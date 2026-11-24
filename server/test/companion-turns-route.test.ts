/**
 * The route `GET /api/sessions/:id/companion/turns` and the flag `RAROG_COMPANION_SESSIONS`: the gate (demo, method,
 * voice agent, mode across sessions, `count`, a Claude Code session in scope), what the route hands the turns reader,
 * what it answers when the session or the device changes while the reader is pending, and the field
 * `companionSessions` in `GET /api/version`. The reader is a stand-in that records its calls; the reading itself is
 * tested in `companion-turns.test.ts` and against a live history path in `herdr-integration.test.ts`.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompanionTurns } from '@rarog/shared/rest';
import { companionTurnsSchema, versionResponseSchema } from '@rarog/shared/rest';
import type { CompanionTurnsReader, CompanionTurnsTarget } from '../src/companion/turns.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { parseCompanionSessionsEnabled } from '../src/config/flags.ts';
import { createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { type TestDevice, createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const CONV_A = '22222222-2222-4222-8222-222222222222';
const CONV_B = '33333333-3333-4333-8333-333333333333';
const CONV_C = '44444444-4444-4444-8444-444444444444';
const CONV_D = '55555555-5555-4555-8555-555555555555';
const STATE_SINCE = '2026-08-21T10:00:00.000Z';
const LATER = '2026-08-21T10:05:00.000Z';
/** The read mark of the stand-in manager's memory of a session (`FakeManager.readMarks`), and one after a message. */
const MARK = 'memory.0';
const NEWER_MARK = 'memory.7';

/** What the stand-in reader answers: one human message of the conversation it was asked about, and its token. */
const answerFor = (target: CompanionTurnsTarget): CompanionTurns => ({
  messages: [{
    seq: 1, role: 'user', blocks: [{ type: 'text', text: `prompt of ${target.agentSessionId ?? 'none'}` }],
    at: STATE_SINCE,
  }],
  conversation: `token-${target.agentSessionId ?? 'none'}`,
  stateSince: target.stateSince,
  readMark: target.readMark,
  complete: true,
});

interface Harness {
  base: string;
  auth: string;
  dir: string;
  manager: FakeManager;
  device: TestDevice;
  reads: { target: CompanionTurnsTarget; count: number }[];
  close(): Promise<void>;
}

interface HarnessOptions {
  /** `RAROG_COMPANION`; missing = no variable. */
  companion?: string;
  /** `RAROG_COMPANION_SESSIONS`; missing = no variable. */
  sessions?: string;
  demo?: boolean;
  /** The server's OpenAI and Soniox keys (the voice agent works only with both); default on. */
  keys?: boolean;
  /** No voice agent module in the router's dependencies (its assembly failed). */
  noFeature?: boolean;
  /**
   * Runs while read `n` (from 1) of the stand-in reader is pending, one turn of the event loop after the route asked:
   * a change of the session or the device in the middle of a read.
   */
  duringRead?: (n: number, h: Harness) => void;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rarog-turns-route-')));
  const project = join(dir, 'projekt');
  const env = {
    ...(opts.companion === undefined ? {} : { RAROG_COMPANION: opts.companion }),
    ...(opts.sessions === undefined ? {} : { RAROG_COMPANION_SESSIONS: opts.sessions }),
    ...(opts.keys === false ? {} : {
      OPENAI_API_KEY: 'sk-test-companion-turns', SONIOX_API_KEY: 'snx-test-companion-turns',
    }),
  };
  const config = opts.demo === true
    ? loadConfig({ RAROG_DEMO: '1', RAROG_ORIGINS: ORIGIN, ...env })
    : loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: dir, RAROG_DATA_DIR: join(dir, 'dane'), ...env });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const manager = new FakeManager([
    makeSummary({ id: 's1', cwd: project, stateSince: STATE_SINCE }),
    makeSummary({ id: 'cx', cwd: project, engine: 'codex' }),
    makeSummary({ id: 'poza', cwd: '/Users/u/Prywatne/birch', outOfScope: true }),
  ]);
  manager.conversations.set('s1', CONV_A);
  const hub = new SseHub({ manager, serverStartId: 'start', protocolVersion: 1, heartbeatMs: 0 });
  const reads: Harness['reads'] = [];
  const duringRead = opts.duringRead;
  const companionTurns: CompanionTurnsReader = {
    read: async (target, count) => {
      reads.push({ target, count });
      if (duringRead !== undefined) {
        const n = reads.length;
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        duringRead(n, h);
      }
      return answerFor(target);
    },
  };
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
    dir,
    manager,
    device,
    reads,
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

