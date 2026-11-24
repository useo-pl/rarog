/**
 * The Inbox on the wire (`docs/implementation-spec.md`, "Inbox"): the heads on the global stream opened with
 * `inbox=1`, `GET /api/inbox`, `GET /api/inbox/:sessionId`, `POST /api/inbox/:sessionId/remove|restore`, and the
 * `RAROG_INBOX` flag.
 *
 * A real session manager on the herdr supervisor and driver fakes, the Inbox of `assembleInbox` over a synthetic
 * conversation file, the real SSE hub and router on an ephemeral port, and two paired devices. The 401 without a key
 * and the 403 for a foreign `Origin` on every Inbox route stand in `routes.test.ts`; the card rules themselves in
 * `inbox.test.ts`.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { PermissionRequest } from '@rarog/shared';
import { inboxCardResponseSchema, inboxListSchema } from '@rarog/shared/rest';
import { foreign } from '@rarog/shared/sentences';
import { deviceAuthorization, hashSecret, pushKeyId } from '../src/auth/index.ts';
import { assembleInbox } from '../src/bootstrap/inbox.ts';
import type { InboxAssembly } from '../src/bootstrap/inbox.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import { INBOX_FILENAME } from '../src/inbox/index.ts';
import type { InboxActionResult, InboxCard } from '../src/inbox/index.ts';
import { type Logger, createRouter } from '../src/router.ts';
import type { InboxRoutesPort } from '../src/routes/inbox.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { ConsentManagerChannel, Manager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { ENGINE_SESSION, FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';
import { agentLine, lineTime, toolLines, userLine } from './helpers/plik-rozmowy.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const SECOND_ID = 'f0e1d2c3'.repeat(4);
const SECOND_SECRET = Buffer.alloc(32, 9).toString('base64url');
const silent: Logger = { info: () => {}, error: () => {} };

const WORKING: DriverEvent = { type: 'agent-state', state: 'working' };
const DONE: DriverEvent = { type: 'agent-state', state: 'idle', seen: false };
const PERMISSION: DriverEvent = {
  type: 'permission-request', reqId: 'tool-1', toolName: 'Bash', input: { command: 'pnpm test' },
  displayText: 'pnpm test',
};
const FIRST_TURN = userLine('prompt 1', 1) + agentLine('reading the file', 1) + toolLines(2) + agentLine('answer 1', 3);

type Frame = { readonly type: string } & Record<string, unknown>;

interface Stream {
  readonly frames: Frame[];
  close(): void;
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Rig {
  readonly manager: Manager;
  readonly parts: InboxAssembly | null;
  readonly id: string;
  readonly dataDir: string;
  feed(...events: DriverEvent[]): Promise<void>;
  /** A global stream of the first or the second device. */
  stream(query: string, device?: 'first' | 'second'): Promise<Stream>;
  get(path: string): Promise<Reply>;
  post(path: string, body: unknown, device?: 'first' | 'second'): Promise<Reply>;
}

let base = '';
let file = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-inbox-routes-'));
  file = join(base, `${ENGINE_SESSION}.jsonl`);
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(base, { recursive: true, force: true });
});

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

/** Time for a few card reads (quiet time 5 ms) and stream writes to land; used before asserting that nothing came. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

/**
 * One pane at `PROJECT` writing `file`, the server with `env` on top of the test origin and data directory, and the
 * consent channel `consent` when given.
 */
