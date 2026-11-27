/*
 * Live Activity counters with a subagent stuck on its own command (`ownCommandWait: 'stuck'`). A session after a turn
 * whose subagent has waited over an hour counts as waiting, never as finished or working, and is never the tap target:
 * its turn is over, and `top` describes the session state. Every other wait stage and every other state count as
 * before. The tile lifetime (`isBusy`) does not change: a stuck wait neither holds nor wakes the tile.
 *
 * The rule itself (`stuckWait`) has its table in `herdr-background-work.test.ts`; the parity with the app is the golden
 * frame `live-activity.update.waiting-agent.json`. Here: how the counters compose it with the session state.
 */
import { describe, expect, it } from 'vitest';
import type { BackgroundTask, OwnCommandWait, SessionState, SessionSummary } from '@rarog/shared';
import { aggregateState, isBusy } from '../src/notify/live-activity-state.ts';
import { makeSummary } from './fake-manager.ts';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const standby = (stage?: OwnCommandWait): BackgroundTask => ({
  id: 'agent_w', kind: 'agent', description: 'Final tests', startedAt: ago(5 * 3_600_000),
  waitingSince: ago(2 * 3_600_000),
  ownTasks: [{ id: 'b0000001', command: 'until false; do sleep 30; done' }],
  ...(stage === undefined ? {} : { ownCommandWait: stage }),
});
const command: BackgroundTask = { id: 'c1', kind: 'command', command: 'pnpm test', startedAt: ago(60_000) };

const session = (id: string, state: SessionState, tasks: BackgroundTask[], extra: Partial<SessionSummary> = {}) =>
  makeSummary({ id, state, stateSince: ago(3_600_000), backgroundTasks: tasks, ...extra });

const counts = (sessions: SessionSummary[]) => {
  const { waiting, working, finished, top } = aggregateState(sessions, NOW);
  return { waiting, working, finished, top: top?.sessionId };
};

describe('Live Activity: a session with a stuck wait counts as waiting', () => {
  it.each([
    { name: '`short`, unacknowledged', stage: 'short', seen: undefined, expected: { waiting: 0, finished: 1 } },
    { name: '`long`, unacknowledged', stage: 'long', seen: undefined, expected: { waiting: 0, finished: 1 } },
    { name: '`stuck`, unacknowledged', stage: 'stuck', seen: undefined, expected: { waiting: 1, finished: 0 } },
    { name: '`stuck`, acknowledged', stage: 'stuck', seen: true, expected: { waiting: 1, finished: 0 } },
  ] as const)('after a turn, $name → waiting $expected.waiting, finished $expected.finished', ({ stage, seen, expected }) => {
    const list = [session('s', 'waiting-input', [standby(stage)], seen === undefined ? {} : { seen })];
    expect(counts(list)).toEqual({ ...expected, working: 0, top: undefined });
  });

  it('a stuck session is never the tap target, also as the only waiting one', () => {
    expect(counts([session('stuck', 'waiting-input', [standby('stuck')])]).top).toBeUndefined();
    const withWork = [
      session('stuck', 'waiting-input', [standby('stuck')], { stateSince: ago(9 * 3_600_000) }),
      session('turn', 'running', []),
    ];
    expect(counts(withWork)).toEqual({ waiting: 1, working: 1, finished: 0, top: 'turn' });
  });

  it('next to other live work in the background: waiting only, the session counts once', () => {
    expect(counts([session('s', 'waiting-input', [standby('stuck'), command])]))
      .toEqual({ waiting: 1, working: 0, finished: 0, top: undefined });
    expect(counts([session('s', 'waiting-input', [standby('long'), command])]))
      .toEqual({ waiting: 0, working: 1, finished: 0, top: undefined });
  });

  it('a decision state with a stuck wait counts once, as the decision, and stays the tap target', () => {
    expect(counts([session('ask', 'waiting-permission', [standby('stuck')])]))
      .toEqual({ waiting: 1, working: 0, finished: 0, top: 'ask' });
  });

  it.each([
    { state: 'running', expected: { waiting: 0, working: 1, finished: 0, top: 's' } },
    { state: 'done', expected: { waiting: 0, working: 0, finished: 0, top: undefined } },
    { state: 'resumable', expected: { waiting: 0, working: 0, finished: 0, top: undefined } },
  ] as const)('state $state with a stuck wait counts as without it', ({ state, expected }) => {
    expect(counts([session('s', state, [standby('stuck')])])).toEqual(expected);
    expect(counts([session('s', state, [standby()])])).toEqual(expected);
  });

  it('a phantom agent next to live work: the session keeps working', () => {
    expect(counts([session('s', 'done', [standby('stuck'), command])]))
      .toEqual({ waiting: 0, working: 1, finished: 0, top: undefined });
  });

  it('a stuck wait alone does not hold the tile: `isBusy` stays false', () => {
    expect(isBusy([session('s', 'waiting-input', [standby('stuck')])])).toBe(false);
  });
});
