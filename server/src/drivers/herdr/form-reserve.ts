/**
 * The form fallback, a module of the herdr driver: an `AskUserQuestion` form that herdr does not report as
 * a block.
 *
 * The module holds the fallback key, the entry budget and the miss count, and decides entry, hold and exit from a
 * fresh screen read. The effective block (`#blockedNow`), the answer shield and the card stay in the facade
 * `drivers/herdr-driver.ts`; the CLI registry fallback is `drivers/herdr/cli-reserve.ts`.
 */
import type { Scheduler } from '../runtime.ts';
import type { HerdrAgentStatus } from '../../herdr/types.ts';
import type { PendingTool } from '../../herdr/jsonl-pending.ts';
import {
  ASK_USER_QUESTION_TOOL, FORM_FALLBACK_MISSES, FORM_FALLBACK_RETRY_DELAYS_MS, askFormOnScreen, hookPendingFrom,
} from '../../herdr/dialogs/index.ts';
import type { PendingHookTool, ScreenConsentDialogId } from '../../herdr/dialogs/index.ts';

/** Driver dependencies the form fallback reads; the same fields as in the driver's deps. */
export interface FormReserveDeps {
  readonly readPendingHook?: (engineSessionId: string) => PendingHookTool | null;
  readonly formFallbackRetryDelaysMs?: readonly number[];
}

export interface FormReserveConfig {
  readonly deps: FormReserveDeps;
  readonly scheduler: Scheduler;
}

/** Driver state the form fallback reads and the steps that stay in the facade. */
export interface FormReservePort {
  disposed(): boolean;
  /** The raw herdr status, not the effective block. */
  status(): HerdrAgentStatus;
  stateChangeSeq(): number;
  agentSessionId(): string;
  /** The CLI consent dialog standing without a herdr block, or `null`. */
  consentDialog(): ScreenConsentDialogId | null;
  /** The first unpaired `tool_use` from the conversation file, or `null`. */
  pending(): PendingTool | null;
  /** The driver's screen read (`force` skips the screen cache). */
  readDialog(force: boolean): Promise<string | null>;
  /** When the last screen read succeeded. */
  screenAt(): number;
  /** The window right after Rarog's own answer, in which misses do not end the fallback. */
  answerShieldUp(): boolean;
  /** A new block in Rarog's eyes: the block number and its time. */
  newBlock(): void;
  emitState(status: HerdrAgentStatus): void;
  syncBlockedPoll(): void;
  /** The card is no longer current: the manager clears it. */
  clearActive(reason: string): void;
  /** The driver's serialized evaluation of the pane. */
  evaluate(): Promise<void>;
}

export class FormReserve {
  readonly #deps: FormReserveDeps;
  readonly #scheduler: Scheduler;
  readonly #port: FormReservePort;

  /**
   * Formularz `AskUserQuestion` stojący BEZ blokady herdr — klucz formularza albo `null`.
   *
   * CLI 2.1.281 w sesji po `/rename` rysuje pod stopką formularza linię z nazwą sesji, a reguła
   * herdr `live_blocked_form` bierze ją za ostatnią kreskę poziomą i melduje `idle`/`done`
   * (zmierzone). Od reguł wykrywania herdr 2026.10.11.1 (#5192) herdr
   * melduje tu `blocked` regułą `live_blocked_form_named_session`, więc rezerwa zwykle nie wchodzi;
   * zostaje na wypadek cofnięcia reguł, które herdr pobiera z sieci.
   * Dopóki pole jest ustawione, panel liczy się jako zablokowany
   * (`#blockedNow`), stan jedzie jako `blocked`, a ocena buduje kartę zwykłą drogą. `#status`
   * zostaje SUROWYM stanem herdr — z niego `#onStatus` liczy przejścia.
   */
  formFallback: string | null = null;
  /**
   * Budżet prób WEJŚCIA w rezerwę na parę (klucz formularza, `state_change_seq`)
   *
   * Resync co 30 s powtarza zdarzenie statusu bez zmiany numeru, a osierocony `tool_use` (sesja
   * po awarii CLI) albo stęchły zrzut hooka dawałby wtedy odczyt ekranu w nieskończoność.
   */
  formProbe: { key: string; seq: number; tries: number } | null = null;
  /** Kolejne potwierdzone odczyty „formularza nie ma" w trakcie rezerwy. */
  formMisses = 0;
  /** Znacznik odczytu policzonego jako pudło — ten sam odczyt z cache'u nie liczy się dwa razy. */
  #formMissAt = 0;

