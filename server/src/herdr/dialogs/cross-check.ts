/**
 * Uzgadnianie źródeł dialogu: zrzut hooka ↔ ekran ↔ wpis jsonl.
 *
 * Treść karty pochodzi z pliku (wpis jsonl albo zrzut hooka), cyfry z ekranu, a ten moduł odpowiada,
 * czy oba opisują TO SAMO wywołanie: pytanie ze zrzutu sparowane z formularzem na ekranie, zrzut
 * konkurujący z wpisem jsonl, fragment wejścia albo komenda w ramce operacji, override `multiSelect`
 * przyłożony do świeżego ekranu. Brak dowodu = `false` albo `null`, czyli karta bez przycisków.
 */
import { createHash } from 'node:crypto';
import { EXIT_PLAN_MODE_TOOL } from '@rarog/shared';
import type { Question } from '@rarog/shared';
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestionInput } from '../../drivers/tool-summary.ts';
import { asRecord } from '../../drivers/tool-text.ts';
import { canonicalLabel } from './screen/options.ts';
import { optionPolicy } from './policy/option-policy.ts';
import { parseOptions } from './screen/parse.ts';
import type { ScreenDialog } from './screen/parse.ts';
import type { ScreenFormOption } from './screen/options.ts';
import type { PendingTool } from '../jsonl-pending.ts';
import { isTruncatedHookInput } from './hook/dump.ts';
import type { PendingHookTool } from './hook/dump.ts';
import { HOOK_PERMISSION_REQUEST_EVENT } from './hook/contract.ts';
import { bashCommand, commandMatches } from './screen/operation.ts';
import { editContradictsOperation, editMatchesOperation } from './screen/edit-frame.ts';
import type { ScreenOperation } from './screen/operation.ts';
import { queueOnScreen } from './screen/queue.ts';
import { optionRole } from './cards/roles.ts';
import type { ActiveReq, HookQuestion } from './cards/build.ts';

/**
 * Odcisk WYWOŁANIA narzędzia: nazwa i kanoniczny JSON wejścia (klucze posortowane), bez id.
 *
 * Tożsamość karty zgody po własnej cyfrze się zmienia — zrzut hooka kasowany po cyfrze zamienia bazę
 * `T~hook:…` w `T`, a zrzut bez wpisu jsonl ustępuje wpisowi o innym id — więc osłona po decyzji
 * rozpoznaje to samo wywołanie po treści, nie po identyfikatorze.
 */
export function callPrint(toolName: string, input: unknown): string {
  return createHash('sha256').update(`${toolName}\n${canonicalJson(input)}`).digest('hex').slice(0, 16);
}

/** Tekst ze zwiniętymi białymi znakami — porównanie odporne na zawijanie linii przez panel. */
export function foldWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Czekające narzędzie ze zrzutu hooka `PreToolUse`/`PermissionRequest` — w kształcie
 * `PendingTool`, żeby budowa karty i cross-check ekranu obsłużyły je TĄ SAMĄ ścieżką co wpis
 * z jsonl. `id` z chwili zapisu zrzutu jest stabilne między przebiegami oceny (dialog stoi
 * = plik się nie zmienia), więc karta nie migocze.
 */
export function hookPendingFrom(hook: PendingHookTool | null): PendingTool | null {
  if (hook === null) return null;
  // Marker przycięcia (>64 kB) to NIE jest input — karta „Write" z pustą treścią
  // i żywym przyciskiem byłaby gorsza niż ekranowa z wycinkiem.
  if (isTruncatedHookInput(hook.toolInput)) return null;
  return {
    id: `hook:${hook.toolUseId ?? hook.at}`,
    toolName: hook.toolName,
    input: hook.toolInput,
    at: '',
    ...(hook.cwd === undefined ? {} : { cwd: hook.cwd }),
  };
}

