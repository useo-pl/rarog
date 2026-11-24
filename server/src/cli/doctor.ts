/**
 * `rarog doctor`: jedna linia na sprawdzenie, stany — zielony,
 * czerwony z komendą naprawy, „nie wiem” (np. `ps` w sandboksie sesji agenta: ani sukces, ani błąd), żółty „uwaga”
 * z komendą naprawy (działa, ale z brakiem) i „info” (stan bez oceny). Tylko czyta: hook i `statusLine` drukuje,
 * nigdy nie wpisuje. Kod 0 wyłącznie przy wszystkich liniach zielonych; „info” się nie liczy.
 *
 * Linie: tryb i katalog tej instalacji z wersją (info; w paczce npm katalog bez prawa zapisu = „uwaga”); `/health`
 * na porcie z `config.json` albo `--port` (wersja serwera inna niż zainstalowana = czerwone z `rarog restart`); usługa
 * launchd (stan etykiety, plist, cel usługi wobec tej instalacji, węzeł usługi, log usługi w katalogu danych);
 * katalog danych (reguła, konflikt = czerwone, katalog z tej powłoki inny niż usługi = czerwone, skrót `serverId`);
 * środowisko żywego serwera wobec konfiguracji (`ps -Eww` procesu nasłuchującego na porcie); nasłuch iroh (`GET /api/admin/iroh` z gniazda administracyjnego, bez klucza; wyłączony = „info”
 * z paczką z manifestu, kod natywny nie ładuje się); hook (to samo porównanie co `/health`); kanał zgód (`consent`
 * z `/health`: tryb skonfigurowany i efektywny z powodem); ustawienia Claude Code wobec kanału (sandbox z dostępem do
 * gniazd pod `<dataDir>/run/` i drugi hook `PermissionRequest` to „uwaga”: doctor ostrzega, nie
 * zabezpiecza); state write block (`doctor-write-block.ts`); `statusLine`; gniazdo herdr; `rarog` w `PATH`
 * (w paczce wejście innej instalacji, np. dowiązanie klonu, = „uwaga”); stan PR-ów (`doctor-pr-status.ts`: `gh`
 * i jego logowanie). `--port` i `--data-dir` celują w wystąpienie próbne.
 *
 * Środowisko oczekiwane to `buildServeEnv` na środowisku „jak pod launchd” ({@link launchdEnv}), bez zmiennych
 * powłoki, w której uruchomiono `doctor`. `ps -E` skleja argv i środowisko spacjami, więc linię dzielimy po znanych
 * nazwach (rejestr i pomijane), a spacja w wartości nie psuje porównania. Sekrety: wyłącznie obecność — wartość
 * sekretu nie trafia na ekran nigdy.
 *
 * Linux: usługa to jednostka `systemd --user` `rarog.service` (stan z `systemctl --user
 * show`, węzeł z `ExecStart` naszego pliku, linger z `loginctl`), środowisko oczekiwane to `buildServeEnv` na
 * środowisku menedżera użytkownika (`busctl`), a żywe — dokładnie z `<procfs>/<pid>/environ` (PID słuchacza
 * z `lsof`, bez niego z `ss`). Do porównania i na ekran idą wyłącznie nazwy z rejestru; nazwa spoza rejestru =
 * różnica samą nazwą. Platformę i katalog procfs podaje `CliIo` (testy na macOS biegną gałęzią Linuksa).
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import http from 'node:http';
import { userInfo } from 'node:os';
import path from 'node:path';
import { dataDirConflictMessage, resolveDataDir } from '@rarog/shared/data-dir';
import { adminSocketPath } from '../auth/admin.ts';
import { DEVICES_FILENAME } from '../auth/devices-store.ts';
import { DEFAULT_PORT, defaultHerdrSocket } from '../config.ts';
import { minClientBuildOf } from '../config/clients.ts';
import type { MinClientBuild } from '../config/clients.ts';
import {
  HERDR_SOCKET_ENV, IROH_ENV, IROH_RELAY_ENV, MIN_CLIENT_BUILD_ENV, SERVER_ENV, registryNameOf,
} from '../config-env.ts';
import type { ServerEnvName } from '../config-env.ts';
import { HOOK_STATUS_MISSING } from '../health.ts';
import { consentChannelOpen } from '../herdr/dialogs/hook/contract.ts';
import { CONSENT_SOCKET_FILENAME } from '../herdr/dialogs/layer1/contract.ts';
import {
  HOOK_MANIFEST_FILENAME, HOOK_PERMISSION_EVENT, STATUSLINE_FRESH_MS, STATUSLINE_INSTALLED_SCRIPT_REL, combineStatus,
  expectedHookEntries, hookCommand, hookCopyReport, hookOriginText, inspectSettingsFile, newestStatuslineDump,
  rarogHookEntries, statuslineCopyReport, statuslineDumpDir, userSettingsPath, withCopyStatus,
} from '../herdr/hook-config.ts';
import type { HookCopyReport } from '../herdr/hook-config.ts';
import { installDataDir } from '../install/data-dir.ts';
import { INSTALL_MODE, INSTALL_ROOT } from '../install/mode.ts';
import type { InstallMode } from '../install/mode.ts';
import { REPAIR, npmBinDir, packageCommands, packageManagerOf, rarogCli } from '../install/repair.ts';
import {
  SDK_PACKAGE, probeCheckedSdkDir, probeSdkDir, readSdkPin, sdkVersionDir, sdkVersions, treeBytes,
} from '../install/sdk.ts';
import type { SdkProbeResult } from '../install/sdk.ts';
import { RAROG_BIN } from '../install/service-target.ts';
import { IROH_PACKAGE, irohModuleInfo, irohPlatform } from '../iroh/adapter.ts';
import type { IrohModuleInfo } from '../iroh/adapter.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { RAROG_VERSION } from '../version.ts';
import { noHookLines } from './doctor-no-hook.ts';
import { prStatusLine } from './doctor-pr-status.ts';
import { writeBlockLine } from './doctor-write-block.ts';
import {
  HOOK_CHECKOUT_REASON, HOOK_REPAIR_COPY, HOOK_REPAIR_ENTRY, seenByFileLines,
} from './hooks.ts';
import { EXIT_OK, EXIT_REFUSED, Refusal, Usage, homeOf, out, platformOf } from './io.ts';
import type { CliIo } from './io.ts';
import {
  SERVICE_LABEL, clonePackageAdvice, loadState, serviceInstallationMismatch, serviceNode, servicePlistArgv,
  servicePlistPath, unitArgv, unitNode,
} from './restart.ts';
import { PROCESS_NAMES, buildServeEnv, servePath } from './serve.ts';
import type { ServeEnv } from './serve.ts';
import { launchdEnv, rarogLinkPath } from './service.ts';
import {
  UNIT_ENV_PROPS, UNIT_NAME, UNIT_STATE_PROPS, classifyUnit, enableLingerCommand, lingerState, managerEnvironment,
  showUnit, unitFilePath,
} from './systemd-unit.ts';
import { usageFor } from './screen/prose.ts';
import { herdrAgentDoctorLine, herdrAgentStart } from './setup-herdr-agent.ts';

export const DOCTOR_USAGE = `  rarog doctor [--port <port>] [--data-dir <dir>]
      Checks the installation line by line (/health, service, data directory, live server environment against
      config.json, iroh listener, hook, consent channel, Claude Code settings for the channel, statusLine, herdr
      socket, rarog in PATH, PR status: gh and its login); read-only. Exit code 0 = all lines ok ("info" lines do
      not count). --port and --data-dir: a trial instance.`;

/** Zmienne, które żywy serwer ma, a których konfiguracja nie daje: dokłada je tsx, powłoka albo system. */
const SKIPPED = ['NODE_PATH', 'PWD', 'SHLVL'] as const;
const SKIPPED_PREFIX = '__CF_';
const HEALTH_TIMEOUT_MS = 3_000;

/** `warn` = żółte ostrzeżenie (działa, ale czegoś brak; liczy się jak nie-zielone), `info` = stan bez oceny. */
export type Verdict = 'ok' | 'bad' | 'unknown' | 'warn' | 'info';

export interface Line {
  readonly verdict: Verdict;
  readonly text: string;
  /** Linie szczegółu pod spodem (różnice środowiska, komunikat konfliktu). */
  readonly details?: readonly string[];
  /** Komenda albo krok naprawy przy czerwonym i żółtym. */
  readonly repair?: string;
}

const MARK: Readonly<Record<Verdict, string>> = {
  ok: 'ok      ', bad: 'ERROR   ', unknown: 'unknown ', warn: 'warn    ', info: 'info    ',
};

interface DoctorFlags {
  readonly port?: string;
  readonly dataDir?: string;
}

