/**
 * Project roots (`RAROG_PROJECT_ROOTS`, `RAROG_HERDR_ROOTS`, `RAROG_YOLO_ROOTS`) and the working directory check
 * that every caller uses before Rarog runs anything in a directory. `loadConfig` (`server/src/config.ts`) passes in
 * the values it read through `readEnv`.
 */
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ServerSentence, say } from '@rarog/shared/sentences';
import { ConfigError, HERDR_ROOTS_ENV, PROJECT_ROOTS_ENV } from '../config-env.ts';
import { type WalkDisk, insideWorkArea, isExcludedPath, resolveInWorkArea } from './work-area.ts';

// ---------------------------------------------------------------------------
// Korzenie projektów i walidacja cwd
// ---------------------------------------------------------------------------

/**
 * Rozwija `~` / `~/…` do katalogu domowego. Sam `~user` NIE jest obsługiwany —
 * Rarog chodzi na koncie jednego człowieka, a zgadywanie cudzych home'ów byłoby furtką.
 */
export function expandTilde(input: string, home: string = os.homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  return input;
}

/** Parsuje `RAROG_PROJECT_ROOTS`; brak wartości = `~/Projects`. */
export function parseProjectRoots(
  raw: string | undefined, home: string = os.homedir(),
): readonly string[] {
  const fallback = [path.join(home, 'Projects')];
  if (raw === undefined || raw.trim() === '') return fallback;
  const roots = raw.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => path.resolve(expandTilde(entry, home)));
  if (roots.length === 0) {
    throw new ConfigError(`${PROJECT_ROOTS_ENV} contains no valid path.`);
  }
  return roots;
}

/**
 * Parsuje `RAROG_HERDR_ROOTS`; brak wartości = korzenie projektów.
 *
 * Domyślna równość z `RAROG_PROJECT_ROOTS` jest celowa: zakres paneli ma być opt-in, ale nie
 * ma powodu, żeby człowiek, który wskazał Rarogowi swoje projekty, musiał je wskazywać drugi raz.
 */
export function parseHerdrRoots(
  raw: string | undefined, projectRoots: readonly string[], home: string = os.homedir(),
): readonly string[] {
  if (raw === undefined || raw.trim() === '') return projectRoots;
  const roots = raw.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => path.resolve(expandTilde(entry, home)));
  if (roots.length === 0) {
    throw new ConfigError(`${HERDR_ROOTS_ENV} contains no valid path.`);
  }
  return roots;
}

/**
 * Parsuje `RAROG_YOLO_ROOTS`. Brak wartości = PUSTA lista (fail-closed): tryb bez pytania
 * o zgodę musi być włączony świadomie, per katalog, a nie „domyślnie gdziekolwiek".
 */
export function parseYoloRoots(
  raw: string | undefined, home: string = os.homedir(),
): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => path.resolve(expandTilde(entry, home)));
}

/** Wynik walidacji katalogu roboczego — zdanie jest gotowe do pokazania użytkownikowi (400 `cwd-not-allowed`). */
export type CwdCheck =
  | { ok: true; cwd: string }
  | { ok: false; sentence: ServerSentence };

export interface CwdCheckOptions {
  /** Wstrzykiwalny test „to istniejący katalog" (testy nie dotykają dysku). */
  isDirectory?: (candidate: string) => boolean;
  /**
   * Wstrzykiwalne rozwiązywanie dowiązań. Rzucenie = „nie da się rozwiązać" i ścieżka odpada.
   * Testy na ścieżkach zmyślonych podają tożsamość; produkcja nigdy tego nie podaje.
   */
  realPath?: (candidate: string) => string;
  home?: string;
  /** The disk calls of the symlink walk (`resolveInWorkArea`); tests record them. Unused with `realPath`. */
  walk?: WalkDisk;
}

/** Czy `candidate` leży wewnątrz `root` (albo nim jest)? Porównanie po segmentach ścieżki. */
function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Czy ABSOLUTNA ścieżka leży w którymkolwiek z korzeni? Pusta lista = nigdzie (fail-closed).
 *
 * Wejście nie-absolutne odrzucamy tu jawnie: `path.relative()` rozwiązałoby je względem cwd
 * PROCESU, więc `.` „leżałoby" w katalogu, z którego przypadkiem wystartował serwer.
 */
export function isInsideAnyRoot(candidate: string, roots: readonly string[]): boolean {
  if (!path.isAbsolute(candidate)) return false;
  return roots.some((root) => isInside(candidate, root));
}

function realIsDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * To samo pytanie co `isInsideAnyRoot`, ale po ROZWIĄZANIU dowiązań — po obu stronach.
 *
 * `isInsideAnyRoot` porównuje same stringi, więc `<korzeń>/skrót -> /gdziekolwiek` przechodził
 * jako „w korzeniu", choć fizycznie leżał poza nim; `statSync` tego nie łapało, bo PODĄŻA za
 * dowiązaniem. Korzenie rozwiązujemy tak samo, inaczej porównywalibyśmy ścieżkę
 * fizyczną z leksykalną — a na macOS wystarczy korzeń w `/tmp` (dowiązanie do `/private/tmp`)
 * albo katalog na wolumenie z dowiązanym punktem montowania, żeby odciąć legalny projekt.
 *
 * Wynik jest KONIUNKCJĄ z `isInsideAnyRoot`: granica ma się wyłącznie zacieśniać. Ścieżka
 * leksykalnie spoza korzeni nie przechodzi nawet wtedy, gdy rozwiązuje się do środka —
 * użytkownik ma widzieć w polu tę ścieżkę, którą wpisał, a nie jej fizyczny odpowiednik.
 *
 * Fail-closed: kandydat, którego nie da się rozwiązać (ENOENT, ELOOP, brak `x` na katalogu
 * nadrzędnym), odpada. Korzeń, którego nie da się rozwiązać, zostaje w postaci leksykalnej —
 * nieistniejący korzeń nie może rozszerzać granicy, więc jego „zawężenie" byłoby tylko szumem.
 */
export function isInsideAnyRootReal(
  candidate: string,
  roots: readonly string[],
  realPath: (path: string) => string = realpathSync,
): boolean {
  if (!isInsideAnyRoot(candidate, roots)) return false;
  let resolved: string;
  try {
    resolved = realPath(candidate);
  } catch {
    return false;
  }
  const resolvedRoots = roots.map((root) => {
    try {
      return realPath(root);
    } catch {
      return root;
    }
  });
  return isInsideAnyRoot(resolved, resolvedRoots);
}

/** Czy segment ścieżki jest katalogiem ukrytym (`.git`, `.ssh`, `.cache`…). */
function isHiddenSegment(segment: string): boolean {
  return segment.startsWith('.') && segment !== '.';
}

/**
 * Czy ścieżka FIZYCZNA (po `realpath`) schodzi przez katalog ukryty PONIŻEJ korzenia.
 *
 * Reguła „bez katalogów ukrytych" była sprawdzana wyłącznie leksykalnie, a granica korzeni —
 * po `realpath`. Dziura była dokładnie w tej szczelinie: `<korzeń>/skrót -> <korzeń>/.git`
 * przechodził (leksykalnie żaden segment nie zaczyna się od kropki, fizycznie nadal jest
 * w korzeniu), więc dowiązanie w projekcie oddawało `cwd` na `.git`, `.ssh` czy `.aws`
 * KAŻDEMU wołającemu tej bramki — nie tylko terminalowi.
 *
 * Liczymy segmenty dopiero POD rozwiązanym korzeniem, a nie na całej ścieżce fizycznej:
 * korzeń użytkownika wolno trzymać pod katalogiem ukrytym (`~/.local/kod`, wolumen
 * z dowiązanym punktem montowania), a to jest jego świadoma decyzja z konfiguracji,
 * nie ścieżka podana w żądaniu.
 *
 * `resolved` is the candidate's on-disk path, `realRoots` the roots in on-disk form.
 */
function realPathEntersHidden(resolved: string, realRoots: readonly string[]): boolean {
  for (const resolvedRoot of realRoots) {
    if (!isInside(resolved, resolvedRoot)) continue;
    const relative = path.relative(resolvedRoot, resolved);
    if (!relative.split(path.sep).some(isHiddenSegment)) return false;
  }
  return true;
}

