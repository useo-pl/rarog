/**
 * Zadania puszczone W TLE, czytane z tego samego pliku jsonl, który follower i tak przewija.
 *
 * Moduł katalogu zadań w tle (mapa modułów: `index.ts`, opis całości: `docs/background-tasks.md`).
 *
 * Moduł jest CZYSTY: bez I/O, bez zegara, bez logów — dokładnie jak `jsonl-pending.ts`, którego
 * kształt tu powtarzamy (reduktor `note(entry)` + getter stanu). Okno wejściowe wyznacza wołający.
 * Strażnika kształtu `wf_<id>` (`isRunId`) importuje z czystego `ids.ts`.
 * Nazwy pól i teksty CLI, o których mowa niżej, stoją w rejestrze `cli-shapes.ts`; tu zostaje
 * ogólny format wpisu transkryptu (`type`, `message.content`, bloki `tool_use`/`tool_result`).
 *
 * Pomiar, na którym stoi cała reguła (na realnych transkryptach tego konta):
 *
 * - **start** siedzi we wpisie `user` w polu `toolUseResult` na NAJWYŻSZYM poziomie, obok bloku
 *   `tool_result` z `tool_use_id` — w tym samym wpisie. Kształt pola rozróżnia rodzaj bez ani
 *   jednego odczytu z dysku: `backgroundTaskId` → komenda, `agentId` → subagent,
 *   `taskId` + `taskType: "local_workflow"` → workflow;
 * - **koniec** przychodzi jako `<task-notification>` w kilku wpisach naraz
 *   (`queue-operation` ×2, `attachment`, `user` ze stringiem) — dedup jest obowiązkowy, a nie
 *   ostrożnościowy. Dedup idzie po TREŚCI meldunku, nie po `task-id` (niżej);
 * - koniec przychodzi TAKŻE bez powiadomienia — gdy główny agent odebrał wynik narzędziem
 *   `TaskOutput` (narzędzie usunięte w CLI 2.1.277, docs `agent-sdk/typescript.md`,
 *   „TaskOutput”, więc dotyczy plików sprzed tej wersji): wtedy jedynym śladem jest `toolUseResult`
 *   `{retrieval_status, task: {task_id, status}}` i to po nim zamykamy;
 * - zamykamy WYŁĄCZNIE na statusie terminalnym. Powiadomienie bez `<status>` istnieje
 *   (`Monitor event: "…"` niesie `<event>tick</event>`) i znaczy „zdarzenie", nie „koniec".
 *   Zamknięcie bez dowodu gasiłoby plakietkę nad procesem, który dalej mieli.
 *
 * Pomiar na transkryptach tego konta (54 starty subagentów, 40 workflow, 12 komend) — KTO i CZYM wykonuje zadanie stoi
 * w tych samych wpisach, więc kosztuje zero I/O:
 *
 * - `toolUseResult.resolvedModel` → model subagenta, już rozwiązany przez silnik
 *   (`claude-opus-5[1m]`, `claude-fable-5`); alias z wywołania bywa nieobecny — 48 z 52;
 * - `input.subagent_type` → podtyp (`Explore`, `general-purpose`, `fork`) — 37 z 52;
 * - `toolUseResult.summary` → zdanie o przebiegu workflow, obecne w 40 z 40;
 * - `input.until` → warunek monitora w ówczesnych plikach; bez niego wiersz monitora nie miał ŻADNEJ
 *   treści (dzisiejsze wejście `Monitor` niesie `description`, `cli-shapes.ts`, `taskWho`).
 *
 * Pomiar na CLI 2.1.295 i 2.1.296 (fixture'y `tasks/measured/` i wyciąg
 * `tasks/incydent-postoj-agenta-2.1.295.jsonl`) — subagent ma TRZY stany, nie dwa:
 *
 * - **postój**: subagent skończył turę, ale jego własna komenda w tle jeszcze leci. CLI melduje
 *   wtedy `completed`, a różnicę niesie wyłącznie dopisek `<note>` (rozpoznaje go
 *   `notification.ts`). Zamknięcie wpisu na samym `completed` schowałoby na godziny żywego agenta;
 * - **wznowienie**: główny agent napisał do subagenta (`SendMessage`), wynik narzędzia niesie
 *   `resumedAgentId` i `success: true`. Start z tym samym id już NIE wraca, więc to jedyny ślad;
 * - **kopie**: ten sam meldunek stoi w pliku 2–3 razy, kopie spóźniają się nawet o minutę
 *   i potrafią stanąć PO nowszym meldunku tego samego agenta albo po jego wznowieniu. Kopie są
 *   identyczne znak w znak, a dwa różne meldunki nigdy (0 z 888), więc dedup idzie po treści
 *   i pamięta WSZYSTKIE meldunki, nie ostatni. Nośnik `attachment` niesie przy tym czas
 *   pierwszej kopii, nie swój — sam `timestamp` wpisu kolejności nie rozstrzyga.
 *
 * Pomiar na CLI 2.1.296 (`tasks/measured/resume-cli.jsonl`) — subagent NIE PRZEŻYWA
 * restartu procesu CLI, a plik o tym milczy: po `/exit` z opcją „Exit and stop tasks" i po
 * `claude --resume` CLI zapisuje wyłącznie meldunek `killed` o KOMENDZIE subagenta. O samym
 * subagencie nie pisze nic, więc z pliku nie da się poznać, że agent w postoju już nie żyje.
 * Brakujący fakt przychodzi z zewnątrz ({@link BackgroundTasksTracker.processStarted}): chwila
 * startu procesu, który jako jedyny pisze tę rozmowę. Moduł zostaje czysty, bo tej chwili nie
 * mierzy, tylko ją dostaje. Inne końce procesu (zamknięty panel, restart bez „stop tasks”) są
 * niezmierzone, a docs agent-view („The supervisor process”) mówią, że pod supervisorem komendy
 * i subagenci w tle przechodzą do następnego procesu (`work.ts`, `tasksBlockRestart`).
 *
 * Czego ten moduł NIE robi: nie zagląda do `/private/tmp/.../tasks/` ani do
 * `subagents/agent-<id>.meta.json` (te same fakty za odczyt z dysku na zadanie i na ramkę),
 * nie ufa prefiksowi identyfikatora (monitor ma taki sam jak komenda) i nie zgaduje śmierci
 * procesu — zadanie bez powiadomienia wisi otwarte, bo rosnący licznik czasu jest jedynym
 * uczciwym sygnałem. Nie wie też, kiedy subagent w postoju sam ruszył: wybudzenie stoi w pliku
 * subagenta, którego ten moduł nie widzi. Wpis czeka do wznowienia, nowego meldunku albo końca.
 *
 * Ta sama maszyna czyta też plik SUBAGENTA (opcja `sidechain`, osobna instancja na plik; karmi
 * ją `agent-file.ts`): start własnej komendy subagenta ma tam ten sam kształt co start komendy
 * w pliku głównym, a jej koniec to meldunek we własnym pliku albo wynik `TaskStop`.
 */
