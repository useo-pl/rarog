/**
 * Przeglądarka katalogów dla formularza „Nowa sesja" (`GET /api/fs`).
 *
 * Ten moduł jest READ-ONLY i celowo NIE jest terminalem: nie wykonuje powłoki, nie POKAZUJE
 * symlinków w listingu, nie schodzi poza korzenie z `RAROG_PROJECT_ROOTS` — a granicę
 * korzeni sprawdza także po rozwiązaniu dowiązań. Poziom ostrożności ma być
 * dokładnie taki sam jak w `validateProjectCwd()` — bo listing katalogu jest tą samą klasą
 * wycieku co założenie w nim sesji: mówi, co użytkownik Raroga ma na dysku.
 *
 * Kolejność sprawdzeń jest celowa (najpierw tanie i pewne odrzucenia, dopiero potem dysk):
 * 1. brak `path` → poziom korzeni (żadnego I/O poza znacznikami),
 * 2. tilde rozwinięta, ścieżka MUSI być absolutna,
 * 3. żadnego segmentu ukrytego (`.git`, `.ssh`, …),
 * 4. po `path.resolve` ścieżka musi być korzeniem ALBO leżeć wewnątrz korzenia — to jest
 *    miejsce, w którym umiera `..`,
 * 5. the work area, text only: a macOS-protected folder of home is refused before any disk access,
 * 6. the symlink walk (`resolveInWorkArea`) as the first disk access: a missing segment is 404, a link into an
 *    excluded folder is refused without a read there; the walked path then goes through `realpath` like the roots,
 *    so both sides of the next step carry the letter case stored on disk,
 * 7. przed `readdir` to samo pytanie o korzenie po ROZWIĄZANIU dowiązań — krok 4
 *    porównuje same stringi, więc `?path=<korzeń>/skrót` oddawał listing katalogu spoza
 *    korzeni; filtr `isDirectory()` w wierszach chronił listę, nie parametr żądania; then `stat` (not a
 *    directory → 404) and `readdir` (no permission → an empty list).
 *
 * A guarded folder of home that the folder gate holds closed (`FolderGateError` from the walk or the port) is a 404
 * with the sentence of the folder's state, the status of a path that cannot be read, never an empty listing.
 *
 * A row is shown only for a folder in the work area, so with the root `~` the protected folders of home neither
 * appear nor get the `stat` of their `.git`. The listing of a directory carries `git` and `history` of the
 * directory itself, and `canCreate` when the route gives it; the roots level carries none of them. Creating a
 * directory is `fs-mkdir.ts`, which reuses the parent steps and the row rule below.
 */
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_DIR_ENTRIES } from '@rarog/shared';
import type { DirEntry, DirListing } from '@rarog/shared';
import { type ServerSentence, say } from '@rarog/shared/sentences';
import { expandTilde, isInsideAnyRoot } from './config.ts';
import { type WalkDisk, insideWorkArea, resolveInWorkArea } from './config/work-area.ts';
import { defaultStoreRoot, projectSlug } from './cli-store.ts';
import { DIRECT_DISK, type WorkAreaDisk } from './folder-gate/disk.ts';
import { FolderGateError } from './folder-gate/types.ts';

/** Katalogi, których nigdy nie pokazujemy — szum, nie projekty. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules']);

/** Kod błędu odpowiedzi 400 (kontrakt UI: inline błąd pod polem ścieżki). */
export const PATH_NOT_ALLOWED = 'path-not-allowed';

/** A refused request: 400 `path-not-allowed` or 404 `not-found`, with the sentence for the app. */
export type BrowseRefusal =
  | { ok: false; status: 400; error: typeof PATH_NOT_ALLOWED; sentence: ServerSentence }
  | { ok: false; status: 404; error: 'not-found'; sentence: ServerSentence };

export type BrowseResult = { ok: true; listing: DirListing } | BrowseRefusal;

export interface BrowseOptions {
  /** Korzenie, poza które nie wolno wyjść (`RAROG_PROJECT_ROOTS`). Pusta lista = nic nie wolno. */
  roots: readonly string[];
  /** Korzeń magazynu CLI — po nim liczymy znacznik `historia`. Domyślnie `~/.claude/projects`. */
  storeRoot?: string;
  home?: string;
  maxEntries?: number;
  /** The disk calls of the symlink walk; tests record them. */
  walk?: WalkDisk;
  /** The disk of every other call in the work area: `realpath`, `stat`, `readdir` and the `.git` marker. */
  disk?: WorkAreaDisk;
  /**
   * `canCreate` of a directory listing: whether this server creates directories (`mkdirRefusal` of `fs-mkdir.ts`,
   * decided by the route). Left out when not given; the roots level never carries it.
   */
  canCreate?: boolean;
}

