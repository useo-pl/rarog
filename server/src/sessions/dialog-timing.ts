/**
 * Card timing of dialogs in the session manager: the `dialog timing: session <id> …` lines of the server log, one
 * episode per session card (entering herdr `blocked` and the first card of the same dialog with its kind). The
 * manager owns one {@link DialogTimings}, gives it the clock and the logger, and calls it from the driver events and
 * the consent cards. No dialog content and no session state. This module does not import `manager.ts`.
 */
import type { Session } from './session.ts';
import { DIALOG_TIMING_LEAD_MS } from './state-sentences.ts';
import type { DialogCardKind, DialogTiming } from './state-sentences.ts';

/** What the card timing reads from the manager: clock and logger. */
export interface DialogTimingsPort {
  readonly now: () => number;
  readonly logger: (line: string) => void;
}

/** Card timing episodes of every session card; one instance per manager. */
export class DialogTimings {
  readonly #port: DialogTimingsPort;
  /** Pomiar drogi karty dialogu ({@link timingBlocked}, {@link timingCard}): jeden epizod na kartę sesji. */
  readonly #dialogTiming = new Map<string, DialogTiming>();

  constructor(port: DialogTimingsPort) {
    this.#port = port;
  }

  /**
   * Pomiar drogi karty dialogu, linia `dialog timing: session <id> …` w logu serwera: wejście karty sesji
   * w blokadę herdr i pierwsza karta tego samego dialogu z rodzajem ({@link DialogCardKind}). Z pary pierwsza linia
   * mówi `blocked` albo `first card <rodzaj>, not blocked yet`, druga `first card <rodzaj> <±ms> ms from blocked`
   * (minus = karta przed blokadą). Karta sprzed blokady paruje się z nią najwyżej {@link DIALOG_TIMING_LEAD_MS};
   * następne karty tej samej blokady i blokada bez karty nie dają linii. Bez treści dialogu: identyfikator sesji
   * Raroga, rodzaj karty i liczby.
   */
  timingBlocked(session: Session): void {
    const now = this.#port.now();
    const open = this.#dialogTiming.get(session.id);
    if (open !== undefined && open.blockedAt === null && open.card !== null && now - open.at <= DIALOG_TIMING_LEAD_MS) {
      open.blockedAt = now;
      this.#timingLog(session, `first card ${open.card} -${String(now - open.at)} ms from blocked`);
      return;
    }
    this.#dialogTiming.set(session.id, { at: now, blockedAt: now, card: null });
    this.#timingLog(session, 'blocked');
  }

  /** Karta dialogu pokazana urządzeniom — do pomiaru drogi karty ({@link timingBlocked}). */
  timingCard(session: Session, kind: DialogCardKind): void {
    const now = this.#port.now();
    const open = this.#dialogTiming.get(session.id);
    if (open !== undefined && open.blockedAt !== null) {
      if (open.card !== null) return;
      open.card = kind;
      this.#timingLog(session, `first card ${kind} +${String(now - open.blockedAt)} ms from blocked`);
      return;
    }
    if (open !== undefined && open.card !== null && now - open.at <= DIALOG_TIMING_LEAD_MS) return;
    this.#dialogTiming.set(session.id, { at: now, blockedAt: null, card: kind });
    this.#timingLog(session, `first card ${kind}, not blocked yet`);
  }

  /** Koniec blokady: epizod pomiaru zamknięty; karta sprzed blokady czeka na nią dalej. */
  timingLeft(session: Session): void {
    if (this.#dialogTiming.get(session.id)?.blockedAt !== null) this.#dialogTiming.delete(session.id);
  }

  /** The session card left the manager (hidden or gone pane): its episode goes with it. */
  forget(sessionId: string): void {
    this.#dialogTiming.delete(sessionId);
  }

  #timingLog(session: Session, text: string): void {
    this.#port.logger(`dialog timing: session ${session.id} ${text}`);
  }
}
