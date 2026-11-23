/**
 * Reason of a desk release: why a subagent request had no proof at its last observation, as one code from
 * a closed list ({@link CONSENT_DESK_REASONS}) for the log line `consent: key <key> (subagent) released to the desk
 * after <ms> ms without proof (reason: <code>)` in `desk.ts` and for the card's reason. Derived from facts the proof
 * path already computes (`observe.ts`, `proof.ts`); it never changes a card, a proof or a decision. Only
 * {@link consentDeskAtOnce} decides something: when the release comes. Described in `docs/dialogs.md`, "Channel cycle"
 * (desk fallback).
 */
import { hookListVerdictKind } from './hook-list/hook-list.ts';
import type { ConsentProofFinding, ConsentSubagentFile, ConsentTopCheck } from './proof.ts';

/**
 * Codes in the order the derivation checks them. `unknown`: no observation facts recorded for the key. `dump-unread`:
 * the last observation did not read the key's dump (incomplete read). `scan-incomplete`: the dump or marker read was
 * incomplete. Subagent file: `file-unknown` (no facts: no file, an agent file under two workflow runs, agent files
 * off, a read error), `reader-partial` (no opening entry of a run read), `file-behind` (the read did not reach the end
 * of the file), `file-unsettled` (an unfinished line or a full line that did not parse). Shared checks:
 * `hook-not-alive` (`ps` did not confirm the hook alive), `digest` (dump input trimmed), `passed` (the agent file has
 * the call closed), `lost` (proof-loss fact). Hidden proof: `registry-unknown` (CLI registry unknown or too old),
 * `interrupted`, `main-file-unknown` (main-file facts about the agent unknown or not known to the end),
 * `not-background` (no background start), `run-ended`, `top-seen` (the dump once matched the screen top), `other-hooks`
 * (the hook list check). Top proof (registry says `waiting: permission`): `top-twins` (two dumps match the top),
 * `top-miss` (the key is not the top winner). `unexplained`: no check failed at the last observation (a proof that
 * expired after it). A durable hook list verdict ({@link consentDeskAtOnce}) gives `other-hooks` right after the read
 * checks, whatever hidden or top check failed first: it is why the request went back at once.
 */
export const CONSENT_DESK_REASONS = [
  'unknown', 'dump-unread', 'scan-incomplete', 'file-unknown', 'reader-partial', 'file-behind', 'file-unsettled',
  'hook-not-alive', 'digest', 'passed', 'lost', 'registry-unknown', 'interrupted', 'main-file-unknown',
  'not-background', 'run-ended', 'top-seen', 'other-hooks', 'top-twins', 'top-miss', 'unexplained',
] as const;

export type ConsentDeskReason = (typeof CONSENT_DESK_REASONS)[number];

/** Why the subagent file facts are not known to the end (the order of `subagentClosures`); `null` = known. */
function fileReasonOf(file: ConsentSubagentFile | null): ConsentDeskReason | null {
  if (file === null) return 'file-unknown';
  if (file.partial) return 'reader-partial';
  if (!file.caughtUp) return 'file-behind';
  return file.settled ? null : 'file-unsettled';
}

/**
 * Reason code for one observation of a subagent key. `finding` = the observation's facts; `dumpRead` = the step
 * came with the key's dump (a step without dump and finding is the observation's card whose dump it did not read);
 * `top` = the cycle's top check for that observation's screen. The top proof counts only when the registry says
 * a fresh `waiting: permission` (then the hidden proof under `screen` fails on the registry check); otherwise the
 * hidden proof names the check that failed.
 */
