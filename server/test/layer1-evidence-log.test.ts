/**
 * Linia logu dowodu „dialog stoi” kanału zgód (diagnostyka): karta wątku głównego w `pending` bez przycisku zgody
 * (`no-proof`) mówi w `server.log`, który człon dowodu odpadł — wierzch (`top=`), rejestr CLI (`registry=`), dowód
 * własny (`own=`), fakt utraty (`lost=`) — raz na zestaw powodów, a po odzyskaniu dowodu raz `ok`. Linia nie niesie
 * treści ekranu ani komendy (log czyta runbook kradzieży telefonu).
 *
 * Zgłoszenie: dwie karty `Bash` z `buttonless.reason = no-proof`, a w logu tylko rejestracja i zapomnienie wpisu.
 * Przyczyną była linia strefy spoza listy (ostrzeżenie CLI 2.1.321 o tekście w cudzysłowie, dziś na liście, fixture
 * `dialog-bash-cytat-2.1.321`). Ekran dialogu niżej to ten dialog od kreski bloku w dół znak w znak, z jedną zmianą:
 * w miejscu ostrzeżenia stoi linia syntetyczna z unikalnym znacznikiem, której żadna lista nie przyjmie; znacznik
 * pozwala sprawdzić, że tekst linii nie trafia do logu. Linia transkryptu nad dialogiem jest neutralna.
 *
 * Harness jak w `layer1-observation.test.ts`: zrzuty na dysku, atrapa `ps`, rejestr i zegar z testu,
 * prawdziwy cykl i obserwacja z produkcyjnym `matchTop`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_PROOF_TTL_MS, CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { TranscriptToolUses } from '../src/herdr/dialogs/layer1/proof.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { topScreen } from '../src/herdr/dialogs/layer1/top.ts';
import { bashZoneMiss } from '../src/herdr/dialogs/screen/bash-zone.ts';
import { REGISTRY_MAX_AGE_MS, REGISTRY_SLACK_MS } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const SESSION = '00000000-0000-4000-9000-0000000010a1';
const PROMPT = '00000000-0000-4000-9000-0000000010b1';

let clock = Date.parse('2026-11-09T12:00:00.000Z');
const now = (): number => clock;
const BOOT_AT = Date.parse('2026-11-01T00:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const waiting = (at = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const active = (at = clock): RegistryEvidence => ({ kind: 'active', at });

/** Komenda dialogu z odtworzenia (2.1.321). */
const COMMAND = '[ "$(git branch --show-current)" = main ] && git branch -D rarog-proba-nieistniejaca 2>&1 | tail -1';
/** Linia strefy spoza listy: syntetyczna, ze znacznikiem, którego log nie może zawierać. */
const UNLISTED = 'Unlisted parser warning ZNACZNIK-STREFY-7f3a for this command';
/** Linie strefy z listy z odtworzenia: reguła `ask` z ustawień w trybie auto. */
const ASK_RULE = [
  'Ask rule Bash(git branch -D *) overrides auto mode for this command.',
  '/permissions to let auto mode decide',
];

/** Dialog `Bash` z odtworzenia na CLI 2.1.321 ze strefą `zone` nad pytaniem i opcjonalnym tekstem pod stopką. */
function bashDialog(zone: readonly string[], command = COMMAND, under: readonly string[] = []): string {
  return [
    '⏺ Neutral transcript line above the dialog.',
    '',
    '─'.repeat(128),
    ' Bash command (unsandboxed)',
    ' Trigger ask-rule dialog outside sandbox, nonexistent branch',
    '╌'.repeat(128),
    ` │ ${command}`,
    '╌'.repeat(128),
    ...zone.map((line) => ` ${line}`),
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
    ...under,
    '',
  ].join('\n');
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly life: Map<number, boolean | null>;
  /** Linie logu cyklu. */
  readonly lines: string[];
  screen: string | null;
  step(registry?: RegistryEvidence, transcript?: TranscriptToolUses | null): Promise<void>;
}

