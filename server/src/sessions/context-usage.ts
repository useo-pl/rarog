/**
 * Context window of a session card: the manager passes a `usage` event of a driver here, and the function stores it
 * on the session and broadcasts it through a narrow {@link ContextUsagePort}. This module does not import
 * `manager.ts`.
 */
import type { ContextLimitState, ServerEvent } from '@rarog/shared';
import type { Session } from './session.ts';

/** Emission of the manager the context window needs. */
export interface ContextUsagePort {
  readonly emitSession: (session: Session, event: ServerEvent) => void;
  readonly emitSessionChanged: (session: Session) => void;
}

/**
 * Zapisuje zużycie kontekstu i rozgłasza je.
 *
 * Stan `unknown` (limit okna NIEPOTWIERDZONY) jest normalny i najczęstszy: w jsonl nie ma
 * limitu, a identyfikator modelu okna nie rozstrzyga (`jsonl-usage.ts`). Karta dostaje wtedy samą liczbę
 * tokenów przez `session-changed`, a event `usage` (który z kontraktu wymaga limitu) NIE
 * leci — zmyślony limit narysowałby pasek pokazujący 92 % przy 185k w sesji na 1M.
 */
export function applyUsage(session: Session, context: ContextLimitState, port: ContextUsagePort): void {
  if (!Number.isFinite(context.tokens) || context.tokens < 0) return;
  session.context = context;
  if (context.kind === 'known' && context.limit > 0) {
    session.usage = { contextTokens: context.tokens, contextLimit: context.limit };
    port.emitSession(session, {
      type: 'usage',
      sessionId: session.id,
      contextTokens: context.tokens,
      contextLimit: context.limit,
    });
  }
  port.emitSessionChanged(session);
}
