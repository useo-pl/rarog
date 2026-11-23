/**
 * Obserwator katalogu `.git` — trzecie, NIEZALEŻNE OD SESJI źródło odświeżenia `git-status`.
 *
 * Same zdarzenia z sesji Claude (tool-call, wejście w transkrypt, pojawienie się karty) nie
 * wystarczą: commit zrobiony w terminalu Raroga, w lazygit albo w nvim na Macu nie rusza
 * żadnego z nich — status stałby do następnego tool-calla. Ten moduł patrzy
 * na sam katalog `.git` (`fs.watch`, zero procesów, zero sieci) i po zmianie mówi managerowi
 * „ten katalog trzeba przeczytać jeszcze raz".
 *
 * Trzy reguły:
 * 1. **Tylko lokalny dysk.** Rarog nie robi `git fetch` w tle; watcher
 *    nie pyta o nic — reaguje na to, co git ZAPISAŁ, także po `git push` (aktualizuje
 *    `refs/remotes/...`) i po `git pull`.
 * 2. **Leading + trailing, jeden limit na REPO.** Rebase, checkout dużej gałęzi albo `git gc`
 *    wyrzucają setki zdarzeń w kilka sekund. Pierwsze zdarzenie po ciszy planuje odczyt za
 *    750 ms (tyle, żeby zapisy JEDNEGO polecenia zmieściły się w jednym odczycie), a zdarzenia,
 *    które przyjdą do tego czasu, dołączają do zaplanowanego, zamiast przesuwać go w przód.
 *    Po odczycie stoi okno 2 s: co przyjdzie w nim, schodzi się w JEDEN odczyt na jego końcu.
 *    Sam resetujący debounce nie wystarcza — burza trwająca minutę odsuwałaby odczyt
 *    o minutę i wiersz gita stałby tyle, ile ona. Odczytów jest przez to więcej, ale
 *    RAMEK nie: odczytu bez zmiany treści manager NIE rozgłasza (podpis w `SessionGit.applyGitStatus`).
 * 3. **Filtr nazw.** Rekurencyjny `fs.watch` na `.git` widzi też `objects/` (każdy zapis
 *    obiektu) i `*.lock`. Reagujemy tylko na to, co zmienia ODPOWIEDŹ `git status`/`git log`:
 *    `HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `MERGE_HEAD`, `index`, `packed-refs`, `refs/**`,
 *    `logs/**`.
 *
 * Własny odczyt Raroga NIE jest zdarzeniem: `gitReadEnv` daje `GIT_OPTIONAL_LOCKS=0`, więc
 * `git status` nie zapisuje indeksu i pętla „odczyt → zapis → odczyt" nie ma jak powstać.
 *
 * Awaria watchera (EMFILE w piaskownicy, katalog zniknął) jest CICHA: schodzimy do
 * dotychczasowych wyzwalaczy, bez logu przy każdym zdarzeniu. Ponowna próba dopiero wtedy,
 * gdy repo zostanie zwolnione (ostatni `unwatch`) i ktoś je znów zarejestruje.
 */
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readRegularFileSync } from './safe-read.ts';

/** Zwłoka między pierwszym zdarzeniem burzy a odczytem (ms) — patrz reguła 2 w nagłówku. */
export const DEFAULT_GIT_WATCH_DEBOUNCE_MS = 750;

/** Najkrótszy odstęp między dwoma odczytami TEGO SAMEGO repo (ms). */
export const DEFAULT_GIT_WATCH_MIN_INTERVAL_MS = 2_000;

/** Sufit pliku `.git` (`gitdir: …`) i `commondir`: jedna ścieżka, nie kilobajty. Dłuższy = to nie repo. */
const GIT_POINTER_MAX_BYTES = 4 * 1024;

/**
 * Nazwy w `.git`, których zmiana zmienia wynik `git status --branch` albo `git log -1`.
 * Ścieżki z rekurencyjnego watchera są WZGLĘDNE wobec obserwowanego katalogu i używają
 * separatora systemu — na macOS `/`.
 */
