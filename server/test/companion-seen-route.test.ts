/**
 * The voice agent's pick-up through `POST /api/sessions/:id/seen` (`docs/companion.md`, "Picking up a result"): the
 * body `{by, stateSince, conversation}`, its all-or-none rule, closed value and bounds, the mode across sessions as a
 * kill switch, the scope of the session catalogue, the 409 for a result the agent did not read (another `stateSince`,
 * another engine conversation), and a body without `by` as from the app.
 *
 * The manager is real, with the supervisor and driver fakes of `helpers/manager-herdr-atrapy.ts`, behind the real
 * router on an ephemeral port, as in `companion-send.test.ts`. The rules of the receipt itself have their manager
 * tests in `seen-marks-voice-agent.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { SessionSummary } from '@rarog/shared';
import { conversationToken } from '../src/companion/conversation.ts';
import { loadConfig } from '../src/config.ts';
import { createRouter } from '../src/router.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { ENGINE_SESSION, FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const KEY = 'w9:p72';
const OUTSIDE = 'w9:p73';
const idOf = (key: string): string => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`;
const ID = idOf(KEY);
/** The engine conversation the pane writes after `/resume`. */
const OTHER_CONVERSATION = '33333333-3333-4333-8333-333333333333';

interface Rig {
  manager: Manager;
  supervisor: FakeSupervisor;
  row(id?: string): SessionSummary | undefined;
  post(body: unknown, opts?: { id?: string; raw?: string; auth?: boolean }): Promise<{
    status: number; body: Record<string, unknown>;
  }>;
}

let dataDir = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-seen-route-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(dataDir, { recursive: true, force: true });
});

/**
 * One pane whose result nobody received (herdr `done` at state number 12) and one pane outside the scope of the voice
 * agent. `flags`: the voice agent with both keys and the mode across sessions, each `'1'` or `'0'`.
 */
