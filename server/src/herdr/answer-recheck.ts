/**
 * Status recheck after a dialog answer: wraps the herdr client a driver gets and, after every send of a dialog answer
 * that herdr accepted, asks the supervisor to refresh that pane's status at fixed delays. It reads no status itself
 * and has no state path of its own: the refresh is the supervisor's (`agent.get` → the same update as a push). A send
 * herdr refused schedules nothing; prompts, pastes, prompt submits, mode cycles and queue take-back keys are not dialog
 * answers.
 */
import type { Scheduler, TimerHandle } from '../drivers/runtime.ts';
import type { HerdrClient } from './types.ts';

/**
 * Delays of the status rechecks after a dialog answer, counted from the moment herdr accepted the keys.
 *
 * Rule: the card goes out with the `idle` push of `pane.agent_status_changed`; when that push is lost, these rechecks
 * bring the same `idle`. Why these numbers: herdr pushed `idle` 0.3–0.8 s after the Enter of an answer (herdr 0.9.5,
 * Claude Code 2.1.323), so 1 s finds it in the usual case and 4 s covers a slow CLI. The full resync every 30 s would
 * also find it, but a card standing that long after the answer looks like an answer that did not land.
 */
export const ANSWER_RECHECK_DELAYS_MS: readonly number[] = [1_000, 4_000];

export interface AnswerRecheckConfig {
  scheduler: Scheduler;
  /** The supervisor's status refresh of one pane. */
  refresh(paneId: string): Promise<void>;
  log(line: string): void;
}

export interface AnswerRecheck {
  /** The client for a driver: the same methods, with a recheck after each accepted dialog answer. */
  wrap(client: HerdrClient): HerdrClient;
  /** Drops the rechecks scheduled for a pane (its entry is gone). */
  cancel(paneId: string): void;
  /** Drops every scheduled recheck; nothing is scheduled after this. */
  dispose(): void;
}

export function createAnswerRecheck(config: AnswerRecheckConfig): AnswerRecheck {
  const { scheduler } = config;
  /** One set of timers per pane: a new answer re-arms it instead of adding a second set. */
  const timers = new Map<string, TimerHandle[]>();
  let disposed = false;

  const cancel = (paneId: string): void => {
    const handles = timers.get(paneId);
    if (handles === undefined) return;
    for (const handle of handles) scheduler.clearTimeout(handle);
    timers.delete(paneId);
  };

  const fire = (paneId: string, handle: TimerHandle): void => {
    const handles = timers.get(paneId)?.filter((h) => h !== handle) ?? [];
    if (handles.length === 0) timers.delete(paneId);
    else timers.set(paneId, handles);
    if (disposed) return;
    config.refresh(paneId).catch((err: unknown) => {
      config.log(`herdr: answer recheck for ${paneId} threw an error: ${(err as Error).message}`);
    });
  };

  const arm = (paneId: string): void => {
    if (disposed) return;
    cancel(paneId);
    const handles: TimerHandle[] = [];
    for (const delay of ANSWER_RECHECK_DELAYS_MS) {
      const handle = scheduler.setTimeout(() => { fire(paneId, handle); }, delay);
      handles.push(handle);
    }
    timers.set(paneId, handles);
  };

  /** Runs the send; only a resolved send schedules the recheck, a rejection goes to the caller as it was. */
  const answered = async (paneId: string, send: Promise<void>): Promise<void> => {
    await send;
    arm(paneId);
  };

  const wrap = (client: HerdrClient): HerdrClient => {
    const wrapped: HerdrClient = {
      listAgents: () => client.listAgents(),
      getAgent: (paneId) => client.getAgent(paneId),
      readScreen: (paneId, source, format) => client.readScreen(paneId, source, format),
      prompt: (paneId, text, wait) => client.prompt(paneId, text, wait),
      // Digits of dialog options, Esc of a refusal and the key rows of layer 2 cards go here; so do the Esc of an
      // interrupt and of a composer clear, for which the recheck is one harmless `agent.get`.
      sendKeys: (paneId, keys) => answered(paneId, client.sendKeys(paneId, keys)),
      sendFormSubmit: (paneId) => answered(paneId, client.sendFormSubmit(paneId)),
      sendModeCycle: (paneId) => client.sendModeCycle(paneId),
      sendTrustStep: (paneId, key) => answered(paneId, client.sendTrustStep(paneId, key)),
      sendDialogKey: (paneId, key) => answered(paneId, client.sendDialogKey(paneId, key)),
      sendTakeBackKey: (paneId, key) => client.sendTakeBackKey(paneId, key),
      pasteText: (paneId, text) => client.pasteText(paneId, text),
      sendPromptSubmit: (paneId) => client.sendPromptSubmit(paneId),
      focus: (paneId) => client.focus(paneId),
      ping: () => client.ping(),
      readPaneHistory: (paneId, lines) => client.readPaneHistory(paneId, lines),
    };
    const { readPaneRows } = client;
    if (readPaneRows !== undefined) wrapped.readPaneRows = (paneId) => readPaneRows.call(client, paneId);
    return wrapped;
  };

  return {
    wrap,
    cancel,
    dispose(): void {
      disposed = true;
      for (const paneId of [...timers.keys()]) cancel(paneId);
    },
  };
}
