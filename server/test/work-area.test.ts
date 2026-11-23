/**
 * The work area predicate (`server/src/config/work-area.ts`): one rule for the start of a session, the
 * directory browser, the project scan, the pane scope, the hook, the diff and the command list. The text cases run on
 * made-up paths; the walk runs on a real tree in a temporary directory with a recording disk, because the promise is
 * about what the server touches: nothing inside an excluded folder.
 */
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  excludedFolders, inExcludedOnDisk, inWorkAreaOnDisk, insideWorkArea, isExcludedPath, resolveInWorkArea,
} from '../src/config/work-area.ts';
import type { AreaDisk, WalkDisk } from '../src/config/work-area.ts';

const HOME = '/Users/demo';

describe('insideWorkArea: text only', () => {
  const home = [HOME];

  it('~/Library/x and ~/Desktop/x with the root ~ are outside', () => {
    expect(insideWorkArea(`${HOME}/Library/x`, home, HOME)).toBe(false);
    expect(insideWorkArea(`${HOME}/Desktop/x`, home, HOME)).toBe(false);
    for (const folder of ['Documents', 'Downloads', 'Pictures', 'Movies', 'Music']) {
      expect(insideWorkArea(`${HOME}/${folder}/x`, home, HOME), folder).toBe(false);
      expect(insideWorkArea(`${HOME}/${folder}`, home, HOME), folder).toBe(false);
    }
  });

  it('~/Documents/Projects/x with the roots ~ and ~/Documents/Projects is inside', () => {
    const roots = [HOME, `${HOME}/Documents/Projects`];
    expect(insideWorkArea(`${HOME}/Documents/Projects/x`, roots, HOME)).toBe(true);
    expect(insideWorkArea(`${HOME}/Documents/Projects`, roots, HOME)).toBe(true);
    // The root opens only its own subtree: the folder around it and its siblings stay out.
    expect(insideWorkArea(`${HOME}/Documents`, roots, HOME)).toBe(false);
    expect(insideWorkArea(`${HOME}/Documents/Other`, roots, HOME)).toBe(false);
  });

  it('~/.cache/x is outside; ~ itself and ~/inne/x are inside', () => {
    expect(insideWorkArea(`${HOME}/.cache/x`, home, HOME)).toBe(false);
    expect(insideWorkArea(`${HOME}/.cache/hook-probe`, home, HOME)).toBe(false);
    expect(insideWorkArea(HOME, home, HOME)).toBe(true);
    expect(insideWorkArea(`${HOME}/inne/x`, home, HOME)).toBe(true);
  });

  it('a hidden directory inside a project stays in the area (an agent worktree under .claude/worktrees)', () => {
    expect(insideWorkArea(`${HOME}/Projects/app/.claude/worktrees/agent-1`, home, HOME)).toBe(true);
    // With the root ~/Projects the hidden entry is the root's own, as ~/.cache is for ~.
    expect(insideWorkArea(`${HOME}/Projects/.archive/x`, [`${HOME}/Projects`], HOME)).toBe(false);
  });

  it('outside every root, relative, and a neighbour with a common prefix are outside', () => {
    expect(insideWorkArea('/etc', home, HOME)).toBe(false);
    expect(insideWorkArea('Projects/x', home, HOME)).toBe(false);
    expect(insideWorkArea(`${HOME}x/Projects`, home, HOME)).toBe(false);
    expect(insideWorkArea(`${HOME}/Projects/x`, [], HOME)).toBe(false);
  });

  it('the protected folders compare without case, and a root spelled in another case does not open them', () => {
    expect(insideWorkArea(`${HOME}/desktop/x`, home, HOME)).toBe(false);
    expect(insideWorkArea('/users/demo/Desktop/x', ['/users/demo'], HOME)).toBe(false);
    expect(isExcludedPath(`${HOME}/DOCUMENTS`, home, HOME)).toBe(true);
  });

  it('names compare the way the default macOS disk folds them', () => {
    expect(insideWorkArea(`${HOME}/Movie\u017f`, home, HOME)).toBe(false);
  });

  it('a root inside a protected folder opens only paths spelled like it up to letter case', () => {
    // On a case-sensitive disk strasse and straße are two folders, so the fold that finds a protected folder must
    // not open the sibling of a root.
    const roots = ['/home/demo', '/home/demo/Documents/strasse'];
    expect(insideWorkArea('/home/demo/Documents/strasse/x', roots, '/home/demo')).toBe(true);
    expect(insideWorkArea('/home/demo/documents/STRASSE/x', roots, '/home/demo')).toBe(true);
    expect(insideWorkArea('/home/demo/Documents/stra\u00dfe/x', roots, '/home/demo')).toBe(false);
    expect(isExcludedPath('/home/demo/Documents/stra\u00dfe/x', roots, '/home/demo')).toBe(true);
    // A root spelled with a letter only the fold maps opens nothing in a protected folder: neither the folder it names
    // on the default macOS disk nor the dotless i sibling, which that disk keeps apart from i.
    const folded = [HOME, `${HOME}/Document\u017f/pix`];
    expect(insideWorkArea(`${HOME}/Documents/pix/x`, folded, HOME)).toBe(false);
    expect(insideWorkArea(`${HOME}/Document\u017f/pix/x`, folded, HOME)).toBe(false);
    expect(insideWorkArea(`${HOME}/Documents/p\u0131x/x`, folded, HOME)).toBe(false);
  });

  it('a root outside home is unaffected by the protected folders', () => {
    expect(insideWorkArea('/srv/code/Desktop/x', ['/srv/code'], HOME)).toBe(true);
  });

  it('the hook gets the excluded folders as absolute paths under home', () => {
    expect(excludedFolders(HOME)).toEqual([
      `${HOME}/Desktop`, `${HOME}/Documents`, `${HOME}/Downloads`, `${HOME}/Library`, `${HOME}/Movies`,
      `${HOME}/Music`, `${HOME}/Pictures`,
    ]);
  });
});

