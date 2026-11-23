/**
 * Zones of a source or data file: which parts of the text are comments, test titles, code (with its literals),
 * Markdown prose and code blocks, and embedded data (shell heredocs, YAML block scalars). Guards that count words
 * only in comments or titles, and tools that must prove "only comments changed", read the zones from here.
 *
 * Formats, chosen by file name ({@link formatOf}):
 * - `ts`: TypeScript and JavaScript, and `tsconfig*.json` (JSON with comments), through `scan()`
 *   (`source-scan.mjs`), which knows strings, templates and regex literals; titles are the first string argument
 *   of `it`, `test`, `describe`, `suite` and `bench` (with modifiers such as `.skip`, `.each(…)`), also through
 *   a title helper (`macOnly(…)`, `checkoutOnly(…)`).
 * - `swift`: a lexer of its own ({@link swiftRanges}): nested block comments, `"…"`, `"""…"""`, raw strings
 *   `#"…"#`, interpolation `\(…)` and regex literals `/…/` and `#/…/#`; titles are the string of `@Test("…")`
 *   and `@Suite("…")`.
 * - `markdown`: fenced code blocks (the fence lines included) are `block`, HTML comments are `comment`, the rest is
 *   `prose`.
 * - `xcstrings`: the value of every `"comment"` key is `comment`, the rest is `code`.
 * - `script` (shell, YAML, TOML, Python, config files, Xcode project): `#` comments (`/* … *\/` in `.pbxproj`) are
 *   `comment`, heredoc bodies and YAML block scalars are `data`, the rest is `code`.
 * - `data`: everything else (JSON, JSONL, text fixtures, property lists) and `pnpm-lock.yaml`: all `code`.
 *
 * The lexers are not parsers. A construct they cannot close (an unterminated string or comment) is reported in
 * `problems`, so a caller that must not guess (a behaviour check) can hand the file to a person instead.
 *
 * Pure ESM, only sibling modules: runs under bare `node` before `pnpm install`. Types: `source-zones.d.mts`.
 */
import { scan } from './source-scan.mjs';

const TS = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
/** TypeScript project files: JSON with `//` and `/* … *\/` comments, which the TypeScript lexer reads as they are. */
const TSCONFIG = /(?:^|\/)tsconfig[\w.-]*\.json$/u;
const SWIFT = /\.swift$/u;
const MARKDOWN = /\.md$/iu;
const XCSTRINGS = /\.xcstrings$/u;
const PBXPROJ = /\.pbxproj$/u;
const SHELL = /\.(?:sh|bash|zsh)$/u;
const YAML = /\.ya?ml$/u;
/** Generated lockfiles: integrity hashes in base64, not configuration. */
const LOCKFILE = /(?:^|\/)pnpm-lock\.yaml$/u;
const SCRIPT = /\.(?:sh|bash|zsh|ya?ml|toml|py|conf|service|cron|pbxproj)$|(?:^|\/)(?:\.gitignore|\.npmrc|\.gitattributes|Dockerfile|Makefile|Caddyfile)$/u;

/** Format of a file by its path (see the module comment). */
export function formatOf(file) {
  if (TS.test(file) || TSCONFIG.test(file)) return 'ts';
  if (SWIFT.test(file)) return 'swift';
  if (MARKDOWN.test(file)) return 'markdown';
  if (XCSTRINGS.test(file)) return 'xcstrings';
  if (LOCKFILE.test(file)) return 'data';
  if (SCRIPT.test(file)) return 'script';
  return 'data';
}

/**
 * Zones of `text` as sorted, non-overlapping ranges `{ start, end, zone }` that cover the whole text, plus the
 * format and the problems the lexer met.
 */
export function sourceZones(file, text) {
  const format = formatOf(file);
  const problems = [];
  let marked;
  if (format === 'ts') marked = tsRanges(text);
  else if (format === 'swift') marked = swiftRanges(text, problems);
  else if (format === 'markdown') marked = markdownRanges(text, problems);
  else if (format === 'xcstrings') marked = xcstringsRanges(text, problems);
  else if (format === 'script') marked = scriptRanges(file, text, problems);
  else marked = [];
  const base = format === 'markdown' ? 'prose' : 'code';
  return { format, ranges: fill(text.length, marked, base), problems };
}

