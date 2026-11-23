/**
 * The CLI prompt queue counted from the conversation file: `herdr/jsonl-queue.ts` and its read on the follower
 * (`cliQueue()` in `herdr/jsonl-follow.ts`). Synthetic entries cover the rules; the measured fixtures
 * (`fixtures/herdr/queue/measured/`, `fixtures/herdr/tasks/measured/`, `fixtures/consent-dowod/`) pin them to what
 * Claude Code wrote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug } from '../src/cli-store.ts';
import { TRUNCATED_MESSAGE, createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { parseJsonlEntry } from '../src/herdr/jsonl-pending.ts';
import { CLI_QUEUE_POPS_KEPT, createCliQueueTracker, popsSince } from '../src/herdr/jsonl-queue.ts';
import type { CliQueueRead, CliQueueTracker } from '../src/herdr/jsonl-queue.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const NOTE = '<task-notification>\n<task-id>b00000001</task-id>\n<status>completed</status>\n</task-notification>';

const enqueue = (content?: string): Record<string, unknown> => ({
  type: 'queue-operation', operation: 'enqueue', ...(content === undefined ? {} : { content }),
});
const dequeue = (): Record<string, unknown> => ({ type: 'queue-operation', operation: 'dequeue' });
const remove = (content: string): Record<string, unknown> => ({
  type: 'queue-operation', operation: 'remove', content, reason: 'absorbed_mid_turn',
});
const popAll = (content: string): Record<string, unknown> => ({ type: 'queue-operation', operation: 'popAll', content });
const turnEnd = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'system', subtype: 'turn_duration', isSidechain: false, ...extra,
});

const fed = (...entries: Record<string, unknown>[]): CliQueueTracker => {
  const tracker = createCliQueueTracker();
  for (const entry of entries) tracker.note(entry);
  return tracker;
};

const fixtureEntries = (path: string): unknown[] =>
  readFileSync(join(FIXTURES, path), 'utf8').split('\n').map(parseJsonlEntry).filter((entry) => entry !== null);

const isQueueStep = (entry: unknown): boolean => {
  const record = entry as Record<string, unknown>;
  return record['type'] === 'queue-operation' || record['subtype'] === 'turn_duration';
};

/** The read after every queue entry and turn end of a fixture, labelled with the operation. */
const replay = (path: string, tracker = createCliQueueTracker()): { step: string; read: CliQueueRead }[] =>
  fixtureEntries(path).filter(isQueueStep).map((entry) => {
    tracker.note(entry);
    const record = entry as Record<string, unknown>;
    return { step: String(record['operation'] ?? record['subtype']), read: tracker.prompts() };
  });