/**
 * Pytanie w kształcie karty PROSTO Z PAYLOADU — bez ani jednego znaku z ekranu.
 *
 * Używane wyłącznie przez kanał hooka: tam odpowiedź jedzie plikiem, więc etykieta nie jest
 * adresem cyfry i nie musi (ani nie może) pochodzić z zakładki, której ekran nie pokazuje.
 * `terminalOnly` liczy polityka opcji w kanale `hook` (`optionPolicy`): eskalacja blokuje i tutaj — reguła
 * eskalacji (`docs/dialogs.md`, „Rules: what must not be relaxed”) nie zna
 * wyjątków dla kanałów — a wielokrotny wybór nie, bo odpowiedź jedzie tekstem w pliku. Polityka dostaje
 * PEŁNĄ etykietę ze zwiniętymi białymi znakami: surowa ze złamaniem linii w środku markera („this\nsession”) nie
 * trafiała w słownik eskalacji, a `canonicalLabel` ucina do `OPTION_LABEL_MAX_CHARS` i marker za tą granicą znikał.
 * Lista `blocked` (`hookAnswerTargetFor`) bierze stąd flagę, a kluczem jest postać kanoniczna, jak w bramce.
 */
function payloadCard(question: Question): Question {
  return {
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({
      label: option.label,
      ...(option.description === undefined || option.description === ''
        ? {}
        : { description: option.description }),
      ...(optionPolicy({
        label: foldWhitespace(option.label), terminalDialog: null, multiSelect: question.multiSelect,
        notesEditing: false,
      }, 'hook').terminalOnly ? { terminalOnly: true } : {}),
      // Payload autora: chrome CLI tu nie występuje, więc każda opcja jest odpowiedzią.
      role: 'answer' as const,
      // Podgląd OD AUTORA — w całości; kopię dla klientów przycina manager.
      ...(option.preview === undefined ? {} : { preview: option.preview }),
    })),
  };
}

/**
 * Pytanie ze zrzutu hooka SPAROWANE z formularzem stojącym na ekranie.
 *
 * Payload `PreToolUse` niesie to, czego ekran nie ma: nagłówek, OPISY opcji i `multiSelect`
 * prosto od autora pytania. Ale niesie też CAŁE wywołanie (formularz bywa wielopytaniowy,
 * a ekran pokazuje jedną zakładkę naraz) i może być stęchły. Dlatego wchodzi na kartę
 * wyłącznie po dwustronnym dopasowaniu:
 *
 * 1. TREŚĆ pytania z hooka = treść z ekranu (po zwinięciu białych znaków — panel zawija
 *    długie zdania, więc porównanie znak w znak dawałoby fałszywe rozjazdy);
 * 2. KOMPLET etykiet opcji z hooka stoi na ekranie. Nadmiar po stronie ekranu jest
 *    normalny i dozwolony: CLI dokłada własne pozycje („Type something", „Chat about
 *    this"), których w payloadzie nie ma. Brak choćby jednej etykiety Z HOOKA znaczy, że
 *    patrzymy na inne pytanie — wtedy `null`, czyli karta czysto ekranowa.
 *
 * Lista opcji wychodzi stąd ZAWSZE Z EKRANU (z cyframi i flagą eskalacji); z hooka jedzie
 * warstwa opisowa, `multiSelect` i pełna etykieta do polityki opcji (marker za ucięciem etykiety
 * z ekranu). To jest ta sama reguła co przy zgodach — treść z pliku, cyfry z ekranu — tylko zastosowana
 * do karty pytania.
 */
/*
 * Ta sama funkcja dopasowuje zakładkę do ekranu także dla wpisu `tool_use`
 * z JSONL (`decideCard`, ścieżka cyfrowa): kształt wejścia jest identyczny (`questions[]`),
 * a reguła „treść pytania + komplet etykiet z ekranu" ma obowiązywać niezależnie od tego,
 * które ze źródeł przyniosło payload. Dwa dopasowania w dwóch miejscach rozjechałyby się.
 */
