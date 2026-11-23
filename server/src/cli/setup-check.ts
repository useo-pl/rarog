/**
 * The closing `Check` step of `rarog setup` and `rarog update --finish`, instead of a full `rarog doctor`: it judges
 * the server in the context of this run. A service that runs (found or installed) gets up to
 * {@link CHECK_HEALTH_TIMEOUT_MS} for a healthy `/health` (`ok`, `herdr`, `hook`, `sdk`, `consent`; after an update
 * `hook: ok` is required too); a server on another version than this package only needs a
 * restart, so its fields are not judged (after an update, whose restart is behind it, such a server fails the check);
 * a skipped service is a skipped check that names the step it waits for. When a new terminal may not find `rarog`
 * (the package's commands directory outside `PATH` or under a Node version manager) every command it names, the
 * pairing command too, is in the absolute form. It ends with `Done in N s.` and, after a green check with no paired
 * device, the pairing command; a run that ends with exit code 0 under `!` lines says how many need a fix instead.
 * It never reads `~/.claude/settings.json`, so nothing it prints or logs quotes the
 * user's settings.
 */
import path from 'node:path';
import { activeDeviceEpochs } from '../auth/devices-store.ts';
import type { InstallMode } from '../install/mode.ts';
import {
  installationCli, npmBinDir, rarogCli, repairCommands, shellQuote, underVersionManager,
} from '../install/repair.ts';
import { readPackageVersion } from '../version.ts';
import { EXIT_OK, EXIT_REFUSED } from './io.ts';
import { onPath } from './restart.ts';
import { shortVersion } from './screen/style.ts';
import { configPort, errnoCode, isRecord } from './setup-context.ts';
import type { Ctx } from './setup-context.ts';

/** How long the check waits for a healthy `/health`: one ceiling for setup, `rarog update` and the owner's script. */
export const CHECK_HEALTH_TIMEOUT_MS = 30_000;

/** Pause between two `/health` reads while the server comes up. */
const POLL_MS = 500;

/** Ceiling of one `/health` request. */
const REQUEST_MS = 3_000;

/** The service after the service step: it runs (found loaded or installed now), there is none, or neither is clear. */
export type ServiceAfterSetup = Ctx['service'];

/** The node and the entry of an installation: its commands in the absolute form (`installationCli`). */
export interface CliTarget {
  readonly node: string;
  readonly bin: string;
}

export interface CheckResult {
  readonly status: 'ok' | 'warn' | 'fail' | 'skip';
  /** The step line's result. */
  readonly result: string;
  readonly fix?: string;
  /** The server answered `/health`, so pairing can follow. */
  readonly answered: boolean;
}

export interface CheckOptions {
  readonly service: ServiceAfterSetup;
  readonly port: number;
  /** Version of this installation (`package.json`). */
  readonly packageVersion: string;
  /**
   * Commands of this installation's mode the result and `Fix:` name; `afterUpdate` makes the service run this
   * installation (`RepairCommands.afterUpdate`: a restart under npm, `rarog service install` under pnpm).
   */
  readonly commands: { readonly restart: string; readonly doctor: string; readonly afterUpdate: string };
  /** Screen title of the step a service that does not run waits for; default `Service`. */
  readonly waitsFor?: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  /**
   * `rarog update --finish`: the check waits for `hook: ok` too (the server reads the hook copy again every few
   * seconds), and a hook not `ok` at the ceiling fails the check with this command in `Fix:`.
   */
  readonly requireHook?: { readonly fix: string };
  /**
   * `rarog update --finish`: a server on another version than this package fails the check with this command in
   * `Fix:`, because after the finish's restart or service move it means the service starts another installation.
   * Without it such a server is a warning with the `afterUpdate` command (`rarog setup`).
   */
  readonly requireVersion?: { readonly fix: string };
  /** A detail line: the run log, and the screen with `--verbose`. */
  readonly detail: (text: string) => void;
}

type HealthRead = { readonly body: Record<string, unknown> } | { readonly failure: string };

async function readHealth(port: number, timeoutMs: number): Promise<HealthRead> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    if (!response.ok) return { failure: `HTTP ${String(response.status)}` };
    const body: unknown = await response.json();
    return isRecord(body) ? { body } : { failure: 'the response is not a JSON object' };
  } catch (failure) {
    const cause = isRecord(failure) ? failure['cause'] : undefined;
    return { failure: `not responding (${errnoCode(cause ?? failure)})` };
  }
}