describe('CLI queue tracker: rules', () => {
  it('two enqueues give both prompts in queue order', () => {
    expect(fed(enqueue('A'), enqueue('B')).prompts()).toEqual(['A', 'B']);
  });

  it('a remove of an absorbed prompt takes that prompt only', () => {
    expect(fed(enqueue('A'), enqueue('B'), remove('A')).prompts()).toEqual(['B']);
  });

  it('popAll of both prompts empties the queue and keeps it known', () => {
    const tracker = fed(enqueue('A'), enqueue('B'), popAll('A'));
    expect(tracker.prompts()).toEqual(['B']);
    tracker.note(popAll('B'));
    expect(tracker.prompts()).toEqual([]);
  });

  it('a contentless dequeue takes the first prompt', () => {
    expect(fed(enqueue('A'), enqueue('B'), dequeue()).prompts()).toEqual(['B']);
  });

  it('a task notification and an empty enqueue stay outside the prompts', () => {
    expect(fed(enqueue(NOTE), enqueue(), enqueue('')).prompts()).toEqual([]);
    expect(fed(enqueue(NOTE), enqueue('A')).prompts()).toEqual(['A']);
  });

  it('the dequeue of a notification does not take a prompt queued after it', () => {
    expect(fed(enqueue(NOTE), dequeue(), enqueue('A')).prompts()).toEqual(['A']);
    expect(fed(enqueue(), dequeue(), enqueue('A')).prompts()).toEqual(['A']);
  });

  it('the remove of a notification takes its placeholder, never a prompt', () => {
    const tracker = fed(enqueue(NOTE), enqueue('A'), remove(NOTE));
    expect(tracker.prompts()).toEqual(['A']);
    tracker.note(dequeue());
    expect(tracker.prompts()).toEqual([]);
  });

  it('a fresh tracker knows an empty queue; lose() makes it unknown', () => {
    const tracker = createCliQueueTracker();
    expect(tracker.prompts()).toEqual([]);
    tracker.note(enqueue('A'));
    tracker.lose();
    expect(tracker.prompts()).toBe('unknown');
  });

  it('an unknown queue stays unknown through queue entries and is known again at the main-thread turn end', () => {
    const tracker = createCliQueueTracker();
    tracker.lose();
    for (const entry of [enqueue('A'), dequeue(), popAll('A'), remove('B'), turnEnd({ isSidechain: true })]) {
      tracker.note(entry);
      expect(tracker.prompts()).toBe('unknown');
    }
    tracker.note(turnEnd());
    expect(tracker.prompts()).toEqual([]);
    tracker.note(enqueue('C'));
    expect(tracker.prompts()).toEqual(['C']);
  });

  it('a turn end clears leftovers, so a later dequeue takes the new prompt', () => {
    expect(fed(enqueue(NOTE), turnEnd(), enqueue('A'), dequeue()).prompts()).toEqual([]);
  });

  it('a contradiction in a known queue makes it unknown', () => {
    expect(fed(enqueue('A'), remove('B')).prompts()).toBe('unknown');
    expect(fed(enqueue('A'), popAll('B')).prompts()).toBe('unknown');
    expect(fed(dequeue()).prompts()).toBe('unknown');
    expect(fed(enqueue('A'), { type: 'queue-operation', operation: 'clear' }).prompts()).toBe('unknown');
  });

  it('other entries change nothing', () => {
    const tracker = fed(enqueue('A'));
    for (const entry of [null, 'text', { type: 'user', message: { role: 'user', content: 'A' } }]) tracker.note(entry);
    expect(tracker.prompts()).toEqual(['A']);
  });

  it('the read is a copy', () => {
    const tracker = fed(enqueue('A'));
    const read = tracker.prompts() as string[];
    read.push('B');
    expect(tracker.prompts()).toEqual(['A']);
  });
});

