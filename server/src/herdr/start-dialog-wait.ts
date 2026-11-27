/**
 * Start dialog wait of the launcher: a Claude Code start dialog herdr reads as ready (`idle`, `interactive_ready`,
 * no session id), for example the dialog about external imports of the project's memory files, ends the readiness
 * wait as `blocked`, like the trust dialog herdr reports itself. After any `blocked` start without a session id (also
 * the trust dialog, which a start dialog herdr reads as ready can follow), a bounded poll notices the session id the
 * answer brings: herdr pushes no status change for it.
 *
 * Two legs end the wait: the signature of a measured dialog on one read, or the same screen without the prompt field
 * for {@link START_DIALOG_STABLE_MS}. The screen rule is `dialogs/screen/start-dialog.ts`; this module only keeps the
 * time and the poll, sends no key and knows neither the supervisor nor the manager (they come in as functions).
 */
import { startDialogOf } from './dialogs/index.ts';
import type { StartDialog } from './dialogs/index.ts';
import { HerdrGoneError } from './types.ts';

/**
 * How long one screen without the prompt field and without a known signature must stand unchanged before it counts
 * as an unknown start dialog. A wrong hit costs one card for a few seconds, because the session id lifts it; a long
 * wait leaves the phone without a word. A screen that changes (a render in progress) restarts the count.
 */
export const START_DIALOG_STABLE_MS = 8_000;

/**
 * Poll period of `agent.get` after a start dialog. The pane is `idle` before and after the answer (herdr 0.9.5), so
 * no status change has to be pushed; without this poll the full resync would be the first to notice the session id.
 */
export const START_DIALOG_SESSION_POLL_MS = 1_000;

/**
 * Bound of that poll: it limits the `agent.get` calls on a pane nobody answers. An answer after it is still found by
 * the full resync, only later.
 */
export const START_DIALOG_SESSION_WATCH_MS = 10 * 60_000;

/** The fields of one `agent.get` sample the start dialog wait looks at. */
export interface StartDialogSample {
  readonly agentSessionId: string;
  readonly interactiveReady: boolean | null;
  readonly launchPending?: boolean;
}

/**
 * Whether a readiness sample is worth a screen read: herdr says ready, or has no readiness flag because the launch
 * record is gone (`interactive_ready` absent without `launch_pending`), and knows no session id. A sample under
 * `launch_pending` is not read: a cold start keeps the shell line on the screen for seconds, and that is no dialog.
 */
export function startDialogSample(sample: StartDialogSample): boolean {
  if (sample.agentSessionId !== '') return false;
  if (sample.interactiveReady === true) return true;
  return sample.interactiveReady === null && sample.launchPending !== true;
}

/** The screen reads of one readiness wait. */
export interface StartDialogWatch {
  /**
   * One screen read of a {@link startDialogSample} at time `at`: the start dialog that ends the wait, or `null` to
   * keep polling. `screen === null` is a failed read: it proves nothing and keeps the count where it was.
   */
  observe(screen: string | null, at: number): StartDialog | null;
}

export function createStartDialogWatch(stableMs: number = START_DIALOG_STABLE_MS): StartDialogWatch {
  let first: { screen: string; at: number } | null = null;
  return {
    observe(screen: string | null, at: number): StartDialog | null {
      if (screen === null) return null;
      const dialog = startDialogOf(screen);
      if (dialog === null) {
        first = null;
        return null;
      }
      if (dialog.id !== null) return dialog;
      if (first?.screen !== screen) {
        first = { screen, at };
        return null;
      }
      return at - first.at >= stableMs ? dialog : null;
    },
  };
}

/** What the session watch after a start dialog needs from the launcher and the supervisor. */
export interface StartDialogSessionWatch {
  readonly key: string;
  readonly paneId: string;
  /** `agent.get` of the pane; throws `HerdrGoneError` when the agent is gone. */
  probe(paneId: string): Promise<{ readonly agentSessionId: string }>;
  /** The supervisor still holds this launch without having seen its agent on a list (and is not disposed). */
  held(key: string): boolean;
  /** The supervisor's status refresh of the pane: it applies the session id and the status like a push. */
  appeared(paneId: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

/**
 * Polls `agent.get` until the session id appears, then asks the supervisor to refresh the pane once. Stops without a
 * refresh when the agent is gone, when the supervisor no longer holds the launch, or after
 * {@link START_DIALOG_SESSION_WATCH_MS}. Another read error keeps the poll. Never rejects.
 */
export async function watchStartDialogSession(watch: StartDialogSessionWatch): Promise<void> {
  const deadline = watch.now() + START_DIALOG_SESSION_WATCH_MS;
  try {
    while (watch.now() < deadline) {
      await watch.sleep(START_DIALOG_SESSION_POLL_MS);
      if (!watch.held(watch.key)) return;
      let sessionId: string;
      try {
        ({ agentSessionId: sessionId } = await watch.probe(watch.paneId));
      } catch (err) {
        if (err instanceof HerdrGoneError) return;
        continue;
      }
      if (sessionId !== '') {
        watch.log(`herdr launcher: pane ${watch.paneId} reports its session after the start dialog; refreshing.`);
        watch.appeared(watch.paneId);
        return;
      }
    }
    watch.log(`herdr launcher: no session on pane ${watch.paneId} within `
      + `${Math.round(START_DIALOG_SESSION_WATCH_MS / 60_000)} min of its start dialog; the resync takes over.`);
  } catch (err) {
    watch.log(`herdr launcher: the session watch of pane ${watch.paneId} failed: ${(err as Error).message}`);
  }
}
