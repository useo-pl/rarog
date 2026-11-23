/**
 * `rarog update`: the newest version of the npm package from the registry (the Download step, `update-registry.ts`),
 * then `rarog update --finish` of the version installed: a new version finishes in its own process (this one only
 * started it, so a fault in the old version's finish cannot block the new one), the same version finishes here.
 *
 * `rarog update --finish` finishes the installed version without the registry. In order: the Claude SDK it pins
 * (downloaded without a question), the service pointed at this installation when the run that has just installed it
 * says so in the update lock (`update-lock.ts`), the hook copy (its diff and question, as in setup; without the question
 * when the lock names this installation as just installed), Rarog's entries in
 * `~/.claude/settings.json` (one question only when an entry changes), `rarog restart` (its output in the run log) and
 * the closing `Check`, which here also waits for `hook: ok` and fails on a server of another version. The steps are
 * setup's (`finishSteps` in `setup.ts`). It never asks about project folders and never changes `config.json`. In the
 * repo clone and without a terminal both refuse before any write. On macOS the service is the plist and the definition
 * launchd has loaded (`launchd-loaded.ts`): either one starting another installation or node is moved by the run that
 * has just installed this installation (as is a plist launchd has not loaded) and refused otherwise; a load state
 * launchctl does not tell is refused before any step.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { INSTALL_MODE, INSTALL_ROOT } from '../install/mode.ts';
import { rarogCli, repairCommands, shellQuote } from '../install/repair.ts';
import { transientInstall } from '../install/service-target.ts';
import { readPackageVersion } from '../version.ts';
import { trackChild } from './child-output.ts';
import type { ChildSink } from './child-output.ts';
import { EXIT_INTERRUPTED, EXIT_OK, EXIT_REFUSED, Refusal, Usage, err, homeOf, out, platformOf } from './io.ts';
import type { CliIo } from './io.ts';
import { loadedDefinition } from './launchd-loaded.ts';
import {
  SERVICE_LABEL, restartCommand, serviceInstallationMismatch, servicePlistArgv, servicePlistPath,
  unitArgv,
} from './restart.ts';
import { readRarogConfig, rarogConfigDir } from './serve.ts';
import type { RarogConfig } from './serve.ts';
import { serviceInstallIfAbsent } from './service.ts';
import { SetupInterrupted, finishSteps, runDataDir } from './setup.ts';
import type { FinishSteps } from './setup.ts';
import { closingCheck, setupCliTarget } from './setup-check.ts';
import { SCREEN_TITLE, SERVICE_UNDETERMINED, entry, serviceStateFix } from './setup-context.ts';
import type { SetupDeps, Step } from './setup-context.ts';
import { SetupView } from './setup-screen.ts';
import { unitFilePath } from './systemd-unit.ts';
import { downloadStep } from './update-registry.ts';
import { UPDATE_LOCK_TOKEN, markInstalled, takeUpdateLock, updateLockOf } from './update-lock.ts';
import type { InstalledPackage, UpdateLock } from './update-lock.ts';
import { sentenceFor, usageFor } from './screen/prose.ts';

export const UPDATE_USAGE = `  rarog update [--data-dir <dir>] [--verbose]
      Updates the npm package on this machine, in a terminal: the newest version from the npm registry (npm next
      to this installation's node, without install scripts), then the finish below by the new version itself. A
      version npm holds back (release age gate) is reported and nothing else changes. One update runs at a time
      (the update lock in ~/.config/rarog). Details go to the log <data directory>/logs/update-<time>.log.
  rarog update --finish [--data-dir <dir>] [--verbose]
      Finishes the version installed on this machine, without the registry: the Claude SDK it pins (downloaded
      without a question), the hook copy (after its diff and a question, as in setup; without the question when the
      update that has just installed this version runs it), the Rarog entries in ~/.claude/settings.json (one
      [y/N/d] question, only when an entry changes), rarog restart, then a check of /health. It never asks about
      project folders and leaves config.json as it is.
      --data-dir: the installation's data directory from rarog serve --data-dir.
      --verbose: every detail line on the screen.`;

/** Command name of the run log (`<dataDir>/logs/update-….log`). */
export const UPDATE_LOG_COMMAND = 'update';

