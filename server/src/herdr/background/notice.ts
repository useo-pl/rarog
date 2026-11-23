/**
 * Notki harnessu Claude Code w transkrypcie — klasyfikacja po POCHODZENIU wpisu jsonl.
 *
 * Moduł katalogu zadań w tle (mapa modułów: `index.ts`, opis całości: `docs/background-tasks.md`).
 *
 * CLI wstrzykuje do rozmowy wpis roli `user`, gdy kończy się zadanie w tle (komenda, subagent,
 * workflow, monitor) albo obserwacja artefaktu (rodzaj `artifact-watch`). To jedyny techniczny
 * sposób, w jaki tło może obudzić agenta — ale nikt tego nie napisał. Klient natywny nie ma
 * prawa znać tekstów CLI.
 *
 * Bramką jest pole `origin.kind === "task-notification"` wpisu (zmierzone w magazynie CLI
 * tego konta: każdy wpis notki je ma, część z dodatkowym `producer: "session-task"`, a prompty
 * człowieka niosą `origin.kind === "human"` albo nic). Prompt człowieka, który zawiera
 * znacznik w treści, tego pola nie ma i zostaje zwykłą wiadomością — bezpieczny kierunek: wpis bez
 * `origin` to surowy tekst. Szczegóły (rodzaj, wynik, nazwa, kod wyjścia) czytamy
 * z treści.
 * Tekst meldunku rozkłada `notification.ts` (jedyny parser); tu zostaje ZNACZENIE pól dla notki.
 * Jeden wynik nie pochodzi z samego statusu: POSTÓJ subagenta. CLI melduje go
 * jako `completed`, a notka mówi `waiting`, bo agent nie skończył — pytanie „czy to postój"
 * zadaje temu samemu parserowi co reduktor zadań, więc TREŚĆ meldunku lista i notka czytają tak
 * samo. Reduktor ma ponadto warunki listy (czas wpisu, rodzaj otwartego zadania), których notka
 * nie zna; opis: `docs/background-tasks.md`, „Notice in the transcript".
 * Słowa CLI (wartość `origin.kind`, początki streszczenia, statusy) stoją w `cli-shapes.ts`.
 *
 * Moduł jest CZYSTY: ten sam wynik dla ścieżki na żywo (follower jsonl, linia po linii) i dla
 * historii (`parseTranscriptTail`), bo obie przechodzą przez `parseImportLine`.
 */
import type { NoticeKind, NoticeOutcome, TranscriptNotice } from '@rarog/shared';
import { CLI_SHAPES, literalSource } from './cli-shapes.ts';
import { isAgentStandby, parseTaskNotification } from './notification.ts';
import type { TaskNotification } from './notification.ts';

/** Wartość `origin.kind` wpisu jsonl, którą CLI znakuje notkę o zadaniu w tle. */
export const TASK_NOTIFICATION_ORIGIN = CLI_SHAPES.notificationOrigin.literals.kind;

/** Ile znaków nazwy zadania jedzie w notce — tyle, co mieścił dymek dawnej PWA (`TASK_NAME_MAX`). */
export const NOTICE_NAME_MAX = 80;

/** Czy `origin` wpisu jsonl znaczy „notka o zadaniu w tle"? Każdy inny kształt = nie. */
export function isTaskNotificationOrigin(origin: unknown): boolean {
  return typeof origin === 'object' && origin !== null
    && (origin as { kind?: unknown }).kind === TASK_NOTIFICATION_ORIGIN;
}

const KINDS = CLI_SHAPES.summaryKinds.literals;
const STATUSES = CLI_SHAPES.terminalStatuses.literals;
const ARTIFACT_WATCH = CLI_SHAPES.artifactWatch.literals.lifecycle;

/** Wzorzec „streszczenie ZACZYNA SIĘ od któregoś z `words` jako całego słowa" (granica `\b`). */
function wordStart(words: readonly string[]): RegExp {
  return new RegExp(`^(?:${words.map(literalSource).join('|')})\\b`);
}

const MONITOR_END = wordStart([KINDS.monitorEnd]);
const COMMAND = wordStart([KINDS.command]);
const WORKFLOW = wordStart(KINDS.workflow);

