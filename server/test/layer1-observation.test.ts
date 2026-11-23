/**
 * Obserwacja kanału zgód jednej sesji (`layer1/observe.ts`) i odebrana odpowiedź przy stojącym dialogu: karta
 * `claimed`, której hook wyszedł albo zginął, przechodzi w `running` tylko wtedy, gdy dialog zniknął, a dialog stojący
 * 30 s po odbiorze daje `unknown` (`no-effect`).
 *
 * Zrzuty leżą na dysku w katalogu danych testu (`pending/<sesja>/`), `ps` to atrapa (pid → żyje), rejestr CLI
 * i zegar podaje test. Cykl jest prawdziwy, z tym samym zegarem. Wynik w transkrypcie: fixture `bash-krotki`
 * (CLI 2.1.314) jak w `layer1-cycle.test.ts`.
 *
 * Dowód „dialog stoi” (także dla karty `claimed` bez żywego hooka) wymaga jedynego dopasowania zrzutu
 * z puli sesji do wierzchu ekranu i puli bez blokady startu: harness startuje cykl dawno przed zegarem testów
 * i zdejmuje blokadę świeżym rejestrem bez `waiting`, a od karty z przyciskiem każda obserwacja czyta ekran z całą
 * ramką komendy tej prośby (dialog stoi dalej, póki CLI odpowiedzi nie wykonało).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sweepDeadRegistrations } from '../src/bootstrap/consent.ts';
import { createConsentEvidenceScanner } from '../src/herdr/consent-evidence.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME, HOOK_QUESTION_TOOL } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_CLAIMED_STANDING_MS, CONSENT_DIRNAME, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { TranscriptToolUses } from '../src/herdr/dialogs/layer1/proof.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { REGISTRY_MAX_AGE_MS, REGISTRY_SLACK_MS } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import { psFindings } from '../src/herdr/dialogs/shadow/liveness.ts';
import type { HookProcess, ProcessLiveness, PsFinding } from '../src/herdr/dialogs/shadow/liveness.ts';
import { turnToolUses } from '../src/herdr/jsonl-pending.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(REPO, 'server', 'test', 'fixtures', 'consent-dowod');
const BASH_FIXTURE = readFileSync(join(REPO, 'server', 'test', 'fixtures', 'herdr', 'measured', 'zgoda-bash-2.1.293.txt'), 'utf8');
const SESSION = '00000000-0000-4000-9000-000000000001';
const PROMPT = '00000000-0000-4000-9000-0000000000aa';
/** Takt obserwacji w serwerze: odczyt rejestru drivera co 1,5 s. */
const TICK_MS = 1_500;

let clock = Date.parse('2026-11-08T10:00:00.000Z');
const now = (): number => clock;
/** Start procesu serwera w harnessie: przed każdą chwilą testów tego pliku i fixture'u. */
const BOOT_AT = Date.parse('2026-10-01T00:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Rejestr CLI: dialog zgody, inny status, inna klasa dialogu albo „nie wiem”. */
const waiting = (at = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const active = (at = clock): RegistryEvidence => ({ kind: 'active', at });
const otherClass = (at = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'input', at });
const unknownRegistry: RegistryEvidence = { kind: 'unknown', why: 'unread' };

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  /** Życie procesów hooka dla atrapy `ps`; brak pidu = „nie wiem”. */
  readonly life: Map<number, boolean | null>;
  /** Ekran przeczytany w każdej obserwacji, z chwilą rozpoczęcia odczytu = teraz; `null` = bez odczytu. */
  screen: string | null;
  step(registry: RegistryEvidence, transcript?: TranscriptToolUses | null): Promise<void>;
}

/**
 * Cykl jak w serwerze. Proces wstał w {@link BOOT_AT}, a blokadę startu zdjął rejestr bez `waiting`
 * `REGISTRY_SLACK_MS` po starcie.
 */
