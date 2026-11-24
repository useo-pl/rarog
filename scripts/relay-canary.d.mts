/**
 * Types of `relay-canary.mjs` for its tests (`relay-vps/test/canary.test.ts`, and `relay-auth/test/core.test.ts`
 * against the registry): the parts that need no relay.
 */

/** Keys from RELAY_CANARY_KEYS: an empty list, two keys (bytes), or an error description without key values. */
export declare function parseKeys(raw: string | undefined): { keys?: number[][]; error?: string };

/** Verdict of the `rate` step: `null` = passed, else the failure. */
export declare function judgeTransfer(res: { burstMs: number; totalMs: number; bytes: number }): string | null;

/** Transfer description for the canary log: times and pace of the first 16 MB and the rest. */
export declare function describeTransfer(res: { burstMs: number; totalMs: number }): string;

/** EndpointId (64 hex characters) of an iroh secret key given as 32 bytes. */
export declare function endpointIdOf(secret: readonly number[]): string;

/** Text that key 0 signs for the registry's `renew`. */
export declare function renewSigningText(request: {
  endpointId: string; issuedAt: number; servers: readonly string[];
}): string;

/** Result of a canary step: passed or failed with a description, or skipped with a reason. */
export type StepResult =
  | { ok: boolean; text: string; skip?: undefined }
  | { skip: string; ok?: undefined; text?: undefined };

/** The `renew` step: key 0 renews its app entry and its sponsorship of key 1 in the registry. */
export declare function renewEntries(keys: readonly (readonly number[])[], options?: {
  registry?: string;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  nowSec?: () => number;
}): Promise<StepResult>;
