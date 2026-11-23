/**
 * The consent channel (layer 1) as the herdr driver sees it, a module of the driver: the channel observation
 * in the registry read rhythm (with its own screen read and, for a waiting subagent request in `all`, its own
 * registry read and tick), and whether a consent card from the screen waits for a channel card or yields to one.
 * The digit gate of channel mode is `herdr/dialogs/consent-gate.ts`; the card itself, the manager signal and the
 * screen read stay in the facade `drivers/herdr-driver.ts`.
 */
import type { Scheduler, TimerHandle } from '../runtime.ts';
import type { JsonlFollower } from '../../herdr/jsonl-follow.ts';
import { consentModeNow, registryEvidenceFromSignal } from '../../herdr/dialogs/index.ts';
import type { ConsentGateSource } from '../../herdr/dialogs/index.ts';
import { consentChannelOpen, consentSubagentsOpen } from '../../herdr/dialogs/hook/contract.ts';
import type { CliReserve } from './cli-reserve.ts';
import { cliWaitsForPermission, readConsentRegistry } from './consent-registry-read.ts';
import type { ConsentRegistryPort } from './consent-registry-read.ts';

/**
 * Najdłuższy odstęp obserwacji kanału zgód przy trybie `all`, gdy w sesji czeka prośba subagenta (5.6):
 * dowód ukryty żyje `CONSENT_PROOF_TTL_MS` (2 s, `layer1/contract.ts`) od odczytu faktów, a rytm odczytu rejestru
 * managera (1,5 s) by go rwał.
 */
export const CONSENT_SUBAGENT_OBSERVE_MS = 1_000;

/** Wejście obserwacji kanału zgód jednej sesji: te same sygnały co dowód trybu cienia. */
export interface ConsentObserveRequest {
  readonly engineSessionId: string;
  /**
   * Sygnał rejestru sesji CLI z chwilą: z ostatniego odczytu managera (chwila nadejścia do drivera) albo, przy
   * czekającej prośbie subagenta i trybie `all`, z odczytu tej obserwacji (chwila sprzed zapytania).
   */
  readonly registry: ReturnType<typeof registryEvidenceFromSignal>;
  /**
   * Otwarte i ostatnie zamknięte `tool_use` wątku głównego z followera (zamknięte ze skrótem wejścia i chwilą wpisu,
   * który je zamknął) i najpóźniejsza chwila zamknięcia, którego ta pamięć nie ma (`lostAt`); `null` = transkrypt
   * nieznany.
   */
  readonly transcript: {
    readonly open: readonly { readonly toolName: string; readonly input: unknown }[];
    readonly closed: readonly {
      readonly toolName: string; readonly inputSha256: string | null; readonly closedAt: number | null;
    }[];
    readonly lostAt: number | null;
  } | null;
  /**
   * Ekran panelu przeczytany dla tej obserwacji (przy świeżym `waiting: permission`) z chwilą rozpoczęcia odczytu,
   * sprzed zapytania (`deps.now`, zegar sygnału rejestru); `null` = bez odczytu albo odczyt nieudany.
   */
  readonly screen: { readonly text: string; readonly readStartedAt: number } | null;
}

/** Driver dependencies the consent channel reads; the same fields as in the driver's deps. */
export interface ConsentChannelDeps extends ConsentGateSource, ConsentRegistryPort {
  readonly consentObserve?: (request: ConsentObserveRequest) => Promise<void>;
  readonly consentSubagentPending?: (engineSessionId: string) => boolean;
  readonly consentCardLive?: (engineSessionId: string) => boolean;
  readonly consentCardAwaited?: (engineSessionId: string) => number | null;
}

export interface ConsentChannelConfig {
  readonly deps: ConsentChannelDeps;
  readonly scheduler: Scheduler;
  readonly inScope: boolean;
  /** The registry signal of the manager and its generation (`noteCliWaiting` writes them). */
  readonly cliReserve: Pick<CliReserve, 'cliSignal' | 'cliSignalAt' | 'cliSignalSession' | 'cliSignalGen'>;
  readonly follower: Pick<JsonlFollower, 'openToolUses' | 'closedToolUses'> | null;
  /** The ceiling of a consent card's wait for a channel card (`HerdrDriverDeps.consentCardWaitMs`). */
  readonly consentCardWaitMs: number;
}

