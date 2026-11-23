/**
 * The step screen of `rarog setup` (`server/src/cli/setup-screen.ts`): one line per step on the screen, the detail
 * lines in the run log `<dataDir>/logs/setup-….log`, `--verbose` with the old lines and the `Summary:` block, plain
 * lines without a terminal, Ctrl-C and a failed download of the Claude SDK. The diff of `~/.claude/settings.json`,
 * and blocks to paste never reach the log. Everything runs in the temporary `HOME` of `setup-harness.ts`; the service step runs the real
 * `rarog service install` against a fake `launchctl` and a fake `restart.sh` (a fake `bash` first in `PATH`).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { interruptOrExit } from '../src/cli/child-output.ts';
import { NO_TERMINAL, type CliTerminal } from '../src/cli/io.ts';
import { renderServicePlist, serviceInstallIfAbsent } from '../src/cli/service.ts';
import { SetupView } from '../src/cli/setup-screen.ts';
import { HOOK_INSTALL_FILES, STATUSLINE_INSTALL_FILES, userSettingsPath } from '../src/herdr/hook-config.ts';
import { installationCli } from '../src/install/repair.ts';
import { SDK_TMP_PREFIX, installSdk, readSdkPin, sdkRoot, sdkVersionDir } from '../src/install/sdk.ts';
import { readPackageVersion } from '../src/version.ts';
import {
  HAS_CHECKOUT, IROH_INTEL, IROH_READY, REPO, TS_HOST, YES, bin, checkoutOnly, copyHooks, dataDirOf, env,
  herdrAgentLaunchctl, home, listenHerdr, logs, markLoaded, plist, port, runSetup, setHealthBody, state, t, treeHash,
  useSetupHarness, write, writeConfig,
} from './helpers/setup-harness.ts';
import type { Question, RunOptions } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';
import { SSH_AUTH_SOCK_ENTRY, domainPrint } from './rarog-service-sandbox.ts';
import { fake } from './systemd-atrapy.ts';

useSetupHarness();

/** A terminal 60 columns wide with colour, as a phone pane in herdr. */
const TTY_60: CliTerminal = { tty: true, columns: 60, color: true };
/** Text a test puts into a foreign field of `~/.claude/settings.json`; it must never reach a log file. */
const MARKER = 'settings-file-content-never-in-a-log';
const ESC = '\x1b';
const VERSION = readSdkPin().version;

/** The screen as a person sees it: escape sequences removed, every redraw (`\r`) keeps only what comes after it. */
function visible(stdout: string): string {
  return stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').split('\n').map((line) => line.split('\r').at(-1) ?? '')
    .join('\n');
}

