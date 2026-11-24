/**
 * Admin socket: `<dataDir>/run/admin.sock`, the ONLY place of the `/api/admin/*` routes.
 *
 * Why a Unix socket, and not a route on the port or a file with a token in `dataDir`: an agent in the Claude Code
 * sandbox CAN READ `~/.local/share/rarog` and connects to `127.0.0.1:8930`, so a token in a file or a route on the
 * port would give it pairing, and with it approving its own dialogs and a terminal outside the sandbox. The sandbox
 * does not let connections to Unix sockets through by default (measured: `connect()` to `herdr.sock` → EPERM).
 * Writing `dataDir` is another matter: a session writes it unless the settings it loads
 * carry the write block rules of `rarog setup`, and a process outside the sandbox (a hook, a command Claude Code
 * does not see as a file write) writes it regardless. So the boundary is the file system: the `run/` directory
 * `0o700`, the socket `0o600`, owner = the server user. `X-Forwarded-For` is NOT a boundary: a local process simply
 * does not send it. The limit of the guarantee against a process running freely as the owner:
 * `docs/security-model.md`, "Pairing and device keys".
 *
 * Access to the socket is the OWNER'S POWER: a pairing code gives a lasting device, and with it approving dialogs.
 * The socket does not check the peer, so a process that can connect to it has all the routes below. The consent
 * channel hook needs only registration, so it has a separate socket `run/consent.sock` (`consent-socket.ts`)
 * without these routes.
 *
 * Start, permissions and replacing a dead socket: `unix-socket.ts`.
 *
 * Routes (no device key, no `Origin`: a browser cannot reach a Unix socket):
 * - `POST /api/admin/pairings`: an `admin` code with the address (`url`), the iroh server (`iroh`) and the link;
 *   REFUSED with 409 `device-active` when the server has an active device (a new one then pairs with a code from
 *   the app);
 * - `GET /api/admin/pairings/:id`: the pairing state `rarog pair` waits for;
 * - `DELETE /api/admin/pairings/:id`: `rarog pair` interrupted by a signal cancels its code: 204 for a pending
 *   or expired code (the state is `expired` afterwards), 404 {@link PAIRING_UNKNOWN_ERROR}, 409
 *   {@link PAIRING_REDEEMED_ERROR} once the code was used;
 * - `GET /api/admin/devices`: active devices and tombstones;
 * - `POST /api/admin/devices/revoke` `{id}` or `{all: true}`: revoke; `{id}` also revokes every active device
 *   paired through it, also when `id` itself is no longer active; the reply lists the device first (when it was
 *   active), then the descendants; an `id` already revoked with nothing active through it writes the store again
 *   and answers `{revoked: [], alreadyRevoked: true}` (the repeat after `persist-failed`);
 * - `GET /api/admin/iroh`: the iroh listener state without the key; a server without the listener:
 *   `{enabled: false, …}`;
 * - `POST /api/admin/dialogs/release` `{sessionId, key?}`: releases consent channel cards to the terminal; the
 *   control may refuse (503 {@link CONSENT_CHANNEL_CLOSED_ERROR}: the channel does not work in this effective mode);
 * - `POST /api/admin/dialogs/off`: consent channel mode `off` until the server restarts, without changing the
 *   configuration. Both channel routes return 503 `consent-unavailable` when the server has no channel control
 *   ({@link AdminDeps.consent}).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { buildPairingLink } from '@rarog/shared/pairing-link';
import type { ServerIroh } from '@rarog/shared/rest';
import { HOOK_CALL_KEY_PATTERN } from '../herdr/dialogs/hook/contract.ts';
import { CONSENT_ADMIN_OFF_ROUTE, CONSENT_ADMIN_RELEASE_ROUTE } from '../herdr/dialogs/layer1/contract.ts';
import type { ConsentAdminRelease } from '../herdr/dialogs/layer1/contract.ts';
import { sanitizeBuild, sanitizeLabel } from '../text.ts';
import type { DeviceRecord, DeviceStore, DeviceTombstone } from './devices-store.ts';
import type { Pairing } from './pairing.ts';
import { UNIX_SOCKET_PATH_MAX, readJsonBody, sendJson, startUnixSocket } from './unix-socket.ts';
import type { UnixSocket } from './unix-socket.ts';

/** Socket directory in `dataDir` (`0o700`). */
export const ADMIN_RUN_DIRNAME = 'run';
/** The socket (`0o600`). The guard `docs-zgodnosc.test.ts` derives the docs entry from it. */
export const ADMIN_SOCKET_FILENAME = 'admin.sock';
/** Length cap of the socket path (`unix-socket.ts`); `rarog service` checks it before installing. */
export const ADMIN_SOCKET_PATH_MAX = UNIX_SOCKET_PATH_MAX;
/** Code 409: the server already has an active device, a code from the socket is not available. */
export const DEVICE_ACTIVE_ERROR = 'device-active';
/** Code 404 of `/api/admin/pairings/:id`: the server does not know this pairing (restart, too old). */
export const PAIRING_UNKNOWN_ERROR = 'pairing-unknown';
/** Code 409 of `DELETE /api/admin/pairings/:id`: the code was already used, so there is nothing to cancel. */
export const PAIRING_REDEEMED_ERROR = 'pairing-redeemed';
/** Code 503 of the consent channel routes: the server has no channel control ({@link AdminDeps.consent}). */
export const CONSENT_UNAVAILABLE_ERROR = 'consent-unavailable';
/**
 * Code 503 of `dialogs/release`: the control refused because the consent channel is off (effective mode other than
 * channel).
 */
