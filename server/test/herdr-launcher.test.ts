/**
 * Zakładanie panelu w herdr — jedyne miejsce w Rarogu, które URUCHAMIA PROCES na Macu.
 *
 * Testy są tu nieproporcjonalnie podejrzliwe wobec KOLEJNOŚCI i wobec tego, czego NIE MA:
 * po wycięciu SDK znika `canUseTool`, więc nie istnieje już żadna bramka, która egzekwowałaby
 * zgodę w procesie Raroga. Zostaje dyscyplina: nic nie powstaje przed sprawdzeniem zaufania,
 * `env` zawsze zeruje zmienne wyłączające transkrypt, a to, co Rarog stworzył i czego nie
 * dokończył, jest sprzątane.
 *
 * Klient herdr jest fake'iem z licznikami — testy nie dotykają gniazda i nie zależą od
 * uruchomionego herdr (w sandboksie `listen` na unix socketcie i tak dostaje EPERM).
 */
import { describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  AGENT_GONE_AT_START_LOG, DEFAULT_CLAUDE_ENV_CLEAR, RAROG_METADATA_SOURCE, createHerdrLauncher,
  isNameTakenError, newRarogAgentName, sanitizePaneTitle,
} from '../src/herdr/launcher.ts';
import { createProjectPlacement } from '../src/herdr/project-workspace.ts';
import type { ProjectPlacement } from '../src/herdr/project-workspace.ts';
import { claudePaneLabel, labelTrace, parsePaneLabel, projectKey } from '../src/herdr/provenance.ts';
import type { HerdrLaunchProbe, HerdrLaunchRegistration } from '../src/herdr/launcher.ts';
// `HerdrUntrustedCwdError` nie jest już rzucany przez launcher (brak zaufania to
// ostrzeżenie `trustPrompt`, nie odmowa) — klasa zostaje w `types.ts` wraz z uzasadnieniem.
import { HerdrUnavailableError } from '../src/herdr/socket.ts';
import { HerdrError, HerdrGoneError, HerdrLaunchTimeoutError } from '../src/herdr/types.ts';
import type {
  HerdrCreateTabParams, HerdrCreateWorkspaceParams, HerdrLaunchClient, HerdrPaneInfo,
  HerdrPaneMetadataParams, HerdrPaneProcess, HerdrStartAgentParams, HerdrWorkspaceInfo,
} from '../src/herdr/types.ts';

// ---------------------------------------------------------------------------
// Fixture `pane.list` (27 paneli, 14 katalogów) — jedyna odpowiedź herdr z `cwd`
// ---------------------------------------------------------------------------

const FIXTURE = join(import.meta.dirname, 'fixtures', 'herdr', 'pane-list.json');

/**
 * Surowy `pane.list` → `HerdrPaneInfo[]`.
 *
 * Mapowanie jest tu, a nie w teście klienta, bo `HerdrLaunchClient` powstaje po stronie
 * S-managera. Kształt bierzemy z pliku, więc gdy klient zacznie istnieć, oba i tak
 * czytają to samo źródło.
 */
function loadPanes(): HerdrPaneInfo[] {
  const raw: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const panes = (raw as { result: { panes: readonly Record<string, unknown>[] } }).result.panes;
  return panes.map((pane): HerdrPaneInfo => ({
    paneId: String(pane['pane_id'] ?? ''),
    tabId: String(pane['tab_id'] ?? ''),
    workspaceId: String(pane['workspace_id'] ?? ''),
    cwd: String(pane['cwd'] ?? ''),
    // W zrzucie NIE MA ani jednego `tokens` (metadane wygasły) — brak pola musi
    // znaczyć „nie mój panel", a nie „błąd kształtu". Etykiet paneli też nie ma.
    tokens: {},
    label: null,
  }));
}

const PANES = loadPanes();

/**
 * `workspace.list` do fixture'a: każdy workspace z etykietą = nazwa katalogu jego PIERWSZEGO
 * panelu — tak herdr nazywa projekt i tak szuka go resolver. `wN` (harbor i kelp) nazywa się więc
 * „harbor", a katalog `kelp` workspace'u nie ma.
 */
function workspacesOf(panes: readonly HerdrPaneInfo[]): HerdrWorkspaceInfo[] {
  const out = new Map<string, HerdrWorkspaceInfo>();
  for (const pane of panes) {
    if (!out.has(pane.workspaceId)) {
      out.set(pane.workspaceId, { workspaceId: pane.workspaceId, label: basename(pane.cwd) });
    }
  }
  return [...out.values()];
}

/** Katalog, który w fixture ma panel — workspace `w9`. */
const KNOWN_CWD = '/Users/u/Projects/demo';
const KNOWN_WORKSPACE = 'w9';
/** Katalog spoza fixture — nie ma workspace'a, więc trzeba go założyć. */
const NEW_CWD = '/Users/u/Projects/nowy';

// ---------------------------------------------------------------------------
// Fake klienta z licznikami
// ---------------------------------------------------------------------------

interface FakeCalls {
  listPanes: number;
  listWorkspaces: number;
  createTab: HerdrCreateTabParams[];
  createWorkspace: HerdrCreateWorkspaceParams[];
  startAgent: HerdrStartAgentParams[];
  metadata: HerdrPaneMetadataParams[];
  renamePane: { paneId: string; label: string | null }[];
  renameTab: { tabId: string; label: string }[];
  closeTab: string[];
  screenReads: number;
  /** Panele, o których procesy pytał launcher (`pane.process_info`). */
  processReads: string[];
  /** Kolejność metod tworzących — krok 6 ma iść PO `agent.start`, a `tab.rename` przed nim. */
  order: string[];
}

interface FakeOptions {
  panes?: readonly HerdrPaneInfo[];
  /** `workspace.list`; domyślnie {@link workspacesOf} paneli. */
  workspaces?: readonly HerdrWorkspaceInfo[];
  /**
   * Panel z `workspace.create`/`tab.create` NIE pojawia się w `pane.list` — herdr, który nie zdążył
   * go jeszcze pokazać (most: pamięć „założyłem" w zamku projektu).
   */
  hideCreatedPanes?: boolean;
  /** Zamek projektu; domyślnie własny na każdy `setup` (pamięć nie przecieka między testami). */
  placement?: ProjectPlacement;
  trusted?: boolean;
  /** Kolejne odpowiedzi `agent.get`; ostatnia powtarza się w nieskończoność. */
  probes?: readonly HerdrLaunchProbe[];
  probeError?: unknown;
  startAgentError?: unknown;
  /** Ile pierwszych wywołań `agent.start` ma paść na `startAgentError`. */
  startAgentFailures?: number;
  metadataError?: unknown;
  renamePaneError?: unknown;
  renameTabError?: unknown;
  screenText?: string;
  sessionId?: string;
  readyTimeoutMs?: number;
  envClear?: readonly string[];
  /** `pane.process_info` panelu; domyślnie pusta lista (powłoka bez procesu na pierwszym planie). */
  foreground?: readonly HerdrPaneProcess[];
  /** `pane.process_info` rzuca — linia porażki startu i tak powstaje (`foreground: unknown`). */
  foregroundError?: unknown;
}

interface Fake {
  launcher: ReturnType<typeof createHerdrLauncher>;
  calls: FakeCalls;
  logs: string[];
  registrations: HerdrLaunchRegistration[];
  /** Sygnały `paneLabelled`: klucz i metody tworzące, które poszły PRZED nim. */
  labelled: { key: string; after: string[] }[];
  names: string[];
  clock(): number;
}

const READY: HerdrLaunchProbe = {
  agentSessionId: '', status: 'idle', interactiveReady: true,
};

