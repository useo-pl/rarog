/**
 * Native client compatibility: the minimum app build the server announces in `hello` and the package default
 * for it. The consent channel (`main`, `all`) needs a threshold (`herdr/dialogs/layer1/mode.ts`).
 */
import { ConfigError, MIN_CLIENT_BUILD_ENV } from '../config-env.ts';
import { INSTALL_MODE } from '../install/mode.ts';
import type { InstallMode } from '../install/mode.ts';

// ---------------------------------------------------------------------------
// Native client compatibility
// ---------------------------------------------------------------------------

/**
 * Minimum app build a package install uses when `RAROG_MIN_CLIENT_BUILD` is unset or empty: the app build released
 * together with this server. It rises only when a server needs a newer app. This is the only place that holds it.
 */
export const DEFAULT_MIN_CLIENT_BUILD = 5614;

/** Where the threshold comes from: the explicit `RAROG_MIN_CLIENT_BUILD` or the package default. */
export type MinClientBuildSource = 'env' | 'default';

export interface MinClientBuild {
  readonly value: number;
  readonly source: MinClientBuildSource;
}

/**
 * Missing or empty variable = no threshold (`undefined`, no field in `hello`). A set value must be a SAFE integer
 * ≥ 1: a typo has to stop the START (`ConfigError`) instead of silently dropping the gate someone just meant to set.
 *
 * `isSafeInteger`, not `isInteger`: the `hello` schema (`z.number().int()`) rejects numbers above
 * `Number.MAX_SAFE_INTEGER`, so `9007199254740992` accepted here would give a frame the client's own decoder
 * rejects, and the app would get no `hello` at all.
 */
export function parseMinClientBuild(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError(
      `${MIN_CLIENT_BUILD_ENV} must be an integer 1–${String(Number.MAX_SAFE_INTEGER)} (got: ${raw}).`,
    );
  }
  return value;
}

/**
 * Effective threshold and its source. An explicit value wins everywhere; an empty one counts as unset. Without it
 * only a package install outside demo takes {@link DEFAULT_MIN_CLIENT_BUILD}: a clone builds the app from its own
 * history (build = commit count, which a fork may keep below the default) and its tests cover the missing threshold,
 * and demo runs the consent channel `off` while its app tests expect `hello` without a threshold.
 */
export function minClientBuildOf(
  raw: string | undefined, options: { readonly demo: boolean; readonly mode?: InstallMode },
): MinClientBuild | undefined {
  const explicit = parseMinClientBuild(raw);
  if (explicit !== undefined) return { value: explicit, source: 'env' };
  return (options.mode ?? INSTALL_MODE) === 'package' && !options.demo
    ? { value: DEFAULT_MIN_CLIENT_BUILD, source: 'default' }
    : undefined;
}
