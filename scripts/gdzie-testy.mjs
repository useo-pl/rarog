#!/usr/bin/env node
// Which tests cover a source file or a Swift type, each group with a ready command to run it.
//
//   node scripts/gdzie-testy.mjs <source file>        e.g. server/src/herdr/dialogs/layer1/top.ts
//   node scripts/gdzie-testy.mjs <Swift type>         e.g. PermissionCard
//   node scripts/gdzie-testy.mjs <file> --wszystkie   also list the other dependent tests when there are many
//
// Order: tests named after the module (file name, or a synonym from SYNONYMS for test names that translate the
// module name), then for TypeScript and JavaScript the tests that import the module directly (a value import,
// `import()` with a literal path, `vi.mock`; not `import type`), then tests that read the file by path without
// importing it, then the other dependent tests: the rest of the import graph of `vitest related` for TypeScript and
// JavaScript, test classes that use the type for Swift. Every group but the last lists all its tests; more than
// LIST_LIMIT other dependent tests collapse into a count. Exit code 0 with tests, 1 with none ("no tests reference
// this module"), 2 on a usage error. Run from anywhere; the commands it prints run from the repo root.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoFiles as listRepoFiles } from './lib/repo-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST_LIMIT = 15;
/** Test roots of the root `vitest.config.ts` (`test.include`). */
const VITEST_TEST = /^(?:server|shared|relay-vps)\/test\/.+\.test\.ts$/u;
/** Extensions that can sit in the vitest import graph. */
const GRAPH_EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json']);
/** This script's own test names source files only as sample inputs, so it never counts as reading them. */
const SELF_TEST = 'server/test/scripts-gdzie-testy.test.ts';

/**
 * Test-name words for a module name, where the test file name translates it (`config-env.ts` →
 * `env-registry.test.ts`). Keys are module file names without extension; a value is a hyphenated phrase matched as
 * consecutive words of the test name. Only words that real test names use.
 */
const SYNONYMS = {
  'config-env': ['env-registry'],
  observe: ['observation'],
  mode: ['layer1-mode'],
  registry: ['layer1-registry'],
  bind: ['binding'],
  proof: ['evidence'],
  sign: ['znaczniki', 'markers'],
  frames: ['rama', 'frame'],
  consent: ['zgod'],
  refusals: ['odmow', 'refusal'],
  uploads: ['zalaczniki', 'attachments'],
  sentences: ['zdania'],
  dialogs: ['dialogi'],
  session: ['sesj'],
  version: ['wersj'],
  block: ['blok-dialogu'],
  verdict: ['werdykt'],
};

function usage(message) {
  if (message) process.stderr.write(`gdzie-testy: ${message}\n`);
  process.stderr.write('usage: node scripts/gdzie-testy.mjs <source file | Swift type> [--wszystkie]\n');
  process.exit(2);
}

const args = process.argv.slice(2);
const all = args.includes('--wszystkie');
const positional = args.filter((a) => a !== '--wszystkie');
if (positional.length !== 1 || positional[0].startsWith('-')) usage(positional.length > 1 ? 'one module at a time' : '');
const input = positional[0];