async function harness(
  options: { readonly log?: (line: string) => void; readonly findings?: ReadonlyMap<number, PsFinding> } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-obserwacja-'));
  dirs.push(dir);
  const reg = createConsentRegistry({ bootId: 'boot-obs', send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope('main');
  const started = clock;
  clock = BOOT_AT;
  const cycle = createConsentCycle({
    dataDir: dir, bootId: 'boot-obs', registry: reg, now, ...(options.log === undefined ? {} : { log: options.log }),
  });
  clock = started;
  const life = new Map<number, boolean | null>();
  const findings = options.findings;
  const liveness: ProcessLiveness = async (processes) => {
    const out = new Map(processes.map((p) => [p.pid, life.get(p.pid) ?? null]));
    return findings === undefined ? out : Object.assign(out, { finding: (pid: number) => findings.get(pid) });
  };
  const unlockAt = BOOT_AT + REGISTRY_SLACK_MS;
  await observeConsentSession(cycle, {
    dataDir: dir, sessionId: SESSION, liveness, registry: active(unlockAt), transcript: null, screen: null, now: () => unlockAt,
  });
  const h: Harness = {
    dir, reg, cycle, life, screen: null,
    step: async (registry, transcript = null) => {
      const screen = h.screen === null ? null : { text: h.screen, readStartedAt: clock };
      await observeConsentSession(cycle, { dataDir: dir, sessionId: SESSION, liveness, registry, transcript, screen, now });
    },
  };
  return h;
}

/** Dialog `Bash` z pomiaru (CLI 2.1.293) z całą ramką komendy zrzutu: wierzch ekranu z tożsamością prośby. */
function bashTop(dump: HookCallDump): string {
  const lines = BASH_FIXTURE.split('\n');
  const top = lines.findIndex((line) => line.startsWith('╌'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╌'));
  const { command } = dump.toolInput as { command: string };
  return [...lines.slice(0, top + 1), ` ${command}`, ...lines.slice(bottom)].join('\n');
}

let nextPid = 40_000;

/** Zrzut syntetyczny wątku głównego (klucz z `seed`), z własnym pidem. */
function syntheticDump(seed: string, toolName: string, toolInput: unknown, over: Partial<HookCallDump> = {}): HookCallDump {
  const promptId = over.promptId ?? PROMPT;
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  nextPid += 1;
  return {
    key: `${promptId}-${nonce}`, sessionId: SESSION, promptId, pid: nextPid, startedAt: clock - 1_000, toolName,
    toolInput, cwd: '/tmp/projekt', at: clock - 900, inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
    ...over,
  };
}

const dumpPath = (dir: string, key: string): string => join(dir, HOOK_PENDING_DIRNAME, SESSION, `${key}.json`);
const answerPath = (dir: string, key: string, suffix: string): string => join(dir, CONSENT_DIRNAME, SESSION, `${key}${suffix}`);

/** Hook startuje: zrzut na dysku, proces żywy. */
function hookStarts(h: Harness, dump: HookCallDump): void {
  mkdirSync(dirname(dumpPath(h.dir, dump.key)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(h.dir, dump.key), JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, true);
}

/** Hook wypisał decyzję i wyszedł: zrzut znika, proces martwy. */
function hookExits(h: Harness, dump: HookCallDump): void {
  rmSync(dumpPath(h.dir, dump.key), { force: true });
  h.life.set(dump.pid, false);
}

function register(reg: ConsentRegistry, dump: HookCallDump): void {
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
  expect(reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
    inputSha256: dump.inputSha256, cardSha256, pid: dump.pid, startedAt: dump.startedAt,
  }).status).toBe(200);
}

const stateOf = (h: Harness, key: string): unknown => {
  const record = h.cycle.record(SESSION, key);
  return record === null ? null : { state: record.state, cause: record.cause };
};

/**
 * Karta z przyciskiem zgody (żywy hook, rejestr `waiting`, na wierzchu dialog tej prośby), zgoda z telefonu: rekord
 * `sent`. Ekran zostaje: dialog stoi, póki CLI odpowiedzi nie wykona.
 */
async function sentKey(h: Harness, dump: HookCallDump): Promise<void> {
  hookStarts(h, dump);
  register(h.reg, dump);
  h.screen = bashTop(dump);
  await h.step(waiting());
  expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
  expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
}

/** Hook przejmuje plik odpowiedzi, przegląd plików go widzi: rekord `claimed` w chwili `clock`. */
async function claimedKey(h: Harness, dump: HookCallDump): Promise<number> {
  await sentKey(h, dump);
  renameSync(answerPath(h.dir, dump.key, '.json'), answerPath(h.dir, dump.key, '.claimed'));
  await h.cycle.tick();
  expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
  return clock;
}

/** Takty co {@link TICK_MS} do `until` (włącznie) ze świeżym rejestrem z `registry`; stan po każdym takcie. */
async function ticksUntil(h: Harness, key: string, until: number, registry: () => RegistryEvidence): Promise<string[]> {
  const seen: string[] = [];
  while (clock + TICK_MS <= until) {
    clock += TICK_MS;
    await h.step(registry());
    seen.push(h.cycle.record(SESSION, key)?.state ?? 'brak');
  }
  return seen;
}

describe('karta `claimed` bez żywego hooka: dialog stoi według rejestru po odbiorze', () => {
  it('zrzut zniknął, rejestr `waiting`/`permission` 2 s po odbiorze i świeży w każdym takcie: po 29 s `claimed`,'
    + ' po 30 s `unknown` (`no-effect`), nigdy `running`', async () => {
    const h = await harness();
    // Narzędzie MCP na wierzchu nie niesie tożsamości prośby: karta bez przycisku, więc `Bash`.
    const dump = syntheticDump('mcp-cisza', 'Bash', { command: 'echo cisza' });
    const claimedAt = await claimedKey(h, dump);
    hookExits(h, dump);
    clock = claimedAt + REGISTRY_SLACK_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
    const seen = await ticksUntil(h, dump.key, claimedAt + CONSENT_CLAIMED_STANDING_MS - 1_000, () => waiting());
    expect(seen.length).toBeGreaterThan(10);
    expect(new Set(seen)).toEqual(new Set(['claimed']));
    clock = claimedAt + CONSENT_CLAIMED_STANDING_MS - 1_000;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
    clock = claimedAt + CONSENT_CLAIMED_STANDING_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'unknown', cause: 'no-effect' });
    expect(h.cycle.record(SESSION, dump.key)?.times.running).toBeUndefined();
    // Zrzut zniknął, więc wpis rejestru martwego hooka zapomniany jak dotąd.
    expect(h.reg.entry(SESSION, dump.key)).toBeNull();
  });

  it('proces hooka martwy, zrzut został (SIGKILL po `rename`): jak przy wyjściu hooka', async () => {
    const h = await harness();
    const dump = syntheticDump('sigkill', 'Bash', { command: 'sleep 1' });
    const claimedAt = await claimedKey(h, dump);
    h.life.set(dump.pid, false);
    expect(existsSync(dumpPath(h.dir, dump.key))).toBe(true);
    clock = claimedAt + REGISTRY_SLACK_MS;
    await h.step(waiting());
    const seen = await ticksUntil(h, dump.key, claimedAt + CONSENT_CLAIMED_STANDING_MS - 1_000, () => waiting());
    expect(new Set(seen)).toEqual(new Set(['claimed']));
    clock = claimedAt + CONSENT_CLAIMED_STANDING_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'unknown', cause: 'no-effect' });
  });

  it('SIGKILL przy `sent`: sygnał `dead` daje `claimed` (hook przejął plik), potem ta sama reguła', async () => {
    const h = await harness();
    const dump = syntheticDump('sigkill-sent', 'Bash', { command: 'sleep 2' });
    await sentKey(h, dump);
    renameSync(answerPath(h.dir, dump.key, '.json'), answerPath(h.dir, dump.key, '.claimed'));
    h.life.set(dump.pid, false);
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
    const claimedAt = clock;
    const seen = await ticksUntil(h, dump.key, claimedAt + CONSENT_CLAIMED_STANDING_MS - 1_000, () => waiting());
    expect(new Set(seen)).toEqual(new Set(['claimed']));
    clock = claimedAt + CONSENT_CLAIMED_STANDING_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'unknown', cause: 'no-effect' });
  });

  it.each([
    ['rejestr bez `waiting`', () => active()],
    ['rejestr `waiting` z inną klasą', () => otherClass()],
  ])('%s odczytany po odbiorze → `running` w tym takcie', async (name, registry) => {
    const h = await harness();
    const dump = syntheticDump(`znikl-${name}`, 'Bash', { command: 'ls' });
    const claimedAt = await claimedKey(h, dump);
    hookExits(h, dump);
    clock = claimedAt + 300;
    await h.step(registry());
    expect(stateOf(h, dump.key)).toEqual({ state: 'running', cause: null });
  });

  it('rejestr nieznany albo nieświeży → `claimed` bez zmian, także po 30 s', async () => {
    const h = await harness();
    const dump = syntheticDump('rejestr-nieznany', 'Bash', { command: 'pwd' });
    const claimedAt = await claimedKey(h, dump);
    hookExits(h, dump);
    clock = claimedAt + REGISTRY_SLACK_MS;
    await h.step(unknownRegistry);
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
    // Odczyt sprzed `REGISTRY_MAX_AGE_MS`: ani dowód, ani zaprzeczenie.
    const stale = clock;
    clock = stale + REGISTRY_MAX_AGE_MS + 1;
    await h.step(waiting(stale));
    await h.step(active(stale));
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
    clock = claimedAt + CONSENT_CLAIMED_STANDING_MS + 5_000;
    await h.step(unknownRegistry);
    await h.step(waiting(clock - REGISTRY_MAX_AGE_MS - 1));
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
  });

  it('`waiting` odczytany przed upływem `REGISTRY_SLACK_MS` od odbioru → bez zmian, potem 30 s od odbioru', async () => {
    const h = await harness();
    const dump = syntheticDump('w-zapasie', 'Bash', { command: 'id' });
    const claimedAt = await claimedKey(h, dump);
    hookExits(h, dump);
    clock = claimedAt + REGISTRY_SLACK_MS - 1;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
    // 30 s liczy się od odbioru, nie od pierwszego dowodu.
    clock = claimedAt + CONSENT_CLAIMED_STANDING_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'unknown', cause: 'no-effect' });
  });

  it('rejestr bez `waiting` odczytany przed odbiorem nie zabiera dialogu → `claimed` bez zmian', async () => {
    const h = await harness();
    const dump = syntheticDump('przed-odbiorem', 'Bash', { command: 'date' });
    const claimedAt = await claimedKey(h, dump);
    hookExits(h, dump);
    clock = claimedAt + 300;
    await h.step(active(claimedAt - 1));
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
  });

  it.each([
    ['następna prośba wątku głównego', 'Bash'],
    ['formularz pytania', HOOK_QUESTION_TOOL],
  ])('inny żywy zrzut w sesji (%s) przy rejestrze `waiting` → `running`', async (name, toolName) => {
    const h = await harness();
    const dump = syntheticDump(`inny-${name}`, 'Bash', { command: 'whoami' });
    const claimedAt = await claimedKey(h, dump);
    hookExits(h, dump);
    hookStarts(h, syntheticDump(`nastepny-${name}`, toolName, { command: 'uname' }));
    clock = claimedAt + REGISTRY_SLACK_MS + 500;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'running', cause: null });
  });

  it('żywy zrzut subagenta nie jest innym zrzutem wątku głównego → `claimed`, potem `unknown`', async () => {
    const h = await harness();
    const dump = syntheticDump('obok-subagenta', 'Bash', { command: 'hostname' });
    const claimedAt = await claimedKey(h, dump);
    hookExits(h, dump);
    hookStarts(h, syntheticDump('subagent', 'Bash', { command: 'true' }, { agentId: 'agent-1' }));
    clock = claimedAt + REGISTRY_SLACK_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
    clock = claimedAt + CONSENT_CLAIMED_STANDING_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'unknown', cause: 'no-effect' });
  });

  it('martwy proces bez faktów sesji (zamiatanie rejestru): `claimed` bez zmian, wpis rejestru zapomniany', async () => {
    const h = await harness();
    const dump = syntheticDump('zamiatanie', 'Bash', { command: 'echo z' });
    await claimedKey(h, dump);
    expect(h.reg.entry(SESSION, dump.key)).not.toBeNull();
    clock += REGISTRY_SLACK_MS;
    await h.cycle.observe(SESSION, dump.key, 'dead');
    expect(stateOf(h, dump.key)).toEqual({ state: 'claimed', cause: null });
    expect(h.reg.entry(SESSION, dump.key)).toBeNull();
  });
});