async function build(env: Record<string, string> = {}, consent?: ConsentManagerChannel): Promise<Rig> {
  const supervisor = new FakeSupervisor();
  const manager = await createManager({
    demo: false, dataDir: join(base, 'manager'), projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [],
    gitStatus: null, gitWatcher: null, liveSessionsReader: () => Promise.resolve(null), herdrSupervisor: supervisor,
    herdrDeps: makeDeps(), herdrRoots: [PROJECT], herdrSend: true, ...(consent === undefined ? {} : { consent }),
  });
  const dataDir = join(base, 'router');
  await mkdir(dataDir, { recursive: true });
  const config = loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: PROJECT, RAROG_DATA_DIR: dataDir, ...env });
  const parts = await assembleInbox({
    config, manager, ready: manager.ready, log: () => undefined, debounceMs: 5,
    locate: (_cwd, conversation) => Promise.resolve(conversation === ENGINE_SESSION ? file : null),
  });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const at = new Date().toISOString();
  const pushKey = Buffer.alloc(32, 5).toString('base64url');
  device.store.add({
    id: SECOND_ID, secretHash: hashSecret(SECOND_SECRET), pushKey, kid: pushKeyId(pushKey), label: 'iPad·test',
    build: null, createdAt: at, lastSeenAt: at, epoch: config.epoch, creator: 'admin',
  });
  const auth = { first: device.authorization, second: deviceAuthorization(SECOND_ID, SECOND_SECRET) };
  const hub = new SseHub({
    manager, serverStartId: 'inbox', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    ...(parts === null ? {} : { inbox: parts.heads }),
  });
  hub.start();
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'inbox', startedAtMs: Date.now(), logger: silent, devices: device.identity,
    ...(parts === null ? {} : { inbox: parts.inbox }),
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  const requests: http.ClientRequest[] = [];
  closers.push(async () => {
    for (const req of requests) req.destroy();
    hub.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    parts?.inbox.dispose();
    await parts?.inbox.flush();
    await manager.dispose();
    supervisor.dispose();
  });
  await manager.ready;
  supervisor.appear(makeAgent());
  await flush();
  const id = manager.list()[0]?.id ?? '';
  expect(id).not.toBe('');
  const driver = supervisor.driver(makeAgent().key);
  const call = async (method: string, path: string, body: unknown, who: 'first' | 'second'): Promise<Reply> => {
    const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method,
      headers: { Authorization: auth[who], Origin: ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return {
    manager, parts, id, dataDir,
    async feed(...events) {
      for (const event of events) driver.queue.push(event);
      await flush();
    },
    stream: (query, who = 'first') => new Promise<Stream>((resolve, reject) => {
      const frames: Frame[] = [];
      const req = http.get({
        host: '127.0.0.1', port, path: `/api/stream${query}`, headers: { Authorization: auth[who] },
      }, (res) => {
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const data = buffer.slice(0, end).split('\n').find((line) => line.startsWith('data: '));
            if (data !== undefined) frames.push(JSON.parse(data.slice('data: '.length)) as Frame);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf('\n\n');
          }
        });
        res.on('error', () => undefined);
        resolve({ frames, close: () => { req.destroy(); } });
      });
      req.on('error', (err) => { if (frames.length === 0) reject(err); });
      requests.push(req);
    }),
    get: (path) => call('GET', path, undefined, 'first'),
    post: (path, body, who = 'first') => call('POST', path, body, who),
  };
}

const inboxFrames = (stream: Stream): Frame[] => stream.frames.filter((frame) => frame.type.startsWith('inbox-'));

/** The cards of a consent channel the test holds; the manager reads them for its snapshots. */
interface Channel {
  readonly channel: ConsentManagerChannel;
  readonly cards: Map<string, ConsentCardView>;
  /** A change of a card from the channel cycle: the channel then holds `view` and the manager gets it. */
  change(manager: Manager, view: ConsentCardView): Promise<void>;
}

function consentChannel(): Channel {
  const cards = new Map<string, ConsentCardView>();
  return {
    cards,
    channel: {
      cards: () => [...cards.values()],
      decide: () => Promise.reject(new Error('not under test')),
      release: () => Promise.reject(new Error('not under test')),
      revoke: () => Promise.resolve([]),
      retire: () => Promise.resolve(),
      turnEnded: () => Promise.resolve(),
      reattached: () => Promise.resolve(),
    },
    async change(manager, view) {
      cards.set(view.permId, view);
      manager.applyConsentCard?.(view, null);
      await flush();
    },
  };
}

/** A consent channel card of the conversation `file` holds for the `Bash` command `command`, waiting for a person. */
function hookCard(permId: string, command: string, changes: Partial<ConsentCardView> = {}): ConsentCardView {
  return {
    permId, sessionId: ENGINE_SESSION, promptId: '22222222-2222-4222-8222-222222222222', toolName: 'Bash',
    agentId: null, presentation: { inputKind: 'shell', displayText: command, fields: [], notes: [], bytes: command.length },
    state: 'pending', canAllow: true, canDeny: true, canRelease: true, unavailable: null, cause: null, late: false,
    createdAt: Date.parse('2026-11-20T10:00:00.000Z'), ...changes,
  };
}

/** The request id a decision card's dialog names. */
const requestIdOf = (card: InboxCard | null): string | undefined => {
  const dialog = card?.dialog;
  return dialog === undefined || dialog.kind === 'panel' ? undefined : dialog.requestId;
};

