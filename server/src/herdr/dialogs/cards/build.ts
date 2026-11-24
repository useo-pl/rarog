/**
 * Karty decyzji: gotowe pary „karta + zdarzenie protokołu".
 *
 * `ActiveReq` to karta, którą fasada drivera zapamiętuje u siebie, a `DecisionCard` — para do wysłania
 * managerowi. Budowniczowie dostają wszystko jawnie: treść z jsonl albo zrzutu hooka, opcje z cyframi
 * z ekranu, identyfikator z `cards/ids.ts`. Karta, której nie da się uzgodnić z ekranem, traci przyciski
 * zatwierdzania i zostaje przy „Odrzuć (Esc)" (`degradedCard`).
 */
import { createHash } from 'node:crypto';
import { EXIT_PLAN_MODE_TOOL } from '@rarog/shared';
import type { Question } from '@rarog/shared';
import { foreign, isServerSentence, say } from '@rarog/shared/sentences';
import type { AnyText, SentenceRef } from '@rarog/shared/sentences';
import type { DriverEvent, Truncation } from '../../../drivers/types.ts';
import { describeToolInput, parseAskUserQuestionInput } from '../../../drivers/tool-summary.ts';
import { MAX_DISPLAY_TEXT, asRecord, clipForDisplay } from '../../../drivers/tool-text.ts';
import type { ClippedText } from '../../../drivers/tool-text.ts';
import { SANDBOX_NETWORK_TOOL } from '../screen/kinds.ts';
import type { CliDialogClass } from '../../../cli-version.ts';
import type { DialogIdentityStamp } from '../screen/identity.ts';
import type { KnownDialogId } from '../screen/known.ts';
import type { ScreenReviewPair } from '../screen/review.ts';
import type { TrustArrowDialog } from '../screen/trust-arrow.ts';
import type { TerminalDialogId } from '../policy/terminal.ts';
import type { MeasuredConsentMark } from '../policy/measured-consent.ts';
import type { ScreenFallbackMark } from '../screen-fallback.ts';
import { canonicalLabel } from '../screen/options.ts';
import type { ScreenFormOption, ScreenOption } from '../screen/options.ts';
import type { PendingTool } from '../../jsonl-pending.ts';
import type { HookBudgetSource } from '../../hook-config.ts';
import type { AuditCardSource, HerdrRefuseReason } from '../../audit.ts';
import { DEGRADED_DISPLAY_TEXT, DEGRADED_UNREADABLE_TEXT } from '../copy.ts';
import { alwaysOption } from '../policy/options.ts';
import { optionPolicy } from '../policy/option-policy.ts';
// `cross-check.ts` bierze z tego pliku same typy, więc w czasie działania cyklu nie ma (jak przy `copy.ts`).
import { foldWhitespace } from '../cross-check.ts';
import type { HookAnswerTarget } from '../hook/target.ts';
import type { Layer2Mark, Layer2Why } from '../layer2/card.ts';
import { screenFormReqId } from './ids.ts';
import { optionRole } from './roles.ts';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';

/** Nazwa „narzędzia" dla dialogu, którego w jsonl NIE MA (zaufanie katalogu, zmiana modelu, MCP). */
export const SCREEN_DIALOG_TOOL = 'dialog';

/** Ile linii i znaków ekranu ma prawo trafić do transkryptu (fallback bez parsera z `herdr/dialogs/screen/`). */
const SNIPPET_MAX_LINES = 40;
const SNIPPET_MAX_CHARS = 2000;

/** Linia pytania zgody CLI — wycinana z treści karty zgody (patrz {@link screenPermissionCard}). */
const PROCEED_QUESTION = SCREEN_SIGNATURES.proceedQuestion.pattern;

/**
 * Karta, o której manager już wie.
 *
 * Typ nazwany (a nie inline), bo ponowna ocena po własnej cyfrze musi przyjąć KONKRETNĄ
 * odpowiedzianą kartę: porównanie po tożsamości obiektu odróżnia „czyszczę kartę, na którą
 * poszła cyfra" od „czyszczę kartę, która zdążyła ją zastąpić".
 */