function parseDoctorFlags(argv: readonly string[], cwd: string): DoctorFlags {
  let port: string | undefined;
  let dataDir: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    if (arg !== '--port' && arg !== '--data-dir') throw new Usage(`Unknown rarog doctor option: ${arg}`);
    if (next === undefined || next.startsWith('--')) throw new Usage(`${arg} requires a value.`);
    if (arg === '--port') {
      if (!/^[0-9]{1,5}$/.test(next) || Number(next) < 1 || Number(next) > 65535) {
        throw new Usage(`--port: expected a port number 1–65535 (got: ${next}).`);
      }
      if (port !== undefined) throw new Usage('--port given twice.');
      port = String(Number(next));
    } else {
      if (dataDir !== undefined) throw new Usage('--data-dir given twice.');
      dataDir = path.resolve(cwd, next);
    }
    i += 1;
  }
  return { ...(port !== undefined ? { port } : {}), ...(dataDir !== undefined ? { dataDir } : {}) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const errnoCode = (failure: unknown): string =>
  (isRecord(failure) && typeof failure['code'] === 'string' ? failure['code'] : '') || String(failure);

/** Rodzaj nazwy z rejestru albo `undefined`. */
const kindOf = (name: string): string | undefined => {
  const registry = registryNameOf(name);
  return registry === undefined ? undefined : SERVER_ENV[registry];
};

const isSkipped = (name: string): boolean =>
  (SKIPPED as readonly string[]).includes(name) || name.startsWith(SKIPPED_PREFIX);

const quoted = (value: string): string => (value === '' ? '(empty)' : `«${value}»`);

// ---------------------------------------------------------------------------
// Środowisko żywego serwera
// ---------------------------------------------------------------------------

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KNOWN_NAMES = new RegExp(
  `(?:^| )(${[...(Object.keys(SERVER_ENV) as ServerEnvName[]), ...SKIPPED]
    .map(escapeRe).join('|')}|${SKIPPED_PREFIX}[A-Za-z0-9_]*)=`,
  'g',
);
/** Wygląd przypisania zmiennej środowiska wewnątrz wartości: znak, że skleiła się nazwa spoza rejestru. */
const ANY_ASSIGNMENT = /(?:^| )([A-Z_][A-Z0-9_]*)=/g;

export interface PsEnvironment {
  /** Wartości znanych nazw (pierwsze wystąpienie wygrywa, jak w `getenv`). */
  readonly values: ReadonlyMap<string, string>;
  /**
   * Nazwy, których wartość wolno wypisać: stoją w odczycie PRZED pierwszym sekretem i przed pierwszą sklejoną nazwą
   * spoza rejestru. `ps -E` łączy wpisy spacją, więc dalszy odcinek może być fragmentem wartości sekretu
   * (`SONIOX_API_KEY=a PATH=b` to jeden wpis albo dwa).
   */
  readonly printable: ReadonlySet<string>;
  /** Znane nazwy, które stoją w odczycie więcej niż raz: jedno z wystąpień jest fragmentem cudzej wartości. */
  readonly repeated: readonly string[];
  /** Nazwy spoza rejestru: z `ps -E` te przed pierwszą znaną nazwą, z `/proc` wszystkie (bez pomijanych). */
  readonly unknownLead: readonly string[];
}

/**
 * Część środowiska z wyjścia `ps -E` (po odcięciu polecenia) podzielona po znanych nazwach. Wartość ciągnie się do
 * spacji przed następną znaną nazwą, więc `RAROG_PROJECT_ROOTS=/a/My Projects` zostaje jedną wartością.
 */
export function parsePsEnvironment(text: string): PsEnvironment {
  const matches = [...text.matchAll(KNOWN_NAMES)];
  const values = new Map<string, string>();
  const printable = new Set<string>();
  const repeated = new Set<string>();
  let ambiguousFromHere = false;
  matches.forEach((match, i) => {
    const name = match[1] ?? '';
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[i + 1]?.index ?? text.length;
    const value = text.slice(start, end);
    if (values.has(name)) {
      repeated.add(name);
    } else {
      values.set(name, value);
      if (!ambiguousFromHere) printable.add(name);
    }
    if (kindOf(name) === 'secret' || gluedNames(value).length > 0) ambiguousFromHere = true;
  });
  const lead = text.slice(0, matches[0]?.index ?? text.length);
  return {
    values, printable, repeated: [...repeated].sort(),
    unknownLead: [...lead.matchAll(ANY_ASSIGNMENT)].map((m) => m[1] ?? ''),
  };
}

/** Nazwy spoza rejestru sklejone w wartości (`ps -E` nie zaznacza granic wpisów). */
function gluedNames(value: string): string[] {
  return [...value.matchAll(ANY_ASSIGNMENT)].map((m) => m[1] ?? '').filter((n) => kindOf(n) === undefined);
}

/** Nazwa spoza rejestru do wypisania: zwykła dosłownie, nietypowa w cudzysłowie JSON (bez łamania linii). */
const shownName = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name));

/**
 * Środowisko z `/proc/<pid>/environ` (Linux): wpisy rozdzielone NUL-em, więc granice są dokładne —
 * wartość ze spacją i `=` zostaje jedną wartością. Do `values` (i dalej na ekran) idą WYŁĄCZNIE nazwy z rejestru;
 * nazwy spoza rejestru (`_`, `INVOCATION_ID`) trafiają do `unknownLead` samą nazwą, pomijane (tsx, powłoka) nigdzie.
 * Pierwsze wystąpienie wygrywa jak w `getenv`, powtórzona nazwa z rejestru trafia do `repeated`.
 */
export function parseProcEnvironment(bytes: Buffer): PsEnvironment {
  const values = new Map<string, string>();
  const repeated = new Set<string>();
  const unknown = new Set<string>();
  for (const entry of bytes.toString('utf8').split('\0')) {
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      unknown.add('(entry without "NAME=")');
      continue;
    }
    const name = entry.slice(0, eq);
    if (kindOf(name) === undefined) {
      if (!isSkipped(name)) unknown.add(shownName(name));
    } else if (values.has(name)) {
      repeated.add(name);
    } else {
      values.set(name, entry.slice(eq + 1));
    }
  }
  return {
    values, printable: new Set(values.keys()), repeated: [...repeated].sort(), unknownLead: [...unknown].sort(),
  };
}

/** Wynik porównania: różnice (czerwone) i miejsca, których odczyt `ps` nie rozstrzyga („nie wiem”). */
export interface EnvComparison {
  readonly diffs: readonly string[];
  readonly unsure: readonly string[];
}

const HIDDEN_VALUE = ' (value from ps not shown: it follows a secret or a name outside the registry, so it may be'
  + ' part of their value)';

export interface CompareOptions {
  /** `config.json` ma `service.wrapper`: sekret obecny w serwerze, a nieobecny w pliku sekretów, daje wrapper. */
  readonly wrapper: boolean;
  /**
   * Odczyt dokładny (`/proc/<pid>/environ`): granice wpisów znane, więc bez zgadywania sklejonych nazw w wartości,
   * a powtórzona nazwa to prawdziwy duplikat w środowisku procesu, nie fragment cudzej wartości.
   */
  readonly exact?: boolean;
}

/**
 * Różnice środowiska żywego serwera wobec oczekiwanego. Wartości jawne dosłownie (także `PATH`), pusta = brak;
 * sekrety tylko obecność; zmienne katalogu danych niepuste bez `--data-dir` = różnica z powodem. Wartość z `ps`
 * pada na ekran tylko dla nazw z `printable`; nazwa powtórzona w odczycie to „nie wiem”. Zwraca zdania do
 * wypisania — bez wartości sekretów.
 */
export function compareServerEnv(
  expected: Readonly<Record<string, string>>, live: PsEnvironment, opts: CompareOptions,
): EnvComparison {
  const diffs: string[] = [];
  const unsure: string[] = [];
  if (live.unknownLead.length > 0) {
    diffs.push(`variables outside the registry in the server environment: ${live.unknownLead.join(', ')}`);
  }
  const names = [...new Set([...Object.keys(expected), ...live.values.keys()])].filter((n) => !isSkipped(n)).sort();
  for (const name of names) {
    const want = expected[name] ?? '';
    const got = live.values.get(name) ?? '';
    const kind = kindOf(name);
    if (live.repeated.includes(name)) {
      unsure.push(opts.exact === true
        ? `${name}: appears more than once in the process environment — not compared, not shown`
        : `${name}: appears more than once in the ps output (one occurrence is part of another value)`
          + ' — not compared, not shown');
      continue;
    }
    if (kind === 'secret') {
      if (want !== '' && got === '') diffs.push(`${name}: the secrets file has it, the server does not`);
      if (want === '' && got !== '' && !opts.wrapper) {
        diffs.push(`${name}: the server has it, but the config does not provide it (neither the secrets file nor`
          + ' service.wrapper)');
      }
      continue;
    }
    if (got === want) continue;
    const printable = live.printable.has(name);
    const glued = opts.exact === true ? [] : gluedNames(got);
    if (glued.length > 0 && printable) {
      diffs.push(`${name}: a variable outside the registry follows the value (${glued.join(', ')}) — value not`
        + ' compared');
    } else if ((PROCESS_NAMES as readonly string[]).includes(name) && want === '') {
      diffs.push(`${printable ? `${name}=${quoted(got)}` : `${name} non-empty`} in the server: the hook in Claude`
        + ` sessions computes the data directory without this variable, so it writes elsewhere${printable ? ''
          : HIDDEN_VALUE}`);
    } else if (printable) {
      diffs.push(`${name}: expected ${quoted(want)}, server ${quoted(got)}`);
    } else {
      diffs.push(`${name}: expected ${quoted(want)}, the server has another value${HIDDEN_VALUE}`);
    }
  }
  return { diffs, unsure };
}

type Listeners = { pids: string[] } | { failure: string };

function spawnLsof(port: number, io: CliIo): SpawnSyncReturns<string> {
  return spawnSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], {
    env: io.env, encoding: 'utf8', timeout: 10_000,
  });
}

/** PID-y nasłuchujące na porcie TCP (`lsof`); `failure` = `lsof` nie odpowiedział. */
function listeningPids(port: number, io: CliIo): Listeners {
  return lsofListeners(spawnLsof(port, io));
}

const isMissing = (failure: Error | undefined): boolean => failure !== undefined && errnoCode(failure) === 'ENOENT';

/**
 * Linux: PID-y słuchacza z `lsof`, a bez niego w `PATH` (Ubuntu 24.04 domyślnie go nie ma) z `ss -Hltnp`
 * (iproute2, `users:(("node",pid=…,fd=…))`). Bez obu — powód z podpowiedzią, czyli „nie wiem”.
 */
function linuxListeningPids(port: number, io: CliIo): Listeners {
  const lsof = spawnLsof(port, io);
  if (!isMissing(lsof.error)) return lsofListeners(lsof);
  const result = spawnSync('ss', ['-Hltnp', `sport = :${String(port)}`], {
    env: io.env, encoding: 'utf8', timeout: 10_000,
  });
  if (isMissing(result.error)) {
    return { failure: 'neither lsof nor ss in PATH — install lsof or iproute2 (ss) and run doctor again' };
  }
  if (result.error !== undefined) return { failure: `ss: ${result.error.message}` };
  if (result.status !== 0) {
    return { failure: `ss: exit status ${String(result.status)} ${result.stderr.trim().split('\n')[0] ?? ''}`.trim() };
  }
  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
  // Każde gniazdo osobno: jedno bez PID (słuchacz innego użytkownika) obok drugiego z PID-em nie może dać „ok”
  // dla procesu, który nie musi być tym, co odpowiada na /health.
  if (lines.some((line) => !/\bpid=[0-9]+/.test(line))) {
    return { failure: `ss sees a socket on port ${String(port)}, but not its process (another user's listener?)` };
  }
  return { pids: [...new Set(lines.flatMap((line) => [...line.matchAll(/\bpid=([0-9]+)/g)].map((m) => m[1] ?? '')))] };
}

function lsofListeners(result: SpawnSyncReturns<string>): Listeners {
  if (result.error !== undefined) return { failure: `lsof: ${result.error.message}` };
  const pids = [...new Set(result.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[0-9]+$/.test(l)))];
  if (pids.length === 0 && result.status !== 0 && result.status !== 1) {
    return { failure: `lsof: exit status ${String(result.status)} ${result.stderr.trim()}`.trim() };
  }
  return { pids };
}

function psLine(args: readonly string[], io: CliIo): { text: string } | { failure: string } {
  const result = spawnSync('ps', args, { env: io.env, encoding: 'utf8', timeout: 10_000 });
  if (result.error !== undefined) return { failure: result.error.message };
  const text = result.stdout.replace(/\n+$/, '');
  if (result.status !== 0 || text === '') {
    return { failure: (result.stderr.trim().split('\n')[0] ?? '') || `exit status ${String(result.status)}` };
  }
  return { text };
}