const inboxHeads = (stream: Stream): { version: string }[] => inboxFrames(stream)
  .flatMap((frame) => (frame.type === 'inbox-head' ? [frame['head'] as { version: string }] : []));

/** The rig with the first turn ended: its result card is visible and its head published. */
async function withResultCard(env: Record<string, string> = {}): Promise<Rig & { card: InboxCard }> {
  await writeFile(file, FIRST_TURN);
  const rig = await build(env);
  await rig.feed(WORKING, DONE);
  const parts = rig.parts;
  if (parts === null) throw new Error('the Inbox is off');
  await waitFor(() => parts.inbox.card(rig.id)?.state === 'waiting-input', 'result card');
  await waitFor(() => parts.heads.heads().length === 1, 'published head');
  const card = parts.inbox.card(rig.id);
  if (card === null) throw new Error('no card');
  return { ...rig, card };
}

describe('Inbox heads on the global stream', () => {
  it('`inbox=1`: hello, sessions-snapshot, then inbox-heads without the text; no parameter: no Inbox event', async () => {
    const rig = await withResultCard();
    const asked = await rig.stream('?inbox=1');
    const plain = await rig.stream('');
    await waitFor(() => asked.frames.length >= 3 && plain.frames.length >= 2, 'stream starts');
    expect(asked.frames.slice(0, 3).map((frame) => frame.type)).toEqual(['hello', 'sessions-snapshot', 'inbox-heads']);
    expect(asked.frames[2]?.['heads']).toEqual([{
      sessionId: rig.id, turnId: rig.card.turnId, version: rig.card.version, kind: 'result', state: 'waiting-input',
      at: lineTime(3),
    }]);

    // A change of the card reaches only the stream that asked.
    const res = await rig.post(`/api/inbox/${rig.id}/remove`, { turnId: rig.card.turnId, version: rig.card.version });
    expect(res.status).toBe(200);
    await waitFor(() => inboxFrames(asked).length === 2, 'inbox-removed');
    await settle();
    expect(inboxFrames(plain)).toEqual([]);
  });

  it('the end of a turn with a result sends one inbox-head; a message during the turn sends none', async () => {
    const rig = await withResultCard();
    const stream = await rig.stream('?inbox=1');
    await waitFor(() => stream.frames.length >= 3, 'stream starts');

    // The next turn starts: the head carries the session state, so it changes once, to `running`.
    await appendFile(file, userLine('prompt 2', 4));
    await rig.feed(WORKING);
    await waitFor(() => inboxFrames(stream).length === 2, 'head of the running turn');
    expect(inboxFrames(stream)[1]).toMatchObject({ type: 'inbox-head', head: { state: 'running', turnId: rig.card.turnId } });

    await appendFile(file, agentLine('reading more', 5));
    await rig.feed({ type: 'message', role: 'assistant', blocks: [{ type: 'text', text: foreign('reading more') }] });
    await settle();
    expect(inboxFrames(stream)).toHaveLength(2);

    await appendFile(file, toolLines(6) + agentLine('answer 2', 7));
    await rig.feed(DONE);
    await waitFor(() => inboxFrames(stream).length === 3, 'head of the ended turn');
    await settle();
    const after = inboxFrames(stream).slice(2);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ type: 'inbox-head', head: { state: 'waiting-input', kind: 'result', at: lineTime(7) } });
    expect((after[0]?.['head'] as { turnId: string }).turnId).not.toBe(rig.card.turnId);
  });
});

