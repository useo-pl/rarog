/**
 * A prompt the voice agent across sessions sends through `POST /api/sessions/:id/messages` (`docs/companion.md`,
 * "Sending from the conversation"): the gate of `source` and `expectedConversation` (the mode across sessions as a
 * kill switch, the closed value of `source`, an older app without either field), the conversation check right before
 * the driver gets the text (`assertSendConversation` in `server/src/sessions/companion-scope.ts`) and the idempotency
 * of `clientMessageId` with both fields.
 *
 * The manager is real, with a herdr supervisor stand-in and a driver steered by the test (no socket, no conversation
 * file), behind the real router on an ephemeral port, as in `send-idempotent.test.ts`. The engine conversation comes
 * with the driver's `init`, as after `/clear` and `/resume` in production.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { HerdrMode } from '@rarog/shared';
import { conversationToken } from '../src/companion/conversation.ts';
import { loadConfig } from '../src/config.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { createRouter } from '../src/router.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const ROOT = '/Users/demo/Projects';
const KEY = 'w1:p1';
const CONV_A = '4b7f0d2e-9c61-4a3b-8e15-2d9f6c0a7b31';
const CONV_B = '7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const CID = '3f2b8c1e-7a4d-4e9b-9c21-5d6e7f8a9b0c';
const ORIGIN = 'http://localhost:8930';

class Driver extends AtrapaDrivera {
  /** The pane's conversation as the driver knows it; `undefined` = the driver does not tell. */
  agentSessionId: string | undefined = undefined;
}

class Supervisor extends AtrapaNadzorcy<Driver> {
  /** While set, the fresh mode read waits for it: a change of the session in the middle of a send. */
  heldMode: Promise<HerdrMode> | null = null;
  modeReads = 0;

  protected nowyDriver(key: string): Driver {
    return new Driver(key);
  }

