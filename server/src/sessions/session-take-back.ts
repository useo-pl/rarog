/**
 * The queue take-back for the app (`POST /api/sessions/:id/queue/take-back`): the session gates, one driver take-back
 * per `operationId` (a retry gets the result of the first, also while it runs), and the held echoes of the taken
 * messages, which leave the session without a flush. While the driver works, the held echo flushes and new sends wait
 * (`pauseHeldFlush`), so a taken message never stands in the transcript as sent. The driver takes the queues
 * (`SessionDriver.takeBackQueue`); this module sends no key and reads no screen. Results live in RAM with the session.
 */
import type { QueueTakeBackResponse } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import type { QueueTakeBackResult, TakeBackRefusal, TakenEntry } from '../drivers/types.ts';
import { echoKey } from '../herdr/jsonl-follow.ts';
import { BadRequestError, BadStateError, GoneError } from './errors.ts';
import { type HeldEchoDeps, pauseHeldFlush, takeHeld } from './held-echo.ts';
import { SEND_REGISTRY_WINDOW_MS } from './send-registry.ts';
import type { Session } from './session.ts';
import { HERDR_OUT_OF_SCOPE_MESSAGE, RESTART_IN_PROGRESS_MESSAGE } from './state-sentences.ts';

/** How long a result answers a retry: the window of the send registry, so a retry after a long outage still matches. */
export const TAKE_BACK_RESULT_TTL_MS = SEND_REGISTRY_WINDOW_MS;

/** Results kept per session; the oldest finished result goes first. A take-back holds the texts of a few prompts. */
export const TAKE_BACK_RESULTS_MAX = 32;

/**
 * What the take-back needs from the manager: the deferred echo dependencies (sessions, clock, restart reservations,
 * logger, and what the turn end flush armed after a take-back needs) and the write channel gate.
 */
export interface SessionTakeBackPort extends HeldEchoDeps {
  /** Throws 400 when the write channel to herdr panes is closed (`RAROG_HERDR_SEND=0`, read-only herdr). */
  readonly assertWritable: () => void;
}

/** One take-back of a session: its promise, and once it answered 200, the moment for the TTL. */
interface Entry {
  readonly promise: Promise<QueueTakeBackResponse>;
  doneAt: number | null;
}

/** When the take-back was accepted and when its first key went to the pane (`null`: none yet), on the port's clock. */
interface Timing {
  readonly accepted: number;
  firstKey: number | null;
}

/**
 * A driver refusal as the error the router maps: `pane` is 410 like a missing session (nothing in this pane can be
 * taken back), every other refusal is 409. Each has its own sentence; none sent a key or changed a queue.
 */
export function takeBackRefusal(reason: TakeBackRefusal): GoneError | BadStateError {
  const sentence = say(`session.take-back.${reason}`);
  return reason === 'pane' ? new GoneError(sentence) : new BadStateError(sentence);
}

export class SessionTakeBack {
  readonly #port: SessionTakeBackPort;
  readonly #results = new WeakMap<Session, Map<string, Entry>>();

  constructor(port: SessionTakeBackPort) {
    this.#port = port;
  }

