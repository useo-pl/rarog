/**
 * Cykl kanału zgód (warstwa 1): karta, protokół zapisu decyzji, odzyskiwanie po restarcie, wiązanie klucza
 * z `tool_use.id`, dowód skutku z transkryptu i przegląd poza oknem followera. Identyfikatory `T-01`…`T-12` numerują
 * przejścia cyklu wątku głównego (bez subagentów i auto-odmowy rodzeństwa).
 *
 * Transkrypty i wejścia hooka to fixture'y pomiaru (`server/test/fixtures/consent-dowod/`, CLI 2.1.314). Start
 * procesu hooka liczy się z fixture'u: wpis `tool_use` stoi `czasy.timestampToolUse` ms przed zrzutem, a zrzut
 * `czasy.pending` ms po starcie hooka.
 *
 * Opisy przejść wątku głównego (`describeTryby`) idą dwa razy: przy trybie efektywnym `main` i `all`
 * (prośba wątku głównego przy `all` ma te same wyniki co przy `main`).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createConsentEvidenceReview, createConsentEvidenceScanner, locateConsentCheckpoint, nodeConsentEvidenceIo,
} from '../src/herdr/consent-evidence.ts';
import type { ConsentEvidenceIo } from '../src/herdr/consent-evidence.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { bindTurn } from '../src/herdr/dialogs/layer1/bind.ts';
import type { ConsentTurnFacts } from '../src/herdr/dialogs/layer1/bind.ts';
import { consentCardVerdict, presentConsentInput } from '../src/herdr/dialogs/layer1/card.ts';
import { wireStateOf } from '../src/herdr/dialogs/layer1/cards.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import {
  CONSENT_CLAIMED_STANDING_MS, CONSENT_CLAIM_TIMEOUT_MS, CONSENT_DIRNAME, CONSENT_DISPLAY_MAX,
  CONSENT_RECORDS_DIRNAME, CONSENT_RECORD_RETENTION_MS, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentCheckpoint, ConsentFile } from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentCycle, ConsentCycleIo } from '../src/herdr/dialogs/layer1/cycle.ts';
import { consentEffectOf } from '../src/herdr/dialogs/layer1/proof.ts';
import {
  CONSENT_FILE_TTL_MS, readConsentRecords, sweepConsentFiles, writeConsentRecord,
} from '../src/herdr/dialogs/layer1/records.ts';
import type { ConsentRecord } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, verifyConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import type { ConsentExpectation, ConsentVerdict } from '../src/herdr/dialogs/layer1/sign.ts';
import { writeAtomic } from '../src/herdr/dialogs/shadow/atomic.ts';
import { HISTORY_MAX_BYTES } from '../src/herdr/jsonl-follow.ts';
import { toolResultDecisions, turnPromptOf, turnToolUses } from '../src/herdr/jsonl-pending.ts';
import { createCycleWithRead, observeStandingOf } from './helpers/dowod-z-odczytem.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'consent-dowod');
const SESSION = '00000000-0000-4000-9000-000000000001';
const BOOT = 'boot-cykl-1';
const NEXT_BOOT = 'boot-cykl-2';

interface Przypadek {
  readonly nazwa: string;
  readonly klucz: string;
  readonly narzedzie: string;
  readonly toolUseId: string | null;
  readonly hook: string;
  readonly transkrypt: string;
  readonly czasy: { readonly pending: number; readonly timestampToolUse: number };
}

interface WejscieHooka {
  readonly session_id: string;
  readonly prompt_id: string;
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly cwd: string;
  readonly permission_mode?: string;
}

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const PRZYPADKI = JSON.parse(fixture('przypadki.json')) as Przypadek[];
const przypadek = (nazwa: string): Przypadek => {
  const found = PRZYPADKI.find((p) => p.nazwa === nazwa);
  if (found === undefined) throw new Error(`brak przypadku ${nazwa}`);
  return found;
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-cykl-'));
  dirs.push(dir);
  return dir;
}

/** `timestamp` wpisu `tool_use` przypadku w jego transkrypcie (ms epoki). */
function toolUseAt(p: Przypadek): number {
  for (const line of fixture(p.transkrypt).split('\n')) {
    if (line === '') continue;
    const entry = JSON.parse(line) as { timestamp?: string };
    if (turnToolUses(entry).some((use) => use.id === p.toolUseId)) return Date.parse(entry.timestamp ?? '');
  }
  throw new Error(`${p.nazwa}: bez tool_use`);
}

/** Start procesu hooka przypadku (ms epoki) z czasów pomiaru. */
function hookStart(p: Przypadek): number {
  return toolUseAt(p) - p.czasy.timestampToolUse - p.czasy.pending;
}

/** Zrzut per wywołanie, jaki hook zapisałby dla przypadku. */
function dumpOf(p: Przypadek, over: Partial<HookCallDump> = {}): HookCallDump {
  const hook = JSON.parse(fixture(p.hook)) as WejscieHooka;
  const startedAt = over.startedAt ?? hookStart(p);
  const toolInput = over.toolInput ?? hook.tool_input;
  return {
    key: p.klucz, sessionId: hook.session_id, promptId: hook.prompt_id, pid: process.pid, startedAt,
    toolName: hook.tool_name, toolInput, cwd: hook.cwd, at: startedAt + 1, inputSha256: canonicalSha256(toolInput),
    ...(hook.permission_mode === undefined ? {} : { permissionMode: hook.permission_mode }),
    ...over,
  };
}

/** Zrzut syntetyczny (klucz z `seed`) dla testów karty i protokołu. */
function syntheticDump(seed: string, toolName: string, toolInput: unknown, over: Partial<HookCallDump> = {}): HookCallDump {
  const promptId = over.promptId ?? '00000000-0000-4000-9000-0000000000aa';
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return {
    key: `${promptId}-${nonce}`, sessionId: SESSION, promptId, pid: process.pid, startedAt: clock - 1_000,
    toolName, toolInput, cwd: '/tmp/projekt', at: clock - 900, inputSha256: canonicalSha256(toolInput),
    permissionMode: 'default', ...over,
  };
}

function cardShaOf(dump: HookCallDump): string {
  return consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
}

let clock = Date.parse('2026-10-30T14:00:00.000Z');
const now = (): number => clock;

/**
 * Tryb efektywny kanału w cyklu i zakres rejestru testu. Opisy z {@link describeTryby} idą przy `main` i przy `all`:
 * prośba wątku głównego ma przy `all` te same wyniki co przy `main`.
 */
const TRYBY = ['main', 'all'] as const;
let tryb: (typeof TRYBY)[number] = 'main';
beforeEach(() => { tryb = 'main'; });

/** Opis puszczony w każdym trybie z {@link TRYBY}; nazwa niesie tryb. */
function describeTryby(name: string, body: () => void): void {
  for (const mode of TRYBY) {
    describe(`${name} [${mode}]`, () => {
      beforeEach(() => { tryb = mode; });
      body();
    });
  }
}

function registry(): ConsentRegistry {
  const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope(tryb);
  return reg;
}

/** Rejestracja hooka dla zrzutu; zwraca sekret. `cardSha256` z pełnego zrzutu, chyba że podany. */
function register(reg: ConsentRegistry, dump: HookCallDump, cardSha256 = cardShaOf(dump)): string {
  const secret = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
  const outcome = reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret, inputSha256: dump.inputSha256,
    cardSha256, pid: dump.pid, startedAt: dump.startedAt, ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  });
  expect(outcome.status).toBe(200);
  return secret;
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly events: ConsentCardView[];
}