/** Driver state the consent channel reads and the steps that stay in the facade. */
export interface ConsentChannelPort {
  disposed(): boolean;
  agentSessionId(): string;
  /** The driver's screen read (`force` skips the screen cache). */
  readDialog(force: boolean): Promise<string | null>;
  /** The driver's serialized evaluation of the pane. */
  evaluate(): Promise<void>;
}

export class ConsentChannel {
  readonly #deps: ConsentChannelDeps;
  readonly #scheduler: Scheduler;
  readonly #inScope: boolean;
  readonly #cliReserve: ConsentChannelConfig['cliReserve'];
  readonly #follower: ConsentChannelConfig['follower'];
  /** Sufit czekania karty zgody na kartę kanału ({@link HerdrDriverDeps.consentCardAwaited}). */
  readonly #consentCardWaitMs: number;
  readonly #port: ConsentChannelPort;
  /** Obserwacja kanału zgód w toku (rytm odczytu rejestru nie nakłada dwóch przebiegów). */
  consentObserving = false;
  /** Następna obserwacja kanału przy czekającej prośbie subagenta i trybie `all` ({@link #armConsentSubagentWatch}). */
  #consentSubagentTimer: TimerHandle | null = null;
  /**
   * Szturchnięcie kanału ({@link noteConsentNudge}) przyszło w trakcie obserwacji: po jej końcu idzie jeszcze jedna,
   * bo trwająca mogła przeczytać zrzuty przed zrzutem tej prośby.
   */
  consentObserveAgain = false;
  /** Ponowna ocena na koniec czekania karty zgody na kartę kanału ({@link #consentCardWait}). */
  #consentWaitTimer: TimerHandle | null = null;

  constructor(config: ConsentChannelConfig, port: ConsentChannelPort) {
    this.#deps = config.deps;
    this.#scheduler = config.scheduler;
    this.#inScope = config.inScope;
    this.#cliReserve = config.cliReserve;
    this.#follower = config.follower;
    this.#consentCardWaitMs = config.consentCardWaitMs;
    this.#port = port;
  }