/**
 * A directory that passed every parent check: `dir` is the lexical path (the form the contract carries), `realDir`
 * the same directory on disk from `realpath`; the roots and home come in both forms, for the work-area question.
 */
export interface ListedDir {
  ok: true;
  dir: string;
  realDir: string;
  roots: readonly string[];
  realRoots: readonly string[];
  home: string;
  realHome: string;
}

function deny(sentence: ServerSentence): BrowseRefusal {
  return { ok: false, status: 400, error: PATH_NOT_ALLOWED, sentence };
}

/** A closed guarded folder: the status of a path that cannot be read, with the sentence of the folder's state. */
function closedFolder(error: FolderGateError): BrowseRefusal {
  return { ok: false, status: 404, error: 'not-found', sentence: error.sentence };
}

/** The value of a port call, or the refusal of a closed folder; any other error gives `fallback`. */
async function orClosed<T, F>(call: Promise<T>, fallback: F): Promise<T | F | FolderGateError> {
  return call.catch((error: unknown) => (error instanceof FolderGateError ? error : fallback));
}

/** Czy katalog istnieje? Każdy błąd (ENOENT, EACCES, ELOOP) znaczy „nie ma znacznika". */
async function exists(candidate: string, disk: WorkAreaDisk): Promise<boolean> {
  try {
    await disk.call('stat', { path: candidate });
    return true;
  } catch {
    return false;
  }
}

/** The same question in the CLI store under `~/.claude`, which never lies in the work area. */
async function inStore(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Znaczniki wiersza: repo gita i historia sesji CLI dla tego katalogu. */
async function markers(
  dir: string, storeRoot: string, disk: WorkAreaDisk,
): Promise<{ git: boolean; history: boolean }> {
  const [git, history] = await Promise.all([
    exists(path.join(dir, '.git'), disk),
    inStore(path.join(storeRoot, projectSlug(dir))),
  ]);
  return { git, history };
}

export async function toEntry(
  dir: string, name: string, storeRoot: string, disk: WorkAreaDisk = DIRECT_DISK,
): Promise<DirEntry> {
  return { name, path: dir, ...await markers(dir, storeRoot, disk) };
}

async function toEntries(
  dirs: readonly string[], storeRoot: string, disk: WorkAreaDisk,
): Promise<DirEntry[]> {
  // Podkatalogi jednego katalogu mają z definicji unikalne nazwy — tu basename WYSTARCZA
  // i ujednoznacznianie z `rootNames()` byłoby tylko szumem („willow" → „Projects/willow").
  return Promise.all(dirs.map((dir) => toEntry(dir, path.basename(dir), storeRoot, disk)));
}

/**
 * Nazwy korzeni — jedyne miejsce, w którym basename może się POWTÓRZYĆ.
 *
 * Dwa korzenie `RAROG_PROJECT_ROOTS` o tym samym basename (np. `~/Projects`
 * i `~/Documents/Projects`) dałyby w dropdownie dwie pozycje „Projects" nie do odróżnienia —
 * użytkownik zgadywałby, w który wejść. Przy kolizji dokładamy segment
 * rodzica („Documents/Projects"); gdy i to nie wystarcza (`/x/a/P` vs `/y/a/P`), zostaje pełna
 * ścieżka — brzydka, ale zawsze jednoznaczna. Bez zmiany protokołu: mieści się w polu `name`.
 */
function rootNames(roots: readonly string[]): string[] {
  const count = (names: readonly string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const name of names) map.set(name, (map.get(name) ?? 0) + 1);
    return map;
  };
  const base = roots.map((root) => path.basename(root));
  const baseCount = count(base);
  const twoSegments = roots.map((root, index) => {
    const name = base[index] ?? '';
    if ((baseCount.get(name) ?? 0) < 2) return name;
    const parent = path.basename(path.dirname(root));
    return parent === '' ? root : `${parent}/${name}`;
  });
  const twoCount = count(twoSegments);
  return twoSegments.map((name, index) => (
    (twoCount.get(name) ?? 0) < 2 ? name : roots[index] ?? name
  ));
}

/**
 * Poziom korzeni — `path: null`.
 *
 * Kolejność jest ta z konfiguracji, a nie alfabetyczna: korzenie wpisuje człowiek i to ON
 * decyduje, co jest pierwsze. Duplikaty odsiewamy po ścieżce.
 */
