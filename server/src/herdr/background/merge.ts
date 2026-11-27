/**
 * Zadania w tle panelu — sklejanie listy followera z tym, co wiemy z plików OBOK transkryptu,
 * i zegar odczytów tych plików.
 *
 * Moduł katalogu zadań w tle (mapa modułów: `index.ts`, opis: `docs/background-tasks.md`).
 *
 * Funkcje nad JAWNYM stanem (`TasksState`), nie klasa z własnym `this`: fasada
 * (`drivers/herdr-driver.ts`) trzyma jedno pole stanu i podaje je przy każdym wywołaniu.
 * Gdyby moduł trzymał stan sam, panel miałby dwie prawdy o tej samej liście zadań —
 * jedną w driverze, drugą tutaj.
 *
 * Podział jest taki sam jak w całym driverze: follower jsonl mówi, JAKIE zadania stoją
 * (`tasks`), a dwa czytniki dokładają to, czego plik główny nie niesie:
 *
 * - `workflow-run.ts` — ROZKŁAD otwartego przebiegu workflow;
 * - `agent-file.ts` — fakty z pliku rozmowy subagenta. Z czasu jego ostatniego wpisu wynika
 *   WYBUDZENIE: agent, którego follower zna jako czekającego, a którego plik ma wpis późniejszy
 *   niż początek postoju, jedzie w górę jako pracujący. Z jego otwartych komend powstaje
 *   `ownTasks`: to, na co agent czeka. A agent w postoju, który nie ma już na co czekać i przez
 *   minutę nie ruszył, jest UŚPIONY i z listy wypada ({@link DORMANT_AFTER_MS}).
 *
 * Trzecia rzecz przychodzi z samego followera, ale nie należy do listy: końce bez startu (`ended`)
 * i czas najstarszego wpisu, jaki reduktor pliku głównego widział (`since`). Oba służą wyłącznie
 * własnym komendom subagentów.
 *
 * Nakładki żyją w stanie i są stosowane przy KAŻDEJ emisji (`mergedTasks`), więc powtórzona lista
 * followera niczego nie cofa. Zamknięte zadanie wypada z pamięci przy nowej liście followera, nie
 * w ticku zegara — lista z pliku jest jedynym źródłem prawdy o tym, co jeszcze żyje.
 */
import type { AgentOwnTask, BackgroundTask, WorkflowRun } from '@rarog/shared';
import type { Scheduler, TimerHandle } from '../../drivers/runtime.ts';
import type { AgentFileFacts, AgentFileReader } from './agent-file.ts';
import { ownCommandWaitOf } from './work.ts';
import type { WorkflowRunReader } from './workflow-run.ts';

/**
 * Co ile driver odczytuje pliki obok transkryptu: rozkłady OTWARTYCH przebiegów workflow
 * i pliki OTWARTYCH subagentów.
 *
 * Niezależnie od tury: workflow i subagent żyją w tle także po tym, jak agent skończył wypowiedź
 * („odpaliłem, dam znać"), więc puls katalogu — który chodzi tylko w turze — nie nadaje się
 * na ten zegar. Pięć sekund, bo zmiana rozkładu to start albo koniec agenta, a te dzielą minuty;
 * dla subagenta to najdłuższe opóźnienie między jego wybudzeniem a „pracuje" na ekranie.
 */
export const TASKS_POLL_MS = 5_000;

/** Ile własnych komend jednego subagenta jedzie na telefon; ponad sufit zostają NAJNOWSZE. */
export const OWN_TASKS_MAX = 20;

/**
 * Po jakiej CISZY subagent w postoju jest uśpiony, czyli znika z listy.
 *
 * CLI melduje postój, gdy agent staje przy żywym własnym zadaniu w tle. Gdy to zadanie skończy
 * się bez wybudzenia agenta, CLI nie pisze o nim nic więcej i wpis wisiałby na „czeka" do
 * restartu procesu CLI (zmierzone: 13 z 248 agentów w plikach sesji projektu).
 * Cisza to stan, w którym naraz: agent czeka, jego plik jest znany do ostatniej linii
 * (`AgentFileFacts.settled`), nie ma w nim wpisu późniejszego niż postój, agent nie ma otwartej
 * własnej komendy i minął termin jego innych własnych zadań ({@link restsQuietly}).
 *
 * Minuta, bo agent stojący w postoju dostaje wpis wybudzenia 8–111 ms po końcu swojej komendy
 * w kolejce pliku głównego (53 przypadki, mediana 33 ms), a plik czytamy co
 * {@link TASKS_POLL_MS}. Reszta to zapas na to, czego pomiar nie objął. Uśpienie niczego nie
 * kasuje: follower dalej trzyma wpis, zegar dalej czyta plik, a każdy późniejszy wpis albo nowy
 * postój przywraca agenta na listę.
 */