describe('zachowania bez zmian', () => {
  it('`claimed` przy żywym hooku: rejestr bez `waiting` po zrzucie (`gone`) → `running`', async () => {
    const h = await harness();
    const dump = syntheticDump('zywy-gone', 'Bash', { command: 'ls -l' });
    const claimedAt = await claimedKey(h, dump);
    clock = Math.max(claimedAt, dump.at + REGISTRY_SLACK_MS) + 100;
    await h.step(active());
    expect(stateOf(h, dump.key)).toEqual({ state: 'running', cause: null });
  });

  it('`claimed` przy żywym hooku: dowód „dialog stoi” przez 30 s → `unknown` (`no-effect`)', async () => {
    const h = await harness();
    const dump = syntheticDump('zywy-stoi', 'Bash', { command: 'ls -a' });
    const claimedAt = await claimedKey(h, dump);
    const seen = await ticksUntil(h, dump.key, claimedAt + CONSENT_CLAIMED_STANDING_MS - 1_000, () => waiting());
    expect(new Set(seen)).toEqual(new Set(['claimed']));
    clock = claimedAt + CONSENT_CLAIMED_STANDING_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'unknown', cause: 'no-effect' });
  });

  it('`pending` bez zrzutu: `revoked` (`hook-dead`), także przy rejestrze `waiting`', async () => {
    const h = await harness();
    const dump = syntheticDump('pending-bez-zrzutu', 'Bash', { command: 'echo p' });
    hookStarts(h, dump);
    register(h.reg, dump);
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'pending', cause: null });
    hookExits(h, dump);
    clock += REGISTRY_SLACK_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'hook-dead' });
  });

  it('`sent` bez zrzutu: plik odpowiedzi odwołany, `revoked` (`hook-dead`), bez nowego pliku', async () => {
    const h = await harness();
    const dump = syntheticDump('sent-bez-zrzutu', 'Bash', { command: 'echo s' });
    await sentKey(h, dump);
    hookExits(h, dump);
    clock += REGISTRY_SLACK_MS;
    await h.step(waiting());
    expect(stateOf(h, dump.key)).toEqual({ state: 'revoked', cause: 'hook-dead' });
    expect(existsSync(answerPath(h.dir, dump.key, '.json'))).toBe(false);
    expect(existsSync(answerPath(h.dir, dump.key, '.revoked'))).toBe(true);
  });

  it('formularz pytania nie dostaje karty', async () => {
    const h = await harness();
    const question = syntheticDump('pytanie', HOOK_QUESTION_TOOL, { questions: [] });
    hookStarts(h, question);
    await h.step(waiting());
    expect(h.cycle.cards(SESSION)).toEqual([]);
  });
});

