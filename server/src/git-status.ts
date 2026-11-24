/**
 * Lokalny `git status` per sesja — źródło eventu `git-status` (branch, liczba brudnych plików,
 * ich rodzaje i szczegóły per plik z licznikami linii).
 *
 * Reguły z architektury:
 * - wyłącznie lokalne `git status --porcelain=v2 --branch --untracked-files=all` (+ `git log -1`
 *   i ograniczone do listy plików `git diff --numstat`), NIGDY `git fetch` (zero ruchu sieciowego
 *   i zero kosztu w tle),
 * - odpalane po domkniętym tool-callu modyfikującym pliki + throttle (żeby seria edycji nie
 *   uruchomiła gita dziesięć razy pod rząd),
 * - w trybie demo NIEUŻYWANE — mock-driver emituje `git-status` sam, bez dotykania dysku.
 *
 * Throttle jest „leading edge": pierwsze pytanie w oknie odpala gita, kolejne dostają `null`
 * (wołający nic nie rozgłasza). Świeży odczyt przyjdzie z następnym tool-callem — nie budujemy
 * timera z trailing edge, bo event `git-status` jest kosmetyczny, a nie transakcyjny.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { MAX_DIFF_PATCH_BYTES } from '@rarog/shared';
import type {
  DiffFile, DiffFileStatus, GitCommit, GitFileDetail, GitFileKinds, SessionDiff,
} from '@rarog/shared';
import {
  CONFIG_NAMES_ENCODING, CONFIG_NAMES_READ_CAP_BYTES, filterDriverNames, withFilterDriversOff,
} from './git-config-guard.ts';
import { SANDBOX_EXEC, gitSandboxLogLine, probeGitSandbox } from './git-sandbox.ts';
import type { GitSandbox, GitSandboxState } from './git-sandbox.ts';
import { gitWorkTree } from './git-work-tree.ts';

export interface GitStatus {
  branch: string;
  dirtyCount: number;
  files: string[];
  /**
   * Brudne pliki po rodzajach. ZAWSZE obecne — pochodzą z tego samego wyjścia co `dirtyCount`,
   * więc nie ma stanu „znam liczbę plików, nie znam rodzajów".
   */
  fileKinds: GitFileKinds;
  /** Commity przed upstreamem. Nieobecne, gdy gałąź nie ma upstreamu (`# branch.ab` nie przyszło). */
  ahead?: number;
  /** Commity za upstreamem. Jak wyżej — brak upstreamu = brak pola, a nie zero. */
  behind?: number;
  /** Ostatni commit z `git log -1`. Brak = repo bez commitów albo nieudany odczyt. */
  lastCommit?: GitCommit;
  /**
   * Brudne pliki z rodzajem — ta sama kolejność, ten sam sufit i ta sama postać ścieżki co
   * `files`, bo powstają w tej samej pętli parsera. Liczniki linii dokłada `GitStatusWatcher`
   * z `git diff --numstat` (budżet {@link GIT_NUMSTAT_BUDGET_MS}); bez nich wpis niesie sam rodzaj.
   */
  fileDetails: GitFileDetail[];
}

/**
 * Status gita tak, jak go przyjmuje manager: z parsera `fileKinds` i `fileDetails` są ZAWSZE,
 * ale tą samą ścieżką wchodzi ramka `git-status` od drivera (mock, herdr) — a driver rodzajów
 * ani szczegółów znać nie musi.
 */
export type GitStatusLike = Omit<GitStatus, 'fileKinds' | 'fileDetails'> & {
  fileKinds?: GitFileKinds;
  fileDetails?: GitFileDetail[];
};

/** Uruchamiacz gita — wstrzykiwany w testach (bez dotykania prawdziwego repo). */
export type GitRunner = (cwd: string) => Promise<{ ok: boolean; stdout: string }>;

export const DEFAULT_THROTTLE_MS = 3_000;
export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_TIMEOUT_MS = 5_000;

/** Etykieta gałęzi dla HEAD w stanie detached (porcelain v2 zwraca dosłownie `(detached)`). */
export const DETACHED_BRANCH = '(detached)';

/**
 * `# branch.ab +2 -1` → 2 commity przed upstreamem, 1 za nim.
 *
 * Git wypisuje ten nagłówek TYLKO gdy gałąź ma upstream, więc jego brak jest informacją
 * („nie ma z czym porównywać"), a nie zerem.
 */
const BRANCH_AB = /^# branch\.ab \+(\d+) -(\d+)$/;

/**
 * Rodzaj brudnego wpisu z pola `XY` porcelain v2.
 *
 * Bierzemy OBIE litery (indeks i drzewo robocze), bo interesuje nas, co się z plikiem stało,
 * a nie w którym obszarze: `AM` (dodany, potem jeszcze zmieniony) to dla nagłówka nowy plik,
 * `.D` (skasowany w drzewie) — usunięty. Usunięcie wygrywa z dodaniem, bo `AD` (dodany do
 * indeksu i skasowany z dysku) kończy się BRAKIEM pliku — a nagłówek ma mówić o stanie,
 * nie o drodze. Wszystko inne (modyfikacja, rename, typechange) to `modified`.
 */
function classifyKind(xy: string): keyof GitFileKinds {
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

/**
 * Pole `XY` wiersza porcelain v2 — drugie pole, zawsze dwie litery.
 *
 * Czytamy je po spacjach, a nie przez `slice(2, 4)`, bo ta druga forma milczy, gdy wiersz jest
 * krótszy, niż się wydaje (ucięte wyjście gita).
 */
function statusField(line: string): string {
  const start = line.indexOf(' ');
  if (start === -1) return '';
  const end = line.indexOf(' ', start + 1);
  return end === -1 ? line.slice(start + 1) : line.slice(start + 1, end);
}

/**
 * Parsuje wyjście `git status --porcelain=v2 --branch`.
 *
 * Liczymy wpisy: `1` (zmiana zwykła), `2` (rename/copy), `u` (konflikt), `?` (nieśledzony).
 * Wpisy `!` (ignorowane) NIE liczą się jako brudne — inaczej każdy `node_modules` zawyżałby licznik.
 *
 * Ten sam przebieg rozbija brudne pliki na trójkę `fileKinds` (dodane / zmienione / usunięte):
 * nieśledzony (`?`) to dodany, konflikt (`u`) to zmieniony, a dla `1`/`2` decyduje pole `XY`
 * (patrz {@link classifyKind}). Suma trójki jest równa `dirtyCount` z definicji. Ta sama
 * klasyfikacja daje `kind` każdego wpisu `fileDetails` — liczniki linii dokłada dopiero watcher.
 *
 * @param maxFiles ile nazw plików zwracamy do UI (reszta jest pomijana — karta i tak nie pokaże)
 */
export function parseGitStatusV2(stdout: string, maxFiles = DEFAULT_MAX_FILES): GitStatus {
  return parsePorcelain(stdout, maxFiles).status;
}

/**
 * Status i ścieżki, o które warto zapytać `git diff --numstat` — jeden przebieg parsera.
 *
 * `pathspecs` to wpisy ŚLEDZONE z listy (≤ `maxFiles`): `1`, `u` i `2` razem ze ścieżką ŹRÓDŁOWĄ
 * rename'u (bez niej git liczy nowy plik jako dodany w całości — zmierzone na git 2.54:
 * `diff --numstat HEAD -- new.ts` daje `9 0`, z `old.ts` w pathspecu `2 1`). Bez liczników
 * zostają: nieśledzone (`?` — `git diff HEAD` ich nie pokazuje) i wpisy, których którejkolwiek
 * ścieżki nie da się dopasować ({@link unmatchable}). Rename liczy się w CAŁOŚCI albo wcale:
 * cel bez źródła to znów „cały plik dodany", czyli liczby, które kłamią.
 */
export function parsePorcelain(
  stdout: string, maxFiles = DEFAULT_MAX_FILES,
): { status: GitStatus; pathspecs: string[] } {
  let branch = DETACHED_BRANCH;
  let dirtyCount = 0;
  const files: string[] = [];
  const fileDetails: GitFileDetail[] = [];
  const pathspecs: string[] = [];
  const fileKinds: GitFileKinds = { added: 0, modified: 0, deleted: 0 };
  let ahead: number | undefined;
  let behind: number | undefined;

  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const match = BRANCH_AB.exec(line.trimEnd());
      if (match !== null) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    const kind = line[0];
    if (kind !== '1' && kind !== '2' && kind !== 'u' && kind !== '?') continue;

    dirtyCount += 1;
    const detailKind: keyof GitFileKinds = kind === '?'
      ? 'added'
      : (kind === 'u' ? 'modified' : classifyKind(statusField(line)));
    fileKinds[detailKind] += 1;
    const path = extractPath(kind, line);
    if (path === null || files.length >= maxFiles) continue;
    files.push(path);
    fileDetails.push({ path, kind: detailKind });
    if (kind === '?') continue;
    const origin = kind === '2' ? renameOrigin(line) : null;
    const entry = origin === null ? [path] : [path, origin];
    if (entry.some(unmatchable)) continue;
    pathspecs.push(...entry);
  }

  const status: GitStatus = { branch, dirtyCount, files, fileKinds, fileDetails };
  // Pola dokładamy tylko, gdy upstream istnieje — `undefined` w JSON-ie eventu to szum.
  if (ahead !== undefined) status.ahead = ahead;
  if (behind !== undefined) status.behind = behind;
  return { status, pathspecs };
}

