/**
 * The `gh` state source: one batched GraphQL query for up to {@link PR_BATCH_MAX} PRs, run with the user's `gh` login
 * for `github.com`. The only place in the server that starts `gh` (guard: `server/test/pr-status-granice.test.ts`).
 *
 * - program: the first executable `gh` in the closed directory list {@link GH_DIRECTORIES}, looked up once, on the
 *   first read; `execFile` without a shell;
 * - argv: fixed literals ({@link GH_ARGV}); the query body (alias indices only) and the variables (owner, repo,
 *   number) go through stdin, so repo names never stand in argv;
 * - env: only {@link PR_STATUS_ENV_PASSTHROUGH}, so no server key reaches the process;
 * - ceilings: {@link GH_TIMEOUT_MS} with `SIGKILL`, {@link GH_OUTPUT_CAP_BYTES} of stdout and of stderr.
 *
 * stdout decides whatever the exit code: `gh` exits 1 when one alias is not found, but still prints `data` for the
 * others. Nothing here throws, and nothing from stderr or `errors[].message` leaves this file.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { PullRequestState } from '@rarog/shared';
import { PR_STATUS_ENV_PASSTHROUGH } from '../config-env.ts';
import type { PrReadResult, PrRef, PrStateSource } from './source.ts';

/**
 * Where `gh` is looked for, in this order; `~/` is the server's `HOME`. A closed list of absolute paths, no `PATH`
 * search: the server's `PATH` is minimal, and Homebrew on an Intel Mac, linuxbrew and `~/.local/bin` are not on it.
 */
export const GH_DIRECTORIES: readonly string[] = [
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin', '~/.local/bin',
];

/** The only host asked; GitHub Enterprise hosts are out of scope. */
export const GH_HOST = 'github.com';

/** Arguments of every call: GraphQL against {@link GH_HOST}, the request body from stdin. */
export const GH_ARGV: readonly string[] = ['api', 'graphql', '--hostname', GH_HOST, '--input', '-'];

/** The closed environment list of the process; it lives in the registry with the other passthrough lists. */
export { PR_STATUS_ENV_PASSTHROUGH };

/** Limit of one call; then `SIGKILL`. */
export const GH_TIMEOUT_MS = 20_000;

/** Ceiling of stdout and, separately, of stderr; over it the process is killed and the call fails. */
export const GH_OUTPUT_CAP_BYTES = 1024 * 1024;

/** PRs per call (aliases in one query). */
export const PR_BATCH_MAX = 50;

/** `gh` exit code for "authentication required". */
const NOT_LOGGED_IN_EXIT = 4;

/** GitHub's wording of the primary and the secondary rate limit. */
const RATE_LIMIT_TEXT = /rate limit/i;

