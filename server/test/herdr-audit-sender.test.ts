/**
 * Who sent a prompt, in the herdr audit log: a message the voice agent across sessions sent (`SendOptions.source`)
 * leaves `sender: "voice-agent"` on each `prompt` entry of its text, on every path the driver takes to the pane (the
 * prompt with a stall guard, the prompt without a wait for a slash command, the paste of the queue while a turn runs).
 * A message without a sender leaves the line exactly as before the field existed. A queued voice agent message keeps
 * its sender across a server restart and, like any queued message, gets no key and no `prompt` entry once the pane
 * runs another conversation. The driver part runs on the fake client and a real follower
 * (`helpers/herdr-driver-atrapy.ts`); the line part on the real audit log in a temporary directory.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { createPromptQueueStore } from '../src/drivers/herdr/prompt-queue-store.ts';
import type { PromptQueueStore } from '../src/drivers/herdr/prompt-queue-store.ts';
import { createHerdrAuditLog, herdrAuditPath } from '../src/herdr/audit.ts';
import type { HerdrAuditEvent } from '../src/herdr/audit.ts';
import type { HerdrAgentInfo } from '../src/herdr/types.ts';
import {
  PANE, base, commandOpts, composerPane, drivenClock, makeDriver, pasteFlow, quiet, systemCodes, useDriverSandbox,
  waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const prompts = (audit: readonly { method: string; text?: string; sender?: string }[]) => audit
  .filter((entry) => entry.method === 'prompt').map(({ text, sender }) => ({ text, sender }));

describe('herdr driver: the sender on prompt entries', () => {
  it('an idle pane, the prompt with a stall guard: the entry carries sender voice-agent', async () => {
    const fx = await makeDriver();
    fx.driver.send('check the build', undefined, undefined, { source: 'voice-agent' });
    await waitFor(() => fx.audit.some((entry) => entry.method === 'prompt'), 'prompt entry');
    expect(fx.client.calls.filter((call) => call.method === 'prompt').map((call) => call.wait)).toEqual([true]);
    expect(prompts(fx.audit)).toEqual([{ text: 'check the build', sender: 'voice-agent' }]);
  });

  it('a slash command without a wait: the entry carries the sender too', async () => {
    const fx = await makeDriver();
    fx.driver.send('/compact', undefined, undefined, { ...commandOpts('/compact'), source: 'voice-agent' });
    await waitFor(() => fx.audit.some((entry) => entry.method === 'prompt'), 'prompt entry');
    expect(fx.client.calls.filter((call) => call.method === 'prompt').map((call) => call.wait)).toEqual([undefined]);
    expect(prompts(fx.audit)).toEqual([{ text: '/compact', sender: 'voice-agent' }]);
  });

  it('a turn runs, the message goes through the paste queue: the paste entry carries the sender, the Enter not', async () => {
    const clock = drivenClock();
    const fx = await makeDriver({ agent: { status: 'working' }, deps: { scheduler: clock.scheduler } });
    composerPane(fx);
    fx.driver.send('one more thing', undefined, undefined, { echo: 'e1', source: 'voice-agent' });
    await clock.advance(0);
    expect(pasteFlow(fx)).toEqual(['paste:one more thing', 'enter']);
    expect(fx.audit.map((entry) => [entry.method, entry.sender])).toEqual([
      ['prompt', 'voice-agent'], ['send_keys', undefined],
    ]);
  });

  it('a message without a sender: no sender key on its entry', async () => {
    const fx = await makeDriver();
    fx.driver.send('typed in the app');
    await waitFor(() => fx.audit.some((entry) => entry.method === 'prompt'), 'prompt entry');
    const entry = fx.audit.find((one) => one.method === 'prompt');
    expect(entry && 'sender' in entry).toBe(false);
  });
});

describe('herdr driver: a voice agent message in the paste queue', () => {
  type Signal = Awaited<ReturnType<NonNullable<HerdrDriverDeps['consentRegistryRead']>>>;
  const WAITING: Signal = { kind: 'waiting', dialog: 'permission' };
  const ACTIVE: Signal = { kind: 'active' };
  const OTHER = '0b6c1f5e-4d1a-4c55-9a3e-2f1e9d7c8b6a';
  const stores: PromptQueueStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });
  /** `voiceAgentSends`: the voice agent and its mode across sessions on at this start (the message route's gate). */
  const newStore = (voiceAgentSends = true): PromptQueueStore => {
    const store = createPromptQueueStore({ dataDir: join(base, 'data'), voiceAgentSends });
    stores.push(store);
    return store;
  };
  /** A Claude pane mid-turn, a registry signal the test flips (a dialog holds the queue) and the store on disk. */
  const queuePane = async (store: PromptQueueStore, registry: { now: Signal }): Promise<Fixture> => {
    const fx = await makeDriver({
      agent: { status: 'working' },
      deps: {
        promptStore: store, promptRetryMs: 5, promptSubmitSettleMs: 20,
        consentRegistryRead: () => Promise.resolve(registry.now),
      },
    });
    composerPane(fx);
    return fx;
  };

  it('accepted while a turn runs, then the pane moves to another conversation: no paste, no prompt entry, the note',
    async () => {
      const registry: { now: Signal } = { now: WAITING };
      const fx = await queuePane(newStore(), registry);
      fx.driver.send('run the tests', undefined, undefined, { echo: 'e1', source: 'voice-agent' });
      await fx.driver.queueSaved?.();
      await quiet();
      fx.client.getAgent = (): Promise<HerdrAgentInfo> => Promise.resolve({
        paneId: PANE, agentSessionId: OTHER, engine: 'claude', status: 'working',
      } as HerdrAgentInfo);
      fx.emit({ type: 'session-changed', agentSessionId: OTHER });
      registry.now = ACTIVE;
      await waitFor(() => systemCodes(fx.events).includes('commands.send-session-changed'), 'refusal note');
      await quiet();
      expect(pasteFlow(fx)).toEqual([]);
      expect(fx.audit.filter((entry) => entry.method === 'prompt')).toEqual([]);
      expect(fx.events).toContainEqual({ type: 'echo-refused', token: 'e1' });
    });

  it('a server restart before the paste: the restored paste still carries sender voice-agent', async () => {
    const registry: { now: Signal } = { now: WAITING };
    const store = newStore();
    const fx = await queuePane(store, registry);
    fx.driver.send('run the tests', undefined, undefined, { echo: 'e1', source: 'voice-agent' });
    await fx.driver.queueSaved?.();
    await quiet();
    expect(pasteFlow(fx)).toEqual([]);
    // Shutdown: the store closes first, then the driver goes; the next start reads the same directory.
    await store.close();
    fx.driver.dispose();

    const fx2 = await queuePane(newStore(), registry);
    registry.now = ACTIVE;
    await waitFor(() => pasteFlow(fx2).length === 2, 'restored paste and Enter');
    expect(pasteFlow(fx2)).toEqual(['paste:run the tests', 'enter']);
    expect(prompts(fx2.audit)).toEqual([{ text: 'run the tests', sender: 'voice-agent' }]);
  });

  it('a server restart with the voice agent\'s sends off: the marked message is not pasted, has no prompt entry and '
    + 'leaves the file; a typed message queued with it goes as today', async () => {
    const registry: { now: Signal } = { now: WAITING };
    const store = newStore();
    const fx = await queuePane(store, registry);
    fx.driver.send('run the tests', undefined, undefined, { echo: 'e1', source: 'voice-agent' });
    await fx.driver.queueSaved?.();
    fx.driver.send('typed in the app', undefined, undefined, { echo: 'e2' });
    await fx.driver.queueSaved?.();
    await quiet();
    expect(pasteFlow(fx)).toEqual([]);
    await store.close();
    fx.driver.dispose();

    const store2 = newStore(false);
    const fx2 = await queuePane(store2, registry);
    registry.now = ACTIVE;
    await waitFor(() => pasteFlow(fx2).length === 2, 'restored paste and Enter of the typed message');
    await quiet();
    expect(pasteFlow(fx2)).toEqual(['paste:typed in the app', 'enter']);
    expect(prompts(fx2.audit)).toEqual([{ text: 'typed in the app', sender: undefined }]);
    await store2.close();
    const file = JSON.parse(await readFile(join(base, 'data', 'prompt-queue.json'), 'utf8')) as {
      entries: { text?: string; source?: string }[];
    };
    expect(file.entries.some((entry) => entry.source !== undefined || entry.text === 'run the tests')).toBe(false);
  });
});