export interface ActiveReq {
  reqId: string;
  toolName: string;
  // `ScreenFormOption`: opcja niesie `terminalOnly` z parsera — `answerQuestion` odmawia
  // wysyłki cyfry takiej opcji NIEZALEŻNIE od UI (uniwersalna karta).
  options: readonly ScreenFormOption[];
  /**
   * Etykiety opcji, które OPUBLIKOWANA karta pytania (`decisionCard`) oznaczyła `terminalOnly`, ze wszystkich jej
   * pytań, w postaci kanonicznej (`canonicalLabel`). Bramka cyfry odmawia odpowiedzi z tej listy, zanim zajrzy do
   * {@link options}: karta z etykietami payloadu liczy flagę na pełnej etykiecie, a opcje z ekranu są ucięte do
   * `OPTION_LABEL_MAX_CHARS`, więc marker eskalacji za tą granicą widzi tylko karta. Klucz kanoniczny łapie też
   * odpowiedź skróconą do samego prefiksu. Brak pola = karta bez opcji `terminalOnly` albo karta spoza
   * `decisionCard`, której flagi pochodzą z tych samych opcji z ekranu co {@link options}.
   */
  terminalOnlyLabels?: readonly string[];
  screen?: true;
  seq?: number;
  /**
   * Treść pytania z karty — dowód „to samo pytanie" przy weryfikacji przed `enter`.
   * O tym, CZY `enter` w ogóle idzie, decyduje ŻYWY odczyt przed cyfrą — nie karta.
   */
  question?: string;
  /**
   * AUTORYTATYWNY `multiSelect` z payloadu hooka, jeżeli karta powstała po cross-checku.
   *
   * Musi jechać z kartą aż do wysyłki: każde ponowne czytanie ekranu przed cyfrą
   * ({@link applyMultiSelectOverride}, `confirmFormSubmit`) parsuje ekran OD NOWA, więc bez
   * tego override'u formularz uznany za wielokrotny wyłącznie przez glify oddawałby cyfrę
   * dopiero po fail-closed — czyli nigdy.
   */
  multiSelect?: boolean;
  /**
   * Adres KANAŁU HOOKA dla tej karty — obecny tylko wtedy, gdy
   * odpowiedź wolno oddać plikiem zamiast cyfrą. Brak pola = karta odpowiada jak dotąd.
   */
  hookAnswer?: HookAnswerTarget;
  /**
   * Odcisk dialogu z ekranu, z którego powstała karta (`ScreenDialog.bodyPrint`): treść zgody z ramką
   * operacji albo blok pytania, potwierdzenia i znanego dialogu. Przed cyfrą świeży ekran musi dać
   * ten sam odcisk: etykieta i cyfra „1. Yes" nie odróżniają komendy X (rozstrzygniętej przy biurku) od komendy Y
   * ani jednego potwierdzenia od drugiego. Brak pola = dialog bez odcisku, kontrola jak dotąd (etykieta, cyfra
   * i tożsamość).
   */
  bodyPrint?: string;
  /**
   * Generacja (`at`) zrzutu `PermissionRequest`, który dał tej karcie treść albo był jej drugim
   * dowodem. Przed cyfrą zrzut musi być TEN SAM: każdy dialog zgody zapisuje nowy zrzut, a przy
   * ramce uciętej u góry dwa różne dialogi o wspólnym końcu komendy mają ten sam odcisk ekranu —
   * nowa generacja zrzutu jest wtedy jedynym śladem podmiany.
   */
  proofHookAt?: number;
  /**
   * Odcisk wywołania ({@link callPrint}) — karta z jsonl/hooka (zgoda, pytanie, karta bez przycisków).
   * Osłona po decyzji porównuje go z kartą z PRZYCISKAMI wyłącznie dla zgody na narzędzie: następna
   * zakładka formularza to to samo wywołanie, a ma dostać kartę.
   */
  callPrint?: string;
  /**
   * Komenda `Bash` ze źródła karty (wpis jsonl albo zrzut, to samo wejście co {@link callPrint}). Sama niczego nie
   * dowodzi: po decyzji Raroga driver bierze ją wyłącznie razem z ekranem sprzed klawisza, który pokazuje całą
   * ramkę tej komendy, żeby odróżnić zrzut INNEGO dialogu od zrzutu rozstrzygniętego (`otherDialogDump`).
   * Brak pola = karta bez źródła `Bash`, zrzut po decyzji znika.
   */
  command?: string;
  /** Id wpisu jsonl, gdy to on jest ŹRÓDŁEM karty. */
  callId?: string;
  /** Id wpisu jsonl stojącego w chwili budowy karty (źródło albo stęchły wpis obok zrzutu hooka). */
  pendingId?: string;
  /**
   * Wpis `pendingId` jest MŁODSZY od zrzutu, który dał karcie treść: to żywe
   * wywołanie agenta głównego obok zgody subagenta, nie stęchły wpis. Jego zmiana nie znaczy nowego
   * dialogu, więc nie zdejmuje osłony po decyzji (nowy dialog przynosi nową generację zrzutu).
   */
  pendingYounger?: true;
  /**
   * Skąd karta wzięła narzędzie i wejście, z którym porównano ekran — WYŁĄCZNIE do
   * dziennika (`approve`, `refuse`, `degrade`). Niczego nie rozstrzyga: decyzje stoją na polach wyżej. Only the reason
   * of a card without the approve button reads `agentId` and `callKey` (`CardOrigin.callKey`).
   * Brak pola = karta spoza oceny dialogu (`/model`) — wpis bez źródła.
   */
  origin?: CardOrigin;
  /**
   * Karta dialogu z listy `TERMINAL_DIALOGS`: każda opcja `terminalOnly`, a `allow`
   * odmawia bez szukania opcji. Pauza „Session paused" dodatkowo nie przyjmuje `escape`
   * (`#pauseBlocksEscape` w driverze). Brak pola = każda inna karta.
   */
  terminalDialog?: TerminalDialogId;
  /**
   * Rodzaj i tożsamość dialogu z BLOKU w chwili budowy karty: tytuł
   * i nazwa narzędzia, serwer i tytuł MCP, dialog z zamkniętej listy albo formularz. Tuż przed cyfrą
   * `#digitStillHolds` wymaga tej samej pary od świeżego odczytu, a blok `ambiguous` nie przechodzi
   * nigdy. Oddzielne od {@link toolName}, które zostaje nazwą do dziennika (`dialog:<rodzaj>`, nazwa
   * kanoniczna MCP z jsonl): dla poprawnej zgody MCP parser daje `toolName: null`. Wypełnia je każdy
   * budowniczy karty z opcjami; karta bez pola nie dostaje cyfry.
   */
  dialogIdentity?: DialogIdentityStamp;
  /**
   * Measured consent dialog of the screen the card came from: its "Yes" digit passes the consent channel gate,
   * and right before the key a fresh read has to give the same mark (`policy/measured-consent.ts`). Absent = the
   * dialog is not one of the measured shapes.
   */
  measuredConsent?: MeasuredConsentMark;
  /**
   * Emergency approve button of a consent dialog without a hook in channel mode: the facts the card was marked on
   * (`screen-fallback.ts`). Its "Yes" digit passes the gate under the live mode and class, and right before the key
   * the driver checks the rule again on fresh facts. Absent = the card is not that path.
   */
  screenFallback?: ScreenFallbackMark;
  /**
   * Ślad warstwy 2 (`RAROG_DIALOG_LAYER2=1`): karta bez przycisków z wycinkiem bloku warstwy 2 (`layer2/card.ts`).
   * Powód idzie do wpisu `block-card`, a odcisk bloku mówi decyzji, czy ten sam widok stoi dalej, czy wycinek trzeba
   * odświeżyć. Osobno od {@link bodyPrint}: niczego nie sprawdza przed cyfrą, bo taka karta cyfry nie wysyła.
   * Brak pola = każda inna karta, także każda karta przy fladze `0`.
   */
  layer2?: Layer2Mark;
  /**
   * Layer 2 card with buttons ({@link layer2QuestionCard}, `docs/dialog-card.md`): the print of the block the
   * occurrence came from. The card carries no options here on purpose: the label → key map lives in the occurrence
   * record of the driver module, so no digit path (`answerQuestion`, `allow`) finds an option on this card. Absent =
   * any other card.
   */
  layer2Card?: { readonly print: string };
  /**
   * Karta dialogu zaufania BEZ cyfr: folder z linii pod „Accessing workspace:” i sesja silnika z chwili
   * wystawienia karty. Zatwierdzenie takiej karty idzie ścieżką `down`/`enter` (`send/trust-step.ts`), nigdy cyfrą:
   * {@link options} jest puste. Brak pola = każda inna karta.
   */
  trustArrow?: TrustArrowMark;
}