/**
 * Ścieżki statusu, której `numstat` nie odda w tej samej postaci:
 * - CYTOWANA (`"za\305\274…"`, `core.quotePath`) — `-z` oddaje surowe bajty;
 * - spoza katalogu sesji (`../top.txt`, sesja w podkatalogu repo) — `numstat --relative` takich
 *   plików nie pokazuje wcale, a rename przez tę granicę liczyłby cel jako dodany w całości.
 */
function unmatchable(path: string): boolean {
  return path.startsWith('"') || path.startsWith('../');
}

/** Ścieżka ŹRÓDŁOWA rename'u (`2 … <path>\t<orig>`) albo `null`, gdy wiersz jej nie niesie. */
function renameOrigin(line: string): string | null {
  const tab = line.indexOf('\t');
  if (tab === -1) return null;
  const origin = line.slice(tab + 1).trim();
  return origin === '' ? null : origin;
}

/**
 * Wyciąga ścieżkę z wiersza porcelain v2.
 *
 * Układ pól (bez `-z`, więc separatorem jest spacja, a rename oddziela TAB):
 * - `? <path>`
 * - `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`                      → ścieżka to pole 9.
 * - `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X score> <path>\t<orig>`    → ścieżka to pole 10.
 * - `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`            → ścieżka to pole 11.
 */
function extractPath(kind: '1' | '2' | 'u' | '?', line: string): string | null {
  if (kind === '?') return line.slice(2).trim() || null;
  const fieldsBeforePath = kind === '1' ? 8 : kind === '2' ? 9 : 10;
  let index = 0;
  for (let field = 0; field < fieldsBeforePath; field += 1) {
    const space = line.indexOf(' ', index);
    if (space === -1) return null;
    index = space + 1;
  }
  const rest = line.slice(index);
  // Przy rename ścieżka nowa i stara są rozdzielone tabulatorem — bierzemy nową.
  const tab = rest.indexOf('\t');
  const path = (tab === -1 ? rest : rest.slice(0, tab)).trim();
  return path === '' ? null : path;
}


/**
 * Górna granica tego, ile bajtów w ogóle CZYTAMY z gita.
 *
 * Patch idzie do klienta ucięty do 512 kB, ale sam `git diff HEAD` w brudnym repo potrafi
 * mieć dziesiątki MB — po przekroczeniu tego progu zabijamy proces i pracujemy na tym, co
 * już mamy (i tak wystarcza z ogromnym zapasem na 512 kB).
 */
export const DIFF_READ_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Wynik jednego wywołania gita.
 *
 * `timedOut` jest TRZECIM stanem obok `ok`, a nie ozdobnikiem: bez niego przekroczony limit
 * czasu wyglądał dokładnie jak niezerowy kod wyjścia, więc wołający mówił „git odmówił" tam,
 * gdzie prawdą było „git nie zdążył" — i dopytywał o powód dwoma KOLEJNYMI procesami na
 * katalogu, który właśnie okazał się wolny. Pole jest OPCJONALNE, żeby atrapy runnera w testach
 * (a jest ich kilkadziesiąt) nie musiały go znać.
 */
export interface GitArgsResult {
  ok: boolean;
  stdout: string;
  timedOut?: boolean;
  /**
   * Kod errno, gdy procesu gita w ogóle NIE UDAŁO SIĘ uruchomić (`EAGAIN`, `EMFILE`, `ENOENT`…).
   *
   * Czwarty stan obok `ok`/`timedOut`, z tego samego powodu co tamten: bez niego „system nie dał
   * procesu" wyglądało jak „git odpowiedział błędem". Opcjonalne, żeby atrapy runnera w testach
   * nie musiały go znać.
   */
  spawnFailed?: string;
  /**
   * Kod wyjścia procesu, który SAM się zakończył. Bez niego `ok: false` znaczyło naraz „git
   * odpowiedział kodem ≠ 0" i „proces zabił sygnał", a `git diff --no-index` kończy się kodem 1
   * przy każdej różnicy. Brak pola = proces nie skończył się sam (limit czasu, sufit odczytu,
   * sygnał, nieudany start) albo atrapa runnera, która kodu nie zna.
   */
  exitCode?: number;
  /**
   * `true`, gdy odczyt doszedł do sufitu bajtów i proces został zabity: `stdout` to PREFIKS
   * wyjścia, a `ok: true` mówi tylko „jest co czytać". Opcjonalne jak pola wyżej.
   */
  capped?: boolean;
}

/**
 * Opcja globalna gita (przed podkomendą), którą wolno podać wołającemu. Lista ZAMKNIĘTA: `-c klucz=wartość`
 * w tym miejscu stałoby po {@link GIT_CONFIG_GUARDS} i nadpisałoby je.
 */
export type GitGlobalOption = '--literal-pathspecs';

/** Opcje globalne dozwolone w {@link GitCommand.global} — ta sama lista co typ, do kontroli w biegu. */
const GIT_GLOBAL_OPTIONS: readonly string[] = ['--literal-pathspecs'] satisfies readonly GitGlobalOption[];

/**
 * Podkomendy, które serwer uruchamia. Lista ZAMKNIĘTA: napis w tym miejscu
 * git czyta jeszcze jako opcję globalną, więc „podkomenda” `-c` z `rest` = `['core.fsmonitor=…', …]` stałaby
 * po osłonach i je nadpisała. Wbudowanych podkomend nie zasłoni też alias z konfiguracji repo.
 */
export const GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'ls-files', 'rev-parse', 'check-ignore'] as const;
export type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number];

/**
 * Jedno wywołanie gita: opcje globalne, podkomenda i jej argumenty. Runner NIE przyjmuje surowej tablicy —
 * argv składa sam ({@link gitArgv}), więc nowy wołający nie ma jak ominąć osłon. `rest` stoi PO
 * podkomendzie, gdzie `-c` jest już opcją podkomendy (np. `diff -c`), nie konfiguracją.
 */
export interface GitCommand {
  readonly global?: readonly GitGlobalOption[];
  readonly sub: GitSubcommand;
  readonly rest: readonly string[];
}

/** Runner gita z dowolnym poleceniem (diff potrzebuje kilku różnych wywołań). */
export type GitArgsRunner = (command: GitCommand, cwd: string) => Promise<GitArgsResult>;

/**
 * A caller's command bound by the runner to the work tree of its read: the session directory or its nearest
 * ancestor with `.git` ({@link gitWorkTree}). {@link gitArgv} names that directory and its `.git` right after the
 * guards ({@link repositoryPin}). Callers cannot pass either option themselves: `global` takes only
 * {@link GitGlobalOption}.
 */
export interface BoundGitCommand extends GitCommand {
  readonly workTree: string;
}

/**
 * The two options that pin a git process to the repository of a read:
 *
 * - `--work-tree=<T>`: git puts it over `core.worktree` from repository config, which the agent writes, so that key
 *   cannot move a read outside `T`;
 * - `--git-dir=<T>/.git`: git does not look for a repository itself. A `.git` entry it would not take for one (an
 *   empty directory, a dangling symlink) then ends the read, where discovery would skip the entry, take the
 *   repository above and lay its index over `T`, handing out committed files from outside the session directory.
 */
function repositoryPin(workTree: string): readonly string[] {
  return [`--git-dir=${join(workTree, '.git')}`, `--work-tree=${workTree}`];
}

/**
 * A command the runner issues for itself, with a fixed argv, outside the subcommand list of callers: the git
 * version, read before the first `diff` and by the sandbox probe, git's exec path, read by the sandbox probe
 * ({@link gitSandbox}), and the config key names, read before every git process ({@link filterDriversOff}).
 * {@link GitArgsRunner} does not take it, so no caller passes one.
 */
