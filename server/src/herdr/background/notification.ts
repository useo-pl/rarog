/**
 * Meldunek `<task-notification>` — JEDYNY parser jego tekstu.
 *
 * Claude Code melduje koniec (albo zdarzenie) zadania w tle tekstem w znacznikach:
 *
 *   <task-notification>
 *   <task-id>…</task-id>
 *   <status>completed</status>
 *   <summary>Background command "pnpm test" completed (exit code 0)</summary>
 *   </task-notification>
 *
 * Ten tekst czytają dwa moduły: reduktor zadań (id i status, żeby zamknąć wpis) i notka
 * transkryptu (rodzaj, wynik, nazwa, kod wyjścia). Oba biorą te same pola z jednego parsera.
 *
 * Moduł jest CZYSTY i oddaje to, co stoi w tekście. Czy status jest końcowy, czy streszczenie
 * mówi „nie wiem" i jaki to rodzaj zadania, wiedzą `reducer.ts` i `notice.ts`. Słowa meldunku
 * (znaczniki, `exit code`, frazy dopisku) stoją w rejestrze `cli-shapes.ts`; tu jest tylko ich
 * gramatyka: znacznik ma zamknięcie, nazwa stoi w cudzysłowie.
 *
 * Tym samym znacznikiem CLI melduje koniec obserwacji ARTEFAKTU: bez `<task-id>` i `<status>`,
 * z `<task-type>` i zdarzeniem `<event>Watch on <adres> ended — …</event>`. Parser oddaje rodzaj
 * (`taskType`) i adres (`watchedUrl`); czy to usunięcie artefaktu, rozstrzyga `artifacts.ts`. Reduktor
 * zadań takiego meldunku nie rusza (bez id), a notka transkryptu dostaje po `taskType` rodzaj
 * `artifact-watch` (`notice.ts`).
 *
 * Jedno rozstrzygnięcie zapada TUTAJ, bo potrzebują go oba moduły i ma być jedno: co meldunek
 * mówi o zatrzymaniu AGENTA. CLI melduje `completed` zarówno wtedy, gdy subagent skończył, jak
 * i wtedy, gdy tylko stanął, a jego własna komenda w tle jeszcze leci. Różnicę niesie wyłącznie
 * dopisek `<note>` (zmierzone na CLI 2.1.296, fixture'y `postoj` i `wznowienie`):
 * {@link isAgentStandby} to POSTÓJ, {@link hasUnknownAgentNote} to dopisek, którego nie znamy.
 * Reduktor zostawia po postoju wpis otwarty, notka dostaje wynik `waiting`; obaj pytają o to samo.
 */
import { CLI_SHAPES, literalSource } from './cli-shapes.ts';

const MARKS = CLI_SHAPES.notification.literals;
const NOTE = CLI_SHAPES.agentNote.literals;
const WATCH = CLI_SHAPES.artifactWatch.literals;
const ARTIFACT_URL_PREFIX = CLI_SHAPES.artifactPublish.literals.urlPrefix;
const KINDS = CLI_SHAPES.summaryKinds.literals;
const COMPLETED = CLI_SHAPES.terminalStatuses.literals.completed;

/** Zamknięcie znacznika wynika z otwarcia (`<status>` → `</status>`), więc rejestr trzyma samo otwarcie. */
function closing(open: string): string {
  return `</${open.slice(1)}`;
}

/** Wzorzec „otwarcie, dowolna treść, zamknięcie"; grupa 1 to treść. */
function tagPattern(open: string): RegExp {
  return new RegExp(`${literalSource(open)}([\\s\\S]*?)${literalSource(closing(open))}`);
}

const TASK_ID = tagPattern(MARKS.taskId);
const TOOL_USE_ID = tagPattern(MARKS.toolUseId);
const OUTPUT_FILE = tagPattern(MARKS.outputFile);
const STATUS = tagPattern(MARKS.status);
const SUMMARY = tagPattern(MARKS.summary);
/**
 * Rodzaj meldunku: znacznik na POCZĄTKU linii, w jednej linii, PRZED streszczeniem — tak stoi w każdym zmierzonym
 * meldunku (nagłówek). Nazwa zadania w streszczeniu i wynik agenta to tekst modelu i mogą nieść ten znacznik;
 * pierwszy w tekście podstawiał rodzaj obserwacji artefaktu pod nieudaną komendę i chował jej wynik.
 */