/** Ślad dialogu zaufania bez cyfr na karcie ({@link ActiveReq.trustArrow}). */
export interface TrustArrowMark {
  readonly folder: string;
  /** Sesja silnika w chwili karty; driver wpisuje ją przy wystawieniu karty, a inna przed klawiszem to odmowa. */
  engineSessionId: string;
}

/**
 * Pochodzenie karty w dzienniku: źródło i identyfikatory wywołania, bez treści.
 *
 * `toolUseId` z wpisu jsonl (`tool_use.id`) albo ze zrzutu `PreToolUse`; `promptId` i `agentId`
 * wyłącznie ze zrzutu hooka, który opisuje to wywołanie (karta ze zrzutu albo podwójny dowód `Bash`).
 */
export interface CardOrigin {
  readonly source: AuditCardSource;
  readonly toolUseId?: string;
  readonly promptId?: string;
  readonly agentId?: string;
  /**
   * Per-call key of the hook dump (`PendingHookTool.callKey` in `hook/dump.ts`), only on a card built from that dump
   * (`source: 'hook'`), never through the Bash double proof of a jsonl card. It and `agentId` also pick the
   * reason of a card without the approve button (`screen-unavailable.ts`); they never give or take the button.
   */
  readonly callKey?: string;
  /**
   * Strażnik wysokości dialogu w chwili hooka: źródło budżetu i pty panelu z `LINES`/`COLUMNS`
   * zrzutu — na tych samych zasadach co `promptId` (wyłącznie ze zrzutu, który opisuje to wywołanie).
   */
  readonly budgetSource?: HookBudgetSource;
  readonly hookPaneRows?: number;
  readonly hookPaneCols?: number;
}

/** Wynik sparowania zrzutu hooka `AskUserQuestion` z formularzem na ekranie. */
export interface HookQuestion {
  /** `multiSelect` OD AUTORA pytania — nadpisuje heurystykę parsera w obie strony. */
  multiSelect: boolean;
  /** Opcje Z EKRANU (cyfry, `terminalOnly` także z pełnej etykiety payloadu) wzbogacone o opisy z hooka. */
  options: readonly ScreenFormOption[];
  /**
   * Gotowa karta na telefon dla ZAKŁADKI stojącej na ekranie: nagłówek i opisy z hooka,
   * etykiety z ekranu. To jest karta ścieżki CYFROWEJ — jedno pytanie, bo cyfra zamyka
   * dokładnie jedno.
   *
   * Treści pytania do weryfikacji przed `enter` NIE MA tutaj z rozmysłem: bierze ją
   * budowa karty z `resolution.question`, czyli z tego samego ekranu, z którego wzięły się
   * cyfry — a nie z payloadu, który mógłby brzmieć inaczej po zwinięciu białych znaków.
   */
  card: Question;
  /**
   * KOMPLET pytań z payloadu — karta kanału hooka.
   *
   * Etykiety jadą tu Z PAYLOADU, a nie z ekranu, i to jest różnica zamierzona: odpowiedź
   * kanału hooka jedzie PLIKIEM (mapa `treść pytania → wartość`), więc żadna z tych etykiet
   * nie jest adresem cyfry — a ekran pokazuje jedną zakładkę naraz i o pozostałych pytaniach
   * nie wie nic. `terminalOnly` liczy ta sama polityka co wszędzie (`optionPolicy`, kanał `hook`):
   * reguła eskalacji (`docs/dialogs.md`, „Rules: what must not be relaxed”) obowiązuje w każdym kanale.
   */
  all: readonly Question[];
  /**
   * Treść pytania ODCZYTANA Z EKRANU dla dopasowanej zakładki — dowód „to samo pytanie" przy
   * weryfikacji przed `enter`. Karta kanału hooka nie ma innego źródła tej wartości:
   * powstaje bez `resolveOptions`, więc `resolution.question` bywa wtedy nieobecne.
   */
  screenQuestion: string;
  /**
   * Odcisk bloku (`ScreenDialog.bodyPrint`) z TEGO SAMEGO parsowania co {@link options}:
   * z podpowiedzią etykiet z payloadu. Parsowanie bez niej daje przy zawiniętych etykietach o wspólnej
   * pierwszej linii `null`, czyli kartę bez odcisku. Nie wychodzi do apki: karta niesie go w `ActiveReq.bodyPrint`.
   */
  bodyPrint: string | null;
}

