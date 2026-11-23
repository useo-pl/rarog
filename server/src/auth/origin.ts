/**
 * The `Origin` rule (CSRF defense): ONE definition for the router (REST), the terminal WebSocket upgrade
 * (`term/ws.ts`) and the demo control (`demo/control.ts`, which adds its own loopback and `http:` conditions on top).
 * Guard `server/test/iroh-granice.test.ts`: `originAllowList.includes` stands only here.
 *
 * Checked: methods from {@link ORIGIN_CHECKED_METHODS} and every upgrade. GET and SSE without an `Origin` check.
 *
 * The iroh socket accepts only `IROH_ORIGIN`, the TCP socket only the `RAROG_ORIGINS` list. A browser will not
 * send `IROH_ORIGIN` (the `.invalid` domain resolves nowhere), and the app over iroh does not give the server's web
 * address, so neither path accepts the other's `Origin`.
 */
import type { IncomingMessage } from 'node:http';
import { IROH_ORIGIN } from '@rarog/shared/iroh';
import type { RarogConfig } from '../config.ts';
import { isIrohSocket } from '../iroh/socket.ts';

/** Methods of mutating requests the router checks with the {@link originAllowed} rule. */
export const ORIGIN_CHECKED_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'DELETE']);

/** Whether the request's `Origin` is allowed on this socket; no header = no. */
export function originAllowed(req: IncomingMessage, config: Pick<RarogConfig, 'originAllowList'>): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  if (isIrohSocket(req.socket)) return origin === IROH_ORIGIN;
  return config.originAllowList.includes(origin);
}
