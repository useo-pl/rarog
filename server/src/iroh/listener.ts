/**
 * iroh listener: the QUIC endpoint, the accept loop, limits before authentication and injecting streams
 * into `http.Server` through `emit('connection', duplex)`. Each bidirectional stream is one HTTP/1.1 connection,
 * so routes, SSE and the WebSocket upgrade see an ordinary socket; `socket.ts` tells that it came over iroh.
 *
 * Order: `startIroh` opens the endpoint at once (failure = an exception for the caller), and the accept loop
 * starts only at the HTTP server's `listening`: Node's connection tracking (`headersTimeout`) works only on a server
 * that listens (requirement (2) in `duplex.ts`). `acceptNext` returning `null` or throwing outside closing ends the
 * process with code 1 (`onFatal`): a server with iroh on does not pretend to be healthy without the listener.
 *
 * Limits (`docs/security-model.md`, "Layer 1b"): authenticated = a connection with at least one active device
 * (`socket.ts`).
 */
import type http from 'node:http';
import { IROH_ALPN } from '@rarog/shared/iroh';
import { irohModuleInfo, openEndpoint } from './adapter.ts';
import type { IrohEndpointOptions, IrohModuleInfo } from './adapter.ts';
import { sanitizeLogText } from '../text.ts';
import { IrohDuplex } from './duplex.ts';
import type { IrohCloseOp, IrohStreamSlot } from './duplex.ts';
import type { IrohBiStream, IrohClock, IrohConnection, IrohEndpoint, IrohIncoming, IrohWatch } from './endpoint.ts';
import { systemClock } from './endpoint.ts';
import { createLogBudget } from './log-budget.ts';
import type { IrohRefusal } from './log-budget.ts';
import { startPathLog } from './path-log.ts';
import type { PathLog } from './path-log.ts';
import { registerIrohPeer } from './socket.ts';
import type { IrohPeerHandle } from './socket.ts';

/** Listener limits; the reason stands at each value. */
export const IROH_LIMITS = Object.freeze({
  /**
   * Handshakes in progress: each is cryptographic work and memory before authentication. 16 fits the app (one
   * connection per generation, at most two generations at once) with a large margin; the excess gets `refuse()`.
   */
  handshakes: 16,
  /**
   * Connections at once. The library has no limit (fact 9 in `adapter.ts`). A new one over the limit evicts the oldest
   * UNauthenticated one; when all are authenticated, the new one is closed (`busy`).
   */
  connections: 64,
  /** Life of a connection without a device: from the handshake or from losing the last device; then `auth-timeout`. */
  authTimeoutMs: 60_000,
  /**
   * Bidirectional streams before authentication. The app opens at least 8 HTTP connections at once plus the terminal,
   * and `URLSession` retries a GET up to 3 times, so 16, not 8.
   */
  biStreamsBeforeAuth: 16,
  /** Bidirectional streams of an authenticated connection. */
  biStreamsAfterAuth: 32,
  /** Stream idle margin above the HTTP server's `keepAliveTimeout` (76 s + 1 s). */
  idleMarginMs: 1_000,
  /** Deadline of `Endpoint.close()` when the server shuts down; the process fuse starts only after it. */
  endpointCloseMs: 3_000,
});

/** CONNECTION_CLOSE codes (QUIC application error) and reasons sent to the client. */
export const IROH_CLOSE = Object.freeze({
  bye: 0, // server shutdown
  alpn: 1,
  busy: 2,
  evicted: 3,
  authTimeout: 4,
  closeTimeout: 5, // escalation: stream close operations past the deadline
});

/** `reset`/`stop` code of a rejected stream (over the limit or unidirectional). */
export const IROH_STREAM_REFUSED = 1;

/** Phrase of the iroh listener start log line (`docs/server-config.md`, the check step after enabling). */
export const IROH_LISTENING_LOG = 'iroh: accepting connections';

/** EndpointId prefix in a log line (like the label in `socket.ts`). */
const SHORT_ID = 12;

export interface IrohLogger {
  info(message: string): void;
  error(message: string): void;
}

/** Listener configuration: key, relay and port. */
export interface IrohListenerConfig {
  /** The server's secret key, 32 bytes. */
  readonly secretKey: Uint8Array;
  /** Relay in canonical form; `null` = no relay (tests on the loopback address). */
  readonly relay: string | null;
  /** Fixed UDP port; `null` = port from the system. */
  readonly port: number | null;
}