/** Nowa karta: co zapamiętać u siebie (`active`) i co wysłać managerowi (`event`). */
export interface DecisionCard {
  active: ActiveReq;
  event: DriverEvent;
}

/**
 * Werdykt polityki przycisków karty — zamknięta lista pola `verdict` wpisu `block-card` w dzienniku: `buttons` =
 * przycisk ma każda opcja, `partial` = część opcji tylko w terminalu (`terminalOnly`), `no-buttons` = karta bez
 * opcji albo z samymi opcjami `terminalOnly`.
 */
export const BLOCK_CARD_VERDICTS = ['buttons', 'partial', 'no-buttons'] as const;
export type BlockCardVerdict = (typeof BLOCK_CARD_VERDICTS)[number];

/** Wpis „karta bloku wystawiona” bez treści: tożsamość, nazwa narzędzia, werdykt i odcisk bloku, gdy karta go ma. */
export interface BlockCardRecord {
  readonly reqId: string;
  readonly toolName: string;
  readonly verdict: BlockCardVerdict;
  readonly print?: string;
  /** Karta warstwy 2 (`ActiveReq.layer2`): powód z zamkniętej listy `LAYER2_WHYS`; brak = karta bez warstwy 2. */
  readonly layer2Why?: Layer2Why;
  /** Layer 2 card with buttons (`ActiveReq.layer2Card`): `true`, without a reason. */
  readonly layer2?: true;
}

/**
 * Wpis „karta bloku wystawiona” dla karty zbudowanej z samego ekranu (`origin.source === 'screen'`); `null` = karta
 * z wpisu jsonl albo ze zrzutu hooka. Czyta gotową kartę i niczego w niej nie zmienia.
 */
export function blockCardRecord(active: ActiveReq): BlockCardRecord | null {
  if (active.origin?.source !== 'screen') return null;
  // A layer 2 card has its buttons in the occurrence record, not in `options`.
  if (active.layer2Card !== undefined) {
    return {
      reqId: active.reqId, toolName: active.toolName, verdict: 'buttons', print: active.layer2Card.print, layer2: true,
    };
  }
  const buttons = active.options.filter((option) => option.terminalOnly !== true).length;
  const verdict: BlockCardVerdict = buttons === 0
    ? 'no-buttons'
    : (buttons === active.options.length ? 'buttons' : 'partial');
  return {
    reqId: active.reqId,
    toolName: active.toolName,
    verdict,
    ...(active.bodyPrint === undefined ? {} : { print: active.bodyPrint }),
    ...(active.layer2 === undefined ? {} : { layer2Why: active.layer2.why }),
  };
}

/**
 * Pytania z payloadu autora na karcie kanału `keys`: każda opcja to odpowiedź (patrz {@link optionRole}).
 *
 * `terminalOnly` daje polityka opcji w kanale cyfry (`optionPolicy`) na PEŁNEJ etykiecie ze zwiniętymi białymi
 * znakami (`foldWhitespace`). Złamanie linii w środku markera („this\nsession”) nie gubi więc eskalacji, a marker
 * dalej niż `OPTION_LABEL_MAX_CHARS` znaków nie znika, jak w `canonicalLabel`, który ucina. Bez flagi opcja
 * eskalująca miała na telefonie przycisk, którego cyfrę serwer odmawiał. Wielokrotny wybór i notatka blokują samą
 * cyfrę (`digitBlocked`), nie przycisk karty, a dialog z listy terminalowej nie jest pytaniem z payloadu.
 */
function payloadAnswers(questions: readonly Question[]): Question[] {
  return questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({
      ...option,
      ...(optionPolicy({
        label: foldWhitespace(option.label), terminalDialog: null, multiSelect: false, notesEditing: false,
      }, 'digit').terminalOnly ? { terminalOnly: true } : {}),
      role: 'answer' as const,
    })),
  }));
}

/** Klucze kanoniczne opcji z `terminalOnly` ze wszystkich pytań karty (patrz `ActiveReq.terminalOnlyLabels`). */
function terminalOnlyLabels(questions: readonly Question[]): string[] {
  return questions.flatMap((question) => question.options
    .filter((option) => option.terminalOnly === true)
    .map((option) => canonicalLabel(option.label)));
}

/**
 * Treść karty zgody dla `ExitPlanMode`: PLAN, a nie zrzut JSON-a.
 *
 * `tool_input` tego narzędzia niesie `plan` (pełny tekst) i `planFilePath` (plik w
 * `~/.claude/plans/`, czyli poza korzeniami Raroga). Domyślny opis inputu pokazałby oba pola
 * jako JSON z `\n` zamiast złamań linii — czyli plan nieczytelny dokładnie na tej karcie,
 * na której człowiek ma go PRZECZYTAĆ przed zgodą. Ryzyka to nie dotyczy: klasyfikator
 * dostaje pełny `input` osobno (`tool-text.ts`), więc przycięcie prezentacji niczego przed
 * nim nie chowa.
 */
export function planDisplayText(toolName: string, input: unknown): ClippedText | null {
  if (toolName !== EXIT_PLAN_MODE_TOOL) return null;
  const plan = asRecord(input)?.['plan'];
  return typeof plan === 'string' && plan.trim() !== ''
    ? clipForDisplay(plan, MAX_DISPLAY_TEXT)
    : null;
}

