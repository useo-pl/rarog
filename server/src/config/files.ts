/**
 * The session files settings: the switch of the file routes (`RAROG_FILES`) and the largest file the server sends
 * (`RAROG_FILES_MAX_MB`). A value out of range stops the start, so a typo never leaves a limit the owner did not set.
 */
import { ConfigError, FILES_ENV, FILES_MAX_MB_ENV } from '../config-env.ts';

/** Limit of a sent file in megabytes without the variable. */
export const DEFAULT_FILES_MAX_MB = 50;

/** The highest value `RAROG_FILES_MAX_MB` takes. */
export const FILES_MAX_MB_CEILING = 1024;

const MIB = 1024 * 1024;

/** Session files switch; missing, empty or `1` = on, `0` = off, any other value stops the start. */
export function parseFilesEnabled(raw: string | undefined): boolean {
  const value = raw?.trim() ?? '';
  if (value === '' || value === '1') return true;
  if (value === '0') return false;
  throw new ConfigError(`${FILES_ENV} takes 1 or 0 (got: ${value}).`);
}

/**
 * The largest sent file in bytes, from whole megabytes (`RAROG_FILES_MAX_MB`); missing or empty = 50 MB. Only digits
 * from 1 to 1024: a fraction, an exponent, a hex number or a value out of range stops the start.
 */
export function parseFilesMaxBytes(raw: string | undefined): number {
  const value = raw?.trim() ?? '';
  if (value === '') return DEFAULT_FILES_MAX_MB * MIB;
  const mb = /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (mb >= 1 && mb <= FILES_MAX_MB_CEILING) return mb * MIB;
  throw new ConfigError(
    `${FILES_MAX_MB_ENV} takes whole megabytes from 1 to ${String(FILES_MAX_MB_CEILING)} (got: ${value}).`,
  );
}
