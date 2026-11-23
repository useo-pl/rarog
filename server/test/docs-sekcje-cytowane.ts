/**
 * Cytowania sekcji dokumentów i sprawdzenie, że trafiają w istniejący nagłówek. Mechanizm strażnika
 * `docs-sekcje-cytowane.test.ts`: dokument przepisany bez poprawki kodu albo innego dokumentu nie może po cichu urwać
 * odsyłacza. Stąd biorą reguły strażnik odsyłaczy (`docs-odsylacze.ts`: ścieżka, rozwiązywanie, plik testu) i skrypt
 * migracji nazw dokumentów, więc reguła jest jedna.
 *
 * Cytowanie ma jedną z dwóch form, z backtickami wokół ścieżki albo bez, także przez kilka linii komentarza:
 * - ścieżka, potem tytuł: `docs/dialogs.md`, „Permission hook”; zamiast przecinka może stać „(”, „:”, „—” albo nic,
 *   przed tytułem może stać słowo „sekcja” albo „section” (`docs/security-model.md` (sekcja „Emergency console”));
 * - tytuł, potem ścieżka: „Sentences and lists” w `docs/localization.md` (także „z”, „in”, „from”, „of”, przed nimi może stać
 *   „sekcja” albo „section”).
 * Tytuł stoi w „…” (w środku może stać ASCII `"`), w „…" (dawna forma, bez `"` w środku), w “…” albo w "…" (forma
 * angielska; tytuł nie zaczyna się ani nie kończy spacją, więc `"docs/design.md", "b"` w kodzie to nie cytat).
 * Kilka tytułów po przecinku albo po „i”, „oraz”, „albo”, „and”, „or” to kilka cytowań.
 *
 * Plik testu ({@link isTestFile}) liczy się tylko w liniach komentarza ({@link commentLines}): napisy w testach to
 * dane (nieistniejące dokumenty w teście samego strażnika), a odsyłacz w napisie, który test czyta, pilnuje sam test.
 *
 * Ścieżkę rozwiązuje {@link resolveDoc}: w dokumencie `.md` najpierw od jego katalogu, potem od korzenia repo,
 * w kodzie od korzenia (`./` i `../` rozwinięte, więc `./docs/design.md` to `docs/design.md`). Plik spoza repo musi
 * stać na liście {@link CLAUDE_CODE_DOCS} (strony dokumentacji Claude Code, których strażnik nie czyta); inny
 * nieistniejący plik to błąd.
 *
 * Kotwica w dokumencie to nagłówek `#`…`######` (numerowany, `### 2. Przykładowa sekcja`, także bez numeru) albo
 * pogrubiony początek akapitu lub punktu listy (`**Przykład**`, `- **Próbka.**`), poza blokami kodu (blok zamyka
 * ogrodzenie tego samego znaku, nie krótsze). Tytuł trafia w kotwicę, gdy jest jej równy albo jest jej początkiem, po
 * którym stoi „ (”, „: ”, „, ”, „ — ” lub „ – ” (dopisek wersji, flagi czy podtytuł może zniknąć bez poprawki kodu).
 * Tytuł zakończony wielokropkiem trafia w każdą kotwicę, która tak się zaczyna. Porównanie po normalizacji: NFC, bez
 * backticków, białe znaki zwinięte.
 */
import { posix } from 'node:path';

/**
 * Katalogi kodu, w których szuka część prywatna strażnika (pliki spoza widoku eksportu). Część publiczna czyta cały
 * widok eksportu poza fixture'ami, razem z dokumentami.
 */
export const SCOPE = [
  '.github', 'bin', 'native', 'relay', 'relay-auth', 'relay-vps', 'scripts', 'server', 'shared',
] as const;

/** Strony dokumentacji Claude Code cytowane w kodzie (ścieżka jak w kodzie): spoza repo, strażnik ich nie czyta. */
export const CLAUDE_CODE_DOCS: ReadonlySet<string> = new Set([
  'agent-sdk/typescript.md',
  'agent-view.md',
  'commands.md',
  'cross-session-messaging.md',
  'env-vars.md',
  'errors.md',
  'interactive-mode.md',
  'mcp.md',
  'model-config.md',
  'plugins-reference.md',
  'plugins/mods/overview.md',
  'sessions.md',
  'setup.md',
  'skills.md',
  'statusline.md',
  'workflows.md',
]);

export interface Citation {
  /** Plik z cytowaniem (względem korzenia repo). */
  readonly file: string;
  /** Linia tytułu (od 1). */
  readonly line: number;
  /** Cytowany dokument, ścieżka jak w kodzie (po `posix.normalize`); rozwiązuje ją {@link resolveDoc}. */
  readonly target: string;
  /** Tytuł sekcji po normalizacji. */
  readonly title: string;
}

/** Cytowanie z miejscami w źródle: skrypt migracji nazw podmienia ścieżkę i tytuł w tych zakresach. */
export interface CitationSpan extends Citation {
  /** Zakres ścieżki w źródle (bez backticków), `[od, do)`. */
  readonly pathSpan: readonly [number, number];
  /** Zakres tytułu w źródle (bez cudzysłowów), `[od, do)`; przez kilka linii obejmuje też znaczniki komentarza. */
  readonly titleSpan: readonly [number, number];
  /** Tytuł dosłownie, jak stoi w źródle (dla tytułu przez kilka linii: z przełamaniem). */
  readonly rawTitle: string;
}

