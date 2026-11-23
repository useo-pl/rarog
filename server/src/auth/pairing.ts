/**
 * Pairing by code: codes in process memory, the record in `devices-store.ts`.
 *
 * A code (32 B base64url, valid 5 min, single-use) is issued by:
 * - the CLI on the Mac through the admin socket (`creator: 'admin'`): ONLY with zero active
 *   devices (the first device and recovery after `rarog devices revoke --all`);
 * - an already paired device (`POST /api/pairings`, `creator: <deviceId>`): consent to a new device
 *   is the code shown on the screen of a phone that is already paired.
 *
 * Memory holds the code's DIGEST (a map by `sha256`, so lookup does not compare codes character by character),
 * the creator and the expiry. One unredeemed code per creator: a new one invalidates the previous one. Revoking or
 * expiry of the creator invalidates its codes (`invalidateCreator`, a store listener in `index.ts`). Restart = codes
 * vanish. The creator can cancel its code at once: a device with `DELETE /api/pairings` (`invalidateCreator`),
 * `rarog pair` on a signal with `DELETE /api/admin/pairings/:id` ({@link Pairing.cancel}).
 *
 * **Redeeming is ONE synchronous step, without `await`** ({@link Pairing.redeem}): code expiry, creator
 * still active (an `admin` code: zero active), redeeming the code, the new device's record in the store state.
 * From that moment the new record counts as active, so a second `admin` code with an empty store does not
 * pass even while the write of the first is still running. The caller (`router.ts`) does the write and the rollback
 * on its error. Bad attempts do not burn pending codes: the body carries no pairing id, so an attempt
 * counter would be global, and 256 bits rule out guessing anyway (the throttle only slows down and logs).
 *
 * **Reviewer code** (demo review mode; {@link Pairing.redeemReview}): a fixed code from the configuration
 * (`RAROG_DEMO_REVIEW_CODE`), compared in constant time. It is not used up, does not expire, does not need zero
 * active devices and revokes nobody; it gives a record with creator `admin` and the current epoch. The active device
 * cap and adding the record are the same one synchronous step as {@link Pairing.redeem}. Cap refusals have a log
 * budget: one line per throttle window ({@link LOGIN_WINDOW_MS}), the rest counted and given in the next line.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PAIRING_CODE_RE } from '@rarog/shared/rest';
import { sanitizeBuild, sanitizeLabel } from '../text.ts';
import type { DeviceCreator, DeviceRecord, DeviceStore } from './devices-store.ts';
import { hashSecret, pushKeyId } from './devices-store.ts';
import { LOGIN_WINDOW_MS } from './limiter.ts';

/** Validity of a pairing code. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;

/**
 * How long the CLI may ask for the pairing state from the socket (`rarog pair` waits for the new device's first
 * request): the code expiry plus the time after which a record without requests expires as an orphan, with a margin.
 */
export const PAIRING_TRACK_MS = PAIRING_CODE_TTL_MS + 11 * 60_000;

/** Result of issuing a code: the code itself (once, for the QR and the link), its expiry and the public pairing id. */
export interface IssuedCode {
  /** Public handle for the CLI (`GET /api/admin/pairings/:id`): not a credential. */
  readonly pairingId: string;
  readonly code: string;
  readonly expiresAt: number;
}

/**
 * Successful redeem: the record already IS in the store's memory; the secret and push key leave once, in the response.
 */
export interface Redeemed {
  readonly ok: true;
  readonly record: DeviceRecord;
  readonly secret: string;
}

export type RedeemResult = Redeemed | { readonly ok: false };

/** Reviewer code from the configuration (`DemoReviewConfig` in `config.ts`): the value and the active device cap. */
export interface ReviewCode {
  readonly code: string;
  readonly maxDevices: number;
}

export type ReviewRedeemResult =
  | Redeemed
  /** Not the reviewer code: the caller goes the regular {@link Pairing.redeem} path. */
  | { readonly ok: false; readonly reason: 'not-review-code' }
  /** Active device cap; `logLine` only when the window's log budget lets it in. */
  | { readonly ok: false; readonly reason: 'device-limit'; readonly logLine?: string };

/**
 * Result of cancelling a code from the admin socket by its pairing id ({@link Pairing.cancel}): `cancelled` also for
 * a code that was already expired or replaced; `redeemed` also when the new record is gone (`lost`).
 */
export type PairingCancel = 'cancelled' | 'unknown' | 'redeemed';

