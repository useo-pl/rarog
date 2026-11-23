/**
 * Claim window of the consent channel in the session manager: right after the hook claimed a phone answer
 * (card `claimed`), herdr `blocked` of that session does not move it to `waiting-permission` for a short window.
 * The window ends early on another herdr status, a new hook registration of the engine session, a card of another
 * request, a dialog card from the screen or the transcript, the end or interrupt of the turn, or another conversation
 * in the pane; the last two drop a held `blocked`. Only the session state shown to the app: the consent cycle, the
 * cards and their frames do not change. This module does not import `manager.ts`.
 */
import type { OwnText } from '@rarog/shared/sentences';
import type { ConsentCardView } from '../herdr/dialogs/layer1/cards.ts';
import type { Session } from './session.ts';
import type { SmEvent } from './state-machine.ts';
import type { DialogCardKind } from './state-sentences.ts';

/**
 * How long after a claim herdr `blocked` leaves the session state alone. herdr reads the dialog from the pane screen,
 * and the answered dialog stays on it for a moment after the claim: in the owner's server log herdr reported `blocked`
 * again 373 ms after the receipt and `working` 1128 ms after it, which made the app jump twice in about 750 ms.
 * Two seconds cover that lag with a margin, and a dialog that really stands shows up at most this much later.
 */
export const CONSENT_CLAIM_WINDOW_MS = 2_000;

/** What the claim window reads from the manager. */
export interface ClaimWindowPort {
  readonly sessions: ReadonlyMap<string, Session>;
  /** Sessions whose last herdr `agent-state` was `blocked` (manager `#herdrBlocked`). */
  readonly herdrBlocked: ReadonlySet<string>;
  readonly now: () => number;
  readonly logger: (line: string) => void;
  readonly applyTransition: (session: Session, event: SmEvent, detail?: OwnText) => boolean;
}

interface OpenWindow {
  /** Key of the claimed card. */
  readonly permId: string;
  /** Conversation of the claimed card: a `blocked` of another conversation in the pane is not held or replayed. */
  readonly engineSessionId: string | undefined;
  readonly openedAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  /** A herdr `blocked` came inside the window and left the state alone; `detail` of the last one. */
  held: { readonly detail: OwnText | undefined } | null;
}

/** Claim windows of every session card, keyed by the Rarog session id; one instance per manager. */
export class ClaimWindows {
  readonly #port: ClaimWindowPort;
  readonly #windows = new Map<string, OpenWindow>();

  constructor(port: ClaimWindowPort) {
    this.#port = port;
  }

  /**
   * A consent card change for the session card that handles the conversation. `claimed` opens the window (the same
   * card again keeps the running one, another claimed card starts a new one). A `pending` card of another request
   * ends the window: its own transition shows the new decision.
   */
  consentCard(session: Session, view: Pick<ConsentCardView, 'permId' | 'state'>): void {
    const open = this.#windows.get(session.id);
    if (view.state === 'claimed') {
      if (open?.permId === view.permId) return;
      this.#close(session.id);
      const timer = setTimeout(() => { this.#expire(session.id); }, CONSENT_CLAIM_WINDOW_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.#windows.set(session.id, {
        permId: view.permId, engineSessionId: session.engineSessionId, openedAt: this.#port.now(), timer, held: null,
      });
      return;
    }
    if (open !== undefined && view.permId !== open.permId && view.state === 'pending') this.#close(session.id);
  }

  /**
   * herdr `blocked` of the session: `true` = the window is open and the caller leaves the state alone. The first held
   * `blocked` of a window gets one log line. A window of another conversation ends: the dialog is a new one.
   */
  holdBlocked(session: Session, detail: OwnText | undefined): boolean {
    const open = this.#windows.get(session.id);
    if (open === undefined) return false;
    if (open.engineSessionId !== session.engineSessionId) {
      this.#close(session.id);
      return false;
    }
    if (open.held === null) {
      const after = this.#port.now() - open.openedAt;
      this.#port.logger(`consent: claim window of session ${session.id} holds herdr blocked (${String(after)} ms`
        + ' after the claim)');
    }
    open.held = { detail };
    return true;
  }

  /** herdr reported a status other than `blocked`: the window ends and the caller's transition goes as usual. */
  herdrMoved(session: Session): void {
    this.#close(session.id);
  }

  /**
   * A dialog card from the screen or the transcript (driver consent card, question form, dialog outside the
   * transcript): the window ends and the card's own transition sets the state. A channel card (`hook`) is judged by
   * {@link consentCard}.
   */
  dialogCard(session: Session, kind: DialogCardKind): void {
    if (kind !== 'hook') this.#close(session.id);
  }

  /**
   * A new hook registration of the engine session, main thread or subagent: a new request comes, so the window of
   * every card of this conversation ends, and a held `blocked` moves the state now.
   */
  registration(engineSessionId: string): void {
    for (const [id, open] of [...this.#windows]) {
      if (this.#port.sessions.get(id)?.engineSessionId !== engineSessionId) continue;
      this.#close(id);
      this.#applyHeld(id, open, 'registration');
    }
  }

  /**
   * The turn ended (the state entered a turn end state) or the phone interrupted or closed it: the window ends and
   * a held `blocked` is dropped, because it is older than that transition and would undo it at the end of the window.
   */
  turnEnded(session: Session): void {
    this.#close(session.id);
  }

  /** The pane writes another conversation (`/clear`, `/resume`): the window ends, a held `blocked` is dropped. */
  conversationChanged(session: Session): void {
    this.#close(session.id);
  }

  /** The session card left the manager (hidden or gone pane). */
  forget(sessionId: string): void {
    this.#close(sessionId);
  }

  /** Manager end: no window fires after it. */
  dispose(): void {
    for (const id of [...this.#windows.keys()]) this.#close(id);
  }

  #expire(sessionId: string): void {
    const open = this.#windows.get(sessionId);
    if (open === undefined) return;
    this.#windows.delete(sessionId);
    this.#applyHeld(sessionId, open, 'window over');
  }

  /**
   * A `blocked` held in the window, while herdr still reports it in the same conversation, moves the state as it would
   * have without the window.
   */
  #applyHeld(sessionId: string, open: OpenWindow, reason: string): void {
    const session = this.#port.sessions.get(sessionId);
    if (open.held === null || session === undefined || !this.#port.herdrBlocked.has(sessionId)) return;
    if (session.engineSessionId !== open.engineSessionId) return;
    const before = session.state;
    if (this.#port.applyTransition(session, { type: 'agent-blocked' }, open.held.detail)) {
      this.#port.logger(`consent: claim window of session ${sessionId} ended (${reason}): ${before} → ${session.state}`
        + ' (herdr: blocked)');
    }
  }

  #close(sessionId: string): void {
    const open = this.#windows.get(sessionId);
    if (open === undefined) return;
    clearTimeout(open.timer);
    this.#windows.delete(sessionId);
  }
}
