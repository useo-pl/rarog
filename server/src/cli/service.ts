/**
 * `rarog service install|uninstall` (macOS): usługa launchd
 * `ai.rarog.server` z szablonu `templates/launchd.plist` dla drogi `rarog serve`.
 *
 * `install` idzie w dwóch fazach, bo zatrzymuje serwer, przez który właściciel łączy się z telefonu:
 *
 * - **faza 0, nic nie zatrzymuje:** paczka npm uruchomiona z cache `npx` albo przez `pnpm dlx` = odmowa jeszcze
 *   przed blokadą (`install/service-target.ts`); blokada `~/.config/rarog/lock`; środowisko instalacji bez
 *   zmiennych katalogu danych (rodzaj `process` rejestru: launchd ich nie przekaże, więc katalog instalacji i usługi
 *   byłby inny),
 *   także w bloku `environment` domeny z `launchctl print gui/<uid>` (dziedziczy go każda usługa; nierozpoznany
 *   wydruk = ostrzeżenie „nie sprawdzone”, nie odmowa);
 *   węzeł tego procesu (`process.execPath`, trafia do plistu) z wersją z `nodeVersionOk`; `rarog serve --check`
 *   w procesie na środowisku, które da launchd (konfiguracja, katalog danych bez konfliktu, port); ścieżka gniazda
 *   administracyjnego ≤ 103 B i żaden serwer tych danych na innym porcie (żywe gniazdo przy milczącym porcie);
 *   pierwszy element `service.wrapper` to wykonywalny plik o ścieżce bezwzględnej;
 *   plist z szablonu w pliku tymczasowym i `plutil -lint`; na końcu pełne `rarog serve --check` PRZEZ
 *   `service.wrapper`, czyli z sekretami (dlatego `install` u właściciela uruchamia właściciel); wrapper, który nie
 *   daje ani jednego sekretu albo zmienia katalog danych lub port, to odmowa; ostatni krok to stan usługi
 *   (`loadState` z `restart.ts`), a „nie wiem” (`launchctl print` z kodem innym niż 0 i 113) to odmowa przed
 *   `bootout`.
 * - **faza 1:** `bootout` `ai.rarog.server`, jeśli jest załadowana, z czekaniem (do 30 s), aż launchd zdejmie
 *   etykietę ({@link waitUntilAbsent}); katalog danych 0700 (launchd zakłada plik logu, ale nie katalog); zapis
 *   plistu; `bootstrap`; `scripts/restart.sh` z etykietą, portem i logiem (ubija resztki na porcie, `kickstart`,
 *   health), wołany wprost, bo blokadę trzyma już `install`; na końcu dowiązanie `~/.local/bin/rarog` (tylko klon
 *   repo; w paczce polecenie `rarog` daje menedżer paczek).
 *   Porażka po pierwszym kroku tej fazy, także wyjątek, wypisuje DOSŁOWNIE komendy powrotu.
 *
 * Klon repo przy usłudze, która startuje paczkę npm ({@link packageSwitch}): `install` przełączyłby produkcję
 * z paczki na klon, więc bez terminala (`CliIo.ask`) odmawia jeszcze przed fazą 0, a w terminalu po fazie 0 wypisuje
 * listę zmian z komendą powrotu na paczkę i pyta `[y/N]`; „nie” i EOF = odmowa, nic nie zatrzymane. To samo na Linuksie.
 * Tak samo plik usługi, którego cel klon nie odczyta ({@link unknownTarget}): lista bez komendy powrotu.
 *
 * Każdy krok jest idempotentny: ponowna instalacja przy załadowanym `ai.rarog.server` to to samo wywołanie.
 * `uninstall` = `bootout` + plist removal; data and config stay, and in a clone the `~/.local/bin/rarog` symlink
 * goes only when it points to this clone ({@link removeRarogLink}). An undecided state of `ai.rarog.server` is
 * a refusal before anything changes. In the npm package it then removes the Rarog entries from
 * `~/.claude/settings.json` after a `[y/N/d]` question and the hook copy directory after a `[y/N]` one, and prints
 * the rest of the uninstall ({@link packageUninstall}). Starej instalacji z plistu `install` nie sprawdza: przepina
 * usługę także wtedy, gdy węzła albo wejścia z plistu już nie ma.
 *
 * Sekrety nie trafiają do argv, plistu ani wyjścia: plist niesie wyłącznie `service.wrapper`, węzeł i ścieżki,
 * a `serve --check` wypisuje same nazwy.
 *
 * Linux: jednostka `systemd --user` `rarog.service` z szablonu `templates/rarog.service`
 * ({@link installUnit}, {@link uninstallUnit}) w tych samych dwóch fazach. Faza 0: blokada; zmienne katalogu danych
 * puste w powłoce i w środowisku menedżera użytkownika (`busctl`); `UnitPath` menedżera zawiera
 * `~/.config/systemd/user`; jednostka bez drop-inów; węzeł; `curl`, `ps`, `pgrep`; `serve --check` na środowisku
 * menedżera; gniazdo ≤ 103 B i żaden serwer tych danych na innym porcie; wrapper; jednostka z szablonu w pliku
 * tymczasowym i `systemd-analyze verify` (tryb systemowy, działa bez menedżera; brak narzędzia = linia „nie
 * sprawdzone”); pełne `--check` przez wrapper (ten sam katalog danych i port co bez niego); stan jednostki. Faza 1: zapis atomowy, `daemon-reload`, `enable`, katalog danych 0700, `restart.sh`
 * z `RAROG_RESTART_UNIT`, linia o lingerze, dowiązanie; porażka wypisuje komendy powrotu. `uninstall` = `disable
 * --now`, unit file removal, `daemon-reload`, this clone's symlink as on macOS. Inna platforma = odmowa.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { resolveDataDir } from '@rarog/shared/data-dir';
import { ADMIN_SOCKET_PATH_MAX, adminSocketPath } from '../auth/admin.ts';
import {
  contextHookCommand, denyReadPaths, hookCommand, hookCopyDirState, hookInstallDir, removeHookCopy,
  renderPasteHookBlock, renderStatuslineBlock, statuslineCommand, userSettingsPath, visibleLine, writeBlockRules,
} from '../herdr/hook-config.ts';
import { INSTALL_MODE, INSTALL_ROOT } from '../install/mode.ts';
import type { InstallMode } from '../install/mode.ts';
import {
  PACKAGE_INSTALL, REPAIR, installationCli, packageCommands, packageManagerOf, rarogCli,
} from '../install/repair.ts';
import { SDK_DIRNAME } from '../install/sdk.ts';
import {
  RAROG_BIN, serviceArgv, serviceArgvNode, serviceArgvWrapper, serviceTarget, transientInstall,
} from '../install/service-target.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { RAROG_VERSION } from '../version.ts';
import { SETTINGS_BACKUP_DIRNAME, copyRemovalCheck, entriesDiff, entriesQuestion, writeClaudeSettings } from './claude-settings.ts';
import type { SettingsWriteResult } from './claude-settings.ts';
import { EXIT_OK, EXIT_REFUSED, Refusal, Usage, err, homeOf, isYes, out, platformOf, terminalOf } from './io.ts';
import type { CliIo } from './io.ts';
import { childExitText } from './child-output.ts';
import type { ChildSink } from './child-output.ts';
import { acquireLock } from './lock.ts';
import {
  LAUNCHD_PATH, LINUX_RESTART_TOOLS, NOTHING_STOPPED, SERVICE_LABEL, accepts, decidedLoadState,
  installedServiceDataDir, launchdDomain, launchdEnv, launchdTarget, loadState, nodeRequirement, onPath,
  refuseLaunchdDataDirEnv, runRestartScript, scriptEnv, serviceNodeVersionOk, servicePackageFromClone,
  servicePackageText, servicePlistArgv, servicePlistPath, unitArgv,
} from './restart.ts';
import type { ServicePackage } from './restart.ts';
import { confirm as confirmForm } from './screen/ask.ts';
import { layoutOf } from './screen/style.ts';
import {
  CHECK_DATA_DIR_LABEL, CHECK_PORT_LABEL, PROCESS_NAMES, SECRETS_UNCHECKED_LINE, buildServeEnv, checkServeEnv,
  rarogConfigDir,
} from './serve.ts';
import type { ServeEnv } from './serve.ts';
import {
  UNIT_ENV_PROPS, UNIT_NAME, UNIT_STATE_PROPS, classifyUnit, enableLingerCommand, lingerState, managerEnvironment,
  managerStrings, renderServiceUnit, samePath, showUnit, unitFilePath, userUnitDir,
} from './systemd-unit.ts';
import { usageFor } from './screen/prose.ts';
import { herdrAgentUninstallLines } from './setup-herdr-agent.ts';

export const SERVICE_USAGE = `  rarog service install|uninstall
      launchd service ${SERVICE_LABEL} (macOS). install first checks everything without stopping anything, then
      unloads the running service, writes the plist from the template, loads it and restarts with a health check;
      uninstall unloads the service and removes its plist (data stays) and, in a repo clone, the ~/.local/bin/rarog
      symlink when it points to this clone; in the npm package it then removes the Rarog entries from
      ~/.claude/settings.json after a [y/N/d] question (d shows the diff) and the hook copy after a list and
      [y/N]. On Linux the same with the systemd --user unit ${UNIT_NAME}. Repo clone over a service on the npm
      package or with an unreadable target: install prints the changes and asks [y/N] (refuses without a terminal).`;

/** Szablon plistu usługi; wartości wstawia {@link renderServicePlist} po escapowaniu XML. */
export const PLIST_TEMPLATE = path.join(INSTALL_ROOT, 'server', 'src', 'cli', 'templates', 'launchd.plist');
/** Wejście `rarog`, które startuje usługa (`install/service-target.ts`). */
export { RAROG_BIN };
/** Środowisko „jak pod launchd” i jego `PATH` (`restart.ts`, wspólne z `restart` i `doctor`). */
export { LAUNCHD_PATH, launchdEnv };
/** Sufit pełnego `serve --check` przez wrapper (wrapper sekretów może pytać sieć). */
export const WRAPPER_CHECK_TIMEOUT_MS = 120_000;
/** Odmowa przy wrapperze, który nie dał żadnego sekretu: `rarog serve` z wrapperem bez sekretów nie startuje. */
export const WRAPPER_WITHOUT_SECRETS = 'service.wrapper supplied no secret at all, and rarog serve with a wrapper but'
  + ' without secrets refuses to start, so the service would not come up. Check the wrapper (names after --only,'
  + ' vault access).';