/** Pieces of the text per line (`line` from 1), each inside one zone; empty pieces are left out. */
export function linePieces(text, ranges) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const out = [];
  let line = 0;
  for (const range of ranges) {
    let pos = range.start;
    while (line + 1 < starts.length && starts[line + 1] <= pos) line += 1;
    while (pos < range.end) {
      const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
      const end = Math.min(range.end, lineEnd);
      if (end > pos) out.push({ line: line + 1, zone: range.zone, text: text.slice(pos, end) });
      if (end >= range.end) break;
      pos = lineEnd + 1;
      line += 1;
    }
  }
  return out;
}

/** Ranges in `marked` (sorted, non-overlapping) with the gaps filled by `base`, merged when neighbours share a zone. */
function fill(length, marked, base) {
  const out = [];
  const push = (start, end, zone) => {
    if (end <= start) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.zone === zone && last.end === start) last.end = end;
    else out.push({ start, end, zone });
  };
  let pos = 0;
  for (const range of [...marked].sort((a, b) => a.start - b.start)) {
    if (range.start < pos) throw new Error(`source-zones: overlapping ranges at ${String(range.start)}`);
    push(pos, range.start, base);
    push(range.start, range.end, range.zone);
    pos = range.end;
  }
  push(pos, length, base);
  return out;
}

// ——— TypeScript and JavaScript ———————————————————————————————————————————————————————————————————————————————

/** Test functions whose first string argument is a title. */
const TITLE_FUNCTIONS = new Set(['it', 'test', 'describe', 'suite', 'bench']);
/** Modifiers between a test function and its call: `it.skip(`, `it.each([…])(`, `describe.skipIf(cond)(`. */
const TITLE_MODIFIERS = new Set([
  'skip', 'only', 'todo', 'concurrent', 'sequential', 'fails', 'each', 'skipIf', 'runIf', 'for', 'shuffle',
]);
/**
 * Helpers that take the title and return it with a reason (`macOnly(title, why)`, `checkoutOnly(title)`): their first
 * string argument is a title when the helper call itself stands in the title position.
 */
const TITLE_HELPERS = new Set(['macOnly', 'checkoutOnly']);

/**
 * Index of the last character before `k` that is neither whitespace nor inside a comment (`comments`: 1 at comment
 * positions), or `-1`. A comment between a test call and its title, or right before the call, is not code: the dot that
 * ends a comment sentence must not look like a property access (`x.it(`).
 */
function backOverSpace(text, k, comments) {
  let j = k - 1;
  while (j >= 0 && (comments[j] === 1 || /\s/u.test(text[j]))) j -= 1;
  return j;
}

/** Positions inside string and template content, regex literals and comments of a scan: their brackets are not code. */
function notCode(text, scanned) {
  const skip = new Uint8Array(text.length);
  for (const literal of scanned.literals) skip.fill(1, literal.offset, literal.offset + literal.text.length);
  for (const regex of scanned.regexes) skip.fill(1, regex.offset, regex.offset + regex.source.length + 2);
  for (const comment of scanned.comments) skip.fill(1, comment.start, comment.end);
  return skip;
}

/** Index of the `(` that matches the `)` at `k`, counting brackets backwards outside `skip`; `-1` if none. */
function openingParen(text, k, skip) {
  let depth = 0;
  for (let j = k; j >= 0 && k - j < 20000; j -= 1) {
    if (skip[j] === 1) continue;
    const ch = text[j];
    if (ch === ')' || ch === ']' || ch === '}') depth += 1;
    else if (ch === '(' || ch === '[' || ch === '{') {
      depth -= 1;
      if (depth === 0) return ch === '(' ? j : -1;
    }
  }
  return -1;
}

/**
 * The `(` at `k` opens the call of a test function: `it(`, `test.skip(`, `it.each([…])(`, `describe.skipIf(x)(`.
 * Walks backwards over the callee: a word, a dot and a modifier, or the closed argument list of a modifier.
 */
