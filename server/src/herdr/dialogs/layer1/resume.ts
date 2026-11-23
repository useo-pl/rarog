/**
 * Resumption of the channel records a server restart interrupted (restart grace G). In recovery a record whose
 * hook may still wait, and whose hook `ps` finds alive, waits up to G for the hook's second registration, which the
 * registry checks against the record (`expectResume` in `registry.ts`). This module keeps that wait and the allow-button
 * hold of a resumed `pending` record, in process memory only; the cycle (`cycle.ts`) does the transitions it asks for
 * and writes the claim deadline start this module hands it. It reads no file and writes nothing.
 *
 * - Waits: `pending` with the card digest of its first dump equal to its first registration's; `sent` and `claimed`
 *   (an `allow` without a receipt) with the answer file of the decision, whose signature the re-sent secret must
 *   verify. `deciding`, another state, a hook `ps` does not find alive, G = 0 or no `ps`: nothing waits. A waiting
 *   `sent` whose file the hook takes before its second registration (`claimed`, an `allow` without a receipt) waits on
 *   under the same deadline and the same check; any other move ends the wait.
 * - Over ({@link ConsentResume.settle}): no second registration within G, or one the registry refused or did not take
 *   as resumed. The cycle then revokes (`restart`) as recovery did before the grace.
 * - The hold ({@link ConsentResume.holds}): a `pending` record that waited never gets the allow button back in this
 *   process. The button needs the transcript history continuous from the hook start, and nobody read the transcript
 *   while the server was down: a "Yes" at the desk followed by a truncation reads afterwards like a call still open.
 *   It is the herdr socket return of a hook started before the boundary (`re-attached`): no evidence read later gives
 *   the proof back. Deny and release stay.
 * - The claim deadline of a resumed `sent` counts from its second registration ({@link ConsentResume.claimFrom}); the
 *   cycle keeps that start in the record (`claimFrom`, {@link consentClaimKept}) for the recovery after another
 *   restart.
 */
import type { ProcessLiveness } from '../shadow/liveness.ts';
import { CONSENT_CLAIMED_SUFFIX } from './contract.ts';
import type { ConsentCycleRecord, ConsentRecord } from './records.ts';
import type { ConsentRegistry, ConsentResumeExpect } from './registry.ts';

export interface ConsentResumeOptions {
  /** G in ms; 0 = no record waits. */
  readonly graceMs: number;
  /** `ps` for the hooks of recovered records (`psLiveness`); no field = no hook counts as alive. */
  readonly liveness?: ProcessLiveness;
  /** The expectation methods are optional so that test registries without them simply never resume. */
  readonly registry: Pick<ConsentRegistry, 'entry'> & Partial<Pick<ConsentRegistry, 'expectResume' | 'cancelResume'>>;
  /** Text of the record's answer file with this suffix (`.json`, `.claimed`), or `null`. */
  readonly read: (record: ConsentRecord, suffix: string) => string | null;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /**
   * The registry took the second registration of a waiting `sent` record of the decision `decisionAt` at `at`: the
   * start of its claim deadline, for the cycle to keep in the record ({@link consentClaimKept}).
   */
  readonly onResumed?: (sessionId: string, key: string, decisionAt: number, at: number) => void;
}

/** Why a wait ended without a resumption: no second registration within G, or one that did not resume. */
export type ConsentResumeOver = 'expired' | 'refused';

export interface ConsentResume {
  /** Before recovery: one `ps` question per hook of a record that could wait ({@link wait}). */
  probe(records: readonly ConsentRecord[]): Promise<void>;
  /** In recovery, after the record took its recovered state: `true` = it waits G for its hook (expectation set). */
  wait(record: ConsentCycleRecord): boolean;
  /** The wait of the record ended without a resumption (forgotten here); `null` = it still waits, resumed or none. */
  settle(record: ConsentRecord): ConsentResumeOver | null;
  /**
   * The record was written: a waiting `sent` the hook took (`claimed`, an `allow` without a receipt) waits on, any
   * other change of state drops the wait and the registry's expectation.
   */
  moved(record: ConsentCycleRecord): void;
  /** The `pending` record's allow button is held for good: it waited for its hook after the restart. */
  holds(record: ConsentRecord): boolean;
  /**
   * Start of the claim deadline of a `sent` record: now while it waits, then its second registration; without a wait
   * the start kept in the record for this decision ({@link ConsentCycleRecord.claimFrom}); `null` = its `sent` time.
   */
  claimFrom(record: ConsentCycleRecord): number | null;
}

