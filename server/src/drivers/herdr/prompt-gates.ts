/**
 * The gates checked before a key goes to the prompt field of a Claude pane: what holds the pane now (the driver's
 * holds, a hook consent request of the session, a fresh registry read) and the prompt field read from the screen.
 * The paste queue (`prompt-queue.ts`) asks them before every paste, Enter and Esc pair. This module only judges and
 * reads; it sends no key and holds no queue. Holds that may outlive a closed dialog are judged in `stale-block.ts`.
 */
import type { HerdrClient } from '../../herdr/types.ts';
import type { CliWaitingSignal } from '../../cli-version.ts';
import { promptFieldOf } from './prompt-paste.ts';
import { staleBlockVerdict } from './stale-block.ts';

/**
 * Co zatrzymało wiadomość w trakcie tury (linia logu): źródło sygnału dialogu, pole albo `submit` — poprzedni Enter
 * z kolejki czeka na rozstrzygnięcie (`PROMPT_SUBMIT_SETTLE_MS` in `prompt-paste.ts`); `disk` — the write without
 * the text failed.
 */
export type PromptObstacle = 'herdr' | 'registry' | 'hook' | 'screen' | 'field' | 'agent' | 'submit' | 'disk';

/**
 * What holds the pane in the driver's view ({@link PromptGatesPort.driverHold}). `status` = only signals that outlive a
 * closed dialog and that fresh reads may show stale ({@link staleBlockVerdict}): the raw herdr `blocked` status and the
 * registry fallback hold (from the manager's last registry signal). Its `generation` grows each time one of them
 * begins (herdr status into `blocked`, the fallback hold set), so a lift binds to the hold its reads judged. `driver` =
 * a CLI consent dialog herdr does not see or a form fallback, with or without those.
 */
export type DriverHold = { readonly kind: 'driver' } | { readonly kind: 'status'; readonly generation: number };

/** Driver dependencies the gates read; the same fields as in the driver's deps. */
export interface PromptGatesDeps {
  readonly client: Pick<HerdrClient, 'readScreen'>;
  readonly now: () => number;
  readonly consentRegistryRead?: (engineSessionId: string) => Promise<CliWaitingSignal>;
  readonly consentCardAwaited?: (engineSessionId: string) => number | null;
}

/** Fixed configuration of the gates, taken from the driver once, at construction. */
export interface PromptGatesConfig {
  readonly deps: PromptGatesDeps;
  readonly consentCardWaitMs: number;
}

/** What the gates need from the facade: current driver state, read on every call. */
export interface PromptGatesPort {
  disposed(): boolean;
  paneId(): string;
  agentSessionId(): string;
  /** What holds the pane in the driver's view ({@link DriverHold}); `null` = nothing. */
  driverHold(): DriverHold | null;
  /** A channel card holds the dialog of this session; a port exception counts as holding. */
  consentCardStands(): boolean;
  /** The last registry signal from the manager says `waiting`. */
  cliWaiting(): boolean;
}

export class PromptGates {
  readonly #deps: PromptGatesDeps;
  readonly #consentCardWaitMs: number;
  readonly #port: PromptGatesPort;
  /** This attempt saw a fresh registry read without `waiting` under a stale-able hold ({@link #blockedStatusLifted}). */
  registryClear = false;

  constructor(config: PromptGatesConfig, port: PromptGatesPort) {
    this.#deps = config.deps;
    this.#consentCardWaitMs = config.consentCardWaitMs;
    this.#port = port;
  }

  get #disposed(): boolean { return this.#port.disposed(); }
  get #paneId(): string { return this.#port.paneId(); }
  get #agentSessionId(): string { return this.#port.agentSessionId(); }

