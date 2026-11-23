/**
 * Types of `source-scan.mjs` (TypeScript and JavaScript source scanner). A separate file, because
 * `tsconfig.base.json` has no `allowJs` and the module must stay pure ESM for bare `node`.
 */

export interface Scanned {
  /** Source without comments; strings, templates and patterns stay whole. */
  readonly code: string;
  /** Skeleton: code without comments AND without the contents of strings, templates and patterns (brackets and words). */
  readonly skeleton: string;
  /**
   * Contents of strings (`'…'`, `"…"`) and template pieces (text between a backtick and `${`, between `}` and a
   * backtick), raw (escapes are not expanded), with the offset of the content start in the SOURCE. No comments and
   * no patterns.
   */
  readonly literals: readonly { readonly text: string; readonly offset: number }[];
  /** Regex literals: the content between the slashes (raw, like `RegExp.source`) and the flags. */
  readonly regexes: readonly { readonly source: string; readonly flags: string; readonly offset: number }[];
  /** Comments as source ranges `[start, end)`, delimiters included; a line comment ends before its newline. */
  readonly comments: readonly { readonly start: number; readonly end: number }[];
}

export declare function scan(source: string): Scanned;