interface Wait {
  readonly state: ConsentRecord['state'];
  readonly until: number;
}

const slotOf = (record: Pick<ConsentRecord, 'sessionId' | 'key'>): string => `${record.sessionId}\n${record.key}`;

/** States of a stored record that recovery can leave waiting. */
const PROBED: readonly ConsentRecord['state'][] = ['pending', 'deciding', 'sent', 'claimed'];

/** The hook process a record waits for: the registration its decision is signed under, else its first dump. */
function hookOf(record: ConsentCycleRecord): { readonly pid: number; readonly startedAt: number } {
  return record.signed === undefined ? { pid: record.pid, startedAt: record.hookStartedAt }
    : { pid: record.signed.pid, startedAt: record.signed.hookStartedAt };
}

/** The suffix of the answer file a record that waits holds; `null` = no file (`pending`) or a record that never waits. */
function answerSuffix(record: ConsentCycleRecord): string | null | undefined {
  if (record.state === 'pending') return null;
  if (record.state === 'sent') return '.json';
  if (record.state === 'claimed' && record.decision === 'allow' && record.receipt === undefined) {
    return CONSENT_CLAIMED_SUFFIX;
  }
  return undefined;
}

/**
 * What the record expects of its hook's second registration, without the answer file; `null` = it never waits.
 * A `pending` record needs the card digest of its first registration equal to the one the server computed from its
 * first dump; a decided one the registration its file is signed under.
 */
function identityOf(record: ConsentCycleRecord): ConsentResumeExpect | null {
  const suffix = answerSuffix(record);
  if (suffix === undefined) return null;
  const base = { key: record.key, sessionId: record.sessionId };
  if (suffix === null) {
    if (record.cardSha256 === null || record.dumpCardSha256 !== record.cardSha256) return null;
    return {
      ...base, promptId: record.promptId, agentId: record.agentId, pid: record.pid, startedAt: record.hookStartedAt,
      inputSha256: record.inputSha256, cardSha256: record.cardSha256,
    };
  }
  const signed = record.signed;
  if (signed === undefined) return null;
  return {
    ...base, promptId: signed.promptId, agentId: signed.agentId, pid: signed.pid, startedAt: signed.hookStartedAt,
    inputSha256: signed.inputSha256, cardSha256: signed.cardSha256,
  };
}

/**
 * The `sent` record of the decision `decisionAt` with the claim deadline start `at` kept
 * ({@link ConsentCycleRecord.claimFrom}); `null` = nothing to write: no record, another state or decision, or the same
 * start already kept.
 */
export function consentClaimKept(
  record: ConsentCycleRecord | undefined, decisionAt: number, at: number,
): ConsentCycleRecord | null {
  if (record === undefined || record.state !== 'sent' || record.decisionAt !== decisionAt) return null;
  if (record.claimFrom?.decisionAt === decisionAt && record.claimFrom.at === at) return null;
  return { ...record, claimFrom: { decisionAt, at } };
}

