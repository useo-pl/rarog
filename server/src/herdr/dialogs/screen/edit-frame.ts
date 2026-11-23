/**
 * The `Edit` and `Write` "Create file" permission dialog as PROOF of the call: whether the screen shows THIS edit or
 * write, the one the hook dump or the jsonl entry knows.
 *
 * The dialog draws a two-line header ("Edit file" or "Create file" and the file path, relative to the call's directory
 * when the file is in it) and under it a `╌╌╌` frame: for `Edit` a diff (line number, space, marker ` `/`+`/`-`,
 * content), for "Create file" the new file (line number, space, content). A file name alone does not tell two edits
 * of one file apart, so the proof is the pair: the header path resolved to `file_path` and a frame that is exactly
 * this edit or this content.
 *
 * Content compares LITERALLY: spaces inside a line, the indent and line boundaries count (a comparison without
 * whitespace would take `rm -rf / safe` on screen for `rm -rf /safe` in the call). Left out are one final newline of
 * a `Write` and a single `\r` right before `\n` (CRLF). Whitespace at the end of a file line is an empty cell and the
 * read trims the row end, so content with it has no proof and a row proves only its line without it. A tab is drawn
 * with spaces, so content with a tab has no proof either.
 *
 * A file line longer than the frame wraps over rows ({@link frameFileLines}). The CLI breaks it hard at the content
 * width W and gives every further row an empty number field and the same marker; a space at the break stays on screen
 * as an empty cell at the row end or as the first cell of the next row. The rows join back into one line only when
 * the frame proves W itself (geometry `FILE_FRAME_GEOMETRY` in `screen/signatures.ts` and a row exactly W wide in the
 * same frame) and every character of the wrapped line is on the closed list measured at one column. Any other
 * mismatch, an unknown frame row or a dialog cut at the top gives `false`: a card without buttons, never a wrong digit.
 *
 * The call (a jsonl entry, a hook dump) has no length limit, so the cost against it is linear: a split at `\n` and
 * `trimEnd`, no regular expression that backtracks over a run of spaces. The module is PURE. "Overwrite file" never
 * proves a write: its diff does not show that it covers the whole file. Docs: `docs/dialogs.md`, "Permission dialog
 * operation" and "Cross-check".
 */
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { displayWidth } from './operation.ts';
import type { ScreenOperation } from './operation.ts';
import { FILE_FRAME_GEOMETRY, SCREEN_SIGNATURES } from './signatures.ts';

const OPERATION_MARGIN = SCREEN_SIGNATURES.operationMargin.pattern;

/** Linia diffu z numerem: `651 -treść`; pusta linia pliku to sam numer (`651`) albo numer ze znacznikiem. */
const NUMBERED_LINE = SCREEN_SIGNATURES.editDiffLine.pattern;

/** Linia treści nowego pliku w ramce „Create file”: numer i treść, bez znacznika diffu. */
const WRITE_CONTENT_LINE = SCREEN_SIGNATURES.writeContentLine.pattern;

/** Characters a wrapped file line may hold: each measured at one column, with the break where the count puts it. */
const WRAP_CHARS = FILE_FRAME_GEOMETRY.wrapChars;

/** The frame a file dialog draws: the `Edit` diff or the `Write` "Create file" content. */
export type FileFrame = 'diff' | 'content';

const FRAME_LINE: Readonly<Record<FileFrame, RegExp>> = { diff: NUMBERED_LINE, content: WRITE_CONTENT_LINE };

/** One file line from the frame: its number, the diff marker (` ` for the content frame), the text without the row end. */
export interface FrameFileLine {
  readonly number: number;
  readonly mark: string;
  readonly text: string;
}

/** A frame row without the margin, as the read gives it, and its line pattern match (`null`: a continuation). */
interface FrameRow {
  readonly body: string;
  readonly match: RegExpExecArray | null;
}

/**
 * The file lines of a file frame, read from its raw rows (`ScreenOperation.rows`); `null` when the frame has no rows,
 * a row without the margin, an empty row or a row outside the line pattern.
 *
 * A row whose number field is blank on the width of the first row's field is a continuation of the line above.
 * A frame without one reads row by row, each row one line, as the line pattern gives it. A frame with one is read by
 * {@link joinedLines}: by column, under the measured geometry.
 */
