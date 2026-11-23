/**
 * Shared fakes of the herdr driver tests: the fake client and pulse, the driver fixture with a real follower over
 * a temporary CLI store, clocks, transcript lines and the prompt field pane for sending while a turn runs.
 *
 * A test file calls {@link useDriverSandbox} once at the top level; it creates the store before each test and
 * disposes the drivers after it. Used by `herdr-driver.test.ts`, `prompt-queue.test.ts`, `turn-guard.test.ts`,
 * `form-reserve.test.ts` and `cli-reserve.test.ts`.
 */
import { afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriverEvent, SendOptions, SessionDriver } from '../../src/drivers/types.ts';
import type { HerdrAuditEntry, HerdrDriverDeps } from '../../src/drivers/herdr-driver.ts';
import { createHerdrDriver } from '../../src/drivers/herdr-driver.ts';
import { classifySlashText, slashOf } from '../../src/herdr/commands/shape.ts';
import { registryCatalog } from '../../src/herdr/commands/catalog.ts';
import type { CommandCatalog } from '../../src/herdr/commands/catalog.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrPaneEvent, HerdrPaneHistory, HerdrScreen,
} from '../../src/herdr/types.ts';
import { createAgentFileReader } from '../../src/herdr/background/agent-file.ts';
import { createJsonlFollower } from '../../src/herdr/jsonl-follow.ts';
import type { PulseSample, SessionPulse } from '../../src/herdr/session-pulse.ts';
import { createUploads } from '../../src/herdr/uploads.ts';
import { projectSlug } from '../../src/cli-store.ts';
import type { Scheduler } from '../../src/drivers/runtime.ts';

export const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
export const PANE = 'w9:p72';

/** Ekrany dialogów z fixture'ów repo — te same, na których testuje się parser opcji. */
export const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'herdr');
export const DIALOG_PERMISSION = readFileSync(join(FIXTURES, 'dialog-permission.txt'), 'utf8');

/*
 * Zegary followera w tym pliku (produkcja: 100 / 2000 / 500 / 60 000 / 5000 ms).
 *
 * Cały plik jest ZWIĄZANY jednym budżetem czasu: `quiet()` (15 ms) musi być DŁUŻSZE niż
 * `pendingDebounceMs` (10 ms) i niż `batchMs`, bo „poczekaj i sprawdź, że nic nie doszło"
 * ma sens tylko wtedy, gdy karencja drivera zdążyła minąć. Skracając jedną z tych liczb,
 * skróć pozostałe w tej samej proporcji — inaczej testy negatywne zaczną przechodzić
 * z niewłaściwego powodu.
 */
export const TIMING = { batchMs: 4, statTickMs: 3, missingFastMs: 3, missingWindowMs: 60, missingSlowMs: 6 };

export interface Call {
  method: 'prompt' | 'send_keys' | 'form_submit' | 'mode_cycle' | 'trust_step' | 'read' | 'focus' | 'history'
    | 'paste' | 'prompt_submit' | 'dialog_key' | 'take_back_key';
  paneId: string;
  text?: string;
  keys?: readonly string[];
  source?: string;
  /** Obecne tylko, gdy driver JAWNIE poprosił o `wait` (zwykłe prompty ze stall-guardem). */
  wait?: boolean;
}

export class FakeClient implements HerdrClient {
  readonly calls: Call[] = [];
  /** Błąd, którym `prompt` odpowie na następne wywołanie (potem wraca do sukcesu). */
  promptError: unknown = null;
  /** Kolejka błędów dla KOLEJNYCH wywołań `prompt` (podwójny stall) — ma pierwszeństwo. */
  readonly promptErrors: unknown[] = [];
  screenText = 'Do you want to proceed?\n1. Yes\n2. No';

  /** Wszystko, co MUTUJE cudzy panel — jedyna liczba, na której zależy nam w `dispose()`. */
  get mutations(): number {
    return this.calls
      .filter((c) => c.method === 'prompt' || c.method === 'send_keys' || c.method === 'form_submit'
        || c.method === 'mode_cycle' || c.method === 'trust_step' || c.method === 'paste'
        || c.method === 'prompt_submit' || c.method === 'dialog_key' || c.method === 'take_back_key')
      .length;
  }

