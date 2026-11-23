/**
 * PR status module (`server/src/pr-status/`): the `gh` source and the tracker, played against a fake `gh` process
 * (`helpers/atrapa-gh.mjs`) that records argv, stdin and env of every call.
 *
 * Time runs on a manual scheduler: a timer fires only when the test moves the clock, and every `gh` call is awaited
 * before the clock moves on. Rows of the server case table that need the session manager (demo, the driver paying out
 * the list again, `/clear` during a query, the `session-changed` frame) are tested where the module is wired in.
 *
 * The tests start processes: run them outside the sandbox.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PullRequestState } from '@rarog/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import {
  FAILURE_PAUSE_MS, GH_ARGV, GH_DIRECTORIES, GH_OUTPUT_CAP_BYTES, GH_TIMEOUT_MS, NEW_URL_DELAY_MS, OPEN_REFRESH_MS,
  PR_BATCH_MAX, PR_STATUS_ENV_PASSTHROUGH, RATE_LIMIT_PAUSE_MAX_MS, UNKNOWN_REFRESH_MS, buildQueryBody, createFixedPrStateSource,
  createGhSource, createPrStatusTracker, findGh, ghCandidates, ghEnv, parsePrUrl, readGhOutput,
} from '../src/pr-status/index.ts';
import type { PrReadResult, PrRef, PrStateSource, PrStatusTracker } from '../src/pr-status/index.ts';

const ATRAPA = fileURLToPath(new URL('./helpers/atrapa-gh.mjs', import.meta.url));
const T0 = Date.parse('2026-11-12T18:00:00Z');
const MIN = 60_000;
/** Call limit of the timeout tests: long enough for the fake to start and record itself on a loaded machine. */
const SHORT_TIMEOUT_MS = 2_000;

const url = (n: number, repo = 'widget'): string => `https://github.com/acme/${repo}/pull/${n}`;
const key = (n: number, repo = 'widget'): string => `acme/${repo}#${n}`;

/** Timers fire only when the test moves the clock; `now()` is wall time (the tracker compares it with `resetAt`). */
class ManualScheduler implements Scheduler {
  t = T0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.#seq += 1;
    this.#timers.set(this.#seq, { at: this.t + Math.max(0, ms), fn });
    return this.#seq;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  now(): number {
    return this.t;
  }

  /** Fires the earliest timer due by `target` (moving the clock to it); `false` when none is due. */
  fireNext(target: number): boolean {
    let next: [number, { at: number; fn: () => void }] | undefined;
    for (const entry of this.#timers) if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) next = entry;
    if (next === undefined) return false;
    this.#timers.delete(next[0]);
    this.t = Math.max(this.t, next[1].at);
    next[1].fn();
    return true;
  }

  get pending(): number {
    return this.#timers.size;
  }
}

/** Base environment of the server: the passthrough names plus names that must never reach `gh`. */
function baseEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home, USER: 'tester', LOGNAME: 'tester', LANG: 'en_US.UTF-8', TMPDIR: tmpdir(), PATH: '/usr/bin:/bin',
    RAROG_SECRET_SAMPLE: 'rarog-secret', OPENAI_API_KEY: 'sk-sample', SONIOX_API_KEY: 'soniox-sample',
    GH_TOKEN: 'gho_mustnotpass', GITHUB_TOKEN: 'ghp_mustnotpass', SHELL: '/bin/zsh', TERM: 'xterm-256color',
  };
}
const FORBIDDEN_ENV = ['RAROG_SECRET_SAMPLE', 'OPENAI_API_KEY', 'SONIOX_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN'];

interface Call {
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  pid: number;
  start: number;
  end: number | null;
}

interface Body {
  query: string;
  variables: Record<string, string | number>;
}

type Scenario = Record<string, unknown>;

