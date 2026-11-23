/**
 * PR status (`SessionPullRequest.state`): the state of the PRs that sessions created, read from GitHub with the
 * user's `gh` login while a client is connected. The entry of the directory; callers import only from here.
 *
 * - `source.ts`: PR reference from an address, the read result, the state source contract, the fixed-map source;
 * - `gh.ts`: the `gh` source (program lookup, closed environment, batched query on stdin, output reader) and the
 *   login check of `rarog doctor`;
 * - `tracker.ts`: the URL → state map, the rhythm, pauses after failures and the change callback.
 */
export {
  GH_ARGV, GH_AUTH_ARGV, GH_AUTH_TIMEOUT_MS, GH_DIRECTORIES, GH_HOST, GH_OUTPUT_CAP_BYTES, GH_TIMEOUT_MS, PR_BATCH_MAX,
  PR_STATUS_ENV_PASSTHROUGH, buildQueryBody, checkGhAuth, createGhSource, findGh, ghCandidates, ghEnv, readGhOutput,
} from './gh.ts';
export type { FindGhOptions, GhAuthState, GhRun, GhSourceOptions } from './gh.ts';
export { createFixedPrStateSource, parsePrUrl } from './source.ts';
export type { PrReadFailure, PrReadResult, PrRef, PrStateSource } from './source.ts';
export {
  FAILURE_PAUSE_MS, NEW_URL_DELAY_MS, OPEN_REFRESH_MS, RATE_LIMIT_PAUSE_MAX_MS, UNKNOWN_REFRESH_MS,
  createPrStatusTracker,
} from './tracker.ts';
export type { PrStatusTracker, PrStatusTrackerOptions } from './tracker.ts';
