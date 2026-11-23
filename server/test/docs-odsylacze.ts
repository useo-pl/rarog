/**
 * Odsyłacze do plików w widoku eksportu i sprawdzenie, że prowadzą do istniejącego pliku. Mechanizm strażnika
 * `docs-odsylacze.test.ts`: zmiana nazwy albo usunięcie dokumentu bez poprawki odsyłaczy nie może zostawić martwej
 * ścieżki po cichu. Cytowanie sekcji (ścieżka i tytuł) pilnuje osobno `docs-sekcje-cytowane.test.ts`.
 *
 * Odsyłacz ma dwie formy:
 * - goła ścieżka `*.md` w dowolnym pliku (wzorzec {@link MD_PATH} strażnika cytowań, z backtickami albo bez);
 * - odnośnik względny Markdown `[tekst](cel)` albo obrazek `![opis](cel)` w dokumencie `.md`, poza blokami kodu
 *   i poza `` `…` ``; cel bez schematu (`https:`, `mailto:`) i bez samego `#kotwica`, kotwica i zapytanie odcięte.
 * W pliku testu liczą się tylko linie komentarza (`scanned` strażnika cytowań): napisy w testach to dane.
 *
 * Rozwiązanie: goła ścieżka jak w strażniku cytowań (`resolveDoc`: w `.md` od katalogu dokumentu, potem od korzenia;
 * w kodzie od korzenia), odnośnik od katalogu dokumentu (tak go otwiera GitHub), `/cel` od korzenia. Odnośnik może
 * wskazywać katalog.
 *
 * Bez sprawdzenia zostaje (każda pozycja ma powód w {@link brokenReference}): plik warstwy prywatnej (pilnują go
 * zapadki odsyłaczy widoku eksportu), a dla gołej ścieżki także strona dokumentacji Claude Code (`CLAUDE_CODE_DOCS`),
 * nazwa pliku spoza repo bez katalogu ({@link FOREIGN_NAMES}) i ścieżka, której katalog nie jest katalogiem widoku
 * eksportu w żadnym odczytaniu (katalog użytkownika `.claude/skills/…`, adres bez schematu). Odnośnik względny
 * zawsze celuje w repo, więc musi istnieć. Reszta też.
 */
import { posix } from 'node:path';
import { CLAUDE_CODE_DOCS, MD_PATH, resolveDoc, scanned } from './docs-sekcje-cytowane.ts';

export interface Reference {
  /** Plik z odsyłaczem (względem korzenia repo). */
  readonly file: string;
  /** Linia (od 1). */
  readonly line: number;
  /** Cel dosłownie (ścieżka bez backticków albo cel odnośnika). */
  readonly raw: string;
  readonly kind: 'sciezka' | 'odnosnik';
}

/**
 * Nazwy plików spoza repo, które kod i dokumenty wymieniają bez katalogu: pliki pamięci i skilli Claude Code
 * w projekcie użytkownika, pliki licencji i zmian w paczkach.
 */
export const FOREIGN_NAMES: ReadonlySet<string> = new Set([
  'AGENTS.md', 'CHANGELOG.md', 'CLAUDE.local.md', 'LICENSE.md', 'NOTICE.md', 'SKILL.md',
]);