import type { BackgroundTask, BackgroundTaskKind } from '@rarog/shared';
import { asRecord } from '../../drivers/tool-text.ts';
import { clipUnits } from '../../text.ts';
import { parseJsonlEntry } from '../jsonl-pending.ts';
import { CLI_SHAPES } from './cli-shapes.ts';
import {
  hasUnknownAgentNote, isAgentStandby, isTaskNotification, notificationFingerprint, parseTaskNotification,
} from './notification.ts';
import { isRunId } from './ids.ts';

/**
 * Ile znaków komendy wolno wysłać na telefon. Przy 200 znakach komenda agenta zaczęta od przypisań
 * zmiennych (`W=…; O=…; LOG=…; … bash "$W/…"`) kończyła się przed nazwą programu i apka nie miała z czego
 * złożyć skrótu do narzędzi. Komenda głównego agenta i tak stoi w transkrypcie w całości; dla własnych komend
 * subagenta (`ownTasks`) to jest granica tego, co z jego pliku opuszcza Maca (`docs/security-model.md`).
 */
export const TASK_COMMAND_MAX = 1000;

/**
 * Sufit mapy wywołań czekających na wynik; ponad nim wypada NAJSTARSZE.
 *
 * W pliku głównym mapa kurczy się sama, bo każdy wynik zdejmuje swoje wywołanie. Czytnik pliku
 * subagenta podaje reduktorowi tylko linie, które mogą nieść start albo koniec zadania, więc wynik
 * zwykłej komendy `Bash` do niego nie dociera, a jej wywołanie zostałoby w mapie na zawsze. Wynik
 * startu w tle stoi zaraz po swoim wywołaniu, a równoległych wywołań w jednej wypowiedzi jest
 * kilkanaście, więc 256 najnowszych wystarcza z dużym zapasem.
 */
export const PENDING_CALLS_MAX = 256;

/**
 * Ile znaków streszczenia workflow jedzie na telefon.
 *
 * Krócej niż komenda, bo to zdanie do CZYTANIA w wąskim panelu, a nie tekst do skopiowania:
 * powyżej dwóch linijek i tak zostaje z niego wielokropek, a każde zadanie w tle jedzie
 * w KAŻDEJ ramce snapshotu.
 */
export const TASK_SUMMARY_MAX = 120;

// Literały CLI pod krótkimi nazwami — wartości i pomiary stoją w rejestrze `cli-shapes.ts`.
const CARRIERS = CLI_SHAPES.notificationCarriers.literals;
const STATUSES = CLI_SHAPES.terminalStatuses.literals;
const START = CLI_SHAPES.taskStart.literals;
const RESUME = CLI_SHAPES.agentResume.literals;
const DESCRIPTION = CLI_SHAPES.taskDescription.literals;
const WHO = CLI_SHAPES.taskWho.literals;
const SKILL = CLI_SHAPES.skillFork.literals;
const FOREGROUND = CLI_SHAPES.foregroundEnd.literals;
const STOP = CLI_SHAPES.taskStop.literals;
const OUTPUT = CLI_SHAPES.taskOutput.literals;
const MONITOR_TOOL = CLI_SHAPES.monitorTool.literals.tool;
const MONITOR_START = CLI_SHAPES.monitorStart.literals;
const TOOL_RESULT = CLI_SHAPES.toolResult.literals.field;

/**
 * Najdłuższy termin monitora (ms). Opis narzędzia `Monitor` w CLI 2.1.296: „Deadlines above 1800000ms are
 * capped to 1800000ms". Monitor bez czytelnego terminu liczymy tym sufitem: w liście zadań (reguła 11) i w
 * czytniku pliku subagenta (`agent-file.ts`, termin innych własnych zadań agenta).
 */
export const MONITOR_MAX_MS = 30 * 60_000;
const RUN_ID = CLI_SHAPES.workflowRun.literals.runId;

/**
 * Narzędzia, po których MOŻE powstać zadanie w tle — reszta wywołań nas nie interesuje i nie ma
 * po co siedzieć w mapie oczekujących. `Monitor` jest tu, bo nazwa narzędzia jest jedynym miejscem,
 * z którego da się poznać rodzaj: start ze starszych plików wygląda jak komenda (`backgroundTaskId`),
 * a dzisiejszy (`{persistent, taskId, timeoutMs}`, reguła 11) bez wywołania nie mówi, czym jest.
 *
 * Eksportowane dla prefiltra przeglądu pliku głównego (`main-scan.ts`): linia z wywołaniem
 * narzędzia spoza tej listy niczego w reduktorze nie zmienia, więc nie musi być parsowana.
 */
export const TASK_TOOLS: readonly string[] = [
  ...Object.values(CLI_SHAPES.taskTools.literals), MONITOR_TOOL, SKILL.tool,
];

/** Statusy, po których zadanie NA PEWNO nie żyje. Wszystko inne = żyje dalej (fail-open). */
const TERMINAL_STATUSES: readonly string[] = Object.values(STATUSES);

