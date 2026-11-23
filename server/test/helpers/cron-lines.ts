/**
 * Lines of a main conversation file with scheduled task (cron) entries, in the shapes measured on CLI 2.1.329
 * (`server/test/fixtures/herdr/scheduled/measured/`): a `CronCreate` and a `CronDelete` call with their results, a run
 * line and a carry attachment. Each function returns complete JSONL lines. Used by the reader, poll and integration
 * tests of the scheduled tasks list.
 */

/** Epoch of the line times: line `seconds` is `CRON_T0 + seconds`. */
export const CRON_T0 = Date.parse('2026-11-19T21:00:00.000Z');

/** The model of the assistant entries: a file with them gives the follower its `meta`, so the driver an `init`. */
export const CRON_MODEL = 'claude-opus-5-5';

export const cronAt = (seconds: number): string => new Date(CRON_T0 + seconds * 1000).toISOString();

const line = (session: string, entry: Record<string, unknown>): string =>
  `${JSON.stringify({ isSidechain: false, sessionId: session, ...entry })}\n`;

/** A user prompt, a line the tracker's prefilter drops. */
export function cronUserText(session: string, text: string, seconds = 0): string {
  return line(session, { type: 'user', timestamp: cronAt(seconds), message: { role: 'user', content: text } });
}

export interface CronCreateLine {
  readonly cron?: string;
  readonly prompt?: string;
  readonly recurring?: boolean;
  /** `nextFireAt` of the result, epoch ms; default an hour after `CRON_T0`. */
  readonly nextFireAt?: number;
  readonly seconds?: number;
}

/** A `CronCreate` call and its result; the tool use id is `toolu_create_<id>`. */
export function cronCreate(session: string, id: string, options: CronCreateLine = {}): string {
  const toolId = `toolu_create_${id}`;
  const timestamp = cronAt(options.seconds ?? 0);
  const recurring = options.recurring ?? false;
  return line(session, {
    type: 'assistant', timestamp,
    message: {
      role: 'assistant', model: CRON_MODEL,
      content: [{
        type: 'tool_use', id: toolId, name: 'CronCreate',
        input: { cron: options.cron ?? '13 22 19 11 *', prompt: options.prompt ?? `prompt ${id}`, recurring },
      }],
    },
  }) + line(session, {
    type: 'user', timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `Scheduled job ${id}` }] },
    toolUseResult: {
      id, humanSchedule: 'x', recurring, durable: false, nextFireAt: options.nextFireAt ?? CRON_T0 + 3_600_000,
    },
  });
}

/** A `CronDelete` call and its result (the result has no literal of its own: only the pending call id ties it). */
export function cronDelete(session: string, id: string, seconds = 0): string {
  const toolId = `toolu_delete_${id}`;
  return line(session, {
    type: 'assistant', timestamp: cronAt(seconds),
    message: {
      role: 'assistant', model: CRON_MODEL,
      content: [{ type: 'tool_use', id: toolId, name: 'CronDelete', input: { id } }],
    },
  }) + line(session, {
    type: 'user', timestamp: cronAt(seconds),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `Cancelled job ${id}.` }] },
    toolUseResult: { id },
  });
}

/** The same lines without `message.model`: the follower gives no `meta`, so the driver emits no `init`. */
export function withoutModel(lines: string): string {
  return lines.replaceAll(`"model":"${CRON_MODEL}",`, '');
}

/** The run line of a task. */
export function cronFire(session: string, id: string, seconds: number): string {
  return line(session, {
    type: 'system', subtype: 'scheduled_task_fire', timestamp: cronAt(seconds), content: 'Running scheduled task',
    taskId: id, cron: '* * * * *', prompt: 'p',
  });
}

/** A carry attachment at the start of a file after `/clear`: the tasks of the previous file as `otherArmed`. */
export function cronCarry(
  session: string, tasks: readonly { id: string; recurring?: boolean; createdAt?: number }[], seconds = 0,
): string {
  return line(session, {
    type: 'attachment', timestamp: cronAt(seconds),
    attachment: {
      type: 'session_cron_carry', tasks: [],
      otherArmed: tasks.map((task) => ({
        id: task.id, cron: '*/5 * * * *', prompt: `prompt ${task.id}`, createdAt: task.createdAt ?? CRON_T0,
        recurring: task.recurring ?? true,
      })),
    },
  });
}
