/**
 * Digits of the emergency approve button the consent cycle (layer 1) remembers for a short while, so that a hook which
 * registers after the key (its registration was still being read on the socket) is tied to that key: at the first
 * observation of its dump the cycle settles the request as when its dialog is gone, main thread and subagent alike,
 * releases its hook with a signed `release` (`cycle.ts`, `observe`) and writes the `screen fallback late hook` line.
 * A tie never approves anything: its only effect is that release. The memory, the match and the order of that
 * settlement (`lateHook`); the record writes stay in `cycle.ts` and come in through `LateHookPort`. The driver sends
 * the key and tells the cycle through the server start (`bootstrap/consent.ts`).
 */
import type { ConsentRevokeCause } from './contract.ts';
import type { ConsentRecord } from './records.ts';
import type { ConsentRegistryEntry } from './registry.ts';

/** One digit of the emergency button: the call it approved and when. */
export interface ConsentScreenKey {
  readonly toolName: string;
  /** Canonical sha256 of the call input (`hook/canon.ts`), the one the hook writes as `inputSha256`. */
  readonly inputSha256: string;
  /** The key, epoch ms. */
  readonly at: number;
  /** Start of the dialog episode the key answered, epoch ms. */
  readonly since: number;
}

/** How long a key ties a late hook to it. */
export const SCREEN_KEY_TTL_MS = 60_000;

/** Slack before the episode start: the hook process may start a moment before the registry or the pane says so. */
export const SCREEN_KEY_START_SLACK_MS = 2_000;

/** Keys kept per session; a dialog series past it drops the oldest. */
const KEYS_PER_SESSION = 16;

/** The record fields the match reads. */
export interface ScreenKeyCall {
  readonly sessionId: string;
  readonly toolName: string;
  readonly inputSha256: string;
  /** Start of the hook process, epoch ms. */
  readonly hookStartedAt: number;
}

export interface ConsentScreenKeys {
  note(sessionId: string, key: ConsentScreenKey): void;
  /**
   * Whether a remembered key answered the dialog of this hook: same session, tool and input, and the hook started
   * within the key's episode, no later than the key. A hook that started after the key asks about another dialog,
   * also an identical one, and is not tied. A key is not used up: the start cannot tell which of two identical calls
   * the key answered, and an extra tie only sends a dialog back to the desk, while a missed one would leave a card that
   * can still get the approve button for a call the key already answered.
   */
  answered(call: ScreenKeyCall): boolean;
}

/**
 * The call the match reads for a new record: the hook start and the input digest from its registration on the socket
 * when there is one, since the first dump the record comes from is not authenticated; the dump's own without it.
 */
export function screenKeyCallOf(
  record: ConsentRecord, entry: Pick<ConsentRegistryEntry, 'inputSha256' | 'startedAt'> | null,
): ScreenKeyCall {
  return {
    sessionId: record.sessionId, toolName: record.toolName,
    inputSha256: entry?.inputSha256 ?? record.inputSha256, hookStartedAt: entry?.startedAt ?? record.hookStartedAt,
  };
}

export function createConsentScreenKeys(now: () => number): ConsentScreenKeys {
  const bySession = new Map<string, ConsentScreenKey[]>();
  const live = (sessionId: string): ConsentScreenKey[] => {
    const at = now();
    const keys = (bySession.get(sessionId) ?? []).filter((key) => at - key.at <= SCREEN_KEY_TTL_MS);
    if (keys.length === 0) bySession.delete(sessionId);
    else bySession.set(sessionId, keys);
    return keys;
  };
  return {
    note: (sessionId, key) => {
      bySession.set(sessionId, [...live(sessionId), key].slice(-KEYS_PER_SESSION));
    },
    answered: (call) => live(call.sessionId).some((key) => key.toolName === call.toolName
      && key.inputSha256 === call.inputSha256 && call.hookStartedAt <= key.at
      && call.hookStartedAt >= key.since - SCREEN_KEY_START_SLACK_MS),
  };
}

/** `consent: screen fallback late hook — …`: the request of a hook that registered after the emergency key. */
export function screenKeyLateHookLine(
  sessionId: string, key: string, thread: 'main' | 'subagent', release: ConsentRevokeCause,
): string {
  return `consent: screen fallback late hook — session ${sessionId}, key ${key}, thread ${thread}, `
    + `release ${release}`;
}

/** The record writes of the cycle that settling a late hook uses. */
export interface LateHookPort {
  log(line: string): void;
  revoke(record: ConsentRecord, cause: ConsentRevokeCause): ConsentRecord;
  releaseHook(record: ConsentRecord): ConsentRecord;
}

/**
 * The request of a hook that registered after the emergency key answered its dialog: its `pending` record, written
 * without publishing, is settled at once as when its dialog is gone, main thread and subagent alike, so the devices
 * only get the settled card, never the approve button, and its hook is released. A release write that failed is
 * retried by the cycle at the next observation with the key's dump; the record stays settled.
 */
export function lateHook(record: ConsentRecord, port: LateHookPort): ConsentRecord {
  const thread = record.agentId === null ? 'main' : 'subagent';
  port.log(screenKeyLateHookLine(record.sessionId, record.key, thread, 'dialog-gone'));
  return port.releaseHook(port.revoke(record, 'dialog-gone'));
}
