/**
 * The hooks and the work area: `roots.json` carries the excluded folders (`exclude`), and both hooks
 * (`scripts/hooks/rarog-pending.mjs`, `scripts/hooks/rarog-context.mjs`) apply the work area rule when the field is
 * there: a hidden entry of a root (`~/.cache/…`) and a macOS-protected folder of home stay silent, unless a root lies
 * in that folder. A `roots.json` without the field (a server from before) keeps the plain root check; a field that is
 * not a list of absolute paths makes both hooks do nothing. The hooks run as processes, as Claude Code runs them; the
 * server side writes `roots.json` through `prepareHookFiles`.
 *
 * The hooks resolve `cwd` one segment at a time (`scripts/hooks/work-area.mjs`) and never reach an excluded folder on
 * the way: a recorder loaded with `--import` (`helpers/fs-recorder.mjs`) logs every disk call of the hook process, and
 * the walk of the hook module runs against the server's walk on one table with recording disks.
 */
import { spawn } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareHookFiles } from '../src/bootstrap/hook-files.ts';
import type { RarogConfig } from '../src/config.ts';
import { foldCase } from '../src/config/protected-dirs.ts';
import {
  type WalkDisk, type WalkResult, excludedFolders, inWorkAreaOnDisk, insideWorkArea, isExcludedPath, resolveInWorkArea,
} from '../src/config/work-area.ts';
import { readPendingHook } from '../src/herdr/dialogs/hook/dump.ts';
import { writeHookRoots } from '../src/herdr/hook-config.ts';

const HOOKS = join(import.meta.dirname, '..', '..', 'scripts', 'hooks');
const RECORDER = pathToFileURL(join(import.meta.dirname, 'helpers', 'fs-recorder.mjs')).href;
const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const SCRIPTS = ['rarog-pending.mjs', 'rarog-context.mjs'] as const;
type Script = (typeof SCRIPTS)[number];

let dir = '';
let home = '';
let data = '';
let recorded = 0;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'rarog-hook-area-')));
  home = join(dir, 'home');
  data = join(dir, 'data');
  for (const sub of ['.cache/hook-probe', 'Desktop/x', 'inne/x', 'Documents/Projects/p', 'Documents/other']) {
    mkdirSync(join(home, sub), { recursive: true });
  }
  writeHookRoots(data, [home], { exclude: excludedFolders(home) });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The hook as a process; with `fsLog` the recorder logs its disk calls there. */