const repoFiles = listRepoFiles(ROOT);
const repoFileSet = new Set(repoFiles);
const tsTests = repoFiles.filter((f) => VITEST_TEST.test(f) && f !== SELF_TEST);
const swiftTests = repoFiles.filter((f) => f.endsWith('.swift')
  && (/^native\/Rarog\/Rarog(?:UIKit|UI)Tests\//u.test(f) || /^native\/Rarog\/Packages\/[^/]+\/Tests\//u.test(f)));
const swiftTestSet = new Set(swiftTests);

const cache = new Map();
function read(rel) {
  if (!cache.has(rel)) {
    try { cache.set(rel, readFileSync(path.join(ROOT, rel), 'utf8')); } catch { cache.set(rel, ''); }
  }
  return cache.get(rel);
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Words of a file name: `layer1-top-matching.test.ts` → `layer1`, `top`, `matching` */
const words = (file) => path.basename(file).replace(/\.test\.ts$|\.swift$/u, '').toLowerCase().split(/[-_.]/u);

/** Phrase word against a test-name word: equal, or a stem with at most two more letters (`refusal` ~ `refusals`). */
const wordMatches = (want, have) => want === have
  || (want.length >= 4 && have.startsWith(want) && have.length - want.length <= 2);

function nameMatches(file, phrases) {
  const w = words(file);
  return phrases.some((phrase) => {
    const p = phrase.toLowerCase().split('-');
    for (let i = 0; i + p.length <= w.length; i++) if (p.every((x, k) => wordMatches(x, w[i + k]))) return true;
    return false;
  });
}

/** Text that names the file in a test: the bare file name when it is unique in the repo, else `<dir>/<name>`. */
function mentionPattern(rel) {
  const base = path.basename(rel);
  const unique = repoFiles.filter((f) => path.basename(f) === base).length <= 1;
  if (unique) return new RegExp(`(?<![\\w.+-])${escape(base)}(?!\\w)`, 'u');
  const dir = path.basename(path.dirname(rel));
  return new RegExp(`(?<![\\w.+-])${escape(dir)}(?:/|['"]\\s*,\\s*['"])${escape(base)}(?!\\w)`, 'u');
}

/** `vitest/node`: the import graph (`createVitest`) and the TypeScript parser (`parseAst`). */
async function vitestNode() {
  try {
    return await import('vitest/node');
  } catch {
    return usage('vitest is not installed here: run pnpm install');
  }
}

/** A string literal, or a template literal without substitutions. */
function literalText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
  return null;
}

// The repo compiles with `verbatimModuleSyntax`: `import type { A }` is erased, `import { type A }` stays as an import
// of the module, and a re-export of types only is erased.
const typeOnlyImport = (node) => node.importKind === 'type';
const typeOnlyExport = (node) => node.exportKind === 'type'
  || (node.specifiers?.length > 0 && node.specifiers.every((s) => s.exportKind === 'type'));

/**
 * Specifiers through which a test file runs a module: imports and re-exports that survive compilation, `import()`
 * with a literal path, `vi.mock` and `vi.doMock`. `import type` does not run the module; comments and strings used
 * as data are not code. Null when the file does not parse.
 */
function runtimeSpecifiers(source, parseAst) {
  let ast;
  try {
    ast = parseAst(source, { lang: 'ts' });
  } catch {
    return null;
  }
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'ImportDeclaration') {
      if (!typeOnlyImport(node)) found.push(node.source.value);
      return;
    }
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      && node.source && !typeOnlyExport(node)) found.push(node.source.value);
    if (node.type === 'ImportExpression') found.push(literalText(node.source));
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
      && node.callee.object?.name === 'vi' && ['mock', 'doMock'].includes(node.callee.property?.name)) {
      found.push(literalText(node.arguments[0]));
    }
    for (const value of Object.values(node)) if (value !== null && typeof value === 'object') walk(value);
  };
  walk(ast.body);
  return found.filter((s) => typeof s === 'string');
}

/** Repo file a relative specifier in `from` points at: as written, `.js` for `.ts`, or without an extension. */
function resolveImport(from, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const base = path.posix.join(path.posix.dirname(from), spec);
  const candidates = [base, base.replace(/\.([mc]?)js$/u, '.$1ts'), `${base}.ts`, `${base}/index.ts`];
  return candidates.find((c) => repoFileSet.has(c)) ?? null;
}

