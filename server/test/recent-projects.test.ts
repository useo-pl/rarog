/**
 * Recent projects for the New Session sheet (`server/src/sessions/recent-projects.ts`). The port stands in for the
 * manager: the allow-list passes the projects under `ROOT`, the clock is fixed. The corpus case goes through the
 * real session list adapter (`createSessionListReader`) with an SDK stand-in that honours `limit`, because the bug
 * it guards against was the adapter's fetch cap cutting the corpus before the allow-list filter.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_RECENT_PROJECTS } from '@rarog/shared';
import type { ResumableSession } from '@rarog/shared';
import { ENGINE_SESSION_FETCH_CAP, createSessionListReader } from '../src/session-list.ts';
import type { EngineSessionInfo, EngineSessionLister } from '../src/session-list.ts';
import { validateProjectCwd } from '../src/config.ts';
import { recentProjects } from '../src/sessions/recent-projects.ts';
import type { OpenSessionRef, RecentProjectsPort } from '../src/sessions/recent-projects.ts';

const ROOT = '/Users/demo/Projects';
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

const entry = (cwd: string, at: number, id = `${cwd}@${String(at)}`): ResumableSession => ({
  engineSessionId: id, cwd, mtime: iso(at), firstPrompt: 'x', liveInHerdr: false,
});

function port(
  readSessions: RecentProjectsPort['readSessions'], open: readonly OpenSessionRef[] = [],
): RecentProjectsPort {
  return {
    readSessions,
    isAllowedCwd: (cwd) => cwd.startsWith(`${ROOT}/`),
    openSessions: () => open,
    now: () => NOW,
  };
}

/** SDK stand-in: the corpus newest first, cut to `limit` like `listSessions()`. */
function sdk(corpus: readonly EngineSessionInfo[]): EngineSessionLister & { calls: number[] } {
  const calls: number[] = [];
  const lister = (opts: { limit?: number }): Promise<EngineSessionInfo[]> => {
    calls.push(opts.limit ?? Infinity);
    return Promise.resolve(corpus.slice(0, opts.limit ?? corpus.length));
  };
  return Object.assign(lister, { calls });
}

const info = (cwd: string, at: number, i: number): EngineSessionInfo => ({
  sessionId: `s${String(i)}`, summary: 'x', lastModified: at, cwd,
});

