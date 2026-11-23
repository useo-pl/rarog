/**
 * `rarog doctor`: the state write block line. It reads `~/.claude/settings.json` and looks in `permissions.deny`
 * for the two rules `rarog setup` writes (`writeBlockRules`), built for the data directory of the installed service
 * (`settingsDataDir`: without a service `--data-dir`, then the rule on the service environment), whatever this shell
 * computes. Both rules present, compared literally = ok;
 * a missing rule = warn with its name and `rarog setup` as the fix; a path no rule can name exactly = warn, never ok.
 * Reads only; it does not see project or managed settings, so the line reports the user file, not the session.
 */
import { settingsDataDir } from '../install/data-dir.ts';
import { rarogCli } from '../install/repair.ts';
import { userSettingsPath, writeBlockRules } from '../herdr/hook-config.ts';
import { readRegularFileSync } from '../safe-read.ts';
import type { CliIo } from './io.ts';
import { installedServiceDataDir } from './restart.ts';
import { launchdEnv } from './service.ts';

/** The doctor line (a subset of `Line` in `doctor.ts`, so this module does not import it). */
export interface WriteBlockDoctorLine {
  readonly verdict: 'ok' | 'warn' | 'unknown';
  readonly text: string;
  readonly details?: readonly string[];
  readonly repair?: string;
}

const TITLE = 'state write block';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const errnoCode = (failure: unknown): string =>
  (isRecord(failure) && typeof failure['code'] === 'string' ? failure['code'] : '') || String(failure);

/**
 * The line for this machine. `manager` is the `systemd --user` environment doctor has already read on Linux (`null`
 * elsewhere); the service environment is then the same as setup's, so both count the rules of one directory. `flag`
 * is doctor's `--data-dir`.
 */
export function writeBlockLine(
  io: CliIo, home: string, platform: NodeJS.Platform,
  manager: { readonly env: NodeJS.ProcessEnv } | { readonly failure: string } | null,
  flag?: string,
): WriteBlockDoctorLine {
  const serviceEnv = manager !== null && 'env' in manager
    ? { ...launchdEnv(io.env), ...manager.env }
    : launchdEnv(io.env);
  const dataDir = settingsDataDir({
    home, env: serviceEnv, flag, serviceDir: installedServiceDataDir(io, platform, home),
  });
  if (!dataDir.ok) return { verdict: 'unknown', text: `${TITLE}: no data directory: ${dataDir.message}` };
  const built = writeBlockRules(dataDir.dir, home);
  if (!built.ok) {
    return {
      verdict: 'warn',
      text: `${TITLE}: rarog setup cannot write it: ${built.reason}`,
      repair: 'give the service a data directory without these characters (rarog setup --data-dir), or keep'
        + ' Claude Code sessions from writing it in your own settings',
    };
  }
  const settings = userSettingsPath(home);
  let parsed: unknown = null;
  try {
    const read = readRegularFileSync(settings, { maxBytes: 4 * 1024 * 1024, followSymlink: true });
    parsed = read === null ? null : JSON.parse(read.bytes.toString('utf8'));
  } catch (failure) {
    if (errnoCode(failure) !== 'ENOENT') {
      return { verdict: 'unknown', text: `${TITLE}: ${settings} unreadable (${errnoCode(failure)})` };
    }
  }
  const permissions = isRecord(parsed) ? parsed['permissions'] : undefined;
  const deny = isRecord(permissions) && Array.isArray(permissions['deny']) ? permissions['deny'] : [];
  const missing = built.rules.filter((rule) => !deny.includes(rule));
  if (missing.length === 0) {
    return { verdict: 'ok', text: `${TITLE}: ${built.rules.join(' and ')} in permissions.deny of ${settings}` };
  }
  return {
    verdict: 'warn',
    text: `${TITLE}: permissions.deny of ${settings} lacks ${String(missing.length)} rule(s), so a Claude Code`
      + ' session can write the Rarog state',
    details: missing,
    repair: rarogCli('setup'),
  };
}
