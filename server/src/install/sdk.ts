/**
 * SDK Claude (`@anthropic-ai/claude-agent-sdk`) dla listy sesji: przypięcie, katalog w katalogu danych, pobranie,
 * sonda i ładowanie przy starcie serwera. Jedyny moduł `server/src` z nazwą pakietu w pozycji wartości; z pakietu
 * bierze wyłącznie `listSessions` (strażnik `server/test/sdk-boundary.test.ts`).
 *
 * Klon repo: pakiet z workspace (pnpm), import po nazwie. Paczka npm Raroga SDK nie niesie, niesie przypięcie
 * (`sdk-package.json`, `sdk-lock.json`, generuje je `scripts/sdk-lock.mjs`): `rarog setup` pobiera tę wersję
 * z rejestru npm do `<katalog danych>/sdk/<wersja>/` ({@link installSdk}), a serwer importuje ją po jawnej ścieżce
 * ({@link importSdkFrom}). Bez `createRequire().resolve`: resolver szuka też w katalogach nadrzędnych i przy
 * uszkodzonym lokalnym `node_modules` przyjąłby cudzą kopię.
 *
 * Moduł importuje wyłącznie `node:*`, swój katalog i (dynamicznie, w klonie) sam pakiet SDK.
 */
import { execFile, spawn } from 'node:child_process';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVIDENCE } from './evidence.ts';
import { INSTALL_MODE, INSTALL_ROOT } from './mode.ts';
import type { InstallMode } from './mode.ts';

/** Nazwa pakietu SDK. */
export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** Funkcja listy sesji z pakietu (typ wymazywany przy emisji). */
export type ListSessionsFn = typeof import('@anthropic-ai/claude-agent-sdk').listSessions;

/** Licencja pakietu (`LICENSE.md` paczki): pytanie `rarog setup` ją podaje. */
export const SDK_TERMS_URL = 'https://code.claude.com/docs/en/legal-and-compliance';

const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

// ---------------------------------------------------------------------------
// Przypięcie
// ---------------------------------------------------------------------------