export const normalize = (text: string): string =>
  text.normalize('NFC').replace(/`/g, '').replace(/\s+/g, ' ').trim();

/** Ścieżka `.md`; nie zaczyna się w środku innej ścieżki (`~/.claude/…`, adres URL). Grupa 1 to ścieżka. */
export const MD_PATH = String.raw`(?<![\w./~-])\`?((?:[\w.-]+/)*[\w.-]+\.md)\`?`;
/**
 * Tytuł w jednym z czterech cudzysłowów; grupy 1–4 to treść (pierwsza niepusta). Tytuł w ASCII `"…"` nie zaczyna
 * się od spacji ani znaku przestankowego i nie kończy spacją: `"docs/design.md"), ("b"` w kodzie to sklejenie
 * napisów, nie cytat.
 */
const TITLE_GROUPS = [
  String.raw`„([^”„]{1,200})”`, String.raw`„([^”"„]{1,200})"`, String.raw`“([^”“]{1,200})”`,
  String.raw`"(?![\s,;:.()[\]{}'])([^"]{1,200}?)(?<!\s)"`,
].join('|');
const TITLE = TITLE_GROUPS.replace(/\((?!\?)/g, '(?:');
const JOIN = String.raw`(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:i|oraz|albo|and|or)\s+)`;
const TITLES = String.raw`(?:${TITLE})(?:${JOIN}(?:${TITLE}))*`;
const SECTION_WORD = String.raw`(?:sekcj[aię]|section)\s+`;
const FORWARD = new RegExp(String.raw`${MD_PATH}\s*(?:[,:(—–]\s*)?(?:${SECTION_WORD})?(${TITLES})`, 'dg');
const BACKWARD = new RegExp(String.raw`(${TITLES})\s+(?:${SECTION_WORD})?(?:w|we|z|ze|in|from|of)\s+${MD_PATH}`, 'dg');
const ONE_TITLE = new RegExp(TITLE_GROUPS, 'dg');
/** Znacznik komentarza na początku linii: cytowanie przez kilka linii czyta się jak jedną. */
const COMMENT_PREFIX = /^\s*(?:\/\/\/?|\*(?!\/)|#+)?\s*/;

/**
 * Plik testu: katalog `test/`, `tests/` albo `Tests/` (także pakiety Swift) albo nazwa `*.test.*`. W nim liczą się
 * tylko linie komentarza.
 */
export function isTestFile(file: string): boolean {
  return /(?:^|\/)(?:test|tests|Tests)\//.test(file) || /\.test\.[cm]?[jt]s$/.test(file);
}

/** Linia komentarza w kodzie z rodziny C (TS, JS, Swift): zaczyna się od `//`, `/*` albo `*`. */
const C_COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/** Linia komentarza w powłoce i konfiguracji (`.sh`, `.yml`, `.toml`, `.py`): zaczyna się od `#`. */
const HASH_COMMENT_LINE = /^\s*#/;

/**
 * Treść pliku z wyczyszczonymi liniami, które nie są komentarzem (numery linii zostają). `#` jest komentarzem tylko
 * w powłoce i konfiguracji: w Swift to makro (`#expect`), w TS pole prywatne.
 */
export function commentLines(file: string, text: string): string {
  const comment = /\.(?:sh|bash|ya?ml|toml|py)$/.test(file) ? HASH_COMMENT_LINE : C_COMMENT_LINE;
  return text.split('\n').map((line) => (comment.test(line) ? line : '')).join('\n');
}

/**
 * Treść, w której strażnik szuka odsyłaczy: w pliku testu same linie komentarza, w innym całość. Dokument `.md`
 * w katalogu testów (README fixture'ów) to dokument, nie kod testu: liczy się w całości.
 */
export function scanned(file: string, text: string): string {
  return isTestFile(file) && !file.endsWith('.md') ? commentLines(file, text) : text;
}

/**
 * Ścieżka dokumentu z odsyłacza w pliku `file`: w dokumencie `.md` najpierw od jego katalogu (gdy taki plik jest),
 * potem od korzenia repo; w kodzie od korzenia. `exists` mówi, czy plik (ścieżka od korzenia) jest w repo.
 */
export function resolveDoc(file: string, raw: string, exists: (path: string) => boolean): string {
  if (file.endsWith('.md')) {
    const local = posix.normalize(posix.join(posix.dirname(file), raw));
    if (exists(local)) return local;
  }
  return posix.normalize(raw);
}

/** Cytowania sekcji w treści `text` z miejscami w źródle (bez filtra pliku testu: ten robi {@link citations}). */
export function citationSpans(file: string, text: string): CitationSpan[] {
  /** `source[i]` = przesunięcie w `text` znaku `flat[i]`; spacja doklejona za linią wskazuje znak końca linii. */
  const source: number[] = [];
  const starts: number[] = [];
  let flat = '';
  let offset = 0;
  for (const line of text.split('\n')) {
    starts.push(flat.length);
    const prefix = COMMENT_PREFIX.exec(line)?.[0].length ?? 0;
    for (let i = prefix; i < line.length; i += 1) source.push(offset + i);
    source.push(offset + line.length);
    flat += `${line.slice(prefix)} `;
    offset += line.length + 1;
  }
  const lineAt = (at: number): number => {
    let line = 0;
    while (line + 1 < starts.length && (starts[line + 1] ?? Infinity) <= at) line += 1;
    return line + 1;
  };
  const span = (from: number, to: number): [number, number] => [source[from] ?? 0, (source[to - 1] ?? 0) + 1];
  const out: CitationSpan[] = [];
  const collect = (pattern: RegExp, pathGroup: number, titlesGroup: number): void => {
    for (const hit of flat.matchAll(pattern)) {
      const target = posix.normalize(hit[pathGroup] ?? '');
      const [pathFrom, pathTo] = hit.indices?.[pathGroup] ?? [0, 0];
      const [from] = hit.indices?.[titlesGroup] ?? [0];
      for (const title of (hit[titlesGroup] ?? '').matchAll(ONE_TITLE)) {
        const group = [1, 2, 3, 4].find((n) => title[n] !== undefined) ?? 1;
        const [titleFrom, titleTo] = title.indices?.[group] ?? [0, 0];
        const titleSpan = span(from + titleFrom, from + titleTo);
        out.push({
          file, line: lineAt(from + titleFrom), target, title: normalize(title[group] ?? ''),
          pathSpan: span(pathFrom, pathTo), titleSpan, rawTitle: text.slice(titleSpan[0], titleSpan[1]),
        });
      }
    }
  };
  collect(FORWARD, 1, 2);
  collect(BACKWARD, 2, 1);
  return out.sort((a, b) => a.line - b.line || a.titleSpan[0] - b.titleSpan[0]);
}

/** Cytowania sekcji w treści pliku `file` (w pliku testu tylko w liniach komentarza). */
export function citations(file: string, text: string): Citation[] {
  return citationSpans(file, scanned(file, text))
    .map(({ file: f, line, target, title }) => ({ file: f, line, target, title }));
}

/** Numer na początku nagłówka: `2. `, `1.2 `, `3) `. */
const HEADING_NUMBER = /^\d+(?:\.\d+)+\.?\s+|^\d+[.)]\s+/;

/**
 * Kotwice dokumentu Markdown po normalizacji: nagłówki (numerowane także bez numeru) i pogrubione początki akapitów,
 * poza blokami kodu.
 */
export function anchors(markdown: string): string[] {
  const out: string[] = [];
  /** Otwarte ogrodzenie bloku kodu (np. „````”); zamyka je linia z samym ogrodzeniem tego znaku, nie krótszym. */
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    if (fence !== null) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (open !== undefined) {
      fence = open;
      continue;
    }
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      out.push(normalize(heading));
      if (HEADING_NUMBER.test(heading)) out.push(normalize(heading.replace(HEADING_NUMBER, '')));
    }
    const lead = /^\s*(?:(?:[-*+]|\d+\.)\s+)?\*\*(.+?)\*\*/.exec(line)?.[1];
    if (lead !== undefined) out.push(normalize(lead).replace(/[.:]$/, ''));
  }
  return out;
}

