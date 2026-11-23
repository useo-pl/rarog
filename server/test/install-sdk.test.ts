/**
 * Pobranie SDK Claude w trybie paczki (`install/sdk.ts`, `installSdk`) i krok „SDK Claude” w `rarog setup`.
 *
 * npm to atrapa `npm-cli.js` w katalogu tymczasowym testu: loguje węzeł, argumenty i nazwy zmiennych `npm_*`,
 * a według `RAROG_FAKE_NPM` kładzie pakiet SDK do `node_modules`, kończy się błędem npm, wisi albo symuluje
 * drugi `setup`, który był pierwszy. Setup biegnie w procesie testów z `deps.mode = 'package'`, `HOME`
 * tymczasowym i atrapą `launchctl` (usługi nie ma), więc niczego poza katalogiem testu nie dotyka.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../src/cli/io.ts';
import { buildServeEnv, checkServeEnv } from '../src/cli/serve.ts';
import { packageUninstallNotes } from '../src/cli/service.ts';
import { PLAN_DECLINED } from '../src/cli/setup-plan.ts';
import { setupCommand } from '../src/cli/setup.ts';
import type { SetupDeps } from '../src/cli/setup.ts';
import { hookCommand, hookInstallDir, statuslineCommand } from '../src/herdr/hook-config.ts';
import { installDataDir } from '../src/install/data-dir.ts';
import { PACKAGE_INSTALL, packageCommands } from '../src/install/repair.ts';
import {
  NPM_AGE_GATE_CONFIG, NPM_CI_ARGS, SDK_PACKAGE, SDK_TERMS_URL, SDK_TMP_PREFIX, checkPinnedSdk, installSdk, npmEnv,
  probeSdkDir,
  readSdkPin, sdkRoot, sdkVersionDir,
} from '../src/install/sdk.ts';
import type { SdkDirProbe, SdkInstallOptions } from '../src/install/sdk.ts';
import { transientInstall } from '../src/install/service-target.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const VERSION = readSdkPin().version;

let t: TempHome;
let home = '';
let bin = '';
let fakeNpm = '';
let npmLog = '';

/**
 * Atrapa `npm-cli.js`: CommonJS, bo leży w katalogu bez `package.json`. Pakiet SDK ma `exports['.'].default`
 * (kształt prawdziwego pakietu) i `listSessions`, które oddaje pustą tablicę.
 */
