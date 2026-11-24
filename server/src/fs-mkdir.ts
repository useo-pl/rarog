/**
 * Creating one directory from the directory browser of the New Session form. Order: the gate (`mkdirRefusal`, no
 * disk), the name rule (no disk), one request at a time, the parent steps of the listing (`resolveListedDir`,
 * `isListedChild` of `fs-browse.ts`, so the rule of what a row may be is one), the device recheck, and the child of
 * `fs-mkdir-child.ts` that creates the directory inside the parent exactly as checked. It never overwrites, never
 * removes, never creates more than one level and never runs in the demo; the route maps the result to HTTP.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { DirEntry } from '@rarog/shared';
import { DIR_EXISTS_ERROR, DIR_NAME_INVALID_ERROR, MKDIR_BUSY_ERROR, MKDIR_DISABLED_ERROR } from '@rarog/shared/rest';
import { type ServerSentence, say } from '@rarog/shared/sentences';
import { redact } from './auth/index.ts';
import { defaultStoreRoot, projectSlug } from './cli-store.ts';
import type { RarogConfig } from './config.ts';
import { type WalkDisk, insideWorkArea } from './config/work-area.ts';
import type { WorkAreaDisk } from './folder-gate/disk.ts';
import { PATH_NOT_ALLOWED, isListedChild, resolveListedDir } from './fs-browse.ts';
import {
  MKDIR_CHILD_CODES, type MkdirChildCode, type MkdirChildExit, type MkdirChildRunner, type MkdirSpawnOptions,
  mkdirChildArgv, runMkdirChild,
} from './fs-mkdir-child.ts';

/** The child's time limit: the directory takes milliseconds, the rest is the start of Node. */
const MKDIR_CHILD_TIMEOUT_MS = 10_000;

/** The longest name in UTF-8 bytes after NFC, the name limit of APFS and ext4. */
const MAX_DIR_NAME_BYTES = 255;

export type MkdirConfig = Pick<RarogConfig, 'demo' | 'herdrLaunch' | 'herdrSend' | 'projectRoots'>;

/**
 * Whether creating directories is off: in the demo (which touches no disk and starts no child) and with either
 * switch that stops Rarog from starting panes. The listing answers `canCreate` from it; the route asks it again.
 */
export function mkdirRefusal(config: Pick<RarogConfig, 'demo' | 'herdrLaunch' | 'herdrSend'>): 'disabled' | null {
  return config.demo || !config.herdrLaunch || !config.herdrSend ? 'disabled' : null;
}

/** The request fields after the shape check: the listed directory and the name of the new one. */
export interface MkdirBody {
  readonly parent: string;
  readonly name: string;
}

export interface MkdirDeps {
  readonly config: MkdirConfig;
  /**
   * The device check again, right before the child starts (no `await` between the two); `false` means the 401 is
   * already sent. A device revoked after the start does not undo the directory.
   */
  readonly recheckDevice: () => boolean;
  readonly log: (line: string) => void;
  /** Secrets wiped from the logged path. */
  readonly secrets: readonly string[];
  /** Starts the child; tests swap it. */
  readonly runChild?: MkdirChildRunner;
  readonly home?: string;
  /** The CLI store the `history` marker comes from; `~/.claude/projects` by default. */
  readonly storeRoot?: string;
  /** The disk calls of the symlink walk; tests record them. */
  readonly walk?: WalkDisk;
  /** The disk of the parent steps after the walk (`resolveListedDir`). */
  readonly disk?: WorkAreaDisk;
}

/** The error code of a refusal: the codes of `shared/src/rest.ts` and the two codes of the listing. */
export type MkdirError =
  | typeof MKDIR_DISABLED_ERROR | typeof MKDIR_BUSY_ERROR | typeof DIR_NAME_INVALID_ERROR | typeof PATH_NOT_ALLOWED
  | 'not-found' | typeof DIR_EXISTS_ERROR | 'internal';

