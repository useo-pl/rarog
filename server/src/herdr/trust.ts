/**
 * Jedno pytanie, jedna odpowiedź: „czy `claude` poprosi w tym katalogu o zaufanie?".
 *
 * Pierwszy `claude` w nieotwieranym katalogu wchodzi w `blocked` z `launch_pending: true`
 * i czeka na odpowiedź w dialogu zaufania (zmierzone: 40 s bez zmiany; ekran: fixture
 * `dialog-trust-2.1.293.txt`). Odpowiedź `false` daje przy starcie ostrzeżenie `trustPrompt`
 * w transkrypcie, nie odmowę.
 *
 * **Tryb snajperski.** `~/.claude.json` według docs (settings) trzyma dane konta, konfigurację serwerów MCP
 * i stan per projekt, w tym decyzje o zaufaniu. Czytamy z niego DOKŁADNIE jedno pole na projekt —
 * `projects[<abs path>].hasTrustDialogAccepted` (nazwa z obserwacji pliku; docs opisują samo zaufanie
 * w permissions, „Project allow rules and workspace trust”) — i nie zwracamy, nie logujemy ani nie zapamiętujemy
 * niczego innego. Wyjątek z `JSON.parse` nigdy nie jest logowany z treścią: komunikaty parsera potrafią zacytować
 * fragment pliku.
 *
 * Rarog tego pliku NIGDY nie zapisuje (`docs/security-model.md`, „Starting sessions from the phone: three powers”).
 */
import { lstat as fsLstat, readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRegularFile } from '../safe-read.ts';

/**
 * Jak długo trzymamy wynik bez parsowania pliku od nowa: pełny odczyt i `JSON.parse` całego `~/.claude.json` przy
 * każdym starcie panelu to koszt bez potrzeby, a zmianę pliku i tak łapie znacznik `mtime:size` (`fileStamp`).
 */
export const TRUST_CACHE_MS = 30_000;

/** Predykat zaufania katalogu — wstrzykiwany do launchera, żeby dało się go zafake'ować. */
export interface TrustCheck {
  /**
   * `true` tylko wtedy, gdy `hasTrustDialogAccepted === true` stoi pod kluczem, którego użyje CLI: korzeń repo
   * (dla worktree główny checkout) w repozytorium, a poza repo ta ścieżka albo jej rodzic.
   */
  isTrusted(cwd: string): Promise<boolean>;
}

/** Wpis `.git` w katalogu: katalog repo, plik z `gitdir` (worktree, submoduł) albo inny rodzaj. */
export type GitEntryKind = 'directory' | 'file' | 'other';

/** Pierwsza linia pliku `.git`: `gitdir: <ścieżka>` (worktree i submoduł, format gita). */
const GITDIR_LINE = /^gitdir: (.+)$/m;

/** `gitdir` worktree: `<główny checkout>/.git/worktrees/<nazwa>`. Inny `gitdir` (submoduł) nie zmienia klucza. */
const WORKTREE_GITDIR = /^(.+)\/\.git\/worktrees\/[^/]+\/?$/;

/** Sufit odczytu pliku `.git`: jedna linia ścieżki. */
const GIT_FILE_MAX_BYTES = 4096;

export interface TrustCheckOptions {
  /** Ścieżka do `~/.claude.json`; wstrzykiwana w testach. */
  claudeJsonPath?: string;
  cacheMs?: number;
  now?: () => number;
  /** Logger dostaje WYŁĄCZNIE stałe komunikaty — nigdy treści pliku ani wyjątku. */
  logger?: (message: string) => void;
  /** I/O wstrzykiwalne, żeby test mógł POLICZYĆ odczyty pliku zamiast zaglądać do modułu. */
  readFile?: (file: string) => Promise<string>;
  /** Znacznik wersji pliku (`mtime:size`); zmiana unieważnia cache przed upływem `cacheMs`. */
  fileStamp?: (file: string) => Promise<string>;
  /** Katalog domowy; jego zaufania CLI nie zapisuje (CLI 2.1.319). */
  home?: string;
  /**
   * Rodzaj wpisu `<dir>/.git` bez podążania za dowiązaniem; `null` = wpisu nie ma (`ENOENT`, `ENOTDIR`). Każdy inny
   * błąd rzuca, a predykat odpowiada wtedy `false` (błąd `stat` to ostrzeżenie, nie odmowa).
   */
  statGit?: (gitPath: string) => Promise<GitEntryKind | null>;
  /** Treść pliku `.git` (worktree, submoduł); `null` = to nie jest plik zwykły. */
  readGitFile?: (gitPath: string) => Promise<string | null>;
}