/** Skąd odczyt żywego środowiska: nazwa w linii „niejednoznaczny”, naprawa przy różnicy, dokładność granic. */
interface EnvSource {
  readonly read: string;
  readonly repair: string;
  readonly exact: boolean;
}

const PS_SOURCE: EnvSource = {
  read: 'ps', exact: false,
  repair: 'fix config.json (or the secrets file, service.wrapper); the ai.rarog.server service picks up'
    + ' changes on rarog restart',
};
const PROC_SOURCE: EnvSource = {
  read: '/proc', exact: true,
  repair: `fix config.json (or the secrets file, service.wrapper); the ${UNIT_NAME} unit picks up changes`
    + ' on rarog restart',
};

/** Sufit odczytu `/proc/<pid>/environ` (jądro i tak tnie środowisko procesu do kilku MiB). */
const ENVIRON_MAX_BYTES = 1024 * 1024;

type LiveRead = { readonly pid: string; readonly live: PsEnvironment } | { readonly line: Line };

function onlyListener(title: string, port: number, listening: Listeners): { pid: string } | { line: Line } {
  if ('failure' in listening) return { line: { verdict: 'unknown', text: `${title}: ${listening.failure}` } };
  if (listening.pids.length === 0) {
    return { line: { verdict: 'unknown', text: `${title}: nothing listens on port ${String(port)}` } };
  }
  if (listening.pids.length > 1) {
    return {
      line: {
        verdict: 'unknown',
        text: `${title}: several processes listen on port ${String(port)} (${listening.pids.join(', ')})`,
      },
    };
  }
  return { pid: listening.pids[0] ?? '' };
}

/** macOS: środowisko procesu z `ps -E` (po odcięciu polecenia z `ps -o command=`). */
function psRead(io: CliIo, title: string, pid: string): LiveRead {
  const command = psLine(['-ww', '-o', 'command=', '-p', pid], io);
  const withEnv = psLine(['-Eww', '-o', 'command=', '-p', pid], io);
  for (const read of [command, withEnv]) {
    if ('failure' in read) {
      return {
        line: {
          verdict: 'unknown',
          text: `${title}: ps could not read process ${pid} (${read.failure}) — inside an agent session sandbox,`
            + ' run doctor in a regular terminal',
        },
      };
    }
  }
  const cmd = 'text' in command ? command.text : '';
  const full = 'text' in withEnv ? withEnv.text : '';
  if (!full.startsWith(`${cmd} `)) {
    return { line: { verdict: 'unknown', text: `${title}: ps -E did not show the environment of process ${pid}` } };
  }
  return { pid, live: parsePsEnvironment(full.slice(cmd.length + 1)) };
}

/** Linux: środowisko procesu dokładnie z `<procRoot>/<pid>/environ` (katalog procfs z `CliIo`, domyślnie `/proc`). */
function procRead(io: CliIo, title: string, pid: string): LiveRead {
  const file = path.join(io.procRoot ?? '/proc', pid, 'environ');
  try {
    const read = readRegularFileSync(file, { maxBytes: ENVIRON_MAX_BYTES, followSymlink: false });
    if (read === null || read.truncated) {
      return { line: { verdict: 'unknown', text: `${title}: ${file} is not a regular file up to 1 MiB` } };
    }
    return { pid, live: parseProcEnvironment(read.bytes) };
  } catch (failure) {
    return {
      line: {
        verdict: 'unknown',
        text: `${title}: cannot read ${file} (${errnoCode(failure)}) — another user's process, or it has exited`,
      },
    };
  }
}

function compareLine(title: string, read: { readonly pid: string; readonly live: PsEnvironment },
  expected: Readonly<Record<string, string>>, wrapper: boolean, source: EnvSource): Line {
  const { pid, live } = read;
  const { diffs, unsure } = compareServerEnv(expected, live, { wrapper, ...(source.exact ? { exact: true } : {}) });
  if (diffs.length > 0) {
    return {
      verdict: 'bad',
      text: `${title}: process ${pid} differs in ${String(diffs.length)} ${diffs.length === 1 ? 'place' : 'places'}`,
      details: [...diffs, ...unsure],
      repair: source.repair,
    };
  }
  if (unsure.length > 0) {
    return {
      verdict: 'unknown',
      text: `${title}: ${source.read} read of process ${pid} is ambiguous`,
      details: unsure,
    };
  }
  const secrets = [...live.values.entries()].filter(([name, value]) => kindOf(name) === 'secret' && value !== '')
    .map(([name]) => name).sort();
  return {
    verdict: 'ok',
    text: `${title}: process ${pid}, ${String(live.values.size)} variables match; secrets present:`
      + ` ${secrets.length > 0 ? secrets.join(', ') : 'none'}`,
  };
}

/**
 * `managerFailure`: na Linuksie środowisko menedżera użytkownika (`busctl`) nieczytelne — oczekiwanego nie ma z czego
 * policzyć („nie wiem”, surowe wyjście `busctl` nie trafia na ekran).
 */
function envLine(io: CliIo, built: ServeEnv | null, configIssue: string | null, port: number | null,
  expectedPath: string, managerFailure: string | null): Line {
  const title = 'live server environment = config';
  const platform = platformOf(io);
  if (platform !== 'darwin' && platform !== 'linux') {
    return {
      verdict: 'unknown',
      text: `${title}: doctor knows macOS (ps -E) and Linux (/proc/<pid>/environ), and this platform is ${platform}`,
    };
  }
  if (configIssue !== null) {
    return { verdict: 'bad', text: `${title}: ${configIssue}`, repair: 'fix ~/.config/rarog/config.json' };
  }
  if (built === null || built.config === null) {
    return {
      verdict: 'bad',
      text: `${title}: no config.json — nothing to compare against`,
      repair: 'create ~/.config/rarog/config.json (docs/server-config.md, "Config file and rarog serve")',
    };
  }
  if (managerFailure !== null) {
    return {
      verdict: 'unknown',
      text: `${title}: user manager environment unreadable (${managerFailure}) — without it the expected`
        + ' environment cannot be computed; run doctor in a regular user session',
    };
  }
  if (port === null) return { verdict: 'unknown', text: `${title}: port from the config unreadable` };
  const linux = platform === 'linux';
  const listener = onlyListener(title, port, linux ? linuxListeningPids(port, io) : listeningPids(port, io));
  if ('line' in listener) return listener.line;
  const read = linux ? procRead(io, title, listener.pid) : psRead(io, title, listener.pid);
  if ('line' in read) return read.line;
  return compareLine(title, read, { ...built.env, PATH: expectedPath }, built.config.wrapper !== null,
    linux ? PROC_SOURCE : PS_SOURCE);
}

// ---------------------------------------------------------------------------
// Pozostałe linie
// ---------------------------------------------------------------------------

type HealthRead = { readonly body: Record<string, unknown> } | { readonly failure: string; readonly denied: boolean };

async function readHealth(port: number): Promise<HealthRead> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return { failure: `HTTP ${String(response.status)}`, denied: false };
    const body: unknown = await response.json();
    return isRecord(body) ? { body } : { failure: 'response is not a JSON object', denied: false };
  } catch (failure) {
    const cause = isRecord(failure) ? failure['cause'] : undefined;
    const code = errnoCode(cause ?? failure);
    return { failure: code, denied: code === 'EPERM' || code === 'EACCES' };
  }
}

function healthLine(
  port: number | null, health: HealthRead | null, termExpected: boolean, installed: string = RAROG_VERSION,
): Line {
  if (port === null || health === null) return { verdict: 'unknown', text: '/health: port unreadable' };
  const where = `127.0.0.1:${String(port)}`;
  if ('failure' in health) {
    return health.denied
      ? { verdict: 'unknown', text: `/health ${where}: connection blocked (${health.failure}, sandbox?)` }
      : { verdict: 'bad', text: `/health ${where}: not responding (${health.failure})`, repair: 'rarog restart' };
  }
  const { body } = health;
  const problems: string[] = [];
  if (body['herdr'] !== true) {
    problems.push('herdr: false — the server cannot talk to herdr (see the socket line below)');
  }
  if (body['term'] !== true && termExpected) problems.push('term: false, but the config has RAROG_TERM=1');
  if (body['authStore'] === 'broken') {
    problems.push('authStore: broken — key store unreadable, devices have to pair again (rarog pair)');
  }
  // Wersja z `/health` to wersja kodu, który działa (czytana przy starcie serwera), a tu — zainstalowana teraz.
  const version = body['version'];
  const stale = typeof version === 'string' && version !== installed;
  if (stale) problems.push(`version ${version}, installed ${installed} — the server runs code from before the change`);
  const summary = `herdr: ${String(body['herdr'])}, term: ${String(body['term'])}, hook: ${String(body['hook'])},`
    + ` authStore: ${String(body['authStore'])}, version ${String(body['version'])}`;
  if (problems.length > 0) {
    return {
      verdict: 'bad', text: `/health ${where}: ${summary}`, details: problems,
      repair: stale && problems.length === 1 ? 'rarog restart'
        : 'cause in server.log in the data directory; after the fix, rarog restart',
    };
  }
  return { verdict: 'ok', text: `/health ${where}: ${summary}` };
}

/** Linia usługi bez węzła (jednostka nie nasza albo nie rozstrzygnięta). */
const unitOnly = (line: Line): { line: Line; node: string | null } => ({ line, node: null });

/**
 * Linux: jednostka `rarog.service` z `systemctl --user show` — nasza (`FragmentPath`), bez drop-inów
 * i bez środowiska w samej jednostce, wczytana po ostatniej zmianie pliku; węzeł z `ExecStart` naszego pliku;
 * `ActiveState=active` i `UnitFileState=enabled`; na koniec linger (`no` albo nieczytelny = „nie wiem” z komendą).
 */
