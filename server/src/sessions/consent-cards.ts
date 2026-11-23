/**
 * Consent channel cards (layer 1) in the session manager: which card carries a conversation's cards, the
 * cards on the wire and in the snapshot, a device decision on a card with its gates, and the cards' end with the
 * session (hold, retire, release, revoke). The cycle itself (files, hook, signatures) lives in
 * `herdr/dialogs/layer1/`; screen cards and the registry nudge stay in the manager. Does not import `manager.ts`.
 */
import type { PermissionRequest, ServerEvent } from '@rarog/shared';
import type { ClaimWindows } from './claim-window.ts';
import { BadRequestError } from './errors.ts';
import type { Session } from './session.ts';
import type { SmEvent } from './state-machine.ts';
import { HERDR_OUT_OF_SCOPE_MESSAGE } from './state-sentences.ts';
import type { DialogCardKind } from './state-sentences.ts';
import type { ConsentRefusalBody, DeviceDecision, ResolveResult } from '../permissions.ts';
import { classifyRisk } from '../risk.ts';
import { consentStep } from '../herdr/consent-step.ts';
import type { HerdrAgent, HerdrSupervisor } from '../herdr/types.ts';
import type { ConsentCardView } from '../herdr/dialogs/layer1/cards.ts';
import { CONSENT_FINAL_STATES, CONSENT_HOLDING_STATES } from '../herdr/dialogs/layer1/contract.ts';
import type { ConsentDecision } from '../herdr/dialogs/layer1/contract.ts';
import type { ConsentOutcome } from '../herdr/dialogs/layer1/cycle.ts';
import {
  consentPermissionRequest, consentResolvedEvent, consentSettledEvent,
} from '../herdr/dialogs/layer1/frames.ts';

/**
 * Widok karty kanału zgód dla managera: `retired` = karta zdjęta z urządzeń na końcu sesji albo przy `running` (pole
 * rekordu cyklu, {@link ConsentManagerChannel.retire}), także przed restartem serwera. Manager trzyma ją poza
 * migawką, a decyzja na niej = 410. `decision` is the record's decision: `null` = no device answered the card, so an
 * `unknown` card has nothing left to show and leaves the devices ({@link leavesDevices}); absent = the port does not
 * say, and an `unknown` card stays.
 */
export type ConsentManagerCard = ConsentCardView & {
  readonly retired?: true;
  readonly decision?: ConsentDecision | null;
};

/**
 * Karty kanału zgód (warstwa 1) widziane z managera: cykl `layer1/cycle.ts` po sesji silnika
 * (`engineSessionId`). Karty kanału żyją poza `PendingInteractions`: stały `permId` (klucz hooka), stan z cyklu,
 * zmiany przez `applyConsentCard`. Brak pola = serwer bez kanału (tryb `off`/`shadow`, demo).
 */
export interface ConsentManagerChannel {
  /** Widoki kart kanału sesji silnika, w kolejności pojawienia się. */
  cards(engineSessionId: string): readonly ConsentManagerCard[];
  decide(engineSessionId: string, permId: string, decision: 'allow' | 'allow-always' | 'deny'): Promise<ConsentOutcome>;
  release(engineSessionId: string, permId: string): Promise<ConsentOutcome>;
  /**
   * Koniec procesu sesji silnika (`layer1/cycle.ts`, `revokeSession` z `hook-dead`): `pending` = `revoked`, `sent` =
   * plik odpowiedzi odwołany, bez nowego pliku; wpisy rejestru sesji zapomniane. Wynik = klucze zmienionych kart.
   * Utrata kontaktu z panelem (`stale`) tu nie trafia: odpowiedź idzie plikiem do hooka, a śmierć hooka widzi
   * obserwacja cyklu.
   */
  revoke(engineSessionId: string, cause: 'hook-dead'): Promise<readonly string[]>;
  /**
   * Karta zdjęta z urządzeń na końcu sesji albo przy `running` (`layer1/cycle.ts`, `retire`): zapis w rekordzie cyklu,
   * który przeżywa restart serwera. Cykl nie publikuje już tej karty urządzeniom, a {@link cards} niesie ją
   * z `retired`. Stan rekordu i pliki odpowiedzi bez zmian. Błąd zostawia zdjęcie tylko w pamięci managera.
   */
  retire(engineSessionId: string, permId: string): Promise<void>;
  /**
   * Koniec tury sesji silnika bez wpisu w transkrypcie (sesja weszła w stan końcowy tury: bezczynność po turze,
   * wyjście procesu, `/exit`): cykl rozlicza wyłącznie odpowiedzi odebrane (`claimed`, `running`) według faktów tury,
   * a karty `pending` i `sent` zostają. Nie rzuca.
   */
  turnEnded(engineSessionId: string): Promise<void>;
  /**
   * Powrót gniazda herdr na znanym panelu (`re-attached`), tuż przed odpięciem starego drivera, w tym samym kroku
   * synchronicznym: okres utraty dowodu w cyklu (`layer1/cycle.ts`, `markReattached`) dla każdej podanej sesji silnika,
   * otwarty w chwili wywołania. Trwa do pierwszej obserwacji ze znanym transkryptem, a tę po wywołaniu zaczyna już
   * tylko nowy driver. Hook rozpoczęty przed jej końcem traci dowód „dialog stoi” na stałe: nowy follower nie wie, co
   * stało się z plikiem rozmowy w przerwie i przed swoim pierwszym odczytem.
   */
  reattached(engineSessionIds: readonly string[]): Promise<void>;
  /**
   * Koniec rozmowy (`layer1/cycle.ts`, `endPool`): pula sesji silnika z pamięci i jej znaczniki prośby z dysku. Manager
   * woła to na końcu procesu sesji (panel `gone`, wyjście procesu) tylko wtedy, gdy żaden inny żywy panel, także ukryty
   * (świeży `agent.list` nadzorcy), nie prowadzi tej rozmowy. Brak pola = znaczniki zostają do sprzątania startu.
   */
  ended?(engineSessionId: string): void;
}