/** Candidate program paths for a directory list; `~/` entries drop out without an absolute `HOME`. */
export function ghCandidates(directories: readonly string[], home: string | undefined): string[] {
  const candidates: string[] = [];
  for (const dir of directories) {
    if (dir.startsWith('~/')) {
      if (home === undefined || !isAbsolute(home)) continue;
      candidates.push(join(home, dir.slice(2), 'gh'));
    } else {
      candidates.push(join(dir, 'gh'));
    }
  }
  return candidates;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface FindGhOptions {
  readonly directories?: readonly string[];
  readonly home: string | undefined;
  readonly isExecutable?: (path: string) => boolean;
}

/** The first executable `gh` of the candidates, or `null`. */
export function findGh(opts: FindGhOptions): string | null {
  const isExecutable = opts.isExecutable ?? isExecutableFile;
  for (const candidate of ghCandidates(opts.directories ?? GH_DIRECTORIES, opts.home)) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Environment of the process: exactly the names of {@link PR_STATUS_ENV_PASSTHROUGH} that are set and not empty. */
export function ghEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PR_STATUS_ENV_PASSTHROUGH) {
    const value = base[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return env;
}

/** Request body for `--input -`: the query names only alias indices, the values travel as GraphQL variables. */
export function buildQueryBody(prs: readonly PrRef[]): string {
  const declarations: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, string | number> = {};
  prs.forEach((pr, i) => {
    declarations.push(`$o${i}:String!,$r${i}:String!,$n${i}:Int!`);
    fields.push(`p${i}:repository(owner:$o${i},name:$r${i}){pullRequest(number:$n${i}){state isDraft}}`);
    variables[`o${i}`] = pr.owner;
    variables[`r${i}`] = pr.repo;
    variables[`n${i}`] = pr.number;
  });
  const query = `query(${declarations.join(',')}){${fields.join(' ')} rateLimit{remaining resetAt}}`;
  return JSON.stringify({ query, variables });
}

/** Outcome of one process run. `failure` names a run that did not end on its own. */
export interface GhRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure: 'spawn' | 'timeout' | 'output-cap' | 'aborted' | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** GitHub's `PullRequestState` values and their wire values; a draft is not one of them, it is `isDraft` on OPEN. */
const GITHUB_STATES: ReadonlyMap<string, PullRequestState> = new Map([
  ['OPEN', 'open'], ['MERGED', 'merged'], ['CLOSED', 'closed'],
]);

/**
 * State of one `pullRequest` object: OPEN with `isDraft: true` is `draft`; OPEN with `isDraft` false, missing or not
 * a boolean stays `open` (the state is known, only the draft mark is not); MERGED and CLOSED ignore `isDraft`.
 */
function stateOf(pullRequest: Record<string, unknown> | null): PullRequestState | null {
  const value = pullRequest?.['state'];
  if (typeof value !== 'string') return null;
  const state = GITHUB_STATES.get(value) ?? null;
  return state === 'open' && pullRequest?.['isDraft'] === true ? 'draft' : state;
}

function rateLimitError(answer: Record<string, unknown> | null): boolean {
  const errors = answer?.['errors'];
  return Array.isArray(errors) && errors.some((error) => record(error)?.['type'] === 'RATE_LIMITED');
}

function epochOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** States of `prs` from one run. Reads stdout whatever the exit code; stdout without a `data` object fails the call. */
export function readGhOutput(run: GhRun, prs: readonly PrRef[]): PrReadResult {
  if (run.failure === 'timeout') return { ok: false, failure: 'timeout' };
  if (run.failure === 'output-cap') return { ok: false, failure: 'output-cap' };
  if (run.failure !== null) return { ok: false, failure: 'error' };
  const answer = record(parseJson(run.stdout));
  const data = record(answer?.['data']);
  if (data === null) {
    if (rateLimitError(answer) || RATE_LIMIT_TEXT.test(run.stdout) || RATE_LIMIT_TEXT.test(run.stderr)) {
      return { ok: false, failure: 'rate-limited', resetAt: null };
    }
    return { ok: false, failure: run.code === NOT_LOGGED_IN_EXIT ? 'not-logged-in' : 'error' };
  }
  const states = new Map<string, PullRequestState | null>();
  prs.forEach((pr, i) => {
    states.set(pr.url, stateOf(record(record(data[`p${i}`])?.['pullRequest'])));
  });
  const limit = record(data['rateLimit']);
  if (limit?.['remaining'] === 0) return { ok: true, states, limitReached: { resetAt: epochOf(limit['resetAt']) } };
  return { ok: true, states };
}

interface RunOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly capBytes: number;
  readonly signal: AbortSignal | undefined;
}

/** One `gh` run; resolves, never rejects. */
export function runGh(bin: string, opts: RunOptions): Promise<GhRun> {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, [...GH_ARGV], {
        env: opts.env,
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: opts.capBytes,
        encoding: 'utf8',
        windowsHide: true,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, failure: null });
          return;
        }
        const code: unknown = (error as { code?: unknown }).code;
        const failed = (failure: GhRun['failure']): void => {
          resolve({ code: null, stdout: '', stderr: '', failure });
        };
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') failed('output-cap');
        else if (error.name === 'AbortError') failed('aborted');
        else if (typeof code === 'string') failed('spawn');
        else if (error.killed === true) failed('timeout');
        else resolve({ code: typeof code === 'number' ? code : null, stdout, stderr, failure: null });
      });
      // A process that exits before reading stdin makes the write fail with EPIPE; the exit callback reports it.
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.stdin);
    } catch {
      resolve({ code: null, stdout: '', stderr: '', failure: 'spawn' });
    }
  });
}

