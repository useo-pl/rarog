/**
 * The session's scheduled tasks: `herdr/background/scheduled-tasks.ts`, a pure tracker fed with conversation file
 * entries in file order.
 *
 * The first block walks the recognition table case by case on synthetic entries; the second replays the measured
 * conversations from `fixtures/herdr/scheduled/measured/` (CLI 2.1.329) and checks the list against every `CronList`
 * snapshot the session took, at the point where it took it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionScheduledTask } from '@rarog/shared';
import {
  SCHEDULED_TASKS_MAX, createScheduledTasksTracker,
} from '../src/herdr/background/scheduled-tasks.ts';
import type { ScheduledTasksTracker } from '../src/herdr/background/scheduled-tasks.ts';

type Json = Record<string, unknown>;

const T0 = Date.parse('2026-11-19T21:00:00.000Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

function call(id: string, name: string, input: Json, seconds = 0, extra: Json = {}): Json {
  return {
    type: 'assistant', timestamp: at(seconds), ...extra,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}

function result(id: string, toolUseResult: unknown, seconds = 0, extra: Json = {}, isError = false): Json {
  const block: Json = { type: 'tool_result', tool_use_id: id, content: 'text' };
  if (isError) block['is_error'] = true;
  return { type: 'user', timestamp: at(seconds), ...extra, toolUseResult, message: { role: 'user', content: [block] } };
}

function fire(taskId: string, seconds: number, extra: Json = {}): Json {
  return {
    type: 'system', subtype: 'scheduled_task_fire', timestamp: at(seconds), content: 'Running scheduled task',
    taskId, cron: '* * * * *', prompt: 'p', ...extra,
  };
}

function carry(attachment: Json, seconds = 0): Json {
  return { type: 'attachment', timestamp: at(seconds), attachment: { type: 'session_cron_carry', ...attachment } };
}

interface CreateOptions {
  readonly cron?: string;
  readonly prompt?: string;
  readonly recurring?: boolean;
  readonly inputRecurring?: unknown;
  readonly nextFireAt?: number;
  readonly seconds?: number;
}

/** A `CronCreate` call and its result; `toolu_<id>` pairs them. */
function create(id: string, options: CreateOptions = {}): Json[] {
  const recurring = options.recurring ?? false;
  const toolId = `toolu_${id}`;
  return [
    call(toolId, 'CronCreate', {
      cron: options.cron ?? '13 22 19 11 *', prompt: options.prompt ?? `prompt ${id}`,
      recurring: options.inputRecurring ?? recurring,
    }, options.seconds ?? 0),
    result(toolId, {
      id, humanSchedule: 'x', recurring, durable: false, nextFireAt: options.nextFireAt ?? T0 + 3_600_000,
    }, options.seconds ?? 0),
  ];
}

function cronDelete(id: string, seconds = 0): Json[] {
  return [call(`toolu_del_${id}`, 'CronDelete', { id }, seconds), result(`toolu_del_${id}`, { id }, seconds)];
}

function cronList(tag: string, jobs: Json[], seconds = 0): Json[] {
  return [call(`toolu_list_${tag}`, 'CronList', {}, seconds), result(`toolu_list_${tag}`, { jobs }, seconds)];
}

function feed(
  entries: readonly Json[], tracker: ScheduledTasksTracker = createScheduledTasksTracker(),
): ScheduledTasksTracker {
  for (const entry of entries) tracker.note(entry);
  return tracker;
}

const ids = (tracker: ScheduledTasksTracker): string[] => tracker.tasks.map((task) => task.id);
const only = (tracker: ScheduledTasksTracker): SessionScheduledTask => {
  expect(tracker.tasks).toHaveLength(1);
  return tracker.tasks[0] as SessionScheduledTask;
};

