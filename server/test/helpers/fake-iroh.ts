/**
 * Atrapa transportu iroh w pamięci (`server/src/iroh/endpoint.ts`) i zegar ręczny dla testów nasłuchu i `Duplex`.
 *
 * Atrapa odtwarza zachowanie wiązania z rejestru faktów `server/src/iroh/adapter.ts`, od którego zależy kod:
 * - jeden mutex na połowę strumienia: `read` trzyma mutex odbioru, `write` mutex wysyłki, a `stop` i `reset` czekają
 *   na nie (fakt 3);
 * - `write` kończy się dopiero, gdy w kierunku leży najwyżej `window` bajtów (kontrola przepływu QUIC);
 * - `close` połączenia kończy wiszące `read` i `write` błędem, więc czekające `reset`/`stop` się kończą (fakt 4);
 * - `acceptBi`/`acceptUni` po zamknięciu rzucają, `acceptNext` po zamknięciu endpointu oddaje `null` (fakt 5).
 * Usterki wstrzykuje test: błąd odczytu, zawieszony handshake, błąd na etapie handshake'u, wiszące `Endpoint.close()`.
 */
import { Duplex } from 'node:stream';
import { IROH_ALPN } from '@rarog/shared/iroh';
import type {
  IrohAccepting, IrohBiStream, IrohClock, IrohConnection, IrohEndpoint, IrohIncoming, IrohRecvStream,
  IrohPathUpdate, IrohSelectedPath, IrohTimer, IrohWatch,
} from '../../src/iroh/endpoint.ts';

const noop = (): void => {};

/** Oczekiwanie na zmianę stanu: `wait()` kończy się przy następnym `notify()`. */
class Signal {
  #waiters: Array<() => void> = [];
  wait(): Promise<void> {
    return new Promise((resolve) => { this.#waiters.push(resolve); });
  }
  notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Mutex (kolejka obietnic) jak tokio `Mutex` w wiązaniu. */
class Lock {
  #tail: Promise<void> = Promise.resolve();
  held = false;
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      this.held = true;
      try {
        return await fn();
      } finally {
        this.held = false;
      }
    });
    this.#tail = result.then(noop, noop);
    return result;
  }
}

/** Jeden kierunek strumienia: bajty od nadawcy do odbiorcy. */
class Lane {
  readonly chunks: Buffer[] = [];
  buffered = 0;
  /** FIN nadawcy. */
  ended = false;
  /** RESET_STREAM nadawcy: odbiorca dostaje błąd. */
  resetCode: number | null = null;
  /** STOP_SENDING odbiorcy: zapis nadawcy dostaje błąd. */
  stopCode: number | null = null;
  readonly changed = new Signal();
  constructor(readonly window: number) {}
}

export class LocallyClosed extends Error {
  constructor() {
    super('ConnectionLost(LocallyClosed)');
  }
}

/** Liczniki operacji jednego końca strumienia (dowód, co Duplex zawołał). */
export interface StreamOps {
  read: number;
  write: number;
  finish: number;
  reset: number;
  stop: number;
  resetDone: number;
  stopDone: number;
}

/** Koniec strumienia dwukierunkowego atrapy (serwera albo klienta). */
export class FakeBiStream implements IrohBiStream {
  readonly ops: StreamOps = { read: 0, write: 0, finish: 0, reset: 0, stop: 0, resetDone: 0, stopDone: 0 };
  readonly sendLock = new Lock();
  readonly recvLock = new Lock();
  /** Następny (albo wiszący) odczyt kończy się tym błędem. */
  #readFault: Error | null = null;

  constructor(
    private readonly conn: FakeConnection,
    private readonly inbound: Lane,
    private readonly outbound: Lane,
  ) {}

  /** Usterka: odczyt (także wiszący) rzuca `err`. */
  failRead(err: Error): void {
    this.#readFault = err;
    this.inbound.changed.notify();
  }

