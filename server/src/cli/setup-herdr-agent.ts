/**
 * herdr as the LaunchAgent `ai.rarog.herdr` on macOS: an item of the setup plan, so `rarog setup` writes it
 * after the one "y" to `Continue?` and, while herdr is not running, loads it (`launchctl bootstrap`) and waits for
 * herdr's ping. The agent starts `herdr server` once at login (`RunAtLoad`, no `KeepAlive`). Setup never overwrites,
 * stops, restarts or unloads it. Here also the doctor line, the command that starts herdr through a loaded agent, and
 * the lines `rarog service uninstall` prints about it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { defaultHerdrSocket } from '../config.ts';
import { HERDR_SOCKET_ENV } from '../config-env.ts';
import { createHerdrSocket } from '../herdr/socket.ts';
import { INSTALL_MODE, INSTALL_ROOT } from '../install/mode.ts';
import { rarogCli, shellQuote } from '../install/repair.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { Refusal } from './io.ts';
import type { CliIo } from './io.ts';
import { accepts, launchdDomain, launchdTarget, printedLoadState } from './restart.ts';
import {
  SCREEN_TITLE, SERVICE_UNDETERMINED, configuredHerdrSocket, entry, errnoCode, herdrSocket, isRecord, line, unsafeDir,
  waitingStep, writeIfMissing,
} from './setup-context.ts';
import type { Ctx, Step, StepState } from './setup-context.ts';
import { tilde } from './setup-plan.ts';
import type { PlanEntry } from './setup-plan.ts';

/** Label of the herdr agent in the user's GUI domain. */
export const HERDR_AGENT_LABEL = 'ai.rarog.herdr';
/** Template of the agent's plist; {@link renderHerdrAgentPlist} fills it. */
export const HERDR_AGENT_TEMPLATE = path.join(INSTALL_ROOT, 'server', 'src', 'cli', 'templates', 'herdr-agent.plist');
/** Ceiling of the wait for herdr's ping after `launchctl bootstrap` (herdr 0.9.5 restored 15 workspaces in 1 s). */
export const HERDR_START_TIMEOUT_MS = 20_000;
/** Ceiling of one ping while waiting, and the pause between pings. */
const PING_TIMEOUT_MS = 1000;
const PING_EVERY_MS = 250;
/**
 * Exit status of `launchctl print` for a domain launchd does not have (measured on macOS 27.2 with `gui/<uid>` of
 * another user): a user without a GUI login session, e.g. only over SSH, has no `gui/<uid>` domain to load an agent in.
 */
const LAUNCHCTL_NO_DOMAIN = 112;

const TITLE = 'herdr agent';

/** The agent's plist in the user's LaunchAgents directory. */
export function herdrAgentPlistPath(home: string): string {
  return path.join(home, 'Library', 'LaunchAgents', `${HERDR_AGENT_LABEL}.plist`);
}

/** The herdr server's log the agent writes to. */
export function herdrAgentLog(home: string): string {
  return path.join(home, 'Library', 'Logs', 'rarog-herdr.log');
}

/** Text in an XML element: the five special characters as entities. */
function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** Characters XML 1.0 cannot carry (C0 controls but tab, line feed and carriage return; U+FFFE, U+FFFF). */
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/u;

export interface HerdrAgentInput {
  /** herdr found by the Tools step: the first item of `ProgramArguments`. */
  readonly herdr: string;
  /** Home: the working directory, and the place of the log. */
  readonly home: string;
  /** `HERDR_SOCKET_PATH` of the agent, `null` = herdr's default socket (no `EnvironmentVariables`). */
  readonly socket: string | null;
}

/** The template through `safe-read.ts`: a regular file, no symlink, with a ceiling. */
function readTemplate(): string {
  const read = readRegularFileSync(HERDR_AGENT_TEMPLATE, { maxBytes: 64 * 1024, followSymlink: false });
  if (read === null || read.truncated) {
    throw new Error(`${HERDR_AGENT_TEMPLATE}: the template is not a regular file ≤ 64 KiB.`);
  }
  return read.bytes.toString('utf8');
}

