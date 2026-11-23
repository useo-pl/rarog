/**
 * Aktualizacja Claude Code widoczna w sesji i restart sesji na nowym wydaniu.
 *
 * Ten plik pilnuje managera: kształtu `SessionSummary.cliUpdate` i przebiegu `restart()`.
 * Moduł odczytu dysku ma własny zestaw w `cli-version.test.ts`.
 *
 * Najważniejsza własność restartu: każda odmowa przychodzi PRZED `/exit`, a po `/exit` karta
 * nigdy nie zostaje bez drogi powrotu. Dlatego testy odmów liczą wywołania `requestExit`
 * i `launch` (mają być zerem), a testy porażek sprawdzają stan `resumable` i „Wznów".
 *
 * Atrapy nadzorcy i drivera dziedziczą po wspólnej `helpers/atrapa-sesji.ts` (zero gniazda, zero procesów)
 * i dopisują sondę restartu, `/exit` i start panelu. „Świat" (rejestr CLI, `claude agents`, `agent.list`)
 * jest jednym obiektem, który atrapa `/exit` zmienia tak, jak zmienia go prawdziwy proces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { foreign, say } from '@rarog/shared/sentences';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BackgroundTask, FileAttachment, HerdrMode, HerdrStatus, ServerEvent, SessionPromptBlocked, SessionSummary,
  TranscriptMessage,
} from '@rarog/shared';
import { createManager } from '../src/sessions/manager.ts';
import {
  CLI_VERSION_POLL_MS, HERDR_LOST_PROMPT_MESSAGE, RESTART_BUSY_MESSAGE, restartComposerMessage,
  RESTART_COMPOSER_UNKNOWN_MESSAGE, RESTART_DONE_NOTE, RESTART_EXIT_ASKED_DETAIL, RESTART_EXIT_TIMEOUT_DETAIL,
  RESTART_FAILED_DETAIL, RESTART_IN_PROGRESS_MESSAGE, RESTART_MODE_UNKNOWN_MESSAGE, RESTART_NO_UPDATE_MESSAGE,
  RESTART_PANEL_CHANGED_MESSAGE, RESTART_RESEND_STALE_MESSAGE, RESTART_TASKS_MESSAGE, RESTART_UNVERIFIED_MESSAGE,
  RESTART_WAITING_AGENT_MESSAGE, RESTART_WRITERS_MESSAGE, RESUME_FOREIGN_CWD_MESSAGE,
  RESUME_WITHOUT_ULTRACODE_MESSAGE, heldNotTakenText,
} from '../src/sessions/state-sentences.ts';
import { echoKey } from '../src/herdr/jsonl-follow.ts';
import { HerdrPromptRejectedError } from '../src/herdr/commands/index.ts';
import { HerdrGoneError } from '../src/herdr/types.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { serverSystem } from '../src/version.ts';
import type {
  BlockedLeftoverClear, DriverEvent, HeldLeftover, HeldLeftoverItem, RestartProbe, SendOptions,
} from '../src/drivers/types.ts';
import type { HerdrAgent, HerdrLaunchHandle, HerdrLaunchRequest } from '../src/herdr/types.ts';
import type { CliRegistryEntry, CliVersionSnapshot } from '../src/cli-version.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const PROJECT = '/Users/u/Projects/atlas';
const ENGINE_SESSION = '11111111-1111-4111-8111-111111111111';
const KEY = 'w9:p72';
const OLD_TAB = 'w9:t3';
/** System procesu testów: manager bez pola `system` bierze słowo maszyny z niego. */
const SYSTEM = serverSystem();

// ---------------------------------------------------------------------------
// Atrapy
// ---------------------------------------------------------------------------

/** Rejestr CLI, `claude agents --json` i zainstalowane wydanie — jedno miejsce prawdy. */
interface World {
  registry: Map<string, CliRegistryEntry[]> | null;
  installed: string | null;
  cliLive: Set<string> | null;
}

class FakeDriver extends AtrapaDrivera {
  probe: RestartProbe = {
    agent: { agentSessionId: ENGINE_SESSION, status: 'idle' }, composer: 'empty', mode: 'auto',
  };
  exits = 0;
  /** Co `requestExit` ZWRACA — niezależnie od tego, czy `/exit` zadziałał (`onExit`). */
  exitResult = true;
  onExit: (() => void) | null = null;
  /** Wołane przy każdej wysyłce — test sprawdza w niej, czy rezerwacja restartu jeszcze stoi. */
  onSend: ((text: string) => void) | null = null;
  /** Zgoda na wyczyszczenie pola z zablokowanym promptem — w prawdziwym driverze daje ją blokada. */
  blockedLeftover = false;
  /** Wynik następnego czyszczenia; `empty` czyści też pole w sondzie. */
  clearResult: BlockedLeftoverClear = 'empty';
  /** Rozmowy, dla których poszło czyszczenie — liczba to liczba zadań z klawiszami. */
  readonly clears: string[] = [];
  onClear: (() => void) | null = null;
  /** Odczyt pola po turze: obietnica trzymana przez test, który odpowiada na nią sam. */
  heldCheck: {
    readonly items: readonly HeldLeftoverItem[];
    readonly valid: () => boolean;
    readonly resolve: (verdicts: ReadonlyMap<string, HeldLeftover> | null) => void;
  } | null = null;

  override send(text: string, images?: readonly string[], files?: readonly FileAttachment[], opts?: SendOptions): void {
    super.send(text, images, files, opts);
    this.onSend?.(text);
  }

  /** Echo odroczone działa tylko z `queueEcho` w konfiguracji — domyślnie `build()` go nie włącza. */
  defersEcho(): boolean {
    return true;
  }

  checkHeldLeftover(
    items: readonly HeldLeftoverItem[], valid: () => boolean,
  ): Promise<ReadonlyMap<string, HeldLeftover> | null> {
    return new Promise((resolve) => { this.heldCheck = { items: [...items], valid, resolve }; });
  }

  clearBlockedLeftover(engineSessionId: string): Promise<BlockedLeftoverClear> {
    this.clears.push(engineSessionId);
    this.onClear?.();
    const result = this.clearResult;
    // Jak w prawdziwym driverze: zgoda gaśnie po każdej próbie z klawiszami (`busy`/`changed`/`stale` bez nich).
    if (result === 'empty' || result === 'filled' || result === 'unknown') this.blockedLeftover = false;
    if (result === 'empty') this.probe = { ...this.probe, composer: 'empty' };
    return Promise.resolve(result);
  }

  restartProbe(): Promise<RestartProbe> {
    return Promise.resolve(this.probe);
  }

  requestExit(): Promise<boolean> {
    this.exits += 1;
    this.onExit?.();
    return Promise.resolve(this.exitResult);
  }
}

class FakeSupervisor extends AtrapaNadzorcy<FakeDriver> {
  readonly live = new Map<string, HerdrAgent>();
  readonly engineLive = new Set<string>();
  readonly launches: HerdrLaunchRequest[] = [];
  readonly closedShellTabs: string[] = [];
  readonly restartLog: string[] = [];
  /** Wynik `ready` następnego startu: `null` = sukces. */
  launchError: Error | null = null;
  /** Gdy ustawione — `ready` następnego startu czeka na tę obietnicę (wyścig z `gone`). */
  launchReady: Promise<void> | null = null;
  /** Co launcher zobaczył na nowym panelu; `blocked` bez gotowości = start stanął na dialogu zaufania. */
  launchSeen: { status: 'idle' | 'blocked'; interactiveReady: boolean } = { status: 'idle', interactiveReady: true };
  paneCount = 0;
  canLaunch = true;
  launchOk = true;
  /** Gdy ustawione — odczyt stopki przy wysyłce czeka na tę obietnicę (mutacja „w locie"). */
  modeGate: Promise<void> | null = null;
  /** Wołane przy każdym podpięciu drivera — test ustawia w nim `onSend` nowego panelu. */
  onAttach: ((key: string, driver: FakeDriver) => void) | null = null;
  #launchNo = 0;

  constructor(private readonly world: World) {
    super();
  }

  override status(): HerdrStatus {
    return { available: true, agentCount: 0, readOnly: false, canLaunch: this.canLaunch };
  }

  protected nowyDriver(key: string): FakeDriver {
    return new FakeDriver(key, { dziennik: this.log });
  }

  override attach(key: string): FakeDriver {
    const driver = super.attach(key);
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    this.onAttach?.(key, driver);
    return driver;
  }

  override async ensureFreshMode(): Promise<HerdrMode> {
    if (this.modeGate !== null) await this.modeGate;
    return 'auto';
  }

  override rarogPaneCount(): number {
    return this.paneCount;
  }

  launchAvailable(): boolean {
    return this.launchOk;
  }

  agentFor(key: string): HerdrAgent | undefined {
    return this.live.get(key);
  }

