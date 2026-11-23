/**
 * A turns read that holds against a change of the session while the file is read, for
 * `GET /api/sessions/:id/companion/turns`. The session is taken again after every read: the same engine conversation
 * means the read is sent; another conversation (`/clear`, `/resume` in the pane) means a new read for it, at most
 * {@link TURNS_MAX_READS} reads in all; a refusal (the session is gone or out of scope now) ends it. It does not know
 * the session manager, the response or the refusals: the route gives the take and the finishing step.
 */
import type { CompanionTurns } from '@rarog/shared/rest';
import type { CompanionTurnsReader, CompanionTurnsTarget } from './turns.ts';

/** Reads of one request: the first one and two more for conversations that changed during the previous read. */
export const TURNS_MAX_READS = 3;

/** The session as the route takes it now: its target with `stateSince`, or the route's own refusal. */
export type TurnsTake<R> = { readonly target: CompanionTurnsTarget } | { readonly refused: R };

/**
 * How a request ends: the turns of the conversation the session still writes (`turns`), the refusal of the last take
 * (`refused`), or a conversation that changed during each of the {@link TURNS_MAX_READS} reads (`unsettled`).
 */
export type SettledTurns<R> =
  | { readonly kind: 'turns'; readonly body: CompanionTurns }
  | { readonly kind: 'refused'; readonly refusal: R }
  | { readonly kind: 'unsettled' };

/**
 * Takes the session, reads its turns and takes it again until the conversation holds still across a read. `finish`
 * runs synchronously right after the last take, with no `await` in between, so the route answers for the session as
 * it was taken. A body carries the token and `stateSince` of the target it was read for, never of a later take.
 */
export async function readSettledTurns<R>(
  reader: CompanionTurnsReader,
  take: () => TurnsTake<R>,
  count: number,
  finish: (outcome: SettledTurns<R>) => void,
): Promise<void> {
  let taken = take();
  for (let reads = 1; ; reads += 1) {
    if (!('target' in taken)) {
      finish({ kind: 'refused', refusal: taken.refused });
      return;
    }
    const { target } = taken;
    const body = await reader.read(target, count);
    taken = take();
    // A refusal now ends the request at the top of the loop.
    if (!('target' in taken)) continue;
    if (taken.target.agentSessionId === target.agentSessionId) {
      finish({ kind: 'turns', body });
      return;
    }
    if (reads === TURNS_MAX_READS) {
      finish({ kind: 'unsettled' });
      return;
    }
  }
}