/** Dowiązanie komendy `rarog` w `PATH` użytkownika. */
export function rarogLinkPath(home: string): string {
  return path.join(home, '.local', 'bin', 'rarog');
}

/** Odmowa poza macOS (launchd) i Linuksem (`systemd --user`). */
export function servicePlatformIssue(platform: NodeJS.Platform): string | null {
  return platform === 'darwin' || platform === 'linux'
    ? null
    : `rarog service knows the launchd (macOS) and systemd --user (Linux) supervisors, and this platform is`
      + ` ${platform}. Here the server starts with \`rarog serve\` from your own supervisor.`;
}

/** Szablon z repo przez `safe-read.ts`: plik zwykły, bez dowiązania, z sufitem. */
function readTemplate(): string {
  const read = readRegularFileSync(PLIST_TEMPLATE, { maxBytes: 64 * 1024, followSymlink: false });
  if (read === null || read.truncated) {
    throw new Error(`${PLIST_TEMPLATE}: the template is not a regular file ≤ 64 KiB.`);
  }
  return read.bytes.toString('utf8');
}

/** Tekst w elemencie albo atrybucie XML: pięć znaków specjalnych jako encje. */
export function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export interface ServicePlistInput {
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly log: string;
}

/**
 * Plist usługi z szablonu: etykieta, `ProgramArguments` (po jednym `<string>` na element), katalog roboczy i log
 * na oba strumienie; każda wartość escapowana. Znak, którego XML 1.0 nie przenosi (np. NUL), wyłapie `plutil -lint`
 * w fazie 0.
 */
export function renderServicePlist(input: ServicePlistInput, template = readTemplate()): string {
  const args = input.programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  const values: Readonly<Record<string, string>> = {
    '{{LABEL}}': xmlEscape(SERVICE_LABEL),
    '{{PROGRAM_ARGUMENTS}}': args,
    '{{WORKING_DIRECTORY}}': xmlEscape(input.workingDirectory),
    '{{LOG}}': xmlEscape(input.log),
  };
  let text = template;
  for (const [placeholder, value] of Object.entries(values)) text = text.split(placeholder).join(value);
  if (text.includes('{{')) throw new Error(`${PLIST_TEMPLATE}: a template field is left unfilled.`);
  return text;
}

/** Ścieżka w pojedynczym cudzysłowie powłoki — komenda ma się dać wkleić. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Komendy powrotu po porażce fazy 1, do wklejenia w powłoce przez mosh: wyładowanie
 * nowej usługi i usunięcie jej plistu; dane i konfiguracja zostają.
 */
export function rollbackLines(home: string, mode: InstallMode = INSTALL_MODE): string[] {
  return [
    `ROLLBACK (unloads ${SERVICE_LABEL}; data and config stay), in a shell:`,
    ...cdLines(mode),
    `  ${rarogCli('service uninstall', mode)}`,
    'Without the CLI (this also breaks the KeepAlive loop of the new service):',
    `  launchctl bootout gui/$UID/${SERVICE_LABEL}`,
    `  rm ${quote(servicePlistPath(home))}`,
  ];
}

/** `cd` do katalogu repo przed komendą powrotu: tylko w klonie, bo `rarog` paczki leży w `PATH`. */
function cdLines(mode: InstallMode): string[] {
  return mode === 'clone' ? [`  cd ${quote(INSTALL_ROOT)}`] : [];
}

/** Zależności `rarog service` podmieniane w testach: tryb i korzeń instalacji (domyślnie tej, `install/mode.ts`). */
export interface ServiceDeps {
  readonly mode?: InstallMode;
  readonly installRoot?: string;
  /** Sink for the `restart.sh` output (`child-output.ts`); none = the terminal. */
  readonly output?: ChildSink;
  /** The data directory of `rarog update --finish --data-dir`: the new service must use it ({@link refuseOtherDataDir}). */
  readonly dataDir?: string;
}

/**
 * The new service starts `rarog serve` without flags, so its data directory is the rule's on the service environment:
 * another directory than the caller's `--data-dir` is a refusal before anything stops (the service would leave it).
 */
function refuseOtherDataDir(given: string | undefined, dataDir: string): void {
  if (given === undefined || samePath(given, dataDir)) return;
  throw new Refusal(`the service would use the data directory ${dataDir}, not ${given} from --data-dir (it starts`
    + ` rarog serve without flags). ${NOTHING_STOPPED}`);
}

/**
 * Instalacja z cache `npx` albo uruchomiona przez `pnpm dlx` ({@link transientInstall}) = odmowa przed blokadą
 * i przed `launchctl`: usługa wskazywałaby katalog, który menedżer paczek usuwa przy czyszczeniu cache.
 */
function refuseTransientInstall(io: CliIo, deps: ServiceDeps): void {
  const transient = transientInstall(deps.mode ?? INSTALL_MODE, deps.installRoot ?? INSTALL_ROOT, io.env);
  if (transient === null) return;
  throw new Refusal(`started from ${transient}. The service would point to a directory that disappears when the`
    + ` package manager cache is cleaned. Install permanently: ${PACKAGE_INSTALL.npm} (or ${PACKAGE_INSTALL.pnpm}),`
    + ` then rarog service install. ${NOTHING_STOPPED}`);
}

/** Wynik fazy 0: wszystko, czego potrzebuje faza 1. */
interface Prepared {
  readonly home: string;
  readonly plist: string;
  /** `ProgramArguments` nowego plistu. */
  readonly argv: readonly string[];
  readonly dataDir: string;
  readonly port: number;
  readonly mode: InstallMode;
}

/**
 * Usługa, którą `install` z klonu przełączyłby z paczki npm na ten klon: tamta paczka
 * ({@link servicePackageFromClone}), argv zainstalowanej usługi i katalog jej logu (`null` = brak logu w pliku).
 */
interface PackageSwitch {
  readonly from: ServicePackage;
  readonly argv: readonly string[];
  readonly dataDir: string | null;
}

/**
 * {@link PackageSwitch} z pliku zainstalowanej usługi (plist albo jednostka); `null` = tryb paczki, brak albo
 * nieczytelny plik usługi, usługa na tym klonie, na innym klonie albo na instalacji, której już nie ma.
 */
function packageSwitch(io: CliIo, platform: 'darwin' | 'linux', mode: InstallMode): PackageSwitch | null {
  if (mode !== 'clone') return null;
  const found = platform === 'linux' ? unitArgv(io) : servicePlistArgv(io);
  if ('issue' in found) return null;
  const from = servicePackageFromClone(found.argv, mode);
  if (from === null) return null;
  return { from, argv: found.argv, dataDir: installedServiceDataDir(io, platform, homeOf(io.env)) };
}

/**
 * Przełączenie z paczki na klon bez terminala = odmowa przed fazą 0 (bez wrappera sekretów i bez żadnego zapisu):
 * tę zmianę produkcji potwierdza człowiek odpowiedzią na pytanie z listą zmian ({@link confirmSwitch}).
 */
function refuseSwitchWithoutTerminal(io: CliIo, switching: PackageSwitch | null, label: string): void {
  if (switching !== null && io.ask === undefined) throw switchWithoutTerminal(switching, label);
}

function switchWithoutTerminal(switching: PackageSwitch, label: string): Refusal {
  return new Refusal(`service ${label} starts ${servicePackageText(switching.from)}, and this is the repo clone`
    + ` ${INSTALL_ROOT}, so install would switch the service from the package to this clone. Confirm the switch in a`
    + ` terminal: ${rarogCli('service install', 'clone')} prints the list of changes there and asks [y/N]. Restart the`
    + ` service without switching: ${installationCli(switching.from, 'restart')}. ${NOTHING_STOPPED}`);
}

/**
 * Co `install` klonu zrobi z dowiązaniem `~/.local/bin/rarog` ({@link ensureRarogLink}) i jak to cofnąć (`undo`,
 * `null` = nic do cofnięcia): nowe dowiązanie usuwa `rm`, a podmienione (np. polecenie paczki z prefiksu
 * `~/.local`) wraca do dawnego celu przez `ln -sfn`, bo `service install` paczki dowiązania nie zakłada. Nic nie zapisuje.
 */
function rarogLinkPlan(home: string): { readonly link: string; readonly text: string; readonly undo: string | null } {
  const link = rarogLinkPath(home);
  const shadows = `${RAROG_BIN} (may shadow the rarog command of the package in PATH)`;
  const stats = lstatSync(link, { throwIfNoEntry: false });
  if (stats === undefined) return { link, text: `none → ${shadows}`, undo: `rm ${quote(link)}` };
  if (!stats.isSymbolicLink()) return { link, text: 'stays (a file, not a symlink)', undo: null };
  const target = readlinkSync(link);
  if (target === RAROG_BIN) return { link, text: 'unchanged (points to this clone)', undo: null };
  return { link, text: `${target} → ${shadows}`, undo: `ln -sfn ${quote(target)} ${quote(link)}` };
}

/**
 * Lista zmian przełączenia z paczki na ten klon (wejście, węzeł, wrapper, katalog danych, dowiązanie, restart), co
 * zostaje i komenda powrotu na paczkę: jej węzeł i wejście z argv usługi, które działają bez `PATH`.
 */
function switchLines(
  switching: PackageSwitch, next: { readonly argv: readonly string[]; readonly dataDir: string }, home: string,
  label: string,
): string[] {
  const change = (name: string, before: string, after: string): string => (before === after
    ? `    ${name}: unchanged (${after})` : `    ${name}: ${before} → ${after}`);
  const wrapper = (argv: readonly string[]): string => serviceArgvWrapper(argv).join(' ') || 'none';
  const link = rarogLinkPlan(home);
  return [
    `Service ${label} starts ${servicePackageText(switching.from)}; install switches it to this clone.`
      + ' What changes:',
    `    entry: ${switching.from.bin} → ${RAROG_BIN} (repo clone, version ${RAROG_VERSION})`,
    change('node', serviceArgvNode(switching.argv) ?? '?', serviceArgvNode(next.argv) ?? '?'),
    change('service.wrapper', wrapper(switching.argv), wrapper(next.argv)),
    change('data directory (service log)', switching.dataDir ?? '?', next.dataDir),
    `    symlink ${link.link}: ${link.text}`,
    '    server: stopped and started from the code of this clone; apps lose the connection for a few seconds',
    `  Unchanged: devices, config.json and the hook copy in ${hookInstallDir(home)} (${REPAIR.hooksDoctor} shows`
      + ' whether it matches this clone).',
    `  Back to the package: ${installationCli(switching.from, 'service install')}`
      + `${link.undo === null ? '' : `, then ${link.undo}`}.`,
  ];
}