  /** Krok dialogu zaufania bez cyfr; testy podmieniają go, żeby symulować odmowę gniazda. */
  sendTrustStep: (paneId: string, key: string) => Promise<void> = (paneId, key) => {
    this.calls.push({ method: 'trust_step', paneId, keys: [key] });
    return Promise.resolve();
  };

  /** Key row of a layer 2 card; tests replace it to simulate a socket refusal. */
  sendDialogKey: (paneId: string, key: string) => Promise<void> = (paneId, key) => {
    this.calls.push({ method: 'dialog_key', paneId, keys: [key] });
    return Promise.resolve();
  };

  /** Key of the queue take-back; tests replace it to simulate a socket refusal. */
  sendTakeBackKey: (paneId: string, key: string) => Promise<void> = (paneId, key) => {
    this.calls.push({ method: 'take_back_key', paneId, keys: [key] });
    return Promise.resolve();
  };

  /** Właściwość (nie metoda): testy formularza podmieniają ją, żeby symulować odmowę gniazda. */
  sendFormSubmit: (paneId: string) => Promise<void> = (paneId) => {
    this.calls.push({ method: 'form_submit', paneId, keys: ['enter'] });
    return Promise.resolve();
  };

  /** Jak wyżej — testy przełącznika trybu podmieniają ją, żeby symulować odmowę gniazda przy `shift+tab`. */
  sendModeCycle: (paneId: string) => Promise<void> = (paneId) => {
    this.calls.push({ method: 'mode_cycle', paneId, keys: ['shift+tab'] });
    return Promise.resolve();
  };

  /** Wklejenie wiadomości w trakcie tury; testy podmieniają je, żeby rysować tekst w polu. */
  pasteText: (paneId: string, text: string) => Promise<void> = (paneId, text) => {
    this.calls.push({ method: 'paste', paneId, text });
    return Promise.resolve();
  };

  /** Enter wklejonej wiadomości. */
  sendPromptSubmit: (paneId: string) => Promise<void> = (paneId) => {
    this.calls.push({ method: 'prompt_submit', paneId, keys: ['enter'] });
    return Promise.resolve();
  };

  listAgents(): Promise<never> {
    return Promise.reject(new Error('driver nie woła agent.list'));
  }

  /** Właściwość (nie metoda): test sondy po przerwaniu podmienia ją na sukces. */
  getAgent: () => Promise<HerdrAgentInfo> = () =>
    Promise.reject(new Error('poza sondą przerwania driver nie woła agent.get'));

  /**
   * Ekran z atrybutami dla odczytu composera (`visible` + `ansi`); `null` = ten sam tekst co
   * `screenText` (bez sekwencji parser liczy cały tekst jako treść).
   */
  screenAnsi: string | null = null;
  /**
   * Historia panelu. Driver po nią NIE SIĘGA — wywołania liczymy,
   * bo to jedyny dowód, że karta pytania nie płaci za siebie drugim odczytem panelu.
   */
  historyText = '';

  /**
   * Wiersze panelu do wpisu `degrade` (`pane.list`). Domyślnie BRAK metody: wpis idzie
   * synchronicznie i bez `paneRows` — tak jak przy błędzie odczytu na produkcji.
   */
  readPaneRows?: (paneId: string) => Promise<number>;

  readPaneHistory(paneId: string, _lines: number): Promise<HerdrPaneHistory> {
    this.calls.push({ method: 'history', paneId });
    return Promise.resolve({ text: this.historyText, truncated: false });
  }

  readScreen(
    paneId: string, source: 'detection' | 'visible', format?: 'text' | 'ansi',
  ): Promise<HerdrScreen> {
    this.calls.push({ method: 'read', paneId, source });
    if (format === 'ansi' && this.screenAnsi !== null) {
      return Promise.resolve({ text: this.screenAnsi });
    }
    return Promise.resolve({ text: this.screenText });
  }

  prompt(paneId: string, text: string, wait?: boolean): Promise<void> {
    const call: Call = { method: 'prompt', paneId, text };
    if (wait !== undefined) call.wait = wait;
    this.calls.push(call);
    const queued = this.promptErrors.shift();
    if (queued !== undefined) return Promise.reject(queued as Error);
    const error = this.promptError;
    if (error !== null) {
      this.promptError = null;
      return Promise.reject(error as Error);
    }
    return Promise.resolve();
  }

  /** Właściwość (nie metoda): testy czyszczenia composera podmieniają ją i „czyszczą" ekran. */
  sendKeys: (paneId: string, keys: readonly string[]) => Promise<void> = (paneId, keys) => {
    this.calls.push({ method: 'send_keys', paneId, keys });
    return Promise.resolve();
  };

