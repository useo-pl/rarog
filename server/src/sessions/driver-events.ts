/**
 * The three large branches of the manager's driver event dispatch (`#handleDriverEvent`): `init` (engine session,
 * model, effort and ultracode of a card), `history` (the batch of transcript messages at attach) and `agent-state`
 * (the state, seen mark and permission mode reported by herdr). Functions over one session; the manager keeps the
 * `switch` with the short branches and gives each function a narrow port, a subset of {@link DriverEventsPort}.
 * Consent cards, dialog cards and their branches stay in the manager. This module does not import `manager.ts`.
 */
import type { MessageAttachment, TranscriptMessage } from '@rarog/shared';
import type { OwnText } from '@rarog/shared/sentences';
import type { DriverEvent, InternalBlock } from '../drivers/types.ts';
import type { NotifierLike } from '../notify/index.ts';
import { backdateState } from './activity-clocks.ts';
import type { AttachSlots } from './attach-slots.ts';
import type { StalledWaitListener } from './conversation-lists.ts';
import type { ClaimWindows } from './claim-window.ts';
import * as seenMarks from './seen-marks.ts';
import type { SeenMarkStore } from './seen-marks.ts';
import type { HeldEcho, MessageExtra, Session } from './session.ts';
import type { SmEvent } from './state-machine.ts';

/** Fields of the manager configuration the branches read (`ManagerConfig`, described there). */
export interface DriverEventsConfig {
  readonly notifier?: Pick<NotifierLike, 'forget'>;
  readonly stalledWait?: Pick<StalledWaitListener, 'forget'>;
  readonly logger?: (line: string) => void;
  /** Consent channel; only its presence matters here (the nudge on entering `blocked`). */
  readonly consent?: unknown;
  readonly herdrDeps?: { readonly seen?: SeenMarkStore };
}

/** Everything the three branches reach in the manager; each function takes only its own subset. */
export interface DriverEventsPort {
  readonly config: DriverEventsConfig;
  /** Sessions whose current conversation is named by `/rename` (manager `#customTitled`). */
  readonly customTitled: WeakSet<Session>;
  /** Tells the conversation listeners that the pane switched to another conversation (voice agent). */
  conversationChanged(sessionId: string, engineSessionId: string): void;
  /** Cards whose last `agent-state` was `blocked` (manager `#herdrBlocked`). */
  readonly herdrBlocked: Set<string>;
  /** Restore quiet marks of the herdr lifecycle (`HerdrLifecycle.herdrRestoreQuiet`). */
  readonly herdrRestoreQuiet: Map<string, number>;
  readonly attach: Pick<AttachSlots, 'settleAttach'>;
  readonly indexEngineSession: (session: Session, previous?: string) => void;
  readonly applyTransition: (session: Session, event: SmEvent, detail?: OwnText) => boolean;
  readonly emitSessionChanged: (session: Session) => void;
  readonly takeHeld: (session: Session, token: string) => HeldEcho | undefined;
  readonly appendHeld: (session: Session, held: HeldEcho, at?: string) => void;
  readonly appendMessage: (
    session: Session, role: TranscriptMessage['role'], blocks: readonly InternalBlock[], at?: string,
    attachments?: readonly MessageAttachment[], extra?: MessageExtra,
  ) => number;
  /** Dialog card timing (`DialogTimings.timingLeft`, `timingBlocked` in `dialog-timing.ts`). */
  readonly timingLeft: (session: Session) => void;
  readonly timingBlocked: (session: Session) => void;
  /** Nudge of the consent channel (manager `#consentNudge`). */
  readonly consentNudge: (engineSessionId: string | undefined) => void;
  /** The start prompt after the start dialog (manager `#settleStartWait`). */
  readonly settleStartWait: (session: Session) => void;
  /** Grace after an interrupt or a blocked prompt (manager `#inWorkingGrace`). */
  readonly inWorkingGrace: (session: Session) => boolean;
  /** Claim window of the consent channel (`claim-window.ts`): herdr `blocked` right after a hook's claim. */
  readonly claimWindows: Pick<ClaimWindows, 'holdBlocked' | 'herdrMoved' | 'conversationChanged'>;
}

export type InitPort = Pick<
  DriverEventsPort,
  'config' | 'customTitled' | 'conversationChanged' | 'indexEngineSession' | 'applyTransition' | 'emitSessionChanged'
  | 'claimWindows'
>;
export type HistoryPort = Pick<
  DriverEventsPort, 'takeHeld' | 'appendHeld' | 'appendMessage' | 'emitSessionChanged' | 'attach'
