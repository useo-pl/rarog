/**
 * `rarog restart`: cienki front przed `scripts/restart.sh`,
 * który zostaje wykonawcą (stop po porcie i wzorcach, ochrona serwera demo, start, health z kodami 2 i 3). Front
 * bierze blokadę `~/.config/rarog/lock`, ustala stan usługi launchd ({@link loadState}) i wybiera parametry
 * `restart.sh`:
 *
 * - stan `ai.rarog.server` „nie wiem” (`launchctl print` z kodem innym niż 0 i 113) → odmowa;
 * - `ai.rarog.server` załadowana → zmienne katalogu danych puste w tej powłoce i w domenie launchd
 *   ({@link refuseLaunchdDataDirEnv}), `serve --check` (zła konfiguracja = odmowa BEZ zatrzymania serwera; przy
 *   `RAROG_IROH=1` moduł natywny iroh ładuje się bez wiązania portu, a z kluczem niesprawdzonym dochodzi pełne
 *   `serve --check` przez `service.wrapper`), cel usługi z `ProgramArguments` plistu to ta instalacja
 *   ({@link checkServiceInstallation}), plik node usługi istnieje i ma wersję z {@link nodeVersionOk}, katalog danych
 *   z tej powłoki to katalog usługi ({@link refuseDataDirMismatch}), potem `restart.sh` z `RAROG_RESTART_LABEL`,
 *   `RAROG_RESTART_PORT` i `RAROG_LOG=<dataDir>/server.log`;
 * - usługi nie ma: `config.json` nie ma → odmowa z „`rarog setup`”; jest → odmowa przy
 *   `service.wrapper` bez sekretów w środowisku (bez usługi serwer nie dostanie sekretów) i przy Node bez
 *   `process.execve`, inaczej `serve --check` i `restart.sh` z parametrem wyboru `RAROG_RESTART_SERVE=rarog`
 *   (start `nohup node bin/rarog.mjs serve`). Odmowa także wtedy, gdy gniazdo administracyjne
 *   katalogu danych żyje, a port z konfiguracji milczy: serwer tych danych chodzi na innym porcie (zmieniony
 *   `RAROG_PORT`), a `restart.sh` zatrzymuje tylko serwer portu z konfiguracji — stary zostałby obok nowego.
 *
 * Na Linuksie jedyną drogą startu jest jednostka `systemd --user` `rarog.service`
 * ({@link decideLinux}): bez jednostki odmowa z „`rarog service install`” (z `config.json` i bez, nigdy `nohup` obok
 * cudzego nadzorcy), a przy jednostce `restart.sh` dostaje `RAROG_RESTART_UNIT`. Inna platforma = odmowa.
 *
 * Każda odmowa pada PRZED `restart.sh`, czyli zanim cokolwiek się zatrzyma.
 *
 * `restart.sh` biegnie jako proces potomny (`runChild` z `child-output.ts`: bez ujścia wyjście na ten sam terminal,
 * z ujściem `RestartDeps.output` tylko do ujścia), a nie przez `exec`: blokada
 * trzyma PID tego procesu i zdejmuje się po zakończeniu skryptu. Parametry `RAROG_RESTART_*` z rodzica nie
 * przechodzą — ustawia je wyłącznie ten front. Każde wywołanie dostaje też `RAROG_RESTART_HOOK_REPAIR`: zdanie
 * naprawy kopii hooka, które `restart.sh` wypisuje przy `hook: stale` ({@link scriptEnv}).
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { adminSocketPath } from '../auth/admin.ts';
import { IROH_ENV, IROH_KEY_ENV } from '../config-env.ts';
import { installDataDir } from '../install/data-dir.ts';
import { INSTALL_MODE, INSTALL_ROOT, installModeAt } from '../install/mode.ts';
import type { InstallMode } from '../install/mode.ts';
import { REPAIR, RESTART_HOOK_REPAIR, installationCli, rarogCli } from '../install/repair.ts';
import { RAROG_BIN, serviceArgv, serviceArgvNode, serviceInstallation } from '../install/service-target.ts';
import type { ServiceTarget } from '../install/service-target.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { RAROG_VERSION } from '../version.ts';
import { EXIT_INTERRUPTED, childExitText, runChild } from './child-output.ts';
import type { ChildResult, ChildSink } from './child-output.ts';
import { acquireLock } from './lock.ts';
import { EXIT_OK, EXIT_REFUSED, Refusal, Usage, err, homeOf, out, platformOf } from './io.ts';
import type { CliIo } from './io.ts';
import {
  IROH_KEY_UNCHECKED_LINE, PROCESS_NAMES, buildServeEnv, checkServeEnv, rarogConfigDir, readRarogConfig,
} from './serve.ts';
import type { ServeEnv, ServeFlags, ServeSdkCheck } from './serve.ts';
import {
  UNIT_ENV_PROPS, UNIT_NAME, UNIT_STATE_PROPS, classifyUnit, managerEnvironment, parseExecStart, showUnit, unitFilePath,
} from './systemd-unit.ts';
import { usageFor } from './screen/prose.ts';

export const RESTART_USAGE = `  rarog restart
      Restarts the server through scripts/restart.sh (stop, start, health) with parameters from the launchd
      service (macOS) or the systemd --user unit rarog.service (Linux) and ~/.config/rarog${INSTALL_MODE === 'clone'
        ? `; \`${REPAIR.restart}\` does the same` : ''}.`;

/** Usługa `rarog service install`, startuje `rarog serve`. */
export const SERVICE_LABEL = 'ai.rarog.server';
/** Parametry `restart.sh` ustawiane wyłącznie przez ten front. */
export const RESTART_PARAMS = [
  'RAROG_RESTART_LABEL', 'RAROG_RESTART_PORT', 'RAROG_RESTART_SERVE', 'RAROG_RESTART_UNIT', 'RAROG_RESTART_HOOK_REPAIR',
] as const;
const RESTART_SCRIPT = 'scripts/restart.sh';
/** Name of the script in error sentences. */
export const RESTART_SCRIPT_NAME = 'restart.sh';
/** Najstarszy Node 22 z `process.execve`. */
export const MIN_NODE_MINOR = 15;
/** Linia 23 ma `process.execve` od 23.11 (22.15 to przeniesienie z niej), więc 23.0–23.10 go nie mają. */
export const MIN_NODE_23_MINOR = 11;
/**
 * Najwyższa linia Node węzła usługi; `null` = każda linia od 22.15. Ta sama granica co bramka `bin/rarog.mjs`
 * i `engines` w `package.json` (pilnuje tego `server/test/install-mode.test.ts`), więc zmienia się razem z nimi.
 */
export const NODE_MAX_MAJOR: number | null = null;

