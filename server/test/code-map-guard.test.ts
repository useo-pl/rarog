/**
 * Code map guard: `docs/code-map.md` has one entry for every directory of the export view under the mapped roots
 * and for every top-level file of `server/src` and `server/src/herdr`, and no entry for anything else.
 *
 * An entry is a list line that starts with a path in backticks: `` - `server/src/auth/` — one sentence ``.
 * A directory entry ends with `/`. A directory counts when it holds at least one file of the export view directly;
 * a container (a path segment with a dot, such as `Rarog.xcodeproj` or `Assets.xcassets`) is one entry for everything
 * inside it.
 * Directories outside the export view are neither required nor allowed: the map is a public document, and the
 * private layer is described elsewhere. In the export the private layer is empty, so the same check runs there.
 *
 * Failure: the message lists the ready lines of missing entries (replace `TODO` with one sentence) and the entries
 * to remove.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIVATE_LAYER, REPO } from './private-guard.ts';
import { repoFiles } from './source-scan.ts';

const DOC = 'docs/code-map.md';
/** Roots whose every directory has an entry. */
const ROOTS = ['server/src', 'shared/src', 'relay', 'relay-auth', 'relay-vps', 'bin', 'scripts', 'native/Rarog'];
/** Directories whose every file has an entry, too. */
const FILE_DIRS = ['server/src', 'server/src/herdr'];
const MAX_LINES = 400;
const PLACEHOLDER = 'TODO';

const under = (file: string, root: string): boolean => file.startsWith(`${root}/`);

/** Directory entry of a file: its parent directory, cut at the first container segment (a segment with a dot). */
function entryDir(file: string): string {
  const segments = file.split('/').slice(0, -1);
  const container = segments.findIndex((segment) => segment.includes('.'));
  return `${(container === -1 ? segments : segments.slice(0, container + 1)).join('/')}/`;
}

/** Entries the map must have for the given files of the export view. */
function requiredEntries(viewFiles: readonly string[]): Set<string> {
  const entries = new Set<string>();
  for (const file of viewFiles) {
    if (!ROOTS.some((root) => under(file, root))) continue;
    entries.add(entryDir(file));
    if (FILE_DIRS.includes(path.posix.dirname(file))) entries.add(file);
  }
  return entries;
}

/** Entries of the document: path in backticks at the start of a list line, with the rest of the line. */
function listedEntries(doc: string): { entry: string; text: string }[] {
  return [...doc.matchAll(/^- `([^`]+)`(.*)$/gmu)].map((hit) => ({ entry: hit[1] ?? '', text: (hit[2] ?? '').trim() }));
}

/** Directories of the private layer under the mapped roots that hold no file of the export view. */
function privateDirs(files: readonly string[], isPrivate: (file: string) => boolean): Set<string> {
  const view = new Set<string>();
  const hidden = new Set<string>();
  for (const file of files) {
    if (!ROOTS.some((root) => under(file, root))) continue;
    for (let at = file.lastIndexOf('/'); at > 0; at = file.lastIndexOf('/', at - 1)) {
      (isPrivate(file) ? hidden : view).add(`${file.slice(0, at)}/`);
    }
  }
  return new Set([...hidden].filter((dir) => !view.has(dir)));
}

/** Everything wrong with the map; an empty list means the map is complete and names only the export view. */
function codeMapProblems(doc: string, files: readonly string[], isPrivate: (file: string) => boolean): string[] {
  const problems: string[] = [];
  const required = requiredEntries(files.filter((file) => !isPrivate(file)));
  const listed = listedEntries(doc);
  const names = listed.map(({ entry }) => entry);
  const hidden = privateDirs(files, isPrivate);
  const privateFiles = files.filter(isPrivate);

  const missing = [...required].filter((entry) => !names.includes(entry)).sort();
  if (missing.length > 0) {
    problems.push(`${DOC}: missing entries; add these lines to the section of their root and replace ${PLACEHOLDER}`
      + ' with one sentence about what lives there:', ...missing.map((entry) => `- \`${entry}\` — ${PLACEHOLDER}`));
  }
  for (const entry of names.filter((name, at) => names.indexOf(name) !== at)) {
    problems.push(`${DOC}: \`${entry}\` is listed twice; keep one entry`);
  }
  for (const { entry, text } of listed) {
    if (required.has(entry)) {
      if (text.replace(/^[—:-]\s*/u, '') === '' || text.includes(PLACEHOLDER)) {
        problems.push(`${DOC}: \`${entry}\` has no sentence; write one sentence about what lives there`);
      }
      continue;
    }
    const isHidden = hidden.has(entry) || privateFiles.includes(entry);
    problems.push(isHidden
      ? `${DOC}: \`${entry}\` is outside the export view; remove the entry (the map is a public document)`
      : `${DOC}: \`${entry}\` is not a directory or mapped file of the export view; remove or fix the entry`);
  }
  for (const dir of [...hidden].sort()) {
    if (doc.includes(dir) || doc.includes(`\`${dir.slice(0, -1)}\``)) {
      problems.push(`${DOC}: names \`${dir}\`, a directory outside the export view; remove it`);
    }
  }
  for (const file of privateFiles.filter((file) => ROOTS.some((root) => under(file, root))).sort()) {
    if (doc.includes(file)) problems.push(`${DOC}: names \`${file}\`, a file outside the export view; remove it`);
  }
  const lines = doc.split('\n').length - (doc.endsWith('\n') ? 1 : 0);
  if (lines > MAX_LINES) {
    problems.push(`${DOC}: ${String(lines)} lines, the limit is ${String(MAX_LINES)}; shorten sentences or entries`);
  }
  return problems;
}

