/**
 * The folder client: one disk operation in a folder helper, through the relay thread (`relay-worker.ts`). `callSync`
 * blocks the calling thread in `Atomics.wait` for at most the sync bound and `call` resolves within the call bound, so
 * a helper that waits for a macOS consent window costs the server one bounded wait, never a hung thread. The client
 * owns request ids, generations and timeouts; an answer that comes after its caller gave up goes to `onLate`. It
 * judges no path and keeps no folder state: that is the gate's.
 */
import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { HelperCommand, RelayEvent, RelayRequest, RelayWorkerData } from './relay-worker.ts';
import type { DiskArgs, DiskOp, DiskValue, FolderClient, HelperAnswer, SyncDiskOp } from './types.ts';
import { decodeResponse, encodeRequest } from './wire.ts';

export type { HelperCommand } from './relay-worker.ts';

/** How long a sync call in a gated folder may block the server thread. */
export const FOLDER_SYNC_BOUND_MS = 1000;
/** How long an async call in a gated folder may stay unanswered. */
export const FOLDER_CALL_BOUND_MS = 1000;

/** A write gets the bound once per this many bytes, so a large file is not cut off by a bound meant for a read. */
const WRITE_BYTES_PER_BOUND = 1024 * 1024;
/** Slots of the shared pid table; one live helper per folder, plus killed ones until they are reaped. */
const PID_SLOTS = 64;

export interface FolderClientOptions {
  /** The module file of the relay thread (`relay-worker.ts`, or its `.js` in the built package). */
  readonly relay: URL;
  /** How the relay starts a helper. */
  readonly helper: HelperCommand;
  readonly syncBoundMs?: number;
  readonly callBoundMs?: number;
}

interface Waiting {
  readonly folder: string;
  readonly gen: number;
  readonly op: DiskOp;
  /** The caller of `call`; a `callSync` caller reads `answer` instead. */
  readonly resolve: ((answer: HelperAnswer<unknown>) => void) | null;
  timer: NodeJS.Timeout | null;
  answer: HelperAnswer<unknown> | null;
}

interface Abandoned {
  readonly folder: string;
  readonly gen: number;
  readonly op: DiskOp;
}

interface Relay {
  readonly worker: Worker;
  readonly port: MessagePort;
}

const GONE: HelperAnswer<never> = { kind: 'gone' };
const TIMEOUT: HelperAnswer<never> = { kind: 'timeout' };

/** The bound of one call: a write over a megabyte gets it once per started megabyte. */
function boundOf(op: DiskOp, args: unknown, base: number): number {
  if (op !== 'writeFile') return base;
  const data = (args as DiskArgs['writeFile']).data;
  return base * Math.max(1, Math.ceil(data.length / WRITE_BYTES_PER_BOUND));
}

/** An `openRead` answer that left a file open in the helper: its handle. */
function openedHandle(op: DiskOp, answer: HelperAnswer<unknown>): number | null {
  if (op !== 'openRead' || answer.kind !== 'ok' || typeof answer.value !== 'object' || answer.value === null) {
    return null;
  }
  const handle = (answer.value as { handle?: unknown }).handle;
  return typeof handle === 'number' ? handle : null;
}

export class RelayFolderClient implements FolderClient {
  readonly #options: FolderClientOptions;
  readonly #syncBoundMs: number;
  readonly #callBoundMs: number;
  readonly #signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  readonly #pids = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * PID_SLOTS));
  readonly #generations = new Map<string, number>();
  /**
   * The files each folder's current helper holds open, by the handle number it gave, with its generation. A new
   * generation starts with none: the files of a helper that ended went with it.
   */
  readonly #handles = new Map<string, { readonly gen: number; readonly open: Set<number> }>();
  readonly #waiting = new Map<number, Waiting>();
  readonly #abandoned = new Map<number, Abandoned>();
  readonly #lateListeners = new Set<(folder: string, gen: number, answer: HelperAnswer<unknown>) => void>();
  readonly #onExit = (): void => { this.#killHelpers(); };
  #relay: Relay | null = null;
  #nextId = 1;
  #disposed = false;

  constructor(options: FolderClientOptions) {
    this.#options = options;
    this.#syncBoundMs = options.syncBoundMs ?? FOLDER_SYNC_BOUND_MS;
    this.#callBoundMs = options.callBoundMs ?? FOLDER_CALL_BOUND_MS;
  }

  /** The generation of the folder's helper: answers of older generations are stale. */
  generationOf(folder: string): number {
    return this.#generations.get(folder) ?? 1;
  }

