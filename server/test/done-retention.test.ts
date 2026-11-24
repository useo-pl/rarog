/**
 * Closed cards have a cap (`done-retention.ts`): over it, the closed card with the oldest `lastActivityAt` leaves by
 * the Hide path with one fresh list to all phones. A card with a driver or a live pane, a `resumable` card and a card
 * whose restart is in progress stay and do not count. A forgotten card whose conversation has no other card tells
 * the consent cycle; a hidden live pane and a resume do not.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@rarog/shared';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { DONE_CARDS_MAX, doneCardsOver, forgetConversation } from '../src/sessions/done-retention.ts';
import type { RetainedCard } from '../src/sessions/done-retention.ts';
import type { FakeDeps } from './helpers/manager-herdr-atrapy.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';

const BASE = Date.parse('2026-11-20T10:00:00.000Z');
const engineOf = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const keyOf = (i: number): string => `w1:p${String(i)}`;

describe('closed cards over the cap (unit)', () => {
  const card = (i: number, over: Partial<RetainedCard> = {}): RetainedCard => ({
    id: `s${String(i)}`, state: 'done', driver: null, herdrKey: keyOf(i),
    lastActivityAt: new Date(BASE + i * 1_000).toISOString(), ...over,
  });
  const mapOf = (cards: RetainedCard[]): Map<string, RetainedCard> => new Map(cards.map((c) => [c.id, c]));

  it('101 closed cards with a cap of 100: the oldest `lastActivityAt` goes, not the first in the map', () => {
    const cards = Array.from({ length: DONE_CARDS_MAX + 1 }, (_, i) => card(i));
    cards[37] = card(37, { lastActivityAt: new Date(BASE - 3_600_000).toISOString() });
    expect(doneCardsOver(mapOf(cards), new Map(), new Map()).map((c) => c.id)).toEqual(['s37']);
    expect(doneCardsOver(mapOf(cards.slice(1)), new Map(), new Map())).toEqual([]);
  });

  it('a card with a driver, a live pane, a restart in progress or `resumable` neither goes nor counts', () => {
    const closed = Array.from({ length: DONE_CARDS_MAX }, (_, i) => card(i + 10));
    const kept = [
      card(1, { driver: {} as RetainedCard['driver'], lastActivityAt: new Date(BASE - 9_000).toISOString() }),
      card(2, { lastActivityAt: new Date(BASE - 8_000).toISOString() }),
      card(3, { lastActivityAt: new Date(BASE - 7_000).toISOString() }),
      card(4, { state: 'resumable', lastActivityAt: new Date(BASE - 6_000).toISOString() }),
    ];
    const herdrByKey = new Map([[keyOf(2), 's2']]);
    const restarts = new Map([['s3', {}]]);
    expect(doneCardsOver(mapOf([...kept, ...closed]), herdrByKey, restarts)).toEqual([]);
    const over = [...kept, ...closed, card(200)];
    expect(doneCardsOver(mapOf(over), herdrByKey, restarts).map((c) => c.id)).toEqual(['s10']);
  });

  it('a forgotten card tells the consent cycle only when no other card carries its conversation', () => {
    const told: string[] = [];
    const forgotten = (engine: string): void => { told.push(engine); };
    forgetConversation({ engineSessionId: engineOf(1) }, new Map([['x', { engineSessionId: engineOf(1) }]]), forgotten);
    forgetConversation({ engineSessionId: undefined }, new Map(), forgotten);
    forgetConversation({ engineSessionId: engineOf(2) }, new Map([['x', { engineSessionId: engineOf(1) }]]), forgotten);
    expect(told).toEqual([engineOf(2)]);
  });
});

describe('closed cards over the cap (manager)', () => {
  let dataDir: string;
  let clock = BASE;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-done-'));
    clock = BASE;
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function rig(overrides: Partial<ManagerConfig> = {}): Promise<{
    manager: Manager; supervisor: FakeSupervisor; told: string[]; deps: FakeDeps;
  }> {
    const supervisor = new FakeSupervisor();
    const deps = makeDeps();
    supervisors.push(supervisor);
    const told: string[] = [];
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [PROJECT], herdrSend: true,
      now: () => clock, consentForgotten: (engine: string) => { told.push(engine); }, ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    return { manager, supervisor, told, deps };
  }

  /** A pane appears and its card gets an id; the pane is the `i`-th of the scenario. */
  async function appear(manager: Manager, supervisor: FakeSupervisor, i: number): Promise<string> {
    supervisor.appear(makeAgent({ key: keyOf(i), paneId: keyOf(i), agentSessionId: engineOf(i), tabId: `w1:t${String(i)}` }));
    await flush();
    const id = manager.list().find((s) => s.paneId === keyOf(i))?.id;
    expect(id).toBeDefined();
    return id ?? '';
  }

  async function gone(supervisor: FakeSupervisor, i: number): Promise<void> {
    supervisor.live.delete(keyOf(i));
    supervisor.emit({ type: 'gone', key: keyOf(i) });
    await flush();
  }

  function snapshots(manager: Manager): ServerEvent[] {
    const out: ServerEvent[] = [];
    manager.onEvent((scope, _seq, event) => {
      if (scope === 'global' && event.type === 'sessions-snapshot') out.push(event);
    });
    return out;
  }

  it('the 101st closed card forgets the one with the oldest activity, with one list to the phones', async () => {
    const { manager, supervisor, told } = await rig();
    const ids: string[] = [];
    for (let i = 0; i < DONE_CARDS_MAX; i += 1) {
      ids.push(await appear(manager, supervisor, i));
      clock = i === 37 ? BASE - 3_600_000 : BASE + i * 1_000;
      await gone(supervisor, i);
    }
    expect(manager.list().filter((s) => s.state === 'done')).toHaveLength(DONE_CARDS_MAX);
    const live = await appear(manager, supervisor, 500);
    ids.push(await appear(manager, supervisor, DONE_CARDS_MAX));
    clock = BASE + 1_000_000;
    const lists = snapshots(manager);
    await gone(supervisor, DONE_CARDS_MAX);

    expect(lists).toHaveLength(1);
    expect(manager.get(ids[37] ?? '')).toBeUndefined();
    const listed = (lists[0] as Extract<ServerEvent, { type: 'sessions-snapshot' }>).sessions.map((s) => s.id);
    expect(listed).not.toContain(ids[37]);
    expect(listed).toContain(live);
    expect(manager.list().filter((s) => s.state === 'done')).toHaveLength(DONE_CARDS_MAX);
    expect(manager.get(live)?.state).not.toBe('done');
    expect(told).toEqual([engineOf(37)]);
  });

  it('a closed card within the cap resumes under the same id, and the resume tells the consent cycle nothing',
    async () => {
      const { manager, supervisor, told, deps } = await rig();
      deps.transcripts.set(engineOf(1), '/store/atlas.jsonl');
      const id = await appear(manager, supervisor, 1);
      await gone(supervisor, 1);
      expect(manager.get(id)?.state).toBe('done');

      const resumed = await manager.resume(id);

      expect(resumed.id).toBe(id);
      expect(supervisor.launches[0]).toMatchObject({ resumeFrom: engineOf(1) });
      expect(told).toEqual([]);
    });

  it('hiding a live pane tells the consent cycle nothing; hiding a closed card does', async () => {
    const { manager, supervisor, told } = await rig();
    const live = await appear(manager, supervisor, 1);
    await manager.close(live);
    expect(manager.get(live)).toBeUndefined();
    expect(told).toEqual([]);

    const closed = await appear(manager, supervisor, 2);
    await gone(supervisor, 2);
    await manager.close(closed);
    expect(told).toEqual([engineOf(2)]);
  });
});
