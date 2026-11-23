/**
 * `rarog serve`: składa środowisko serwera z pliku konfiguracji,
 * sekretów i flag, a potem ZAMIENIA swój proces w serwer ({@link serverExec}, `cwd` = korzeń instalacji).
 * W klonie repo `process.execve` idzie na `<repo>/node_modules/.bin/tsx` z `server/src/index.ts`: dwa procesy
 * (`cli.mjs …` i `loader.mjs …`). W paczce npm idzie na węzeł tego procesu z `server/src/index.js`: jeden proces
 * (`node …`). Wszystkich trzech szukają wzorce stopu `restart.sh`.
 *
 * Środowisko serwera to WYŁĄCZNIE nazwy z rejestru `server/src/config-env.ts`, z czterech źródeł:
 * - `~/.config/rarog/config.json` (`{"version": 1, "env": {…}, "service": {"wrapper": […]}}`): tylko nazwy rodzaju
 *   `plain`, wartości napisami; nieznany klucz, sekret, zmienna katalogu danych albo systemowa = odmowa z nazwą;
 * - plik sekretów `~/.config/rarog/secret/private.env` (0600 w katalogu 0700, właściciel = użytkownik procesu,
 *   linie `NAZWA=wartość`): tylko nazwy rodzaju `secret`; inne prawa = odmowa;
 * - środowisko rodzica, z którego przechodzą dokładnie trzy grupy: sześć przepustek systemowych
 *   (`HOME`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `TMPDIR`, z wartościami domyślnymi z {@link SERVE_PASSTHROUGH}),
 *   sekrety oraz zmienne katalogu danych (rodzaj `process`, także puste). `TERM` NIE przechodzi:
 *   serwer go nie dostaje, a `tailnetEnv` podstawia wtedy `dumb`;
 * - flagi: `--port`, `--data-dir`, `--env NAZWA=wartość` (tylko rodzaj `plain`: sekret w argv widać w `ps`).
 * Pierwszeństwo: flagi > rodzic > plik sekretów > `config.json` > domyślne `config.ts`. `PATH` liczony, nie
 * dziedziczony: katalog węzła tego procesu + `/usr/bin:/bin:/usr/sbin:/sbin` + `/opt/homebrew/bin` na macOS, gdy
 * istnieje (pod launchd to dokładnie dzisiejszy `PATH` serwera).
 *
 * `--print-env` wypisuje złożone środowisko (sekrety jako `<set>`/`<unset>`), `--check` sprawdza je bez startu
 * na dwóch poziomach: bez sekretów (u właściciela dostarcza je dopiero `service.wrapper`) linia mówi „secrets:
 * not checked”, a `loadConfig` sprawdza resztę; z sekretami `loadConfig` widzi prawdziwe środowisko,
 * a `apnsIssue`/`pushRelayIssue` wychodzą jako ostrzeżenia (zdania serwera, same nazwy zmiennych). Klucz iroh przy
 * `RAROG_IROH=1`: bez sekretów przy wrapperze linia „iroh key: not checked”, inaczej brak klucza = odmowa.
 * Moduł natywny iroh `--check` ładuje naprawdę (`loadIroh()`), ale endpointu nie otwiera i portu UDP
 * nie wiąże: próba biegnie w osobnym krótkim procesie (`iroh/module-probe.ts`) na środowisku serwera, także
 * w `rarog restart` przed zatrzymaniem działającej usługi, która trzyma ten port.
 *
 * Magazyn urządzeń nowszego formatu ({@link assertDevicesFormat}): `--check` i start odmawiają, zanim serwer
 * dotknie `devices.json` (w zwykłym demo `devices.demo.json`) albo jego `.bak` — powrót do starszej wersji nie kasuje
 * parowań. Pod launchd odmowa
 * powtarza się przy każdym starcie usługi, jak przy błędnym `config.json`.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devicesFileName, devicesFormatMessage, newerDevicesFormat } from '../auth/devices-store.ts';
import type { DeviceStoreMode } from '../auth/devices-store.ts';
import { ConfigError, loadConfig } from '../config.ts';
import { skippedOriginLine } from '../config/listen.ts';
import { IROH_ENV, IROH_KEY_ENV, SERVER_ENV, WITHDRAWN_ENV_NAMES, registryNameOf } from '../config-env.ts';
import { INSTALL_MODE, INSTALL_ROOT } from '../install/mode.ts';
import type { InstallMode } from '../install/mode.ts';
import { REPAIR } from '../install/repair.ts';
import { checkPinnedSdk, probeSdkDir } from '../install/sdk.ts';
import type { SdkCheck } from '../install/sdk.ts';
import { IROH_PACKAGE, IROH_PROBE_PREFIX, irohModuleInfo, irohPlatform } from '../iroh/adapter.ts';
import { readRegularFileSync } from '../safe-read.ts';
import type { ServerEnvKind, ServerEnvName, ServerPassthroughName } from '../config-env.ts';
import { EXIT_OK, EXIT_REFUSED, Refusal, Usage, err, homeOf, out } from './io.ts';
import type { CliIo } from './io.ts';
import { usageFor } from './screen/prose.ts';

export const SERVE_USAGE = `  rarog serve [--port <port>] [--data-dir <dir>] [--env NAME=value]… [--print-env | --check]
      Starts the server with the environment from ~/.config/rarog (config.json and the secrets file) and from
      flags; the rarog process turns into the server. --print-env prints the environment (secrets as
      <set>/<unset>), --check checks it without starting.`;

/** Wersja formatu `config.json`; inna = odmowa (zmiana formatu to nowa wersja i migracja w CLI). */
export const CONFIG_VERSION = 1;
export const CONFIG_FILENAME = 'config.json';

