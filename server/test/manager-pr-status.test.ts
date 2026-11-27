/**
 * The PR list and its state on session cards (`sessions/pr-status-link.ts`, `bootstrap/pr-status.ts`).
 *
 * The verdict (`visiblePullRequests`) is pure: the owner's PRs of this conversation, the filter before the limit, the
 * title from GitHub. The rows that need the session manager run the real tracker over a test source on a manual
 * clock, with the port `bootstrap/pr-status.ts` builds:
 *
 * - facts from GitHub make a linked PR visible; a state change → `session-changed` only for the sessions that show it;
 * - no `gh`, not logged in, no client after a restart, no port (`RAROG_PR_STATUS=0`) → an empty list; facts already
 *   in memory count without a client;
 * - the same URL in two conversations: one facts query, a verdict per window;
 * - a changed `gh` login → the verdicts again, `session-changed` only where the list changed;
 * - `/clear` → the card loses the list; a verdict that comes after it brings nothing back, its facts stay;
 * - a session that leaves the manager, or a card replaced under the same id, leaves the tracker.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestState, ServerEvent, SessionPullRequest, SessionSummary } from '@rarog/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrStatusLink } from '../src/bootstrap/pr-status.ts';
import type { PrStatusLink } from '../src/bootstrap/pr-status.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import { NEW_URL_DELAY_MS, OPEN_REFRESH_MS, UNKNOWN_REFRESH_MS } from '../src/pr-status/index.ts';
import type { PrFacts, PrReadFailure, PrReadResult, PrRef, PrStateSource } from '../src/pr-status/index.ts';
import { applyInitEvent } from '../src/sessions/driver-events.ts';
import type { InitPort } from '../src/sessions/driver-events.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { PULL_REQUESTS_MAX, SessionPrStatus, visiblePullRequests } from '../src/sessions/pr-status-link.ts';
import type { Session } from '../src/sessions/session.ts';
import { FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';

const T0 = Date.parse('2026-11-12T18:00:00Z');
const OWNER = 'octo-owner';
const OTHER = 'someone-else';
/** The first entry of the test conversations; every PR of the tests is created after it unless a test says so. */
const WINDOW = '2026-11-12T09:00:00.000Z';
const urlOf = (n: number): string => `https://github.com/example/atlas/pull/${String(n)}`;
const URL_A = urlOf(7);
const URL_B = urlOf(8);
const ENGINE_1 = '11111111-1111-4111-8111-111111111111';
const ENGINE_2 = '22222222-2222-4222-8222-222222222222';
const ENGINE_3 = '33333333-3333-4333-8333-333333333333';
const ENGINE_4 = '44444444-4444-4444-8444-444444444444';

/** A linked PR as the reader gives it: the time of its first link entry, no title, no state. */
const pr = (url: string, createdAt = '2026-11-12T10:00:00.000Z'): SessionPullRequest => ({
  url, repo: 'example/atlas', number: Number(url.split('/').pop()), createdAt,
});

/** The driver event of a conversation that links `urls` and started at `windowStart`. */
const linked = (urls: readonly string[], windowStart = WINDOW): DriverEvent => ({
  type: 'pull-requests', pullRequests: urls.map((url) => pr(url)), windowStart,
});

/** What GitHub says: author, creation time (minutes after {@link WINDOW}) and title. */
const facts = (author: string, minutesAfterWindow: number, title?: string): PrFacts => ({
  author, createdAtMs: Date.parse(WINDOW) + minutesAfterWindow * 60_000, ...(title === undefined ? {} : { title }),
});