export interface GitRunnerProbe {
  readonly probe: 'version' | 'exec-path' | 'config-names';
}

/** The config names read of one read, pinned to the same repository as the read itself ({@link repositoryPin}). */
interface BoundNamesProbe {
  readonly probe: 'config-names';
  readonly workTree: string;
}

/** Fixed argv of each runner probe, after the config guards. */
const PROBE_ARGV: Readonly<Record<GitRunnerProbe['probe'], readonly string[]>> = {
  version: ['version'],
  'exec-path': ['--exec-path'],
  'config-names': ['config', '--null', '--name-only', '--list'],
};

/**
 * Guards of EVERY git process Rarog starts: repository config, which the agent writes from its sandbox, runs
 * no program on a read. Rarog's git runs outside that sandbox.
 *
 * - `core.fsmonitor=false`: the hook from `core.fsmonitor` ran on `status`, `diff` and `ls-files`;
 * - `log.showSignature=false`: with `true` in repo config `git log` verified the commit signature with the program
 *   from `gpg.program` (measured on git 2.54: `core.fsmonitor=false` alone does not stop it);
 * - `safe.bareRepository=explicit`: a directory with `HEAD`, `objects` and `refs` inside the project (say, with
 *   `core.worktree` and a filter in its `config`) is not taken as a repository. Git honours this key only from
 *   protected config, and the command line counts as protected;
 * - `core.hooksPath=/dev/null`: no hook runs, neither from `.git/hooks` nor from a `core.hooksPath` of the repo;
 * - `diff.submodule=short`: the `log` and `diff` formats read a submodule's history or diff it under its own config.
 *
 * Flags per subcommand: {@link subcommandGuards}; environment: {@link GIT_ENV_GUARDS}. `-c` options reach git's child
 * processes (submodules) through `GIT_CONFIG_PARAMETERS`. Filter drivers (`clean`, `process`), which git runs when it
 * hashes a changed working-tree file on `status` and `diff`, are emptied per process: {@link filterDriversOff}.
 */
export const GIT_CONFIG_GUARDS: readonly string[] = [
  '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'safe.bareRepository=explicit',
  '-c', 'core.hooksPath=/dev/null', '-c', 'diff.submodule=short',
];

/** Flaga każdego `git diff` Raroga: patch bez programu z `diff.<drv>.textconv`. */
export const NO_TEXTCONV = '--no-textconv';

/**
 * `status` and `diff` do not look inside a submodule's working tree: the dirty check runs `git status` in the
 * submodule, under the submodule's own config and filters. A submodule whose only change is in its working
 * tree therefore does not show; a new commit checked out in it still does.
 */
const IGNORE_DIRTY_SUBMODULES = '--ignore-submodules=dirty';

/**
 * Flags right after the subcommand, before the caller's arguments: `diff` gets `--no-textconv`
 * (`diff.<drv>.textconv` ran a program on a patch), `--no-ext-diff` (`diff.external` replaced the patch with
 * a program's output) and {@link IGNORE_DIRTY_SUBMODULES}; `log` gets `--no-ext-diff`; `status` gets
 * {@link IGNORE_DIRTY_SUBMODULES}. A function, not a table: `NO_EXT_DIFF` is declared further down.
 */
function subcommandGuards(sub: GitSubcommand): readonly string[] {
  switch (sub) {
    case 'diff': return [NO_TEXTCONV, NO_EXT_DIFF, IGNORE_DIRTY_SUBMODULES];
    case 'log': return [NO_EXT_DIFF];
    case 'status': return [IGNORE_DIRTY_SUBMODULES];
    default: return [];
  }
}

/**
 * Full argv of a git process: the guards, the repository pin of a command the runner bound ({@link BoundGitCommand},
 * {@link repositoryPin}), the global options, the subcommand, its guards ({@link subcommandGuards}) and the rest.
 * A runner probe ({@link GitRunnerProbe}) gets the guards and its fixed argv; the config names read of a read carries
 * the pin of that read, the version and exec path probes read no repository and carry none.
 */
export function gitArgv(command: GitCommand | BoundGitCommand | GitRunnerProbe | BoundNamesProbe): string[] {
  if ('probe' in command) {
    if (!Object.hasOwn(PROBE_ARGV, command.probe)) {
      throw new TypeError(`git: probe outside the list: ${JSON.stringify(command.probe)}`);
    }
    const pin = 'workTree' in command && command.probe === 'config-names' ? repositoryPin(command.workTree) : [];
    return [...GIT_CONFIG_GUARDS, ...pin, ...PROBE_ARGV[command.probe]];
  }
  /*
   * Kontrola w biegu obok typów: atrapa, rzutowanie albo dane spoza TypeScriptu nie przejdą. Rzuca — runner łapie
   * to jak nieudany start procesu (`spawnFailed`), więc git z takim argv nie startuje.
   */
  if (!(GIT_SUBCOMMANDS as readonly string[]).includes(command.sub)) {
    throw new TypeError(`git: podkomenda spoza listy: ${JSON.stringify(command.sub)}`);
  }
  for (const option of command.global ?? []) {
    if (!GIT_GLOBAL_OPTIONS.includes(option)) {
      throw new TypeError(`git: opcja globalna spoza listy: ${JSON.stringify(option)}`);
    }
  }
  const pin = 'workTree' in command ? repositoryPin(command.workTree) : [];
  return [
    ...GIT_CONFIG_GUARDS, ...pin, ...(command.global ?? []), command.sub, ...subcommandGuards(command.sub),
    ...command.rest,
  ];
}

/**
 * Environment guards of every git process. The runner sets them last, over the server's `GIT_*` passthrough:
 *
 * - `GIT_NO_LAZY_FETCH=1`: a repository with a missing object and a promisor remote does not fetch the object when
 *   `diff` needs it. The fetch runs a program from repo config (`remote.<name>.uploadpack`, the transport of an
 *   `ext::` URL). Git honours the variable from {@link MIN_GIT_VERSION};
 * - `GIT_ALLOW_PROTOCOL=` (empty): no transport is allowed, so an `ext::` URL runs nothing even with
 *   `protocol.ext.allow=always` in repo config. `-c protocol.allow=never` would not do: repo config overrides it per
 *   protocol.
 */
const GIT_ENV_GUARDS: Readonly<Record<string, string>> = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };

/**
 * Variables of the server's `GIT_*` passthrough that no git process of the runner gets. The first two would
 * leave a filter driver on, the third would choose the program:
 *
 * - `GIT_CONFIG` moves only `git config` to another file, so the config names read would list a config that
 *   `status` and `diff` do not use, and a driver of the repository would stay unlisted;
 * - `GIT_CONFIG_PARAMETERS` (the `-c` pairs of a parent git) wins over the `GIT_CONFIG_COUNT` pairs the runner
 *   empties the drivers with;
 * - `GIT_EXEC_PATH` names the directory git takes its own programs from. The sandbox starts the `git` of that directory
 *   ({@link gitSandbox}), so a directory an agent can write would hand it the program of every read.
 */
const GIT_ENV_DROPPED: ReadonlySet<string> = new Set(['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_EXEC_PATH']);

/** `env` as every git process of the runner gets it: without {@link GIT_ENV_DROPPED}, with {@link GIT_ENV_GUARDS}. */
function guardedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => !GIT_ENV_DROPPED.has(name));
  return { ...Object.fromEntries(kept), ...GIT_ENV_GUARDS };
}

/**
 * Oldest git the runner starts `diff` with: `GIT_NO_LAZY_FETCH` works from git 2.44. With an older git `diff` is
 * refused, because a lazy fetch was measured on `diff` only; `status`, `log`, `ls-files`, `rev-parse` and
 * `check-ignore` still run.
 */
const MIN_GIT_VERSION = { major: 2, minor: 44 } as const;

/** Read cap of `git version` and `git --exec-path` (one line each). */
const VERSION_READ_CAP_BYTES = 4 * 1024;

/** `git version 2.54.0 (Apple Git-157)` → 2 and 54. */
const GIT_VERSION_LINE = /^git version (\d+)\.(\d+)/;

/** `true` when `git version` output names a git at or above {@link MIN_GIT_VERSION}; anything else is `false`. */
function supportsNoLazyFetch(stdout: string): boolean {
  const match = GIT_VERSION_LINE.exec(stdout);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MIN_GIT_VERSION.major || (major === MIN_GIT_VERSION.major && minor >= MIN_GIT_VERSION.minor);
}

