/**
 * Status recheck after a dialog answer (`server/src/herdr/answer-recheck.ts`) and the two supervisor spots it leans
 * on: a launched pane joins the event subscription at registration, and a failed status refresh leaves a log line.
 *
 * The card goes out with the `idle` push of `pane.agent_status_changed`. These tests run with a silent event stream,
 * so every `idle` the driver sees here comes from the recheck, not from a push.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foreign } from '@rarog/shared/sentences';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { DecisionOutcome, SessionDriver } from '../src/drivers/types.ts';
import { ANSWER_RECHECK_DELAYS_MS, createAnswerRecheck } from '../src/herdr/answer-recheck.ts';
import { parseAgentList } from '../src/herdr/client.ts';
import { TAKE_BACK_CLEAR_KEY, TAKE_BACK_UP_KEY } from '../src/herdr/dialogs/send/take-back-keys.ts';
import { TRUST_DOWN_KEY } from '../src/herdr/dialogs/send/trust-step.ts';
import type { HerdrSocketStatus, HerdrStreamEvent, HerdrSubscription, HerdrSubscriptionSpec } from '../src/herdr/socket.ts';
import { createHerdrSupervisor } from '../src/herdr/supervisor.ts';
import type { HerdrAttachContext, HerdrSupervisorHandle, HerdrTransport } from '../src/herdr/supervisor.ts';
import { HerdrGoneError } from '../src/herdr/types.ts';
import type {
  HerdrAgentInfo, HerdrAgentStatus, HerdrClient, HerdrLaunchClient, HerdrLauncher, HerdrLifecycleEvent,
  HerdrPaneEvent, HerdrScreen,
} from '../src/herdr/types.ts';
import { FakeHerdr } from './fake-term-herdr.ts';
import { VirtualScheduler } from './helpers/supervisor-tab-label-harness.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const rawAgents = (JSON.parse(
  readFileSync(join(FIXTURES, 'agent-list.json'), 'utf8'),
) as { result: { agents: Record<string, unknown>[] } }).result.agents;
const footerAuto = readFileSync(join(FIXTURES, 'footer-auto.txt'), 'utf8');

/** One agent of the live fixture, as the input filter passes it. */
function fixtureAgent(status: HerdrAgentStatus, seq: number): HerdrAgentInfo {
  const [info] = parseAgentList({ agents: [rawAgents[0]] });
  if (info === undefined) throw new Error('input filter rejected the fixture agent');
  return { ...info, status, stateChangeSeq: seq };
}

/** `agent.get` answers from {@link FakeClient.answer}; every call and every send is recorded. */
class FakeClient implements HerdrClient {
  answer: (paneId: string) => Promise<HerdrAgentInfo>;
  readonly gets: string[] = [];
  readonly sends: string[] = [];
  /** Sends reject with this error when set (herdr refused the keys). */
  sendError: Error | null = null;

  constructor(private readonly listed: HerdrAgentInfo[]) {
    this.answer = (paneId) => Promise.resolve({ ...this.find(paneId) });
  }

  private find(paneId: string): HerdrAgentInfo {
    const found = this.listed.find((agent) => agent.paneId === paneId);
    if (found === undefined) throw new HerdrGoneError(foreign(`no ${paneId}`));
    return found;
  }

  private sent(name: string): Promise<void> {
    this.sends.push(name);
    return this.sendError === null ? Promise.resolve() : Promise.reject(this.sendError);
  }

  listAgents(): Promise<HerdrAgentInfo[]> {
    return Promise.resolve(this.listed.map((agent) => ({ ...agent })));
  }

  getAgent(paneId: string): Promise<HerdrAgentInfo> {
    this.gets.push(paneId);
    return this.answer(paneId);
  }

  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: footerAuto }); }
  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ text: '', truncated: false });
  }
  prompt(): Promise<void> { return this.sent('prompt'); }
  sendKeys(): Promise<void> { return this.sent('sendKeys'); }
  sendFormSubmit(): Promise<void> { return this.sent('sendFormSubmit'); }
  sendModeCycle(): Promise<void> { return this.sent('sendModeCycle'); }
  sendTrustStep(): Promise<void> { return this.sent('sendTrustStep'); }
  sendDialogKey(): Promise<void> { return this.sent('sendDialogKey'); }
  sendTakeBackKey(): Promise<void> { return this.sent('sendTakeBackKey'); }
  pasteText(): Promise<void> { return this.sent('pasteText'); }
  sendPromptSubmit(): Promise<void> { return this.sent('sendPromptSubmit'); }
  focus(): Promise<void> { return Promise.resolve(); }
  ping(): Promise<{ version: string; protocol: number }> {
    return Promise.resolve({ version: '0.9.5', protocol: 20 });
  }
}

