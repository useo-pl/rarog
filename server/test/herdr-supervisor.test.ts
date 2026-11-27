/**
 * Supervisor: rekoncyliacja tożsamości, strażnik kolejności, karencja po wysyłce, subskrypcja
 * i dostępność.
 *
 * Wejściem jest REALNY zrzut `agent-list.json` (17 paneli z żywego serwera), a klient i strumień
 * zdarzeń są atrapami — żaden test nie dotyka gniazda. Przypadki, których na żywym serwerze
 * nie było (`codex`, `kind: 'path'`, `blocked`, `done`, `unknown`), BUDUJEMY z tego zrzutu,
 * zamiast dopisywać je do fixture'a i udawać, że przyszły z serwera.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import type { DecisionOutcome, SessionDriver } from '../src/drivers/types.ts';
import { parseAgentList } from '../src/herdr/client.ts';
import { sessionIdFor } from '../src/herdr/identity.ts';
import {
  HERDR_NAME_PREFIX, claudePaneLabel, labelTrace, projectKey, realProjectPath, termPaneLabel,
} from '../src/herdr/provenance.ts';
import {
  HERDR_IDLE_GRACE_MS,
  HERDR_WORKING_GRACE_MS, HERDR_RESYNC_MS, HERDR_TRUST_REEXEC_GRACE_MS,
  LAUNCH_ADOPT_TIMEOUT_MS, RESUBSCRIBE_DEBOUNCE_MS, TAB_LABEL_DEBOUNCE_MS,
  createHerdrSupervisor,
} from '../src/herdr/supervisor.ts';
import type { HerdrAuditEvent } from '../src/herdr/audit.ts';
import { HERDR_MODE_FRESH_MS } from '../src/config.ts';
import type { RefusalDump, RefusalDumper } from '../src/herdr/dialogs/refusals.ts';
import type {
  HerdrAttachContext, HerdrLauncherSeam, HerdrSupervisorHandle, HerdrTransport,
} from '../src/herdr/supervisor.ts';
import { HerdrUnavailableError } from '../src/herdr/socket.ts';
import type { PushContent } from '../src/notify/content.ts';
import { VERSIONS_SEEN_FILENAME, VERSION_PUSH_SETTLE_MS, createVersionWatch } from '../src/version-watch.ts';
import type { VersionWatch } from '../src/version-watch.ts';
import type {
  HerdrSocketStatus, HerdrStreamEvent, HerdrSubscription, HerdrSubscriptionSpec,
} from '../src/herdr/socket.ts';
import {
  HERDR_PANE_CAP_MESSAGE, HerdrGoneError, HerdrNotOwnedError, HerdrReadOnlyError,
} from '../src/herdr/types.ts';
import type {
  HerdrAgentInfo, HerdrAgentStatus, HerdrClient, HerdrLaunchClient,
  HerdrLaunchRequest, HerdrLauncher, HerdrLifecycleEvent, HerdrPaneEvent,
  HerdrPaneInfo, HerdrScreen,
} from '../src/herdr/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const rawAgents = (JSON.parse(
  readFileSync(join(FIXTURES, 'agent-list.json'), 'utf8'),
) as { result: { agents: Record<string, unknown>[] } }).result.agents;
const footerAuto = readFileSync(join(FIXTURES, 'footer-auto.txt'), 'utf8');

const ROOTS = ['/Users/u/Projects'];

// ---------------------------------------------------------------------------
// Atrapy
// ---------------------------------------------------------------------------

class FakeScheduler implements Scheduler {
  #now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();
  /**
   * Każdy uzbrojony odstęp, w kolejności.
   *
   * Tempa pompy nie da się zmierzyć samym licznikiem odczytów: przy zegarze wirtualnym praca
   * obrotu (koszt sondy i odczytu) przesuwa `clock`, a nie kolejkę timerów. Odstęp, na jaki
   * pompa się uzbroiła, jest tu jedyną liczbą, która mówi wprost, od czego liczy okres.
   */
  readonly delays: number[] = [];

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.#seq += 1;
    this.delays.push(ms);
    this.#timers.set(this.#seq, { at: this.#now + ms, fn });
    return this.#seq;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].fn();
    }
    this.#now = target;
  }
}

class FakeClient implements HerdrClient {
  agents: HerdrAgentInfo[];
  screen = footerAuto;
  readonly calls = { list: 0, get: 0, read: 0, prompt: 0, sendKeys: 0, focus: 0 };
  listFails: string | null = null;

  constructor(agents: HerdrAgentInfo[]) {
    this.agents = agents;
  }

  listAgents(): Promise<HerdrAgentInfo[]> {
    this.calls.list += 1;
    if (this.listFails !== null) return Promise.reject(new Error(this.listFails));
    return Promise.resolve(this.agents.map((a) => ({ ...a })));
  }

  getAgent(paneId: string): Promise<HerdrAgentInfo> {
    this.calls.get += 1;
    const found = this.agents.find((a) => a.paneId === paneId);
    if (found === undefined) return Promise.reject(new HerdrGoneError(foreign(`brak ${paneId}`)));
    return Promise.resolve({ ...found });
  }

  /** Źródła KAŻDEGO odczytu ekranu — punkt 11 `docs/security-model.md` jest o nich, nie o treści. */
  /** Historia panelu — te testy jej nie czytają; pusta = brak wstępu dialogu. */
  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ text: '', truncated: false });
  }
  readonly readSources: ('detection' | 'visible')[] = [];

  readScreen(_paneId: string, source: 'detection' | 'visible'): Promise<HerdrScreen> {
    this.calls.read += 1;
    this.readSources.push(source);
    return Promise.resolve({ text: this.screen });
  }

  prompt(): Promise<void> {
    this.calls.prompt += 1;
    return Promise.resolve();
  }

  sendKeys(): Promise<void> {
    this.calls.sendKeys += 1;
    return Promise.resolve();
  }

  sendFormSubmit(): Promise<void> { this.calls.sendKeys += 1; return Promise.resolve(); }
  sendModeCycle(): Promise<void> { this.calls.sendKeys += 1; return Promise.resolve(); }
  pasteText(): Promise<void> { this.calls.prompt += 1; return Promise.resolve(); }
  sendPromptSubmit(): Promise<void> { this.calls.sendKeys += 1; return Promise.resolve(); }
  sendTrustStep(): Promise<void> { this.calls.sendKeys += 1; return Promise.resolve(); }
  sendDialogKey(): Promise<void> { this.calls.sendKeys += 1; return Promise.resolve(); }
  sendTakeBackKey(): Promise<void> { this.calls.sendKeys += 1; return Promise.resolve(); }
  focus(): Promise<void> {
    this.calls.focus += 1;
    return Promise.resolve();
  }

  pingFails: string | null = null;
  /** Wersja programu herdr z `ping` — `herdr update --handoff` zmienia ją bez utraty gniazda. */
  pingVersion = '0.8.2';
  pings = 0;

  ping(): Promise<{ version: string; protocol: number }> {
    this.pings += 1;
    if (this.pingFails !== null) return Promise.reject(new Error(this.pingFails));
    return Promise.resolve({ version: this.pingVersion, protocol: 20 });
  }
}

interface FakeSub {
  subs: HerdrSubscriptionSpec[];
  queue: AsyncEventQueue<HerdrStreamEvent>;
  closed: boolean;
}

class FakeTransport implements HerdrTransport {
  readonly opened: FakeSub[] = [];
  statusValue: HerdrSocketStatus = {
    available: true, readOnly: false, version: '0.8.2', protocol: 20,
  };

  subscribe(subs: readonly HerdrSubscriptionSpec[]): HerdrSubscription {
    const entry: FakeSub = {
      subs: subs.map((s) => ({ ...s })),
      queue: new AsyncEventQueue<HerdrStreamEvent>(),
      closed: false,
    };
    this.opened.push(entry);
    return {
      events: entry.queue,
      close: (): void => {
        entry.closed = true;
        entry.queue.close();
      },
    };
  }

  status(): HerdrSocketStatus {
    return this.statusValue;
  }

  dispose(): void {
    // atrapa nie ma czego zwalniać
  }

  get current(): FakeSub {
    const last = this.opened.at(-1);
    if (last === undefined) throw new Error('brak otwartej subskrypcji');
    return last;
  }

  emit(ev: HerdrStreamEvent): void {
    this.current.queue.push(ev);
  }
}