export const DORMANT_AFTER_MS = 60_000;

/*
 * Odmiany liczebnika („1 agent" / „4 agenci" / „7 agentów") świadomie TU NIE MA.
 *
 * Serwer niesie `agents: number` i `workflow?: string`, a zdanie składa klient
 * (`ActivityText.swift` apki) — to samo miejsce, które odmienia
 * pozostałe liczebniki. Dwie kopie polskiej odmiany po dwóch stronach drutu rozjeżdżają się
 * przy pierwszej poprawce copy.
 */

/** Stan zadań JEDNEGO panelu — właścicielem pola jest fasada, nie ten moduł. */
export interface TasksState {
  /** Zadania tak, jak przyszły z followera — bez nakładek; źródło dla {@link mergedTasks}. */
  raw: readonly BackgroundTask[];
  /** `wf_<id>` → ostatni odczytany rozkład, w postaci do porównania i do wysłania. */
  readonly runs: Map<string, { json: string; run: WorkflowRun }>;
  /** Id subagenta → fakty z ostatniego odczytu jego pliku. Tylko agenci z listy followera. */
  readonly agents: Map<string, AgentFileFacts>;
  /**
   * Agenci, których OSTATNI odczyt pliku się nie udał. Fakty z wcześniejszego odczytu zostają
   * (wybudzenie, które widzieliśmy, było), ale ciszy nie dowodzą: plik mógł się zmienić.
   */
  readonly unread: Set<string>;
  /**
   * Agenci w CISZY ({@link restsQuietly}): postój, dla którego ją liczymy, i chwila zegara
   * drivera, od której trwa nieprzerwanie. Upływ czasu jest faktem o zegarze, nie o plikach,
   * dlatego jedyny w tym module zapamiętany werdykt stoi tutaj.
   */
  readonly quiet: Map<string, { waitingSince: string; since: number }>;
  /**
   * Agenci uśpieni: cisza trwa co najmniej {@link DORMANT_AFTER_MS} i potwierdził ją odczyt pliku
   * zakończony PO upływie tego czasu. Liczone tuż przed emisją ({@link refreshDormant}).
   */
  readonly dormant: Set<string>;
  /**
   * Id zamknięte w pliku głównym BEZ startu (`ended` z followera), zbierane przez całą sesję
   * silnika. Wśród nich są końce własnych komend subagentów, które przeszły tylko przez kolejkę
   * pliku głównego. Zbiór, nie kolejka zdarzeń: koniec potrafi przyjść PRZED odczytaniem startu
   * (follower czyta od razu, plik subagenta w ticku) i wtedy czeka tu na swoją komendę. Czytnik
   * dostaje ten zbiór przy każdym odczycie i zamyka nim komendy u siebie; tutaj odsiewa on
   * komendę między końcem a następnym odczytem.
   */
  readonly ended: Set<string>;
  /**
   * `timestamp` najstarszego wpisu, jaki reduktor pliku głównego widział od swojego zerowania
   * (`since` z ostatniego zdarzenia followera); `undefined` = nie wiadomo. Koniec komendy
   * wystartowanej wcześniej mógł stać w pliku głównym, zanim zaczęliśmy patrzeć.
   */
  since: string | undefined;
  /**
   * Numer sesji silnika z punktu widzenia tego stanu; rośnie w {@link forgetSession}. Odczyt
   * trwa, a `/clear` potrafi wejść w jego środek: wynik rozpoczęty w starszym pokoleniu opisuje
   * poprzednią sesję i do stanu nie wchodzi.
   */
  generation: number;
  /**
   * Ostatnio wysłana lista jako JSON — w górę jedzie tylko lista, która się od niej różni. `null` = nic jeszcze
   * nie wyszło: pierwsza lista idzie zawsze, także pusta. Nowy driver po wymianie (`re-attached`) dostaje
   * sesję z listą poprzedniego drivera, a pusta lista nie różniłaby się od pustego podpisu i nie wyszłaby nigdy.
   * Pustą listę przy polu, którego i tak nie ma, odsiewa manager.
   */
  sent: string | null;
  timer: TimerHandle | null;
  polling: boolean;
}

