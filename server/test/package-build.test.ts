/**
 * Pakowacz paczki npm (`scripts/package.mjs`, `pnpm run package`) na atrapie drzewa źródeł: prawdziwa emisja `tsc`
 * z `tsconfig.package.json` repo i prawdziwy `npm pack`, a w miejscu `pnpm` atrapa w `PATH`, która zapisuje argv
 * i środowisko, a jako materializację kopiuje przygotowane `node_modules` (dołączane paczki, SDK, tsx z esbuild,
 * iroh, paczka platformowa i plik stanu pnpm). Sieci nie ma: `npm pack` nie pobiera niczego.
 *
 * Sprawdza: skład tarballa i manifestu paczki (SDK i tsx w żadnym polu zależności, iroh z rejestru, nie dołączony),
 * `@rarog/shared` z `exports` na `.js`, pliki `server/src/install/*.json` w liście, dwa buildy = te same listy
 * i skróty, audyt tarballa przyjmuje wynik pakowacza, bez `--name` nazwa to `RAROG_PACKAGE_NAME` z `install/repair.ts`,
 * `--name` zmienia tylko pole `name`, `--dry-run` niczego nie
 * zapisuje, odmowy (licencja spoza listy, brak pliku licencji, istniejący `build/`, `--out` w drzewie źródeł)
 * i importy pakowacza wyłącznie z `node:*`.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RAROG_PACKAGE_NAME } from '../src/install/repair.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGER = path.join(REPO, 'scripts', 'package.mjs');
/** Jeden przebieg pakowacza na atrapie: emisja `tsc` i `npm pack` to ok. 2 s; zapas na wolny runner. */
const RUN_TIMEOUT_MS = 120_000;

const SDK = '@anthropic-ai/claude-agent-sdk';
const IROH = '@number0/iroh';
/** The tarball and build manifest base of the default name on the fake tree (version 0.0.1). */
const DEFAULT_BASE = `${RAROG_PACKAGE_NAME.replace(/^@/u, '').replace('/', '-')}-0.0.1`;

interface PackRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface BuildRecord {
  readonly name: string;
  readonly version: string;
  readonly tarball: string | null;
  readonly sha256: string | null;
  readonly dependencies: Record<string, string>;
  readonly bundleDependencies: string[];
  readonly packages: { path: string; name: string; version: string; license: string }[];
  readonly files: { path: string; size: number; sha256: string }[];
}

interface PnpmCall {
  readonly args: string[];
  readonly cwd: string;
  readonly userconfig: string | null;
  readonly store: string | null;
  readonly npmVars: string[];
}