function isTitleCall(text, k, skip, comments) {
  let j = backOverSpace(text, k, comments);
  for (let steps = 0; steps < 8 && j >= 0; steps += 1) {
    if (text[j] === ')') {
      const open = openingParen(text, j, skip);
      if (open === -1) return false;
      j = backOverSpace(text, open, comments);
      continue;
    }
    let w = j;
    while (w >= 0 && /[\w$]/u.test(text[w])) w -= 1;
    const word = text.slice(w + 1, j + 1);
    if (word === '') return false;
    const before = backOverSpace(text, w + 1, comments);
    if (text[before] === '.' && TITLE_MODIFIERS.has(word)) {
      j = backOverSpace(text, before, comments);
      continue;
    }
    return TITLE_FUNCTIONS.has(word) && text[before] !== '.';
  }
  return false;
}

/** The `(` at `k` opens a title helper call (`macOnly(`) that is itself the first argument of a test call. */
function isHelperTitle(text, k, skip, comments) {
  const j = backOverSpace(text, k, comments);
  let w = j;
  while (w >= 0 && /[\w$]/u.test(text[w])) w -= 1;
  if (!TITLE_HELPERS.has(text.slice(w + 1, j + 1))) return false;
  const open = backOverSpace(text, w + 1, comments);
  return text[open] === '(' && isTitleCall(text, open, skip, comments);
}

/**
 * End (exclusive) of the template literal whose first piece is `literals[index]`. The scanner splits a template at
 * each `${…}`: a piece starts after the opening backtick or after the `}` of an interpolation, and ends at the closing
 * backtick or at `${`. A template nested in an interpolation adds its own pieces in between.
 */
function templateEnd(text, literals, index) {
  let open = 0;
  for (let n = index; n < literals.length; n += 1) {
    const { offset, text: content } = literals[n];
    const before = text[offset - 1];
    if (before !== '`' && before !== '}') continue;
    if (before === '`') open += 1;
    const end = offset + content.length;
    if (text[end] === '`') {
      open -= 1;
      if (open === 0) return end;
    }
  }
  return text.length;
}

function tsRanges(text) {
  const scanned = scan(text);
  const marked = scanned.comments.map((c) => ({ start: c.start, end: c.end, zone: 'comment' }));
  const skip = notCode(text, scanned);
  const comments = new Uint8Array(text.length);
  for (const comment of scanned.comments) comments.fill(1, comment.start, comment.end);
  for (const [index, literal] of scanned.literals.entries()) {
    const quote = literal.offset - 1;
    const opener = text[quote];
    if (opener !== "'" && opener !== '"' && opener !== '`') continue;
    const k = backOverSpace(text, quote, comments);
    if (text[k] !== '(' || !(isTitleCall(text, k, skip, comments) || isHelperTitle(text, k, skip, comments))) continue;
    const end = opener === '`' ? templateEnd(text, scanned.literals, index) : literal.offset + literal.text.length;
    marked.push({ start: literal.offset, end, zone: 'title' });
  }
  return dropNested(marked);
}

/** Ranges with any range that lies inside an earlier one removed (a title inside a comment, a comment in a title). */
function dropNested(marked) {
  const out = [];
  let reach = -1;
  for (const range of [...marked].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (range.start < reach) continue;
    out.push(range);
    reach = range.end;
  }
  return out;
}

// ——— Swift ——————————————————————————————————————————————————————————————————————————————————————————————

