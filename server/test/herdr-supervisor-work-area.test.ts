/**
 * Pane scope in the supervisor (`scopeOf` in `server/src/herdr/supervisor.ts`) with the root `~`: a pane in
 * a hidden entry of home or in a macOS-protected folder is out of scope, a pane anywhere else under home is in, also
 * when the directory reaches the folder through a symlink or through a root that is a symlink to home. The input is
 * the recorded `agent-list.json` with the directories rewritten; client, stream and drivers are stand-ins, so no
 * socket is touched.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import type { DecisionOutcome, SessionDriver } from '../src/drivers/types.ts';
import { parseAgentList } from '../src/herdr/client.ts';
import { createHerdrSupervisor } from '../src/herdr/supervisor.ts';
import type { HerdrSupervisorHandle, HerdrTransport } from '../src/herdr/supervisor.ts';
import type { HerdrStreamEvent } from '../src/herdr/socket.ts';
import type { HerdrAgentInfo, HerdrClient, HerdrLifecycleEvent } from '../src/herdr/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const HOME = '/Users/u';
const rawAgents = (JSON.parse(readFileSync(join(FIXTURES, 'agent-list.json'), 'utf8')) as {
  result: { agents: Record<string, unknown>[] };
}).result.agents;

/** Never fires: the test reads the first `agent.list` only. */
const scheduler: Scheduler = {
  setTimeout: (): TimerHandle => ({}) as TimerHandle,
  clearTimeout: () => {},
  now: () => 0,
};

const transport: HerdrTransport = {
  subscribe: () => ({ events: new AsyncEventQueue<HerdrStreamEvent>(), close: () => {} }),
  status: () => ({ available: true, readOnly: false, version: '0.8.2', protocol: 20 }),
  dispose: () => {},
};

/** A client that lists the given agents; every other call resolves with nothing. */
function clientOf(agents: HerdrAgentInfo[]): HerdrClient {
  const known: Record<string, unknown> = {
    listAgents: () => Promise.resolve(agents.map((agent) => ({ ...agent }))),
    getAgent: (paneId: string) => Promise.resolve({ ...agents.find((agent) => agent.paneId === paneId) }),
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

let active: HerdrSupervisorHandle | null = null;

afterEach(() => {
  active?.dispose();
  active = null;
});

/** Scope of each pane after the first list, by directory. */
async function scopes(
  cwds: readonly string[], roots: readonly string[], home: string = HOME,
): Promise<Record<string, boolean>> {
  const agents = parseAgentList({
    agents: cwds.map((cwd, index) => ({ ...rawAgents[index], cwd, foreground_cwd: cwd })),
  });
  const supervisor = createHerdrSupervisor(
    { socketPath: '/unused.sock', roots, yoloRoots: [], sendEnabled: true, dataDir: join(FIXTURES, 'unused'), home },
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
  active = supervisor;
  const seen: HerdrLifecycleEvent[] = [];
  void (async () => {
    for await (const event of supervisor.events) seen.push(event);
  })();
  await supervisor.ready;
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
  const out: Record<string, boolean> = {};
  for (const event of seen) if (event.type === 'appeared') out[event.agent.cwd] = event.agent.inScope;
  return out;
}

describe('pane scope with the root ~', () => {
  it('~/.cache/x and ~/Desktop/x are out of scope; ~/inne/x and an agent worktree are in', async () => {
    const cwds = [
      `${HOME}/.cache/x`, `${HOME}/Desktop/x`, `${HOME}/inne/x`, `${HOME}/Projects/app/.claude/worktrees/agent-1`,
      `${HOME}/Library/Mobile Documents/x`,
    ];
    expect(await scopes(cwds, [HOME])).toEqual({
      [`${HOME}/.cache/x`]: false,
      [`${HOME}/Desktop/x`]: false,
      [`${HOME}/inne/x`]: true,
      [`${HOME}/Projects/app/.claude/worktrees/agent-1`]: true,
      [`${HOME}/Library/Mobile Documents/x`]: false,
    });
  });

  it('a root inside ~/Documents keeps its panes in scope', async () => {
    const cwds = [`${HOME}/Documents/Projects/p`, `${HOME}/Documents/other`];
    expect(await scopes(cwds, [HOME, `${HOME}/Documents/Projects`])).toEqual({
      [`${HOME}/Documents/Projects/p`]: true,
      [`${HOME}/Documents/other`]: false,
    });
  });
});

describe('pane scope on disk: symlinks into a protected folder', () => {
  let base = '';

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('a pane in ~/inne/link -> ~/Desktop/x and in <root symlinked to home>/Desktop/x is out of scope', async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'rarog-scope-')));
    const home = join(base, 'home');
    const dom = join(base, 'dom');
    for (const dir of ['inne/x', 'Desktop/x']) mkdirSync(join(home, dir), { recursive: true });
    symlinkSync(join(home, 'Desktop', 'x'), join(home, 'inne', 'link'));
    symlinkSync(home, dom);
    expect(await scopes([join(home, 'inne', 'link'), join(home, 'inne', 'x')], [home], home)).toEqual({
      [join(home, 'inne', 'link')]: false,
      [join(home, 'inne', 'x')]: true,
    });
    expect(await scopes([join(dom, 'Desktop', 'x'), join(dom, 'inne', 'x')], [dom], home)).toEqual({
      [join(dom, 'Desktop', 'x')]: false,
      [join(dom, 'inne', 'x')]: true,
    });
  });
});
