/**
 * Terminal PTY — backend PANELOWY (herdr) razem z rejestrem, na atrapach.
 *
 * Ani jednego panelu herdr, ani jednej binarki: proces kontrolera jest wstrzykiwany
 * (`PassThrough` jako stdin/stdout/stderr), a gniazdo herdr zastępuje fałszywy
 * `HerdrLaunchClient`. Inaczej nie da się w ogóle dotknąć rzeczy, o które w tym backendzie
 * chodzi: własnego respawnu przy drugim urządzeniu (który wygląda dokładnie jak obce
 * przejęcie), karencji kończącej się `terminal.release` i bramki `pane.close`.
 *
 * Żywy herdr sprawdza blok `RAROG_TEST_HERDR` w `term-integration.test.ts` — domyślnie
 * pominięty, bo zakłada i zamyka prawdziwy workspace.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { TERM_PROC_MAX_LENGTH } from '@rarog/shared';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { foreign, say } from '@rarog/shared/sentences';
import { loadConfig } from '../src/config.ts';
import type { RarogConfig } from '../src/config.ts';
import { HerdrUnavailableError } from '../src/herdr/socket.ts';
import { HerdrReadOnlyError } from '../src/herdr/types.ts';
import type {
  HerdrCreateTabParams, HerdrCreateWorkspaceParams, HerdrLaunchClient, HerdrPaneInfo,
  HerdrPaneLayout, HerdrPaneMetadataParams, HerdrPaneProcess, HerdrPaneProcessInfo,
  HerdrWorkspaceInfo,
} from '../src/herdr/types.ts';
import { HERDR_NAME_PREFIX, termPaneLabel } from '../src/herdr/provenance.ts';
import type { Logger } from '../src/router.ts';
import { errFrame } from '../src/term/backend.ts';
import type { TermBackend, TermSessionHandle } from '../src/term/backend.ts';
import {
  RAROG_TERM_METADATA_SOURCE, RAROG_TERM_TOKEN,
  TERM_HERDR_STATE_FILENAME,
  TERM_PROC_FALLBACK, TERM_PROC_TTL_MS, createHerdrBackend,
  termProcessLabel, termRestoreSize,
} from '../src/term/herdr-backend.ts';
import type { TermHerdrChild } from '../src/term/herdr-backend.ts';
import { reapIdleSessions } from '../src/term/index.ts';
import { termIdFor } from '../src/term/lifecycle.ts';
import { TERM_LAZYGIT_START_INPUT, TermRegistry } from '../src/term/registry.ts';
import type { TermClient } from '../src/term/registry.ts';

const CWD = '/Users/testowy/Projects/rarog';
const ID = termIdFor(CWD);
const HERDR_BIN = '/usr/bin/true';

const dataDirs: string[] = [];
afterEach(() => {
  while (dataDirs.length > 0) rmSync(dataDirs.pop() ?? '', { recursive: true, force: true });
});

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-term-herdr-'));
  dataDirs.push(dir);
  return dir;
}

function makeConfig(dataDir: string, env: NodeJS.ProcessEnv = {}): RarogConfig {
  return loadConfig({
    RAROG_ORIGINS: 'https://rarog.example',
    RAROG_TERM: '1',
    RAROG_TERM_BACKEND: 'herdr',
    RAROG_HERDR_BIN: HERDR_BIN,
    RAROG_HERDR_LAUNCH: '1',
    RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
    RAROG_DATA_DIR: dataDir,
    HOME: '/Users/testowy',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
    // Sekret Raroga w env serwera: sprawdzamy niżej, że NIE wchodzi do procesu kontrolera.
    SONIOX_API_KEY: 'sekret-nie-do-powloki',
    ...env,
  });
}

/** Ramka `terminal.frame` w kształcie herdr 0.8.2. */
function frameLine(text: string, full = false): string {
  return `${JSON.stringify({
    type: 'terminal.frame', seq: 1, full, width: 80, height: 24,
    encoding: 'ansi', bytes: Buffer.from(text, 'utf8').toString('base64'),
  })}\n`;
}

/** Atrapa procesu `herdr terminal session control` — strumienie prawdziwe, proces nie. */
class FakeController extends EventEmitter implements TermHerdrChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Linie NDJSON, które Rarog wysłał na stdin kontrolera. */
  readonly sent: Record<string, unknown>[] = [];
  killed = 0;
  exited = false;

  constructor() {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== '') this.sent.push(JSON.parse(line) as Record<string, unknown>);
        index = buffer.indexOf('\n');
      }
    });
  }

  kill(): void {
    this.killed += 1;
    this.exit(0);
  }

  /** Bajty ekranu z panelu. */
  frame(text: string, full = false): void { this.stdout.write(frameLine(text, full)); }

  /** Kontroler ogłasza koniec (`terminal.closed`) — SAM proces jeszcze żyje. */
  closed(reason: string): void {
    this.stdout.write(`${JSON.stringify({ type: 'terminal.closed', reason })}\n`);
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, null);
  }

  /** Ostatnia ramka danego typu — czytelniej niż indeksowanie `sent`. */
  last(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((frame) => frame['type'] === type);
  }
}

interface FakeHerdrOptions {
  panes?: HerdrPaneInfo[];
  /** Ile PIERWSZYCH `pane.list` ma paść — chwilowo martwe gniazdo herdr. */
  failList?: number;
  /** Czy `pane.report_metadata` ma paść (stempel świeżo założonego panelu). */
  failStamp?: boolean;
}

/**
 * Jak ma się zachować mutacja: `ok`; `error` — herdr odmówił (nic się nie stało);
 * `timeout` — transport padł PRZED skutkiem; `timeout-applied` — skutek JEST, zginęła odpowiedź
 * (ten przypadek, dla którego timeout znaczy „wynik nieznany"); `read-only` — bramka gniazda
 * (nieznany protokół) odbiła wywołanie, zanim cokolwiek poszło do herdr.
 */
type FakeOutcome = 'ok' | 'error' | 'timeout' | 'timeout-applied' | 'read-only';

/** Błąd mutacji wg {@link FakeOutcome} — klasy te same, które rzuca prawdziwe gniazdo. */
function outcomeError(outcome: Exclude<FakeOutcome, 'ok'>, method: string): Error {
  if (outcome === 'read-only') return new HerdrReadOnlyError(foreign('protokół herdr nieznany — tylko odczyt'));
  if (outcome === 'error') return new Error(`${method} odrzucone`);
  return new HerdrUnavailableError(foreign(`Przekroczony czas odpowiedzi herdr (${method}).`));
}

/** Fałszywe gniazdo herdr: notuje wszystko, co poszłoby do demona. */
class FakeHerdr implements HerdrLaunchClient {
  panes: HerdrPaneInfo[];
  /** Panele obecne WYŁĄCZNIE w `listPaneIds` — `pane.list` odsiał je jako niepełne. */
  hiddenPaneIds: string[] = [];
  readonly created: { workspaces: HerdrCreateWorkspaceParams[]; tabs: HerdrCreateTabParams[] } = {
    workspaces: [], tabs: [],
  };
  readonly stamped: HerdrPaneMetadataParams[] = [];
  readonly closedPanes: string[] = [];
  readonly closedTabs: string[] = [];
  listCalls = 0;
  listIdsCalls = 0;
  /** Mutacje, które herdr naprawdę WYKONAŁ (po odfiltrowaniu odmów i timeoutów przed skutkiem). */
  applied = 0;
  /** Wynik następnych `pane.report_metadata` (po `failStamp`) — patrz {@link FakeOutcome}. */
  stampOutcome: FakeOutcome = 'ok';
  /** Wynik następnych `pane.rename`. */
  renameOutcome: FakeOutcome = 'ok';
  /** Wynik następnych `pane.close`. */
  closeOutcome: FakeOutcome = 'ok';
  /** Wynik następnych `tab.rename` (migracja etykiet tabów). */
  tabRenameOutcome: FakeOutcome = 'ok';
  /**
   * Bieżące etykiety tabów (`tab.get`). Tab nieznany z `tab.create`/`tab.rename`/`workspace.create`
   * ani z testu ma etykietę „nazwaną ręcznie" — migracja etykiet takiego nie rusza.
   */
  readonly tabLabels = new Map<string, string>();
  /** Wywołania `tab.get` — odczyt etykiety przed migracją. */
  readonly tabReads: string[] = [];
  /**
   * Zapora `pane.list`: gdy ustawiona, odczyt czeka na nią — testy współbieżności trzymają nią
   * przebieg odzyskiwania „w locie".
   */
  listGate: Promise<void> | null = null;
  /**
   * Wołane przy KAŻDYM `pane.list` (z numerem wywołania, od 1) PRZED odpowiedzią — test zmienia
   * nim świat w środku przepływu (np. `dispose()` w trakcie odczytu pod mutexem).
   */
  onList: ((call: number) => void) | null = null;
  /** Wołane w `listPaneIds` PRZED odpowiedzią — zmiana panelu między dwoma odczytami inwentarza. */
  onListIds: (() => void) | null = null;
  /** Wołane po KAŻDYM stemplu — zmiana innego panelu w trakcie przebiegu odzyskiwania. */
  onStamp: (() => void) | null = null;
  private failList: number;
  private readonly failStamp: boolean;
  private tabsCreated = 0;

  constructor(opts: FakeHerdrOptions = {}) {
    this.panes = [...(opts.panes ?? [])];
    this.failList = opts.failList ?? 0;
    this.failStamp = opts.failStamp ?? false;
  }

  /** Ile NASTĘPNYCH `pane.list` ma paść — chwilowo martwe gniazdo w środku testu. */
  failNextList(count: number): void { this.failList = count; }

  async listPanes(): Promise<HerdrPaneInfo[]> {
    this.listCalls += 1;
    if (this.listGate !== null) await this.listGate;
    this.onList?.(this.listCalls);
    if (this.failList > 0) {
      this.failList -= 1;
      throw new Error('gniazdo herdr nie odpowiada');
    }
    return this.panes.map((pane) => ({ ...pane, tokens: { ...pane.tokens } }));
  }

  listPaneIds(): Promise<ReadonlySet<string>> {
    this.listIdsCalls += 1;
    this.onListIds?.();
    return Promise.resolve(new Set([...this.panes.map((pane) => pane.paneId), ...this.hiddenPaneIds]));
  }

  /**
   * Workspace'y znane z góry (`workspace.list`) — etykieta i ścieżka checkoutu. Workspace
   * panelu, którego tu nie ma, atrapa pokazuje z etykietą = nazwa katalogu jego pierwszego panelu
   * (tak nazywa projekt herdr i tak szuka go resolver); `workspace.create` dopisuje swój.
   */
  workspaces: HerdrWorkspaceInfo[] = [];
  listWorkspacesCalls = 0;

  listWorkspaces(): Promise<HerdrWorkspaceInfo[]> {
    this.listWorkspacesCalls += 1;
    const out = [...this.workspaces];
    for (const pane of this.panes) {
      if (!out.some((workspace) => workspace.workspaceId === pane.workspaceId)) {
        out.push({ workspaceId: pane.workspaceId, label: basename(pane.cwd) });
      }
    }
    return Promise.resolve(out);
  }

  /** Podmiana JEDNEGO panelu (adresy w atrapie bywają niepowtarzalne tylko z założenia testu). */
  private patch(paneId: string, change: Partial<HerdrPaneInfo>): void {
    this.panes = this.panes.map((pane) => (pane.paneId === paneId ? { ...pane, ...change } : pane));
  }

  /** Wywołania `pane.read` — historia terminala do zaznaczenia. */
  readonly historyReads: { paneId: string; lines: number }[] = [];
  /** Treść, którą fałszywe gniazdo odda jako historię, i flaga ucięcia. */
  history: { text: string; truncated: boolean } = { text: 'linia\n', truncated: false };

  readPaneHistory(paneId: string, lines: number): Promise<{ text: string; truncated: boolean }> {
    this.historyReads.push({ paneId, lines });
    return Promise.resolve(this.history);
  }

  /** Wywołania `pane.process_info` — nazwa procesu na etykietę taba. */
  readonly processReads: string[] = [];
  /** Co fałszywe gniazdo odda jako procesy pierwszego planu; `null` = odczyt PADA. */
  processes: readonly HerdrPaneProcess[] | null = [{ pid: 1, name: 'zsh', argv0: 'zsh' }];
  /**
   * Kolejne odpowiedzi `pane.process_info` PRZED {@link processes} — `Cmd+G` na zastanym panelu sprawdza go dwa razy,
   * a test „zmiana w międzyczasie" potrzebuje dwóch różnych odpowiedzi.
   */
  processQueue: (readonly HerdrPaneProcess[])[] = [];
  /** Wołane po KAŻDYM odczycie procesu — test zmienia nim świat między dwoma odczytami procesu. */
  afterProcessRead: (() => void) | null = null;

  readPaneProcess(paneId: string): Promise<HerdrPaneProcessInfo> {
    this.processReads.push(paneId);
    const queued = this.processQueue.shift();
    this.afterProcessRead?.();
    if (queued !== undefined) return Promise.resolve({ processes: queued });
    if (this.processes === null) {
      return Promise.reject(new Error('gniazdo herdr nie odpowiada na pane.process_info'));
    }
    return Promise.resolve({ processes: this.processes });
  }

  createWorkspace(params: HerdrCreateWorkspaceParams): Promise<{
    workspaceId: string; tabId: string; paneId: string;
  }> {
    this.created.workspaces.push(params);
    this.applied += 1;
    const pane: HerdrPaneInfo = {
      paneId: 'wNEW:p1', tabId: 'wNEW:t1', workspaceId: 'wNEW', cwd: params.cwd, tokens: {},
      label: null,
    };
    this.panes.push(pane);
    this.workspaces.push({ workspaceId: 'wNEW', label: params.label ?? basename(params.cwd) });
    // Jak herdr: etykieta z parametrów nazywa WORKSPACE, jego pierwszy tab dostaje „1".
    this.tabLabels.set(pane.tabId, '1');
    return Promise.resolve({ workspaceId: 'wNEW', tabId: 'wNEW:t1', paneId: pane.paneId });
  }

  createTab(params: HerdrCreateTabParams): Promise<{ tabId: string; paneId: string }> {
    this.created.tabs.push(params);
    this.applied += 1;
    this.tabsCreated += 1;
    // Pierwszy tab w workspace to `p9`/`t9` (na tym stoją starsze asercje), kolejne — unikalne.
    const suffix = this.tabsCreated === 1 ? '9' : `9-${String(this.tabsCreated)}`;
    const pane: HerdrPaneInfo = {
      paneId: `${params.workspaceId}:p${suffix}`,
      tabId: `${params.workspaceId}:t${suffix}`,
      workspaceId: params.workspaceId,
      cwd: params.cwd,
      tokens: {},
      label: null,
    };
    this.panes.push(pane);
    if (params.label !== undefined) this.tabLabels.set(pane.tabId, params.label);
    return Promise.resolve({ tabId: pane.tabId, paneId: pane.paneId });
  }

  startAgent(): Promise<{ argv: readonly string[] }> {
    return Promise.reject(new Error('terminal nie uruchamia agentów'));
  }

  reportPaneMetadata(params: HerdrPaneMetadataParams): Promise<void> {
    this.stamped.push(params);
    if (this.failStamp) return Promise.reject(new Error('pane.report_metadata odrzucone'));
    const outcome = this.stampOutcome;
    if (outcome === 'ok' || outcome === 'timeout-applied') {
      const pane = this.panes.find((candidate) => candidate.paneId === params.paneId);
      if (pane !== undefined) {
        this.applied += 1;
        // Jak herdr: `null` zdejmuje token, napis go stawia.
        const tokens: Record<string, string> = { ...pane.tokens };
        for (const [key, value] of Object.entries(params.tokens ?? {})) {
          if (value === null) delete tokens[key];
          else tokens[key] = value;
        }
        this.patch(params.paneId, { tokens });
      }
    }
    this.onStamp?.();
    return outcome === 'ok' ? Promise.resolve() : Promise.reject(outcomeError(outcome, 'pane.report_metadata'));
  }

  /** Etykiety: `pane.rename` zmienia panel jak w herdr, `tab.rename` tylko się notuje. */
  readonly renamed: { kind: 'pane' | 'tab'; id: string; label: string | null }[] = [];

  renamePane(paneId: string, label: string | null): Promise<void> {
    this.renamed.push({ kind: 'pane', id: paneId, label });
    const outcome = this.renameOutcome;
    if (outcome === 'ok' || outcome === 'timeout-applied') {
      this.applied += 1;
      this.patch(paneId, { label });
    }
    return outcome === 'ok' ? Promise.resolve() : Promise.reject(outcomeError(outcome, 'pane.rename'));
  }