/**
 * Rodzaj z POCZĄTKU `<summary>` (jak w dawnej PWA). Kolejność ma znaczenie:
 * „Monitor event" przed „Monitor", bo drugi wzorzec połknąłby pierwszy, a małe „agent" to sierota
 * po padzie CLI meldująca się jako „Background agent …". Fraza sieroty po powłokach jest szukana
 * GDZIEKOLWIEK w streszczeniu, więc stoi na końcu: nazwa zadania to tekst modelu i potrafi tę frazę
 * powtórzyć, a `Agent "Analiza background shell command task(s)" finished` to agent. Jako sierota
 * traciłby wynik `waiting`, choć lista pokazuje go w postoju. Zbiorczy
 * meldunek o sierotach zaczyna się od liczby, nie od słowa któregoś rodzaju.
 *
 * Trzy sposoby dopasowania, każdy taki jak przed rejestrem: sam początek (sierota, zdarzenie
 * monitora), gdziekolwiek w streszczeniu (sierota po powłokach) i początek jako całe słowo
 * (`wordStart` — „Monitors" ani „Agents" rodzaju nie dają). Czy streszczenie zaczyna się jak
 * meldunek agenta, mówi parser (`TaskNotification.agent`): tę samą odpowiedź bierze reduktor.
 *
 * Meldunek o końcu obserwacji ARTEFAKTU rozpoznaje się przed streszczeniem, po `<task-type>`:
 * to jedyny meldunek z tym znacznikiem, a jego streszczenie (`Stopped watching Artifact: "…"`) nie
 * zaczyna się od słowa żadnego rodzaju zadania. Każdy wariant (usunięty, publiczny, zmiana konta) to
 * ten sam rodzaj; czy artefakt jest usunięty, rozstrzyga lista (`artifacts.ts`), nie notka.
 */
function noticeKind({ summary, agent, taskType }: TaskNotification): NoticeKind {
  if (taskType === ARTIFACT_WATCH) return 'artifact-watch';
  if (summary.startsWith(KINDS.orphanStart)) return 'orphan';
  if (summary.startsWith(KINDS.monitorEvent)) return 'monitor-event';
  if (MONITOR_END.test(summary)) return 'monitor-end';
  if (COMMAND.test(summary)) return 'command';
  if (WORKFLOW.test(summary)) return 'workflow';
  if (agent) return 'agent';
  if (summary.includes(KINDS.orphanShells)) return 'orphan';
  return 'unknown';
}

/**
 * Wynik ze `<status>`, nigdy z czasownika streszczenia (mapowanie między nimi jest przewrotne:
 * `killed` chodzi z „was stopped"). Sierota nie ma wyniku: jej `stopped` to przyznanie się CLI
 * do niewiedzy (`UNKNOWN_FATE` w `reducer.ts`), nie meldunek o zatrzymaniu.
 *
 * Jedyny wyjątek od „wyłącznie ze statusu": postój subagenta. Status mówi `completed`, a dopisek
 * meldunku, że agent tylko stanął i czeka na własną komendę w tle — to `waiting`, nie `done`.
 * Wynik dostaje WYŁĄCZNIE notka rodzaju `agent`: streszczenie, którego rodzaju nie znamy, nie
 * ma prawa udawać postoju subagenta.
 *
 * Koniec obserwacji artefaktu wyniku nie ma: to nie zadanie i meldunek nie niesie `<status>`.
 */
function noticeOutcome(kind: NoticeKind, notification: TaskNotification): NoticeOutcome | undefined {
  const { status } = notification;
  if (kind === 'orphan' || kind === 'artifact-watch') return undefined;
  if (kind === 'agent' && isAgentStandby(notification)) return 'waiting';
  if (status === STATUSES.completed) return 'done';
  if (status === STATUSES.failed) return 'failed';
  if (status === STATUSES.killed || status === STATUSES.stopped) return 'halted';
  return undefined;
}

/**
 * Nazwa zadania przycięta do {@link NOTICE_NAME_MAX}. Sufit liczony w punktach kodowych: `slice`
 * po jednostkach UTF-16 rozcinał parę zastępczą emoji i oddawał JSON, którego Swift nie dekoduje.
 */
function cappedName(name: string): string {
  const chars = Array.from(name);
  if (chars.length <= NOTICE_NAME_MAX) return name;
  return `${chars.slice(0, NOTICE_NAME_MAX - 1).join('')}…`;
}

/** Treść notki → fakty do jednego zdania klienta. Kształt spoza tabeli = `kind: 'unknown'`. */
export function noticeFromText(text: string): TranscriptNotice {
  const parsed = parseTaskNotification(text);
  const kind = noticeKind(parsed);
  const notice: TranscriptNotice = { kind };
  const outcome = noticeOutcome(kind, parsed);
  if (outcome !== undefined) notice.outcome = outcome;
  const name = cappedName(parsed.name);
  if (name !== '') notice.name = name;
  if (parsed.exitCode !== undefined) notice.exitCode = parsed.exitCode;
  return notice;
}