/** Styk z resztą drivera: czytniki, zegar i jedyne wyjście na zewnątrz (emisja listy). */
export interface TasksDeps {
  /** Czytnik rozkładu; `null` = panel poza zasięgiem, żadnych plików nie oglądamy. */
  readonly reader: WorkflowRunReader | null;
  /**
   * Czytnik plików subagentów; `null` = panel poza zasięgiem albo odczyt wyłączony
   * (`RAROG_AGENT_FILES=0`). Bez niego agent po postoju stoi na „czeka" do wznowienia albo końca.
   */
  readonly agentReader: AgentFileReader | null;
  readonly scheduler: Scheduler;
  readonly pollMs: number;
  readonly disposed: () => boolean;
  readonly emit: (tasks: readonly BackgroundTask[]) => void;
}

/** Jedna porcja z followera — kształt jego zdarzenia `tasks`. */
export interface TasksUpdate {
  readonly tasks: readonly BackgroundTask[];
  /** Id zamknięte bez startu od poprzedniej porcji. */
  readonly ended?: readonly string[];
  /** Czas najstarszego wpisu, jaki reduktor pliku głównego widział; nieobecny = żadnego z czasem. */
  readonly since?: string;
}

/** Emisja bez świeżego odczytu (lista z followera): nikogo nie wolno uśpić. */
const NO_FRESH: ReadonlySet<string> = new Set();

export function createTasksState(): TasksState {
  return {
    raw: [], runs: new Map(), agents: new Map(), unread: new Set(), quiet: new Map(), dormant: new Set(),
    ended: new Set(), since: undefined, generation: 0, sent: null, timer: null, polling: false,
  };
}

export function openRunIds(state: TasksState): string[] {
  return state.raw.flatMap((task) =>
    (task.kind === 'workflow' && task.runId !== undefined ? [task.runId] : []));
}

/**
 * Otwarte przebiegi z chwilą OSTATNIEGO uruchomienia (`startedAt` zadania). Wznowienie
 * (`resumeFromRunId`) zakłada nowe zadanie z tym samym `runId`; gdy stare nie dostało
 * zamknięcia, liczy się późniejsze. Po tej chwili `workflow-run.ts` odsiewa agentów
 * przerwanego uruchomienia (`withoutInterrupted`).
 */
export function openRuns(state: TasksState): { runId: string; launchedAt?: string }[] {
  const latest = new Map<string, string | undefined>();
  const time = (at: string | undefined): number => (at === undefined ? -Infinity : Date.parse(at) || -Infinity);
  for (const task of state.raw) {
    if (task.kind !== 'workflow' || task.runId === undefined) continue;
    if (!latest.has(task.runId) || time(task.startedAt) > time(latest.get(task.runId))) {
      latest.set(task.runId, task.startedAt);
    }
  }
  return [...latest].map(([runId, launchedAt]) => (launchedAt === undefined ? { runId } : { runId, launchedAt }));
}

/** Otwarci subagenci z listy followera: pracujący i czekający. */
function openAgentIds(state: TasksState): string[] {
  return state.raw.flatMap((task) => (task.kind === 'agent' ? [task.id] : []));
}

/**
 * Nazwa przebiegu `runId` z LISTY ZADAŃ followera (`description` zadania `workflow`, czyli
 * `workflowName` z `toolUseResult`). Puls zna nazwę tylko z listingu `workflows/scripts/`,
 * a ten katalog Claude Code zapełnia WYŁĄCZNIE dla skryptu podanego inline (`script`) —
 * przebieg z `scriptPath` (zmierzone: skrypt w scratchpadzie, `workflows/scripts/`
 * bez wpisu) nie ma tam nic i puls nazwałby go „subagent". `undefined` = lista też nie wie.
 */
export function runName(state: TasksState, runId: string): string | undefined {
  const task = state.raw.find((item) => item.kind === 'workflow' && item.runId === runId);
  const name = task?.description ?? '';
  return name === '' ? undefined : name;
}

/**
 * Własne komendy subagenta do pokazania: otwarte według jego pliku, bez tych, których koniec znamy
 * z pliku głównego, i bez tych o LOSIE NIEZNANYM.
 *
 * Koniec własnej komendy ma trzy źródła: meldunek we własnym pliku subagenta i wynik `TaskStop`
 * (zna je czytnik pliku) oraz meldunek w kolejce pliku głównego (`state.ended`). To trzecie bywa
 * jedynym, a plik główny znamy dopiero od `state.since`: okno ogona po restarcie Raroga, przeskok,
 * skrócenie. Komenda wystartowana przed tą chwilą mogła się skończyć, zanim zaczęliśmy patrzeć,
 * więc bez znanego końca nie jest pokazywana. Lepiej nie pokazać żywej komendy niż trzymać na
 * ekranie martwą bez końca. Tak samo komenda bez czasu startu i każda komenda, gdy `since` nie znamy.
 */