/**
 * `stopped`, które NIE jest dowodem (sesja wznowiona przy żywym workflow):
 * po wznowieniu procesu Claude Code silnik dopisuje do transkryptu powiadomienie
 * `<status>stopped</status>` ze streszczeniem „No completion record was found for background
 * workflow … It may have been stopped …, or it may have been running when the previous
 * Claude Code process exited". To przyznanie się do niewiedzy, nie meldunek o śmierci — przebieg
 * w `subagents/workflows/wf_…/` dalej pisał journal. Gaszenie karty po takim wpisie zabierało
 * `runId`, a z nim cały rozkład faz (`merge.ts` czyta go WYŁĄCZNIE z otwartych
 * zadań). Prawdziwy koniec i tak przyjdzie: `completed`/`failed` albo wynik `TaskStop`.
 *
 * Wyjątek od wyjątku: SUBAGENT. Agent żyje w procesie CLI, więc po końcu procesu nie ma kto
 * dopisać jego prawdziwego końca — sierota agenta zamyka wpis (dla workflow i komend reguła
 * zostaje, ich proces bywa osobny).
 */
const UNKNOWN_FATE = CLI_SHAPES.unknownFate.literals.sentence;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Bloki treści wpisu; nie-tablica = brak bloków (ta sama pomocnicza co w `jsonl-pending.ts`). */
function blocksOf(entry: Record<string, unknown>): readonly Record<string, unknown>[] {
  const message = asRecord(entry['message']);
  const content = message === null ? null : message['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Record<string, unknown>[] => {
    const block = asRecord(item);
    return block === null ? [] : [block];
  });
}

/** Wywołanie narzędzia czekające na swój wynik — źródło opisu i komendy dla zadania. */
interface PendingCall {
  toolName: string;
  description: string;
  command: string;
  /** `subagent_type` — jedyne miejsce, gdzie stoi podtyp subagenta; wynik go NIE niesie. */
  agentType: string;
}

/**
 * Opis wyciągnięty z WYWOŁANIA, gdy narzędzie nie ma pola `description`.
 *
 * Dwa narzędzia, dwa powody:
 *
 * - `Monitor` ze starszych plików (wersja CLI nieznana): wejściem był sam warunek
 *   `until` („review agent completes"), więc bez tej gałęzi wiersz monitora pokazywałby myślnik —
 *   plakietka mówiłaby, że coś czeka, a nie NA CO. Zdanie warunku jest tu całym opisem zadania.
 *   Dzisiejsze wejście niesie `description` (docs `agent-sdk/typescript.md`, „Monitor”; fixture'y
 *   `tasks/incydent-gotowe-po-postoju-2.1.301/subagents/`), więc pierwsza gałąź wyżej je bierze.
 * - `Skill` puszczony w tle (CLI 2.1.258, `/code-review 35 high`): wejściem
 *   jest `{skill, args}`, a wynik niesie `agentId` jak zwykły subagent, ale bez `description`.
 *   Bez tej gałęzi karta mówiła „subagent —". Opis składamy tak, jak CLI zapisuje go
 *   w `subagents/agent-<id>.meta.json`: `/<skill> <args>` — to samo, co człowiek wpisałby
 *   w wierszu poleceń. Starszy kształt CLI to fork skilla jako `Agent` z własnym opisem;
 *   tamta gałąź działa dalej, ta obsługuje nowy kształt.
 */
function callDescription(toolName: string, input: Record<string, unknown> | null): string {
  if (input === null) return '';
  const own = asText(input[DESCRIPTION.description]);
  if (own !== '') return own;
  if (toolName === MONITOR_TOOL) return asText(input[WHO.until]);
  if (toolName === SKILL.tool) return skillDescription(input);
  return '';
}

/** `/<skill> <args>` — z pustych `args` zostaje sam `/<skill>`; bez `skill` nie ma opisu. */
function skillDescription(input: Record<string, unknown>): string {
  const skill = asText(input[SKILL.skill]).trim();
  if (skill === '') return '';
  const args = asText(input[SKILL.args]).trim();
  return args === '' ? `/${skill}` : `/${skill} ${args}`;
}

/**
 * Kształt `toolUseResult` → rodzaj i identyfikator zadania; `null` = to nie jest start w tle.
 *
 * Kolejność testów odpowiada pewności pomiaru: `agentId` i `taskType` są jednoznaczne,
 * `backgroundTaskId` niesie i komenda, i (zakładamy) monitor — dlatego rodzaj dla niego
 * doprecyzowuje dopiero nazwa narzędzia.
 */
function startOf(result: Record<string, unknown>): { id: string; kind: BackgroundTaskKind } | null {
  const agentId = asText(result[START.agentId]);
  if (agentId !== '') return { id: agentId, kind: 'agent' };
  const taskId = asText(result[START.taskId]);
  if (taskId !== '' && asText(result[START.taskType]) !== '') return { id: taskId, kind: 'workflow' };
  const backgroundId = asText(result[START.backgroundTaskId]);
  if (backgroundId !== '') return { id: backgroundId, kind: 'command' };
  return null;
}

/**
 * Termin monitora z wyniku startu w kształcie CLI 2.1.319 (`{persistent, taskId, timeoutMs}`); `null` = to nie
 * jest taki start. Wynik musi być sparowany z wywołaniem `Monitor`: ten sam `taskId` bez `taskType` niesie tylko
 * ten wynik, ale bez wywołania nie wiadomo, czy to monitor.
 *
 * `span` to czas życia w ms; `null` = monitor trwały (`persistent: true`), który zamyka dopiero meldunek,
 * `TaskStop` albo nowy proces CLI. `timeoutMs` inne niż skończona liczba nieujemna znaczy sufit narzędzia.
 */
function monitorStartOf(
  result: Record<string, unknown>, call: PendingCall | undefined,
): { id: string; span: number | null } | null {
  if (call?.toolName !== MONITOR_TOOL) return null;
  const id = asText(result[START.taskId]);
  if (id === '' || asText(result[START.taskType]) !== '') return null;
  if (!(MONITOR_START.timeoutMs in result) && !(MONITOR_START.persistent in result)) return null;
  if (result[MONITOR_START.persistent] === true) return { id, span: null };
  const timeout = result[MONITOR_START.timeoutMs];
  const readable = typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0;
  return { id, span: readable ? timeout : MONITOR_MAX_MS };
}

/**
 * Opis dla człowieka — najpierw to, co silnik podał sam, potem to, co obiecał przy wywołaniu.
 *
 * Ostatnia deska to `commandName` z wyniku forka skilla: gdy wywołanie wypadło z okna ogona
 * (start sprzed `/resume`), wynik sam jeszcze mówi, KTÓRY skill leci — argumentów już nie,
 * ale `/code-review` jest lepsze od myślnika.
 */