/** Wymaganie węzła usługi w zdaniu komunikatu: `22.x ≥ 22.15` albo `≥ 22.15, 23.x ≥ 23.11`. */
export function nodeRequirement(maxMajor: number | null = NODE_MAX_MAJOR): string {
  const min = `22.${String(MIN_NODE_MINOR)}`;
  if (maxMajor === 22) return `22.x ≥ ${min}`;
  const line23 = `23.x ≥ 23.${String(MIN_NODE_23_MINOR)}`;
  return maxMajor === null ? `≥ ${min}, ${line23}` : `${min}–${String(maxMajor)}.x, ${line23}`;
}

/**
 * Czy wersja (`v22.22.3` albo `22.22.3`) ma `process.execve` (22.15 i nowsze, w linii 23 od 23.11) i jest najwyżej
 * z linii `maxMajor` (`null` = bez sufitu).
 */
export function nodeVersionOk(version: string, maxMajor: number | null = NODE_MAX_MAJOR): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 22 || (major === 22 && minor < MIN_NODE_MINOR)) return false;
  if (major === 23 && minor < MIN_NODE_23_MINOR) return false;
  return maxMajor === null || major <= maxMajor;
}

/** Czy wersja spełnia {@link nodeRequirement} — węzeł, na którym działa `rarog serve` (`execve`). */
export function serviceNodeVersionOk(version: string): boolean {
  return nodeVersionOk(version);
}

/** Domena GUI użytkownika tego procesu (`gui/<uid>`); `null` bez `getuid` (poza POSIX). */
export function launchdDomain(): string | null {
  const uid = process.getuid?.();
  return uid === undefined ? null : `gui/${String(uid)}`;
}

/** Cel `launchctl` etykiety w domenie GUI użytkownika tego procesu; `null` bez `getuid` (poza POSIX). */
export function launchdTarget(label: string): string | null {
  const domain = launchdDomain();
  return domain === null ? null : `${domain}/${label}`;
}

/** Plik usługi `ai.rarog.server` w katalogu LaunchAgents użytkownika. */
export function servicePlistPath(home: string): string {
  return path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

/** `PATH`, z którym launchd startuje LaunchAgenta bez `EnvironmentVariables`. */
export const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** Przepustki ze środowiska instalacji do środowiska „jak pod launchd” (faza 0, sprawdzenie przez wrapper). */
const LAUNCHD_PASSTHROUGH = ['USER', 'LOGNAME', 'SHELL', 'TMPDIR'] as const;

/** Środowisko „jak pod launchd”: dom, kilka przepustek i systemowy `PATH`, bez reszty powłoki instalacji. */
export function launchdEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { HOME: homeOf(env), PATH: LAUNCHD_PATH };
  for (const name of LAUNCHD_PASSTHROUGH) {
    const value = env[name];
    if (value !== undefined && value !== '') result[name] = value;
  }
  return result;
}

/**
 * Kod `launchctl print` dla etykiety, której domena nie zna (stderr „Bad request.”, „Could not find service”);
 * zmierzone na macOS 27 w sandboksie sesji agenta i poza nim. Inny niezerowy kod (np. 125 dla cudzej domeny) nie
 * znaczy „brak”.
 */
export const LAUNCHCTL_NO_SERVICE = 113;

/** Stan etykiety w domenie launchd: załadowana, brak albo „nie wiem” z powodem. */
export type LoadState = 'loaded' | 'absent' | { readonly unknown: string };

/**
 * Stan etykiety w domenie GUI użytkownika (`launchctl print`) — jedna reguła dla `restart`, `service` i `doctor`:
 * kod 0 = załadowana, 113 = brak, każdy inny kod, sygnał, timeout albo błąd uruchomienia = „nie wiem” z powodem.
 * Poza macOS, bez `getuid` i bez `launchctl` w `PATH` (ENOENT) = brak: launchd tam nie ma (Linux ma własną drogę,
 * jednostkę `systemd --user`, {@link decideLinux}).
 */
export function loadState(label: string, io: CliIo, platform: NodeJS.Platform = process.platform): LoadState {
  if (platform !== 'darwin') return 'absent';
  const target = launchdTarget(label);
  if (target === null) return 'absent';
  return printedLoadState(spawnSync('launchctl', ['print', target], {
    env: io.env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 10_000,
  }));
}

/**
 * The {@link loadState} of one finished `launchctl print <target>`: exit status 0 = loaded, 113 = absent, no
 * `launchctl` (ENOENT) = absent, anything else = unknown with the exit status or signal and the first stderr line.
 * The loaded definition (`launchd-loaded.ts`) applies the same rule to its own call.
 */
export function printedLoadState(result: SpawnSyncReturns<string>): LoadState {
  if (result.error !== undefined) {
    return (result.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : { unknown: result.error.message };
  }
  if (result.status === 0) return 'loaded';
  if (result.status === LAUNCHCTL_NO_SERVICE) return 'absent';
  const stderr = (result.stderr.trim().split('\n')[0] ?? '').trim();
  const how = result.status === null ? `signal ${String(result.signal)}` : `exit status ${String(result.status)}`;
  return { unknown: `${how}${stderr !== '' ? `, ${stderr}` : ''}` };
}

/**
 * {@link loadState} przed krokiem, który coś zatrzymuje albo ładuje: „nie wiem” = odmowa z powodem, bo zły domysł
 * pominąłby `bootout` albo postawił drugiego nadzorcę obok załadowanej usługi.
 */
export function decidedLoadState(label: string, io: CliIo): 'loaded' | 'absent' {
  const state = loadState(label, io);
  if (typeof state === 'string') return state;
  throw new Refusal(`launchctl print ${launchdTarget(label) ?? label} does not tell whether ${label} is loaded`
    + ` (${state.unknown}); only exit status 0 (loaded) or ${String(LAUNCHCTL_NO_SERVICE)} (absent) decides.`
    + ' Nothing was stopped; check this command in a regular terminal and try again.');
}

/** Plist usługi jako obiekt (`plutil -convert json`) albo powód, czemu go nie ma. */
function readServicePlist(
  io: CliIo, home: string = homeOf(io.env),
): { readonly plist: Readonly<Record<string, unknown>> } | { readonly issue: string } {
  const file = servicePlistPath(home);
  if (!existsSync(file)) {
    return { issue: `${file} missing — service ${SERVICE_LABEL} is loaded without its file; install it again.` };
  }
  const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], {
    env: io.env, encoding: 'utf8', timeout: 10_000,
  });
  if (converted.error !== undefined || converted.status !== 0) return { issue: `cannot read ${file} (plutil).` };
  try {
    const parsed: unknown = JSON.parse(converted.stdout);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { plist: parsed as Record<string, unknown> };
    }
  } catch {
    // Niżej, jak każdy wynik spoza obiektu.
  }
  return { issue: `${file}: plutil returned non-JSON.` };
}

