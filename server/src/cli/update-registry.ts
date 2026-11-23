/**
 * The registry half of `rarog update`: the Download step. It refuses before any npm call when this installation is
 * another package than `@rarog/server`, asks npm (the `npm-cli.js` next to this installation's node) for the
 * newest `@rarog/server` and its `engines.node`, refuses before any install when npm's global prefix is not this
 * installation's or when the new version needs a newer Node. Then npm downloads the tarball of the highest version
 * above this one up to it into a temporary directory (npm's release age gate holds, also from the environment, and
 * never gives an older version; a gate that holds every version back is a warning that names the day npm lets the next
 * one in), `update-provenance.ts` checks that one file, and npm installs exactly that file with
 * `--ignore-scripts`. It finishes nothing: `update.ts` hands a new version to that version's own `rarog update
 * --finish`. After npm has replaced the package files this process only reads one file and starts a child, so it never
 * loads a module from the new files (no dynamic import).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PACKAGE_INSTALL, RAROG_PACKAGE_NAME, isPackageName, npmBinDir, npmSelfUpdate, npmUpdateInstallArgs,
  npmUpdatePackArgs, otherPackageFix, packageCommands, packageManagerOf,
} from '../install/repair.ts';
import { NPM_AGE_GATE_CONFIG, firstNpmError, npmCliOf, npmEnv } from '../install/sdk.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { VERSION_RE } from '../version.ts';
import { trackChild } from './child-output.ts';
import type { CliIo } from './io.ts';
import { SetupInterrupted } from './setup.ts';
import type { Step } from './setup-context.ts';
import type { SetupView } from './setup-screen.ts';
import type { InstalledPackage } from './update-lock.ts';
import { packedTarball, verifyTarball } from './update-provenance.ts';

/** `npm prefix -g`: where npm installs global packages. */
const PREFIX_ARGS = ['prefix', '-g'] as const;

/** `npm view`: the newest version on the registry and the Node it needs, as one JSON object. */
const VIEW_ARGS = ['view', `${RAROG_PACKAGE_NAME}@latest`, 'version', 'engines', '--json'] as const;

/**
 * `npm config get` of the age gate, with `-g` like the install: `min-release-age=<days>` and `before=<date>` (npm 11
 * prints `<key>=<value>` per key when it gets more than one, `null` for a key that is not set).
 */
const GATE_CONFIG_ARGS = ['config', 'get', 'min-release-age', 'before', '-g'] as const;

/**
 * `npm view` with two fields, so one JSON object `{ time, versions }`: the publication time of every version ever
 * published (`{ "<version>": "<ISO>", created, modified }`) and the versions the registry still has.
 */
const TIME_ARGS = ['view', RAROG_PACKAGE_NAME, 'time', 'versions', '--json'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ceiling of what npm prints to stdout that this module keeps (a JSON object, a path). */
const STDOUT_MAX = 1024 * 1024;
/** Ceiling of npm's stderr kept for the first error line. */
const STDERR_MAX = 64 * 1024;
/** Ceiling of a `package.json` read. */
const PACKAGE_JSON_MAX = 64 * 1024;

/** Title of the step on the screen. */
const TITLE = 'Download';

/**
 * npm's error code when no version of the install range is older than the release age gate's cutoff: `ETARGET` (none
 * in the range before the cutoff) or `ENOVERSIONS` (no version of the package before it); npm 11 prints
 * `npm error code <code>`, older npm `npm ERR! code <code>`.
 */
const NO_VERSION_OLD_ENOUGH = /^npm (?:error|ERR!) code (?:ETARGET|ENOVERSIONS)\s*$/mu;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

interface Semver {
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[];
}

function parseSemver(version: string): Semver | null {
  const match = SEMVER.exec(version);
  if (match === null) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return { core, pre: match[4] === undefined ? [] : match[4].split('.') };
}

/** Pre-release identifiers by semver: numbers by value and below words, words by ASCII order. */
function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return (a.length === 0 ? 1 : 0) - (b.length === 0 ? 1 : 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/u.test(x);
    const yn = /^\d+$/u.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Semver order of two versions: below 0 when `a` is lower, 0 when equal (build metadata ignored), above 0 when higher;
 * `null` when either is not `major.minor.patch` with an optional pre-release.
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i += 1) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return comparePre(x.pre, y.pre);
}

