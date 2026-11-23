/**
 * The route `GET /api/companion/sessions`: its gate (demo, method, voice agent, mode across sessions, a paired
 * device), which sessions of the manager get a row and with which keys, and the `conversation` of a row against a turns
 * read of the same session through the same router. Both routes take their token function by default here (no token
 * injected), so a row and a turns read can only agree while they use one function. The catalog over a live session
 * manager is tested in `companion-catalog.test.ts`, the question marker in `companion-asks-owner.test.ts`.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TranscriptMessage } from '@rarog/shared';
import { companionSessionsSchema, companionTurnsSchema } from '@rarog/shared/rest';
import { createCompanionTurns } from '../src/companion/turns.ts';
import { loadConfig } from '../src/config.ts';
import { createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { type TestDevice, createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const CONV_A = '22222222-2222-4222-8222-222222222222';
const CONV_B = '33333333-3333-4333-8333-333333333333';
const CONV_C = '44444444-4444-4444-8444-444444444444';
const ASKED_SINCE = '2026-11-20T10:00:00.000Z';
const RUNNING_SINCE = '2026-11-20T10:05:00.000Z';

/** An agent message that ends with the owner's question block. */
const question = (seq: number): TranscriptMessage => ({
  seq, role: 'assistant', blocks: [{ type: 'text', text: 'Done.\n\n**Do Ciebie:** merge now or wait?' }],
  at: ASKED_SINCE,
});

interface Harness {
  base: string;
  auth: string;
  manager: FakeManager;
  device: TestDevice;
  close(): Promise<void>;
}

interface HarnessOptions {
  /** `RAROG_COMPANION`; missing = no variable. */
  companion?: string;
  /** `RAROG_COMPANION_SESSIONS`; missing = no variable. */
  sessions?: string;
  demo?: boolean;
  /** No voice agent module in the router's dependencies (its assembly failed). */
  noFeature?: boolean;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rarog-catalog-route-')));
  const project = join(dir, 'projekt');
  const env = {
    ...(opts.companion === undefined ? {} : { RAROG_COMPANION: opts.companion }),
    ...(opts.sessions === undefined ? {} : { RAROG_COMPANION_SESSIONS: opts.sessions }),
    OPENAI_API_KEY: 'sk-test-companion-catalog', SONIOX_API_KEY: 'snx-test-companion-catalog',
  };
  const config = opts.demo === true
    ? loadConfig({ RAROG_DEMO: '1', RAROG_ORIGINS: ORIGIN, ...env })
    : loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: dir, RAROG_DATA_DIR: join(dir, 'dane'), ...env });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const manager = new FakeManager([
    makeSummary({ id: 's1', cwd: project, state: 'waiting-input', stateSince: ASKED_SINCE }),
    makeSummary({ id: 's2', cwd: project, state: 'running', stateSince: RUNNING_SINCE }),
    makeSummary({ id: 'cx', cwd: project, engine: 'codex', state: 'waiting-input' }),
    makeSummary({ id: 'poza', cwd: '/Users/u/Prywatne/birch', outOfScope: true, state: 'waiting-input' }),
  ]);
  manager.conversations.set('s1', CONV_A);
  manager.conversations.set('s2', CONV_B);
  // The question stands as the newest message of every session; only `s1` waits for input in scope.
  for (const id of ['s1', 's2', 'cx', 'poza']) manager.lastMessages.set(id, question(1));
  const hub = new SseHub({ manager, serverStartId: 'start', protocolVersion: 1, heartbeatMs: 0 });
  // The real turns reader with its default token function and no conversation file: it answers the token alone.
  const companionTurns = createCompanionTurns({ locate: () => Promise.resolve(null), promptBlock: false });
  const companion = { ask: () => Promise.reject(new Error('the ask route is not under test')) };
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start', startedAtMs: Date.now(),
    logger: { info: () => {}, error: () => {} }, devices: device.identity, companionTurns,
    ...(opts.noFeature === true ? {} : { companion }),
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  const h: Harness = {
    base: `http://127.0.0.1:${String(port)}`,
    auth: device.authorization,
    manager,
    device,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      hub.closeAll();
      await rm(dir, { recursive: true, force: true });
    },
  };
  harnesses.push(h);
  return h;
}

/** The mode across sessions on: the voice agent and `RAROG_COMPANION_SESSIONS=1`. */
const ON: HarnessOptions = { companion: '1', sessions: '1' };