describe('visiblePullRequests: the owner\'s PRs of this conversation', () => {
  const know = (known: Record<string, PrFacts>) => (url: string): PrFacts | undefined => known[url];
  const verdict = (links: readonly SessionPullRequest[], known: Record<string, PrFacts>, viewer: string | null = OWNER,
    windowStart: string | null = WINDOW): SessionPullRequest[] =>
    visiblePullRequests({ linked: links, windowStart, viewer, factsOf: know(known) });

  it('author = login, created after the window start: listed with the link time and the GitHub title', () => {
    expect(verdict([pr(URL_A, '2026-11-12T11:00:00.000Z')], { [URL_A]: facts(OWNER, 30, 'Add CSV export') })).toEqual([
      { url: URL_A, repo: 'example/atlas', number: 7, createdAt: '2026-11-12T11:00:00.000Z', title: 'Add CSV export' },
    ]);
  });

  it('another author: not listed; created before the window start: not listed; created at it: listed', () => {
    expect(verdict([pr(URL_A)], { [URL_A]: facts(OTHER, 30) })).toEqual([]);
    expect(verdict([pr(URL_A)], { [URL_A]: facts(OWNER, -1) })).toEqual([]);
    expect(verdict([pr(URL_A)], { [URL_A]: facts(OWNER, 0) }).map((one) => one.url)).toEqual([URL_A]);
  });

  it('no facts, no login, or no window start: nothing listed', () => {
    expect(verdict([pr(URL_A)], {})).toEqual([]);
    expect(verdict([pr(URL_A)], { [URL_A]: facts(OWNER, 30) }, null)).toEqual([]);
    expect(verdict([pr(URL_A)], { [URL_A]: facts(OWNER, 30) }, OWNER, null)).toEqual([]);
  });

  it('25 newer PRs of someone else and 1 older own: the own one is listed (the filter comes before the limit)', () => {
    const others = Array.from({ length: 25 }, (_, n) => pr(urlOf(100 + n), `2026-11-12T12:${String(10 + n)}:00.000Z`));
    const own = pr(URL_A, '2026-11-12T10:00:00.000Z');
    const known = Object.fromEntries([...others.map((one) => [one.url, facts(OTHER, 30)]), [URL_A, facts(OWNER, 30)]]);
    expect(verdict([...others, own], known).map((one) => one.url)).toEqual([URL_A]);
  });

  it(`more than ${String(PULL_REQUESTS_MAX)} own PRs: the newest ${String(PULL_REQUESTS_MAX)}, newest first, in any input order`, () => {
    const own = Array.from({ length: 25 }, (_, n) => pr(urlOf(100 + n), `2026-11-12T12:${String(10 + n)}:00.000Z`));
    const known = Object.fromEntries(own.map((one) => [one.url, facts(OWNER, 30)]));
    const shuffled = [...own.filter((_, n) => n % 2 === 0), ...own.filter((_, n) => n % 2 === 1)];
    expect(verdict(shuffled, known).map((one) => one.number))
      .toEqual(Array.from({ length: PULL_REQUESTS_MAX }, (_, n) => 124 - n));
  });

  it('the title and the state come only from GitHub, never from the linked item', () => {
    const item = { ...pr(URL_A), title: 'from the conversation', state: 'merged' as const };
    expect(verdict([item], { [URL_A]: facts(OWNER, 30) })).toEqual([pr(URL_A)]);
  });
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

/**
 * GitHub as a map the test changes: states, facts (author, creation time, title) and the login. A URL without facts
 * answers an error (asked again later). Every read is recorded; `hold` keeps the next read open; `failure` fails it.
 */
class TestSource implements PrStateSource {
  readonly states = new Map<string, PullRequestState | null>();
  readonly prs = new Map<string, PrFacts>();
  viewer: string | null = OWNER;
  failure: Exclude<PrReadFailure, 'rate-limited'> | null = null;
  readonly reads: string[][] = [];
  #held: (() => void) | null = null;
  hold = false;

  read(prs: readonly PrRef[]): Promise<PrReadResult> {
    this.reads.push(prs.map((ref) => ref.url));
    const answer = (): PrReadResult => {
      if (this.failure !== null) return { ok: false, failure: this.failure };
      const titles = prs.flatMap((ref): [string, string][] => {
        const title = this.prs.get(ref.url)?.title;
        return title === undefined ? [] : [[ref.url, title]];
      });
      return {
        ok: true, states: new Map(prs.map((ref) => [ref.url, this.states.get(ref.url) ?? null])), titles: new Map(titles),
        facts: new Map(prs.map((ref) => {
          const known = this.prs.get(ref.url);
          return [ref.url, known === undefined || this.viewer === null ? { kind: 'error' } as const
            : { kind: 'found', author: known.author, createdAtMs: known.createdAtMs } as const];
        })),
        viewer: this.viewer,
      };
    };
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

describe('manager × PR list and status', () => {
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

  /** Manager with the tracker over `source`, a connected client (unless `connected: false`) and the panes given. */
  async function withPanes(source: TestSource, panes: Record<string, string>, connected = true): Promise<{
    manager: Manager; supervisor: FakeSupervisor; link: PrStatusLink; scheduler: ManualScheduler;
    ids: Record<string, string>;
  }> {
    const scheduler = new ManualScheduler();
    const link = createPrStatusLink({ source, scheduler, log: () => undefined });
    links.push(link);
    link.tracker.setClientConnected(connected);
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
  const urlsOf = (summary: SessionSummary | undefined): string[] | undefined =>
    summary?.pullRequests?.map((one) => one.url);

  it('facts make a linked PR visible; a state change sends `session-changed` only to the sessions that show it', async () => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 30, 'Add CSV export'));
    source.prs.set(URL_B, facts(OWNER, 20));
    source.states.set(URL_A, 'merged');
    const { manager, supervisor, scheduler, ids } = await withPanes(source, {
      'w9:p1': ENGINE_1, 'w9:p2': ENGINE_2, 'w9:p3': ENGINE_3,
    });
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    supervisor.driver('w9:p2').queue.push(linked([URL_A, URL_B]));
    supervisor.driver('w9:p3').queue.push(linked([URL_B]));
    await flush();
    // Nothing verified yet: the linked set alone shows nothing.
    expect(manager.get(ids['w9:p1'] ?? '')?.pullRequests).toBeUndefined();

    const listed = record(manager);
    await scheduler.tick(NEW_URL_DELAY_MS);
    expect(source.reads).toEqual([[URL_A, URL_B]]);
    expect(listed.map((summary) => summary.id).sort()).toEqual([ids['w9:p1'], ids['w9:p2'], ids['w9:p3']].sort());
    expect(manager.get(ids['w9:p2'] ?? '')?.pullRequests?.map((one) => [one.url, one.title]))
      .toEqual([[URL_B, undefined], [URL_A, 'Add CSV export']]);

    const frames = record(manager);
    await scheduler.tick(NEW_URL_DELAY_MS);
    // One state read for both URLs (A shown twice): B has no state, so only A changed.
    expect(source.reads.slice(1)).toEqual([[URL_A, URL_B]]);
    expect(frames.map((summary) => summary.id).sort()).toEqual([ids['w9:p1'], ids['w9:p2']].sort());
    expect(statesOf(frames.find((summary) => summary.id === ids['w9:p2']))).toEqual({ [URL_A]: 'merged', [URL_B]: undefined });
    // The state is not part of the session's state machine: no transition, no `seen`.
    expect(manager.get(ids['w9:p1'] ?? '')?.state).toBe(manager.get(ids['w9:p3'] ?? '')?.state);
  });

  it('the same state again sends no frame; the same linked set again sends none either', async () => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 30));
    source.states.set(URL_A, 'open');
    const { manager, supervisor, scheduler } = await withPanes(source, { 'w9:p1': ENGINE_1 });
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS * 2);
    expect(source.reads).toHaveLength(2);

    const frames = record(manager);
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    await flush();
    await scheduler.tick(OPEN_REFRESH_MS);
    expect(source.reads).toHaveLength(3);
    expect(frames).toEqual([]);
  });

  it('a PR joining the list: its frame carries the known states of the others; a merged PR is never asked again', async () => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 20));
    source.prs.set(URL_B, facts(OWNER, 30));
    source.states.set(URL_A, 'merged');
    const { manager, supervisor, scheduler, ids } = await withPanes(source, { 'w9:p1': ENGINE_1 });
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS * 2);
    expect(source.reads).toEqual([[URL_A], [URL_A]]);

    const frames = record(manager);
    supervisor.driver('w9:p1').queue.push(linked([URL_B, URL_A]));
    await flush();
    expect(frames).toEqual([]);
    await scheduler.tick(NEW_URL_DELAY_MS);
    expect(frames).toHaveLength(1);
    expect(statesOf(frames[0])).toEqual({ [URL_A]: 'merged', [URL_B]: undefined });
    expect(frames[0]?.id).toBe(ids['w9:p1']);

    await scheduler.tick(UNKNOWN_REFRESH_MS * 3);
    expect(source.reads.slice(2).flat()).not.toContain(URL_A);
    expect(source.reads.slice(2).flat()).toContain(URL_B);
  });

  it.each(['missing-gh', 'not-logged-in'] as const)('`%s`: the list stays empty', async (failure) => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 30));
    source.failure = failure;
    const { manager, supervisor, scheduler, ids } = await withPanes(source, { 'w9:p1': ENGINE_1 });
    const frames = record(manager);
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    await flush();
    await scheduler.tick(UNKNOWN_REFRESH_MS);
    expect(source.reads.length).toBeGreaterThan(0);
    expect(manager.get(ids['w9:p1'] ?? '')?.pullRequests).toBeUndefined();
    expect(frames).toEqual([]);
  });

  it('no client after a restart: no read and an empty list; facts already in memory count without a client', async () => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 30));
    const { manager, supervisor, scheduler, link, ids } = await withPanes(source, { 'w9:p1': ENGINE_1, 'w9:p2': ENGINE_2 }, false);
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    await flush();
    await scheduler.tick(UNKNOWN_REFRESH_MS);
    expect(source.reads).toEqual([]);
    expect(manager.get(ids['w9:p1'] ?? '')?.pullRequests).toBeUndefined();

    link.tracker.setClientConnected(true);
    await scheduler.tick(0);
    expect(urlsOf(manager.get(ids['w9:p1'] ?? ''))).toEqual([URL_A]);
    link.tracker.setClientConnected(false);
    supervisor.driver('w9:p2').queue.push(linked([URL_A]));
    await flush();
    expect(urlsOf(manager.get(ids['w9:p2'] ?? ''))).toEqual([URL_A]);
    expect(source.reads).toHaveLength(1);
  });

  it('without the port (`RAROG_PR_STATUS=0`) the list stays empty and no frame goes out', async () => {
    const { manager, supervisor } = await build();
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    const frames = record(manager);
    supervisor.driver('w9:p72').queue.push(linked([URL_A]));
    await flush();
    expect(manager.get(id)?.pullRequests).toBeUndefined();
    expect(frames).toEqual([]);
  });

  it('the same URL in two conversations with different windows: one facts query, a verdict per window', async () => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 30));
    const { manager, supervisor, scheduler, link, ids } = await withPanes(source, { 'w9:p1': ENGINE_1, 'w9:p2': ENGINE_2 });
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    supervisor.driver('w9:p2').queue.push(linked([URL_A], '2026-11-12T09:31:00.000Z'));
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS);
    expect(source.reads).toEqual([[URL_A]]);
    expect(link.port.factsOf(URL_A)).toEqual(facts(OWNER, 30));
    expect(urlsOf(manager.get(ids['w9:p1'] ?? ''))).toEqual([URL_A]);
    expect(manager.get(ids['w9:p2'] ?? '')?.pullRequests).toBeUndefined();
  });

  it('a changed `gh` login: the verdicts again, `session-changed` only where the list changed', async () => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 30));
    source.prs.set(URL_B, facts(OTHER, -60));
    source.states.set(URL_A, 'open');
    const { manager, supervisor, scheduler, link, ids } = await withPanes(source, { 'w9:p1': ENGINE_1, 'w9:p2': ENGINE_2 });
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    supervisor.driver('w9:p2').queue.push(linked([URL_B]));
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS * 2);
    expect(statesOf(manager.get(ids['w9:p1'] ?? ''))).toEqual({ [URL_A]: 'open' });

    const frames = record(manager);
    source.viewer = OTHER;
    await scheduler.tick(OPEN_REFRESH_MS);
    expect(link.port.viewerLogin()).toBe(OTHER);
    expect(frames.map((summary) => [summary.id, summary.pullRequests])).toEqual([[ids['w9:p1'], undefined]]);
    // The PR left every list, so it left the state map too.
    expect(link.port.stateOf(URL_A)).toBeUndefined();
  });

  it('`/clear`: the card loses the list in a frame; a verdict that comes after it brings nothing back', async () => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 20));
    source.prs.set(URL_B, facts(OWNER, 30));
    const { manager, supervisor, scheduler, link, ids } = await withPanes(source, { 'w9:p1': ENGINE_1 });
    const id = ids['w9:p1'] ?? '';
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS);
    supervisor.driver('w9:p1').queue.push(linked([URL_B, URL_A]));
    await flush();
    source.hold = true;
    await scheduler.tick(NEW_URL_DELAY_MS);
    expect(source.reads.slice(1)).toEqual([[URL_A, URL_B]]);

    const frames = record(manager);
    supervisor.driver('w9:p1').queue.push({ type: 'init', engineSessionId: ENGINE_4, model: 'claude-opus-5' });
    await flush();
    expect(frames.map((summary) => [summary.id, summary.pullRequests])).toEqual([[id, undefined]]);

    source.release();
    await flush();
    await scheduler.tick(UNKNOWN_REFRESH_MS);
    expect(frames).toHaveLength(1);
    expect(manager.get(id)?.pullRequests).toBeUndefined();
    expect(link.port.factsOf(URL_B)).toEqual(facts(OWNER, 30));
    expect(source.reads).toHaveLength(2);
  });

  it('a session that leaves the manager leaves the tracker', async () => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 30));
    source.states.set(URL_A, 'open');
    const { manager, supervisor, scheduler, link, ids } = await withPanes(source, { 'w9:p1': ENGINE_1 });
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS * 2);
    expect(link.tracker.stateOf(URL_A)).toBe('open');

    await manager.close(ids['w9:p1'] ?? '');
    await flush();
    expect(manager.get(ids['w9:p1'] ?? '')).toBeUndefined();
    expect(link.tracker.stateOf(URL_A)).toBeUndefined();
    await scheduler.tick(OPEN_REFRESH_MS * 2);
    expect(source.reads).toHaveLength(2);
  });

  it('a pane gone and a Codex pane under the same id: the old URLs leave the tracker', async () => {
    const source = new TestSource();
    source.prs.set(URL_A, facts(OWNER, 30));
    source.states.set(URL_A, 'open');
    const { manager, supervisor, scheduler, link, ids } = await withPanes(source, { 'w9:p1': ENGINE_1 });
    supervisor.driver('w9:p1').queue.push(linked([URL_A]));
    await flush();
    await scheduler.tick(NEW_URL_DELAY_MS * 2);
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
    expect(source.reads).toHaveLength(2);
  });

  it('`/clear` with links: the new conversation has neither the links nor the window of the previous one', () => {
    const session = {
      id: 'card-1', engine: 'claude', state: 'waiting-input', engineSessionId: ENGINE_2, emptyStart: false,
      ring: { lastSeq: 0 },
    } as unknown as Session;
    const status = new SessionPrStatus(undefined, { sessions: new Map(), emitSessionChanged: () => undefined });
    status.applyList(session, [pr(URL_A)], WINDOW);
    expect(session.pullRequestLinks?.map((one) => one.url)).toEqual([URL_A]);
    expect(session.pullRequestWindowStart).toBe(WINDOW);

    const port = {
      config: {}, customTitled: new WeakSet(), conversationChanged: () => undefined,
      indexEngineSession: () => undefined, applyTransition: () => false, emitSessionChanged: () => undefined,
      claimWindows: { holdBlocked: () => false, herdrMoved: () => undefined, conversationChanged: () => undefined },
    } as unknown as InitPort;
    applyInitEvent(session, { type: 'init', engineSessionId: ENGINE_3, model: 'claude-opus-5' }, port);
    expect(session.pullRequestLinks).toBeUndefined();
    expect(session.pullRequestWindowStart).toBeUndefined();
    expect(session.pullRequests).toBeUndefined();
  });
});