function describe(result: Record<string, unknown>, call: PendingCall | undefined): string {
  const own = asText(result[DESCRIPTION.description]);
  if (own !== '') return own;
  const workflow = asText(result[DESCRIPTION.workflowName]);
  if (workflow !== '') return workflow;
  const fromCall = call?.description ?? '';
  if (fromCall !== '') return fromCall;
  const command = asText(result[SKILL.commandName]).trim();
  return command === '' ? '' : `/${command}`;
}

/** Opcje reduktora; bez nich czyta plik główny rozmowy. */
export interface BackgroundTasksTrackerOptions {
  /**
   * Reduktor czyta plik SUBAGENTA, nie plik główny. Każdy wpis takiego pliku ma
   * `isSidechain: true`, więc bramka z reguły 4 odcięłaby go w całości; z tą opcją jej nie ma.
   * Reszta reguł jest ta sama.
   */
  readonly sidechain?: boolean;
}

export interface BackgroundTasksTracker {
  /** Skarmia JEDEN sparsowany wpis (wynik `parseJsonlEntry`). */
  note(entry: unknown): void;
  /**
   * Koniec zadania znany SPOZA tego pliku. Własna komenda subagenta kończy się czasem tylko
   * meldunkiem w kolejce pliku głównego, którego reduktor pliku subagenta nigdy nie zobaczy;
   * czytnik podaje wtedy jej id tutaj, żeby zamknięta komenda nie stała w liście otwartych
   * do końca życia agenta. Działa jak każdy inny koniec (reguły 2 i 3).
   */
  end(id: string): void;
  /**
   * Proces CLI, który JAKO JEDYNY pisze tę rozmowę, wystartował o `atMs` (milisekundy epoki).
   * Subagent żyje w procesie CLI, więc agent, którego ostatni dowód życia jest starszy niż ta
   * chwila, należał do poprzedniego procesu i już nie żyje: wpis znika (reguła 10). Chwilę
   * reduktor pamięta i stosuje także do wpisów, które przeczyta później, więc kolejność
   * „najpierw sygnał, potem historia pliku" daje ten sam wynik co odwrotna.
   *
   * Wołający podaje ją tylko wtedy, gdy ją ZNA (rejestr procesów CLI, dokładnie jeden żywy proces
   * rozmowy). Bez wywołania reguły nie ma. Ta sama chwila zamyka monitor ze startem w kształcie CLI 2.1.319
   * (reguła 12). Komend, workflow i monitorów ze starszych plików (`backgroundTaskId`) nie dotyczy.
   */
  processStarted(atMs: number): void;
  /**
   * Zegar terminów monitorów (reguła 11): zamyka monitor nietrwały, którego termin (start plus `timeoutMs`) minął
   * przed `nowMs` albo równo z nim. Moduł zegara nie ma, więc chwilę podaje wołający: czytnik pliku głównego po
   * każdym wpisie i na swoim tyknięciu, bo wygaśnięcie monitora nie zostawia w pliku żadnej linii. Monitor, którego
   * start nie miał `timestamp`, dostaje przy pierwszym wywołaniu tę chwilę jako swój start.
   */
  expire(nowMs: number): void;
  /**
   * Zadania OTWARTE, w kolejności pierwszego otwarcia. Pusto = nic nie leci (albo nic nie
   * widzieliśmy). Subagent w postoju stoi tu z `waitingSince`.
   *
   * Obiekt zadania NIGDY nie zmienia się w miejscu: zmiana stanu podmienia go na nowy. Lista
   * jedzie stąd przez followera i driver aż do sesji przez referencję, więc mutacja zmieniłaby
   * ramkę, która już wyszła.
   */
  readonly tasks: readonly BackgroundTask[];
  /**
   * Ile RÓŻNYCH meldunków agenta niosło dopisek `<note>`, którego nie znamy (kopie się nie
   * liczą). Każdy taki meldunek został policzony jak koniec. Moduł nie loguje; wołający zostawia
   * po niezerowej wartości jedną linię, bo to jedyny sygnał, że CLI zmieniło zdanie o postoju.
   */
  readonly unknownAgentNotes: number;
  /**
   * Identyfikatory zamknięte BEZ STARTU w tym pliku, w kolejności zamknięcia, każdy raz. Lista
   * tylko rośnie (do zerowania reduktora); wołający bierze z niej przyrost po długości.
   *
   * W pliku głównym to przede wszystkim końce WŁASNYCH komend subagentów: komendę wystartował
   * subagent (start stoi w jego pliku), a meldunek o jej końcu przechodzi przez kolejkę pliku
   * głównego. Trafia tu też koniec zadania sprzed okna ogona. Reduktor nie wie, czyje to id.
   */
  readonly unstartedEnds: readonly string[];
  /**
   * `timestamp` PIERWSZEGO wpisu, jaki ten reduktor dostał od swojego założenia; `''` = żadnego
   * z czasem. Od tej chwili reduktor widział wszystko, co stało w pliku, więc koniec zadania
   * wystartowanego później nie mógł go ominąć; o zadaniach wcześniejszych tego nie wiadomo.
   *
   * Załącznik (`attachment`) się nie liczy: niesie czas pierwszej kopii meldunku, czyli chwilę
   * sprzed swojego zapisu, a reduktor zaczął patrzeć dopiero od zapisu.
   */
  readonly firstEntryAt: string;
}