/**
 * Waliduje katalog roboczy podany przez użytkownika (dropdown albo pole „inna ścieżka…").
 *
 * Kolejność jest celowa — najpierw tanie i pewne odrzucenia, dopiero na końcu dysk:
 * 1. tilde rozwijamy (`~`, `~/…`; `~user` NIE jest rozwijane i dlatego odpada w kroku 2),
 * 2. ścieżka musi być JUŻ absolutna — `path.resolve` na wejściu względnym dokleiłby cwd
 *    procesu serwera, więc `.`, `..` czy `../../etc` przechodziłyby jako „katalog w projekcie",
 * 3. odrzucamy segmenty ukryte (`.git`, `.ssh`, `node_modules/.cache`…),
 * 4. ścieżka musi leżeć wewnątrz któregoś korzenia (pusta lista = nic nie przechodzi),
 * 5. the work area, still text only: a macOS-protected folder of home is refused unless a root lies in it
 *    (`config/work-area.ts`); a read there makes macOS ask for access, and this check is synchronous,
 * 6. the symlink walk (`resolveInWorkArea`) as the first disk access: it stops before an excluded folder, so
 *    `<root>/link -> ~/Desktop/x` is refused without a read in `Desktop`; a missing segment is "not found",
 * 7. musi istnieć i być katalogiem,
 * 8. i dopiero teraz to samo pytanie po ROZWIĄZANIU dowiązań — kroki 4 i 7 same
 *    przepuszczały `<korzeń>/skrót -> /gdziekolwiek`; the resolved path must also lie outside the excluded folders,
 * 9. oraz — z tego samego powodu — pytanie o segmenty ukryte na ścieżce FIZYCZNEJ:
 *    krok 3 patrzy leksykalnie, więc `<korzeń>/skrót -> <korzeń>/.git` mu umyka
 *    (szczegóły przy `realPathEntersHidden`).
 *
 * With `opts.realPath` (tests on made-up paths) step 6 is skipped and the candidate resolves through it after step 7.
 *
 * Krok 2 jest tu, a nie tylko w `checkCwd()` (router), bo ta funkcja jest DRUGĄ linią obrony
 * (`manager.#assertAllowedCwd`) i musi być fail-closed sama z siebie — inaczej pierwszy nowy
 * wołający przywróciłby fail-open.
 *
 * Zwracamy ścieżkę LEKSYKALNĄ, nie rozwiązaną — świadomie. Od zwróconego stringa zależy
 * `projectSlug`, rejestr paneli i porównania w `#assertResumable`, więc podmiana go na wersję
 * fizyczną rozjechałaby historię sesji istniejących projektów. Rozwiązywanie jest tu
 * WYŁĄCZNIE pytaniem o granicę, nie normalizacją.
 */
export function validateProjectCwd(
  input: string, roots: readonly string[], opts: CwdCheckOptions = {},
): CwdCheck {
  const home = opts.home ?? os.homedir();
  const isDirectory = opts.isDirectory ?? realIsDirectory;

  const raw = input.trim();
  if (raw === '') return { ok: false, sentence: say('rest.cwd-empty') };

  const expanded = expandTilde(raw, home);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, sentence: say('rest.cwd-not-absolute') };
  }

  const cwd = path.resolve(expanded);
  if (cwd.split(path.sep).some(isHiddenSegment)) {
    return { ok: false, sentence: say('rest.cwd-hidden') };
  }
  if (roots.length === 0) {
    return { ok: false, sentence: say('rest.cwd-not-in-projects') };
  }
  if (!isInsideAnyRoot(cwd, roots)) {
    return {
      ok: false,
      sentence: say('rest.cwd-outside-roots.listed', { roots: roots.join(', ') }),
    };
  }
  if (!insideWorkArea(cwd, roots, home)) {
    return { ok: false, sentence: say('rest.cwd-protected') };
  }
  const resolveOne = opts.realPath ?? realpathSync;
  const onDisk = (entry: string): string => {
    try {
      return resolveOne(entry);
    } catch {
      return entry;
    }
  };
  // Roots and home in on-disk form: only they are resolved here, never a folder inside them.
  const realRoots = roots.map(onDisk);
  const realHome = onDisk(home);
  let resolved: string | null = null;
  if (opts.realPath === undefined) {
    const walked = resolveInWorkArea(cwd, realRoots, realHome, opts.walk);
    if (walked.kind === 'missing') return { ok: false, sentence: say('rest.cwd-not-found') };
    if (walked.kind === 'excluded') return { ok: false, sentence: say('rest.cwd-symlink-escape') };
    resolved = walked.path;
  }
  if (!isDirectory(cwd)) {
    return { ok: false, sentence: say('rest.cwd-not-found') };
  }
  if (resolved === null) {
    try {
      resolved = opts.realPath === undefined ? realpathSync(cwd) : opts.realPath(cwd);
    } catch {
      return { ok: false, sentence: say('rest.cwd-symlink-escape') };
    }
  }
  if (!isInsideAnyRoot(resolved, realRoots) || isExcludedPath(resolved, realRoots, realHome)) {
    return { ok: false, sentence: say('rest.cwd-symlink-escape') };
  }
  if (realPathEntersHidden(resolved, realRoots)) {
    return { ok: false, sentence: say('rest.cwd-hidden') };
  }
  return { ok: true, cwd };
}
