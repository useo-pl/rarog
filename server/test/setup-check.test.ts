/**
 * The closing `Check` step of `rarog setup` (`server/src/cli/setup-check.ts`): a healthy service, a skipped service,
 * a server on another version (a warning; with `requireVersion`, the option of `rarog update --finish`, a failure),
 * no answer within the ceiling, and the line for a new terminal when the package's
 * commands directory is outside `PATH` or under a Node version manager, with the same absolute form in `Fix:`. The
 * absolute command is run in a clean environment (`env -i`) to prove it works without `rarog` in `PATH`. Everything
 * runs in the temporary `HOME` of `setup-harness.ts` with its own `/health` server, never the default port.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVICES_FILENAME } from '../src/auth/devices-store.ts';
import type { CliTerminal } from '../src/cli/io.ts';
import type { SetupDeps } from '../src/cli/setup-context.ts';
import { CHECK_HEALTH_TIMEOUT_MS, checkServer, doneLine, newTerminalTarget } from '../src/cli/setup-check.ts';
import type { CheckOptions } from '../src/cli/setup-check.ts';
import { fixLines } from '../src/cli/setup-screen.ts';
import { HOOK_INSTALL_FILES, STATUSLINE_INSTALL_FILES } from '../src/herdr/hook-config.ts';
import { installationCli, underVersionManager, withInstallationCli } from '../src/install/repair.ts';
import { readPackageVersion } from '../src/version.ts';
import {
  REPO, TS_HOST, YES, bin, copyHooks, deadPort, env, home, listenHerdr, markLoaded, port, runSetup, setHealthBody,
  state, t, useSetupHarness, writeConfig,
} from './helpers/setup-harness.ts';
import type { Question } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';

useSetupHarness();

const TTY_60: CliTerminal = { tty: true, columns: 60, color: false };
/** Wide enough that no command of a temporary path wraps. */
const TTY_WIDE: CliTerminal = { tty: true, columns: 400, color: false };
const VERSION = readPackageVersion();

/** The screen as a person sees it: escape sequences removed, every redraw (`\r`) keeps only what comes after it. */
function visible(stdout: string): string {
  return stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').split('\n').map((line) => line.split('\r').at(-1) ?? '')
    .join('\n');
}

/**
 * An existing `config.json` on `checkPort`, its `tailscale serve` mapping, the hook and script copy and a loaded
 * service: the check waits for `/health`, and no earlier step asks for a fix. The copy is in place because a clone
 * writes it only from the committed state, which a tree without `.git` (the export view) cannot give.
 */
function runningService(checkPort = port): void {
  mkdirSync(path.join(home, 'Projects'), { recursive: true });
  copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
  writeConfig({
    RAROG_ORIGINS: `https://${TS_HOST}`, RAROG_PORT: String(checkPort), RAROG_PROJECT_ROOTS: path.join(home, 'Projects'),
  }, ['/usr/bin/env']);
  writeFileSync(path.join(state, 'serve-status'), JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: { [`${TS_HOST}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${String(checkPort)}` } } } },
  }));
  markLoaded();
}

/** "y" except the Claude SDK download (no npm in these tests). */
const noSdk = (question: Question): string | null => (question === 'inne' ? 'n' : YES(question));

/** "y" on the plan screen only: every other question gets "n". */
const planOnly = (question: Question): string | null => (question === 'continue' ? 'y' : 'n');

/** The package's SDK download as a stub: the plan lists it, no npm runs. */
const sdkStub: Pick<SetupDeps, 'sdkInstall'> = {
  sdkInstall: (options) => Promise.resolve({ ok: true, dir: options.dataDir, raced: false }),
};

/** The lines from the Check step to the end of the screen, a result wrapped under its column joined again. */
function tail(screen: string): string {
  const at = /^ [✓✗!–] Check /mu.exec(screen)?.index;
  return at === undefined ? `(no Check line in)\n${screen}` : screen.slice(at).replace(/\n {18}(?=\S)/gu, ' ');
}

/** `text` as a literal part of a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * An npm package root under `<prefix>/lib/node_modules/@rarog/server`, linked to this repository (its
 * `bin/rarog.mjs`).
 */