/**
 * Koniec fazy 0 przy {@link PackageSwitch}: lista zmian ({@link switchLines}) i pytanie `[y/N]`; „nie” albo EOF =
 * odmowa, zanim cokolwiek się zatrzyma.
 */
async function confirmSwitch(
  io: CliIo, switching: PackageSwitch | null, next: { readonly argv: readonly string[]; readonly dataDir: string },
  label: string,
): Promise<void> {
  if (switching === null) return;
  const ask = io.ask;
  if (ask === undefined) throw switchWithoutTerminal(switching, label);
  for (const line of switchLines(switching, next, homeOf(io.env), label)) out(io, line);
  if (!isYes(await ask(`Switch service ${label} from the package to this clone? [y/N] `))) {
    throw new Refusal(`switch declined; the service still starts ${servicePackageText(switching.from)}.`
      + ` ${NOTHING_STOPPED}`);
  }
}

/**
 * Cel zainstalowanej usługi, którego klon nie ustala: plik usługi jest, ale {@link servicePlistArgv} albo
 * {@link unitArgv} go nie czyta (np. `ExecStart` bez cudzysłowów, poprawka ręczna). Taka usługa może startować paczkę
 * npm, więc `install` z klonu traktuje zapis jak przełączenie z paczki: bez terminala odmowa przed fazą 0, w terminalu
 * lista zmian i pytanie ({@link confirmUnknownTarget}). `null` = tryb paczki, brak pliku albo cel odczytany.
 */
interface UnknownTarget {
  readonly issue: string;
  readonly dataDir: string | null;
}

function unknownTarget(io: CliIo, platform: 'darwin' | 'linux', mode: InstallMode): UnknownTarget | null {
  if (mode !== 'clone') return null;
  const home = homeOf(io.env);
  const file = platform === 'linux' ? unitFilePath(home) : servicePlistPath(home);
  if (lstatSync(file, { throwIfNoEntry: false }) === undefined) return null;
  const found = platform === 'linux' ? unitArgv(io) : servicePlistArgv(io);
  return 'issue' in found ? { issue: found.issue, dataDir: installedServiceDataDir(io, platform, home) } : null;
}

function unknownWithoutTerminal(unknown: UnknownTarget, label: string): Refusal {
  return new Refusal(`service ${label}: target of the current service unreadable: ${unknown.issue} This is the repo`
    + ` clone ${INSTALL_ROOT}, so install would replace the service without knowing what it starts (maybe the npm`
    + ` package). Confirm the replacement in a terminal: ${rarogCli('service install', 'clone')} prints the list of`
    + ` changes there and asks [y/N]. ${NOTHING_STOPPED}`);
}

/** {@link UnknownTarget} bez terminala = odmowa przed fazą 0, bez wrappera sekretów i bez zapisu. */
function refuseUnknownWithoutTerminal(io: CliIo, unknown: UnknownTarget | null, label: string): void {
  if (unknown !== null && io.ask === undefined) throw unknownWithoutTerminal(unknown, label);
}

/**
 * Koniec fazy 0 przy {@link UnknownTarget}: lista zmian jak przy przełączeniu z paczki, z linią o nieczytelnym celu
 * i bez komendy powrotu (plik nie mówi, którą instalację startował), i pytanie `[y/N]`; „nie” albo EOF = odmowa.
 */
async function confirmUnknownTarget(
  io: CliIo, unknown: UnknownTarget | null, next: { readonly argv: readonly string[]; readonly dataDir: string },
  label: string,
): Promise<void> {
  if (unknown === null) return;
  const ask = io.ask;
  if (ask === undefined) throw unknownWithoutTerminal(unknown, label);
  const home = homeOf(io.env);
  const link = rarogLinkPlan(home);
  const lines = [
    `Service ${label}: install replaces it with a service of this clone, without knowing what it starts. What`
      + ' changes:',
    `    target of the current service unreadable: ${unknown.issue}`,
    `    entry: ? → ${RAROG_BIN} (repo clone, version ${RAROG_VERSION})`,
    `    node: ? → ${serviceArgvNode(next.argv) ?? '?'}`,
    `    service.wrapper: ? → ${serviceArgvWrapper(next.argv).join(' ') || 'none'}`,
    `    data directory (service log): ${unknown.dataDir === next.dataDir ? `unchanged (${next.dataDir})`
      : `${unknown.dataDir ?? '?'} → ${next.dataDir}`}`,
    `    symlink ${link.link}: ${link.text}`,
    '    server: stopped and started from the code of this clone; apps lose the connection for a few seconds',
    `  Unchanged: devices, config.json and the hook copy in ${hookInstallDir(home)} (${REPAIR.hooksDoctor} shows`
      + ' whether it matches this clone).',
    '  No command to go back to the previous installation: the service file does not say which one it started.',
  ];
  for (const line of lines) out(io, line);
  if (!isYes(await ask(`Replace service ${label} with a service of this clone? [y/N] `))) {
    throw new Refusal(`replacement declined; the service file is unchanged. ${NOTHING_STOPPED}`);
  }
}

export function spawnText(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout = 30_000) {
  return spawnSync(command, args, { env, encoding: 'utf8', timeout, cwd: INSTALL_ROOT });
}

/** Linie wyjścia procesu potomnego z wcięciem (pusty koniec pominięty). */
export function indented(text: string): string[] {
  return text.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1).map((line) => `  ${line}`);
}

/** `plutil -lint` na tekście plistu w pliku tymczasowym w katalogu konfiguracji (0700, blokada już jest nasza). */
function lintPlist(text: string, io: CliIo): void {
  const file = path.join(rarogConfigDir(io.env), `${SERVICE_LABEL}.plist.sprawdzany`);
  writeFileSync(file, text, { mode: 0o600 });
  try {
    const lint = spawnText('plutil', ['-lint', file], io.env);
    if (lint.error !== undefined || lint.status !== 0) {
      const detail = lint.error?.message ?? `${lint.stdout}${lint.stderr}`.trim();
      throw new Refusal(`the plist from the template fails plutil -lint (${detail}). ${NOTHING_STOPPED}`);
    }
  } finally {
    rmSync(file, { force: true });
  }
}

/** Faza 0: każda odmowa tutaj pada, zanim cokolwiek zostanie zatrzymane. */
async function prepare(io: CliIo, mode: InstallMode, given?: string): Promise<Prepared> {
  const home = homeOf(io.env);
  out(io, 'rarog service install — phase 0 (checks, stops nothing):');
  // Zmienne katalogu danych puste w powłoce i w domenie launchd — ta sama reguła co w `rarog restart`.
  refuseLaunchdDataDirEnv(io, 'install');
  if (!serviceNodeVersionOk(process.versions.node)) {
    throw new Refusal(`the node of this installation is v${process.versions.node} (${process.execPath}), but the`
      + ` service requires ${nodeRequirement()} (process.execve); this path goes into the plist. Run install with such`
      + ' a node.');
  }
  out(io, `  service node: ${serviceTarget().node} (v${process.versions.node})`);

  // Konfiguracja, katalog danych i port tak, jak zobaczy je usługa: środowisko launchd, nie ta powłoka.
  const env = launchdEnv(io.env);
  let built: ServeEnv;
  try {
    built = buildServeEnv(env, { env: {}, mode: 'check' });
  } catch (failure) {
    if (failure instanceof Refusal) throw new Refusal(`${failure.message} ${NOTHING_STOPPED}`);
    throw failure;
  }
  if (built.config === null) {
    throw new Refusal(`no ${path.join(rarogConfigDir(io.env), 'config.json')}; the service starts \`rarog serve\``
      + ` without flags, so it does not come up without a config file. ${NOTHING_STOPPED}`);
  }
  const captured: string[] = [];
  const quiet: CliIo = { ...io, stdout: (text) => { captured.push(text); }, stderr: (text) => { captured.push(text); } };
  const checked = await checkServeEnv(built, quiet, 'rarog serve --check');
  if (!checked.ok) {
    throw new Refusal(`the config fails the check. ${NOTHING_STOPPED}\n${captured.join('')}`
      .trimEnd());
  }
  out(io, `  config: ${built.config.file}, data directory ${checked.dataDir}, port ${String(checked.port)}`);
  refuseOtherDataDir(given, checked.dataDir);

  const socket = adminSocketPath(checked.dataDir);
  if (Buffer.byteLength(socket, 'utf8') > ADMIN_SOCKET_PATH_MAX) {
    throw new Refusal(`the admin socket path ${socket} has ${String(Buffer.byteLength(socket, 'utf8'))} B, but a`
      + ` Unix socket on macOS holds ${String(ADMIN_SOCKET_PATH_MAX)} B; the server could not create the socket.`
      + ` Choose a shorter data directory. ${NOTHING_STOPPED}`);
  }
  // Serwer tych danych na innym porcie (np. `rarog serve` z ręki przed zmianą `RAROG_PORT`) zostałby obok usługi —
  // `restart.sh` zatrzymuje tylko serwer portu z konfiguracji. Ta sama reguła co w `rarog restart` i na Linuksie.
  if (await accepts({ path: socket }) && !await accepts({ host: '127.0.0.1', port: checked.port })) {
    throw new Refusal(`the server of data directory ${checked.dataDir} is running (socket ${socket}), but not on`
      + ` port ${String(checked.port)} from the config; RAROG_PORT changed? restart.sh stops only the server on that`
      + ' port, so the old one would stay next to the new one on the same data. Stop the old server by hand and'
      + ` repeat install. ${NOTHING_STOPPED}`);
  }

  const wrapper = built.config.wrapper ?? [];
  const head = wrapper[0];
  if (head !== undefined) {
    if (!path.isAbsolute(head)) {
      throw new Refusal(`service.wrapper starts with "${head}", but launchd needs an absolute path`
        + ` (fix ${built.config.file}). ${NOTHING_STOPPED}`);
    }
    try {
      accessSync(head, constants.X_OK);
    } catch {
      throw new Refusal(`service.wrapper: ${head} does not exist or is not executable. ${NOTHING_STOPPED}`);
    }
  }

  const programArguments = serviceArgv(wrapper, ['serve']);
  const log = path.join(checked.dataDir, 'server.log');
  const plist = renderServicePlist({ programArguments, workingDirectory: INSTALL_ROOT, log });
  lintPlist(plist, io);
  out(io, '  plist from the template: plutil -lint OK');

  // Pełny poziom `--check`: przez wrapper, z sekretami, na środowisku jak pod launchd.
  const command = serviceArgv(wrapper, ['serve', '--check']);
  out(io, `  rarog serve --check ${wrapper.length > 0 ? 'through service.wrapper' : 'without a wrapper'}:`);
  const full = spawnText(command[0] ?? process.execPath, command.slice(1), env, WRAPPER_CHECK_TIMEOUT_MS);
  for (const line of indented(full.stdout ?? '')) out(io, line);
  for (const line of indented(full.stderr ?? '')) err(io, line);
  if (full.error !== undefined || full.status !== 0) {
    throw new Refusal(`rarog serve --check ${wrapper.length > 0 ? 'through service.wrapper ' : ''}failed`
      + ` (${full.error?.message ?? `code ${String(full.status)}`}). ${NOTHING_STOPPED}`);
  }
  // Pod wrapperem `--check` bez żadnego sekretu przechodzi z linią „not checked”, a prawdziwy start odmówi.
  if (wrapper.length > 0 && (full.stdout ?? '').split('\n').some((line) => line.trim() === SECRETS_UNCHECKED_LINE)) {
    throw new Refusal(`${WRAPPER_WITHOUT_SECRETS} ${NOTHING_STOPPED}`);
  }
  // Wrapper może dołożyć zmienną katalogu danych albo podmienić HOME (inny `config.json`, inny port) — wtedy usługa
  // pracowałaby na innych danych niż hook i niż katalog logu w plistcie. Porównanie z liniami pełnego `--check`.
  // `RAROG_PORT` z wrappera nie działa: `rarog serve` bierze port z `config.json`, nie ze środowiska rodzica.
  const seenDataDir = checkValue(full.stdout ?? '', CHECK_DATA_DIR_LABEL);
  const seenPort = checkValue(full.stdout ?? '', CHECK_PORT_LABEL);
  if (seenDataDir !== checked.dataDir || seenPort !== String(checked.port)) {
    throw new Refusal(`the full rarog serve --check${wrapper.length > 0 ? ' through service.wrapper' : ''} sees data`
      + ` directory ${seenDataDir ?? '?'} and port ${seenPort ?? '?'}, but the check without the wrapper`
      + ` ${checked.dataDir} and ${String(checked.port)}; does the wrapper set ${PROCESS_NAMES.join(', ')} or HOME?`
      + ` The service would work on other data than the hook. ${NOTHING_STOPPED}`);
  }

  // Stan usługi na końcu fazy 0, tuż przed `bootout`: „nie wiem” = odmowa tutaj, bo w fazie 1 pominięty `bootout`
  // zostawiłby starą instancję usługi obok nowego plistu.
  decidedLoadState(SERVICE_LABEL, io);
  return { home, plist, argv: programArguments, dataDir: checked.dataDir, port: checked.port, mode };
}