>;
export type AgentStatePort = Pick<
  DriverEventsPort, 'config' | 'herdrBlocked' | 'herdrRestoreQuiet' | 'attach' | 'applyTransition'
  | 'emitSessionChanged' | 'timingLeft' | 'timingBlocked' | 'consentNudge' | 'settleStartWait' | 'inWorkingGrace'
  | 'claimWindows'
>;

/** `init` from the driver: engine session, model, effort, ultracode and pull requests of the conversation. */
export function applyInitEvent(
  session: Session, event: Extract<DriverEvent, { type: 'init' }>, port: InitPort,
): void {
  /*
   * `/new` w Codexie to NOWY uuid rollouta w TYM SAMYM panelu. Zapisujemy go, bo
   * od niego zależy znacznik „obejrzane", ale ani nie robimy z niego `engineSessionId`,
   * ani nie wpuszczamy do indeksu pisarzy: obie te rzeczy znaczą „ta karta pisze do
   * pliku jsonl", a Codex takiego pliku nie ma. Karta zostaje ta sama — jest jedna
   * na panel.
   */
  if (session.engine === 'codex') {
    session.observedSessionId = event.engineSessionId;
    return;
  }
  const previousEngineSession = session.engineSessionId;
  session.engineSessionId = event.engineSessionId;
  // Indeks pisarzy musi nadążać za `/clear` w panelu: driver herdr emituje wtedy `init`
  // z NOWYM uuidem sesji silnika, a stary przestaje być zajęty.
  port.indexEngineSession(session, previousEngineSession);
  /*
   * Panel pisze już inną rozmowę (`/clear`, `/resume`): powiadomienia o poprzedniej, w tym
   * zaległe „gotowe", nie mają o czym mówić. Komendę wpisał
   * człowiek przy panelu, a lista zadań nowej rozmowy jest pusta, więc bez tego cisza w tle
   * (`quiet`) dosłałaby „gotowe" o wyniku sprzed `/clear`. Kolejność `init` i nowej listy
   * nie jest pewna; `forget` zdejmuje też uzbrojenie, jeśli lista doszła pierwsza.
   */
  if (previousEngineSession !== undefined && previousEngineSession !== event.engineSessionId) {
    port.config.notifier?.forget(session.id);
    // The stalled wait alarm of the previous conversation stops its tries too.
    port.config.stalledWait?.forget(session.id);
    // A claim window of the previous conversation does not hold a dialog of the new one (`claim-window.ts`).
    port.claimWindows.conversationChanged(session);
  }
  // Silnik właśnie powiedział, czym NAPRAWDĘ liczy — to nadpisuje alias z formularza.
  const modelChanged = event.model !== '' && session.model !== event.model;
  if (modelChanged) session.model = event.model;
  // `effort` z jsonl mówi, co silnik NAPRAWDĘ ma; brak pola = starsze CLI, nie zmiana.
  const effortChanged = event.effort !== undefined && session.effort !== event.effort;
  if (effortChanged) session.effort = event.effort;
  /*
   * Ultracode tak samo: znacznik z jsonl nadpisuje żądanie, brak znacznika niczego nie zmienia. Dwa
   * wyjątki zdejmują pole z karty. `null`: ta sama rozmowa, ale nowy proces CLI (`/exit` i `claude --resume`
   * przy biurku) albo luka w odczycie pliku, więc znacznik i żądanie przestały się liczyć (czytelnik pliku,
   * `createUltracodeTracker`). Panel pisze INNĄ rozmowę (`/clear`, `/resume`
   * przy biurku): stan nowej potwierdzi dopiero jej plik (czytelnik zaczyna od zera). Karta do dowodu nie ma
   * pola, zamiast nieść stan procesu albo rozmowy, której już nie ma.
   */
  const conversationChanged = previousEngineSession !== undefined
    && previousEngineSession !== event.engineSessionId;
  /*
   * Nazwa z `/rename` należy do rozmowy, nie do panelu: nowa rozmowa (`/clear` niesie własny wpis
   * `custom-title`, `/resume` rozmowy bez nazwy go nie ma) wraca do reguły tytułu herdr. Etykieta stoi do
   * jego zmiany albo do wpisu nowego pliku.
   */
  if (conversationChanged) port.customTitled.delete(session);
  /*
   * The messages in memory so far belong to the previous conversation (the voice agent's `asksOwner`), except the
   * history imported since the last `init` from the conversation this `init` names: a driver attaching to a pane that
   * moved meanwhile hands over that history first.
   */
  const imported = session.importedHistory;
  session.importedHistory = undefined;
  if (conversationChanged) {
    session.conversationStartSeq = imported?.engineSessionId === event.engineSessionId
      ? imported.fromSeq : session.ring.lastSeq;
  }
  if (conversationChanged) port.conversationChanged(session.id, event.engineSessionId); // voice agent
  const nextUltracode = event.ultracode === null ? undefined
    : event.ultracode ?? (conversationChanged ? undefined : session.ultracode);
  const ultracodeChanged = session.ultracode !== nextUltracode;
  if (ultracodeChanged) session.ultracode = nextUltracode;
  /*
   * PR-y należą do rozmowy jak artefakty. Driver po wymianie startuje z pustym podpisem listy, więc
   * pusta lista nowej rozmowy nie wyszłaby z niego nigdy: lista poprzedniej schodzi tu, przy zmianie rozmowy.
   */
  const pullRequestsDropped = conversationChanged && (session.pullRequests !== undefined
    || session.pullRequestLinks !== undefined || session.scheduledTasks !== undefined);
  if (pullRequestsDropped) {
    // The links and the window too, and scheduled tasks; the driver sends the new conversation's after this `init`.
    session.pullRequests = undefined;
    session.pullRequestLinks = undefined;
    session.pullRequestWindowStart = undefined;
    session.scheduledTasks = undefined;
  }
  const moved = port.applyTransition(session, { type: 'driver-init' });
  // Siatka bezpieczeństwa: turę zerową domyka `#settleEmptyStart` już przy podpięciu
  // drivera (realny silnik wysyła `init` dopiero po pierwszej wiadomości). Gałąź zostaje
  // dla drivera, który jej nie przeszedł — nigdy nie szkodzi, bo `result` w stanie
  // innym niż tura jest no-opem.
  if (session.emptyStart) {
    session.emptyStart = false;
    port.applyTransition(session, { type: 'result', subtype: 'success' });
    // Jak w `#settleEmptyStart`: tura zerowa nie domyka rachunku wiadomości.
    session.turnInput = undefined;
  } else if ((modelChanged || effortChanged || ultracodeChanged || pullRequestsDropped) && !moved) {
    /*
     * Sam model ani sam effort nie są przejściem stanu, więc karta musi dostać osobne
     * odświeżenie. Dotyczy to też effortu: `init` poza `starting` nie rusza stanu
     * (`transition`), więc panel, w którym zmienił się WYŁĄCZNIE poziom (ten sam
     * rozwiązany model), zostawiałby pigułkę na starej wartości do najbliższej tury.
     */
    port.emitSessionChanged(session);
  }
}