describe('scheduled tasks: recognition table', () => {
  it('a CronCreate call with its result adds the task with `recurring` from the result', () => {
    const recurring = only(feed(create('9bc70ce1', {
      cron: '*/2 * * * *', recurring: true, inputRecurring: 'true', nextFireAt: 1795122756510.361, seconds: 10,
    })));
    expect(recurring).toEqual({
      id: '9bc70ce1', cron: '*/2 * * * *', recurring: true, prompt: 'prompt 9bc70ce1', createdAt: at(10),
      nextFireAt: '2026-11-19T21:12:36.510Z', expiresAt: new Date(T0 + 10_000 + 7 * DAY_MS).toISOString(),
    });
    const oneShot = only(feed(create('bac11b20', { inputRecurring: 'false', nextFireAt: 1795122780000, seconds: 5 })));
    expect(oneShot).toEqual({
      id: 'bac11b20', cron: '13 22 19 11 *', recurring: false, prompt: 'prompt bac11b20', createdAt: at(5),
      nextFireAt: '2026-11-19T21:13:00.000Z',
    });
    // The input says `"true"`, the result says false: the result wins.
    expect(only(feed(create('c1', { recurring: false, inputRecurring: 'true' }))).recurring).toBe(false);
  });

  it('an error result, a string result, an unpaired result or a repeated result change nothing', () => {
    const base = create('keep1');
    const cases: Json[][] = [
      [call('toolu_e', 'CronCreate', { cron: '* * * * *', prompt: 'p' }),
        result('toolu_e', { id: 'x1', recurring: true }, 0, {}, true)],
      [call('toolu_s', 'CronCreate', { cron: '* * * * *', prompt: 'p' }), result('toolu_s', 'Error: invalid cron')],
      [result('toolu_nobody', { id: 'x2', recurring: true, nextFireAt: T0 })],
      [call('toolu_d', 'CronDelete', { id: 'keep1' }), result('toolu_d', { id: 'keep1' }, 0, {}, true)],
      [call('toolu_d2', 'CronDelete', { id: 'keep1' }), result('toolu_d2', 'Error: no such job')],
      [call('toolu_l', 'CronList', {}), result('toolu_l', { jobs: [] }, 0, {}, true)],
      [call('toolu_l2', 'CronList', {}), result('toolu_l2', 'No scheduled jobs.')],
    ];
    for (const entries of cases) expect(ids(feed([...base, ...entries]))).toEqual(['keep1']);
    // The same result twice: the second one has nothing pending to pair with.
    const repeated = feed([...base, result('toolu_keep1', { id: 'other', recurring: false, nextFireAt: T0 })]);
    expect(ids(repeated)).toEqual(['keep1']);
  });

  it('the run of a one-shot task removes it', () => {
    expect(ids(feed([...create('bac11b20'), fire('bac11b20', 60)]))).toEqual([]);
  });

  it('the run of a recurring task sets `lastFiredAt` to the line time and drops `nextFireAt`', () => {
    const task = only(feed([...create('9bc70ce1', { recurring: true }), fire('9bc70ce1', 97)]));
    expect(task.lastFiredAt).toBe(at(97));
    expect(task.nextFireAt).toBeUndefined();
    expect(task.expiresAt).toBeDefined();
  });

  it('a run with an unknown task id or of a `ScheduleWakeup` changes nothing', () => {
    const base = create('bac11b20');
    expect(ids(feed([...base, fire('76cf3e2a', 60)]))).toEqual(['bac11b20']);
    expect(ids(feed([...base, fire('bac11b20', 60, { taskKind: 'loop', cronKind: 'loop' })]))).toEqual(['bac11b20']);
    expect(ids(feed([...base, fire('bac11b20', 60, { taskKind: 'loop' })]))).toEqual(['bac11b20']);
    expect(ids(feed([...base, fire('bac11b20', 60, { cronKind: 'loop' })]))).toEqual(['bac11b20']);
  });

  it('CronDelete removes the task', () => {
    expect(ids(feed([...create('a1'), ...create('b2', { seconds: 1 }), ...cronDelete('a1', 2)]))).toEqual(['b2']);
  });

  it('CronList drops known ids it lacks, updates known ones and never adds an unknown id', () => {
    const tracker = feed([
      ...create('gone1', { seconds: 1 }),
      ...create('kept2', { recurring: true, cron: '*/3 * * * *', seconds: 2 }),
      fire('kept2', 30),
      ...cronList('a', [
        { id: 'kept2', cron: '*/3 * * * *', humanSchedule: 'Every 3 minutes', prompt: 'prompt kept2', recurring: true,
          durable: false, nextFireAt: 1795126579137.932 },
        { id: '76cf3e2a', cron: '9 23 * * *', humanSchedule: 'Every day at 11:09 PM', prompt: '/loop 5m p',
          durable: false, nextFireAt: 1795126140000 },
      ], 40),
    ]);
    expect(tracker.tasks).toEqual([{
      id: 'kept2', cron: '*/3 * * * *', recurring: true, prompt: 'prompt kept2', createdAt: at(2),
      nextFireAt: '2026-11-19T22:16:19.137Z', lastFiredAt: at(30),
      expiresAt: new Date(T0 + 2_000 + 7 * DAY_MS).toISOString(),
    }]);
    // The snapshot writes `recurring` only when it is true: a missing key means false.
    const listed = feed([
      ...create('r1', { recurring: true }),
      ...cronList('b', [{ id: 'r1', cron: '* * * * *', prompt: 'p', durable: false, nextFireAt: T0 }]),
    ]);
    expect(only(listed).recurring).toBe(false);
  });

  it('a carry replaces the list with `tasks` and `otherArmed`, minus `ended`, keeping what known ids knew', () => {
    const createdAt = 1795122709338;
    const tracker = feed([
      ...create('dropped', { seconds: 1 }),
      ...create('ran', { recurring: true, cron: '*/2 * * * *', seconds: 2, nextFireAt: T0 + 120_000 }),
      ...create('waits', { recurring: true, cron: '*/5 * * * *', seconds: 3, nextFireAt: T0 + 300_000 }),
      fire('ran', 120),
      carry({
        tasks: [
          { id: 'ran', cron: '*/2 * * * *', prompt: 'prompt ran', createdAt, recurring: true },
          { id: 'waits', cron: '*/5 * * * *', prompt: 'prompt waits', createdAt: createdAt + 1, recurring: true },
          { id: 'stopped', cron: '1 1 * * *', prompt: 'stopped', createdAt: createdAt + 2, recurring: false },
        ],
        otherArmed: [{ id: 'other', cron: '7 7 7 7 *', prompt: 'other', createdAt: createdAt + 3, recurring: false }],
        ended: ['stopped'],
      }, 150),
    ]);
    expect(tracker.tasks).toEqual([
      {
        id: 'other', cron: '7 7 7 7 *', recurring: false, prompt: 'other',
        createdAt: new Date(createdAt + 3).toISOString(),
      },
      {
        id: 'waits', cron: '*/5 * * * *', recurring: true, prompt: 'prompt waits',
        createdAt: new Date(createdAt + 1).toISOString(), nextFireAt: new Date(T0 + 300_000).toISOString(),
        expiresAt: new Date(createdAt + 1 + 7 * DAY_MS).toISOString(),
      },
      {
        id: 'ran', cron: '*/2 * * * *', recurring: true, prompt: 'prompt ran',
        createdAt: new Date(createdAt).toISOString(),
        lastFiredAt: at(120), expiresAt: new Date(createdAt + 7 * DAY_MS).toISOString(),
      },
    ]);
    // Exit with "Exit and stop tasks": nothing carried, the ended id gone.
    expect(ids(feed([carry({ tasks: [], ended: ['1e927a54'] })], feed(create('1e927a54'))))).toEqual([]);
  });

  it('subagent entries, `api-request-blob` and `queue-operation` change nothing', () => {
    const sidechain = { isSidechain: true };
    const createCall = call('toolu_x', 'CronCreate', { cron: '* * * * *', prompt: 'p', recurring: true });
    const cases: Json[][] = [
      [call('toolu_x', 'CronCreate', { cron: '* * * * *', prompt: 'p' }, 0, sidechain),
        result('toolu_x', { id: 'x1', recurring: true, nextFireAt: T0 }, 0, sidechain)],
      [{ type: 'api-request-blob', message: createCall['message'] }, result('toolu_x', { id: 'x1', recurring: true })],
      [{ type: 'queue-operation', operation: 'enqueue', timestamp: at(1), content: 'p', taskId: 'base1' }],
      [fire('base1', 5, sidechain)],
    ];
    for (const entries of cases) expect(ids(feed([...create('base1'), ...entries]))).toEqual(['base1']);
    const sideCarry = { ...carry({ tasks: [] }), isSidechain: true };
    expect(ids(feed([...create('base1'), sideCarry]))).toEqual(['base1']);
  });

  it('keeps the 50 newest by `createdAt`, entries without one last', () => {
    const entries: Json[] = [];
    for (let i = 0; i < SCHEDULED_TASKS_MAX + 1; i += 1) entries.push(...create(`t${i}`, { seconds: i }));
    const noTime = create('untimed');
    (noTime[1] as Json)['timestamp'] = 'not a time';
    const tracker = feed([...noTime, ...entries]);
    expect(tracker.tasks).toHaveLength(SCHEDULED_TASKS_MAX);
    expect(tracker.tasks[0]?.id).toBe(`t${SCHEDULED_TASKS_MAX}`);
    expect(ids(tracker)).not.toContain('t0');
    expect(ids(tracker)).not.toContain('untimed');
    const few = feed([...noTime, ...create('timed', { seconds: 1 })]);
    expect(ids(few)).toEqual(['timed', 'untimed']);
    expect(few.tasks[1]?.createdAt).toBeUndefined();
  });

  it('a new file after `/clear` starts from its own carry', () => {
    const newFile = feed([
      carry({
        tasks: [],
        otherArmed: [{ id: '9bc70ce1', cron: '*/2 * * * *', prompt: 'p', createdAt: T0, recurring: true }],
      }),
    ]);
    expect(newFile.tasks).toEqual([{
      id: '9bc70ce1', cron: '*/2 * * * *', recurring: true, prompt: 'p', createdAt: at(0),
      expiresAt: new Date(T0 + 7 * DAY_MS).toISOString(),
    }]);
  });

  it('a one-shot due before the current process started and never run is removed; due later, it stays', () => {
    const due = T0 + 60_000;
    const lines = [
      ...create('missed', { nextFireAt: due, seconds: 0 }),
      ...create('ahead', { nextFireAt: due + 600_000, seconds: 1 }),
      ...create('repeats', { recurring: true, nextFireAt: due, seconds: 2 }),
    ];
    const started = feed(lines);
    started.processStarted(due + 30_000);
    expect(ids(started).sort()).toEqual(['ahead', 'repeats']);
    // A whole file read with the start already known gives the same list.
    const known = createScheduledTasksTracker();
    known.processStarted(due + 30_000);
    expect(ids(feed(lines, known)).sort()).toEqual(['ahead', 'repeats']);
    // Past due within the same process: the run of a busy session comes later, the task stays.
    const sameProcess = createScheduledTasksTracker();
    sameProcess.processStarted(T0 - 1_000);
    // A carry that lists the missed task does not bring it back, whether the start comes before or after the lines.
    const carried = [...create('missed', { nextFireAt: due }),
      carry({ tasks: [{ id: 'missed', cron: '1 1 1 1 *', prompt: 'p', createdAt: T0, recurring: false }] }, 10)];
    const startFirst = createScheduledTasksTracker();
    startFirst.processStarted(due + 30_000);
    expect(ids(feed(carried, startFirst))).toEqual([]);
    const startAfter = feed(carried);
    startAfter.processStarted(due + 30_000);
    expect(ids(startAfter)).toEqual([]);
    const later = { type: 'user', timestamp: at(3_600), message: { content: 'later' } };
    expect(ids(feed([...lines, later], sameProcess)).sort()).toEqual(['ahead', 'missed', 'repeats']);
  });

  it('cleans and clips the prompt without splitting a surrogate pair', () => {
    const clean = only(feed(create('c', { prompt: '  line one\u0007\n\nline\ttwo\u2028end ' }))).prompt;
    expect(clean).toBe('line one line two end');
    const long = only(feed(create('l', { prompt: 'x'.repeat(300) }))).prompt;
    expect(long).toBe('x'.repeat(120));
    const pair = only(feed(create('s', { prompt: `${'x'.repeat(119)}😀tail` }))).prompt;
    expect(pair).toHaveLength(120);
    expect(pair.endsWith('�')).toBe(true);
    expect(pair.slice(0, 119)).toBe('x'.repeat(119));
  });
});