export interface MkdirRefused {
  readonly ok: false;
  readonly status: 400 | 404 | 409 | 429 | 500;
  readonly error: MkdirError;
  readonly sentence: ServerSentence;
}

/** 200 with the new row, a refusal to send, or 401 that the recheck already sent. */
export type MkdirResult =
  | { readonly ok: true; readonly entry: DirEntry }
  | MkdirRefused
  | { readonly ok: false; readonly status: 401 };

const SPAWN_OPTIONS: MkdirSpawnOptions = Object.freeze({
  cwd: '/',
  env: Object.freeze({}),
  stdio: Object.freeze(['ignore', 'pipe', 'ignore'] as const),
  timeout: MKDIR_CHILD_TIMEOUT_MS,
  killSignal: 'SIGKILL',
});

/** A lone surrogate, the test of `String.prototype.isWellFormed` (the ES2023 lib of the repo does not type it). */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
/** A separator, a colon (the path separator of Finder) or a control, format or line character. */
const FORBIDDEN_CHAR = /[/:\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const EDGE_SPACE = /^\s|\s$/u;

/** Unicode line breaks that `JSON.stringify` leaves as they are. */
const RAW_LINE_BREAK = /[\u{85}\u{2028}\u{2029}]/gu;

/** One request at a time in the whole server: taken before the child starts, freed when it is gone. */
let inFlight = false;

const refusal = (status: MkdirRefused['status'], error: MkdirError, sentence: ServerSentence): MkdirRefused => (
  { ok: false, status, error, sentence }
);

/** The name rule and the parent's form, text only. The name is judged in NFC, the form that reaches the disk. */
function formRefusal(parent: string, name: string): MkdirRefused | null {
  if (LONE_SURROGATE.test(parent)) return refusal(400, PATH_NOT_ALLOWED, say('rest.bad-request'));
  if (name === '') return refusal(400, DIR_NAME_INVALID_ERROR, say('rest.dir-name-empty'));
  if (LONE_SURROGATE.test(name)) return refusal(400, DIR_NAME_INVALID_ERROR, say('rest.dir-name-invalid'));
  const nfc = name.normalize('NFC');
  if (nfc.startsWith('.')) return refusal(400, DIR_NAME_INVALID_ERROR, say('rest.cwd-hidden'));
  if (FORBIDDEN_CHAR.test(nfc) || EDGE_SPACE.test(nfc)) {
    return refusal(400, DIR_NAME_INVALID_ERROR, say('rest.dir-name-chars'));
  }
  if (Buffer.byteLength(nfc, 'utf8') > MAX_DIR_NAME_BYTES) {
    return refusal(400, DIR_NAME_INVALID_ERROR, say('rest.dir-name-too-long'));
  }
  return null;
}

/** A path for the log: secrets wiped, then quoted, so a name with a line break or ESC stays on one line. */
function quoted(value: string, secrets: readonly string[]): string {
  return JSON.stringify(redact(value, secrets)).replace(
    RAW_LINE_BREAK, (ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  );
}

function refused(deps: MkdirDeps, result: MkdirRefused): MkdirRefused {
  deps.log(`fs/mkdir: refused ${String(result.status)} ${result.error} (${result.sentence.ref.code})`);
  return result;
}

function failed(deps: MkdirDeps, target: string, detail: string): MkdirRefused {
  deps.log(`fs/mkdir: failed (${detail}) for ${quoted(target, deps.secrets)}`);
  return refusal(500, 'internal', say('rest.mkdir-failed'));
}

/** The child's code, only from a clean exit with exactly one known line; anything else is no answer. */
function answerOf(exit: MkdirChildExit): MkdirChildCode | null {
  if (exit.signal !== null || exit.code !== 0) return null;
  return MKDIR_CHILD_CODES.find((code) => exit.stdout === `${code}\n`) ?? null;
}

function failureDetail(exit: MkdirChildExit, answer: MkdirChildCode | null): string {
  if (exit.signal !== null) return `child signal ${exit.signal}`;
  if (exit.code !== 0) return `child exit ${String(exit.code)}`;
  return answer === null ? 'child gave no known answer' : `child answered ${answer}`;
}

/**
 * Creates `name` in the listed directory `parent`. Everything before the slot runs before the first `await`, so two
 * calls in one tick cannot both take it.
 */
export async function makeDirectory(body: MkdirBody, deps: MkdirDeps): Promise<MkdirResult> {
  if (mkdirRefusal(deps.config) !== null) {
    return refused(deps, refusal(409, MKDIR_DISABLED_ERROR, say('rest.mkdir-disabled')));
  }
  const form = formRefusal(body.parent, body.name);
  if (form !== null) return refused(deps, form);
  if (inFlight) return refused(deps, refusal(429, MKDIR_BUSY_ERROR, say('rest.mkdir-busy')));
  inFlight = true;
  try {
    return await inSlot(body.parent, body.name.normalize('NFC'), deps);
  } finally {
    inFlight = false;
  }
}

async function inSlot(parent: string, name: string, deps: MkdirDeps): Promise<MkdirResult> {
  const ctx = await resolveListedDir(parent, {
    roots: deps.config.projectRoots, home: deps.home, walk: deps.walk, disk: deps.disk,
  });
  if (!ctx.ok) return refused(deps, ctx);
  // From here to the start of the child: no `fs` call and no `await`, so the child gets `realDir` as checked.
  if (!isListedChild(ctx, name)) {
    // `isListedChild` decides; the work-area question only picks the code: a name the listing hides
    // (`node_modules`) is a bad name, a protected folder of home is a path outside the work area.
    const inArea = insideWorkArea(path.join(ctx.dir, name), ctx.roots, ctx.home)
      && insideWorkArea(path.join(ctx.realDir, name), ctx.realRoots, ctx.realHome);
    return refused(deps, inArea
      ? refusal(400, DIR_NAME_INVALID_ERROR, say('rest.dir-name-invalid'))
      : refusal(400, PATH_NOT_ALLOWED, say('rest.cwd-protected')));
  }
  const target = path.join(ctx.dir, name);
  if (!deps.recheckDevice()) {
    deps.log('fs/mkdir: refused 401, the device was revoked before the child started');
    return { ok: false, status: 401 };
  }
  let exit: MkdirChildExit;
  try {
    exit = await (deps.runChild ?? runMkdirChild)(process.execPath, mkdirChildArgv(ctx.realDir, name), SPAWN_OPTIONS);
  } catch {
    return failed(deps, target, 'child did not start');
  }
  const answer = answerOf(exit);
  switch (answer) {
    case 'OK': {
      deps.log(`fs/mkdir: created ${quoted(target, deps.secrets)}`);
      return { ok: true, entry: { name, path: target, git: false, history: await hasHistory(target, deps) } };
    }
    case 'MOVED':
      return refused(deps, refusal(400, PATH_NOT_ALLOWED, say('rest.mkdir-moved')));
    case 'EEXIST':
      return refused(deps, refusal(409, DIR_EXISTS_ERROR, say('rest.dir-exists')));
    case 'ENOENT':
    case 'ENOTDIR':
      return refused(deps, refusal(404, 'not-found', say('rest.cwd-not-found')));
    default:
      return failed(deps, target, failureDetail(exit, answer));
  }
}

/**
 * The `history` marker of the new row: transcripts in the CLI store for this path (a directory created again where a
 * session once ran). `git` is always `false`: a `stat` of `.git` would look inside a directory an agent can swap for
 * a symlink into a protected folder of home.
 */
async function hasHistory(target: string, deps: MkdirDeps): Promise<boolean> {
  const storeRoot = deps.storeRoot ?? defaultStoreRoot();
  return stat(path.join(storeRoot, projectSlug(target))).then(() => true, () => false);
}
