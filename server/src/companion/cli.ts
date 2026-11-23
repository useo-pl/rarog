/**
 * One question to the model of `MODEL` (`cli-literals.ts`) through `claude -p` on the owner's subscription: the only
 * place in the server that starts Claude Code in print mode (guard: `server/test/companion-granice.test.ts`).
 *
 * The call, and why each part is the way it is:
 * - program: `claudeCommand()` (the native installer's program by full path, `claude` from `PATH` only without it);
 * - argv: `--model` with the alias of `MODEL` and the isolation flags of the registry, never content;
 * - system prompt through file descriptor 3, the question through stdin: content never reaches argv or the disk;
 * - env: only the closed list `COMPANION_ENV_PASSTHROUGH` (`config-env.ts`), so Rarog's secrets stay in the server;
 * - working directory: a fresh empty directory under `<dataDir>/companion-cwd/` (mode 0700), removed afterwards,
 *   so `--setting-sources project` finds no project settings;
 * - ceilings: 60 s per call, 64 kB of stdout and of stderr; over a ceiling the process gets `SIGKILL`;
 * - at most one question in flight per session and two per server; one more is refused (`companion-busy`), not
 *   queued.
 *
 * The outcome carries a code and a short reason for the log (`reason`), never content.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { COMPANION_ENV_PASSTHROUGH } from '../config-env.ts';
import { claudeCommand } from '../live-sessions.ts';
import { MODEL, PRINT_FLAGS, RATE_LIMIT, STREAM_EVENTS } from './cli-literals.ts';
import { buildMessage } from './prompt.ts';

/** Directory under `<dataDir>` that holds the per-call empty working directories (`cwdRoot`). */
export const COMPANION_CWD_DIR = 'companion-cwd';

/** Limit of one call; then `SIGKILL`. */
export const COMPANION_TIMEOUT_MS = 60_000;

/** Ceiling of stdout and, separately, of stderr; over it the process gets `SIGKILL`. */
export const OUTPUT_CAP_BYTES = 64 * 1024;

/** Questions in flight on the whole server. Per session it is always one. */
export const MAX_IN_FLIGHT = 2;

/**
 * Why a question got no answer. `aborted`: the caller's signal fired (the request closed, the session moved on,
 * the device was revoked); the route sends nothing then.
 */
export type CompanionFailure = 'companion-busy' | 'companion-limit' | 'companion-cli' | 'companion-timeout' | 'aborted';

/** Subscription limit read from `rate_limit_event`. */
export interface RateLimitState {
  /** Highest utilization over all windows (0–1), `null` when no event carried one. */
  readonly utilization: number | null;
  /** A window (or the overall status) has a status that does not start with `allowed`. */
  readonly exhausted: boolean;
}

export type AskOutcome =
  | { readonly ok: true; readonly text: string; readonly limit: RateLimitState; readonly ms: number }
  | {
    readonly ok: false;
    readonly code: CompanionFailure;
    /** Short, content-free reason for the log (`stdout-cap`, `exit-1`, `spawn`…). */
    readonly reason: string;
    readonly limit: RateLimitState;
    readonly ms: number;
  };

export interface AskRequest {
  /** Rarog session the question is about: one question in flight per session. */
  readonly sessionId: string;
  /** System prompt (`buildSystem`). */
  readonly system: string;
  /** The user's question (`buildMessage` checks its length). */
  readonly question: string;
  /** Kills the process when it fires. */
  readonly signal?: AbortSignal;
}

export interface CompanionCliOptions {
  /** `<dataDir>/companion-cwd`: parent of the per-call empty working directories. */
  readonly cwdRoot: string;
  /** Program to start, default `claudeCommand()`. */
  readonly bin?: string;
  /** Server environment the closed list is cut from (the server's start environment). */
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly outputCapBytes?: number;
  readonly maxInFlight?: number;
}

export interface CompanionCli {
  ask(request: AskRequest): Promise<AskOutcome>;
  /** Processes running now. */
  readonly running: number;
}

/** Argv of the call: the model and the isolation flags. No content. */
export function buildArgv(): string[] {
  return [MODEL.flag, MODEL.alias, ...PRINT_FLAGS.flags];
}

/** Environment of the process: exactly the names of `COMPANION_ENV_PASSTHROUGH` that are set. */
export function companionEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of COMPANION_ENV_PASSTHROUGH) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const NO_LIMIT: RateLimitState = { utilization: null, exhausted: false };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const refused = (status: unknown): boolean =>
  typeof status === 'string' && !status.startsWith(RATE_LIMIT.allowedPrefix);

/** Limit state of one `rate_limit_event`: the highest window utilization; any refused status exhausts. */
export function readRateLimit(event: unknown): RateLimitState {
  const info = record(record(event)?.[RATE_LIMIT.info]);
  if (info === null) return NO_LIMIT;
  let utilization: number | null = null;
  let exhausted = refused(info[RATE_LIMIT.status]);
  for (const window of Object.values(record(info[RATE_LIMIT.windows]) ?? {})) {
    const entry = record(window);
    if (entry === null) continue;
    const value = entry[RATE_LIMIT.utilization];
    if (typeof value === 'number' && Number.isFinite(value)) utilization = Math.max(utilization ?? value, value);
    if (refused(entry[RATE_LIMIT.status])) exhausted = true;
  }
  return { utilization, exhausted };
}

