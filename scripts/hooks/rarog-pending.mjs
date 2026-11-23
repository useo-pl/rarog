#!/usr/bin/env node
/**
 * Claude Code hook: dumps to a file WHAT the session is STOPPED on, so that Rarog can show a card with the full
 * content on the phone.
 *
 * TWO events, two different roles:
 * - `PermissionRequest`: fires when a permission request enters the dialog queue: with a single dialog that is the
 *   moment the dialog appears on screen. With a QUEUE ("1 of 2", two parallel calls that need permission) the hook
 *   fires for each request at once, so the second one's dump overwrites the first one's, although the screen shows the
 *   first (measured on CLI 2.1.302). It also covers `ExitPlanMode`: the payload then carries the full plan text. The
 *   dump key stays per SESSION, because `tool_use_id` is ABSENT in this event (the `/hooks` screen claims otherwise and
 *   is wrong: the payload counts).
 * - `PreToolUse` ONLY for `AskUserQuestion`: the question content (header, option descriptions,
 *   `multiSelect`) sits in `tool_input` and nowhere else. This hook must finish
 *   AT ONCE: while `PreToolUse` waits, the form does NOT render in the terminal
 *   (measured). There is no dump for EVERY tool: it would give stale files and a write on every
 *   `Read`.
 *
 * WHY it does not decide PERMISSIONS by itself: both events may return a decision
 * (`hookSpecificOutput`). This hook does not ALLOW a tool on its own judgement: a permission comes from a KEY
 * on the screen or, in consent channel mode (section below), ONLY from Rarog's signed answer file
 * after a human's decision on the device. Rarog interprets nothing. The contract for tools
 * outside the guard and the channel: exit 0, stdout EMPTY; it waits in shadow mode and leaves it without a result.
 * Every error (no HOME, full disk, a garbage payload) ends silently with exit 0: a hook
 * plugged into EVERY Claude session on this Mac must not break anyone's work.
 *
 * CONSENT CHANNEL (layer 1): when `alive.json` carries mode `main` (a main-thread request, without `agent_id`)
 * or `all`, is fresh, `send: true` and the session is on the list, a tool permission request skips the tall dialog
 * guard and goes through the `consent.mjs` module: the secret on the socket `<dataDir>/run/consent.sock` BEFORE the
 * per-call dump and before the log line with the key, then the dump, then waiting for the file
 * `<dataDir>/consent/<session>/<key>.json`, which the hook first claims (`rename` to `.claimed`), and only
 * then reads and verifies. A valid file gives `allow` (without `updatedInput`, except `ExitPlanMode`), a bare `deny`
 * with an English text from the list in `consent.mjs`, or silence (`release`). An invalid file goes aside
 * (`.rejected`), the wait goes on. A missing module, a refusal or the registration deadline, a mode lower than at
 * registration and a new `bootId` in `alive.json` (outside a restart break, below) end the hook WITHOUT a decision:
 * the dialog stays at the desk.
 * A valid `allow` goes out only after the server's receipt (`POST /claim`, `consent.mjs`); without it the hook
 * exits without a decision too. `deny` and `release` need no receipt.
 *
 * RESTART BREAK (`consent.mjs`, `waitThroughRestart`): a hook that starts on `stop` or `phase: "starting"` in
 * `alive.json` waits (`pauza`) for the next server's channel before the marker and the route, then takes the usual
 * path; past the break it exits after the per-session dump without a decision (`przerwa`). A registered hook pauses
 * on such a break too and registers again with the same body (`waitResuming`): only `resumed` lets it wait on.
 *
 * PER-CALL DUMP AND SHADOW MODE (contract: `server/src/herdr/dialogs/hook/contract.ts`). On a
 * `PermissionRequest` for a tool other than `AskUserQuestion` the hook writes, next to the per-session dump,
 * the dump `pending/<session>/<key>.json` with the key `<prompt_id>-<nonce 16 B hex>`, the PID, the process start
 * and the full sha256 of the canonical `tool_input` (`canon.mjs`). The dump lives as long as the process: the hook
 * deletes it on every exit, also after SIGTERM. Then it reads `<dataDir>/alive.json` and WAITS only
 * when all hold: the file is fresh (`ts` at most 30 s), mode `shadow`, `send: true`, the session on the `sessions`
 * list, a request without `agent_id`, the dump not truncated. While waiting, at every poll it reads `alive.json` again
 * (a condition that stopped holding ends the hook without a result), claims the shadow file
 * `shadow/<session>/<key>.json` (`rename` to `<key>.claimed`) or sees `<key>.revoked`. Each
 * of these exits is WITHOUT A RESULT: shadow mode checks the addressing of decisions, and the permission still comes
 * from a key. No `alive.json` (the server does not write it) = mode `off` = behavior without shadow mode plus the
 * per-call dump for the life of the process and the `shadow.jsonl` lines. The hook appends the whole cycle (start,
 * waiting or not waiting with a reason, claim, signal, exit with a reason and time) to `<dataDir>/shadow.jsonl`,
 * without the `tool_input` content. `czekam` and an exit on an `alive.json` veto carry `bootId` and `ts` of the file
 * read (`aliveTs`), and `czekam` also the input digest: from them the shadow audit computes the time from a flag
 * change to the exit.
 *
 * REQUEST MARKER (`HookMarkerFile` in the contract). For the same request, when `alive.json` has a valid shape and is
 * fresh, the session is on the list, the mode is `main` or `all` and the `markers` field is literally `true`, the hook
 * writes `<dataDir>/markers/<session>/<name>.json` (0600 in a 0700 directory, a temporary file and `rename`): after
 * validating `session_id`, `cwd` and the roots and after the canon digest, BEFORE choosing the path, that is before the
 * tall dialog guard, the consent channel, shadow mode, registration, truncation and every exit without waiting. The
 * marker tells the server the request exists, also when the hook exited before the server saw its per-call dump. The
 * hook draws the per-call key ONCE (`callKeyFor` in `main`), and the same key with the same nonce is carried by the
 * marker name, the per-call dump and the consent channel registration. Without a key (`prompt_id` is not fit for a file
 * name) the name is `anon-<pid>-<startedAt>`, and the `key` field is `null`. Fields as in the per-call dump, without
 * `permissionMode`; `inputSha256` is `null` when `canon.mjs` did not load or threw. The hook NEVER deletes the marker
 * (the server cleans up), and it swallows a write error. A server without the `markers` field (or with another value),
 * mode `shadow` or `off`, a stale or broken file or one without this session = no marker, and the rest of the hook is
 * unchanged to the byte; an older hook does not read the field. Nothing closes the window before the write: Node start,
 * the `canon.mjs` import and the digest (a main-thread dialog stands from the hook's start), a signal before the write
 * and a write error leave the request without a marker, as without this feature.
 *
 * TALL DIALOG GUARD: the hook's only decision without a human, and only a FORM REFUSAL: `PermissionRequest` for `Bash`,
 * in a herdr session (`HERDR_ENV=1`), under Rarog's roots, when `roots.json` carries `tallDialogGuard: true`. If the
 * permission dialog would be taller than the pane the session stands in (estimate in `tall-dialog.mjs`; geometry from
 * `COLUMNS` and `LINES` of the hook's environment, at most the phone, without them the phone), the hook returns `deny`
 * with the message "this is not a block, split into shorter calls, one after another". Reason: a tall dialog hides the
 * title and the start of the command above the edge, and a subagent's permission then has no double proof: a card
 * without buttons, a human cannot approve it from the phone. The refusal writes no dump to `pending/` (there will be no
 * dialog, and an existing dump, e.g. of a standing question, stays untouched), refreshes `hook-seen.json` and appends a
 * line to `<dataDir>/guard.jsonl` (time, session, whether a subagent, estimate, budget, budget source and pane
 * geometry: no command content). A request LET THROUGH carries the budget source and the geometry in the dump, so that
 * a later card without a decision has the pane size at the moment of the hook in the log. A module load error or an
 * estimate error = behavior without the guard; a write error of the marker or the refusal log line does not stop
 * anything (both are diagnostics, and the model sees the refusal in its transcript anyway).
 *
 * ONE EXCEPTION: THE ANSWER CHANNEL: `PermissionRequest` for `AskUserQuestion`. After dumping the question the hook
 * WAITS (polling every 250 ms, up to `--answer-wait`) for the file `<dataDir>/answers/<session_id>/<key>.json` written
 * by Rarog, and only then returns `allow` with `updatedInput.answers`. This is not a tool permission: `AskUserQuestion`
 * executes nothing, and `answers` is LITERALLY the human's answer: the same one they would type as digits in the
 * terminal. Measured (CLI 2.1.257): the form renders and accepts keys the whole time the hook sleeps, and a decision
 * from the DESK wins the race both ways (on `Esc` the CLI kills the hook, on a digit it silently ignores the hook's
 * late `allow`). The file can also carry the human's NOTES for the chosen option (`annotations`: `notes` and a literal
 * option preview): part of the same answer, checked in `readAnnotations` before handing it to the CLI.
 *
 * The answer file KEY is `<prompt_id>-<sha256(tool_input.questions) to 16 characters>-<nonce>`.
 * `prompt_id` alone is NOT ENOUGH: two `AskUserQuestion` in one turn of the main agent have it
 * IDENTICAL and run in parallel, and the main-thread `PermissionRequest` payload carries neither
 * `tool_use_id` nor `agent_id`. The only thing that tells these two questions apart is the
 * `tool_input` content, and that is what goes into the key. The key also goes to the dump (`answerKey`), so that
 * Rarog does not compute it a second time and a mismatch is impossible. A SUBAGENT's payload carries
 * `agent_id` and `agent_type` (measured on CLI 2.1.302): the guard records only
 * "subagent yes/no" from it, and the dump only `agentId`, solely for Rarog's log.
 *
 * NONCE: `prompt_id` + content digest do NOT tell apart two IDENTICAL calls of the same turn: a repeated question (the
 * same content, the same `prompt_id`) would give exactly the same key without it. And the process of a hook resolved by
 * a DIGIT at the desk lives on (the CLI does not kill it, only ignores its late `allow`, measured) and watches only its
 * key, so it could eat the answer file meant for the NEXT call. Random 8 bytes make every key single-use: the old
 * process waits for a file nobody will write any more, and after the dump is overwritten (`dumpStillMine` sees another
 * `answerKey`) it ends silently. The command in the hooks block does NOT change, so `hooks:doctor` does not show
 * `mismatch`.
 *
 * The `cwd` FILTER: the entry in `~/.claude/settings.json` covers all sessions on the account, also
 * client repositories. We write ONLY for directories lying in Rarog's roots, read
 * from `<dataDir>/roots.json` (the server keeps the file at start from `RAROG_HERDR_ROOTS`). No
 * file or a `cwd` outside the roots = exit 0 without writing and without a trace. Fail-closed: when we do not know
 * where we may write, we do not write.
 * Work area: when `roots.json` has `exclude` (the macOS-protected folders of home), a `cwd` in a hidden entry
 * of a root (`~/.cache/…` under the root `~`) or in an excluded folder that no root lies in counts as outside, checked
 * on the path as given before any disk access and again on the resolved path. The path is resolved one segment at a
 * time (`work-area.mjs`), which stops before an excluded folder: a link into `~/Desktop` or a root that is a symlink to
 * home gets no read there. Without the field: roots only; a field that is not a list of absolute paths: no action.
 *
 * PROGRAMMATIC SESSIONS: `claude -p` and Agent SDK clients have no human at the screen, and Rarog does not serve them
 * (the list of sessions to resume hides them too, `includeProgrammatic: false`). When `CLAUDE_CODE_ENTRYPOINT` is
 * `sdk-cli`, `sdk-ts` or `sdk-py`, the hook exits right after reading stdin: exit 0, empty stdout, zero writes: no
 * dump, `hook-seen.json`, `shadow.jsonl` or `guard.jsonl` lines, no waiting and no guard refusal. The trace is the same
 * as for a `cwd` outside the roots, that is none. Any other value or no variable = unchanged behavior. We read stdin
 * BEFORE the condition, so that the CLI does not get EPIPE when writing the payload. The variable is neither in the
 * payload nor in the Claude Code docs; the hook inherits it from the CLI process. Measured on CLI 2.1.314: `claude -p`
 * without the variable and with an inherited `cli` gives the hook `sdk-cli`, an interactive session `cli`, and an
 * interactive session with an inherited `sdk-cli` keeps it. `sdk-ts` and `sdk-py` are not measured; the hook treats
 * them as programmatic too, by their name. A known, accepted mistake: an interactive `claude` started
 * with a programmatic session's environment loses Rarog's hooks: the card goes back to the screen, there is no wrong
 * permission. Panes Rarog creates clear the variable (`DEFAULT_CLAUDE_ENV_CLEAR`).
 *
 * Plain Node, zero dependencies: the hook starts in someone else's process and cannot pull
 * `node_modules` or wait for imports from the Rarog repo to resolve. Claude Code runs a
 * COPY of this file from `~/.claude/hooks/rarog/` (made by `pnpm run hooks:install`, together
 * with `tall-dialog.mjs`, `canon.mjs`, `consent.mjs` and `work-area.mjs`), so the imports are only `node:`,
 * `./tall-dialog.mjs`, `./canon.mjs`, `./consent.mjs` and `./work-area.mjs`, all modules dynamically in `try`:
 * `server/test/hook-granica-guard.test.ts` checks this.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, lstatSync, mkdirSync, readFileSync, renameSync,
  rmdirSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The same pattern as `ENGINE_SESSION_ID_PATTERN` on the server side (transcript-import.ts). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The only tool we take `PreToolUse` for: see the header. */