export function hookQuestionFrom(pending: PendingTool, screenText: string): HookQuestion | null {
  if (pending.toolName !== ASK_USER_QUESTION_TOOL) return null;
  const questions = parseAskUserQuestionInput(pending.input);
  if (questions === null) return null;
  /*
   * Parsujemy z wymuszonym `multiSelect: false` — nie po to, żeby cokolwiek przemycić, lecz
   * po to, żeby W OGÓLE dostać treść pytania i etykiety z formularza, który sygnatury
   * ekranu uznały za wielokrotny (`question: null`). Bez porównania nie da się rozstrzygnąć,
   * czy hook mówi o TYM formularzu — a dopiero po dopasowaniu jego `multiSelect` staje się
   * autorytatywny (w obie strony).
   */
  // Etykiety payloadu prowadzą odtworzenie etykiet zawiniętych przez wąski panel:
  // bez tego „Dwie ikony u góry (Rekomendowane)" stałaby na ekranie jako „Dwie ikony u góry"
  // i cały kanał hooka przepadałby na jednej opcji (odmowa `no-digit`).
  const dialog = parseOptions(screenText, {
    multiSelect: false,
    labels: questions.flatMap((question) => question.options.map((option) => ({
      label: option.label, description: option.description,
    }))),
  });
  if (dialog === null || dialog.kind !== 'question' || dialog.question === null) return null;
  const screenQuestion = dialog.question.question;
  const labels = new Set(dialog.options.map((option) => option.label));
  const match = questions.find((question) => foldWhitespace(question.question)
    === foldWhitespace(screenQuestion)
    && question.options.length > 0
    && question.options.every((option) => labels.has(canonicalLabel(option.label))));
  if (match === undefined) return null;
  const describedBy = new Map(
    match.options.map((option) => [canonicalLabel(option.label), option.description]),
  );
  // Podgląd opcji wyłącznie z PAYLOADU — ekran rysuje go obok listy i ucina.
  const previewOf = new Map(match.options.flatMap((option) => (
    option.preview === undefined ? [] : [[canonicalLabel(option.label), option.preview] as const]
  )));
  // PEŁNE etykiety payloadu (zwinięte białe znaki, bez ucinania) pod kluczem kanonicznym etykiety z ekranu. Lista,
  // bo dwie etykiety o wspólnym początku dają na ekranie ten sam klucz.
  const fullLabels = new Map<string, string[]>();
  for (const option of match.options) {
    const key = canonicalLabel(option.label);
    fullLabels.set(key, [...(fullLabels.get(key) ?? []), foldWhitespace(option.label)]);
  }
  const options: ScreenFormOption[] = dialog.options.map((option) => {
    const description = describedBy.get(option.label);
    /*
     * Bramka eskalacji (`docs/dialogs.md`, „Rules: what must not be relaxed”) obowiązuje TAK SAMO na karcie z hooka: opcja eskalująca uprawnienia jedzie na telefon widoczna,
     * ale bez przycisku, a `answerQuestion` odmawia jej cyfry. Polityka idzie na etykiecie z ekranu i na pełnej
     * etykiecie z payloadu (jak `payloadCard`): etykieta z ekranu jest ucięta do `OPTION_LABEL_MAX_CHARS`, więc
     * marker za tą granicą widzi tylko payload. Opcja spoza payloadu („Type something.”) ma samą etykietę z ekranu.
     */
    const terminalOnly = [option.label, ...(fullLabels.get(option.label) ?? [])].some((label) => optionPolicy({
      label, terminalDialog: dialog.terminalDialog, multiSelect: match.multiSelect, notesEditing: dialog.notesEditing,
    }, 'digit').terminalOnly);
    return {
      ...option,
      ...(description === undefined || description === '' ? {} : { description }),
      ...(terminalOnly ? { terminalOnly: true as const } : {}),
    };
  });
  return {
    multiSelect: match.multiSelect,
    options,
    all: questions.map(payloadCard),
    screenQuestion,
    // Odcisk bloku z tego parsowania, nie z drugiego bez podpowiedzi etykiet.
    bodyPrint: dialog.bodyPrint,
    card: {
      // Treść i nagłówek z HOOKA: to samo zdanie co na ekranie, tylko bez twardych złamań
      // linii, które panel dołożył zawijaniem.
      question: match.question,
      header: match.header,
      multiSelect: match.multiSelect,
      options: options.map((option) => {
        const preview = previewOf.get(option.label);
        return {
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
          ...(option.terminalOnly === true ? { terminalOnly: true } : {}),
          // Etykiety Z EKRANU — tu stoją „Type something." i „Chat about this".
          role: optionRole(option.label),
          ...(preview === undefined ? {} : { preview }),
        };
      }),
    },
  };
}

