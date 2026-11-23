/**
 * `rarog update --finish` (`server/src/cli/update.ts`) over an installed npm package: the Claude SDK it pins without
 * a question, the hook copy and the Rarog settings entries with their questions only when they change (the hook copy
 * without its question when the update lock names this installation as just installed), the service
 * repointed when the update lock names this installation, `rarog restart` into the run log, and the closing `Check`
 * that waits for `hook: ok`. `config.json` stays byte for byte and nothing asks about directories. Refusals: a second
 * live update, a bad lock token, no terminal, a service of another installation without the lock's marker, the repo
 * clone. npm, `launchctl`, `systemctl` and `rarog restart` are fakes; `/health` is the harness server on its own port.
 * The `--data-dir` tests run the real `rarog restart` and `rarog service install` with a fake `restart.sh` instead.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliIo, CliTerminal } from '../src/cli/io.ts';
import { restartCommand } from '../src/cli/restart.ts';
import { HERDR_AGENT_LABEL, herdrAgentPlistPath } from '../src/cli/setup-herdr-agent.ts';
import { configFileText } from '../src/cli/serve.ts';
import { renderServicePlist, serviceInstallIfAbsent } from '../src/cli/service.ts';
import { renderServiceUnit, unitFilePath } from '../src/cli/systemd-unit.ts';
import { UPDATE_LOCK_FILENAME, UPDATE_LOCK_TOKEN, updateLockBody } from '../src/cli/update-lock.ts';
import { updateCommand } from '../src/cli/update.ts';
import type { UpdateDeps } from '../src/cli/update.ts';
import {
  HOOK_INSTALL_FILES, HOOK_MANIFEST_FILENAME, STATUSLINE_INSTALL_FILES, contextHookCommand, denyReadBlock, hookCommand,
  hookInstallDir, pasteHookBlock, statuslineCommand, userSettingsPath, writeBlockRules,
} from '../src/herdr/hook-config.ts';
import { installationCli } from '../src/install/repair.ts';
import { serviceTarget } from '../src/install/service-target.ts';
import { installSdk, readSdkPin, sdkVersionDir } from '../src/install/sdk.ts';
import { readPackageVersion } from '../src/version.ts';
import {
  CHECK_TIMEOUT_MS, REPO, bin, calls, changedEntries, configDir, configFile, copyHooks, dataDirOf, env, home, logs,
  markLoaded, plist, port, questionOf, removeHerdrAgent, setHealthBody, state, t, treeHash, useSetupHarness, write,
  writeBlockOf, writeConfig, writeSettings,
} from './helpers/setup-harness.ts';
import type { Question } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';
import { fake, linuxSandbox } from './systemd-atrapy.ts';
import type { LinuxSandbox } from './systemd-atrapy.ts';

useSetupHarness();

const TTY_60: CliTerminal = { tty: true, columns: 60, color: false };
const VERSION = readPackageVersion();
const SDK_VERSION = readSdkPin().version;
const TOKEN = 'abababababababababababababababab';
const HEALTHY = { ok: true, version: VERSION, uptime: 1, herdr: true, term: true, hook: 'ok', authStore: 'ok', sdk: 'ok' };

/** The screen as a person sees it: escape sequences removed, every redraw (`\r`) keeps only what comes after it. */
function visible(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '').split('\n').map((line) => line.split('\r').at(-1) ?? '')
    .join('\n');
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

/** Another installation: its own `bin/rarog.mjs` and `package.json` (not this repository). */
function otherRoot(): string {
  const root = path.join(t.home, 'old', 'lib', 'node_modules', 'rarog');
  write(path.join(root, 'bin', 'rarog.mjs'), '// another installation\n');
  write(path.join(root, 'package.json'), '{"name":"rarog","version":"0.9.0"}\n');
  return root;
}

/** A repo clone next to the package: its own `bin/rarog.mjs` and an older `package.json`. */
function cloneRoot(): string {
  const root = path.join(t.home, 'clone');
  write(path.join(root, 'bin', 'rarog.mjs'), '// the repo clone\n');
  write(path.join(root, 'package.json'), '{"name":"rarog","version":"0.1.0"}\n');
  return root;
}

/** The environment of a finish started by an update run: the lock token, the package prefix in `PATH`. */
const lockEnv = (): NodeJS.ProcessEnv => env(home, {
  PATH: `${bin}:${path.join(t.home, 'prefix', 'bin')}:/usr/bin:/bin`, [UPDATE_LOCK_TOKEN]: TOKEN,
});