describe('scheduled tasks: ambiguous result entries', () => {
  it('an entry with several result blocks changes nothing and closes the calls it answers', () => {
    const [createCall, single] = create('m1');
    const both = {
      ...(single as Json),
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_m1', content: 'text' },
        { type: 'tool_result', tool_use_id: 'toolu_other', content: 'text' },
      ] },
    };
    const tracker = feed([createCall as Json, both]);
    expect(ids(tracker)).toEqual([]);
    feed([single as Json], tracker);
    expect(ids(tracker)).toEqual([]);
  });
});

describe('scheduled tasks: prefilter for raw lines', () => {
  it('passes cron call, run and carry lines, and the result line of a pending call, nothing else', () => {
    const tracker = createScheduledTasksTracker();
    const [createLine, resultLine] = create('a1').map((entry) => JSON.stringify(entry));
    const [deleteCall, deleteResult] = cronDelete('a1').map((entry) => JSON.stringify(entry));
    expect(tracker.mayMatter(JSON.stringify(fire('a1', 1)))).toBe(true);
    expect(tracker.mayMatter(JSON.stringify(carry({ tasks: [] })))).toBe(true);
    expect(tracker.mayMatter(JSON.stringify({ type: 'user', message: { content: 'hello' } }))).toBe(false);
    expect(tracker.mayMatter(deleteResult ?? '')).toBe(false);
    for (const line of [createLine, resultLine, deleteCall]) {
      expect(tracker.mayMatter(line ?? '')).toBe(true);
      tracker.note(JSON.parse(line ?? '') as unknown);
    }
    // The CronDelete result carries no cron literal: it passes only while its call is pending.
    expect(tracker.mayMatter(deleteResult ?? '')).toBe(true);
    tracker.note(JSON.parse(deleteResult ?? '') as unknown);
    expect(tracker.mayMatter(deleteResult ?? '')).toBe(false);
    expect(tracker.tasks).toEqual([]);
  });
});