/** The mode across sessions on: the voice agent with both keys and `RAROG_COMPANION_SESSIONS=1`. */
const ON: HarnessOptions = { companion: '1', sessions: '1' };

function turns(h: Harness, id: string, query = '?count=3', method = 'GET'): Promise<Response> {
  return fetch(`${h.base}/api/sessions/${id}/companion/turns${query}`, {
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

async function version(h: Harness): Promise<Record<string, unknown>> {
  const res = await fetch(`${h.base}/api/version`, { headers: { Authorization: h.auth } });
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  expect(versionResponseSchema.parse(body)).toEqual(body);
  return body;
}

describe('companion turns: the flag `RAROG_COMPANION_SESSIONS`', () => {
  it('`1` turns it on; missing, empty and `0` leave it off; whitespace is ignored; another value stops the start', () => {
    expect(parseCompanionSessionsEnabled('1')).toBe(true);
    expect(parseCompanionSessionsEnabled(' 1 ')).toBe(true);
    expect(parseCompanionSessionsEnabled(undefined)).toBe(false);
    expect(parseCompanionSessionsEnabled('')).toBe(false);
    expect(parseCompanionSessionsEnabled('0')).toBe(false);
    expect(() => parseCompanionSessionsEnabled('true')).toThrow(ConfigError);
    expect(() => parseCompanionSessionsEnabled('yes')).toThrow(/RAROG_COMPANION_SESSIONS takes 1 or 0/u);
  });

  it('off by default; off in demo also at `1`; a wrong value stops the start also in demo', () => {
    const plain = { RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: tmpdir() };
    expect(loadConfig(plain).companionSessionsEnabled).toBe(false);
    expect(loadConfig({ ...plain, RAROG_COMPANION_SESSIONS: '1' }).companionSessionsEnabled).toBe(true);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_COMPANION_SESSIONS: '1' }).companionSessionsEnabled).toBe(false);
    expect(() => loadConfig({ RAROG_DEMO: '1', RAROG_COMPANION_SESSIONS: 'on' })).toThrow(ConfigError);
  });
});

describe('companion turns: `GET /api/version`', () => {
  it('the mode on with a working voice agent → `companionSessions: true`; the capability is always there', async () => {
    const body = await version(await startHarness(ON));
    expect(body['companionEnabled']).toBe(true);
    expect(body['companionSessions']).toBe(true);
    expect(body['capabilities']).toContain('companion-sessions');
  });

  it('the field is absent, never `false`: mode off, voice agent off, or demo', async () => {
    for (const opts of [{ companion: '1' }, { companion: '1', sessions: '0' }, { sessions: '1' }, { ...ON, demo: true }]) {
      const body = await version(await startHarness(opts));
      expect('companionSessions' in body, JSON.stringify(opts)).toBe(false);
      expect(body['capabilities'], JSON.stringify(opts)).toContain('companion-sessions');
    }
  });

  it('both flags without the OpenAI and Soniox keys: the version has no field, the route still answers', async () => {
    const h = await startHarness({ ...ON, keys: false });
    const body = await version(h);
    expect(body['companionEnabled']).toBe(false);
    expect('companionSessions' in body).toBe(false);
    expect((await turns(h, 's1')).status).toBe(200);
  });
});