async function rootListing(
  roots: readonly string[], storeRoot: string, disk: WorkAreaDisk,
): Promise<DirListing> {
  const unique = [...new Set(roots.map((root) => path.resolve(root)))];
  const names = rootNames(unique);
  return {
    path: null,
    parent: null,
    entries: await Promise.all(
      unique.map((dir, index) => toEntry(dir, names[index] ?? path.basename(dir), storeRoot, disk)),
    ),
    truncated: false,
  };
}

/**
 * The parent steps of a listing (steps 2 to 7 of the module header up to `stat`): the path as given, no trim, so
 * an empty string is refused as not absolute. Returns the directory in both forms or the refusal to send.
 */
export async function resolveListedDir(
  raw: string, opts: Pick<BrowseOptions, 'roots' | 'home' | 'walk' | 'disk'>,
): Promise<ListedDir | BrowseRefusal> {
  const home = opts.home ?? os.homedir();
  const disk = opts.disk ?? DIRECT_DISK;
  const roots = opts.roots.map((root) => path.resolve(expandTilde(root, home)));

  const expanded = expandTilde(raw, home);
  if (!path.isAbsolute(expanded)) {
    return deny(say('rest.cwd-not-absolute'));
  }
  const dir = path.resolve(expanded);
  const hidden = dir.split(path.sep).some((segment) => segment.startsWith('.') && segment !== '.');
  if (hidden) return deny(say('rest.cwd-hidden'));
  // `isInsideAnyRoot` przepuszcza też sam korzeń, więc jedno sprawdzenie załatwia oba przypadki
  // ze speca („równa korzeniowi ALBO wewnątrz"). Pusta lista korzeni = nic nie przechodzi.
  if (!isInsideAnyRoot(dir, roots)) {
    return deny(say('rest.cwd-outside-roots'));
  }
  if (!insideWorkArea(dir, roots, home)) return deny(say('rest.cwd-protected'));

  /*
   * Granica po raz drugi, tym razem po fizycznej stronie dysku. `stat` PODĄŻA za dowiązaniem,
   * więc sam z siebie potwierdzał tylko, że cel istnieje i jest katalogiem — nie że
   * leży w korzeniach. Korzenie rozwiązujemy tak samo, bo inaczej korzeń będący dowiązaniem
   * (klasyk: `/tmp` na macOS) odcinałby własne, legalne podkatalogi. The directory itself is resolved by the walk,
   * one segment at a time, which stops before an excluded folder; only home and the roots go through `realpath`.
   */
  const realHome = await disk.call('realpathNative', { path: home }).catch(() => home);
  const realRoots = await Promise.all(
    roots.map(async (root) => disk.call('realpathNative', { path: root }).catch(() => root)),
  );
  const walked = resolveInWorkArea(dir, realRoots, realHome, opts.walk);
  if (walked.kind === 'missing') {
    return { ok: false, status: 404, error: 'not-found', sentence: say('rest.cwd-not-found') };
  }
  if (walked.kind === 'excluded') {
    return walked.closed === undefined ? deny(say('rest.cwd-symlink-escape')) : closedFolder(walked.closed);
  }
  /*
   * The walk keeps the letter case of the request, while `realpath` gives the roots in the case stored on disk, so on
   * the default macOS disk a root written in another case refused its own folders. The walked path has no symlink
   * left and no excluded folder on it, so the same `realpath` as for the roots reads nothing new and gives the case
   * the comparison needs.
   */
  const realDir = await orClosed(disk.call('realpathNative', { path: walked.path }), null);
  if (realDir instanceof FolderGateError) return closedFolder(realDir);
  if (realDir === null) {
    return { ok: false, status: 404, error: 'not-found', sentence: say('rest.cwd-not-found') };
  }
  if (!isInsideAnyRoot(realDir, realRoots) || !insideWorkArea(realDir, realRoots, realHome)) {
    return deny(say('rest.cwd-symlink-escape'));
  }
  // Hidden segments at any depth below the resolved root, the rule of `validateProjectCwd`.
  const viaHidden = realRoots.every((root) => {
    const relative = path.relative(root, realDir);
    return relative.startsWith('..') || path.isAbsolute(relative)
      || relative.split(path.sep).some((segment) => segment.startsWith('.') && segment !== '.');
  });
  if (viaHidden) return deny(say('rest.cwd-hidden'));

  return { ok: true, dir, realDir, roots, realRoots, home, realHome };
}

/**
 * Whether a child name of a resolved directory is a row of its listing: no leading dot, not a skipped folder, and
 * inside the work area. The work area as written and on disk: a root that is a symlink to home names its folders
 * with another prefix. Text only, no disk access.
 */