/** Czekanie po `bootout`, aż launchd zdejmie etykietę: sufit i krok pytania. */
export interface BootoutWait {
  readonly timeoutMs: number;
  readonly stepMs: number;
}

/**
 * Domyślne czekanie po `bootout`: launchd przy usłudze z `KeepAlive` kończy `bootout` asynchronicznie, a `bootstrap`
 * tej samej etykiety przed końcem pada z „Bootstrap failed: 5” (zaobserwowane);
 * przy innej etykiecie stary proces może jeszcze trzymać port.
 */
export const BOOTOUT_WAIT: BootoutWait = { timeoutMs: 30_000, stepMs: 500 };

/** Sleep without the event loop: waiting after `bootout` is synchronous (`spawnSync`); only `restart.sh` is async. */
function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Po udanym `bootout`: {@link loadState} co `stepMs`, aż etykieta zniknie (kod 113). `null` = zniknęła; inaczej
 * powód porażki — limit przekroczony albo „nie wiem” w trakcie.
 */
export function waitUntilAbsent(label: string, io: CliIo, wait: BootoutWait = BOOTOUT_WAIT): string | null {
  const target = launchdTarget(label) ?? label;
  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    const state = loadState(label, io);
    if (state === 'absent') return null;
    if (typeof state === 'object') {
      return `after launchctl bootout ${target} the state is undecided (${state.unknown}); unknown whether launchd`
        + ` removed ${label}.`;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      return `after launchctl bootout ${target} label ${label} is still loaded after`
        + ` ${String(wait.timeoutMs / 1000)} s; launchd did not remove it, bootstrap would come too early.`;
    }
    sleepSync(Math.min(wait.stepMs, left));
  }
}

/**
 * `launchctl bootout` jednej etykiety, jeśli jest załadowana, i czekanie, aż launchd ją zdejmie
 * ({@link waitUntilAbsent}); `null` = zrobione albo nie było czego. Stan pytany od nowa (mógł się zmienić od
 * fazy 0); „nie wiem” = porażka, nie pominięcie.
 */
function bootout(label: string, io: CliIo, wait: BootoutWait): string | null {
  const target = launchdTarget(label) ?? label;
  const state = loadState(label, io);
  if (typeof state === 'object') {
    return `launchctl print ${target} does not decide whether ${label} is loaded (${state.unknown}); bootout`
      + ' held back, no further steps.';
  }
  if (state === 'absent') return null;
  const result = spawnText('launchctl', ['bootout', target], io.env, 60_000);
  if (result.error !== undefined || result.status !== 0) {
    return `launchctl bootout ${target} failed (${result.error?.message ?? `code ${String(result.status)}`}`
      + `${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}).`;
  }
  out(io, `  bootout ${target}`);
  return waitUntilAbsent(label, io, wait);
}

/** Zapis pliku przez plik tymczasowy obok i `rename` — launchd nie zobaczy połowy plistu. */
function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, text, { mode: 0o644 });
  renameSync(temp, file);
}

/**
 * Dowiązanie `~/.local/bin/rarog` → `bin/rarog.mjs` w klonie repo ({@link ensureRarogLink}). W paczce npm nic:
 * polecenie `rarog` w `PATH` daje menedżer paczek, a dowiązanie klonu by je przesłoniło. Zwraca linie raportu.
 */
function rarogLinkLines(home: string, mode: InstallMode): string[] {
  return mode === 'clone' ? [ensureRarogLink(home)] : [];
}

/** Dowiązanie `~/.local/bin/rarog` → `bin/rarog.mjs`; cudzego pliku nie nadpisuje. Zwraca linię raportu. */
function ensureRarogLink(home: string): string {
  const link = rarogLinkPath(home);
  try {
    mkdirSync(path.dirname(link), { recursive: true });
    let stats: ReturnType<typeof lstatSync> | null = null;
    try {
      stats = lstatSync(link);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    }
    if (stats === null) {
      symlinkSync(RAROG_BIN, link);
      return `  symlink ${link} → ${RAROG_BIN}`;
    }
    if (!stats.isSymbolicLink()) {
      return `  WARNING: ${link} exists and is not a symlink; left as is; run rarog with ${REPAIR.cli}.`;
    }
    const target = readlinkSync(link);
    if (target === RAROG_BIN) return `  symlink ${link} → ${RAROG_BIN} (already there)`;
    unlinkSync(link);
    symlinkSync(RAROG_BIN, link);
    return `  symlink ${link} → ${RAROG_BIN} (pointed to ${target})`;
  } catch (failure) {
    return `  WARNING: cannot create symlink ${link} (${(failure as NodeJS.ErrnoException).code ?? 'error'});`
      + ` the service works, run rarog with ${REPAIR.cli}.`;
  }
}

/**
 * `uninstall` in a clone: removes `~/.local/bin/rarog` only when it is a symlink to this clone's `bin/rarog.mjs`
 * (the one {@link ensureRarogLink} made), so the package's `rarog` in `PATH` is no longer shadowed. Another symlink
 * or a file stays with a report line; no entry = no line. The npm package does nothing (its `rarog` comes from the
 * package manager).
 */
function removeRarogLink(home: string, mode: InstallMode): string | null {
  if (mode !== 'clone') return null;
  const link = rarogLinkPath(home);
  try {
    const stats = lstatSync(link, { throwIfNoEntry: false });
    if (stats === undefined) return null;
    if (!stats.isSymbolicLink()) return `${link} stays: it is not a symlink.`;
    const target = readlinkSync(link);
    if (path.resolve(path.dirname(link), target) !== RAROG_BIN) {
      return `Symlink ${link} stays: it points to ${target}, not to this clone.`;
    }
    unlinkSync(link);
    return `Symlink ${link} removed (it pointed to this clone).`;
  } catch (failure) {
    return `WARNING: cannot remove symlink ${link} (${(failure as NodeJS.ErrnoException).code ?? 'error'});`
      + ` remove it by hand: rm ${quote(link)}`;
  }
}

/** Faza 1. Od pierwszego `bootout` każda porażka wypisuje komendy powrotu. */
async function apply(io: CliIo, prepared: Prepared, wait: BootoutWait, output?: ChildSink): Promise<number> {
  const { home } = prepared;
  const fail = (what: string, code = EXIT_REFUSED): number => {
    err(io, `rarog service install: ${what}`);
    for (const line of rollbackLines(home, prepared.mode)) err(io, line);
    return code;
  };
  out(io, 'rarog service install — phase 1 (stop and switch):');
  try {
    return await switchOver(io, prepared, fail, wait, output);
  } catch (failure) {
    // Wyjątek po `bootout` (np. `bash` nie startuje w `runRestartScript`) też musi wypisać drogę powrotu.
    return fail(failure instanceof Error ? failure.message : String(failure));
  }
}

/** Kroki fazy 1 po kolei; porażka każdego idzie przez `fail` z komendami powrotu. */
async function switchOver(
  io: CliIo, prepared: Prepared, fail: (what: string, code?: number) => number, wait: BootoutWait, output?: ChildSink,
): Promise<number> {
  const { home, plist, dataDir, port } = prepared;
  const issue = bootout(SERVICE_LABEL, io, wait);
  if (issue !== null) return fail(issue);
  const plistFile = servicePlistPath(home);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(path.dirname(plistFile), { recursive: true });
    writeAtomic(plistFile, plist);
    out(io, `  plist ${plistFile}`);
  } catch (failure) {
    return fail(`writing files failed (${(failure as NodeJS.ErrnoException).code ?? String(failure)}).`);
  }
  const domain = launchdDomain() ?? 'gui';
  const loaded = spawnText('launchctl', ['bootstrap', domain, plistFile], io.env, 60_000);
  if (loaded.error !== undefined || loaded.status !== 0) {
    return fail(`launchctl bootstrap ${domain} ${plistFile} failed`
      + ` (${loaded.error?.message ?? `code ${String(loaded.status)}`}${loaded.stderr.trim() === '' ? ''
        : `: ${loaded.stderr.trim()}`}).`);
  }
  out(io, `  bootstrap ${domain} ${plistFile}`);
  out(io, `  restart.sh with label ${SERVICE_LABEL}, port ${String(port)}:`);
  const result = await runRestartScript(scriptEnv(io, {
    RAROG_RESTART_LABEL: SERVICE_LABEL,
    RAROG_RESTART_PORT: String(port),
    RAROG_LOG: path.join(dataDir, 'server.log'),
  }), output);
  if (result.code !== 0) {
    return fail(`${childExitText('restart.sh', result)}; the service is loaded, but unhealthy.`, result.code);
  }
  for (const line of rarogLinkLines(home, prepared.mode)) out(io, line);
  out(io, `rarog service install: done — ${SERVICE_LABEL} is running. Check: ${rarogCli('doctor', prepared.mode)}.`);
  return EXIT_OK;
}

