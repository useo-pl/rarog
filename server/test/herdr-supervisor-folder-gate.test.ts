/**
 * Pane scope in the supervisor (`scopeOf` in `server/src/herdr/supervisor.ts`) while the folder gate keeps a guarded
 * folder of home that a root opens: scope ignores the state of the folder, so a pane there is in scope from the first
 * list after a restart, before the folder was ever checked, once it is open and while it is closed, a state change of
 * the folder never recomputes the scope of a known pane (no `changed scope` line, no re-attach), and a `cd` into a
 * closed folder keeps the pane in scope. The gate is a stand-in routed into the work-area disk port; home is a scratch
 * directory with the pane directories in it, so the walk passes the guarded folder and no real one is touched.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HERDR_RESYNC_MS } from '../src/config.ts';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import type { DecisionOutcome, SessionDriver } from '../src/drivers/types.ts';
import { routeWorkAreaDisk } from '../src/folder-gate/disk.ts';
import { gatedFolderOf } from '../src/folder-gate/folders.ts';
import type { FolderBlock, FolderClient, FolderGate, FolderState } from '../src/folder-gate/types.ts';
import { parseAgentList } from '../src/herdr/client.ts';
import { createHerdrSupervisor } from '../src/herdr/supervisor.ts';
import type { HerdrSupervisorHandle, HerdrTransport } from '../src/herdr/supervisor.ts';
import type { HerdrStreamEvent } from '../src/herdr/socket.ts';
import type { HerdrAgentInfo, HerdrClient, HerdrLifecycleEvent } from '../src/herdr/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'shfg-')));
const DOCUMENTS = join(HOME, 'Documents');
const ROOTS = [HOME, DOCUMENTS];
const rawAgents = (JSON.parse(readFileSync(join(FIXTURES, 'agent-list.json'), 'utf8')) as {
  result: { agents: Record<string, unknown>[] };
}).result.agents;

/** A gate whose folder states the test sets; `set` tells the listeners as the real gate does. */
class StubGate implements FolderGate {
  readonly enabled = true;
  readonly #states = new Map<string, FolderState>();
  readonly #listeners = new Set<(folder: string, state: FolderState) => void>();