export interface IrohListenerDeps {
  /** Opening the endpoint; tests pass a fake. By default `openEndpoint` from `adapter.ts`. */
  readonly open?: (options: IrohEndpointOptions) => Promise<IrohEndpoint>;
  readonly clock?: IrohClock;
  /** The accept loop died outside closing. By default a log line and `process.exit(1)`. */
  readonly onFatal?: (reason: string) => void;
}

/** Listener state for the admin socket and `rarog doctor`; without the key. */
export interface IrohSnapshot {
  readonly endpointId: string;
  /** Relay from the configuration. */
  readonly relay: string | null;
  readonly boundSockets: readonly string[];
  /**
   * Home relay from `watchHomeRelay`: addresses of the relays the endpoint chose, and the moment of the watcher's last
   * event (`null` = no event since start). This is NOT proof of a connection: the binding loses the relay state
   * (fact 7 in `adapter.ts`), so losing and regaining the same relay changes only `since`.
   */
  readonly homeRelay: { readonly relays: readonly string[]; readonly since: number | null };
  /**
   * First contact with the configured relay: when the endpoint started and when `online()` resolved (`null` = not
   * yet). The only sign that the relay accepted the server; `null` for the whole = no relay in the configuration.
   */
  readonly relayContact: { readonly startedAt: number; readonly firstContactAt: number | null } | null;
  readonly connections: { readonly authenticated: number; readonly unauthenticated: number };
  readonly handshakes: number;
  /** Bidirectional streams holding a slot (also closed ones whose native operations are still running). */
  readonly streams: number;
  /** `reset`/`stop` operations in progress; growth without a drop = blocked library operations. */
  readonly pendingCloseOps: number;
  readonly refusals: Readonly<Record<IrohRefusal, number>>;
}

export interface IrohListener {
  readonly endpointId: string;
  readonly relay: string | null;
  snapshot(): IrohSnapshot;
  /** Connections with code 0, `Endpoint.close()` with a 3 s deadline. A second call returns the same. */
  close(): Promise<void>;
}

/**
 * `GET /api/admin/iroh` (`docs/server-config.md`, "iroh listener"): the listener state without the key. The home
 * relay with the time of the watcher's last event (ISO), not "connected or not" (fact 7 in `adapter.ts`); the first
 * contact with the relay with its times in ISO. A disabled listener reports the native module too.
 */
export type IrohAdminStatus =
  | { readonly enabled: false; readonly module: IrohModuleInfo }
  | (Omit<IrohSnapshot, 'homeRelay' | 'relayContact'> & {
    readonly enabled: true;
    readonly port: number | null;
    readonly homeRelay: { readonly relays: readonly string[]; readonly since: string | null };
    readonly relayContact: { readonly startedAt: string; readonly firstContactAt: string | null } | null;
    readonly module: IrohModuleInfo;
  });

const iso = (at: number): string => new Date(at).toISOString();

/** State for the admin socket; `listener === null` = listener off. */
export function irohAdminStatus(
  listener: IrohListener | null, port: number | null, module: IrohModuleInfo = irohModuleInfo(),
): IrohAdminStatus {
  if (listener === null) return { enabled: false, module };
  const snapshot = listener.snapshot();
  const since = snapshot.homeRelay.since;
  const contact = snapshot.relayContact;
  return {
    enabled: true,
    ...snapshot,
    port,
    homeRelay: { relays: snapshot.homeRelay.relays, since: since === null ? null : iso(since) },
    relayContact: contact === null ? null : {
      startedAt: iso(contact.startedAt),
      firstContactAt: contact.firstContactAt === null ? null : iso(contact.firstContactAt),
    },
    module,
  };
}

interface Entry {
  readonly conn: IrohConnection;
  readonly short: string;
  readonly handle: IrohPeerHandle;
  /**
   * Path lines and the summary at close (`path-log.ts`), from the first authentication on; `null` before it. Only
   * authenticated connections log paths: anyone who knows the EndpointId can open unauthenticated ones in a row.
   */
  paths: PathLog | null;
  /** Sockets of the connection that are not destroyed yet (the end of the connection destroys them). */
  readonly sockets: Set<IrohDuplex>;
  streams: number;
  authTimer: { cancel(): void } | null;
  closed: boolean;
}

/**
 * An error of the library on one line: the `Caused by:` chain joined with `: `, then `sanitizeLogText`, because a
 * handshake error can carry text from the peer (a TLS alert, a close reason) that would drive the terminal showing
 * `server.log`.
 */
