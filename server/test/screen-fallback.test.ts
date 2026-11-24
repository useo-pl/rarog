/**
 * The emergency approve button rule (`herdr/dialogs/screen-fallback.ts`): facts → the first guard that refuses the
 * button, the digit gate with the mark, and the log lines of the key and the refused key. The driver cases (the card
 * over time, the key and its checks) live in `screen-fallback-driver.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { consentDigitBlocked } from '../src/herdr/dialogs/router.ts';
import {
  SCREEN_FALLBACK_GUARDS, screenFallbackGuard, screenFallbackHolds, screenFallbackKeyLine, screenFallbackRefusedLine,
} from '../src/herdr/dialogs/screen-fallback.ts';
import type { ScreenFallbackFacts, ScreenFallbackGuard, ScreenFallbackMark } from '../src/herdr/dialogs/screen-fallback.ts';

/** A main thread `Bash` dialog in `all` with `disableAllHooks`: everything the button needs. */
const OK: ScreenFallbackFacts = {
  mode: 'all', cliDialog: 'permission', card: true, thread: 'main', judged: true, trace: false, hookWaits: false,
  hookRunning: false, foreignHook: false, restarting: false,
};

const rows: readonly (readonly [string, Partial<ScreenFallbackFacts>, ScreenFallbackGuard | null])[] = [
  ['hooks off in the project, main thread call proven by the frame', {}, null],
  ['the same in `main`', { mode: 'main' }, null],
  ['a registration within the grace is a trace', { trace: true }, 'trace'],
  ['a trace source that cannot be read', { trace: null }, 'trace'],
  ['the grace has not passed or was not judged yet', { judged: false }, 'judgement'],
  ['a channel card (also `unknown`) or a live registration without one holds the dialog', { hookWaits: true }, 'hook'],
  ['the hook process runs without a registration', { hookRunning: true }, 'hook-running'],
  ['the hook process is gone without a registration', { hookRunning: false }, null],
  ['a transient hook list verdict (`no-process`, `io`)', { foreignHook: null }, 'hook-list'],
  ['a foreign hook in the current settings', { foreignHook: true }, 'hook-list'],
  ['settings changed after the start, no foreign hook in the current content', { foreignHook: false }, null],
  ['subagent dialog, call identical to the main thread entry, in `main`', { thread: 'subagent', mode: 'main' },
    'thread'],
  ['the same in `all` (the card shows the suffix)', { thread: 'subagent' }, null],
  ['subagent dialog, main thread entry another call: the `off` card has no button', { thread: 'subagent', card: false },
    'card'],
  ['no title line on screen to tell the thread', { thread: null }, 'thread'],
  ['`ps` unavailable: the main thread goes on the other facts', { hookRunning: null }, null],
  ['`ps` unavailable: never for a subagent', { hookRunning: null, thread: 'subagent' }, 'ps'],
  ['within the restart grace (a dump or record from before the start may still register)', { restarting: true },
    'restart'],
  ['card cut, ambiguous, with a hidden character, over the ceiling, or a dialog without digits', { card: false },
    'card'],
  ['unknown mode (the mode source failed)', { mode: null }, 'mode'],
  ['`off`', { mode: 'off' }, 'mode'],
  ['`shadow`', { mode: 'shadow' }, 'mode'],
  ['sandbox network class', { cliDialog: 'sandbox' }, 'class'],
  ['registry not `waiting`', { cliDialog: null }, 'class'],
];

describe('emergency approve button: facts → guard', () => {
  it.each(rows)('%s', (_name, change, guard) => {
    expect(screenFallbackGuard({ ...OK, ...change })).toBe(guard);
  });

  it('every guard of the rule has a row, and the order puts the mode and class first', () => {
    const seen = new Set(rows.map((row) => row[2]));
    const own = SCREEN_FALLBACK_GUARDS.slice(0, SCREEN_FALLBACK_GUARDS.indexOf('registry'));
    expect(own.filter((guard) => !seen.has(guard))).toEqual([]);
    expect(screenFallbackGuard({ ...OK, mode: 'off', cliDialog: 'sandbox', card: false })).toBe('mode');
    expect(screenFallbackGuard({ ...OK, cliDialog: 'sandbox', card: false, trace: true })).toBe('class');
  });
});

const MARK: ScreenFallbackMark = {
  facts: { ...OK }, cause: 'hooks-disabled', toolUseId: 'toolu_1', inputSha256: 'a'.repeat(64), since: 0,
};

describe('digit gate with the emergency mark', () => {
  it('"Yes" of a marked `permission` card passes in `main`, `all`; the same function decides', () => {
    for (const mode of ['main', 'all'] as const) {
      expect(consentDigitBlocked({ mode, cliDialog: 'permission', toolName: 'Bash', consent: true, fallback: MARK }))
        .toBe(false);
      expect(screenFallbackHolds(MARK, mode, 'permission')).toBe(true);
    }
  });

  it('unknown mode, another class, an answer path or a subagent mark in `main`: blocked as before', () => {
    const sub: ScreenFallbackMark = { ...MARK, facts: { ...MARK.facts, thread: 'subagent' } };
    const blocked = [
      { mode: null, cliDialog: 'permission', consent: true, fallback: MARK },
      { mode: 'all', cliDialog: 'sandbox', consent: true, fallback: MARK },
      { mode: 'all', cliDialog: null, consent: true, fallback: MARK },
      { mode: 'all', cliDialog: 'permission', consent: false, fallback: MARK },
      { mode: 'main', cliDialog: 'permission', consent: true, fallback: sub },
      { mode: 'all', cliDialog: 'permission', consent: true },
    ] as const;
    for (const row of blocked) {
      expect(consentDigitBlocked({ ...row, toolName: 'Bash' }), JSON.stringify(row)).toBe(true);
    }
    expect(consentDigitBlocked({ mode: 'all', cliDialog: 'permission', toolName: 'Bash', consent: true, fallback: sub }))
      .toBe(false);
  });

  it('`off` and `shadow` stay without the gate', () => {
    for (const mode of ['off', 'shadow'] as const) {
      expect(consentDigitBlocked({ mode, cliDialog: 'permission', toolName: 'Bash', consent: true })).toBe(false);
    }
  });
});

describe('log lines', () => {
  it('key and refused key carry identifiers only; anything else becomes `?`', () => {
    expect(screenFallbackKeyLine({
      sessionId: 'b1e7c0de-0000-4000-8000-000000000001', tool: 'Bash', cause: 'hooks-disabled', card: 'toolu_1',
      toolUseId: 'toolu_1',
    })).toBe('consent: screen fallback key — session b1e7c0de-0000-4000-8000-000000000001, tool Bash,'
      + ' cause hooks-disabled, card toolu_1, tool_use toolu_1');
    expect(screenFallbackKeyLine({
      sessionId: 's', tool: 'echo /etc/passwd', cause: 'unexplained', card: 'a b', toolUseId: null,
    })).toBe('consent: screen fallback key — session s, tool ?, cause unexplained, card ?, tool_use ?');
    expect(screenFallbackRefusedLine({ sessionId: 's', tool: 'Edit', guard: 'screen', card: 'toolu_2' }))
      .toBe('consent: screen fallback refused — session s, tool Edit, guard screen, card toolu_2');
  });
});