  read(max: number): Promise<Buffer | null> {
    this.ops.read += 1;
    return this.recvLock.run(async () => {
      for (;;) {
        if (this.#readFault !== null) throw this.#readFault;
        if (this.conn.isClosed) throw new LocallyClosed();
        if (this.inbound.resetCode !== null) throw new Error(`Reset(${String(this.inbound.resetCode)})`);
        const head = this.inbound.chunks[0];
        if (head !== undefined) {
          const out = head.subarray(0, max);
          if (out.length === head.length) this.inbound.chunks.shift();
          else this.inbound.chunks[0] = head.subarray(max);
          this.inbound.buffered -= out.length;
          this.inbound.changed.notify();
          return Buffer.from(out);
        }
        if (this.inbound.ended) return null;
        await Promise.race([this.inbound.changed.wait(), this.conn.closedSignal.wait()]);
      }
    });
  }

  write(chunk: Buffer): Promise<void> {
    this.ops.write += 1;
    return this.sendLock.run(async () => {
      const lane = this.outbound;
      if (lane.ended || lane.resetCode !== null) throw new Error('ClosedStream');
      lane.chunks.push(Buffer.from(chunk));
      lane.buffered += chunk.length;
      lane.changed.notify();
      for (;;) {
        if (this.conn.isClosed) throw new LocallyClosed();
        if (lane.stopCode !== null) throw new Error(`Stopped(${String(lane.stopCode)})`);
        if (lane.buffered <= lane.window) return;
        await Promise.race([lane.changed.wait(), this.conn.closedSignal.wait()]);
      }
    });
  }

  finish(): Promise<void> {
    this.ops.finish += 1;
    return this.sendLock.run(async () => {
      if (this.conn.isClosed) throw new LocallyClosed();
      this.outbound.ended = true;
      this.outbound.changed.notify();
    });
  }

  reset(code: number): Promise<void> {
    this.ops.reset += 1;
    return this.sendLock.run(async () => {
      this.outbound.resetCode = code;
      this.outbound.changed.notify();
      this.ops.resetDone += 1;
    });
  }

  stop(code: number): Promise<void> {
    this.ops.stop += 1;
    return this.recvLock.run(async () => {
      this.inbound.stopCode = code;
      this.inbound.changed.notify();
      this.ops.stopDone += 1;
    });
  }

  /** Bajty, które czekają na odbiór w kierunku do tego końca. */
  get inboundBuffered(): number {
    return this.inbound.buffered;
  }
}

/** Para końców jednego strumienia. */
export interface FakeStreamPair {
  readonly server: FakeBiStream;
  readonly client: FakeBiStream;
}

export interface FakeConnectionOptions {
  /** Okno kontroli przepływu na kierunek (bajty). */
  readonly window?: number;
}

/** Połączenie atrapy: widok serwera (`IrohConnection`) i sterowanie klienta. */
export class FakeConnection implements IrohConnection {
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  readonly biLimits: number[] = [];
  readonly uniLimits: number[] = [];
  readonly pairs: FakeStreamPair[] = [];
  readonly uniStops: number[] = [];
  readonly closedSignal = new Signal();
  isClosed = false;
  /** Path watchers started and `stop()` calls on them (path log). */
  pathWatches = 0;
  pathWatchStops = 0;
  /** What `lostPackets()` returns. */
  lost: number | null = 0;
  #pathCallback: ((update: IrohPathUpdate) => void) | null = null;
  #biQueue: FakeBiStream[] = [];
  #uniQueue: IrohRecvStream[] = [];
  readonly #arrived = new Signal();
  #closedResolve: (reason: string) => void = noop;
  readonly #closed: Promise<string>;
  readonly #window: number;

  constructor(readonly remoteId: string, options: FakeConnectionOptions = {}) {
    this.#window = options.window ?? 1024 * 1024;
    this.#closed = new Promise((resolve) => { this.#closedResolve = resolve; });
  }