  renameTab(tabId: string, label: string): Promise<void> {
    this.renamed.push({ kind: 'tab', id: tabId, label });
    const outcome = this.tabRenameOutcome;
    if (outcome === 'ok' || outcome === 'timeout-applied') {
      this.applied += 1;
      this.tabLabels.set(tabId, label);
    }
    return outcome === 'ok' ? Promise.resolve() : Promise.reject(outcomeError(outcome, 'tab.rename'));
  }

  /** Wołane w `tab.get` PRZED odpowiedzią — terminal przeniesiony w środku migracji. */
  onGetTab: (() => void) | null = null;

  getTab(tabId: string): Promise<{
    tabId: string; label: string; paneCount: number; workspaceId: string;
  }> {
    this.tabReads.push(tabId);
    this.onGetTab?.();
    const inTab = this.panes.filter((pane) => pane.tabId === tabId);
    return Promise.resolve({
      tabId,
      label: this.tabLabels.get(tabId) ?? 'nazwany ręcznie',
      paneCount: inTab.length,
      workspaceId: inTab[0]?.workspaceId ?? '',
    });
  }

  closeTab(tabId: string): Promise<void> {
    this.closedTabs.push(tabId);
    this.applied += 1;
    return Promise.resolve();
  }

  closePane(paneId: string): Promise<void> {
    const outcome = this.closeOutcome;
    if (outcome !== 'ok' && outcome !== 'timeout-applied') {
      return Promise.reject(outcomeError(outcome, 'pane.close'));
    }
    this.closedPanes.push(paneId);
    this.applied += 1;
    this.panes = this.panes.filter((pane) => pane.paneId !== paneId);
    return outcome === 'ok' ? Promise.resolve() : Promise.reject(outcomeError(outcome, 'pane.close'));
  }

  probeAgent(): Promise<never> {
    return Promise.reject(new Error('terminal nie sonduje agentów'));
  }

  /** Wywołania `pane.layout` — układ taba przed zwolnieniem po karencji. */
  readonly layoutReads: string[] = [];
  /**
   * `pane.layout`. Domyślnie atrapa tej metody NIE MA (jak klient launchera i nadzorcy) — dokłada ją
   * {@link answerLayout}.
   */
  readPaneLayout?: (paneId: string) => Promise<HerdrPaneLayout>;

  /** Odpowiedź `pane.layout`: układ, obietnica układu (zapora), błąd albo `'hang'` (gniazdo milczy). */
  answerLayout(answer: HerdrPaneLayout | Promise<HerdrPaneLayout> | Error | 'hang'): void {
    this.readPaneLayout = (paneId: string): Promise<HerdrPaneLayout> => {
      this.layoutReads.push(paneId);
      if (answer === 'hang') return new Promise<HerdrPaneLayout>(() => { /* cisza herdr */ });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    };
  }
}

/** Gniazdo WS wg kontraktu `TermClient` (kopia wzorca z `term-registry.test.ts`). */
class FakeClient implements TermClient {
  readonly data: string[] = [];
  readonly events: ({ t: 'exit' } | { t: 'err'; msg: string })[] = [];
  terminated = 0;
  buffered = 0;

  sendData(chunk: Buffer): void { this.data.push(chunk.toString('utf8')); }
  sendEvent(frame: { t: 'exit' } | { t: 'err'; msg: string }): void { this.events.push(frame); }
  bufferedAmount(): number { return this.buffered; }
  terminate(): void { this.terminated += 1; }
}

/** Timer karencji pod kontrolą testu (kopia wzorca z `term-registry.test.ts`). */
class FakeTimers {
  private cb: (() => void) | null = null;

  readonly set = (cb: () => void): NodeJS.Timeout => {
    this.cb = cb;
    return { unref: () => { /* atrapa */ } } as unknown as NodeJS.Timeout;
  };

  readonly clear = (): void => { this.cb = null; };

  get pending(): boolean { return this.cb !== null; }

  fire(): void {
    const cb = this.cb;
    this.cb = null;
    if (cb === null) throw new Error('karencja nie była uzbrojona');
    cb();
  }
}

/** Strumienie są prawdziwe, więc bajty docierają dopiero w następnej turze pętli. */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
};

async function waitUntil(what: string, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`nie doczekano: ${what}`);
}

interface Harness {
  registry: TermRegistry;
  backend: TermBackend;
  herdr: FakeHerdr;
  controllers: FakeController[];
  spawnArgs: string[][];
  spawnEnv: Record<string, string>[];
  timers: FakeTimers;
  logs: string[];
  dataDir: string;
  config: RarogConfig;
}

