#!/usr/bin/env node
/**
 * Pakowacz paczki npm Raroga: `node scripts/package.mjs` (`pnpm run package`).
 *
 * Wejście to drzewo źródeł, w którym leży ten plik, po `pnpm install` (emisja bierze `typescript`
 * z devDependencies). Pakowacz nie wybiera plików według klasy: bierze całe drzewo, w którym stoi. Wyjście: tarball
 * `npm pack` i manifest budowania `<tarball bez .tgz>.build.json` w katalogu `--out`, który leży poza drzewem
 * wejścia (domyślnie nowy katalog w `os.tmpdir()`). Katalog roboczy `build/` w korzeniu drzewa pakowacz zakłada sam
 * (odmowa, gdy już istnieje) i usuwa na końcu, także po błędzie.
 *
 * Kroki:
 * 1. podział zależności produkcyjnych korzenia i `server/` na grupy: dołączane do tarballa (reszta), poza paczką
 *    ({@link OUTSIDE_PACKAGE}), tylko klon ({@link CLONE_ONLY}), z rejestru ({@link FROM_REGISTRY});
 * 2. emisja JavaScriptu `tsc -p tsconfig.package.json` do `build/` i sprawdzenie, że każdy plik `.ts` ma swój `.js`;
 * 3. kopia plików bez TypeScriptu ({@link COPY}, `server/src/install/*.json`); plik w `server/src` albo
 *    `shared/src` bez reguły pakowania to odmowa;
 * 4. `@rarog/shared` jako katalog `build/node_modules/@rarog/shared/` ze skompilowanym `src/` i własnym
 *    `package.json` (`exports` na `.js`);
 * 5. materializacja zależności w katalogu tymczasowym: `pnpm install --prod --frozen-lockfile
 *    --config.node-linker=hoisted --ignore-scripts` na kopii manifestów i lockfile'a, sklep pnpm drzewa wejścia;
 * 6. kopia domknięcia paczek dołączanych (reguły rozwiązywania Node) do `build/node_modules/`; dowiązanie, paczka
 *    z polem `os` albo `cpu` i licencja spoza {@link LICENSES} albo brak pliku licencji to odmowa;
 * 7. `build/package.json` i jego samosprawdzenie: grupy poza paczką i tylko klon nie stoją w żadnym polu zależności;
 * 8. `npm pack --json --ignore-scripts` z `build/` i sprawdzenie listy plików wobec `build/` i domknięcia.
 *
 * npm i pnpm dostają środowisko bez zmiennych `npm_*` wołającego (`pnpm run` wstawia tam swoje) i z pustym plikiem
 * w miejscu `~/.npmrc` użytkownika, więc wynik nie zależy od jego konfiguracji ani poświadczeń. Kody wyjścia:
 * 0 = zrobione, 1 = odmowa albo błąd narzędzia (zdanie na stderr), 64 = złe wywołanie. Importy wyłącznie `node:*`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 64;

/** SDK Anthropic: paczka go nie niesie i nie wymienia w żadnym polu zależności. */
const OUTSIDE_PACKAGE = ['@anthropic-ai/claude-agent-sdk'];
/** Zależności potrzebne tylko w klonie repo: tsx uruchamia tam TypeScript, paczka niesie JavaScript. */
const CLONE_ONLY = ['tsx'];
/** Zwykłe zależności paczki z rejestru, przypięte co do wersji: moduł natywny iroh wybiera paczkę platformy. */
const FROM_REGISTRY = ['@number0/iroh'];
const SHARED = '@rarog/shared';
/**
 * Package name without `--name`: `RAROG_PACKAGE_NAME` of `server/src/install/repair.ts`, not the root
 * `package.json` name (`rarog`, the private workspace root). A copy, because the packer imports only `node:*`;
 * `server/test/package-build.test.ts` checks the two are equal.
 */
