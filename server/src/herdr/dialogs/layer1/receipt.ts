/**
 * The hook's receipt of a phone `allow` (W-a): the `POST /claim` body check and the rule which record takes it.
 *
 * The hook gives `allow` only after the server confirms that the taken answer file is the record's live decision.
 * A copy of an old `allow` (restored `.revoked`, a file put back after a revoke) keeps a valid signature, but the
 * record has moved on, so the receipt is refused and the hook gives nothing. The receipt is signed with the secret of
 * the hook's live registration (`consentReceiptMac` in `sign.ts`): a process with access to the socket cannot confirm
 * someone else's key, and a wrong signature gets the same answer as an unknown key.
 *
 * This module does not write records: the cycle does, in the key's queue (`confirmReceipt` in `cycle.ts`).
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HOOK_CALL_KEY_PATTERN } from '../hook/contract.ts';
import { CONSENT_SECRET_BYTES } from './contract.ts';
import type { ConsentClaimConfirmed, ConsentDecision, ConsentCycleState } from './contract.ts';
import type { ConsentRegistry } from './registry.ts';
import { consentReceiptMac } from './sign.ts';

/** HTTP status of each refusal of `/claim`. `refused` covers a wrong signature and an unknown key alike. */
export const CONSENT_CLAIM_REFUSALS = {
  'bad-request': 400,
  refused: 403,
  stale: 409,
} as const;
export type ConsentClaimRefusal = keyof typeof CONSENT_CLAIM_REFUSALS;

export type ConsentClaimOutcome =
  | { readonly status: 200; readonly body: ConsentClaimConfirmed }
  | {
    readonly status: (typeof CONSENT_CLAIM_REFUSALS)[ConsentClaimRefusal];
    readonly body: { readonly confirmed: false; readonly error: ConsentClaimRefusal };
  };

export interface ConsentClaimsOptions {
  readonly registry: Pick<ConsentRegistry, 'entries' | 'secretOf'>;
  /**
   * The cycle's confirmation (`ConsentCycle.confirmReceipt`): `true` = the record's live `allow` with this `at` now
   * carries the receipt. Gets the `inputSha256` of the hook's registration.
   */
  readonly confirm: (sessionId: string, key: string, at: number, inputSha256: string) => Promise<boolean>;
  readonly log?: (line: string) => void;
}

export interface ConsentClaims {
  /** One `/claim` body (unchecked). Never throws. */
  claim(body: unknown): Promise<ConsentClaimOutcome>;
}

const claimSchema = z.strictObject({
  key: z.string().regex(HOOK_CALL_KEY_PATTERN),
  at: z.number().int().nonnegative().refine(Number.isSafeInteger),
  mac: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Secret for an unknown key: the signature is still computed and compared, so the answer takes the same path. */
const DUMMY_SECRET = '0'.repeat(CONSENT_SECRET_BYTES * 2);
/** Session for an unknown key; any value valid in the signature contract. */
const DUMMY_SESSION = 'unknown';

/**
 * Whether a record takes a receipt for `at`: its decision is `allow` with this `decisionAt`, and it is `sent` or
 * `claimed`. `claimed` too, because the cycle may see the hook's take (file review, a revoke or release that found
 * `.claimed`) before the receipt comes; the same `decisionAt` still means the same signed decision. Any later or
 * final state, another decision or another `at` takes none.
 */
export function consentReceiptConfirmable(
  record: { readonly state: ConsentCycleState; readonly decision: ConsentDecision | null;
    readonly decisionAt: number | null },
  at: number,
): boolean {
  return record.decision === 'allow' && record.decisionAt === at
    && (record.state === 'sent' || record.state === 'claimed');
}

export function createConsentClaims(options: ConsentClaimsOptions): ConsentClaims {
  const log = options.log ?? ((): void => {});
  const refuse = (error: ConsentClaimRefusal): ConsentClaimOutcome => ({
    status: CONSENT_CLAIM_REFUSALS[error], body: { confirmed: false, error },
  });

  const claim = async (body: unknown): Promise<ConsentClaimOutcome> => {
    const parsed = claimSchema.safeParse(body);
    if (!parsed.success) return refuse('bad-request');
    const { key, at, mac } = parsed.data;
    const entry = options.registry.entries().find((candidate) => candidate.key === key) ?? null;
    const secret = entry === null ? null : options.registry.secretOf(entry.sessionId, key);
    const expected = consentReceiptMac(secret ?? DUMMY_SECRET, {
      sessionId: entry?.sessionId ?? DUMMY_SESSION, key, at,
    });
    const signed = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'));
    if (entry === null || secret === null || !signed) return refuse('refused');
    let confirmed: boolean;
    try {
      confirmed = await options.confirm(entry.sessionId, key, at, entry.inputSha256);
    } catch {
      confirmed = false;
    }
    log(`consent: receipt of key ${key} ${confirmed ? 'confirmed' : 'refused (stale)'}`);
    return confirmed ? { status: 200, body: { confirmed: true } } : refuse('stale');
  };

  return { claim };
}
