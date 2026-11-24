/**
 * Path classes of disk access in `server/src`. macOS asks the user before a process reads Desktop, Documents or
 * Downloads, and a disk call there waits for the answer. The rule: disk calls in those folders go through the folder
 * gate (`server/src/folder-gate/`), which waits on them outside the server's own threads. So every module outside
 * `cli/` that imports `fs`, `node:fs`, `node:fs/promises` or `safe-read.ts` names in {@link PATH_CLASSES} where the
 * paths it touches come from, and a new module that reaches the disk without a row fails here instead of slipping
 * past the gate.
 *
 * Detection reads code without comments (`source-scan.ts`) and matches the specifier in every import shape: `from`
 * (also `import type` and re-exports), a bare `import '…'`, `import(…)` and `require(…)`. A type-only import
 * counts: an exemption for it would be a hole a value import could later slip through. String contents stay in the
 * scanned code, so a child process source held in a template literal (`fs-mkdir-child.ts`) counts as well.
 *
 * Files under `server/src/folder-gate/` take the class `port` from their path, never from a row. They do not import a
 * server facade or `config/work-area.ts` (the work area builds on the port, not the other way round), and
 * `relay-worker.ts` does not import any of the disk modules above: the relay thread only moves pipes and messages.
 *
 * A row whose file no longer exists fails; a row whose file stopped importing the disk modules stays, because the
 * class still says where the module's paths come from when it reaches the disk through the port.
 *
 * A module of class `work-area` or `claude-home-via-links` reaches the disk through the port
 * (`server/src/folder-gate/disk.ts`), which sends a call in a guarded folder to its helper. Each value import of a
 * disk module it keeps (a function, `*`, a default) has a row in {@link DIRECT_IMPORTS} that says why those calls stay
 * in the server process; a type-only import needs none, and a row naming an import that is gone fails.
 *
 * Negative cases run on a COPY of `server/src` in a temporary directory: each mutation must fail the guard with the
 * exact violation, and the unchanged copy passes.
 */
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scan, tsFiles } from './source-scan.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = 'server/src';
const CLI_DIR = 'server/src/cli/';
const GATE_DIR = 'server/src/folder-gate/';
const RELAY_WORKER = 'server/src/folder-gate/relay-worker.ts';
const SAFE_READ = 'server/src/safe-read.ts';
const WORK_AREA = 'server/src/config/work-area.ts';
/** The server facades: they compose and delegate, so a folder-gate module never imports them. */
const FACADES = [
  'server/src/sessions/manager.ts',
  'server/src/router.ts',
  'server/src/index.ts',
  'server/src/config.ts',
  'server/src/drivers/herdr-driver.ts',
];

/**
 * Where the paths of a module come from. A module whose paths fall into several classes takes the first one in this
 * order, the most exposed; a trailing comment on its row names the rest.
 */
const CLASS_ORDER = ['work-area', 'claude-home-via-links', 'claude-home', 'data-dir', 'fixed-path'] as const;
type PathClass = (typeof CLASS_ORDER)[number];

const CLASS_MEANING: Readonly<Record<PathClass, string>> = {
  'work-area': 'a path from a project root, a session or pane `cwd`, or a browsed path; it can lie in Desktop, '
    + 'Documents or Downloads, also through a symlink',
  'claude-home-via-links': 'a path under `~/.claude` that the module reads or resolves following symlinks, where users '
    + 'point settings, skills, commands or hooks into other folders',
  'claude-home': 'the Claude Code store under `~/.claude` (transcripts, status line dumps, session registry) '
    + 'and `~/.claude.json`',
  'data-dir': 'the server data directory',
  'fixed-path': 'a path the install or the system fixes: the install tree, an executable, the herdr socket, `/proc`, '
    + 'a volume, the home directory itself',
};