/** Driver-atrapa: liczy podpięcia i zbiera zdarzenia panelu. */
function fakeDriverFactory(): {
  factory: (ctx: HerdrAttachContext) => SessionDriver;
  attached: { ctx: HerdrAttachContext; events: HerdrPaneEvent[] }[];
} {
  const attached: { ctx: HerdrAttachContext; events: HerdrPaneEvent[] }[] = [];
  return {
    attached,
    factory: (ctx): SessionDriver => {
      const record = { ctx, events: [] as HerdrPaneEvent[] };
      attached.push(record);
      ctx.handle.subscribe((ev) => record.events.push(ev));
      return {
        ownsProcess: false,
        events: new AsyncEventQueue(),
        send: () => {},
        respondPermission: () => Promise.resolve<DecisionOutcome>({ kind: 'applied' }),
        answerQuestion: () => Promise.resolve<DecisionOutcome>({ kind: 'applied' }),
        interrupt: () => Promise.resolve(true),
        dispose: () => {},
      };
    },
  };
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

interface Setup {
  supervisor: HerdrSupervisorHandle;
  client: FakeClient;
  transport: FakeTransport;
  scheduler: FakeScheduler;
  lifecycle: HerdrLifecycleEvent[];
  drivers: ReturnType<typeof fakeDriverFactory>['attached'];
  clock: { value: number };
  /** Wpisy, które poszłyby do `herdr-audit.log` — testy władz tworzących na nie patrzą. */
  audit: HerdrAuditEvent[];
  /** Linie logu serwera (`config.logger`). */
  logs: string[];
}

let active: Setup | null = null;

afterEach(() => {
  active?.supervisor.dispose();
  active = null;
});

interface SetupOptions {
  launcher?: HerdrLauncher;
  /** Fabryka launchera na szwie nadzorcy (`registerLaunch`, `paneLabelled`) — jak w produkcji. */
  createLauncher?: (seam: HerdrLauncherSeam) => HerdrLauncher;
  launchClient?: HerdrLaunchClient;
  maxPanes?: number;
  dumpRefusal?: RefusalDumper;
  /** `RAROG_HERDR_TAB_LABELS`; brak = domyślne „włączone". */
  tabLabels?: boolean;
  /** Wersja programu herdr z walidowanego `ping` na ticku resyncu (sygnał nowej wersji). */
  onVersion?: (version: string) => void;
}

async function setup(
  agents: HerdrAgentInfo[] = parseAgentList({ agents: rawAgents }),
  opts: SetupOptions = {},
): Promise<Setup> {
  const client = new FakeClient(agents);
  const transport = new FakeTransport();
  const scheduler = new FakeScheduler();
  const drivers = fakeDriverFactory();
  const clock = { value: 1_000_000 };
  const lifecycle: HerdrLifecycleEvent[] = [];
  const audit: HerdrAuditEvent[] = [];
  const logs: string[] = [];

  const supervisor = createHerdrSupervisor(
    {
      socketPath: '/nie/uzywany.sock',
      roots: ROOTS,
      yoloRoots: [],
      sendEnabled: true,
      // Kanał tworzenia istnieje TYLKO wtedy, gdy test poda launchera — dokładnie tak, jak
      // w produkcji przy `RAROG_HERDR_LAUNCH=1`.
      launchEnabled: opts.launcher !== undefined || opts.createLauncher !== undefined,
      ...(opts.maxPanes !== undefined ? { maxPanes: opts.maxPanes } : {}),
      ...(opts.tabLabels !== undefined ? { tabLabels: opts.tabLabels } : {}),
      dataDir: join(FIXTURES, 'nie-uzywany'),
      now: () => clock.value,
      logger: (line) => { logs.push(line); },
    },
    {
      createDriver: drivers.factory,
      client,
      transport,
      scheduler,
      ...(opts.launcher !== undefined ? { launcher: opts.launcher } : {}),
      ...(opts.createLauncher !== undefined ? { createLauncher: opts.createLauncher } : {}),
      ...(opts.launchClient !== undefined ? { launchClient: opts.launchClient } : {}),
      ...(opts.dumpRefusal !== undefined ? { dumpRefusal: opts.dumpRefusal } : {}),
      ...(opts.onVersion !== undefined ? { onVersion: opts.onVersion } : {}),
      // Fasada LUSTRA jest osobnym polem, dokładnie jak w produkcji: launcher jej NIE widzi.
      // Audit i magazyn tożsamości są tu atrapami: ten test nie dotyka dysku.
      audit: { log: (entry) => { audit.push(entry); }, flush: () => Promise.resolve() },
      hidden: {
        flush: () => Promise.resolve(),
        aliasFor: () => undefined, rememberAlias: () => Promise.resolve(),
        seenSeq: () => undefined, markSeen: () => Promise.resolve(), seenBy: () => undefined,
        unseenSeq: () => undefined, markUnseen: () => Promise.resolve(),
      },
    },
  );

  void (async () => {
    for await (const ev of supervisor.events) lifecycle.push(ev);
  })();

  await supervisor.ready;
  await flush();
  // The pane label migration reads `pane.list` once at start; the counter measures what a test does after.
  if (opts.launchClient instanceof FakeLaunchClient) opts.launchClient.listPanesCalls = 0;
  const result: Setup = {
    supervisor, client, transport, scheduler, lifecycle, drivers: drivers.attached, clock, audit,
    logs,
  };
  active = result;
  return result;
}

/** Uuid sesji Codexa z pomiaru (prawdziwy UUID v7 z `agent_session.value`). */
const CODEX_SESSION = '0198f0c4-1f2a-7c31-9a44-6f2b5d0e7a10';

/**
 * SUROWY wpis Codexa zbudowany z wpisu Claude z fixture'a — README `fixtures/herdr` zabrania
 * dopisywać do `agent-list.json` rekordów, których na żywym serwerze nie było. Kształt pochodzi
 * z pomiaru na herdr 0.9.0.
 */
function codexRawAt(index: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = rawAgents[index];
  if (raw === undefined) throw new Error(`brak agenta ${index}`);
  return {
    ...raw,
    agent: 'codex',
    agent_session: {
      agent: 'codex', kind: 'id', source: 'herdr:codex', value: CODEX_SESSION,
    },
    terminal_title_stripped: 'Przeprojektuj aplikację | demo',
    ...patch,
  };
}

/** Wpis Codexa PO filtrze wejściowym — tak, jak zobaczy go nadzorca przy `RAROG_CODEX_STATUS=1`. */
function codexAt(index: number, patch: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  const [info] = parseAgentList({ agents: [codexRawAt(index)] }, { codexStatus: true });
  if (info === undefined) throw new Error('filtr wejściowy odrzucił wpis Codexa');
  return { ...info, ...patch };
}

/**
 * Wpis z NAZWĄ agenta przepuszczony przez prawdziwy filtr wejściowy: `launchedByRarog`
 * liczy `normalizeAgentInfo` z `name`, a nie test. `null` = agent bez nazwy (ręczny `claude`
 * albo agent Raroga po wygasłym rekordzie startu).
 */
function namedAgentAt(
  index: number, name: string | null, patch: Partial<HerdrAgentInfo> = {},
): HerdrAgentInfo {
  const [info] = parseAgentList({ agents: [{ ...rawAgents[index], name }] });
  if (info === undefined) throw new Error(`filtr wejściowy odrzucił agenta ${index}`);
  return { ...info, ...patch };
}

/** Kopia wpisu z fixture'a z podmienionymi polami. */
function agentAt(index: number, patch: Partial<HerdrAgentInfo> = {}): HerdrAgentInfo {
  const list = parseAgentList({ agents: rawAgents });
  const base = list[index];
  if (base === undefined) throw new Error(`brak agenta ${index}`);
  return { ...base, ...patch };
}

/**
 * Tik resyncu przesuwający OBA zegary: kolejkę timerów i zegar ścienny nadzorcy.
 *
 * `FakeScheduler` ma własny czas wirtualny, a nadzorca czyta `now()` z `clock` — sam
 * `advance()` odtwarza więc tik, który odbywa się „w tej samej chwili" co poprzedni, czego
 * produkcja nie robi nigdy. Ma to znaczenie tam, gdzie zachowanie zależy od ODSTĘPU między
 * odczytami (odczyt stopki trybu podlega `MODE_READ_MIN_INTERVAL_MS` na każdej drodze).
 */
function resyncTick(s: Setup, ms: number = HERDR_RESYNC_MS): void {
  s.clock.value += ms;
  s.scheduler.advance(ms);
}

// ---------------------------------------------------------------------------
// Testy
// ---------------------------------------------------------------------------

describe('start i filtr wejściowy', () => {
  it('pierwszy resync daje `appeared` dla wszystkich 17 realnych paneli', async () => {
    const s = await setup();
    const appeared = s.lifecycle.filter((ev) => ev.type === 'appeared');
    expect(appeared).toHaveLength(17);
    expect(s.supervisor.status()).toMatchObject({ available: true, agentCount: 17 });
  });

  it('klucz tożsamości to `pane_id` z chwili pierwszego zobaczenia', async () => {
    const s = await setup();
    const first = s.lifecycle[0];
    expect(first?.type).toBe('appeared');
    if (first?.type === 'appeared') {
      expect(first.agent.key).toBe('w9:p72');
      expect(first.agent.paneId).toBe('w9:p72');
    }
  });

  it('panel spoza RAROG_HERDR_ROOTS ma `inScope: false`, ale ISTNIEJE', async () => {
    const s = await setup();
    const outside = s.lifecycle
      .filter((ev): ev is Extract<HerdrLifecycleEvent, { type: 'appeared' }> => (
        ev.type === 'appeared'
      ))
      .filter((ev) => ev.agent.cwd.startsWith('/Users/u/Desktop'));
    expect(outside).toHaveLength(2);
    expect(outside.every((ev) => !ev.agent.inScope)).toBe(true);
  });

  it('bez flagi ani codex, ani `kind: path` nie docierają do supervisora', async () => {
    const mixed = parseAgentList({
      agents: [
        rawAgents[0],
        codexRawAt(1),
        {
          ...rawAgents[2],
          agent_session: { ...(rawAgents[2]?.['agent_session'] as object), kind: 'path' },
        },
      ],
    });
    const s = await setup(mixed);
    expect(s.lifecycle.filter((ev) => ev.type === 'appeared')).toHaveLength(1);
    expect(s.supervisor.status().agentCount).toBe(1);
  });

  it('codex dociera jako `inScope: false` MIMO cwd pod korzeniem; `kind: path` nadal nie', async () => {
    const mixed = parseAgentList({
      agents: [
        rawAgents[0],
        codexRawAt(1),
        {
          ...rawAgents[2],
          agent_session: { ...(rawAgents[2]?.['agent_session'] as object), kind: 'path' },
        },
      ],
    }, { codexStatus: true });
    const s = await setup(mixed);
    const appeared = s.lifecycle
      .filter((ev): ev is Extract<HerdrLifecycleEvent, { type: 'appeared' }> => (
        ev.type === 'appeared'
      ));
    expect(appeared).toHaveLength(2);
    const codex = appeared.find((ev) => ev.agent.engine === 'codex');
    // `inScope` Codexa NIE wynika z korzeni: ten panel siedzi w `RAROG_HERDR_ROOTS`, a i tak
    // dostaje `false` — bo ścieżka `!inScope` to jedyne miejsce, które daje „stan bez treści".
    expect(codex?.agent.cwd.startsWith(ROOTS[0]!)).toBe(true);
    expect(codex?.agent.inScope).toBe(false);
    expect(codex?.agent.interactiveReady).toBe(false);
    expect(s.supervisor.status().agentCount).toBe(2);
  });

  it('panel Codexa nie jest CZYTANY — ani przy odkryciu, ani przy pushu statusu', async () => {
    const s = await setup([codexAt(0)]);
    // Zero `agent.read`: `parseMode` nie zna stopki Codexa, a `standingConsentDialog` na obcym
    // ekranie dałby sztuczne `blocked` i push o dialogu, którego nie ma.
    expect(s.client.calls.read).toBe(0);

    s.client.agents = [codexAt(0, { status: 'blocked', stateChangeSeq: 99 })];
    s.transport.emit({
      type: 'event',
      kind: 'pane_agent_status_changed',
      data: { pane_id: 'w9:p72', workspace_id: 'w9', agent_status: 'blocked' },
    });
    await flush();
    expect(s.supervisor.agentFor?.('w9:p72')?.status).toBe('blocked');
    expect(s.client.calls.read).toBe(0);

    resyncTick(s);
    await flush();
    expect(s.client.calls.read).toBe(0);
    // `ensureFreshMode` też nie czyta — tryb zostaje `unknown`, czyli bramka wysyłki fail-closed.
    await expect(s.supervisor.ensureFreshMode('w9:p72')).resolves.toBe('unknown');
    expect(s.client.calls.read).toBe(0);
  });

  it('`cd` Codexa POD korzeń nie włącza zakresu i nie zleca reattachu', async () => {
    const poza = '/Users/u/Desktop/inne';
    const s = await setup([codexAt(0, { cwd: poza })]);
    s.supervisor.attach('w9:p72');
    expect(s.drivers).toHaveLength(1);

    s.client.agents = [codexAt(0, { cwd: '/Users/u/Projects/demo', stateChangeSeq: 24 })];
    resyncTick(s);
    await flush();

    expect(s.supervisor.agentFor?.('w9:p72')?.cwd).toBe('/Users/u/Projects/demo');
    expect(s.supervisor.agentFor?.('w9:p72')?.inScope).toBe(false);
    // Reattach istnieje po to, żeby przebudować driver Z FOLLOWEREM pliku jsonl — a tego pliku
    // dla Codexa nie ma. Brak zdarzenia jest tu dowodem, że follower nigdy nie powstał.
    expect(s.lifecycle.filter((ev) => ev.type === 're-attached')).toHaveLength(0);
  });

  it('zmiana silnika w panelu = `gone` + `appeared`, nigdy mutacja wpisu', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');

    s.client.agents = [codexAt(0, { stateChangeSeq: 30 })];
    resyncTick(s);
    await flush();

    expect(s.lifecycle.map((ev) => ev.type)).toEqual(['appeared', 'gone', 'appeared']);
    const poZmianie = s.lifecycle.at(-1);
    expect(poZmianie?.type === 'appeared' && poZmianie.agent.engine).toBe('codex');
    expect(s.supervisor.status().agentCount).toBe(1);
    const odczytyPrzed = s.client.calls.read;

    /*
     * SPÓŹNIONA odpowiedź `agent.get` starego silnika: push poleciał PRZED zmianą silnika,
     * a odpowiedź wróciła już po niej (seq 23 < 30). Gałąź „zmiana silnika" kasowała wtedy
     * świeży wpis Codexa PRZED strażnikiem kolejności i stawiała na tym panelu wpis Claude
     * z `inScope: true` — czyli czytała ekran cudzego panelu.
     * Starsza migawka ma odpaść w całości: zero zdarzeń, zero odczytów, wpis bez zmian.
     */
    s.client.agents = [agentAt(0)];
    s.transport.emit({
      type: 'event',
      kind: 'pane_agent_status_changed',
      data: { pane_id: 'w9:p72', workspace_id: 'w9', agent_status: 'idle' },
    });
    await flush();

    expect(s.lifecycle.map((ev) => ev.type)).toEqual(['appeared', 'gone', 'appeared']);
    expect(s.supervisor.agentFor?.('w9:p72')?.engine).toBe('codex');
    expect(s.supervisor.agentFor?.('w9:p72')?.inScope).toBe(false);
    expect(s.supervisor.status().agentCount).toBe(1);
    expect(s.client.calls.read).toBe(odczytyPrzed);
  });

  it('token terminala Raroga (`termId`) na znanym panelu Claude daje `term-changed`, raz na zmianę', async () => {
    // Restart serwera herdr odtwarza Claude w panelu terminala, zanim terminal odzyska token
    // z etykiety panelu — karta ma się o tokenie dowiedzieć bez reattachu.
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    expect(s.supervisor.agentFor?.('w9:p72')?.termId).toBeNull();

    s.client.agents = [agentAt(0, { termId: '0123456789abcdef' })];
    resyncTick(s);
    await flush();

    expect(s.lifecycle.map((ev) => ev.type)).toEqual(['appeared', 'term-changed']);
    const zmiana = s.lifecycle.at(-1);
    expect(zmiana?.type === 'term-changed' && zmiana.agent.termId).toBe('0123456789abcdef');
    expect(zmiana?.type === 'term-changed' && zmiana.agent.key).toBe('w9:p72');

    // Ta sama wartość w kolejnej migawce to nie zmiana.
    resyncTick(s);
    await flush();
    expect(s.lifecycle.map((ev) => ev.type)).toEqual(['appeared', 'term-changed']);

    // Utrata tokenu jest zmianą w drugą stronę.
    s.client.agents = [agentAt(0)];
    resyncTick(s);
    await flush();
    expect(s.lifecycle.map((ev) => ev.type)).toEqual(['appeared', 'term-changed', 'term-changed']);
    expect(s.supervisor.agentFor?.('w9:p72')?.termId).toBeNull();
  });

  it('odłożone potwierdzenie `working` nie cofa tokenu terminala, który przyniósł nowszy resync', async () => {
    // Push `working` ze starą migawką (bez tokenu) czeka karencję; w jej trakcie resync przynosi token.
    // Callback karencji nakłada starą migawkę: ma potwierdzić status, a nie zdjąć token z karty.
    const s = await setup([agentAt(0, { status: 'idle', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');

    s.client.agents = [agentAt(0, { status: 'working', stateChangeSeq: 11 })];
    s.transport.emit({
      type: 'event',
      kind: 'pane_agent_status_changed',
      data: { pane_id: 'w9:p72', workspace_id: 'w9', agent_status: 'working' },
    });
    await flush();

    s.client.agents = [agentAt(0, { status: 'working', stateChangeSeq: 11, termId: '0123456789abcdef' })];
    s.transport.emit({ type: 'event', kind: 'pane_moved', data: {} });
    await flush();
    s.scheduler.advance(RESUBSCRIBE_DEBOUNCE_MS);
    await flush();
    expect(s.supervisor.agentFor?.('w9:p72')?.termId).toBe('0123456789abcdef');

    s.scheduler.advance(HERDR_WORKING_GRACE_MS);
    await flush();

    expect(s.supervisor.agentFor?.('w9:p72')?.termId).toBe('0123456789abcdef');
    expect(s.lifecycle.filter((ev) => ev.type === 'term-changed')).toHaveLength(1);
  });

  it('panel, który POJAWIA SIĘ z tokenem terminala, niesie go w `appeared` bez `term-changed`', async () => {
    const s = await setup([agentAt(0, { termId: '0123456789abcdef' })]);
    expect(s.lifecycle.map((ev) => ev.type)).toEqual(['appeared']);
    const pierwszy = s.lifecycle[0];
    expect(pierwszy?.type === 'appeared' && pierwszy.agent.termId).toBe('0123456789abcdef');
  });

  it('powrót do Claude w tym samym panelu (NOWSZY seq) dalej daje `gone` + `appeared`', async () => {
    // Druga strona tej samej bramki: strażnik kolejności ma odsiewać SPÓŹNIONE migawki,
    // a nie prawdziwą zmianę silnika — ta jedzie zawsze, w obie strony.
    const s = await setup([codexAt(0, { stateChangeSeq: 30 })]);
    s.supervisor.attach('w9:p72');

    s.client.agents = [agentAt(0, { stateChangeSeq: 31 })];
    resyncTick(s);
    await flush();

    expect(s.lifecycle.map((ev) => ev.type)).toEqual(['appeared', 'gone', 'appeared']);
    const ostatni = s.lifecycle.at(-1);
    expect(ostatni?.type === 'appeared' && ostatni.agent.engine).toBe('claude');
    expect(ostatni?.type === 'appeared' && ostatni.agent.inScope).toBe(true);
    expect(s.supervisor.status().agentCount).toBe(1);
  });

  it('`/new` w Codexie: nowy uuid w tym samym panelu → `session-changed`, jeden wpis', async () => {
    const s = await setup([codexAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    const nowy = '0198f0c4-3333-7c31-9a44-6f2b5d0e7a11';
    s.client.agents = [codexAt(0, { agentSessionId: nowy, stateChangeSeq: 24 })];
    resyncTick(s);
    await flush();

    expect(driver.events).toContainEqual({ type: 'session-changed', agentSessionId: nowy });
    expect(s.lifecycle.filter((ev) => ev.type === 'appeared')).toHaveLength(1);
    expect(s.supervisor.status().agentCount).toBe(1);
  });

  it('`liveEngineSessions()` zna WYŁĄCZNIE uuid Claude (bramka pisarzy jsonl)', async () => {
    const s = await setup([agentAt(0), codexAt(1)]);
    const live = await s.supervisor.liveEngineSessions();
    expect(live.has('e3759b2c-2275-565c-8f49-4e2707bb0231')).toBe(true);
    // Uuid Codexa adresuje rollout w `~/.codex/sessions`, nie plik jsonl — w bramce pisarzy
    // blokowałby wznowienie sesji Claude i nie chroniłby niczego.
    expect(live.has(CODEX_SESSION)).toBe(false);
    expect(live.size).toBe(1);
  });

  it('trzy panele w JEDNYM `cwd` to trzy osobne sesje (cwd nigdy nie jest kluczem)', async () => {
    const s = await setup();
    const atlas = s.lifecycle
      .filter((ev): ev is Extract<HerdrLifecycleEvent, { type: 'appeared' }> => (
        ev.type === 'appeared'
      ))
      .filter((ev) => ev.agent.cwd === '/Users/u/Projects/demo');
    expect(atlas).toHaveLength(3);
    expect(new Set(atlas.map((ev) => ev.agent.key)).size).toBe(3);
  });

  it('agent `blocked` już w pierwszym resyncu pojawia się z tym stanem', async () => {
    const s = await setup([agentAt(0, { status: 'blocked' })]);
    const appeared = s.lifecycle[0];
    expect(appeared?.type === 'appeared' && appeared.agent.status).toBe('blocked');
  });

  it('tryb uprawnień jest odczytywany ze stopki przy pojawieniu się agenta', async () => {
    const s = await setup([agentAt(0)]);
    expect(s.client.calls.read).toBeGreaterThan(0);
    const appeared = s.lifecycle[0];
    expect(appeared?.type === 'appeared' && appeared.agent.mode).toBe('auto');
  });
});

describe('rekoncyliacja tożsamości', () => {
  it('`pane move`: ten sam `agent_session`, nowy `pane_id` → `pane-changed`, nie nowa sesja', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.agents = [agentAt(0, { paneId: 'wZ:p99' })];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(driver.events).toContainEqual({ type: 'pane-changed', paneId: 'wZ:p99' });
    expect(s.lifecycle.filter((ev) => ev.type === 'appeared')).toHaveLength(1);
    expect(s.lifecycle.some((ev) => ev.type === 'gone')).toBe(false);
    expect(driver.ctx.handle.agent.key).toBe('w9:p72');
    expect(driver.ctx.handle.agent.paneId).toBe('wZ:p99');
  });

  it('`/clear`: ten sam `pane_id`, nowy uuid sesji → `session-changed`', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;
    const fresh = '99999999-1111-5222-8333-444444444444';

    s.client.agents = [agentAt(0, { agentSessionId: fresh })];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(driver.events).toContainEqual({ type: 'session-changed', agentSessionId: fresh });
    expect(s.lifecycle.filter((ev) => ev.type === 'appeared')).toHaveLength(1);
  });

  it('`/resume` sesji ŻYWEJ w innym panelu → `session-changed` TEGO panelu, nie `pane move`',
    async () => {
      /*
       * Kolizja indeksów: uuid znany pod panelem B, a panel A ma własny wpis. Kolejność
       * „najpierw `bySession`" wzięłaby gałąź `pane move` i przepięła wpis panelu B na adres
       * panelu A — karta panelu A nie dostałaby ŻADNEGO zdarzenia, a follower czytałby stary plik.
       * Panel jest fizyczną kotwicą: dwa wpisy → wierzymy `pane_id`.
       */
      const s = await setup([agentAt(0), agentAt(1)]);
      s.supervisor.attach(agentAt(0).paneId);
      s.supervisor.attach(agentAt(1).paneId);
      const driverA = s.drivers[0]!;
      const driverB = s.drivers[1]!;
      const resumed = agentAt(1).agentSessionId;

      s.client.agents = [agentAt(0, { agentSessionId: resumed }), agentAt(1)];
      s.scheduler.advance(HERDR_RESYNC_MS);
      await flush();

      expect(driverA.events).toContainEqual({ type: 'session-changed', agentSessionId: resumed });
      expect(driverB.events.some((ev) => ev.type === 'pane-changed')).toBe(false);
      expect(s.lifecycle.filter((ev) => ev.type === 'appeared')).toHaveLength(2);
      expect(s.lifecycle.some((ev) => ev.type === 'gone')).toBe(false);
      // Panel A nie zmienił adresu — wpis panelu B nie został na niego przepięty.
      expect(driverA.ctx.handle.agent.paneId).toBe(agentAt(0).paneId);
      expect(driverB.ctx.handle.agent.paneId).toBe(agentAt(1).paneId);
    });

  it('nowy panel → `appeared`; znikniecie panelu → `gone` na obu kanałach', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.agents = [agentAt(1)];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(driver.events).toContainEqual({ type: 'gone' });
    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toEqual([
      { type: 'gone', key: 'w9:p72' },
    ]);
    expect(s.lifecycle.filter((ev) => ev.type === 'appeared')).toHaveLength(2);
  });

  /**
   * Zaufanie katalogu RE-EKSEKUUJE `claude`.
   *
   * Panel zostaje ten sam, ale agent na moment znika z `agent.list`. Bez karencji nadzorca
   * ogłosiłby `gone`, manager zamknąłby kartę (`done` + `stale`) i sesja nie wróciłaby — a wraca
   * ten sam `pane_id` z tym samym `agent_session`, czyli DOKŁADNIE ta sama rozmowa.
   */
  it('refreshMode oddaje WŁASNY odczyt: dokładny tryb, `unknown` bez stopki', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    // Agent stoi w `auto` od pierwszego odczytu; wymuszony odczyt po `shift+tab` widzi plan.
    s.client.screen = footerAuto.replace('auto mode on', 'plan mode on');
    expect(await driver.ctx.refreshMode()).toBe('plan');
    expect(driver.events.at(-1)).toEqual({ type: 'mode', mode: 'plan' });

    s.client.screen = footerAuto.replace('auto mode on', 'accept edits on');
    // `acceptEdits` osobno od `auto` — pętla przełączania trybu nie może uznać go za cel…
    expect(await driver.ctx.refreshMode()).toBe('acceptEdits');
    // …ale wpis nadzorcy i chip dostają wartość zlaną z kontraktu.
    expect(driver.events.at(-1)).toEqual({ type: 'mode', mode: 'auto' });

    s.client.screen = 'jakiś ekran bez stopki trybu';
    // Stopki nie widać: wynik TEGO odczytu to `unknown`, choć wpis dalej pamięta `auto`
    // (reguła 11.3) — porównanie znaczników czasu nie zastępuje wyniku odczytu.
    expect(await driver.ctx.refreshMode()).toBe('unknown');
    expect(driver.events.filter((ev) => ev.type === 'mode')).toHaveLength(2);
  });

  it('zniknięcie tuż po dialogu zaufania NIE jest `gone` — czekamy na powrót', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;
    driver.ctx.markTrustDialog();

    // `claude` znika z listy na czas re-eksekucji.
    s.client.agents = [];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toHaveLength(0);
    expect(driver.events).not.toContainEqual({ type: 'gone' });

    // …i wraca pod tym samym adresem, z tym samym uuidem sesji silnika — herdr melduje to
    // zdarzeniem składu paneli, czyli szybciej niż najbliższy pełny resync.
    s.client.agents = [agentAt(0)];
    s.transport.emit({ type: 'event', kind: 'pane_agent_detected', data: {} });
    await flush();
    s.scheduler.advance(RESUBSCRIBE_DEBOUNCE_MS);
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toHaveLength(0);
    // JEDNA sesja: `appeared` nie leci drugi raz, a manager dostaje `re-attached` — po
    // re-eksekucji plik transkryptu bywa nowy, więc świeże podpięcie jest tu wartością.
    expect(s.lifecycle.filter((ev) => ev.type === 'appeared')).toHaveLength(1);
    expect(s.lifecycle.filter((ev) => ev.type === 're-attached')).toHaveLength(1);
  });

  it('panel, który po karencji NIE wrócił, znika normalną drogą', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    s.drivers[0]!.ctx.markTrustDialog();

    s.client.agents = [];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toHaveLength(0);

    s.scheduler.advance(HERDR_TRUST_REEXEC_GRACE_MS);
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toEqual([
      { type: 'gone', key: 'w9:p72' },
    ]);
  });

  it('karencja zaufania WYGASA — zniknięcie długo po dialogu to zwykłe `gone`', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    s.drivers[0]!.ctx.markTrustDialog();

    // Minuta pracy po zatwierdzeniu zaufania: zamknięcie panelu jest już zamknięciem panelu.
    s.clock.value += 60_000;
    s.client.agents = [];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toEqual([
      { type: 'gone', key: 'w9:p72' },
    ]);
  });

  it('`agentFor` daje migawkę żywego panelu, a nieznany klucz — undefined', async () => {
    const s = await setup([agentAt(0)]);
    expect(s.supervisor.agentFor?.('w9:p72')?.cwd).toBe(agentAt(0).cwd);
    expect(s.supervisor.agentFor?.('wX:p0')).toBeUndefined();
  });

  it('nowy panel pod adresem po `pane move` NIE przejmuje cudzej tożsamości', async () => {
    const s = await setup([agentAt(0)]);
    // Agent 0 wyjeżdża z `w9:p72`, a pod tym adresem staje ktoś nowy.
    s.client.agents = [
      agentAt(0, { paneId: 'wZ:p99' }),
      agentAt(1, { paneId: 'w9:p72' }),
    ];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    const keys = s.lifecycle
      .filter((ev): ev is Extract<HerdrLifecycleEvent, { type: 'appeared' }> => (
        ev.type === 'appeared'
      ))
      .map((ev) => ev.agent.key);
    expect(keys).toEqual(['w9:p72', 'w9:p72#1']);
  });
});

