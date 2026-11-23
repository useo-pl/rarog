/**
 * Terminal PTY — złożenie ficzeru: start i TAKT odzyskiwania paneli.
 *
 * A 4 h tick that refreshed tokens only for registry entries with a resolved handle would do nothing
 * for a Rarog that started while herdr did not answer: its registry is EMPTY, so orphans after a herdr
 * restart would wait for a manual `POST`. This file holds the contract "the tick recovers and adopts
 * without any `POST`" on a real `createTermFeature`, with a herdr socket fake (`fake-term-herdr.ts`)
 * and a fake clock ONLY for `setInterval`.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERM_START_RETRY_MS, TERM_TOKEN_REFRESH_MS, loadConfig } from '../src/config.ts';
import { termPaneLabel, terminalTabLabel } from '../src/herdr/provenance.ts';
import type { Logger } from '../src/router.ts';
import { RAROG_TERM_TOKEN } from '../src/term/herdr-backend.ts';
import { createTermFeature } from '../src/term/index.ts';
import type { TermFeature } from '../src/term/index.ts';
import { termIdFor } from '../src/term/lifecycle.ts';
import { FakeController, FakeHerdr } from './fake-term-herdr.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function waitUntil(what: string, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`nie doczekano: ${what}`);
}

interface Harness {
  term: TermFeature;
  herdr: FakeHerdr;
  root: string;
  logs: string[];
  /** Gniazdo herdr „wraca" — do tej chwili fabryka klienta oddaje `null`. */
  connect(): void;
  /** Socket present but herdr does not answer: every `listPanes` rejects like `connect ENOENT`. */
  setDown(down: boolean): void;
  /** How many times the backend asked herdr for its panes. */
  listCalls(): number;
  /** Only the n-th `listPanes` call from now rejects (one flaky read inside an otherwise healthy pass). */
  failNthList(n: number): void;
}