/**
 * The layout `rarog setup` writes `config.json` in: two-space JSON and a final LF. One definition, because a command
 * that edits the file rewrites only a file in exactly this layout.
 */
export const configFileText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const SECRET_DIRNAME = 'secret';
export const PRIVATE_ENV_FILENAME = 'private.env';

/** Katalog konfiguracji CLI: `<HOME>/.config/rarog` (`HOME` z podanego środowiska, inaczej katalog domowy). */
export function rarogConfigDir(env: NodeJS.ProcessEnv): string {
  return path.join(homeOf(env), '.config', 'rarog');
}

/** Rodzaj nazwy w rejestrze albo `undefined` (także dla nazw z prototypu obiektu). */
function kindOf(name: string): ServerEnvKind | undefined {
  const registry = registryNameOf(name);
  return registry === undefined ? undefined : SERVER_ENV[registry];
}

/** Wartości pod nazwami rejestru. Nazwa spoza rejestru = {@link Refusal} (walidacja źródła odmawia już wcześniej). */
function registryEnv(values: Readonly<Record<string, string>>, where: string): Partial<Record<ServerEnvName, string>> {
  const out: Partial<Record<ServerEnvName, string>> = {};
  for (const [given, value] of Object.entries(values)) {
    const registry = registryNameOf(given);
    if (registry === undefined) throw new Refusal(`${given} in ${where}: name outside the server variable registry.`);
    out[registry] = value;
  }
  return out;
}

function namesOfKind(kind: ServerEnvKind): ServerEnvName[] {
  return (Object.keys(SERVER_ENV) as ServerEnvName[]).filter((name) => SERVER_ENV[name] === kind);
}

/** Sekrety z rejestru (`SONIOX_API_KEY`, klucz APNs: ścieżka i id, klucz iroh). */
export const SECRET_NAMES: readonly ServerEnvName[] = namesOfKind('secret');
/**
 * Zmienne katalogu danych (rodzaj `process`): tylko ze środowiska procesu albo z `--data-dir`. Tyle sprawdzają odmowy
 * „zmienna katalogu danych ustawiona w powłoce albo w domenie usługi”.
 */
export const PROCESS_NAMES: readonly ServerEnvName[] = namesOfKind('process');
const DATA_DIR_NAME: ServerEnvName = 'RAROG_DATA_DIR';
const PORT_NAME: ServerEnvName = 'RAROG_PORT';
const EPOCH_NAME: ServerEnvName = 'RAROG_AUTH_EPOCH';

/**
 * Przepustki systemowe ze środowiska rodzica — jawna lista, bez `PATH` (liczony) i bez `TERM` (nie przechodzi).
 * Pusta albo brak = wartość domyślna.
 */
export const SERVE_PASSTHROUGH: readonly { readonly name: ServerPassthroughName; readonly fallback: () => string }[] = [
  { name: 'HOME', fallback: () => os.homedir() },
  { name: 'SHELL', fallback: () => '/bin/zsh' },
  { name: 'USER', fallback: () => '' },
  { name: 'LOGNAME', fallback: () => '' },
  { name: 'LANG', fallback: () => 'en_US.UTF-8' },
  { name: 'TMPDIR', fallback: () => '' },
];

/**
 * Linia `--check`, gdy sekrety ma dać `service.wrapper`, a nie ma żadnego. `service install` szuka jej w wyjściu
 * sprawdzenia PRZEZ wrapper: tam znaczy, że wrapper nie dostarczył ani jednego sekretu.
 */
export const SECRETS_UNCHECKED_LINE = 'secrets: not checked (supplied by service.wrapper)';

/**
 * Linia `--check` przy `RAROG_IROH=1` bez klucza iroh, gdy sekrety ma dać `service.wrapper`, a w środowisku nie ma
 * żadnego (wstępne sprawdzenie). Z sekretami albo bez wrappera brak klucza to odmowa; start serwera bez
 * klucza też odmawia (`index.ts`).
 */
export const IROH_KEY_UNCHECKED_LINE = 'iroh key: not checked (supplied by service.wrapper)';

/**
 * Etykiety linii `--check` `<etykieta>: <wartość>` z katalogiem danych i portem przy zielonym sprawdzeniu.
 * `service install` czyta obie z wyjścia pełnego sprawdzenia przez `service.wrapper` (`checkValue` w `service.ts`),
 * więc drukuje i czyta je ta sama stała.
 */
export const CHECK_DATA_DIR_LABEL = 'data directory';
export const CHECK_PORT_LABEL = 'port';

