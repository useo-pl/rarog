/**
 * Fake `restart.sh` for Ctrl-C tests of `rarog` commands that run it (`rarog restart`, `rarog service install`).
 *
 * `runChild` starts `bash` found through the `PATH` of the command, so a directory with this fake `bash` first in
 * `PATH` replaces the real script. The fake writes its events to a file, not to the terminal of the command:
 * `started`; on SIGTERM `got TERM` and `lock held` when the lock file still exists at that moment; after a short
 * cleanup `cleanup done`, then exit 143. A second SIGTERM during the cleanup adds a second `got TERM`. Its stdin,
 * stdout and stderr point to /dev/null, so an orphan left by a broken interrupt holds no pipe or terminal open.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Python 3.9+ standard library only (`python3 -I -c PTY_RUN <program> <args…>`): runs the program in a
 * pseudo-terminal, copies stdin to it and its output to stdout, writes `PID <pid>` of the program to stderr and exits
 * with its code once its output ends. `bin/rarog.mjs` asks questions only when stdin and stdout are a terminal, and
 * Node opens no pseudo-terminal by itself. Not `pty.spawn`: on macOS it keeps waiting for stdin after the program
 * ended.
 */
export const PTY_RUN = [
  'import os, pty, select, sys',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execv(sys.argv[1], sys.argv[1:])',
  'sys.stderr.write("PID %d\\n" % pid)',
  'sys.stderr.flush()',
  'reading = True',
  'while True:',
  '    ready = select.select([fd] + ([0] if reading else []), [], [])[0]',
  '    if fd in ready:',
  '        try:',
  '            data = os.read(fd, 4096)',
  '        except OSError:',
  '            data = b""',
  '        if not data:',
  '            break',
  '        os.write(1, data)',
  '    if 0 in ready:',
  '        data = os.read(0, 4096)',
  '        if data:',
  '            os.write(fd, data)',
  '        else:',
  '            reading = False',
  'sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))',
  '',
].join('\n');

export interface FakeRestartScript {
  /** Directory with the fake `bash`; put it first in `PATH`. */
  readonly dir: string;
  /** Event lines written so far. */
  events(): string[];
  /** Resolves once the fake printed `started`; rejects after `timeoutMs`. */
  started(timeoutMs?: number): Promise<void>;
  /** SIGKILL for a fake still alive (an orphan after a failed interrupt); nothing when it already ended. */
  kill(): void;
}

/** Fake `bash` in `<parent>/atrapa-restart-sh`; `lockFile` is the lock the command holds while the script runs. */
export function fakeRestartScript(parent: string, lockFile: string): FakeRestartScript {
  const dir = path.join(parent, 'atrapa-restart-sh');
  mkdirSync(dir, { recursive: true });
  const events = path.join(dir, 'events');
  const pidFile = path.join(dir, 'pid');
  const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(path.join(dir, 'bash'), [
    '#!/bin/bash',
    'exec </dev/null >/dev/null 2>&1',
    `ev=${quoted(events)}`,
    `lock=${quoted(lockFile)}`,
    `echo $$ > ${quoted(pidFile)}`,
    'trap \'echo "got TERM" >> "$ev"; if [ -e "$lock" ]; then echo "lock held" >> "$ev"; fi; stop=1\' TERM',
    'echo started >> "$ev"',
    'while [ -z "${stop:-}" ]; do sleep 0.05; done',
    'sleep 0.3',
    'echo "cleanup done" >> "$ev"',
    'exit 143',
    '',
  ].join('\n'));
  chmodSync(path.join(dir, 'bash'), 0o755);
  const read = (): string[] => (existsSync(events) ? readFileSync(events, 'utf8').trimEnd().split('\n') : []);
  return {
    dir,
    events: read,
    started: async (timeoutMs = 30_000) => {
      const until = Date.now() + timeoutMs;
      while (!read().includes('started')) {
        if (Date.now() > until) throw new Error(`fake restart.sh did not start within ${String(timeoutMs)} ms`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    kill: () => {
      if (!existsSync(pidFile)) return;
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already ended.
      }
    },
  };
}