  override ensureFreshMode(key: string): Promise<HerdrMode> {
    this.modeReads += 1;
    return this.heldMode ?? super.ensureFreshMode(key);
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

const agent: HerdrAgent = {
  key: KEY, paneId: KEY, tabId: 'w1:t1', agentSessionId: CONV_A, engine: 'claude', termId: null, cwd: `${ROOT}/atlas`,
  status: 'idle', title: 'atlas', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true,
  launchedByRarog: true, interactiveReady: true,
};
const ID = `herdr-${KEY.replace(/[^a-z0-9]/gi, '-')}`;
const init = (engineSessionId: string): DriverEvent => ({ type: 'init', engineSessionId, model: 'claude-opus-5' });

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

interface Rig {
  manager: Manager;
  supervisor: Supervisor;
  driver: Driver;
  push(...events: DriverEvent[]): Promise<void>;
  post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  /** User messages in the session's transcript (echoes of sends). */
  echoes(): string[];
}

let dataDir = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-companion-send-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * `flags`: the voice agent with both keys and the mode across sessions, each `'1'` or `'0'`. `conversation`: the engine
 * conversation herdr reports for the pane and the driver's `init` brings; `''` = none yet, and no `init`.
 */
async function rig(
  flags: { companion: '0' | '1'; sessions: '0' | '1' } = { companion: '1', sessions: '1' }, conversation = CONV_A,
): Promise<Rig> {
  const supervisor = new Supervisor();
  const deps: HerdrManagerDeps = {
    sessionIdFor: () => ID,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: () => Promise.resolve([]),
    writeUploadFiles: () => Promise.resolve([]),
    sweepUploads: () => Promise.resolve(),
  };
  const manager = await createManager({
    demo: false, dataDir: join(dataDir, 'manager'), herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [ROOT],
    now: () => Date.parse('2026-11-20T10:00:00.000Z'), gitStatus: null, gitWatcher: null,
    liveSessionsReader: () => Promise.resolve(null),
  });
  await manager.ready;
  supervisor.appear({ ...agent, agentSessionId: conversation });
  await flush();
  const driver = supervisor.driver(KEY);
  if (conversation !== '') driver.queue.push(init(conversation));
  driver.queue.push({ type: 'agent-state', state: 'idle', seen: true, mode: 'auto', stateChangeSeq: 1 });
  await flush();

  const config = loadConfig({
    RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: ROOT, RAROG_DATA_DIR: join(dataDir, 'router'),
    RAROG_COMPANION: flags.companion, RAROG_COMPANION_SESSIONS: flags.sessions,
    OPENAI_API_KEY: 'sk-test-companion-send', SONIOX_API_KEY: 'snx-test-companion-send',
  });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const hub = new SseHub({ manager, serverStartId: 'send', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  const companion = { ask: () => Promise.reject(new Error('the ask route is not under test')) };
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'send', startedAtMs: Date.now(), logger: { info: () => {}, error: () => {} },
    devices: device.identity, companion,
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    hub.closeAll();
    await manager.dispose();
    supervisor.dispose();
  });
  return {
    manager, supervisor, driver,
    push: async (...events) => {
      for (const event of events) driver.queue.push(event);
      await flush();
    },
    post: async (body) => {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/sessions/${ID}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: device.authorization },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    },
    echoes: () => manager.transcript(ID).messages.filter((m) => m.role === 'user')
      .map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')),
  };
}

describe('messages from the voice agent: the gate of the two fields', () => {
  it('the mode across sessions off: a body with source and expectedConversation is a 503 and nothing is sent',
    async () => {
      const cases = [
        { flags: { companion: '1', sessions: '0' }, error: 'companion-sessions-disabled' },
        { flags: { companion: '0', sessions: '1' }, error: 'companion-disabled' },
      ] as const;
      for (const { flags, error } of cases) {
        const r = await rig(flags);
        const res = await r.post({
          text: 'run the tests', source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
        });
        expect(res.status, error).toBe(503);
        expect(res.body['error']).toBe(error);
        expect((res.body['messageRef'] as { code: string }).code).toBe(`rest.${error}`);
        expect(r.driver.sent).toEqual([]);
        expect(r.echoes()).toEqual([]);
      }
    });

  it('one field without the other is a 400, with the mode on and before the 503 of the mode off; nothing is sent',
    async () => {
      for (const flags of [{ companion: '1', sessions: '1' }, { companion: '1', sessions: '0' }] as const) {
        const r = await rig(flags);
        for (const extra of [{ source: 'voice-agent' }, { expectedConversation: conversationToken(CONV_A) }]) {
          const res = await r.post({ text: 'run the tests', ...extra });
          expect(res.status, `${flags.sessions} ${JSON.stringify(extra)}`).toBe(400);
          expect(res.body['error']).toBe('bad-request');
        }
        expect(r.driver.sent).toEqual([]);
        expect(r.echoes()).toEqual([]);
      }
    });

  it('an unknown source is a 400 and nothing is sent', async () => {
    const r = await rig();
    const res = await r.post({ text: 'run the tests', source: 'phone', expectedConversation: conversationToken(CONV_A) });
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe('bad-request');
    expect(r.driver.sent).toEqual([]);
  });

  it('an older app that sends neither field: 202 as today, also with the mode off, and the send carries no source',
    async () => {
      const r = await rig({ companion: '0', sessions: '0' });
      const res = await r.post({ text: 'typed in the app', clientMessageId: CID });
      expect(res).toEqual({ status: 202, body: { ok: true, clientMessageId: CID } });
      expect(r.driver.sent).toEqual(['typed in the app']);
      expect(r.driver.sendOpts[0]?.source).toBeUndefined();
    });
});

describe('messages from the voice agent: the conversation it read', () => {
  it('the token of the conversation the session writes: 202, the driver gets the text with source voice-agent',
    async () => {
      const r = await rig();
      const res = await r.post({
        text: 'run the tests', source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
      });
      expect(res.status).toBe(202);
      expect(r.driver.sent).toEqual(['run the tests']);
      expect(r.driver.sendOpts[0]?.source).toBe('voice-agent');
      expect(r.echoes()).toEqual(['run the tests']);
    });

  it('the token from before /clear: 409 with its sentence, no text to the driver and no echo', async () => {
    const r = await rig();
    await r.push(init(CONV_B));
    const res = await r.post({
      text: 'run the tests', source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'bad-state',
      message: 'The session moved to another conversation after the voice agent read it. Nothing was sent.',
      messageRef: { code: 'session.conversation-changed' },
    });
    expect(r.driver.sent).toEqual([]);
    expect(r.echoes()).toEqual([]);
    expect(r.manager.get(ID)?.state).toBe('waiting-input');
  });

  it('the driver moved to the new conversation before the manager heard init: 409, nothing reaches the driver',
    async () => {
      const r = await rig();
      // `session-changed` reached the driver; its `init` still waits in the event queue.
      r.driver.agentSessionId = CONV_B;
      const res = await r.post({
        text: 'run the tests', source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
      });
      expect(res.status).toBe(409);
      expect((res.body['messageRef'] as { code: string }).code).toBe('session.conversation-changed');
      expect(r.driver.sent).toEqual([]);
      // The same conversation on both sides passes.
      r.driver.agentSessionId = CONV_A;
      expect((await r.post({
        text: 'now', source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
      })).status).toBe(202);
      expect(r.driver.sent).toEqual(['now']);
    });

  it('the driver does not know the pane\'s conversation while the session has one: 409, nothing reaches the driver',
    async () => {
      const r = await rig();
      // herdr reports an empty conversation id while it does not know it yet; the card still says CONV_A.
      r.driver.agentSessionId = '';
      const res = await r.post({
        text: 'run the tests', source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
      });
      expect(res.status).toBe(409);
      expect((res.body['messageRef'] as { code: string }).code).toBe('session.conversation-changed');
      expect(r.driver.sent).toEqual([]);
      expect(r.echoes()).toEqual([]);
    });

  it('a session before its first conversation: the token of no conversation passes, another token is a 409',
    async () => {
      const r = await rig(undefined, '');
      r.driver.agentSessionId = '';
      expect(r.manager.get(ID)?.state).toBe('waiting-input');
      const other = await r.post({
        text: 'run the tests', source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
      });
      expect(other.status).toBe(409);
      expect(r.driver.sent).toEqual([]);
      const none = await r.post({
        text: 'run the tests', source: 'voice-agent', expectedConversation: conversationToken(undefined),
      });
      expect(none.status).toBe(202);
      expect(r.driver.sent).toEqual(['run the tests']);
    });

  it('/clear while the send waits for the fresh mode read: 409, nothing reaches the driver', async () => {
    const r = await rig();
    let release: (mode: HerdrMode) => void = () => {};
    r.supervisor.heldMode = new Promise<HerdrMode>((resolve) => { release = resolve; });
    const pending = r.post({
      text: 'run the tests', source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
    });
    for (let i = 0; i < 50 && r.supervisor.modeReads === 0; i += 1) await flush(1);
    expect(r.supervisor.modeReads).toBe(1);
    await r.push(init(CONV_B));
    release('auto');
    const res = await pending;
    expect(res.status).toBe(409);
    expect(r.driver.sent).toEqual([]);
    expect(r.echoes()).toEqual([]);
  });

  it('the same clientMessageId twice: one send; after /clear the repeat answers replayed, not 409, and sends nothing',
    async () => {
      const r = await rig();
      const body = {
        text: 'run the tests', clientMessageId: CID, source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
      };
      expect(await r.post(body)).toEqual({ status: 202, body: { ok: true, clientMessageId: CID } });
      expect(await r.post(body)).toEqual({ status: 202, body: { ok: true, clientMessageId: CID, replayed: true } });
      await r.push(init(CONV_B));
      expect(await r.post(body)).toEqual({ status: 202, body: { ok: true, clientMessageId: CID, replayed: true } });
      expect(r.driver.sent).toEqual(['run the tests']);
      expect(r.echoes()).toEqual(['run the tests']);
    });

  it('a refused send keeps the clientMessageId free: the same body 409s again, nothing is sent', async () => {
    const r = await rig();
    await r.push(init(CONV_B));
    const body = {
      text: 'run the tests', clientMessageId: CID, source: 'voice-agent', expectedConversation: conversationToken(CONV_A),
    };
    expect((await r.post(body)).status).toBe(409);
    expect((await r.post(body)).status).toBe(409);
    expect(r.driver.sent).toEqual([]);
  });
});
