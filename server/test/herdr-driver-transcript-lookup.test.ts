/**
 * The driver asks the follower to look the transcript file up when the pane enters a block, so a dialog in a
 * session whose file appeared after the follower's fast retry window gets the card from the `tool_use` entry, not
 * a card from the screen alone. A dialog before the first prompt (no file) still gets its screen card after one
 * lookup, without waiting the jsonl ↔ screen grace.
 *
 * The follower here retries a missing file fast for 20 ms and then every ten minutes, so the slow retry never comes
 * during a test.
 */
import { rename, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import {
  DIALOG_PERMISSION, makeDriver, permissions, root, screenDialogs, toolUseLine, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const TIMING = { batchMs: 4, statTickMs: 3, missingFastMs: 3, missingWindowMs: 20, missingSlowMs: 600_000 };
/** Long enough that one lookup and one history read fit well inside the grace (2 × debounce). */
const DEBOUNCE_MS = 150;
/** The call of the `dialog-permission.txt` screen; the description is the one that screen shows. */
const BASH_INPUT = {
  command: 'pnpm exec vitest run server/test/state-machine.test.ts',
  description: 'Uruchamia testy maszyny stanów',
};
const TRUST_DIALOG = `${'─'.repeat(63)}\n Do you trust the files in this folder?\n\n ❯ 1. Yes, proceed\n   2. No, exit\n`;

/** A driver over a pane with no transcript file whose follower has passed its fast retry window. */
async function staleNoFile(): Promise<{ fx: Fixture; follower: () => JsonlFollower }> {
  let follower: JsonlFollower | null = null;
  const follow: HerdrDriverDeps['follow'] = (o) => {
    follower = createJsonlFollower({ ...o, root, watch: false, timing: TIMING });
    return follower;
  };
  const fx = await makeDriver({ noTranscript: true, deps: { follow, pendingDebounceMs: DEBOUNCE_MS } });
  const current = (): JsonlFollower => {
    if (follower === null) throw new Error('no follower');
    return follower;
  };
  await waitFor(() => current().hasTranscript() === 'no', 'first lookup missed');
  // Past the fast window: what is armed now is the ten-minute retry.
  await new Promise((resolve) => setTimeout(resolve, TIMING.missingWindowMs * 3));
  expect(current().hasTranscript()).toBe('no');
  return { fx, follower: current };
}

/** Atomic create: a lookup sees no file or the whole file. */
async function createTranscript(path: string, content: string): Promise<void> {
  await writeFile(`${path}.partial`, content);
  await rename(`${path}.partial`, path);
}

describe('transcript lookup when the pane enters a block', () => {
  it('a dialog after a stale "no file" gets the card from the `tool_use` entry, never one from the screen', async () => {
    const { fx } = await staleNoFile();
    await createTranscript(fx.transcript, userLine('run the tests') + toolUseLine('toolu_1', 'Bash', BASH_INPUT));
    fx.client.screenText = DIALOG_PERMISSION;

    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'card');

    expect(permissions(fx.events).map((card) => card.reqId)).toEqual(['toolu_1']);
    expect(permissions(fx.events)[0]?.input).toEqual(BASH_INPUT);
    expect(screenDialogs(fx.events)).toEqual([]);
  });

  it('a dialog before the first prompt gets its screen card without waiting the grace', async () => {
    const { fx, follower } = await staleNoFile();
    fx.client.screenText = TRUST_DIALOG;

    const started = Date.now();
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'screen card');

    expect(screenDialogs(fx.events)[0]?.knownDialog).toBe('trust');
    expect(Date.now() - started).toBeLessThan(DEBOUNCE_MS * 2);
    expect(follower().hasTranscript()).toBe('no');
  });
});
