/**
 * The follower's lookup of a transcript file it has not found yet (`lookUpTranscript` in `herdr/jsonl-follow.ts`):
 * a request looks the file up at once instead of at the next retry, repeated requests share one retry chain, and
 * until a lookup that began after the request ends, `hasTranscript()` does not answer the "no" of an earlier one.
 *
 * A separate file, because it wraps `readdir` of `node:fs/promises`: a lookup that misses the file under the slug
 * reads the store root, so the tests count those reads and can hold one in flight.
 */
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';

/** Reads of the store root: their number, a gate that holds the next one, and a probe run after it ends. */
const rootReads: {
  root: string; count: number; gate: Promise<void> | null; after: (() => void) | null;
} = { root: '', count: 0, gate: null, after: null };

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readdir: async (...args: Parameters<typeof real.readdir>) => {
      if (String(args[0]) !== rootReads.root) return real.readdir(...args);
      rootReads.count += 1;
      const gate = rootReads.gate;
      rootReads.gate = null;
      if (gate !== null) await gate;
      const entries = await real.readdir(...args);
      const after = rootReads.after;
      rootReads.after = null;
      after?.();
      return entries;
    },
  };
});

const { createJsonlFollower } = await import('../src/herdr/jsonl-follow.ts');
const { projectSlug } = await import('../src/cli-store.ts');

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
/** The slow retry is ten minutes: a test that finds the file did not wait for it. */
const TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 600_000 };

let root = '';
let now = 1_000_000;
const followers: JsonlFollower[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-lookup-'));
  await mkdir(join(root, projectSlug(CWD)), { recursive: true });
  Object.assign(rootReads, { root, count: 0, gate: null, after: null });
  now = 1_000_000;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const follower of followers.splice(0)) follower.close();
  await rm(root, { recursive: true, force: true });
});

const filePath = (): string => join(root, projectSlug(CWD), `${SESSION}.jsonl`);

/** Atomic create (write next to it, then `rename`): a lookup sees no file or the whole file. */
const createTranscript = async (content: string): Promise<void> => {
  const tmp = `${filePath()}.partial`;
  await writeFile(tmp, content);
  await rename(tmp, filePath());
};

const userLine = (text: string): string => `${JSON.stringify({
  type: 'user', message: { role: 'user', content: text }, isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z', sessionId: SESSION,
})}\n`;

/** An `assistant` entry with a `tool_use` that has no result yet. */
const toolUseLine = (id: string): string => `${JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: '2026-08-22T10:00:06.000Z', sessionId: SESSION,
  message: {
    role: 'assistant', model: 'claude-fable-5',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }],
  },
})}\n`;

const start = (opts: { agentSessionId?: string; timing?: typeof TIMING } = {}): {
  follower: JsonlFollower; events: FollowEvent[];
} => {
  const follower = createJsonlFollower({
    cwd: CWD, agentSessionId: opts.agentSessionId ?? SESSION, root, watch: false, timing: opts.timing ?? TIMING,
    now: () => now,
  });
  followers.push(follower);
  const events: FollowEvent[] = [];
  void (async () => {
    for await (const event of follower.events) events.push(event);
  })();
  return { follower, events };
};

/** Polls on `setImmediate`, which the fake timers below leave real. */
const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const pendingIds = (events: readonly FollowEvent[]): (string | undefined)[] => events
  .filter((e): e is Extract<FollowEvent, { type: 'pending' }> => e.type === 'pending')
  .map((e) => e.pending?.id);

/** The first lookup missed and the fast window passed, so the next retry is the slow one. */
async function staleNo(follower: JsonlFollower): Promise<void> {
  await waitFor(() => follower.hasTranscript() === 'no', 'first lookup missed');
  now += TIMING.missingWindowMs * 5;
  const seen = rootReads.count;
  await waitFor(() => rootReads.count > seen, 'last fast retry');
  await waitFor(() => follower.hasTranscript() === 'no', 'last fast retry missed');
}