const TASK_TYPE_LINE = new RegExp(
  `(?:^|\\n)${literalSource(WATCH.taskType)}([^\\n]*?)${literalSource(closing(WATCH.taskType))}`,
);
/**
 * Zdarzenie meldunku: znacznik na POCZĄTKU linii, a z kilku — ostatni. Tytuł artefaktu w streszczeniu to tekst
 * modelu i może nieść `<event>…</event>`; stoi w środku linii streszczenia i PRZED prawdziwym zdarzeniem, więc
 * nie podstawi cudzego adresu (ta sama ostrożność co miejsce dopisku `NOTE_PLACE` niżej).
 */
const EVENT_LINES = new RegExp(
  `(?:^|\\n)${literalSource(WATCH.event)}([\\s\\S]*?)${literalSource(closing(WATCH.event))}`, 'g',
);
/**
 * Adres artefaktu: prefiks z rejestru i identyfikator z samych liter i cyfr ASCII — nic więcej (bez portu,
 * dalszych segmentów, zapytania, fragmentu i danych użytkownika). Zmierzone na całym magazynie
 * CLI tego konta: w wynikach publikacji i w meldunkach stoi wyłącznie `<prefiks><22 znaki base58>`.
 * Ta sama gramatyka obowiązuje adres z wyniku publikacji (`artifacts.ts`) i adres z meldunku niżej.
 */
const ARTIFACT_ID = '[A-Za-z0-9]+';
const ARTIFACT_URL = new RegExp(`^${literalSource(ARTIFACT_URL_PREFIX)}${ARTIFACT_ID}$`);
/**
 * Zdarzenie meldunku o końcu obserwacji artefaktu: `Watch on <adres> ended — …`. Grupa 1 to adres. Słowo
 * po adresie musi stać jako całe słowo, a adres kończy się przed pierwszym znakiem spoza identyfikatora.
 */
const WATCHED_URL = new RegExp(
  `^${literalSource(WATCH.watchOn)} (${literalSource(ARTIFACT_URL_PREFIX)}${ARTIFACT_ID}) `
  + `${literalSource(WATCH.ended)}(?![A-Za-z0-9])`,
);
/** Zamknięcie całego meldunku. */
const CLOSE = closing(MARKS.open);
/**
 * MIEJSCE dopisku w meldunku: linia zaraz po zamknięciu streszczenia, a w następnej wynik agenta
 * albo koniec meldunku. Grupa 1 to treść dopisku; dopasowanie bez grupy = meldunek bez dopisku.
 *
 * Zmierzone na całym magazynie CLI tego konta (3422 różne meldunki, 110 projektów,
 * wszystkie nośniki): każdy element meldunku zaczyna linię, dopisek stoi zawsze tu i nigdzie
 * indziej, a po nim zawsze `<result>` albo zamknięcie meldunku. Miejsce, a nie „pierwszy `<note>`
 * w tekście", bo dwa pola meldunku niosą tekst MODELU i same bywają pełne znaczników: nazwa
 * zadania w streszczeniu i wynik agenta. Pomyłki, które ten wzorzec zamyka:
 * `<result>` w nazwie ucinał meldunek przed prawdziwym dopiskiem,
 * `</summary> <note>…</note>` w nazwie podstawiał cudzy dopisek, a `</summary> <result>` w nazwie
 * udawał meldunek bez dopisku. Znacznik wewnątrz nazwy stoi w ŚRODKU linii, więc odpada.
 *
 * Trzecia rzecz, która może stać po dopisku: znacznik treści przekazanej z artefaktu (`relayed`)
 * z linią ostrzeżenia, a dopiero po nich wynik. Tak wygląda meldunek agenta, który czytał treść
 * artefaktu (zmierzone na pliku żywej sesji, CLI 2.1.296). Parser bez tego układu wziąłby dopisek
 * za nieznany, meldunek liczyłby jak koniec, a postój takiego agenta zamknąłby jego wpis.
 *
 * Granica: nazwa, która sama niesie `</summary>`, znak nowej linii i `<result>`, jest nie do
 * odróżnienia od prawdziwego układu. Meldunek o INNYM układzie linii (nowe CLI) nie ma miejsca na
 * dopisek wcale — patrz `noteOf`: to nie jest ciche „bez dopisku".
 */
