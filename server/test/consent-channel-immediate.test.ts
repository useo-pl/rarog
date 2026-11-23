/**
 * Karta kanału zgód bez czekania na takt rejestru CLI, strona managera.
 *
 * Pomiar właściciela (n = 10): od startu hooka do karty kanału `pending` mediana 614 ms, p90 1097 ms, maksimum 1501 ms,
 * bo obserwację kanału uruchamiał wyłącznie takt rejestru co 1,5 s. Przyjęta rejestracja hooka stała w logu przed
 * blokadą sesji we wszystkich dziesięciu przypadkach.
 *
 * Zdania, których pilnuje plik:
 *
 * - przyjęta rejestracja hooka i wejście panelu w blokadę (przy kanale zgód) dają świeży odczyt rejestru i sygnał dla
 *   driverów TEJ sesji silnika od razu, bez przesuwania zegara taktu; inne sesje go nie dostają, powtórka `blocked`
 *   i blokada bez kanału nie czytają rejestru poza taktem, odczyty się nie nakładają, a nieudany nie daje sygnału;
 * - linia pomiaru `dialog timing` w logu serwera: wejście w blokadę i pierwsza karta tego samego dialogu z rodzajem
 *   (`hook`, `jsonl`, `screen`, `question`, `dialog`) i odstępem w ms (minus = karta przed blokadą), bez treści dialogu.
 *
 * - rejestr kanału zgód woła `onAccepted` raz na nową przyjętą rejestrację, nie przy powtórce ani odmowie, a wyjątek
 *   odbiorcy nie zmienia jej wyniku.
 *
 * Driver (szturchnięcie tylko przy `waiting: permission`, karta zgody czekająca na kartę kanału) ma swoje testy
 * w `layer1-driver.test.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HerdrStatus } from '@rarog/shared';
import type { CliRegistry, CliVersionReadOptions, CliVersionSnapshot, CliWaitingSignal } from '../src/cli-version.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import { CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentRegistration } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { ConsentManagerChannel, HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const UUID_A = '8d5c7e65-abb8-4841-b17f-e98b1588b918';
const UUID_B = '6903789c-2cac-4a0f-92a8-2397f7827340';
const PROJECT = '/Users/u/Projects/atlas';
const KEY_A = 'w9:p72';
const KEY_B = 'w9:p73';
/** Takt rejestru jak w produkcji: test niczego nie przesuwa, więc każdy sygnał niżej przyszedł poza taktem. */
const POLL_MS = 1_500;
/** Sygnał rejestru z wpisu {@link waitingPermission}: stan i wydanie jedynego procesu sesji z jednego odczytu. */
const WAITING_PERMISSION: CliWaitingSignal = { kind: 'waiting', dialog: 'permission', version: '2.1.320' };
const SECRET_COMMAND = 'rm -rf /Users/u/tajne';

class NudgeDriver extends AtrapaDrivera {
  readonly signals: CliWaitingSignal[] = [];
  readonly nudges: CliWaitingSignal[] = [];

  noteCliWaiting(signal: CliWaitingSignal): void {
    this.signals.push(signal);
  }

  noteConsentNudge(signal: CliWaitingSignal): void {
    this.nudges.push(signal);
  }
}

class FakeSupervisor extends AtrapaNadzorcy<NudgeDriver> {
  override status(): HerdrStatus {
    return { available: true, agentCount: 0, readOnly: false, canLaunch: false };
  }