/** Test files that run `rel` themselves, not only through another module (see `runtimeSpecifiers`). */
async function directImporters(rel) {
  const { parseAst } = await vitestNode();
  // Only a file that spells the module's name (or its folder's, for `index.ts`) can import it; the rest is not parsed.
  const names = [path.basename(rel).replace(/\.[^.]+$/u, ''), path.basename(path.dirname(rel))];
  return tsTests.filter((t) => {
    if (t === rel || !names.some((n) => read(t).includes(n))) return false;
    const specs = runtimeSpecifiers(read(t), parseAst);
    if (specs === null) {
      process.stderr.write(`gdzie-testy: ${t} does not parse, its imports are not counted\n`);
      return false;
    }
    return specs.some((s) => resolveImport(t, s) === rel);
  });
}

/** Test files that depend on `rel` through imports, from vitest's own module graph (`vitest related`). */
async function vitestRelated(rel) {
  const { createVitest } = await vitestNode();
  const vitest = await createVitest('test', { related: [path.join(ROOT, rel)], watch: false, root: ROOT }, {}, {});
  try {
    const specs = await vitest.getRelevantTestSpecifications();
    return new Set(specs.map((s) => path.relative(ROOT, s.moduleId)).filter((f) => f !== rel));
  } finally {
    await vitest.close();
  }
}

// --- Swift --------------------------------------------------------------------------------------------------------

const SWIFT_DECL = /^[ \t]*(?:@\w+(?:\([^)\n]*\))?\s+)*(?:(?:public|internal|private|fileprivate|final|open|indirect)\s+)*(?:struct|class|enum|actor|protocol|extension)\s+([A-Z]\w*)/gmu;

/** Types a Swift source file declares or extends. */
const swiftTypesOf = (rel) => [...read(rel).matchAll(SWIFT_DECL)].map((m) => m[1]);

/** Test classes and suites in a Swift test file: XCTestCase subclasses, `@Suite` types, top-level `…Tests` types. */
function swiftTestClasses(rel) {
  const lines = read(rel).split('\n');
  const names = [];
  lines.forEach((line, i) => {
    const m = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:final\s+)?(?:class|struct)\s+([A-Z]\w*)([^\n]*)/u.exec(line);
    if (!m) return;
    const suite = lines.slice(Math.max(0, i - 3), i).some((l) => /^@Suite\b/u.test(l)) || /@Suite\b/u.test(line);
    if (suite || /\bXCTestCase\b/u.test(m[2]) || m[1].endsWith('Tests')) names.push(m[1]);
  });
  return names;
}

/** One-run command for a Swift test class (`scripts/ios-test.sh`, which sets the copy language itself). */
function swiftCommand(rel, cls) {
  const app = /^native\/Rarog\/(Rarog(?:UIKit|UI)Tests)\//u.exec(rel);
  if (app) return `bash scripts/ios-test.sh ${app[1]}/${cls}`;
  const pkg = /^native\/Rarog\/Packages\/([^/]+)\/Tests\/([^/]+)\//u.exec(rel);
  if (pkg && /^import UIKit\b/mu.test(read(rel))) return `bash scripts/ios-test.sh ${pkg[2]}/${cls}`;
  return `bash scripts/ios-test.sh --package ${pkg ? pkg[1] : '?'} --filter ${cls}`;
}

// --- input --------------------------------------------------------------------------------------------------------

function resolveFile(arg) {
  for (const candidate of [path.resolve(process.cwd(), arg), path.resolve(ROOT, arg)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const rel = path.relative(ROOT, candidate);
      if (rel.startsWith('..')) usage(`${arg} is outside the repo`);
      return rel;
    }
  }
  return null;
}

const looksLikeType = /^[A-Z]\w*$/u.test(input);
const file = looksLikeType ? null : resolveFile(input);
if (!looksLikeType && !file) usage(`no such file: ${input}`);

/** @type {{ title: string, tests: string[], swift: boolean }[]} */
const groups = [];
const seen = new Set();
function addGroup(title, tests, swift) {
  const fresh = [...new Set(tests)].filter((t) => !seen.has(t)).sort();
  fresh.forEach((t) => seen.add(t));
  if (fresh.length > 0) groups.push({ title, tests: fresh, swift });
}