const TOP_LEVEL_FILES = new Set(['HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'index', 'packed-refs']);

/** Czy zmiana pod tą ścieżką (względną wobec katalogu gita) jest warta odczytu. */
export function isRelevantGitPath(name: string): boolean {
  if (name.endsWith('.lock')) return false;
  if (TOP_LEVEL_FILES.has(name)) return true;
  return name.startsWith('refs/') || name.startsWith('logs/');
}

export interface GitDirs {
  /** Katalog z `HEAD` i `index` tego drzewa roboczego (`.git` albo `.git/worktrees/<x>`). */
  gitDir: string;
  /** Wspólny katalog refów przy worktree (`commondir`); `null`, gdy to samo co `gitDir`. */
  commonDir: string | null;
}

/**
 * Szuka `.git` idąc W GÓRĘ od `cwd` (sesja może żyć w podkatalogu repo, np. `rarog/web`).
 *
 * `.git` bywa PLIKIEM (`gitdir: <ścieżka>`) — tak wyglądają worktree i submoduły; wtedy
 * `HEAD`/`index` są pod wskazanym katalogiem, a refy we wspólnym `commondir`. Brak repo
 * = `null`, bez wyjątku: sesja w katalogu bez gita to normalna sytuacja.
 */
export function findGitDirs(cwd: string): GitDirs | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = resolve(dir, '.git');
    const gitDir = resolveGitDir(candidate, dir);
    if (gitDir !== null) return { gitDir, commonDir: readCommonDir(gitDir) };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Treść pliku-wskaźnika (`.git` worktree, `commondir`) albo `null`.
 *
 * Tylko plik zwykły w sufit {@link GIT_POINTER_MAX_BYTES}, bez dowiązania w ostatnim członie (`safe-read.ts`):
 * agent w sandboksie zapisuje `.git`, a FIFO jako `commondir` zawieszało tu synchronicznie rejestrację sesji.
 */
function readPointer(path: string): string | null {
  try {
    const read = readRegularFileSync(path, { maxBytes: GIT_POINTER_MAX_BYTES, followSymlink: false });
    return read === null || read.truncated ? null : read.bytes.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Cel wskaźnika przyjmujemy tylko jako KATALOG (Ś9): `fs.watch` otwiera obserwowaną ścieżkę, a plik albo
 * FIFO w tym miejscu nie jest repozytorium. Podmiana celu między tym sprawdzeniem a `watch` wymaga żywego procesu
 * atakującego — to samo okno co przy `.git` jako katalogu.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveGitDir(candidate: string, base: string): string | null {
  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return candidate;
  if (!stat.isFile()) return null;
  const text = readPointer(candidate);
  if (text === null) return null;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (match === null || match[1] === undefined) return null;
  const target = isAbsolute(match[1]) ? match[1] : resolve(base, match[1]);
  return isDirectory(target) ? target : null;
}

function readCommonDir(gitDir: string): string | null {
  const text = readPointer(resolve(gitDir, 'commondir'));
  if (text === null) return null;
  const target = text.trim();
  if (target === '') return null;
  const common = isAbsolute(target) ? target : resolve(gitDir, target);
  return common === gitDir || !isDirectory(common) ? null : common;
}

export interface GitRepoWatcherOptions {
  /** Wołane po zaplanowanym odczycie (reguła 2) — z listą katalogów sesji dzielących repo. */
  onChange: (cwds: readonly string[]) => void;
  /** Wołane RAZ per repo, gdy watchera nie da się postawić (diagnostyka, nie sterowanie). */
  onUnavailable?: (gitDir: string, error: unknown) => void;
  debounceMs?: number;
  /** Sufit tempa odczytów jednego repo; `0` znaczy „bez limitu" (dawne zachowanie). */
  minIntervalMs?: number;
  /** Wstrzykiwalne `fs.watch` (testy). */
  watchFn?: typeof watch;
  /** Wstrzykiwalny zegar (testy) — mierzy odstęp między odczytami. */
  now?: () => number;
}

interface RepoWatch {
  watchers: FSWatcher[];
  /** Katalogi sesji dzielące to repo (liczniki per cwd trzyma `#byCwd`). */
  cwds: Set<string>;
  timer: NodeJS.Timeout | null;
  /** Kiedy ostatnio oddaliśmy `onChange` dla tego repo (ms); `null` = jeszcze ani razu. */
  lastFiredAt: number | null;
  /** Awaria watchera: repo zostaje na liście bez obserwacji do zwolnienia ostatniego cwd. */
  failed: boolean;
}

/**
 * Jeden watcher na REPO (nie na sesję): sesje z `rarog` i `rarog/web` dzielą `.git`, a każdy
 * `watch(cwd)` jest liczony — repo puszczamy dopiero po ostatnim `unwatch`.
 */
export class GitRepoWatcher {
  readonly #onChange: (cwds: readonly string[]) => void;
  readonly #onUnavailable: ((gitDir: string, error: unknown) => void) | null;
  readonly #debounceMs: number;
  readonly #minIntervalMs: number;
  readonly #watchFn: typeof watch;
  readonly #now: () => number;
  readonly #repos = new Map<string, RepoWatch>();
  /** cwd → klucz repo (`gitDir`); `null` = katalog bez gita (też liczony, żeby `unwatch` był symetryczny). */
  readonly #byCwd = new Map<string, { gitDir: string | null; count: number }>();
  #closed = false;

  constructor(opts: GitRepoWatcherOptions) {
    this.#onChange = opts.onChange;
    this.#onUnavailable = opts.onUnavailable ?? null;
    this.#debounceMs = opts.debounceMs ?? DEFAULT_GIT_WATCH_DEBOUNCE_MS;
    this.#minIntervalMs = opts.minIntervalMs ?? DEFAULT_GIT_WATCH_MIN_INTERVAL_MS;
    this.#watchFn = opts.watchFn ?? watch;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Repozytoria pod obserwacją (diagnostyka i testy). */
  get repoCount(): number {
    return this.#repos.size;
  }

  /** Czy dla tego cwd stoi ŻYWY watcher (a nie tylko wpis po awarii). */
  watching(cwd: string): boolean {
    const entry = this.#byCwd.get(cwd);
    if (entry === undefined || entry.gitDir === null) return false;
    const repo = this.#repos.get(entry.gitDir);
    return repo !== undefined && !repo.failed;
  }

  watch(cwd: string): void {
    if (this.#closed) return;
    const known = this.#byCwd.get(cwd);
    if (known !== undefined && known.gitDir !== null) {
      known.count += 1;
      return;
    }
    /*
     * Katalog bez repo NIE jest zapamiętany na zawsze: sesja mogła wstać w pustym katalogu,
     * a `git init` przyszedł później z terminala. Każdy kolejny `watch` takiego cwd pyta
     * dysk od nowa (tani `stat`) i dopiero znalezione repo dostaje watcher.
     */
    const dirs = findGitDirs(cwd);
    const gitDir = dirs?.gitDir ?? null;
    if (known !== undefined) {
      known.count += 1;
      known.gitDir = gitDir;
    } else {
      this.#byCwd.set(cwd, { gitDir, count: 1 });
    }
    if (dirs === null || gitDir === null) return;

    let repo = this.#repos.get(gitDir);
    if (repo === undefined) {
      repo = { watchers: [], cwds: new Set(), timer: null, lastFiredAt: null, failed: false };
      this.#repos.set(gitDir, repo);
      this.#start(gitDir, dirs, repo);
    }
    repo.cwds.add(cwd);
  }

  unwatch(cwd: string): void {
    const known = this.#byCwd.get(cwd);
    if (known === undefined) return;
    known.count -= 1;
    if (known.count > 0) return;
    this.#byCwd.delete(cwd);
    if (known.gitDir === null) return;
    const repo = this.#repos.get(known.gitDir);
    if (repo === undefined) return;
    repo.cwds.delete(cwd);
    if (repo.cwds.size === 0) {
      this.#stop(repo);
      this.#repos.delete(known.gitDir);
    }
  }

  close(): void {
    this.#closed = true;
    for (const repo of this.#repos.values()) this.#stop(repo);
    this.#repos.clear();
    this.#byCwd.clear();
  }

  #start(gitDir: string, dirs: GitDirs, repo: RepoWatch): void {
    const targets = dirs.commonDir === null ? [gitDir] : [gitDir, dirs.commonDir];
    for (const dir of targets) {
      try {
        // `persistent: false` — obserwator gita nie ma prawa trzymać procesu przy życiu.
        const watcher = this.#watchFn(dir, { recursive: true, persistent: false }, (_event, name) => {
          if (typeof name !== 'string' || !isRelevantGitPath(name)) return;
          this.#bump(gitDir, repo);
        });
        watcher.on('error', (error) => { this.#fail(gitDir, repo, error); });
        repo.watchers.push(watcher);
      } catch (error) {
        this.#fail(gitDir, repo, error);
        return;
      }
    }
  }

  /**
   * Planuje odczyt. Zdarzenie, które trafia na ZAPLANOWANY odczyt, dołącza do niego —
   * timera NIE przesuwamy w przód (to jest cała różnica wobec resetującego debounce'u).
   */
  #bump(gitDir: string, repo: RepoWatch): void {
    if (repo.failed || this.#closed) return;
    if (repo.timer !== null) return;
    /*
     * Zwłoka to 750 ms po zdarzeniu ALBO koniec okna 2 s od ostatniego odczytu — co dalej.
     * Pierwszy człon daje zapisom jednego polecenia (`commit` rusza `index`, `HEAD` i `logs/`)
     * jeden wspólny odczyt; drugi jest sufitem tempa dla burzy, która nie chce się skończyć.
     */
    const since = repo.lastFiredAt === null ? Infinity : this.#now() - repo.lastFiredAt;
    const delay = Math.max(this.#debounceMs, this.#minIntervalMs - since);
    const timer = setTimeout(() => {
      repo.timer = null;
      // Repo mogło zostać puszczone w oknie oczekiwania — wtedy nie ma komu mówić.
      if (this.#repos.get(gitDir) !== repo || repo.cwds.size === 0) return;
      repo.lastFiredAt = this.#now();
      this.#onChange([...repo.cwds]);
    }, delay);
    timer.unref();
    repo.timer = timer;
  }

  #fail(gitDir: string, repo: RepoWatch, error: unknown): void {
    if (repo.failed) return;
    repo.failed = true;
    this.#stop(repo);
    this.#onUnavailable?.(gitDir, error);
  }

  #stop(repo: RepoWatch): void {
    if (repo.timer !== null) {
      clearTimeout(repo.timer);
      repo.timer = null;
    }
    const watchers = repo.watchers;
    repo.watchers = [];
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Watcher po `error` bywa już zamknięty — to nie jest awaria.
      }
    }
  }
}
