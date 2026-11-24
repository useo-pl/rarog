/**
 * Device identity routes: pairing with a code (`/api/pair`, public: the code is the credential), a code for a new
 * device and its cancellation (`/api/pairings`), the device list, the calling device and "Forget server"
 * (`/api/devices*`), the retired token login (`/api/login`) and the demo pairing code for UI tests (called by the
 * router before the credential).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  DEMO_REVIEW_FULL_ERROR, DEVICE_REQUIRED_ERROR, DEVICE_UNKNOWN_ERROR, PAIR_PROTOCOL_VERSION, PAIR_UNKNOWN_ERROR,
  PAIR_VERSION_ERROR, pairBodySchema,
} from '@rarog/shared/rest';
import type { DeviceInfo, DeviceList, DeviceMe, PairResponse, PairingIssued } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import { devicesFileName } from '../auth/devices-store.ts';
import { type DeviceRecord, loginPeer, pairingLink, publicUrlOf, redact } from '../auth/index.ts';
import { isIrohSocket, markAuthenticated, noteIrohRefusal } from '../iroh/socket.ts';
import {
  type DeviceIdentity, methodNotAllowed, parseBody, readJsonBody, readValidatedBody, sendError, sendJson,
  sendNoContent,
} from '../router.ts';
import { sanitizeBuild, sanitizeLabel } from '../text.ts';
import { serverCapabilities } from '../version.ts';
import type { RouteContext, RouteRequest } from './context.ts';

/** Pusty obiekt — ciało `POST /api/pairings` (kod wydaje serwer, klient niczego nie podaje). */
const emptyBodySchema = z.strictObject({});

/**
 * Rekord urządzenia → wiersz listy dla apki: bez skrótu sekretu i klucza push. Label and build go through the
 * pairing rules again, so a record written under an older rule shows the same.
 */
function deviceInfo(record: DeviceRecord, current: string | undefined): DeviceInfo {
  return {
    id: record.id, label: sanitizeLabel(record.label), createdAt: record.createdAt, lastSeenAt: record.lastSeenAt,
    creator: record.creator, build: sanitizeBuild(record.build), current: record.id === current,
  };
}

/*
 * POST /api/pair {v, code, label, build?, pushFormats?} — parowanie kodem.
 *
 * Po odczycie ciała JEDEN synchroniczny krok `pairing.redeem` (termin, twórca aktywny, zużycie kodu,
 * rekord w pamięci), potem trwały zapis i dopiero wtedy JEDNA odpowiedź z sekretem. Błąd zapisu cofa
 * rekord i daje 500: kod jest już spalony, `rarog pair` albo telefon wydaje nowy. Zły, zużyty
 * i przeterminowany kod to jedno 404 `pair-unknown`; nieznane `v` — 400 `pair-version`.
 *
 * Tryb recenzji demo (`config.demoReview`): najpierw kod recenzenta (`pairing.redeemReview`, ten sam jeden krok
 * synchroniczny). Pełny sufit to 429 `demo-review-full` bez `Retry-After` i bez porażki w dławiku; udane
 * parowanie dławika nie zeruje, bo kod recenzenta zna więcej niż jedna osoba. Inny kod idzie drogą `redeem`.
 */