  /**
   * The take-back of session `id`. The `operationId` lookup goes before every gate, so a retry of a take-back that
   * answered 200 gets the same body, and a retry during it joins it. A refusal and a thrown gate free the id. Gates
   * throw synchronously: unknown session 410, out of scope (Codex included) 400, closed write channel 400, restart
   * reservation 409, no driver 410, a driver without a queue 400.
   */
  take(id: string, operationId: string): Promise<QueueTakeBackResponse> {
    const session = this.#port.sessions.get(id);
    if (session === undefined) throw new GoneError(say('rest.session-not-found'));
    const results = this.#resultsOf(session);
    const known = results.get(operationId);
    if (known !== undefined) return known.promise;
    if (session.outOfScope === true) throw new BadRequestError(HERDR_OUT_OF_SCOPE_MESSAGE);
    this.#port.assertWritable();
    if (this.#port.restarting(id)) throw new BadStateError(RESTART_IN_PROGRESS_MESSAGE);
    const driver = session.driver;
    if (driver === null) throw takeBackRefusal('pane');
    if (driver.takeBackQueue === undefined) throw new BadRequestError(say('session.take-back.no-queue'));
    const timing: Timing = { accepted: this.#port.now(), firstKey: null };
    const taken = driver.takeBackQueue(() => { timing.firstKey ??= this.#port.now(); });
    // Until the take-back answers, the held echo flushes wait: they could append a message it takes. Paused after the
    // call, so a driver that throws synchronously leaves nothing paused; nothing can flush in between.
    const resume = pauseHeldFlush(session, this.#port);
    const promise = taken.then((result) => this.#answer(session, result, entry, results, timing)).finally(resume);
    const entry: Entry = { promise, doneAt: null };
    results.set(operationId, entry);
    // A refusal (or a driver error) frees the id: nothing was taken, so a retry gets a new chance.
    promise.catch(() => { if (results.get(operationId) === entry) results.delete(operationId); });
    this.#trim(results);
    return promise;
  }

  /**
   * The driver's result as the body of the 200, with the held echoes of the taken messages out of the session. The log
   * line times it from the request: to the answer, and to the first key (`no key` when none went).
   */
  #answer(
    session: Session, result: QueueTakeBackResult, entry: Entry, results: Map<string, Entry>, timing: Timing,
  ): QueueTakeBackResponse {
    if ('refused' in result) throw takeBackRefusal(result.refused);
    const items = [...result.cli, ...result.rarog].map((taken) => itemOf(session, taken));
    entry.doneAt = this.#port.now();
    // Take-backs that ran together finish over the cap: the oldest finished results go now, not at the next start.
    this.#trim(results);
    const firstKey = timing.firstKey === null
      ? 'no key' : `first key after ${String(timing.firstKey - timing.accepted)} ms`;
    this.#port.config.logger?.(`take-back: ${session.id} gave back ${String(items.length)} prompt(s) in `
      + `${String(entry.doneAt - timing.accepted)} ms (${firstKey})`
      + (result.cliLeft === true ? '; part of the CLI queue stayed' : ''));
    return result.cliLeft === true ? { items, incomplete: true } : { items };
  }

  /** The results of this session without the expired ones. */
  #resultsOf(session: Session): Map<string, Entry> {
    let results = this.#results.get(session);
    if (results === undefined) {
      results = new Map();
      this.#results.set(session, results);
    }
    const now = this.#port.now();
    for (const [id, entry] of results) {
      if (entry.doneAt !== null && now - entry.doneAt >= TAKE_BACK_RESULT_TTL_MS) results.delete(id);
    }
    return results;
  }

  /** Over the cap, the oldest finished results go; a take-back that still runs stays joinable. */
  #trim(results: Map<string, Entry>): void {
    for (const [id, entry] of results) {
      if (results.size <= TAKE_BACK_RESULTS_MAX) return;
      if (entry.doneAt !== null) results.delete(id);
    }
  }
}

/**
 * One taken prompt for the app. The held echo of its token leaves the session, so the message is not flushed after the
 * turn; its `clientMessageId` goes with the item only when the taken text is the message's own text. Under the same
 * token the follower also matches a field in which the message was pasted onto a draft at the desk: that text is not
 * the app's message alone, so it comes back without the id, like a prompt typed at the Mac.
 */
function itemOf(session: Session, taken: TakenEntry): QueueTakeBackResponse['items'][number] {
  if (taken.echo === undefined) return { text: taken.text };
  const held = takeHeld(session, taken.echo);
  return held !== undefined && echoKey(held.text) === echoKey(taken.text)
    ? { text: taken.text, clientMessageId: held.clientMessageId }
    : { text: taken.text };
}