/** Pairing state from the socket, for the CLI. */
export type PairingStatus =
  | { readonly state: 'pending'; readonly expiresAt: number }
  /** Code invalid without being used: expired, or a newer code from the socket overwrote it. */
  | { readonly state: 'expired' }
  /** Code used; `confirmed` = the new device has made an authenticated request. */
  | { readonly state: 'redeemed'; readonly deviceId: string; readonly label: string; readonly confirmed: boolean }
  /** Code used, but the record is gone (the orphan expired or the device was revoked). */
  | { readonly state: 'lost'; readonly deviceId: string };

export interface Pairing {
  /**
   * Issues a code to the creator (invalidates its previous one). Checking WHETHER it is allowed belongs to the caller.
   */
  issue(creator: DeviceCreator, nowMs?: number): IssuedCode;
  /** One synchronous redeem step: see the module header. */
  redeem(input: { code: string; label: string; build?: string | undefined }, nowMs?: number): RedeemResult;
  /**
   * Reviewer code, one synchronous step: constant-time comparison, active device cap, the record
   * in the store state. The code is not used up. The caller does the write and rollback, as with {@link redeem}.
   */
  redeemReview(
    input: { code: string; label: string; build?: string | undefined }, review: ReviewCode, nowMs?: number,
  ): ReviewRedeemResult;
  /**
   * Deletes the creator's unredeemed codes (revoke, "Forget server", expiry, `DELETE /api/pairings`). Returns how many
   * codes went.
   */
  invalidateCreator(creator: string): number;
  /**
   * Cancels the code of a pairing from the admin socket (`rarog pair` interrupted). Only the code of this pairing goes,
   * so cancelling a replaced one leaves the newer code alive; afterwards {@link status} says `expired`.
   */
  cancel(pairingId: string, nowMs?: number): PairingCancel;
  /** Pairing state for the CLI; `undefined` = the server does not know it (restart, too old, never existed). */
  status(pairingId: string, nowMs?: number): PairingStatus | undefined;
  /** Number of unredeemed, unexpired codes (tests). */
  pendingCount(nowMs?: number): number;
}

export interface PairingOptions {
  readonly store: DeviceStore;
  /** The current `RAROG_AUTH_EPOCH`: a new record carries it. */
  readonly epoch: string;
  readonly now?: () => number;
  /** Source of randomness (codes, identifiers, secrets); deterministic in golden response tests. */
  readonly random?: (bytes: number) => Buffer;
}

interface PendingCode {
  readonly pairingId: string;
  readonly creator: DeviceCreator;
  readonly expiresAt: number;
}

interface Tracked {
  readonly creator: DeviceCreator;
  readonly expiresAt: number;
  readonly until: number;
  deviceId?: string;
  label?: string;
}

/**
 * Code from the body equal to the reviewer code, in constant time: comparing `sha256` digests (always 32 bytes), so
 * neither the length nor the first differing character affects the response time.
 */
function sameCode(given: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(hashSecret(given), 'hex'), Buffer.from(hashSecret(expected), 'hex'));
}

