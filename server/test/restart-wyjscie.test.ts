/**
 * Output of `restart.sh` under `rarog restart` and `rarog service install` (`server/src/cli/child-output.ts`).
 *
 * The real `restart.sh` never runs here: `runRestartScript` spawns `bash` found through the `PATH` of the given
 * environment, and that `PATH` starts with a fake `bash` in a temporary directory. The fake prints lines, exits with
 * a chosen code or waits for a signal. A driver process (`node --import tsx`) calls `runRestartScript` and then
 * `finishRestartScript`, so the checks see the real file descriptor 1 of a command and its real exit code. The
 * driver routes SIGINT through `interruptOrExit`, as `bin/rarog.mjs` does.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { interruptOrExit, runChild } from '../src/cli/child-output.ts';
import type { ChildResult } from '../src/cli/child-output.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const RESTART = path.join(REPO, 'server', 'src', 'cli', 'restart.ts');
const CHILD_OUTPUT = path.join(REPO, 'server', 'src', 'cli', 'child-output.ts');

/** Prefix of lines the driver writes to stderr for the sink; the result line has its own prefix. */
const SINK = 'SINK ';
const RESULT = 'RESULT ';

let dir: string;
let driver: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'rarog-restart-output-'));
  driver = path.join(dir, 'driver.mts');
  writeFileSync(driver, [
    `import { finishRestartScript, runRestartScript } from ${JSON.stringify(RESTART)};`,
    `import { interruptOrExit } from ${JSON.stringify(CHILD_OUTPUT)};`,
    'process.on("SIGINT", () => { interruptOrExit((code) => { process.exit(code); }); });',
    'const withSink = process.argv[2] === "sink";',
    `const sink = withSink ? (line) => process.stderr.write(${JSON.stringify(SINK)} + line + "\\n") : undefined;`,
    'const io = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t),',
    '  env: process.env, cwd: process.cwd() };',
    'const result = await runRestartScript(process.env, sink);',
    `process.stderr.write(${JSON.stringify(RESULT)} + JSON.stringify(result) + "\\n");`,
    'process.exitCode = finishRestartScript(io, result);',
  ].join('\n'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Directory with a fake `bash` running the given body (`$0` is the fake, `$1` the script path). */
function fakeBash(name: string, body: string[]): string {
  const bin = path.join(dir, name);
  mkdirSync(bin);
  const file = path.join(bin, 'bash');
  writeFileSync(file, `#!/bin/bash\n${body.join('\n')}\n`);
  chmodSync(file, 0o755);
  return bin;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly sinkLines: string[];
  readonly result: { code: number; lastLine: string | null; interrupted: boolean } | null;
  readonly stderrRest: string[];
}

function runDriver(bin: string, mode: 'sink' | 'none', onLine?: (line: string, child: ReturnType<typeof spawn>) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', driver, mode], {
      cwd: REPO,
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (onLine !== undefined) for (const line of chunk.split('\n')) onLine(line, child);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stderr.split('\n').filter((line) => line !== '');
      const resultLine = lines.find((line) => line.startsWith(RESULT));
      resolve({
        code,
        stdout,
        sinkLines: lines.filter((line) => line.startsWith(SINK)).map((line) => line.slice(SINK.length)),
        result: resultLine === undefined ? null : JSON.parse(resultLine.slice(RESULT.length)) as Run['result'],
        stderrRest: lines.filter((line) => !line.startsWith(SINK) && !line.startsWith(RESULT)),
      });
    });
  });
}

const TWENTY = ['for i in $(seq 1 20); do echo "restart line $i"; done'];

describe('restart.sh output with a sink', () => {
  it('20 lines and exit 0: all 20 in the sink, nothing on stdout, exit 0', async () => {
    const run = await runDriver(fakeBash('twenty', [...TWENTY, 'exit 0']), 'sink');
    expect(run.sinkLines).toEqual(Array.from({ length: 20 }, (_, i) => `restart line ${String(i + 1)}`));
    expect(run.stdout).toBe('');
    expect(run.result).toEqual({ code: 0, lastLine: 'restart line 20', interrupted: false });
    expect(run.stderrRest).toEqual([]);
    expect(run.code).toBe(0);
  });

  it('stderr of the child goes to the sink too, not to the terminal', async () => {
    const run = await runDriver(fakeBash('stderr', ['echo "to stdout"', 'echo "to stderr" >&2', 'exit 0']), 'sink');
    expect(run.sinkLines).toEqual(['to stdout', 'to stderr']);
    expect(run.stdout).toBe('');
    expect(run.stderrRest).toEqual([]);
  });

  it.each([2, 3])('exit %i: the same exit code and the last child line in the error sentence', async (code) => {
    const run = await runDriver(fakeBash(`exit${String(code)}`, [
      ...TWENTY, `echo "ERROR: health check failed with code ${String(code)}"`, 'echo ""', `exit ${String(code)}`,
    ]), 'sink');
    expect(run.code).toBe(code);
    expect(run.stdout).toBe('');
    expect(run.result?.lastLine).toBe(`ERROR: health check failed with code ${String(code)}`);
    expect(run.stderrRest).toEqual([
      `rarog restart: restart.sh exited with code ${String(code)}`
      + ` (last line: ERROR: health check failed with code ${String(code)}).`,
    ]);
  });

  it('SIGINT: the child gets SIGTERM, the command waits for its cleanup and exits 130', async () => {
    const bin = fakeBash('interrupt', [
      'trap \'echo "got TERM"; sleep 0.3; echo "cleanup done"; exit 143\' TERM',
      'trap \'echo "got INT"\' INT',
      'echo "started"',
      'while :; do sleep 0.05; done',
    ]);
    let sent = false;
    const run = await runDriver(bin, 'sink', (line, child) => {
      if (!sent && line === `${SINK}started`) {
        sent = true;
        child.kill('SIGINT');
      }
    });
    expect(sent).toBe(true);
    expect(run.sinkLines).toEqual(['started', 'got TERM', 'cleanup done']);
    expect(run.result).toEqual({ code: 130, lastLine: 'cleanup done', interrupted: true });
    expect(run.stderrRest).toEqual(['rarog restart: restart.sh was interrupted (Ctrl-C) and stopped.']);
    expect(run.code).toBe(130);
  });
});