/** Fields of the manager configuration the consent cards read (`ManagerConfig`, described there). */
export interface ConsentCardsConfig {
  readonly consent?: ConsentManagerChannel;
  readonly logger?: (line: string) => void;
  readonly herdrSupervisor?: Pick<HerdrSupervisor, 'liveEngineSessions'>;
}

/** What the consent cards reach in the manager: shared maps and the calls listed below. */
export interface ConsentCardsPort {
  readonly sessions: ReadonlyMap<string, Session>;
  /** `HerdrAgent.key` → Rarog session id (a pane waiting for an attach slot still has its entry). */
  readonly herdrByKey: ReadonlyMap<string, string>;
  /** Card with a live pane from the writer index (manager `#liveSession`). */
  readonly liveSession: (engineSessionId: string) => Session | null;
  /** A screen card or a question waits on the session (`PendingInteractions.hasPending`). */
  readonly hasPending: (sessionId: string) => boolean;
  readonly emitSession: (session: Session, event: ServerEvent) => void;
  readonly emitSessionChanged: (session: Session) => void;
  readonly applyTransition: (session: Session, event: SmEvent) => boolean;
  /** Notifier step of a state event (manager `#note`, default arguments). */
  readonly note: (session: Session, event: SmEvent) => void;
  readonly timingCard: (session: Session, kind: DialogCardKind) => void;
  /** One card per dialog: screen and jsonl consent cards of the session expire (manager `#dropScreenPermissions`). */
  readonly dropScreenPermissions: (session: Session) => void;
  /** Write gate of panes: `RAROG_HERDR_SEND=0` and a read-only supervisor refuse (manager `#assertHerdrWritable`). */
  readonly assertHerdrWritable: () => void;
  /** Claim window of the session state after a hook's claim (`claim-window.ts`). */
  readonly claimWindows: Pick<ClaimWindows, 'consentCard' | 'turnEnded'>;
}

/** Consent channel cards of the manager's sessions; one instance per manager. */
export class ConsentCards {
  readonly #config: ConsentCardsConfig;
  readonly #port: ConsentCardsPort;
  /** Karty kanału zgód ogłoszone urządzeniom (`permission-pending`), klucz `<sesja Raroga>\n<permId>`. */
  readonly #consentShown = new Set<string>();
  /**
   * Karty kanału zgód zdjęte z urządzeń na końcu sesji ({@link holdConsentCards}) albo przy `running`
   * ({@link #retireAnswered}), klucz `<sesja silnika>\n<permId>`: nie wracają na żadną kartę Raroga, a decyzja na nich
   * = 410. Wpis trzyma zdjęcie do zapisu pola w rekordzie cyklu (port `retire`, {@link #saveRetired}) i znika po nim
   * albo wcześniej, gdy z cyklu dojdzie stan końcowy karty. Od zapisu, także po restarcie serwera, tę samą rolę pełni
   * pole rekordu (`retired` w widoku portu). Błąd zapisu zostawia wpis do końca procesu.
   */
  readonly #consentRetired = new Set<string>();

