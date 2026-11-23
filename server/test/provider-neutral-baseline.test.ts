/**
 * Golden contract of the Claude-only core.
 *
 * This file tests several public seams together on purpose. Module tests lower in the tree guard the implementation
 * details; this set freezes what a change of the core must not change:
 * publiczne ID i aliasy, wynik Claude w mixed `agent.list`, argv/env launchera, schematy
 * wire oraz lifecycle `/clear`.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FALLBACK_MODEL_CHOICES,
  createSessionBodySchema,
  createSessionResponseSchema,
  modelListSchema,
  permissionDecisionBodySchema,
  resumableListSchema,
} from '@rarog/shared';
import { answersBodySchema } from '@rarog/shared/rest';
import { afterEach, describe, expect, it } from 'vitest';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import type { DecisionOutcome, SessionDriver } from '../src/drivers/types.ts';
import { normalizeAgentInfo, parseAgentList } from '../src/herdr/client.ts';
import { buildClaudeArgs } from '../src/herdr/argv.ts';
import { createHerdrLauncher } from '../src/herdr/launcher.ts';
import { createHiddenStore, hiddenStorePath, sessionIdFor } from '../src/herdr/identity.ts';
import {
  HERDR_RESYNC_MS,
  createHerdrSupervisor,
} from '../src/herdr/supervisor.ts';
import type { HerdrAttachContext, HerdrTransport } from '../src/herdr/supervisor.ts';
import type {
  HerdrSocketStatus,
  HerdrStreamEvent,
  HerdrSubscription,
  HerdrSubscriptionSpec,
} from '../src/herdr/socket.ts';
import type {
  HerdrAgentInfo,
  HerdrClient,
  HerdrCreateTabParams,
  HerdrCreateWorkspaceParams,
  HerdrLaunchClient,
  HerdrLifecycleEvent,
  HerdrPaneEvent,
  HerdrPaneMetadataParams,
  HerdrStartAgentParams,
} from '../src/herdr/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const rawAgents = (JSON.parse(
  readFileSync(join(FIXTURES, 'agent-list.json'), 'utf8'),
) as { result: { agents: Record<string, unknown>[] } }).result.agents;

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const RESUME_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/*
 * Golden jest celowo niezalezny od `DEFAULT_CLAUDE_ENV_CLEAR`. Gdyby expected importowal
 * te sama stala co launcher, przypadkowe usuniecie zmiennej zmniejszyloby obie strony
 * asercji i test przeszedlby mimo regresji.
 */
const EXPECTED_CLAUDE_ENV_CLEAR = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_TMPDIR',
  'CLAUDE_EFFORT',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_ADMIN_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