async function rig(flags: { companion: '0' | '1'; sessions: '0' | '1' } = { companion: '1', sessions: '1' }):
  Promise<Rig> {
  const supervisor = new FakeSupervisor();
  supervisor.autoSettle = false;
  let clock = Date.parse('2026-11-20T10:00:00.000Z');
  const manager = await createManager({
    demo: false, dataDir: join(dataDir, 'manager'), herdrSupervisor: supervisor, herdrDeps: makeDeps(),
    herdrRoots: [PROJECT], herdrSend: true, now: () => (clock += 1000), gitStatus: null, gitWatcher: null,
    liveSessionsReader: () => Promise.resolve(null),
  });
  await manager.ready;
  supervisor.appear(makeAgent({ status: 'done', stateChangeSeq: 12 }));
  supervisor.appear(makeAgent({
    key: OUTSIDE, paneId: OUTSIDE, tabId: 'w9:t4', status: 'done', stateChangeSeq: 3, inScope: false,
    agentSessionId: '22222222-2222-4222-8222-222222222222',
  }));
  await flush();

  const config = loadConfig({
    RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: PROJECT, RAROG_DATA_DIR: join(dataDir, 'router'),
    RAROG_COMPANION: flags.companion, RAROG_COMPANION_SESSIONS: flags.sessions,
    OPENAI_API_KEY: 'sk-test-companion-seen', SONIOX_API_KEY: 'snx-test-companion-seen',
  });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const hub = new SseHub({ manager, serverStartId: 'seen', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  const companion = { ask: () => Promise.reject(new Error('the ask route is not under test')) };
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'seen', startedAtMs: Date.now(), logger: { info: () => {}, error: () => {} },
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
    manager, supervisor,
    row: (id = ID) => manager.list().find((s) => s.id === id),
    post: async (body, opts = {}) => {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/sessions/${opts.id ?? ID}/seen`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', Origin: ORIGIN,
          ...(opts.auth === false ? {} : { Authorization: device.authorization }),
        },
        body: opts.raw ?? JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    },
  };
}

/** The body the voice agent builds from a read of the session: its `stateSince` and its conversation token. */
const pickUpBody = (r: Rig, id = ID, conversation = ENGINE_SESSION): Record<string, string> => ({
  by: 'voice-agent', stateSince: r.row(id)?.stateSince ?? '', conversation: conversationToken(conversation),
});

/** The row of a result nobody received: herdr's `done`, no receiver. */
function expectUnreceived(row: SessionSummary | undefined): void {
  expect(row?.seen).toBe(false);
  expect(row).not.toHaveProperty('seenBy');
}

describe('POST /api/sessions/:id/seen from the voice agent', () => {
  it('the current `stateSince`: 200, the list row has `seen: true` and `seenBy`, herdr clears `done`', async () => {
    const r = await rig();
    const res = await r.post(pickUpBody(r));
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(r.row()?.seen).toBe(true);
    expect(r.row()?.seenBy).toBe('voice-agent');
    await flush();
    expect(r.supervisor.focusCalls).toEqual([KEY]);
  });

  it('another `stateSince`: 409 with its sentence, the row stays unreceived', async () => {
    const r = await rig();
    for (const stateSince of ['2026-11-20T09:00:00.000Z', 'x']) {
      const res = await r.post({ ...pickUpBody(r), stateSince });
      expect(res.status, stateSince).toBe(409);
      expect(res.body['error']).toBe('bad-state');
      expect((res.body['messageRef'] as { code: string }).code).toBe('session.seen-result-changed');
    }
    expectUnreceived(r.row());
    await flush();
    expect(r.supervisor.focusCalls).toEqual([]);
  });

  it('the token of the conversation the agent read after `/resume` moved the session to another one with the same '
    + '`stateSince`: 409 with the same sentence, the row stays unreceived; the token of the new one picks up', async () => {
    const r = await rig();
    const read = pickUpBody(r);
    r.supervisor.driver(KEY).queue.push({ type: 'init', engineSessionId: OTHER_CONVERSATION, model: 'claude-opus-5' });
    await flush();
    expect(r.row()?.stateSince).toBe(read['stateSince']);
    for (const conversation of [read['conversation'], conversationToken(undefined)]) {
      const res = await r.post({ ...read, conversation });
      expect(res.status, conversation).toBe(409);
      expect(res.body['error']).toBe('bad-state');
      expect((res.body['messageRef'] as { code: string }).code).toBe('session.seen-result-changed');
    }
    expectUnreceived(r.row());
    await flush();
    expect(r.supervisor.focusCalls).toEqual([]);

    expect(await r.post(pickUpBody(r, ID, OTHER_CONVERSATION))).toEqual({ status: 200, body: { ok: true } });
    expect(r.row()?.seenBy).toBe('voice-agent');
  });

  it('`by`, `stateSince` and `conversation` all three or none, `by` only `voice-agent`, the token 1–64 characters: '
    + '400 before the gate of the flags', async () => {
    for (const flags of [{ companion: '1', sessions: '1' }, { companion: '1', sessions: '0' }] as const) {
      const r = await rig(flags);
      const body = pickUpBody(r);
      const { by, stateSince, conversation } = body;
      const bodies = [
        { by }, { stateSince }, { conversation }, { by, stateSince }, { by, conversation }, { stateSince, conversation },
        { ...body, by: 'human' }, { ...body, by: '' }, { ...body, conversation: '' }, { ...body, conversation: 'c'.repeat(65) },
      ];
      for (const sent of bodies) {
        const res = await r.post(sent);
        expect(res.status, `${flags.sessions} ${JSON.stringify(sent)}`).toBe(400);
        expect(res.body['error']).toBe('bad-request');
      }
      expectUnreceived(r.row());
    }
  });

  it('the voice agent or its mode across sessions off: 503 and nothing changes', async () => {
    const cases = [
      { flags: { companion: '1', sessions: '0' }, error: 'companion-sessions-disabled' },
      { flags: { companion: '0', sessions: '1' }, error: 'companion-disabled' },
    ] as const;
    for (const { flags, error } of cases) {
      const r = await rig(flags);
      const res = await r.post(pickUpBody(r));
      expect(res.status, error).toBe(503);
      expect(res.body['error']).toBe(error);
      expect((res.body['messageRef'] as { code: string }).code).toBe(`rest.${error}`);
      expectUnreceived(r.row());
    }
  });

  it('a session out of the catalogue\'s scope: the 404 of the turns route; an unknown session: 404', async () => {
    const r = await rig();
    const outside = await r.post(pickUpBody(r, idOf(OUTSIDE)), { id: idOf(OUTSIDE) });
    expect(outside.status).toBe(404);
    expect((outside.body['messageRef'] as { code: string }).code).toBe('rest.companion-claude-only');
    expectUnreceived(r.row(idOf(OUTSIDE)));
    const unknown = await r.post({ ...pickUpBody(r), stateSince: 'x' }, { id: 'herdr-nope' });
    expect(unknown.status).toBe(404);
    expect(unknown.body['error']).toBe('not-found');
  });

  it('a device the server does not know: 401 and nothing changes', async () => {
    const r = await rig();
    const res = await r.post(pickUpBody(r), { auth: false });
    expect(res.status).toBe(401);
    expectUnreceived(r.row());
  });
});

describe('POST /api/sessions/:id/seen without `by`', () => {
  it('`{}` and an empty body as from the app, with the mode off: 200, received, no `seenBy`', async () => {
    for (const raw of ['{}', '']) {
      const r = await rig({ companion: '0', sessions: '0' });
      const res = await r.post(undefined, { raw });
      expect(res, JSON.stringify(raw)).toEqual({ status: 200, body: { ok: true } });
      expect(r.row()?.seen).toBe(true);
      expect(r.row()).not.toHaveProperty('seenBy');
    }
  });

  it('on a result the voice agent picked up: `seenBy` goes, `seen` stays, herdr gets no second `agent.focus`',
    async () => {
      const r = await rig();
      expect((await r.post(pickUpBody(r))).status).toBe(200);
      await flush();
      expect(r.row()?.seenBy).toBe('voice-agent');
      expect(r.supervisor.focusCalls).toEqual([KEY]);
      expect(await r.post({})).toEqual({ status: 200, body: { ok: true } });
      await flush();
      expect(r.row()?.seen).toBe(true);
      expect(r.row()).not.toHaveProperty('seenBy');
      expect(r.supervisor.focusCalls).toEqual([KEY]);
    });
});