/*
 * Measured conversations. A `_pomiar: process-start` line marks where a new Claude Code process of that conversation
 * started (its `startedAt` from Claude Code's process registry); only conversation D has them.
 */
const DIR = join(import.meta.dirname, 'fixtures/herdr/scheduled/measured');
const FILES = readdirSync(DIR).filter((name) => name.endsWith('.jsonl') && !/-\d+\.\d+\.\d+\.jsonl$/.test(name)).sort();
const linesOf = (name: string): string[] => readFileSync(join(DIR, name), 'utf8').split('\n')
  .filter((line) => line !== '');
const record = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
const blocksOf = (entry: Json): Json[] => {
  const content = record(entry['message'])?.['content'];
  return Array.isArray(content) ? content.flatMap((item) => (record(item) === null ? [] : [item as Json])) : [];
};

interface Snapshot { readonly index: number; readonly jobs: Json[] }

/** The `CronList` results of a file (paired with their call inside the file) and the ids of pending wakeups. */
function evidence(entries: readonly Json[]): { snapshots: Snapshot[]; wakeups: Set<string> } {
  const tools = new Map<string, string>();
  const snapshots: Snapshot[] = [];
  const wakeups = new Set<string>();
  entries.forEach((entry, index) => {
    if (entry['type'] === 'api-request-blob') return;
    for (const block of blocksOf(entry)) {
      if (block['type'] === 'tool_use') tools.set(String(block['id']), String(block['name']));
      if (block['type'] !== 'tool_result') continue;
      const value = record(entry['toolUseResult']);
      const tool = tools.get(String(block['tool_use_id']));
      if (tool === 'CronList' && value !== null && Array.isArray(value['jobs'])) {
        snapshots.push({ index, jobs: value['jobs'] as Json[] });
      }
      // A wakeup is known as one only by its run (`taskKind: loop`) or by the delete that ended it.
      if (tool === 'CronDelete' && value?.['endedLoopWakeup'] === true) wakeups.add(String(value['id']));
    }
    if (entry['subtype'] === 'scheduled_task_fire' && entry['taskKind'] === 'loop') {
      wakeups.add(String(entry['taskId']));
    }
  });
  return { snapshots, wakeups };
}

