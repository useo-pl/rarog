/**
 * Child processes of CLI commands (`restart.sh` in `rarog restart` and `rarog service install`) run asynchronously.
 * With a sink, child stdout and stderr go as lines only to the sink (command log, or the screen with `--verbose`);
 * without one, the child shares the terminal (`stdio: 'inherit'`). Ctrl-C sends SIGTERM to the child and waits for
 * its end, so its cleanup finishes before the command exits 130; a child still running after {@link KILL_GRACE_MS}
 * or at a second Ctrl-C gets SIGKILL. The interrupt decision for the whole command lives here ({@link interruptOrExit}),
 * for Ctrl-C, SIGTERM and SIGHUP. No step rendering, no files: the caller owns the sink.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

/** Receiver of child output lines, without the line end; stdout and stderr in arrival order. */
export type ChildSink = (line: string) => void;

/** Exit code of a command interrupted by Ctrl-C (128 + SIGINT). */
export const EXIT_INTERRUPTED = 130;

/**
 * The signals `bin/rarog.mjs` hands to {@link interruptOrExit}: Ctrl-C, a stop (`kill`, a service manager) and a closed
 * terminal. Every one ends the command with 128 + its number ({@link signalExitCode}).
 */
export const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export type HandledSignal = (typeof HANDLED_SIGNALS)[number];

/** Exit code after a signal: 128 + its number (130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP). */
export function signalExitCode(signal: HandledSignal): number {
  return 128 + constants.signals[signal];
}

/**
 * After the child exits, its pipes get this long to close: a grandchild that kept them open (a background start
 * without redirection) must not hold the command forever.
 */
const PIPE_CLOSE_GRACE_MS = 1000;

/**
 * After SIGTERM the child gets this long to clean up; then SIGKILL. A child that ignores SIGTERM must not hold the
 * command, and the lock of the command, forever.
 */
export const KILL_GRACE_MS = 10_000;

/**
 * Interrupt functions of the {@link runChild} children running now: the first call sends SIGTERM, the next one
 * SIGKILL.
 */
const runningChildren = new Set<() => void>();

/** What a command shows right before {@link interruptOrExit} exits (the step screen ends its running step). */
const beforeExit = new Set<() => void>();

/** Work an interrupt finishes before the command exits ({@link deferInterruptExit}). */
const deferredExit = new Set<() => Promise<void>>();

/** A deferred exit runs now: the next signal exits at once. */
let deferring = false;

/**
 * The one interrupt decision of a `rarog` command. `bin/rarog.mjs` calls it on the process SIGINT, SIGTERM and SIGHUP
 * and on the SIGINT event of its question prompt (a terminal in raw mode delivers Ctrl-C only there).
 *
 * - Ctrl-C while a child of {@link runChild} runs: nothing exits. Every running child gets SIGTERM (SIGKILL after
 *   {@link KILL_GRACE_MS}, or at once on a second Ctrl-C), `runChild` resolves after the child closed, the command's
 *   `finally` blocks (the lock) run, and the command ends with 130 on its own.
 * - Otherwise the {@link beforeInterruptExit} handlers run (the step screen ends its running step), then the work
 *   registered with {@link deferInterruptExit} (`rarog pair` cancels its code), then `exit` with 128 + the signal
 *   number. SIGTERM and SIGHUP do not wait for children: the command ends as it would without a handler.
 * - A signal while that work runs exits at once.
 */
export function interruptOrExit(exit: (code: number) => void, signal: HandledSignal = 'SIGINT'): void {
  const code = signalExitCode(signal);
  if (deferring) {
    exit(code);
    return;
  }
  if (signal === 'SIGINT' && runningChildren.size > 0) {
    for (const interrupt of [...runningChildren]) interrupt();
    return;
  }
  for (const handler of [...beforeExit]) {
    try {
      handler();
    } catch {
      // A broken screen must not keep the process from exiting.
    }
  }
  if (deferredExit.size === 0) {
    exit(code);
    return;
  }
  deferring = true;
  void Promise.allSettled([...deferredExit].map(async (work) => { await work(); })).then(() => {
    deferring = false;
    exit(code);
  });
}

/**
 * Registers work an interrupt finishes before the command exits (`rarog pair` cancels its pairing code on the server).
 * The work bounds its own time; a second signal exits without waiting for it. Returns the function that removes it;
 * call it when the work no longer applies.
 */
export function deferInterruptExit(work: () => Promise<void>): () => void {
  deferredExit.add(work);
  return () => { deferredExit.delete(work); };
}

