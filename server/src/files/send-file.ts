/**
 * Sends a file download as the 200 of `GET /api/sessions/:id/files/raw`, and keeps the downloads in flight by device.
 * The headers announce the download's size; then exactly that many bytes go out, piece by piece, with the socket's
 * backpressure. A file found shorter on the way, a read error, the client gone and a stop of the device (unpaired)
 * end the response by destroying it, so the client never keeps a cut copy as the file. The descriptor is closed once,
 * on every path. The module opens no file itself and does not import the router.
 */
import type { ServerResponse } from 'node:http';
import type { ExactPiece } from '../safe-read.ts';
import type { FileDownload } from './session-download.ts';

/** The downloads in flight by device: the unpair effects stop them (`device-effects.ts`). */
export class FileDownloads {
  readonly #byOwner = new Map<string, Set<() => void>>();

  /** Registers `stop` under the device `owner`; the returned function removes it again. */
  track(owner: string, stop: () => void): () => void {
    let stops = this.#byOwner.get(owner);
    if (stops === undefined) {
      stops = new Set();
      this.#byOwner.set(owner, stops);
    }
    // An entry of its own, so the same function registered twice is two downloads.
    const entry = (): void => { stop(); };
    stops.add(entry);
    return () => {
      const current = this.#byOwner.get(owner);
      if (current === undefined) return;
      current.delete(entry);
      if (current.size === 0) this.#byOwner.delete(owner);
    };
  }

  /** Stops every download of the device `owner` (it was unpaired); returns how many. */
  closeOwner(owner: string): number {
    const stops = this.#byOwner.get(owner);
    if (stops === undefined) return 0;
    this.#byOwner.delete(owner);
    for (const stop of stops) stop();
    return stops.size;
  }
}

/** The headers of the 200: bytes the app keeps as they are, never sniffed and never cached on the way. */
export function downloadHeaders(size: number): Record<string, string> {
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

/** How a download ended: every byte sent, the file got shorter, the response closed first, or the read failed. */
export type DownloadOutcome = 'sent' | 'short' | 'closed' | 'failed';

export interface SendOptions {
  /** The device the download goes to; `undefined` = not tracked (no device behind the request). */
  readonly owner: string | undefined;
  readonly downloads: FileDownloads;
  readonly log: (line: string) => void;
}

const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
};

/** Settles on the next `drain` or `close` of `res`, whichever comes first. */
function drainedOrClosed(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Sends `download` on `res`, registered under `opts.owner` until it ends. Call it right after the last check of the
 * device, with no `await` in between, so an unpair from then on reaches this download. Never throws.
 */
export async function sendDownload(
  res: ServerResponse, download: FileDownload, opts: SendOptions,
): Promise<DownloadOutcome> {
  // The descriptor closes after the last read, but the download leaves the registry only when the response closes:
  // the last bytes may still wait in the transport, and an unpair until then must still cut them.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    download.close().catch((err: unknown) => { opts.log(`files: closing a downloaded file failed: ${codeOf(err)}`); });
  };
  const untrack = opts.owner === undefined ? () => {} : opts.downloads.track(opts.owner, () => { res.destroy(); });
  res.once('close', () => {
    untrack();
    release();
  });
  if (res.destroyed) {
    untrack();
    release();
    return 'closed';
  }
  res.writeHead(200, downloadHeaders(download.size));
  for (;;) {
    let piece: ExactPiece;
    try {
      piece = await download.read();
    } catch (err) {
      const outcome = res.destroyed ? 'closed' : 'failed';
      if (outcome === 'failed') opts.log(`files: reading a downloaded file failed: ${codeOf(err)}`);
      res.destroy();
      release();
      return outcome;
    }
    if (res.destroyed) {
      release();
      return 'closed';
    }
    if (piece.kind === 'done') {
      release();
      res.end();
      return 'sent';
    }
    if (piece.kind === 'short') {
      opts.log('files: a file got shorter while it was sent, the response was cut');
      res.destroy();
      release();
      return 'short';
    }
    if (!res.write(piece.bytes)) await drainedOrClosed(res);
  }
}
