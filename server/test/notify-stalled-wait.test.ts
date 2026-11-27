/**
 * Delivery of the stalled wait alarm (`notify/stalled-wait.ts`): memory per wait, tries after `failed` and
 * `no-receiver`, presence, test sessions and cleanup. The edge itself is `stuckWaits` in `work.ts`
 * (`herdr-background-work.test.ts`); the list swap that feeds it is `conversation-lists.test.ts`. Here the waits are
 * built by hand and the clock and timers are a fake.
 */
import { describe, expect, it } from 'vitest';
import type { StuckWaits } from '../src/herdr/background/work.ts';
import type { PushContent, SendOutcome } from '../src/notify/content.ts';
import { PUSH_QUIET_LOG } from '../src/notify/index.ts';
import { STALLED_WAIT_WINDOW_MS, createStalledWaitAlert } from '../src/notify/stalled-wait.ts';
import type { StalledWaitFacts } from '../src/notify/stalled-wait.ts';

const MIN = 60_000;
const FACTS: StalledWaitFacts = { sessionId: 's1', project: 'atlas', label: 'tests', testSession: false };

/** Waits of one swap: `edge` on the edge, `stuck` at `stuck` (edge included), `listed` on the list in any stage. */
function waits(edge: readonly string[], stuck: readonly string[] = edge, listed: readonly string[] = stuck): StuckWaits {
  return {
    newly: edge.map((key) => ({ key, agentId: key, description: `agent ${key}` })),
    stuckKeys: [...stuck],
    waitKeys: [...listed],
  };
}

interface Try { readonly at: number; readonly content: PushContent }

/** The alarm on a fake clock; `send` answers from `outcomes` (then `delivered`), or waits for `release` when held. */
function rig(outcomes: SendOutcome[] = []) {
  let now = 0;
  let nextId = 1;
  let present = false;
  let hold = false;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const tries: Try[] = [];
  const logs: string[] = [];
  const held: (() => void)[] = [];
  const alert = createStalledWaitAlert({
    send: (content) => {
      tries.push({ at: now, content });
      const outcome = outcomes.shift() ?? 'delivered';
      if (!hold) return Promise.resolve(outcome);
      return new Promise((resolve) => { held.push(() => { resolve(outcome); }); });
    },
    presence: { active: () => present },
    badge: () => 3,
    log: (line) => { logs.push(line); },
    scheduler: {
      setTimeout: (fn, ms) => {
        timers.set(nextId, { at: now + ms, fn });
        return nextId++;
      },
      clearTimeout: (handle) => { timers.delete(handle as number); },
      now: () => now,
    },
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  };
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined || due[1].at > until) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = until;
  };
  return {
    alert, tries, logs, settle, advance,
    update: async (w: StuckWaits, facts: StalledWaitFacts = FACTS): Promise<void> => {
      alert.update(facts, w);
      await settle();
    },
    present: (value: boolean) => { present = value; },
    hold: (value: boolean) => { hold = value; },
    release: async (): Promise<void> => {
      for (const done of held.splice(0)) done();
      await settle();
    },
    /** The clock jumps by `ms` and only then the overdue timers fire (a suspended process). */
    late: async (ms: number): Promise<void> => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
        await settle();
      }
    },
    timers: () => timers.size,
    tryMinutes: () => tries.map((t) => t.at / MIN),
  };
}