/*
 * PORCJA historii przy podpięciu — jedno zdarzenie na całą paczkę.
 *
 * Bez `#emitSessionChanged` na wiadomość i bez `maybeGitStatus`: 17 paneli po 60
 * wiadomości to przy broadcaście per wiadomość ponad tysiąc globalnych ramek SSE
 * w pierwszych sekundach po starcie Raroga — czyli telefon, który mieli się przez
 * pół minuty, zanim pokaże listę.
 */
export function applyHistoryEvent(
  session: Session, event: Extract<DriverEvent, { type: 'history' }>, port: HistoryPort,
): void {
  if (session.state === 'done') return;
  // Historii nie liczymy, a bywa w niej prompt tury, która jeszcze trwa: po każdej porcji
  // rachunek wiadomości tury jest niepełny do następnego końca tury.
  session.turnInput = undefined;
  // Where this conversation's history starts in memory, for an `init` that names it next (`applyInitEvent`).
  if (event.engineSessionId !== undefined && session.importedHistory?.engineSessionId !== event.engineSessionId) {
    session.importedHistory = { engineSessionId: event.engineSessionId, fromSeq: session.ring.lastSeq };
  }
  for (const item of event.messages) {
    // Echo odroczone na swojej pozycji historii: podstawiamy wstrzymaną wiadomość
    // z czasem wpisu; token nieznany = duplikat już spłukanej, przepada.
    if (item.echoToken !== undefined) {
      const held = port.takeHeld(session, item.echoToken);
      if (held !== undefined) port.appendHeld(session, held, item.at);
      continue;
    }
    port.appendMessage(
      session, item.role, item.blocks, item.at, item.attachments, {
        ...(item.notice !== undefined ? { notice: item.notice } : {}),
        ...(item.promptBlocked !== undefined ? { promptBlocked: item.promptBlocked } : {}),
      },
    );
  }
  /*
   * `lastActivityAt` ZOSTAJE z pliku, a nie z czasu PODPIĘCIA: po restarcie Raroga
   * wszystkie panele dostałyby ten sam znacznik z jednej sekundy, więc telefon pokazałby
   * kilkanaście kart z identycznym „21 min" — czyli wiekiem SERWERA, a nie sesji. To samo
   * pole jest kluczem sortowania bezczynnych, które porządkowałoby listę kolejnością podpinania.
   *
   * Panel z wczorajszą rozmową nie ląduje przez to źle: klient sortuje najpierw po RANDZE (co
   * czeka na człowieka), a dopiero wewnątrz bezczynnych po świeżości — wczorajsza rozmowa ma
   * stać niżej niż ta sprzed dziesięciu minut i to jest właśnie oczekiwana kolejność.
   */
  /*
   * …i z tego samego powodu `stateSince` COFA SIĘ do ostatniego znaku życia w pliku,
   * żeby wiersz nie mówił „pracuje 23 min", a karta „3 min".
   *
   * Znacznik stanu powstaje przy ADOPCJI panelu, czyli mówi „od kiedy RAROG o tym wie",
   * a nagłówek i karta czytają go jako „od kiedy agent pracuje". Po restarcie serwera obie
   * liczby startowałyby więc od zera, podczas gdy wiersz aktywności — liczony z ciszy
   * w pliku — pamięta prawdę. Plik jest tu mocniejszym świadkiem: skoro agent pisał
   * ostatnią linię 23 minuty temu, to w tym stanie jest CO NAJMNIEJ od tamtej chwili.
   *
   * Wyłącznie W TYŁ i wyłącznie przy imporcie historii: prawdziwe przejście stanu
   * (`#applyTransition`) stempluje `stateSince` czasem przejścia i tego nikt nie rusza.
   */
  const learned = Date.parse(session.stateSince);
  const lastSeen = Date.parse(session.lastActivityAt);
  if (Number.isFinite(learned) && Number.isFinite(lastSeen) && lastSeen < learned) {
    backdateState(session, session.lastActivityAt);
  }
  port.emitSessionChanged(session);
  port.attach.settleAttach(session);
}

