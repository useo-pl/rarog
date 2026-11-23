/**
 * PR status on session cards (`sessions/pr-status-link.ts`, `bootstrap/pr-status.ts`): the rows of the server case
 * table that need the session manager. The tracker is real, its state source is a test source, and its timers run on
 * a manual clock; the manager gets the port `bootstrap/pr-status.ts` builds.
 *
 * - a state change → `session-changed` for every current session that lists the URL, and only for them;
 * - the same state → no frame;
 * - the driver pays the list out again → the known states in that same frame, no query about a merged PR;
 * - `/clear` during a query → the result does not bring the old list back;
 * - a session that leaves the manager leaves the tracker;
 * - a card replaced under the same id (a pane gone, a Codex pane on the same key) → the old URLs leave the tracker;
 * - no port (`RAROG_PR_STATUS=0`) → no `state` on the wire, even when an event carried one.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestState, ServerEvent, SessionPullRequest, SessionSummary } from '@rarog/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrStatusLink } from '../src/bootstrap/pr-status.ts';
import type { PrStatusLink } from '../src/bootstrap/pr-status.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import { NEW_URL_DELAY_MS, OPEN_REFRESH_MS, UNKNOWN_REFRESH_MS } from '../src/pr-status/index.ts';
import type { PrReadResult, PrRef, PrStateSource } from '../src/pr-status/index.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';

const T0 = Date.parse('2026-11-12T18:00:00Z');
const URL_A = 'https://github.com/acme/widget/pull/7';
const URL_B = 'https://github.com/acme/widget/pull/8';
const ENGINE_2 = '22222222-2222-4222-8222-222222222222';
const ENGINE_3 = '33333333-3333-4333-8333-333333333333';

const pr = (url: string, extra: Partial<SessionPullRequest> = {}): SessionPullRequest => ({
  url, repo: 'acme/widget', number: Number(url.split('/').pop()), createdAt: '2026-11-12T10:00:00.000Z', ...extra,
});

/** Timers fire only when the test moves the clock. */
class ManualScheduler implements Scheduler {
  t = T0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.#seq += 1;
    this.#timers.set(this.#seq, { at: this.t + Math.max(0, ms), fn });
    return this.#seq;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  now(): number {
    return this.t;
  }

  /** Moves the clock by `ms`, firing every timer due on the way and letting the reads settle. */
  async tick(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) next = entry;
      }
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

/** A source answering from a map that the test changes; every read is recorded; `hold` keeps the next read open. */
class TestSource implements PrStateSource {
  readonly states = new Map<string, PullRequestState | null>();
  readonly reads: string[][] = [];
  #held: (() => void) | null = null;
  hold = false;

  read(prs: readonly PrRef[]): Promise<PrReadResult> {
    this.reads.push(prs.map((ref) => ref.url));
    const answer = (): PrReadResult => ({
      ok: true, states: new Map(prs.map((ref) => [ref.url, this.states.get(ref.url) ?? null])),
    });
    if (!this.hold) return Promise.resolve(answer());
    this.hold = false;
    return new Promise((resolve) => { this.#held = () => { resolve(answer()); }; });
  }

  release(): void {
    const held = this.#held;
    this.#held = null;
    held?.();
  }
}

describe('manager × PR status', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];
  const links: PrStatusLink[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-pr-status-'));
  });