describe('code map guard: rules on a small tree', () => {
  const files = [
    'server/src/index.ts', 'server/src/health.ts', 'server/src/install/mode.ts',
    'server/src/herdr/socket.ts', 'scripts/check.sh', 'scripts/hidden/probe/hook.mjs', 'scripts/hidden.sh',
  ];
  const isPrivate = (file: string): boolean => file.startsWith('scripts/hidden/') || file === 'scripts/hidden.sh';
  const full = [
    '# Code map', '',
    '- `server/src/` — the server.',
    '- `server/src/index.ts` — the entry.',
    '- `server/src/health.ts` — the health route.',
    '- `server/src/install/` — the install layout.',
    '- `server/src/herdr/` — the herdr integration.',
    '- `server/src/herdr/socket.ts` — the socket.',
    '- `scripts/` — repository scripts.',
    '',
  ].join('\n');
  const without = (line: string): string => full.split('\n').filter((row) => !row.startsWith(line)).join('\n');

  it('a complete map has no problems', () => {
    expect(codeMapProblems(full, files, isPrivate)).toEqual([]);
  });

  it('a directory without an entry is red, with the ready line', () => {
    const problems = codeMapProblems(without('- `server/src/install/`'), files, isPrivate);
    expect(problems).toContain(`- \`server/src/install/\` — ${PLACEHOLDER}`);
  });

  it('an entry for a directory that does not exist is red', () => {
    const problems = codeMapProblems(`${full}- \`server/src/gone/\` — nothing.\n`, files, isPrivate);
    expect(problems.join('\n')).toContain('`server/src/gone/` is not a directory or mapped file of the export view');
  });

  it('a top-level file of `server/src` without an entry is red', () => {
    const problems = codeMapProblems(without('- `server/src/health.ts`'), files, isPrivate);
    expect(problems).toContain(`- \`server/src/health.ts\` — ${PLACEHOLDER}`);
  });

  it('a file of `server/src/herdr` without an entry is red', () => {
    const problems = codeMapProblems(without('- `server/src/herdr/socket.ts`'), files, isPrivate);
    expect(problems).toContain(`- \`server/src/herdr/socket.ts\` — ${PLACEHOLDER}`);
  });

  it('a private directory is not required, and naming it is red', () => {
    expect([...requiredEntries(files.filter((file) => !isPrivate(file)))]).not.toContain('scripts/hidden/probe/');
    const listed = codeMapProblems(`${full}- \`scripts/hidden/probe/\` — a probe.\n`, files, isPrivate).join('\n');
    expect(listed).toContain('`scripts/hidden/probe/` is outside the export view');
    const prose = codeMapProblems(`${full}\nSee \`scripts/hidden/\` for the probe.\n`, files, isPrivate).join('\n');
    expect(prose).toContain('names `scripts/hidden/`, a directory outside the export view');
    const file = codeMapProblems(`${full}\nRun \`scripts/hidden.sh\`.\n`, files, isPrivate).join('\n');
    expect(file).toContain('names `scripts/hidden.sh`, a file outside the export view');
  });

  it('an entry without a sentence or with the placeholder is red', () => {
    const problems = codeMapProblems(full.replace('— the health route.', `— ${PLACEHOLDER}`), files, isPrivate);
    expect(problems.join('\n')).toContain('`server/src/health.ts` has no sentence');
  });

  it('a container directory is one entry', () => {
    const app = ['native/Rarog/Rarog.xcodeproj/project.pbxproj', 'native/Rarog/Rarog.xcodeproj/xcshareddata/a.plist'];
    expect([...requiredEntries(app)]).toEqual(['native/Rarog/Rarog.xcodeproj/']);
  });

  it(`a map longer than ${String(MAX_LINES)} lines is red`, () => {
    const long = `${full}${'\nfiller'.repeat(MAX_LINES)}\n`;
    expect(codeMapProblems(long, files, isPrivate).join('\n')).toContain(`the limit is ${String(MAX_LINES)}`);
  });
});

describe('code map guard: the repository', () => {
  it(`${DOC} has an entry for every directory of the export view and nothing else`, () => {
    const doc = readFileSync(path.join(REPO, DOC), 'utf8');
    const problems = codeMapProblems(doc, repoFiles(REPO), (file) => PRIVATE_LAYER.has(file));
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