function catalog(h: Harness, method = 'GET'): Promise<Response> {
  return fetch(`${h.base}/api/companion/sessions`, {
    method,
    headers: {
      Authorization: h.auth,
      ...(method === 'GET' ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json' }),
    },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
}

async function errorOf(res: Response): Promise<{ error: string; code: string | undefined }> {
  const body = await res.json() as { error: string; messageRef?: { code: string } };
  return { error: body.error, code: body.messageRef?.code };
}

async function rows(h: Harness): Promise<ReturnType<typeof companionSessionsSchema.parse>['sessions']> {
  const res = await catalog(h);
  expect(res.status).toBe(200);
  return companionSessionsSchema.parse(await res.json()).sessions;
}

async function turnsToken(h: Harness, id: string): Promise<string> {
  const res = await fetch(`${h.base}/api/sessions/${id}/companion/turns?count=1`, { headers: { Authorization: h.auth } });
  expect(res.status).toBe(200);
  return companionTurnsSchema.parse(await res.json()).conversation;
}

describe('companion catalog route: the gate', () => {
  it('demo mode → 404 as an unknown path', async () => {
    const res = await catalog(await startHarness({ ...ON, demo: true }));
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ error: 'not-found', code: 'rest.endpoint-not-found' });
  });

  it('POST → 405', async () => {
    expect((await catalog(await startHarness(ON), 'POST')).status).toBe(405);
  });

  it('voice agent off, or its module missing → 503 `companion-disabled`', async () => {
    for (const opts of [{ sessions: '1' }, { companion: '0', sessions: '1' }, { ...ON, noFeature: true }]) {
      const res = await catalog(await startHarness(opts));
      expect(res.status, JSON.stringify(opts)).toBe(503);
      expect(await errorOf(res), JSON.stringify(opts)).toEqual({
        error: 'companion-disabled', code: 'rest.companion-disabled',
      });
    }
  });

  it('voice agent on, mode off → 503 `companion-sessions-disabled`', async () => {
    for (const sessions of [undefined, '0']) {
      const res = await catalog(await startHarness({ companion: '1', ...(sessions === undefined ? {} : { sessions }) }));
      expect(res.status, String(sessions)).toBe(503);
      expect(await errorOf(res), String(sessions)).toEqual({
        error: 'companion-sessions-disabled', code: 'rest.companion-sessions-disabled',
      });
    }
  });

  it('a device unpaired before the request → 401 `device-revoked`, no row in the body', async () => {
    const h = await startHarness(ON);
    h.device.store.revoke(h.device.id, 'admin');
    const res = await catalog(h);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain('conversation');
    expect(JSON.parse(text)).toMatchObject({ error: 'device-revoked' });
  });
});

describe('companion catalog route: the answer', () => {
  it('200: a row only for the Claude Code sessions in scope, with exactly its keys', async () => {
    const h = await startHarness(ON);
    const sessions = await rows(h);
    expect(sessions.map((row) => row.id)).toEqual(['s1', 's2']);
    const [asked, running] = sessions;
    expect(Object.keys(asked ?? {}).sort()).toEqual(['asksOwner', 'conversation', 'id', 'stateSince']);
    expect(asked).toMatchObject({ id: 's1', asksOwner: true, stateSince: ASKED_SINCE });
    // In its turn the session has no field, also with the question as its newest message.
    expect(Object.keys(running ?? {}).sort()).toEqual(['conversation', 'id', 'stateSince']);
    expect(running).toMatchObject({ id: 's2', stateSince: RUNNING_SINCE });
  });

  it('`conversation` is the turns route\'s token of the same session, also after `/clear`', async () => {
    const h = await startHarness(ON);
    const before = await rows(h);
    for (const id of ['s1', 's2']) {
      expect(before.find((row) => row.id === id)?.conversation, id).toBe(await turnsToken(h, id));
    }
    expect(before[0]?.conversation).not.toBe(before[1]?.conversation);
    h.manager.changeConversation('s1', CONV_C);
    const after = await rows(h);
    const s1 = after.find((row) => row.id === 's1')?.conversation;
    expect(s1).toBe(await turnsToken(h, 's1'));
    expect(s1).not.toBe(before.find((row) => row.id === 's1')?.conversation);
    expect(after.find((row) => row.id === 's2')?.conversation).toBe(before.find((row) => row.id === 's2')?.conversation);
  });
});
