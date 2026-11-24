/**
 * The folder helper: a child `node` process that runs the disk calls of one gated folder, so a call that waits in the
 * kernel (a macOS consent window) waits in a process the server can kill, never in a thread of the server. It reads
 * requests of the line codec (`wire.ts`) on stdin, runs each through the port's own disk (`disk.ts`) and writes the
 * answer on stdout. This module also gives the command that starts it; it never judges a path or a folder state.
 */
import path from 'node:path';
import { INSTALL_MODE, INSTALL_ROOT, type InstallMode } from '../install/mode.ts';
import { runDisk } from './disk.ts';
import type { DiskArgs, DiskOp } from './types.ts';
import { decodeRequest, encodeResponse } from './wire.ts';

/**
 * The source run with `--input-type=module -e`: `argv[1]` is this module's file, which the source imports and serves.
 * The serving loop lives in the module, so the helper and the server share one codec and one disk.
 */
export const FOLDER_HELPER_BOOTSTRAP = `import { pathToFileURL } from 'node:url';
const { serveFolderHelper } = await import(pathToFileURL(process.argv[1]).href);
serveFolderHelper();
`;

/** Spawn options of every helper: `/` as the start directory (no folder held open) and an empty environment. */
export const FOLDER_HELPER_SPAWN = { cwd: '/', env: {} } as const satisfies {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

/** How to start a helper: the executable, its arguments and the spawn options; stdin and stdout are pipes. */
export interface FolderHelperCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: typeof FOLDER_HELPER_SPAWN.cwd;
  readonly env: typeof FOLDER_HELPER_SPAWN.env;
}

/**
 * The command for the install at `root`. The package runs the built JavaScript. The clone runs this module's
 * TypeScript with Node's own type stripping, not tsx: under an empty environment tsx would keep its cache in `/tmp`.
 * The flag goes only to a Node that does not strip types by default; `typescript` is `process.features.typescript`.
 */
export function folderHelperCommand(
  root: string = INSTALL_ROOT,
  mode: InstallMode = INSTALL_MODE,
  typescript: 'strip' | 'transform' | false = process.features.typescript,
): FolderHelperCommand {
  const entry = path.join(root, 'server', 'src', 'folder-gate', mode === 'package' ? 'helper.js' : 'helper.ts');
  const strip = mode === 'clone' && typescript === false ? ['--experimental-strip-types'] : [];
  return {
    file: process.execPath,
    args: [...strip, '--input-type=module', '-e', FOLDER_HELPER_BOOTSTRAP, '--', entry],
    ...FOLDER_HELPER_SPAWN,
  };
}

/**
 * Ends the helper with SIGKILL. A thread stuck in the kernel keeps `process.exit` waiting, so with a call still in
 * flight this is the only way out.
 */
const killSelf = (): void => { process.kill(process.pid, 'SIGKILL'); };

/** A request whose line decodes to JSON with an integer `id` but is not a valid request. */
function malformed(message: string): Error {
  return Object.assign(new Error(`folder helper: ${message}`), { code: 'EINVAL' });
}

/** The id of a line that is not a valid request, when it has one; such a request still gets an answer. */
function idOf(line: string): number | null {
  try {
    const message: unknown = JSON.parse(line);
    if (typeof message !== 'object' || message === null) return null;
    const id = (message as Record<string, unknown>).id;
    return Number.isSafeInteger(id) ? (id as number) : null;
  } catch {
    return null;
  }
}

/**
 * Serves requests until stdin ends. Every call runs as a promise, so one call that waits does not hold the answers of
 * the others; answers go out in the order calls finish. A line without an integer id has no one to answer and is
 * dropped. At the end of stdin the helper exits with 0 when idle and kills itself when a call is still in flight.
 */
export function serveFolderHelper(): void {
  let inFlight = 0;
  /** The start of a line whose end has not come yet. */
  const parts: string[] = [];
  const send = (line: string): void => { process.stdout.write(`${line}\n`); };

  const answer = async (id: number, op: DiskOp, args: unknown): Promise<void> => {
    let reply: string;
    try {
      const value = await runDisk(op, args as DiskArgs[DiskOp]);
      reply = encodeResponse(id, { ok: true, value });
    } catch (error) {
      reply = encodeResponse(id, { ok: false, error: error instanceof Error ? error : new Error(String(error)) });
    }
    send(reply);
  };

  const handle = (line: string): void => {
    let request: ReturnType<typeof decodeRequest>;
    try {
      request = decodeRequest(line);
    } catch (error) {
      const id = idOf(line);
      const message = error instanceof Error ? error.message : String(error);
      if (id !== null) send(encodeResponse(id, { ok: false, error: malformed(message) }));
      return;
    }
    inFlight += 1;
    void answer(request.id, request.op, request.args).finally(() => { inFlight -= 1; });
  };

  process.stdin.setEncoding('utf8');
  // Only the new chunk is searched for a line end, so a large `writeFile` that comes in many chunks stays linear.
  process.stdin.on('data', (chunk: string) => {
    let from = 0;
    let end = chunk.indexOf('\n');
    while (end >= 0) {
      parts.push(chunk.slice(from, end));
      const line = parts.join('');
      parts.length = 0;
      if (line.length > 0) handle(line);
      from = end + 1;
      end = chunk.indexOf('\n', from);
    }
    if (from < chunk.length) parts.push(chunk.slice(from));
  });
  process.stdin.on('end', () => {
    if (inFlight === 0) process.exit(0);
    else killSelf();
  });
  // The server is gone and no answer can reach it.
  process.stdout.on('error', killSelf);
}