  /**
   * Obserwacja kanału zgód przy otwartym kanale, efektywnym `main` albo `all` (`consentChannelOpen`,
   * {@link HerdrDriverDeps.consentObserve}). Sygnał rejestru jest
   * już zapisany, więc dowód liczy się z tego samego odczytu. Przy świeżym `waiting: permission` krok czyta ekran sam
   * (`readScreen` przez {@link #readDialog} z `force`, nie pamięć ekranu: stojący dialog z kartą ma w pamięci ekran
   * z chwili budowy karty, bo bramka „ta sama karta” w ocenie kończy ją przed odczytem) i podaje go z chwilą sprzed
   * zapytania; odczyt odświeża też pamięć ekranu. Driver odpięty w trakcie odczytu, inna sesja silnika albo kanał
   * zamknięty (tryb inny niż `main` i `all`, także nieznany) = bez obserwacji. Sygnał rejestru managera bez `waiting:
   * permission` przyjęty w trakcie odczytu ekranu ({@link CliReserve.cliSignalGen}) = obserwacja spóźniona: odpada, a następna
   * rusza od razu po niej z nowszym sygnałem. Jedna obserwacja naraz. Nie czeka i nie rzuca.
   *
   * Przy trybie `all` i czekającej prośbie subagenta ({@link HerdrDriverDeps.consentSubagentPending}, 5.6)
   * obserwacja czyta rejestr od nowa ({@link #consentRegistryNow}) i od niego zależy odczyt ekranu, a po jej końcu
   * następna rusza najpóźniej {@link CONSENT_SUBAGENT_OBSERVE_MS} od jej początku, także bez odczytu rejestru
   * managera ({@link #armConsentSubagentWatch}).
   */
  consentObserveStep(): void {
    const observe = this.#deps.consentObserve;
    if (observe === undefined || this.consentObserving || this.#port.agentSessionId() === '') return;
    const mode = consentModeNow(this.#deps);
    if (!consentChannelOpen(mode)) return;
    this.clearConsentSubagentTimer();
    this.consentObserving = true;
    const engineSessionId = this.#port.agentSessionId();
    const startedAt = this.#scheduler.now();
    const fresh = consentSubagentsOpen(mode) && this.#consentSubagentPendingNow(engineSessionId);
    const signalGen = this.#cliReserve.cliSignalGen;
    const work = (async (): Promise<void> => {
      let registry = this.#managerRegistryOf(engineSessionId);
      if (fresh) {
        registry = await this.#consentRegistryNow(engineSessionId);
        if (this.#port.disposed() || this.#port.agentSessionId() !== engineSessionId || !consentChannelOpen(consentModeNow(this.#deps))) {
          return;
        }
      }
      let screen: ConsentObserveRequest['screen'] = null;
      if (registry.kind === 'waiting' && registry.dialog === 'permission') {
        const readStartedAt = this.#deps.now();
        const text = await this.#port.readDialog(true);
        if (this.#port.disposed() || this.#port.agentSessionId() !== engineSessionId || !consentChannelOpen(consentModeNow(this.#deps))) {
          return;
        }
        if (!fresh && this.#cliReserve.cliSignalGen !== signalGen && !cliWaitsForPermission(this.#cliReserve.cliSignal)) {
          // W trakcie odczytu ekranu rejestr przestał mówić `waiting: permission`: obserwacja z tamtym `waiting` jest
          // spóźniona (dałaby dowód z kanału z odczytu, który nowszy już podważył). Następna idzie od razu z nowszym.
          this.consentObserveAgain = true;
          return;
        }
        screen = text === null ? null : { text, readStartedAt };
      }
      const open = this.#follower?.openToolUses?.() ?? null;
      const closures = this.#follower?.closedToolUses?.() ?? null;
      await observe({
        engineSessionId,
        registry,
        /*
         * Bez pamięci zamknięć (atrapa followera) nic nie wiadomo o zamknięciach do teraz: `lostAt` = teraz, więc
         * brak prośby w transkrypcie zabiera dowód jak w trybie cienia, a nie przywraca przycisku.
         */
        transcript: open === null ? null : {
          open, closed: closures?.closed ?? [], lostAt: closures === null ? Date.now() : closures.lostAt,
        },
        screen,
      });
    })();
    void work.catch(() => undefined).finally(() => {
      this.consentObserving = false;
      if (this.consentObserveAgain) {
        // Szturchnięcie w trakcie: następna obserwacja od razu; jej koniec sam planuje takt prośby subagenta.
        this.consentObserveAgain = false;
        if (!this.#port.disposed()) this.consentObserveStep();
        return;
      }
      this.#armConsentSubagentWatch(startedAt);
    });
  }

  /**
   * Następna obserwacja kanału przy trybie `all` i czekającej prośbie subagenta: najpóźniej
   * {@link CONSENT_SUBAGENT_OBSERVE_MS} od początku obserwacji, która się skończyła (każda nowa obserwacja kasuje
   * zaplanowaną, `session-changed` też). Inny tryb, brak czekającej prośby, driver odpięty albo poza zasięgiem = bez
   * planu. Takt należy do sesji, dla której go zaplanowano: przy odpaleniu rusza obserwację tylko przy tej samej sesji,
   * nadal `all` i nadal czekającej prośbie subagenta, więc nie wyzwala obserwacji ze starym sygnałem rejestru.
   */
  #armConsentSubagentWatch(startedAt: number): void {
    if (this.#port.disposed() || this.#consentSubagentTimer !== null || this.#port.agentSessionId() === '') return;
    const armedFor = this.#port.agentSessionId();
    if (!consentSubagentsOpen(consentModeNow(this.#deps))) return;
    if (!this.#consentSubagentPendingNow(armedFor)) return;
    const delay = Math.max(0, startedAt + CONSENT_SUBAGENT_OBSERVE_MS - this.#scheduler.now());
    this.#consentSubagentTimer = this.#scheduler.setTimeout(() => {
      this.#consentSubagentTimer = null;
      if (this.#port.disposed() || !this.#inScope || this.#port.agentSessionId() !== armedFor) return;
      if (!consentSubagentsOpen(consentModeNow(this.#deps)) || !this.#consentSubagentPendingNow(armedFor)) return;
      this.consentObserveStep();
    }, delay);
  }

  clearConsentSubagentTimer(): void {
    if (this.#consentSubagentTimer === null) return;
    this.#scheduler.clearTimeout(this.#consentSubagentTimer);
    this.#consentSubagentTimer = null;
  }

  /** Czy w sesji czeka prośba subagenta ({@link HerdrDriverDeps.consentSubagentPending}); wyjątek = nie. */
  #consentSubagentPendingNow(engineSessionId: string): boolean {
    const pending = this.#deps.consentSubagentPending;
    if (pending === undefined) return false;
    try {
      return pending(engineSessionId);
    } catch {
      return false;
    }
  }

  /**
   * Rejestr sesji z odczytu tej obserwacji ({@link readConsentRegistry}: odczyt bez `waiting: permission` zdejmuje
   * dowód z kanału, zanim obserwacja pójdzie dalej); bez portu albo przy wyjątku ostatni sygnał managera dla tej sesji.
   */
  async #consentRegistryNow(engineSessionId: string): Promise<ConsentObserveRequest['registry']> {
    return await readConsentRegistry(this.#deps, engineSessionId) ?? this.#managerRegistryOf(engineSessionId);
  }

  /**
   * Ostatni sygnał rejestru od managera z chwilą jego nadejścia jako rejestr obserwacji kanału sesji `engineSessionId`;
   * sygnał, który przyszedł przy innej sesji silnika (przed `session-changed`), = rejestr nieznany.
   */
  #managerRegistryOf(engineSessionId: string): ConsentObserveRequest['registry'] {
    const signal = this.#cliReserve.cliSignalSession === engineSessionId ? this.#cliReserve.cliSignal : null;
    return registryEvidenceFromSignal(signal, this.#cliReserve.cliSignalAt);
  }

  /**
   * Czy karta zgody bez przycisku zgody czeka jeszcze na kartę kanału ({@link HerdrDriverDeps.consentCardAwaited}):
   * żywa rejestracja sesji bez karty kanału, przyjęta mniej niż sufit temu. Przy `true` zegar zamawia ponowną ocenę na
   * koniec sufitu, więc dialog bez karty kanału dostaje kartę z ekranu najpóźniej wtedy; karta kanału, która przyjdzie
   * wcześniej, zatrzymuje ją na stałe ({@link #consentCardStands}). Wyjątek portu = karta nie czeka.
   */
  consentCardWait(): boolean {
    const awaited = this.#deps.consentCardAwaited;
    if (awaited === undefined || this.#port.agentSessionId() === '') return false;
    let acceptedAt: number | null;
    try {
      acceptedAt = awaited(this.#port.agentSessionId());
    } catch {
      return false;
    }
    if (acceptedAt === null) return false;
    const left = Math.min(acceptedAt + this.#consentCardWaitMs - this.#deps.now(), this.#consentCardWaitMs);
    if (left <= 0) return false;
    if (this.#consentWaitTimer !== null) this.#scheduler.clearTimeout(this.#consentWaitTimer);
    this.#consentWaitTimer = this.#scheduler.setTimeout(() => {
      this.#consentWaitTimer = null;
      if (!this.#port.disposed()) void this.#port.evaluate();
    }, left);
    return true;
  }

  /**
   * Czy dialog sesji trzyma karta kanału zgód ({@link HerdrDriverDeps.consentCardLive}). `onError` = wynik przy
   * wyjątku portu: karta z ekranu i `escape` liczą go jak brak karty (karta bez przycisku zgody, odmowa niczego nie
   * zatwierdza), cyfra zgody jak kartę, która dialog trzyma (przy wątpliwości bez zgody).
   */
  consentCardStands(onError = false): boolean {
    const live = this.#deps.consentCardLive;
    if (live === undefined || this.#port.agentSessionId() === '') return false;
    try {
      return live(this.#port.agentSessionId());
    } catch {
      return onError;
    }
  }

  /** Both timers of the channel off: the driver is detached. */
  dispose(): void {
    this.clearConsentSubagentTimer();
    if (this.#consentWaitTimer !== null) {
      this.#scheduler.clearTimeout(this.#consentWaitTimer);
      this.#consentWaitTimer = null;
    }
  }
}