describe('Inbox routes', () => {
  it('`GET /api/inbox` gives the visible cards with their text, `GET /api/inbox/:id` one card with its version', async () => {
    const rig = await withResultCard();
    const wire = {
      sessionId: rig.id, turnId: rig.card.turnId, version: rig.card.version, kind: 'result', state: 'waiting-input',
      at: lineTime(3), text: 'answer 1', truncated: false,
    };
    const list = await rig.get('/api/inbox');
    expect(list).toEqual({ status: 200, body: { cards: [wire] } });
    expect(inboxListSchema.parse(list.body)).toEqual({ cards: [wire] });
    const one = await rig.get(`/api/inbox/${rig.id}`);
    expect(one).toEqual({ status: 200, body: { card: wire } });
    expect(inboxCardResponseSchema.parse(one.body)).toEqual({ card: wire });
    const version = await rig.get('/api/version');
    expect(version.body['capabilities']).toContain('inbox');
  });

  it('remove: a stale version is 409 without effect, the current one 200 with inbox-removed on both devices, '
    + 'a repeat 200 without a second effect; restore brings the card back', async () => {
    const rig = await withResultCard();
    const first = await rig.stream('?inbox=1', 'first');
    const second = await rig.stream('?inbox=1', 'second');
    await waitFor(() => first.frames.length >= 3 && second.frames.length >= 3, 'streams start');
    const ref = { turnId: rig.card.turnId, version: rig.card.version };

    const stale = await rig.post(`/api/inbox/${rig.id}/remove`, { ...ref, version: 'an-older-version' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'inbox-card-changed', messageRef: { code: 'rest.inbox-card-changed' } });
    await settle();
    expect(inboxFrames(first)).toHaveLength(1);
    expect((await rig.get('/api/inbox')).body['cards']).toHaveLength(1);
    expect(rig.manager.get(rig.id)?.seen).not.toBe(true);
    expect(existsSync(join(rig.dataDir, INBOX_FILENAME))).toBe(false);

    const removed = await rig.post(`/api/inbox/${rig.id}/remove`, ref, 'second');
    expect(removed).toEqual({ status: 200, body: { ok: true, changed: true } });
    const gone = { type: 'inbox-removed', sessionId: rig.id, turnId: rig.card.turnId };
    await waitFor(() => inboxFrames(first).length === 2 && inboxFrames(second).length === 2, 'inbox-removed');
    expect(inboxFrames(first)[1]).toEqual(gone);
    expect(inboxFrames(second)[1]).toEqual(gone);
    expect(await rig.get('/api/inbox')).toEqual({ status: 200, body: { cards: [] } });
    expect(await rig.get(`/api/inbox/${rig.id}`)).toEqual({ status: 200, body: {} });
    // Removing a result receives it, like opening the session.
    expect(rig.manager.get(rig.id)?.seen).toBe(true);
    expect(rig.manager.get(rig.id)).not.toHaveProperty('seenBy');

    const again = await rig.post(`/api/inbox/${rig.id}/remove`, ref);
    expect(again).toEqual({ status: 200, body: { ok: true, changed: false } });
    await settle();
    expect(inboxFrames(first)).toHaveLength(2);
    expect(inboxFrames(second)).toHaveLength(2);

    const restored = await rig.post(`/api/inbox/${rig.id}/restore`, ref);
    expect(restored).toEqual({ status: 200, body: { ok: true, changed: true } });
    await waitFor(() => inboxFrames(second).length === 3, 'inbox-head after restore');
    expect(inboxFrames(second)[2]).toMatchObject({ type: 'inbox-head', head: { sessionId: rig.id, turnId: ref.turnId } });
    expect(rig.manager.get(rig.id)?.seen).not.toBe(true);
  });

  it('an unknown session is 404 with the sentence of the registry', async () => {
    const rig = await withResultCard();
    for (const res of [
      await rig.get('/api/inbox/no-such-session'),
      await rig.post('/api/inbox/no-such-session/remove', { turnId: 't', version: 'v' }),
      await rig.post('/api/inbox/no-such-session/restore', { turnId: 't', version: 'v' }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'not-found', messageRef: { code: 'rest.session-not-found' } });
    }
  });

  it('a decision card carries the summary dialog and its request id, not the pending card', async () => {
    await writeFile(file, FIRST_TURN + userLine('run the tests', 4) + agentLine('running the tests', 5));
    const rig = await build();
    await rig.feed(WORKING, PERMISSION);
    const parts = rig.parts;
    if (parts === null) throw new Error('the Inbox is off');
    await waitFor(() => parts.inbox.card(rig.id)?.kind === 'decision', 'decision card');
    await waitFor(() => parts.heads.heads()[0]?.kind === 'decision', 'decision head');
    expect(parts.heads.heads()[0]?.dialog).toBe('permission');
    const res = await rig.get(`/api/inbox/${rig.id}`);
    expect(res.status).toBe(200);
    const dialog = (res.body['card'] as { dialog: Record<string, unknown> }).dialog;
    expect(dialog).toMatchObject({
      kind: 'permission', requestId: 'tool-1', waitingFor: { kind: 'permission', tool: 'Bash', text: 'pnpm test' },
    });
    expect(dialog).not.toHaveProperty('request');
    expect(inboxCardResponseSchema.safeParse(res.body).success).toBe(true);
  });
});