let base = '';
let source = '';
let modules = '';
let pnpmLog = '';

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function json(file: string, value: unknown): void {
  write(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Paczka w atrapie materializacji: `package.json`, `index.js` i (domyślnie) `LICENSE`. */
function fakePackage(root: string, rel: string, manifest: Record<string, unknown>, licenseFile = true): void {
  json(path.join(root, rel, 'package.json'), manifest);
  write(path.join(root, rel, 'index.js'), `export const name = ${JSON.stringify(manifest['name'])};\n`);
  if (licenseFile) write(path.join(root, rel, 'LICENSE'), 'MIT License\n');
}

/** Registry page fields of the root package.json, which the published manifest carries unchanged. */
const METADATA = {
  description: 'Server for the Rarog app', keywords: ['claude-code', 'herdr'], homepage: 'https://example.invalid/',
  bugs: { url: 'https://example.invalid/issues' },
};

/** Atrapa drzewa źródeł: manifesty jak w repo, kilka plików TS, pliki bez TS i prawdziwy pakowacz. */
function makeSource(dir: string): void {
  json(path.join(dir, 'package.json'), {
    name: 'rarog', version: '0.0.1', private: true, license: 'MIT', ...METADATA,
    repository: { type: 'git', url: 'git+https://example.invalid/rarog.git' },
    type: 'module', bin: { rarog: 'bin/rarog.mjs' }, engines: { node: '>=22.15' },
    scripts: { package: 'node scripts/package.mjs' }, devDependencies: { typescript: '7.0.2' },
    dependencies: { qrcode: '1.5.4', tsx: '4.23.12' },
  });
  json(path.join(dir, 'server', 'package.json'), {
    name: '@rarog/server', version: '0.0.1', private: true, type: 'module',
    dependencies: { [SDK]: '0.3.247', [IROH]: '1.2.0', '@rarog/shared': 'workspace:*', ws: '8.21.3', zod: '4.4.3' },
  });
  json(path.join(dir, 'shared', 'package.json'), {
    name: '@rarog/shared', version: '0.0.2', private: true, license: 'MIT', type: 'module',
    exports: {
      '.': { types: './dist/types/src/protocol.d.ts', default: './src/protocol.ts' },
      './data-dir': { types: './src/data-dir.d.mts', default: './src/data-dir.mjs' },
    },
    dependencies: { zod: '4.4.3' },
  });
  write(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  write(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - shared\n  - server\n');
  write(path.join(dir, '.npmrc'), 'ignore-scripts=true\n');
  for (const file of ['tsconfig.base.json', 'tsconfig.package.json']) cpSync(path.join(REPO, file), path.join(dir, file));
  write(path.join(dir, 'server/src/index.ts'), "import { VALUE } from '@rarog/shared';\nimport { main } from"
    + " './cli/main.ts';\n\nexport const started: number = VALUE + main();\n");
  write(path.join(dir, 'server/src/cli/main.ts'), 'export function main(): number {\n  return 0;\n}\n');
  write(path.join(dir, 'server/src/cli/qrcode.d.ts'), "declare module 'qrcode';\n");
  write(path.join(dir, 'server/src/cli/templates/launchd.plist'), '<plist/>\n');
  write(path.join(dir, 'server/src/cli/templates/rarog.service'), '[Unit]\n');
  write(path.join(dir, 'server/src/install/mode.ts'), "export const MODE: string = 'clone';\n");
  json(path.join(dir, 'server/src/install/sdk-package.json'), { name: 'rarog-sdk', private: true });
  json(path.join(dir, 'server/src/install/sdk-lock.json'), { lockfileVersion: 3 });
  write(path.join(dir, 'server/src/demo/notatka.md'), '# notatka\n');
  write(path.join(dir, 'shared/src/protocol.ts'), 'export const VALUE: number = 1;\n');
  write(path.join(dir, 'shared/src/data-dir.mjs'), 'export const DIR = "x";\n');
  write(path.join(dir, 'shared/src/data-dir.d.mts'), 'export declare const DIR: string;\n');
  write(path.join(dir, 'bin/rarog.mjs'), '#!/usr/bin/env node\n');
  chmodSync(path.join(dir, 'bin/rarog.mjs'), 0o755);
  write(path.join(dir, 'scripts/hooks/canon.mjs'), 'export {};\n');
  write(path.join(dir, 'scripts/restart.sh'), '#!/usr/bin/env bash\n');
  write(path.join(dir, 'LICENSE'), 'MIT License\n');
  write(path.join(dir, 'THIRD-PARTY-NOTICES'), 'notices\n');
  write(path.join(dir, 'README.md'), '# rarog\n');
  cpSync(PACKAGER, path.join(dir, 'scripts', 'package.mjs'));
  mkdirSync(path.join(dir, 'node_modules', '@types'), { recursive: true });
  symlinkSync(path.join(REPO, 'node_modules', 'typescript'), path.join(dir, 'node_modules', 'typescript'));
  symlinkSync(path.join(REPO, 'node_modules', '@types', 'node'), path.join(dir, 'node_modules', '@types', 'node'));
}

/** Atrapa wyniku `pnpm install --prod` z `node-linker=hoisted`. */
function makeModules(dir: string): void {
  const nm = path.join(dir, 'node_modules');
  fakePackage(nm, 'qrcode', { name: 'qrcode', version: '1.5.4', license: 'MIT', dependencies: { dijkstrajs: '^1.0.1' } });
  fakePackage(nm, 'dijkstrajs', { name: 'dijkstrajs', version: '1.0.3', license: 'MIT' });
  fakePackage(nm, 'ws', { name: 'ws', version: '8.21.3', license: 'MIT', optionalDependencies: { 'nie-ma': '1' } });
  fakePackage(nm, 'zod', { name: 'zod', version: '4.4.3', license: 'MIT' });
  fakePackage(nm, SDK, { name: SDK, version: '0.3.247', license: 'SEE LICENSE IN README.md' });
  fakePackage(nm, 'tsx', { name: 'tsx', version: '4.23.12', license: 'MIT', dependencies: { esbuild: '~0.27.0' } });
  fakePackage(nm, 'esbuild', { name: 'esbuild', version: '0.27.0', license: 'MIT' });
  fakePackage(nm, IROH, { name: IROH, version: '1.2.0', license: 'MIT OR Apache-2.0' }, false);
  fakePackage(nm, 'fsevents', { name: 'fsevents', version: '2.3.3', license: 'MIT', os: ['darwin'] });
  write(path.join(nm, '.modules.yaml'), `virtualStoreDir: ${dir}\n`);
  mkdirSync(path.join(dir, 'server', 'node_modules', '@rarog'), { recursive: true });
  symlinkSync('../../../shared', path.join(dir, 'server', 'node_modules', '@rarog', 'shared'));
}

/** Atrapa `pnpm`: zapis wywołania; `store path`, `--version` i `install` (kopia atrapy materializacji). */
function makeFakePnpm(bin: string): void {
  write(path.join(bin, 'pnpm'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({ args, cwd: process.cwd(),',
    '  userconfig: process.env.npm_config_userconfig ?? null, store: process.env.pnpm_config_store_dir ?? null,',
    "  npmVars: Object.keys(process.env).filter((k) => /^npm_/i.test(k)).sort() }) + '\\n');",
    "if (args[0] === '--version') { console.log('11.4.0'); process.exit(0); }",
    "if (args[0] === 'store' && args[1] === 'path') { console.log(path.join(process.env.FAKE_PNPM_STORE, 'v11'));"
      + ' process.exit(0); }',
    "if (args[0] === 'install') {",
    '  fs.cpSync(process.env.FAKE_PNPM_MODULES, process.cwd(), { recursive: true, verbatimSymlinks: true });',
    '  process.exit(0);',
    '}',
    'process.exit(2);',
    '',
  ].join('\n'));
  chmodSync(path.join(bin, 'pnpm'), 0o755);
}

function runPackager(args: string[], options: { root?: string; modulesDir?: string; tmp?: string } = {}): PackRun {
  const result = spawnSync(process.execPath, [path.join(options.root ?? source, 'scripts', 'package.mjs'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(base, 'bin')}${path.delimiter}${process.env['PATH'] ?? ''}`,
      TMPDIR: options.tmp ?? path.join(base, 'tmp'),
      FAKE_PNPM_LOG: pnpmLog,
      FAKE_PNPM_MODULES: options.modulesDir ?? modules,
      FAKE_PNPM_STORE: path.join(base, 'store'),
      // Zmienne `npm_*` wołającego nie mogą dojść do pnpm ani npm.
      npm_config_registry: 'http://127.0.0.1:9/',
      npm_package_name: 'obca',
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readRecord(out: string, name = DEFAULT_BASE): BuildRecord {
  return JSON.parse(readFileSync(path.join(out, `${name}.build.json`), 'utf8')) as BuildRecord;
}

function unpack(tarball: string): string {
  const dir = mkdtempSync(path.join(base, 'unpack-'));
  const result = spawnSync('tar', ['-xzf', tarball, '-C', dir], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return path.join(dir, 'package');
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function pnpmCalls(): PnpmCall[] {
  return readFileSync(pnpmLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as PnpmCall);
}

beforeAll(() => {
  // `realpath`: na macOS `tmpdir()` to dowiązanie (`/var` → `/private/var`), a procesy widzą `cwd` po rozwinięciu.
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'rarog-package-build-')));
  source = path.join(base, 'source');
  modules = path.join(base, 'modules');
  pnpmLog = path.join(base, 'pnpm.log');
  mkdirSync(path.join(base, 'tmp'));
  makeSource(source);
  makeModules(modules);
  makeFakePnpm(path.join(base, 'bin'));
});

afterAll(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
});

describe('pakowacz paczki npm na atrapie drzewa', () => {
  let first: BuildRecord;
  let firstOut = '';
  let pkg: Record<string, unknown> = {};
  let unpacked = '';

  beforeAll(() => {
    firstOut = path.join(base, 'out-1');
    const run = runPackager(['--out', firstOut]);
    expect(run.code, run.stderr).toBe(0);
    first = readRecord(firstOut);
    unpacked = unpack(path.join(firstOut, `${DEFAULT_BASE}.tgz`));
    pkg = readJson(path.join(unpacked, 'package.json'));
  }, RUN_TIMEOUT_MS);

  it('tarball i manifest budowania leżą w `--out`, `build/` znika, wejście bez zmian poza nim', () => {
    expect(readdirSync(firstOut).sort()).toEqual([`${DEFAULT_BASE}.build.json`, `${DEFAULT_BASE}.tgz`]);
    expect(first.tarball).toBe(`${DEFAULT_BASE}.tgz`);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(existsSync(path.join(source, 'build'))).toBe(false);
    // Node i npm trzymają w `TMPDIR` własną pamięć podręczną kompilacji; katalogi pakowacza mają prefiks.
    const left = readdirSync(path.join(base, 'tmp')).filter((name) => name.startsWith('rarog-package'));
    expect(left, 'katalogi robocze pakowacza sprzątnięte').toEqual([]);
  });

  // The root package.json is the private workspace root `rarog`; without `--name` the package is still the published
  // name of the server code (a wrong name sends users to a 404).
  it('without `--name` the package is RAROG_PACKAGE_NAME, not the root name', () => {
    expect(first.name).toBe(RAROG_PACKAGE_NAME);
    expect(pkg['name']).toBe(RAROG_PACKAGE_NAME);
  });

  it('manifest paczki: pola z korzenia, SDK i tsx w żadnym polu zależności, iroh z rejestru', () => {
    expect(pkg).toEqual({
      name: RAROG_PACKAGE_NAME, version: '0.0.1', ...METADATA, license: 'MIT', type: 'module',
      bin: { rarog: 'bin/rarog.mjs' },
      engines: { node: '>=22.15' }, os: ['darwin', 'linux'],
      repository: { type: 'git', url: 'git+https://example.invalid/rarog.git' },
      dependencies: { [IROH]: '1.2.0', '@rarog/shared': '0.0.2', qrcode: '1.5.4', ws: '8.21.3', zod: '4.4.3' },
      bundleDependencies: ['@rarog/shared', 'qrcode', 'ws', 'zod'],
      publishConfig: { access: 'public' },
    });
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      const names = Object.keys((pkg[field] ?? {}) as Record<string, string>);
      expect(names, field).not.toContain(SDK);
      expect(names, field).not.toContain('tsx');
    }
  });

  it('lista plików: JS, pliki bez TS, `sdk-*.json`; bez SDK, tsx, esbuild, iroh, paczki platformowej i stanu pnpm', () => {
    const files = first.files.map((file) => file.path);
    expect(files).toEqual(expect.arrayContaining([
      'LICENSE', 'README.md', 'THIRD-PARTY-NOTICES', 'bin/rarog.mjs', 'package.json', 'scripts/hooks/canon.mjs',
      'scripts/restart.sh', 'server/src/cli/main.js', 'server/src/cli/templates/launchd.plist',
      'server/src/cli/templates/rarog.service', 'server/src/index.js', 'server/src/install/mode.js',
      'server/src/install/sdk-lock.json', 'server/src/install/sdk-package.json',
      'node_modules/@rarog/shared/LICENSE', 'node_modules/@rarog/shared/package.json',
      'node_modules/@rarog/shared/src/data-dir.d.mts', 'node_modules/@rarog/shared/src/data-dir.mjs',
      'node_modules/@rarog/shared/src/protocol.js', 'node_modules/dijkstrajs/LICENSE', 'node_modules/qrcode/index.js',
      'node_modules/ws/index.js', 'node_modules/zod/index.js',
    ]));
    const forbidden = /^node_modules\/(?:@anthropic-ai|tsx|esbuild|@number0|fsevents|\.modules\.yaml)(?:\/|$)/u;
    expect(files.filter((file) => forbidden.test(file))).toEqual([]);
    expect(files.filter((file) => /\.ts$/u.test(file) || file.startsWith('server/src/demo/'))).toEqual([]);
    expect(existsSync(path.join(unpacked, 'node_modules', '@anthropic-ai'))).toBe(false);
    expect(existsSync(path.join(unpacked, 'node_modules', 'tsx'))).toBe(false);
    expect(first.packages.map((one) => `${one.name}@${one.version} ${one.license}`)).toEqual([
      'dijkstrajs@1.0.3 MIT', 'qrcode@1.5.4 MIT', 'ws@8.21.3 MIT', 'zod@4.4.3 MIT',
    ]);
  });

  it('`@rarog/shared`: `exports` na `.js`, typy tylko tam, gdzie plik jest w paczce', () => {
    expect(readJson(path.join(unpacked, 'node_modules/@rarog/shared/package.json'))).toEqual({
      name: '@rarog/shared', version: '0.0.2', private: true, license: 'MIT', type: 'module',
      exports: {
        '.': { default: './src/protocol.js' },
        './data-dir': { types: './src/data-dir.d.mts', default: './src/data-dir.mjs' },
      },
      dependencies: { zod: '4.4.3' },
    });
    expect(readFileSync(path.join(unpacked, 'server/src/index.js'), 'utf8')).toContain("'./cli/main.js'");
  });

  it('pnpm dostaje materializację w katalogu tymczasowym, sklep drzewa wejścia, bez `npm_*` wołającego', () => {
    const install = pnpmCalls().find((call) => call.args[0] === 'install');
    expect(install?.args).toEqual(['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted',
      '--ignore-scripts']);
    expect(install?.cwd.startsWith(path.join(base, 'tmp'))).toBe(true);
    expect(install?.store).toBe(path.join(base, 'store'));
    // Pusty plik w katalogu roboczym pakowacza (już usuniętym) zamiast `~/.npmrc` użytkownika.
    expect(install?.userconfig?.startsWith(path.join(base, 'tmp'))).toBe(true);
    expect(install?.npmVars).toEqual(['npm_config_update_notifier', 'npm_config_userconfig']);
  });

  it('drugi build z tego samego drzewa: te same pliki, te same skróty, ten sam tarball', () => {
    const out = path.join(base, 'out-2');
    const run = runPackager(['--out', out]);
    expect(run.code, run.stderr).toBe(0);
    const second = readRecord(out);
    expect(second.files).toEqual(first.files);
    expect(second.sha256).toBe(first.sha256);
  }, RUN_TIMEOUT_MS);

  it('audyt tarballa (`scripts/package-audit.mjs`) przyjmuje tarball i manifest pakowacza', () => {
    const result = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'package-audit.mjs'), '--name',
      RAROG_PACKAGE_NAME, '--version', '0.0.1', path.join(firstOut, `${DEFAULT_BASE}.tgz`),
      path.join(firstOut, `${DEFAULT_BASE}.build.json`)], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${RAROG_PACKAGE_NAME}@0.0.1: ${String(first.files.length)} files match the manifest`);
  }, RUN_TIMEOUT_MS);

  it('`--name` zmienia tylko pole `name` manifestu paczki', () => {
    const out = path.join(base, 'out-name');
    const run = runPackager(['--out', out, '--name', '@rarog-test/rarog']);
    expect(run.code, run.stderr).toBe(0);
    const renamed = readRecord(out, 'rarog-test-rarog-0.0.1');
    const renamedPkg = readJson(path.join(unpack(path.join(out, 'rarog-test-rarog-0.0.1.tgz')), 'package.json'));
    expect(renamedPkg).toEqual({ ...pkg, name: '@rarog-test/rarog' });
    const withoutManifest = (record: BuildRecord) => record.files.filter((file) => file.path !== 'package.json');
    expect(withoutManifest(renamed)).toEqual(withoutManifest(first));
  }, RUN_TIMEOUT_MS);

  it('`--version` i `--dry-run --json`: lista na stdout, nic na dysku', () => {
    const out = path.join(base, 'out-dry');
    const run = runPackager(['--out', out, '--version', '1.2.3-test.1', '--dry-run', '--json']);
    expect(run.code, run.stderr).toBe(0);
    const record = JSON.parse(run.stdout) as BuildRecord;
    expect(record.name).toBe(RAROG_PACKAGE_NAME);
    expect(record.version).toBe('1.2.3-test.1');
    expect(record.tarball).toBeNull();
    expect(record.files.map((file) => file.path)).toEqual(first.files.map((file) => file.path));
    expect(existsSync(out)).toBe(false);
    expect(existsSync(path.join(source, 'build'))).toBe(false);
  }, RUN_TIMEOUT_MS);
});

describe('pakowacz odmawia', () => {
  /** Kopia atrapy materializacji ze zmianą. */
  function modulesWith(change: (dir: string) => void): string {
    const dir = mkdtempSync(path.join(base, 'modules-'));
    cpSync(modules, dir, { recursive: true, verbatimSymlinks: true });
    change(dir);
    return dir;
  }

  it('licencja dołączanej paczki spoza listy: kod 1, bez tarballa', () => {
    const modulesDir = modulesWith((dir) => {
      const file = path.join(dir, 'node_modules/ws/package.json');
      writeFileSync(file, JSON.stringify({ ...readJson(file), license: 'GPL-3.0-only' }));
    });
    const out = path.join(base, 'out-gpl');
    const run = runPackager(['--out', out], { modulesDir });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('ws@8.21.3: license GPL-3.0-only not on the list');
    expect(readdirSync(out)).toEqual([]);
    expect(existsSync(path.join(source, 'build'))).toBe(false);
  }, RUN_TIMEOUT_MS);

  it('dołączana paczka bez pliku licencji: kod 1', () => {
    const modulesDir = modulesWith((dir) => { rmSync(path.join(dir, 'node_modules/dijkstrajs/LICENSE')); });
    const run = runPackager(['--out', path.join(base, 'out-nolicense')], { modulesDir });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('dijkstrajs@1.0.3: no license file');
  }, RUN_TIMEOUT_MS);

  it('paczka platformowa albo SDK w domknięciu dołączanych: kod 1', () => {
    const modulesDir = modulesWith((dir) => {
      const file = path.join(dir, 'node_modules/ws/package.json');
      writeFileSync(file, JSON.stringify({ ...readJson(file), dependencies: { fsevents: '^2', [SDK]: '*' } }));
    });
    const run = runPackager(['--out', path.join(base, 'out-platform')], { modulesDir });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('fsevents@2.3.3: platform package (os/cpu)');
    expect(run.stderr).toContain(`${SDK}@0.3.247: dependency of an included package`);
  }, RUN_TIMEOUT_MS);

  it('istniejący `build/`: kod 1, cudzy katalog zostaje nietknięty', () => {
    mkdirSync(path.join(source, 'build'));
    writeFileSync(path.join(source, 'build', 'cudzy'), 'x');
    try {
      const run = runPackager(['--out', path.join(base, 'out-build')]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('already exists');
      expect(readFileSync(path.join(source, 'build', 'cudzy'), 'utf8')).toBe('x');
    } finally {
      rmSync(path.join(source, 'build'), { recursive: true, force: true });
    }
  }, RUN_TIMEOUT_MS);

  /*
   * Plik z listy kopii (`README.md`) albo katalog nad nim (`bin/`) jako dowiązanie poza drzewo
   * wciągał cudzą treść do tarballa jako zwykły plik.
   */
  it('dowiązanie w drzewie źródeł (plik z listy kopii albo katalog nad nim): kod 1, bez tarballa, bez `build/`', () => {
    const outside = mkdtempSync(path.join(base, 'poza-drzewem-'));
    writeFileSync(path.join(outside, 'prywatny.md'), 'nie do paczki\n');
    for (const rel of ['README.md', 'bin']) {
      const target = path.join(source, rel);
      const kept = path.join(outside, `oryginal-${rel}`);
      renameSync(target, kept);
      symlinkSync(rel === 'bin' ? kept : path.join(outside, 'prywatny.md'), target);
      try {
        const out = path.join(base, `out-link-${rel}`);
        const run = runPackager(['--out', out]);
        expect(run.code, rel).toBe(1);
        expect(run.stderr, rel).toContain(`symlink in the source tree: ${rel}`);
        expect(readdirSync(out), rel).toEqual([]);
        expect(existsSync(path.join(source, 'build')), rel).toBe(false);
      } finally {
        unlinkSync(target); // dowiązanie: `rmSync` na Node 24 odmawia przy dowiązaniu do katalogu
        renameSync(kept, target);
      }
    }
  }, RUN_TIMEOUT_MS);

  it('błąd przed materializacją (brak `TMPDIR`): `build/` znika, następny przebieg może ruszyć', () => {
    const run = runPackager(['--out', path.join(base, 'out-notmp')], { tmp: path.join(base, 'nie-ma-tmp') });
    expect(run.code).not.toBe(0);
    expect(existsSync(path.join(source, 'build'))).toBe(false);
  }, RUN_TIMEOUT_MS);

  it('`--out` w drzewie źródeł: kod 1; złe wywołanie: kod 64', () => {
    const inside = runPackager(['--out', path.join(source, 'dist-paczki')]);
    expect(inside.code).toBe(1);
    expect(inside.stderr).toContain('is inside the source tree');
    rmSync(path.join(source, 'dist-paczki'), { recursive: true, force: true });
    expect(runPackager(['--nieznana']).code).toBe(64);
    expect(runPackager(['--version', 'jutro']).code).toBe(64);
  }, RUN_TIMEOUT_MS);
});

describe('pakowacz sam w sobie', () => {
  it('importuje wyłącznie moduły `node:*` (w repo publicznym nie ma modułów warstwy prywatnej)', () => {
    const code = readFileSync(PACKAGER, 'utf8');
    const specifiers = [
      ...code.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gmu),
      ...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ].map((match) => match[1] ?? '');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((one) => !one.startsWith('node:'))).toEqual([]);
    expect(code, 'import bez `from`').not.toMatch(/^\s*import\s+['"]/mu);
  });

  it('`pnpm run package` woła pakowacz, a `build/` jest w `.gitignore`', () => {
    const root = readJson(path.join(REPO, 'package.json'));
    expect((root['scripts'] as Record<string, string>)['package']).toBe('node scripts/package.mjs');
    expect(readFileSync(path.join(REPO, '.gitignore'), 'utf8').split('\n')).toContain('/build/');
  });
});
