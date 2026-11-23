/**
 * The child process that creates one directory for `fs-mkdir.ts`: its source, its argv and the runner that starts it.
 * The child enters the checked parent with `process.chdir`, so its working directory holds the directory object and
 * not a path, and `mkdirSync` of one relative segment then works like `mkdirat` (Node has no `mkdirat` and no
 * `fchdir`, and `chdir` in the server would move every request). The child prints one code from a closed list and
 * nothing else. This module never judges a path and never touches the disk itself.
 */
import { spawn } from 'node:child_process';

/** What the child prints: one of these, then a newline. */
export const MKDIR_CHILD_CODES = ['OK', 'MOVED', 'EEXIST', 'ENOENT', 'ENOTDIR', 'EACCES', 'OTHER'] as const;
export type MkdirChildCode = (typeof MKDIR_CHILD_CODES)[number];

/**
 * The child's source, run with `--input-type=module -e`. `argv[1]` is the parent on disk exactly as the server checked
 * it, `argv[2]` the name in NFC. After `chdir`, `process.cwd()` (the system `getcwd`) gives the path of the directory
 * the child now holds; anything other than the checked parent means it moved or was swapped in between, so the child
 * creates nothing and prints `MOVED`.
 */
export const CHILD_SOURCE = `import { mkdirSync } from 'node:fs';
const KNOWN = new Set(['EEXIST', 'ENOENT', 'ENOTDIR', 'EACCES']);
let result = 'OTHER';
try {
  if (process.argv.length !== 3) throw new Error('two arguments expected');
  const dir = process.argv[1];
  const name = process.argv[2];
  process.chdir(dir);
  if (process.cwd() === dir) {
    mkdirSync(name);
    result = 'OK';
  } else {
    result = 'MOVED';
  }
} catch (error) {
  const code = typeof error === 'object' && error !== null ? error.code : undefined;
  result = KNOWN.has(code) ? code : 'OTHER';
}
process.stdout.write(result + '\\n');
`;

/**
 * The child's argv after the `node` executable. `--` ends Node's options, so a name such as `-p` or `--inspect-brk=0`
 * reaches the child as an argument and never as an option of Node.
 */
export function mkdirChildArgv(realDir: string, name: string): string[] {
  return ['--input-type=module', '-e', CHILD_SOURCE, '--', realDir, name];
}

/** Spawn options of the child: no shell, an empty environment, `/` as the start directory, stdout only. */
export interface MkdirSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: readonly ['ignore', 'pipe', 'ignore'];
  readonly timeout: number;
  readonly killSignal: 'SIGKILL';
}

/** How the child ended: exit code or signal, and the start of its stdout. */
export interface MkdirChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
}

/**
 * Starts the child and waits for it to end. `spawn` runs in the call itself, before the function returns, so the
 * caller controls what happens in the same tick before the start. Tests swap the runner.
 */
export type MkdirChildRunner = (
  file: string, args: readonly string[], options: MkdirSpawnOptions,
) => Promise<MkdirChildExit>;

/** The child's answer is a few bytes; anything past this is not an answer. */
const STDOUT_CAP = 64;

/**
 * The default runner. It never rejects: a child that cannot start ends as `{ code: null, signal: null }`. It resolves
 * only when the child is gone (`close`), so the caller's slot stays taken while the child can still create something.
 */
export const runMkdirChild: MkdirChildRunner = (file, args, options) => new Promise((resolve) => {
  let stdout = '';
  let settled = false;
  const finish = (exit: MkdirChildExit): void => {
    if (settled) return;
    settled = true;
    resolve(exit);
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(file, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: [...options.stdio],
      timeout: options.timeout,
      killSignal: options.killSignal,
    });
  } catch {
    // An argument Node refuses before the start (a NUL byte); nothing ran.
    finish({ code: null, signal: null, stdout: '' });
    return;
  }
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length < STDOUT_CAP) stdout += chunk.slice(0, STDOUT_CAP - stdout.length);
  });
  // `error` without a pid: the child never started, and `close` may not follow. With a pid (a failed kill) the
  // child still runs, so the answer waits for `close`.
  child.on('error', () => {
    if (child.pid === undefined) finish({ code: null, signal: null, stdout: '' });
  });
  child.on('close', (code, signal) => { finish({ code, signal, stdout }); });
});