function harness(
  options: {
    dir?: string; reg?: ConsentRegistry; io?: Partial<ConsentCycleIo>; bootId?: string; log?: (line: string) => void;
  } = {},
): Harness {
  const dir = options.dir ?? dataDir();
  const reg = options.reg ?? registry();
  const events: ConsentCardView[] = [];
  const cycle = createCycleWithRead({
    dataDir: dir, bootId: options.bootId ?? BOOT, registry: reg, now, mode: () => tryb,
    onCard: (view) => { events.push(view); },
    ...(options.io === undefined ? {} : { io: options.io }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  return { dir, reg, cycle, events };
}

const consentPath = (dir: string, key: string, suffix: string): string => join(dir, CONSENT_DIRNAME, SESSION, `${key}${suffix}`);

/** Hook przejmuje plik odpowiedzi (`rename` na `.claimed`) i oddaje jego treść. */
function hookClaims(dir: string, key: string): unknown {
  const from = consentPath(dir, key, '.json');
  const to = consentPath(dir, key, '.claimed');
  renameSync(from, to);
  return JSON.parse(readFileSync(to, 'utf8')) as unknown;
}

/** Kopia transkryptu przypadku w katalogu testu. */
function transcriptOf(dir: string, name: string): string {
  const file = join(dir, 'transkrypt.jsonl');
  copyFileSync(join(FIXTURES, name), file);
  return file;
}

/**
 * Transkrypt przypadku z wywołaniem `toolUseId` podmienionym na inne narzędzie i wejście (nazwa i `input` wpisu
 * `tool_use`, `wireToolInputs` tak samo); reszta tury, w tym wynik i jego `permissionDecision`, bez zmian.
 */
function transcriptWithTool(dir: string, p: Przypadek, toolName: string, input: unknown): string {
  let hits = 0;
  const lines = fixture(p.transkrypt).split('\n').map((line) => {
    if (line === '') return line;
    const entry = JSON.parse(line) as { message?: { content?: unknown }; wireToolInputs?: Record<string, unknown> };
    const content = entry.message?.content;
    if (!Array.isArray(content)) return line;
    const use = (content as Record<string, unknown>[])
      .find((block) => block['type'] === 'tool_use' && block['id'] === p.toolUseId);
    if (use === undefined) return line;
    use['name'] = toolName;
    use['input'] = input;
    if (entry.wireToolInputs !== undefined && p.toolUseId !== null) entry.wireToolInputs[p.toolUseId] = input;
    hits += 1;
    return JSON.stringify(entry);
  });
  expect(hits, `${p.nazwa}: wpis \`tool_use\` ${String(p.toolUseId)}`).toBe(1);
  const file = join(dir, 'transkrypt.jsonl');
  writeFileSync(file, lines.join('\n'));
  return file;
}

/** Wejścia `NotebookEdit` i `WebSearch` w kształcie pomiaru (CLI 2.1.322: wejście hooka = wpis). */
const NOTEBOOK_EDIT_INPUT = {
  notebook_path: '/tmp/projekt/analiza.ipynb', cell_id: 'cell-3', new_source: 'print("rarog")\n', edit_mode: 'replace',
};
const WEB_SEARCH_INPUT = { query: 'herdr agent list protocol', allowed_domains: ['herdr.dev'] };

/** Bajt początku linii z `tool_use` przypadku (podpowiedź followera po odczycie tej linii). */
function lineStartOf(file: string, needle: string): number {
  const text = readFileSync(file);
  const at = text.indexOf(needle);
  expect(at).toBeGreaterThan(-1);
  return text.lastIndexOf(0x0a, at) + 1;
}

/** Przebieg przeglądu dla każdej tury, która czeka na dowód, i rozliczenie faktów w cyklu. */
async function settle(cycle: ConsentCycle, file: string, scanner = createConsentEvidenceScanner()): Promise<void> {
  for (const target of cycle.evidenceTargets()) {
    const pass = await scanner.pass({ ...target, file });
    if (pass.status === 'ok') await cycle.applyTurn(target.sessionId, target.promptId, pass.facts);
  }
}

/** Klucz od zrzutu do `claimed`: rejestracja, karta, decyzja z urządzenia, przejęcie przez hook, `tick`. */
async function claimedKey(h: Harness, dump: HookCallDump, decision: 'allow' | 'deny' = 'allow'): Promise<string> {
  const secret = register(h.reg, dump);
  await observeStandingOf(h.cycle, dump, (ms) => (clock += ms));
  expect(await h.cycle.decide(dump.sessionId, dump.key, decision)).toEqual({ ok: true, state: 'sent' });
  hookClaims(h.dir, dump.key);
  await h.cycle.tick();
  expect(h.cycle.record(dump.sessionId, dump.key)?.state).toBe('claimed');
  return secret;
}

describeTryby('T-05: `pending → running → unknown` (`no-receipt`) po związanym `tool_use_id` (test padający na bazie)', () => {
  it('bash-krotki: karta, zgoda, plik ważny dla hooka, przejęcie, dialog zniknął, wynik `hook/accept`', async () => {
    const p = przypadek('bash-krotki');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    const secret = register(h.reg, dump);

    const view = await h.cycle.observe(SESSION, p.klucz, 'standing', dump);
    expect(view).toMatchObject({
      permId: p.klucz, state: 'pending', canAllow: true, canDeny: true, canRelease: true, unavailable: null,
    });
    expect(view?.presentation).toMatchObject({ inputKind: 'shell', displayText: 'echo m5-krotki > m5-krotki.txt' });

    expect(await h.cycle.decide(SESSION, p.klucz, 'allow')).toEqual({ ok: true, state: 'sent' });
    const file = hookClaims(h.dir, p.klucz);
    expect(verifyConsentFile(file, {
      secret, sessionId: SESSION, key: p.klucz, inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump),
      notBefore: dump.startedAt - 60_000,
    })).toMatchObject({ ok: true, file: { decision: 'allow', reasonId: 'allow' } });

    await h.cycle.tick();
    expect(h.cycle.record(SESSION, p.klucz)?.state).toBe('claimed');
    await h.cycle.observe(SESSION, p.klucz, 'gone');
    expect(h.cycle.record(SESSION, p.klucz)?.state).toBe('running');

    const transcript = transcriptOf(h.dir, p.transkrypt);
    const point = await locateConsentCheckpoint(transcript, SESSION, dump.promptId,
      lineStartOf(transcript, p.toolUseId ?? ''));
    expect(point?.lineStart).toBe(0);
    if (point === null) throw new Error('bez checkpointu');
    await h.cycle.setCheckpoint(SESSION, p.klucz, point);
    await settle(h.cycle, transcript);

    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({
      state: 'unknown', correlation: 'bound', toolUseId: p.toolUseId, decision: 'allow', late: false, cause: 'no-receipt',
    });
    expect(readConsentRecords(h.dir)).toEqual([expect.objectContaining({ key: p.klucz, state: 'unknown' })]);
    expect(h.cycle.card(SESSION, p.klucz)?.state).toBe('unknown');
    expect(h.cycle.evidenceTargets()).toEqual([]);
  });

  it.each(['bash-krotki', 'bash-cd', 'bash-dlugi', 'write', 'edit', 'read', 'mcp', 'bash-odrzuc'])(
    'fixture `%s`: a claimed answer and its `hook` result: `allow` without a receipt = `unknown` (`no-receipt`),'
    + ' `deny` = `applied` (a `deny` needs no receipt)', async (nazwa) => {
      const p = przypadek(nazwa);
      const dump = dumpOf(p);
      clock = dump.startedAt + 50;
      const h = harness();
      await claimedKey(h, dump, nazwa === 'bash-odrzuc' ? 'deny' : 'allow');
      await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
      expect(h.cycle.record(SESSION, p.klucz)).toMatchObject(nazwa === 'bash-odrzuc'
        ? { state: 'applied', cause: null, decision: 'deny', correlation: 'bound', toolUseId: p.toolUseId, late: false }
        : { state: 'unknown', cause: 'no-receipt', correlation: 'bound', toolUseId: p.toolUseId });
    },
  );

  it.each([['NotebookEdit', NOTEBOOK_EDIT_INPUT], ['WebSearch', WEB_SEARCH_INPUT]] as const)(
    '`%s` ze zgodnym skrótem wejścia i wynikiem `hook/accept`: `bound` i `no-receipt` (dotąd `incomparable-input`)',
    async (toolName, toolInput) => {
      const p = przypadek('mcp');
      const dump = dumpOf(p, { toolName, toolInput });
      clock = dump.startedAt + 50;
      const h = harness();
      await claimedKey(h, dump);
      await settle(h.cycle, transcriptWithTool(h.dir, p, toolName, toolInput));
      expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({
        state: 'unknown', correlation: 'bound', toolUseId: p.toolUseId, decision: 'allow', cause: 'no-receipt',
      });
    },
  );
});

describe('T-01: karta kanału ze zrzutu', () => {
  const standing = { scope: 'main' as const, standing: 'standing' as const };

  it('bez rejestracji `no-channel`, zablokowany klucz `key-blocked`, inny skrót karty `card-mismatch`', () => {
    clock = Date.parse('2026-10-30T14:00:00.000Z');
    const reg = registry();
    const dump = syntheticDump('karta', 'Bash', { command: 'ls' });
    expect(consentCardVerdict({ dump, registration: null, signable: false, ...standing }))
      .toMatchObject({ unavailable: 'no-channel', canAllow: false, canSign: false });

    register(reg, dump, createHash('sha256').update('inna karta').digest('hex'));
    const entry = reg.entry(SESSION, dump.key);
    expect(consentCardVerdict({ dump, registration: entry, signable: true, ...standing }))
      .toMatchObject({ unavailable: 'card-mismatch', canAllow: false, canSign: true });

    const other = syntheticDump('blokada', 'Bash', { command: 'ls' });
    register(reg, other);
    expect(reg.register({
      key: other.key, sessionId: SESSION, promptId: other.promptId, secret: 'ab'.repeat(32), inputSha256: other.inputSha256,
      cardSha256: cardShaOf(other), pid: other.pid, startedAt: other.startedAt,
    }).status).toBe(409);
    expect(consentCardVerdict({ dump: other, registration: reg.entry(SESSION, other.key), signable: false, ...standing }))
      .toMatchObject({ unavailable: 'key-blocked', canAllow: false, canSign: false });
  });

  it('zrzut przycięty `truncated`, puste wejście `no-content`, subagent `terminal-only`, dowód: `no-proof`, `hook-dead`', () => {
    const reg = registry();
    const cut = syntheticDump('przyciety', 'Write', { rarogTruncated: true, preview: 'abc' });
    register(reg, cut, createHash('sha256').update('karta hooka').digest('hex'));
    expect(consentCardVerdict({ dump: cut, registration: reg.entry(SESSION, cut.key), signable: true, ...standing }))
      .toMatchObject({ unavailable: 'truncated', canAllow: false, canSign: true, presentation: null });

    const empty = syntheticDump('pusty', 'ExitPlanMode', {});
    register(reg, empty);
    expect(consentCardVerdict({ dump: empty, registration: reg.entry(SESSION, empty.key), signable: true, ...standing }))
      .toMatchObject({ unavailable: 'no-content', canAllow: false, canSign: true });

    const sub = syntheticDump('subagent', 'Bash', { command: 'ls' }, { agentId: 'agent-1' });
    expect(consentCardVerdict({ dump: sub, registration: null, signable: false, ...standing }))
      .toMatchObject({ unavailable: 'terminal-only', canAllow: false, canSign: false });

    const ok = syntheticDump('dowod', 'Bash', { command: 'ls' });
    register(reg, ok);
    const registration = reg.entry(SESSION, ok.key);
    expect(consentCardVerdict({ dump: ok, registration, signable: true, scope: 'main', standing: 'unknown' }))
      .toMatchObject({ unavailable: 'no-proof', canAllow: false, canSign: true });
    expect(consentCardVerdict({ dump: ok, registration, signable: true, scope: 'main', standing: 'dead' }))
      .toMatchObject({ unavailable: 'hook-dead', canAllow: false, canSign: false });
    expect(consentCardVerdict({ dump: ok, registration, signable: true, ...standing }))
      .toMatchObject({ unavailable: null, canAllow: true, canSign: true });
  });

  it('`Write` 30 kB ze zmianą w ostatniej linii: całość i `allow`; po wcięciu ponad sufit: `truncated`', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `linia ${String(i).padStart(4, '0')} ${'x'.repeat(40)}`);
    lines[lines.length - 1] = 'OSTATNIA LINIA: rm -rf ~/projekt';
    const content = lines.join('\n');
    expect(Buffer.byteLength(content)).toBeGreaterThan(28_000);
    const h = harness();
    const dump = syntheticDump('write-30', 'Write', { file_path: '/tmp/projekt/a.txt', content });
    register(h.reg, dump);
    const view = await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    expect(view).toMatchObject({ canAllow: true, unavailable: null, presentation: { inputKind: 'json' } });
    const shown = JSON.parse(view?.presentation?.displayText ?? '{}') as { content: string; file_path: string };
    expect(shown.content).toBe(content);
    expect(shown.content.endsWith('OSTATNIA LINIA: rm -rf ~/projekt')).toBe(true);
    expect(Object.keys(shown)).toEqual(['file_path', 'content']);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });

    // Under 1 MiB compact (the hook keeps it whole), over the display ceiling once indented; 200 KiB: hook test.
    const large = syntheticDump('write-wide', 'Write', { file_path: '/tmp/b.txt', v: Array<number>(400_000).fill(0) });
    register(h.reg, large);
    const card = await h.cycle.observe(SESSION, large.key, 'standing', large);
    expect(presentConsentInput('Write', large.toolInput)?.bytes).toBeGreaterThan(CONSENT_DISPLAY_MAX);
    expect(card).toMatchObject({ unavailable: 'truncated', canAllow: false, canDeny: true, presentation: null });
    expect(await h.cycle.decide(SESSION, large.key, 'allow'))
      .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(consentPath(h.dir, large.key, '.json'))).toBe(false);
  });

  it('dwie komendy `Bash` różne tylko `dangerouslyDisableSandbox`: dwie prezentacje i dwa `cardSha256`', () => {
    const base = { command: 'curl https://example.com', description: 'Pobierz', timeout: 1000 };
    const plain = presentConsentInput('Bash', base);
    const open = presentConsentInput('Bash', { ...base, dangerouslyDisableSandbox: true });
    expect(plain).toMatchObject({ inputKind: 'shell', displayText: base.command, notes: [] });
    expect(plain?.fields).toEqual([{ name: 'description', value: 'Pobierz' }, { name: 'timeout', value: '1000' }]);
    expect(open?.fields).toEqual([
      { name: 'description', value: 'Pobierz' }, { name: 'timeout', value: '1000' },
      { name: 'dangerouslyDisableSandbox', value: 'true' },
    ]);
    expect(open?.notes).toEqual(['sandbox-disabled']);
    const a = syntheticDump('sandbox-a', 'Bash', base);
    const b = syntheticDump('sandbox-b', 'Bash', { ...base, dangerouslyDisableSandbox: true });
    expect(cardShaOf(a)).not.toBe(cardShaOf(b));
  });

  it('nieznane narzędzie: pełny JSON w kolejności pól wejścia', () => {
    const input = { zeta: 1, atlas: { b: [1, 2] } };
    expect(presentConsentInput('mcp__x__y', input)).toMatchObject({
      inputKind: 'json', displayText: JSON.stringify(input, null, 2), fields: [],
    });
  });

  /** Werdykt karty z żywą, przyjętą rejestracją i dowodem „dialog stoi”: zostaje tylko powód z treści. */
  const contentVerdict = (
    seed: string, toolName: string, toolInput: unknown, over: Partial<HookCallDump> = {},
  ): ReturnType<typeof consentCardVerdict> => {
    const reg = registry();
    const dump = syntheticDump(seed, toolName, toolInput, over);
    register(reg, dump);
    return consentCardVerdict({ dump, registration: reg.entry(SESSION, dump.key), signable: true, ...standing });
  };
  const char = (code: number): string => String.fromCodePoint(code);

  it('MCP z wejściem `{}`: karta z treścią i przyciskiem; `Bash` `{}` i `ExitPlanMode` `{}`: `no-content`', () => {
    expect(contentVerdict('mcp-pusty', 'mcp__claude_ai_Asana__get_me', {})).toMatchObject({
      unavailable: null, canAllow: true, canSign: true, presentation: { inputKind: 'json', displayText: '{}' },
    });
    for (const toolName of ['Bash', 'ExitPlanMode']) {
      expect(contentVerdict(`${toolName}-pusty`, toolName, {}), toolName)
        .toMatchObject({ unavailable: 'no-content', canAllow: false, canSign: true });
    }
  });

  it.each([
    ['U+202E w komendzie `Bash`', 'Bash', { command: `echo ${char(0x202e)}gnp.exe` }],
    ['U+200B w treści `Write`', 'Write', { file_path: '/tmp/projekt/a.sh', content: `rm${char(0x200b)} -rf build\n` }],
    ['U+202E w polu `description` `Bash`', 'Bash', { command: 'ls', description: `List ${char(0x202e)}files` }],
    ['CR w komendzie `Bash`', 'Bash', { command: `curl https://example.com/x.sh | sh${char(0x0d)}echo ok` }],
    ['U+2066 w argumencie MCP', 'mcp__pomiar__echo', { text: `a${char(0x2066)}b` }],
  ])('%s: bez przycisku zgody (`hidden-chars`), odmowa i zwolnienie zostają', (_name, toolName, toolInput) => {
    expect(contentVerdict(`ukryty-${_name}`, toolName, toolInput))
      .toMatchObject({ unavailable: 'hidden-chars', canAllow: false, canSign: true });
  });

  it.each([
    ['U+200B', 0x200b],
    ['U+202E', 0x202e],
  ])('%s tylko w katalogu roboczym (`cwd`): bez przycisku zgody (`hidden-chars`)', (_name, code) => {
    expect(contentVerdict(`ukryty-cwd-${_name}`, 'Bash', { command: 'rm -rf build' }, { cwd: `/work/prod${char(code)}` }))
      .toMatchObject({ unavailable: 'hidden-chars', canAllow: false, canSign: true });
  });

  it.each([
    ['emoji z łącznikiem U+200D w komendzie `Bash`', 'Bash', {
      command: `echo "${char(0x1f468)}${char(0x200d)}${char(0x1f469)}${char(0x200d)}${char(0x1f467)}"`,
    }],
    ['heredok `Bash` z tabulatorem', 'Bash', { command: 'cat <<EOF > a.txt\n\tlinia 1\nlinia 2\nEOF' }],
    ['`Write` z końcami linii CRLF (JSON pokazuje `\\r`)', 'Write', {
      file_path: '/tmp/projekt/a.txt', content: `linia 1${char(0x0d)}\nlinia 2${char(0x0d)}\n`,
    }],
    ['`Edit` wielowierszowy', 'Edit', { file_path: '/tmp/projekt/a.ts', old_string: 'a\nb', new_string: 'a\nc' }],
    ['MCP z wielowierszowym argumentem', 'mcp__pomiar__echo', { text: 'linia 1\nlinia 2' }],
  ])('%s: przycisk jak dotąd', (_name, toolName, toolInput) => {
    expect(contentVerdict(`widoczny-${_name}`, toolName, toolInput))
      .toMatchObject({ unavailable: null, canAllow: true, canSign: true });
  });

  it('karta z U+202E w cyklu: `decide(allow)` = `card-changed` bez pliku odpowiedzi', async () => {
    const h = harness();
    const dump = syntheticDump('ukryty-cykl', 'Bash', { command: `echo ${char(0x202e)}gnp.exe` });
    register(h.reg, dump);
    const view = await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    expect(view).toMatchObject({ unavailable: 'hidden-chars', canAllow: false, canDeny: true, canRelease: true });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow'))
      .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(false);
  });
});