export function createConsentResume(options: ConsentResumeOptions): ConsentResume {
  const { registry, now, log } = options;
  const waits = new Map<string, Wait>();
  /** Slots of `pending` records that waited for their hook: their allow button is held for the life of the process. */
  const held = new Set<string>();
  /** `ps` answers of {@link ConsentResume.probe} per slot, read once by {@link ConsentResume.wait}. */
  const alive = new Map<string, boolean>();
  const enabled = options.graceMs > 0 && options.liveness !== undefined && registry.expectResume !== undefined;

  /** The answer file of a decided record as `expectResume` takes it; `null` = no readable file. */
  function answerOf(record: ConsentCycleRecord, suffix: string): ConsentResumeExpect['answer'] | null {
    try {
      const text = options.read(record, suffix);
      if (text === null) return null;
      return { file: JSON.parse(text) as unknown, permissionsSha256: record.permissions?.sha256 ?? null };
    } catch {
      return null;
    }
  }

  /** The registry's call on the second registration of a `sent` record, for its claim deadline start. */
  function toldOf(record: ConsentCycleRecord): Pick<ConsentResumeExpect, 'onResumed'> {
    const { decisionAt } = record;
    const onResumed = options.onResumed;
    if (record.state !== 'sent' || decisionAt === null || onResumed === undefined) return {};
    return { onResumed: (at) => { onResumed(record.sessionId, record.key, decisionAt, at); } };
  }

  /** The tracked wait of the record in the state it waited in; another state drops it. */
  function waitOf(record: ConsentRecord): Wait | null {
    const found = waits.get(slotOf(record));
    if (found === undefined) return null;
    if (found.state === record.state) return found;
    drop(record);
    return null;
  }

  function drop(record: ConsentRecord): void {
    if (waits.delete(slotOf(record))) registry.cancelResume?.(record.sessionId, record.key);
  }

  /** The registry entry of a resumed record: its second registration time; `null` = not (or not yet) resumed. */
  function resumedAt(record: Pick<ConsentRecord, 'sessionId' | 'key'>): number | null {
    const entry = registry.entry(record.sessionId, record.key);
    return entry !== null && entry.resumed === true && !entry.blocked ? entry.acceptedAt : null;
  }

  return {
    async probe(records) {
      if (!enabled || options.liveness === undefined) return;
      const liveness = options.liveness;
      // `deciding` too: with its answer file on disk recovery makes it `sent`.
      const asked = records.filter((record) => PROBED.includes(record.state));
      const at = now();
      // One question per hook: a pid given back to another process answers for its own start only.
      const answers = await Promise.all(asked.map((record) => {
        const hook = hookOf(record);
        return liveness([hook], at).then((found) => found.get(hook.pid) ?? null, () => null);
      }));
      asked.forEach((record, index) => { if (answers[index] === true) alive.set(slotOf(record), true); });
    },

    wait(record) {
      const slot = slotOf(record);
      const found = alive.delete(slot);
      const identity = enabled && found ? identityOf(record) : null;
      if (identity === null) return false;
      const suffix = answerSuffix(record);
      const answer = suffix === null || suffix === undefined ? undefined : answerOf(record, suffix);
      if (answer === null) return false;
      registry.expectResume?.({ ...identity, ...(answer === undefined ? {} : { answer }), ...toldOf(record) });
      waits.set(slot, { state: record.state, until: now() + options.graceMs });
      if (record.state === 'pending') held.add(slot);
      log(`consent: key ${record.key} (${record.state}) waits for its hook after the restart`);
      return true;
    },

    settle(record) {
      const found = waitOf(record);
      if (found === null) return null;
      const entry = registry.entry(record.sessionId, record.key);
      if (entry === null && now() < found.until) return null;
      if (entry !== null && entry.resumed === true && !entry.blocked) return null;
      const over: ConsentResumeOver = entry === null ? 'expired' : 'refused';
      drop(record);
      log(`consent: key ${record.key} not resumed after the restart (${over})`);
      return over;
    },

    moved(record) {
      const slot = slotOf(record);
      const found = waits.get(slot);
      if (found === undefined || found.state === record.state) return;
      // The hook took the file before its second registration: the `allow` still needs the receipt, which needs that
      // registration, so the wait, its deadline and the check of the secret stay.
      if (found.state === 'sent' && answerSuffix(record) === CONSENT_CLAIMED_SUFFIX) {
        waits.set(slot, { ...found, state: record.state });
        return;
      }
      drop(record);
    },

    holds(record) {
      return record.state === 'pending' && held.has(slotOf(record));
    },

    claimFrom(record) {
      if (record.state !== 'sent') return null;
      if (waitOf(record) !== null) return resumedAt(record) ?? now();
      const kept = record.claimFrom;
      return kept !== undefined && kept.decisionAt === record.decisionAt ? kept.at : null;
    },
  };
}
