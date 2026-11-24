/**
 * Inbox routes: `GET /api/inbox` (every visible card with its text), `GET /api/inbox/:sessionId` (one card) and
 * `POST /api/inbox/:sessionId/remove|restore` (`{turnId, version}`). The cards come from the tracker in
 * `server/src/inbox/`; the heads go out on the global stream (`SseHub`). Without the tracker (`RAROG_INBOX=0`) every
 * route answers 503. The routes never read the session transcript (see {@link wireOf}).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  INBOX_CARD_CHANGED_ERROR, INBOX_DISABLED_ERROR, inboxActionBodySchema,
} from '@rarog/shared/rest';
import type { InboxActionResponse, InboxCardWire } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import type { Inbox, InboxCard } from '../inbox/index.ts';
import { methodNotAllowed, readValidatedBody, sendError, sendJson } from '../router.ts';
import { type RouteContext, type RouteRequest, decodeSegment } from './context.ts';

/** What the routes ask the Inbox tracker. */
export type InboxRoutesPort = Pick<Inbox, 'visibleCards' | 'card' | 'removed' | 'remove' | 'restore'>;

type InboxAction = 'remove' | 'restore';

/**
 * The card on the wire, as the tracker composed it: a `decision` card carries the dialog the session summary
 * describes and the id of its card in the session stream, not that pending card. Reading it (`ManagerApi.transcript`,
 * also with `peek`) marks every consent card of the session as shown, also those this answer would not carry; the next
 * change of such a card then goes as `permission-settled`, which a device that never got the card drops, instead of
 * `permission-pending`.
 */
function wireOf(card: InboxCard): InboxCardWire {
  const { dialog, ...head } = card;
  return dialog === undefined ? head : { ...head, dialog };
}

function disabled(res: ServerResponse): true {
  sendError(res, 503, INBOX_DISABLED_ERROR, say('rest.inbox-disabled'));
  return true;
}

function unknownSession(res: ServerResponse): true {
  sendError(res, 404, 'not-found', say('rest.session-not-found'));
  return true;
}

async function act(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, inbox: InboxRoutesPort, sessionId: string,
  action: InboxAction,
): Promise<void> {
  const body = await readValidatedBody(req, res, ctx.config, inboxActionBodySchema);
  if (body === null) return;
  if (ctx.manager.get(sessionId) === undefined) {
    unknownSession(res);
    return;
  }
  const result = action === 'remove' ? await inbox.remove(sessionId, body) : await inbox.restore(sessionId, body);
  if (result.kind === 'stale') {
    sendError(res, 409, INBOX_CARD_CHANGED_ERROR, say('rest.inbox-card-changed'));
    return;
  }
  if (result.kind === 'write-failed') {
    ctx.log.error(`inbox: ${action} of the card of session ${sessionId} not saved`);
    sendError(res, 500, 'internal', say('rest.inbox-save-failed'));
    return;
  }
  const response: InboxActionResponse = {
    ok: true, changed: result.changed, ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
  };
  sendJson(res, 200, response);
}

export async function routeInbox(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
): Promise<boolean> {
  const { method, pathname, segments } = rq;
  const inbox = ctx.deps.inbox;

  if (pathname === '/api/inbox') {
    if (method !== 'GET') return methodNotAllowed(res, 'GET');
    if (inbox === undefined) return disabled(res);
    sendJson(res, 200, { cards: inbox.visibleCards().map(wireOf) });
    return true;
  }

  // /api/inbox/:sessionId[/remove|/restore]
  if (segments[0] === 'api' && segments[1] === 'inbox' && segments.length >= 3) {
    const sessionId = decodeSegment(segments[2] ?? '');
    const action = segments[3];

    if (segments.length === 3) {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      if (inbox === undefined) return disabled(res);
      if (ctx.manager.get(sessionId) === undefined) return unknownSession(res);
      const card = inbox.card(sessionId);
      sendJson(res, 200, card === null || inbox.removed(sessionId) ? {} : { card: wireOf(card) });
      return true;
    }

    if (action === 'remove' && segments.length === 4) {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      if (inbox === undefined) return disabled(res);
      await act(ctx, req, res, inbox, sessionId, 'remove');
      return true;
    }

    if (action === 'restore' && segments.length === 4) {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      if (inbox === undefined) return disabled(res);
      await act(ctx, req, res, inbox, sessionId, 'restore');
      return true;
    }
  }

  return false;
}