describe('stalled wait alarm: one push per wait', () => {
  it('an edge sends at once: kind, session, badge, the first agent named, the alarm key', async () => {
    const r = rig();
    await r.update(waits(['k1', 'k2']));
    expect(r.tries).toHaveLength(1);
    const content = r.tries[0]?.content;
    expect(content).toMatchObject({ kind: 'stalled', sessionId: 's1', badge: 3 });
    expect(content?.bodyRef).toEqual({ code: 'push.detail.stalled', args: ['agent k1'] });
    expect(r.logs).toEqual(['push: stalled for atlas — APNs: SENT (try 1)']);
  });

  it('`stuck` on the next swaps and a clock set back (`stuck` → `long` → `stuck`) send nothing more', async () => {
    const r = rig();
    await r.update(waits(['k1']));
    await r.update(waits([], ['k1']));
    await r.update(waits([], [], ['k1']));
    await r.update(waits(['k1']));
    expect(r.tries).toHaveLength(1);
    expect(r.logs.at(-1)).toBe(`${PUSH_QUIET_LOG} atlas (stalled, this wait already had its alarm)`);
  });

  it('a wait that left the list and comes back with a new edge is a new wait', async () => {
    const r = rig();
    await r.update(waits(['k1']));
    await r.update(waits([], [], []));
    await r.update(waits(['k1']));
    expect(r.tries).toHaveLength(2);
  });

  it('the owner watching Rarog: no push, one log line, and no push later for the same wait', async () => {
    const r = rig();
    r.present(true);
    await r.update(waits(['k1']));
    r.present(false);
    await r.update(waits([], [], ['k1']));
    await r.update(waits(['k1']));
    expect(r.tries).toEqual([]);
    expect(r.logs[0]).toBe(`${PUSH_QUIET_LOG} atlas (stalled, you are watching Rarog)`);
  });

  it('a test session: no push, one log line', async () => {
    const r = rig();
    await r.update(waits(['k1']), { ...FACTS, testSession: true });
    expect(r.tries).toEqual([]);
    expect(r.logs).toEqual([`${PUSH_QUIET_LOG} atlas (stalled, test session in a temporary directory)`]);
  });
});