export function isListedChild(ctx: ListedDir, name: string): boolean {
  return !name.startsWith('.') && !SKIPPED_DIRS.has(name)
    && insideWorkArea(path.join(ctx.dir, name), ctx.roots, ctx.home)
    && insideWorkArea(path.join(ctx.realDir, name), ctx.realRoots, ctx.realHome);
}

/**
 * Listuje katalog dla przeglądarki „Nowa sesja".
 *
 * @param rawPath ścieżka z requestu (`?path=`); `null` / pusta = poziom korzeni.
 * @returns listing albo gotowy do odesłania błąd 400/404 (z komunikatem po polsku).
 */
export async function browseDirectory(
  rawPath: string | null, opts: BrowseOptions,
): Promise<BrowseResult> {
  const home = opts.home ?? os.homedir();
  const storeRoot = opts.storeRoot ?? defaultStoreRoot();
  const maxEntries = opts.maxEntries ?? MAX_DIR_ENTRIES;
  const disk = opts.disk ?? DIRECT_DISK;
  const roots = opts.roots.map((root) => path.resolve(expandTilde(root, home)));

  const raw = (rawPath ?? '').trim();
  if (raw === '') return { ok: true, listing: await rootListing(roots, storeRoot, disk) };

  const ctx = await resolveListedDir(raw, opts);
  if (!ctx.ok) return ctx;
  const { dir, realDir } = ctx;

  const info = await orClosed(disk.call('stat', { path: realDir }), null);
  if (info instanceof FolderGateError) return closedFolder(info);
  if (info === null || !info.isDirectory()) {
    return { ok: false, status: 404, error: 'not-found', sentence: say('rest.cwd-not-found') };
  }

  // Brak uprawnień do odczytu katalogu NIE jest błędem żądania: użytkownik ma zobaczyć pusty
  // katalog i móc się z niego cofnąć, a nie czerwony komunikat. A closed guarded folder is a refusal.
  const dirents = await orClosed(disk.call('readdir', { path: dir, encoding: 'utf8' }), []);
  if (dirents instanceof FolderGateError) return closedFolder(dirents);
  const names = dirents
    // `isDirectory()` jest fałszem dla dowiązania — symlinków świadomie NIE rozwijamy, bo
    // dowiązanie do `/` wyprowadziłoby przeglądarkę poza korzenie jednym tapnięciem.
    .filter((entry) => entry.isDirectory())
    .map((entry) => String(entry.name))
    .filter((name) => isListedChild(ctx, name))
    .sort((a, b) => a.localeCompare(b, 'pl', { sensitivity: 'base' }));

  const truncated = names.length > maxEntries;
  const shown = truncated ? names.slice(0, maxEntries) : names;
  const isRoot = roots.some((root) => root === dir);
  return {
    ok: true,
    listing: {
      path: dir,
      // Korzeń → `null`: cofnięcie wraca na poziom korzeni, a nie do katalogu nad korzeniem.
      parent: isRoot ? null : path.dirname(dir),
      ...await markers(dir, storeRoot, disk),
      ...(opts.canCreate === undefined ? {} : { canCreate: opts.canCreate }),
      entries: await toEntries(shown.map((name) => path.join(dir, name)), storeRoot, disk),
      truncated,
    },
  };
}

/**
 * Listing dla trybu demo — bez ANI JEDNEGO dotknięcia dysku.
 *
 * Demo jeździ na ścieżkach, które nie istnieją (`/Users/demo/Projects/...`), więc prawdziwy
 * `readdir` dałby 404 na każdym kroku. Korzeniami są tu projekty demo; wejście w projekt
 * pokazuje pustą listę („Brak podkatalogów — możesz uruchomić sesję tutaj").
 */
export function demoListing(
  rawPath: string | null, projects: readonly { path: string; name: string }[],
): BrowseResult {
  const raw = (rawPath ?? '').trim();
  if (raw === '') {
    return {
      ok: true,
      listing: {
        path: null,
        parent: null,
        entries: projects.map((project) => ({
          name: project.name, path: project.path, git: true, history: true,
        })),
        truncated: false,
      },
    };
  }
  const dir = path.resolve(expandTilde(raw));
  const known = projects.some((project) => path.resolve(project.path) === dir);
  if (!known) {
    return {
      ok: false, status: 400, error: PATH_NOT_ALLOWED,
      sentence: say('rest.cwd-not-in-projects'),
    };
  }
  // The demo creates no directories (`mkdirRefusal`), so a project listing says so.
  return {
    ok: true,
    listing: { path: dir, parent: null, git: true, history: true, canCreate: false, entries: [], truncated: false },
  };
}
