/**
 * Refreshing the session's pull request list, a module of the herdr driver.
 *
 * The module holds the explicit read state (the conversation file reader, timer, read in progress, next read
 * ordered, signature of the sent list) and two functions over it: ordering a read and the read itself with the list
 * payout. Creating the reader, its `repoint`, `relocated` and `close`, and the signals that order a read stay in the
 * facade `drivers/herdr-driver.ts`, because the facade knows the agent handle and follower events.
 */
import type { SessionPullRequest } from '@rarog/shared';
import type { Scheduler, TimerHandle } from '../runtime.ts';
import { PULL_REQUESTS_BACKLOG_MS, pullRequestsSignature } from '../../herdr/background/index.ts';
import type { PullRequestFilesReader } from '../../herdr/background/index.ts';

export interface PullRequestPollState {
  /** Czytnik plików rozmowy pod kątem PR-ów; `null` = panel poza zasięgiem. */
  readonly prReader: PullRequestFilesReader | null;
  /** Delay of a read after a signal. */
  readonly prPollMs: number;
  /** Zegar najbliższego odczytu PR-ów; `null` = żaden nie czeka. */
  prTimer: TimerHandle | null;
  /** Odczyt PR-ów trwa; sygnał w tym czasie zamawia następny (`prAgain`). */
  prReading: boolean;
  prAgain: boolean;
  /**
   * Podpis ostatnio wysłanej listy PR-ów. Start od pustej listy: pusta lista po podpięciu nie wychodzi, bo sesja po
   * wymianie drivera trzyma listę tylko tej samej rozmowy (inną manager zdejmuje), a PR-y rozmowy nie znikają.
   */
  prSent: string;
}

/** Contact with the facade, built at every call, like `TasksDeps` of background tasks. */
export interface PullRequestPollDeps {
  readonly scheduler: Scheduler;
  readonly disposed: () => boolean;
  readonly emit: (pullRequests: readonly SessionPullRequest[]) => void;
}

export function createPullRequestPollState(
  prReader: PullRequestFilesReader | null, prPollMs: number,
): PullRequestPollState {
  return { prReader, prPollMs, prTimer: null, prReading: false, prAgain: false, prSent: pullRequestsSignature([]) };
}

/**
 * Zamawia odczyt plików rozmowy pod kątem PR-ów za `delayMs`. Sygnały, które przyjdą, zanim zegar
 * wybije, składają się w ten sam odczyt; sygnał w trakcie odczytu zamawia następny po nim.
 */
export function schedulePullRequests(
  state: PullRequestPollState, deps: PullRequestPollDeps, delayMs = state.prPollMs,
): void {
  if (deps.disposed() || state.prReader === null) return;
  if (state.prReading) {
    state.prAgain = true;
    return;
  }
  if (state.prTimer !== null) return;
  state.prTimer = deps.scheduler.setTimeout(() => {
    state.prTimer = null;
    void readPullRequests(state, deps);
  }, delayMs);
}

/**
 * Jeden odczyt PR-ów i wypłata listy, gdy różni się od wysłanej (pierwsza idzie zawsze). Zaległość odczytu
 * (budżet bajtów) zamawia następny po krótkiej przerwie, bez czekania na sygnał.
 */
export async function readPullRequests(state: PullRequestPollState, deps: PullRequestPollDeps): Promise<void> {
  const reader = state.prReader;
  if (deps.disposed() || reader === null) return;
  state.prReading = true;
  state.prAgain = false;
  let backlog = false;
  let stale = false;
  try {
    const read = await reader.read();
    if (deps.disposed()) return;
    // Odczyt przerwany przez `/clear` albo przeniesienie plików: następny od razu, po nowym adresie.
    stale = read === null;
    if (read === null) return;
    backlog = read.backlog;
    const signature = pullRequestsSignature(read.pullRequests);
    if (signature !== state.prSent) {
      state.prSent = signature;
      deps.emit(read.pullRequests);
    }
  } finally {
    state.prReading = false;
    const again = state.prAgain;
    state.prAgain = false;
    if (stale) schedulePullRequests(state, deps, 0);
    else if (backlog) schedulePullRequests(state, deps, PULL_REQUESTS_BACKLOG_MS);
    else if (again) schedulePullRequests(state, deps);
  }
}