/** One comparator of a range: `>=22.15`, `<23`; a missing minor or patch counts as 0. */
const COMPARATOR = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u;

/**
 * Whether Node `version` (`22.22.3`) matches an `engines.node` range made of comparators (`>=`, `>`, `<=`, `<`, `=`
 * or none, with one to three numbers), joined by spaces (and) and `||` (or), the form of this package's own range;
 * `null` for any other form (`^`, `~`, `x`, hyphen ranges), which this check does not judge.
 */
export function nodeSatisfies(version: string, range: string): boolean | null {
  const node = parseSemver(version);
  if (node === null) return null;
  let any = false;
  for (const set of range.split('||')) {
    const comparators = set.trim().split(/\s+/u).filter((part) => part !== '');
    if (comparators.length === 0) return null;
    let all = true;
    for (const comparator of comparators) {
      const match = COMPARATOR.exec(comparator);
      if (match === null) return null;
      const bound = `${match[2] ?? '0'}.${match[3] ?? '0'}.${match[4] ?? '0'}`;
      const order = compareVersions(`${node.core.join('.')}`, bound) ?? 0;
      const op = match[1] ?? '=';
      const ok = op === '>=' ? order >= 0 : op === '>' ? order > 0 : op === '<=' ? order <= 0 : op === '<' ? order < 0
        : order === 0;
      if (!ok) all = false;
    }
    if (all) any = true;
  }
  return any;
}

/**
 * The days of npm's `min-release-age` from {@link GATE_CONFIG_ARGS}' output; `null` when `before` is set (npm then
 * gates by that date instead), when the age is not a positive number, or for any other output.
 */
export function gateDaysOf(stdout: string): number | null {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const match = /^([a-z-]+)=(.*)$/u.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
  }
  const age = values.get('min-release-age');
  if (values.get('before') !== 'null' || age === undefined || !/^\d+(?:\.\d+)?$/u.test(age)) return null;
  const days = Number(age);
  return days > 0 ? days : null;
}

/** When npm's age gate lets a version above this installation in. */
export interface AgeGateWait {
  /** The earliest published version of the install range. */
  readonly version: string;
  /** Full days since its publication. */
  readonly ageDays: number;
  /** The UTC day its publication plus the gate's days falls on, `YYYY-MM-DD`. */
  readonly from: string;
}

/**
 * Whether `version` is in npm's install range `>above <=upTo`: by semver order, and a pre-release only when `above`
 * or `upTo` is a pre-release of the same `major.minor.patch` (npm's range rule).
 */
function inInstallRange(version: string, above: string, upTo: string): boolean {
  const v = parseSemver(version);
  if (v === null || (compareVersions(version, above) ?? 0) <= 0 || (compareVersions(version, upTo) ?? 1) > 0) {
    return false;
  }
  if (v.pre.length === 0) return true;
  return [above, upTo].some((bound) => {
    const b = parseSemver(bound);
    return b !== null && b.pre.length > 0 && b.core.join('.') === v.core.join('.');
  });
}

/** A JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The first version npm's age gate of `days` lets in from the install range `>above <=upTo`: the earliest published
 * one of `{ time, versions }` (the value of {@link TIME_ARGS}), among the versions still on the registry only, because
 * `npm unpublish` removes a version from `versions` and keeps its `time`. `null` for another shape (`time` not an
 * object of strings, `versions` not an array of strings, a date that does not parse, a version of the range without a
 * time), for no version in the range, and for a publication in the future or a day already past, which the gate would
 * not have held back.
 */
export function ageGateWait(
  answer: unknown, gate: { readonly days: number; readonly above: string; readonly upTo: string; readonly now: number },
): AgeGateWait | null {
  if (!isRecord(answer)) return null;
  const { time, versions } = answer;
  if (!isRecord(time) || !Array.isArray(versions)) return null;
  if (!Object.values(time).every((value) => typeof value === 'string')) return null;
  let earliest: { readonly version: string; readonly at: number } | null = null;
  for (const version of versions) {
    if (typeof version !== 'string') return null;
    if (!inInstallRange(version, gate.above, gate.upTo)) continue;
    const published = time[version];
    const at = typeof published === 'string' ? Date.parse(published) : Number.NaN;
    if (Number.isNaN(at)) return null;
    if (earliest === null || at < earliest.at) earliest = { version, at };
  }
  if (earliest === null || earliest.at > gate.now) return null;
  const opens = earliest.at + gate.days * DAY_MS;
  if (opens <= gate.now) return null;
  return {
    version: earliest.version,
    ageDays: Math.floor((gate.now - earliest.at) / DAY_MS),
    from: new Date(opens).toISOString().slice(0, 10),
  };
}