  focus(paneId: string): Promise<void> {
    this.calls.push({ method: 'focus', paneId });
    return Promise.resolve();
  }

  ping(): Promise<{ version: string; protocol: number }> {
    return Promise.resolve({ version: '0.8.2', protocol: 20 });
  }
}

/**
 * Puls katalogu sesji (S-live) — atrapa.
 *
 * Prawdziwy `session-pulse.ts` ma własny zestaw testów na plikach; tutaj interesuje nas
 * WYŁĄCZNIE styk z driverem: kiedy jest włączany i co driver robi z próbką. Atrapa jest też
 * bezpiecznikiem — bez niej driver w testach oglądałby prawdziwe `~/.claude/projects`.
 */
export class FakePulse implements SessionPulse {
  starts = 0;
  stops = 0;
  closes = 0;
  running = false;
  readonly repoints: string[] = [];
  /** Ile razy driver kazał zapomnieć katalog po przeniesieniu transkryptu. */
  relocations = 0;

  constructor(private readonly onPulse: (sample: PulseSample) => void) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.starts += 1;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stops += 1;
  }

  repoint(agentSessionId: string): void {
    this.repoints.push(agentSessionId);
  }

  relocated(): void {
    this.relocations += 1;
  }

  close(): void {
    this.closes += 1;
    this.running = false;
  }

  /** Meldunek „coś w katalogu urosło" — tak, jak zrobiłby to prawdziwy watcher. */
  beat(sample: Partial<PulseSample> = {}): void {
    this.onPulse({ agents: 0, other: 0, at: Date.now(), ...sample });
  }
}

export interface Fixture {
  driver: SessionDriver;
  client: FakeClient;
  events: DriverEvent[];
  audit: HerdrAuditEntry[];
  emit: (ev: HerdrPaneEvent) => void;
  cwd: string;
  transcript: string;
  /** `null` tylko dla panelu poza zasięgiem — tam driver pulsu w ogóle nie zakłada. */
  pulse: FakePulse | null;
  /** Zależności, które dostał driver (ten sam obiekt: driver czyta flagi przy każdym użyciu). */
  deps: HerdrDriverDeps;
}

export let root = '';
export let base = '';
export const disposers: (() => void)[] = [];

/** Temporary CLI store per test and disposal of drivers built by {@link makeDriver}. */
export function useDriverSandbox(): void {
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'rarog-herdr-driver-'));
    root = join(base, 'store');
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    await rm(base, { recursive: true, force: true });
  });
}

export const waitFor = async (predicate: () => boolean, label = 'warunek'): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/**
 * „Daj driverowi dojść do końca i sprawdź, że NIC więcej nie doszło".
 *
 * 15 ms to nie zaokrąglenie: ma być dłuższe niż `pendingDebounceMs` (10 ms) i `batchMs` (4 ms),
 * a krótsze niż cokolwiek, co test chce zobaczyć przez `waitFor`. Dłuższa cisza niczego tu nie
 * dowodzi — mnoży tylko czas przebiegu przez 87 wywołań.
 *
 * Czemu te 87 wywołań NIE idzie na predykaty `waitFor`: asercja po `quiet()`
 * prawie zawsze ma połowę NEGATYWNĄ — `toEqual([jeden call])` znaczy „ten i ani jeden więcej",
 * a tego predykat nie umie sprawdzić (spełni się na pierwszym i przestanie patrzeć). Stała
 * cisza jest tu NOŚNA, nie leniwa; skracamy ją do granicy karencji drivera i na tym koniec.
 * Przeliczone: 87 × 15 ms ≈ 1,3 s z 6,6 s przebiegu — reszta to prawdziwe `fs/promises`.
 */
export const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

