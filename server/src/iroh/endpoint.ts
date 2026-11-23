/**
 * The iroh transport shape the rest of `server/src/iroh/` sees. No library: `adapter.ts` gives the implementation
 * with the native module, and tests pass an in-memory fake (`server/test/helpers/fake-iroh.ts`).
 *
 * Stream shape as measured: `read` returns a `Buffer` or `null` (FIN), `write` finishes only after the stream
 * accepted the bytes, `reset` and `stop` close a direction with a code. Any method can block in the library (one
 * mutex per stream half, the register of facts in `adapter.ts`), so the code above never waits for them without a
 * deadline.
 */

/** Receive half of a stream that may only be stopped (unidirectional stream). */
export interface IrohRecvStream {
  /** STOP_SENDING with a code: the sender gets a write error. */
  stop(code: number): Promise<void>;
}

/** Bidirectional stream: one HTTP/1.1 connection. */
export interface IrohBiStream extends IrohRecvStream {
  /** Up to `max` bytes; `null` = end of stream (sender's FIN). Error = reset or connection lost. */
  read(max: number): Promise<Buffer | null>;
  /** Finishes when the stream has accepted all bytes (QUIC flow control). */
  write(chunk: Buffer): Promise<void>;
  /** FIN of the send direction. */
  finish(): Promise<void>;
  /** RESET_STREAM with a code: drops unsent bytes. */
  reset(code: number): Promise<void>;
}

/** QUIC connection after the handshake: the client identity from TLS and its streams. */
export interface IrohConnection {
  /** Client EndpointId, 64 lowercase hex characters (public key from the handshake). */
  readonly remoteId: string;
  /** Next bidirectional stream opened by the client; error = connection closed. */
  acceptBi(): Promise<IrohBiStream>;
  /** Next unidirectional stream opened by the client; error = connection closed. */
  acceptUni(): Promise<IrohRecvStream>;
  /** Bidirectional stream credit QUIC gives the client for further streams. */
  setMaxConcurrentBiStreams(count: number): void;
  /** Unidirectional stream credit for further streams. */
  setMaxConcurrentUniStreams(count: number): void;
  /** CONNECTION_CLOSE with a code and reason; ends all streams of the connection. */
  close(code: number, reason: string): void;
  /** Finishes with a reason when the connection closes (from either side). */
  closed(): Promise<string>;
  /**
   * Calls `callback` with the path selected now (`initial`, when the library lists one), then with every path the
   * library switches to (`selected`), and with `lagged` when the library dropped path events. `stop` unregisters;
   * a watcher not stopped keeps the process alive.
   */
  watchSelectedPath(callback: (update: IrohPathUpdate) => void): IrohWatch;
  /** Lost packets of the connection over all paths so far; also after close. `null` = unknown. */
  lostPackets(): number | null;
}

/** The network path a connection uses: the relay or a direct IP address. */
export interface IrohSelectedPath {
  /** `initial`: selected when watching began; `selected`: the library switched to this path. */
  readonly kind: 'initial' | 'selected';
  readonly relay: boolean;
  /** `ip:port` of a direct path, the relay URL of a relay path. */
  readonly remoteAddr: string;
  /** RTT of the path in ms; `null` = the library does not list the path. */
  readonly rttMs: number | null;
}

/**
 * The library dropped path events (a switch may be among them): `missed` events (`null` = count unknown) and the path
 * `paths()` shows selected right after (`null` = none listed).
 */
export interface IrohPathLagged {
  readonly kind: 'lagged';
  readonly missed: number | null;
  readonly path: Omit<IrohSelectedPath, 'kind'> | null;
}

export type IrohPathUpdate = IrohSelectedPath | IrohPathLagged;

/** Handshake in progress on the server side. */
export interface IrohAccepting {
  /** ALPN negotiated in TLS. */
  alpn(): Promise<string>;
  /** End of the handshake: a connection or an error. */
  connect(): Promise<IrohConnection>;
}

/** Connection attempt before the handshake. */
export interface IrohIncoming {
  accept(): Promise<IrohAccepting>;
  /** Refusal without a handshake (CONNECTION_REFUSED packet). */
  refuse(): Promise<void>;
}

/** Handle of a library watcher; `stop` unregisters it. */
export interface IrohWatch {
  stop(): Promise<void>;
}

/** Server endpoint after `bind`. */
export interface IrohEndpoint {
  /** Server EndpointId, 64 lowercase hex characters. */
  readonly endpointId: string;
  /** Addresses of the UDP sockets the endpoint listens on (`host:port`). */
  boundSockets(): string[];
  /** Next connection attempt; `null` after the endpoint closes. */
  acceptNext(): Promise<IrohIncoming | null>;
  /** Finishes when the endpoint has a home relay. */
  online(): Promise<void>;
  /** Calls `callback` with the addresses of the relays the endpoint is connected to, on every change. */
  watchHomeRelay(callback: (relays: readonly string[]) => void): IrohWatch;
  /** Closes the endpoint and all its connections. */
  close(): Promise<void>;
}

/** Cancels a scheduled clock action. */
export interface IrohTimer {
  cancel(): void;
}

/**
 * Clock of the `iroh/` directory: deadlines (stream idle, close escalation, authentication, log budget window)
 * go through it, so tests can move time without waiting.
 */
export interface IrohClock {
  now(): number;
  /** Calls `callback` after `ms`; deadlines do not keep the process alive. */
  after(ms: number, callback: () => void): IrohTimer;
}

export const systemClock: IrohClock = {
  now: () => Date.now(),
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return { cancel: () => { clearTimeout(timer); } };
  },
};