describe('Claude-only contract — Claude identity i normalizacja agent.list', () => {
  it('zamraza publiczne UUID istniejacych deep-linkow', () => {
    expect(sessionIdFor('w9:p72')).toBe('cf9448d5-fb26-50da-8e83-c43d660a9602');
    expect(sessionIdFor('wQ:p2')).toBe('bde67d15-b4ac-5d11-8950-edbf08ae0bdc');
  });

  it('zachowuje stary, nieprefiksowany alias Claude po ponownym otwarciu store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-provider-neutral-'));
    const file = hiddenStorePath(dataDir);
    try {
      await writeFile(file, JSON.stringify({
        aliases: { [RESUME_ID]: 'legacy-rarog-session' },
      }), 'utf8');
      expect(createHiddenStore({ dataDir }).aliasFor(RESUME_ID)).toBe('legacy-rarog-session');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('zachowuje wynik Claude posrod realistycznych rekordow mixed-provider', () => {
    const claude = rawAgents[0];
    const codex = {
      ...rawAgents[1],
      agent: 'codex',
      agent_session: {
        agent: 'codex',
        kind: 'id',
        source: 'herdr:codex',
        value: '00000000-0000-4000-8000-000000000010',
      },
    };
    const unknown = {
      ...rawAgents[2],
      agent: 'future-agent',
      agent_session: {
        agent: 'future-agent',
        kind: 'id',
        source: 'herdr:future-agent',
        value: '00000000-0000-4000-8000-000000000011',
      },
    };
    const pathSession = {
      ...rawAgents[3],
      agent_session: { ...(rawAgents[3]?.['agent_session'] as object), kind: 'path' },
    };

    const mixed = parseAgentList(
      { agents: [codex, unknown, pathSession, claude] }, { codexStatus: true },
    );
    expect(mixed.find((agent) => agent.paneId === 'w9:p72')).toEqual({
      paneId: 'w9:p72',
      tabId: 'w9:t1H',
      agentSessionId: 'e3759b2c-2275-565c-8f49-4e2707bb0231',
      engine: 'claude',
      termId: null,
      cwd: '/Users/u/Projects/demo',
      status: 'idle',
      launchedByRarog: false,
      interactiveReady: true,
      title: 'refaktor',
      stateChangeSeq: 23,
    });
    expect(normalizeAgentInfo(claude, { codexStatus: true }))
      .toEqual(mixed.find((agent) => agent.paneId === 'w9:p72'));
    /*
     * Obok wpisu Claude stoi wpis Codexa (stan bez treści), a `future-agent` i `kind: 'path'` dalej nie istnieją.
     * Neutralność providera mierzy się tym, że rekord Claude jest BIT W BIT ten sam.
     */
    expect(mixed.map((agent) => [agent.paneId, agent.engine]))
      .toEqual([['w9:p1Y', 'codex'], ['w9:p72', 'claude']]);
    expect(parseAgentList({ agents: [codex, unknown, pathSession, claude] })
      .map((agent) => agent.paneId)).toEqual(['w9:p72']);
  });
});

describe('Claude-only contract — Claude launcher recipe', () => {
  it('zamraza kolejnosc argv dla fresh, resume i fork', () => {
    expect(buildClaudeArgs({ cwd: '/projekt' }, SESSION_ID)).toEqual([
      '--session-id', SESSION_ID,
    ]);
    expect(buildClaudeArgs({ cwd: '/projekt', resumeFrom: RESUME_ID }, SESSION_ID)).toEqual([
      '--resume', RESUME_ID,
    ]);
    expect(buildClaudeArgs({
      cwd: '/projekt',
      resumeFrom: RESUME_ID,
      fork: true,
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
    }, SESSION_ID)).toEqual([
      '--session-id', SESSION_ID,
      '--resume', RESUME_ID,
      '--fork-session',
      '--model', 'opus',
      '--effort', 'high',
      '--permission-mode', 'acceptEdits',
    ]);
  });

  it('wysyla agent.start kind=claude i zamkniety env panelu', async () => {
    const calls: {
      tab: HerdrCreateTabParams[];
      start: HerdrStartAgentParams[];
    } = { tab: [], start: [] };
    const client: HerdrLaunchClient = {
      listPaneIds: async () => new Set(['w1:p1']),
      // Workspace projektu nazwany katalogiem — kandydat resolvera workspace'u, panel w nim to dowód.
      listWorkspaces: async () => [{ workspaceId: 'w1', label: 'projekt' }],
      readPaneHistory: async () => ({ text: '', truncated: false }),
      readPaneProcess: async () => ({ processes: [] }),
      getTab: async (tabId: string) => ({ tabId, label: '1', paneCount: 1, workspaceId: 'w1' }),
      listPanes: async () => [{
        paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', cwd: '/projekt', tokens: {},
        label: null,
      }],
      createWorkspace: async (params: HerdrCreateWorkspaceParams) => ({
        workspaceId: 'w2', tabId: 'w2:t1', paneId: `w2:p-${params.cwd.length}`,
      }),
      createTab: async (params: HerdrCreateTabParams) => {
        calls.tab.push(params);
        return { tabId: 'w1:t2', paneId: 'w1:p2' };
      },
      startAgent: async (params: HerdrStartAgentParams) => {
        calls.start.push(params);
        return { argv: ['claude', ...params.args] };
      },
      reportPaneMetadata: async (_params: HerdrPaneMetadataParams) => {},
      renamePane: async () => {},
      renameTab: async () => {},
      closeTab: async () => {},
      closePane: async () => {},
      probeAgent: async () => ({
        agentSessionId: SESSION_ID, status: 'idle', interactiveReady: true, launchPending: false,
      }),
    };
    const launcher = createHerdrLauncher({
      client,
      trust: { isTrusted: async () => true },
      registerLaunch: () => 'w1:p2',
      newSessionId: () => SESSION_ID,
      newAgentName: () => 'rarog-golden',
      defer: (fn) => { fn(); },
    });

    await (await launcher.launch({ cwd: '/projekt' })).ready;

    expect(calls.start).toEqual([{
      name: 'rarog-golden', kind: 'claude', paneId: 'w1:p2', args: ['--session-id', SESSION_ID],
    }]);
    const env = calls.tab[0]?.env;
    expect(Object.keys(env ?? {}).sort()).toEqual([
      ...EXPECTED_CLAUDE_ENV_CLEAR, 'DISABLE_AUTO_UPDATE',
    ].sort());
    for (const name of EXPECTED_CLAUDE_ENV_CLEAR) expect(env?.[name]).toBe('');
    expect(env?.['DISABLE_AUTO_UPDATE']).toBe('true');
  });
});