describeTryby('T-02, T-10: protokół zapisu, first-wins i przejścia sterujące', () => {
  it('kolejność kroków: rekord `deciding` z `fsync`, plik z `fsync`, rekord `sent`; `deciding` bez zdarzenia', async () => {
    const calls: string[] = [];
    let h: Harness | undefined;
    const io: Partial<ConsentCycleIo> = {
      writeRecord: (dir, record, options) => {
        calls.push(`rekord:${record.state}:${String(options.fsync)}`);
        writeConsentRecord(dir, record, options);
      },
      writeFile: (dir, name, body, options) => {
        calls.push(`plik:${String(options.fsync)}`);
        // Między krokiem 1 a 2 karta na drucie nie zmienia się: `deciding` nie idzie do urządzeń.
        expect(h?.events.at(-1)?.state).toBe('pending');
        writeAtomic(dir, name, body, options);
      },
    };
    h = harness({ io });
    const dump = syntheticDump('kolejnosc', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    calls.length = 0;
    const before = h.events.length;
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect(calls).toEqual(['rekord:deciding:true', 'plik:true', 'rekord:sent:false']);
    expect(h.events.slice(before).map((e) => [e.state, e.canAllow])).toEqual([['sent', false]]);
    expect(wireStateOf('deciding')).toBe('sent');
  });

  it('`Promise.all(allow, deny, release, off)`: jedna decyzja `allow`/`deny`, jeden stan końcowy', async () => {
    const written: string[] = [];
    const h = harness({
      io: {
        writeFile: (dir, name, body, options) => {
          written.push((JSON.parse(body) as { decision: string }).decision);
          writeAtomic(dir, name, body, options);
        },
      },
    });
    const dump = syntheticDump('wyscig', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    const [allow, deny, release, off] = await Promise.all([
      h.cycle.decide(SESSION, dump.key, 'allow'), h.cycle.decide(SESSION, dump.key, 'deny'),
      h.cycle.release(SESSION, dump.key), h.cycle.off(),
    ]);
    expect(allow).toEqual({ ok: true, state: 'sent' });
    expect(deny).toEqual({ ok: false, error: 'decided', state: 'sent' });
    expect(release).toEqual({ ok: true, state: 'sent' });
    expect(off).toBeUndefined();
    expect(written.filter((d) => d === 'allow' || d === 'deny')).toEqual(['allow']);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'off', decision: 'release' });
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(false);
  });

  it('`allow → sent → release`: plik `allow` odwołany, `release` podpisany, hook go przejmuje = `released`', async () => {
    const h = harness();
    const dump = syntheticDump('zwolnij', 'Bash', { command: 'ls' });
    const secret = register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    await h.cycle.decide(SESSION, dump.key, 'allow');
    expect(await h.cycle.release(SESSION, dump.key)).toEqual({ ok: true, state: 'sent' });
    expect(JSON.parse(readFileSync(consentPath(h.dir, dump.key, '.revoked'), 'utf8'))).toMatchObject({ decision: 'allow' });
    const file = hookClaims(h.dir, dump.key);
    expect(verifyConsentFile(file, {
      secret, sessionId: SESSION, key: dump.key, inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump),
      notBefore: dump.startedAt - 60_000,
    })).toMatchObject({ ok: true, file: { decision: 'release', reasonId: 'release' } });
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'released', decision: 'release' });
  });

  it('`release` według stanu: `pending` bez rejestracji, odebrana (409), skończona (410), wyścig z hookiem', async () => {
    const h = harness();
    const bare = syntheticDump('bez-rejestracji', 'Bash', { command: 'ls' });
    await h.cycle.observe(SESSION, bare.key, 'standing', bare);
    expect(h.cycle.card(SESSION, bare.key)).toMatchObject({ unavailable: 'no-channel', canAllow: false, canRelease: true });
    expect(await h.cycle.release(SESSION, bare.key)).toEqual({ ok: true, state: 'released' });
    expect(await h.cycle.release(SESSION, bare.key)).toEqual({ ok: false, error: 'gone', state: 'released' });
    expect(existsSync(join(h.dir, CONSENT_DIRNAME))).toBe(false);

    const claimed = syntheticDump('odebrana', 'Bash', { command: 'ls' });
    await claimedKey(h, claimed);
    expect(await h.cycle.release(SESSION, claimed.key)).toEqual({ ok: false, error: 'too-late', state: 'claimed' });

    // Hook przejmuje plik w chwili zwolnienia: `rename` serwera pada, rekord idzie za przejęciem.
    const race = syntheticDump('wyscig-zwolnienia', 'Bash', { command: 'ls' });
    register(h.reg, race);
    await h.cycle.observe(SESSION, race.key, 'standing', race);
    await h.cycle.decide(SESSION, race.key, 'allow');
    hookClaims(h.dir, race.key);
    expect(await h.cycle.release(SESSION, race.key)).toEqual({ ok: false, error: 'too-late', state: 'claimed' });
  });

  it('`off`: `pending` → `revoked` (`off`), `sent` → plik odwołany, odebrana bez zmian', async () => {
    const h = harness();
    const pending = syntheticDump('off-pending', 'Bash', { command: 'a' });
    const sent = syntheticDump('off-sent', 'Bash', { command: 'b' });
    const taken = syntheticDump('off-claimed', 'Bash', { command: 'c' });
    register(h.reg, pending);
    register(h.reg, sent);
    await h.cycle.observe(SESSION, pending.key, 'standing', pending);
    await h.cycle.observe(SESSION, sent.key, 'standing', sent);
    await h.cycle.decide(SESSION, sent.key, 'deny');
    await claimedKey(h, taken);
    await h.cycle.off();
    expect(h.cycle.record(SESSION, pending.key)).toMatchObject({ state: 'revoked', cause: 'off' });
    expect(h.cycle.record(SESSION, sent.key)).toMatchObject({ state: 'revoked', cause: 'off' });
    expect(existsSync(consentPath(h.dir, sent.key, '.revoked'))).toBe(true);
    expect(h.cycle.record(SESSION, taken.key)?.state).toBe('claimed');
  });

  it('pełny dysk przy rekordzie `deciding`: `write-failed`, bez pliku, karta dalej z przyciskiem; potem zgoda', async () => {
    let full = true;
    const h = harness({
      io: {
        writeRecord: (dir, record, options) => {
          if (full && record.state === 'deciding') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          writeConsentRecord(dir, record, options);
        },
      },
    });
    const dump = syntheticDump('dysk', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'write-failed', state: 'pending' });
    expect(existsSync(join(h.dir, CONSENT_DIRNAME))).toBe(false);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
    expect(readConsentRecords(h.dir)).toEqual([expect.objectContaining({ state: 'pending' })]);
    full = false;
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
  });

  it('pełny dysk przy pliku odpowiedzi: rekord wraca do `pending`, `write-failed`', async () => {
    const h = harness({ io: { writeFile: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } } });
    const dump = syntheticDump('dysk-plik', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    expect(await h.cycle.decide(SESSION, dump.key, 'deny')).toEqual({ ok: false, error: 'write-failed', state: 'pending' });
    expect(readConsentRecords(h.dir)).toEqual([expect.objectContaining({ state: 'pending', decision: null })]);
  });

  it('zgoda bez przycisku w chwili decyzji: 409 `card-changed`; odmowa bez rejestracji: `not-signable`', async () => {
    const h = harness();
    const dump = syntheticDump('bez-dowodu', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    await h.cycle.observe(SESSION, dump.key, 'unknown');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ unavailable: 'no-proof', canAllow: false, canDeny: true });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    const bare = syntheticDump('odmowa-bez', 'Bash', { command: 'ls' });
    await h.cycle.observe(SESSION, bare.key, 'standing', bare);
    expect(await h.cycle.decide(SESSION, bare.key, 'deny')).toEqual({ ok: false, error: 'not-signable', state: 'pending' });
    expect(await h.cycle.decide(SESSION, 'brak', 'deny')).toEqual({ ok: false, error: 'not-found', state: null });
  });
});

describeTryby('T-03, T-04, T-08, T-09, T-12: przejęcie, termin, sygnały', () => {
  it('`sent` 60 s bez przejęcia (także hook zatrzymany `SIGSTOP`): plik odwołany, `revoked` (`claim-timeout`)', async () => {
    const h = harness();
    const dump = syntheticDump('termin', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    await h.cycle.decide(SESSION, dump.key, 'allow');
    clock += CONSENT_CLAIM_TIMEOUT_MS - 1;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('sent');
    clock += 1;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'claim-timeout' });
    expect(existsSync(consentPath(h.dir, dump.key, '.revoked'))).toBe(true);
  });

  it('`.rejected` bez nowego pliku: `revoked` (`signature`); martwy hook przy `sent`: `revoked` (`hook-dead`)', async () => {
    const h = harness();
    const bad = syntheticDump('podpis', 'Bash', { command: 'a' });
    register(h.reg, bad);
    await h.cycle.observe(SESSION, bad.key, 'standing', bad);
    await h.cycle.decide(SESSION, bad.key, 'allow');
    renameSync(consentPath(h.dir, bad.key, '.json'), consentPath(h.dir, bad.key, '.1.rejected'));
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, bad.key)).toMatchObject({ state: 'revoked', cause: 'signature' });

    const dead = syntheticDump('martwy', 'Bash', { command: 'b' });
    register(h.reg, dead);
    await h.cycle.observe(SESSION, dead.key, 'standing', dead);
    await h.cycle.decide(SESSION, dead.key, 'allow');
    await h.cycle.observe(SESSION, dead.key, 'dead');
    expect(h.cycle.record(SESSION, dead.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    expect(existsSync(consentPath(h.dir, dead.key, '.revoked'))).toBe(true);
  });

  it('T-09: `pending` i sygnał negatywny = `revoked` (`dialog-gone`), klawisz przy biurku = `settled-at-desk`', async () => {
    const p = przypadek('sigkill-biurko');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    register(h.reg, dump);
    await h.cycle.observe(SESSION, p.klucz, 'standing', dump);
    await h.cycle.observe(SESSION, p.klucz, 'gone');
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'settled-at-desk', correlation: 'bound' });
  });

  it('T-03 SIGKILL hooka po przejęciu: `claimed` do końca tury, potem wynik przy biurku (`user_temporary`, Esc)', async () => {
    for (const nazwa of ['sigkill-biurko', 'sigkill-esc']) {
      const p = przypadek(nazwa);
      const dump = dumpOf(p);
      clock = dump.startedAt + 50;
      const h = harness();
      await claimedKey(h, dump);
      await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
      expect(h.cycle.record(SESSION, p.klucz), nazwa).toMatchObject({ state: 'settled-at-desk', correlation: 'bound' });
    }
  });

  it('odebrana, a dialog stoi dłużej niż 30 s: `unknown` (`no-effect`); spóźniony wynik `hook` bez potwierdzenia: bez zmian', async () => {
    const p = przypadek('bash-krotki');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    await claimedKey(h, dump);
    await h.cycle.observe(SESSION, p.klucz, 'standing');
    expect(h.cycle.record(SESSION, p.klucz)?.state).toBe('claimed');
    clock += CONSENT_CLAIMED_STANDING_MS;
    await h.cycle.observe(SESSION, p.klucz, 'standing');
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', cause: 'no-effect' });
    await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', late: false, cause: 'no-effect' });
  });

  it('T-04 długi `Bash`: `running` bez wyniku do końca tury, potem `no-receipt`; koniec tury z bezczynności nie zdejmuje', async () => {
    const p = przypadek('bash-dlugi');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    await claimedKey(h, dump);
    await h.cycle.observe(SESSION, p.klucz, 'gone');
    const full = fixture(p.transkrypt);
    const lines = full.split('\n').filter((l) => l !== '');
    const cut = lines.findIndex((l) => l.includes('"tool_result"'));
    const file = join(h.dir, 'transkrypt.jsonl');
    writeFileSync(file, `${lines.slice(0, cut).join('\n')}\n`);
    const scanner = createConsentEvidenceScanner();
    await settle(h.cycle, file, scanner);
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'running', correlation: 'open' });
    appendFileSync(file, `${lines.slice(cut).join('\n')}\n`);
    await settle(h.cycle, file, scanner);
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p.toolUseId });
  });

  it('wynik `hook` z inną decyzją: `unknown` (`foreign-decision`); tura bez wywołania: `unknown` (`no-tool-use`)', async () => {
    const p = przypadek('bash-krotki');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    await claimedKey(h, dump, 'deny');
    await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', cause: 'foreign-decision' });

    const lonely = dumpOf(p, { toolInput: { command: 'echo inne' } });
    const g = harness();
    await claimedKey(g, lonely);
    await settle(g.cycle, transcriptOf(g.dir, p.transkrypt));
    expect(g.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', cause: 'no-tool-use', correlation: 'open' });
  });
});

describeTryby('T-11: odzyskiwanie po restarcie z rekordów i plików', () => {
  const base = (dump: HookCallDump, over: Partial<ConsentRecord>): ConsentRecord => ({
    v: 1, key: dump.key, sessionId: SESSION, promptId: dump.promptId, toolName: dump.toolName,
    inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump), agentId: null, pid: dump.pid,
    hookStartedAt: dump.startedAt, bootId: BOOT, state: 'pending', decision: null, reasonId: null, decisionAt: null,
    correlation: 'open', toolUseId: null, cause: null, late: false, checkpoint: null, times: { pending: clock - 5_000 },
    ...over,
  });
  const decided = (dump: HookCallDump, state: 'deciding' | 'sent', at: number, decision: 'allow' | 'release' = 'allow') =>
    base(dump, {
      state, decision, reasonId: decision, decisionAt: at,
      times: { pending: at - 1_000, deciding: at, ...(state === 'sent' ? { sent: at } : {}) },
    });
  const put = (dir: string, dump: HookCallDump, suffix: string, body = '{}'): void => {
    mkdirSync(join(dir, CONSENT_DIRNAME, SESSION), { recursive: true });
    writeFileSync(consentPath(dir, dump.key, suffix), body);
  };
  /** Treść przejętego pliku odpowiedzi: decyzja i `at`, po których cykl rozpoznaje odbiór bieżącej decyzji. */
  const claimedBody = (decision: 'allow' | 'release', at: number): string => JSON.stringify({ decision, at });

  it('awaria między krokami protokołu: `.claimed` = odebrana, `.rejected` = `signature`, nic = `restart`', async () => {
    const dir = dataDir();
    const cases = {
      claimed: syntheticDump('odz-claimed', 'Bash', { command: '1' }),
      rejected: syntheticDump('odz-rejected', 'Bash', { command: '2' }),
      nothing: syntheticDump('odz-nic', 'Bash', { command: '3' }),
      fresh: syntheticDump('odz-swiezy', 'Bash', { command: '4' }),
      stale: syntheticDump('odz-stary', 'Bash', { command: '5' }),
      pending: syntheticDump('odz-pending', 'Bash', { command: '6' }),
      release: syntheticDump('odz-release', 'Bash', { command: '7' }),
      running: syntheticDump('odz-running', 'Bash', { command: '8' }),
    };
    // Proces zabity między (1) a (2): rekord `deciding`, plik przejęty, odłożony albo żaden.
    writeConsentRecord(dir, decided(cases.claimed, 'deciding', clock - 2_000));
    put(dir, cases.claimed, '.claimed', claimedBody('allow', clock - 2_000));
    writeConsentRecord(dir, decided(cases.rejected, 'deciding', clock - 2_000));
    put(dir, cases.rejected, '.1.rejected');
    writeConsentRecord(dir, decided(cases.nothing, 'deciding', clock - 2_000));
    // Proces zabity między (2) a (3): plik leży, rekord `deciding`; i `sent` sprzed ponad 60 s.
    writeConsentRecord(dir, decided(cases.fresh, 'deciding', clock - 2_000));
    put(dir, cases.fresh, '.json');
    writeConsentRecord(dir, decided(cases.stale, 'sent', clock - CONSENT_CLAIM_TIMEOUT_MS - 1));
    put(dir, cases.stale, '.json');
    writeConsentRecord(dir, base(cases.pending, {}));
    writeConsentRecord(dir, decided(cases.release, 'sent', clock - 2_000, 'release'));
    put(dir, cases.release, '.claimed', claimedBody('release', clock - 2_000));
    writeConsentRecord(dir, base(cases.running, { state: 'running', decision: 'allow', reasonId: 'allow' }));

    const h = harness({ dir, bootId: NEXT_BOOT });
    expect(await h.cycle.recover()).toMatchObject({ records: 8 });
    const state = (dump: HookCallDump) => {
      const record = h.cycle.record(SESSION, dump.key);
      return [record?.state, record?.cause];
    };
    expect(state(cases.claimed)).toEqual(['claimed', null]);
    expect(state(cases.rejected)).toEqual(['revoked', 'signature']);
    expect(state(cases.nothing)).toEqual(['revoked', 'restart']);
    expect(state(cases.fresh)).toEqual(['sent', null]);
    expect(state(cases.stale)).toEqual(['revoked', 'restart']);
    expect(existsSync(consentPath(dir, cases.stale.key, '.revoked'))).toBe(true);
    expect(state(cases.pending)).toEqual(['revoked', 'restart']);
    expect(state(cases.release)).toEqual(['released', null]);
    expect(state(cases.running)).toEqual(['running', null]);
    expect(h.cycle.card(SESSION, cases.running.key)).toMatchObject({ state: 'running', unavailable: 'server-restart' });

    clock += CONSENT_CLAIM_TIMEOUT_MS;
    await h.cycle.tick();
    expect(state(cases.fresh)).toEqual(['revoked', 'claim-timeout']);
    expect(readConsentRecords(dir).every((r) => r.bootId === NEXT_BOOT || r.state === 'running')).toBe(true);
  });

  it('restart przed wynikiem drugiego z dwóch kolejnych: pierwszy rozliczony w trakcie tury, drugi `open` do swojego wyniku', async () => {
    const p1 = przypadek('bash-kolejno-1');
    const p2 = przypadek('bash-kolejno-2');
    const d1 = dumpOf(p1);
    const d2 = dumpOf(p2);
    clock = d2.startedAt + 50;
    const reg = registry();
    const h = harness({ reg });
    await claimedKey(h, d1);
    await claimedKey(h, d2);
    const lines = fixture(p1.transkrypt).split('\n').filter((l) => l !== '');
    const file = join(h.dir, 'transkrypt.jsonl');
    // Do wpisu `tool_use` drugiego wywołania: wynik pierwszego jest, drugiego jeszcze nie.
    writeFileSync(file, `${lines.slice(0, 4).join('\n')}\n`);
    const hint = await locateConsentCheckpoint(file, SESSION, d1.promptId, statSync(file).size);
    if (hint === null) throw new Error('bez checkpointu');
    await h.cycle.setCheckpoint(SESSION, p1.klucz, hint);
    await h.cycle.setCheckpoint(SESSION, p2.klucz, hint);
    await settle(h.cycle, file);
    expect(h.cycle.record(SESSION, p1.klucz)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p1.toolUseId });
    expect(h.cycle.record(SESSION, p2.klucz)).toMatchObject({ state: 'claimed', correlation: 'open', toolUseId: null });

    // Restart: nowy proces, ten sam katalog danych, pusty rejestr; transkrypt dopisuje resztę tury.
    appendFileSync(file, `${lines.slice(4).join('\n')}\n`);
    const after = harness({ dir: h.dir, bootId: NEXT_BOOT });
    await after.cycle.recover();
    await settle(after.cycle, file);
    expect(after.cycle.record(SESSION, p1.klucz)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p1.toolUseId });
    expect(after.cycle.record(SESSION, p2.klucz)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p2.toolUseId });
  });
});