describe('CLI queue tracker: measured fixtures', () => {
  it('dwa-naraz: two prompts, two dequeues one after another', () => {
    expect(replay('herdr/queue/measured/dwa-naraz.jsonl')).toEqual([
      { step: 'enqueue', read: ['pomiar B: ok'] },
      { step: 'enqueue', read: ['pomiar B: ok', 'pomiar C: ok'] },
      { step: 'dequeue', read: ['pomiar C: ok'] },
      { step: 'dequeue', read: [] },
      { step: 'turn_duration', read: [] },
      { step: 'turn_duration', read: [] },
    ]);
  });

  it('compact: the `/compact` enqueue without content and its dequeue stay outside the prompts', () => {
    expect(replay('herdr/queue/measured/compact.jsonl').map(({ read }) => read)).toEqual([[], [], [], []]);
  });

  it('wchloniecie: the prompt absorbed mid-turn leaves with its remove', () => {
    expect(replay('herdr/queue/measured/wchloniecie.jsonl')).toEqual([
      { step: 'enqueue', read: ['pomiar B: ok'] },
      { step: 'remove', read: [] },
      { step: 'turn_duration', read: [] },
    ]);
  });

  it.each(['zabranie', 'zabranie-szeroki'])('%s: up takes both prompts back with popAll', (name) => {
    expect(replay(`herdr/queue/measured/${name}.jsonl`)).toEqual([
      { step: 'enqueue', read: ['pomiar B: ok'] },
      { step: 'enqueue', read: ['pomiar B: ok', 'pomiar C: ok'] },
      { step: 'popAll', read: ['pomiar C: ok'] },
      { step: 'popAll', read: [] },
      { step: 'turn_duration', read: [] },
    ]);
  });

  it('zabranie-dlugie: three long prompts, three popAll entries', () => {
    const steps = replay('herdr/queue/measured/zabranie-dlugie.jsonl');
    expect(steps.map(({ step }) => step)).toEqual(['enqueue', 'enqueue', 'enqueue', 'popAll', 'popAll', 'popAll',
      'turn_duration']);
    expect((steps[2]?.read as string[]).length).toBe(3);
    expect(steps.slice(5).map(({ read }) => read)).toEqual([[], []]);
  });

  it('zabranie-meldunek: popAll takes the prompt, the notification leaves later with its own remove', () => {
    expect(replay('herdr/queue/measured/zabranie-meldunek.jsonl')).toEqual([
      { step: 'enqueue', read: [] },
      { step: 'enqueue', read: ['pomiar B: ok'] },
      { step: 'popAll', read: [] },
      { step: 'remove', read: [] },
      { step: 'turn_duration', read: [] },
    ]);
  });

  it('postoj: notifications delivered by dequeue and remove never enter the prompts and the queue stays known', () => {
    const steps = replay('herdr/tasks/measured/postoj.jsonl');
    expect(steps.filter(({ step }) => step === 'dequeue')).toHaveLength(2);
    expect(steps.filter(({ step }) => step === 'remove')).toHaveLength(1);
    for (const { read } of steps) expect(read).toEqual([]);
  });

  it('resume-cli: the notification left by the exited CLI process does not shadow a later prompt', () => {
    const tracker = createCliQueueTracker();
    replay('herdr/tasks/measured/resume-cli.jsonl', tracker);
    tracker.note(enqueue('A'));
    tracker.note(dequeue());
    expect(tracker.prompts()).toEqual([]);
  });

  it('background-stop (CLI 2.1.319): the CLI message about a stopped agent counts as a prompt until its dequeue', () => {
    const steps = replay('consent-dowod/background-stop-1.glowny.jsonl');
    expect(steps.slice(2, 5)).toEqual([
      { step: 'enqueue', read: ['Background agent "Zapis pliku m8s-1" was stopped by the user.'] },
      { step: 'dequeue', read: ['Background agent "Zapis pliku m8s-1" was stopped by the user.'] },
      { step: 'dequeue', read: [] },
    ]);
  });

  it.each([
    'queue/measured/dequeue.jsonl', 'queue/measured/esc-nad-kolejka.jsonl', 'queue/measured/esc-w-tekscie.jsonl',
    'queue/measured/kolejka-przed-startem.jsonl', 'queue/measured/zabranie-wyscig-koniec.jsonl',
    'queue/measured/zabranie-wyscig-wynik.jsonl', 'tasks/measured/taskoutput-w-postoju.jsonl',
    'tasks/measured/wznowienie.jsonl',
  ])('%s: the queue ends known and empty, without a contradiction on the way', (path) => {
    const steps = replay(`herdr/${path}`);
    expect(steps.length).toBeGreaterThan(0);
    for (const { read } of steps) expect(read).not.toBe('unknown');
    expect(steps.at(-1)?.read).toEqual([]);
  });
});

vi.setConfig({ testTimeout: 20_000 });

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };

describe('CLI queue tracker: popAll entries since a mark', () => {
  it('gives the popAll texts noted after the mark, in file order, one item per entry', () => {
    const tracker = fed(enqueue('A'), enqueue('A'), enqueue('B'));
    const mark = tracker.pops();
    tracker.note(popAll('A'));
    tracker.note(popAll('A'));
    expect(popsSince(mark, tracker.pops())).toEqual(['A', 'A']);
    tracker.note(popAll('B'));
    expect(popsSince(mark, tracker.pops())).toEqual(['A', 'A', 'B']);
    expect(tracker.prompts()).toEqual([]);
  });

  it('nothing after the mark is an empty list; a remove or a dequeue is no popAll', () => {
    const tracker = fed(enqueue('A'), enqueue('B'));
    const mark = tracker.pops();
    tracker.note(remove('A'));
    tracker.note(dequeue());
    expect(popsSince(mark, tracker.pops())).toEqual([]);
  });

  it('a popAll in an unknown queue still counts, so the mark sees it', () => {
    const tracker = createCliQueueTracker();
    tracker.lose();
    const mark = tracker.pops();
    tracker.note(popAll('A'));
    expect(popsSince(mark, tracker.pops())).toEqual(['A']);
  });

  it('a loss after the mark, another tracker or more entries than kept is unknown', () => {
    const tracker = fed(enqueue('A'));
    const mark = tracker.pops();
    tracker.note(popAll('A'));
    tracker.lose();
    expect(popsSince(mark, tracker.pops())).toBe('unknown');
    expect(popsSince(mark, createCliQueueTracker().pops())).toBe('unknown');
    const busy = createCliQueueTracker();
    const early = busy.pops();
    for (let i = 0; i <= CLI_QUEUE_POPS_KEPT; i += 1) busy.note(popAll(`P${String(i)}`));
    expect(popsSince(early, busy.pops())).toBe('unknown');
  });

  it('zabranie: the two popAll entries after `up` are the two queued prompts', () => {
    const tracker = createCliQueueTracker();
    const entries = fixtureEntries('herdr/queue/measured/zabranie-2.1.328.jsonl');
    const up = entries.findIndex((entry) => (entry as Record<string, unknown>)['_pomiar'] === 'up');
    for (const entry of entries.slice(0, up)) tracker.note(entry);
    const mark = tracker.pops();
    for (const entry of entries.slice(up)) tracker.note(entry);
    expect(popsSince(mark, tracker.pops())).toEqual(['pomiar B: ok', 'pomiar C: ok']);
  });
});