/** Cykl jak w serwerze, z logiem; `unlock: false` = bez zdjęcia blokady startu. */
async function harness(options: { readonly unlock?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-log-dowodu-'));
  dirs.push(dir);
  const reg = createConsentRegistry({ bootId: 'boot-log', send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope('main');
  const lines: string[] = [];
  const started = clock;
  clock = BOOT_AT;
  const cycle = createConsentCycle({ dataDir: dir, bootId: 'boot-log', registry: reg, now, log: (line) => { lines.push(line); } });
  clock = started;
  const life = new Map<number, boolean | null>();
  const liveness: ProcessLiveness = async (processes) => new Map(processes.map((p) => [p.pid, life.get(p.pid) ?? null]));
  if (options.unlock !== false) {
    const unlockAt = BOOT_AT + REGISTRY_SLACK_MS;
    await observeConsentSession(cycle, {
      dataDir: dir, sessionId: SESSION, liveness, registry: active(unlockAt), transcript: null, screen: null,
      now: () => unlockAt,
    });
  }
  const h: Harness = {
    dir, reg, cycle, life, lines, screen: null,
    step: async (registry = waiting(), transcript = null) => {
      const screen = h.screen === null ? null : { text: h.screen, readStartedAt: clock };
      await observeConsentSession(cycle, { dataDir: dir, sessionId: SESSION, liveness, registry, transcript, screen, now });
    },
  };
  return h;
}

let nextPid = 52_000;

function bashDump(seed: string, command = COMMAND): HookCallDump {
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const toolInput = { command, description: 'Trigger ask-rule dialog outside sandbox, nonexistent branch' };
  nextPid += 1;
  return {
    key: `${PROMPT}-${nonce}`, sessionId: SESSION, promptId: PROMPT, pid: nextPid, startedAt: clock - 1_000,
    toolName: 'Bash', toolInput, cwd: '/tmp/projekt', at: clock - 900, inputSha256: canonicalSha256(toolInput),
    permissionMode: 'auto',
  };
}

const dumpPath = (dir: string, key: string): string => join(dir, HOOK_PENDING_DIRNAME, SESSION, `${key}.json`);

/** Hook startuje i rejestruje się: zrzut na dysku, proces żywy (`alive: false` = `ps` nie wie). */
function hookStarts(h: Harness, dump: HookCallDump, alive: boolean | null = true): void {
  mkdirSync(dirname(dumpPath(h.dir, dump.key)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(h.dir, dump.key), JSON.stringify(dump), { mode: 0o600 });
  if (alive !== null) h.life.set(dump.pid, alive);
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: null, permissionMode: dump.permissionMode ?? null,
  });
  expect(h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256, cardSha256,
    pid: dump.pid, startedAt: dump.startedAt,
  }).status).toBe(200);
}

/** Linie logu dowodu (`consent: proof of key …`) klucza. */
const proofLines = (h: Harness, key: string): string[] =>
  h.lines.filter((line) => line.startsWith(`consent: proof of key ${key} `));
const missing = (key: string, why: string): string => `consent: proof of key ${key} missing: ${why}`;
const ok = (key: string): string => `consent: proof of key ${key} ok`;

const card = (h: Harness, key: string): unknown => {
  const view = h.cycle.card(SESSION, key);
  return view === null ? null : { state: view.state, canAllow: view.canAllow, unavailable: view.unavailable };
};