  stateOf(candidate: string): { folder: string; state: FolderState } | null {
    const folder = gatedFolderOf(candidate, HOME);
    return folder === null ? null : { folder, state: this.#states.get(folder) ?? 'unknown' };
  }

  report(): void {}

  check(folder: string): Promise<FolderState> {
    return Promise.resolve(this.#states.get(folder) ?? 'unknown');
  }

  blocked(): FolderBlock[] {
    return [];
  }

  onChange(listener: (folder: string, state: FolderState) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  set(folder: string, state: FolderState): void {
    this.#states.set(folder, state);
    for (const listener of [...this.#listeners]) listener(folder, state);
  }

  dispose(): void {}
}

/** The helper client is never asked: scope needs metadata only, which stays in the server process. */
const noHelper = new Proxy({}, {
  get: () => () => { throw new Error('the scope of a pane must not call a folder helper'); },
}) as unknown as FolderClient;

/** Timers fire only on `advance`. */
class FakeScheduler implements Scheduler {
  #now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.#seq += 1;
    this.#timers.set(this.#seq, { at: this.#now + ms, fn });
    return this.#seq;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].fn();
    }
    this.#now = target;
  }
}

const transport: HerdrTransport = {
  subscribe: () => ({ events: new AsyncEventQueue<HerdrStreamEvent>(), close: () => {} }),
  status: () => ({ available: true, readOnly: false, version: '0.8.2', protocol: 20 }),
  dispose: () => {},
};

/** Lists of `agent.list` the client answered. */
let lists = 0;

function clientOf(agents: () => HerdrAgentInfo[]): HerdrClient {
  const known: Record<string, unknown> = {
    listAgents: () => {
      lists += 1;
      return Promise.resolve(agents().map((agent) => ({ ...agent })));
    },
    getAgent: (paneId: string) => Promise.resolve({ ...agents().find((agent) => agent.paneId === paneId) }),
    readScreen: () => Promise.resolve({ text: '' }),
    readPaneHistory: () => Promise.resolve({ text: '', truncated: false }),
    ping: () => Promise.resolve({ version: '0.8.2', protocol: 20 }),
  };
  return new Proxy(known, {
    get: (target, key: string) => target[key] ?? (() => Promise.resolve()),
  }) as unknown as HerdrClient;
}

function driver(): SessionDriver {
  return {
    ownsProcess: false,
    events: new AsyncEventQueue(),
    send: () => {},
    respondPermission: () => Promise.resolve<DecisionOutcome>({ kind: 'applied' }),
    answerQuestion: () => Promise.resolve<DecisionOutcome>({ kind: 'applied' }),
    interrupt: () => Promise.resolve(true),
    dispose: () => {},
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
};

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

interface Run {
  readonly supervisor: HerdrSupervisorHandle;
  readonly scheduler: FakeScheduler;
  readonly seen: HerdrLifecycleEvent[];
  readonly lines: string[];
}

/**
 * A supervisor over panes in `cwds` with the gate routed in; waits for the first list. Each list reads `cwds` again,
 * so a test that replaces an entry moves that pane (`cd`) for the next resync.
 */
async function start(gate: StubGate, cwds: string[]): Promise<Run> {
  cleanups.push(routeWorkAreaDisk({ gate, client: noHelper, home: HOME }));
  const agents = (): HerdrAgentInfo[] => parseAgentList({
    agents: cwds.map((cwd, index) => ({ ...rawAgents[index], cwd, foreground_cwd: cwd })),
  });
  const scheduler = new FakeScheduler();
  const lines: string[] = [];
  const supervisor = createHerdrSupervisor(
    {
      socketPath: '/unused.sock', roots: ROOTS, yoloRoots: [], sendEnabled: true, dataDir: join(FIXTURES, 'unused'),
      home: HOME, logger: (line) => { lines.push(line); },
    },
    {
      createDriver: () => driver(), client: clientOf(agents), transport, scheduler,
      audit: { log: () => {}, flush: () => Promise.resolve() },
      hidden: {
        flush: () => Promise.resolve(),
        aliasFor: () => undefined, rememberAlias: () => Promise.resolve(),
        seenSeq: () => undefined, markSeen: () => Promise.resolve(), seenBy: () => undefined,
        unseenSeq: () => undefined, markUnseen: () => Promise.resolve(),
      },
    },
  );
  cleanups.push(() => { supervisor.dispose(); });
  const seen: HerdrLifecycleEvent[] = [];
  void (async () => {
    for await (const event of supervisor.events) seen.push(event);
  })();
  await supervisor.ready;
  await flush();
  return { supervisor, scheduler, seen, lines };
}

const appearedScope = (run: Run): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const event of run.seen) if (event.type === 'appeared') out[event.agent.cwd] = event.agent.inScope;
  return out;
};

describe('pane scope in a guarded folder a root opens', () => {
  const pane = join(DOCUMENTS, 'p');
  mkdirSync(pane, { recursive: true });

  it('after a restart, before any check of the folder, the pane is in scope from the first list', async () => {
    const run = await start(new StubGate(), [pane]);
    expect(appearedScope(run)).toEqual({ [pane]: true });
    expect(run.seen.filter((event) => event.type === 're-attached')).toEqual([]);
  });

  it('with consent given (folder open) the pane is in scope from the first list', async () => {
    const gate = new StubGate();
    gate.set(DOCUMENTS, 'open');
    const run = await start(gate, [pane]);
    expect(appearedScope(run)).toEqual({ [pane]: true });
  });

  it('open, waiting, open again: the scope of the known pane stays, no changed scope line, no re-attach', async () => {
    const gate = new StubGate();
    gate.set(DOCUMENTS, 'open');
    const run = await start(gate, [pane]);
    const key = run.seen.find((event) => event.type === 'appeared')?.agent.key ?? '';
    const before = lists;
    for (const state of ['waiting', 'open'] as const) {
      gate.set(DOCUMENTS, state);
      run.scheduler.advance(HERDR_RESYNC_MS);
      await flush();
      expect(run.supervisor.agentFor?.(key)?.inScope, state).toBe(true);
    }
    expect(lists - before).toBeGreaterThanOrEqual(2);
    expect(run.lines.filter((line) => line.includes('changed scope'))).toEqual([]);
    expect(run.seen.filter((event) => event.type === 're-attached' || event.type === 'gone')).toEqual([]);
  });

  it.each(['waiting', 'denied', 'unchecked'] as const)(
    'a pane discovered while the folder is %s is in scope from the first list', async (state) => {
      const gate = new StubGate();
      gate.set(DOCUMENTS, state);
      const run = await start(gate, [pane]);
      expect(appearedScope(run)).toEqual({ [pane]: true });
    },
  );

  it('a cd into the closed folder keeps the pane in scope: no changed scope line, no re-attach', async () => {
    const outside = join(HOME, 'q');
    mkdirSync(outside, { recursive: true });
    const gate = new StubGate();
    gate.set(DOCUMENTS, 'waiting');
    const cwds = [outside];
    const run = await start(gate, cwds);
    const key = run.seen.find((event) => event.type === 'appeared')?.agent.key ?? '';
    expect(run.supervisor.agentFor?.(key)?.inScope).toBe(true);
    cwds[0] = pane;
    run.scheduler.advance(HERDR_RESYNC_MS);
    await flush();
    expect(run.supervisor.agentFor?.(key)?.cwd).toBe(pane);
    expect(run.supervisor.agentFor?.(key)?.inScope).toBe(true);
    expect(run.lines.filter((line) => line.includes('changed scope'))).toEqual([]);
    expect(run.seen.filter((event) => event.type === 're-attached' || event.type === 'gone')).toEqual([]);
  });
});
