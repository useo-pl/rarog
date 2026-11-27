/**
 * `rarog doctor`: the PR status line (`docs/pull-requests.md`). Session cards list only PRs whose author GitHub
 * confirms through the `gh` login, so without `gh` in the closed directory list and a login they show no PRs. It
 * looks for `gh` the way the server does (the closed directory list, `~/` from the service environment that
 * `buildServeEnv` gives), then runs `gh auth status --active --no-refresh --hostname github.com` with the same closed
 * environment as the server's reads.
 *
 * `RAROG_PR_STATUS=0` = info; the demo and its review mode (`RAROG_DEMO`, as `bootstrap/pr-status.ts` decides) = info
 * about the fixed state source, no lookup; no `gh` = warn with a fix; not logged in, a `gh` too old for the check's
 * flags, or a check that failed = warn; logged in = ok. Without a usable `config.json` there is no service environment
 * (and `rarog serve` would refuse to start): info, no lookup. Reads only; nothing from the output of `gh` reaches the
 * screen.
 */
import { PR_STATUS_ENV } from '../config-env.ts';
import { demoEnabled } from '../config/demo.ts';
import { GH_AUTH_ARGV, GH_DIRECTORIES, GH_HOST, checkGhAuth, findGh } from '../pr-status/index.ts';
import type { GhAuthState } from '../pr-status/index.ts';

/** The doctor line (a subset of `Line` in `doctor.ts`, so this module does not import it). */
export interface PrStatusDoctorLine {
  readonly verdict: 'ok' | 'warn' | 'info';
  readonly text: string;
  readonly repair?: string;
}

export interface PrStatusLineInput {
  /** `RAROG_PR_STATUS` of the service environment (empty = missing). */
  readonly flag: string;
  /** The `gh` found, or `null`. */
  readonly gh: string | null;
  /** The login check of the `gh` found; `null` when there is none. */
  readonly auth: GhAuthState | null;
  readonly directories?: readonly string[];
}

const LOGIN = `gh auth login --hostname ${GH_HOST}`;
const CHECK = `gh ${GH_AUTH_ARGV.join(' ')}`;
const CHECK_FLAGS = GH_AUTH_ARGV.filter((arg) => arg === '--active' || arg === '--no-refresh').join(' ');
/** Without GitHub's answer no linked PR is confirmed as the user's, so the cards list none. */
const NO_PRS = ', so session cards show no PRs';

/** The line for given facts; no process, no disk. */
export function prStatusLineOf(input: PrStatusLineInput): PrStatusDoctorLine {
  if (input.flag.trim() === '0') return { verdict: 'info', text: `PR status: off (${PR_STATUS_ENV}=0)${NO_PRS}` };
  if (input.gh === null) {
    return {
      verdict: 'warn',
      text: `PR status: gh not found in ${(input.directories ?? GH_DIRECTORIES).join(', ')}${NO_PRS}`,
      repair: `install the GitHub CLI (gh) in one of these directories, run ${LOGIN} and restart the server,`
        + ` or set ${PR_STATUS_ENV}=0 in config.json`,
    };
  }
  if (input.auth === 'logged-in') return { verdict: 'ok', text: `PR status: ${input.gh} logged in to ${GH_HOST}` };
  if (input.auth === 'not-logged-in') {
    return {
      verdict: 'warn',
      text: `PR status: ${input.gh} is not logged in to ${GH_HOST}${NO_PRS}`,
      repair: `${LOGIN} as the user the service runs as; the server picks it up within 30 min, without a restart`,
    };
  }
  if (input.auth === 'outdated-gh') {
    return {
      verdict: 'warn',
      text: `PR status: ${input.gh} does not know gh auth status ${CHECK_FLAGS}, so the login was not checked`,
      repair: 'update the GitHub CLI (gh) and run rarog doctor again',
    };
  }
  return {
    verdict: 'warn',
    text: `PR status: ${CHECK} did not finish (${input.gh})`,
    repair: `run ${CHECK} in a terminal`,
  };
}

/** The line when `config.json` gives no service environment: nothing to check against. */
export const PR_STATUS_UNCHECKED_LINE: PrStatusDoctorLine = {
  verdict: 'info', text: 'PR status: not checked (config.json gives no service environment)',
};

/** The demo and its review mode read states from a fixed map and never start `gh` (`bootstrap/pr-status.ts`). */
export const PR_STATUS_DEMO_LINE: PrStatusDoctorLine = {
  verdict: 'info', text: 'PR status: demo, fixed states (RAROG_DEMO=1), gh not used',
};

export interface PrStatusLineDeps {
  readonly directories?: readonly string[];
  readonly check?: (bin: string, env: NodeJS.ProcessEnv) => Promise<GhAuthState>;
}

/**
 * The line for the service environment `env` (from `buildServeEnv`; the flag, `HOME` for `~/.local/bin` and the
 * closed environment of `gh`), `null` when there is none. With the flag at `0` and in the demo no lookup and no
 * process.
 */
export async function prStatusLine(
  env: Readonly<Record<string, string | undefined>> | null, deps: PrStatusLineDeps = {},
): Promise<PrStatusDoctorLine> {
  if (env === null) return PR_STATUS_UNCHECKED_LINE;
  const flag = env[PR_STATUS_ENV] ?? '';
  const directories = deps.directories ?? GH_DIRECTORIES;
  if (flag.trim() === '0') return prStatusLineOf({ flag, gh: null, auth: null, directories });
  if (demoEnabled(env['RAROG_DEMO'])) return PR_STATUS_DEMO_LINE;
  const gh = findGh({ home: env['HOME'], directories });
  const auth = gh === null ? null : await (deps.check ?? checkGhAuth)(gh, { ...env });
  return prStatusLineOf({ flag, gh, auth, directories });
}