function mergeLimit(a: RateLimitState, b: RateLimitState): RateLimitState {
  const utilization = a.utilization === null ? b.utilization
    : b.utilization === null ? a.utilization : Math.max(a.utilization, b.utilization);
  return { utilization, exhausted: a.exhausted || b.exhausted };
}

interface RunOptions {
  readonly bin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly system: string;
  readonly message: string;
  readonly timeoutMs: number;
  readonly cap: number;
  readonly signal: AbortSignal | undefined;
  readonly started: number;
}

function runProcess(opts: RunOptions): Promise<AskOutcome> {
  return new Promise((resolve) => {
    let limit = NO_LIMIT;
    let result: { text: string; isError: boolean } | null = null;
    let killedFor: { code: CompanionFailure; reason: string } | null = null;
    let settled = false;
    const ms = (): number => Date.now() - opts.started;
    const fail = (code: CompanionFailure, reason: string): AskOutcome => ({ ok: false, code, reason, limit, ms: ms() });

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.bin, buildArgv(), {
        cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch {
      resolve(fail('companion-cli', 'spawn'));
      return;
    }

    const kill = (code: CompanionFailure, reason: string): void => {
      if (killedFor !== null) return;
      killedFor = { code, reason };
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { kill('companion-timeout', 'timeout'); }, opts.timeoutMs);
    const onAbort = (): void => { kill('aborted', 'aborted'); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted === true) onAbort();

    const settle = (outcome: () => AskOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(outcome());
    };

    // A process that died before reading gives EPIPE here; the exit code says what happened.
    const fd3 = child.stdio[3] as Writable | null | undefined;
    fd3?.on('error', () => undefined);
    fd3?.end(opts.system);
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.message);

    const decoder = new StringDecoder('utf8');
    let pending = '';
    let outBytes = 0;
    const onLine = (line: string): void => {
      if (line.trim() === '') return;
      let event: Record<string, unknown> | null;
      try {
        event = record(JSON.parse(line) as unknown);
      } catch {
        return;
      }
      if (event === null) return;
      const type = event[STREAM_EVENTS.type];
      if (type === STREAM_EVENTS.rateLimit) {
        limit = mergeLimit(limit, readRateLimit(event));
      } else if (type === STREAM_EVENTS.result) {
        const text = event[STREAM_EVENTS.resultText];
        result = { text: typeof text === 'string' ? text : '', isError: event[STREAM_EVENTS.resultIsError] === true };
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (killedFor !== null) return;
      outBytes += chunk.length;
      if (outBytes > opts.cap) {
        kill('companion-cli', 'stdout-cap');
        return;
      }
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    });
    let errBytes = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > opts.cap) kill('companion-cli', 'stderr-cap');
    });

    child.on('error', () => {
      settle(() => (killedFor !== null ? fail(killedFor.code, killedFor.reason) : fail('companion-cli', 'spawn')));
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      settle(() => {
        if (killedFor !== null) return fail(killedFor.code, killedFor.reason);
        onLine(pending + decoder.end());
        const done = result as { text: string; isError: boolean } | null;
        if (done !== null && !done.isError && code === 0) return { ok: true, text: done.text, limit, ms: ms() };
        if (limit.exhausted) return fail('companion-limit', 'limit');
        if (code === null) return fail('companion-cli', `signal-${signal ?? 'unknown'}`);
        if (code !== 0) return fail('companion-cli', `exit-${String(code)}`);
        return fail('companion-cli', done === null ? 'no-result' : 'is-error');
      });
    });
  });
}

/** The question runner of one server: ceilings, the in-flight rule and the per-call working directory. */
export function createCompanionCli(opts: CompanionCliOptions): CompanionCli {
  const bin = opts.bin ?? claudeCommand();
  const timeoutMs = opts.timeoutMs ?? COMPANION_TIMEOUT_MS;
  const cap = opts.outputCapBytes ?? OUTPUT_CAP_BYTES;
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
  const sessions = new Set<string>();

  async function run(request: AskRequest, message: string, started: number): Promise<AskOutcome> {
    let cwd: string;
    try {
      await mkdir(opts.cwdRoot, { recursive: true, mode: 0o700 });
      await chmod(opts.cwdRoot, 0o700);
      cwd = await mkdtemp(join(opts.cwdRoot, 'ask-'));
    } catch {
      return { ok: false, code: 'companion-cli', reason: 'cwd', limit: NO_LIMIT, ms: Date.now() - started };
    }
    try {
      return await runProcess({
        bin, env: companionEnv(opts.env), cwd, system: request.system, message, timeoutMs, cap,
        signal: request.signal, started,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    get running() {
      return sessions.size;
    },
    async ask(request) {
      const started = Date.now();
      const message = buildMessage(request.question);
      if (sessions.has(request.sessionId) || sessions.size >= maxInFlight) {
        return { ok: false, code: 'companion-busy', reason: 'in-flight', limit: NO_LIMIT, ms: 0 };
      }
      sessions.add(request.sessionId);
      try {
        return await run(request, message, started);
      } finally {
        sessions.delete(request.sessionId);
      }
    },
  };
}