const QUESTION_TOOL = 'AskUserQuestion';

/** Name of the file with Rarog's roots: MUST match `HOOK_ROOTS_FILENAME` in the server. */
const ROOTS_FILE = 'roots.json';

/** The "hook is alive" marker: MUST match `HOOK_SEEN_FILENAME` in the server. */
const SEEN_FILE = 'hook-seen.json';

/**
 * Marker PER ENTRY FILE: `hook-seen.<file name without .mjs>.json` next to the shared one. The same code
 * lies in the copy under both file names, so the server and doctor see which command Claude Code
 * calls. The name shape MUST match `HOOK_SEEN_PER_FILE_RE` in the server; a file outside the pattern writes no
 * per-file marker.
 */
const SEEN_PER_FILE = (() => {
  const stem = basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '');
  return /^[a-z][a-z0-9-]{0,63}$/.test(stem) ? `hook-seen.${stem}.json` : null;
})();

/** Directory of answer files: MUST match `HOOK_ANSWERS_DIRNAME` in the server. */
const ANSWERS_DIR = 'answers';

/** The event in which (and only in which) the hook waits for an answer from Rarog. */
const PERMISSION_REQUEST_EVENT = 'PermissionRequest';

/**
 * Environment variable with the CLI session entry point: MUST match `HOOK_PROGRAMMATIC_ENTRYPOINT.env`
 * in the contract. See the header, "PROGRAMMATIC SESSIONS".
 */
const ENTRYPOINT_ENV = 'CLAUDE_CODE_ENTRYPOINT';

/** Programmatic session values at which the hook does nothing: `HOOK_PROGRAMMATIC_ENTRYPOINT.values`. */
const PROGRAMMATIC_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);

/** The only tool whose dialog the tall dialog guard watches. */
const GUARD_TOOL = 'Bash';

/**
 * Guard refusal log: MUST match `HOOK_GUARD_LOG_FILENAME` in the server. The hook only
 * APPENDS; the server rotates it (`.1` at 1 MB) at start, in one process: two parallel
 * hooks rotating the same file could overwrite `.1` with one entry.
 */
const GUARD_LOG_FILE = 'guard.jsonl';

/**
 * Poll interval of the answer file, the shadow file and `alive.json`: MUST match `HOOK_POLL_MS`
 * in the contract. Shorter = more `stat` for nothing, longer = a sluggish card and a slower release.
 */
const ANSWER_POLL_MS = 250;

/** Server life file: MUST match `HOOK_ALIVE_FILENAME` in the contract. The hook only reads it. */
const ALIVE_FILE = 'alive.json';

/** Age of `ts` in `alive.json` (both ways of the clock) above which the hook does not wait: `HOOK_ALIVE_MAX_AGE_MS`. */
const ALIVE_MAX_AGE_MS = 30000;

/** Consent channel modes from `alive.json`: MUST match `HOOK_ALIVE_MODES` in the contract. */
const MODE_OFF = 'off';
const MODE_SHADOW = 'shadow';
const MODE_MAIN = 'main';
const MODE_ALL = 'all';

/** All modes this hook version knows. Any other string in `mode` = `tryb-nieznany`. */
const ALIVE_MODES = new Set([MODE_OFF, MODE_SHADOW, MODE_MAIN, MODE_ALL]);

/** Directory of shadow files: MUST match `HOOK_SHADOW_DIRNAME` in the contract. The server writes them. */
const SHADOW_DIR = 'shadow';

/** Shadow file suffixes: claimed by the hook and revoked by the server (`HOOK_SHADOW_*_SUFFIX`). */
const CLAIMED_SUFFIX = '.claimed';
const REVOKED_SUFFIX = '.revoked';

/**
 * Shadow mode cycle log: MUST match `HOOK_SHADOW_LOG_FILENAME` in the contract. The hook only
 * APPENDS, like `guard.jsonl`; rotation belongs to the server.
 */
const SHADOW_LOG_FILE = 'shadow.jsonl';

/** Per-call key nonce IN BYTES (32 hex characters): `HOOK_CALL_NONCE_BYTES` in the contract. */
const CALL_NONCE_BYTES = 16;

/**
 * Directory of request markers (header, "REQUEST MARKER"): MUST match `HOOK_MARKERS_DIRNAME` in the contract.
 * The hook only writes, never deletes; the server cleans up.
 */
const MARKERS_DIR = 'markers';

/** Prefix of a marker name without a key, `anon-<pid>-<startedAt>`: `HOOK_MARKER_ANON_PREFIX` in the contract. */
const MARKER_ANON_PREFIX = 'anon-';

/** Tool name in a `shadow.jsonl` line: the same pattern as the server's dump reader, otherwise `?`. */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