describe('wiązanie klucza z `tool_use.id`', () => {
  it('dwa identyczne `Bash` z kolejnych wiadomości: oba `bound`, każdy ze swoim wywołaniem', async () => {
    const p1 = przypadek('bash-kolejno-1');
    const p2 = przypadek('bash-kolejno-2');
    clock = dumpOf(p2).startedAt + 50;
    const h = harness();
    await claimedKey(h, dumpOf(p1));
    await claimedKey(h, dumpOf(p2));
    await settle(h.cycle, transcriptOf(h.dir, p1.transkrypt));
    expect(h.cycle.record(SESSION, p1.klucz)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p1.toolUseId });
    expect(h.cycle.record(SESSION, p2.klucz)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p2.toolUseId });
  });

  it.each([['bash-rownolegle-1', 'bash-rownolegle-2'], ['read-rownolegle-1', 'read-rownolegle-2']])(
    'dwa identyczne z jednej wiadomości (%s, %s): oba `ambiguous-tool-use`, także po wyniku jednego',
    async (a, b) => {
      const p1 = przypadek(a);
      const p2 = przypadek(b);
      clock = Math.max(dumpOf(p1).startedAt, dumpOf(p2).startedAt) + 50;
      const h = harness();
      await claimedKey(h, dumpOf(p1));
      await claimedKey(h, dumpOf(p2));
      const lines = fixture(p1.transkrypt).split('\n').filter((l) => l !== '');
      const first = lines.findIndex((l) => l.includes('"tool_result"'));
      const file = join(h.dir, 'transkrypt.jsonl');
      writeFileSync(file, `${lines.slice(0, first + 1).join('\n')}\n`);
      const scanner = createConsentEvidenceScanner();
      const target = h.cycle.evidenceTargets()[0];
      if (target === undefined) throw new Error('bez tury');
      const pass = await scanner.pass({ ...target, file });
      if (pass.status !== 'ok') throw new Error('bez przebiegu');
      // Po wyniku jednego z nich tura zamknięta bezczynnością: nakładanie zostaje.
      await h.cycle.applyTurn(SESSION, target.promptId, pass.facts, true);
      for (const p of [p1, p2]) {
        expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', cause: 'ambiguous-tool-use' });
      }
      appendFileSync(file, `${lines.slice(first + 1).join('\n')}\n`);
      await settle(h.cycle, file, scanner);
      for (const p of [p1, p2]) {
        expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({
          state: 'unknown', cause: 'ambiguous-tool-use', correlation: 'ambiguous-tool-use', toolUseId: null,
        });
      }
    },
  );

  it('odwrócona kolejność hooków: drugi klucz, gdy plik zna tylko pierwsze wywołanie — `open` do końca tury', () => {
    const p1 = przypadek('bash-kolejno-1');
    const p2 = przypadek('bash-kolejno-2');
    const keys = [p2, p1].map((p) => {
      const d = dumpOf(p);
      return { key: p.klucz, toolName: d.toolName, inputSha256: d.inputSha256, hookStartedAt: d.startedAt };
    });
    const facts = factsOf(fixture(p1.transkrypt), dumpOf(p1).promptId, 2);
    expect(bindTurn(keys, facts).map((v) => v.correlation)).toEqual(['open', 'open']);
    const full = factsOf(fixture(p1.transkrypt), dumpOf(p1).promptId);
    expect(bindTurn(keys, full).map((v) => [v.correlation, v.toolUseId]))
      .toEqual([['bound', p2.toolUseId], ['bound', p1.toolUseId]]);
  });

  it('`ExitPlanMode`: `bound` po samej nazwie (wejście hooka `{}` różne od wpisu)', () => {
    const p = przypadek('exitplanmode');
    const d = dumpOf(p);
    const facts = factsOf(fixture(p.transkrypt), d.promptId);
    expect(bindTurn([{ key: p.klucz, toolName: d.toolName, inputSha256: d.inputSha256, hookStartedAt: d.startedAt }], facts))
      .toEqual([{ key: p.klucz, correlation: 'bound', toolUseId: p.toolUseId, cause: null }]);
  });

  it.each([['NotebookEdit', NOTEBOOK_EDIT_INPUT], ['WebSearch', WEB_SEARCH_INPUT]] as const)(
    '`%s`: porównanie skrótem wejścia — zgodny `bound`, inny bez kandydata (`no-tool-use`)',
    (toolName, toolInput) => {
      const p = przypadek('mcp');
      const d = dumpOf(p, { toolName, toolInput });
      const dir = dataDir();
      const facts = factsOf(readFileSync(transcriptWithTool(dir, p, toolName, toolInput), 'utf8'), d.promptId);
      const key = (inputSha256: string): Parameters<typeof bindTurn>[0][number] =>
        ({ key: p.klucz, toolName, inputSha256, hookStartedAt: d.startedAt });
      expect(bindTurn([key(d.inputSha256)], facts))
        .toEqual([{ key: p.klucz, correlation: 'bound', toolUseId: p.toolUseId, cause: null }]);
      expect(bindTurn([key(canonicalSha256({ ...toolInput, extra: 1 }))], facts))
        .toEqual([{ key: p.klucz, correlation: 'open', toolUseId: null, cause: 'no-tool-use' }]);
    },
  );

  it('narzędzie spoza listy porównywalnych: `incomparable-input`; dwa klucze na jedno wywołanie: oba wieloznaczne', () => {
    const p = przypadek('bash-krotki');
    const d = dumpOf(p);
    const facts = factsOf(fixture(p.transkrypt), d.promptId);
    expect(bindTurn([{ key: 'k', toolName: 'Task', inputSha256: d.inputSha256, hookStartedAt: d.startedAt }], facts))
      .toEqual([{ key: 'k', correlation: 'incomparable-input', toolUseId: null, cause: 'incomparable-input' }]);
    const twins = ['k1', 'k2'].map((key) => ({ key, toolName: 'Bash', inputSha256: d.inputSha256, hookStartedAt: d.startedAt }));
    expect(bindTurn(twins, facts).map((v) => v.correlation)).toEqual(['ambiguous-tool-use', 'ambiguous-tool-use']);
  });

  it('skutek z wyniku: `hook`, biurko, przerwanie bez źródła, `config`', () => {
    const result = { toolUseId: 't', line: 1, at: 1, decision: 'accept', source: 'hook', interrupted: false };
    expect(consentEffectOf(result)).toEqual({ kind: 'hook', decision: 'allow' });
    expect(consentEffectOf({ ...result, decision: 'reject' })).toEqual({ kind: 'hook', decision: 'deny' });
    expect(consentEffectOf({ ...result, source: 'user_permanent' })).toEqual({ kind: 'desk' });
    expect(consentEffectOf({ ...result, source: null, decision: null, interrupted: true })).toEqual({ kind: 'desk' });
    expect(consentEffectOf({ ...result, source: 'config' })).toEqual({ kind: 'other' });
    expect(consentEffectOf(null)).toEqual({ kind: 'none' });
  });
});

/** Fakty tury z tekstu transkryptu przez skaner (opcjonalnie tylko `limit` pierwszych linii). */
function factsOf(text: string, promptId: string, limit?: number): ConsentTurnFacts {
  const lines = text.split('\n').filter((l) => l !== '');
  const kept = limit === undefined ? lines : lines.slice(0, limit);
  const uses: ConsentTurnFacts['toolUses'][number][] = [];
  const results: ConsentTurnFacts['results'][number][] = [];
  let inside = false;
  let ended = false;
  kept.forEach((line, index) => {
    const entry = JSON.parse(line) as unknown;
    const turn = turnPromptOf(entry);
    if (!inside) {
      if (turn?.promptId !== promptId) return;
      inside = true;
    }
    if (ended) return;
    if ((entry as { subtype?: string }).subtype === 'turn_duration') {
      ended = true;
      return;
    }
    for (const use of turnToolUses(entry)) {
      uses.push({ id: use.id, name: use.toolName, inputSha256: canonicalSha256(use.input), line: index });
    }
    for (const r of toolResultDecisions(entry)) {
      results.push({ toolUseId: r.toolUseId, line: index, at: r.at, decision: r.decision, source: r.source,
        interrupted: r.interrupted });
    }
  });
  return { promptId, ended, partial: false, toolUses: uses, results };
}

describe('przegląd dowodów poza oknem followera (`consent-evidence.ts`)', () => {
  const p = przypadek('bash-krotki');
  const promptId = dumpOf(p).promptId;
  const turn = fixture(p.transkrypt);
  const filler = (bytes: number, prompt = '00000000-0000-4000-9000-0000000000ff'): string => {
    const line = `${JSON.stringify({
      type: 'user', isSidechain: false, promptId: prompt, timestamp: '2026-10-30T13:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'w'.repeat(1000) }] },
    })}\n`;
    return line.repeat(Math.ceil(bytes / line.length));
  };
  const counting = (): { io: ConsentEvidenceIo; bytes: () => number } => {
    let total = 0;
    return {
      io: {
        stat: nodeConsentEvidenceIo.stat,
        read: async (path, start, length) => {
          const buffer = await nodeConsentEvidenceIo.read(path, start, length);
          total += buffer?.length ?? 0;
          return buffer;
        },
      },
      bytes: () => total,
    };
  };

  it('dowód przed oknem historii followera: tura na początku, za nią ponad 8 MiB innych wpisów', async () => {
    const dir = dataDir();
    const file = join(dir, 'transkrypt.jsonl');
    writeFileSync(file, turn + filler(HISTORY_MAX_BYTES + 1024 * 1024));
    const point = await locateConsentCheckpoint(file, SESSION, promptId, statSync(file).size);
    expect(point?.lineStart).toBe(0);
    const pass = await createConsentEvidenceScanner().pass({ sessionId: SESSION, promptId, file, checkpoint: point });
    expect(pass).toMatchObject({ status: 'ok', facts: { ended: true, partial: false } });
  });

  it('checkpoint od podpowiedzi: szukanie wstecz znajduje pierwszą linię tury za starszymi wpisami', async () => {
    const dir = dataDir();
    const file = join(dir, 'transkrypt.jsonl');
    const before = filler(2 * 1024 * 1024);
    writeFileSync(file, before + turn);
    const point = await locateConsentCheckpoint(file, SESSION, promptId, lineStartOf(file, p.toolUseId ?? ''));
    expect(point?.lineStart).toBe(Buffer.byteLength(before));
    // Podpowiedź w środku tury za wpisem przerwania: tura otwiera się dalej wstecz.
    const esc = przypadek('sigkill-esc');
    writeFileSync(file, before + fixture(esc.transkrypt));
    const escPoint = await locateConsentCheckpoint(file, SESSION, dumpOf(esc).promptId, statSync(file).size);
    expect(escPoint?.lineStart).toBe(Buffer.byteLength(before));
  });

  it('przyrost ponad 8 MiB między odczytami i dowód za sufitem jednego przebiegu: dwa przebiegi, postęp', async () => {
    const dir = dataDir();
    const file = join(dir, 'transkrypt.jsonl');
    const lines = turn.split('\n').filter((l) => l !== '');
    const cut = lines.findIndex((l) => l.includes('"tool_result"'));
    writeFileSync(file, `${lines.slice(0, cut).join('\n')}\n`);
    const { io, bytes } = counting();
    const scanner = createConsentEvidenceScanner({ io, maxBytes: 4 * 1024 * 1024 });
    const point = await locateConsentCheckpoint(file, SESSION, promptId, statSync(file).size);
    const first = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: point });
    expect(first).toMatchObject({ status: 'ok', facts: { ended: false }, caughtUp: true });
    // Wpisy tej samej tury (wyniki innych narzędzi) rosną o ponad 8 MiB, dopiero potem wynik i koniec tury.
    const big = `${JSON.stringify({
      type: 'user', isSidechain: false, promptId, timestamp: '2026-10-30T14:24:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_inne', content: 'z'.repeat(1024) }] },
    })}\n`;
    appendFileSync(file, big.repeat(Math.ceil((HISTORY_MAX_BYTES + 512 * 1024) / big.length)));
    appendFileSync(file, `${lines.slice(cut).join('\n')}\n`);
    const read0 = bytes();
    const second = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: point });
    expect(second).toMatchObject({ status: 'ok', facts: { ended: false }, caughtUp: false });
    expect(bytes() - read0).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(bytes() - read0).toBeLessThan(4 * 1024 * 1024 + 2 * 1024 * 1024);
    let last = second;
    for (let i = 0; i < 4 && last.status === 'ok' && !last.facts.ended; i += 1) {
      last = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: point });
    }
    expect(last).toMatchObject({ status: 'ok', facts: { ended: true } });
    if (last.status !== 'ok') throw new Error('bez przebiegu');
    expect(last.facts.results.map((r) => r.toolUseId)).toContain(p.toolUseId);
  });

  it('przerwany zapis `tool_result`, restart i przyrost: niedokończona linia czeka, potem wynik', async () => {
    const dir = dataDir();
    const file = join(dir, 'transkrypt.jsonl');
    const lines = turn.split('\n').filter((l) => l !== '');
    const cut = lines.findIndex((l) => l.includes('"tool_result"'));
    const result = lines[cut] ?? '';
    writeFileSync(file, `${lines.slice(0, cut).join('\n')}\n${result.slice(0, 50)}`);
    const point = await locateConsentCheckpoint(file, SESSION, promptId, 0);
    const before = await createConsentEvidenceScanner().pass({ sessionId: SESSION, promptId, file, checkpoint: point });
    expect(before).toMatchObject({ status: 'ok', facts: { ended: false, results: [] } });
    // Restart: nowy skaner od checkpointu z rekordu, plik dopisany do końca.
    appendFileSync(file, `${result.slice(50)}\n${lines.slice(cut + 1).join('\n')}\n`);
    const after = await createConsentEvidenceScanner().pass({ sessionId: SESSION, promptId, file, checkpoint: point });
    expect(after).toMatchObject({ status: 'ok', facts: { ended: true } });
    if (after.status !== 'ok') throw new Error('bez przebiegu');
    expect(after.facts.results).toEqual([expect.objectContaining({ toolUseId: p.toolUseId, source: 'hook' })]);
  });

  it('przeniesiony i skrócony transkrypt: inny plik albo `inode` i krótszy plik = przegląd od początku', async () => {
    const dir = dataDir();
    const file = join(dir, 'transkrypt.jsonl');
    const before = filler(64 * 1024);
    writeFileSync(file, before + turn);
    const point = await locateConsentCheckpoint(file, SESSION, promptId, statSync(file).size);
    if (point === null) throw new Error('bez checkpointu');
    expect(point.lineStart).toBe(Buffer.byteLength(before));
    const moved = join(dir, 'przeniesiony.jsonl');
    writeFileSync(moved, turn);
    const pass = await createConsentEvidenceScanner().pass({ sessionId: SESSION, promptId, file: moved, checkpoint: point });
    expect(pass).toMatchObject({ status: 'ok', facts: { ended: true }, checkpoint: { file: moved, lineStart: 0 } });

    const scanner = createConsentEvidenceScanner();
    await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: point });
    truncateSync(file, 0);
    appendFileSync(file, turn);
    const shorter = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: point });
    expect(shorter).toMatchObject({ status: 'ok', facts: { ended: true }, checkpoint: { lineStart: 0 } });
    expect(await scanner.pass({ sessionId: SESSION, promptId, file: join(dir, 'brak.jsonl'), checkpoint: point }))
      .toEqual({ status: 'missing' });
  });

  it('checkpoint w środku tury (zły zapis): przegląd wraca na początek pliku zamiast gubić wywołania', async () => {
    const dir = dataDir();
    const file = join(dir, 'transkrypt.jsonl');
    const before = filler(16 * 1024);
    writeFileSync(file, before + turn);
    const info = statSync(file);
    const mid: ConsentCheckpoint = {
      file, sessionId: SESSION, inode: info.ino, lineStart: lineStartOf(file, `"tool_use_id":"${p.toolUseId ?? ''}"`),
    };
    const scanner = createConsentEvidenceScanner();
    const first = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: mid });
    expect(first).toMatchObject({ status: 'ok', facts: { partial: true }, checkpoint: { lineStart: 0 }, caughtUp: false });
    const second = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: mid });
    expect(second).toMatchObject({ status: 'ok', facts: { partial: false, ended: true } });
  });
});