/**
 * Zapas na zaokrąglenia znaczników czasu między wpisem jsonl a zrzutem hooka TEGO SAMEGO momentu
 * (hook `PermissionRequest` strzela po wpisie; od CLI 2.1.267 wpis ląduje ~0,1 s przed zrzutem).
 */
export const HOOK_AFTER_JSONL_SLACK_MS = 2_000;

/** Nazwa narzędzia edycji w payloadzie jsonl i hooka (nie wygląd ekranu, więc poza `screen/`). */
export const EDIT_TOOL = 'Edit';

/**
 * Ramka dialogu `Edit` z ekranu; tytuł z BLOKU dialogu, nie z linii nad ramką. Inny dialog — `null`. Bierze ją
 * też dowód „dialog stoi” kanału zgód z wierzchu ekranu (`layer1/top.ts`).
 */
export function editOperation(screenText: string): ScreenOperation | null {
  const dialog = parseOptions(screenText);
  return dialog !== null && dialog.kind === 'tool' && dialog.identity.kind === 'title'
    && dialog.identity.tool === EDIT_TOOL
    ? dialog.operation
    : null;
}

/**
 * Czy dialog `Edit` na ekranie PRZECZY wywołaniu `Edit` (`editContradictsOperation`): ścieżka z nagłówka nie może
 * wskazywać jego `file_path` przy żadnym katalogu. Bez `cwd`, więc działa dla wpisu jsonl; niewiadoma to `false`.
 * Rozstrzyga konkurencję wpisu i zrzutu w `settleCompeting`: wpisu, któremu ekran nie przeczy, nie wykluczamy.
 */
export function editContradictsScreen(pending: PendingTool, screenText: string | null): boolean {
  if (pending.toolName !== EDIT_TOOL || screenText === null) return false;
  return editContradictsOperation(pending.input, editOperation(screenText));
}

/**
 * Czy zrzut `PermissionRequest` opisuje INNE wywołanie niż czekający wpis jsonl, i to wywołanie
 * NIE STARSZE niż ten wpis. Taki zrzut jest kandydatem na źródło karty: rozstrzyga ekran
 * (`settleCompeting` w `decide/sources.ts`). Bez tego wpis `Read`, którego wyniku follower nie
 * przeczytał, zasłaniałby świeży zrzut `Bash` przez całą turę.
 *
 * Formularz pytania ma własną ścieżkę ({@link hookMatchesPending}); wpis bez czytelnego znacznika
 * czasu albo zrzut starszy od wpisu nie konkuruje — stęchły zrzut nie ma prawa wypierać świeżego
 * wpisu. Wyjątek z dowodem z ekranu: zrzut `Bash` starszy od wpisu ({@link olderBashHook}).
 */
export function competingHook(pending: PendingTool, hook: PendingHookTool | null): boolean {
  if (hook === null || hook.hookEventName !== HOOK_PERMISSION_REQUEST_EVENT) return false;
  if (hook.toolName === ASK_USER_QUESTION_TOOL) return false;
  const jsonlAt = Date.parse(pending.at);
  if (!Number.isFinite(jsonlAt) || hook.at + HOOK_AFTER_JSONL_SLACK_MS < jsonlAt) return false;
  if (hook.toolName !== pending.toolName) return true;
  return canonicalJson(hook.toolInput) !== canonicalJson(pending.input);
}

