/**
 * Komendy naprawcze, które komunikaty podają człowiekowi do wklejenia w powłoce: JEDYNE miejsce z literałami
 * `pnpm run …`, `pnpm install`, `node bin/rarog.mjs …` i komend menedżerów paczek (`npm i -g`, `pnpm add -g`,
 * `npm uninstall -g`, `pnpm remove -g`) w kodzie `server/src` (strażnik `server/test/install-guard.test.ts`).
 * Komendy `rarog` (`server/src/cli/`) i serwer (`herdr/hook-config.ts`) składają z nich zdania; `scripts/restart.sh`
 * dostaje swoje zdanie od `rarog restart` parametrem `RAROG_RESTART_HOOK_REPAIR`.
 *
 * Komendy zależą od trybu instalacji (`mode.ts`). Klon repo: skrypty `package.json` przez `pnpm run` i wejście
 * `node bin/rarog.mjs`, oba z katalogu repo. Paczka npm: `rarog <komenda>` z `PATH`, a zależności, aktualizację
 * i odinstalowanie robi menedżer, który paczkę położył ({@link packageManagerOf}; układy katalogów w `evidence.ts`).
 */
import path from 'node:path';
import { EVIDENCE } from './evidence.ts';
import { INSTALL_MODE, INSTALL_ROOT } from './mode.ts';
import type { InstallMode } from './mode.ts';

/**
 * The npm name of Rarog's server package; the command it installs stays `rarog`. Every package manager command
 * here and the registry queries of `rarog update` use it.
 */
export const RAROG_PACKAGE_NAME = '@rarog/server';

/** Menedżer paczek globalnej instalacji paczki npm Raroga. */
export type PackageManager = 'npm' | 'pnpm';

/**
 * Menedżer, który położył paczkę w katalogu `root` (korzeń instalacji, ścieżka po `realpath`): pnpm 11 trzyma paczkę
 * globalną w sklepie (`…/links/@/<nazwa>/…/node_modules/<nazwa>`; segment po `links` zaczyna się od `@`), npm
 * w `<prefiks>/lib/node_modules/<nazwa>`. `null` = układ, którego rejestr nie zna.
 */
export function packageManagerOf(root: string): PackageManager | null {
  const parts = root.split(path.sep);
  const { npm, pnpm } = EVIDENCE.globalLayouts;
  const links = parts.indexOf(pnpm.storeSegment);
  if (links !== -1 && (parts[links + 1] ?? '').startsWith(pnpm.scopePrefix) && parts.indexOf('node_modules', links) !== -1) {
    return 'pnpm';
  }
  const at = parts.findIndex((part, i) => part === npm.segments[0] && parts[i + 1] === npm.segments[1]);
  return at === -1 ? null : 'npm';
}

/**
 * The npm global commands directory (`<prefix>/bin`, where npm puts the command `rarog`) of a package root
 * `<prefix>/lib/node_modules/<name>` or `<prefix>/lib/node_modules/@<scope>/<name>`, whatever the name; `null` for any
 * other layout (pnpm: the directory of `pnpm bin -g`, which its store path does not show).
 */
export function npmBinDir(root: string): string | null {
  const [lib, modules] = EVIDENCE.globalLayouts.npm.segments;
  const scoped = (part: string): boolean => part.startsWith('@');
  let parent = path.dirname(root);
  if (scoped(path.basename(root))) return null;
  if (scoped(path.basename(parent))) parent = path.dirname(parent);
  if (path.basename(parent) !== modules || path.basename(path.dirname(parent)) !== lib) return null;
  return path.join(path.dirname(path.dirname(parent)), 'bin');
}

/** Komendy menedżera dla paczki: instalacja na stałe, aktualizacja do najnowszej i odinstalowanie. */
export interface PackageCommands {
  readonly install: string;
  readonly update: string;
  readonly uninstall: string;
}

/** The commands of each manager for the package `name` (a name {@link isPackageName} accepts). */
function managerCommands(name: string): Readonly<Record<PackageManager, PackageCommands>> {
  return {
    npm: { install: `npm i -g ${name}`, update: `npm i -g ${name}@latest`, uninstall: `npm uninstall -g ${name}` },
    pnpm: {
      install: `pnpm add -g ${name}`, update: `pnpm add -g ${name}@latest`, uninstall: `pnpm remove -g ${name}`,
    },
  };
}

const PACKAGE_COMMANDS = managerCommands(RAROG_PACKAGE_NAME);

/** One shell word in single quotes (an apostrophe closes, escapes and reopens): safe in sh, bash and zsh. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Komendy menedżera paczki; nieznany menedżer = obie komendy w jednym zdaniu („npm … or pnpm …”). Z `root`
 * w układzie npm aktualizacja i odinstalowanie celują w prefiks TEJ instalacji (`--prefix`), bo `npm -g` bez niego
 * bierze prefiks węzła z bieżącej powłoki (inna wersja nvm, Homebrew) i zmieniłby inną instalację.
 */
