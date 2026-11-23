/**
 * The server's Inbox: the card of every open session (`card.ts`), read again from the session's conversation file
 * after the session manager's events, and the removals people made (`removals.ts`), with their effect on the receipt
 * of the result. It learns about sessions only from the events it is given and asks the manager through
 * {@link InboxPort}. It sends nothing to devices and has no routes.
 */
import type { ServerEvent, SessionState, SessionSummary } from '@rarog/shared';
import type { ManagerApi } from '../sessions/manager-api.ts';
import { WORKING_STATES } from '../sessions/state-sentences.ts';
import { cardKindOf, composeCard, removalKeyOf, showsResult, shownTurnFor } from './card.ts';
import type { InboxCard, RequestOf, ShownTurn } from './card.ts';
import { PendingDialogs } from './dialogs.ts';
import { RemovalStore } from './removals.ts';
import type { RemovalEntry } from './removals.ts';
import type { SegmentReader } from './segments.ts';

/** What the Inbox asks the session manager. */
export type InboxPort = Pick<ManagerApi, 'get' | 'list' | 'companionTarget' | 'markSeen' | 'markUnseen'>;

/** Quiet time after the last event of a session before its card is read again. */
export const INBOX_DEBOUNCE_MS = 500;

/** A card read that takes longer than this logs one line with the session and its duration. */
export const INBOX_SLOW_READ_MS = 250;

export interface InboxConfig {
  /** Directory of `inbox.json`. */
  readonly dataDir: string;
  readonly readSegments: SegmentReader;
  readonly log: (line: string) => void;
  /** Default {@link INBOX_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** Duration in ms of every card read of a session, also one that changed nothing; not measured without it. */
  readonly timing?: (sessionId: string, ms: number) => void;
}

/** The card a device acts on: the turn and the version it saw. */
export interface InboxCardRef {
  readonly turnId: string;
  readonly version: string;
}

/**
 * `done`: the card is removed (or restored); `changed: false` = it already was, nothing happened again.
 * `receipt: 'skipped'`: the card is removed (restored) in `inbox.json`, but the receipt it would give (`remove`:
 * `markSeen`) or take back (`restore`: `markUnseen`) did not happen, because no read confirmed the card's turn or the
 * session moved before the write landed.
 * `stale`: the session has no card, another turn or version than the request's, or it moved while the card was read
 * again; nothing happened.
 * `write-failed`: `inbox.json` could not be written; nothing happened and the card stays as it was.
 */
export type InboxActionResult =
  | { readonly kind: 'done'; readonly changed: boolean; readonly receipt?: 'skipped' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'write-failed' };

const STALE: InboxActionResult = { kind: 'stale' };
const CHANGED: InboxActionResult = { kind: 'done', changed: true };
const RECEIPT_SKIPPED: InboxActionResult = { kind: 'done', changed: true, receipt: 'skipped' };
const CLOSED_STATES: readonly SessionState[] = ['done', 'resumable'];

/** What the tracker keeps of a session's conversation file between reads. */
interface Turns {
  /** The engine conversation both turns come from. */
  readonly conversation: string;
  /** The turn the last read that proved anything showed outside `starting` and `running`. */
  readonly shown?: ShownTurn | undefined;
  /** The turn such a read showed in `waiting-input`: the last turn known to have ended with a result. */
  readonly ended?: ShownTurn | undefined;
}

/** What says that a session is still where a removal or a restore found it: its state and the transitions so far. */
interface Mark {
  readonly state: SessionState;
  readonly stateSince: string;
  readonly transitions: number;
}

function sameMark(a: Mark, b: Mark): boolean {
  return a.state === b.state && a.stateSince === b.stateSince && a.transitions === b.transitions;
}

/** The card a removal or a restore acts on, read again for it. */
interface Found {
  readonly card: InboxCard;
  /** The session summary after the read. */
  readonly session: SessionSummary;
  /** Where the session stood when the read started. */
  readonly mark: Mark;
  /** The session left `mark` during the read. */
  readonly moved: boolean;
  /** The read showed the card's turn from the conversation file (see {@link Inbox.remove}). */
  readonly confirmed: boolean;
}