/**
 * Czy zrzut `PermissionRequest` dla `Bash` jest STARSZY niż czekający wpis jsonl i opisuje INNE wywołanie
 * — bliźniak {@link competingHook} po drugiej stronie granicy czasu.
 *
 * Zgoda SUBAGENTA nie ma wpisu w pliku głównym rozmowy, więc Rarog zna ją tylko z ekranu i ze zrzutu.
 * Gdy agent główny puści w tym czasie własne narzędzie, jego wpis jest MŁODSZY od zrzutu dialogu, który
 * stoi na ekranie (np. komenda agenta głównego kilka sekund po dialogu subagenta), a dla
 * {@link competingHook} taki zrzut jest stęchły. Ten zrzut też wchodzi do rozstrzygnięcia konkurencji,
 * ale wygrywa w nim wyłącznie przy całej ramce operacji z tytułem `Bash` i komendą równą komendzie
 * zrzutu (`settleCompeting` w `decide/sources.ts`). Inne narzędzia nie: ich kontrola treści na ekranie jest za
 * słaba, żeby stęchły zrzut odróżnić od stojącego dialogu.
 */
export function olderBashHook(pending: PendingTool, hook: PendingHookTool | null): boolean {
  if (hook === null || hook.hookEventName !== HOOK_PERMISSION_REQUEST_EVENT) return false;
  if (bashCommand(hook.toolName, hook.toolInput) === null) return false;
  if (!jsonlYoungerThanHook(pending, hook.at)) return false;
  if (hook.toolName !== pending.toolName) return true;
  return canonicalJson(hook.toolInput) !== canonicalJson(pending.input);
}

/**
 * Czy wpis jsonl jest MŁODSZY od zrzutu hooka o generacji `hookAt`, poza zapasem na zaokrąglenia
 * ({@link HOOK_AFTER_JSONL_SLACK_MS}). Wpis bez czytelnego znacznika czasu — `false`. Obok karty ze zrzutu
 * taki wpis to żywe wywołanie agenta głównego, nie dialog z karty.
 */
export function jsonlYoungerThanHook(pending: PendingTool, hookAt: number): boolean {
  const jsonlAt = Date.parse(pending.at);
  return Number.isFinite(jsonlAt) && hookAt + HOOK_AFTER_JSONL_SLACK_MS < jsonlAt;
}

/**
 * Czy zrzut `ExitPlanMode` to TO SAMO wywołanie co wpis jsonl, tylko z planem dołożonym przez CLI.
 * Model, który zapisał plik planu i wywołał narzędzie bez planu w wejściu, ma w transkrypcie `{}`,
 * a hook `PermissionRequest` dostaje od CLI `plan` i `planFilePath` z pliku (CLI 2.1.314). Warunek: wpis nie ma
 * żadnego z tych pól, zrzut ma oba jako napisy, a reszta wejścia zrzutu jest równa wejściu wpisu. Wpis z własnym
 * planem albo ścieżką i zrzut z inną resztą wejścia to dwa różne wywołania.
 */
export function planAddedByCli(pending: PendingTool, hook: PendingTool): boolean {
  if (pending.toolName !== EXIT_PLAN_MODE_TOOL || hook.toolName !== EXIT_PLAN_MODE_TOOL) return false;
  const entry = asRecord(pending.input);
  const dump = asRecord(hook.input);
  if (entry === null || dump === null || Array.isArray(entry) || Array.isArray(dump)) return false;
  if (Object.hasOwn(entry, 'plan') || Object.hasOwn(entry, 'planFilePath')) return false;
  if (typeof dump['plan'] !== 'string' || typeof dump['planFilePath'] !== 'string') return false;
  const rest = Object.fromEntries(Object.entries(dump).filter(([key]) => key !== 'plan' && key !== 'planFilePath'));
  return canonicalJson(rest) === canonicalJson(entry);
}

