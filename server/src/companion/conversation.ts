/**
 * Opaque token of a session's engine conversation for the voice agent across sessions. Two reads of a session carry
 * different tokens when the session moved to another conversation in between (`/clear`, `/resume` in the pane), so a
 * client sees the change without the server handing out the engine's conversation id. It does not track
 * conversations: it only maps an id to its token.
 *
 * The token is HMAC-SHA-256 of the id under a random key drawn when the server process starts and kept only in its
 * memory, cut to 22 base64url characters (132 bits). The same conversation gives the same token while the server runs,
 * another conversation another token, and a restart changes every token. Without the key nobody can recover the id
 * from a token or check a guessed id against it.
 */
import { createHmac, randomBytes } from 'node:crypto';

/** Characters of a token: 22 base64url characters carry 132 bits of the digest. */
export const CONVERSATION_TOKEN_CHARS = 22;

/** Token function under `key`; a session without an engine conversation yet (`undefined`) has its own token. */
export function conversationTokens(key: Uint8Array): (agentSessionId: string | undefined) => string {
  return (agentSessionId) => createHmac('sha256', key).update(agentSessionId ?? '').digest('base64url')
    .slice(0, CONVERSATION_TOKEN_CHARS);
}

/** Token of the server process: a key drawn once, at the first import of this module. */
export const conversationToken = conversationTokens(randomBytes(32));