describe('follower: cliQueue()', () => {
  let root = '';
  let dir = '';
  const followers: JsonlFollower[] = [];
  const events: unknown[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarog-follow-queue-'));
    dir = join(root, projectSlug(CWD));
    await mkdir(dir, { recursive: true });
    events.length = 0;
  });

  afterEach(async () => {
    for (const follower of followers.splice(0)) follower.close();
    await rm(root, { recursive: true, force: true });
  });

  const filePath = (): string => join(dir, `${SESSION}.jsonl`);
  const line = (entry: Record<string, unknown>): string =>
    `${JSON.stringify({ sessionId: SESSION, timestamp: '2026-11-19T10:00:00.000Z', ...entry })}\n`;
  const userText = (text: string): string =>
    line({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
  const createTranscript = async (content: string): Promise<void> => {
    await writeFile(`${filePath()}.partial`, content);
    await rename(`${filePath()}.partial`, filePath());
  };
  const start = (extra: Record<string, unknown> = {}): JsonlFollower => {
    const follower = createJsonlFollower({
      cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING, ...extra,
    });
    followers.push(follower);
    void (async () => {
      for await (const event of follower.events) events.push(event);
    })();
    return follower;
  };
  const waitFor = async (read: () => CliQueueRead | undefined, expected: CliQueueRead): Promise<void> => {
    await vi.waitFor(() => expect(read()).toEqual(expected), { timeout: 10_000, interval: 4 });
  };

  it('readNow() reads the tail without waiting for the stat tick, and the popAll entries count from a mark', async () => {
    await createTranscript(userText('first') + line(enqueue('A')) + line(enqueue('B')));
    const follower = start({ timing: { ...TIMING, statTickMs: 600_000 } });
    await waitFor(() => follower.cliQueue?.(), ['A', 'B']);
    const mark = follower.cliQueuePops?.();
    await appendFile(filePath(), line(popAll('A')) + line(popAll('B')));
    // Two calls at once: the second one resolves only after a read that began after it, not with the read in flight.
    await Promise.all([follower.readNow?.(), follower.readNow?.()]);
    expect(follower.cliQueue?.()).toEqual([]);
    expect(mark === undefined ? 'no mark' : popsSince(mark, follower.cliQueuePops?.() ?? mark)).toEqual(['A', 'B']);
  });

  it('claimEcho() takes the window entry of a taken-back prompt: own text first, then the joined field text', () => {
    const follower = start();
    follower.dropEcho('pomiar B: ok', 'tok-b');
    follower.dropEcho('pomiar C: ok', 'tok-c');
    follower.joinEcho('tok-c', 'szkic pomiar C: ok');
    expect(follower.claimEcho?.('pomiar B: ok')).toBe('tok-b');
    expect(follower.claimEcho?.('pomiar B: ok')).toBeUndefined();
    expect(follower.claimEcho?.('szkic  pomiar C: ok')).toBe('tok-c');
    expect(follower.claimEcho?.('pomiar C: ok')).toBeUndefined();
  });

  it('is unknown before the first read, then counts from the whole file and follows the tail', async () => {
    const follower = start();
    expect(follower.cliQueue?.()).toBe('unknown');
    await createTranscript(userText('first') + line(enqueue('A')) + line(enqueue('B')));
    await waitFor(() => follower.cliQueue?.(), ['A', 'B']);
    await appendFile(filePath(), line(dequeue()));
    await waitFor(() => follower.cliQueue?.(), ['B']);
  });

  it('is unknown after a history window that starts mid-file, until the turn end', async () => {
    const pad = 'x'.repeat(400);
    await createTranscript(
      line(enqueue('early')) + userText(`one ${pad}`) + userText(`two ${pad}`) + userText(`three ${pad}`),
    );
    const follower = start({ historyBytes: 256, historyMessages: 1 });
    await appendFile(filePath(), line(enqueue('A')) + userText('marker'));
    // The marker message proves the tail past `enqueue('A')` was read, so `unknown` is the count, not "not read yet".
    await vi.waitFor(() => expect(JSON.stringify(events)).toContain('marker'), { timeout: 10_000, interval: 4 });
    expect(follower.cliQueue?.()).toBe('unknown');
    await appendFile(filePath(), line(turnEnd()) + line(enqueue('C')));
    await waitFor(() => follower.cliQueue?.(), ['C']);
  });

  it('is unknown after a read gap and after a truncation that keeps content', async () => {
    await createTranscript(userText('first') + line(enqueue('A')));
    const follower = start({ maxReadBytes: 512 });
    await waitFor(() => follower.cliQueue?.(), ['A']);
    await appendFile(filePath(), userText('y'.repeat(2000)) + line(enqueue('B')));
    await waitFor(() => follower.cliQueue?.(), 'unknown');
    await appendFile(filePath(), line(turnEnd()));
    await waitFor(() => follower.cliQueue?.(), []);
    await truncate(filePath(), 10);
    await waitFor(() => follower.cliQueue?.(), 'unknown');
  });

  it('is unknown after a truncation to zero, because the running CLI may still hold a prompt, until the turn end',
    async () => {
      await createTranscript(userText('first') + line(enqueue('A')));
      const follower = start();
      await waitFor(() => follower.cliQueue?.(), ['A']);
      await truncate(filePath(), 0);
      // The truncation notice proves the follower handled the cut, so the read below is the count after it.
      await vi.waitFor(() => expect(JSON.stringify(events)).toContain(JSON.stringify(TRUNCATED_MESSAGE)),
        { timeout: 10_000, interval: 4 });
      expect(follower.cliQueue?.()).toBe('unknown');
      await appendFile(filePath(), line(enqueue('B')) + userText('marker'));
      await vi.waitFor(() => expect(JSON.stringify(events)).toContain('marker'), { timeout: 10_000, interval: 4 });
      expect(follower.cliQueue?.()).toBe('unknown');
      await appendFile(filePath(), line(turnEnd()) + line(enqueue('C')));
      await waitFor(() => follower.cliQueue?.(), ['C']);
    });
});