const DEFAULT_NAME = '@rarog/server';
/** Licencje dołączanych paczek, które pakowacz przyjmuje (identyfikatory SPDX). */
const LICENSES = ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD'];
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/iu;
/** Pliki i katalogi bez TypeScriptu, które paczka niesie w tym samym miejscu co drzewo źródeł. */
const COPY = [
  'bin/rarog.mjs', 'scripts/hooks', 'scripts/restart.sh', 'server/src/cli/templates',
  'LICENSE', 'THIRD-PARTY-NOTICES', 'README.md',
];
/** Pliki, które pnpm czyta przy materializacji; `.npmrc` jest opcjonalny. */
const STAGE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'server/package.json',
  'shared/package.json'];
const EXACT = /^\d+\.\d+\.\d+$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u;
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies',
  'bundleDependencies'];
const MAX_OUTPUT = 256 * 1024 * 1024;

const USAGE = `Usage: node scripts/package.mjs [--out <dir>] [--version <version>] [--name <name>]
                                [--dry-run] [--json]
  --out <dir>          directory for the tarball and build manifest, outside the source tree
                       (default: a new one in ${os.tmpdir()})
  --version <version>  package version field (default: from the root package.json)
  --name <name>        package name field (default: ${DEFAULT_NAME})
  --dry-run            npm pack --dry-run: file list, no tarball or manifest on disk
  --json               build manifest on stdout as JSON
`;

/** Odmowa z jednym zdaniem dla człowieka (kod 1). */
class Refusal extends Error {}
/** Złe wywołanie (kod 64). */
class UsageError extends Error {}

function log(message) {
  process.stderr.write(`package.mjs: ${message}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        out: { type: 'string' },
        version: { type: 'string' },
        name: { type: 'string' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (failure) {
    throw new UsageError(failure instanceof Error ? failure.message : String(failure));
  }
  const { values } = parsed;
  if (values.version !== undefined && !VERSION.test(values.version)) {
    throw new UsageError(`--version ${values.version}: expected a semver version, e.g. 1.0.0 or 1.0.0-test.1`);
  }
  if (values.name !== undefined && (!NAME.test(values.name) || values.name.length > 214)) {
    throw new UsageError(`--name ${values.name}: not an npm package name`);
  }
  return {
    out: values.out,
    version: values.version,
    name: values.name,
    dryRun: values['dry-run'] === true,
    json: values.json === true,
    help: values.help === true,
  };
}

/** Środowisko npm i pnpm: bez `npm_*` wołającego, z pustym plikiem w miejscu `~/.npmrc`. */
function toolEnv(emptyConfig, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/iu.test(name)));
  return { ...env, npm_config_userconfig: emptyConfig, npm_config_update_notifier: 'false', ...extra };
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT, ...options });
  if (result.error !== undefined) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    throw new Refusal(code === 'ENOENT' ? `no ${command} in PATH` : `${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n');
    throw new Refusal(`${command} ${args.join(' ')} exited with code ${String(result.status)}:\n${output}`);
  }
  return result.stdout;
}

/** Pliki drzewa (ścieżki względne, `/`), bez dowiązań: dowiązanie to odmowa. */
function walk(dir, { skipTopNodeModules = false } = {}) {
  const files = [];
  const visit = (current, top) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Refusal(`symlink in the package tree: ${full}`);
      if (entry.isDirectory()) {
        if (top && skipTopNodeModules && entry.name === 'node_modules') continue;
        visit(full, false);
      } else if (entry.isFile()) {
        files.push(path.relative(dir, full).split(path.sep).join('/'));
      } else {
        throw new Refusal(`neither a file nor a directory: ${full}`);
      }
    }
  };
  visit(dir, true);
  return files;
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, fs.statSync(from).mode & 0o777);
}

function copyTree(from, to, options) {
  for (const rel of walk(from, options)) copyFile(path.join(from, rel), path.join(to, rel));
}