/**
 * JSON z kluczami obiektów posortowanymi rekurencyjnie — porównanie inputów niezależne od
 * kolejności kluczy: `{command, description}` z jsonl i `{description, command}` z hooka to TO SAMO
 * wywołanie, a zwykły `JSON.stringify` zrobiłby z nich konkurentów.
 * Kolejność elementów tablic zostaje znacząca.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
}

/**
 * Czy wpis `tool_use` z jsonl i zrzut hooka opisują TO SAMO wywołanie `AskUserQuestion`?
 *
 * Od Claude Code 2.1.267 wpis `tool_use` formularza pytania ląduje w jsonl
 * ~0,1 s PRZED zrzutem hooka, czyli GDY DIALOG JESZCZE STOI — a nie, jak do 2.1.266, dopiero po
 * decyzji. Obecność wpisu przestała więc znaczyć „dialog rozstrzygnięty" i nie ma prawa zamykać
 * kanału odpowiedzi. Wpis zostaje jednak KONTROLĄ: dwa źródła opisują ten sam moment, więc jeśli
 * mówią o różnych pytaniach, jedno z nich jest stęchłe i kanał zamykamy (fail-closed).
 *
 * Porównujemy to, co widzi człowiek i co adresuje odpowiedź: treść pytania, nagłówek,
 * `multiSelect` i etykiety W KOLEJNOŚCI (klucze mapy `answers` i kolejność zakładek). Opisy opcji
 * do porównania NIE wchodzą — nie adresują niczego, a różnią się tylko wtedy, gdy różni się
 * pytanie. `toolUseId` zrzutu (niesie go wyłącznie `PreToolUse`) musi zgadzać się z `tool_use.id`,
 * jeśli w ogóle jest.
 */
export function hookMatchesPending(pending: PendingTool, hook: PendingHookTool | null): boolean {
  if (hook === null) return false;
  if (pending.toolName !== ASK_USER_QUESTION_TOOL) return false;
  if (hook.toolName !== ASK_USER_QUESTION_TOOL) return false;
  if (hook.toolUseId !== undefined && hook.toolUseId !== pending.id) return false;
  const fromJsonl = parseAskUserQuestionInput(pending.input);
  const fromHook = parseAskUserQuestionInput(hook.toolInput);
  if (fromJsonl === null || fromHook === null) return false;
  if (fromJsonl.length !== fromHook.length) return false;
  return fromJsonl.every((question, index) => {
    const other = fromHook[index];
    if (other === undefined) return false;
    return foldWhitespace(question.question) === foldWhitespace(other.question)
      && foldWhitespace(question.header) === foldWhitespace(other.header)
      && question.multiSelect === other.multiSelect
      && question.options.length === other.options.length
      && question.options.every((option, i) => option.label === other.options[i]?.label);
  });
}