function ownTasksOf(state: TasksState, facts: AgentFileFacts): AgentOwnTask[] {
  // Chwile, nie napisy; `NaN` (brak albo nieczytelny czas) przegrywa każde porównanie.
  const since = state.since === undefined ? Number.NaN : Date.parse(state.since);
  return facts.commands
    .filter((command) => !state.ended.has(command.id)
      && command.startedAt !== undefined && Date.parse(command.startedAt) >= since)
    .slice(-OWN_TASKS_MAX);
}

/** Czy plik agenta ma wpis późniejszy niż początek postoju (chwile, nie napisy; `NaN` przegrywa). */
function wokenSince(task: BackgroundTask, facts: AgentFileFacts): boolean {
  return task.waitingSince !== undefined && facts.lastEntryAt !== undefined
    && Date.parse(facts.lastEntryAt) > Date.parse(task.waitingSince);
}

/**
 * Czy subagent jest w CISZY: stoi w postoju i według wszystkiego, co wiemy, nie ma już na co
 * czekać. Pięć warunków naraz; brak któregokolwiek zostawia agenta na liście.
 *
 * 1. follower zna go jako czekającego (`waitingSince`);
 * 2. ostatni odczyt jego pliku się udał, a plik jest znany do ostatniej linii (`settled`);
 * 3. plik nie ma wpisu późniejszego niż postój (agent nie ruszył);
 * 4. agent nie ma otwartej własnej komendy. Liczą się WSZYSTKIE otwarte według jego pliku, także
 *    te o losie nieznanym, których `ownTasksOf` nie pokazuje: brak dowodu końca to nie koniec;
 * 5. minął termin jego innych własnych zadań (monitor; zagnieżdżony subagent i workflow terminu
 *    nie mają, więc taki agent w ciszy nie jest nigdy). Uśpienie zdejmuje blokadę restartu sesji,
 *    więc agent, który może jeszcze na coś czekać, zostaje.
 */
function restsQuietly(state: TasksState, task: BackgroundTask, now: number): boolean {
  if (task.waitingSince === undefined || state.unread.has(task.id)) return false;
  const facts = state.agents.get(task.id);
  if (facts?.settled === undefined || wokenSince(task, facts)) return false;
  if (facts.commands.some((command) => !state.ended.has(command.id))) return false;
  return now >= (facts.settled.otherWorkUntil ?? -Infinity);
}

/**
 * Liczy ciszę i uśpienie wszystkich agentów z listy followera na chwilę `now`. Cisza liczy się od
 * pierwszej chwili, w której ją widzimy, i od nowa po każdym nowym postoju (inne `waitingSince`):
 * agent, który ruszył i znów stanął między dwoma odczytami, wraca na listę na pełną minutę.
 *
 * ODWOŁAĆ uśpienie wolno przy każdej emisji, NADAĆ tylko po odczycie: `fresh` to agenci, których
 * plik udało się przeczytać w odczycie zakończonym tuż przed tą emisją. Lista followera przychodzi
 * także w trakcie odczytu; gdyby sama mijająca minuta usypiała, agent zniknąłby na podstawie faktów
 * sprzed odczytu, który właśnie niesie jego wybudzenie.
 */
function refreshDormant(state: TasksState, now: number, fresh: ReadonlySet<string>): void {
  const open = new Set<string>();
  const asleep = new Set(state.dormant);
  state.dormant.clear();
  for (const task of state.raw) {
    if (task.kind !== 'agent') continue;
    open.add(task.id);
    if (task.waitingSince === undefined || !restsQuietly(state, task, now)) {
      state.quiet.delete(task.id);
      continue;
    }
    let known = state.quiet.get(task.id);
    if (known?.waitingSince !== task.waitingSince) {
      known = { waitingSince: task.waitingSince, since: now };
      state.quiet.set(task.id, known);
      continue;
    }
    const due = now - known.since >= DORMANT_AFTER_MS;
    if (due && (asleep.has(task.id) || fresh.has(task.id))) state.dormant.add(task.id);
  }
  for (const id of [...state.quiet.keys()]) if (!open.has(id)) state.quiet.delete(id);
}