describe('wierzch: strefa `Bash` spoza listy (zgłoszenie z dwiema kartami `Bash` bez przycisku)', () => {
  it('linia spoza listy nad `Ask rule`: `top=bash-zone` z liczbą linii, znakami i paskiem, bez treści linii'
    + ' i komendy; karta bez przycisku jak dotąd', async () => {
    const h = await harness();
    const dump = bashDump('strefa-spoza-listy');
    hookStarts(h, dump);
    h.screen = bashDialog([UNLISTED, ...ASK_RULE]);
    await h.step();
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    expect(proofLines(h, dump.key)).toEqual([
      missing(dump.key, `top=bash-zone(unlisted=1,chars=${String([...UNLISTED].length)},bar=no)`),
    ]);
    const log = h.lines.join('\n');
    for (const secret of ['ZNACZNIK-STREFY', 'Unlisted parser', 'git branch', 'rarog-proba', '/tmp/projekt', 'Ask rule']) {
      expect(log, secret).not.toContain(secret);
    }
  });

  it('dwie linie spoza listy, jedna z paskiem objaśnienia: liczby w kolejności ekranu', async () => {
    const h = await harness();
    const dump = bashDump('dwie-linie');
    hookStarts(h, dump);
    h.screen = bashDialog([UNLISTED, `│ ${UNLISTED} 2`, ...ASK_RULE]);
    await h.step();
    const chars = [...UNLISTED].length;
    expect(proofLines(h, dump.key)).toEqual([
      missing(dump.key, `top=bash-zone(unlisted=2,chars=${String(chars)}/${String(chars + 2)},bar=no/yes)`),
    ]);
  });

  it('ten sam zestaw powodów w kolejnych obserwacjach i przeglądach plików: jedna linia; strefa z listy: dowód i jedna'
    + ' linia `ok`, potem cisza', async () => {
    const h = await harness();
    const dump = bashDump('powtorki');
    hookStarts(h, dump);
    h.screen = bashDialog([UNLISTED, ...ASK_RULE]);
    for (let i = 0; i < 4; i += 1) {
      await h.step();
      await h.cycle.tick();
      clock += 1_500;
    }
    expect(proofLines(h, dump.key)).toHaveLength(1);
    h.screen = bashDialog(ASK_RULE);
    await h.step();
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
    for (let i = 0; i < 3; i += 1) {
      clock += 1_500;
      await h.step();
      await h.cycle.tick();
    }
    expect(proofLines(h, dump.key)).toEqual([
      missing(dump.key, `top=bash-zone(unlisted=1,chars=${String([...UNLISTED].length)},bar=no)`),
      ok(dump.key),
    ]);
  });

  it('karta z przyciskiem od pierwszej obserwacji: żadnej linii dowodu', async () => {
    const h = await harness();
    const dump = bashDump('od-razu');
    hookStarts(h, dump);
    h.screen = bashDialog(ASK_RULE);
    await h.step();
    await h.step();
    expect(card(h, dump.key)).toMatchObject({ canAllow: true });
    expect(proofLines(h, dump.key)).toEqual([]);
  });

  it('zmierzony ekran zgłoszenia (`dialog-bash-cytat-2.1.321`, ostrzeżenie z listy): dowód jest, żadnej linii dowodu',
    async () => {
      const h = await harness();
      const measured = JSON.parse(readFileSync(join(FIXTURES, 'dialog-bash-cytat-2.1.321.command.json'), 'utf8')) as {
        command: string;
      };
      const dump = bashDump('zmierzony', measured.command);
      hookStarts(h, dump);
      h.screen = readFileSync(join(FIXTURES, 'dialog-bash-cytat-2.1.321.txt'), 'utf8');
      await h.step();
      await h.cycle.tick();
      expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
      expect(proofLines(h, dump.key)).toEqual([]);
    });

  it.each([
    ['dół odczytu z tekstem pod stopką', 'bottom', bashDialog(ASK_RULE, COMMAND, ['', '⏺ More transcript.'])],
    ['ekran bez opcji dialogu', 'no-options', '⏺ Done.\n\n> \n'],
    ['strefa bez pytania na końcu', 'bash-question', bashDialog(ASK_RULE).replace(' Do you want to proceed?', '')],
  ])('%s → `top=%s`', async (_name, why, screen) => {
    const h = await harness();
    const dump = bashDump(`ekran-${why}`);
    hookStarts(h, dump);
    h.screen = screen;
    await h.step();
    expect(proofLines(h, dump.key)).toEqual([missing(dump.key, `top=${why}`)]);
  });
});

