/**
 * The activity row from the transcript tail (`herdr/jsonl-follow.ts` with `herdr/jsonl-activity.ts`): the tool
 * description on a `tool` activity, the end of a tool call, and the precedence of the session directory pulse.
 *
 * Shapes follow the measured main transcript: every `tool_use` and every `tool_result` is its own entry, and a call
 * often opens while another one is still open. Open calls come from the follower's pending tracker; the row shows
 * the most recently opened call that is still open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Activity } from '@rarog/shared';
import { projectSlug } from '../src/cli-store.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { Scheduler } from '../src/drivers/runtime.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import {
  makeDriver, quiet as driverQuiet, toolResultLine, toolUseLine, useDriverSandbox, userLine as driverUserLine,
  waitFor as driverWaitFor,
} from './helpers/herdr-driver-atrapy.ts';

vi.setConfig({ testTimeout: 20_000 });

const CWD = '/Users/u/Projects/atlas';
const SESSION = '5c0f6a1e-3d2b-4c8e-9a71-2f4e6b8d0c13';
const TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };
/** Longer than one batch window: an event caused by a line that was already read is out by then. */
const SETTLE_MS = TIMING.batchMs * 4;

// ---------------------------------------------------------------------------
// Follower over a temporary CLI store
// ---------------------------------------------------------------------------

let root = '';
let dir = '';
const followers: JsonlFollower[] = [];

const filePath = (): string => join(dir, `${SESSION}.jsonl`);

/** Atomic write (next to the file, then `rename`): the follower sees no file or the whole content. */
const writeTranscript = async (content: string): Promise<void> => {
  await writeFile(`${filePath()}.partial`, content);
  await rename(`${filePath()}.partial`, filePath());
};

const line = (entry: Record<string, unknown>): string =>
  `${JSON.stringify({ isSidechain: false, sessionId: SESSION, timestamp: '2026-11-16T09:12:04.120Z', ...entry })}\n`;
const userText = (text: string): string => line({ type: 'user', message: { role: 'user', content: text } });
/** One `tool_use` per assistant entry: the measured shape. */
const toolUse = (id: string, name: string, input: Record<string, unknown>): string => line({
  type: 'assistant',
  message: {
    role: 'assistant', model: 'claude-opus-5-5', type: 'message',
    content: [{ type: 'tool_use', id, name, input }],
  },
});
/** One `tool_result` per user entry: the measured shape. */
const toolResult = (id: string): string => line({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  toolUseResult: { stdout: 'ok', stderr: '', interrupted: false },
});

