/**
 * Types of `source-zones.mjs` (zones of source and data files). A separate file, because `tsconfig.base.json` has no
 * `allowJs` and the module must stay pure ESM for bare `node`.
 */

export type SourceFormat = 'ts' | 'swift' | 'markdown' | 'xcstrings' | 'script' | 'data';

/**
 * `comment`: comment text with its delimiters (in a string catalog: the value of a `comment` key); `title`: the
 * content of a test title; `code`: everything else of a source or data file; `prose` and `block`: Markdown outside
 * and inside fenced code blocks; `data`: a heredoc body or a YAML block scalar.
 */
export type Zone = 'comment' | 'title' | 'code' | 'prose' | 'block' | 'data';

/** A range `[start, end)` of the text (UTF-16 offsets) in one zone. */
export interface ZoneRange {
  readonly start: number;
  readonly end: number;
  readonly zone: Zone;
}

export interface SourceZones {
  readonly format: SourceFormat;
  /** Sorted, non-overlapping ranges that cover the whole text. */
  readonly ranges: readonly ZoneRange[];
  /** Constructs the lexer could not close (unterminated string, comment, heredoc, fence); empty when none. */
  readonly problems: readonly string[];
}

/** A piece of one line (`line` from 1) inside one zone, without the newline. */
export interface LinePiece {
  readonly line: number;
  readonly zone: Zone;
  readonly text: string;
}

export declare function formatOf(file: string): SourceFormat;
export declare function sourceZones(file: string, text: string): SourceZones;
export declare function linePieces(text: string, ranges: readonly ZoneRange[]): LinePiece[];
/** Comment and title ranges of Swift source only (no filling); problems are appended to `problems`. */
export declare function swiftRanges(text: string, problems?: string[]): ZoneRange[];