export const CONSENT_CHANNEL_CLOSED_ERROR = 'channel-closed';

const ADMIN_BODY_MAX_BYTES = 4096;
const ADMIN_BODY_TIMEOUT_MS = 10_000;

export function adminSocketPath(dataDir: string): string {
  return path.join(dataDir, ADMIN_RUN_DIRNAME, ADMIN_SOCKET_FILENAME);
}

/**
 * Pairing link: data in the FRAGMENT, so a link pasted into a browser does not send the code in a request. The
 * CLI `rarog pair` (`server/src/cli/devices.ts`) calls the same function, and the shared link contract
 * (`buildPairingLink`) builds it, so the scheme and the rules have one source. The `u=` field gives the address, the
 * `k=`/`r=` fields the iroh server; without both there is no link (`null`).
 */
export function pairingLink(publicUrl: string, iroh: ServerIroh | null, code: string): string;
export function pairingLink(publicUrl: string | null, iroh: ServerIroh | null, code: string): string | null;
export function pairingLink(publicUrl: string | null, iroh: ServerIroh | null, code: string): string | null {
  if (publicUrl === null && iroh === null) return null;
  return buildPairingLink({ server: publicUrl, iroh, code });
}

/**
 * Server address for the pairing link: the first `https://` origin from the allow-list (`RAROG_ORIGINS`), and
 * without one the first at all (demo on loopback). The origin is the server's base address: the app computes its
 * `Origin` exactly from this address.
 */
export function publicUrlOf(origins: readonly string[]): string | null {
  return origins.find((origin) => origin.startsWith('https://')) ?? origins[0] ?? null;
}

/**
 * Release refused: the consent channel does not work in this effective mode, so there are no channel cards to release.
 */
export interface ConsentReleaseRefused {
  readonly refused: typeof CONSENT_CHANNEL_CLOSED_ERROR;
}

/** Release result: keys of the released cards or a refusal. */
export type ConsentReleaseResult = readonly string[] | ConsentReleaseRefused;

/**
 * Consent channel control from the admin socket. Calls come with a body already checked for shape.
 */
export interface ConsentAdminControl {
  /**
   * Releases the channel cards of session `sessionId` to the terminal (all, or one by `key`); result = keys of the
   * released cards, an empty list when there was nothing to release, or the refusal {@link ConsentReleaseRefused}.
   * `sessionId` has only a checked length here: it serves to look up cards, never as a path.
   */
  release(request: ConsentAdminRelease): Promise<ConsentReleaseResult> | ConsentReleaseResult;
  /** Channel mode `off` until the server restarts; does not change the configuration. */
  off(): void;
}

export interface AdminDeps {
  readonly store: DeviceStore;
  readonly pairing: Pairing;
  /**
   * Address for the pairing link (`publicUrlOf`); `null` = none, the link then carries only the iroh server or does not
   * exist.
   */
  readonly publicUrl: string | null;
  /** iroh server for the response and the pairing link; absent or `null` = a server without the iroh listener. */
  readonly iroh?: ServerIroh | null;
  /**
   * iroh listener state for `GET /api/admin/iroh`, built by `index.ts` (listener snapshot and native module), without
   * the key. Absent = `{enabled: false}`.
   */
  readonly irohStatus?: () => Readonly<Record<string, unknown>>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /** Consent channel control; absent = the `dialogs/*` routes return 503 {@link CONSENT_UNAVAILABLE_ERROR}. */
  readonly consent?: ConsentAdminControl;
}

const sendError = (res: ServerResponse, status: number, error: string, message: string): void => {
  sendJson(res, status, { error, message });
};

/** JSON body up to {@link ADMIN_BODY_MAX_BYTES}; `undefined` = unacceptable body (the response has been sent). */
function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  return readJsonBody(req, {
    maxBytes: ADMIN_BODY_MAX_BYTES,
    timeoutMs: ADMIN_BODY_TIMEOUT_MS,
    refuse: (status) => { sendError(res, status, 'bad-request', 'Could not read the request.'); },
  });
}