const isSwift = looksLikeType || file.endsWith('.swift');
if (isSwift) {
  // A bare type name stands for the file of that name too (`PermissionCard` → `PermissionCard.swift`).
  const sourceFile = file ?? repoFiles.find((f) => f.endsWith(`/${input}.swift`) && !swiftTestSet.has(f));
  const stem = looksLikeType ? input : path.basename(file, '.swift').split('+')[0];
  const types = new Set([...(looksLikeType ? [input] : []), ...(sourceFile ? swiftTypesOf(sourceFile) : [])]);
  if (!looksLikeType && types.size === 0) types.add(stem);
  const typeRe = new RegExp(`\\b(?:${[...types].map(escape).join('|')})\\b`, 'u');
  const using = swiftTests.filter((t) => swiftTestClasses(t).length > 0 && typeRe.test(read(t)));
  const mention = sourceFile ? mentionPattern(sourceFile) : null;
  const readers = mention ? [...tsTests, ...swiftTests].filter((t) => mention.test(read(t))) : [];
  addGroup(`Named after ${stem}`, using.filter((t) => swiftTestClasses(t).some((c) => c.startsWith(stem))), true);
  addGroup(`Read ${path.basename(sourceFile ?? '')} by path`, readers, true);
  addGroup(`Other tests that use ${[...types].join(', ')}`, using, true);
} else {
  const ext = path.extname(file);
  const stem = path.basename(file).replace(/(?:\.d)?\.[^.]+$/u, '');
  const name = stem === 'index' ? path.basename(path.dirname(file)) : stem;
  const related = GRAPH_EXT.has(ext) ? await vitestRelated(file) : new Set();
  const direct = GRAPH_EXT.has(ext) ? await directImporters(file) : [];
  const mention = mentionPattern(file);
  const readers = tsTests.filter((t) => t !== file && !related.has(t) && !direct.includes(t) && mention.test(read(t)));
  const candidates = [...related, ...direct, ...readers];
  addGroup('Named after the module', candidates.filter((t) => nameMatches(t, [name, ...(SYNONYMS[name] ?? [])])), false);
  addGroup('Import the module directly', direct, false);
  addGroup(`Read ${path.basename(file)} by path, no import`, readers, false);
  addGroup('Other dependent tests (vitest related)', [...related], false);
}

// --- output -------------------------------------------------------------------------------------------------------

if (groups.length === 0) {
  process.stdout.write(`${file ?? input}: no tests reference this module\n`);
  process.exit(1);
}

const out = [`Tests for ${file ?? input} (commands run from ${ROOT}):`];
groups.forEach((group, index) => {
  const isOther = index === groups.length - 1 && group.title.startsWith('Other');
  // Swift lists test classes (one file may hold several), TypeScript lists files.
  const count = group.swift
    ? group.tests.reduce((n, t) => n + (swiftTestSet.has(t) ? swiftTestClasses(t).length : 1), 0)
    : group.tests.length;
  out.push('');
  if (isOther && !all && count > LIST_LIMIT) {
    out.push(`${group.title}: ${count} more (list them with --wszystkie)`);
    return;
  }
  out.push(`${group.title} (${count}):`);
  if (group.swift) {
    for (const t of group.tests) {
      if (!swiftTestSet.has(t)) {
        out.push(`  ${t}`, `    pnpm exec vitest run ${t}`);
        continue;
      }
      for (const cls of swiftTestClasses(t)) out.push(`  ${cls}  ${t}`, `    ${swiftCommand(t, cls)}`);
    }
  } else {
    for (const t of group.tests) out.push(`  ${t}`);
    out.push(`  run: pnpm exec vitest run ${group.tests.join(' ')}`);
  }
});
process.stdout.write(`${out.join('\n')}\n`);