async function handlePair(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, identity: DeviceIdentity,
): Promise<void> {
  const { deps, config, loginLimiter, log, secrets } = ctx;
  const raw = await readJsonBody(req, res, config.maxBodyBytes);
  if (raw === null) return;
  const version = (raw.value as { v?: unknown } | null)?.v;
  if (typeof version === 'number' && version !== PAIR_PROTOCOL_VERSION) {
    sendError(res, 400, PAIR_VERSION_ERROR, say('rest.pair-version-unknown'));
    return;
  }
  const body = parseBody(res, pairBodySchema, raw.value);
  if (body === null) return;
  const clock = identity.now ?? Date.now;
  const input = { code: body.code, label: body.label, build: body.build };
  const review = config.demoReview === null ? null : identity.pairing.redeemReview(input, config.demoReview, clock());
  if (review !== null && !review.ok && review.reason === 'device-limit') {
    if (review.logLine !== undefined) log.info(review.logLine);
    sendError(res, 429, DEMO_REVIEW_FULL_ERROR, say('demo.review-device-limit'));
    return;
  }
  const result = review !== null && review.ok ? review : identity.pairing.redeem(input, clock());
  if (!result.ok) {
    const outcome = loginLimiter.fail(loginPeer(req), Date.now(), 'pairing');
    if (outcome.logLine !== undefined) log.info(outcome.logLine);
    if (outcome.limited) {
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
      sendError(res, 429, 'too-many-requests', say('rest.pair-rate-limited'));
      return;
    }
    sendError(res, 404, PAIR_UNKNOWN_ERROR, say('rest.pair-code-invalid'));
    return;
  }
  const { record, secret } = result;
  try {
    await identity.store.persist();
  } catch (err: unknown) {
    identity.store.discard(record.id);
    log.error(`devices: failed to save the pairing, record rolled back (${redact(err, secrets)})`);
    sendError(res, 500, 'internal', say('rest.pair-save-failed'));
    return;
  }
  const byReview = result === review;
  if (!byReview) loginLimiter.succeed();
  // Połączenie iroh, którym przyszło parowanie, dostaje nowe urządzenie od razu: limity jak po kluczu. Tylko
  // aktywne: odpięcie w trakcie `persist()` minęło już połączenie, a dopisane po nim zostałoby tam.
  if (identity.store.get(record.id, clock()) !== undefined) markAuthenticated(req.socket, record.id);
  const source = byReview
    ? 'review code'
    : `code from ${record.creator === 'admin' ? 'the admin socket' : record.creator}`;
  log.info(`devices: paired ${record.id} (${source})`);
  const onPaired = identity.onPaired;
  if (onPaired !== undefined) res.once('finish', () => { onPaired(record); });
  const response: PairResponse = {
    deviceId: record.id,
    secret,
    pushKey: record.pushKey,
    kid: record.kid,
    server: {
      id: identity.store.serverId,
      name: identity.serverName,
      version: config.version,
      capabilities: serverCapabilities({ inbox: deps.inbox !== undefined, files: config.filesEnabled }),
      // Serwer iroh — ten sam co w `/api/version`; serwer bez nasłuchu iroh pisze `null`.
      iroh: deps.iroh ?? null,
    },
  };
  sendJson(res, 200, response);
}

/** {@link DEMO_PAIRING_PATH}: odpięcie wszystkich urządzeń demo i kod „z Maca” z linkiem pod adres demo. */
export async function handleDemoPairing(
  ctx: RouteContext, res: ServerResponse, identity: DeviceIdentity,
): Promise<void> {
  const { deps, config, log, secrets } = ctx;
  const clock = identity.now ?? Date.now;
  identity.store.revokeAll('admin', clock());
  try {
    await identity.store.persist();
  } catch (err: unknown) {
    log.error(`demo: failed to save ${devicesFileName(config)} after unpairing (${redact(err, secrets)})`);
  }
  const issued = identity.pairing.issue('admin', clock());
  const url = publicUrlOf(config.originAllowList);
  log.info('demo: pairing code for UI tests (demo devices unpaired)');
  sendJson(res, 200, {
    code: issued.code,
    expiresAt: new Date(issued.expiresAt).toISOString(),
    link: pairingLink(url, deps.iroh ?? null, issued.code),
  });
}