/**
 * Version checks per `PATH`, which decides the `git` binary the runner starts. An answer (old enough or not) is kept
 * for the life of the process; a failed read (timeout, failed start, exit code ≠ 0) is dropped, so the next `diff`
 * asks again. Concurrent diffs share one read.
 */
const versionChecks = new Map<string, Promise<GitArgsResult | null>>();

/**
 * `null` when `diff` may run, otherwise the result the refused `diff` returns. The refusal carries no `exitCode`:
 * git did not answer the diff, so callers report a failure, not "nothing to compare". A failed version read passes
 * on `timedOut` and `spawnFailed`.
 */
function diffRefusal(
  env: NodeJS.ProcessEnv, timeoutMs: number, sandbox: GitSandbox | null,
): Promise<GitArgsResult | null> {
  const key = env['PATH'] ?? '';
  const known = versionChecks.get(key);
  if (known !== undefined) return known;
  // `/` as cwd: `git version` reads no repository, and no repository config is near.
  const check = startGit(
    { probe: 'version' }, '/', env, timeoutMs, VERSION_READ_CAP_BYTES, 'utf8', sandbox,
  ).then((result) => {
    if (!result.ok) {
      versionChecks.delete(key);
      return refusalAfter(result);
    }
    return supportsNoLazyFetch(result.stdout) ? null : { ok: false, stdout: '' };
  });
  versionChecks.set(key, check);
  return check;
}

/**
 * The result of a read the runner refuses after its own probe failed: no `exitCode` (git did not answer the read, so
 * callers report a failure, not "nothing to compare"), but `timedOut` and `spawnFailed` of the probe pass on.
 */
function refusalAfter(probe: GitArgsResult): GitArgsResult {
  return {
    ok: false, stdout: '',
    ...(probe.timedOut === true ? { timedOut: true } : {}),
    ...(probe.spawnFailed === undefined ? {} : { spawnFailed: probe.spawnFailed }),
  };
}

/**
 * The environment of one git process with every filter driver of its config emptied, or the refused read.
 * The names are read in the same `cwd`, with the same guards, environment and repository pin (`workTree`) as the
 * process itself, so git lists the same config files (repository, worktree, includes, global, system, pairs from the
 * environment). The read is
 * refused, and git does not start, when the names read fails, times out or reaches its cap, when a driver name is not
 * UTF-8, or when the environment's own pair count is not plain digits ({@link withFilterDriversOff}). A driver added
 * between the names read and the start of git stays on for that process: turning the drivers off does not close this
 * race, the sandbox does ({@link gitSandbox}).
 */
async function filterDriversOff(
  cwd: string, workTree: string, env: NodeJS.ProcessEnv, timeoutMs: number, sandbox: GitSandbox | null,
): Promise<{ env: NodeJS.ProcessEnv } | { refused: GitArgsResult }> {
  const listing = await startGit(
    { probe: 'config-names', workTree }, cwd, env, timeoutMs, CONFIG_NAMES_READ_CAP_BYTES, CONFIG_NAMES_ENCODING,
    sandbox,
  );
  if (!listing.ok || listing.capped === true) return { refused: refusalAfter(listing) };
  const names = filterDriverNames(Buffer.from(listing.stdout, CONFIG_NAMES_ENCODING));
  const cleared = names === null ? null : withFilterDriversOff(env, names);
  return cleared === null ? { refused: { ok: false, stdout: '' } } : { env: cleared };
}

/**
 * Środowisko procesu gita CZYTAJĄCEGO repo (`status`, `diff`, `ls-files`).
 *
 * Baza jest PODAWANA (`gitEnvBase` z konfiguracji), nigdy ze środowiska serwera — granica
 * sekretów to `GIT_ENV_PASSTHROUGH` w `config-env.ts`. Dokładamy stałe: te odczyty są w 100%
 * lokalne, więc `GIT_SSH_COMMAND` byłoby tu szumem, ale `git diff` w repo z submodułami
 * potrafi dotknąć konfiguracji z promptem.
 */
export function gitReadEnv(base: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  /*
   * `GIT_OPTIONAL_LOCKS=0`: `git status` domyślnie ODŚWIEŻA indeks (zapisuje `.git/index`),
   * gdy stat plików się rozjechał. Na `.git` siedzi watcher (`git-watch.ts`),
   * który po każdej zmianie pyta gita jeszcze raz — nasz własny odczyt nie ma prawa być
   * zdarzeniem, na które sam reaguje. To dokładnie ten przełącznik, który git daje
   * narzędziom działającym w tle (edytory, prompt powłoki).
   */
  return { ...base, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...GIT_ENV_GUARDS };
}

/**
 * Wspólny spawn gita z twardym timeoutem — zero interaktywności, zero stdin, zero sieci.
 *
 * @param env pełne środowisko procesu (`gitReadEnv(config.gitEnvBase)`). WYMAGANE: wartość
 *            domyślna oznaczałaby ciche dziedziczenie env serwera razem z sekretami Raroga.
 * @param maxBytes po przekroczeniu limitu proces jest zabijany, a wynik oznaczany jako OK
 *                 z `capped: true`: wołający chce prefiks, nie całość (patrz `DIFF_READ_CAP_BYTES`).
 *
 * Nie rzuca: proces, którego nie dało się uruchomić, wraca jako `ok: false` z kodem errno
 * w `spawnFailed` — także wtedy, gdy Node zgłasza błąd `spawn` synchronicznie (ENOMEM i inne
 * spoza jego krótkiej listy błędów „na później").
 *
 * The runner puts {@link GIT_ENV_GUARDS} over `env` itself and takes {@link GIT_ENV_DROPPED} out of it, so a caller's
 * environment cannot undo either, and starts
 * `diff` only with a git at or above {@link MIN_GIT_VERSION} (version read once per `PATH`). Before every git
 * process it reads the config key names and empties each filter driver ({@link filterDriversOff}); that read and the
 * process share `timeoutMs`. On macOS every one of these git processes starts under the sandbox
 * ({@link gitSandbox}, probed once per environment). Before anything else it binds the command to the work tree of the
 * read ({@link bindWorkTree}); a read without one starts no git at all.
 */
export function spawnGitArgs(
  env: NodeJS.ProcessEnv, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DIFF_READ_CAP_BYTES,
): GitArgsRunner {
  const processEnv = guardedGitEnv(env);
  return async (command, cwd) => {
    const bound = await bindWorkTree(command, cwd);
    if ('refused' in bound) return bound.refused;
    const layer2 = await gitSandbox(processEnv);
    const sandbox = 'sandbox' in layer2 ? layer2.sandbox : null;
    if (bound.command.sub === 'diff') {
      const refusal = await diffRefusal(processEnv, timeoutMs, sandbox);
      if (refusal !== null) return refusal;
    }
    const deadline = Date.now() + timeoutMs;
    const drivers = await filterDriversOff(cwd, bound.command.workTree, processEnv, timeoutMs, sandbox);
    if ('refused' in drivers) return drivers.refused;
    return startGit(bound.command, cwd, drivers.env, Math.max(1, deadline - Date.now()), maxBytes, 'utf8', sandbox);
  };
}

/**
 * `command` bound to the work tree of a read in `cwd`, or the result of a read that starts no git:
 * - no directory up from `cwd` has `.git`: exit code 128, what git answers outside a repository. Git does not run,
 *   because a `.git` created between the lookup and its start would come with its own `core.worktree`;
 * - `cwd` cannot be resolved, or the command is not one the runner takes ({@link gitArgv} throws): `spawnFailed`,
 *   as for a process that did not start.
 * The config names read ({@link filterDriversOff}) runs in the same `cwd` with the same pin.
 */
async function bindWorkTree(
  command: GitCommand, cwd: string,
): Promise<{ command: BoundGitCommand } | { refused: GitArgsResult }> {
  try {
    const workTree = await gitWorkTree(cwd);
    if (workTree === null) return { refused: { ok: false, stdout: '', exitCode: 128 } };
    // Built field by field: a `workTree` or a `probe` in the caller's object does not reach the argv.
    const bound: BoundGitCommand = { global: command.global, sub: command.sub, rest: command.rest, workTree };
    gitArgv(bound);
    return { command: bound };
  } catch (error) {
    return { refused: { ok: false, stdout: '', spawnFailed: errnoCode(error) } };
  }
}

/**
 * The sandbox probe runs per `PATH`, which decides the git binaries. One probe per environment for the life of the
 * process: its answer, also "not applied", stays. Concurrent reads share one probe.
 */
const sandboxProbes = new Map<string, Promise<GitSandboxState>>();