/** Dlaczego nazwy nie wolno w `config.json` albo w `--env` (`where` mówi, gdzie stała). */
function forbiddenReason(name: string, where: string): string | null {
  const kind = kindOf(name);
  if (kind === undefined) {
    return `${name} in ${where}: name outside the server variable registry (server/src/config-env.ts).`;
  }
  if (kind === 'secret') {
    return `${name} in ${where}: this is a secret; it comes from the environment (service.wrapper) or from the`
      + ` secrets file ${path.join('~/.config/rarog', SECRET_DIRNAME, PRIVATE_ENV_FILENAME)}, never from ${where}.`;
  }
  if (kind === 'process') {
    return `${name} in ${where}: the data directory comes from the process environment (the hook in Claude`
      + ' sessions computes it the same way); pass an explicit directory with --data-dir.';
  }
  if (kind === 'passthrough') {
    return `${name} in ${where}: system variable; rarog serve takes it from the process environment or computes`
      + ' it (PATH); TERM does not reach the server.';
  }
  return null;
}

/** `config.json` po walidacji. */
export interface RarogConfig {
  readonly file: string;
  /** Zmienne pod nazwami rejestru. */
  readonly env: Readonly<Partial<Record<ServerEnvName, string>>>;
  /** Przedrostek `ProgramArguments` usługi (np. wrapper menedżera sekretów); `null` = brak. */
  readonly wrapper: readonly string[] | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const errnoCode = (failure: unknown): string =>
  (isRecord(failure) && typeof failure['code'] === 'string' ? failure['code'] : 'read error');

/** Sufit pliku konfiguracji i pliku sekretów: oba to kilkadziesiąt linii. */
export const MAX_FILE_BYTES = 64 * 1024;

/**
 * Tekst pliku zwykłego przez `safe-read.ts` (O_NONBLOCK, `fstat` na deskryptorze, sufit): FIFO albo urządzenie pod
 * nazwą pliku to odmowa, a nie zawieszony `rarog serve`. Brak pliku = `null`.
 */
function readTextFile(file: string, followSymlink: boolean): string | null {
  let read: ReturnType<typeof readRegularFileSync>;
  try {
    read = readRegularFileSync(file, { maxBytes: MAX_FILE_BYTES, followSymlink });
  } catch (failure) {
    if (errnoCode(failure) === 'ENOENT') return null;
    throw new Refusal(`Cannot read ${file} (${errnoCode(failure)}).`);
  }
  if (read === null) throw new Refusal(`${file}: not a regular file.`);
  if (read.truncated) throw new Refusal(`${file}: file larger than ${String(MAX_FILE_BYTES)} B.`);
  return read.bytes.toString('utf8');
}

/**
 * Odczyt i walidacja `config.json` (za dowiązaniem: plik bywa dowiązaniem do repo z konfiguracją Maca).
 * Brak pliku = `null`; każdy inny problem = {@link Refusal} z nazwą klucza.
 */
export function readRarogConfig(env: NodeJS.ProcessEnv): RarogConfig | null {
  const file = path.join(rarogConfigDir(env), CONFIG_FILENAME);
  const text = readTextFile(file, true);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Bez komunikatu `JSON.parse`: V8 cytuje w nim fragment wejścia, a tym fragmentem może być sekret
    // wpisany przez pomyłkę do `config.json` (odmowa sekretu przychodzi dopiero po parsowaniu).
    throw new Refusal(`${file}: not valid JSON (check it, e.g. \`jq . '${file}'\`).`);
  }
  if (!isRecord(parsed)) throw new Refusal(`${file}: expected a JSON object.`);
  for (const key of Object.keys(parsed)) {
    if (key !== 'version' && key !== 'env' && key !== 'service') {
      throw new Refusal(`${file}: unknown key "${key}" (known: version, env, service).`);
    }
  }
  if (parsed['version'] !== CONFIG_VERSION) {
    throw new Refusal(`${file}: version ${JSON.stringify(parsed['version']) ?? 'missing'}; this rarog version knows`
      + ` only ${String(CONFIG_VERSION)}.`);
  }
  const rawEnv = parsed['env'] ?? {};
  if (!isRecord(rawEnv)) throw new Refusal(`${file}: env must be an object NAME → string.`);
  const given: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawEnv)) {
    // A withdrawn name: an older file keeps starting, the server never sees the value.
    if (WITHDRAWN_ENV_NAMES.includes(name)) continue;
    const reason = forbiddenReason(name, CONFIG_FILENAME);
    if (reason !== null) throw new Refusal(`${file}: ${reason}`);
    if (typeof value !== 'string') throw new Refusal(`${file}: env.${name} must be a string.`);
    given[name] = value;
  }
  const envOut = registryEnv(given, CONFIG_FILENAME);
  let wrapper: readonly string[] | null = null;
  const service = parsed['service'];
  if (service !== undefined) {
    if (!isRecord(service)) throw new Refusal(`${file}: service must be an object.`);
    for (const key of Object.keys(service)) {
      if (key !== 'wrapper') throw new Refusal(`${file}: unknown key "service.${key}" (known: wrapper).`);
    }
    const raw = service['wrapper'];
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every((part) => typeof part === 'string' && part !== '')) {
        throw new Refusal(`${file}: service.wrapper must be a non-empty list of non-empty strings.`);
      }
      wrapper = raw as string[];
    }
  }
  return { file, env: envOut, wrapper };
}