function unitServiceLine(io: CliIo, home: string): { line: Line; node: string | null } {
  const shown = showUnit(io, [...UNIT_STATE_PROPS, 'ActiveState', 'UnitFileState'], UNIT_ENV_PROPS);
  if ('failure' in shown) {
    return unitOnly({
      verdict: 'unknown',
      text: `service: systemctl --user show ${UNIT_NAME} is inconclusive (${shown.failure}) — without the user`
        + ' manager bus (logind session, XDG_RUNTIME_DIR) the state is unknown; run doctor in a regular user session',
    });
  }
  const file = unitFilePath(home);
  const status = classifyUnit(shown.values, home);
  switch (status.kind) {
    case 'ours':
      break;
    case 'absent':
      return unitOnly({
        verdict: 'bad', text: `service: no systemd --user unit ${UNIT_NAME}`, repair: 'rarog service install',
      });
    case 'masked':
      return unitOnly({
        verdict: 'bad', text: `service: ${UNIT_NAME} has LoadState=masked`,
        repair: `systemctl --user unmask ${UNIT_NAME}, then rarog service install`,
      });
    case 'bad-setting':
      return unitOnly({
        verdict: 'bad', text: `service: ${UNIT_NAME} has LoadState=bad-setting (systemd rejected the unit file)`,
        repair: `cause in systemctl --user status ${UNIT_NAME}; then rarog service install`,
      });
    case 'foreign':
      return unitOnly({
        verdict: 'bad', text: `service: ${UNIT_NAME} loaded from ${status.detail}, not from ${file}`,
        repair: `not the unit from rarog service install: remove it, systemctl --user daemon-reload, then rarog`
          + ' service install',
      });
    case 'drop-in':
      return unitOnly({
        verdict: 'bad',
        text: `service: ${UNIT_NAME} has drop-ins (${status.detail}) — they can change the server start or`
          + ' environment',
        repair: 'remove the drop-ins and run systemctl --user daemon-reload; server variables go in config.json',
      });
    case 'stale':
      return unitOnly({
        verdict: 'bad', text: `service: ${file} changed without daemon-reload (NeedDaemonReload=yes)`,
        repair: 'systemctl --user daemon-reload, then rarog restart',
      });
    case 'environment':
      return unitOnly({
        verdict: 'bad', text: `service: ${UNIT_NAME} sets environment in the unit itself (${status.detail})`,
        repair: 'rarog service install (the template has no such entries); server variables go in config.json',
      });
    default:
      return unitOnly({
        verdict: 'unknown',
        text: `service: ${UNIT_NAME} has ${status.detail} — check systemctl --user status ${UNIT_NAME}`,
      });
  }
  const found = unitNode(io);
  if ('issue' in found) {
    return unitOnly({ verdict: 'bad', text: `service: ${found.issue}`, repair: 'rarog service install' });
  }
  const active = shown.values.get('ActiveState') ?? '';
  if (active !== 'active') {
    return {
      line: {
        verdict: 'bad', text: `service: ${UNIT_NAME} is not running (ActiveState=${active || '?'}), node ${found.node}`,
        repair: `rarog restart; cause in server.log in the data directory and in systemctl --user status ${UNIT_NAME}`,
      },
      node: found.node,
    };
  }
  const enabled = shown.values.get('UnitFileState') ?? '';
  if (enabled !== 'enabled') {
    return {
      line: {
        verdict: 'bad',
        text: `service: ${UNIT_NAME} runs, but will not start on its own (UnitFileState=${enabled || '?'}),`
          + ` node ${found.node}`,
        repair: `systemctl --user enable ${UNIT_NAME}`,
      },
      node: found.node,
    };
  }
  const running = `service: ${UNIT_NAME} active and enabled, node ${found.node}`;
  const user = userInfo().username;
  const linger = lingerState(io, user);
  if ('failure' in linger || linger.value !== 'yes') {
    const state = 'failure' in linger ? `linger: unknown (${linger.failure})`
      : `linger off (Linger=${linger.value || '?'})`;
    return {
      line: withInstallation({
        verdict: 'unknown',
        text: `${running}; ${state} — without a login session (server, reboot) the service will not start;`
          + ` enable it with ${enableLingerCommand(user)}`,
      }, UNIT_NAME, unitArgv(io)),
      node: found.node,
    };
  }
  return {
    line: withInstallation({ verdict: 'ok', text: `${running}; linger: yes` }, UNIT_NAME, unitArgv(io)),
    node: found.node,
  };
}

/**
 * Cel usługi wobec tej instalacji (`restart.ts`, {@link serviceInstallationMismatch}; ta sama reguła co
 * w `rarog restart`) na linii usługi, która poza tym przechodzi: rozjazd blokujący restart = czerwone z komendą
 * `service install` tej instalacji, a z klonu przy usłudze na paczce npm z radą {@link clonePackageAdvice} (tam
 * `service install` przełączyłby usługę na klon); inny węzeł klonu = dopisek pod linią.
 */
function withInstallation(
  line: Line, label: string, argv: { readonly argv: readonly string[] } | { readonly issue: string },
): Line {
  if ('issue' in argv || (line.verdict !== 'ok' && line.verdict !== 'unknown')) return line;
  const mismatch = serviceInstallationMismatch(argv.argv);
  if (mismatch === null) return line;
  if (mismatch.blocking) {
    const repair = mismatch.servicePackage === null ? mismatch.reinstall : clonePackageAdvice(mismatch.servicePackage);
    return { verdict: 'bad', text: `service: ${label} ${mismatch.what}`, repair };
  }
  return {
    ...line, details: [...(line.details ?? []), `the service ${mismatch.what}; ${mismatch.reinstall} switches it`],
  };
}

function serviceLine(io: CliIo, home: string, dataDir: string | null): { line: Line; node: string | null } {
  const platform = platformOf(io);
  if (platform === 'linux') return unitServiceLine(io, home);
  if (platform !== 'darwin') {
    return unitOnly({
      verdict: 'unknown',
      text: `service: doctor knows launchd (macOS) and systemd --user (Linux), and this platform is ${platform}`,
    });
  }
  const service = loadState(SERVICE_LABEL, io);
  const servicePlist = existsSync(servicePlistPath(home));
  if (typeof service === 'object') {
    return {
      line: { verdict: 'unknown', text: `service: launchctl print ${SERVICE_LABEL} is inconclusive (${service.unknown})` },
      node: null,
    };
  }
  if (service === 'absent' && !servicePlist) {
    return { line: { verdict: 'bad', text: 'service: no launchd service', repair: 'rarog service install' }, node: null };
  }
  const found = serviceNode(io);
  if ('issue' in found) {
    return { line: { verdict: 'bad', text: `service: ${found.issue}`, repair: 'rarog service install' }, node: null };
  }
  if (service !== 'loaded') {
    return {
      line: { verdict: 'bad', text: `service: ${SERVICE_LABEL} has a plist, but is not loaded`,
        repair: 'rarog service install' },
      node: found.node,
    };
  }
  const log = dataDir === null ? undefined : serviceLogPaths(io, home)
    .find((file) => path.dirname(path.resolve(file)) !== path.resolve(dataDir));
  if (log !== undefined && dataDir !== null) {
    // Plist pisze log poza katalogiem danych (np. przez dowiązanie po przeniesieniu katalogu): bez dowiązania launchd
    // nie otworzy pliku logu. Ponowna instalacja wpisuje log z bieżącej reguły katalogu.
    return {
      line: {
        verdict: 'bad',
        text: `service: ${SERVICE_LABEL} loaded, but the service log ${log} lies outside the data directory ${dataDir}`,
        repair: 'rarog service install',
      },
      node: found.node,
    };
  }
  return {
    line: withInstallation({ verdict: 'ok', text: `service: ${SERVICE_LABEL} loaded, node ${found.node}` },
      SERVICE_LABEL, servicePlistArgv(io)),
    node: found.node,
  };
}

/**
 * `StandardOutPath` i `StandardErrorPath` plistu usługi (szablon daje oba równe, ręczna edycja nie musi; review
 * Codexa); pusta lista, gdy plist nieczytelny (plist i węzeł sprawdza już reszta linii usługi).
 */
function serviceLogPaths(io: CliIo, home: string): string[] {
  const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', servicePlistPath(home)], {
    env: io.env, encoding: 'utf8', timeout: 10_000,
  });
  if (converted.error !== undefined || converted.status !== 0) return [];
  try {
    const plist = JSON.parse(converted.stdout) as Record<string, unknown>;
    return [plist['StandardOutPath'], plist['StandardErrorPath']]
      .filter((value): value is string => typeof value === 'string' && value !== '');
  } catch {
    return [];
  }
}

/** Katalog danych (hook, log usługi) w tym samym rozstrzygnięciu co {@link dataDirLine}; `null` przy konflikcie. */
function resolvedDataDir(io: CliIo, home: string, flag: string | undefined): string | null {
  const resolved = resolveDataDir({ env: launchdEnv(io.env), home, flag });
  return resolved.ok ? resolved.dir : null;
}

function dataDirLine(io: CliIo, home: string, flag: string | undefined): Line {
  const resolved = resolveDataDir({ env: launchdEnv(io.env), home, flag });
  if (!resolved.ok) {
    return {
      verdict: 'bad', text: 'data directory: CONFLICT — the server will not start, the hook will not write anything',
      details: dataDirConflictMessage(resolved).split('\n'),
    };
  }
  const where = `data directory: ${resolved.dir} (${resolved.source})`;
  const file = path.join(resolved.dir, DEVICES_FILENAME);
  let text: string;
  try {
    const read = readRegularFileSync(file, { maxBytes: 4 * 1024 * 1024, followSymlink: false });
    if (read === null || read.truncated) {
      return { verdict: 'bad', text: `${where}; ${DEVICES_FILENAME} is not a regular file` };
    }
    text = read.bytes.toString('utf8');
  } catch (failure) {
    const code = errnoCode(failure);
    return code === 'ENOENT'
      ? { verdict: 'unknown', text: `${where}; no ${DEVICES_FILENAME} — no server has run with this directory` }
      : { verdict: 'unknown', text: `${where}; ${DEVICES_FILENAME} unreadable (${code})` };
  }
  let serverId: unknown;
  try {
    serverId = (JSON.parse(text) as Record<string, unknown>)['serverId'];
  } catch {
    serverId = undefined;
  }
  if (typeof serverId !== 'string' || serverId === '') {
    return { verdict: 'bad', text: `${where}; ${DEVICES_FILENAME} without serverId`, repair: 'see authStore in /health' };
  }
  return { verdict: 'ok', text: `${where}; serverId ${serverId.slice(0, 8)}…` };
}

/**
 * Linia hooka: rejestracja i kopia jak w `/health`; w szczegółach znaczniki per plik wejściowy, gdy katalog
 * danych jest znany (`dataDir` = `null` przy konflikcie katalogów — wtedy pokazuje go linia katalogu danych).
 */