const NOTE_PLACE = new RegExp(
  `${literalSource(closing(MARKS.summary))}\\n`
  + `(?:${literalSource(NOTE.tag)}((?:(?!${literalSource(closing(NOTE.tag))})[\\s\\S])*)`
  + `${literalSource(closing(NOTE.tag))}\\n)?`
  + `(?=${literalSource(NOTE.result)}|${literalSource(NOTE.relayed)}|${literalSource(CLOSE)})`,
);
/**
 * Streszczenie ZACZYNA SIĘ jak meldunek agenta: któreś z brzmień jako całe słowo (granica `\b` —
 * „Agents" ani „Agentic" agentem nie są). Małe „agent" i „Background agent" to brzmienia starszych
 * wersji CLI i sieroty po padzie.
 */
const AGENT_SUMMARY = new RegExp(
  `^(?:${[...KINDS.agent, ...KINDS.backgroundAgent].map(literalSource).join('|')})\\b`,
);
/** `exit code N` — grupa 1 to cyfry. */
const EXIT_CODE = new RegExp(`${literalSource(CLI_SHAPES.summaryExitCode.literals.prefix)}(\\d+)`);

/**
 * Dopisek `<note>` meldunku, rozpoznany po frazie kluczowej z rejestru (`agentNote`):
 *
 * - `none` — meldunek bez dopisku (komenda, workflow, agent ze starszego CLI);
 * - `standby` — agent stanął, a jego własna praca w tle jeszcze leci;
 * - `ended` — agent stanął i nie ma żywych własnych zadań w tle;
 * - `other` — dopisek jest, ale o brzmieniu spoza rejestru (dopisek komendy po timeoucie, nowe
 *   zdanie CLI) albo niosący OBIE frazy naraz, czyli taki, którego nie umiemy przeczytać.
 */
export type NotificationNote = 'none' | 'standby' | 'ended' | 'other';

/** Meldunek rozłożony na pola. Brak znacznika w tekście to pusty napis, nigdy wyjątek. */
export interface TaskNotification {
  /** Zawartość `<task-id>`; `''` = brak. */
  readonly id: string;
  /** Content of `<tool-use-id>`: the call that started the task; `''` = none. */
  readonly toolUseId: string;
  /**
   * Content of `<output-file>`: where the CLI writes the task output (measured on 2.1.296); `''` = none. Not checked
   * here.
   */
  readonly outputFile: string;
  /** Zawartość `<status>`; `''` = meldunek bez statusu (zdarzenie monitora, nie koniec). */
  readonly status: string;
  /** Zawartość `<summary>`; `''` = brak. */
  readonly summary: string;
  /** Nazwa zadania z pierwszego cudzysłowu w streszczeniu, bez sufitu długości; `''` = brak. */
  readonly name: string;
  /** Kod wyjścia ze streszczenia (`exit code N`); nieobecny = streszczenie go nie podaje. */
  readonly exitCode?: number;
  /** Czy streszczenie zaczyna się jak meldunek AGENTA (`Agent "…"`, `Background agent …`). */
  readonly agent: boolean;
  /** Rodzaj dopisku `<note>`. O agencie mówi coś tylko razem z {@link TaskNotification.agent}. */
  readonly note: NotificationNote;
  /**
   * Zawartość `<task-type>`; `''` = brak. Meldunki zadań w tle go nie niosą; niesie go meldunek o końcu
   * obserwacji artefaktu (zmierzone: jedyna wartość w magazynie CLI to ta z `artifactWatch`).
   */
  readonly taskType: string;
  /**
   * Adres artefaktu ze zdarzenia `<event>` w brzmieniu `Watch on <adres> ended …`, w gramatyce
   * {@link isArtifactUrl}; `''` = zdarzenia nie ma albo mówi co innego. Co z tym adresem zrobić (czy to
   * usunięcie), rozstrzyga `artifacts.ts`.
   */
  readonly watchedUrl: string;
}