/** Plik sekretów po walidacji: wartości tylko nazw rodzaju `secret`; brak pliku = pusty wynik. */
export interface PrivateEnv {
  readonly file: string;
  readonly present: boolean;
  /** Sekrety pod nazwami rejestru. */
  readonly values: Readonly<Partial<Record<ServerEnvName, string>>>;
}

/** Prawa i właściciel wpisu (`lstat`: dowiązanie nie jest ani katalogiem, ani plikiem). */
export function checkEntry(target: string, kind: 'dir' | 'file', mode: number): void {
  const stats = lstatSync(target);
  const ok = kind === 'dir' ? stats.isDirectory() : stats.isFile();
  if (!ok) {
    throw new Refusal(`${target}: expected a ${kind === 'dir' ? 'directory' : 'regular file'} (symlinks and other`
      + ' types are rejected).');
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Refusal(`${target}: owned by uid ${String(stats.uid)}, not by the user of this process.`);
  }
  if ((stats.mode & 0o777) !== mode) {
    throw new Refusal(`${target}: mode ${(stats.mode & 0o777).toString(8)}, required ${mode.toString(8)}`
      + ` (chmod ${mode.toString(8)} '${target}').`);
  }
}

/**
 * Odczyt pliku sekretów. Komunikaty błędów podają numer linii i — tylko dla nazw z rejestru — nazwę; nigdy treść
 * linii, bo w źle sformatowanej linii może stać sama wartość.
 */
export function readPrivateEnv(env: NodeJS.ProcessEnv): PrivateEnv {
  const dir = path.join(rarogConfigDir(env), SECRET_DIRNAME);
  const file = path.join(dir, PRIVATE_ENV_FILENAME);
  try {
    lstatSync(file);
  } catch (failure) {
    if (errnoCode(failure) === 'ENOENT') return { file, present: false, values: {} };
    throw new Refusal(`Cannot read ${file} (${errnoCode(failure)}).`);
  }
  checkEntry(dir, 'dir', 0o700);
  checkEntry(file, 'file', 0o600);
  const given = parsePrivateEnv(readTextFile(file, false) ?? '', file);
  return { file, present: true, values: registryEnv(given, PRIVATE_ENV_FILENAME) };
}

/**
 * Parser treści pliku sekretów (`file` tylko do zdań odmów): wartości pod podanymi nazwami, każda to sekret
 * z rejestru. Ten sam parser sprawdza nową treść `rarog dictation set-key` przed zapisem. Odmowy jak
 * w {@link readPrivateEnv}: numer linii, nigdy jej treść.
 */
export function parsePrivateEnv(text: string, file: string): Record<string, string> {
  const given: Record<string, string> = {};
  const lines = text.split('\n');
  lines.forEach((rawLine, index) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const at = `${file}, line ${String(index + 1)}`;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Refusal(`${at}: expected NAME=value.`);
    const name = line.slice(0, eq).trim();
    const kind = kindOf(name);
    if (kind === undefined) throw new Refusal(`${at}: name outside the server secret registry.`);
    if (kind !== 'secret') throw new Refusal(`${at}: ${name} is not a secret; it belongs in config.json.`);
    if (Object.hasOwn(given, name)) throw new Refusal(`${at}: ${name} appears twice.`);
    given[name] = line.slice(eq + 1);
  });
  return given;
}

/** `PATH` serwera: katalog węzła tego procesu + systemowe + homebrew na macOS, gdy istnieje; bez powtórzeń. */
export function servePath(
  execPath: string = process.execPath, platform: NodeJS.Platform = process.platform,
  exists: (dir: string) => boolean = existsSync,
): string {
  const parts = [path.dirname(execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  if (platform === 'darwin' && exists('/opt/homebrew/bin')) parts.push('/opt/homebrew/bin');
  return [...new Set(parts)].join(':');
}

/** Flagi `rarog serve`. */
export interface ServeFlags {
  readonly port?: string;
  readonly dataDir?: string;
  /** `--env` z wywołania (nazwy rejestru). */
  readonly env: Readonly<Record<string, string>>;
  readonly mode: 'start' | 'print-env' | 'check';
}

/** Parser flag; `argv` zaczyna się od `serve`. Złe wywołanie = {@link Usage}. */
export function parseServeFlags(argv: readonly string[], cwd: string): ServeFlags {
  let port: string | undefined;
  let dataDir: string | undefined;
  let mode: ServeFlags['mode'] = 'start';
  const env: Record<string, string> = {};
  const value = (i: number, flag: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Usage(`${flag} requires a value.`);
    return next;
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--port') {
      const raw = value(i, arg);
      if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
        throw new Usage(`--port: expected a port number 1–65535 (got: ${raw}).`);
      }
      if (port !== undefined) throw new Usage('--port given twice.');
      port = String(Number(raw));
      i += 1;
    } else if (arg === '--data-dir') {
      const raw = value(i, arg);
      if (dataDir !== undefined) throw new Usage('--data-dir given twice.');
      dataDir = path.resolve(cwd, raw);
      i += 1;
    } else if (arg === '--env') {
      const raw = value(i, arg);
      const eq = raw.indexOf('=');
      if (eq <= 0) throw new Usage('--env: expected NAME=value.');
      const name = raw.slice(0, eq);
      // A withdrawn name is accepted and dropped, as in `config.json`.
      if (!WITHDRAWN_ENV_NAMES.includes(name)) {
        // Nazwa sekretu w argv to już za dużo: wartość obok widać w `ps` — odmowa bez powtarzania wartości.
        const reason = forbiddenReason(name, '--env');
        if (reason !== null) throw new Usage(reason);
        if (Object.hasOwn(env, name)) throw new Usage(`--env ${name} given twice.`);
        env[name] = raw.slice(eq + 1);
      }
      i += 1;
    } else if (arg === '--print-env' || arg === '--check') {
      const next = arg === '--print-env' ? 'print-env' : 'check';
      if (mode !== 'start' && mode !== next) throw new Usage('--print-env and --check are mutually exclusive.');
      mode = next;
    } else {
      throw new Usage(`Unknown rarog serve option: ${arg}`);
    }
  }
  if (port !== undefined && Object.hasOwn(env, PORT_NAME)) {
    throw new Usage(`--port and --env ${PORT_NAME} cannot be used together.`);
  }
  return { ...(port !== undefined ? { port } : {}), ...(dataDir !== undefined ? { dataDir } : {}), env, mode };
}

