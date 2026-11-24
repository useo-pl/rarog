/**
 * The heads of the visible Inbox cards as the stream sends them: one head per session whose card is not removed,
 * without the text. It keeps the head it last published for each session and turns every change the tracker reports
 * (`Inbox.onChange`) into at most one event: `inbox-head` when a card became visible or its head changed,
 * `inbox-removed` when a published card left the visible cards, nothing when the head stayed the same. It writes to no
 * stream itself; the SSE hub subscribes (`onEvent`) and sends the events only to streams opened with `inbox=1`.
 */
import type { InboxEventOf, InboxHeadOf, SessionState } from '@rarog/shared';
import type { InboxCard } from './card.ts';
import type { Inbox } from './inbox.ts';

export type InboxHead = InboxHeadOf<SessionState>;
export type InboxEvent = InboxEventOf<SessionState>;

/** The head of a card: what the stream says of it, without the text and the dialog details. */
export function headOf(card: InboxCard): InboxHead {
  return {
    sessionId: card.sessionId, turnId: card.turnId, version: card.version, kind: card.kind, state: card.state,
    at: card.at, ...(card.dialog === undefined ? {} : { dialog: card.dialog.kind }),
  };
}

/** Newest first, as the Inbox shows the cards; the session id keeps the order stable for equal times. */
export function byNewest(a: { at: string; sessionId: string }, b: { at: string; sessionId: string }): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

export class InboxHeads {
  readonly #source: Pick<Inbox, 'card' | 'removed'>;
  /** The head last published for each session, with its JSON for the comparison. */
  readonly #published = new Map<string, { readonly head: InboxHead; readonly json: string }>();
  readonly #listeners = new Set<(event: InboxEvent) => void>();

  /** Follows the tracker's changes from now on; the heads start empty and fill with its reads. */
  constructor(inbox: Pick<Inbox, 'card' | 'removed' | 'onChange'>) {
    this.#source = inbox;
    inbox.onChange((sessionId) => { this.note(sessionId); });
  }

  /** The published heads, newest first: the `inbox-heads` of a stream that opens now. */
  heads(): InboxHead[] {
    return [...this.#published.values()].map((entry) => entry.head).sort(byNewest);
  }

  /** Listener of the events; returns the function that detaches it. */
  onEvent(listener: (event: InboxEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Compares the session's visible card with the head published for it and publishes the difference. */
  note(sessionId: string): void {
    const card = this.#source.card(sessionId);
    const previous = this.#published.get(sessionId);
    if (card === null || this.#source.removed(sessionId)) {
      if (previous === undefined) return;
      this.#published.delete(sessionId);
      this.#emit({ type: 'inbox-removed', sessionId, turnId: previous.head.turnId });
      return;
    }
    const head = headOf(card);
    const json = JSON.stringify(head);
    if (previous?.json === json) return;
    this.#published.set(sessionId, { head, json });
    this.#emit({ type: 'inbox-head', head });
  }

  #emit(event: InboxEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
