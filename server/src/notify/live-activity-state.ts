/**
 * Stan treści zbiorczej Live Activity — CZYSTE składanie z listy sesji, zero sieci.
 *
 * To jest wszystko, co serwer kiedykolwiek kładzie na ekran blokady apki: liczniki „czeka", „pracuje"
 * i „skończyły", do dwóch przebiegów workflow z paskiem faz, limity planu i obciążenie Maca, a do tego
 * cel tapnięcia (sesja wiodąca — bez nazwy). Kształt wyznacza kontrakt (`liveActivityContentStateSchema`
 * w `@rarog/shared/rest`), który NIE MA pól na treść — ten moduł dokłada drugą warstwę: z `SessionSummary`
 * bierze wyłącznie pola, które wolno pokazać.
 *
 * **Nigdy:** `waitingFor` (ani treść, ani narzędzie zgody: ile czeka, bez informacji na co),
 * `activity.summary`, `lastSummary`, `displayText`, etykieta sesji, `summary` przebiegu (to opis skryptu)
 * ani opis zadania, który nie ma kształtu nazwy skryptu. Aktywność wisi do 8 h na ekranie blokady.
 * Wolno: liczby, procenty, projekt, nazwa skryptu workflow, numer i tytuł fazy
 * oraz stan każdej fazy planu. Strażnik:
 * `server/test/notify-live-activity.test.ts`.
 *
 * Liczniki to te same definicje co lista klienta: `waiting` = `waiting-permission`
 * + `waiting-question`, `working` = `starting` + `running` ORAZ sesja po turze, w której coś dalej mieli
 * w tle („pracuje w tle"), `finished` = `waiting-input` z wynikiem nieodebranym (`seen !== true`)
 * i bez pracy w tle. Kafel bez zadań w tle rozjeżdżałby się z listą: lista mówiłaby „3 pracują", a kafel
 * „1 pracuje · 1 skończyła". A `waiting-input` session whose subagent is stuck on its own command (`stuckWait`)
 * counts as waiting only, acknowledged or not, and is not the lead; the silence timer (`isBusy`) ignores it.
 *
 * Sesja wiodąca = NAJDŁUŻEJ czekająca, a gdy nikt nie czeka — najdłużej pracująca. Reguła „najstarszy
 * `stateSince`" jest świadomie stabilna: wiodąca zmienia się tylko wtedy, gdy ta sesja zmienia stan.
 *
 * Przebiegi workflow pochodzą z `backgroundTasks[].run` WSZYSTKICH sesji, nie z `activity` sesji wiodącej:
 * `activity` istnieje tylko w turze i opisuje jeden przebieg na sesję, a workflow mieli w tle także po
 * zakończeniu tury („odpaliłem, dam znać"). Kolejność = start przebiegu (najstarszy pierwszy): nowy
 * przebieg nie wypycha z kafla tego, który już tam stoi.
 *
 * Co z listy zadań liczy się jako praca, rozstrzyga `herdr/background/work.ts` (jedno miejsce reguł,
 * `docs/background-tasks.md`): ten moduł tylko pyta `hasBackgroundWork`, `hasOpenWorkflow`, `stuckWait`
 * i `workflowsWithRun`. Subagent w postoju (`waitingSince`) pracą nie jest: sesja po turze, której całe tło czeka,
 * nie liczy się do „pracuje", a z wynikiem nieodebranym liczy się do „skończyły". Once its wait reaches `stuck`, the
 * session counts as waiting instead (golden frame `live-activity.update.waiting-agent.json`).
 */
import type { BackgroundTask, SessionState, SessionSummary, WorkflowRun } from '@rarog/shared';
import { TERM_ID_RE } from '@rarog/shared';
import { phaseCounts } from '@rarog/shared/workflow-phases';
import type { LiveActivityContentState } from '@rarog/shared/rest';
import {
  LIVE_ACTIVITY_SEGMENTS_MAX, LIVE_ACTIVITY_TEXT_MAX, LIVE_ACTIVITY_WORKFLOWS_MAX,
} from '@rarog/shared/rest';
import { hasBackgroundWork, hasOpenWorkflow, stuckWait, workflowsWithRun } from '../herdr/background/work.ts';
import { currentPhase } from './workflow-phase.ts';

type Top = NonNullable<LiveActivityContentState['top']>;
type Workflow = NonNullable<LiveActivityContentState['workflows']>[number];
type Limits = NonNullable<LiveActivityContentState['limits']>;
type Mac = NonNullable<LiveActivityContentState['mac']>;
type PhaseState = NonNullable<Workflow['states']>[number];

/** Dane spoza listy sesji: limity planu (`live-activity-limits.ts`) i obciążenie Maca (`mac-stats.ts`). */
export interface LiveActivityExtras {
  readonly limits?: Limits;
  readonly mac?: Mac;
}

const WAITING: readonly SessionState[] = ['waiting-permission', 'waiting-question'];
const WORKING: readonly SessionState[] = ['starting', 'running'];
/**
 * Stany, które zadanie w tle podnosi do „pracuje" — na liście to tony `new` i `done`: człowiek
 * nic nie musi, a proces dalej mieli. Czekanie, przerwanie i błąd zostają sobą, jak na liście.
 * (`unsupported` listy to stan nadany przez dekoder klienta — serwer go nie zna.)
 */