/** The Download step's warning with the gate's date; `installed` = the version npm did install below it. */
export function ageGateText(wait: AgeGateWait, installed?: string): string {
  const age = `${wait.version} is ${String(wait.ageDays)} ${wait.ageDays === 1 ? 'day' : 'days'} old;`
    + ` npm installs it from ${wait.from}`;
  return installed === undefined ? `rarog ${age}` : `rarog ${installed} installed, ${age}`;
}

/** The `package.json` in `root` (a regular file) as parsed; `null` = unreadable. */
function readInstalledManifest(root: string): { readonly name?: unknown; readonly version?: unknown } | null {
  try {
    const read = readRegularFileSync(path.join(root, 'package.json'), { maxBytes: PACKAGE_JSON_MAX, followSymlink: true });
    if (read === null || read.truncated) return null;
    const parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** `version` of the `package.json` in `root` (a regular file, the shape of `VERSION_RE`); `null` = unreadable. */
export function readInstalledVersion(root: string): string | null {
  const version = readInstalledManifest(root)?.version;
  return typeof version === 'string' && VERSION_RE.test(version) ? version : null;
}

interface NpmResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly interrupted: boolean;
  readonly error?: string;
}

/**
 * `npm <args>` through `npm-cli.js` with this installation's node: stdout kept, every output line to `line` (the run
 * log). Ctrl-C sends npm SIGTERM and waits for its end (`trackChild`), so the step can end as interrupted.
 */
function runNpm(
  run: { readonly execPath: string; readonly npmCli: string; readonly env: Record<string, string>; readonly cwd: string },
  args: readonly string[], line: (text: string) => void,
): Promise<NpmResult> {
  return new Promise((resolve) => {
    const child = spawn(run.execPath, [run.npmCli, ...args], {
      cwd: run.cwd, env: run.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let interrupted = false;
    const untrack = trackChild(() => {
      child.kill(interrupted ? 'SIGKILL' : 'SIGTERM');
      interrupted = true;
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < STDOUT_MAX) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < STDERR_MAX) stderr += chunk;
    });
    child.on('error', (failure) => {
      untrack();
      resolve({ code: null, stdout, stderr, interrupted, error: failure.message });
    });
    child.on('close', (code) => {
      untrack();
      for (const text of `${stdout}${stderr}`.split('\n')) if (text.trim() !== '') line(`  npm: ${text.trimEnd()}`);
      resolve({ code, stdout, stderr, interrupted });
    });
  });
}

/** What `update.ts` does after the Download step. */
export type DownloadOutcome =
  /** Nothing newer on npm: finish this version in this process (the hook copy keeps its question). */
  | { readonly kind: 'finish-here' }
  /** A new version is installed: its own `rarog update --finish`, with `installed` in the update lock. */
  | { readonly kind: 'finish-new'; readonly installed: InstalledPackage }
  /** Refused, failed, or held back by the age gate: the command ends with `code`. */
  | { readonly kind: 'stop'; readonly code: number };

export interface DownloadInput {
  /** The command's I/O: its environment gives npm the registry, proxy and config (`npmEnv`), and the home. */
  readonly io: CliIo;
  readonly view: SetupView;
  readonly home: string;
  /** Root of this installation (the directory over `bin/rarog.mjs`). */
  readonly root: string;
  /** Node of this installation: it runs `npm-cli.js` and the new version. */
  readonly execPath: string;
  /** `npm-cli.js` (tests give a fake); default the one next to {@link execPath}. */
  readonly npmCli?: string;
  /** The certificate authority of a release's provenance, DER (tests give their own); default Sigstore's. */
  readonly provenanceAuthority?: Buffer;
  /** Exit code of a refusal and of a failed step. */
  readonly refused: number;
  /** The step's header line in the log and with `--verbose` (`[1/6] Download`). */
  readonly stepHeader: string;
}

/** The same directory: equal `realpath`, or equal paths when either is missing. */
function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * The npm global prefix of an npm package root `<prefix>/lib/node_modules/@rarog/server` (any name, with or without
 * a scope); `null` for any other layout.
 */
function npmPrefixOf(root: string): string | null {
  const binDir = npmBinDir(root);
  return binDir === null ? null : path.dirname(binDir);
}

/**
 * The Download step on `view`: the header with the versions, then one step line. Ctrl-C during npm =
 * {@link SetupInterrupted}.
 */
export async function downloadStep(input: DownloadInput): Promise<DownloadOutcome> {
  const { view, root } = input;
  view.startStep(input.stepHeader, TITLE, true);
  view.screen.progress('checking npm…');
  const current = readInstalledVersion(root);
  const header = (text: string): void => { view.heading(text); };
  /** A refusal whose fix is typed as it stands (`fix` is not rewritten to this installation's absolute `rarog`). */
  const refuse = (result: string, fix: string): DownloadOutcome => {
    view.flush();
    view.detail(`  fail: ${result}; fix: ${fix}`);
    if (!view.verbose) view.screen.fail(result, { fix });
    return { kind: 'stop', code: input.refused };
  };
  const stop = (step: Omit<Step, 'title'>, code = input.refused): DownloadOutcome => {
    // The step line is not on the screen with --verbose, so the reason and the fix go to the detail lines.
    view.flush();
    view.detail(`  ${step.state === 'problem' ? 'fail' : step.state}: ${step.summary}`
      + `${step.fix === undefined ? '' : `; fix: ${step.fix}`}`);
    view.endStep({ title: TITLE, ...step }, input.home);
    return { kind: 'stop', code };
  };
  if (current === null) {
    header('Rarog update');
    return stop({ state: 'problem', summary: `no readable package.json in ${root}` });
  }
  const manager = packageManagerOf(root);
  const prefix = npmPrefixOf(root);
  const then = (update: string): string => `${update}, then rarog update --finish`;
  // The registry is asked only about this package: the update of another package name (an old local tarball,
  // a trial package) would install this one next to it, and npm refuses its command `rarog` there.
  const name = readInstalledManifest(root)?.name;
  if (name !== RAROG_PACKAGE_NAME) {
    header(`Rarog update ${current}`);
    const summary = isPackageName(name) ? `this installation is the package ${name}, not ${RAROG_PACKAGE_NAME}`
      : `this installation is not the package ${RAROG_PACKAGE_NAME}`;
    // The fix removes this installation, so its commands are the `rarog` of the new package, never this
    // installation's absolute form; the service still starts the removed package, and a finish moves a service only
    // for the run that installed its version, so `rarog service install` comes first.
    return refuse(summary, `${otherPackageFix(manager, root, name)}, then rarog service install, then rarog update`
      + ' --finish');
  }
  if (manager !== 'npm' || prefix === null) {
    header(`Rarog update ${current}`);
    // The `rarog` of the new version: another package manager puts it in another directory, so the absolute form of
    // this installation would finish the old version.
    const result = `rarog update installs with npm, and ${manager === 'pnpm' ? 'pnpm' : 'another tool'} installed`
      + ' this one';
    return refuse(result, then(packageCommands(manager, root).update));
  }
  const manual = then(packageCommands('npm', root).update);
  let npmCli = input.npmCli;
  if (npmCli === undefined) {
    const found = npmCliOf(input.execPath);
    if ('failure' in found) {
      header(`Rarog update ${current}`);
      view.detail(`  ${found.failure}`);
      return stop({ state: 'problem', summary: `no npm next to node ${input.execPath}`, fix: manual });
    }
    npmCli = found.file;
  }
  const npm = { execPath: input.execPath, npmCli, env: npmEnv(input.io.env, NPM_AGE_GATE_CONFIG), cwd: input.home };
  const log = (text: string): void => { view.detail(text); };
  /** A failed npm call: `what` failed (`npm <command>`, its exit), npm's first error line in the log. */
  const failed = (what: string, command: string, result: NpmResult, fix: string): DownloadOutcome => {
    if (result.interrupted) throw new SetupInterrupted(`npm ${command} was interrupted (Ctrl-C)`);
    const said = result.error ?? firstNpmError(result.stderr);
    if (said !== '') view.detail(`  npm ${command}: ${said}`);
    const code = result.code === null ? 'did not start' : `exit ${String(result.code)}`;
    return stop({ state: 'problem', summary: `${what} failed (npm ${command}, ${code})`, fix });
  };

  const prefixRun = await runNpm(npm, PREFIX_ARGS, log);
  const npmPrefix = prefixRun.stdout.trim();
  if (prefixRun.code !== 0 || npmPrefix === '') {
    header(`Rarog update ${current}`);
    return failed('prefix check', 'prefix', prefixRun, manual);
  }
  if (!sameDir(npmPrefix, prefix)) {
    header(`Rarog update ${current}`);
    return stop({ state: 'problem', summary: `npm installs into ${npmPrefix}, not into ${prefix} of this installation`,
      fix: manual });
  }

  const viewRun = await runNpm(npm, VIEW_ARGS, () => {});
  if (viewRun.code !== 0) {
    header(`Rarog update ${current}`);
    return failed('registry check', 'view', viewRun, 'check the network, then rarog update');
  }
  let latest: string | null = null;
  let engines: unknown;
  try {
    const parsed = JSON.parse(viewRun.stdout) as { version?: unknown; engines?: unknown } | null;
    latest = typeof parsed?.version === 'string' && VERSION_RE.test(parsed.version) ? parsed.version : null;
    engines = parsed?.engines;
  } catch {
    latest = null;
  }
  if (latest === null) {
    header(`Rarog update ${current}`);
    view.detail(`  npm view: ${viewRun.stdout.trim().slice(0, 300)}`);
    return stop({ state: 'problem', summary: `npm gave no version of ${RAROG_PACKAGE_NAME}`,
      fix: 'rarog update again later' });
  }
  view.detail(`  npm: ${RAROG_PACKAGE_NAME}@latest is ${latest}; this installation is ${current}`);
  const order = compareVersions(latest, current);
  if (latest === current || (order !== null && order <= 0)) {
    header(`Rarog update ${current}`);
    view.endStep({
      title: TITLE, state: 'warn', skipped: true,
      summary: latest === current ? `rarog ${current} is the latest` : `rarog ${current} is newer than ${latest} on npm`,
    }, input.home);
    return { kind: 'finish-here' };
  }
  header(`Rarog update ${current} → ${latest}`);
  const range = engines !== null && typeof engines === 'object' && 'node' in engines ? engines.node : undefined;
  if (typeof range === 'string') {
    const fits = nodeSatisfies(process.versions.node, range);
    if (fits === false) {
      return stop({
        state: 'problem', summary: `rarog ${latest} needs Node ${range}; this is ${process.versions.node}`,
        fix: `nvm install --lts, ${PACKAGE_INSTALL.npm}, then rarog setup`,
      });
    }
    if (fits === null) view.detail(`  engines.node ${range}: a form this check does not read, so the install goes on`);
  }

  view.screen.progress(`downloading ${latest}…`);
  const newest = latest;
  /**
   * When npm's age gate lets a version above `above` in: `min-release-age` from npm's own config, the
   * publication times from the registry; `null` = no date (`before` set, a failed call, another shape), and the text
   * stays without one.
   */
  const gateWait = async (above: string): Promise<AgeGateWait | null> => {
    const config = await runNpm(npm, GATE_CONFIG_ARGS, log);
    if (config.interrupted) throw new SetupInterrupted('npm config was interrupted (Ctrl-C)');
    const days = config.code === 0 ? gateDaysOf(config.stdout) : null;
    if (days === null) {
      view.detail('  npm age gate: no date (min-release-age not read, or before is set)');
      return null;
    }
    const timeRun = await runNpm(npm, TIME_ARGS, () => {});
    if (timeRun.interrupted) throw new SetupInterrupted('npm view was interrupted (Ctrl-C)');
    let answer: unknown = null;
    try {
      answer = timeRun.code === 0 ? JSON.parse(timeRun.stdout) as unknown : null;
    } catch {
      answer = null;
    }
    const wait = ageGateWait(answer, { days, above, upTo: newest, now: Date.now() });
    const why = timeRun.code === 0 ? 'no version to date' : firstNpmError(timeRun.stderr);
    view.detail(wait === null ? `  npm age gate: no date (npm view time: ${why})`
      : `  npm age gate: ${String(days)} days; ${wait.version} is in from ${wait.from}`);
    return wait;
  };
  /** npm's release age gate holds every version above this one back: a warning, exit 0, nothing finished. */
  const heldBack = async (detail: string): Promise<DownloadOutcome> => {
    view.detail(`  ${detail}`);
    const wait = await gateWait(current);
    const summary = wait === null ? `rarog ${latest} not installed yet (npm age gate)` : ageGateText(wait);
    return stop({ state: 'warn', summary }, 0);
  };
  /** stderr of a call whose stdout is JSON for this process, to the run log. */
  const logStderr = (result: NpmResult): void => {
    for (const text of result.stderr.split('\n')) if (text.trim() !== '') log(`  npm: ${text.trimEnd()}`);
  };
  const tooYoung = `npm found no version above ${current} old enough for its release age gate; ${current} stays`;
  // The tarball and the audit project live in a directory of this run only, removed on every way out.
  const work = mkdtempSync(path.join(os.tmpdir(), 'rarog-update-'));
  try {
    const tarballDir = path.join(work, 'tarball');
    const auditDir = path.join(work, 'audit');
    mkdirSync(tarballDir);
    mkdirSync(auditDir);
    const pack = await runNpm(npm, npmUpdatePackArgs(current, latest, tarballDir), () => {});
    logStderr(pack);
    if (pack.code !== 0 && !pack.interrupted && NO_VERSION_OLD_ENOUGH.test(pack.stderr)) return await heldBack(tooYoung);
    if (pack.code !== 0) return failed('download', 'pack', pack, 'check the network, then rarog update');
    const tarball = packedTarball(pack.stdout, tarballDir);
    if (tarball === null || !inInstallRange(tarball.version, current, latest)) {
      view.detail(`  npm pack: ${pack.stdout.trim().slice(0, 300)}`);
      return stop({ state: 'problem', summary: `npm gave no tarball of ${RAROG_PACKAGE_NAME} above ${current}`,
        fix: 'rarog update again later' });
    }
    const check = await verifyTarball({
      npm: (args, cwd) => runNpm({ ...npm, cwd }, args, () => {}), tarball, auditDir, cwd: input.home, log,
      ...(input.provenanceAuthority === undefined ? {} : { authority: input.provenanceAuthority }),
    });
    if (check.kind === 'npm-failed') {
      return failed(check.what, check.command, check.result, 'check the network, then rarog update');
    }
    if (check.kind === 'old-npm') {
      // The npm to update is the one this step runs, next to this node.
      const selfUpdate = npmSelfUpdate(npmCli) ?? `update the npm next to ${input.execPath} to 11.12 or newer`;
      return stop({ state: 'problem', summary: 'this npm does not list attestations (it needs npm 11.12 or newer)',
        fix: `${selfUpdate}, then rarog update` });
    }
    if (check.kind === 'refused') return stop({ state: 'problem', summary: check.summary, fix: check.fix });
    view.screen.progress(`installing ${tarball.version}…`);
    const install = await runNpm(npm, npmUpdateInstallArgs(tarball.file), log);
    // A dependency of the package held back by the gate is the same wait as the package.
    if (install.code !== 0 && !install.interrupted && NO_VERSION_OLD_ENOUGH.test(install.stderr)) {
      return await heldBack(tooYoung);
    }
    if (install.code !== 0) return failed('install', 'install', install, 'check the network, then rarog update');
    const after = readInstalledVersion(root);
    if (after !== tarball.version) {
      return stop({ state: 'problem', fix: manual, summary: after === null
        ? `after npm there is no readable package.json in ${root}`
        : `after npm, ${root} has ${after}, not ${tarball.version}` });
    }
    if (after !== latest) {
      const wait = await gateWait(after);
      const summary = wait === null ? `rarog ${after} installed, ${latest} not yet (npm age gate)`
        : ageGateText(wait, after);
      view.endStep({ title: TITLE, state: 'warn', summary }, input.home);
    } else {
      // The finish runs in a new process with its own screen: a line counted here would never be shown.
      view.endStep({ title: TITLE, state: 'ok', summary: `rarog ${latest} from npm`, changed: true }, input.home);
    }
    return { kind: 'finish-new', installed: { version: after, root } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