/** Characters after which `/` is a prefix (a regex literal may start); after anything else it is an operator. */
const SWIFT_PREFIX_CHARS = new Set(['(', '[', '{', ',', ':', '=', ';', '!', '&', '|', '?', '^', '~', '+', '-', '*', '%', '<', '>']);
/** Keywords after which `/` starts a regex literal. */
const SWIFT_PREFIX_WORD = /(?:^|[^\w$.])(?:return|case|in|try|await|throw|where|if|guard|while|else|repeat|is|as|some|any)$/u;
/** Title attributes of Swift Testing: the string argument of `@Test(` and `@Suite(`. */
const SWIFT_TITLE = /@(?:Test|Suite)\s*\(\s*$/u;

/**
 * Comment and title ranges of Swift source. Strings (with interpolation), raw strings and regex literals are code:
 * their content never starts a comment. Problems: an unterminated block comment, string or extended regex.
 */
export function swiftRanges(text, problems = []) {
  const marked = [];
  /** Last significant character of code (not whitespace, not a comment), for the regex-or-division guess. */
  let lastCode = '';
  let lastCodeAt = -1;
  const lineOf = (at) => text.slice(0, at).split('\n').length;

  /** A string literal at `i` (after its `#` run, at the opening quote); returns the index after the literal. */
  const lexString = (start, hashes) => {
    const quote = start + hashes;
    const multi = text.startsWith('"""', quote);
    const close = (multi ? '"""' : '"') + '#'.repeat(hashes);
    let j = quote + (multi ? 3 : 1);
    const contentStart = j;
    while (j < text.length) {
      if (text.startsWith(close, j)) {
        maybeTitle(start, contentStart, j);
        return j + close.length;
      }
      const ch = text[j];
      if (!multi && ch === '\n') {
        problems.push(`unterminated string at line ${String(lineOf(start))}`);
        return j;
      }
      if (ch === '\\' && text.startsWith('#'.repeat(hashes), j + 1)) {
        const after = j + 1 + hashes;
        if (text[after] === '(') {
          j = lexCode(after + 1, true);
          continue;
        }
        j = after + 1;
        continue;
      }
      j += 1;
    }
    problems.push(`unterminated string at line ${String(lineOf(start))}`);
    return text.length;
  };

  /** The string at `start` is a title when `@Test(` or `@Suite(` stands right before it. */
  const maybeTitle = (start, from, to) => {
    if (SWIFT_TITLE.test(text.slice(Math.max(0, start - 200), start))) marked.push({ start: from, end: to, zone: 'title' });
  };

  /** A bare regex literal `/…/` at `i`; the index after it, or `-1` when it is not one (no closing slash on the line). */
  const bareRegexEnd = (i) => {
    const first = text[i + 1];
    if (first === undefined || first === ' ' || first === '\t' || first === '\n' || first === '/' || first === '*') return -1;
    let inClass = 0;
    for (let j = i + 1; j < text.length && text[j] !== '\n'; j += 1) {
      const ch = text[j];
      if (ch === '\\') j += 1;
      else if (ch === '[') inClass += 1;
      else if (ch === ']' && inClass > 0) inClass -= 1;
      else if (ch === '/' && inClass === 0) return text[j - 1] === ' ' ? -1 : j + 1;
    }
    return -1;
  };

  /** Code from `i`; with `untilParen`, stops after the `)` that closes an interpolation. */
  const lexCode = (start, untilParen) => {
    let i = start;
    let depth = 0;
    while (i < text.length) {
      const ch = text[i];
      const next = text[i + 1];
      if (ch === '/' && next === '/') {
        const end = text.indexOf('\n', i);
        const stop = end === -1 ? text.length : end;
        marked.push({ start: i, end: stop, zone: 'comment' });
        i = stop;
        continue;
      }
      if (ch === '/' && next === '*') {
        let nest = 0;
        let j = i;
        for (; j < text.length; j += 1) {
          if (text[j] === '/' && text[j + 1] === '*') {
            nest += 1;
            j += 1;
          } else if (text[j] === '*' && text[j + 1] === '/') {
            nest -= 1;
            j += 1;
            if (nest === 0) break;
          }
        }
        if (nest !== 0) problems.push(`unterminated block comment at line ${String(lineOf(i))}`);
        const end = Math.min(j + 1, text.length);
        marked.push({ start: i, end, zone: 'comment' });
        i = end;
        continue;
      }
      if (ch === '#') {
        let hashes = 0;
        while (text[i + hashes] === '#') hashes += 1;
        if (text[i + hashes] === '"') {
          i = lexString(i, hashes);
          lastCode = '"';
          lastCodeAt = i;
          continue;
        }
        if (text[i + hashes] === '/') {
          const close = `/${'#'.repeat(hashes)}`;
          let end = -1;
          for (let j = i + hashes + 1; j < text.length; j += 1) {
            if (text[j] === '\\') j += 1;
            else if (text.startsWith(close, j)) {
              end = j;
              break;
            }
          }
          if (end === -1) {
            problems.push(`unterminated regex literal at line ${String(lineOf(i))}`);
            return text.length;
          }
          i = end + close.length;
          lastCode = '/';
          lastCodeAt = i;
          continue;
        }
      }
      if (ch === '"') {
        i = lexString(i, 0);
        lastCode = '"';
        lastCodeAt = i;
        continue;
      }
      if (ch === '/') {
        const before = text.slice(Math.max(0, lastCodeAt - 20), lastCodeAt);
        const prefix = lastCode === '' || SWIFT_PREFIX_CHARS.has(lastCode) || SWIFT_PREFIX_WORD.test(before);
        const end = prefix ? bareRegexEnd(i) : -1;
        if (end !== -1) {
          i = end;
          lastCode = '/';
          lastCodeAt = i;
          continue;
        }
      }
      if (untilParen) {
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          if (depth === 0) return i + 1;
          depth -= 1;
        }
      }
      if (!/\s/u.test(ch)) {
        lastCode = ch;
        lastCodeAt = i + 1;
      }
      i += 1;
    }
    if (untilParen) problems.push('unterminated string interpolation');
    return i;
  };

  lexCode(0, false);
  return dropNested(marked);
}

