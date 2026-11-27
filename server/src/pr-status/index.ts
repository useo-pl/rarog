/**
 * PR status (`SessionPullRequest.state`) and the facts of PRs: the state of the PRs that sessions list, and the
 * author, creation time and title of the PRs that conversations link, read from GitHub with the user's `gh` login
 * while a client is connected. The entry of the directory; callers import only from here.
 *
 * - `source.ts`: PR reference from an address, the read result (state, title and facts per address, `gh` login), the
 *   source contract, the fixed-map source;
 * - `gh.ts`: the `gh` source (program lookup, closed environment, batched query on stdin, output reader, title
 *   sanitiser) and the login check of `rarog doctor`;
 * - `facts.ts`: the facts memory, the `gh` login and the one-time verification queue of linked URLs;
 * - `tracker.ts`: the URL → state map, the rhythm of every read, pauses after failures and the change callback.
 */
export type { PrFacts } from './facts.ts';
export {
  GH_ARGV, GH_AUTH_ARGV, GH_AUTH_TIMEOUT_MS, GH_DIRECTORIES, GH_HOST, GH_OUTPUT_CAP_BYTES, GH_TIMEOUT_MS, PR_BATCH_MAX,
  PR_STATUS_ENV_PASSTHROUGH, PR_TITLE_MAX, buildQueryBody, checkGhAuth, createGhSource, findGh, ghCandidates, ghEnv,
  prTitle, readGhOutput,
} from './gh.ts';
export type { FindGhOptions, GhAuthState, GhRun, GhSourceOptions } from './gh.ts';
export { createFixedPrStateSource, parsePrUrl } from './source.ts';
export type {
  FixedGitHub, FixedPullRequest, PrFactsRead, PrReadFailure, PrReadResult, PrRef, PrStateSource,
} from './source.ts';
export {
  FAILURE_PAUSE_MS, NEW_URL_DELAY_MS, OPEN_REFRESH_MS, RATE_LIMIT_PAUSE_MAX_MS, UNKNOWN_REFRESH_MS,
  createPrStatusTracker,
} from './tracker.ts';
export type { PrStatusChange, PrStatusTracker, PrStatusTrackerOptions } from './tracker.ts';