/** `ProgramArguments` plistu usługi z wejściem `…/bin/rarog.mjs` i węzłem przed nim, albo powód odmowy. */
export function servicePlistArgv(io: CliIo): { readonly argv: readonly string[] } | { readonly issue: string } {
  const file = servicePlistPath(homeOf(io.env));
  const read = readServicePlist(io);
  if ('issue' in read) return read;
  const args = read.plist['ProgramArguments'];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return { issue: `${file}: no ProgramArguments list.` };
  }
  if (serviceArgvNode(args) === undefined) return { issue: `${file}: ProgramArguments has no "<node> …/bin/rarog.mjs".` };
  return { argv: args };
}

/**
 * Węzeł z `ProgramArguments` plistu usługi (element tuż przed `…/bin/rarog.mjs`), sprawdzony: plik istnieje, jest
 * wykonywalny i ma wersję z {@link nodeVersionOk} — `nvm uninstall` tej wersji zabiłby usługę po restarcie, więc
 * odmowa idzie PRZED zatrzymaniem serwera.
 */
export function serviceNode(io: CliIo): { readonly node: string } | { readonly issue: string } {
  const found = servicePlistArgv(io);
  return 'issue' in found ? found : checkedNode(found.argv, io);
}

/** Węzeł argv usługi (z {@link servicePlistArgv} albo {@link unitArgv}) po {@link nodeFileIssue}. */
function checkedNode(argv: readonly string[], io: CliIo): { readonly node: string } | { readonly issue: string } {
  const node = serviceArgvNode(argv) ?? '';
  const issue = nodeFileIssue(node, io);
  return issue === null ? { node } : { issue };
}

/** Plik węzła usługi istnieje, jest wykonywalny i ma wersję z {@link nodeVersionOk}; `null` = w porządku. */
function nodeFileIssue(node: string, io: CliIo): string | null {
  try {
    accessSync(node, constants.X_OK);
  } catch {
    return `service node file ${node} does not exist or is not executable (nvm uninstall?) — install the service`
      + ` again with Node ${nodeRequirement()}.`;
  }
  const version = spawnSync(node, ['--version'], { env: io.env, encoding: 'utf8', timeout: 10_000 });
  if (!serviceNodeVersionOk(version.stdout ?? '')) {
    return `service node ${node} is ${(version.stdout ?? '').trim() || '?'}, but the service requires ${nodeRequirement()}.`;
  }
  return null;
}

/**
 * Węzeł jednostki `rarog.service` z `ExecStart` NASZEGO pliku (parser cudzysłowów z `systemd-unit.ts`, nie
 * `systemctl show`: tam argv bez cytowania), sprawdzony jak węzeł plistu; albo powód odmowy.
 */
export function unitNode(io: CliIo): { readonly node: string } | { readonly issue: string } {
  const found = unitArgv(io);
  return 'issue' in found ? found : checkedNode(found.argv, io);
}

/** Tekst pliku jednostki (zwykły plik ≤ 64 KiB, bez dowiązania) albo powód. */
function readUnitFile(file: string): { readonly text: string } | { readonly issue: string } {
  try {
    const read = readRegularFileSync(file, { maxBytes: 64 * 1024, followSymlink: false });
    if (read === null || read.truncated) return { issue: `${file} is not a regular file ≤ 64 KiB.` };
    return { text: read.bytes.toString('utf8') };
  } catch (failure) {
    return { issue: `cannot read ${file} (${(failure as NodeJS.ErrnoException).code ?? 'error'}).` };
  }
}

/** Argv `ExecStart` naszego pliku jednostki z wejściem `…/bin/rarog.mjs` i węzłem przed nim, albo powód odmowy. */
export function unitArgv(io: CliIo): { readonly argv: readonly string[] } | { readonly issue: string } {
  const file = unitFilePath(homeOf(io.env));
  const read = readUnitFile(file);
  if ('issue' in read) return read;
  const parsed = parseExecStart(read.text);
  if ('issue' in parsed) {
    return {
      issue: `${file}: ExecStart does not have the shape rarog service install writes (${parsed.issue}) — install`
        + ' the service again (rarog service install).',
    };
  }
  if (serviceArgvNode(parsed.argv) === undefined) return { issue: `${file}: ExecStart has no "<node> …/bin/rarog.mjs".` };
  return { argv: parsed.argv };
}

/**
 * Katalog danych zainstalowanej usługi: katalog jej logu (`StandardOutPath` plistu, `StandardOutput=append:`
 * jednostki), który `service install` zakłada w katalogu danych. `null` = usługi nie ma, jej pliku nie da się
 * odczytać albo nie ma w nim logu (wtedy rozstrzyga reguła na środowisku usługi, `install/data-dir.ts`).
 */
export function installedServiceDataDir(io: CliIo, platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'linux') {
    const file = unitFilePath(home);
    if (!existsSync(file)) return null;
    const read = readUnitFile(file);
    if ('issue' in read) return null;
    const log = /^StandardOutput=append:(.+)$/mu.exec(read.text)?.[1];
    return log === undefined ? null : path.dirname(log.replaceAll('%%', '%'));
  }
  if (!existsSync(servicePlistPath(home))) return null;
  const read = readServicePlist(io, home);
  if ('issue' in read) return null;
  const log = read.plist['StandardOutPath'];
  return typeof log === 'string' && log !== '' ? path.dirname(log) : null;
}