/** Krok 1: grupy zależności produkcyjnych. */
function dependencyGroups(rootPkg, serverPkg) {
  const prod = new Map();
  for (const [where, pkg] of [['package.json', rootPkg], ['server/package.json', serverPkg]]) {
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      const seen = prod.get(name);
      if (seen !== undefined && seen.spec !== spec) {
        throw new Refusal(`${name}: ${seen.where} wants ${seen.spec}, but ${where} ${spec}`);
      }
      prod.set(name, { spec, where, from: where === 'package.json' ? '.' : 'server' });
    }
  }
  for (const [list, label] of [[OUTSIDE_PACKAGE, 'outside the package'], [CLONE_ONLY, 'clone only'],
    [FROM_REGISTRY, 'from the registry']]) {
    for (const name of list) {
      if (!prod.has(name)) throw new Refusal(`list "${label}" names ${name}, which is not among the dependencies`);
    }
  }
  if (!/^workspace:/u.test(prod.get(SHARED)?.spec ?? '')) {
    throw new Refusal(`${SHARED} must be a workspace dependency in server/package.json`);
  }
  const registry = new Map();
  const included = new Map();
  for (const [name, entry] of prod) {
    if (name === SHARED || OUTSIDE_PACKAGE.includes(name) || CLONE_ONLY.includes(name)) continue;
    if (!EXACT.test(entry.spec)) {
      throw new Refusal(`${name}@${entry.spec} in ${entry.where}: the package takes exact versions only`);
    }
    (FROM_REGISTRY.includes(name) ? registry : included).set(name, entry);
  }
  return { registry, included };
}

/** Krok 2: emisja JavaScriptu i sprawdzenie, że każdy `.ts` ma swój `.js`. */
function emit() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Refusal(`no ${tsc}: run pnpm install in the source tree first`);
  run(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.package.json')], { cwd: ROOT });
  for (const dir of ['server/src', 'shared/src']) {
    for (const rel of walk(path.join(ROOT, dir))) {
      if (!rel.endsWith('.ts') || rel.endsWith('.d.ts')) continue;
      const js = path.join(BUILD, dir, rel.replace(/\.ts$/u, '.js'));
      if (!fs.existsSync(js)) throw new Refusal(`emit did not produce ${path.relative(ROOT, js)}`);
    }
  }
}

/**
 * Ścieżka w drzewie źródeł, w której ani cel, ani żaden katalog nad nim (do korzenia) nie jest dowiązaniem: `walk`
 * sprawdza wpisy wewnątrz katalogu, a ten krok sam cel i drogę do niego (`README.md` jako
 * dowiązanie do pliku spoza drzewa trafiał do tarballa jako zwykły plik).
 */
function sourcePath(rel) {
  let current = ROOT;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
      throw new Refusal(`symlink in the source tree: ${path.relative(ROOT, current)}`);
    }
  }
  return current;
}

/** Krok 3: pliki bez TypeScriptu; plik źródeł bez reguły pakowania to odmowa. */
function copyRuntimeFiles() {
  for (const dir of ['server/src', 'shared/src', 'server/src/install']) sourcePath(dir);
  for (const rel of COPY) {
    const from = sourcePath(rel);
    if (!fs.existsSync(from)) throw new Refusal(`no ${rel} in the source tree`);
    if (fs.lstatSync(from).isDirectory()) copyTree(from, path.join(BUILD, rel));
    else copyFile(from, path.join(BUILD, rel));
  }
  const installDir = 'server/src/install';
  for (const rel of walk(path.join(ROOT, installDir)).filter((file) => /^[^/]+\.json$/u.test(file))) {
    copyFile(path.join(ROOT, installDir, rel), path.join(BUILD, installDir, rel));
  }
  const ruled = (rel) => rel.endsWith('.ts') || rel.endsWith('.md')
    || COPY.some((entry) => rel === entry || rel.startsWith(`${entry}/`))
    || /^server\/src\/install\/[^/]+\.json$/u.test(rel)
    || /^shared\/src\/[^/]+\.(?:mjs|d\.mts)$/u.test(rel);
  for (const dir of ['server/src', 'shared/src']) {
    for (const rel of walk(path.join(ROOT, dir)).map((file) => `${dir}/${file}`)) {
      if (!ruled(rel)) throw new Refusal(`file without a packing rule: ${rel}`);
    }
  }
}

