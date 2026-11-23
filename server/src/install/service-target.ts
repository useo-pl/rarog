/**
 * Cel usługi serwera: co startuje usługa launchd `ai.rarog.server` albo jednostka `systemd --user` `rarog.service`
 * i jak to odczytać z powrotem. Jedna definicja kształtu argv dla `rarog service install` (plist, jednostka,
 * `serve --check` przez wrapper), `rarog restart` (sprawdzenie przez wrapper, węzeł i wejście z plistu i z jednostki)
 * i `rarog doctor`.
 *
 * Kształt: `[...service.wrapper, <węzeł>, <korzeń>/bin/rarog.mjs, ...argumenty]`. Węzeł to węzeł procesu, który
 * instaluje albo sprawdza usługę (`process.execPath`, z Homebrew przez `opt/<formuła>`, {@link homebrewOptNode}),
 * a wejście `bin/rarog.mjs` leży w korzeniu TEJ instalacji (`mode.ts`). Zawsze plik wejścia, nigdy polecenie
 * `rarog` menedżera paczek: pnpm robi z niego skrypt sh, który bierze `node` z `PATH`, a launchd daje usłudze
 * systemowy `PATH` bez węzła.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE } from './evidence.ts';
import { INSTALL_ROOT } from './mode.ts';
import type { InstallMode } from './mode.ts';

/** Wejście `rarog`, które startuje usługa i na które wskazuje dowiązanie `~/.local/bin/rarog`. */
export const RAROG_BIN = path.join(INSTALL_ROOT, 'bin', 'rarog.mjs');

/** Węzeł i wejście, które startuje usługa. */
export interface ServiceTarget {
  readonly node: string;
  readonly bin: string;
}

type Realpath = (file: string) => string;

/** Węzeł w `Cellar` Homebrew: prefiks, formuła, wersja (każdy prefiks: `/opt/homebrew`, `/usr/local`, Linuxbrew). */
const CELLAR_NODE = new RegExp(`^(.+)/${EVIDENCE.homebrew.cellar}/([^/]+)/[^/]+/bin/node$`, 'u');

/**
 * Węzeł usługi dla węzła `execPath`: `<prefiks>/Cellar/<formuła>/<wersja>/bin/node` przechodzi na
 * `<prefiks>/opt/<formuła>/bin/node`, gdy oba mają ten sam `realpath`: `brew cleanup` usuwa starą wersję z `Cellar`,
 * więc ścieżka z `Cellar` w plistcie zabiłaby usługę po pierwszej aktualizacji (fakty w {@link EVIDENCE}). Inny
 * węzeł (nvm, nodejs.org, systemowy) zostaje bez zmian.
 */
export function homebrewOptNode(execPath: string, realpath: Realpath = realpathSync): string {
  const match = CELLAR_NODE.exec(execPath);
  if (match === null) return execPath;
  const opt = path.join(match[1] ?? '', EVIDENCE.homebrew.opt, match[2] ?? '', 'bin', 'node');
  try {
    return realpath(opt) === realpath(execPath) ? opt : execPath;
  } catch {
    return execPath;
  }
}

/** Cel usługi instalacji w `root` uruchomionej węzłem `execPath`: węzeł z {@link homebrewOptNode} i wejście. */
export function serviceTarget(
  execPath: string = process.execPath, root: string = INSTALL_ROOT, realpath: Realpath = realpathSync,
): ServiceTarget {
  return { node: homebrewOptNode(execPath, realpath), bin: path.join(root, 'bin', 'rarog.mjs') };
}

/** Argv usługi albo sprawdzenia: wrapper, węzeł i wejście celu (domyślnie tej instalacji) i argumenty. */
export function serviceArgv(
  wrapper: readonly string[], args: readonly string[], target: ServiceTarget = serviceTarget(),
): string[] {
  return [...wrapper, target.node, target.bin, ...args];
}