describe('rekordy `consent-records/` i sprzątanie', () => {
  it('rekord bez `tool_input` i sekretu; zły kształt i cudza nazwa pominięte', async () => {
    const h = harness();
    const dump = syntheticDump('rekord', 'Bash', { command: 'echo SEKRETNA-KOMENDA' });
    const secret = register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    await h.cycle.decide(SESSION, dump.key, 'allow');
    const raw = readFileSync(join(h.dir, CONSENT_RECORDS_DIRNAME, SESSION, `${dump.key}.json`), 'utf8');
    expect(raw).not.toContain('SEKRETNA-KOMENDA');
    expect(raw).not.toContain(secret);
    writeFileSync(join(h.dir, CONSENT_RECORDS_DIRNAME, SESSION, 'obcy.json'), raw);
    writeFileSync(join(h.dir, CONSENT_RECORDS_DIRNAME, SESSION, 'zepsuty.json'), '{');
    expect(readConsentRecords(h.dir).map((r) => r.key)).toEqual([dump.key]);
  });

  it('sprzątanie: `consent/` po `timeout` hooka plus zapas, rekordy po 30 dniach', () => {
    const dir = dataDir();
    const aged = (path: string, ageMs: number): void => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, '{}');
      const at = (clock - ageMs) / 1000;
      utimesSync(path, at, at);
    };
    aged(join(dir, CONSENT_DIRNAME, SESSION, 'stary.claimed'), CONSENT_FILE_TTL_MS + 60_000);
    aged(join(dir, CONSENT_DIRNAME, SESSION, 'mlody.json'), CONSENT_FILE_TTL_MS - 60_000);
    aged(join(dir, CONSENT_RECORDS_DIRNAME, SESSION, 'stary.json'), CONSENT_RECORD_RETENTION_MS + 60_000);
    aged(join(dir, CONSENT_RECORDS_DIRNAME, SESSION, 'mlody.json'), 60_000);
    expect(sweepConsentFiles(dir, now)).toEqual({ consentFiles: 1, records: 1 });
    expect(readdirSync(join(dir, CONSENT_DIRNAME, SESSION))).toEqual(['mlody.json']);
    expect(readdirSync(join(dir, CONSENT_RECORDS_DIRNAME, SESSION))).toEqual(['mlody.json']);
  });

  it('`writeAtomic` z `fsync`: ta sama treść i prawa co bez opcji, bez resztek `.tmp`', () => {
    const dir = dataDir();
    writeAtomic(dir, 'a.json', 'treść\n', { fsync: true });
    writeAtomic(dir, 'b.json', 'treść\n');
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('treść\n');
    expect(statSync(join(dir, 'a.json')).mode & 0o777).toBe(statSync(join(dir, 'b.json')).mode & 0o777);
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'b.json']);
  });
});

describeTryby('odwołanie niepotwierdzone, przejęcie przed przeglądem plików, stara `.claimed`', () => {
  const failingRevoke = (code: string): Partial<ConsentCycleIo> => ({
    rename: (from, to) => {
      if (to.endsWith('.revoked')) throw Object.assign(new Error(code), { code });
      renameSync(from, to);
    },
  });

  it('`rename` odwołania pada (`EIO`): `off` zostawia `sent`, `release` bez nowego pliku, potem termin przejęcia', async () => {
    let broken = true;
    const h = harness({
      io: {
        rename: (from, to) => {
          if (broken && to.endsWith('.revoked')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
          renameSync(from, to);
        },
      },
    });
    const dump = syntheticDump('odwolanie-eio', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    await h.cycle.decide(SESSION, dump.key, 'allow');
    await h.cycle.off();
    // Podpisana zgoda dalej leży, więc rekord nie może mówić `revoked`.
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'sent', decision: 'allow' });
    expect(JSON.parse(readFileSync(consentPath(h.dir, dump.key, '.json'), 'utf8'))).toMatchObject({ decision: 'allow' });
    expect(await h.cycle.release(SESSION, dump.key)).toEqual({ ok: false, error: 'write-failed', state: 'sent' });
    expect(JSON.parse(readFileSync(consentPath(h.dir, dump.key, '.json'), 'utf8'))).toMatchObject({ decision: 'allow' });
    await h.cycle.observe(SESSION, dump.key, 'dead');
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('sent');
    broken = false;
    clock += CONSENT_CLAIM_TIMEOUT_MS;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'claim-timeout' });
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(false);
  });

  it('`ENOENT` przy odwołaniu bez przejęcia i bez `.rejected`: `revoked` jak dotąd', async () => {
    const h = harness({ io: failingRevoke('ENOENT') });
    const dump = syntheticDump('odwolanie-enoent', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    await h.cycle.decide(SESSION, dump.key, 'allow');
    await h.cycle.off();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'off' });
  });

  it('wynik `hook/accept` i koniec tury przed `tick`: przejęcie rozliczone od razu (`unknown`, `no-receipt`)', async () => {
    const p = przypadek('bash-krotki');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    register(h.reg, dump);
    await h.cycle.observe(SESSION, p.klucz, 'standing', dump);
    await h.cycle.decide(SESSION, p.klucz, 'allow');
    hookClaims(h.dir, p.klucz);
    expect(h.cycle.record(SESSION, p.klucz)?.state).toBe('sent');
    await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p.toolUseId });
    expect(h.cycle.evidenceTargets()).toEqual([]);
  });

  it('hook przejmuje plik w chwili odwołania na końcu tury: ten sam wynik tury daje `unknown` (`no-receipt`)', async () => {
    const p = przypadek('bash-krotki');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness({
      io: {
        rename: (from, to) => {
          if (to.endsWith('.revoked')) {
            renameSync(from, from.replace(/\.json$/u, '.claimed'));
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          }
          renameSync(from, to);
        },
      },
    });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, p.klucz, 'standing', dump);
    await h.cycle.decide(SESSION, p.klucz, 'allow');
    await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p.toolUseId });
  });

  it('odebrana bez wyniku, przejęcie wykryte po zamknięciu tury: następny przegląd z końcem tury ją rozlicza', async () => {
    const p = przypadek('bash-krotki');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    register(h.reg, dump);
    await h.cycle.observe(SESSION, p.klucz, 'standing', dump);
    await h.cycle.decide(SESSION, p.klucz, 'allow');
    // Tura zamknięta faktami bez tego wywołania (np. przegląd przy forsowanym końcu), plik dalej nieprzejęty.
    await h.cycle.applyTurn(SESSION, dump.promptId, {
      promptId: dump.promptId, ended: true, partial: false, toolUses: [], results: [],
    });
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'revoked', cause: 'turn-ended' });

    const late = syntheticDump('po-zamknieciu', 'Bash', { command: 'ls' }, { promptId: dump.promptId });
    register(h.reg, late);
    await h.cycle.observe(SESSION, late.key, 'standing', late);
    await h.cycle.decide(SESSION, late.key, 'allow');
    hookClaims(h.dir, late.key);
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, late.key)?.state).toBe('claimed');
    expect(h.cycle.evidenceTargets().map((t) => t.keys)).toEqual([[late.key]]);
    await h.cycle.applyTurn(SESSION, dump.promptId, {
      promptId: dump.promptId, ended: true, partial: false, toolUses: [], results: [],
    });
    expect(h.cycle.record(SESSION, late.key)).toMatchObject({ state: 'unknown', cause: 'no-tool-use' });
  });

  it('`unknown → release` (T-10): 409 `too-late`, bez nowego pliku, rekord bez zmian; spóźniony dowód bez potwierdzenia też', async () => {
    const p = przypadek('bash-krotki');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    await claimedKey(h, dump);
    clock += CONSENT_CLAIMED_STANDING_MS;
    await h.cycle.observe(SESSION, p.klucz, 'standing');
    const before = h.cycle.record(SESSION, p.klucz);
    expect(before).toMatchObject({ state: 'unknown', cause: 'no-effect', decision: 'allow' });
    expect(h.cycle.card(SESSION, p.klucz)).toMatchObject({ canRelease: false });
    const files = readdirSync(join(h.dir, CONSENT_DIRNAME, SESSION)).sort();

    expect(await h.cycle.release(SESSION, p.klucz)).toEqual({ ok: false, error: 'too-late', state: 'unknown' });
    // Hook mógł już wykonać przejętą decyzję: żadnego nowego pliku odpowiedzi pod tym kluczem.
    expect(existsSync(consentPath(h.dir, p.klucz, '.json'))).toBe(false);
    expect(readdirSync(join(h.dir, CONSENT_DIRNAME, SESSION)).sort()).toEqual(files);
    expect(h.cycle.record(SESSION, p.klucz)).toEqual(before);
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', decision: 'allow' });

    await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', late: false, cause: 'no-effect' });
  });

  it('wejście JSON z własnym polem `__proto__`: prezentacja pokazuje je w całości', () => {
    const input = JSON.parse('{"path":"visible","__proto__":{"secret_action":"hidden"}}') as unknown;
    const shown = presentConsentInput('mcp__serwer__narzedzie', input);
    expect(shown?.displayText).toContain('"__proto__"');
    expect(shown?.displayText).toContain('secret_action');
    expect(JSON.parse(shown?.displayText ?? 'null')).toEqual(input);
  });
});

describe('linia dłuższa niż sufit przebiegu', () => {
  const p = przypadek('bash-krotki');
  const promptId = dumpOf(p).promptId;
  const MIB = 1024 * 1024;

  /** Transkrypt przypadku z linią wyniku powiększoną o `pad` bajtów (pole spoza kontraktu, parser go nie czyta). */
  function withLongResult(pad: number): { head: string; result: string; tail: string } {
    const lines = fixture(p.transkrypt).split('\n').filter((l) => l !== '');
    const cut = lines.findIndex((l) => l.includes(`"tool_use_id":"${p.toolUseId ?? ''}"`) && l.includes('"tool_result"'));
    expect(cut).toBeGreaterThan(-1);
    const entry = JSON.parse(lines[cut] ?? '') as Record<string, unknown>;
    const result = JSON.stringify({ ...entry, wypelnienie: 'x'.repeat(pad) });
    return {
      head: `${lines.slice(0, cut).join('\n')}\n`, result: `${result}\n`, tail: `${lines.slice(cut + 1).join('\n')}\n`,
    };
  }

  function countingIo(): { io: ConsentEvidenceIo; reads: number[] } {
    const reads: number[] = [];
    return {
      reads,
      io: {
        stat: nodeConsentEvidenceIo.stat,
        read: async (path, start, length) => {
          const buffer = await nodeConsentEvidenceIo.read(path, start, length);
          reads.push(buffer?.length ?? 0);
          return buffer;
        },
      },
    };
  }

  it('pełna linia 3 MiB przy suficie 1 MiB: każdy przebieg czyta najwyżej 1 MiB, wynik dochodzi', async () => {
    const dir = dataDir();
    const file = join(dir, 'transkrypt.jsonl');
    const { head, result, tail } = withLongResult(3 * MIB);
    writeFileSync(file, head + result + tail);
    const { io, reads } = countingIo();
    const scanner = createConsentEvidenceScanner({ io, maxBytes: MIB });
    let pass = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: null });
    for (let i = 0; i < 10 && pass.status === 'ok' && !pass.facts.ended; i += 1) {
      const before = reads.reduce((a, b) => a + b, 0);
      pass = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: null });
      expect(reads.reduce((a, b) => a + b, 0) - before).toBeLessThanOrEqual(MIB);
    }
    expect(pass).toMatchObject({ status: 'ok', facts: { ended: true } });
    if (pass.status !== 'ok') throw new Error('bez przebiegu');
    expect(pass.facts.results.map((r) => r.toolUseId)).toContain(p.toolUseId);
  });

  it('niedokończona linia dłuższa niż sufit: czeka w pamięci przeglądu, po dopisaniu reszty wynik dochodzi', async () => {
    const dir = dataDir();
    const file = join(dir, 'transkrypt.jsonl');
    const { head, result, tail } = withLongResult(2 * MIB);
    const half = Math.floor(result.length / 2);
    writeFileSync(file, head + result.slice(0, half));
    const { io, reads } = countingIo();
    const scanner = createConsentEvidenceScanner({ io, maxBytes: MIB });
    let pass = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: null });
    for (let i = 0; i < 5 && pass.status === 'ok' && !pass.caughtUp; i += 1) {
      pass = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: null });
    }
    expect(pass).toMatchObject({ status: 'ok', caughtUp: true, facts: { ended: false, results: [] } });
    const total = reads.reduce((a, b) => a + b, 0);
    expect(total).toBe(statSync(file).size);
    appendFileSync(file, result.slice(half) + tail);
    for (let i = 0; i < 5 && pass.status === 'ok' && !pass.facts.ended; i += 1) {
      pass = await scanner.pass({ sessionId: SESSION, promptId, file, checkpoint: null });
    }
    expect(pass).toMatchObject({ status: 'ok', facts: { ended: true } });
    if (pass.status !== 'ok') throw new Error('bez przebiegu');
    expect(pass.facts.results.map((r) => r.toolUseId)).toContain(p.toolUseId);
    expect(reads.every((n) => n <= MIB)).toBe(true);
  });
});

describe('pole audytu `buttonless` (kontrakt dla audytu kanału)', () => {
  const bash = { command: 'npm test' };

  it('karta wątku głównego bez `canAllow` przy żywym hooku i przyjętej rejestracji: pole raz, z powodem karty', async () => {
    const h = harness();
    const dump = syntheticDump('bez-przycisku', 'Bash', bash);
    register(h.reg, dump);
    const at = clock;
    const view = await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    expect(view).toMatchObject({ state: 'pending', canAllow: false, canDeny: true, unavailable: 'no-proof' });
    expect(h.cycle.record(SESSION, dump.key)?.buttonless).toEqual({ reason: 'no-proof', at });
    clock += 5_000;
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    expect(h.cycle.card(SESSION, dump.key)?.canAllow).toBe(true);
    // Ustawione raz: następne sygnały (także karta z przyciskiem) chwili i powodu nie zmieniają.
    expect(h.cycle.record(SESSION, dump.key)?.buttonless).toEqual({ reason: 'no-proof', at });
    const onDisk = readConsentRecords(h.dir).find((r) => r.key === dump.key);
    expect(onDisk?.buttonless).toEqual({ reason: 'no-proof', at });
  });

  it('pole przeżywa przejście i restart: rekord po odzyskaniu niesie je dalej', async () => {
    const h = harness();
    const dump = syntheticDump('bez-przycisku-restart', 'Bash', bash);
    register(h.reg, dump);
    const at = clock;
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    expect((await h.cycle.decide(SESSION, dump.key, 'allow')).ok).toBe(true);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'sent', buttonless: { reason: 'no-proof', at } });
    const next = harness({ dir: h.dir, bootId: NEXT_BOOT });
    await next.cycle.recover();
    expect(next.cycle.record(SESSION, dump.key)?.buttonless).toEqual({ reason: 'no-proof', at });
    expect(readConsentRecords(h.dir).find((r) => r.key === dump.key)?.buttonless).toEqual({ reason: 'no-proof', at });
  });

  it('bez pola: karta z przyciskiem od początku, karta subagenta (`terminal-only`), brak rejestracji', async () => {
    const h = harness();
    const ok = syntheticDump('z-przyciskiem', 'Bash', bash);
    register(h.reg, ok);
    expect(await h.cycle.observe(SESSION, ok.key, 'standing', ok)).toMatchObject({ canAllow: true });
    // Rejestr odmawia rejestracji subagenta (zakres tylko dla wątku głównego), więc karta jest bez rejestracji.
    const sub = syntheticDump('subagent', 'Bash', bash, { agentId: 'agent-1' });
    expect(await h.cycle.observe(SESSION, sub.key, 'unknown', sub)).toMatchObject({ canAllow: false });
    const unregistered = syntheticDump('bez-rejestracji', 'Bash', bash);
    expect(await h.cycle.observe(SESSION, unregistered.key, 'unknown', unregistered)).toMatchObject({ canAllow: false });
    for (const dump of [ok, sub, unregistered]) {
      expect(h.cycle.record(SESSION, dump.key)?.buttonless, dump.key).toBeUndefined();
    }
    expect(h.cycle.card(SESSION, sub.key)?.unavailable).toBe('terminal-only');
  });
});