/** Złożone środowisko serwera i to, skąd przyszło. */
export interface ServeEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly config: RarogConfig | null;
  readonly privateEnv: PrivateEnv;
  /** Choć jeden sekret niepusty (z rodzica albo z pliku sekretów). */
  readonly hasSecrets: boolean;
  /** Konfiguracja albo choć jedna flaga środowiska — bez tego `rarog serve` odmawia. */
  readonly configured: boolean;
  /** Skąd epoka uwierzytelnienia: nazwa zmiennej, pod którą przyszła, albo `null` = wartość domyślna. */
  readonly epochFrom: string | null;
}

/**
 * Składa środowisko serwera. `parent` to środowisko procesu `rarog`; czytane są z niego
 * wyłącznie przepustki, sekrety i zmienne katalogu danych.
 */
export function buildServeEnv(parent: NodeJS.ProcessEnv, flags: ServeFlags): ServeEnv {
  const config = readRarogConfig(parent);
  const privateEnv = readPrivateEnv(parent);
  const fromFlags = registryEnv(flags.env, '--env');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(config?.env ?? {})) env[name] = value;
  for (const { name, fallback } of SERVE_PASSTHROUGH) {
    const value = parent[name];
    env[name] = value !== undefined && value !== '' ? value : fallback();
  }
  env['PATH'] = servePath();
  // Sekret z rodzica wygrywa, gdy NAZWA jest w środowisku, także pusta: pusta wartość z wrappera nie może po cichu
  // wziąć starej wartości z pliku.
  for (const name of SECRET_NAMES) {
    const fromParent = parent[name];
    env[name] = fromParent !== undefined ? fromParent : (privateEnv.values[name] ?? '');
  }
  for (const name of PROCESS_NAMES) env[name] = parent[name] ?? '';
  for (const [name, value] of Object.entries(fromFlags)) env[name] = value;
  if (flags.port !== undefined) env[PORT_NAME] = flags.port;
  if (flags.dataDir !== undefined) env[DATA_DIR_NAME] = flags.dataDir;
  // Znaku NUL nie przeniesie `execve` (ERR_INVALID_ARG_VALUE dopiero przy starcie), więc `--check` i `restart`
  // odmawiają już tutaj; komunikat ma samą nazwę, bo wartością może być sekret z pliku.
  for (const [name, value] of Object.entries(env)) {
    if (value.includes('\0')) throw new Refusal(`${name}: the value contains a NUL character; fix it at the source.`);
  }
  const hasSecrets = SECRET_NAMES.some((name) => env[name] !== '');
  const configured = config !== null || flags.port !== undefined || flags.dataDir !== undefined
    || Object.keys(flags.env).length > 0;
  const epochFrom = env[EPOCH_NAME] === undefined || env[EPOCH_NAME] === '' ? null : EPOCH_NAME;
  return { env, config, privateEnv, hasSecrets, configured, epochFrom };
}

/** `NAZWA=wartość` posortowane; sekrety jako `<set>`/`<unset>`. */
export function printableEnv(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).sort().map((name) => {
    const value = env[name] ?? '';
    if (kindOf(name) === 'secret') return `${name}=${value === '' ? '<unset>' : '<set>'}`;
    return `${name}=${value}`;
  });
}

/**
 * Wynik `--check`: przy zielonym port i katalog danych z `loadConfig` (`rarog restart` podaje je `restart.sh`).
 * `irohKeyUnchecked` = linia {@link IROH_KEY_UNCHECKED_LINE}: klucz iroh widać dopiero pod `service.wrapper`, więc
 * `rarog restart` sprawdza go tam, zanim cokolwiek zatrzyma.
 */
