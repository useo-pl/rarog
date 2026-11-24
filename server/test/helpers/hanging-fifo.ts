/**
 * A FIFO in a fresh `mkdtemp` directory: a disk call that opens it for writing waits in the kernel until a reader
 * opens the other end, the stand-in for a read that waits on a macOS consent window. Through the work-area port only
 * an open for writing (`writeFile`) waits on it, because every read path opens with `O_NONBLOCK`. `release` opens
 * the read end, so the waiting call goes on; `dispose` closes what was opened and removes the directory.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, readSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HangingFifo {
  /** The directory that holds the FIFO. */
  readonly dir: string;
  /** The FIFO itself. */
  readonly path: string;
  /** Opens the read end without blocking, so a writer waiting in `open` goes on; the bytes it writes are drained. */
  release(): void;
  /** Closes the read end (if open) and removes the directory. */
  dispose(): Promise<void>;
}

export async function hangingFifo(): Promise<HangingFifo> {
  const dir = await mkdtemp(join(tmpdir(), 'rarog-hanging-fifo-'));
  const path = join(dir, 'fifo');
  execFileSync('mkfifo', [path]);
  let reader: number | null = null;
  const drain = (): void => {
    if (reader === null) return;
    const buffer = Buffer.alloc(4096);
    try {
      while (readSync(reader, buffer, 0, buffer.length, null) > 0) { /* drop the bytes */ }
    } catch {
      // EAGAIN: nothing more to read right now.
    }
  };
  return {
    dir,
    path,
    release: () => {
      if (reader === null) reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      drain();
    },
    dispose: async () => {
      if (reader !== null) {
        drain();
        closeSync(reader);
        reader = null;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
