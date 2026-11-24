/**
 * The digits of the emergency approve button the consent cycle remembers (`layer1/screen-key.ts`) and the match of
 * a hook that registers after the key: same session, tool and input, the hook started within the key's episode
 * (slack before its start) and no later than the key, while the key is live. A hook that started after the key asks
 * about another dialog, also an identical one, and is not tied.
 */
import { describe, expect, it } from 'vitest';
import {
  SCREEN_KEY_START_SLACK_MS, SCREEN_KEY_TTL_MS, createConsentScreenKeys, screenKeyLateHookLine,
} from '../src/herdr/dialogs/layer1/screen-key.ts';
import type { ConsentScreenKey, ScreenKeyCall } from '../src/herdr/dialogs/layer1/screen-key.ts';

const SESSION = '00000000-0000-4000-9000-000000000001';
const OTHER = '00000000-0000-4000-9000-000000000002';
const SHA = 'a'.repeat(64);
const EPISODE = Date.parse('2026-11-09T10:00:00.000Z');

/** The key 5 s after the start of the episode it answered. */
const KEY: ConsentScreenKey = { toolName: 'Bash', inputSha256: SHA, at: EPISODE + 5_000, since: EPISODE };

interface Keys {
  /** A call of `SESSION`, `Bash` with `SHA`, its hook started 100 ms before the key, with the given fields over it. */
  answered(call: Partial<ScreenKeyCall>): boolean;
  note(key: ConsentScreenKey, sessionId?: string): void;
  setClock(at: number): void;
}

function keys(): Keys {
  let clock = KEY.at;
  const screenKeys = createConsentScreenKeys(() => clock);
  return {
    answered: (call) => screenKeys.answered({
      sessionId: SESSION, toolName: 'Bash', inputSha256: SHA, hookStartedAt: KEY.at - 100, ...call,
    }),
    note: (key, sessionId = SESSION) => { screenKeys.note(sessionId, key); },
    setClock: (at) => { clock = at; },
  };
}

describe('createConsentScreenKeys: the match of a late hook', () => {
  it('no key noted → no match', () => {
    expect(keys().answered({})).toBe(false);
  });

  it.each([
    ['at the key', KEY.at, true],
    ['one ms after the key (another dialog, also an identical one)', KEY.at + 1, false],
    ['at the slack before the episode start', KEY.since - SCREEN_KEY_START_SLACK_MS, true],
    ['one ms before the slack', KEY.since - SCREEN_KEY_START_SLACK_MS - 1, false],
    ['inside the episode', KEY.since + 1_000, true],
  ] as const)('hook started %s → %s', (_name, hookStartedAt, tied) => {
    const k = keys();
    k.note(KEY);
    expect(k.answered({ hookStartedAt })).toBe(tied);
  });

  it.each([
    ['another session', { sessionId: OTHER }],
    ['another tool', { toolName: 'Write' }],
    ['another input', { inputSha256: 'b'.repeat(64) }],
  ] as const)('%s → no match', (_name, call) => {
    const k = keys();
    k.note(KEY);
    expect(k.answered(call)).toBe(false);
  });

  it(`the key lives ${String(SCREEN_KEY_TTL_MS)} ms: at the end it still ties, one ms later it is gone`, () => {
    const k = keys();
    k.note(KEY);
    k.setClock(KEY.at + SCREEN_KEY_TTL_MS);
    expect(k.answered({})).toBe(true);
    k.setClock(KEY.at + SCREEN_KEY_TTL_MS + 1);
    expect(k.answered({})).toBe(false);
  });

  it('a key of another session ties only its own session', () => {
    const k = keys();
    k.note(KEY, OTHER);
    expect(k.answered({})).toBe(false);
    expect(k.answered({ sessionId: OTHER })).toBe(true);
  });

  it('16 keys per session: the 17th drops the oldest', () => {
    const k = keys();
    const series = Array.from({ length: 17 }, (_, i): ConsentScreenKey => ({
      ...KEY, inputSha256: i.toString(16).padStart(64, '0'),
    }));
    for (const key of series) k.note(key);
    expect(k.answered({ inputSha256: series[0]?.inputSha256 ?? '' })).toBe(false);
    for (const key of series.slice(1)) expect(k.answered({ inputSha256: key.inputSha256 })).toBe(true);
  });

  it('the same key ties two identical hooks that both started before it (no key is used up)', () => {
    const k = keys();
    k.note(KEY);
    expect(k.answered({ hookStartedAt: KEY.at - 300 })).toBe(true);
    expect(k.answered({ hookStartedAt: KEY.at - 200 })).toBe(true);
  });
});

describe('screenKeyLateHookLine', () => {
  it('the contract format, no input, command or path', () => {
    expect(screenKeyLateHookLine(SESSION, 'k-1', 'subagent', 'dialog-gone')).toBe(
      `consent: screen fallback late hook — session ${SESSION}, key k-1, thread subagent, release dialog-gone`,
    );
  });
});
