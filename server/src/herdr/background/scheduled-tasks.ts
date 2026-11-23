/**
 * The session's scheduled tasks (crons): recognition in the conversation file and the list. PURE: no I/O, clock or
 * logs. The caller feeds parsed entries in file order and, when it knows it, the start of the current Claude Code
 * process; the tracker keeps the tasks the session has armed now. It does not read files and does not track
 * `ScheduleWakeup`, subagents' crons or the next run of a recurring task after it ran (that needs a cron evaluator).
 *
 * Recognition (shapes measured on CLI 2.1.329, registry entry `scheduledTasks` in `cli-shapes.ts`); only entries of
 * type `assistant`, `user`, `system` and the attachment count, never a subagent's (`isSidechain`):
 *
 * - **create**: a `CronCreate` call and its result paired by `tool_use_id`, without `is_error`, with an object result.
 *   The prompt and the pattern come from the call (the result has neither); `recurring` from the result, because the
 *   call may carry it as a string. `createdAt` is the time of the result entry;
 * - **delete**: a `CronDelete` result removes the id it names; **snapshot**: a `CronList` result drops known ids it
 *   lacks and updates the others, but never adds an id, because it also lists a pending `ScheduleWakeup` unmarked;
 * - **run**: `scheduled_task_fire` removes a one-shot task; for a recurring one it sets `lastFiredAt` and drops the
 *   stale `nextFireAt`. A `ScheduleWakeup` run (`taskKind` or `cronKind` equal to `loop`) and an unknown id do nothing;
 * - **carry** (`session_cron_carry`): the list becomes `tasks` with `otherArmed`, minus `ended`; known ids keep their
 *   last run and next run;
 * - **process start**: a one-shot task due before the current process started and never run is gone (a resumed
 *   process does not restore it); one past due in the same process stays, its run comes when the session is free.
 */
import type { SessionScheduledTask } from '@rarog/shared';
import { asRecord } from '../../drivers/tool-text.ts';
import { clipUnits, stripControlChars } from '../../text.ts';
import { CLI_SHAPES } from './cli-shapes.ts';

const SHAPE = CLI_SHAPES.scheduledTasks.literals;
const CARRIERS = CLI_SHAPES.notificationCarriers.literals;
const TOOL_RESULT = CLI_SHAPES.toolResult.literals.field;

/** The CLI keeps at most 50 tasks per session (Claude Code docs, "scheduled-tasks"); the list never carries more. */
export const SCHEDULED_TASKS_MAX = 50;

/** UTF-16 units of the prompt that travel to the phone, as many as a task summary. */
export const SCHEDULED_PROMPT_MAX = 120;

/** A recurring task expires 7 days after it was created (Claude Code docs, "scheduled-tasks"). */
export const RECURRING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Calls waiting for their result; a call whose result never comes (the process died) must not pile up. */
const PENDING_MAX = 50;

const ENTRY_TYPES: ReadonlySet<unknown> = new Set(['assistant', 'user', 'system', CARRIERS.attachmentType]);
const TOOLS: ReadonlySet<unknown> = new Set([SHAPE.createTool, SHAPE.deleteTool, SHAPE.listTool]);
/** Literals of which every line that matters has at least one, apart from results of pending calls. */
const LINE_MARKS = [SHAPE.createTool, SHAPE.deleteTool, SHAPE.listTool, SHAPE.fire, SHAPE.carry];

export interface ScheduledTasksTracker {
  /** Feeds ONE parsed entry (a `parseJsonlEntry` result), in file order. */
  note(entry: unknown): void;
  /** The start of the current Claude Code process (epoch ms): one-shot tasks due before it and never run go. */
  processStarted(atMs: number): void;
  /**
   * Prefilter for a raw line before `JSON.parse`: `false` means the line cannot change the list. Passes lines with a
   * cron call, run or carry literal and lines carrying the id of a pending call, because a `CronDelete` result and an
   * empty snapshot have no literal of their own.
   */
  mayMatter(line: string): boolean;
  /** Newest `createdAt` first (without one last), at most {@link SCHEDULED_TASKS_MAX}; a new array of new objects. */
  readonly tasks: readonly SessionScheduledTask[];
}