  protected nowyDriver(key: string): NudgeDriver {
    const driver = new NudgeDriver(key);
    driver.queue.push({ type: 'agent-state', state: 'working', seen: true });
    return driver;
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function makeDeps(): HerdrManagerDeps {
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

function makeAgent(key: string, engine: string): HerdrAgent {
  return {
    key, paneId: key, agentSessionId: engine, engine: 'claude', termId: null,
    cwd: PROJECT, status: 'working', title: 'atlas', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0,
    inScope: true, tabId: 'w9:t3', launchedByRarog: false, interactiveReady: true,
  };
}

/** Kanał zgód bez kart: manager wie, że kanał jest (`consent`), a żadna karta nie trzyma dialogu. */
function emptyConsent(): ConsentManagerChannel {
  return {
    cards: () => [],
    decide: () => Promise.reject(new Error('nieużywane')),
    release: () => Promise.reject(new Error('nieużywane')),
    revoke: () => Promise.resolve([]),
    retire: () => Promise.resolve(),
    turnEnded: () => Promise.resolve(),
    reattached: () => Promise.resolve(),
  };
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

const waitingPermission = (engine: string): CliRegistry => new Map([
  [engine, [{ pid: 4242, version: '2.1.320', status: 'waiting', waitingFor: 'permission' }]],
]);

describe('karta kanału zgód bez czekania na takt rejestru', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-kanal-od-razu-'));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  interface Built {
    manager: Manager;
    supervisor: FakeSupervisor;
    driver: NudgeDriver;
    id: string;
    /** Odczyty samego rejestru (szybki tik albo szturchnięcie). */
    reads: () => number;
    lines: string[];
  }

  async function build(opts: {
    registry: () => CliRegistry | null;
    consent?: boolean;
    agents?: readonly HerdrAgent[];
    /** Odczyt „w locie": czytnik czeka na tę obietnicę, zanim odda wynik. */
    gate?: () => Promise<void> | null;
    fail?: () => boolean;
    overrides?: Partial<ManagerConfig>;
  }): Promise<Built> {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const calls: (CliVersionReadOptions | undefined)[] = [];
    const lines: string[] = [];
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      herdrSupervisor: supervisor,
      herdrDeps: makeDeps(),
      herdrRoots: [PROJECT],
      herdrSend: true,
      cliWaiting: true,
      cliWaitingPollMs: POLL_MS,
      logger: (line) => { lines.push(line); },
      ...(opts.consent === true ? { consent: emptyConsent() } : {}),
      cliVersionReader: async (readOpts) => {
        calls.push(readOpts);
        const gate = opts.gate?.() ?? null;
        if (gate !== null) await gate;
        if (opts.fail?.() === true) throw new Error('rejestr');
        const snapshot: CliVersionSnapshot = { installed: null, registry: opts.registry() };
        return snapshot;
      },
      ...opts.overrides,
    });
    managers.push(manager);
    await manager.ready;
    const agents = opts.agents ?? [makeAgent(KEY_A, UUID_A)];
    for (const agent of agents) supervisor.appear(agent);
    await flush();
    const first = agents[0];
    if (first === undefined) throw new Error('brak agenta');
    const driver = supervisor.drivers.get(first.key);
    if (driver === undefined) throw new Error('brak drivera');
    const id = manager.list().find((s) => s.paneId === first.key)?.id ?? '';
    expect(id).not.toBe('');
    return {
      manager, supervisor, driver, id, lines,
      reads: () => calls.filter((call) => call?.registryOnly === true).length,
    };
  }

  const timing = (built: Built): string[] => built.lines.filter((line) => line.startsWith('dialog timing:'));

  it('przyjęta rejestracja: świeży odczyt rejestru i sygnał dla drivera tej sesji od razu, bez taktu', async () => {
    const built = await build({ registry: () => waitingPermission(UUID_A) });
    const before = built.reads();
    built.manager.noteConsentRegistration?.(UUID_A);
    await flush();
    expect(built.reads()).toBe(before + 1);
    expect(built.driver.nudges).toEqual([WAITING_PERMISSION]);
    // Szturchnięcie nie jest taktem: manager nie rozesłał zwykłego sygnału rejestru (`noteCliWaiting`).
    expect(built.driver.signals).toEqual([]);
  });

  it('szturchnięcie trafia tylko w driver tej sesji silnika', async () => {
    const built = await build({
      registry: () => new Map([...waitingPermission(UUID_A), ...waitingPermission(UUID_B)]),
      agents: [makeAgent(KEY_A, UUID_A), makeAgent(KEY_B, UUID_B)],
    });
    built.manager.noteConsentRegistration?.(UUID_B);
    await flush();
    expect(built.supervisor.drivers.get(KEY_B)?.nudges).toEqual([WAITING_PERMISSION]);
    expect(built.driver.nudges).toEqual([]);
  });

  it('wejście w blokadę przy kanale zgód: szturchnięcie bez taktu; powtórka `blocked` nie czyta drugi raz', async () => {
    const built = await build({ registry: () => waitingPermission(UUID_A), consent: true });
    const before = built.reads();
    built.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    expect(built.reads()).toBe(before + 1);
    expect(built.driver.nudges).toEqual([WAITING_PERMISSION]);
    built.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    expect(built.reads()).toBe(before + 1);
    expect(built.driver.nudges).toHaveLength(1);
  });

  it('blokada bez kanału zgód (`off`, `shadow`, demo) nie czyta rejestru poza taktem', async () => {
    const built = await build({ registry: () => waitingPermission(UUID_A) });
    const before = built.reads();
    built.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    expect(built.reads()).toBe(before);
    expect(built.driver.nudges).toEqual([]);
  });

  it('odczyt w toku: szturchnięcia z jego czasu łączą się w jeden następny odczyt', async () => {
    let gate: Promise<void> | null = null;
    let release: () => void = () => undefined;
    const built = await build({ registry: () => waitingPermission(UUID_A), gate: () => gate });
    const before = built.reads();
    gate = new Promise<void>((resolve) => { release = resolve; });
    built.manager.noteConsentRegistration?.(UUID_A);
    await flush();
    gate = null;
    built.manager.noteConsentRegistration?.(UUID_A);
    built.manager.noteConsentRegistration?.(UUID_A);
    await flush();
    expect(built.reads()).toBe(before + 1);
    release();
    await flush();
    expect(built.reads()).toBe(before + 2);
    expect(built.driver.nudges).toHaveLength(2);
  });

  it('nieudany odczyt rejestru (albo „nie wiem”): bez sygnału', async () => {
    let fail = false;
    let registry: CliRegistry | null = waitingPermission(UUID_A);
    const built = await build({ registry: () => registry, fail: () => fail });
    fail = true;
    built.manager.noteConsentRegistration?.(UUID_A);
    await flush();
    fail = false;
    registry = null;
    built.manager.noteConsentRegistration?.(UUID_A);
    await flush();
    expect(built.driver.nudges).toEqual([]);
  });

  it('pomiar: blokada, potem karta zgody z jsonl — dwie linie z odstępem w ms, bez treści komendy', async () => {
    const built = await build({ registry: () => null });
    built.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    built.driver.queue.push({
      type: 'permission-request', reqId: 'toolu_1', toolName: 'Bash', input: { command: SECRET_COMMAND },
      displayText: SECRET_COMMAND,
    });
    await flush();
    const lines = timing(built);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`dialog timing: session ${built.id} blocked`);
    expect(lines[1]).toMatch(new RegExp(`^dialog timing: session ${built.id} first card jsonl \\+\\d+ ms from blocked$`));
    expect(built.lines.some((line) => line.includes('tajne'))).toBe(false);
  });