  override async liveEngineSessions(): Promise<ReadonlySet<string>> {
    return new Set(this.engineLive);
  }

  override launch(req: HerdrLaunchRequest): Promise<HerdrLaunchHandle> {
    this.launches.push(req);
    this.#launchNo += 1;
    const key = `w9:pN${String(this.#launchNo)}`;
    const agentSessionId = req.resumeFrom ?? 'nowa';
    const error = this.launchError;
    if (error === null) {
      // Nowy proces melduje się w rejestrze na zainstalowanym wydaniu.
      this.world.registry?.set(agentSessionId, [
        { pid: 9000 + this.#launchNo, version: this.world.installed ?? '0.0.0', status: 'idle' },
      ]);
    }
    const gate = this.launchReady ?? Promise.resolve();
    const seen = this.launchSeen;
    return Promise.resolve({
      key, paneId: key, tabId: `w9:tN${String(this.#launchNo)}`, agentSessionId,
      ready: gate.then(() => {
        if (error !== null) throw error;
        return {
          key, paneId: key, tabId: 'w9:tN', agentSessionId, createdWorkspace: false, argv: [], ...seen,
        };
      }),
    });
  }

  async closeShellTab(tabId: string): Promise<boolean> {
    this.closedShellTabs.push(tabId);
    return true;
  }

  logRestart(key: string, reason: string, versions?: string): void {
    this.restartLog.push(versions === undefined ? `${key} ${reason}` : `${key} ${reason} ${versions}`);
  }

  appear(agent: HerdrAgent): void {
    this.live.set(agent.key, agent);
    this.engineLive.add(agent.agentSessionId);
    this.lifecycle.push({ type: 'appeared', agent });
  }

  gone(key: string): void {
    const agent = this.live.get(key);
    this.live.delete(key);
    if (agent !== undefined) this.engineLive.delete(agent.agentSessionId);
    this.lifecycle.push({ type: 'gone', key });
  }
}

function makeDeps(): HerdrManagerDeps {
  const aliases = new Map<string, string>();
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: (engine) => aliases.get(engine),
    rememberAlias: (engine, id) => { aliases.set(engine, id); },
    // Magazyn CLI w atrapie: rozmowa ma plik i ten plik należy do katalogu karty.
    resumeSource: {
      locate: (_root, _cwd, uuid) => Promise.resolve(uuid === ENGINE_SESSION ? '/store/a.jsonl' : null),
      cwdOf: () => Promise.resolve(PROJECT),
    },
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

/** Atrapa magazynu, w której ostatnia linia pliku rozmowy niesie podany `cwd`. */
function depsWithTail(tail: string): HerdrManagerDeps {
  const deps = makeDeps();
  const source = deps.resumeSource;
  if (source === undefined) throw new Error('atrapa bez resumeSource');
  return { ...deps, resumeSource: { ...source, cwdOf: () => Promise.resolve(tail) } };
}

function makeAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    key: KEY,
    paneId: KEY,
    agentSessionId: ENGINE_SESSION,
    engine: 'claude',
    termId: null,
    cwd: PROJECT,
    status: 'idle',
    title: 's3-back',
    stateChangeSeq: 1,
    mode: 'auto',
    modeReadAt: 0,
    inScope: true,
    tabId: OLD_TAB,
    launchedByRarog: false,
    interactiveReady: true,
    ...overrides,
  };
}

/** Oddaje sterowanie pętli zdarzeń, żeby pompy managera przetrawiły kolejki. */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

/** Czeka, aż warunek stanie się prawdą — restart biegnie w tle na prawdziwych zegarach. */
async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('warunek nie spełniony w czasie');
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

/** Świat z jednym procesem tej rozmowy na `running`, zainstalowane `installed`. */
function makeWorld(running = '2.1.280', installed = '2.1.283'): World {
  return {
    registry: new Map([[ENGINE_SESSION, [{ pid: 4242, version: running, status: 'idle' }]]]),
    installed,
    cliLive: new Set([ENGINE_SESSION]),
  };
}

function snapshotOf(world: World): CliVersionSnapshot {
  return { installed: world.installed, registry: world.registry };
}

// ---------------------------------------------------------------------------

