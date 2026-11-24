/**
 * The listing of one directory of a session, as `GET /api/sessions/:id/files?dir=` sends it: the session gate of the
 * file routes, then either the fixed demo data or the directory on disk (`listing.ts`) with git's `ignored` labels
 * (`ignored.ts`). Functions over a port the manager fills; the module holds no state and does not import the manager.
 */
import path from 'node:path';
import type { FileEntry, FileListing } from '@rarog/shared';
import type { GitArgsRunner } from '../git-status.ts';
import type { DiffSessionPort } from '../sessions/session-scope.ts';
import { labelIgnored } from './ignored.ts';
import { listSessionDir } from './listing.ts';
import { FILES_DISK, type FilesDisk, type Ruled, shapeRefusal } from './path-rule.ts';
import { NOT_FOUND } from './refusals.ts';
import { filesSession } from './session-gate.ts';

/** The answer of a listing: the listing, or the refusal the route sends. */
export type FileListingAnswer = Ruled<FileListing>;

/** What the listing needs from the manager: the session lookup and its configuration, git, the demo data. */
export interface SessionFilesPort extends DiffSessionPort {
  /** The git runner of the session reads; `check-ignore` runs through it in the listed directory. */
  readonly run: GitArgsRunner;
  /** Entries of a directory of the demo data, sorted; `null` = no such directory. Asked only in demo mode. */
  readonly demoEntries: (dir: string) => FileEntry[] | null;
}

/**
 * Lists the directory `dir` of the session `id` (`''` = the session directory) and announces `maxBytes`. An unknown
 * session throws the manager's 404 (`port.require`); the gate refuses a Codex entry, a pane out of scope and a
 * session without a pane before any disk call.
 */
export async function listSessionFiles(
  id: string, dir: string, maxBytes: number, port: SessionFilesPort, disk: FilesDisk = FILES_DISK,
): Promise<FileListingAnswer> {
  const gate = filesSession(id, port, disk.area);
  if (gate.kind === 'refused') return { ok: false, refusal: gate.refusal };
  if (gate.kind === 'demo') return demoListing(dir, maxBytes, port.demoEntries);
  const listing = await listSessionDir(gate.area, dir, { maxBytes }, disk);
  if (!listing.ok) return listing;
  // The walk of the rule proved the listed directory on disk is exactly the session directory on disk plus `dir`.
  return { ok: true, value: await labelIgnored(listing.value, path.join(gate.area.realCwd, dir), port.run) };
}

/** The demo listing: the shape check as on a server, then the demo data; a directory it does not have is 404. */
function demoListing(
  dir: string, maxBytes: number, entriesOf: SessionFilesPort['demoEntries'],
): FileListingAnswer {
  const shape = shapeRefusal(dir, true);
  if (shape !== null) return { ok: false, refusal: shape };
  const entries = entriesOf(dir);
  if (entries === null) return { ok: false, refusal: NOT_FOUND };
  return { ok: true, value: { dir, entries, truncated: false, maxBytes } };
}