/** Przypięcie SDK trybu paczki: wersja i teksty obu plików, które `setup` kładzie przed `npm ci`. */
export interface SdkPin {
  readonly version: string;
  /** `sdk-package.json`, zapisywany jako `package.json`. */
  readonly packageJson: string;
  /** `sdk-lock.json`, zapisywany jako `package-lock.json`. */
  readonly lockJson: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Wersja SDK z `sdk-package.json` i `sdk-lock.json`; różne albo nie `x.y.z` = błąd (obie pilnuje `sdk-pin.test.ts`). */
export function parseSdkPin(packageJson: string, lockJson: string): SdkPin {
  const manifest: unknown = JSON.parse(packageJson);
  const lock: unknown = JSON.parse(lockJson);
  const deps = isRecord(manifest) ? manifest['dependencies'] : undefined;
  const version = isRecord(deps) ? deps[SDK_PACKAGE] : undefined;
  const packages = isRecord(lock) ? lock['packages'] : undefined;
  const entry = isRecord(packages) ? packages[`node_modules/${SDK_PACKAGE}`] : undefined;
  const locked = isRecord(entry) ? entry['version'] : undefined;
  if (typeof version !== 'string' || !EXACT_VERSION.test(version) || locked !== version) {
    throw new Error(`SDK pin: sdk-package.json (${String(version)}) and sdk-lock.json (${String(locked)})`
      + ' must have the same x.y.z version (node scripts/sdk-lock.mjs)');
  }
  return { version, packageJson, lockJson };
}

let pinned: SdkPin | null = null;

/** Przypięcie z plików obok tego modułu, czytane raz na proces. */
export function readSdkPin(): SdkPin {
  pinned ??= parseSdkPin(
    readFileSync(new URL('./sdk-package.json', import.meta.url), 'utf8'),
    readFileSync(new URL('./sdk-lock.json', import.meta.url), 'utf8'),
  );
  return pinned;
}

// ---------------------------------------------------------------------------
// Katalogi
// ---------------------------------------------------------------------------

/** Podkatalog SDK w katalogu danych. */
export const SDK_DIRNAME = 'sdk';
/** Prefiks katalogu roboczego pobrania (`<katalog danych>/sdk/.tmp-*`). */
export const SDK_TMP_PREFIX = '.tmp-';
/** Prawa katalogów SDK: jak katalog danych. */
export const SDK_DIR_MODE = 0o700;
const PACKAGE_SUBDIR = path.join('node_modules', ...SDK_PACKAGE.split('/'));

export function sdkRoot(dataDir: string): string {
  return path.join(dataDir, SDK_DIRNAME);
}

export function sdkVersionDir(dataDir: string, version: string): string {
  return path.join(sdkRoot(dataDir), version);
}

function errnoCode(failure: unknown): string {
  return isRecord(failure) && typeof failure['code'] === 'string' ? failure['code'] : 'error';
}

/** Prawdziwy katalog tego użytkownika z prawami {@link SDK_DIR_MODE}; napis = powód odmowy, `null` = w porządku. */
export function sdkDirIssue(dir: string): string | null {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (failure) {
    return `${dir}: ${errnoCode(failure)}`;
  }
  if (!stats.isDirectory()) return `${dir}: expected a directory (symlinks and other types are rejected)`;
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    return `${dir}: owned by uid ${String(stats.uid)}, not by the user of this process`;
  }
  if ((stats.mode & 0o777) !== SDK_DIR_MODE) {
    return `${dir}: mode ${(stats.mode & 0o777).toString(8)}, required ${SDK_DIR_MODE.toString(8)}`
      + ` (chmod ${SDK_DIR_MODE.toString(8)} '${dir}')`;
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Wersje `x.y.z` w `<katalog danych>/sdk/`, od najnowszej; brak katalogu = pusta lista. */
export function sdkVersions(dataDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(sdkRoot(dataDir));
  } catch {
    return [];
  }
  return names.filter((name) => EXACT_VERSION.test(name)).sort(compareVersions).reverse();
}

/** Suma rozmiarów zwykłych plików pod katalogiem (bez wchodzenia w dowiązania). */
export function treeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() ?? '';
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      continue;
    }
    if (stats.isFile()) total += stats.size;
    if (!stats.isDirectory()) continue;
    try {
      for (const name of readdirSync(current)) stack.push(path.join(current, name));
    } catch {
      // Nieczytelny podkatalog: rozmiar bez niego.
    }
  }
  return total;
}

/** Katalog roboczy pobrania zostawiony przez inny (albo przerwany) `setup`. */
export interface SdkTempDir {
  readonly dir: string;
  readonly ageMs: number;
  readonly bytes: number;
}