const FAKE_NPM = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const mode = process.env.RAROG_FAKE_NPM || 'ok';
const names = Object.keys(process.env).filter((name) => /^npm_/i.test(name)).sort();
fs.appendFileSync(process.env.RAROG_FAKE_NPM_LOG, JSON.stringify({
  node: process.execPath, args: process.argv.slice(2), cwd: process.cwd(), names,
}) + '\n');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const version = mode === 'wrong' ? '0.0.1' : lock.packages['node_modules/${SDK_PACKAGE}'].version;
function sdk(root) {
  const dir = path.join(root, 'node_modules', ...'${SDK_PACKAGE}'.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '${SDK_PACKAGE}', version, type: 'module', exports: { '.': { types: './sdk.d.ts', default: './sdk.mjs' } },
  }));
  fs.writeFileSync(path.join(dir, 'sdk.mjs'), 'export async function listSessions() { return []; }\n');
}
if (mode === 'fail') {
  process.stderr.write('npm warn config something\nnpm error code ENOTFOUND\nnpm error network request failed\n');
  process.exit(1);
}
if (mode === 'integrity') {
  process.stderr.write('npm error code EINTEGRITY\nnpm error sha512-x integrity checksum failed\n');
  process.exit(1);
}
if (mode === 'hang') setTimeout(() => {}, 60000);
else {
  if (mode === 'race') sdk(path.join(path.dirname(process.cwd()), version));
  sdk(process.cwd());
  if (mode === 'two') {
    fs.mkdirSync(path.join('node_modules', 'zod'), { recursive: true });
    fs.writeFileSync(path.join('node_modules', 'zod', 'package.json'), '{"name":"zod","version":"4.0.0"}');
  }
}
`;

const PROBE_OK: SdkDirProbe = () => Promise.resolve({ ok: true });

beforeEach(() => {
  t = tempHome('install-sdk-');
  home = path.join(t.home, 'h');
  bin = path.join(t.home, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  fakeNpm = path.join(t.home, 'npm', 'npm-cli.js');
  mkdirSync(path.dirname(fakeNpm));
  writeFileSync(fakeNpm, FAKE_NPM);
  npmLog = path.join(t.home, 'npm.log');
  // `launchctl print` z kodem 113: usługi nie ma (setup na macOS pyta launchd; prawdziwego nie dotykamy).
  writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\nexit 113\n', { mode: 0o755 });
});
afterEach(() => { t.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const dataDir = (): string => path.join(home, '.local', 'share', 'rarog');

interface NpmCall { readonly node: string; readonly args: string[]; readonly cwd: string; readonly names: string[] }
const npmCalls = (): NpmCall[] => (existsSync(npmLog)
  ? readFileSync(npmLog, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as NpmCall)
  : []);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, USER: 'znajomy', SHELL: '/bin/zsh', RAROG_FAKE_NPM_LOG: npmLog,
    ...(process.env['TMPDIR'] === undefined ? {} : { TMPDIR: process.env['TMPDIR'] }),
    ...extra,
  };
}

const install = (mode: string, extra: Partial<SdkInstallOptions> = {}): ReturnType<typeof installSdk> => installSdk({
  dataDir: dataDir(), env: env({ RAROG_FAKE_NPM: mode }), probe: PROBE_OK, npmCli: fakeNpm, ...extra,
});

/** Wpisy `<katalog danych>/sdk/` (bez nich: pusta lista). */
const sdkEntries = (): string[] => (existsSync(sdkRoot(dataDir())) ? readdirSync(sdkRoot(dataDir())).sort() : []);

describe('installSdk: npm ci w katalogu roboczym, potem rename', () => {
  it('pobranie: węzeł tego procesu, npm-cli.js z flagami, jedna paczka, katalog z wersją z prawami 700', async () => {
    const probed: string[] = [];
    const result = await install('ok', {
      probe: (dir, version) => { probed.push(`${path.basename(dir)} ${version}`); return Promise.resolve({ ok: true }); },
    });
    expect(result).toEqual({ ok: true, dir: sdkVersionDir(dataDir(), VERSION), raced: false });
    const [call] = npmCalls();
    expect(call?.node).toBe(process.execPath);
    expect(call?.args).toEqual(NPM_CI_ARGS.slice());
    expect(path.basename(path.dirname(call?.cwd ?? ''))).toBe('sdk');
    expect(path.basename(call?.cwd ?? '')).toMatch(new RegExp(`^${SDK_TMP_PREFIX.replace('.', '\\.')}`));
    // Sonda na katalogu roboczym, PRZED rename: katalog z wersją powstaje tylko z działającym SDK.
    expect(probed).toEqual([`${path.basename(call?.cwd ?? '')} ${VERSION}`]);
    expect(sdkEntries()).toEqual([VERSION]);
    const lock = readFileSync(path.join(sdkVersionDir(dataDir(), VERSION), 'package-lock.json'), 'utf8');
    expect(lock).toBe(readSdkPin().lockJson);
    for (const dir of [sdkRoot(dataDir()), sdkVersionDir(dataDir(), VERSION)]) {
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700);
    }
  });

  it('flagi z pomiaru: --include=prod, --omit=optional, --ignore-scripts, --legacy-peer-deps', () => {
    expect(NPM_CI_ARGS[0]).toBe('ci');
    expect(NPM_CI_ARGS).toEqual(expect.arrayContaining([
      '--include=prod', '--omit=optional', '--ignore-scripts', '--legacy-peer-deps',
    ]));
  });

  it.each([
    ['fail', /^npm ci: exited with code 1 \(npm error code ENOTFOUND\)$/u],
    ['integrity', /^npm ci: exited with code 1 \(npm error code EINTEGRITY\)$/u],
    ['two', /node_modules has 2 packages .*zod.*expected only/u],
    ['wrong', null],
  ])('%s → problem, bez katalogu z wersją, własny .tmp-* usunięty', async (mode, reason) => {
    const probe: SdkDirProbe = (dir, version) => probeSdkDir(dir, version, env());
    const result = await install(mode, mode === 'wrong' ? { probe } : {});
    expect(result.ok).toBe(false);
    if (!result.ok && reason !== null) expect(result.reason).toMatch(reason);
    if (!result.ok && mode === 'wrong') expect(result.reason).toContain(`expected ${SDK_PACKAGE} ${VERSION}, found`);
    expect(sdkEntries()).toEqual([]);
  });

  it('npm ci ponad limit czasu → problem, proces zabity, bez katalogu z wersją', async () => {
    const result = await install('hang', { timeoutMs: 500 });
    expect(result).toEqual({ ok: false, reason: 'npm ci did not finish within 0.5 s' });
    expect(sdkEntries()).toEqual([]);
  });

  it('no npm next to the node of this process (a node from pnpm env use): a failure marked noNpm, nothing written', async () => {
    const node = path.join(t.home, 'pnpm-node', 'bin', 'node');
    mkdirSync(path.dirname(node), { recursive: true });
    const result = await installSdk({ dataDir: dataDir(), env: {}, execPath: node });
    expect(result).toMatchObject({ ok: false, noNpm: true });
    expect(!result.ok && result.reason).toMatch(/^no npm next to node /u);
    expect(existsSync(dataDir())).toBe(false);
  });

  it('nieudana sonda → problem z jej powodem, bez katalogu z wersją', async () => {
    const result = await install('ok', { probe: () => Promise.resolve({ ok: false, reason: 'sonda: zła' }) });
    expect(result).toEqual({ ok: false, reason: 'sonda: zła' });
    expect(sdkEntries()).toEqual([]);
  });

  it('równoległy setup był pierwszy (rename na zajęty katalog) → ok z raced, własny .tmp-* usunięty', async () => {
    const result = await install('race');
    expect(result).toEqual({ ok: true, dir: sdkVersionDir(dataDir(), VERSION), raced: true });
    expect(sdkEntries()).toEqual([VERSION]);
  });

  it('cudzy .tmp-* zostaje nietknięty', async () => {
    const foreign = path.join(sdkRoot(dataDir()), `${SDK_TMP_PREFIX}cudzy`);
    mkdirSync(foreign, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(foreign, 'x'), 'abc');
    expect((await install('fail')).ok).toBe(false);
    expect(sdkEntries()).toEqual([`${SDK_TMP_PREFIX}cudzy`]);
  });

  it('sonda w osobnym procesie na prawdziwym imporcie pobranego katalogu przechodzi', async () => {
    const probe: SdkDirProbe = (dir, version) => probeSdkDir(dir, version, env());
    expect(await install('ok', { probe })).toMatchObject({ ok: true, raced: false });
  });

  it('npm dostaje środowisko bez npm_* wołającego, poza dozwolonymi npm_config_*', async () => {
    const extra = {
      npm_config_include: 'optional', npm_config_registry: 'https://registry.example.invalid/',
      npm_lifecycle_event: 'postinstall', NPM_CONFIG_GLOBAL: 'true', npm_config_https_proxy: 'http://proxy.invalid',
    };
    await installSdk({
      dataDir: dataDir(), env: env({ RAROG_FAKE_NPM: 'fail', ...extra }), probe: PROBE_OK, npmCli: fakeNpm,
    });
    expect(npmCalls()[0]?.names).toEqual(['npm_config_https_proxy', 'npm_config_registry']);
    expect(Object.keys(npmEnv({ ...extra, PATH: '/bin' })).sort())
      .toEqual(['PATH', 'npm_config_https_proxy', 'npm_config_registry']);
  });

  it('the release age gate reaches npm only through the extra list of rarog update; npm ci of the pinned SDK does'
    + ' not get it', async () => {
    const gate = {
      npm_config_min_release_age: '7', NPM_CONFIG_BEFORE: '2026-11-01', 'npm_config_min-release-age-exclude': 'x',
      npm_config_prefix: '/x', npm_config_global: 'true', npm_config_ignore_scripts: 'false',
    };
    await installSdk({
      dataDir: dataDir(), env: env({ RAROG_FAKE_NPM: 'fail', ...gate }), probe: PROBE_OK, npmCli: fakeNpm,
    });
    expect(npmCalls()[0]?.names).toEqual([]);
    expect(Object.keys(npmEnv(gate, NPM_AGE_GATE_CONFIG)).sort())
      .toEqual(['NPM_CONFIG_BEFORE', 'npm_config_min-release-age-exclude', 'npm_config_min_release_age']);
  });
});

// ---------------------------------------------------------------------------
// Krok „SDK Claude” w `rarog setup`
// ---------------------------------------------------------------------------

interface SetupRun {
  readonly code: number; readonly stdout: string; readonly prompts: string[]; readonly installs: number;
}

interface SetupOptions {
  /** `false` = bez terminala. */
  readonly tty?: boolean;
  readonly mode?: 'package' | 'clone';
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly installRoot?: string;
  readonly npmMode?: string;
  readonly probe?: SdkDirProbe;
}

/**
 * Setup with Enter on every question and a fake npm: on the plan screen's "Continue? [Y/n]" it means yes (the SDK
 * download comes with the plan), on `[y/N]` and `[y/N/d]` questions no.
 */
/**
 * A `config.json` of an earlier setup. This `PATH` has no `claude` and no `herdr`, and a first setup in a terminal
 * stops before the plan when a tool is missing; with an existing `config.json` the run goes on to the
 * SDK step, which these tests are about.
 */
function existingConfig(): void {
  const dir = path.join(home, '.config', 'rarog');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, env: {} }), { mode: 0o600 });
}

async function setup(options: SetupOptions = {}): Promise<SetupRun> {
  if (options.tty !== false) existingConfig();
  let stdout = '';
  const prompts: string[] = [];
  let installs = 0;
  const io: CliIo = {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stdout += text; },
    env: options.env ?? env({ RAROG_FAKE_NPM: options.npmMode ?? 'ok' }),
    cwd: t.home,
    platform: 'darwin',
    ...(options.tty === false ? {} : {
      ask: (prompt: string) => {
        prompts.push(prompt);
        return Promise.resolve('');
      },
    }),
  };
  const deps: SetupDeps = {
    serviceInstall: () => { installs += 1; return Promise.resolve(0); },
    mode: options.mode ?? 'package',
    installRoot: options.installRoot ?? path.join(t.home, 'lib', 'node_modules', 'rarog'),
    sdkInstall: (o) => installSdk({ ...o, npmCli: fakeNpm }),
    sdkProbe: options.probe ?? PROBE_OK,
  };
  const code = await setupCommand(['setup', '--verbose', ...(options.argv ?? [])], io, deps);
  return { code, stdout, prompts, installs };
}

/** Linia kroku „SDK Claude” z podsumowania setupu. */
const sdkSummary = (run: SetupRun): string =>
  run.stdout.split('Summary:')[1]?.split('\n').find((text) => /^ {2}\S+ +SDK\b/u.test(text)) ?? '';

describe('rarog setup: krok „SDK Claude” w paczce npm', () => {
  it('missing → plan screen with Anthropic\'s terms, after "Continue?" a download to the service data dir, step ok',
    async () => {
    const run = await setup();
    // No question of its own: the SDK is a line of the plan screen, covered by "Continue? [Y/n]".
    expect(run.prompts.filter((text) => text.includes('SDK'))).toEqual([]);
    expect(run.prompts[0]).toMatch(/^\? Continue\? \[Y\/n\] $/u);
    const plan = run.stdout.slice(run.stdout.indexOf('Rarog will set up'), run.stdout.indexOf('[1/'));
    // Two lines: the version, its size and the terms, then the link alone on its line, so it opens or copies whole.
    expect(plan).toContain(`  • Claude Agent SDK ${VERSION}, 5 MB, Anthropic's terms:\n    ${SDK_TERMS_URL}\n`);
    expect(run.stdout).toContain(`downloaded: ${sdkVersionDir(dataDir(), VERSION)}`);
    expect(sdkSummary(run)).toMatch(/^ {2}ok +SDK: \S+ downloaded$/u);
    expect(npmCalls()).toHaveLength(1);
    expect(existsSync(path.join(sdkVersionDir(dataDir(), VERSION), 'node_modules', ...SDK_PACKAGE.split('/'),
      'package.json'))).toBe(true);
  });

  it('bez terminala: tylko wydruk, zero zapisów i zero wywołań npm', async () => {
    const run = await setup({ tty: false });
    expect(run.stdout).toContain(`${sdkVersionDir(dataDir(), VERSION)}: missing`);
    expect(sdkSummary(run)).toBe(`  MISSING  SDK: rarog setup in a terminal downloads ${SDK_PACKAGE} ${VERSION}`);
    expect(npmCalls()).toEqual([]);
    expect(existsSync(dataDir())).toBe(false);
  });

  it('"n" on "Continue?" = nothing: no npm, no data directory, code 1', async () => {
    existingConfig();
    let stdout = '';
    const prompts: string[] = [];
    const io: CliIo = {
      stdout: (text) => { stdout += text; }, stderr: (text) => { stdout += text; }, env: env(), cwd: t.home,
      platform: 'darwin', ask: (prompt) => { prompts.push(prompt); return Promise.resolve('n'); },
    };
    const code = await setupCommand(['setup', '--verbose'], io, {
      serviceInstall: () => Promise.resolve(0), mode: 'package',
      installRoot: path.join(t.home, 'lib'), sdkInstall: (o) => installSdk({ ...o, npmCli: fakeNpm }), sdkProbe: PROBE_OK,
    });
    expect(stdout).toContain(`Claude Agent SDK ${VERSION}`);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^\? Continue\? \[Y\/n\] $/u);
    expect(stdout).toContain(PLAN_DECLINED);
    expect(code).toBe(1);
    expect(npmCalls()).toEqual([]);
    expect(existsSync(dataDir())).toBe(false);
  });

  it('pobranie nie przeszło: problem z pierwszą linią błędu npm i zdaniem o pustej liście', async () => {
    const run = await setup({ npmMode: 'fail' });
    expect(run.stdout).toContain('download failed: npm ci: exited with code 1 (npm error code ENOTFOUND)');
    expect(run.stdout).toContain('The sessions list in the app stays empty until the SDK is downloaded; once online,'
      + ' run rarog setup.');
    expect(sdkSummary(run)).toMatch(/^ {2}PROBLEM +SDK: download failed/u);
    expect(sdkEntries()).toEqual([]);
  });

  it('obecny i zgodny → ok bez pytania; sonda nie przeszła → problem; katalog bez package.json → problem bez kasowania', async () => {
    expect((await install('ok')).ok).toBe(true);
    const green = await setup({ tty: false });
    expect(sdkSummary(green)).toBe(`  ok       SDK: ${VERSION}`);
    const red = await setup({ tty: false, probe: () => Promise.resolve({ ok: false, reason: 'listSessions: x' }) });
    expect(red.stdout).toContain(`${sdkVersionDir(dataDir(), VERSION)}: listSessions: x`);
    expect(sdkSummary(red)).toMatch(/^ {2}PROBLEM +SDK \S+: probe failed/u);
    const empty = path.join(dataDir(), 'sdk-pusty');
    const run = await setup({ tty: false, argv: ['--data-dir', empty] });
    expect(run.stdout).toContain(`${sdkVersionDir(empty, VERSION)}: missing`);
    mkdirSync(sdkVersionDir(empty, VERSION), { recursive: true, mode: 0o700 });
    for (const dir of [sdkRoot(empty), sdkVersionDir(empty, VERSION)]) chmodSync(dir, 0o700);
    const noManifest = await setup({ tty: false, argv: ['--data-dir', empty] });
    expect(noManifest.stdout).toContain(`has no ${SDK_PACKAGE} package.json`);
    expect(noManifest.stdout).not.toMatch(/\brm -r/u);
    expect(sdkSummary(noManifest)).toMatch(/^ {2}PROBLEM +SDK: .* has no package\.json for the package$/u);
  });

  it('cudzy katalog roboczy: wiek i rozmiar, bez komendy kasowania', async () => {
    const foreign = path.join(sdkRoot(dataDir()), `${SDK_TMP_PREFIX}cudzy`);
    mkdirSync(foreign, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(foreign, 'x'), 'x'.repeat(2_000_000));
    const run = await setup({ tty: false });
    expect(run.stdout).toMatch(new RegExp(`work directory of another or interrupted download: ${foreign
      .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\(0 min, 2\\.0 MB\\)`, 'u'));
    expect(run.stdout).not.toMatch(/\brm -r/u);
  });

  it('na końcu zdanie o aktualizacji: komenda menedżera z układu katalogu, potem rarog restart (npm) albo rarog service install (pnpm, nieznany układ); klon bez zdania', async () => {
    const sentence = (update: string, after = 'rarog restart'): string => `To update Rarog: ${update}, then ${after};`
      + ' to go back to an older version, run the same command with its number instead of latest.';
    const npm = await setup({ tty: false });
    const npmRoot = path.join(t.home, 'lib', 'node_modules', 'rarog');
    expect(npm.stdout.trimEnd().endsWith(`\n\n${sentence(packageCommands('npm', npmRoot).update)}`)).toBe(true);
    const pnpmRoot = path.join(t.home, 'pnpm', 'store', 'v11', 'links', '@', 'rarog', '1.0.0', 'abc123', 'node_modules',
      'rarog');
    expect((await setup({ tty: false, installRoot: pnpmRoot })).stdout)
      .toContain(sentence(packageCommands('pnpm').update, 'rarog service install'));
    expect((await setup({ tty: false, installRoot: path.join(t.home, 'inny', 'rarog') })).stdout)
      .toContain(sentence(packageCommands(null).update, 'rarog service install'));
    expect((await setup({ tty: false, mode: 'clone' })).stdout).not.toContain('To update Rarog');
  });

  it('klon repo: info „z workspace”, bez pytania i bez npm', async () => {
    const run = await setup({ mode: 'clone' });
    expect(run.prompts.some((text) => text.includes('Download the Claude SDK'))).toBe(false);
    expect(sdkSummary(run)).toBe('  info     SDK: from the workspace');
    expect(npmCalls()).toEqual([]);
  });

  it('uruchomiony z cache npx → odmowa z komendą instalacji na stałe, przed jakimkolwiek krokiem', async () => {
    const run = await setup({ installRoot: path.join(t.home, '.npm', '_npx', '0123abcd', 'node_modules', 'rarog') });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('npx cache');
    expect(run.stdout).toContain(PACKAGE_INSTALL.npm);
    expect(run.stdout).toContain(PACKAGE_INSTALL.pnpm);
    expect(run.stdout).not.toContain('[1/');
    expect(npmCalls()).toEqual([]);
  });

  it('uruchomiony przez pnpm dlx (user agent pnpm) → odmowa; klon tej odmowy nie ma', async () => {
    const agent = { npm_config_user_agent: 'pnpm/11.4.0 npm/? node/v22.22.3 darwin arm64' };
    const run = await setup({ env: env(agent) });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('pnpm dlx or pnpm exec');
    expect(transientInstall('clone', '/x/_npx/y', agent)).toBeNull();
    expect(transientInstall('package', '/usr/local/lib/node_modules/@rarog/server', {})).toBeNull();
  });

  it('XDG_DATA_HOME w powłoce, a usługa go nie dostaje → rozjazd z obiema ścieżkami, bez pobrania', async () => {
    const xdg = path.join(t.home, 'xdg');
    const run = await setup({ env: env({ XDG_DATA_HOME: xdg }) });
    expect(run.stdout).toContain(`The data directory from this shell ${path.join(xdg, 'rarog')} (XDG_DATA_HOME in this shell)`);
    expect(run.stdout).toContain(dataDir());
    expect(sdkSummary(run)).toMatch(/^ {2}PROBLEM +SDK: data directory undetermined/u);
    expect(npmCalls()).toEqual([]);
  });

  it('Linux: XDG_DATA_HOME w powłoce bez wpisu u menedżera → ten sam rozjazd (reguła na środowisku usługi)', () => {
    const xdg = path.join(t.home, 'xdg');
    const result = installDataDir({ home, shellEnv: { XDG_DATA_HOME: xdg }, serviceEnv: {} });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.message).toContain(`${path.join(xdg, 'rarog')} (XDG_DATA_HOME in this shell)`);
    expect(installDataDir({ home, shellEnv: { XDG_DATA_HOME: xdg }, serviceEnv: { XDG_DATA_HOME: xdg } }))
      .toEqual({ ok: true, dir: path.join(xdg, 'rarog'), source: 'rule' });
  });

  it('katalog zainstalowanej usługi inny niż z powłoki albo z --data-dir → odmowa z obiema ścieżkami', () => {
    const service = path.join(t.home, 'usluga');
    expect(installDataDir({ home, shellEnv: {}, serviceEnv: {}, serviceDir: service }))
      .toMatchObject({ ok: false, message: expect.stringContaining(`the directory of the installed service ${service} differ`) });
    expect(installDataDir({ home, shellEnv: {}, serviceEnv: {}, flag: service, serviceDir: service }))
      .toEqual({ ok: true, dir: service, source: 'flag' });
    const other = installDataDir({ home, shellEnv: {}, serviceEnv: {}, flag: path.join(t.home, 'inny'), serviceDir: service });
    expect(other.ok ? '' : other.message).toContain(`${path.join(t.home, 'inny')} and the data directory of the installed service`
      + ` ${service} differ`);
  });

  it('--data-dir setupu = katalog serve --data-dir: SDK pobrany tam przechodzi serve --check paczki', async () => {
    const custom = path.join(t.home, 'dane');
    const run = await setup({ argv: ['--data-dir', custom] });
    expect(run.stdout).toContain(`downloaded: ${sdkVersionDir(custom, VERSION)}`);
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env: env(), cwd: t.home,
    };
    const built = buildServeEnv(env(), {
      env: { RAROG_ORIGINS: 'https://rarog-test.example.ts.net' }, mode: 'check', dataDir: custom,
    });
    const checked = await checkServeEnv(built, io, 'rarog serve --check', undefined, (input) => checkPinnedSdk({
      ...input, mode: 'package', probe: PROBE_OK,
    }));
    expect(checked.ok, stderr).toBe(true);
    expect(stdout).toContain(`SDK: ${VERSION} (${sdkVersionDir(custom, VERSION)})`);
  });

  it('usługa czeka na SDK: bez gotowego SDK setup jej nie instaluje', async () => {
    const config = path.join(home, '.config', 'rarog');
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(config, 'config.json'), JSON.stringify({
      version: 1, env: { RAROG_ORIGINS: 'https://rarog-test.example.ts.net', RAROG_PORT: '18997' },
    }), { mode: 0o600 });
    const run = await setup({ tty: false });
    expect(run.stdout).toContain('the Claude SDK first (step above): without it rarog serve --check refuses');
    expect(run.installs).toBe(0);
  });
});