export function packageCommands(manager: PackageManager | null, root?: string): PackageCommands {
  return commandsFor(RAROG_PACKAGE_NAME, manager, root);
}

/** {@link packageCommands} of the package `name`. */
function commandsFor(name: string, manager: PackageManager | null, root?: string): PackageCommands {
  const commands = managerCommands(name);
  const bin = manager === 'npm' && root !== undefined ? npmBinDir(root) : null;
  if (bin !== null) {
    const prefix = `--prefix ${shellQuote(path.dirname(bin))}`;
    return {
      ...commands.npm, update: `npm i -g ${prefix} ${name}@latest`, uninstall: `npm uninstall -g ${prefix} ${name}`,
    };
  }
  if (manager !== null) return commands[manager];
  const both = (key: keyof PackageCommands): string => `${commands.npm[key]} or ${commands.pnpm[key]}`;
  return { install: both('install'), update: both('update'), uninstall: both('uninstall') };
}

/**
 * The command that updates the npm whose `npm-cli.js` is `npmCli` (`rarog update` runs the npm next to its node), in
 * that npm's own prefix: the shell's prefix and the package's may be other ones. `null` when the file is not in an
 * npm global layout (`<prefix>/lib/node_modules/npm/bin/npm-cli.js`): such an npm comes with its Node distribution.
 */
export function npmSelfUpdate(npmCli: string): string | null {
  const root = path.dirname(path.dirname(npmCli));
  if (path.basename(root) !== 'npm' || npmBinDir(root) === null) return null;
  return commandsFor('npm', 'npm', root).update;
}

/** npm's longest package name. */
const PACKAGE_NAME_MAX = 214;

/**
 * An npm package name (an optional `@scope/`, lower-case letters, digits, `.`, `_`, `-`) that is safe as one word of a
 * pasted command and on a terminal: the name read from an installation's `package.json` is text from a file.
 */
export function isPackageName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PACKAGE_NAME_MAX
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(value);
}

/**
 * The fix of an installation of another package than {@link RAROG_PACKAGE_NAME} (`name` from its `package.json`):
 * removing that package, then installing this one. npm refuses a package whose command `rarog` another package of the
 * prefix owns (EEXIST), so the old package goes first; a `name` that {@link isPackageName} refuses leaves only the
 * install.
 */
export function otherPackageFix(manager: PackageManager | null, root: string, name: unknown): string {
  const install = packageCommands(manager, root).update;
  if (!isPackageName(name)) return install;
  return `${commandsFor(name, manager, root).uninstall}, then ${install}`;
}

/**
 * Arguments of `npm-cli.js` with which `rarog update` downloads the one version it may install over this installation
 * `current`: the tarball of the highest version above `current` up to `latest` (one argument) into `dir`, with its
 * name and version as JSON. Under a release age gate npm picks the highest version old enough in that range, never one
 * below `current`; none old enough is `ETARGET` or `ENOVERSIONS`, as at an install.
 */
export function npmUpdatePackArgs(current: string, latest: string, dir: string): readonly string[] {
  return ['pack', `${RAROG_PACKAGE_NAME}@>${current} <=${latest}`, '--ignore-scripts', '--json', '--pack-destination',
    dir];
}

/**
 * Arguments of `npm-cli.js` with which `rarog update --beta` downloads exactly `version`, the target it chose from the
 * dist-tags, into `dir`, with its name and version as JSON. npm's release age gate holds an exact version back as it
 * holds a range: not old enough is `ETARGET`.
 */
export function npmUpdateExactPackArgs(version: string, dir: string): readonly string[] {
  return ['pack', `${RAROG_PACKAGE_NAME}@${version}`, '--ignore-scripts', '--json', '--pack-destination', dir];
}

/**
 * Arguments of `npm-cli.js` with which `rarog update` installs exactly the tarball `file` it checked: global,
 * without install scripts (the package needs none, and a release must not run code at install).
 */
export function npmUpdateInstallArgs(file: string): readonly string[] {
  return ['i', '-g', '--ignore-scripts', file];
}

/** Instalacja paczki npm Raroga na stałe (menedżerem paczek, nie z cache `npx` ani `pnpm dlx`). */
export const PACKAGE_INSTALL = {
  npm: PACKAGE_COMMANDS.npm.install,
  pnpm: PACKAGE_COMMANDS.pnpm.install,
} as const;