/**
 * Zegar w PEŁNI sterowany: driver nie ma tu ani jednego prawdziwego `setTimeout`, a czas
 * płynie wyłącznie przez `advance()`. Odwrotnie niż `fakeClock()` niżej, który podmienia
 * samo `now()`.
 *
 * WYNIK SPIKE'U — dlaczego to jest w JEDNYM `describe`, a nie w całym pliku:
 *
 * - Zysk jest tam, gdzie test CZEKA na własny zegar drivera. Cztery testy „obrotów zegara"
 *   czekały łącznie ~0,5 s czystej zwłoki; na sterowanym zegarze schodzą do ~0,1 s,
 *   a liczba obrotów jest DOKŁADNA zamiast „ile się zmieści w 100 ms".
 * - Sprawdzone mutacją: po wyłączeniu hamulca `sameForm` (`herdr/dialogs/decide/decide.ts`) i hamulca
 *   „ta sama zakładka" testy na sterowanym zegarze dalej czerwienią. Nie kupiliśmy szybkości
 *   za czułość.
 * - Reszty pliku to NIE dotyczy i nie ma dotyczyć: follower czyta prawdziwe pliki
 *   (`fs/promises`), więc poza zegarem drivera pracuje druga, niesterowana pętla. `flush()`
 *   jest heurystyką („oddaj pętli zdarzeń 30 razy") — wolno jej ufać tylko tam, gdzie jedynym
 *   źródłem czasu jest timer drivera. Przepisanie 417 miejsc na fake timery kupiłoby sekundy
 *   za ryzyko flaków, więc zostaje realny zegar ze skróconymi stałymi.
 */
export function drivenClock(): { scheduler: Scheduler; advance: (ms: number) => Promise<void> } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    now: () => now,
  };
  // Łańcuchy drivera są asynchroniczne (odczyt ekranu, audyt, emisja) — po każdym timerze
  // trzeba oddać pętli zdarzeń, inaczej asercja ogląda stan sprzed połowy reakcji.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      await flush();
      let id: number | null = null;
      let due = Number.POSITIVE_INFINITY;
      for (const [key, timer] of timers) {
        if (timer.at <= target && timer.at < due) { id = key; due = timer.at; }
      }
      if (id === null) break;
      const timer = timers.get(id);
      timers.delete(id);
      now = due;
      timer?.fn();
    }
    now = target;
    await flush();
  };
  return { scheduler, advance };
}

/** Opcje wysyłki tak, jak składa je manager: migawka katalogu i klasyfikacja tekstu. */
export function commandOpts(text: string, catalog: CommandCatalog = registryCatalog()): SendOptions {
  return { command: { catalog, slash: slashOf(classifySlashText(text, catalog)) } };
}

