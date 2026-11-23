/**
 * Clocks of the activity row (`server/src/sessions/activity-clocks.ts`): the turn start on the session summary
 * (`turnSince`) and the age of the held activity in summaries and transcript snapshots (`elapsedSeconds`).
 *
 * The wire behaviour runs through the manager on the shared supervisor and driver fakes
 * (`helpers/manager-herdr-atrapy.ts`) with a fake clock; edges with no wiring of their own run on a bare `Session`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionState } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { heldActivity, holdActivity, stampState } from '../src/sessions/activity-clocks.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';

const T0 = Date.parse('2026-11-16T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('activity row clocks through the manager', () => {
  let dataDir: string;
  let clock: number;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-clocks-'));
    clock = T0;
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Manager on a fake clock with one idle herdr pane; `push` feeds that pane's driver. */
  async function withIdlePane(): Promise<{
    manager: Manager; id: string; push: (...events: DriverEvent[]) => Promise<void>;
  }> {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      herdrSupervisor: supervisor,
      herdrDeps: makeDeps(),
      herdrRoots: [PROJECT],
      herdrSend: true,
      now: () => clock,
    });
    managers.push(manager);
    await manager.ready;
    const agent = makeAgent();
    supervisor.appear(agent);
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(manager.get(id)?.state).toBe('waiting-input');
    const push = async (...events: DriverEvent[]): Promise<void> => {
      const driver = supervisor.drivers.get(agent.key);
      if (driver === undefined) throw new Error('the pane has no driver');
      for (const event of events) driver.queue.push(event);
      await flush();
    };
    return { manager, id, push };
  }

  it('turnSince starts with the turn, survives a permission inside it and goes with its end', async () => {
    const { manager, id, push } = await withIdlePane();
    expect(manager.get(id)).not.toHaveProperty('turnSince');

    clock = T0 + 5_000;
    await push({ type: 'agent-state', state: 'working' });
    expect(manager.get(id)).toMatchObject({ state: 'running', stateSince: iso(T0 + 5_000), turnSince: iso(T0 + 5_000) });

    clock = T0 + 20_000;
    await push({ type: 'agent-state', state: 'blocked' });
    expect(manager.get(id)).toMatchObject({
      state: 'waiting-permission', stateSince: iso(T0 + 20_000), turnSince: iso(T0 + 5_000),
    });

    clock = T0 + 30_000;
    await push({ type: 'agent-state', state: 'working' });
    expect(manager.get(id)).toMatchObject({ state: 'running', stateSince: iso(T0 + 30_000), turnSince: iso(T0 + 5_000) });

    clock = T0 + 40_000;
    await push({ type: 'agent-state', state: 'idle' });
    expect(manager.get(id)?.state).toBe('waiting-input');
    expect(manager.get(id)).not.toHaveProperty('turnSince');

    clock = T0 + 90_000;
    await push({ type: 'agent-state', state: 'working' });
    expect(manager.get(id)).toMatchObject({ state: 'running', turnSince: iso(T0 + 90_000) });
  });

  it('a history read that moves stateSince back moves the turn start with it', async () => {
    const { manager, id, push } = await withIdlePane();
    clock = T0 + 60_000;
    await push({ type: 'agent-state', state: 'working' });
    expect(manager.get(id)?.turnSince).toBe(iso(T0 + 60_000));

    await push({
      type: 'history',
      messages: [{ role: 'user', blocks: [{ type: 'text', text: foreign('go') }], at: iso(T0 + 58_500) }],
    });
    expect(manager.get(id)).toMatchObject({ stateSince: iso(T0 + 58_500), turnSince: iso(T0 + 58_500) });
  });

  it('the summary and the transcript snapshot carry the age of the held activity', async () => {
    const { manager, id, push } = await withIdlePane();
    await push({ type: 'agent-state', state: 'working' });

    clock = T0 + 1_000;
    await push({ type: 'activity', kind: 'tool', toolName: 'Bash', summary: 'pnpm test' });
    clock = T0 + 71_000;
    expect(manager.get(id)?.activity).toEqual({ kind: 'tool', toolName: 'Bash', summary: 'pnpm test', elapsedSeconds: 70 });
    expect(manager.transcript(id).activity?.elapsedSeconds).toBe(70);

    // The session pulse already says how long the file was quiet: the age adds to it.
    await push({ type: 'activity', kind: 'thinking', elapsedSeconds: 12 });
    clock = T0 + 141_000;
    expect(manager.get(id)?.activity).toEqual({ kind: 'thinking', elapsedSeconds: 82 });
    expect(manager.transcript(id).activity?.elapsedSeconds).toBe(82);
  });
});

describe('activity row clocks on one session', () => {
  function session(state: SessionState, stateSince: string): Session {
    return new Session({
      id: 's1', cwd: PROJECT, title: 'atlas', state, stateSince, createdAt: stateSince, lastActivityAt: stateSince,
    });
  }

  function move(target: Session, next: SessionState, at: string): void {
    const from = target.state;
    target.state = next;
    stampState(target, from, at);
  }

  it('a session first seen inside a turn counts the turn from the state it was first seen in', () => {
    const adopted = session('running', iso(T0));
    expect(adopted.summary()).not.toHaveProperty('turnSince');

    move(adopted, 'waiting-permission', iso(T0 + 30_000));
    expect(adopted.summary()).toMatchObject({ stateSince: iso(T0 + 30_000), turnSince: iso(T0) });
    move(adopted, 'running', iso(T0 + 40_000));
    expect(adopted.summary().turnSince).toBe(iso(T0));
  });

  it('an activity younger than a second and a clock behind the activity leave it as sent', () => {
    const working = session('running', iso(T0));
    holdActivity(working, { kind: 'tool', toolName: 'Read' }, T0);
    expect(heldActivity(working, T0 + 999)).toEqual({ kind: 'tool', toolName: 'Read' });
    expect(heldActivity(working, T0 - 5_000)).toEqual({ kind: 'tool', toolName: 'Read' });

    holdActivity(working, { kind: 'thinking', elapsedSeconds: 12 }, T0);
    expect(heldActivity(working, T0 - 5_000)).toEqual({ kind: 'thinking', elapsedSeconds: 12 });
  });
});
