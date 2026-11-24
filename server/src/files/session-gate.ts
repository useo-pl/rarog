/**
 * The session gate of the file routes: which session's directory a listing or a file may come from, and the area the
 * path rule works in. The variant of the diff gate (`sessions/session-scope.ts`) with its own refusal codes, and
 * without its pass for a session that has no pane: such a session is refused. The checks on the session come first
 * and touch no disk; the session directory is then checked in the work area on disk and resolved, together with the
 * roots and home, never a path of the request.
 */
import { homedir } from 'node:os';
import { type AreaDisk, inWorkAreaOnDisk, onDiskForms, resolveInWorkArea } from '../config/work-area.ts';
import type { SessionScopeConfig } from '../sessions/companion-scope.ts';
import type { DiffSessionPort } from '../sessions/session-scope.ts';
import type { Session } from '../sessions/session.ts';
import { FILES_DISK, type FilesArea, type Ruled } from './path-rule.ts';
import { CODEX, type FilesRefusal, NOT_FOUND, NO_PANE, OUT_OF_SCOPE, closedFolder } from './refusals.ts';

/**
 * The area of the session directory `cwd`: refused when `cwd` lies outside the work area as written or on disk
 * (`out-of-scope`), when the way to it passes a guarded folder that a root opens and the folder gate holds closed
 * (404 with the sentence of the folder's state), and when it no longer resolves (`not-found`: the directory is gone).
 */
export function filesArea(
  cwd: string, config: SessionScopeConfig, disk: AreaDisk = FILES_DISK.area,
): Ruled<FilesArea> {
  const roots = config.herdrRoots ?? [];
  const home = config.home ?? homedir();
  const real = onDiskForms(roots, home, disk.realpath);
  if (!inWorkAreaOnDisk(cwd, roots, home, disk)) {
    // The walk again, metadata only, for the one case a closed folder put `cwd` out: say why.
    const walked = resolveInWorkArea(cwd, real.roots, real.home, disk);
    const closed = walked.kind === 'excluded' ? walked.closed : undefined;
    return { ok: false, refusal: closed === undefined ? OUT_OF_SCOPE : closedFolder(closed) };
  }
  let realCwd: string;
  try {
    realCwd = disk.realpath(cwd);
  } catch {
    return { ok: false, refusal: NOT_FOUND };
  }
  return { ok: true, value: { cwd, realCwd, roots, realRoots: real.roots, home, realHome: real.home } };
}

/** The gate's answer: the area of a real session, the demo (fixed data, no disk), or the refusal to send. */
export type FilesGate =
  | { readonly kind: 'area'; readonly session: Session; readonly area: FilesArea }
  | { readonly kind: 'demo'; readonly session: Session }
  | { readonly kind: 'refused'; readonly refusal: FilesRefusal };

/**
 * The gate of both file routes. An unknown session throws the manager's 404 (`port.require`). A Codex entry and a
 * pane out of scope are refused before the demo branch, as in the diff gate; the demo has no directories, so a demo
 * session passes without a pane; any other session without a herdr pane is refused.
 */
export function filesSession(id: string, port: DiffSessionPort, disk: AreaDisk = FILES_DISK.area): FilesGate {
  const session = port.require(id);
  if (session.engine === 'codex') return { kind: 'refused', refusal: CODEX };
  if (session.outOfScope === true) return { kind: 'refused', refusal: OUT_OF_SCOPE };
  if (port.config.demo) return { kind: 'demo', session };
  if (session.herdrKey === undefined) return { kind: 'refused', refusal: NO_PANE };
  const area = filesArea(session.cwd, port.config, disk);
  return area.ok ? { kind: 'area', session, area: area.value } : { kind: 'refused', refusal: area.refusal };
}
