/**
 * Relay rate-limit keys: the ONLY place that builds them. The core (`core.ts`) gives the
 * counters only the result of a function from here ({@link clientBucket}, {@link pushKey}, {@link parentKey}), never
 * a raw header or a token digest; the guard `test/klucz-limitu-guard.test.ts` enforces this. The prefixes `a:` and
 * `la:` do not collide with an address key: IPv4 has no colon, and an IPv6 key has only hex digits before `::/64`.
 *
 * The adapter picks the address (`worker.ts`: `CF-Connecting-IP`, and behind a Pseudo IPv4 address
 * `CF-Connecting-IPv6`):
 * - IPv4 unchanged;
 * - IPv6 cut to /64 in one form (`::` expanded, four hex digits per group, lowercase): one link gets at least a /64
 *   from its provider, so the full address would give as many keys as there are addresses in the pool;
 * - IPv4 written as IPv6 (`::ffff:a.b.c.d`) → IPv4, the same key as without the IPv6 notation;
 * - no address, or a string that cannot be parsed → the shared bucket {@link UNKNOWN_BUCKET} (it does not hand out
 *   a separate counter to every piece of garbage).
 */

import type { PassClaims } from './pass.ts';

/** Bucket for an address that is missing or cannot be parsed. */
export const UNKNOWN_BUCKET = 'unknown';

/** The longest textual IPv6 address is 45 characters; a longer string is not an address. */
const ADDRESS_MAX_CHARS = 64;
const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4_RE = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);
const GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

/** Hex groups of one side of `::` (empty side = zero groups); `null` on a bad group. */
function groupsOf(part: string): number[] | null {
  if (part === '') return [];
  const groups: number[] = [];
  for (const group of part.split(':')) {
    if (!GROUP_RE.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

/**
 * Eight 16-bit groups of an IPv6 address, or `null`. A dotted quad is allowed only at the end (the last two groups).
 */
function ipv6Groups(text: string): number[] | null {
  let hex = text;
  const tail = text.slice(text.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    if (!IPV4_RE.test(tail)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    hex = `${text.slice(0, text.length - tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = hex.split('::');
  if (halves.length > 2) return null;
  const head = groupsOf(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = groupsOf(halves[1] ?? '');
  if (rest === null || head.length + rest.length > 7) return null;
  return [...head, ...Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

/** Rate-limit key per client address (`/v1/pass`, and with format `v2` also `/v1/push` per address). */
export function clientBucket(address: string | null): string {
  if (address === null || address === '' || address.length > ADDRESS_MAX_CHARS) return UNKNOWN_BUCKET;
  if (IPV4_RE.test(address)) return address;
  if (!address.includes(':')) return UNKNOWN_BUCKET;
  const groups = ipv6Groups(address);
  if (groups === null) return UNKNOWN_BUCKET;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16).padStart(4, '0')).join(':')}::/64`;
}

/**
 * `RL_PUSH` key: a banner per device token digest (`a:`), a Live Activity per PARENT device digest (`la:`),
 * so many activity tokens of one device share one budget instead of multiplying it.
 */
export const pushKey = (claims: PassClaims): string =>
  (claims.type === 'alert' ? `a:${claims.tokenHash}` : `la:${claims.parentHash}`);

/** `RL_PASS` key for issuing Live Activity passes per parent device; `parentHash` = token digest from `devicePass`. */
export const parentKey = (parentHash: string): string => `la:${parentHash}`;