  callSync<K extends SyncDiskOp>(folder: string, op: K, args: DiskArgs[K]): HelperAnswer<DiskValue[K]> {
    const sent = this.#send(folder, op, args, null);
    if (sent === null) return GONE;
    const { id, entry } = sent;
    const stale = this.#staleHandle(folder, op, args);
    if (stale !== null) return stale;
    // A monotonic clock: a step of the wall clock must not stretch the time the main thread waits.
    const deadline = performance.now() + boundOf(op, args, this.#syncBoundMs);
    for (;;) {
      const seen = Atomics.load(this.#signal, 0);
      this.#drain();
      if (entry.answer !== null) return entry.answer as HelperAnswer<DiskValue[K]>;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        this.#abandon(id, entry);
        return TIMEOUT;
      }
      Atomics.wait(this.#signal, 0, seen, remaining);
    }
  }

  call<K extends DiskOp>(
    folder: string, op: K, args: DiskArgs[K], gen?: number,
  ): Promise<HelperAnswer<DiskValue[K]>> {
    const stale = this.#staleHandle(folder, op, args, gen);
    if (stale !== null) return Promise.resolve(stale);
    return new Promise((resolve) => {
      const sent = this.#send(folder, op, args, resolve as (answer: HelperAnswer<unknown>) => void);
      if (sent === null) {
        resolve(GONE);
        return;
      }
      const { id, entry } = sent;
      entry.timer = setTimeout(() => {
        if (this.#waiting.get(id) !== entry) return;
        this.#abandon(id, entry);
        resolve(TIMEOUT);
      }, boundOf(op, args, this.#callBoundMs));
    });
  }

  restart(folder: string): number {
    const gen = this.#nextGeneration(folder);
    for (const [id, entry] of this.#waiting) {
      if (entry.folder === folder) this.#settle(id, entry, GONE);
    }
    this.#post({ type: 'restart', folder, gen });
    return gen;
  }

  onLate(listener: (folder: string, gen: number, answer: HelperAnswer<unknown>) => void): () => void {
    this.#lateListeners.add(listener);
    return () => { this.#lateListeners.delete(listener); };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#killHelpers();
    this.#stopRelay();
    for (const [id, entry] of this.#waiting) this.#settle(id, entry, GONE);
    this.#abandoned.clear();
  }

  #send(
    folder: string, op: DiskOp, args: unknown, resolve: ((answer: HelperAnswer<unknown>) => void) | null,
  ): { id: number; entry: Waiting } | null {
    const relay = this.#ensureRelay();
    if (relay === null) return null;
    const id = this.#nextId++;
    const gen = this.generationOf(folder);
    const entry: Waiting = { folder, gen, op, resolve, timer: null, answer: null };
    this.#waiting.set(id, entry);
    relay.port.postMessage({ type: 'call', folder, gen, id, line: encodeRequest(id, op, args) } satisfies RelayRequest);
    return { id, entry };
  }

  #post(request: RelayRequest): void {
    this.#relay?.port.postMessage(request);
  }

  #ensureRelay(): Relay | null {
    if (this.#disposed) return null;
    if (this.#relay !== null) return this.#relay;
    const { port1, port2 } = new MessageChannel();
    const workerData: RelayWorkerData = {
      port: port2, signal: this.#signal.buffer as SharedArrayBuffer, pids: this.#pids.buffer as SharedArrayBuffer,
      helper: this.#options.helper,
    };
    const worker = new Worker(this.#options.relay, { workerData, transferList: [port2] });
    const relay: Relay = { worker, port: port1 };
    port1.on('message', (event: RelayEvent) => { this.#handle(event); });
    const lost = (): void => { this.#relayLost(relay); };
    worker.on('error', lost);
    worker.on('exit', lost);
    // Neither the relay nor its channel keeps the process alive; a pending `call` does, through its timer.
    worker.unref();
    port1.unref();
    process.on('exit', this.#onExit);
    this.#relay = relay;
    return relay;
  }

  /** The relay thread ended on its own: no answer can come, and its helpers would be left without a reader. */
  #relayLost(relay: Relay): void {
    if (this.#relay !== relay) return;
    this.#killHelpers();
    this.#stopRelay();
    for (const [id, entry] of this.#waiting) this.#settle(id, entry, GONE);
    this.#abandoned.clear();
  }

  /**
   * Lets the relay thread go without waiting for it: it kills its helpers, reaps them and ends on its own. Terminating
   * it here would leave the killed helpers unreaped for the life of the server.
   */
  #stopRelay(): void {
    const relay = this.#relay;
    if (relay === null) return;
    this.#relay = null;
    process.off('exit', this.#onExit);
    relay.port.postMessage({ type: 'dispose' } satisfies RelayRequest);
    relay.port.close();
  }

  /** SIGKILL to every live helper, by pid from the shared table: works in an `exit` hook and never waits. */
  #killHelpers(): void {
    for (let slot = 0; slot < this.#pids.length; slot += 1) {
      const pid = Atomics.exchange(this.#pids, slot, 0);
      if (pid <= 0) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  #drain(): void {
    const port = this.#relay?.port;
    if (port === undefined) return;
    for (let message = receiveMessageOnPort(port); message !== undefined; message = receiveMessageOnPort(port)) {
      this.#handle(message.message as RelayEvent);
    }
  }

  #handle(event: RelayEvent): void {
    if (event.type === 'gone') {
      // The current helper ended: its open files went with it, so the next call starts a new generation.
      if (event.gen === this.generationOf(event.folder)) this.#nextGeneration(event.folder);
      for (const id of event.ids) {
        this.#abandoned.delete(id);
        const entry = this.#waiting.get(id);
        if (entry !== undefined) this.#settle(id, entry, GONE);
      }
      return;
    }
    const answer = this.#decode(event.line);
    const entry = this.#waiting.get(event.id);
    if (entry !== undefined) {
      this.#settle(event.id, entry, answer);
      return;
    }
    const abandoned = this.#abandoned.get(event.id);
    if (abandoned === undefined) return;
    this.#abandoned.delete(event.id);
    const handle = openedHandle(abandoned.op, answer);
    if (handle !== null && abandoned.gen === this.generationOf(abandoned.folder)) {
      this.#closeLate(abandoned.folder, abandoned.gen, handle);
    }
    for (const listener of this.#lateListeners) listener(abandoned.folder, abandoned.gen, answer);
  }

  #decode(line: string): HelperAnswer<unknown> {
    try {
      const response = decodeResponse(line);
      return response.ok ? { kind: 'ok', value: response.value } : { kind: 'fs-error', error: response.error };
    } catch {
      // A line the codec cannot read means a broken helper, the same as one that ended.
      return GONE;
    }
  }

  /** Closes a file a late answer left open; nobody waits for the result. */
  #closeLate(folder: string, gen: number, handle: number): void {
    const relay = this.#relay;
    if (relay === null) return;
    const id = this.#nextId++;
    relay.port.postMessage({
      type: 'call', folder, gen, id, line: encodeRequest(id, 'close', { handle } satisfies DiskArgs['close']),
    } satisfies RelayRequest);
  }

  #abandon(id: number, entry: Waiting): void {
    this.#waiting.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.#abandoned.set(id, { folder: entry.folder, gen: entry.gen, op: entry.op });
  }

  #nextGeneration(folder: string): number {
    const gen = this.generationOf(folder) + 1;
    this.#generations.set(folder, gen);
    this.#handles.delete(folder);
    return gen;
  }

  /** Remembers a file the folder's current helper opened; one an older helper opened went with that helper. */
  #hold(folder: string, gen: number, handle: number): void {
    if (gen !== this.generationOf(folder)) return;
    let held = this.#handles.get(folder);
    if (held?.gen !== gen) {
      held = { gen, open: new Set() };
      this.#handles.set(folder, held);
    }
    held.open.add(handle);
  }

  /**
   * A `read` or `close` of a handle that the folder's current helper did not give: `EBADF` without a call, since a
   * new helper may hold another file under the same number. With `gen`, a handle of an older generation stays stale
   * even when the current helper gave the same number again.
   */
  #staleHandle(folder: string, op: DiskOp, args: unknown, gen?: number): HelperAnswer<never> | null {
    if (op !== 'read' && op !== 'close') return null;
    const handle = (args as DiskArgs['read' | 'close']).handle;
    const current = this.generationOf(folder);
    const held = this.#handles.get(folder);
    if ((gen ?? current) === current && held?.gen === current && held.open.has(handle)) {
      if (op === 'close') held.open.delete(handle);
      return null;
    }
    const error: NodeJS.ErrnoException = Object.assign(new Error(`EBADF: bad file descriptor, ${op}`), {
      code: 'EBADF', syscall: op,
    });
    return { kind: 'fs-error', error };
  }

  #settle(id: number, entry: Waiting, answer: HelperAnswer<unknown>): void {
    this.#waiting.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    const handle = openedHandle(entry.op, answer);
    if (handle !== null) this.#hold(entry.folder, entry.gen, handle);
    entry.answer = answer;
    entry.resolve?.(answer);
  }
}
