/**
 * `Duplex` over an iroh bidirectional stream: `http.Server` gets it through `emit('connection', duplex)` and handles it
 * like a TCP socket. Requirements from measuring the library, numbers in the comments:
 *
 * (1) `setTimeout(ms, cb?)` with its own idle timer (read and write), `0` disables it;
 * (2) `listen` on `http.Server` is done by the server's owner, not this module (without it Node does not enforce
 *     `headersTimeout`);
 * (3) `_write` acknowledges only after the stream accepted the bytes (`ws.bufferedAmount`, terminal pause);
 * (4) reading with backpressure: `push() === false` pauses reading until the next `_read()`;
 * (5) `allowHalfOpen`: the client's FIN is `push(null)`, and `_final` is the send FIN;
 * (6) closing both ways: `destroy()` resets the directions that have not finished, and an error or end of the
 *     stream destroys the `Duplex`;
 * (7) a plain, extensible object (`http` adds its own fields on the socket); (8) no `setNoDelay`, `setKeepAlive`,
 * `bytesRead` etc.: `http` and `ws` do not need them; (9) no `remoteAddress`: the iroh socket does not pretend to be a
 * loopback address (`socket.ts` gives the label).
 *
 * Difference from TCP: the error response Node writes right before `destroy()` (400 for a bad header, 408 after
 * `headersTimeout`) does not arrive over iroh, because `destroy()` is a stream `reset`. The client sees a reset
 * instead of a status.
 *
 * Native close (`docs/security-model.md`, "Layer 1b"): `reset` and `stop` can hang on the stream mutex (fact 3 in
 * `adapter.ts`). `_destroy` returns the callback at once, so `http` and `ws` clean up without waiting, but it does not
 * free the stream SLOT: only the end of the native operations frees it ({@link IrohStreamSlot.release}). After the
 * deadline (2 s by default) `late` tells the owner it must escalate (close the connection, fact 4).
 */
import { Duplex } from 'node:stream';
import type { IrohBiStream, IrohClock, IrohTimer } from './endpoint.ts';
import { systemClock } from './endpoint.ts';

/** Read chunk (fact 1 in `adapter.ts`). */
const READ_CHUNK = 64 * 1024;

/** Deadline of close operations before escalation. */
export const CLOSE_DEADLINE_MS = 2_000;

/** Native close operation. */
export type IrohCloseOp = 'reset' | 'stop';

/** `reset`/`stop` code on a normal socket close. */
const CLOSE_CODE = 0;

/**
 * The stream's slot at the owner (`listener.ts`). Each method is called at most once per `Duplex`.
 */
export interface IrohStreamSlot {
  /** Close operations started (`ops` not empty). */
  closing(ops: readonly IrohCloseOp[]): void;
  /** The operations did not finish within the deadline. */
  late(ops: readonly IrohCloseOp[], deadlineMs: number): void;
  /** The stream holds nothing in the library any more: the slot is free. `ops` empty = clean close. */
  release(ops: readonly IrohCloseOp[], elapsedMs: number): void;
}

export interface IrohDuplexOptions {
  readonly slot?: IrohStreamSlot;
  readonly clock?: IrohClock;
  readonly closeDeadlineMs?: number;
}

export class IrohDuplex extends Duplex {
  readonly #stream: IrohBiStream;
  readonly #slot: IrohStreamSlot | null;
  readonly #clock: IrohClock;
  readonly #closeDeadlineMs: number;
  #timeoutMs = 0;
  #idle: IrohTimer | null = null;
  #reading = false;
  #resume: (() => void) | null = null;
  #readEnded = false;
  #writeFinished = false;

  constructor(stream: IrohBiStream, options: IrohDuplexOptions = {}) {
    super({ allowHalfOpen: true }); // (5)
    this.#stream = stream;
    this.#slot = options.slot ?? null;
    this.#clock = options.clock ?? systemClock;
    this.#closeDeadlineMs = options.closeDeadlineMs ?? CLOSE_DEADLINE_MS;
  }

  /** (1) Idle timer like `net.Socket#setTimeout`: after `ms` without a read or write, the `timeout` event. */
  setTimeout(ms: number, callback?: () => void): this {
    this.#timeoutMs = ms;
    if (callback !== undefined) {
      if (ms === 0) this.removeListener('timeout', callback);
      else this.once('timeout', callback);
    }
    this.#arm();
    return this;
  }

  #arm(): void {
    this.#idle?.cancel();
    this.#idle = null;
    if (this.#timeoutMs > 0 && !this.destroyed) {
      this.#idle = this.#clock.after(this.#timeoutMs, () => {
        this.#idle = null;
        this.emit('timeout');
      });
    }
  }

  #touch(): void {
    if (this.#timeoutMs > 0) this.#arm();
  }

  // (4) One read at a time (receive mutex, fact 3); after `push() === false` the loop waits for `_read()`.
  override _read(): void {
    const resume = this.#resume;
    if (resume !== null) {
      this.#resume = null;
      resume();
      return;
    }
    if (!this.#reading) void this.#readLoop();
  }

  async #readLoop(): Promise<void> {
    this.#reading = true;
    try {
      for (;;) {
        const chunk = await this.#stream.read(READ_CHUNK);
        if (this.destroyed) return;
        this.#touch();
        if (chunk === null) {
          this.#readEnded = true;
          this.push(null); // (5) Client FIN: end of reading, sending stays open
          return;
        }
        if (!this.push(chunk)) {
          await new Promise<void>((resolve) => { this.#resume = resolve; });
          if (this.destroyed) return;
        }
      }
    } catch (err: unknown) {
      // (6) A read error (client reset, connection lost) destroys the socket; after `destroy()` it is only the close
      // echo.
      if (!this.destroyed) this.destroy(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.#reading = false;
    }
  }

  // (3) Callback only after the stream accepted the bytes.
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#touch();
    this.#stream.write(chunk).then(() => {
      this.#touch();
      callback();
    }, (err: unknown) => { callback(err instanceof Error ? err : new Error(String(err))); });
  }

  // (5) Send FIN.
  override _final(callback: (error?: Error | null) => void): void {
    this.#stream.finish().then(() => {
      this.#writeFinished = true;
      callback();
    }, (err: unknown) => { callback(err instanceof Error ? err : new Error(String(err))); });
  }

  /**
   * (6) Reset only the directions that have not finished: `reset` after FIN would drop unacknowledged response bytes.
   * Callback at once; the end of the native operations frees the slot, and after the deadline the owner gets `late`.
   */
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#idle?.cancel();
    this.#idle = null;
    const resume = this.#resume;
    this.#resume = null;
    resume?.();
    const ops: IrohCloseOp[] = [];
    if (!this.#writeFinished) ops.push('reset');
    if (!this.#readEnded) ops.push('stop');
    const slot = this.#slot;
    if (ops.length === 0) {
      slot?.release(ops, 0);
    } else {
      const started = this.#clock.now();
      slot?.closing(ops);
      const deadline = this.#clock.after(this.#closeDeadlineMs, () => { slot?.late(ops, this.#closeDeadlineMs); });
      // A synchronous binding exception counts as an operation that ended with an error: the slot must come back
      // anyway.
      const work = ops.map(async (op) => {
        await (op === 'reset' ? this.#stream.reset(CLOSE_CODE) : this.#stream.stop(CLOSE_CODE));
      });
      void Promise.allSettled(work).then(() => {
        deadline.cancel();
        slot?.release(ops, this.#clock.now() - started);
      });
    }
    callback(error);
  }
}