/** Wersja instalacji z wejściem `bin` (`<korzeń>/package.json`); `null` = pliku nie ma albo nie ma w nim wersji. */
function installationVersion(bin: string): string | null {
  try {
    const read = readRegularFileSync(path.join(path.dirname(path.dirname(bin)), 'package.json'), {
      maxBytes: 1024 * 1024, followSymlink: true,
    });
    if (read === null || read.truncated) return null;
    const parsed: unknown = JSON.parse(read.bytes.toString('utf8'));
    const version = parsed !== null && typeof parsed === 'object' ? (parsed as { version?: unknown }).version : null;
    return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/u.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** Paczka npm, którą startuje usługa, widziana z klonu repo ({@link servicePackageFromClone}). */
export interface ServicePackage {
  /** Korzeń paczki (katalog nad `bin/`). */
  readonly root: string;
  /** Wejście `…/bin/rarog.mjs` z argv usługi. */
  readonly bin: string;
  /** Węzeł z argv usługi. */
  readonly node: string;
  /** `version` z `package.json` paczki; `null` = nieczytelna. */
  readonly version: string | null;
}

/**
 * Usługa startuje paczkę npm, a ta komenda to klon repo: wejście z argv usługi to inny plik niż wejście tego klonu,
 * istnieje i leży w instalacji trybu `package` ({@link installModeAt}). Wtedy `service install` klonu przełączyłby
 * usługę z paczki na klon, więc restart i `doctor` klonu nie podają go jako naprawy, a `service install` pyta.
 * `null` = tryb paczki, cel to ten klon, inny klon albo instalacja, której już nie ma.
 */
export function servicePackageFromClone(
  argv: readonly string[], mode: InstallMode = INSTALL_MODE,
  current: ServiceTarget = { node: process.execPath, bin: RAROG_BIN },
): ServicePackage | null {
  if (mode !== 'clone') return null;
  const found = serviceInstallation(argv, current);
  if (!found.otherBin || found.bin === undefined || found.node === undefined || !existsSync(found.bin)) return null;
  const root = path.dirname(path.dirname(found.bin));
  if (installModeAt(root) !== 'package') return null;
  return { root, bin: found.bin, node: found.node, version: installationVersion(found.bin) };
}

/** „the rarog package <version> (<root>)” — dopełnienie w zdaniu o usłudze. */
export function servicePackageText(pkg: ServicePackage): string {
  return `the rarog package ${pkg.version ?? '?'} (${pkg.root})`;
}

/**
 * Trzy drogi z klonu, gdy usługa startuje paczkę npm ({@link servicePackageFromClone}): restart paczki jej węzłem
 * i wejściem, kod klonu w usłudze przez paczkę z klonu, przełączenie usługi na klon z pytaniem i powrót na paczkę.
 */
export function clonePackageAdvice(pkg: ServicePackage, mode: InstallMode = INSTALL_MODE): string {
  return `Restart the service: ${installationCli(pkg, 'restart')}. This clone's code reaches the service as a package`
    + ' built from the clone (docs/distribution.md, "Clone next to the package"). Switch the service to this clone:'
    + ` ${rarogCli('service install', mode)} (shows the changes and asks [y/N]); back to the package:`
    + ` ${installationCli(pkg, 'service install')}.`;
}

/** Rozjazd celu usługi z tą instalacją: inne wejście albo inny węzeł, opis i komenda ponownej instalacji. */
export interface InstallationMismatch {
  readonly kind: 'bin' | 'node';
  /** Orzeczenie o usłudze bez podmiotu i kropki: „points to another installation (…)” albo „starts with node …”. */
  readonly what: string;
  /** Czy rozjazd blokuje restart (inne wejście zawsze, inny węzeł w paczce npm). */
  readonly blocking: boolean;
  /** `service install` tej instalacji. */
  readonly reinstall: string;
  /**
   * Paczka npm usługi, gdy ta komenda to klon ({@link servicePackageFromClone}): wtedy naprawą nie jest `reinstall`
   * (przełączyłby usługę na klon), tylko {@link clonePackageAdvice}. `null` w każdym innym przypadku.
   */
  readonly servicePackage: ServicePackage | null;
}

/**
 * Cel usługi (argv z plistu albo z jednostki) wobec tej instalacji (`install/service-target.ts`), jedna reguła dla
 * `rarog restart` i `rarog doctor`: wejście `…/bin/rarog.mjs` innej instalacji, także takiej, której już nie ma
 * (przerwana aktualizacja, `pnpm store prune`), blokuje zawsze; inny węzeł blokuje w paczce, a w klonie nie, bo
 * usługę klonu instaluje się węzłem z `PATH` chwili instalacji, a jej węzeł i tak sprawdza {@link nodeFileIssue}.
 * `null` = cel to ta instalacja.
 */
export function serviceInstallationMismatch(
  argv: readonly string[], mode: InstallMode = INSTALL_MODE,
  current: ServiceTarget = { node: process.execPath, bin: RAROG_BIN },
): InstallationMismatch | null {
  const found = serviceInstallation(argv, current);
  const reinstall = rarogCli('service install', mode);
  if (found.otherBin) {
    const servicePackage = servicePackageFromClone(argv, mode, current);
    if (servicePackage !== null) {
      return {
        kind: 'bin', blocking: true, reinstall, servicePackage,
        what: `starts ${servicePackageText(servicePackage)}, but this command is the repo clone`
          + ` ${path.dirname(path.dirname(current.bin))} (version ${RAROG_VERSION})`,
      };
    }
    const bin = found.bin ?? '?';
    const version = existsSync(bin) ? `version ${installationVersion(bin) ?? '?'}` : 'the file is gone';
    return {
      kind: 'bin', blocking: true, reinstall, servicePackage: null,
      what: `points to another installation (${bin}, ${version}), but this command is ${current.bin} (version`
        + ` ${RAROG_VERSION})`,
    };
  }
  if (!found.otherNode) return null;
  return {
    kind: 'node', blocking: mode === 'package', reinstall, servicePackage: null,
    what: `starts with node ${found.node ?? '?'}, but this command runs on ${current.node}`,
  };
}

/**
 * {@link serviceInstallationMismatch} przed restartem: blokujący rozjazd = odmowa z komendą `service install` tej
 * instalacji (inne wejście: restart wystartowałby tamten kod); z klonu przy usłudze na paczce npm odmowa z
 * {@link clonePackageAdvice} zamiast `service install` (ten przełączyłby usługę na klon); inny węzeł w klonie = uwaga
 * na stderr i restart dalej.
 */
export function checkServiceInstallation(argv: readonly string[], io: CliIo, deps: RestartDeps): void {
  const mode = deps.mode ?? INSTALL_MODE;
  const mismatch = serviceInstallationMismatch(argv, mode, deps.current);
  if (mismatch === null) return;
  const { reinstall } = mismatch;
  const text = `the service ${mismatch.what}`;
  if (mismatch.servicePackage !== null) {
    throw new Refusal(`${text} — a restart from here would run the package code, not this clone.`
      + ` ${clonePackageAdvice(mismatch.servicePackage, mode)} ${NOTHING_STOPPED}`);
  }
  if (mismatch.kind === 'bin') {
    throw new Refusal(`${text} — a restart would start that code; run ${reinstall} from this installation.`
      + ` ${NOTHING_STOPPED}`);
  }
  if (mismatch.blocking) {
    throw new Refusal(`${text}; run ${reinstall} so the service starts with this installation's node. ${NOTHING_STOPPED}`);
  }
  err(io, `rarog restart: warning, ${text} — the restart keeps the service's node; ${reinstall} switches it.`);
}

/**
 * Katalog danych z tej powłoki wobec katalogu usługi (`install/data-dir.ts`: katalog logu zainstalowanej usługi,
 * inaczej reguła na środowisku usługi) przed restartem: rozjazd = odmowa, bo `serve --check` i log restartu
 * patrzyłyby na inne dane niż serwer usługi.
 */
function refuseDataDirMismatch(
  io: CliIo, platform: NodeJS.Platform, serviceEnv: NodeJS.ProcessEnv, deps: RestartDeps,
): void {
  const home = homeOf(io.env);
  const resolved = installDataDir({
    home, shellEnv: io.env, serviceEnv, flag: deps.dataDir, serviceDir: installedServiceDataDir(io, platform, home),
    reinstall: rarogCli('service install', deps.mode ?? INSTALL_MODE),
  });
  if (!resolved.ok) throw new Refusal(`${resolved.message} ${NOTHING_STOPPED}`);
}

/** Plik wykonywalny o tej nazwie w `PATH` środowiska. */
export function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env['PATH'] ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return true;
    } catch {
      // Następny katalog.
    }
  }
  return false;
}