/**
 * Podpis pól WIDOCZNYCH NA KARCIE: jedyna lista pól, których zmiana przy `agent-state` wysyła
 * `session-changed`. Liczy go {@link applyAgentStateEvent} przed zmianami i {@link emitIfChanged} po nich.
 */
function cardSignature(session: Session): string {
  return `${session.herdrMode ?? ''}|${String(session.seen)}`
    + `|${session.herdrDialog ?? ''}|${session.herdrDialogReason ?? ''}`
    // Sam ROZMIAR wycinka: treść zmienia się wyłącznie razem z kartą albo odświeżeniem wycinka, a oba mają
    // własne zdarzenia (`dialog-screen` porównuje pełny tekst) — dwa kilobajty ekranu w podpisie byłyby pracą
    // przy każdym obrocie resyncu.
    + `|${String(session.herdrDialogScreen?.length ?? 0)}|${session.cliDialog ?? ''}`
    + `|${String(session.stale)}`;
}

/**
 * Rozgłasza kartę TYLKO wtedy, gdy któreś z jej widocznych pól naprawdę się zmieniło.
 *
 * `before` to podpis tych pól sprzed zmian ({@link cardSignature}, patrz {@link applyAgentStateEvent}). Bez tego
 * porównania powtarzany przy każdym resyncu status zamieniłby się w stały strumień pustych ramek.
 */
function emitIfChanged(session: Session, before: string, port: Pick<DriverEventsPort, 'emitSessionChanged'>): void {
  if (cardSignature(session) !== before) port.emitSessionChanged(session);
}

/*
 * Stan raportowany przez ZEWNĘTRZNEGO nadzorcę. Zdarzenie niesie trzy niezależne
 * rzeczy: stan (przez maszynę stanów), `seen` (SUROWY status badge'a herdr: `false`
 * = badge `done` stoi, `true` = panel bez badge'a — o ODBIORZE decyduje manager niżej)
 * i tryb uprawnień panelu.
 */