/**
 * Minimalny wycinek ekranu — używany TYLKO, gdy nikt nie wstrzyknął parsera z `herdr/dialogs/screen/`.
 *
 * Celowo ubogi: prawdziwy parser (ANSI, ramki, warianty dialogów) należy do S-herdr. Tutaj chodzi
 * o to, żeby driver bez wstrzykniętego parsera nie milczał o tym, że agent na coś czeka.
 * Wynik jedzie na KARTĘ (`screen`), a nie do transkryptu; `hash` jest w kształcie, bo tak
 * wygląda kontrakt `ScreenSnippet` wstrzykiwany z `herdr/dialogs/screen/`.
 */
export function fallbackSnippet(text: string): { text: string; hash: string } | null {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd());
  while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  if (lines.length === 0) return null;
  const clipped = lines.slice(-SNIPPET_MAX_LINES).join('\n').slice(0, SNIPPET_MAX_CHARS);
  if (clipped.trim() === '') return null;
  return { text: clipped, hash: createHash('sha256').update(clipped.slice(0, 512)).digest('hex') };
}

/**
 * Karta ZGODY zbudowana z ekranu — dla dialogu `tool` bez wpisu w jsonl.
 * Treść jedzie dosłownie, z jednym cięciem: linia „Do you want to proceed?"
 * jest boilerplate'em CLI, a karta zgody SAMA jest tym pytaniem (para Odrzuć/Zatwierdź) —
 * powtórzona linia tylko rozpychałaby kartę. `input` niesie tę samą treść pod kluczem
 * `screen`, bo `input: null` znaczy w managerze „karta nie do zatwierdzenia" (`docs/security-model.md`, „herdr sessions: Rarog writes to a terminal it does not own”, pkt 17),
 * a tu Rarog dokładnie wie, co zatwierdza: dosłowny dialog + cyfra po treści etykiety.
 * `reqId` z TREŚCI (jak karta pytania) — mignięcie `blocked→working→blocked` nad stojącym
 * dialogiem odtwarza kartę z tym samym identyfikatorem.
 */
export function screenPermissionCard(
  form: {
    header: string; question: string; options: readonly ScreenFormOption[];
    toolName?: string | null;
    bodyPrint?: string | null;
    /** Nazwa pliku planu ze stopki dialogu planu — wchodzi do `reqId` (`screenFormReqId`). */
    planFile?: string;
    dialogIdentity: DialogIdentityStamp;
  },
  seq: number,
): DecisionCard {
  const reqId = screenFormReqId('p', form);
  const toolName = form.toolName ?? SCREEN_DIALOG_TOOL;
  const displayText = form.question
    .split('\n')
    .filter((line) => line.trim() !== PROCEED_QUESTION)
    .join('\n')
    .trim();
  // Dialog sieci sandboksa: tylko „Yes” (host do końca sesji), bez „zawsze”: „Yes, and don't ask again for <host>"
  // zostaje do wybrania przy biurku.
  const always = toolName === SANDBOX_NETWORK_TOOL ? null : alwaysOption(form.options);
  return {
    active: {
      reqId, toolName, options: form.options, screen: true, seq,
      ...(form.bodyPrint === undefined || form.bodyPrint === null ? {} : { bodyPrint: form.bodyPrint }),
      dialogIdentity: form.dialogIdentity,
    },
    event: {
      type: 'permission-request',
      reqId,
      toolName,
      input: { screen: displayText },
      // Treść dialogu z ekranu: tekst obcy, bez kodu zdania.
      ...cardText(foreign(displayText)),
      ...(always === null ? {} : { alwaysLabel: always.label }),
    },
  };
}

/**
 * Karta pytania LUB potwierdzenia zbudowana Z EKRANU — jedyna, która działa
 * na żywo.
 *
 * Ścieżka jsonl ({@link decisionCard} z `kind: 'question'`) ZOSTAJE: gdyby przyszły silnik
 * zapisywał `tool_use` przed rozstrzygnięciem, karta z pełnym inputem (opisy opcji,
 * multi-select) jest lepsza od ekranowej. Odpowiedź idzie tą samą drogą co zawsze:
 * `answerQuestion` wybiera cyfrę po TEKŚCIE etykiety z aktywnej karty.
 *
 * `kind: 'confirm'` (silnik dialogów) jedzie tą samą kartą: dialog potwierdzenia ustawień
 * CLI, którego Rarog nie zamawiał (np. postawiony ręcznie w terminalu), dostaje na telefonie
 * DOSŁOWNĄ treść i DOSŁOWNE etykiety opcji — bez interpretacji i bez opcji domyślnej, więc
 * granica „przyciski tylko dla dialogów, które Rarog rozumie” (`docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 14; żadnego klikania w cudze dialogi bez wiedzy, co zatwierdzają) jest
 * zachowana: wie człowiek, bo czyta dokładnie to, co stoi w terminalu.
 */