export function createPairing(opts: PairingOptions): Pairing {
  const { store } = opts;
  const now = opts.now ?? ((): number => Date.now());
  const random = opts.random ?? ((bytes: number): Buffer => randomBytes(bytes));
  /** Code digest → pending code. */
  const pending = new Map<string, PendingCode>();
  /** Pairings from the socket the CLI asks about after issuing the code (`admin` only). */
  const tracked = new Map<string, Tracked>();

  const prune = (nowMs: number): void => {
    for (const [hash, entry] of pending) if (!(nowMs < entry.expiresAt)) pending.delete(hash);
    for (const [id, entry] of tracked) if (!(nowMs < entry.until)) tracked.delete(id);
  };

  const dropCreator = (creator: string): number => {
    let dropped = 0;
    for (const [hash, entry] of pending) {
      if (entry.creator !== creator) continue;
      pending.delete(hash);
      dropped += 1;
    }
    return dropped;
  };

  /** New record with a secret (draw order: id, secret, push key; the golden responses rely on it). */
  const newRecord = (
    input: { label: string; build?: string | undefined }, creator: DeviceCreator, nowMs: number,
  ): { record: DeviceRecord; secret: string } => {
    const id = random(16).toString('hex');
    const secret = random(32).toString('base64url');
    const pushKey = random(32).toString('base64url');
    const record: DeviceRecord = {
      id,
      secretHash: hashSecret(secret),
      pushKey,
      kid: pushKeyId(pushKey),
      label: sanitizeLabel(input.label),
      build: sanitizeBuild(input.build),
      createdAt: new Date(nowMs).toISOString(),
      lastSeenAt: null,
      epoch: opts.epoch,
      creator,
    };
    return { record, secret };
  };

  /** Log budget of reviewer code cap refusals: the moment of the last line and the refusals skipped since. */
  let reviewLineAt: number | null = null;
  let reviewSkipped = 0;
  const reviewRefusalLine = (active: number, maxDevices: number, nowMs: number): string | undefined => {
    if (reviewLineAt !== null && nowMs - reviewLineAt < LOGIN_WINDOW_MS) {
      reviewSkipped += 1;
      return undefined;
    }
    const skipped = reviewSkipped;
    reviewLineAt = nowMs;
    reviewSkipped = 0;
    return `devices: review code refused, ${String(active)} active devices (limit ${String(maxDevices)})`
      + (skipped > 0 ? `, ${String(skipped)} more since the last line` : '');
  };

  return {
    issue(creator, nowMs = now()) {
      prune(nowMs);
      dropCreator(creator);
      const code = random(32).toString('base64url');
      const pairingId = random(8).toString('hex');
      const expiresAt = nowMs + PAIRING_CODE_TTL_MS;
      pending.set(hashSecret(code), { pairingId, creator, expiresAt });
      if (creator === 'admin') tracked.set(pairingId, { creator, expiresAt, until: nowMs + PAIRING_TRACK_MS });
      return { pairingId, code, expiresAt };
    },

    redeem(input, nowMs = now()) {
      // From this line to `store.add` there is not a single `await`: see the module header.
      if (!PAIRING_CODE_RE.test(input.code)) return { ok: false };
      const hash = hashSecret(input.code);
      const entry = pending.get(hash);
      if (entry === undefined) return { ok: false };
      if (!(nowMs < entry.expiresAt)) {
        pending.delete(hash);
        return { ok: false };
      }
      const creatorActive = entry.creator === 'admin'
        ? store.active(nowMs).length === 0
        : store.get(entry.creator, nowMs) !== undefined;
      if (!creatorActive) {
        // A code that stopped being valid (creator revoked, the store already has a device) does not come back to life.
        pending.delete(hash);
        return { ok: false };
      }
      pending.delete(hash);
      const { record, secret } = newRecord(input, entry.creator, nowMs);
      store.add(record);
      const track = tracked.get(entry.pairingId);
      if (track !== undefined) {
        track.deviceId = record.id;
        track.label = record.label;
      }
      return { ok: true, record, secret };
    },

    redeemReview(input, review, nowMs = now()) {
      // From this line to `store.add` there is not a single `await`: see the module header.
      if (!sameCode(input.code, review.code)) return { ok: false, reason: 'not-review-code' };
      const active = store.active(nowMs).length;
      if (active >= review.maxDevices) {
        const logLine = reviewRefusalLine(active, review.maxDevices, nowMs);
        return logLine === undefined
          ? { ok: false, reason: 'device-limit' }
          : { ok: false, reason: 'device-limit', logLine };
      }
      const { record, secret } = newRecord(input, 'admin', nowMs);
      store.add(record);
      return { ok: true, record, secret };
    },

    invalidateCreator(creator) {
      return dropCreator(creator);
    },

    cancel(pairingId, nowMs = now()) {
      prune(nowMs);
      const track = tracked.get(pairingId);
      if (track === undefined) return 'unknown';
      if (track.deviceId !== undefined) return 'redeemed';
      for (const [hash, entry] of pending) if (entry.pairingId === pairingId) pending.delete(hash);
      return 'cancelled';
    },

    status(pairingId, nowMs = now()) {
      prune(nowMs);
      const track = tracked.get(pairingId);
      if (track === undefined) return undefined;
      if (track.deviceId === undefined) {
        // A code overwritten by a newer code of the same creator is as dead as an expired one.
        const live = [...pending.values()].some((entry) => entry.pairingId === pairingId);
        return live ? { state: 'pending', expiresAt: track.expiresAt } : { state: 'expired' };
      }
      const record = store.get(track.deviceId, nowMs);
      if (record === undefined) return { state: 'lost', deviceId: track.deviceId };
      return {
        state: 'redeemed', deviceId: record.id, label: record.label, confirmed: record.lastSeenAt !== null,
      };
    },

    pendingCount(nowMs = now()) {
      prune(nowMs);
      return pending.size;
    },
  };
}