function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return sanitizeLogText(
    text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && line !== 'Caused by:').join(': '),
  );
}

const ignore = (): void => {};

/**
 * Opens the endpoint and returns the listener. The accept loop starts at the server's `listening` (or at once if it
 * already listens). An exception from `open` (no module, busy port, bad key) goes to the caller.
 */
export async function startIroh(
  config: IrohListenerConfig, server: http.Server, log: IrohLogger, deps: IrohListenerDeps = {},
): Promise<IrohListener> {
  const clock = deps.clock ?? systemClock;
  const open = deps.open ?? openEndpoint;
  const onFatal = deps.onFatal ?? ((reason: string) => {
    log.error(`iroh: accept loop failed (${reason}); the process exits with code 1`);
    process.exit(1);
  });
  const endpoint = await open({ secretKey: config.secretKey, relay: config.relay, port: config.port });
  const budget = createLogBudget((line) => { log.info(line); }, clock);
  const conns = new Set<Entry>(); // insertion order = connection age (evicting the oldest)
  let handshakes = 0;
  let streams = 0;
  let pendingCloseOps = 0;
  let closing = false;
  let closed: Promise<void> | null = null;
  let home: { relays: readonly string[]; since: number | null } = { relays: [], since: null };

  const watch: IrohWatch = endpoint.watchHomeRelay((relays) => {
    // Every event is a relay state change, also with the same address list (fact 7): `since` always moves,
    // the log line only on a different list.
    const changed = relays.join(' ') !== home.relays.join(' ');
    home = { relays: [...relays], since: clock.now() };
    if (changed) log.info(relays.length > 0 ? `iroh: home relay ${relays.join(', ')}` : 'iroh: no home relay');
  });
  let contact: { startedAt: number; firstContactAt: number | null } | null = null;
  if (config.relay !== null) {
    // Without a reachable relay `online()` never settles, also after `Endpoint.close()`, and cannot be cancelled
    // (fact 8 in `adapter.ts`): without a relay in the configuration it is never called, and with one the server
    // process ends through the shutdown fuse in `index.ts`, not through the event loop running empty. Retrying stays
    // with the library.
    const started = clock.now();
    contact = { startedAt: started, firstContactAt: null };
    endpoint.online().then(() => {
      const at = clock.now();
      contact = { startedAt: started, firstContactAt: at };
      log.info(`iroh: first contact with the relay after ${String(at - started)} ms`);
    }, ignore);
  }

  const idleMs = (): number => (server.keepAliveTimeout > 0 ? server.keepAliveTimeout + IROH_LIMITS.idleMarginMs : 0);

  const closeConn = (conn: IrohConnection, code: number, reason: string): void => {
    try {
      conn.close(code, reason);
    } catch {
      // already closed
    }
  };

  /**
   * One exit of a connection from the table: with a code (our close) or without (the client or the network closed).
   * Destroys the connection's sockets directly: a `Duplex` under backpressure has no read in progress, so it would
   * not notice the end of the connection by itself, and `ws` turns off the socket idle timer. First `close`, then
   * `destroy`: `reset`/`stop` on a closed connection finish at once (fact 4 in `adapter.ts`).
   */
  const drop = (entry: Entry, code: number | null, reason: string): void => {
    if (entry.closed) return;
    entry.closed = true;
    conns.delete(entry);
    entry.authTimer?.cancel();
    entry.authTimer = null;
    entry.handle.dispose();
    if (entry.paths !== null) void entry.paths.close();
    if (code !== null) closeConn(entry.conn, code, reason);
    for (const socket of [...entry.sockets]) socket.destroy();
  };

  const setBiLimit = (entry: Entry, count: number): void => {
    try {
      entry.conn.setMaxConcurrentBiStreams(count);
    } catch {
      // connection closed: the limit does not matter
    }
  };

  const armAuthTimer = (entry: Entry): void => {
    entry.authTimer?.cancel();
    entry.authTimer = clock.after(IROH_LIMITS.authTimeoutMs, () => {
      entry.authTimer = null;
      if (entry.closed || entry.handle.peer.authenticated) return;
      budget.note('auth-timeout', entry.short);
      drop(entry, IROH_CLOSE.authTimeout, 'auth-timeout');
    });
  };

  const onAuthChange = (entry: Entry, authenticated: boolean): void => {
    if (entry.closed) return;
    if (authenticated) {
      entry.authTimer?.cancel();
      entry.authTimer = null;
      setBiLimit(entry, IROH_LIMITS.biStreamsAfterAuth);
      // First authentication only: losing and regaining devices keeps the same path log.
      entry.paths ??= startPathLog(entry.conn, entry.short, (line) => { log.info(line); }, clock);
    } else {
      setBiLimit(entry, IROH_LIMITS.biStreamsBeforeAuth);
      armAuthTimer(entry);
    }
  };

  /** Stream without a slot: `reset` and `stop` at once (a fresh stream has no operations they would wait for). */
  const refuseStream = (stream: IrohBiStream): void => {
    void stream.reset(IROH_STREAM_REFUSED).catch(ignore);
    void stream.stop(IROH_STREAM_REFUSED).catch(ignore);
  };

  const openStream = (entry: Entry, stream: IrohBiStream): void => {
    entry.streams += 1;
    streams += 1;
    const slot: IrohStreamSlot = {
      closing: (ops) => { pendingCloseOps += ops.length; },
      late: (ops: readonly IrohCloseOp[], deadlineMs: number) => {
        budget.note('close-escalation', `${entry.short} ${ops.join('+')} over ${String(deadlineMs)} ms`);
        drop(entry, IROH_CLOSE.closeTimeout, 'close-timeout');
      },
      release: (ops) => {
        pendingCloseOps -= ops.length;
        entry.streams -= 1;
        streams -= 1;
      },
    };
    const duplex = new IrohDuplex(stream, { slot, clock });
    entry.sockets.add(duplex);
    duplex.once('close', () => { entry.sockets.delete(duplex); });
    // A throw in an `http.Server` listener comes back through the read loop as the socket's `'error'`. Node removes
    // its own `'error'` listener before `'upgrade'`, and an unheard `'error'` would end the process.
    duplex.on('error', ignore);
    entry.handle.attach(duplex);
    duplex.setTimeout(idleMs());
    try {
      server.emit('connection', duplex);
    } catch (err: unknown) {
      log.error(`iroh: http.Server failed to accept the stream: ${describe(err)}`);
      duplex.destroy();
    }
  };

  const biLoop = async (entry: Entry): Promise<void> => {
    for (;;) {
      let stream: IrohBiStream;
      try {
        stream = await entry.conn.acceptBi();
      } catch {
        return; // connection closed (fact 5)
      }
      const limit = entry.handle.peer.authenticated ? IROH_LIMITS.biStreamsAfterAuth : IROH_LIMITS.biStreamsBeforeAuth;
      if (entry.closed || entry.streams >= limit) {
        if (!entry.closed) budget.note('stream-limit', `${entry.short} over ${String(limit)}`);
        refuseStream(stream);
        continue;
      }
      openStream(entry, stream);
    }
  };

  const uniLoop = async (entry: Entry): Promise<void> => {
    for (;;) {
      let stream;
      try {
        stream = await entry.conn.acceptUni();
      } catch {
        return;
      }
      budget.note('uni-stream', entry.short);
      void stream.stop(IROH_STREAM_REFUSED).catch(ignore);
    }
  };

  const admit = (conn: IrohConnection): void => {
    const short = conn.remoteId.slice(0, SHORT_ID);
    if (conns.size >= IROH_LIMITS.connections) {
      let victim: Entry | undefined;
      for (const entry of conns) {
        if (!entry.handle.peer.authenticated) {
          victim = entry;
          break;
        }
      }
      if (victim === undefined) {
        budget.note('busy', short);
        closeConn(conn, IROH_CLOSE.busy, 'busy');
        return;
      }
      budget.note('evicted', `${victim.short} for ${short}`);
      drop(victim, IROH_CLOSE.evicted, 'evicted');
    }
    // A state change comes only from an HTTP request, so the entry always exists already; `ref` closes the entry ↔
    // handle cycle.
    const ref: { entry: Entry | null } = { entry: null };
    const handle = registerIrohPeer(conn.remoteId, (authenticated) => {
      if (ref.entry !== null) onAuthChange(ref.entry, authenticated);
    }, (kind, detail) => { budget.note(kind, `${short} ${detail}`); });
    const entry: Entry = {
      conn, short, handle, paths: null, sockets: new Set(), streams: 0, authTimer: null, closed: false,
    };
    ref.entry = entry;
    conns.add(entry);
    setBiLimit(entry, IROH_LIMITS.biStreamsBeforeAuth);
    try {
      conn.setMaxConcurrentUniStreams(0);
    } catch {
      // connection closed
    }
    armAuthTimer(entry);
    conn.closed().then(() => { drop(entry, null, 'closed'); }, () => { drop(entry, null, 'closed'); });
    void biLoop(entry);
    void uniLoop(entry);
  };

  const handshake = async (incoming: IrohIncoming): Promise<void> => {
    let conn: IrohConnection;
    let alpn: string;
    try {
      const accepting = await incoming.accept();
      alpn = await accepting.alpn();
      conn = await accepting.connect();
    } catch (err: unknown) {
      if (!closing) budget.note('handshake-error', describe(err));
      return;
    }
    if (closing) {
      closeConn(conn, IROH_CLOSE.bye, 'bye');
      return;
    }
    if (alpn !== IROH_ALPN) {
      budget.note('alpn', `${JSON.stringify(alpn.slice(0, 64))} from ${conn.remoteId.slice(0, SHORT_ID)}`);
      closeConn(conn, IROH_CLOSE.alpn, 'alpn');
      return;
    }
    admit(conn);
  };

  const acceptLoop = async (): Promise<void> => {
    for (;;) {
      let incoming: IrohIncoming | null;
      try {
        incoming = await endpoint.acceptNext();
      } catch (err: unknown) {
        if (!closing) onFatal(`acceptNext rzuciło: ${describe(err)}`);
        return;
      }
      if (incoming === null) {
        if (!closing) onFatal('acceptNext oddało null');
        return;
      }
      if (closing) {
        void incoming.refuse().catch(ignore);
        return;
      }
      if (handshakes >= IROH_LIMITS.handshakes) {
        budget.note('handshake-refused', `over ${String(IROH_LIMITS.handshakes)} in progress`);
        void incoming.refuse().catch(ignore);
        continue;
      }
      handshakes += 1;
      void handshake(incoming).finally(() => { handshakes -= 1; });
    }
  };

  const start = (): void => {
    if (closing) return;
    let sockets: readonly string[] = [];
    try {
      sockets = endpoint.boundSockets();
    } catch {
      // without addresses the start line is true anyway
    }
    log.info(`${IROH_LISTENING_LOG} (EndpointId ${endpoint.endpointId}, relay ${config.relay ?? 'none'},`
      + ` UDP ${sockets.join(' ')})`);
    void acceptLoop();
  };
  if (server.listening) start();
  else server.once('listening', start);

  return {
    endpointId: endpoint.endpointId,
    relay: config.relay,
    snapshot(): IrohSnapshot {
      let authenticated = 0;
      for (const entry of conns) if (entry.handle.peer.authenticated) authenticated += 1;
      let boundSockets: string[] = [];
      try {
        boundSockets = endpoint.boundSockets();
      } catch {
        boundSockets = [];
      }
      return {
        endpointId: endpoint.endpointId,
        relay: config.relay,
        boundSockets,
        homeRelay: { relays: [...home.relays], since: home.since },
        relayContact: contact === null ? null : { ...contact },
        connections: { authenticated, unauthenticated: conns.size - authenticated },
        handshakes,
        streams,
        pendingCloseOps,
        refusals: budget.totals(),
      };
    },
    close(): Promise<void> {
      if (closed !== null) return closed;
      closing = true;
      server.removeListener('listening', start);
      // A path watcher not stopped keeps the process alive (fact 7 in `adapter.ts`): the endpoint closes after them.
      const pathStops = [...conns].flatMap((entry) => (entry.paths === null ? [] : [entry.paths.close()]));
      for (const entry of [...conns]) drop(entry, IROH_CLOSE.bye, 'bye');
      budget.flush();
      closed = new Promise<void>((resolve) => {
        const deadline = clock.after(IROH_LIMITS.endpointCloseMs, () => {
          log.error(`iroh: Endpoint.close() timed out after ${String(IROH_LIMITS.endpointCloseMs)} ms`);
          resolve();
        });
        void (async () => {
          await Promise.all([watch.stop().catch(ignore), ...pathStops]);
          await endpoint.close();
        })().then(() => {
          deadline.cancel();
          log.info('iroh: endpoint closed');
          resolve();
        }, (err: unknown) => {
          deadline.cancel();
          log.error(`iroh: Endpoint.close(): ${describe(err)}`);
          resolve();
        });
      });
      return closed;
    },
  };
}