async function defaultStatGit(gitPath: string): Promise<GitEntryKind | null> {
  try {
    const st = await fsLstat(gitPath);
    if (st.isDirectory()) return 'directory';
    return st.isFile() ? 'file' : 'other';
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

async function defaultReadGitFile(gitPath: string): Promise<string | null> {
  const read = await readRegularFile(gitPath, { maxBytes: GIT_FILE_MAX_BYTES, followSymlink: false });
  return read === null ? null : read.bytes.toString('utf8');
}

/**
 * Klucz zaufania repozytorium, w którym leży `target`, albo `null`, gdy po drodze do korzenia systemu nie ma `.git`.
 *
 * Najbliższy `.git` wyznacza repo, więc repo zagnieżdżone (klon w środku, submoduł) ma własny klucz. Kluczem jest
 * katalog z `.git`, a dla worktree (`.git` jako plik z `gitdir` w `<repo>/.git/worktrees/…`) główny checkout
 * (zmierzone). `.git` innego rodzaju niż katalog i plik (dowiązanie, FIFO) też wyznacza repo z kluczem katalogu:
 * wynik w stronę „niezaufany” kosztuje jedno zdanie ostrzeżenia.
 */
async function repoKeyOf(
  target: string,
  statGit: (gitPath: string) => Promise<GitEntryKind | null>,
  readGitFile: (gitPath: string) => Promise<string | null>,
): Promise<string | null> {
  for (let dir = target; ; dir = path.dirname(dir)) {
    const gitPath = path.join(dir, '.git');
    const kind = await statGit(gitPath);
    if (kind === 'file') {
      const text = await readGitFile(gitPath);
      const gitdir = text === null ? undefined : GITDIR_LINE.exec(text)?.[1]?.trim();
      const main = gitdir === undefined ? undefined : WORKTREE_GITDIR.exec(path.resolve(dir, gitdir))?.[1];
      return main ?? dir;
    }
    if (kind !== null) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Domyślna lokalizacja pliku konfiguracyjnego Claude Code. */
export function defaultClaudeJsonPath(home: string = os.homedir()): string {
  return path.join(home, '.claude.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Surowa treść pliku → zbiór ZAUFANYCH ścieżek.
 *
 * Ze sparsowanego JSON-a wychodzą wyłącznie klucze `projects` (ścieżki katalogów, które Rarog
 * i tak zna z `cwd`) i jedna wartość boolowska na klucz. Reszta obiektu, w tym dane konta i konfiguracja
 * serwerów MCP (docs settings), jest porzucana razem z referencją do niego.
 */
function trustedPathsFrom(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) return out;
  const projects = raw['projects'];
  if (!isRecord(projects)) return out;

  for (const [dir, entry] of Object.entries(projects)) {
    if (!isRecord(entry)) continue;
    if (entry['hasTrustDialogAccepted'] !== true) continue;
    out.add(path.resolve(dir));
  }
  return out;
}

interface CacheEntry {
  trusted: ReadonlySet<string>;
  /** `mtime:size` w chwili odczytu; pusty string = plik był nieczytelny. */
  stamp: string;
  loadedAt: number;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Predykat zaufania z cache'em na proces.
 *
 * Fail-closed w każdej niepewności: brak pliku, uszkodzony JSON, brak wpisu, brak pola →
 * `false`. Porównanie idzie po `path.resolve`, BEZ podążania za symlinkami.
 *
 * Poza repozytorium zaufanie DZIEDZICZY się po katalogu nadrzędnym, tak jak w `claude` (zmierzone na CLI 2.1.299
 * i na 2.1.319): pod zaufanym katalogiem dialogu nie ma, także gdy katalog pośredni ma w pliku
 * `false`. Takie `false` CLI zapisuje samo przy starcie bez dialogu, więc wpis `false` nie zatrzymuje wspinaczki.
 *
 * W repozytorium liczy się WYŁĄCZNIE klucz repo ({@link repoKeyOf}): docs permissions („Project allow rules and
 * workspace trust”) wyłączają z dziedziczenia repo zagnieżdżone w zaufanym katalogu, a pomiar na CLI 2.1.319 pokazał dialog
 * dla nowego repo pod zaufanym rodzicem i zapis klucza korzenia repo przy akceptacji w podkatalogu. Katalog domowy
 * nie jest zaufany nigdy: CLI pyta tam za każdym razem i zaufania nie zapisuje.
 */
export function createTrustCheck(opts: TrustCheckOptions = {}): TrustCheck {
  const file = opts.claudeJsonPath ?? defaultClaudeJsonPath();
  const cacheMs = opts.cacheMs ?? TRUST_CACHE_MS;
  const now = opts.now ?? ((): number => Date.now());
  const log = opts.logger ?? ((): void => {});
  const readFile = opts.readFile ?? (async (f: string): Promise<string> => fsReadFile(f, 'utf8'));
  const fileStamp = opts.fileStamp ?? (async (f: string): Promise<string> => {
    const st = await fsStat(f);
    return `${st.mtimeMs}:${st.size}`;
  });
  const home = path.resolve(opts.home ?? os.homedir());
  const statGit = opts.statGit ?? defaultStatGit;
  const readGitFile = opts.readGitFile ?? defaultReadGitFile;

  let cache: CacheEntry | null = null;
  /** Dedup równoległych wywołań: dwie karty naraz nie mają czytać 210 kB dwa razy. */
  let inFlight: Promise<ReadonlySet<string>> | null = null;

  const load = async (): Promise<ReadonlySet<string>> => {
    const cached = cache;
    if (cached !== null && now() - cached.loadedAt < cacheMs) return cached.trusted;

    let stamp = '';
    try {
      stamp = await fileStamp(file);
    } catch {
      // Brak pliku to normalny stan świeżego konta, a nie awaria — logujemy raz na okno cache.
      log('Failed to read `~/.claude.json` — treating the directory as untrusted.');
      cache = { trusted: EMPTY, stamp: '', loadedAt: now() };
      return EMPTY;
    }

    if (cached !== null && cached.stamp === stamp && stamp !== '') {
      // Plik się nie zmienił — przedłużamy okno bez czytania 210 kB drugi raz.
      cache = { trusted: cached.trusted, stamp, loadedAt: now() };
      return cached.trusted;
    }

    let trusted: ReadonlySet<string>;
    try {
      trusted = trustedPathsFrom(await readFile(file));
    } catch {
      // Świadomie BEZ `err`: komunikat `JSON.parse` cytuje fragment pliku, a plik zawiera
      // klucze `mcpServers`. Logujemy sam fakt.
      log('Failed to read `~/.claude.json` — treating the directory as untrusted.');
      cache = { trusted: EMPTY, stamp, loadedAt: now() };
      return EMPTY;
    }

    cache = { trusted, stamp, loadedAt: now() };
    return trusted;
  };

  return {
    async isTrusted(cwd: string): Promise<boolean> {
      const target = path.resolve(cwd);
      if (inFlight === null) {
        inFlight = load().finally((): void => {
          inFlight = null;
        });
      }
      const trusted = await inFlight;
      if (target === home) return false;
      let repoKey: string | null;
      try {
        repoKey = await repoKeyOf(target, statGit, readGitFile);
      } catch {
        // Stały komunikat bez ścieżki i bez błędu systemowego, jak przy samym pliku.
        log('Failed to look for `.git` — treating the directory as untrusted.');
        return false;
      }
      if (repoKey !== null) return trusted.has(repoKey);
      for (let dir = target; ; dir = path.dirname(dir)) {
        if (trusted.has(dir)) return true;
        if (path.dirname(dir) === dir) return false;
      }
    },
  };
}