describe('odczyt rekordu z polem `buttonless` w złym kształcie', () => {
  it('rekord zostaje, pole odpada', async () => {
    const h = harness();
    const dump = syntheticDump('zly-ksztalt', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    const record = h.cycle.record(SESSION, dump.key);
    if (record === null) throw new Error('bez rekordu');
    const file = join(h.dir, CONSENT_RECORDS_DIRNAME, SESSION, `${dump.key}.json`);
    writeFileSync(file, `${JSON.stringify({ ...record, buttonless: { reason: 'cokolwiek', at: 1 } })}\n`);
    const read = readConsentRecords(h.dir).find((r) => r.key === dump.key);
    expect(read).toMatchObject({ key: dump.key, state: 'pending' });
    expect(read?.buttonless).toBeUndefined();
  });
});

describeTryby('S3a-6c: koniec sesji (`revokeSession`) i wpis rejestru po śmierci hooka', () => {
  const OTHER = '00000000-0000-4000-9000-0000000000bb';

  /** Rejestr z dwiema obserwowanymi sesjami: druga pilnuje, że koniec jednej nie rusza drugiej. */
  function twoSessionRegistry(): ConsentRegistry {
    const reg = createConsentRegistry({
      bootId: BOOT, send: () => true, sessions: () => [SESSION, OTHER], log: () => {}, now,
    });
    reg.setScope(tryb);
    return reg;
  }

  /** Nazwy plików katalogu odpowiedzi sesji, posortowane. */
  const answerFiles = (dir: string): string[] => {
    const at = join(dir, CONSENT_DIRNAME, SESSION);
    return existsSync(at) ? readdirSync(at).sort() : [];
  };

  /** Karta z rejestracją i sygnałem `standing`; zegar idzie o 1 ms, żeby kolejność kart była jawna. */
  async function card(h: Harness, dump: HookCallDump): Promise<void> {
    register(h.reg, dump);
    await h.cycle.observe(dump.sessionId, dump.key, 'standing', dump);
    clock += 1;
  }

  it('`hook-dead`: `pending` → `revoked`, `sent` → plik odwołany, `claimed` bez zmian, zero plików odpowiedzi,'
    + ' wpisy sesji zapomniane (także bez karty), druga sesja nietknięta', async () => {
    const h = harness({ reg: twoSessionRegistry() });
    const pending = syntheticDump('kon-pending', 'Bash', { command: 'p' });
    const sent = syntheticDump('kon-sent', 'Bash', { command: 's' });
    const taken = syntheticDump('kon-claimed', 'Bash', { command: 'c' });
    const orphan = syntheticDump('kon-bez-karty', 'Bash', { command: 'o' });
    const other = syntheticDump('kon-inna-sesja', 'Bash', { command: 'i' }, { sessionId: OTHER });
    for (const dump of [pending, sent, taken, other]) await card(h, dump);
    register(h.reg, orphan);
    expect(await h.cycle.decide(SESSION, sent.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect(await h.cycle.decide(SESSION, taken.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    hookClaims(h.dir, taken.key);
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, taken.key)?.state).toBe('claimed');

    const filesBefore = answerFiles(h.dir);
    expect(filesBefore).toEqual([`${sent.key}.json`, `${taken.key}.claimed`].sort());
    const eventsBefore = h.events.length;
    const changed = await h.cycle.revokeSession(SESSION, 'hook-dead');

    expect(changed).toEqual([pending.key, sent.key]);
    expect(h.cycle.record(SESSION, pending.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    expect(h.cycle.record(SESSION, sent.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    expect(h.cycle.record(SESSION, taken.key)).toMatchObject({ state: 'claimed', cause: null });
    // Zero nowych plików odpowiedzi: jedyna zmiana w katalogu to odwołanie pliku `sent` (`rename` na `.revoked`).
    expect(answerFiles(h.dir)).toEqual([`${sent.key}.revoked`, `${taken.key}.claimed`].sort());
    // Zdarzenie karty dla każdej zmienionej, żadnego dla reszty.
    expect(h.events.slice(eventsBefore).map((view) => `${view.permId} ${view.state}`).sort())
      .toEqual([`${pending.key} revoked`, `${sent.key} revoked`].sort());
    for (const dump of [pending, sent, taken, orphan]) expect(h.reg.entry(SESSION, dump.key), dump.key).toBeNull();
    // Druga sesja: karta i wpis zostają.
    expect(h.cycle.record(OTHER, other.key)?.state).toBe('pending');
    expect(h.reg.secretOf(OTHER, other.key)).not.toBeNull();
    // Powtórka niczego już nie zmienia.
    expect(await h.cycle.revokeSession(SESSION, 'hook-dead')).toEqual([]);
  });

  it('`dialog-gone`: `pending` i `sent` → `revoked` (`dialog-gone`), wpisy rejestru zostają (hook może żyć)', async () => {
    const h = harness();
    const pending = syntheticDump('stale-pending', 'Bash', { command: 'p' });
    const sent = syntheticDump('stale-sent', 'Bash', { command: 's' });
    for (const dump of [pending, sent]) await card(h, dump);
    await h.cycle.decide(SESSION, sent.key, 'allow');
    expect(await h.cycle.revokeSession(SESSION, 'dialog-gone')).toEqual([pending.key, sent.key]);
    expect(h.cycle.record(SESSION, pending.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    expect(h.cycle.record(SESSION, sent.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    expect(answerFiles(h.dir)).toEqual([`${sent.key}.revoked`]);
    for (const dump of [pending, sent]) expect(h.reg.entry(SESSION, dump.key), dump.key).not.toBeNull();
  });

  it('hook przejął plik przed odwołaniem: `sent` → `claimed` (w wyniku), bez `.revoked` i bez nowego pliku', async () => {
    const h = harness();
    const dump = syntheticDump('kon-wyscig', 'Bash', { command: 'w' });
    await card(h, dump);
    await h.cycle.decide(SESSION, dump.key, 'allow');
    hookClaims(h.dir, dump.key);
    expect(await h.cycle.revokeSession(SESSION, 'hook-dead')).toEqual([dump.key]);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'claimed', cause: null });
    expect(answerFiles(h.dir)).toEqual([`${dump.key}.claimed`]);
  });

  it('sygnał `dead` zapomina wpis rejestru (z kartą i bez); `gone`, `standing` i `unknown` go zostawiają', async () => {
    const h = harness();
    const withCard = syntheticDump('martwy-z-karta', 'Bash', { command: 'k' });
    await card(h, withCard);
    await h.cycle.observe(SESSION, withCard.key, 'dead');
    expect(h.cycle.record(SESSION, withCard.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    expect(h.reg.entry(SESSION, withCard.key)).toBeNull();

    const bare = syntheticDump('martwy-bez-karty', 'Bash', { command: 'b' });
    register(h.reg, bare);
    expect(await h.cycle.observe(SESSION, bare.key, 'dead')).toBeNull();
    expect(h.reg.entry(SESSION, bare.key)).toBeNull();
    expect(h.cycle.record(SESSION, bare.key)).toBeNull();

    const alive = syntheticDump('zywy', 'Bash', { command: 'z' });
    await card(h, alive);
    for (const signal of ['standing', 'unknown'] as const) await h.cycle.observe(SESSION, alive.key, signal);
    expect(h.reg.secretOf(SESSION, alive.key)).not.toBeNull();
    await h.cycle.observe(SESSION, alive.key, 'gone');
    expect(h.cycle.record(SESSION, alive.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    expect(h.reg.entry(SESSION, alive.key)).not.toBeNull();

    // Odebrana odpowiedź i martwy hook bez faktów sesji: wpis zapomniany, a stan zostaje `claimed`, bo o dialogu
    // rozstrzyga rejestr CLI odczytany po odbiorze (`layer1-observation.test.ts`).
    const taken = syntheticDump('martwy-po-odbiorze', 'Bash', { command: 'o' });
    await card(h, taken);
    await h.cycle.decide(SESSION, taken.key, 'allow');
    hookClaims(h.dir, taken.key);
    await h.cycle.tick();
    await h.cycle.observe(SESSION, taken.key, 'dead');
    expect(h.cycle.record(SESSION, taken.key)?.state).toBe('claimed');
    expect(h.reg.entry(SESSION, taken.key)).toBeNull();
  });

  it('65 kolejnych rejestracji w jednej sesji, każda po śmierci poprzedniego hooka: 65. przyjęta', async () => {
    const h = harness();
    for (let i = 0; i < 65; i += 1) {
      const dump = syntheticDump(`seria-${String(i)}`, 'Bash', { command: `echo ${String(i)}` });
      register(h.reg, dump);
      await h.cycle.observe(SESSION, dump.key, 'standing', dump);
      await h.cycle.observe(SESSION, dump.key, 'dead');
    }
    expect(h.reg.entries()).toEqual([]);
  });

  it('pierwsza obserwacja w kolejce przed `revokeSession` i `off`: karta odwołana, zgoda potem odrzucona', async () => {
    const h = harness();
    const late = syntheticDump('kolejka-odwolanie', 'Bash', { command: 'q' });
    register(h.reg, late);
    const observed = h.cycle.observe(SESSION, late.key, 'standing', late);
    const changed = await h.cycle.revokeSession(SESSION, 'dialog-gone');
    await observed;
    expect(changed).toEqual([late.key]);
    expect(h.cycle.record(SESSION, late.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    expect((await h.cycle.decide(SESSION, late.key, 'allow')).ok).toBe(false);

    const later = syntheticDump('kolejka-wylacznik', 'Bash', { command: 'w' });
    register(h.reg, later);
    const pendingObserve = h.cycle.observe(SESSION, later.key, 'standing', later);
    await h.cycle.off();
    await pendingObserve;
    expect(h.cycle.record(SESSION, later.key)).toMatchObject({ state: 'revoked', cause: 'off' });
  });
});

describe('przegląd dowodów w serwerze (`createConsentEvidenceReview`)', () => {
  const INTERVAL = 30_000;

  /** Linie transkryptu przypadku i indeks pierwszej linii z wynikiem narzędzia. */
  function linesOf(p: Przypadek): { lines: string[]; cut: number } {
    const lines = fixture(p.transkrypt).split('\n').filter((l) => l !== '');
    const cut = lines.findIndex((l) => l.includes('"tool_result"'));
    expect(cut).toBeGreaterThan(0);
    return { lines, cut };
  }

  /** Klucz przypadku `bash-krotki` w `running` (odebrana zgoda, dialog zniknął). */
  async function runningKey(h: Harness): Promise<HookCallDump> {
    const dump = dumpOf(przypadek('bash-krotki'));
    await claimedKey(h, dump);
    await h.cycle.observe(SESSION, dump.key, 'gone');
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('running');
    return dump;
  }

  it('checkpoint pierwszym tikiem, przebieg od razu, potem co interwał: `running` → `unknown` (`no-receipt`)', async () => {
    const p = przypadek('bash-krotki');
    clock = dumpOf(p).startedAt + 50;
    const h = harness();
    const dump = await runningKey(h);
    const { lines, cut } = linesOf(p);
    const file = join(h.dir, 'transkrypt.jsonl');
    writeFileSync(file, `${lines.slice(0, cut).join('\n')}\n`);
    const located: Array<[string, string | null]> = [];
    const review = createConsentEvidenceReview({
      cycle: h.cycle, now, intervalMs: INTERVAL,
      locate: async (sessionId, known) => { located.push([sessionId, known]); return file; },
    });

    await review.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({
      state: 'running', checkpoint: { file, sessionId: SESSION, lineStart: 0, inode: statSync(file).ino },
    });
    expect(located[0]).toEqual([SESSION, null]);

    appendFileSync(file, `${lines.slice(cut).join('\n')}\n`);
    clock += INTERVAL - 1;
    await review.tick();
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('running');
    clock += 1;
    await review.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p.toolUseId });
    expect(h.cycle.evidenceTargets()).toEqual([]);
  });

  it('restart po `claimed`: przegląd rusza od zapisanego checkpointu (bajty przed nim się nie liczą), `no-receipt`',
    async () => {
      const p = przypadek('bash-krotki');
      clock = dumpOf(p).startedAt + 50;
      const h = harness();
      const dump = await runningKey(h);
      const { lines, cut } = linesOf(p);
      // Przed turą: inna tura człowieka, dość długa, żeby w jej miejscu zmieścić podrobioną turę tego klucza.
      const earlier = JSON.stringify({
        type: 'user', uuid: '00000000-0000-4000-9000-0000000000c1', timestamp: '2026-10-30T14:00:00.000Z',
        sessionId: SESSION, promptId: '00000000-0000-4000-9000-0000000000c2', isSidechain: false,
        origin: { kind: 'human' }, message: { role: 'user', content: 'x'.repeat(8_000) },
      });
      const file = join(h.dir, 'transkrypt.jsonl');
      writeFileSync(file, `${earlier}\n${lines.slice(0, cut).join('\n')}\n`);
      const review = createConsentEvidenceReview({ cycle: h.cycle, now, intervalMs: INTERVAL, locate: async () => file });
      await review.tick();
      const checkpoint = h.cycle.record(SESSION, dump.key)?.checkpoint;
      expect(checkpoint?.lineStart).toBe(Buffer.byteLength(earlier) + 1);
      appendFileSync(file, `${lines.slice(cut).join('\n')}\n`);

      // Po zapisie checkpointu bajty przed nim zastępuje (ten sam plik, ten sam rozmiar) podrobiona, zamknięta tura
      // z tym samym `promptId` i odmową tego samego wywołania: przegląd od początku pliku rozliczyłby obcą decyzję.
      const result = lines[cut] ?? '';
      const fakeResult = result.replace('"decision":"accept"', '"decision":"reject"');
      expect(fakeResult).not.toBe(result);
      const end = lines.find((l) => l.includes('"turn_duration"')) ?? '';
      const fake = `${[...lines.slice(0, cut), fakeResult, end].join('\n')}\n`;
      const padBase = JSON.stringify({ type: 'system', subtype: 'pad', p: '' });
      const room = Buffer.byteLength(earlier) - Buffer.byteLength(fake) - padBase.length;
      expect(room).toBeGreaterThan(0);
      const prefix = `${fake}${padBase.replace('"p":""', `"p":"${'y'.repeat(room)}"`)}\n`;
      expect(Buffer.byteLength(prefix)).toBe(Buffer.byteLength(earlier) + 1);
      const sizeBefore = statSync(file).size;
      const fd = openSync(file, 'r+');
      try {
        writeSync(fd, prefix, 0, 'utf8');
      } finally {
        closeSync(fd);
      }
      expect(statSync(file).size).toBe(sizeBefore);

      // Kontrola: ten sam rekord bez checkpointu (przegląd od początku pliku) kończy podrobioną turą z odmową.
      const control = harness({ bootId: NEXT_BOOT });
      await runningKey(control);
      await settle(control.cycle, file);
      expect(control.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'unknown', cause: 'foreign-decision' });

      // Restart: nowy proces, pusty rejestr i nowy przegląd; rekord z checkpointem z dysku.
      const after = harness({ dir: h.dir, bootId: NEXT_BOOT });
      await after.cycle.recover();
      expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'running', checkpoint });
      const known: Array<string | null> = [];
      const restarted = createConsentEvidenceReview({
        cycle: after.cycle, now, intervalMs: INTERVAL,
        locate: async (_sessionId, path) => { known.push(path); return file; },
      });
      await restarted.tick();
      expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: p.toolUseId });
      expect(known[0]).toBe(file);
    });

  it('brak pliku i błąd szukania: rekord bez zmian, tik nie rzuca, następny tik próbuje znowu', async () => {
    const p = przypadek('bash-krotki');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    await claimedKey(h, dump);
    const lines: string[] = [];
    let calls = 0;
    const review = createConsentEvidenceReview({
      cycle: h.cycle, now, intervalMs: INTERVAL, log: (line) => { lines.push(line); },
      locate: async () => {
        calls += 1;
        if (calls === 1) return null;
        throw new Error('dysk padł');
      },
    });
    await review.tick();
    await review.tick();
    expect(calls).toBeGreaterThan(2);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'claimed', checkpoint: null });
    expect(lines.some((line) => line.includes('dysk padł'))).toBe(true);
  });
});

describeTryby('karta zdjęta na końcu sesji (`retire`): pole rekordu, bez publikacji urządzeniom', () => {
  /** Rekord `claimed` zapisany jak przez poprzedni proces, z dodatkowymi polami surowego pliku. */
  function claimedRecord(dir: string, seed: string, extra: Record<string, unknown> = {}): HookCallDump {
    const dump = syntheticDump(seed, 'Bash', { command: 'npm test' });
    const at = clock - 3_000;
    const record = {
      v: 1, key: dump.key, sessionId: SESSION, promptId: dump.promptId, toolName: dump.toolName,
      inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump), agentId: null, pid: dump.pid,
      hookStartedAt: dump.startedAt, bootId: BOOT, state: 'claimed', decision: 'allow', reasonId: 'allow',
      decisionAt: at, correlation: 'open', toolUseId: null, cause: null, late: false, checkpoint: null,
      times: { pending: at - 1_000, deciding: at, sent: at, claimed: at + 500 }, ...extra,
    };
    mkdirSync(join(dir, CONSENT_RECORDS_DIRNAME, SESSION), { recursive: true });
    writeFileSync(join(dir, CONSENT_RECORDS_DIRNAME, SESSION, `${dump.key}.json`), `${JSON.stringify(record)}\n`);
    return dump;
  }

  it('odpowiedź odebrana (`claimed`): pole raz, stan bez zmian; koniec tury zmienia rekord, późny dowód bez potwierdzenia'
    + ' odbioru nie, pole zostaje, a urządzenia nie dostają żadnej zmiany', async () => {
    const p = przypadek('bash-krotki');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    await claimedKey(h, dump);
    const at = clock;
    const shown = h.events.length;
    expect(await h.cycle.retire(SESSION, p.klucz)).toBe(true);
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'claimed', retired: { at } });
    expect(readConsentRecords(h.dir).find((r) => r.key === p.klucz)).toMatchObject({ state: 'claimed', retired: { at } });
    clock += 1_000;
    // Drugie zdjęcie niczego nie zmienia: chwila zostaje pierwsza.
    expect(await h.cycle.retire(SESSION, p.klucz)).toBe(true);
    expect(h.cycle.record(SESSION, p.klucz)?.retired).toEqual({ at });

    await h.cycle.applyTurn(SESSION, dump.promptId, {
      promptId: dump.promptId, ended: false, partial: true, toolUses: [], results: [],
    }, true);
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', retired: { at } });
    await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'unknown', late: false, retired: { at } });
    expect(readConsentRecords(h.dir).find((r) => r.key === p.klucz)).toMatchObject({ state: 'unknown', retired: { at } });
    expect(h.events.slice(shown)).toEqual([]);
    // Magazyn kart idzie dalej za rekordem: manager czyta pole zdjęcia z rekordu.
    expect(h.cycle.card(SESSION, p.klucz)?.state).toBe(wireStateOf('unknown'));
  });

  it('rekord skończony i klucz bez rekordu: `retire` = `false`, bez pola', async () => {
    const h = harness();
    const dump = syntheticDump('zdjecie-skonczonej', 'Bash', { command: 'ls' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    await h.cycle.observe(SESSION, dump.key, 'gone', dump);
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('revoked');
    expect(await h.cycle.retire(SESSION, dump.key)).toBe(false);
    expect(h.cycle.record(SESSION, dump.key)?.retired).toBeUndefined();
    expect(await h.cycle.retire(SESSION, `${dump.promptId}-${'e'.repeat(32)}`)).toBe(false);
  });

  it('restart: rekord z polem odzyskany bez publikacji urządzeniom (karta w magazynie, pole na miejscu); rekord bez'
    + ' pola i z polem w złym kształcie odzyskany i opublikowany jak dotąd, bez wyjątku', async () => {
    const dir = dataDir();
    const retired = claimedRecord(dir, 'odzysk-zdjeta', { retired: { at: clock - 2_000 } });
    const plain = claimedRecord(dir, 'odzysk-bez-pola');
    const broken = [
      claimedRecord(dir, 'odzysk-zle-1', { retired: 'tak' }),
      claimedRecord(dir, 'odzysk-zle-2', { retired: { at: 'wczoraj' } }),
      claimedRecord(dir, 'odzysk-zle-3', { retired: null }),
      claimedRecord(dir, 'odzysk-zle-4', { retired: {} }),
    ];
    const h = harness({ dir, bootId: NEXT_BOOT });
    expect(await h.cycle.recover()).toEqual({ records: 6, changed: 0 });
    expect(h.cycle.record(SESSION, retired.key)).toMatchObject({ state: 'claimed', retired: { at: clock - 2_000 } });
    expect(h.cycle.card(SESSION, retired.key)).toMatchObject({ state: 'claimed' });
    for (const dump of [plain, ...broken]) {
      expect(h.cycle.record(SESSION, dump.key), dump.key).toMatchObject({ state: 'claimed' });
      expect(h.cycle.record(SESSION, dump.key)?.retired, dump.key).toBeUndefined();
    }
    expect(h.events.map((view) => view.permId).sort()).toEqual([plain, ...broken].map((dump) => dump.key).sort());
  });
});

describe('zwolnienie hooka, gdy karta kończy się bez odebranej odpowiedzi', () => {
  /** Moduł hooka `scripts/hooks/consent.mjs` (JS bez typów): to, czego hook używa przy odbiorze. */
  interface HookConsent {
    verifyConsentFile(raw: unknown, expected: ConsentExpectation): ConsentVerdict;
    waitForConsent(options: {
      base: string; expected: ConsentExpectation; pollMs: number;
      veto: () => Record<string, unknown> | null; onRejected: (reason: string, n: number) => void;
      sleep?: (ms: number) => Promise<void>;
    }): Promise<{ readonly outcome: 'claimed' | 'veto'; readonly file?: ConsentFile }>;
    consentOutput(
      file: ConsentFile, context: { hookEventName: string; toolName: string; toolInput: unknown },
    ): unknown;
  }
  const HOOK_CONSENT = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'consent.mjs');
  const hookConsent = async (): Promise<HookConsent> => (await import(pathToFileURL(HOOK_CONSENT).href)) as HookConsent;

  /** Nazwy plików katalogu odpowiedzi sesji, posortowane. */
  const answerFiles = (dir: string): string[] => {
    const at = join(dir, CONSENT_DIRNAME, SESSION);
    return existsSync(at) ? readdirSync(at).sort() : [];
  };

  /** To, co hook zna sam: sekret rejestracji, klucz, skróty ze stdin i `notBefore` z chwili rejestracji. */
  const expectationOf = (dump: HookCallDump, secret: string): ConsentExpectation => ({
    secret, sessionId: dump.sessionId, key: dump.key, inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump),
    notBefore: clock - 60_000,
  });

  /**
   * Hook czeka jak `rarog-pending.mjs` w trybie `main` (`waitForConsent`, potem `consentOutput`); bez pliku weto po
   * kilku okrążeniach. Plik odłożony jako nieważny przewraca test.
   */
  async function hookWaits(
    dir: string, dump: HookCallDump, secret: string,
  ): Promise<{ readonly outcome: string; readonly file?: ConsentFile; readonly output?: unknown }> {
    const consent = await hookConsent();
    const rejected: string[] = [];
    let rounds = 0;
    const result = await consent.waitForConsent({
      base: join(dir, CONSENT_DIRNAME, dump.sessionId, dump.key), expected: expectationOf(dump, secret), pollMs: 1,
      veto: () => (rounds++ > 3 ? { powod: 'koniec-testu' } : null),
      onRejected: (reason) => { rejected.push(reason); },
      sleep: () => Promise.resolve(),
    });
    expect(rejected).toEqual([]);
    if (result.file === undefined) return { outcome: result.outcome };
    return {
      outcome: result.outcome, file: result.file,
      output: consent.consentOutput(result.file, {
        hookEventName: 'PermissionRequest', toolName: dump.toolName, toolInput: dump.toolInput,
      }),
    };
  }

  /** Dysk, który odmawia zapisu plików odpowiedzi, dopóki `full()` mówi `true`. */
  const fullDisk = (full: () => boolean): Partial<ConsentCycleIo> => ({
    writeFile: (dir, name, body, options) => {
      if (full()) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      writeAtomic(dir, name, body, options);
    },
  });

  it('`pending` i `gone` przy sekrecie: podpisany `release` pod kluczem, hook go przejmuje i milczy; rekord i karta'
    + ' jak przy `dialog-gone`', async () => {
    const lines: string[] = [];
    const h = harness({ log: (line) => { lines.push(line); } });
    const dump = syntheticDump('zwolnienie-gone', 'Bash', { command: 'rm -r katalog' });
    const secret = register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    const before = h.events.length;
    expect(await h.cycle.observe(SESSION, dump.key, 'gone', dump)).toMatchObject({ state: 'revoked' });
    const record = h.cycle.record(SESSION, dump.key);
    expect(record).toMatchObject({
      state: 'revoked', cause: 'dialog-gone', decision: null, reasonId: null, decisionAt: null,
    });
    expect(Object.keys(record?.times ?? {}).sort()).toEqual(['pending', 'settled']);
    // Karta jak dotąd: jedna zmiana (`revoked`, bez przycisków), plik odpowiedzi nie daje zdarzenia.
    expect(h.events.slice(before).map((view) => [view.state, view.cause, view.canAllow, view.canDeny, view.canRelease]))
      .toEqual([['revoked', 'dialog-gone', false, false, false]]);
    expect(answerFiles(h.dir)).toEqual([`${dump.key}.json`]);
    const raw = JSON.parse(readFileSync(consentPath(h.dir, dump.key, '.json'), 'utf8')) as unknown;
    expect((await hookConsent()).verifyConsentFile(raw, expectationOf(dump, secret)))
      .toMatchObject({ ok: true, file: { decision: 'release', reasonId: 'release', key: dump.key, sessionId: SESSION } });
    const hook = await hookWaits(h.dir, dump, secret);
    expect(hook).toMatchObject({ outcome: 'claimed', file: { decision: 'release', reasonId: 'release' } });
    expect(hook.output).toBeNull();
    expect(answerFiles(h.dir)).toEqual([`${dump.key}.claimed`]);
    expect(lines.filter((line) => line.includes(dump.key))).toHaveLength(1);
    expect(lines.find((line) => line.includes(dump.key))).toContain('released');
  });

  it('to samo bez sekretu i przy zablokowanym kluczu: bez pliku, rekord `revoked` (`dialog-gone`) jak dotąd', async () => {
    const h = harness();
    const bare = syntheticDump('zwolnienie-bez-sekretu', 'Bash', { command: 'a' });
    await h.cycle.observe(SESSION, bare.key, 'standing', bare);
    await h.cycle.observe(SESSION, bare.key, 'gone', bare);
    expect(h.cycle.record(SESSION, bare.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone', decision: null });

    const blocked = syntheticDump('zwolnienie-zablokowany', 'Bash', { command: 'b' });
    register(h.reg, blocked);
    const second = h.reg.register({
      key: blocked.key, sessionId: blocked.sessionId, promptId: blocked.promptId,
      secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: blocked.inputSha256,
      cardSha256: cardShaOf(blocked), pid: blocked.pid, startedAt: blocked.startedAt,
    });
    expect(second.status).toBe(409);
    await h.cycle.observe(SESSION, blocked.key, 'standing', blocked);
    await h.cycle.observe(SESSION, blocked.key, 'gone', blocked);
    expect(h.cycle.record(SESSION, blocked.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    expect(answerFiles(h.dir)).toEqual([]);
  });

  it('hook przejął `release` (`.claimed`): przegląd plików i obserwacje bez linii logu, bez pliku i bez zmiany'
    + ' rekordu', async () => {
    const lines: string[] = [];
    const h = harness({ log: (line) => { lines.push(line); } });
    const dump = syntheticDump('zwolnienie-przejete', 'Bash', { command: 'c' });
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    await h.cycle.observe(SESSION, dump.key, 'gone', dump);
    expect(hookClaims(h.dir, dump.key)).toMatchObject({ decision: 'release' });
    const record = h.cycle.record(SESSION, dump.key);
    const logged = lines.length;
    const events = h.events.length;
    await h.cycle.tick();
    for (const signal of ['gone', 'unknown', 'standing'] as const) await h.cycle.observe(SESSION, dump.key, signal, dump);
    clock += CONSENT_CLAIM_TIMEOUT_MS;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)).toEqual(record);
    expect(lines.slice(logged)).toEqual([]);
    expect(h.events.length).toBe(events);
    expect(answerFiles(h.dir)).toEqual([`${dump.key}.claimed`]);
    // Hook wyszedł, `ps` mówi `dead`: wpis rejestru zapomniany, rekord bez zmian.
    await h.cycle.observe(SESSION, dump.key, 'dead');
    expect(h.cycle.record(SESSION, dump.key)).toEqual(record);
    expect(h.reg.entry(SESSION, dump.key)).toBeNull();
  });

  it('zapis `release` pada: linia logu raz, rekord bez wyjątku, następna obserwacja z żywym zrzutem pisze plik raz;'
    + ' martwy hook bez kolejnej próby', async () => {
    const lines: string[] = [];
    let full = true;
    const h = harness({ log: (line) => { lines.push(line); }, io: fullDisk(() => full) });
    const failures = (key: string): number => lines.filter((line) => line.includes(key) && line.includes('not written')).length;
    const dump = syntheticDump('zwolnienie-pelny-dysk', 'Bash', { command: 'd' });
    const secret = register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    expect(await h.cycle.observe(SESSION, dump.key, 'gone', dump)).toMatchObject({ state: 'revoked' });
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    expect(answerFiles(h.dir)).toEqual([]);
    expect(failures(dump.key)).toBe(1);
    // Dysk dalej pełny: druga próba bez drugiej linii logu.
    await h.cycle.observe(SESSION, dump.key, 'gone', dump);
    expect(failures(dump.key)).toBe(1);
    full = false;
    // Przegląd plików nie zwalnia: próbuje obserwacja, która widzi żywy zrzut hooka.
    await h.cycle.tick();
    expect(answerFiles(h.dir)).toEqual([]);
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    expect(answerFiles(h.dir)).toEqual([`${dump.key}.json`]);
    expect(await hookWaits(h.dir, dump, secret)).toMatchObject({
      outcome: 'claimed', file: { decision: 'release' }, output: null,
    });
    await h.cycle.observe(SESSION, dump.key, 'gone', dump);
    expect(answerFiles(h.dir)).toEqual([`${dump.key}.claimed`]);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });

    full = true;
    const dead = syntheticDump('zwolnienie-martwy', 'Bash', { command: 'e' });
    register(h.reg, dead);
    await h.cycle.observe(SESSION, dead.key, 'standing', dead);
    await h.cycle.observe(SESSION, dead.key, 'gone', dead);
    await h.cycle.observe(SESSION, dead.key, 'dead');
    full = false;
    await h.cycle.observe(SESSION, dead.key, 'gone', dead);
    expect(answerFiles(h.dir)).toEqual([`${dump.key}.claimed`]);
  });

  it('restart serwera między `revoked` a przejęciem: bez drugiego pliku i bez zmiany przyczyny', async () => {
    const dir = dataDir();
    const h = harness({ dir });
    const dump = syntheticDump('zwolnienie-restart', 'Bash', { command: 'f' });
    const secret = register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    await h.cycle.observe(SESSION, dump.key, 'gone', dump);
    const written = readFileSync(consentPath(dir, dump.key, '.json'), 'utf8');
    const before = h.cycle.record(SESSION, dump.key);
    expect(before).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    // Nowy proces z rejestracją tego klucza: najsurowszy wariant, bo taki serwer mógłby podpisać drugi plik.
    const reg = registry();
    const after = harness({ dir, bootId: NEXT_BOOT, reg });
    register(reg, dump);
    expect(await after.cycle.recover()).toEqual({ records: 1, changed: 0 });
    expect(after.cycle.record(SESSION, dump.key)).toEqual(before);
    for (const signal of ['gone', 'standing', 'unknown'] as const) await after.cycle.observe(SESSION, dump.key, signal, dump);
    await after.cycle.tick();
    expect(answerFiles(dir)).toEqual([`${dump.key}.json`]);
    expect(readFileSync(consentPath(dir, dump.key, '.json'), 'utf8')).toBe(written);
    expect(await hookWaits(dir, dump, secret)).toMatchObject({ outcome: 'claimed', output: null });
    await after.cycle.tick();
    await after.cycle.observe(SESSION, dump.key, 'gone', dump);
    expect(after.cycle.record(SESSION, dump.key)).toEqual(before);
    expect(answerFiles(dir)).toEqual([`${dump.key}.claimed`]);
  });

  it('koniec tury (`pending`, `sent` po odwołaniu), klawisz przy biurku przed sygnałem i nieudane zwolnienie'
    + ' z urządzenia: podpisany `release`, rekord jak dotąd', async () => {
    const turnEnd = (dump: HookCallDump): ConsentTurnFacts =>
      ({ promptId: dump.promptId, ended: true, partial: false, toolUses: [], results: [] });

    const a = harness();
    const pending = syntheticDump('tura-pending', 'Bash', { command: 'g' });
    const pendingSecret = register(a.reg, pending);
    await a.cycle.observe(SESSION, pending.key, 'standing', pending);
    await a.cycle.applyTurn(SESSION, pending.promptId, turnEnd(pending));
    expect(a.cycle.record(SESSION, pending.key)).toMatchObject({ state: 'revoked', cause: 'turn-ended', decision: null });
    expect(answerFiles(a.dir)).toEqual([`${pending.key}.json`]);
    expect(await hookWaits(a.dir, pending, pendingSecret)).toMatchObject({
      outcome: 'claimed', file: { decision: 'release' }, output: null,
    });

    const b = harness();
    const sent = syntheticDump('tura-sent', 'Bash', { command: 'h' });
    const sentSecret = register(b.reg, sent);
    await b.cycle.observe(SESSION, sent.key, 'standing', sent);
    await b.cycle.decide(SESSION, sent.key, 'allow');
    await b.cycle.applyTurn(SESSION, sent.promptId, turnEnd(sent));
    expect(b.cycle.record(SESSION, sent.key)).toMatchObject({ state: 'revoked', cause: 'turn-ended', decision: 'allow' });
    expect(answerFiles(b.dir)).toEqual([`${sent.key}.json`, `${sent.key}.revoked`]);
    expect(await hookWaits(b.dir, sent, sentSecret)).toMatchObject({
      outcome: 'claimed', file: { decision: 'release' }, output: null,
    });

    const p = przypadek('sigkill-biurko');
    const desk = dumpOf(p);
    clock = desk.startedAt + 50;
    const c = harness();
    const deskSecret = register(c.reg, desk);
    await c.cycle.observe(SESSION, p.klucz, 'standing', desk);
    await settle(c.cycle, transcriptOf(c.dir, p.transkrypt));
    expect(c.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'settled-at-desk', decision: null });
    expect(answerFiles(c.dir)).toEqual([`${p.klucz}.json`]);
    expect(await hookWaits(c.dir, desk, deskSecret)).toMatchObject({
      outcome: 'claimed', file: { decision: 'release' }, output: null,
    });

    let full = false;
    const d = harness({ io: fullDisk(() => full) });
    const failed = syntheticDump('zwolnienie-z-urzadzenia', 'Bash', { command: 'i' });
    const failedSecret = register(d.reg, failed);
    await d.cycle.observe(SESSION, failed.key, 'standing', failed);
    await d.cycle.decide(SESSION, failed.key, 'allow');
    full = true;
    expect(await d.cycle.release(SESSION, failed.key)).toEqual({ ok: false, error: 'write-failed', state: 'revoked' });
    expect(d.cycle.record(SESSION, failed.key)).toMatchObject({ state: 'revoked', cause: 'write-failed' });
    expect(answerFiles(d.dir)).toEqual([`${failed.key}.revoked`]);
    full = false;
    await d.cycle.observe(SESSION, failed.key, 'unknown', failed);
    expect(answerFiles(d.dir)).toEqual([`${failed.key}.json`, `${failed.key}.revoked`]);
    expect(await hookWaits(d.dir, failed, failedSecret)).toMatchObject({
      outcome: 'claimed', file: { decision: 'release' }, output: null,
    });
  });

  it('bez zwolnienia: martwy hook, termin przejęcia, podpis odrzucony, wymuszony koniec tury, wyłącznik, koniec'
    + ' sesji i restart', async () => {
    const h = harness();
    const card = async (seed: string, over: Partial<HookCallDump> = {}): Promise<HookCallDump> => {
      const dump = syntheticDump(seed, 'Bash', { command: seed }, over);
      register(h.reg, dump);
      await h.cycle.observe(SESSION, dump.key, 'standing', dump);
      return dump;
    };
    const dead = await card('bez-martwy');
    await h.cycle.observe(SESSION, dead.key, 'dead');
    const timeout = await card('bez-termin');
    await h.cycle.decide(SESSION, timeout.key, 'allow');
    const rejected = await card('bez-podpis');
    await h.cycle.decide(SESSION, rejected.key, 'allow');
    renameSync(consentPath(h.dir, rejected.key, '.json'), consentPath(h.dir, rejected.key, '.1.rejected'));
    const forced = await card('bez-wymuszony', { promptId: '00000000-0000-4000-9000-0000000000ab' });
    await h.cycle.applyTurn(SESSION, forced.promptId, {
      promptId: forced.promptId, ended: false, partial: false, toolUses: [], results: [],
    }, true);
    clock += CONSENT_CLAIM_TIMEOUT_MS;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dead.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    expect(h.cycle.record(SESSION, timeout.key)).toMatchObject({ state: 'revoked', cause: 'claim-timeout' });
    expect(h.cycle.record(SESSION, rejected.key)).toMatchObject({ state: 'revoked', cause: 'signature' });
    expect(h.cycle.record(SESSION, forced.key)?.state).toBe('pending');
    await h.cycle.off();
    expect(h.cycle.record(SESSION, forced.key)).toMatchObject({ state: 'revoked', cause: 'off' });
    const ended = await card('bez-koniec-sesji');
    expect(await h.cycle.revokeSession(SESSION, 'hook-dead')).toEqual([ended.key]);
    expect(answerFiles(h.dir)).toEqual([`${rejected.key}.1.rejected`, `${timeout.key}.revoked`].sort());

    const dir = dataDir();
    const before = harness({ dir });
    const restarted = syntheticDump('bez-restart', 'Bash', { command: 'r' });
    register(before.reg, restarted);
    await before.cycle.observe(SESSION, restarted.key, 'standing', restarted);
    const reg = registry();
    register(reg, restarted);
    const after = harness({ dir, bootId: NEXT_BOOT, reg });
    await after.cycle.recover();
    expect(after.cycle.record(SESSION, restarted.key)).toMatchObject({ state: 'revoked', cause: 'restart' });
    await after.cycle.observe(SESSION, restarted.key, 'gone', restarted);
    expect(answerFiles(dir)).toEqual([]);
  });
});