function hookLine(home: string, health: HealthRead | null, dataDir: string | null): Line {
  const user = inspectSettingsFile(userSettingsPath(home), expectedHookEntries(hookCommand(home)));
  const report = hookCopyReport(home);
  const status = withCopyStatus(combineStatus([user]), report);
  const origin = hookCopyOriginLine(report);
  const details = { details: dataDir === null ? [origin] : [origin, ...seenByFileLines(dataDir, Date.now())] };
  const fromHealth = health !== null && 'body' in health && typeof health.body['hook'] === 'string'
    ? health.body['hook'] : null;
  const healthNote = fromHealth !== null && fromHealth !== status ? ` (/health: ${fromHealth})` : '';
  if (status === 'ok' && healthNote !== '') {
    // Serwer liczy to samo względem SWOJEGO checkoutu i trzyma wynik sondy przez chwilę: zgoda lokalna nie wystarczy.
    return {
      verdict: 'unknown',
      text: `hook: entry and copy match this repo, but /health says ${String(fromHealth)} — the server runs from`
        + ' another checkout or holds an older probe result; run doctor again in a moment',
      ...details,
    };
  }
  if (status === 'ok') return { verdict: 'ok', text: 'hook: ok — entry and copy match the repo', ...details };
  const stale = report.files.every((one) => one.state === 'match') && report.leftovers.length > 0
    ? `the copy in ~/.claude/hooks/rarog has a leftover file from an older installation (${report.leftovers.join(', ')})`
    : 'the copy in ~/.claude/hooks/rarog differs from the repo or is missing';
  const reason = status === 'stale' ? stale
    : status === HOOK_STATUS_MISSING ? 'no entry in ~/.claude/settings.json' : (user.checkout ? HOOK_CHECKOUT_REASON
      : 'the entry exists, but differs from the one hooks:print prints');
  const repair = status === 'stale' ? HOOK_REPAIR_COPY : HOOK_REPAIR_ENTRY;
  return {
    verdict: 'bad',
    text: `hook: ${status}${healthNote} — ${reason}`,
    // Zdanie z `hooks.ts` zaczyna się od etykiety naprawy („Fix: ” itp.), a linia `doctor` ma własną (`fix:`).
    repair: `${repair.replace(/^\p{L}+: /u, '')} Details: rarog hooks doctor.`,
    ...details,
  };
}

/**
 * Pochodzenie zainstalowanej kopii hooka (krok 6 rollbacku kanału zgód: `hooks:install` z commita, do którego się
 * wraca): commit klonu albo wersja paczki z manifestu instalacji, wyłącznie gdy każdy plik kopii ma skrót zapisany
 * w manifeście. Brak katalogu kopii, brak manifestu albo plik zmieniony po instalacji = powód zamiast pochodzenia.
 */
export function hookCopyOriginLine(report: HookCopyReport): string {
  if (report.dirKind !== 'dir') return 'installed copy: origin unknown (no copy directory)';
  const manifest = report.manifest;
  if (manifest === null) return `installed copy: origin unknown (${HOOK_MANIFEST_FILENAME} missing or unreadable)`;
  const changed = report.files.filter((one) => one.copySha === null || one.copySha !== one.manifestSha);
  if (changed.length > 0) {
    return `installed copy: origin unknown (changed after installation or missing: ${
      changed.map((one) => one.name).join(', ')})`;
  }
  return `installed copy from ${hookOriginText(manifest)}, installed ${new Date(manifest.at).toISOString()}`;
}

/** Naprawa trybu `shadow` zamiast `main` według powodu z `/health`. */
const CONSENT_SHADOW_REPAIR: Readonly<Record<string, string>> = {
  'missing': 'see the hook line above; after the fix run rarog restart (the mode is computed once, at start)',
  'mismatch': 'see the hook line above; after the fix run rarog restart (the mode is computed once, at start)',
  'stale': 'see the hook line above; after the fix run rarog restart (the mode is computed once, at start)',
  'consent-socket': 'the registration socket <dataDir>/run/consent.sock did not start: look for consent: and'
    + ' admin: lines in the server log, then run rarog restart',
  'admin-socket': 'the admin socket <dataDir>/run/admin.sock did not start: look for admin: lines in the server'
    + ' log, then run rarog restart',
  'min-client-build': 'set RAROG_MIN_CLIENT_BUILD in env in ~/.config/rarog/config.json to the first app build'
    + ' that knows consent channel cards, then run rarog restart',
};

/**
 * Linia kanału zgód z pola `consent` w `/health` (`herdr/dialogs/layer1/mode.ts`): kanał otwarty (`main`, `all`)
 * równy skonfigurowanemu = zielona, tryb równy skonfigurowanemu (`off`, `shadow`) = „info”, konfiguracja `main` albo
 * `all` z `shadow` = czerwona z naprawą według powodu, wyłącznik = „uwaga” z wpisem do `config.json`,
 * rozstrzygnięcie w toku = „nie wiem”. Serwer bez pola
 * (starsza wersja) i brak `/health` = „info”: linia `/health` ocenia to sama.
 * `threshold` (from {@link thresholdOf}) adds the minimum app build and its source to the text; `undefined` = no
 * clause. The verdict does not depend on it.
 */
export function consentLineOf(health: HealthRead | null, threshold?: MinClientBuild | null): Line {
  if (health === null || 'failure' in health) return { verdict: 'info', text: 'consent channel: no /health answer' };
  const raw = health.body['consent'];
  if (!isRecord(raw) || typeof raw['configured'] !== 'string' || typeof raw['effective'] !== 'string'
    || typeof raw['reason'] !== 'string') {
    return { verdict: 'info', text: 'consent channel: the server does not report it (/health without consent)' };
  }
  const configured = raw['configured'];
  const effective = raw['effective'];
  const reason = raw['reason'];
  const where = `consent channel: ${effective} (configured ${configured}, reason ${reason})${thresholdText(threshold)}`;
  if (reason === 'killswitch') {
    return {
      verdict: 'warn', text: `${where} — off until the server restarts (rarog dialogs off)`,
      repair: 'to keep it off after a restart, set RAROG_CONSENT_CHANNEL to "off" in env in'
        + ' ~/.config/rarog/config.json, then run rarog restart',
    };
  }
  if (reason === 'starting') {
    return { verdict: 'unknown', text: `${where} — the server is starting its sockets; run doctor again in a moment` };
  }
  if (consentChannelOpen(effective) && effective === configured) return { verdict: 'ok', text: where };
  if (consentChannelOpen(configured)) {
    return {
      verdict: 'bad', text: `${where} — the channel does not run, the server falls back to shadow`,
      repair: CONSENT_SHADOW_REPAIR[reason] ?? 'check the server log, then run rarog restart',
    };
  }
  return { verdict: 'info', text: where };
}

/** Clause of the consent channel line: the minimum app build `rarog serve` takes from `config.json`. */
function thresholdText(threshold: MinClientBuild | null | undefined): string {
  if (threshold === undefined) return '';
  if (threshold === null) return `; minimum app build: none (${MIN_CLIENT_BUILD_ENV} not set)`;
  return `; minimum app build ${String(threshold.value)} (${
    threshold.source === 'default' ? 'package default' : `${MIN_CLIENT_BUILD_ENV} in config.json`})`;
}

/**
 * Minimum app build from the server environment with the same rule as the server (`config/clients.ts`): `null` = no
 * threshold, `undefined` = unknown (no environment, or a value the server refuses at start; the env line says so).
 */
export function thresholdOf(env: Readonly<Record<string, string>> | null): MinClientBuild | null | undefined {
  if (env === null) return undefined;
  const demo = env['RAROG_DEMO'] === '1' || env['RAROG_DEMO'] === 'true';
  try {
    return minClientBuildOf(env[MIN_CLIENT_BUILD_ENV], { demo }) ?? null;
  } catch {
    return undefined;
  }
}

/** Wzorzec ścieżki z ustawień sandboksa: `~/` od domu, `*` w obrębie członu, `**` przez człony. */
function socketPattern(entry: string, home: string): RegExp {
  const full = entry.startsWith('~/') ? path.join(home, entry.slice(2)) : entry;
  const body = full.replace(/\/+$/, '').split('**').map((part) => part.split('*').map(escapeRe).join('[^/]*'))
    .join('.*');
  // Wpis bez gwiazdki obejmuje samo gniazdo albo katalog nad nim.
  return new RegExp(`^${body}(?:/.*)?$`);
}

/** Wpisy `sandbox.network`, które dają agentowi w sandboksie gniazda pod `<dataDir>/run/`. */
function sandboxSocketFindings(settings: Record<string, unknown>, home: string, dataDir: string | null): string[] {
  const sandbox = isRecord(settings['sandbox']) ? settings['sandbox'] : null;
  const network = sandbox !== null && isRecord(sandbox['network']) ? sandbox['network'] : null;
  if (network === null) return [];
  const found: string[] = [];
  if (network['allowAllUnixSockets'] === true) {
    found.push('sandbox.network.allowAllUnixSockets: true — a sandboxed agent reaches every Unix socket, also'
      + ' <dataDir>/run/admin.sock (the owner\'s power: pairing, rarog dialogs)');
  }
  const entries = Array.isArray(network['allowUnixSockets']) ? network['allowUnixSockets'] : [];
  if (dataDir === null) return found;
  const sockets = [adminSocketPath(dataDir), path.join(path.dirname(adminSocketPath(dataDir)), CONSENT_SOCKET_FILENAME)];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    const pattern = socketPattern(entry.trim(), home);
    const hit = sockets.filter((socket) => pattern.test(socket));
    if (hit.length > 0) {
      found.push(`sandbox.network.allowUnixSockets: ${quoted(entry)} covers ${hit.join(' and ')} — a sandboxed`
        + ' agent with it has the owner\'s power (admin socket) or can block channel cards (registration socket)');
    }
  }
  return found;
}

/** Komendy hooków `PermissionRequest` spoza Raroga: taki hook może odpowiedzieć na ten sam dialog. */
function foreignPermissionHooks(settings: Record<string, unknown>): string[] {
  const hooks = isRecord(settings['hooks']) ? settings['hooks'] : null;
  const groups = hooks === null ? null : hooks[HOOK_PERMISSION_EVENT];
  if (!Array.isArray(groups)) return [];
  const ours = new Set(rarogHookEntries(settings).filter((one) => one.event === HOOK_PERMISSION_EVENT)
    .map((one) => one.command));
  const found: string[] = [];
  for (const group of groups) {
    const list = isRecord(group) && Array.isArray(group['hooks']) ? group['hooks'] : [];
    for (const hook of list) {
      const command = isRecord(hook) && typeof hook['command'] === 'string' ? hook['command'] : null;
      if (command === null || ours.has(command)) continue;
      const shown = command.length > 100 ? `${command.slice(0, 100)}…` : command;
      found.push(`another ${HOOK_PERMISSION_EVENT} hook: ${quoted(shown)} — it can answer the same dialog`);
    }
  }
  return found;
}

/**
 * Linia ustawień Claude Code wobec kanału zgód (`~/.claude/settings.json`, tylko odczyt): sandbox z dostępem do
 * gniazd pod `<dataDir>/run/` i drugi hook `PermissionRequest` = „uwaga”; doctor nie widzi ustawień
 * projektów, więc to ostrzeżenie, nie zabezpieczenie. Czysto albo brak pliku = „info”.
 */
