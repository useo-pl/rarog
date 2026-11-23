/**
 * Holds that outlive a consent dialog, for the paste queue's gates (`prompt-gates.ts`): whether fresh
 * reads show them stale. herdr keeps `blocked` after a dialog closes, Rarog's status follows herdr's events later
 * still, and the registry fallback hold follows the manager's last registry signal; a message queued during a
 * turn waited through the gap between two dialogs and went in the next turn. This module only judges; it lifts no
 * other hold (a screen consent dialog, a form fallback, a hook request) and sends no key.
 */
import type { CliWaitingSignal } from '../../cli-version.ts';

/**
 * Retry of a queued message whose attempt saw a fresh registry read without `waiting` under a stale-able hold. The
 * dialog is closed and only lagging signals hold: herdr's own status left `blocked` up to 0.35 s after the dialog
 * closed, and the next dialog of the same turn stood about 0.8 s after it (two `Bash` dialogs, CLI 2.1.322, herdr
 * 0.9.5). The usual 300 ms retry often missed that gap.
 */
export const PROMPT_STALE_RETRY_MS = 100;

/** Fresh reads the judgement takes, in this order; each comes from the queue's own dependencies. */
export interface StaleBlockReads {
  /** A fresh CLI session registry read of the pane's engine session. */
  readonly registry: () => Promise<CliWaitingSignal>;
  /** The prompt field from a fresh screen read: `null` = covered (dialog, form), `undefined` = the read failed. */
  readonly field: () => Promise<string | null | undefined>;
}

/**
 * - `stale`: a fresh registry read says the CLI process does not wait (`active`, busy or idle) and then a fresh screen
 *   read shows the prompt field, which every consent dialog and form covers: the hold outlived the dialog;
 * - `covered`: the registry does not wait, but the field is covered or the screen read failed: the hold stays;
 * - `held`: the registry says `waiting` or `unknown` (no registry, two writers), or its read failed: the hold stays and
 *   the screen is not read.
 */
export async function staleBlockVerdict(reads: StaleBlockReads): Promise<'stale' | 'covered' | 'held'> {
  let signal: CliWaitingSignal;
  try {
    signal = await reads.registry();
  } catch {
    return 'held';
  }
  if (signal.kind !== 'active') return 'held';
  let field: string | null | undefined;
  try {
    field = await reads.field();
  } catch {
    return 'covered';
  }
  return typeof field === 'string' ? 'stale' : 'covered';
}
