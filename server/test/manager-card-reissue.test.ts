/**
 * A consent card the driver publishes again under the same `reqId` (the emergency approve button that comes later or
 * goes, `drivers/herdr/screen-fallback.ts`): the manager drops the old card on `permission-cleared` and takes the new
 * one as it is, so the approve button follows the latest card and `allow` reaches the driver only when it stands.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DriverEvent } from '../src/drivers/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';
import type { FakeHerdrDriver } from './helpers/manager-herdr-atrapy.ts';

let dataDir = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-reissue-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(dataDir, { recursive: true, force: true });
});

async function build(): Promise<{
  manager: Manager; driver: FakeHerdrDriver; id: string; feed: (...events: DriverEvent[]) => Promise<void>;
}> {
  const supervisor = new FakeSupervisor();
  const manager = await createManager({
    demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
    gitWatcher: null, liveSessionsReader: () => Promise.resolve(null), herdrSupervisor: supervisor,
    herdrDeps: makeDeps(), herdrRoots: [PROJECT], herdrSend: true,
  });
  closers.push(async () => {
    await manager.dispose();
    supervisor.dispose();
  });
  await manager.ready;
  const agent = makeAgent();
  supervisor.appear(agent);
  await flush();
  const id = manager.list().find((s) => s.paneId === agent.paneId)?.id ?? '';
  expect(id).not.toBe('');
  const driver = supervisor.driver(agent.key);
  return {
    manager, driver, id,
    feed: async (...events) => {
      for (const event of events) driver.queue.push(event);
      await flush();
    },
  };
}

const CARD = {
  type: 'permission-request', reqId: 'toolu_1', toolName: 'Bash', input: { command: 'npm test' },
  displayText: 'npm test',
} as const;

const decisions = (driver: FakeHerdrDriver): string[] => driver.calls
  .flatMap((call) => (call.method === 'respondPermission' ? [`${call.reqId}:${call.decision}`] : []));

describe('a consent card published again under the same reqId', () => {
  it('the approve button that comes later: `allow` goes to the driver only on the card with the button', async () => {
    const { manager, driver, id, feed } = await build();
    await feed({ ...CARD, canAllow: false });
    expect(manager.transcript(id).pendingPermissions.map((p) => p.canAllow)).toEqual([false]);
    await expect(manager.resolvePermission(id, 'toolu_1', 'allow', 'iPhone')).rejects.toThrow();
    expect(decisions(driver)).toEqual([]);

    await feed({ type: 'permission-cleared', reqId: 'toolu_1', reason: 'screen fallback' }, { ...CARD });
    expect(manager.transcript(id).pendingPermissions.map((p) => [p.permId, p.canAllow])).toEqual([['toolu_1', true]]);
    await expect(manager.resolvePermission(id, 'toolu_1', 'allow', 'iPhone')).resolves.toEqual({ outcome: 'ok' });
    expect(decisions(driver)).toEqual(['toolu_1:allow']);
  });

  it('the approve button that goes: `allow` no longer reaches the driver', async () => {
    const { manager, driver, id, feed } = await build();
    await feed({ ...CARD });
    await feed({ type: 'permission-cleared', reqId: 'toolu_1', reason: 'screen fallback' }, { ...CARD, canAllow: false });
    expect(manager.transcript(id).pendingPermissions.map((p) => [p.permId, p.canAllow])).toEqual([['toolu_1', false]]);
    await expect(manager.resolvePermission(id, 'toolu_1', 'allow', 'iPhone')).rejects.toThrow();
    expect(decisions(driver)).toEqual([]);
  });
});