export function frameFileLines(operation: ScreenOperation, frame: FileFrame): FrameFileLine[] | null {
  const pattern = FRAME_LINE[frame];
  const rows: FrameRow[] = [];
  let field = 0;
  for (const row of operation.rows) {
    if (!OPERATION_MARGIN.test(row)) return null;
    const body = row.replace(OPERATION_MARGIN, '');
    const line = body.trimEnd();
    if (line === '') return null;
    if (rows.length > 0 && line.slice(0, field).trim() === '') {
      rows.push({ body, match: null });
      continue;
    }
    const match = pattern.exec(line);
    if (match === null) return null;
    if (rows.length === 0) field = (match[1] ?? '').length;
    rows.push({ body, match });
  }
  if (rows.length === 0) return null;
  if (rows.some((row) => row.match === null)) return joinedLines(rows, operation.ruleWidth, frame);
  return rows.map((row) => lineOf(row.match as RegExpExecArray, frame));
}

/** A whole line from one numbered row; the text without whitespace at its end, which the screen does not show. */
function lineOf(match: RegExpExecArray, frame: FileFrame): FrameFileLine {
  const text = (frame === 'diff' ? match[3] : match[2]) ?? '';
  return { number: Number(match[1]), mark: frame === 'diff' ? match[2] ?? ' ' : ' ', text: text.trimEnd() };
}

/** A line under construction: its first row's number and marker (`null`: a number-only diff row) and row texts. */
interface OpenLine {
  readonly number: number;
  readonly mark: string | null;
  readonly parts: string[];
}

/**
 * The file lines of a frame with continuation rows, read by column; `null` at any doubt.
 *
 * The geometry comes from the frame: C is the rule width, d the digits of the largest line number, the content width
 * W = C − reserve − d (`FILE_FRAME_GEOMETRY`). The frame must hold a row exactly W wide of listed characters (the
 * witness: without it the formula is not trusted, since another CLI version or terminal layout draws narrower, as
 * `measured/zgoda-write-dluga-linia-2.1.322.txt` shows) and no row wider than W. Every numbered row has a number
 * field of the measured width. A continuation row has a blank number field, the marker of its line (the diff) and does not read as a numbered row after the margin (`42 -x`); it never
 * stands first, and a number-only diff row (an empty line) has none.
 *
 * A wrapped line takes its rows' content by column; each character must be on the closed list. A row that does not end
 * the line is padded with U+0020 to W: the screen dropped that empty cell at the row end, and on the list the only
 * character drawn as an empty cell is the space.
 */
function joinedLines(rows: readonly FrameRow[], ruleWidth: number, frame: FileFrame): FrameFileLine[] | null {
  const geometry = FILE_FRAME_GEOMETRY[frame];
  const numbers = rows.flatMap((row) => (row.match === null ? [] : [Number(row.match[1])]));
  const digits = String(Math.max(...numbers)).length;
  const width = ruleWidth - geometry.reserve - digits;
  // Columns in the row without the margin: the content, and the diff marker right before it.
  const start = digits + FILE_FRAME_GEOMETRY.contentAfterDigits - 1;
  const markAt = frame === 'diff' ? start - 1 : start;
  if (width < 1) return null;
  const lines: OpenLine[] = [];
  let witness = false;
  for (const { body, match } of rows) {
    const content = body.slice(start);
    if (displayWidth(content) > width) return null;
    if (content.length === width && WRAP_CHARS.test(content)) witness = true;
    if (match !== null) {
      if ((match[1] ?? '').length !== digits + geometry.fieldExtra) return null;
      const mark = frame === 'diff' ? match[2] ?? null : ' ';
      lines.push({ number: Number(match[1]), mark, parts: [content] });
      continue;
    }
    const owner = lines.at(-1);
    if (owner === undefined || owner.mark === null || !/^ *$/u.test(body.slice(0, markAt))) return null;
    if (frame === 'diff' && body.slice(markAt, start) !== owner.mark) return null;
    if (FRAME_LINE[frame].test(body.trimEnd())) return null;
    owner.parts.push(content);
  }
  if (!witness) return null;
  const out: FrameFileLine[] = [];
  for (const { number, mark, parts } of lines) {
    if (parts.length > 1 && !parts.every((part) => WRAP_CHARS.test(part))) return null;
    const last = parts.length - 1;
    const text = parts.map((part, index) => (index < last ? part.padEnd(width, ' ') : part.trimEnd())).join('');
    out.push({ number, mark: mark ?? ' ', text });
  }
  return out;
}