/** Buduje drivera z fake'owym klientem, prawdziwym followerem i sterowanym uchwytem. */
export async function makeDriver(opts: {
  agent?: Partial<HerdrAgent>;
  deps?: Partial<HerdrDriverDeps>;
  transcript?: string;
  /** Plik jsonl NIE POWSTAJE — panel, w którym agent jeszcze nie ruszył (dialog zaufania). */
  noTranscript?: boolean;
  /** Ekran ustawiony PRZED zbudowaniem drivera — dla panelu podpiętego już w `blocked`. */
  screen?: string;
} = {}): Promise<Fixture> {
  const cwd = join(base, 'projekt');
  await mkdir(cwd, { recursive: true });
  const storeDir = join(root, projectSlug(cwd));
  await mkdir(storeDir, { recursive: true });
  const transcript = join(storeDir, `${SESSION}.jsonl`);
  if (opts.noTranscript !== true) await writeFile(transcript, opts.transcript ?? '');

  const agent: HerdrAgent = {
    key: PANE,
    paneId: PANE,
    agentSessionId: SESSION,
    engine: 'claude',
    termId: null,
    cwd,
    status: 'idle',
    title: 'refaktor',
    stateChangeSeq: 7,
    mode: 'auto',
    modeReadAt: 0,
    inScope: true,
    tabId: 'w9:t3',
    launchedByRarog: false,
    interactiveReady: true,
    ...opts.agent,
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
  if (opts.screen !== undefined) client.screenText = opts.screen;
  const audit: HerdrAuditEntry[] = [];
  let pulse: FakePulse | null = null;
  const deps: HerdrDriverDeps = {
    pulse: (o) => {
      pulse = new FakePulse(o.onPulse);
      return pulse;
    },
    client,
    audit: { log: (entry) => audit.push(entry) },
    uploads: createUploads(),
    yoloRoots: [],
    now: () => Date.UTC(2026, 7, 22, 12, 0, 0),
    follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
    // Czytnik plików subagentów patrzy w ten sam magazyn tymczasowy co follower, nie w `~/.claude`.
    agentFiles: (o) => createAgentFileReader({ ...o, root }),
    // Uzgadnianie jsonl ↔ herdr jedzie w testach w milisekundach; realne 800/500 ms sprawdza
    // wyłącznie to, czy `setTimeout` działa. To samo dotyczy pauzy po parze `esc esc`
    // (produkcja: `ESC_SETTLE_MS` = 120 ms) — czekanie na przemalowanie composera jest
    // obietnicą wobec TUI, nie warunkiem żadnej asercji w tym pliku.
    pendingDebounceMs: 10,
    pendingRetryMs: 4,
    escSettleMs: 5,
    // Wariant zdań .mac/.vps zależy od systemu; bez przypięcia CI na Linuksie dostaje inne brzmienie.
    system: 'macos',
    ...opts.deps,
  };

  const driver = createHerdrDriver(handle, deps);
  disposers.push(() => { driver.dispose(); });
  const events: DriverEvent[] = [];
  void (async () => {
    for await (const event of driver.events) events.push(event);
  })();

  return {
    driver, client, events, audit, cwd, transcript, pulse, deps,
    emit: (ev) => { for (const listener of listeners) listener(ev); },
  };
}

export const userLine = (text: string): string => `${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: text },
  isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z',
  sessionId: SESSION,
})}\n`;

/** Wpis bloku hooka `UserPromptSubmit` z cytatem promptu (CLI 2.1.303, `docs/dialogs.md`, „Prompt blocked by a hook”). */
export const blockedLine = (prompt: string): string => `${JSON.stringify({
  type: 'system', subtype: 'informational', level: 'warning', isMeta: false, preventContinuation: true,
  content: `UserPromptSubmit operation blocked by hook:\n[/h.sh]: nie teraz\n\nOriginal prompt: ${prompt}`,
  promptSubmitEnding: { ending: { kind: 'blocked_by_hook', reason: 'nie teraz' }, promptKept: false },
  timestamp: new Date().toISOString(), sessionId: SESSION,
})}\n`;

/** Kody zdań (`ref.code`) notek systemowych; blok bez kodu daje pusty łańcuch. */
export const systemCodes = (events: readonly DriverEvent[]): string[] => events
  .filter((e): e is Extract<DriverEvent, { type: 'message' }> =>
    e.type === 'message' && e.role === 'system')
  .flatMap((e) => e.blocks.map((b) => (b.type === 'text' && 'ref' in b.text ? b.text.ref.code : '')));

/**
 * Wprowadza panel W TURĘ — warunek wpisu „Tura przerwana z Raroga", mierzony PRZED wysłaniem
 * klawisza. Bez tego driver widzi `idle` z fixture'u, czyli panel, który STOI: Esc dalej leci,
 * tylko nie ma o czym meldować.
 */
export const inTurn = (fx: Fixture, status: 'working' | 'blocked' = 'working'): void => {
  fx.emit({ type: 'status', status, stateChangeSeq: 8, title: 'refaktor' });
};

/**
 * Pole promptu w ramce (odczyt `visible` + `ansi`) — komenda sterująca czyta je przed każdą wysyłką. Testy z ekranem
 * samego dialogu ustawiają je w `screenAnsi`: dialog widzi odczyt `detection`, a pole przed komendą jest puste.
 */
export const FIELD_RULE = '─'.repeat(40);
export const fieldScreen = (text: string): string => `${FIELD_RULE}\n❯ ${text}\n${FIELD_RULE}`;
export const EMPTY_FIELD = fieldScreen('');

/** Panel Claude z polem promptu w ramce ({@link composerPane}): pole i dialog, który je zakrywa. */
export interface ComposerPane {
  field: string;
  /** Ekran dialogu albo formularza na wierzchu; `null` = widać pole. */
  dialog: string | null;
  /** Treść pola przy każdym Enterze wklejonej wiadomości — to, co CLI dostał jako prompt. */
  submitted: string[];
  draw: () => void;
}

/**
 * Panel Claude w trakcie tury dla wysyłki z osobnym Enterem: oba odczyty ekranu pokazują pole
 * w ramce albo dialog, wklejenie dopisuje tekst do widocznego pola (w dialog przepada — pomiar 0a, 6 z 6), Enter
 * opróżnia pole, para Esc czyści widoczne pole, a `agent.get` oddaje tę samą sesję Claude.
 */
export function composerPane(fx: Fixture): ComposerPane {
  const pane: ComposerPane = {
    field: '',
    dialog: null,
    submitted: [],
    draw: () => {
      const screen = pane.dialog ?? fieldScreen(pane.field);
      fx.client.screenText = screen;
      fx.client.screenAnsi = screen;
    },
  };
  pane.draw();
  fx.client.pasteText = (paneId, text) => {
    fx.client.calls.push({ method: 'paste', paneId, text });
    if (pane.dialog === null) pane.field += text;
    pane.draw();
    return Promise.resolve();
  };
  fx.client.sendPromptSubmit = (paneId) => {
    fx.client.calls.push({ method: 'prompt_submit', paneId, keys: ['enter'] });
    if (pane.dialog === null) {
      pane.submitted.push(pane.field);
      pane.field = '';
    }
    pane.draw();
    return Promise.resolve();
  };
  fx.client.sendKeys = (paneId, keys) => {
    fx.client.calls.push({ method: 'send_keys', paneId, keys });
    if (pane.dialog === null && keys.length === 2 && keys.every((key) => key === 'escape')) pane.field = '';
    pane.draw();
    return Promise.resolve();
  };
  fx.client.getAgent = (): Promise<HerdrAgentInfo> => Promise.resolve({
    paneId: PANE, agentSessionId: SESSION, engine: 'claude', status: 'working',
  } as HerdrAgentInfo);
  return pane;
}

/** Wklejenia i Entery wysyłki w trakcie tury oraz `agent.prompt`, po kolei. */
export const pasteFlow = (fx: Fixture): string[] => fx.client.calls
  .filter((c) => c.method === 'paste' || c.method === 'prompt_submit' || c.method === 'prompt')
  .map((c) => (c.method === 'prompt_submit' ? 'enter' : `${c.method}:${c.text ?? ''}`));

/** Ekran, którego `parseOptions` nie rozpozna — panel przemalowany bez dialogu. */
export const NIE_DIALOG = 'przemalowany panel bez dialogu\n\n(nic tu nie ma)\n';

export const systemTexts = (events: readonly DriverEvent[]): string[] => events
  .filter((e): e is Extract<DriverEvent, { type: 'message' }> =>
    e.type === 'message' && e.role === 'system')
  .flatMap((e) => e.blocks.map((b) => (b.type === 'text' ? b.text.text : '')));

export const states = (events: readonly DriverEvent[]): Extract<DriverEvent, { type: 'agent-state' }>[] =>
  events.filter((e): e is Extract<DriverEvent, { type: 'agent-state' }> => e.type === 'agent-state');

export const permissions = (
  events: readonly DriverEvent[],
): Extract<DriverEvent, { type: 'permission-request' }>[] => events.filter(
  (e): e is Extract<DriverEvent, { type: 'permission-request' }> => e.type === 'permission-request',
);

/** Karty dialogu spoza jsonl — osobne zdarzenie, bo taka karta nie ma `permId`. */
export const screenDialogs = (
  events: readonly DriverEvent[],
): Extract<DriverEvent, { type: 'screen-dialog' }>[] => events.filter(
  (e): e is Extract<DriverEvent, { type: 'screen-dialog' }> => e.type === 'screen-dialog',
);

export const questions = (
  events: readonly DriverEvent[],
): Extract<DriverEvent, { type: 'question-request' }>[] => events.filter(
  (e): e is Extract<DriverEvent, { type: 'question-request' }> => e.type === 'question-request',
);

export const cleared = (
  events: readonly DriverEvent[],
): Extract<DriverEvent, { type: 'permission-cleared' }>[] => events.filter(
  (e): e is Extract<DriverEvent, { type: 'permission-cleared' }> => e.type === 'permission-cleared',
);

export const reads = (client: FakeClient): number =>
  client.calls.filter((c) => c.method === 'read').length;

/** Wpis `assistant` z niedomkniętym `tool_use` — to on znaczy „agent na coś czeka". */
export const toolUseLine = (id: string, name: string, input: unknown): string => `${JSON.stringify({
  type: 'assistant',
  isSidechain: false,
  timestamp: '2026-08-22T10:00:06.000Z',
  sessionId: SESSION,
  message: {
    role: 'assistant', model: 'claude-fable-5',
    content: [{ type: 'tool_use', id, name, input }],
  },
})}\n`;

export const toolResultLine = (id: string): string => `${JSON.stringify({
  type: 'user',
  isSidechain: false,
  timestamp: '2026-08-22T10:00:07.000Z',
  sessionId: SESSION,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})}\n`;