/**
 * The agent's plist from the template, each value escaped. No `PATH`, `SHELL` or `LANG`: herdr panes are login shells
 * and set them (measured on herdr 0.9.5 under launchd). One pass over the template, so a value that contains a field
 * name is not filled again. A value XML cannot carry is a {@link Refusal}.
 */
export function renderHerdrAgentPlist(input: HerdrAgentInput, template = readTemplate()): string {
  for (const value of [input.herdr, input.home, input.socket ?? '']) {
    if (NOT_XML.test(value)) throw new Refusal(`a control character in ${JSON.stringify(value)}; a plist cannot carry it`);
  }
  const environment = input.socket === null ? '' : [
    '  <key>EnvironmentVariables</key>', '  <dict>', '    <key>HERDR_SOCKET_PATH</key>',
    `    <string>${xmlEscape(input.socket)}</string>`, '  </dict>', '',
  ].join('\n');
  const values: Readonly<Record<string, string>> = {
    LABEL: HERDR_AGENT_LABEL, HERDR: xmlEscape(input.herdr), HOME: xmlEscape(input.home),
    LOG: xmlEscape(herdrAgentLog(input.home)),
  };
  return template.replace(/^\{\{ENVIRONMENT\}\}\n|\{\{([A-Z_]*)\}\}/gmu, (match, name: string | undefined) => {
    if (name === undefined) return environment;
    const value = values[name];
    if (value === undefined) throw new Error(`${HERDR_AGENT_TEMPLATE}: template field ${match} is left unfilled.`);
    return value;
  });
}

// ---------------------------------------------------------------------------
// What launchd and the plist say
// ---------------------------------------------------------------------------

/** The agent's label in launchd: not loaded, loaded (with its pid when it runs), or why that is not known. */
type LabelState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'loaded'; readonly pid: string | null; readonly lastExit: string | null }
  | { readonly kind: 'undetermined'; readonly detail: string; readonly noDomain: boolean };

/**
 * `pid` and `last exit code` of a `launchctl print gui/<uid>/<label>` printout. Only the service's own `<name> = <value>`
 * lines count (one tab); deeper blocks such as `endpoints` have their own `pid` lines.
 */
export function parseAgentPrint(text: string): { readonly pid: string | null; readonly lastExit: string | null } {
  const fields = new Map<string, string>();
  for (const match of text.matchAll(/^\t([^\t=][^=]*?) = (.*)$/gmu)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined && !fields.has(name)) fields.set(name, value);
  }
  const pid = fields.get('pid');
  return {
    pid: pid !== undefined && /^[0-9]+$/u.test(pid) ? pid : null,
    lastExit: fields.get('last exit code') ?? null,
  };
}

/** {@link LabelState} from one `launchctl print`, by `rarog restart`'s rule (`printedLoadState`). */
function labelState(io: CliIo): LabelState {
  const target = launchdTarget(HERDR_AGENT_LABEL);
  if (target === null) return { kind: 'undetermined', detail: 'no user id', noDomain: false };
  const result = spawnSync('launchctl', ['print', target], {
    env: io.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000,
  });
  const state = printedLoadState(result);
  if (state === 'absent') return { kind: 'absent' };
  if (state === 'loaded') return { kind: 'loaded', ...parseAgentPrint(result.stdout) };
  return { kind: 'undetermined', detail: `launchctl print ${target}: ${state.unknown}`,
    noDomain: result.status === LAUNCHCTL_NO_DOMAIN };
}

/** The agent's plist through `plutil`: the program it starts and its `HERDR_SOCKET_PATH`, or why it cannot be read. */
type PlistRead = { readonly program: string; readonly socket: string | null } | { readonly issue: string };

