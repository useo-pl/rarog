/**
 * Zrzut nieznanego elementu wierzchu: gdy linia logu dowodu karty kanału zgód mówi `top=bash-zone(unlisted=…)`,
 * `top=edit-zone` albo `top=bottom` (element ekranu spoza zamkniętej listy Raroga), cykl zapisuje ekran dowodu do `<dataDir>/refusals/` mechanizmem zrzutów odmów (`refusals.ts`: `0600`
 * w `0700`, 48 h, sufit plików, wyłącznik `RAROG_REFUSAL_DUMPS=0`), raz na kartę. `server.log` dalej nie dostaje treści
 * ekranu: linię strefy może napisać agent, więc może nieść komendę albo sekret. Karta na telefonie bez zmian.
 *
 * Ekran: zmierzony dialog `dialog-bash-cytat-2.1.321.txt` (ostrzeżenie „Quoted text…” CLI 2.1.321), a „lista bez tej
 * linii” to `BASH_ZONE_LINES` z wyjętym wpisem `bashZoneQuotedUnchecked` na czas testu. Harness jak
 * w `layer1-evidence-log.test.ts`.
 *
 * Karta subagenta przy trybie `all` linii logu dowodu nie ma (`noteProof` w `cycle.ts`), a zrzut idzie
 * wyłącznie za tą linią, więc pod tym samym ekranem zrzut dostaje tylko karta wątku głównego.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { topScreen } from '../src/herdr/dialogs/layer1/top.ts';
import { REFUSAL_DUMP_DIRNAME, createRefusalDumper } from '../src/herdr/dialogs/refusals.ts';
import { BASH_ZONE_LINES } from '../src/herdr/dialogs/screen/bash-zone.ts';
import { SCREEN_SIGNATURES } from '../src/herdr/dialogs/screen/signatures.ts';
import { REGISTRY_SLACK_MS } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const SESSION = '00000000-0000-4000-9000-0000000020a1';
const PROMPT = '00000000-0000-4000-9000-0000000020b1';

let clock = Date.parse('2026-11-10T12:00:00.000Z');
const now = (): number => clock;
const BOOT_AT = Date.parse('2026-11-01T00:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const waiting = (at = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const active = (at = clock): RegistryEvidence => ({ kind: 'active', at });

const SCREEN = readFileSync(join(FIXTURES, 'dialog-bash-cytat-2.1.321.txt'), 'utf8');
const COMMAND = (JSON.parse(readFileSync(join(FIXTURES, 'dialog-bash-cytat-2.1.321.command.json'), 'utf8')) as {
  command: string;
}).command;
/** Linia ostrzeżenia z fixture'u, która jest na liście strefy od 2.1.321. */
const QUOTED = "Quoted text in this command can't be checked before it runs";
/** Znacznik w linii spoza listy: udaje sekret, którego `server.log` nie może zawierać. */
const PLANTED = 'rarog-sekret-ZNACZNIK-91c2e7';

/** Zrzut wywołania dla komendy z fixture'u. */
function bashDump(seed: string, agentId?: string): HookCallDump {
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const toolInput = { command: COMMAND, description: 'Trigger ask-rule dialog outside sandbox, nonexistent branch' };
  return {
    key: `${PROMPT}-${nonce}`, sessionId: SESSION, promptId: PROMPT, pid: 61_000 + Number.parseInt(nonce.slice(0, 4), 16),
    startedAt: clock - 1_000, toolName: 'Bash', toolInput, cwd: '/tmp/projekt', at: clock - 900,
    inputSha256: canonicalSha256(toolInput), permissionMode: 'auto',
    ...(agentId === undefined ? {} : { agentId }),
  };
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly life: Map<number, boolean | null>;
  readonly lines: string[];
  screen: string | null;
  step(registry?: RegistryEvidence): Promise<void>;
}

/**
 * Cykl jak w serwerze: log i zapisywacz zrzutów odmów z tego samego `dataDir`. `dumps: 'off'` = `RAROG_REFUSAL_DUMPS=0`,
 * `'none'` = cykl bez zapisywacza (zachowanie sprzed zrzutu nieznanego elementu), `'throw'` = zapisywacz, który rzuca.
 * `mode` = tryb efektywny kanału i zakres rejestru (`all` otwiera kanał subagentom).
 */