/**
 * The sandbox for the git processes of `env`: the sandbox every one of them starts under, or why git runs with the
 * filter drivers off only (not macOS, no git on `PATH`, a profile `sandbox-exec` cannot apply, measured under another
 * sandbox). `git --exec-path` of the probe runs without the sandbox: it reads no repository. The first probe of an
 * environment decides; `sandboxExec` is the program it tries.
 */
export function gitSandbox(env: NodeJS.ProcessEnv, sandboxExec = SANDBOX_EXEC): Promise<GitSandboxState> {
  const processEnv = guardedGitEnv(env);
  const key = processEnv['PATH'] ?? '';
  const known = sandboxProbes.get(key);
  if (known !== undefined) return known;
  const run = (probe: GitRunnerProbe, sandbox: GitSandbox | null): Promise<GitArgsResult> =>
    startGit(probe, '/', processEnv, DEFAULT_TIMEOUT_MS, VERSION_READ_CAP_BYTES, 'utf8', sandbox);
  const probe = probeGitSandbox(process.platform, processEnv['PATH'] ?? '', sandboxExec, {
    execPath: () => run({ probe: 'exec-path' }, null),
    version: (sandbox) => run({ probe: 'version' }, sandbox),
  }).catch((error: unknown): GitSandboxState => ({ unavailable: `probe failed: ${errnoCode(error)}` }));
  sandboxProbes.set(key, probe);
  return probe;
}

/**
 * Server start: probes the sandbox once for the environment of the server's git reads and writes one log line when
 * git runs with the filter drivers off only.
 */
export async function probeGitSandboxAtStart(
  env: NodeJS.ProcessEnv, log: (line: string) => void, sandboxExec = SANDBOX_EXEC,
): Promise<GitSandboxState> {
  const state = await gitSandbox(env, sandboxExec);
  if ('unavailable' in state) log(gitSandboxLogLine(state.unavailable));
  return state;
}

/**
 * One git process: the only `spawn` of git in the server. Contract of the result: {@link spawnGitArgs}.
 * `encoding` decodes stdout; the names read uses {@link CONFIG_NAMES_ENCODING} to keep the bytes. With `sandbox` git
 * starts through `sandbox-exec` ({@link gitSandbox}), with the same argv after the profile and the binary.
 * A caller's command comes only bound to its work tree ({@link BoundGitCommand}).
 */
function startGit(
  command: BoundGitCommand | GitRunnerProbe | BoundNamesProbe, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number,
  maxBytes: number,
  encoding: BufferEncoding, sandbox: GitSandbox | null,
): Promise<GitArgsResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    // Nie chcemy, żeby git próbował pytać o cokolwiek interaktywnie ani czytać stdin.
    const options: SpawnOptions = { cwd, stdio: ['ignore', 'pipe', 'ignore'], env };
    try {
      child = sandbox === null
        ? spawn('git', gitArgv(command), options)
        : spawn(sandbox.file, [...sandbox.args, ...gitArgv(command)], options);
    } catch (error) {
      resolve({ ok: false, stdout: '', spawnFailed: errnoCode(error) });
      return;
    }
    let stdout = '';
    let bytes = 0;
    let settled = false;
    const finish = (result: GitArgsResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // Powód JEST znany — patrz `GitArgsResult.timedOut`.
      finish({ ok: false, stdout, timedOut: true });
    }, timeoutMs);
    // Przy EMFILE/ENFILE Node nie zakłada rur wcale (`stdout === null`) i zaraz zgłosi `error`.
    child.stdout?.setEncoding(encoding);
    child.stdout?.on('data', (chunk: string) => {
      if (settled) return;
      stdout += chunk;
      bytes += Buffer.byteLength(chunk, encoding);
      if (bytes >= maxBytes) {
        child.kill('SIGKILL');
        finish({ ok: true, stdout, capped: true });
      }
    });
    // Procesu nie dało się uruchomić — powód idzie dalej, bo „system nie dał procesu" to inna
    // diagnoza niż „git odpowiedział błędem" (`GitArgsResult.spawnFailed`).
    child.on('error', (error) => { finish({ ok: false, stdout, spawnFailed: errnoCode(error) }); });
    child.on('close', (code) => {
      // Proces zabity sygnałem ma `code === null`: kodu wyjścia nie ma i pole nie powstaje.
      finish(typeof code === 'number' ? { ok: code === 0, stdout, exitCode: code } : { ok: false, stdout });
    });
  });
}

/** Kod errno z błędu `spawn` — `UNKNOWN`, gdy błąd go nie niesie (nie ma czego zgadywać). */
export function errnoCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN';
}

/** Wariant związany z jednym poleceniem (status / log). */
function spawnGit(
  command: GitCommand, env: NodeJS.ProcessEnv, timeoutMs: number,
): GitRunner {
  const run = spawnGitArgs(env, timeoutMs);
  return (cwd) => run(command, cwd);
}

/**
 * Produkcyjny runner statusu: `git status --porcelain=v2 --branch --untracked-files=all`.
 *
 * `--untracked-files=all`: bez niej nowy katalog to jeden wpis `? docs/` i panel nie ma jak pokazać
 * plików w środku. Sufit {@link DEFAULT_MAX_FILES} nie zasłoni przez to zmian śledzonych, bo porcelain
 * v2 wypisuje je przed nieśledzonymi (zmierzone na git 2.54). Zagnieżdżone repo dalej daje
 * jeden wpis z `/` na końcu — git w nie nie schodzi.
 */
export function spawnGitStatus(
  env: NodeJS.ProcessEnv, timeoutMs = DEFAULT_TIMEOUT_MS,
): GitRunner {
  return spawnGit({ sub: 'status', rest: ['--porcelain=v2', '--branch', '--untracked-files=all'] }, env, timeoutMs);
}

/** Separator pól w `git log --format` — US (0x1f), bo w temacie commita może stać wszystko. */
const LOG_SEP = '\u001f';

/** Format `git log -1`: skrót SHA, temat, czas commitera (epoka w sekundach). */
export const GIT_LOG_FORMAT = '%h%x1f%s%x1f%ct';

/**
 * `git log -1 --format=%h%x1f%s%x1f%ct` → ostatni commit albo `null`.
 *
 * `null` dla pustego wyjścia (repo bez commitów) i dla śmieci (zły separator, czas nie jest
 * liczbą) — wolimy nie pokazać wiersza, niż zmyślić commit.
 */
export function parseGitLog(stdout: string): GitCommit | null {
  const line = stdout.split('\n').find((l) => l !== '') ?? '';
  const [hash, subject, ct] = line.split(LOG_SEP);
  if (hash === undefined || hash === '' || subject === undefined || ct === undefined) return null;
  const seconds = Number(ct.trim());
  if (!Number.isFinite(seconds)) return null;
  return { hash, subject, at: new Date(seconds * 1000).toISOString() };
}

/** Produkcyjny runner ostatniego commita: `git log -1`. Lokalny jak pozostałe. */
export function spawnGitLog(
  env: NodeJS.ProcessEnv, timeoutMs = DEFAULT_TIMEOUT_MS,
): GitRunner {
  return spawnGit({ sub: 'log', rest: ['-1', `--format=${GIT_LOG_FORMAT}`] }, env, timeoutMs);
}

// ---------------------------------------------------------------------------
// Liczniki linii per plik (`fileDetails`) — `git diff --numstat -z` dla listy z `status`
// ---------------------------------------------------------------------------

/**
 * Własny budżet odczytu liczników. `numstat` biegnie PO `status` (potrzebuje jego listy plików),
 * więc ta liczba to najdłużej, o ile odczyt liczników opóźnia ramkę `git-status`. Po budżecie
 * proces jest zabijany, a ramka jedzie z samymi rodzajami.
 */
export const GIT_NUMSTAT_BUDGET_MS = 1_500;

/** Sufit wyjścia `numstat`: ≤ 50 plików (i źródła rename'ów) to setki bajtów, nie megabajty. */
export const GIT_NUMSTAT_READ_CAP_BYTES = 64 * 1024;

/**
 * Polecenie odczytu liczników dla podanych ścieżek.
 *
 * - `--literal-pathspecs`: ścieżka z pliku to ŚCIEŻKA, nie wzorzec — `*`, `?` i magia `:(…)`
 *   w nazwie pliku nie rozszerzają zapytania na pół repo;
 * - `-z`: ścieżka dosłownie (spacja, tabulator, „ => ” w nazwie), a rename jako dwa osobne pola
 *   zamiast `stare => nowe`, którego bez `-z` nie da się odróżnić od nazwy z dosłownym „ => ”;
 * - `--relative`: ścieżki względem katalogu sesji, jak w `git status`. Bez niego sesja
 *   w podkatalogu repo (`rarog/server`) dostawała `server/src/x.ts` wobec `src/x.ts` w statusie —
 *   liczniki chybiały, a przy tej samej nazwie w korzeniu (`../src/x.ts` → `src/x.ts`) trafiały
 *   do CUDZEGO pliku (zmierzone na git 2.54);
 * - `--no-ext-diff` jak w diffie sesji (patrz {@link NO_EXT_DIFF}).
 */
