/**
 * The voice agent on the session manager's side: the scope gate it shares with the commands list, the session it
 * may ask about or list in its catalog, the conversation check of a prompt it sends and of a result it picks up, and
 * the listeners that hear of a new engine conversation (`/clear`, `/resume` in the pane). Functions over one session and a listener set; the
 * manager keeps the session lookup and calls them. This module does not import `manager.ts`.
 */
import { homedir } from 'node:os';
import { say } from '@rarog/shared/sentences';
import type { CompanionTarget } from '../companion/ask.ts';
import type { CompanionEntry } from '../companion/catalog.ts';
import { inWorkAreaOnDisk } from '../config/work-area.ts';
import { BadStateError } from './errors.ts';
import type { Session } from './session.ts';

/** What the scope gate reads from the manager configuration. */
export interface SessionScopeConfig {
  readonly demo: boolean;
  readonly herdrRoots?: readonly string[] | undefined;
  /** Home directory for the work area's protected folders; default the account's home. */
  readonly home?: string | undefined;
}

/** Listener of engine conversation changes: the session and the conversation it writes now. */
export type ConversationListener = (sessionId: string, agentSessionId: string) => void;

/**
 * Scope of the commands list (`GET /api/sessions/:id/commands`) and of the voice agent, the same as for sending and
 * for reading the session catalog. Out of scope: a pane outside `RAROG_HERDR_ROOTS` (every Codex pane among them)
 * and a session whose directory lies outside the roots (a pane that started outside them and ran `cd` under a
 * root), as for the diff, because the list carries the names and descriptions of skills from `.claude/` of that
 * directory. A card without a pane is in scope with its directory; demo mode reads the registry only.
 */
export function inCommandScope(session: Session, config: SessionScopeConfig): boolean {
  if (session.engine === 'codex' || session.outOfScope === true) return false;
  return config.demo || sessionCwdInArea(session, config);
}

/**
 * Whether the directory a read of this session will use lies in the work area of `RAROG_HERDR_ROOTS`. A pane
 * follows `cd` in its scope, but `session.cwd` stays the directory from the pane's appearance, so the diff and the
 * command list ask about this directory. A card without a pane is in the area with its directory. The directory counts
 * as written and on disk ({@link inWorkAreaOnDisk}): a link into a protected folder of home, or a root that is a
 * symlink to home, does not open that folder to a read.
 */
export function sessionCwdInArea(session: Session, config: SessionScopeConfig): boolean {
  return session.herdrKey === undefined
    || inWorkAreaOnDisk(session.cwd, config.herdrRoots ?? [], config.home ?? homedir());
}

/**
 * Session the voice agent may ask about: its directory and the engine conversation it writes now (`init` of the
 * driver; `undefined` before the first one). `null` = out of {@link inCommandScope}; the route answers that with its
 * own sentence instead of the 400 of the commands list.
 */
export function companionTargetOf(session: Session, config: SessionScopeConfig): CompanionTarget | null {
  return inCommandScope(session, config) ? { cwd: session.cwd, agentSessionId: session.engineSessionId } : null;
}

/**
 * {@link companionTargetOf} with the newest message of the session's transcript in memory, for the voice agent's
 * session catalog, only when that message belongs to the engine conversation the session writes now
 * (`Session.lastMessageOfConversation`). It reads the session only: no file, no mark of a card or a message as shown.
 */
export function companionEntryOf(session: Session, config: SessionScopeConfig): CompanionEntry | null {
  const target = companionTargetOf(session, config);
  return target === null ? null : { ...target, lastMessage: session.lastMessageOfConversation() };
}

/**
 * Whether the session is in the engine conversation a client read: the conversation the session writes (`init` of
 * the driver) passes `matches` (the client's token turned into a check of a conversation id), and the pane runs that
 * same conversation as the driver knows it (`SessionDriver.agentSessionId`: the driver moves at `/clear` and `/resume`
 * before the manager hears `init`). A driver that does not know the pane's conversation (`''`) passes only for a
 * session without one. Synchronous, so a caller that acts right after it acts on the conversation it checked: the send
 * ({@link assertSendConversation}) and the voice agent's pick-up of a result (`markSeen` in `seen-marks.ts`).
 */
export function inReadConversation(
  session: Session, matches: (agentSessionId: string | undefined) => boolean,
): boolean {
  const paneRuns = session.driver?.agentSessionId;
  const moved = paneRuns !== undefined && paneRuns !== (session.engineSessionId ?? '');
  return !moved && matches(session.engineSessionId);
}

/**
 * The conversation check of a send (`SendMessageOptions.conversation`, from the body's `expectedConversation`):
 * {@link inReadConversation}, otherwise a 409 with its sentence. The manager calls it after the last `await` of the
 * send and before the echo, with no `await` between it and `driver.send`, whose ticket keeps the same conversation for
 * every key of the message, also in the paste queue. `undefined` = no check.
 */
export function assertSendConversation(
  session: Session, matches: ((agentSessionId: string | undefined) => boolean) | undefined,
): void {
  if (matches === undefined) return;
  if (!inReadConversation(session, matches)) throw new BadStateError(say('session.conversation-changed'));
}

/** Listeners of engine conversation changes; a failing listener goes to the log and does not stop the others. */
export class ConversationListeners {
  readonly #listeners = new Set<ConversationListener>();
  readonly #log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.#log = log;
  }

  /** Adds a listener; returns the function that detaches it. */
  add(listener: ConversationListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** The session now writes `agentSessionId` (a question about the previous conversation dies with it). */
  notify(sessionId: string, agentSessionId: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(sessionId, agentSessionId);
      } catch (err) {
        this.#log(`conversation listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