/** Fake `npm-cli.js`: `npm ci` leaves only the SDK package in its working directory and logs the call. */
function fakeNpm(): string {
  const dir = path.join(t.home, 'npm-ok');
  const file = path.join(dir, 'npm-cli.js');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))}, process.argv.slice(2).join(' ') + '\\n');`,
    "fs.mkdirSync('node_modules/@anthropic-ai/claude-agent-sdk', { recursive: true });",
    "fs.writeFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', '{}');",
    '',
  ].join('\n'));
  return file;
}

const npmCalls = (): string[] => {
  const file = path.join(t.home, 'npm-ok', 'calls');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
};

const okProbe = (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true });

/** The pinned SDK already in `dataDir` (downloaded by the fake npm as the product does). */
async function sdkPresent(dataDir = dataDirOf()): Promise<void> {
  const done = await installSdk({ dataDir, env: env(), npmCli: fakeNpm(), probe: okProbe });
  expect(done.ok).toBe(true);
}

/** The service file of this platform pointing at `root`, with its log in `dataDir`. */
function servicePlist(root: string, dataDir = dataDirOf(), h = home): void {
  write(plist(h), renderServicePlist({
    programArguments: [process.execPath, path.join(root, 'bin', 'rarog.mjs'), 'serve'],
    workingDirectory: h, log: path.join(dataDir, 'server.log'),
  }));
}

/** `config.json` with two project roots (a narrowed work area), in its canonical text. */
function twoRootsConfig(h = home): string {
  const text = configFileText({ version: 1, env: {
    RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port),
    RAROG_PROJECT_ROOTS: `${path.join(h, 'Projects')},${path.join(h, 'Work')}`,
    RAROG_HERDR_ROOTS: path.join(h, 'Projects'),
  } });
  write(configFile(h), text, 0o600);
  return text;
}

/** A machine where this version is fully installed: config, hook and script copy, settings, SDK and the service. */
async function installed(root: string): Promise<string> {
  const config = twoRootsConfig();
  copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
  writeSettings(statuslineCommand(home), home, { denyRead: true });
  await sdkPresent();
  servicePlist(root);
  markLoaded();
  return config;
}

/** The write block rules of `dataDir` as setup writes them. */
function blockFor(dataDir: string, h = home): { readonly permissions: { readonly deny: readonly string[] } } {
  const block = writeBlockRules(dataDir, h);
  if (!block.ok) throw new Error(block.reason);
  return { permissions: { deny: block.rules } };
}

/** Settings with every Rarog entry, the `denyRead` paths and the write block of `dataDir` among them. */
function settingsFor(dataDir: string): void {
  write(userSettingsPath(home), JSON.stringify({
    ...pasteHookBlock(hookCommand(home), contextHookCommand(home)) as object,
    statusLine: { type: 'command', command: statuslineCommand(home) },
    ...denyReadBlock(dataDir) as object,
    ...blockFor(dataDir),
  }, null, 2));
}

/**
 * `restart.sh` replaced by a fake `bash` in `dir` (found through the `PATH` of `rarog restart`): it logs its launchd
 * label or systemd unit, port and log to `restart-sh` in `logDir` and succeeds; any other script runs in `/bin/bash`.
 */
function fakeRestartScript(dir = bin, logDir = logs): void {
  fake(path.join(dir, 'bash'), [
    `printf '%s\\n' "$*" >> '${logDir}/bash'`,
    'case "$1" in',
    '  */restart.sh)',
    `    printf '%s %s %s\\n' "$RAROG_RESTART_LABEL$RAROG_RESTART_UNIT" "$RAROG_RESTART_PORT" "$RAROG_LOG" \\`,
    `      >> '${logDir}/restart-sh'`,
    '    echo "restart.sh fake"; exit 0 ;;',
    'esac',
    'exec /bin/bash "$@"',
  ]);
}

/** The statusLine script file of the copy. */
const SCRIPT = STATUSLINE_INSTALL_FILES[0];

/**
 * The script copy of the previous version: other bytes, which its manifest entry names (so not changed after the
 * install); the hook files stay as they are. Returns the old bytes.
 */
function previousStatuslineCopy(): Buffer {
  const dir = hookInstallDir(home);
  const old = Buffer.from('// statusLine script of the previous version\n');
  writeFileSync(path.join(dir, SCRIPT), old);
  const manifestFile = path.join(dir, HOOK_MANIFEST_FILENAME);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { files: Record<string, string> };
  manifest.files[SCRIPT] = createHash('sha256').update(old).digest('hex');
  writeFileSync(manifestFile, JSON.stringify(manifest));
  return old;
}

interface UpdateRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The screen: stdout and stderr in the order written, as the terminal shows them. */
  readonly screen: string;
  readonly asked: Question[];
  /** Calls of the fakes and the questions, in order (`service install`, `restart`, `sdk download`, `ask:<kind>`). */
  readonly order: string[];
}

interface UpdateOptions {
  readonly root: string;
  /** `null` = no terminal (no `ask`). */
  readonly answer?: ((question: Question) => string) | null;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly deps?: Partial<UpdateDeps>;
  /** `rarog service install` of the fake: what it does after its precheck (default: nothing). */
  readonly onServiceInstall?: () => void;
  /** The real `rarog restart` instead of the fake (its `restart.sh` is {@link fakeRestartScript}). */
  readonly realRestart?: boolean;
}

/** `rarog update --finish` in the test process on a 60-column terminal; the answer to every question is "y". */
async function runUpdate(options: UpdateOptions): Promise<UpdateRun> {
  let stdout = '';
  let stderr = '';
  let screen = '';
  const asked: Question[] = [];
  const order: string[] = [];
  const answer = options.answer === undefined ? (): string => 'y' : options.answer;
  const io: CliIo = {
    stdout: (text) => { stdout += text; screen += text; },
    stderr: (text) => { stderr += text; screen += text; },
    env: options.env ?? env(home, { PATH: `${bin}:${path.join(t.home, 'prefix', 'bin')}:/usr/bin:/bin` }),
    cwd: t.home,
    terminal: TTY_60,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(answer === null ? {} : {
      ask: (prompt: string) => {
        const question = questionOf(prompt);
        asked.push(question);
        order.push(`ask:${question}`);
        const given = answer(question);
        // The terminal echoes the answer and the line end.
        stdout += `${prompt}${given}\n`;
        screen += `${prompt}${given}\n`;
        return Promise.resolve(given);
      },
    }),
  };
  const deps: UpdateDeps = {
    mode: 'package', installRoot: options.root,
    serviceInstall: (_io, precheck) => {
      order.push('service install');
      const reason = precheck();
      if (reason !== null) return Promise.resolve(1);
      options.onServiceInstall?.();
      return Promise.resolve(0);
    },
    ...(options.realRestart === true ? {} : {
      restart: (_io: CliIo, output: (text: string) => void) => {
        order.push('restart');
        for (const n of [1, 2, 3]) output(`restart-fake line ${String(n)}`);
        return Promise.resolve(0);
      },
    }),
    sdkInstall: (sdk) => {
      order.push('sdk download');
      return installSdk({ ...sdk, npmCli: fakeNpm() });
    },
    sdkProbe: okProbe,
    checkPort: port,
    checkTimeoutMs: CHECK_TIMEOUT_MS,
    ...options.deps,
  };
  const code = await updateCommand(['update', '--finish', ...(options.argv ?? [])], io, deps);
  return { code, stdout, stderr, screen: visible(screen), asked, order };
}

/** The run logs of `rarog update` in `dataDir`, with their text. */
function updateLogs(dataDir = dataDirOf()): string[] {
  const dir = path.join(dataDir, 'logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith('update-')).sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8'));
}

/** The screen's lines (the last empty one after the final line end dropped). */
const lines = (screen: string): string[] => screen.replace(/\n$/u, '').split('\n');

/** The step lines of the screen: ` <mark> <title>`, with their result (not the new terminal line after Check). */
const stepLines = (screen: string): string[] => lines(screen)
  .filter((line) => /^ [✓✗!–] \S/u.test(line) && !line.includes('In a new terminal'));

/**
 * A step that ended `ok` without a change has no line of its own on the screen, only the one line before
 * Check; the run log keeps its plain line `[n/N] ok      <title>: <result>`.
 */
const loggedOk = (title: string, result: string, dataDir?: string): string =>
  (updateLogs(dataDir).join('').match(new RegExp(`\\] ok {6}${title}: ${result}`, 'u')) ?? [''])[0];

/** A lock held by another live process (the test runner's parent) with this body. */
function lockHeldByParent(body: string, h = home): string {
  const file = path.join(configDir(h), UPDATE_LOCK_FILENAME);
  write(file, `${String(process.ppid)}\n${body}`, 0o600);
  return file;
}

describe.skipIf(!IS_MAC)(macOnly('rarog update --finish on macOS', 'launchd and plutil'), () => {
  const pkg = (): string => packageRoot(path.join(t.home, 'prefix'));

  it('nothing to do: no question, the restart in the log only, at most 6 lines at 60 columns, code 0', async () => {
    const root = pkg();
    const config = await installed(root);
    const settings = readFileSync(userSettingsPath(home), 'utf8');
    const downloads = npmCalls().length;
    const run = await runUpdate({ root });
    expect(run.code, run.screen).toBe(0);
    expect(run.asked).toEqual([]);
    expect(run.order).toEqual(['restart']);
    expect(npmCalls()).toHaveLength(downloads);
    // The three steps without a change have no line; the restart is a change, so no summary line either.
    expect(stepLines(run.screen)).toEqual([
      ' ✓ Restart        server restarted',
      ' ✓ Check          hook · SDK · herdr ok',
    ]);
    expect(run.screen).not.toContain('nothing changed');
    expect(loggedOk('Claude SDK', '\\S+')).not.toBe('');
    expect(loggedOk('Hook copy', 'matches the source')).not.toBe('');
    expect(loggedOk('Settings', 'entries match')).not.toBe('');
    expect(lines(run.screen)[0]).toBe(`Rarog update ${VERSION}`);
    // The screen budget: at most 6 lines of at most 60 columns.
    expect(lines(run.screen).length, run.screen).toBeLessThanOrEqual(6);
    for (const line of lines(run.screen)) expect([...line].length, line).toBeLessThanOrEqual(60);
    expect(run.screen).not.toContain('restart-fake');
    const [log] = updateLogs();
    expect(log).toContain('restart-fake line 3');
    expect(readFileSync(configFile(), 'utf8')).toBe(config);
    expect(readFileSync(userSettingsPath(home), 'utf8')).toBe(settings);
    expect(existsSync(path.join(configDir(), UPDATE_LOCK_FILENAME))).toBe(false);
  });

  it('no herdr agent and herdr not running: the finish has no herdr step, so no plist, no bootstrap, no question',
    async () => {
      const root = pkg();
      await installed(root);
      removeHerdrAgent();
      const run = await runUpdate({ root });
      expect(run.code, run.screen).toBe(0);
      expect(run.asked).toEqual([]);
      expect(existsSync(herdrAgentPlistPath(home))).toBe(false);
      expect(calls('launchctl').filter((one) => one.includes(HERDR_AGENT_LABEL) && !one.startsWith('print ')))
        .toEqual([]);
      expect(run.screen).not.toContain('herdr agent');
    });

  it('a new pinned SDK: downloaded without a question; entries unchanged: no question either', async () => {
    const root = pkg();
    twoRootsConfig();
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
    writeSettings(statuslineCommand(home), home, { denyRead: true });
    servicePlist(root);
    markLoaded();
    const run = await runUpdate({ root });
    expect(run.code, run.screen).toBe(0);
    expect(run.asked).toEqual([]);
    expect(run.order).toEqual(['sdk download', 'restart']);
    expect(existsSync(path.join(sdkVersionDir(dataDirOf(), SDK_VERSION), 'node_modules'))).toBe(true);
    expect(loggedOk('Claude SDK', '\\S+ downloaded')).not.toBe('');
  });

  it('a new required settings entry: one [y/N/d] question, the entry written after "y"', async () => {
    const root = pkg();
    await installed(root);
    writeSettings(statuslineCommand(home), home);
    const run = await runUpdate({ root });
    expect(run.code, run.screen).toBe(0);
    expect(run.asked).toEqual(['settings']);
    expect(readFileSync(userSettingsPath(home), 'utf8')).toContain('denyRead');
    expect(loggedOk('Settings', '\\S')).not.toBe('');
  });

  it('every other entry in place, no write block: one question for the block alone, the rest byte for byte', async () => {
    const root = pkg();
    await installed(root);
    writeSettings(statuslineCommand(home), home, { denyRead: true, writeBlock: false });
    const before = JSON.parse(readFileSync(userSettingsPath(home), 'utf8')) as object;
    const run = await runUpdate({ root });
    expect(run.code, run.screen).toBe(0);
    expect(run.asked).toEqual(['settings']);
    // One entry, not the count of every Rarog entry: the question names only what is missing.
    expect(run.screen.replace(/\s+/gu, ' ')).toContain('Add a Rarog entry to ~/.claude/settings.json?');
    expect(JSON.parse(readFileSync(userSettingsPath(home), 'utf8'))).toEqual({ ...before, ...writeBlockOf() });
  });

  it('screen (b): a new SDK and one new settings entry, at 60 columns', async () => {
    const root = pkg();
    twoRootsConfig();
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
    writeSettings(statuslineCommand(home), home);
    servicePlist(root);
    markLoaded();
    const run = await runUpdate({ root });
    expect(run.code, run.screen).toBe(0);
    expect(run.asked).toEqual(['settings']);
    expect(run.order).toEqual(['sdk download', 'ask:settings', 'restart']);
    for (const line of lines(run.screen)) expect([...line].length, line).toBeLessThanOrEqual(60);
  });

  it('config.json with two roots: byte for byte, no question about directories', async () => {
    const root = pkg();
    const config = await installed(root);
    const before = treeHash(configDir());
    const run = await runUpdate({ root });
    expect(run.code, run.screen).toBe(0);
    expect(run.asked).toEqual([]);
    expect(readFileSync(configFile(), 'utf8')).toBe(config);
    expect(treeHash(configDir())).toEqual(before);
    expect(run.screen).not.toMatch(/folder|director|root|work area/iu);
  });

  it('Tailscale only (RAROG_IROH=0 with the relay): no transport question, config.json byte for byte, no iroh key',
    async () => {
      const root = pkg();
      await installed(root);
      const text = configFileText({ version: 1, env: {
        RAROG_ORIGINS: 'https://rarog-test.example.ts.net:8931', RAROG_PORT: String(port), RAROG_IROH: '0',
        RAROG_IROH_RELAY: 'https://relay.rarog.ai/',
      } });
      write(configFile(), text, 0o600);
      const before = treeHash(configDir());
      const run = await runUpdate({ root });
      expect(run.code, run.screen).toBe(0);
      expect(run.asked).toEqual([]);
      expect(readFileSync(configFile(), 'utf8')).toBe(text);
      expect(treeHash(configDir())).toEqual(before);
      expect(existsSync(path.join(configDir(), 'secret'))).toBe(false);
    });

  it('pnpm: the lock names a new store path as installed.root, the service moves first, then the hook copy', async () => {
    const old = otherRoot();
    const root = packageRoot(path.join(t.home, 'pnpm', 'store', 'rarog@2.0.0'));
    twoRootsConfig();
    writeSettings(statuslineCommand(home), home, { denyRead: true });
    await sdkPresent();
    servicePlist(old);
    markLoaded();
    const lock = lockHeldByParent(updateLockBody({ token: TOKEN, installed: { version: VERSION, root } }));
    const run = await runUpdate({
      root, env: env(home, { [UPDATE_LOCK_TOKEN]: TOKEN }),
      // `rarog service install` of this installation rewrites the service file to start it.
      onServiceInstall: () => { servicePlist(root); },
    });
    expect(run.code, run.screen).toBe(0);
    // The hook copy is written only after the service points here, and without its question: the lock names this
    // installation as just installed. No question about switching the service either.
    expect(run.order).toEqual(['service install']);
    expect(existsSync(path.join(hookInstallDir(home), HOOK_INSTALL_FILES[0] ?? ''))).toBe(true);
    expect(stepLines(run.screen)).toContain(' ✓ Service        moved to this installation');
    expect(stepLines(run.screen).at(-1)).toBe(' ✓ Check          hook · SDK · herdr ok');
    expect(loggedOk('Hook copy', '\\S')).not.toBe('');
    expect(loggedOk('Settings', 'entries match')).not.toBe('');
    // An inherited lock: no header of its own, the lock stays for its owner.
    expect(lines(run.screen)[0]).not.toMatch(/^Rarog update/u);
    expect(readFileSync(lock, 'utf8')).toContain(`token=${TOKEN}`);
  });

  it('the service starts another npm package of this prefix (rarog next to @rarog/server), the lock names this'
    + ' installation: the service moves here, code 0', async () => {
    const root = pkg();
    const old = path.join(t.home, 'prefix', 'lib', 'node_modules', 'rarog');
    write(path.join(old, 'bin', 'rarog.mjs'), '// the package rarog\n');
    write(path.join(old, 'package.json'), '{"name":"rarog","version":"0.9.0"}\n');
    await installed(root);
    servicePlist(old);
    markLoaded();
    lockHeldByParent(updateLockBody({ token: TOKEN, installed: { version: VERSION, root } }));
    const run = await runUpdate({
      root, env: lockEnv(), onServiceInstall: () => { servicePlist(root); markLoaded(); },
    });
    expect(run.code, run.screen).toBe(0);
    expect(run.order).toEqual(['service install']);
    expect(stepLines(run.screen)).toEqual([
      ' ✓ Service        moved to this installation',
      ' ✓ Check          hook · SDK · herdr ok',
    ]);
  });

  it('the plist names this installation, the loaded service still the clone: service install, not restart, code 0',
    async () => {
      // An interrupted rarog service install: the new plist is on disk, launchd still has the clone's definition, and a
      // restart (kickstart) would start the clone.
      const root = pkg();
      const clone = cloneRoot();
      await installed(root);
      markLoaded([process.execPath, path.join(clone, 'bin', 'rarog.mjs'), 'serve']);
      lockHeldByParent(updateLockBody({ token: TOKEN, installed: { version: VERSION, root } }));
      const run = await runUpdate({ root, env: lockEnv(), onServiceInstall: () => { markLoaded(); } });
      expect(run.code, run.screen).toBe(0);
      expect(run.order).toEqual(['service install']);
      expect(stepLines(run.screen)).toEqual([
        ' ✓ Service        moved to this installation',
        ' ✓ Check          hook · SDK · herdr ok',
      ]);
      expect(updateLogs().join('')).toContain('the service launchd has loaded (ai.rarog.server) points to another'
        + ` installation (${path.join(clone, 'bin', 'rarog.mjs')}, version 0.1.0)`);
    });

  it('the loaded service starts this installation with another node: service install, not restart, code 0', async () => {
    const root = pkg();
    const node = path.join(t.home, 'node-b', 'bin', 'node');
    write(node, '#!/bin/sh\n', 0o755);
    await installed(root);
    markLoaded([node, path.join(root, 'bin', 'rarog.mjs'), 'serve']);
    lockHeldByParent(updateLockBody({ token: TOKEN, installed: { version: VERSION, root } }));
    const run = await runUpdate({ root, env: lockEnv(), onServiceInstall: () => { markLoaded(); } });
    expect(run.code, run.screen).toBe(0);
    expect(run.order).toEqual(['service install']);
    expect(stepLines(run.screen)).toContain(' ✓ Service        moved to this installation');
    expect(updateLogs().join('')).toContain(`the service launchd has loaded (ai.rarog.server) starts with node ${node}`);
  });

  it('the plist is there and launchd has nothing loaded: the run that installed loads it through service install',
    async () => {
      const root = pkg();
      twoRootsConfig();
      copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
      writeSettings(statuslineCommand(home), home, { denyRead: true });
      await sdkPresent();
      servicePlist(root);
      lockHeldByParent(updateLockBody({ token: TOKEN, installed: { version: VERSION, root } }));
      const run = await runUpdate({ root, env: lockEnv(), onServiceInstall: () => { markLoaded(); } });
      expect(run.code, run.screen).toBe(0);
      expect(run.order).toEqual(['service install']);
      expect(stepLines(run.screen)).toContain(' ✓ Service        loaded for this installation');
      expect(stepLines(run.screen).at(-1)).toBe(' ✓ Check          hook · SDK · herdr ok');
      expect(updateLogs().join('')).toContain(`the service file ${plist()} is there, but launchd has no ai.rarog.server`
        + ' loaded');
    });

  it('the loaded service starts the clone, no lock naming this installation: refused before any change, code 1',
    async () => {
      const root = pkg();
      await installed(root);
      markLoaded([process.execPath, path.join(cloneRoot(), 'bin', 'rarog.mjs'), 'serve']);
      const before = treeHash(home);
      const run = await runUpdate({ root });
      expect(run.code, run.screen).toBe(1);
      expect(run.order).toEqual([]);
      expect(run.asked).toEqual([]);
      expect(run.screen).toContain(' ✗ Service        starts another installation; nothing was');
      expect(run.screen).toMatch(/^ {3}Fix: rarog service install$/mu);
      const logs = path.join('.local', 'share', 'rarog', 'logs');
      const changed = changedEntries(before, treeHash(home))
        .filter((key) => !logs.startsWith(key) && !key.startsWith(`${logs}${path.sep}`))
        .filter((key) => key !== path.join('.config', 'rarog'));
      expect(changed).toEqual([]);
    });

  it('/health answers an older version after the restart: ✗ Check with rarog service install, code 1', async () => {
    const root = pkg();
    await installed(root);
    setHealthBody({ ...HEALTHY, version: '0.0.1-old' });
    const run = await runUpdate({ root });
    expect(run.code, run.screen).toBe(1);
    expect(run.order).toEqual(['restart']);
    const end = run.screen.slice(run.screen.indexOf(' ✗ Check'));
    expect(end).toMatch(/^ ✗ Check {10}server runs 0\.0\.1-old\n {3}Fix: rarog service install\n/u);
  });

  it('launchctl print does not tell what is loaded: refused before any step, nothing changed, code 1', async () => {
    const root = pkg();
    await installed(root);
    writeFileSync(path.join(state, 'launchctl-odmowa'), '');
    const run = await runUpdate({ root });
    expect(run.code, run.screen).toBe(1);
    expect(run.order).toEqual([]);
    expect(stepLines(run.screen)).toEqual([' ✗ Service        state undetermined; nothing was changed']);
    expect(run.screen).toContain('Fix: check launchctl print gui/');
    expect(updateLogs().join('')).toContain('exit status 1, Operation not permitted');
  });

  it('launchctl print does not tell what is loaded, with --data-dir: the fix runs the finish again with that directory', async () => {
    const root = pkg();
    await installed(root);
    const custom = path.join(home, 'data dir');
    mkdirSync(custom, { recursive: true });
    writeFileSync(path.join(state, 'launchctl-odmowa'), '');
    const run = await runUpdate({ root, argv: ['--data-dir', custom] });
    expect(run.code, run.screen).toBe(1);
    // The fix may wrap, a path breaking at "/": compare without the layout whitespace.
    const fix = run.screen.slice(run.screen.indexOf('Fix:')).replace(/\s+/gu, '');
    expect(fix, run.screen).toContain(`thenrarogupdate--finish--data-dir'${custom.replace(/\s+/gu, '')}'`);
  });

  it('--data-dir with the service log there: the real rarog restart takes it, restart.sh logs there, code 0', async () => {
    const root = pkg();
    const custom = path.join(home, 'data');
    twoRootsConfig();
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
    settingsFor(custom);
    await sdkPresent(custom);
    servicePlist(root, custom);
    markLoaded();
    fakeRestartScript();
    const run = await runUpdate({ root, argv: ['--data-dir', custom], realRestart: true });
    expect(run.code, `${run.screen}\n${updateLogs(custom).join('')}`).toBe(0);
    expect(stepLines(run.screen)).toContain(' ✓ Restart        server restarted');
    expect(calls('restart-sh')).toEqual([`ai.rarog.server ${String(port)} ${path.join(custom, 'server.log')}`]);
    expect(updateLogs(custom).join('')).toContain('restart.sh fake');
  });

  it('--data-dir, RAROG_IROH=1 with the key from service.wrapper: the check through the wrapper gets that directory', async () => {
    const root = pkg();
    const custom = path.join(home, 'data');
    // The secrets wrapper: logs its argv, supplies the iroh key and runs the rest after `--`.
    const wrapper = path.join(t.home, 'wrapper', 'export.sh');
    mkdirSync(path.dirname(wrapper), { recursive: true });
    fake(wrapper, [`printf '%s\\n' "$*" >> '${logs}/wrapper'`, `export RAROG_IROH_KEY='${'34'.repeat(32)}'`, 'shift',
      'exec "$@"']);
    writeConfig({
      RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port), RAROG_IROH: '1',
      RAROG_IROH_RELAY: 'https://relay.example./',
    }, [wrapper, '--']);
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
    settingsFor(custom);
    await sdkPresent(custom);
    servicePlist(root, custom);
    markLoaded();
    fakeRestartScript();
    const run = await runUpdate({ root, argv: ['--data-dir', custom], realRestart: true });
    expect(run.code, `${run.screen}\n${updateLogs(custom).join('')}`).toBe(0);
    const target = serviceTarget();
    expect(calls('wrapper')).toEqual([`-- ${target.node} ${target.bin} serve --check --data-dir ${custom}`]);
    expect(calls('restart-sh')).toEqual([`ai.rarog.server ${String(port)} ${path.join(custom, 'server.log')}`]);
  });

  it('rarog restart with a verified data directory: another service log directory and no service are refused', async () => {
    const root = pkg();
    const custom = path.join(home, 'data');
    twoRootsConfig();
    await sdkPresent(custom);
    servicePlist(root);
    markLoaded();
    fakeRestartScript();
    let stderr = '';
    const io: CliIo = { stdout: () => {}, stderr: (text) => { stderr += text; }, env: env(), cwd: t.home };
    const deps = {
      mode: 'package' as const, current: { node: process.execPath, bin: path.join(root, 'bin', 'rarog.mjs') },
      dataDir: custom,
    };
    expect(await restartCommand(['restart'], io, deps)).toBe(1);
    expect(stderr).toContain(`--data-dir ${custom} and the data directory of the installed service ${dataDirOf()}`
      + ' differ');
    // Without a loaded service the start goes through rarog serve without --data-dir: refused before restart.sh.
    writeFileSync(path.join(state, 'loaded'), '');
    stderr = '';
    expect(await restartCommand(['restart'], io, deps)).toBe(1);
    expect(stderr).toMatch(/^rarog restart: no launchd service is loaded/u);
    expect(calls('restart-sh')).toEqual([]);
  });

  it('pnpm with --data-dir: a moved service would leave that directory, so service install refuses, nothing stops', async () => {
    const old = otherRoot();
    const root = packageRoot(path.join(t.home, 'pnpm', 'store', 'rarog@2.0.0'));
    const custom = path.join(home, 'data');
    twoRootsConfig();
    settingsFor(custom);
    await sdkPresent(custom);
    servicePlist(old, custom);
    markLoaded();
    fakeRestartScript();
    const service = readFileSync(plist(), 'utf8');
    lockHeldByParent(updateLockBody({ token: TOKEN, installed: { version: VERSION, root } }));
    const run = await runUpdate({
      root, argv: ['--data-dir', custom], env: env(home, { [UPDATE_LOCK_TOKEN]: TOKEN }),
      deps: {
        // The real `rarog service install` (bootout waits 50 ms at most), with what update.ts hands it.
        serviceInstall: (io, precheck, output, dataDir) => serviceInstallIfAbsent(io, precheck,
          { timeoutMs: 50, stepMs: 10 }, { mode: 'package', installRoot: root, output, dataDir }),
      },
    });
    const log = updateLogs(custom).join('');
    expect(run.code, `${run.screen}\n${log}`).toBe(1);
    expect(stepLines(run.screen))
      .toContainEqual(expect.stringMatching(/^ ✗ Service {8}rarog service install failed \(code 1\)/u));
    expect(log).toContain(`the service would use the data directory ${dataDirOf()}, not ${custom} from --data-dir`);
    expect(calls('launchctl').filter((call) => !call.startsWith('print'))).toEqual([]);
    expect(readFileSync(plist(), 'utf8')).toBe(service);
    expect(calls('restart-sh')).toEqual([]);
    expect(existsSync(hookInstallDir(home))).toBe(false);
  });

  it('a new statusLine script only: its copy is updated after the diff and "y", code 0', async () => {
    const root = pkg();
    await installed(root);
    previousStatuslineCopy();
    const run = await runUpdate({ root });
    expect(run.code, run.screen).toBe(0);
    expect(run.asked).toEqual(['hook']);
    expect(readFileSync(path.join(hookInstallDir(home), SCRIPT)))
      .toEqual(readFileSync(path.join(REPO, 'scripts', 'hooks', SCRIPT)));
    // A write of this run has its own line, not the folded "checks ok, nothing changed".
    expect(stepLines(run.screen)).toContain(' ✓ Settings       status line script updated');
    expect(loggedOk('Settings', 'status line script updated')).not.toBe('');
  });

  it('a new statusLine script only, "n": the copy stays, ! Settings with its Fix:, code 1', async () => {
    const root = pkg();
    await installed(root);
    const old = previousStatuslineCopy();
    const run = await runUpdate({ root, answer: (question) => (question === 'hook' ? 'n' : 'y') });
    expect(run.code, run.screen).toBe(1);
    expect(run.asked).toEqual(['hook']);
    expect(readFileSync(path.join(hookInstallDir(home), SCRIPT))).toEqual(old);
    expect(run.screen).toMatch(/^ ! Settings {7}status line script out of date/mu);
    expect(run.screen).toMatch(/^ {3}Fix: .*hooks install/mu);
    expect(loggedOk('Hook copy', 'matches the source')).not.toBe('');
  });

  it('a new statusLine script whose install fails after the code files: ✗ Settings with its Fix:, code 1', async () => {
    const root = pkg();
    await installed(root);
    previousStatuslineCopy();
    // The installer writes the code files, then the manifest write fails: a directory stands under its name.
    const manifest = path.join(hookInstallDir(home), HOOK_MANIFEST_FILENAME);
    rmSync(manifest);
    write(path.join(manifest, 'keep'), '');
    // A failed restart is no change, so only the code files written by this run drop the "nothing changed" line.
    const run = await runUpdate({ root, deps: { restart: () => Promise.resolve(1) } });
    expect(run.code, run.screen).toBe(1);
    expect(run.asked).toEqual(['hook']);
    // The script copy now matches, so the settings check alone would pass.
    expect(readFileSync(path.join(hookInstallDir(home), SCRIPT)))
      .toEqual(readFileSync(path.join(REPO, 'scripts', 'hooks', SCRIPT)));
    expect(run.screen).toMatch(/^ ✗ Settings {7}entries match; hook copy: /mu);
    expect(run.screen).toMatch(/^ {3}Fix: .*hooks install/mu);
    // The code files this run wrote are a change: no "nothing changed" line under the ✗.
    expect(stepLines(run.screen)).not.toContain(' ✓ Settings       entries match');
    expect(run.screen).not.toContain('nothing changed');
  });

  it('a service of another installation without the lock marker: refused before any change, code 1', async () => {
    const old = otherRoot();
    const root = pkg();
    twoRootsConfig();
    writeSettings(statuslineCommand(home), home);
    servicePlist(old);
    markLoaded();
    const before = treeHash(home);
    const run = await runUpdate({ root });
    expect(run.code).toBe(1);
    expect(run.order).toEqual([]);
    expect(run.asked).toEqual([]);
    expect(run.screen).toContain(' ✗ Service        starts another installation; nothing was');
    expect(run.screen).toMatch(/^ {3}Fix: rarog service install$/mu);
    // Only the run log (and the directories over it) is new; the config directory's time moved with the update lock.
    const logs = path.join('.local', 'share', 'rarog', 'logs');
    const changed = changedEntries(before, treeHash(home))
      .filter((key) => !logs.startsWith(key) && !key.startsWith(`${logs}${path.sep}`))
      .filter((key) => key !== path.join('.config', 'rarog'));
    expect(changed).toEqual([]);
    expect(existsSync(hookInstallDir(home))).toBe(false);
  });

  it('a second live lock: one sentence on stderr, nothing written, code 1', async () => {
    const root = pkg();
    await installed(root);
    lockHeldByParent(`token=${TOKEN}\n`);
    const before = treeHash(home);
    const run = await runUpdate({ root });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(oneSentence(run.stderr)).toBe(`rarog update --finish: another update is running (PID`
      + ` ${String(process.ppid)}, lock ${path.join(configDir(), UPDATE_LOCK_FILENAME)}); wait until it ends.\n`);
    expect(treeHash(home)).toEqual(before);
    expect(run.order).toEqual([]);
  });

  it('a child process with the good token passes; with a bad token it is refused', async () => {
    const root = pkg();
    await installed(root);
    lockHeldByParent(`token=${TOKEN}\n`);
    const good = await runUpdate({ root, env: env(home, { [UPDATE_LOCK_TOKEN]: TOKEN }) });
    expect(good.code, good.screen).toBe(0);
    expect(good.order).toEqual(['restart']);
    const before = treeHash(home);
    const bad = await runUpdate({ root, env: env(home, { [UPDATE_LOCK_TOKEN]: 'f'.repeat(32) }) });
    expect(bad.code).toBe(1);
    const sentence = oneSentence(bad.stderr);
    expect(sentence).toMatch(/^rarog update --finish: RAROG_UPDATE_LOCK_TOKEN does not match the update lock \S+,/u);
    expect(sentence.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(treeHash(home)).toEqual(before);
  });

  it('restart fails: ✗ Restart with the one fix, Check waits for Restart (no Service step to point at), code 1', async () => {
    const root = pkg();
    await installed(root);
    const run = await runUpdate({ root, deps: { restart: () => Promise.resolve(1) } });
    expect(run.code).toBe(1);
    expect(stepLines(run.screen)).toContain(' – Check          waits for Restart');
    expect(run.screen).not.toContain('Service step');
    expect(run.screen.match(/Fix:/gu)).toHaveLength(1);
  });

  it('/health without hook: ok until the ceiling: ✗ Check, Fix: in the absolute form, code 1', async () => {
    const root = pkg();
    await installed(root);
    setHealthBody({ ...HEALTHY, hook: 'stale' });
    // The package's commands directory is not in PATH: a new terminal may not find `rarog`.
    const run = await runUpdate({ root, env: env() });
    expect(run.code).toBe(1);
    const absolute = installationCli({ node: process.execPath, bin: path.join(root, 'bin', 'rarog.mjs') });
    const end = run.screen.slice(run.screen.indexOf(' ✗ Check'));
    expect(end).toMatch(/^ ✗ Check {10}hook stale after 1 s/u);
    expect(end).toContain(`${absolute} hooks install`);
    // The Fix: line already carries the absolute form: no new terminal line.
    expect(end).not.toContain('In a new terminal');
  });

  it('/health with hook: stale that turns ok within the ceiling: the check waits for it', async () => {
    const root = pkg();
    await installed(root);
    setHealthBody({ ...HEALTHY, hook: 'stale' });
    const later = setTimeout(() => { setHealthBody(HEALTHY); }, 300);
    try {
      const run = await runUpdate({ root });
      expect(run.code, run.screen).toBe(0);
      expect(stepLines(run.screen).at(-1)).toBe(' ✓ Check          hook · SDK · herdr ok');
    } finally {
      clearTimeout(later);
    }
  });

  it('no terminal: refused, nothing changed, code 1', async () => {
    const root = pkg();
    await installed(root);
    const before = treeHash(home);
    const run = await runUpdate({ root, answer: null });
    expect(run.code).toBe(1);
    expect(oneSentence(run.stderr)).toBe('rarog update --finish: no terminal, so nothing was changed; run rarog'
      + ' update in a terminal.\n');
    expect(treeHash(home)).toEqual(before);
    expect(run.order).toEqual([]);
  });

  it('the repo clone: refused with the clone\'s commands, nothing changed', async () => {
    await installed(pkg());
    const before = treeHash(home);
    const run = await runUpdate({ root: REPO, deps: { mode: 'clone', installRoot: REPO } });
    expect(run.code).toBe(1);
    expect(oneSentence(run.stderr))
      .toMatch(/^rarog update --finish finishes an install of the npm package, and this is the repo/u);
    expect(run.stderr).toContain('pnpm install');
    expect(treeHash(home)).toEqual(before);
  });

  it('no config.json: refused with the setup command', async () => {
    const run = await runUpdate({ root: pkg() });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('run rarog setup first');
    expect(existsSync(configDir())).toBe(false);
  });

  it('an unknown argument: a usage error', async () => {
    const io: CliIo = { stdout: () => {}, stderr: () => {}, env: env(), cwd: t.home };
    await expect(updateCommand(['update', '--now'], io)).rejects.toThrow(/unknown argument "--now"/u);
  });
});


/**
 * A refusal on the 60-column terminal of these runs as one sentence: it wraps at the screen width (a path breaks
 * after a `/`), so the lines go back together; each of them fits 60 columns.
 */
function oneSentence(stderr: string): string {
  const lines = stderr.trimEnd().split('\n');
  for (const line of lines) expect([...line].length, line).toBeLessThanOrEqual(60);
  return `${lines.join(' ').replace(/\/ /gu, '/')}\n`;
}

describe('rarog update --finish on Linux (systemd --user fakes) with its own data directory', () => {
  let sb: LinuxSandbox | null = null;

  afterEach(() => {
    sb?.cleanup();
    sb = null;
  });

  /**
   * A Linux machine with this version installed in its own data directory `custom`: config, hook copy, settings,
   * SDK, and the unit starting `unitRoot` with its log in `custom`. Returns the config text.
   */
  async function linuxInstalled(box: LinuxSandbox, unitRoot: string, custom: string): Promise<string> {
    const h = box.homeDir;
    const config = twoRootsConfig(h);
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES], true, h);
    write(userSettingsPath(h), JSON.stringify({
      ...pasteHookBlock(hookCommand(h), contextHookCommand(h)) as object,
      statusLine: { type: 'command', command: statuslineCommand(h) },
      ...denyReadBlock(custom) as object,
      ...blockFor(custom, h),
    }, null, 2));
    await sdkPresent(custom);
    write(unitFilePath(h), renderServiceUnit({
      execStart: [process.execPath, path.join(unitRoot, 'bin', 'rarog.mjs'), 'serve'], workingDirectory: h,
      log: path.join(custom, 'server.log'),
    }));
    return config;
  }

  /** The child environment of the sandbox: fakes first, then the package prefix, then the system tools. */
  const linuxEnv = (box: LinuxSandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
    box.env({ PATH: `${box.bin}:${path.join(box.homeDir, 'prefix', 'bin')}:${box.systemPath}`, ...extra });

  it('the same steps: SDK, hook copy, settings, restart, check; the log in the data directory', async () => {
    sb = linuxSandbox('rul-');
    const h = sb.homeDir;
    const custom = path.join(h, 'data');
    const root = packageRoot(path.join(h, 'prefix'));
    const config = await linuxInstalled(sb, root, custom);
    const run = await runUpdate({ root, platform: 'linux', argv: ['--data-dir', custom], env: linuxEnv(sb) });
    expect(run.code, run.screen).toBe(0);
    expect(run.asked).toEqual([]);
    expect(run.order).toEqual(['restart']);
    expect(stepLines(run.screen)).toEqual([
      ' ✓ Restart        server restarted',
      ' ✓ Check          hook · SDK · herdr ok',
    ]);
    expect(loggedOk('Settings', 'entries match', custom)).not.toBe('');
    expect(updateLogs(custom).join('')).toContain('restart-fake line 1');
    expect(existsSync(path.join(h, '.local', 'share', 'rarog'))).toBe(false);
    expect(readFileSync(configFile(h), 'utf8')).toBe(config);
    expect(sb.calls('systemctl').some((call) => call.startsWith('--user show rarog.service'))).toBe(true);
    // No herdr step in the finish: no herdr.service although there is none and herdr does not run.
    expect(existsSync(path.join(h, '.config', 'systemd', 'user', 'herdr.service'))).toBe(false);
  });

  it('the real rarog restart with --data-dir: restart.sh gets the unit, the port and the log there, code 0', async () => {
    sb = linuxSandbox('rul-');
    const h = sb.homeDir;
    const custom = path.join(h, 'data');
    const root = packageRoot(path.join(h, 'prefix'));
    await linuxInstalled(sb, root, custom);
    fakeRestartScript(sb.bin, sb.logs);
    const run = await runUpdate({
      root, platform: 'linux', argv: ['--data-dir', custom], env: linuxEnv(sb), realRestart: true,
    });
    const log = updateLogs(custom).join('');
    expect(run.code, `${run.screen}\n${log}`).toBe(0);
    expect(stepLines(run.screen)).toContain(' ✓ Restart        server restarted');
    expect(sb.calls('restart-sh')).toEqual([`rarog.service ${String(port)} ${path.join(custom, 'server.log')}`]);
    expect(log).toContain('restart.sh fake');
    expect(existsSync(path.join(h, '.local', 'share', 'rarog'))).toBe(false);
  });

  it('pnpm with --data-dir: the new unit would leave that directory, so service install refuses, the unit stays', async () => {
    sb = linuxSandbox('rul-');
    const h = sb.homeDir;
    const custom = path.join(h, 'data');
    const old = otherRoot();
    const root = packageRoot(path.join(h, 'pnpm', 'store', 'rarog@2.0.0'));
    await linuxInstalled(sb, old, custom);
    fakeRestartScript(sb.bin, sb.logs);
    const unit = readFileSync(unitFilePath(h), 'utf8');
    lockHeldByParent(updateLockBody({ token: TOKEN, installed: { version: VERSION, root } }), h);
    const run = await runUpdate({
      root, platform: 'linux', argv: ['--data-dir', custom], env: linuxEnv(sb, { [UPDATE_LOCK_TOKEN]: TOKEN }),
      deps: {
        serviceInstall: (io, precheck, output, dataDir) => serviceInstallIfAbsent(io, precheck, undefined,
          { mode: 'package', installRoot: root, output, dataDir }),
      },
    });
    const log = updateLogs(custom).join('');
    expect(run.code, `${run.screen}\n${log}`).toBe(1);
    expect(stepLines(run.screen))
      .toContainEqual(expect.stringMatching(/^ ✗ Service {8}rarog service install failed \(code 1\)/u));
    expect(log).toContain(`the service would use the data directory ${path.join(h, '.local', 'share', 'rarog')},`
      + ` not ${custom} from --data-dir`);
    expect(readFileSync(unitFilePath(h), 'utf8')).toBe(unit);
    expect(sb.calls('systemctl').filter((call) => !call.startsWith('--user show'))).toEqual([]);
    expect(sb.calls('restart-sh')).toEqual([]);
  });
});