interface Replay {
  /** The list right before each snapshot entry, by entry index. */
  readonly before: Map<number, readonly SessionScheduledTask[]>;
  readonly after: Map<number, readonly SessionScheduledTask[]>;
  readonly end: readonly SessionScheduledTask[];
}

function replay(name: string, options: { processStarts?: boolean; prefilter?: boolean } = {}): Replay {
  const tracker = createScheduledTasksTracker();
  const entries = linesOf(name).map((line) => JSON.parse(line) as Json);
  const { snapshots } = evidence(entries);
  const points = new Set(snapshots.map((snapshot) => snapshot.index));
  const before = new Map<number, readonly SessionScheduledTask[]>();
  const after = new Map<number, readonly SessionScheduledTask[]>();
  linesOf(name).forEach((line, index) => {
    const entry = entries[index] as Json;
    if (entry['_pomiar'] === 'process-start') {
      if (options.processStarts !== false) tracker.processStarted(Number(entry['startedAt']));
      return;
    }
    if (points.has(index)) before.set(index, tracker.tasks);
    if (options.prefilter !== true || tracker.mayMatter(line)) tracker.note(entry);
    if (points.has(index)) after.set(index, tracker.tasks);
  });
  return { before, after, end: tracker.tasks };
}

const END: Record<string, string[]> = {
  'after-clear.jsonl': [],
  // Nothing in this conversation's excerpt deletes the recurring task created after the resume.
  'exit-resume.jsonl': ['7d79c741'],
  'loop-wakeup-carry.jsonl': [],
  'recurring-one-shot-compact.jsonl': [],
  'resume-missed-one-shot.jsonl': [],
};