  /**
   * Co stoi teraz na drodze wiadomości (kroki 1 i 4) albo `null`. Najpierw stan, który driver już zna (bez odczytu),
   * potem prośba hooka, potem świeży rejestr sesji CLI; po jego `await` stan drivera jeszcze raz.
   * A hold of signals that outlive a closed dialog (herdr `blocked`, the registry fallback hold) first gets fresh reads
   * ({@link #blockedStatusLifted}): a message waiting on them missed the gap before the next dialog of the same turn.
   * The lift covers only the hold those reads judged: a hold that began after they started (the next dialog of the
   * turn while a read returned an earlier `active`) has a new generation and holds, at both checks below. Every other
   * check of this step stays.
   */
  async promptObstacle(): Promise<PromptObstacle | null> {
    const lifted = await this.#blockedStatusLifted();
    if (this.#disposed) return null;
    const known = this.knownObstacle(lifted);
    if (known !== null) return known;
    const waiting = await this.#registryWaitingNow();
    if (this.#disposed) return null;
    return this.knownObstacle(lifted) ?? (waiting ? 'registry' : null);
  }

  /**
   * Przeszkoda z tego, co driver wie bez odczytu: blokada, dialog zgody CLI, rezerwy, prośba hooka.
   *
   * @param lifted the generation of the `status` hold ({@link DriverHold}) that fresh reads just showed stale: that hold,
   *   and only while its generation is the same, does not hold; `null` = no lift
   */
  knownObstacle(lifted: number | null = null): PromptObstacle | null {
    const hold = this.#port.driverHold();
    if (hold !== null && (hold.kind === 'driver' || hold.generation !== lifted)) return 'herdr';
    return this.#consentRequestWaits() ? 'hook' : null;
  }

  /**
   * Only stale-able signals hold (`status`, {@link DriverHold}), and a fresh registry read without `waiting` plus a fresh
   * screen read with the prompt field say they outlived the dialog (`stale-block.ts`). A registry read without `waiting`
   * marks the attempt for the short retry (`drainPrompts` in `prompt-queue.ts`). No registry port or no engine
   * session = it holds.
   *
   * @returns the generation of the hold taken BEFORE the reads, so a hold that begins during them is not the one lifted,
   *   or `null` = nothing lifted
   */
  async #blockedStatusLifted(): Promise<number | null> {
    const read = this.#deps.consentRegistryRead;
    const session = this.#agentSessionId;
    const hold = this.#port.driverHold();
    if (hold?.kind !== 'status' || read === undefined || session === '') return null;
    const verdict = await staleBlockVerdict({ registry: () => read(session), field: () => this.readPromptField() });
    if (verdict !== 'held') this.registryClear = true;
    return verdict === 'stale' ? hold.generation : null;
  }

  /**
   * Czy czeka prośba hooka zgody tej sesji (kanał zgód): karta kanału trzyma dialog
   * ({@link HerdrDriverDeps.consentCardLive}) albo rejestracja hooka nie ma jeszcze karty, a od jej przyjęcia minęło
   * mniej niż sufit karty ({@link HerdrDriverDeps.consentCardAwaited}). Wyjątek portu = czeka (bez Entera przy
   * wątpliwości).
   */
  #consentRequestWaits(): boolean {
    if (this.#port.consentCardStands()) return true;
    const awaited = this.#deps.consentCardAwaited;
    if (awaited === undefined || this.#agentSessionId === '') return false;
    try {
      const acceptedAt = awaited(this.#agentSessionId);
      return acceptedAt !== null && this.#deps.now() - acceptedAt < this.#consentCardWaitMs;
    } catch {
      return true;
    }
  }

  /**
   * Świeży rejestr sesji CLI ({@link HerdrDriverDeps.consentRegistryRead}): `waiting` = coś stoi. Bez portu albo przy
   * wyjątku ostatni sygnał od managera ({@link PromptGatesPort.cliWaiting}).
   */
  async #registryWaitingNow(): Promise<boolean> {
    const read = this.#deps.consentRegistryRead;
    if (read !== undefined && this.#agentSessionId !== '') {
      try {
        return (await read(this.#agentSessionId)).kind === 'waiting';
      } catch {
        // Ostatni sygnał od managera niżej.
      }
    }
    return this.#port.cliWaiting();
  }

  /**
   * Pole promptu z ekranu z atrybutami (bez białych znaków, {@link promptFieldOf}): `null` = pola nie widać (dialog,
   * formularz), `undefined` = odczyt się nie udał.
   */
  async readPromptField(): Promise<string | null | undefined> {
    try {
      return promptFieldOf((await this.#deps.client.readScreen(this.#paneId, 'visible', 'ansi')).text);
    } catch {
      return undefined;
    }
  }
}