/** Body of `dialogs/release`: the session and optionally the key of one card; an unknown field = 400. */
const consentReleaseSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  key: z.string().regex(HOOK_CALL_KEY_PATTERN).optional(),
});

/**
 * Record on the list for the CLI: without the secret digest and the push key. Label and build go through the pairing
 * rules again, so a record written under an older rule shows the same.
 */
function deviceRow(record: DeviceRecord): Record<string, unknown> {
  return {
    id: record.id, label: sanitizeLabel(record.label), createdAt: record.createdAt, lastSeenAt: record.lastSeenAt,
    creator: record.creator, build: sanitizeBuild(record.build),
  };
}

/** Tombstone on the list and in the revoke replies; the label goes through the pairing rules like {@link deviceRow}. */
function tombRow(tomb: DeviceTombstone): Record<string, unknown> {
  return {
    id: tomb.id, label: sanitizeLabel(tomb.label), createdAt: tomb.createdAt, revokedAt: tomb.revokedAt,
    revokedBy: tomb.revokedBy,
  };
}

/** HTTP handler of the admin socket. Port 8930 does NOT have these routes (the router returns 404). */
export function createAdminHandler(deps: AdminDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, pairing, log } = deps;
  const now = deps.now ?? ((): number => Date.now());

  /*
   * Ids revoked in memory whose write failed. The repeat after `persist-failed` must write even when the
   * store no longer knows the id: a large cascade can trim the device's own tombstone past the cap. Any successful
   * write saves the whole state, so it empties the set.
   */
  const unsavedRevocations = new Set<string>();

  const persistOr500 = async (res: ServerResponse, what: string, ids: readonly string[] = []): Promise<boolean> => {
    try {
      await store.persist();
      unsavedRevocations.clear();
      return true;
    } catch (err: unknown) {
      for (const id of ids) unsavedRevocations.add(id);
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
      log(`devices: write after ${what} failed (${typeof code === 'string' ? code : 'no code'})`);
      sendError(res, 500, 'persist-failed',
        `Writing devices.json failed; the ${what} holds until the server restarts. Check the disk and try again.`);
      return false;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://admin').pathname.replace(/\/+$/, '') || '/';
    const segments = pathname.split('/').filter((s) => s !== '');

    if (pathname === '/api/admin/pairings') {
      if (method !== 'POST') return sendError(res, 405, 'method-not-allowed', 'Method not allowed.');
      const nowMs = now();
      const active = store.active(nowMs);
      if (active.length > 0) {
        sendError(res, 409, DEVICE_ACTIVE_ERROR,
          'The server already has a paired device; pair new ones from the app: Settings → Pairing → Pair New Device.');
        return;
      }
      const issued = pairing.issue('admin', nowMs);
      log(`devices: pairing code from the admin socket (pairing ${issued.pairingId}, valid for 5 min)`);
      const iroh = deps.iroh ?? null;
      sendJson(res, 200, {
        pairingId: issued.pairingId,
        code: issued.code,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        url: deps.publicUrl,
        iroh,
        link: pairingLink(deps.publicUrl, iroh, issued.code),
      });
      return;
    }

    if (pathname === '/api/admin/iroh') {
      if (method !== 'GET') return sendError(res, 405, 'method-not-allowed', 'Method not allowed.');
      sendJson(res, 200, deps.irohStatus?.() ?? { enabled: false });
      return;
    }

    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'admin' && segments[2] === 'pairings') {
      if (method !== 'GET' && method !== 'DELETE') {
        return sendError(res, 405, 'method-not-allowed', 'Method not allowed.');
      }
      const pairingId = segments[3] ?? '';
      const unknown = (): void => {
        sendError(res, 404, PAIRING_UNKNOWN_ERROR,
          'The server does not know this pairing: it restarted or too much time passed. Run rarog pair again.');
      };
      if (method === 'DELETE') {
        const cancelled = pairing.cancel(pairingId, now());
        if (cancelled === 'unknown') return unknown();
        if (cancelled === 'redeemed') {
          sendError(res, 409, PAIRING_REDEEMED_ERROR,
            'The pairing code was already used and the device is paired; see rarog devices.');
          return;
        }
        log(`devices: pairing code from the admin socket cancelled (pairing ${pairingId})`);
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const status = pairing.status(pairingId, now());
      if (status === undefined) return unknown();
      sendJson(res, 200, status.state === 'pending'
        ? { state: status.state, expiresAt: new Date(status.expiresAt).toISOString() }
        : status);
      return;
    }

    if (pathname === '/api/admin/devices') {
      if (method !== 'GET') return sendError(res, 405, 'method-not-allowed', 'Method not allowed.');
      const active = store.active(now());
      sendJson(res, 200, {
        serverId: store.serverId,
        authStore: store.status,
        devices: active.map(deviceRow),
        revoked: store.tombstones().map(tombRow),
      });
      return;
    }

    if (pathname === '/api/admin/devices/revoke') {
      if (method !== 'POST') return sendError(res, 405, 'method-not-allowed', 'Method not allowed.');
      const body = await readJson(req, res);
      if (body === undefined) return;
      const input = (typeof body === 'object' && body !== null ? body : {}) as { id?: unknown; all?: unknown };
      if (input.all === true) {
        const tombs = store.revokeAll('admin', now());
        log(`devices: all revoked from the admin socket (${String(tombs.length)})`);
        if (!await persistOr500(res, 'revocation')) return;
        sendJson(res, 200, { revoked: tombs.map(tombRow) });
        return;
      }
      if (typeof input.id !== 'string' || input.id === '') {
        sendError(res, 400, 'bad-request', 'Give a device id (`id`) or `all: true`.');
        return;
      }
      const revoked = store.revokeWithDescendants(input.id, 'admin', now());
      if (revoked === undefined && (store.tombstone(input.id) !== undefined || unsavedRevocations.has(input.id))) {
        // Already revoked, nothing active through it: write anyway. After `persist-failed` the revocation lives
        // only in memory, and the runbook's "repeat the command" is what saves it before a restart.
        log(`devices: revoke from the admin socket for ${input.id}, already revoked; writing devices.json again`);
        if (!await persistOr500(res, 'revocation', [input.id])) return;
        sendJson(res, 200, { revoked: [], alreadyRevoked: true });
        return;
      }
      if (revoked === undefined) {
        sendError(res, 404, 'device-not-found', 'No active device has this id or was paired through it.');
        return;
      }
      const { device, descendants } = revoked;
      log(`devices: revoked from the admin socket ${input.id}${device === undefined ? ' (no longer active)' : ''}`
        + ` and ${String(descendants.length)} paired through it`);
      if (!await persistOr500(res, 'revocation', [input.id, ...descendants.map((tomb) => tomb.id)])) return;
      sendJson(res, 200, { revoked: [...(device === undefined ? [] : [device]), ...descendants].map(tombRow) });
      return;
    }

    if (pathname === CONSENT_ADMIN_RELEASE_ROUTE || pathname === CONSENT_ADMIN_OFF_ROUTE) {
      if (method !== 'POST') return sendError(res, 405, 'method-not-allowed', 'Method not allowed.');
      const consent = deps.consent;
      if (consent === undefined) {
        sendError(res, 503, CONSENT_UNAVAILABLE_ERROR,
          'The consent channel does not run in this server mode; there is nothing to release or turn off.');
        return;
      }
      if (pathname === CONSENT_ADMIN_OFF_ROUTE) {
        consent.off();
        log('consent: kill switch from the admin socket — channel off until the server restarts');
        sendJson(res, 200, { mode: 'off' });
        return;
      }
      const body = await readJson(req, res);
      if (body === undefined) return;
      const parsed = consentReleaseSchema.safeParse(body);
      if (!parsed.success) {
        sendError(res, 400, 'bad-request', 'Give a session (`sessionId`) and optionally a card key (`key`).');
        return;
      }
      const request: ConsentAdminRelease = parsed.data.key === undefined
        ? { sessionId: parsed.data.sessionId }
        : { sessionId: parsed.data.sessionId, key: parsed.data.key };
      const result = await consent.release(request);
      if ('refused' in result) {
        log('consent: release from the admin socket refused — the channel is closed');
        sendError(res, 503, CONSENT_CHANNEL_CLOSED_ERROR,
          'The consent channel is closed on this server, so no card waits on the phone; answer in the terminal.');
        return;
      }
      log(`consent: release from the admin socket — ${String(result.length)} cards`);
      sendJson(res, 200, { released: result });
      return;
    }

    sendError(res, 404, 'not-found', 'No such admin route.');
  };

  return (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'internal', 'Server error.');
      else res.end();
    });
  };
}

/** A running admin socket. */
export type AdminSocket = UnixSocket;

/**
 * Creates the socket `<dataDir>/run/admin.sock` with the admin route handler (`unix-socket.ts`).
 *
 * `null` = no socket (path too long, `run/` is not a directory, a live socket of another process, a `listen`
 * error): a log line, and the server keeps running without pairing from the CLI. Never throws.
 */
export function startAdminSocket(
  dataDir: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  log: (line: string) => void,
): Promise<AdminSocket | null> {
  return startUnixSocket({
    path: adminSocketPath(dataDir), handler, log, label: 'admin', name: 'admin socket',
    pathHint: ' (shorter RAROG_DATA_DIR)', requestTimeoutMs: 15_000,
  });
}