  /** Klient otwiera strumień dwukierunkowy; zwraca koniec klienta. */
  openBi(): FakeBiStream {
    const toServer = new Lane(this.#window);
    const toClient = new Lane(this.#window);
    const server = new FakeBiStream(this, toServer, toClient);
    const client = new FakeBiStream(this, toClient, toServer);
    this.pairs.push({ server, client });
    this.#biQueue.push(server);
    this.#arrived.notify();
    return client;
  }

  /** Klient otwiera strumień jednokierunkowy. */
  openUni(): void {
    const index = this.uniStops.length;
    this.uniStops.push(-1);
    this.#uniQueue.push({ stop: async (code) => { this.uniStops[index] = code; } });
    this.#arrived.notify();
  }

  /** Klient (albo sieć) zamyka połączenie. */
  peerClose(reason = 'closed by peer'): void {
    this.#shut(reason);
  }

  #shut(reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closedSignal.notify();
    this.#arrived.notify();
    this.#closedResolve(reason);
  }

  async acceptBi(): Promise<IrohBiStream> {
    for (;;) {
      if (this.isClosed) throw new Error('LocallyClosed');
      const next = this.#biQueue.shift();
      if (next !== undefined) return next;
      await this.#arrived.wait();
    }
  }

  async acceptUni(): Promise<IrohRecvStream> {
    for (;;) {
      if (this.isClosed) throw new Error('LocallyClosed');
      const next = this.#uniQueue.shift();
      if (next !== undefined) return next;
      await this.#arrived.wait();
    }
  }

  setMaxConcurrentBiStreams(count: number): void {
    this.biLimits.push(count);
  }

  setMaxConcurrentUniStreams(count: number): void {
    this.uniLimits.push(count);
  }

  close(code: number, reason: string): void {
    this.closeCalls.push({ code, reason });
    this.#shut(`closed: ${reason}`);
  }

  closed(): Promise<string> {
    return this.#closed;
  }

  watchSelectedPath(callback: (update: IrohPathUpdate) => void): IrohWatch {
    this.pathWatches += 1;
    this.#pathCallback = callback;
    return { stop: async () => { this.pathWatchStops += 1; this.#pathCallback = null; } };
  }

  /** The library switches the connection to `path` (a `Selected` event). */
  selectPath(path: Omit<IrohSelectedPath, 'kind'>, kind: IrohSelectedPath['kind'] = 'selected'): void {
    this.#pathCallback?.({ kind, ...path });
  }

  /** The library lost `missed` path events (`null` = count unknown); `path` is what `paths()` shows selected now. */
  lagPaths(missed: number | null, path: Omit<IrohSelectedPath, 'kind'> | null): void {
    this.#pathCallback?.({ kind: 'lagged', missed, path });
  }

  lostPackets(): number | null {
    return this.lost;
  }
}

export type HandshakeFault = 'accept' | 'alpn' | 'connect';

export interface FakeIncomingOptions {
  readonly alpn?: string;
  readonly fail?: HandshakeFault;
  /** Handshake wisi na `accept()` do `release()`. */
  readonly hold?: boolean;
  readonly window?: number;
}

/** Próba połączenia atrapy. */
export class FakeIncoming implements IrohIncoming {
  refused = false;
  readonly connection: FakeConnection;
  #release: () => void = noop;
  readonly #held: Promise<void>;

  constructor(remoteId: string, private readonly options: FakeIncomingOptions = {}) {
    this.connection = new FakeConnection(remoteId, options.window === undefined ? {} : { window: options.window });
    this.#held = options.hold === true ? new Promise((resolve) => { this.#release = resolve; }) : Promise.resolve();
  }

  release(): void {
    this.#release();
  }

  async accept(): Promise<IrohAccepting> {
    await this.#held;
    if (this.options.fail === 'accept') throw new Error('handshake: accept');
    return {
      alpn: async () => {
        if (this.options.fail === 'alpn') throw new Error('handshake: alpn');
        return this.options.alpn ?? IROH_ALPN;
      },
      connect: async () => {
        if (this.options.fail === 'connect') throw new Error('handshake: timeout');
        return this.connection;
      },
    };
  }

  async refuse(): Promise<void> {
    this.refused = true;
  }
}

/** Endpoint atrapy. */
export class FakeEndpoint implements IrohEndpoint {
  readonly endpointId: string;
  closeCalls = 0;
  /** `close()` wisi (termin w nasłuchu). */
  closeHangs = false;
  watchStops = 0;
  #queue: Array<FakeIncoming | Error | null> = [];
  readonly #arrived = new Signal();
  #closed = false;
  #relayCallback: ((relays: readonly string[]) => void) | null = null;
  #onlineResolve: () => void = noop;
  readonly #online = new Promise<void>((resolve) => { this.#onlineResolve = resolve; });

  constructor(endpointId = 'e'.repeat(64)) {
    this.endpointId = endpointId;
  }

  /** Nowa próba połączenia od klienta `remoteId`. */
  incoming(remoteId: string, options: FakeIncomingOptions = {}): FakeIncoming {
    const incoming = new FakeIncoming(remoteId, options);
    this.#queue.push(incoming);
    this.#arrived.notify();
    return incoming;
  }

  /** Usterka pętli: następne `acceptNext` rzuca `err` albo oddaje `null` bez zamknięcia. */
  breakAccept(fault: Error | null): void {
    this.#queue.push(fault);
    this.#arrived.notify();
  }

  emitRelays(relays: readonly string[]): void {
    this.#relayCallback?.(relays);
  }

  boundSockets(): string[] {
    return ['0.0.0.0:7842', '[::]:7842'];
  }

  async acceptNext(): Promise<IrohIncoming | null> {
    for (;;) {
      if (this.#closed) return null;
      if (this.#queue.length > 0) {
        const next = this.#queue.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      }
      await this.#arrived.wait();
    }
  }

  /** `online()` waits until the test announces the first contact with the relay ({@link resolveOnline}); else hangs. */
  online(): Promise<void> {
    return this.#online;
  }

  /** First contact with the relay: every `online()` resolves. */
  resolveOnline(): void {
    this.#onlineResolve();
  }

  watchHomeRelay(callback: (relays: readonly string[]) => void): IrohWatch {
    this.#relayCallback = callback;
    return { stop: async () => { this.watchStops += 1; this.#relayCallback = null; } };
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.#closed = true;
    this.#arrived.notify();
    return this.closeHangs ? new Promise(noop) : Promise.resolve();
  }
}

/** Zegar ręczny: `advance` woła zaległe terminy po kolei, bez czekania. */
export class ManualClock implements IrohClock {
  #now = 1_000_000;
  #timers: Array<{ at: number; seq: number; callback: () => void; live: boolean }> = [];
  #seq = 0;

  now(): number {
    return this.#now;
  }

  after(ms: number, callback: () => void): IrohTimer {
    const timer = { at: this.#now + ms, seq: this.#seq++, callback, live: true };
    this.#timers.push(timer);
    return { cancel: () => { timer.live = false; } };
  }

  /** Przesuwa czas o `ms`, wołając terminy w kolejności; między nimi oddaje kolejkę mikrozadań. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers
        .filter((timer) => timer.live && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (due === undefined) break;
      due.live = false;
      this.#now = due.at;
      due.callback();
      await settle();
    }
    this.#now = target;
    this.#timers = this.#timers.filter((timer) => timer.live);
    await settle();
  }

  /** Terminy, które jeszcze czekają. */
  get pending(): number {
    return this.#timers.filter((timer) => timer.live).length;
  }
}

/** Kilka obrotów kolejki zdarzeń: mikrozadania i `setImmediate` (strumienie Node). */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

/** Czeka, aż `condition` będzie prawdziwe (najwyżej `ms`). */
export async function until(condition: () => boolean, ms = 2_000, label = 'warunek'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${label}: brak po ${String(ms)} ms`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

/**
 * Gniazdo klienta HTTP i `ws` po atrapie (`createConnection`): osobna, prosta implementacja, żeby test nie sprawdzał
 * `IrohDuplex` nim samym.
 */
export class FakeClientSocket extends Duplex {
  #reading = false;

  constructor(readonly stream: FakeBiStream) {
    super({ allowHalfOpen: true });
  }

  override _read(): void {
    if (this.#reading) return;
    this.#reading = true;
    void (async () => {
      for (;;) {
        let chunk: Buffer | null;
        try {
          chunk = await this.stream.read(64 * 1024);
        } catch (err: unknown) {
          if (!this.destroyed) this.destroy(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (this.destroyed) return;
        if (chunk === null) {
          this.push(null);
          return;
        }
        this.push(chunk);
      }
    })();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.stream.write(chunk).then(() => { callback(); }, (err: unknown) => { callback(err as Error); });
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.stream.finish().then(() => { callback(); }, (err: unknown) => { callback(err as Error); });
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void this.stream.reset(0).catch(noop);
    void this.stream.stop(0).catch(noop);
    callback(error);
  }

  setTimeout(): this {
    return this;
  }
}

/** EndpointId klienta atrapy: 64 znaki hex z jednej cyfry i numeru. */
export function fakeClientId(n: number): string {
  return `${String(n % 10)}${n.toString(16).padStart(8, '0')}`.padEnd(64, 'a');
}