export type ServeCheck =
  | { readonly ok: true; readonly port: number; readonly dataDir: string; readonly irohKeyUnchecked: boolean }
  | { readonly ok: false };

/**
 * `--check`: raport na stdout, błąd konfiguracji na stderr. `loadConfig` dostaje złożone
 * środowisko (plik, rejestr, wartości, katalog danych); bez sekretów i z `service.wrapper` linia mówi, że sekretów
 * nie sprawdzono, a z sekretami dochodzą ostrzeżenia `apnsIssue`/`pushRelayIssue`. A skipped `RAROG_ORIGINS`
 * entry is a warning line in every case (`config/listen.ts`). Przy `RAROG_IROH=1` moduł
 * natywny iroh ładuje się naprawdę ({@link checkIrohModule}); niezaładowany = odmowa. W paczce npm przypięty SDK
 * Claude musi leżeć w katalogu danych i przejść sondę ({@link checkServeSdk}); brak = odmowa z pełną ścieżką
 * i komendą `rarog setup`. `probe` i `sdk` podmieniają testy.
 */
export async function checkServeEnv(
  built: ServeEnv, io: CliIo, label = 'rarog serve --check', probe: IrohProbe = probeIrohModule,
  sdk: ServeSdkCheck = checkServeSdk,
): Promise<ServeCheck> {
  const { config, privateEnv } = built;
  out(io, config === null
    ? 'config: no config.json, flags only'
    : `config: ${config.file} (version ${String(CONFIG_VERSION)}, ${String(Object.keys(config.env).length)}`
      + ` variables${config.wrapper === null ? '' : ', service.wrapper'})`);
  out(io, privateEnv.present
    ? `secrets file: ${privateEnv.file} (${String(Object.keys(privateEnv.values).length)} names, permissions OK)`
    : 'secrets file: none');
  out(io, built.epochFrom === null ? 'epoch: default (1)' : `epoch: from ${built.epochFrom}`);
  out(io, `environment names: ${Object.keys(built.env).sort().join(', ')}`);
  const wrapper = config?.wrapper ?? null;
  if (built.hasSecrets) {
    const set = SECRET_NAMES.filter((name) => built.env[name] !== '');
    const missing = SECRET_NAMES.filter((name) => built.env[name] === '');
    out(io, `secrets: set ${set.join(', ')}${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}`);
  } else if (wrapper !== null) {
    out(io, SECRETS_UNCHECKED_LINE);
  } else {
    out(io, 'secrets: none (neither in the environment nor in the secrets file)');
  }
  try {
    const loaded = loadConfig({ ...built.env });
    assertDevicesFormat(loaded);
    const irohKeyUnchecked = loaded.iroh !== null && loaded.iroh.key === null;
    if (irohKeyUnchecked) {
      if (built.hasSecrets || wrapper === null) {
        err(io, `${label}: ${IROH_ENV}=1 without ${IROH_KEY_ENV}; the iroh server key comes from the secrets file or`
          + ' from service.wrapper (new one: openssl rand -hex 32; a new key means a new EndpointId and pairing'
          + ' again).');
        return { ok: false };
      }
      out(io, IROH_KEY_UNCHECKED_LINE);
    }
    if (loaded.iroh !== null && !await checkIrohModule(io, label, built.env, probe)) return { ok: false };
    for (const entry of loaded.originsSkipped ?? []) out(io, `warning ${skippedOriginLine(entry)}`);
    if (built.hasSecrets) {
      if (loaded.apnsIssue !== undefined) out(io, `warning apnsIssue: ${loaded.apnsIssue}`);
      if (loaded.pushRelayIssue !== undefined) out(io, `warning pushRelayIssue: ${loaded.pushRelayIssue}`);
    }
    const explicit = built.env[DATA_DIR_NAME] ?? '';
    const sdkChecked = await sdk({
      dataDir: loaded.dataDir, demo: loaded.demo, dataDirFlag: explicit === '' ? null : loaded.dataDir,
      env: withoutSecrets(built.env),
    });
    if (!sdkChecked.ok) {
      err(io, `${label}: ${sdkChecked.message}`);
      return { ok: false };
    }
    out(io, sdkChecked.line);
    out(io, `${CHECK_DATA_DIR_LABEL}: ${loaded.dataDir}`);
    out(io, `${CHECK_PORT_LABEL}: ${String(loaded.port)}`);
    return { ok: true, port: loaded.port, dataDir: loaded.dataDir, irohKeyUnchecked };
  } catch (failure) {
    if (failure instanceof ConfigError || failure instanceof Refusal) {
      err(io, `${label}: ${failure.message}`);
      return { ok: false };
    }
    throw failure;
  }
}

/**
 * Plik magazynu urządzeń (`devices.json` albo jego `.bak`) z wersją formatu wyższą niż znana = {@link Refusal}
 * ze zdaniem `devices-store.ts`: plik, jego wersja, wersja znana. Plik uszkodzony przechodzi — magazyn ma na
 * niego własną ścieżkę (kopia, potem pusty magazyn `broken`). The file is the one the server reads in this mode
 * (`devices.demo.json` in the plain demo, {@link devicesFileName}).
 */