describe('resolveInWorkArea: the walk never touches an excluded folder', () => {
  let base = '';
  let home = '';
  const touched: string[] = [];
  const disk: WalkDisk = {
    lstat: (file) => {
      touched.push(file);
      return lstatSync(file);
    },
    readlink: (file) => {
      touched.push(file);
      return readlinkSync(file);
    },
  };
  /** Paths the walk touched inside `<home>/<folder>`, the folder itself excluded. */
  const inside = (folder: string): string[] => touched.filter((file) => file.startsWith(`${path.join(home, folder)}/`));

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'rarog-work-area-')));
    home = path.join(base, 'demo');
    for (const dir of ['Projects/x', 'Desktop/y', 'Documents/Projects/p', 'Documents/Other']) {
      mkdirSync(path.join(home, dir), { recursive: true });
    }
    touched.length = 0;
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('a plain project resolves to itself', () => {
    const dir = path.join(home, 'Projects', 'x');
    expect(resolveInWorkArea(dir, [home], home, disk)).toEqual({ kind: 'resolved', path: dir });
  });

  it('~/Projects/x/link -> ~/Desktop/y is excluded, and nothing inside Desktop is touched', () => {
    const link = path.join(home, 'Projects', 'x', 'link');
    symlinkSync(path.join(home, 'Desktop', 'y'), link);
    expect(resolveInWorkArea(link, [home], home, disk)).toEqual({ kind: 'excluded' });
    expect(touched).toContain(link);
    expect(touched).not.toContain(path.join(home, 'Desktop'));
    expect(inside('Desktop')).toEqual([]);
  });

  it('a relative link into an excluded folder is excluded the same way', () => {
    const link = path.join(home, 'Projects', 'rel');
    symlinkSync('../Desktop/y', link);
    expect(resolveInWorkArea(link, [home], home, disk)).toEqual({ kind: 'excluded' });
    expect(inside('Desktop')).toEqual([]);
  });

  it('the walk passes ~/Documents only on the way to a root inside it', () => {
    const roots = [home, path.join(home, 'Documents', 'Projects')];
    const project = path.join(home, 'Documents', 'Projects', 'p');
    expect(resolveInWorkArea(project, roots, home, disk)).toEqual({ kind: 'resolved', path: project });
    expect(inside('Documents').every((file) => file.startsWith(path.join(home, 'Documents', 'Projects')))).toBe(true);
    touched.length = 0;
    expect(resolveInWorkArea(path.join(home, 'Documents', 'Other'), roots, home, disk)).toEqual({ kind: 'excluded' });
    expect(inside('Documents')).toEqual([]);
  });

  it('a missing segment and a loop of links are missing', () => {
    expect(resolveInWorkArea(path.join(home, 'Projects', 'none'), [home], home, disk)).toEqual({ kind: 'missing' });
    const a = path.join(home, 'Projects', 'a');
    const b = path.join(home, 'Projects', 'b');
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(resolveInWorkArea(a, [home], home, disk)).toEqual({ kind: 'missing' });
  });

  it('a link inside the area resolves like realpath', () => {
    const link = path.join(home, 'Projects', 'to-x');
    symlinkSync('x', link);
    expect(resolveInWorkArea(link, [home], home, disk))
      .toEqual({ kind: 'resolved', path: realpathSync(link) });
  });
});