const PATH_RE = new RegExp(MD_PATH, 'dg');
/** Odnośnik albo obrazek: grupa 1 to cel (bez spacji), opcjonalny tytuł w cudzysłowie po spacji. */
const LINK_RE = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/dg;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** Odsyłacze w treści pliku `file` (w pliku testu tylko w liniach komentarza). */
export function references(file: string, text: string): Reference[] {
  const out: Reference[] = [];
  const markdown = file.endsWith('.md');
  let fence: string | null = null;
  scanned(file, text).split('\n').forEach((line, index) => {
    let inFence = false;
    if (markdown) {
      const mark = FENCE.exec(line)?.[1];
      if (fence !== null) {
        inFence = true;
        const closes = mark !== undefined && mark[0] === fence[0] && mark.length >= fence.length;
        if (closes && line.trim() === mark) fence = null;
      } else if (mark !== undefined) {
        fence = mark;
        inFence = true;
      }
    }
    /** Zakresy celów odnośników w linii: goła ścieżka w nich to ten sam odsyłacz. */
    const taken: [number, number][] = [];
    if (markdown && !inFence) {
      const plain = line.replace(/`[^`]*`/g, (code) => ' '.repeat(code.length));
      for (const hit of plain.matchAll(LINK_RE)) {
        const span = hit.indices?.[1] ?? [0, 0];
        taken.push(span);
        out.push({ file, line: index + 1, raw: hit[1] ?? '', kind: 'odnosnik' });
      }
    }
    for (const hit of line.matchAll(PATH_RE)) {
      const [from] = hit.indices?.[1] ?? [0];
      if (taken.some(([start, end]) => from >= start && from < end)) continue;
      out.push({ file, line: index + 1, raw: hit[1] ?? '', kind: 'sciezka' });
    }
  });
  return out;
}

export interface Tree {
  /** Plik (ścieżka od korzenia) jest w widoku eksportu. */
  readonly exists: (file: string) => boolean;
  /** Katalog (ścieżka od korzenia, `''` = korzeń) ma pliki widoku eksportu. */
  readonly isDir: (dir: string) => boolean;
  /** Plik leży w warstwie prywatnej repo źródłowego (w eksporcie zbiór pusty). */
  readonly isPrivate: (file: string) => boolean;
}

const SCHEME = /^(?:[a-z][\w+.-]*:|\/\/)/i;
const parent = (file: string): string => {
  const dir = posix.dirname(file);
  return dir === '.' ? '' : dir;
};

/** Odczytania odsyłacza jako ścieżki od korzenia, w kolejności pierwszeństwa. */
function readings(ref: Reference, tree: Tree): string[] {
  if (ref.kind === 'odnosnik') {
    const target = ref.raw.replace(/[#?].*$/, '');
    if (target.startsWith('/')) return [posix.normalize(target.slice(1))];
    return [posix.normalize(posix.join(parent(ref.file), target))];
  }
  const resolved = resolveDoc(ref.file, ref.raw, tree.exists);
  const local = posix.normalize(posix.join(parent(ref.file), ref.raw));
  return ref.file.endsWith('.md') && local !== resolved ? [resolved, local] : [resolved];
}

/** Odczytania bez końcowego `/`; `.` (korzeń repo po normalizacji, np. `../` z `docs/`) to `''`, jak w {@link Tree}. */
function targets(ref: Reference, tree: Tree): string[] {
  return readings(ref, tree).map((target) => target.replace(/\/$/, '')).map((target) => (target === '.' ? '' : target));
}

/**
 * Odsyłacz celuje w to repo, gdy goła nazwa pliku (bez `/`) albo gdy w którymś odczytaniu istnieje katalog, który
 * wnosi SAMA ścieżka odsyłacza: brakujący podkatalog istniejącego katalogu też się liczy. Katalog dokumentu, od
 * którego liczy się odczytanie lokalne, się nie liczy, bo istnieje zawsze (adres bez schematu w dokumencie z `docs/`
 * to nie ścieżka repo). Inaczej to ścieżka u użytkownika albo w innym repo.
 */
function inRepo(ref: Reference, tree: Tree): boolean {
  if (!ref.raw.includes('/')) return true;
  const bases = ref.file.endsWith('.md') ? ['', parent(ref.file)] : [''];
  return bases.some((base) => {
    const target = posix.normalize(posix.join(base, ref.raw));
    if (target.startsWith('..')) return false;
    for (let dir = parent(target); dir !== ''; dir = parent(dir)) {
      if (dir === base || base.startsWith(`${dir}/`)) break;
      if (tree.isDir(dir)) return true;
    }
    return false;
  });
}

/** Istniejący plik albo katalog (odnośnik), do którego prowadzi odsyłacz; `null`, gdy takiego nie ma. */
export function resolvesTo(ref: Reference, tree: Tree): string | null {
  if (ref.kind === 'odnosnik' && (SCHEME.test(ref.raw) || ref.raw.startsWith('#'))) return null;
  const paths = targets(ref, tree);
  return paths.find((target) => tree.exists(target) || (ref.kind === 'odnosnik' && tree.isDir(target))) ?? null;
}

/** Odsyłacz sprawdzany: `null` = istnieje albo jest poza sprawdzeniem; inaczej `plik:linia: opis`. */
export function brokenReference(ref: Reference, tree: Tree): string | null {
  if (ref.kind === 'odnosnik' && (SCHEME.test(ref.raw) || ref.raw.startsWith('#'))) return null;
  if (resolvesTo(ref, tree) !== null) return null;
  const paths = targets(ref, tree);
  // Plik warstwy prywatnej: odsyłacz liczą zapadki widoku eksportu, w eksporcie bramka wymaga zera.
  if (paths.some((target) => tree.isPrivate(target))) return null;
  const where = `${ref.file}:${String(ref.line)}`;
  if (ref.kind === 'odnosnik') {
    return `${where}: odnośnik (${ref.raw}) prowadzi do ${paths[0] ?? ''}, a takiego pliku ani katalogu nie ma`;
  }
  if (CLAUDE_CODE_DOCS.has(posix.normalize(ref.raw))) return null;
  if (!ref.raw.includes('/') && FOREIGN_NAMES.has(ref.raw)) return null;
  // Żadne odczytanie nie leży w tym repo: ścieżka u użytkownika albo w innym repo.
  if (!inRepo(ref, tree)) return null;
  return `${where}: ${ref.raw} — nie ma takiego pliku (ścieżka od korzenia repo, w dokumencie .md także od jego katalogu)`;
}

/** Odsyłacze, które nie prowadzą do istniejącego pliku, jako `plik:linia: opis`. */
export function brokenReferences(list: readonly Reference[], tree: Tree): string[] {
  return list.map((ref) => brokenReference(ref, tree)).filter((miss): miss is string => miss !== null);
}