/**
 * Tworzy tracker zadań w tle.
 *
 * Reguły, każda z powodu:
 *
 * 1. **Mapa oczekujących wywołań kurczy się.** Wpis `tool_use` żyje w niej do sparowania
 *    i wtedy WYPADA — inaczej długa sesja trzymałaby w pamięci każdą komendę, jaką agent
 *    kiedykolwiek uruchomił (`jsonl-pending.ts` może trzymać `settled` bez końca, bo to same
 *    stringi; tu wisiałyby całe treści komend). Wywołanie, którego wynik nigdy nie przyszedł,
 *    wypada, gdy mapa przekroczy `PENDING_CALLS_MAX`.
 * 2. **Start jest idempotentny.** Id już otwarte albo już rozliczone nie zakłada drugiej karty.
 * 3. **Zamknięcie bez startu** (zadanie sprzed okna ogona, własna komenda subagenta) zapisuje id
 *    jako rozliczone i oddaje je RAZ w `unstartedEnds`. Duch nie powstaje, a spóźniona notyfikacja
 *    nie ma czego gasić. Lista zadań się nie zmienia; koniec wychodzi na zewnątrz osobno, bo
 *    własną komendę subagenta zna dopiero czytnik jego pliku.
 * 4. **`isSidechain === true` odpada** — podagent pisze do WŁASNEGO pliku; w głównym takich
 *    wpisów nie ma, bramka jest pasem bezpieczeństwa (ta sama co w trackerze zgód). Instancja
 *    czytająca plik subagenta (`sidechain`) tej bramki nie ma.
 * 5. **Postój nie zamyka.** Meldunek agenta ze statusem `completed` i dopiskiem o postoju
 *    zostawia wpis otwarty i ustawia `waitingSince` na czas wpisu, który niósł pierwszą kopię.
 *    Postój agenta zamkniętego albo nieznanego OTWIERA wpis jako czekający: skoro stanął
 *    z własną pracą w tle, to żyje, a jego startu albo wznowienia nie widzieliśmy.
 * 6. **Wznowienie otwiera.** `resumedAgentId` z `success: true` zdejmuje `waitingSince`,
 *    a wpis zamknięty otwiera na nowo z zapamiętanych danych startu. To jedyna droga powrotu
 *    agenta po końcu — reguła 2 dalej ignoruje start rozliczonego id.
 * 7. **Kopia meldunku nie robi nic.** Reduktor pamięta odciski wszystkich przetworzonych
 *    meldunków ze statusem końcowym (do swojego zerowania) i pomija każdą kopię — także taką,
 *    która stoi po nowszym meldunku albo po wznowieniu. `waitingSince` nigdy się nie cofa.
 * 8. **Agent sprzed okna** (start niewidziany) dostaje wpis minimalny: `id`, rodzaj `agent`
 *    i opis z cudzysłowu streszczenia, gdy jakiś meldunek go podał. Bez `startedAt`.
 * 9. **Bez mutacji w miejscu.** Każda zmiana stanu zadania podmienia obiekt na nowy.
 * 10. **Agent nie przeżywa restartu procesu CLI.** Gdy znamy chwilę startu procesu
 *    (`processStarted`), zamykamy każde otwarte zadanie rodzaju `agent`, którego ostatni DOWÓD
 *    ŻYCIA jest od niej starszy. Dowód życia to najpóźniejszy ze znanych czasów: startu,
 *    wznowienia i postoju. Agent bez znanego czasu zostaje: start albo wznowienie we wpisie bez
 *    `timestamp` (CLI takich nie pisze) nie mówi, po której stronie restartu stoi. Tak zamknięty
 *    agent wraca zwykłą drogą: wznowieniem albo postojem z czasem po starcie procesu (reguły 5
 *    i 6). Komend i workflow reguła nie rusza: komendy zamyka meldunek `killed`, a przebieg workflow
 *    bywa osobnym procesem. Monitory ma reguła 12.
 * 11. **Monitor ma termin**. Start w kształcie CLI 2.1.319 (`{persistent, taskId, timeoutMs}`
 *    po wywołaniu `Monitor`) otwiera zadanie `monitor` o kluczu `taskId`. Nietrwały (`persistent`
 *    różne od `true`) żyje do `timestamp` startu plus `timeoutMs`, a przy nieczytelnym albo ujemnym
 *    `timeoutMs` do sufitu narzędzia ({@link MONITOR_MAX_MS}). Wygaśnięcie nie zostawia w pliku linii
 *    (zdarzenie `<event>` bez `<status>`), więc zamyka je zegar wołającego (`expire`). Trwały czeka na
 *    meldunek, `TaskStop` albo nowy proces CLI. Monitor ze starszych plików (`backgroundTaskId`)
 *    terminu nie ma, jak przed tą regułą.
 * 12. **Monitor nie przeżywa nowego procesu CLI.** Monitor z reguły 11, którego start jest starszy
 *    niż chwila z `processStarted`, znika. Start bez czasu liczy się od pierwszego `expire` po nim;
 *    do tej chwili reguła go nie rusza.
 */