/*
 * A directory that exists somewhere (a pane's, a session's) against the work area on disk too: the text alone let
 * `<root>/link -> ~/Desktop/x` and a root that is a symlink to home (`/srv/home/Desktop`) through.
 */
describe('inWorkAreaOnDisk: the text, then the walk from the roots and home on disk', () => {
  let base = '';
  let home = '';
  let dom = '';
  const touched: string[] = [];
  const disk: AreaDisk = {
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
  /** Paths touched at `<home>/Desktop` or inside it. */
  const desktop = (): string[] => touched.filter((file) => file === path.join(home, 'Desktop')
    || file.startsWith(`${path.join(home, 'Desktop')}/`));

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'rarog-on-disk-')));
    home = path.join(base, 'demo');
    dom = path.join(base, 'dom');
    for (const dir of ['inne/x', 'Desktop/y', 'Documents/Projects/p', '.cache/z']) {
      mkdirSync(path.join(home, dir), { recursive: true });
    }
    mkdirSync(path.join(base, 'elsewhere'));
    symlinkSync(home, dom);
    touched.length = 0;
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('~/inne/link -> ~/Desktop/y is outside, and nothing in Desktop is touched', () => {
    const link = path.join(home, 'inne', 'link');
    symlinkSync(path.join(home, 'Desktop', 'y'), link);
    expect(insideWorkArea(link, [home], home), 'the text alone lets it in').toBe(true);
    expect(inWorkAreaOnDisk(link, [home], home, disk)).toBe(false);
    expect(touched).toContain(link);
    expect(desktop()).toEqual([]);
  });

  it('a root that is a symlink to home keeps its protected folders out, and the rest of home in', () => {
    expect(insideWorkArea(path.join(dom, 'Desktop', 'y'), [dom], home), 'the text alone lets it in').toBe(true);
    expect(inWorkAreaOnDisk(path.join(dom, 'Desktop', 'y'), [dom], home, disk)).toBe(false);
    expect(inWorkAreaOnDisk(path.join(dom, 'Library', 'z'), [dom], home, disk)).toBe(false);
    expect(desktop()).toEqual([]);
    expect(inWorkAreaOnDisk(path.join(dom, 'inne', 'x'), [dom], home, disk)).toBe(true);
  });

  it('a link to ~/Documents, the folder that holds a root, is outside', () => {
    const roots = [home, path.join(home, 'Documents', 'Projects')];
    const link = path.join(home, 'inne', 'docs');
    symlinkSync(path.join(home, 'Documents'), link);
    expect(inWorkAreaOnDisk(link, roots, home, disk)).toBe(false);
    expect(inWorkAreaOnDisk(path.join(home, 'Documents', 'Projects', 'p'), roots, home, disk)).toBe(true);
  });

  it('a path that does not resolve keeps the verdict of its text', () => {
    expect(inWorkAreaOnDisk(path.join(home, 'gone', 'x'), [home], home, disk)).toBe(true);
    expect(inWorkAreaOnDisk(path.join(home, 'Desktop', 'gone'), [home], home, disk)).toBe(false);
    expect(desktop()).toEqual([]);
  });

  it('a link out of the roots keeps the verdict of its text: on disk only the excluded folders count', () => {
    const out = path.join(home, 'inne', 'out');
    symlinkSync(path.join(base, 'elsewhere'), out);
    expect(inWorkAreaOnDisk(out, [home], home, disk)).toBe(true);
  });

  it('a link that stays in the roots meets the whole rule on its target: a hidden entry of the root is outside', () => {
    const visible = path.join(home, 'visible');
    symlinkSync(path.join(home, '.cache', 'z'), visible);
    expect(insideWorkArea(visible, [home], home), 'the text alone lets it in').toBe(true);
    expect(inWorkAreaOnDisk(visible, [home], home, disk)).toBe(false);
    // A hidden folder inside a project is not an entry of the root itself, so a link to it stays in the area.
    mkdirSync(path.join(home, 'inne', 'x', '.claude'));
    const tools = path.join(home, 'tools');
    symlinkSync(path.join(home, 'inne', 'x', '.claude'), tools);
    expect(inWorkAreaOnDisk(tools, [home], home, disk)).toBe(true);
    // A second root that is the hidden folder itself opens it.
    const config = path.join(home, '.cache', 'z');
    expect(inWorkAreaOnDisk(visible, [home, config], home, disk)).toBe(true);
  });

  it('a root that is a symlink into a protected folder opens the physical path a pane reports, and only that', () => {
    mkdirSync(path.join(home, 'Desktop', 'other'));
    const project = path.join(home, 'Desktop', 'y');
    const code = path.join(base, 'code');
    symlinkSync(project, code);
    for (const roots of [[code], [home, code]]) {
      expect(inWorkAreaOnDisk(project, roots, home, disk), roots.join(', ')).toBe(true);
      expect(inWorkAreaOnDisk(path.join(code, 'gone'), roots, home, disk), roots.join(', ')).toBe(true);
      touched.length = 0;
      expect(inWorkAreaOnDisk(path.join(home, 'Desktop', 'other'), roots, home, disk), roots.join(', ')).toBe(false);
      // Only the root resolves, to the folder it opens; nothing else of Desktop is touched.
      expect(desktop().filter((file) => file !== project)).toEqual([]);
    }
  });
});

