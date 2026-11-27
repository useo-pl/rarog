/**
 * Supervisor side of a launch that stands on a start dialog herdr reads as ready (`idle`, `interactive_ready`, no
 * session id): the launch entry stays `blocked`, and the launcher's session watch (`sessionAppeared`) brings it to
 * ready through the supervisor's own refresh, without the full resync. The launcher side is in
 * `herdr-launcher.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { HerdrLauncherSeam } from '../src/herdr/supervisor.ts';
import type { HerdrAgentInfo, HerdrLaunchResult, HerdrLauncher } from '../src/herdr/types.ts';
import { FakeHerdr } from './fake-term-herdr.ts';
import { namedFixtureAgent, startTabLabelHarness } from './helpers/supervisor-tab-label-harness.ts';

const PANE = 'w9:pNEW';
const TAB = 'w9:tNEW';
const SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CWD = '/Users/u/Projects/demo';

/** A supervisor with a launcher whose start settles on a start dialog; the agent list starts empty. */
async function blockedLaunch(): Promise<{
  harness: Awaited<ReturnType<typeof startTabLabelHarness>>; seam: HerdrLauncherSeam; key: string;
  agents: HerdrAgentInfo[];
}> {
  const agents: HerdrAgentInfo[] = [];
  let seam: HerdrLauncherSeam | undefined;
  const createLauncher = (given: HerdrLauncherSeam): HerdrLauncher => {
    seam = given;
    return {
      launch: () => {
        const key = given.registerLaunch({
          paneId: PANE, tabId: TAB, agentSessionId: SESSION, cwd: CWD, label: 'demo',
        });
        const result: HerdrLaunchResult = {
          key, paneId: PANE, tabId: TAB, agentSessionId: SESSION, createdWorkspace: false, argv: ['claude'],
          status: 'blocked', interactiveReady: false, startDialog: { id: 'external-imports', title: null },
        };
        return Promise.resolve({
          key, paneId: PANE, tabId: TAB, agentSessionId: SESSION, ready: Promise.resolve(result),
        });
      },
    };
  };
  const harness = await startTabLabelHarness(agents, new FakeHerdr(), { createLauncher });
  const handle = await harness.supervisor.launch({ cwd: CWD });
  await expect(handle.ready).resolves.toMatchObject({ status: 'blocked', startDialog: { id: 'external-imports' } });
  if (seam === undefined) throw new Error('the supervisor built no launcher');
  return { harness, seam, key: handle.key, agents };
}

describe('supervisor: a launch on a start dialog herdr reads as ready', () => {
  it('stays `blocked` and held, then the session watch refresh makes it ready without a resync', async () => {
    const { harness, seam, key, agents } = await blockedLaunch();
    expect(harness.supervisor.agentFor?.(key)).toMatchObject({ status: 'blocked', interactiveReady: false });
    expect(seam.launchHeld(key)).toBe(true);

    // The answer in the terminal: `SessionStart` gives herdr the session id; the pane is `idle` before and after.
    agents.push({
      ...namedFixtureAgent(0, 'rarog-a1b2c3'), paneId: PANE, tabId: TAB, agentSessionId: SESSION, cwd: CWD,
      status: 'idle', interactiveReady: true,
    });
    seam.sessionAppeared(PANE);
    await vi.waitFor(() => {
      expect(harness.supervisor.agentFor?.(key)).toMatchObject({ status: 'idle', interactiveReady: true });
    });
    expect(seam.launchHeld(key)).toBe(false);
    expect(harness.scheduler.now()).toBe(0);
  });

  it('a disposed supervisor holds no launch, so the session watch stops', async () => {
    const { harness, seam, key } = await blockedLaunch();
    harness.supervisor.dispose();
    expect(seam.launchHeld(key)).toBe(false);
  });
});