async function start(opts: {
  connected: boolean; down?: boolean; env?: Readonly<Record<string, string>>;
}): Promise<Harness> {
  // Fałszywy zegar TYLKO dla taktu — `setTimeout`/`setImmediate` testu i atrap zostają prawdziwe.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-term-index-')));
  const config = loadConfig({
    RAROG_ORIGINS: 'https://rarog.example',
    RAROG_PROJECT_ROOTS: root,
    RAROG_TERM: '1',
    RAROG_HERDR_LAUNCH: '1',
    RAROG_HERDR_BIN: '/usr/bin/true',
    RAROG_DATA_DIR: join(root, '.dane'),
    HOME: root,
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
    ...opts.env,
  });
  const herdr = new FakeHerdr();
  let down = opts.down ?? false;
  let calls = 0;
  let failAt = -1;
  const listPanes = herdr.listPanes.bind(herdr);
  herdr.listPanes = () => {
    calls += 1;
    const flaky = calls === failAt;
    return down || flaky ? Promise.reject(new Error('connect ENOENT /fake/herdr.sock')) : listPanes();
  };
  let connected = opts.connected;
  const logs: string[] = [];
  const logger: Logger = {
    info: (message) => { logs.push(message); },
    error: (message) => { logs.push(message); },
  };
  const term = await createTermFeature(config, logger, {
    herdrLaunchClient: () => (connected ? herdr : null),
    herdrSpawn: () => new FakeController(),
  });
  if (term === null) throw new Error('createTermFeature oddało null mimo RAROG_TERM=1');
  await term.ready;
  cleanups.push(async () => {
    term.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    term, herdr, root, logs,
    connect: () => { connected = true; },
    setDown: (value) => { down = value; },
    listCalls: () => calls,
    failNthList: (n) => { failAt = calls + n; },
  };
}

describe('takt odzyskiwania terminali', () => {
  it('start bez herdr → herdr wraca → takt BEZ żadnego `POST` odzyskuje token i adoptuje', async () => {
    const h = await start({ connected: false });
    expect(h.term.list()).toEqual([]);

    // herdr wrócił po restarcie: panel terminala ma etykietę (snapshot), a token zginął.
    const id = termIdFor(h.root);
    h.herdr.addPane({
      paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', cwd: h.root, tokens: {},
      label: termPaneLabel(id),
    });
    h.connect();
    vi.advanceTimersByTime(TERM_TOKEN_REFRESH_MS);

    await waitUntil('adopcja z taktu', () => h.term.list().length === 1);
    expect(h.term.list()[0]).toMatchObject({ id, cwd: h.root, live: false, slot: 1, role: 'shell' });
    expect(h.herdr.pane('w1:p1')?.tokens).toEqual({ [RAROG_TERM_TOKEN]: id });
    // Żaden stempel nie niesie terminu ważności — TTL był powodem połowy sierot.
    expect(h.herdr.stamps.length).toBeGreaterThan(0);
    expect(h.herdr.stamps.every((stamp) => stamp.ttlMs === undefined)).toBe(true);
    expect(h.logs.some((line) => line.includes('recovery tick adopted 1'))).toBe(true);
  });

  /*
   * Start odzyskuje PRZED adopcją: bez tego sierota po restarcie herdr nie miałaby tokenu, więc
   * ani adopcja, ani żniwiarz by jej nie widzieli — a pierwszy `POST` założyłby tab obok.
   */
  it('start z herdr po restarcie: odzyskanie, potem adopcja — i panel z tokenem bez etykiety dostaje etykietę', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-term-index-')));
    const herdr = new FakeHerdr();
    const sierota = termIdFor(root, 2);
    const sprzed = termIdFor(root, 3);
    herdr.addPane({
      paneId: 'w1:p2', tabId: 'w1:t2', workspaceId: 'w1', cwd: root, tokens: {},
      label: termPaneLabel(sierota),
    });
    herdr.addPane({
      paneId: 'w1:p3', tabId: 'w1:t3', workspaceId: 'w1', cwd: root,
      tokens: { [RAROG_TERM_TOKEN]: sprzed }, label: null,
    });
    const config = loadConfig({
      RAROG_ORIGINS: 'https://rarog.example',
      RAROG_PROJECT_ROOTS: root, RAROG_TERM: '1', RAROG_HERDR_LAUNCH: '1', RAROG_HERDR_BIN: '/usr/bin/true',
      RAROG_DATA_DIR: join(root, '.dane'), HOME: root, PATH: '/usr/bin:/bin', TMPDIR: '/tmp',
    });
    const silent: Logger = { info: () => {}, error: () => {} };
    const term = await createTermFeature(config, silent, {
      herdrLaunchClient: () => herdr, herdrSpawn: () => new FakeController(),
    });
    if (term === null) throw new Error('createTermFeature oddało null mimo RAROG_TERM=1');
    cleanups.push(async () => {
      term.dispose();
      await rm(root, { recursive: true, force: true });
    });
    await term.ready;

    expect(term.list().map((entry) => entry.slot).sort()).toEqual([2, 3]);
    expect(herdr.pane('w1:p2')?.tokens).toEqual({ [RAROG_TERM_TOKEN]: sierota });
    expect(herdr.pane('w1:p3')?.label).toBe(termPaneLabel(sprzed, terminalTabLabel('shell', 3, root)));
  });
});