export function applyAgentStateEvent(
  session: Session, event: Extract<DriverEvent, { type: 'agent-state' }>, port: AgentStatePort,
): void {
  if (session.state === 'done') return;
  /*
   * Migawka pól WIDOCZNYCH NA KARCIE sprzed zmian — bo resync powtarza
   * status przy każdym obrocie, także gdy nic się nie ruszyło. Bezwarunkowy
   * `session-changed` znaczyłby wtedy 17 ramek globalnego SSE co 30 s bez ani jednej
   * nowej informacji, czyli dokładnie ten szum, przed którym ostrzega komentarz niżej.
   */
  const before = cardSignature(session);
  const stateBefore = session.state;
  if (event.mode !== undefined) session.herdrMode = event.mode;
  if (event.stateChangeSeq !== undefined) session.herdrSeq = event.stateChangeSeq;
  seenMarks.applyHerdrSeen(session, event, port.config.herdrDeps?.seen);
  // Panel przestał być zablokowany → nie ma dialogu, więc nie ma czego zatwierdzać.
  // Driver zgasi kartę własnym `permission-cleared`, ale dopiero po debouncie; tutaj
  // jest to natychmiast i za darmo, a przycisk bez pokrycia jest gorszy niż jego brak.
  //
  // Wyjątek „spóźniony herdr `working`, a rejestr CLI dalej `waiting`" NIE
  // stoi tutaj, tylko w driverze: `agent-state` niesie blokadę EFEKTYWNĄ (herdr `blocked`
  // albo rezerwa z ekranu albo rezerwa z rejestru), więc przy żywym dialogu przychodzi tu
  // `blocked`. Drugi warunek na rejestr w tym miejscu zrobiłby z rejestru osobne źródło
  // stanu i trzymałby kartę, którą driver zdjął po ekranie bez dialogu.
  if (event.state !== 'blocked') {
    session.herdrDialog = undefined;
    session.herdrDialogReason = undefined;
    session.herdrDialogScreen = undefined;
    session.cliDialog = undefined;
    port.herdrBlocked.delete(session.id);
    port.timingLeft(session);
    port.claimWindows.herdrMoved(session);
  } else if (!port.herdrBlocked.has(session.id)) {
    // Wejście w blokadę (pierwszy `blocked` po innym stanie; powtórki z resyncu nic nie robią): pomiar drogi karty
    // i szturchnięcie kanału zgód, żeby karta kanału nie czekała na takt rejestru.
    port.herdrBlocked.add(session.id);
    port.timingBlocked(session);
    if (port.config.consent !== undefined) port.consentNudge(session.engineSessionId);
  }
  // Świeży stan z nadzorcy znaczy, że kontakt wrócił.
  session.stale = false;
  // Prompt startowy po dialogu startowym rusza po przejściu niżej (obietnica, więc dopiero po tym zdarzeniu).
  if (event.state === 'idle') port.settleStartWait(session);
  // Karencja po przerwaniu (patrz `INTERRUPT_WORKING_GRACE_MS`): spóźniony `working`
  // z ubitej tury nie ma prawa wskrzesić spinnera. Meta (tryb, seen) już zapisane. Ta sama karencja
  // po prompcie zablokowanym przez hook: herdr miga `working` ~30 ms po wpisie blokady.
  if (event.state === 'working' && session.state === 'waiting-input' && port.inWorkingGrace(session)) {
    emitIfChanged(session, before, port);
    return;
  }
  const smEvent: SmEvent = event.state === 'working'
    ? { type: 'agent-working' }
    : (event.state === 'idle' ? { type: 'agent-idle' } : { type: 'agent-blocked' });
  // `#applyTransition` sam rozgłasza `session-changed`, gdy stan się ruszył — drugi
  // broadcast byłby przy 17 panelach czystym szumem w strumieniu globalnym.
  // Right after the hook claimed a phone answer the answered dialog is still on the pane, so herdr repeats `blocked`:
  // inside the claim window it leaves the state alone (`claim-window.ts`), and a dialog that stays moves it after.
  if (event.state === 'blocked' && port.claimWindows.holdBlocked(session, event.detail)) {
    emitIfChanged(session, before, port);
  } else if (port.applyTransition(session, smEvent, event.detail)) {
    /*
     * Stan się RUSZYŁ na wiadomość z herdr — czyli przed chwilą pokazywaliśmy co innego,
     * niż panel naprawdę robił. Przy zwykłej pracy to normalne (agent skończył turę),
     * ale to samo zdarzenie łapie KOREKTĘ po rozjeździe, a tej nie da się odtworzyć
     * z pamięci użytkownika. Jedna linia, tylko przy faktycznej zmianie.
     */
    port.config.logger?.(
      `herdr: stan ${session.id} ${stateBefore} → ${session.state} (herdr: ${event.state})`,
    );
  } else {
    emitIfChanged(session, before, port);
  }
  // Znacznik ciszy po odtworzeniu jest JEDNORAZOWY: zużywa go pierwszy stan inny niż
  // praca — także przejście-tożsamość, po którym `#note` w ogóle nie padło. Inaczej
  // karta, która wróciła od razu bezczynna, wyciszyłaby koniec pierwszej prawdziwej tury.
  if (event.state !== 'working') port.herdrRestoreQuiet.delete(session.id);
  port.attach.settleAttach(session);
}
