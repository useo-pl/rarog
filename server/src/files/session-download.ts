/**
 * The download of one file of a session, as `GET /api/sessions/:id/files/raw?path=` sends it: the session gate of the
 * file routes, then either the fixed demo bytes or the file opened by the path rule, and the size limit against the
 * `fstat` of that open descriptor, before any byte. It sends nothing itself (`send-file.ts`), holds no state and does
 * not import the manager.
 */
import { type ExactPiece, exactReader } from '../safe-read.ts';
import type { DiffSessionPort } from '../sessions/session-scope.ts';
import { FILES_DISK, type FilesDisk, openSessionFile, shapeRefusal } from './path-rule.ts';
import { type FileTooLarge, type FilesRefusal, NOT_FOUND, fileTooLarge } from './refusals.ts';
import { filesSession } from './session-gate.ts';

/** A file ready to send: its size and its bytes one piece at a time, from one open descriptor. */
export interface FileDownload {
  /** The bytes the response announces (`Content-Length`) and sends: the `fstat` size of the open descriptor. */
  readonly size: number;
  /** The next piece of those bytes (`exactReader` of `safe-read.ts`); `short` = the file got shorter meanwhile. */
  readonly read: () => Promise<ExactPiece>;
  /** Closes the descriptor. The sender calls it once, on every path. */
  readonly close: () => Promise<void>;
}

/** The answer of a download: the file to send, or the refusal the route sends (413 with the size and the limit). */
export type FileDownloadAnswer =
  | { readonly ok: true; readonly value: FileDownload }
  | { readonly ok: false; readonly refusal: FilesRefusal | FileTooLarge };

/** What the download needs from the manager: the session lookup and its configuration, and the demo data. */
export interface SessionDownloadPort extends DiffSessionPort {
  /** Bytes of a file of the demo data; `null` = no such file. Asked only in demo mode. */
  readonly demoFile: (rel: string) => Buffer | null;
}

/**
 * Opens the file `rel` of the session `id` for sending, or refuses it. An unknown session throws the manager's 404
 * (`port.require`); the gate refuses a Codex entry, a pane out of scope and a session without a pane before any disk
 * call. A file over `maxBytes` is refused with its descriptor closed; on success the caller owns the descriptor
 * through `close`.
 */
export async function openSessionDownload(
  id: string, rel: string, maxBytes: number, port: SessionDownloadPort, disk: FilesDisk = FILES_DISK,
): Promise<FileDownloadAnswer> {
  const gate = filesSession(id, port, disk.area);
  if (gate.kind === 'refused') return { ok: false, refusal: gate.refusal };
  if (gate.kind === 'demo') return demoDownload(rel, maxBytes, port.demoFile);
  const opened = await openSessionFile(gate.area, rel, disk);
  if (!opened.ok) return opened;
  const { handle, size } = opened.value;
  if (size > maxBytes) {
    await handle.close();
    return { ok: false, refusal: fileTooLarge(size, maxBytes) };
  }
  return { ok: true, value: { size, read: exactReader(handle, size), close: () => handle.close() } };
}

/** The demo download: the shape check as on a server, then the demo bytes; a file it does not have is 404. */
function demoDownload(rel: string, maxBytes: number, bytesOf: SessionDownloadPort['demoFile']): FileDownloadAnswer {
  const shape = shapeRefusal(rel, false);
  if (shape !== null) return { ok: false, refusal: shape };
  const bytes = bytesOf(rel);
  if (bytes === null) return { ok: false, refusal: NOT_FOUND };
  if (bytes.length > maxBytes) return { ok: false, refusal: fileTooLarge(bytes.length, maxBytes) };
  let sent = false;
  const read = (): Promise<ExactPiece> => {
    if (sent || bytes.length === 0) return Promise.resolve({ kind: 'done' });
    sent = true;
    return Promise.resolve({ kind: 'piece', bytes });
  };
  return { ok: true, value: { size: bytes.length, read, close: () => Promise.resolve() } };
}