describe('rarog service uninstall w paczce: bloki do zdjęcia z ustawień Claude Code', () => {
  it('paczka: blok hooka, statusLine i katalog kopii; klon: nic', () => {
    const notes = packageUninstallNotes(home, 'package').join('\n');
    expect(notes).toContain(hookCommand(home));
    expect(notes).toContain(statuslineCommand(home));
    expect(notes).toContain(hookInstallDir(home));
    expect(packageUninstallNotes(home, 'clone')).toEqual([]);
  });

  it('rm -r katalogu danych tylko z sdk/ i poniżej katalogu domowego; log usługi w HOME nie daje rm -r HOME', () => {
    const configDir = path.join(home, '.config', 'rarog');
    const notes = (dataDir: string | null): string => packageUninstallNotes(home, 'package', {
      installRoot: path.join(t.home, 'prefix', 'lib', 'node_modules', 'rarog'), dataDir, configDir,
    }).at(-1) ?? '';
    const data = path.join(home, '.local', 'share', 'rarog');
    mkdirSync(path.join(data, 'sdk'), { recursive: true });
    expect(notes(data)).toBe('4. When you are done with Rarog (data, devices, SDK and config):'
      + ` rm -r '${data}' '${configDir}'`);
    mkdirSync(path.join(home, 'sdk'), { recursive: true });
    for (const dir of [home, path.dirname(home), path.join(t.home, 'bez-sdk'), null]) {
      const line = notes(dir);
      expect(line, String(dir)).toContain(`rm -r '${configDir}' (config)`);
      expect(line, String(dir)).toContain('gets no delete command');
      expect(line.match(/rm -r/gu), String(dir)).toHaveLength(1);
    }
  });
});