function readAgentPlist(io: CliIo, file: string): PlistRead {
  const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], {
    env: io.env, encoding: 'utf8', timeout: 10_000,
  });
  if (converted.error !== undefined || converted.status !== 0) {
    const first = (String(converted.stderr ?? '').trim().split('\n')[0] ?? '').trim();
    return { issue: `plutil cannot read it${first === '' ? '' : ` (${first})`}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(converted.stdout);
  } catch {
    return { issue: 'plutil gave no dictionary' };
  }
  const args = isRecord(parsed) ? parsed['ProgramArguments'] : undefined;
  const program: unknown = Array.isArray(args) ? args[0] : undefined;
  if (typeof program !== 'string' || program === '') return { issue: 'no ProgramArguments' };
  const environment = isRecord(parsed) ? parsed['EnvironmentVariables'] : undefined;
  const socket = isRecord(environment) ? environment['HERDR_SOCKET_PATH'] : undefined;
  return { program, socket: typeof socket === 'string' ? socket : null };
}

/** The file exists after symlinks; a dangling symlink does not. */
function exists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// One verdict for setup and doctor
// ---------------------------------------------------------------------------

/** A verdict on the agent: a setup step without its title, and the doctor line. */
interface Finding {
  readonly state: StepState;
  /** The screen result; doctor prints it after the label. */
  readonly result: string;
  readonly fix?: string;
  /** Not in use (`–`): herdr runs outside it, or it starts at the next login. */
  readonly skipped?: boolean;
  /** launchd did not tell: doctor's `unknown`. */
  readonly undetermined?: boolean;
  /** Lines for the run log and under the doctor line. */
  readonly details: readonly string[];
  readonly changed?: boolean;
}

/** What a verdict needs besides launchd: home, the socket from `config.json` and the command that runs setup again. */
interface Where {
  readonly io: CliIo;
  readonly home: string;
  readonly socket: string;
  readonly again: string;
  /**
   * What follows a command that starts herdr: in setup `, then <setup>`, because the Service step waits for this one
   * fix; empty in `rarog doctor`, where the service already runs and reconnects to herdr by itself.
   */
  readonly afterStart: string;
}

const agentFile = (home: string): string => tilde(herdrAgentPlistPath(home), home);
const target = (): string => launchdTarget(HERDR_AGENT_LABEL) ?? HERDR_AGENT_LABEL;
const kickstart = (): string => `launchctl kickstart ${target()}`;
const bootstrapCommand = (home: string): string => `launchctl bootstrap ${launchdDomain() ?? 'gui/$UID'}`
  + ` ${agentFile(home)}`;

function undeterminedFinding(where: Where, label: Extract<LabelState, { kind: 'undetermined' }>): Finding {
  if (label.noDomain) {
    return {
      state: 'problem', result: 'no GUI login session', undetermined: true,
      fix: `log in on the Mac itself, then ${where.again}`,
      details: [`${label.detail} — launchd has no GUI domain for this user, so no agent can load; writing nothing`],
    };
  }
  return {
    state: 'problem', result: SERVICE_UNDETERMINED, undetermined: true,
    fix: `check launchctl print ${target()} in a regular terminal, then ${where.again}`,
    details: [`${label.detail} — writing nothing`],
  };
}

/** The fix of an agent setup cannot use: unload it when loaded, remove the plist, then setup writes a new one. */
function replaceFix(where: Where, loaded: boolean): string {
  return `${loaded ? `launchctl bootout ${target()} && ` : ''}rm ${agentFile(where.home)}, then ${where.again}`;
}

/**
 * An existing plist: first what it starts (the program must exist, the socket must be the one of `config.json`), then
 * the state of the label. A loaded agent that runs is `ok`; one without a process is herdr down (`kickstart`) or herdr
 * running outside it; a plist launchd has not loaded starts at the next login, or with herdr down needs `bootstrap`.
 */
async function existingFinding(where: Where, plist: PlistRead, label: LabelState): Promise<Finding> {
  const file = herdrAgentPlistPath(where.home);
  if (label.kind === 'undetermined') return undeterminedFinding(where, label);
  const loaded = label.kind === 'loaded';
  if ('issue' in plist) {
    return {
      state: 'problem', result: 'plist unreadable', fix: `check ${agentFile(where.home)}, then ${where.again}`,
      details: [`${file}: ${plist.issue}`],
    };
  }
  const stays = loaded ? ['the loaded definition stays in launchd until launchctl bootout'] : [];
  if (!exists(plist.program)) {
    return {
      state: 'missing', result: `herdr missing at ${tilde(plist.program, where.home)}`, fix: replaceFix(where, loaded),
      details: [`${file}: ProgramArguments[0] ${plist.program} does not exist`, ...stays],
    };
  }
  const agentSocket = plist.socket ?? defaultHerdrSocket(where.home);
  if (path.resolve(agentSocket) !== path.resolve(where.socket)) {
    return {
      state: 'missing', result: 'its herdr socket is not the one in config.json', fix: replaceFix(where, loaded),
      details: [`the agent starts herdr on ${agentSocket}, config.json expects ${where.socket}`, ...stays,
        ...(loaded && label.pid !== null ? ['launchctl bootout stops that herdr and closes its panes'] : [])],
    };
  }
  if (label.kind === 'loaded' && label.pid !== null) {
    return { state: 'ok', result: `running (pid ${label.pid})`, details: [`${HERDR_AGENT_LABEL}: running, pid ${label.pid}`] };
  }
  const alive = await accepts({ path: where.socket });
  if (label.kind === 'loaded') {
    const exit = label.lastExit === null ? [] : [`launchd's last exit code: ${label.lastExit}`];
    return alive
      ? {
        state: 'info', result: 'herdr runs outside the agent', skipped: true,
        details: [`${HERDR_AGENT_LABEL}: loaded, not running; herdr answers on ${where.socket}`, ...exit],
      }
      : {
        state: 'missing', result: 'herdr is not running', fix: `${kickstart()}${where.afterStart}`,
        details: [`${HERDR_AGENT_LABEL}: loaded, not running; ${where.socket} does not respond`, ...exit],
      };
  }
  return alive
    ? {
      state: 'info', result: 'starts at next login', skipped: true,
      details: [`${file}: present, not loaded; herdr runs now`],
    }
    : {
      state: 'missing', result: 'not loaded, herdr is not running',
      fix: `${bootstrapCommand(where.home)}${where.afterStart}`,
      details: [`${file}: present, not loaded; ${where.socket} does not respond`],
    };
}