const PATH_CLASSES: Readonly<Record<string, PathClass>> = {
  'server/src/auth/devices-store.ts': 'data-dir',
  'server/src/auth/unix-socket.ts': 'data-dir',
  'server/src/bootstrap/consent.ts': 'claude-home',
  'server/src/bootstrap/hook-files.ts': 'fixed-path',
  'server/src/cli-version.ts': 'claude-home', // also the installer symlink `~/.local/bin/claude`
  'server/src/client-log.ts': 'data-dir',
  'server/src/companion/cli.ts': 'data-dir',
  'server/src/companion/condense.ts': 'claude-home',
  'server/src/config/claude-account.ts': 'claude-home-via-links',
  'server/src/config/herdr.ts': 'fixed-path',
  'server/src/config/push.ts': 'fixed-path', // the APNs key path the owner sets in the config file
  'server/src/config/roots.ts': 'work-area',
  'server/src/config/work-area.ts': 'work-area',
  'server/src/demo/content/named-set.ts': 'fixed-path',
  'server/src/drivers/herdr/consent-no-hook-io.ts': 'claude-home',
  'server/src/drivers/herdr/prompt-queue-store.ts': 'data-dir',
  'server/src/files/listing.ts': 'work-area',
  'server/src/files/path-rule.ts': 'work-area',
  'server/src/files/send-file.ts': 'work-area',
  'server/src/files/session-download.ts': 'work-area',
  'server/src/fs-browse.ts': 'work-area',
  'server/src/fs-mkdir-child.ts': 'work-area',
  'server/src/fs-mkdir.ts': 'work-area',
  'server/src/git-sandbox.ts': 'fixed-path',
  'server/src/git-status.ts': 'work-area',
  'server/src/git-watch.ts': 'work-area',
  'server/src/git-work-tree.ts': 'work-area',
  'server/src/herdr/audit.ts': 'data-dir',
  'server/src/herdr/background/agent-file.ts': 'claude-home',
  'server/src/herdr/background/incremental-read.ts': 'claude-home',
  'server/src/herdr/background/main-scan.ts': 'claude-home',
  'server/src/herdr/background/pull-request-files.ts': 'claude-home',
  'server/src/herdr/background/satellite.ts': 'claude-home',
  'server/src/herdr/background/workflow-run.ts': 'claude-home',
  'server/src/herdr/commands/discover.ts': 'work-area', // also `~/.claude` skills and commands through symlinks
  'server/src/herdr/commands/shape.ts': 'fixed-path', // one entry right under `/`, a name without a slash
  'server/src/herdr/consent-evidence.ts': 'claude-home',
  'server/src/herdr/consent-subagent.ts': 'claude-home',
  'server/src/herdr/dialogs/hook/answers.ts': 'data-dir',
  'server/src/herdr/dialogs/hook/dump.ts': 'data-dir',
  'server/src/herdr/dialogs/layer1/cycle.ts': 'data-dir',
  'server/src/herdr/dialogs/layer1/hook-list/hook-list.ts': 'work-area', // also `~/.claude/settings.json`
  'server/src/herdr/dialogs/layer1/records.ts': 'data-dir',
  'server/src/herdr/dialogs/layer1/version-gate.ts': 'data-dir',
  'server/src/herdr/dialogs/refusals.ts': 'data-dir',
  'server/src/herdr/dialogs/shadow/alive-log.ts': 'data-dir',
  'server/src/herdr/dialogs/shadow/atomic.ts': 'data-dir',
  'server/src/herdr/dialogs/shadow/files.ts': 'data-dir',
  'server/src/herdr/dialogs/shadow/sweep.ts': 'data-dir',
  'server/src/herdr/history-steps.ts': 'claude-home',
  'server/src/herdr/hook-config.ts': 'claude-home-via-links', // also the data directory
  'server/src/herdr/identity.ts': 'data-dir',
  'server/src/herdr/jsonl-follow.ts': 'claude-home',
  'server/src/herdr/provenance.ts': 'work-area',
  'server/src/herdr/session-pulse.ts': 'claude-home',
  'server/src/herdr/statusline.ts': 'claude-home',
  'server/src/herdr/transcript-path.ts': 'claude-home',
  'server/src/herdr/trust.ts': 'work-area', // also `~/.claude.json`
  'server/src/herdr/uploads-registry.ts': 'data-dir',
  'server/src/herdr/uploads.ts': 'work-area', // also the data directory
  'server/src/inbox/removals.ts': 'data-dir',
  'server/src/index.ts': 'claude-home',
  'server/src/install/data-dir.ts': 'data-dir',
  'server/src/install/mode.ts': 'fixed-path',
  'server/src/install/sdk.ts': 'data-dir', // also the install tree
  'server/src/install/service-target.ts': 'fixed-path',
  'server/src/iroh/adapter.ts': 'fixed-path',
  'server/src/live-sessions.ts': 'fixed-path',
  'server/src/mac-stats.ts': 'fixed-path',
  'server/src/notes/store.ts': 'work-area', // also the data directory
  'server/src/notify/apns-devices.ts': 'data-dir',
  'server/src/notify/consent-canary-push.ts': 'data-dir',
  'server/src/notify/weekly-limit.ts': 'data-dir',
  'server/src/pr-status/gh.ts': 'fixed-path',
  'server/src/safe-read.ts': 'work-area', // reads whatever path its callers hand in
  'server/src/sessions/manager.ts': 'data-dir',
  'server/src/sessions/project-scan.ts': 'work-area',
  'server/src/sessions/send-registry.ts': 'data-dir',
  'server/src/term/herdr-backend.ts': 'data-dir',
  'server/src/term/index.ts': 'work-area',
  'server/src/term/registry.ts': 'work-area',
  'server/src/transcript-import.ts': 'claude-home',
  'server/src/usage.ts': 'claude-home',
  'server/src/version-watch.ts': 'data-dir',
  'server/src/version.ts': 'fixed-path',
};