async function harness(
  dumps: 'on' | 'off' | 'none' | 'throw' = 'on', mode: 'main' | 'all' = 'main',
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-zrzut-wierzchu-'));
  dirs.push(dir);
  const reg = createConsentRegistry({ bootId: 'boot-e', send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope(mode);
  const lines: string[] = [];
  const started = clock;
  clock = BOOT_AT;
  const dumper = dumps === 'none' ? {} : dumps === 'throw'
    ? { dumpUnknownTop: (): void => { throw new Error('zapis zrzutu padł'); } }
    : { dumpUnknownTop: createRefusalDumper({ dataDir: dir, version: 'test', enabled: dumps === 'on', now }) };
  const cycle = createConsentCycle({
    dataDir: dir, bootId: 'boot-e', registry: reg, now, log: (line) => { lines.push(line); }, mode: () => mode,
    ...dumper,
  });
  clock = started;
  const life = new Map<number, boolean | null>();
  const liveness: ProcessLiveness = async (processes) => new Map(processes.map((p) => [p.pid, life.get(p.pid) ?? null]));
  const unlockAt = BOOT_AT + REGISTRY_SLACK_MS;
  await observeConsentSession(cycle, {
    dataDir: dir, sessionId: SESSION, liveness, registry: active(unlockAt), transcript: null, screen: null,
    now: () => unlockAt,
  });
  const h: Harness = {
    dir, reg, cycle, life, lines, screen: null,
    step: async (registry = waiting()) => {
      const screen = h.screen === null ? null : { text: h.screen, readStartedAt: clock };
      await observeConsentSession(cycle, { dataDir: dir, sessionId: SESSION, liveness, registry, transcript: null, screen, now });
    },
  };
  return h;
}

function hookStarts(h: Harness, dump: HookCallDump): void {
  const path = join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, true);
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
  expect(h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256, cardSha256,
    pid: dump.pid, startedAt: dump.startedAt,
    ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  }).status).toBe(200);
}

/** Pliki zrzutów (`*.txt`); brak katalogu = pusta lista. */
function refusals(h: Harness): string[] {
  const dir = join(h.dir, REFUSAL_DUMP_DIRNAME);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.txt')).sort() : [];
}

const readDump = (h: Harness, name: string): string => readFileSync(join(h.dir, REFUSAL_DUMP_DIRNAME, name), 'utf8');

const proofLines = (h: Harness, key: string): string[] =>
  h.lines.filter((line) => line.startsWith(`consent: proof of key ${key} `));

const card = (h: Harness, key: string): unknown => {
  const view = h.cycle.card(SESSION, key);
  return view === null ? null : { state: view.state, canAllow: view.canAllow, unavailable: view.unavailable };
};

/**
 * Lista strefy bez linii „Quoted text…” na czas `run`. Wierzch pamięta ostatni tekst ekranu
 * (`topCached` w `top.ts`, lista jest w produkcji stała), więc przed i po zmianie listy odczyt innego tekstu czyści
 * tę pamięć.
 */
async function withoutQuotedLine(run: () => Promise<void>): Promise<void> {
  const list = BASH_ZONE_LINES as (RegExp | string)[];
  const index = list.indexOf(SCREEN_SIGNATURES.bashZoneQuotedUnchecked.pattern);
  expect(index).toBeGreaterThanOrEqual(0);
  const [removed] = list.splice(index, 1);
  topScreen('');
  try {
    await run();
  } finally {
    list.splice(index, 0, removed as RegExp | string);
    topScreen('');
  }
}

