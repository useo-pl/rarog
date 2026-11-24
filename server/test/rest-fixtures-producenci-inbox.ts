/**
 * Golden REST responses, producers of the Inbox routes: `rest-fixtures-producenci.test.ts` runs them next to its other
 * producers and checks each body against `shared/fixtures/rest/`. The bodies come from the real router (`routeInbox`)
 * over the demo manager of that file. The cards are composed by `composeCard` from the demo session waiting for a
 * permission (its request id from the manager's pending cards) and from summaries derived from it; the tracker behind
 * the routes is a small port whose remove and restore give each outcome the route turns into a response.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ZodType } from 'zod';
import type { SessionSummary } from '@rarog/shared';
import { inboxActionResponseSchema, inboxCardResponseSchema, inboxListSchema } from '@rarog/shared/rest';
import { byNewest, composeCard } from '../src/inbox/index.ts';
import type { InboxActionResult, InboxCard, InboxCardRef, ShownTurn } from '../src/inbox/index.ts';
import { type RouterDeps, createRouter } from '../src/router.ts';
import type { InboxRoutesPort } from '../src/routes/inbox.ts';

interface Captured {
  status: number;
  body: unknown;
}

/** Schema names of the Inbox responses in the manifest (the same names as in `shared/test/rest-fixtures.test.ts`). */
export const INBOX_REST_SCHEMAS: Record<string, ZodType> = {
  inboxList: inboxListSchema,
  inboxCardResponse: inboxCardResponseSchema,
  inboxActionResponse: inboxActionResponseSchema,
};

/** The demo session waiting for a permission: its card carries the id of its pending request. */
const DECISION_SESSION = 'demo-willow';
/** A demo session without a card (closed). */
const NO_CARD_SESSION = 'demo-willow-parser';

function turn(turnId: string, text: string, at: string, truncated = false): ShownTurn {
  return { turnId, version: `${turnId}-v1`, text, truncated, at };
}

function cardOf(session: SessionSummary, shown: ShownTurn, requestId?: string): InboxCard {
  const card = composeCard(session, shown, () => (requestId === undefined ? undefined : { id: requestId }));
  if (card === null) throw new Error(`${session.id}: no card`);
  return card;
}

/** The tracker's answers the routes need, over fixed cards; remove and restore follow the outcomes queued in `next`. */
class FixedInbox implements InboxRoutesPort {
  readonly next: InboxActionResult[] = [];
  readonly #cards: ReadonlyMap<string, InboxCard>;

  constructor(cards: readonly InboxCard[]) {
    this.#cards = new Map(cards.map((card) => [card.sessionId, card]));
  }

