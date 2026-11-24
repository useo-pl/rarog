/**
 * Dowód „dialog stoi” kanału zgód przy regule `channel`:
 * przycisk zgody z kanału bez wierzchu ekranu, termin dowodu z odczytu rejestru CLI (odczyt + 5 s), bramka wersji CLI
 * (`CONSENT_CHANNEL_MEASURED_CLI`) z wersją procesu z tego samego odczytu rejestru co `waiting`, kolejność werdyktów
 * według chwili odczytu rejestru, status bez `waiting: permission` zdejmujący dowód (`noteRegistryNotWaiting`),
 * narzędzia MCP przy regule `screen`, flaga `RAROG_CONSENT_PROOF`, dowód bez wpisu, reguła karty `claimed` bez
 * wierzchu i tabela przejść cyklu.
 *
 * Harness jak w `layer1-evidence-log.test.ts`: zrzuty na dysku, atrapa `ps`, rejestr CLI i zegar z testu,
 * prawdziwy cykl, rejestr sekretów i obserwacja z produkcyjnym `matchTop`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliWaitingOf, runningCliVersion } from '../src/cli-version.ts';
import type { CliRegistry } from '../src/cli-version.ts';
import { ConfigError, parseConsentProof } from '../src/config.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { CONSENT_CHANNEL_MEASURED_CLI, HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import {
  CONSENT_CYCLE_STATES, CONSENT_PROOF_RULES, CONSENT_SECRET_BYTES, CONSENT_TRANSITIONS,
} from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentCycleState } from '../src/herdr/dialogs/layer1/contract.ts';
import { assertConsentTransition, createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { createConsentProofGate, observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import { claimedDialogSignal, consentKeyRule } from '../src/herdr/dialogs/layer1/proof.ts';
import type { ConsentProofRule } from '../src/herdr/dialogs/layer1/proof.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import type { MatchTop } from '../src/herdr/dialogs/layer1/top.ts';
import { consentProofRuleOf } from '../src/herdr/dialogs/layer1/version-gate.ts';
import type { ConsentProofRules } from '../src/herdr/dialogs/layer1/version-gate.ts';
import {
  REGISTRY_MAX_AGE_MS, REGISTRY_SLACK_MS, registryEvidenceFromSignal,
} from '../src/herdr/dialogs/shadow/evidence.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';

const SESSION = '00000000-0000-4000-9000-0000000020a1';
const OTHER_SESSION = '00000000-0000-4000-9000-0000000020a2';
const PROMPT = '00000000-0000-4000-9000-0000000020b1';

let clock = Date.parse('2026-11-10T12:00:00.000Z');
const now = (): number => clock;
const BOOT_AT = Date.parse('2026-11-10T08:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const waiting = (at = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const active = (at = clock): RegistryEvidence => ({ kind: 'active', at });

/** Dialog `Bash` na wierzchu ekranu: inna prośba niż karty testu (wierzch nie wchodzi do reguły `channel`). */
const BASH_ON_TOP = [
  '─'.repeat(100),
  ' Bash command',
  '',
  '   rm -rf build',
  '   Clean the build directory',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
  '',
].join('\n');

interface Step {
  readonly registry?: RegistryEvidence;
  readonly rule?: ConsentProofRule | ConsentProofRules;
  readonly screen?: string | null;
  /** Dopasowanie wierzchu zamiast produkcyjnego `matchTop` (prośba bez tożsamości na wierzchu, np. MCP). */
  readonly matchTop?: MatchTop;
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly life: Map<number, boolean | null>;
  /** Linie logu cyklu. */
  readonly lines: string[];
  /** Widoki kart wysłane do urządzeń (`onCard`). */
  readonly published: ConsentCardView[];
  step(options?: Step): Promise<void>;
}

