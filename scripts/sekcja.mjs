#!/usr/bin/env node
// Prints one section of a Markdown document, so an agent reads a section instead of the whole file:
//
//     node scripts/sekcja.mjs <file> "<heading>"   the section, up to the next heading of the same or higher level
//     node scripts/sekcja.mjs <file> --spis        every heading with its line number and section size in characters
//
// Matching, first tier with a hit wins: the exact heading text; the same text ignoring case, backticks and leading
// `#`; the text without a trailing parenthetical ("Module map" hits "Module map (server)"). Several hits print
// the candidates and exit 1; a line number from that list (`... <file> 338`) picks one heading. Only ATX headings
// count (`#` to `######`, at most three spaces of indent); lines inside fenced code blocks (``` or ~~~, any fence
// length) are not headings. `<file>` must be a `.md` file inside the repository this script belongs to, after
// resolving symlinks. Exit codes: 0 section printed, 1 no single matching heading, 2 bad arguments or refused file.
// Node only, no dependencies.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main.mjs';

/** Repository root: the parent of `scripts/`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  'Usage: node scripts/sekcja.mjs <file> "<heading>"',
  '       node scripts/sekcja.mjs <file> --spis',
  '',
].join('\n');

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * Headings of a Markdown text, outside fenced code blocks.
 * @param {string} text
 * @returns {{ line: number, level: number, text: string, end: number, chars: number }[]} `line` is 1-based, `end`
 *   is the 1-based line of the next heading of the same or higher level (or one past the last line), `chars` is
 *   the section size in characters (code points) without trailing whitespace.
 */
export function headings(text) {
  const lines = text.split(/\r?\n/);
  /** @type {{ line: number, level: number, text: string, end: number, chars: number }[]} */
  const found = [];
  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  lines.forEach((raw, index) => {
    const fenceMatch = FENCE.exec(raw);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length
        && fenceMatch[2].trim() === '') fence = null;
      return;
    }
    if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      return;
    }
    const atx = ATX.exec(raw);
    if (!atx) return;
    const title = (atx[2] ?? '').replace(/(?:^|[ \t]+)#+$/, '').trim();
    found.push({ line: index + 1, level: atx[1].length, text: title, end: lines.length + 1, chars: 0 });
  });
  for (const [i, heading] of found.entries()) {
    const next = found.slice(i + 1).find((other) => other.level <= heading.level);
    if (next) heading.end = next.line;
    heading.chars = [...sectionText(lines, heading)].length;
  }
  return found;
}

/** @param {string[]} lines @param {{ line: number, end: number }} heading */
function sectionText(lines, heading) {
  return lines.slice(heading.line - 1, heading.end - 1).join('\n').trimEnd();
}

/** @param {string} value */
const loose = (value) => value.replace(/^#+[ \t]*/, '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
/** @param {string} value */
const withoutParenthetical = (value) => value.replace(/\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/, '');

/**
 * Headings that match the query, from the first matching tier.
 * @template {{ text: string, line: number }} H
 * @param {H[]} list
 * @param {string} query
 * @returns {H[]}
 */
export function matchHeadings(list, query) {
  const exact = query.replace(/^#+[ \t]*/, '').trim();
  const tiers = [
    (/** @type {H} */ h) => h.text === exact,
    (/** @type {H} */ h) => loose(h.text) === loose(query),
    (/** @type {H} */ h) => loose(withoutParenthetical(h.text)) === loose(withoutParenthetical(exact)),
  ];
  for (const tier of tiers) {
    const hits = list.filter(tier);
    if (hits.length > 0) return hits;
  }
  if (/^\d+$/.test(query.trim())) return list.filter((h) => h.line === Number(query.trim()));
  return [];
}

/**
 * @param {{ line: number, level: number, text: string }} heading
 * @param {number} width
 */
const headingLine = (heading, width) =>
  `${String(heading.line).padStart(width)}: ${'#'.repeat(heading.level)} ${heading.text}`;

/**
 * Resolves the file argument and checks it: an existing `.md` file inside `root`, symlinks resolved.
 * @param {string} arg
 * @param {string} cwd
 * @param {string} root
 * @returns {{ file: string, shown: string } | { refusal: string }}
 */
function resolveFile(arg, cwd, root) {
  const given = path.resolve(cwd, arg);
  if (path.extname(given).toLowerCase() !== '.md') {
    return { refusal: `refused: ${arg} is not a Markdown file (.md)` };
  }
  let real;
  try {
    real = realpathSync(given);
  } catch {
    return { refusal: `no such file: ${arg}` };
  }
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const relative = path.relative(realRoot, real);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { refusal: `refused: ${arg} is outside the repository (${realRoot})` };
  }
  if (path.extname(real).toLowerCase() !== '.md') {
    return { refusal: `refused: ${arg} points to a file that is not Markdown (.md)` };
  }
  if (!statSync(real).isFile()) return { refusal: `refused: ${arg} is not a regular file` };
  return { file: real, shown: relative };
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, root?: string, stdout?: (text: string) => void, stderr?: (text: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const cwd = io.cwd ?? process.cwd();
  const root = io.root ?? REPO_ROOT;
  const stdout = io.stdout ?? ((text) => { process.stdout.write(text); });
  const stderr = io.stderr ?? ((text) => { process.stderr.write(text); });

  if (argv.includes('--help') || argv.includes('-h')) {
    stdout(USAGE);
    return 0;
  }
  const spis = argv.includes('--spis');
  const rest = argv.filter((arg) => arg !== '--spis');
  const unknown = rest.find((arg) => arg.startsWith('--'));
  if (unknown) {
    stderr(`unknown option: ${unknown}\n${USAGE}`);
    return 2;
  }
  if (rest.length !== (spis ? 1 : 2)) {
    stderr(USAGE);
    return 2;
  }

  const resolved = resolveFile(rest[0], cwd, root);
  if ('refusal' in resolved) {
    stderr(`${resolved.refusal}\n`);
    return 2;
  }
  const text = readFileSync(resolved.file, 'utf8');
  const list = headings(text);
  const width = String(list.at(-1)?.line ?? 1).length;

  if (spis) {
    stdout(list.map((h) => `${headingLine(h, width)} (${h.chars} chars)\n`).join(''));
    return 0;
  }

  const query = rest[1];
  const hits = matchHeadings(list, query);
  if (hits.length === 0) {
    stderr(`no heading matches "${query}" in ${resolved.shown}; list the headings with:\n`
      + `  node scripts/sekcja.mjs ${resolved.shown} --spis\n`);
    return 1;
  }
  if (hits.length > 1) {
    stderr(`${hits.length} headings match "${query}" in ${resolved.shown}; repeat with the full heading text `
      + 'or its line number:\n'
      + hits.map((h) => `  ${headingLine(h, width)}\n`).join(''));
    return 1;
  }
  stdout(`${sectionText(text.split(/\r?\n/), hits[0])}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