describe('herdr audit log: the sender in the line', () => {
  const event: HerdrAuditEvent = {
    at: '2026-11-20T10:00:00.000Z', sessionId: 'herdr-w1-p1', key: 'w1:p1', paneId: 'w1:p1', cwd: '/Users/u/Projects/a',
    method: 'prompt', mode: 'auto', text: 'check the build',
  };

  async function lineOf(one: HerdrAuditEvent): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'rarog-audit-sender-'));
    try {
      const log = createHerdrAuditLog({ dataDir: dir });
      log.log(one);
      await log.flush();
      return await readFile(herdrAuditPath(dir), 'utf8');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('without a sender the line is byte for byte the line of a prompt without the field', async () => {
    expect(await lineOf(event)).toBe('{"ts":"2026-11-20T10:00:00.000Z","sessionId":"herdr-w1-p1","key":"w1:p1",'
      + '"paneId":"w1:p1","cwd":"/Users/u/Projects/a","method":"prompt","mode":"auto",'
      + '"textSha256":"ddf18d8f2073c91344cdd3914bfb897fdd0c150c68b8a9365aee83aaa47540bd","textHead":"check the build"}\n');
  });

  it('with sender voice-agent the key stands right after mode, the rest unchanged', async () => {
    const plain = await lineOf(event);
    const marked = await lineOf({ ...event, sender: 'voice-agent' });
    expect(marked).toBe(plain.replace('"mode":"auto",', '"mode":"auto","sender":"voice-agent",'));
  });

  it('a value outside the closed list never reaches the file', async () => {
    const forged = { ...event, sender: 'someone' } as unknown as HerdrAuditEvent;
    expect(await lineOf(forged)).toBe(await lineOf(event));
  });
});