/**
 * Subagent z nakładką z jego pliku. Oddaje obiekt followera albo jego KOPIĘ: obiekty zadań jadą
 * do sesji przez referencję, więc zmiana w miejscu przepisałaby listę, która już wyszła.
 *
 * WYBUDZENIE to porównanie dwóch faktów, nie zapamiętany werdykt: początek postoju z followera
 * (`waitingSince`) i czas ostatniego wpisu pliku subagenta. Pierwszy wpis po postoju jest zawsze
 * późniejszy niż meldunek o postoju, a ostatni przed nim zawsze wcześniejszy (pomiar w nagłówku
 * `agent-file.ts`), więc wpis późniejszy niż `waitingSince` znaczy, że agent ruszył. Skutki:
 *
 * - nowy postój gasi wybudzenie sam: jego `waitingSince` jest późniejsze niż wszystko, co agent
 *   zapisał wcześniej;
 * - wznowienie i koniec z followera wygrywają bez udziału tej funkcji (pola nie ma albo agenta
 *   nie ma na liście);
 * - wynik odczytu, który wrócił po zmianie `waitingSince`, niczego nie psuje: czas wpisu jest
 *   faktem o pliku i zestawia się z BIEŻĄCYM postojem, nie z tym sprzed odczytu.
 *
 * The wait stage (`ownCommandWait`) is set last, on the copy, from the view after the wake and the own commands:
 * `ownCommandWaitOf` in `work.ts` decides, with the clock of this emission (`now`).
 */
function agentView(state: TasksState, task: BackgroundTask, now: number): BackgroundTask {
  const facts = state.agents.get(task.id);
  if (facts === undefined) return task;
  // Chwile, nie napisy. Nieczytelny czas daje `NaN`, a każde porównanie z nim jest fałszem: agent
  // zostaje na „czeka", czyli tam, gdzie postawił go follower.
  const woken = wokenSince(task, facts);
  const own = ownTasksOf(state, facts);
  if (!woken && own.length === 0) return task;
  const view: BackgroundTask = { ...task };
  if (woken) delete view.waitingSince;
  // Własne komendy widać także pod agentem, który pracuje: to dalej jego otwarte zadania.
  if (own.length > 0) view.ownTasks = own;
  const wait = ownCommandWaitOf(view, now);
  if (wait !== undefined) view.ownCommandWait = wait;
  return view;
}

/**
 * Zadania followera z nakładkami tam, gdzie je znamy. Reszta jedzie bez zmian; agent uśpiony
 * (`state.dormant`) nie jedzie wcale. Funkcja samego stanu: uśpienie liczy `emitChanged`.
 * `now` is the clock of the emission; only the wait stage of an agent reads it.
 */
export function mergedTasks(state: TasksState, now: number): BackgroundTask[] {
  return state.raw.flatMap((task): BackgroundTask[] => {
    if (task.kind === 'agent') return state.dormant.has(task.id) ? [] : [agentView(state, task, now)];
    const run = task.runId === undefined ? undefined : state.runs.get(task.runId)?.run;
    return [run === undefined ? task : { ...task, run }];
  });
}

/**
 * Lista w górę, ale tylko gdy różni się od ostatnio wysłanej (pierwsza idzie zawsze, `TasksState.sent`).
 *
 * Follower woła {@link noteTasks} także wtedy, gdy lista się nie zmieniła (koniec bez startu:
 * zdarzenie `tasks` z samym `ended`), a odczyt pliku subagenta co tick przynosi nowy czas wpisu,
 * który zwykle niczego w liście nie zmienia. Manager po każdej liście rozsyła `session-changed`,
 * więc powtórka tej samej listy byłaby pustą ramką do każdego klienta.
 *
 * The compared list carries the wait stage, so a threshold passed between two ticks changes the JSON and goes out on
 * the first tick after it, with no change in any file.
 */
function emitChanged(state: TasksState, deps: TasksDeps, fresh: ReadonlySet<string> = NO_FRESH): void {
  const now = deps.scheduler.now();
  refreshDormant(state, now, fresh);
  const merged = mergedTasks(state, now);
  const json = JSON.stringify(merged);
  if (json === state.sent) return;
  state.sent = json;
  deps.emit(merged);
}

/** Czy jest co czytać: otwarty przebieg z czytnikiem rozkładów albo otwarty agent z czytnikiem plików. */
function hasOpenFiles(state: TasksState, deps: TasksDeps): boolean {
  return (deps.reader !== null && openRunIds(state).length > 0)
    || (deps.agentReader !== null && openAgentIds(state).length > 0);
}

