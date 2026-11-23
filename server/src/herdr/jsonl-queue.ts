/**
 * The prompt queue of the CLI counted from the conversation file: which human prompts wait in it right now. Pure
 * (no I/O, clock or logs): the follower feeds every parsed main-file entry in file order, the tracker reads
 * `queue-operation` entries and the main-thread turn end. It presses no keys, reads no screen and matches no echoes;
 * the driver's take-back step compares this list with the screen and decides.
 */
import { asRecord } from '../drivers/tool-text.ts';
import { CLI_SHAPES } from './background/cli-shapes.ts';
import { isTurnEnd } from './jsonl-pending.ts';

/**
 * The operations of a `queue-operation` entry, measured on CLI 2.1.328 (fixtures `queue/measured/*-2.1.328.jsonl`):
 * - `enqueue` with `content` (the prompt text; a paste starts with `<pasted_content …>`). A `/compact` call queues an
 *   `enqueue` with no `content` key at all (`compact-2.1.328.jsonl`);
 * - `dequeue` with no `content`: the head goes into a new turn and its `user` entry follows (`dwa-naraz`, `dequeue`,
 *   `compact`; a notification in `tasks/measured/postoj-2.1.296.jsonl`);
 * - `remove` with `content`: the entry left the queue mid-turn (`reason` `absorbed_mid_turn`, `wchloniecie`,
 *   `zabranie-meldunek`) or went to the agent (`delivered_to_agent`, `postoj-2.1.296.jsonl`);
 * - `popAll` with `content`, one entry per prompt and one timestamp for all: `up` on an empty field took the human
 *   prompts back to the field (`zabranie`, `zabranie-szeroki`, `zabranie-dlugie`); it leaves a queued notification
 *   where it was (`zabranie-meldunek`).
 */
const OP = { enqueue: 'enqueue', dequeue: 'dequeue', remove: 'remove', popAll: 'popAll' } as const;

/** Human prompts in queue order, or `unknown` when the tracker has not seen the whole queue history. */
export type CliQueueRead = readonly string[] | 'unknown';

/** How many popAll texts a tracker keeps for {@link popsSince}: one `up` empties one CLI queue. */
export const CLI_QUEUE_POPS_KEPT = 64;

/**
 * The popAll entries a tracker has noted, as a mark for {@link popsSince}: `tracker` tells two trackers apart (the
 * follower makes a new one when it reads the file again), `losses` counts {@link CliQueueTracker.lose} calls and
 * `recent` holds the texts of the last {@link CLI_QUEUE_POPS_KEPT} popAll entries in file order, one item per entry,
 * whatever the queue state was.
 */
export interface CliQueuePops {
  readonly tracker: number;
  readonly total: number;
  readonly losses: number;
  readonly recent: readonly string[];
}

/**
 * The popAll texts noted between two marks of the same tracker, in file order: the proof that `up` took the CLI queue
 * back into the prompt field. `unknown` = another tracker, a part of the file the tracker missed in between, or more
 * entries than it keeps.
 */
export function popsSince(before: CliQueuePops, after: CliQueuePops): readonly string[] | 'unknown' {
  const count = after.total - before.total;
  if (after.tracker !== before.tracker || after.losses !== before.losses || count < 0 || count > after.recent.length) {
    return 'unknown';
  }
  return after.recent.slice(after.recent.length - count);
}

export interface CliQueueTracker {
  /** One parsed entry of the main file, in file order (history window and live tail alike). */
  note(entry: unknown): void;
  /** The tracker misses part of the file (window started mid-file, read gap, truncation): the queue is unknown. */
  lose(): void;
  /** Current human prompts in the CLI queue (a copy), oldest first; `unknown` until the next known point. */
  prompts(): CliQueueRead;
  /** The popAll entries noted so far ({@link popsSince}). */
  pops(): CliQueuePops;
}

interface Queued {
  readonly text: string;
  readonly human: boolean;
}