// ——— Markdown ——————————————————————————————————————————————————————————————————————————————————————————————

/** A fence line: indentation, three or more backticks or tildes, the rest (an info string on the opening fence). */
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/u;

/**
 * Fenced blocks and HTML comments of Markdown. A fence inside an HTML comment is comment; a block closes only at a
 * fence of the same character, at least as long as the opening one, with nothing after it (so a block of four
 * backticks can show a fence of three).
 */
function markdownRanges(text, problems) {
  const marked = [];
  /** Open fenced block: the fence character, its length and where the block started. */
  let fence = null;
  /** End of the last HTML comment; a comment may span lines. */
  let commentEnd = 0;
  let offset = 0;
  for (const line of text.split('\n')) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    if (fence !== null) {
      const m = FENCE.exec(line);
      if (m !== null && m[1][0] === fence.char && m[1].length >= fence.length && m[2].trim() === '') {
        marked.push({ start: fence.start, end, zone: 'block' });
        fence = null;
      }
      continue;
    }
    if (start >= commentEnd) {
      const m = FENCE.exec(line);
      if (m !== null) {
        fence = { char: m[1][0], length: m[1].length, start };
        continue;
      }
    }
    let from = Math.max(start, commentEnd) - start;
    for (let k = line.indexOf('<!--', from); k !== -1; k = line.indexOf('<!--', from)) {
      const at = start + k;
      const close = text.indexOf('-->', at + 4);
      if (close === -1) problems.push(`unterminated HTML comment at offset ${String(at)}`);
      commentEnd = close === -1 ? text.length : close + 3;
      marked.push({ start: at, end: commentEnd, zone: 'comment' });
      from = commentEnd - start;
    }
  }
  if (fence !== null) {
    problems.push('unterminated code fence');
    marked.push({ start: fence.start, end: text.length, zone: 'block' });
  }
  return dropNested(marked);
}

// ——— String catalogs ——————————————————————————————————————————————————————————————————————————————————————————

/** Number of `comment` keys anywhere in a parsed JSON value. */
function commentKeys(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + commentKeys(item), 0);
  if (value === null || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum, [key, item]) => sum + (key === 'comment' ? 1 : 0) + commentKeys(item), 0);
}

function xcstringsRanges(text, problems) {
  const marked = [];
  for (const m of text.matchAll(/^[ \t]*"comment"[ \t]*:[ \t]*"((?:[^"\\\n]|\\.)*)"/gmu)) {
    const start = (m.index ?? 0) + m[0].length - m[1].length - 1;
    marked.push({ start, end: start + m[1].length, zone: 'comment' });
  }
  try {
    const keys = commentKeys(JSON.parse(text));
    if (keys !== marked.length) problems.push(`${String(keys)} comment keys, ${String(marked.length)} found on their own lines`);
  } catch (error) {
    problems.push(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return marked;
}

// ——— Shell, YAML, TOML and other line formats —————————————————————————————————————————————————————————————————

/**
 * A heredoc operator at the lexer position (outside quotes and comments): `<<WORD`, `<<-WORD`, `<<'WORD'`,
 * `<<"WORD"`, `<<\WORD`. The caller rules out a here-string `<<<`.
 */
const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w-]*))/uy;
/**
 * A YAML key or list item that opens a block scalar (`run: |`, `- >-`, `- run: |`), optionally followed by a comment.
 * Groups: the indentation, the list dash with its spaces, the key.
 */