/*
 * A directory that may lie outside every root (the git row of a pane outside them) against the excluded folders only:
 * the text, then the walk, so a link into `~/Desktop` or a root that is a symlink to home is caught without a disk call
 * in the folder.
 */
describe('inExcludedOnDisk: an excluded folder as written or on disk, inside the roots or not', () => {
  let base = '';
  let home = '';
  const touched: string[] = [];
  const disk: AreaDisk = {
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
  /** Paths touched at `<home>/<folder>` or inside it. */
  const into = (folder: string): string[] => touched.filter((file) => file === path.join(home, folder)
    || file.startsWith(`${path.join(home, folder)}/`));

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'rarog-excluded-')));
    home = path.join(base, 'demo');
    for (const dir of ['inne/x', 'Desktop/y', 'Desktop/other', 'Documents/Projects/p', 'Documents/Other']) {
      mkdirSync(path.join(home, dir), { recursive: true });
    }
    mkdirSync(path.join(base, 'elsewhere'));
    touched.length = 0;
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('a protected folder as written is excluded with no disk call in it; only the roots and home resolve', () => {
    expect(inExcludedOnDisk(path.join(home, 'Desktop', 'y'), [home], home, disk)).toBe(true);
    expect(inExcludedOnDisk(path.join(home, 'Desktop', 'y'), [], home, disk)).toBe(true);
    expect(into('Desktop')).toEqual([]);
    expect(touched.every((file) => file === home)).toBe(true);
  });

  it('a directory outside every root and outside the protected folders is not excluded', () => {
    expect(inExcludedOnDisk(path.join(base, 'elsewhere'), [path.join(home, 'inne')], home, disk)).toBe(false);
    expect(inExcludedOnDisk(path.join(home, 'inne', 'x'), [home], home, disk)).toBe(false);
    expect(inExcludedOnDisk(path.join(home, 'gone', 'x'), [home], home, disk)).toBe(false);
  });

  it('a link into a protected folder is excluded, and nothing in it is touched', () => {
    const link = path.join(base, 'elsewhere', 'link');
    symlinkSync(path.join(home, 'Desktop', 'y'), link);
    expect(inExcludedOnDisk(link, [path.join(home, 'inne')], home, disk)).toBe(true);
    expect(touched).toContain(link);
    expect(into('Desktop')).toEqual([]);
  });

  it('a root that is a symlink to home keeps its protected folders excluded, with no disk call there', () => {
    const dom = path.join(base, 'dom');
    symlinkSync(home, dom);
    expect(inExcludedOnDisk(path.join(dom, 'Desktop', 'y'), [dom], home, disk)).toBe(true);
    expect(inExcludedOnDisk(path.join(dom, 'inne', 'x'), [dom], home, disk)).toBe(false);
    expect(into('Desktop')).toEqual([]);
  });

  it('a root inside a protected folder opens its subtree, also at the physical path of a root that links there', () => {
    const roots = [home, path.join(home, 'Documents', 'Projects')];
    expect(inExcludedOnDisk(path.join(home, 'Documents', 'Projects', 'p'), roots, home, disk)).toBe(false);
    const docs = path.join(home, 'inne', 'docs');
    symlinkSync(path.join(home, 'Documents'), docs);
    expect(inExcludedOnDisk(docs, roots, home, disk), 'the folder that holds the root').toBe(true);
    const code = path.join(base, 'code');
    symlinkSync(path.join(home, 'Desktop', 'y'), code);
    touched.length = 0;
    expect(inExcludedOnDisk(path.join(home, 'Desktop', 'y'), [code], home, disk)).toBe(false);
    expect(inExcludedOnDisk(path.join(home, 'Desktop', 'other'), [code], home, disk)).toBe(true);
    expect(into('Desktop/other')).toEqual([]);
  });
});