function makeHarness(opts: {
  panes?: HerdrPaneInfo[];
  env?: NodeJS.ProcessEnv;
  client?: () => HerdrLaunchClient | null;
  failList?: number;
  failStamp?: boolean;
  /** Zegar backendu — testy TTL cache'u nazw procesów przesuwają go ręcznie. */
  now?: () => number;
  /** Sufit odczytu układu przed zwolnieniem — test „gniazdo milczy" skraca go do milisekund. */
  restoreReadMs?: number;
} = {}): Harness {
  const dataDir = makeDataDir();
  const config = makeConfig(dataDir, opts.env);
  const logs: string[] = [];
  const logger: Logger = {
    info: (msg) => { logs.push(msg); },
    error: (msg) => { logs.push(msg); },
  };
  const herdr = new FakeHerdr({
    panes: opts.panes ?? [],
    failList: opts.failList ?? 0,
    failStamp: opts.failStamp ?? false,
  });
  const controllers: FakeController[] = [];
  const spawnArgs: string[][] = [];
  const spawnEnv: Record<string, string>[] = [];
  const timers = new FakeTimers();
  const backend = createHerdrBackend({
    config,
    logger,
    launchClient: opts.client ?? ((): HerdrLaunchClient => herdr),
    spawn: (_file, args, options) => {
      spawnArgs.push([...args]);
      spawnEnv.push(options.env);
      const controller = new FakeController();
      controllers.push(controller);
      return controller;
    },
    setTimer: timers.set,
    // Słowo maszyny w zdaniach odmów: Mac niezależnie od systemu, na którym idą testy.
    system: 'macos',
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.restoreReadMs === undefined ? {} : { restoreReadMs: opts.restoreReadMs }),
  });
  const registry = new TermRegistry({
    config,
    logger,
    backend,
    // Ścieżka jest ZMYŚLONA — prawdziwy `realpathSync` wywaliłby ją na ENOENT.
    realPath: (p) => p,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  return {
    registry, backend, herdr, controllers, spawnArgs, spawnEnv, timers, logs, dataDir, config,
  };
}

/** Panel człowieka w projekcie — workspace, w którym Rarog ma założyć swój tab. */
const HOST_PANE: HerdrPaneInfo = {
  paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', cwd: CWD, tokens: {}, label: null,
};

/** Panel terminala Raroga (już ostemplowany). */
const OWN_PANE: HerdrPaneInfo = {
  paneId: 'w1:p9', tabId: 'w1:t9', workspaceId: 'w1', cwd: CWD,
  tokens: { [RAROG_TERM_TOKEN]: ID }, label: null,
};

// ---------------------------------------------------------------------------
// Killswitche — odmowa PRZED wpisem do rejestru
// ---------------------------------------------------------------------------

describe('killswitche herdr obejmują terminal panelowy', () => {
  it('`RAROG_HERDR_LAUNCH=0` → odmowa `herdr-launch-off`, zero ruchu do gniazda', () => {
    const h = makeHarness({ env: { RAROG_HERDR_LAUNCH: '0' } });
    const opened = h.registry.open(CWD);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error).toBe('herdr-launch-off');
      expect(opened.sentence.text).toContain('RAROG_HERDR_LAUNCH');
    }
    expect(h.herdr.listCalls).toBe(0);
  });

  it('`RAROG_HERDR_SEND=0` → odmowa `herdr-send-off` (panelu nie da się ani założyć, ani ostemplować)', () => {
    const h = makeHarness({ env: { RAROG_HERDR_SEND: '0' } });
    const opened = h.registry.open(CWD);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error).toBe('herdr-send-off');
    expect(h.herdr.listCalls).toBe(0);
  });

  it('z oboma włączonymi terminal się otwiera', () => {
    const h = makeHarness();
    expect(h.registry.open(CWD).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Zakładanie i odnajdywanie panelu
// ---------------------------------------------------------------------------

describe('ensureSession — panel po tokenie, tab w istniejącym workspace, workspace na ostatek', () => {
  it('zakłada TAB w workspace o tym katalogu i stempluje go tokenem terminala', async () => {
    const h = makeHarness({ panes: [HOST_PANE] });
    const opened = h.registry.open(CWD);
    expect(opened.ok).toBe(true);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('spawn kontrolera', () => h.controllers.length === 1);

    expect(h.herdr.created.tabs).toHaveLength(1);
    expect(h.herdr.created.tabs[0]?.workspaceId).toBe('w1');
    expect(h.herdr.created.workspaces).toHaveLength(0);
    // Token jest WARUNKIEM własności: bez niego panel nie przejdzie ani bramki `pane.close`,
    // ani adopcji po restarcie.
    expect(h.herdr.stamped[0]?.tokens).toEqual({ [RAROG_TERM_TOKEN]: ID });
    h.registry.dispose();
  });

  it('powłoka panelu dostaje ZNACZNIK `RAROG_TERM_PANE=1` i nic poza nim', async () => {
    /*
     * Znacznik istnieje po to, żeby konfiguracja powłoki mogła zachować się inaczej na
     * telefonie niż przy biurku — powód zmierzony: prompt dociągnięty do prawej
     * krawędzi zostawia kopię przy każdym zwężeniu panelu, a Rarog nie ma jak tego zwężenia
     * uniknąć. Rarog NICZEGO nie narzuca: oddaje jedną, jawną informację.
     *
     * „I nic poza nim" jest tu ASERCJĄ, nie ozdobą: ten kanał idzie prosto do cudzej powłoki,
     * więc ma nieść znacznik, a nigdy niczego z env Raroga (`docs/security-model.md` punkt 6).
     */
    const h = makeHarness({ panes: [HOST_PANE] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('spawn kontrolera', () => h.controllers.length === 1);

    expect(h.herdr.created.tabs[0]?.env).toEqual({ RAROG_TERM_PANE: '1' });
    h.registry.dispose();
  });

  it('bez workspace o tym katalogu zakłada workspace z etykietą = nazwa katalogu', async () => {
    const h = makeHarness({ panes: [] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('spawn kontrolera', () => h.controllers.length === 1);
    expect(h.herdr.created.workspaces)
      .toEqual([{ cwd: CWD, label: 'rarog', env: { RAROG_TERM_PANE: '1' } }]);
    h.registry.dispose();
  });

  /*
   * Dopasowanie po TOKENIE, nie po `cwd`: token niesie `sha256(realpath(cwd))`, a `pane.list`
   * oddaje BIEŻĄCY katalog powłoki. Bez tej reguły pierwsze `cd` w terminalu kazałoby Rarogowi
   * założyć drugi panel dla tego samego terminala.
   */
  it('odnajduje własny panel po tokenie, choć powłoka zdążyła zmienić katalog', async () => {
    const moved: HerdrPaneInfo = { ...OWN_PANE, cwd: '/Users/testowy/gdzie-indziej' };
    const h = makeHarness({ panes: [moved] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('spawn kontrolera', () => h.controllers.length === 1);
    expect(h.herdr.created.tabs).toHaveLength(0);
    expect(h.herdr.created.workspaces).toHaveLength(0);
    expect(h.spawnArgs[0]).toEqual([
      'terminal', 'session', 'control', moved.paneId, '--takeover', '--cols', '80', '--rows', '24',
    ]);
    h.registry.dispose();
  });

  /*
   * TTL to OPCJA herdr, nie wymóg. Token bez `ttl_ms` trwa do zastąpienia, zdjęcia albo
   * zamknięcia panelu — żaden stempel terminala nie niesie terminu ważności.
   */
  it('odświeża token przy każdym odnalezieniu — BEZ terminu ważności', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('spawn kontrolera', () => h.controllers.length === 1);
    // DWA stemple, bo dwa różne momenty: `ensureSession` (odnalezienie) i `attach` (podpięcie).
    expect(h.herdr.stamped).toHaveLength(2);
    expect(h.herdr.stamped.every((stamp) => stamp.ttlMs === undefined)).toBe(true);
    h.registry.dispose();
  });

  /*
   * Stempel przy KAŻDYM podpięciu jest tanim, idempotentnym raportem na panelu, który bramka
   * przed spawnem uznała za nasz.
   */
  it('każde podpięcie odświeża token panelu, nie tylko POST', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('kontroler 1', () => h.controllers.length === 1);
    const poPierwszym = h.herdr.stamped.length;

    // Drugie gniazdo = planowy respawn kontrolera, czyli kolejny `attach` na tym samym panelu.
    h.registry.attach(ID, new FakeClient());
    await waitUntil('kontroler 2', () => h.controllers.length === 2);
    expect(h.herdr.stamped.length).toBe(poPierwszym + 1);
    expect(h.herdr.stamped.at(-1)).toEqual({
      paneId: OWN_PANE.paneId,
      source: RAROG_TERM_METADATA_SOURCE,
      tokens: { [RAROG_TERM_TOKEN]: ID },
    });
    h.registry.dispose();
  });

  /*
   * Panel BEZ tokenu jest dla Raroga niewidzialny: nie adoptuje go, nie tknie żniwiarz i nie
   * zamknie `DELETE` (bramka własności). Nieudany stempel PO udanym `tab.create` zostawiałby
   * więc pusty tab na Macu, a każdy następny POST zakładał kolejny.
   */
  it('nieudany stempel zamyka świeżo założony tab i przerywa zakładanie', async () => {
    const h = makeHarness({ panes: [HOST_PANE], failStamp: true });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('sprzątanie sieroty', () => h.herdr.closedTabs.length === 1);
    expect(h.herdr.created.tabs).toHaveLength(1);
    expect(h.herdr.closedTabs).toEqual(['w1:t9']);
    // Kontroler nie wstał: uchwyt padł, więc nie ma czego przejmować.
    expect(h.controllers).toHaveLength(0);
    h.registry.dispose();
  });

  it('do procesu kontrolera wchodzą TRZY zmienne, bez sekretów Raroga', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('spawn kontrolera', () => h.controllers.length === 1);
    expect(Object.keys(h.spawnEnv[0] ?? {}).sort()).toEqual(['HOME', 'PATH', 'TMPDIR']);
    expect(JSON.stringify(h.spawnEnv[0])).not.toContain('sekret-nie-do-powloki');
    h.registry.dispose();
  });
});

// ---------------------------------------------------------------------------
// Strumień: ramki, wejście, przewijanie
// ---------------------------------------------------------------------------

describe('strumień kontrolera', () => {
  async function attached(): Promise<{ h: Harness; client: FakeClient; ctl: FakeController }> {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    const client = new FakeClient();
    h.registry.attach(ID, client);
    await waitUntil('spawn kontrolera', () => h.controllers.length === 1);
    const ctl = h.controllers[0];
    if (ctl === undefined) throw new Error('brak kontrolera');
    return { h, client, ctl };
  }

  it('ramki z panelu lecą do gniazda jako surowe bajty', async () => {
    const { h, client, ctl } = await attached();
    ctl.frame('zażółć gęślą jaźń', true);
    await flush();
    expect(client.data).toEqual(['zażółć gęślą jaźń']);
    h.registry.dispose();
  });

  it('wejście i zmiana rozmiaru jadą NDJSON-em na stdin', async () => {
    const { h, ctl } = await attached();
    h.registry.write(ID, 'ls\r');
    h.registry.resize(ID, 100, 40);
    await flush();
    expect(ctl.sent).toContainEqual({ type: 'terminal.input', text: 'ls\r' });
    expect(ctl.sent).toContainEqual({ type: 'terminal.resize', cols: 100, rows: 40 });
    h.registry.dispose();
  });

  /*
   * Znak `d` w ramce `sc` jest jedyną informacją o KIERUNKU: ujemny to „w górę", czyli
   * w historię panelu. `source: 'wheel'` odpowiada gestowi palca (zmierzone).
   */
  it('`sc` mapuje się na `terminal.scroll`: ujemne w górę, dodatnie w dół, zero milczy',
    async () => {
      const { h, ctl } = await attached();
      const scrolls = (): Record<string, unknown>[] =>
        ctl.sent.filter((frame) => frame['type'] === 'terminal.scroll');

      // Osobne okna sklejania (powód niżej), więc każdy kierunek jedzie własnym oknem. Okno
      // ≤ 8 wierszy rozbija się na wywołania po JEDNYM wierszu (powód przy
      // `HERDR_SCROLL_CALLS_PER_TICK`): suma dla powłoki ta sama, tyknięcia dla myszy — tyle,
      // ile wierszy.
      h.registry.scroll(ID, -3);
      await waitUntil('okno w górę', () => scrolls().length === 3);
      h.registry.scroll(ID, 5);
      await waitUntil('okno w dół', () => scrolls().length === 8);
      h.registry.scroll(ID, 0);
      await flush();

      const up = { type: 'terminal.scroll', direction: 'up', lines: 1, source: 'wheel' };
      const down = { type: 'terminal.scroll', direction: 'down', lines: 1, source: 'wheel' };
      expect(scrolls()).toEqual([up, up, up, down, down, down, down, down]);
      h.registry.dispose();
    });

  /*
   * Komórka pod palcem: `column`/`row` w `terminal.scroll` mówią herdr, POD KTÓRYM
   * panelem aplikacji stoi gest — lazygit przewija diff pod palcem, nie panel z fokusem (bez
   * adresu kółko w aplikacji z panelami nie robiło nic — zmierzone na żywym panelu). Sklejanie
   * bierze OSTATNIĄ komórkę okna, a ramka bez adresu nie wymyśla współrzędnych.
   */
  it('`sc` z komórką pod palcem dokłada `column`/`row`; sklejanie bierze ostatnią', async () => {
    const { h, ctl } = await attached();
    const scrolls = (): Record<string, unknown>[] =>
      ctl.sent.filter((frame) => frame['type'] === 'terminal.scroll');

    h.registry.scroll(ID, -2, { col: 70, row: 5 });
    h.registry.scroll(ID, -3, { col: 75, row: 10 });
    await waitUntil('okno z adresem', () => scrolls().length === 5);
    h.registry.scroll(ID, 4);
    await waitUntil('okno bez adresu', () => scrolls().length === 9);
    await flush();

    // Każde wywołanie okna niesie TĘ SAMĄ (ostatnią) komórkę — gest jest jeden.
    const up = { type: 'terminal.scroll', direction: 'up', lines: 1, source: 'wheel', column: 75, row: 10 };
    const down = { type: 'terminal.scroll', direction: 'down', lines: 1, source: 'wheel' };
    expect(scrolls()).toEqual([up, up, up, up, up, down, down, down, down]);
    h.registry.dispose();
  });

  /*
   * Ramka `sc` ma limit AMPLITUDY (zod ±200), nie miała żadnego limitu CZĘSTOTLIWOŚCI — a każda
   * linia NDJSON na stdin kontrolera to RPC do demona herdr, czyli do control-plane'u WSZYSTKICH
   * paneli użytkownika. Uczciwy klient wysyła ~60 ramek/s, uwierzytelniony zapętlony potrafił
   * tyle, ile przyjmie gniazdo WS.
   */
  it('ramki `sc` z jednego okna sklejają się: suma wierszy w ≤ 8 wywołaniach', async () => {
    const { h, ctl } = await attached();
    for (let i = 0; i < 20; i += 1) h.registry.scroll(ID, -10);
    await waitUntil(
      'sklejone okno', () => ctl.sent.some((frame) => frame['type'] === 'terminal.scroll'),
    );
    await flush();
    const scrolls = ctl.sent.filter((frame) => frame['type'] === 'terminal.scroll');
    /*
     * 200 wierszy z 20 ramek = JEDNO okno, ale `HERDR_SCROLL_CALLS_PER_TICK` = 8 wywołań, nie
     * jedno (w aplikacji z myszą herdr robi z jednego wywołania jedno tyknięcie kółka, więc
     * lazygit dostawałby 2 wiersze na klatkę). Pierwsze wywołanie niesie nadwyżkę, reszta po
     * wierszu; suma = 200, czyli scrollback powłoki przewija się o całe okno.
     * Sufit CZĘSTOTLIWOŚCI zostaje sufitem: 8 RPC na 16 ms, nie 20.
     */
    const one = { type: 'terminal.scroll', direction: 'up', lines: 1, source: 'wheel' };
    expect(scrolls).toEqual([
      { type: 'terminal.scroll', direction: 'up', lines: 193, source: 'wheel' },
      one, one, one, one, one, one, one,
    ]);
    expect(scrolls.reduce((sum, frame) => sum + (frame['lines'] as number), 0)).toBe(200);
    h.registry.dispose();
  });

  it('reszta zebrana w oknie sklejania jedzie PRZED `terminal.release`', async () => {
    const { h, client, ctl } = await attached();
    h.registry.scroll(ID, -7);
    // Zwolnienie strumienia w TYM SAMYM oknie co gest — bez domknięcia wiersze by zniknęły.
    h.registry.detach(ID, client);
    h.timers.fire();
    await flush();
    const types = ctl.sent.map((frame) => frame['type']);
    // 7 wierszy = 7 wywołań (rozbicie okna), wszystkie PRZED zwolnieniem.
    expect(types).toEqual([...Array<string>(7).fill('terminal.scroll'), 'terminal.release']);
    h.registry.dispose();
  });

  it('backpressure wstrzymuje CZYTANIE ze stdout kontrolera', async () => {
    const { h, client, ctl } = await attached();
    client.buffered = 512 * 1024;
    h.registry.reviewBackpressure(ID);
    await flush();
    expect(ctl.stdout.isPaused()).toBe(true);
    h.registry.dispose();
  });
});

// ---------------------------------------------------------------------------
// Jeden kontroler na panel: własny respawn kontra obce przejęcie
// ---------------------------------------------------------------------------

describe('drugie gniazdo respawnuje kontrolera, a to NIE jest obce przejęcie', () => {
  it('nowe gniazdo = nowy kontroler z rozmiarem tego gniazda, stary zwalniany przez release',
    async () => {
      const h = makeHarness({ panes: [OWN_PANE] });
      h.registry.open(CWD);
      const pierwszy = new FakeClient();
      h.registry.attach(ID, pierwszy);
      await waitUntil('kontroler 1', () => h.controllers.length === 1);
      h.registry.resize(ID, 120, 50);

      const drugi = new FakeClient();
      expect(h.registry.attach(ID, drugi)).toBe('ok');
      await waitUntil('kontroler 2', () => h.controllers.length === 2);
      await flush();

      // Stary kontroler dostał uprzejme pożegnanie...
      expect(h.controllers[0]?.last('terminal.release')).toEqual({ type: 'terminal.release' });
      // ...a nowy wstał z rozmiarem OSTATNIEGO gniazda (odpowiednik tmuxowego `latest`).
      expect(h.spawnArgs[1]).toEqual([
        'terminal', 'session', 'control', OWN_PANE.paneId, '--takeover',
        '--cols', '120', '--rows', '50',
      ]);
      h.registry.dispose();
    });

  /*
   * Bloker: nasz WŁASNY respawn wygląda dokładnie jak obce przejęcie (to my wyrzucamy własnego
   * kontrolera przez `--takeover`, więc stary dostaje `terminal.closed: taken over`). Gdyby
   * rejestr patrzył na powód przed swoją rezerwacją `plannedKill`, KAŻDE drugie urządzenie
   * kładłoby terminal w `failed`.
   */
  it('`taken over` od WŁASNEGO, planowo zwolnionego kontrolera nie kładzie terminala',
    async () => {
      const h = makeHarness({ panes: [OWN_PANE] });
      h.registry.open(CWD);
      const pierwszy = new FakeClient();
      h.registry.attach(ID, pierwszy);
      await waitUntil('kontroler 1', () => h.controllers.length === 1);

      const drugi = new FakeClient();
      h.registry.attach(ID, drugi);
      await waitUntil('kontroler 2', () => h.controllers.length === 2);
      await flush();

      // Stary kontroler ogłasza przejęcie i ginie — tak zachowuje się herdr przy `--takeover`.
      h.controllers[0]?.closed('terminal taken over by another controller');
      h.controllers[0]?.exit(0);
      await flush();

      expect(pierwszy.events).toEqual([]);
      expect(drugi.events).toEqual([]);
      // Terminal ŻYJE: kolejne gniazdo dalej wchodzi, a wpis nie jest w `failed`.
      expect(h.registry.attach(ID, new FakeClient())).toBe('ok');
      h.registry.dispose();
    });

  /*
   * Żniwiarz pyta backend „czy panel ma klienta". Stary kontroler kończy się PO starcie nowego,
   * więc gdyby sprzątał wpis panelu, a nie swój własny, panel z żywym kontrolerem wyglądałby
   * na porzucony i po `RAROG_TERM_IDLE_DAYS` poszedłby pod `pane.close`.
   */
  it('po respawnie panel dalej jest `attached` — stary kontroler sprząta tylko po sobie',
    async () => {
      const h = makeHarness({ panes: [OWN_PANE] });
      h.registry.open(CWD);
      h.registry.attach(ID, new FakeClient());
      await waitUntil('kontroler 1', () => h.controllers.length === 1);
      h.registry.attach(ID, new FakeClient());
      await waitUntil('kontroler 2', () => h.controllers.length === 2);
      await flush();
      h.controllers[0]?.exit(0);
      await flush();

      const sessions = await h.backend.listSessions();
      expect(sessions[0]?.attached).toBe(true);
      h.registry.dispose();
    });

  it('OBCE `taken over` → ramka `err` i `failed` bez ani jednego respawnu', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    const client = new FakeClient();
    h.registry.attach(ID, client);
    await waitUntil('kontroler 1', () => h.controllers.length === 1);

    h.controllers[0]?.closed('stream taken over');
    await flush();

    // Zdanie z kodem: tekst angielski z rejestru i `msgRef`, apka składa zdanie w swoim języku.
    expect(client.events).toEqual([
      { t: 'err', msg: 'The terminal was taken over. Open it again.', msgRef: { code: 'term.taken-over' } },
    ]);
    // Bez respawnu: dwa Rarogi biłyby się o panel w pętli.
    expect(h.controllers).toHaveLength(1);
    expect(h.registry.attach(ID, new FakeClient())).toBe('failed');
    h.registry.dispose();
  });

  it('zwykły koniec kontrolera (nie przejęcie) idzie normalną ścieżką padu — ramka `exit`',
    async () => {
      const h = makeHarness({ panes: [OWN_PANE] });
      h.registry.open(CWD);
      const client = new FakeClient();
      h.registry.attach(ID, client);
      await waitUntil('kontroler 1', () => h.controllers.length === 1);

      h.controllers[0]?.exit(1);
      await flush();
      expect(client.events).toEqual([{ t: 'exit' }]);
      h.registry.dispose();
    });
});

// ---------------------------------------------------------------------------
// Karencja, adopcja, żniwa, zamykanie
// ---------------------------------------------------------------------------

describe('karencja kończy się `terminal.release`, a panel żyje dalej', () => {
  it('ostatnie gniazdo odpada → po karencji release, bez `pane.close`', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    const client = new FakeClient();
    h.registry.attach(ID, client);
    await waitUntil('kontroler', () => h.controllers.length === 1);

    h.registry.detach(ID, client);
    expect(h.timers.pending).toBe(true);
    h.timers.fire();
    await flush();

    expect(h.controllers[0]?.last('terminal.release')).toEqual({ type: 'terminal.release' });
    // Panel ZOSTAJE — o to w trwałości chodzi.
    expect(h.herdr.closedPanes).toEqual([]);
    h.registry.dispose();
  });
});

/*
 * The controller sets the pane's pty to the phone size, and herdr does NOT recompute the size after
 * `terminal.release`: the pty would stay 62×29 until a herdr client looks at the tab, and a CLI dialog
 * taller than the pane would lose its header. Release after the grace period therefore gives the pane
 * its size from the tab layout (`pane.layout`) BEFORE `terminal.release`; every other release path
 * and every error releases without it.
 */
describe('przywrócenie rozmiaru panelu przed `terminal.release`', () => {
  /** Układ taba jednopanelowego — kształt z żywego herdr 0.9.5 po fasadzie klienta. */
  const solo = (width = 128, height = 52, paneId = OWN_PANE.paneId): HerdrPaneLayout => ({
    panes: [{ paneId, width, height }],
  });

  /** Terminal otwarty z telefonu (62×29 — rozmiar z incydentu rarog 10:17Z). */
  async function phoneAttached(h: Harness): Promise<FakeClient> {
    h.registry.open(CWD);
    const client = new FakeClient();
    h.registry.attach(ID, client, false, { cols: 62, rows: 29 });
    await waitUntil('kontroler', () => h.controllers.length === 1);
    return client;
  }

  const released = (ctl: FakeController | undefined): boolean =>
    ctl?.last('terminal.release') !== undefined;

  it('wzór herdr: prostokąt minus rynna paska; split, obcy panel i wymiary spoza zakresu to powód', () => {
    // Zmierzone na świeżym panelu: prostokąt 128×52 → pty 127×52 (`stty -f`).
    expect(termRestoreSize(solo(), OWN_PANE.paneId)).toEqual({ cols: 127, rows: 52 });
    // Rynny nie ma przy szerokości ≤ 4 (`terminal_inner_rect_for`).
    expect(termRestoreSize(solo(4, 3), OWN_PANE.paneId)).toEqual({ cols: 4, rows: 3 });
    expect(termRestoreSize(solo(5, 3), OWN_PANE.paneId)).toEqual({ cols: 4, rows: 3 });
    const split: HerdrPaneLayout = {
      panes: [...solo(64).panes, { paneId: 'w1:p10', width: 63, height: 52 }],
    };
    expect(termRestoreSize(split, OWN_PANE.paneId)).toBe('tab with 2 panes');
    expect(termRestoreSize({ panes: [] }, OWN_PANE.paneId)).toBe('tab with 0 panes');
    expect(termRestoreSize(solo(128, 52, 'w1:p1'), OWN_PANE.paneId)).toBe('layout does not describe this pane');
    // Obszar zerowy (herdr bez żadnego widoku) i wymiary ponad zakres ramki `rs`.
    expect(termRestoreSize(solo(0, 0), OWN_PANE.paneId)).toMatch(/out of range/);
    expect(termRestoreSize(solo(128, 0), OWN_PANE.paneId)).toMatch(/out of range/);
    expect(termRestoreSize(solo(1002, 52), OWN_PANE.paneId)).toMatch(/out of range/);
    expect(termRestoreSize(solo(128, 1001), OWN_PANE.paneId)).toMatch(/out of range/);
  });

  it('karencja: NAJPIERW `terminal.resize` na rozmiar z układu, POTEM `terminal.release`', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.herdr.answerLayout(solo());
    const client = await phoneAttached(h);
    expect(h.spawnArgs[0]?.slice(-4)).toEqual(['--cols', '62', '--rows', '29']);

    h.registry.detach(ID, client);
    // Samo odejście gniazda niczego nie przywraca — karencja trzyma kontroler (TERM_GRACE_MS).
    await flush();
    expect(h.herdr.layoutReads).toEqual([]);
    h.timers.fire();
    await waitUntil('release', () => released(h.controllers[0]));

    expect(h.controllers[0]?.sent).toEqual([
      { type: 'terminal.resize', cols: 127, rows: 52 },
      { type: 'terminal.release' },
    ]);
    expect(h.herdr.layoutReads).toEqual([OWN_PANE.paneId]);
    expect(h.logs).toContain(`term: pane ${OWN_PANE.paneId} back to 127×52 before release`);
    h.registry.dispose();
  });

  it('błąd odczytu, split i klient bez `pane.layout` — release i tak idzie, bez resize, z linią logu',
    async () => {
      const cases: { answer: HerdrPaneLayout | Error | null; reason: RegExp }[] = [
        { answer: new HerdrUnavailableError(foreign('Przekroczony czas odpowiedzi herdr (pane.layout).')), reason: /layout read failed/ },
        { answer: { panes: [...solo(64).panes, { paneId: 'w1:p10', width: 63, height: 52 }] }, reason: /tab with 2 panes/ },
        { answer: null, reason: /herdr client without `pane\.layout`/ },
      ];
      for (const { answer, reason } of cases) {
        const h = makeHarness({ panes: [OWN_PANE] });
        if (answer !== null) h.herdr.answerLayout(answer);
        const client = await phoneAttached(h);
        h.registry.detach(ID, client);
        h.timers.fire();
        await waitUntil('release', () => released(h.controllers[0]));
        expect(h.controllers[0]?.sent, String(reason)).toEqual([{ type: 'terminal.release' }]);
        const line = h.logs.find((log) => log.includes('size not restored'));
        expect(line, String(reason)).toMatch(reason);
        expect(line).toMatch(/plain release/);
        h.registry.dispose();
      }
    });

  it('herdr milczy — release po suficie odczytu, bez resize (zwolnienie nigdy nie stoi)', async () => {
    const h = makeHarness({ panes: [OWN_PANE], restoreReadMs: 20 });
    h.herdr.answerLayout('hang');
    const client = await phoneAttached(h);
    h.registry.detach(ID, client);
    h.timers.fire();
    await flush();
    expect(released(h.controllers[0])).toBe(false);
    await waitUntil('release po suficie', () => released(h.controllers[0]));
    expect(h.controllers[0]?.sent).toEqual([{ type: 'terminal.release' }]);
    expect(h.logs.some((log) => log.includes('layout read timed out after 20 ms'))).toBe(true);
    h.registry.dispose();
  });

  it('układ spóźniony za sufit: bez późnego `terminal.resize` i bez drugiego `terminal.release`',
    async () => {
      const h = makeHarness({ panes: [OWN_PANE], restoreReadMs: 20 });
      let answer: (layout: HerdrPaneLayout) => void = () => { /* ustawi zapora */ };
      h.herdr.answerLayout(new Promise<HerdrPaneLayout>((resolve) => { answer = resolve; }));
      const client = await phoneAttached(h);
      h.registry.detach(ID, client);
      h.timers.fire();
      await waitUntil('release po suficie', () => released(h.controllers[0]));
      answer(solo());
      await flush();
      await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
      expect(h.controllers[0]?.sent).toEqual([{ type: 'terminal.release' }]);
      h.registry.dispose();
    });

  it('OBCE przejęcie w trakcie odczytu: bez resize, release i tak idzie', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    let answer: (layout: HerdrPaneLayout) => void = () => { /* ustawi zapora */ };
    h.herdr.answerLayout(new Promise<HerdrPaneLayout>((resolve) => { answer = resolve; }));
    const client = await phoneAttached(h);
    h.registry.detach(ID, client);
    h.timers.fire();
    await waitUntil('odczyt układu w locie', () => h.herdr.layoutReads.length === 1);

    // Inny klient herdr wchodzi z `--takeover`: nasz kontroler dostaje `terminal.closed` i ginie.
    h.controllers[0]?.closed('terminal attach taken over');
    h.controllers[0]?.exit(0);
    await flush();
    answer(solo());
    await waitUntil('release', () => released(h.controllers[0]));

    expect(h.controllers[0]?.sent).toEqual([{ type: 'terminal.release' }]);
    expect(h.logs).toContain(
      `term: pane ${OWN_PANE.paneId} size not restored (controller is no longer the last one)`,
    );
    // Zwolnienie było planowe (karencja) — przejęcie po nim nie kładzie terminala w `failed`.
    expect(h.registry.attach(ID, new FakeClient())).toBe('ok');
    h.registry.dispose();
  });

  it('respawn pod drugie urządzenie: stary kontroler BEZ resize i bez odczytu; przywraca tylko ostatni',
    async () => {
      const h = makeHarness({ panes: [OWN_PANE] });
      h.herdr.answerLayout(solo());
      const telefon = await phoneAttached(h);
      const ipad = new FakeClient();
      h.registry.attach(ID, ipad, false, { cols: 100, rows: 40 });
      await waitUntil('kontroler 2', () => h.controllers.length === 2);
      await waitUntil('release starego', () => released(h.controllers[0]));
      // Następca wstaje z rozmiarem urządzenia — przywrócenie byłoby parą zbędnych SIGWINCH.
      expect(h.controllers[0]?.sent).toEqual([{ type: 'terminal.release' }]);
      expect(h.herdr.layoutReads).toEqual([]);
      expect(h.spawnArgs[1]?.slice(-4)).toEqual(['--cols', '100', '--rows', '40']);

      // Odejście JEDNEGO z dwóch gniazd nie uzbraja karencji — kontroler zostaje drugiemu.
      // (Slot atrapy zegara trzyma tu dobicie STAREGO kontrolera, więc pytamy o logi, nie o slot.)
      h.registry.detach(ID, telefon);
      await flush();
      expect(h.logs.filter((log) => log.includes('grace period over'))).toEqual([]);
      expect(released(h.controllers[1])).toBe(false);
      h.registry.detach(ID, ipad);
      h.timers.fire();
      await waitUntil('release ostatniego', () => released(h.controllers[1]));
      expect(h.controllers[1]?.sent).toEqual([
        { type: 'terminal.resize', cols: 127, rows: 52 },
        { type: 'terminal.release' },
      ]);
      expect(h.herdr.layoutReads).toEqual([OWN_PANE.paneId]);
      h.registry.dispose();
    });

  it('nowe gniazdo W TRAKCIE odczytu: następca nie dostaje przywrócenia, stary — sam release', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    let answer: (layout: HerdrPaneLayout) => void = () => { /* ustawi zapora */ };
    h.herdr.answerLayout(new Promise<HerdrPaneLayout>((resolve) => { answer = resolve; }));
    const client = await phoneAttached(h);
    h.registry.detach(ID, client);
    h.timers.fire();
    await waitUntil('odczyt układu w locie', () => h.herdr.layoutReads.length === 1);

    // Człowiek wraca do terminala, zanim herdr odpowie — rejestr podpina świeży kontroler.
    h.registry.attach(ID, new FakeClient(), true, { cols: 62, rows: 29 });
    await waitUntil('następca', () => h.controllers.length === 2);
    answer(solo());
    await waitUntil('release starego', () => released(h.controllers[0]));

    expect(h.controllers[0]?.sent).toEqual([{ type: 'terminal.release' }]);
    expect(h.controllers[1]?.sent.filter((frame) => frame['type'] === 'terminal.resize')).toEqual([]);
    expect(h.spawnArgs[1]?.slice(-4)).toEqual(['--cols', '62', '--rows', '29']);
    expect(h.logs).toContain(
      `term: pane ${OWN_PANE.paneId} size not restored (controller is no longer the last one)`,
    );
    h.registry.dispose();
  });

  it('zamknięcie terminala i zamknięcie serwera zwalniają bez przywrócenia i bez odczytu', async () => {
    const zamkniecie = makeHarness({ panes: [OWN_PANE] });
    zamkniecie.herdr.answerLayout(solo());
    await phoneAttached(zamkniecie);
    zamkniecie.registry.close(ID);
    await waitUntil('release', () => released(zamkniecie.controllers[0]));
    expect(zamkniecie.controllers[0]?.sent).toEqual([{ type: 'terminal.release' }]);

    const serwer = makeHarness({ panes: [OWN_PANE] });
    serwer.herdr.answerLayout(solo());
    await phoneAttached(serwer);
    serwer.registry.dispose();
    await waitUntil('release', () => released(serwer.controllers[0]));
    expect(serwer.controllers[0]?.sent).toEqual([{ type: 'terminal.release' }]);

    await flush();
    expect(zamkniecie.herdr.layoutReads).toEqual([]);
    expect(serwer.herdr.layoutReads).toEqual([]);
  });

  it('martwy kontroler: bez odczytu układu; `dispose()` w trakcie odczytu — bez resize', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.herdr.answerLayout(solo());
    const options = {
      cwd: CWD, cols: 62, rows: 29, onData: (): void => { /* atrapa */ }, onExit: (): void => { /* atrapa */ },
    };
    const martwy = await h.backend.attach({ ref: OWN_PANE.paneId, id: ID }, options);
    h.controllers[0]?.exit(1);
    martwy.release({ restoreSize: true });
    await flush();
    expect(h.herdr.layoutReads).toEqual([]);
    expect(h.controllers[0]?.sent).toEqual([{ type: 'terminal.release' }]);

    let answer: (layout: HerdrPaneLayout) => void = () => { /* ustawi zapora */ };
    h.herdr.answerLayout(new Promise<HerdrPaneLayout>((resolve) => { answer = resolve; }));
    const zywy = await h.backend.attach({ ref: OWN_PANE.paneId, id: ID }, options);
    zywy.release({ restoreSize: true });
    await waitUntil('odczyt układu w locie', () => h.herdr.layoutReads.length === 1);
    h.backend.dispose();
    answer(solo());
    await waitUntil('release', () => released(h.controllers[1]));
    expect(h.controllers[1]?.sent).toEqual([{ type: 'terminal.release' }]);
  });
});