/**
 * Sprawdzenie `rarog setup` pod blokadą instalatora, zanim cokolwiek się zmieni: napis = powód odmowy (usługa albo
 * dowiązanie `rarog` powstały w trakcie pytania), `null` = można instalować.
 */
export type InstallPrecheck = () => string | null;

function runPrecheck(precheck: InstallPrecheck | undefined): void {
  const reason = precheck?.() ?? null;
  if (reason !== null) throw new Refusal(reason);
}

async function install(
  io: CliIo, wait: BootoutWait, precheck?: InstallPrecheck, deps: ServiceDeps = {},
): Promise<number> {
  refuseTransientInstall(io, deps);
  const lock = acquireLock(rarogConfigDir(io.env), 'rarog service install');
  try {
    runPrecheck(precheck);
    const mode = deps.mode ?? INSTALL_MODE;
    const switching = packageSwitch(io, 'darwin', mode);
    refuseSwitchWithoutTerminal(io, switching, SERVICE_LABEL);
    const unknown = unknownTarget(io, 'darwin', mode);
    refuseUnknownWithoutTerminal(io, unknown, SERVICE_LABEL);
    const prepared = await prepare(io, mode, deps.dataDir);
    await confirmSwitch(io, switching, prepared, SERVICE_LABEL);
    await confirmUnknownTarget(io, unknown, prepared, SERVICE_LABEL);
    return await apply(io, prepared, wait, deps.output);
  } finally {
    lock.release();
  }
}

