/**
 * Driver herdr z prawdziwym cyklem przy regule `channel` (warstwa 1).
 *
 * Zdania, których pilnuje plik:
 *
 * - sygnał rejestru bez `waiting: permission` (`active` albo rejestr `unknown` przy dwóch procesach sesji) przyjęty
 *   w trakcie odczytu ekranu odrzuca spóźnioną obserwację: pusty ekran po nim nie daje przycisku zgody;
 * - taki sygnał w trakcie reszty obserwacji (odczyt `ps`) albo przy obserwacji, która wisi, zdejmuje dowód z kanału
 *   od razu (port `consentRegistryNotWaiting`); `allow` po nim jest odrzucone;
 * - tak samo każdy inny odczyt rejestru bez `waiting: permission`: własny odczyt obserwacji przy trybie `all`
 *   i prośbie subagenta (z chwilą sprzed zapytania, zanim obserwacja pójdzie dalej) i szturchnięcie kanału, które
 *   obserwacji nie startuje.
 *
 * Atrapa klienta herdr i pomocnicy są tu kopią minimalną z `layer1-driver.test.ts` (wzorzec testów
 * drivera: każdy plik ma własną atrapę).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliWaitingOf } from '../src/cli-version.ts';
import type { CliRegistry, CliWaitingSignal } from '../src/cli-version.ts';
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrPaneEvent, HerdrPaneHistory, HerdrScreen,
} from '../src/herdr/types.ts';
import type { PulseSample, SessionPulse } from '../src/herdr/session-pulse.ts';
import { createUploads } from '../src/herdr/uploads.ts';

const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const CONSENT_PROMPT = '00000000-0000-4000-9000-0000000000cc';
const PANE = 'w9:p72';
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const BASH_MEASURED = readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', 'measured', 'zgoda-bash-2.1.293.txt'),
  'utf8');
const TIMING = { batchMs: 4, statTickMs: 3, missingFastMs: 3, missingWindowMs: 60, missingSlowMs: 6 };
const BASH_INPUT = {
  command: 'pnpm exec vitest run server/test/state-machine.test.ts',
  description: 'Uruchamia testy maszyny stanów',
};
const WAITING_PERMISSION = { kind: 'waiting', dialog: 'permission' } as const;
/** Rejestr procesów CLI z dwoma żywymi procesami tej sesji (2.1.323 czeka, 2.1.322 pracuje). */
const TWO_WRITERS: CliRegistry = new Map([[SESSION, [
  { pid: 70_001, version: '2.1.323', status: 'waiting', waitingFor: 'permission' },
  { pid: 70_002, version: '2.1.322', status: 'busy' },
]]]);

