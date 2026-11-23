/**
 * Keys of the queue take-back: `up` takes the CLI prompt queue back into the prompt field, `down` leaves the history
 * entry that `up` opens when that queue is empty, `ctrl+u` clears the field (measured, CLI 2.1.328). One key per
 * call, from a closed list, checked before the client touches the socket (`sendTakeBackKey`); only the driver's queue
 * take-back module calls it.
 *
 * These keys do NOT join `ALLOWED_KEYS` (`keys.ts`): there a key would be open to every send path at once, and the
 * arrows move the highlight of a standing dialog (`up` in a permission dialog, `up` and `down` in an `AskUserQuestion`
 * form; CLI 2.1.328), which is a choice by position.
 * The proof that the prompt field, not a dialog, takes the key is the caller's, not this module's. Pure, no I/O.
 */
import { say } from '@rarog/shared/sentences';
import { HerdrKeyNotAllowedError } from './keys.ts';

/** On an empty prompt field, takes every prompt of the CLI queue back into the field, one per line (CLI 2.1.328). */
export const TAKE_BACK_UP_KEY = 'up';
/** Leaves the history entry `up` opens on an empty CLI queue: the field before `up` comes back (CLI 2.1.328). */
export const TAKE_BACK_DOWN_KEY = 'down';
/** Deletes the prompt field's screen line from the cursor to its start; the turn runs on (CLI 2.1.328). */
export const TAKE_BACK_CLEAR_KEY = 'ctrl+u';

/** Keys the queue take-back sends through `sendTakeBackKey`: the closed list. */
export const TAKE_BACK_KEYS = [TAKE_BACK_UP_KEY, TAKE_BACK_DOWN_KEY, TAKE_BACK_CLEAR_KEY] as const;

export type TakeBackKey = typeof TAKE_BACK_KEYS[number];

const TAKE_BACK_SET: ReadonlySet<string> = new Set(TAKE_BACK_KEYS);

/**
 * Assertion of the take-back path: EXACTLY one key from {@link TAKE_BACK_KEYS} per call.
 *
 * @throws {HerdrKeyNotAllowedError} when the array has another length than 1 or the key is not on the list
 */
export function assertTakeBackKey(keys: readonly string[]): void {
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !TAKE_BACK_SET.has(key)) {
    throw new HerdrKeyNotAllowedError(
      say('dialogs.key-not-allowed', { key: keys.join(', '), allowed: TAKE_BACK_KEYS.join(', ') }),
    );
  }
}
