/**
 * „Jaka karta stoi na telefonie" — CZYSTA decyzja poza driverem.
 *
 * Tutaj wchodzą DANE (ekran, zrzut hooka, wpis z jsonl, stan stojącej karty, numery blokady),
 * wychodzi OPIS CZYNNOŚCI — a wykonuje ją driver. Dzięki temu tabela przypadków z pomiarów
 * jest testem jednostkowym, nie scenariuszem integracyjnym.
 *
 * Granica jest wąska z rozmysłem i biegnie po odczycie ekranu:
 *
 * - PRZED nią zostaje w driverze wszystko, co dotyczy CYKLU ŻYCIA panelu i kosztu odczytu
 *   (panel poza zasięgiem, `status !== 'blocked'`, karencja debounce'u, bramka „ten sam
 *   `reqId` z pliku"). Wciągnięcie tych bramek tutaj kazałoby czytać ekran tam, gdzie dziś
 *   nie jest czytany — a `agent.read` to ruch po gnieździe, nie zmienna.
 * - PO niej nie ma już ani jednego skutku ubocznego: audyt odmowy, gaszenie starej karty
 *   i wystawienie nowej opisuje {@link DecideAction}, w tej samej KOLEJNOŚCI, w jakiej robił
 *   je driver (audyt → clear → open).
 *
 * Czystość jest warunkowa i tak jest zamierzone: czytnik rozpoznania (`resolve`) wchodzi przez
 * wejście, bo trafia dokładnie tam, gdzie trafiał w driverze. Zrzut hooka przychodzi za to
 * WARTOŚCIĄ (`hookRaw`), a nie czytnikiem: driver czyta plik dokładnie RAZ na ocenę,
 * żeby treść karty i adres odpowiedzi pochodziły z tej samej generacji zrzutu.
 */
import type { PendingHookTool } from '../hook/dump.ts';
import { HOOK_PERMISSION_REQUEST_EVENT } from '../hook/contract.ts';
import type { PendingTool } from '../../jsonl-pending.ts';
import type { AuditMismatchReason, HerdrRefuseReason } from '../../audit.ts';
import { isReviewForm, reviewPairsFrom } from '../screen/review.ts';
import { bashCommand } from '../screen/operation.ts';
import { parseOptions, screenOnlyDialog } from '../screen/parse.ts';
import { blockExcerpt } from '../screen/excerpt.ts';
import { blockNoDigitsExcerpt } from '../layer2/card.ts';
import { composerRegionState } from '../../../drivers/herdr/commands.ts';
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestionInput } from '../../../drivers/tool-summary.ts';
import type { DecisionResolution, ExpectedDecision } from '../screen/resolve.ts';
import type { DialogIdentityStamp } from '../screen/identity.ts';
import {
  decisionCard, degradedCard, screenPermissionCard, screenQuestionCard,
} from '../cards/build.ts';
import {
  degradedReqId, hookQuestionReqId, isDegradedOf, screenFallbackReqId, screenFormReqId,
} from '../cards/ids.ts';
import {
  callPrint, foldWhitespace, hookMatchesPending, hookMatchesScreen, hookQuestionFrom, jsonlYoungerThanHook,
} from '../cross-check.ts';
import { dialogShapeOf, refuseReasonFor, screenRefuseReason } from './reasons.ts';
import { mcpFrameShows, measuredConsentOf } from '../policy/measured-consent.ts';
import { SANDBOX_NETWORK_TOOL } from '../screen/kinds.ts';
import { hookAnswerTargetFor } from '../hook/target.ts';
import type { CardOrigin, DecisionCard, HookQuestion } from '../cards/build.ts';
import {
  admittedHook, bashDoubleProof, competingSources, decideReqId, expectedFor, settleCompeting,
} from './sources.ts';
import type { DecideAction, DecideInput, DecidedShield, DegradeDiagnosis } from './input.ts';

/** Kształt karty bez decyzji z ekranu tej oceny i podpowodu (patrz {@link DegradeDiagnosis}). */
function diagnose(text: string | null, mismatchReason: AuditMismatchReason | null): DegradeDiagnosis {
  return { mismatchReason, ...dialogShapeOf(text) };
}

/**
 * Pochodzenie karty zbudowanej ze źródła `source` (wpis jsonl albo zrzut hooka w kształcie `PendingTool`).
 *
 * Wpis jsonl daje `tool_use.id`; identyfikatory ze zrzutu (`prompt_id`, `agent_id`, `tool_use_id`
 * zrzutu `PreToolUse`) dochodzą WYŁĄCZNIE wtedy, gdy zrzut opisuje to samo wywołanie: karta ze zrzutu,
 * `Bash` z podwójnym dowodem albo formularz `AskUserQuestion` zgodny z wpisem (`hookMatchesPending`).
 * Zrzut obok innego wywołania nie przypisuje mu swojej tury.
 */
function originOf(input: DecideInput, source: PendingTool, pending: PendingTool | null): CardOrigin {
  const raw = input.hookRaw;
  const fromHook = raw === null ? {} : {
    ...(raw.toolUseId === undefined ? {} : { toolUseId: raw.toolUseId }),
    ...(raw.promptId === undefined ? {} : { promptId: raw.promptId }),
    ...(raw.agentId === undefined ? {} : { agentId: raw.agentId }),
    ...(raw.budgetSource === undefined ? {} : { budgetSource: raw.budgetSource }),
    ...(raw.paneRows === undefined ? {} : { hookPaneRows: raw.paneRows }),
    ...(raw.paneCols === undefined ? {} : { hookPaneCols: raw.paneCols }),
  };
  if (pending !== null && source.id === pending.id) {
    const sameCall = bashDoubleProof(pending, raw) || hookMatchesPending(pending, raw);
    return { source: 'jsonl', ...(sameCall ? fromHook : {}), toolUseId: pending.id };
  }
  // The call key binds a desk release to the card, so only a card built from that very dump carries it: the
  // double proof matches by command and time and would lend another call's reason to a jsonl card.
  return { source: 'hook', ...fromHook, ...(raw?.callKey === undefined ? {} : { callKey: raw.callKey }) };
}

const SCREEN_ORIGIN: CardOrigin = { source: 'screen' };

/** Karta z pochodzeniem w `ActiveReq` — jedyne miejsce, w którym `decideCard` je dokłada. */
function withOrigin(card: DecisionCard, origin: CardOrigin): DecisionCard {
  return { ...card, active: { ...card.active, origin } };
}

/** Karta z tożsamością dialogu z bloku — patrz `ActiveReq.dialogIdentity`. */
function withIdentity(card: DecisionCard, dialogIdentity: DialogIdentityStamp): DecisionCard {
  return { ...card, active: { ...card.active, dialogIdentity } };
}

/** Formularz `AskUserQuestion` nie ma nazwy w bloku: rodzaj `question`, tożsamość `form`. */
const QUESTION_FORM_IDENTITY: DialogIdentityStamp = { kind: 'question', identity: { kind: 'form' } };

const KEEP: DecideAction = { kind: 'keep', touchSeq: false };
const KEEP_TOUCH: DecideAction = { kind: 'keep', touchSeq: true };