/** Process start (epoch ms): with the PID in the per-call dump it tells this process from a reused PID. */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);

/**
 * Cap on ONE value in `answers`: the third and last length gate of free text.
 *
 * Rarog cuts at `MAX_ANSWER_TEXT_CHARS` (2000 characters per value) in the body schema and in the manager;
 * here the cap is looser, because a multiple choice joins several values with a comma, and the hook
 * does not know how many there were. It follows the same principle as `TOOL_INPUT_MAX_BYTES`: a value that
 * grew beyond any real case must not leave the hook for the model. Exceeding it =
 * REJECTING the file (fail-closed), not cutting: a cut human answer is a different answer.
 */
const ANSWER_VALUE_MAX_CHARS = 8 * 1024;

/**
 * Cap on ONE note in `annotations`: Rarog's cap, unmeasured in the CLI. MUST match
 * `MAX_ANSWER_NOTE_CHARS` from `shared/src/rest.ts`. Exceeding it = REJECTING the file, not
 * cutting (as with `answers`).
 */
const ANSWER_NOTE_MAX_CHARS = 8192;

/**
 * Cap on the SUM of answers and notes in UTF-16 units (`string.length`): Rarog's cap,
 * unmeasured in the CLI. MUST match `MAX_ANSWERS_TOTAL_CHARS` from `shared/src/rest.ts`.
 */
const ANSWERS_TOTAL_MAX_CHARS = 32768;

/**
 * Default wait cap IN SECONDS: used when the command has no `--answer-wait`.
 *
 * MUST match `HOOK_ANSWER_WAIT_S` from `server/src/herdr/hook-config.ts` (86 400 − 2, a day). The value
 * from the registration takes precedence over this constant, so it comes as an argument: a hook waiting longer
 * than its `timeout` allows is killed silently and has no way to report it.
 */
const ANSWER_WAIT_DEFAULT_S = 86_398;

/**
 * Ceiling of the serialized `tool_input` in UTF-8 bytes (`HOOK_TOOL_INPUT_MAX_BYTES` in the server's hook contract).
 * A `Write` or `Edit` input can be a whole file and `ExitPlanMode` a whole plan. Over it every dump carries the
 * truncation marker, never an exception: a card that says it shows a fragment beats no card.
 */
const TOOL_INPUT_MAX_BYTES = 1024 * 1024;

/** Ceiling of the marker's `preview` in UTF-8 bytes: enough to show the card is a fragment, small on disk. */
const TRUNCATED_PREVIEW_MAX_BYTES = 64 * 1024;

/** Cap on the stdin payload alone: above it we give up, because it would be truncated anyway. */
const STDIN_MAX_BYTES = 4 * 1024 * 1024;

/** Entry kind by `lstat` (a symlink is NOT a directory); an error other than ENOENT propagates. */
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

/**
 * Data directory: MUST match the server's `dataDir`, because the reader (`server/src/herdr/pending-hook.ts`) looks
 * exactly there. It is THE SAME rule as `resolveDataDir` from `shared/src/data-dir.mjs`,
 * rewritten without an import: the hook serves every Claude session on this Mac, and a silent import error would
 * disable all cards without a trace in `/health` (the same principle as for the tall dialog guard below). The parity
 * test `server/test/data-dir.test.ts` checks the equality (this hook in a subprocess on the module's state matrix).
 *
 * Non-empty `RAROG_DATA_DIR` → that path; base = `XDG_DATA_HOME` or `~/.local/share`; `<base>/rarog` missing, a
 * directory or a symlink to a directory → `<base>/rarog`. Any other state and any read error → `null`: the hook stays
 * silent and WRITES NOTHING, because the server does not start in this state, and a write in a guessed directory
 * would create it anew.
 */
function dataDir() {
  const explicit = process.env['RAROG_DATA_DIR'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const xdg = process.env['XDG_DATA_HOME'];
  try {
    const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share');
    const defaultDir = join(base, 'rarog');
    const current = entryKind(defaultDir);
    if (current === 'other') return null;
    // The symlink must lead to a directory; no target = `null`, a loop throws (ELOOP) = `null`.
    if (current === 'link' && !statSync(defaultDir, { throwIfNoEntry: false })?.isDirectory()) return null;
    return defaultDir;
  } catch {
    return null;
  }
}

/** Reads all of stdin. Returns `''` when there is no stream or it broke off with an error. */
async function readStdin() {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > STDIN_MAX_BYTES) return '';
      chunks.push(chunk);
    }
  } catch {
    return '';
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Rarog's roots from `<dataDir>/roots.json` (`{"roots": ["/abs/…"], "exclude"?: […], "tallDialogGuard"?: true}`).
 *
 * `null` means "unknown" and equals a write ban: there is no file (the server never
 * started or writes to another `dataDir`), broken JSON, an empty list. `tallDialogGuard` is
 * on ONLY with a literal `true`: the server writes the field from the `RAROG_TALL_DIALOG_GUARD` flag,
 * and its absence (a server without the field, flag `0`) means "no guard".
 * `exclude`: absent = a server from before, roots only. When present it must be a list of absolute paths;
 * anything else (`null`, a string, one bad entry) gives `null` as well, because a broken field must not widen the area.
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
  return roots.length === 0 ? null : { roots, exclude, tallDialogGuard: parsed['tallDialogGuard'] === true };
}

/**
 * The `cwd` filter of the header: `insideRoots` of `work-area.mjs`, loaded dynamically like the other
 * modules of the copy. A missing or broken module means `false`, so the hook does nothing, as for a `cwd` outside.
 */
async function insideRoots(cwd, config) {
  try {
    const area = await import(new URL('./work-area.mjs', import.meta.url).href);
    return area.insideRoots(cwd, config.roots, config.exclude) === true;
  } catch {
    return false;
  }
}

/**
 * `tool_input` in a form fit for writing: either the original or a truncation marker.
 *
 * The marker is READABLE for a human (it goes to the card literally), not a silent cut:
 * the user must see they are looking at a fragment.
 */
function cappedToolInput(toolInput) {
  let serialized;
  try {
    serialized = JSON.stringify(toolInput ?? null);
  } catch {
    // A cycle or a `toJSON` that throws: we have nothing to write, but the tool name stays.
    return { rarogTruncated: true, preview: '' };
  }
  if (serialized === undefined) return { rarogTruncated: true, preview: '' };
  if (Buffer.byteLength(serialized, 'utf8') <= TOOL_INPUT_MAX_BYTES) return toolInput ?? null;
  return {
    rarogTruncated: true,
    /*
     * Cut on BYTES, the measure of the ceilings. A cut on characters
     * (`serialized.slice(0, TRUNCATED_PREVIEW_MAX_BYTES)`) would not keep the ceiling: in UTF-8 one character is
     * 1–4 bytes, so a plan in Polish or a diff with emoji would grow to ~256 kB at a 64 kB ceiling.
     *
     * `TextDecoder` with `stream: true` HOLDS BACK a sequence cut at the end instead of turning
     * it into `U+FFFD`: the replacement character takes 3 bytes, so a plain `toString` could
     * go over the very ceiling we cut at.
     */
    preview: new TextDecoder('utf-8').decode(
      Buffer.from(serialized, 'utf8').subarray(0, TRUNCATED_PREVIEW_MAX_BYTES), { stream: true },
    ),
  };
}

/**
 * Data directory this process writes in (`main` sets it after reading the roots). The hook does NOT create it: the
 * server does, and `roots.json` in it is the condition of every write.
 */
let dataRoot = null;

/**
 * Write directory under the data directory, WITHOUT `recursive`: the data directory itself must already exist, and
 * the subdirectories (`pending/`, `pending/<session>/`) are created one segment at a time. A hook that read the roots
 * before a `mv` of the data directory gets ENOENT and stays silent, instead of recreating the old directory next to
 * the moved one. A directory outside the data directory is an error, not a write.
 */
function ensureDir(dir) {
  if (dataRoot === null) throw new Error('data directory not set');
  const rel = relative(dataRoot, dir);
  if (rel === '') return;
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error('write directory outside the data directory');
  }
  let current = dataRoot;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (err) {
      if (err === null || typeof err !== 'object' || err.code !== 'EEXIST') throw err;
    }
  }
}

/** Atomic write: tmp in THE SAME directory + rename. The reader never sees half a file. */
function writeAtomic(dir, file, body) {
  ensureDir(dir);
  // Random suffix and `wx`: under a predictable name `<file>.<pid>.tmp` a symlink could redirect the write, and
  // `rename` would put it in place of the dump. An existing name, symlink included, is an error, not a write through
  // it.
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup: a tmp without rename is not seen by the reader anyway.
    }
    throw err;
  }
}

/**
 * The "hook is alive" marker: the only trace by which `/health` and `hooks:doctor` know that the hook
 * is INSTALLED AND FIRES, not only listed in the settings file.
 *
 * A separate file, because the dump itself is DELETED after a decision from Rarog (`clearPendingHook`): counting
 * the age from the content of `pending/` would say "never" in exactly those sessions where the hook
 * works best.
 *
 * Next to the shared marker the same content goes to the per-entry-file marker ({@link SEEN_PER_FILE}).
 */