  constructor(config: FormReserveConfig, port: FormReservePort) {
    this.#deps = config.deps;
    this.#scheduler = config.scheduler;
    this.#port = port;
  }

  /**
   * Klucz formularza, na który czeka panel: `tool_use.id` z jsonl, a gdy wpisu nie ma —
   * id zrzutu hooka.
   *
   * Zrzut jest drugim źródłem, bo wpis w jsonl potrafi mrugnąć `null` w oknie repoint followera
   * albo przyjść później niż render. Sam zrzut NIE dowodzi, że formularz stoi: żyje do sufitu hooka
   * zgód i przeżywa odpowiedź z biurka (zmierzone) — rozstrzyga ekran. Wpis INNEGO
   * narzędzia wygrywa ze zrzutem: pierwszy niesparowany `tool_use` to nie formularz, więc karta
   * z ekranu pytania miałaby rozjazd z jsonl (znane ograniczenie).
   */
  #formKey(): string | null {
    const pending = this.#port.pending();
    if (pending !== null) return pending.toolName === ASK_USER_QUESTION_TOOL ? pending.id : null;
    const hook = hookPendingFrom(this.#deps.readPendingHook?.(this.#port.agentSessionId()) ?? null);
    return hook?.toolName === ASK_USER_QUESTION_TOOL ? hook.id : null;
  }

  /**
   * Migawka przesłanek rezerwy — odczyt ekranu jest `await`-em, a w jego trakcie `#onStatus`,
   * follower albo `/clear` potrafią zmienić to, na czym opieramy wniosek.
   */
  #formSnapshot(key: string): string {
    return [
      this.#port.agentSessionId(), key, this.#port.pending()?.id ?? '', this.#port.status(),
      String(this.#port.stateChangeSeq()), this.#port.consentDialog() ?? '', this.formFallback ?? '',
    ].join('|');
  }

  /**
   * Czy ocena ma traktować panel `idle`/`done` jak zablokowany?
   *
   * @returns `blocked` — formularz stoi, oceniaj jak blokadę; `none` — nie ma na co czekać
   *   (karta może zgasnąć); `wait` — nic nie ruszaj: ekran nieczytelny, pierwsze pudło albo
   *   przesłanki zmieniły się w trakcie odczytu (ich zmiana sama zamówiła nową ocenę)
   */
  async formFallbackVerdict(): Promise<'blocked' | 'wait' | 'none'> {
    if (this.#port.consentDialog() !== null) {
      // Ekran i kartę przejął dialog zgody CLI: rezerwa schodzi PO CICHU — jej
      // `#clearActive` skasowałby świeżą kartę zgody, której nic już nie odbuduje.
      this.#dropFormFallback();
      return 'none';
    }
    const status = this.#port.status();
    const idle = status === 'idle' || status === 'done';
    const key = idle ? this.#formKey() : null;
    if (key === null) {
      this.leaveFormFallback('formularz pytania już nie czeka');
      return 'none';
    }
    return this.formFallback === null
      ? this.#enterFormFallback(key)
      : this.#holdFormFallback(key);
  }