/*
 * To jest baseline schematow wspoldzielonych. Zachowanie tras, metod i statusow HTTP
 * zamrazaja testy integracyjne w `router.test.ts` (w tym create=202, resumable, models,
 * permissions i answers).
 */
describe('Claude-only contract — obecne schematy wire Claude', () => {
  it('legacy create zachowuje opcje oraz schemat odpowiedzi startowej', () => {
    const body = {
      cwd: '/projekt',
      prompt: 'napraw test',
      permissionMode: 'manual',
      model: 'opus',
      effort: 'xhigh',
      resumeFrom: RESUME_ID,
      fork: true,
    };
    expect(createSessionBodySchema.parse(body)).toEqual(body);
    expect(createSessionResponseSchema.parse({
      sessionId: 'rarog-id', state: 'starting', trustPrompt: true,
    })).toEqual({ sessionId: 'rarog-id', state: 'starting', trustPrompt: true });
  });

  it('history wymaga obecnych pol Claude i models pozostaje lista bez source', () => {
    const history = {
      sessions: [{
        engineSessionId: RESUME_ID,
        cwd: '/projekt',
        mtime: '2026-08-31T10:00:00.000Z',
        firstPrompt: 'napraw test',
        gitBranch: 'fix/test',
        liveInHerdr: false,
        title: 'Testy',
      }],
    };
    expect(resumableListSchema.parse(history)).toEqual(history);
    expect(modelListSchema.parse({ models: FALLBACK_MODEL_CHOICES })).toEqual({
      models: FALLBACK_MODEL_CHOICES,
    });
  });

  it('permissions i answers zachowuja legacy body bez revision i attemptId', () => {
    expect(permissionDecisionBodySchema.parse({
      decision: 'allow-always', message: 'dla tego projektu',
    })).toEqual({ decision: 'allow-always', message: 'dla tego projektu' });
    expect(answersBodySchema.parse({ answers: [['A'], ['B', 'C']] })).toEqual({
      answers: [['A'], ['B', 'C']],
    });
  });
});

class GoldenScheduler implements Scheduler {
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
    this.#now += ms;
    const due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= this.#now);
    for (const [id, timer] of due) {
      this.#timers.delete(id);
      timer.fn();
    }
  }
}

class GoldenClient implements HerdrClient {
  constructor(public agents: HerdrAgentInfo[]) {}