/** What a session summary says that its card depends on, besides the conversation file. */
function lookOf(session: SessionSummary): string {
  return JSON.stringify([
    session.state, session.stateSince, session.herdrDialog ?? null, session.herdrDialogReason ?? null,
    session.waitingFor ?? null,
    session.engine ?? null, session.outOfScope ?? false,
  ]);
}

export class Inbox {
  readonly #port: InboxPort;
  readonly #readSegments: SegmentReader;
  readonly #log: (line: string) => void;
  readonly #debounceMs: number;
  readonly #timing: ((sessionId: string, ms: number) => void) | undefined;
  readonly #store: RemovalStore;
  readonly #cards = new Map<string, InboxCard>();
  readonly #turns = new Map<string, Turns>();
  readonly #dialogs = new PendingDialogs();
  /** Bumped at every change of a session's engine conversation: a read started before the change publishes nothing. */
  readonly #generations = new Map<string, number>();
  /** {@link lookOf} of the last summary of each known session. */
  readonly #looks = new Map<string, string>();
  /** Last known state of each known session: a message in `starting`/`running` reads nothing. */
  readonly #states = new Map<string, SessionState>();
  /** `state` events of each session so far: a transition within the same millisecond keeps `stateSince`. */
  readonly #transitions = new Map<string, number>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The read of each session in progress; it settles with whether it confirmed the card's turn (`#readCard`). */
  readonly #running = new Map<string, Promise<boolean>>();
  /** The read of each session asked for while its previous read ran; it starts once that one ends. */
  readonly #queued = new Map<string, Promise<boolean>>();
  #disposed = false;