  constructor(config: ConsentCardsConfig, port: ConsentCardsPort) {
    this.#config = config;
    this.#port = port;
  }

  /** Karta kanału zgód sesji o tym `permId` albo `null`. */
  consentCardOf(session: Session, permId: string): ConsentManagerCard | null {
    const consent = this.#config.consent;
    const engine = session.engineSessionId;
    if (consent === undefined || engine === undefined || engine === '') return null;
    try {
      return consent.cards(engine).find((card) => card.permId === permId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Decyzja na karcie kanału: `allow`, `allow-always` (opcja „zawsze”) i `deny` przez protokół zapisu cyklu,
   * `release` jako przejście sterujące; karta bez opcji „zawsze” = 422 `allow-always`. Zdarzenia karty idą z cyklu
   * (`applyConsentCard`), więc odpowiedź `ok` niczego tu nie rozgłasza. Błąd cyklu = odmowa, nigdy zgoda.
   *
   * Decyzję przyjmuje wyłącznie karta, która obsługuje rozmowę ({@link #ownsConsent}): karta historyczna (stary panel
   * wznowionej rozmowy, sesja `done`) i karta zdjęta po końcu sesji dają 410 bez pliku, także dla `deny` i `release`.
   * `allow` i `allow-always` przechodzą te same bramki co zgoda z ekranu, liczone na tej karcie: panel spoza zasięgu
   * i „widzę, nie ruszam” (`RAROG_HERDR_SEND=0`, tylko odczyt) odmawiają 400, zanim cykl zapisze plik. Tak samo panel
   * spoza zasięgu z tą samą rozmową, który żyje obok: hook karty może należeć do niego. `deny` i `release` przechodzą
   * na karcie rozmowy zawsze: odmowa i zwolnienie niczego nie zatwierdzają, a zdejmują kartę z telefonu.
   */
  async resolveConsent(session: Session, card: ConsentManagerCard, decision: DeviceDecision): Promise<ResolveResult> {
    const consent = this.#config.consent;
    const engine = session.engineSessionId;
    const permId = card.permId;
    if (consent === undefined || engine === undefined) return { outcome: 'gone' };
    if (!this.#ownsConsent(session) || this.#consentCardRetired(engine, card)) return { outcome: 'gone' };
    if (decision === 'allow' || decision === 'allow-always') {
      if (session.outOfScope === true || this.#consentOutOfScopeNearby(session)) {
        throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
      }
      this.#port.assertHerdrWritable();
    }
    const outcome = await consentStep('decision', this.#config.logger, () => (decision === 'release'
      ? consent.release(engine, permId) : consent.decide(engine, permId, decision)));
    if (outcome === undefined) return consentRefusal(422, 'send-failed', 'dialogs.refuse.send-failed');
    if (outcome.ok) return { outcome: 'ok' };
    return consentOutcomeResult(decision === 'release', outcome);
  }

  /**
   * Inna karta tej samej rozmowy, która nie skończyła się (`done`), z panelem spoza zasięgu: dwa panele piszą jedną
   * rozmowę, a hook karty kanału może należeć do tego spoza zasięgu.
   */
  #consentOutOfScopeNearby(session: Session): boolean {
    for (const other of this.#port.sessions.values()) {
      if (other === session || other.engineSessionId !== session.engineSessionId || other.state === 'done') continue;
      if (other.outOfScope === true) return true;
    }
    return false;
  }

  /**
   * Karty kanału zgód sesji na drucie, bez stanów końcowych (zdjęte kartą `permission-resolved`), bez kart zdjętych
   * (koniec sesji, `running`) i bez kart `running`. Karta `running` bez zdjęcia to karta, której zmiana z cyklu nie
   * doszła do managera (rekord z `recover` przed managerem): dostaje zdjęcie tutaj ({@link #retireAnswered}). The same
   * goes for an `unknown` card no device answered ({@link leavesDevices}), also a recovered record without `retired`.
   * Karty niesie wyłącznie karta, która obsługuje rozmowę ({@link #ownsConsent}); karta historyczna i sesja `done`
   * nie niosą żadnej.
   */
  consentRequests(session: Session): PermissionRequest[] {
    const consent = this.#config.consent;
    const engine = session.engineSessionId;
    if (consent === undefined || engine === undefined || engine === '' || !this.#ownsConsent(session)) return [];
    let cards: readonly ConsentManagerCard[];
    try {
      cards = consent.cards(engine);
    } catch {
      return [];
    }
    return cards
      .filter((card) => {
        if ((CONSENT_FINAL_STATES as readonly string[]).includes(card.state)) return false;
        if (this.#consentCardRetired(engine, card)) return false;
        if (!leavesDevices(card.state, card.decision)) return true;
        this.#retireAnswered(card, null);
        return false;
      })
      .map((card) => this.#consentRequest(session, card));
  }

  /** Cards the session snapshot carried count as shown: later changes go as `permission-settled`, not `pending`. */
  noteShown(session: Session, requests: readonly PermissionRequest[]): void {
    for (const card of requests) this.#consentShown.add(`${session.id}\n${card.permId}`);
  }

  /**
   * Karta zdjęta z urządzeń (koniec sesji, `running`): w pamięci tego procesu ({@link #consentRetired}) albo polem
   * rekordu cyklu sprzed restartu (`retired` w widoku portu).
   */
  #consentCardRetired(engine: string, card: ConsentManagerCard): boolean {
    return card.retired === true || this.#consentRetired.has(`${engine}\n${card.permId}`);
  }

  #consentRequest(session: Session, card: ConsentCardView): PermissionRequest {
    const presentation = card.presentation;
    const text = presentation === null ? ''
      : [presentation.displayText, ...presentation.fields.map((f) => `${f.name}: ${f.value}`)].join('\n');
    return consentPermissionRequest({ ...card, sessionId: session.id }, {
      cwd: session.cwd,
      risk: presentation === null ? 'red' : classifyRisk(text, card.toolName),
    });
  }

  /**
   * Zmiana karty kanału zgód z cyklu (`layer1/cycle.ts`, `onCard`): pierwsza karta niekońcowa idzie jako
   * `permission-pending`, każda następna zmiana jako `permission-settled`, stan końcowy jako `permission-resolved`
   * (`applied` z decyzją odebraną przez hook, reszta `expired`). `running` zdejmuje kartę z urządzeń od razu
   * ({@link #retireAnswered}), and so does `unknown` without a decision (`decision` `null`, {@link leavesDevices}).
   * Karta sesji, której manager nie zna, i karta końcowa, której urządzenia nie widziały, nie idą nigdzie. Karta
   * pokazana migawką sesji (`transcript`) liczy się jako pokazana. `waitingFor` i push liczą wyłącznie stan `pending`.
   *
   * Sesja to karta, która obsługuje rozmowę ({@link #consentSessionOf}). Karta zdjęta po końcu sesji
   * ({@link retireConsentCards}) nie idzie nigdzie, a sesja `done` nie dostaje nowych kart ani zmian: kartę, którą
   * urządzenia jeszcze widzą, zdejmuje `permission-resolved` (`expired` od `system`). Pierwsze pojawienie się karty
   * kanału zdejmuje karty zgody z ekranu tej sesji (jedna karta na dialog).
   */
  applyConsentCard(view: ConsentCardView, decision: ConsentDecision | null): void {
    const final = (CONSENT_FINAL_STATES as readonly string[]).includes(view.state);
    const retired = `${view.sessionId}\n${view.permId}`;
    if (this.#consentRetired.has(retired)) {
      // Rekord idzie dalej za dowodem (audyt); urządzenia kartę już zdjęły.
      if (final) this.#consentRetired.delete(retired);
      return;
    }
    if (leavesDevices(view.state, decision)) {
      this.#retireAnswered(view, decision);
      return;
    }
    const session = this.#consentSessionOf(view.sessionId);
    if (session === null) return;
    const slot = `${session.id}\n${view.permId}`;
    if (session.state === 'done') {
      if (this.#consentShown.delete(slot)) this.#emitConsentExpired(session, view.permId);
      return;
    }
    // `claimed` opens the claim window of the session state, a new request's `pending` ends it (`claim-window.ts`).
    this.#port.claimWindows.consentCard(session, view);
    const wire: ConsentCardView = { ...view, sessionId: session.id };
    if (!this.#consentShown.has(slot)) {
      if (final) return;
      this.#consentShown.add(slot);
      if (view.state === 'pending' || view.state === 'sent') this.#port.dropScreenPermissions(session);
      this.#port.emitSession(session, { type: 'permission-pending', request: this.#consentRequest(session, view) });
      this.#port.timingCard(session, 'hook');
      if (view.state !== 'pending' || !this.#port.applyTransition(session, { type: 'permission-requested' })) {
        this.#port.emitSessionChanged(session);
        if (view.state === 'pending') this.#port.note(session, { type: 'permission-requested' });
      }
      return;
    }
    if (!final) {
      this.#port.emitSession(session, consentSettledEvent(wire, Date.now()));
      if (view.state !== 'pending' && !this.decisionStands(session)) {
        if (!this.#port.applyTransition(session, { type: 'permission-resolved' })) this.#port.emitSessionChanged(session);
      } else {
        this.#port.emitSessionChanged(session);
      }
      return;
    }
    this.#consentShown.delete(slot);
    const resolved = consentResolvedEvent(wire, decision, CONSENT_RESOLVED_BY);
    if (resolved !== null) this.#port.emitSession(session, resolved);
    if (this.decisionStands(session) || !this.#port.applyTransition(session, { type: 'permission-resolved' })) {
      this.#port.emitSessionChanged(session);
    }
  }

  /**
   * Karta kanału w stanie `running` (zasada 3): hook odebrał odpowiedź, a dialog karty zniknął albo CLI
   * pyta o coś innego. Skutek w transkrypcie (`applied`) przychodzi dopiero po końcu tury, a na karcie nie ma już nic
   * do rozstrzygnięcia, więc schodzi z urządzeń od razu: `permission-resolved` z decyzją rekordu od hooka (bez
   * decyzji `expired`) na karcie sesji, która ją pokazała, potem zdjęcie jak na końcu sesji ({@link #consentRetired},
   * port `retire`). `allow` znaczy tu „odpowiedź oddana hookowi”, nie „narzędzie wykonane”. Karta, której urządzenia
   * nie widziały (pierwszy widok w procesie), nie idzie na drut, a zdjęcie dostaje tak samo. Nie wraca na żadną kartę
   * Raroga, także po restarcie serwera i po zmianie panelu rozmowy; rekord idzie dalej za dowodem (audyt).
   *
   * An `unknown` card no device answered ({@link leavesDevices}) leaves the same way, as `expired` from the hook: the
   * call ended without our answer, and the card has no button and nothing a later proof could still tell the phone.
   */
  #retireAnswered(view: ConsentCardView, decision: ConsentDecision | null): void {
    const engine = view.sessionId;
    this.#consentRetired.add(`${engine}\n${view.permId}`);
    const session = this.#consentSessionOf(engine);
    if (session !== null && this.#consentShown.delete(`${session.id}\n${view.permId}`)) {
      // `consentResolvedEvent` has a frame for `running` and the final states only.
      const resolved = consentResolvedEvent({ ...view, sessionId: session.id }, decision, CONSENT_RESOLVED_BY);
      if (resolved !== null) this.#port.emitSession(session, resolved);
      else this.#emitConsentExpired(session, view.permId, CONSENT_RESOLVED_BY);
      if (session.state !== 'done'
        && (this.decisionStands(session) || !this.#port.applyTransition(session, { type: 'permission-resolved' }))) {
        this.#port.emitSessionChanged(session);
      }
    }
    void this.#saveRetired(engine, view.permId);
  }

  /**
   * Zapis zdjęcia karty w rekordzie cyklu (port `retire`). Po zapisie wpis {@link #consentRetired} schodzi: zdjęcie
   * niesie odtąd widok portu (`retired`), a cykl zmian tej karty urządzeniom już nie publikuje. Błąd zapisu idzie do
   * logu, a wpis zostaje do końca procesu (zdjęcie tylko w pamięci). Nie rzuca.
   */
  async #saveRetired(engine: string, permId: string): Promise<void> {
    const consent = this.#config.consent;
    if (consent === undefined) return;
    try {
      await consent.retire(engine, permId);
    } catch (err) {
      this.#config.logger?.(`consent: card ${permId} retire not saved: ${describeError(err)}`);
      return;
    }
    this.#consentRetired.delete(`${engine}\n${permId}`);
  }

  /**
   * Karta, która obsługuje rozmowę `engineSessionId` (karty kanału zgód tej sesji silnika): karta z żywym panelem
   * z indeksu pisarzy, potem inna karta z żywym panelem tej rozmowy, a bez nich ostatnia karta w RAM, która tę
   * rozmowę pisała (panel zniknął, driver odpięty, stan `done`). Karta zapomniana (ukrycie, zamknięcie z telefonu)
   * nie dostaje nic: lista urządzeń zdejmuje ją razem z kartami.
   */
  #consentSessionOf(engineSessionId: string): Session | null {
    const indexed = this.#port.liveSession(engineSessionId);
    if (indexed !== null) return indexed;
    let live: Session | null = null;
    let last: Session | null = null;
    for (const session of this.#port.sessions.values()) {
      if (session.engineSessionId !== engineSessionId) continue;
      last = session;
      if (session.driver !== null && session.state !== 'done') live = session;
    }
    return live ?? last;
  }

  /**
   * Czy karty kanału zgód rozmowy należą do tej karty: karta obsługuje rozmowę ({@link #consentSessionOf}) i jej
   * sesja się nie skończyła (`done`). Tylko taka karta niesie karty w migawce, przyjmuje decyzje i przekłada swój
   * koniec (przerwanie, zamknięcie, koniec procesu) na karty rozmowy. Karta historyczna (stary panel rozmowy
   * wznowionej w nowym) nie odwołuje, nie zwalnia i nie rozstrzyga kart następcy.
   */
  #ownsConsent(session: Session): boolean {
    const engine = session.engineSessionId;
    if (engine === undefined || engine === '' || session.state === 'done') return false;
    return this.#consentSessionOf(engine) === session;
  }

  /**
   * Czy dialog sesji rozstrzyga teraz karta kanału zgód: karta tej sesji silnika w stanie z
   * {@link CONSENT_HOLDING_STATES} (hook czeka na plik). Ta sama reguła co port drivera (`consentCardLive`
   * w `server/src/index.ts`): odpowiedź odebrana (`claimed`, `running`) i `unknown` dialogu już nie trzymają, więc
   * następny dialog to nowa karta. Wyjątek cyklu = brak karty.
   */
  consentCardStands(session: Session): boolean {
    const consent = this.#config.consent;
    const engine = session.engineSessionId;
    if (consent === undefined || engine === undefined || engine === '') return false;
    try {
      return consent.cards(engine)
        .some((card) => (CONSENT_HOLDING_STATES as readonly string[]).includes(card.state));
    } catch {
      return false;
    }
  }

  /**
   * `permission-resolved` (`expired`, domyślnie od `system`) karty kanału zgód, którą urządzenia widzą na tej karcie.
   */
  #emitConsentExpired(session: Session, permId: string, by: 'system' | typeof CONSENT_RESOLVED_BY = 'system'): void {
    this.#port.emitSession(session, {
      type: 'permission-resolved', sessionId: session.id, permId, decision: 'expired', by,
    });
  }

