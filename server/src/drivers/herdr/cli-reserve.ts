/**
 * The CLI registry fallback, a module of the herdr driver: a dialog the CLI session registry reports as
 * `waiting` while herdr does not see a block.
 *
 * The module holds the last registry signal, the episode budget and the hold, judges an unblocked pane (the registry
 * first, then the form fallback of `drivers/herdr/form-reserve.ts`) and gates mutations. The registry signal intake
 * (`noteCliWaiting`), the effective block (`#blockedNow`) and the card stay in the facade `drivers/herdr-driver.ts`.
 */
import type { HerdrAgentStatus } from '../../herdr/types.ts';
import { CLI_HOLD_MISSES, CLI_WAITING_PROBES, cliDialogOnScreen } from '../../herdr/dialogs/index.ts';
import type { ScreenConsentDialogId } from '../../herdr/dialogs/index.ts';
import type { CliDialogClass, CliWaitingSignal } from '../../cli-version.ts';
import type { FormReserve } from './form-reserve.ts';

export interface CliReserveConfig {
  /** The pane is inside `RAROG_HERDR_ROOTS`; outside it the registry is not read. */
  readonly inScope: boolean;
  /** The form fallback: the registry yields to it and closes it when the registry says the form closed. */
  readonly form: Pick<FormReserve, 'formFallback' | 'formFallbackVerdict' | 'leaveFormFallback'>;
}

/** Driver state the CLI registry fallback reads and the steps that stay in the facade. */
export interface CliReservePort {
  disposed(): boolean;
  /** The raw herdr status, not the effective block. */
  status(): HerdrAgentStatus;
  stateChangeSeq(): number;
  agentSessionId(): string;
  /** The CLI consent dialog standing without a herdr block, or `null`. */
  consentDialog(): ScreenConsentDialogId | null;
  /** The driver's screen read (`force` skips the screen cache). */
  readDialog(force: boolean): Promise<string | null>;
  /** When the last screen read succeeded. */
  screenAt(): number;
  /** The window right after Rarog's own answer, in which misses do not end a fallback. */
  answerShieldUp(): boolean;
  /** When Rarog last answered: a digit or a hook file, whichever is later. */
  answeredAt(): number;
  /** The effective block: herdr `blocked`, the form fallback or this hold. */
  blockedNow(): boolean;
  /** A new block in Rarog's eyes: the block number and its time. */
  newBlock(): void;
  emitState(status: HerdrAgentStatus): void;
  syncBlockedPoll(): void;
  /** The card is no longer current: the manager clears it. */
  clearActive(reason: string): void;
}

export class CliReserve {
  readonly #inScope: boolean;
  readonly #form: CliReserveConfig['form'];
  readonly #port: CliReservePort;