export function consentDeskReasonOf(
  key: string, finding: ConsentProofFinding | undefined, dumpRead: boolean, top: ConsentTopCheck | null,
): ConsentDeskReason {
  if (finding === undefined) return dumpRead ? 'unknown' : 'dump-unread';
  const facts = finding.subagent;
  if (facts === undefined) return 'unknown';
  if (!facts.complete) return 'scan-incomplete';
  if (durableHooks(facts.hooks ?? null)) return 'other-hooks';
  const file = fileReasonOf(facts.file) ?? 'unexplained';
  if (facts.hidden === 'registry' && finding.registry === null) {
    switch (finding.own) {
      case 'subagent': return file;
      case 'digest': return 'digest';
      case 'hook-dead': case 'hook-unknown': return 'hook-not-alive';
      case 'transcript-passed': return 'passed';
      default: break;
    }
    if (facts.lost) return 'lost';
    if (top === null || top.winner !== key) return top?.miss === 'ambiguous' ? 'top-twins' : 'top-miss';
    return 'unexplained';
  }
  // Under `channel` the hidden proof can fail before the registry check while the top proof holds (the card had the
  // button): the failed hidden check is then not why the key went to the desk.
  if (finding.registry === null && finding.own === null && !facts.lost && top?.winner === key) return 'unexplained';
  switch (facts.hidden) {
    case null: case 'thread': return 'unexplained';
    case 'hook': return 'hook-not-alive';
    case 'registry': return 'registry-unknown';
    case 'file': return file;
    case 'main-file': return 'main-file-unknown';
    case 'top-lost': return 'top-seen';
    default: return facts.hidden;
  }
}

/** The hook list's `why` says no hook list proof for the life of the session process (`hookListVerdictKind`). */
function durableHooks(why: string | null): boolean {
  return why !== null && hookListVerdictKind(why) === 'durable';
}

/**
 * The desk fallback sends a subagent request without the approve button back at its first check, without waiting
 * `CONSENT_SUBAGENT_GRACE_MS` and also while the registry says `waiting: permission`: the
 * reason of its last observation is `other-hooks` with a durable verdict of the session hook list. The observation
 * gives the verdict only under the `screen` hidden rule (`observe.ts`), where the hook list check counts, so the hidden
 * proof cannot come back while the session process lives. A transient verdict, or none, keeps the 10 s.
 */
export function consentDeskAtOnce(
  note: { readonly reason: ConsentDeskReason; readonly hooks: string | null } | undefined,
): boolean {
  return note !== undefined && note.reason === 'other-hooks' && durableHooks(note.hooks);
}

/** The hook list's `why` (`hook-list/hook-list.ts`) split at its first `:`: the code and the rest (file or layer). */
export interface ConsentHookWhy {
  readonly code: string;
  /** A file for `changed`, `hook-in` and `marketplace-changed`, a layer for `foreign`; `null` = the code alone. */
  readonly detail: string | null;
}

export function consentHookWhyOf(why: string): ConsentHookWhy {
  const at = why.indexOf(':');
  return at < 0 ? { code: why, detail: null } : { code: why.slice(0, at), detail: why.slice(at + 1) };
}

/**
 * What the desk release of a subagent key kept for the card of the same call (`screen-unavailable.ts`): the reason
 * code, the hook list's `why` of the last observation with the hook list miss and the request's `cwd`. Memory only: a
 * server restart forgets it, and so does the end of the engine session.
 */
export interface ConsentDeskRelease {
  readonly reason: ConsentDeskReason;
  readonly hooks: ConsentHookWhy | null;
  /** `cwd` of the request's per-call dump; `null` = unknown. */
  readonly cwd: string | null;
}

/** Desk releases per cycle slot, kept until the end of the engine session. */
export interface ConsentDeskReleases {
  note(slot: string, reason: ConsentDeskReason, why: string | null, cwd: string | null): void;
  of(slot: string): ConsentDeskRelease | null;
  /** Forgets every slot that starts with `prefix` (the session's slot prefix). */
  endSession(prefix: string): void;
}

export function createConsentDeskReleases(): ConsentDeskReleases {
  const kept = new Map<string, ConsentDeskRelease>();
  return {
    note: (slot, reason, why, cwd) => {
      kept.set(slot, { reason, hooks: why === null ? null : consentHookWhyOf(why), cwd });
    },
    of: (slot) => kept.get(slot) ?? null,
    endSession: (prefix) => {
      for (const slot of [...kept.keys()]) if (slot.startsWith(prefix)) kept.delete(slot);
    },
  };
}
