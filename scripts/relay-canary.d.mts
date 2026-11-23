/** Typy `relay-canary.mjs` dla testów `relay-vps/test/canary.test.ts` (czyste części bez sieci). */

/** Klucze z RELAY_CANARY_KEYS: pusta lista, dwa klucze (bajty) albo opis błędu bez wartości kluczy. */
export declare function parseKeys(raw: string | undefined): { keys?: number[][]; error?: string };

/** Werdykt kroku `rate`: `null` = zaliczony, inaczej opis porażki. */
export declare function judgeTransfer(res: { burstMs: number; totalMs: number; bytes: number }): string | null;

/** Opis transferu do logu kanarka: czasy i tempo pierwszych 16 MB i reszty. */
export declare function describeTransfer(res: { burstMs: number; totalMs: number }): string;