interface Known {
  cron: string;
  recurring: boolean;
  prompt: string;
  createdAtMs?: number;
  nextFireAtMs?: number;
  lastFiredAt?: string;
  /** File order of the last insert: breaks a tie of `createdAt` (later first). */
  seq: number;
}

interface Pending {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A time in epoch ms that `Date` can hold; anything else is unknown. */
function epochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : undefined;
}

function entryMs(entry: Record<string, unknown>): number | undefined {
  return epochMs(Date.parse(asText(entry['timestamp'])));
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** A multi-line prompt becomes one line: line breaks and tabs turn into single spaces before control characters go. */
function cleanPrompt(raw: unknown): string {
  return clipUnits(stripControlChars(asText(raw).replace(/\s+/g, ' ')).trim(), SCHEDULED_PROMPT_MAX);
}

function blocksOf(entry: Record<string, unknown>): readonly Record<string, unknown>[] {
  const content = asRecord(entry['message'])?.['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Record<string, unknown>[] => {
    const block = plainRecord(item);
    return block === null ? [] : [block];
  });
}

function newestFirst(a: Known, b: Known): number {
  if (a.createdAtMs === undefined || b.createdAtMs === undefined) {
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs === undefined ? 1 : -1;
    return b.seq - a.seq;
  }
  return b.createdAtMs - a.createdAtMs || b.seq - a.seq;
}