describe('wynik w transkrypcie przy `claimed`, `running` i `unknown` rozlicza się jak dotąd', () => {
  interface Przypadek {
    readonly nazwa: string;
    readonly klucz: string;
    readonly toolUseId: string | null;
    readonly hook: string;
    readonly transkrypt: string;
    readonly czasy: { readonly pending: number; readonly timestampToolUse: number };
  }
  const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
  const p = (JSON.parse(fixture('przypadki.json')) as Przypadek[]).find((c) => c.nazwa === 'bash-krotki');

  /** Zrzut hooka przypadku `bash-krotki`: start procesu z czasów pomiaru, jak w teście cyklu. */
  function krotki(): HookCallDump {
    if (p === undefined) throw new Error('brak przypadku bash-krotki');
    const hook = JSON.parse(fixture(p.hook)) as {
      session_id: string; prompt_id: string; tool_name: string; tool_input: unknown; cwd: string; permission_mode?: string;
    };
    let toolUseAt = Number.NaN;
    for (const line of fixture(p.transkrypt).split('\n')) {
      if (line === '') continue;
      const entry = JSON.parse(line) as { timestamp?: string };
      if (turnToolUses(entry).some((use) => use.id === p.toolUseId)) toolUseAt = Date.parse(entry.timestamp ?? '');
    }
    const startedAt = toolUseAt - p.czasy.timestampToolUse - p.czasy.pending;
    nextPid += 1;
    return {
      key: p.klucz, sessionId: hook.session_id, promptId: hook.prompt_id, pid: nextPid, startedAt, toolName: hook.tool_name,
      toolInput: hook.tool_input, cwd: hook.cwd, at: startedAt + 1, inputSha256: canonicalSha256(hook.tool_input),
      ...(hook.permission_mode === undefined ? {} : { permissionMode: hook.permission_mode }),
    };
  }

  async function settle(h: Harness): Promise<void> {
    if (p === undefined) throw new Error('brak przypadku bash-krotki');
    const file = join(h.dir, 'transkrypt.jsonl');
    copyFileSync(join(FIXTURES, p.transkrypt), file);
    const scanner = createConsentEvidenceScanner();
    for (const target of h.cycle.evidenceTargets()) {
      const pass = await scanner.pass({ ...target, file });
      if (pass.status === 'ok') await h.cycle.applyTurn(target.sessionId, target.promptId, pass.facts);
    }
  }

  it.each([
    ['claimed', 'no-receipt'],
    ['running', 'no-receipt'],
    ['unknown', 'no-effect'],
  ] as const)('`%s` po wyjściu hooka, potem `hook/accept` bez potwierdzenia odbioru → `unknown` (`%s`)', async (state, cause) => {
    const dump = krotki();
    clock = dump.startedAt + 50;
    const h = await harness();
    const claimedAt = await claimedKey(h, dump);
    hookExits(h, dump);
    clock = claimedAt + REGISTRY_SLACK_MS;
    await h.step(state === 'running' ? active() : waiting());
    if (state === 'unknown') {
      clock = claimedAt + CONSENT_CLAIMED_STANDING_MS;
      await h.step(waiting());
    }
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe(state);
    await settle(h);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'unknown', cause, late: false, toolUseId: p?.toolUseId });
  });
});