/** Krok 4: `@rarog/shared` jako dołączony katalog z `exports` na JavaScript. */
function sharedPackage(sharedPkg, rootPkg) {
  const target = path.join(BUILD, 'node_modules', '@rarog', 'shared');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(path.join(BUILD, 'shared'), target);
  for (const rel of walk(path.join(ROOT, 'shared/src')).filter((file) => /\.(?:mjs|d\.mts)$/u.test(file))) {
    copyFile(path.join(ROOT, 'shared/src', rel), path.join(target, 'src', rel));
  }
  copyFile(path.join(ROOT, 'LICENSE'), path.join(target, 'LICENSE'));
  const mapTarget = (value) => value.replace(/\.ts$/u, '.js');
  const exists = (value) => fs.existsSync(path.join(target, value));
  const exportsMap = {};
  for (const [key, value] of Object.entries(sharedPkg.exports ?? {})) {
    if (typeof value === 'string') {
      exportsMap[key] = mapTarget(value);
      continue;
    }
    exportsMap[key] = Object.fromEntries(Object.entries(value).map(([condition, file]) => [condition, mapTarget(file)])
      .filter(([, file]) => exists(file)));
  }
  for (const [key, value] of Object.entries(exportsMap)) {
    const files = typeof value === 'string' ? [value] : Object.values(value);
    if (files.length === 0 || !files.every(exists)) throw new Refusal(`${SHARED} exports["${key}"]: file missing`);
  }
  writeJson(path.join(target, 'package.json'), {
    name: SHARED,
    version: sharedPkg.version,
    private: true,
    license: sharedPkg.license ?? rootPkg.license,
    type: sharedPkg.type,
    exports: exportsMap,
    dependencies: sortedObject(Object.entries(sharedPkg.dependencies ?? {})),
  });
  return { version: sharedPkg.version, dependencies: Object.keys(sharedPkg.dependencies ?? {}) };
}

/** Krok 5: materializacja zależności produkcyjnych w katalogu tymczasowym. */
function materialize(stage, emptyConfig) {
  for (const rel of [...STAGE_FILES, '.npmrc']) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) {
      if (rel === '.npmrc') continue;
      throw new Refusal(`no ${rel} in the source tree`);
    }
    copyFile(from, path.join(stage, rel));
  }
  const env = toolEnv(emptyConfig);
  const storePath = run('pnpm', ['store', 'path'], { cwd: ROOT, env }).trim();
  const pnpmEnv = toolEnv(emptyConfig, { pnpm_config_store_dir: path.dirname(storePath) });
  run('pnpm', ['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted', '--ignore-scripts'],
    { cwd: stage, env: pnpmEnv });
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (typeof pkg.license?.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((one) => one?.type ?? '').join(' OR ');
  return null;
}

/** Wyrażenie SPDX z listy: jeden identyfikator albo alternatywa `OR`, w której któryś jest na liście. */
function licenseAllowed(expression) {
  const bare = expression.trim().replace(/^\((.*)\)$/u, '$1');
  if (/\s(?:AND|WITH)\s/u.test(bare)) return false;
  return bare.split(/\s+OR\s+/u).some((one) => LICENSES.includes(one.trim()));
}