/** Step lines of a finish: four steps and the closing Check. */
const STEPS = 5;

/** Dependencies tests replace: setup's, the restart of the running service, and npm. */
export interface UpdateDeps extends SetupDeps {
  /** `rarog restart` with its output in `output` (default `restartCommand`); returns its exit code. */
  readonly restart?: (io: CliIo, output: ChildSink) => Promise<number>;
  /** `npm-cli.js` of the Download step (default: the one next to this node). */
  readonly npmCli?: string;
  /** The certificate authority of a release's provenance, DER (default: Sigstore's, `update-provenance.ts`). */
  readonly provenanceAuthority?: Buffer;
}

const DEFAULT_DEPS: UpdateDeps = {
  serviceInstall: (io, precheck, output, dataDir) => serviceInstallIfAbsent(io, precheck, undefined, {
    ...(output === undefined ? {} : { output }), ...(dataDir === undefined ? {} : { dataDir }),
  }),
};

interface Flags {
  readonly finish: boolean;
  readonly dataDir: string | null;
  readonly verbose: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  let finish = false;
  let dataDir: string | null = null;
  let verbose = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--finish') {
      finish = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--data-dir') {
      const value = argv[i + 1];
      if (value === undefined || value === '') throw new Usage('rarog update: --data-dir needs a directory.');
      if (!path.isAbsolute(value)) throw new Usage(`rarog update: --data-dir "${value}" is not an absolute path.`);
      if (dataDir !== null) throw new Usage('rarog update: --data-dir given twice.');
      dataDir = path.resolve(value);
      i += 1;
    } else {
      throw new Usage(`rarog update: unknown argument "${arg}".`);
    }
  }
  return { finish, dataDir, verbose };
}

/** The environment of the steps and their child processes: without the lock token, which only this process checks. */
function withoutToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest[UPDATE_LOCK_TOKEN];
  return rest;
}