const start = (): { follower: JsonlFollower; events: FollowEvent[] } => {
  const follower = createJsonlFollower({ cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING });
  followers.push(follower);
  const events: FollowEvent[] = [];
  void (async () => {
    for await (const event of follower.events) events.push(event);
  })();
  return { follower, events };
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

type ActivityEvent = Extract<FollowEvent, { type: 'activity' }>;
const activities = (events: readonly FollowEvent[]): ActivityEvent[] =>
  events.filter((e): e is ActivityEvent => e.type === 'activity');

/** The follower after the history of `content` and its first state payout. */
async function attached(content: string): Promise<{ follower: JsonlFollower; events: FollowEvent[] }> {
  await writeTranscript(content);
  const started = start();
  await waitFor(() => started.events.some((e) => e.type === 'history'), 'history');
  await waitFor(() => started.events.some((e) => e.type === 'artifacts'), 'first artifact list');
  return started;
}

/** Appends `text` and returns the next activity it causes. */
async function nextActivity(events: FollowEvent[], text: string): Promise<ActivityEvent | undefined> {
  const before = activities(events).length;
  await appendFile(filePath(), text);
  await waitFor(() => activities(events).length > before, 'next activity');
  await settle();
  return activities(events).at(-1);
}

/** Appends `text`, waits until the tracker holds `open` calls, and returns the activities that came out. */
async function activitiesAfter(
  follower: JsonlFollower, events: FollowEvent[], text: string, open: number,
): Promise<ActivityEvent[]> {
  const before = events.length;
  await appendFile(filePath(), text);
  await waitFor(() => follower.openToolUses?.()?.length === open, `${String(open)} open calls`);
  await settle();
  return activities(events.slice(before));
}

const BASH_A = { command: 'pnpm test server/test', description: 'Run the server tests' };
const BASH_B = { command: 'git status --short', description: 'Show the working tree status' };
const toolA: Activity = {
  kind: 'tool', toolName: 'Bash', summary: BASH_A.command, description: BASH_A.description,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-follow-activity-'));
  dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  for (const follower of followers.splice(0)) follower.close();
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `tool_use`: summary and description
// ---------------------------------------------------------------------------

describe('a `tool_use` on the tail', () => {
  it('Bash with a description: `summary` is the command, `description` the trimmed description', async () => {
    const { events } = await attached(userText('go'));
    const activity = await nextActivity(events, toolUse('toolu_a', 'Bash', {
      ...BASH_A, description: `  ${BASH_A.description}\n`,
    }));
    expect(activity).toEqual({ type: 'activity', ...toolA });
  });

  it.each([
    ['no description', {}],
    ['an empty description', { description: '' }],
    ['a whitespace-only description', { description: ' \n\t ' }],
    ['a description that is not a string', { description: 42 }],
  ])('%s: a `tool` activity without `description`', async (_label, extra) => {
    const { events } = await attached(userText('go'));
    const activity = await nextActivity(events, toolUse('toolu_a', 'Bash', { command: 'ls', ...extra }));
    expect(activity).toEqual({ type: 'activity', kind: 'tool', toolName: 'Bash', summary: 'ls' });
  });

  it('a 300-character description is cut to the summary limit, at a character boundary', async () => {
    const long = '\u{1F600}'.repeat(300);
    const { events } = await attached(userText('go'));
    const summary = (await nextActivity(events, toolUse('toolu_a', 'Bash', { command: 'x'.repeat(300) })))?.summary;
    const description = (await nextActivity(events, toolUse('toolu_b', 'Bash', { command: 'ls', description: long })))
      ?.description ?? '';
    expect([...description]).toHaveLength([...(summary ?? '')].length);
    expect(description).not.toBe(long);
    // Everything before the ellipsis is a prefix of the original: no surrogate pair is split.
    expect(long.startsWith(description.slice(0, -1))).toBe(true);
  });

  it('a tool other than Bash gets no `description`: an MCP input field of that name is the data it writes', async () => {
    const { events } = await attached(userText('go'));
    const activity = await nextActivity(events, toolUse('toolu_a', 'mcp__catalog__create_task', {
      name: 'Fix the row', description: 'The whole body of the task the call creates',
    }));
    expect(activity?.kind).toBe('tool');
    expect(activity?.toolName).toBe('mcp__catalog__create_task');
    expect(activity).not.toHaveProperty('description');
  });

  it('a delegating tool keeps its delegation summary and gets no `description`', async () => {
    const { events } = await attached(userText('go'));
    const activity = await nextActivity(events, toolUse('toolu_a', 'Agent', {
      description: 'Audit the panel', subagent_type: 'general-purpose', prompt: 'Look at the panel.',
    }));
    expect(activity).toEqual({
      type: 'activity', kind: 'tool', toolName: 'Agent', summary: 'Audit the panel', delegation: 'agents',
    });
  });
});

// ---------------------------------------------------------------------------
// `tool_result`: the end of a call
// ---------------------------------------------------------------------------

describe('a `tool_result` on the tail', () => {
  it('the result of the only open call: `thinking`', async () => {
    const { events } = await attached(userText('go'));
    await nextActivity(events, toolUse('toolu_a', 'Bash', BASH_A));
    expect(await nextActivity(events, toolResult('toolu_a'))).toEqual({ type: 'activity', kind: 'thinking' });
  });

  it('A open, then B; the result of B: the row goes back to A, with its own summary and description', async () => {
    const { follower, events } = await attached(userText('go'));
    await nextActivity(events, toolUse('toolu_a', 'Bash', BASH_A));
    await nextActivity(events, toolUse('toolu_b', 'Bash', BASH_B));
    expect(await activitiesAfter(follower, events, toolResult('toolu_b'), 1)).toEqual([{ type: 'activity', ...toolA }]);
    // Then A ends: nothing stays open.
    expect(await activitiesAfter(follower, events, toolResult('toolu_a'), 0))
      .toEqual([{ type: 'activity', kind: 'thinking' }]);
  });

  it('A open, then B; the result of A: no event (the row shows B), then `thinking` after B', async () => {
    const { follower, events } = await attached(userText('go'));
    await nextActivity(events, toolUse('toolu_a', 'Bash', BASH_A));
    await nextActivity(events, toolUse('toolu_b', 'Bash', BASH_B));
    expect(await activitiesAfter(follower, events, toolResult('toolu_a'), 1)).toEqual([]);
    expect(await activitiesAfter(follower, events, toolResult('toolu_b'), 0))
      .toEqual([{ type: 'activity', kind: 'thinking' }]);
  });

  it('the row goes back to an open delegating call with its delegation and summary', async () => {
    const { follower, events } = await attached(userText('go'));
    await nextActivity(events, toolUse('toolu_a', 'Agent', { description: 'Audit the panel', prompt: 'Look.' }));
    await nextActivity(events, toolUse('toolu_b', 'Bash', BASH_B));
    expect(await activitiesAfter(follower, events, toolResult('toolu_b'), 1)).toEqual([{
      type: 'activity', kind: 'tool', toolName: 'Agent', summary: 'Audit the panel', delegation: 'agents',
    }]);
  });

  it('a `tool_use` and its result in one batch: only `thinking` goes out', async () => {
    const { follower, events } = await attached(userText('go'));
    expect(await activitiesAfter(follower, events, toolUse('toolu_a', 'Bash', BASH_A) + toolResult('toolu_a'), 0))
      .toEqual([{ type: 'activity', kind: 'thinking' }]);
  });

  it('the result of an unknown id: no event, the open call stays on the row', async () => {
    const { follower, events } = await attached(userText('go'));
    await nextActivity(events, toolUse('toolu_a', 'Bash', BASH_A));
    expect(await activitiesAfter(follower, events, toolResult('toolu_unknown'), 1)).toEqual([]);
  });

  it('a human message closes every open call without an activity: the message replaces the row', async () => {
    const { follower, events } = await attached(userText('go'));
    await nextActivity(events, toolUse('toolu_a', 'Bash', BASH_A));
    expect(await activitiesAfter(follower, events, userText('stop, do something else'), 0)).toEqual([]);
  });

  it('results in the history read at attach: no activity', async () => {
    const { events } = await attached(userText('go')
      + toolUse('toolu_a', 'Bash', BASH_A) + toolUse('toolu_b', 'Bash', BASH_B)
      + toolResult('toolu_b') + toolResult('toolu_a'));
    await settle();
    expect(activities(events)).toEqual([]);
  });

  it('after a file truncation the call open before it is gone: the next result ends the row', async () => {
    const { events } = await attached(userText('go'));
    await nextActivity(events, toolUse('toolu_a', 'Bash', BASH_A));
    await writeFile(filePath(), userText('a'));
    await waitFor(() => events.some((e) => e.type === 'turn-input' && e.lost === true), 'truncation');

    await nextActivity(events, toolUse('toolu_b', 'Bash', BASH_B));
    // Without the reset, A would still be open and come back on the row.
    expect(await nextActivity(events, toolResult('toolu_b'))).toEqual({ type: 'activity', kind: 'thinking' });
  });
});

// ---------------------------------------------------------------------------
// The session directory pulse while a call is open
// ---------------------------------------------------------------------------

/** Steered `now()` for the silence counter; timers stay real (the follower reads real files). */
function steeredClock(): { scheduler: Scheduler; advance: (ms: number) => void } {
  let now = Date.now();
  return {
    scheduler: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
      now: () => now,
    },
    advance: (ms) => { now += ms; },
  };
}

type DriverActivity = Extract<DriverEvent, { type: 'activity' }>;
const driverActivities = (events: readonly DriverEvent[]): DriverActivity[] =>
  events.filter((e): e is DriverActivity => e.type === 'activity');

describe('the directory pulse while a tool call is open', () => {
  useDriverSandbox();

  it('generic `thinking` is not sent while a call is open, and is sent again after its result', async () => {
    const clock = steeredClock();
    const fx = await makeDriver({ transcript: driverUserLine('go'), deps: { scheduler: clock.scheduler } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });
    // The history is out: a line appended now is read on the tail, not as history.
    await driverWaitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
    await appendFile(fx.transcript, toolUseLine('toolu_a', 'Bash', { command: 'sleep 40' }));
    await driverWaitFor(() => driverActivities(fx.events).length === 1, 'tool activity');

    clock.advance(12_000);
    fx.pulse?.beat({ other: 2 });
    await driverQuiet();
    expect(driverActivities(fx.events)).toHaveLength(1);

    await appendFile(fx.transcript, toolResultLine('toolu_a'));
    await driverWaitFor(() => driverActivities(fx.events).length === 2, 'end of the call');
    clock.advance(12_000);
    fx.pulse?.beat({ other: 2 });
    await driverWaitFor(() => driverActivities(fx.events).length === 3, 'pulse after the result');
    expect(driverActivities(fx.events).at(-1)).toEqual({ type: 'activity', kind: 'thinking', elapsedSeconds: 12 });
  });

  it('the delegation pulse still goes out while the delegating call is open', async () => {
    const clock = steeredClock();
    const fx = await makeDriver({ transcript: driverUserLine('go'), deps: { scheduler: clock.scheduler } });
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 8, title: '' });
    // The history is out: a line appended now is read on the tail, not as history.
    await driverWaitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
    await appendFile(fx.transcript, toolUseLine('toolu_a', 'Agent', { description: 'Audit', prompt: 'Look.' }));
    await driverWaitFor(() => driverActivities(fx.events).length === 1, 'tool activity');

    clock.advance(30_000);
    fx.pulse?.beat({ agents: 1 });
    await driverWaitFor(() => driverActivities(fx.events).length === 2, 'delegation pulse');
    expect(driverActivities(fx.events).at(-1)).toMatchObject({ kind: 'tool', agents: 1, delegation: 'agents' });
  });
});
