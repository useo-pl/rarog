/**
 * The sender of a file download on a response that has not finished yet: the last bytes may still wait in the
 * transport after the last read, and an unpair in that moment must still cut the response.
 */
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { ExactPiece } from '../src/safe-read.ts';
import { FileDownloads, sendDownload } from '../src/files/send-file.ts';
import type { FileDownload } from '../src/files/session-download.ts';

/** A response whose `end()` leaves the bytes buffered: `close` comes only from `destroy()` or `flush()`. */
class PendingResponse extends EventEmitter {
  destroyed = false;
  writeHead(): this { return this; }
  write(): boolean { return true; }
  end(): this { return this; }
  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit('close');
    return this;
  }
  flush(): void { this.emit('finish'); this.emit('close'); }
}

function oneKilobyte(): { download: FileDownload; closes: () => number } {
  const pieces: ExactPiece[] = [{ kind: 'piece', bytes: Buffer.alloc(1024, 1) }, { kind: 'done' }];
  let closes = 0;
  return {
    download: {
      size: 1024,
      read: () => Promise.resolve(pieces.shift() ?? { kind: 'done' }),
      close: () => { closes += 1; return Promise.resolve(); },
    },
    closes: () => closes,
  };
}

describe('file download sender: the response still sending its last bytes', () => {
  it('an unpair after the last read and before the response finished destroys the response', async () => {
    const res = new PendingResponse();
    const downloads = new FileDownloads();
    const { download, closes } = oneKilobyte();
    const outcome = await sendDownload(res as unknown as ServerResponse, download, {
      owner: 'device-a', downloads, log: () => {},
    });
    expect(outcome).toBe('sent');
    expect(closes()).toBe(1);
    expect(downloads.closeOwner('device-a')).toBe(1);
    expect(res.destroyed).toBe(true);
    expect(closes()).toBe(1);
  });

  it('a response that finished leaves the registry: a later unpair stops nothing', async () => {
    const res = new PendingResponse();
    const downloads = new FileDownloads();
    const { download, closes } = oneKilobyte();
    await sendDownload(res as unknown as ServerResponse, download, { owner: 'device-a', downloads, log: () => {} });
    res.flush();
    expect(downloads.closeOwner('device-a')).toBe(0);
    expect(res.destroyed).toBe(false);
    expect(closes()).toBe(1);
  });
});