function markSeen(dir, event, toolName) {
  const body = `${JSON.stringify({ at: Date.now(), event, toolName })}\n`;
  writeAtomic(dir, join(dir, SEEN_FILE), body);
  if (SEEN_PER_FILE === null) return;
  try {
    writeAtomic(dir, join(dir, SEEN_PER_FILE), body);
  } catch {
    // The per-file marker is diagnostics: its error does not change the hook's course.
  }
}

/** Guard budget sources: MUST match `BUDGET_SOURCES` from `tall-dialog.mjs` (a test checks). */
const BUDGET_SOURCES = new Set(['pane', 'phone', 'floor']);

/** Pane dimension in the log and dump field: a positive integer (the module caps it at 1000). */
const isDimension = (value) => Number.isInteger(value) && value > 0;

/**
 * Guard fields for the log and the dump: the budget source and the pane geometry, when it was valid.
 * `null` = the module's result does not have a shape we know (then as without the guard).
 */
function guardFields(budget) {
  if (budget === null || typeof budget !== 'object' || !BUDGET_SOURCES.has(budget.source)) return null;
  const known = isDimension(budget.paneRows) && isDimension(budget.paneCols);
  return {
    budgetSource: budget.source,
    ...(known ? { paneRows: budget.paneRows, paneCols: budget.paneCols } : {}),
  };
}

/**
 * Result of the tall dialog guard: the verdict (`null` = the dialog fits) and the fields for the log or the dump.
 * The whole `null` means "behave as without the guard".
 *
 * We load the estimate module DYNAMICALLY and only here: a broken or missing `tall-dialog.mjs`
 * must not knock over a hook that serves every Claude session on this Mac. Every exception
 * (import, estimate, result shape) gives `null`. The module reads and checks the geometry (`COLUMNS`, `LINES`):
 * the hook passes the raw strings from the environment, without a spawn and without the herdr socket.
 */
async function tallDialogGuard(toolInput, columns, lines) {
  try {
    const guard = await import(new URL('./tall-dialog.mjs', import.meta.url).href);
    const pane = guard.paneFromEnv(columns, lines);
    const fields = guardFields(guard.dialogBudget(pane));
    if (fields === null) return null;
    const verdict = guard.tallDialogVerdict(toolInput, pane);
    if (verdict === null) return { verdict: null, fields };
    if (typeof verdict !== 'object') return null;
    if (typeof verdict.message !== 'string' || verdict.message === '') return null;
    return { verdict, fields };
  } catch {
    return null;
  }
}

/**
 * Guard log line: numbers, never the command or description content, so that the lines can be summed.
 * One write with the `a` flag (`O_APPEND`): parallel hooks append short lines without overwriting
 * each other. Best-effort: an exception goes back to the caller, which swallows it.
 */