/**
 * Nowa lista zadań z followera → od razu w górę (z nakładkami, które już mamy), a dla otwartych
 * przebiegów i agentów — odczyt od razu i zegar. Zamknięte zadania wypadają z pamięci tu, nie
 * w ticku: lista followera jest jedynym źródłem prawdy o tym, co jeszcze żyje.
 */
export function noteTasks(state: TasksState, deps: TasksDeps, update: TasksUpdate): void {
  state.raw = update.tasks;
  for (const id of update.ended ?? []) state.ended.add(id);
  state.since = update.since;
  const runs = new Set(openRunIds(state));
  for (const runId of [...state.runs.keys()]) if (!runs.has(runId)) state.runs.delete(runId);
  const agents = new Set(openAgentIds(state));
  for (const id of [...state.agents.keys()]) if (!agents.has(id)) state.agents.delete(id);
  for (const id of [...state.unread]) if (!agents.has(id)) state.unread.delete(id);
  emitChanged(state, deps);
  void pollTasks(state, deps);
}

/**
 * Jeden odczyt wszystkich otwartych przebiegów i plików otwartych agentów; zmiana = nowa lista
 * w górę. Zegar zakłada się na nowo dopóki jest co czytać — i tylko wtedy.
 *
 * Wynik odczytu wchodzi do stanu tylko, gdy w trakcie nie zmieniła się sesja silnika
 * (`generation`), a zadanie, którego dotyczy, dalej stoi na liście followera. Sama
 * kontrola `disposed` po `await` nie wystarcza: rozkład przebiegu sprzed `/clear` wracałby do
 * stanu nowej sesji.
 */
export async function pollTasks(state: TasksState, deps: TasksDeps): Promise<void> {
  if (deps.disposed() || state.polling || !hasOpenFiles(state, deps)) return;
  state.polling = true;
  const generation = state.generation;
  const current = (): boolean => state.generation === generation;
  /** Agenci, których plik udało się przeczytać w TYM odczycie: tylko ich wolno teraz uśpić. */
  const fresh = new Set<string>();
  try {
    if (deps.reader !== null) {
      for (const { runId, launchedAt } of openRuns(state)) {
        const run = await deps.reader.read(runId, launchedAt);
        if (deps.disposed()) return;
        if (!current()) break;
        if (run === null || !openRunIds(state).includes(runId)) continue;
        const json = JSON.stringify(run);
        if (state.runs.get(runId)?.json !== json) state.runs.set(runId, { json, run });
      }
    }
    if (deps.agentReader !== null && current()) {
      for (const id of openAgentIds(state)) {
        const facts = await deps.agentReader.read(id, state.ended);
        if (deps.disposed()) return;
        if (!current()) break;
        if (!openAgentIds(state).includes(id)) continue;
        // Nieudany odczyt przerywa ciszę: stare fakty zostają, ale niczego już nie dowodzą.
        if (facts === null) {
          state.unread.add(id);
          continue;
        }
        state.unread.delete(id);
        state.agents.set(id, facts);
        fresh.add(id);
      }
    }
  } finally {
    state.polling = false;
  }
  emitChanged(state, deps, fresh);
  scheduleTasks(state, deps);
}

export function scheduleTasks(state: TasksState, deps: TasksDeps): void {
  if (deps.disposed() || state.timer !== null || !hasOpenFiles(state, deps)) return;
  state.timer = deps.scheduler.setTimeout(() => {
    state.timer = null;
    void pollTasks(state, deps);
  }, deps.pollMs);
}

/**
 * Nowa sesja silnika (`/clear`, `/resume`): rozkłady, fakty o agentach, końce i początek okna
 * opisują PRZESZŁOŚĆ, a odczyt, który właśnie trwa, opisuje ją także po powrocie.
 */
export function forgetSession(state: TasksState): void {
  state.generation += 1;
  state.runs.clear();
  state.agents.clear();
  state.unread.clear();
  state.quiet.clear();
  state.dormant.clear();
  state.ended.clear();
  state.since = undefined;
}

/** `dispose()`: gasimy WYŁĄCZNIE własny zegar — czytniki zamyka fasada razem z resztą źródeł. */
export function stopTasks(state: TasksState, scheduler: Scheduler): void {
  if (state.timer === null) return;
  scheduler.clearTimeout(state.timer);
  state.timer = null;
}