/** The same directory: equal paths or equal `realpath` (a pnpm root is reached through a link). */
function sameDir(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The update lock names this installation as the one its run has just installed: `installed.root` is this root and
 * `installed.version` this version. Only then the finish writes the hook copy without its question.
 */
function justInstalledHere(installed: InstalledPackage | null, root: string): boolean {
  return installed !== null && sameDir(installed.root, root) && installed.version === readPackageVersion();
}

/**
 * The service against this installation, before any step. `elsewhere`: it starts another installation, or on macOS
 * this one on another node; `unloaded`: macOS, the plist is there, but launchd has nothing loaded; `unknown`:
 * `launchctl print` does not tell what is loaded; `here`: no service, an unreadable service file (the Restart step
 * says why) or this installation. `what` is the sentence of the run log.
 */
type ServiceAgainst =
  | { readonly kind: 'here' }
  | { readonly kind: 'elsewhere'; readonly what: string; readonly other: 'installation' | 'node' }
  | { readonly kind: 'unloaded'; readonly what: string }
  | { readonly kind: 'unknown'; readonly what: string };

const HERE: ServiceAgainst = { kind: 'here' };

/**
 * {@link ServiceAgainst} by `rarog restart`'s rule (`serviceInstallationMismatch`). Linux: the unit file starting
 * another installation; `rarog restart` checks the node and the loaded unit itself. macOS: the definition launchd has
 * loaded and the plist on disk, each against this installation and this node, because launchd reads the plist only at
 * `bootstrap` and `rarog restart` starts the loaded definition: after an interrupted `rarog service install` the plist
 * can name this installation while the loaded service still starts another one.
 */
function serviceAgainst(io: CliIo, platform: NodeJS.Platform, root: string): ServiceAgainst {
  const current = { node: process.execPath, bin: path.join(root, 'bin', 'rarog.mjs') };
  const home = homeOf(io.env);
  if (platform === 'linux') {
    if (entry(unitFilePath(home)) !== 'present') return HERE;
    const found = unitArgv(io);
    if ('issue' in found) return HERE;
    const mismatch = serviceInstallationMismatch(found.argv, 'package', current);
    return mismatch?.kind === 'bin' ? { kind: 'elsewhere', what: `the service ${mismatch.what}`, other: 'installation' }
      : HERE;
  }
  const loaded = loadedDefinition(SERVICE_LABEL, io, platform);
  if (loaded.kind === 'unknown') return { kind: 'unknown', what: loaded.detail };
  const file = servicePlistPath(home);
  const plist = entry(file) === 'present';
  const sources: (readonly [string, readonly string[]])[] = [];
  if (loaded.kind === 'loaded') sources.push([`the service launchd has loaded (${SERVICE_LABEL})`, loaded.argv]);
  if (plist) {
    const found = servicePlistArgv(io);
    if (!('issue' in found)) sources.push([`the service file ${file}`, found.argv]);
  }
  for (const [source, argv] of sources) {
    const mismatch = serviceInstallationMismatch(argv, 'package', current);
    if (mismatch !== null) {
      return {
        kind: 'elsewhere', what: `${source} ${mismatch.what}`, other: mismatch.kind === 'bin' ? 'installation' : 'node',
      };
    }
  }
  return plist && loaded.kind === 'absent'
    ? { kind: 'unloaded', what: `the service file ${file} is there, but launchd has no ${SERVICE_LABEL} loaded` }
    : HERE;
}

/** `rarog update` and `rarog update --finish` — `argv` starts with `update`; tests give `deps`. */
export async function updateCommand(
  argv: readonly string[], io: CliIo, deps: UpdateDeps = DEFAULT_DEPS,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(io, usageFor(io, `Usage:\n${UPDATE_USAGE}`));
    return EXIT_OK;
  }
  const flags = parseFlags(argv);
  const what = flags.finish ? 'rarog update --finish' : 'rarog update';
  const mode = deps.mode ?? INSTALL_MODE;
  const root = deps.installRoot ?? INSTALL_ROOT;
  try {
    if (mode !== 'package') {
      const clone = repairCommands('clone', root);
      throw new Refusal(`${what} ${flags.finish ? 'finishes' : 'updates'} an install of the npm package, and this is`
        + ` the repo clone ${root}: after git pull run ${clone.dependencies}, then ${clone.cli} setup and`
        + ` ${clone.restart}.`);
    }
    if (io.ask === undefined) {
      throw new Refusal(`${what}: no terminal, so nothing was changed; run rarog update in a terminal.`);
    }
    const platform = platformOf(io);
    if (platform !== 'darwin' && platform !== 'linux') {
      throw new Refusal(`${what} supports macOS and Linux (systemd --user); this platform is ${platform}.`);
    }
    const transient = transientInstall(mode, root, io.env);
    if (transient !== null) {
      throw new Refusal(`${what}: started from ${transient}, a directory that disappears when the package manager`
        + ' cache is cleared; install rarog permanently, then run rarog update.');
    }
    const config = readRarogConfig(io.env);
    if (config === null) {
      throw new Refusal(`${what}: no ${path.join(rarogConfigDir(io.env), 'config.json')}, so there is no installation`
        + ` to ${flags.finish ? 'finish' : 'update'}; run ${rarogCli('setup', mode)} first.`);
    }
    // `rarog update` installs, so it always takes the lock itself; a finish inherits the lock of a run that installed.
    const dir = rarogConfigDir(io.env);
    const lock = flags.finish ? updateLockOf(dir, io.env, what) : takeUpdateLock(dir, what);
    try {
      return await run(io, { flags, platform, config, lock, root, what }, deps);
    } finally {
      lock.release();
    }
  } catch (failure) {
    if (failure instanceof Refusal) {
      // One sentence, wrapped to the terminal; one line without a terminal.
      err(io, sentenceFor(io, failure.message.startsWith(what) ? failure.message : `${what}: ${failure.message}`));
      return EXIT_REFUSED;
    }
    throw failure;
  }
}