/** Komendy naprawcze instalacji. */
export interface RepairCommands {
  /** Wejście `rarog`; komenda `rarog <argumenty>` to {@link rarogCli}. */
  readonly cli: string;
  /** Kopia kodu hooka i skryptu `statusLine` w `~/.claude/hooks/rarog/`. */
  readonly hooksInstall: string;
  /** Blok hooka do wklejenia w ustawieniach Claude Code. */
  readonly hooksPrint: string;
  /** Blok hooka dla pliku ustawień projektu. */
  readonly hooksPrintLocal: string;
  /** Stan rejestracji hooka i kopii. */
  readonly hooksDoctor: string;
  /** Restart serwera (`rarog restart`). */
  readonly restart: string;
  /**
   * What makes the service run this installation after its files changed (an update, a server on another version):
   * npm keeps the package path, so a restart; pnpm keeps each version in its own store directory, so the service is
   * installed again from this installation (its restart refuses a service that points elsewhere), and so is a package
   * of a manager the registry does not know; a clone restarts.
   */
  readonly afterUpdate: string;
  /** Zależności instalacji, także moduł natywny iroh: w paczce ponowna instalacja paczki menedżerem. */
  readonly dependencies: string;
}

/** Komendy naprawcze trybu `mode` dla instalacji w `root` (menedżer paczki z {@link packageManagerOf}). */
export function repairCommands(mode: InstallMode, root: string): RepairCommands {
  if (mode === 'package') {
    const manager = packageManagerOf(root);
    return {
      cli: 'rarog',
      hooksInstall: 'rarog hooks install',
      hooksPrint: 'rarog hooks print',
      hooksPrintLocal: 'rarog hooks print --local',
      hooksDoctor: 'rarog hooks doctor',
      restart: 'rarog restart',
      afterUpdate: manager === 'npm' ? 'rarog restart' : 'rarog service install',
      dependencies: packageCommands(manager, root).update,
    };
  }
  return {
    cli: 'node bin/rarog.mjs',
    hooksInstall: 'pnpm run hooks:install',
    hooksPrint: 'pnpm run hooks:print',
    hooksPrintLocal: 'pnpm run hooks:print -- --local',
    hooksDoctor: 'pnpm run hooks:doctor',
    restart: 'pnpm run restart',
    afterUpdate: 'pnpm run restart',
    dependencies: 'pnpm install',
  };
}

/** Komendy naprawcze tej instalacji. */
export const REPAIR: RepairCommands = repairCommands(INSTALL_MODE, INSTALL_ROOT);

/** Komenda `rarog <argumenty>` do wklejenia: w klonie z katalogu repo, w paczce `rarog` z `PATH`. */
export function rarogCli(args: string, mode: InstallMode = INSTALL_MODE): string {
  return `${repairCommands(mode, INSTALL_ROOT).cli} ${args}`;
}

/**
 * Komenda `rarog <argumenty>` INNEJ instalacji, wskazanej węzłem i wejściem `…/bin/rarog.mjs` z argv usługi. Nie
 * zależy od `PATH` ani od katalogu wywołania, więc trafia w tamtą instalację także wtedy, gdy `rarog` w `PATH` to
 * dowiązanie klonu.
 */
export function installationCli(target: { readonly node: string; readonly bin: string }, args = ''): string {
  const command = `${shellQuote(target.node)} ${shellQuote(target.bin)}`;
  return args === '' ? command : `${command} ${args}`;
}

/**
 * A sentence with every `rarog <command>` in the absolute form of {@link installationCli} (`rarog setup` →
 * `'/…/node' '/…/rarog.mjs' setup`): the `Fix:` lines of an installation whose `rarog` a new terminal may not find.
 */
export function withInstallationCli(text: string, target: { readonly node: string; readonly bin: string }): string {
  return text.replace(/(^|[\s(;,])rarog (?=[a-z])/gu, (_match, before: string) => `${before}${installationCli(target)} `);
}

/**
 * Directories of Node version managers under the home directory (nvm in `~/.config/nvm` or `~/.nvm`) and path
 * segments of the others (fnm, volta): the node, and the npm prefix with the `rarog` command, of such a directory
 * belong to one Node version, and a new terminal may start with another one.
 */
const VERSION_MANAGER_HOME_DIRS = [['.config', 'nvm'], ['.nvm']] as const;
const VERSION_MANAGER_SEGMENTS: ReadonlySet<string> = new Set(['fnm', '.fnm', 'fnm_multishells', 'volta', '.volta']);

/** `dir` lies under a Node version manager (nvm, fnm, volta). */
export function underVersionManager(dir: string, home: string): boolean {
  const resolved = path.resolve(dir);
  for (const parts of VERSION_MANAGER_HOME_DIRS) {
    const root = path.join(home, ...parts);
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) return true;
  }
  return resolved.split(path.sep).some((part) => VERSION_MANAGER_SEGMENTS.has(part));
}

/** Zdanie naprawy kopii hooka różnej od źródła dla trybu `mode` (`scripts/restart.sh`, `hook: stale`). */
export function restartHookRepair(commands: RepairCommands): string {
  return `review the changes (${commands.hooksDoctor}), then ${commands.hooksInstall}`;
}

/**
 * Zdanie naprawy kopii hooka różnej od źródła, które `scripts/restart.sh` wypisuje po `hook: stale`
 * (parametr `RAROG_RESTART_HOOK_REPAIR`, ustawia go `rarog restart`).
 */
export const RESTART_HOOK_REPAIR = restartHookRepair(REPAIR);