function setup(opts: FakeOptions = {}): Fake {
  const sessionId = opts.sessionId ?? '11111111-2222-4333-8444-555555555555';
  const calls: FakeCalls = {
    listPanes: 0, listWorkspaces: 0, createTab: [], createWorkspace: [], startAgent: [], metadata: [],
    renamePane: [], renameTab: [], closeTab: [], screenReads: 0, processReads: [], order: [],
  };
  const logs: string[] = [];
  const registrations: HerdrLaunchRegistration[] = [];
  const labelled: { key: string; after: string[] }[] = [];
  const names: string[] = [];
  let clock = 1_000_000;
  let probeIndex = 0;

  const probes = opts.probes ?? [{ ...READY, agentSessionId: sessionId }];
  /*
   * Stan herdr: panele i workspace'y rosną z każdym `workspace.create`/`tab.create`, jak w herdr —
   * drugie zakładanie w tym samym katalogu musi zobaczyć to, co założyło pierwsze (zamek).
   */
  const panes: HerdrPaneInfo[] = [...(opts.panes ?? PANES)];
  const workspaces: HerdrWorkspaceInfo[] = [...(opts.workspaces ?? workspacesOf(panes))];
  const addPane = (pane: HerdrPaneInfo): void => {
    if (opts.hideCreatedPanes !== true) panes.push(pane);
  };

  const client: HerdrLaunchClient = {
    async listPaneIds(): Promise<ReadonlySet<string>> {
      return new Set(panes.map((pane) => pane.paneId));
    },
    async listWorkspaces(): Promise<HerdrWorkspaceInfo[]> {
      calls.listWorkspaces += 1;
      return [...workspaces];
    },
    // Historia panelu (`pane.read`) — launcher jej nie dotyka; stub trzyma kontrakt.
    readPaneHistory: async () => ({ text: '', truncated: false }),
    // Procesy panelu czyta launcher tylko po porażce startu (linia logu) — na SWOIM panelu.
    async readPaneProcess(paneId: string) {
      calls.processReads.push(paneId);
      if (opts.foregroundError !== undefined) throw opts.foregroundError;
      return { processes: opts.foreground ?? [] };
    },
    // `tab.get` czyta nadzorca (synchronizacja etykiety taba) i terminal — launcher nigdy.
    getTab: (tabId: string) => Promise.reject(new Error(`launcher nie czyta tabów (${tabId})`)),
    async listPanes(): Promise<HerdrPaneInfo[]> {
      calls.listPanes += 1;
      return [...panes];
    },
    async createWorkspace(params: HerdrCreateWorkspaceParams) {
      calls.createWorkspace.push(params);
      calls.order.push('workspace.create');
      workspaces.push({ workspaceId: 'wZ', label: params.label ?? basename(params.cwd) });
      addPane({
        paneId: 'wZ:p1', tabId: 'wZ:t1', workspaceId: 'wZ', cwd: params.cwd, tokens: {}, label: null,
      });
      return { workspaceId: 'wZ', tabId: 'wZ:t1', paneId: 'wZ:p1' };
    },
    async createTab(params: HerdrCreateTabParams) {
      calls.createTab.push(params);
      calls.order.push('tab.create');
      addPane({
        paneId: `${params.workspaceId}:p9`, tabId: `${params.workspaceId}:t9`,
        workspaceId: params.workspaceId, cwd: params.cwd, tokens: {}, label: null,
      });
      return { tabId: `${params.workspaceId}:t9`, paneId: `${params.workspaceId}:p9` };
    },
    async startAgent(params: HerdrStartAgentParams) {
      calls.startAgent.push(params);
      calls.order.push('agent.start');
      names.push(params.name);
      const failures = opts.startAgentFailures ?? (opts.startAgentError === undefined ? 0 : 99);
      if (opts.startAgentError !== undefined && calls.startAgent.length <= failures) {
        throw opts.startAgentError;
      }
      return { argv: ['claude', ...params.args] };
    },
    async reportPaneMetadata(params: HerdrPaneMetadataParams): Promise<void> {
      calls.metadata.push(params);
      calls.order.push('pane.report_metadata');
      if (opts.metadataError !== undefined) throw opts.metadataError;
    },
    async renamePane(paneId: string, label: string | null): Promise<void> {
      calls.renamePane.push({ paneId, label });
      calls.order.push('pane.rename');
      if (opts.renamePaneError !== undefined) throw opts.renamePaneError;
    },
    async renameTab(tabId: string, label: string): Promise<void> {
      calls.renameTab.push({ tabId, label });
      calls.order.push('tab.rename');
      if (opts.renameTabError !== undefined) throw opts.renameTabError;
    },
    async closeTab(tabId: string): Promise<void> {
      calls.closeTab.push(tabId);
    },
    // `pane.close` należy wyłącznie do terminala na backendzie herdr — launcher agentów
    // sprząta po sobie `tab.close` i nic mu do pojedynczych paneli.
    closePane(paneId: string): Promise<void> {
      return Promise.reject(new Error(`launcher nie zamyka paneli (${paneId})`));
    },
    // Sonda gotowości jest tu wstrzyknięta osobno (`deps.probeAgent`), żeby test sterował
    // kolejnymi odczytami; wersja z klienta jest domyślnikiem produkcyjnym i nie ma prawa
    // się tu odezwać.
    probeAgent(): Promise<never> {
      throw new Error('nieużywane: sonda jest wstrzyknięta przez `deps.probeAgent`');
    },
  };

  const launcher = createHerdrLauncher({
    client,
    placement: opts.placement ?? createProjectPlacement(),
    trust: { isTrusted: async (): Promise<boolean> => opts.trusted !== false },
    async probeAgent(): Promise<HerdrLaunchProbe> {
      if (opts.probeError !== undefined) throw opts.probeError;
      const probe = probes[Math.min(probeIndex, probes.length - 1)];
      probeIndex += 1;
      return probe ?? READY;
    },
    registerLaunch(reg: HerdrLaunchRegistration): string {
      registrations.push(reg);
      return `key-${registrations.length}`;
    },
    paneLabelled(key: string): void {
      labelled.push({ key, after: [...calls.order] });
    },
    async readScreen(): Promise<string> {
      calls.screenReads += 1;
      return opts.screenText ?? '';
    },
    now: (): number => clock,
    sleep: async (ms: number): Promise<void> => {
      clock += ms;
    },
    newSessionId: (): string => sessionId,
    logger: (message: string): void => {
      logs.push(message);
    },
    ...(opts.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: opts.readyTimeoutMs }),
    ...(opts.envClear === undefined ? {} : { envClear: opts.envClear }),
  });

  return {
    launcher, calls, logs, registrations, labelled, names, clock: (): number => clock,
  };
}

// ---------------------------------------------------------------------------
// Funkcje czyste
// ---------------------------------------------------------------------------

describe('newRarogAgentName', () => {
  it('pasuje do wzorca nazw agenta herdr i jest różna za każdym razem', () => {
    const a = newRarogAgentName();
    const b = newRarogAgentName();
    expect(a).toMatch(/^rarog-[0-9a-f]{6}$/);
    expect(a).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(a).not.toBe(b);
  });
});

describe('sanitizePaneTitle', () => {
  it('usuwa znaki sterujące i przycina długość', () => {
    expect(sanitizePaneTitle('a\u0000b\nc', 'x')).toBe('a b c');
    expect(sanitizePaneTitle('t'.repeat(200), 'x')).toHaveLength(64);
  });

  it('pusty tytuł spada na wartość zapasową', () => {
    expect(sanitizePaneTitle('   ', 'atlas')).toBe('atlas');
  });
});

