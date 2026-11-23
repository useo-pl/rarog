/**
 * The contract between the PR status tracker and a state source: a PR reference parsed from its address, the result
 * of one read, and the fixed-map source used where no process may start (demo, review mode, frame producer).
 *
 * Nothing here starts a process or touches the disk; `gh.ts` is the only source that does.
 */
import type { PullRequestState } from '@rarog/shared';
import { PR_URL } from '../herdr/background/pull-requests.ts';

/** One PR as the source asks about it; `url` is the key of the state map. */
export interface PrRef {
  readonly url: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * Why a whole read gave no states. `missing-gh` turns the status off until restart, `rate-limited` pauses until
 * `resetAt`, every other failure pauses for the fixed failure pause.
 */
export type PrReadFailure = 'missing-gh' | 'not-logged-in' | 'timeout' | 'output-cap' | 'error' | 'rate-limited';

export type PrReadResult =
  | {
    readonly ok: true;
    /** Every asked URL: its state, or `null` for no state (PR not found, unknown value). */
    readonly states: ReadonlyMap<string, PullRequestState | null>;
    /** Present when GitHub said no points are left: pause until `resetAt` (epoch ms, `null` = unknown). */
    readonly limitReached?: { readonly resetAt: number | null };
  }
  | { readonly ok: false; readonly failure: Exclude<PrReadFailure, 'rate-limited'> }
  | { readonly ok: false; readonly failure: 'rate-limited'; readonly resetAt: number | null };

/** Where states come from. `read` never rejects; a call that cannot finish answers with a failure. */
export interface PrStateSource {
  read(prs: readonly PrRef[], signal?: AbortSignal): Promise<PrReadResult>;
}

/**
 * The PR behind an address, or `null` for any other shape (never asked about). The grammar is the one of the reader
 * of conversation files (`PR_URL` in `herdr/background/pull-requests.ts`), the addresses the server sends: the number
 * has at most 9 digits, so it always fits GraphQL `Int` and one bad address cannot fail the whole batched query.
 */
export function parsePrUrl(url: string): PrRef | null {
  const match = PR_URL.exec(url);
  if (match === null) return null;
  const [, owner = '', repo = '', number = ''] = match;
  return { url, owner, repo, number: Number(number) };
}

/** A source that answers from a fixed map and never starts a process. URLs outside the map have no state. */
export function createFixedPrStateSource(states: ReadonlyMap<string, PullRequestState>): PrStateSource {
  return {
    read: (prs) => Promise.resolve({
      ok: true,
      states: new Map(prs.map((pr) => [pr.url, states.get(pr.url) ?? null])),
    }),
  };
}
