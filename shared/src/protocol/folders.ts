/**
 * Protocol contract, macOS folders area: the `folder-access` SSE frame (`FolderAccessEvent`), the guarded folders of
 * the home directory the server keeps closed until macOS lets it in.
 *
 * The full list goes in every frame, sorted by `name`. A server with the folder gate on sends it on every global
 * stream right after `sessions-snapshot`, also empty, and again on every change of the list. The frame is fleeting:
 * `seq: null`, outside every ring buffer. A server without the gate never sends it.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

/**
 * Why a folder is closed: `waiting` (no answer from the disk, macOS probably shows a window on the Mac), `denied`
 * (macOS refused; System Settings decide) or `unchecked` (the server could not tell; details in the server log).
 */
export const MAC_FOLDER_STATES = ['waiting', 'denied', 'unchecked'] as const;
export type MacFolderState = (typeof MAC_FOLDER_STATES)[number];
export const macFolderStateSchema = z.enum(MAC_FOLDER_STATES);

/** One closed folder. */
export interface MacFolderBlock {
  /** The folder's name under home, as macOS names it: `Desktop`, `Documents`, `Downloads`. */
  name: string;
  /** The absolute path on the server. */
  path: string;
  state: MacFolderState;
  /** ISO 8601: when the folder entered this state. */
  since: string;
}

export const macFolderBlockSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  state: macFolderStateSchema,
  since: z.string(),
});

/** Every closed folder, sorted by `name`; an empty list means every folder is open. */
export interface FolderAccessEvent {
  type: 'folder-access';
  blocked: MacFolderBlock[];
}

export const folderAccessEventSchema = z.object({
  type: z.literal('folder-access'),
  blocked: z.array(macFolderBlockSchema),
});