function packageRoot(prefix: string): string {
  const root = path.join(prefix, 'lib', 'node_modules', '@rarog', 'server');
  mkdirSync(path.dirname(root), { recursive: true });
  symlinkSync(REPO, root);
  return root;
}

describe.skipIf(!IS_MAC)(macOnly('rarog setup: the closing Check step', 'launchd'), () => {
  it('service and a healthy /health: ✓ Check with the fields, Done, then the pairing command', async () => {
    runningService();
    const run = await runSetup({ verbose: false, terminal: TTY_60, answer: noSdk });
    const end = tail(visible(run.stdout));
    expect(end).toMatch(/^ ✓ Check {10}hook · SDK · herdr ok\n/u);
    expect(end).toMatch(/\n\nDone in [0-9]+ s\.\nNext: node bin\/rarog\.mjs pair \(QR code for the app\)\n$/u);
    expect(end).not.toContain('In a new terminal');
    expect(run.stdout).not.toContain('Doctor');
  });

  it('a paired device: no pairing command after Done', async () => {
    runningService();
    const devices = path.join(home, '.local', 'share', 'rarog', DEVICES_FILENAME);
    mkdirSync(path.dirname(devices), { recursive: true });
    writeFileSync(devices, `${JSON.stringify({
      version: 1, serverId: 'f'.repeat(32), revoked: [], devices: [{
        id: 'a'.repeat(32), secretHash: 'b'.repeat(64), pushKey: 'c'.repeat(43), kid: 'deadbeef', label: 'iPad',
        build: null, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), epoch: '1',
        creator: 'admin',
      }],
    })}\n`);
    const end = tail(visible((await runSetup({ verbose: false, terminal: TTY_60, answer: noSdk })).stdout));
    expect(end).toMatch(/\n\nDone in [0-9]+ s\.\n$/u);
  });

  it('service skipped (herdr not running): – Check waits for the Service step, no command, no ERROR, no pairing command', async () => {
    const run = await runSetup({ verbose: false, terminal: TTY_60, answer: planOnly });
    const screen = visible(run.stdout);
    expect(tail(screen)).toMatch(/^ – Check {10}waits for Service\n\nDone in [0-9]+ s\.\n$/u);
    expect(screen).not.toContain('ERROR');
    expect(screen).not.toContain('✗ Check');
  });

  it('server on another version: ! Check with the restart command, its fields not judged', async () => {
    runningService();
    setHealthBody({ ok: true, version: '0.0.1-old', herdr: true, hook: 'stale', sdk: 'missing' });
    const run = await runSetup({ verbose: false, terminal: TTY_60, answer: noSdk });
    const end = tail(visible(run.stdout));
    expect(end).toMatch(/^ ! Check {10}server runs 0\.0\.1-old\n {3}Fix: pnpm run restart\n/u);
    expect(end).not.toMatch(/hook|SDK/u);
    // Exit code 0 with a ! line above: the closing line says how many steps need a fix, no Next:.
    expect(run.code, run.stdout).toBe(0);
    expect(end).toMatch(/\n\nDone in [0-9]+ s; 1 step above needs a fix\.\n$/u);
  });

  it('a service installed now, no answer within the ceiling: ✗ Check with Fix: and Log:, code 1; the product ceiling is 30 s', async () => {
    expect(CHECK_HEALTH_TIMEOUT_MS).toBe(30_000);
    const dead = await deadPort();
    runningService(dead);
    // No loaded service: the Service step installs it (the harness's fake), then the check waits for /health.
    rmSync(path.join(state, 'loaded'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    const run = await runSetup({ verbose: false, terminal: TTY_60, answer: noSdk, deps: { checkPort: dead } });
    expect(run.installs).toBe(1);
    expect(run.code).toBe(1);
    const end = tail(visible(run.stdout));
    expect(end).toMatch(new RegExp(`^ ✗ Check {10}no answer on port ${String(dead)} within 1 s( +[0-9]+ s)?\\n`
      + ' {3}Fix: pnpm run restart\\n {3}Log: ~/\\S+/logs/setup-\\S+\\.log\\n', 'u'));
    expect(end).not.toContain('Next:');
  });

  it('a running service that does not answer: ✗ Service with the one fix, Check waits for it, code 1', async () => {
    const dead = await deadPort();
    runningService(dead);
    const run = await runSetup({ verbose: false, terminal: TTY_60, answer: noSdk, deps: { checkPort: dead } });
    expect(run.code).toBe(1);
    const screen = visible(run.stdout);
    expect(screen).toMatch(/^ ✗ Service {8}not responding \(ECONNREFUSED\)\n {3}Fix: pnpm run restart\n/mu);
    expect(tail(screen)).toMatch(/^ – Check {10}waits for Service\n\nDone in [0-9]+ s\.\n$/u);
    expect(screen.match(/Fix:/gu)).toHaveLength(1);
  });

  it('launchctl print refused: ✗ Service with one sentence, Fix: and Log:, launchctl\'s message only in the log', async () => {
    runningService();
    writeFileSync(path.join(state, 'launchctl-odmowa'), '');
    const run = await runSetup({ verbose: false, terminal: TTY_60, answer: noSdk });
    expect(run.code).toBe(1);
    const screen = visible(run.stdout);
    // The Fix: sentence wraps under its label; joined again it is one sentence.
    expect(screen.replace(/\n {8}(?=\S)/gu, ' ')).toMatch(new RegExp('^ ✗ Service {8}state undetermined\\n {3}Fix: check'
      + ' launchctl print gui/[0-9]+/ai\\.rarog\\.server in a regular terminal, then node bin/rarog\\.mjs setup\\n'
      + ' {3}Log: ~/\\S+/logs/setup-\\S+\\.log\\n', 'mu'));
    expect(screen).not.toContain('Operation not permitted');
    expect(tail(screen)).toMatch(/^ – Check {10}waits for Service\n/u);
    const dir = path.join(home, '.local', 'share', 'rarog', 'logs');
    expect(readdirSync(dir).map((name) => readFileSync(path.join(dir, name), 'utf8')).join(''))
      .toContain('Operation not permitted');
  });

  it('a step that sets the exit code, a green Check: Done without Next:', async () => {
    runningService();
    const run = await runSetup({
      verbose: false, terminal: TTY_60, answer: (question) => (question === 'settings' ? 'n' : noSdk(question)),
    });
    expect(run.code).toBe(1);
    const end = tail(visible(run.stdout));
    expect(end).toMatch(/^ ✓ Check {10}hook · SDK · herdr ok\n\nDone in [0-9]+ s\.\n$/u);
  });

  it('package under nvm, its commands directory not in PATH, server on another version: Fix: in the absolute form, no new terminal line and no Next:', async () => {
    const prefix = path.join(home, '.config', 'nvm', 'versions', 'node', 'v22.0.0');
    const root = packageRoot(prefix);
    runningService();
    setHealthBody({ ok: true, version: '0.0.1-old', herdr: true, hook: 'ok', sdk: 'ok' });
    const run = await runSetup({
      verbose: false, terminal: TTY_60, answer: planOnly, deps: { mode: 'package', installRoot: root, ...sdkStub },
    });
    const absolute = installationCli({ node: process.execPath, bin: path.join(root, 'bin', 'rarog.mjs') });
    const screen = visible(run.stdout);
    const end = tail(screen);
    // A command wider than the screen stands alone on its line under its sentence, so it can be copied whole.
    expect(end).toContain(`\n   Fix:\n     ${absolute} restart\n`);
    expect(end).not.toContain('In a new terminal');
    // The pairing command only after a green check.
    expect(end).not.toContain('Next');
    // Every Fix: line of the run, not only the check's, uses the absolute form.
    for (const line of screen.split('\n').filter((one) => /^(?: {3}Fix:| {5}\S)/u.test(one))) {
      expect(line).not.toMatch(/(^|[\s(;,])rarog [a-z]/u);
    }
    // No line wider than the screen except a line that is only the indented absolute command.
    const wide = screen.split('\n').filter((one) => [...one].length > 60);
    expect(wide.filter((one) => !new RegExp(`^ +${escape(absolute)}( [a-z][a-z -]*)?$`, 'u').test(one))).toEqual([]);
  });

  it('package under nvm, its commands directory not in PATH, a green check: one Next: with the absolute pairing command, which runs', async () => {
    const prefix = path.join(home, '.config', 'nvm', 'versions', 'node', 'v22.0.0');
    const root = packageRoot(prefix);
    runningService();
    // Every question "y": a declined step would leave the run without Next:.
    const run = await runSetup({
      verbose: false, terminal: TTY_60, answer: noSdk, deps: { mode: 'package', installRoot: root, ...sdkStub },
    });
    const absolute = installationCli({ node: process.execPath, bin: path.join(root, 'bin', 'rarog.mjs') });
    const end = tail(visible(run.stdout));
    expect(run.code, visible(run.stdout)).toBe(0);
    expect(end).toMatch(/^ ✓ Check /u);
    expect(end).not.toContain('In a new terminal');
    expect(end.match(/Next/gu)).toHaveLength(1);
    expect(end).toMatch(new RegExp(
      `\\nDone in [0-9]+ s\\. Next \\(QR code for the app\\):\\n {3}${escape(absolute)} pair\\n$`, 'u',
    ));
    // The command from the screen, in a new terminal without rarog, node or nvm in PATH (pairing swapped for --version).
    const shown = new RegExp(`^ {3}(${escape(absolute)}) pair$`, 'mu').exec(end)?.[1] ?? '';
    const measured = spawnSync('env', ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', 'zsh', '-fc', `${shown} --version`], {
      encoding: 'utf8', timeout: 60_000,
    });
    expect(measured.stderr).toBe('');
    expect(measured.stdout).toBe(`${VERSION}\n`);
    expect(measured.status).toBe(0);
  }, 90_000);

  it('pnpm package, server on another version: ! Check with rarog service install, not rarog restart', async () => {
    const root = path.join(t.home, 'pnpm', 'store', 'v11', 'links', '@', 'rarog', '0.1.0', 'abc123', 'node_modules',
      'rarog');
    mkdirSync(path.dirname(root), { recursive: true });
    symlinkSync(REPO, root);
    // rarog of this installation in PATH, as pnpm puts it in its bin directory.
    writeFileSync(path.join(bin, 'rarog'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    runningService();
    setHealthBody({ ok: true, version: '0.0.1-old', herdr: true, hook: 'ok', sdk: 'ok' });
    const run = await runSetup({
      verbose: false, terminal: TTY_60, answer: planOnly, deps: { mode: 'package', installRoot: root, ...sdkStub },
    });
    const end = tail(visible(run.stdout));
    expect(end).toMatch(/^ ! Check {10}server runs 0\.0\.1-old\n {3}Fix: rarog service install\n/u);
    expect(end).not.toContain('rarog restart');
  });

  it('pnpm package, the running service on another version with herdr: false: ✗ Service with rarog service install, not rarog restart', async () => {
    const root = path.join(t.home, 'pnpm', 'store', 'v11', 'links', '@', 'rarog', '0.1.0', 'abc123', 'node_modules',
      'rarog');
    mkdirSync(path.dirname(root), { recursive: true });
    symlinkSync(REPO, root);
    writeFileSync(path.join(bin, 'rarog'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    runningService();
    // The service still runs the previous installation: its rarog restart refuses for this one.
    setHealthBody({ ok: false, version: '0.0.1-old', herdr: false, hook: 'ok', sdk: 'ok' });
    const run = await runSetup({
      verbose: false, terminal: TTY_60, answer: planOnly, deps: { mode: 'package', installRoot: root, ...sdkStub },
    });
    const screen = visible(run.stdout);
    expect(screen).toMatch(/^ ✗ Service {8}herdr: false\n {3}Fix: rarog service install\n/mu);
    expect(screen).not.toContain('rarog restart');
  });

  it('pnpm package, its own service on this version with herdr: false: ✗ Service says to start herdr, not rarog restart', async () => {
    const root = path.join(t.home, 'pnpm', 'store', 'v11', 'links', '@', 'rarog', '0.1.0', 'abc123', 'node_modules',
      'rarog');
    mkdirSync(path.dirname(root), { recursive: true });
    symlinkSync(REPO, root);
    writeFileSync(path.join(bin, 'rarog'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    runningService();
    setHealthBody({ ok: false, version: VERSION, herdr: false, hook: 'ok', sdk: 'ok' });
    const run = await runSetup({
      verbose: false, terminal: TTY_60, answer: planOnly, deps: { mode: 'package', installRoot: root, ...sdkStub },
    });
    // The server is fine and reconnects to herdr by itself; a restart would not start herdr.
    const screen = visible(run.stdout);
    expect(screen).toMatch(/^ ✗ Service {8}herdr: false\n {3}Fix: run herdr in a terminal, then rarog setup\n/mu);
    expect(screen).not.toContain('rarog restart');
  });

  it('package with its commands directory in PATH, no version manager: no new terminal line, Fix: keeps rarog', async () => {
    const prefix = path.join(t.home, 'prefix');
    const root = packageRoot(prefix);
    runningService();
    setHealthBody({ ok: true, version: '0.0.1-old', herdr: true, hook: 'ok', sdk: 'ok' });
    const run = await runSetup({
      verbose: false, terminal: TTY_60, answer: planOnly, deps: { mode: 'package', installRoot: root, ...sdkStub },
      env: env(home, { PATH: `${bin}:${path.join(prefix, 'bin')}:/usr/bin:/bin` }),
    });
    const end = tail(visible(run.stdout));
    expect(end).toContain('\n   Fix: rarog restart\n');
    expect(end).not.toContain('In a new terminal');
    // The pairing command only after a green check.
    expect(end).toMatch(/\n\nDone in [0-9]+ s\.\n$/u);
  });

  it('ok: false held until the ceiling, herdr true: ✗ Check with the blocking field and the restart fix, code 1', async () => {
    runningService();
    setHealthBody({ ok: false, version: VERSION, herdr: true, hook: 'ok', sdk: 'ok' });
    const run = await runSetup({ verbose: false, terminal: TTY_60, answer: noSdk });
    expect(run.code).toBe(1);
    const end = tail(visible(run.stdout));
    expect(end).toMatch(/^ ✗ Check {10}ok: false after 1 s( +[0-9]+ s)?\n {3}Fix: pnpm run restart\n/u);
    expect(end).not.toContain('✓ Check');
  });

  it('--data-dir and an SDK problem: the doctor command in Fix: keeps --data-dir', async () => {
    runningService();
    setHealthBody({ ok: true, version: VERSION, herdr: true, hook: 'ok', sdk: 'missing' });
    const dataDir = path.join(home, 'custom-data');
    const run = await runSetup({ verbose: false, terminal: TTY_WIDE, answer: noSdk, argv: ['--data-dir', dataDir] });
    const end = tail(visible(run.stdout));
    expect(end).toMatch(/^ ! Check {10}SDK missing\n/u);
    // A command wider than the screen is never wrapped: whole, on its own line under `Fix:`.
    expect(end).toContain(`\n   Fix:\n     node bin/rarog.mjs doctor --data-dir '${dataDir}'\n`);
  });

  it('a data directory with an apostrophe: the Next: command parses in zsh and keeps the argument', async () => {
    runningService();
    const dataDir = path.join(home, "it's data");
    const run = await runSetup({ verbose: false, terminal: TTY_WIDE, answer: noSdk, argv: ['--data-dir', dataDir] });
    const next = /^Next: (.+) \(QR code for the app\)$/mu.exec(visible(run.stdout))?.[1] ?? '';
    expect(next).toMatch(/^node bin\/rarog\.mjs pair --data-dir /u);
    const parsed = spawnSync('zsh', ['-fn', '-c', next], { encoding: 'utf8' });
    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
    const words = spawnSync('zsh', ['-fc', `print -rl -- ${next}`], { encoding: 'utf8' });
    expect(words.stdout).toBe(['node', 'bin/rarog.mjs', 'pair', '--data-dir', dataDir, ''].join('\n'));
  });

  it('--verbose, package under nvm outside PATH: every Fix: line uses the absolute form', async () => {
    const prefix = path.join(home, '.config', 'nvm', 'versions', 'node', 'v22.0.0');
    const root = packageRoot(prefix);
    runningService();
    setHealthBody({ ok: true, version: '0.0.1-old', herdr: true, hook: 'ok', sdk: 'ok' });
    const run = await runSetup({ answer: planOnly, deps: { mode: 'package', installRoot: root, ...sdkStub } });
    const absolute = installationCli({ node: process.execPath, bin: path.join(root, 'bin', 'rarog.mjs') });
    const fixes = run.stdout.split('\n').filter((line) => /^\s*Fix: /u.test(line));
    expect(fixes).toContain(`  Fix: ${absolute} restart`);
    for (const line of fixes) expect(line).not.toMatch(/(^|[\s(;,])rarog [a-z]/u);
  });

  it('--verbose: the check as detail lines after the Summary block, no step line and no Done line', async () => {
    runningService();
    const run = await runSetup({ answer: noSdk });
    expect(run.stdout).toMatch(new RegExp(`\\n\\n {2}/health 127\\.0\\.0\\.1:${String(port)}: version ${VERSION.replace(/\./gu, '\\.')},`
      + ' herdr true, hook ok, sdk ok\\ncheck: hook · SDK · herdr ok\\n', 'u'));
    expect(run.stdout).not.toMatch(/Done in|✓ Check|\[12\/12\]/u);
  });
});

describe('the closing Done line', () => {
  it('exit code 0 and ! lines: their number; otherwise Done alone', () => {
    expect(doneLine(4, { exitZero: true, warnings: 0 })).toBe('Done in 4 s.');
    expect(doneLine(4, { exitZero: true, warnings: 1 })).toBe('Done in 4 s; 1 step above needs a fix.');
    expect(doneLine(12, { exitZero: true, warnings: 2 })).toBe('Done in 12 s; 2 steps above need a fix.');
    expect(doneLine(4, { exitZero: false, warnings: 2 })).toBe('Done in 4 s.');
  });
});

describe('checkServer: a server on another version', () => {
  /** The check of a running service on the harness port, with a short ceiling. */
  const options = (extra: Partial<CheckOptions> = {}): CheckOptions => ({
    service: 'running', port, packageVersion: VERSION,
    commands: { restart: 'rarog restart', doctor: 'rarog doctor', afterUpdate: 'rarog restart' },
    timeoutMs: 2_000, pollMs: 50, detail: () => {}, ...extra,
  });

  it('without requireVersion (rarog setup): a warning with the afterUpdate command; with it: a failure with its command',
    async () => {
      setHealthBody({ ok: true, version: '0.0.1-old', herdr: true, hook: 'ok', sdk: 'ok' });
      expect(await checkServer(options())).toEqual({
        status: 'warn', result: 'server runs 0.0.1-old', fix: 'rarog restart', answered: true,
      });
      // Under pnpm the afterUpdate command installs the service again (rarog restart refuses there).
      const pnpm = { restart: 'rarog restart', doctor: 'rarog doctor', afterUpdate: 'rarog service install' };
      expect(await checkServer(options({ commands: pnpm }))).toMatchObject({ fix: 'rarog service install' });
      const fix = 'rarog service install';
      expect(await checkServer(options({ requireVersion: { fix } }))).toEqual({
        status: 'fail', result: 'server runs 0.0.1-old', fix, answered: true,
      });
    });

  it('herdr: false at the ceiling: start herdr, then doctor; the server reconnects without a restart', async () => {
    setHealthBody({ ok: false, version: VERSION, herdr: false, hook: 'ok', sdk: 'ok' });
    expect(await checkServer(options({ timeoutMs: 200 }))).toEqual({
      status: 'fail', result: 'herdr: false after 0 s', fix: 'start herdr, then rarog doctor', answered: true,
    });
  });

  it('requireVersion and this version: the fields judged as without it', async () => {
    setHealthBody({ ok: true, version: VERSION, herdr: true, hook: 'ok', sdk: 'ok' });
    expect(await checkServer(options({ requireVersion: { fix: 'x' } })))
      .toEqual({ status: 'ok', result: 'hook · SDK · herdr ok', answered: true });
  });
});

describe('the absolute command of an installation', () => {
  const target = { node: '/n/node', bin: "/p/it's/bin/rarog.mjs" };

  it('every rarog command of a sentence, nothing else', () => {
    expect(installationCli(target)).toBe("'/n/node' '/p/it'\\''s/bin/rarog.mjs'");
    expect(withInstallationCli('check the network, then rarog setup', target))
      .toBe(`check the network, then ${installationCli(target)} setup`);
    expect(withInstallationCli('rarog service install', target)).toBe(`${installationCli(target)} service install`);
    expect(withInstallationCli('install herdr (default ~/.local/bin/herdr); ai.rarog.server', target))
      .toBe('install herdr (default ~/.local/bin/herdr); ai.rarog.server');
  });

  it('a Fix: wider than the screen: every absolute command alone on a line, the sentence around it wrapped', () => {
    const cli = installationCli(target);
    const lines = (text: string, width = 60): string[] => fixLines(withInstallationCli(text, target), cli, width);
    expect(lines('rarog restart')).toEqual(['', `${cli} restart`]);
    expect(lines('start herdr, then rarog restart')).toEqual(['start herdr, then', `${cli} restart`]);
    expect(lines('rarog hooks doctor, then rarog hooks install'))
      .toEqual(['', `${cli} hooks doctor`, 'then', `${cli} hooks install`]);
    expect(lines("check the network, then rarog setup --data-dir '/d, e'"))
      .toEqual(['check the network, then', `${cli} setup --data-dir '/d, e'`]);
    expect(lines('install herdr (default ~/.local/bin/herdr); then rarog setup'))
      .toEqual(['install herdr (default ~/.local/bin/herdr); then', `${cli} setup`]);
    expect(lines('fix ~/.claude/settings.json by hand (see the docs section on the settings file), then rarog setup'))
      .toEqual(['fix ~/.claude/settings.json by hand (see the docs', 'section on the settings file), then', `${cli} setup`]);
    // A sentence without the command: wrapped, nothing else.
    expect(lines('start herdr in a terminal and wait until it answers on its socket', 40))
      .toEqual(['start herdr in a terminal and', 'wait until it answers on its socket']);
  });

  it('version managers: nvm in ~/.config/nvm and ~/.nvm, fnm, volta; other directories not', () => {
    expect(underVersionManager('/h/.config/nvm/versions/node/v22.22.3/bin', '/h')).toBe(true);
    expect(underVersionManager('/h/.nvm/versions/node/v22.22.3/bin', '/h')).toBe(true);
    expect(underVersionManager('/h/.local/share/fnm/node-versions/v22/installation/bin', '/h')).toBe(true);
    expect(underVersionManager('/h/.volta/tools/image/node/22.0.0/bin', '/h')).toBe(true);
    expect(underVersionManager('/opt/homebrew/bin', '/h')).toBe(false);
    expect(underVersionManager('/h/.nvmx/bin', '/h')).toBe(false);
  });

  it('new terminal target: npm under nvm even when in PATH, outside PATH, in PATH; a clone never', () => {
    const nvm = '/h/.config/nvm/versions/node/v22/lib/node_modules/@rarog/server';
    const plain = '/usr/local/lib/node_modules/@rarog/server';
    const of = (root: string, PATH: string, mode: 'package' | 'clone' = 'package'): string | null => {
      const found = newTerminalTarget({ mode, root, home: '/h', env: { PATH }, node: '/n/node' });
      return found === null ? null : found.bin;
    };
    expect(of(nvm, '/h/.config/nvm/versions/node/v22/bin:/usr/bin')).toBe(`${nvm}/bin/rarog.mjs`);
    expect(of(plain, '/usr/bin:/bin')).toBe(`${plain}/bin/rarog.mjs`);
    expect(of(plain, '/usr/bin:/usr/local/bin/:/bin')).toBeNull();
    expect(of(nvm, '/usr/bin', 'clone')).toBeNull();
  });
});