/** The command that runs this update again, with the `--data-dir` the user gave (the service check needs it). */
function runAgain(what: string, dataDir: string | null): string {
  return dataDir === null ? what : `${what} --data-dir ${shellQuote(dataDir)}`;
}

interface Run {
  readonly flags: Flags;
  readonly platform: NodeJS.Platform;
  readonly config: RarogConfig;
  readonly lock: UpdateLock;
  readonly root: string;
  /** What the command calls itself in its refusals. */
  readonly what: string;
}

/**
 * A finished step on the screen, without a {@link Step} (the Restart step's skip is not a missing part). Its `ok`
 * always restarted or moved the service, so it keeps its own line.
 */
function show(view: SetupView, status: 'ok' | 'skip' | 'fail', result: string, fix?: string): void {
  view.flush();
  view.detail(`  ${status}: ${result}`);
  if (view.verbose) return;
  if (status === 'ok') view.screen.done(result, { changed: true });
  else if (status === 'skip') view.screen.skip(result);
  else view.screen.fail(result, fix === undefined ? {} : { fix: view.screenFix(fix) });
}

/** A step that blocks the rest: its line ended as a problem. */
const blocks = (step: Step): boolean => step.state === 'problem' || step.state === 'missing';

/**
 * `--data-dir` of this run, checked against the service's log directory (`runDataDir`): the service install and
 * `rarog restart` get it, so they use and check it instead of this shell's directory; none without the flag.
 */
function givenDataDir(ctx: FinishSteps['ctx']): string | undefined {
  return ctx.dataDirFlag !== null && ctx.dataDir.ok ? ctx.dataDir.dir : undefined;
}

/**
 * One run on one step screen and one run log: the Download step and then the finish (`rarog update`), or the finish
 * alone (`rarog update --finish`). Ctrl-C in a step ends the screen as interrupted.
 */
async function run(io: CliIo, update: Run, deps: UpdateDeps): Promise<number> {
  const startedAt = Date.now();
  const stepIo: CliIo = { ...io, env: withoutToken(io.env) };
  const home = homeOf(stepIo.env);
  const { serviceEnv, dataDir } = runDataDir(stepIo, update.platform, update.flags.dataDir);
  // The Download step is one more line of the run's screen.
  const offset = update.flags.finish ? 0 : 1;
  const view = new SetupView({
    io: stepIo, home, verbose: update.flags.verbose, dataDir, total: STEPS + offset, command: UPDATE_LOG_COMMAND,
    cliTarget: setupCliTarget({ mode: 'package', installRoot: update.root, home, io: stepIo }),
  });
  // A run in a terminal is the user's yes: the log from the first line on.
  view.accepted();
  const stopWatching = view.watchInterrupt();
  try {
    if (!update.flags.finish) {
      const outcome = await downloadStep({
        io: stepIo, view, home, root: update.root, execPath: process.execPath, refused: EXIT_REFUSED,
        stepHeader: `[1/${String(STEPS + offset)}] Download`, ...(deps.npmCli === undefined ? {} : { npmCli: deps.npmCli }),
        ...(deps.provenanceAuthority === undefined ? {} : { provenanceAuthority: deps.provenanceAuthority }),
      });
      if (outcome.kind === 'stop') return outcome.code;
      if (outcome.kind === 'finish-new') return await startNewVersion(io, view, update, outcome.installed);
    } else if (!update.lock.inherited) {
      view.heading(`Rarog update ${readPackageVersion()}`);
    }
    const { installed } = update.lock;
    view.log.line(`update lock ${update.lock.file}${update.lock.inherited ? ' (inherited)' : ''}`
      + `${installed === null ? '' : `, installed ${installed.version} in ${installed.root}`}`);
    const copyWithoutQuestion = justInstalledHere(installed, update.root);
    if (copyWithoutQuestion) view.log.line('this run has just installed this version: the hook copy without a question');
    const steps = finishSteps(stepIo, view, {
      platform: update.platform, dataDirFlag: update.flags.dataDir, serviceEnv, dataDir, config: update.config,
      copyWithoutQuestion,
    }, deps);
    return await runSteps(stepIo, view, steps, update, deps, { startedAt, offset });
  } catch (failure) {
    if (!(failure instanceof SetupInterrupted)) throw failure;
    return view.interrupted();
  } finally {
    stopWatching();
  }
}