/** Krok 6: domknięcie paczek dołączanych w materializacji, sprawdzenie i kopia do `build/node_modules/`. */
function includedClosure(stage, starts) {
  const stageModules = path.join(stage, 'node_modules');
  const resolve = (fromDir, name) => {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (dir === stage || !isInside(stage, dir)) return null;
    }
  };
  const closure = new Map();
  const queue = starts.map(({ name, from }) => ({ name, from: path.join(stage, from), optional: false, by: from }));
  while (queue.length > 0) {
    const { name, from, optional, by } = /** @type {NonNullable<ReturnType<typeof queue.shift>>} */ (queue.shift());
    const dir = resolve(from, name);
    if (dir === null) {
      if (optional) continue;
      throw new Refusal(`the materialized tree has no ${name} (required by ${by})`);
    }
    const rel = path.relative(stage, dir).split(path.sep).join('/');
    if (closure.has(rel)) continue;
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Refusal(`${rel} is a symlink, but the package carries copies`);
    if (!isInside(stageModules, dir)) throw new Refusal(`${rel} is outside node_modules of the materialization root`);
    const pkg = readJson(path.join(dir, 'package.json'));
    closure.set(rel, { name, dir, pkg });
    for (const [dep, optionalDep] of [
      ...Object.keys(pkg.dependencies ?? {}).map((dep) => [dep, false]),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((dep) => [dep, true]),
    ]) {
      queue.push({ name: dep, from: dir, optional: optionalDep, by: `${pkg.name}@${pkg.version}` });
    }
  }
  const problems = [];
  for (const { dir, pkg } of closure.values()) {
    const id = `${pkg.name}@${pkg.version}`;
    if ((pkg.os?.length ?? 0) > 0 || (pkg.cpu?.length ?? 0) > 0) problems.push(`${id}: platform package (os/cpu)`);
    const license = licenseOf(pkg);
    if (license === null || !licenseAllowed(license)) problems.push(`${id}: license ${license ?? 'none'} not on the list`);
    const hasFile = fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && LICENSE_FILE.test(e.name));
    if (!hasFile) problems.push(`${id}: no license file`);
    if (OUTSIDE_PACKAGE.includes(pkg.name) || CLONE_ONLY.includes(pkg.name) || FROM_REGISTRY.includes(pkg.name)) {
      problems.push(`${id}: dependency of an included package, but on the outside the package, clone only or from the registry list`);
    }
  }
  if (problems.length > 0) throw new Refusal(`included packages:\n  ${problems.join('\n  ')}`);
  for (const [rel, { dir }] of closure) copyTree(dir, path.join(BUILD, rel), { skipTopNodeModules: true });
  return [...closure].map(([rel, { pkg }]) => ({ path: rel, name: pkg.name, version: pkg.version,
    license: licenseOf(pkg) })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Krok 7: `build/package.json` i jego samosprawdzenie. */
function packageManifest(rootPkg, options, groups, shared, stage) {
  if (rootPkg.repository === undefined) throw new Refusal('the root package.json has no repository field');
  const dependencies = [];
  for (const [name, entry] of groups.included) {
    const installed = readJson(path.join(stage, 'node_modules', name, 'package.json')).version;
    if (installed !== entry.spec) throw new Refusal(`${name}: ${entry.where} wants ${entry.spec}, the lockfile gave ${installed}`);
    dependencies.push([name, entry.spec]);
  }
  for (const [name, entry] of groups.registry) dependencies.push([name, entry.spec]);
  dependencies.push([SHARED, shared.version]);
  // Registry page fields (description, search keywords, links) come from the root package.json as they are.
  const metadata = Object.fromEntries(['description', 'keywords', 'homepage', 'bugs']
    .filter((field) => rootPkg[field] !== undefined).map((field) => [field, rootPkg[field]]));
  const manifest = {
    name: options.name ?? DEFAULT_NAME,
    version: options.version ?? rootPkg.version,
    ...metadata,
    license: rootPkg.license,
    type: rootPkg.type,
    bin: rootPkg.bin,
    engines: rootPkg.engines,
    os: ['darwin', 'linux'],
    repository: rootPkg.repository,
    dependencies: sortedObject(dependencies),
    bundleDependencies: [...groups.included.keys(), SHARED].sort(),
    publishConfig: { access: 'public' },
  };
  const forbidden = [...OUTSIDE_PACKAGE, ...CLONE_ONLY];
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    const names = Array.isArray(value) ? value : Object.keys(value ?? {});
    for (const name of names) {
      if (forbidden.includes(name)) throw new Refusal(`the package manifest names ${name} in ${field}`);
    }
  }
  for (const name of manifest.bundleDependencies) {
    if (FROM_REGISTRY.includes(name)) throw new Refusal(`${name} from the registry is on the included list`);
    if (!(name in manifest.dependencies)) throw new Refusal(`${name} is included but not in dependencies`);
  }
  for (const name of [...forbidden, ...FROM_REGISTRY]) {
    if (fs.existsSync(path.join(BUILD, 'node_modules', name))) throw new Refusal(`build/node_modules/${name} exists`);
  }
  writeJson(path.join(BUILD, 'package.json'), manifest);
  return manifest;
}