  it('pomiar: karta kanału przed blokadą — linia karty, potem para z ujemnym odstępem; druga karta bez linii',
    async () => {
      const built = await build({ registry: () => null, consent: true });
      const view: ConsentCardView = {
        permId: 'p1-00', sessionId: UUID_A, promptId: 'p1', toolName: 'Bash', agentId: null, presentation: null,
        state: 'pending', canAllow: true, canDeny: true, canRelease: true, unavailable: null, cause: null, late: false,
        createdAt: Date.now(),
      };
      built.manager.applyConsentCard?.(view, null);
      await flush();
      built.driver.queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      built.driver.queue.push({ type: 'question-request', reqId: 'q1', questions: [] });
      await flush();
      const lines = timing(built);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(`dialog timing: session ${built.id} first card hook, not blocked yet`);
      expect(lines[1]).toMatch(new RegExp(`^dialog timing: session ${built.id} first card hook -\\d+ ms from blocked$`));
    });

  it('pomiar: rodzaj karty — pytanie, dialog spoza transkryptu, zgoda bez treści; nowa blokada = nowy epizod',
    async () => {
      const built = await build({ registry: () => null });
      const episode = async (card: DriverEvent): Promise<void> => {
        built.driver.queue.push({ type: 'agent-state', state: 'blocked' });
        await flush();
        built.driver.queue.push(card);
        await flush();
        built.driver.queue.push({ type: 'agent-state', state: 'working' });
        await flush();
      };
      await episode({ type: 'question-request', reqId: 'q1', questions: [] });
      await episode({ type: 'screen-dialog' });
      await episode({ type: 'permission-request', reqId: 'r1', toolName: 'dialog', input: null, displayText: '' });
      const kinds = timing(built).filter((line) => line.includes('first card'))
        .map((line) => /first card (\w+) /.exec(line)?.[1]);
      expect(kinds).toEqual(['question', 'dialog', 'screen']);
      expect(timing(built).filter((line) => line.endsWith(`session ${built.id} blocked`))).toHaveLength(3);
    });
});

describe('rejestr kanału zgód: `onAccepted`', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
  const registration = (seed: string, over: Partial<ConsentRegistration> = {}): ConsentRegistration => {
    const promptId = `p${sha(`prompt-${seed}`).slice(0, 12)}`;
    return {
      key: `${promptId}-${sha(`nonce-${seed}`).slice(0, 32)}`,
      sessionId: UUID_A,
      promptId,
      secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
      inputSha256: sha(`input-${seed}`),
      cardSha256: sha(`card-${seed}`),
      pid: process.pid,
      startedAt: Date.now() - 1_000,
      ...over,
    };
  };

  it('raz na nową przyjętą rejestrację; powtórka, odmowa i klucz zablokowany bez wywołania', () => {
    const accepted: string[] = [];
    const registry = createConsentRegistry({
      bootId: 'boot-1', send: () => true, sessions: () => [UUID_A], log: () => undefined,
      onAccepted: (sessionId) => { accepted.push(sessionId); },
    });
    registry.setScope('main');
    const first = registration('a');
    expect(registry.register(first).status).toBe(200);
    expect(registry.register({ ...first }).status).toBe(200);
    expect(registry.register(registration('b', { sessionId: UUID_B })).status).toBe(503);
    expect(registry.register({ ...first, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex') }).status)
      .toBe(409);
    expect(accepted).toEqual([UUID_A]);
  });

  it('wyjątek odbiorcy nie zmienia wyniku rejestracji', () => {
    const registry = createConsentRegistry({
      bootId: 'boot-1', send: () => true, sessions: () => [UUID_A], log: () => undefined,
      onAccepted: () => { throw new Error('odbiorca'); },
    });
    registry.setScope('main');
    const reg = registration('c');
    expect(registry.register(reg).status).toBe(200);
    expect(registry.secretOf(UUID_A, reg.key)).toBe(reg.secret);
  });
});