describe('recentProjects', () => {
  it('233 of the 300 newest sessions outside the work area do not push projects out', async () => {
    const corpus: EngineSessionInfo[] = [];
    // The 300 newest, all within the last two days: every fourth of the first 268 (67 sessions) in two projects,
    // the other 233 outside the roots.
    for (let i = 0; i < 300; i += 1) {
      const inArea = i % 4 === 0 && i / 4 < 67;
      const cwd = inArea ? `${ROOT}/${(i / 4) % 2 === 0 ? 'atlas' : 'birch'}` : `/Users/demo/elsewhere/p${String(i)}`;
      corpus.push(info(cwd, NOW - i * 10 * 60 * 1000, i));
    }
    expect(corpus.filter((s) => !s.cwd?.startsWith(ROOT))).toHaveLength(233);
    // Older but still inside the 7-day window: eleven more projects past the old fetch cap of 300.
    const older = Array.from({ length: 11 }, (_, k) => `${ROOT}/p${String(k).padStart(2, '0')}`);
    older.forEach((cwd, k) => { corpus.push(info(cwd, NOW - (3 * DAY + k * HOUR), 300 + k)); });
    // Outside the window: never listed.
    corpus.push(info(`${ROOT}/stale`, NOW - 8 * DAY, 400));

    const lister = sdk(corpus);
    const out = await recentProjects(port(createSessionListReader({ lister })));
    expect(out.map((p) => p.cwd)).toEqual([`${ROOT}/atlas`, `${ROOT}/birch`, ...older]);
    expect(MAX_RECENT_PROJECTS).toBe(13);
    expect(Math.max(...lister.calls)).toBeGreaterThan(ENGINE_SESSION_FETCH_CAP);
  });

  it('a session from 8 days ago without an open session is not listed; with an open one it is, first', async () => {
    const reader = vi.fn(async () => [
      entry(`${ROOT}/fresh`, NOW - DAY),
      entry(`${ROOT}/old`, NOW - 8 * DAY),
      entry(`${ROOT}/old-open`, NOW - 8 * DAY),
    ]);
    const open = [{ cwd: `${ROOT}/old-open`, lastActivityAt: iso(NOW - 8 * DAY + HOUR) }];
    expect(await recentProjects(port(reader, open))).toEqual([
      { cwd: `${ROOT}/old-open`, mtime: iso(NOW - 8 * DAY + HOUR) },
      { cwd: `${ROOT}/fresh`, mtime: iso(NOW - DAY) },
    ]);
    expect(reader).toHaveBeenCalledWith({ since: NOW - 7 * DAY });
  });

  it('14 projects with open sessions give 13, newest first, ahead of newer history', async () => {
    const open = Array.from({ length: 14 }, (_, k) => ({
      cwd: `${ROOT}/open${String(k).padStart(2, '0')}`, lastActivityAt: iso(NOW - (k + 1) * HOUR),
    }));
    const reader = vi.fn(async () => [entry(`${ROOT}/history`, NOW - 60 * 1000)]);
    const out = await recentProjects(port(reader, open));
    expect(out).toHaveLength(13);
    expect(out.map((p) => p.cwd)).toEqual(open.slice(0, 13).map((s) => s.cwd));
  });

  it('a project is the exact cwd: the newest session wins, a subdirectory is its own project', async () => {
    const reader = vi.fn(async () => [
      entry(`${ROOT}/willow`, NOW - 3 * HOUR),
      entry(`${ROOT}/willow/`, NOW - HOUR),
      entry(`${ROOT}/willow/server`, NOW - 2 * HOUR),
    ]);
    expect(await recentProjects(port(reader))).toEqual([
      { cwd: `${ROOT}/willow`, mtime: iso(NOW - HOUR) },
      { cwd: `${ROOT}/willow/server`, mtime: iso(NOW - 2 * HOUR) },
    ]);
  });

  it('a cwd both open and in newer history stays in the open group with the newer mtime', async () => {
    const reader = vi.fn(async () => [
      entry(`${ROOT}/history`, NOW - 2 * HOUR),
      entry(`${ROOT}/both`, NOW - HOUR),
    ]);
    const open = [
      { cwd: `${ROOT}/both`, lastActivityAt: iso(NOW - 5 * HOUR) },
      { cwd: `${ROOT}/open`, lastActivityAt: iso(NOW - 3 * HOUR) },
    ];
    expect(await recentProjects(port(reader, open))).toEqual([
      { cwd: `${ROOT}/both`, mtime: iso(NOW - HOUR) },
      { cwd: `${ROOT}/open`, mtime: iso(NOW - 3 * HOUR) },
      { cwd: `${ROOT}/history`, mtime: iso(NOW - 2 * HOUR) },
    ]);
  });

  it('the allow-list filters history and open sessions alike', async () => {
    const reader = vi.fn(async () => [entry('/etc', NOW - HOUR), entry(`${ROOT}/a`, NOW - 2 * HOUR)]);
    const open = [{ cwd: '/Users/demo/Library/x', lastActivityAt: iso(NOW) }];
    expect(await recentProjects(port(reader, open))).toEqual([{ cwd: `${ROOT}/a`, mtime: iso(NOW - 2 * HOUR) }]);
  });

  it('with the root ~ a history entry in ~/Desktop/x is skipped without a stat', async () => {
    const home = '/Users/demo';
    const asked: string[] = [];
    const walk = {
      lstat: (file: string) => { asked.push(file); return { isSymbolicLink: () => false }; },
      readlink: (file: string) => { asked.push(file); return file; },
    };
    const area: RecentProjectsPort = {
      ...port(vi.fn(async () => [entry(`${home}/Desktop/x`, NOW - HOUR), entry(`${home}/code/a`, NOW - 2 * HOUR)])),
      isAllowedCwd: (cwd) => validateProjectCwd(cwd, [home], {
        home, walk, realPath: (p) => p, isDirectory: (p) => { asked.push(p); return true; },
      }).ok,
    };
    expect(await recentProjects(area)).toEqual([{ cwd: `${home}/code/a`, mtime: iso(NOW - 2 * HOUR) }]);
    expect(asked.filter((file) => file.startsWith(`${home}/Desktop`))).toEqual([]);
  });

  it('honours the limit; a reader failure leaves the open projects', async () => {
    const reader = vi.fn(async () => [entry(`${ROOT}/a`, NOW - HOUR), entry(`${ROOT}/b`, NOW - 2 * HOUR)]);
    expect(await recentProjects(port(reader), 1)).toEqual([{ cwd: `${ROOT}/a`, mtime: iso(NOW - HOUR) }]);
    const failing = (): Promise<ResumableSession[]> => Promise.reject(new Error('EACCES'));
    expect(await recentProjects(port(failing))).toEqual([]);
    const open = [{ cwd: `${ROOT}/a`, lastActivityAt: iso(NOW) }];
    expect(await recentProjects(port(failing, open))).toEqual([{ cwd: `${ROOT}/a`, mtime: iso(NOW) }]);
  });
});
