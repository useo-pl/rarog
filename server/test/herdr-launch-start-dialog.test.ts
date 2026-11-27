/**
 * The real launcher on the supervisor's seam, for a start that stands on a dialog: what state the supervisor keeps
 * when the launch result arrives after a fresher list, and how the session id of an answered start dialog reaches
 * the supervisor without the full resync. The launcher alone is in `herdr-launcher.test.ts`, the supervisor with a
 * fake launcher in `herdr-supervisor-start-dialog.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createHerdrLauncher } from '../src/herdr/launcher.ts';
import type { HerdrLaunchProbe } from '../src/herdr/launcher.ts';
import { createProjectPlacement } from '../src/herdr/project-workspace.ts';
import type { HerdrLauncherSeam } from '../src/herdr/supervisor.ts';
import type { HerdrAgentInfo, HerdrLaunchRegistration } from '../src/herdr/types.ts';
import { FakeHerdr } from './fake-term-herdr.ts';
import { namedFixtureAgent, startTabLabelHarness } from './helpers/supervisor-tab-label-harness.ts';

const SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CWD = '/Users/u/Projects/demo';
const IMPORTS = readFileSync(
  join(import.meta.dirname, 'fixtures', 'herdr', 'kontrolny', 'importy-zewnetrzne-2.1.332.txt'), 'utf8',
);
const DIALOG_READY: HerdrLaunchProbe = { agentSessionId: '', status: 'idle', interactiveReady: true };
const TRUST_BLOCKED: HerdrLaunchProbe = { agentSessionId: '', status: 'blocked', interactiveReady: false };

/** The terminal backend fake, which also starts agents. */
class StartingHerdr extends FakeHerdr {
  override startAgent(): Promise<{ argv: readonly string[] }> {
    return Promise.resolve({ argv: ['claude'] });
  }
}

interface Rig {
  harness: Awaited<ReturnType<typeof startTabLabelHarness>>;
  seam: () => HerdrLauncherSeam;
  /** The supervisor's key of the launch, from its registration. */
  key: () => string;
  /** The agent with its session id on the list, as herdr shows it after the answer. */
  answered: () => HerdrAgentInfo;
  agents: HerdrAgentInfo[];
}

/**
 * A supervisor with the real launcher. `probe(n)` answers the `n`-th `agent.get` of the launch (from 0);
 * `screen(paneId)` is the launcher's screen read.
 */
async function rig(opts: {
  probe: (n: number, r: Rig) => HerdrLaunchProbe;
  screen?: (paneId: string, r: Rig) => Promise<string>;
}): Promise<Rig> {
  const agents: HerdrAgentInfo[] = [];
  let seam: HerdrLauncherSeam | undefined;
  let registered: HerdrLaunchRegistration | undefined;
  let key = '';
  let probes = 0;
  let clock = 1_000_000;
  const self = {} as Rig;
  const harness = await startTabLabelHarness(agents, new StartingHerdr(), {
    createLauncher: (given) => {
      seam = given;
      return createHerdrLauncher({
        client: given.client,
        placement: createProjectPlacement(),
        trust: { isTrusted: async () => true },
        registerLaunch: (reg) => {
          registered = reg;
          key = given.registerLaunch(reg);
          return key;
        },
        paneLabelled: (key) => { given.paneLabelled(key); },
        probeAgent: async () => {
          const answer = opts.probe(probes, self);
          probes += 1;
          return answer;
        },
        readScreen: (paneId) => opts.screen?.(paneId, self) ?? Promise.resolve(''),
        sessionAppeared: (paneId) => { given.sessionAppeared(paneId); },
        launchHeld: (key) => given.launchHeld(key),
        newSessionId: () => SESSION,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          await new Promise((resolve) => { setImmediate(resolve); });
        },
        logger: (line) => { given.logger(line); },
      });
    },
  });
  Object.assign(self, {
    harness,
    agents,
    seam: () => {
      if (seam === undefined) throw new Error('the supervisor built no launcher');
      return seam;
    },
    key: () => key,
    answered: () => ({
      ...namedFixtureAgent(0, 'rarog-a1b2c3'), paneId: registered?.paneId ?? '', tabId: registered?.tabId ?? '',
      agentSessionId: SESSION, cwd: CWD, status: 'idle', interactiveReady: true,
    }),
  });
  return self;
}

describe('launcher on the supervisor: a start dialog answered while the launcher reads its screen', () => {
  it('the late `blocked` result does not overwrite the ready state the supervisor applied from herdr', async () => {
    const r = await rig({
      probe: () => DIALOG_READY,
      // The answer lands during this read: herdr lists the session, the supervisor applies it, and the read still
      // returns the screen from before the answer.
      screen: async (paneId, self) => {
        self.agents.push(self.answered());
        self.seam().sessionAppeared(paneId);
        await vi.waitFor(() => {
          expect(self.harness.supervisor.agentFor?.(self.key())).toMatchObject({ status: 'idle', interactiveReady: true });
        });
        return IMPORTS;
      },
    });
    const handle = await r.harness.supervisor.launch({ cwd: CWD });
    await expect(handle.ready).resolves.toMatchObject({ status: 'blocked', startDialog: { id: 'external-imports' } });

    expect(r.harness.supervisor.agentFor?.(handle.key)).toMatchObject({ status: 'idle', interactiveReady: true });
    expect(r.seam().launchHeld(handle.key)).toBe(false);
    // No resync ran: the virtual clock never moved.
    expect(r.harness.scheduler.now()).toBe(0);
  });
});

describe('launcher on the supervisor: a start herdr reports `blocked` without a session id', () => {
  it('the session id after the answer reaches the supervisor through the session watch, not the resync', async () => {
    const r = await rig({
      probe: (n, self) => {
        if (n < 3) return TRUST_BLOCKED;
        // The trust answer, then the imports dialog answered in the terminal: the session id appears.
        if (self.agents.length === 0) self.agents.push(self.answered());
        return { agentSessionId: SESSION, status: 'idle', interactiveReady: true };
      },
    });
    const handle = await r.harness.supervisor.launch({ cwd: CWD });
    const result = await handle.ready;
    expect(result).toMatchObject({ status: 'blocked', interactiveReady: false });
    expect(result.startDialog).toBeUndefined();
    expect(r.harness.supervisor.agentFor?.(handle.key)).toMatchObject({ status: 'blocked' });

    await vi.waitFor(() => {
      expect(r.harness.supervisor.agentFor?.(handle.key)).toMatchObject({ status: 'idle', interactiveReady: true });
    });
    expect(r.seam().launchHeld(handle.key)).toBe(false);
    expect(r.harness.scheduler.now()).toBe(0);
  });
});
