/**
 * iroh socket marker without the library and without the rest of the directory: the only module of
 * `server/src/iroh/` the HTTP layer may import (`auth/`, router, `term/ws.ts`, `device-effects.ts`; guard
 * `server/test/iroh-granice.test.ts`).
 *
 * A socket (the listener's `Duplex`) belongs to one QUIC connection, and authentication belongs to the CONNECTION:
 * the set of devices that passed device key authentication on it. A connection with at least one active device is
 * authenticated (higher stream limit, no deadline, protection from eviction), and revoking a device
 * (`revokeDevice`) removes it from all connections at once. The listener gets the state change through `onAuthChange`.
 *
 * HTTP layer refusals on an iroh socket (bad `Origin`, upgrade refusal, `/api/login`) go through
 * {@link noteIrohRefusal} to the listener's log budget instead of an ordinary line: before authentication anyone who
 * knows the server's EndpointId can trigger them as often as they like.
 *
 * A TCP socket has no entry: `isIrohSocket` says `false`, and `markAuthenticated` and `noteIrohRefusal` do nothing.
 */

/** Length of the EndpointId prefix in the log label. */
const LABEL_ID_LENGTH = 12;

/** HTTP layer refusals on an iroh socket counted in the listener's log budget (a subset of `log-budget.ts` kinds). */
export type IrohHttpRefusal = 'origin' | 'upgrade-refused' | 'login';

/** Receiver of HTTP layer refusals: the listener adds the EndpointId prefix and hands them to the log budget. */
export type IrohRefusalSink = (kind: IrohHttpRefusal, detail: string) => void;

interface PeerRecord {
  readonly endpointId: string;
  readonly devices: Set<string>;
  readonly onAuthChange: (authenticated: boolean) => void;
  readonly onRefusal: IrohRefusalSink | null;
  live: boolean;
}

/** QUIC connection as seen from the socket. */
export interface IrohPeer {
  /** Client EndpointId from the TLS handshake (64 hex characters). */
  readonly endpointId: string;
  /** Devices whose key passed on this connection and that are not revoked. */
  readonly devices: ReadonlySet<string>;
  readonly authenticated: boolean;
}

/** Connection handle held by the listener. */
export interface IrohPeerHandle {
  readonly peer: IrohPeer;
  /** A socket was created on this connection. */
  attach(socket: object): void;
  /** Connection closed: end of state changes and removal from `revokeDevice`. */
  dispose(): void;
}

const sockets = new WeakMap<object, PeerRecord>();
const peers = new Set<PeerRecord>();

function viewOf(record: PeerRecord): IrohPeer {
  return {
    endpointId: record.endpointId,
    devices: record.devices,
    get authenticated() { return record.devices.size > 0; },
  };
}

function recordOf(socket: unknown): PeerRecord | undefined {
  return typeof socket === 'object' && socket !== null ? sockets.get(socket) : undefined;
}

/** New QUIC connection (listener, after the handshake). */
export function registerIrohPeer(
  endpointId: string, onAuthChange: (authenticated: boolean) => void, onRefusal: IrohRefusalSink | null = null,
): IrohPeerHandle {
  const record: PeerRecord = { endpointId, devices: new Set(), onAuthChange, onRefusal, live: true };
  peers.add(record);
  return {
    peer: viewOf(record),
    attach: (socket) => { sockets.set(socket, record); },
    dispose: () => {
      record.live = false;
      record.devices.clear();
      peers.delete(record);
    },
  };
}

/** The socket came from the iroh listener. */
export function isIrohSocket(socket: unknown): boolean {
  return recordOf(socket) !== undefined;
}

/** Connection of an iroh socket, or `null` for another socket. */
export function irohPeerOf(socket: unknown): IrohPeer | null {
  const record = recordOf(socket);
  return record === undefined ? null : viewOf(record);
}

/**
 * Source label for the log: `iroh:<12 characters of EndpointId>`. The EndpointId comes from the handshake (the
 * client key), so it is authenticated and has only hex characters. `null` for a socket outside the listener.
 */
export function irohPeerLabel(socket: unknown): string | null {
  const record = recordOf(socket);
  return record === undefined ? null : `iroh:${record.endpointId.slice(0, LABEL_ID_LENGTH)}`;
}

/** A device key passed on this socket: the device joins the connection. TCP socket: nothing. */
export function markAuthenticated(socket: unknown, deviceId: string): void {
  const record = recordOf(socket);
  if (record === undefined || !record.live || record.devices.has(deviceId)) return;
  record.devices.add(deviceId);
  if (record.devices.size === 1) record.onAuthChange(true);
}

/**
 * HTTP layer refusal on an iroh socket goes to the listener's log budget. `true` = iroh socket, the budget took the
 * refusal; `false` = another socket, the caller logs it itself as before. The detail comes from the client (a path);
 * the budget cleans and cuts it before the line (`log-budget.ts`), because this module imports nothing.
 */
export function noteIrohRefusal(socket: unknown, kind: IrohHttpRefusal, detail: string): boolean {
  const record = recordOf(socket);
  if (record === undefined) return false;
  record.onRefusal?.(kind, detail);
  return true;
}

/** Device revoked: it disappears from all connections; a connection without devices goes back to unauthenticated. */
export function revokeDevice(deviceId: string): void {
  for (const record of [...peers]) {
    if (record.devices.delete(deviceId) && record.devices.size === 0) record.onAuthChange(false);
  }
}
