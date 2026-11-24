/**
 * The two system reads of the consent-without-hook detector (`consent-no-hook.ts`): whether `ps` shows Rarog's hook
 * as a child of the session process, and how fresh the session's `statusLine` dump is. Each read gives an answer or
 * "unknown"; neither throws, and neither reads a file's content.
 */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { StatuslineFreshness } from '../../herdr/dialogs/index.ts';
import { STATUSLINE_FRESH_MS } from '../../herdr/hook-config.ts';
import { statuslinePath } from '../../herdr/statusline.ts';

/** `ps` from an absolute path (macOS and Linux), without the server's `PATH`. */
const PS_PATH = '/bin/ps';

/** Every process with its parent and its arguments, unwrapped: the hook is a direct child of the session process. */
const PS_ARGS = ['-A', '-ww', '-o', 'ppid=,args='] as const;

/**
 * Ceiling of the `ps` run; it runs once per judgement of a consent dialog without a hook trace, off the card's path. A
 * registry that stops saying `waiting: permission` during the facts read gives the episode one more judgement.
 */
const PS_TIMEOUT_MS = 1_000;

/** Ceiling of the `ps` output (every process of the machine). */
const PS_MAX_BUFFER = 8 * 1024 * 1024;

/** One `ps` run: its output, or `null` on an error, a timeout or a non-zero exit (`ps` under a sandbox exits 71). */
export type PsRun = (args: readonly string[]) => Promise<string | null>;

const runPs: PsRun = (args) => new Promise((resolve) => {
  execFile(PS_PATH, [...args], { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, encoding: 'utf8' }, (err, out) => {
    resolve(err === null ? out : null);
  });
});

/** The interpreter of the hook command, by its name or its path. */
const NODE = /(?:^|\/)node$/;

/**
 * Whether the arguments of one process are the hook command: `node`, then `script` as its first argument, then the end
 * or a space. `ps` joins the arguments with spaces, so with whitespace in the interpreter or in `script` the bounds of
 * the arguments are not settled: `null`.
 */
function hookArgs(args: string, script: string): boolean | null {
  const needle = ` ${script}`;
  for (let at = args.indexOf(needle); at !== -1; at = args.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (end < args.length && args[end] !== ' ') continue;
    const interpreter = args.slice(0, at);
    if (!NODE.test(interpreter)) continue;
    return /\s/.test(interpreter) || /\s/.test(script) ? null : true;
  }
  return false;
}

/**
 * Whether a child of the process `pid` runs the hook script `script` (`node <home>/.claude/hooks/rarog/rarog-pending.mjs
 * --answer-wait=…`, measured on CLI 2.1.330: a direct child of the session's `claude` process, also for a subagent's
 * dialog). `null` = `ps` unavailable, its output unreadable or a child whose arguments may be the hook but whose
 * argument bounds `ps` does not settle: never "no hook".
 */
export async function hookChildRunning(pid: number, script: string, run: PsRun = runPs): Promise<boolean | null> {
  const out = await run(PS_ARGS).catch((): null => null);
  if (out === null) return null;
  let rows = 0;
  let unsettled = false;
  for (const line of out.split('\n')) {
    const row = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (row === null) continue;
    rows += 1;
    if (Number(row[1]) !== pid) continue;
    const hook = hookArgs(row[2] ?? '', script);
    if (hook === true) return true;
    if (hook === null) unsettled = true;
  }
  // A run that lists no process at all did not list this machine's processes.
  return rows === 0 || unsettled ? null : false;
}

/**
 * Freshness of the session's `statusLine` dump (`<root>/<session>.json`) by its modification time: `fresh` within
 * {@link STATUSLINE_FRESH_MS} of `now`, `stale` older, `none` without a regular file there. It is an observation in
 * the log line, not a cause: the dump refreshes on events only.
 */
export async function statuslineFreshness(root: string, engineSessionId: string, now: number): Promise<StatuslineFreshness> {
  try {
    const file = await stat(statuslinePath(root, engineSessionId));
    if (!file.isFile()) return 'none';
    return now - file.mtimeMs <= STATUSLINE_FRESH_MS ? 'fresh' : 'stale';
  } catch {
    return 'none';
  }
}