export interface GhSourceOptions {
  /** Server environment; cut to {@link PR_STATUS_ENV_PASSTHROUGH}, its `HOME` expands `~/` of the directory list. */
  readonly env: NodeJS.ProcessEnv;
  readonly directories?: readonly string[];
  readonly timeoutMs?: number;
  readonly capBytes?: number;
}

/** The `gh` source. The program is looked up on the first read; not found = `missing-gh` for every read after. */
export function createGhSource(opts: GhSourceOptions): PrStateSource {
  const env = ghEnv(opts.env);
  const home = opts.env['HOME'];
  let bin: string | null | undefined;
  return {
    read: async (prs, signal) => {
      try {
        const batch = prs.slice(0, PR_BATCH_MAX);
        if (batch.length === 0) return { ok: true, states: new Map() };
        if (bin === undefined) {
          bin = findGh({ home, ...(opts.directories === undefined ? {} : { directories: opts.directories }) });
        }
        if (bin === null) return { ok: false, failure: 'missing-gh' };
        const run = await runGh(bin, {
          env,
          stdin: buildQueryBody(batch),
          timeoutMs: opts.timeoutMs ?? GH_TIMEOUT_MS,
          capBytes: opts.capBytes ?? GH_OUTPUT_CAP_BYTES,
          signal,
        });
        return readGhOutput(run, batch);
      } catch {
        return { ok: false, failure: 'error' };
      }
    },
  };
}

/**
 * Arguments of the login check of `rarog doctor`: the same host as the reads. `--active` checks only the account the
 * reads use (a broken inactive account must not read as "not logged in"); `--no-refresh` keeps the check read-only
 * (without it `gh` refreshes and stores a token near expiry).
 */
export const GH_AUTH_ARGV: readonly string[] = ['auth', 'status', '--active', '--no-refresh', '--hostname', GH_HOST];

/** Limit of the login check; `gh auth status` asks GitHub whether the token still works. */
export const GH_AUTH_TIMEOUT_MS = 10_000;

/**
 * Outcome of `gh auth status`: exit 0, another exit code, a `gh` that refused one of the flags of
 * {@link GH_AUTH_ARGV} (older than the flags), or a run that did not end on its own.
 */
export type GhAuthState = 'logged-in' | 'not-logged-in' | 'outdated-gh' | 'failed';

/** How `gh` (cobra) refuses a flag it does not know: `unknown flag: --active`, then the usage, exit 1. */
const UNKNOWN_FLAG = /^unknown flag: --(?:active|no-refresh)\b/m;

/**
 * Login check for `rarog doctor`: {@link GH_AUTH_ARGV} with the same closed environment as the reads.
 * Resolves, never rejects; stderr only tells a refused flag apart, and nothing from stdout or stderr leaves this
 * function.
 */
export function checkGhAuth(bin: string, base: NodeJS.ProcessEnv, timeoutMs = GH_AUTH_TIMEOUT_MS): Promise<GhAuthState> {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, [...GH_AUTH_ARGV], {
        env: ghEnv(base), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: GH_OUTPUT_CAP_BYTES, encoding: 'utf8',
        windowsHide: true,
      }, (error, _stdout, stderr) => {
        if (error === null) resolve('logged-in');
        else if (typeof (error as { code?: unknown }).code !== 'number' || error.killed === true) resolve('failed');
        else resolve(UNKNOWN_FLAG.test(stderr) ? 'outdated-gh' : 'not-logged-in');
      });
      child.stdin?.end();
    } catch {
      resolve('failed');
    }
  });
}
