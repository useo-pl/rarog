/**
 * The channel rules of `rarog update`: the shapes of a release and a beta version, which version `rarog update --beta`
 * targets from the npm dist-tags (the higher of `beta` and `latest`), and whether npm's `min-release-age-exclude`
 * lets this package past the release age gate. Pure functions over what npm prints; the npm calls stay in
 * `update-registry.ts`.
 */

const STABLE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const BETA = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-beta\.(?:0|[1-9]\d*)$/u;

/** A release: `X.Y.Z`, numbers without leading zeros. */
export function isStableVersion(value: unknown): value is string {
  return typeof value === 'string' && STABLE.test(value);
}

/** A beta: a release followed by `-beta.N`, `N` without leading zeros, and nothing after it. */
export function isBetaVersion(value: unknown): value is string {
  return typeof value === 'string' && BETA.test(value);
}

/** A version with a pre-release part (`1.1.0-beta.2`, `1.1.0-rc.0`): `X.Y.Z` followed by `-`. */
export function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/u.test(version);
}

/** What `rarog update --beta` installs, from the dist-tags of the package. */
export interface ChannelTarget {
  readonly latest: string;
  /** The `beta` tag when it names a beta; `null` = no such tag or another shape (see {@link note}). */
  readonly beta: string | null;
  /** The higher of {@link beta} and {@link latest}. */
  readonly target: string;
  /** Why the target is `latest` without a word from `beta`: no tag, or a tag that is not a beta. */
  readonly note: 'npm has no beta tag' | 'npm\'s beta tag is not a beta version' | null;
}

/** `X.Y.Z` and `X.Y.Z-beta.N` in semver order (a beta below its release). */
function order(a: string, b: string): number {
  const parts = (version: string): number[] => {
    const [core = '', beta] = version.split('-beta.');
    return [...core.split('.').map(Number), beta === undefined ? Number.POSITIVE_INFINITY : Number(beta)];
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 4; i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The target of `rarog update --beta` from the value of `npm view @rarog/server dist-tags --json`: `latest` must be a
 * release, and the `beta` tag counts when it names a beta, because nobody moves it after a release and a release above
 * it is the newer code. `null` = another shape or no release under `latest`.
 */
export function channelTarget(tags: unknown): ChannelTarget | null {
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) return null;
  const { latest, beta } = tags as Record<string, unknown>;
  if (!isStableVersion(latest)) return null;
  if (!isBetaVersion(beta)) {
    return { latest, beta: null, target: latest, note: beta === undefined ? 'npm has no beta tag'
      : 'npm\'s beta tag is not a beta version' };
  }
  return { latest, beta, target: order(beta, latest) > 0 ? beta : latest, note: null };
}

/**
 * A pattern of `min-release-age-exclude` as npm matches it against a package name (a name, or a glob in which `*` and
 * `?` stay inside one path segment and `**` crosses them, also zero of them; a leading `!` or `#` is a plain
 * character). A pattern with a character class or braces counts as a match: this module does not evaluate those, and
 * a wrong "no" would print an admission date for a package npm does not hold back.
 */
function globMatches(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (/[[\]{}]/u.test(pattern)) return true;
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? '';
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$.|+()[\]{}]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u').test(name);
}

/**
 * Whether `npm config get … min-release-age-exclude …` (`key=value` lines; npm prints the list joined with commas)
 * names `name`: npm then installs it however young, so a release age gate stop is a dependency's.
 */
export function gateExcludes(stdout: string, name: string): boolean {
  const line = stdout.split('\n').map((text) => text.trim())
    .find((text) => text.startsWith('min-release-age-exclude='));
  if (line === undefined) return false;
  return line.slice('min-release-age-exclude='.length).split(',').map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '' && pattern !== 'null').some((pattern) => globMatches(pattern, name));
}
