/**
 * CLI registry of the session manager: the last readings of the Claude Code version reader, the slow
 * tick that announces `cliUpdate` on cards and the fast tick that passes the registry signal to drivers. The manager
 * owns one {@link CliRegistryState}, gives it a narrow {@link CliRegistryPort} (sessions, `session-changed` emission,
 * disposal, clock) and reads the CLI update, the dialog signal and the process release of a card from it. This module
 * does not import `manager.ts`.
 */
import type { ServerSentence } from '@rarog/shared/sentences';
import { cliProcessStartOf, cliUpdateFor, cliWaitingOf, runningCliVersion } from '../cli-version.ts';
import type { CliRegistry, CliVersionReader, CliVersionSnapshot, CliWaitingSignal } from '../cli-version.ts';
import { cliAcceptsNotes } from './question-card.ts';
import type { Session } from './session.ts';
import {
  CLI_VERSION_POLL_MS, CLI_WAITING_POLL_MS, HERDR_MODE_UNKNOWN_MESSAGE, herdrDialogStandsMessage,
} from './state-sentences.ts';

/** Fields of the manager configuration the CLI registry reads (`ManagerConfig`, described there). */
export interface CliRegistryConfig {
  readonly cliVersionReader?: CliVersionReader;
  readonly cliWaiting?: boolean;
  readonly cliWaitingPollMs?: number;
}

/** What the CLI registry reads from the manager besides configuration: sessions, disposal, clock, emission. */
export interface CliRegistryPort {
  readonly sessions: ReadonlyMap<string, Session>;
  readonly disposed: () => boolean;
  readonly now: () => number;
  readonly emitSessionChanged: (session: Session) => void;
}

/** Readings of the CLI registry and the two ticks that refresh them; one instance per manager. */
export class CliRegistryState {
  readonly #config: CliRegistryConfig;
  readonly #port: CliRegistryPort;

  /** Ostatni odczyt wydań Claude Code; `null` w polach = „nie wiem". */
  #cliVersion: CliVersionSnapshot = { installed: null, registry: null };
  /**
   * `sessionId` → ostatnio OGŁOSZONA para wydań (`running>installed`). Tick emituje
   * `session-changed` tylko kartom, którym wynik się zmienił — 26 kart co 30 s bez zmiany
   * to 26 ramek SSE po nic.
   */
  readonly #cliShown = new Map<string, string>();
  #cliTimer: ReturnType<typeof setInterval> | null = null;
  /** Tick w locie — kolejny nie startuje, zanim poprzedni nie skończy odczytu dysku. */
  #cliTickRunning = false;
  /**
   * Ostatnio PRZYJĘTY odczyt rejestru pod kątem dialogów — `null` = „nie wiem"
   * (wyłączone, brak katalogu, błąd czytnika). Osobno od {@link #cliVersion}: tamto pole
   * zmienia się co 30 s i od niego zależy ramka `cliUpdate`, której szybki tik nie ma
   * prawa ruszać mimochodem.
   */
  #cliRegistry: CliRegistry | null = null;
  /**
   * Czego ostatnio przyjęty odczyt rejestru NIE widział: żywe pidy z plikiem bez wpisu
   * i rozmowy żywych procesów bez pliku. Przy którymkolwiek rejestr nie dowodzi, że rozmowę pisze
   * jeden proces (`cliProcessStartOf`).
   */
  #cliRegistryDoubt: Pick<CliVersionSnapshot, 'unreadablePids' | 'unlistedSessions'> = {};
  /** Numer ostatnio przyjętego odczytu — starszy wynik z kolejki czytnika jest odrzucany. */
  #cliRegistryGen = 0;
  #cliWaitingTimer: ReturnType<typeof setInterval> | null = null;
  /** Szybki tik w locie — tak jak przy {@link #cliTickRunning}, ticki się nie nakładają. */
  #cliWaitingTickRunning = false;

  constructor(config: CliRegistryConfig, port: CliRegistryPort) {
    this.#config = config;
    this.#port = port;
  }

  /** Last reading of the slow tick. */
  get cliVersion(): CliVersionSnapshot {
    return this.#cliVersion;
  }

  /** Last accepted registry reading of the fast tick; `null` = unknown. */
  get cliRegistry(): CliRegistry | null {
    return this.#cliRegistry;
  }

