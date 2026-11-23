/**
 * The voice agent's session catalog behind `GET /api/companion/sessions`: one row per session the voice agent may see,
 * built from the server's memory. A session the scope gate refuses (a Codex session, a pane out of scope, a directory
 * outside the work area) has no row, so it never reaches the voice model in any form. It reads no conversation file
 * and keeps nothing between reads; the route checks the flags.
 */
import type { SessionSummary, TranscriptMessage } from '@rarog/shared';
import type { CompanionSessions } from '@rarog/shared/rest';
import type { CompanionTarget } from './ask.ts';
import { messageAsksOwner } from './asks-owner.ts';

/** A session as the voice agent may see it: the question target and the last message the server holds. */
export interface CompanionEntry extends CompanionTarget {
  /** The newest message of the session's transcript in the server's memory; `undefined` = none. */
  readonly lastMessage: TranscriptMessage | undefined;
}

/** What the catalog needs from the session manager (`ManagerApi`). */
export interface CompanionCatalogPort {
  list(): SessionSummary[];
  /** `null` = out of the voice agent's scope. */
  companionTarget(id: string): CompanionEntry | null;
}

/**
 * The catalog now. A row carries the session id, `conversation` (the token of its engine conversation, the same
 * function as the turns route), `stateSince` as the session list carries it and `asksOwner: true` only while the
 * session waits for input and its last message is an agent message that asks the owner (`asks-owner.ts`).
 */
export function companionCatalog(
  port: CompanionCatalogPort, token: (agentSessionId: string | undefined) => string,
): CompanionSessions {
  const sessions: CompanionSessions['sessions'] = [];
  for (const summary of port.list()) {
    const entry = port.companionTarget(summary.id);
    if (entry === null) continue;
    const asksOwner = summary.state === 'waiting-input' && messageAsksOwner(entry.lastMessage);
    sessions.push({
      id: summary.id,
      ...(asksOwner ? { asksOwner: true as const } : {}),
      conversation: token(entry.agentSessionId),
      stateSince: summary.stateSince,
    });
  }
  return { sessions };
}