interface Stand {
  readonly dir: string;
  readonly sched: ManualScheduler;
  readonly tracker: PrStatusTracker;
  readonly lines: string[];
  readonly changes: string[][];
  calls(): Call[];
  started(): { pid: number }[];
  scenario(list: Scenario[]): void;
  /** Moves the clock by `ms`, firing timers on the way and awaiting every `gh` call they start. */
  tick(ms: number): Promise<void>;
  /** Fires timers due now and awaits the calls they start, until nothing is left. */
  drain(): Promise<void>;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stand(list: Scenario[], opts: { withGh?: boolean; timeoutMs?: number; source?: PrStateSource } = {}): Stand {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-pr-status-'));
  dirs.push(dir);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  if (opts.withGh !== false) {
    writeFileSync(join(binDir, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${ATRAPA}' '${dir}' "$@"\n`, { mode: 0o755 });
  }
  const writeScenario = (next: Scenario[]): void => { writeFileSync(join(dir, 'scenario.json'), JSON.stringify(next)); };
  writeScenario(list);

  const pending: Promise<unknown>[] = [];
  const gh = createGhSource({
    env: baseEnv(join(dir, 'home')),
    directories: [join(dir, 'missing'), binDir],
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  const inner = opts.source ?? gh;
  const source: PrStateSource = {
    read: (prs, signal) => {
      const read = inner.read(prs, signal);
      pending.push(read);
      return read;
    },
  };
  const sched = new ManualScheduler();
  const lines: string[] = [];
  const changes: string[][] = [];
  const tracker = createPrStatusTracker({
    source, scheduler: sched, log: (line) => { lines.push(line); }, onChange: (urls) => { changes.push([...urls].sort()); },
  });

  const settle = async (): Promise<boolean> => {
    if (pending.length === 0) return false;
    await Promise.all(pending.splice(0));
    await new Promise((resolve) => { setImmediate(resolve); });
    return true;
  };
  const runUntil = async (target: number): Promise<void> => {
    for (;;) {
      if (await settle()) continue;
      if (!sched.fireNext(target)) break;
    }
    sched.t = Math.max(sched.t, target);
  };
  const readJsonl = <T>(name: string): T[] => {
    const file = join(dir, name);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as T);
  };
  return {
    dir, sched, tracker, lines, changes,
    calls: () => readJsonl<Call>('calls.jsonl'),
    started: () => readJsonl<{ pid: number }>('started.jsonl'),
    scenario: writeScenario,
    tick: (ms) => runUntil(sched.t + ms),
    drain: () => runUntil(sched.t),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const bodyOf = (call: Call): Body => JSON.parse(call.stdin) as Body;
/** `owner/repo#n` of every alias of a call, in alias order. */
function keysOf(call: Call): string[] {
  const { variables } = bodyOf(call);
  const keys: string[] = [];
  for (let i = 0; `o${i}` in variables; i += 1) {
    keys.push(`${String(variables[`o${i}`])}/${String(variables[`r${i}`])}#${String(variables[`n${i}`])}`);
  }
  return keys;
}

/** Ticks `total` in steps of `step`, so every periodic refresh on the way runs. */
async function tickInSteps(s: Stand, total: number, step = MIN): Promise<void> {
  for (let done = 0; done < total; done += step) await s.tick(Math.min(step, total - done));
}

describe('parsePrUrl: only the grammar the server sends', () => {
  it('splits a PR address into owner, repo and number', () => {
    expect(parsePrUrl('https://github.com/acme/widget.js/pull/42'))
      .toEqual({ url: 'https://github.com/acme/widget.js/pull/42', owner: 'acme', repo: 'widget.js', number: 42 });
  });

  it('rejects every other shape', () => {
    for (const bad of [
      'http://github.com/acme/widget/pull/1', 'https://github.com/acme/widget/pull/0',
      'https://github.com/acme/widget/pull/1/', 'https://github.com/acme/widget/pull/1234567890',
      'https://gitlab.com/acme/widget/pull/1', 'https://github.com/acme/widget/issues/1',
      'https://github.com/-acme/widget/pull/1', 'https://github.com/acme/wid get/pull/1', '',
    ]) {
      expect(parsePrUrl(bad), bad).toBeNull();
    }
  });
});

describe('gh source: program, environment and query', () => {
  it('looks for gh in the closed directory list, `~/.local/bin` under HOME', () => {
    expect(GH_DIRECTORIES).toEqual([
      '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin', '~/.local/bin',
    ]);
    expect(ghCandidates(GH_DIRECTORIES, '/srv/sample')).toEqual([
      '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh',
      '/srv/sample/.local/bin/gh',
    ]);
    expect(ghCandidates(GH_DIRECTORIES, undefined)).toHaveLength(4);
    expect(ghCandidates(GH_DIRECTORIES, 'relative/home')).toHaveLength(4);
  });

  it('takes the first executable candidate', () => {
    const seen: string[] = [];
    const exec = (path: string): boolean => { seen.push(path); return path === '/usr/bin/gh'; };
    expect(findGh({ directories: GH_DIRECTORIES, home: '/h', isExecutable: exec })).toBe('/usr/bin/gh');
    expect(seen).toEqual(['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']);
    expect(findGh({ directories: GH_DIRECTORIES, home: '/h', isExecutable: () => false })).toBeNull();
  });

  it('passes exactly the closed environment list, no server keys', () => {
    expect(PR_STATUS_ENV_PASSTHROUGH).toEqual(['HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'PATH']);
    const env = ghEnv(baseEnv('/srv/sample'));
    expect(Object.keys(env).sort()).toEqual([...PR_STATUS_ENV_PASSTHROUGH].sort());
    expect(ghEnv({ HOME: '/h', USER: '' })).toEqual({ HOME: '/h' });
  });

  it('argv names the host and reads the body from stdin; the query text carries only alias indices', () => {
    expect(GH_ARGV).toEqual(['api', 'graphql', '--hostname', 'github.com', '--input', '-']);
    const prs = [parsePrUrl(url(7)), parsePrUrl(url(9, 'gadget'))] as PrRef[];
    const body = JSON.parse(buildQueryBody(prs)) as Body;
    expect(body.variables).toEqual({ o0: 'acme', r0: 'widget', n0: 7, o1: 'acme', r1: 'gadget', n1: 9 });
    expect(body.query).toBe('query($o0:String!,$r0:String!,$n0:Int!,$o1:String!,$r1:String!,$n1:Int!)'
      + '{p0:repository(owner:$o0,name:$r0){pullRequest(number:$n0){state isDraft}} '
      + 'p1:repository(owner:$o1,name:$r1){pullRequest(number:$n1){state isDraft}} rateLimit{remaining resetAt}}');
    expect(body.query).not.toMatch(/acme|widget|gadget/);
  });

  it('limits: 50 PRs per call, 20 s, 1 MiB', () => {
    expect(PR_BATCH_MAX).toBe(50);
    expect(GH_TIMEOUT_MS).toBe(20_000);
    expect(GH_OUTPUT_CAP_BYTES).toBe(1024 * 1024);
  });
});

describe('readGhOutput: stdout decides, whatever the exit code', () => {
  const prs = [parsePrUrl(url(1)), parsePrUrl(url(2)), parsePrUrl(url(3))] as PrRef[];
  const run = (stdout: string, code: number | null = 0, stderr = ''): PrReadResult =>
    readGhOutput({ code, stdout, stderr, failure: null }, prs);

  it('maps the three states to lowercase and anything else to no state', () => {
    const result = run(JSON.stringify({
      data: { p0: { pullRequest: { state: 'MERGED' } }, p1: { pullRequest: { state: 'DRAFT' } }, p2: { pullRequest: null } },
      errors: [{ type: 'NOT_FOUND', path: ['p2', 'pullRequest'] }],
    }), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.states]).toEqual([[url(1), 'merged'], [url(2), null], [url(3), null]]);
    expect(result.limitReached).toBeUndefined();
  });

  it('an open PR with `isDraft: true` is a draft; `isDraft` never changes a merged or closed PR', () => {
    const cases: [unknown, PullRequestState | null][] = [
      [{ state: 'OPEN', isDraft: true }, 'draft'],
      [{ state: 'OPEN', isDraft: false }, 'open'],
      [{ state: 'OPEN' }, 'open'],
      [{ state: 'OPEN', isDraft: 'true' }, 'open'],
      [{ state: 'OPEN', isDraft: null }, 'open'],
      [{ state: 'MERGED', isDraft: true }, 'merged'],
      [{ state: 'CLOSED', isDraft: true }, 'closed'],
      [{ state: 'DRAFT', isDraft: true }, null],
      [{ state: 'draft' }, null],
    ];
    for (const [pullRequest, expected] of cases) {
      const result = readGhOutput(
        { code: 0, stdout: JSON.stringify({ data: { p0: { pullRequest } } }), stderr: '', failure: null }, [prs[0] as PrRef]);
      expect(result.ok && result.states.get(url(1)), JSON.stringify(pullRequest)).toBe(expected);
    }
  });

  it('stdout without a `data` object fails the whole call; exit 4 means not logged in', () => {
    expect(run('', 1)).toEqual({ ok: false, failure: 'error' });
    expect(run('{"data":null}', 1)).toEqual({ ok: false, failure: 'error' });
    expect(run('[1]', 0)).toEqual({ ok: false, failure: 'error' });
    expect(run('', 4, 'To get started with GitHub CLI, please run:  gh auth login')).toEqual({ ok: false, failure: 'not-logged-in' });
  });

  it('a rate limit error without data pauses until `resetAt` when known', () => {
    const limited = JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] });
    expect(run(limited, 1)).toEqual({ ok: false, failure: 'rate-limited', resetAt: null });
    expect(run('', 1, 'gh: API rate limit exceeded for user ID 1')).toEqual({ ok: false, failure: 'rate-limited', resetAt: null });
    const exhausted = run(JSON.stringify({
      data: { p0: { pullRequest: { state: 'OPEN' } }, rateLimit: { remaining: 0, resetAt: '2026-11-12T18:30:00Z' } },
    }));
    expect(exhausted.ok && exhausted.limitReached).toEqual({ resetAt: Date.parse('2026-11-12T18:30:00Z') });
  });
});

describe('tracker against the fake gh', () => {
  it('OPEN → open, 5 s after the first signal; argv, stdin and env of the call', async () => {
    const s = stand([{}]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS - 1);
    expect(s.calls()).toHaveLength(0);
    await s.tick(1);
    expect(s.tracker.stateOf(url(1))).toBe<PullRequestState>('open');
    expect(s.changes).toEqual([[url(1)]]);

    const [call] = s.calls();
    expect(call?.argv).toEqual(['api', 'graphql', '--hostname', 'github.com', '--input', '-']);
    expect(call?.argv.join(' ')).not.toMatch(/acme|widget/);
    const body = bodyOf(call as Call);
    expect(body.variables).toEqual({ o0: 'acme', r0: 'widget', n0: 1 });
    expect(body.query).not.toMatch(/acme|widget/);
    const expected = baseEnv(join(s.dir, 'home'));
    for (const name of PR_STATUS_ENV_PASSTHROUGH) expect(call?.env[name], name).toBe(expected[name]);
    for (const name of FORBIDDEN_ENV) expect(call?.env[name], name).toBeUndefined();
  });

  it('MERGED → merged, never asked again', async () => {
    const s = stand([{ states: { [key(1)]: 'MERGED' } }]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.tracker.stateOf(url(1))).toBe('merged');
    await tickInSteps(s, 3 * 60 * MIN, 5 * MIN);
    expect(s.calls()).toHaveLength(1);
    expect(s.sched.pending).toBe(0);
  });

  it('null alias with NOT_FOUND and exit 1: that PR has no state and is asked again after 30 min', async () => {
    const s = stand([{ states: { [key(2)]: null } }]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1), url(2)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.tracker.stateOf(url(1))).toBe('open');
    expect(s.tracker.stateOf(url(2))).toBeUndefined();
    expect(s.changes).toEqual([[url(1)]]);
    await tickInSteps(s, UNKNOWN_REFRESH_MS - MIN, 5 * MIN);
    expect(s.calls().slice(1).map(keysOf)).toEqual(Array(5).fill([key(1)]));
    await tickInSteps(s, MIN);
    expect(s.calls().at(-1)).toBeDefined();
    expect(keysOf(s.calls().at(-1) as Call)).toEqual([key(1), key(2)]);
  });

  it('no gh in the directory list: no state, zero calls until restart, one log line', async () => {
    const s = stand([{}], { withGh: false });
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await tickInSteps(s, 60 * MIN, 5 * MIN);
    s.tracker.setSessionUrls('s2', [url(2)]);
    s.tracker.setClientConnected(false);
    s.tracker.setClientConnected(true);
    await tickInSteps(s, 60 * MIN, 5 * MIN);
    expect(s.calls()).toHaveLength(0);
    expect(s.tracker.stateOf(url(1))).toBeUndefined();
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatch(/^pr-status: gh not found/);
  });

  it('exit ≠ 0 and stdout without data: no new states, every query paused 30 min (new URLs too)', async () => {
    const s = stand([{ stdout: 'not json', stderr: 'HTTP 502', exit: 1 }, {}]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.tracker.stateOf(url(1))).toBeUndefined();
    expect(s.lines).toEqual(['pr-status: gh call failed (error) for 1 PR, paused for 30 min']);
    s.tracker.setSessionUrls('s1', [url(1), url(2)]);
    await tickInSteps(s, FAILURE_PAUSE_MS - MIN);
    expect(s.calls()).toHaveLength(1);
    await tickInSteps(s, MIN);
    expect(s.calls()).toHaveLength(2);
    expect(keysOf(s.calls()[1] as Call)).toEqual([key(1), key(2)]);
    expect(s.tracker.stateOf(url(2))).toBe('open');
  });

  it('timeout: the process is killed, every query paused 30 min', async () => {
    const s = stand([{ sleepMs: 30_000 }, {}], { timeoutMs: SHORT_TIMEOUT_MS });
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    const [started] = s.started();
    expect(started).toBeDefined();
    expect(alive((started as { pid: number }).pid)).toBe(false);
    expect(s.calls()).toHaveLength(0);
    expect(s.lines).toEqual(['pr-status: gh call failed (timeout) for 1 PR, paused for 30 min']);
    await tickInSteps(s, FAILURE_PAUSE_MS - MIN);
    expect(s.started()).toHaveLength(1);
    await tickInSteps(s, MIN);
    expect(s.tracker.stateOf(url(1))).toBe('open');
  });

  it('stdout over 1 MiB fails the call', async () => {
    const s = stand([{ stdoutBytes: GH_OUTPUT_CAP_BYTES + 16 }]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.tracker.stateOf(url(1))).toBeUndefined();
    expect(s.lines).toEqual(['pr-status: gh call failed (output-cap) for 1 PR, paused for 30 min']);
  });

  it('GitHub rate limit without data: paused 1 h when `resetAt` is unknown', async () => {
    const limited = JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] });
    const s = stand([{ stdout: limited, exit: 1 }, {}]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.lines).toEqual(['pr-status: gh call failed (rate-limited) for 1 PR, paused for 60 min']);
    await tickInSteps(s, RATE_LIMIT_PAUSE_MAX_MS - MIN);
    expect(s.calls()).toHaveLength(1);
    await tickInSteps(s, MIN);
    expect(s.calls()).toHaveLength(2);
  });

  it('`rateLimit.remaining` 0: states kept, paused until `resetAt`, at most 1 h', async () => {
    const reset = new Date(T0 + NEW_URL_DELAY_MS + 10 * MIN).toISOString();
    const far = new Date(T0 + 5 * 60 * MIN).toISOString();
    const s = stand([{ rateLimit: { remaining: 0, resetAt: reset } }, { rateLimit: { remaining: 0, resetAt: far } }, {}]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.tracker.stateOf(url(1))).toBe('open');
    await tickInSteps(s, 10 * MIN - MIN);
    expect(s.calls()).toHaveLength(1);
    await tickInSteps(s, MIN);
    expect(s.calls()).toHaveLength(2);
    await tickInSteps(s, RATE_LIMIT_PAUSE_MAX_MS - MIN);
    expect(s.calls()).toHaveLength(2);
    await tickInSteps(s, MIN);
    expect(s.calls()).toHaveLength(3);
  });

  it('known open, then an error: open stays', async () => {
    const s = stand([{}, { stdout: '', stderr: 'boom', exit: 1 }]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    await s.tick(OPEN_REFRESH_MS);
    expect(s.calls()).toHaveLength(2);
    expect(s.tracker.stateOf(url(1))).toBe('open');
    expect(s.changes).toEqual([[url(1)]]);
  });

  it('not logged in, then `gh auth login`: state after the pause ends, without restart', async () => {
    const s = stand([{ stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login\n', exit: 4 }]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.lines).toEqual(['pr-status: gh call failed (not-logged-in) for 1 PR, paused for 30 min']);
    s.scenario([{ states: { [key(1)]: 'MERGED' } }]);
    await tickInSteps(s, FAILURE_PAUSE_MS - MIN);
    expect(s.tracker.stateOf(url(1))).toBeUndefined();
    await tickInSteps(s, MIN);
    expect(s.tracker.stateOf(url(1))).toBe('merged');
  });

  it('zero connected clients: zero calls; a client reads everything overdue at once', async () => {
    const s = stand([{}]);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await tickInSteps(s, 2 * 60 * MIN, 10 * MIN);
    expect(s.calls()).toHaveLength(0);
    s.tracker.setClientConnected(true);
    await s.drain();
    expect(s.calls()).toHaveLength(1);
    s.tracker.setClientConnected(false);
    await tickInSteps(s, 60 * MIN, 5 * MIN);
    expect(s.calls()).toHaveLength(1);
    s.tracker.setClientConnected(true);
    await s.drain();
    expect(s.calls()).toHaveLength(2);
  });

  it('a draft is asked again like an open PR and becomes open when GitHub says so', async () => {
    const s = stand([{ states: { [key(1)]: { state: 'OPEN', isDraft: true } } }, { states: { [key(1)]: 'OPEN' } }]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.tracker.stateOf(url(1))).toBe<PullRequestState>('draft');
    expect(s.sched.pending).toBe(1);
    await s.tick(OPEN_REFRESH_MS);
    expect(s.calls()).toHaveLength(2);
    expect(s.tracker.stateOf(url(1))).toBe('open');
    expect(s.changes).toEqual([[url(1)], [url(1)]]);
  });

  it('the same state again: no change callback; a new state: one', async () => {
    const s = stand([{}, {}, { states: { [key(1)]: 'CLOSED' } }]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    await s.tick(OPEN_REFRESH_MS);
    expect(s.calls()).toHaveLength(2);
    expect(s.changes).toEqual([[url(1)]]);
    await s.tick(OPEN_REFRESH_MS);
    expect(s.tracker.stateOf(url(1))).toBe('closed');
    expect(s.changes).toEqual([[url(1)], [url(1)]]);
  });

  it('one URL in two sessions: one query for it', async () => {
    const s = stand([{}]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('a', [url(1)]);
    s.tracker.setSessionUrls('b', [url(1), url(2), url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.calls().map(keysOf)).toEqual([[key(1), key(2)]]);
    s.tracker.dropSession('a');
    expect(s.tracker.stateOf(url(1))).toBe('open');
  });

  it('60 URLs: two calls (50 + 10), one after the other', async () => {
    const s = stand([{}]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', Array.from({ length: 60 }, (_, i) => url(i + 1)));
    await s.tick(NEW_URL_DELAY_MS);
    const calls = s.calls();
    expect(calls.map((call) => keysOf(call).length)).toEqual([50, 10]);
    expect((calls[1] as Call).start).toBeGreaterThanOrEqual((calls[0] as Call).end as number);
    expect(new Set(calls.flatMap(keysOf)).size).toBe(60);
    expect(s.changes.flat()).toHaveLength(60);
  });

  it('a signal during a query: one process, the next query after it', async () => {
    const s = stand([{ sleepMs: 300 }, {}]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    s.sched.fireNext(s.sched.t + NEW_URL_DELAY_MS);
    s.tracker.setSessionUrls('s1', [url(1), url(2)]);
    s.sched.t += NEW_URL_DELAY_MS;
    s.tracker.setClientConnected(false);
    s.tracker.setClientConnected(true);
    expect(s.sched.pending).toBe(0);
    await s.drain();
    const calls = s.calls();
    expect(calls.map(keysOf)).toEqual([[key(1)], [key(2)]]);
    expect((calls[1] as Call).start).toBeGreaterThanOrEqual((calls[0] as Call).end as number);
  });

  it('a URL gone from every list: map entry removed, no refresh', async () => {
    const s = stand([{}]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1), url(2)]);
    await s.tick(NEW_URL_DELAY_MS);
    s.tracker.setSessionUrls('s1', [url(2)]);
    expect(s.tracker.stateOf(url(1))).toBeUndefined();
    await s.tick(OPEN_REFRESH_MS);
    expect(s.calls().map(keysOf)).toEqual([[key(1), key(2)], [key(2)]]);
    s.tracker.dropSession('s1');
    expect(s.tracker.stateOf(url(2))).toBeUndefined();
    await tickInSteps(s, 60 * MIN, 5 * MIN);
    expect(s.calls()).toHaveLength(2);
    expect(s.sched.pending).toBe(0);
  });

  it('stderr and `errors[].message` with the repo name and a `gho_` token never reach the log', async () => {
    const leak = 'acme/widget gho_SAMPLETOKEN0123456789 https://github.com/acme/widget/pull/1';
    const s = stand([
      { states: { [key(1)]: null }, notFoundMessage: leak, stderr: leak },
      { stdout: JSON.stringify({ errors: [{ type: 'FORBIDDEN', message: leak }] }), stderr: leak, exit: 1 },
      { stdout: JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: leak }] }), stderr: leak, exit: 1 },
      { sleepMs: 30_000 },
    ], { timeoutMs: SHORT_TIMEOUT_MS });
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    await s.tick(NEW_URL_DELAY_MS);
    await tickInSteps(s, UNKNOWN_REFRESH_MS + FAILURE_PAUSE_MS + RATE_LIMIT_PAUSE_MAX_MS + MIN, 5 * MIN);
    expect(s.started()).toHaveLength(4);
    expect(s.lines.length).toBeGreaterThanOrEqual(3);
    for (const line of s.lines) expect(line).not.toMatch(/acme|widget|gho_|github\.com|SAMPLETOKEN/);
  });

  it('invalid URLs are never asked about', async () => {
    const s = stand([{}]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', ['https://example.com/acme/widget/pull/1', url(3)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.calls().map(keysOf)).toEqual([[key(3)]]);
  });

  it('close: the call in flight is killed and nothing changes afterwards', async () => {
    const s = stand([{ sleepMs: 30_000 }]);
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('s1', [url(1)]);
    s.sched.fireNext(s.sched.t + NEW_URL_DELAY_MS);
    for (let i = 0; i < 250 && s.started().length === 0; i += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
    s.tracker.close();
    await s.drain();
    const { pid } = s.started()[0] as { pid: number };
    // The abort resolves the read before the killed process is reaped.
    for (let i = 0; i < 250 && alive(pid); i += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(alive(pid)).toBe(false);
    expect(s.changes).toEqual([]);
    s.tracker.setSessionUrls('s1', [url(2)]);
    s.tracker.setClientConnected(true);
    expect(s.sched.pending).toBe(0);
  });
});

describe('tracker: never throws', () => {
  it('a throwing callback and a rejecting source do not stop the rhythm', async () => {
    let reads = 0;
    const source: PrStateSource = {
      read: (prs) => {
        reads += 1;
        if (reads === 1) return Promise.reject(new Error('acme/widget gho_SAMPLE'));
        return Promise.resolve({ ok: true, states: new Map(prs.map((pr) => [pr.url, 'open' as const])) });
      },
    };
    const s = stand([{}], { source });
    const sched = s.sched;
    const tracker = createPrStatusTracker({ source, scheduler: sched, onChange: () => { throw new Error('boom'); }, log: () => {} });
    tracker.setClientConnected(true);
    tracker.setSessionUrls('s1', [url(1)]);
    sched.fireNext(sched.t + NEW_URL_DELAY_MS);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(tracker.stateOf(url(1))).toBeUndefined();
    sched.fireNext(sched.t + FAILURE_PAUSE_MS);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(tracker.stateOf(url(1))).toBe('open');
    tracker.close();
  });
});

describe('fixed source (demo, review mode, frame producer)', () => {
  it('answers from its map, no state for other URLs', async () => {
    const source = createFixedPrStateSource(new Map<string, PullRequestState>([[url(1), 'merged']]));
    const result = await source.read([parsePrUrl(url(1)), parsePrUrl(url(2))] as PrRef[]);
    expect(result).toEqual({ ok: true, states: new Map([[url(1), 'merged'], [url(2), null]]) });
  });

  it('drives the tracker like gh does', async () => {
    const source = createFixedPrStateSource(new Map<string, PullRequestState>([[url(1), 'merged']]));
    const s = stand([{}], { source, withGh: false });
    s.tracker.setClientConnected(true);
    s.tracker.setSessionUrls('demo', [url(1), url(2)]);
    await s.tick(NEW_URL_DELAY_MS);
    expect(s.tracker.stateOf(url(1))).toBe('merged');
    expect(s.tracker.stateOf(url(2))).toBeUndefined();
    expect(s.changes).toEqual([[url(1)]]);
    expect(s.calls()).toHaveLength(0);
  });
});

describe('tracker: a read in flight', () => {
  /** A source whose reads stay open until the test answers them (every PR `open`). */
  function heldSource(): { source: PrStateSource; reads: string[][]; answer(): Promise<void> } {
    const reads: string[][] = [];
    const waiting: Array<() => void> = [];
    return {
      reads,
      source: {
        read: (prs) => {
          reads.push(prs.map((pr) => pr.url));
          return new Promise((resolve) => {
            waiting.push(() => { resolve({ ok: true, states: new Map(prs.map((pr) => [pr.url, 'open' as const])) }); });
          });
        },
      },
      answer: async () => {
        waiting.shift()?.();
        await new Promise((resolve) => { setImmediate(resolve); });
      },
    };
  }

  it.each([
    ['setSessionUrls', (tracker: PrStatusTracker): void => { tracker.setSessionUrls('s1', []); }],
    ['dropSession', (tracker: PrStatusTracker): void => { tracker.dropSession('s1'); }],
  ])('a URL removed by %s and added again before the answer: the old result is dropped', async (_name, remove) => {
    const held = heldSource();
    const sched = new ManualScheduler();
    const changes: string[][] = [];
    const tracker = createPrStatusTracker({
      source: held.source, scheduler: sched, log: () => {}, onChange: (urls) => { changes.push([...urls]); },
    });
    tracker.setClientConnected(true);
    tracker.setSessionUrls('s1', [url(1)]);
    expect(sched.fireNext(sched.t + NEW_URL_DELAY_MS)).toBe(true);
    expect(held.reads).toEqual([[url(1)]]);

    remove(tracker);
    tracker.setSessionUrls('s2', [url(1)]);
    await held.answer();
    expect(tracker.stateOf(url(1))).toBeUndefined();
    expect(changes).toEqual([]);

    // The new entry is asked on its own rhythm and gets the state from its own read.
    expect(sched.fireNext(sched.t + NEW_URL_DELAY_MS)).toBe(true);
    expect(held.reads).toEqual([[url(1)], [url(1)]]);
    await held.answer();
    expect(tracker.stateOf(url(1))).toBe('open');
    expect(changes).toEqual([[url(1)]]);
    tracker.close();
  });

  it('the last client disconnecting during a read: after the answer, no further reads', async () => {
    const held = heldSource();
    const sched = new ManualScheduler();
    const tracker = createPrStatusTracker({ source: held.source, scheduler: sched, log: () => {}, onChange: () => {} });
    tracker.setClientConnected(true);
    tracker.setSessionUrls('s1', [url(1)]);
    tracker.setSessionUrls('s2', [url(2)]);
    expect(sched.fireNext(sched.t + NEW_URL_DELAY_MS)).toBe(true);
    expect(held.reads).toHaveLength(1);

    tracker.setClientConnected(false);
    tracker.setSessionUrls('s3', [url(3)]);
    await held.answer();
    expect(sched.pending).toBe(0);
    expect(sched.fireNext(sched.t + UNKNOWN_REFRESH_MS * 4)).toBe(false);
    expect(held.reads).toHaveLength(1);
    tracker.close();
  });
});
