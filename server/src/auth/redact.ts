/**
 * Wiping secrets from logs: shared by the whole server (router, terminal, herdr audit).
 *
 * A separate file, because the list of sensitive names covers every credential that can come in a request or stand
 * in the configuration (also the `Cookie` header, which the server does not read), and the users of this list have
 * nothing to do with authentication.
 */
import { DEVICE_AUTH_SCHEME } from './device.ts';

/** Replacing sensitive values in logs. */
export const REDACTED = '[ukryte]';

/**
 * Names of fields/headers whose values must never reach the log. Lowercase comparison, "contains" matching (e.g.
 * `x-auth-token`, `set-cookie`).
 */
export const SENSITIVE_KEY_PARTS: readonly string[] = [
  'token', 'cookie', 'authorization', 'auth', 'secret', 'password', 'passwd', 'apikey', 'api-key',
  // `api_key` is NOT caught by `apikey` or `api-key` (the underscore does not disappear after
  // lowercasing), and that is exactly the name of the key field in the Soniox response.
  // Without this entry one `redact(response)` would print the key to the log.
  'api_key',
  // Device push key (`devices.json`): it encrypts the banner content, so it is a secret of the same class
  // as the device secret (`secret` catches it by itself, `pushKey` does not).
  'pushkey',
];

/**
 * Value of the `Authorization: Rarog-Device <id>.<secret>` header anywhere in any text, under the scheme
 * the parser accepts (`DEVICE_AUTH_SCHEME`). Device secrets are not on the static `secrets` list (they are created
 * at pairing), so their shape catches them: after the scheme only `[ukryte]` remains, also when a library message
 * quotes the request header. A header under another scheme in an object is masked by the field name (`authorization`).
 */
const DEVICE_CREDENTIAL = new RegExp(`(${DEVICE_AUTH_SCHEME})\\s+[^\\s"',;]+`, 'gi');

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  const obj = value as object;
  if (seen.has(obj)) return '[cykl]';
  seen.add(obj);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(val, seen);
  }
  return out;
}

/**
 * Turns any value into a string safe to log.
 *
 * Three layers of defense:
 * 1. fields/headers with sensitive names (token, cookie, authorization, secret, pushKey…) → `[ukryte]`,
 * 2. a device credential after the `Rarog-Device <…>` scheme anywhere in the text → `[ukryte]`,
 * 3. literal occurrences of secrets from `secrets` (e.g. `config.sonioxApiKey`) → `[ukryte]`,
 *    which catches cases like `Error: bad token "hunter2"`.
 *
 * @param value any value (object, string, Error)
 * @param secrets secrets to wipe even when they appear inside text
 */
export function redact(value: unknown, secrets: readonly string[] = []): string {
  const raw = typeof value === 'string'
    ? value
    : (JSON.stringify(redactValue(value, new WeakSet<object>())) ?? String(value));
  let out = raw.replace(DEVICE_CREDENTIAL, `$1 ${REDACTED}`);
  for (const secret of secrets) {
    // Very short secrets skipped: wiping them would eat ordinary text.
    if (secret.length < 3) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}