describe('adopcja i żniwa czytają panele po tokenie', () => {
  it('listSessions oddaje wyłącznie panele z tokenem i przyznany identyfikator', async () => {
    const h = makeHarness({ panes: [HOST_PANE, OWN_PANE] });
    const sessions = await h.backend.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(ID);
    expect(sessions[0]?.handle).toEqual({ ref: OWN_PANE.paneId, id: ID, fresh: false });
    expect(sessions[0]?.cwd).toBe(CWD);
  });

  /*
   * Panel z tokenem NIEOBECNY w pliku (czysty `dataDir` po reinstalacji) dostaje `now`
   * i liczy czas od zera. „Nieznany = do żniw" skasowałby po restarcie Raroga powłokę,
   * o której wieku nic nie wiemy.
   */
  it('nieznany panel dostaje znacznik TERAZ, a plik stanu powstaje z prawami 0600', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    const przed = Math.floor(Date.now() / 1000);
    const sessions = await h.backend.listSessions();
    expect(sessions[0]?.activityEpochSec).toBeGreaterThanOrEqual(przed);

    const statePath = join(h.dataDir, TERM_HERDR_STATE_FILENAME);
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, { cwd: string }>;
    expect(state[OWN_PANE.paneId]?.cwd).toBe(CWD);
  });

  it('zapamiętany katalog bije bieżący `cwd` powłoki (adopcja po `cd` w terminalu)', async () => {
    const h = makeHarness({ panes: [{ ...OWN_PANE, cwd: '/Users/testowy/gdzie-indziej' }] });
    writeFileSync(
      join(h.dataDir, TERM_HERDR_STATE_FILENAME),
      JSON.stringify({ [OWN_PANE.paneId]: { seen: Date.now(), cwd: CWD } }),
    );
    const sessions = await h.backend.listSessions();
    expect(sessions[0]?.cwd).toBe(CWD);
  });

  it('wpisy po panelach, których herdr już nie pokazuje, znikają z pliku', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    writeFileSync(
      join(h.dataDir, TERM_HERDR_STATE_FILENAME),
      JSON.stringify({
        [OWN_PANE.paneId]: { seen: 1, cwd: CWD },
        'w9:p9': { seen: 1, cwd: '/dawno/temu' },
      }),
    );
    await h.backend.listSessions();
    const state = JSON.parse(
      readFileSync(join(h.dataDir, TERM_HERDR_STATE_FILENAME), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(state)).toEqual([OWN_PANE.paneId]);
  });

  it('bez gniazda herdr lista jest pusta — nic nie adoptujemy i nic nie zabijamy', async () => {
    const h = makeHarness({ panes: [OWN_PANE], client: () => null });
    expect(await h.backend.listSessions()).toEqual([]);
  });
});

describe('bramka własności PRZED `--takeover` i przeliczanie zatrutego uchwytu', () => {
  /*
   * `--takeover` WYRZUCA z panelu dotychczasowego kontrolera, a id paneli herdr są POZYCYJNE
   * (`w15:p1`). Uchwyt żyje w rejestrze do restartu Raroga, więc po zamknięciu naszego panelu
   * albo po restarcie herdr ten sam adres należy dziś do kogoś innego — spawn bez pytania
   * o token wyrzucałby prawowitego kontrolera z cudzej powłoki.
   */
  it('panel z CUDZYM tokenem `rarog-term` nie jest przejmowany — zero spawnów', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('kontroler 1', () => h.controllers.length === 1);

    // Panele przenumerowane: pod tym samym adresem stoi dziś terminal INNEGO projektu.
    const obcy = termIdFor('/Users/testowy/Projects/inny');
    h.herdr.panes = [{ ...OWN_PANE, tokens: { [RAROG_TERM_TOKEN]: obcy } }];

    // Drugie gniazdo = planowy respawn, czyli kolejny `attach` na zapamiętanym uchwycie.
    h.registry.attach(ID, new FakeClient());
    await waitUntil(
      'odmowa przejęcia', () => h.logs.some((line) => line.includes('is no longer terminal')),
    );
    await flush();
    expect(h.spawnArgs).toHaveLength(1);
    h.registry.dispose();
  });

  /*
   * Bloker: obietnica `ensureSession` powstawała RAZ na wpis, więc JEDNA chwilowa awaria
   * gniazda herdr zatruwała terminal do `DELETE` albo restartu Raroga — a udokumentowaną
   * drogą wyjścia jest „Spróbuj od nowa", czyli `POST`.
   */
  it('odrzucony `ensureSession` nie jest wyrokiem — kolejny POST liczy uchwyt od nowa',
    async () => {
      const h = makeHarness({ panes: [OWN_PANE], failList: 1 });
      expect(h.registry.open(CWD).ok).toBe(true);
      h.registry.attach(ID, new FakeClient());
      await waitUntil(
        'odmowa uchwytu', () => h.logs.some((line) => line.includes('the next POST recomputes it')),
      );
      expect(h.controllers).toHaveLength(0);

      // „Spróbuj od nowa" z PWA to zwykły POST — i tu ma naprawdę naprawiać.
      expect(h.registry.open(CWD).ok).toBe(true);
      h.registry.attach(ID, new FakeClient());
      await waitUntil('kontroler po ponowieniu', () => h.controllers.length === 1);
      h.registry.dispose();
    });
});

describe('żniwiarz paneli chodzi tylko wtedy, gdy wolno terminal w ogóle otworzyć', () => {
  const silent: Logger = { info: () => { /* cisza */ }, error: () => { /* cisza */ } };
  const DAWNO_MS = 30 * 24 * 3600 * 1000;

  /*
   * Killswitch, który blokuje OTWIERANIE terminala, ale przepuszcza `pane.close` na
   * bezczynnych panelach, byłby niespodzianką w miejscu, w którym człowiek szuka pewności.
   * Przy `RAROG_HERDR_LAUNCH=0` Rarog nie ma tknąć paneli w żadną stronę
   * — nawet `pane.list` nie leci.
   */
  it('`RAROG_HERDR_LAUNCH=0` — zero odczytów paneli i zero zamknięć', async () => {
    const h = makeHarness({ panes: [OWN_PANE], env: { RAROG_HERDR_LAUNCH: '0' } });
    writeFileSync(
      join(h.dataDir, TERM_HERDR_STATE_FILENAME),
      JSON.stringify({ [OWN_PANE.paneId]: { seen: Date.now() - DAWNO_MS, cwd: CWD } }),
    );
    expect(await reapIdleSessions(h.backend, h.config, silent, Date.now())).toBe(0);
    expect(h.herdr.listCalls).toBe(0);
    expect(h.herdr.closedPanes).toEqual([]);
  });

  it('z włączonymi killswitchami zamyka panel bez klienta i bez aktywności', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    writeFileSync(
      join(h.dataDir, TERM_HERDR_STATE_FILENAME),
      JSON.stringify({ [OWN_PANE.paneId]: { seen: Date.now() - DAWNO_MS, cwd: CWD } }),
    );
    expect(await reapIdleSessions(h.backend, h.config, silent, Date.now())).toBe(1);
    expect(h.herdr.closedPanes).toEqual([OWN_PANE.paneId]);
  });
});