/** Narzędzia `restart.sh` na Linuksie: health (`curl`), środowisko kandydata (`ps`), stop po wzorcach (`pgrep`). */
export const LINUX_RESTART_TOOLS = ['curl', 'ps', 'pgrep'] as const;

/**
 * Środowisko `restart.sh`: środowisko wywołania bez cudzych parametrów `RAROG_RESTART_*`, zdanie naprawy kopii hooka
 * tej instalacji (`RAROG_RESTART_HOOK_REPAIR`, `install/repair.ts`) i podane parametry.
 */
export function scriptEnv(io: CliIo, extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...io.env };
  for (const name of RESTART_PARAMS) delete env[name];
  return { ...env, RAROG_RESTART_HOOK_REPAIR: RESTART_HOOK_REPAIR, ...extra };
}

/**
 * `restart.sh` as an asynchronous child: without a sink on the terminal of this command, with one only into the sink.
 * Ctrl-C sends it SIGTERM and waits for its end (code 130).
 */
export async function runRestartScript(env: NodeJS.ProcessEnv, sink?: ChildSink): Promise<ChildResult> {
  try {
    return await runChild({ command: 'bash', args: [RESTART_SCRIPT], cwd: INSTALL_ROOT, env, sink });
  } catch (failure) {
    throw new Refusal(`cannot run ${RESTART_SCRIPT}: ${failure instanceof Error ? failure.message : String(failure)}`);
  }
}

/**
 * Exit code of `rarog restart` after `restart.sh`. A failure the user did not see (output in a sink) or Ctrl-C gets
 * one sentence on stderr; without a sink `restart.sh` already printed its own reason, as before.
 */
export function finishRestartScript(io: CliIo, result: ChildResult): number {
  if (result.code !== 0 && (result.interrupted || result.lastLine !== null)) {
    err(io, `rarog restart: ${childExitText(RESTART_SCRIPT_NAME, result)}.`);
  }
  return result.interrupted ? EXIT_INTERRUPTED : result.code;
}

/** Zależności `rarog restart` podmieniane w testach. */
export interface RestartDeps {
  /** Sprawdzenie SDK w `serve --check` (domyślnie `checkServeSdk` trybu tej instalacji). */
  readonly sdk?: ServeSdkCheck;
  /** Tryb instalacji (domyślnie `INSTALL_MODE`). */
  readonly mode?: InstallMode;
  /** Węzeł i wejście tej instalacji, z którymi porównuje się cel usługi (domyślnie `process.execPath`, `RAROG_BIN`). */
  readonly current?: ServiceTarget;
  /** Sink for the `restart.sh` output (command log, or the screen with `--verbose`); none = the terminal. */
  readonly output?: ChildSink;
  /**
   * The data directory of `rarog update --finish --data-dir`, checked there against the service's log directory:
   * `serve --check`, `RAROG_LOG` and the data directory check use it instead of this shell's (default: none).
   */
  readonly dataDir?: string;
}

/** `serve --check` flags of the restart: the caller's data directory, when it gives one. */
function checkFlags(deps: RestartDeps): ServeFlags {
  return { env: {}, mode: 'check', ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }) };
}

/**
 * `serve --check` dla restartu; `null` = odmowa (komunikat już na stderr). Klucz iroh niesprawdzony (`RAROG_IROH=1`,
 * `service.wrapper`, sekretów w `env` brak) sprawdza dodatkowo pełne `serve --check` przez wrapper na `env`, czyli na
 * środowisku, które dostaje usługa: bez klucza nowy serwer nie wstałby po zatrzymaniu starego (`docs/server-config.md`, „Refusals and failures”).
 * W paczce npm `check` sprawdza też przypięty SDK: brak = odmowa z pełną ścieżką i `rarog setup`, przed `restart.sh`.
 */
async function check(
  built: ServeEnv, io: CliIo, env: NodeJS.ProcessEnv, deps: RestartDeps,
): Promise<{ port: number; dataDir: string } | null> {
  const result = await checkServeEnv(
    built, io, 'rarog restart: the config does not pass rarog serve --check', undefined, deps.sdk,
  );
  if (!result.ok) {
    err(io, `rarog restart: ${NOTHING_STOPPED}`);
    return null;
  }
  if (result.irohKeyUnchecked && !irohKeyUnderWrapper(built, io, env, deps.dataDir)) return null;
  return { port: result.port, dataDir: result.dataDir };
}

/** Sufit `serve --check` przez wrapper, ten sam co w `rarog service install` (wrapper sekretów może pytać sieć). */
const WRAPPER_CHECK_MS = 120_000;

/**
 * Pełne `serve --check` przez `service.wrapper`: `true` = przeszło i nie pisze już linii klucza niesprawdzonego.
 * Na ekran idzie tylko stderr sprawdzenia (nazwy zmiennych, bez wartości), a stdout z listą sekretów zostaje.
 * The caller's verified data directory goes along as `--data-dir`, so the check looks where the first one did
 * (the pinned SDK of a package lives there); without one the argv stays the service's own.
 */
function irohKeyUnderWrapper(
  built: ServeEnv, io: CliIo, env: NodeJS.ProcessEnv, dataDir: string | undefined,
): boolean {
  const command = serviceArgv(built.config?.wrapper ?? [],
    ['serve', '--check', ...(dataDir === undefined ? [] : ['--data-dir', dataDir])]);
  const run = spawnSync(command[0] ?? process.execPath, command.slice(1), {
    env, encoding: 'utf8', timeout: WRAPPER_CHECK_MS, cwd: INSTALL_ROOT,
  });
  const unchecked = (run.stdout ?? '').split('\n').some((line) => line.trim() === IROH_KEY_UNCHECKED_LINE);
  if (run.error === undefined && run.status === 0 && !unchecked) return true;
  for (const line of (run.stderr ?? '').split('\n')) if (line !== '') err(io, `  ${line}`);
  const why = run.error?.message
    ?? (run.status === 0 ? 'the wrapper supplies no secret' : `exit status ${String(run.status)}`);
  err(io, `rarog restart: ${IROH_ENV}=1, but rarog serve --check through service.wrapper does not see`
    + ` ${IROH_KEY_ENV} or failed (${why}) — the new server would not start. ${NOTHING_STOPPED}`);
  return false;
}