describe('stalled wait alarm: tries until delivered', () => {
  it('`failed`, then `delivered`: two tries a minute apart, then nothing', async () => {
    const r = rig(['failed', 'delivered']);
    await r.update(waits(['k1']));
    await r.advance(3 * 60 * MIN);
    expect(r.tryMinutes()).toEqual([0, 1]);
    expect(r.timers()).toBe(0);
  });

  it('`no-receiver` without end: tries at 0, 1, 6, 21, 36 and 51 min, then one log line and the end', async () => {
    const r = rig(Array<SendOutcome>(20).fill('no-receiver'));
    await r.update(waits(['k1']));
    await r.advance(5 * 60 * MIN);
    expect(r.tryMinutes()).toEqual([0, 1, 6, 21, 36, 51]);
    expect(r.logs.at(-1)).toBe('push: stalled for atlas — not delivered within 1 h, no more tries');
    expect(r.timers()).toBe(0);
  });

  it('a retry timer that fires after the window sends nothing', async () => {
    const r = rig(['failed']);
    await r.update(waits(['k1']));
    await r.late(STALLED_WAIT_WINDOW_MS + 1);
    expect(r.tries).toHaveLength(1);
    expect(r.logs.at(-1)).toBe('push: stalled for atlas — not delivered within 1 h, no more tries');
    expect(r.timers()).toBe(0);
  });

  it('a wait near the end of its window does not end the tries of a new wait in the same push', async () => {
    const r = rig(Array<SendOutcome>(20).fill('failed'));
    r.hold(true);
    await r.update(waits(['k1']));
    // During the first send k1 goes back to `long` (clock set back), so it may alarm again within its window.
    await r.update(waits([], [], ['k1']));
    await r.release();
    r.hold(false);
    await r.advance(59 * MIN);
    await r.update(waits(['k1', 'k2']));
    await r.advance(3 * 60 * MIN);
    // k1 ends at minute 60; k2 keeps its own hour from minute 59.
    expect(r.tryMinutes()).toEqual([0, 59, 60, 65, 80, 95, 110]);
    expect(r.timers()).toBe(0);
  });

  it('the wait ends before delivery: no more tries', async () => {
    const r = rig(['failed']);
    await r.update(waits(['k1']));
    await r.update(waits([], [], []));
    await r.advance(60 * MIN);
    expect(r.tries).toHaveLength(1);
    expect(r.timers()).toBe(0);
  });

  it('the owner comes back to the app before the retry: no more tries, one log line', async () => {
    const r = rig(['failed']);
    await r.update(waits(['k1']));
    r.present(true);
    await r.advance(60 * MIN);
    expect(r.tries).toHaveLength(1);
    expect(r.logs.at(-1)).toBe(`${PUSH_QUIET_LOG} atlas (stalled, you are watching Rarog, retry dropped)`);
  });

  it('`forget` (session removed, another conversation, driver detached) and `close`: no more tries', async () => {
    for (const end of ['forget', 'close'] as const) {
      const r = rig(['failed']);
      await r.update(waits(['k1']));
      if (end === 'forget') r.alert.forget('s1');
      else await r.alert.close();
      await r.advance(60 * MIN);
      expect(r.tries, end).toHaveLength(1);
      expect(r.timers(), end).toBe(0);
    }
  });

  it('a clock set back after `failed` keeps the 1 h window from the first edge', async () => {
    const r = rig(Array<SendOutcome>(20).fill('failed'));
    await r.update(waits(['k1']));
    await r.update(waits([], [], ['k1']));
    await r.advance(59 * MIN);
    await r.update(waits(['k1']));
    await r.advance(3 * 60 * MIN);
    expect(r.tryMinutes()).toEqual([0, 59]);
    await r.update(waits([], [], ['k1']));
    await r.update(waits(['k1']));
    expect(r.tries).toHaveLength(2);
    expect(r.logs.at(-1)).toBe(`${PUSH_QUIET_LOG} atlas (stalled, this wait already had its alarm)`);
  });

  it('a re-edge after the window of the first edge sends nothing', async () => {
    const r = rig(['failed']);
    await r.update(waits(['k1']));
    await r.update(waits([], [], ['k1']));
    await r.advance(STALLED_WAIT_WINDOW_MS);
    await r.update(waits(['k1']));
    expect(r.tries).toHaveLength(1);
    expect(r.logs.at(-1)).toBe(`${PUSH_QUIET_LOG} atlas (stalled, over 1 h since the first edge of this wait)`);
  });

  it('an outcome after its waits changed marks only the waits still in the push', async () => {
    const r = rig(['delivered', 'failed', 'delivered']);
    r.hold(true);
    await r.update(waits(['k1', 'k2']));
    // During the send: k1 goes back to `long` (clock set back), k3 crosses the threshold.
    await r.update(waits(['k3'], ['k2', 'k3'], ['k1', 'k2', 'k3']));
    expect(r.tries.map((t) => t.content.bodyRef?.args)).toEqual([['agent k1'], ['agent k3']]);
    r.hold(false);
    await r.release();
    // k3 failed: its own tries go on; `delivered` of the first push did not mark it.
    await r.advance(MIN);
    expect(r.tries.map((t) => t.content.bodyRef?.args)).toEqual([['agent k1'], ['agent k3'], ['agent k3']]);
    // k1 left that push before its outcome, so the outcome did not settle it: a new edge alarms.
    await r.update(waits(['k1'], ['k1', 'k2', 'k3'], ['k1', 'k2', 'k3']));
    expect(r.tries).toHaveLength(4);
    // k2 stayed in the delivered push: no second alarm.
    await r.update(waits([], ['k1', 'k3'], ['k1', 'k2', 'k3']));
    await r.update(waits(['k2'], ['k1', 'k2', 'k3'], ['k1', 'k2', 'k3']));
    expect(r.tries).toHaveLength(4);
  });

  it('a send that throws counts as `failed`', async () => {
    const logs: string[] = [];
    let calls = 0;
    const alert = createStalledWaitAlert({
      send: () => {
        calls += 1;
        return Promise.reject(new Error('socket'));
      },
      presence: { active: () => false },
      log: (line) => { logs.push(line); },
    });
    alert.update(FACTS, waits(['k1']));
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(calls).toBe(1);
    expect(logs).toEqual(['push: stalled for atlas — APNs: FAILED (try 1)']);
    await alert.close();
  });
});