describe('pane.close TYLKO z tokenem terminala', () => {
  it('zamyka panel z tokenem i czyści go z pliku stanu', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    expect(h.registry.close(ID)).toBe(true);
    await waitUntil('pane.close', () => h.herdr.closedPanes.length === 1);
    expect(h.herdr.closedPanes).toEqual([OWN_PANE.paneId]);
    // Tab (a z nim cudze panele) zostaje nietknięty — zamykamy PANEL, nie tab.
    expect(h.herdr.closedTabs).toEqual([]);
  });

  /*
   * Bramka: identyfikatory paneli herdr są pozycyjne (`w15:p1`), więc uchwyt sprzed restartu
   * herdr może dziś wskazywać CUDZY panel. Zamykamy wyłącznie to, co w ŚWIEŻYM `pane.list`
   * nosi nasz token.
   */
  it('NIE zamyka panelu, który stracił token (albo nigdy go nie miał)', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    // Uchwyt musi być już rozstrzygnięty — dopiero potem panel „zmienia właściciela".
    await waitUntil('kontroler', () => h.controllers.length === 1);
    h.herdr.panes = [{ ...OWN_PANE, tokens: {} }];
    expect(h.registry.close(ID)).toBe(true);
    await waitUntil('próba zamknięcia', () => h.logs.some((line) => line.includes('skipping close of')));
    expect(h.herdr.closedPanes).toEqual([]);
  });

  /*
   * Sama OBECNOŚĆ tokenu broniła tylko panelu człowieka. Pod pozycyjnym adresem może dziś stać
   * panel INNEGO terminala Raroga — i `DELETE /api/term/:id` zabijałby powłokę cudzego projektu
   * razem z pracą w niej. Dlatego porównujemy WARTOŚĆ tokenu z tożsamością
   * terminala, którą niesie uchwyt.
   */
  it('NIE zamyka panelu z tokenem INNEGO terminala Raroga', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('kontroler', () => h.controllers.length === 1);
    const obcy = termIdFor('/Users/testowy/Projects/inny');
    h.herdr.panes = [{ ...OWN_PANE, tokens: { [RAROG_TERM_TOKEN]: obcy } }];
    expect(h.registry.close(ID)).toBe(true);
    await waitUntil(
      'próba zamknięcia', () => h.logs.some((line) => line.includes('skipping close of')),
    );
    expect(h.herdr.closedPanes).toEqual([]);
  });
});

describe('pane.read TYLKO z tokenem terminala (historia do zaznaczenia)', () => {
  it('czyta historię własnego panelu i oddaje `text` + `truncated`', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.herdr.history = { text: 'wyjscie\n', truncated: true };

    const result = await h.registry.history(ID, 1_000);

    expect(result).toEqual({ ok: true, text: 'wyjscie\n', truncated: true });
    expect(h.herdr.historyReads).toEqual([{ paneId: OWN_PANE.paneId, lines: 1_000 }]);
  });

  /*
   * Ta sama bramka co przy `pane.close` i `--takeover`, ale waży najwięcej: `pane.read` oddaje
   * TREŚĆ powłoki. Panel spod pozycyjnego adresu (`w15:p1`) może dziś należeć do kogoś innego,
   * a wtedy odczyt wysłałby na telefon cudzy scrollback.
   */
  it('NIE czyta panelu, który stracił token — i nie dotyka gniazda odczytem', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('kontroler', () => h.controllers.length === 1);
    h.herdr.panes = [{ ...OWN_PANE, tokens: {} }];

    expect(await h.registry.history(ID, 100)).toMatchObject({ ok: false, error: 'not-found' });
    expect(h.herdr.historyReads).toEqual([]);
  });

  it('NIE czyta panelu z tokenem INNEGO terminala Raroga', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('kontroler', () => h.controllers.length === 1);
    h.herdr.panes = [{
      ...OWN_PANE,
      tokens: { [RAROG_TERM_TOKEN]: termIdFor('/Users/testowy/Projects/inny') },
    }];

    expect(await h.registry.history(ID, 100)).toMatchObject({ ok: false, error: 'not-found' });
    expect(h.herdr.historyReads).toEqual([]);
  });

  /*
   * REGUŁA ZERO LOGÓW TREŚCI. Do `server.log` wolno iść wyłącznie cyklowi życia (adres panelu
   * i liczba linii) — ani jeden znak historii. Asercja szuka DOSŁOWNIE treści, którą oddało
   * fałszywe gniazdo: to jedyny sposób, żeby przyszła linia diagnostyczna z `text` w środku
   * przewróciła test, zamiast po cichu wypisać `.env` do pliku.
   */
  it('nie loguje ANI JEDNEGO znaku historii', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.registry.open(CWD);
    h.herdr.history = { text: 'SEKRET-Z-EKRANU-42\n', truncated: false };

    await h.registry.history(ID, 1_000);

    expect(h.logs.some((line) => line.includes('SEKRET-Z-EKRANU-42'))).toBe(false);
    // Cykl życia PRZECHODZI — inaczej diagnostyka „czy ktoś w ogóle czytał historię" znika.
    expect(h.logs.some((line) => line.includes(`pane history ${OWN_PANE.paneId}`))).toBe(true);
  });

  /*
   * `RAROG_HERDR_SEND=0` to „widzę, nie ruszam". `pane.read` NICZEGO nie zmienia, więc historia
   * ma wychodzić także wtedy — to dokładnie ten tryb, w którym czytanie własnej powłoki jest
   * jedyną wartością, jaka Rarogowi zostaje.
   */
  it('działa przy RAROG_HERDR_SEND=0 (odczyt nie jest zapisem)', async () => {
    /*
     * Pytamy BACKEND wprost, a nie przez rejestr: `registry.open` odmawia przy tym killswitchu
     * z własnego powodu (nie wolno zakładać ani stemplować paneli), więc przez rejestr nie da
     * się tu w ogóle dojść do odczytu. Kontraktem jest to, że `readHistory` NIE PYTA
     * `refusal()` — inaczej historia znikałaby razem z prawem pisania.
     */
    const h = makeHarness({ panes: [OWN_PANE], env: { RAROG_HERDR_SEND: '0' } });
    expect(h.backend.refusal()).not.toBeNull();

    const history = await h.backend.readHistory({ ref: OWN_PANE.paneId, id: ID }, 100);

    expect(history).toEqual({ text: 'linia\n', truncated: false });
    expect(h.herdr.historyReads).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Nazwa procesu na etykiecie taba (`pane.process_info`)
// ---------------------------------------------------------------------------

describe('termProcessLabel — jedno słowo na pigułkę', () => {
  /*
   * `foreground_processes[0]`, a NIE proces o `pid == foreground_process_group_id`. Zmierzone
   * na żywym herdr: panel z codeksem oddaje `[0] = codex` (pid 51073) i drugi wpis `node`
   * o pid równym id grupy (51069). Bierzemy pierwszy, bo to on odpowiada na pytanie „co tu
   * chodzi"; wersja „po pid grupy" pokazywałaby `node`.
   */
  it('bierze PIERWSZY proces, nie ten o pid grupy', () => {
    expect(termProcessLabel([
      { pid: 51_073, name: 'codex', argv0: 'codex' },
      { pid: 51_069, name: 'node', argv0: 'node' },
    ])).toBe('codex');
  });

  it('`argv0` bije `name`, a jego brak (pole nullowalne) wraca do `name`', () => {
    expect(termProcessLabel([{ pid: 1, name: 'python3.12', argv0: 'devspace' }])).toBe('devspace');
    expect(termProcessLabel([{ pid: 1, name: 'nvim', argv0: '' }])).toBe('nvim');
  });

  it('pełna ścieżka binarki schodzi do samej nazwy pliku', () => {
    expect(termProcessLabel([{
      pid: 1, name: 'codex', argv0: '/Users/x/.config/nvm/versions/node/v22/bin/codex',
    }])).toBe('codex');
  });

  it('lowercase i sufit długości — pigułka ma szerokość kciuka', () => {
    expect(termProcessLabel([{ pid: 1, name: 'X', argv0: 'MyVeryLongProcessName' }]))
      .toBe('myverylongpr');
    expect(termProcessLabel([{ pid: 1, name: 'X', argv0: 'MyVeryLongProcessName' }]))
      .toHaveLength(TERM_PROC_MAX_LENGTH);
  });

  /*
   * Pusta lista to NORMALNY stan (powłoka, w której nic nie chodzi) — i dlatego fallback jest
   * słowem, a nie pustym stringiem: `''` znaczy w kontrakcie „jeszcze nie wiem".
   */
  it('pusta lista procesów to `zsh`, nie pusty string', () => {
    expect(termProcessLabel([])).toBe(TERM_PROC_FALLBACK);
    expect(termProcessLabel([{ pid: 1, name: '', argv0: '' }])).toBe(TERM_PROC_FALLBACK);
  });
});

describe('processName — cache z TTL, odczyt PO odpowiedzi', () => {
  const handle = { ref: OWN_PANE.paneId, id: ID };

  /** Oddanie sterowania pętli zdarzeń: odświeżenie startuje mikrozadaniem, nie synchronicznie. */
  const settle = async (): Promise<void> => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  };

  /*
   * PIERWSZE pytanie oddaje `''` („jeszcze nie wiem") i NIE czeka na herdr — to jest cały
   * powód, dla którego `GET /api/term` zostaje synchroniczny. Odczyt rusza dopiero po nim.
   */
  it('pierwsze wywołanie oddaje pusty string, a odczyt leci dopiero potem', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.herdr.processes = [{ pid: 1, name: 'nvim', argv0: 'nvim' }];

    expect(h.backend.processName(handle)).toBe('');
    expect(h.herdr.processReads).toEqual([]); // ani jednego RPC w torze synchronicznym

    await settle();
    expect(h.herdr.processReads).toEqual([OWN_PANE.paneId]);
    expect(h.backend.processName(handle)).toBe('nvim');
  });

  it('w oknie TTL nie ma drugiego odczytu, po nim jest', async () => {
    let teraz = 1_000_000;
    const h = makeHarness({ panes: [OWN_PANE], now: () => teraz });
    h.backend.processName(handle);
    await settle();
    expect(h.herdr.processReads).toHaveLength(1);

    teraz += TERM_PROC_TTL_MS - 1;
    h.backend.processName(handle);
    await settle();
    expect(h.herdr.processReads).toHaveLength(1);

    teraz += 1;
    h.backend.processName(handle);
    await settle();
    expect(h.herdr.processReads).toHaveLength(2);
  });

  /*
   * BRAMKA WŁASNOŚCI, ta sama co przy `attach`, `killSession` i `readHistory`: pytamy o proces
   * WYŁĄCZNIE panelu, który w świeżym `pane.list` nosi token `rarog-term` o WARTOŚCI równej
   * tożsamości uchwytu. Adresy paneli herdr są pozycyjne, więc bez niej etykieta zdradzałaby,
   * co człowiek uruchomił w cudzym tabie.
   */
  it('cudzy panel pod tym adresem: ZERO odczytu procesu', async () => {
    const obcy: HerdrPaneInfo = { ...OWN_PANE, tokens: { [RAROG_TERM_TOKEN]: 'inny-terminal' } };
    const h = makeHarness({ panes: [obcy] });

    h.backend.processName(handle);
    await settle();

    expect(h.herdr.processReads).toEqual([]);
    expect(h.backend.processName(handle)).toBe('');
  });

  it('panel zniknął z listy: nazwa WRACA do pustej, a nie zostaje ostatnią znaną', async () => {
    let teraz = 1_000_000;
    const h = makeHarness({ panes: [OWN_PANE], now: () => teraz });
    h.backend.processName(handle);
    await settle();
    expect(h.backend.processName(handle)).toBe('zsh');

    // Panel zamknięty na Macu (albo przenumerowany po restarcie herdr) — po upływie TTL
    // odświeżenie ma SKASOWAĆ wpis, a nie zostawić nazwy sprzed zniknięcia.
    h.herdr.panes = [];
    teraz += TERM_PROC_TTL_MS;
    h.backend.processName(handle);
    await settle();
    expect(h.backend.processName(handle)).toBe('');
  });

  it('padnięty `pane.process_info` to fallback `zsh`, a do logu idzie sam POWÓD', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.herdr.processes = null;

    h.backend.processName(handle);
    await settle();

    expect(h.backend.processName(handle)).toBe(TERM_PROC_FALLBACK);
    expect(h.logs.some((line) => line.includes('process name of pane'))).toBe(true);
  });

  it('padnięty `pane.list` zostawia OSTATNIĄ znaną nazwę — cisza, nie kłamstwo', async () => {
    let teraz = 1_000_000;
    const h = makeHarness({ panes: [OWN_PANE], now: () => teraz });
    h.herdr.processes = [{ pid: 1, name: 'nvim', argv0: 'nvim' }];
    h.backend.processName(handle);
    await settle();
    expect(h.backend.processName(handle)).toBe('nvim');

    // Gniazdo chwilowo martwe przy NASTĘPNYM odświeżeniu.
    teraz += TERM_PROC_TTL_MS;
    h.herdr.failNextList(1);
    h.backend.processName(handle);
    await settle();
    expect(h.backend.processName(handle)).toBe('nvim');
  });

  /*
   * Lista ośmiu terminali ma kosztować JEDEN `pane.list`, a nie osiem: wszystkie wywołania
   * `processName` z jednego `list()` lądują w tej samej turze odświeżania.
   */
  it('kilka uchwytów w jednej turze to JEDEN `pane.list`', async () => {
    const drugiId = termIdFor(CWD, 2);
    const drugiPane: HerdrPaneInfo = {
      paneId: 'w1:pA', tabId: 'w1:tA', workspaceId: 'w1', cwd: CWD,
      tokens: { [RAROG_TERM_TOKEN]: drugiId }, label: null,
    };
    const h = makeHarness({ panes: [OWN_PANE, drugiPane] });
    const przed = h.herdr.listCalls;

    h.backend.processName(handle);
    h.backend.processName({ ref: drugiPane.paneId, id: drugiId });
    await settle();

    expect(h.herdr.listCalls - przed).toBe(1);
    expect(h.herdr.processReads.sort()).toEqual([OWN_PANE.paneId, drugiPane.paneId].sort());
  });

  /*
   * REGRESSION: the `procScheduled` flag must protect the round in flight, so it is not reset at
   * the START of `refreshProcessNames`. Otherwise a phone and an iPad polling `GET /api/term`
   * 100 ms apart see `procCache` still stale (the round has written nothing yet) and plan
   * a SECOND, parallel round: another `pane.list` plus `pane.process_info` for EVERY terminal.
   * At the `RAROG_TERM_MAX` ceiling and three devices that is a dozen extra reads within 5 s —
   * a pump into the herdr control plane that the terminal must not create.
   *
   * `await Promise.resolve()` to JEDEN krok mikrozadań: mikrozadanie odświeżenia już ruszyło
   * i wisi na `listPanes()`, a druga „lista" wchodzi w środek tury.
   */
  it('druga lista W ŚRODKU tury nie planuje drugiej tury', async () => {
    const drugiId = termIdFor(CWD, 2);
    const drugiPane: HerdrPaneInfo = {
      paneId: 'w1:pA', tabId: 'w1:tA', workspaceId: 'w1', cwd: CWD,
      tokens: { [RAROG_TERM_TOKEN]: drugiId }, label: null,
    };
    const drugi = { ref: drugiPane.paneId, id: drugiId };
    const h = makeHarness({ panes: [OWN_PANE, drugiPane] });
    const przed = h.herdr.listCalls;

    // Poll pierwszego urządzenia.
    h.backend.processName(handle);
    h.backend.processName(drugi);
    await Promise.resolve();

    // Poll drugiego urządzenia — tura pierwszego jeszcze nie oddała ani jednej nazwy.
    h.backend.processName(handle);
    h.backend.processName(drugi);
    await settle();

    expect(h.herdr.listCalls - przed).toBe(1);
    expect(h.herdr.processReads.sort()).toEqual([OWN_PANE.paneId, drugiPane.paneId].sort());
    // Tura się domknęła: nazwy są, a flaga puściła, więc następny poll po TTL znów zaplanuje.
    expect(h.backend.processName(handle)).toBe('zsh');
  });

  it('zamknięcie terminala kasuje wpis w cache', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.backend.processName(handle);
    await settle();
    expect(h.backend.processName(handle)).toBe('zsh');

    await h.backend.killSession(handle);
    expect(h.backend.processName(handle)).toBe('');
  });

  /*
   * `pane.process_info` jest ODCZYTEM: przy `RAROG_HERDR_SEND=0` etykieta ma dalej działać —
   * ta sama zasada co przy historii („widzę, nie ruszam").
   */
  it('działa przy RAROG_HERDR_SEND=0', async () => {
    const h = makeHarness({ panes: [OWN_PANE], env: { RAROG_HERDR_SEND: '0' } });
    expect(h.backend.refusal()).not.toBeNull();

    h.backend.processName(handle);
    await settle();

    expect(h.herdr.processReads).toEqual([OWN_PANE.paneId]);
  });
});

/*
 * The host workspace is chosen by the resolver (`herdr/workspace-resolver.ts`): a candidate by label
 * or checkout, then proof of the path. Choosing by the drifting `pane.cwd` (the current folder of the
 * foreground process) would put slots of one project in SEPARATE workspaces and let a tab of project
 * A enter the workspace of project B.
 */