const YAML_BLOCK = /^([ \t]*)(-[ \t]+)?([^#'"\n]*?:[ \t]+)?[|>][+-]?[0-9]?[ \t]*(?:#.*)?$/u;

function scriptRanges(file, text, problems) {
  if (PBXPROJ.test(file)) return pbxprojRanges(text, problems);
  const marked = [];
  const shell = SHELL.test(file);
  const yaml = YAML.test(file);
  /** Quote open across lines (shell only): `'` or `"`. */
  let quote = null;
  /** Heredoc terminators still to come, in order: `{ word, strip }`. */
  let pending = [];
  /** Open heredoc: its terminator and where its body started. */
  let heredoc = null;
  /** Open YAML block scalar: indentation of its key and where the block started. */
  let block = null;
  let offset = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    if (heredoc !== null) {
      const ended = (heredoc.strip ? line.replace(/^\t+/u, '') : line) === heredoc.word;
      if (ended) {
        marked.push({ start: heredoc.start, end, zone: 'data' });
        heredoc = pending.length > 0 ? { ...pending.shift(), start: offset } : null;
      }
      continue;
    }
    if (block !== null) {
      const indent = /^[ \t]*/u.exec(line)?.[0].length ?? 0;
      if (line.trim() === '' || indent > block.indent) {
        block.end = end;
        continue;
      }
      marked.push({ start: block.start, end: block.end, zone: 'data' });
      block = null;
    }
    let commentAt = -1;
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (quote !== null) {
        if (quote === '"' && ch === '\\') j += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\\' && shell) {
        j += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (shell && ch === '<' && line[j + 1] === '<' && line[j + 2] !== '<' && line[j - 1] !== '<') {
        HEREDOC.lastIndex = j;
        const m = HEREDOC.exec(line);
        if (m !== null) {
          pending.push({ word: m[2] ?? m[3] ?? m[4], strip: m[1] === '-' });
          j = HEREDOC.lastIndex - 1;
          continue;
        }
      }
      if (ch === '#' && (j === 0 || /\s/u.test(line[j - 1]))) {
        commentAt = j;
        break;
      }
    }
    if (!shell) quote = null;
    if (commentAt !== -1) marked.push({ start: start + commentAt, end, zone: 'comment' });
    if (shell && pending.length > 0) heredoc = { ...pending.shift(), start: offset };
    if (yaml) {
      const m = YAML_BLOCK.exec(line);
      // The block belongs to the key: under `- run: |` its siblings (`env:`) stand at the column of `run`.
      if (m !== null) {
        const parent = m[1].length + (m[2] !== undefined && m[3] !== undefined ? m[2].length : 0);
        block = { indent: parent, start: offset, end: offset };
      }
    }
  }
  if (heredoc !== null) {
    problems.push(`unterminated heredoc ${heredoc.word}`);
    marked.push({ start: heredoc.start, end: text.length, zone: 'data' });
  }
  if (block !== null && block.end > block.start) marked.push({ start: block.start, end: block.end, zone: 'data' });
  return marked.filter((range) => range.end > range.start);
}

/** Xcode project: `/* … *\/` comments and `//` lines; strings are quoted with `"`. */
function pbxprojRanges(text, problems) {
  const marked = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) problems.push('unterminated block comment');
      const stop = end === -1 ? text.length : end + 2;
      marked.push({ start: i, end: stop, zone: 'comment' });
      i = stop;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      marked.push({ start: i, end: stop, zone: 'comment' });
      i = stop;
      continue;
    }
    i += 1;
  }
  return marked;
}
