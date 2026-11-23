/**
 * Consent channel registration socket (layer 1): `<dataDir>/run/consent.sock`, in the same `run/` directory
 * (`0o700`) as the admin socket, file `0o600`. Route `POST /register` with a registration body
 * (`ConsentRegistration`, at most 32 KiB); the response and the acceptance rules: `herdr/dialogs/layer1/registry.ts`.
 * Route `POST /claim`: the hook's signed receipt of an `allow` (`ConsentClaim`, at most 1024 B); the check and the
 * answer: `herdr/dialogs/layer1/receipt.ts`. Without the claims port the route answers 404 like an unknown path.
 *
 * A separate file, and not a route on `admin.sock`: the socket does not check the peer, so a process that connects
 * has all the socket's routes. The admin socket is the owner's power (pairing code, revoke, release and the channel
 * switch), and the hook needs only registration. A process with access to this socket can at most block a card
 * with a foreign registration (409 `key-blocked`); it can neither approve nor release, because the server signs and
 * there are no routes for that here. A receipt needs the live hook's secret and only lets the hook give an `allow`
 * the server already signed.
 *
 * The socket is created after the port's `listen`, only in a channel mode that needs registration
 * (`consentRegistrationWanted`); start, permissions and replacing a dead socket as for the admin socket
 * (`unix-socket.ts`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import {
  CONSENT_CLAIM_BODY_MAX_BYTES, CONSENT_CLAIM_ROUTE, CONSENT_REGISTER_BODY_MAX_BYTES, CONSENT_REGISTER_ROUTE,
  CONSENT_SOCKET_FILENAME,
} from '../herdr/dialogs/layer1/contract.ts';
import type { ConsentClaims } from '../herdr/dialogs/layer1/receipt.ts';
import type { ConsentRegistry } from '../herdr/dialogs/layer1/registry.ts';
import { ADMIN_RUN_DIRNAME } from './admin.ts';
import { readJsonBody, sendJson, startUnixSocket } from './unix-socket.ts';
import type { UnixSocket } from './unix-socket.ts';

/**
 * Deadline for the whole registration body. The hook waits for the response for less (`CONSENT_REGISTER_DEADLINE_MS`);
 * the margin covers event loop delay, and a connection without a body does not hang longer.
 */
export const CONSENT_SOCKET_BODY_TIMEOUT_MS = 2_000;

export function consentSocketPath(dataDir: string): string {
  return path.join(dataDir, ADMIN_RUN_DIRNAME, CONSENT_SOCKET_FILENAME);
}

/** A running registration socket. */
export type ConsentSocket = UnixSocket;

/**
 * HTTP handler of the registration socket: `POST /register` → registry, `POST /claim` → `claims` (when given). Another
 * path = 404, another method = 405, a body over the cap = 413, bad JSON, the deadline or an address `URL` cannot
 * parse = 400. The `/register` response has the shape `{accepted, …}`, `/claim` `{confirmed, …}`. The handler is
 * synchronous: an exception before the body read promise would end the server process.
 */
export function createConsentHandler(
  registry: ConsentRegistry, claims?: Pick<ConsentClaims, 'claim'>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://consent').pathname;
    } catch {
      sendJson(res, 400, { accepted: false, error: 'bad-request' });
      return;
    }
    if (pathname === CONSENT_CLAIM_ROUTE && claims !== undefined) {
      handleClaim(req, res, claims);
      return;
    }
    if (pathname !== CONSENT_REGISTER_ROUTE) {
      sendJson(res, 404, { accepted: false, error: 'not-found' });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { accepted: false, error: 'method-not-allowed' });
      return;
    }
    void readJsonBody(req, {
      maxBytes: CONSENT_REGISTER_BODY_MAX_BYTES,
      timeoutMs: CONSENT_SOCKET_BODY_TIMEOUT_MS,
      refuse: (status) => { sendJson(res, status, { accepted: false, error: 'bad-request' }); },
    }).then((body) => {
      if (body === undefined) return;
      const outcome = registry.register(body);
      sendJson(res, outcome.status, outcome.body);
    }).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { accepted: false, error: 'internal' });
      else res.end();
    });
  };
}

/** `POST /claim`: the body goes to `claims`; every answer has the shape `{confirmed, …}`. */
function handleClaim(req: IncomingMessage, res: ServerResponse, claims: Pick<ConsentClaims, 'claim'>): void {
  if (req.method !== 'POST') {
    sendJson(res, 405, { confirmed: false, error: 'method-not-allowed' });
    return;
  }
  void readJsonBody(req, {
    maxBytes: CONSENT_CLAIM_BODY_MAX_BYTES,
    timeoutMs: CONSENT_SOCKET_BODY_TIMEOUT_MS,
    refuse: (status) => { sendJson(res, status, { confirmed: false, error: 'bad-request' }); },
  }).then(async (body) => {
    if (body === undefined) return;
    const outcome = await claims.claim(body);
    sendJson(res, outcome.status, outcome.body);
  }).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { confirmed: false, error: 'internal' });
    else res.end();
  });
}

/**
 * Creates the socket `<dataDir>/run/consent.sock`. `null` = no socket (a log line); the hook does not wait without
 * a socket. Never throws.
 */
export function startConsentSocket(
  dataDir: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  log: (line: string) => void,
): Promise<ConsentSocket | null> {
  return startUnixSocket({
    path: consentSocketPath(dataDir), handler, log, label: 'consent', name: 'registration socket',
    pathHint: ' (shorter data directory path)', requestTimeoutMs: 5_000,
  });
}