describe('companion turns: the gate', () => {
  it('demo mode → 404 as an unknown path, the reader is not asked', async () => {
    const h = await startHarness({ ...ON, demo: true });
    const res = await turns(h, 's1');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ error: 'not-found', code: 'rest.endpoint-not-found' });
    expect(h.reads).toEqual([]);
  });

  it('POST → 405', async () => {
    const h = await startHarness(ON);
    expect((await turns(h, 's1', '?count=3', 'POST')).status).toBe(405);
    expect(h.reads).toEqual([]);
  });

  it('voice agent off, or its module missing → 503 `companion-disabled`', async () => {
    for (const opts of [{ sessions: '1' }, { companion: '0', sessions: '1' }, { ...ON, noFeature: true }]) {
      const h = await startHarness(opts);
      const res = await turns(h, 's1');
      expect(res.status, JSON.stringify(opts)).toBe(503);
      expect(await errorOf(res), JSON.stringify(opts)).toEqual({ error: 'companion-disabled', code: 'rest.companion-disabled' });
      expect(h.reads).toEqual([]);
    }
  });

  it('voice agent on, mode off → 503 `companion-sessions-disabled`', async () => {
    for (const sessions of [undefined, '0']) {
      const h = await startHarness({ companion: '1', ...(sessions === undefined ? {} : { sessions }) });
      const res = await turns(h, 's1');
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toEqual({
        error: 'companion-sessions-disabled', code: 'rest.companion-sessions-disabled',
      });
      expect(h.reads).toEqual([]);
    }
  });

  it('`count` that is not one digit from 1 to 3 (0, 4, missing, empty, 1.5, 03, -1, a letter) → 400', async () => {
    const h = await startHarness(ON);
    for (const query of ['?count=0', '?count=4', '', '?count=', '?count=1.5', '?count=03', '?count=-1', '?count=x']) {
      const res = await turns(h, 's1', query);
      expect(res.status, query).toBe(400);
      expect(await errorOf(res), query).toEqual({ error: 'bad-request', code: 'rest.companion-turns-count' });
    }
    expect(h.reads).toEqual([]);
  });

  it('a Codex session and a pane out of scope → 404 with the sentence "Claude Code only"', async () => {
    const h = await startHarness(ON);
    for (const id of ['cx', 'poza']) {
      const res = await turns(h, id);
      expect(res.status, id).toBe(404);
      expect(await errorOf(res), id).toEqual({ error: 'not-found', code: 'rest.companion-claude-only' });
    }
    expect(h.reads).toEqual([]);
  });

  it('unknown session → 404 `not-found`', async () => {
    const h = await startHarness(ON);
    const res = await turns(h, 'nie-ma');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ error: 'not-found', code: 'rest.session-not-found' });
  });
});

describe('companion turns: the answer', () => {
  it('200 with the reader\'s answer; the reader gets the directory, current conversation, `stateSince`, read mark and '
    + 'count', async () => {
    const h = await startHarness(ON);
    for (const count of [1, 2, 3]) {
      const res = await turns(h, 's1', `?count=${String(count)}`);
      expect(res.status).toBe(200);
      const body = companionTurnsSchema.parse(await res.json());
      expect(body).toEqual(answerFor({
        cwd: join(h.dir, 'projekt'), agentSessionId: CONV_A, stateSince: STATE_SINCE, readMark: MARK,
      }));
    }
    expect(h.reads).toEqual([1, 2, 3].map((count) => ({
      target: { cwd: join(h.dir, 'projekt'), agentSessionId: CONV_A, stateSince: STATE_SINCE, readMark: MARK }, count,
    })));
  });

  it('after `/clear` the reader is asked about the new conversation; before the first one about none', async () => {
    const h = await startHarness(ON);
    h.manager.changeConversation('s1', CONV_B);
    expect((await turns(h, 's1', '?count=1')).status).toBe(200);
    h.manager.conversations.delete('s1');
    expect((await turns(h, 's1', '?count=1')).status).toBe(200);
    expect(h.reads.map((read) => read.target.agentSessionId)).toEqual([CONV_B, undefined]);
  });
});

