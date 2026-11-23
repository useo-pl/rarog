#!/usr/bin/env node
/**
 * Rarog's `SessionStart` context hook: in a herdr pane under Rarog's roots it adds one fact to the model's context:
 * how the app highlights a question to the user (the marker **To you:** or **Do Ciebie:**,
 * `MarkdownQuestion.swift`). So the marker works also for a user without their own style rule in Claude Code's
 * memory files.
 *
 * It runs from the COPY in `~/.claude/hooks/rarog/`, like the permission hook: Claude Code runs hooks outside the
 * sandbox, and an agent in the sandbox can change the repo checkout. The file is in `HOOK_INSTALL_FILES`, so
 * `rarog hooks install` makes the copy. Imports: `node:` modules and `./work-area.mjs` of the same copy, loaded
 * dynamically in `try` (guard `hook-granica-guard.test.ts`).
 *
 * Rules:
 * - prints JSON with `hookSpecificOutput.additionalContext` ONLY when `HERDR_ENV=1`, the input is `SessionStart`
 *   with `cwd`, and `cwd` lies under a root from `<dataDir>/roots.json` (the server writes the file at start). `source`
 *   (`startup`, `resume`, `clear`, `compact`, `fork`) does not change the text;
 * - in every other case prints nothing and exits with code 0, also on error; never code 2;
 * - writes nothing, no network; stdin at most 1 MiB within 1 s.
 *
 * The data directory and reading `roots.json` follow the same rule as in `rarog-pending.mjs` (`dataDir`, `rarogRoots`),
 * rewritten without an import: a silent import error would disable the hook without a trace. The `cwd` filter with the
 * work area rule is the one module both hooks share, `work-area.mjs`: it resolves `cwd` one segment at a time and
 * stops before an excluded folder, which a copy here would have to repeat. A missing module means no context, never a
 * wider scope.
 */
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/** Name of the file with Rarog's roots: MUST match `HOOK_ROOTS_FILENAME` in the server. */
const ROOTS_FILE = 'roots.json';
/** stdin cap: the `SessionStart` payload has a few hundred bytes. */
const STDIN_MAX_BYTES = 1024 * 1024;
/** Claude Code gives the payload at once; waiting longer would delay the session start. */
const STDIN_TIMEOUT_MS = 1000;

/**
 * Context text: a fact, not an instruction (hooks docs: context is information for the model). The full format of the
 * app renderer: a separate top-level paragraph, a bold marker at the start, a block to the end of the reply.
 */
const CONTEXT_TEXT = 'This session runs in a Rarog pane, so the user may read your replies in the Rarog phone'
  + ' app. Rarog highlights a question to the user with an orange bar when it is its own top-level paragraph (not'
  + ' inside a list, quote or heading) that starts with the bold marker **To you:**, or **Do Ciebie:** in Polish'
  + ' replies. That paragraph and everything after it, to the end of the reply, belong to the highlighted block.';

/** Entry kind by `lstat`; an error other than ENOENT propagates. */
function entryKind(target) {
  let stats;
  try {
    stats = lstatSync(target);
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.code === 'ENOENT') return 'missing';
    throw err;
  }
  if (stats.isSymbolicLink()) return 'link';
  if (stats.isDirectory()) return 'dir';
  return 'other';
}

/** The server's data directory: the `dataDir` rule from `rarog-pending.mjs`; `null` = the hook stays silent. */
function dataDir() {
  const explicit = process.env['RAROG_DATA_DIR'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const xdg = process.env['XDG_DATA_HOME'];
  try {
    const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share');
    const defaultDir = join(base, 'rarog');
    const current = entryKind(defaultDir);
    if (current === 'other') return null;
    if (current === 'link' && !statSync(defaultDir, { throwIfNoEntry: false })?.isDirectory()) return null;
    return defaultDir;
  } catch {
    return null;
  }
}

/**
 * Roots from `<dataDir>/roots.json`; `null` = no file, bad JSON or an empty list. `exclude`: absent = a
 * server from before (roots only), a list of absolute paths = the work area rule; anything else gives `null`, like
 * `rarog-pending.mjs`, because a broken field must not widen the area.
 */
function rarogRoots(dir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(dir, ROOTS_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const raw = parsed['roots'];
  if (!Array.isArray(raw)) return null;
  const roots = raw.filter((entry) => typeof entry === 'string' && entry !== '');
  const hasExclude = Object.hasOwn(parsed, 'exclude');
  const exclude = hasExclude ? parsed['exclude'] : null;
  if (hasExclude && !(Array.isArray(exclude) && exclude.every((entry) => typeof entry === 'string'
    && entry.startsWith(sep)))) return null;
  return roots.length === 0 ? null : { roots, exclude };
}

/** `cwd` in the roots by its path on disk, with the work area rule (`work-area.mjs`); a module error = outside. */
async function insideRoots(cwd, config) {
  try {
    const area = await import(new URL('./work-area.mjs', import.meta.url).href);
    return area.insideRoots(cwd, config.roots, config.exclude) === true;
  } catch {
    return false;
  }
}

/** All of stdin up to the cap and the time limit; `''` when exceeded, without a stream, or on error. */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (text) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(text);
    };
    const timer = setTimeout(() => { finish(''); }, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > STDIN_MAX_BYTES) finish('');
      else chunks.push(chunk);
    });
    process.stdin.on('end', () => { finish(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { finish(''); });
  });
}

/** Text to print on stdout, or `null` (nothing). */
async function main() {
  const raw = await readStdin();
  if (process.env['HERDR_ENV'] !== '1' || raw === '') return null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload['hook_event_name'] !== 'SessionStart') return null;
  const cwd = payload['cwd'];
  if (typeof cwd !== 'string' || cwd === '') return null;
  const dir = dataDir();
  if (dir === null) return null;
  const roots = rarogRoots(dir);
  if (roots === null || !(await insideRoots(cwd, roots))) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT_TEXT } });
}

// The only exit: code 0, stdout empty or one JSON line. An exception must not reach stderr or a code ≠ 0.
main().then(
  (text) => {
    if (text === null) process.exit(0);
    process.stdout.write(`${text}\n`, () => { process.exit(0); });
  },
  () => { process.exit(0); },
);