export function assertDevicesFormat(config: DeviceStoreMode & { readonly dataDir: string }): void {
  const newer = newerDevicesFormat(config.dataDir, devicesFileName(config));
  if (newer !== null) throw new Refusal(devicesFormatMessage(newer));
}

/**
 * Sprawdzenie przed `execve` startu: katalog danych z `loadConfig` na środowisku serwera, potem
 * {@link assertDevicesFormat}. `ConfigError` nie jest tu odmową: serwer zgłasza go sam przy starcie, zanim utworzy
 * magazyn.
 */
function assertStartable(env: Readonly<Record<string, string>>): void {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ ...env });
  } catch (failure) {
    if (failure instanceof ConfigError) return;
    throw failure;
  }
  assertDevicesFormat(config);
}

/**
 * Wejścia serwera i próby modułu iroh względem korzenia instalacji (`cwd` obu procesów), per tryb
 * z `install/mode.ts`: klon uruchamia TypeScript przez tsx, paczka npm JavaScript (`pnpm run package`) wprost węzłem.
 */
const ENTRIES = {
  clone: { server: 'server/src/index.ts', irohProbe: 'server/src/iroh/module-probe.ts' },
  package: { server: 'server/src/index.js', irohProbe: 'server/src/iroh/module-probe.js' },
} as const satisfies Record<InstallMode, { readonly server: string; readonly irohProbe: string }>;

/** Wejście próby modułu iroh tej instalacji względem jej korzenia (`cwd` procesu próby). */
export const IROH_PROBE_ENTRY: string = ENTRIES[INSTALL_MODE].irohProbe;
const IROH_PROBE_TIMEOUT_MS = 30_000;
const IROH_PROBE_MAX_BYTES = 64 * 1024;

/** Wejście sprawdzenia SDK w `--check`: katalog danych z konfiguracji i środowisko serwera bez sekretów. */
export interface ServeSdkInput {
  readonly dataDir: string;
  readonly demo: boolean;
  /** Katalog spoza reguły (`--data-dir` albo `RAROG_DATA_DIR`) do komendy naprawy. */
  readonly dataDirFlag: string | null;
  readonly env: Readonly<Record<string, string>>;
}
/** Sprawdzenie SDK w `--check` ({@link checkServeSdk}; testy podają własne). */
export type ServeSdkCheck = (input: ServeSdkInput) => Promise<SdkCheck>;

/** Środowisko serwera bez sekretów: próby w osobnych procesach sekretów nie potrzebują. */
function withoutSecrets(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAMES.some((s) => s === name)));
}

/**
 * SDK tej instalacji dla `--check` (`install/sdk.ts`, `checkPinnedSdk`): sonda w osobnym procesie na środowisku
 * serwera bez sekretów, jak próba modułu iroh.
 */
export const checkServeSdk: ServeSdkCheck = (input) => checkPinnedSdk({
  dataDir: input.dataDir, demo: input.demo, dataDirFlag: input.dataDirFlag,
  probe: (dir, version) => probeSdkDir(dir, version, input.env),
});

/** Wynik próby modułu natywnego iroh; `reason` to zdanie dla człowieka. */
export type IrohProbeResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
/** Próba modułu na środowisku serwera ({@link probeIrohModule}; testy podają własną). */
export type IrohProbe = (env: Readonly<Record<string, string>>) => Promise<IrohProbeResult>;

/** Komenda próby modułu iroh: w paczce węzeł i wejście `.js`, w klonie węzeł z `--import tsx` i wejście `.ts`. */
export function irohProbeCommand(mode: InstallMode, node: string): string[] {
  const entry = ENTRIES[mode].irohProbe;
  return mode === 'package' ? [node, entry] : [node, '--import', 'tsx', entry];
}

/**
 * Próba modułu natywnego iroh w osobnym krótkim procesie (`iroh/module-probe.ts`): PRAWDZIWE `loadIroh()`, bez
 * endpointu i bez wiązania portu. Środowisko = środowisko serwera bez sekretów (ładowacz ich nie czyta), a nie
 * środowisko tego procesu: ładowacz paczki czyta zmienne procesu (`NAPI_RS_*`), a serwer dostaje wyłącznie nazwy
 * z rejestru. Węzeł ten sam co CLI, czyli pierwszy katalog `PATH` serwera ({@link servePath}).
 * `command` podmieniają testy.
 */
export function probeIrohModule(
  env: Readonly<Record<string, string>>,
  command: readonly string[] = irohProbeCommand(INSTALL_MODE, process.execPath),
): Promise<IrohProbeResult> {
  const probeEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAMES.some((s) => s === name)));
  const [file = process.execPath, ...args] = command;
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: INSTALL_ROOT, env: probeEnv, encoding: 'utf8', timeout: IROH_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
      maxBuffer: IROH_PROBE_MAX_BYTES,
    }, (failure, _stdout, stderr) => {
      if (failure === null) {
        resolve({ ok: true });
        return;
      }
      const said = stderr.split('\n').find((line) => line.startsWith(IROH_PROBE_PREFIX));
      if (said !== undefined) {
        resolve({ ok: false, reason: said.slice(IROH_PROBE_PREFIX.length) });
        return;
      }
      const code: unknown = (failure as { code?: unknown }).code;
      const how = failure.killed && failure.signal === 'SIGKILL'
        ? `did not finish within ${String(IROH_PROBE_TIMEOUT_MS / 1000)} s`
        : typeof code === 'number' ? `exited with code ${String(code)}`
          : `failed (${String(code ?? failure.signal ?? 'no code')})`;
      const last = stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
      resolve({ ok: false, reason: `the iroh native module probe ${how}${last === '' ? '' : `: ${last}`}` });
    });
  });
}