describe('wierzch: obserwacja i pula', () => {
  it('obserwacja bez odczytu ekranu → `top=no-screen`', async () => {
    const h = await harness();
    const dump = bashDump('bez-ekranu');
    hookStarts(h, dump);
    await h.step();
    expect(proofLines(h, dump.key)).toEqual([missing(dump.key, 'top=no-screen')]);
  });

  it('niekompletny odczyt zrzutów (plik zrzutu nieczytelny) → `top=scan-incomplete`', async () => {
    const h = await harness();
    const dump = bashDump('niekompletny');
    hookStarts(h, dump);
    writeFileSync(dumpPath(h.dir, `${PROMPT}-${'e'.repeat(32)}`), 'to nie jest JSON', { mode: 0o600 });
    h.screen = bashDialog(ASK_RULE);
    await h.step();
    expect(proofLines(h, dump.key)).toEqual([missing(dump.key, 'top=scan-incomplete')]);
  });

  it('blokada startu niezdjęta → `top=start-lock`', async () => {
    const h = await harness({ unlock: false });
    const dump = bashDump('blokada');
    hookStarts(h, dump);
    h.screen = bashDialog(ASK_RULE);
    await h.step();
    expect(proofLines(h, dump.key)).toEqual([missing(dump.key, 'top=start-lock')]);
  });

  it('przegrana w puli: na wierzchu inna prośba `Bash` → `top=other-key(screen=bash)`, zwycięzca bez linii', async () => {
    const h = await harness();
    const loser = bashDump('przegrany', 'echo przegrany');
    const winner = bashDump('zwyciezca');
    hookStarts(h, loser);
    hookStarts(h, winner);
    h.screen = bashDialog(ASK_RULE);
    await h.step();
    expect(proofLines(h, loser.key)).toEqual([missing(loser.key, 'top=other-key(screen=bash)')]);
    expect(proofLines(h, winner.key)).toEqual([]);
  });

  it('dwie prośby o tej samej komendzie → `top=ambiguous(screen=bash)` dla obu', async () => {
    const h = await harness();
    const first = bashDump('bliźniak-1');
    const second = bashDump('bliźniak-2');
    hookStarts(h, first);
    hookStarts(h, second);
    h.screen = bashDialog(ASK_RULE);
    await h.step();
    expect(proofLines(h, first.key)).toEqual([missing(first.key, 'top=ambiguous(screen=bash)')]);
    expect(proofLines(h, second.key)).toEqual([missing(second.key, 'top=ambiguous(screen=bash)')]);
  });

  it('termin dowodu minął bez nowej obserwacji: przegląd plików → `top=expired`, następna obserwacja → `ok`',
    async () => {
      const h = await harness();
      const dump = bashDump('termin');
      hookStarts(h, dump);
      h.screen = bashDialog(ASK_RULE);
      await h.step();
      expect(card(h, dump.key)).toMatchObject({ canAllow: true });
      clock += CONSENT_PROOF_TTL_MS;
      await h.cycle.tick();
      expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
      await h.cycle.tick();
      await h.step();
      expect(card(h, dump.key)).toMatchObject({ canAllow: true });
      expect(proofLines(h, dump.key)).toEqual([missing(dump.key, 'top=expired'), ok(dump.key)]);
    });
});

describe('rejestr CLI', () => {
  it('rejestr `busy` (bez `waiting`) przy dialogu na wierzchu → `registry=not-waiting`; potem `waiting` → `ok`',
    async () => {
      const h = await harness();
      const dump = bashDump('rejestr-busy');
      hookStarts(h, dump);
      h.screen = bashDialog(ASK_RULE);
      // Odczyt rejestru w zapasie po zapisie prośby: CLI mogło jeszcze nie przepisać rejestru, więc bez sieroty.
      await h.step(active());
      expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
      await h.step(waiting());
      expect(proofLines(h, dump.key)).toEqual([missing(dump.key, 'registry=not-waiting'), ok(dump.key)]);
    });

  it.each([
    ['`waiting` z inną klasą', 'class-input', (): RegistryEvidence => ({ kind: 'waiting', dialog: 'input', at: clock })],
    ['odczyt starszy niż 5 s', 'stale', (): RegistryEvidence => waiting(clock - REGISTRY_MAX_AGE_MS - 1)],
    ['rejestr nieznany', 'unknown-unread', (): RegistryEvidence => ({ kind: 'unknown', why: 'unread' })],
  ])('%s → `registry=%s`', async (_name, why, registry) => {
    const h = await harness();
    const dump = bashDump(`rejestr-${why}`);
    hookStarts(h, dump);
    h.screen = bashDialog(ASK_RULE);
    await h.step(registry());
    expect(proofLines(h, dump.key)).toEqual([missing(dump.key, `registry=${why}`)]);
  });

  it('zmiana zestawu powodów (rejestr, potem wierzch) daje drugą linię', async () => {
    const h = await harness();
    const dump = bashDump('zmiana-zestawu');
    hookStarts(h, dump);
    h.screen = bashDialog(ASK_RULE);
    await h.step(active());
    h.screen = bashDialog([UNLISTED, ...ASK_RULE]);
    await h.step(active());
    await h.step(waiting());
    const zone = `top=bash-zone(unlisted=1,chars=${String([...UNLISTED].length)},bar=no)`;
    expect(proofLines(h, dump.key)).toEqual([
      missing(dump.key, 'registry=not-waiting'),
      missing(dump.key, `${zone} registry=not-waiting`),
      missing(dump.key, zone),
    ]);
  });
});

