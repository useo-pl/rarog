/**
 * Inbox cards: the last message of every agent's turn that ended with a result, waits for a decision or stopped,
 * one card per session, and the removals of those cards. The only entry of the directory; code outside imports
 * from here.
 *
 * Module map:
 * - `card.ts`: the card of one session from its summary and the segments of its conversation file (pure), and the
 *   key a removal is stored under;
 * - `dialogs.ts`: the dialog requests each session waits on, folded from the manager's events, for the identity of
 *   a decision card's dialog;
 * - `segments.ts`: the read of the conversation file a session writes now, through `readInputSegments`;
 * - `removals.ts`: `inbox.json`, the removals with their atomic write chain;
 * - `inbox.ts`: the tracker that reads cards again after the session manager's events, and remove and restore;
 * - `heads.ts`: the heads of the visible cards and the stream events of their changes.
 */
export { cardKindOf, composeCard, removalKeyOf, shownTurnFor } from './card.ts';
export type { InboxCard, InboxCardKind, InboxDialog, RemovalKey, RequestOf, ShownTurn } from './card.ts';
export { PendingDialogs } from './dialogs.ts';
export { InboxHeads, byNewest, headOf } from './heads.ts';
export type { InboxEvent, InboxHead } from './heads.ts';
export { INBOX_DEBOUNCE_MS, INBOX_SLOW_READ_MS, Inbox } from './inbox.ts';
export type { InboxActionResult, InboxCardRef, InboxConfig, InboxPort } from './inbox.ts';
export { INBOX_CLOSED_LIMIT, INBOX_FILENAME, INBOX_FORMAT } from './removals.ts';
export { INBOX_FIRST_WINDOW, createSegmentReader } from './segments.ts';
export type { SegmentReader, SegmentReaderOptions, SegmentsRead } from './segments.ts';