function wire(id: string, task: Known): SessionScheduledTask {
  const createdAt = iso(task.createdAtMs);
  const nextFireAt = iso(task.nextFireAtMs);
  const expiresAt = task.recurring && task.createdAtMs !== undefined
    ? iso(epochMs(task.createdAtMs + RECURRING_LIFETIME_MS))
    : undefined;
  return {
    id, cron: task.cron, recurring: task.recurring, prompt: task.prompt,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(nextFireAt === undefined ? {} : { nextFireAt }),
    ...(task.lastFiredAt === undefined ? {} : { lastFiredAt: task.lastFiredAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** Creates the scheduled task tracker of one conversation file. */
export function createScheduledTasksTracker(): ScheduledTasksTracker {
  let known = new Map<string, Known>();
  const pending = new Map<string, Pending>();
  let processStartedAt: number | null = null;
  let seq = 0;

  /*
   * Hidden, not deleted: the start may come before or after the lines, and a carry that lists the task again must
   * still find its `nextFireAt`, or the task would come back without one and stay.
   */
  const missed = (task: Known): boolean => !task.recurring && processStartedAt !== null
    && task.nextFireAtMs !== undefined && task.nextFireAtMs < processStartedAt;

  const created = (input: Record<string, unknown>, result: Record<string, unknown>, at: number | undefined): void => {
    const id = asText(result[SHAPE.id]);
    if (id === '') return;
    seq += 1;
    const task: Known = {
      cron: asText(input[SHAPE.cron]),
      recurring: result[SHAPE.recurring] === true,
      prompt: cleanPrompt(input[SHAPE.prompt]),
      seq,
    };
    if (at !== undefined) task.createdAtMs = at;
    const next = epochMs(result[SHAPE.nextFireAt]);
    if (next !== undefined) task.nextFireAtMs = next;
    known.set(id, task);
  };

  const listed = (result: Record<string, unknown>): void => {
    const jobs = result[SHAPE.jobs];
    if (!Array.isArray(jobs)) return;
    const snapshot = new Map<string, Record<string, unknown>>();
    for (const item of jobs) {
      const job = plainRecord(item);
      const id = asText(job?.[SHAPE.id]);
      if (job !== null && id !== '' && !snapshot.has(id)) snapshot.set(id, job);
    }
    for (const [id, task] of known) {
      const job = snapshot.get(id);
      if (job === undefined) {
        known.delete(id);
        continue;
      }
      // The snapshot writes `recurring` only when it is true.
      task.recurring = job[SHAPE.recurring] === true;
      const next = epochMs(job[SHAPE.nextFireAt]);
      if (next === undefined) delete task.nextFireAtMs;
      else task.nextFireAtMs = next;
    }
  };

  const resulted = (entry: Record<string, unknown>): void => {
    const results = blocksOf(entry).filter((block) => block['type'] === 'tool_result');
    for (const block of results) {
      const id = asText(block['tool_use_id']);
      const call = pending.get(id);
      if (call === undefined) continue;
      pending.delete(id);
      // One entry carries one `toolUseResult`: with several result blocks it is not clear whose it is.
      if (results.length !== 1 || block['is_error'] === true) continue;
      const result = plainRecord(entry[TOOL_RESULT]);
      if (result === null) continue;
      if (call.name === SHAPE.createTool) created(call.input, result, entryMs(entry));
      else if (call.name === SHAPE.deleteTool) known.delete(asText(result[SHAPE.id]));
      else listed(result);
    }
  };

  const called = (entry: Record<string, unknown>): void => {
    for (const block of blocksOf(entry)) {
      if (block['type'] !== 'tool_use' || !TOOLS.has(block['name'])) continue;
      const id = asText(block['id']);
      if (id === '') continue;
      pending.set(id, { name: asText(block['name']), input: plainRecord(block['input']) ?? {} });
      if (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value as string);
    }
  };

  const fired = (entry: Record<string, unknown>): void => {
    if (entry[SHAPE.taskKind] === SHAPE.loop || entry[SHAPE.cronKind] === SHAPE.loop) return;
    const id = asText(entry[SHAPE.taskId]);
    const task = known.get(id);
    if (task === undefined) return;
    if (!task.recurring) {
      known.delete(id);
      return;
    }
    const at = iso(entryMs(entry));
    if (at !== undefined) task.lastFiredAt = at;
    delete task.nextFireAtMs;
  };

  const carried = (attachment: Record<string, unknown>): void => {
    const tasks = attachment[SHAPE.tasks];
    if (!Array.isArray(tasks)) return;
    const others = attachment[SHAPE.otherArmed];
    const endedList = attachment[SHAPE.ended];
    const ended = new Set(Array.isArray(endedList) ? endedList.map(asText) : []);
    const next = new Map<string, Known>();
    for (const value of [...tasks, ...(Array.isArray(others) ? others : [])]) {
      const item = plainRecord(value);
      const id = asText(item?.[SHAPE.id]);
      if (item === null || id === '' || ended.has(id) || next.has(id)) continue;
      const before = known.get(id);
      seq += 1;
      const task: Known = {
        cron: asText(item[SHAPE.cron]),
        recurring: item[SHAPE.recurring] === true,
        prompt: cleanPrompt(item[SHAPE.prompt]),
        seq,
      };
      const createdAt = epochMs(item[SHAPE.createdAt]) ?? before?.createdAtMs;
      if (createdAt !== undefined) task.createdAtMs = createdAt;
      if (before?.nextFireAtMs !== undefined) task.nextFireAtMs = before.nextFireAtMs;
      if (before?.lastFiredAt !== undefined) task.lastFiredAt = before.lastFiredAt;
      next.set(id, task);
    }
    known = next;
  };

  return {
    note(value: unknown): void {
      const entry = plainRecord(value);
      if (entry === null || entry['isSidechain'] === true || !ENTRY_TYPES.has(entry['type'])) return;
      switch (entry['type']) {
        case 'assistant':
          called(entry);
          return;
        case 'user':
          resulted(entry);
          return;
        case 'system':
          if (entry['subtype'] === SHAPE.fire) fired(entry);
          return;
        default: {
          const attachment = plainRecord(entry[CARRIERS.attachmentField]);
          if (attachment !== null && attachment['type'] === SHAPE.carry) carried(attachment);
        }
      }
    },
    processStarted(atMs: number): void {
      if (epochMs(atMs) !== undefined) processStartedAt = atMs;
    },
    mayMatter(line: string): boolean {
      if (LINE_MARKS.some((mark) => line.includes(mark))) return true;
      for (const id of pending.keys()) if (line.includes(id)) return true;
      return false;
    },
    get tasks(): readonly SessionScheduledTask[] {
      return [...known.entries()]
        .filter(([, task]) => !missed(task))
        .sort(([, a], [, b]) => newestFirst(a, b))
        .slice(0, SCHEDULED_TASKS_MAX)
        .map(([id, task]) => wire(id, task));
    },
  };
}