/**
 * Czy zrzut hooka mówi o TYM dialogu, który stoi na ekranie?
 *
 * Zrzut zgody pochodzi ze zdarzenia `PermissionRequest`, które odpala się DOPIERO,
 * gdy dialog realnie stanie, i jest z nim jeden-do-jednego: równoległa paczka `tool_use`
 * daje dialogi SEKWENCYJNE, więc nie istnieje przypadek „dwa zrzuty, który wygrywa"
 * (zmierzone). Cross-check ZOSTAJE mimo to i pilnuje innego wyścigu — STARY
 * zrzut kontra NOWY ekran: dialog rozstrzygnięty przy biurku nie sprząta pliku, a kolejny
 * dialog tego samego narzędzia (drugi `Bash` pod rząd) podstawiłby treść poprzedniego.
 *
 * Dowodem tożsamości jest FRAGMENT inputu widoczny na ekranie: dialog zgody zawsze pokazuje
 * komendę/ścieżkę, więc jej brak w regionie = to nie ten zrzut. Fragment jest krótki
 * (40 znaków), bo panel zawija długie linie.
 *
 * `Edit` ma własny dowód (`screen/edit-frame.ts`): dialog pokazuje ścieżkę
 * WZGLĘDNĄ do katalogu wywołania, więc początek bezwzględnego `file_path` nie stał na ekranie nigdy i zrzut
 * nie pasował do własnego dialogu. Teraz ścieżka z NAGŁÓWKA dialogu rozwiązana względem `cwd` TEGO źródła
 * (`PendingTool.cwd`, tylko ze zrzutu hooka) musi dać `file_path`, a diff w ramce musi być dokładnie tą edycją.
 * Przy kolejce dialogów („k of N”) albo bez całego bloku `Edit` nie pasuje: zrzut bywa wtedy zrzutem innej
 * prośby, a ekran nie pokazuje katalogu wywołania, więc ta sama edycja tego samego pliku względnego w innym
 * katalogu byłaby nie do odróżnienia.
 *
 * Dwa świadome wyjątki, oba fail-closed po drugiej stronie:
 *
 * - `AskUserQuestion` — zrzut z `PreToolUse` nie ma pola fragmentarycznego, a treść pytania
 *   na ekranie bywa zawinięta. Dowodzi go osobny, MOCNIEJSZY cross-check
 *   ({@link hookQuestionFrom}: treść pytania + komplet etykiet), a tu zostaje sama jego
 *   odpowiedź.
 * - `ExitPlanMode` — `tool_input` ma `plan` i `planFilePath`, więc żadne z czterech pól
 *   fragmentarycznych nie istnieje, a karta planu jest NAJBARDZIEJ treściowa z wszystkich
 *   ({@link planDisplayText} wysyła na telefon cały plan) i ma działający przycisk
 *   „Zatwierdź". Klucz do porównania jest jednak na ekranie: stopka dialogu niesie ścieżkę
 *   pliku planu (`~/.claude/plans/floofy-prancing-hejlsberg.md`, nazwa losowa PER PLAN —
 *   zmierzone). Porównujemy samą NAZWĘ pliku, bo ekran skraca `/Users/<user>` do `~`,
 *   i WYŁĄCZNIE ze stopki CLI pod opcjami (`ScreenDialog.planFile`, `screen/plan-file.ts`), nie
 *   z całego ekranu ani z całego bloku dialogu: nazwa planu A w scrollbacku albo w feedbacku
 *   wpisanym w opcji 3 nad złamaną stopką planu B dałaby kartę z planem A i cyfrą zatwierdzającą
 *   plan B. Brak pola, brak stopki, stopka
 *   niekompletna, nierozpoznana albo z dwiema ścieżkami = fail-closed: karta planu spada do
 *   ekranowej (`PLAN_DIALOG_PATTERN` i tak daje jej przyciski, tylko bez treści planu) albo, przy
 *   wpisie jsonl obok, do karty bez przycisków, zamiast pokazywać PLAN A pod cyfrą
 *   zatwierdzającą PLAN B.
 * - input bez pola fragmentarycznego (nietypowe narzędzie MCP) przechodzi bez weryfikacji
 *   treści. Tożsamość niesie wtedy nazwa narzędzia, którą i tak sprawdza `resolveOptions`.
 *   Odrzucanie takich zrzutów zabiłoby hook dla całej klasy narzędzi, a zysk byłby żaden:
 *   bez fragmentu nie ma czego porównać.
 */
export function hookMatchesScreen(pending: PendingTool, screenText: string | null): boolean {
  if (screenText === null) return false;
  if (pending.toolName === EDIT_TOOL) {
    return queueOnScreen(screenText).kind === 'single'
      && editMatchesOperation(pending.input, editOperation(screenText), pending.cwd ?? null);
  }
  if (pending.toolName === ASK_USER_QUESTION_TOOL) {
    return hookQuestionFrom(pending, screenText) !== null;
  }
  if (pending.toolName === EXIT_PLAN_MODE_TOOL) {
    const planFile = asRecord(pending.input)?.['planFilePath'];
    if (typeof planFile !== 'string') return false;
    const name = (planFile.split('/').pop() ?? '').trim();
    return name !== '' && parseOptions(screenText)?.planFile === name;
  }
  /*
   * `Bash` z ramką operacji na ekranie: komenda musi być W RAMCE dialogu, a nie gdziekolwiek
   * na ekranie. Pierwsze 40 znaków trafiały też w linię `⎿ $ komenda` w scrollbacku nad dialogiem
   * (ten sam tekst co poprzednie, zakończone wywołanie), a przy długiej komendzie w wąskim panelu
   * pierwsza linia komendy jest nad krawędzią ekranu — wtedy zrzut nie pasował do własnego dialogu.
   */
  const command = bashCommand(pending.toolName, pending.input);
  const operation = command === null ? null : parseOptions(screenText)?.operation ?? null;
  if (command !== null && operation !== null) return commandMatches(operation, command);
  const fragment = inputFragment(pending.input);
  return fragment === null || screenText.includes(fragment);
}