/** The classes whose paths can lie in a guarded folder: their modules reach the disk through the port. */
const PORT_CLASSES: ReadonlySet<PathClass> = new Set<PathClass>(['work-area', 'claude-home-via-links']);

/**
 * Value imports of a disk module that a module of a port class keeps, by file and disk module (`node:fs`,
 * `node:fs/promises`, `safe-read.ts`): calls that run in the server process, not through the port. The comment on each
 * row says why.
 */
const DIRECT_IMPORTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  // `~/.claude/settings.json`, read in the server process for the default model and effort.
  'server/src/config/claude-account.ts': { 'node:fs': ['readFileSync'] },
  // `exactReader` touches no disk: it reads through the port handle `path-rule.ts` opened.
  'server/src/files/session-download.ts': { 'safe-read.ts': ['exactReader'] },
  // The `history` marker in the CLI store under `~/.claude/projects`.
  'server/src/fs-browse.ts': { 'node:fs/promises': ['stat'] },
  // Runs in the child process of one `mkdir`, never in the server.
  'server/src/fs-mkdir-child.ts': { 'node:fs': ['mkdirSync'] },
  // The `history` marker in the CLI store under `~/.claude/projects`.
  'server/src/fs-mkdir.ts': { 'node:fs/promises': ['stat'] },
  // `fs.watch` of the `.git` directory of a session, started only while every guarded folder of the watched
  // directories is open.
  'server/src/git-watch.ts': { 'node:fs': ['watch'] },
  // The hook entries of `~/.claude/settings.json`, the hook copy in `~/.claude/hooks`, the data directory.
  'server/src/herdr/hook-config.ts': {
    'node:fs': [
      'chmodSync', 'linkSync', 'lstatSync', 'mkdirSync', 'readFileSync', 'readdirSync', 'realpathSync', 'renameSync',
      'rmdirSync', 'statSync', 'unlinkSync', 'writeFileSync',
    ],
    'safe-read.ts': ['readRegularFileSync'],
  },
  // `~/.claude.json`, the trust list of Claude Code.
  'server/src/herdr/trust.ts': { 'node:fs/promises': ['readFile', 'stat'] },
  // Notes files in the data directory.
  'server/src/notes/store.ts': {
    'node:fs': ['mkdirSync', 'readFileSync', 'renameSync', 'unlinkSync', 'writeFileSync'],
  },
  // The reader of regular files the port itself runs, in the server process and in a helper.
  'server/src/safe-read.ts': {
    'node:fs': ['closeSync', 'constants', 'fstatSync', 'openSync', 'readSync'],
    'node:fs/promises': ['open', 'readdir'],
  },
};