// ---------------------------------------------------------------------------
// The setup step
// ---------------------------------------------------------------------------

function stepOf(ctx: Ctx, finding: Finding): Step {
  for (const text of finding.details) line(ctx, text);
  const fix = finding.fix === undefined ? '' : `: ${finding.fix}`;
  return {
    title: TITLE, state: finding.state, summary: `herdr agent: ${finding.result}${fix}`, result: finding.result,
    ...(finding.fix === undefined ? {} : { fix: finding.fix }),
    ...(finding.skipped === true ? { skipped: true } : {}),
    ...(finding.changed === true ? { changed: true } : {}),
  };
}

/** `rarog setup` again, with the `--data-dir` of this run. */
function setupAgain(ctx: Ctx): string {
  return rarogCli(ctx.dataDirFlag === null ? 'setup' : `setup --data-dir ${shellQuote(ctx.dataDirFlag)}`, ctx.mode);
}

function whereOf(ctx: Ctx): Where {
  const again = setupAgain(ctx);
  return { io: ctx.io, home: ctx.home, socket: herdrSocket(ctx), again, afterStart: `, then ${again}` };
}

/** herdr answers its ping on `socket` (herdr's own protocol, `herdr/socket.ts`), within `timeoutMs`. */
async function herdrAnswers(socket: string, timeoutMs: number): Promise<boolean> {
  const client = createHerdrSocket({ socketPath: socket, sendEnabled: false });
  try {
    const pong = await client.request('ping', {}, { timeoutMs });
    return isRecord(pong) && typeof pong['version'] === 'string';
  } catch {
    return false;
  } finally {
    client.dispose();
  }
}