/** Cykl jak w serwerze; `unlock: false` = bez zdjęcia blokady startu (reguła `channel` jej nie potrzebuje). */
async function harness(options: { readonly unlock?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-dowod-kanalu-'));
  dirs.push(dir);
  const reg = createConsentRegistry({
    bootId: 'boot-kanal', send: () => true, sessions: () => [SESSION, OTHER_SESSION], log: () => {}, now,
  });
  reg.setScope('main');
  const lines: string[] = [];
  const published: ConsentCardView[] = [];
  const started = clock;
  clock = BOOT_AT;
  const cycle = createConsentCycle({
    dataDir: dir, bootId: 'boot-kanal', registry: reg, now, log: (line) => { lines.push(line); },
    onCard: (view) => { published.push(view); },
  });
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
  return {
    dir, reg, cycle, life, lines, published,
    step: async ({ registry = waiting(), rule = 'channel', screen = null, matchTop } = {}) => {
      await observeConsentSession(cycle, {
        dataDir: dir, sessionId: SESSION, liveness, registry, transcript: null, proofRule: rule,
        screen: screen === null ? null : { text: screen, readStartedAt: clock }, now,
        ...(matchTop === undefined ? {} : { matchTop }),
      });
    },
  };
}

let nextPid = 61_000;

function dumpOf(seed: string, toolName: string, toolInput: Record<string, unknown>): HookCallDump {
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  nextPid += 1;
  return {
    key: `${PROMPT}-${nonce}`, sessionId: SESSION, promptId: PROMPT, pid: nextPid, startedAt: clock - 1_000,
    toolName, toolInput, cwd: '/tmp/projekt', at: clock - 900, inputSha256: canonicalSha256(toolInput),
    permissionMode: 'default',
  };
}

const writeDump = (seed: string): HookCallDump =>
  dumpOf(seed, 'Write', { file_path: '/tmp/projekt/notatki.md', content: `# Notatki ${seed}\n` });

const editDump = (seed: string, oldString: string): HookCallDump =>
  dumpOf(seed, 'Edit', { file_path: '/tmp/projekt/app.ts', old_string: oldString, new_string: `${oldString} // ok` });

const dumpPath = (dir: string, key: string): string => join(dir, HOOK_PENDING_DIRNAME, SESSION, `${key}.json`);

/** Hook startuje i rejestruje się: zrzut na dysku, proces żywy. */
function hookStarts(h: Harness, dump: HookCallDump): void {
  mkdirSync(dirname(dumpPath(h.dir, dump.key)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(h.dir, dump.key), JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, true);
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

const card = (h: Harness, key: string): unknown => {
  const view = h.cycle.card(SESSION, key);
  return view === null ? null : { state: view.state, canAllow: view.canAllow, unavailable: view.unavailable };
};

const proofLines = (h: Harness, key: string): string[] =>
  h.lines.filter((line) => line.startsWith(`consent: proof of key ${key} `));

/** Rejestr procesów CLI z jednym procesem tej sesji w wersji `version`, który pokazuje dialog zgody. */
const oneProcess = (version: string): CliRegistry => new Map([[SESSION, [
  { pid: 70_010, version, status: 'waiting', waitingFor: 'permission' },
]]]);

/** Odczyt rejestru sesji tak, jak dostaje go obserwacja: sygnał managera (`cliWaitingOf`) z chwilą `at`. */
const readOf = (registry: CliRegistry, at = clock): RegistryEvidence =>
  registryEvidenceFromSignal(cliWaitingOf(registry, SESSION), at);

/** Reguły sesji z bramki wersji: oba rodzaje próśb tak samo. */
const SCREEN_RULES: ConsentProofRules = { main: 'screen', subagents: 'screen' };
const CHANNEL_RULES: ConsentProofRules = { main: 'channel', subagents: 'channel' };

/** Wersja CLI o jedno wydanie wyższa od zmierzonej. */
function newerThanMeasured(): string {
  const [major, minor, patch] = CONSENT_CHANNEL_MEASURED_CLI.cli.split('.').map(Number);
  return `${String(major)}.${String(minor)}.${String((patch ?? 0) + 1)}`;
}

describe('reguła `channel`: przycisk zgody z kanału, bez wierzchu ekranu', () => {
  it('`Write` z żywym hookiem i świeżym rejestrem `waiting: permission` → przycisk, bez odczytu ekranu i bez blokady'
    + ' startu; ta sama obserwacja przy regule `screen` → bez przycisku', async () => {
    const h = await harness({ unlock: false });
    const dump = writeDump('write');
    hookStarts(h, dump);
    await h.step({ rule: 'screen' });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    await h.step();
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    const [record] = readConsentRecords(h.dir).filter((r) => r.key === dump.key);
    expect(record).toMatchObject({ state: 'sent', decision: 'allow', proofKind: 'channel' });
  });

  it('inny dialog na wierzchu ekranu nie zabiera przycisku', async () => {
    const h = await harness();
    const dump = writeDump('inny-wierzch');
    hookStarts(h, dump);
    await h.step({ screen: BASH_ON_TOP });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
    await h.step({ screen: BASH_ON_TOP, rule: 'screen' });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
  });

  it('termin dowodu = odczyt rejestru + 5 s: po 2,5 s przycisk zostaje, po 5 s `tick` go zdejmuje, a `decide(allow)`'
    + ' → `card-changed`', async () => {
    const h = await harness();
    const dump = writeDump('termin');
    hookStarts(h, dump);
    const readAt = clock;
    await h.step({ registry: waiting(readAt) });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
    clock = readAt + 2_500;
    await h.cycle.tick();
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
    clock = readAt + REGISTRY_MAX_AGE_MS;
    const before = h.published.length;
    await h.cycle.tick();
    expect(h.published.slice(before).map((view) => [view.permId, view.canAllow, view.unavailable]))
      .toEqual([[dump.key, false, 'no-proof']]);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(proofLines(h, dump.key)).toEqual([`consent: proof of key ${dump.key} missing: registry=stale`]);
    // Następny świeży odczyt rejestru daje przycisk z powrotem.
    await h.step({ registry: waiting(clock) });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
  });

  it('dwa `Edit` jednego pliku, każdy z żywym hookiem → oba z przyciskiem (także dwa identyczne)', async () => {
    const h = await harness();
    const first = editDump('edit-1', 'const a = 1;');
    const second = editDump('edit-2', 'const b = 2;');
    const twin = editDump('edit-3', 'const b = 2;');
    for (const dump of [first, second, twin]) hookStarts(h, dump);
    await h.step({ screen: BASH_ON_TOP });
    for (const dump of [first, second, twin]) {
      expect(card(h, dump.key), dump.key).toEqual({ state: 'pending', canAllow: true, unavailable: null });
    }
  });

  it('bez świeżego `waiting: permission` → bez przycisku; linia logu bez członu wierzchu', async () => {
    const h = await harness();
    const dump = writeDump('bez-waiting');
    hookStarts(h, dump);
    await h.step({ registry: active(clock), screen: BASH_ON_TOP });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    expect(proofLines(h, dump.key)).toEqual([`consent: proof of key ${dump.key} missing: registry=not-waiting`]);
  });

  it('`ps` nie wie, czy hook żyje → bez przycisku (dowód własny dalej obowiązuje)', async () => {
    const h = await harness();
    const dump = writeDump('ps-nie-wie');
    hookStarts(h, dump);
    h.life.set(dump.pid, null);
    await h.step();
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
  });

  it('narzędzie MCP zostaje przy regule `screen` (dialog z interakcją nie zamyka się gołym `allow`)', async () => {
    const h = await harness();
    const dump = dumpOf('mcp', 'mcp__docs__guide', { items: ['topic.index'] });
    hookStarts(h, dump);
    await h.step({ screen: BASH_ON_TOP });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    expect(proofLines(h, dump.key)).toHaveLength(1);
    expect(proofLines(h, dump.key)[0]).toMatch(/ missing: top=/u);
  });

  it('narzędzie MCP przy regule `channel` z dialogiem na wierzchu ekranu → przycisk z dowodu z wierzchu, zgoda z'
    + ' `proofKind: top`', async () => {
    const h = await harness();
    const dump = dumpOf('mcp-wierzch', 'mcp__docs__guide', { items: ['topic.index'] });
    hookStarts(h, dump);
    const mcpOnTop: MatchTop = (_text, candidate) => (candidate.toolName === dump.toolName ? 'match' : 'no');
    await h.step({ screen: 'dialog MCP', matchTop: mcpOnTop });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ decision: 'allow', proofKind: 'top' });
  });

  it('reguła prośby: `channel` tylko dla wątku głównego spoza MCP; subagent, MCP i reguła sesji `screen` → `screen`',
    () => {
      expect(consentKeyRule('channel', { toolName: 'Write' })).toBe('channel');
      expect(consentKeyRule('channel', { toolName: 'Bash', agentId: null })).toBe('channel');
      expect(consentKeyRule('channel', { toolName: 'Bash', agentId: 'a0123456789abcdef' })).toBe('screen');
      expect(consentKeyRule('channel', { toolName: 'mcp__docs__guide' })).toBe('screen');
      expect(consentKeyRule('screen', { toolName: 'Write' })).toBe('screen');
    });
});

describe('bramka wersji CLI (`CONSENT_CHANNEL_MEASURED_CLI`)', () => {
  it('stała w rejestrze literałów CLI: wersja i data pomiaru', () => {
    expect(CONSENT_CHANNEL_MEASURED_CLI).toEqual({ cli: '2.1.330', excluded: ['2.1.327'] });
  });

  it('wersja wyższa od zmierzonej → `screen`; równa i niższa → `channel`; nieznana → `screen`; konfiguracja `screen`'
    + ' → `screen`', () => {
    const measured = CONSENT_CHANNEL_MEASURED_CLI.cli;
    expect(consentProofRuleOf('channel', newerThanMeasured(), null)).toBe('screen');
    expect(consentProofRuleOf('channel', measured, null)).toBe('channel');
    expect(consentProofRuleOf('channel', '2.1.300', null)).toBe('channel');
    expect(consentProofRuleOf('channel', undefined, null)).toBe('screen');
    expect(consentProofRuleOf('screen', measured, null)).toBe('screen');
  });

  it('linia logu przy każdej zmianie reguł sesji; bez linii przy wersji zmierzonej na starcie sesji, przy wersji'
    + ' nieznanej i przy konfiguracji `screen`', () => {
    const lines: string[] = [];
    const gate = createConsentProofGate({ configured: 'channel', log: (line) => { lines.push(line); } });
    const newer = newerThanMeasured();
    const measured = CONSENT_CHANNEL_MEASURED_CLI.cli;
    expect(gate.ruleFor(SESSION, readOf(oneProcess(newer)))).toEqual(SCREEN_RULES);
    expect(gate.ruleFor(SESSION, readOf(oneProcess(newer)))).toEqual(SCREEN_RULES);
    expect(gate.ruleFor(SESSION, readOf(oneProcess(measured)))).toEqual(CHANNEL_RULES);
    expect(gate.ruleFor(OTHER_SESSION, readOf(oneProcess(measured)))).toEqual(CHANNEL_RULES);
    expect(gate.ruleFor(OTHER_SESSION, waiting())).toEqual(SCREEN_RULES);
    expect(lines).toEqual([
      `consent: session ${SESSION} runs Claude Code ${newer}: proof rule main=screen, subagents=screen`
      + ` (measured ${measured}; no canary file)`,
      `consent: session ${SESSION} runs Claude Code ${measured}: proof rule main=channel, subagents=channel`
      + ` (measured ${measured}; no canary file)`,
    ]);
    const quiet: string[] = [];
    const screen = createConsentProofGate({ configured: 'screen', log: (line) => { quiet.push(line); } });
    expect(screen.ruleFor(SESSION, readOf(oneProcess(newer)))).toEqual(SCREEN_RULES);
    expect(screen.ruleFor(SESSION, readOf(oneProcess(measured)))).toEqual(SCREEN_RULES);
    expect(quiet).toEqual([]);
  });

  it('sesja z CLI wyższym: werdykt jak `screen` (`Write` bez wierzchu bez przycisku)', async () => {
    const h = await harness();
    const gate = createConsentProofGate({ configured: 'channel', log: () => {} });
    const dump = writeDump('nowsze-cli');
    hookStarts(h, dump);
    const newer = readOf(oneProcess(newerThanMeasured()));
    await h.step({ registry: newer, rule: gate.ruleFor(SESSION, newer), screen: BASH_ON_TOP });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    const measured = readOf(oneProcess(CONSENT_CHANNEL_MEASURED_CLI.cli));
    await h.step({ registry: measured, rule: gate.ruleFor(SESSION, measured), screen: BASH_ON_TOP });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
  });

  it('a late `waiting` observation from a release above the measured one, with a newer snapshot holding processes of'
    + ' the measured release and the one above → the `screen` rule from the release of that same read, an empty'
    + ' screen without the button; one process of the measured release → `channel`',
  async () => {
    const h = await harness();
    const gate = createConsentProofGate({ configured: 'channel', log: () => {} });
    const dump = writeDump('migawka');
    hookStarts(h, dump);
    const measuredCli = CONSENT_CHANNEL_MEASURED_CLI.cli;
    const older = oneProcess(newerThanMeasured());
    const newer: CliRegistry = new Map([[SESSION, [
      ...(older.get(SESSION) ?? []), { pid: 70_011, version: measuredCli, status: 'busy' },
    ]]]);
    // Pułapka: najniższa wersja z nowszej migawki to wersja zmierzona.
    expect(runningCliVersion(newer, SESSION)).toBe(measuredCli);
    const late = readOf(older);
    expect(gate.ruleFor(SESSION, late)).toEqual(SCREEN_RULES);
    expect(gate.ruleFor(SESSION, readOf(newer))).toEqual(SCREEN_RULES);
    await h.step({ registry: late, rule: gate.ruleFor(SESSION, late), screen: '' });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    const single = readOf(oneProcess(measuredCli));
    expect(gate.ruleFor(SESSION, single)).toEqual(CHANNEL_RULES);
    await h.step({ registry: single, rule: gate.ruleFor(SESSION, single), screen: '' });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
  });
});

describe('dowód z kanału a nowszy status rejestru', () => {
  it('starszy odczyt `waiting` z późniejszą chwilą obserwacji, bez ekranu, nie przywraca dowodu po nowszym `active`',
    async () => {
      const h = await harness();
      const dump = writeDump('starszy-waiting');
      hookStarts(h, dump);
      const waitingAt = clock;
      await h.step({ registry: waiting(waitingAt) });
      expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
      // `active` w zapasie od zrzutu (`REGISTRY_SLACK_MS`): niewiadoma, karta zostaje `pending` bez dowodu.
      clock = waitingAt + 500;
      await h.step({ registry: active(clock) });
      expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
      clock = waitingAt + 1_000;
      await h.step({ registry: waiting(waitingAt) });
      expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
      expect(await h.cycle.decide(SESSION, dump.key, 'allow'))
        .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    });

  it('status bez `waiting: permission` przyjęty przez driver zdejmuje przycisk od razu (widok do urządzeń, linia logu'
    + ' `registry=newer-not-waiting`); obserwacja ze starszym odczytem go nie przywraca, nowszy `waiting` tak', async () => {
    const h = await harness();
    const dump = writeDump('nowszy-status');
    hookStarts(h, dump);
    const waitingAt = clock;
    await h.step({ registry: waiting(waitingAt) });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
    clock = waitingAt + 300;
    const before = h.published.length;
    await h.cycle.noteRegistryNotWaiting(SESSION, clock);
    expect(h.published.slice(before).map((view) => [view.permId, view.canAllow, view.unavailable]))
      .toEqual([[dump.key, false, 'no-proof']]);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow'))
      .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
    expect(proofLines(h, dump.key)).toEqual([`consent: proof of key ${dump.key} missing: registry=newer-not-waiting`]);
    // Inna sesja bez zmian; status starszy niż przyjęty nic nie zmienia.
    await h.cycle.noteRegistryNotWaiting(OTHER_SESSION, clock);
    await h.cycle.noteRegistryNotWaiting(SESSION, waitingAt - 100);
    clock = waitingAt + 600;
    await h.step({ registry: waiting(waitingAt + 200) });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    await h.step({ registry: waiting(clock) });
    expect(card(h, dump.key)).toEqual({ state: 'pending', canAllow: true, unavailable: null });
  });
});

describe('flaga `RAROG_CONSENT_PROOF`', () => {
  it('domyślnie `channel`; `screen` i `channel` z odstępami; inna wartość zatrzymuje start', () => {
    expect(CONSENT_PROOF_RULES).toEqual(['channel', 'screen']);
    expect(parseConsentProof(undefined)).toBe('channel');
    expect(parseConsentProof('')).toBe('channel');
    expect(parseConsentProof(' screen ')).toBe('screen');
    expect(parseConsentProof('channel')).toBe('channel');
    expect(() => parseConsentProof('top')).toThrow(ConfigError);
    expect(() => parseConsentProof('top')).toThrow('RAROG_CONSENT_PROOF must be one of: channel, screen (got: top).');
  });
});

describe('dowód bez wpisu', () => {
  it('`standing` bez odczytu (`observe` bez `observed`) nie daje przycisku', async () => {
    const h = await harness();
    const dump = writeDump('bez-wpisu');
    hookStarts(h, dump);
    const view = await h.cycle.observe(SESSION, dump.key, 'standing', dump);
    expect(view).toMatchObject({ state: 'pending', canAllow: false, unavailable: 'no-proof' });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
  });
});

describe('karta `claimed` przy regule `channel`: bez wierzchu ekranu', () => {
  it('`waiting: permission` co najmniej 2 s po odbiorze, bez innego żywego zrzutu → dialog stoi bez wierzchu;'
    + ' reguła `screen` bez wierzchu → niewiadoma', () => {
    const claimedAt = clock;
    const registry = waiting(claimedAt + REGISTRY_SLACK_MS);
    const at = claimedAt + REGISTRY_SLACK_MS + 100;
    expect(claimedDialogSignal({ registry, otherLive: false, channel: true }, claimedAt, at)).toBe('standing');
    expect(claimedDialogSignal({ registry, otherLive: false, channel: true, top: false }, claimedAt, at)).toBe('standing');
    expect(claimedDialogSignal({ registry, otherLive: false }, claimedAt, at)).toBe('unknown');
    expect(claimedDialogSignal({ registry, otherLive: false, top: false }, claimedAt, at)).toBe('unknown');
    expect(claimedDialogSignal({ registry, otherLive: true, channel: true }, claimedAt, at)).toBe('gone');
    expect(claimedDialogSignal({ registry: waiting(claimedAt + 500), otherLive: false, channel: true }, claimedAt, at))
      .toBe('unknown');
  });
});

describe('tabela przejść cyklu', () => {
  it('przejście spoza tabeli → błąd; każde z tabeli przechodzi', () => {
    const states = CONSENT_CYCLE_STATES as readonly ConsentCycleState[];
    for (const from of states) {
      for (const to of states) {
        const allowed = (CONSENT_TRANSITIONS[from] as readonly ConsentCycleState[]).includes(to);
        if (allowed) expect(() => { assertConsentTransition(from, to); }, `${from} → ${to}`).not.toThrow();
        else expect(() => { assertConsentTransition(from, to); }, `${from} → ${to}`).toThrow(`${from} → ${to}`);
      }
    }
    expect(() => { assertConsentTransition('pending', 'applied'); }).toThrow();
    expect(() => { assertConsentTransition('applied', 'revoked'); }).toThrow();
  });

  it('stany końcowe nie mają wyjścia poza `revoked` (klawisz przy biurku albo wynik hooka po zdjęciu karty)', () => {
    expect(CONSENT_TRANSITIONS.applied).toEqual([]);
    expect(CONSENT_TRANSITIONS.released).toEqual([]);
    expect(CONSENT_TRANSITIONS['settled-at-desk']).toEqual([]);
    expect(CONSENT_TRANSITIONS.revoked).toEqual(['settled-at-desk', 'unknown', 'applied']);
  });
});