/**
 * Węzeł w argv usługi (`ProgramArguments` plistu, `ExecStart` jednostki): element tuż przed `…/bin/rarog.mjs`,
 * z dowolnej instalacji. `undefined`, gdy argv nie ma `…/bin/rarog.mjs` albo nic przed nim nie stoi.
 */
export function serviceArgvNode(argv: readonly string[]): string | undefined {
  const at = argv.findIndex((arg) => arg.endsWith(BIN_SUFFIX));
  return at > 0 ? argv[at - 1] : undefined;
}

const BIN_SUFFIX = '/bin/rarog.mjs';

/** Wejście `…/bin/rarog.mjs` w argv usługi, z dowolnej instalacji; `undefined`, gdy go nie ma. */
export function serviceArgvBin(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.endsWith(BIN_SUFFIX));
}

/** `service.wrapper` w argv usługi: elementy przed węzłem; pusta lista bez wrappera albo bez `…/bin/rarog.mjs`. */
export function serviceArgvWrapper(argv: readonly string[]): string[] {
  const at = argv.findIndex((arg) => arg.endsWith(BIN_SUFFIX));
  return at > 1 ? argv.slice(0, at - 1) : [];
}

/** Zgodność celu zapisanego w usłudze z instalacją, która go sprawdza. */
export interface ServiceInstallation {
  /** Wejście z argv usługi; `undefined` = argv bez `…/bin/rarog.mjs`. */
  readonly bin: string | undefined;
  /** Węzeł z argv usługi; `undefined` = nic nie stoi przed wejściem. */
  readonly node: string | undefined;
  /** Wejście usługi to inny plik niż wejście tej instalacji, także gdy go już nie ma. */
  readonly otherBin: boolean;
  /** Węzeł usługi to inny plik niż węzeł tej komendy, także gdy go już nie ma. */
  readonly otherNode: boolean;
}

/** Ten sam plik: równe napisy albo równy `realpath`; brak pliku to inny plik. */
function sameFile(a: string, b: string, realpath: Realpath): boolean {
  if (a === b) return true;
  try {
    return realpath(a) === realpath(b);
  } catch {
    return false;
  }
}

/**
 * Cel usługi (argv z plistu albo `ExecStart`) wobec tej instalacji: wejście wobec {@link RAROG_BIN}, węzeł wobec węzła
 * tej komendy, oba po `realpath` (węzeł Homebrew przez `opt/<formuła>` równa się węzłowi z `Cellar`). Ścieżka, której
 * już nie ma (przerwana aktualizacja, `nvm uninstall`, `pnpm store prune`), to inna instalacja.
 */
export function serviceInstallation(
  argv: readonly string[], current: ServiceTarget = { node: process.execPath, bin: RAROG_BIN },
  realpath: Realpath = realpathSync,
): ServiceInstallation {
  const bin = serviceArgvBin(argv);
  const node = serviceArgvNode(argv);
  return {
    bin,
    node,
    otherBin: bin === undefined || !sameFile(bin, current.bin, realpath),
    otherNode: node === undefined || !sameFile(node, current.node, realpath),
  };
}

/**
 * Instalacja z cache menedżera paczek, z której usługa nie może startować: katalog w cache `npx`
 * (`<cache npm>/_npx/…`, znika przy `npm cache clean`) albo proces uruchomiony przez pnpm (`pnpm dlx`: ścieżka w
 * sklepie pnpm wygląda jak po `pnpm add -g`, więc rozpoznaje go `npm_config_user_agent`; fakty w {@link EVIDENCE}).
 * `null` = instalacja stała albo klon repo; napis = skąd uruchomiono. Dotyczy tylko trybu paczki.
 */
export function transientInstall(
  mode: InstallMode, root: string, env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (mode !== 'package') return null;
  if (root.split(path.sep).includes(EVIDENCE.npx.segment)) return `npx cache (${root})`;
  if ((env['npm_config_user_agent'] ?? '').startsWith(EVIDENCE.pnpmDlx.userAgentPrefix)) {
    return 'pnpm dlx or pnpm exec (npm_config_user_agent from pnpm)';
  }
  return null;
}