function run(script: Script, stdin: string, fsLog?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const args = fsLog === undefined ? [join(HOOKS, script)] : ['--import', RECORDER, join(HOOKS, script)];
    const child = spawn(process.execPath, args, {
      env: {
        PATH: process.env['PATH'] ?? '', HOME: home, RAROG_DATA_DIR: data, HERDR_ENV: '1',
        ...(fsLog === undefined ? {} : { FS_RECORDER_LOG: fsLog }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

/** The stdin of each hook for a session in `cwd`. */
const INPUT: Readonly<Record<Script, (cwd: string) => string>> = {
  'rarog-pending.mjs': (cwd) => JSON.stringify({
    session_id: SESSION, cwd, permission_mode: 'auto', hook_event_name: 'PermissionRequest', tool_name: 'Bash',
    tool_input: { command: 'ls', description: 'List' },
  }),
  'rarog-context.mjs': (cwd) => JSON.stringify({
    session_id: SESSION, hook_event_name: 'SessionStart', source: 'startup', cwd,
  }),
};

/**
 * Whether the hook acted for a session in `cwd`: the permission hook left a dump, the context hook added its context.
 * The permission hook never prints anything here.
 */
async function acts(script: Script, cwd: string, fsLog?: string): Promise<boolean> {
  rmSync(join(data, 'pending'), { recursive: true, force: true });
  const result = await run(script, INPUT[script](cwd), fsLog);
  expect(result.code).toBe(0);
  if (script === 'rarog-context.mjs') return result.stdout.includes('additionalContext');
  expect(result.stdout).toBe('');
  return readPendingHook(data, SESSION, () => Date.now()) !== null;
}

/** Whether the permission hook left a dump for a dialog in `cwd`. */
const dumps = (cwd: string): Promise<boolean> => acts('rarog-pending.mjs', cwd);

/** Whether the context hook added its context for a session starting in `cwd`. */
const adds = (cwd: string): Promise<boolean> => acts('rarog-context.mjs', cwd);

/** One disk call of the hook process: the path handed over and, for `realpath` and `readlink`, where it led. */
interface DiskCall {
  readonly fn: string;
  readonly path: string;
  readonly target?: string;
}

/** Whether the hook acted for `cwd`, and every disk call it made on the way. */
async function recordedRun(script: Script, cwd: string): Promise<{ acted: boolean; calls: DiskCall[] }> {
  recorded += 1;
  const log = join(dir, `fs-${String(recorded)}.jsonl`);
  writeFileSync(log, '');
  const acted = await acts(script, cwd, log);
  const calls = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as DiskCall);
  return { acted, calls };
}

/**
 * Calls that reached `folder` or anything in it: by the path handed over, or for `realpath` by the path it resolved to
 * (it looked at every folder on the way). A `readlink` reads the link itself; where the link points is only its text.
 */
const into = (calls: readonly DiskCall[], folder: string): DiskCall[] => calls.filter((call) => [
  call.path, call.fn.startsWith('realpath') ? call.target : undefined,
].some((file) => file !== undefined && (file === folder || file.startsWith(`${folder}/`))));

describe('permission hook with the root ~', () => {
  it('stays silent in ~/.cache/hook-probe and in ~/Desktop/x; writes in ~/inne/x', async () => {
    expect(await dumps(join(home, '.cache', 'hook-probe'))).toBe(false);
    expect(await dumps(join(home, 'Desktop', 'x'))).toBe(false);
    expect(await dumps(join(home, 'inne', 'x'))).toBe(true);
  });

  it('a symlink in the area that leads into ~/Desktop stays silent', async () => {
    symlinkSync(join(home, 'Desktop', 'x'), join(home, 'inne', 'link'));
    expect(await dumps(join(home, 'inne', 'link'))).toBe(false);
  });

  it('a root inside ~/Documents opens its own subtree only', async () => {
    writeHookRoots(data, [home, join(home, 'Documents', 'Projects')], { exclude: excludedFolders(home) });
    expect(await dumps(join(home, 'Documents', 'Projects', 'p'))).toBe(true);
    expect(await dumps(join(home, 'Documents', 'other'))).toBe(false);
  });

  it('roots.json without the field (a server from before) keeps the plain root check', async () => {
    writeFileSync(join(data, 'roots.json'), `${JSON.stringify({ roots: [home] })}\n`);
    expect(await dumps(join(home, '.cache', 'hook-probe'))).toBe(true);
  });
});

describe('context hook with the root ~', () => {
  it('stays silent in a hidden entry and in a protected folder; adds its context elsewhere in home', async () => {
    expect(await adds(join(home, '.cache', 'hook-probe'))).toBe(false);
    expect(await adds(join(home, 'Desktop', 'x'))).toBe(false);
    expect(await adds(join(home, 'inne', 'x'))).toBe(true);
  });
});

describe('the hooks resolve cwd without a disk call in an excluded folder', () => {
  for (const script of SCRIPTS) {
    it(`${script}: ~/inne/link -> ~/Desktop/x stays silent, and nothing in Desktop is touched`, async () => {
      const link = join(home, 'inne', 'link');
      symlinkSync(join(home, 'Desktop', 'x'), link);
      const { acted, calls } = await recordedRun(script, link);
      expect(acted).toBe(false);
      expect(calls.map((call) => call.path), 'the recorder sees the hook resolve cwd').toContain(link);
      expect(into(calls, join(home, 'Desktop'))).toEqual([]);
    });

    it(`${script}: a root that is a symlink to home keeps its Desktop out, with no disk call there`, async () => {
      const dom = join(dir, 'dom');
      symlinkSync(home, dom);
      writeHookRoots(data, [dom], { exclude: excludedFolders(home) });
      const outside = await recordedRun(script, join(dom, 'Desktop', 'x'));
      expect(outside.acted).toBe(false);
      expect(outside.calls.map((call) => call.path), 'the recorder sees the hook resolve cwd').toContain(dom);
      expect(into(outside.calls, join(home, 'Desktop'))).toEqual([]);
      // The rest of home under that root stays in the area.
      expect((await recordedRun(script, join(dom, 'inne', 'x'))).acted).toBe(true);
    });
  }
});

describe('a name the default macOS disk reads as a protected folder', () => {
  /** The long s (U+017F) reads as `s` there; on a case-sensitive disk each of these is a folder of its own. */
  const FOLDED = ['De\u017fktop/x', 'Document\u017f', 'Movie\u017f'] as const;

  for (const script of SCRIPTS) {
    it(`${script}: ~/De\u017fktop/x, ~/Document\u017f and ~/Movie\u017f stay silent, with no disk call in them`,
      async () => {
        for (const rel of FOLDED) {
          mkdirSync(join(home, rel), { recursive: true });
          const top = rel.split('/')[0] ?? rel;
          const { acted, calls } = await recordedRun(script, join(home, rel));
          expect(acted, rel).toBe(false);
          expect(calls.map((call) => call.path), 'the recorder sees the hook resolve the root').toContain(home);
          expect(into(calls, join(home, top)), rel).toEqual([]);
          expect(into(calls, join(home, top.replace('\u017f', 's'))), rel).toEqual([]);
        }
      });
  }
});

describe('a root that is a symlink into a protected folder opens it at its physical path', () => {
  for (const script of SCRIPTS) {
    it(`${script}: acts in the project the root leads to; the rest of the folder stays silent and untouched`,
      async () => {
        const code = join(dir, 'code');
        symlinkSync(join(home, 'Desktop', 'x'), code);
        mkdirSync(join(home, 'Desktop', 'other'));
        writeHookRoots(data, [code], { exclude: excludedFolders(home) });
        expect(await acts(script, join(home, 'Desktop', 'x')), 'the physical path of the root').toBe(true);
        expect(await acts(script, join(code, 'sub-missing')), 'a path that does not resolve').toBe(false);
        const other = await recordedRun(script, join(home, 'Desktop', 'other'));
        expect(other.acted).toBe(false);
        expect(other.calls.map((call) => call.path), 'the recorder sees the hook resolve the root').toContain(code);
        expect(into(other.calls, join(home, 'Desktop', 'other'))).toEqual([]);
      });
  }
});

describe('an exclude field that is not a list of absolute paths makes both hooks do nothing', () => {
  const BAD: readonly (readonly [string, () => unknown])[] = [
    ['null', () => null],
    ['a string', () => '/x'],
    ['an object', () => ({})],
    ['a list with a number', () => [42]],
    ['a list with a folder and a number', () => [join(home, 'Desktop'), 42]],
    ['a list with a relative path', () => ['Desktop']],
  ];
  for (const [label, excludeOf] of BAD) {
    it(`exclude: ${label}`, async () => {
      const exclude = excludeOf();
      writeFileSync(join(data, 'roots.json'), `${JSON.stringify({ roots: [home], exclude })}\n`);
      for (const cwd of [join(home, 'Desktop', 'x'), join(home, 'inne', 'x')]) {
        expect(await dumps(cwd), cwd).toBe(false);
        expect(await adds(cwd), cwd).toBe(false);
      }
    });
  }

  it('an empty list is a list: the rule without excluded folders', async () => {
    writeFileSync(join(data, 'roots.json'), `${JSON.stringify({ roots: [home], exclude: [] })}\n`);
    expect(await dumps(join(home, 'inne', 'x'))).toBe(true);
    expect(await adds(join(home, '.cache', 'hook-probe'))).toBe(false);
  });
});

/** The disk of a walk, with `realpath` for the roots, recording every path it is handed and every path it leads to. */
interface RecordingDisk extends WalkDisk {
  readonly realpath: (file: string) => string;
  readonly touched: string[];
}

function recordingDisk(): RecordingDisk {
  const touched: string[] = [];
  return {
    touched,
    lstat: (file) => {
      touched.push(file);
      return lstatSync(file);
    },
    readlink: (file) => {
      touched.push(file);
      return readlinkSync(file);
    },
    realpath: (file) => {
      touched.push(file);
      const target = realpathSync(file);
      touched.push(target);
      return target;
    },
  };
}

/** The hook's work area module, imported as a file: `.mjs` lies outside the server's TS project. */
interface HookArea {
  resolveInWorkArea(candidate: string, roots: readonly string[], exclude: readonly string[], disk?: WalkDisk): WalkResult;
  insideRoots(cwd: string, roots: readonly string[], exclude: readonly string[] | null, disk?: RecordingDisk): boolean;
  foldCase(value: string): string;
}

describe('work-area.mjs folds names like the server', () => {
  /**
   * A name and its folded form. The single code points the default macOS disk reads as ASCII letters fold to them;
   * the dotless i stays apart from i, as on that disk. Spellings that disk reads as one name fold alike, also a letter
   * with several marks whose case mapping decomposes it (`ẖ` upper-cases to `H` and a combining macron below).
   */
  const FOLDS: readonly (readonly [string, string])[] = [
    ['Desktop', 'desktop'],
    ['DOCUMENTS', 'documents'],
    ['De\u017fktop', 'desktop'],
    ['/Users/demo/Movie\u017f/x', '/users/demo/movies/x'],
    ['\u00df', 'ss'],
    ['\u1e9e', 'ss'],
    ['\u017f', 's'],
    ['\u212a', 'k'],
    ['\ufb00', 'ff'],
    ['\ufb01', 'fi'],
    ['\ufb02', 'fl'],
    ['\ufb03', 'ffi'],
    ['\ufb04', 'ffl'],
    ['\ufb05', 'st'],
    ['\ufb06', 'st'],
    ['p\u0131x', 'p\u0131x'],
    ['\u0130', 'i\u0307'],
    ['PI\u0301', 'p\u00ed'],
    ['H\u0331\u0302', '\u1e96\u0302'],
    ['h\u0331\u0302', '\u1e96\u0302'],
    ['\u0124\u0331', '\u1e96\u0302'],
    ['\u1e96\u0302', '\u1e96\u0302'],
    ['\u0386\u0301\u0345', '\u03ac\u0301\u03b9'],
    ['\u1fb4\u0301', '\u03ac\u0301\u03b9'],
  ];

  it.each(FOLDS.map(([name, folded]) => [name, folded] as const))('%s folds to %s in both copies',
    async (name, folded) => {
      const hook = await import(pathToFileURL(join(HOOKS, 'work-area.mjs')).href) as HookArea;
      expect(foldCase(name), 'server').toBe(folded);
      expect(hook.foldCase(name), 'hook').toBe(folded);
    });
});

/** A disk that answers from the text alone: `realpath` returns its argument and nothing is a symlink. */
function textDisk(): RecordingDisk {
  const touched: string[] = [];
  return {
    touched,
    lstat: (file) => {
      touched.push(file);
      return { isSymbolicLink: () => false };
    },
    readlink: (file) => {
      touched.push(file);
      throw new Error(`not a link: ${file}`);
    },
    realpath: (file) => {
      touched.push(file);
      return file;
    },
  };
}

describe('a root inside a protected folder opens only paths spelled like it up to letter case', () => {
  // On a case-sensitive disk strasse and straße are two folders, so the fold that finds a protected folder must not
  // open the sibling of a root. The disk answers from the text, so the verdict does not depend on the file system.
  const HOME = '/home/demo';
  const sibling = `${HOME}/Documents/stra\u00dfe`;
  const inSibling = (file: string): boolean => file === sibling || file.startsWith(`${sibling}/`);

  it('the server predicate and the hook refuse ~/Documents/stra\u00dfe/x next to the root ~/Documents/strasse, with no'
    + ' disk call there', async () => {
    const hook = await import(pathToFileURL(join(HOOKS, 'work-area.mjs')).href) as HookArea;
    const roots = [HOME, `${HOME}/Documents/strasse`];
    const exclude = excludedFolders(HOME);
    for (const [cwd, verdict] of [[`${HOME}/Documents/strasse/x`, true], [`${sibling}/x`, false]] as const) {
      const serverDisk = textDisk();
      const hookDisk = textDisk();
      expect(inWorkAreaOnDisk(cwd, roots, HOME, serverDisk), `server: ${cwd}`).toBe(verdict);
      expect(hook.insideRoots(cwd, roots, exclude, hookDisk), `hook: ${cwd}`).toBe(verdict);
      expect(serverDisk.touched.filter(inSibling), `server disk calls: ${cwd}`).toEqual([]);
      expect(hookDisk.touched.filter(inSibling), `hook disk calls: ${cwd}`).toEqual([]);
    }
  });

  it('the walk passes ~/Documents on the way to the root ~/Documents/stra\u00dfe/p, but does not enter'
    + ' ~/Documents/strasse', async () => {
    const hook = await import(pathToFileURL(join(HOOKS, 'work-area.mjs')).href) as HookArea;
    const roots = [HOME, `${sibling}/p`];
    const cwd = `${HOME}/Documents/strasse/x`;
    const serverDisk = textDisk();
    const hookDisk = textDisk();
    expect(resolveInWorkArea(cwd, roots, HOME, serverDisk), 'server').toEqual({ kind: 'excluded' });
    expect(hook.resolveInWorkArea(cwd, roots, excludedFolders(HOME), hookDisk), 'hook').toEqual({ kind: 'excluded' });
    expect(serverDisk.touched).toEqual(['/home', HOME, `${HOME}/Documents`]);
    expect(hookDisk.touched).toEqual(serverDisk.touched);
  });
});

describe('two spellings of one home fold alike', () => {
  /**
   * The home as created and as typed in `cwd`, once decomposed (NFD) and once composed (NFC). `ẖ` upper-cases to `H`
   * and a combining macron below, so a fold that composes before the case mapping keeps the two spellings apart, and a
   * root above home opens that home's Desktop. The default macOS disk reads both as one folder; elsewhere each is
   * created on its own.
   */
  const SPELLINGS = [['H\u0331\u0302', 'h\u0331\u0302'], ['\u0124\u0331', '\u1e96\u0302']] as const;

  it.each(SPELLINGS)('home %s: %s/Desktop/x with the root / is refused by the server and the hook, with no disk call'
    + ' in Desktop', async (stored, typed) => {
    const hook = await import(pathToFileURL(join(HOOKS, 'work-area.mjs')).href) as HookArea;
    const parent = mkdtempSync(join(dir, 'spelling-'));
    const homeDir = join(parent, stored);
    const cwd = join(parent, typed, 'Desktop', 'x');
    mkdirSync(join(homeDir, 'Desktop', 'x'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const desktops = [join(homeDir, 'Desktop'), join(parent, typed, 'Desktop')];
    const inDesktop = (file: string): boolean => desktops.some((desktop) => file === desktop
      || file.startsWith(`${desktop}/`));
    const exclude = excludedFolders(homeDir);
    const disks = [recordingDisk(), recordingDisk(), recordingDisk(), recordingDisk()] as const;
    expect(insideWorkArea(cwd, ['/'], homeDir), 'server text').toBe(false);
    expect(resolveInWorkArea(cwd, ['/'], homeDir, disks[0]), 'server walk').toEqual({ kind: 'excluded' });
    expect(inWorkAreaOnDisk(cwd, ['/'], homeDir, disks[1]), 'server on disk').toBe(false);
    expect(hook.resolveInWorkArea(cwd, ['/'], exclude, disks[2]), 'hook walk').toEqual({ kind: 'excluded' });
    expect(hook.insideRoots(cwd, ['/'], exclude, disks[3]), 'hook').toBe(false);
    expect(disks[2].touched, 'the walk resolves home as typed').toContain(join(parent, typed));
    for (const disk of disks) expect(disk.touched.filter(inDesktop)).toEqual([]);
  });
});

describe('work-area.mjs and the server walk agree on one table', () => {
  /** `cwd`, the roots (`home` or `dom`, with `docs` adding `~/Documents/Projects`) and the verdict. */
  const CASES: readonly (readonly [string, 'home' | 'docs' | 'dom', boolean])[] = [
    ['inne/x', 'home', true],
    ['inne/ok', 'home', true],
    ['inne/link', 'home', false],
    ['inne/rel', 'home', false],
    ['inne/out', 'home', false],
    ['inne/hidden', 'home', false],
    ['inne/loop-a', 'home', false],
    ['inne/none', 'home', false],
    ['Desktop/x', 'home', false],
    ['.cache/hook-probe', 'home', false],
    ['Documents/Projects/p', 'docs', true],
    ['Documents/other', 'docs', false],
    ['inne/docs', 'docs', false],
    ['@dom/inne/x', 'dom', true],
    ['@dom/inne/link', 'dom', false],
    ['@dom/Desktop/x', 'dom', false],
    ['@dom/Library/x', 'dom', false],
    ['visible', 'home', false],
  ];

  let hook: HookArea;

  beforeEach(async () => {
    hook = await import(pathToFileURL(join(HOOKS, 'work-area.mjs')).href) as HookArea;
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(home, 'Desktop', 'x'), join(home, 'inne', 'link'));
    symlinkSync('../Desktop/x', join(home, 'inne', 'rel'));
    symlinkSync('x', join(home, 'inne', 'ok'));
    symlinkSync(join(dir, 'elsewhere'), join(home, 'inne', 'out'));
    symlinkSync(join(home, 'Documents'), join(home, 'inne', 'docs'));
    symlinkSync(join(home, '.cache', 'hook-probe'), join(home, 'inne', 'hidden'));
    symlinkSync(join(home, '.cache', 'hook-probe'), join(home, 'visible'));
    symlinkSync('loop-b', join(home, 'inne', 'loop-a'));
    symlinkSync('loop-a', join(home, 'inne', 'loop-b'));
    symlinkSync(home, join(dir, 'dom'));
  });

  const rootsOf = (kind: 'home' | 'docs' | 'dom'): string[] => (kind === 'home' ? [home]
    : kind === 'docs' ? [home, join(home, 'Documents', 'Projects')] : [join(dir, 'dom')]);
  const pathOf = (rel: string): string => (rel.startsWith('@dom/') ? join(dir, 'dom', rel.slice(5)) : join(home, rel));

  it.each(CASES.map(([rel, kind, verdict]) => [rel, kind, verdict] as const))('%s with the roots %s', (rel, kind, verdict) => {
    const cwd = pathOf(rel);
    const roots = rootsOf(kind);
    const realRoots = roots.map((root) => realpathSync(root));
    const exclude = excludedFolders(home);
    const serverDisk = recordingDisk();
    const hookDisk = recordingDisk();
    const server = resolveInWorkArea(cwd, realRoots, home, serverDisk);
    expect(hook.resolveInWorkArea(cwd, realRoots, exclude, hookDisk), 'walk result').toEqual(server);
    expect(hookDisk.touched, 'disk calls of the walk').toEqual(serverDisk.touched);
    // The predicate of the hook against the server rule: the text first, then the resolved path in the area.
    const serverVerdict = !isExcludedPath(cwd, roots, home) && server.kind === 'resolved'
      && insideWorkArea(server.path, realRoots, home);
    const predicateDisk = recordingDisk();
    expect(hook.insideRoots(cwd, roots, exclude, predicateDisk), 'hook verdict').toBe(serverVerdict);
    expect(serverVerdict, 'expected verdict').toBe(verdict);
    // The server's own predicate gives the same verdict wherever the walk is excluded or ends in the roots. A path that
    // does not resolve or leads out of every root keeps its text verdict on the server and is outside for the hook.
    const endsInRoots = server.kind === 'resolved'
      && realRoots.some((root) => server.path === root || server.path.startsWith(`${root}/`));
    if (server.kind === 'excluded' || endsInRoots) {
      expect(inWorkAreaOnDisk(cwd, roots, home), 'server predicate on disk').toBe(verdict);
    }
    const desktop = join(home, 'Desktop');
    expect([...hookDisk.touched, ...predicateDisk.touched]
      .filter((file) => file === desktop || file.startsWith(`${desktop}/`))).toEqual([]);
  });

  it('a root that is a symlink into ~/Desktop: the physical path counts, the rest of Desktop stays untouched', () => {
    const code = join(dir, 'code');
    symlinkSync(join(home, 'Desktop', 'x'), code);
    mkdirSync(join(home, 'Desktop', 'other'));
    const exclude = excludedFolders(home);
    const inside = recordingDisk();
    expect(hook.insideRoots(join(home, 'Desktop', 'x'), [code], exclude, inside)).toBe(true);
    expect(hook.insideRoots(join(code, 'sub'), [code], exclude)).toBe(false);
    const outside = recordingDisk();
    expect(hook.insideRoots(join(home, 'Desktop', 'other'), [code], exclude, outside)).toBe(false);
    // Only the root resolves, to the folder it opens; nothing of the rest of Desktop is touched.
    expect(outside.touched).toEqual([code, join(home, 'Desktop', 'x')]);
    const documents = recordingDisk();
    expect(hook.insideRoots(join(home, 'Documents', 'other'), [code], exclude, documents)).toBe(false);
    expect(documents.touched.filter((file) => file.startsWith(join(home, 'Documents')))).toEqual([]);
  });

  it('a root that is a symlink into ~/Desktop, alone or next to ~: the server predicate and the hook agree, and'
    + ' neither touches a protected folder no root opens', () => {
    const code = join(dir, 'code');
    const project = join(home, 'Desktop', 'x');
    symlinkSync(project, code);
    mkdirSync(join(project, 'sub'));
    mkdirSync(join(home, 'Desktop', 'other'));
    const exclude = excludedFolders(home);
    /** `cwd`, the verdict with the root `code` alone, the verdict with `~` next to it. */
    const CASES_LINK: readonly (readonly [string, boolean, boolean])[] = [
      [project, true, true],
      [join(project, 'sub'), true, true],
      [code, true, true],
      [join(code, 'sub'), true, true],
      [join(home, 'Desktop', 'other'), false, false],
      [join(home, 'Desktop'), false, false],
      [join(home, 'Documents', 'other'), false, false],
      [join(home, 'inne', 'x'), false, true],
      [join(home, '.cache', 'hook-probe'), false, false],
    ];
    /** A path in a protected folder of home that is neither the root's target nor the folder on the way to it. */
    const unopened = (file: string): boolean => isExcludedPath(file, [project], home)
      && file !== join(home, 'Desktop');
    for (const [cwd, alone, withHome] of CASES_LINK) {
      for (const [roots, verdict] of [[[code], alone], [[home, code], withHome]] as const) {
        const serverDisk = recordingDisk();
        const hookDisk = recordingDisk();
        const label = `${cwd} with the roots ${roots.join(', ')}`;
        expect(inWorkAreaOnDisk(cwd, roots, home, serverDisk), `server: ${label}`).toBe(verdict);
        expect(hook.insideRoots(cwd, roots, exclude, hookDisk), `hook: ${label}`).toBe(verdict);
        expect(serverDisk.touched.filter(unopened), `server disk calls: ${label}`).toEqual([]);
        expect(hookDisk.touched.filter(unopened), `hook disk calls: ${label}`).toEqual([]);
      }
    }
  });

  it('without exclude (a server from before) only the roots count, after realpath', () => {
    expect(hook.insideRoots(join(home, '.cache', 'hook-probe'), [home], null)).toBe(true);
    expect(hook.insideRoots(join(home, 'inne', 'out'), [home], null)).toBe(false);
    expect(hook.insideRoots(join(home, 'inne', 'none'), [home], null)).toBe(false);
  });
});

describe('roots.json written at start', () => {
  it('carries the roots as before and the excluded folders of the real home', () => {
    const logs: string[] = [];
    const log = { info: (line: string) => { logs.push(line); }, error: (line: string) => { logs.push(line); } };
    prepareHookFiles({ dataDir: data, herdrRoots: [home], tallDialogGuard: false } as unknown as RarogConfig,
      log as never);
    const written = JSON.parse(readFileSync(join(data, 'roots.json'), 'utf8')) as Record<string, unknown>;
    expect(written).toEqual({ roots: [home], exclude: excludedFolders(realpathSync(homedir())) });
  });
});