async function uninstall(io: CliIo, wait: BootoutWait, deps: ServiceDeps = {}): Promise<number> {
  const home = homeOf(io.env);
  const mode = deps.mode ?? INSTALL_MODE;
  const lock = acquireLock(rarogConfigDir(io.env), 'rarog service uninstall');
  try {
    // „Nie wiem” = odmowa przed `bootout` i przed usunięciem plistu; etykieta, której launchd nie zdjął w limicie,
    // też zostawia plist.
    const wasLoaded = decidedLoadState(SERVICE_LABEL, io) === 'loaded';
    const issue = bootout(SERVICE_LABEL, io, wait);
    if (issue !== null) throw new Refusal(`${issue} The plist stays.`);
    const plistFile = servicePlistPath(home);
    const hadPlist = existsSync(plistFile);
    const dataDir = uninstalledDataDir(io, 'darwin', home);
    rmSync(plistFile, { force: true });
    out(io, `rarog service uninstall: ${wasLoaded ? `${SERVICE_LABEL} unloaded (the service server is STOPPED)`
      : `${SERVICE_LABEL} was not loaded`}, ${hadPlist ? `${plistFile} removed` : `${plistFile} did not exist`}.`
      + ' The data directory, ~/.config/rarog stay.');
    const linkLine = removeRarogLink(home, mode);
    if (linkLine !== null) out(io, linkLine);
    out(io, `Reinstall: ${rarogCli('service install', mode)}.`);
    // The herdr agent is not Rarog's service: it stays, and the lines say how to remove it.
    for (const one of herdrAgentUninstallLines(home)) out(io, one);
    await packageUninstall(io, home, mode, uninstallPaths(io, deps, dataDir));
    return EXIT_OK;
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Linux: jednostka systemd --user
// ---------------------------------------------------------------------------

const NOTHING_CHANGED = 'Nothing was changed.';

/**
 * Komendy powrotu po porażce fazy 1 na Linuksie: wyłączenie i zatrzymanie jednostki, usunięcie jej pliku,
 * przeładowanie menedżera; dane i konfiguracja zostają.
 */
export function unitRollbackLines(home: string, mode: InstallMode = INSTALL_MODE): string[] {
  return [
    `ROLLBACK (disables ${UNIT_NAME}; data and config stay), in a shell:`,
    ...cdLines(mode),
    `  ${rarogCli('service uninstall', mode)}`,
    'Without the CLI (this also breaks the Restart=always loop of the new unit):',
    `  systemctl --user disable --now ${UNIT_NAME}`,
    `  rm ${quote(unitFilePath(home))}`,
    '  systemctl --user daemon-reload',
  ];
}

/** Kod albo błąd uruchomienia i pierwsza linia stderr — bez stdout. */
function failureText(result: ReturnType<typeof spawnText>): string {
  if (result.error !== undefined) return result.error.message;
  const how = result.status === null ? `signal ${String(result.signal)}` : `code ${String(result.status)}`;
  const first = (result.stderr.trim().split('\n')[0] ?? '').trim();
  return `${how}${first === '' ? '' : `: ${first}`}`;
}

function failed(result: ReturnType<typeof spawnText>): boolean {
  return result.error !== undefined || result.status !== 0;
}

function systemctlUser(args: readonly string[], io: CliIo): ReturnType<typeof spawnText> {
  return spawnText('systemctl', ['--user', ...args], io.env, 60_000);
}

/** Wynik fazy 0 na Linuksie: wszystko, czego potrzebuje faza 1. */
interface PreparedUnit {
  readonly home: string;
  readonly unit: string;
  /** `ExecStart` nowej jednostki. */
  readonly argv: readonly string[];
  readonly dataDir: string;
  readonly port: number;
  readonly mode: InstallMode;
}

/**
 * `systemd-analyze verify` jednostki z szablonu w pliku tymczasowym (nazwa `*.service`) w katalogu konfiguracji
 * (0700, blokada już jest nasza). Tryb systemowy, bo `--user verify` bez menedżera pada; brak narzędzia to
 * linia „nie sprawdzone”, nie odmowa.
 */
function verifyUnit(text: string, io: CliIo): void {
  const file = path.join(rarogConfigDir(io.env), 'rarog-sprawdzany.service');
  writeFileSync(file, text, { mode: 0o600 });
  try {
    const verify = spawnText('systemd-analyze', ['verify', file], io.env, 60_000);
    if ((verify.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      out(io, '  unit from the template: systemd-analyze verify not checked (no systemd-analyze in PATH)');
      return;
    }
    if (failed(verify)) {
      const detail = verify.error?.message ?? `${verify.stdout}${verify.stderr}`.trim();
      throw new Refusal(`the unit from the template fails systemd-analyze verify (${detail}). ${NOTHING_STOPPED}`);
    }
    out(io, '  unit from the template: systemd-analyze verify OK');
  } finally {
    rmSync(file, { force: true });
  }
}

/** Wartość linii `<etykieta>: <wartość>` z wyjścia `rarog serve --check` (ostatnie wystąpienie); `null` = brak. */
export function checkValue(stdout: string, label: string): string | null {
  const lines = stdout.split('\n').filter((line) => line.startsWith(`${label}: `));
  const last = lines.at(-1);
  return last === undefined ? null : last.slice(label.length + 2);
}

/** Faza 0 na Linuksie: każda odmowa tutaj pada, zanim cokolwiek zostanie zapisane albo zatrzymane. */
async function prepareUnit(io: CliIo, mode: InstallMode, given?: string): Promise<PreparedUnit> {
  const home = homeOf(io.env);
  out(io, 'rarog service install — phase 0 (checks, stops nothing):');
  for (const name of PROCESS_NAMES) {
    if ((io.env[name] ?? '') !== '') {
      throw new Refusal(`${name} is set in this shell, but the systemd --user unit gets the manager environment`
        + ' without it; the data directory of the installation and of the service would differ (the hook in Claude'
        + ` sessions too). Run install without this variable. ${NOTHING_STOPPED}`);
    }
  }
  // Środowisko menedżera użytkownika dziedziczy każda jednostka (`set-environment` też), więc to ono decyduje.
  const manager = managerEnvironment(io);
  if ('failure' in manager) {
    throw new Refusal(`the systemd --user manager environment (busctl … Manager Environment) is unreadable`
      + ` (${manager.failure}), and that is what the service gets. ${NOTHING_STOPPED}`);
  }
  for (const name of PROCESS_NAMES) {
    if ((manager.env[name] ?? '') !== '') {
      throw new Refusal(`${name} is set in the systemd --user manager environment, so the service would get it;`
        + ` the data directory would differ from the checked one. Remove it: systemctl --user unset-environment`
        + ` ${name}. ${NOTHING_STOPPED}`);
    }
  }
  const unitDir = userUnitDir(home);
  const unitPath = managerStrings(io, 'UnitPath');
  if ('failure' in unitPath) {
    throw new Refusal(`the unit search path of the manager (busctl … Manager UnitPath) is unreadable`
      + ` (${unitPath.failure}). ${NOTHING_STOPPED}`);
  }
  if (!unitPath.values.some((dir) => samePath(dir, unitDir))) {
    throw new Refusal(`the systemd --user manager does not look for units in ${unitDir} (not in UnitPath; another`
      + ' XDG_CONFIG_HOME of the manager?), so a unit written there would be invisible. Run install in a regular'
      + ` user session. ${NOTHING_STOPPED}`);
  }
  const early = showUnit(io, UNIT_STATE_PROPS, UNIT_ENV_PROPS);
  if ('failure' in early) {
    throw new Refusal(`systemctl --user show ${UNIT_NAME} does not decide the unit state (${early.failure}).`
      + ` ${NOTHING_STOPPED}`);
  }
  const dropIns = (early.values.get('DropInPaths') ?? '').trim();
  if (dropIns !== '') {
    throw new Refusal(`${UNIT_NAME} has drop-ins (${dropIns}): they survive a reinstall and can change the start or`
      + ' the environment of the service. Remove them and run systemctl --user daemon-reload; server variables go to'
      + ` config.json. ${NOTHING_STOPPED}`);
  }
  if (!serviceNodeVersionOk(process.versions.node)) {
    throw new Refusal(`the node of this installation is v${process.versions.node} (${process.execPath}), but the`
      + ` service requires ${nodeRequirement()} (process.execve); this path goes into the unit. Run install with such`
      + ' a node.');
  }
  out(io, `  service node: ${serviceTarget().node} (v${process.versions.node})`);
  const missing = LINUX_RESTART_TOOLS.filter((tool) => !onPath(tool, io.env));
  if (missing.length > 0) {
    throw new Refusal(`missing in PATH: ${missing.join(', ')}; restart.sh needs them for health (curl) and for`
      + ` stopping by pattern (ps, pgrep). Install them (e.g. the curl and procps packages). ${NOTHING_STOPPED}`);
  }

  // Konfiguracja, katalog danych i port tak, jak zobaczy je usługa: środowisko menedżera, nie ta powłoka.
  let built: ServeEnv;
  try {
    built = buildServeEnv(manager.env, { env: {}, mode: 'check' });
  } catch (failure) {
    if (failure instanceof Refusal) throw new Refusal(`${failure.message} ${NOTHING_STOPPED}`);
    throw failure;
  }
  if (built.config === null) {
    throw new Refusal(`no ${path.join(rarogConfigDir(manager.env), 'config.json')}; the service starts \`rarog serve\``
      + ` without flags, so it does not come up without a config file. ${NOTHING_STOPPED}`);
  }
  const captured: string[] = [];
  const quiet: CliIo = { ...io, stdout: (text) => { captured.push(text); }, stderr: (text) => { captured.push(text); } };
  const checked = await checkServeEnv(built, quiet, 'rarog serve --check');
  if (!checked.ok) {
    throw new Refusal(`the config fails the check. ${NOTHING_STOPPED}\n${captured.join('')}`.trimEnd());
  }
  out(io, `  config: ${built.config.file}, data directory ${checked.dataDir}, port ${String(checked.port)}`);
  refuseOtherDataDir(given, checked.dataDir);

  const socket = adminSocketPath(checked.dataDir);
  if (Buffer.byteLength(socket, 'utf8') > ADMIN_SOCKET_PATH_MAX) {
    throw new Refusal(`the admin socket path ${socket} has ${String(Buffer.byteLength(socket, 'utf8'))} B, but the`
      + ` server creates a socket of at most ${String(ADMIN_SOCKET_PATH_MAX)} B (the macOS cap, the same on Linux).`
      + ` Choose a shorter data directory. ${NOTHING_STOPPED}`);
  }
  // Serwer tych danych na innym porcie (np. `rarog serve` z ręki przed zmianą `RAROG_PORT`) zostałby
  // obok jednostki — `restart.sh` zatrzymuje tylko serwer portu z konfiguracji. Ta sama reguła co w `rarog restart`.
  if (await accepts({ path: socket }) && !await accepts({ host: '127.0.0.1', port: checked.port })) {
    throw new Refusal(`the server of data directory ${checked.dataDir} is running (socket ${socket}), but not on`
      + ` port ${String(checked.port)} from the config; RAROG_PORT changed? restart.sh stops only the server on that`
      + ' port, so the old one would stay next to the new one on the same data. Stop the old server by hand and'
      + ` repeat install. ${NOTHING_STOPPED}`);
  }

  const wrapper = built.config.wrapper ?? [];
  const head = wrapper[0];
  if (head !== undefined) {
    if (!path.isAbsolute(head)) {
      throw new Refusal(`service.wrapper starts with "${head}", but the unit needs an absolute path`
        + ` (fix ${built.config.file}). ${NOTHING_STOPPED}`);
    }
    try {
      accessSync(head, constants.X_OK);
    } catch {
      throw new Refusal(`service.wrapper: ${head} does not exist or is not executable. ${NOTHING_STOPPED}`);
    }
  }

  const execStart = serviceArgv(wrapper, ['serve']);
  let unit: string;
  try {
    unit = renderServiceUnit({ execStart, workingDirectory: INSTALL_ROOT, log: path.join(checked.dataDir, 'server.log') });
  } catch (failure) {
    if (failure instanceof Refusal) throw new Refusal(`${failure.message} ${NOTHING_STOPPED}`);
    throw failure;
  }
  verifyUnit(unit, io);

  // Pełny poziom `--check`: przez wrapper, z sekretami, na środowisku menedżera (to dostanie usługa).
  const command = serviceArgv(wrapper, ['serve', '--check']);
  out(io, `  rarog serve --check ${wrapper.length > 0 ? 'through service.wrapper' : 'without a wrapper'}:`);
  const full = spawnText(command[0] ?? process.execPath, command.slice(1), manager.env, WRAPPER_CHECK_TIMEOUT_MS);
  for (const line of indented(full.stdout ?? '')) out(io, line);
  for (const line of indented(full.stderr ?? '')) err(io, line);
  if (failed(full)) {
    throw new Refusal(`rarog serve --check ${wrapper.length > 0 ? 'through service.wrapper ' : ''}failed`
      + ` (${full.error?.message ?? `code ${String(full.status)}`}). ${NOTHING_STOPPED}`);
  }
  if (wrapper.length > 0 && (full.stdout ?? '').split('\n').some((line) => line.trim() === SECRETS_UNCHECKED_LINE)) {
    throw new Refusal(`${WRAPPER_WITHOUT_SECRETS} ${NOTHING_STOPPED}`);
  }
  // Wrapper może dołożyć zmienną katalogu danych (albo portu) — wtedy usługa pracowałaby na innych
  // danych niż hook i niż katalog logu w jednostce. Porównanie z liniami pełnego `--check`.
  const seenDataDir = checkValue(full.stdout ?? '', CHECK_DATA_DIR_LABEL);
  const seenPort = checkValue(full.stdout ?? '', CHECK_PORT_LABEL);
  if (seenDataDir !== checked.dataDir || seenPort !== String(checked.port)) {
    throw new Refusal(`the full rarog serve --check${wrapper.length > 0 ? ' through service.wrapper' : ''} sees data`
      + ` directory ${seenDataDir ?? '?'} and port ${seenPort ?? '?'}, but the check without the wrapper`
      + ` ${checked.dataDir} and ${String(checked.port)}; does the wrapper set ${PROCESS_NAMES.join(', ')}, HOME or`
      + ` RAROG_PORT? The service would work on other data than the hook. ${NOTHING_STOPPED}`);
  }

  // Stan jednostki na końcu fazy 0, tuż przed zapisem: brak albo nasza (także zmieniona ręcznie — zapis ją
  // nadpisze); cudza, zamaskowana, z drop-inem, z błędem albo „nie wiem” = odmowa.
  const final = showUnit(io, UNIT_STATE_PROPS, UNIT_ENV_PROPS);
  if ('failure' in final) {
    throw new Refusal(`systemctl --user show ${UNIT_NAME} does not decide the unit state (${final.failure}).`
      + ` ${NOTHING_STOPPED}`);
  }
  const status = classifyUnit(final.values, home);
  switch (status.kind) {
    case 'absent':
    case 'ours':
    case 'stale':
    case 'environment':
      break;
    case 'masked':
      throw new Refusal(`${UNIT_NAME} is masked (LoadState=masked). Unmask it: systemctl --user unmask`
        + ` ${UNIT_NAME}, then repeat install. ${NOTHING_STOPPED}`);
    case 'foreign':
      throw new Refusal(`${UNIT_NAME} is loaded from ${status.detail}, not from ${unitFilePath(home)}; this is a`
        + ` foreign unit with this name, install does not cover it. ${NOTHING_STOPPED}`);
    case 'drop-in':
      throw new Refusal(`${UNIT_NAME} has drop-ins (${status.detail}). Remove them and run systemctl --user`
        + ` daemon-reload. ${NOTHING_STOPPED}`);
    default:
      throw new Refusal(`${UNIT_NAME} has ${status.detail}; install handles only loaded or not-found. Check`
        + ` systemctl --user status ${UNIT_NAME}; remove a broken unit file (rm ${quote(unitFilePath(home))},`
        + ` systemctl --user daemon-reload) and repeat. ${NOTHING_STOPPED}`);
  }
  return { home, unit, argv: execStart, dataDir: checked.dataDir, port: checked.port, mode };
}

/**
 * Linger użytkownika (`loginctl show-user … -p Linger --value`): bez niego menedżer użytkownika, a z nim usługa,
 * żyje tylko z sesją logowania. `no` i „nie wiem” to ostrzeżenie z komendą, nie porażka instalacji.
 */
function lingerLine(io: CliIo): string {
  const user = userInfo().username;
  const enable = enableLingerCommand(user);
  const linger = lingerState(io, user);
  if ('failure' in linger) {
    return `  linger: unknown (${linger.failure}); without linger the service lives only with a login session;`
      + ` enable it with ${enable}`;
  }
  const { value } = linger;
  if (value === 'yes') return '  linger: yes (the service comes up after a reboot without a login)';
  return `  WARNING: linger disabled (Linger=${value || '?'}); after a logout and after a reboot the service does not`
    + ` come up without a login session. Enable it: ${enable}`;
}

/** Faza 1 na Linuksie; każda porażka, także wyjątek, wypisuje komendy powrotu. */
async function applyUnit(io: CliIo, prepared: PreparedUnit, output?: ChildSink): Promise<number> {
  const { home, unit, dataDir, port } = prepared;
  const fail = (what: string, code = EXIT_REFUSED): number => {
    err(io, `rarog service install: ${what}`);
    for (const line of unitRollbackLines(home, prepared.mode)) err(io, line);
    return code;
  };
  out(io, 'rarog service install — phase 1 (unit write and switch):');
  try {
    const file = unitFilePath(home);
    try {
      mkdirSync(userUnitDir(home), { recursive: true });
      writeAtomic(file, unit);
    } catch (failure) {
      return fail(`writing ${file} failed (${(failure as NodeJS.ErrnoException).code ?? String(failure)}).`);
    }
    out(io, `  unit ${file}`);
    for (const args of [['daemon-reload'], ['enable', UNIT_NAME]]) {
      const result = systemctlUser(args, io);
      if (failed(result)) return fail(`systemctl --user ${args.join(' ')} failed (${failureText(result)}).`);
      out(io, `  systemctl --user ${args.join(' ')}`);
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    out(io, `  restart.sh with unit ${UNIT_NAME}, port ${String(port)}:`);
    const result = await runRestartScript(scriptEnv(io, {
      RAROG_RESTART_UNIT: UNIT_NAME,
      RAROG_RESTART_PORT: String(port),
      RAROG_LOG: path.join(dataDir, 'server.log'),
    }), output);
    if (result.code !== 0) {
      return fail(`${childExitText('restart.sh', result)}; the unit is enabled, but unhealthy.`, result.code);
    }
    out(io, lingerLine(io));
    for (const line of rarogLinkLines(home, prepared.mode)) out(io, line);
    out(io, `rarog service install: done — ${UNIT_NAME} is running. Check: ${rarogCli('doctor', prepared.mode)}.`);
    return EXIT_OK;
  } catch (failure) {
    return fail(failure instanceof Error ? failure.message : String(failure));
  }
}

/** `rarog service install` na Linuksie. */
export async function installUnit(io: CliIo, precheck?: InstallPrecheck, deps: ServiceDeps = {}): Promise<number> {
  refuseTransientInstall(io, deps);
  const lock = acquireLock(rarogConfigDir(io.env), 'rarog service install');
  try {
    runPrecheck(precheck);
    const mode = deps.mode ?? INSTALL_MODE;
    const switching = packageSwitch(io, 'linux', mode);
    refuseSwitchWithoutTerminal(io, switching, UNIT_NAME);
    const unknown = unknownTarget(io, 'linux', mode);
    refuseUnknownWithoutTerminal(io, unknown, UNIT_NAME);
    const prepared = await prepareUnit(io, mode, deps.dataDir);
    await confirmSwitch(io, switching, prepared, UNIT_NAME);
    await confirmUnknownTarget(io, unknown, prepared, UNIT_NAME);
    return await applyUnit(io, prepared, deps.output);
  } finally {
    lock.release();
  }
}

/**
 * `rarog service uninstall` on Linux: `disable --now`, unit file removal, `daemon-reload`. The unit is touched only
 * when it is loaded from our file (also with a drop-in or edited by hand); a foreign, masked or failed unit, or an
 * undecided state, is a refusal before anything changes. Data and config stay; in a clone this clone's
 * `~/.local/bin/rarog` symlink is removed ({@link removeRarogLink}).
 */
export async function uninstallUnit(io: CliIo, deps: ServiceDeps = {}): Promise<number> {
  const home = homeOf(io.env);
  const mode = deps.mode ?? INSTALL_MODE;
  const lock = acquireLock(rarogConfigDir(io.env), 'rarog service uninstall');
  try {
    const shown = showUnit(io, UNIT_STATE_PROPS, UNIT_ENV_PROPS);
    if ('failure' in shown) {
      throw new Refusal(`systemctl --user show ${UNIT_NAME} does not decide the unit state (${shown.failure}).`
        + ` ${NOTHING_CHANGED}`);
    }
    const file = unitFilePath(home);
    const status = classifyUnit(shown.values, home);
    let stopped = false;
    switch (status.kind) {
      case 'absent':
        break;
      case 'ours':
      case 'drop-in':
      case 'stale':
      case 'environment': {
        const disabled = systemctlUser(['disable', '--now', UNIT_NAME], io);
        if (failed(disabled)) {
          throw new Refusal(`systemctl --user disable --now ${UNIT_NAME} failed (${failureText(disabled)}).`
            + ' The unit file stays.');
        }
        stopped = true;
        break;
      }
      case 'masked':
        throw new Refusal(`${UNIT_NAME} is masked (LoadState=masked); unmask it (systemctl --user unmask`
          + ` ${UNIT_NAME}) and repeat. ${NOTHING_CHANGED}`);
      case 'foreign':
        throw new Refusal(`${UNIT_NAME} is loaded from ${status.detail}, not from ${file}; this is not a unit from`
          + ` rarog service install. ${NOTHING_CHANGED}`);
      default:
        throw new Refusal(`${UNIT_NAME} has ${status.detail}; uninstall handles only loaded or not-found.`
          + ` Check systemctl --user status ${UNIT_NAME}. ${NOTHING_CHANGED}`);
    }
    let hadFile = true;
    try {
      lstatSync(file);
    } catch {
      hadFile = false;
    }
    const dataDir = uninstalledDataDir(io, 'linux', home);
    rmSync(file, { force: true });
    const what = `${stopped ? `${UNIT_NAME} disabled (the service server is STOPPED)` : `${UNIT_NAME} was not loaded`},`
      + ` ${hadFile ? `${file} removed` : `${file} did not exist`}`;
    if (stopped || hadFile) {
      const reload = systemctlUser(['daemon-reload'], io);
      if (failed(reload)) {
        err(io, `rarog service uninstall: ${what}, but systemctl --user daemon-reload failed`
          + ` (${failureText(reload)}); run it by hand.`);
        return EXIT_REFUSED;
      }
    }
    out(io, `rarog service uninstall: ${what}.${status.kind === 'drop-in' ? ` The drop-ins (${status.detail}) stay.`
      : ''} The data directory, ~/.config/rarog stay.`);
    const linkLine = removeRarogLink(home, mode);
    if (linkLine !== null) out(io, linkLine);
    out(io, `Reinstall: ${rarogCli('service install', mode)}.`);
    await packageUninstall(io, home, mode, uninstallPaths(io, deps, dataDir));
    return EXIT_OK;
  } finally {
    lock.release();
  }
}

/** Ścieżki w kolejności odinstalowania paczki: korzeń instalacji (menedżer), katalog danych i konfiguracji. */
export interface UninstallPaths {
  readonly installRoot: string;
  readonly dataDir: string | null;
  readonly configDir: string;
}

/**
 * Katalog danych usuwanej usługi, odczytany przed usunięciem jej pliku: katalog logu usługi, inaczej reguła na
 * środowisku bez zmiennych katalogu danych; `null` = konflikt reguły.
 */
function uninstalledDataDir(io: CliIo, platform: NodeJS.Platform, home: string): string | null {
  const resolved = resolveDataDir({ env: launchdEnv(io.env), home });
  return installedServiceDataDir(io, platform, home) ?? (resolved.ok ? resolved.dir : null);
}

function uninstallPaths(io: CliIo, deps: ServiceDeps, dataDir: string | null): UninstallPaths {
  return { installRoot: deps.installRoot ?? INSTALL_ROOT, dataDir, configDir: rarogConfigDir(io.env) };
}

/**
 * Zdanie o kopiach zapasowych `~/.claude/settings.json` w katalogu danych (pisarz ustawień kładzie je tam przed
 * każdym zapisem): `rm -r` katalogu danych usuwa też je, w tym kopię `backup` z tego przebiegu. Osobna linia
 * pod krokiem, żeby skopiowana linia z `rm -r` nie niosła zdania jako dalszych argumentów. `null`, gdy katalogu
 * danych nie znamy albo kopii nie ma.
 */
function backupsNote(dataDir: string | null, backup: string | null): string | null {
  if (dataDir === null) return null;
  const dir = path.join(dataDir, SETTINGS_BACKUP_DIRNAME);
  let present = backup !== null;
  try {
    present ||= lstatSync(dir, { throwIfNoEntry: false }) !== undefined;
  } catch {
    present = true;
  }
  if (!present) return null;
  return `   The data directory also holds the backups of ${userSettingsPath('~')} (${quote(dir)}`
    + `${backup === null ? '' : `, the one from this run: ${quote(backup)}`}); rm -r removes them too.`;
}

/** Ostatni krok: `rm -r` katalogu danych i konfiguracji (`number` = numer kroku), z kopiami zapasowymi ustawień. */
function dataDirStep(number: number, home: string, paths: UninstallPaths, backup: string | null): string[] {
  const { dataDir, configDir } = paths;
  const step = `${String(number)}. When you are done with Rarog`;
  const text = dataDir !== null && removableDataDir(dataDir, home)
    ? `${step} (data, devices, SDK and config): rm -r ${quote(dataDir)} ${quote(configDir)}`
    : `${step}: rm -r ${quote(configDir)} (config); the data directory`
      + ` ${dataDir === null ? 'from rarog doctor' : quote(dataDir)} gets no delete command, because it does not look`
      + ` like a package data directory (no ${SDK_DIRNAME}/, or it is the home directory or above it); check it`
      + ' yourself.';
  const note = backupsNote(dataDir, backup);
  return note === null ? [text] : [text, note];
}

/** Komenda menedżera, który położył paczkę (`install/repair.ts`). */
function packageUninstallCommand(paths: UninstallPaths): string {
  return packageCommands(packageManagerOf(paths.installRoot), paths.installRoot).uninstall;
}

/**
 * Reszta odinstalowania paczki npm do zrobienia ręcznie, po kolei: wpisy Raroga do usunięcia z ustawień Claude Code
 * (hooki zgód i kontekstu, `statusLine`, ścieżki `denyRead`, reguły blokady zapisu; po odinstalowaniu paczki
 * wskazywałyby kopię, której nikt już nie aktualizuje), katalog kopii hooka, komenda menedżera, który położył paczkę
 * (npm nie uruchamia przy tym skryptów paczki, więc niczego nie posprząta sam), na końcu opcjonalnie katalog danych
 * i konfiguracji. Drukuje je
 * {@link packageUninstall}, gdy wpisy zostają w ustawieniach („n”, brak terminala, konflikt, odmowa) albo wróciły do
 * nich w czasie pytania o kopię (`backup` = kopia zapasowa z zapisu w tym przebiegu). W klonie repo nic (hook zostaje
 * razem z checkoutem).
 */
export function packageUninstallNotes(
  home: string, mode: InstallMode = INSTALL_MODE,
  paths: UninstallPaths = { installRoot: INSTALL_ROOT, dataDir: null, configDir: path.join(home, '.config', 'rarog') },
  backup: string | null = null,
): string[] {
  if (mode !== 'package') return [];
  const deny = denyReadPaths(paths.dataDir ?? '<dataDir>').map((one) => JSON.stringify(one)).join(' and ');
  const block = paths.dataDir === null ? null : writeBlockRules(paths.dataDir, home);
  const rules = block?.ok === true ? block.rules.map((one) => JSON.stringify(one)).join(' and ')
    : '"Edit(//<dataDir>/**)" and "Edit(//<home>/.config/rarog/**)"';
  return [
    '',
    'Uninstalling Rarog, step by step (the service is already removed):',
    `1. In ${userSettingsPath('~')} remove by hand the hook entries of this block (keep the rest of \`hooks\`):`,
    renderPasteHookBlock(hookCommand(home), contextHookCommand(home)),
    '   and the statusLine key, when it points to the copy of the Rarog script:',
    renderStatuslineBlock(statuslineCommand(home)),
    `   and the paths ${deny} from sandbox.filesystem.denyRead,`,
    `   and the rules ${rules} from permissions.deny.`,
    `2. Copy of the hook code and of the statusLine script: ${hookInstallDir(home)} (remove after the entries).`,
    `3. Package: ${packageUninstallCommand(paths)}`,
    ...dataDirStep(4, home, paths, backup),
  ];
}

/** Wcięcie linii pod nagłówkiem części odinstalowania: różnica, pytania i wyniki. */
const UNDER = '  ';

/** Pytanie `[y/N]` w terminalu; `null` = bez terminala. */
type Confirm = ((question: string) => Promise<boolean>) | null;

/**
 * Wpisy Raroga zostały w ustawieniach: powód (linie pod nagłówkiem) albo `null`, gdy ich tam już nie ma (zapis albo
 * nic do zdjęcia).
 */
function entriesLeft(result: SettingsWriteResult): string[] | null {
  const byHand = 'nothing removed; remove them by hand (step 1 below)';
  switch (result.kind) {
    case 'unchanged':
    case 'written':
      return null;
    case 'declined':
      return [`answer no: ${byHand}`];
    case 'no-terminal':
      return [`without a terminal ${byHand}`];
    case 'conflict':
      return [`conflict: ${byHand}`, ...result.reasons.map((reason) => `  ${reason}`)];
    case 'copy-not-ready':
      return [`${result.reason}: ${byHand}`];
    case 'refused':
      return [`${result.reason}: ${byHand}`];
  }
}

/** Nazwy wpisów do jednej linii wydruku. */
const shown = (names: readonly string[]): string => names.map((one) => visibleLine(one)).join(', ');

/**
 * Katalog kopii po zdjęciu wpisów: co zniknie (pliki z zamkniętej listy, {@link hookCopyDirState}) i co zostanie,
 * pytanie i usunięcie ({@link removeHookCopy}) po „y”, tuż przed nim ustawienia jeszcze raz ({@link copyRemovalCheck}).
 * Bez terminala, po „n” albo przy błędzie usuwania komenda do zrobienia ręcznie: `rm -r` katalogu, gdy są w nim
 * same pliki kopii, inaczej `rm` samych plików kopii. Katalog podmieniony w czasie pytania albo usuwania: powód, co
 * usunięte i co nie, bez komendy (trafiłaby w katalog, którego nikt nie pokazał). `manual` = w ustawieniach są znowu
 * wpisy Raroga albo nie da się ich odczytać: nic nie usunięte, dalej kroki ręczne.
 */
async function removeCopyStep(io: CliIo, home: string, confirm: Confirm): Promise<'done' | 'manual'> {
  const state = hookCopyDirState(home);
  const print = (line: string): void => { out(io, `${UNDER}${line}`); };
  out(io, `Copy of the hook code and of the statusLine script: ${state.dir}`);
  if (state.kind === 'missing') {
    print('not there, nothing to remove');
    return 'done';
  }
  if (state.kind === 'refused') {
    print(state.reason);
    return 'done';
  }
  print(`to remove: ${shown(state.remove)}`);
  if (state.keep.length > 0) print(`stays, not from a Rarog install: ${shown(state.keep)}`);
  /** Komenda ręczna dla plików kopii `names`, które jeszcze są w katalogu. */
  const byHand = (names: readonly string[]): string => {
    if (names.length === 0) return `remove the empty directory by hand: rmdir ${quote(state.dir)}`;
    return state.keep.length === 0
      ? `remove it by hand: rm -r ${quote(state.dir)}`
      : `remove the Rarog files by hand: rm ${names.map((one) => quote(path.join(state.dir, one))).join(' ')}`;
  };
  if (confirm === null) {
    print(`without a terminal it stays; ${byHand(state.remove)}`);
    return 'done';
  }
  const question = state.keep.length === 0
    ? 'Remove these files and the directory?' : 'Remove these files? The directory stays with the rest.';
  if (!(await confirm(question))) {
    print(`kept; ${byHand(state.remove)}`);
    return 'done';
  }
  // W czasie pytania ktoś mógł dopisać wpis Raroga do ustawień: po usunięciu wskazywałby brakujący plik.
  const check = copyRemovalCheck(home, 'rarog service uninstall');
  if (!check.ok) {
    print(`${check.reason}; nothing removed`);
    for (const entry of check.entries) print(`  ${entry}`);
    return 'manual';
  }
  const removed = removeHookCopy(state);
  if (removed.ok) {
    print(removed.dirRemoved
      ? `removed: ${state.dir}`
      : `removed: ${shown(removed.removed)}; ${state.dir} stays with: ${shown(removed.left)}`);
    return 'done';
  }
  print(removed.reason);
  if (removed.removed.length > 0) {
    print(`removed: ${shown(removed.removed)}`);
    if (removed.notRemoved.length > 0) print(`not removed: ${shown(removed.notRemoved)}`);
  }
  if (removed.why === 'failed') print(`then ${byHand(removed.notRemoved)}`);
  return 'done';
}

/**
 * Po `uninstall` w paczce npm: zdjęcie wpisów Raroga z `~/.claude/settings.json` pisarzem ustawień (operacja
 * `remove`: one `[y/N/d]` question as in `rarog setup`, the diff only on `d`; „y”, kopia zapasowa, zapis; blokadę
 * trzyma już `uninstall`), potem pytanie o katalog kopii, na końcu wydruk komendy menedżera paczek i katalogów danych
 * i konfiguracji. Katalog kopii idzie tylko wtedy, gdy wpisów Raroga w ustawieniach już nie ma (zapis albo nic do
 * zdjęcia), bo inaczej wskazywałyby brakujący plik; po „y” sprawdza to jeszcze raz. „n”, EOF, brak terminala,
 * konflikt i odmowa pisarza, a także wpisy, które wróciły w czasie pytania o kopię = kroki ręczne
 * {@link packageUninstallNotes}; kod wyjścia `uninstall` się nie zmienia. W klonie repo nic.
 */
async function packageUninstall(io: CliIo, home: string, mode: InstallMode, paths: UninstallPaths): Promise<void> {
  if (mode !== 'package') return;
  const ask = io.ask;
  const confirm: Confirm = ask === undefined
    ? null : async (question) => isYes(await ask(`${UNDER}${question} [y/N] `));
  const print = (line: string): void => { out(io, `${UNDER}${line}`); };
  out(io, '');
  out(io, `Rarog entries in ${userSettingsPath('~')} (hook entries, statusLine, denyRead paths, write block rules):`);
  const result = await writeClaudeSettings({
    home, root: paths.installRoot, operation: 'remove',
    dataDir: paths.dataDir === null
      ? { ok: false, message: 'the data directory rule gives a conflict (rarog doctor shows it)' }
      : { ok: true, dir: paths.dataDir },
    lock: 'held', print, again: 'rarog service uninstall',
    confirm: ask === undefined ? null : (question) => confirmForm(ask, entriesQuestion(question), 'y/N/d', {
      width: layoutOf(terminalOf(io).columns).width,
      showDiff: () => { for (const one of entriesDiff(question)) print(one); },
    }),
    // The diff quotes the user's file: only on the answer `d`, never up front.
    printDiff: () => {},
  });
  const left = entriesLeft(result);
  if (left !== null) {
    for (const line of left) print(line);
    for (const note of packageUninstallNotes(home, mode, paths)) out(io, note);
    return;
  }
  if (result.kind === 'unchanged') print('none left, nothing to remove');
  const backup = result.kind === 'written' ? result.backup : null;
  if (await removeCopyStep(io, home, confirm) === 'manual') {
    for (const note of packageUninstallNotes(home, mode, paths, backup)) out(io, note);
    return;
  }
  out(io, '');
  out(io, 'Uninstalling Rarog, the remaining steps:');
  out(io, `1. Package: ${packageUninstallCommand(paths)}`);
  for (const line of dataDirStep(2, home, paths, backup)) out(io, line);
}

/**
 * Katalog danych, który komenda kasowania z {@link packageUninstallNotes} może podać: nie katalog domowy ani katalog
 * nad nim, z podkatalogiem `sdk/` (`rarog setup` paczki zakłada go zawsze). Katalog danych bierze się z katalogu
 * logu usługi, więc plik usługi zmieniony ręcznie (np. log w katalogu domowym) nie trafia do `rm -r`.
 */
export function removableDataDir(dir: string, home: string): boolean {
  const toHome = path.relative(path.resolve(dir), path.resolve(home));
  if (toHome !== '..' && !toHome.startsWith(`..${path.sep}`)) return false;
  return lstatSync(path.join(dir, SDK_DIRNAME), { throwIfNoEntry: false })?.isDirectory() === true;
}

/** `rarog service install|uninstall` — `argv` zaczyna się od `service`; `wait` podają testy (krótszy limit). */
export async function serviceCommand(
  argv: readonly string[], io: CliIo, wait: BootoutWait = BOOTOUT_WAIT, deps: ServiceDeps = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(io, usageFor(io, `Usage:\n${SERVICE_USAGE}`));
    return EXIT_OK;
  }
  const action = argv[1];
  if (argv.length !== 2 || (action !== 'install' && action !== 'uninstall')) {
    throw new Usage('rarog service: expected install or uninstall, with no other arguments.');
  }
  try {
    const platform = platformOf(io);
    const issue = servicePlatformIssue(platform);
    if (issue !== null) throw new Refusal(issue);
    if (platform === 'linux') {
      return action === 'install' ? await installUnit(io, undefined, deps) : await uninstallUnit(io, deps);
    }
    return action === 'install' ? await install(io, wait, undefined, deps) : await uninstall(io, wait, deps);
  } catch (failure) {
    if (failure instanceof Refusal) {
      err(io, `rarog service ${action}: ${failure.message}`);
      return EXIT_REFUSED;
    }
    throw failure;
  }
}

/**
 * `rarog service install` dla `rarog setup`: to samo co `serviceCommand(['service', 'install'])`, ale pod blokadą
 * instalatora najpierw `precheck` — usługa zainstalowana w trakcie pytania (drugi `setup`, ręczne `service install`)
 * daje odmowę, zanim padnie pierwszy `bootout` albo zapis.
 */
export async function serviceInstallIfAbsent(
  io: CliIo, precheck: InstallPrecheck, wait: BootoutWait = BOOTOUT_WAIT, deps: ServiceDeps = {},
): Promise<number> {
  try {
    const platform = platformOf(io);
    const issue = servicePlatformIssue(platform);
    if (issue !== null) throw new Refusal(issue);
    return platform === 'linux' ? await installUnit(io, precheck, deps) : await install(io, wait, precheck, deps);
  } catch (failure) {
    if (failure instanceof Refusal) {
      err(io, `rarog service install: ${failure.message}`);
      return EXIT_REFUSED;
    }
    throw failure;
  }
}