const SEPARATORS = [' (', ': ', ', ', ' — ', ' – '] as const;
const ELLIPSIS = /\s*(?:…|\.\.\.)$/;

/** Tytuł z kodu trafia w kotwicę dokumentu (obie po normalizacji). */
export function hits(title: string, anchor: string): boolean {
  if (anchor === title) return true;
  if (ELLIPSIS.test(title)) return anchor.startsWith(title.replace(ELLIPSIS, ''));
  return SEPARATORS.some((separator) => anchor.startsWith(title + separator));
}

/**
 * Cytowania, które nie trafiają, jako `plik:linia: opis`. `target` cytowania jest już rozwiązany ({@link resolveDoc});
 * `read(target)` daje treść dokumentu albo `null`, gdy dokumentu nie ma.
 */
export function misses(list: readonly Citation[], read: (target: string) => string | null): string[] {
  const cache = new Map<string, readonly string[] | null>();
  const out: string[] = [];
  for (const { file, line, target, title } of list) {
    if (!cache.has(target)) {
      const text = read(target);
      cache.set(target, text === null ? null : anchors(text));
    }
    const found = cache.get(target) ?? null;
    const where = `${file}:${String(line)}`;
    if (found === null) {
      if (CLAUDE_CODE_DOCS.has(target)) continue;
      out.push(`${where}: ${target}, „${title}” — nie ma takiego dokumentu (ścieżka od korzenia repo, w dokumencie .md `
        + 'także od jego katalogu; strona dokumentacji Claude Code idzie na listę CLAUDE_CODE_DOCS)');
    } else if (!found.some((anchor) => hits(title, anchor))) {
      out.push(`${where}: ${target} nie ma nagłówka „${title}”`);
    }
  }
  return out;
}