export function numstatArgs(pathspecs: readonly string[]): GitCommand {
  return {
    global: ['--literal-pathspecs'], sub: 'diff',
    rest: [NO_EXT_DIFF, '--relative', '--numstat', '-z', 'HEAD', '--', ...pathspecs],
  };
}

/** Liczniki jednego pliku z `numstat`: linie albo `binary` (git linii nie liczy). */
export type NumstatCounts = { linesAdded: number; linesDeleted: number } | { binary: true };

/** Rekord `numstat -z`: `dodane\tusunięte\tścieżka` albo przy rename `dodane\tusunięte\t` + 2 pola. */
const NUMSTAT_HEAD = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

/**
 * `git diff --numstat -z` → mapa ścieżka (po zmianie) → liczniki.
 *
 * Bierzemy WYŁĄCZNIE rekordy domknięte bajtem NUL: kawałek po ostatnim NUL to rekord ucięty
 * (sufit bajtów, zabity proces) i jego liczby mogłyby być połówką. Plik binarny (`-\t-`) wraca
 * jako `binary: true` bez liczników — `parseNumstatFiles` diffa sesji dalej zamienia go na 0/0.
 */
export function parseNumstatZ(stdout: string): Map<string, NumstatCounts> {
  const out = new Map<string, NumstatCounts>();
  const fields = stdout.split('\0');
  fields.pop();
  for (let i = 0; i < fields.length; i += 1) {
    const match = NUMSTAT_HEAD.exec(fields[i] ?? '');
    if (match === null) continue;
    const [, added = '', deleted = ''] = match;
    let path = match[3] ?? '';
    if (path === '') {
      // Rename/copy: dwa kolejne pola to ścieżka źródłowa i docelowa — liczy się docelowa.
      const target = fields[i + 2];
      if (target === undefined) break;
      path = target;
      i += 2;
    }
    if (path === '') continue;
    if (added === '-' && deleted === '-') out.set(path, { binary: true });
    else if (added !== '-' && deleted !== '-') {
      out.set(path, { linesAdded: Number(added), linesDeleted: Number(deleted) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff sesji (`GET /api/sessions/:id/diff`)
// ---------------------------------------------------------------------------

/**
 * Ścieżka z wiersza `--numstat`.
 *
 * Rename bez `-z` git zapisuje jako `stare => nowe` (czasem z prefiksem/sufiksem wspólnym:
 * `src/{a => b}/plik.ts`). Bierzemy stronę PRAWĄ — overlay pokazuje stan po zmianie.
 */
export function numstatPath(raw: string): string {
  const arrow = raw.indexOf(' => ');
  if (arrow === -1) return raw;
  const open = raw.indexOf('{');
  const close = raw.indexOf('}');
  if (open !== -1 && close > open) {
    const middle = raw.slice(open + 1, close);
    const to = middle.slice(middle.indexOf(' => ') + 4);
    return `${raw.slice(0, open)}${to}${raw.slice(close + 1)}`;
  }
  return raw.slice(arrow + 4);
}

/**
 * `git diff --numstat HEAD` → lista plików z licznikami (diff sesji, bez `-z`).
 *
 * Pliki binarne (`-\t-`) zostają na liście z zerami: użytkownik ma zobaczyć, że plik się
 * zmienił, nawet jeśli nie ma tam linii do policzenia. Ramka `git-status` ma własny parser
 * ({@link parseNumstatZ}), który binarność zachowuje.
 */
export function parseNumstatFiles(stdout: string): { path: string; linesAdded: number; linesDeleted: number }[] {
  const out: { path: string; linesAdded: number; linesDeleted: number }[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = Number(parts[0]);
    const deleted = Number(parts[1]);
    const path = numstatPath(parts.slice(2).join('\t').trim());
    if (path === '') continue;
    out.push({
      path,
      linesAdded: Number.isInteger(added) ? added : 0,
      linesDeleted: Number.isInteger(deleted) ? deleted : 0,
    });
  }
  return out;
}

/**
 * `git diff --name-status HEAD` → mapa ścieżka → status.
 *
 * Litery gita mapujemy na trójkę z kontraktu: `R` (rename) to dla overlaya zwykła modyfikacja
 * pliku docelowego, `C` (copy) to nowy plik, reszta (`T`, `U`, `X`) to modyfikacja.
 */
export function parseNameStatus(stdout: string): Map<string, DiffFileStatus> {
  const map = new Map<string, DiffFileStatus>();
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const parts = line.split('\t');
    const code = (parts[0] ?? '').trim();
    if (code === '' || parts.length < 2) continue;
    // Rename/copy niosą DWIE ścieżki — interesuje nas docelowa (ostatnia).
    const path = (parts.at(-1) ?? '').trim();
    if (path === '') continue;
    const letter = code[0];
    const status: DiffFileStatus = letter === 'A' || letter === 'C'
      ? 'A'
      : (letter === 'D' ? 'D' : 'M');
    map.set(path, status);
  }
  return map;
}

/**
 * Ucina patch do limitu BAJTÓW, na granicy linii.
 *
 * Cięcie po ostatnim `\n` w budżecie robi dwie rzeczy naraz: nie rozjeżdża znaku UTF-8
 * i nie zostawia w overlayu połówki linii diffa (co wyglądałoby jak uszkodzony patch).
 *
 * Najpierw MIERZYMY, a kopiujemy dopiero na ścieżce ucinania: `Buffer.from` na patchu, który
 * i tak się mieści (czyli praktycznie zawsze), to kopia całości po to, żeby poznać jej długość.
 * Zmierzone w Node 22: 400 kB — 0,30 ms wobec 0,11 ms, 8 MB (sufit `DIFF_READ_CAP_BYTES`) —
 * 5,97 ms wobec 2,17 ms i osiem megabajtów alokacji na żądanie.
 */
export function clampPatch(
  patch: string, maxBytes = MAX_DIFF_PATCH_BYTES,
): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, 'utf8') <= maxBytes) return { patch, truncated: false };
  const head = Buffer.from(patch, 'utf8').subarray(0, maxBytes);
  const lastNewline = head.lastIndexOf(0x0a);
  const cut = lastNewline > 0 ? head.subarray(0, lastNewline + 1) : head;
  return { patch: cut.toString('utf8'), truncated: true };
}

export interface CollectDiffOptions {
  /**
   * Runner gita — WYMAGANY, bo niesie środowisko procesu.
   *
   * Wartości domyślnej nie ma: `spawnGitArgs()` na środowisku serwera byłby drogą,
   * którą sekrety Raroga wchodziłyby do gita po cichu. Env pochodzi z konfiguracji
   * (`gitEnvBase`), a wołający musi go podać jawnie.
   */
  run: GitArgsRunner;
  maxPatchBytes?: number;
  /**
   * Czym na dysku jest wpis nieśledzony (domyślnie {@link probeUntracked}). Wstrzykiwalne, bo testy
   * z atrapą runnera nie mają plików na dysku.
   */
  probe?: (cwd: string, path: string) => Promise<UntrackedEntry>;
}

/**
 * Wpis nieśledzony na dysku: zwykły plik, dowiązanie symboliczne (z celem) albo cokolwiek innego
 * (katalog, gniazdo, kolejka, wpis, który zdążył zniknąć).
 */
export type UntrackedEntry =
  | { kind: 'file' }
  | { kind: 'symlink'; target: string }
  | { kind: 'other' };

/**
 * Rodzaj wpisu nieśledzonego przez `lstat` — czyli BEZ podążania za dowiązaniem.
 *
 * `git diff --no-index -- /dev/null <ścieżka>` sprawdza ścieżkę przez `stat`: gdy to katalog (albo
 * dowiązanie do katalogu), porównuje `/dev/null` z `<ścieżka>/null`. Nieśledzone dowiązanie do katalogu
 * POZA repo, w którym leży plik `null`, oddałoby więc jego treść (zmierzone na git 2.54).
 * Dlatego do `--no-index` idzie wyłącznie zwykły plik.
 */
export async function probeUntracked(cwd: string, path: string): Promise<UntrackedEntry> {
  try {
    const full = join(cwd, path);
    // Katalog nadrzędny po rozwiązaniu dowiązań ma leżeć w katalogu sesji: `ls-files` nie schodzi
    // w dowiązania, więc katalog podmieniony na dowiązanie PO wypisaniu listy odpada tutaj.
    const [root, parent] = await Promise.all([realpath(cwd), realpath(dirname(full))]);
    if (parent !== root && !parent.startsWith(root + sep)) return { kind: 'other' };
    const info = await lstat(full);
    if (info.isSymbolicLink()) return { kind: 'symlink', target: await readlink(full) };
    return info.isFile() ? { kind: 'file' } : { kind: 'other' };
  } catch {
    return { kind: 'other' };
  }
}

/**
 * Blok patcha dla nieśledzonego dowiązania, złożony przez serwer: ten sam kształt, który git daje
 * dla dowiązania do pliku (tryb `120000`, jedyną „linią" jest cel). Celu nikt nie otwiera.
 */
export function symlinkPatch(path: string, target: string): { patch: string; lines: number } {
  // Cel z nową linią (legalna nazwa pliku) to kilka linii patcha, każda z własnym `+` — bez
  // zamiany znaków, bo dwa różne cele dawałyby wtedy ten sam blok.
  const closed = target.endsWith('\n');
  const lines = (closed ? target.slice(0, -1) : target).split('\n');
  const range = lines.length === 1 ? '+1' : `+1,${String(lines.length)}`;
  const body = lines.map((line) => `+${line}\n`).join('');
  const before = patchHeaderPath('a/', path);
  const after = patchHeaderPath('b/', path);
  return {
    patch: `diff --git ${before} ${after}\nnew file mode 120000\n--- /dev/null\n+++ ${after}\n`
      + `@@ -0,0 ${range} @@\n${body}${closed ? '' : '\\ No newline at end of file\n'}`,
    lines: lines.length,
  };
}

/** Znaki, przez które git bierze ścieżkę nagłówka w cudzysłów: sterujące, `"` i `\`. */
const HEADER_QUOTED = /[\u0000-\u001f\u007f"\\]/g;

/**
 * Ścieżka w nagłówku patcha tak, jak pisze ją git: zwykła dosłownie, a z tabulatorem, nową linią,
 * cudzysłowem albo ukośnikiem wstecznym — w cudzysłowie z sekwencjami C (`"b/na\tme"`). Bez tego
 * nazwa z nową linią rozrywała nagłówek na dwie linie i mogła dopisać do bloku własne linie
 * (`git apply --numstat` taki blok odrzuca).
 */
function patchHeaderPath(prefix: 'a/' | 'b/', path: string): string {
  if (path.search(HEADER_QUOTED) === -1) return `${prefix}${path}`;
  const escaped = path.replace(HEADER_QUOTED, (char) => {
    switch (char) {
      case '\t': return '\\t';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '"': return '\\"';
      case '\\': return '\\\\';
      default: return `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`;
    }
  });
  return `"${prefix}${escaped}"`;
}

/**
 * Zbiera diff katalogu sesji: `git diff HEAD` (patch) + `--numstat` (liczby) + `--name-status`
 * (litery A/M/D).
 *
 * Trzy wywołania zamiast jednego, bo git ma JEDEN format wyjścia na raz — a parsowanie
 * statusów z samego patcha byłoby własnym parserem diffa (dokładnie tego spec zabrania po
 * stronie UI i nie ma powodu wprowadzać go po stronie serwera).
 *
 * Wszystkie trzy są lokalne: żadne nie dotyka sieci. Katalog spoza repo (albo repo bez HEAD)
 * = pusty diff, nie błąd — sesja może żyć w katalogu, który nie jest repozytorium.
 */
/** Sufit plików NIEŚLEDZONYCH w diffie — każdy to osobny spawn gita. */
const UNTRACKED_DIFF_CAP = 20;

/**
 * `--no-ext-diff` przy KAŻDYM `git diff` diffa sesji: `diff.external` z konfiguracji repo
 * podmienia patch na wyjście zewnętrznego programu. Zmierzone na git 2.54 ze skryptem, który
 * nic nie pisze na stdout: 0 B z `diff HEAD` i z `diff --no-index`, czyli overlay „brak zmian"
 * przy realnej zmianie — a program, który coś wypisze, i tak nie odda patcha unified, który
 * umie narysować front. `--numstat`/`--name-status` programu nie wołają, ale flaga stoi i tam,
 * żeby cztery wywołania czytało się jednym wzrokiem. `textconv` wyłącza runner ({@link gitArgv});
 * filtry `clean`/`smudge` zostają.
 *
 * The runner adds this flag to every `diff` and `log` itself ({@link subcommandGuards}); a caller that still passes
 * it only repeats it, and git takes the flag twice without complaint.
 */
export const NO_EXT_DIFF = '--no-ext-diff';

/**
 * `--relative` przy każdym `git diff HEAD` diffa sesji: diff obejmuje WYŁĄCZNIE
 * katalog sesji, a ścieżki są względem niego — jak w ramce `git-status`. Bez tego sesja
 * w podkatalogu repo (`repo/public`, gdy korzeniem Raroga jest tylko on) dostawała patch całego
 * repozytorium, razem z plikami z katalogów obok (`repo/private`), czyli spoza zasięgu.
 */
export const RELATIVE = '--relative';

export async function collectDiff(
  cwd: string, opts: CollectDiffOptions,
): Promise<SessionDiff> {
  const run = opts.run;
  const [patchResult, numstatResult, nameStatusResult, untrackedResult] = await Promise.all([
    run({ sub: 'diff', rest: [NO_EXT_DIFF, RELATIVE, 'HEAD'] }, cwd).catch(() => ({ ok: false, stdout: '' })),
    run({ sub: 'diff', rest: [NO_EXT_DIFF, RELATIVE, '--numstat', 'HEAD'] }, cwd)
      .catch(() => ({ ok: false, stdout: '' })),
    run({ sub: 'diff', rest: [NO_EXT_DIFF, RELATIVE, '--name-status', 'HEAD'] }, cwd)
      .catch(() => ({ ok: false, stdout: '' })),
    // Pliki nieśledzone: `git diff HEAD` ich NIE pokazuje, a `git status` je liczy — bez tej
    // gałęzi overlay mówiłby „0 plików" przy liczniku „1 plik".
    run({ sub: 'ls-files', rest: ['--others', '--exclude-standard'] }, cwd)
      .catch(() => ({ ok: false, stdout: '' })),
  ]);
  if (!patchResult.ok && !numstatResult.ok) {
    return { files: [], patch: '', truncated: false };
  }

  const statuses = nameStatusResult.ok ? parseNameStatus(nameStatusResult.stdout) : new Map();
  const files: DiffFile[] = parseNumstatFiles(numstatResult.ok ? numstatResult.stdout : '')
    .map((file) => ({
      path: file.path,
      // Brak wpisu w `--name-status` (np. gdy to wywołanie padło) — modyfikacja jest
      // najbezpieczniejszym domysłem: nie sugeruje ani utworzenia, ani skasowania pliku.
      status: statuses.get(file.path) ?? 'M',
      linesAdded: file.linesAdded,
      linesDeleted: file.linesDeleted,
    }));

  /*
   * Nieśledzone dokładamy per plik przez `git diff --no-index -- /dev/null <plik>`.
   * Uwaga na kod wyjścia: `--no-index` kończy się 1, gdy pliki się różnią (czyli ZAWSZE tu),
   * więc liczy się stdout, nie `ok`. Sekwencyjnie i z sufitem — to spawn na plik, a katalog
   * świeżego projektu potrafi mieć setki nieśledzonych plików.
   *
   * Do `--no-index` idzie TYLKO zwykły plik ({@link probeUntracked}): dowiązanie dostaje blok
   * złożony przez serwer, a katalog i pliki specjalne są pomijane.
   */
  const probe = opts.probe ?? probeUntracked;
  const untracked = (untrackedResult.ok ? untrackedResult.stdout : '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, UNTRACKED_DIFF_CAP);
  let untrackedPatch = '';
  for (const path of untracked) {
    const entry = await probe(cwd, path).catch((): UntrackedEntry => ({ kind: 'other' }));
    if (entry.kind === 'other') continue;
    if (entry.kind === 'symlink') {
      const block = symlinkPatch(path, entry.target);
      files.push({ path, status: 'A', linesAdded: block.lines, linesDeleted: 0 });
      untrackedPatch += block.patch;
      continue;
    }
    const result = await run({ sub: 'diff', rest: [NO_EXT_DIFF, '--no-index', '--', '/dev/null', path] }, cwd)
      .catch(() => ({ ok: false, stdout: '' }));
    if (result.stdout === '') continue;
    const added = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
    files.push({ path, status: 'A', linesAdded: added, linesDeleted: 0 });
    untrackedPatch += result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`;
  }

  const clamped = clampPatch(
    (patchResult.ok ? patchResult.stdout : '') + untrackedPatch,
    opts.maxPatchBytes ?? MAX_DIFF_PATCH_BYTES,
  );
  return { files, patch: clamped.patch, truncated: clamped.truncated };
}

export interface GitStatusWatcherOptions {
  /**
   * Runner `git status` — WYMAGANY z tego samego powodu co w {@link CollectDiffOptions}:
   * niesie środowisko procesu, czyli granicę sekretów (`GIT_ENV_PASSTHROUGH`).
   */
  run: GitRunner;
  /** Runner `git log -1` (ostatni commit); brak albo `null` wyłącza wiersz commita. */
  runLog?: GitRunner | null;
  /**
   * Runner liczników linii (`git diff --numstat -z`, argumenty z {@link numstatArgs}) z WŁASNYM
   * budżetem czasu. Brak albo `null` = `fileDetails` z samymi rodzajami (`RAROG_GIT_FILE_DETAILS=0`
   * i testy, które liczników nie dotyczą).
   */
  runNumstat?: GitArgsRunner | null;
  /** Wynik każdego odczytu (czas i los liczników) — linia diagnostyczna managera. */
  onCollect?: (sample: GitCollectSample) => void;
  throttleMs?: number;
  maxFiles?: number;
  /** Wstrzykiwalny zegar (testy). */
  now?: () => number;
}

/**
 * Co się stało z licznikami linii w jednym odczycie: policzone, pominięte (czyste repo, same
 * nieśledzone, runner wyłączony), timeout budżetu albo błąd gita (np. repo bez HEAD, kod 128).
 */
export type NumstatOutcome = 'ok' | 'skipped' | 'timeout' | 'failed';

/** Jeden odczyt `#collect` dla diagnostyki: czas całości i los liczników. */
export interface GitCollectSample {
  ms: number;
  numstat: NumstatOutcome;
}

/**
 * Throttlowany dostawca statusu gita, jeden na serwer (klucz throttle'a to `cwd`).
 */
export class GitStatusWatcher {
  readonly #run: GitRunner;
  readonly #runLog: GitRunner | null;
  readonly #runNumstat: GitArgsRunner | null;
  readonly #onCollect: ((sample: GitCollectSample) => void) | null;
  readonly #throttleMs: number;
  readonly #maxFiles: number;
  readonly #now: () => number;
  readonly #lastRunAt = new Map<string, number>();
  readonly #inFlight = new Map<string, Promise<GitStatus | null>>();
  /** Jeden ZAPLANOWANY odczyt `force` na katalog — kolejni wymuszający dołączają do niego. */
  readonly #pendingForce = new Map<string, Promise<GitStatus | null>>();

  constructor(opts: GitStatusWatcherOptions) {
    this.#run = opts.run;
    this.#runLog = opts.runLog ?? null;
    this.#runNumstat = opts.runNumstat ?? null;
    this.#onCollect = opts.onCollect ?? null;
    this.#throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.#maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.#now = opts.now ?? (() => Date.now());
  }

  /**
   * Pyta gita o status katalogu.
   *
   * @param force pomija throttle. Używane WYŁĄCZNIE wtedy, gdy repo właśnie się zmieniło
   *              (koniec tury, zmiana w `.git` spoza sesji) — stary odczyt kłamałby, więc
   *              throttle byłby tu szkodliwy.
   * @returns status albo `null`, gdy zapytanie wpadło w throttle, katalog nie jest repo
   *          albo git zwrócił błąd.
   */
  async status(cwd: string, force = false): Promise<GitStatus | null> {
    const running = this.#inFlight.get(cwd);
    if (running !== undefined) {
      if (!force) return running;
      /*
       * `force` znaczy „repo WŁAŚNIE się zmieniło" (koniec tury, zmiana w `.git`). Już lecący
       * odczyt wystartował przed tą zmianą, więc oddanie jego wyniku pokazywałoby stan sprzed
       * niej — po pushu w wierszu gita zostawałoby `↑2` (znalezisko audytu CR-04).
       * Nie mnożymy procesów gita: czekamy, aż bieżący odczyt się domknie, i pytamy jeszcze raz.
       * `#inFlight` jest wtedy już posprzątane (kasuje je `finally` poniżej), więc rekurencja
       * schodzi dokładnie o jeden poziom.
       *
       * Pięć sesji jednego katalogu kończących tury w tej samej sekundzie to JEDEN odczyt
       * po bieżącym, nie pięć po kolei: wszyscy, którzy wymuszają
       * w oknie lecącego odczytu, dostają ten sam zaplanowany, a każdy taki odczyt i tak
       * jest późniejszy niż zmiana, która go wywołała.
       */
      const pending = this.#pendingForce.get(cwd);
      if (pending !== undefined) return pending;
      const next = running.then(() => {
        this.#pendingForce.delete(cwd);
        return this.status(cwd, true);
      });
      this.#pendingForce.set(cwd, next);
      return next;
    }

    const last = this.#lastRunAt.get(cwd);
    const now = this.#now();
    if (!force && last !== undefined && now - last < this.#throttleMs) return null;
    this.#lastRunAt.set(cwd, now);

    const promise = this.#collect(cwd)
      .catch(() => null)
      .finally(() => { this.#inFlight.delete(cwd); });
    this.#inFlight.set(cwd, promise);
    return promise;
  }

  /**
   * Odpala `status` i `log -1` RÓWNOLEGLE, skleja wynik, a dla brudnego repo dokłada liczniki
   * linii z `numstat` (po `status`, bo potrzebuje jego listy plików).
   *
   * Ostatni commit i liczniki są dodatkami: ich awaria (brak HEAD w świeżym repo, timeout)
   * zostawia status bez tych pól, ale nie kasuje wiersza gałęzi ani listy plików z rodzajami.
   */
  async #collect(cwd: string): Promise<GitStatus | null> {
    const startedAt = this.#now();
    const failed = { ok: false, stdout: '' };
    const optional = (run: GitRunner | null): Promise<{ ok: boolean; stdout: string }> =>
      (run === null ? Promise.resolve(failed) : run(cwd).catch(() => failed));
    const [statusResult, logResult] = await Promise.all([
      this.#run(cwd).catch(() => failed),
      optional(this.#runLog),
    ]);
    if (!statusResult.ok) {
      this.#onCollect?.({ ms: this.#now() - startedAt, numstat: 'skipped' });
      return null;
    }

    const { status, pathspecs } = parsePorcelain(statusResult.stdout, this.#maxFiles);
    if (logResult.ok) {
      const commit = parseGitLog(logResult.stdout);
      if (commit !== null) status.lastCommit = commit;
    }
    const numstat = await this.#lineCounts(cwd, status, pathspecs);
    this.#onCollect?.({ ms: this.#now() - startedAt, numstat });
    return status;
  }

  /**
   * Dokłada liczniki linii do `status.fileDetails` (w miejscu) i mówi, jak poszło.
   *
   * Pomijany bez procesu, gdy nie ma czego liczyć (czyste repo, same nieśledzone, ścieżki
   * cytowane). Porażka i timeout zostawiają wpisy z samymi rodzajami — nigdy zgadywane zera.
   * Dopasowanie po ścieżce PO zmianie: tak samo stoi w `files` i tak samo oddaje ją `-z`.
   */
  async #lineCounts(cwd: string, status: GitStatus, pathspecs: readonly string[]): Promise<NumstatOutcome> {
    const run = this.#runNumstat;
    if (run === null || pathspecs.length === 0) return 'skipped';
    const result = await run(numstatArgs(pathspecs), cwd)
      .catch((): GitArgsResult => ({ ok: false, stdout: '' }));
    if (!result.ok) return result.timedOut === true ? 'timeout' : 'failed';
    const counts = parseNumstatZ(result.stdout);
    for (const detail of status.fileDetails) {
      const found = counts.get(detail.path);
      if (found !== undefined) Object.assign(detail, found);
    }
    return 'ok';
  }

  /** Kasuje pamięć throttle'a (np. po zamknięciu sesji). */
  forget(cwd: string): void {
    this.#lastRunAt.delete(cwd);
  }
}