  /**
   * Czy proces tej sesji działa na starszym Claude Code niż zainstalowany.
   *
   * Tylko żywy panel Claude w zasięgu: karta bez drivera nie ma procesu, który można by
   * uruchomić ponownie, Codex nie jest Claude Code, a panel poza korzeniami nie dostaje
   * od Raroga żadnej władzy — pigułka nad nim byłaby obietnicą bez pokrycia.
   */
  cliUpdateOf(session: Session): { running: string; installed: string } | undefined {
    if (session.engine === 'codex' || session.outOfScope === true) return undefined;
    if (session.driver === null || session.herdrKey === undefined) return undefined;
    const running = runningCliVersion(this.#cliVersion.registry, session.engineSessionId);
    return cliUpdateFor(running, this.#cliVersion.installed);
  }

  /**
   * Start odpytywania wydań Claude Code — wyłącznie z wstrzykniętym czytnikiem. Przy
   * `cliWaiting` drugi, szybki tik czyta sam rejestr pod kątem stojących dialogów.
   */
  startCliVersionPoll(): void {
    if (this.#config.cliVersionReader === undefined) return;
    void this.cliTick();
    const timer = setInterval(() => { void this.cliTick(); }, CLI_VERSION_POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.#cliTimer = timer;
    if (this.#config.cliWaiting !== true) return;
    const fast = setInterval(
      () => { void this.#cliWaitingTick(); },
      this.#config.cliWaitingPollMs ?? CLI_WAITING_POLL_MS,
    );
    if (typeof fast.unref === 'function') fast.unref();
    this.#cliWaitingTimer = fast;
  }

  /** Stop of both ticks (manager `dispose()`). */
  stopCliVersionPoll(): void {
    if (this.#cliTimer !== null) clearInterval(this.#cliTimer);
    this.#cliTimer = null;
    if (this.#cliWaitingTimer !== null) clearInterval(this.#cliWaitingTimer);
    this.#cliWaitingTimer = null;
  }

  /**
   * Jeden odczyt wydań i ramki `session-changed` dla kart, którym wynik się zmienił.
   *
   * Błąd czytnika to „nie wiem" dla wszystkich — pigułki gasną, zamiast wisieć na odczycie
   * sprzed awarii. Ten sam odczyt karmi też wykrycie dialogów
   * (`#noteCliRegistry`) — jest świeższy niż ostatni szybki tik, więc nie ma powodu go marnować.
   */
  async cliTick(): Promise<void> {
    const reader = this.#config.cliVersionReader;
    if (reader === undefined || this.#cliTickRunning || this.#port.disposed()) return;
    this.#cliTickRunning = true;
    try {
      this.#cliVersion = await reader().catch(
        (): CliVersionSnapshot => ({ installed: null, registry: null }),
      );
      if (this.#port.disposed()) return;
      this.#noteCliRegistry(this.#cliVersion);
      for (const [id] of this.#cliShown) {
        if (!this.#port.sessions.has(id)) this.#cliShown.delete(id);
      }
      for (const session of this.#port.sessions.values()) {
        const update = this.cliUpdateOf(session);
        const shown = update === undefined ? '' : `${update.running}>${update.installed}`;
        if ((this.#cliShown.get(session.id) ?? '') === shown) continue;
        if (shown === '') this.#cliShown.delete(session.id);
        else this.#cliShown.set(session.id, shown);
        this.#port.emitSessionChanged(session);
      }
    } finally {
      this.#cliTickRunning = false;
    }
  }

  /** Szybki tik: sam rejestr, z pamięcią `stat`, w kolejce czytnika. */
  async #cliWaitingTick(): Promise<void> {
    const reader = this.#config.cliVersionReader;
    if (reader === undefined || this.#cliWaitingTickRunning || this.#port.disposed()) return;
    this.#cliWaitingTickRunning = true;
    try {
      const snapshot = await reader({ registryOnly: true }).catch(
        (): CliVersionSnapshot => ({ installed: null, registry: null }),
      );
      if (this.#port.disposed()) return;
      this.#noteCliRegistry(snapshot);
    } finally {
      this.#cliWaitingTickRunning = false;
    }
  }

  /**
   * Odczyt rejestru → sygnał dla KAŻDEGO drivera, także bez zmiany.
   *
   * Driver dostaje sygnał przy każdym odczycie, a nie tylko przy zmianie, bo z niego liczy
   * ponowienia oceny ekranu, póki `waiting` trwa (z własnym budżetem). Rejestr jest dla niego
   * SZTURCHNIĘCIEM: niczego nie zatwierdza i niczego nie wysyła, a stan sesji dalej zmienia
   * wyłącznie driver swoim `agent-state`. Wynik starszy od przyjętego (`generation`) odpada.
   */
  #noteCliRegistry(snapshot: CliVersionSnapshot): void {
    if (this.#config.cliWaiting !== true || !this.acceptCliRegistry(snapshot)) return;
    for (const session of this.#port.sessions.values()) {
      session.driver?.noteCliWaiting?.(this.cliWaitingOf(session));
      this.#noteCliProcessStart(session);
    }
  }

  /** Przyjęcie odczytu rejestru do pamięci managera; `false` = odczyt starszy niż przyjęty (`generation`). */
  acceptCliRegistry(snapshot: CliVersionSnapshot): boolean {
    const generation = snapshot.generation;
    if (generation !== undefined) {
      if (generation <= this.#cliRegistryGen) return false;
      this.#cliRegistryGen = generation;
    }
    this.#cliRegistry = snapshot.registry;
    this.#cliRegistryDoubt = {
      ...(snapshot.unreadablePids === undefined ? {} : { unreadablePids: snapshot.unreadablePids }),
      ...(snapshot.unlistedSessions === undefined ? {} : { unlistedSessions: snapshot.unlistedSessions }),
    };
    return true;
  }

  /**
   * Start procesu CLI tej rozmowy → driver, z tego samego odczytu rejestru co sygnał dialogu.
   *
   * Subagent żyje w procesie CLI, a CLI po wyjściu i `claude --resume` nie zapisuje o nim nic
   * (fixture `tasks/measured/resume-cli-2.1.296.jsonl`), więc bez tego faktu agent w postoju stałby w Rarogu
   * bez końca. Regułę ma maszyna stanów zadań w tle (`herdr/background/reducer.ts`); manager podaje jej tylko chwilę
   * startu.
   *
   * Woła WYŁĄCZNIE wtedy, gdy rozmowę pisze dokładnie jeden żywy proces o znanym czasie startu.
   * „Nie wiem” (brak rejestru, rozmowy nie ma w rejestrze, dwóch pisarzy, pole nieobecne, żywy
   * proces z nieczytelnym albo znikniętym plikiem rejestru) to brak wywołania, czyli brak reguły;
   * `RAROG_CLI_WAITING=0` odcina całą metodę wyżej. Czas startu
   * z przyszłości nie jest startem procesu (inna jednostka w nowym CLI zamknęłaby każdego
   * agenta), więc też odpada. Te same granice co przy `#cliWaitingOf`: Codex, panel poza
   * zasięgiem i karta bez drivera nie dostają nic.
   *
   * Ta sama chwila idzie przy każdym odczycie, nie tylko przy zmianie: powtórkę gasi follower,
   * a dzięki powtarzaniu fakt dociera sam do nowego drivera i po `/clear` (Rarog wstający przy
   * już zrestartowanym CLI nie potrzebuje osobnej ścieżki).
   */
  #noteCliProcessStart(session: Session): void {
    if (session.engine === 'codex' || session.outOfScope === true || session.herdrKey === undefined) return;
    const sessionId = session.engineSessionId;
    const startedAt = cliProcessStartOf({ registry: this.#cliRegistry, ...this.#cliRegistryDoubt }, sessionId);
    if (sessionId === undefined || startedAt === undefined || startedAt > this.#port.now()) return;
    session.driver?.noteCliProcessStart?.({ sessionId, startedAt });
  }

  /**
   * Sygnał rejestru dla jednej karty — tylko żywy panel Claude w zasięgu, jak przy `cliUpdate`.
   * Codex nie jest Claude Code, a panel poza korzeniami nie dostaje od Raroga ani karty,
   * ani odczytu ekranu — sygnał byłby tam obietnicą bez pokrycia.
   */
  cliWaitingOf(session: Session): CliWaitingSignal {
    if (this.#config.cliWaiting !== true || session.engine === 'codex'
      || session.outOfScope === true || session.driver === null || session.herdrKey === undefined) {
      return { kind: 'unknown' };
    }
    return cliWaitingOf(this.#cliRegistry, session.engineSessionId);
  }

  /**
   * Czy proces Claude Code tej sesji przyjmie notatki w `annotations` — wydanie
   * z rejestru sesji CLI. Świeższy jest odczyt szybkiego tiku, pełna migawka wersji CLI zostaje
   * zapasem; wydanie nieznane (brak wpisu, kilka procesów o różnych wydaniach → najniższe) = nie.
   */
  cliAcceptsNotes(session: Session): boolean {
    const registry = this.#cliRegistry ?? this.#cliVersion.registry;
    return cliAcceptsNotes(runningCliVersion(registry, session.engineSessionId));
  }

  /** 400 bramki „nie znam trybu" — z nazwaną przyczyną, gdy rejestr mówi o dialogu. */
  modeUnknownMessage(session: Session): ServerSentence {
    const signal = this.cliWaitingOf(session);
    return signal.kind === 'waiting'
      ? herdrDialogStandsMessage(signal.dialog)
      : HERDR_MODE_UNKNOWN_MESSAGE;
  }
}
