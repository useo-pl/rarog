/**
 * What the relay lets through to APNs: allow-list of headers and payload.
 *
 * Why: a pass says "you may send to this token", but not "you may send anything". Without this gate a process
 * with a pass (or with the token alone, as long as `/v1/pass` issues one to anyone who knows the token) could send
 * any plain banner signed with the USEO key to the device. So the `aps.alert` text is FIXED (placeholder text,
 * chime): the server sends only encrypted banners, with the content in the ciphertext of the `rarog` block outside
 * `aps`.
 *
 * The payload goes to Apple BYTE FOR BYTE, so it must be canonical JSON (`JSON.stringify(JSON.parse(p)) === p`):
 * with a duplicated key `JSON.parse` takes the last occurrence, and Apple's parser could take the first one;
 * the `payload-canonical` rule closes that gap. The Rarog server builds payloads with `JSON.stringify`, so it complies.
 *
 * The result is the name of the violated rule (`payload-rejected {rule}` in `/v1/push`) or `null`.
 */
import {
  ALERT_PLACEHOLDER, ALERT_PLACEHOLDER_KEYS, APS_KEYS, LIVE_ACTIVITY_CHIME, LIVE_ACTIVITY_CHIME_KEYS, TOP_LEVEL_KEYS,
} from './alert-policy.ts';
import { utf8Length } from './bytes.ts';
import { apnsTopicFor } from './identity.ts';
import type { PushType } from './identity.ts';

/** APNs payload cap (UTF-8 bytes of the whole JSON). */
export const APNS_PAYLOAD_MAX_BYTES = 4096;

export const POLICY_RULES = [
  'headers', 'push-type', 'topic', 'payload-size', 'payload-json', 'payload-canonical', 'top-level', 'aps-key',
  'aps-value', 'alert',
] as const;
export type PolicyRule = typeof POLICY_RULES[number];

/** APNs headers the caller may set. The relay sets `authorization` and `content-type`. */
export const ALLOWED_HEADERS = [
  'apns-push-type', 'apns-topic', 'apns-priority', 'apns-collapse-id', 'apns-expiration',
] as const;

const PRIORITIES: Readonly<Record<PushType, readonly string[]>> = {
  alert: ['1', '5', '10'],
  liveactivity: ['5', '10'],
};
/** `apns-collapse-id`: Apple allows up to 64 bytes; here printable ASCII. */
const COLLAPSE_ID_RE = /^[\x21-\x7e][\x20-\x7e]{0,63}$/;
const EXPIRATION_RE = /^(0|[1-9][0-9]{0,11})$/;
/** `aps.sound`: `default` or a file name in the app package. A dictionary (critical sound) is rejected. */
const SOUND_RE = /^[A-Za-z0-9._-]{1,64}$/;
const THREAD_ID_MAX_BYTES = 256;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The object has EXACTLY these keys and these values (flat or one level deeper). */
function equalsExactly(value: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== Object.keys(expected).length) return false;
  return keys.every((key) => {
    if (!Object.hasOwn(expected, key)) return false;
    const want = expected[key];
    return isObject(want) ? equalsExactly(value[key], want) : value[key] === want;
  });
}

const onlyKeys = (value: Json, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

export function checkHeaders(headers: Readonly<Record<string, string>>, type: PushType): PolicyRule | null {
  if (!onlyKeys(headers, ALLOWED_HEADERS)) return 'headers';
  if (headers['apns-push-type'] !== type) return 'push-type';
  if (headers['apns-topic'] !== apnsTopicFor(type)) return 'topic';
  const priority = headers['apns-priority'];
  if (priority !== undefined && !PRIORITIES[type].includes(priority)) return 'headers';
  const collapseId = headers['apns-collapse-id'];
  if (collapseId !== undefined && !COLLAPSE_ID_RE.test(collapseId)) return 'headers';
  const expiration = headers['apns-expiration'];
  if (expiration !== undefined && !EXPIRATION_RE.test(expiration)) return 'headers';
  return null;
}

/** v2 placeholder text (literal or keys) with `mutable-content: 1`: the only banner alert. */
function isPlaceholderAlert(aps: Json): boolean {
  const alert = aps['alert'];
  return aps['mutable-content'] === 1
    && (equalsExactly(alert, ALERT_PLACEHOLDER) || equalsExactly(alert, ALERT_PLACEHOLDER_KEYS));
}

function checkAlertAps(aps: Json): PolicyRule | null {
  if (aps['badge'] !== undefined && !isCount(aps['badge'])) return 'aps-value';
  const sound = aps['sound'];
  if (sound !== undefined && (typeof sound !== 'string' || !SOUND_RE.test(sound))) return 'aps-value';
  const thread = aps['thread-id'];
  if (thread !== undefined
    && (typeof thread !== 'string' || thread === '' || utf8Length(thread) > THREAD_ID_MAX_BYTES)) return 'aps-value';
  if (aps['mutable-content'] !== undefined && aps['mutable-content'] !== 1) return 'aps-value';
  if (aps['alert'] === undefined) return null;
  return isPlaceholderAlert(aps) ? null : 'alert';
}

/**
 * Live Activity chime: the `LIVE_ACTIVITY_CHIME` literal or its keys in the Live Activity form; the sound is always the
 * same.
 */
function isChimeAlert(alert: unknown): boolean {
  return equalsExactly(alert, LIVE_ACTIVITY_CHIME) || equalsExactly(alert, {
    title: { 'loc-key': LIVE_ACTIVITY_CHIME_KEYS.title },
    body: { 'loc-key': LIVE_ACTIVITY_CHIME_KEYS.body },
    sound: LIVE_ACTIVITY_CHIME.sound,
  });
}

function checkLiveActivityAps(aps: Json): PolicyRule | null {
  const event = aps['event'];
  if (event !== 'update' && event !== 'end') return 'aps-value';
  if (!isCount(aps['timestamp']) || !isObject(aps['content-state'])) return 'aps-value';
  for (const key of ['stale-date', 'dismissal-date']) {
    if (aps[key] !== undefined && !isCount(aps[key])) return 'aps-value';
  }
  if (aps['alert'] === undefined) return null;
  // Sound rides only with `update` (as in the server: the type rejects `end` with an alert).
  return event === 'update' && isChimeAlert(aps['alert']) ? null : 'alert';
}

/** Top-level keys: a closed set per type (banner: `aps` and the `rarog` block, Live Activity: `aps` only). */
function topLevelOk(parsed: Json, type: PushType): boolean {
  return onlyKeys(parsed, TOP_LEVEL_KEYS[type]);
}

/** A `/v1/push` payload (JSON string) against the `v2` policy. */
export function checkPayload(payload: string, type: PushType): PolicyRule | null {
  if (utf8Length(payload) > APNS_PAYLOAD_MAX_BYTES) return 'payload-size';
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return 'payload-json';
  }
  if (!isObject(parsed)) return 'payload-json';
  if (JSON.stringify(parsed) !== payload) return 'payload-canonical';
  const aps = parsed['aps'];
  if (!topLevelOk(parsed, type) || !isObject(aps)) return 'top-level';
  if (!onlyKeys(aps, APS_KEYS[type])) return 'aps-key';
  return type === 'alert' ? checkAlertAps(aps) : checkLiveActivityAps(aps);
}