/**
 * Hands the run to the version this run has just installed: `installed` goes into the update lock, then that
 * version's own `rarog update --finish` runs with this node, the lock token and this terminal (its questions, its
 * screen). Ctrl-C reaches it from the terminal, so this process only waits for its end; its exit code is the
 * command's. Nothing here loads a module: the package files are already the new version's.
 */
async function startNewVersion(io: CliIo, view: SetupView, update: Run, installed: InstalledPackage): Promise<number> {
  const lock = markInstalled(update.lock, installed, update.what);
  const args = [
    path.join(installed.root, 'bin', 'rarog.mjs'), 'update', '--finish',
    ...(update.flags.dataDir === null ? [] : ['--data-dir', update.flags.dataDir]),
    ...(update.flags.verbose ? ['--verbose'] : []),
  ];
  view.log.line(`start ${process.execPath} ${args.join(' ')} with the update lock token`);
  view.flush();
  const result = await new Promise<{ readonly code: number; readonly error?: string }>((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: io.cwd, env: { ...io.env, [UPDATE_LOCK_TOKEN]: lock.token }, stdio: 'inherit',
    });
    // The child gets Ctrl-C from the terminal itself and finishes its own step; this process must not exit first.
    const untrack = trackChild(() => {});
    child.on('error', (failure) => {
      untrack();
      resolve({ code: EXIT_REFUSED, error: failure.message });
    });
    child.on('close', (code, signal) => {
      untrack();
      resolve({ code: code ?? (signal === 'SIGINT' ? EXIT_INTERRUPTED : EXIT_REFUSED) });
    });
  });
  view.log.line(`rarog update --finish of ${installed.version} ended with code ${String(result.code)}`
    + `${result.error === undefined ? '' : ` (${result.error})`}`);
  if (result.error !== undefined) {
    view.screen.step('fail', 'Finish', `rarog ${installed.version} did not start (${result.error})`,
      { fix: view.screenFix('rarog update --finish') });
  }
  return result.code;
}

