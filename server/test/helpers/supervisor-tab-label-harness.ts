/**
 * A small harness for the supervisor's tab label sync: a virtual scheduler, an agent
 * client that serves a fixed `agent.list`, a silent event transport and a no-op driver.
 *
 * The launch client (panes, tabs, labels) comes from the caller, so a test can reuse the
 * terminal backend fake (`server/test/fake-term-herdr.ts`) and record every write there.
 * No socket, no disk: audit and the hidden store are in-memory stubs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AsyncEventQueue } from '../../src/drivers/runtime.ts';
import type { Scheduler, TimerHandle } from '../../src/drivers/runtime.ts';
import type { DecisionOutcome, SessionDriver } from '../../src/drivers/types.ts';
import { parseAgentList } from '../../src/herdr/client.ts';
import type { HerdrSocketStatus, HerdrStreamEvent, HerdrSubscription } from '../../src/herdr/socket.ts';
import {
  TAB_LABEL_DEBOUNCE_MS, createHerdrSupervisor,
} from '../../src/herdr/supervisor.ts';
import type { HerdrLauncherSeam, HerdrSupervisorHandle, HerdrTransport } from '../../src/herdr/supervisor.ts';
import { HerdrGoneError } from '../../src/herdr/types.ts';
import type {
  HerdrAgentInfo, HerdrClient, HerdrLaunchClient, HerdrLauncher, HerdrScreen,
} from '../../src/herdr/types.ts';
import { foreign } from '@rarog/shared/sentences';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'herdr');
const rawAgents = (JSON.parse(
  readFileSync(join(FIXTURES, 'agent-list.json'), 'utf8'),
) as { result: { agents: Record<string, unknown>[] } }).result.agents;
const footerAuto = readFileSync(join(FIXTURES, 'footer-auto.txt'), 'utf8');

/**
 * An agent from the live `agent-list.json` fixture with an agent NAME, passed through the real
 * input filter, so `launchedByRarog` comes from `name` like in production.
 */
export function namedFixtureAgent(index: number, name: string | null): HerdrAgentInfo {
  const [info] = parseAgentList({ agents: [{ ...rawAgents[index], name }] });
  if (info === undefined) throw new Error(`input filter rejected agent ${String(index)}`);
  return info;
}

/** Virtual time: timers fire only on {@link VirtualScheduler.advance}. */
export class VirtualScheduler implements Scheduler {
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

/** `agent.list` from a fixed list; every input method succeeds and does nothing. */
export class StaticAgentClient implements HerdrClient {
  constructor(private readonly agents: HerdrAgentInfo[]) {}

  listAgents(): Promise<HerdrAgentInfo[]> {
    return Promise.resolve(this.agents.map((agent) => ({ ...agent })));
  }

  getAgent(paneId: string): Promise<HerdrAgentInfo> {
    const found = this.agents.find((agent) => agent.paneId === paneId);
    if (found === undefined) return Promise.reject(new HerdrGoneError(foreign(`no ${paneId}`)));
    return Promise.resolve({ ...found });
  }

  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: footerAuto }); }
  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ text: '', truncated: false });
  }
  prompt(): Promise<void> { return Promise.resolve(); }
  sendKeys(): Promise<void> { return Promise.resolve(); }
  sendFormSubmit(): Promise<void> { return Promise.resolve(); }
  sendModeCycle(): Promise<void> { return Promise.resolve(); }
  sendTrustStep(): Promise<void> { return Promise.resolve(); }
  sendDialogKey(): Promise<void> { return Promise.resolve(); }
  sendTakeBackKey(): Promise<void> { return Promise.resolve(); }
  pasteText(): Promise<void> { return Promise.resolve(); }
  sendPromptSubmit(): Promise<void> { return Promise.resolve(); }
  focus(): Promise<void> { return Promise.resolve(); }
  ping(): Promise<{ version: string; protocol: number }> {
    return Promise.resolve({ version: '0.9.5', protocol: 20 });
  }
}

/** An event stream that never emits. */
class SilentTransport implements HerdrTransport {
  subscribe(): HerdrSubscription {
    const queue = new AsyncEventQueue<HerdrStreamEvent>();
    return { events: queue, close: (): void => { queue.close(); } };
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

export interface TabLabelHarness {
  supervisor: HerdrSupervisorHandle;
  scheduler: VirtualScheduler;
  logs: string[];
  /** Lets the debounce pass and the sync pass run to the end. */
  fire(): Promise<void>;
}

/**
 * A started supervisor over `agents`, with `launchClient` as its pane and tab channel.
 * `options.tabLabels` is `RAROG_HERDR_TAB_LABELS` (absent = on, like the default config);
 * `options.client` replaces the agent client (e.g. one that fails while herdr is down);
 * `options.createLauncher` turns the launch channel on with a launcher built on the supervisor's seam.
 */
export async function startTabLabelHarness(
  agents: HerdrAgentInfo[], launchClient: HerdrLaunchClient,
  options: {
    tabLabels?: boolean; client?: HerdrClient; createLauncher?: (seam: HerdrLauncherSeam) => HerdrLauncher;
  } = {},
): Promise<TabLabelHarness> {
  const scheduler = new VirtualScheduler();
  const logs: string[] = [];
  const supervisor = createHerdrSupervisor(
    {
      socketPath: '/unused.sock',
      roots: ['/Users/u/Projects'],
      yoloRoots: [],
      sendEnabled: true,
      ...(options.tabLabels === undefined ? {} : { tabLabels: options.tabLabels }),
      launchEnabled: options.createLauncher !== undefined,
      dataDir: join(FIXTURES, 'unused'),
      now: () => 1_000_000,
      logger: (line) => { logs.push(line); },
    },
    {
      createDriver: () => noopDriver(),
      client: options.client ?? new StaticAgentClient(agents),
      transport: new SilentTransport(),
      scheduler,
      launchClient,
      ...(options.createLauncher === undefined ? {} : { createLauncher: options.createLauncher }),
      audit: { log: () => {}, flush: () => Promise.resolve() },
      hidden: {
        flush: () => Promise.resolve(),
        aliasFor: () => undefined, rememberAlias: () => Promise.resolve(),
        seenSeq: () => undefined, markSeen: () => Promise.resolve(), seenBy: () => undefined,
        unseenSeq: () => undefined, markUnseen: () => Promise.resolve(),
      },
    },
  );
  void (async () => {
    for await (const _ of supervisor.events) { /* drain */ }
  })();
  await supervisor.ready;
  const fire = async (): Promise<void> => {
    scheduler.advance(TAB_LABEL_DEBOUNCE_MS);
    // A few turns with `setTimeout`, not only `setImmediate`: migration resolves the project
    // key through `realpath`, which is I/O on the libuv thread pool.
    for (let i = 0; i < 10; i += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
    }
  };
  return { supervisor, scheduler, logs, fire };
}
