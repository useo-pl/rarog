/**
 * The supervisor's agent set signal wired to `alive.json` (`server/src/bootstrap/alive-sessions.ts`): when the
 * herdr supervisor reports the first Claude session after the start, `alive.json` carries it at once instead of
 * with the next 10 s tick. A hook that started during a server restart waits for its session on that list, so the
 * tick would stretch the restart window. Real supervisor and writer; only herdr is a fake.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { createAliveSessionsSignal } from '../src/bootstrap/alive-sessions.ts';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { DecisionOutcome, SessionDriver } from '../src/drivers/types.ts';
import { parseAgentList } from '../src/herdr/client.ts';
import { HOOK_ALIVE_FILENAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookAliveFile } from '../src/herdr/dialogs/hook/contract.ts';
import { createAliveWriter } from '../src/herdr/dialogs/shadow/alive.ts';
import type { AliveWriter } from '../src/herdr/dialogs/shadow/alive.ts';
import type { HerdrSocketStatus, HerdrStreamEvent, HerdrSubscription } from '../src/herdr/socket.ts';
import { createHerdrSupervisor } from '../src/herdr/supervisor.ts';
import type { HerdrSupervisorHandle, HerdrTransport } from '../src/herdr/supervisor.ts';
import { HerdrGoneError } from '../src/herdr/types.ts';
import type { HerdrAgentInfo, HerdrClient, HerdrScreen } from '../src/herdr/types.ts';
import { VirtualScheduler } from './helpers/supervisor-tab-label-harness.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const rawAgents = (JSON.parse(
  readFileSync(join(FIXTURES, 'agent-list.json'), 'utf8'),
) as { result: { agents: Record<string, unknown>[] } }).result.agents;

/** The first agent of the live fixture: Claude, in the `/Users/u/Projects` scope, with a session id. */
function claudeAgent(): HerdrAgentInfo {
  const [info] = parseAgentList({ agents: [rawAgents[0]] });
  if (info === undefined) throw new Error('input filter rejected the fixture agent');
  return info;
}

/** `agent.list` answers only once the test opens the gate: the moment the supervisor learns of the session. */
class GatedClient implements HerdrClient {
  #open: (() => void) | null = null;
  readonly #gate = new Promise<void>((resolve) => { this.#open = resolve; });
  /** When `agent.list` answered (ms, `Date.now`). */
  answeredAt = 0;

  constructor(private readonly agents: HerdrAgentInfo[]) {}

  open(): void { this.#open?.(); }

  async listAgents(): Promise<HerdrAgentInfo[]> {
    await this.#gate;
    this.answeredAt = Date.now();
    return this.agents.map((agent) => ({ ...agent }));
  }

  getAgent(paneId: string): Promise<HerdrAgentInfo> {
    const found = this.agents.find((agent) => agent.paneId === paneId);
    if (found === undefined) return Promise.reject(new HerdrGoneError(foreign(`no ${paneId}`)));
    return Promise.resolve({ ...found });
  }

  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: '' }); }
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

const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function readAlive(dir: string): HookAliveFile {
  return JSON.parse(readFileSync(join(dir, HOOK_ALIVE_FILENAME), 'utf8')) as HookAliveFile;
}

interface Wired {
  readonly dir: string;
  readonly client: GatedClient;
  readonly supervisor: HerdrSupervisorHandle;
  readonly writer: AliveWriter;
}

/** The order of `main()`: the signal before the supervisor, the writer after it, then the hand-over. */
function wire(agents: HerdrAgentInfo[]): Wired {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-alive-sessions-'));
  dirs.push(dir);
  const signal = createAliveSessionsSignal();
  const client = new GatedClient(agents);
  const supervisor = createHerdrSupervisor(
    {
      socketPath: '/unused.sock', roots: ['/Users/u/Projects'], yoloRoots: [], sendEnabled: true,
      tabLabels: false, dataDir: join(FIXTURES, 'unused'), now: () => 1_000_000,
    },
    {
      createDriver: () => noopDriver(),
      client,
      transport: new SilentTransport(),
      scheduler: new VirtualScheduler(),
      audit: { log: () => {}, flush: () => Promise.resolve() },
      hidden: {
        flush: () => Promise.resolve(),
        aliasFor: () => undefined, rememberAlias: () => Promise.resolve(),
        seenSeq: () => undefined, markSeen: () => Promise.resolve(), seenBy: () => undefined,
        unseenSeq: () => undefined, markUnseen: () => Promise.resolve(),
      },
      onAgentsChanged: signal.onAgentsChanged,
    },
  );
  void (async () => {
    for await (const _ of supervisor.events) { /* drain */ }
  })();
  // Real rhythm (10 s): a write inside the test window can only come from the signal.
  const writer = createAliveWriter({
    dataDir: dir, mode: 'all', send: () => true, bootId: 'boot-a',
    sessions: () => supervisor.observedEngineSessions?.() ?? [],
  });
  writer.start();
  signal.connect(writer);
  cleanups.push(() => { writer.stop(); supervisor.dispose(); });
  return { dir, client, supervisor, writer };
}

describe('alive.json follows the first session the supervisor reports', { timeout: 5_000 }, () => {
  it('first session after the start → alive.json carries it in under 100 ms', async () => {
    const agent = claudeAgent();
    const { dir, client, supervisor } = wire([agent]);
    expect(readAlive(dir).sessions).toEqual([]);
    client.open();
    await supervisor.ready;
    let sessions: readonly string[] = [];
    while (Date.now() - client.answeredAt < 200) {
      sessions = readAlive(dir).sessions;
      if (sessions.length > 0) break;
      await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    }
    const elapsed = Date.now() - client.answeredAt;
    expect(sessions).toEqual([agent.agentSessionId]);
    expect(elapsed).toBeLessThan(100);
  });
});