describe('dowód własny i fakt utraty', () => {
  it('`ps` bez odpowiedzi o procesie hooka → `own=hook-unknown`', async () => {
    const h = await harness();
    const dump = bashDump('ps-nie-wie');
    hookStarts(h, dump, null);
    h.screen = bashDialog(ASK_RULE);
    await h.step();
    expect(proofLines(h, dump.key)).toEqual([missing(dump.key, 'own=hook-unknown')]);
  });

  it('transkrypt minął prośbę → `lost=transcript-passed`', async () => {
    const h = await harness();
    const dump = bashDump('transkrypt-minal');
    hookStarts(h, dump);
    h.screen = bashDialog(ASK_RULE);
    await h.step(waiting(), {
      open: [], closed: [{ toolName: 'Bash', inputSha256: dump.inputSha256, closedAt: clock }], lostAt: null,
    });
    expect(proofLines(h, dump.key)).toEqual([missing(dump.key, 'lost=transcript-passed')]);
  });

  it('powrót gniazda herdr przy karcie z przyciskiem → `lost=reattach`', async () => {
    const h = await harness();
    const dump = bashDump('powrot-gniazda');
    hookStarts(h, dump);
    h.screen = bashDialog(ASK_RULE);
    await h.step();
    expect(card(h, dump.key)).toMatchObject({ canAllow: true });
    await h.cycle.markReattached(SESSION);
    expect(card(h, dump.key)).toMatchObject({ canAllow: false, unavailable: 'no-proof' });
    expect(proofLines(h, dump.key)).toEqual([missing(dump.key, 'lost=reattach')]);
  });
});

describe('poza zakresem linii', () => {
  it('karta wyjęta z `pending` (odmowa z telefonu) zapomina linię; martwy hook bez linii dowodu', async () => {
    const h = await harness();
    const dump = bashDump('odmowa');
    hookStarts(h, dump);
    h.screen = bashDialog([UNLISTED, ...ASK_RULE]);
    await h.step();
    expect(await h.cycle.decide(SESSION, dump.key, 'deny')).toMatchObject({ ok: true, state: 'sent' });
    expect(h.cycle.diagnosticMemory(SESSION).proofNotes).toEqual([]);
    expect(h.cycle.diagnosticMemory(SESSION).proofMisses).toEqual([]);

    const dead = bashDump('martwy');
    hookStarts(h, dead, false);
    await h.step();
    expect(proofLines(h, dead.key)).toEqual([]);
  });
});

describe('powód wierzchu bez linii (`topScreen`, `bashZoneMiss`)', () => {
  const measured = (name: string): string => readFileSync(join(FIXTURES, 'measured', name), 'utf8');
  const lines = bashDialog(ASK_RULE).split('\n');
  const without = (drop: (line: string, index: number) => boolean): string =>
    lines.filter((line, index) => !drop(line, index)).join('\n');
  const lowerRule = lines.findLastIndex((line) => line.startsWith('╌'));

  it.each([
    ['dialog `Bash` z odtworzenia', bashDialog(ASK_RULE), { identity: 'bash' }],
    ['dialog `Edit` z pomiaru 2.1.293', measured('zgoda-edit-2.1.293.txt'), { identity: 'edit' }],
    ['bez kreski nad tytułem', without((line) => line.startsWith('─')), { identity: null, miss: { kind: 'title-pair' } }],
    ['bez dolnej kreski ramki', without((_line, index) => index === lowerRule),
      { identity: null, miss: { kind: 'frame' } }],
    ['dialog narzędzia MCP z pomiaru 2.1.293', measured('zgoda-mcp-2.1.293.txt'),
      { identity: null, miss: { kind: 'other-dialog' } }],
    ['dialog `Edit` z linią nad pytaniem',
      measured('zgoda-edit-2.1.293.txt').replace(' Do you want to make', ` ${UNLISTED}\n Do you want to make`),
      { identity: null, miss: { kind: 'edit-zone' } }],
  ])('%s', (_name, screen, expected) => {
    expect(topScreen(screen)).toEqual(expected);
  });

  it('`bashZoneMiss`: zawinięcie z listy przechodzi, linia spoza listy daje liczby, brak pytania daje `question`', () => {
    expect(bashZoneMiss([...ASK_RULE, '', 'Do you want to proceed?'])).toBeNull();
    expect(bashZoneMiss(['Ask rule Bash(git branch -D *) overrides auto mode', 'for this command.',
      'Do you want to proceed?'])).toBeNull();
    expect(bashZoneMiss([UNLISTED, '│ ąę', ...ASK_RULE, 'Do you want to proceed?'])).toEqual({
      kind: 'unlisted', lines: [{ chars: [...UNLISTED].length, bar: false }, { chars: 2, bar: true }],
    });
    expect(bashZoneMiss(ASK_RULE)).toEqual({ kind: 'question' });
  });
});