export function channelSettingsLine(home: string, dataDir: string | null): Line {
  const settings = userSettingsPath(home);
  let parsed: unknown = null;
  try {
    const read = readRegularFileSync(settings, { maxBytes: 4 * 1024 * 1024, followSymlink: true });
    parsed = read === null ? null : JSON.parse(read.bytes.toString('utf8'));
  } catch (failure) {
    if (errnoCode(failure) !== 'ENOENT') {
      return { verdict: 'unknown', text: `consent channel settings: ${settings} unreadable (${errnoCode(failure)})` };
    }
  }
  if (!isRecord(parsed)) {
    return { verdict: 'info', text: `consent channel settings: no ${settings}` };
  }
  const sandbox = sandboxSocketFindings(parsed, home, dataDir);
  const foreign = foreignPermissionHooks(parsed);
  if (sandbox.length === 0 && foreign.length === 0) {
    const runDir = dataDir === null ? '<dataDir>/run' : path.dirname(adminSocketPath(dataDir));
    return {
      verdict: 'info',
      text: `consent channel settings: no sandbox access to ${runDir}/ and no other ${HOOK_PERMISSION_EVENT}`
        + ` hook in ${settings}`,
    };
  }
  const repairs = [
    ...(sandbox.length > 0 ? ['remove that sandbox entry from ~/.claude/settings.json (doctor warns, it does not'
      + ' protect: project settings stay unseen)'] : []),
    ...(foreign.length > 0 ? [`remove the other ${HOOK_PERMISSION_EVENT} hook, or expect its answers as unmatched in`
      + ' the channel audit'] : []),
  ];
  return {
    verdict: 'warn',
    text: `consent channel settings: ${[...sandbox.length > 0 ? ['sandbox reaches <dataDir>/run/'] : [],
      ...foreign.length > 0 ? [`${String(foreign.length)} other ${HOOK_PERMISSION_EVENT} hook(s)`] : []].join(', ')}`
      + ` in ${settings}`,
    details: [...sandbox, ...foreign],
    repair: repairs.join('; '),
  };
}

function statusLineLine(home: string, now: number): Line {
  const settings = userSettingsPath(home);
  let command: unknown;
  try {
    const read = readRegularFileSync(settings, { maxBytes: 4 * 1024 * 1024, followSymlink: true });
    const parsed: unknown = read === null ? null : JSON.parse(read.bytes.toString('utf8'));
    command = isRecord(parsed) && isRecord(parsed['statusLine']) ? parsed['statusLine']['command'] : undefined;
  } catch (failure) {
    const code = errnoCode(failure);
    if (code !== 'ENOENT' && !(failure instanceof SyntaxError)) {
      return { verdict: 'unknown', text: `statusLine: ${settings} unreadable (${code})` };
    }
  }
  const repair = 'run rarog setup in your own terminal: it sets statusLine in ~/.claude/settings.json to the Rarog'
    + ' script, which dumps the payload to ~/.claude/statusline/<session>.json, after one question, d shows the'
    + ' diff (block to paste instead: rarog hooks statusline)';
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      verdict: 'bad', text: 'statusLine: missing in ~/.claude/settings.json — the app will not show usage', repair,
    };
  }
  // Komenda wskazuje kopię skryptu Raroga: kopia różna od repo albo jej brak to `stale`, jak przy hooku.
  // Własna komenda użytkownika tego sprawdzenia nie dostaje — kopia skryptu jej nie dotyczy.
  if (command.includes(STATUSLINE_INSTALLED_SCRIPT_REL) && !statuslineCopyReport(home).ok) {
    return {
      verdict: 'bad',
      text: 'statusLine: stale — the command points to the script copy in ~/.claude/hooks/rarog, and the copy'
        + ' differs from the repo or is missing',
      repair: 'review rarog hooks doctor, then run rarog hooks install in your own terminal (outside the Claude'
        + ' Code sandbox)',
    };
  }
  // Ta sama reguła świeżości co pisarz ustawień (`rarog setup`, krok 7): `newestStatuslineDump` w `hook-config.ts`.
  const dir = statuslineDumpDir(home);
  const dump = newestStatuslineDump(home);
  if ('code' in dump) return { verdict: 'unknown', text: `statusLine: ${dir} unreadable (${dump.code})` };
  const { newest } = dump;
  if (newest === null) {
    return { verdict: 'unknown', text: `statusLine: command "${command}", but ${dir} has no dump` };
  }
  const age = Math.max(0, Math.round((now - newest) / 1000));
  return now - newest <= STATUSLINE_FRESH_MS
    ? { verdict: 'ok', text: `statusLine: command "${command}", last dump ${String(age)} s ago` }
    : { verdict: 'unknown', text: `statusLine: command "${command}", last dump ${String(age)} s ago (no session`
      + ' worked in the last hour?)' };
}

function herdrSocketLine(expected: Readonly<Record<string, string>> | null, home: string, start: string): Line {
  const configured = expected?.[HERDR_SOCKET_ENV] ?? '';
  const socket = configured !== '' ? configured : defaultHerdrSocket(home);
  try {
    const stats = lstatSync(socket);
    return stats.isSocket()
      ? { verdict: 'ok', text: `herdr socket: ${socket}` }
      : { verdict: 'bad', text: `herdr socket: ${socket} is not a socket`, repair: 'check RAROG_HERDR_SOCKET' };
  } catch (failure) {
    const code = errnoCode(failure);
    return code === 'ENOENT'
      ? { verdict: 'bad', text: `herdr socket: ${socket} missing — herdr is not running`, repair: start }
      : { verdict: 'unknown', text: `herdr socket: ${socket} unreadable (${code})` };
  }
}

/**
 * Pierwszy `rarog` w `PATH`. W paczce npm wejście `…/bin/rarog.mjs` innej instalacji (dowiązanie klonu
 * `~/.local/bin/rarog` przed katalogiem poleceń menedżera) = „uwaga”: `rarog` z powłoki uruchamiałby tamten kod.
 * Polecenie pnpm to skrypt sh, nie dowiązanie, więc jego wejścia stąd nie widać i nie ocenia się go.
 */
export function rarogInPathLine(io: CliIo, home: string, mode: InstallMode = INSTALL_MODE, bin = RAROG_BIN): Line {
  const dirs = (io.env['PATH'] ?? '').split(':').filter((dir) => dir !== '');
  for (const dir of dirs) {
    const candidate = path.join(dir, 'rarog');
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    let real = candidate;
    try {
      real = realpathSync(candidate);
    } catch {
      // Zostaje ścieżka w PATH.
    }
    const text = `rarog in PATH: ${candidate}${real !== candidate ? ` → ${real}` : ''}`;
    if (mode === 'package' && real.endsWith('/bin/rarog.mjs') && !sameRealpath(real, bin)) {
      return {
        verdict: 'warn', text: `${text}, but this installation is ${bin} — it shadows the package`,
        repair: `remove the other installation's symlink (rm ${candidate}) or reorder PATH`,
      };
    }
    return { verdict: 'ok', text };
  }
  if (mode === 'package') return { verdict: 'bad', text: 'rarog in PATH: missing', repair: packageBinRepair(bin) };
  const link = rarogLinkPath(home);
  if (existsSync(link)) {
    return {
      verdict: 'bad', text: `rarog in PATH: symlink ${link} exists, but ${path.dirname(link)} is not in PATH`,
      repair: `add ${path.dirname(link)} to PATH in your shell profile`,
    };
  }
  return {
    verdict: 'bad', text: 'rarog in PATH: missing',
    repair: `rarog service install creates the symlink ${link} → ${bin}; until then ${REPAIR.cli}`,
  };
}

/**
 * Naprawa braku `rarog` w `PATH` paczki: polecenie kładzie menedżer w swoim katalogu poleceń, nie `service install`
 * w `~/.local/bin`. npm: `<prefiks>/bin` ({@link npmBinDir}); pnpm: katalog z `pnpm bin -g`; menedżer nieznany = obie
 * rady.
 */
function packageBinRepair(bin: string): string {
  const root = path.dirname(path.dirname(bin));
  const manager = packageManagerOf(root);
  const npmBin = manager === 'npm' ? npmBinDir(root) : null;
  if (npmBin !== null) {
    return `add ${npmBin} (the npm bin directory: npm prefix -g, then /bin) to PATH in your shell profile`;
  }
  if (manager === 'pnpm') return 'add the pnpm bin directory (pnpm bin -g) to PATH in your shell profile';
  return 'add the package manager bin directory to PATH (npm: npm prefix -g, then /bin; pnpm: pnpm bin -g)';
}

function sameRealpath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/** Wejście linii instalacji: tryb, korzeń, dom, wersja i sprawdzenie prawa zapisu katalogu. */
export interface InstallationInput {
  readonly mode: InstallMode;
  readonly root: string;
  readonly home: string;
  readonly version: string;
  readonly writable: (dir: string) => boolean;
}

/** Prawo zapisu katalogu dla tego procesu. */
function writableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tryb i katalog tej instalacji z wersją, w paczce z menedżerem (`install/repair.ts`): „info”. Katalog pod domem to
 * dopisek (sesja agenta z zapisem w domu może zmienić kod, który usługa uruchamia poza sandboksem). W paczce katalog
 * nadrzędny bez prawa zapisu = „uwaga”: aktualizacja menedżerem padnie na EACCES.
 */
export function installationLine(input: InstallationInput): Line {
  const { mode, root, home } = input;
  const manager = mode === 'package' ? packageManagerOf(root) : null;
  const kind = mode === 'clone' ? 'repo clone' : `npm package${manager === null ? '' : ` (${manager})`}`;
  const text = `installation: ${kind} ${root}, version ${input.version}`;
  const details: string[] = [];
  if (root === home || root.startsWith(`${home}${path.sep}`)) {
    details.push(`installation directory under ${home}: a Claude Code session with write access to the home`
      + ' directory can change the code the service runs outside the sandbox'
      + (mode === 'package' ? '; Node outside the home directory (e.g. Homebrew) narrows this' : ''));
  }
  const parent = path.dirname(root);
  if (mode === 'package' && !input.writable(parent)) {
    return {
      verdict: 'warn', text, ...(details.length > 0 ? { details } : {}),
      repair: `${parent} is not writable — ${packageCommands(manager, root).update} will fail with EACCES; use a Node`
        + ' version manager (e.g. nvm), not sudo',
    };
  }
  return { verdict: 'info', text, ...(details.length > 0 ? { details } : {}) };
}

/**
 * Katalog danych z tej powłoki wobec katalogu usługi (`install/data-dir.ts`, bez katalogu logu usługi — ten
 * sprawdza linia usługi): rozjazd = czerwone, bo hook w sesjach Claude z tej powłoki liczyłby inny katalog niż
 * serwer. Wystąpienia próbnego (`--data-dir`) nie dotyczy.
 */
