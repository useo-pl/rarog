/**
 * The PR list and PR status on session cards (`docs/pull-requests.md`): the manager's side of the PR status tracker.
 * From the conversation's linked set it keeps the owner's PRs (`visiblePullRequests`: the author is the `gh` login,
 * created at or after the conversation's first entry), tells the tracker which URLs to verify and which to keep fresh,
 * lays the known state over the list when a summary is built, and sends `session-changed` when what a card shows
 * changes.
 *
 * The state never lives in the session: it is read at summary time, so a result that comes after the list changed
 * cannot bring an old list back. A list change touches neither the session state, nor `seen`, nor a push. Without a
 * port (`RAROG_PR_STATUS=0`) there are no facts, so the list stays empty. This module does not import `manager.ts`.
 */
import type { PullRequestState, SessionPullRequest, SessionSummary } from '@rarog/shared';
import { newestFirst } from '../herdr/background/pull-requests.ts';
import type { PrFacts, PrStatusChange } from '../pr-status/index.ts';
import type { Session } from './session.ts';

/** How many PRs at most stand on the session list; the list rides in every snapshot frame, like artifacts. */
export const PULL_REQUESTS_MAX = 20;

/** What the verdict needs: the linked set, the conversation window, the `gh` login and the facts from GitHub. */
export interface PullRequestVerdictInput {
  /** The conversation's linked set (the driver's `pull-requests` event), any order. */
  readonly linked: readonly SessionPullRequest[];
  /** Time of the conversation's first entry (ISO); missing = not known yet. */
  readonly windowStart: string | null | undefined;
  /** The `gh` login GitHub answered with; `null` = no answer yet. */
  readonly viewer: string | null;
  readonly factsOf: (url: string) => PrFacts | undefined;
}

/**
 * The PRs a card shows: the linked PRs whose author is `viewer` and that GitHub says were created at or after
 * `windowStart`, with the GitHub title and the link time as `createdAt`, newest first, at most
 * {@link PULL_REQUESTS_MAX} after the filter. No login, no window or no facts = not shown. Pure.
 */
export function visiblePullRequests(input: PullRequestVerdictInput): SessionPullRequest[] {
  const { linked, windowStart, viewer, factsOf } = input;
  if (viewer === null || windowStart === null || windowStart === undefined) return [];
  const from = Date.parse(windowStart);
  if (Number.isNaN(from)) return [];
  const visible: SessionPullRequest[] = [];
  for (const { url, repo, number, createdAt } of linked) {
    const facts = factsOf(url);
    if (facts === undefined || facts.author !== viewer || !(facts.createdAtMs >= from)) continue;
    const { title } = facts;
    visible.push(title === undefined ? { url, repo, number, createdAt } : { url, repo, number, createdAt, title });
  }
  return visible.sort(newestFirst).slice(0, PULL_REQUESTS_MAX);
}

/** What the manager needs from the tracker; `bootstrap/pr-status.ts` builds it. */
export interface PrStatusPort {
  stateOf(url: string): PullRequestState | undefined;
  /** Author, creation time (epoch ms) and latest title of a PR from GitHub; `undefined` = not known (yet). */
  factsOf(url: string): PrFacts | undefined;
  /** The `gh` login GitHub last answered with; `null` before the first answer. Never log or send it. */
  viewerLogin(): string | null;
  /** The whole current PR list of a session (replaces the previous one). */
  setSessionUrls(sessionId: string, urls: Iterable<string>): void;
  /** The whole linked set of a session (replaces the previous one): each URL without facts is verified once. */
  setSessionLinks(sessionId: string, urls: Iterable<string>): void;
  /** Forgets the session's list and linked set. */
  dropSession(sessionId: string): void;
  /** Registers the one listener of changes: URLs whose state, facts or title changed, and a changed `gh` login. */
  listen(onChange: (change: PrStatusChange) => void): void;
}

export interface SessionPrStatusDeps {
  readonly sessions: ReadonlyMap<string, Session>;
  readonly emitSessionChanged: (session: Session) => void;
}

const urlsOf = (list: readonly SessionPullRequest[] | undefined): string[] => (list ?? []).map((pr) => pr.url);

export class SessionPrStatus {
  readonly #port: PrStatusPort | undefined;
  readonly #deps: SessionPrStatusDeps;

  constructor(port: PrStatusPort | undefined, deps: SessionPrStatusDeps) {
    this.#port = port;
    this.#deps = deps;
    port?.listen((change) => { this.#changed(change); });
  }

  /**
   * The `pull-requests` driver event: the conversation's linked set and window, a card's metadata without a state
   * transition, `seen` or push. An empty set clears the fields; a card frame goes out only when the shown list
   * changed (the driver pays the set out at every attach).
   */
  applyList(session: Session, linked: readonly SessionPullRequest[], windowStart?: string): void {
    const links = linked.length > 0 ? linked : undefined;
    if (links === undefined && session.pullRequestLinks === undefined && session.pullRequests === undefined) return;
    session.pullRequestLinks = links;
    session.pullRequestWindowStart = links === undefined ? undefined : windowStart;
    if (this.sync(session)) this.#deps.emitSessionChanged(session);
  }

  /** Drops the list and the links (another conversation or out of scope) and tells the tracker. */
  clear(session: Session): void {
    session.pullRequests = undefined;
    session.pullRequestLinks = undefined;
    session.pullRequestWindowStart = undefined;
    this.sync(session);
  }

  /**
   * The shown list again from the session's links and window, and the tracker told both (the linked set to verify,
   * the shown URLs to keep fresh); call after anything that set the PR fields. `true` = the shown list changed.
   */
  sync(session: Session): boolean {
    const before = session.pullRequests;
    const shown = this.#port === undefined ? [] : visiblePullRequests({
      linked: session.pullRequestLinks ?? [], windowStart: session.pullRequestWindowStart,
      viewer: this.#port.viewerLogin(), factsOf: (url) => this.#port?.factsOf(url),
    });
    session.pullRequests = shown.length > 0 ? shown : undefined;
    this.#port?.setSessionLinks(session.id, urlsOf(session.pullRequestLinks));
    this.#port?.setSessionUrls(session.id, urlsOf(session.pullRequests));
    return JSON.stringify(before ?? []) !== JSON.stringify(shown);
  }

  forget(sessionId: string): void {
    this.#port?.dropSession(sessionId);
  }

  /** The known state over the summary's PR list (a copy), or no `state` at all without a port. */
  overlay(summary: SessionSummary): void {
    if (summary.pullRequests === undefined) return;
    summary.pullRequests = summary.pullRequests.map(({ state: _ignored, ...pr }) => {
      const state = this.#port?.stateOf(pr.url);
      return state === undefined ? pr : { ...pr, state };
    });
  }

  /**
   * A tracker answer: the sessions that link a changed URL (every session with links when the `gh` login changed)
   * get their list again; a frame goes to those whose shown list changed or that show a URL whose state changed.
   */
  #changed({ urls, viewerChanged }: PrStatusChange): void {
    for (const session of this.#deps.sessions.values()) {
      const links = session.pullRequestLinks ?? [];
      if (links.length === 0 || (!viewerChanged && !links.some((pr) => urls.has(pr.url)))) continue;
      const listChanged = this.sync(session);
      const shownChanged = urlsOf(session.pullRequests).some((url) => urls.has(url));
      if (listChanged || shownChanged) this.#deps.emitSessionChanged(session);
    }
  }
}