async function runSteps(
  io: CliIo, view: SetupView, steps: FinishSteps, run: Run, deps: UpdateDeps,
  at: { readonly startedAt: number; readonly offset: number },
): Promise<number> {
  const { ctx } = steps;
  const service = serviceAgainst(io, run.platform, run.root);
  const installed = run.lock.installed;
  // Only the run that has just installed this installation moves the service to it or loads its plist; without
  // `installed.root` naming it the finish never changes the service.
  const repoint = installed !== null && sameDir(installed.root, run.root)
    && (service.kind === 'elsewhere' || service.kind === 'unloaded');
  let number = at.offset;
  const start = (title: string, screenTitle: string, animate: boolean): void => {
    number += 1;
    view.startStep(`[${String(number)}/${String(STEPS + at.offset)}] ${title}`, screenTitle, animate);
  };
  if (service.kind === 'unknown') {
    // Neither a restart nor a service install may guess what launchd has loaded: the refusal of rarog restart.
    start('service', 'Service', false);
    view.detail(`  ${service.what}`);
    show(view, 'fail', `${SERVICE_UNDETERMINED}; nothing was changed`, serviceStateFix(run.platform, runAgain(run.what, run.flags.dataDir)));
    return EXIT_REFUSED;
  }
  if (service.kind === 'elsewhere' && !repoint) {
    // The update lock does not name this installation as the one just installed: the refusal of rarog restart.
    start('service', 'Service', false);
    view.detail(`  ${service.what}`);
    // The command of this installation (the absolute form outside `PATH`, `screenFix`); the step line says why.
    show(view, 'fail', `starts another ${service.other}; nothing was changed`, rarogCli('service install', 'package'));
    return EXIT_REFUSED;
  }
  const results: Step[] = [];
  const step = async (header: string, title: string, animate: boolean, body: () => Promise<Step>): Promise<Step> => {
    start(header, title, animate);
    const done = await body();
    view.endStep(done, ctx.home);
    results.push(done);
    return done;
  };
  if (blocks(await step('Claude SDK', 'Claude SDK', true, steps.sdk))) return EXIT_REFUSED;
  if (repoint) {
    start('service', 'Service', true);
    view.detail(`  ${service.what}; this run installed ${installed.version} here, so rarog service install points the`
      + ' service here');
    const code = await ctx.deps.serviceInstall(view.detailIo(), () => null, (text) => { view.detail(text); },
      givenDataDir(ctx));
    if (code === EXIT_INTERRUPTED) throw new SetupInterrupted('rarog service install was interrupted (Ctrl-C)');
    if (code !== EXIT_OK) {
      // The run ends here, before Check: the steps without a change get their line now.
      if (!view.verbose) view.screen.summary();
      show(view, 'fail', `rarog service install failed (code ${String(code)})`,
        rarogCli('service install', 'package'));
      return EXIT_REFUSED;
    }
    ctx.service = 'running';
    steps.serviceMoved();
    show(view, 'ok', service.kind === 'unloaded' ? 'loaded for this installation' : 'moved to this installation');
  }
  await step('hook copy', 'Hook copy', false, steps.hook);
  await step('Settings', 'Settings', false, steps.settings);
  if (!repoint) await restart(view, steps, deps, start);
  // After the restart or the move, a server on another version runs another installation's code: a failure.
  const stepsOk = !results.some(blocks) && ctx.service !== 'other';
  const check = await closingCheck(ctx, {
    startedAt: at.startedAt, service: ctx.service, update: null, requireHook: true, requireVersion: true, stepsOk,
  });
  return !stepsOk || check !== EXIT_OK ? EXIT_REFUSED : EXIT_OK;
}

/** The Restart step: `rarog restart` of a loaded service, its output in the run log; no service = skipped. */
async function restart(
  view: SetupView, steps: FinishSteps, deps: UpdateDeps,
  start: (header: string, title: string, animate: boolean) => void,
): Promise<void> {
  const { ctx } = steps;
  start('restart', SCREEN_TITLE.restart, true);
  // A service this step leaves not running: the closing Check waits for this step, whose line carries the fix.
  ctx.checkWaits = SCREEN_TITLE.restart;
  const trace = steps.service();
  const install = rarogCli('service install', 'package');
  if (trace.kind === 'absent') {
    ctx.service = 'skipped';
    show(view, 'skip', `no service (${install})`);
    return;
  }
  ctx.service = 'other';
  if (trace.kind === 'unknown') {
    // One sentence and a fix; the tool's own message goes to the run log.
    view.detail(`  service state undetermined (${trace.detail})`);
    const again = runAgain('rarog update --finish', ctx.dataDirFlag);
    show(view, 'fail', SERVICE_UNDETERMINED, serviceStateFix(ctx.platform, again));
    return;
  }
  view.detail(`  ${trace.detail}`);
  if (!trace.loaded) {
    show(view, 'fail', 'the service is installed, but not loaded', install);
    return;
  }
  // The service must start this installation: `rarog restart` compares its target with this package.
  const dataDir = givenDataDir(ctx);
  const run = deps.restart ?? (async (io: CliIo, output: ChildSink) => restartCommand(['restart'], io, {
    output, mode: ctx.mode, current: { node: process.execPath, bin: path.join(ctx.installRoot, 'bin', 'rarog.mjs') },
    ...(dataDir === undefined ? {} : { dataDir }),
  }));
  const code = await run(view.detailIo(), (text) => { view.detail(text); });
  if (code === EXIT_INTERRUPTED) throw new SetupInterrupted('rarog restart was interrupted (Ctrl-C)');
  if (code !== EXIT_OK) {
    show(view, 'fail', `rarog restart failed (code ${String(code)})`,
      repairCommands('package', ctx.installRoot).restart);
    return;
  }
  ctx.service = 'running';
  show(view, 'ok', 'server restarted');
}
