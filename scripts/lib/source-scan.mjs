/**
 * TypeScript and JavaScript source scanner: code without comments, a bracket skeleton, string and template
 * literals, and regex literals. Boundary guards in `server/test/` ask about CODE with it, so a quote in a comment
 * or `/*` inside a regex does not hide code from them. `server/test/source-scan.ts` re-exports it for the tests.
 *
 * Pure ESM without imports: runs under bare `node` before `pnpm install`. Types: `source-scan.d.mts`.
 */

/** Words after which `/` starts a regex literal, not a division. */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'default', 'yield', 'await',
]);
/** Words after which a parenthesis is a statement CONDITION: after its closing paren comes a statement, not a divisor. */
const CONTROL_WORD = new Set(['if', 'while', 'for', 'with']);
/** Flags right after the closing slash of a regex (read from `lastIndex`). */
const REGEX_FLAGS = /[a-z]*/y;
const SPACE = /\s/;
const WORD_CHAR = /[\w$]/;

/** Index of the last non-whitespace character of `text` before `end`, or `-1`. */
function lastNonSpace(text, end = text.length) {
  let j = end - 1;
  while (j >= 0 && SPACE.test(text[j])) j -= 1;
  return j;
}

/**
 * The word (a maximal run of `[\w$]`) that ends at index `e` of `text` and is not a property (no `.` before it), with
 * the index where it starts; `null` when `text[e]` is not a word character or a dot precedes the word. Reading the
 * word from the end keeps the scan linear: a regex anchored with `$` over the whole code so far made it quadratic.
 */
function wordEndingAt(text, e) {
  let s = e;
  while (s >= 0 && WORD_CHAR.test(text[s])) s -= 1;
  if (s === e || text[s] === '.') return null;
  return { word: text.slice(s + 1, e + 1), start: s + 1 };
}

/** The code so far ends with a statement keyword before a condition (`if`, `while`, `for`, `for await`, `with`). */
function endsWithControlWord(code) {
  const hit = wordEndingAt(code, lastNonSpace(code));
  if (hit === null) return false;
  if (CONTROL_WORD.has(hit.word)) return true;
  if (hit.word !== 'await' || !SPACE.test(code[hit.start - 1] ?? '')) return false;
  const before = wordEndingAt(code, lastNonSpace(code, hit.start));
  return before !== null && before.word === 'for';
}

/**
 * Scans TypeScript source: guards ask about CODE, and comments may quote anything.
 *
 * Knows strings, templates (with `${…}`) and regex literals: `//` in a URL or `/*` in a pattern does not start a
 * comment, and a quote in a comment does not start a string. String and pattern contents STAY in `code`, because
 * that is where the literals the guards look for live.
 *
 * This is not a parser. Whether `/` starts a pattern is guessed from what precedes it: an operator, a keyword or the
 * end of an `if (…)` condition. A wrong guess is dangerous SILENTLY: a `/*` from a pattern's character class taken
 * for a comment eats the rest of the file and the guard stops seeing. That is why `skeleton` exists: in a correctly
 * scanned file its brackets balance, and an eaten piece of code breaks that balance.
 */
export function scan(source) {
  let code = '';
  let skeleton = '';
  const literals = [];
  const regexes = [];
  const comments = [];
  let i = 0;
  /** Open template `${`: count of nested `{` in each. */
  const interpolations = [];
  /** Open round brackets: whether the bracket is a statement condition. */
  const parens = [];
  /** Length of `code` right after the closing paren of a condition; a `/` right after it starts a pattern. */
  let controlClosedAt = -1;

  const plain = (text) => {
    code += text;
    skeleton += text;
  };

  const copyQuoted = (quote) => {
    const from = i;
    i += 1;
    while (i < source.length && source[i] !== quote && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
    literals.push({ text: source.slice(from + 1, Math.min(i, source.length)), offset: from + 1 });
    i += 1;
    code += source.slice(from, i);
  };

  /** Template content from the current position: up to the closing backtick or up to `${`. */
  const copyTemplate = () => {
    const from = i;
    while (i < source.length) {
      const ch = source[i] ?? '';
      if (ch === '\\') {
        code += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      code += ch;
      i += 1;
      if (ch === '`') {
        literals.push({ text: source.slice(from, i - 1), offset: from });
        return;
      }
      if (ch === '$' && source[i] === '{') {
        literals.push({ text: source.slice(from, i - 1), offset: from });
        plain('{');
        i += 1;
        interpolations.push(0);
        return;
      }
    }
    literals.push({ text: source.slice(from), offset: from });
  };

  /** A regex literal; `false` = not one after all (a newline before its end). */
  const copyRegex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < source.length && source[j] !== '\n') {
      const ch = source[j];
      if (ch === '\\') j += 1;
      else if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        REGEX_FLAGS.lastIndex = j + 1;
        regexes.push({ source: source.slice(i + 1, j), flags: REGEX_FLAGS.exec(source)?.[0] ?? '', offset: i });
        code += source.slice(i, j + 1);
        i = j + 1;
        return true;
      }
      j += 1;
    }
    return false;
  };

  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (ch === '/' && next === '/') {
      const from = i;
      while (i < source.length && source[i] !== '\n') i += 1;
      comments.push({ start: from, end: i });
      continue;
    }
    if (ch === '/' && next === '*') {
      const from = i;
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      comments.push({ start: from, end: i });
      plain(' ');
      continue;
    }
    if (ch === "'" || ch === '"') {
      copyQuoted(ch);
      continue;
    }
    if (ch === '`') {
      code += ch;
      i += 1;
      copyTemplate();
      continue;
    }
    if (interpolations.length > 0 && (ch === '{' || ch === '}')) {
      const depth = interpolations[interpolations.length - 1] ?? 0;
      if (ch === '}' && depth === 0) {
        interpolations.pop();
        plain(ch);
        i += 1;
        copyTemplate();
        continue;
      }
      interpolations[interpolations.length - 1] = depth + (ch === '{' ? 1 : -1);
    }
    if (ch === '/') {
      const e = lastNonSpace(code);
      const last = e === -1 ? '' : code[e];
      // Postfix `++`/`--`: a `/` after them is a division (`n++ / 2`), although the last character is an operator.
      const postfix = (last === '+' || last === '-') && code[e - 1] === last;
      const afterOperator = last === '' || ('(,=:[!&|?{};+-*%<>~^'.includes(last) && !postfix);
      const afterCondition = e + 1 === controlClosedAt;
      const afterWord = !afterOperator && !afterCondition && REGEX_AFTER_WORD.has(wordEndingAt(code, e)?.word ?? '');
      if ((afterOperator || afterCondition || afterWord) && copyRegex()) continue;
    }
    if (ch === '(') parens.push(endsWithControlWord(code));
    plain(ch);
    i += 1;
    if (ch === ')' && parens.pop() === true) controlClosedAt = code.length;
  }
  return { code, skeleton, literals, regexes, comments };
}