  listAgents = async (): Promise<HerdrAgentInfo[]> => this.agents.map((agent) => ({ ...agent }));
  getAgent = async (paneId: string): Promise<HerdrAgentInfo> => {
    const agent = this.agents.find((candidate) => candidate.paneId === paneId);
    if (agent === undefined) throw new Error('agent missing');
    return { ...agent };
  };
  readScreen = async () => ({ text: 'auto mode on' });
  readPaneHistory = async () => ({ text: '', truncated: false });
  prompt = async () => {};
  sendKeys = async () => {};
  sendFormSubmit = async () => {};
  sendModeCycle = async () => {};
  pasteText = async () => {};
  sendPromptSubmit = async () => {};
  sendTrustStep = async () => {};
  sendDialogKey = async () => {};
  sendTakeBackKey = async () => {};
  focus = async () => {};
  ping = async () => ({ version: '0.8.2', protocol: 20 });
}

class GoldenTransport implements HerdrTransport {
  readonly queues: AsyncEventQueue<HerdrStreamEvent>[] = [];

  subscribe(_subs: readonly HerdrSubscriptionSpec[]): HerdrSubscription {
    const queue = new AsyncEventQueue<HerdrStreamEvent>();
    this.queues.push(queue);
    return { events: queue, close: () => { queue.close(); } };
  }

  status(): HerdrSocketStatus {
    return { available: true, readOnly: false, version: '0.8.2', protocol: 20 };
  }

  dispose(): void {
    for (const queue of this.queues) queue.close();
  }
}

const supervisors: ReturnType<typeof createHerdrSupervisor>[] = [];
const temporaryDataDirs: string[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) supervisor.dispose();
  for (const dataDir of temporaryDataDirs.splice(0)) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

describe('Claude-only contract — lifecycle zmiany sesji Claude', () => {
  it('ten sam pane z nowym external ID daje session-changed, bez drugiego appeared', async () => {
    const base = parseAgentList({ agents: [rawAgents[0]] })[0];
    if (base === undefined) throw new Error('brak fixture Claude');
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-provider-lifecycle-'));
    temporaryDataDirs.push(dataDir);
    const client = new GoldenClient([base]);
    const transport = new GoldenTransport();
    const scheduler = new GoldenScheduler();
    const lifecycle: HerdrLifecycleEvent[] = [];
    const paneEvents: HerdrPaneEvent[] = [];
    let context: HerdrAttachContext | undefined;
    const supervisor = createHerdrSupervisor({
      socketPath: '/nie-uzywany.sock',
      roots: ['/Users/u/Projects'],
      yoloRoots: [],
      sendEnabled: true,
      dataDir,
    }, {
      client,
      transport,
      scheduler,
      createDriver: (ctx): SessionDriver => {
        context = ctx;
        ctx.handle.subscribe((event) => { paneEvents.push(event); });
        return {
          ownsProcess: false,
          events: new AsyncEventQueue(),
          send: () => {},
          respondPermission: async (): Promise<DecisionOutcome> => ({ kind: 'applied' }),
          answerQuestion: async (): Promise<DecisionOutcome> => ({ kind: 'applied' }),
          interrupt: async () => true,
          dispose: () => {},
        };
      },
      audit: { log: () => {}, flush: async () => {} },
      hidden: {
        aliasFor: () => undefined,
        rememberAlias: async () => {},
        seenSeq: () => undefined,
        markSeen: async () => {},
        seenBy: () => undefined,
        unseenSeq: () => undefined,
        markUnseen: async () => {},
        flush: async () => {},
      },
    });
    supervisors.push(supervisor);
    void (async () => {
      for await (const event of supervisor.events) lifecycle.push(event);
    })();
    await supervisor.ready;
    await flush();

    supervisor.attach(base.paneId);
    expect(context?.sessionId).toBe('cf9448d5-fb26-50da-8e83-c43d660a9602');

    const changed = '99999999-1111-5222-8333-444444444444';
    client.agents = [{ ...base, agentSessionId: changed, stateChangeSeq: 24 }];
    scheduler.advance(HERDR_RESYNC_MS);
    await flush();

    expect(paneEvents).toContainEqual({ type: 'session-changed', agentSessionId: changed });
    expect(lifecycle.filter((event) => event.type === 'appeared')).toHaveLength(1);
    expect(lifecycle.some((event) => event.type === 'gone')).toBe(false);
  });
});