/** Katalogi `.tmp-*` w `<katalog danych>/sdk/` z wiekiem (od `mtime`) i rozmiarem. */
export function sdkTempDirs(dataDir: string, now = Date.now()): SdkTempDir[] {
  let names: string[];
  try {
    names = readdirSync(sdkRoot(dataDir));
  } catch {
    return [];
  }
  return names.filter((name) => name.startsWith(SDK_TMP_PREFIX)).flatMap((name) => {
    const dir = path.join(sdkRoot(dataDir), name);
    try {
      return [{ dir, ageMs: Math.max(0, now - lstatSync(dir).mtimeMs), bytes: treeBytes(dir) }];
    } catch {
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// Import po jawnej ścieżce i sonda
// ---------------------------------------------------------------------------

/** Ścieżka po `realpath`, która musi leżeć w `base` (też po `realpath`). */
function inside(base: string, file: string): string {
  const real = realpathSync(file);
  if (!real.startsWith(`${base}${path.sep}`)) throw new Error(`${file} leads outside ${base} (${real})`);
  return real;
}

/** Wejście modułu z `exports['.']` (napis albo warunek `import`, `node`, `default`) albo `main`. */
function entryOf(manifest: Record<string, unknown>): string {
  const exportsField = manifest['exports'];
  const dot = isRecord(exportsField) ? exportsField['.'] : exportsField;
  if (typeof dot === 'string') return dot;
  if (isRecord(dot)) {
    for (const condition of ['import', 'node', 'default']) {
      const value = dot[condition];
      if (typeof value === 'string') return value;
      if (isRecord(value) && typeof value['default'] === 'string') return value['default'];
    }
  }
  const main = manifest['main'];
  if (typeof main === 'string') return main;
  throw new Error('SDK package.json has no entry point (neither exports["."] nor main)');
}

/**
 * `listSessions` z `<katalog wersji>/node_modules/@anthropic-ai/claude-agent-sdk`: `package.json` z nazwą i wersją
 * równą `version`, wejście z `exports` albo `main`, oba po `realpath` w katalogu wersji, potem `import()`.
 */
export async function importSdkFrom(versionDir: string, version: string): Promise<ListSessionsFn> {
  const base = realpathSync(versionDir);
  const pkgDir = path.join(base, PACKAGE_SUBDIR);
  const manifest: unknown = JSON.parse(readFileSync(inside(base, path.join(pkgDir, 'package.json')), 'utf8'));
  if (!isRecord(manifest) || manifest['name'] !== SDK_PACKAGE || manifest['version'] !== version) {
    const found = isRecord(manifest) ? `${String(manifest['name'])} ${String(manifest['version'])}` : '?';
    throw new Error(`${pkgDir}: expected ${SDK_PACKAGE} ${version}, found ${found}`);
  }
  const file = inside(base, path.join(pkgDir, entryOf(manifest)));
  const loaded: unknown = await import(pathToFileURL(file).href);
  const fn = isRecord(loaded) ? loaded['listSessions'] : undefined;
  if (typeof fn !== 'function') throw new Error(`${file}: no listSessions function`);
  return fn as ListSessionsFn;
}

/** Sufit sondy `listSessions` na pustym katalogu. */
export const SDK_PROBE_TIMEOUT_MS = 30_000;
/** Prefiks linii wyniku procesu sondy (`sdk-probe.ts`) na stdout. */
export const SDK_PROBE_PREFIX = 'sdk-probe: ';

/** Wynik sondy; `reason` to zdanie dla człowieka. */
export type SdkProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * `listSessions({ dir: <pusty katalog tymczasowy>, limit: 1 })` z limitem czasu: tablica = działa. Magazynu sesji nie
 * czyta (katalog bez sesji), więc nie zależy od tego, co użytkownik ma w `~/.claude`.
 */
export async function probeListSessions(
  listSessions: ListSessionsFn, timeoutMs = SDK_PROBE_TIMEOUT_MS,
): Promise<SdkProbeResult> {
  let empty: string;
  try {
    empty = mkdtempSync(path.join(os.tmpdir(), 'rarog-sdk-probe-'));
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    return { ok: false, reason: `probe directory in ${os.tmpdir()}: ${message}` };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const clock = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { resolve('timeout'); }, timeoutMs);
    });
    const result = await Promise.race([
      listSessions({ dir: empty, limit: 1, includeProgrammatic: false, includeWorktrees: false }),
      clock,
    ]);
    if (result === 'timeout') return { ok: false, reason: `listSessions did not finish within ${String(timeoutMs)} ms` };
    return Array.isArray(result) ? { ok: true } : { ok: false, reason: 'listSessions did not return an array' };
  } catch (failure) {
    return { ok: false, reason: `listSessions: ${failure instanceof Error ? failure.message : String(failure)}` };
  } finally {
    clearTimeout(timer);
    try {
      rmSync(empty, { recursive: true, force: true });
    } catch {
      // Pusty katalog sondy zostaje w katalogu tymczasowym; wynik sondy o SDK jest ważniejszy niż to sprzątanie.
    }
  }
}

const PROBE_ENTRIES = {
  clone: 'server/src/install/sdk-probe.ts',
  package: 'server/src/install/sdk-probe.js',
} as const satisfies Record<InstallMode, string>;

/** Komenda procesu sondy: w paczce węzeł i wejście `.js`, w klonie węzeł z `--import tsx` i wejście `.ts`. */
export function sdkProbeCommand(mode: InstallMode, node: string): string[] {
  const entry = PROBE_ENTRIES[mode];
  return mode === 'package' ? [node, entry] : [node, '--import', 'tsx', entry];
}

/** Sonda katalogu wersji w osobnym procesie (podmieniają ją testy). */
export type SdkDirProbe = (versionDir: string, version: string) => Promise<SdkProbeResult>;

/**
 * Sonda katalogu wersji w osobnym procesie (`sdk-probe.ts`): import po jawnej ścieżce i {@link probeListSessions},
 * potem `process.exit` (moduł może zostawić otwarty uchwyt). `env` = środowisko usługi; `cwd` = korzeń instalacji.
 */
export function probeSdkDir(
  versionDir: string, version: string, env: Readonly<Record<string, string | undefined>>,
  command: readonly string[] = sdkProbeCommand(INSTALL_MODE, process.execPath),
): Promise<SdkProbeResult> {
  const [file = process.execPath, ...args] = command;
  return new Promise((resolve) => {
    execFile(file, [...args, versionDir, version], {
      cwd: INSTALL_ROOT, env, encoding: 'utf8', timeout: SDK_PROBE_TIMEOUT_MS + 10_000, killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    }, (failure, stdout, stderr) => {
      const said = stdout.split('\n').find((line) => line.startsWith(SDK_PROBE_PREFIX));
      if (said !== undefined) {
        try {
          const parsed: unknown = JSON.parse(said.slice(SDK_PROBE_PREFIX.length));
          if (isRecord(parsed) && parsed['ok'] === true && failure === null) {
            resolve({ ok: true });
            return;
          }
          if (isRecord(parsed) && typeof parsed['reason'] === 'string') {
            resolve({ ok: false, reason: parsed['reason'] });
            return;
          }
        } catch {
          // Linia bez JSON: niżej jak każda inna porażka procesu.
        }
      }
      const how = failure === null ? 'returned no result'
        : failure.killed ? 'did not finish within the time limit'
          : `exited with code ${String((failure as { code?: unknown }).code ?? '?')}`;
      const last = stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
      resolve({ ok: false, reason: `SDK probe ${how}${last === '' ? '' : `: ${last}`}` });
    });
  });
}

/**
 * Sonda katalogu wersji po sprawdzeniu `sdk/` i katalogu wersji tak jak przy starcie serwera ({@link sdkDirIssue}):
 * kodu z katalogu z obcym właścicielem, złymi prawami albo dowiązaniem sonda nie uruchamia (`rarog doctor`).
 */
export async function probeCheckedSdkDir(
  dataDir: string, version: string, probe: SdkDirProbe,
): Promise<SdkProbeResult> {
  const dir = sdkVersionDir(dataDir, version);
  const issue = sdkDirIssue(sdkRoot(dataDir)) ?? sdkDirIssue(dir);
  if (issue !== null) return { ok: false, reason: `directory rejected, probe not run: ${issue}` };
  return probe(dir, version);
}

// ---------------------------------------------------------------------------
// Pobranie (`rarog setup`)
// ---------------------------------------------------------------------------

/** Flagi `npm ci` pobrania (pomiar: {@link EVIDENCE}`.sdkInstall`). */
export const NPM_CI_ARGS: readonly string[] = ['ci', ...EVIDENCE.sdkInstall.flags];

/**
 * Sufit `npm ci`. Wartość tymczasowa: czas pobrania na wolnym łączu nie jest zmierzony; pobranie przerwane limitem
 * nie zostawia katalogu z wersją, więc powtórzenie `rarog setup` zaczyna od zera.
 */
export const NPM_CI_TIMEOUT_MS = 300_000;

/**
 * Zmienne `npm_config_*` przekazywane do `npm ci`: rejestr, cache, pliki konfiguracji, proxy i certyfikaty. Reszta
 * zmiennych `npm_*` wołającego (np. `include`, `global`, `prefix` ustawione przez `npm exec` albo skrypt) nie
 * przechodzi; pliki `.npmrc` użytkownika npm czyta sam.
 */
export const NPM_CONFIG_ALLOWED: readonly string[] = [
  'registry', 'cache', 'userconfig', 'globalconfig', 'proxy', 'https-proxy', 'noproxy', 'cafile', 'ca', 'strict-ssl',
  'fetch-retries', 'fetch-retry-factor', 'fetch-retry-mintimeout', 'fetch-retry-maxtimeout', 'fetch-timeout',
  'maxsockets', 'offline', 'prefer-offline',
];

/**
 * The npm release age gate (`min-release-age`, `before`, `min-release-age-exclude`): `rarog update` passes these
 * `npm_config_*` on, so a gate set in the environment holds its `npm i -g` as a gate in `.npmrc` does. The SDK
 * `npm ci` installs the versions its lockfile pins and does not take them.
 */
export const NPM_AGE_GATE_CONFIG: readonly string[] = ['min-release-age', 'before', 'min-release-age-exclude'];

/**
 * Environment of an npm call: everything but `npm_*`, and of `npm_config_*` only the keys in
 * {@link NPM_CONFIG_ALLOWED} and in `extra` (npm's key form, `min-release-age`; the variable in any case, `_` or `-`).
 */
export function npmEnv(
  env: Readonly<Record<string, string | undefined>>, extra: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^npm_/iu.test(name)) {
      const config = /^npm_config_(.+)$/iu.exec(name)?.[1]?.toLowerCase().replaceAll('_', '-');
      if (config === undefined || !(NPM_CONFIG_ALLOWED.includes(config) || extra.includes(config))) continue;
    }
    result[name] = value;
  }
  return result;
}