/** Pings herdr until it answers or `ceilingMs` passes: the time it took, or `null`. */
async function waitForHerdr(socket: string, ceilingMs: number): Promise<number | null> {
  const start = Date.now();
  for (;;) {
    const left = start + ceilingMs - Date.now();
    if (left <= 0) return null;
    if (await herdrAnswers(socket, Math.min(PING_TIMEOUT_MS, left))) return Date.now() - start;
    const pause = Math.min(PING_EVERY_MS, start + ceilingMs - Date.now());
    if (pause > 0) await new Promise((resolve) => { setTimeout(resolve, pause); });
  }
}

/** After a write: the one-time folder window of macOS for the binary the agent starts (TCC), in the run log. */
const TCC_NOTE = 'macOS may ask once to let herdr into folders such as Documents';

/** The plist could not be written (`reason` without the path): nothing under its name. */
function notWritten(ctx: Ctx, dir: string, reason: string): Step {
  return stepOf(ctx, {
    state: 'problem', result: `not written: ${reason}`, fix: `check ${tilde(dir, ctx.home)}, then ${setupAgain(ctx)}`,
    details: [`${herdrAgentPlistPath(ctx.home)} not written: ${reason}`],
  });
}

/**
 * After "y": the directory (created when missing, then a real directory of this user, not a symlink planted during
 * the question), the plist only while its name is free (`writeIfMissing`, mode 0644). With herdr down right after the
 * write, `launchctl bootstrap` and the wait for herdr's ping; with herdr up (started by hand meanwhile) nothing more:
 * a second server would exit with code 1, and the agent starts herdr at the next login.
 */
async function writeAgent(ctx: Ctx, plist: string): Promise<Step> {
  const file = herdrAgentPlistPath(ctx.home);
  const dir = path.dirname(file);
  if (entry(dir) === 'missing') {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (failure) {
      return notWritten(ctx, dir, errnoCode(failure));
    }
  }
  const issue = unsafeDir(dir, null);
  if (issue !== null) return notWritten(ctx, dir, issue.replace(`${dir}: `, ''));
  let written: boolean;
  try {
    written = writeIfMissing(file, plist, 0o644);
  } catch (failure) {
    return notWritten(ctx, dir, errnoCode(failure));
  }
  const where = whereOf(ctx);
  if (!written) {
    line(ctx, `${file} appeared during the question — writing nothing`);
    return stepOf(ctx, await existingFinding(where, readAgentPlist(ctx.io, file), labelState(ctx.io)));
  }
  line(ctx, `${file}: written`);
  for (const one of plist.trimEnd().split('\n')) line(ctx, `  ${one}`);
  line(ctx, TCC_NOTE);
  if (await accepts({ path: where.socket })) {
    return stepOf(ctx, {
      state: 'ok', result: 'written, starts at next login', changed: true,
      details: [`herdr answers on ${where.socket}: no bootstrap, the agent starts herdr at the next login`],
    });
  }
  const domain = launchdDomain() ?? 'gui/$UID';
  const loaded = spawnSync('launchctl', ['bootstrap', domain, file], {
    env: ctx.io.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000,
  });
  if (loaded.error !== undefined || loaded.status !== 0) {
    const first = (String(loaded.stderr ?? '').trim().split('\n')[0] ?? '').trim();
    const how = loaded.error?.message ?? `code ${String(loaded.status)}`;
    return stepOf(ctx, {
      state: 'missing', result: 'written, launchctl bootstrap failed', changed: true,
      fix: `${bootstrapCommand(ctx.home)}, then ${setupAgain(ctx)}`,
      details: [`launchctl bootstrap ${domain} ${file}: ${how}${first === '' ? '' : `, ${first}`}; the plist stays`],
    });
  }
  line(ctx, `bootstrap ${domain} ${file}`);
  const ceiling = ctx.deps.herdrStartTimeoutMs ?? HERDR_START_TIMEOUT_MS;
  const took = await waitForHerdr(where.socket, ceiling);
  const log = herdrAgentLog(ctx.home);
  return took === null
    ? stepOf(ctx, {
      state: 'missing', result: 'started, herdr does not answer', changed: true,
      fix: `check ${tilde(log, ctx.home)}, then ${setupAgain(ctx)}`,
      details: [`herdr gave no answer to its ping on ${where.socket} within ${String(ceiling / 1000)} s; log ${log}`],
    })
    : stepOf(ctx, {
      state: 'ok', result: 'herdr started', changed: true,
      details: [`herdr answered on ${where.socket} after ${(took / 1000).toFixed(1)} s`],
    });
}