describe('scheduled tasks: measured conversations (CLI 2.1.329)', () => {
  it('reads every conversation', () => {
    expect(FILES).toEqual(Object.keys(END).sort());
  });

  it.each(FILES)('%s: the list equals every CronList snapshot where it was taken', (name) => {
    const entries = linesOf(name).map((line) => JSON.parse(line) as Json);
    const { snapshots, wakeups } = evidence(entries);
    expect(snapshots.length).toBeGreaterThan(0);
    const { before, after } = replay(name);
    for (const { index, jobs } of snapshots) {
      const cron = jobs.filter((job) => !wakeups.has(String(job['id'])));
      const expected = cron.map((job) => ({ id: job['id'], recurring: job['recurring'] === true })).sort((a, b) =>
        String(a.id).localeCompare(String(b.id)));
      const seen = (before.get(index) ?? []).map((task) => ({ id: task.id, recurring: task.recurring }))
        .sort((a, b) => a.id.localeCompare(b.id));
      expect(seen, `${name}: entry ${index + 1}`).toEqual(expected);
      for (const task of after.get(index) ?? []) {
        const job = cron.find((item) => item['id'] === task.id);
        const listedAt = new Date(Number(job?.['nextFireAt'])).toISOString();
        expect(task.nextFireAt, `${name}: entry ${index + 1}`).toBe(listedAt);
      }
    }
  });

  it.each(FILES)('%s: the list at the end of the excerpt', (name) => {
    expect(replay(name).end.map((task) => task.id)).toEqual(END[name]);
  });

  it.each(FILES)('%s: the prefilter keeps every line that matters', (name) => {
    const plain = replay(name);
    const filtered = replay(name, { prefilter: true });
    expect(filtered.end).toEqual(plain.end);
    expect([...filtered.before]).toEqual([...plain.before]);
  });

  it('the one-shot missed while the process was down is gone before the session looks, by the process start', () => {
    const name = 'resume-missed-one-shot.jsonl';
    const entries = linesOf(name).map((line) => JSON.parse(line) as Json);
    const { snapshots } = evidence(entries);
    const empty = snapshots.find(({ jobs }) => jobs.length === 0);
    expect(empty).toBeDefined();
    const index = empty?.index ?? -1;
    expect(replay(name).before.get(index)).toEqual([]);
    // Without the process start the missed task would still be listed there; the snapshot alone would hide this.
    expect(replay(name, { processStarts: false }).before.get(index)?.map((task) => task.id)).toEqual(['38a8a967']);
  });

  it('the file `/clear` opens starts with the carry of the armed task', () => {
    const first = JSON.parse(linesOf('after-clear.jsonl')[0] ?? '{}') as Json;
    expect(record(first['attachment'])?.['type']).toBe('session_cron_carry');
    const tracker = createScheduledTasksTracker();
    tracker.note(first);
    expect(ids(tracker)).toEqual(['9bc70ce1']);
  });
});
