/**
 * Protocol contract, Inbox area: the heads of Inbox cards on the global stream, without the card text.
 *
 * A stream gets them only when it asks with `inbox=1` (`GET /api/stream?inbox=1`): `inbox-heads` right after
 * `sessions-snapshot`, then `inbox-head` when a visible card changes and `inbox-removed` when it leaves the visible
 * cards. The text comes from `GET /api/inbox` (`rest.ts`). The head carries the protocol's `SessionState`, which an
 * area file does not import: the types and schemas take it as a parameter, and `protocol.ts` binds it.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

/** `result`: the turn ended with a result; `decision`: the turn waits for a person; `failed`: the turn stopped. */
export const INBOX_CARD_KINDS = ['result', 'decision', 'failed'] as const;
export type InboxCardKind = (typeof INBOX_CARD_KINDS)[number];
export const inboxCardKindSchema = z.enum(INBOX_CARD_KINDS);

/** What a `decision` card waits for: a permission card, a question card, or a dialog in the pane without a card. */
export const INBOX_DIALOG_KINDS = ['permission', 'question', 'panel'] as const;
export type InboxDialogKind = (typeof INBOX_DIALOG_KINDS)[number];
export const inboxDialogKindSchema = z.enum(INBOX_DIALOG_KINDS);

/**
 * The head of one visible card. `turnId` and `version` are opaque: a new `version` means new text to fetch, and
 * remove and restore send both back. `state` is the session state when the card was read (the app hides the card in
 * `starting` and `running`); `at` orders the cards, newest first.
 */
export interface InboxHeadOf<S extends string> {
  sessionId: string;
  turnId: string;
  version: string;
  kind: InboxCardKind;
  state: S;
  at: string;
  /** `decision` cards only. */
  dialog?: InboxDialogKind;
}

/**
 * `inbox-heads`: every visible card, newest first, once per stream; `inbox-head`: a card that became visible or whose
 * head changed; `inbox-removed`: the card of this turn left the visible cards (removed on a device, the session
 * closed, or its conversation changed). All three are fleeting: `seq: null`, outside every ring buffer.
 */
export type InboxEventOf<S extends string> =
  | { type: 'inbox-heads'; heads: InboxHeadOf<S>[] }
  | { type: 'inbox-head'; head: InboxHeadOf<S> }
  | { type: 'inbox-removed'; sessionId: string; turnId: string };

/** The head schema over the protocol's session state schema. */
export function inboxHeadSchemaOf<S extends z.ZodType<string>>(state: S) {
  return z.object({
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    version: z.string().min(1),
    kind: inboxCardKindSchema,
    state,
    at: z.string(),
    dialog: inboxDialogKindSchema.optional(),
  });
}

/** The three event schemas, in the order of {@link InboxEventOf}, for the protocol's event union. */
export function inboxEventSchemas<S extends z.ZodType<string>>(state: S) {
  const head = inboxHeadSchemaOf(state);
  return [
    z.object({ type: z.literal('inbox-heads'), heads: z.array(head) }),
    z.object({ type: z.literal('inbox-head'), head }),
    z.object({ type: z.literal('inbox-removed'), sessionId: z.string().min(1), turnId: z.string().min(1) }),
  ] as const;
}
