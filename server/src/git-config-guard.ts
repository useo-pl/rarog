/**
 * Filter drivers off for Rarog's git reads. From the key names git lists for a read's own config it finds every
 * `filter.<name>.*` driver, from any scope (repository, include, global, the server's `GIT_*` passthrough), and builds
 * the environment that empties each one. It starts no process: the runner in `git-status.ts` reads the names with its
 * own probe and refuses the read when this module cannot empty every driver.
 */
import { isUtf8 } from 'node:buffer';

/**
 * Cap of the names read. A longer listing is refused, not cut: a driver past the cap would stay on. Key names of a real
 * config take a few kilobytes; this leaves room for thousands of branches and remotes.
 */
export const CONFIG_NAMES_READ_CAP_BYTES = 1024 * 1024;

/** Encoding of the names read: one character per byte, so the listing turns back into the exact bytes git printed. */
export const CONFIG_NAMES_ENCODING = 'latin1' satisfies BufferEncoding;

/** `filter.` in the canonical key form git lists (section names in lower case). */
const FILTER_PREFIX = Buffer.from('filter.');

const DOT = 0x2e;

/**
 * Driver names from the output of `git config --null --name-only --list` (each key ends with NUL). The name is the
 * text between the first and the last dot of a `filter.<name>.<field>` key; an empty one (`[filter ""]`, attribute
 * `filter=`) is a name too, and `filter.<field>` without a name is no driver. `null` when a driver name is not valid
 * UTF-8: the environment cannot carry it byte for byte, so the driver could not be emptied.
 */
export function filterDriverNames(listing: Buffer): string[] | null {
  const names = new Set<string>();
  for (let start = 0; start < listing.length;) {
    const nul = listing.indexOf(0, start);
    const end = nul === -1 ? listing.length : nul;
    const key = listing.subarray(start, end);
    start = end + 1;
    if (!key.subarray(0, FILTER_PREFIX.length).equals(FILTER_PREFIX)) continue;
    const last = key.lastIndexOf(DOT);
    if (last < FILTER_PREFIX.length) continue;
    const name = key.subarray(FILTER_PREFIX.length, last);
    if (!isUtf8(name)) return null;
    names.add(name.toString('utf8'));
  }
  return [...names];
}

/** What each driver gets: no command, and `required=false`, because a required driver without one fails the read. */
const DRIVER_OFF: readonly (readonly [field: string, value: string])[] = [
  ['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false'],
];

/** A count of config pairs as git reads it without doubt: digits only, or nothing. */
const PLAIN_COUNT = /^\d*$/;

/**
 * `env` with every driver in `names` emptied through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`,
 * not `-c`: `-c` cuts at the first `=`, and a driver name may hold one. Pairs already in `env` (the server's `GIT_*`
 * passthrough) keep their place and these come after them, so they win. `null` when `env` holds a count that is not
 * plain digits (git reads `+2` as 2): the runner would not know where its own pairs start.
 */
export function withFilterDriversOff(env: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv | null {
  if (names.length === 0) return env;
  const count = env['GIT_CONFIG_COUNT'] ?? '';
  if (!PLAIN_COUNT.test(count)) return null;
  const out: NodeJS.ProcessEnv = { ...env };
  let index = count === '' ? 0 : Number(count);
  for (const name of names) {
    for (const [field, value] of DRIVER_OFF) {
      out[`GIT_CONFIG_KEY_${String(index)}`] = `filter.${name}.${field}`;
      out[`GIT_CONFIG_VALUE_${String(index)}`] = value;
      index += 1;
    }
  }
  out['GIT_CONFIG_COUNT'] = String(index);
  return out;
}