/** Krok 8: `npm pack` i sprawdzenie listy plików. */
function pack(out, dryRun, emptyConfig, cache, closure) {
  const args = ['pack', '--json', '--ignore-scripts', ...(dryRun ? ['--dry-run'] : ['--pack-destination', out])];
  const stdout = run('npm', args, { cwd: BUILD, env: toolEnv(emptyConfig, { npm_config_cache: cache }) });
  const [result] = JSON.parse(stdout);
  const listed = result.files.map((file) => file.path).sort();
  const own = walk(BUILD, { skipTopNodeModules: true }).sort();
  const ownListed = listed.filter((file) => !file.startsWith('node_modules/'));
  const missing = own.filter((file) => !ownListed.includes(file));
  const extra = ownListed.filter((file) => !own.includes(file));
  if (missing.length > 0 || extra.length > 0) {
    throw new Refusal(`npm pack took other files than build/: missing ${missing.join(', ') || '—'}, extra ${
      extra.join(', ') || '—'}`);
  }
  const packages = [...closure.map((one) => one.path), `node_modules/${SHARED}`];
  for (const file of listed.filter((one) => one.startsWith('node_modules/'))) {
    if (!packages.some((one) => file.startsWith(`${one}/`))) throw new Refusal(`npm pack took ${file} from outside the closure`);
  }
  const names = new Set([...closure.map((one) => one.name), SHARED]);
  const reported = new Set(result.bundled ?? []);
  const lost = [...names].filter((name) => !reported.has(name));
  if (lost.length > 0) throw new Refusal(`npm pack did not include: ${lost.join(', ')}`);
  return { result, listed };
}

function npmVersion(emptyConfig, cache) {
  return run('npm', ['--version'], { cwd: ROOT, env: toolEnv(emptyConfig, { npm_config_cache: cache }) }).trim();
}