export function screenQuestionCard(
  form: {
    kind: 'question' | 'confirm' | 'tool';
    header: string; question: string; options: readonly ScreenFormOption[];
    submit?: 'digit' | 'digit-enter';
    /** Dialog z listy `TERMINAL_DIALOGS`: karta bez decyzji, opcje już z `terminalOnly`. */
    terminalDialog?: TerminalDialogId;
    /** Odcisk bloku z ekranu karty; `null` albo brak = karta bez odcisku. */
    bodyPrint?: string | null;
    dialogIdentity: DialogIdentityStamp;
  },
  seq: number,
  review: readonly ScreenReviewPair[] | null = null,
): DecisionCard {
  const reqId = screenFormReqId('q', form);
  // Pytanie zapasowe (karta z ekranu bez treści pytania): zdanie `dialogs.fallback-question.<rodzaj>`.
  const fallback = say(`dialogs.fallback-question.${form.kind}`);
  const questions: Question[] = [{
    // Kod pytania tylko przy pytaniu zapasowym; treść z ekranu jest tekstem autora pytania (obcym).
    ...questionText(form.question === '' ? fallback : foreign(form.question)),
    header: form.header,
    multiSelect: false,
    /*
     * Pola addytywne kontraktu jadą na telefon TYLKO, gdy są (stary klient je ignoruje):
     *
     * - `terminalOnly` — UI wyszarza taką opcję, a bramka w `answerQuestion` i tak odmówi
     *   jej cyfry;
     * - `description` — opis spod etykiety, odczytany z ekranu; bez niego karta
     *   ekranowa miałaby same etykiety, choć autor pytania napisał, czym warianty się różnią.
     */
    options: form.options.map((option) => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
      ...(option.terminalOnly === true ? { terminalOnly: true } : {}),
      // Opcje Z EKRANU: chrome CLI dostaje swoją rolę, reszta jest odpowiedzią.
      role: optionRole(option.label),
    })),
    /*
     * Ekran PRZEGLĄDU formularza: pary „pytanie → odpowiedzi" liczy serwer, klient
     * rysuje z nich listę. Treść pytania zostaje dosłowna — stary klient pokazuje ją jak dotąd.
     */
    ...(review === null
      ? {}
      : { review: review.map((pair) => ({ question: pair.question, answers: [...pair.answers] })) }),
  }];
  return {
    active: {
      reqId,
      // `dialog:question` / `dialog:confirm` w dzienniku odpowiada na „co zatwierdzono"
      // tak samo jak `dialog:trust` — samo `dialog` nie odpowiadałoby wcale.
      toolName: `${SCREEN_DIALOG_TOOL}:${form.kind}`,
      options: form.options,
      screen: true,
      seq,
      // Dowód „to samo pytanie" dla weryfikacji przed `enter` — sam tryb zatwierdzania
      // rozstrzyga żywy odczyt przed cyfrą, nie karta.
      question: form.question,
      ...(form.terminalDialog === undefined ? {} : { terminalDialog: form.terminalDialog }),
      ...(form.bodyPrint === undefined || form.bodyPrint === null ? {} : { bodyPrint: form.bodyPrint }),
      dialogIdentity: form.dialogIdentity,
    },
    // Karta czysto ekranowa odpowiada CYFRĄ i tylko cyfrą — kanał deklarujemy jawnie, żeby
    // manager nie musiał wnioskować z braku pola (przy cyfrze wielokrotny wybór odpada).
    event: { type: 'question-request', reqId, questions, channel: 'keys' },
  };
}

/** Tool name of a layer 2 card in the audit log (`dialog:<kind>` like the other screen cards). */
export const LAYER2_CARD_TOOL = `${SCREEN_DIALOG_TOOL}:layer2`;

/**
 * Layer 2 card with buttons (`docs/dialog-card.md`): one question whose text is the whole literal block, from
 * its title to the footer, whose header is the block title and whose options are the literal labels of the verdict's
 * choices (digit options and footer keys), in screen order. Channel `keys`, no `terminalOnly`, no free answer: the app
 * draws it like any immediate question card.
 *
 * `reqId` is the occurrence id (`l2:<12 hex>`) the driver module gave the card. The active card carries no options
 * and only the block print ({@link ActiveReq.layer2Card}): what a label sends stays in the occurrence record.
 */
export function layer2QuestionCard(
  reqId: string, verdict: { readonly title: string; readonly block: string; readonly print: string;
    readonly choices: readonly { readonly label: string }[] }, seq: number,
): DecisionCard {
  const questions: Question[] = [{
    // The block is CLI text on a foreign pane (foreign), never a server sentence.
    ...questionText(foreign(verdict.block)),
    header: verdict.title,
    multiSelect: false,
    options: verdict.choices.map((choice) => ({ label: choice.label, role: optionRole(choice.label) })),
  }];
  return {
    active: {
      reqId,
      toolName: LAYER2_CARD_TOOL,
      options: [],
      screen: true,
      seq,
      origin: { source: 'screen' },
      layer2Card: { print: verdict.print },
    },
    event: { type: 'question-request', reqId, questions, channel: 'keys' },
  };
}

/**
 * Karta z PEŁNĄ treścią z jsonl i cyframi z ekranu — jedyna, która ma przyciski.
 *
 * @param hookQuestion pytanie ze zrzutu hooka SPAROWANE z ekranem. Obecne wyłącznie
 *        na ścieżce hooka i wyłącznie po cross-checku: wtedy karta bierze z niego nagłówek,
 *        opisy i `multiSelect`, a etykiety z cyframi dalej pochodzą z EKRANU. Nieobecne =
 *        kształt pytania prosto z `tool_input`.
 * @param hookAnswer adres KANAŁU ODPOWIEDZI. Obecny = karta niesie
 *        KOMPLET pytań ze zrzutu i deklaruje `channel: 'hook'`, bo odpowiedź pojedzie plikiem;
 *        wielopytaniowość i `multiSelect` przestają być wtedy problemem, a etykiety pochodzą
 *        z payloadu (ekran pokazuje jedną zakładkę i o reszcie nie wie nic). Nieobecny = karta
 *        jednej zakładki z cyframi z ekranu, jak dotąd.
 */
