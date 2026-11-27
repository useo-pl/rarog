/**
 * Pull requests linked to the conversation: recognition of the link entry, the conversation window and the linked
 * set. PURE: no I/O, clock or logs. The disk side is `pull-request-files.ts`; this module gets entries of the MAIN
 * conversation file in write order. Whole picture: `docs/pull-requests.md`.
 *
 * Source: Claude Code writes a top-level `pr-link` entry (shape in `cli-shapes.ts`, `prLink`) when it ties a pull
 * request to the conversation. An entry counts only when its URL is exactly a GitHub PR URL ({@link PR_URL}), its
 * number and repository agree with the URL and it has a valid `timestamp`. `sessionId` is not checked: a forked
 * conversation copies the entries of its parent, and they count.
 *
 * Linked set: one item per URL with the EARLIEST entry time as `createdAt`, at most {@link LINKED_PULL_REQUESTS_MAX}
 * newest. Window: the `timestamp` of the first entry of the file that has a valid top-level one; a nested `timestamp`
 * does not count. This module does not decide which linked PR the session shows.
 */
import type { SessionPullRequest } from '@rarog/shared';
import { asRecord } from '../../drivers/tool-text.ts';
import { parseJsonlEntry } from '../jsonl-pending.ts';
import { CLI_SHAPES } from './cli-shapes.ts';

const LINK = CLI_SHAPES.prLink.literals;

/** How many linked URLs one conversation keeps; above it the oldest goes. */
export const LINKED_PULL_REQUESTS_MAX = 100;

/**
 * Adres PR w gramatyce GitHuba: właściciel z liter, cyfr i łączników (do 39 znaków), nazwa repo z liter, cyfr,
 * kropki, podkreślenia i łącznika, numer dodatni bez zer wiodących (do 9 cyfr, bezpieczna liczba całkowita).
 * Jedna definicja: tę samą gramatykę czyta moduł stanu PR-ów (`pr-status/source.ts`, `parsePrUrl`).
 */
export const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,8})$/;

/** Prefilter needle: the entry type stands in the line literally. Bytes, because the reader compares file chunks. */
const NEEDLE = Buffer.from(LINK.type, 'utf8');

/** Whether a file line MAY carry a link entry. A cheap prefilter before `JSON.parse`; a false "yes" costs one parse. */
export function mayCarryPullRequestLink(line: Buffer): boolean {
  return line.includes(NEEDLE);
}

/** Adres PR rozłożony na części; `null` = linia nie jest DOKŁADNIE adresem PR. */
export function parsePullRequestUrl(text: string): Pick<SessionPullRequest, 'url' | 'repo' | 'number'> | null {
  const hit = PR_URL.exec(text);
  if (hit === null) return null;
  const owner = hit[1] ?? '';
  const repo = hit[2] ?? '';
  if (repo === '.' || repo === '..') return null;
  return { url: text, repo: `${owner}/${repo}`, number: Number(hit[3]) };
}

/** A valid top-level `timestamp` of a PARSED entry (`parseJsonlEntry`), or `null`. */
export function entryTimeOf(value: unknown): string | null {
  const entry = asRecord(value);
  if (entry === null || Array.isArray(value)) return null;
  const at = entry['timestamp'];
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
}

/** Whether a PARSED entry is a link entry, valid or not (the follower's read signal). */
export function isPullRequestLinkEntry(value: unknown): boolean {
  return !Array.isArray(value) && asRecord(value)?.['type'] === LINK.type;
}

/** One PARSED link entry → the linked PR with the entry time as `createdAt`; `null` = not a valid link entry. */
export function pullRequestLinkOf(value: unknown): SessionPullRequest | null {
  if (!isPullRequestLinkEntry(value)) return null;
  const entry = asRecord(value) ?? {};
  const url = entry[LINK.url];
  const createdAt = entryTimeOf(value);
  if (typeof url !== 'string' || createdAt === null) return null;
  const pr = parsePullRequestUrl(url);
  if (pr === null || entry[LINK.number] !== pr.number || entry[LINK.repository] !== pr.repo) return null;
  return { ...pr, createdAt };
}

/** What the reader gives for one conversation: the linked set and the window's lower bound. */
export interface PullRequestLinks {
  /** Linked PRs, newest first, at most {@link LINKED_PULL_REQUESTS_MAX}; `createdAt` = the first entry time. */
  readonly linked: SessionPullRequest[];
  /** Time of the conversation's first entry with a valid top-level `timestamp`; `null` = not known yet. */
  readonly windowStart: string | null;
}

export interface LinkedPullRequests {
  /** Adds a linked PR; `true` when the set changed. */
  add(pr: SessionPullRequest): boolean;
  /** The set, newest first; a NEW array of NEW objects at every read (it travels on by reference). */
  readonly linked: SessionPullRequest[];
}

/** Order: time descending, on a tie number descending, then URL (a stable order). */
export function newestFirst(a: SessionPullRequest, b: SessionPullRequest): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number || (a.url < b.url ? -1 : 1);
}

/** The linked set of one conversation: one item per URL, the earliest time, the oldest out above the ceiling. */
export function createLinkedPullRequests(): LinkedPullRequests {
  const known = new Map<string, SessionPullRequest>();
  return {
    add(pr: SessionPullRequest): boolean {
      const current = known.get(pr.url);
      if (current === undefined) {
        known.set(pr.url, { ...pr });
        if (known.size > LINKED_PULL_REQUESTS_MAX) {
          const [oldest] = [...known.values()].sort((a, b) => newestFirst(b, a));
          if (oldest !== undefined) known.delete(oldest.url);
        }
        return known.has(pr.url);
      }
      if (Date.parse(pr.createdAt) >= Date.parse(current.createdAt)) return false;
      known.set(pr.url, { ...current, createdAt: pr.createdAt });
      return true;
    },
    get linked(): SessionPullRequest[] {
      return [...known.values()].sort(newestFirst).map((pr) => ({ ...pr }));
    },
  };
}

/**
 * Signature of what the driver paid out: the linked set and the window. An empty set has the signature `[]` whatever
 * the window, so a conversation without links pays nothing out after attach.
 */
export function pullRequestLinksSignature(links: PullRequestLinks): string {
  if (links.linked.length === 0) return '[]';
  return JSON.stringify([links.windowStart, ...links.linked.map((pr) => [pr.url, pr.createdAt, pr.title ?? null])]);
}

/** Links and window from the lines of ONE main file (write order): the reader's rule, for tests and demo data. */
export function pullRequestLinks(lines: readonly string[]): PullRequestLinks {
  const set = createLinkedPullRequests();
  let windowStart: string | null = null;
  for (const line of lines) {
    const entry = parseJsonlEntry(line);
    windowStart ??= entryTimeOf(entry);
    const pr = pullRequestLinkOf(entry);
    if (pr !== null) set.add(pr);
  }
  return { linked: set.linked, windowStart };
}