  afterEach(async () => {
    for (const link of links.splice(0)) link.tracker.close();
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function build(overrides: Partial<ManagerConfig> = {}): Promise<{ manager: Manager; supervisor: FakeSupervisor }> {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null, maxPanes: 6,
      herdrSupervisor: supervisor, herdrDeps: makeDeps(), herdrRoots: [PROJECT], herdrSend: true, ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    return { manager, supervisor };
  }

  /** Manager with the tracker over `source`, a connected client and the panes given (key → engine session). */
  async function withPanes(source: TestSource, panes: Record<string, string>): Promise<{
    manager: Manager; supervisor: FakeSupervisor; link: PrStatusLink; scheduler: ManualScheduler;
    ids: Record<string, string>;
  }> {
    const scheduler = new ManualScheduler();
    const link = createPrStatusLink({ source, scheduler, log: () => undefined });
    links.push(link);
    link.tracker.setClientConnected(true);
    const { manager, supervisor } = await build({ prStatus: link.port });
    const ids: Record<string, string> = {};
    for (const [key, engine] of Object.entries(panes)) {
      supervisor.appear(makeAgent({ key, paneId: key, agentSessionId: engine }));
      await flush();
      ids[key] = manager.list().find((s) => s.paneId === key)?.id ?? '';
      expect(ids[key]).not.toBe('');
      supervisor.driver(key).queue.push({ type: 'init', engineSessionId: engine, model: 'claude-opus-5' });
    }
    await flush();
    return { manager, supervisor, link, scheduler, ids };
  }

  function record(manager: Manager): SessionSummary[] {
    const out: SessionSummary[] = [];
    manager.onEvent((scope, _seq, event: ServerEvent) => {
      if (scope === 'global' && event.type === 'session-changed') out.push(event.session);
    });
    return out;
  }

  const statesOf = (summary: SessionSummary | undefined): Record<string, string | undefined> =>
    Object.fromEntries((summary?.pullRequests ?? []).map((one) => [one.url, one.state]));

  it('a state change sends `session-changed` to every current session that lists the URL, and only to them', async () => {
    const source = new TestSource();
    source.states.set(URL_A, 'merged');
    const { manager, supervisor, scheduler, ids } = await withPanes(source, {
      'w9:p1': '11111111-1111-4111-8111-111111111111', 'w9:p2': ENGINE_2, 'w9:p3': ENGINE_3,
    });
    supervisor.driver('w9:p1').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_A)] });
    supervisor.driver('w9:p2').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_A), pr(URL_B)] });
    supervisor.driver('w9:p3').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_B)] });
    await flush();
    expect(statesOf(manager.get(ids['w9:p1'] ?? ''))).toEqual({ [URL_A]: undefined });

    const frames = record(manager);
    await scheduler.tick(NEW_URL_DELAY_MS);
    // One read for both URLs (A listed twice): B has no state, so only A changed.
    expect(source.reads).toEqual([[URL_A, URL_B]]);
    expect(frames.map((summary) => summary.id).sort()).toEqual([ids['w9:p1'], ids['w9:p2']].sort());
    expect(statesOf(frames.find((summary) => summary.id === ids['w9:p2']))).toEqual({ [URL_A]: 'merged', [URL_B]: undefined });
    expect(statesOf(manager.get(ids['w9:p1'] ?? ''))).toEqual({ [URL_A]: 'merged' });
    // The state is not part of the session's state machine: no transition, no `seen`.
    expect(manager.get(ids['w9:p1'] ?? '')?.state).toBe(manager.get(ids['w9:p3'] ?? '')?.state);
  });

  it('the same state again sends no frame', async () => {
    const source = new TestSource();
    source.states.set(URL_A, 'open');
    const { manager, supervisor, scheduler } = await withPanes(source, { 'w9:p1': '11111111-1111-4111-8111-111111111111' });
    supervisor.driver('w9:p1').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_A)] });
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS);
    expect(source.reads).toHaveLength(1);

    const frames = record(manager);
    await scheduler.tick(OPEN_REFRESH_MS);
    expect(source.reads).toHaveLength(2);
    expect(frames).toEqual([]);
  });

  it('the driver paying the list out again carries the known states in that frame; a merged PR is never asked again', async () => {
    const source = new TestSource();
    source.states.set(URL_A, 'merged');
    const { manager, supervisor, scheduler, ids } = await withPanes(source, {
      'w9:p1': '11111111-1111-4111-8111-111111111111',
    });
    supervisor.driver('w9:p1').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_A)] });
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS);
    expect(source.reads).toEqual([[URL_A]]);

    const frames = record(manager);
    supervisor.driver('w9:p1').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_A), pr(URL_B)] });
    await flush();
    expect(frames).toHaveLength(1);
    expect(statesOf(frames[0])).toEqual({ [URL_A]: 'merged', [URL_B]: undefined });
    expect(frames[0]?.id).toBe(ids['w9:p1']);

    await scheduler.tick(UNKNOWN_REFRESH_MS * 3);
    expect(source.reads.slice(1).flat()).not.toContain(URL_A);
    expect(source.reads.slice(1).flat()).toContain(URL_B);
  });

  it('`/clear` during a query: the result does not bring the old list back', async () => {
    const source = new TestSource();
    source.states.set(URL_A, 'merged');
    const { manager, supervisor, scheduler, ids } = await withPanes(source, {
      'w9:p1': '11111111-1111-4111-8111-111111111111',
    });
    supervisor.driver('w9:p1').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_A)] });
    await flush();
    source.hold = true;
    await scheduler.tick(NEW_URL_DELAY_MS);
    expect(source.reads).toEqual([[URL_A]]);

    supervisor.driver('w9:p1').queue.push({
      type: 'init', engineSessionId: '44444444-4444-4444-8444-444444444444', model: 'claude-opus-5',
    });
    await flush();
    expect(manager.get(ids['w9:p1'] ?? '')?.pullRequests).toBeUndefined();

    const frames = record(manager);
    source.release();
    await flush();
    await scheduler.tick(UNKNOWN_REFRESH_MS);
    expect(frames).toEqual([]);
    expect(manager.get(ids['w9:p1'] ?? '')?.pullRequests).toBeUndefined();
    expect(source.reads).toHaveLength(1);
  });

  it('a session that leaves the manager leaves the tracker', async () => {
    const source = new TestSource();
    source.states.set(URL_A, 'open');
    const { manager, supervisor, scheduler, link, ids } = await withPanes(source, {
      'w9:p1': '11111111-1111-4111-8111-111111111111',
    });
    supervisor.driver('w9:p1').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_A)] });
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS);
    expect(link.tracker.stateOf(URL_A)).toBe('open');

    await manager.close(ids['w9:p1'] ?? '');
    await flush();
    expect(manager.get(ids['w9:p1'] ?? '')).toBeUndefined();
    expect(link.tracker.stateOf(URL_A)).toBeUndefined();
    await scheduler.tick(OPEN_REFRESH_MS * 2);
    expect(source.reads).toHaveLength(1);
  });

  it('a pane gone and a Codex pane under the same id: the old URLs leave the tracker', async () => {
    const source = new TestSource();
    source.states.set(URL_A, 'open');
    const { manager, supervisor, scheduler, link, ids } = await withPanes(source, {
      'w9:p1': '11111111-1111-4111-8111-111111111111',
    });
    supervisor.driver('w9:p1').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_A)] });
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS);
    expect(link.tracker.stateOf(URL_A)).toBe('open');

    supervisor.emit({ type: 'gone', key: 'w9:p1' });
    await flush();
    supervisor.appear(makeAgent({ key: 'w9:p1', paneId: 'w9:p1', engine: 'codex', agentSessionId: ENGINE_3 }));
    await flush();
    const id = ids['w9:p1'] ?? '';
    expect(manager.get(id)?.engine).toBe('codex');
    expect(manager.get(id)?.pullRequests).toBeUndefined();
    expect(link.tracker.stateOf(URL_A)).toBeUndefined();
    await scheduler.tick(OPEN_REFRESH_MS * 2);
    expect(source.reads).toHaveLength(1);
  });

  it('without the port (`RAROG_PR_STATUS=0`) no `state` goes out, even when the event carried one', async () => {
    const { manager, supervisor } = await build();
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    supervisor.driver('w9:p72').queue.push({ type: 'pull-requests', pullRequests: [pr(URL_A, { state: 'merged' })] });
    await flush();
    expect(manager.get(id)?.pullRequests).toEqual([pr(URL_A)]);
    expect(JSON.stringify(manager.list())).not.toContain('"state":"merged"');
  });
});