/**
 * Linie tekstu wywołania po `\n`, każda bez jednego `\r` tuż przed `\n` (CRLF). Ostatni kawałek (po ostatnim `\n`)
 * zostaje bez zmian: `\r` bez `\n` za nim to zwykły biały znak.
 */
function callLines(text: string): string[] {
  const lines = text.split('\n');
  const last = lines.length - 1;
  return lines.map((line, index) => (index < last && line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Czy linia kończy się białym znakiem (spacja, tabulator, `\r`, spacja niełamiąca…); `trimEnd` czyta tylko koniec. */
const endsWithSpace = (line: string): boolean => line.trimEnd().length !== line.length;

/** The sides of a diff: the old one (context and `-`) and the new one (context and `+`), file lines, text literal. */
export interface EditDiffSides {
  readonly old: string;
  readonly new: string;
}

/**
 * The sides of the diff in an `Edit` frame: the old one (context and `-`) and the new one (context and `+`), one file
 * line each, the text literal with its indent ({@link frameFileLines}). `null` when the frame gives no file lines
 * (a hunk separator, a note, another render, a wrapped line the frame does not prove).
 */
export function editDiffSides(operation: ScreenOperation): EditDiffSides | null {
  const lines = frameFileLines(operation, 'diff');
  if (lines === null) return null;
  return {
    old: lines.filter((line) => line.mark !== '+').map((line) => line.text).join('\n'),
    new: lines.filter((line) => line.mark !== '-').map((line) => line.text).join('\n'),
  };
}

interface EditCall {
  readonly filePath: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

function editCall(input: unknown): EditCall | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const { file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll } = record;
  if (typeof filePath !== 'string' || typeof oldString !== 'string' || typeof newString !== 'string') return null;
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return null;
  return { filePath, oldString, newString, replaceAll: replaceAll === true };
}

/** Ścieżka z nagłówka jako bezwzględna: `~/…` w katalogu domowym, bezwzględna wprost, względna wobec `cwd`. */
function shownAbsolute(shown: string, cwd: string | null, home: string): string | null {
  if (shown === '~' || shown.startsWith('~/')) return join(home, shown.slice(1));
  if (isAbsolute(shown)) return shown;
  return cwd !== null && isAbsolute(cwd) ? resolve(cwd, shown) : null;
}

/** Biały znak na końcu ścieżki: ekran obcina go na końcu linii, więc takiej nazwy nie pokaże. */
const TRAILING_SPACE = /\s$/u;

/**
 * Czy ścieżka z nagłówka wskazuje DOKŁADNIE `filePath` ({@link shownAbsolute}; względna bez `cwd` — `false`).
 * `filePath` względna albo zakończona białym znakiem — `false`.
 */
export function shownPathIs(shown: string, filePath: string, cwd: string | null, home: string): boolean {
  if (shown === '' || !isAbsolute(filePath) || TRAILING_SPACE.test(filePath)) return false;
  const absolute = shownAbsolute(shown, cwd, home);
  return absolute !== null && normalize(absolute) === normalize(filePath);
}

/**
 * Czy ścieżka z nagłówka MOŻE wskazywać `filePath` przy JAKIMKOLWIEK katalogu wywołania: względna jest końcem
 * `filePath` po pełnych członach. Służy wyłącznie do wykluczenia źródła, więc przy niewiadomej (`filePath` względna,
 * `..` w ścieżce) odpowiada `true`.
 */
function shownPathFits(shown: string, filePath: string, home: string): boolean {
  const target = filePath.trimEnd();
  if (!isAbsolute(target)) return true;
  const absolute = shownAbsolute(shown, null, home);
  if (absolute !== null) return normalize(absolute) === normalize(target);
  if (shown.split('/').includes('..')) return true;
  return normalize(target).endsWith(`/${normalize(shown)}`);
}

/** Długość wspólnego początku (`fromEnd`: wspólnego końca) dwóch tekstów. */
function commonLength(a: string, b: string, fromEnd: boolean): number {
  const limit = Math.min(a.length, b.length);
  let n = 0;
  while (n < limit && (fromEnd
    ? a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)
    : a.charCodeAt(n) === b.charCodeAt(n))) n += 1;
  return n;
}

/**
 * Czy dosłowna zamiana `old_string` na `new_string` w starej stronie (któreś wystąpienie albo wszystkie) daje nową
 * stronę. Obie strony to linie z ekranu bez białych znaków na końcu, więc wynik równy nowej stronie nie ma ich na żadnym
 * końcu linii. Kawałek `old_string` albo `new_string` przed `\n` kończy linię pliku: biały znak na jego końcu to
 * `false` od razu (sam `\r` przed `\n` to CRLF, {@link callLines}). Ostatni kawałek kończy się tam, gdzie tekst
 * wywołania, czyli często w środku linii (`foo ` z `foo bar`); tam spację widać, a przy końcu linii pliku odrzuca ją
 * porównanie z ekranem.
 *
 * Koszt wobec tekstów wywołania liniowy (podział i `trimEnd`). Dalszą pracę ograniczają strony z ekranu: tekst
 * wywołania dłuższy od strony to `false`, zanim cokolwiek się buduje, a przy jednej zamianie sprawdzamy tylko
 * wystąpienia, przy których wspólny początek i koniec stron się zgadzają.
 */
function editExplainsDiff(oldSide: string, newSide: string, oldString: string, newString: string, all: boolean): boolean {
  const oldLines = callLines(oldString);
  const newLines = callLines(newString);
  const lineEnd = (line: string, index: number, lines: readonly string[]): boolean =>
    index < lines.length - 1 && endsWithSpace(line);
  if (oldLines.some(lineEnd) || newLines.some(lineEnd)) return false;
  const oldText = oldLines.join('\n');
  const newText = newLines.join('\n');
  if (oldText === '' || oldText.length > oldSide.length || newText.length > newSide.length) return false;
  if (all) {
    const parts = oldSide.split(oldText);
    const count = parts.length - 1;
    return count > 0 && oldSide.length + count * (newText.length - oldText.length) === newSide.length
      && parts.join(newText) === newSide;
  }
  if (oldSide.length - oldText.length + newText.length !== newSide.length) return false;
  // Zamiana w `at` daje nową stronę, gdy strony mają wspólne `at` znaków z przodu, wspólny ogon za zamianą
  // i `newText` stoi w nowej stronie w `at`.
  const head = commonLength(oldSide, newSide, false);
  const tail = commonLength(oldSide, newSide, true);
  for (let at = oldSide.indexOf(oldText, oldSide.length - oldText.length - tail); at !== -1 && at <= head;
    at = oldSide.indexOf(oldText, at + 1)) {
    if (newSide.startsWith(newText, at)) return true;
  }
  return false;
}

/** Linia nagłówka bez DOKŁADNIE jednego marginesu CLI; `null`, gdy marginesu nie ma. Reszty nie przycinamy. */
function withoutMargin(line: string | undefined): string | null {
  return line !== undefined && OPERATION_MARGIN.test(line) ? line.replace(OPERATION_MARGIN, '') : null;
}

/** Ścieżka z nagłówka całego dialogu `Edit` (tytuł i jedna linia ścieżki); `null` przy innym kształcie. */
function shownPath(operation: ScreenOperation | null): string | null {
  if (operation === null || !operation.complete || !operation.headerVisible || operation.header.length !== 2) return null;
  return withoutMargin(operation.header[1]);
}

/**
 * Nazwa bazowa pliku ze ścieżki nagłówka całego dialogu `Edit` ({@link shownPath}); `null` przy innym kształcie
 * nagłówka i przy pustej nazwie. Pytanie pod ramką diffu niesie samą tę nazwę (`screen/edit-zone.ts`, dowód wierzchu
 * kanału zgód w `layer1/top.ts`).
 */
export function editShownName(operation: ScreenOperation | null): string | null {
  const name = shownPath(operation)?.split('/').pop() ?? '';
  return name === '' ? null : name;
}

/**
 * Whether the `Edit` dialog on screen shows this edit: the whole frame under the visible header, a header of TWO
 * lines (title and path), the path resolved against THIS call's `cwd` to `file_path` ({@link shownPathIs}), and
 * a diff of the file lines the frame proves ({@link editDiffSides}) explained by the literal replacement of
 * `old_string` with `new_string` ({@link editExplainsDiff}). Input without the `Edit` fields gives `false`. The caller
 * checks that this is an `Edit` dialog from the block identity (the title under the top rule), not this module.
 *
 * The path comes from one line, neither joined nor trimmed: a path wrapped over two lines or a third header line is
 * an unmeasured shape, and a space at the edge of a file name is another file. Such a dialog gets a card without
 * buttons.
 */
export function editMatchesOperation(
  input: unknown, operation: ScreenOperation | null, cwd: string | null, home: string = homedir(),
): boolean {
  const call = editCall(input);
  const shown = shownPath(operation);
  if (call === null || operation === null || shown === null) return false;
  if (!shownPathIs(shown, call.filePath, cwd, home)) return false;
  const sides = editDiffSides(operation);
  return sides !== null && editExplainsDiff(sides.old, sides.new, call.oldString, call.newString, call.replaceAll);
}

/**
 * Whether the `Edit` dialog on screen CONTRADICTS this call: the header path cannot point to `file_path` from any
 * directory ({@link shownPathFits}). It needs no `cwd`, so it works for a jsonl entry too. An unknown (a cut dialog,
 * another header shape, input without `file_path`) is `false`: excluding a source needs proof of a contradiction.
 *
 * The diff proves NO contradiction. A real edit can stay unexplained: a wrapped line the frame does not prove, a tab
 * drawn as spaces, whitespace at the end of `old_string` at a line end, or an `old_string` with unchanged lines far
 * from the change that reach past the hunk context. A failed diff match is therefore no confirmation, not proof of
 * another call.
 */
export function editContradictsOperation(
  input: unknown, operation: ScreenOperation | null, home: string = homedir(),
): boolean {
  const shown = shownPath(operation);
  if (shown === null || typeof input !== 'object' || input === null) return false;
  const filePath = (input as Record<string, unknown>)['file_path'];
  return typeof filePath === 'string' && !shownPathFits(shown, filePath, home);
}

/** Sufiks tytułu zgody subagenta (` · from the Explore agent`). */
const SUBAGENT_TITLE_SUFFIX = SCREEN_SIGNATURES.subagentTitleSuffix.pattern;

/**
 * Rodzaj ramki dialogu zapisu pliku z tytułu całego dialogu (pierwsza linia nagłówka): `create` dla „Create file”
 * (ramka z treścią nowego pliku), `overwrite` dla „Overwrite file” (ramka z diffem starej i nowej treści), `null`
 * dla każdego innego tytułu. Tylko do odczytu ramki: tożsamość dialogu i nazwę daje blok (`screen/block.ts`).
 */
function writeFrameKind(operation: ScreenOperation): 'create' | 'overwrite' | null {
  const title = withoutMargin(operation.header[0])?.replace(SUBAGENT_TITLE_SUFFIX, '') ?? null;
  if (title === SCREEN_SIGNATURES.toolDialogHeaderWrite.pattern) return 'create';
  return title === SCREEN_SIGNATURES.toolDialogHeaderWriteOverwrite.pattern ? 'overwrite' : null;
}

/**
 * The lines of the new file in a "Create file" frame, literal with their indent ({@link frameFileLines}); the numbers
 * run from 1 without gaps, so the frame shows the file from its start. The whole frame under the header (the bottom
 * rule over the question) proves the end of the file. `null` when the frame gives no file lines and at a gap in the
 * numbers.
 */
function createdLines(operation: ScreenOperation): string[] | null {
  const lines = frameFileLines(operation, 'content');
  if (lines === null || lines.some((line, index) => line.number !== index + 1)) return null;
  return lines.map((line) => line.text);
}

/**
 * Linie treści `Write` tak, jak może je pokazać ramka „Create file”: bez jednej nowej linii na końcu pliku (zmierzony
 * plik jednej linii ma jeden wiersz) i bez `\r` przed `\n` (CRLF, {@link callLines}). `null`, gdy któraś linia, także
 * ostatnia bez `\n`, kończy się białym znakiem: ekran rysuje go pustą komórką, więc takiej treści nie dowodzi.
 */
function contentLines(content: string): string[] | null {
  const lines = callLines(content);
  if (content.endsWith('\n')) lines.pop();
  return lines.some(endsWithSpace) ? null : lines;
}

function writeCall(input: unknown): { readonly filePath: string; readonly content: string } | null {
  if (typeof input !== 'object' || input === null) return null;
  const { file_path: filePath, content } = input as Record<string, unknown>;
  return typeof filePath === 'string' && typeof content === 'string' ? { filePath, content } : null;
}

/**
 * Czy dialog zapisu pliku na ekranie pokazuje TEN zapis: cała ramka pod widocznym nagłówkiem z dwóch linii (tytuł
 * i ścieżka), ścieżka rozwiązana względem `cwd` do `file_path` ({@link shownPathIs}) i ramka „Create file”, której
 * linie od 1 do końca są dosłownie liniami CAŁEJ `content` ({@link createdLines}, {@link contentLines}).
 *
 * „Overwrite file” to zawsze `false`. Ramka pokazuje diff starej i nowej treści w kształcie diffu `Edit`
 * (`measured/zgoda-write-nadpisanie-2.1.322.txt`), a z niego nie wynika, że nowa strona to cały plik: hunk z numerami
 * 50–51 albo od linii 1 z niewidocznym ciągiem dalej ma nową stronę równą stęchłej, krótszej treści. Zmierzona ramka
 * zmienia wszystkie linie, więc nie pokazuje, ile linii kontekstu CLI rysuje i czy rysuje plik do końca. Inny tytuł,
 * inny kształt ramki albo wejście bez `file_path` i `content` — `false`.
 */
export function writeMatchesOperation(
  input: unknown, operation: ScreenOperation | null, cwd: string | null, home: string = homedir(),
): boolean {
  const call = writeCall(input);
  const shown = shownPath(operation);
  if (call === null || operation === null || shown === null) return false;
  if (!shownPathIs(shown, call.filePath, cwd, home) || writeFrameKind(operation) !== 'create') return false;
  const shownLines = createdLines(operation);
  const lines = contentLines(call.content);
  return shownLines !== null && lines !== null && shownLines.length === lines.length
    && shownLines.every((line, index) => line === lines[index]);
}

/**
 * Wywołanie zapisu (`write`) albo edycji (`edit`) pliku, które karta z jsonl albo ze zrzutu hooka chce zatwierdzić
 * cyfrą: surowe wejście i katalog, względem którego dialog pokazuje ścieżkę (katalog wywołania ze zrzutu hooka, bez
 * niego katalog sesji). Rodzaj wybiera wołający po nazwie narzędzia (`decide/sources.ts`): ten moduł nazw nie zna.
 */
export interface FileCall {
  readonly change: 'write' | 'edit';
  readonly input: unknown;
  readonly cwd: string | null;
}

/** Czy ekran dowodzi wywołania pliku: {@link writeMatchesOperation} albo {@link editMatchesOperation}. */
export function fileCallShown(call: FileCall, operation: ScreenOperation | null, home: string = homedir()): boolean {
  return call.change === 'edit'
    ? editMatchesOperation(call.input, operation, call.cwd, home)
    : writeMatchesOperation(call.input, operation, call.cwd, home);
}