export async function routeDevices(
  ctx: RouteContext, req: IncomingMessage, res: ServerResponse, rq: RouteRequest,
): Promise<boolean> {
  const { method, pathname, principal } = rq;
  const { deps, config, log, secrets } = ctx;

  /*
   * Tożsamość urządzeń. `POST /api/pair` jest publiczne (kod jest poświadczeniem); reszta wymaga
   * KLUCZA urządzenia, jak każda trasa za bramką: kod dla nowego urządzenia wydaje sparowane urządzenie,
   * a listę urządzeń i „Zapomnij serwer” ma tylko klient z rekordem. 403 `device-required` niżej to
   * zabezpieczenie typu: za bramką klient jest zawsze urządzeniem. Trasy `/api/admin/*` na tym porcie
   * NIE istnieją (gniazdo Unix, `auth/admin.ts`) — oddaje je 404 niżej.
   */
  if (pathname === '/api/pair' || pathname === '/api/pairings' || pathname.startsWith('/api/devices')) {
    const identity = deps.devices;
    const known = pathname === '/api/pair' || pathname === '/api/pairings'
      || pathname === '/api/devices' || pathname === '/api/devices/me' || pathname === '/api/devices/forget';
    if (identity === undefined || !known) {
      sendError(res, 404, 'not-found', say('rest.endpoint-not-found'));
      return true;
    }
    if (pathname === '/api/pair') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      await handlePair(ctx, req, res, identity);
      return true;
    }
    if (pathname === '/api/pairings') {
      if (method !== 'POST' && method !== 'DELETE') return methodNotAllowed(res, 'POST, DELETE');
    } else {
      const expected = pathname === '/api/devices/forget' ? 'POST' : 'GET';
      if (method !== expected) return methodNotAllowed(res, expected);
    }
    if (principal === undefined) {
      sendError(res, 403, DEVICE_REQUIRED_ERROR, say('rest.device-required'));
      return true;
    }
    const clock = identity.now ?? Date.now;
    const self = principal.deviceId;
    /*
     * DELETE /api/pairings — the device cancels its own unused code at once (the app closes the code screen).
     * 204 also when there was none; codes of other creators stay. No body (or `{}`, as `POST`), anything else is 400;
     * reading it checks the key again, as on every route with a body.
     */
    if (pathname === '/api/pairings' && method === 'DELETE') {
      const body = await readValidatedBody(req, res, config, emptyBodySchema);
      if (body === null) return true;
      if (identity.pairing.invalidateCreator(self) > 0) log.info(`devices: device ${self} cancelled its pairing code`);
      sendNoContent(res);
      return true;
    }
    if (pathname === '/api/pairings') {
      const body = await readValidatedBody(req, res, config, emptyBodySchema);
      if (body === null) return true;
      // Twórca musi być aktywny w chwili wydania — po odczycie ciała, nie tylko na bramce.
      if (identity.store.get(self, clock()) === undefined) {
        sendError(res, 401, DEVICE_UNKNOWN_ERROR, say('rest.device-unknown'));
        return true;
      }
      const issued = identity.pairing.issue(self, clock());
      log.info(`devices: pairing code from device ${self} (valid for 5 min)`);
      const response: PairingIssued = { code: issued.code, expiresAt: new Date(issued.expiresAt).toISOString() };
      sendJson(res, 200, response);
      return true;
    }
    if (pathname === '/api/devices') {
      const response: DeviceList = {
        devices: identity.store.active(clock()).map((record) => deviceInfo(record, self)),
      };
      sendJson(res, 200, response);
      return true;
    }
    if (pathname === '/api/devices/me') {
      const record = identity.store.get(self, clock());
      if (record === undefined) {
        sendError(res, 401, DEVICE_UNKNOWN_ERROR, say('rest.device-unknown'));
        return true;
      }
      const response: DeviceMe = { device: deviceInfo(record, self), serverId: identity.store.serverId };
      sendJson(res, 200, response);
      return true;
    }
    // POST /api/devices/forget — „Zapomnij serwer” z apki: własny rekord, best-effort.
    const body = await readValidatedBody(req, res, config, emptyBodySchema);
    if (body === null) return true;
    if (identity.store.revoke(self, 'forget', clock()) !== undefined) {
      log.info(`devices: ${self} forgot the server (unpaired)`);
      try {
        await identity.store.persist();
      } catch (err: unknown) {
        log.error(`devices: failed to save after "Forget server" — unpaired until restart (${redact(err, secrets)})`);
      }
    }
    sendNoContent(res);
    return true;
  }

  /*
   * `POST /api/login`: logowania tokenem serwer nie ma, więc stałe 410 `login-retired` bez czytania ciała,
   * bez dławika i bez `Set-Cookie`. Na gnieździe iroh trasy nie ma wcale: odpowiedź jak dla trasy nieznanej.
   */
  if (pathname === '/api/login') {
    if (isIrohSocket(req.socket)) {
      noteIrohRefusal(req.socket, 'login', `${method} ${pathname}`);
      sendError(res, 404, 'not-found', say('rest.endpoint-not-found'));
      return true;
    }
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    sendError(res, 410, 'login-retired', say('rest.login-retired'));
    return true;
  }

  return false;
}
