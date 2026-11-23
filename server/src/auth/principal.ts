/**
 * One authentication boundary: who stands behind a request.
 *
 * Every surface behind the gate asks THIS function and gets the same result for the same request:
 * the router (REST and both SSE streams, `/api/stream` and `…/sessions/:id/stream`, go through its
 * gate) and the terminal WebSocket upgrade (`term/ws.ts`). The Origin gate does NOT belong to this function:
 * it stays at the router and at the upgrade, because it protects against something else (another site in a browser),
 * and does not say who the client is.
 *
 * The only credential is the device key from pairing: the header `Authorization: Rarog-Device <id>.<secret>`
 * (`device.ts`). The server has no token or cookie login: the `Cookie` header opens nothing, and `POST /api/login`
 * answers a fixed 410 `login-retired` (router). Boundary guard: `server/test/auth-principal.test.ts` (outside `auth/`
 * nobody reads `Authorization` directly).
 *
 * **iroh socket.** A successful device key adds the device to the QUIC connection (`markAuthenticated`):
 * listener limits and eviction protection belong to the connection, and this place is one for REST, SSE
 * and the upgrade. On a TCP socket it does nothing.
 */
import type { IncomingMessage } from 'node:http';
import type { DeviceRevokedBy } from '@rarog/shared/rest';
import { checkDevice } from './device.ts';
import type { DeviceStore } from './devices-store.ts';
import { markAuthenticated } from '../iroh/socket.ts';

/** A client with a valid device key. `label` = the label from pairing, after sanitizing. */
export interface DevicePrincipal {
  readonly kind: 'device';
  readonly deviceId: string;
  readonly label: string;
}

/** An authenticated client: always a paired device. */
export type Principal = DevicePrincipal;

/**
 * Why refused: `missing` = no `Authorization` header (401 `unauthorized`), `device-unknown` = a key
 * the server does not know (also a bad secret and a foreign `Authorization` scheme), `device-revoked` = the key of a
 * revoked or expired device (401 with a date).
 */
export type AuthRefusal =
  | { readonly kind: 'missing' }
  | { readonly kind: 'device-unknown' }
  | { readonly kind: 'device-revoked'; readonly revokedAt: string; readonly revokedBy: DeviceRevokedBy };

export type AuthResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly refusal: AuthRefusal };

/**
 * Who stands behind the request. Refusal: the router answers 401 (with the code from {@link AuthRefusal}), the
 * WebSocket upgrade ends with `socket.destroy()`.
 *
 * @param devices the device key store; absent (tests without pairing) = every
 *   `Authorization` header is `device-unknown`.
 */
export function authenticate(req: IncomingMessage, devices: DeviceStore | undefined): AuthResult {
  const authorization = req.headers.authorization;
  if (authorization === undefined) return { ok: false, refusal: { kind: 'missing' } };
  if (devices === undefined) return { ok: false, refusal: { kind: 'device-unknown' } };
  const check = checkDevice(devices, authorization);
  if (check.ok) {
    markAuthenticated(req.socket, check.record.id);
    return { ok: true, principal: { kind: 'device', deviceId: check.record.id, label: check.record.label } };
  }
  if (check.reason === 'device-revoked') {
    return {
      ok: false,
      refusal: { kind: 'device-revoked', revokedAt: check.tombstone.revokedAt, revokedBy: check.tombstone.revokedBy },
    };
  }
  return { ok: false, refusal: { kind: 'device-unknown' } };
}