describe('restart.sh output without a sink (calls as today)', () => {
  it('the child writes to stdout of the command, exit code passes through', async () => {
    const run = await runDriver(fakeBash('plain', [...TWENTY, 'exit 0']), 'none');
    expect(run.stdout).toBe(Array.from({ length: 20 }, (_, i) => `restart line ${String(i + 1)}\n`).join(''));
    expect(run.sinkLines).toEqual([]);
    expect(run.result).toEqual({ code: 0, lastLine: null, interrupted: false });
    expect(run.code).toBe(0);
  });

  it('exit 2 without a sink: code 2 and no extra sentence (restart.sh printed its own)', async () => {
    const run = await runDriver(fakeBash('plain2', ['echo "ERROR: own message"', 'exit 2']), 'none');
    expect(run.stdout).toBe('ERROR: own message\n');
    expect(run.stderrRest).toEqual([]);
    expect(run.code).toBe(2);
  });
});

describe('Ctrl-C decision (`interruptOrExit`)', () => {
  it('no child of runChild running: the command ends with 130, as before', () => {
    const codes: number[] = [];
    interruptOrExit((code) => { codes.push(code); });
    expect(codes).toEqual([130]);
  });

  it('a child running: no exit, SIGTERM once, the child cleans up and runChild waits for its end', async () => {
    const bin = fakeBash('decision', [
      'trap \'echo "got TERM"; stop=1\' TERM',
      'echo "started"',
      'while [ -z "${stop:-}" ]; do sleep 0.05; done',
      'sleep 0.3',
      'echo "cleanup done"',
      'exit 143',
    ]);
    const codes: number[] = [];
    const lines: string[] = [];
    let onStarted = (): void => {};
    const started = new Promise<void>((resolve) => { onStarted = resolve; });
    const result = runChild({
      command: 'bash', args: [], cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      sink: (line) => {
        lines.push(line);
        if (line === 'started') onStarted();
      },
    });
    await started;
    interruptOrExit((code) => { codes.push(code); });
    expect(await result).toEqual({ code: 130, lastLine: 'cleanup done', interrupted: true });
    expect(codes).toEqual([]);
    expect(lines).toEqual(['started', 'got TERM', 'cleanup done']);
    // After the child ended, Ctrl-C ends the command again.
    interruptOrExit((code) => { codes.push(code); });
    expect(codes).toEqual([130]);
  });
});

/** A Node child that ignores SIGTERM and never ends by itself; it prints its PID, then `started`. */
const STUBBORN = [
  "process.on('SIGTERM', () => { console.log('got TERM'); });",
  "console.log(String(process.pid)); console.log('started');",
  'setInterval(() => {}, 1000);',
].join(' ');

/** Starts {@link STUBBORN} under runChild; resolves once it printed `started`. */
async function stubborn(killGraceMs: number): Promise<{ result: Promise<ChildResult>; pid: number; lines: string[] }> {
  const lines: string[] = [];
  let onStarted = (): void => {};
  const started = new Promise<void>((resolve) => { onStarted = resolve; });
  const result = runChild({
    command: process.execPath, args: ['-e', STUBBORN], cwd: dir, env: process.env, killGraceMs,
    sink: (line) => {
      lines.push(line);
      if (line === 'started') onStarted();
    },
  });
  await started;
  return { result, pid: Number(lines[0]), lines };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The result, or `still running` after `ms`. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | 'still running'> =>
  Promise.race([promise, new Promise<'still running'>((resolve) => { setTimeout(resolve, ms, 'still running'); })]);

describe('a child that ignores SIGTERM', () => {
  it('after the grace it gets SIGKILL; runChild waits for its end, code 130', async () => {
    const child = await stubborn(400);
    try {
      const startedAt = Date.now();
      interruptOrExit(() => { throw new Error('exit while a child runs'); });
      expect(await within(child.result, 5000)).toEqual({ code: 130, lastLine: 'got TERM', interrupted: true });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
      expect(child.lines.slice(1)).toEqual(['started', 'got TERM']);
      expect(alive(child.pid)).toBe(false);
    } finally {
      if (alive(child.pid)) process.kill(child.pid, 'SIGKILL');
    }
  });

  it('a second Ctrl-C during the grace sends SIGKILL at once', async () => {
    const child = await stubborn(60_000);
    try {
      interruptOrExit(() => { throw new Error('exit while a child runs'); });
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      interruptOrExit(() => { throw new Error('exit while a child runs'); });
      expect(await within(child.result, 5000)).toEqual({ code: 130, lastLine: 'got TERM', interrupted: true });
      expect(alive(child.pid)).toBe(false);
    } finally {
      if (alive(child.pid)) process.kill(child.pid, 'SIGKILL');
    }
  });
});