describe('manager: cliUpdate i restart sesji', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-restart-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  interface Built {
    manager: Manager; supervisor: FakeSupervisor; driver: FakeDriver; id: string; world: World;
  }

  async function build(opts: {
    world?: World;
    agent?: HerdrAgent;
    read?: () => CliVersionSnapshot | undefined;
    overrides?: Partial<ManagerConfig>;
  } = {}): Promise<Built> {
    const world = opts.world ?? makeWorld();
    const supervisor = new FakeSupervisor(world);
    supervisors.push(supervisor);
    const read = opts.read ?? ((): CliVersionSnapshot => snapshotOf(world));
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      maxPanes: 6,
      herdrSupervisor: supervisor,
      herdrDeps: makeDeps(),
      herdrRoots: [PROJECT],
      herdrSend: true,
      transcriptRoot: '/store',
      cliVersionReader: () => {
        const value = read();
        return value === undefined ? Promise.reject(new Error('EIO')) : Promise.resolve(value);
      },
      liveSessionsReader: () => Promise.resolve(world.cliLive === null ? null : new Set(world.cliLive)),
      restartTiming: { exitTimeoutMs: 300, pollMs: 5 },
      // Throttle startów poluzowany: scenariusz „porażka → Wznów" to dwa starty w jednym teście.
      // Test zwrotu slotu przywraca odstęp, żeby 429 było możliwe.
      launchThrottle: { minIntervalMs: 0 },
      ...opts.overrides,
    });
    managers.push(manager);
    await manager.ready;
    supervisor.appear(opts.agent ?? makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    const driver = supervisor.driver((opts.agent ?? makeAgent()).key);
    // `/exit` w atrapie robi to, co robi prawdziwy proces: znika z rejestru, z `claude agents`
    // i z herdr (push `gone` z nadzorcy).
    driver.onExit = (): void => {
      world.registry?.delete(ENGINE_SESSION);
      world.cliLive?.delete(ENGINE_SESSION);
      supervisor.gone(KEY);
    };
    return { manager, supervisor, driver, id, world };
  }

  function record(manager: Manager): { scope: string; event: ServerEvent }[] {
    const out: { scope: string; event: ServerEvent }[] = [];
    manager.onEvent((scope, _seq, event) => { out.push({ scope, event }); });
    return out;
  }

  function globalChanges(events: { scope: string; event: ServerEvent }[]): SessionSummary[] {
    return events.flatMap(({ scope, event }) => (
      scope === 'global' && event.type === 'session-changed' ? [event.session] : []
    ));
  }

  // -------------------------------------------------------------------------
  // cliUpdate
  // -------------------------------------------------------------------------

  describe('cliUpdate', () => {
    beforeEach(() => {
      // Tylko interwał jest udawany: `setImmediate` z `flush()` musi dalej działać naprawdę.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    async function tick(): Promise<void> {
      vi.advanceTimersByTime(CLI_VERSION_POLL_MS);
      await flush();
    }

    it('proces na starszym wydaniu niż zainstalowane → para wydań na karcie', async () => {
      const { manager, id } = await build();
      expect(manager.get(id)?.cliUpdate).toEqual({ running: '2.1.280', installed: '2.1.283' });
    });

    it('wydanie aktualne, brak procesu w rejestrze, brak dowiązania → brak pola (cisza)', async () => {
      for (const world of [
        makeWorld('2.1.283', '2.1.283'),
        { ...makeWorld(), registry: null },
        { ...makeWorld(), installed: null },
        { ...makeWorld(), registry: new Map() },
      ]) {
        const { manager, id } = await build({ world });
        expect('cliUpdate' in (manager.get(id) ?? {})).toBe(false);
        await manager.dispose();
      }
    });

    it('bez wstrzykniętego czytnika pola nie ma nigdy — test nie czyta rejestru Maca', async () => {
      const { manager, id } = await build({ overrides: { cliVersionReader: undefined } });
      expect('cliUpdate' in (manager.get(id) ?? {})).toBe(false);
    });

    it('Codex i panel poza zasięgiem nie dostają pigułki — Rarog nie ma nad nimi władzy', async () => {
      const codex = await build({ agent: makeAgent({ engine: 'codex' }) });
      expect('cliUpdate' in (codex.manager.get(codex.id) ?? {})).toBe(false);
      await codex.manager.dispose();
      const foreign = await build({ agent: makeAgent({ inScope: false }) });
      expect('cliUpdate' in (foreign.manager.get(foreign.id) ?? {})).toBe(false);
    });

    it('tick emituje ramkę TYLKO przy zmianie wyniku', async () => {
      const world = makeWorld();
      const { manager, id } = await build({ world });
      await tick();
      const events = record(manager);

      await tick();
      expect(globalChanges(events)).toEqual([]);

      // Instalator dociągnął nowsze wydanie w tle — karta ma to zobaczyć bez restartu Raroga.
      world.installed = '2.1.284';
      await tick();
      expect(globalChanges(events).map((s) => s.cliUpdate))
        .toEqual([{ running: '2.1.280', installed: '2.1.284' }]);
      expect(manager.get(id)?.cliUpdate?.installed).toBe('2.1.284');
    });

    it('błąd czytnika gasi pigułkę zamiast zostawić odczyt sprzed awarii', async () => {
      let fail = false;
      const world = makeWorld();
      const { manager, id } = await build({ world, read: () => (fail ? undefined : snapshotOf(world)) });
      await tick();
      const events = record(manager);
      fail = true;
      await tick();
      expect('cliUpdate' in (manager.get(id) ?? {})).toBe(false);
      expect(globalChanges(events)).toHaveLength(1);
    });

    it('karta bez procesu (panel zniknął) nie niesie pigułki', async () => {
      const { manager, supervisor, id } = await build();
      supervisor.gone(KEY);
      await flush();
      expect('cliUpdate' in (manager.get(id) ?? {})).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // restart — odmowy PRZED `/exit`
  // -------------------------------------------------------------------------

  describe('restart — każda odmowa przed /exit', () => {
    /** Odmowa: właściwe zdanie, ZERO `/exit`, ZERO startu, rezerwacja i slot zwrócone. */
    async function expectRefusal(built: Built, message: string | RegExp): Promise<void> {
      await expect(built.manager.restart(built.id)).rejects.toThrow(message);
      expect(built.driver.exits).toBe(0);
      expect(built.supervisor.launches).toEqual([]);
    }

    it('brak aktualizacji → 409, zero /exit', async () => {
      await expectRefusal(await build({ world: makeWorld('2.1.283', '2.1.283') }),
        RESTART_NO_UPDATE_MESSAGE.text);
    });

    it('pole promptu na Macu z tekstem albo nieczytelne → 409', async () => {
      const filled = await build();
      filled.driver.probe = { ...filled.driver.probe, composer: 'filled' };
      await expectRefusal(filled, restartComposerMessage(SYSTEM).text);
      filled.driver.probe = { ...filled.driver.probe, composer: 'unknown' };
      await expectRefusal(filled, RESTART_COMPOSER_UNKNOWN_MESSAGE.text);
    });

    it('świeży status z gniazda `working` (karencja nadzorcy go jeszcze nie widzi) → 409', async () => {
      const built = await build();
      built.driver.probe = {
        ...built.driver.probe, agent: { agentSessionId: ENGINE_SESSION, status: 'working' },
      };
      await expectRefusal(built, RESTART_BUSY_MESSAGE.text);
    });

    it('w panelu stoi inna rozmowa albo agenta nie ma → 409', async () => {
      const built = await build();
      built.driver.probe = {
        ...built.driver.probe,
        agent: { agentSessionId: '22222222-2222-4222-8222-222222222222', status: 'idle' },
      };
      await expectRefusal(built, RESTART_PANEL_CHANGED_MESSAGE.text);
    });

    it('tryb zgód nieczytelny → 409; `bypass` poza RAROG_YOLO_ROOTS → 400', async () => {
      const built = await build();
      built.driver.probe = { ...built.driver.probe, mode: 'unknown' };
      await expectRefusal(built, RESTART_MODE_UNKNOWN_MESSAGE.text);
      built.driver.probe = { ...built.driver.probe, mode: 'bypass' };
      await expectRefusal(built, /bypass|YOLO|tryb/i);
    });

    it('rejestr CLI: powłoka w tle, dwa procesy, inne wydanie → 409', async () => {
      const shell = makeWorld();
      shell.registry?.set(ENGINE_SESSION, [{ pid: 1, version: '2.1.280', status: 'shell' }]);
      await expectRefusal(await build({ world: shell }), RESTART_TASKS_MESSAGE.text);

      const two = makeWorld();
      two.registry?.set(ENGINE_SESSION, [
        { pid: 1, version: '2.1.280', status: 'idle' }, { pid: 2, version: '2.1.281', status: 'idle' },
      ]);
      await expectRefusal(await build({ world: two }), RESTART_WRITERS_MESSAGE.text);
    });

    /*
     * Subagent w postoju nie jest pracą, ale restart zabija proces CLI, a z nim agenta, który
     * stoi, i komendę, na którą czeka. Blokada zostaje dla każdego zadania; zmienia się zdanie.
     * „W tle działa zadanie" przy samym czekającym byłoby nieprawdą.
     */
    describe('lista zadań w tle', () => {
      const AT = '2026-10-10T06:00:00.000Z';
      const waitingAgent: BackgroundTask = {
        id: 'a52b91f105b002e8d', kind: 'agent', description: 'Shared views', waitingSince: AT,
        ownTasks: [{ id: 'bjvzo6rnl', command: 'until grep -q TEST log.txt; do sleep 5; done' }],
      };
      const workingAgent: BackgroundTask = { id: 'a7c3bc19e5d808853', kind: 'agent', startedAt: AT };
      const command: BackgroundTask = { id: 'b28xs0cd6', kind: 'command', command: 'pnpm test' };

      async function withTasks(tasks: BackgroundTask[]): Promise<Built> {
        const built = await build();
        built.driver.queue.push({ type: 'background-tasks', tasks });
        await flush();
        expect(built.manager.get(built.id)?.backgroundTasks).toEqual(tasks);
        return built;
      }

      it('sami czekający subagenci → 409 ze zdaniem o czekającym subagencie', async () => {
        await expectRefusal(await withTasks([waitingAgent]), RESTART_WAITING_AGENT_MESSAGE.text);
        await expectRefusal(
          await withTasks([waitingAgent, { ...waitingAgent, id: 'adf9f89efc18a4bc4' }]),
          RESTART_WAITING_AGENT_MESSAGE.text,
        );
      });

      it('czekający obok pracującego subagenta albo komendy → 409 ze zdaniem o działającym zadaniu', async () => {
        await expectRefusal(await withTasks([waitingAgent, workingAgent]), RESTART_TASKS_MESSAGE.text);
        await expectRefusal(await withTasks([waitingAgent, command]), RESTART_TASKS_MESSAGE.text);
      });

      it('samo pracujące zadanie → 409 jak dotąd', async () => {
        await expectRefusal(await withTasks([command]), RESTART_TASKS_MESSAGE.text);
        await expectRefusal(await withTasks([workingAgent]), RESTART_TASKS_MESSAGE.text);
      });

      it('zdania są dwa i oba nazwą przeszkodę', () => {
        expect(RESTART_WAITING_AGENT_MESSAGE.text).toBe('A subagent with its own task is waiting in the background. A restart would interrupt it.');
        expect(RESTART_TASKS_MESSAGE.text).toBe('A background task is running. A restart would interrupt it.');
      });

      it('lista opróżniona → restart przechodzi', async () => {
        const built = await withTasks([waitingAgent]);
        built.driver.queue.push({ type: 'background-tasks', tasks: [] });
        await flush();
        await expect(built.manager.restart(built.id)).resolves.toEqual({ sessionId: built.id });
      });

      /**
       * Lista jest sprawdzana drugi raz, tuż przed `/exit`.
       * Kontrole restartu czekają na odczyty, a w tym czasie uśpiony subagent potrafi wrócić na
       * listę albo ruszyć nowe zadanie; `/exit` zabiłby jego proces bez odmowy.
       */
      it('zadanie pojawia się w trakcie kontroli restartu → 409, zero /exit, a slot i rezerwacja wracają', async () => {
        const built = await build({ overrides: { launchThrottle: { minIntervalMs: 60_000 } } });
        const probe = built.driver.restartProbe.bind(built.driver);
        built.driver.restartProbe = async () => {
          built.driver.queue.push({ type: 'background-tasks', tasks: [workingAgent] });
          await flush();
          return probe();
        };
        await expectRefusal(built, RESTART_TASKS_MESSAGE.text);

        // Lista znów pusta przed drugą próbą: tym razem w trakcie kontroli wraca czekający subagent.
        built.driver.queue.push({ type: 'background-tasks', tasks: [] });
        await flush();
        built.driver.restartProbe = async () => {
          built.driver.queue.push({ type: 'background-tasks', tasks: [waitingAgent] });
          await flush();
          return probe();
        };
        await expectRefusal(built, RESTART_WAITING_AGENT_MESSAGE.text);

        // Zadanie zeszło: restart przechodzi od razu, bez „trwa restart" i bez 429.
        built.driver.restartProbe = probe;
        built.driver.queue.push({ type: 'background-tasks', tasks: [] });
        await flush();
        await expect(built.manager.restart(built.id)).resolves.toEqual({ sessionId: built.id });
      });
    });

    it('`claude agents --json` milczy → 409 (restart sam zabija proces, cisza nie wystarcza)', async () => {
      const world = makeWorld();
      world.cliLive = null;
      await expectRefusal(await build({ world }), RESTART_UNVERIFIED_MESSAGE.text);
    });

    it('odmowa zwraca slot throttle\'a: poprawiony restart przechodzi od razu, bez 429', async () => {
      const built = await build({ overrides: { launchThrottle: { minIntervalMs: 60_000 } } });
      built.driver.probe = { ...built.driver.probe, composer: 'filled' };
      await expectRefusal(built, restartComposerMessage(SYSTEM).text);
      built.driver.probe = { ...built.driver.probe, composer: 'empty' };
      await expect(built.manager.restart(built.id)).resolves.toEqual({ sessionId: built.id });
    });

    it('dwa tapnięcia naraz: drugie dostaje 409 bez czekania na odczyty pierwszego', async () => {
      const built = await build();
      const first = built.manager.restart(built.id);
      await expect(built.manager.restart(built.id)).rejects.toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
      await first;
      await until(() => built.supervisor.launches.length === 1);
      expect(built.driver.exits).toBe(1);
    });

    it('wysyłka rozpoczęta PRZED restartem, stojąca na odczycie stopki → restart 409', async () => {
      const built = await build();
      let release = (): void => { /* ustawiane niżej */ };
      built.supervisor.modeGate = new Promise<void>((resolve) => { release = resolve; });
      const sending = built.manager.sendMessage(built.id, 'hej');
      await flush();
      await expectRefusal(built, RESTART_BUSY_MESSAGE.text);
      release();
      await sending;
      expect(built.driver.sent).toEqual(['hej']);
    });

    it('wyłączony launcher schowany za pełnym sufitem paneli → 409 przed /exit', async () => {
      const built = await build({
        agent: makeAgent({ launchedByRarog: true }),
        overrides: { maxPanes: 1 },
      });
      built.supervisor.paneCount = 1;
      built.supervisor.launchOk = false;
      await expectRefusal(built, /wyłączone|RAROG_HERDR_LAUNCH/);
    });

    it('ogon pliku rozmowy poza katalogiem karty → 400 przed /exit', async () => {
      const built = await build({ overrides: { herdrDeps: depsWithTail(`${PROJECT}-b`) } });
      await expectRefusal(built, RESUME_FOREIGN_CWD_MESSAGE.text);
    });

    it('katalog w zasięgu obserwacji, ale poza allow-listą zakładania → 400 przed /exit', async () => {
      const built = await build({
        overrides: { projects: [{ path: '/Users/u/Projects/inny', name: 'inny' }] },
      });
      await expectRefusal(built, /isn't allowed|isn't on the list of allowed projects|nie jest na liście projektów/);
    });

    it('w trakcie restartu wysyłka, tryb i zamknięcie karty dostają 409', async () => {
      const built = await build();
      // `/exit` bez skutku: proces „wisi", rezerwacja trwa aż do limitu czasu.
      built.driver.onExit = null;
      await built.manager.restart(built.id);
      // `sendMessage` rzuca SYNCHRONICZNIE (kontrakt `ManagerApi`), reszta odrzuca obietnicę.
      expect(() => built.manager.sendMessage(built.id, 'hej')).toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
      await expect(built.manager.setMode(built.id, { mode: 'plan' }))
        .rejects.toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
      await expect(built.manager.close(built.id, { closePanel: true }))
        .rejects.toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
    });

    it('a queue take-back during a restart gets 409 before the driver', async () => {
      const built = await build();
      built.driver.onExit = null;
      await built.manager.restart(built.id);
      expect(() => built.manager.takeBackQueue(built.id, 'take-back-during-restart'))
        .toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
    });
  });

  // -------------------------------------------------------------------------
  // restart — przebieg
  // -------------------------------------------------------------------------

  describe('restart z ultracode (pytanie 3 planu: poziom rozmowy wygrywa)', () => {
    const systemTexts = (manager: Manager, id: string): string[] => manager.transcript(id).messages
      .filter((m) => m.role === 'system').flatMap((m) => m.blocks)
      .flatMap((b) => (b.type === 'text' ? [b.text] : []));

    it('karta z ultracode na xhigh i Claude Code ≥ 2.1.284: nowy proces wstaje z `--effort ultracode`', async () => {
      const built = await build({ world: makeWorld('2.1.290', '2.1.317') });
      const { manager, supervisor, driver, id } = built;
      driver.queue.push({
        type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5', effort: 'xhigh', ultracode: true,
      });
      await flush();
      driver.probe = { ...driver.probe, mode: 'auto' };

      await manager.restart(id);
      await until(() => supervisor.launches.length === 1);
      expect(supervisor.launches[0]).toEqual({
        cwd: PROJECT, resumeFrom: ENGINE_SESSION, permissionMode: 'auto', effort: 'xhigh', ultracode: true,
      });
      await until(() => manager.get(id)?.state === 'waiting-input');
      expect(manager.get(id)).toMatchObject({ effort: 'xhigh', ultracode: true });
      expect(systemTexts(manager, id)).not.toContain(RESUME_WITHOUT_ULTRACODE_MESSAGE.text);
    });

    it('karta z ultracode na innym poziomie: restart na poziomie rozmowy, bez ultracode, ze zdaniem systemowym', async () => {
      const built = await build({ world: makeWorld('2.1.290', '2.1.317') });
      const { manager, supervisor, driver, id } = built;
      driver.queue.push({
        type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5', effort: 'high', ultracode: true,
      });
      await flush();
      driver.probe = { ...driver.probe, mode: 'auto' };

      await manager.restart(id);
      await until(() => supervisor.launches.length === 1);
      expect(supervisor.launches[0]).toEqual({
        cwd: PROJECT, resumeFrom: ENGINE_SESSION, permissionMode: 'auto', effort: 'high',
      });
      await until(() => systemTexts(manager, id).includes(RESUME_WITHOUT_ULTRACODE_MESSAGE.text));
      expect('ultracode' in (manager.get(id) ?? {})).toBe(false);
    });

    it('zainstalowane Claude Code poniżej 2.1.284: restart idzie dalej bez ultracode, odmowy nie ma po /exit', async () => {
      const built = await build();
      const { manager, supervisor, driver, id } = built;
      driver.queue.push({
        type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5', effort: 'xhigh', ultracode: true,
      });
      await flush();
      driver.probe = { ...driver.probe, mode: 'auto' };

      await manager.restart(id);
      await until(() => supervisor.launches.length === 1);
      expect(supervisor.launches[0]).toEqual({
        cwd: PROJECT, resumeFrom: ENGINE_SESSION, permissionMode: 'auto', effort: 'xhigh',
      });
      await until(() => systemTexts(manager, id).includes(RESUME_WITHOUT_ULTRACODE_MESSAGE.text));
    });
  });

  describe('restart — przebieg po /exit', () => {
    it('ścieżka szczęśliwa: /exit → koniec w trzech źródłach → --resume w nowym tabie → ta sama karta', async () => {
      const built = await build();
      const { manager, supervisor, driver, id } = built;
      built.driver.queue.push({ type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5', effort: 'xhigh' });
      await flush();
      driver.probe = { ...driver.probe, mode: 'acceptEdits' };

      await expect(manager.restart(id)).resolves.toEqual({ sessionId: id });
      expect(driver.exits).toBe(1);
      expect(supervisor.restartLog).toEqual([`${KEY} cli-update 2.1.280 → 2.1.283`]);
      await until(() => supervisor.launches.length === 1);
      // Tryb 1:1 (`acceptEdits` NIE zwinięty do `auto`), effort ostatniej tury, BEZ `--model`.
      expect(supervisor.launches[0]).toEqual({
        cwd: PROJECT, resumeFrom: ENGINE_SESSION, permissionMode: 'acceptEdits', effort: 'xhigh',
      });
      await until(() => supervisor.closedShellTabs.length === 1);
      expect(supervisor.closedShellTabs).toEqual([OLD_TAB]);
      const summary = manager.get(id);
      expect(summary?.id).toBe(id);
      expect(summary?.state).toBe('waiting-input');
      // Nowy proces jest na zainstalowanym wydaniu — pigułka gaśnie.
      expect('cliUpdate' in (summary ?? {})).toBe(false);
      const texts = manager.transcript(id).messages.flatMap((m) => m.blocks)
        .flatMap((b) => (b.type === 'text' ? [b.text] : []));
      expect(texts.some((t) => t.includes('Session restarted on Claude Code 2.1.283'))).toBe(true);
    });

    it('rozmowa skończyła w worktree pod katalogiem karty → restart przechodzi, panel w katalogu karty', async () => {
      // `cd` do worktree agenta zostawia w ogonie pliku katalog pod projektem.
      const built = await build({
        overrides: { herdrDeps: depsWithTail(`${PROJECT}/.claude/worktrees/agent-a462323964696f07a`) },
      });

      await expect(built.manager.restart(built.id)).resolves.toEqual({ sessionId: built.id });
      await until(() => built.supervisor.launches.length === 1);
      expect(built.supervisor.launches[0]).toMatchObject({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });
    });

    it('CLI pyta przy wyjściu (praca w tle) → Esc, sesja żyje, zero startu', async () => {
      const built = await build();
      // `/exit` stawia dialog zamiast wyjść: herdr melduje `blocked`.
      built.driver.onExit = (): void => {
        built.driver.queue.push({ type: 'agent-state', state: 'blocked' });
      };
      await built.manager.restart(built.id);
      await until(() => built.driver.interrupts === 1);
      await flush();
      expect(built.supervisor.launches).toEqual([]);
      const blocks = built.manager.transcript(built.id).messages.flatMap((m) => m.blocks)
        .filter((b) => b.type === 'text');
      // Notka ostrzega (⚠) i niesie powód jako podkod; szczegół stanu zostaje bez prefiksu.
      expect(blocks).toContainEqual(expect.objectContaining({
        text: `⚠ ${RESTART_EXIT_ASKED_DETAIL.text}`, ref: { code: 'restart.exit-note', args: ['restart.exit-asked'] },
      }));
      expect(built.manager.get(built.id)?.stateDetail).toBe(RESTART_EXIT_ASKED_DETAIL.text);
      // Rezerwacja zdjęta: karta przyjmuje znów akcje (tu: kolejny restart odmawia z innego powodu).
      await expect(built.manager.restart(built.id)).rejects.not.toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
    });

    it('proces nie kończy się w limicie → restart przerwany, zero startu, karta żywa', async () => {
      const built = await build();
      built.driver.onExit = null;
      await built.manager.restart(built.id);
      await until(() => built.manager.transcript(built.id).messages.some((m) => m.blocks.some(
        (b) => b.type === 'text' && b.text === `⚠ ${RESTART_EXIT_TIMEOUT_DETAIL.text}`,
      )));
      expect(built.supervisor.launches).toEqual([]);
      expect(built.manager.get(built.id)?.state).toBe('waiting-input');
    });

    it('start po /exit pada definitywnie → `resumable`; spóźnione `gone` nie zamyka; „Wznów" z tym samym trybem', async () => {
      const built = await build();
      const { manager, supervisor, driver, id } = built;
      driver.probe = { ...driver.probe, mode: 'plan' };
      supervisor.launchError = Object.assign(new Error('No conversation found'), { code: 'herdr-gone' });
      await manager.restart(id);
      // `resumable` bywa też PRZEJŚCIOWE (proces zniknął, nowy jeszcze nie wstał) — czekamy na powód.
      await until(() => manager.get(id)?.stateDetail?.includes(RESTART_FAILED_DETAIL.text) === true);
      expect(manager.get(id)?.state).toBe('resumable');

      // Resync nadzorcy ogłasza zniknięcie nowego panelu po czasie — karta ma zostać.
      supervisor.gone('w9:pN1');
      await flush();
      expect(manager.get(id)?.state).toBe('resumable');

      supervisor.launchError = null;
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      await manager.resume(id);
      // Drugi start to „Wznów" — z trybem odczytanym PRZED `/exit`, a nie z domyślnym konta.
      expect(supervisor.launches).toHaveLength(2);
      expect(supervisor.launches[1]?.permissionMode).toBe('plan');
    });

    it('start po /exit pada ze zdaniem z argumentami → `resumable`, rama „Couldn\'t restart” z tekstem zdania', async () => {
      const built = await build();
      const { manager, supervisor, id } = built;
      const vanished = say('herdr.agent-vanished.screen', { screen: 'zsh: command not found' });
      supervisor.launchError = new HerdrGoneError(vanished);
      await manager.restart(id);
      await until(() => manager.get(id)?.stateDetailRef?.code === 'restart.failed.reason');
      expect(manager.get(id)?.state).toBe('resumable');
      expect(manager.get(id)?.stateDetailRef).toEqual({ code: 'restart.failed.reason', args: [vanished.text] });
      expect(manager.get(id)?.stateDetail).toContain(RESTART_FAILED_DETAIL.text);
    });

    it('NOWY panel znika przed gotowością → `resumable`, nie terminalne `done`', async () => {
      const built = await build();
      let release = (): void => { /* ustawiane niżej */ };
      built.supervisor.launchReady = new Promise<void>((resolve) => { release = resolve; });
      built.supervisor.launchError = Object.assign(new Error('proces padł'), { code: 'herdr-gone' });
      await built.manager.restart(built.id);
      await until(() => built.supervisor.launches.length === 1);
      await flush();
      built.supervisor.gone('w9:pN1');
      await flush();
      release();
      await until(() => built.manager.get(built.id)?.stateDetail?.includes(RESTART_FAILED_DETAIL.text) === true);
      expect(built.manager.get(built.id)?.state).toBe('resumable');
    });

    it('`/exit` z niepewnym wynikiem (zgubiona odpowiedź), ale proces zniknął → restart idzie dalej', async () => {
      const built = await build();
      built.driver.exitResult = false;
      await expect(built.manager.restart(built.id)).resolves.toEqual({ sessionId: built.id });
      await until(() => built.supervisor.launches.length === 1);
      expect(built.driver.exits).toBe(1);
    });

    it('niepewny wynik startu (brak gotowości w oknie) → `error`, nie `resumable`', async () => {
      const built = await build();
      built.supervisor.launchError = Object.assign(new Error('brak gotowości'), {
        name: 'HerdrLaunchTimeoutError',
      });
      await built.manager.restart(built.id);
      await until(() => built.manager.get(built.id)?.state === 'error');
    });
  });

  // -------------------------------------------------------------------------
  // restart z powodu blokady promptu i ponowna wysyłka
  // -------------------------------------------------------------------------

  /*
   * Prompt wysłany z Raroga zablokował hook `UserPromptSubmit`: notka z `seq`, przycisk „Uruchom ponownie
   * i wyślij” (`SessionSummary.promptBlocked`), a CLI włożył prompt z powrotem do pola — driver ma zgodę na jego
   * wyczyszczenie. Restart TEJ sesji (także bez aktualizacji) i prompt do nowego procesu RAZ, drogą promptu
   * startowego, z tekstem z serwera. Najważniejsze własności: każda odmowa przed `/exit` zostawia przycisk,
   * a odmowy z odczytu zapadają bez klawiszy.
   */
  describe('restart po blokadzie promptu z ponowną wysyłką', () => {
    const NEW_KEY = 'w9:pN1';
    const SAME = (): World => makeWorld('2.1.283', '2.1.283');

    /** Wysyłka z Raroga, blokada hooka jak z drivera, pole z promptem i zgoda drivera. Oddaje pole z karty. */
    async function blockPrompt(built: Built, text = 'Dopisz testy kontraktu'): Promise<SessionPromptBlocked> {
      await built.manager.sendMessage(built.id, text);
      await flush();
      built.driver.queue.push({
        type: 'prompt-blocked', reason: 'Sesja sprzed aktualizacji ustawień.', promptKept: false,
        echoed: true, decided: true, key: echoKey(text),
      });
      await flush();
      built.driver.blockedLeftover = true;
      built.driver.probe = { ...built.driver.probe, composer: 'filled' };
      const blocked = built.manager.get(built.id)?.promptBlocked;
      if (blocked === undefined) throw new Error('blokada nie dała przycisku');
      return blocked;
    }

    function texts(manager: Manager, id: string): string[] {
      return manager.transcript(id).messages.flatMap((m) => m.blocks)
        .flatMap((b) => (b.type === 'text' ? [b.text] : []));
    }

    /** Odmowa przed `/exit`: zdanie, zero `/exit`, zero startu, przycisk (`kept`) zostaje na karcie. */
    async function expectKept(
      built: Built, resend: SessionPromptBlocked, message: string | RegExp, kept = resend,
    ): Promise<void> {
      await expect(built.manager.restart(built.id, { resend })).rejects.toThrow(message);
      expect(built.driver.exits).toBe(0);
      expect(built.supervisor.launches).toEqual([]);
      expect(built.manager.get(built.id)?.promptBlocked).toEqual(kept);
    }

    it('blokada daje przycisk na karcie; wpis `user` z pliku go gasi ramką `session-changed`', async () => {
      const built = await build({ world: SAME() });
      const blocked = await blockPrompt(built);
      expect(built.manager.get(built.id)?.state).toBe('waiting-input');
      const notice = built.manager.transcript(built.id).messages.find((m) => m.seq === blocked.seq);
      expect(notice?.promptBlocked?.reason).toBe('Sesja sprzed aktualizacji ustawień.');

      const events = record(built.manager);
      built.driver.queue.push({ type: 'turn-input' });
      await flush();
      expect('promptBlocked' in (built.manager.get(built.id) ?? {})).toBe(false);
      expect(globalChanges(events).at(-1)?.promptBlocked).toBeUndefined();
      await expect(built.manager.restart(built.id, { resend: blocked }))
        .rejects.toThrow(RESTART_RESEND_STALE_MESSAGE.text);
    });

    it('ścieżka szczęśliwa bez aktualizacji: pole czyszczone po kontrolach, `/exit`, prompt RAZ do nowego procesu', async () => {
      const built = await build({ world: SAME() });
      const { manager, supervisor, driver, id } = built;
      const blocked = await blockPrompt(built);
      const events = record(manager);

      await expect(manager.restart(id, { resend: blocked })).resolves.toEqual({ sessionId: id });
      // Czyszczenie pola dla TEJ rozmowy, przed `/exit`; dziennik z powodem, bez pary wydań.
      expect(driver.clears).toEqual([ENGINE_SESSION]);
      expect(driver.exits).toBe(1);
      expect(supervisor.restartLog).toEqual([`${KEY} prompt-blocked`]);
      // Teksty bez wydania — restart nie jest aktualizacją.
      expect(globalChanges(events).map((s) => s.stateDetail)).toContain('Exiting the session…');
      // Przycisk znika z karty dopiero przy `/exit` — ładunek przeszedł do restartu.
      expect(globalChanges(events).find((s) => s.stateDetail === 'Exiting the session…')?.promptBlocked).toBeUndefined();

      await until(() => supervisor.drivers.get(NEW_KEY)?.sent.length === 1);
      // Prompt drogą promptu startowego (`agent.prompt` nowego panelu), nigdy w argv `--resume`.
      expect(supervisor.drivers.get(NEW_KEY)?.sent).toEqual(['Dopisz testy kontraktu']);
      expect(JSON.stringify(supervisor.launches[0])).not.toContain('Dopisz testy');
      await until(() => supervisor.closedShellTabs.length === 1);
      // Notka restartu stoi PRZED dymkiem ponownej wysyłki; prompt idzie dokładnie raz.
      const after = texts(manager, id);
      expect(after.slice(-2)).toEqual([RESTART_DONE_NOTE.text, 'Dopisz testy kontraktu']);
      expect(manager.get(id)?.state).toBe('running');
      await flush();
      expect(supervisor.drivers.get(NEW_KEY)?.sent).toHaveLength(1);
    });

    it('prompt wysłany przed zdjęciem rezerwacji; zwykła wysyłka w trakcie dostaje 409', async () => {
      const built = await build({ world: SAME() });
      const { manager, supervisor, id } = built;
      const blocked = await blockPrompt(built);
      let release = (): void => { /* ustawiane niżej */ };
      supervisor.launchReady = new Promise<void>((resolve) => { release = resolve; });
      const inSend: boolean[] = [];
      supervisor.onAttach = (key, driver): void => {
        if (key !== NEW_KEY) return;
        // W chwili wysyłki karta jest jeszcze zarezerwowana: żadna inna wysyłka nie wejdzie przed ten prompt.
        driver.onSend = (): void => {
          try {
            void manager.sendMessage(id, 'wcisnę się');
            inSend.push(false);
          } catch (error: unknown) {
            inSend.push(error instanceof Error && error.message === RESTART_IN_PROGRESS_MESSAGE.text);
          }
        };
      };

      await manager.restart(id, { resend: blocked });
      await until(() => supervisor.launches.length === 1);
      expect(() => manager.sendMessage(id, 'w trakcie')).toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
      release();
      await until(() => inSend.length === 1);
      expect(inSend).toEqual([true]);
      await until(() => supervisor.closedShellTabs.length === 1);
      // Po wysyłce rezerwacja zeszła: karta znów przyjmuje akcje (tu: ponowny restart odmawia z innego powodu).
      await expect(manager.restart(id, { resend: blocked })).rejects.toThrow(RESTART_RESEND_STALE_MESSAGE.text);
    });

    it('nieaktualny `seq` albo `id` → 409 PRZED rezerwacją: bez slotu throttle\'a, bez odczytów i klawiszy', async () => {
      const built = await build({ overrides: { launchThrottle: { minIntervalMs: 60_000 } } });
      // Bez blokady w ogóle — też 409, także przy dostępnej aktualizacji (gest dotyczył promptu).
      await expect(built.manager.restart(built.id, { resend: { seq: 3, id: 'nie-ma' } }))
        .rejects.toThrow(RESTART_RESEND_STALE_MESSAGE.text);
      const blocked = await blockPrompt(built);
      await expectKept(built, { ...blocked, seq: blocked.seq + 1 }, RESTART_RESEND_STALE_MESSAGE.text, blocked);
      await expectKept(built, { ...blocked, id: 'inna-blokada' }, RESTART_RESEND_STALE_MESSAGE.text, blocked);
      expect(built.driver.clears).toEqual([]);
      // Slot nie został zużyty: właściwe tapnięcie przechodzi od razu, bez 429.
      await expect(built.manager.restart(built.id, { resend: blocked })).resolves.toEqual({ sessionId: built.id });
    });

    it('brak aktualizacji i brak `resend` → 409 jak dotąd, także przy blokadzie na karcie', async () => {
      const built = await build({ world: SAME() });
      await blockPrompt(built);
      built.driver.probe = { ...built.driver.probe, composer: 'empty' };
      await expect(built.manager.restart(built.id)).rejects.toThrow(RESTART_NO_UPDATE_MESSAGE.text);
      expect(built.driver.exits).toBe(0);
    });

    it('strażnik tekstu odrzuca ładunek (tryb nieznany, katalog nowego wydania) → 400 przed `/exit`', async () => {
      const deps = makeDeps();
      const built = await build({
        world: SAME(),
        overrides: {
          herdrDeps: {
            ...deps,
            assertSendable: (text, opts) => {
              // Pierwsza wysyłka szła przy znanym trybie; sucha kontrola restartu ma tryb `unknown`.
              if (opts.mode === 'unknown') throw new HerdrPromptRejectedError(foreign('Tego nie wyślę.'));
              return { text: text.trim(), slash: null };
            },
          },
        },
      });
      const blocked = await blockPrompt(built);
      await expectKept(built, blocked, 'Tego nie wyślę.');
      expect(built.driver.clears).toEqual([]);
    });

    it('każda odmowa przed `/exit` zostawia przycisk — także 429 throttle\'a startów', async () => {
      const built = await build({ world: SAME() });
      const blocked = await blockPrompt(built);
      built.driver.probe = { ...built.driver.probe, agent: { agentSessionId: ENGINE_SESSION, status: 'working' } };
      await expectKept(built, blocked, RESTART_BUSY_MESSAGE.text);

      const throttled = await build({ world: SAME(), overrides: { launchThrottle: { hourlyCap: 0 } } });
      const throttledBlocked = await blockPrompt(throttled);
      await expectKept(throttled, throttledBlocked, /Too many sessions too fast/);
    });

    it('pole po blokadzie: odmowy z odczytu (rozmowa, status, tryb, `claude agents`) zapadają bez klawiszy', async () => {
      const built = await build({ world: SAME() });
      const blocked = await blockPrompt(built);
      const filled = built.driver.probe;

      const other = '22222222-2222-4222-8222-222222222222';
      built.driver.probe = { ...filled, agent: { agentSessionId: other, status: 'idle' } };
      await expectKept(built, blocked, RESTART_PANEL_CHANGED_MESSAGE.text);
      built.driver.probe = { ...filled, agent: { agentSessionId: ENGINE_SESSION, status: 'working' } };
      await expectKept(built, blocked, RESTART_BUSY_MESSAGE.text);
      built.driver.probe = { ...filled, mode: 'unknown' };
      await expectKept(built, blocked, RESTART_MODE_UNKNOWN_MESSAGE.text);
      built.driver.probe = filled;
      const live = built.world.cliLive;
      built.world.cliLive = null;
      await expectKept(built, blocked, RESTART_UNVERIFIED_MESSAGE.text);
      built.world.cliLive = live;
      expect(built.driver.clears).toEqual([]);
      expect(built.driver.blockedLeftover).toBe(true);
    });

    it('pigułka `↑` po zablokowanym prompcie: pole czyszczone, restart idzie, bez ponownej wysyłki', async () => {
      const built = await build();
      await blockPrompt(built);
      await expect(built.manager.restart(built.id)).resolves.toEqual({ sessionId: built.id });
      expect(built.driver.clears).toEqual([ENGINE_SESSION]);
      expect(built.driver.exits).toBe(1);
      expect(built.supervisor.restartLog).toEqual([`${KEY} cli-update 2.1.280 → 2.1.283`]);
      await until(() => built.supervisor.closedShellTabs.length === 1);
      expect(built.supervisor.drivers.get(NEW_KEY)?.sent).toEqual([]);
    });

    it('zadanie czyszczenia widzi `working` albo inną rozmowę → odmowa, zero `/exit`', async () => {
      const built = await build({ world: SAME() });
      const blocked = await blockPrompt(built);
      built.driver.clearResult = 'busy';
      await expectKept(built, blocked, RESTART_BUSY_MESSAGE.text);
      built.driver.clearResult = 'changed';
      await expectKept(built, blocked, RESTART_PANEL_CHANGED_MESSAGE.text);
      built.driver.clearResult = 'stale';
      await expectKept(built, blocked, restartComposerMessage(SYSTEM).text);
    });

    it('czyszczenie nieudane → ta sama odmowa co przy pełnym polu (albo nieczytelnym)', async () => {
      const built = await build({ world: SAME() });
      const blocked = await blockPrompt(built);
      built.driver.clearResult = 'filled';
      await expectKept(built, blocked, restartComposerMessage(SYSTEM).text);
      // Zgoda zużyta: drugie tapnięcie przy wciąż pełnym polu odmawia bez czyszczenia.
      await expectKept(built, blocked, restartComposerMessage(SYSTEM).text);
      expect(built.driver.clears).toHaveLength(1);

      const other = await build({ world: SAME() });
      const otherBlocked = await blockPrompt(other);
      other.driver.clearResult = 'unknown';
      await expectKept(other, otherBlocked, RESTART_COMPOSER_UNKNOWN_MESSAGE.text);
    });

    it('odmowa PO czyszczeniu zostawia przycisk; nowy szkic na Macu → ponowny restart odmawia jak dotąd', async () => {
      const built = await build({ world: SAME() });
      const blocked = await blockPrompt(built);
      // W trakcie czyszczenia rusza zadanie w tle — druga kontrola listy przed `/exit` odmawia.
      built.driver.onClear = (): void => {
        built.driver.queue.push({
          type: 'background-tasks', tasks: [{ id: 'b1', kind: 'command', command: 'pnpm test' }],
        });
      };
      await expectKept(built, blocked, RESTART_TASKS_MESSAGE.text);
      expect(built.driver.clears).toHaveLength(1);
      expect(built.driver.blockedLeftover).toBe(false);

      built.driver.onClear = null;
      built.driver.queue.push({ type: 'background-tasks', tasks: [] });
      await flush();
      // Człowiek przy Macu wpisał nowy szkic: pole pełne, zgody już nie ma.
      built.driver.probe = { ...built.driver.probe, composer: 'filled' };
      await expectKept(built, blocked, restartComposerMessage(SYSTEM).text);
      expect(built.driver.clears).toHaveLength(1);
    });

    it('prompt wysłany przy Macu w trakcie kontroli (wejście tury z pliku) → 409, zero `/exit`', async () => {
      const built = await build({ world: SAME() });
      const blocked = await blockPrompt(built);
      const probe = built.driver.restartProbe.bind(built.driver);
      built.driver.restartProbe = async () => {
        built.driver.queue.push({ type: 'turn-input' });
        await flush();
        return probe();
      };
      await expect(built.manager.restart(built.id, { resend: blocked }))
        .rejects.toThrow(RESTART_RESEND_STALE_MESSAGE.text);
      expect(built.driver.exits).toBe(0);
      expect(built.supervisor.launches).toEqual([]);
      expect('promptBlocked' in (built.manager.get(built.id) ?? {})).toBe(false);
    });

    // Blokada promptu wysłanego przy Macu po naszym gasi przycisk starego promptu.
    it('blokada promptu spoza Raroga po naszej → przycisk znika, ponowna wysyłka starego dostaje 409', async () => {
      const built = await build({ world: SAME() });
      const blocked = await blockPrompt(built);
      const events = record(built.manager);
      built.driver.queue.push({
        type: 'prompt-blocked', reason: 'hook', promptKept: false, prompt: 'wpisane przy Macu',
        echoed: false, decided: false,
      });
      await flush();
      expect('promptBlocked' in (built.manager.get(built.id) ?? {})).toBe(false);
      expect(globalChanges(events).at(-1)?.promptBlocked).toBeUndefined();
      await expect(built.manager.restart(built.id, { resend: blocked }))
        .rejects.toThrow(RESTART_RESEND_STALE_MESSAGE.text);
      expect(built.driver.clears).toEqual([]);
      expect(built.driver.exits).toBe(0);
    });

    it('bez zgody drivera pełne pole → `RESTART_COMPOSER_MESSAGE` jak dotąd, bez czyszczenia', async () => {
      const built = await build({ world: SAME() });
      const blocked = await blockPrompt(built);
      built.driver.blockedLeftover = false;
      await expectKept(built, blocked, restartComposerMessage(SYSTEM).text);
      expect(built.driver.clears).toEqual([]);
    });

    it('nowy panel znika przed wysyłką → zdanie zostaje w transkrypcie z `HERDR_LOST_PROMPT_MESSAGE.text`', async () => {
      const built = await build({ world: SAME() });
      const { manager, supervisor, id } = built;
      const blocked = await blockPrompt(built);
      let release = (): void => { /* ustawiane niżej */ };
      supervisor.launchReady = new Promise<void>((resolve) => { release = resolve; });
      await manager.restart(id, { resend: blocked });
      await until(() => supervisor.launches.length === 1);
      await flush();
      supervisor.gone(NEW_KEY);
      await flush();
      release();
      await until(() => texts(manager, id).includes(HERDR_LOST_PROMPT_MESSAGE.text));
      expect(texts(manager, id).slice(-2)).toEqual(['Dopisz testy kontraktu', HERDR_LOST_PROMPT_MESSAGE.text]);
      expect(supervisor.drivers.get(NEW_KEY)?.sent).toEqual([]);
      // Rezerwacja zdjęta: karta nie wisi na „trwa restart”.
      await expect(manager.restart(id)).rejects.not.toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
    });

    it('dymek ponownej wysyłki: zdanie bez ścieżek i wizytówki załączników; do CLI tekst ze ścieżkami', async () => {
      const deps = makeDeps();
      const built = await build({
        world: SAME(),
        overrides: {
          herdrDeps: {
            ...deps,
            writeUploads: async (cwd, images) => images.map((_, i) => `${cwd}/.rarog-uploads/zrzut-${String(i)}.png`),
            writeUploadFiles: async (cwd, files) => files.map((f) => `${cwd}/.rarog-uploads/${f.name}`),
          },
        },
      });
      const { manager, supervisor, id } = built;
      const PNG = 'data:image/png;base64,iVBORw0KGgo=';
      const PDF = 'data:application/pdf;base64,JVBERi0xLjQ=';
      await manager.sendMessage(id, 'Porównaj zrzut z raportem', [PNG], [{ name: 'raport.pdf', dataUrl: PDF }]);
      await flush();
      const uploads = `${PROJECT}/.rarog-uploads`;
      const raw = `Porównaj zrzut z raportem ${uploads}/zrzut-0.png ${uploads}/raport.pdf`;
      built.driver.queue.push({
        type: 'prompt-blocked', reason: 'hook', promptKept: false, echoed: true, decided: true, key: echoKey(raw),
      });
      await flush();
      const blocked = manager.get(id)?.promptBlocked;
      if (blocked === undefined) throw new Error('blokada nie dała przycisku');
      const original = manager.transcript(id).messages.find((m) => m.role === 'user');

      await manager.restart(id, { resend: blocked });
      await until(() => supervisor.drivers.get(NEW_KEY)?.sent.length === 1);
      expect(supervisor.drivers.get(NEW_KEY)?.sent).toEqual([raw]);
      const bubble = manager.transcript(id).messages.findLast((m: TranscriptMessage) => m.role === 'user');
      expect(bubble?.blocks).toEqual([{ type: 'text', text: 'Porównaj zrzut z raportem' }]);
      expect(bubble?.attachments).toEqual(original?.attachments);
      expect(bubble?.attachments?.map((a) => a.kind)).toEqual(['image', 'file']);
      // Etykieta karty ze zdania, nie ze ścieżek uploadów.
      expect(manager.get(id)?.label ?? '').not.toContain('.rarog-uploads');
    });

    /*
     * Prompt startowy a dialog zaufania: nowy panel wstaje na dialogu (launcher: `blocked` bez gotowości).
     * Prompt czeka na `idle` po dialogu i idzie z załącznikami, a gdy panel zniknie, wraca do transkryptu tą samą
     * drogą co zdanie (`#lostStartPrompt`), z tymi samymi wizytówkami załączników.
     */
    it.each(['idle', 'gone'] as const)(
      'ponowna wysyłka na dialogu zaufania, potem `%s`: załączniki idą z promptem albo wracają razem z nim',
      async (end) => {
        const deps = makeDeps();
        const built = await build({
          world: SAME(),
          overrides: {
            herdrDeps: {
              ...deps,
              writeUploads: async (cwd, images) => images.map((_, i) => `${cwd}/.rarog-uploads/zrzut-${String(i)}.png`),
              writeUploadFiles: async (cwd, files) => files.map((f) => `${cwd}/.rarog-uploads/${f.name}`),
            },
          },
        });
        const { manager, supervisor, id } = built;
        const PNG = 'data:image/png;base64,iVBORw0KGgo=';
        const PDF = 'data:application/pdf;base64,JVBERi0xLjQ=';
        await manager.sendMessage(id, 'Porównaj zrzut z raportem', [PNG], [{ name: 'raport.pdf', dataUrl: PDF }]);
        await flush();
        const uploads = `${PROJECT}/.rarog-uploads`;
        const raw = `Porównaj zrzut z raportem ${uploads}/zrzut-0.png ${uploads}/raport.pdf`;
        built.driver.queue.push({
          type: 'prompt-blocked', reason: 'hook', promptKept: false, echoed: true, decided: true, key: echoKey(raw),
        });
        await flush();
        const blocked = manager.get(id)?.promptBlocked;
        if (blocked === undefined) throw new Error('blokada nie dała przycisku');
        const original = manager.transcript(id).messages.find((m) => m.role === 'user');

        supervisor.launchSeen = { status: 'blocked', interactiveReady: false };
        await manager.restart(id, { resend: blocked });
        await until(() => supervisor.launches.length === 1);
        await flush();
        expect(supervisor.drivers.get(NEW_KEY)?.sent).toEqual([]);
        if (end === 'idle') {
          supervisor.driver(NEW_KEY).queue.push({ type: 'agent-state', state: 'idle' });
          await until(() => supervisor.drivers.get(NEW_KEY)?.sent.length === 1);
          expect(supervisor.drivers.get(NEW_KEY)?.sent).toEqual([raw]);
        } else {
          supervisor.gone(NEW_KEY);
          await until(() => texts(manager, id).includes(HERDR_LOST_PROMPT_MESSAGE.text));
          expect(supervisor.drivers.get(NEW_KEY)?.sent).toEqual([]);
          // Rezerwacja zdjęta: karta nie wisi na „trwa restart”.
          await expect(manager.restart(id)).rejects.not.toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
        }
        const bubble = manager.transcript(id).messages.findLast((m: TranscriptMessage) => m.role === 'user');
        expect(bubble?.blocks).toEqual([{ type: 'text', text: 'Porównaj zrzut z raportem' }]);
        expect(bubble?.attachments).toEqual(original?.attachments);
        expect(bubble?.attachments?.map((a) => a.kind)).toEqual(['image', 'file']);
      });

    it('ponowione żądanie HTTP po udanym restarcie → 409, drugi prompt nie idzie', async () => {
      const built = await build({ world: SAME() });
      const { manager, supervisor, id } = built;
      const blocked = await blockPrompt(built);
      await manager.restart(id, { resend: blocked });
      // W trakcie: rezerwacja.
      await expect(manager.restart(id, { resend: blocked })).rejects.toThrow(RESTART_IN_PROGRESS_MESSAGE.text);
      await until(() => supervisor.closedShellTabs.length === 1);
      // Po: nowa karta nie ma przycisku tej notki.
      await expect(manager.restart(id, { resend: blocked })).rejects.toThrow(RESTART_RESEND_STALE_MESSAGE.text);
      expect(supervisor.launches).toHaveLength(1);
      expect(supervisor.drivers.get(NEW_KEY)?.sent).toHaveLength(1);
    });

    /*
     * Karta po `#recreate` numeruje transkrypt od zera, więc nowa notka blokady
     * w nowym procesie bywa pod TYM SAMYM `seq` co notka sprzed restartu. Spóźnione tapnięcie ze starego widoku
     * (drugie urządzenie) nie może zrestartować sesji z nowym promptem — rozstrzyga `id` blokady.
     */
    it('nowa blokada pod tym samym `seq` po restarcie: żądanie ze starym `id` → 409, zero klawiszy', async () => {
      const built = await build({ world: SAME() });
      const { manager, supervisor, id } = built;
      // Historia przesuwa numer notki sprzed restartu; nowa karta dobija do niego swoją porcją historii.
      const history = (count: number): DriverEvent => ({
        type: 'history',
        messages: Array.from({ length: count }, (_, i) => ({
          role: 'assistant' as const, blocks: [{ type: 'text' as const, text: foreign(`h${String(i)}`) }],
          at: '2026-10-19T10:00:00.000Z',
        })),
      });
      built.driver.queue.push(history(20));
      await flush();
      const old = await blockPrompt(built);
      let head = 0;
      manager.onEvent((scope, seq) => { if (scope === id && seq !== null) head = seq; });
      await manager.restart(id, { resend: old });
      await until(() => supervisor.closedShellTabs.length === 1);
      await flush();

      // `head` to ostatni numer NOWEJ karty. Porcja n wiadomości zajmuje n numerów i jedną ramkę `session-changed`,
      // a notka blokady bierze następny — więc n = old.seq − head − 2.
      const fresh = supervisor.driver(NEW_KEY);
      expect(head).toBeLessThan(old.seq - 2);
      fresh.queue.push(history(old.seq - head - 2));
      await flush();
      // Hook blokuje prompt i w nowym procesie: nowa notka i nowy przycisk.
      fresh.queue.push({
        type: 'prompt-blocked', reason: 'Sesja sprzed aktualizacji ustawień.', promptKept: false,
        echoed: true, decided: true, key: echoKey('Dopisz testy kontraktu'),
      });
      await flush();
      fresh.blockedLeftover = true;
      fresh.probe = { ...fresh.probe, composer: 'filled' };
      const now = manager.get(id)?.promptBlocked;
      // Warunek scenariusza: ten sam numer notki, inna blokada.
      expect(now?.seq).toBe(old.seq);
      expect(now?.id).not.toBe(old.id);

      // Spóźnione tapnięcie ze starego widoku: 409 przed rezerwacją, bez klawiszy, przycisk nowej notki zostaje.
      await expect(manager.restart(id, { resend: old })).rejects.toThrow(RESTART_RESEND_STALE_MESSAGE.text);
      expect(fresh.clears).toEqual([]);
      expect(fresh.exits).toBe(0);
      expect(supervisor.launches).toHaveLength(1);
      expect(manager.get(id)?.promptBlocked).toEqual(now);
      expect(fresh.sent).toEqual(['Dopisz testy kontraktu']);
    });

    it('restart z ponowną wysyłką na nowym wydaniu: teksty i notka z wydaniem, powód `prompt-blocked`', async () => {
      const built = await build();
      const blocked = await blockPrompt(built);
      await built.manager.restart(built.id, { resend: blocked });
      expect(built.supervisor.restartLog).toEqual([`${KEY} prompt-blocked 2.1.280 → 2.1.283`]);
      await until(() => built.supervisor.closedShellTabs.length === 1);
      expect(texts(built.manager, built.id).slice(-2))
        .toEqual(['Session restarted on Claude Code 2.1.283.', 'Dopisz testy kontraktu']);
    });
  });

  /*
   * Odczyt pola po turze dla wstrzymanych promptów trwa (`await` w driverze). Rezerwacja restartu, która
   * przyjdzie w jego trakcie, unieważnia go: bez flag w driverze i bez notki — panel zaraz dostanie `/exit`.
   */
  describe('odczyt pola po turze a rezerwacja restartu', () => {
    it('rezerwacja w trakcie odczytu: driver nie ustawia flag, manager nie dopisuje notki', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const built = await build({ overrides: { queueEcho: true } });
      const { manager, driver, id } = built;
      driver.queue.push({ type: 'agent-state', state: 'working', seen: false });
      await flush();
      await manager.sendMessage(id, 'w kolejce', undefined, undefined, 'cid-n2', { queueAware: true });
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: false });
      await flush();
      vi.advanceTimersByTime(10_500);
      await flush();
      vi.useRealTimers();
      const check = driver.heldCheck;
      if (check === null) throw new Error('brak odczytu pola po turze');
      expect(check.items.map((item) => item.text)).toEqual(['w kolejce']);

      const restarting = manager.restart(id);
      // Prawdziwy driver pyta `valid()` po odczycie, przed flagami — karta jest już zarezerwowana.
      expect(check.valid()).toBe(false);
      // Wynik i tak dochodzi (wyścig: driver zdążył przed rezerwacją) — manager sprawdza jeszcze raz.
      check.resolve(new Map(check.items.map((item) => [item.token, 'not-taken'] as const)));
      await expect(restarting).resolves.toEqual({ sessionId: id });
      await until(() => built.supervisor.closedShellTabs.length === 1);
      const texts = manager.transcript(id).messages.flatMap((m) => m.blocks)
        .flatMap((b) => (b.type === 'text' ? [b.text] : []));
      expect(texts).not.toContain(heldNotTakenText('w kolejce', SYSTEM).text);
    });
  });
});