const FS_SPECIFIER = /^(?:node:)?fs(?:\/promises)?$/;

/** Module specifiers in code without comments, in every import shape (see the header). */
function specifiers(code: string): string[] {
  const shapes = [
    /\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
    // A dynamic import may carry options or a trailing comma after the specifier.
    /\bimport\s*\(\s*(['"`])([^'"`$\n]+)\1\s*[,)]/g,
    /\brequire\s*\(\s*(['"`])([^'"`$\n]+)\1\s*[,)]/g,
  ];
  return shapes.flatMap((shape) => [...code.matchAll(shape)].map((hit) => hit[2] ?? ''));
}

/** A relative specifier as a repo path (`.js` written for a `.ts` file counts as the `.ts` file); else `null`. */
function target(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.js$/, '.ts');
}

const touchesDisk = (file: string, specs: readonly string[]): boolean =>
  specs.some((spec) => FS_SPECIFIER.test(spec) || target(file, spec) === SAFE_READ);

/** A disk module under one name: `node:fs`, `node:fs/promises` or `safe-read.ts`; `null` for any other module. */
function diskModule(file: string, spec: string): string | null {
  if (FS_SPECIFIER.test(spec)) return spec.startsWith('node:') ? spec : `node:${spec}`;
  return target(file, spec) === SAFE_READ ? 'safe-read.ts' : null;
}

/** The value names of a brace list (`a, b as c, type D` gives `a`, `b`). */
const braceNames = (list: string): string[] => list.split(',').map((part) => part.trim())
  .filter((part) => part !== '' && !/^type\s/.test(part))
  .map((part) => part.split(/\s+as\s+/)[0]?.trim() ?? part);

/** The value names of an import clause: `*` for a namespace, `default` for a default import; none for `import type`. */
function clauseNames(clause: string): string[] {
  const text = clause.trim();
  if (/^type[\s{]/.test(text)) return [];
  const brace = /\{([^}]*)\}/.exec(text);
  const outside = text.replace(/\{[^}]*\}/, '').split(',').map((part) => part.trim()).filter((part) => part !== '');
  const named = brace === null ? [] : braceNames(brace[1] ?? '');
  return [...named, ...outside.map((part) => (part.startsWith('*') ? '*' : 'default'))];
}

/** Every value import of a disk module in `code`: the module under its one name and the imported name. */
function diskImports(file: string, code: string): { readonly module: string; readonly name: string }[] {
  const out: { module: string; name: string }[] = [];
  const add = (spec: string, names: readonly string[]): void => {
    const module = diskModule(file, spec);
    if (module !== null) for (const name of names) out.push({ module, name });
  };
  for (const hit of code.matchAll(/\bimport\s+([^'"`;]*?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g)) {
    add(hit[3] ?? '', clauseNames(hit[1] ?? ''));
  }
  for (const hit of code.matchAll(/\bexport\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\3/g)) {
    if (hit[1] === undefined) add(hit[4] ?? '', braceNames(hit[2] ?? ''));
  }
  const whole = [
    /\bexport\s*\*\s*(?:as\s+\w+\s*)?from\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"`])([^'"`$\n]+)\1\s*[,)]/g,
    /\brequire\s*\(\s*(['"`])([^'"`$\n]+)\1\s*[,)]/g,
  ];
  for (const shape of whole) for (const hit of code.matchAll(shape)) add(hit[2] ?? '', ['*']);
  return out;
}

type Violation =
  | { readonly rule: 'no-class'; readonly file: string }
  | { readonly rule: 'direct-import'; readonly file: string; readonly module: string; readonly name: string }
  | { readonly rule: 'stale-direct'; readonly file: string; readonly module: string; readonly name: string }
  | { readonly rule: 'stale-row'; readonly file: string }
  | { readonly rule: 'row-in-port'; readonly file: string }
  | { readonly rule: 'port-import'; readonly file: string; readonly target: string }
  | { readonly rule: 'relay-disk'; readonly file: string; readonly spec: string };

/** Every broken rule of the guard for the `server/src` tree under `root`, judged against `table` and `direct`. */
function violations(
  root: string, table: Readonly<Record<string, PathClass>>,
  direct: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = DIRECT_IMPORTS,
): Violation[] {
  const files = tsFiles(join(root, SRC)).map((full) => relative(root, full).split('\\').join('/'));
  const present = new Set(files);
  const out: Violation[] = [];
  const kept = new Set<string>();
  for (const file of files) {
    if (file.startsWith(CLI_DIR)) continue;
    const code = scan(readFileSync(join(root, file), 'utf8')).code;
    const specs = specifiers(code);
    const pathClass = table[file];
    if (!file.startsWith(GATE_DIR) && pathClass !== undefined && PORT_CLASSES.has(pathClass)) {
      for (const { module, name } of diskImports(file, code)) {
        kept.add(`${file}\0${module}\0${name}`);
        if (!(direct[file]?.[module] ?? []).includes(name)) out.push({ rule: 'direct-import', file, module, name });
      }
    }
    if (file.startsWith(GATE_DIR)) {
      for (const spec of specs) {
        const to = target(file, spec);
        if (to === null || !(FACADES.includes(to) || to === WORK_AREA)) continue;
        out.push({ rule: 'port-import', file, target: to });
      }
      if (file === RELAY_WORKER) {
        for (const spec of specs) {
          if (FS_SPECIFIER.test(spec) || target(file, spec) === SAFE_READ) out.push({ rule: 'relay-disk', file, spec });
        }
      }
      continue;
    }
    if (touchesDisk(file, specs) && !(file in table)) out.push({ rule: 'no-class', file });
  }
  for (const file of Object.keys(table)) {
    if (file.startsWith(GATE_DIR)) out.push({ rule: 'row-in-port', file });
    else if (!present.has(file)) out.push({ rule: 'stale-row', file });
  }
  for (const [file, modules] of Object.entries(direct)) {
    for (const [module, names] of Object.entries(modules)) {
      for (const name of names) {
        if (!kept.has(`${file}\0${module}\0${name}`)) out.push({ rule: 'stale-direct', file, module, name });
      }
    }
  }
  return out;
}

const CLASS_LIST = CLASS_ORDER.map((name) => `  ${name}: ${CLASS_MEANING[name]}`).join('\n');

/** Failure text: what broke, why the rule exists, what to do (a missing row comes with the ready line). */
function explain(found: readonly Violation[]): string {
  const lines = found.map((one) => {
    switch (one.rule) {
      case 'no-class':
        return `${one.file}: imports a disk module without a path class. Add the row, with the right class:\n`
          + `  '${one.file}': '<class>',\nClasses, most exposed first (a mixed module takes the first):\n${CLASS_LIST}`;
      case 'stale-row':
        return `${one.file}: has a row in PATH_CLASSES, but the file does not exist. Remove the row, or move it with `
          + 'the file.';
      case 'row-in-port':
        return `${one.file}: files under ${GATE_DIR} take the class \`port\` from their path. Remove the row.`;
      case 'port-import':
        return `${one.file} imports ${one.target}: the folder gate imports no server facade and not the work area, `
          + 'which builds on the gate. Pass what it needs in through its constructor or a port.';
      case 'relay-disk':
        return `${one.file} imports '${one.spec}': the relay thread only moves pipes and messages; disk calls run `
          + 'in the helper process.';
      case 'direct-import':
        return `${one.file} imports \`${one.name}\` from ${one.module}: its paths can lie in a guarded folder, so it `
          + 'reaches the disk through the port (`server/src/folder-gate/disk.ts`, `DIRECT_DISK`). Use the port; a call '
          + 'whose path can never lie in a guarded folder gets a row in DIRECT_IMPORTS with a comment saying why.';
      case 'stale-direct':
        return `${one.file}: DIRECT_IMPORTS names \`${one.name}\` from ${one.module}, which the file no longer imports `
          + 'as a value of a module of a port class. Remove the name from the row.';
    }
  });
  return `Why: a disk call in Desktop, Documents or Downloads can wait for a macOS consent window; such calls go `
    + `through the folder gate, so every module says where its paths come from.\n`
    + lines.join('\n');
}

/** Runs the guard on a fresh copy of `server/src`, after `mutate` changed the copy. */
async function onCopy(
  mutate: (root: string) => Promise<void>,
  table: Readonly<Record<string, PathClass>> = PATH_CLASSES,
  direct: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = DIRECT_IMPORTS,
): Promise<Violation[]> {
  const root = await mkdtemp(join(tmpdir(), 'fgb-'));
  try {
    await cp(join(REPO, SRC), join(root, SRC), { recursive: true });
    await mutate(root);
    return violations(root, table, direct);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function put(root: string, file: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), text);
}

describe('path classes of disk access in server/src', () => {
  it('the scan sees every import shape the table relies on', () => {
    const disk = tsFiles(join(REPO, SRC)).map((full) => relative(REPO, full).split('\\').join('/'))
      .filter((file) => !file.startsWith(CLI_DIR) && !file.startsWith(GATE_DIR))
      .filter((file) => touchesDisk(file, specifiers(scan(readFileSync(join(REPO, file), 'utf8')).code)));
    expect(disk, 'the disk scan misses a known shape: a multi-line import (hook-config.ts), a type-only import '
      + '(files/send-file.ts), a child source in a template (fs-mkdir-child.ts) or the helper itself (safe-read.ts)')
      .toEqual(expect.arrayContaining([
        'server/src/herdr/hook-config.ts',
        'server/src/files/send-file.ts',
        'server/src/fs-mkdir-child.ts',
        SAFE_READ,
      ]));
  });

  it('every disk module outside cli/ has a class, and every row names an existing file', () => {
    const found = violations(REPO, PATH_CLASSES);
    expect(found, explain(found)).toEqual([]);
  });

  it('an unchanged copy of the sources passes', async () => {
    expect(await onCopy(async () => {})).toEqual([]);
  });

  it('a disk module without a row fails, in every import shape; cli/ stays outside', async () => {
    const found = await onCopy(async (root) => {
      await put(root, 'server/src/zz-from.ts', "import { readFileSync } from 'node:fs';\nreadFileSync('x');\n");
      await put(root, 'server/src/zz-multi.ts', "import {\n  readFile,\n  stat,\n} from 'node:fs/promises';\n");
      await put(root, 'server/src/zz-type.ts', "import type { Stats } from 'fs';\nexport type S = Stats;\n");
      await put(root, 'server/src/zz-dynamic.ts', "export const fs = await import('node:fs');\n");
      await put(root, 'server/src/zz-require.ts', "export const fs = require('node:fs');\n");
      await put(root, 'server/src/zz-dynamic-opts.ts', "export const fs = await import('node:fs', {});\n");
      await put(root, 'server/src/zz-dynamic-comma.ts', "export const fs = await import(\n  './safe-read.ts',\n);\n");
      await put(root, 'server/src/herdr/zz-safe.ts', "import { readRegularFile } from '../safe-read.ts';\n");
      await put(root, 'server/src/cli/zz-cli.ts', "import { readFileSync } from 'node:fs';\n");
      await put(root, 'server/src/zz-comment.ts', "// import { readFileSync } from 'node:fs';\nexport const a = 1;\n");
    });
    expect(found).toEqual([
      'server/src/herdr/zz-safe.ts',
      'server/src/zz-dynamic-comma.ts',
      'server/src/zz-dynamic-opts.ts',
      'server/src/zz-dynamic.ts',
      'server/src/zz-from.ts',
      'server/src/zz-multi.ts',
      'server/src/zz-require.ts',
      'server/src/zz-type.ts',
    ].map((file) => ({ rule: 'no-class', file })));
  });

  it('a row for a file that does not exist fails', async () => {
    const found = await onCopy((root) => rm(join(root, 'server/src/version.ts')));
    expect(found).toEqual([{ rule: 'stale-row', file: 'server/src/version.ts' }]);
  });

  it('a folder-gate file that imports a facade or the work area fails', async () => {
    const found = await onCopy(async (root) => {
      await put(root, 'server/src/folder-gate/zz-manager.ts', "import { x } from '../sessions/manager.ts';\n");
      await put(root, 'server/src/folder-gate/zz-router.ts', "export const r = await import('../router.ts', {});\n");
      await put(root, 'server/src/folder-gate/zz-area.ts', "import type { AreaDisk } from '../config/work-area.ts';\n");
    });
    expect(found).toEqual([
      { rule: 'port-import', file: 'server/src/folder-gate/zz-area.ts', target: WORK_AREA },
      { rule: 'port-import', file: 'server/src/folder-gate/zz-manager.ts', target: 'server/src/sessions/manager.ts' },
      { rule: 'port-import', file: 'server/src/folder-gate/zz-router.ts', target: 'server/src/router.ts' },
    ]);
  });

  it('folder-gate files take `port` from their path: disk imports pass, a row fails', async () => {
    const probe = 'server/src/folder-gate/zz-port.ts';
    const found = await onCopy(
      (root) => put(root, probe,
        "import { lstatSync } from 'node:fs';\nimport { readRegularFile } from '../safe-read.ts';\n"),
      { ...PATH_CLASSES, [probe]: 'work-area' },
    );
    expect(found).toEqual([{ rule: 'row-in-port', file: probe }]);
  });

  it('relay-worker.ts that imports a disk module fails', async () => {
    const found = await onCopy((root) => put(root, RELAY_WORKER,
      "import { Worker } from 'node:worker_threads';\nimport { readFileSync } from 'node:fs';\n"
      + "import { open } from 'node:fs/promises';\n"));
    expect(found).toEqual([
      { rule: 'relay-disk', file: RELAY_WORKER, spec: 'node:fs' },
      { rule: 'relay-disk', file: RELAY_WORKER, spec: 'node:fs/promises' },
    ]);
  });

  it('a work-area module that imports a disk function without a row fails; a type-only import passes', async () => {
    const roots = 'server/src/config/roots.ts';
    const account = 'server/src/config/claude-account.ts';
    const found = await onCopy(async (root) => {
      const add = async (file: string, line: string): Promise<void> => {
        await put(root, file, `${line}\n${readFileSync(join(root, file), 'utf8')}`);
      };
      await add(roots, "import { readdirSync, type Dirent as D } from 'node:fs';");
      await add(roots, "import type { Stats } from 'node:fs';");
      await add(roots, "import * as fsp from 'node:fs/promises';");
      await add(account, "import { statSync } from 'fs';");
      await add('server/src/usage.ts', "import { readdirSync as list } from 'node:fs';");
    });
    expect(found).toEqual([
      { rule: 'direct-import', file: account, module: 'node:fs', name: 'statSync' },
      { rule: 'direct-import', file: roots, module: 'node:fs/promises', name: '*' },
      { rule: 'direct-import', file: roots, module: 'node:fs', name: 'readdirSync' },
    ]);
  });

  it('a row of DIRECT_IMPORTS naming an import the file does not keep fails', async () => {
    const found = await onCopy(async () => {}, PATH_CLASSES, {
      ...DIRECT_IMPORTS, 'server/src/fs-browse.ts': { 'node:fs/promises': ['stat', 'readdir'] },
    });
    expect(found).toEqual([
      { rule: 'stale-direct', file: 'server/src/fs-browse.ts', module: 'node:fs/promises', name: 'readdir' },
    ]);
  });
});