/** `npm-cli.js` obok węzła (`<katalog węzła>/npm` po `realpath`); napis w `failure` = powód. */
export function npmCliOf(execPath = process.execPath): { readonly file: string } | { readonly failure: string } {
  const candidate = path.join(path.dirname(execPath), 'npm');
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (failure) {
    return { failure: `no npm next to node ${execPath} (${candidate}: ${errnoCode(failure)})` };
  }
  if (path.basename(real) !== EVIDENCE.npmCli.file) {
    return { failure: `${candidate} leads to ${real}, not to ${EVIDENCE.npmCli.file} of the npm package` };
  }
  return { file: real };
}

/** Paczki w `node_modules` katalogu (z zakresami, bez wpisów z kropką). */
export function installedPackages(dir: string): string[] {
  const modules = path.join(dir, 'node_modules');
  const names: string[] = [];
  for (const name of readdirSync(modules)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      for (const inner of readdirSync(path.join(modules, name))) names.push(`${name}/${inner}`);
    } else {
      names.push(name);
    }
  }
  return names.sort();
}

/** Pierwsza linia błędu npm (`npm error …`, `npm ERR! …`), inaczej pierwsza niepusta. */
export function firstNpmError(stderr: string): string {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return (lines.find((line) => /^npm (?:error|ERR!) /u.test(line)) ?? lines[0] ?? '').slice(0, 300);
}