function build(options) {
  const rootPkg = readJson(path.join(ROOT, 'package.json'));
  const serverPkg = readJson(path.join(ROOT, 'server', 'package.json'));
  const sharedPkg = readJson(path.join(ROOT, 'shared', 'package.json'));
  const groups = dependencyGroups(rootPkg, serverPkg);
  if (!options.dryRun && options.out !== undefined) {
    const wanted = path.resolve(options.out);
    fs.mkdirSync(wanted, { recursive: true });
    if (isInside(fs.realpathSync(ROOT), fs.realpathSync(wanted))) {
      throw new Refusal(`--out ${wanted} is inside the source tree; the tarball goes outside it`);
    }
  }
  try {
    fs.mkdirSync(BUILD);
  } catch (failure) {
    if (/** @type {NodeJS.ErrnoException} */ (failure).code === 'EEXIST') {
      throw new Refusal(`${BUILD} already exists: left over from another build; remove it and run again`);
    }
    throw failure;
  }
  /** Katalog wyjścia: `null` przy `--dry-run`, nowy katalog tymczasowy bez `--out`. */
  let out = null;
  /** Katalog roboczy (pusty `npmrc`, cache npm, materializacja); `null`, dopóki nie powstał. */
  let work = null;
  /** Pliki wyjścia tego przebiegu: po błędzie znikają, żeby tarball bez manifestu nie udawał wyniku. */
  const written = [];
  let done = false;
  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'rarog-package-work-'));
    if (!options.dryRun) {
      out = options.out === undefined
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'rarog-package-'))
        : path.resolve(options.out);
    }
    const emptyConfig = path.join(work, 'empty-npmrc');
    const cache = path.join(work, 'npm-cache');
    const stage = path.join(work, 'stage');
    fs.writeFileSync(emptyConfig, '');
    log('emitting JavaScript (tsc -p tsconfig.package.json)');
    emit();
    copyRuntimeFiles();
    const shared = sharedPackage(sharedPkg, rootPkg);
    log('materializing dependencies (pnpm install --prod, node-linker=hoisted)');
    materialize(stage, emptyConfig);
    const starts = [
      ...[...groups.included].map(([name, entry]) => ({ name, from: entry.from })),
      ...shared.dependencies.map((name) => ({ name, from: 'shared' })),
    ];
    const closure = includedClosure(stage, starts);
    const manifest = packageManifest(rootPkg, options, groups, shared, stage);
    const base = `${manifest.name.replace(/^@/u, '').replace('/', '-')}-${manifest.version}`;
    const tarballPath = out === null ? null : path.join(out, `${base}.tgz`);
    const buildManifestPath = out === null ? null : path.join(out, `${base}.build.json`);
    for (const file of [tarballPath, buildManifestPath]) {
      if (file !== null && fs.existsSync(file)) throw new Refusal(`${file} already exists; the packager does not overwrite it`);
    }
    log(out === null ? 'npm pack --dry-run' : `npm pack to ${out}`);
    if (tarballPath !== null) written.push(tarballPath);
    const { result, listed } = pack(out, options.dryRun, emptyConfig, cache, closure);
    if (tarballPath !== null && path.basename(tarballPath) !== result.filename) {
      written.push(path.join(out ?? '', result.filename));
      throw new Refusal(`npm pack named the tarball ${result.filename}, but the packager expected ${path.basename(tarballPath)}`);
    }
    const files = listed.map((file) => ({
      path: file,
      size: fs.statSync(path.join(BUILD, file)).size,
      sha256: sha256(path.join(BUILD, file)),
    }));
    const record = {
      name: manifest.name,
      version: manifest.version,
      tarball: tarballPath === null ? null : result.filename,
      sha256: tarballPath === null ? null : sha256(tarballPath),
      integrity: result.integrity,
      size: result.size,
      unpackedSize: result.unpackedSize,
      entryCount: result.entryCount,
      tools: {
        node: process.version,
        npm: npmVersion(emptyConfig, cache),
        pnpm: run('pnpm', ['--version'], { cwd: ROOT, env: toolEnv(emptyConfig) }).trim(),
        typescript: readJson(path.join(ROOT, 'node_modules', 'typescript', 'package.json')).version,
      },
      dependencies: manifest.dependencies,
      bundleDependencies: manifest.bundleDependencies,
      packages: closure,
      files,
    };
    if (buildManifestPath !== null) {
      written.push(buildManifestPath);
      writeJson(buildManifestPath, record);
    }
    done = true;
    return { record, tarballPath, buildManifestPath, out };
  } finally {
    if (work !== null) fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(BUILD, { recursive: true, force: true });
    if (!done) for (const file of written) fs.rmSync(file, { force: true });
    if (!done && out !== null && options.out === undefined) fs.rmSync(out, { recursive: true, force: true });
  }
}

function main(argv) {
  let options;
  try {
    options = parseCli(argv);
  } catch (failure) {
    process.stderr.write(`package.mjs: ${failure instanceof Error ? failure.message : String(failure)}\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  try {
    const { record, tarballPath, buildManifestPath } = build(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else if (options.dryRun) {
      process.stdout.write(`${record.name}@${record.version}: ${String(record.files.length)} files,`
        + ` ${String(record.packages.length + 1)} included packages (npm pack --dry-run, no tarball)\n`);
    } else {
      process.stdout.write(`tarball:  ${tarballPath}\nsha256:   ${String(record.sha256)}\nmanifest: ${buildManifestPath}\n`
        + `files: ${String(record.files.length)}, included packages: ${String(record.packages.length + 1)}\n`);
    }
    return EXIT_OK;
  } catch (failure) {
    if (failure instanceof Refusal) {
      process.stderr.write(`package.mjs: refused: ${failure.message}\n`);
      return EXIT_REFUSED;
    }
    throw failure;
  }
}

process.exitCode = main(process.argv.slice(2));