/** The plist this installation writes for herdr at `herdr` and the herdr socket `socket`; a refusal it cannot carry. */
function agentPlist(herdr: string, home: string, socket: string): string {
  return renderHerdrAgentPlist({ herdr, home, socket: socket === defaultHerdrSocket(home) ? null : socket });
}

/** The agent's line of the plan screen: what and where (the folder window of macOS comes after the write). */
export function herdrAgentPlanEntry(home: string): PlanEntry {
  return { item: 'herdr', what: TITLE, where: tilde(path.dirname(herdrAgentPlistPath(home)), home) };
}

/**
 * The agent as a plan item, read without a write, when the step would write it (`null` otherwise): macOS, herdr found
 * by the Tools step, no plist, the label absent from launchd, and a plist the values can carry. `socket` is the herdr
 * socket of `config.json` (or herdr's default), read before the Config step.
 */
export function herdrAgentOffer(ctx: Ctx, socket: string): PlanEntry | null {
  if (ctx.platform !== 'darwin' || ctx.herdr === null) return null;
  if (entry(herdrAgentPlistPath(ctx.home)) !== 'missing' || labelState(ctx.io).kind !== 'absent') return null;
  try {
    agentPlist(ctx.herdr, ctx.home, socket);
  } catch (failure) {
    if (failure instanceof Refusal) return null;
    throw failure;
  }
  return herdrAgentPlanEntry(ctx.home);
}

/**
 * The herdr agent step of `rarog setup` on macOS (`null` elsewhere). An existing plist gets its verdict (no question,
 * no write). Without one: the label must be absent from launchd and herdr found by the Tools step; the plan item
 * accepted with "Continue?" leads to {@link writeAgent} (no question of its own). Without a terminal, with the
 * item declined or not in the plan, nothing is written.
 */
export async function stepHerdrAgent(ctx: Ctx): Promise<Step | null> {
  if (ctx.platform !== 'darwin') return null;
  const where = whereOf(ctx);
  if (ctx.herdr === null) {
    line(ctx, 'no herdr — install herdr first');
    // The Tools step carries the fix.
    const alive = await accepts({ path: where.socket });
    return waitingStep(TITLE, alive ? 'info' : 'missing', 'herdr agent: herdr first', SCREEN_TITLE.tools);
  }
  const file = herdrAgentPlistPath(ctx.home);
  const label = labelState(ctx.io);
  if (entry(file) !== 'missing') {
    return stepOf(ctx, await existingFinding(where, readAgentPlist(ctx.io, file), label));
  }
  if (label.kind === 'undetermined') return stepOf(ctx, undeterminedFinding(where, label));
  if (label.kind === 'loaded') {
    // A bootstrap would fail next to it; bootout stops the herdr it started.
    return stepOf(ctx, {
      state: 'missing', result: 'loaded without its plist', fix: `launchctl bootout ${target()}, then ${where.again}`,
      details: [`${HERDR_AGENT_LABEL} is loaded, ${file} is missing; launchctl bootout stops the herdr it started`],
    });
  }
  let plist: string;
  try {
    plist = agentPlist(ctx.herdr, ctx.home, where.socket);
  } catch (failure) {
    if (!(failure instanceof Refusal)) throw failure;
    return stepOf(ctx, {
      state: 'problem', result: 'herdr path unfit for a plist', fix: `install herdr at a plain path, then ${where.again}`,
      details: [failure.message],
    });
  }
  const alive = await accepts({ path: where.socket });
  line(ctx, `${file}: missing, herdr ${alive ? 'runs' : 'not running'}`);
  if (ctx.ask === null) {
    return stepOf(ctx, {
      state: alive ? 'info' : 'missing', result: 'no agent; rarog setup in a terminal writes it',
      ...(alive ? { skipped: true } : {}), details: [],
    });
  }
  // The write only after "y" to the plan that listed it.
  if (ctx.declined.has('herdr')) {
    // The user's choice, not a fault: no `Fix:` that sends them back to setup.
    return stepOf(ctx, {
      state: 'info', result: 'not written', skipped: true, details: [`${file}: not written (answer: no)`],
    });
  }
  if (!ctx.accepted.has('herdr')) {
    // The plan read another state (a plist or the label then); the next setup offers it.
    return stepOf(ctx, {
      state: 'missing', result: 'not written: not in the plan', fix: where.again,
      details: [`${file}: not written, the plan of this run did not list it`],
    });
  }
  return writeAgent(ctx, plist);
}