const QUIET: readonly SessionState[] = ['waiting-input', 'done', 'resumable'];
const ELLIPSIS = '…';

/**
 * Kształt NAZWY skryptu workflow (`meta.name`, np. `review-changes`): litery, cyfry, `.`, `_`, `-`, bez
 * spacji. `BackgroundTask.description` bierze najpierw `result.description`, a dopiero potem
 * `workflowName`, a wywołanie `Workflow` ma własne pole `description` (`herdr/background/reducer.ts`) —
 * opis zdaniem nie przejdzie, kafel napisze wtedy po prostu „workflow".
 */
const WORKFLOW_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/** Jedna linia bez znaków sterujących — nazwy z dysku i z tytułów paneli nie są zaufane. */
function clean(text: string | undefined): string {
  return (text ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Sufit {@link LIVE_ACTIVITY_TEXT_MAX} z wielokropkiem na końcu. Liczy jednostki UTF-16 (tak liczy
 * `z.string().max()` kontraktu), ale tnie po skalarach Unicode — para zastępcza emoji nie rozpada się.
 */
function cap(text: string): string {
  if (text.length <= LIVE_ACTIVITY_TEXT_MAX) return text;
  let out = '';
  for (const scalar of text) {
    if (out.length + scalar.length > LIVE_ACTIVITY_TEXT_MAX - ELLIPSIS.length) break;
    out += scalar;
  }
  return out + ELLIPSIS;
}

/** Najstarszy `stateSince`; remis rozstrzyga id, żeby wybór był deterministyczny. */
function longest(sessions: readonly SessionSummary[]): SessionSummary | undefined {
  let best: SessionSummary | undefined;
  let bestAt = Infinity;
  for (const session of sessions) {
    const at = Date.parse(session.stateSince);
    const key = Number.isFinite(at) ? at : Infinity;
    if (best === undefined || key < bestAt || (key === bestAt && session.id < best.id)) {
      best = session;
      bestAt = key;
    }
  }
  return best;
}

/** Cel tapnięcia: sesja (albo terminal Raroga, w którym stoi agent) — nic, co kafel by pokazywał. */
function topOf(session: SessionSummary): Top {
  return {
    sessionId: session.id,
    ...(session.termId !== undefined && TERM_ID_RE.test(session.termId) ? { termId: session.termId } : {}),
  };
}

interface OpenRun {
  readonly session: SessionSummary;
  readonly task: BackgroundTask;
  readonly run: WorkflowRun;
  readonly startedMs: number;
}

const startedMs = (task: BackgroundTask): number => {
  const ms = task.startedAt === undefined ? Number.NaN : Date.parse(task.startedAt);
  return Number.isFinite(ms) ? ms : Infinity;
};

/**
 * Przebiegi z rozkładem, po jednym na (sesja, `runId`): wznowienie (`resumeFromRunId`) zakłada drugie
 * zadanie z tym samym `runId`, a driver dokleja obu ten sam `run` (`herdr/background/merge.ts`) — liczy się
 * późniejsze uruchomienie. Kolejność: start rosnąco (brak czasu na końcu), remis — `runId`, potem sesja.
 */
function openRuns(sessions: readonly SessionSummary[]): OpenRun[] {
  const byRun = new Map<string, OpenRun>();
  for (const session of sessions) {
    for (const { task, run } of workflowsWithRun(session.backgroundTasks)) {
      const key = `${session.id}\u0000${task.runId ?? task.id}`;
      const candidate: OpenRun = { session, task, run, startedMs: startedMs(task) };
      const seen = byRun.get(key);
      if (seen === undefined || (candidate.startedMs > seen.startedMs && candidate.startedMs !== Infinity)) {
        byRun.set(key, candidate);
      }
    }
  }
  return [...byRun.values()].sort((a, b) => {
    if (a.startedMs !== b.startedMs) return a.startedMs < b.startedMs ? -1 : 1;
    const runA = a.task.runId ?? a.task.id;
    const runB = b.task.runId ?? b.task.id;
    if (runA !== runB) return runA < runB ? -1 : 1;
    return a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0;
  });
}

const percentOf = (done: number, agents: number): number => (agents > 0 ? Math.round((done / agents) * 100) : 0);

/**
 * Stan fazy z jej liczników, niezależnie od fazy bieżącej i od zaokrąglonego
 * procentu: nikt nie ruszył → `pending`, ktoś jeszcze pracuje → `running`, wszyscy skończyli → `done`.
 * Kilka faz bywa naraz w pracy, a skończona faza z nowym agentem wraca do `running`.
 */
const stateOf = ({ agents, done }: { agents: number; done: number }): PhaseState =>
  agents === 0 ? 'pending' : done < agents ? 'running' : 'done';

/**
 * Przebieg → wpis kafla: projekt, nazwa skryptu, agenci i pasek z segmentem na fazę planu. Stan faz
 * (`states`) stoi tylko przy planie, razem z `phase`; przebieg bez planu ma sam segment całości.
 */
function workflowOf({ session, task, run }: OpenRun): Workflow {
  const project = cap(clean(session.title) || clean(session.cwd.split('/').pop()) || '?');
  const raw = clean(task.description);
  const name = WORKFLOW_NAME.test(raw) ? cap(raw) : 'workflow';
  const agents = run.agents.length;
  const done = run.agents.filter((agent) => agent.done).length;
  // Fazy tylko z PLANU (`meta.phases`): fazy z samych tagów mają rosnący mianownik („faza 2/2" → „3/3"),
  // co na ekranie blokady wygląda jak błąd.
  const planned = run.phases.length > 0 && run.phases.length <= LIVE_ACTIVITY_SEGMENTS_MAX;
  const counts = planned ? phaseCounts(run) : null;
  const current = counts === null ? null : currentPhase(counts);
  if (counts === null || current === null) {
    return { sessionId: session.id, project, name, agents, done, segments: [percentOf(done, agents)] };
  }
  return {
    sessionId: session.id, project, name, agents, done,
    phase: { index: current.index + 1, count: counts.length, title: cap(clean(current.title)) },
    segments: counts.map((phase) => percentOf(phase.done, phase.agents)),
    states: counts.map(stateOf),
  };
}

/** Lista sesji → stan treści aktywności (kolejność kluczy = kolejność w kontrakcie). */
export function aggregateState(
  sessions: readonly SessionSummary[], nowMs: number, extras: LiveActivityExtras = {},
): LiveActivityContentState {
  const nowSec = Math.floor(nowMs / 1000);
  const waiting = sessions.filter((s) => WAITING.includes(s.state));
  const working = sessions.filter((s) => WORKING.includes(s.state));
  // A session after a turn whose subagent is stuck on its own command waits for the owner: it counts once, as waiting.
  const stuck = sessions.filter((s) => stuckWait(s.state, s.backgroundTasks));
  const background = sessions.filter((s) => QUIET.includes(s.state) && !stuck.includes(s)
    && hasBackgroundWork(s.backgroundTasks));
  const finished = sessions.filter(
    (s) => s.state === 'waiting-input' && s.seen !== true && !stuck.includes(s) && !hasBackgroundWork(s.backgroundTasks),
  ).length;
  // Wiodąca bez zmian: sesja „w tle" nie jest celem tapnięcia — jej tura już się skończyła. The same holds for a
  // stuck session, so it is not a lead candidate.
  const lead = longest(waiting) ?? longest(working);
  const runs = openRuns(sessions);
  const workflows = runs.slice(0, LIVE_ACTIVITY_WORKFLOWS_MAX).map(workflowOf);
  const more = runs.length - workflows.length;
  const limits = extras.limits !== undefined && Object.keys(extras.limits).length > 0 ? extras.limits : undefined;
  const mac = extras.mac !== undefined && Object.keys(extras.mac).length > 0 ? extras.mac : undefined;
  return {
    waiting: waiting.length + stuck.length,
    working: working.length + background.length,
    finished,
    ...(lead === undefined ? {} : { top: topOf(lead) }),
    ...(workflows.length === 0 ? {} : { workflows }),
    ...(more > 0 ? { moreWorkflows: more } : {}),
    ...(limits === undefined ? {} : { limits: { ...limits } }),
    ...(mac === undefined ? {} : { mac: { ...mac } }),
    updatedEpoch: nowSec,
  };
}

/**
 * Klucz porównania TREŚCI: stan bez `updatedEpoch` i bez `mac`. Globalny event managera, który nie
 * zmienił niczego widocznego, daje ten sam klucz — i zero wysyłek. Obciążenie Maca zmienia się co
 * sekundę, więc jedzie wyłącznie z inną zmianą albo z heartbeatem.
 */
export function contentKey(state: LiveActivityContentState): string {
  const { updatedEpoch: _at, mac: _mac, ...content } = state;
  void _at;
  void _mac;
  return JSON.stringify(content);
}

/**
 * „Coś czeka, pracuje albo mieli w tle" — od końca takiego stanu liczy się zegar ciszy (30 min).
 *
 * Liczy się z SESJI, nie ze stanu kafla: otwarte zadanie workflow bez odczytanego rozkładu (`run`) na kaflu
 * nie stoi, a „nie wiem" nie może zakończyć aktywności. Przebieg z rozkładem trzyma kafel, dopóki
 * ma agenta w locie albo jeszcze żadnego (start); gdy wszyscy skończyli, już nie — inaczej zadanie bez
 * wpisu zamknięcia w jsonl (zabite CLI) trzymałoby kafel do systemowych 8 h.
 *
 * Inne zadania w tle kafla NIE trzymają, choć licznik „pracuje" je liczy: serwer deweloperski albo
 * monitor puszczony w tle mieli bez końca, a kafel ma zejść po 30 min bez decyzji, tury i workflow.
 */
export function isBusy(sessions: readonly SessionSummary[]): boolean {
  return sessions.some((session) => WAITING.includes(session.state) || WORKING.includes(session.state)
    || hasOpenWorkflow(session.backgroundTasks));
}