  /**
   * Koniec sesji (koniec procesu, panel zamknięty z telefonu), krok pierwszy: niekońcowe karty kanału zgód rozmowy,
   * które niesie ta karta, dostają zdjęcie w pamięci ({@link #consentRetired}) i od tej chwili nie idą nigdzie: ani na
   * tę kartę, ani na inną kartę rozmowy, także po odpięciu drivera, kiedy rozmowę obsługiwałby już drugi żywy panel.
   * Wynik (dokładnie te karty) idzie do {@link retireConsentCards}; zdjęcia nic nie cofa. Tylko karta, która obsługuje
   * rozmowę, i tylko przed odpięciem drivera.
   */
  holdConsentCards(session: Session): readonly string[] {
    const consent = this.#config.consent;
    const engine = session.engineSessionId;
    if (consent === undefined || engine === undefined || engine === '' || !this.#ownsConsent(session)) return [];
    let cards: readonly ConsentManagerCard[];
    try {
      cards = consent.cards(engine);
    } catch {
      return [];
    }
    const held: string[] = [];
    for (const card of cards) {
      if ((CONSENT_FINAL_STATES as readonly string[]).includes(card.state) || this.#consentCardRetired(engine, card)) {
        continue;
      }
      this.#consentRetired.add(`${engine}\n${card.permId}`);
      held.push(card.permId);
    }
    return held;
  }

  /**
   * Koniec sesji, krok drugi: karty z {@link holdConsentCards} od razu schodzą z urządzeń jak karty z ekranu
   * (`permission-resolved`, `expired` od `system`, na tej karcie, bez ponownego wyboru właściciela) i nie wracają na
   * żadną kartę Raroga, także po wznowieniu rozmowy i po restarcie serwera (zapis przez port `retire`). Hook tych kart
   * nie żyje albo zaraz nie będzie żył, więc późnego dowodu nie będzie; rekord cyklu idzie dalej za dowodem, jaki
   * przyjdzie (audyt). Wynik spełnia się po zapisie pól (zamknięcie z telefonu czeka na niego przed zamknięciem tabu).
   * Nie rzuca: błąd zapisu idzie do logu, a zdjęcie zostaje w pamięci tego procesu.
   */
  retireConsentCards(session: Session, permIds: readonly string[]): Promise<void> {
    const consent = this.#config.consent;
    const engine = session.engineSessionId;
    if (consent === undefined || engine === undefined || engine === '') return Promise.resolve();
    const writes = permIds.map((permId) => this.#saveRetired(engine, permId));
    for (const permId of permIds) {
      if (this.#consentShown.delete(`${session.id}\n${permId}`)) this.#emitConsentExpired(session, permId);
    }
    return Promise.all(writes).then(() => undefined);
  }

  /**
   * Powrót gniazda herdr na panelu sesji (port `reattached`): granica utraty dowodu dla rozmowy karty i rozmowy
   * z migawki agenta, gdy się różnią (`/clear` albo `/resume` w przerwie gniazda). Uuid Codexa nie jest sesją silnika.
   * Bez filtra właściciela rozmowy: granica tylko zabiera przycisk zgody. Nie czeka i nie rzuca.
   */
  consentReattached(session: Session, agent: HerdrAgent): void {
    const consent = this.#config.consent;
    if (consent === undefined) return;
    const engines = new Set<string>();
    if (session.engineSessionId !== undefined && session.engineSessionId !== '') engines.add(session.engineSessionId);
    if (agent.engine !== 'codex' && agent.agentSessionId !== '') engines.add(agent.agentSessionId);
    if (engines.size === 0) return;
    // On failure no boundary stands: the card keeps the proof of the current read.
    void consentStep('reattached', this.#config.logger, () => consent.reattached([...engines]));
  }

  /** Koniec tury bez wpisu w transkrypcie dla kart kanału zgód sesji (port `turnEnded`). Nie czeka i nie rzuca. */
  consentTurnEnded(session: Session): void {
    // The claim window ends with the turn: a held `blocked` is older than the turn end (`claim-window.ts`).
    this.#port.claimWindows.turnEnded(session);
    const consent = this.#config.consent;
    const engine = session.engineSessionId;
    if (consent === undefined || engine === undefined || engine === '' || !this.#ownsConsent(session)) return;
    // On failure the transcript review settles the received answers.
    void consentStep('turn end', this.#config.logger, () => consent.turnEnded(engine));
  }

  /**
   * Koniec procesu sesji (panel zniknął, wyjście procesu), przed odpięciem drivera. Karta, która obsługuje rozmowę
   * ({@link #ownsConsent}): karty kanału zgód schodzą z urządzeń ({@link retireConsentCards}), w cyklu `pending`
   * i `sent` odwołane (`revoke`, `hook-dead`, bez pliku odpowiedzi), odebrane rozliczone końcem tury. Pula sesji
   * i znaczniki prośby (`ended`) schodzą na końcu procesu każdej karty tej rozmowy, także karty, która jej nie
   * obsługuje, gdy nie zostaje inny żywy panel rozmowy. Karta `done` nic nie zmienia: jej proces już się skończył
   * (`gone` panelu po wyjściu procesu). Nie czeka i nie rzuca.
   */
  endConsentSession(session: Session): void {
    const consent = this.#config.consent;
    const engine = session.engineSessionId;
    if (consent === undefined || engine === undefined || engine === '' || session.state === 'done') return;
    if (this.#ownsConsent(session)) {
      void this.retireConsentCards(session, this.holdConsentCards(session));
      // On failure the cards stay in the cycle and end with a signal or the claim deadline.
      void consentStep('revoke', this.#config.logger, () => consent.revoke(engine, 'hook-dead'));
      this.consentTurnEnded(session);
    }
    /*
     * Pula i znaczniki prośby rozmowy (port `ended`) tylko bez innego żywego panelu tej rozmowy: ani innej karty tej
     * rozmowy, która opisuje żywy panel (z driverem albo czekająca na slot podpięcia: wpis w `#herdrByKey`), ani
     * panelu w świeżym `agent.list` nadzorcy (panel ukryty żyje i pisze dalej). Karty sprawdzane przed odczytem
     * i drugi raz po nim: panel, który pojawił się w trakcie, nie musi stać w odpowiedzi i zwykle nie ma jeszcze
     * drivera. Bez bramki właściciela rozmowy: ostatni żywy panel może nie mieć drivera, a karta, którą wskazałby
     * `#consentSessionOf`, bywa wtedy kartą `done`. Karta `done` (panel, z którego rozmowa odeszła) niczego nie
     * blokuje. Bez nadzorcy i przy błędzie odczytu nic nie znika.
     */
    const supervisor = this.#config.herdrSupervisor;
    const otherLive = (): boolean => [...this.#port.sessions.values()].some((other) => other !== session
      && other.engineSessionId === engine && other.state !== 'done'
      && (other.driver !== null
        || (other.herdrKey !== undefined && this.#port.herdrByKey.get(other.herdrKey) === other.id)));
    if (consent.ended === undefined || supervisor === undefined || otherLive()) return;
    void consentStep('pool end', this.#config.logger, async () => {
      const live = await supervisor.liveEngineSessions();
      if (!live.has(engine) && !otherLive()) consent.ended?.(engine);
    });
  }

  /**
   * Zwolnienie kart kanału zgód sesji w `pending` i `sent` (podpisany `release`, plik odpowiedzi odwołany). Nie
   * czeka: wynik przychodzi zmianą karty z cyklu. Błąd cyklu zostawia kartę; hook wychodzi sam przy `escape`.
   */
  releaseConsentCards(session: Session): void {
    // Interrupt or close from the phone ends the claim window, also when the state does not move (`claim-window.ts`).
    this.#port.claimWindows.turnEnded(session);
    const consent = this.#config.consent;
    const engine = session.engineSessionId;
    if (consent === undefined || engine === undefined || engine === '' || !this.#ownsConsent(session)) return;
    for (const request of this.consentRequests(session)) {
      if (request.state !== 'pending' && request.state !== 'sent') continue;
      // On failure the card stays and ends with a channel signal.
      void consentStep('release', this.#config.logger, () => consent.release(engine, request.permId));
    }
  }

  /**
   * Czy na sesji stoi decyzja dla człowieka: karta z ekranu, pytanie albo karta kanału w `pending`. The voice agent's
   * pick-up of a result reads it too (`SeenMarksDeps.decisionStands`).
   */
  decisionStands(session: Session): boolean {
    return this.#port.hasPending(session.id)
      || this.consentRequests(session).some((request) => request.state === 'pending');
  }
}

/** Kto zdjął kartę kanału zgód w `permission-resolved`: hook (skutek albo koniec cyklu), nie urządzenie. */
const CONSENT_RESOLVED_BY = 'hook';

/**
 * Whether a consent channel card leaves the devices before a final state, with `permission-resolved` and `retire`:
 * `running` (the hook took the answer and the card's dialog is gone) or `unknown` that no device answered (the
 * record's `decision` is `null`: the call ended without our answer and its result does not say who decided it).
 * Neither card has anything left to decide on the phone; the record follows the evidence for the audit. An `unknown`
 * card with the phone's answer (`claimed` → `unknown` at the end of the turn, or with the dialog still standing) and
 * one whose decision the port does not give (`undefined`) stay.
 */
function leavesDevices(state: ConsentCardView['state'], decision: ConsentDecision | null | undefined): boolean {
  return state === 'running' || (state === 'unknown' && decision === null);
}

export function consentRefusal(status: ConsentRefusalBody['status'], code: string, sentence: ConsentRefusalBody['sentence'])
  : ResolveResult {
  return { outcome: 'consent', consent: { status, code, sentence } };
}

/**
 * Odmowa cyklu kanału jako odpowiedź REST (kontrakt apki: 409 `too-late` = hook już nie czeka, 410 = karta wygasła,
 * inne 409 i 422 = odmowa ze zdaniem serwera). `too-late` przy zwolnieniu odebranej odpowiedzi (`claimed`, `running`)
 * mówi, że odpowiedzi nie da się bezpiecznie odwołać; przy `unknown` — że hook już nie czeka.
 */
function consentOutcomeResult(release: boolean, outcome: Extract<ConsentOutcome, { ok: false }>): ResolveResult {
  switch (outcome.error) {
    case 'not-found':
    case 'gone':
      return { outcome: 'gone' };
    case 'decided':
      return { outcome: 'conflict' };
    case 'card-changed':
      return consentRefusal(409, 'card-changed', 'dialogs.consent.card-changed');
    case 'no-always': return consentRefusal(422, 'allow-always', 'dialogs.consent.allow-always');
    case 'too-late':
      return release && outcome.state !== 'unknown'
        ? consentRefusal(409, 'release-taken', 'dialogs.consent.release-taken')
        : consentRefusal(409, 'too-late', 'dialogs.consent.too-late');
    case 'not-signable':
      return consentRefusal(422, 'not-signable', 'dialogs.refuse.terminal-only');
    case 'write-failed':
      return consentRefusal(422, 'write-failed', 'dialogs.refuse.send-failed');
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