// ---------------------------------------------------------------------------
// Doctor, the Service step and `rarog service uninstall`
// ---------------------------------------------------------------------------

/**
 * The command that starts herdr through the agent: `launchctl kickstart` when its plist exists and launchd has it
 * loaded without a process; `null` otherwise (no agent, not loaded, running, not macOS), and the caller keeps its own
 * advice.
 */
export function herdrAgentStart(io: CliIo, home: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin' || entry(herdrAgentPlistPath(home)) === 'missing') return null;
  const label = labelState(io);
  return label.kind === 'loaded' && label.pid === null ? kickstart() : null;
}

/** A line of `rarog doctor` (its `Line`). */
export interface HerdrAgentDoctorLine {
  readonly verdict: 'ok' | 'bad' | 'unknown' | 'info';
  readonly text: string;
  readonly details?: readonly string[];
  readonly repair?: string;
}

/**
 * The doctor line of the agent, only when its plist exists on macOS (`null` otherwise): the same verdict as the setup
 * step, with the socket of the server's configuration (`expected`).
 */
export async function herdrAgentDoctorLine(
  io: CliIo, home: string, platform: NodeJS.Platform, expected: Readonly<Record<string, string>> | null,
): Promise<HerdrAgentDoctorLine | null> {
  const file = herdrAgentPlistPath(home);
  if (platform !== 'darwin' || entry(file) === 'missing') return null;
  const where: Where = {
    io, home, socket: configuredHerdrSocket(expected?.[HERDR_SOCKET_ENV], home), again: rarogCli('setup', INSTALL_MODE),
    afterStart: '',
  };
  const finding = await existingFinding(where, readAgentPlist(io, file), labelState(io));
  const verdict = finding.state === 'ok' ? 'ok' : finding.state === 'info' ? 'info'
    : finding.undetermined === true ? 'unknown' : 'bad';
  return {
    verdict, text: `herdr agent: ${HERDR_AGENT_LABEL} ${finding.result}`,
    ...(verdict === 'ok' || finding.details.length === 0 ? {} : { details: finding.details }),
    ...(finding.fix === undefined ? {} : { repair: finding.fix }),
  };
}

/**
 * Two lines for `rarog service uninstall` on macOS when the agent's plist exists: the agent stays, and how to remove
 * it. Empty without the plist.
 */
export function herdrAgentUninstallLines(home: string): string[] {
  if (entry(herdrAgentPlistPath(home)) === 'missing') return [];
  return [
    `The herdr agent ${HERDR_AGENT_LABEL} stays: it starts herdr at login, apart from Rarog.`,
    `To remove it: rm ${agentFile(home)} (from the next login); launchctl bootout ${target()} also stops herdr and`
      + ' closes its panes at once.',
  ];
}
