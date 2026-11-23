/**
 * Scan of the project roots (`server/src/sessions/project-scan.ts`), the list behind `GET /api/projects`. Its entries
 * pass the directory gate without `validateProjectCwd`, so with the root `~` the macOS-protected folders and the
 * hidden entries must not reach the list, also through a root that is a symlink to home. Runs on a real tree in a
 * temporary directory.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RarogConfig } from '../src/config.ts';
import { checkCwd } from '../src/routes/projects.ts';
import type { ManagerApi } from '../src/sessions/manager-api.ts';
import { scanProjectRoots } from '../src/sessions/project-scan.ts';

let base = '';
let home = '';
let dom = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'rarog-scan-')));
  home = path.join(base, 'demo');
  dom = path.join(base, 'dom');
  for (const dir of ['Projects', 'code', 'Desktop', 'Documents/Projects/p', 'Library', 'Downloads', '.cache']) {
    mkdirSync(path.join(home, dir), { recursive: true });
  }
  symlinkSync(home, dom);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

describe('scanProjectRoots', () => {
  it('with the root ~ lists the folders of home without the protected and the hidden ones', () => {
    expect(scanProjectRoots([home], home).map((entry) => entry.name)).toEqual(['code', 'Projects']);
  });

  it('a root inside ~/Documents lists its own folders', () => {
    const roots = [home, path.join(home, 'Documents', 'Projects')];
    expect(scanProjectRoots(roots, home).map((entry) => entry.path))
      .toEqual([path.join(home, 'code'), path.join(home, 'Documents', 'Projects', 'p'), path.join(home, 'Projects')]);
  });

  it('a missing root gives an empty list', () => {
    expect(scanProjectRoots([path.join(base, 'none')], home)).toEqual([]);
  });

  it('a root that is a symlink to home lists the same folders under its own path', () => {
    expect(scanProjectRoots([dom], home).map((entry) => entry.path))
      .toEqual([path.join(dom, 'code'), path.join(dom, 'Projects')]);
  });

  it('a symlink in a root, into a protected folder or not, is no entry', () => {
    symlinkSync(path.join(home, 'Desktop'), path.join(home, 'desk'));
    symlinkSync(path.join(home, 'code'), path.join(home, 'code-link'));
    expect(scanProjectRoots([home], home).map((entry) => entry.name)).toEqual(['code', 'Projects']);
  });
});

describe('checkCwd on the scanned list', () => {
  const config = (roots: readonly string[]): RarogConfig => ({ demo: false, projectRoots: roots }) as unknown as RarogConfig;
  const manager = (roots: readonly string[]): ManagerApi =>
    ({ projects: () => scanProjectRoots(roots, home) }) as unknown as ManagerApi;

  it('a protected folder behind a root that is a symlink to home is refused, a project there passes', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const desktop = checkCwd(path.join(dom, 'Desktop'), config([dom]), manager([dom]));
    expect(desktop.ok === false && desktop.sentence.ref.code).toBe('rest.cwd-symlink-escape');
    const library = checkCwd(path.join(dom, 'Library'), config([dom]), manager([dom]));
    expect(library.ok).toBe(false);
    expect(checkCwd(path.join(dom, 'code'), config([dom]), manager([dom])))
      .toEqual({ ok: true, cwd: path.join(dom, 'code') });
  });
});
