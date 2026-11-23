/**
 * Key row of a layer 2 card (`docs/dialog-card.md`, "Answer"): the arrows, Tab and Enter a footer segment names.
 * One key per call, from a closed list, checked before the client touches the socket (`sendDialogKey`).
 *
 * These keys do NOT join `ALLOWED_KEYS` (`keys.ts`): there a key would be open to every send path at once, which would be
 * a choice by position, and Rarog never chooses by position. Digits and Esc of a layer 2 card go the `sendKeys` way like every other card; the proof that the
 * key belongs to the card on the screen is the layer 2 step's (`drivers/herdr/layer2-step.ts`), not this module's.
 * Pure, no I/O.
 */
import { say } from '@rarog/shared/sentences';
import { HerdrKeyNotAllowedError } from './keys.ts';

/** Keys a layer 2 card sends through `sendDialogKey`: the closed list. */
export const KEY_ROW_KEYS = ['up', 'down', 'left', 'right', 'tab', 'enter'] as const;

export type KeyRowKey = typeof KEY_ROW_KEYS[number];

const KEY_ROW_SET: ReadonlySet<string> = new Set(KEY_ROW_KEYS);

/** Whether a key goes the key row way (`sendDialogKey`) rather than `sendKeys`. */
export function isKeyRowKey(key: string): key is KeyRowKey {
  return KEY_ROW_SET.has(key);
}

/**
 * Assertion of the key row: EXACTLY one key from {@link KEY_ROW_KEYS} per call.
 *
 * @throws {HerdrKeyNotAllowedError} when the array has another length than 1 or the key is not on the list
 */
export function assertDialogKey(keys: readonly string[]): void {
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !KEY_ROW_SET.has(key)) {
    throw new HerdrKeyNotAllowedError(
      say('dialogs.key-not-allowed', { key: keys.join(', '), allowed: KEY_ROW_KEYS.join(', ') }),
    );
  }
}