/**
 * A human prompt is any non-empty `content` that is not a task notification. A CLI message about a background agent
 * (`Background agent "…" was stopped by the user.`, `consent-dowod/background-stop-1.glowny.jsonl`, CLI 2.1.319) has
 * no marker in its `queue-operation` entry and counts as human here until its `dequeue`.
 */
function isHuman(text: string): boolean {
  return text !== '' && !text.startsWith(CLI_SHAPES.notification.literals.open);
}

function queueOperation(entry: unknown): { op: string; text: string; hasText: boolean } | null {
  const record = asRecord(entry);
  const { queueType, queueText } = CLI_SHAPES.notificationCarriers.literals;
  if (record === null || record['type'] !== queueType) return null;
  const op = typeof record['operation'] === 'string' ? record['operation'] : '';
  const content = record[queueText];
  return { op, text: typeof content === 'string' ? content : '', hasText: typeof content === 'string' };
}

/**
 * One FIFO list of everything the CLI queued, where a task notification and an empty `enqueue` stand as
 * placeholders: only human prompts leave the tracker, the placeholders keep the contentless `dequeue` that belongs
 * to them from taking a human prompt. A fresh tracker knows an empty queue: the caller creates it for a file read from
 * its first byte, and calls {@link CliQueueTracker.lose} otherwise.
 *
 * Rules (a contradiction in a known queue makes it unknown, never a silent no-op):
 * - `remove` and `popAll` take the first entry with the same text; no such entry → unknown. A notification's
 *   `remove` therefore takes its placeholder, never a human prompt.
 * - A contentless `dequeue` takes the head of the whole queue, placeholders included; an empty queue → unknown.
 *   Which entry the CLI takes when a notification and a human prompt wait together is unmeasured: every measured
 *   `dequeue` had one kind in the queue.
 * - Known again at the main-thread turn end (`system/turn_duration`): the queue is empty there in every measured
 *   file (queue and task fixtures, CLI 2.1.296–2.1.328). The one entry left at a turn end, in
 *   `tasks/measured/resume-cli-2.1.296.jsonl`, was queued while the CLI process exited and never left the file's
 *   queue; the resumed process did not deliver it. The turn end clears such leftovers too.
 * - An unknown operation → unknown.
 */
let trackers = 0;

export function createCliQueueTracker(): CliQueueTracker {
  let queue: Queued[] | null = [];
  const id = ++trackers;
  const popped: string[] = [];
  let poppedTotal = 0;
  let losses = 0;

  const take = (text: string): void => {
    if (queue === null) return;
    const index = queue.findIndex((item) => item.text === text);
    if (index === -1) queue = null;
    else queue.splice(index, 1);
  };

  return {
    note(entry: unknown): void {
      if (isTurnEnd(entry)) {
        queue = [];
        return;
      }
      const operation = queueOperation(entry);
      if (operation?.op === OP.popAll) {
        popped.push(operation.text);
        poppedTotal += 1;
        if (popped.length > CLI_QUEUE_POPS_KEPT) popped.shift();
      }
      if (operation === null || queue === null) return;
      switch (operation.op) {
        case OP.enqueue:
          queue.push({ text: operation.text, human: isHuman(operation.text) });
          return;
        case OP.dequeue:
          // A `dequeue` with content is unmeasured; it can only name the entry it took.
          if (operation.hasText) take(operation.text);
          else if (queue.shift() === undefined) queue = null;
          return;
        case OP.remove:
        case OP.popAll:
          take(operation.text);
          return;
        default:
          queue = null;
      }
    },
    lose(): void {
      queue = null;
      losses += 1;
    },
    prompts(): CliQueueRead {
      return queue === null ? 'unknown' : queue.filter((item) => item.human).map((item) => item.text);
    },
    pops(): CliQueuePops {
      return { tracker: id, total: poppedTotal, losses, recent: [...popped] };
    },
  };
}
