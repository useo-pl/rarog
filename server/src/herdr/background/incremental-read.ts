/**
 * One incremental read of one conversation file: from the remembered offset, in byte chunks, up to a byte budget,
 * handing the complete lines of each chunk to the caller (`jsonl-lines.ts` cuts them; a line over the ceiling is
 * skipped whole). A file shorter than the offset or with another inode or device is read again from byte zero, and
 * the caller learns that before the first line, so it can drop what it built from the old content. Never throws: a
 * missing file is a normal state, and any other error (also midway, which leaves the offset after the last handled
 * chunk) comes back as `failed`, so a caller that has no other wake-up can read again.
 *
 * Recognition is not here: the caller filters and parses the lines. Which files to read, the budget across files and
 * the cost log stay with the caller too (`pull-request-files.ts`, `scheduled-task-file.ts`).
 */
import { open } from 'node:fs/promises';
import { emptyCarry, resetCarry, takeLines } from './jsonl-lines.ts';
import type { LineCarry } from './jsonl-lines.ts';

/** Where a reader stands in one file between reads. */
export interface FileCursor extends LineCarry {
  offset: number;
  ino: number;
  dev: number;
}

/** Identity of the file content: a new inode or device under the same name is another content. */
export interface FileIdentity {
  readonly ino: number;
  readonly dev: number;
}

/** A cursor at byte zero of the file with this identity. */
export function cursorAt(identity: FileIdentity): FileCursor {
  const cursor = { ...emptyCarry(), offset: 0, ino: identity.ino, dev: identity.dev };
  resetCarry(cursor);
  return cursor;
}

export interface IncrementOptions<C extends FileCursor> {
  /** The cursor the previous read of this file left; `undefined` = never read. */
  readonly cursor: C | undefined;
  /**
   * The cursor for a read from byte zero: no cursor yet, another inode or device, or a file shorter than the offset.
   * Called before the first line, so the caller resets here what it built from the old content.
   */
  readonly restart: (identity: FileIdentity) => C;
  /** At most this many bytes in this read. */
  readonly budgetBytes: number;
  readonly chunkBytes: number;
  readonly lineMaxBytes: number;
  /** The read went stale (the caller repointed or closed): stop without handing over more lines. */
  readonly stale: () => boolean;
  /**
   * The complete lines of one chunk, in file order. The lines are views on the chunk buffer, which the next chunk
   * overwrites: handle them before returning. A returned promise is awaited before the next chunk.
   */
  readonly onLines: (lines: Buffer[], cursor: C) => void | Promise<void>;
}

export interface IncrementResult {
  /** Bytes read in this call. */
  readonly bytes: number;
  /** The file has an unread part (the budget ended first). */
  readonly more: boolean;
  /** The read hit an error other than a missing file; absent otherwise. */
  readonly failed?: true;
}

/** A missing file or directory on the path: a normal state, not a read error. */
function missing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Reads one file from its cursor by at most `budgetBytes`. The cursor is updated in place (or replaced through
 * `restart`), chunk by chunk, before the chunk's lines go to `onLines`.
 */
export async function readIncrement<C extends FileCursor>(
  path: string, opts: IncrementOptions<C>,
): Promise<IncrementResult> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    return missing(error) ? { bytes: 0, more: false } : { bytes: 0, more: false, failed: true };
  }
  let bytes = 0;
  try {
    const info = await handle.stat();
    if (opts.stale()) return { bytes, more: false };
    let state = opts.cursor;
    if (state === undefined || info.ino !== state.ino || info.dev !== state.dev || info.size < state.offset) {
      state = opts.restart({ ino: info.ino, dev: info.dev });
    }
    const end = Math.min(info.size, state.offset + opts.budgetBytes);
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(opts.chunkBytes, end - state.offset)));
    while (state.offset < end) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - state.offset), state.offset);
      if (opts.stale()) return { bytes, more: false };
      if (bytesRead === 0) break;
      state.offset += bytesRead;
      bytes += bytesRead;
      const pending = opts.onLines(takeLines(state, buffer.subarray(0, bytesRead), opts.lineMaxBytes), state);
      if (pending !== undefined) await pending;
      if (opts.stale()) return { bytes, more: false };
    }
    return { bytes, more: state.offset < info.size };
  } catch {
    return { bytes, more: false, failed: true };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