/**
 * Fragment treści wywołania, po którym ekran może je rozpoznać: pierwsza linia pola `command`, `file_path`,
 * `url` albo `pattern`, do 40 znaków. `null` = nie ma czego porównać.
 */
function inputFragment(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) return null;
  const candidate = record['command'] ?? record['file_path'] ?? record['url'] ?? record['pattern'];
  if (typeof candidate !== 'string' || candidate.trim() === '') return null;
  const fragment = (candidate.split('\n')[0] ?? '').trim().slice(0, 40);
  return fragment === '' ? null : fragment;
}

/**
 * Czy ekran POZYTYWNIE potwierdza treść wywołania — ścisła wersja {@link hookMatchesScreen}: wejście
 * bez fragmentu do porównania NIE jest potwierdzeniem. Służy
 * rozstrzyganiu konkurencji wpisu i zrzutu TEGO SAMEGO narzędzia, gdzie nazwa nie odróżnia wywołań.
 */
export function screenConfirmsInput(pending: PendingTool, screenText: string | null): boolean {
  if (screenText === null) return false;
  const specific = pending.toolName === ASK_USER_QUESTION_TOOL || pending.toolName === EXIT_PLAN_MODE_TOOL
    || pending.toolName === EDIT_TOOL || bashCommand(pending.toolName, pending.input) !== null;
  if (specific) return hookMatchesScreen(pending, screenText);
  const fragment = inputFragment(pending.input);
  return fragment !== null && screenText.includes(fragment);
}

/**
 * Override `multiSelect` z karty przyłożony do ŚWIEŻEGO ekranu — z dowodem tożsamości.
 *
 * Override jedzie z karty zbudowanej po cross-checku hooka i jest autorytatywny
 * W OBIE STRONY, ale asymetrycznie ryzykowny:
 *
 * - `true` tylko ZAMYKA (karta bez przycisków, cyfra nie wyjdzie) — przyjmujemy bez dowodu;
 * - `false` OTWIERA cyfrę w formularzu, który ekran uznał za wielokrotny — a to jedyna
 *   bramka multi-select tej ścieżki. Wolno go przyjąć wyłącznie wtedy, gdy świeży ekran
 *   stoi nad TYM SAMYM pytaniem, z którego karta powstała (etykiety sąsiednich
 *   zakładek kolidują, a zakładki przełączają się bez mignięcia `agent_status`).
 *
 * Brak dowodu = oddajemy odczyt SUROWY, czyli ten z glifami — wołający idzie ścieżką
 * fail-closed (`screen-changed`).
 */
export function applyMultiSelectOverride(
  text: string, raw: ScreenDialog | null, answered: ActiveReq | null,
): ScreenDialog | null {
  const override = answered?.multiSelect;
  if (override === undefined) return raw;
  // Etykiety karty prowadzą odtworzenie zawiniętych etykiet — jak przy jej budowie.
  const labels = answered?.options.map((option) => ({
    label: option.label, description: option.description,
  }));
  if (override) return parseOptions(text, { multiSelect: true, labels });
  // Ekran i tak nie widzi wielokrotnego — override niczego nie otwiera.
  if (raw?.multiSelect !== true) return parseOptions(text, { multiSelect: false, labels });
  const forced = parseOptions(text, { multiSelect: false, labels });
  const screenQuestion = forced?.question?.question;
  const cardQuestion = answered?.question;
  if (screenQuestion === undefined || cardQuestion === undefined) return raw;
  return foldWhitespace(screenQuestion) === foldWhitespace(cardQuestion) ? forced : raw;
}