describe('isNameTakenError', () => {
  it('łapie kod zdalny i tekst, ale nie łapie cudzych błędów', () => {
    expect(isNameTakenError(Object.assign(new HerdrError(foreign('x')), {
      remoteCode: 'agent_name_taken',
    }))).toBe(true);
    expect(isNameTakenError(new HerdrError(foreign('herdr: agent_name_taken')))).toBe(true);
    expect(isNameTakenError(new HerdrError(foreign('herdr: agent_pane_busy')))).toBe(false);
    expect(isNameTakenError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Procedura zakładania
// ---------------------------------------------------------------------------

describe('launch — katalog → workspace', () => {
  it('katalog z fixture → `tab.create` we właściwym workspace, ZERO `workspace.create`', async () => {
    const f = setup();
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    const result = await handle.ready;

    expect(f.calls.createTab).toHaveLength(1);
    expect(f.calls.createTab[0]?.workspaceId).toBe(KNOWN_WORKSPACE);
    expect(f.calls.createWorkspace).toHaveLength(0);
    expect(result.createdWorkspace).toBe(false);
    // Jeden odczyt paneli i jeden workspace'ów na decyzję — bez pompy.
    expect(f.calls.listPanes).toBe(1);
    expect(f.calls.listWorkspaces).toBe(1);
  });

  it('normalizuje ścieżkę zapytania (`demo/src/..` to `demo`)', async () => {
    const f = setup();
    await (await f.launcher.launch({ cwd: `${KNOWN_CWD}/src/..` })).ready;
    expect(f.calls.createTab[0]?.workspaceId).toBe(KNOWN_WORKSPACE);
  });

  it('podkatalog projektu (`fjord/apps/server`) nie dziedziczy workspace\'u `fjord` — nowy', async () => {
    // Kandydatem jest workspace NAZWANY katalogiem sesji; `fjord` nim nie jest.
    const f = setup();
    await (await f.launcher.launch({ cwd: '/Users/u/Projects/fjord/apps/server' })).ready;
    expect(f.calls.createTab).toHaveLength(0);
    expect(f.calls.createWorkspace[0]?.label).toBe('server');
  });

  it('drugi katalog w cudzym workspace\'ie (`kelp` w „harbor") dostaje WŁASNY workspace', async () => {
    /*
     * Sam panel z tym `cwd` w `wN` nie czyni go workspace'em `kelp`. Workspace „harbor" nie jest
     * kandydatem `kelp` (etykieta ≠ nazwa katalogu, brak checkoutu) — cena: nowy workspace dla
     * katalogu bez własnego.
     */
    const f = setup();
    await (await f.launcher.launch({ cwd: '/Users/u/Projects/kelp' })).ready;
    expect(f.calls.createTab).toHaveLength(0);
    expect(f.calls.createWorkspace[0]?.label).toBe('kelp');
  });

  it('katalog nieznany → `workspace.create`, ZERO `tab.create`', async () => {
    const f = setup();
    const handle = await f.launcher.launch({ cwd: NEW_CWD });
    const result = await handle.ready;

    expect(f.calls.createWorkspace).toHaveLength(1);
    expect(f.calls.createWorkspace[0]?.cwd).toBe(NEW_CWD);
    expect(f.calls.createTab).toHaveLength(0);
    expect(result.createdWorkspace).toBe(true);
  });

  it('pusty `pane.list` (świeży herdr) → `workspace.create`', async () => {
    const f = setup({ panes: [] });
    await (await f.launcher.launch({ cwd: KNOWN_CWD })).ready;
    expect(f.calls.createWorkspace).toHaveLength(1);
  });
});

describe('launch — env nowego panelu', () => {
  it('ZAWSZE zeruje `CLAUDECODE` i `CLAUDE_CODE_CHILD_SESSION`', async () => {
    // Bez tego `claude` pokazuje „Transcript saving is off" i NIE POWSTAJE plik jsonl —
    // czyli cała warstwa treści Raroga (wiadomości, usage, model, czekające narzędzie)
    // znika po cichu, a Rarog pokazuje pustą, „działającą" sesję.
    const f = setup();
    await (await f.launcher.launch({ cwd: KNOWN_CWD })).ready;
    const env = f.calls.createTab[0]?.env;
    expect(env?.['CLAUDECODE']).toBe('');
    expect(env?.['CLAUDE_CODE_CHILD_SESSION']).toBe('');
    for (const name of DEFAULT_CLAUDE_ENV_CLEAR) expect(env?.[name]).toBe('');
  });

  /*
   * Zmierzone: prompt `[oh-my-zsh] Would you like to update? [Y/n]` w świeżym panelu herdr uznaje
   * za gotową powłokę i wpisuje komendę — `c` idzie jako odpowiedź na pytanie, reszta do powłoki
   * (`command not found: laude`). Claude nie wstaje, a karta dostaje „zniknął zaraz po starcie". Powłoka panelu Raroga nie ma
   * prawa zadawać pytań ZANIM przyjmie komendę.
   */
  it('USTAWIA `DISABLE_AUTO_UPDATE=true`, żeby oh-my-zsh nie pytał o update nad promptem', async () => {
    const f = setup();
    await (await f.launcher.launch({ cwd: KNOWN_CWD })).ready;
    const env = f.calls.createTab[0]?.env;
    expect(env?.['DISABLE_AUTO_UPDATE']).toBe('true');
    // Ustawienie wygrywa z zerowaniem tej samej nazwy — inaczej `RAROG_CLAUDE_ENV_CLEAR`
    // mogłoby po cichu przywrócić pytanie nad promptem.
    const g = setup({ envClear: ['CLAUDECODE', 'DISABLE_AUTO_UPDATE'] });
    await (await g.launcher.launch({ cwd: KNOWN_CWD })).ready;
    expect(g.calls.createTab[0]?.env?.['DISABLE_AUTO_UPDATE']).toBe('true');
  });

  it('zeruje klucze API Anthropica I token OAuth z env', async () => {
    // Panel z Raroga ma bić WYŁĄCZNIE w subskrypcję: klucz API z env herdr (jest tam,
    // zmierzone) po jednorazowym zatwierdzeniu w CC płaciłby za tokeny po cichu.
    // `CLAUDE_CODE_OAUTH_TOKEN` z env NADPISUJE świeże `/login` starym tokenem z
    // pliku sekretów powłoki — wyzerowany, panel loguje się z `~/.claude/.credentials.json`.
    const f = setup();
    await (await f.launcher.launch({ cwd: KNOWN_CWD })).ready;
    const env = f.calls.createTab[0]?.env;
    expect(env?.['ANTHROPIC_API_KEY']).toBe('');
    expect(env?.['ANTHROPIC_ADMIN_KEY']).toBe('');
    expect(env?.['ANTHROPIC_AUTH_TOKEN']).toBe('');
    expect(DEFAULT_CLAUDE_ENV_CLEAR).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('');
  });

  it('zeruje też KANAŁ ZGÓD sesji potomnej (`CLAUDE_CODE_MESSAGING_*`)', async () => {
    /*
     * Zmierzone: gdy serwer herdr wystartuje Z WNĘTRZA sesji Claude Code, panel zakładany przez
     * Raroga bez zerowania dziedziczy `CLAUDE_CODE_MESSAGING_SOCKET` i `CLAUDE_CODE_MESSAGING_TOKEN`,
     * staje się SESJĄ POTOMNĄ tamtej sesji i oddaje jej decyzje o zgodach. Skutek: `rm -f` wykonane
     * w trybie `--permission-mode manual` BEZ ŻADNEGO PYTANIA, bo pytanie idzie do rodzica
     * w `bypass permissions`.
     *
     * Po wycięciu SDK zgoda w terminalu jest JEDYNĄ bramką, jaka Rarogowi została,
     * więc jej cicha utrata jest najgorszą możliwą awarią tego modułu.
     */
    const f = setup();
    await (await f.launcher.launch({ cwd: KNOWN_CWD })).ready;
    const env = f.calls.createTab[0]?.env;
    expect(env?.['CLAUDE_CODE_MESSAGING_SOCKET']).toBe('');
    expect(env?.['CLAUDE_CODE_MESSAGING_TOKEN']).toBe('');
    expect(env?.['CLAUDE_CODE_SESSION_ID']).toBe('');
    // Poświadczenie konta bierze się z `~/.claude/.credentials.json` (/login), więc token
    // z env też jest zerowany — stary token nadpisywałby świeże logowanie.
    expect(env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('');
  });

  it('to samo dla ścieżki `workspace.create`', async () => {
    const f = setup();
    await (await f.launcher.launch({ cwd: NEW_CWD })).ready;
    const env = f.calls.createWorkspace[0]?.env;
    expect(env?.['CLAUDECODE']).toBe('');
    expect(env?.['CLAUDE_CODE_CHILD_SESSION']).toBe('');
  });

  it('pusta lista zmiennych to błąd konfiguracji, wykrywany przy składaniu zależności', () => {
    expect(() => setup({ envClear: [] })).toThrow(/RAROG_CLAUDE_ENV_CLEAR/);
  });

  it('nazwa, która nie jest zmienną środowiskową, też rzuca od razu', () => {
    expect(() => setup({ envClear: ['NIE=TAK'] })).toThrow();
  });
});

describe('launch — uchwyt przed procesem', () => {
  it('`handle` wraca ZANIM poleci `agent.start`', async () => {
    // Router odpowiada 202 z `sessionId` policzonym z `key`, a manager zdąży podpiąć driver,
    // zanim w panelu ruszy proces. Blokujący POST na ~5 s gubi telefon przy zgaszeniu ekranu.
    const f = setup();
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    expect(f.calls.startAgent).toHaveLength(0);
    expect(handle.key).toBe('key-1');
    expect(handle.paneId).toBe('w9:p9');
    expect(handle.tabId).toBe('w9:t9');
    expect(handle.agentSessionId).toBe('11111111-2222-4333-8444-555555555555');

    await handle.ready;
    expect(f.calls.startAgent).toHaveLength(1);
  });

  it('rejestracja w supervisorze zna panel, tab, uuid sesji i tytuł przed startem', async () => {
    const f = setup();
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    // `label` jedzie w rejestracji, bo dwa równoległe `launch()` są dozwolone — wspólna
    // zmienna po stronie nadzorcy gubiłaby tytuł jednego z nich.
    expect(f.registrations).toEqual([{
      paneId: 'w9:p9', tabId: 'w9:t9', agentSessionId: handle.agentSessionId, cwd: KNOWN_CWD,
      label: 'demo',
    }]);
    await handle.ready;
  });
});

describe('launch — argumenty', () => {
  it('`agent.start` dostaje flagi z allow-listy i ZERO argumentów pozycyjnych', async () => {
    const f = setup();
    const handle = await f.launcher.launch({
      cwd: KNOWN_CWD, model: 'sonnet', effort: 'high', permissionMode: 'manual',
    });
    const result = await handle.ready;

    expect(f.calls.startAgent[0]?.args).toEqual([
      '--session-id', handle.agentSessionId,
      '--model', 'sonnet',
      '--effort', 'high',
      '--permission-mode', 'manual',
    ]);
    expect(f.calls.startAgent[0]?.kind).toBe('claude');
    expect(f.calls.startAgent[0]?.name).toMatch(/^rarog-[0-9a-f]{6}$/);
    expect(result.argv).toContain('claude');
  });

  it('złe żądanie NIE tworzy niczego — walidacja argv jest przed `pane.list`', async () => {
    const f = setup();
    await expect(f.launcher.launch({ cwd: KNOWN_CWD, model: 'Model Z Wielkiej Litery' }))
      .rejects.toThrow();
    expect(f.calls.listPanes).toBe(0);
    expect(f.calls.createTab).toHaveLength(0);
    expect(f.calls.createWorkspace).toHaveLength(0);
  });
});

describe('launch — zaufanie katalogu', () => {
  it('niezaufany katalog ZAKŁADA panel i oddaje ostrzeżenie `trustPrompt`', async () => {
    /*
     * The trust dialog stays in the pane without end (measured: 40 s without a change), but it is on the closed
     * list of signatures, so the phone can confirm it, and refusing the launch would be an obstacle with no risk
     * behind it. Flaga jedzie do odpowiedzi 202 jako OSTRZEŻENIE.
     */
    const f = setup({ trusted: false });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    expect(handle.trustPrompt).toBe(true);
    expect(f.calls.createTab).toHaveLength(1);
    expect(f.registrations).toHaveLength(1);
  });

  it('katalog zaufany nie niesie ostrzeżenia', async () => {
    const f = setup({ trusted: true });
    expect((await f.launcher.launch({ cwd: KNOWN_CWD })).trustPrompt).toBeUndefined();
  });
});

describe('launch — etykieta pochodzenia panelu', () => {
  /** Klucz projektu z fixture'a: katalogu nie ma na dysku, więc realpath oddaje ścieżkę. */
  const KNOWN_KEY = projectKey(KNOWN_CWD);

  it('po `agent.start` nadaje panelowi `<tytuł> · rarog-claude <klucz> <ślad>`, a tytuł idzie bez tokenów',
    async () => {
      const f = setup();
      await (await f.launcher.launch({ cwd: KNOWN_CWD })).ready;

      // Ślad = skrót etykiety TABA nadanej przy zakładaniu (tu: `tab.create` z `label: 'demo'`).
      expect(f.calls.createTab[0]?.label).toBe('demo');
      expect(f.calls.renamePane).toEqual([
        { paneId: 'w9:p9', label: claudePaneLabel(KNOWN_KEY, labelTrace('demo'), 'demo') },
      ]);
      expect(parsePaneLabel(f.calls.renamePane[0]?.label)).toEqual({
        kind: 'claude', value: KNOWN_KEY, trace: labelTrace('demo'),
      });
      /*
       * Token `rarog` (z TTL 24 h) przestał istnieć: własność mówi nazwa agenta, pochodzenie —
       * etykieta panelu. Zostaje sam tytuł panelu, bez `ttlMs`, czyli do nadpisania albo
       * zamknięcia panelu.
       */
      expect(f.calls.metadata).toEqual([
        { paneId: 'w9:p9', source: RAROG_METADATA_SOURCE, title: 'demo' },
      ]);
      expect(f.calls.order).toEqual(['tab.create', 'agent.start', 'pane.rename', 'pane.report_metadata']);
    });

  it('po `workspace.create` od razu `tab.rename` — herdr nadaje pierwszemu tabowi „1"', async () => {
    const f = setup();
    const handle = await f.launcher.launch({ cwd: NEW_CWD });
    // Uchwyt (202) nie czeka na nazwę taba — idzie ona pierwszym krokiem części w tle,
    // przed `agent.start`.
    expect(f.calls.renameTab).toEqual([]);
    await handle.ready;
    expect(f.calls.renameTab).toEqual([{ tabId: 'wZ:t1', label: 'nowy' }]);

    expect(f.calls.order).toEqual([
      'workspace.create', 'tab.rename', 'agent.start', 'pane.rename', 'pane.report_metadata',
    ]);
    expect(f.calls.renamePane[0]?.label)
      .toBe(claudePaneLabel(projectKey(NEW_CWD), labelTrace('nowy'), 'nowy'));
  });

  it('`tab.create` niesie etykietę sam — drugiego `tab.rename` nie ma', async () => {
    const f = setup();
    await (await f.launcher.launch({ cwd: KNOWN_CWD })).ready;
    expect(f.calls.renameTab).toEqual([]);
  });

  it('etykieta taba to ten sam oczyszczony tytuł co panelu (herdr nie normalizuje)', async () => {
    // Zmierzone: `tab.rename` przyjmuje ESC i `\n` i zapisuje je surowo do snapshotu.
    const f = setup();
    await (await f.launcher.launch({ cwd: NEW_CWD, label: 'zły\u001b[31m\ntytuł' })).ready;
    const clean = sanitizePaneTitle('zły\u001b[31m\ntytuł', 'nowy');
    expect(clean).toBe('zły [31m tytuł');
    // WORKSPACE nosi nazwę katalogu (po niej pozna go resolver przy następnym starcie),
    // tytuł sesji nazywa TAB.
    expect(f.calls.createWorkspace[0]?.label).toBe('nowy');
    expect(f.calls.renameTab).toEqual([{ tabId: 'wZ:t1', label: clean }]);
    expect(f.calls.renamePane[0]?.label)
      .toBe(claudePaneLabel(projectKey(NEW_CWD), labelTrace(clean), clean));
  });

  it('błąd `pane.rename` NIE przerywa startu — log, tytuł i tak idzie', async () => {
    const f = setup({ renamePaneError: new HerdrError(foreign('herdr: pane_not_found')) });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).resolves.toMatchObject({ paneId: 'w9:p9' });
    expect(f.calls.metadata).toHaveLength(1);
    expect(f.logs.some((line) => line.includes('w9:p9') && line.includes('label'))).toBe(true);
    // Nadzorca i tak dostaje sygnał: synchronizacja etykiety taba nie ma czekać w nieskończoność
    // (bez etykiety panelu zostaje jej migracja po nazwie agenta).
    expect(f.labelled).toEqual([{ key: 'key-1', after: ['tab.create', 'agent.start', 'pane.rename'] }]);
  });

  it('sygnał `paneLabelled` idzie RAZ, zaraz PO etykiecie panelu — nadzorca rusza sync taba',
    async () => {
      const f = setup();
      const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
      // Uchwyt (202) jest przed krokiem 6 — sygnału jeszcze nie ma.
      expect(f.labelled).toEqual([]);
      await handle.ready;
      expect(f.labelled).toEqual([{ key: 'key-1', after: ['tab.create', 'agent.start', 'pane.rename'] }]);
    });

  it('nieudany `agent.start` — bez sygnału `paneLabelled` (nadzorcę zwalnia rozstrzygnięcie `ready`)',
    async () => {
      const f = setup({ startAgentError: new HerdrError(foreign('herdr: feature_disabled')) });
      const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
      await expect(handle.ready).rejects.toThrow();
      expect(f.labelled).toEqual([]);
    });

  it('błąd `tab.rename` NIE przerywa startu — tab zostaje z „1", log', async () => {
    const f = setup({ renameTabError: new HerdrError(foreign('herdr: tab_not_found')) });
    const handle = await f.launcher.launch({ cwd: NEW_CWD });
    await expect(handle.ready).resolves.toMatchObject({ paneId: 'wZ:p1' });
    expect(f.calls.startAgent).toHaveLength(1);
    expect(f.logs.some((line) => line.includes('wZ:t1'))).toBe(true);
  });

  it('błąd stempla tytułu NIE przerywa startu', async () => {
    const f = setup({ metadataError: new HerdrError(foreign('herdr: nie ma takiego panelu')) });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).resolves.toMatchObject({ paneId: 'w9:p9' });
    expect(f.calls.renamePane).toHaveLength(1);
    expect(f.calls.startAgent).toHaveLength(1);
  });
});

describe('launch — porażki', () => {
  it('`agent.start` rzuca → tab utworzony przez Raroga jest zamykany, `ready` odrzucone', async () => {
    const f = setup({ startAgentError: new HerdrError(foreign('herdr: agent_pane_busy')) });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toThrow(/agent_pane_busy/);
    expect(f.calls.closeTab).toEqual(['w9:t9']);
    // Znacznika nie stawiamy na panelu, którego nie ma po co oznaczać.
    expect(f.calls.metadata).toHaveLength(0);
    expect(f.calls.renamePane).toHaveLength(0);
  });

  it('TIMEOUT gniazda przy `agent.start` NIE zamyka taba — sierota ma być widoczna',
    async () => {
      /*
       * Dwa różne niepowodzenia, dwie różne decyzje o cudzym procesie (reguła 11.9).
       *
       * `HerdrUnavailableError` znaczy „nie wiem, co się stało": `agent.start` mógł dojść
       * i wykonać się w całości, a zgubiła się dopiero odpowiedź (timeout gniazda, zerwane
       * połączenie w trakcie startu). Ślepy `closeTab` zabijał wtedy panel z ŻYWYM, właśnie
       * uruchomionym agentem — i to bez śladu dla użytkownika. Tab zostaje: sierotę pokaże
       * resync (≤ 30 s), a koszt pomyłki w tę stronę to jeden panel do zamknięcia ręcznie
       * zamiast ubitej sesji.
       */
      const f = setup({
        startAgentError: new HerdrUnavailableError(
          foreign('Przekroczony czas odpowiedzi herdr (agent.start).'),
        ),
      });
      const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

      await expect(handle.ready).rejects.toBeInstanceOf(HerdrUnavailableError);
      expect(f.calls.closeTab).toEqual([]);
      // Ślad w logu, bo panel zostaje po nas i ktoś musi wiedzieć, dlaczego.
      expect(f.logs.some((line) => line.includes('STAYS'))).toBe(true);
    });

  it('padnięte gniazdo w trakcie `agent.start` też zostawia tab', async () => {
    // Ta sama klasa błędu, inny powód — decyzja zależy od WIEDZY o wyniku, nie od treści.
    const f = setup({
      startAgentError: new HerdrUnavailableError(foreign('Błąd gniazda herdr: ECONNRESET')),
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).rejects.toBeInstanceOf(HerdrUnavailableError);
    expect(f.calls.closeTab).toEqual([]);
    // I żadnego ponawiania: „nie wiem" nie jest sytuacją przejściową jak zajęta nazwa.
    expect(f.calls.startAgent).toHaveLength(1);
  });

  it('timeout gotowości NIE zamyka panelu', async () => {
    // Panel może stać na dialogu i za chwilę ruszyć — zabicie go byłoby gorsze niż
    // wisząca karta, którą użytkownik widzi i rozumie.
    const f = setup({
      probes: [{ agentSessionId: '', status: 'idle', interactiveReady: false }],
      readyTimeoutMs: 1000,
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toThrow(HerdrLaunchTimeoutError);
    expect(f.calls.closeTab).toEqual([]);
  });

  it('timeout gotowości mówi, że panel żyje, i pokazuje ogon ekranu', async () => {
    // Zimny start `claude` (wtyczki, marketplace'y, Mac pod obciążeniem) potrafi przekroczyć
    // limit, a panel i tak za chwilę wstanie. Karta nie może wtedy brzmieć jak
    // nekrolog — a ogon ekranu mówi, na czym start stanął.
    const f = setup({
      probes: [{ agentSessionId: '', status: 'idle', interactiveReady: false }],
      readyTimeoutMs: 1000,
      screenText: 'Claude Code v2.1\nLoading plugins…',
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toThrow(
      /ready within 1\ss\. The pane is still running; check it in herdr\. Screen: Claude Code v2\.1\s+Loading plugins/,
    );
    await expect(handle.ready).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.launch-timeout.screen' } } });
    expect(f.calls.screenReads).toBe(1);
  });

  it('herdr 0.9.0: rekord startu wygasł, agent wykryty sam (bez `interactive_ready`) → gotowy ze statusu', async () => {
    /*
     * herdr 0.9.0, CLI 2.1.266: `claude` wstaje po 9 s, rekord startu (`timeout_ms` 10 s) wygasa,
     * herdr wykrywa agenta sam — `agent.get` bez `name`, bez `launch_pending` i bez
     * `interactive_ready` już na zawsze. Launcher czekający na flagę pokazałby po 60 s „nie zgłosił
     * gotowości" przy panelu, który przyjmuje prompty.
     */
    const uuid = '11111111-2222-4333-8444-555555555555';
    const f = setup({
      sessionId: uuid,
      probes: [
        { agentSessionId: '', status: 'unknown', interactiveReady: null, launchPending: true },
        { agentSessionId: uuid, status: 'unknown', interactiveReady: null, launchPending: true },
        { agentSessionId: uuid, status: 'idle', interactiveReady: null },
      ],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    const result = await handle.ready;

    expect(result.interactiveReady).toBe(true);
    expect(result.status).toBe('idle');
    expect(f.logs.some((l) => l.includes('launch record expired'))).toBe(true);
  });

  it('herdr 0.9.0: `launch_pending: true` bez `interactive_ready` to dalej CZEKANIE, nie gotowość', async () => {
    // Status `idle` z ekranu może pojawić się chwilę przed flagą — dopóki rekord startu żyje,
    // rozstrzyga flaga herdr, a nie nasz skrót.
    const uuid = '11111111-2222-4333-8444-555555555555';
    const f = setup({
      sessionId: uuid,
      probes: [
        { agentSessionId: uuid, status: 'idle', interactiveReady: null, launchPending: true },
        { agentSessionId: uuid, status: 'idle', interactiveReady: true },
      ],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    const result = await handle.ready;

    expect(result.interactiveReady).toBe(true);
    expect(f.logs.some((l) => l.includes('launch record expired'))).toBe(false);
  });

  it('bez `interactive_ready`, ale bez sesji albo ze statusem `unknown` → dalej czekanie do timeoutu', async () => {
    const f = setup({
      probes: [
        { agentSessionId: '', status: 'idle', interactiveReady: null },
        { agentSessionId: '11111111-2222-4333-8444-555555555555', status: 'unknown', interactiveReady: null },
      ],
      readyTimeoutMs: 1000,
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).rejects.toThrow(HerdrLaunchTimeoutError);
    expect(f.calls.closeTab).toEqual([]);
  });

  it('`agent_session` inny niż `--session-id` → `HerdrLaunchTimeoutError`', async () => {
    // Rozjazd znaczy, że `--session-id` nie zadziałało, a cała ścieżka jsonl byłaby
    // zgadywaniem — to jest porażka startu, nie drobiazg.
    const f = setup({
      probes: [{ agentSessionId: 'inny-uuid', status: 'idle', interactiveReady: true }],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).rejects.toThrow(HerdrLaunchTimeoutError);
    expect(f.calls.closeTab).toEqual([]);
  });

  it('`interactive_ready: true` with an empty `agent_session` keeps polling until herdr reports the id', async () => {
    // herdr 0.9.5 can report readiness a moment before the session id; empty means "not yet", not a mismatch.
    const uuid = '11111111-2222-4333-8444-555555555555';
    const f = setup({
      sessionId: uuid,
      probes: [
        { agentSessionId: '', status: 'idle', interactiveReady: true },
        { agentSessionId: '', status: 'idle', interactiveReady: true },
        { agentSessionId: uuid, status: 'idle', interactiveReady: true },
      ],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    const result = await handle.ready;

    expect(result).toMatchObject({ status: 'idle', interactiveReady: true, agentSessionId: uuid });
    expect(f.logs.filter((l) => l.startsWith('herdr launcher: start failed on '))).toEqual([]);
  });

  it('`interactive_ready: true` with an empty `agent_session` until the deadline → launch timeout', async () => {
    const uuid = '11111111-2222-4333-8444-555555555555';
    const f = setup({
      sessionId: uuid,
      probes: [{ agentSessionId: '', status: 'idle', interactiveReady: true }],
      readyTimeoutMs: 1000,
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.launch-timeout' } } });
    expect(f.logs.filter((l) => l.startsWith('herdr launcher: start failed on '))).toEqual([
      `herdr launcher: start failed on w9:p9: not ready within 1 s; expected session ${uuid}, `
        + 'herdr reported none; status idle, interactive_ready true, launch_pending absent, start new; '
        + 'foreground: none',
    ]);
    expect(f.calls.closeTab).toEqual([]);
  });

  it('agent zniknął w trakcie startu → `HerdrGoneError` z powodem z ekranu', async () => {
    const f = setup({
      probeError: new HerdrGoneError(foreign('agent_not_found')),
      screenText: 'No conversation found with session ID: 9999',
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toThrow(HerdrGoneError);
    await expect(handle.ready).rejects.toThrow(/No conversation found/);
    expect(f.calls.screenReads).toBeGreaterThan(0);
  });

  it('nieczytelny ekran nie psuje komunikatu o zniknięciu agenta', async () => {
    const f = setup({ probeError: new HerdrGoneError(foreign('agent_not_found')), screenText: '' });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).rejects.toThrow(/disappeared right after starting/);
    await expect(handle.ready).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.agent-vanished' } } });
  });

  /*
   * Karta w PWA jest jedynym innym miejscem, w którym ta porażka istnieje — i znika razem
   * z sesją. Bez linii w logu diagnoza (np. prompt aktualizacji oh-my-zsh zjada pierwszą literę
   * `claude`) wymaga dziennika herdr i ekranu osieroconego panelu.
   */
  it('zniknięcie agenta zostawia ślad w logu z adresem panelu', async () => {
    const f = setup({ probeError: new HerdrGoneError(foreign('agent_not_found')), screenText: '' });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).rejects.toThrow(HerdrGoneError);
    const line = f.logs.find((entry) => entry.startsWith(AGENT_GONE_AT_START_LOG));
    expect(line).toContain('w9:p9');
    // Bez ekranu log mówi, GDZIE go obejrzeć — a nie udaje, że powodu nie ma.
    expect(line).toContain('herdr');
  });
});

/*
 * Porażka startu zostawia JEDNĄ linię w `server.log`.
 *
 * Przy „błąd tworzenia sesji" (zdanie rozjazdu id) bez tej linii zostaje zgadywanie, co herdr wtedy
 * zgłosił. Linia niesie ostatni odczyt `agent.get` i procesy
 * pierwszego planu panelu w wąskim kształcie fasady (`pid`, `name`, `argv0`) — nic z linii poleceń.
 * Zdanie dla apki zostaje bez zmian.
 */
describe('launch — porażka startu zostawia linię w logu', () => {
  const SESSION = '11111111-2222-4333-8444-555555555555';
  const OLD = '99999999-8888-4777-8666-555555555555';
  const failureLines = (logs: readonly string[]): string[] => (
    logs.filter((line) => line.startsWith('herdr launcher: start failed on '))
  );

  it('`interactive_ready: true` z innym id → linia z odczytem herdr i procesami panelu', async () => {
    const f = setup({
      sessionId: SESSION,
      probes: [{ agentSessionId: 'inny-uuid', status: 'idle', interactiveReady: true }],
      foreground: [
        { pid: 4242, name: 'claude', argv0: 'claude' },
        { pid: 4300, name: 'node', argv0: '' },
      ],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.session-id-mismatch' } } });
    expect(failureLines(f.logs)).toEqual([
      `herdr launcher: start failed on w9:p9: session id mismatch; expected session ${SESSION}, `
        + 'herdr reported inny-uuid; status idle, interactive_ready true, launch_pending absent, start new; '
        + 'foreground: 4242 claude claude, 4300 node -',
    ]);
    expect(f.calls.processReads).toEqual(['w9:p9']);
  });

  it('agent wykryty bez rekordu startu, inne id → linia mówi `interactive_ready absent` i `start resume`', async () => {
    const f = setup({
      probes: [{ agentSessionId: 'cudzy', status: 'working', interactiveReady: null }],
      foreground: [{ pid: 7, name: 'claude', argv0: 'claude' }],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD, resumeFrom: OLD });

    await expect(handle.ready).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.session-id-mismatch' } } });
    expect(failureLines(f.logs)).toEqual([
      `herdr launcher: start failed on w9:p9: session id mismatch; expected session ${OLD}, `
        + 'herdr reported cudzy; status working, interactive_ready absent, launch_pending absent, start resume; '
        + 'foreground: 7 claude claude',
    ]);
  });

  it('`blocked` z innym id → linia ze statusem `blocked` i `start fork`', async () => {
    const f = setup({
      sessionId: SESSION,
      probes: [{ agentSessionId: 'inny-uuid', status: 'blocked', interactiveReady: false, launchPending: false }],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD, resumeFrom: OLD, fork: true });

    await expect(handle.ready).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.session-id-mismatch' } } });
    expect(failureLines(f.logs)).toEqual([
      `herdr launcher: start failed on w9:p9: session id mismatch; expected session ${SESSION}, `
        + 'herdr reported inny-uuid; status blocked, interactive_ready false, launch_pending false, start fork; '
        + 'foreground: none',
    ]);
  });

  it('timeout gotowości → linia z ostatnim odczytem (`herdr reported none`), zdanie dla apki bez zmian', async () => {
    const f = setup({
      sessionId: SESSION,
      probes: [{ agentSessionId: '', status: 'unknown', interactiveReady: false, launchPending: true }],
      readyTimeoutMs: 1000,
      foreground: [{ pid: 99, name: 'zsh', argv0: '-zsh' }],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.launch-timeout' } } });
    // Zdanie renderuje twardą spację przed „s" — stąd `\s`, jak w teście ogona ekranu wyżej.
    await expect(handle.ready).rejects.toThrow(
      /^The agent didn't report ready within 1\ss\. The pane is still running; check it in herdr\.$/,
    );
    expect(failureLines(f.logs)).toEqual([
      `herdr launcher: start failed on w9:p9: not ready within 1 s; expected session ${SESSION}, `
        + 'herdr reported none; status unknown, interactive_ready false, launch_pending true, start new; '
        + 'foreground: 99 zsh -zsh',
    ]);
  });

  it('błąd odczytu procesów → `foreground: unknown`, linia i tak jest, błąd startu bez zmian', async () => {
    const f = setup({
      sessionId: SESSION,
      probes: [{ agentSessionId: 'inny-uuid', status: 'idle', interactiveReady: true }],
      foregroundError: new HerdrUnavailableError(foreign('Błąd gniazda herdr: ECONNRESET')),
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toBeInstanceOf(HerdrLaunchTimeoutError);
    await expect(handle.ready).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.session-id-mismatch' } } });
    const lines = failureLines(f.logs);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/; foreground: unknown$/);
  });

  it('znaki sterujące z herdr nie łamią linii', async () => {
    const f = setup({
      probes: [{ agentSessionId: 'zły\nid', status: 'idle', interactiveReady: true }],
      foreground: [{ pid: 5, name: 'a\tb', argv0: 'x\ny' }],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toThrow(HerdrLaunchTimeoutError);
    const lines = failureLines(f.logs);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\n\r\t]/);
    expect(lines[0]).toContain('herdr reported zły?id;');
    expect(lines[0]).toMatch(/foreground: 5 a\?b x\?y$/);
  });

  it('udany start nie czyta procesów panelu i nie pisze linii porażki', async () => {
    const f = setup({ sessionId: SESSION });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await handle.ready;

    expect(failureLines(f.logs)).toEqual([]);
    expect(f.calls.processReads).toEqual([]);
  });
});

describe('launch — kolizja nazwy agenta', () => {
  const taken = Object.assign(new HerdrError(foreign('herdr: nazwa zajęta')), {
    remoteCode: 'agent_name_taken',
  });

  it('ponawia z INNĄ nazwą', async () => {
    const f = setup({ startAgentError: taken, startAgentFailures: 1 });
    await (await f.launcher.launch({ cwd: KNOWN_CWD })).ready;

    expect(f.calls.startAgent).toHaveLength(2);
    expect(f.names[0]).not.toBe(f.names[1]);
  });

  it('po trzech próbach oddaje błąd i sprząta taba', async () => {
    const f = setup({ startAgentError: taken });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toThrow(HerdrError);
    expect(f.calls.startAgent).toHaveLength(3);
    expect(f.calls.closeTab).toEqual(['w9:t9']);
  });

  it('`agent_pane_busy` ponawia z TĄ SAMĄ nazwą (to powłoka, nie nazwa)', async () => {
    /*
     * Znalezione na żywo: `herdr agent start` wymaga panelu „at an interactive shell
     * prompt" i przez pierwsze kilkaset ms po `tab.create` odpowiada `agent_pane_busy` —
     * zsh z motywem nie zdążył narysować promptu. Bez ponowienia ten sam kod raz startuje,
     * a raz wywala sesję i zostawia po sobie PUSTY PANEL (reguła 11.9).
     *
     * Nazwa się nie zmienia, bo nazwa nie była problemem — a zmiana zużywałaby budżet
     * trzech prób zarezerwowany na prawdziwą kolizję.
     */
    const busy = Object.assign(new HerdrError(foreign('herdr: pane is not an available shell')), {
      remoteCode: 'agent_pane_busy',
    });
    const f = setup({ startAgentError: busy, startAgentFailures: 2 });
    await (await f.launcher.launch({ cwd: KNOWN_CWD })).ready;

    expect(f.calls.startAgent).toHaveLength(3);
    expect(new Set(f.names).size).toBe(1);
    expect(f.calls.closeTab).toEqual([]);
  });

  it('`agent_pane_busy` bez końca kończy się błędem i sprzątnięciem taba', async () => {
    // Okno na prompt powłoki jest OKNEM, nie wieczną cierpliwością: panel, w którym powłoka
    // nigdy nie wstała, ma zniknąć razem z błędem, a nie zostać pustym tabem.
    const busy = Object.assign(new HerdrError(foreign('herdr: pane is not an available shell')), {
      remoteCode: 'agent_pane_busy',
    });
    const f = setup({ startAgentError: busy });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).rejects.toThrow(HerdrError);
    expect(f.calls.closeTab).toEqual(['w9:t9']);
    // Zegar testu przesuwa `sleep`, więc pętla musi się skończyć na budżecie, a nie kręcić.
    expect(f.calls.startAgent.length).toBeGreaterThan(3);
  });

  it('inny błąd `agent.start` NIE jest ponawiany', async () => {
    // Ponawiamy DOKŁADNIE dwie sytuacje: zajętą nazwę i niegotową powłokę. `feature_disabled`
    // (killswitch po drugiej stronie) nie zmieni się od czekania — ponawianie go byłoby
    // dobijaniem się do zamkniętych drzwi.
    const f = setup({ startAgentError: new HerdrError(foreign('herdr: feature_disabled')) });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).rejects.toThrow();
    expect(f.calls.startAgent).toHaveLength(1);
  });
});

describe('launch — panel na dialogu', () => {
  it('`blocked` kończy start SUKCESEM (kartę dialogu pokaże warstwa zgód)', async () => {
    const f = setup({
      probes: [
        { agentSessionId: '', status: 'idle', interactiveReady: false },
        { agentSessionId: '', status: 'blocked', interactiveReady: false },
      ],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).resolves.toMatchObject({ paneId: 'w9:p9' });
    expect(f.calls.closeTab).toEqual([]);
    expect(f.logs.some((line) => line.includes('blocked'))).toBe(true);
  });

  it('`blocked` with `interactive_ready: true` and an empty `agent_session` still ends the start as blocked', async () => {
    const f = setup({
      probes: [{ agentSessionId: '', status: 'blocked', interactiveReady: true }],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });

    await expect(handle.ready).resolves.toMatchObject({ status: 'blocked', interactiveReady: false });
    expect(f.calls.closeTab).toEqual([]);
  });

  it('`blocked` z INNYM uuidem sesji to dalej rozjazd', async () => {
    const f = setup({
      probes: [{ agentSessionId: 'inny-uuid', status: 'blocked', interactiveReady: false }],
    });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).rejects.toThrow(HerdrLaunchTimeoutError);
  });
});

describe('launch — dwa zlecenia w tym samym katalogu', () => {
  it('dają dwa taby w tym samym workspace (to jest dozwolone)', async () => {
    const f = setup();
    const [a, b] = await Promise.all([
      f.launcher.launch({ cwd: KNOWN_CWD }),
      f.launcher.launch({ cwd: KNOWN_CWD }),
    ]);
    await Promise.all([a.ready, b.ready]);

    expect(f.calls.createTab).toHaveLength(2);
    expect(f.calls.createWorkspace).toHaveLength(0);
    expect(a.key).not.toBe(b.key);
  });

  it('PIERWSZE dwa zlecenia katalogu bez workspace\'u → JEDEN workspace i tab w nim (zamek)',
    async () => {
      // Bez zamka projektu oba widziały „brak workspace'u" i zakładały dwa.
      const f = setup();
      const [a, b] = await Promise.all([
        f.launcher.launch({ cwd: NEW_CWD }),
        f.launcher.launch({ cwd: NEW_CWD }),
      ]);
      await Promise.all([a.ready, b.ready]);

      expect(f.calls.createWorkspace).toHaveLength(1);
      expect(f.calls.createTab.map((tab) => tab.workspaceId)).toEqual(['wZ']);
    });

  it('herdr jeszcze nie pokazał panelu nowego workspace\'u → pamięć „założyłem" i tak go wskazuje',
    async () => {
      /*
       * Launcher nadaje etykietę pochodzenia dopiero po `agent.start`, poza zamkiem; gdyby herdr
       * nie zdążył pokazać w `pane.list` panelu z `cwd`, drugi start nie miałby dowodu i założyłby
       * drugi workspace „nowy (Projects)". Most to pamięć zamka: workspace założony przez TEN
       * proces dla TEGO katalogu.
       */
      const f = setup({ hideCreatedPanes: true });
      await (await f.launcher.launch({ cwd: NEW_CWD })).ready;
      await (await f.launcher.launch({ cwd: NEW_CWD })).ready;

      expect(f.calls.createWorkspace).toHaveLength(1);
      expect(f.calls.createTab.map((tab) => tab.workspaceId)).toEqual(['wZ']);
    });
});

describe('launch — workspace projektu z potwierdzeniem ścieżki', () => {
  const GROVE = '/Users/u/Projects/Atlas/grove';
  const FJORD = '/Users/u/Projects/fjord-ios';

  it('`cd` cudzego panelu do projektu NIE wybiera jego workspace\'u', async () => {
    // Panel człowieka w „atlas" zrobił `cd` do grove — to nie wystarcza.
    const f = setup({
      panes: [
        { paneId: 'wY:p1', tabId: 'wY:t1', workspaceId: 'wY', cwd: '/Users/u/Projects/Atlas',
          tokens: {}, label: null },
        { paneId: 'wY:p2', tabId: 'wY:t2', workspaceId: 'wY', cwd: GROVE, tokens: {}, label: null },
      ],
      workspaces: [{ workspaceId: 'wY', label: 'atlas' }],
    });
    await (await f.launcher.launch({ cwd: GROVE })).ready;

    expect(f.calls.createTab).toHaveLength(0);
    expect(f.calls.createWorkspace.map((ws) => ws.label)).toEqual(['grove']);
  });

  it('zmigrowany panel fjord-ios w „fleet-ops" nie ściąga tam nowej sesji', async () => {
    // Znane błędne położenie: panel Raroga TEGO projektu stoi w obcym workspace'ie. Workspace
    // o innej etykiecie niż nazwa katalogu i bez checkoutu kandydatem nie jest.
    const f = setup({
      panes: [{
        paneId: 'wJ:p2B', tabId: 'wJ:t2B', workspaceId: 'wJ', cwd: FJORD, tokens: {},
        label: claudePaneLabel(projectKey(FJORD), labelTrace('fjord-ios')),
      }],
      workspaces: [{ workspaceId: 'wJ', label: 'fleet-ops' }],
    });
    await (await f.launcher.launch({ cwd: FJORD })).ready;

    expect(f.calls.createTab).toHaveLength(0);
    expect(f.calls.createWorkspace.map((ws) => ws.label)).toEqual(['fjord-ios']);
  });

  it('nazwa zajęta przez workspace innego `api` → nowy workspace `api (Atlas)`', async () => {
    const other = '/Users/u/Projects/ACME/api';
    const f = setup({
      panes: [{
        paneId: 'wA:p1', tabId: 'wA:t1', workspaceId: 'wA', cwd: other, tokens: {},
        label: claudePaneLabel(projectKey(other), labelTrace('api')),
      }],
      workspaces: [{ workspaceId: 'wA', label: 'api' }],
    });
    await (await f.launcher.launch({ cwd: '/Users/u/Projects/Atlas/api' })).ready;

    expect(f.calls.createTab).toHaveLength(0);
    expect(f.calls.createWorkspace.map((ws) => ws.label)).toEqual(['api (Atlas)']);
  });

  it('stare duplikaty z remisem 2:2 → JEDEN nowy workspace na kolejne i równoczesne starty', async () => {
    /*
     * Pamięć „założyłem" jako sam punkt dałaby nowemu `rarog (Projects)`
     * tyle samo dowodów co starym (2:2:2), więc trzy starty założyłyby trzy workspace'y. Remis
     * rozstrzyga więc ostatni workspace założony dla projektu przez ten proces.
     */
    const project = '/Users/u/Projects/rarog';
    const old = (paneId: string, workspaceId: string): HerdrPaneInfo => ({
      paneId, tabId: `${paneId}t`, workspaceId, cwd: project, tokens: {}, label: null,
    });
    for (const hideCreatedPanes of [false, true]) {
      const f = setup({
        panes: [old('w1:p1', 'w1'), old('w1:p2', 'w1'), old('w2:p1', 'w2'), old('w2:p2', 'w2')],
        workspaces: [{ workspaceId: 'w1', label: 'rarog' }, { workspaceId: 'w2', label: 'rarog' }],
        hideCreatedPanes,
      });
      await (await f.launcher.launch({ cwd: project })).ready;
      await (await f.launcher.launch({ cwd: project })).ready;
      const [a, b] = await Promise.all([
        f.launcher.launch({ cwd: project }), f.launcher.launch({ cwd: project }),
      ]);
      await Promise.all([a.ready, b.ready]);

      expect(f.calls.createWorkspace.map((ws) => ws.label), String(hideCreatedPanes))
        .toEqual(['rarog (Projects)']);
      expect(f.calls.createTab.map((tab) => tab.workspaceId)).toEqual(['wZ', 'wZ', 'wZ']);
    }
  });

  it('workspace checkoutu (worktree) wygrywa, choć nazywa się inaczej', async () => {
    const worktree = '/Users/u/Projects/rarog/.claude/worktrees/taby';
    const f = setup({
      panes: [],
      workspaces: [{ workspaceId: 'wT', label: 'feat/taby', checkoutPath: worktree,
        repoRoot: '/Users/u/Projects/rarog' }],
    });
    await (await f.launcher.launch({ cwd: worktree })).ready;

    expect(f.calls.createWorkspace).toHaveLength(0);
    expect(f.calls.createTab.map((tab) => tab.workspaceId)).toEqual(['wT']);
  });
});

describe('launch — sonda gotowości bez wstrzyknięcia (styk produkcyjny)', () => {
  it('bez `deps.probeAgent` launcher pyta KLIENTA, a nie zgaduje gotowości', async () => {
    /*
     * To jest styk, który naprawdę biegnie w produkcji: `index.ts` nie podaje sondy, więc
     * musi ją dać `HerdrLaunchClient`. Test istnieje dlatego, że wszystkie pozostałe testy
     * launchera wstrzykują własną sondę — bez tego jednego ścieżka produkcyjna nie miałaby
     * ani jednej asercji i „działa" znaczyłoby „kompiluje się".
     */
    const probes: string[] = [];
    const uuid = '11111111-2222-4333-8444-555555555555';
    let ready = false;

    const client: HerdrLaunchClient = {
      listPanes: async () => [...PANES],
      listPaneIds: async () => new Set(PANES.map((pane) => pane.paneId)),
      listWorkspaces: async () => workspacesOf(PANES),
      readPaneHistory: async () => ({ text: '', truncated: false }),
      readPaneProcess: async () => ({ processes: [] }),
      getTab: (tabId: string) => Promise.reject(new Error(`launcher nie czyta tabów (${tabId})`)),
      createWorkspace: async () => ({ workspaceId: 'wZ', tabId: 'wZ:t1', paneId: 'wZ:p1' }),
      createTab: async (params: HerdrCreateTabParams) => ({
        tabId: `${params.workspaceId}:t9`, paneId: `${params.workspaceId}:p9`,
      }),
      startAgent: async () => ({ argv: ['claude'] }),
      reportPaneMetadata: async () => undefined,
      renamePane: async () => undefined,
      renameTab: async () => undefined,
      closeTab: async () => undefined,
      closePane: async () => undefined,
      probeAgent: async (paneId: string) => {
        probes.push(paneId);
        // Pierwszy odczyt: herdr jeszcze nie zna sesji (~2 s po `agent.start`). Drugi: gotowe.
        const answer: HerdrLaunchProbe = ready
          ? { agentSessionId: uuid, status: 'idle', interactiveReady: true }
          : { agentSessionId: '', status: 'idle', interactiveReady: false };
        ready = true;
        return answer;
      },
    };

    const launcher = createHerdrLauncher({
      client,
      placement: createProjectPlacement(),
      trust: { isTrusted: async () => true },
      registerLaunch: (reg: HerdrLaunchRegistration): string => `key-${reg.paneId}`,
      newSessionId: () => uuid,
      sleep: async () => undefined,
    });

    const handle = await launcher.launch({ cwd: KNOWN_CWD });
    await expect(handle.ready).resolves.toMatchObject({ agentSessionId: uuid });
    // Pusty `agentSessionId` w pierwszym odczycie NIE przerwał startu — gdyby sonda stała
    // na `getAgent()`, ten sam wpis byłby „agent zniknął" i sesja padłaby w pierwszej sekundzie.
    expect(probes).toEqual(['w9:p9', 'w9:p9']);
  });
});

describe('launch — wznowienie zachowuje uuid sesji', () => {
  const OLD = '99999999-8888-4777-8666-555555555555';

  it('zwykłe wznowienie: `agentSessionId` to WZNAWIANY uuid, nie świeży', async () => {
    /*
     * Zmierzone: `claude --session-id <nowy> --resume <stary>`
     * kończy się błędem („--session-id can only be used … if --fork-session is also
     * specified") i panel wraca do powłoki. Wznowiona sesja ZOSTAJE przy swoim uuid, więc
     * to on jest adresem jej pliku jsonl — Rarog, który szukałby świeżego, nie znalazłby
     * ani jednej wiadomości.
     */
    const f = setup({ probes: [{ ...READY, agentSessionId: OLD }] });
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD, resumeFrom: OLD });
    const result = await handle.ready;

    expect(handle.agentSessionId).toBe(OLD);
    expect(result.argv).toEqual(['claude', '--resume', OLD]);
    expect(f.registrations[0]?.agentSessionId).toBe(OLD);
  });

  it('rozwidlenie: `agentSessionId` to NOWY uuid, a stary idzie w `--resume`', async () => {
    const f = setup();
    const handle = await f.launcher.launch({ cwd: KNOWN_CWD, resumeFrom: OLD, fork: true });
    const result = await handle.ready;

    expect(handle.agentSessionId).not.toBe(OLD);
    expect(result.argv).toEqual([
      'claude', '--session-id', handle.agentSessionId, '--resume', OLD, '--fork-session',
    ]);
  });
});
