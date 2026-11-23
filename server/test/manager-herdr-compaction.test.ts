/**
 * A turn started by a context compaction alone through the manager, on supervisor and driver fakes, with the
 * real notification scheduler.
 *
 * Claude Code compacts an idle conversation before the prompt cache expires: herdr shows `idle → working → idle`,
 * and the only turn input in the file is the compaction boundary (`turn-input` of kind compaction from the
 * follower). Such a turn has no result: no `done` push, and a received previous result stays received.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foreign } from '@rarog/shared/sentences';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { Notifier, PUSH_QUIET_LOG, sessionLook } from '../src/notify/index.ts';
import { FIRST_CHECK_MS } from '../src/notify/policy.ts';
import { Presence } from '../src/notify/presence.ts';
import type { PushContent } from '../src/notify/content.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';

const COMPACTION: DriverEvent = { type: 'turn-input', kind: 'compaction' };
const typed = (value: string): DriverEvent => ({
  type: 'message', role: 'user', blocks: [{ type: 'text', text: foreign(value) }],
});
const working = (stateChangeSeq: number): DriverEvent => ({ type: 'agent-state', state: 'working', stateChangeSeq });
const idle = (stateChangeSeq: number): DriverEvent => ({ type: 'agent-state', state: 'idle', stateChangeSeq });

describe('turn after a context compaction alone', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-herdr-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  interface Rig {
    manager: Manager; id: string; sent: PushContent[]; logs: string[];
    feed(...events: DriverEvent[]): Promise<void>;
    /** Armed pushes waiting for their check. */
    pending(): number;
    /** Runs the checks of the armed pushes. */
    fire(): Promise<void>;
  }

  /**
   * A herdr session after one ordinary turn (the turn tally is complete only after a seen turn end); its `done`
   * push already went out, so the scenario starts with nothing armed and the result not received.
   */
  async function rig(): Promise<Rig> {
    const sent: PushContent[] = [];
    const logs: string[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    let managerRef: Manager | null = null;
    const notifier = new Notifier({
      presence: new Presence(),
      sink: { send: (content) => { sent.push(content); return Promise.resolve({ channels: { apns: 'delivered' } }); } },
      look: (sessionId) => sessionLook(managerRef?.get(sessionId)),
      log: (line) => { logs.push(line); },
      setTimeout: (cb, ms) => {
        expect(ms).toBe(FIRST_CHECK_MS.done);
        const handle = nextTimer++;
        timers.set(handle, cb);
        return handle;
      },
      clearTimeout: (handle) => { timers.delete(handle as number); },
    });
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: makeDeps(), herdrRoots: [PROJECT], herdrSend: true,
      notifier,
    });
    managers.push(manager);
    await manager.ready;
    managerRef = manager;
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    const fire = async (): Promise<void> => {
      const due = [...timers.values()];
      timers.clear();
      for (const cb of due) cb();
      await flush();
    };
    const feed = async (...events: DriverEvent[]): Promise<void> => {
      for (const event of events) {
        supervisor.driver('w9:p72').queue.push(event);
        await flush();
      }
    };
    expect(manager.get(id)?.state).toBe('waiting-input');
    await feed(typed('do it'), working(10), idle(11));
    await fire();
    expect(sent.map((content) => content.kind)).toEqual(['done']);
    sent.length = 0;
    logs.length = 0;
    return { manager, id, sent, logs, feed, pending: () => timers.size, fire };
  }

  it('received result, then a compaction alone: no `done` armed, quiet line in the log, the card stays received',
    async () => {
      const r = await rig();
      r.manager.markSeen(r.id);
      expect(r.manager.get(r.id)?.seen).toBe(true);

      await r.feed(working(12), COMPACTION, idle(13));
      expect(r.manager.get(r.id)?.state).toBe('waiting-input');
      expect(r.pending()).toBe(0);
      expect(r.logs.filter((line) => line.startsWith(PUSH_QUIET_LOG)
        && line.endsWith('(done, turn after a context compaction alone)'))).toHaveLength(1);
      expect(r.manager.get(r.id)?.seen).toBe(true);
    });

  /*
   * The silence rests on the missing tool call, and the call entry may reach the manager from the file only after
   * the turn end (`LATE_TOOL_CALL_MS`): the manager then hands the turn end to the scheduler again, with the tool.
   */
  it('received result, compaction alone, then a late tool call: the ordinary `done`, the receipt taken back',
    async () => {
      const r = await rig();
      r.manager.markSeen(r.id);
      await r.feed(working(12), COMPACTION, idle(13));
      expect(r.pending()).toBe(0);
      expect(r.manager.get(r.id)?.seen).toBe(true);

      await r.feed({
        type: 'message', role: 'assistant', blocks: [{ type: 'tool-call', toolName: 'Read', summary: 'a.ts' }],
      });
      expect(r.manager.get(r.id)?.seen).not.toBe(true);
      expect(r.pending()).toBe(1);
      await r.fire();
      expect(r.sent.map((content) => content.kind)).toEqual(['done']);
    });

  it('result not received, then a compaction alone: no push, the card stays unreceived', async () => {
    const r = await rig();
    await r.feed(working(12), COMPACTION, idle(13));
    await r.fire();
    expect(r.sent).toEqual([]);
    expect(r.manager.get(r.id)?.seen).not.toBe(true);
  });

  it('a human prompt and a compaction in one turn: the ordinary `done`', async () => {
    const r = await rig();
    r.manager.markSeen(r.id);
    await r.feed(typed('and now this'), working(12), COMPACTION, idle(13));
    expect(r.pending()).toBe(1);
    await r.fire();
    expect(r.sent.map((content) => content.kind)).toEqual(['done']);
    expect(r.manager.get(r.id)?.seen).not.toBe(true);
  });
});