/** Czy ktoś przyjmuje połączenie (gniazdo unix albo TCP na loopbacku); brak odpowiedzi w limicie = nie. */
export function accepts(target: net.NetConnectOpts, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(target);
    const done = (alive: boolean): void => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => { done(false); });
    socket.once('connect', () => { done(true); });
    socket.once('error', () => { done(false); });
  });
}

/** Zdanie na końcu odmów `rarog restart` i `rarog service install`, które niczego nie zatrzymały; wspólne dla obu. */
export const NOTHING_STOPPED = 'Nothing was stopped.';

/** Początek bloku środowiska domeny w wydruku `launchctl print gui/<uid>`: dokładnie jeden tabulator wcięcia. */
const DOMAIN_ENV_START = '\tenvironment = {';
/** Koniec tego bloku. */
const DOMAIN_ENV_END = '\t}';
/**
 * Wpis bloku: dwa tabulatory, nazwa, ` =>`, spacja i wartość (wartość może mieć spacje i `=>`; pusta też bez spacji
 * po `=>`). `s`: wartość z `\r` albo innym znakiem końca linii poza `\n` to nadal ten sam wpis.
 */
const DOMAIN_ENV_ENTRY = /^\t\t(\S.*?) =>(?: (.*))?$/su;

/** Blok `environment` domeny launchd z wydruku `launchctl print gui/<uid>`. */
export interface DomainEnvironment {
  /**
   * Wpisy `[nazwa, wartość]` w kolejności wydruku, które na pewno należą do bloku domeny: z jednego zamkniętego
   * bloku, także obok linii spoza kształtu; przy braku bloku, bloku bez końca i powtórzonym bloku — żadne.
   */
  readonly entries: readonly (readonly [string, string])[];
  /** Czemu wydruk nie rozstrzyga (bez treści linii: mogłaby nieść wartość innej zmiennej); `null` = rozstrzyga. */
  readonly issue: string | null;
}

/**
 * Blok `environment` domeny z wydruku `launchctl print gui/<uid>` (kształt z pomiaru na macOS 27.0.1): linia
 * dokładnie `\tenvironment = {`, wpisy `\t\tNAZWA => wartość`, koniec `\t}`. Bloki z innym wcięciem (zagnieżdżone,
 * `inherited environment` itp.) się nie liczą. Wydruk `launchctl print` Apple opisuje jako niebędący API, więc
 * brak bloku, blok bez końca, drugi taki blok i linia bloku spoza kształtu dają {@link DomainEnvironment.issue}.
 */
export function parseDomainEnvironment(text: string): DomainEnvironment {
  const entries: [string, string][] = [];
  let blocks = 0;
  let inside = false;
  let issue: string | null = null;
  const lines = text.split('\n');
  // Pusty kawałek za końcowym `\n` to nie linia wydruku (inaczej blok bez końca wyglądałby na linię spoza kształtu).
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, index) => {
    if (!inside) {
      if (line === DOMAIN_ENV_START) {
        inside = true;
        blocks += 1;
      }
      return;
    }
    if (line === DOMAIN_ENV_END) {
      inside = false;
      return;
    }
    const match = DOMAIN_ENV_ENTRY.exec(line);
    if (match === null) {
      issue ??= `line ${String(index + 1)} of the environment block does not have the shape "NAME => value"`;
      return;
    }
    entries.push([match[1] ?? '', match[2] ?? '']);
  });
  // Zła struktura: nie wiadomo, gdzie blok domeny się kończy ani który blok jest domeny, więc
  // żaden wpis nie rozstrzyga — inaczej wpis z cudzego bloku zablokowałby restart zamiast ostrzec.
  if (blocks === 0) return { entries: [], issue: 'no environment block' };
  if (inside) return { entries: [], issue: 'environment block not closed' };
  if (blocks > 1) return { entries: [], issue: `environment block appears ${String(blocks)} times instead of once` };
  return { entries, issue };
}

/**
 * Zmienne katalogu danych ({@link PROCESS_NAMES}) przed krokiem, po którym serwer startuje pod launchd (`rarog
 * restart` przy `ai.rarog.server`, faza 0 `rarog service install`): puste w tej powłoce i w bloku `environment`
 * domeny `gui/<uid>`. Z powłoki liczą katalog danych sprawdzenie tutaj i hook w sesjach Claude, a usługa jej nie
 * dostaje; blok domeny dziedziczy każdy nowy proces usługi (brak `EnvironmentVariables` w plistcie tego nie
 * wyłącza). Blok czytamy z `launchctl print gui/<uid>`, bo ten wydruk jest ten sam z każdego kontekstu: `launchctl
 * getenv` z SSH, mosh i herdr (`managername` = `Background`) czyta domenę `user/<uid>`, której usługa nie dostaje.
 * Niepusta wartość (także sama spacja) = odmowa z komendą naprawy. Wydruk nie do rozstrzygnięcia (kod różny od 0,
 * sygnał, timeout, błąd uruchomienia, {@link parseDomainEnvironment} z powodem) = ostrzeżenie „nie sprawdzone” na
 * stderr i dalej: nieoficjalny format nie może zablokować jedynej drogi restartu; zmienną w żywym serwerze pokazuje
 * po fakcie `rarog doctor`. Wpis z naszą nazwą obok linii spoza kształtu w jednym zamkniętym bloku to nadal odmowa;
 * przy bloku bez końca albo powtórzonym parser nie oddaje wpisów, więc tylko ostrzeżenie. Jedna reguła dla obu
 * komend; to samo na Linuksie robi {@link decideLinux} ze środowiskiem menedżera.
 */
