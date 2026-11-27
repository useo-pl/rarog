/**
 * The manager and the stalled wait alarm (`ManagerConfig.stalledWait`): every task list of a herdr session reaches the
 * alarm with the session, and the roads that drop the session or its driver make the alarm forget it, so no try goes
 * out for a session that is gone. The alarm itself is `notify-stalled-wait.test.ts`; the list swap
 * `conversation-lists.test.ts`. Supervisor and driver are the fakes of `helpers/manager-herdr-atrapy.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackgroundTask } from '@rarog/shared';
import type { StuckWaits } from '../src/herdr/background/work.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';

const KEY = 'w9:p72';
const STANDBY = '2026-11-20T10:00:00.000Z';
const agent = (stage: 'long' | 'stuck'): BackgroundTask => ({
  id: 'a7', kind: 'agent', description: 'Final tests', waitingSince: STANDBY,
  ownTasks: [{ id: 'b0000007', command: 'until false; do sleep 30; done' }], ownCommandWait: stage,
});

describe('manager: the stalled wait alarm gets every list and forgets a session that is gone', () => {
  let dataDir: string;
  let manager: Manager | undefined;
  let supervisor: FakeSupervisor | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-stalled-'));
  });

  afterEach(async () => {
    await manager?.dispose();
    supervisor?.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function start() {
    const lists: { sessionId: string; waits: StuckWaits }[] = [];
    const forgotten: string[] = [];
    supervisor = new FakeSupervisor();
    manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: makeDeps(), herdrRoots: [PROJECT], herdrSend: true,
      stalledWait: {
        stuckWaits: (session, waits) => { lists.push({ sessionId: session.id, waits }); },
        forget: (sessionId) => { forgotten.push(sessionId); },
      },
    });
    await manager.ready;
    supervisor.appear(makeAgent({ cwd: PROJECT }));
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    return { lists, forgotten, id, fake: supervisor };
  }

  it('a task list with a wait crossing into `stuck` reaches the alarm as an edge of that session', async () => {
    const { lists, id, fake } = await start();
    fake.driver(KEY).queue.push({ type: 'background-tasks', tasks: [agent('long')] });
    await flush();
    fake.driver(KEY).queue.push({ type: 'background-tasks', tasks: [agent('stuck')] });
    await flush();
    expect(lists.map((l) => [l.sessionId, l.waits.newly.length])).toEqual([[id, 0], [id, 1]]);
  });

  it('a driver swap (`re-attached`) and the pane gone make the alarm forget the session', async () => {
    const { forgotten, id, fake } = await start();
    expect(forgotten).toEqual([]);
    fake.emit({ type: 're-attached', agent: makeAgent({ cwd: PROJECT }) });
    await flush();
    expect(forgotten).toContain(id);
    forgotten.length = 0;
    fake.emit({ type: 'gone', key: KEY });
    await flush();
    expect(forgotten).toContain(id);
  });
});