describe('status, strażnik kolejności i karencja', () => {
  it('zmiana statusu leci na uchwyt', async () => {
    const s = await setup([agentAt(0, { status: 'idle', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.agents = [agentAt(0, { status: 'working', stateChangeSeq: 11 })];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(driver.events.at(-1)).toMatchObject({ type: 'status', status: 'working' });
  });

  /*
   * Tytuł terminala herdr dalej jedzie do drivera, także sam, bez zmiany statusu. Pierwszeństwo nazwy
   * z `custom-title` ustala manager, nie nadzorca.
   */
  it('sama zmiana tytułu panelu (`/rename` w terminalu) leci na uchwyt z nowym tytułem', async () => {
    const s = await setup([agentAt(0, { status: 'idle', stateChangeSeq: 10, title: 'Claude Code' })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.agents = [agentAt(0, { status: 'idle', stateChangeSeq: 10, title: 'demo-eksport' })];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(driver.events.at(-1)).toMatchObject({ type: 'status', status: 'idle', title: 'demo-eksport' });
  });

  it('aktualizacja ze starszym `state_change_seq` jest odrzucana', async () => {
    const s = await setup([agentAt(0, { status: 'working', stateChangeSeq: 50 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.agents = [agentAt(0, { status: 'idle', stateChangeSeq: 49 })];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    /*
     * Resync POWTARZA status przy każdym obrocie, więc „zero zdarzeń" przestało
     * być miarą — miarą jest WARTOŚĆ: spóźniona migawka nie ma prawa przestawić ani stanu
     * wpisu, ani tego, co usłyszał driver.
     */
    const statuses = driver.events.filter((ev) => ev.type === 'status');
    expect(statuses.every((ev) => ev.status === 'working')).toBe(true);
    expect(driver.ctx.handle.agent.status).toBe('working');
  });

  /**
   * TEST OBOWIĄZKOWY (Rarog nie może pokazywać pracy, gdy w herdr wszystko skończone).
   *
   * Nadzorca zgłaszający status WYŁĄCZNIE przy zmianie swojej własnej migawki milczałby zawsze,
   * gdy się zgadza. A stan SESJI potrafi się rozjechać bez udziału herdr: Rarog ustawia
   * `running` optymistycznie po wysyłce, a karencja połyka `idle` z pierwszych 3 s. Jeśli agent
   * skończy w tym oknie, każdy kolejny odczyt jest „bez zmiany" — i karta zostałaby zielona do
   * restartu Raroga. Resync ma POWTARZAĆ prawdę, nie tylko jej zmiany.
   */
  it('resync POWTARZA status, nawet gdy nadzorca nie widzi u siebie zmiany', async () => {
    const s = await setup([agentAt(0, { status: 'idle', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;
    const before = driver.events.filter((ev) => ev.type === 'status').length;

    // Ta sama migawka co poprzednio — zero zmian po stronie nadzorcy.
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    const after = driver.events.filter((ev) => ev.type === 'status');
    expect(after.length).toBeGreaterThan(before);
    expect(after.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });

  /**
   * TEST OBOWIĄZKOWY. Agent główny w trakcie workflow błyska `working` na ułamek sekundy między
   * rozstawianiem subagentów. Bez karencji każdy taki błysk malował kartę na zielono i zerował
   * jej timer — panel wyglądał na „ciągle pracujący", a herdr sekundę później na „skończony".
   */
  it('błysk `working` z pusha KRÓTSZY niż karencja nie dociera do drivera', async () => {
    const s = await setup([agentAt(0, { status: 'idle', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.agents = [agentAt(0, { status: 'working', stateChangeSeq: 11 })];
    s.transport.emit({
      type: 'event',
      kind: 'pane_agent_status_changed',
      data: { pane_id: 'w9:p72', workspace_id: 'w9', agent_status: 'working' },
    });
    await flush();
    expect(driver.events.filter((ev) => ev.type === 'status' && ev.status === 'working'))
      .toHaveLength(0);

    // …i wraca do ciszy, zanim karencja minie: zegar ma się rozbroić, a nie wypalić później.
    s.client.agents = [agentAt(0, { status: 'done', stateChangeSeq: 12 })];
    s.transport.emit({
      type: 'event',
      kind: 'pane_agent_status_changed',
      data: { pane_id: 'w9:p72', workspace_id: 'w9', agent_status: 'done' },
    });
    await flush();
    s.scheduler.advance(HERDR_WORKING_GRACE_MS);
    await flush();

    expect(driver.events.filter((ev) => ev.type === 'status' && ev.status === 'working'))
      .toHaveLength(0);
    expect(driver.ctx.handle.agent.status).toBe('done');
  });

  it('praca, która się UTRZYMA, dociera normalnie', async () => {
    const s = await setup([agentAt(0, { status: 'idle', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.agents = [agentAt(0, { status: 'working', stateChangeSeq: 11 })];
    s.transport.emit({
      type: 'event',
      kind: 'pane_agent_status_changed',
      data: { pane_id: 'w9:p72', workspace_id: 'w9', agent_status: 'working' },
    });
    await flush();
    s.scheduler.advance(HERDR_WORKING_GRACE_MS);
    await flush();

    expect(driver.events.at(-1)).toMatchObject({ type: 'status', status: 'working' });
  });

  it('`unknown` NIE emituje zmiany stanu (reguła: nigdy nie zgaduj „skończył")', async () => {
    const s = await setup([agentAt(0, { status: 'working', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.agents = [agentAt(0, { status: 'unknown', stateChangeSeq: 11 })];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(driver.events.filter((ev) => ev.type === 'status')).toHaveLength(0);
  });

  it('karencja: `idle` w 1 s po wysyłce ignorowane, w 4 s zastosowane', async () => {
    const s = await setup([agentAt(0, { status: 'working', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;
    s.supervisor.markSent('w9:p72');

    s.client.agents = [agentAt(0, { status: 'idle', stateChangeSeq: 11 })];
    s.clock.value += 1_000;
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    // Karencja połknęła `idle`; powtórzony przez resync status mówi dalej „pracuje".
    expect(driver.events.filter((ev) => ev.type === 'status' && ev.status === 'idle'))
      .toHaveLength(0);

    s.clock.value += HERDR_IDLE_GRACE_MS;
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    expect(driver.events.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });

  it('karencja NIE dotyczy `blocked` — dialog musi być widoczny natychmiast', async () => {
    const s = await setup([agentAt(0, { status: 'working', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;
    s.supervisor.markSent('w9:p72');

    s.client.agents = [agentAt(0, { status: 'blocked', stateChangeSeq: 11 })];
    s.clock.value += 1_000;
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(driver.events.at(-1)).toMatchObject({ type: 'status', status: 'blocked' });
  });

  it('zmiana trybu panelu leci jako osobne zdarzenie `mode`', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.screen = footerAuto.replace('auto mode on', 'bypass permissions on');
    resyncTick(s);
    await flush();

    expect(driver.events).toContainEqual({ type: 'mode', mode: 'bypass' });
    expect(driver.ctx.handle.agent.mode).toBe('bypass');
  });

  /*
   * Odstęp `MODE_READ_MIN_INTERVAL_MS` obowiązuje KAŻDĄ drogę odczytu, także resync.
   * Resync leci nie tylko z tikiem 30 s, ale i z debounce 500 ms po
   * zdarzeniach składu paneli — burza `pane_created`/`pane_moved` (zakładanie panelu,
   * przenoszenie taba na Macu) dałaby serię pełnych odczytów ekranu × liczba paneli
   * w oknie, w którym stopka trybu nie miała prawa się zmienić.
   *
   * Świeżości to nie psuje: przy tiku 30 s odstęp 10 s niczego nie odcina, nowy panel czyta
   * bezwarunkowo (ścieżka „nowy agent"), a bramka wysyłki ma własne `ensureFreshMode`.
   */
  it('resync w oknie odstępu NIE czyta stopki drugi raz', async () => {
    const s = await setup([agentAt(0)]);
    const afterStart = s.client.calls.read;
    expect(afterStart).toBe(1);

    // Burza zdarzeń składu: trzy resynce z debounce, wszystkie w tej samej sekundzie.
    for (let i = 0; i < 3; i += 1) {
      s.clock.value += 100;
      s.transport.emit({ type: 'event', kind: 'pane_moved', data: {} });
      await flush();
      s.scheduler.advance(RESUBSCRIBE_DEBOUNCE_MS);
      await flush();
    }
    expect(s.client.calls.list).toBeGreaterThan(1);
    expect(s.client.calls.read).toBe(afterStart);

    // Po odstępie następny resync czyta normalnie — odczyt jest odłożony, nie skasowany.
    resyncTick(s);
    await flush();
    expect(s.client.calls.read).toBe(afterStart + 1);
  });

  it('dialog zgody CLI na ekranie BEZCZYNNEGO panelu → `consent-dialog` na zmianę', async () => {
    /*
     * CLI 2.1.258: „Teach auto mode about your environment?" staje po turze, herdr
     * widzi `idle`, a status się nie zmienia — bez odczytu ekranu bezczynnych paneli nadzorca
     * nigdy by go nie zobaczył. Zdarzenie niesie SAM identyfikator, nigdy tekst ekranu.
     */
    const consent = readFileSync(
      join(FIXTURES, 'dialog-automode-teach-2.1.258.txt'), 'utf8',
    );
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.screen = consent;
    resyncTick(s);
    await flush();
    expect(driver.events).toContainEqual({ type: 'consent-dialog', dialog: 'auto-mode-teach' });
    // Dialog zasłania stopkę — tryb ZOSTAJE (reguła 11.3), nie ma `mode: unknown`.
    expect(driver.events).not.toContainEqual({ type: 'mode', mode: 'unknown' });

    // Ten sam ekran w następnym tiku = zero powtórek.
    resyncTick(s);
    await flush();
    expect(driver.events.filter((e) => e.type === 'consent-dialog')).toHaveLength(1);

    s.client.screen = footerAuto;
    resyncTick(s);
    await flush();
    expect(driver.events).toContainEqual({ type: 'consent-dialog', dialog: null });
  });

  it('nieczytelna stopka NIE kasuje znanego `bypass`', async () => {
    /*
     * Reguła bezpieczeństwa, nie kosmetyka. Nakładka (`/status`, pełnoekranowy dialog) zasłania
     * stopkę, więc `parseMode` oddaje `unknown`. Gdyby nadzorca to zapisał, panel w `bypass
     * permissions` straciłby chip ORAZ blokadę `RAROG_YOLO_ROOTS` — dokładnie w chwili, w której
     * na ekranie coś się dzieje. Reguła 11.3: nieznane → zostaw poprzednie.
     */
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.client.screen = footerAuto.replace('auto mode on', 'bypass permissions on');
    resyncTick(s);
    await flush();
    expect(driver.ctx.handle.agent.mode).toBe('bypass');

    s.client.screen = 'Esc to cancel';
    resyncTick(s);
    await flush();

    expect(driver.ctx.handle.agent.mode).toBe('bypass');
    expect(driver.events).not.toContainEqual({ type: 'mode', mode: 'unknown' });
  });
});

describe('subskrypcja zdarzeń', () => {
  it('subskrybuje globalne zdarzenia i `agent_status_changed` per znany panel', async () => {
    const s = await setup([agentAt(0), agentAt(1)]);
    const subs = s.transport.current.subs;
    expect(subs.filter((x) => x.pane_id === undefined).map((x) => x.type).sort()).toEqual([
      'pane.agent_detected', 'pane.closed', 'pane.created', 'pane.exited', 'pane.moved',
    ]);
    expect(subs.filter((x) => x.pane_id !== undefined).map((x) => x.pane_id).sort())
      .toEqual(['w9:p1Y', 'w9:p72']);
  });

  it('push o zmianie statusu pyta `agent.get` i wykrywa `/clear` bez czekania na resync', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;
    const before = s.client.calls.get;
    const fresh = '77777777-1111-5222-8333-444444444444';

    s.client.agents = [agentAt(0, { agentSessionId: fresh, status: 'working', stateChangeSeq: 40 })];
    s.transport.emit({
      type: 'event',
      kind: 'pane_agent_status_changed',
      data: { pane_id: 'w9:p72', workspace_id: 'w9', agent_status: 'working' },
    });
    await flush();

    expect(s.client.calls.get).toBe(before + 1);
    expect(driver.events).toContainEqual({ type: 'session-changed', agentSessionId: fresh });
    // Wejście w pracę z PUSHA czeka na potwierdzenie (`HERDR_WORKING_GRACE_MS`) — patrz karencja
    // w `applyInfo`. Rozpoznanie `/clear` jest natychmiastowe i to ono jest sednem tego testu.
    s.scheduler.advance(HERDR_WORKING_GRACE_MS);
    await flush();
    expect(driver.events.at(-1)).toMatchObject({ type: 'status', status: 'working' });
  });

  it('powtórzony push (replay po re-subscribe) nie duplikuje zdarzeń', async () => {
    const s = await setup([agentAt(0, { status: 'idle', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;
    s.client.agents = [agentAt(0, { status: 'working', stateChangeSeq: 11 })];

    for (let i = 0; i < 3; i += 1) {
      s.transport.emit({
        type: 'event',
        kind: 'pane_agent_status_changed',
        data: { pane_id: 'w9:p72', workspace_id: 'w9', agent_status: 'working' },
      });
      await flush();
    }
    // Trzy pushe = JEDEN zbrojony zegar karencji i jedno zdarzenie po jego wygaśnięciu.
    s.scheduler.advance(HERDR_WORKING_GRACE_MS);
    await flush();

    expect(driver.events.filter((ev) => ev.type === 'status')).toHaveLength(1);
  });

  it('burza zdarzeń o składzie paneli → JEDNO re-subscribe po debounce', async () => {
    const s = await setup([agentAt(0)]);
    const before = s.transport.opened.length;
    s.client.agents = [agentAt(0), agentAt(1)];

    for (let i = 0; i < 10; i += 1) {
      s.transport.emit({ type: 'event', kind: 'pane_created', data: { type: 'pane_created' } });
    }
    await flush();
    expect(s.transport.opened).toHaveLength(before);

    s.scheduler.advance(RESUBSCRIBE_DEBOUNCE_MS);
    await flush();

    expect(s.transport.opened).toHaveLength(before + 1);
    expect(s.transport.opened[before - 1]?.closed).toBe(true);
    expect(s.transport.current.subs.filter((x) => x.pane_id !== undefined)).toHaveLength(2);
  });

  it('resync bez zmiany składu NIE otwiera nowej subskrypcji', async () => {
    const s = await setup([agentAt(0)]);
    const before = s.transport.opened.length;
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    expect(s.transport.opened).toHaveLength(before);
  });
});

describe('dostępność herdr', () => {
  it('padnięcie socketu → JEDNO `unavailable`, nie N × `gone`', async () => {
    const s = await setup();
    s.transport.emit({ type: 'disconnected', reason: foreign('ECONNRESET') });
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'unavailable')).toHaveLength(1);
    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toHaveLength(0);
    expect(s.supervisor.status().agentCount).toBe(17);
  });

  it('powrót → `available`, `re-attached` dla podpiętych i `appeared` tylko dla nowych', async () => {
    const s = await setup([agentAt(0)]);
    s.supervisor.attach('w9:p72');

    s.transport.emit({ type: 'disconnected', reason: foreign('ECONNRESET') });
    await flush();

    s.client.agents = [agentAt(0), agentAt(1)];
    s.transport.emit({ type: 'connected' });
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'available')).toHaveLength(1);
    // Awaria i powrót zostawiają w logu po JEDNEJ linii — z powodem zerwania.
    expect(s.logs.filter((l) => l.startsWith('herdr: unavailable'))).toEqual([
      'herdr: unavailable — ECONNRESET',
    ]);
    expect(s.logs.filter((l) => l === 'herdr: available again')).toHaveLength(1);
    const reattached = s.lifecycle.filter((ev) => ev.type === 're-attached');
    expect(reattached).toHaveLength(1);
    expect(reattached[0]?.type === 're-attached' && reattached[0].agent.key).toBe('w9:p72');
    // Drugi panel jest nowy → `appeared`, a nie `re-attached`.
    expect(s.lifecycle.filter((ev) => ev.type === 'appeared')).toHaveLength(2);
  });

  it('restart herdr zeruje `state_change_seq`, a mimo to stany wracają', async () => {
    /*
     * Zmierzone na żywo: po zatrzymaniu i ponownym starcie serwera herdr licznik
     * `state_change_seq` wraca do 0. Strażnik kolejności sam odrzucałby wtedy KAŻDĄ aktualizację,
     * dopóki panel nie „dorobi" numeru sprzed awarii — czyli po restarcie herdr Rarog pokazywałby
     * zamrożone stany wszystkich kart. Resync jest źródłem prawdy,
     * więc pierwsza aktualizacja po powrocie gniazda przebija zapamiętany licznik.
     */
    const s = await setup([agentAt(0, { status: 'idle', stateChangeSeq: 163 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;

    s.transport.emit({ type: 'disconnected', reason: foreign('ECONNRESET') });
    await flush();

    s.client.agents = [agentAt(0, { status: 'working', stateChangeSeq: 0 })];
    s.transport.emit({ type: 'connected' });
    await flush();

    expect(driver.ctx.handle.agent.status).toBe('working');
    expect(driver.events.at(-1)).toMatchObject({ type: 'status', status: 'working' });
  });

  it('nieudany resync (herdr nie odpowiada) → `unavailable`, stany bez zmian', async () => {
    const s = await setup([agentAt(0)]);
    s.client.listFails = 'ECONNREFUSED';
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'unavailable')).toHaveLength(1);
    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toHaveLength(0);
    expect(s.supervisor.status().agentCount).toBe(1);
  });

  it('agent, który zniknął w trakcie `agent.get`, jest traktowany jak `gone`', async () => {
    const s = await setup([agentAt(0)]);
    s.client.agents = [];
    s.transport.emit({
      type: 'event',
      kind: 'pane_agent_status_changed',
      data: { pane_id: 'w9:p72', workspace_id: 'w9', agent_status: 'idle' },
    });
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toHaveLength(1);
  });
});

describe('attach, markSent i dispose', () => {
  it('`attach` na nieznanym kluczu rzuca HerdrGoneError', async () => {
    const s = await setup([agentAt(0)]);
    expect(() => s.supervisor.attach('nie-ma-takiego')).toThrow(HerdrGoneError);
  });

  it('`attach` daje driverowi uchwyt, klienta, audit i `markSent`', async () => {
    const s = await setup([agentAt(0)]);
    const driver = s.supervisor.attach('w9:p72');
    expect(driver.ownsProcess).toBe(false);

    const ctx = s.drivers[0]!.ctx;
    expect(ctx.handle.agent.key).toBe('w9:p72');
    expect(ctx.sendEnabled).toBe(true);
    expect(typeof ctx.markSent).toBe('function');
    expect(await ctx.client.listAgents()).toEqual(await s.client.listAgents()); // wrapped (answer recheck), same herdr
    // Deterministyczny identyfikator sesji Raroga — ten sam po restarcie.
    expect(ctx.sessionId).toBe(sessionIdFor('w9:p72'));
  });

  it('`markSent` z kontekstu drivera startuje tę samą karencję co metoda supervisora', async () => {
    const s = await setup([agentAt(0, { status: 'working', stateChangeSeq: 10 })]);
    s.supervisor.attach('w9:p72');
    const driver = s.drivers[0]!;
    driver.ctx.markSent();

    s.client.agents = [agentAt(0, { status: 'done', stateChangeSeq: 11 })];
    s.clock.value += 500;
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    // Jak wyżej: liczy się WARTOŚĆ. `done` z karencji nie doszło, powtórka mówi „pracuje".
    expect(driver.events.filter((ev) => ev.type === 'status' && ev.status === 'done'))
      .toHaveLength(0);
  });

  it('`dispose()` NIE wysyła do herdr niczego i zamyka subskrypcję', async () => {
    const s = await setup();
    s.supervisor.attach('w9:p72');
    s.supervisor.dispose();
    await flush();

    expect(s.client.calls.prompt).toBe(0);
    expect(s.client.calls.sendKeys).toBe(0);
    expect(s.client.calls.focus).toBe(0);
    expect(s.transport.opened.every((sub) => sub.closed)).toBe(true);
    active = null;
  });

  it('po `dispose()` nie ma już resyncu', async () => {
    const s = await setup([agentAt(0)]);
    const before = s.client.calls.list;
    s.supervisor.dispose();
    s.scheduler.advance(HERDR_RESYNC_MS * 3);
    await flush();
    expect(s.client.calls.list).toBe(before);
    active = null;
  });
});

// ---------------------------------------------------------------------------
// Kanał TWORZENIA i własność paneli
// ---------------------------------------------------------------------------

/** Fasada metod tworzących — liczy WSZYSTKO, co poszłoby do herdr. */
class FakeLaunchClient implements HerdrLaunchClient {
  readonly closedTabs: string[] = [];
  readonly stamped: { paneId: string; tokens: Record<string, string | null> }[] = [];
  /** Odpowiedź `pane.list` — rejestr terminali czyta ją przy resyncu i odbudowie. */
  panes: HerdrPaneInfo[] = [];
  /** Ile razy resync sięgnął po `pane.list` — człon rachunku obciążenia bramki gniazda. */
  listPanesCalls = 0;

  listPanes(): Promise<HerdrPaneInfo[]> {
    this.listPanesCalls += 1;
    return Promise.resolve(this.panes.map((pane) => ({ ...pane, tokens: { ...pane.tokens } })));
  }

  /** Historia panelu (`pane.read`) — nadzorca jej nie dotyka; stub trzyma kontrakt. */
  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ text: '', truncated: false });
  }

  /** Procesy pierwszego planu (`pane.process_info`) — terminal i sprzątanie po restarcie. */
  foreground: { pid: number; name: string; argv0: string }[] = [];

  readPaneProcess(): Promise<{ processes: readonly { pid: number; name: string; argv0: string }[] }> {
    return Promise.resolve({ processes: this.foreground });
  }

  /**
   * Inwentarz OBECNOŚCI — domyślnie te same panele co `panes`; test może dołożyć wiersze
   * „zubożone" (obecne w herdr, odfiltrowane przez normalizację) przez `extraPaneIds`.
   */
  extraPaneIds: string[] = [];
  /**
   * Panele w tabach, których `listPanes` nie oddaje (np. `restore_error` — herdr ich nie
   * odtworzył), a `tab.get` liczy i inwentarz obecności zna.
   */
  hiddenPanes: { paneId: string; tabId: string }[] = [];

  listPaneIds(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set([
      ...this.panes.map((pane) => pane.paneId), ...this.hiddenPanes.map((pane) => pane.paneId),
      ...this.extraPaneIds,
    ]));
  }

  /** `workspace.list` czyta wyłącznie launcher (resolver workspace'u projektu) — tu launcher jest atrapą. */
  listWorkspaces(): Promise<never> {
    return Promise.reject(new Error('nieużywane: launcher jest atrapą'));
  }

  createWorkspace(): Promise<never> {
    return Promise.reject(new Error('nieużywane: launcher jest atrapą'));
  }

  createTab(): Promise<never> {
    return Promise.reject(new Error('nieużywane: launcher jest atrapą'));
  }

  startAgent(): Promise<never> {
    return Promise.reject(new Error('nieużywane: launcher jest atrapą'));
  }

  reportPaneMetadata(params: { paneId: string; tokens?: Readonly<Record<string, string | null>> })
    : Promise<void> {
    this.stamped.push({ paneId: params.paneId, tokens: { ...params.tokens } });
    return Promise.resolve();
  }

  /**
   * Etykiety paneli i tabów — nadzorca nadaje je przy synchronizacji etykiety taba
   * z kartą (`syncTabLabel`); atrapa notuje KAŻDE wywołanie i zmienia stan jak herdr.
   */
  readonly renamed: { kind: 'pane' | 'tab'; id: string; label: string | null }[] = [];
  /** Bieżące etykiety tabów (`tab.get`); `paneCount` liczy się z {@link panes}. */
  readonly tabs = new Map<string, string>();
  /** Ile razy padło `tab.get` — rachunek odczytów synchronizacji. */
  tabReads = 0;
  /**
   * Wynik następnego `tab.rename`: `ok`; `error` — herdr odmówił; `timeout` — transport padł
   * przed skutkiem; `timeout-applied` — skutek JEST, zginęła odpowiedź; `read-only` — bramka.
   */
  tabRenameOutcome: 'ok' | 'error' | 'timeout' | 'timeout-applied' | 'read-only' = 'ok';
  /** Wynik następnych `pane.rename` — te same wartości co przy tabie. */
  paneRenameOutcome: 'ok' | 'error' | 'timeout' | 'read-only' = 'ok';
  /** Opóźnienie odpowiedzi `pane.rename` (obietnica do rozstrzygnięcia przez test). */
  paneRenameGate: Promise<void> | null = null;

  /** Zapora `tab.get` — test trzyma przebieg synchronizacji „w locie" i zmienia świat. */
  getTabGate: Promise<void> | null = null;
  /** Wołane w `tab.get` po zaporze, PRZED odpowiedzią — zmiana świata w środku przebiegu. */
  onGetTab: (() => void) | null = null;
  /** Ile NASTĘPNYCH `tab.get` ma paść (chwilowo martwe gniazdo). */
  getTabFails = 0;

  async getTab(tabId: string): Promise<{
    tabId: string; label: string; paneCount: number; workspaceId: string;
  }> {
    this.tabReads += 1;
    if (this.getTabGate !== null) await this.getTabGate;
    this.onGetTab?.();
    if (this.getTabFails > 0) {
      this.getTabFails -= 1;
      throw new HerdrUnavailableError(foreign('Przekroczony czas odpowiedzi herdr (tab.get).'));
    }
    const inTab = this.panes.filter((pane) => pane.tabId === tabId);
    const hidden = this.hiddenPanes.filter((pane) => pane.tabId === tabId);
    return {
      tabId,
      label: this.tabs.get(tabId) ?? '1',
      paneCount: inTab.length + hidden.length,
      workspaceId: inTab[0]?.workspaceId ?? '',
    };
  }

  async renamePane(paneId: string, label: string | null): Promise<void> {
    this.renamed.push({ kind: 'pane', id: paneId, label });
    if (this.paneRenameGate !== null) await this.paneRenameGate;
    if (this.paneRenameOutcome === 'read-only') {
      throw new HerdrReadOnlyError(foreign('kanał zapisu wyłączony (RAROG_HERDR_SEND=0)'));
    }
    if (this.paneRenameOutcome === 'error') throw new Error('pane.rename odrzucone');
    if (this.paneRenameOutcome === 'timeout') {
      throw new HerdrUnavailableError(foreign('Przekroczony czas odpowiedzi herdr (pane.rename).'));
    }
    this.panes = this.panes.map((pane) => (pane.paneId === paneId ? { ...pane, label } : pane));
  }

  renameTab(tabId: string, label: string): Promise<void> {
    this.renamed.push({ kind: 'tab', id: tabId, label });
    const outcome = this.tabRenameOutcome;
    if (outcome === 'read-only') {
      return Promise.reject(new HerdrReadOnlyError(foreign('kanał zapisu wyłączony (RAROG_HERDR_SEND=0)')));
    }
    if (outcome === 'error') return Promise.reject(new Error('tab.rename odrzucone'));
    if (outcome === 'ok' || outcome === 'timeout-applied') this.tabs.set(tabId, label);
    return outcome === 'ok'
      ? Promise.resolve()
      : Promise.reject(new HerdrUnavailableError(foreign('Przekroczony czas odpowiedzi herdr (tab.rename).')));
  }

  closeTab(tabId: string): Promise<void> {
    this.closedTabs.push(tabId);
    return Promise.resolve();
  }

  /*
   * `pane.close` należy WYŁĄCZNIE do terminala na backendzie herdr (`term/herdr-backend.ts`).
   * Nadzorca sesji nie ma prawa go wołać i ta atrapa tego pilnuje: wywołanie stąd znaczy,
   * że ktoś dołożył supervisorowi władzy zamykania cudzych paneli.
   */
  closePane(paneId: string): Promise<void> {
    return Promise.reject(new Error(`nadzorca nie zamyka paneli (${paneId})`));
  }

  probeAgent(): Promise<never> {
    return Promise.reject(new Error('nieużywane: launcher jest atrapą'));
  }
}

/**
 * Launcher-atrapa: oddaje uchwyt do panelu, którego `agent.list` jeszcze nie widzi.
 *
 * `settled` mówi, W JAKIM STANIE launcher zastał panel, gdy przestał na niego czekać.
 * Domyślnie to zwykły, gotowy panel; wariant `blocked` odwzorowuje panel stojący na dialogu
 * zaufania — jedyny, o którym `agent.list` NIGDY nie doniesie (brak `agent_session`).
 */
function fakeLauncher(
  paneId: string,
  agentSessionId: string,
  settled: { status: HerdrAgentStatus; interactiveReady: boolean }
    = { status: 'idle', interactiveReady: true },
): {
  launcher: HerdrLauncher; settle: () => void; calls: HerdrLaunchRequest[];
} {
  const calls: HerdrLaunchRequest[] = [];
  let settleReady: () => void = () => {};
  const launcher: HerdrLauncher = {
    launch: (req) => {
      calls.push(req);
      const result = {
        key: paneId,
        paneId,
        tabId: `${paneId}:tab`,
        agentSessionId,
        createdWorkspace: false,
        argv: ['--session-id', agentSessionId],
        status: settled.status,
        interactiveReady: settled.interactiveReady,
      };
      const ready = new Promise<typeof result>((resolve) => {
        settleReady = () => { resolve(result); };
      });
      return Promise.resolve({
        key: paneId, paneId, tabId: result.tabId, agentSessionId, ready,
      });
    },
  };
  return { launcher, settle: () => { settleReady(); }, calls };
}

describe('zakładanie panelu i własność', () => {
  const NEW_PANE = 'w9:pNOWY';
  const NEW_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  it('świeżo założony panel NIE generuje `appeared` — manager już o nim wie', async () => {
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    const before = s.lifecycle.filter((ev) => ev.type === 'appeared').length;

    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    // Panel pojawia się w `agent.list` chwilę PO `tab.create` — resync nie ma prawa zrobić
    // z niego drugiej karty na tę samą sesję.
    s.client.agents = [...s.client.agents, agentAt(0, {
      paneId: NEW_PANE, agentSessionId: NEW_SESSION, tabId: `${NEW_PANE}:tab`,
    })];
    // Pełny resync wywołany pushem `pane.created` — czyli dokładnie tą drogą, którą świeży
    // panel dociera do supervisora na żywo.
    s.transport.emit({ type: 'event', kind: 'pane_created', data: {} });
    await flush();
    s.scheduler.advance(RESUBSCRIBE_DEBOUNCE_MS);
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'appeared')).toHaveLength(before);
    expect(handle.key).toBe(NEW_PANE);
    // …a `attach()` działa natychmiast, bo wpis JEST w mapach supervisora.
    expect(s.supervisor.attach(handle.key)).toBeDefined();
  });

  it('resync PRZED pojawieniem się agenta NIE ogłasza `gone` (regresja)', async () => {
    /*
     * Panel istnieje od `tab.create`, ale w `agent.list` pojawia się dopiero ~2 s później:
     * `agent.start` leci obrót pętli po uchwycie, a `agent_session` herdr wypełnia jeszcze
     * później — do tego czasu filtr wejściowy odrzuca wpis w całości.
     *
     * Zmierzone na żywo: bez tej ochrony sesja szła `starting → done → starting`, manager
     * odpinał driver i PROMPT STARTOWY GINĄŁ po cichu. `attach()` nie może być tu bramką,
     * bo manager robi go SYNCHRONICZNIE, sekundy przed pojawieniem się agenta.
     */
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    s.supervisor.attach(handle.key);

    // Pełny resync, w którym nowego agenta JESZCZE NIE MA na liście.
    s.transport.emit({ type: 'event', kind: 'pane_created', data: {} });
    await flush();
    s.scheduler.advance(RESUBSCRIBE_DEBOUNCE_MS);
    await flush();

    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toHaveLength(0);
    // Wpis dalej żyje — `attach` i wysyłka mają do czego trafić.
    expect(() => s.supervisor.attach(handle.key)).not.toThrow();
  });

  it('po wygaśnięciu okna zakładania panel bez agenta JEST zapominany', async () => {
    // Druga strona tej samej reguły: ochrona jest oknem czasu, a nie wieczną amnestią —
    // panel, w którym `claude` nigdy nie wstał, nie ma prawa wisieć w Rarogu bez końca.
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    s.supervisor.attach(handle.key);

    s.scheduler.advance(LAUNCH_ADOPT_TIMEOUT_MS);
    await flush();
    s.transport.emit({ type: 'event', kind: 'pane_created', data: {} });
    await flush();
    s.scheduler.advance(RESUBSCRIBE_DEBOUNCE_MS);
    await flush();

    expect(s.lifecycle.some((ev) => ev.type === 'gone' && ev.key === NEW_PANE)).toBe(true);
  });

  it('rejestracja bez `attach` wygasa po 30 s i panel wraca jako `appeared`', async () => {
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });

    s.scheduler.advance(LAUNCH_ADOPT_TIMEOUT_MS);
    await flush();

    /*
     * Manager się nie podpiął (awaria w trakcie startu), a panel ŻYJE. Zostawienie go
     * niewidocznym byłoby dokładnie tym, czego zakazuje reguła 11.9: Rarog stworzył coś,
     * czego nie umie dokończyć, i schował to przed użytkownikiem.
     */
    const appeared = s.lifecycle.filter((ev) => ev.type === 'appeared');
    expect(appeared.some((ev) => ev.type === 'appeared' && ev.agent.key === NEW_PANE)).toBe(true);
  });

  it('`ready` domyka rejestrację: panel jest gotowy na wysyłkę', async () => {
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    launch.settle();
    await handle.ready;

    expect((await handle.ready).key).toBe(NEW_PANE);
  });

  /*
   * REGRESJA (claude 3.1.6).
   *
   * Panel stojący na dialogu ZAUFANIA nie ma jeszcze `agent_session` — proces `claude` nie
   * wystartował. `normalizeAgentInfo` odrzuca taki wpis w CAŁOŚCI, więc ani resync, ani push
   * nigdy o nim nie donoszą. Bez statusu z launchera wpis z `registerLaunched` zostałby na
   * `unknown` na zawsze: driver nie dostałby przejścia w `blocked`, karta zaufania nie powstałaby,
   * a telefon pokazywałby „czeka na polecenie" przy panelu, który stoi zablokowany bez końca.
   *
   * Status zaobserwowany przez launcher jest tu JEDYNYM źródłem prawdy — i musi dojechać do
   * drivera tą samą drogą co zwykła zmiana statusu.
   */
  it('panel zastany przez launcher w `blocked` melduje blokadę driverowi', async () => {
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION, {
      status: 'blocked', interactiveReady: false,
    });
    const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    s.supervisor.attach(handle.key);
    const record = s.drivers.at(-1);

    launch.settle();
    await handle.ready;
    await flush();

    const seen = record?.events ?? [];
    expect(seen.map((ev) => (ev.type === 'status' ? ev.status : null))).toContain('blocked');
    // …i panel NIE jest ogłoszony gotowym do wysyłki: `agent.prompt` oddałby `agent_not_ready`.
    expect(s.supervisor.agentFor?.(handle.key)?.interactiveReady).toBe(false);
  });

  /*
   * DRUGA POŁOWA TEGO SAMEGO ZNALEZISKA: panel na dialogu zaufania nie ma prawa zostać
   * ogłoszony `gone` tylko dlatego, że nie ma go w `agent.list`.
   *
   * Dialog stoi, dopóki człowiek nie zdecyduje — na żywo zmierzono minuty. Przez cały ten czas
   * filtr wejściowy odrzuca panel (brak `agent_session`), więc każdy resync wyglądał jak
   * „agent zniknął": sesja szła w `done` + `stale`, manager odpinał driver, a „Zatwierdź"
   * z telefonu odpowiadało `ok` i nie wysyłało ani jednego klawisza.
   */
  it('panel na stojącym dialogu NIE znika, choć `agent.list` go nie pokazuje', async () => {
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION, {
      status: 'blocked', interactiveReady: false,
    });
    const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    s.supervisor.attach(handle.key);
    launch.settle();
    await handle.ready;
    await flush();

    // Okno „zakładam" mija, a agenta na liście JAK NIE BYŁO, tak nie ma — i nie będzie,
    // dopóki dialog stoi. Kilka pełnych resyncow, czyli dokładnie to, co robi żywy Rarog.
    s.scheduler.advance(LAUNCH_ADOPT_TIMEOUT_MS + HERDR_TRUST_REEXEC_GRACE_MS);
    await flush();
    for (let i = 0; i < 3; i += 1) {
      s.scheduler.advance(HERDR_RESYNC_MS);
      await flush();
    }

    expect(s.lifecycle.some((ev) => ev.type === 'gone' && ev.key === NEW_PANE)).toBe(false);
    // …a panel dalej jest adresowalny, więc „Zatwierdź" z telefonu ma dokąd wysłać cyfrę.
    expect(s.supervisor.agentFor?.(handle.key)?.status).toBe('blocked');
  });

  it('closeTab zamyka także CUDZY panel', async () => {
    // Decyzja użytkownika: „× ma zamykać, bez znaczenia czyja sesja". Poprzednia zasada
    // („cudzych tabów nie zamykamy nigdy") chroniła wielodostęp, którego tu nie ma.
    const launchClient = new FakeLaunchClient();
    const s = await setup(parseAgentList({ agents: rawAgents }), { launchClient });

    const tabId = s.supervisor.agentFor?.('w9:p72')?.tabId ?? '';
    await s.supervisor.closeTab('w9:p72');
    expect(launchClient.closedTabs).toEqual([tabId]);
  });

  it('closeTab panelu CODEXA rzuca i nie zamyka niczego', async () => {
    /*
     * Bramka managera stoi na `engine` KARTY, a po zmianie silnika w panelu klucz dziedziczy
     * karta następcy — historyczna karta Claude potrafiła więc zaadresować tab Codexa.
     * Tu decyduje prawda nadzorcy, czyli silnik panelu.
     */
    const launchClient = new FakeLaunchClient();
    const s = await setup([codexAt(0)], { launchClient });

    await expect(s.supervisor.closeTab('w9:p72')).rejects.toBeInstanceOf(HerdrNotOwnedError);
    expect(launchClient.closedTabs).toEqual([]);
    // Odmowa nie jest „władzą wykonaną": w `herdr-audit.log` nie ma po niej śladu `close_tab`.
    expect(s.audit.filter((ev) => ev.method === 'close_tab')).toEqual([]);
    expect(s.supervisor.status().agentCount).toBe(1);
  });

  it('closeTab bez adresu taba rzuca i NIE dotyka gniazda', async () => {
    const launchClient = new FakeLaunchClient();
    const noTab = parseAgentList({ agents: rawAgents })
      .map((info, i) => (i === 0 ? { ...info, tabId: '' } : info));
    const s = await setup(noTab, { launchClient });

    await expect(s.supervisor.closeTab('w9:p72')).rejects.toBeInstanceOf(HerdrNotOwnedError);
    expect(launchClient.closedTabs).toEqual([]);
  });

  /*
   * Stary tab po restarcie sesji: w panelu została goła powłoka. Zamykamy go wyłącznie
   * wtedy, gdy świeży `pane.list` pokazuje w tym tabie JEDEN panel bez agenta — split
   * z panelem użytkownika albo agent w tej powłoce zostają.
   */
  it('closeShellTab zamyka jednopanelowy tab bez agenta i zostawia ślad `close_tab`', async () => {
    const launchClient = new FakeLaunchClient();
    const s = await setup(parseAgentList({ agents: rawAgents }), { launchClient });
    launchClient.panes = [{
      paneId: 'w9:pOLD', tabId: 'w9:tOLD', workspaceId: 'w9', cwd: '/Users/u/Projects/demo', tokens: {}, label: null,
    }];
    // Zmierzone: goła powłoka = dokładnie jeden proces pierwszego planu, `zsh`.
    launchClient.foreground = [{ pid: 80832, name: 'zsh', argv0: 'zsh' }];
    await expect(s.supervisor.closeShellTab?.('w9:tOLD', '/Users/u/Projects/demo')).resolves.toBe(true);
    expect(launchClient.closedTabs).toEqual(['w9:tOLD']);
    expect(s.audit.filter((ev) => ev.method === 'close_tab').map((ev) => ev.tabId)).toEqual(['w9:tOLD']);
  });

  it('closeShellTab zostawia tab z dwoma panelami i tab, w którym stoi agent', async () => {
    const launchClient = new FakeLaunchClient();
    const s = await setup(parseAgentList({ agents: rawAgents }), { launchClient });
    const tabOfAgent = s.supervisor.agentFor?.('w9:p72')?.tabId ?? '';
    launchClient.panes = [
      { paneId: 'w9:pA', tabId: 'w9:tSPLIT', workspaceId: 'w9', cwd: '/x', tokens: {}, label: null },
      { paneId: 'w9:pB', tabId: 'w9:tSPLIT', workspaceId: 'w9', cwd: '/x', tokens: {}, label: null },
      { paneId: 'w9:p72', tabId: tabOfAgent, workspaceId: 'w9', cwd: '/x', tokens: {}, label: null },
    ];
    await expect(s.supervisor.closeShellTab?.('w9:tSPLIT', '/x')).resolves.toBe(false);
    await expect(s.supervisor.closeShellTab?.(tabOfAgent, '/x')).resolves.toBe(false);
    await expect(s.supervisor.closeShellTab?.('', '/x')).resolves.toBe(false);
    expect(launchClient.closedTabs).toEqual([]);
  });

  it('closeShellTab zostawia tab z panelem, którego herdr nie odtworzył (`restore_error`)', async () => {
    const launchClient = new FakeLaunchClient();
    const s = await setup(parseAgentList({ agents: rawAgents }), { launchClient });
    launchClient.panes = [{
      paneId: 'w9:pOLD', tabId: 'w9:tOLD', workspaceId: 'w9', cwd: '/x', tokens: {}, label: null,
    }];
    launchClient.foreground = [{ pid: 80832, name: 'zsh', argv0: 'zsh' }];
    // `pane.list` po filtrze widzi jedną gołą powłokę, ale w tabie stoi jeszcze martwy panel.
    launchClient.hiddenPanes = [{ paneId: 'w9:pDEAD', tabId: 'w9:tOLD' }];
    await expect(s.supervisor.closeShellTab?.('w9:tOLD', '/x')).resolves.toBe(false);
    // Błąd `tab.get` to „nie wiem" — tab też zostaje.
    launchClient.hiddenPanes = [];
    launchClient.getTabFails = 1;
    await expect(s.supervisor.closeShellTab?.('w9:tOLD', '/x')).resolves.toBe(false);
    expect(launchClient.closedTabs).toEqual([]);
  });

  it('closeShellTab zostawia tab, w którym po `/exit` ruszył inny program', async () => {
    const launchClient = new FakeLaunchClient();
    const s = await setup(parseAgentList({ agents: rawAgents }), { launchClient });
    launchClient.panes = [{
      paneId: 'w9:pOLD', tabId: 'w9:tOLD', workspaceId: 'w9', cwd: '/x', tokens: {}, label: null,
    }];
    // `claude; nvim plik` — po wyjściu z CLI na pierwszym planie stoi edytor.
    launchClient.foreground = [{ pid: 81437, name: 'nvim', argv0: 'nvim' }];
    await expect(s.supervisor.closeShellTab?.('w9:tOLD', '/x')).resolves.toBe(false);
    // Brak odczytu procesów to „nie wiem" — tab też zostaje.
    launchClient.foreground = [];
    await expect(s.supervisor.closeShellTab?.('w9:tOLD', '/x')).resolves.toBe(false);
    expect(launchClient.closedTabs).toEqual([]);
  });

  it('launchAvailable: prawo zakładania BEZ sufitu paneli', async () => {
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const withLauncher = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    expect(withLauncher.supervisor.launchAvailable?.()).toBe(true);
    const without = await setup(parseAgentList({ agents: rawAgents }));
    expect(without.supervisor.launchAvailable?.()).toBe(false);
  });

  it('logRestart: jeden wpis `restart` z powodem, para wydań tylko przy aktualizacji', async () => {
    const s = await setup(parseAgentList({ agents: rawAgents }));
    s.supervisor.logRestart?.('w9:p72', 'cli-update', '2.1.280 → 2.1.283');
    s.supervisor.logRestart?.('nie-ma', 'cli-update', '2.1.280 → 2.1.283');
    // Restart po blokadzie promptu bez aktualizacji: sam powód, bez pary wydań.
    s.supervisor.logRestart?.('w9:p72', 'prompt-blocked');
    const restarts = s.audit.filter((ev) => ev.method === 'restart');
    expect(restarts.map((ev) => [ev.reason, ev.text])).toEqual([
      ['cli-update', '2.1.280 → 2.1.283'],
      ['prompt-blocked', undefined],
    ]);
    expect('text' in (restarts[1] ?? {})).toBe(false);
  });

  it('logCommandRefusal zapisuje `refuse` z `command-not-allowed` i samą nazwą komendy', async () => {
    const s = await setup(parseAgentList({ agents: rawAgents }));
    s.supervisor.logCommandRefusal?.('w9:p72', '/inny', '/usa');
    s.supervisor.logCommandRefusal?.(null, '/Users/u/Projects/demo', 'quit');
    const refusals = s.audit.filter((ev) => ev.method === 'refuse');
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatchObject({
      key: 'w9:p72', paneId: 'w9:p72', reason: 'command-not-allowed', command: '/usa',
    });
    expect(refusals[0]?.cwd).not.toBe('/inny');
    // Prompt startowy: panelu jeszcze nie ma, więc wpis niesie sam katalog.
    expect(refusals[1]).toMatchObject({
      key: '', paneId: '', cwd: '/Users/u/Projects/demo', mode: 'unknown', command: 'quit',
    });
    expect(refusals[1]?.sessionId).toBeUndefined();
  });

  it('closeTab na WŁASNYM panelu zamyka dokładnie jeden tab', async () => {
    const launchClient = new FakeLaunchClient();
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const s = await setup(parseAgentList({ agents: rawAgents }), {
      launcher: launch.launcher, launchClient,
    });
    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });

    await s.supervisor.closeTab(handle.key);

    expect(launchClient.closedTabs).toEqual([`${NEW_PANE}:tab`]);
    // Karta znika od razu — spóźnione `pane.closed` trafi w pustkę.
    expect(s.lifecycle.some((ev) => ev.type === 'gone' && ev.key === NEW_PANE)).toBe(true);
  });

  it('nazwa agenta `rarog-<6 hex>` z agent.list ustawia własność po restarcie RAROGA',
    async () => {
      // Pełna droga od surowej odpowiedzi herdr: filtr wejściowy czyta `name`, nadzorca liczy
      // z tego chip i sufit. Token `rarog` nie istnieje — po restarcie Raroga mówi tylko nazwa.
      const named = parseAgentList({
        agents: rawAgents.map((raw, i) => (i === 0 ? { ...raw, name: 'rarog-abc123' } : raw)),
      });
      const s = await setup(named, { launchClient: new FakeLaunchClient() });

      const first = s.lifecycle.find((ev) => ev.type === 'appeared');
      expect(first?.type === 'appeared' && first.agent.launchedByRarog).toBe(true);
      expect(s.supervisor.rarogPaneCount()).toBe(1);
    });

  it('sufit paneli liczy po NAZWIE agenta, a ręczne panele się nie liczą', async () => {
    const named = parseAgentList({
      agents: rawAgents.map((raw, i) => (i < 2 ? { ...raw, name: `rarog-00000${String(i)}` } : raw)),
    });
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const s = await setup(named, { launcher: launch.launcher, maxPanes: 2 });

    expect(s.supervisor.rarogPaneCount()).toBe(2);
    expect(s.supervisor.status().canLaunch).toBe(false);
    expect(s.supervisor.status().detail).toBe(HERDR_PANE_CAP_MESSAGE.text);
    // Kod zdania sufitu jedzie od nadzorcy obok tekstu, a nie z dopasowania tekstu w managerze.
    expect(s.supervisor.status().detailRef).toEqual({ code: 'herdr.pane-cap' });
  });

  it('powrót herdr NIE stempluje niczego — bez re-stempla tokenu `rarog`', async () => {
    /*
     * Nadzorca po powrocie gniazda nie wysyła `pane.report_metadata`. Własność mówi nazwa agenta
     * i RAM tego procesu, pochodzenie — etykieta panelu w snapshotcie herdr, więc po restarcie
     * herdr nie ma czego odtwarzać i nadzorca nie pisze do herdr ani jednej ramki.
     */
    const launchClient = new FakeLaunchClient();
    const named = parseAgentList({
      agents: rawAgents.map((raw, i) => (i === 0 ? { ...raw, name: 'rarog-abc123' } : raw)),
    });
    const s = await setup(named, { launchClient });

    s.client.listFails = 'socket padł';
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    expect(s.lifecycle.some((ev) => ev.type === 'unavailable')).toBe(true);
    s.client.listFails = null;
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(launchClient.stamped).toEqual([]);
    expect(launchClient.renamed).toEqual([]);
    // Własność wróciła z samej listy — nazwa agenta jest w `agent.list`, nie w metadanych.
    expect(s.supervisor.rarogPaneCount()).toBe(1);
  });

  /*
   * Własność NIE przechodzi na kolejny proces w tym samym panelu. `freshKey` oddaje
   * agentowi, który wstał w panelu po zniknięciu poprzednika, TEN SAM klucz — więc klucz
   * zostawiony w `launchedKeys` dałby chip i miejsce w suficie ręcznemu `claude` po `/exit`.
   */
  it('agent Raroga wychodzi, ręczny `claude` w tym samym panelu NIE jest Raroga', async () => {
    const MANUAL_SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    s.supervisor.attach(handle.key);

    // Agent wstaje BEZ nazwy (rekord startu wygasł, herdr wykrył go sam):
    // własność trzyma wtedy wyłącznie RAM tego procesu.
    s.client.agents = [...s.client.agents, agentAt(0, {
      paneId: NEW_PANE, agentSessionId: NEW_SESSION, tabId: `${NEW_PANE}:tab`,
    })];
    resyncTick(s);
    await flush();
    expect(s.supervisor.agentFor?.(NEW_PANE)?.launchedByRarog).toBe(true);
    expect(s.supervisor.rarogPaneCount()).toBe(1);

    // `/exit` — agent znika z listy, wpis odchodzi.
    s.client.agents = s.client.agents.filter((info) => info.paneId !== NEW_PANE);
    resyncTick(s);
    await flush();
    expect(s.lifecycle.some((ev) => ev.type === 'gone' && ev.key === NEW_PANE)).toBe(true);

    // Ręczny `claude` w TEJ SAMEJ powłoce: nowa sesja, bez nazwy, ten sam klucz z `freshKey`.
    s.client.agents = [...s.client.agents, agentAt(0, {
      paneId: NEW_PANE, agentSessionId: MANUAL_SESSION, tabId: `${NEW_PANE}:tab`,
    })];
    resyncTick(s);
    await flush();
    const reborn = s.lifecycle
      .filter((ev) => ev.type === 'appeared' && ev.agent.key === NEW_PANE).at(-1);
    expect(reborn?.type === 'appeared' && reborn.agent.launchedByRarog).toBe(false);
    expect(s.supervisor.rarogPaneCount()).toBe(0);
  });

  /*
   * `/exit` i ręczny `claude` w tym samym panelu BEZ pustej
   * migawki pomiędzy (szybka ręka albo zdarzenia zgubione przy zerwanym strumieniu) wpadały
   * w gałąź „znany panel, nowy uuid = `/clear`" i następca dziedziczył klucz z `launchedKeys`.
   * Sygnałem zastąpienia procesu jest ZNIKNIĘCIE nazwy `rarog-*` — `/clear` i `/resume` w tym
   * samym procesie ją zachowują.
   */
  describe('zastąpienie agenta Raroga w panelu bez pustej migawki', () => {
    const NEXT_SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    async function launchedAndSeen(name: string | null): Promise<Setup> {
      const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
      const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
      const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
      s.supervisor.attach(handle.key);
      s.client.agents = [...s.client.agents, namedAgentAt(0, name, {
        paneId: NEW_PANE, agentSessionId: NEW_SESSION, tabId: `${NEW_PANE}:tab`,
      })];
      resyncTick(s);
      await flush();
      expect(s.supervisor.agentFor?.(NEW_PANE)?.launchedByRarog).toBe(true);
      expect(s.supervisor.rarogPaneCount()).toBe(1);
      return s;
    }

    function replaceInPane(s: Setup, name: string | null): void {
      s.client.agents = s.client.agents.map((info) => (info.paneId === NEW_PANE
        ? namedAgentAt(0, name, {
          paneId: NEW_PANE, agentSessionId: NEXT_SESSION, tabId: `${NEW_PANE}:tab`,
        })
        : info));
    }

    it('agent z nazwą Raroga → ręczny `claude` bez nazwy, nowy uuid: własność gaśnie', async () => {
      const s = await launchedAndSeen('rarog-abc123');
      replaceInPane(s, null);
      resyncTick(s);
      await flush();

      // Ten sam klucz (gałąź `/clear`), więc karta trwa — ale nie jest już „Raroga".
      expect(s.supervisor.agentFor?.(NEW_PANE)).toMatchObject({
        agentSessionId: NEXT_SESSION, launchedByRarog: false,
      });
      expect(s.supervisor.rarogPaneCount()).toBe(0);
    });

    it('to samo przez push (`agent.get`), nie tylko przez pełny resync', async () => {
      const s = await launchedAndSeen('rarog-abc123');
      replaceInPane(s, null);
      s.transport.emit({
        type: 'event', kind: 'pane_agent_status_changed', data: { pane_id: NEW_PANE },
      });
      await flush();

      expect(s.supervisor.agentFor?.(NEW_PANE)?.launchedByRarog).toBe(false);
      expect(s.supervisor.rarogPaneCount()).toBe(0);
    });

    it('`/clear` (nowy uuid, ta sama nazwa) zostawia własność', async () => {
      const s = await launchedAndSeen('rarog-abc123');
      replaceInPane(s, 'rarog-abc123');
      resyncTick(s);
      await flush();

      expect(s.supervisor.agentFor?.(NEW_PANE)).toMatchObject({
        agentSessionId: NEXT_SESSION, launchedByRarog: true,
      });
      expect(s.supervisor.rarogPaneCount()).toBe(1);
    });

    it('agent Raroga BEZ nazwy od początku zostaje Raroga po `/clear` (znana granica)', async () => {
      /*
       * Rekord startu wygasł, herdr wykrył agenta sam — nazwy nie było nigdy, własność trzyma
       * RAM. `/clear` w tym procesie i zastąpienie procesu wyglądają wtedy identycznie (nowy uuid,
       * brak nazwy), a bez PID nie da się ich rozróżnić; wybieramy „zostaje", bo pomyłka kosztuje
       * chip i miejsce w suficie, zero władzy. Ten test pilnuje, że ta granica jest świadoma.
       */
      const s = await launchedAndSeen(null);
      replaceInPane(s, null);
      resyncTick(s);
      await flush();

      expect(s.supervisor.agentFor?.(NEW_PANE)?.launchedByRarog).toBe(true);
      expect(s.supervisor.rarogPaneCount()).toBe(1);
    });
  });

  it('Codex odpalony w panelu po Claude z Raroga NIE dziedziczy własności', async () => {
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
    const s = await setup(parseAgentList({ agents: rawAgents }), { launcher: launch.launcher });
    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    s.supervisor.attach(handle.key);
    s.client.agents = [...s.client.agents, agentAt(0, {
      paneId: NEW_PANE, agentSessionId: NEW_SESSION, tabId: `${NEW_PANE}:tab`,
    })];
    resyncTick(s);
    await flush();
    expect(s.supervisor.rarogPaneCount()).toBe(1);

    // W JEDNEJ migawce: Claude wyszedł, w tym samym panelu stoi Codex (gałąź zmiany silnika).
    s.client.agents = s.client.agents.map((info) => (info.paneId === NEW_PANE
      ? codexAt(0, { paneId: NEW_PANE, tabId: `${NEW_PANE}:tab` })
      : info));
    resyncTick(s);
    await flush();
    expect(s.supervisor.agentFor?.(NEW_PANE)).toMatchObject({ engine: 'codex', launchedByRarog: false });
    expect(s.supervisor.rarogPaneCount()).toBe(0);
  });

  it('canLaunch: bez launchera `false`, z launcherem `true`, przy suficie znowu `false`',
    async () => {
      const bez = await setup();
      expect(bez.supervisor.status().canLaunch).toBe(false);
      bez.supervisor.dispose();

      const launch = fakeLauncher(NEW_PANE, NEW_SESSION);
      const s = await setup(parseAgentList({ agents: rawAgents }), {
        launcher: launch.launcher, maxPanes: 1,
      });
      expect(s.supervisor.status().canLaunch).toBe(true);

      await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
      // Sufit liczy panele RAROGA, a nie wszystkie 17 — po pierwszym własnym gaśnie.
      expect(s.supervisor.rarogPaneCount()).toBe(1);
      expect(s.supervisor.status().canLaunch).toBe(false);
    });

  it('liveEngineSessions robi ŚWIEŻY odczyt, a nie migawkę z RAM', async () => {
    const s = await setup();
    const before = s.client.calls.list;

    const live = await s.supervisor.liveEngineSessions();

    expect(s.client.calls.list).toBe(before + 1);
    expect(live.has('e3759b2c-2275-565c-8f49-4e2707bb0231')).toBe(true);
  });

  it('ensureFreshMode: świeży odczyt jest cache’owany, nieświeży wymusza nowy', async () => {
    const s = await setup();
    const readsAfterStart = s.client.calls.read;

    // Tryb potwierdzony przy odkryciu panelu — drugi odczyt byłby czystym kosztem.
    expect(await s.supervisor.ensureFreshMode('w9:p72')).toBe('auto');
    expect(s.client.calls.read).toBe(readsAfterStart);

    // Po `HERDR_MODE_FRESH_MS` odczyt jest nieświeży: `shift+tab` przy biurku między turami
    // nie zostawia śladu w jsonl, więc stopkę trzeba przeczytać jeszcze raz.
    s.clock.value += HERDR_MODE_FRESH_MS + 1;
    expect(await s.supervisor.ensureFreshMode('w9:p72')).toBe('auto');
    expect(s.client.calls.read).toBe(readsAfterStart + 1);
  });

  it('nieczytelna stopka daje `unknown` — a manager traktuje to jak `bypass`', async () => {
    const s = await setup();
    s.clock.value += HERDR_MODE_FRESH_MS + 1;
    // Pełnoekranowy dialog albo nakładka `/status`: stopki po prostu nie widać.
    s.client.screen = 'jakiś ekran bez stopki trybu';

    expect(await s.supervisor.ensureFreshMode('w9:p72')).toBe('unknown');
  });

  it('odmowa „nie znam trybu" zostawia zrzut ekranu; odczyt ze stopką nie zrzuca', async () => {
    // Dialog CLI przy `--resume` zasłania stopkę; bez zrzutu nie zostaje po nim ślad.
    const dumps: RefusalDump[] = [];
    const s = await setup(undefined, { dumpRefusal: (dump) => { dumps.push(dump); } });
    s.clock.value += HERDR_MODE_FRESH_MS + 1;
    expect(await s.supervisor.ensureFreshMode('w9:p72')).toBe('auto');
    expect(dumps).toEqual([]);

    s.clock.value += HERDR_MODE_FRESH_MS + 1;
    s.client.screen = 'pytanie CLI bez stopki trybu';
    // Odczyty INNE niż na żądanie (tik resyncu, wymuszony odczyt pętli trybu) widzą ten sam ekran
    // bez stopki i nie zrzucają nic: nakładka to stan normalny, odmowa człowiekowi — nie.
    s.supervisor.attach('w9:p72');
    resyncTick(s);
    await Promise.resolve();
    expect(await s.drivers[0]!.ctx.refreshMode()).toBe('unknown');
    expect(dumps).toEqual([]);

    expect(await s.supervisor.ensureFreshMode('w9:p72')).toBe('unknown');
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toMatchObject({ reason: 'mode-unknown', screen: 'pytanie CLI bez stopki trybu' });
  });
});

/*
 * Resync agentów bez strażnika pokolenia, z bramką `blocked && !seenInList` w `forget`, tworzyłby
 * wpis nie do zdjęcia. Trzy regresje niżej pilnują trzech reguł: strażnik pokolenia, zapalenie
 * `seenInList` przy odkryciu, sprzątanie sierot dowodem z `pane.list`.
 */
describe('strażnik pokolenia resyncu agentów', () => {
  it('spóźniona STARSZA migawka `agent.list` nie ogłasza `gone` świeżo odkrytemu panelowi', async () => {
    const s = await setup([agentAt(0)]);
    const pending: ((infos: HerdrAgentInfo[]) => void)[] = [];
    s.client.listAgents = () => new Promise<HerdrAgentInfo[]>((resolve) => {
      pending.push(resolve);
    });

    // Resync A rusza z ticka i wisi na odpowiedzi — jego migawka będzie STARA.
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    // Zdarzenie kompozycji zbroi debounce → resync B, drugie `agent.list` w locie.
    s.transport.emit({ type: 'event', kind: 'pane_created', data: { type: 'pane_created' } });
    await flush();
    s.scheduler.advance(RESUBSCRIBE_DEBOUNCE_MS);
    await flush();
    expect(pending).toHaveLength(2);

    // B (świeższa migawka, zna drugi panel) wraca PIERWSZY i odkrywa nowego agenta…
    pending[1]!([agentAt(0), agentAt(1)]);
    await flush();
    const fresh = agentAt(1);
    expect(s.lifecycle.some(
      (ev) => ev.type === 'appeared' && ev.agent.paneId === fresh.paneId,
    )).toBe(true);

    // …a A (stara migawka, bez niego) DRUGI. Bez strażnika: `forget` → `gone` żywej sesji.
    pending[0]!([agentAt(0)]);
    await flush();
    expect(s.lifecycle.filter((ev) => ev.type === 'gone')).toHaveLength(0);
  });

  it('agent odkryty z listy w `blocked` daje się zdjąć, gdy z niej zniknie', async () => {
    // Przed naprawą gałąź „nowy agent" w `applyInfo` wracała PRZED zapaleniem `seenInList`,
    // więc taki wpis wpadał pod bramkę `blocked && !seenInList` i żył do restartu Raroga.
    const s = await setup([agentAt(0, { status: 'blocked' })]);
    s.client.agents = [];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    expect(s.lifecycle.some((ev) => ev.type === 'gone')).toBe(true);
  });

  it('wpis `blocked` spoza `agent.list` znika, gdy świeży `pane.list` nie zna PANELU', async () => {
    const NEW_PANE = 'w9:pNOWY';
    const NEW_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const launch = fakeLauncher(NEW_PANE, NEW_SESSION, {
      status: 'blocked', interactiveReady: false,
    });
    const launchClient = new FakeLaunchClient();
    const s = await setup(parseAgentList({ agents: rawAgents }), {
      launcher: launch.launcher, launchClient,
    });
    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    s.supervisor.attach(handle.key);
    launch.settle();
    await handle.ready;
    await flush();

    // Dopóki panel ISTNIEJE w `pane.list`, dialog może stać godzinami — wpis zostaje.
    launchClient.panes = [{
      paneId: NEW_PANE, tabId: `${NEW_PANE}:tab`, workspaceId: 'w9',
      cwd: '/Users/u/Projects/demo', tokens: {}, label: null,
    }];
    s.scheduler.advance(LAUNCH_ADOPT_TIMEOUT_MS + HERDR_TRUST_REEXEC_GRACE_MS);
    await flush();
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    expect(s.lifecycle.some((ev) => ev.type === 'gone' && ev.key === handle.key)).toBe(false);

    /*
     * Wiersz ZUBOŻONY (obecny w herdr, ale odfiltrowany przez normalizację — brak `cwd`
     * albo `tab_id` po minorze herdr) to wciąż ISTNIEJĄCY panel: inwentarz obecności
     * (`listPaneIds`) go zna, więc sweep NIE zdejmuje wpisu.
     */
    launchClient.panes = [];
    launchClient.extraPaneIds = [NEW_PANE];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    expect(s.lifecycle.some((ev) => ev.type === 'gone' && ev.key === handle.key)).toBe(false);

    // Tab zamknięty RĘCZNIE w herdr: znika z inwentarza → wpis ma zniknąć z map,
    // a nie liczyć się do sufitu paneli i jechać martwym `pane_id` w subskrypcjach.
    launchClient.extraPaneIds = [];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    expect(s.lifecycle.some((ev) => ev.type === 'gone' && ev.key === handle.key)).toBe(true);
  });

  it('`cd` poza RAROG_HERDR_ROOTS wymusza reattach — zakres karty nie zostaje z chwili podpięcia', async () => {
    // Driver kopiuje `inScope` przy podpięciu (follower transkryptu powstaje albo nie),
    // więc sama zmiana pola w RAM nie odbierała panelowi ani transkryptu, ani wysyłki.
    const s = await setup([agentAt(0)]);
    s.supervisor.attach(agentAt(0).paneId);
    await flush();

    s.client.agents = [agentAt(0, { cwd: '/tmp/poza-korzeniami' })];
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    const reattached = s.lifecycle.find((ev) => ev.type === 're-attached');
    expect(reattached?.type === 're-attached' && reattached.agent.inScope).toBe(false);
  });
});

describe('ping — sonda /health', () => {
  it('żywe gniazdo → true, awaria transportu → false (nigdy rzut)', async () => {
    const s = await setup();
    await expect(s.supervisor.ping()).resolves.toBe(true);
    s.client.pingFails = 'gniazdo padło';
    await expect(s.supervisor.ping()).resolves.toBe(false);
  });

  it('po dispose → false bez pytania gniazda', async () => {
    const s = await setup();
    s.supervisor.dispose();
    await expect(s.supervisor.ping()).resolves.toBe(false);
  });
});

describe('źródła odczytu ekranu — punkt 11 `security-model.md`', () => {
  /*
   * Reguła jest o ŹRÓDLE, nie o treści: z `--source visible` wolno wyprowadzić wyłącznie
   * rozpoznany TRYB ze stopki, bo widoczny ekran potrafi nieść treść `.env` albo klucz
   * w komendzie. Wycinek, który gdziekolwiek się ZAPISUJE — transkrypt, `stateDetail` sesji,
   * treść błędu jadąca po SSE — musi pochodzić z `--source detection`.
   *
   * Gdyby supervisor podawał launcherowi `visible`, launcher wkleiłby ogon tego ekranu
   * w komunikat timeoutu startu, czyli w `stateDetail`. Fakt bierze się z KODU, bo wiring
   * (supervisor → launcher) nie ma innej drogi do sprawdzenia niż źródło: jedyne `visible`
   * w tym module ma stać w `readMode`.
   */
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/herdr/supervisor.ts'),
    'utf8',
  );

  it('jedyne `visible` w supervisorze czyta STOPKĘ TRYBU, reszta idzie przez `detection`', () => {
    const visible = [...source.matchAll(/readScreen\([^)]*'visible'\)/g)].map((m) => m[0]);
    expect(visible, 'nowy odczyt `visible` — sprawdź, czy jego tekst gdziekolwiek się zapisuje')
      .toEqual(["readScreen(entry.agent.paneId, 'visible')"]);
    // A ogon ekranu podawany launcherowi (timeout startu, `goneReason`) — z `detection`.
    expect(source).toMatch(/readScreen\(paneId, 'detection'\)/);
  });
});

// ---------------------------------------------------------------------------
// Etykieta taba = etykieta karty
// ---------------------------------------------------------------------------

describe('etykieta taba w herdr idzie za etykietą karty', () => {
  /** Etykieta taba nadana przez Raroga wcześniej — jej ślad stoi w etykiecie panelu. */
  const OLD = 'stara etykieta';
  /** Klucz projektu z etykiety panelu — nadzorca go PRZEPISUJE, nie liczy na nowo. */
  const KEY16 = 'feedfacefeedface';

  interface TabSetup {
    s: Setup;
    launchClient: FakeLaunchClient;
    agent: HerdrAgentInfo;
    key: string;
  }

  /** Agent (domyślnie z nazwą Raroga) w tabie jednopanelowym; panel z etykietą `rarog-claude`. */
  async function withTab(opts: {
    agent?: HerdrAgentInfo;
    paneLabel?: string | null;
    tabLabel?: string;
    extraPaneInTab?: boolean;
    tabLabels?: boolean;
  } = {}): Promise<TabSetup> {
    const agent = opts.agent ?? namedAgentAt(0, 'rarog-abc123');
    const launchClient = new FakeLaunchClient();
    const pane: HerdrPaneInfo = {
      paneId: agent.paneId, tabId: agent.tabId, workspaceId: 'w9', cwd: agent.cwd, tokens: {},
      label: opts.paneLabel === undefined ? claudePaneLabel(KEY16, labelTrace(OLD)) : opts.paneLabel,
    };
    launchClient.panes = [pane];
    if (opts.extraPaneInTab === true) {
      launchClient.panes.push({ ...pane, paneId: 'w9:pOBOK', label: null });
    }
    launchClient.tabs.set(agent.tabId, opts.tabLabel ?? OLD);
    const s = await setup([agent], {
      launchClient, ...(opts.tabLabels === undefined ? {} : { tabLabels: opts.tabLabels }),
    });
    return { s, launchClient, agent, key: agent.paneId };
  }

  /**
   * Debounce mija i przebieg dobiega końca. Kilka obrotów z `setTimeout`, nie samo `setImmediate`:
   * migracja liczy klucz projektu przez `realpath`, a to I/O z puli wątków libuv.
   */
  async function fire(s: Setup): Promise<void> {
    s.scheduler.advance(TAB_LABEL_DEBOUNCE_MS);
    for (let i = 0; i < 10; i += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
    }
  }

  const tabRenames = (client: FakeLaunchClient): (string | null)[] => client.renamed
    .filter((call) => call.kind === 'tab').map((call) => call.label);

  it('zmiana etykiety karty → jedno `tab.rename` i jedno `pane.rename` z nowym śladem', async () => {
    const { s, launchClient, agent, key } = await withTab();

    s.supervisor.syncTabLabel?.(key, 'napraw zapis notatek');
    await fire(s);

    expect(launchClient.renamed).toEqual([
      { kind: 'tab', id: agent.tabId, label: 'napraw zapis notatek' },
      // Klucz projektu przepisany z etykiety panelu, ślad — z NOWEJ etykiety taba.
      {
        kind: 'pane', id: agent.paneId,
        label: claudePaneLabel(KEY16, labelTrace('napraw zapis notatek'), 'napraw zapis notatek'),
      },
    ]);
    expect(launchClient.tabs.get(agent.tabId)).toBe('napraw zapis notatek');
  });

  /*
   * Nazwa z `/rename` przychodzi do managera z pliku rozmowy, a tab dostaje ją tą
   * samą drogą co każdą etykietę karty, bez czekania na tytuł panelu w herdr.
   */
  it('nazwa z `/rename` na tabie po debounce, choć tytuł panelu w herdr jeszcze stary', async () => {
    const { s, launchClient, agent, key } = await withTab({ agent: namedAgentAt(0, 'rarog-abc123', { title: 'Claude Code' }) });

    s.supervisor.syncTabLabel?.(key, 'demo-eksport');
    await fire(s);

    expect(tabRenames(launchClient)).toEqual(['demo-eksport']);
    expect(launchClient.tabs.get(agent.tabId)).toBe('demo-eksport');
  });

  it('dwie nazwy w oknie debounce → tab dostaje ostatnią', async () => {
    const { s, launchClient, key } = await withTab();

    s.supervisor.syncTabLabel?.(key, 'demo-eksport');
    s.supervisor.syncTabLabel?.(key, 'demo-eksport-csv');
    await fire(s);

    expect(tabRenames(launchClient)).toEqual(['demo-eksport-csv']);
  });

  it('seria zmian w oknie debounce → jedno nazwanie, OSTATNIĄ etykietą', async () => {
    const { s, launchClient, key } = await withTab();

    s.supervisor.syncTabLabel?.(key, 'pierwsza');
    s.scheduler.advance(TAB_LABEL_DEBOUNCE_MS / 2);
    s.supervisor.syncTabLabel?.(key, 'druga');
    s.scheduler.advance(TAB_LABEL_DEBOUNCE_MS / 2);
    s.supervisor.syncTabLabel?.(key, 'trzecia');
    await fire(s);

    expect(tabRenames(launchClient)).toEqual(['trzecia']);
    expect(launchClient.tabReads).toBe(1);
  });

  it('10 resynców i 10 synchronizacji z tą samą etykietą po nazwaniu → zero wywołań', async () => {
    const { s, launchClient, key } = await withTab();
    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);
    const mutations = launchClient.renamed.length;
    const reads = launchClient.tabReads;
    const lists = launchClient.listPanesCalls;

    for (let i = 0; i < 10; i += 1) {
      resyncTick(s);
      s.supervisor.syncTabLabel?.(key, 'nowa');
      await fire(s);
    }

    expect(launchClient.renamed).toHaveLength(mutations);
    expect(launchClient.tabReads).toBe(reads);
    expect(launchClient.listPanesCalls).toBe(lists);
  });

  it('tab z DWOMA panelami (split) — etykieta zostaje', async () => {
    const { s, launchClient, key } = await withTab({ extraPaneInTab: true });

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
  });

  it('etykieta nadana ręcznie zostaje — a po kolejnej zmianie karty pytamy od nowa', async () => {
    const { s, launchClient, key } = await withTab({ tabLabel: 'moja nazwa' });

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);
    s.supervisor.syncTabLabel?.(key, 'jeszcze nowsza');
    await fire(s);
    expect(launchClient.renamed).toEqual([
      { kind: 'pane', id: key, label: claudePaneLabel(KEY16, labelTrace(OLD), 'moja nazwa') }]);
    // Bez „ręcznej na zawsze": każdy przebieg liczy prawo od nowa ze świeżego `tab.get`.
    expect(launchClient.tabReads).toBe(2);
    expect(s.logs.some((line) => line.includes('named by hand'))).toBe(true);
  });

  it('restart Raroga między zmianami — własna etykieta rozpoznana po ŚLADZIE w etykiecie panelu', async () => {
    const { s, launchClient, agent, key } = await withTab();
    s.supervisor.syncTabLabel?.(key, 'pierwsza');
    await fire(s);
    s.supervisor.dispose();

    // Nowy proces Raroga (i ewentualnie nowy herdr): zero RAM, etykiety taba i panelu przetrwały.
    const s2 = await setup([agent], { launchClient });
    s2.supervisor.syncTabLabel?.(key, 'druga');
    await fire(s2);

    expect(tabRenames(launchClient)).toEqual(['pierwsza', 'druga']);
  });

  it('panel z etykietą Claude i agent `rarog-<6 hex>` — nazwanie idzie, potwierdzenie po etykiecie panelu', async () => {
    const { s, launchClient, agent, key } = await withTab({
      agent: namedAgentAt(0, `${HERDR_NAME_PREFIX}-abc123`),
    });

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.renamed).toEqual([
      { kind: 'tab', id: agent.tabId, label: 'nowa' },
      { kind: 'pane', id: agent.paneId, label: claudePaneLabel(KEY16, labelTrace('nowa'), 'nowa') },
    ]);
  });

  it('panel z INNYM kluczem po odczycie taba → bez zapisu', async () => {
    const { s, launchClient, agent, key } = await withTab();
    launchClient.onGetTab = () => {
      const pane = launchClient.panes[0];
      if (pane !== undefined) pane.label = claudePaneLabel('cafebabecafebabe', labelTrace(OLD));
    };

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
    expect(s.logs.some((line) => line.includes(`pane ${agent.paneId} changed`))).toBe(true);
  });

  it('panel BEZ etykiety pochodzenia i agent bez nazwy Raroga → nic, nawet odczytu taba', async () => {
    const agent = namedAgentAt(0, null);
    const { s, launchClient, key } = await withTab({
      agent, paneLabel: null, tabLabel: basename(agent.cwd),
    });

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
    expect(launchClient.tabReads).toBe(0);
  });

  it('panel terminala Raroga (`rarog-term`) z `claude` w środku — jego tab nazywa terminal', async () => {
    const { s, launchClient, key } = await withTab({ paneLabel: termPaneLabel('0123456789abcdef') });

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
    expect(launchClient.tabReads).toBe(0);
  });

  it('Codex — nigdy, nawet z etykietą Claude na panelu', async () => {
    const { s, launchClient, key } = await withTab({ agent: codexAt(0) });

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
    expect(launchClient.listPanesCalls).toBe(0);
  });

  it('write channel closed (`RAROG_HERDR_SEND=0` at the socket) → zero calls, ONE log line', async () => {
    const { s, launchClient, key } = await withTab();
    s.transport.statusValue = { ...s.transport.statusValue, readOnly: true };

    for (const label of ['a', 'b', 'c']) {
      s.supervisor.syncTabLabel?.(key, label);
      await fire(s);
    }

    expect(launchClient.renamed).toEqual([]);
    expect(launchClient.listPanesCalls).toBe(0);
    expect(s.logs.filter((line) => line.includes('tab labels on hold'))).toHaveLength(1);
  });

  it('bramka gniazda odbija `tab.rename` — bez śladu na panelu, jedna linia na proces', async () => {
    const { s, launchClient, key } = await withTab();
    launchClient.tabRenameOutcome = 'read-only';

    s.supervisor.syncTabLabel?.(key, 'a');
    await fire(s);
    s.supervisor.syncTabLabel?.(key, 'b');
    await fire(s);

    expect(launchClient.renamed.filter((call) => call.kind === 'pane')).toEqual([]);
    expect(s.logs.filter((line) => line.includes('tab labels without write access'))).toHaveLength(1);
  });

  it('timeout `tab.rename`, który SIĘ WYKONAŁ → `tab.get` to widzi i dopisuje ślad', async () => {
    const { s, launchClient, agent, key } = await withTab();
    launchClient.tabRenameOutcome = 'timeout-applied';

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.tabReads).toBe(2);
    expect(launchClient.renamed).toEqual([
      { kind: 'tab', id: agent.tabId, label: 'nowa' },
      { kind: 'pane', id: agent.paneId, label: claudePaneLabel(KEY16, labelTrace('nowa'), 'nowa') },
    ]);
  });

  it('timeout `tab.rename` BEZ skutku → `tab.get` pokazuje starą etykietę, śladu nie ruszamy', async () => {
    const { s, launchClient, agent, key } = await withTab();
    launchClient.tabRenameOutcome = 'timeout';

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.tabReads).toBe(2);
    expect(launchClient.renamed).toEqual([{ kind: 'tab', id: agent.tabId, label: 'nowa' }]);
    expect(s.logs.some((line) => line.includes('failed to set the card label'))).toBe(true);
  });

  it('`pane.rename` ze śladem padł — następna zmiana karty dalej rozpoznaje własną etykietę', async () => {
    const { s, launchClient, agent, key } = await withTab();
    launchClient.paneRenameOutcome = 'error';
    s.supervisor.syncTabLabel?.(key, 'pierwsza');
    await fire(s);

    launchClient.paneRenameOutcome = 'ok';
    s.supervisor.syncTabLabel?.(key, 'druga');
    await fire(s);

    expect(tabRenames(launchClient)).toEqual(['pierwsza', 'druga']);
    expect(launchClient.panes[0]?.label).toBe(claudePaneLabel(KEY16, labelTrace('druga'), 'druga'));
    void agent;
  });

  it('tab ma już etykietę karty, ślad jest stary → dopisany ślad, raz', async () => {
    const { s, launchClient, agent, key } = await withTab({ tabLabel: 'nowa' });

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);
    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.renamed).toEqual([
      { kind: 'pane', id: agent.paneId, label: claudePaneLabel(KEY16, labelTrace('nowa'), 'nowa') },
    ]);
  });

  it('etykieta karty idzie na tab CAŁA — bez znaków sterujących, bez osobnego ucięcia', async () => {
    const { s, launchClient, key } = await withTab();

    // Nazwa katalogu jako fallback karty bywa dłuższa niż 28 znaków — karta pokazuje ją całą.
    s.supervisor.syncTabLabel?.(key, 'fjord-dashboard-settings-panel');
    await fire(s);
    s.supervisor.syncTabLabel?.(key, 'zły\u001b[31m\u2028tytuł');
    await fire(s);

    expect(tabRenames(launchClient)).toEqual(['fjord-dashboard-settings-panel', 'zły [31m tytuł']);
  });

  /*
   * Przebieg nie czyta adresów z ŻYWEGO wpisu, który `applyInfo`
   * przestawia przy przeniesieniu panelu. Pod starym adresem staje wtedy panel człowieka — zapis
   * tam przemianowałby jego tab i przykleił mu etykietę pochodzenia Raroga.
   */
  it('panel przeniesiony w trakcie `tab.get`, stary adres zajęty przez cudzy panel → zero zapisów na starym', async () => {
    const { s, launchClient, agent, key } = await withTab();
    let release: () => void = () => {};
    launchClient.getTabGate = new Promise<void>((resolve) => { release = resolve; });
    s.supervisor.syncTabLabel?.(key, 'nowa');
    s.scheduler.advance(TAB_LABEL_DEBOUNCE_MS);
    await flush();
    expect(launchClient.tabReads).toBe(1);

    // `pane move`: agent stoi teraz pod nowym adresem; pod starym — panel człowieka, tab z tą samą nazwą.
    s.client.agents = [{ ...agent, paneId: 'w9:pNOWY', tabId: 'w9:tNOWY' }];
    launchClient.panes = [
      { paneId: agent.paneId, tabId: agent.tabId, workspaceId: 'w9', cwd: agent.cwd, tokens: {}, label: null },
      {
        paneId: 'w9:pNOWY', tabId: 'w9:tNOWY', workspaceId: 'w9', cwd: agent.cwd, tokens: {},
        label: claudePaneLabel(KEY16, labelTrace(OLD)),
      },
    ];
    launchClient.tabs.set('w9:tNOWY', OLD);
    resyncTick(s);
    await flush();
    expect(s.supervisor.agentFor?.(key)?.paneId).toBe('w9:pNOWY');

    launchClient.getTabGate = null;
    release();
    await fire(s);
    await fire(s);

    expect(launchClient.renamed.filter((call) => call.id === agent.paneId || call.id === agent.tabId))
      .toEqual([]);
    // Zmiana adresu = nowy przebieg — już pod nowym adresem.
    expect(launchClient.renamed).toEqual([
      { kind: 'tab', id: 'w9:tNOWY', label: 'nowa' },
      { kind: 'pane', id: 'w9:pNOWY', label: claudePaneLabel(KEY16, labelTrace('nowa'), 'nowa') },
    ]);
  });

  it('etykieta panelu zmieniona między `tab.get` a zapisem → świeży odczyt to widzi, zero `tab.rename`', async () => {
    const { s, launchClient, key } = await withTab();
    launchClient.onGetTab = (): void => {
      launchClient.onGetTab = null;
      launchClient.panes = launchClient.panes.map((pane) => ({ ...pane, label: 'moja etykieta' }));
    };

    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
  });

  it('migracja: NIEPUSTA etykieta panelu spoza wzorców Raroga blokuje migrację', async () => {
    const agent = namedAgentAt(0, 'rarog-abc123');
    const { s, launchClient, key } = await withTab({
      agent, paneLabel: 'moja etykieta panelu', tabLabel: basename(agent.cwd),
    });

    s.supervisor.syncTabLabel?.(key, 'napraw zapis');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
  });

  /*
   * Sync pominięty przy chwilowej niedostępności herdr nie może zginąć —
   * po powrocie z tym samym tytułem manager nie woła `#setLabel` (tytuł == etykieta karty).
   */
  it('rozłączenie w oknie debounce → powrót z tym samym tytułem → resync → dokładnie jedno `tab.rename`', async () => {
    const { s, launchClient, key } = await withTab();
    s.supervisor.syncTabLabel?.(key, 'nowa');
    s.transport.emit({ type: 'disconnected', reason: foreign('EOF') });
    await flush();
    await fire(s);
    expect(launchClient.renamed).toEqual([]);

    s.transport.emit({ type: 'connected' });
    await flush();
    await fire(s);
    resyncTick(s);
    await flush();
    await fire(s);

    expect(tabRenames(launchClient)).toEqual(['nowa']);
  });

  it('chwilowy błąd odczytu → ponowienie po kolejnym resyncu; trwała odmowa bramki → bez pętli', async () => {
    const { s, launchClient, key } = await withTab();
    launchClient.getTabFails = 1;
    s.supervisor.syncTabLabel?.(key, 'nowa');
    await fire(s);
    expect(launchClient.renamed).toEqual([]);

    resyncTick(s);
    await flush();
    await fire(s);
    expect(tabRenames(launchClient)).toEqual(['nowa']);

    launchClient.tabRenameOutcome = 'read-only';
    s.supervisor.syncTabLabel?.(key, 'druga');
    await fire(s);
    for (let i = 0; i < 5; i += 1) {
      resyncTick(s);
      await flush();
      await fire(s);
    }
    expect(tabRenames(launchClient)).toEqual(['nowa', 'druga']);
  });

  it('zmiana etykiety w TRAKCIE przebiegu → przebiegi po kolei, na tabie zostaje OSTATNIA', async () => {
    const { s, launchClient, agent, key } = await withTab();
    let release: () => void = () => {};
    launchClient.getTabGate = new Promise<void>((resolve) => { release = resolve; });
    s.supervisor.syncTabLabel?.(key, 'pierwsza');
    s.scheduler.advance(TAB_LABEL_DEBOUNCE_MS);
    await flush();
    // Druga etykieta, gdy pierwszy przebieg czeka na `tab.get` — drugi przebieg NIE rusza równolegle.
    s.supervisor.syncTabLabel?.(key, 'druga');
    s.scheduler.advance(TAB_LABEL_DEBOUNCE_MS);
    await flush();
    expect(launchClient.tabReads).toBe(1);

    launchClient.getTabGate = null;
    release();
    await fire(s);
    await fire(s);

    expect(tabRenames(launchClient)).toEqual(['pierwsza', 'druga']);
    expect(launchClient.tabs.get(agent.tabId)).toBe('druga');
  });

  it('etykieta panelu nadana PO debounce (launcher wolniejszy) — sync czeka na `paneLabelled`', async () => {
    const NEW_PANE = 'w9:pNOWY';
    const NEW_TAB = 'w9:tNOWY';
    const NEW_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const launchClient = new FakeLaunchClient();
    const holder: { seam?: HerdrLauncherSeam } = {};
    const createLauncher = (seam: HerdrLauncherSeam): HerdrLauncher => {
      holder.seam = seam;
      return {
        launch: (req) => {
          const key = seam.registerLaunch({
            paneId: NEW_PANE, tabId: NEW_TAB, agentSessionId: NEW_SESSION, cwd: req.cwd, label: 'demo',
          });
          return Promise.resolve({
            key, paneId: NEW_PANE, tabId: NEW_TAB, agentSessionId: NEW_SESSION,
            ready: new Promise<never>(() => {}),
          });
        },
      };
    };
    const s = await setup(parseAgentList({ agents: rawAgents }), { createLauncher, launchClient });
    launchClient.panes = [{
      paneId: NEW_PANE, tabId: NEW_TAB, workspaceId: 'w9', cwd: '/Users/u/Projects/demo',
      tokens: {}, label: null,
    }];
    launchClient.tabs.set(NEW_TAB, 'demo');

    const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
    s.supervisor.syncTabLabel?.(handle.key, 'napraw zapis');
    await fire(s);
    // Launcher jeszcze nie skończył kroku 6 — bez dowodu pochodzenia nie ma czego sprawdzać.
    expect(launchClient.listPanesCalls).toBe(0);
    expect(launchClient.renamed).toEqual([]);

    // Krok 6 launchera: etykieta panelu, potem sygnał dla nadzorcy.
    launchClient.panes = launchClient.panes.map((pane) => (
      { ...pane, label: claudePaneLabel(KEY16, labelTrace('demo')) }
    ));
    holder.seam?.paneLabelled(handle.key);
    await fire(s);

    expect(tabRenames(launchClient)).toEqual(['napraw zapis']);
  });

  it('start rozstrzygnięty BEZ `paneLabelled` (porażka przed krokiem 6) — sync nie czeka w nieskończoność',
    async () => {
      const NEW_PANE = 'w9:pNOWY';
      const NEW_TAB = 'w9:tNOWY';
      const NEW_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const launchClient = new FakeLaunchClient();
      let fail: (err: Error) => void = () => {};
      const createLauncher = (seam: HerdrLauncherSeam): HerdrLauncher => ({
        launch: (req) => {
          const key = seam.registerLaunch({
            paneId: NEW_PANE, tabId: NEW_TAB, agentSessionId: NEW_SESSION, cwd: req.cwd, label: 'demo',
          });
          const ready = new Promise<never>((_resolve, reject) => { fail = reject; });
          return Promise.resolve({ key, paneId: NEW_PANE, tabId: NEW_TAB, agentSessionId: NEW_SESSION, ready });
        },
      });
      const s = await setup(parseAgentList({ agents: rawAgents }), { createLauncher, launchClient });
      launchClient.panes = [{
        paneId: NEW_PANE, tabId: NEW_TAB, workspaceId: 'w9', cwd: '/Users/u/Projects/demo',
        tokens: {}, label: claudePaneLabel(KEY16, labelTrace('demo')),
      }];
      launchClient.tabs.set(NEW_TAB, 'demo');
      const handle = await s.supervisor.launch({ cwd: '/Users/u/Projects/demo' });
      s.supervisor.syncTabLabel?.(handle.key, 'napraw zapis');
      await fire(s);
      expect(launchClient.listPanesCalls).toBe(0);

      fail(new Error('agent.start: nie wstał'));
      // Odrzucenie `ready` dociera do nadzorcy mikrozadaniem — dopiero wtedy rusza odliczanie.
      await flush();
      await fire(s);

      expect(tabRenames(launchClient)).toEqual(['napraw zapis']);
    });

  it('migracja starej konwencji: agent `rarog-*`, panel bez etykiety, tab z nazwą katalogu', async () => {
    const agent = namedAgentAt(0, 'rarog-abc123');
    const dir = basename(agent.cwd);
    const { s, launchClient, key } = await withTab({ agent, paneLabel: null, tabLabel: dir });

    s.supervisor.syncTabLabel?.(key, 'napraw zapis');
    await fire(s);

    const project = projectKey(await realProjectPath(agent.cwd));
    expect(launchClient.renamed).toEqual([
      // Najpierw pochodzenie ze śladem BIEŻĄCEJ etykiety taba — dalej zwykła ścieżka.
      { kind: 'pane', id: agent.paneId, label: claudePaneLabel(project, labelTrace(dir), dir) },
      { kind: 'tab', id: agent.tabId, label: 'napraw zapis' },
      { kind: 'pane', id: agent.paneId, label: claudePaneLabel(project, labelTrace('napraw zapis'), 'napraw zapis') },
    ]);
    expect(s.logs.some((line) => line.includes(`migration — pane ${agent.paneId}`))).toBe(true);
  });

  it('migracja obejmuje „1" z `workspace.create`', async () => {
    const { s, launchClient, key } = await withTab({ paneLabel: null, tabLabel: '1' });

    s.supervisor.syncTabLabel?.(key, 'napraw zapis');
    await fire(s);

    expect(tabRenames(launchClient)).toEqual(['napraw zapis']);
  });

  it('migracja: inna etykieta taba (mógł być nazwany ręcznie) → nietknięty, panel też', async () => {
    const { s, launchClient, key } = await withTab({ paneLabel: null, tabLabel: 'moja nazwa' });

    s.supervisor.syncTabLabel?.(key, 'napraw zapis');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
  });

  it('migracja: tab z dwoma panelami → nietknięty', async () => {
    const agent = namedAgentAt(0, 'rarog-abc123');
    const { s, launchClient, key } = await withTab({
      agent, paneLabel: null, tabLabel: basename(agent.cwd), extraPaneInTab: true,
    });

    s.supervisor.syncTabLabel?.(key, 'napraw zapis');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
  });

  it('`RAROG_HERDR_TAB_LABELS=0` — ani odczytu, ani zmiany, ani migracji', async () => {
    const { s, launchClient, key } = await withTab({ paneLabel: null, tabLabel: '1', tabLabels: false });

    s.supervisor.syncTabLabel?.(key, 'napraw zapis');
    await fire(s);

    expect(launchClient.renamed).toEqual([]);
    expect(launchClient.listPanesCalls).toBe(0);
  });

  it('agent zniknął przed końcem debounce — przebieg nie rusza niczego', async () => {
    const { s, launchClient, key } = await withTab();
    s.supervisor.syncTabLabel?.(key, 'nowa');
    // Panel zamknięty na Macu: push składu → resync po debounce subskrypcji → `forget`.
    s.client.agents = [];
    s.transport.emit({ type: 'event', kind: 'pane_closed', data: {} });
    await flush();
    s.scheduler.advance(RESUBSCRIBE_DEBOUNCE_MS);
    await flush();
    expect(s.lifecycle.some((ev) => ev.type === 'gone' && ev.key === key)).toBe(true);

    await fire(s);

    expect(launchClient.renamed).toEqual([]);
    expect(launchClient.listPanesCalls).toBe(0);
  });
});

describe('wersja herdr na ticku resyncu (sygnał nowej wersji)', () => {
  /*
   * `checkProtocol` gniazda jest zapamiętany i czyta `ping` od nowa dopiero po utracie gniazda, a `herdr update
   * --handoff` zmienia program pod tym samym gniazdem. Nadzorca pyta więc walidowanym `ping` na każdym ticku
   * resyncu i oddaje wersję obserwatorowi (`version-watch.ts`).
   */
  it('zmiana wersji herdr przy tym samym protokole i bez utraty gniazda: jeden push', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rarog-wersja-herdr-'));
    let watch: VersionWatch | undefined;
    try {
      writeFileSync(join(dir, VERSIONS_SEEN_FILENAME), JSON.stringify({ format: 1, versions: { herdr: '0.9.5' } }));
      const seen: string[] = [];
      const s = await setup(undefined, {
        onVersion: (version) => {
          seen.push(version);
          watch?.observe('herdr', version);
        },
      });
      s.client.pingVersion = '0.9.5';
      const subscriptions = s.transport.opened.length;
      const pushes: PushContent[] = [];
      const logs: string[] = [];
      const created = createVersionWatch({
        dataDir: dir,
        scheduler: s.scheduler,
        log: (line) => { logs.push(line); },
        send: (content) => {
          pushes.push(content);
          return Promise.resolve('delivered');
        },
      });
      watch = created;
      const tick = async (ms: number): Promise<void> => {
        s.scheduler.advance(ms);
        await flush(8);
        await created.idle();
      };
      // Pierwszy `ping` poszedł przy starcie, przed obserwatorem; tick z tą samą wersją niczego nie wysyła.
      expect(s.client.pings).toBe(1);
      await tick(HERDR_RESYNC_MS);
      await tick(VERSION_PUSH_SETTLE_MS);
      expect(pushes).toEqual([]);

      s.client.pingVersion = '0.9.6';
      await tick(HERDR_RESYNC_MS);
      await tick(VERSION_PUSH_SETTLE_MS);
      await tick(HERDR_RESYNC_MS);
      await tick(VERSION_PUSH_SETTLE_MS);

      expect(seen.at(-1)).toBe('0.9.6');
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ kind: 'version-changed', body: 'herdr 0.9.5 → 0.9.6' });
      expect(logs).toEqual(['versions: herdr 0.9.5 → 0.9.6 (push: delivered)']);
      // Gniazdo nie padło: żadnej nowej subskrypcji ani rozłączenia, protokół ten sam.
      expect(s.transport.opened).toHaveLength(subscriptions);
      expect(s.transport.opened.at(-1)?.closed).toBe(false);
      expect(s.supervisor.status()).toMatchObject({ available: true, protocol: 20 });
    } finally {
      watch?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('`ping` bez obserwatora nie idzie, a `ping`, który padł, nie przerywa ticku', async () => {
    const quiet = await setup();
    quiet.scheduler.advance(HERDR_RESYNC_MS);
    await flush(8);
    expect(quiet.client.pings).toBe(0);
    quiet.supervisor.dispose();

    const seen: string[] = [];
    const s = await setup(undefined, { onVersion: (version) => { seen.push(version); } });
    s.client.pingFails = 'gniazdo padło';
    const listed = s.client.calls.list;
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush(8);
    s.client.pingFails = null;
    s.client.pingVersion = '0.9.6';
    s.scheduler.advance(HERDR_RESYNC_MS);
    await flush(8);
    expect(s.client.calls.list).toBe(listed + 2);
    expect(seen).toEqual(['0.8.2', '0.9.6']);
  });
});