describe('a registration forgotten as dead: the log line says why', () => {
  /** The `ps` finding for `proc` from a `ps` output, as `psLiveness` gives it. */
  function findingOf(output: string, proc: HookProcess): PsFinding {
    const finding = psFindings(output, [proc], clock).get(proc.pid);
    if (finding === undefined) throw new Error('no finding');
    return finding;
  }

  async function withLog(): Promise<{ h: Harness; lines: string[]; findings: Map<number, PsFinding> }> {
    const lines: string[] = [];
    const findings = new Map<number, PsFinding>();
    const h = await harness({ log: (line) => { lines.push(line); }, findings });
    return { h, lines, findings };
  }

  /** The forgotten line of `key`; fails when there is none or more than one. */
  function forgottenLine(lines: readonly string[], key: string): string {
    const hits = lines.filter((line) => line.includes(`registration of key ${key} forgotten (hook dead)`));
    expect(hits).toHaveLength(1);
    return hits[0] ?? '';
  }

  /** A pending card of a live hook with its registration. */
  async function pendingKey(h: Harness, dump: HookCallDump): Promise<void> {
    hookStarts(h, dump);
    register(h.reg, dump);
    h.screen = bashTop(dump);
    await h.step(waiting());
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('pending');
  }

  it('observation, dump on disk, `ps` has no such pid: pid, hook start and reason', async () => {
    const { h, lines, findings } = await withLog();
    const dump = syntheticDump('dead-no-pid', 'Bash', { command: 'echo a' });
    await pendingKey(h, dump);
    h.life.set(dump.pid, false);
    findings.set(dump.pid, findingOf('', dump));
    await h.step(waiting());
    const line = forgottenLine(lines, dump.key);
    expect(line).toContain(`pid ${String(dump.pid)}`);
    expect(line).toContain(new Date(dump.startedAt).toISOString());
    expect(line).toMatch(/no such pid/);
  });

  it('observation, card whose call dump is gone: the reason says so and that `ps` was not asked', async () => {
    const { h, lines } = await withLog();
    const dump = syntheticDump('dead-dump-gone', 'Bash', { command: 'echo b' });
    await pendingKey(h, dump);
    rmSync(dumpPath(h.dir, dump.key), { force: true });
    await h.step(waiting());
    const line = forgottenLine(lines, dump.key);
    expect(line).toContain(`pid ${String(dump.pid)}`);
    expect(line).toMatch(/call dump gone, no ps check/);
  });

  it('registry sweep, a newer process on the pid: `ps` start, difference and reason', async () => {
    const { h, lines } = await withLog();
    const dump = syntheticDump('dead-sweep-late', 'Bash', { command: 'echo c' }, { startedAt: clock - 6_000 });
    register(h.reg, dump);
    // The process on the pid started 1 s ago, 5 s after the hook's `startedAt`.
    const finding = findingOf(`   ${String(dump.pid)} 00:01\n`, dump);
    const liveness: ProcessLiveness = async (processes) => Object.assign(
      new Map(processes.map((p) => [p.pid, false])), { finding: (pid: number) => (pid === dump.pid ? finding : undefined) },
    );
    await sweepDeadRegistrations(h.cycle, h.reg, liveness);
    const line = forgottenLine(lines, dump.key);
    expect(line).toContain(`pid ${String(dump.pid)}`);
    expect(line).toContain(new Date(dump.startedAt).toISOString());
    expect(line).toContain(new Date(clock - 1_000).toISOString());
    expect(line).toContain('5000 ms after');
    expect(line).toMatch(/too late/);
  });

  it('session end: the reason says so and that `ps` was not asked', async () => {
    const { h, lines } = await withLog();
    const dump = syntheticDump('dead-session-end', 'Bash', { command: 'echo d' });
    await pendingKey(h, dump);
    await h.cycle.revokeSession(SESSION, 'hook-dead');
    const line = forgottenLine(lines, dump.key);
    expect(line).toContain(`pid ${String(dump.pid)}`);
    expect(line).toMatch(/session ended, no ps check/);
  });
});

describe('jedna definicja obserwacji', () => {
  it('`observeConsent` w `server/src/index.ts` woła `observeConsentSession`, bez własnej kopii pętli', () => {
    // `observeConsent` stoi w `bootstrap/consent.ts`, a `index.ts` składa start: oba pliki bez własnej kopii pętli.
    const source = ['server/src/index.ts', 'server/src/bootstrap/consent.ts']
      .map((file) => readFileSync(join(REPO, file), 'utf8')).join('\n');
    expect(source).toContain("import { observeConsentSession } from '../herdr/dialogs/layer1/observe.ts';");
    expect(source).toContain("consentStep('observe', log, () => observeConsentSession(cycle, {");
    expect(source).not.toContain('consentDialogSignals');
    expect(source).not.toContain('readCallDumps');
    expect(source).not.toContain("cycle.observe(sid, card.permId, 'dead')");
  });
});