/**
 * Czy tekst niesie znacznik meldunku?
 *
 * Tania bramka dla reduktora, który ogląda KAŻDY wpis kolejki i każdy goły napis roli `user`
 * (także prompty człowieka). Notka transkryptu jej nie używa: tam bramką jest pochodzenie wpisu
 * (`origin.kind`), nie tekst.
 */
export function isTaskNotification(text: string): boolean {
  return text.includes(MARKS.open);
}

/** Zawartość pojedynczego znacznika, bez białych znaków na brzegach; `''` = znacznika nie ma. */
function tag(text: string, pattern: RegExp): string {
  return pattern.exec(text)?.[1]?.trim() ?? '';
}

/**
 * Odwrotny lukier na `\"`: część wpisów przechodzi przez podwójne kodowanie JSON i niesie
 * ukośniki w treści (zmierzone na realnych transkryptach).
 */
function unescapeQuotes(summary: string): string {
  return summary.replace(/\\"/g, '"');
}

/** Nazwa z pierwszego cudzysłowu w `<summary>`. */
function quotedName(summary: string): string {
  return /"([^"]+)"/.exec(unescapeQuotes(summary))?.[1]?.trim() ?? '';
}

/**
 * Kod wyjścia ze streszczenia (`exit code N`) — tylko z pliku. Szukany POZA cytowaną nazwą:
 * zadanie „check exit code 2" z meldunkiem „(exit code 0)" ma kod 0, nie 2.
 */
function exitCodeOf(summary: string): number | undefined {
  const outside = unescapeQuotes(summary).replace(/"[^"]*"/, '');
  const raw = EXIT_CODE.exec(outside)?.[1];
  if (raw === undefined) return undefined;
  const code = Number(raw);
  return Number.isSafeInteger(code) ? code : undefined;
}

/**
 * Rodzaj dopisku po frazie kluczowej; dwie frazy naraz to dopisek, którego nie umiemy czytać.
 * Dopisek bierzemy wyłącznie z jego miejsca ({@link NOTE_PLACE}); `<note>` w nazwie zadania albo
 * w wyniku agenta to tekst modelu.
 *
 * Meldunek o układzie, którego nie znamy (między streszczeniem a wynikiem stoi coś jeszcze), nie
 * ma miejsca na dopisek. Jeśli mimo to niesie `<note>`, nie umiemy go przeczytać: `other`, czyli
 * koniec i ślad w logu, a nie ciche „bez dopisku".
 */
function noteOf(text: string): NotificationNote {
  const place = NOTE_PLACE.exec(text);
  if (place === null) return text.includes(NOTE.tag) ? 'other' : 'none';
  const note = place[1];
  if (note === undefined) return 'none';
  const standby = note.includes(NOTE.standby);
  const ended = note.includes(NOTE.ended);
  if (standby === ended) return 'other';
  return standby ? 'standby' : 'ended';
}

/**
 * Tekst meldunku → pola. Nie sprawdza znacznika `<task-notification>`: tekst bez niego też da
 * się rozłożyć (notka idzie po `origin`), a reduktor pyta wcześniej {@link isTaskNotification}.
 */
export function parseTaskNotification(text: string): TaskNotification {
  const summary = tag(text, SUMMARY);
  const exitCode = exitCodeOf(summary);
  return {
    id: tag(text, TASK_ID),
    toolUseId: tag(text, TOOL_USE_ID),
    outputFile: tag(text, OUTPUT_FILE),
    status: tag(text, STATUS),
    summary,
    name: quotedName(summary),
    ...(exitCode === undefined ? {} : { exitCode }),
    agent: AGENT_SUMMARY.test(summary),
    note: noteOf(text),
    taskType: taskTypeOf(text),
    watchedUrl: WATCHED_URL.exec(lastEvent(text))?.[1] ?? '',
  };
}

/** Rodzaj meldunku z nagłówka (przed pierwszym `<summary>`), bez białych brzegów; `''` = brak. */
function taskTypeOf(text: string): string {
  const summaryAt = text.indexOf(MARKS.summary);
  const head = summaryAt === -1 ? text : text.slice(0, summaryAt);
  return TASK_TYPE_LINE.exec(head)?.[1]?.trim() ?? '';
}