export function createBackgroundTasksTracker(opts: BackgroundTasksTrackerOptions = {}): BackgroundTasksTracker {
  const sidechain = opts.sidechain === true;
  const calls = new Map<string, PendingCall>();
  const open: BackgroundTask[] = [];
  const settled = new Set<string>();
  /** Odciski przetworzonych meldunków ze statusem końcowym — po nich poznajemy kopie. */
  const seen = new Set<string>();
  /**
   * Co wiemy o subagencie niezależnie od tego, czy jest otwarty: dane startu (opis, podtyp,
   * model, `startedAt`) albo wpis minimalny agenta sprzed okna. BEZ stanu postoju — z tego
   * wznowienie i postój odtwarzają wpis zamknięty. Jeden mały obiekt na agenta sesji.
   */
  const agents = new Map<string, BackgroundTask>();
  /** Numer pierwszego otwarcia zadania: wpis otwarty ponownie wraca na swoje miejsce listy. */
  const order = new Map<string, number>();
  let unknownAgentNotes = 0;
  /** Id zamknięte bez startu (reguła 3), każde raz. */
  const unstartedEnds: string[] = [];
  let firstEntryAt = '';
  /**
   * Ostatni dowód życia agenta w ms epoki (reguła 10): najpóźniejszy ze znanych czasów startu,
   * wznowienia i postoju. Brak wpisu = czasu nie znamy. Zostaje po zamknięciu agenta, bo dowód
   * jest faktem o przeszłości; nowy dowód go przesuwa albo (bez czasu) kasuje.
   */
  const proofs = new Map<string, number>();
  /** Chwila startu jedynego procesu CLI tej rozmowy (ms epoki); `null` = nikt jej nie podał. */
  let processStartedAt: number | null = null;
  /**
   * Otwarte monitory z reguły 11: start w ms epoki (`null` = wpis bez czasu, do pierwszego `expire`) i czas życia
   * (`null` = trwały). Wpis znika razem z zadaniem.
   */
  const monitors = new Map<string, { startMs: number | null; span: number | null }>();

  const close = (id: string): void => {
    monitors.delete(id);
    const at = open.findIndex((task) => task.id === id);
    if (at !== -1) open.splice(at, 1);
    // Nigdy nieotwarte (`order` zna każde otwarcie) i zamykane pierwszy raz: koniec bez startu.
    else if (!order.has(id) && !settled.has(id)) unstartedEnds.push(id);
    settled.add(id);
  };

  /** Reguła 12 dla jednego monitora: start starszy niż start procesu CLI zamyka go. */
  const closeMonitorIfOutlived = (id: string): void => {
    const startMs = monitors.get(id)?.startMs ?? null;
    if (processStartedAt !== null && startMs !== null && startMs < processStartedAt) close(id);
  };

  /** Otwiera wpis na miejscu wynikającym z kolejności pierwszego otwarcia. */
  const insert = (task: BackgroundTask): void => {
    settled.delete(task.id);
    let rank = order.get(task.id);
    if (rank === undefined) {
      rank = order.size;
      order.set(task.id, rank);
    }
    const own = rank;
    const at = open.findIndex((other) => (order.get(other.id) ?? 0) > own);
    if (at === -1) open.push(task);
    else open.splice(at, 0, task);
  };

  /** Wpis agenta bez stanu postoju: zapamiętany albo minimalny (agent sprzed okna). */
  const agentBase = (id: string): BackgroundTask => {
    const known = agents.get(id);
    if (known !== undefined) return known;
    const minimal: BackgroundTask = { id, kind: 'agent' };
    agents.set(id, minimal);
    return minimal;
  };

  /**
   * Nazwa z cudzysłowu streszczenia jako opis agenta, którego startu nie widzieliśmy. Wpis ze
   * startu ma opis z wywołania i tego nie potrzebuje; wpis minimalny bez opisu dostaje go tu.
   */
  const learnAgentName = (id: string, name: string): void => {
    if (name === '') return;
    const known = agents.get(id);
    if (known?.description !== undefined) return;
    agents.set(id, { ...(known ?? { id, kind: 'agent' }), description: name });
    const at = open.findIndex((task) => task.id === id);
    const task = open[at];
    if (task !== undefined && task.description === undefined) open[at] = { ...task, description: name };
  };

  /**
   * Nowy dowód życia agenta: start, wznowienie albo postój we wpisie o czasie `at`. Znany czas
   * przesuwa dowód naprzód (nigdy wstecz: załącznik niesie czas pierwszej kopii meldunku).
   * Wpis bez czasu KASUJE dowód: agent żył później, niż wiemy, ale nie wiemy kiedy.
   */
  const prove = (id: string, at: string): void => {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) proofs.delete(id);
    else proofs.set(id, Math.max(ms, proofs.get(id) ?? -Infinity));
  };

  /**
   * Reguła 10 dla jednego agenta: zamyka go, gdy jego ostatni dowód życia jest starszy niż start
   * procesu CLI. Wołana po KAŻDYM nowym dowodzie, więc historia czytana po sygnale daje to samo
   * co sygnał po historii. Bez znanego startu procesu albo bez znanego dowodu nie robi nic.
   */
  const closeIfOutlived = (id: string): void => {
    if (processStartedAt === null) return;
    const proof = proofs.get(id);
    if (proof !== undefined && proof < processStartedAt) close(id);
  };

  /**
   * Postój agenta: wpis otwarty dostaje `waitingSince`, zamknięty albo nieznany otwiera się
   * jako czekający. Każda gałąź kładzie NOWY obiekt.
   */
  const standBy = (id: string, at: string): void => {
    const index = open.findIndex((task) => task.id === id);
    const task = open[index];
    // Czas CLI to ISO w UTC o stałej szerokości, więc porównanie napisów jest porównaniem czasu.
    if (task?.waitingSince !== undefined && at <= task.waitingSince) return;
    if (task === undefined) insert({ ...agentBase(id), waitingSince: at });
    else open[index] = { ...task, waitingSince: at };
    prove(id, at);
    closeIfOutlived(id);
  };

  /**
   * Wznowienie agenta: zdejmuje postój, a wpis zamknięty albo nieznany otwiera jako pracujący.
   *
   * @param at `timestamp` wpisu z wynikiem `SendMessage`; `''` = wpis go nie ma
   */
  const resume = (id: string, at: string): void => {
    const index = open.findIndex((task) => task.id === id);
    const task = open[index];
    // Id otwartego zadania innego rodzaju agentem nie jest: nic nie wznawiamy i niczego nie dowodzimy.
    if (task !== undefined && task.kind !== 'agent') return;
    if (task === undefined) {
      insert(agentBase(id));
    } else if (task.waitingSince !== undefined) {
      const working: BackgroundTask = { ...task };
      delete working.waitingSince;
      open[index] = working;
    }
    // Wznowienie jest dowodem życia także wtedy, gdy stanu nie zmienia (agent już pracował).
    prove(id, at);
    closeIfOutlived(id);
  };

  /**
   * Treść powiadomienia → zmiana stanu zadania. Nie-powiadomienie i brak statusu nie robią NIC.
   * Pola czyta `notification.ts` (ten sam parser, z którego bierze notka transkryptu).
   *
   * @param at `timestamp` wpisu, który niósł meldunek; `''` = wpis go nie ma
   */
  const noteNotification = (text: string, at: string): void => {
    if (!isTaskNotification(text)) return;
    const notification = parseTaskNotification(text);
    const { id, status, summary } = notification;
    if (id === '') return;
    if (!TERMINAL_STATUSES.includes(status)) return;
    // Zdarzenia monitora (bez statusu) odpadły wyżej: niczego nie zmieniają, a ich treść bywa
    // ta sama przy każdym tyknięciu, więc odcisków po nich nie trzymamy.
    const print = notificationFingerprint(text);
    if (seen.has(print)) return;
    seen.add(print);

    if (hasUnknownAgentNote(notification)) unknownAgentNotes += 1;
    if (notification.agent) learnAgentName(id, notification.name);

    const current = open.find((task) => task.id === id);
    if (status === STATUSES.stopped && summary.includes(UNKNOWN_FATE)) {
      if (current?.kind === 'agent') close(id);
      return;
    }
    /*
     * Postój wymaga CZASU: `waitingSince` jest jedynym sposobem, w jaki wpis mówi „czekam",
     * a wpis otwarty bez niego znaczyłby „pracuję". Meldunek bez `timestamp` (CLI takiego nie
     * pisze, zmierzone na 202 nośnikach) jest więc liczony jak koniec.
     * Tak samo postój pod id zadania, które agentem nie jest.
     */
    if (isAgentStandby(notification) && at !== '' && (current === undefined || current.kind === 'agent')) {
      standBy(id, at);
      return;
    }
    close(id);
  };

  const noteAssistant = (entry: Record<string, unknown>): void => {
    for (const block of blocksOf(entry)) {
      if (block['type'] !== 'tool_use') continue;
      const id = asText(block['id']);
      const toolName = asText(block['name']);
      if (id === '' || !TASK_TOOLS.includes(toolName)) continue;
      const input = asRecord(block['input']);
      calls.set(id, {
        toolName,
        description: callDescription(toolName, input),
        command: input === null ? '' : clipUnits(asText(input[DESCRIPTION.command]), TASK_COMMAND_MAX),
        agentType: input === null ? '' : asText(input[WHO.subagentType]),
      });
      // `Map` pamięta kolejność wstawiania, więc pierwszy klucz to najstarsze wywołanie.
      if (calls.size > PENDING_CALLS_MAX) {
        const oldest = calls.keys().next();
        if (oldest.done !== true) calls.delete(oldest.value);
      }
    }
  };

  const noteUser = (entry: Record<string, unknown>): void => {
    // Wpis wstrzyknięty do rozmowy: `message.content` jest wtedy GOŁYM stringiem, nie tablicą.
    const message = asRecord(entry['message']);
    const raw = message === null ? '' : asText(message['content']);
    if (raw !== '') {
      noteNotification(raw, asText(entry['timestamp']));
      return;
    }

    const results = blocksOf(entry).filter((block) => block['type'] === 'tool_result');
    if (results.length === 0) return;
    const result = asRecord(entry[TOOL_RESULT]);
    // Wywołanie jest rozliczone NIEZALEŻNIE od tego, czy powstało z niego zadanie w tle.
    const paired = results.flatMap((block) => {
      const id = asText(block['tool_use_id']);
      const call = id === '' ? undefined : calls.get(id);
      if (id !== '') calls.delete(id);
      return call === undefined ? [] : [call];
    });
    if (result === null) return;

    /*
     * Jawne zatrzymanie (TaskStop) — zmierzone: `toolUseResult` niesie
     * `{message: 'Successfully stopped task: …', task_id, task_type}`. Dla zadania ubitego
     * w ten sposób powiadomienie `<task-notification>` potrafi NIE powstać wcale (pomiar:
     * dwa ubite zadania, zero wpisów, pliki wyjściowe bez markera) — wynik TaskStop jest
     * wtedy jedynym dowodem końca, a bez tej gałęzi plakietka świeciłaby nad trupem do
     * wyjścia wpisu startu z okna ogona. Warunek jest podwójny (id ORAZ prefiks zdania),
     * żeby cudze `task_id` w wynikach innych narzędzi niczego nie gasiło.
     */
    const stoppedId = asText(result[STOP.taskId]);
    if (stoppedId !== '' && asText(result[STOP.message]).startsWith(STOP.messagePrefix)) {
      close(stoppedId);
      return;
    }

    /*
     * Wynik odebrany przez `TaskOutput` — narzędzia usuniętego w CLI 2.1.277 (docs `agent-sdk/typescript.md`,
     * „TaskOutput”), więc gałąź czyta pliki sprzed tej wersji. Gdy główny agent CZEKA na wynik tym narzędziem,
     * `<task-notification>` NIE powstaje wcale — jedynym śladem końca jest ten wynik. Zmierzone
     * na 68 wynikach `TaskOutput` z tego konta: `{retrieval_status, task: {task_id, task_type,
     * status, …}}`, gdzie `status` ∈ `running|completed|failed`, a `retrieval_status`
     * ∈ `success|timeout|not_ready`. Zamykamy po `task.status` z tej samej listy terminalnej,
     * co powiadomienia — `timeout` z `running` znaczy „jeszcze mieli" i nie rusza niczego.
     */
    const fetched = asRecord(result[OUTPUT.task]);
    if (fetched !== null && asText(result[OUTPUT.retrievalStatus]) !== '') {
      const fetchedId = asText(fetched[OUTPUT.taskId]);
      if (fetchedId !== '' && TERMINAL_STATUSES.includes(asText(fetched[OUTPUT.status]))) close(fetchedId);
      return;
    }

    /*
     * Wznowienie subagenta (`SendMessage`) — zmierzone na 86 wynikach z 30 dni, wszystkie
     * w kształcie `{message, pin, resumedAgentId, success: true}`. Pola startu (`agentId`) wynik
     * NIE niesie, więc bez tej gałęzi agent wznowiony po końcu nie wróciłby na listę nigdy. Warunek
     * jest podwójny (niepuste id ORAZ `success` równe dokładnie `true`): odmowa wznowienia nie
     * ma prawa niczego otworzyć.
     */
    const resumedId = asText(result[RESUME.resumedAgentId]);
    if (resumedId !== '' && result[RESUME.success] === true) {
      resume(resumedId, asText(entry['timestamp']));
      return;
    }

    const call = paired[0];
    // Monitor w kształcie CLI 2.1.319 (reguła 11) przed resztą: jego `taskId` bez `taskType` niczym innym nie jest.
    const monitor = monitorStartOf(result, call);
    const start = monitor === null ? startOf(result) : { id: monitor.id, kind: 'monitor' as const };
    if (start === null) return;
    if (settled.has(start.id) || open.some((task) => task.id === start.id)) return;

    // Rodzaj z pola przegrywa z nazwą narzędzia TYLKO dla monitora — patrz `TASK_TOOLS`.
    const kind: BackgroundTaskKind = call?.toolName === MONITOR_TOOL ? 'monitor' : start.kind;
    const task: BackgroundTask = { id: start.id, kind };
    const description = describe(result, call);
    if (description !== '') task.description = description;
    if (call !== undefined && call.command !== '') task.command = call.command;
    /*
     * KTO to robi — zmierzone na 54 startach subagentów w transkryptach tego konta.
     * Oba pola są w wpisach, które follower i tak przewija, więc moduł zostaje bez I/O: podtyp
     * w wywołaniu (`subagent_type`), model w wyniku (`resolvedModel`, wartości `claude-fable-5`,
     * `claude-opus-5[1m]`, `claude-opus-4-8`). Katalogu `subagents/agent-<id>.meta.json` NIE
     * czytamy — te same fakty kosztowałyby odczyt z dysku na zadanie przy każdej ramce.
     */
    if (call !== undefined && call.agentType !== '') task.agentType = call.agentType;
    const model = asText(result[WHO.resolvedModel]);
    if (model !== '') task.model = model;
    const summary = asText(result[WHO.summary]);
    if (summary !== '') task.summary = clipUnits(summary, TASK_SUMMARY_MAX);
    /*
     * Koniec pracy na PIERWSZYM PLANIE. Fork skilla i subagent na pierwszym planie zapisują `agentId` razem z wynikiem
     * końcowym, a meldunku `<task-notification>` nie wyślą nigdy, więc start założony z takiego wyniku byłby
     * duchem. Rozpoznajemy go po statusie: końcowy, albo `forked` bez `background: true`. Każdy inny status
     * (`async_launched`, brak pola) zostaje startem.
     *
     * Wpisu nie otwieramy, ale dane agenta zostają w `agents`: subagenta z pierwszego planu da się wznowić
     * (`SendMessage`, wynik niesie `canContinueAgent: true`), a wznowienie odtwarza wpis z tych danych
     * (reguła 6). Bez `startedAt`, bo czas tego wyniku to koniec pracy, nie jej start.
     */
    const status = asText(result[FOREGROUND.status]);
    if (TERMINAL_STATUSES.includes(status) || (status === FOREGROUND.forked && result[FOREGROUND.background] !== true)) {
      if (kind === 'agent') agents.set(task.id, task);
      return;
    }
    // `runId` (`wf_<id>`) to klucz katalogu przebiegu w satelicie sesji — po nim driver dokleja
    // rozkład faz i agentów (`workflow-run.ts`). Ścieżek `transcriptDir`/`scriptPath`
    // z tego samego wyniku NIE bierzemy: adres składa się z katalogu sesji, nie z treści pliku.
    const runId = asText(result[RUN_ID]);
    if (kind === 'workflow' && isRunId(runId)) {
      task.runId = runId;
      // Wznowienie (`resumeFromRunId`, zmierzone): ten sam `runId`, nowy `taskId`.
      // CLI wznawia tylko zatrzymany przebieg, więc poprzednie zadanie już nie żyje. Bez
      // zamknięcia (`UNKNOWN_FATE`, zgubione powiadomienie) wisiałoby dalej, a po końcu nowego
      // jego starszy `startedAt` przywracał w rozkładzie przerwanych agentów (`openRuns`).
      for (const previous of open.filter((item) => item.runId === runId)) close(previous.id);
    }
    const at = asText(entry['timestamp']);
    if (at !== '') task.startedAt = at;
    // Od tej linii obiekt jest gotowy i już się nie zmienia (reguła 9).
    if (kind === 'agent') agents.set(task.id, task);
    insert(task);
    if (kind === 'agent') {
      prove(task.id, at);
      closeIfOutlived(task.id);
    }
    if (monitor !== null) {
      const startMs = Date.parse(at);
      monitors.set(task.id, { startMs: Number.isNaN(startMs) ? null : startMs, span: monitor.span });
      closeMonitorIfOutlived(task.id);
    }
  };

  return {
    note(value: unknown): void {
      const entry = asRecord(value);
      if (entry === null || (!sidechain && entry['isSidechain'] === true)) return;
      const type = entry['type'];
      if (firstEntryAt === '' && type !== CARRIERS.attachmentType) firstEntryAt = asText(entry['timestamp']);

      if (type === 'assistant') {
        noteAssistant(entry);
        return;
      }
      if (type === 'user') {
        noteUser(entry);
        return;
      }
      // Powiadomienie w drodze do kolejki promptów — treść jest w innym polu w każdym z wariantów.
      if (type === CARRIERS.queueType) {
        noteNotification(asText(entry[CARRIERS.queueText]), asText(entry['timestamp']));
        return;
      }
      if (type === CARRIERS.attachmentType) {
        const attachment = asRecord(entry[CARRIERS.attachmentField]);
        if (attachment === null || attachment['type'] !== CARRIERS.queuedCommand) return;
        noteNotification(asText(attachment[CARRIERS.queuedText]), asText(entry['timestamp']));
      }
    },
    end(id: string): void {
      close(id);
    },
    processStarted(atMs: number): void {
      processStartedAt = atMs;
      // Kopia listy: `close()` wyjmuje zadanie z tablicy, po której idziemy.
      for (const task of [...open]) if (task.kind === 'agent') closeIfOutlived(task.id);
      for (const id of [...monitors.keys()]) closeMonitorIfOutlived(id);
    },
    expire(nowMs: number): void {
      for (const [id, monitor] of [...monitors]) {
        if (monitor.startMs === null) {
          // Start bez czasu: od tej chwili, czyli od odczytu linii (reguła 11).
          monitors.set(id, { ...monitor, startMs: nowMs });
          closeMonitorIfOutlived(id);
          continue;
        }
        if (monitor.span !== null && nowMs >= monitor.startMs + monitor.span) close(id);
      }
    },
    get tasks(): readonly BackgroundTask[] {
      return open;
    },
    get unknownAgentNotes(): number {
      return unknownAgentNotes;
    },
    get unstartedEnds(): readonly string[] {
      return unstartedEnds;
    },
    get firstEntryAt(): string {
      return firstEntryAt;
    },
  };
}

/**
 * Zadania w tle żywe na końcu okna linii.
 *
 * Ten sam duet co `pendingToolUse` przy zgodach: czysta funkcja zbudowana NA trackerze, żeby
 * jeden test pilnował obu i żeby nie dało się ich rozjechać.
 *
 * @param lines linie okna ogona pliku (kolejność zapisu)
 */
export function backgroundTasks(lines: readonly string[]): readonly BackgroundTask[] {
  const tracker = createBackgroundTasksTracker();
  for (const line of lines) tracker.note(parseJsonlEntry(line));
  return tracker.tasks;
}