describe('wybór workspace\'u gospodarza — resolver zamiast heurystyki `pane.cwd`', () => {
  /** Panel człowieka w CUDZYM workspace'ie, który zrobił `cd` do projektu. */
  const FOREIGN_CD: HerdrPaneInfo = {
    paneId: 'w7:p1', tabId: 'w7:t1', workspaceId: 'w7', cwd: CWD, tokens: {}, label: null,
  };

  it('drugi slot wchodzi do workspace\'u pierwszego (etykieta panelu), nie do cudzego z `cd`', async () => {
    // Slot 1 zdryfował `cd` poza projekt, a pliku stanu nie ma (np. po reinstalacji) — wybór po
    // `pane.cwd` wziąłby wtedy `w7`, bo tam stoi panel z `cwd === CWD`.
    const slot1: HerdrPaneInfo = {
      paneId: 'w5:p1', tabId: 'w5:t1', workspaceId: 'w5', cwd: '/Users/testowy/gdzie-indziej',
      tokens: { [RAROG_TERM_TOKEN]: ID }, label: termPaneLabel(ID),
    };
    const h = makeHarness({ panes: [FOREIGN_CD, slot1] });
    h.herdr.workspaces = [
      { workspaceId: 'w7', label: 'atlas' }, { workspaceId: 'w5', label: 'rarog' },
    ];

    await h.backend.ensureSession(termIdFor(CWD, 2), CWD, 'shell');

    expect(h.herdr.created.workspaces).toEqual([]);
    expect(h.herdr.created.tabs.map((tab) => tab.workspaceId)).toEqual(['w5']);
  });

  it('`cd` cudzego panelu do projektu nie wybiera workspace\'u — nowy „rarog"', async () => {
    const h = makeHarness({ panes: [FOREIGN_CD] });
    h.herdr.workspaces = [{ workspaceId: 'w7', label: 'atlas' }];

    await h.backend.ensureSession(ID, CWD, 'shell');

    expect(h.herdr.created.tabs).toEqual([]);
    expect(h.herdr.created.workspaces.map((ws) => ws.label)).toEqual(['rarog']);
  });

  it('dwa sloty naraz na pustym herdr → JEDEN workspace i tab drugiego slotu w nim', async () => {
    const h = makeHarness({ panes: [] });

    await Promise.all([
      h.backend.ensureSession(ID, CWD, 'shell'),
      h.backend.ensureSession(termIdFor(CWD, 2), CWD, 'shell'),
    ]);

    expect(h.herdr.created.workspaces).toHaveLength(1);
    expect(h.herdr.created.tabs.map((tab) => tab.workspaceId)).toEqual(['wNEW']);
  });

  it('strażnik: ani backend, ani launcher nie wybierają workspace\'u po `pane.cwd === cwd`', () => {
    for (const file of [['term', 'herdr-backend.ts'], ['herdr', 'launcher.ts']]) {
      const src = readFileSync(join(import.meta.dirname, '..', 'src', ...file), 'utf8');
      expect(src, file.join('/')).not.toMatch(/pane\.cwd === cwd/);
      expect(src, file.join('/')).toContain('decideProjectWorkspace(');
    }
  });
});

/*
 * ROLA panelu. Backend zna z niej dokładnie jedną rzecz — ETYKIETĘ zakładanego
 * taba — i jedną musi oddać: czy panel powstał przed chwilą (`fresh`), bo na tym stoi decyzja
 * rejestru o wpisaniu `exec lazygit`. Token panelu zostaje ten sam (`rarog-term`): to bramka
 * własności, więc ma być jedna dla całego terminala Raroga. Etykieta niesie też
 * slot i katalog: `rarog <slot> · <katalog>` / `rarog lazygit · …` / `rarog popup · …`.
 */
describe('rola panelu: etykieta taba i `fresh` uchwytu', () => {
  const LAZY_ID = termIdFor(CWD, 0, 'lazygit');

  const POPUP_ID = termIdFor(CWD, 0, 'popup');

  it('każda rola ma własną etykietę taba: `rarog 1 · …`, `rarog lazygit · …`, `rarog popup · …`', async () => {
    const h = makeHarness({ panes: [HOST_PANE] });
    await h.backend.ensureSession(ID, CWD, 'shell');
    await h.backend.ensureSession(LAZY_ID, CWD, 'lazygit');
    await h.backend.ensureSession(POPUP_ID, CWD, 'popup');

    expect(h.herdr.created.tabs.map((tab) => tab.label))
      .toEqual(['rarog 1 · rarog', 'rarog lazygit · rarog', 'rarog popup · rarog']);
    // Token jest WSPÓLNY dla wszystkich ról — po nim idzie bramka `pane.close`, `attach` i adopcja.
    expect(h.herdr.stamped.map((stamp) => stamp.tokens)).toEqual([
      { [RAROG_TERM_TOKEN]: ID },
      { [RAROG_TERM_TOKEN]: LAZY_ID },
      { [RAROG_TERM_TOKEN]: POPUP_ID },
    ]);
  });

  it('brak roli w wywołaniu = `shell` (zgodność wstecz kontraktu backendu)', async () => {
    const h = makeHarness({ panes: [HOST_PANE] });
    await h.backend.ensureSession(ID, CWD);
    expect(h.herdr.created.tabs[0]?.label).toBe('rarog 1 · rarog');
  });

  it('slot z tożsamości trafia do etykiety taba (`rarog 3 · rarog`) — jak pigułka w PWA', async () => {
    const h = makeHarness({ panes: [HOST_PANE] });
    await h.backend.ensureSession(termIdFor(CWD, 3), CWD, 'shell');
    expect(h.herdr.created.tabs[0]?.label).toBe('rarog 3 · rarog');
  });

  it('świeżo założony panel ma `fresh: true`, ODNALEZIONY po tokenie — `false`', async () => {
    const h = makeHarness({ panes: [HOST_PANE] });
    const swiezy = await h.backend.ensureSession(LAZY_ID, CWD, 'lazygit');
    expect(swiezy.fresh).toBe(true);

    // Drugie wejście na ten sam terminal odnajduje panel po tokenie — lazygit już w nim chodzi.
    const odnaleziony = await h.backend.ensureSession(LAZY_ID, CWD, 'lazygit');
    expect(odnaleziony).toMatchObject({ ref: swiezy.ref, id: LAZY_ID, fresh: false });
    expect(h.herdr.created.tabs).toHaveLength(1);
  });

  it('panele z `listSessions` (adopcja, żniwa) nigdy nie są świeże', async () => {
    const h = makeHarness({ panes: [{ ...OWN_PANE, tokens: { [RAROG_TERM_TOKEN]: LAZY_ID } }] });
    const sesje = await h.backend.listSessions();
    expect(sesje).toHaveLength(1);
    expect(sesje[0]?.handle.fresh).toBe(false);
  });
});

/*
 * Token `rarog-term` stemplują `ensureSession` i `attach`. `refreshSession` jest trzecią drogą
 * stempla — z tą samą bramką
 * własności co pozostałe i BEZ dotykania znacznika aktywności.
 */
describe('refreshSession — odświeżenie tokenu bez dotykania powłoki', () => {
  const handle: TermSessionHandle = { ref: OWN_PANE.paneId, id: ID };

  it('stempluje panel, który nosi tożsamość uchwytu, i oddaje `true`', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });

    await expect(h.backend.refreshSession(handle)).resolves.toBe(true);

    expect(h.herdr.stamped).toEqual([{
      paneId: OWN_PANE.paneId,
      source: RAROG_TERM_METADATA_SOURCE,
      tokens: { [RAROG_TERM_TOKEN]: ID },
    }]);
    expect(h.spawnArgs).toEqual([]);
  });

  it('NIE przywraca tokenu panelowi, który go stracił — id paneli są pozycyjne', async () => {
    const h = makeHarness({ panes: [{ ...OWN_PANE, tokens: {} }] });

    await expect(h.backend.refreshSession(handle)).resolves.toBe(false);

    expect(h.herdr.stamped).toEqual([]);
  });

  it('nie stempluje panelu z CUDZĄ tożsamością ani panelu, którego nie ma', async () => {
    const obcy = termIdFor('/Users/testowy/Projects/inny');
    const h = makeHarness({ panes: [{ ...OWN_PANE, tokens: { [RAROG_TERM_TOKEN]: obcy } }] });

    await expect(h.backend.refreshSession(handle)).resolves.toBe(false);
    h.herdr.panes = [];
    await expect(h.backend.refreshSession(handle)).resolves.toBe(false);

    expect(h.herdr.stamped).toEqual([]);
  });

  it('nie rusza znacznika aktywności — żniwa liczą ciszę od człowieka, nie od timera', async () => {
    const dawno = Date.now() - 3 * 24 * 3600 * 1000;
    const h = makeHarness({ panes: [OWN_PANE] });
    writeFileSync(
      join(h.dataDir, TERM_HERDR_STATE_FILENAME),
      `${JSON.stringify({ [OWN_PANE.paneId]: { seen: dawno, cwd: CWD } })}\n`,
    );

    await h.backend.refreshSession(handle);

    const sesje = await h.backend.listSessions();
    expect(sesje.map((s) => s.activityEpochSec)).toEqual([Math.floor(dawno / 1000)]);
  });
});

// ---------------------------------------------------------------------------
// Pochodzenie panelu = etykieta, token wraca z etykiety, nigdy drugi tab obok
// ---------------------------------------------------------------------------

/**
 * Sierota po restarcie serwera herdr: etykieta PANELU przeżyła (snapshot herdr), token zginął
 * (tokeny żyją w RAM demona). Dokładnie ten stan zostawiły restarty z 22.09 i 30.09.
 */
function orphan(paneId: string, id: string, cwd = CWD): HerdrPaneInfo {
  return {
    paneId, tabId: `${paneId}t`, workspaceId: 'w1', cwd, tokens: {}, label: termPaneLabel(id),
  };
}

const stateKeys = (h: Harness): string[] => Object.keys(JSON.parse(
  readFileSync(join(h.dataDir, TERM_HERDR_STATE_FILENAME), 'utf8'),
) as Record<string, unknown>).sort();

describe('panel terminala z etykietą i tokenem Raroga', () => {
  it('etykieta i token `rarog-term`: panel potwierdzony bez zapisu, widoczny dla adopcji, zamykalny', async () => {
    const pane = { ...orphan('w1:p1', ID), label: `rarog 1 · rarog · ${HERDR_NAME_PREFIX}-term ${ID}`, tokens: { [RAROG_TERM_TOKEN]: ID } };
    const h = makeHarness({ panes: [pane] });

    const result = await h.backend.reconcile();

    expect(result.confirmed.get('w1:p1')).toBe(ID);
    expect(h.herdr.stamped).toEqual([]);
    expect(h.herdr.renamed).toEqual([]);
    expect((await h.backend.listSessions()).map((session) => session.id)).toEqual([ID]);
    h.registry.open(CWD);
    expect(h.registry.close(ID)).toBe(true);
    await waitUntil('pane.close', () => h.herdr.closedPanes.length === 1);
    expect(h.herdr.closedPanes).toEqual(['w1:p1']);
  });
});

describe('reconcile — token wraca z etykiety panelu', () => {
  /*
   * Dowodem jest etykieta PANELU, nie `cwd` (sierota często ma katalog po `cd`) i nie etykieta
   * TABA (człowiek mógł ją zmienić; `pane.list` jej nawet nie niesie). Stempel jest bez `ttlMs`,
   * bo termin ważności robi sieroty.
   */
  it('sierota z etykietą bez tokenu odzyskuje token BEZ ttlMs, choć powłoka zmieniła katalog', async () => {
    const h = makeHarness({ panes: [orphan('w3:p2', ID, '/Users/testowy/gdzie-indziej')] });

    const result = await h.backend.reconcile();

    expect(result.ran).toBe(true);
    expect(result.restored).toEqual(['w3:p2']);
    expect(result.confirmed.get('w3:p2')).toBe(ID);
    expect(h.herdr.stamped).toEqual([{
      paneId: 'w3:p2', source: RAROG_TERM_METADATA_SOURCE, tokens: { [RAROG_TERM_TOKEN]: ID },
    }]);
    expect(h.herdr.panes[0]?.tokens).toEqual({ [RAROG_TERM_TOKEN]: ID });
    expect(h.logs.some((line) => line.includes('recovered token of pane w3:p2'))).toBe(true);
    // Odzyskany panel jest znów widoczny dla adopcji i żniw — po tokenie, jak każdy inny.
    expect((await h.backend.listSessions()).map((s) => s.id)).toEqual([ID]);
  });

  /*
   * Reconcile NICZEGO nie zamyka — w żadnej roli. Token mógł zniknąć także bez restartu herdr,
   * a wtedy w panelu żyje praca człowieka.
   */
  it('sieroty każdej roli dostają token — zero `pane.close`, zero nowych tabów', async () => {
    const lazy = termIdFor(CWD, 0, 'lazygit');
    const popup = termIdFor(CWD, 0, 'popup');
    const h = makeHarness({
      panes: [orphan('w1:p1', ID), orphan('w1:p2', lazy), orphan('w1:p3', popup)],
    });

    const result = await h.backend.reconcile();

    expect([...result.restored].sort()).toEqual(['w1:p1', 'w1:p2', 'w1:p3']);
    expect(h.herdr.closedPanes).toEqual([]);
    expect(h.herdr.closedTabs).toEqual([]);
    expect(h.herdr.created.tabs).toEqual([]);
    expect(h.herdr.created.workspaces).toEqual([]);
  });

  it('etykieta przy CUDZYM tokenie to konflikt: nic nie rusza, jedna linia logu', async () => {
    const obcy = termIdFor('/Users/testowy/Projects/inny');
    const h = makeHarness({
      panes: [{ ...orphan('w1:p1', ID), tokens: { [RAROG_TERM_TOKEN]: obcy } }],
    });

    const result = await h.backend.reconcile();
    await h.backend.reconcile();

    expect(result.conflicts.has(ID)).toBe(true);
    expect(result.confirmed.size).toBe(0);
    expect(h.herdr.stamped).toEqual([]);
    expect(h.herdr.renamed).toEqual([]);
    // Konflikt nie znika sam, więc linia jest RAZ na proces, nie co przebieg.
    expect(h.logs.filter((line) => line.includes(`conflicting marks for terminal ${ID}`))).toHaveLength(1);
  });

  it('dwa panele z tą samą etykietą: żaden nie dostaje tokenu', async () => {
    const h = makeHarness({ panes: [orphan('w1:p1', ID), orphan('w2:p1', ID)] });

    const result = await h.backend.reconcile();

    expect(result.conflicts.has(ID)).toBe(true);
    expect(h.herdr.stamped).toEqual([]);
    expect(h.logs.some((line) => line.includes('panes w1:p1, w2:p1'))).toBe(true);
  });

  /*
   * MIGRACJA: panele terminala w starym formacie mają token, ale nie mają etykiety — bez niej najbliższy
   * restart herdr zrobiłby z nich sieroty. Etykieta idzie raz; drugi przebieg widzi ją już stojącą.
   */
  it('panel z tokenem bez etykiety (stary format) dostaje `rarog-term <token>` jeden raz', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });

    const first = await h.backend.reconcile();
    await h.backend.reconcile();

    expect(first.migrated).toEqual([OWN_PANE.paneId]);
    expect(h.herdr.renamed.map((call) => call.label)).toEqual([termPaneLabel(ID), termPaneLabel(ID, 'rarog 1 · rarog')]);
    expect(h.herdr.stamped).toEqual([]);
    expect(h.logs.some((line) => line.includes(`migration — pane ${OWN_PANE.paneId}`))).toBe(true);
  });

  it('migracja: timeout ponawia w następnym przebiegu, odmowa herdr — już nie w tym procesie', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.herdr.renameOutcome = 'timeout';
    await h.backend.reconcile();
    await h.backend.reconcile();
    expect(h.herdr.renamed).toHaveLength(2);

    h.herdr.renameOutcome = 'error';
    await h.backend.reconcile();
    await h.backend.reconcile();
    expect(h.herdr.renamed).toHaveLength(3);
  });

  /*
   * Droga „zapomnij" z runbooka: człowiek zdejmuje etykietę I token (`herdr pane rename --clear`
   * + `--clear-token`), restartuje Raroga — i panel ma zostać jego. Bez etykiety i tokenu
   * migracja nie ma czego podjąć.
   */
  it('„zapomnij": zdjęte etykieta i token → po restarcie Raroga panel nietknięty', async () => {
    const h = makeHarness({ panes: [{ ...OWN_PANE, tokens: {}, label: null }] });

    const result = await h.backend.reconcile();

    expect(result.restored).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(h.herdr.stamped).toEqual([]);
    expect(h.herdr.renamed).toEqual([]);
    expect(await h.backend.listSessions()).toEqual([]);
  });

  /*
   * `listPanes` odsiewa wiersze bez `cwd`/`tab_id`, a „odfiltrowany" nie znaczy „nieistniejący".
   * Prune po liście FILTROWANEJ kasował katalog powstania żywego panelu — po nim adopcja nie
   * miała z czego odtworzyć tożsamości.
   */
  it('prune `term-herdr.json` nie kasuje panelu obecnego tylko w `listPaneIds`', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.herdr.hiddenPaneIds = ['w2:p5'];
    writeFileSync(join(h.dataDir, TERM_HERDR_STATE_FILENAME), JSON.stringify({
      [OWN_PANE.paneId]: { seen: 1, cwd: CWD },
      'w2:p5': { seen: 1, cwd: CWD },
      'w9:p9': { seen: 1, cwd: '/dawno/temu' },
    }));

    await h.backend.reconcile();
    expect(stateKeys(h)).toEqual([OWN_PANE.paneId, 'w2:p5'].sort());

    await h.backend.listSessions();
    expect(stateKeys(h)).toEqual([OWN_PANE.paneId, 'w2:p5'].sort());
  });
});