/** One detail line with the fields the check reads; none of them quotes a file of the user. */
function healthText(body: Record<string, unknown>): string {
  const consent = isRecord(body['consent'])
    ? `, consent ${String(body['consent']['effective'])} (configured ${String(body['consent']['configured'])},`
      + ` reason ${String(body['consent']['reason'])})`
    : '';
  return `version ${String(body['version'])}, herdr ${String(body['herdr'])}, hook ${String(body['hook'])},`
    + ` sdk ${String(body['sdk'])}${consent}`;
}

/** The consent channel still resolves after the start (`starting`): the check waits for it like for herdr. */
const consentStarting = (body: Record<string, unknown>): boolean =>
  isRecord(body['consent']) && body['consent']['reason'] === 'starting';

/** Fields of a healthy server on this version: all fine, or what is not. */
function judgeFields(body: Record<string, unknown>, doctor: string): CheckResult {
  const bad: string[] = [];
  if (body['hook'] !== 'ok') bad.push(`hook ${String(body['hook'])}`);
  if (body['sdk'] !== 'ok') bad.push(`SDK ${String(body['sdk'])}`);
  const consent = body['consent'];
  if (isRecord(consent) && consent['effective'] !== consent['configured']) {
    bad.push(`consent ${String(consent['effective'])} (${String(consent['reason'])})`);
  }
  if (bad.length > 0) return { status: 'warn', result: bad.join(' · '), fix: doctor, answered: true };
  const fields = isRecord(consent) ? 'hook · SDK · herdr · consent ok' : 'hook · SDK · herdr ok';
  return { status: 'ok', result: fields, answered: true };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The check itself. A running service: `/health` until it answers with `herdr: true` (and a resolved consent
 * channel, and with `requireHook` also `hook: ok`) or the ceiling passes; a server on another version is at once a
 * warning with the `afterUpdate` command, or with `requireVersion` a failure with its command.
 */
export async function checkServer(options: CheckOptions): Promise<CheckResult> {
  if (options.service !== 'running') {
    // The step it waits for carries the one fix.
    return { status: 'skip', result: `waits for ${options.waitsFor ?? 'Service'}`, answered: false };
  }
  const timeoutMs = options.timeoutMs ?? CHECK_HEALTH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const where = `/health 127.0.0.1:${String(options.port)}`;
  let last: HealthRead = { failure: 'not read' };
  for (;;) {
    last = await readHealth(options.port, Math.min(REQUEST_MS, deadline - Date.now()));
    if ('body' in last) {
      const { body } = last;
      const version = typeof body['version'] === 'string' ? body['version'] : '?';
      if (version !== options.packageVersion) {
        options.detail(`  ${where}: ${healthText(body)}; this package is ${options.packageVersion}`);
        // The fields of an older server say nothing about this installation (its hook copy is already newer).
        return {
          status: options.requireVersion === undefined ? 'warn' : 'fail',
          result: `server runs ${shortVersion(version)}`,
          fix: options.requireVersion?.fix ?? options.commands.afterUpdate,
          answered: true,
        };
      }
      if (body['ok'] === true && body['herdr'] === true && !consentStarting(body)
        && (options.requireHook === undefined || body['hook'] === 'ok')) {
        options.detail(`  ${where}: ${healthText(body)}`);
        return judgeFields(body, options.commands.doctor);
      }
    }
    if (Date.now() + (options.pollMs ?? POLL_MS) >= deadline) break;
    await sleep(options.pollMs ?? POLL_MS);
  }
  const seconds = `${String(Math.round(timeoutMs / 1000))} s`;
  if ('failure' in last) {
    options.detail(`  ${where}: ${last.failure} within ${seconds}`);
    return {
      status: 'fail', result: `no answer on port ${String(options.port)} within ${seconds}`,
      fix: options.commands.restart, answered: false,
    };
  }
  options.detail(`  ${where}: ${healthText(last.body)} after ${seconds}`);
  // The service has just started on this configuration, so herdr: false means herdr is down; the server reconnects to
  // herdr by itself once herdr runs, and doctor tells the rarer case it does not.
  if (last.body['herdr'] !== true) {
    return {
      status: 'fail', result: `herdr: false after ${seconds}`, fix: `start herdr, then ${options.commands.doctor}`,
      answered: true,
    };
  }
  // The loop's readiness conditions hold here too: a server not ready at the ceiling is never judged as healthy.
  let blocking: string | null = null;
  if (last.body['ok'] !== true) blocking = `ok: ${String(last.body['ok'])}`;
  else if (consentStarting(last.body)) blocking = 'consent: starting';
  if (blocking !== null) {
    return {
      status: 'fail', result: `${blocking} after ${seconds}`, fix: options.commands.restart, answered: true,
    };
  }
  if (options.requireHook !== undefined && last.body['hook'] !== 'ok') {
    return {
      status: 'fail', result: `hook ${String(last.body['hook'])} after ${seconds}`, fix: options.requireHook.fix,
      answered: true,
    };
  }
  return judgeFields(last.body, options.commands.doctor);
}

export interface NewTerminalInput {
  readonly mode: InstallMode;
  readonly root: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  /** Node of this process: the absolute form runs the package with it. */
  readonly node: string;
}

/** `dir` stands in `PATH` (entries compared as resolved paths). */
function inPath(dir: string, env: NodeJS.ProcessEnv): boolean {
  const wanted = path.resolve(dir);
  return (env['PATH'] ?? '').split(':').some((entry) => path.isAbsolute(entry) && path.resolve(entry) === wanted);
}

/**
 * The installation a new terminal may not reach as `rarog`, or `null`. npm package: its commands directory
 * (`<prefix>/bin`) is outside this process's `PATH`, or under a Node version manager whose default version a new
 * terminal may switch. Other layouts (pnpm): no `rarog` in `PATH` at all. A clone runs from its directory anyway.
 */
export function newTerminalTarget(input: NewTerminalInput): CliTarget | null {
  if (input.mode !== 'package') return null;
  const target = { node: input.node, bin: path.join(input.root, 'bin', 'rarog.mjs') };
  const dir = npmBinDir(input.root);
  if (dir === null) return onPath('rarog', input.env) ? null : target;
  return underVersionManager(dir, input.home) || !inPath(dir, input.env) ? target : null;
}

/** This run's {@link newTerminalTarget}. */
export function setupCliTarget(ctx: Pick<Ctx, 'mode' | 'installRoot' | 'home' | 'io'>): CliTarget | null {
  return newTerminalTarget({
    mode: ctx.mode, root: ctx.installRoot, home: ctx.home, env: ctx.io.env, node: process.execPath,
  });
}

/**
 * The closing line: `Done in N s.`, and when the run ends with exit code 0 while `!` lines stand above it,
 * how many steps need a fix (`Done in N s; 1 step above needs a fix.`). A run with another exit code keeps the plain
 * line: its `✗` or `!` lines already say so.
 */
export function doneLine(seconds: number, run: { readonly exitZero: boolean; readonly warnings: number }): string {
  const done = `Done in ${String(seconds)} s`;
  if (!run.exitZero || run.warnings === 0) return `${done}.`;
  return run.warnings === 1 ? `${done}; 1 step above needs a fix.`
    : `${done}; ${String(run.warnings)} steps above need a fix.`;
}

/** No active device in the data directory: the run ends with the pairing command. */
function unpaired(ctx: Ctx): boolean {
  return ctx.dataDir.ok && activeDeviceEpochs(ctx.dataDir.dir).length === 0;
}

/** Version of this installation; unreadable = `?` (then any server version reads as another one). */
export function packageVersion(): string {
  try {
    return readPackageVersion();
  } catch {
    return '?';
  }
}

/**
 * The end of the run after the `Summary:` block: the Check step, the update sentence (the log, and the screen with
 * `--verbose`), then `Done in N s.` with the pairing command only when the run ends with exit code 0: a green check,
 * no step before it that sets the exit code, and no `✗` or `!` line on the screen; exit code 0 under `!`
 * lines gives {@link doneLine} with their number instead. `--verbose` shows the
 * check as detail lines and keeps no `Done` line. Returns the exit code the check adds (a failed check is a problem).
 */
export async function closingCheck(ctx: Ctx, options: {
  readonly startedAt: number;
  readonly service: ServiceAfterSetup;
  readonly update: string | null;
  /** No step before the check sets the exit code (a `missing` or `problem` step, a service left on another one). */
  readonly stepsOk: boolean;
  /** `rarog update --finish`: a hook not `ok` within the ceiling fails the check ({@link CheckOptions.requireHook}). */
  readonly requireHook?: boolean;
  /**
   * `rarog update --finish`: a server on another version fails the check with `rarog service install` of this
   * installation ({@link CheckOptions.requireVersion}).
   */
  readonly requireVersion?: boolean;
}): Promise<number> {
  const { view } = ctx;
  if (!view.verbose) view.screen.start('Check', { animate: true });
  view.detail('');
  // The commands it names keep the data directory given to setup.
  const dataDirArg = ctx.dataDirFlag === null ? '' : ` --data-dir ${shellQuote(ctx.dataDirFlag)}`;
  const check = await checkServer({
    service: options.service, port: ctx.deps.checkPort ?? configPort(ctx), packageVersion: packageVersion(),
    commands: {
      restart: repairCommands(ctx.mode, ctx.installRoot).restart, doctor: rarogCli(`doctor${dataDirArg}`, ctx.mode),
      afterUpdate: repairCommands(ctx.mode, ctx.installRoot).afterUpdate,
    },
    ...(ctx.checkWaits === null ? {} : { waitsFor: ctx.checkWaits }),
    ...(ctx.deps.checkTimeoutMs === undefined ? {} : { timeoutMs: ctx.deps.checkTimeoutMs }),
    ...(options.requireHook === true
      ? { requireHook: { fix: repairCommands(ctx.mode, ctx.installRoot).hooksInstall } } : {}),
    ...(options.requireVersion === true
      ? { requireVersion: { fix: rarogCli('service install', ctx.mode) } } : {}),
    detail: (text) => { view.detail(text); },
  });
  const target = setupCliTarget(ctx);
  const fixText = check.fix === undefined ? undefined
    : view.verbose ? view.absoluteFix(check.fix) : view.screenFix(check.fix);
  if (view.verbose) {
    view.detail(`check: ${check.result}`);
    if (fixText !== undefined) view.detail(`  Fix: ${fixText}`);
  } else {
    const fix = fixText === undefined ? {} : { fix: fixText };
    if (check.status === 'ok') view.screen.done(check.result);
    else if (check.status === 'skip') view.screen.skip(check.result);
    else if (check.status === 'warn') view.screen.warn(check.result, fix);
    else view.screen.fail(check.result, fix);
  }
  if (target !== null) {
    // No line of its own on the screen: the Fix: lines and the pairing command already use the absolute form.
    view.logOnly(`a new terminal may not find rarog; this installation runs as ${installationCli(target)} <command>`);
  }
  if (options.update !== null) {
    view.detail('');
    view.detail(options.update);
  }
  if (!view.verbose) {
    const pair = `pair${dataDirArg}`;
    // `Next:` only after a run that ends with exit code 0 and asks for no fix on the screen.
    const clean = check.status === 'ok' && options.stepsOk && !view.screen.flagged;
    const nextCommand = clean && unpaired(ctx)
      ? target === null ? rarogCli(pair, ctx.mode) : installationCli(target, pair) : null;
    const next = nextCommand === null ? null : `Next: ${nextCommand} (QR code for the app)`;
    const width = view.screen.layout.width;
    const seconds = Math.max(1, Math.round((Date.now() - options.startedAt) / 1000));
    // The run's exit code: 0 needs the steps before the check and the check itself without a failure.
    const exitZero = options.stepsOk && check.status !== 'fail';
    const done = doneLine(seconds, { exitZero, warnings: view.screen.warnings });
    view.block('');
    if (next === null || nextCommand === null) view.block(done);
    else if (done.length + 1 + next.length <= width) view.closing(`${done} ${next}`);
    else if (target === null || next.length <= width) {
      view.block(done);
      view.closing(next);
    } else {
      // The absolute command wider than the screen: alone on its line, like the new terminal line; its sentence
      // follows Done when both fit.
      const sentence = 'Next (QR code for the app):';
      if (done.length + 1 + sentence.length <= width) view.closing(`${done} ${sentence}`);
      else {
        view.block(done);
        view.closing(sentence);
      }
      view.block(`   ${nextCommand}`);
    }
    view.logOnly(done);
  }
  return check.status === 'fail' ? EXIT_REFUSED : EXIT_OK;
}