/**
 * Czy osłona po decyzji obowiązuje w TEJ ocenie. Zdejmują ją od razu — nowy dialog ma dostać kartę bez
 * czekania — nowa blokada, wpis jsonl INNY niż ten, który stał przy decyzji, nowa generacja zrzutu hooka
 * `PermissionRequest` (po decyzji zrzut rozstrzygniętego dialogu jest kasowany, więc każdy nowy to nowy dialog)
 * i upływ terminu (driver podaje wtedy `null`). Wpis MŁODSZY od zrzutu karty (`pendingYounger`) nie jest
 * kotwicą: agent główny pracuje obok zgody subagenta i zmienia wpis bez nowego dialogu.
 *
 * Zrzut INNEGO dialogu decyzja zostawia (`otherDialogDump`): zgoda `Bash` subagenta
 * w kolejce za rozstrzygniętym dialogiem. Osłony nie zdejmuje, także wtedy, gdy doszedł w trakcie wysyłki klawisza
 * i migawka sprzed klawisza go nie zna: driver podaje jego generację w `keptHookAt`. Jego dialog przechodzi osłonę
 * mimo to: ma inną komendę niż rozstrzygnięty, więc inną tożsamość karty (sam zrzut, `hook:<generacja>`), inny
 * odcisk wywołania (`callPrint`), inną ramkę w `bodyPrint` i inną tożsamość ekranową. Rozstrzygnięty dialog, wciąż
 * na ekranie, zatrzymuje się na nich.
 */
function decidedShield(input: DecideInput): DecidedShield | null {
  const decided = input.decided;
  if (decided === null || decided.seq !== input.blockedSeq) return null;
  const anchor = decided.callId ?? (decided.pendingYounger ? null : decided.pendingId);
  if (anchor !== null && input.pending !== null && input.pending.id !== anchor) return null;
  const hook = input.hookRaw;
  if (hook !== null && hook.hookEventName === HOOK_PERMISSION_REQUEST_EVENT
    && hook.at !== decided.hookAt && hook.at !== decided.keptHookAt) return null;
  return decided;
}

/**
 * Czy na ekranie stoi DOKŁADNIE rozstrzygnięty dialog — po odcisku treści z ramką (`bodyPrint`) albo po
 * tożsamości ekranowej (`screenFormReqId`), obu z migawki sprzed klawisza. Niezależne od źródła karty: łapie
 * kartę z ekranu odbudowaną z jsonl, który dopiero doszedł, i odwrotnie, a inny
 * czytelny dialog — następną zakładkę, inną operację — przepuszcza.
 */
function sameDecidedDialog(input: DecideInput, decided: DecidedShield, text: string | null): boolean {
  if (text === null) return false;
  if (decided.bodyPrint !== null && parseOptions(text)?.bodyPrint === decided.bodyPrint) return true;
  if (decided.screenReqId === null) return false;
  const screen = input.resolve(text, null);
  return screen.status === 'no-jsonl' && screen.questionForm !== null
    && screenFormReqId(screen.questionForm.kind === 'tool' ? 'p' : 'q', screen.questionForm) === decided.screenReqId;
}

/**
 * Materiał osłony po decyzji na karcie z jsonl/hooka: odcisk wywołania, źródło, wpis obok. `pendingYounger`
 * = źródłem jest zrzut STARSZY niż wpis obok. Komenda `Bash` źródła idzie z nimi:
 * po decyzji odróżnia zrzut innego dialogu od zrzutu rozstrzygniętego (`otherDialogDump`).
 */
function withCall(
  card: DecisionCard, source: PendingTool, pending: PendingTool | null, pendingYounger = false,
): DecisionCard {
  // `pending` = SUROWY wpis jsonl z wejścia (przed rozstrzygnięciem konkurencji wpisu i zrzutu).
  const command = bashCommand(source.toolName, source.input);
  return {
    ...card,
    active: {
      ...card.active,
      callPrint: callPrint(source.toolName, source.input),
      ...(command === null ? {} : { command }),
      ...(pending !== null && source.id === pending.id ? { callId: pending.id } : {}),
      ...(pending === null ? {} : { pendingId: pending.id }),
      ...(pending !== null && pendingYounger ? { pendingYounger: true as const } : {}),
    },
  };
}

/**
 * Rozpoznanie liczymy Z EKRANU, więc i cross-check hooka, i override `multiSelect` muszą
 * powstać z TEGO SAMEGO odczytu — stąd jedna funkcja zamiast trzech kroków obok siebie.
 */
function resolveScreen(
  input: DecideInput, source: PendingTool | null, hookPending: PendingTool | null,
): {
  hookQuestion: HookQuestion | null; resolution: DecisionResolution;
} {
  const hookQuestion = hookPending === null || input.text === null
    ? null
    : hookQuestionFrom(hookPending, input.text);
  const expected: ExpectedDecision | null = source === null
    ? null
    : {
      ...expectedFor(input, source),
      // Autorytatywny WYŁĄCZNIE po dopasowaniu treści i etykiet — zrzut bez cross-checku
      // nie ma prawa rozstrzygać, czy cyfra może wyjść (`docs/security-model.md`, „Starting sessions from the phone: three powers”).
      ...(hookQuestion === null ? {} : { multiSelect: hookQuestion.multiSelect }),
    };
  const resolution = input.text === null
    ? { status: 'unreadable', retryable: true, reason: 'no-options' } as const
    : input.resolve(input.text, expected);
  return { hookQuestion, resolution };
}

/**
 * Czy wpis z jsonl to TO SAMO wywołanie, na które poszła odpowiedź plikiem?
 *
 * Porównujemy KOMPLET treści pytań w kolejności — dokładnie to, co pojechało w pliku jako klucze
 * mapy `answers`. Wpis o innych pytaniach to nowe wywołanie i musi dostać kartę.
 */
function sameQuestions(pending: PendingTool, answered: readonly string[]): boolean {
  if (pending.toolName !== ASK_USER_QUESTION_TOOL) return false;
  const questions = parseAskUserQuestionInput(pending.input);
  if (questions === null || questions.length !== answered.length) return false;
  return questions.every(
    (question, index) => foldWhitespace(question.question) === foldWhitespace(answered[index] ?? ''),
  );
}

/**
 * Czy zrzut hooka opisuje NOWĄ generację, czyli inne wywołanie niż rozliczone plikiem?
 *
 * `answerKey` niesie nonce, więc dwa wywołania o IDENTYCZNEJ treści mają różne
 * klucze — i to jedyna rzecz, która je odróżnia (treść nie, `tool_use.id` bierze się ze
 * spóźnionego followera). Zrzut rozliczonego wywołania driver kasuje po zużyciu pliku, więc
 * zrzut, który tu widać, jest albo już nowy, albo go nie ma wcale.
 *
 * Zrzut BEZ klucza (`PreToolUse`) osłony nie kończy: on stoi nad narzędziem, które dopiero
 * ma się odpalić, i żadnej karty kanału i tak nie otworzy — nowe wywołanie rozpozna dopiero
 * jego własny zrzut `PermissionRequest`.
 */
function newerHookGeneration(hook: PendingHookTool | null, answeredKey: string): boolean {
  if (hook === null) return false;
  const key = hook.answerKey;
  return key !== undefined && key !== '' && key !== answeredKey;
}

/** Pusty `no-jsonl`: bez sygnatury i bez formularza — czyli ekran, z którego nic nie wynikło. */
function emptyNoJsonl(res: DecisionResolution): boolean {
  return res.status === 'no-jsonl' && res.knownDialog === null && res.questionForm === null;
}

/**
 * Wejście bez zrzutu, którego ocenie nie wolno wziąć: zrzut `Bash` starszy niż
 * 10 minut bez dowodu z ekranu ({@link admittedHook}) znika z oceny razem z kartą ze zrzutu, więc żadna bramka
 * niżej go nie widzi. Driver dopuszcza zrzut tą samą funkcją jeszcze przed
 * tożsamością oceny; tu dowód idzie na ekranie TEJ oceny (także po ponowionym odczycie), więc i wejście złożone
 * z surowego zrzutu nie da przycisków bez dowodu. `reqId` zostaje taki, jaki podał wołający.
 */
