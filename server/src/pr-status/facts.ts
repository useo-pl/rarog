/**
 * Facts of PRs from GitHub: author, creation time and the latest title, kept in process memory until restart and
 * shared by every conversation, plus the `gh` login (`viewer.login`) and the queue that verifies each linked URL
 * without facts once. Author and creation time never change, so a stored fact is never asked again; only the title
 * follows later answers.
 *
 * No process, no timer, no log: the tracker (`tracker.ts`) asks what is due, puts it into its reads and hands every
 * successful answer back. Nothing here touches the state map.
 */
import { parsePrUrl } from './source.ts';
import type { PrReadResult, PrRef } from './source.ts';

/** What GitHub said about one PR, as the list needs it. */
export interface PrFacts {
  /** Login of the PR author (`ghost` for a deleted account). */
  readonly author: string;
  /** When GitHub says the PR was created (epoch ms). */
  readonly createdAtMs: number;
  /** The latest title GitHub gave, sanitised; missing while no answer had one. */
  readonly title?: string;
}

/** What one answer changed: URLs with new facts or a new title, and whether the `gh` login changed. */
export interface PrFactsChange {
  readonly urls: ReadonlySet<string>;
  readonly viewerChanged: boolean;
}

/** A successful read. */
export type PrReadAnswer = Extract<PrReadResult, { ok: true }>;

export interface PrFactsQueue {
  factsOf(url: string): PrFacts | undefined;
  /** The `gh` login of the last answer that had one; `null` before the first. */
  viewerLogin(): string | null;
  /**
   * The whole linked set of a session (replaces the previous one). A URL in the grammar without facts waits for its
   * verification from `dueAt`; URLs no session links leave the queue (their facts stay).
   */
  setSessionLinks(sessionId: string, urls: Iterable<string>, dueAt: number): void;
  /** Forgets the linked set of a session; `false` when it had none. */
  dropSession(sessionId: string): boolean;
  /** When the earliest verification is due (epoch ms), `Infinity` when none waits. */
  nextDueAt(): number;
  /** Verifications due by `now`, the oldest first, at most `max`, without the URLs of `skip`. */
  due(now: number, max: number, skip: ReadonlySet<string>): PrRef[];
  /**
   * One successful answer about `urls`: found facts are stored (also for a URL no session links any more), a title
   * replaces the stored one, a URL still waiting without facts is due again at `retryAt`.
   */
  apply(urls: Iterable<string>, answer: PrReadAnswer, retryAt: number): PrFactsChange;
}

interface Waiting {
  readonly ref: PrRef;
  dueAt: number;
}

export function createPrFactsQueue(): PrFactsQueue {
  const known = new Map<string, PrFacts>();
  const links = new Map<string, ReadonlySet<string>>();
  const waiting = new Map<string, Waiting>();
  let viewer: string | null = null;

  const sync = (dueAt: number): void => {
    const wanted = new Set<string>();
    for (const urls of links.values()) for (const url of urls) wanted.add(url);
    for (const url of waiting.keys()) if (!wanted.has(url)) waiting.delete(url);
    for (const url of wanted) {
      if (known.has(url) || waiting.has(url)) continue;
      const ref = parsePrUrl(url);
      if (ref !== null) waiting.set(url, { ref, dueAt });
    }
  };

  return {
    factsOf: (url) => known.get(url),
    viewerLogin: () => viewer,
    setSessionLinks: (sessionId, urls, dueAt) => {
      links.set(sessionId, new Set(urls));
      sync(dueAt);
    },
    dropSession: (sessionId) => {
      if (!links.delete(sessionId)) return false;
      sync(Infinity);
      return true;
    },
    nextDueAt: () => {
      let next = Infinity;
      for (const entry of waiting.values()) if (entry.dueAt < next) next = entry.dueAt;
      return next;
    },
    due: (now, max, skip) => [...waiting.values()]
      .filter((entry) => entry.dueAt <= now && !skip.has(entry.ref.url))
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, Math.max(0, max))
      .map((entry) => entry.ref),
    apply: (urls, answer, retryAt) => {
      const changed = new Set<string>();
      for (const url of urls) {
        const read = answer.facts.get(url);
        const title = answer.titles.get(url);
        const before = known.get(url);
        if (before !== undefined) {
          if (title !== undefined && title !== before.title) {
            known.set(url, { ...before, title });
            changed.add(url);
          }
        } else if (read?.kind === 'found') {
          const { author, createdAtMs } = read;
          known.set(url, title === undefined ? { author, createdAtMs } : { author, createdAtMs, title });
          waiting.delete(url);
          changed.add(url);
        } else {
          const entry = waiting.get(url);
          if (entry !== undefined) entry.dueAt = retryAt;
        }
      }
      const viewerChanged = answer.viewer !== null && answer.viewer !== viewer;
      if (viewerChanged) viewer = answer.viewer;
      return { urls: changed, viewerChanged };
    },
  };
}