describe('companion turns: a change while the reader is pending', () => {
  const project = (h: Harness): string => join(h.dir, 'projekt');
  /**
   * `/clear` in the pane during read `n`: the session writes `conversation` now, with a later `stateSince`, and its
   * memory holds a newer message (the note of `/clear`).
   */
  const clearTo = (h: Harness, conversation: string): void => {
    h.manager.changeConversation('s1', conversation);
    h.manager.readMarks.set('s1', NEWER_MARK);
    const session = h.manager.sessions.get('s1');
    if (session !== undefined) h.manager.sessions.set('s1', { ...session, stateSince: LATER });
  };

  it('the conversation changes → the new one is read and sent with its token and `stateSince`, nothing of the old', async () => {
    const h = await startHarness({ ...ON, duringRead: (n, hh) => { if (n === 1) clearTo(hh, CONV_B); } });
    const res = await turns(h, 's1');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(companionTurnsSchema.parse(JSON.parse(text)))
      .toEqual(answerFor({ cwd: project(h), agentSessionId: CONV_B, stateSince: LATER, readMark: NEWER_MARK }));
    expect(text).not.toContain(CONV_A);
    expect(h.reads.map((read) => read.target)).toEqual([
      { cwd: project(h), agentSessionId: CONV_A, stateSince: STATE_SINCE, readMark: MARK },
      { cwd: project(h), agentSessionId: CONV_B, stateSince: LATER, readMark: NEWER_MARK },
    ]);
  });

  it('the same conversation with a new `stateSince` and a newer message → one read, sent with the `stateSince` and '
    + '`readMark` taken before it', async () => {
    const h = await startHarness({ ...ON, duringRead: (_n, hh) => { clearTo(hh, CONV_A); } });
    const res = await turns(h, 's1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answerFor({
      cwd: project(h), agentSessionId: CONV_A, stateSince: STATE_SINCE, readMark: MARK,
    }));
    expect(h.reads).toHaveLength(1);
  });

  it('the session leaves scope → 404 "Claude Code only"; it disappears → 404 `not-found`; nothing of the read', async () => {
    const cases: [(hh: Harness) => void, string][] = [
      [(hh) => {
        const session = hh.manager.sessions.get('s1');
        if (session !== undefined) hh.manager.sessions.set('s1', { ...session, outOfScope: true });
      }, 'rest.companion-claude-only'],
      [(hh) => { hh.manager.sessions.delete('s1'); }, 'rest.session-not-found'],
    ];
    for (const [change, code] of cases) {
      const h = await startHarness({ ...ON, duringRead: (_n, hh) => { change(hh); } });
      const res = await turns(h, 's1');
      expect(res.status, code).toBe(404);
      const text = await res.text();
      expect(text, code).not.toContain('prompt of');
      expect(JSON.parse(text), code).toMatchObject({ error: 'not-found', messageRef: { code } });
      expect(h.reads, code).toHaveLength(1);
    }
  });

  it('two changes in a row → the third read is sent', async () => {
    const next = [CONV_B, CONV_C];
    const h = await startHarness({
      ...ON, duringRead: (n, hh) => { const to = next[n - 1]; if (to !== undefined) clearTo(hh, to); },
    });
    const res = await turns(h, 's1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answerFor({
      cwd: project(h), agentSessionId: CONV_C, stateSince: LATER, readMark: NEWER_MARK,
    }));
    expect(h.reads.map((read) => read.target.agentSessionId)).toEqual([CONV_A, CONV_B, CONV_C]);
  });

  it('three changes in a row → the connection is dropped without a body after the third read', async () => {
    const next = [CONV_B, CONV_C, CONV_D];
    const h = await startHarness({
      ...ON, duringRead: (n, hh) => { const to = next[n - 1]; if (to !== undefined) clearTo(hh, to); },
    });
    await expect(turns(h, 's1').then((res) => res.text())).rejects.toThrow();
    expect(h.reads.map((read) => read.target.agentSessionId)).toEqual([CONV_A, CONV_B, CONV_C]);
  });

  it('the device is unpaired → 401 `device-revoked`, no messages in the body', async () => {
    const h = await startHarness({
      ...ON, duringRead: (_n, hh) => { hh.device.store.revoke(hh.device.id, 'admin'); },
    });
    const res = await turns(h, 's1');
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain('prompt of');
    expect(text).not.toContain('messages');
    expect(JSON.parse(text)).toMatchObject({ error: 'device-revoked' });
  });
});