export function decisionCard(
  reqId: string,
  pending: PendingTool,
  kind: 'tool' | 'question',
  options: readonly ScreenFormOption[],
  question: string | null,
  hookQuestion: HookQuestion | null = null,
  hookAnswer: HookAnswerTarget | null = null,
): DecisionCard {
  const active: ActiveReq = {
    reqId,
    toolName: pending.toolName,
    // Opcje z hooka to TE SAME opcje z ekranu, tylko z flagą `terminalOnly` — bramka
    // eskalacji (`docs/dialogs.md`, „Rules: what must not be relaxed”) w `answerQuestion` działa dzięki niej także na tej ścieżce.
    options: hookQuestion?.options ?? options,
    // Formularz z preview zdarza się też na ścieżce jsonl/hooka. Treść pytania
    // idzie Z EKRANU: bez niej weryfikacja przed `enter` nie umiałaby
    // dowieść „to samo pytanie" — a etykiety sąsiednich zakładek potrafią brzmieć
    // identycznie („Tak"/„Nie"). Tryb zatwierdzania rozstrzyga żywy odczyt przed cyfrą.
    ...(kind === 'question' && question !== null ? { question } : {}),
    ...(hookQuestion === null ? {} : { multiSelect: hookQuestion.multiSelect }),
    // Kanał odpowiedzi jedzie Z KARTĄ, a nie jest czytany w chwili decyzji: adres ma pochodzić
    // z tego samego zrzutu, z którego powstała treść, jaką człowiek widzi na telefonie.
    ...(hookAnswer === null ? {} : { hookAnswer }),
  };
  if (kind === 'question') {
    /*
     * Kanał odpowiedzi rozstrzyga, ILE pytań niesie karta:
     *
     * - `hook` — KOMPLET ze zrzutu (`all`), bo `allow` domyka całe wywołanie naraz i pytania
     *   2..n nie dostaną już własnej zakładki do odpowiedzenia;
     * - `keys` — jedna zakładka, ta stojąca na ekranie: cyfra zamyka dokładnie jedno pytanie.
     */
    const parsed = hookQuestion === null ? parseAskUserQuestionInput(pending.input) : null;
    const questions = hookAnswer !== null && hookQuestion !== null
      ? [...hookQuestion.all]
      : (hookQuestion === null ? (parsed === null ? null : payloadAnswers(parsed)) : [hookQuestion.card]);
    if (questions !== null) {
      // Werdykt `terminalOnly` z TEJ karty jedzie do bramki cyfry (`ActiveReq.terminalOnlyLabels`): w kanale `keys`
      // z etykietami payloadu i przy odpowiedzi kanału `hook`, która trafia na tor cyfry.
      const blocked = terminalOnlyLabels(questions);
      return {
        active: blocked.length === 0 ? active : { ...active, terminalOnlyLabels: blocked },
        event: {
          type: 'question-request',
          reqId,
          questions,
          channel: hookAnswer === null ? 'keys' : 'hook',
        },
      };
    }
    // Kształt inputu inny niż `questions[]` — lepiej pokazać kartę zgody niż zgubić turę.
  }
  const always = alwaysOption(options);
  const shown = planDisplayText(pending.toolName, pending.input) ?? describeToolInput(pending.toolName, pending.input);
  return {
    active,
    event: {
      type: 'permission-request',
      reqId,
      toolName: pending.toolName,
      input: pending.input,
      // Plan albo input narzędzia od agenta (tekst obcy); stopkę ucięcia opisuje `truncation`, które manager przenosi
      // na kartę (`PermissionRequest.truncation`).
      ...cardText(foreign(shown.text), shown.truncation),
      ...(always === null ? {} : { alwaysLabel: always.label }),
    },
  };
}

/**
 * Karta dialogu, którego NIE MA w jsonl (`docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 14).
 *
 * Nie jest kartą zgody i celowo nią nie jest: bez wpisu w transkrypcie nie ma `tool_input`,
 * nie ma `permId` i nie ma czego klasyfikować ryzykiem. Człowiek dostaje wycinek ekranu
 * (pole `screen`, NA KARCIE) plus dokładnie te akcje, które Rarog umie wykonać uczciwie.
 *
 * Opcje trzymamy WYŁĄCZNIE dla dialogu rozpoznanego z sygnatury — `[]` dla każdego innego
 * zamyka drogę do zatwierdzenia w samym driverze, niezależnie od tego, co zdecyduje UI.
 *
 * `knownDialog` wraca do wołającego, bo dialog ZAUFANIA znaczy „za chwilę ten agent może
 * zniknąć i wrócić" — meldunek do nadzorcy wysyła fasada, tu go nie ma czym wysłać.
 *
 * `layer2` to ślad warstwy 2 (powód i odcisk bloku) przy karcie z wycinkiem bloku warstwy 2; ląduje w
 * `ActiveReq.layer2`, nie w zdarzeniu: apka dostaje tę samą kartę co bez flagi.
 */