describe('karta końcowa nie trzyma treści w pamięci cyklu', () => {
  /** Klucze sesji z wpisem w mapach treści cyklu (zrzut, werdykt, odczyt ekranu, chwile odczytu i pojawienia się). */
  const content = (cycle: ConsentCycle): string[] => {
    const memory = cycle.diagnosticMemory(SESSION);
    return [...memory.dumps, ...memory.verdicts, ...memory.proofs, ...memory.seenAt, ...memory.createdAt];
  };
  const textOf = (views: readonly ConsentCardView[]): number =>
    views.reduce((sum, view) => sum + (view.presentation?.displayText.length ?? 0), 0);

  it('50 zrzutów `Write` po 60 tys. znaków, każdy do `revoked` sygnałem `dead`: urządzenia dostają stan końcowy'
    + ' z pełną kartą, potem karta bez prezentacji z tym samym powodem i chwilą; `endPool` zdejmuje karty końcowe,'
    + ' rekordy zostają, karta niekońcowa bez zmian', async () => {
    const h = harness();
    const body = 'x'.repeat(60_000);
    const write = (seed: string): HookCallDump =>
      syntheticDump(seed, 'Write', { file_path: `/tmp/projekt/${seed}.txt`, content: body });
    const dumps = Array.from({ length: 50 }, (_, i) => write(`pamiec-${String(i)}`));
    for (const dump of dumps) {
      await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
      await h.cycle.observe(SESSION, dump.key, 'dead', dump);
    }
    const waiting = write('pamiec-czeka');
    await h.cycle.observe(SESSION, waiting.key, 'unknown', waiting);

    // Publikacja stanu końcowego niesie pełny widok (urządzenia i serwer pomiaru wiążą kartę po treści).
    const finals = dumps.map((dump) => h.events.filter((v) => v.permId === dump.key && v.state === 'revoked'));
    expect(finals.map((events) => events.length)).toEqual(dumps.map(() => 1));
    expect(finals.flat().every((v) => (v.presentation?.displayText.length ?? 0) >= body.length)).toBe(true);
    expect(textOf(finals.flat())).toBeGreaterThanOrEqual(50 * body.length);

    // Po publikacji: karty końcowe bez prezentacji, z powodem i chwilą z publikacji; mapy treści bez ich kluczy.
    const light = finals.flat().map((v) => ({ ...v, presentation: null }));
    const cards = h.cycle.cards(SESSION);
    expect(cards.filter((v) => v.permId !== waiting.key)).toEqual(light);
    expect(textOf(cards.filter((v) => v.permId !== waiting.key))).toBe(0);
    expect(h.cycle.card(SESSION, waiting.key)?.presentation?.displayText.length).toBeGreaterThanOrEqual(body.length);
    expect(content(h.cycle).filter((key) => key !== waiting.key)).toEqual([]);
    expect(h.cycle.diagnosticMemory(SESSION).dumps).toEqual([waiting.key]);
    expect(h.cycle.diagnosticMemory(SESSION).verdicts).toEqual([waiting.key]);

    // Hook odwołanej karty czeka dalej, a jego zrzut leży: następna obserwacja nie wkłada treści z powrotem.
    const before = h.events.length;
    for (const dump of dumps.slice(0, 5)) await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    expect(h.events.length).toBe(before);
    expect(content(h.cycle).filter((key) => key !== waiting.key)).toEqual([]);

    // Koniec sesji: karty końcowe schodzą z magazynu, rekordy (metadane) zostają, karta `pending` bez zmian.
    const pendingCard = h.cycle.card(SESSION, waiting.key);
    h.cycle.endPool(SESSION);
    expect(h.cycle.cards(SESSION)).toEqual([pendingCard]);
    expect(h.cycle.diagnosticMemory(SESSION).cards).toEqual([waiting.key]);
    expect(h.cycle.diagnosticMemory(SESSION).records).toHaveLength(51);
    for (const dump of dumps) {
      expect(h.cycle.card(SESSION, dump.key)).toBeNull();
      expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
      expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'decided', state: 'revoked' });
    }
  });

  it('karta końcowa zmienia stan dalej (`revoked` → `settled-at-desk`): zdarzenie bez prezentacji, ten sam powód,'
    + ' mapy treści puste', async () => {
    const p = przypadek('sigkill-biurko');
    const dump = dumpOf(p);
    clock = dump.startedAt + 50;
    const h = harness();
    register(h.reg, dump);
    await h.cycle.observe(SESSION, p.klucz, 'standing', dump);
    await h.cycle.observe(SESSION, p.klucz, 'gone');
    const revoked = h.events.at(-1);
    expect(revoked).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    expect(revoked?.presentation).not.toBeNull();
    expect(content(h.cycle)).toEqual([]);
    await settle(h.cycle, transcriptOf(h.dir, p.transkrypt));
    expect(h.cycle.record(SESSION, p.klucz)).toMatchObject({ state: 'settled-at-desk', correlation: 'bound' });
    const settled = h.events.at(-1);
    expect(settled).toEqual({ ...revoked, presentation: null, state: 'settled-at-desk', cause: null, deskDecision: 'allow' });
    expect(h.cycle.card(SESSION, p.klucz)).toEqual(settled);
    expect(content(h.cycle)).toEqual([]);
    h.cycle.endPool(SESSION);
    expect(h.cycle.cards(SESSION)).toEqual([]);
  });

  it('`endPool` w trakcie `revokeSession` zdejmuje kartę już odwołaną: wynik dalej niesie każdy zmieniony klucz',
    async () => {
      const first = syntheticDump('wyscig-1', 'Bash', { command: 'echo 1' });
      const second = syntheticDump('wyscig-2', 'Bash', { command: 'echo 2' });
      let during: (() => void) | null = null;
      const h = harness({
        io: {
          writeRecord: (dir, record, options) => {
            writeConsentRecord(dir, record, options);
            if (record.key !== second.key || record.state !== 'revoked') return;
            const run = during;
            during = null;
            run?.();
          },
        },
      });
      await h.cycle.observe(SESSION, first.key, 'unknown', first);
      await h.cycle.observe(SESSION, second.key, 'unknown', second);
      during = () => { h.cycle.endPool(SESSION); };
      expect(await h.cycle.revokeSession(SESSION, 'hook-dead')).toEqual([second.key, first.key]);
      expect(h.cycle.card(SESSION, first.key)).toBeNull();
      expect(h.cycle.record(SESSION, first.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    });
});