/**
 * Registers `handler` to run when Ctrl-C exits the command at once (no child running). Returns the function that
 * removes it; call it when the command ends.
 */
export function beforeInterruptExit(handler: () => void): () => void {
  beforeExit.add(handler);
  return () => { beforeExit.delete(handler); };
}

/**
 * Registers the interrupt function of a child started outside {@link runChild} (`npm ci` of the Claude SDK, which
 * keeps its own pipes and time limit): while it is registered, Ctrl-C calls it instead of exiting, so the caller's
 * cleanup runs first. Returns the function that removes it; call it when the child ended.
 */
export function trackChild(interrupt: () => void): () => void {
  runningChildren.add(interrupt);
  return () => { runningChildren.delete(interrupt); };
}

export interface ChildRun {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Without a sink the child writes to the terminal of the command, as `stdio: 'inherit'` did. */
  readonly sink?: ChildSink;
  /** Time between SIGTERM and SIGKILL after Ctrl-C; default {@link KILL_GRACE_MS} (tests pass a shorter one). */
  readonly killGraceMs?: number;
}

export interface ChildResult {
  /** Exit code of the child; {@link EXIT_INTERRUPTED} after Ctrl-C, 1 when it ended on a signal. */
  readonly code: number;
  /** Last non-empty output line seen by the sink; `null` without a sink or without output. */
  readonly lastLine: string | null;
  /** Ctrl-C came during the run: the child got SIGTERM and the command waited for its end. */
  readonly interrupted: boolean;
}

/** Splits chunks of one stream into lines; the rest without a line end goes out at {@link LineSplitter.flush}. */
class LineSplitter {
  #rest = '';

  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: string): void {
    const parts = (this.#rest + chunk).split('\n');
    this.#rest = parts.pop() ?? '';
    for (const part of parts) this.emit(part.endsWith('\r') ? part.slice(0, -1) : part);
  }

  flush(): void {
    if (this.#rest !== '') this.emit(this.#rest);
    this.#rest = '';
  }
}

/**
 * Runs the child and resolves after it ended and its output reached the sink. A spawn failure (missing command,
 * wrong `cwd`) rejects with the spawn error. Ctrl-C reaches the child through {@link interruptOrExit}.
 */
export function runChild(run: ChildRun): Promise<ChildResult> {
  const { sink } = run;
  return new Promise((resolve, reject) => {
    const child = spawn(run.command, [...run.args], {
      cwd: run.cwd, env: run.env, stdio: sink === undefined ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let lastLine: string | null = null;
    let interrupted = false;
    let settled = false;
    const emit = (line: string): void => {
      if (line.trim() !== '') lastLine = line;
      sink?.(line);
    };
    const splitters: LineSplitter[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue;
      const splitter = new LineSplitter(emit);
      splitters.push(splitter);
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => splitter.push(chunk));
    }
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (): void => {
      if (killTimer !== undefined) clearTimeout(killTimer);
      killTimer = undefined;
      if (!exited) child.kill('SIGKILL');
    };
    const onInterrupt = (): void => {
      if (interrupted) {
        kill();
        return;
      }
      interrupted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(kill, run.killGraceMs ?? KILL_GRACE_MS);
    };
    runningChildren.add(onInterrupt);
    let grace: NodeJS.Timeout | undefined;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      runningChildren.delete(onInterrupt);
      if (grace !== undefined) clearTimeout(grace);
      if (killTimer !== undefined) clearTimeout(killTimer);
      finish();
    };
    child.on('error', (failure) => settle(() => reject(failure)));
    child.on('exit', () => {
      exited = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, PIPE_CLOSE_GRACE_MS);
    });
    child.on('close', (code) => settle(() => {
      for (const splitter of splitters) splitter.flush();
      resolve({ code: interrupted ? EXIT_INTERRUPTED : code ?? 1, lastLine, interrupted });
    }));
  });
}

/**
 * Start of an error sentence about the child: `restart.sh exited with code 2 (last line: …)`; after Ctrl-C
 * `restart.sh was interrupted (Ctrl-C) and stopped`. Without a sink there is no last line, and the text is the one
 * the commands printed before the sink existed.
 */
export function childExitText(name: string, result: ChildResult): string {
  if (result.interrupted) return `${name} was interrupted (Ctrl-C) and stopped`;
  const last = result.lastLine === null ? '' : ` (last line: ${result.lastLine.trim()})`;
  return `${name} exited with code ${String(result.code)}${last}`;
}