export interface SdkInstallOptions {
  readonly dataDir: string;
  /** Środowisko wołającego: z niego rejestr, proxy i cache npm (filtr {@link npmEnv}). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Sonda pobranego katalogu przed `rename` (domyślnie {@link probeSdkDir} ze środowiskiem `env`). */
  readonly probe?: SdkDirProbe;
  readonly pin?: SdkPin;
  readonly execPath?: string;
  /** `npm-cli.js`; domyślnie {@link npmCliOf}. */
  readonly npmCli?: string;
  readonly timeoutMs?: number;
  /**
   * Registers the interrupt function of `npm ci` with the caller's Ctrl-C handling and returns the function that
   * removes it (`rarog setup`: `trackChild` from `cli/child-output.ts`). After an interrupt `npm ci` stops, the work
   * directory is removed and the result says `interrupted`.
   */
  readonly trackChild?: (interrupt: () => void) => () => void;
}

export type SdkInstallResult =
  | { readonly ok: true; readonly dir: string; readonly raced: boolean }
  /**
   * `interrupted`: Ctrl-C stopped `npm ci`; the work directory is already removed. `noNpm`: the node of this process
   * has no npm next to it (a node from `pnpm env use` has none), so a retry fails the same way until another node runs.
   */
  | { readonly ok: false; readonly reason: string; readonly interrupted?: true; readonly noNpm?: true };