  /**
   * Próba WEJŚCIA w rezerwę: świeży odczyt ekranu i formularz na nim.
   *
   * Budżet prób liczy się na parę (klucz, `state_change_seq`): pierwsza próba plus ponowienia
   * z `FORM_FALLBACK_RETRY_DELAYS_MS` na wypadek renderu w toku. Powtórka zdarzenia statusu
   * z resyncu niesie ten sam numer, więc budżetu nie odnawia.
   */
  async #enterFormFallback(key: string): Promise<'blocked' | 'wait' | 'none'> {
    const seq = this.#port.stateChangeSeq();
    const probe = this.formProbe;
    const fresh = probe === null || probe.key !== key || probe.seq !== seq;
    const tries = fresh ? 0 : probe.tries;
    const delays = this.#deps.formFallbackRetryDelaysMs ?? FORM_FALLBACK_RETRY_DELAYS_MS;
    if (tries > delays.length) return 'none';
    this.formProbe = { key, seq, tries: tries + 1 };
    if (fresh) {
      for (const delay of delays) {
        this.#scheduler.setTimeout(() => {
          if (this.#port.disposed() || this.formFallback !== null) return;
          const current = this.formProbe;
          if (current?.key !== key || current.seq !== seq) return;
          void this.#port.evaluate();
        }, delay);
      }
    }
    const before = this.#formSnapshot(key);
    const text = await this.#port.readDialog(true);
    if (this.#port.disposed() || this.#formSnapshot(key) !== before || this.#formKey() !== key) {
      return 'wait';
    }
    if (askFormOnScreen(text) !== 'form') return 'none';
    this.formFallback = key;
    this.formMisses = 0;
    this.#formMissAt = 0;
    // Nowa blokada w oczach Raroga — numer daje świeżą generację osłonom i weryfikacji `enter`.
    this.#port.newBlock();
    this.#port.emitState(this.#port.status());
    this.#port.syncBlockedPoll();
    return 'blocked';
  }

  /**
   * Rezerwa trwa, dopóki ekran pokazuje formularz.
   *
   * Jeden odczyt bez formularza to za mało (resize i przemalowanie parsują się jak ekran
   * bez dialogu), a fałszywie zgaszona rezerwa nie wraca — formularz dalej stoi, więc nie
   * przyjdzie żadne zdarzenie, które by ją wskrzesiło. Gasi dopiero `FORM_FALLBACK_MISSES`
   * KOLEJNYCH różnych odczytów, i nie w oknie osłony po własnej odpowiedzi plikiem: tam
   * formularz znika, bo odpowiedź doszła — koniec ogłosi `working` albo `tool_result`.
   */
  async #holdFormFallback(key: string): Promise<'blocked' | 'wait' | 'none'> {
    // Inny klucz = kolejny formularz tej tury; karta zmieni się zwykłą drogą (nowy `reqId`).
    this.formFallback = key;
    const before = this.#formSnapshot(key);
    const text = await this.#port.readDialog(false);
    if (this.#port.disposed() || this.#formSnapshot(key) !== before || this.#formKey() !== key) {
      return 'wait';
    }
    const seen = askFormOnScreen(text);
    if (seen === 'form') {
      this.formMisses = 0;
      return 'blocked';
    }
    if (seen === 'unknown') return 'wait';
    // Ten sam odczyt z cache'u (dwie oceny w oknie `HERDR_SCREEN_CACHE_MS`) to jedno pudło.
    const screenAt = this.#port.screenAt();
    if (screenAt !== this.#formMissAt) {
      this.#formMissAt = screenAt;
      this.formMisses += 1;
    }
    if (this.formMisses < FORM_FALLBACK_MISSES || this.#port.answerShieldUp()) return 'wait';
    this.leaveFormFallback('formularz pytania zniknął z ekranu');
    return 'none';
  }

  /** Stan rezerwy do zera BEZ ruszania karty — gdy kartę i ekran przejął ktoś inny. */
  #dropFormFallback(): void {
    if (this.formFallback === null) return;
    this.formFallback = null;
    this.formMisses = 0;
    this.#port.syncBlockedPoll();
  }

  /** Koniec rezerwy z GASZENIEM karty — dla przejęcia przez herdr jest ciche `#onStatus`. */
  leaveFormFallback(reason: string): void {
    if (this.formFallback === null) return;
    this.#dropFormFallback();
    this.#port.clearActive(reason);
    this.#port.emitState(this.#port.status());
  }

  /**
   * Bramka mutacji: czy w panelu stoi formularz, w który wpadłby tekst albo klawisz?
   *
   * Manager zamyka composer stanem `waiting-permission`, ale wysyłka przyjęta chwilę wcześniej
   * czeka w kolejce drivera (zapis załącznika, pauzy) — a rezerwa mogła wejść w tym czasie albo
   * jeszcze nie zdążyć. Ekran czytamy WYŁĄCZNIE, gdy czeka `AskUserQuestion`: zwykła wysyłka
   * nie kosztuje ani jednego odczytu więcej.
   */
  async formStandsNow(): Promise<boolean> {
    if (this.formFallback !== null) return true;
    const status = this.#port.status();
    if (status !== 'idle' && status !== 'done') return false;
    if (this.#formKey() === null) return false;
    const text = await this.#port.readDialog(true);
    if (this.#port.disposed()) return false;
    return askFormOnScreen(text) === 'form';
  }
}