describe('zrzut nieznanego elementu wierzchu: `dialog-bash-cytat-2.1.321.txt` z listą bez linii „Quoted text…”', () => {
  it('dwa kolejne odczyty tej samej karty (i przeglądy plików) → jeden zrzut z kluczem karty i ekranem', async () => {
    await withoutQuotedLine(async () => {
      const h = await harness();
      const dump = bashDump('jeden-zrzut');
      hookStarts(h, dump);
      h.screen = SCREEN;
      await h.step();
      await h.cycle.tick();
      clock += 1_500;
      await h.step();
      await h.cycle.tick();
      expect(proofLines(h, dump.key)).toEqual([
        expect.stringMatching(/^consent: proof of key \S+ missing: top=bash-zone\(unlisted=1,/u),
      ]);
      const files = refusals(h);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(new RegExp(`-top-bash-zone-${dump.key.slice(-12)}\\.txt$`, 'u'));
      const text = readDump(h, files[0]!);
      expect(text).toContain(`key: ${dump.key}\n`);
      expect(text).toContain('reason: top-bash-zone\n');
      expect(text).toContain('toolName: Bash\n');
      expect(text).toMatch(/\nproof: top=bash-zone\(unlisted=1,[^\n]*\n/u);
      expect(text).toContain(`--- ekran ---\n${SCREEN}`);
    });
  });

  it('dwie karty pod tym samym ekranem: zrzut na kartę (klucz), nie na odczyt', async () => {
    await withoutQuotedLine(async () => {
      const h = await harness();
      const first = bashDump('karta-1');
      const second = bashDump('karta-2');
      hookStarts(h, first);
      hookStarts(h, second);
      h.screen = SCREEN;
      await h.step();
      clock += 1_500;
      await h.step();
      expect(proofLines(h, first.key)).toHaveLength(1);
      expect(proofLines(h, second.key)).toHaveLength(1);
      const keys = refusals(h).map((name) => /\nkey: (\S+)\n/u.exec(readDump(h, name))?.[1]);
      expect(keys.sort()).toEqual([first.key, second.key].sort());
    });
  });

  it('ta sama karta wraca do nieznanego wierzchu po innym członie: nowa linia logu, dalej jeden zrzut', async () => {
    await withoutQuotedLine(async () => {
      const h = await harness();
      const dump = bashDump('powrot');
      hookStarts(h, dump);
      h.screen = SCREEN;
      await h.step();
      h.screen = null;
      clock += 1_500;
      await h.step();
      h.screen = SCREEN;
      clock += 1_500;
      await h.step();
      // Trzy różne linie logu z rzędu: druga linia z `top=bash-zone` dochodzi do zapisywacza, więc zrzut powstrzymuje
      // pamięć zrzuconych kart, nie tłumienie powtórzonej linii.
      expect(proofLines(h, dump.key).map((line) => /missing: (top=[a-z-]+)/u.exec(line)?.[1]))
        .toEqual(['top=bash-zone', 'top=no-screen', 'top=bash-zone']);
      expect(refusals(h)).toHaveLength(1);
    });
  });

  it('tryb `all`: karta subagenta pod tym samym ekranem bez linii logu i bez zrzutu, wątek główny ze zrzutem', async () => {
    await withoutQuotedLine(async () => {
      const h = await harness('on', 'all');
      const main = bashDump('all-glowny');
      const sub = bashDump('all-subagent', 'a0000000000000e1');
      hookStarts(h, main);
      hookStarts(h, sub);
      h.screen = SCREEN;
      await h.step();
      await h.cycle.tick();
      clock += 1_500;
      await h.step();
      await h.cycle.tick();
      expect(card(h, sub.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
      expect(proofLines(h, sub.key)).toEqual([]);
      expect(proofLines(h, main.key)).toEqual([
        expect.stringMatching(/^consent: proof of key \S+ missing: top=bash-zone\(unlisted=1,/u),
      ]);
      const keys = refusals(h).map((name) => /\nkey: (\S+)\n/u.exec(readDump(h, name))?.[1]);
      expect(keys).toEqual([main.key]);
    });
  });

  it('zapisywacz rzuca: karta i linia logu dowodu jak bez zapisywacza, cykl idzie dalej', async () => {
    await withoutQuotedLine(async () => {
      const h = await harness('throw');
      const dump = bashDump('rzuca');
      hookStarts(h, dump);
      h.screen = SCREEN;
      await h.step();
      clock += 1_500;
      await h.step();
      await h.cycle.tick();
      expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
      expect(proofLines(h, dump.key)).toHaveLength(1);
    });
  });

  it('`RAROG_REFUSAL_DUMPS=0` → brak zrzutu, linia logu dowodu jak dotąd', async () => {
    await withoutQuotedLine(async () => {
      const h = await harness('off');
      const dump = bashDump('wylacznik');
      hookStarts(h, dump);
      h.screen = SCREEN;
      await h.step();
      expect(proofLines(h, dump.key)).toHaveLength(1);
      expect(existsSync(join(h.dir, REFUSAL_DUMP_DIRNAME))).toBe(false);
    });
  });

  it('zachowanie karty bez zmian: te same widoki karty i te same linie logu co cykl bez zapisywacza', async () => {
    await withoutQuotedLine(async () => {
      const run = async (dumps: 'on' | 'none'): Promise<{ cards: unknown[]; lines: string[] }> => {
        clock = Date.parse('2026-11-10T13:00:00.000Z');
        const h = await harness(dumps);
        const dump = bashDump('zachowanie');
        hookStarts(h, dump);
        const cards: unknown[] = [];
        h.screen = SCREEN;
        await h.step();
        cards.push(h.cycle.card(SESSION, dump.key));
        clock += 1_500;
        await h.step();
        await h.cycle.tick();
        cards.push(h.cycle.card(SESSION, dump.key));
        cards.push(await h.cycle.decide(SESSION, dump.key, 'allow'));
        cards.push(await h.cycle.decide(SESSION, dump.key, 'deny'));
        cards.push(h.cycle.card(SESSION, dump.key));
        return { cards, lines: h.lines };
      };
      const without = await run('none');
      const withDumps = await run('on');
      expect(withDumps).toEqual(without);
      expect(without.cards[1]).toMatchObject({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    });
  });
});

describe('zrzut nieznanego elementu wierzchu: lista z linią i inne człony', () => {
  it('lista z linią „Quoted text…”: dowód jest, zero zrzutów', async () => {
    const h = await harness();
    const dump = bashDump('lista-z-linia');
    hookStarts(h, dump);
    h.screen = SCREEN;
    await h.step();
    await h.step();
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
    expect(refusals(h)).toEqual([]);
  });

  it('sekret w nieznanej linii: w zrzucie, nigdy w `server.log`; plik `0600` w katalogu `0700`', async () => {
    const h = await harness();
    const dump = bashDump('sekret');
    hookStarts(h, dump);
    const screen = SCREEN.replace(QUOTED, `${QUOTED} ${PLANTED}`);
    expect(screen).not.toBe(SCREEN);
    h.screen = screen;
    await h.step();
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    const log = h.lines.join('\n');
    expect(proofLines(h, dump.key)).toHaveLength(1);
    for (const secret of [PLANTED, 'Quoted text', 'git branch', '/tmp/projekt']) expect(log, secret).not.toContain(secret);
    const [file] = refusals(h);
    expect(file).toBeDefined();
    expect(readDump(h, file!)).toContain(PLANTED);
    expect(statSync(join(h.dir, REFUSAL_DUMP_DIRNAME, file!)).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.dir, REFUSAL_DUMP_DIRNAME)).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['tekst pod stopką dialogu', 'bottom', `${SCREEN.trimEnd()}\n\n⏺ More transcript.\n`],
    ['linia nad pytaniem dialogu `Edit`', 'edit-zone',
      readFileSync(join(FIXTURES, 'measured', 'zgoda-edit-2.1.293.txt'), 'utf8')
        .replace(' Do you want to make', ` Unlisted edit zone line ${PLANTED}\n Do you want to make`)],
  ])('%s → `top=%s` i jeden zrzut', async (_name, kind, screen) => {
    const h = await harness();
    const dump = bashDump(`czlon-${kind}`);
    hookStarts(h, dump);
    h.screen = screen;
    await h.step();
    await h.step();
    expect(proofLines(h, dump.key)).toEqual([`consent: proof of key ${dump.key} missing: top=${kind}`]);
    const files = refusals(h);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`-top-${kind}-${dump.key.slice(-12)}\\.txt$`, 'u'));
    expect(h.lines.join('\n')).not.toContain(PLANTED);
  });

  it.each([
    ['ekran bez opcji dialogu (`top=no-options`)', '⏺ Done.\n\n> \n', waiting],
    ['dialog z listy przy rejestrze bez `waiting` (`registry=not-waiting`)', SCREEN, active],
    ['obserwacja bez ekranu (`top=no-screen`)', null, waiting],
  ])('%s → linia logu dowodu bez zrzutu', async (_name, screen, registry) => {
    const h = await harness();
    const dump = bashDump(`bez-zrzutu-${String(screen?.length ?? 0)}-${registry.name}`);
    hookStarts(h, dump);
    h.screen = screen;
    await h.step(registry());
    expect(proofLines(h, dump.key)).toHaveLength(1);
    expect(refusals(h)).toEqual([]);
  });
});