  /*
   * Rejestr sesji CLI. Plik `~/.claude/sessions/<pid>.json` dostaje `status: waiting`
   * w chwili pokazania dialogu i wraca do `busy`/`idle` w chwili odpowiedzi — także dla dialogów,
   * nad którymi herdr 0.9.3 melduje `working` (formularz z podglądem, „Exit plan mode?”).
   * Rejestr jest SZTURCHNIĘCIEM, nie źródłem stanu: budzi ocenę ekranu, a blokadę stawia
   * dopiero ekran z dialogiem (albo nieczytelny ekran przy `waiting` — karta bez decyzji).
   */
  /** Klasa stojącego dialogu z rejestru; `null` = rejestr NIE mówi `waiting` (albo „nie wiem"). */
  cliWaiting: CliDialogClass | null = null;
  /** Ostatni sygnał rejestru z managera i chwila jego nadejścia (ms epoki) — wejście dowodu trybu cienia. */
  cliSignal: CliWaitingSignal | null = null;
  cliSignalAt = 0;
  /**
   * Sesja silnika, przy której przyszedł {@link cliSignal}: obserwacja kanału zgód innej sesji (po `session-changed`)
   * nie bierze go za swój rejestr (`#managerRegistryOf` in `consent-channel.ts`).
   */
  cliSignalSession = '';
  /**
   * Numer sygnału rejestru przyjętego przez driver ({@link noteCliWaiting}); rośnie z każdym. Obserwacja kanału zgód
   * z `waiting: permission` porównuje go po odczycie ekranu: nowszy sygnał bez `waiting: permission` w tym czasie
   * odrzuca ją jako spóźnioną (`ConsentChannel.consentObserveStep`).
   */
  cliSignalGen = 0;
  /**
   * Rezerwa z rejestru: panel liczy się jako zablokowany przy KAŻDYM statusie herdr, dopóki
   * rejestr mówi `waiting`, a ekran nie pokazał pola promptu {@link CLI_HOLD_MISSES} razy pod
   * rząd. Niezmiennik: `#cliHold` ⇒ `#cliWaiting !== null`.
   */
  get cliHold(): boolean { return this.#cliHold; }
  set cliHold(value: boolean) {
    if (value && !this.#cliHold) this.cliHoldStarts += 1;
    this.#cliHold = value;
  }

  /**
   * How many times {@link cliHold} began (false → true), from any setter: part of the hold generation the paste queue
   * binds a lift to (`DriverHold` in `prompt-gates.ts`), so a hold that begins during the lift's reads is not lifted.
   */
  cliHoldStarts = 0;
  #cliHold = false;
  /** Numer epizodu `waiting` — wejście w `waiting` albo zmiana klasy; od niego liczy się budżet. */
  cliEpisode = 0;
  /** Zużyte próby wejścia w rezerwę w danym epizodzie ({@link CLI_WAITING_PROBES}). */
  cliProbe: { episode: number; tries: number } | null = null;
  /** Kolejne odczyty z polem promptu w trakcie rezerwy — jak `#formMisses` przy rezerwie formularza. */
  cliMisses = 0;
  #cliMissAt = 0;
  /**
   * Kiedy rejestr ostatnio POTWIERDZIŁ, że proces nie czeka (`active`). Odpowiedź starsza od tej
   * chwili jest rozliczona — jej osłona nie ma prawa zasłaniać następnego dialogu.
   */
  cliActiveAt = -1;

  constructor(config: CliReserveConfig, port: CliReservePort) {
    this.#inScope = config.inScope;
    this.#form = config.form;
    this.#port = port;
  }

  /**
   * Ocena panelu, który herdr widzi jako NIEzablokowany: najpierw rejestr CLI, potem rezerwa formularza.
   *
   * Dialog zgody CLI ma pierwszeństwo przed obiema rezerwami — przejmuje ekran i kartę,
   * a rezerwy schodzą po cichu (ich `#clearActive` skasowałby świeżą kartę zgody).
   */
  async unblockedVerdict(): Promise<'blocked' | 'wait' | 'none'> {
    if (this.#port.consentDialog() !== null) this.dropCliHold();
    else {
      const verdict = await this.cliVerdict();
      if (verdict !== 'off') return verdict;
    }
    return this.#form.formFallbackVerdict();
  }

  /**
   * Werdykt rezerwy z rejestru: `off` = rejestr nic tu nie wnosi, decyduje reszta (rezerwa
   * formularza, zwykłe „nie czeka"). Rezerwy formularza, która właśnie trzyma formularz, rejestr nie przejmuje
   * w ocenie — przejmuje ją dopiero spóźniony `working` w `#onStatus`.
   */
  async cliVerdict(): Promise<'blocked' | 'wait' | 'none' | 'off'> {
    if (this.cliWaiting === null || !this.#inScope) return 'off';
    if (this.cliHold) return this.#holdCliVerdict();
    if (this.#form.formFallback !== null) return 'off';
    return this.#enterCliVerdict();
  }

  /**
   * Osłona po własnej odpowiedzi DLA REJESTRU: ta sama co `#answerShieldUp`, ale kończy ją też
   * potwierdzone `active` po odpowiedzi. Rejestr, który po naszej
   * cyfrze albo pliku raz powiedział „nie czekam", nie może już stać na `waiting` ZA TAMTEN
   * dialog — następne `waiting` to nowy dialog i ma dostać ocenę od razu, nie po 8 s.
   */
  cliShieldUp(): boolean {
    if (!this.#port.answerShieldUp()) return false;
    const answeredAt = this.#port.answeredAt();
    // Ta sama chwila co odpowiedź to jeszcze nie dowód: odczyt mógł wystartować przed nią.
    return this.cliActiveAt <= answeredAt;
  }

  /** Czy epizod `waiting` ma jeszcze budżet prób wejścia ({@link CLI_WAITING_PROBES}). */
  cliProbeLeft(): boolean {
    const probe = this.cliProbe;
    return probe?.episode !== this.cliEpisode || probe.tries < CLI_WAITING_PROBES;
  }

  /**
   * Migawka przesłanek rezerwy z rejestru — jak `#formSnapshot`: odczyt ekranu jest `await`-em,
   * a w jego trakcie status, rejestr albo `/clear` potrafią zmienić to, na czym stoi wniosek.
   */
  #cliSnapshot(): string {
    return [
      this.#port.agentSessionId(), this.#port.status(), String(this.#port.stateChangeSeq()),
      this.#port.consentDialog() ?? '', this.cliWaiting ?? '', String(this.cliEpisode), String(this.cliHold),
      this.#form.formFallback ?? '',
    ].join('|');
  }

  /**
   * Próba WEJŚCIA w rezerwę: świeży odczyt ekranu i dialog na nim (albo ekran nieczytelny).
   *
   * Ekran z polem promptu to dowód, że dialogu NIE MA (rejestr spóźniony albo dialog trwał
   * ułamek sekundy) — wtedy `off` i następna próba z następnym tikiem, w budżecie epizodu.
   * Ekran nieczytelny przy `waiting` (`/login`, render w toku) daje rezerwę i kartę bez decyzji:
   * rejestr mówi, że coś stoi, a Rarog nie wie co — dokładnie przypadek „odpowiedz w terminalu".
   * Osłona po własnej odpowiedzi zamyka wejście w ogóle i nie zjada budżetu.
   */
  async #enterCliVerdict(): Promise<'blocked' | 'wait' | 'off'> {
    if (this.cliShieldUp() || !this.cliProbeLeft()) return 'off';
    const episode = this.cliEpisode;
    const tries = this.cliProbe?.episode === episode ? this.cliProbe.tries : 0;
    this.cliProbe = { episode, tries: tries + 1 };
    const before = this.#cliSnapshot();
    const text = await this.#port.readDialog(true);
    if (this.#port.disposed() || this.#cliSnapshot() !== before) return 'wait';
    if (text === null || cliDialogOnScreen(text) === 'none') return 'off';
    this.cliHold = true;
    this.cliMisses = 0;
    this.#cliMissAt = 0;
    // Nowa blokada w oczach Raroga — numer daje świeżą generację osłonom i weryfikacji `enter`.
    this.#port.newBlock();
    this.#port.emitState(this.#port.status());
    this.#port.syncBlockedPoll();
    return 'blocked';
  }

  /**
   * Rezerwa trwa, dopóki rejestr mówi `waiting` i ekran nie pokaże pola promptu
   * {@link CLI_HOLD_MISSES} razy pod rząd — ta sama reguła i ta sama osłona po własnej
   * odpowiedzi co przy rezerwie formularza (`#holdFormFallback`). Ekran nieczytelny podtrzymuje rezerwę.
   */
  async #holdCliVerdict(): Promise<'blocked' | 'wait' | 'none'> {
    const before = this.#cliSnapshot();
    const text = await this.#port.readDialog(false);
    if (this.#port.disposed() || this.#cliSnapshot() !== before) return 'wait';
    if (text === null) return 'wait';
    if (cliDialogOnScreen(text) !== 'none') {
      this.cliMisses = 0;
      return 'blocked';
    }
    // Ten sam odczyt z cache'u (dwie oceny w oknie `HERDR_SCREEN_CACHE_MS`) to jedno pudło.
    const screenAt = this.#port.screenAt();
    if (screenAt !== this.#cliMissAt) {
      this.#cliMissAt = screenAt;
      this.cliMisses += 1;
    }
    if (this.cliMisses < CLI_HOLD_MISSES || this.#port.answerShieldUp()) return 'wait';
    this.leaveCliHold('dialog CLI zniknął z ekranu');
    // Rejestr stoi na `waiting`, a ekran pokazuje pole promptu: do następnego epizodu żadnych
    // prób — inaczej każdy tik czytałby ekran nad rejestrem, który się zaciął.
    this.cliProbe = { episode: this.cliEpisode, tries: CLI_WAITING_PROBES };
    return 'none';
  }

  /**
   * Bramka mutacji: czy w panelu stoi dialog zgłoszony przez rejestr CLI?
   *
   * Rezerwa = tak. Bez rezerwy, ale przy `waiting` — świeży odczyt: wysyłka przyjęta chwilę
   * wcześniej czeka w kolejce, a rezerwa mogła jeszcze nie zdążyć wejść. Pole promptu na ekranie
   * przepuszcza wysyłkę (rejestr bywa spóźniony o tik); błąd odczytu też — jak przy dialogu zgody CLI, stała
   * odmowa przy chwilowej awarii zostawiłaby telefon bez wysyłki na dobre. Zwykła wysyłka bez
   * `waiting` nie kosztuje ani jednego odczytu więcej.
   */
  async cliDialogStandsNow(): Promise<boolean> {
    if (this.cliHold) return true;
    if (this.cliWaiting === null || !this.#inScope) return false;
    const text = await this.#port.readDialog(true);
    if (this.#port.disposed()) return false;
    // Ocena panelu nie chodzi kolejką wysyłek: w trakcie NASZEGO odczytu mogła zobaczyć dialog
    // i wejść w rezerwę — wtedy ekran sprzed chwili (z polem promptu) jest już nieprawdą.
    if (this.cliHold) return true;
    if (text === null) return false;
    return cliDialogOnScreen(text) !== 'none';
  }

  /**
   * Rejestr przestał mówić `waiting`. Rezerwa z rejestru schodzi zawsze; rezerwa formularza — tylko
   * przy `busy`/`idle` (`closed`), bo wtedy rejestr MÓWI, że formularz zamknięto: odpowiedź
   * przy biurku albo nasza. „Nie wiem" rezerwy formularza nie rusza — ona ma własne dowody z ekranu.
   */
  onCliWaitingEnd(closed: boolean): void {
    this.leaveCliHold('rejestr CLI: dialog zamknięty');
    if (closed) this.#form.leaveFormFallback('rejestr CLI: formularz zamknięty');
  }

  /** Rezerwa z rejestru do zera BEZ ruszania karty — gdy blokadę przejmuje herdr albo dialog zgody CLI. */
  dropCliHold(): void {
    if (!this.cliHold) return;
    this.cliHold = false;
    this.cliMisses = 0;
    this.#port.syncBlockedPoll();
  }

  /**
   * Koniec rezerwy z rejestru z gaszeniem karty — chyba że ten sam dialog trzyma dalej herdr
   * (`blocked`) albo rezerwa formularza: wtedy karta mówi prawdę i zostaje.
   */
  leaveCliHold(reason: string): void {
    if (!this.cliHold) return;
    this.dropCliHold();
    if (this.#port.blockedNow()) return;
    this.#port.clearActive(reason);
    this.#port.emitState(this.#port.status());
  }
}