describe('lookup of a transcript file not found yet', () => {
  it('a request finds a file created after the fast window without waiting for the slow retry', async () => {
    const { follower, events } = start();
    await staleNo(follower);
    await createTranscript(userLine('run it') + toolUseLine('toolu_1'));

    follower.lookUpTranscript?.();
    expect(follower.hasTranscript()).toBe('unknown');
    await waitFor(() => pendingIds(events).includes('toolu_1'), 'pending from the file');
    expect(follower.hasTranscript()).toBe('yes');
  });

  it('`expectTranscript()` looks the file up at once too', async () => {
    const { follower, events } = start();
    await staleNo(follower);
    await createTranscript(userLine('run it') + toolUseLine('toolu_1'));

    follower.expectTranscript();
    await waitFor(() => pendingIds(events).includes('toolu_1'), 'pending from the file');
  });

  it('repeated requests share one retry chain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { follower } = start({ timing: { ...TIMING, missingWindowMs: 0 } });
    await waitFor(() => follower.hasTranscript() === 'no', 'first lookup missed');
    // The batch timer of the first payout; what stays is the slow retry.
    vi.advanceTimersByTime(TIMING.batchMs);
    expect(vi.getTimerCount()).toBe(1);
    const reads = rootReads.count;

    for (let i = 0; i < 5; i += 1) follower.lookUpTranscript?.();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(0);
    await waitFor(() => rootReads.count > reads && follower.hasTranscript() === 'no', 'requested lookup missed');
    await new Promise((resolve) => setImmediate(resolve));

    expect(rootReads.count).toBe(reads + 1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a lookup that began before the request does not answer it with "no"', async () => {
    let release = (): void => undefined;
    rootReads.gate = new Promise((resolve) => { release = resolve; });
    const { follower, events } = start();
    await waitFor(() => rootReads.count === 1, 'first lookup reads the store root');
    await createTranscript(userLine('run it') + toolUseLine('toolu_1'));

    follower.lookUpTranscript?.();
    // Read once the first lookup has ended and before any timer of the follower runs.
    let atEnd = '';
    rootReads.after = () => { setImmediate(() => { atEnd = follower.hasTranscript(); }); };
    release();
    await waitFor(() => atEnd !== '', 'first lookup ended');
    expect(atEnd).not.toBe('no');
    await waitFor(() => pendingIds(events).includes('toolu_1'), 'pending from the file');
  });

  it('a request made during the lookup that finds the file does not speed up the retries of a failed read', async () => {
    // The file sits under another project folder, so the lookup reads the store root and the gate can hold it.
    const elsewhere = join(root, '-Users-u-Projects-demo');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, `${SESSION}.jsonl`), userLine('run it'));
    let release = (): void => undefined;
    rootReads.gate = new Promise((resolve) => { release = resolve; });
    let sizeReads = 0;
    const follower = createJsonlFollower({
      cwd: CWD, agentSessionId: SESSION, root, watch: false, now: () => now,
      timing: { ...TIMING, missingWindowMs: 0 },
      io: { sizeOf: async () => { sizeReads += 1; return null; } },
    });
    followers.push(follower);
    await waitFor(() => rootReads.count === 1, 'first lookup reads the store root');

    follower.lookUpTranscript?.();
    release();
    await waitFor(() => sizeReads >= 1, 'read of the found file failed');
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The found file answers the request; the next try is the slow retry, not one every tick.
    expect(follower.hasTranscript()).toBe('yes');
    expect(sizeReads).toBe(1);
  });

  it('a requested lookup that finds no file answers "no" again', async () => {
    const { follower } = start();
    await staleNo(follower);

    follower.lookUpTranscript?.();
    expect(follower.hasTranscript()).toBe('unknown');
    await waitFor(() => follower.hasTranscript() === 'no', 'requested lookup missed');
  });

  it('a request with the file known, or with an id that is not a session id, changes no answer', async () => {
    await createTranscript(userLine('run it'));
    const known = start();
    await waitFor(() => known.follower.hasTranscript() === 'yes', 'file found');
    known.follower.lookUpTranscript?.();
    expect(known.follower.hasTranscript()).toBe('yes');

    const invalid = start({ agentSessionId: '../escape' });
    expect(invalid.follower.hasTranscript()).toBe('no');
    invalid.follower.lookUpTranscript?.();
    expect(invalid.follower.hasTranscript()).toBe('no');
  });
});