function withShellDataDir(line: Line, io: CliIo, home: string, flag: string | undefined): Line {
  if (flag !== undefined || line.verdict === 'bad') return line;
  const resolved = installDataDir({ home, shellEnv: io.env, serviceEnv: launchdEnv(io.env),
    reinstall: rarogCli('service install') });
  if (resolved.ok) return line;
  return {
    verdict: 'bad', text: `${line.text}; this shell computes a different directory`, details: [resolved.message],
    repair: 'run Claude sessions and rarog without the data directory variables of this shell',
  };
}

// ---------------------------------------------------------------------------
// Nasłuch iroh
// ---------------------------------------------------------------------------

const ADMIN_TIMEOUT_MS = 3_000;
/** Sufit odpowiedzi gniazda administracyjnego: stan nasłuchu to kilkaset bajtów. */
const ADMIN_MAX_BYTES = 256 * 1024;
/** Skrót EndpointId w linii, jak etykieta `iroh:<id>` w logach serwera. */
const SHORT_ENDPOINT_ID = 12;
/**
 * How long to wait for the first contact with the relay before the line turns into a warning. Until then the
 * library retries the connection itself, so no contact is not an error yet.
 */
const RELAY_CONTACT_WAIT_S = 120;

/** Odpowiedź gniazda administracyjnego: status z ciałem JSON (`null` = nie obiekt) albo kod błędu połączenia. */
export type AdminRead =
  | { readonly status: number; readonly body: Record<string, unknown> | null }
  | { readonly failure: string; readonly denied: boolean };

/** `GET` przez gniazdo administracyjne serwera (`<dataDir>/run/admin.sock`); ciało JSON albo `null`. */
function readAdmin(socketPath: string, route: string): Promise<AdminRead> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: AdminRead): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (failure: unknown): void => {
      const code = errnoCode(failure);
      settle({ failure: code, denied: code === 'EACCES' || code === 'EPERM' });
    };
    const req = http.request({ socketPath, path: route, method: 'GET', timeout: ADMIN_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= ADMIN_MAX_BYTES) {
          chunks.push(chunk);
          return;
        }
        fail(Object.assign(new Error('response too large'), { code: 'E2BIG' }));
        req.destroy();
      });
      res.on('end', () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsed = null;
        }
        settle({ status: res.statusCode ?? 0, body: isRecord(parsed) ? parsed : null });
      });
      res.on('error', fail);
      // Połączenie zerwane po nagłówkach nie daje ani `end`, ani `error` żądania (Node 22: samo
      // `aborted` i `close`), a obietnica bez rozstrzygnięcia kończy `doctor` kodem 13 bez raportu.
      res.on('close', () => {
        if (!res.complete) fail(Object.assign(new Error('response cut off'), { code: 'ECONNRESET' }));
      });
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    req.on('error', fail);
    req.end();
  });
}

/** Moduł natywny z manifestów albo powód, czemu nie wiadomo. */
export type IrohModuleRead = IrohModuleInfo | { readonly failure: string };

/** Paczka i moduł platformy z manifestów (bez ładowania kodu natywnego) albo powód, czemu nie wiadomo. */
function moduleInfo(): IrohModuleRead {
  try {
    return irohModuleInfo();
  } catch (failure) {
    return { failure: failure instanceof Error ? failure.message : String(failure) };
  }
}

/**
 * The native module's description for the line and whether it looks ready (the manifests of the package and of the
 * platform package are on disk). The same description picks the transport in `rarog setup`.
 */
export function describeModule(info: IrohModuleRead): { text: string; ready: boolean } {
  if ('failure' in info) return { text: `package manifest ${IROH_PACKAGE} unreadable (${info.failure})`, ready: false };
  if (info.version === null) return { text: `package ${IROH_PACKAGE} missing`, ready: false };
  const main = `package ${IROH_PACKAGE} ${info.version}`;
  if (info.platformPackage === null) return { text: `${main}, but ${irohPlatform()} has no native module`, ready: false };
  if (info.platformVersion === null) return { text: `${main}, but ${info.platformPackage} is missing`, ready: false };
  return { text: `${main}, module ${info.platformPackage} ${info.platformVersion}`, ready: true };
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/**
 * The listener runs (`enabled: true` from the server): green with a relay, yellow without a relay address. The sign
 * that the relay admitted the server is the first contact (`relayContact.firstContactAt`, the library's `online()`
 * resolved): without it the line waits {@link RELAY_CONTACT_WAIT_S} s as `info`, then it is a warning. A server
 * without the field (older code) and a server after the contact get the line from the home relay address.
 */
function listeningLine(status: Record<string, unknown>, configured: boolean, now: number): Line {
  const id = typeof status['endpointId'] === 'string' ? status['endpointId'] : '?';
  const home = isRecord(status['homeRelay']) ? status['homeRelay'] : {};
  const relays = strings(home['relays']);
  const since = typeof home['since'] === 'string' ? Date.parse(home['since']) : Number.NaN;
  const age = Number.isNaN(since) ? null : Math.max(0, Math.round((now - since) / 1000));
  const conns = isRecord(status['connections']) ? status['connections'] : {};
  const connText = `connections: ${String(count(conns['authenticated']))} with a device,`
    + ` ${String(count(conns['unauthenticated']))} without`;
  const sockets = strings(status['boundSockets']);
  const details: string[] = [];
  if (!configured) details.push(`the config has no ${IROH_ENV}=1 — after a restart the server will not listen on iroh`);
  const pending = count(status['pendingCloseOps']);
  if (pending > 0) {
    details.push(`stream close operations in progress: ${String(pending)} (growing between doctor runs =`
      + ' the library is stuck)');
  }
  const head = `iroh: listener running, EndpointId ${id.slice(0, SHORT_ENDPOINT_ID)}…`;
  const contact = isRecord(status['relayContact']) ? status['relayContact'] : null;
  const startedAt = typeof contact?.['startedAt'] === 'string' ? Date.parse(contact['startedAt']) : Number.NaN;
  if (contact !== null && contact['firstContactAt'] === null && !Number.isNaN(startedAt)) {
    const waited = Math.max(0, Math.round((now - startedAt) / 1000));
    const relayName = typeof status['relay'] === 'string' ? status['relay'] : '?';
    if (waited < RELAY_CONTACT_WAIT_S) {
      return {
        verdict: 'info',
        text: `${head}, waiting for the first contact with relay ${relayName} (${String(waited)} s since start);`
          + ` ${connText}`,
        ...(details.length > 0 ? { details } : {}),
      };
    }
    return {
      verdict: 'warn',
      text: `${head}, but relay ${relayName} has not accepted the connection for ${String(waited)} s; ${connText}`,
      details: ['until the first contact with the relay only devices with a direct UDP path connect', ...details],
      repair: `check the address in ${IROH_RELAY_ENV} (DNS, HTTPS, firewall); a relay that admits only registered`
        + ' servers lets this server in after a device pairs with it (rarog pair)',
    };
  }
  if (relays.length > 0) {
    return {
      verdict: 'ok',
      text: `${head}, relay ${relays.join(' ')} (${age === null ? 'no events since start' : `last event`
        + ` ${String(age)} s ago`}), ${connText}${sockets.length > 0 ? `, UDP ${sockets.join(' ')}` : ''}`,
      ...(details.length > 0 ? { details } : {}),
    };
  }
  const relay = typeof status['relay'] === 'string' ? ` ${status['relay']}` : '';
  return {
    verdict: 'warn',
    text: `${head}, but no relay address ${age === null ? 'since server start' : `for ${String(age)} s`}; ${connText}`,
    details: [
      `the iroh library reports only the relay address, not the connection state: a missing address is the only`
        + ` sign that relay${relay} is unreachable (right after start, contact takes a few seconds)`,
      ...details,
    ],
    repair: `check ${IROH_RELAY_ENV} and the route to the relay (DNS, HTTPS, firewall); without a relay only`
      + ' devices with a direct UDP path connect; run rarog doctor again in a moment',
  };
}

/** Wejście linii „iroh” ({@link irohLineOf}). */
export interface IrohLineInput {
  /** `RAROG_IROH` z oczekiwanego środowiska serwera, bez białych znaków na brzegach. */
  readonly flag: string;
  /** `<dataDir>/run/admin.sock`; `null` = katalog danych w konflikcie. */
  readonly socket: string | null;
  /** Odpowiedź `GET /api/admin/iroh`; `null`, gdy nie było gdzie pytać. */
  readonly read: AdminRead | null;
  /** Moduł natywny z manifestów; wołane tylko wtedy, gdy linia go pokazuje. */
  readonly module: () => IrohModuleRead;
  readonly now: number;
}

/**
 * Linia „iroh” (`docs/server-config.md`, „iroh listener”): stan z `GET /api/admin/iroh` żywego serwera (bez klucza; doctor nie czyta
 * `RAROG_IROH_KEY` ani pliku klucza) i flaga z konfiguracji. Wyłączone = „info” z paczką z manifestu; włączone
 * i słucha = zielone albo żółte (bez adresu relaya); włączone bez nasłuchu albo modułu = czerwone. Gniazdo
 * niedostępne (sandbox) przy włączonym = „nie wiem”.
 */
export function irohLineOf(input: IrohLineInput): Line {
  const { flag, socket, read, now } = input;
  if (flag !== '' && flag !== '0' && flag !== '1') {
    return {
      verdict: 'bad', text: `iroh: ${IROH_ENV}=${flag} — the server accepts 1 or 0 and will not start`,
      repair: 'fix ~/.config/rarog/config.json',
    };
  }
  const configured = flag === '1';
  if (read !== null && 'status' in read && read.status === 200 && read.body?.['enabled'] === true) {
    return listeningLine(read.body, configured, now);
  }
  if (!configured) {
    return { verdict: 'info', text: `iroh: off (${IROH_ENV} is not 1); ${describeModule(input.module()).text}` };
  }
  if (socket === null || read === null) {
    return {
      verdict: 'unknown',
      text: `iroh: ${IROH_ENV}=1, but the data directory is in conflict — admin socket location unknown`,
    };
  }
  if ('failure' in read && read.denied) {
    return {
      verdict: 'unknown',
      text: `iroh: ${IROH_ENV}=1, admin socket ${socket} not accessible (${read.failure}) — inside an agent`
        + ' session sandbox, run doctor in a regular terminal',
    };
  }
  const reason = 'failure' in read
    ? `the server does not respond on the admin socket ${socket} (${read.failure})`
    : read.status === 404 ? 'the server does not know GET /api/admin/iroh (code older than the iroh listener)'
      : read.status === 200 && read.body?.['enabled'] === false
        ? 'the server runs without the iroh listener (started before the config change?)'
        : `GET /api/admin/iroh: HTTP ${String(read.status)} without listener state`;
  const module = describeModule(input.module());
  if (!module.ready) {
    return {
      verdict: 'bad', text: `iroh: ${IROH_ENV}=1, but the native module is missing: ${module.text}`, details: [reason],
      repair: `${REPAIR.dependencies}${INSTALL_MODE === 'clone' ? ' in the repo' : ''}, then rarog serve --check`
        + ` (loads the module) and rarog restart; an Intel Mac has no module: ${IROH_ENV}=0`,
    };
  }
  return {
    verdict: 'bad', text: `iroh: ${IROH_ENV}=1, but no listener — ${reason}`,
    repair: 'rarog serve --check (loads the native module), then rarog restart; the start failure cause is in'
      + ' server.log in the data directory',
  };
}

/** Wejście linii „SDK” ({@link sdkLineOf}). */
export interface SdkLineInput {
  readonly mode: InstallMode;
  /** Wersja przypięta tej instalacji. */
  readonly pinned: string;
  /** Katalog danych; `null` = konflikt katalogów. */
  readonly dataDir: string | null;
  /** Wersje w `<katalog danych>/sdk/` z rozmiarem, od najnowszej. */
  readonly versions: readonly { readonly version: string; readonly bytes: number }[];
  /** Sonda przypiętej wersji; `null`, gdy jej katalogu nie ma. */
  readonly probe: SdkProbeResult | null;
  /** Pole `sdk` z `/health` żywego serwera; `null` = brak odpowiedzi albo pola. */
  readonly health: string | null;
}

const sizeText = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * Linia „SDK”: SDK Claude listy sesji (`install/sdk.ts`). Klon repo: z workspace. Paczka: wersja wymagana, katalog,
 * obecność, wynik sondy, pozostałe wersje z rozmiarem (bez porady kasowania: stary katalog może czytać działający
 * proces albo poprzednia wersja Raroga po powrocie) i stan z `/health`. Brak albo błąd = czerwona z `rarog setup`;
 * pobrany SDK przy serwerze, który mówi coś innego niż `ok` = czerwona z `rarog restart`.
 */
export function sdkLineOf(input: SdkLineInput): Line {
  const { mode, pinned, dataDir, versions, probe, health } = input;
  const fromHealth = health === null ? '' : ` (/health: ${health})`;
  if (mode === 'clone') {
    // `missing` w klonie mówi tylko serwer demo (SDK nie ładuje), więc czerwone jest wyłącznie `error`.
    if (health === 'error') {
      return {
        verdict: 'bad', text: `SDK: from the workspace, but the server says /health sdk: ${health}`,
        repair: `${REPAIR.dependencies}, then rarog restart; cause in the "sdk:" line of server.log in the data`
          + ' directory',
      };
    }
    return { verdict: 'ok', text: `SDK: from the workspace (${SDK_PACKAGE} ${pinned})${fromHealth}` };
  }
  if (dataDir === null) {
    return { verdict: 'unknown', text: `SDK ${pinned}: data directory in conflict — location unknown` };
  }
  const dir = sdkVersionDir(dataDir, pinned);
  const others = versions.filter((entry) => entry.version !== pinned);
  const details = others.length === 0 ? [] : [`other versions in ${path.dirname(dir)}: ${others
    .map((entry) => `${entry.version} (${sizeText(entry.bytes)})`).join(', ')}`];
  const setup = rarogCli('setup', mode);
  const present = versions.find((entry) => entry.version === pinned);
  if (present === undefined) {
    const installed = others[0]?.version;
    return {
      verdict: 'bad',
      text: installed === undefined
        ? `SDK ${pinned}: missing in ${dir} — the Recent sessions list in the app is empty${fromHealth}`
        : `SDK ${pinned} missing, ${installed} installed — after a restart the server runs the old SDK${fromHealth}`,
      details, repair: setup,
    };
  }
  if (probe !== null && !probe.ok) {
    return {
      verdict: 'bad', text: `SDK ${pinned} (${dir}): probe failed — ${probe.reason}${fromHealth}`, details,
      repair: `${setup} (shows the directory state; does not change an existing one)`,
    };
  }
  if (health !== null && health !== 'ok') {
    return {
      verdict: 'bad', text: `SDK ${pinned} downloaded (${dir}), but the server says /health sdk: ${health} — it`
        + ' started before the download or with another data directory', details, repair: rarogCli('restart', mode),
    };
  }
  return { verdict: 'ok', text: `SDK ${pinned}: ${dir} (${sizeText(present.bytes)})${fromHealth}`, details };
}

/** Linia „SDK” z odczytem katalogu i sondą w osobnym procesie na środowisku usługi. */
export async function sdkLine(
  dataDir: string | null, health: HealthRead | null, env: NodeJS.ProcessEnv, mode: InstallMode = INSTALL_MODE,
): Promise<Line> {
  let pinned: string;
  try {
    pinned = readSdkPin().version;
  } catch (failure) {
    return { verdict: 'bad', text: `SDK: pin unreadable (${failure instanceof Error ? failure.message : '?'})` };
  }
  const versions = mode === 'package' && dataDir !== null
    ? sdkVersions(dataDir).map((version) => ({ version, bytes: treeBytes(sdkVersionDir(dataDir, version)) }))
    : [];
  const probe = dataDir !== null && versions.some((entry) => entry.version === pinned)
    ? await probeCheckedSdkDir(dataDir, pinned, (dir, version) => probeSdkDir(dir, version, env))
    : null;
  const field = health !== null && 'body' in health ? health.body['sdk'] : undefined;
  return sdkLineOf({ mode, pinned, dataDir, versions, probe, health: typeof field === 'string' ? field : null });
}

/** Linia „iroh” z odczytem: gniazdo administracyjne pytane zawsze, gdy katalog danych jest znany. */
async function irohLine(built: ServeEnv | null, dataDir: string | null, now: number): Promise<Line> {
  const socket = dataDir === null ? null : adminSocketPath(dataDir);
  const read = socket === null ? null : await readAdmin(socket, '/api/admin/iroh');
  return irohLineOf({ flag: (built?.env[IROH_ENV] ?? '').trim(), socket, read, module: moduleInfo, now });
}

// ---------------------------------------------------------------------------
// Komenda
// ---------------------------------------------------------------------------

function portOf(flags: DoctorFlags, built: ServeEnv | null): number | null {
  const raw = flags.port ?? built?.env['RAROG_PORT'] ?? '';
  if (raw === '') return DEFAULT_PORT;
  return /^[0-9]{1,5}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 65535 ? Number(raw) : null;
}

function print(io: CliIo, lines: readonly Line[]): void {
  for (const line of lines) {
    out(io, `${MARK[line.verdict]}  ${line.text}`);
    for (const detail of line.details ?? []) out(io, `            ${detail}`);
    if (line.repair !== undefined && (line.verdict === 'bad' || line.verdict === 'warn')) {
      out(io, `            fix: ${line.repair}`);
    }
  }
}

/** Środowisko bez zmiennych katalogu danych (`PROCESS_NAMES`). */
function withoutProcessNames(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const name of PROCESS_NAMES) Reflect.deleteProperty(result, name);
  return result;
}