/** Lets the promise chains of a pass started by a fake timer finish (atrapy answer on microtasks). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
}

const RETRY_LINE = 'term: herdr unreachable at start, retrying recovery every 30 s';

describe('start while herdr is unreachable: retry every 30 s until herdr answers', () => {
  it('herdr down at start, back later: the retry adopts the survivor without any POST', async () => {
    const h = await start({ connected: true, down: true });
    expect(h.term.list()).toEqual([]);
    expect(h.logs).toContain(RETRY_LINE);

    const id = termIdFor(h.root);
    h.herdr.addPane({
      paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', cwd: h.root, tokens: {},
      label: termPaneLabel(id),
    });
    h.setDown(false);
    vi.advanceTimersByTime(TERM_START_RETRY_MS);

    await waitUntil('adoption from the start retry', () => h.term.list().length === 1);
    expect(h.term.list()[0]).toMatchObject({ id, cwd: h.root, slot: 1, role: 'shell' });
    expect(h.herdr.pane('w1:p1')?.tokens).toEqual({ [RAROG_TERM_TOKEN]: id });
    await waitUntil('success line', () => h.logs.some((line) => line.includes('start recovery adopted 1')));
  });

  it('after one successful retry the timer stops asking herdr', async () => {
    const h = await start({ connected: true, down: true });
    h.setDown(false);
    vi.advanceTimersByTime(TERM_START_RETRY_MS);
    await waitUntil('success line', () => h.logs.some((line) => line.includes('start recovery adopted 0')));
    await settle();
    const calls = h.listCalls();
    vi.advanceTimersByTime(2 * TERM_START_RETRY_MS);
    await settle();
    expect(h.listCalls()).toBe(calls);
  });

  it('pane recovery fails to read herdr inside a retry: the timer keeps going and the next retry adopts', async () => {
    const h = await start({ connected: true, down: true });
    const id = termIdFor(h.root);
    h.herdr.addPane({
      paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', cwd: h.root, tokens: {},
      label: termPaneLabel(id),
    });
    h.setDown(false);
    // Call 1 is the silent probe, call 2 the pane recovery read; reaper and adoption read fine afterwards.
    h.failNthList(2);
    vi.advanceTimersByTime(TERM_START_RETRY_MS);
    await settle();
    expect(h.term.list()).toEqual([]);
    expect(h.logs.some((line) => line.includes('start recovery adopted'))).toBe(false);

    vi.advanceTimersByTime(TERM_START_RETRY_MS);
    await waitUntil('adoption from the next retry', () => h.term.list().length === 1);
    expect(h.herdr.pane('w1:p1')?.tokens).toEqual({ [RAROG_TERM_TOKEN]: id });
  });

  it('a failed retry stays silent and the next one tries again', async () => {
    const h = await start({ connected: true, down: true });
    const linesAfterStart = h.logs.length;
    vi.advanceTimersByTime(TERM_START_RETRY_MS);
    await settle();
    expect(h.logs.slice(linesAfterStart)).toEqual([]);
    const calls = h.listCalls();
    vi.advanceTimersByTime(TERM_START_RETRY_MS);
    await settle();
    expect(h.listCalls()).toBeGreaterThan(calls);
    expect(h.logs.filter((line) => line === RETRY_LINE)).toHaveLength(1);
  });

  it('herdr answers at start: no retry timer at all', async () => {
    const h = await start({ connected: true });
    const calls = h.listCalls();
    expect(calls).toBeGreaterThan(0);
    vi.advanceTimersByTime(2 * TERM_START_RETRY_MS);
    await settle();
    expect(h.listCalls()).toBe(calls);
    expect(h.logs).not.toContain(RETRY_LINE);
  });

  it('backend refused by the killswitch: no retry loop, even with herdr down', async () => {
    const h = await start({ connected: true, down: true, env: { RAROG_HERDR_LAUNCH: '0' } });
    const calls = h.listCalls();
    vi.advanceTimersByTime(2 * TERM_START_RETRY_MS);
    await settle();
    expect(h.listCalls()).toBe(calls);
    expect(h.logs).not.toContain(RETRY_LINE);
  });

  it('dispose() while retrying: no further calls to herdr', async () => {
    const h = await start({ connected: true, down: true });
    expect(h.logs).toContain(RETRY_LINE);
    h.term.dispose();
    const calls = h.listCalls();
    h.setDown(false);
    vi.advanceTimersByTime(2 * TERM_START_RETRY_MS);
    await settle();
    expect(h.listCalls()).toBe(calls);
  });
});