  visibleCards(): InboxCard[] { return [...this.#cards.values()].sort(byNewest); }
  card(sessionId: string): InboxCard | null { return this.#cards.get(sessionId) ?? null; }
  removed(): boolean { return false; }
  remove(sessionId: string, ref: InboxCardRef): Promise<InboxActionResult> { return this.#act(sessionId, ref); }
  restore(sessionId: string, ref: InboxCardRef): Promise<InboxActionResult> { return this.#act(sessionId, ref); }

  #act(sessionId: string, ref: InboxCardRef): Promise<InboxActionResult> {
    const card = this.#cards.get(sessionId);
    if (card === undefined || card.turnId !== ref.turnId || card.version !== ref.version) {
      return Promise.resolve({ kind: 'stale' });
    }
    const outcome = this.next.shift();
    if (outcome === undefined) throw new Error('no outcome queued for the Inbox action');
    return Promise.resolve(outcome);
  }
}

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function closed(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
}

/**
 * The Inbox responses: the list with a result (its text cut to the ceiling), a permission decision with its request
 * id, a question decision known by its summary, a dialog in the pane and a failure; one card and no card; remove
 * and restore (done, done again, receipt skipped); the 409, 500 and 503 refusals; `GET /api/version` with `inbox`.
 */
export async function produceInboxRest(
  produced: Map<string, Captured>, deps: RouterDeps, headers: Record<string, string>, origin: string,
): Promise<void> {
  const manager = deps.manager;
  const decision = manager.get(DECISION_SESSION);
  if (decision?.state !== 'waiting-permission') throw new Error(`${DECISION_SESSION}: not waiting for a permission`);
  const permId = manager.transcript(DECISION_SESSION, { peek: true }).pendingPermissions[0]?.permId;
  if (permId === undefined) throw new Error(`${DECISION_SESSION}: no pending permission`);
  const at = (minutes: number): string => new Date(Date.parse(decision.stateSince) - minutes * 60_000).toISOString();
  const { waitingFor: _waiting, herdrDialog: _dialog, herdrDialogReason: _reason, ...plain } = decision;
  const derived = (id: string, patch: Partial<SessionSummary>): SessionSummary => ({ ...plain, id, ...patch });

  const permission = cardOf(decision, turn('pX8n2cHq5zKe4uTy9bWa1f', 'Running the notes tests now.', at(1)), permId);
  const cards = [
    permission,
    cardOf(derived('demo-inbox-result', { state: 'waiting-input', stateSince: at(3) }),
      turn('kT3q9sVb1xRm0aLp2wEc7d', 'All 1446 tests pass; the note is saved before the event.', at(4), true)),
    cardOf(derived('demo-inbox-question', {
      state: 'waiting-question', stateSince: at(6), waitingFor: { kind: 'question', text: 'Which database?', count: 2 },
    }), turn('sC9w4fNt7yRj2oEb5mKv8g', 'Two databases fit the notes store.', at(7))),
    cardOf(derived('demo-inbox-panel', {
      state: 'waiting-permission', stateSince: at(8), herdrDialog: 'trust', herdrDialogReason: 'terminal-only',
    }), turn('uE1y6hQv9aTl4qGd7oMx0j', 'Opening the new project.', at(9))),
    cardOf(derived('demo-inbox-failed', { state: 'error', stateSince: at(10) }),
      turn('rB6m1dLs3vQo8iGh0nZx4k', 'The build failed in step two.', at(11))),
  ];
  const inbox = new FixedInbox(cards);

  const withInbox = http.createServer(createRouter({ ...deps, inbox }));
  const without = http.createServer(createRouter({ ...deps }));
  const base = await listening(withInbox);
  const off = await listening(without);
  const call = async (root: string, method: 'GET' | 'POST', route: string, body?: unknown): Promise<Captured> => {
    const res = await fetch(`${root}${route}`, {
      method,
      headers: { ...headers, ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as unknown };
  };
  const ref = { turnId: permission.turnId, version: permission.version };
  const action = `/api/inbox/${DECISION_SESSION}`;
  try {
    produced.set('version.inbox.json', await call(base, 'GET', '/api/version'));
    produced.set('inbox.list.json', await call(base, 'GET', '/api/inbox'));
    produced.set('inbox.card.json', await call(base, 'GET', action));
    produced.set('inbox.card.none.json', await call(base, 'GET', `/api/inbox/${NO_CARD_SESSION}`));
    inbox.next.push(
      { kind: 'done', changed: true }, { kind: 'done', changed: false },
      { kind: 'done', changed: true, receipt: 'skipped' }, { kind: 'write-failed' },
    );
    produced.set('inbox.removed.json', await call(base, 'POST', `${action}/remove`, ref));
    produced.set('inbox.removed.again.json', await call(base, 'POST', `${action}/remove`, ref));
    produced.set('inbox.restored.receipt-skipped.json', await call(base, 'POST', `${action}/restore`, ref));
    produced.set('error.inbox-save-failed.json', await call(base, 'POST', `${action}/remove`, ref));
    produced.set('error.inbox-card-changed.json',
      await call(base, 'POST', `${action}/remove`, { ...ref, version: 'an-older-version' }));
    produced.set('error.inbox-disabled.json', await call(off, 'GET', '/api/inbox'));
  } finally {
    await closed(withInbox);
    await closed(without);
  }
}