/*
 * MIGRACJA ETYKIET TABÓW terminala w starym formacie: tab z naszym panelem (token + etykieta
 * `rarog-term <id>`) i dawną etykietą roli albo „1" dostaje `rarog <slot> · <katalog>`. Etykieta
 * nadana ręcznie i tab z kilkoma panelami — nietknięte. Etykiety terminala są deterministyczne,
 * więc nie ma śladu: rozpoznaje je sama lista dawnych nazw.
 */
describe('reconcile — etykiety tabów terminala w starym formacie dostają nowy format', () => {
  /** Panel terminala Raroga z tokenem i etykietą w tabie `<pane>t` (jak `orphan`, z tokenem). */
  const marked = (paneId: string, id: string, cwd = CWD): HerdrPaneInfo => ({
    ...orphan(paneId, id, cwd), tokens: { [RAROG_TERM_TOKEN]: id },
  });

  it('„1” z `workspace.create` → `rarog <slot|rola> · <katalog>` (shell, slot 2, lazygit, popup)', async () => {
    const slot2 = termIdFor(CWD, 2);
    const lazy = termIdFor(CWD, 0, 'lazygit');
    const popup = termIdFor(CWD, 0, 'popup');
    const h = makeHarness({
      panes: [marked('w1:p1', ID), marked('w1:p2', slot2), marked('w1:p3', lazy), marked('w1:p4', popup)],
    });
    h.herdr.tabLabels.set('w1:p1t', '1');
    h.herdr.tabLabels.set('w1:p2t', '1');
    h.herdr.tabLabels.set('w1:p3t', '1');
    h.herdr.tabLabels.set('w1:p4t', '1');

    await h.backend.reconcile();

    expect(h.herdr.renamed.filter((call) => call.kind === 'tab')).toEqual([
      { kind: 'tab', id: 'w1:p1t', label: 'rarog 1 · rarog' },
      { kind: 'tab', id: 'w1:p2t', label: 'rarog 2 · rarog' },
      { kind: 'tab', id: 'w1:p3t', label: 'rarog lazygit · rarog' },
      { kind: 'tab', id: 'w1:p4t', label: 'rarog popup · rarog' },
    ]);
    // Niczego poza etykietami: ani tokenu, ani zamknięcia, ani nowego taba.
    expect(h.herdr.stamped).toEqual([]);
    expect(h.herdr.closedPanes).toEqual([]);
    expect(h.herdr.created.tabs).toEqual([]);
    expect(h.logs.some((line) => line.includes('tab labels 4'))).toBe(true);
  });

  it('etykieta nadana ręcznie zostaje — także po kolejnych przebiegach', async () => {
    const h = makeHarness({ panes: [marked('w1:p1', ID)] });
    h.herdr.tabLabels.set('w1:p1t', 'moja powłoka');

    await h.backend.reconcile();
    await h.backend.reconcile();

    expect(h.herdr.renamed.filter((call) => call.kind === 'tab')).toEqual([]);
    // Jedno sprawdzenie na panel i proces — drugi przebieg nie pyta już o tab.
    expect(h.herdr.tabReads).toEqual(['w1:p1t']);
  });

  it('split (dwa panele w tabie) zostaje, choć etykieta to „1”', async () => {
    const human: HerdrPaneInfo = {
      paneId: 'w1:p8', tabId: 'w1:p1t', workspaceId: 'w1', cwd: CWD, tokens: {}, label: null,
    };
    const h = makeHarness({ panes: [marked('w1:p1', ID), human] });
    h.herdr.tabLabels.set('w1:p1t', '1');

    await h.backend.reconcile();

    expect(h.herdr.renamed).toEqual([]);
  });

  it('token przy CUDZEJ etykiecie panelu — tab człowieka, nawet nie pytamy', async () => {
    const h = makeHarness({ panes: [{ ...marked('w1:p1', ID), label: 'moje' }] });
    h.herdr.tabLabels.set('w1:p1t', '1');

    await h.backend.reconcile();

    expect(h.herdr.renamed).toEqual([]);
    expect(h.herdr.tabReads).toEqual([]);
  });

  it('panel w starym formacie (token bez etykiety) dostaje etykietę panelu i tab w tym samym przebiegu', async () => {
    const h = makeHarness({ panes: [{ ...marked('w1:p1', ID), label: null }] });
    h.herdr.tabLabels.set('w1:p1t', '1');

    await h.backend.reconcile();

    expect(h.herdr.renamed).toEqual([
      { kind: 'pane', id: 'w1:p1', label: termPaneLabel(ID) }, { kind: 'tab', id: 'w1:p1t', label: 'rarog 1 · rarog' },
      { kind: 'pane', id: 'w1:p1', label: termPaneLabel(ID, 'rarog 1 · rarog') },
    ]);
  });

  it('katalog z pliku stanu, nie z bieżącego `cwd` powłoki (dryf po `cd`)', async () => {
    const h = makeHarness({ panes: [marked('w1:p1', ID, '/Users/testowy/gdzie-indziej')] });
    h.herdr.tabLabels.set('w1:p1t', '1');
    writeFileSync(join(h.dataDir, TERM_HERDR_STATE_FILENAME), JSON.stringify({
      'w1:p1': { seen: 1, cwd: CWD },
    }));

    await h.backend.reconcile();

    expect(h.herdr.renamed.filter((call) => call.kind === 'tab')).toEqual([{ kind: 'tab', id: 'w1:p1t', label: 'rarog 1 · rarog' }]);
  });

  it('tożsamość nie pasuje ani do pliku stanu, ani do `cwd` — etykieta zostaje (nie zmyślamy)', async () => {
    const h = makeHarness({ panes: [marked('w1:p1', ID, '/Users/testowy/gdzie-indziej')] });
    h.herdr.tabLabels.set('w1:p1t', '1');

    await h.backend.reconcile();

    expect(h.herdr.renamed).toEqual([]);
  });

  /*
   * Prawo do zmiany nazwy stało na migawce z początku przebiegu, a `tab.get`
   * potwierdzał tylko liczbę paneli. Terminal przeniesiony w trakcie zostawia pod starym adresem
   * taba panel człowieka — jego tab nie jest już „terminala".
   */
  it('terminal przeniesiony w trakcie `tab.get`, w starym tabie panel człowieka → zero `tab.rename`', async () => {
    const h = makeHarness({ panes: [marked('w1:p1', ID)] });
    h.herdr.tabLabels.set('w1:p1t', '1');
    h.herdr.onGetTab = (): void => {
      h.herdr.onGetTab = null;
      h.herdr.panes = [
        { ...marked('w1:p1', ID), tabId: 'w1:inny' },
        { paneId: 'w1:p8', tabId: 'w1:p1t', workspaceId: 'w1', cwd: CWD, tokens: {}, label: null },
      ];
    };

    await h.backend.reconcile();

    expect(h.herdr.renamed.filter((call) => call.kind === 'tab')).toEqual([]);
    expect(h.logs.some((line) => line.includes('changed before relabel'))).toBe(true);
  });

  it('`RAROG_HERDR_TAB_LABELS=0` — ani odczytu taba, ani zmiany etykiety', async () => {
    const h = makeHarness({ panes: [marked('w1:p1', ID)], env: { RAROG_HERDR_TAB_LABELS: '0' } });
    h.herdr.tabLabels.set('w1:p1t', '1');

    await h.backend.reconcile();

    expect(h.herdr.tabReads).toEqual([]);
    expect(h.herdr.renamed).toEqual([]);
  });

  it('timeout `tab.rename` (wynik nieznany) — następny przebieg sprawdza tab jeszcze raz', async () => {
    const h = makeHarness({ panes: [marked('w1:p1', ID)] });
    h.herdr.tabLabels.set('w1:p1t', '1');
    h.herdr.tabRenameOutcome = 'timeout';

    await h.backend.reconcile();
    h.herdr.tabRenameOutcome = 'ok';
    await h.backend.reconcile();

    expect(h.herdr.renamed.filter((call) => call.kind === 'tab')).toEqual([
      { kind: 'tab', id: 'w1:p1t', label: 'rarog 1 · rarog' },
      { kind: 'tab', id: 'w1:p1t', label: 'rarog 1 · rarog' },
    ]);
    expect(h.herdr.tabLabels.get('w1:p1t')).toBe('rarog 1 · rarog');
  });

  it('bramka zapisu odbija `tab.rename` (nieznany protokół) — jedna linia, koniec migracji przebiegu', async () => {
    const h = makeHarness({ panes: [marked('w1:p1', ID), marked('w1:p2', termIdFor(CWD, 2))] });
    h.herdr.tabLabels.set('w1:p1t', '1');
    h.herdr.tabLabels.set('w1:p2t', '1');
    h.herdr.tabRenameOutcome = 'read-only';

    await h.backend.reconcile();

    expect(h.herdr.renamed).toHaveLength(1);
    expect(h.logs.filter((line) => line.includes('tab labels read-only'))).toHaveLength(1);
  });
});

describe('ensureSession po odzyskiwaniu — nigdy drugi tab obok sieroty', () => {
  it('`POST` na sierotę odzyskuje JEJ panel zamiast zakładać nowy', async () => {
    const h = makeHarness({ panes: [HOST_PANE, orphan('w1:p4', ID)] });

    const handle = await h.backend.ensureSession(ID, CWD);

    expect(handle).toEqual({ ref: 'w1:p4', id: ID, fresh: false });
    expect(h.herdr.created.tabs).toEqual([]);
  });

  /*
   * Timeout gniazda NIE mówi, czy mutacja przeszła. Tu przeszła, a zginęła tylko odpowiedź —
   * świeży odczyt pod mutexem widzi token i oddaje ten sam panel.
   */
  it('zgubiona odpowiedź po skutecznym przywróceniu tokenu → bez drugiego taba', async () => {
    const h = makeHarness({ panes: [HOST_PANE, orphan('w1:p4', ID)] });
    h.herdr.stampOutcome = 'timeout-applied';

    const handle = await h.backend.ensureSession(ID, CWD);

    expect(handle).toEqual({ ref: 'w1:p4', id: ID, fresh: false });
    expect(h.herdr.created.tabs).toEqual([]);
    expect(h.logs.some((line) => line.includes('result unknown'))).toBe(true);
  });

  it('wynik nieznany i token NIE wrócił → odmowa „terminal się odzyskuje", bez taba', async () => {
    const h = makeHarness({ panes: [HOST_PANE, orphan('w1:p4', ID)] });
    h.herdr.stampOutcome = 'timeout';

    await expect(h.backend.ensureSession(ID, CWD)).rejects.toThrow(say('term.recovering').text);
    expect(h.herdr.created.tabs).toEqual([]);

    // Kolejny `POST` zaczyna od nowego przebiegu odzyskiwania — gniazdo już odpowiada.
    h.herdr.stampOutcome = 'ok';
    expect(await h.backend.ensureSession(ID, CWD)).toEqual({ ref: 'w1:p4', id: ID, fresh: false });
    expect(h.herdr.created.tabs).toEqual([]);
  });

  it('konflikt oznaczeń → odmowa ze zdaniem o konflikcie, bez taba', async () => {
    const h = makeHarness({ panes: [HOST_PANE, orphan('w1:p4', ID), orphan('w2:p4', ID)] });

    await expect(h.backend.ensureSession(ID, CWD)).rejects.toThrow(say('term.label-conflict.mac').text);
    expect(h.herdr.created.tabs).toEqual([]);
    expect(h.herdr.created.workspaces).toEqual([]);
  });

  /*
   * Plik stanu zginął (czysty `dataDir`), a powłoka zrobiła `cd` — z samego herdr nie da się
   * już odtworzyć katalogu, więc adopcja tego panelu nie podejmie. `POST`, który katalog ZNA,
   * odzyskuje go przez etykietę i zapisuje katalog z powrotem.
   */
  it('utrata `term-herdr.json` + dryf `cwd`: `POST` znający katalog odzyskuje bez duplikatu', async () => {
    const h = makeHarness({ panes: [orphan('w1:p4', ID, '/Users/testowy/gdzie-indziej')] });

    expect(h.registry.open(CWD).ok).toBe(true);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('spawn kontrolera', () => h.controllers.length === 1);

    expect(h.spawnArgs[0]?.[3]).toBe('w1:p4');
    expect(h.herdr.created.tabs).toEqual([]);
    expect(h.herdr.created.workspaces).toEqual([]);
    const state = JSON.parse(
      readFileSync(join(h.dataDir, TERM_HERDR_STATE_FILENAME), 'utf8'),
    ) as Record<string, { cwd: string }>;
    expect(state['w1:p4']?.cwd).toBe(CWD);
    h.registry.dispose();
  });

  /*
   * Przebieg z taktu i `POST` w tej samej chwili: `reconcile` jest single-flight, a zakładanie
   * czeka na ten sam przebieg pod wspólnym mutexem — jeden inwentarz, zero taba obok.
   */
  it('`POST` równolegle z przebiegiem odzyskiwania → jeden przebieg, bez taba', async () => {
    const h = makeHarness({ panes: [HOST_PANE, orphan('w1:p4', ID)] });
    let release: () => void = () => { /* nadpisane niżej */ };
    h.herdr.listGate = new Promise<void>((resolve) => { release = resolve; });

    const tick = h.backend.reconcile();
    const post = h.backend.ensureSession(ID, CWD);
    await flush();
    h.herdr.listGate = null;
    release();
    const [result, handle] = await Promise.all([tick, post]);

    expect(h.herdr.listIdsCalls).toBe(1);
    expect(result.restored).toEqual(['w1:p4']);
    expect(handle).toMatchObject({ ref: 'w1:p4', id: ID, fresh: false });
    expect(h.herdr.created.tabs).toEqual([]);
  });

  /*
   * Odmowa „nie teraz" nie jest padem: klient dostaje ZDANIE (ramka `err` zatrzymuje reconnect),
   * a „Spróbuj od nowa" (`POST`) liczy uchwyt od nowa.
   */
  it('odmowa dochodzi do klienta ramką `err`, a kolejny `POST` odzyskuje panel', async () => {
    const h = makeHarness({ panes: [HOST_PANE, orphan('w1:p4', ID)] });
    h.herdr.stampOutcome = 'timeout';
    h.registry.open(CWD);
    const client = new FakeClient();
    h.registry.attach(ID, client);
    await waitUntil('ramka err', () => client.events.length === 1);

    expect(client.events).toEqual([errFrame(say('term.recovering'))]);
    expect(h.registry.attach(ID, new FakeClient())).toBe('failed');
    expect(h.controllers).toHaveLength(0);

    h.herdr.stampOutcome = 'ok';
    expect(h.registry.open(CWD).ok).toBe(true);
    h.registry.attach(ID, new FakeClient());
    await waitUntil('kontroler', () => h.controllers.length === 1);
    expect(h.spawnArgs[0]?.[3]).toBe('w1:p4');
    expect(h.herdr.created.tabs).toEqual([]);
    h.registry.dispose();
  });
});