function withAdmittedHook(input: DecideInput): DecideInput {
  if (input.hookRaw === null || admittedHook(input.hookRaw, input.text, input.resolve) !== null) return input;
  return { ...input, hookRaw: null, hookPending: null };
}

/**
 * The card of the evaluation ({@link decideCardGates}); a consent card with options over a measured consent dialog
 * carries the mark of the screen it came from. The network card is the sandbox network tool, the MCP card is
 * any other consent card built from its `tool_use` entry (`callId`; a card from a hook dump alone gets no mark) whose
 * call input the argument frame shows exactly ({@link mcpFrameShows}).
 */
export function decideCard(given: DecideInput): DecideAction {
  const action = decideCardGates(given);
  if (action.kind !== 'card' || action.card.event.type !== 'permission-request') return action;
  const { active } = action.card;
  const mark = active.options.length === 0 ? null : measuredConsentOf(given.text);
  if (mark === null) return action;
  const fits = mark.kind === 'network'
    ? active.toolName === SANDBOX_NETWORK_TOOL
    : active.toolName !== SANDBOX_NETWORK_TOOL && active.callId !== undefined
      && mcpFrameShows(mark, action.card.event.input);
  return fits ? { ...action, card: { ...action.card, active: { ...active, measuredConsent: mark } } } : action;
}

/**
 * Jedna funkcja, piętnaście wyjść — i tak zostaje.
 *
 * Rozbicie jej na „pomocnicze" kawałki rozproszyłoby KOLEJNOŚĆ bramek, a to właśnie kolejność
 * jest tu treścią: każda z nich stoi przed następną z konkretnego powodu.
 * Czytelność ma tu wygrać czytaniem od góry do dołu, nie skakaniem.
 */
