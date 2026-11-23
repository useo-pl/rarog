/**
 * Recent projects for the New Session sheet (`GET /api/projects/recent`): the exact directories of CLI sessions from
 * the last {@link RECENT_PROJECTS_WINDOW_MS} plus the directories of open Rarog sessions, allow-listed before the
 * cap. The manager passes its session reader, allow-list question, open sessions and clock as
 * {@link RecentProjectsPort}; this module keeps no state and does not import `manager.ts`.
 */
import { resolve } from 'node:path';
import { MAX_RECENT_PROJECTS } from '@rarog/shared';
import type { RecentProject } from '@rarog/shared';
import type { SessionListReader } from '../session-list.ts';

/** How far back the Claude Code session history goes: seven days. */
export const RECENT_PROJECTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** What the list needs of an open Rarog session (`Session` fits as is). */
export interface OpenSessionRef {
  readonly cwd: string;
  /** ISO time of the last activity. */
  readonly lastActivityAt: string;
}

/** What the recent-projects list reads from the manager. */
export interface RecentProjectsPort {
  readonly readSessions: SessionListReader;
  readonly isAllowedCwd: (cwd: string) => boolean;
  /** Rarog sessions with a live pane: their projects lead the list whatever the age of their history. */
  readonly openSessions: () => Iterable<OpenSessionRef>;
  readonly now: () => number;
}

interface Candidate {
  readonly cwd: string;
  mtime: string;
  at: number;
  open: boolean;
}

/**
 * Recent projects, at most `limit`: projects with an open Rarog session first, then the rest, each group newest
 * first. A project is the exact `cwd` of its sessions (a subdirectory is its own project); its `mtime` is the newest
 * session in it, open ones counted by their last activity.
 *
 * The reader is asked for the whole 7-day window (`since`), so sessions outside the allow-list cannot push allowed
 * projects past a fetch cap. The allow-list is a filter, not a gate: a directory outside the roots or deleted
 * (`validateProjectCwd` also checks it exists) is skipped. The answer carries only allow-listed paths, the same that
 * `GET /api/projects` gives. A store failure leaves the open projects.
 */
export async function recentProjects(
  port: RecentProjectsPort, limit: number = MAX_RECENT_PROJECTS,
): Promise<RecentProject[]> {
  const since = port.now() - RECENT_PROJECTS_WINDOW_MS;
  const candidates = new Map<string, Candidate>();
  const note = (rawCwd: string, mtime: string, open: boolean): void => {
    const cwd = resolve(rawCwd);
    const at = Date.parse(mtime);
    if (Number.isNaN(at)) return;
    const seen = candidates.get(cwd);
    if (seen === undefined) {
      candidates.set(cwd, { cwd, mtime, at, open });
      return;
    }
    seen.open ||= open;
    if (seen.at < at) Object.assign(seen, { mtime, at });
  };
  for (const session of port.openSessions()) note(session.cwd, session.lastActivityAt, true);
  const entries = await port.readSessions({ since }).catch(() => []);
  for (const entry of entries) {
    if (Date.parse(entry.mtime) >= since) note(entry.cwd, entry.mtime, false);
  }
  const ordered = [...candidates.values()].sort((a, b) => (a.open !== b.open ? (a.open ? -1 : 1) : b.at - a.at));
  const out: RecentProject[] = [];
  for (const project of ordered) {
    if (out.length >= limit) break;
    if (!port.isAllowedCwd(project.cwd)) continue;
    out.push({ cwd: project.cwd, mtime: project.mtime });
  }
  return out;
}