export function screenDialogCard(
  reqId: string,
  resolved: {
    knownDialog: KnownDialogId | null; options: readonly ScreenOption[]; dialogIdentity?: DialogIdentityStamp | null;
    /** Odcisk bloku znanego dialogu; karta bez rozpoznania go nie niesie. */
    bodyPrint?: string | null;
    /** Dialog zaufania bez cyfr; karta niesie jego folder do kontroli przed `down` i `enter`. */
    trustArrow?: TrustArrowDialog | undefined;
  } | null,
  reason: HerdrRefuseReason | null = null,
  screen: string | null = null,
  cliDialog: CliDialogClass | null = null,
  origin: CardOrigin | null = null,
  layer2: Layer2Mark | null = null,
): DecisionCard & { knownDialog: KnownDialogId | null } {
  const knownDialog = resolved?.knownDialog ?? null;
  const options = knownDialog === null ? [] : resolved?.options ?? [];
  // Powód I wycinek ekranu niesie WYŁĄCZNIE karta bez przycisków (`docs/implementation-spec.md`, „Session fields and herdr frames”): dialog rozpoznany
  // z sygnatury ma własne, dosłowne zdanie w kliencie — doklejony do niego powód mówiłby o odmowie,
  // której nie było, a zrzut ekranu powtarzałby tę samą treść surowym pismem. Klasa z rejestru
  // CLI jedzie tą samą drogą: opisuje dialog, którego Rarog nie rozpoznał.
  const carried = knownDialog === null
    ? {
      ...(reason === null ? {} : { reason }),
      ...(screen === null ? {} : { screen }),
      ...(cliDialog === null ? {} : { cliDialog }),
    }
    : {};
  return {
    knownDialog,
    active: {
      reqId,
      // Nazwa jedzie do DZIENNIKA (nie na telefon): `dialog:trust` odpowiada na pytanie
      // „co zatwierdzono", a samo `dialog` nie odpowiadałoby na nie wcale.
      toolName: knownDialog === null ? SCREEN_DIALOG_TOOL : `${SCREEN_DIALOG_TOOL}:${knownDialog}`,
      options,
      screen: true,
      ...(origin === null ? {} : { origin }),
      // Tożsamość tylko przy karcie z przyciskiem (znany dialog): karta bez opcji nie wysyła cyfry.
      ...(knownDialog === null || resolved?.dialogIdentity == null ? {} : { dialogIdentity: resolved.dialogIdentity }),
      // Odcisk bloku też: kontrola przed cyfrą porówna go ze świeżym odczytem.
      ...(knownDialog === null || resolved?.bodyPrint == null ? {} : { bodyPrint: resolved.bodyPrint }),
      // Ślad warstwy 2 tylko przy karcie bez przycisków (wycinek bloku bez cyfr); flaga `0` go nie daje.
      ...(knownDialog !== null || layer2 === null ? {} : { layer2 }),
      // Dialog zaufania bez cyfr: sesję silnika dopisuje fasada, która ją zna.
      ...(knownDialog !== 'trust' || resolved?.trustArrow === undefined
        ? {}
        : { trustArrow: { folder: resolved.trustArrow.folder, engineSessionId: '' } }),
    },
    event: knownDialog === null
      ? { type: 'screen-dialog', ...carried }
      : { type: 'screen-dialog', knownDialog },
  };
}

/** Pola treści karty zgody w zdarzeniu drivera. */
type CardTextFields = Pick<
  Extract<DriverEvent, { type: 'permission-request' }>, 'displayText' | 'displayTextRef' | 'truncation'
>;

/**
 * Ujście treści karty zgody: JEDYNE miejsce w tym pliku, gdzie powstaje `displayText` (strażnik pochodzenia zdań,
 * `server/test/sentence-origin-guard.test.ts`). Zdanie z `say()` daje tekst i kod (`displayTextRef`); tekst obcy
 * (ekran, plan, input narzędzia) sam tekst, a ucięcie stopką jedzie obok (`truncation`).
 */
function cardText(text: AnyText, truncation?: Truncation): CardTextFields {
  return {
    displayText: text.text,
    ...(isServerSentence(text) ? { displayTextRef: text.ref } : {}),
    ...(truncation === undefined ? {} : { truncation }),
  };
}

/** Ujście treści pytania karty: JEDYNE miejsce w tym pliku z `questionRef`; kod tylko przy zdaniu z `say()`. */
function questionText(text: AnyText): { question: string; questionRef?: SentenceRef } {
  return { question: text.text, ...(isServerSentence(text) ? { questionRef: text.ref } : {}) };
}

/**
 * Karta BEZ przycisków zatwierdzania (fail-closed).
 *
 * Trafia tu karta, która MA wpis w jsonl, ale nie da się jej z ekranem uzgodnić: rozjazd
 * nazwy narzędzia albo ekran nie do odczytania po ponowieniu (dialog spoza jsonl ma
 * własną kartę — {@link screenDialogCard}). `input: null` jest UMOWĄ z managerem (`docs/security-model.md`, „herdr sessions: Rarog writes to a terminal it does not own”, pkt 17):
 * karta bez inputu dostaje `risk: 'red'` bez pytania klasyfikatora, a UI zostawia na niej
 * wyłącznie „Odrzuć (Esc)". Pusta lista opcji zamyka drugą furtkę —
 * `respondPermission(…, 'allow')` nie ma tu czego znaleźć.
 */
export function degradedCard(
  reqId: string,
  pending: PendingTool | null,
  reason: HerdrRefuseReason | null = null,
  screen: string | null = null,
  /**
   * Nazwa narzędzia, którą pokazuje EKRAN, gdy przeczy wpisowi jsonl (`mismatch / tool-name`).
   * Karta nosi wtedy nazwę z ekranu, inaczej karta „Read" mogłaby stanąć nad dialogiem `Bash`.
   * Dziennik `degrade` zostaje przy nazwie ze źródła (`#applyDecision`), zrzut odmowy ma obie.
   */
  screenToolName: string | null = null,
): DecisionCard {
  const toolName = screenToolName ?? pending?.toolName ?? SCREEN_DIALOG_TOOL;
  return {
    active: { reqId, toolName, options: [] },
    event: {
      type: 'permission-request',
      reqId,
      toolName,
      input: null,
      ...cardText(reason === 'unreadable' ? DEGRADED_UNREADABLE_TEXT : DEGRADED_DISPLAY_TEXT),
      // Powód degradacji (`docs/implementation-spec.md`, „Session fields and herdr frames”) — ta sama wartość, która poszła do dziennika odmów.
      ...(reason === null ? {} : { reason }),
      // …a obok niego to, CO WIDAĆ w panelu: karta bez `input` nie ma innej treści,
      // więc bez wycinka mówiłaby wyłącznie „nie umiem tego złożyć".
      ...(screen === null ? {} : { screen }),
    },
  };
}