/** Treść ostatniego zdarzenia `<event>` zaczynającego linię, bez białych brzegów; `''` = brak. */
function lastEvent(text: string): string {
  let last = '';
  for (const hit of text.matchAll(EVENT_LINES)) last = hit[1] ?? '';
  return last.trim();
}

/**
 * Czy napis to DOKŁADNIE adres artefaktu (`https://claude.ai/artifact/<id>`, id z liter i cyfr ASCII)?
 * Jedna gramatyka dla adresu z wyniku publikacji i z meldunku: z serwera nie wychodzi adres w innej formie.
 */
export function isArtifactUrl(text: string): boolean {
  return ARTIFACT_URL.test(text);
}

/**
 * Czy to meldunek o POSTOJU agenta: subagent skończył turę, ale jego własna komenda w tle jeszcze
 * leci, więc nie skończył i nie pracuje.
 *
 * Trzy warunki naraz: streszczenie agenta, status `completed` (postój nie występuje z żadnym
 * innym — 888 meldunków agentów z 30 dni) i dopisek o postoju. Brak któregokolwiek = zwykły
 * koniec, czyli zachowanie sprzed rozróżnienia: zmiana brzmienia w nowym CLI nie psuje niczego
 * ponad to, co było.
 */
export function isAgentStandby(notification: TaskNotification): boolean {
  return notification.agent && notification.status === COMPLETED && notification.note === 'standby';
}

/**
 * Czy meldunek AGENTA niesie dopisek, którego nie znamy. Taki meldunek jest liczony jak koniec,
 * a wołający zostawia po nim ślad w logu: to jedyny sygnał, że CLI zmieniło zdanie, po którym
 * poznajemy postój. Meldunek agenta BEZ dopisku (starsze CLI) nim nie jest, a dopisek komendy
 * po timeoucie nie stoi przy streszczeniu agenta.
 */
export function hasUnknownAgentNote(notification: TaskNotification): boolean {
  return notification.agent && notification.note === 'other';
}

/**
 * Odcisk meldunku do rozpoznawania KOPII — krótki napis zamiast całej treści.
 *
 * CLI zapisuje jeden meldunek w 2–3 wpisach o identycznej treści (kolejka, wpis `user`,
 * załącznik), a dwa różne meldunki nigdy nie miały tej samej (kształt z CLI 2.1.295 i 2.1.296, fixture
 * `tasks/measured/postoj.jsonl`; skan plików rozmów: 1353 kopie
 * identyczne, 0 z 888 różnych meldunków o wspólnej treści — różni je co najmniej `<usage>`).
 * Liczony z samego meldunku, od otwarcia do zamknięcia znacznika: tekst nośnika dookoła (nagłówek
 * CLI w pliku subagenta, zdanie pod meldunkiem w starszych wersjach) do treści nie należy.
 * Zamknięciem jest OSTATNIE w tekście: wynik agenta bywa raportem, który sam cytuje meldunek,
 * a cięcie na pierwszym zamknięciu sklejało dwa różne meldunki o wspólnym początku wyniku
 * w jeden odcisk — drugi postój przepadał jako „kopia".
 *
 * Skrót (cyrb53, 53 bity) i długość zamiast napisu, bo reduktor trzyma odciski do swojego
 * zerowania, a `<result>` meldunku agenta ma kilobajty. Moduł jest czysty, więc bez `node:crypto`.
 */
export function notificationFingerprint(text: string): string {
  const from = text.indexOf(MARKS.open);
  const to = from === -1 ? -1 : text.lastIndexOf(CLOSE);
  const body = from === -1 ? text : text.slice(from, to < from ? undefined : to + CLOSE.length);
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let at = 0; at < body.length; at += 1) {
    const code = body.charCodeAt(at);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ (high >>> 16), 2246822507) ^ Math.imul(low ^ (low >>> 13), 3266489909);
  low = Math.imul(low ^ (low >>> 16), 2246822507) ^ Math.imul(high ^ (high >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & low) + (high >>> 0);
  return `${String(body.length)}:${hash.toString(36)}`;
}