describe('Inbox decision cards of the consent channel', () => {
  it('losing and regaining the allow button gives a new version and head; a removal holds across it', async () => {
    await writeFile(file, FIRST_TURN + userLine('run the tests', 4) + agentLine('running the tests', 5));
    const consent = consentChannel();
    const rig = await build({}, consent.channel);
    const parts = rig.parts;
    if (parts === null) throw new Error('the Inbox is off');
    const stream = await rig.stream('?inbox=1');
    await rig.feed(WORKING);
    await consent.change(rig.manager, hookCard('h1', 'pnpm test'));
    await waitFor(() => requestIdOf(parts.inbox.card(rig.id)) === 'h1', 'decision card of h1');
    await waitFor(() => inboxHeads(stream).at(-1)?.version === parts.inbox.card(rig.id)?.version, 'head of h1');
    const allowed = parts.inbox.card(rig.id)?.version ?? '';
    const heads = inboxHeads(stream).length;

    // No session stream is open: only the head can tell the app that the buttons changed.
    await consent.change(rig.manager, hookCard('h1', 'pnpm test', { canAllow: false, unavailable: 'hook-dead' }));
    await waitFor(() => inboxHeads(stream).length === heads + 1, 'head without the allow button');
    const blocked = inboxHeads(stream).at(-1)?.version;
    expect(blocked).not.toBe(allowed);
    expect(blocked).toBe(parts.inbox.card(rig.id)?.version);
    expect(requestIdOf(parts.inbox.card(rig.id))).toBe('h1');

    await consent.change(rig.manager, hookCard('h1', 'pnpm test'));
    await waitFor(() => inboxHeads(stream).length === heads + 2, 'head with the allow button again');
    expect(inboxHeads(stream).at(-1)?.version).not.toBe(blocked);

    const card = parts.inbox.card(rig.id);
    if (card === null) throw new Error('no card');
    const removed = await rig.post(`/api/inbox/${rig.id}/remove`, { turnId: card.turnId, version: card.version });
    expect(removed).toEqual({ status: 200, body: { ok: true, changed: true } });
    await waitFor(() => inboxFrames(stream).at(-1)?.type === 'inbox-removed', 'inbox-removed');
    const frames = inboxFrames(stream).length;

    await consent.change(rig.manager, hookCard('h1', 'pnpm test', { canAllow: false, unavailable: 'hook-dead' }));
    await waitFor(() => parts.inbox.card(rig.id)?.version !== card.version, 'card without the allow button');
    await settle();
    expect(parts.inbox.removed(rig.id)).toBe(true);
    expect(await rig.get(`/api/inbox/${rig.id}`)).toEqual({ status: 200, body: {} });
    expect(inboxFrames(stream)).toHaveLength(frames);
  });

  it('fetching the card of one recovered consent card leaves the other unshown: it comes pending and gets its id', async () => {
    await writeFile(file, FIRST_TURN + userLine('run the tests', 4) + agentLine('running the tests', 5));
    const consent = consentChannel();
    // Both cards were recovered at the start: the channel holds them, no event announced them.
    consent.cards.set('h1', hookCard('h1', 'pnpm test'));
    consent.cards.set('h2', hookCard('h2', 'pnpm lint'));
    const rig = await build({}, consent.channel);
    const parts = rig.parts;
    if (parts === null) throw new Error('the Inbox is off');
    const events: { readonly type: string; readonly permId?: string; readonly request?: { readonly permId: string } }[] = [];
    rig.manager.onEvent((scope, _seq, event) => { if (scope === rig.id) events.push(event as (typeof events)[number]); });
    await rig.feed(WORKING);
    await consent.change(rig.manager, hookCard('h1', 'pnpm test', { late: true }));
    await waitFor(() => requestIdOf(parts.inbox.card(rig.id)) === 'h1', 'decision card of h1');

    const res = await rig.get(`/api/inbox/${rig.id}`);
    expect(res.status).toBe(200);
    expect((res.body['card'] as { dialog: unknown }).dialog).toMatchObject({ kind: 'permission', requestId: 'h1' });

    await consent.change(rig.manager, hookCard('h2', 'pnpm lint', { late: true }));
    expect(events.filter((event) => event.permId === 'h2' || event.request?.permId === 'h2').map((event) => event.type))
      .toEqual(['permission-pending']);

    await consent.change(rig.manager, hookCard('h1', 'pnpm test', { state: 'revoked' }));
    await waitFor(() => requestIdOf(parts.inbox.card(rig.id)) === 'h2', 'decision card of h2');
  });
});

