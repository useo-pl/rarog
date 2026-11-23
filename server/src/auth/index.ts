/**
 * Server authentication: the only entry for the rest of the code (`import … from '…/auth/index.ts'`).
 *
 * - `principal.ts`: `authenticate(req, devices) → AuthResult`, one boundary for the router,
 *   SSE and the terminal WebSocket: the device key, the only credential;
 * - `device.ts`: the `Authorization: Rarog-Device <id>.<secret>` header and its check;
 * - `devices-store.ts`: `devices.json`: records, tombstones, `serverId`, expiry;
 * - `pairing.ts`: pairing codes in memory and redeeming them in one synchronous step;
 * - `admin.ts`: the Unix socket `<dataDir>/run/admin.sock` with the `/api/admin/*` routes (the owner's power);
 * - `consent-socket.ts`: the consent channel registration socket `<dataDir>/run/consent.sock`, routes `/register`
 *   and `/claim`;
 * - `unix-socket.ts`: shared start of both sockets (permissions, dead socket, another process's live one), JSON body
 *   within limits;
 * - `limiter.ts`: throttle of failed attempts (pairing, unknown key) and the source for the log;
 * - `origin.ts`: the `Origin` rule for mutations and upgrades, separately for the TCP socket and the iroh socket;
 * - `redact.ts`: wiping secrets from logs.
 */
export * from './admin.ts';
export * from './consent-socket.ts';
export * from './device.ts';
export * from './devices-store.ts';
export * from './limiter.ts';
export * from './origin.ts';
export * from './pairing.ts';
export * from './principal.ts';
export * from './redact.ts';