/** Run logs of setup in the test data directory, oldest first, with their text. */
function setupLogs(): { readonly file: string; readonly text: string }[] {
  const dir = path.join(dataDirOf(), 'logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith('setup-')).sort()
    .map((name) => ({ file: path.join(dir, name), text: readFileSync(path.join(dir, name), 'utf8') }));
}

/**
 * `launchctl` for the real `rarog service install`: the GUI domain prints a block without data directory variables,
 * a label is loaded only after `bootstrap`, everything else succeeds; the herdr agent's label as in the harness. Calls
 * go to `<logs>/launchctl`.
 */
function fakeLaunchctl(): void {
  writeFileSync(path.join(state, 'domain'), domainPrint([SSH_AUTH_SOCK_ENTRY]));
  fake(path.join(bin, 'launchctl'), [
    `printf '%s\\n' "$*" >> '${logs}/launchctl'`,
    ...herdrAgentLaunchctl(state),
    `loaded='${state}/loaded'`,
    'touch "$loaded"',
    'case "$1" in',
    '  print)',
    `    if [[ "$2" != */*/* ]]; then cat '${state}/domain'; exit 0; fi`,
    '    grep -qxF "${2##*/}" "$loaded" && exit 0 || exit 113 ;;',
    '  bootout) grep -vxF "${2##*/}" "$loaded" > "$loaded.tmp" || true; mv "$loaded.tmp" "$loaded"; exit 0 ;;',
    '  bootstrap) basename "$3" .plist >> "$loaded"; exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
  ]);
}

/** `restart.sh` replaced by a fake `bash` that prints 20 lines and succeeds; any other script runs in `/bin/bash`. */
function fakeRestartScript(): void {
  fake(path.join(bin, 'bash'), [
    `printf '%s\\n' "$*" >> '${logs}/bash'`,
    'case "$1" in',
    '  */restart.sh) for i in $(seq 1 20); do echo "restart-fake line $i"; done; exit 0 ;;',
    'esac',
    'exec /bin/bash "$@"',
  ]);
}

/** A one-line `~/.claude/settings.json` with the marker in a foreign `env` field. */
function settingsWithMarker(): void {
  write(userSettingsPath(home), `${JSON.stringify({ env: { SOME_TOOL_TOKEN: MARKER } })}\n`, 0o600);
}

/**
 * A one-line `~/.claude/settings.json` with the marker in the user's own `statusLine` command (no snapshot from it,
 * so setup offers to chain it) and in a foreign `PermissionRequest` hook command.
 */
function settingsWithForeignCommands(): void {
  write(userSettingsPath(home), `${JSON.stringify({
    statusLine: { type: 'command', command: `bash ~/bin/my-bar.sh --tag ${MARKER}` },
    hooks: {
      PermissionRequest: [
        { matcher: '*', hooks: [{ type: 'command', command: `bash ~/bin/my-guard.sh --tag ${MARKER}` }] },
      ],
    },
  })}\n`, 0o600);
}

describe.skipIf(!IS_MAC)(macOnly('rarog setup: step screen in a fresh home', 'launchd'), () => {
  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('all yes, real service step, 60 columns: one line per step, details only in the log, no settings content in it'), async () => {
    mkdirSync(path.join(home, 'Projects'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    fakeLaunchctl();
    fakeRestartScript();
    settingsWithMarker();
    const run = await runSetup({
      verbose: false, terminal: TTY_60,
      deps: {
        serviceInstall: (io, precheck, output) => serviceInstallIfAbsent(io, precheck, { timeoutMs: 50, stepMs: 10 },
          output === undefined ? {} : { output }),
      },
    });
    const screen = visible(run.stdout);
    expect(run.code, screen).toBe(0);
    // Steps that ended ok without a change have no line of their own; the run log keeps every step. This run
    // created files, so it has no "nothing changed" line either.
    expect(screen).not.toContain('nothing changed');
    for (const line of screen.split('\n')) {
      expect(line).not.toMatch(/restart-fake line|sha256|\+\+\+|backup:/u);
    }
    // No old detail line and no Summary block on the screen.
    expect(screen).not.toContain('Summary:');
    expect(screen).not.toContain('[1/10] tools');
    expect(screen).not.toMatch(/^ ✓ Tools /mu);
    expect(screen).toMatch(/^ ✓ Check {10}hook · SDK · herdr ok$/mu);
    // The live line (spinner, `n/9` and the bar) never wraps: at most 59 columns.
    const lives = run.stdout.split('\r').map((chunk) => chunk.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').split('\n')[0] ?? '')
      .filter((line) => / [0-9]+\/10 [━─]{10}/u.test(line));
    expect(lives.length).toBeGreaterThan(10);
    for (const live of lives) expect([...live].length, live).toBeLessThanOrEqual(59);
    const [log, ...more] = setupLogs();
    expect(more).toEqual([]);
    expect(log?.text).toContain('restart-fake line 1\n');
    expect(log?.text).toContain('restart-fake line 20\n');
    expect(log?.text).toContain('backup: ');
    // One total in the log: the step headers and the step lines both count the closing Check. The seventh step is the
    // herdr agent on macOS (the herdr unit on Linux), counted on both.
    expect(log?.text).toContain('[9/10] service\n');
    expect(log?.text).toMatch(/\[9\/10\] ok {6}Service: /u);
    expect(log?.text).not.toContain('/9]');
    expect(log?.text).toContain('[7/10] herdr agent (macOS)\n');
    expect(screen).not.toContain('herdr unit');
    expect(log?.text).toContain('Summary:');
    expect(log?.text).toContain('claude settings: permission, hooks (permission entries): added');
    // Neither the diff nor anything else from the user's settings file.
    expect(log?.text).not.toContain(MARKER);
    expect(log?.text).not.toContain(`+++ ${userSettingsPath(home)}`);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('"n" to the settings question: the log exists ("Continue?") and holds no settings content'), async () => {
    mkdirSync(path.join(home, 'Projects'));
    settingsWithMarker();
    const run = await runSetup({
      verbose: false, terminal: TTY_60, answer: (question) => (question === 'settings' ? 'n' : YES(question)),
    });
    expect(run.asked).toContain('settings');
    const logs = setupLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.text).toContain('claude settings: permission, hooks (permission entries): declined');
    expect(logs[0]?.text).not.toContain(MARKER);
    expect(visible(run.stdout)).not.toContain(MARKER);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('log open, the diff shown with "d", settings declined, closing check: no user command in the log'), async () => {
    mkdirSync(path.join(home, 'Projects'));
    writeConfig({
      RAROG_ORIGINS: `https://${TS_HOST}`, RAROG_PORT: String(port), RAROG_PROJECT_ROOTS: path.join(home, 'Projects'),
    }, ['/usr/bin/env']);
    settingsWithForeignCommands();
    const settings = ['d', 'n'];
    const run = await runSetup({
      verbose: false, terminal: TTY_60,
      answer: (question) => (question === 'settings' ? settings.shift() ?? 'n' : YES(question)),
    });
    expect(run.asked.filter((one) => one === 'settings')).toHaveLength(2);
    const screen = visible(run.stdout);
    // The diff "d" shows (with the user's command as the chain) stays on the screen.
    expect(screen).toContain(MARKER);
    expect(screen).toMatch(/^ – Check {10}waits for Service$/mu);
    expect(screen).not.toContain('another PermissionRequest hook');
    const logs = setupLogs();
    expect(logs).toHaveLength(1);
    for (const log of logs) expect(log.text).not.toContain(MARKER);
    expect(logs[0]?.text).toContain('claude settings: statusLine, statusLine: declined');
    expect(logs[0]?.text).toMatch(/ \[10\/10\] skip {4}Check: waits for Service\n/u);
  });

  it('--verbose: the old lines and the Summary block, the settings diff on the screen, no \\r and no escape byte', async () => {
    settingsWithMarker();
    const run = await runSetup({
      verbose: true, terminal: TTY_60, answer: (question) => (question === 'continue' ? 'y' : 'n'),
    });
    expect(run.stdout).not.toContain('\r');
    expect(run.stdout).not.toContain(ESC);
    expect(run.stdout).toContain('rarog setup: creates only what is missing');
    expect(run.stdout).toContain('[1/9] tools\n');
    expect(run.stdout).toContain('[9/9] service\n');
    expect(run.stdout).toMatch(/\nSummary:\n {2}(ok|info|MISSING|PROBLEM) /u);
    // The diff is shown with --verbose (the old screen), never in the log the plan's "y" opened.
    expect(run.stdout).toContain(`  +++ ${userSettingsPath(home)} (after the change)`);
    for (const log of setupLogs()) expect(log.text).not.toContain('+++ ');
  });

  it('without a terminal: plain lines, zero escape bytes, code 1 for what is missing, no log file', async () => {
    settingsWithMarker();
    const run = await runSetup({ verbose: false, answer: null });
    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain(ESC);
    expect(run.stdout).not.toContain('\r');
    expect(run.stdout.split('\n')[0]).toMatch(/^rarog setup \S+: no terminal, checks only$/u);
    // Without a terminal too: no line for the unchanged steps, one line for them before Check.
    expect(run.stdout).not.toMatch(/^\[1\/10\] /mu);
    expect(run.stdout).toMatch(/^\[ok\] [0-9]+ checks? ok, nothing changed$/mu);
    expect(run.stdout).toMatch(/^\[2\/10\] warn {4}Config: .*config\.json missing: run rarog setup in a terminal$/mu);
    expect(run.stdout).not.toContain('Summary:');
    expect(run.stdout).not.toContain(MARKER);
    expect(setupLogs()).toEqual([]);
  });

  it('without a terminal, tools missing: the step line names them, a Fix line says what to install', async () => {
    for (const name of ['claude', 'herdr', 'tailscale']) rmSync(path.join(bin, name));
    const run = await runSetup({ verbose: false, answer: null, deps: { irohModule: () => IROH_INTEL } });
    expect(run.code).toBe(1);
    const lines = run.stdout.split('\n');
    const at = lines.findIndex((line) => line.startsWith('[1/10] '));
    expect(lines[at]).toBe('[1/10] warn    Tools: 3 missing: claude, herdr, tailscale');
    // The Fix: sentence wraps at 60 columns, its next lines indented under the sentence.
    const next = lines.findIndex((line, index) => index > at && line.startsWith('[2/10] '));
    const fix = lines.slice(at + 1, next);
    expect(fix[0]).toMatch(/^ {3}Fix: \S/u);
    for (const line of fix) expect([...line].length, line).toBeLessThanOrEqual(60);
    for (const line of fix.slice(1)) expect(line).toMatch(/^ {8}\S/u);
    expect(fix.join('\n').replace(/\/\n +/gu, '/').replace(/\s+/gu, ' '))
      .toBe(' Fix: install Claude Code; install herdr (default ~/.local/bin/herdr); install Tailscale (no iroh native module on this machine); then rarog setup');
    // No log file without a terminal, so nothing on the screen may point at lines it does not show.
    expect(`${lines[at] ?? ''}\n${lines[at + 1] ?? ''}`).not.toMatch(/above/u);
    expect(setupLogs()).toEqual([]);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('a settings conflict: one Settings line with its fix, the reason in the run log, not on the screen'), async () => {
    mkdirSync(path.join(home, 'Projects'));
    write(userSettingsPath(home), `${JSON.stringify({ hooks: [] })}\n`, 0o600);
    const run = await runSetup({ verbose: false, terminal: TTY_60, echo: true });
    expect(run.asked).toContain('settings');
    const screen = visible(run.stdout);
    expect(screen).not.toContain('is an array');
    const lines = screen.split('\n');
    const question = lines.findIndex((line) => line.endsWith('[y/N/d] t'));
    // Right after the answer: the step line, no bare line between them.
    expect(lines[question + 1], screen).toMatch(/^ ! Settings {7}/u);
    expect(screen).toMatch(/^ {3}Fix: fix ~\/\.claude\/settings\.json by hand/mu);
    expect(setupLogs().map((log) => log.text).join('')).toContain('"hooks" is an array, not an object');
  });

  it('rarog service install fails: the step line says so with its code, Fix: and Log:, no "message above"', async () => {
    mkdirSync(path.join(home, 'Projects'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const run = await runSetup({ verbose: false, deps: { serviceInstall: () => Promise.resolve(1) } });
    expect(run.code).toBe(1);
    const lines = run.stdout.split('\n');
    // The harness prints a question without its answer, so the step line can follow it on the same line.
    const at = lines.findIndex((line) => line.includes('[9/10] '));
    expect(lines[at]?.replace(/^.*?(?=\[9\/10\] )/u, ''), run.stdout)
      .toMatch(/^\[9\/10\] FAIL {4}Service: rarog service install failed \(code 1\)( \(\S+\))?$/u);
    expect(lines[at + 1]).toBe('   Fix: rarog service install');
    expect(lines[at + 2]).toMatch(/^ {3}Log: ~\/\S+\/logs\/setup-\S+\.log$/u);
    expect(run.stdout).not.toContain('message above');
  });
});

/** Fake `npm-cli.js`: `hang` writes `started` into its working directory and waits; `fail` exits 1 like npm. */
function fakeNpm(mode: 'hang' | 'fail'): string {
  const file = path.join(t.home, `npm-${mode}`, 'npm-cli.js');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, mode === 'hang'
    ? "require('node:fs').writeFileSync('started', '');\nsetTimeout(() => {}, 60000);\n"
    : "process.stderr.write('npm error code ENOTFOUND\\n');\nprocess.exit(1);\n");
  return file;
}

/** The SDK work directory (`.tmp-*`) that has the `started` file of the fake npm, or `null`. */
function startedWorkDir(): string | null {
  const root = sdkRoot(dataDirOf());
  if (!existsSync(root)) return null;
  const work = readdirSync(root).find((name) => name.startsWith(SDK_TMP_PREFIX)
    && existsSync(path.join(root, name, 'started')));
  return work === undefined ? null : path.join(root, work);
}

/** The plan screen gets "y" (it covers the SDK download); the rest "n". */
const onlySdk = (question: Question): string => (question === 'continue' ? 't' : 'n');

describe.skipIf(!IS_MAC)(macOnly('rarog setup: the Claude SDK step on the screen (npm package)', 'launchd'), () => {
  const pkg = (): string => path.join(t.home, 'lib', 'node_modules', 'rarog');

  it('Ctrl-C during the download: npm ci stopped, its work directory removed, no version directory, code 130', async () => {
    const npm = fakeNpm('hang');
    const exits: number[] = [];
    const running = runSetup({
      verbose: false, terminal: TTY_60, answer: onlySdk,
      deps: { mode: 'package', installRoot: pkg(), sdkInstall: (options) => installSdk({ ...options, npmCli: npm }) },
    });
    const deadline = Date.now() + 20_000;
    while (startedWorkDir() === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startedWorkDir()).not.toBeNull();
    // What bin/rarog.mjs does on Ctrl-C: with npm ci running nothing exits, npm ci gets SIGTERM.
    interruptOrExit((code) => { exits.push(code); });
    const run = await running;
    expect(exits).toEqual([]);
    expect(run.code).toBe(130);
    const screen = visible(run.stdout);
    expect(screen).toContain(' ✗ Claude SDK     interrupted');
    // The log path on a line of its own under the Interrupted line.
    expect(screen).toMatch(/Interrupted\. Nothing after this step was changed\.\n {3}Log: ~\/\S+\/logs\/setup-\S+\.log\n$/u);
    expect(existsSync(sdkVersionDir(dataDirOf(), VERSION))).toBe(false);
    expect(readdirSync(sdkRoot(dataDirOf())).filter((name) => name.startsWith(SDK_TMP_PREFIX))).toEqual([]);
    expect(screen).not.toContain('Summary:');
  });

  it('failed download: ✗ with one sentence, Fix: and Log:, code 1', async () => {
    const npm = fakeNpm('fail');
    const run = await runSetup({
      verbose: false, terminal: TTY_60, answer: onlySdk,
      // The package's commands directory in PATH: the Fix line keeps `rarog` (setup-check.test.ts has the other case).
      env: env(home, { PATH: `${bin}:${path.join(t.home, 'bin')}:/usr/bin:/bin` }),
      deps: { mode: 'package', installRoot: pkg(), sdkInstall: (options) => installSdk({ ...options, npmCli: npm }) },
    });
    expect(run.code).toBe(1);
    const lines = visible(run.stdout).split('\n');
    const at = lines.findIndex((line) => line.startsWith(' ✗ Claude SDK     download failed'));
    expect(at, visible(run.stdout)).toBeGreaterThanOrEqual(0);
    const fixAt = lines.findIndex((line, index) => index > at && line.startsWith('   Fix: '));
    expect(lines[fixAt]).toBe('   Fix: check the network, then rarog setup');
    expect(lines[fixAt + 1]).toMatch(/^ {3}Log: ~\/\S+\/logs\/setup-\S+\.log$/u);
    const [log] = setupLogs();
    expect(log?.text).toContain('download failed: npm ci: exited with code 1 (npm error code ENOTFOUND)');
  });
});

describe('rarog setup: Ctrl-C at an open question', () => {
  it('no child running: the step line ends interrupted and the Interrupted line is out before the exit', async () => {
    let out = '';
    const exits: number[] = [];
    const view = new SetupView({
      io: {
        stdout: (text) => { out += text; }, stderr: (text) => { out += text; }, env: {}, cwd: '/', terminal: TTY_60,
        // What bin/rarog.mjs does on the SIGINT of its question prompt.
        ask: () => {
          interruptOrExit((code) => { exits.push(code); });
          return Promise.resolve(null);
        },
      },
      home: '/home/tester', verbose: false, dataDir: { ok: false, message: 'no data directory in this test' }, total: 12,
    });
    const stop = view.watchInterrupt();
    view.startStep('[2/11] config.json', 'Config', false);
    await view.ask?.('  Create config.json? [y/N] ');
    stop();
    expect(exits).toEqual([130]);
    const screen = visible(out);
    expect(screen).toContain(' ✗ Config         interrupted\n');
    expect(screen.endsWith('Interrupted. Nothing after this step was changed.\n')).toBe(true);
  });

  it('a ✗ in a run without a "yes" opens the run log and points at it; without a terminal no file and no Log:', () => {
    for (const terminal of [true, false]) {
      let out = '';
      const dir = path.join(t.home, terminal ? 'data-tty' : 'data-plain');
      const view = new SetupView({
        io: {
          stdout: (text) => { out += text; }, stderr: (text) => { out += text; }, env: {}, cwd: '/',
          terminal: terminal ? TTY_60 : { tty: false, columns: 0, color: false },
          ...(terminal ? { ask: () => Promise.resolve('n') } : {}),
        },
        home: t.home, verbose: false, dataDir: { ok: true, dir, source: 'rule' }, total: 9,
      });
      view.startStep('[8/9] service', 'Service', false);
      view.endStep({ title: 'service', state: 'problem', summary: 'service: x', result: 'state undetermined',
        fix: 'rarog doctor' }, t.home);
      const lines = visible(out).split('\n');
      const logs = existsSync(path.join(dir, 'logs')) ? readdirSync(path.join(dir, 'logs')) : [];
      if (terminal) {
        expect(lines).toContain(' ✗ Service        state undetermined');
        expect(lines).toContain('   Fix: rarog doctor');
        expect(logs).toHaveLength(1);
        expect(lines).toContain(`   Log: ~/${path.relative(t.home, path.join(dir, 'logs', logs[0] ?? ''))}`);
      } else {
        expect(logs).toEqual([]);
        expect(out).not.toContain('Log:');
      }
    }
  });

  /** A view on a 60-column terminal whose question prompt writes the prompt, then answers with `answer()`. */
  function questionView(answer: () => string | null) {
    const state = { out: '', prompts: [] as string[] };
    const view = new SetupView({
      io: {
        stdout: (text) => { state.out += text; }, stderr: (text) => { state.out += text; }, env: {}, cwd: '/',
        terminal: TTY_60,
        ask: (prompt) => {
          state.prompts.push(prompt);
          state.out += prompt;
          return Promise.resolve(answer());
        },
      },
      home: '/home/tester', verbose: false, dataDir: { ok: false, message: 'no data directory in this test' }, total: 9,
    });
    return { view, state };
  }

  it('Ctrl-C at the plan question, before any step: a new line, "Interrupted. Nothing was changed.", 130', async () => {
    const exits: number[] = [];
    const { view, state } = questionView(() => {
      interruptOrExit((code) => { exits.push(code); });
      return null;
    });
    const stop = view.watchInterrupt();
    await view.ask?.('? Continue? [Y/n] ');
    stop();
    expect(exits).toEqual([130]);
    expect(visible(state.out).endsWith('? Continue? [Y/n] \nInterrupted. Nothing was changed.\n')).toBe(true);
  });

  it('EOF at a question starts a new line, so the next line is not glued to the prompt', async () => {
    const { view, state } = questionView(() => null);
    expect(await view.ask?.('? Continue? [Y/n] ')).toBeNull();
    view.block('Nothing changed.');
    expect(visible(state.out)).toBe('? Continue? [Y/n] \nNothing changed.\n');
  });

  it('the question mark is cyan on a terminal with colour, the rest of the prompt unchanged', async () => {
    const { view, state } = questionView(() => 'n');
    await view.ask?.('? Continue? [Y/n] ');
    expect(state.prompts).toEqual(['\x1b[36m?\x1b[39m Continue? [Y/n] ']);
  });

  it('a step with a question or a key prompt has no time on its line; a step without one keeps it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let out = '';
      const later = (): void => { vi.setSystemTime(Date.now() + 5000); };
      const view = new SetupView({
        io: {
          stdout: (text) => { out += text; }, stderr: (text) => { out += text; }, env: {}, cwd: '/',
          terminal: { tty: true, columns: 60, color: false },
          ask: (prompt) => { out += `${prompt}y\n`; later(); return Promise.resolve('y'); },
          askSecret: (prompt) => { out += `${prompt}\n`; later(); return Promise.resolve(''); },
        },
        home: '/home/tester', verbose: false, dataDir: { ok: false, message: 'no data directory in this test' }, total: 4,
      });
      view.startStep('[1/4] Settings', 'Settings', false);
      await view.ask?.('? Add 4 Rarog entries to ~/.claude/settings.json? [y/N/d] ');
      view.endStep({ title: 'Settings', state: 'ok', summary: 'Settings: 4 entries added', changed: true }, '/home/tester');
      view.startStep('[2/4] secrets', 'Secrets', false);
      await view.askSecret?.('? Soniox EU key (hidden): ');
      view.endStep({ title: 'Secrets', state: 'ok', summary: 'secrets: key created', changed: true }, '/home/tester');
      view.startStep('[3/4] SDK', 'Claude SDK', false);
      later();
      view.endStep({ title: 'Claude SDK', state: 'ok', summary: 'SDK: 0.3.247 downloaded', changed: true }, '/home/tester');
      const steps = visible(out).split('\n').filter((line) => line.startsWith(' ✓'));
      expect(steps).toEqual([
        ' ✓ Settings       4 entries added',
        ' ✓ Secrets        key created',
        expect.stringMatching(/^ ✓ Claude SDK {5}0\.3\.247 downloaded +5 s$/u),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a ! step that wrote something counts as a change, so the run has no "nothing changed" line', () => {
    let out = '';
    const view = new SetupView({
      io: { stdout: (text) => { out += text; }, stderr: () => {}, env: {}, cwd: '/', terminal: NO_TERMINAL },
      home: '/home/tester', verbose: false, dataDir: { ok: false, message: 'no data directory in this test' }, total: 3,
    });
    view.startStep('[1/3] tools', 'Tools', false);
    view.endStep({ title: 'Tools', state: 'ok', summary: 'tools: all present' }, '/home/tester');
    view.startStep('[2/3] Settings', 'Settings', false);
    view.endStep({
      title: 'Settings', state: 'missing', summary: 'Settings: 1 entry added, 3 wait for the hook copy',
      fix: 'rarog hooks install, then rarog setup', changed: true,
    }, '/home/tester');
    view.screen.start('Check');
    view.screen.done('hook · SDK · herdr ok');
    expect(out).toContain('warn    Settings: 1 entry added, 3 wait for the hook copy');
    expect(out).not.toContain('nothing changed');
  });
});

/**
 * A package root under `<prefix>/lib/node_modules/rarog` linked to this repository, its commands directory in `PATH`
 * (the screen keeps `rarog`), and an SDK download stub that leaves a version directory the probe stub accepts.
 */
function packageInstall(prefix = path.join(t.home, 'prefix')): {
  readonly env: NodeJS.ProcessEnv; readonly deps: RunOptions['deps']; readonly root: string;
} {
  const root = path.join(prefix, 'lib', 'node_modules', 'rarog');
  mkdirSync(path.dirname(root), { recursive: true });
  symlinkSync(REPO, root);
  return {
    root,
    env: env(home, { PATH: `${bin}:${path.join(prefix, 'bin')}:/usr/bin:/bin` }),
    deps: {
      mode: 'package', installRoot: root,
      sdkInstall: (options) => {
        const dir = sdkVersionDir(options.dataDir, VERSION);
        const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
        mkdirSync(pkg, { recursive: true, mode: 0o700 });
        for (const one of [sdkRoot(options.dataDir), dir]) chmodSync(one, 0o700);
        writeFileSync(path.join(pkg, 'package.json'), '{}');
        return Promise.resolve({ ok: true, dir, raced: false });
      },
      sdkProbe: () => Promise.resolve({ ok: true }),
    },
  };
}

/** The screen lines of a run: escape sequences and redraws applied, the empty line after the last line end dropped. */
const screenLines = (stdout: string): string[] => visible(stdout).replace(/\n$/u, '').split('\n');

describe.skipIf(!IS_MAC)(macOnly('rarog setup: what each step did and one fix per problem (60 columns)', 'launchd'), () => {
  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('first setup of the package: each step that changed something says what, Check has its own line'), async () => {
    rmSync(path.join(bin, 'tailscale'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const install = packageInstall();
    const run = await runSetup({ verbose: false, terminal: TTY_60, echo: true, env: install.env, deps: install.deps });
    const screen = visible(run.stdout);
    expect(run.code, screen).toBe(0);
    expect(screen).toMatch(/^ ✓ Config {9}~\/\.config\/rarog\/config\.json: created/mu);
    expect(screen).toMatch(/^ ✓ Secrets {8}key created/mu);
    expect(screen).toMatch(/^ – Tailscale {6}not used \(iroh only\)$/mu);
    expect(screen).toMatch(/^ ✓ Hook copy {6}installed/mu);
    expect(screen).toMatch(/^ ✓ Settings {7}5 entries.* added/mu);
    expect(screen).toMatch(new RegExp(`^ ✓ Claude SDK {5}${VERSION.replace(/\./gu, '\\.')} downloaded`, 'mu'));
    expect(screen).toMatch(/^ ✓ Service {8}installed/mu);
    expect(screen).toMatch(/^ ✓ Check {10}hook · SDK · herdr ok$/mu);
    expect(screen).not.toContain('matches the source');
    expect(screen).toMatch(/^Done in [0-9]+ s\. Next: rarog pair \(QR code for the app\)$/mu);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('"n" to tailscale serve: ! Tailscale declined with the command in Fix:, a green Check and no Next: (code 1)'), async () => {
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const install = packageInstall();
    const run = await runSetup({
      verbose: false, terminal: TTY_60, echo: true, env: install.env, deps: install.deps,
      answer: (question) => (question === 'tailscale' ? 'n' : YES(question)),
    });
    expect(run.asked).toContain('tailscale');
    const lines = screenLines(run.stdout);
    const at = lines.indexOf(' ! Tailscale      declined');
    expect(at, lines.join('\n')).toBeGreaterThan(-1);
    expect(lines[at + 1]).toMatch(/^ {3}Fix: tailscale serve --bg --https=8931 [0-9]+$/u);
    expect(lines).toContain(' ✓ Check          hook · SDK · herdr ok');
    expect(run.code).toBe(1);
    // The pairing command only after a run that ends with code 0.
    expect(lines.join('\n')).not.toContain('Next:');
    expect(lines.at(-1)).toMatch(/^Done in [0-9]+ s\.$/u);
  });

  it('the service starts another installation: ✗ Hook copy in one sentence, a Fix: command and Log:', async () => {
    const other = path.join(t.home, 'old', 'lib', 'node_modules', 'rarog');
    write(path.join(other, 'bin', 'rarog.mjs'), '// another installation\n');
    write(path.join(other, 'package.json'), '{"name":"rarog","version":"0.0.9"}\n');
    mkdirSync(path.join(home, 'Projects'));
    writeConfig({
      RAROG_ORIGINS: `https://${TS_HOST}`, RAROG_PORT: String(port), RAROG_PROJECT_ROOTS: path.join(home, 'Projects'),
    }, ['/usr/bin/env']);
    write(plist(), renderServicePlist({
      programArguments: [process.execPath, path.join(other, 'bin', 'rarog.mjs'), 'serve'],
      workingDirectory: home, log: path.join(dataDirOf(), 'server.log'),
    }));
    markLoaded();
    const install = packageInstall();
    const run = await runSetup({ verbose: false, terminal: TTY_60, echo: true, env: install.env, deps: install.deps });
    const lines = screenLines(run.stdout);
    const at = lines.indexOf(' ✗ Hook copy      the service starts another installation');
    expect(at, lines.join('\n')).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe('   Fix: rarog service install, then rarog hooks install');
    expect(lines[at + 2]).toMatch(/^ {3}Log: ~\/\S+\/logs\/setup-\S+\.log$/u);
    expect(lines.join('\n')).not.toContain('`');
    expect(lines.join('\n')).not.toContain('Next:');
    expect(run.code).toBe(1);
    // The entries waiting for the hook copy are one phrase of the result; the entry written is a change.
    expect(lines).toContain(' ! Settings       2 entries added, 3 wait for the hook copy');
    expect(lines.join('\n')).not.toContain('nothing changed');
    // The whole refusal, with the service installation's own command, is the run log's.
    expect(setupLogs().map((log) => log.text).join('')).toContain('would change the hook code next to that server');
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('second setup with nothing to do: at most 5 lines, no question'), async () => {
    rmSync(path.join(bin, 'tailscale'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const install = packageInstall();
    const first = await runSetup({ verbose: false, terminal: TTY_60, echo: true, env: install.env, deps: install.deps });
    expect(first.code, visible(first.stdout)).toBe(0);
    markLoaded();
    const second = await runSetup({ verbose: false, terminal: TTY_60, echo: true, env: install.env, deps: install.deps });
    const lines = screenLines(second.stdout);
    expect(second.code, lines.join('\n')).toBe(0);
    expect(second.asked).toEqual([]);
    expect(lines.length, lines.join('\n')).toBeLessThanOrEqual(5);
    expect(lines).toContain(' ✓ Check          hook · SDK · herdr ok');
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('Service step of a loaded service reads the test /health, not the port of config.json'), async () => {
    // The config.json of a package install has no RAROG_PORT, so its port is the default one: the owner's live server.
    rmSync(path.join(bin, 'tailscale'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const install = packageInstall();
    const first = await runSetup({ verbose: false, terminal: TTY_60, echo: true, env: install.env, deps: install.deps });
    expect(first.code, visible(first.stdout)).toBe(0);
    markLoaded();
    setHealthBody({ ok: true, version: readPackageVersion(), uptime: 1, herdr: false, term: true, hook: 'ok', authStore: 'ok', sdk: 'ok' });
    const second = await runSetup({ verbose: false, terminal: TTY_60, echo: true, env: install.env, deps: install.deps });
    const screen = screenLines(second.stdout).join('\n');
    expect(screen).toMatch(/^ ✗ Service /mu);
    expect(screen).not.toContain('not responding');
  });

  it('SDK download without network: ✗ Claude SDK with one fix, the service and Check wait for it, no Next:', async () => {
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const install = packageInstall();
    const npm = fakeNpm('fail');
    const run = await runSetup({
      verbose: false, terminal: TTY_60, echo: true, env: install.env,
      deps: { ...install.deps, sdkInstall: (options) => installSdk({ ...options, npmCli: npm }) },
    });
    const lines = screenLines(run.stdout);
    expect(run.code).toBe(1);
    expect(lines.find((line) => line.startsWith(' ✗ Claude SDK '))).toBe(' ✗ Claude SDK     download failed (ENOTFOUND)');
    expect(lines.filter((line) => line.startsWith('   Fix: '))).toEqual(['   Fix: check the network, then rarog setup']);
    expect(lines).toContain(' – Service        waits for Claude SDK');
    expect(lines).toContain(' – Check          waits for Claude SDK');
    expect(lines.join('\n')).not.toContain('Next:');
    expect(lines.join('\n')).not.toContain('rarog service install');
  });

  it('SDK download where no npm stands next to node: the step says so and the fix installs Node with npm', async () => {
    const install = packageInstall();
    const nodeDir = path.join(t.home, 'pnpm-node', 'bin');
    mkdirSync(nodeDir, { recursive: true });
    const run = await runSetup({
      verbose: false, terminal: TTY_60, echo: true, env: install.env,
      deps: { ...install.deps, sdkInstall: (options) => installSdk({ ...options, execPath: path.join(nodeDir, 'node') }) },
    });
    const lines = screenLines(run.stdout);
    expect(lines.find((line) => line.startsWith(' ✗ Claude SDK '))).toBe(' ✗ Claude SDK     no npm next to node');
    const fixes = lines.filter((line) => line.startsWith('   Fix: '));
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatch(/^ {3}Fix: install Node with npm/u);
    expect(lines.join('\n')).not.toContain('check the network');
  });

  it('herdr not running: one fix on the Service line, Check waits for the service', async () => {
    mkdirSync(path.join(home, 'Projects'));
    // The copy in place: a clone writes it only from the committed state, which the export view has not.
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
    const run = await runSetup({ verbose: false, terminal: TTY_60, echo: true });
    const lines = screenLines(run.stdout);
    expect(lines).toContain(' ! Service        herdr is not running');
    expect(lines.filter((line) => line.startsWith('   Fix: '))).toEqual(['   Fix: start herdr, then node bin/rarog.mjs setup']);
    expect(lines).toContain(' – Check          waits for Service');
    expect(lines.join('\n')).not.toContain('service install');
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('"n" to the hook copy: ! Hook copy declined with the install command'), async () => {
    const install = packageInstall();
    const run = await runSetup({
      verbose: false, terminal: TTY_60, echo: true, env: install.env, deps: install.deps,
      answer: (question) => (question === 'hook' ? 'n' : YES(question)),
    });
    expect(run.asked).toContain('hook');
    const lines = screenLines(run.stdout);
    // The command stands in Fix:, where it is rewritten like every other fix and can be copied whole.
    expect(lines).toContain(' ! Hook copy      declined');
    expect(lines[lines.indexOf(' ! Hook copy      declined') + 1]).toBe('   Fix: rarog hooks install');
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('"n" to the hook copy, package under nvm outside PATH: Fix: with the absolute hooks install'), async () => {
    const install = packageInstall(path.join(home, '.config', 'nvm', 'versions', 'node', 'v22.0.0'));
    const run = await runSetup({
      verbose: false, terminal: TTY_60, echo: true, env: env(home), deps: install.deps,
      answer: (question) => (question === 'hook' ? 'n' : YES(question)),
    });
    expect(run.asked).toContain('hook');
    const absolute = installationCli({ node: process.execPath, bin: path.join(install.root, 'bin', 'rarog.mjs') });
    const lines = screenLines(run.stdout);
    const at = lines.indexOf(' ! Hook copy      declined');
    expect(at, lines.join('\n')).toBeGreaterThan(-1);
    // Wider than the screen: the absolute command stands alone on the line under Fix:.
    expect(lines.slice(at + 1, at + 3)).toEqual(['   Fix:', `     ${absolute} hooks install`]);
    expect(visible(run.stdout)).not.toMatch(/declined: rarog/u);
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog setup: a missing tool stops a first setup before the plan', 'launchd'), () => {
  /** The screen of a refused run: the header, the sentence lines up to `Fix:`, then the `Fix:` lines joined. */
  function refusal(stdout: string): { readonly sentence: string; readonly fix: string; readonly lines: string[] } {
    const lines = screenLines(stdout);
    const at = lines.findIndex((line) => line.startsWith('   Fix: '));
    return {
      lines,
      sentence: at < 1 ? '' : lines.slice(1, at).join(' '),
      fix: at < 0 ? '' : lines.slice(at).map((line) => line.trim()).join(' ').replace(/\/ /gu, '/'),
    };
  }

  for (const [name, missing, iroh, names, fix] of [
    ['no claude and no herdr', ['claude', 'herdr'], IROH_READY, 'claude and herdr',
      'Fix: install Claude Code; install herdr (default ~/.local/bin/herdr); then rarog setup'],
    ['an Intel Mac without Tailscale', ['tailscale'], IROH_INTEL, 'tailscale',
      'Fix: install Tailscale (no iroh native module on this machine); then rarog setup'],
  ] as const) {
    it(`${name}, in a terminal: one sentence with the names and Fix:, no question, code 1, nothing written`, async () => {
      for (const one of missing) rmSync(path.join(bin, one));
      const before = treeHash(home);
      const run = await runSetup({ verbose: false, terminal: TTY_60, echo: true, deps: { irohModule: () => iroh } });
      const screen = refusal(run.stdout);
      expect(run.code, screen.lines.join('\n')).toBe(1);
      expect(run.asked).toEqual([]);
      expect(screen.lines[0]).toMatch(/^Rarog setup /u);
      expect(screen.sentence).toContain(names);
      expect(screen.sentence).toMatch(/nothing changed/iu);
      expect(screen.fix).toBe(fix);
      for (const line of screen.lines) expect([...line].length, line).toBeLessThanOrEqual(60);
      // No step ran: no plan, no step line, no Log: line.
      expect(screen.lines.join('\n')).not.toMatch(/Continue\?|^ [✓✗!–] |Log:/mu);
      expect(run.installs).toBe(0);
      // Nothing in the data directory, ~/.claude, ~/.config/rarog or ~/Library/LaunchAgents, and no run log.
      expect(treeHash(home)).toEqual(before);
      expect(setupLogs()).toEqual([]);
    });
  }

  it('the same with --verbose: the lines of the tools check stay on the screen, nothing written', async () => {
    rmSync(path.join(bin, 'herdr'));
    const before = treeHash(home);
    const run = await runSetup({ terminal: TTY_60, echo: true });
    expect(run.code).toBe(1);
    expect(run.asked).toEqual([]);
    expect(run.stdout).toContain('MISSING herdr — install herdr (default ~/.local/bin/herdr)');
    expect(run.stdout).not.toContain('[1/10] tools');
    expect(run.stdout).not.toContain('Summary:');
    expect(treeHash(home)).toEqual(before);
  });

  it('an existing config.json with its own proxy address, no iroh and no Tailscale: no refusal, the steps and Check run', async () => {
    rmSync(path.join(bin, 'tailscale'));
    writeConfig({ RAROG_ORIGINS: 'https://rarog.proxy.example.org' });
    const run = await runSetup({ verbose: false, terminal: TTY_60, echo: true, deps: { irohModule: () => IROH_INTEL } });
    const lines = screenLines(run.stdout);
    expect(lines.join('\n')).not.toContain('install Tailscale');
    expect(lines.some((line) => /^ [✓✗!–] Check {10}/u.test(line)), lines.join('\n')).toBe(true);
  });

  it('an existing installation without herdr: the Tools line and its Fix: as before, the steps and Check run', async () => {
    rmSync(path.join(bin, 'herdr'));
    writeConfig({ RAROG_IROH: '1' });
    const run = await runSetup({ verbose: false, terminal: TTY_60, echo: true });
    const lines = screenLines(run.stdout);
    const at = lines.indexOf(' ! Tools          1 missing: herdr');
    expect(at, lines.join('\n')).toBeGreaterThan(-1);
    expect(lines[at + 1]).toMatch(/^ {3}Fix: install herdr /u);
    expect(lines.some((line) => /^ [✓✗!–] Check {10}/u.test(line))).toBe(true);
    expect(run.code).toBe(1);
  });

  it('--verbose of a run that goes on: the check ran before the plan, its lines stand under [1/9] tools', async () => {
    const declined = await runSetup({
      terminal: TTY_60, answer: (question) => (question === 'continue' ? 'n' : YES(question)),
    });
    expect(declined.stdout).not.toContain('[1/9] tools');
    expect(declined.stdout).not.toContain('  claude: ');
    const run = await runSetup({ terminal: TTY_60 });
    const header = run.stdout.indexOf('[1/9] tools\n');
    expect(header).toBeGreaterThan(-1);
    expect(run.stdout.indexOf('  claude: ')).toBeGreaterThan(header);
    expect(run.stdout.indexOf('  claude: ')).toBeLessThan(run.stdout.indexOf('[2/9] config.json\n'));
    expect(run.stdout).toMatch(/^ {2}ok {7}tools: all present$/mu);
  });
});
