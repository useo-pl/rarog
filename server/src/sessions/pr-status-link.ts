/**
 * PR status on session cards (`docs/pull-requests.md`): the manager's side of the PR status tracker. It tells the
 * tracker which URLs each session lists, lays the known state over the list when a summary is built, and sends
 * `session-changed` to the current sessions that list a URL whose state changed.
 *
 * The state never lives in `session.pullRequests` (the driver's list replaces it whole): it is read at summary time,
 * so a list the driver pays out again carries the known states in the same frame, and a result that comes after the
 * list changed cannot bring an old list back. A state change touches neither the session state, nor `seen`, nor a push.
 * Without a port (`RAROG_PR_STATUS=0`) no `state` goes out. This module does not import `manager.ts`.
 */
import type { PullRequestState, SessionPullRequest, SessionSummary } from '@rarog/shared';
import type { Session } from './session.ts';

/** What the manager needs from the tracker; `bootstrap/pr-status.ts` builds it. */
export interface PrStatusPort {
  stateOf(url: string): PullRequestState | undefined;
  /** The whole current PR list of a session (replaces the previous one). */
  setSessionUrls(sessionId: string, urls: Iterable<string>): void;
  dropSession(sessionId: string): void;
  /** Registers the one listener of state changes: the URLs whose state changed after a read. */
  listen(onChange: (urls: ReadonlySet<string>) => void): void;
}

export interface SessionPrStatusDeps {
  readonly sessions: ReadonlyMap<string, Session>;
  readonly emitSessionChanged: (session: Session) => void;
}

const urlsOf = (session: Session): string[] => (session.pullRequests ?? []).map((pr) => pr.url);

export class SessionPrStatus {
  readonly #port: PrStatusPort | undefined;
  readonly #deps: SessionPrStatusDeps;

  constructor(port: PrStatusPort | undefined, deps: SessionPrStatusDeps) {
    this.#port = port;
    this.#deps = deps;
    port?.listen((urls) => { this.#changed(urls); });
  }

  /**
   * The `pull-requests` driver event: a card's metadata without a state transition, `seen` or push. An empty
   * list leaves the field; an empty list where there is no field sends no card (the driver pays the list out at every
   * attach).
   */
  applyList(session: Session, list: readonly SessionPullRequest[]): void {
    const pullRequests = list.length > 0 ? list : undefined;
    if (pullRequests === undefined && session.pullRequests === undefined) return;
    session.pullRequests = pullRequests;
    this.sync(session);
    this.#deps.emitSessionChanged(session);
  }

  /** Drops the list (another conversation or out of scope) and tells the tracker. */
  clear(session: Session): void {
    session.pullRequests = undefined;
    this.sync(session);
  }

  /** Tells the tracker the session's current list; call after anything that set `session.pullRequests`. */
  sync(session: Session): void {
    this.#port?.setSessionUrls(session.id, urlsOf(session));
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

  #changed(urls: ReadonlySet<string>): void {
    for (const session of this.#deps.sessions.values()) {
      if (urlsOf(session).some((url) => urls.has(url))) this.#deps.emitSessionChanged(session);
    }
  }
}