/** `rarog doctor` — `argv` zaczyna się od `doctor`. */
export async function doctorCommand(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(io, usageFor(io, `Usage:\n${DOCTOR_USAGE}`));
    return EXIT_OK;
  }
  const flags = parseDoctorFlags(argv, io.cwd);
  const home = homeOf(io.env);
  const platform = platformOf(io);
  // Linux: serwer dostaje środowisko menedżera użytkownika (rarog serve pod systemd --user), więc z niego liczymy
  // oczekiwane — ale bez zmiennych katalogu danych, jak na macOS: hook liczy katalog bez nich, więc niepusta w serwerze
  // ma wyjść różnicą, a nie zgodą z menedżerem. Bez magistrali port i gniazdo herdr bierzemy jak na macOS, a linia
  // środowiska mówi „nie wiem”.
  const manager = platform === 'linux' ? managerEnvironment(io) : null;
  const base = manager !== null && 'env' in manager ? withoutProcessNames(manager.env) : launchdEnv(io.env);
  let built: ServeEnv | null = null;
  let configIssue: string | null = null;
  try {
    built = buildServeEnv(base, {
      env: {}, mode: 'check',
      ...(flags.port !== undefined ? { port: flags.port } : {}),
      ...(flags.dataDir !== undefined ? { dataDir: flags.dataDir } : {}),
    });
  } catch (failure) {
    if (!(failure instanceof Refusal)) throw failure;
    configIssue = failure.message;
  }
  const port = portOf(flags, built);
  const health = port === null ? null : await readHealth(port);
  const dataDir = resolvedDataDir(io, home, flags.dataDir);
  // Usługa pracuje na katalogu z reguły, nie na `--data-dir` wystąpienia próbnego.
  const service = serviceLine(io, home, resolvedDataDir(io, home, undefined));
  // `PATH` usługi liczy `rarog serve` z katalogu SWOJEGO węzła — tego z plistu (z `ExecStart`), gdy usługa jest.
  const expectedPath = servePath(service.node ?? process.execPath, platform);
  const managerFailure = manager !== null && 'failure' in manager ? manager.failure : null;
  const lines: Line[] = [
    installationLine({ mode: INSTALL_MODE, root: INSTALL_ROOT, home, version: RAROG_VERSION, writable: writableDir }),
    healthLine(port, health, built?.env['RAROG_TERM'] === '1'),
    service.line,
    withShellDataDir(dataDirLine(io, home, flags.dataDir), io, home, flags.dataDir),
    await sdkLine(dataDir, health, base),
    envLine(io, built, configIssue, port, expectedPath, managerFailure),
    await irohLine(built, dataDir, Date.now()),
    hookLine(home, health, dataDir),
    consentLineOf(health, thresholdOf(built?.env ?? null)),
    channelSettingsLine(home, dataDir),
    ...await noHookLines(dataDir, Date.now()),
    writeBlockLine(io, home, platform, manager, flags.dataDir),
    statusLineLine(home, Date.now()),
    // A loaded herdr agent starts herdr with `launchctl kickstart` (`setup-herdr-agent.ts`).
    herdrSocketLine(built?.env ?? null, home, herdrAgentStart(io, home, platform) ?? 'start herdr'),
    ...await herdrAgentDoctorLine(io, home, platform, built?.env ?? null).then((one) => (one === null ? [] : [one])),
    rarogInPathLine(io, home),
    await prStatusLine(built?.env ?? null),
  ];
  out(io, `rarog doctor — port ${port === null ? '?' : String(port)}`
    + `${flags.dataDir !== undefined ? `, data directory ${flags.dataDir}` : ''}:`);
  print(io, lines);
  const tally = (verdict: Verdict): number => lines.filter((line) => line.verdict === verdict).length;
  out(io, `result: ok ${String(tally('ok'))}, ERROR ${String(tally('bad'))},`
    + ` unknown ${String(tally('unknown'))}, warn ${String(tally('warn'))}`);
  return tally('ok') + tally('info') === lines.length ? EXIT_OK : EXIT_REFUSED;
}
