/**
 * Golden SSE frames, producers of the blocked macOS folders: `sse-fixtures-producenci.test.ts` runs them next to its
 * other producers and checks each frame against `shared/fixtures/sse/`. The states come from the real `MacFolderGate`
 * over a client stub whose folder check answers as the helpers would (no answer, `EPERM`, a helper gone), and the frames
 * from an `SseHub` global stream, read back from the `data:` field as a client gets them. Only the clock is fake, so
 * `since` is fixed; nothing touches a real folder.
 */
import path from 'node:path';
import { vi } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { FOLDER_SYNC_BOUND_MS } from '../src/folder-gate/client.ts';
import { MacFolderGate } from '../src/folder-gate/gate.ts';
import type { DiskOp, DiskValue, FolderClient, HelperAnswer } from '../src/folder-gate/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import { SseHub, type SseResponse } from '../src/sse.ts';

/** Produced frames: file name in `shared/fixtures/sse/` → frame as the client gets it. */
type Produced = Map<string, unknown>;

const HOME = '/Users/demo';

/** Collects what the hub writes to one stream and reads the `folder-access` frames back. */
class FolderSink implements SseResponse {
  readonly chunks: string[] = [];
  writeHead(): unknown { return this; }
  write(chunk: string): boolean { this.chunks.push(chunk); return true; }
  end(): unknown { return this; }
  on(): unknown { return this; }

  /** The last `folder-access` frame, or a hard error (the scenario went astray). */
  last(): Record<string, unknown> {
    const found = this.chunks.join('').split('\n\n')
      .map((raw) => raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
      .filter((data): data is string => data !== undefined)
      .map((data) => JSON.parse(data) as Record<string, unknown>)
      .filter((frame) => frame.type === 'folder-access')
      .at(-1);
    if (found === undefined) throw new Error('no folder-access frame on the stream');
    return found;
  }
}

/** A client whose folder check gives a fixed answer per folder; the gate needs no other call. */
class CheckStub implements FolderClient {
  readonly #answers: ReadonlyMap<string, HelperAnswer<unknown>>;
  #gen = 0;

  constructor(answers: ReadonlyMap<string, HelperAnswer<unknown>>) {
    this.#answers = answers;
  }

  callSync(): never {
    throw new Error('the gate makes no synchronous call');
  }

  call<K extends DiskOp>(folder: string, op: K): Promise<HelperAnswer<DiskValue[K]>> {
    const answer = this.#answers.get(folder);
    if (op !== 'check' || answer === undefined) throw new Error(`unexpected ${op} in ${folder}`);
    return Promise.resolve(answer as HelperAnswer<DiskValue[K]>);
  }

  restart(): number {
    this.#gen += 1;
    return this.#gen;
  }

  generationOf(): number { return this.#gen; }
  onLate(): () => void { return () => undefined; }
  dispose(): void {}
}

const denied = Object.assign(new Error('EPERM: operation not permitted, opendir'), { code: 'EPERM' });

/**
 * A global stream on a server with the gate on: the empty `folder-access` right after the list, then a live frame for
 * each folder that closes, Desktop with no answer (`waiting`), Documents refused (`denied`) and Downloads with its
 * helper gone (`unchecked`); the last frame lists all three.
 */
export async function produceFolders(out: Produced, dataDir: string): Promise<void> {
  const manager = await createManager({ demo: false, dataDir, gitStatus: null, gitWatcher: null });
  const folder = (name: string): string => path.join(HOME, name);
  const client = new CheckStub(new Map<string, HelperAnswer<unknown>>([
    [folder('Desktop'), { kind: 'timeout' }],
    [folder('Documents'), { kind: 'fs-error', error: denied }],
    [folder('Downloads'), { kind: 'gone' }],
  ]));
  const gate = new MacFolderGate({ home: HOME, client, boundMs: FOLDER_SYNC_BOUND_MS });
  const hub = new SseHub({
    manager, serverStartId: '6a2d9f14-3c7b-4e85-a0d1-9b4e7c2f8a63', protocolVersion: PROTOCOL_VERSION,
    heartbeatMs: 0, folderGate: gate,
  });
  try {
    await manager.ready;
    // Only `Date`: the gate's own timers stay real, so a check that waits on a folder never blocks the producer.
    vi.useFakeTimers({ now: new Date('2026-10-03T08:14:00.000Z'), toFake: ['Date'] });
    hub.start();

    const stream = new FolderSink();
    hub.openGlobal(stream);
    out.set('folder-access.empty.json', stream.last());

    for (const [name, at] of [
      ['Desktop', '2026-10-03T08:14:05.000Z'], ['Documents', '2026-10-03T08:15:30.000Z'],
      ['Downloads', '2026-10-03T08:16:10.000Z'],
    ] as const) {
      vi.setSystemTime(new Date(at));
      void gate.check(folder(name), FOLDER_SYNC_BOUND_MS);
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    out.set('folder-access.max.json', stream.last());
  } finally {
    vi.useRealTimers();
    hub.closeAll();
    gate.dispose();
    await manager.dispose();
  }
}