export function refuseLaunchdDataDirEnv(io: CliIo, command: 'restart' | 'install'): void {
  for (const name of PROCESS_NAMES) {
    if ((io.env[name] ?? '') !== '') {
      throw new Refusal(`${name} is set in this shell, but the launchd service gets an environment without it — the`
        + ' data directory checked here and the service directory would differ (and so would the hook in Claude'
        + ` sessions from this shell). Run ${command} without this variable. ${NOTHING_STOPPED}`);
    }
  }
  const uidDomain = launchdDomain();
  const domain = uidDomain ?? 'gui/<uid>';
  const [prefix, goesOn] = command === 'restart'
    ? ['rarog restart', 'Restart']
    : ['rarog service install', 'Installation'];
  const unchecked = (why: string): void => {
    err(io, `${prefix}: WARNING, not checked: ${PROCESS_NAMES.join(', ')} in the launchd domain ${domain} (${why}).`
      + ` ${goesOn} continues, because Apple does not guarantee the launchctl print format; after the start, rarog`
      + ' doctor shows whether the service got any of these variables (the live server environment line).');
  };
  if (uidDomain === null) {
    unchecked('no process.getuid');
    return;
  }
  const result = spawnSync('launchctl', ['print', domain], {
    env: io.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    const first = (result.stderr?.trim().split('\n')[0] ?? '').trim();
    const code = result.status === null ? `signal ${String(result.signal)}` : `exit status ${String(result.status)}`;
    unchecked(`launchctl print ${domain}: ${result.error?.message ?? `${code}${first !== '' ? `, ${first}` : ''}`}`);
    return;
  }
  const parsed = parseDomainEnvironment(result.stdout);
  for (const name of PROCESS_NAMES) {
    // Wartość ze spacji albo tabulatora to dla `resolveDataDir` niepusty katalog, więc też odmowa.
    if (parsed.entries.some(([key, value]) => key === name && value !== '')) {
      throw new Refusal(`${name} is set in the launchd domain ${domain} (launchctl setenv), so every new service`
        + ' process gets it — the data directory would differ from the one checked here and from the one the hook'
        + ' computes. Remove it in Terminal.app on the Mac screen, outside herdr (launchctl managername = Aqua):'
        + ` launchctl unsetenv ${name} — from SSH, mosh and herdr, unsetenv reaches another domain (user/<uid>).`
        + ` ${NOTHING_STOPPED}`);
    }
  }
  if (parsed.issue !== null) unchecked(`launchctl print ${domain} output: ${parsed.issue}`);
}

/**
 * Jednostka `rarog.service` przed restartem na Linuksie: nasza, załadowana, bez drop-inów — albo odmowa z powodem.
 * „Nie wiem” (brak magistrali użytkownika, `masked`, `bad-setting`, inny `LoadState`) też jest odmową.
 */
function linuxUnitOrRefuse(io: CliIo): void {
  const shown = showUnit(io, UNIT_STATE_PROPS, UNIT_ENV_PROPS);
  if ('failure' in shown) {
    throw new Refusal(`systemctl --user show ${UNIT_NAME} does not tell whether the unit exists (${shown.failure})`
      + ' — without the user manager bus (logind session, XDG_RUNTIME_DIR) it is unknown who supervises the server.'
      + ` ${NOTHING_STOPPED} Check systemctl --user status in a regular session and try again.`);
  }
  const home = homeOf(io.env);
  const status = classifyUnit(shown.values, home);
  switch (status.kind) {
    case 'ours':
      return;
    case 'absent':
      throw new Refusal(`no systemd --user unit ${UNIT_NAME} — on Linux the server starts only through it (nohup`
        + ' next to a supervisor would start a second server, and logind kills it when the session ends). Install it:'
        + ` rarog service install. ${NOTHING_STOPPED}`);
    case 'foreign':
      throw new Refusal(`${UNIT_NAME} is loaded from ${status.detail}, not from ${unitFilePath(home)} — not the`
        + ` unit from rarog service install. ${NOTHING_STOPPED}`);
    case 'drop-in':
      throw new Refusal(`${UNIT_NAME} has drop-ins (${status.detail}): they can change the service start or`
        + ` environment (e.g. Environment= with ${PROCESS_NAMES.join(' or ')}, which rarog serve passes through — a`
        + ' server on another data directory). Remove them and run systemctl --user daemon-reload; server variables'
        + ` go in config.json. ${NOTHING_STOPPED}`);
    case 'stale':
      throw new Refusal(`${unitFilePath(home)} changed on disk without systemctl --user daemon-reload: a restart`
        + ' would start the old unit definition, while the node is checked from the file. Run systemctl --user'
        + ` daemon-reload and try again. ${NOTHING_STOPPED}`);
    case 'environment':
      throw new Refusal(`${UNIT_NAME} sets environment in the unit itself (${status.detail}), and the rarog service`
        + ' install template has none — a data directory variable would move the server to other data. Remove these'
        + ' entries (or install the service again) and run systemctl --user daemon-reload; server variables go in'
        + ` config.json. ${NOTHING_STOPPED}`);
    default:
      throw new Refusal(`${UNIT_NAME} has ${status.detail}; restart decides only on LoadState=loaded (present)`
        + ` or not-found (absent).${status.kind === 'masked' ? ` Unmask it: systemctl --user unmask ${UNIT_NAME}.`
          : ` Check: systemctl --user status ${UNIT_NAME}.`} ${NOTHING_STOPPED}`);
  }
}

/**
 * Linux: jednostka `rarog.service` → środowisko menedżera użytkownika (`busctl`) →
 * zmienne katalogu danych puste w powłoce i w menedżerze → `serve --check` na środowisku menedżera → węzeł
 * z `ExecStart` naszego pliku → `curl`, `ps`, `pgrep` w `PATH` → `restart.sh` z `RAROG_RESTART_UNIT`. Każda odmowa
 * pada przed `restart.sh`.
 */
async function decideLinux(io: CliIo, deps: RestartDeps): Promise<number> {
  linuxUnitOrRefuse(io);
  const manager = managerEnvironment(io);
  if ('failure' in manager) {
    throw new Refusal(`systemd --user manager environment (busctl … Manager Environment) unreadable`
      + ` (${manager.failure}) — and that is what the service gets. ${NOTHING_STOPPED}`);
  }
  for (const name of PROCESS_NAMES) {
    if ((io.env[name] ?? '') !== '') {
      throw new Refusal(`${name} is set in this shell, but the ${UNIT_NAME} service gets the systemd --user manager`
        + ' environment — the hook in Claude sessions from this shell would compute a different data directory than'
        + ` the server. Run restart without this variable. ${NOTHING_STOPPED}`);
    }
    if ((manager.env[name] ?? '') !== '') {
      throw new Refusal(`${name} is set in the systemd --user manager environment (set-environment), so the service`
        + ' would get it — a server on a different data directory than the hook. Remove it: systemctl --user'
        + ` unset-environment ${name}. ${NOTHING_STOPPED}`);
    }
  }
  const built = buildServeEnv(manager.env, checkFlags(deps));
  const checked = await check(built, io, manager.env, deps);
  if (checked === null) return EXIT_REFUSED;
  const argv = unitArgv(io);
  if ('issue' in argv) throw new Refusal(`${argv.issue} ${NOTHING_STOPPED}`);
  checkServiceInstallation(argv.argv, io, deps);
  const node = checkedNode(argv.argv, io);
  if ('issue' in node) throw new Refusal(`${node.issue} ${NOTHING_STOPPED}`);
  refuseDataDirMismatch(io, 'linux', manager.env, deps);
  const missing = LINUX_RESTART_TOOLS.filter((tool) => !onPath(tool, io.env));
  if (missing.length > 0) {
    throw new Refusal(`missing in PATH: ${missing.join(', ')} — restart.sh needs them for health (curl) and for`
      + ` stopping by pattern (ps, pgrep). Install them (e.g. the curl and procps packages). ${NOTHING_STOPPED}`);
  }
  out(io, `rarog restart: unit ${UNIT_NAME} — restart.sh with it, port ${String(checked.port)}.`);
  return finishRestartScript(io, await runRestartScript(scriptEnv(io, {
    RAROG_RESTART_UNIT: UNIT_NAME,
    RAROG_RESTART_PORT: String(checked.port),
    RAROG_LOG: path.join(checked.dataDir, 'server.log'),
  }), deps.output));
}

async function decide(io: CliIo, deps: RestartDeps): Promise<number> {
  const platform = platformOf(io);
  if (platform === 'linux') return decideLinux(io, deps);
  if (platform !== 'darwin') {
    throw new Refusal(`rarog restart knows the launchd (macOS) and systemd --user (Linux) supervisors, and this`
      + ` platform is ${platform}. ${NOTHING_STOPPED}`);
  }
  // „Nie wiem” o usłudze = odmowa, zanim cokolwiek się zatrzyma (obie gałęzie niżej).
  const service = decidedLoadState(SERVICE_LABEL, io) === 'loaded';
  if (service) {
    refuseLaunchdDataDirEnv(io, 'restart');
    const built = buildServeEnv(io.env, checkFlags(deps));
    const checked = await check(built, io, io.env, deps);
    if (checked === null) return EXIT_REFUSED;
    const argv = servicePlistArgv(io);
    if ('issue' in argv) throw new Refusal(`${argv.issue} ${NOTHING_STOPPED}`);
    checkServiceInstallation(argv.argv, io, deps);
    const node = checkedNode(argv.argv, io);
    if ('issue' in node) throw new Refusal(`${node.issue} ${NOTHING_STOPPED}`);
    refuseDataDirMismatch(io, 'darwin', launchdEnv(io.env), deps);
    out(io, `rarog restart: ${SERVICE_LABEL} loaded — restart.sh with this label, port ${String(checked.port)}.`);
    return finishRestartScript(io, await runRestartScript(scriptEnv(io, {
      RAROG_RESTART_LABEL: SERVICE_LABEL,
      RAROG_RESTART_PORT: String(checked.port),
      RAROG_LOG: path.join(checked.dataDir, 'server.log'),
    }), deps.output));
  }
  if (deps.dataDir !== undefined) {
    // restart.sh starts rarog serve without --data-dir here, so the server would come up on another directory.
    throw new Refusal(`no launchd service is loaded, so a start through rarog serve here would not use the data`
      + ` directory ${deps.dataDir} from --data-dir. ${NOTHING_STOPPED}`);
  }
  // Najpierw sam `config.json`: bez niego `rarog serve` nie wystartuje, więc odmowa przed zatrzymaniem.
  if (readRarogConfig(io.env) === null) {
    throw new Refusal(`no ${SERVICE_LABEL} service and no ${path.join(rarogConfigDir(io.env), 'config.json')} —`
      + ' the server starts only through rarog serve with this config. rarog setup creates it (then rarog'
      + ` service install). ${NOTHING_STOPPED}`);
  }
  const built = buildServeEnv(io.env, { env: {}, mode: 'check' });
  if (built.config === null) throw new Refusal('config.json disappeared during the restart — run it again.');
  if (typeof process.execve !== 'function') {
    // `rarog serve` po zatrzymaniu serwera padłby na tym samym — odmowa PRZED zatrzymaniem.
    throw new Refusal(`this Node (v${process.versions.node}) has no process.execve, and a start without the service`
      + ` goes through rarog serve — Node ${nodeRequirement()} is required.`);
  }
  if (built.config.wrapper !== null && !built.hasSecrets) {
    throw new Refusal(`no launchd service is loaded, and the secrets come from service.wrapper in`
      + ` ${built.config.file} — a server started from here would not get them. Load the service`
      + ` (${SERVICE_LABEL}) or run the restart through the wrapper.`);
  }
  const checked = await check(built, io, io.env, deps);
  if (checked === null) return EXIT_REFUSED;
  const socket = adminSocketPath(checked.dataDir);
  if (await accepts({ path: socket }) && !await accepts({ host: '127.0.0.1', port: checked.port })) {
    throw new Refusal(`the server of data directory ${checked.dataDir} is running (socket ${socket}), but not on`
      + ` port ${String(checked.port)} from the config — RAROG_PORT changed? restart.sh stops only the server on this`
      + ' port, so the old one would stay next to the new one on the same data. Nothing was stopped; stop the old'
      + ' server by hand and run restart again.');
  }
  out(io, `rarog restart: no launchd service — restart.sh with a nohup rarog serve start, port ${String(checked.port)}.`);
  return finishRestartScript(io, await runRestartScript(scriptEnv(io, {
    RAROG_RESTART_SERVE: 'rarog',
    RAROG_RESTART_PORT: String(checked.port),
    RAROG_LOG: path.join(checked.dataDir, 'server.log'),
    // `node` w `restart.sh` to ten sam węzeł co tutaj (wersja sprawdzona w `bin/rarog.mjs`), nie pierwszy z PATH.
    PATH: [path.dirname(process.execPath), io.env['PATH'] ?? ''].filter((part) => part !== '').join(':'),
  }), deps.output));
}

/** `rarog restart` — `argv` zaczyna się od `restart`. */
export async function restartCommand(
  argv: readonly string[], io: CliIo, deps: RestartDeps = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(io, usageFor(io, `Usage:\n${RESTART_USAGE}`));
    return EXIT_OK;
  }
  if (argv.length > 1) throw new Usage(`rarog restart takes no arguments (got: ${argv.slice(1).join(' ')}).`);
  try {
    const lock = acquireLock(rarogConfigDir(io.env), 'rarog restart');
    try {
      return await decide(io, deps);
    } finally {
      lock.release();
    }
  } catch (failure) {
    if (failure instanceof Refusal) {
      err(io, `rarog restart: ${failure.message}`);
      return EXIT_REFUSED;
    }
    throw failure;
  }
}