/** Dialog `Bash` z pomiaru (CLI 2.1.293, ramka 61 kolumn) z komendą `command` w całej ramce. */
function bashFrame(command: string): string {
  const lines = BASH_MEASURED.split('\n');
  const top = lines.findIndex((line) => line.startsWith('╌'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╌'));
  return [...lines.slice(0, top + 1), ` ${command}`, ...lines.slice(bottom)].join('\n');
}

class FakeClient implements HerdrClient {
  screenText = '';
  sendFormSubmit = (): Promise<void> => Promise.resolve();
  sendModeCycle = (): Promise<void> => Promise.resolve();
  sendTrustStep = (): Promise<void> => Promise.resolve();
  sendDialogKey = (): Promise<void> => Promise.resolve();
  sendTakeBackKey = (): Promise<void> => Promise.resolve();
  pasteText = (): Promise<void> => Promise.resolve();
  sendPromptSubmit = (): Promise<void> => Promise.resolve();
  listAgents(): Promise<never> {
    return Promise.reject(new Error('driver nie woła agent.list'));
  }
  getAgent: () => Promise<HerdrAgentInfo> = () => Promise.reject(new Error('bez sondy przerwania'));
  readPaneHistory(): Promise<HerdrPaneHistory> {
    return Promise.resolve({ text: '', truncated: false });
  }
  readScreen(): Promise<HerdrScreen> {
    return Promise.resolve({ text: this.screenText });
  }
  prompt(): Promise<void> {
    return Promise.resolve();
  }
  sendKeys = (): Promise<void> => Promise.resolve();
  focus(): Promise<void> {
    return Promise.resolve();
  }
  ping(): Promise<{ version: string; protocol: number }> {
    return Promise.resolve({ version: '0.8.2', protocol: 20 });
  }
}

class FakePulse implements SessionPulse {
  start(): void {}
  stop(): void {}
  repoint(): void {}
  relocated(): void {}
  close(): void {}
  constructor(readonly onPulse: (sample: PulseSample) => void) {}
}

interface Fixture {
  driver: SessionDriver;
  client: FakeClient;
  events: DriverEvent[];
}

let base = '';
let root = '';
const disposers: (() => void)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-layer1-migawka-'));
  root = join(base, 'store');
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await rm(base, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

const userLine = (text: string): string => `${JSON.stringify({
  type: 'user', message: { role: 'user', content: text }, isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z', sessionId: SESSION,
})}\n`;

async function makeDriver(opts: {
  deps: Partial<HerdrDriverDeps>; transcript: string; screen: string;
}): Promise<Fixture> {
  const cwd = join(base, 'projekt');
  await mkdir(cwd, { recursive: true });
  const storeDir = join(root, projectSlug(cwd));
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, `${SESSION}.jsonl`), opts.transcript);
  const agent: HerdrAgent = {
    key: PANE, paneId: PANE, agentSessionId: SESSION, engine: 'claude', termId: null, cwd, status: 'idle',
    title: 'refaktor', stateChangeSeq: 7, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
  const listeners = new Set<(ev: HerdrPaneEvent) => void>();
  const handle: HerdrAgentHandle = {
    agent,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const client = new FakeClient();
  client.screenText = opts.screen;
  const deps: HerdrDriverDeps = {
    pulse: (o) => new FakePulse(o.onPulse),
    client,
    audit: { log: () => {} },
    uploads: createUploads(),
    yoloRoots: [],
    now: () => NOW,
    follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
    agentFiles: (o) => createAgentFileReader({ ...o, root }),
    pendingDebounceMs: 10,
    pendingRetryMs: 4,
    escSettleMs: 5,
    system: 'macos',
    ...opts.deps,
  };
  const driver = createHerdrDriver(handle, deps);
  disposers.push(() => { driver.dispose(); });
  const events: DriverEvent[] = [];
  void (async () => {
    for await (const event of driver.events) events.push(event);
  })();
  return { driver, client, events };
}

/** Zegar prawdziwego cyklu: domyślnie `NOW`, test go przesuwa. */
let consentClock = NOW;

/**
 * Prawdziwy rejestr sekretów i cykl, jak w serwerze, z zrzutem prośby `Bash` na dysku (hook czeka). Proces wstał
 * 10 s przed `NOW`, a blokadę startu zdjął rejestr bez `waiting` 5 s po starcie.
 */
async function unlockedCycleWithDump(): Promise<{
  dataDir: string; cycle: ConsentCycle; liveness: ProcessLiveness; dump: HookCallDump;
}> {
  const dataDir = join(base, 'dane');
  consentClock = NOW - 10_000;
  const now = (): number => consentClock;
  const registry = createConsentRegistry({ bootId: 'boot-drv', send: () => true, sessions: () => [SESSION], log: () => {}, now });
  registry.setScope('main');
  const cycle = createConsentCycle({ dataDir, bootId: 'boot-drv', registry, now });
  const liveness: ProcessLiveness = async (processes) => new Map(processes.map((p) => [p.pid, true]));
  consentClock = NOW - 5_000;
  await observeConsentSession(cycle, {
    dataDir, sessionId: SESSION, liveness, registry: { kind: 'active', at: consentClock }, transcript: null, screen: null,
    now,
  });
  consentClock = NOW;
  const startedAt = NOW - 1_000;
  const dump: HookCallDump = {
    key: `${CONSENT_PROMPT}-${randomBytes(16).toString('hex')}`, sessionId: SESSION, promptId: CONSENT_PROMPT, pid: 61_000,
    startedAt, toolName: 'Bash', toolInput: BASH_INPUT, cwd: '/tmp/projekt', at: startedAt + 100,
    inputSha256: canonicalSha256(BASH_INPUT), permissionMode: 'default',
  };
  await mkdir(join(dataDir, HOOK_PENDING_DIRNAME, SESSION), { recursive: true });
  await writeFile(join(dataDir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`), JSON.stringify(dump));
  expect(registry.register({
    key: dump.key, sessionId: SESSION, promptId: CONSENT_PROMPT, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
    inputSha256: dump.inputSha256, pid: dump.pid, startedAt: dump.startedAt,
    cardSha256: consentCardSha256({
      sessionId: SESSION, toolName: 'Bash', toolInput: BASH_INPUT, cwd: dump.cwd, agentId: null, permissionMode: 'default',
    }),
  }).status).toBe(200);
  return { dataDir, cycle, liveness, dump };
}

/**
 * Driver z prawdziwą obserwacją i cyklem przy regule `channel` i z portem statusu rejestru do cyklu, jak w serwerze.
 * `hang.value` = następne obserwacje wiszą (obserwacja w toku); `observed` = liczba skończonych obserwacji. `deps`
 * nadpisuje zależności drivera (tryb, prośba subagenta, odczyt rejestru obserwacji).
 */
async function channelDriver(options: {
  readonly liveness?: ProcessLiveness; readonly deps?: Partial<HerdrDriverDeps>;
} = {}): Promise<{
  fx: Fixture; cycle: ConsentCycle; dump: HookCallDump; observed: () => number; hang: { value: boolean };
}> {
  const unlocked = await unlockedCycleWithDump();
  const { dataDir, cycle, dump } = unlocked;
  const liveness = options.liveness ?? unlocked.liveness;
  let observed = 0;
  const hang = { value: false };
  const fx = await makeDriver({
    transcript: userLine('zbuduj'), screen: bashFrame(BASH_INPUT.command),
    deps: {
      now: () => consentClock,
      consentMode: () => 'main',
      consentObserve: async (request) => {
        if (hang.value) await new Promise<never>(() => {});
        await observeConsentSession(cycle, {
          dataDir, sessionId: request.engineSessionId, liveness, registry: request.registry,
          transcript: request.transcript, screen: request.screen, proofRule: 'channel', now: () => consentClock,
        });
        observed += 1;
      },
      consentRegistryNotWaiting: (engineSessionId, at) => {
        void cycle.noteRegistryNotWaiting(engineSessionId, at);
      },
      ...options.deps,
    },
  });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
  return { fx, cycle, dump, observed: () => observed, hang };
}

/** Odczyty ekranu, które test kończy sam (`answer` kończy wszystkie czekające). */
function heldScreen(fx: Fixture): { reads: () => number; answer: (text: string) => void } {
  const pending: ((text: string) => void)[] = [];
  let reads = 0;
  fx.client.readScreen = () => {
    reads += 1;
    return new Promise<HerdrScreen>((resolve) => { pending.push((text) => { resolve({ text }); }); });
  };
  return { reads: () => reads, answer: (text) => { for (const resolve of pending.splice(0)) resolve(text); } };
}

describe('reguła `channel`: dowód z kanału z jednej migawki rejestru', { timeout: 10_000 }, () => {
  it.each<[string, CliWaitingSignal]>([
    ['`active`', { kind: 'active' }],
    ['dwa procesy sesji (rejestr `unknown`)', cliWaitingOf(TWO_WRITERS, SESSION)],
  ])('w trakcie opóźnionego `readScreen` przychodzi %s, potem pusty ekran → bez przycisku zgody, `decide(allow)`'
    + ' odrzucone', async (_name, newer) => {
    const { fx, cycle, dump, observed } = await channelDriver();
    const held = heldScreen(fx);
    consentClock = NOW;
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    expect(held.reads()).toBeGreaterThan(0);
    consentClock = NOW + 1_500;
    fx.driver.noteCliWaiting?.(newer);
    consentClock = NOW + 2_000;
    held.answer('');
    await waitFor(() => observed() >= 1, 'obserwacja');
    await quiet();
    expect(cycle.card(SESSION, dump.key)?.canAllow ?? false).toBe(false);
    expect((await cycle.decide(SESSION, dump.key, 'allow')).ok).toBe(false);
  });

  it('`active` przychodzi w trakcie obserwacji, już po odczycie ekranu (odczyt `ps`) → dowód z kanału z tamtego'
    + ' `waiting` nie obowiązuje', async () => {
    let release: () => void = () => {};
    let hold = false;
    let asked = 0;
    const liveness: ProcessLiveness = async (processes) => {
      asked += 1;
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      return new Map(processes.map((p) => [p.pid, true]));
    };
    const { fx, cycle, dump, observed } = await channelDriver({ liveness });
    hold = true;
    consentClock = NOW;
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await waitFor(() => asked > 0, 'odczyt `ps`');
    hold = false;
    consentClock = NOW + 1_500;
    fx.driver.noteCliWaiting?.({ kind: 'active' });
    release();
    await waitFor(() => observed() >= 1, 'obserwacja');
    await quiet();
    expect(cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    expect(await cycle.decide(SESSION, dump.key, 'allow'))
      .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
  });

  it('przycisk z kanału, potem `active` przy obserwacji, która wisi → przycisk schodzi od razu', async () => {
    const { fx, cycle, dump, observed, hang } = await channelDriver();
    consentClock = NOW;
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await waitFor(() => observed() === 1, 'obserwacja');
    expect(cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
    hang.value = true;
    consentClock = NOW + 1_500;
    fx.driver.noteCliWaiting?.({ kind: 'active' });
    await quiet();
    expect(cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    expect(await cycle.decide(SESSION, dump.key, 'allow'))
      .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
  });

  it.each<[string, CliWaitingSignal]>([
    ['`active`', { kind: 'active' }],
    ['dwa procesy sesji (rejestr `unknown`)', cliWaitingOf(TWO_WRITERS, SESSION)],
  ])('tryb `all` z prośbą subagenta: odczyt rejestru obserwacji daje %s, obserwacja wisi → dowód z kanału'
    + ' z wcześniejszego `waiting` schodzi, `decide(allow)` odrzucone', async (_name, read) => {
    const subagent = { value: false };
    const reads: number[] = [];
    const { fx, cycle, dump, observed, hang } = await channelDriver({ deps: {
      consentMode: () => 'all',
      consentSubagentPending: () => subagent.value,
      consentRegistryRead: async () => {
        reads.push(consentClock);
        return read;
      },
    } });
    consentClock = NOW;
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await waitFor(() => observed() === 1, 'obserwacja z taktu');
    expect(cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
    subagent.value = true;
    hang.value = true;
    consentClock = NOW + 1_000;
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await waitFor(() => reads.length === 1, 'odczyt rejestru obserwacji');
    await quiet();
    expect(cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    expect(await cycle.decide(SESSION, dump.key, 'allow'))
      .toEqual({ ok: false, error: 'card-changed', state: 'pending' });
  });

  it.each<[string, CliWaitingSignal]>([
    ['`active`', { kind: 'active' }],
    ['dwa procesy sesji (rejestr `unknown`)', cliWaitingOf(TWO_WRITERS, SESSION)],
  ])('szturchnięcie z %s w trakcie odczytu ekranu obserwacji `waiting` → jej dowód z kanału nie obowiązuje bez'
    + ' taktu managera, następnej obserwacji nie ma', async (_name, nudge) => {
    const { fx, cycle, dump, observed } = await channelDriver();
    const held = heldScreen(fx);
    consentClock = NOW;
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    expect(held.reads()).toBeGreaterThan(0);
    consentClock = NOW + 1_500;
    fx.driver.noteConsentNudge?.(nudge);
    consentClock = NOW + 2_000;
    held.answer(bashFrame(BASH_INPUT.command));
    await waitFor(() => observed() >= 1, 'obserwacja');
    await quiet();
    expect(observed()).toBe(1);
    expect(cycle.card(SESSION, dump.key)?.canAllow ?? false).toBe(false);
    expect((await cycle.decide(SESSION, dump.key, 'allow')).ok).toBe(false);
  });
});