function runNpm(
  execPath: string, npmCli: string, cwd: string, env: Record<string, string>, timeoutMs: number,
  track: SdkInstallOptions['trackChild'],
): Promise<{
  readonly code: number | null; readonly timedOut: boolean; readonly interrupted: boolean; readonly stderr: string;
  readonly error?: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(execPath, [npmCli, ...NPM_CI_ARGS], { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    // Ctrl-C through the caller: SIGTERM first, SIGKILL on the second one; the cleanup below runs before the exit.
    const untrack = track?.(() => {
      child.kill(interrupted ? 'SIGKILL' : 'SIGTERM');
      interrupted = true;
    });
    child.on('error', (failure) => {
      clearTimeout(timer);
      untrack?.();
      resolve({ code: null, timedOut, interrupted, stderr, error: failure.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      untrack?.();
      resolve({ code, timedOut, interrupted, stderr });
    });
  });
}

/** Katalog `dir` z prawami {@link SDK_DIR_MODE}, gdy go brak (rodzice z tymi samymi prawami); istniejący sprawdzony. */
function ensureSdkDir(dir: string): string | null {
  try {
    mkdirSync(dir, { mode: SDK_DIR_MODE });
    chmodSync(dir, SDK_DIR_MODE);
  } catch (failure) {
    if (errnoCode(failure) !== 'EEXIST') return `${dir}: ${errnoCode(failure)}`;
  }
  return sdkDirIssue(dir);
}

/**
 * Pobranie przypiętego SDK do `<katalog danych>/sdk/<wersja>/`: oba pliki przypięcia do własnego `.tmp-*`, `npm ci`
 * węzłem tego procesu ({@link NPM_CI_ARGS}, limit czasu), dokładnie jedna paczka w `node_modules` z przypiętą
 * wersją, sonda w osobnym procesie, `rename`. Katalog z wersją istnieje wyłącznie po kompletnym przebiegu; każda
 * porażka usuwa własny `.tmp-*`. `rename` na zajęty katalog (`EEXIST`, `ENOTEMPTY`) = inny `setup` był pierwszy:
 * wynik `ok` z `raced`.
 */
export async function installSdk(options: SdkInstallOptions): Promise<SdkInstallResult> {
  const pin = options.pin ?? readSdkPin();
  const execPath = options.execPath ?? process.execPath;
  let npmCli = options.npmCli;
  if (npmCli === undefined) {
    const found = npmCliOf(execPath);
    if ('failure' in found) return { ok: false, reason: found.failure, noNpm: true };
    npmCli = found.file;
  }
  try {
    mkdirSync(options.dataDir, { recursive: true, mode: SDK_DIR_MODE });
  } catch (failure) {
    return { ok: false, reason: `${options.dataDir}: ${errnoCode(failure)}` };
  }
  const root = sdkRoot(options.dataDir);
  const rootIssue = ensureSdkDir(root);
  if (rootIssue !== null) return { ok: false, reason: rootIssue };
  const target = sdkVersionDir(options.dataDir, pin.version);
  const work = mkdtempSync(path.join(root, SDK_TMP_PREFIX));
  let keep = false;
  try {
    writeFileSync(path.join(work, 'package.json'), pin.packageJson, { mode: 0o600 });
    writeFileSync(path.join(work, 'package-lock.json'), pin.lockJson, { mode: 0o600 });
    const timeoutMs = options.timeoutMs ?? NPM_CI_TIMEOUT_MS;
    const run = await runNpm(execPath, npmCli, work, npmEnv(options.env), timeoutMs, options.trackChild);
    if (run.interrupted) return { ok: false, reason: 'npm ci was interrupted (Ctrl-C)', interrupted: true };
    if (run.timedOut) return { ok: false, reason: `npm ci did not finish within ${String(timeoutMs / 1000)} s` };
    if (run.error !== undefined) return { ok: false, reason: `npm ci: ${run.error}` };
    if (run.code !== 0) {
      const said = firstNpmError(run.stderr);
      return { ok: false, reason: `npm ci: exited with code ${String(run.code)}${said === '' ? '' : ` (${said})`}` };
    }
    let packages: string[];
    try {
      packages = installedPackages(work);
    } catch (failure) {
      return { ok: false, reason: `no node_modules after npm ci (${errnoCode(failure)})` };
    }
    if (packages.length !== 1 || packages[0] !== SDK_PACKAGE) {
      return { ok: false, reason: `after npm ci node_modules has ${String(packages.length)} packages (${packages.join(', ')}),`
        + ` expected only ${SDK_PACKAGE}` };
    }
    const probe = options.probe ?? ((dir, version) => probeSdkDir(dir, version, options.env));
    const probed = await probe(work, pin.version);
    if (!probed.ok) return { ok: false, reason: probed.reason };
    try {
      renameSync(work, target);
      keep = true;
      return { ok: true, dir: target, raced: false };
    } catch (failure) {
      const code = errnoCode(failure);
      if (code === 'EEXIST' || code === 'ENOTEMPTY') return { ok: true, dir: target, raced: true };
      return { ok: false, reason: `rename ${work} → ${target}: ${code}` };
    }
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Start serwera
// ---------------------------------------------------------------------------

/**
 * Stan SDK w `/health`: `ok` — przypięta wersja działa; `stale` — przypiętej brak, działa najnowsza inna
 * z `<katalog danych>/sdk/`; `missing` — żadnej; `error` — import albo sonda nie przeszły.
 */
export type SdkState = 'ok' | 'stale' | 'missing' | 'error';

export interface SdkStatus {
  readonly state: SdkState;
  /** Wersja przypięta tej instalacji. */
  readonly pinned: string;
  /** Wersja załadowana (`ok`, `stale`) albo ta, której import padł (`error`); `null` przy `missing`. */
  readonly version: string | null;
  /** Katalog wersji albo `workspace` (klon); `null` przy `missing`. */
  readonly source: string | null;
  /** Powód przy `error`. */
  readonly detail: string | null;
}

export interface LoadedSdk {
  readonly status: SdkStatus;
  /** Funkcja listy sesji; `null` przy `missing` i `error`. */
  readonly listSessions: ListSessionsFn | null;
}

export interface LoadSdkOptions {
  readonly dataDir: string;
  readonly mode?: InstallMode;
  readonly pin?: SdkPin;
  readonly probeTimeoutMs?: number;
  /** Import z katalogu wersji (testy); domyślnie {@link importSdkFrom}. */
  readonly importFrom?: (versionDir: string, version: string) => Promise<ListSessionsFn>;
  /** Import z workspace (testy); domyślnie `import()` pakietu po nazwie. */
  readonly importWorkspace?: () => Promise<unknown>;
}

/** Wybór katalogu SDK przy starcie: przypięta wersja, najnowsza inna, żadna. */
export function pickSdkVersion(dataDir: string, pinnedVersion: string):
  { readonly version: string; readonly state: 'ok' | 'stale' } | null {
  const versions = sdkVersions(dataDir);
  if (versions.includes(pinnedVersion)) return { version: pinnedVersion, state: 'ok' };
  const newest = versions[0];
  return newest === undefined ? null : { version: newest, state: 'stale' };
}

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

/**
 * SDK dla procesu serwera, raz przy starcie (przed `listen()`), z przypięciem odczytanym raz: stary proces po
 * aktualizacji Raroga nie wczyta nowego przypięcia. Klon: pakiet z workspace. Paczka: katalog z
 * {@link pickSdkVersion}, katalog sprawdzony jak katalog danych, import po jawnej ścieżce. Potem sonda na pustym
 * katalogu. Nigdy nie rzuca: każdy problem to stan w {@link SdkStatus}, a serwer startuje bez listy sesji.
 */
export async function loadListSessions(options: LoadSdkOptions): Promise<LoadedSdk> {
  const mode = options.mode ?? INSTALL_MODE;
  let pin: SdkPin;
  try {
    pin = options.pin ?? readSdkPin();
  } catch (failure) {
    return {
      status: { state: 'error', pinned: '?', version: null, source: null, detail: messageOf(failure) },
      listSessions: null,
    };
  }
  let version = pin.version;
  let source = 'workspace';
  let state: 'ok' | 'stale' = 'ok';
  let fn: ListSessionsFn;
  try {
    if (mode === 'clone') {
      const loaded = await (options.importWorkspace ?? (() => import('@anthropic-ai/claude-agent-sdk')))();
      const candidate = isRecord(loaded) ? loaded['listSessions'] : undefined;
      if (typeof candidate !== 'function') throw new Error(`${SDK_PACKAGE}: no listSessions function`);
      fn = candidate as ListSessionsFn;
    } else {
      const picked = pickSdkVersion(options.dataDir, pin.version);
      if (picked === null) {
        return {
          status: { state: 'missing', pinned: pin.version, version: null, source: null, detail: null },
          listSessions: null,
        };
      }
      ({ version, state } = picked);
      source = sdkVersionDir(options.dataDir, version);
      const issue = sdkDirIssue(sdkRoot(options.dataDir)) ?? sdkDirIssue(source);
      if (issue !== null) throw new Error(issue);
      fn = await (options.importFrom ?? importSdkFrom)(source, version);
    }
  } catch (failure) {
    return {
      status: { state: 'error', pinned: pin.version, version, source, detail: messageOf(failure) },
      listSessions: null,
    };
  }
  const probed = await probeListSessions(fn, options.probeTimeoutMs);
  if (!probed.ok) {
    return { status: { state: 'error', pinned: pin.version, version, source, detail: probed.reason }, listSessions: null };
  }
  return { status: { state, pinned: pin.version, version, source, detail: null }, listSessions: fn };
}

/** Linia logu startu serwera o SDK. */
export function sdkLogLine(status: SdkStatus): string {
  switch (status.state) {
    case 'ok':
      return `sdk: ok (${SDK_PACKAGE} ${status.pinned}, ${String(status.source)})`;
    case 'stale':
      return `sdk: stale — the pinned ${status.pinned} is not downloaded, ${String(status.version)} runs`
        + ` (${String(status.source)}); run rarog setup`;
    case 'missing':
      return `sdk: missing — ${SDK_PACKAGE} ${status.pinned} is not downloaded; the session list stays empty until you`
        + ' run rarog setup';
    default:
      return `sdk: error — ${String(status.detail)}; the session list stays empty`;
  }
}

// ---------------------------------------------------------------------------
// Sprawdzenie w komendach (`serve --check`, `restart`, `service install`)
// ---------------------------------------------------------------------------

/** Wynik sprawdzenia SDK: linia raportu albo zdanie odmowy z komendą naprawy. */
export type SdkCheck = { readonly ok: true; readonly line: string } | { readonly ok: false; readonly message: string };

export interface SdkCheckOptions {
  readonly dataDir: string;
  readonly demo: boolean;
  /** Katalog danych spoza reguły (`--data-dir`, `RAROG_DATA_DIR`): komenda naprawy dostaje go flagą. */
  readonly dataDirFlag: string | null;
  readonly probe: SdkDirProbe;
  readonly mode?: InstallMode;
  readonly pin?: SdkPin;
}

/**
 * Przypięty SDK w katalogu danych, ściśle: w paczce brak `<katalog danych>/sdk/<wersja>/`, katalog z obcym
 * właścicielem, prawami albo dowiązaniem i nieudana sonda to odmowa z pełną ścieżką i komendą `rarog setup`.
 * Klon repo bierze SDK z workspace, demo go nie ładuje.
 */
export async function checkPinnedSdk(options: SdkCheckOptions): Promise<SdkCheck> {
  const mode = options.mode ?? INSTALL_MODE;
  if (options.demo) return { ok: true, line: 'SDK: not required (demo)' };
  const pin = options.pin ?? readSdkPin();
  if (mode === 'clone') return { ok: true, line: `SDK: from the workspace (${SDK_PACKAGE} ${pin.version})` };
  const dir = sdkVersionDir(options.dataDir, pin.version);
  const setup = options.dataDirFlag === null ? 'rarog setup' : `rarog setup --data-dir '${options.dataDirFlag}'`;
  try {
    lstatSync(dir);
  } catch (failure) {
    if (errnoCode(failure) === 'ENOENT') {
      return { ok: false, message: `SDK ${pin.version} is not downloaded in ${dir}; run ${setup}.` };
    }
    return { ok: false, message: `${dir}: ${errnoCode(failure)}` };
  }
  const issue = sdkDirIssue(sdkRoot(options.dataDir)) ?? sdkDirIssue(dir);
  if (issue !== null) return { ok: false, message: issue };
  const probed = await options.probe(dir, pin.version);
  if (!probed.ok) return { ok: false, message: `SDK ${pin.version} in ${dir} does not work (${probed.reason}).` };
  return { ok: true, line: `SDK: ${pin.version} (${dir})` };
}