describe('odzyskiwanie pod killswitchami i po `dispose` — zero mutacji', () => {
  it('`RAROG_HERDR_LAUNCH=0`: ani odczytu, ani mutacji', async () => {
    const h = makeHarness({ panes: [orphan('w1:p1', ID), OWN_PANE], env: { RAROG_HERDR_LAUNCH: '0' } });

    expect((await h.backend.reconcile()).ran).toBe(false);
    expect(h.herdr.listCalls).toBe(0);
    expect(h.herdr.stamped).toEqual([]);
    expect(h.herdr.renamed).toEqual([]);
    expect(h.logs.some((line) => line.includes('skipped — herdr-launch-off'))).toBe(true);
  });

  it('`RAROG_HERDR_SEND=0`: ani odczytu, ani mutacji', async () => {
    const h = makeHarness({ panes: [orphan('w1:p1', ID), OWN_PANE], env: { RAROG_HERDR_SEND: '0' } });

    expect((await h.backend.reconcile()).ran).toBe(false);
    expect(h.herdr.listCalls).toBe(0);
    expect(h.herdr.stamped).toEqual([]);
    expect(h.herdr.renamed).toEqual([]);
  });

  /*
   * Nieznany protokół herdr: gniazdo przełącza się w tryb tylko-do-odczytu bez zmiany configu
   * i odbija KAŻDĄ mutację przed zapisem bajtów (`HerdrReadOnlyError`). Przebieg kończy
   * mutacje po pierwszym odbiciu — jedna linia logu zamiast próby na każdym panelu.
   */
  it('nieznany protokół: jedna odbita próba, linia logu, zero skutków w herdr', async () => {
    const h = makeHarness({
      panes: [orphan('w1:p1', ID), orphan('w1:p2', termIdFor(CWD, 2)), { ...OWN_PANE, paneId: 'w1:p3' }],
    });
    h.herdr.stampOutcome = 'read-only';
    h.herdr.renameOutcome = 'read-only';

    const result = await h.backend.reconcile();

    expect(h.herdr.applied).toBe(0);
    expect(h.herdr.stamped.length + h.herdr.renamed.length).toBe(1);
    expect(result.restored).toEqual([]);
    expect(h.logs.some((line) => line.includes('pane recovery read-only'))).toBe(true);
  });

  it('`dispose` w trakcie przebiegu: zero mutacji', async () => {
    const h = makeHarness({ panes: [orphan('w1:p1', ID)] });
    let release: () => void = () => { /* nadpisane niżej */ };
    h.herdr.listGate = new Promise<void>((resolve) => { release = resolve; });

    const pass = h.backend.reconcile();
    await flush();
    h.backend.dispose();
    h.herdr.listGate = null;
    release();

    expect((await pass).ran).toBe(false);
    expect(h.herdr.stamped).toEqual([]);
    // Zamknięty backend nie zakłada też nowych paneli.
    await expect(h.backend.ensureSession(termIdFor(CWD, 2), CWD)).rejects.toThrow('backend closed');
    expect(h.herdr.created.tabs).toEqual([]);
  });
});

describe('nowy panel terminala dostaje etykietę pochodzenia', () => {
  it('`tab.create` → token BEZ TTL i etykieta panelu `<etykieta taba> · rarog-term <id>`', async () => {
    const h = makeHarness({ panes: [HOST_PANE] });

    const handle = await h.backend.ensureSession(ID, CWD);

    expect(handle).toEqual({ ref: 'w1:p9', id: ID, fresh: true });
    expect(h.herdr.stamped).toEqual([{
      paneId: 'w1:p9', source: RAROG_TERM_METADATA_SOURCE, tokens: { [RAROG_TERM_TOKEN]: ID },
    }]);
    // `tab.create` niesie etykietę taba sam — `tab.rename` nie jest potrzebne.
    expect(h.herdr.renamed).toEqual([{ kind: 'pane', id: 'w1:p9', label: termPaneLabel(ID, 'rarog 1 · rarog') }]);
  });

  it('`workspace.create` → tab dostaje etykietę roli zamiast herdrowego „1"', async () => {
    const lazy = termIdFor(CWD, 0, 'lazygit');
    const h = makeHarness({ panes: [] });

    await h.backend.ensureSession(lazy, CWD, 'lazygit');

    expect(h.herdr.renamed).toEqual([
      { kind: 'pane', id: 'wNEW:p1', label: termPaneLabel(lazy, 'rarog lazygit · rarog') },
      { kind: 'tab', id: 'wNEW:t1', label: 'rarog lazygit · rarog' },
    ]);
  });

  it('nieudana etykieta panelu zamyka świeży tab i przerywa zakładanie', async () => {
    const h = makeHarness({ panes: [HOST_PANE] });
    h.herdr.renameOutcome = 'error';

    await expect(h.backend.ensureSession(ID, CWD)).rejects.toThrow('pane.rename odrzucone');
    expect(h.herdr.closedTabs).toEqual(['w1:t9']);
  });
});

/*
 * Restart herdr zabija procesy paneli i odtwarza je samą
 * powłoką, więc odzyskany panel lazygita pokazuje prompt. `Cmd+G` jest jawną prośbą o lazygit,
 * a panel jest Raroga — zamykamy go i zakładamy świeży, do którego rejestr wpisze start.
 */
describe('`Cmd+G` na zastanym panelu lazygita z gołą powłoką', () => {
  const LAZY = termIdFor(CWD, 0, 'lazygit');
  const STALE: HerdrPaneInfo = {
    paneId: 'w1:p5', tabId: 'w1:t5', workspaceId: 'w1', cwd: CWD,
    tokens: { [RAROG_TERM_TOKEN]: LAZY }, label: termPaneLabel(LAZY),
  };
  const typedStart = (ctl: FakeController | undefined): boolean => ctl?.sent.some(
    (frame) => frame['type'] === 'terminal.input' && frame['text'] === TERM_LAZYGIT_START_INPUT,
  ) === true;

  it('goła powłoka → `pane.close` starego i świeży panel ze startem lazygita', async () => {
    const h = makeHarness({ panes: [HOST_PANE, STALE] });

    h.registry.open(CWD, 1, 'lazygit');
    h.registry.attach(LAZY, new FakeClient());
    await waitUntil('kontroler', () => h.controllers.length === 1);

    expect(h.herdr.closedPanes).toEqual(['w1:p5']);
    // Dwa odczyty procesu (decyzja + potwierdzenie tuż przed zamknięciem).
    expect(h.herdr.processReads).toEqual(['w1:p5', 'w1:p5']);
    expect(h.herdr.created.tabs).toHaveLength(1);
    expect(h.spawnArgs[0]?.[3]).toBe('w1:p9');
    h.controllers[0]?.frame('$ ', true);
    await waitUntil('start lazygita', () => typedStart(h.controllers[0]));
    h.registry.dispose();
  });

  it('żywy lazygit → ponowne użycie: zero zamknięć i zero wpisanego startu', async () => {
    const h = makeHarness({ panes: [HOST_PANE, STALE] });
    h.herdr.processes = [{ pid: 7, name: 'lazygit', argv0: 'lazygit' }];

    h.registry.open(CWD, 1, 'lazygit');
    h.registry.attach(LAZY, new FakeClient());
    await waitUntil('kontroler', () => h.controllers.length === 1);
    h.controllers[0]?.frame('lazygit', true);
    await flush();

    expect(h.herdr.closedPanes).toEqual([]);
    expect(h.herdr.created.tabs).toEqual([]);
    expect(h.spawnArgs[0]?.[3]).toBe('w1:p5');
    expect(typedStart(h.controllers[0])).toBe(false);
    h.registry.dispose();
  });

  /*
   * Węziej niż „nie lazygit": edytor otwarty z lazygita (`e`) stoi na pierwszym planie z własną
   * nazwą, a w nim niezapisany bufor. Zamykamy wyłącznie gołą powłokę.
   */
  it('inny program na pierwszym planie (edytor) → panel zostaje', async () => {
    const h = makeHarness({ panes: [HOST_PANE, STALE] });
    h.herdr.processes = [{ pid: 9, name: 'nvim', argv0: 'nvim' }];

    expect(await h.backend.ensureSession(LAZY, CWD, 'lazygit', { explicit: true }))
      .toEqual({ ref: 'w1:p5', id: LAZY, fresh: false });
    expect(h.herdr.closedPanes).toEqual([]);
  });

  it('zmiana między odczytami (lazygit wstał) → bez zamknięcia, ramka `err` ze zdaniem', async () => {
    const h = makeHarness({ panes: [HOST_PANE, STALE] });
    h.herdr.processQueue = [
      [{ pid: 1, name: 'zsh', argv0: 'zsh' }],
      [{ pid: 7, name: 'lazygit', argv0: 'lazygit' }],
    ];

    h.registry.open(CWD, 1, 'lazygit');
    const client = new FakeClient();
    h.registry.attach(LAZY, client);
    await waitUntil('ramka err', () => client.events.length === 1);

    expect(client.events).toEqual([errFrame(say('term.lazygit-changed'))]);
    expect(h.herdr.closedPanes).toEqual([]);
    expect(h.herdr.created.tabs).toEqual([]);
    h.registry.dispose();
  });

  it('zmiana między odczytami (panel stracił token) → bez zamknięcia', async () => {
    const h = makeHarness({ panes: [HOST_PANE, STALE] });
    h.herdr.afterProcessRead = () => {
      h.herdr.panes = h.herdr.panes.map((pane) => (pane.paneId === 'w1:p5' ? { ...pane, tokens: {} } : pane));
      h.herdr.afterProcessRead = null;
    };

    await expect(h.backend.ensureSession(LAZY, CWD, 'lazygit', { explicit: true }))
      .rejects.toThrow(say('term.lazygit-changed').text);
    expect(h.herdr.closedPanes).toEqual([]);
    expect(h.herdr.created.tabs).toEqual([]);
  });

  it('adopcja (bez jawnej prośby) nie czyta procesu i niczego nie zamyka', async () => {
    const h = makeHarness({ panes: [HOST_PANE, STALE] });

    h.registry.open(CWD, 1, 'lazygit', { adopt: true });
    h.registry.attach(LAZY, new FakeClient());
    await waitUntil('kontroler', () => h.controllers.length === 1);

    expect(h.herdr.processReads).toEqual([]);
    expect(h.herdr.closedPanes).toEqual([]);
    expect(h.spawnArgs[0]?.[3]).toBe('w1:p5');
    h.registry.dispose();
  });

  /*
   * Najczęstsza droga w praktyce: takt odzyskiwania (albo restart Raroga) ADOPTUJE sierotę
   * lazygita, a człowiek dopiero potem naciska `Cmd+G`. Wpis już istnieje, więc decyzja musi
   * zapaść przy jego ponownym otwarciu — i start ma pójść do NOWEGO panelu.
   */
  it('zaadoptowany wpis + `Cmd+G` → sprawdzenie, świeży panel i start lazygita', async () => {
    const h = makeHarness({ panes: [HOST_PANE, STALE] });
    h.registry.open(CWD, 1, 'lazygit', { adopt: true });
    await flush();
    expect(h.herdr.processReads).toEqual([]);

    expect(h.registry.open(CWD, 1, 'lazygit')).toMatchObject({ ok: true, id: LAZY });
    h.registry.attach(LAZY, new FakeClient());
    await waitUntil('kontroler', () => h.controllers.length === 1);

    expect(h.herdr.closedPanes).toEqual(['w1:p5']);
    expect(h.spawnArgs[0]?.[3]).toBe('w1:p9');
    h.controllers[0]?.frame('$ ', true);
    await waitUntil('start lazygita', () => typedStart(h.controllers[0]));
    h.registry.dispose();
  });
});

/*
 * Adresy paneli herdr są POZYCYJNE, a przebieg odzyskiwania
 * trwa kilka `await`: decyzja z migawki `pane.list` nie jest dowodem, że pod tym adresem nadal stoi
 * TEN panel w chwili zapisu. Przed każdym stemplem i każdą etykietą — świeży odczyt i potwierdzenie.
 */
describe('reconcile — potwierdzenie panelu tuż przed zapisem', () => {
  const HUMAN = (paneId: string): HerdrPaneInfo => ({
    paneId, tabId: `${paneId}t`, workspaceId: 'w1', cwd: CWD, tokens: {}, label: null,
  });
  const replace = (h: Harness, paneId: string): void => {
    h.herdr.panes = h.herdr.panes.map((pane) => (pane.paneId === paneId ? HUMAN(paneId) : pane));
  };

  it('panel zastąpiony między `pane.list` a `listPaneIds` → zero stempla na zastępcy', async () => {
    const h = makeHarness({ panes: [orphan('w1:p1', ID)] });
    h.herdr.onListIds = () => { replace(h, 'w1:p1'); };

    const result = await h.backend.reconcile();

    expect(h.herdr.stamped).toEqual([]);
    expect(result.restored).toEqual([]);
    expect(h.herdr.panes[0]?.tokens).toEqual({});
    expect(h.logs.some((line) => line.includes('changed before write'))).toBe(true);
  });

  it('panel zastąpiony w trakcie WCZEŚNIEJSZEJ mutacji przebiegu → zero stempla na zastępcy', async () => {
    const drugi = termIdFor(CWD, 2);
    const h = makeHarness({ panes: [orphan('w1:p1', ID), orphan('w1:p2', drugi)] });
    h.herdr.onStamp = () => { replace(h, 'w1:p2'); h.herdr.onStamp = null; };

    const result = await h.backend.reconcile();

    expect(h.herdr.stamped.map((stamp) => stamp.paneId)).toEqual(['w1:p1']);
    expect(result.restored).toEqual(['w1:p1']);
    expect(h.herdr.panes.find((pane) => pane.paneId === 'w1:p2')?.tokens).toEqual({});
  });

  it('migracja: panel zastąpiony przed zapisem etykiety → zero `pane.rename`', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.herdr.onListIds = () => { replace(h, OWN_PANE.paneId); };

    const result = await h.backend.reconcile();

    expect(h.herdr.renamed).toEqual([]);
    expect(result.migrated).toEqual([]);
  });
});

/*
 * Pierwsze `Cmd+G` po restarcie herdr trafia zwykle na panel lazygita, któremu
 * token wraca dopiero w przebiegu odzyskiwania TEGO otwarcia — reguła obejmuje i tę drogę.
 */
describe('panel lazygita odzyskany w tym samym otwarciu', () => {
  const LAZY = termIdFor(CWD, 0, 'lazygit');

  it('etykieta bez tokenu + goła powłoka + `Cmd+G` → zastąpienie i start lazygita', async () => {
    const h = makeHarness({ panes: [HOST_PANE, orphan('w1:p5', LAZY)] });

    h.registry.open(CWD, 1, 'lazygit');
    h.registry.attach(LAZY, new FakeClient());
    await waitUntil('kontroler', () => h.controllers.length === 1);

    expect(h.herdr.closedPanes).toEqual(['w1:p5']);
    expect(h.spawnArgs[0]?.[3]).toBe('w1:p9');
    h.controllers[0]?.frame('$ ', true);
    await waitUntil('start lazygita', () => h.controllers[0]?.sent.some(
      (frame) => frame['type'] === 'terminal.input' && frame['text'] === TERM_LAZYGIT_START_INPUT,
    ) === true);
    h.registry.dispose();
  });

  it('ta sama sierota przy ADOPCJI (bez jawnej prośby) → token wraca, panel zostaje', async () => {
    const h = makeHarness({ panes: [HOST_PANE, orphan('w1:p5', LAZY)] });

    expect(await h.backend.ensureSession(LAZY, CWD, 'lazygit'))
      .toEqual({ ref: 'w1:p5', id: LAZY, fresh: false });
    expect(h.herdr.processReads).toEqual([]);
    expect(h.herdr.closedPanes).toEqual([]);
  });
});

/*
 * `dispose()` w trakcie odczytu pod mutexem nie zatrzymywał zakładania, a droga
 * ponownego użycia stemplowała token bez bramki. Po zamknięciu backendu — zero dalszych mutacji.
 */
describe('`dispose` w trakcie `ensureSession` — zero dalszych mutacji', () => {
  it('w trakcie odczytu pod mutexem przed zakładaniem: bez taba, stempla i etykiety', async () => {
    const h = makeHarness({ panes: [HOST_PANE] });
    // 1: odczyt `ensureSession`, 2: przebieg odzyskiwania, 3: świeży odczyt pod mutexem.
    h.herdr.onList = (call) => { if (call === 3) h.backend.dispose(); };

    await expect(h.backend.ensureSession(ID, CWD)).rejects.toThrow('backend closed');
    expect(h.herdr.created.tabs).toEqual([]);
    expect(h.herdr.created.workspaces).toEqual([]);
    expect(h.herdr.stamped).toEqual([]);
    expect(h.herdr.renamed).toEqual([]);
  });

  it('w trakcie odczytu przy ponownym użyciu panelu: bez stempla', async () => {
    const h = makeHarness({ panes: [OWN_PANE] });
    h.herdr.onList = (call) => { if (call === 1) h.backend.dispose(); };

    await expect(h.backend.ensureSession(ID, CWD)).rejects.toThrow('backend closed');
    expect(h.herdr.stamped).toEqual([]);
  });
});