function appendGuardLog(dir, entry) {
  ensureDir(dir);
  appendFileSync(join(dir, GUARD_LOG_FILE), `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: 'a' });
}

/**
 * Nonce length IN BYTES (16 hex characters in the key): see the header, section NONCE.
 *
 * The key is a FILE NAME and enters `ANSWER_KEY_PATTERN` on Rarog's side (`server/src/herdr/answers.ts`, cap 192
 * characters): `prompt_id` (up to 128) + `-` + 16 characters of digest + `-` + 16 characters of nonce is at most 162
 * characters, so it fits with a margin. Hex, because only letters and digits: base64 would bring `/` and `+` into the
 * file name.
 */
const ANSWER_NONCE_BYTES = 8;

/**
 * Answer file key: `<prompt_id>-<sha256(questions) to 16 characters>-<nonce>`: see the header.
 *
 * `null` means "this question cannot be addressed" (no `prompt_id`, a shape from somewhere
 * else, a cycle in `tool_input`) and equals having no answer channel: the dump is made
 * the usual way, the hook does not wait, the decision comes from a digit.
 */
function answerKeyFor(promptId, toolInput) {
  if (typeof promptId !== 'string' || !SESSION_ID_PATTERN.test(promptId)) return null;
  const questions = toolInput === null || typeof toolInput !== 'object'
    ? undefined
    : toolInput['questions'];
  let serialized;
  try {
    serialized = JSON.stringify(questions ?? null);
  } catch {
    return null;
  }
  if (serialized === undefined) return null;
  const digest = createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 16);
  // Nonce computed ON EVERY hook call: two identical questions of one turn (and the same
  // question repeated) have different keys, so the answer file reaches ONE process.
  return `${promptId}-${digest}-${randomBytes(ANSWER_NONCE_BYTES).toString('hex')}`;
}

/**
 * Answers from Rarog's file, or `null` (no file, it does not match, it is stale).
 *
 * There are three conditions and all must hold: the file is about THIS session, THIS key (that is this
 * `prompt_id` and this question content), and it was made NO EARLIER than the dump it answers.
 * The last condition cuts off an answer that stayed in the directory after the PREVIOUS question: Rarog
 * deletes it itself, but its process could have vanished between the write and the cleanup.
 *
 * Values must be strings; the CLI does not validate them against `options[].label`,
 * so free text goes literally to the model, and that is intended, but not ARBITRARILY long:
 * a value over `ANSWER_VALUE_MAX_CHARS` rejects the WHOLE file, because the hook must not give the model
 * an answer nobody measured (cutting would change the content, and that is a different answer).
 *
 * The file can carry NOTES (`annotations`): see {@link readAnnotations}. Any error in the
 * notes rejects the WHOLE file: an answer without a note the human wrote would be a different
 * answer, and Rarog then does not fall back to a digit (an explicit refusal on its side).
 *
 * @returns `{ answers, annotations }` (`annotations` = `null` when the file carries none) or `null`
 */
function readAnswers(file, sessionId, key, notBefore, toolInput) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  if (parsed['sessionId'] !== sessionId) return null;
  if (parsed['key'] !== key) return null;
  const at = parsed['at'];
  if (typeof at !== 'number' || !Number.isFinite(at) || at < notBefore) return null;
  const answers = parsed['answers'];
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return null;
  // Dictionaries WITHOUT a prototype: the key is the question text from the author, and `out['__proto__'] = …` on
  // a plain object would reset the prototype instead of adding an answer.
  const out = Object.create(null);
  let total = 0;
  for (const [question, value] of Object.entries(answers)) {
    if (question === '' || typeof value !== 'string') return null;
    if (value.length > ANSWER_VALUE_MAX_CHARS) return null;
    out[question] = value;
    total += value.length;
  }
  if (Object.keys(out).length === 0) return null;
  const annotations = readAnnotations(parsed['annotations'], out, toolInput);
  if (annotations === undefined) return null;
  for (const entry of Object.values(annotations ?? {})) total += entry.notes?.length ?? 0;
  if (total > ANSWERS_TOTAL_MAX_CHARS) return null;
  return { answers: out, annotations };
}

/**
 * Option previews of each question from `tool_input` (`question text → set of previews`).
 * An empty set = a question without a preview; no key = there is no such question in the call.
 */
function previewsByQuestion(toolInput) {
  const out = new Map();
  const questions = toolInput === null || typeof toolInput !== 'object'
    ? undefined
    : toolInput['questions'];
  if (!Array.isArray(questions)) return out;
  for (const item of questions) {
    if (item === null || typeof item !== 'object' || typeof item['question'] !== 'string') continue;
    const previews = new Set();
    for (const option of Array.isArray(item['options']) ? item['options'] : []) {
      const preview = option === null || typeof option !== 'object' ? undefined : option['preview'];
      if (typeof preview === 'string' && preview !== '') previews.add(preview);
    }
    out.set(item['question'], previews);
  }
  return out;
}

/**
 * NOTES to the answer: the `annotations` field of Rarog's file, handed to the CLI in
 * `updatedInput.annotations`. We check the shape and caps HERE, because this is a file from outside the CLI process,
 * and the CLI does not check the preview on the hook path (a cut preview passes):
 *
 * - the key is the LITERAL text of the question from `tool_input` the file answers;
 * - the value has only `notes` (non-empty text ≤ `ANSWER_NOTE_MAX_CHARS`) and/or `preview`
 *   (LITERALLY one of the option previews of this question: the CLI gives it to the model as `selected preview`);
 * - a question that already carries `annotations` in `tool_input` is rejected (Rarog does not overwrite a field it did
 *   not write).
 *
 * @returns `null` = the file carries no notes; an object = notes to hand over; `undefined` = the file is
 *          bad, reject it WHOLE (fail-closed)
 */
function readAnnotations(raw, answers, toolInput) {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (toolInput !== null && typeof toolInput === 'object' && Object.hasOwn(toolInput, 'annotations')) {
    return undefined;
  }
  const previews = previewsByQuestion(toolInput);
  const out = Object.create(null);
  for (const [question, value] of Object.entries(raw)) {
    if (!Object.hasOwn(answers, question)) return undefined;
    const allowed = previews.get(question);
    if (allowed === undefined) return undefined;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (Object.keys(value).some((field) => field !== 'notes' && field !== 'preview')) return undefined;
    const entry = {};
    if (Object.hasOwn(value, 'notes')) {
      const notes = value['notes'];
      if (typeof notes !== 'string' || notes === '' || notes.length > ANSWER_NOTE_MAX_CHARS) return undefined;
      entry.notes = notes;
    }
    if (Object.hasOwn(value, 'preview')) {
      const preview = value['preview'];
      if (typeof preview !== 'string' || !allowed.has(preview)) return undefined;
      entry.preview = preview;
    }
    if (Object.keys(entry).length === 0) return undefined;
    out[question] = entry;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Is the dump in `pending/` STILL our dialog?
 *
 * Without this condition the hook would wait up to the `--answer-wait` cap (a day) also when the question was settled
 * long ago at the desk: the CLI then leaves the process alive and only ignores its late `allow`
 * (measured on 2.1.314). The dump is the only signal the hook has access to: Rarog deletes it after
 * the decision is sent, and the next dialog in this session overwrites it. Another key or no file =
 * we end silently, exactly as after a timeout.
 *
 * Fail-OPEN on a read error (`true`): a single failed `read` must not take the answer channel
 * from the human: the time cap is there for closing.
 */
function dumpStillMine(dir, sessionId, key) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(dir, 'pending', `${sessionId}.json`), 'utf8'));
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
  return parsed !== null && typeof parsed === 'object' && parsed['answerKey'] === key;
}

/** Wait cap in milliseconds: `--answer-wait=<seconds>` from the registration, or the default. */
function answerWaitMs(argv) {
  const arg = argv.find((entry) => entry.startsWith('--answer-wait='));
  const raw = arg === undefined ? Number.NaN : Number(arg.slice('--answer-wait='.length));
  const seconds = Number.isFinite(raw) && raw >= 0 ? raw : ANSWER_WAIT_DEFAULT_S;
  return Math.round(seconds * 1000);
}

/**
 * Waits for an answer from Rarog and returns it (deleting the file), or `null` after the cap.
 *
 * We delete the file AFTER reading and before returning `allow`: if it stayed, it would act on the
 * NEXT question of the same turn. A failed delete does not overturn the answer: Rarog
 * cleans the directory independently (the reaper at server start).
 */
async function waitForAnswers(dir, sessionId, key, notBefore, waitMs, toolInput) {
  const file = join(dir, ANSWERS_DIR, sessionId, `${key}.json`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const answers = readAnswers(file, sessionId, key, notBefore, toolInput);
    if (answers !== null) {
      try {
        unlinkSync(file);
      } catch {
        // Best-effort cleanup: the answer is already read.
      }
      return answers;
    }
    if (Date.now() >= deadline) return null;
    if (!dumpStillMine(dir, sessionId, key)) return null;
    await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS));
  }
}

/**
 * State of ONE shadow mode cycle (process = one request, so one cycle per process): `null` outside a
 * `PermissionRequest` for a tool. `finish` is the cycle's only exit: it cleans up the per-call dump
 * and appends `wyjscie`, once.
 */
let cycle = null;

/** Milliseconds since the hook process start (the `ms` field in `shadow.jsonl`). */
const elapsedMs = () => Math.max(0, Date.now() - PROCESS_STARTED_AT);

/**
 * A `shadow.jsonl` line: identifiers, reasons and numbers, never the `tool_input` content. One write with the `a`
 * flag (`O_APPEND`), like `guard.jsonl`. Best-effort: the log is diagnostics, a write error stops nothing.
 */
function shadowLog(ev, fields = {}) {
  if (cycle === null) return;
  try {
    ensureDir(cycle.dir);
    appendFileSync(join(cycle.dir, SHADOW_LOG_FILE), `${JSON.stringify({
      at: Date.now(), ev, pid: process.pid, sessionId: cycle.sessionId,
      ...(cycle.key === null ? {} : { key: cycle.key }),
      ...fields,
    })}\n`, { mode: 0o600, flag: 'a' });
  } catch {
    // Diagnostics: the cycle goes on without the line.
  }
}

/**
 * Signal (SIGTERM on Esc in the main thread, on the hook timeout, on `ctrl+x ctrl+k`): a `sygnal` line,
 * cleanup of the per-call dump, exit 0 without a result. Registered only for the shadow mode cycle, so
 * the question's answer channel keeps its own reaction to a signal.
 */
function onSignal(signal) {
  if (cycle !== null && !cycle.done) {
    shadowLog('sygnal', { sygnal: signal, ms: elapsedMs() });
    finishCycle('sygnal');
  }
  process.exit(0);
}

function startCycle(dir, sessionId, fields) {
  cycle = { dir, sessionId, key: null, dumpFile: null, waited: false, done: false };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { onSignal(signal); });
  shadowLog('start', fields);
}

/**
 * The cycle's only exit: the per-call dump disappears (best effort), `wyjscie` with the reason and time. Idempotent.
 * `alive` = `{bootId, aliveTs}` of the file that gave the veto (shadow audit: time from a flag change to the exit).
 */
function finishCycle(powod, alive = {}) {
  if (cycle === null || cycle.done) return;
  cycle.done = true;
  removeCallDump(cycle.dumpFile);
  shadowLog('wyjscie', { powod, ms: elapsedMs(), czekal: cycle.waited, ...alive });
}

/**
 * Exit without waiting: `bez-czekania` with the reason (and the `extra` fields, e.g. `szczegol` of a registration
 * refusal), then `wyjscie` with the same reason.
 */
function skipWaiting(powod, alive = {}, extra = {}) {
  shadowLog('bez-czekania', { powod, ...extra });
  finishCycle(powod, alive);
}

/**
 * Per-call key: `<prompt_id>-<nonce 16 B hex>`. The nonce is uninterpreted and drawn ON EVERY
 * call, so two identical requests of one turn (the same `prompt_id`, the same input) have different keys.
 * The hook calls this function ONCE, in {@link main}: the request marker, the per-call dump and the consent channel
 * registration carry the same key. `null` = `prompt_id` is not fit for a file name: no per-call dump and no waiting.
 */
function callKeyFor(promptId) {
  if (typeof promptId !== 'string' || !SESSION_ID_PATTERN.test(promptId)) return null;
  return `${promptId}-${randomBytes(CALL_NONCE_BYTES).toString('hex')}`;
}

/**
 * Full sha256 of the canonical `tool_input`, or `null`. The module is loaded DYNAMICALLY, like the tall dialog guard:
 * a missing or broken `canon.mjs` (a copy installed without it, an exception on a deep input) means "no per-call
 * dump and no waiting", not a knocked-over hook.
 */
async function inputDigest(toolInput) {
  try {
    const canon = await import(new URL('./canon.mjs', import.meta.url).href);
    const digest = canon.canonicalSha256(toolInput ?? null);
    return typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

/**
 * Writes the per-call dump and the request marker. A parallel hook of this session deletes the empty directory
 * `pending/<session>/` on exit (and the server may remove an empty `markers/<session>/`), so between `mkdir` and the
 * write the directory may vanish (ENOENT): one retry.
 */
function writeCallDump(dumpDir, file, body) {
  try {
    writeAtomic(dumpDir, file, body);
  } catch (err) {
    if (err === null || typeof err !== 'object' || err.code !== 'ENOENT') throw err;
    writeAtomic(dumpDir, file, body);
  }
}

/** Cleanup of the per-call dump and the empty session directory (one held by another dump stays). Best effort. */
function removeCallDump(file) {
  if (file === null) return;
  try {
    unlinkSync(file);
  } catch {
    // No file or no permissions: the server sweeps orphaned dumps.
  }
  try {
    rmdirSync(dirname(file));
  } catch {
    // The directory is not empty (another request of this session) or is already gone.
  }
}

/**
 * Reads `<dataDir>/alive.json`: `{veto: null, seen, alive}` for a file of valid shape with a fresh `ts`, or
 * `{veto: reason, seen?}`, where `seen` = `{bootId, aliveTs}` of a file of valid shape (for the log), and `alive`
 * = `{bootId, mode, send, sessions, markers}`. Fail-closed: no file, bad JSON, any required field missing, `ts`
 * further than `ALIVE_MAX_AGE_MS` from the hook's clock (both ways): each of these is a veto. The
 * `markers` field is optional and not part of the shape: `true` only with a literal `true`, any other value
 * and absence are `false` (a server without markers), never `alive-zly`. `restart` = the raw `stop` and `phase` of a
 * file of valid shape, also a stale one (the restart break, `consent.mjs`).
 */
function readAlive(dir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(dir, ALIVE_FILE), 'utf8'));
  } catch (err) {
    return { veto: err !== null && typeof err === 'object' && err.code === 'ENOENT' ? 'alive-brak' : 'alive-zly' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { veto: 'alive-zly' };
  const ts = parsed['ts'];
  const bootId = parsed['bootId'];
  const mode = parsed['mode'];
  const send = parsed['send'];
  const sessions = parsed['sessions'];
  if (
    typeof ts !== 'number' || !Number.isFinite(ts) || typeof bootId !== 'string' || bootId === ''
    || typeof mode !== 'string' || typeof send !== 'boolean' || !Array.isArray(sessions)
  ) {
    return { veto: 'alive-zly' };
  }
  const seen = { bootId: bootId.slice(0, 64), aliveTs: ts };
  const restart = { stop: parsed['stop'], phase: parsed['phase'] };
  if (Math.abs(Date.now() - ts) > ALIVE_MAX_AGE_MS) return { veto: 'alive-ts', seen, restart };
  return { veto: null, seen, restart, alive: { bootId, mode, send, sessions, markers: parsed['markers'] === true } };
}

/** `consent.mjs`, loaded dynamically (header, "CONSENT CHANNEL"); `null` = a missing or failing module, no channel. */
async function loadConsent() {
  let consent;
  try {
    consent = await import(new URL('./consent.mjs', import.meta.url).href);
  } catch {
    return null;
  }
  return consent;
}

/** Whether `mode` opens the consent channel for a request with this `agent_id`: `all`, or `main` without it. */
const channelFor = (mode, agentId) => mode === MODE_ALL || (mode === MODE_MAIN && agentId === undefined);

/**
 * Restart break (header, "RESTART BREAK"): `false` = it ended without the next server's channel, `true` = go on by
 * `alive.json` as it is now (no break, the channel opened, a server settled without it, `consent.mjs` unusable).
 */
async function restartBreak(dir, sessionId, agentId) {
  const first = readAlive(dir);
  if (first.restart?.stop === undefined && first.restart?.phase === undefined) return true;
  const consent = await loadConsent();
  if (typeof consent?.waitThroughRestart !== 'function') return true;
  const exit = await consent.waitThroughRestart({
    first, read: () => readAlive(dir), sessionId, channel: (alive) => channelFor(alive.mode, agentId),
    pollMs: ANSWER_POLL_MS, onPause: (fields) => { shadowLog('pauza', { ...fields, ms: elapsedMs() }); },
  });
  return exit.outcome !== 'expired';
}

/**
 * Request marker gate (header, "REQUEST MARKER"): `alive.json` of valid shape with a fresh `ts`
 * ({@link readAlive}), the session on the list, mode `main` or `all` and `markers: true`. Any other state (no file,
 * a server without the field, shadow, `off`, a session off the list) = no marker, and the rest of the hook runs as
 * without markers. `send` and `agent_id` do not change the gate: the marker decides nothing, it only tells the server
 * the request exists.
 */
function markersOn(dir, sessionId) {
  const read = readAlive(dir);
  if (read.veto !== null) return false;
  const { mode, sessions, markers } = read.alive;
  return markers === true && (mode === MODE_MAIN || mode === MODE_ALL) && sessions.includes(sessionId);
}

/**
 * Writes the request marker `markers/<session>/<name>.json` (`HookMarkerFile`): name = the per-call key or, without
 * a key, `anon-<pid>-<startedAt>` with `key: null`. Fields as in the per-call dump (without `permissionMode`), with the
 * same `tool_input` cap. Atomic write (0600, directories 0700, a temporary file and `rename`); we swallow an error,
 * because a missing marker puts this request back to the behavior without markers. The hook deletes the marker at no
 * exit.
 */
function writeMarker(dir, request, key, inputSha256) {
  const { sessionId, promptId, agentId, toolName, toolInput, cwd } = request;
  const markerDir = join(dir, MARKERS_DIR, sessionId);
  const name = key ?? `${MARKER_ANON_PREFIX}${String(process.pid)}-${String(PROCESS_STARTED_AT)}`;
  try {
    writeCallDump(markerDir, join(markerDir, `${name}.json`), `${JSON.stringify({
      key,
      sessionId,
      promptId: key === null ? null : promptId,
      pid: process.pid,
      startedAt: PROCESS_STARTED_AT,
      ...(typeof agentId === 'string' && agentId !== '' ? { agentId } : {}),
      toolName,
      toolInput: cappedToolInput(toolInput),
      cwd,
      at: Date.now(),
      inputSha256,
    })}\n`);
  } catch {
    // No marker = this request as without markers; the hook goes on.
  }
}

/**
 * Whether waiting in shadow mode is allowed according to `alive.json` ({@link readAlive}): `{veto: null, seen}` or
 * `{veto: reason, seen?}`. Read at EVERY poll. Beyond the read veto: a mode other than `shadow`, `send` other
 * than `true`, a session off the list: each of these is a veto.
 */
function aliveVeto(dir, sessionId) {
  const read = readAlive(dir);
  if (read.veto !== null) return { veto: read.veto, ...(read.seen === undefined ? {} : { seen: read.seen }) };
  const { seen } = read;
  const { mode, send, sessions } = read.alive;
  if (mode !== MODE_SHADOW) return { veto: mode === MODE_OFF ? 'tryb-off' : 'tryb-nieznany', seen };
  if (send !== true) return { veto: 'send', seen };
  if (!sessions.includes(sessionId)) return { veto: 'sesja', seen };
  return { veto: null, seen };
}

/**
 * Whether the request goes through the consent channel (header, "CONSENT CHANNEL"): `{mode, seen}` or `null`, that is
 * the usual path unchanged to the byte (tall dialog guard, dump, shadow mode). Channel: `alive.json` of valid shape
 * with a fresh `ts`, `send: true`, the session on the list and mode `main` for a request without `agent_id`, or `all`.
 */
function consentRoute(dir, sessionId, agentId) {
  const read = readAlive(dir);
  if (read.veto !== null) return null;
  const { mode, send, sessions } = read.alive;
  if (!channelFor(mode, agentId) || send !== true || !sessions.includes(sessionId)) return null;
  return { mode, seen: read.seen };
}

/**
 * Wait veto in the consent channel from reading `alive.json` ({@link readAlive}), at EVERY poll: `{veto: null, seen,
 * mode}` or `{veto: reason, seen?}`, like {@link aliveVeto}. Beyond the read veto: a `bootId` other than in the
 * registration response (`restart`), a mode outside {@link ALIVE_MODES} (`tryb-nieznany`), a mode lower than the
 * channel for this request (`tryb-nizszy`), `send` other than `true`, a session off the list.
 */
function consentVeto(read, sessionId, agentId, bootId) {
  if (read.veto !== null) return { veto: read.veto, ...(read.seen === undefined ? {} : { seen: read.seen }) };
  const { seen } = read;
  const { mode, send, sessions } = read.alive;
  if (read.alive.bootId !== bootId) return { veto: 'restart', seen };
  if (!ALIVE_MODES.has(mode)) return { veto: 'tryb-nieznany', seen };
  if (!channelFor(mode, agentId)) return { veto: 'tryb-nizszy', seen };
  if (send !== true) return { veto: 'send', seen };
  if (!sessions.includes(sessionId)) return { veto: 'sesja', seen };
  return { veto: null, seen, mode };
}

/** Whether something lies at the path (`lstat`: a symlink too). */
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claims a shadow file: `rename` `<key>.json` → `<key>.claimed` (whoever did the `rename` first won;
 * the server revokes with the same move to `.revoked`). `null` = there was no file. The content is read AFTER the
 * claim, only for the log: in shadow mode the file decides nothing.
 */
function claimShadow(base) {
  const claimed = `${base}${CLAIMED_SUFFIX}`;
  try {
    renameSync(`${base}.json`, claimed);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(claimed, 'utf8'));
    return { body: parsed !== null && typeof parsed === 'object' ? parsed : null };
  } catch {
    return { body: null };
  }
}

/**
 * Waits in shadow mode for the shadow file under this request's key. Returns `{powod, alive?}`: `odbior`, `odwolane`,
 * `sufit` (`--answer-wait`) or an `alive.json` veto from a poll (with `bootId` and `ts` of the file, when readable).
 * A signal ends the process separately ({@link onSignal}).
 */
async function waitForShadow(dir, sessionId, key, inputSha256, waitMs) {
  const base = join(dir, SHADOW_DIR, sessionId, key);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const claimed = claimShadow(base);
    if (claimed !== null) {
      const body = claimed.body;
      const decision = body === null ? undefined : body['decision'];
      shadowLog('odbior', {
        decyzja: decision === 'allow' || decision === 'deny' ? decision : '?',
        zgodny: body !== null && body['key'] === key && body['sessionId'] === sessionId
          && body['inputSha256'] === inputSha256,
        ms: elapsedMs(),
      });
      return { powod: 'odbior' };
    }
    if (present(`${base}${REVOKED_SUFFIX}`)) return { powod: 'odwolane' };
    if (Date.now() >= deadline) return { powod: 'sufit' };
    await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS));
    // Veto before the claim, as at the start: a server that does not allow waiting does not get a claim.
    const { veto, seen } = aliveVeto(dir, sessionId);
    if (veto !== null) return { powod: veto, alive: seen };
  }
}

/**
 * Writes the per-call dump `pending/<session>/<key>.json` (`HookCallDump`); `false` = the write failed.
 * A successful write registers the file in the cycle, so {@link finishCycle} cleans it up.
 * `suggestions`: `permission_suggestions` as the consent channel carries them (`carriedSuggestions` in `consent.mjs`);
 * shadow mode passes none.
 */
function writeKeyDump(dir, request, key, inputSha256, capped, suggestions) {
  const { sessionId, promptId, agentId, permissionMode, toolName, cwd } = request;
  const dumpDir = join(dir, 'pending', sessionId);
  const dumpFile = join(dumpDir, `${key}.json`);
  try {
    writeCallDump(dumpDir, dumpFile, `${JSON.stringify({
      key,
      sessionId,
      promptId,
      pid: process.pid,
      startedAt: PROCESS_STARTED_AT,
      ...(typeof agentId === 'string' && agentId !== '' ? { agentId } : {}),
      ...(typeof permissionMode === 'string' ? { permissionMode } : {}),
      toolName,
      toolInput: capped,
      ...(suggestions === undefined ? {} : { permissionSuggestions: suggestions }),
      cwd,
      at: Date.now(),
      inputSha256,
    })}\n`);
  } catch {
    return false;
  }
  cycle.dumpFile = dumpFile;
  return true;
}

/**
 * Per-call dump and shadow mode for a tool permission (`PermissionRequest`, not `AskUserQuestion`), after
 * the per-session dump is written. `call` = `{key, inputSha256}` computed ONCE in {@link main} (the same key as
 * in the request marker). The order of conditions sets the reason in `shadow.jsonl`: key, digest, dump write,
 * truncation, subagent, `alive.json`. Every path ends with {@link finishCycle} and writes nothing to stdout.
 */
async function shadowChannel(dir, request, call) {
  const { sessionId, agentId, toolInput } = request;
  const { key, inputSha256 } = call;
  if (key === null) return skipWaiting('klucz');
  cycle.key = key;
  if (inputSha256 === null) return skipWaiting('skrot');

  const capped = cappedToolInput(toolInput);
  if (!writeKeyDump(dir, request, key, inputSha256, capped)) {
    return skipWaiting('zrzut');
  }

  // `cappedToolInput` returns the original (or `null` for none) within the cap, and the marker above it.
  if (capped !== (toolInput ?? null)) return skipWaiting('obciety');
  if (agentId !== undefined) return skipWaiting('subagent');
  const alive = aliveVeto(dir, sessionId);
  if (alive.veto !== null) return skipWaiting(alive.veto, alive.seen);

  cycle.waited = true;
  shadowLog('czekam', { ...alive.seen, inputSha256 });
  const exit = await waitForShadow(dir, sessionId, key, inputSha256, answerWaitMs(process.argv));
  finishCycle(exit.powod, exit.alive);
}

/**
 * Consent channel (header, "CONSENT CHANNEL") for a request to which {@link consentRoute} gave a mode, after the
 * per-session dump is written. `call` = `{key, inputSha256}` computed ONCE in {@link main}: the registration, the
 * dump and the request marker carry the same key with the same nonce. The order sets the reason in `shadow.jsonl`:
 * module, key, digest, registration BEFORE the per-call dump and before the first log line with the key, dump,
 * truncation, waiting. Only a decision from a valid, claimed answer file goes to stdout; every other path ends with
 * {@link finishCycle} without a decision.
 */
async function consentChannel(dir, request, route, call) {
  const { sessionId, promptId, agentId, permissionMode, toolName, toolInput, cwd } = request;
  const consent = await loadConsent();
  if (consent === null) return skipWaiting('modul');
  const { key, inputSha256 } = call;
  if (key === null) return skipWaiting('klucz');
  if (inputSha256 === null) return skipWaiting('skrot');
  let cardSha256;
  try {
    // The same fields as the server's card from the per-call dump: `agentId` only non-empty, the mode only a string.
    cardSha256 = consent.cardSha256({
      sessionId, toolName, toolInput: toolInput ?? null, cwd,
      agentId: typeof agentId === 'string' && agentId !== '' ? agentId : null,
      permissionMode: typeof permissionMode === 'string' ? permissionMode : null,
    });
  } catch {
    return skipWaiting('skrot');
  }
  if (typeof cardSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(cardSha256)) return skipWaiting('skrot');

  // The secret lives only in this function and in the registration body (never argv, env, dump, log, file, stdout).
  const secret = consent.newSecret();
  const registeredAt = Date.now();
  const suggestions = consent.carriedSuggestions(request.permissionSuggestions);
  // The same body goes again after a server restart (`waitResuming`).
  const register = (deadlineMs) => consent.registerConsent(consent.socketPathOf(dir), {
    key, sessionId, promptId, secret, inputSha256, cardSha256, pid: process.pid, startedAt: PROCESS_STARTED_AT,
    // Any presence of `agent_id` goes to the registry: a field with a bad shape is a refusal, not a main-thread
    // request.
    ...(agentId === undefined ? {} : { agentId }),
    // "Always" (`alwaysVersion`) only with suggestions: a request without them never has the option.
    ...(suggestions === undefined ? {} : { permissionSuggestions: suggestions, alwaysVersion: consent.ALWAYS_VERSION }),
  }, deadlineMs);
  const reply = await register();
  cycle.key = key;
  const capped = cappedToolInput(toolInput);
  if (!writeKeyDump(dir, request, key, inputSha256, capped, suggestions)) {
    return skipWaiting('zrzut');
  }
  if (reply.accepted !== true) {
    return skipWaiting('rejestracja', {}, { szczegol: String(reply.detail).slice(0, 64) });
  }
  if (capped !== (toolInput ?? null)) return skipWaiting('obciety');

  cycle.waited = true;
  shadowLog('czekam', { ...route.seen, inputSha256, tryb: route.mode });
  let mode = route.mode;
  const exit = await consent.waitResuming({
    base: join(dir, consent.CONSENT_DIR, sessionId, key),
    expected: {
      secret, sessionId, key, inputSha256, cardSha256, notBefore: registeredAt - consent.NOT_BEFORE_MARGIN_MS,
      permissionsSha256: suggestions === undefined ? null : consent.alwaysDigest(suggestions),
    },
    pollMs: ANSWER_POLL_MS, deadline: Date.now() + answerWaitMs(process.argv), bootId: reply.bootId, sessionId,
    read: () => readAlive(dir), channel: (alive) => channelFor(alive.mode, agentId), register,
    onLine: (ev, f) => { shadowLog(ev, { ...f, ...(ev === 'czekam' ? { inputSha256 } : { ms: elapsedMs() }) }); },
    // Veto before every claim (after the `--answer-wait` cap): reading `alive.json` against the registration `bootId`.
    veto: (bootId, read) => {
      const alive = consentVeto(read, sessionId, agentId, bootId);
      if (alive.veto === null) {
        mode = alive.mode;
        return null;
      }
      return { powod: alive.veto, alive: alive.seen ?? {} };
    },
    onRejected: (reason, n) => {
      shadowLog('odrzucony', {
        powod: ['input', 'card', 'permissions'].includes(reason) ? 'karta-inna' : 'podpis', szczegol: reason, n,
        ms: elapsedMs(),
      });
    },
  });
  if (exit.outcome !== 'claimed') return finishCycle(exit.powod, exit.alive);

  // ONLY the content of a claimed, verified file is executed; `allow` for `agent_id` only in mode `all`.
  const { file } = exit;
  shadowLog('odbior', { decyzja: file.decision, szczegol: file.reasonId, ms: elapsedMs() });
  const output = consent.consentOutput(file, {
    hookEventName: PERMISSION_REQUEST_EVENT, toolName, toolInput, allowed: agentId === undefined || mode === MODE_ALL,
    suggestions,
  });
  // `allow` only with the server's receipt: a copy of an old `allow` has a valid signature but is not the record's
  // live decision. No receipt (refusal, deadline, a server or module without `/claim`) = exit without a decision.
  if (output !== null && file.decision === 'allow') {
    const receipt = await confirmReceipt(consent, dir, { secret, sessionId, key, at: file.at });
    if (receipt.confirmed !== true) {
      return finishCycle('potwierdzenie', { szczegol: String(receipt.detail).slice(0, 64) });
    }
  }
  finishCycle(file.decision === 'release' ? 'release' : 'odbior');
  if (output !== null) writeSync(1, JSON.stringify(output));
}

/** The receipt of a taken `allow` (`consent.mjs`, `confirmConsent`); a module without it or a throw = no receipt. */
async function confirmReceipt(consent, dir, { secret, sessionId, key, at }) {
  if (typeof consent.confirmConsent !== 'function' || typeof consent.receiptMac !== 'function') {
    return { confirmed: false, detail: 'modul' };
  }
  try {
    const mac = consent.receiptMac(secret, { sessionId, key, at });
    return await consent.confirmConsent(consent.socketPathOf(dir), { key, at, mac });
  } catch {
    return { confirmed: false, detail: 'modul' };
  }
}

async function main() {
  const raw = await readStdin();
  // Programmatic session (header, "PROGRAMMATIC SESSIONS"): end without a trace, right after reading stdin.
  if (PROGRAMMATIC_ENTRYPOINTS.has(process.env[ENTRYPOINT_ENV])) return;
  if (raw === '') return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (payload === null || typeof payload !== 'object') return;

  const event = payload['hook_event_name'];
  // Events outside the contract (a `PreToolUse` registration for all tools, a `PostToolUse` added by hand) write
  // NOTHING: otherwise stale dumps come back.
  if (event !== 'PermissionRequest' && event !== 'PreToolUse') return;

  const sessionId = payload['session_id'];
  const toolName = payload['tool_name'];
  // Validation BEFORE `join`: `session_id` goes into the file name, and `../../…` would write over
  // any file of the user's account.
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return;
  if (typeof toolName !== 'string' || toolName === '') return;
  if (event === 'PreToolUse' && toolName !== QUESTION_TOOL) return;

  const cwd = payload['cwd'];
  if (typeof cwd !== 'string' || cwd === '') return;

  const dir = dataDir();
  if (dir === null) return;
  const config = rarogRoots(dir);
  if (config === null) return;
  dataRoot = dir;
  if (!(await insideRoots(cwd, config))) return;

  const promptId = payload['prompt_id'];
  const permissionMode = payload['permission_mode'];
  const toolInput = payload['tool_input'];
  // Only a SUBAGENT's request carries `agent_id` (CLI 2.1.302). Rarog takes it to the log (`herdr-audit.log`), so that
  // subagent permissions count separately; in shadow mode and in the consent channel in mode `main` the mere PRESENCE
  // of the field means "do not wait".
  const agentId = payload['agent_id'];

  /*
   * Shadow mode cycle (header, "PER-CALL DUMP AND SHADOW MODE"): only a tool permission:
   * a question has its own answer channel, which stays unchanged. From this moment every process exit
   * appends `wyjscie` to `shadow.jsonl` and cleans up the per-call dump.
   */
  if (event === PERMISSION_REQUEST_EVENT && toolName !== QUESTION_TOOL) {
    startCycle(dir, sessionId, {
      toolName: TOOL_NAME_PATTERN.test(toolName) ? toolName : '?',
      ...(typeof promptId === 'string' && SESSION_ID_PATTERN.test(promptId) ? { promptId } : {}),
      subagent: agentId !== undefined,
      ...(typeof permissionMode === 'string' ? { permissionMode: permissionMode.slice(0, 64) } : {}),
    });
  }
  // Data for the consent channel (the registration and the per-call dump); the hook decides nothing on it.
  const permissionSuggestions = payload['permission_suggestions'];
  const request = { sessionId, promptId, agentId, permissionMode, toolName, toolInput, cwd, permissionSuggestions };
  /*
   * Per-call key and canon digest ONCE per request, before choosing the path (header, "REQUEST MARKER"): the same
   * key goes to the marker, the per-call dump and the consent channel registration. The marker is made here, before
   * the tall dialog guard, the channel, shadow mode and every exit without waiting; the reasons of these exits keep
   * their order (module, key, digest…), because the paths check `call` themselves.
   */
  const call = cycle === null ? null : { key: callKeyFor(promptId), inputSha256: await inputDigest(toolInput) };
  // Restart break (header, "RESTART BREAK"): `false` = no successor in time, exit after the per-session dump.
  const successor = call === null || await restartBreak(dir, sessionId, agentId);
  if (call !== null && markersOn(dir, sessionId)) writeMarker(dir, request, call.key, call.inputSha256);
  // Consent channel (header, "CONSENT CHANNEL"): `null` = the usual path unchanged to the byte.
  const channel = cycle === null ? null : consentRoute(dir, sessionId, agentId);

  /*
   * Tall dialog guard (pane geometry): see the header. Cheap conditions before importing the
   * module: event, tool, flag from `roots.json`, herdr session, command as a string. The guard fields
   * (budget source, geometry) go to the refusal log or to the dump of a request let through.
   */
  let guarded = {};
  // A consent channel request skips the guard: the card on the device shows the whole input, with no dialog row limit.
  if (
    channel === null
    && event === PERMISSION_REQUEST_EVENT && toolName === GUARD_TOOL && config.tallDialogGuard
    && process.env['HERDR_ENV'] === '1'
    && toolInput !== null && typeof toolInput === 'object' && typeof toolInput['command'] === 'string'
  ) {
    const outcome = await tallDialogGuard(toolInput, process.env['COLUMNS'], process.env['LINES']);
    if (outcome !== null) guarded = outcome.fields;
    const verdict = outcome?.verdict ?? null;
    if (verdict !== null) {
      try {
        markSeen(dir, event, toolName);
      } catch {
        // The marker is diagnostics: the form refusal goes anyway.
      }
      try {
        appendGuardLog(dir, {
          at: Date.now(),
          sessionId,
          subagent: typeof payload['agent_id'] === 'string' && payload['agent_id'] !== '',
          reason: verdict.reason,
          rows: verdict.rows,
          budget: verdict.budget,
          descriptionRows: verdict.descriptionRows,
          ...guarded,
          ...(typeof permissionMode === 'string' ? { permissionMode } : {}),
        });
      } catch {
        // The log is diagnostics: the model sees the refusal in its transcript.
      }
      // Form refusal: no per-call dump and no waiting, also in shadow mode.
      skipWaiting('straznik');
      // The response shape EXACTLY as measured on CLI 2.1.302 (main thread and a background subagent, modes default and
      // auto): no `interrupt`, whose default value does not interrupt the turn anyway: the model gets `message` as a
      // tool result with an error and splits the work.
      writeSync(1, JSON.stringify({
        hookSpecificOutput: {
          hookEventName: PERMISSION_REQUEST_EVENT,
          decision: { behavior: 'deny', message: verdict.message },
        },
      }));
      return;
    }
  }

  const pending = join(dir, 'pending');
  // ONLY `PreToolUse` carries `tool_use_id` (measured: `PermissionRequest` does not have it,
  // even for the same tool in the same turn). It stays in the dump, because it gives the card
  // a stable call identity where it exists at all.
  const toolUseId = payload['tool_use_id'];
  /*
   * We compute the answer channel key ONLY for a standing question form, and the HOOK computes it,
   * not Rarog: so there is exactly one algorithm, not two that agree by chance.
   * The dump carries it, so Rarog addresses the answer file without knowing the payload.
   */
  const answerKey = event === PERMISSION_REQUEST_EVENT && toolName === QUESTION_TOOL
    ? answerKeyFor(promptId, toolInput)
    : null;
  const at = Date.now();
  const body = `${JSON.stringify({
    sessionId,
    toolName,
    ...(typeof toolUseId === 'string' ? { toolUseId } : {}),
    toolInput: cappedToolInput(toolInput),
    at,
    hookEventName: event,
    ...(typeof promptId === 'string' ? { promptId } : {}),
    ...(typeof permissionMode === 'string' ? { permissionMode } : {}),
    ...(answerKey === null ? {} : { answerKey }),
    // The per-call key of this request (the same as in the marker, the per-call dump and the channel registration):
    // the server ties a card built from this dump to the channel record of the same call, never by its content.
    ...(typeof call?.key === 'string' ? { callKey: call.key } : {}),
    ...(typeof agentId === 'string' && agentId !== '' ? { agentId } : {}),
    // The guard's budget source and pane geometry at the moment of the hook: only for a request
    // the guard assessed and let through; Rarog moves them to this card's `degrade` entry.
    ...guarded,
    cwd,
  })}\n`;
  writeAtomic(pending, join(pending, `${sessionId}.json`), body);
  markSeen(dir, event, toolName);
  if (call !== null) {
    if (!successor) skipWaiting('przerwa');
    else if (channel === null) await shadowChannel(dir, request, call);
    else await consentChannel(dir, request, channel, call);
    return;
  }
  if (answerKey === null) return;

  const reply = await waitForAnswers(
    dir, sessionId, answerKey, at, answerWaitMs(process.argv), toolInput,
  );
  // Silence after a timeout is CORRECT and the only option: the CLI leaves no trace on the screen
  // that the hook was lost, so the form stays and waits for a digit.
  if (reply === null) return;
  /*
   * The `decision` shape is an OBJECT (`{behavior, updatedInput}`): hooks docs, "PermissionRequest decision control".
   * `updatedInput` replaces the whole tool input, so we give it back WHOLE with `answers` added (docs,
   * "AskUserQuestion"; measured), and with notes also `annotations`: a field CLI 2.1.288 and 2.1.293 accept (measured).
   * RAROG enforces the version threshold: it writes notes only for a process ≥ 2.1.288; a file without notes gives
   * `updatedInput` without `annotations`.
   *
   * `writeSync` instead of `process.stdout.write`: `process.exit(0)` follows right after, and an
   * asynchronous write to a pipe might not make it.
   */
  writeSync(1, JSON.stringify({
    hookSpecificOutput: {
      hookEventName: PERMISSION_REQUEST_EVENT,
      decision: {
        behavior: 'allow',
        updatedInput: {
          ...(toolInput === null || typeof toolInput !== 'object' ? {} : toolInput),
          answers: reply.answers,
          ...(reply.annotations === null ? {} : { annotations: reply.annotations }),
        },
      },
    },
  }));
}

// The only exit from the process: exit 0, stdout empty or one decision (`allow` with an answer to a
// question, the guard's `deny`, a consent channel decision). Without this `catch` a write exception would go
// to stderr and (with exit ≠ 0) could be taken as a hook signal. A shadow mode cycle that no path
// closed (an exception, e.g. a full disk at the per-session dump) ends here as `blad`.
main().then(
  () => {
    finishCycle('blad');
    process.exit(0);
  },
  () => {
    finishCycle('blad');
    process.exit(0);
  },
);