describe('Inbox decision dialog on the wire', () => {
  const PENDING: PermissionRequest = {
    permId: 'p-1', sessionId: 's1', toolName: 'Bash', displayText: 'ls', risk: 'normal', cwd: PROJECT,
    createdAt: '2026-11-20T10:00:00.000Z',
  };
  const decision = (dialog: InboxCard['dialog']): InboxCard => ({
    sessionId: 's1', turnId: 't1', version: 'v1', kind: 'decision', state: 'waiting-permission',
    at: '2026-11-20T10:00:00.000Z', text: 'running ls', truncated: false, ...(dialog === undefined ? {} : { dialog }),
  });

  async function serve(card: InboxCard): Promise<Reply & { transcriptReads: number }> {
    const dir = await mkdtemp(join(base, 'fake-'));
    const config = loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: dir });
    const device = createTestDevice(config.dataDir, { epoch: config.epoch });
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    manager.transcriptResult = { messages: [], pendingPermissions: [PENDING], pendingQuestions: [] };
    const hub = new SseHub({ manager, serverStartId: 'fake', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
    const never = (): Promise<InboxActionResult> => Promise.reject(new Error('not under test'));
    const inbox: InboxRoutesPort = {
      visibleCards: () => [card], card: () => card, removed: () => false, remove: never, restore: never,
    };
    const server = http.createServer(createRouter({
      config, manager, hub, serverStartId: 'fake', startedAtMs: Date.now(), logger: silent, devices: device.identity, inbox,
    }));
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const res = await fetch(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/inbox/s1`, {
        headers: { Authorization: device.authorization },
      });
      return {
        status: res.status, body: await res.json() as Record<string, unknown>,
        transcriptReads: manager.calls.filter((call) => call.method === 'transcript').length,
      };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  }

  const waitingFor = { kind: 'permission', tool: 'Bash', text: 'ls' } as const;

  // Reading the transcript would mark every consent card of the session as shown, also those the answer lacks.
  it.each([
    ['a request id of a pending card', { kind: 'permission', waitingFor, requestId: 'p-1' }],
    ['no request id', { kind: 'permission', waitingFor }],
    ['a dialog in the pane without a card', { kind: 'panel', herdrDialog: 'trust' }],
  ] as const)('%s: the dialog as the tracker has it, without a transcript read', async (_name, dialog) => {
    const res = await serve(decision(dialog as InboxCard['dialog']));
    expect(res.status).toBe(200);
    expect((res.body['card'] as { dialog: unknown }).dialog).toEqual(dialog);
    expect(res.transcriptReads).toBe(0);
  });
});

describe('`RAROG_INBOX`', () => {
  it('missing, empty or `1` = on, `0` = off, anything else stops the start', () => {
    const flag = (value?: string): boolean => loadConfig({
      RAROG_DEMO: '1', ...(value === undefined ? {} : { RAROG_INBOX: value }),
    }).inboxEnabled;
    expect(flag()).toBe(true);
    expect(flag('')).toBe(true);
    expect(flag('1')).toBe(true);
    expect(flag('0')).toBe(false);
    expect(() => flag('off')).toThrow(ConfigError);
    expect(() => flag('off')).toThrow('RAROG_INBOX takes 1 or 0 (got: off).');
  });

  it('`0`: no capability, no Inbox event on an `inbox=1` stream, every route 503, `inbox.json` untouched', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = await build({ RAROG_INBOX: '0' });
    expect(rig.parts).toBeNull();
    const stream = await rig.stream('?inbox=1');
    await rig.feed(WORKING, DONE);
    await waitFor(() => rig.manager.get(rig.id)?.state === 'waiting-input', 'turn end');
    await waitFor(() => stream.frames.length >= 2, 'stream starts');
    await settle();
    expect(inboxFrames(stream)).toEqual([]);
    expect((await rig.get('/api/version')).body['capabilities']).not.toContain('inbox');
    for (const res of [
      await rig.get('/api/inbox'),
      await rig.get(`/api/inbox/${rig.id}`),
      await rig.post(`/api/inbox/${rig.id}/remove`, { turnId: 't', version: 'v' }),
      await rig.post(`/api/inbox/${rig.id}/restore`, { turnId: 't', version: 'v' }),
    ]) {
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: 'inbox-disabled', messageRef: { code: 'rest.inbox-disabled' } });
    }
    expect(existsSync(join(rig.dataDir, INBOX_FILENAME))).toBe(false);
  });
});