/**
 * Moduł natywny iroh dla `--check` przy `RAROG_IROH=1`: PRAWDZIWE ładowanie w próbie
 * ({@link probeIrohModule}), bo sam manifest paczki (`irohModuleInfo()`) nie mówi, czy kod natywny się ładuje. Bez
 * `bind`: `rarog restart` sprawdza, zanim zatrzyma działającą usługę, a ta trzyma stały port UDP (`RAROG_IROH_PORT`).
 * Serwer, który by nie wstał, kończy się tym samym zdaniem (`index.ts`).
 */
async function checkIrohModule(
  io: CliIo, label: string, env: Readonly<Record<string, string>>, probe: IrohProbe,
): Promise<boolean> {
  const probed = await probe(env);
  if (!probed.ok) {
    err(io, `${label}: ${IROH_ENV}=1, but ${probed.reason}`);
    return false;
  }
  let version = '?';
  try {
    version = irohModuleInfo().version ?? '?';
  } catch {
    // Manifest nieczytelny przy działającym module: wersja zostaje nieznana, sprawdzenie i tak przeszło.
  }
  out(io, `iroh: native module loaded (${IROH_PACKAGE} ${version}, ${irohPlatform()}); UDP port not checked,`
    + ' only the server binds it');
  return true;
}

/** Plik startowy serwera w klonie: shim tsx z `node_modules` repo, ścieżką bezwzględną. */
export const TSX_BIN = path.join(INSTALL_ROOT, 'node_modules', '.bin', 'tsx');
/** Wejście serwera tej instalacji względem jej korzenia. */
export const SERVER_ENTRY: string = ENTRIES[INSTALL_MODE].server;

/**
 * Plik i argv `execve` serwera: w paczce węzeł (ścieżka bezwzględna) z `server/src/index.js`, bez tsx; w klonie shim
 * tsx z `server/src/index.ts`. Wiersz polecenia procesu to ten napis, którego szukają wzorce stopu `restart.sh`.
 */
export function serverExec(
  mode: InstallMode, node: string,
): { readonly file: string; readonly argv: string[] } {
  if (mode === 'package') return { file: node, argv: [node, ENTRIES.package.server] };
  return { file: TSX_BIN, argv: [TSX_BIN, ENTRIES.clone.server] };
}

/** `rarog serve …` — `argv` zaczyna się od `serve`. */
export async function serveCommand(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(io, usageFor(io, `Usage:\n${SERVE_USAGE}`));
    return EXIT_OK;
  }
  const flags = parseServeFlags(argv, io.cwd);
  let built: ServeEnv;
  try {
    built = buildServeEnv(io.env, flags);
  } catch (failure) {
    if (failure instanceof Refusal) {
      err(io, `rarog serve: ${failure.message}`);
      return EXIT_REFUSED;
    }
    throw failure;
  }
  if (!built.configured) {
    err(io, `rarog serve: no configuration: ${path.join(rarogConfigDir(io.env), CONFIG_FILENAME)} does not exist`
      + ' and no flags were given. `rarog setup` creates it.');
    return EXIT_REFUSED;
  }
  if (flags.mode === 'print-env') {
    for (const line of printableEnv(built.env)) out(io, line);
    return EXIT_OK;
  }
  if (flags.mode === 'check') {
    if (!(await checkServeEnv(built, io)).ok) return EXIT_REFUSED;
    out(io, 'OK');
    return EXIT_OK;
  }
  if (built.config?.wrapper != null && !built.hasSecrets) {
    err(io, 'rarog serve: the config has service.wrapper, but the environment has no secrets; the server would start'
      + ` without them. Run it through the wrapper (as the launchd service does) or through \`${REPAIR.restart}\`.`);
    return EXIT_REFUSED;
  }
  try {
    assertStartable(built.env);
  } catch (failure) {
    if (failure instanceof Refusal) {
      err(io, `rarog serve: ${failure.message}`);
      return EXIT_REFUSED;
    }
    throw failure;
  }
  const execve = process.execve;
  if (execve === undefined) {
    err(io, `rarog serve: this Node (v${process.versions.node}) has no process.execve; Node 22.15 or newer is`
      + ' required (on the 23 line: 23.11 or newer).');
    return EXIT_REFUSED;
  }
  process.chdir(INSTALL_ROOT);
  // Ten sam PID: launchd (KeepAlive) i `restart.sh` widzą proces serwera, a nie front `rarog`.
  const { file, argv: serverArgv } = serverExec(INSTALL_MODE, process.execPath);
  return execve(file, serverArgv, built.env);
}