  constructor(config: InboxConfig, port: InboxPort) {
    this.#port = port;
    this.#readSegments = config.readSegments;
    this.#log = config.log;
    this.#debounceMs = config.debounceMs ?? INBOX_DEBOUNCE_MS;
    this.#timing = config.timing;
    this.#store = new RemovalStore({
      dataDir: config.dataDir,
      isOpen: (sessionId) => {
        const state = this.#states.get(sessionId);
        return state !== undefined && !CLOSED_STATES.includes(state);
      },
      log: config.log,
    });
  }

  /**
   * One event of the session manager (`ManagerApi.onEvent`). A state change, a changed summary (state, dialog,
   * scope), a dialog event and a message outside `starting`/`running` schedule a read of the session's card; a full
   * session list forgets the sessions it lacks.
   */
  noteEvent(scope: string, event: ServerEvent): void {
    if (this.#disposed) return;
    if (scope === 'global') {
      if (event.type === 'state') {
        this.#states.set(event.sessionId, event.state);
        this.#transitions.set(event.sessionId, (this.#transitions.get(event.sessionId) ?? 0) + 1);
        this.#schedule(event.sessionId);
      } else if (event.type === 'session-changed') {
        this.#observe(event.session);
      } else if (event.type === 'sessions-snapshot') {
        this.#snapshot(event.sessions);
      }
      return;
    }
    switch (event.type) {
      case 'message':
        if (!WORKING_STATES.includes(this.#states.get(scope) ?? 'waiting-input')) this.#schedule(scope);
        return;
      case 'permission-pending':
      case 'permission-resolved':
      case 'permission-settled':
      case 'question-pending':
      case 'question-resolved':
        this.#dialogs.note(scope, event);
        this.#schedule(scope);
        return;
      default:
        return;
    }
  }

  /**
   * The session writes another engine conversation (`/clear`, `/resume`); its state may stay the same. The card and
   * the shown turn of the previous conversation go at once, so a read of the new one that proves nothing keeps none.
   */
  noteConversation(sessionId: string): void {
    if (this.#disposed) return;
    this.#generations.set(sessionId, (this.#generations.get(sessionId) ?? 0) + 1);
    this.#forget(sessionId);
    this.#schedule(sessionId);
  }

  /** Reads the card of every session the manager lists, once after the start. */
  refreshAll(): void {
    if (this.#disposed) return;
    for (const session of this.#port.list()) {
      this.#observe(session);
      this.#schedule(session.id);
    }
  }

  /** The card of a session, also a removed one; `null` = none. */
  card(sessionId: string): InboxCard | null {
    return this.#cards.get(sessionId) ?? null;
  }

  /** The session's card is removed. */
  removed(sessionId: string): boolean {
    const card = this.#cards.get(sessionId);
    return card !== undefined && this.#store.has(removalKeyOf(card));
  }

  /** Cards that are not removed, the newest first. */
  visibleCards(): InboxCard[] {
    return [...this.#cards.values()]
      .filter((card) => !this.#store.has(removalKeyOf(card)))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  /**
   * Removes the session's card. A `result` card of a `waiting-input` session also receives the result
   * (`ManagerApi.markSeen`, with the herdr focus on the Mac); a `decision` or `failed` card is only hidden.
   * The same request again does nothing more, also after late text of the turn changed the version.
   *
   * The card is read again first (`#current`), so a request for a turn that has just been followed by another is
   * stale, and so is a request whose session moved (state, `stateSince`, `state` events) while that read ran: the
   * read may hold the file from before the move. The receipt needs a read that confirmed the card's turn: it showed
   * that turn from the conversation file outside `starting` and `running`. After a read that proves nothing (the
   * file cannot be read, or the window holds no result) the card is only hidden, with `receipt: 'skipped'`. The
   * receipt waits for the write and goes only to a session still where the read found it; otherwise the stored
   * removal drops its receipt, the result says `receipt: 'skipped'`, and a restore takes back nothing.
   */
  async remove(sessionId: string, ref: InboxCardRef): Promise<InboxActionResult> {
    const found = await this.#current(sessionId, ref);
    if (found === null) return STALE;
    const { card, session, mark } = found;
    const key = removalKeyOf(card);
    if (this.#store.has(key)) return { kind: 'done', changed: false };
    if (card.version !== ref.version || found.moved) return STALE;
    const due = card.kind === 'result' && session.state === 'waiting-input';
    const receipt = due && found.confirmed;
    const entry: RemovalEntry = {
      sessionId, ...key, ...(receipt && session.seen !== true ? { seen: true as const } : {}),
    };
    const stored = await this.#store.add(entry);
    if (stored === 'failed') return { kind: 'write-failed' };
    if (stored === 'present') return { kind: 'done', changed: false };
    if (!due) return CHANGED;
    if (receipt && this.#stillAt(sessionId, mark, card)) {
      this.#safely(sessionId, 'receipt', () => { this.#port.markSeen(sessionId); });
      return CHANGED;
    }
    if (entry.seen === true) await this.#store.replace({ sessionId, ...key });
    return RECEIPT_SKIPPED;
  }

  /**
   * Brings a removed card back. When its removal received a result that had not been received before, the receipt
   * is taken back (`ManagerApi.markUnseen`), under the rules of {@link remove}: a read that confirmed the card's turn
   * and a session that stayed where that read found it until the write landed; else the card comes back with
   * `receipt: 'skipped'`. A read in `starting` or `running` confirms nothing, so a restore during the next turn takes
   * back nothing. The same request again does nothing more.
   */
  async restore(sessionId: string, ref: InboxCardRef): Promise<InboxActionResult> {
    const found = await this.#current(sessionId, ref);
    if (found === null) return STALE;
    const { card, mark } = found;
    const key = removalKeyOf(card);
    if (!this.#store.has(key)) return { kind: 'done', changed: false };
    if (card.version !== ref.version || found.moved) return STALE;
    const removed = await this.#store.delete(key);
    if (removed === 'failed') return { kind: 'write-failed' };
    if (removed === 'absent') return { kind: 'done', changed: false };
    if (removed.entry.seen !== true) return CHANGED;
    if (found.confirmed && this.#stillAt(sessionId, mark, card)) {
      this.#safely(sessionId, 'unread mark', () => { this.#port.markUnseen(sessionId); });
      return CHANGED;
    }
    return RECEIPT_SKIPPED;
  }

  /** Settles once every write of `inbox.json` asked for so far has landed or failed. */
  flush(): Promise<void> {
    return this.#store.flush();
  }

  /**
   * The session's card read again now, after the writes asked for so far, when it shows the request's turn; `null`
   * otherwise. A read scheduled for later runs now, and one in progress is followed by a new one. The session's mark
   * is taken right before that read, which starts no earlier.
   */
  async #current(sessionId: string, ref: InboxCardRef): Promise<Found | null> {
    await this.#store.flush();
    clearTimeout(this.#timers.get(sessionId));
    this.#timers.delete(sessionId);
    const before = this.#port.get(sessionId);
    const mark = before === undefined ? null : this.#markOf(before);
    const confirmed = await this.#run(sessionId);
    const card = this.#cards.get(sessionId);
    const session = this.#port.get(sessionId);
    if (mark === null || card === undefined || card.turnId !== ref.turnId || session === undefined) return null;
    return { card, session, mark, moved: !sameMark(mark, this.#markOf(session)), confirmed };
  }

  #markOf(session: SessionSummary): Mark {
    return { state: session.state, stateSince: session.stateSince, transitions: this.#transitions.get(session.id) ?? 0 };
  }

  /** The session is where `mark` found it and its card still shows the turn of `card`. */
  #stillAt(sessionId: string, mark: Mark, card: InboxCard): boolean {
    const session = this.#port.get(sessionId);
    return session !== undefined && sameMark(mark, this.#markOf(session))
      && this.#cards.get(sessionId)?.turnId === card.turnId;
  }

  /** Stops reading: pending reads are dropped and events are ignored. */
  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #observe(session: SessionSummary): void {
    this.#states.set(session.id, session.state);
    const look = lookOf(session);
    if (this.#looks.get(session.id) === look) return;
    this.#looks.set(session.id, look);
    this.#schedule(session.id);
  }

  #snapshot(sessions: readonly SessionSummary[]): void {
    const listed = new Set(sessions.map((session) => session.id));
    for (const session of sessions) this.#observe(session);
    for (const id of [...this.#states.keys()]) {
      if (listed.has(id)) continue;
      // The session is gone: no card; its removals stay among those of closed sessions.
      clearTimeout(this.#timers.get(id));
      this.#timers.delete(id);
      this.#cards.delete(id);
      this.#turns.delete(id);
      this.#dialogs.forget(id);
      this.#generations.delete(id);
      this.#transitions.delete(id);
      this.#looks.delete(id);
      this.#states.delete(id);
    }
  }

  #schedule(sessionId: string): void {
    clearTimeout(this.#timers.get(sessionId));
    const timer = setTimeout(() => {
      this.#timers.delete(sessionId);
      void this.#run(sessionId);
    }, this.#debounceMs);
    timer.unref();
    this.#timers.set(sessionId, timer);
  }

  /**
   * One read per session at a time; reads asked for meanwhile run once, right after it. Settles when the read that
   * starts no earlier than this call has ended, with whether that read confirmed the card's turn.
   */
  #run(sessionId: string): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    const queued = this.#queued.get(sessionId);
    if (queued !== undefined) return queued;
    const running = this.#running.get(sessionId);
    if (running === undefined) return this.#start(sessionId);
    const next = running.then(() => {
      this.#queued.delete(sessionId);
      return this.#start(sessionId);
    });
    this.#queued.set(sessionId, next);
    return next;
  }

  #start(sessionId: string): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    const read = this.#read(sessionId)
      .catch((err: unknown) => {
        this.#log(`inbox: card read failed for session ${sessionId} (${err instanceof Error ? err.message : String(err)})`);
        return false;
      })
      .finally(() => { this.#running.delete(sessionId); });
    this.#running.set(sessionId, read);
    return read;
  }

  async #read(sessionId: string): Promise<boolean> {
    const started = performance.now();
    try {
      return await this.#readCard(sessionId);
    } finally {
      const ms = performance.now() - started;
      this.#timing?.(sessionId, ms);
      if (ms > INBOX_SLOW_READ_MS) {
        this.#log(`inbox: card read of session ${sessionId} took ${String(Math.round(ms))} ms`);
      }
    }
  }

  /**
   * Reads the session's conversation file and composes its card. The shown turn comes from a read that proves
   * something outside `starting` and `running`; in those two states the card shows the last turn known to have ended
   * with a result, because a segment of the turn in progress has a result as soon as it calls a tool. A file that
   * cannot be read now, or a window that does not begin at the first entry of the file and holds no result, keeps the
   * shown turn; the card's kind, state and time follow the session either way.
   *
   * @returns whether this read confirmed the card's turn: it took the shown turn from the file it just read. A read
   * that keeps the shown turn, shows the turn of `ended`, publishes nothing or forgets the card confirms nothing.
   */
  async #readCard(sessionId: string): Promise<boolean> {
    const before = this.#port.get(sessionId);
    if (before === undefined || CLOSED_STATES.includes(before.state)) {
      this.#forget(sessionId);
      return false;
    }
    let target: ReturnType<InboxPort['companionTarget']>;
    try {
      target = this.#port.companionTarget(sessionId);
    } catch {
      this.#forget(sessionId);
      return false;
    }
    const conversation = target?.agentSessionId;
    if (target === null || conversation === undefined) {
      this.#forget(sessionId);
      return false;
    }
    const generation = this.#generations.get(sessionId);
    const read = await this.#readSegments(target.cwd, conversation);
    if (this.#disposed || this.#generations.get(sessionId) !== generation) return false;
    const session = this.#port.get(sessionId);
    if (session === undefined) {
      this.#forget(sessionId);
      return false;
    }
    if (this.#conversationOf(sessionId) !== conversation) {
      // The session moved to another conversation during the read without a notice yet: read that one.
      this.#schedule(sessionId);
      return false;
    }
    const segments = read.kind === 'read' ? read.segments : [];
    const proves = read.kind === 'no-file' || (read.kind === 'read' && (read.wholeFile || segments.some(showsResult)));
    const working = WORKING_STATES.includes(session.state);
    const kind = cardKindOf(session.state);
    const kept = this.#turns.get(sessionId);
    let turns: Turns = kept?.conversation === conversation ? kept : { conversation };
    const confirmed = proves && !working && kind !== null;
    if (confirmed) {
      const shown = shownTurnFor(kind, segments);
      turns = { conversation, shown, ended: session.state === 'waiting-input' ? shown : turns.ended };
    }
    this.#turns.set(sessionId, turns);
    const requestOf: RequestOf = (dialog, waitingFor) => this.#dialogs.current(sessionId, dialog, waitingFor);
    const card = composeCard(session, working ? turns.ended : turns.shown, requestOf);
    if (card === null) {
      this.#cards.delete(sessionId);
      return false;
    }
    this.#cards.set(sessionId, card);
    // The turn ended with this result: removals of the session's earlier turns can never match again.
    if (proves && session.state === 'waiting-input') void this.#store.keepTurn(sessionId, card.turnId);
    return confirmed;
  }

  /** The engine conversation the session writes now; `undefined` = none, or the session is gone. */
  #conversationOf(sessionId: string): string | undefined {
    try {
      return this.#port.companionTarget(sessionId)?.agentSessionId;
    } catch {
      return undefined;
    }
  }

  /** The session has no card and no shown turn; its removals stay. */
  #forget(sessionId: string): void {
    this.#cards.delete(sessionId);
    this.#turns.delete(sessionId);
  }

  #safely(sessionId: string, what: string, step: () => void): void {
    try {
      step();
    } catch (err) {
      this.#log(`inbox: ${what} failed for session ${sessionId} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