function decideCardGates(given: DecideInput): DecideAction {
  const input = withAdmittedHook(given);
  // Dialog spoza jsonl nie ma `tool_use.id` — bierzemy numer blokady (zrzut hooka niesie
  // własny stabilny id z chwili zapisu). To jest wyłącznie BAZA identyfikatora: każda karta
  // liczona z ekranu dokleja do niej odcisk TREŚCI dialogu (`screenFormReqId` dla kart
  // z opcjami, `screenFallbackReqId` dla karty bez nich) — i to on, nie numer blokady,
  // rozstrzyga ich świeżość.
  const { text, active } = input;
  // Baza tożsamości KART — zwykle tożsamość oceny; inna przy zrzucie starszym niż wpis i przy zrzucie `Bash`,
  // który wygrał z wpisem na ekranie (niżej).
  let { reqId } = input;
  const decided = decidedShield(input);
  /*
   * Dialog, który z definicji nie ma ani wpisu w jsonl, ani zrzutu hooka (sieć
   * sandboksa). Czekający wtedy wpis `Bash` to komenda, która poprosiła o sieć — nie ten
   * dialog — więc porównanie z nim dałoby `mismatch` i kartę „odpowiedz w terminalu".
   * Taki dialog oceniamy wyłącznie z ekranu, jak każdy dialog spoza jsonl.
   */
  const screenOwned = text !== null && screenOnlyDialog(text);
  let pending = screenOwned ? null : input.pending;
  let hookPending = screenOwned ? null : input.hookPending;
  let olderHookSource = false;
  if (pending !== null && hookPending !== null && competingSources(pending, hookPending)) {
    const settled = settleCompeting(input, pending, hookPending);
    if (settled.ambiguous) {
      /*
       * Ta karta ZOSTAJE przy gołej bazie, czyli zamrożona do zmiany źródeł — świadomy wyjątek od ponownej oceny
       * stojącego dialogu.
       * Rozstrzygnięcie konkurencji sprawdza treść tylko dla
       * zrzutu hooka, a dla narzędzi innych niż `Bash` sprowadza się do fragmentu ścieżki na ekranie
       * (`hookMatchesScreen`). Po przewinięciu, które zabierze tę linię, kolejna ocena oddałaby kartę
       * z przyciskami STĘCHŁEMU wpisowi jsonl, a cyfra zatwierdziłaby dialog zrzutu. Dwa wywołania
       * pasujące naraz to dowód, którego późniejszy, uboższy ekran nie ma prawa unieważnić.
       * Ta sama karta wychodzi, gdy wpis i zrzut to to samo narzędzie inne niż `Bash`, a ekran nie
       * potwierdza treści wpisu.
       * Karta niesie odcisk wpisu, jak każda karta bez przycisków z jsonl (`withCall`): „Odrzuć” na niej
       * zakłada osłonę po decyzji, a bez odcisku stęchły wpis dostałby po Esc kartę z przyciskami, gdy
       * skasowany zrzut przestaje z nim konkurować.
       */
      return {
        kind: 'card',
        card: withOrigin(withCall(
          degradedCard(input.reqId, pending, 'mismatch', text === null ? null : input.excerpt(text)),
          pending, input.pending,
        ), originOf(input, pending, pending)),
        audit: 'mismatch',
        // Podpowód z rozstrzygania konkurencji, nie z `resolveOptions`: ekran pasuje do obu źródeł albo
        // nie potwierdza treści wpisu tego samego narzędzia.
        diagnosis: diagnose(text, 'ambiguous-sources'),
      };
    }
    ({ pending, hookPending } = settled);
    /*
     * Zrzut STARSZY niż wpis: tożsamość KARTY bierze się z jednego źródła — tego,
     * które opisuje dialog — czyli taka sama jak bez drugiego. Wpis agenta głównego zmienia się z każdym
     * jego narzędziem, a karta zgody subagenta ze zrzutu podmieniałaby się przy każdym (ślad „Zgoda
     * wygasła" w apce); przegrany zrzut nie zmienia tożsamości karty z wpisu. Tożsamość OCENY
     * (`input.reqId`, `evaluationReqId`) to tu sam wpis: inna niż karta ze zrzutu, więc ocena nad nią czyta
     * ekran i kończy na hamulcu „ta sama karta" niżej (`KEEP`).
     *
     * Tak samo karta ze zrzutu `Bash` MŁODSZEGO od wpisu, gdy ekran rozstrzygnął na korzyść zrzutu:
     * tożsamość `hook:<generacja>`. Tożsamość oceny niesie oba źródła, więc z nią dialog wpisu
     * i dialog zrzutu, pokazane po kolei pod tymi samymi źródłami, miałyby jedną tożsamość. Po decyzji Raroga
     * na karcie wpisu zrzut subagenta w kolejce zostaje (`otherDialogDump`), a jego karta trafiała w osłonę po
     * decyzji (`decided.reqId`) i dostawała tożsamość karty już rozstrzygniętej. Karta z wpisu zostaje przy
     * tożsamości oceny, więc nad stojącym dialogiem wpisu bramka „ta sama karta" nie czyta ekranu.
     * Karta ze zrzutu stoi pod tą tożsamością także wtedy, gdy wpis obok się zmienia, a hamulec „ta sama karta"
     * niżej nie odświeża jej `pendingId`/`pendingYounger`. Wpis obok do osłony po decyzji bierze więc driver
     * z migawki sprzed klawisza (`besideAtDecision`), nie z karty.
     */
    const hookWon = pending === null && hookPending !== null
      && bashCommand(hookPending.toolName, hookPending.input) !== null;
    if (settled.older || hookWon) reqId = decideReqId(pending ?? hookPending, input.blockedSeq);
    // Źródłem karty jest zrzut STARSZY niż wpis obok — materiał osłony po decyzji (`pendingYounger`).
    olderHookSource = settled.older && pending === null;
  }
  const source = pending ?? hookPending;
  // Pochodzenie karty z jsonl/hooka do dziennika — `null`, gdy źródła nie ma.
  const sourceOrigin = source === null ? null : originOf(input, source, pending);
  let { hookQuestion, resolution } = resolveScreen(input, source, hookPending);
  // Wycinek ekranu NA KARTĘ — liczony LENIWIE, przy samym budowaniu karty bez przycisków.
  // Zegar oceny obraca się co 4 s nad stojącym dialogiem i kończy w `keep`; czyszczenie ANSI
  // całego ekranu przy każdym takim obrocie byłoby pracą, której nikt nigdy nie zobaczy.
  const screen = (): string | null => (text === null ? null : input.excerpt(text));

  /*
   * OSŁONA PO WŁASNEJ DECYZJI, wariant pusty: dialogu, który Rarog przed chwilą rozstrzygnął,
   * już nie widać, a wpis jsonl jeszcze nie ma `tool_result`. To zamykanie dialogu, nie nowy dialog —
   * bez ponowienia odczytu i bez karty bez przycisków. Bliźniak „okna po własnej cyfrze" niżej, które
   * obejmuje wyłącznie dialogi bez wpisu w jsonl.
   */
  if (decided !== null && pending !== null && resolution.status === 'unreadable'
    && decided.callPrint === callPrint(pending.toolName, pending.input)) {
    return KEEP;
  }

  /*
   * JEDEN ponowny odczyt — dla „nie dało się przeczytać" ORAZ dla pustego `no-jsonl`
   * (bez sygnatury i bez formularza). Rozjazd nazwy narzędzia nie jest problemem czasu,
   * więc ponawianie go byłoby wyłącznie odwlekaniem fail-closed.
   *
   * Pusty `no-jsonl` też dostaje ponowienie: ekran przy wejściu w `blocked` jest
   * czytany NATYCHMIAST i cache'owany (`#reportBlocked`), więc odczyt trafiony w środek
   * przemalowania TUI zamroziłby zniekształcony ekran — a karta spadłaby do „odpowiedz
   * w terminalu" nad dialogiem, który ułamek sekundy później parsował się bez zarzutu.
   */
  if (input.canRetry && (resolution.status === 'unreadable' || emptyNoJsonl(resolution))) {
    return { kind: 'retry' };
  }

  /*
   * OKNO PO ODPOWIEDZI PLIKIEM — bliźniak okna po własnej cyfrze niżej, tylko dla
   * wpisu z jsonl.
   *
   * `allow` z hooka domyka całe wywołanie, ale `tool_result` dochodzi do pliku z opóźnieniem,
   * a od CLI 2.1.267 `tool_use` stoi tam od chwili postawienia dialogu — przez kilka obrotów
   * oceny `pending` opisuje więc formularz JUŻ ODPOWIEDZIANY. Bez tej bramki telefon dostałby
   * w tym oknie kartę z tymi samymi pytaniami (albo fallback z przemalowanego ekranu), sekundę
   * po wysłaniu odpowiedzi.
   *
   * Okno jest wąskie w obie strony i ma TRZY końce: `tool_result`
   * (wpis o innych pytaniach), nowa blokada — i ŚWIEŻY ZRZUT HOOKA o innym `answerKey`.
   * Ten trzeci jest tu niezbędny: dwa identyczne `AskUserQuestion` jednej tury mają tę samą
   * treść i tę samą blokadę (dialogi idą pod rząd bez mignięcia `agent_status`), więc
   * bez niego drugie z nich nie dostałoby karty do końca blokady — ani karty, ani fallbacku,
   * ani wpisu odmowy w dzienniku. Nonce w kluczu gwarantuje, że klucze się różnią.
   */
  const answered = input.answeredHookCall;
  if (pending !== null && answered !== null && answered.seq === input.blockedSeq
    && sameQuestions(pending, answered.questions)
    && !newerHookGeneration(input.hookRaw, answered.key)) {
    return KEEP;
  }

  /*
   * KANAŁ ODPOWIEDZI HOOKA — karta z KOMPLETEM pytań ze zrzutu.
   *
   * Stoi PRZED oceną `resolveOptions` z rozmysłem: tamta odpowiada na pytanie „którą CYFRĘ
   * wolno wysłać", a tu żadna cyfra nie pojedzie. Odpowiedź jedzie plikiem, więc karta nie
   * potrzebuje ani zgodności numeracji, ani jednokrotności formularza — `multiSelect`
   * przestaje tu być powodem odmowy, a zakładki 2..n nie muszą czekać na własny
   * ekran, bo `allow` domyka całe wywołanie naraz.
   *
   * Cross-check ekranu ZOSTAJE i jest warunkiem ISTNIENIA karty: `hookQuestion !== null`
   * znaczy „na ekranie stoi formularz pytania, którego choć jedna zakładka zgadza się
   * z payloadem co do treści i kompletu etykiet". Bez tego stęchły zrzut opisywałby dialog,
   * który już nie stoi. Cross-check nie ogranicza za to LISTY pytań: ekran pokazuje jedną
   * zakładkę, a odpowiadamy na całe wywołanie.
   *
   * Wpis z jsonl NIE ZAMYKA tej ścieżki. Do CLI 2.1.266 `tool_use` formularza pytania wchodził do
   * pliku dopiero po decyzji, więc obecność wpisu znaczyła „dialog rozstrzygnięty". Od 2.1.267 wpis
   * ląduje ~0,1 s PRZED zrzutem hooka, nad stojącym dialogiem, więc ta przesłanka nie jest prawdziwa:
   * zamykanie ścieżki wpisem gasiłoby kanał odpowiedzi na wszystkich pytaniach naraz.
   * Wpis zostaje KONTROLĄ zgodności ({@link hookMatchesPending}): dwa źródła opisują ten sam
   * moment, więc rozjazd pytań znaczy, że jedno z nich jest stęchłe — kanał zamknięty.
   */
  const pendingFitsHook = pending === null || hookMatchesPending(pending, input.hookRaw);
  const hookTarget = !pendingFitsHook || hookQuestion === null || !input.hookAnswersEnabled
    ? null
    // Zrzut bierzemy SUROWY: `answerKey` i `hookEventName` gubi konwersja na `PendingTool`.
    : hookAnswerTargetFor(input.hookRaw, hookQuestion);
  if (hookTarget !== null && source !== null && hookQuestion !== null
    && hookTarget.key !== input.deadAnswerKey) {
    // Tożsamość z TREŚCI karty, czyli z kompletu pytań — przełączenie zakładki przy
    // biurku nie podmienia karty, która i tak pokazuje je wszystkie.
    const cardReqId = hookQuestionReqId(reqId, hookQuestion.all);
    if (active !== null && active.reqId === cardReqId) return KEEP;
    // BEZ osłony po decyzji: ta karta ma JEDEN `reqId` na wszystkie zakładki, więc
    // po cyfrze-fallbacku (plik odpowiedzi nie powstał) osłona schowałaby zakładkę 2. Odpowiedź plikiem ma
    // własną osłonę (`answeredHookCall`).
    const built = withOrigin(decisionCard(
      cardReqId, source, 'question', hookQuestion.options,
      // Treść pytania Z EKRANU — dla fallbacku cyfrą, który dowozi zakładkę
      // stojącą na ekranie. Karta pokazuje komplet, cyfra zamyka jedno.
      hookQuestion.screenQuestion, hookQuestion, hookTarget,
    ), originOf(input, source, pending));
    // Tożsamość formularza pytania — fallback cyfrą sprawdza ją na świeżym ekranie tuż przed klawiszem.
    const card = withIdentity(built, QUESTION_FORM_IDENTITY);
    /*
     * Odcisk bloku z TEGO SAMEGO odczytu i parsowania co opcje karty: `hookQuestionFrom` parsuje
     * z podpowiedzią etykiet z payloadu, a parsowanie bez niej daje przy zawiniętych etykietach o wspólnym początku
     * `null`. Odpowiedź plikiem odcisku nie czyta, cyfra-fallback tak. Zakładka przełączona przy
     * biurku zmienia blok, więc fallback dostaje `screen-changed`, a karta wraca pod tym samym `reqId` z pytaniem
     * z ekranu — inaczej cyfra pytania 1 szła w zakładkę 2 o tych samych etykietach.
     */
    const print = hookQuestion.bodyPrint;
    return {
      kind: 'card', card: print === null ? card : { ...card, active: { ...card.active, bodyPrint: print } }, audit: null,
    };
  }

  if (resolution.status === 'ok' && source !== null) {
    // Zrzut hooka dodatkowo musi ZGADZAĆ SIĘ TREŚCIĄ z ekranem — nazwa narzędzia nie
    // rozróżnia równoległych wywołań (patrz `hookMatchesScreen`). Wpis z jsonl tej
    // weryfikacji nie potrzebuje: niesie `tool_use.id` sparowany z transkryptem.
    if (pending !== null || hookPending === null || hookMatchesScreen(source, text)) {
      const { kind, options, question } = resolution;
      /*
       * Karta CYFROWA niesie JEDNĄ zakładkę — tę, która stoi na ekranie, na ścieżce hooka
       * i jsonl. Karta z KOMPLETEM pytań z `tool_input` (`answerQuestion` bierze `answers[0]`)
       * po pierwszej cyfrze, gdy zakładka się przełączy, odtworzyłaby się z tym samym
       * `tool_use.id` i tym samym kompletem, więc odpowiedź na pytanie 1 pojechałaby cyfrą
       * w zakładkę 2 (etykiety sąsiednich pytań kolidują). Zakładkę dopasowuje ta sama
       * funkcja co na ścieżce hooka: treść pytania plus KOMPLET etykiet na ekranie, czyli źródłem
       * cyfr zostaje ekran.
       */
      const merged = pending === null
        ? hookQuestion
        : (text === null ? null : hookQuestionFrom(pending, text));
      /*
       * Formularz WIELOPYTANIOWY z jsonl, którego zakładki nie umiemy dopasować do ekranu, jest
       * fail-closed: karta z kompletem pytań ma tylko jeden adres cyfry — ekran —
       * a skoro nie wiemy, które pytanie na nim stoi, cyfra trafiłaby w zakładkę, której człowiek
       * nie widzi. Formularz JEDNOPYTANIOWY zostaje przy karcie: tam nie ma czego mylić,
       * a dopasowanie potrafi nie wyjść z błahego powodu (starszy render sklejał nagłówek
       * z treścią pytania — fixture `dialog-askuserquestion.txt`).
       */
      if (kind === 'question' && pending !== null && merged === null) {
        const all = parseAskUserQuestionInput(pending.input);
        if (all !== null && all.length > 1) {
          /*
           * Tożsamość z TREŚCI EKRANU, nie z `tool_use.id`: bramka
           * „ta sama karta" w driverze kończy ocenę PRZED odczytem ekranu, więc karta o gołym
           * `reqId` z pliku zamrażałaby formularz do końca blokady — a niedopasowanie bywa
           * chwilowe (przemalowanie TUI, przełączona zakładka). Z odciskiem ekranu kolejna
           * ocena idzie dalej i po powrocie zgodnego ekranu karta wraca z przyciskami.
           */
          const fallbackId = screenFallbackReqId(reqId, {
            knownDialog: null,
            reason: 'no-digit',
            question: question === null ? null : { header: '', question },
            options,
          });
          // TEN SAM ekran stoi dalej — obrót zegara ma być zdarzeniem zerowym (jak `sameForm`).
          if (active !== null && active.reqId === fallbackId) return KEEP;
          return {
            kind: 'card',
            card: withOrigin(
              degradedCard(fallbackId, pending, 'no-digit', screen()), originOf(input, pending, pending),
            ),
            audit: 'no-digit',
            diagnosis: diagnose(text, null),
          };
        }
      }
      /*
       * Tożsamość karty pytania z hooka liczy się z TREŚCI zakładki, nie z pliku.
       * Zrzut niesie CAŁY formularz i przeżywa odpowiedź na pojedyncze
       * pytanie, więc samo `hook:<id>` znaczyłoby to samo dla zakładki 1 i 2 — a wtedy
       * odpowiedź wysłana z NIEŚWIEŻEJ karty pierwszego pytania byłaby przyjęta jako
       * odpowiedź na drugie (etykiety sąsiednich zakładek kolidują).
       */
      const cardReqId = merged === null ? reqId : hookQuestionReqId(reqId, [merged.card]);
      // TEN SAM dialog stoi dalej — hamulec jak `sameForm` niżej: bez niego karta pytania
      // z hooka wychodziłaby na nowo przy każdym obrocie oceny (`reqId` z pliku przestał
      // ją zatrzymywać w driverze).
      if (active !== null && active.reqId === cardReqId) return KEEP;
      /*
       * OSŁONA PO WŁASNEJ DECYZJI: karta, którą Rarog przed chwilą rozstrzygnął cyfrą albo
       * `escape`, nie wraca w tej samej blokadzie, choć ekran jeszcze pokazuje dialog (cache sprzed cyfry,
       * przemalowanie TUI). Zgodę na narzędzie poznajemy po odcisku wywołania, bo jej `reqId` po cyfrze się
       * zmienia (skasowany zrzut hooka: `T~hook:…` → `T`); pytanie — po `reqId` z odciskiem zakładki, żeby
       * NASTĘPNA zakładka tego samego wywołania dostała kartę.
       */
      // Odcisk wywołania i „ten sam dialog na ekranie" WYŁĄCZNIE dla zgody na narzędzie (przypadek: karta
      // z ekranu, po której dochodzi spóźniony wpis jsonl). Pytanie rozróżnia `reqId` z odciskiem
      // zakładki — kanał hooka po cyfrze-fallbacku ma dostać kartę zakładki na torze cyfry.
      if (decided !== null && (decided.reqId === cardReqId
        || (kind === 'tool' && (decided.callPrint === callPrint(source.toolName, source.input)
          || sameDecidedDialog(input, decided, text))))) {
        return KEEP;
      }
      // Bez kanału odpowiedzi (brak `answerKey`, `PreToolUse`, kanał wyłączony albo martwy):
      // karta jednej zakładki i cyfra — rozstrzygnął to blok wyżej, tutaj `hookAnswer` nie
      // ma prawa się pojawić.
      const built = decisionCard(cardReqId, source, kind, options, question, merged);
      // Surowy wpis jsonl, nie ten po rozstrzygnięciu konkurencji — stęchły wpis obok zrzutu też się liczy.
      const card = withOrigin(
        withCall(built, source, input.pending, olderHookSource), originOf(input, source, pending),
      );
      // Odcisk treści dialogu z ramką i generacja zrzutu hooka, który dał treść albo drugi dowód
      // — oba do kontroli tuż przed cyfrą (`#digitStillHolds`).
      const bodyPrint = resolution.bodyPrint;
      const raw = input.hookRaw;
      const proofHookAt = kind === 'tool' && raw !== null && raw.hookEventName === HOOK_PERMISSION_REQUEST_EVENT
        && (pending === null || bashDoubleProof(pending, raw))
        ? raw.at
        : null;
      return {
        kind: 'card',
        card: {
          ...card,
          active: {
            ...card.active,
            ...(bodyPrint === null ? {} : { bodyPrint }),
            ...(proofHookAt === null ? {} : { proofHookAt }),
            // Tożsamość dialogu z bloku — `#digitStillHolds` porówna ją ze świeżym odczytem.
            dialogIdentity: resolution.dialogIdentity,
          },
        },
        audit: null,
      };
    }
    // Treść zrzutu nie zgadza się z ekranem — spadamy na ścieżkę ekranową (blok niżej
    // przeliczy rozpoznanie z `expected = null` na tym samym, już przeczytanym ekranie).
  }
  /*
   * Zrzut hooka nie zgadza się z ekranem (stęchły plik po poprzednim narzędziu, wyścig
   * zapisu) — hook jest WZBOGACENIEM, nie bramką: rozjazd zrzutu nie ma prawa degradować
   * karty poniżej tego, co warstwa 2 zrobiłaby bez niego. Liczymy rozpoznanie jeszcze raz
   * z `expected = null` (ten sam, już przeczytany ekran) i jedziemy ścieżką ekranową.
   *
   * POWÓD odmowy zapamiętujemy PRZED nadpisaniem: `resolve(text, null)`
   * zawsze zwraca `no-jsonl`, więc bez tego każda odmowa hookowa (rozjazd nazwy narzędzia,
   * `multi-select` z `resolveOptions`, ekran nieczytelny przy obecnym zrzucie) lądowałaby
   * w dzienniku jako `no-jsonl`, a dziennik ma pokazać ROZKŁAD tych powodów.
   */
  /*
   * OSTATNI KROK formularza wielopytaniowego na kanale `keys` (zmierzone na CLI 2.1.273):
   * wpis `AskUserQuestion` stoi w jsonl, a na ekranie jest już PRZEGLĄD odpowiedzi („Review your
   * answers" + „1. Submit answers / 2. Cancel"), który parser czyta jako `confirm`. To ten sam
   * formularz, nie cudzy dialog — a jsonl o tym ekranie nie wie nic (nie ma w nim ani „Submit
   * answers", ani „Cancel"), więc jedyną uczciwą kartą jest ekranowa: dokładnie ta, którą ten
   * ekran dostaje BEZ wpisu w jsonl. Od tego miejsca wpis przestaje się liczyć (`jsonlEntry`).
   * Na kanale `hook` przegląd nie występuje — odpowiedzi jadą plikiem naraz.
   */
  const reviewStep = pending !== null && text !== null
    && resolution.status === 'mismatch' && resolution.reviewStep === true;
  if (reviewStep && text !== null) resolution = input.resolve(text, null);
  const jsonlEntry = reviewStep ? null : pending;
  /*
   * PODPOWÓD rozjazdu do dziennika — z PIERWSZEGO rozpoznania, przed przeliczeniem niżej. Przy samym zrzucie
   * hooka `resolve(text, null)` nadpisuje rozpoznanie i zostałby z niego goły `mismatch` (np. zgoda `Bash`
   * subagenta z ramką uciętą u góry — `operation`, bez nagłówka na ekranie). Przegląd formularza (wyżej) to nie
   * rozjazd, więc liczymy po nim.
   */
  const mismatchReason: AuditMismatchReason | null = resolution.status === 'mismatch'
    ? resolution.reason
    : null;

  let hookRefuseReason: HerdrRefuseReason | null = null;
  if (pending === null && hookPending !== null) {
    if (resolution.status !== 'ok') hookRefuseReason = refuseReasonFor(resolution);
    resolution = text === null
      ? { status: 'unreadable', retryable: true, reason: 'no-options' }
      : input.resolve(text, null);
  }
  /*
   * WIELOKROTNY WYBÓR ogłoszony przez autora pytania — karta bez przycisków, choćby
   * ekran parsował się jak formularz jednokrotny.
   *
   * To jest druga strona autorytetu `multiSelect` z hooka i musi stać TUTAJ, bo linia wyżej
   * przeliczyła rozpoznanie z `expected = null`, czyli bez override'u: ścieżka ekranowa
   * zbudowałaby wtedy kartę z przyciskiem, a jedna cyfra w formularzu czekającym na
   * zaznaczenie + „Submit" niczego nie odpowiada.
   */
  if (hookQuestion !== null && hookQuestion.multiSelect) {
    // Tożsamość z TREŚCI zakładki, nie z pliku zrzutu: `hook:<id>` znaczy to samo dla
    // KAŻDEJ zakładki formularza, więc zamrażał ocenę do końca blokady (patrz
    // `screenFallbackReqId`) — kolejne pytania nie miały jak dostać karty.
    const fallbackId = screenFallbackReqId(reqId, {
      knownDialog: null,
      reason: 'multi-select',
      question: { header: hookQuestion.card.header, question: hookQuestion.card.question },
      options: hookQuestion.options,
    });
    // TA SAMA zakładka stoi dalej — obrót zegara ma być zdarzeniem zerowym (jak `sameForm`).
    if (active !== null && active.reqId === fallbackId) return KEEP_TOUCH;
    return {
      kind: 'screen-dialog',
      reqId: fallbackId,
      resolved: null,
      reason: 'multi-select',
      audit: 'multi-select',
      screen: screen(),
      origin: sourceOrigin ?? SCREEN_ORIGIN,
      diagnosis: diagnose(text, mismatchReason),
    };
  }
  /*
   * TEN SAM dialog stoi dalej → koniec oceny, ZANIM cokolwiek wyjdzie na zewnątrz.
   *
   * To jest hamulec zegara ponownej oceny i musi stać PRZED wycinkiem ekranu: obrót nad
   * niezmienionym dialogiem ma być zdarzeniem zerowym — ani karty, ani wiadomości. Dedup
   * wycinka po hashu tu nie wystarcza, bo hash liczy się z OGONA ekranu, a ogon potrafi
   * nieść ostatnią linię poprzedniej tury („✻ Churned for 3 s") — jedna zmienna liczba
   * i transkrypt dostawałby zrzut ekranu co cztery sekundy.
   */
  const sameForm = jsonlEntry === null && resolution.status === 'no-jsonl'
    && resolution.questionForm !== null
    && active !== null
    && active.reqId === screenFormReqId(
      resolution.questionForm.kind === 'tool' ? 'p' : 'q', resolution.questionForm,
    );
  if (sameForm) return KEEP_TOUCH;

  /*
   * Brak wpisu w jsonl to INNA sytuacja niż „mam wpis, ale nie zgadza się z ekranem" —
   * i dostaje inną kartę. Dialog spoza transkryptu nie ma `permId` (nie ma z czego go
   * złożyć), więc adresem decyzji jest sesja, a przycisk zatwierdzania włącza wyłącznie
   * dopasowanie do zamkniętej listy sygnatur.
   */
  if (jsonlEntry === null) {
    /*
     * Formularz PYTANIA bez wpisu w jsonl to WYŚCIG albo sesja bez transkryptu, a nie stan
     * trwały.
     *
     * Od CLI 2.1.267 wpis `tool_use` formularza `AskUserQuestion` ląduje ~0,1 s PRZED zrzutem hooka,
     * nad STOJĄCYM dialogiem: brak wpisu znaczy najczęściej „follower jeszcze nie dogonił" i karencja
     * w `#evaluateOnce` ma sens. Jedynym źródłem karty jest tu i tak EKRAN — a on niesie
     * komplet: nagłówek, treść i opcje z cyframi.
     */
    if (resolution.status === 'no-jsonl' && resolution.questionForm !== null) {
      /*
       * Zgoda na narzędzie jedzie KARTĄ ZGODY, nie pytania: karta zgody ma klasyfikację ryzyka, hold 1,5 s dla
       * czerwonych i parę Odrzuć/Zatwierdź — a `respondPermission('allow')` wybiera cyfrę `affirmativeOption` po TREŚCI
       * etykiety, więc opcje eskalujące strukturalnie nie mają jak być celem tapnięcia. Pytania i potwierdzenia zostają
       * przy karcie pytania.
       */
      // Karta o tej samej treści odpadła wyżej (`sameForm`) — tu stoi już NOWY dialog.
      const form = resolution.questionForm;
      // Ekran PRZEGLĄDU formularza dostaje pary „pytanie → odpowiedzi" z surowych linii
      // ekranu, z zawinięciami — ten sam odczyt, z którego powstała karta.
      const review = form.kind === 'confirm' && text !== null && isReviewForm(form)
        ? reviewPairsFrom(text)
        : null;
      const card = form.kind === 'tool'
        ? screenPermissionCard(form, input.blockedSeq)
        : screenQuestionCard(form, input.blockedSeq, review);
      // Osłona po własnej decyzji: karta z ekranu o tym samym odcisku nie wraca — także wtedy,
      // gdy rozstrzygnięta była kartą ze zrzutu hooka, skasowanego po cyfrze (ten sam `bodyPrint`).
      if (decided !== null && (decided.reqId === card.active.reqId || sameDecidedDialog(input, decided, text))) {
        return KEEP;
      }
      /*
       * Dialog z listy `TERMINAL_DIALOGS`: karta z pełną treścią, ale BEZ DECYZJI — każda
       * opcja `terminalOnly`. Liczy się więc do dziennika jak karta z wycinkiem: ten sam
       * powód (`no-jsonl`, a przy zrzucie hooka, któremu ekran przeczył, powód z jego ścieżki), plus
       * `dialogTitle` z kształtu. Ta sama karta nad stojącym dialogiem kończy się wyżej (`sameForm`), więc
       * wpis powstaje raz na dialog, nie co obrót zegara.
       */
      if (form.kind === 'confirm' && form.terminalDialog !== undefined) {
        return {
          kind: 'card',
          card: withOrigin(card, SCREEN_ORIGIN),
          audit: hookRefuseReason ?? 'no-jsonl',
          diagnosis: diagnose(text, mismatchReason),
        };
      }
      // Karta z SAMEGO ekranu — także wtedy, gdy zrzut hooka był, ale ekranowi przeczył.
      return { kind: 'card', card: withOrigin(card, SCREEN_ORIGIN), audit: null };
    }
    /*
     * OKNO PO WŁASNEJ CYFRZE: `#rearmAfterScreenAnswer` ponawia ocenę, a ekran
     * w trakcie ZAMYKANIA dialogu jest nieparsowalny — pusta ocena otwierałaby na moment fallback
     * „zobacz w terminalu”, który sekundę później gasi przejście w `working`. W tym oknie (ta sama blokada,
     * na którą poszła nasza cyfra) pustej oceny NIE zamieniamy na kartę: prawdziwy DRUGI
     * dialog i tak parsuje się w całości (gałęzie wyżej), a rozpad okna pilnuje numer
     * blokady — nowa blokada znaczy nowy dialog i fallback wraca do łask.
     */
    const known = resolution.status === 'no-jsonl' ? resolution.knownDialog : null;
    if (input.answeredSeq === input.blockedSeq && known === null) return KEEP;
    /*
     * PUSTA ocena nad STOJĄCĄ kartą ekranową = ekran chwilowo nieczytelny, nie nowy dialog
     * (resize albo przemalowanie panelu przy biurku zdegradowałyby stojącą kartę zgody do fallbacku
     * bez przycisków, a hold z telefonu trafiłby w pustkę).
     * Kartę z opcjami ZOSTAWIAMY — jej `reqId` liczy się z TREŚCI dialogu, więc ten sam
     * dialog odtworzyłby ją identycznie, a każdą cyfrę i tak weryfikuje `#digitStillHolds`
     * na żywym ekranie tuż przed wysyłką (fail-closed przy realnej zmianie dialogu).
     * Fallback zostaje dla sytuacji, w której żadnej karty nie było — ORAZ dla ekranu,
     * który SPARSOWAŁ się, ale karty mu odmówiono (marker eskalacji, multi-select):
     * to realny nowy dialog, a podtrzymana stara karta wysyłałaby cyfrę w jego opcje.
     */
    // Ochrona obejmuje też kartę z JSONL (screen-brak): pending potrafi mrugnąć `null`
    // w oknie repoint followera, a degradacja do fallbacku gasiłaby kartę z pełną treścią.
    // Ten sam odczyt służy potem za POWÓD odmowy (`docs/dialogs.md`, „Refusal diagnostics”) — ekran parsujemy dokładnie raz.
    const screenDialog = text === null ? null : parseOptions(text);
    const unreadable = screenDialog === null;
    if (known === null && unreadable && active !== null && active.options.length > 0) {
      return { kind: 'keep', touchSeq: active.screen === true };
    }
    // Karta bez przycisków dla dialogu spoza jsonl i spoza zamkniętej listy sygnatur —
    // liczymy ją jako odmowę: to jest sytuacja, w której Rarog NIE WIE, co stoi
    // na ekranie, i właśnie ta liczba ma kiedyś rozstrzygnąć, czy warto ją naprawiać.
    // Powód liczymy z EKRANU (`docs/dialogs.md`, „Refusal diagnostics”): `refuseReasonFor(resolution)` po przeliczeniu
    // z `expected = null` oddaje tu zawsze `no-jsonl`, więc mieszał w statystyce ekran
    // nieczytelny, multi-select i realny dialog spoza jsonl. Powód ze ścieżki HOOKA
    // (jeśli był) zostaje ważniejszy: on wie więcej niż sam ekran. TA SAMA wartość jedzie
    // na kartę (`docs/implementation-spec.md`, „Session fields and herdr frames”) — dziennik i telefon nie mają prawa mówić dwóch różnych rzeczy.
    const reason = known === null
      ? hookRefuseReason ?? screenRefuseReason(screenDialog)
      : null;
    /*
     * BLOK dialogu zamiast ogona ekranu: wyłącznie ekran bez opcji z cyframi (widok
     * slash-komendy, dialog zaufania bez cyfr, logowanie), przy niewidocznym polu promptu i bez powodu ze ścieżki
     * hooka — karta odmowy ze zrzutu hooka i ekran z polem promptu zostają przy ogonie ekranu. Tytuł bloku
     * wchodzi do tożsamości karty (`title` niżej), więc liczymy go przy każdej ocenie: `/help` podmieniony na
     * `/status` w tej samej blokadzie to nowa karta z nowym blokiem.
     */
    const blockScreen = screenDialog === null && hookRefuseReason === null && text !== null
      && composerRegionState(text) === 'unknown'
      ? text
      : null;
    /*
     * Przy fladze warstwy 2 (`input.layer2`) blok czyta `readBlock` z wyższym sufitem (`layer2/card.ts`), a karta
     * niesie ślad warstwy 2: powód do dziennika i odcisk bloku. Bez flagi albo gdy blok warstwy 2 się nie udał —
     * dzisiejszy wycinek bloku.
     */
    const layer2Block = blockScreen !== null && input.layer2 === true ? blockNoDigitsExcerpt(blockScreen) : null;
    const block = layer2Block ?? (blockScreen === null ? null : blockExcerpt(blockScreen));
    // Tożsamość karty bez opcji liczy się z TREŚCI ekranu (`screenFallbackReqId`), tak jak
    // każdej innej karty ekranowej: `screen:<numer blokady>` był stały do końca
    // blokady, więc raz postawiony fallback zamykał ocenę — kolejny dialog podmieniony
    // w miejscu (następna zakładka formularza) nie miał jak dostać karty.
    const fallbackId = screenFallbackReqId(reqId, {
      knownDialog: known,
      reason,
      question: screenDialog?.question ?? null,
      options: screenDialog?.options ?? [],
      // Tytuł dialogu: ten sam zestaw etykiet pod innym tytułem albo tytuł odsłonięty nad tym samym
      // zestawem to nowa karta — patrz `screenFallbackReqId`. Ekran bez opcji: tytuł bloku, gdy blok się udał.
      title: screenDialog === null ? block?.title ?? null : screenDialog.title,
    });
    // TEN SAM ekran stoi dalej — obrót zegara ma być zdarzeniem zerowym (jak `sameForm`).
    if (active !== null && active.reqId === fallbackId) {
      /*
       * Wyjątek warstwy 2: ta sama tożsamość karty (ten sam tytuł bloku), a inny odcisk bloku — widok pod kartą się
       * zmienił (następna zakładka `/status`), więc wycinek się odświeża, a karta stoi dalej. Bez flagi karta trzyma
       * pierwszy wycinek do końca blokady.
       */
      if (layer2Block !== null && active.layer2?.print !== layer2Block.mark.print) {
        return { kind: 'refresh', reqId: fallbackId, screen: layer2Block.text, layer2: layer2Block.mark };
      }
      return KEEP_TOUCH;
    }
    // Osłona po własnej decyzji: rozstrzygnięty dialog z zamkniętej listy nie wraca.
    if (decided !== null && decided.reqId === fallbackId) return KEEP;
    return {
      kind: 'screen-dialog',
      reqId: fallbackId,
      resolved: resolution.status === 'no-jsonl' ? resolution : null,
      reason,
      audit: reason,
      screen: block?.text ?? screen(),
      // Karta BEZ DECYZJI przy samym zrzucie hooka (bez wpisu jsonl): zrzut był oczekiwaniem, któremu ekran
      // przeczył — źródłem jest zrzut. Dialog rozpoznany z zamkniętej listy (`reason === null`), przegląd
      // formularza i dialog bez obu źródeł to karta z samego ekranu: zatwierdzenie dialogu `model` albo
      // `trust` nie dostaje tury stęchłego zrzutu.
      origin: reason !== null && pending === null ? sourceOrigin ?? SCREEN_ORIGIN : SCREEN_ORIGIN,
      // Blok niejednoznaczny bez wpisu jsonl: rozpoznanie `no-jsonl` nie niesie podpowodu, więc
      // bierzemy go z tego samego odczytu ekranu — w dzienniku ma stać `ambiguous`, nie goły `mismatch`.
      ...(reason === null ? {} : {
        diagnosis: diagnose(text, mismatchReason ?? (screenDialog?.identity.kind === 'ambiguous' ? 'ambiguous' : null)),
      }),
      ...(layer2Block === null ? {} : { layer2: layer2Block.mark }),
    };
  }
  const degradedReason = hookRefuseReason ?? refuseReasonFor(resolution);
  // Ekran przeczy NAZWIE z jsonl — karta nosi nazwę z ekranu, nie tę, której ekran zaprzecza.
  const screenToolName = resolution.status === 'mismatch' && resolution.reason === 'tool-name'
    ? resolution.screenToolName
    : null;
  /*
   * Tożsamość z sufiksem, nie goła baza. Z bazą ta karta zamarzała do
   * końca blokady: bramka „ta sama karta" w driverze nie czytała ekranu, a hamulec karty z przyciskami
   * wyżej brał czytelny już dialog za kartę, która stoi. Dialog, który wrócił na ekran, daje kartę
   * z przyciskami o tożsamości bazy.
   *
   * Nad stojącą kartą bez przycisków TEGO SAMEGO wywołania nowa wychodzi WYŁĄCZNIE wtedy, gdy ekran
   * pokazuje dialog INNEGO narzędzia niż ta karta. Ekran bez nazwy — przewinięty w górę, ramka
   * ucięta, zmiana powodu — niczego nie zmienia. Inaczej przewijanie terminalu przełączałoby kartę
   * przy każdym obrocie zegara (`unreadable` ↔ `mismatch`), a każda podmiana to wpis `degrade`, zrzut
   * odmowy i ślad „zgoda wygasła” w apce.
   */
  const degradedId = degradedReqId(reqId, screenToolName);
  if (active !== null && isDegradedOf(active.reqId, reqId)
    && (active.reqId === degradedId || screenToolName === null)) return KEEP;
  /*
   * Osłona po własnej decyzji przy karcie bez przycisków — dwa warianty, oba bez połykania INNEGO dialogu:
   *
   * - „ten sam dialog": na ekranie stoi rozstrzygnięty dialog, a przyciski
   *   zniknęły tylko dlatego, że po cyfrze skasowany zrzut hooka zabrał podwójny dowód treści (ucięty nagłówek
   *   w wąskim panelu → `mismatch`) albo kartę zbudował zrzut obok stęchłego wpisu jsonl;
   * - „wpis obok, ekran pusty": kartę rozstrzygniętą zbudował zrzut, w jsonl stoi stęchły
   *   wpis INNEGO wywołania, a dialog się zamyka. Czytelny inny dialog (inna operacja, inne narzędzie)
   *   dostaje kartę od razu — sam stęchły wpis nie jest dowodem, że to ten sam dialog.
   */
  const besideStale = decided !== null && decided.callId === null && decided.pendingId !== null
    && pending !== null && pending.id === decided.pendingId;
  /*
   * Wariant „wpis obok, ekran pusty" dla wpisu MŁODSZEGO od zrzutu, który dał treść rozstrzygniętej karcie:
   * to żywe wywołanie agenta głównego obok zgody subagenta, a nie dialog z karty.
   * Liczone ze świeżych źródeł (generacja zrzutu z migawki osłony i znacznik czasu wpisu), więc działa bez
   * względu na to, czy wpis doszedł przed kartą, czy po niej (karta zbudowana z samego zrzutu nie ma
   * `pendingId`). Nowego dialogu nie chowa: czytelny dialog nie jest `unreadable`, a nowy dialog zgody
   * zapisuje nową generację zrzutu i zdejmuje osłonę (`decidedShield`).
   */
  // Karta ze zrzutu = odcisk wywołania bez wpisu-źródła (karty z ekranu odcisku nie mają).
  const besideLive = decided !== null && decided.callPrint !== null && decided.callId === null
    && decided.hookAt !== null && pending !== null && jsonlYoungerThanHook(pending, decided.hookAt);
  if (decided !== null && (sameDecidedDialog(input, decided, text)
    || ((besideStale || besideLive) && resolution.status === 'unreadable'))) return KEEP;
  return {
    kind: 'card',
    // Odcisk wywołania także tu: „Odrzuć" na tej karcie zakłada osłonę po decyzji.
    card: withOrigin(pending === null
      ? degradedCard(degradedId, pending, degradedReason, screen(), screenToolName)
      : withCall(degradedCard(degradedId, pending, degradedReason, screen(), screenToolName), pending, input.pending),
    sourceOrigin ?? SCREEN_ORIGIN),
    audit: degradedReason,
    diagnosis: diagnose(text, mismatchReason),
  };
}