/** An event stream that never emits; it records every subscription the supervisor opens. */
class RecordingTransport implements HerdrTransport {
  readonly subscriptions: HerdrSubscriptionSpec[][] = [];
  /** Event queues of the opened streams, in order; a test pushes `connected` or frames into one. */
  readonly streams: AsyncEventQueue<HerdrStreamEvent>[] = [];

  subscribe(subs: readonly HerdrSubscriptionSpec[]): HerdrSubscription {
    this.subscriptions.push(subs.map((s) => ({ ...s })));
    const queue = new AsyncEventQueue<HerdrStreamEvent>();
    this.streams.push(queue);
    return { events: queue, close: (): void => { queue.close(); } };
  }

  current(): HerdrSubscriptionSpec[] {
    return this.subscriptions.at(-1) ?? [];
  }

  status(): HerdrSocketStatus {
    return { available: true, readOnly: false, version: '0.9.5', protocol: 20 };
  }

  dispose(): void {
    // nothing to release
  }
}

function noopDriver(): SessionDriver {
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

interface Setup {
  supervisor: HerdrSupervisorHandle;
  scheduler: VirtualScheduler;
  client: FakeClient;
  transport: RecordingTransport;
  logs: string[];
  contexts: HerdrAttachContext[];
  lifecycle: HerdrLifecycleEvent[];
}

const started: HerdrSupervisorHandle[] = [];

afterEach(() => {
  for (const supervisor of started.splice(0)) supervisor.dispose();
});

async function setup(
  agents: HerdrAgentInfo[], launcher?: HerdrLauncher, launchClient?: HerdrLaunchClient,
): Promise<Setup> {
  const scheduler = new VirtualScheduler();
  const client = new FakeClient(agents);
  const transport = new RecordingTransport();
  const logs: string[] = [];
  const contexts: HerdrAttachContext[] = [];
  const supervisor = createHerdrSupervisor(
    {
      socketPath: '/unused.sock',
      roots: ['/Users/u/Projects'],
      yoloRoots: [],
      sendEnabled: true,
      tabLabels: false,
      dataDir: join(FIXTURES, 'unused'),
      // Far from zero, so the post-send grace (`sentAt` 0) never applies here.
      now: () => 1_000_000 + scheduler.now(),
      logger: (line) => { logs.push(line); },
      ...(launcher === undefined ? {} : { launchEnabled: true }),
    },
    {
      createDriver: (ctx) => {
        contexts.push(ctx);
        return noopDriver();
      },
      client,
      transport,
      scheduler,
      ...(launcher === undefined ? {} : { launcher }),
      ...(launchClient === undefined ? {} : { launchClient }),
      audit: { log: () => {}, flush: () => Promise.resolve() },
      hidden: {
        flush: () => Promise.resolve(),
        aliasFor: () => undefined, rememberAlias: () => Promise.resolve(),
        seenSeq: () => undefined, markSeen: () => Promise.resolve(), seenBy: () => undefined,
        unseenSeq: () => undefined, markUnseen: () => Promise.resolve(),
      },
    },
  );
  started.push(supervisor);
  const lifecycle: HerdrLifecycleEvent[] = [];
  void (async () => {
    for await (const ev of supervisor.events) lifecycle.push(ev);
  })();
  await supervisor.ready;
  return { supervisor, scheduler, client, transport, logs, contexts, lifecycle };
}

/** Lets pending promise chains (`agent.get` → `applyInfo` → mode read) run to the end. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

/** A blocked fixture pane, attached, with the status events its driver receives. */
async function attachedBlocked(launchClient?: HerdrLaunchClient): Promise<Setup & {
  paneId: string; ctx: HerdrAttachContext; statuses: HerdrAgentStatus[];
}> {
  const blocked = fixtureAgent('blocked', 5);
  const s = await setup([blocked], undefined, launchClient);
  // A fixture pane's key is its pane id (`freshKey`).
  s.supervisor.attach(blocked.paneId);
  const ctx = s.contexts[0];
  if (ctx === undefined) throw new Error('no driver context');
  const statuses: HerdrAgentStatus[] = [];
  ctx.handle.subscribe((ev: HerdrPaneEvent) => {
    if (ev.type === 'status') statuses.push(ev.status);
  });
  s.client.gets.length = 0;
  return { ...s, paneId: blocked.paneId, ctx, statuses };
}

const idleNow = (paneId: string): HerdrAgentInfo => ({ ...fixtureAgent('idle', 6), paneId });

describe('answer recheck: delays', () => {
  it('rechecks at 1 s and 4 s after the answer', () => {
    expect(ANSWER_RECHECK_DELAYS_MS).toEqual([1_000, 4_000]);
  });
});

describe('answer recheck: the wrapped client sends what the driver sent', () => {
  const PANE = 'w9:p72';

  /** A client that records every call with its arguments and sends nothing. */
  function recordingClient(): { client: HerdrClient; calls: [string, unknown[]][] } {
    const calls: [string, unknown[]][] = [];
    const client = new Proxy({}, {
      get: (_target, name) => (...args: unknown[]): Promise<void> => {
        calls.push([String(name), args]);
        return Promise.resolve();
      },
    }) as HerdrClient;
    return { client, calls };
  }

  // The boundary guards of these five sends let the wrapper call them because it adds no key, pane or text of its own.
  it.each<[string, (client: HerdrClient) => Promise<void>, unknown[]]>([
    ['sendDialogKey', (c) => c.sendDialogKey(PANE, 'tab'), [PANE, 'tab']],
    ['sendTrustStep', (c) => c.sendTrustStep(PANE, TRUST_DOWN_KEY), [PANE, TRUST_DOWN_KEY]],
    ['pasteText', (c) => c.pasteText(PANE, 'a note'), [PANE, 'a note']],
    ['sendPromptSubmit', (c) => c.sendPromptSubmit(PANE), [PANE]],
    ['sendTakeBackKey', (c) => c.sendTakeBackKey(PANE, TAKE_BACK_CLEAR_KEY), [PANE, TAKE_BACK_CLEAR_KEY]],
  ])('%s reaches the client once, with the same arguments', async (name, send, args) => {
    const { client, calls } = recordingClient();
    const recheck = createAnswerRecheck({
      scheduler: new VirtualScheduler(), refresh: () => Promise.resolve(), log: () => undefined,
    });
    await send(recheck.wrap(client));
    recheck.dispose();
    expect(calls).toEqual([[name, args]]);
  });
});

describe('answer recheck: status after a dialog answer without a push', () => {
  it('sendTrustStep, herdr already idle, no push → the driver gets idle after 1000 ms', async () => {
    const s = await attachedBlocked();
    s.client.answer = (paneId) => Promise.resolve(idleNow(paneId));
    await s.ctx.client.sendTrustStep(s.paneId, 'enter');
    await flush();
    s.scheduler.advance(999);
    await flush();
    expect(s.statuses).toEqual([]);
    expect(s.client.gets).toEqual([]);
    s.scheduler.advance(1);
    await flush();
    expect(s.statuses).toEqual(['idle']);
  });

  it('still blocked at 1 s, idle at 4 s → idle arrives at 4 s; no recheck after that', async () => {
    const s = await attachedBlocked();
    let idle = false;
    s.client.answer = (paneId) => Promise.resolve(
      idle ? idleNow(paneId) : { ...fixtureAgent('blocked', 5), paneId },
    );
    await s.ctx.client.sendTrustStep(s.paneId, 'enter');
    s.scheduler.advance(1_000);
    await flush();
    expect(s.client.gets).toEqual([s.paneId]);
    expect(s.statuses).toEqual([]);
    idle = true;
    s.scheduler.advance(2_999);
    await flush();
    expect(s.statuses).toEqual([]);
    s.scheduler.advance(1);
    await flush();
    expect(s.statuses).toEqual(['idle']);
    expect(s.client.gets).toEqual([s.paneId, s.paneId]);
    // Well before the 30 s resync tick: nothing more from this path.
    s.scheduler.advance(20_000);
    await flush();
    expect(s.client.gets).toEqual([s.paneId, s.paneId]);
  });

  it('a second answer before the first recheck re-arms the timers instead of adding more', async () => {
    const s = await attachedBlocked();
    await s.ctx.client.sendTrustStep(s.paneId, 'down');
    s.scheduler.advance(500);
    await s.ctx.client.sendTrustStep(s.paneId, 'enter');
    await flush();
    s.scheduler.advance(10_000);
    await flush();
    expect(s.client.gets).toEqual([s.paneId, s.paneId]);
  });

  it.each([
    ['sendDialogKey', (c: HerdrClient, pane: string) => c.sendDialogKey(pane, 'enter')],
    ['sendFormSubmit', (c: HerdrClient, pane: string) => c.sendFormSubmit(pane)],
    ['sendKeys (digit of a dialog option)', (c: HerdrClient, pane: string) => c.sendKeys(pane, ['1'])],
  ])('%s → the same recheck', async (_name, answer) => {
    const s = await attachedBlocked();
    s.client.answer = (paneId) => Promise.resolve(idleNow(paneId));
    await answer(s.ctx.client, s.paneId);
    s.scheduler.advance(1_000);
    await flush();
    expect(s.statuses).toEqual(['idle']);
  });

  it.each([
    ['prompt', (c: HerdrClient, pane: string) => c.prompt(pane, 'hello')],
    ['pasteText', (c: HerdrClient, pane: string) => c.pasteText(pane, 'hello')],
    ['sendPromptSubmit', (c: HerdrClient, pane: string) => c.sendPromptSubmit(pane)],
    ['sendModeCycle', (c: HerdrClient, pane: string) => c.sendModeCycle(pane)],
    ['sendTakeBackKey', (c: HerdrClient, pane: string) => c.sendTakeBackKey(pane, TAKE_BACK_UP_KEY)],
  ])('%s → no recheck', async (_name, send) => {
    const s = await attachedBlocked();
    await send(s.ctx.client, s.paneId);
    s.scheduler.advance(10_000);
    await flush();
    expect(s.client.gets).toEqual([]);
  });

  it('a refused send schedules nothing', async () => {
    const s = await attachedBlocked();
    s.client.sendError = new Error('herdr refused');
    await expect(s.ctx.client.sendTrustStep(s.paneId, 'enter')).rejects.toThrow('herdr refused');
    s.scheduler.advance(10_000);
    await flush();
    expect(s.client.gets).toEqual([]);
  });

  it('dispose() before the deadline → no agent.get after it, no exception', async () => {
    const s = await attachedBlocked();
    await s.ctx.client.sendTrustStep(s.paneId, 'enter');
    s.supervisor.dispose();
    expect(() => { s.scheduler.advance(10_000); }).not.toThrow();
    await flush();
    expect(s.client.gets).toEqual([]);
  });

  it('the entry is gone after the first recheck → no second agent.get for it', async () => {
    const s = await attachedBlocked();
    s.client.answer = (paneId) => Promise.reject(new HerdrGoneError(foreign(`no ${paneId}`)));
    await s.ctx.client.sendTrustStep(s.paneId, 'enter');
    s.scheduler.advance(1_000);
    await flush();
    expect(s.client.gets).toEqual([s.paneId]);
    s.scheduler.advance(10_000);
    await flush();
    expect(s.client.gets).toEqual([s.paneId]);
  });
});

describe('a launched pane joins the event subscription at registration', () => {
  it('supervisor.launch → the current subscription has the new pane, without a composition event', async () => {
    const NEW_PANE = 'w9:pNEW';
    const launcher: HerdrLauncher = {
      launch: () => Promise.resolve({
        key: 'from-the-fake',
        paneId: NEW_PANE,
        tabId: 'w9:tNEW',
        agentSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        ready: new Promise<never>(() => {}),
      }),
    };
    const s = await setup([fixtureAgent('idle', 1)], launcher);
    await s.supervisor.launch({ cwd: '/Users/u/Projects/atlas' });
    await flush();
    expect(s.transport.current()).toContainEqual({ type: 'pane.agent_status_changed', pane_id: NEW_PANE });
  });
});

describe('refreshPane: a failed status refresh is logged', () => {
  it('agent.get throws a plain Error → one log line with the pane and the message', async () => {
    const s = await attachedBlocked();
    s.client.answer = () => Promise.reject(new Error('boom'));
    await s.ctx.client.sendTrustStep(s.paneId, 'enter');
    s.scheduler.advance(1_000);
    await flush();
    const lines = s.logs.filter((line) => line.includes('boom'));
    expect(lines).toEqual([`herdr: status refresh for ${s.paneId} failed: boom`]);
  });

  it('agent.get throws HerdrGoneError → the entry is forgotten as before', async () => {
    const s = await attachedBlocked();
    const gone: HerdrPaneEvent[] = [];
    s.ctx.handle.subscribe((ev) => { if (ev.type === 'gone') gone.push(ev); });
    s.client.answer = (paneId) => Promise.reject(new HerdrGoneError(foreign(`no ${paneId}`)));
    await s.ctx.client.sendTrustStep(s.paneId, 'enter');
    s.scheduler.advance(1_000);
    await flush();
    expect(gone).toEqual([{ type: 'gone' }]);
    expect(s.logs.filter((line) => line.includes('status refresh'))).toEqual([]);
  });
});

/** A promise the test resolves by hand: a slow `agent.get`. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('a late status refresh does not bring back a closed pane', () => {
  it('closeTab while the recheck `agent.get` is in flight → no second appeared, the status does not come back',
    async () => {
      const s = await attachedBlocked(new FakeHerdr());
      const slow = deferred<HerdrAgentInfo>();
      s.client.answer = () => slow.promise;
      await s.ctx.client.sendTrustStep(s.paneId, 'enter');
      s.scheduler.advance(1_000);
      await flush();
      expect(s.client.gets).toEqual([s.paneId]);
      await s.supervisor.closeTab(s.paneId);
      slow.resolve(idleNow(s.paneId));
      await flush();
      expect(s.lifecycle.map((ev) => ev.type)).toEqual(['appeared', 'gone']);
      expect(s.statuses).toEqual([]);
    });

  it('dispose() while the recheck `agent.get` is in flight → the late answer is dropped without an exception',
    async () => {
      const s = await attachedBlocked();
      const slow = deferred<HerdrAgentInfo>();
      s.client.answer = () => slow.promise;
      await s.ctx.client.sendTrustStep(s.paneId, 'enter');
      s.scheduler.advance(1_000);
      await flush();
      s.supervisor.dispose();
      slow.resolve(idleNow(s.paneId));
      await flush();
      expect(s.statuses).toEqual([]);
    });
});

describe('a renewed subscription catches up on what its gap lost', () => {
  const NEW_PANE = 'w9:pNEW';
  const launcher: HerdrLauncher = {
    launch: () => Promise.resolve({
      key: 'from-the-fake',
      paneId: NEW_PANE,
      tabId: 'w9:tNEW',
      agentSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ready: new Promise<never>(() => {}),
    }),
  };

  /** Pane A working and attached; starting pane B renews the stream; meanwhile A went idle in herdr. */
  async function gapAfterLaunch(): Promise<Setup & { statuses: HerdrAgentStatus[]; paneA: string }> {
    const working = fixtureAgent('working', 5);
    const s = await setup([working], launcher);
    s.supervisor.attach(working.paneId);
    const statuses: HerdrAgentStatus[] = [];
    s.contexts[0]?.handle.subscribe((ev) => { if (ev.type === 'status') statuses.push(ev.status); });
    const opened = s.transport.subscriptions.length;
    await s.supervisor.launch({ cwd: '/Users/u/Projects/atlas' });
    expect(s.transport.subscriptions.length).toBe(opened + 1);
    s.client.listAgents = () => Promise.resolve([{ ...working, status: 'idle', stateChangeSeq: 6 }]);
    return { ...s, statuses, paneA: working.paneId };
  }

  it('connected of the renewed stream → resync: A is idle without the 30 s tick', async () => {
    const s = await gapAfterLaunch();
    s.transport.streams.at(-1)?.push({ type: 'connected' });
    await flush();
    expect(s.statuses).toEqual(['idle']);
  });

  it('that resync does not open the subscription again', async () => {
    const s = await gapAfterLaunch();
    const opened = s.transport.subscriptions.length;
    s.transport.streams.at(-1)?.push({ type: 'connected' });
    await flush();
    expect(s.transport.subscriptions.length).toBe(opened);
  });
});
