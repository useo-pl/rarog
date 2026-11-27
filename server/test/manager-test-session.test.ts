/**
 * The manager passes the test session fact to the real scheduler: a herdr session whose working directory is a real
 * directory in `os.tmpdir()` ends a turn without arming "done", while the same turn in a project directory arms it.
 * Supervisor and driver are the fakes of `helpers/manager-herdr-atrapy.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foreign } from '@rarog/shared/sentences';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { Notifier, PUSH_QUIET_LOG, sessionLook } from '../src/notify/index.ts';
import { Presence } from '../src/notify/presence.ts';
import type { PushContent } from '../src/notify/content.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';

const typed = (value: string): DriverEvent => ({
  type: 'message', role: 'user', blocks: [{ type: 'text', text: foreign(value) }],
});
const working = (stateChangeSeq: number): DriverEvent => ({ type: 'agent-state', state: 'working', stateChangeSeq });
const idle = (stateChangeSeq: number): DriverEvent => ({ type: 'agent-state', state: 'idle', stateChangeSeq });

describe('manager: a session in a temporary directory ends turns without "done"', () => {
  let dataDir: string;
  let scratch: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-herdr-'));
    scratch = await mkdtemp(join(tmpdir(), 'rarog-test-session-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  /** A herdr session in `cwd` after one ordinary human turn; returns what the scheduler did with its end. */
  async function turnIn(cwd: string): Promise<{ logs: string[]; sent: PushContent[]; pending: number }> {
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
      setTimeout: (cb) => {
        const handle = nextTimer++;
        timers.set(handle, cb);
        return handle;
      },
      clearTimeout: (handle) => { timers.delete(handle as number); },
    });
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: cwd, name: 'proj' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: makeDeps(), herdrRoots: [cwd], herdrSend: true,
      notifier,
    });
    managers.push(manager);
    await manager.ready;
    managerRef = manager;
    supervisor.appear(makeAgent({ cwd }));
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(manager.get(id)?.state).toBe('waiting-input');
    logs.length = 0;
    for (const event of [typed('run the tests'), working(10), idle(11)]) {
      supervisor.driver('w9:p72').queue.push(event);
      await flush();
    }
    const pending = timers.size;
    for (const cb of [...timers.values()]) cb();
    await flush();
    return { logs, sent, pending };
  }

  it('working directory in os.tmpdir(): nothing armed, the quiet line, no push', async () => {
    const cwd = join(scratch, 'abc', 'proj');
    await mkdir(cwd, { recursive: true });
    const r = await turnIn(cwd);
    expect(r.pending).toBe(0);
    expect(r.logs.filter((line) => line.startsWith(`${PUSH_QUIET_LOG} `)))
      .toEqual([`${PUSH_QUIET_LOG} proj (done, test session in a temporary directory)`]);
    expect(r.sent).toEqual([]);
  });

  it('working directory in a project: the usual "done"', async () => {
    const r = await turnIn(PROJECT);
    expect(r.pending).toBe(1);
    expect(r.logs.some((line) => line.startsWith('push: armed done for '))).toBe(true);
    expect(r.sent.map((content) => content.kind)).toEqual(['done']);
  });
});
