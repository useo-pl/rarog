/**
 * The voice agent's pick-up through `POST /api/sessions/:id/seen` (`docs/companion.md`, "Picking up a result"): the
 * body `{by, conversation, readMark}` from a turns read, its all-or-none rule, closed value and bounds, the mode across
 * sessions as a kill switch, the scope of the session catalogue, the 409 for a result the agent did not read (a newer
 * message in the session's memory, also one that came during the read, a turn whose messages have not reached the
 * server, another engine conversation, a read whose newest message was trimmed), and a body without `by` as from the
 * app.
 *
 * The manager is real, with the supervisor and driver fakes of `helpers/manager-herdr-atrapy.ts`, behind the real
 * router on an ephemeral port, as in `companion-send.test.ts`. The turns reader is real too, over a synthetic
 * conversation file, so an accepted pick-up comes from a read that returned messages; a read that found no file
 * returns none, and its pick-up gets the 409. The rules of the receipt itself have their manager tests in
 * `seen-marks-voice-agent.test.ts`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { SessionSummary } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import { conversationToken } from '../src/companion/conversation.ts';
import { createCompanionTurns } from '../src/companion/turns.ts';
import { loadConfig } from '../src/config.ts';
import type { DriverEvent, InternalBlock } from '../src/drivers/types.ts';
import type { NotifierLike } from '../src/notify/index.ts';
import { createRouter } from '../src/router.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { ENGINE_SESSION, FakeSupervisor, PROJECT, flush, makeAgent, makeDeps } from './helpers/manager-herdr-atrapy.ts';
import type { FakeSeenMark } from './helpers/manager-herdr-atrapy.ts';
import { agentLine, turnLines, userLine } from './helpers/plik-rozmowy.ts';
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
  /** The durable seen marks, as in `herdr-hidden.json`. */
  marks: Map<string, FakeSeenMark>;
  /** Sessions whose pending push the notifier cancelled. */
  dismissed: string[];
  row(id?: string): SessionSummary | undefined;
  post(body: unknown, opts?: { id?: string; raw?: string; auth?: boolean }): Promise<{
    status: number; body: Record<string, unknown>;
  }>;
  /**
   * The voice agent's read of the session: `GET …/companion/turns?count=1` through the real turns reader, over the
   * rig's conversation file of one turn.
   */
  turns(): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Turns reads from now on find no conversation file: the reader's `locate` answers `null`. */
  withoutFile(): void;
  /** The rig's conversation file holds `text` from now on. */
  writeConversation(text: string): Promise<void>;
  /**
   * The next turns read waits in its file lookup, after the route took the session, until `release` runs; `reached`
   * resolves once it waits.
   */
  holdRead(): { reached: Promise<void>; release: () => void };
  /** Events of the pane's driver, one after another. */
  feed(...events: DriverEvent[]): Promise<void>;
}

const text = (value: string): InternalBlock[] => [{ type: 'text', text: foreign(value) }];

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
  const marks = new Map<string, FakeSeenMark>();
  const dismissed: string[] = [];
  const notifier: NotifierLike = {
    note: () => undefined, seen: (id) => { dismissed.push(id); }, forget: () => undefined, quiet: () => undefined,
  };
  const manager = await createManager({
    demo: false, dataDir: join(dataDir, 'manager'), herdrSupervisor: supervisor, herdrDeps: makeDeps(marks),
    herdrRoots: [PROJECT], herdrSend: true, now: () => (clock += 1000), gitStatus: null, gitWatcher: null,
    liveSessionsReader: () => Promise.resolve(null), notifier,
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
  /*
   * The real turns reader over a conversation file of one turn, the same file for each engine conversation of the
   * pane: a read that returns messages carries the read mark the route took of the session.
   */
  const store = join(dataDir, 'store');
  await mkdir(store, { recursive: true });
  const conversationFile = join(store, 'conversation.jsonl');
  await writeFile(conversationFile, turnLines(1));
  let file: string | null = conversationFile;
  let hold: { reached: () => void; released: Promise<void> } | undefined;
  const companionTurns = createCompanionTurns({
    locate: async () => {
      const held = hold;
      hold = undefined;
      if (held !== undefined) {
        held.reached();
        await held.released;
      }
      return file;
    },
    promptBlock: true,
  });
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'seen', startedAtMs: Date.now(), logger: { info: () => {}, error: () => {} },
    devices: device.identity, companion, companionTurns,
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
    manager, supervisor, marks, dismissed,
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
    turns: async () => {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/sessions/${ID}/companion/turns?count=1`, {
        headers: { Origin: ORIGIN, Authorization: device.authorization },
      });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    },
    withoutFile: () => { file = null; },
    writeConversation: (text) => writeFile(conversationFile, text),
    holdRead: () => {
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { hold = { reached: resolve, released }; });
      return { reached, release };
    },
    feed: async (...events) => {
      for (const event of events) {
        supervisor.driver(KEY).queue.push(event);
        await flush();
      }
    },
  };
}

/**
 * The body a turns read of the session now gives when it returns messages: its conversation token and the read mark
 * the route takes (`readMark` of the answer), built without the read for the cases about the body, the gate and the
 * conversation.
 */
const pickUpBody = (r: Rig, id = ID, conversation = ENGINE_SESSION): Record<string, string> => ({
  by: 'voice-agent', conversation: conversationToken(conversation),
  readMark: r.manager.companionTarget(id)?.readMark ?? 'out-of-scope.0',
});

/** The row of a result nobody received: herdr's `done`, no receiver. */
function expectUnreceived(row: SessionSummary | undefined): void {
  expect(row?.seen).toBe(false);
  expect(row).not.toHaveProperty('seenBy');
}

describe('POST /api/sessions/:id/seen from the voice agent', () => {
  it('right after a turns read with nothing new: 200, the list row has `seen: true` and `seenBy`, herdr clears `done`',
    async () => {
    const r = await rig();
    const read = await r.turns();
    expect(read.status).toBe(200);
    expect(read.body['messages']).not.toEqual([]);
    const res = await r.post({ by: 'voice-agent', conversation: read.body['conversation'], readMark: read.body['readMark'] });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(r.row()?.seen).toBe(true);
    expect(r.row()?.seenBy).toBe('voice-agent');
    await flush();
    expect(r.supervisor.focusCalls).toEqual([KEY]);
  });

  it('a turns read that found no conversation file: the answer has no messages, its pick-up gets 409, the result in '
    + 'the server\'s memory stays unreceived', async () => {
    const r = await rig();
    await r.feed({ type: 'message', role: 'assistant', blocks: text('The build is green.') });
    expect(r.row()?.state).toBe('waiting-input');
    expectUnreceived(r.row());
    r.withoutFile();
    const read = await r.turns();
    expect(read.status).toBe(200);
    expect(read.body['messages']).toEqual([]);

    const res = await r.post({ by: 'voice-agent', conversation: read.body['conversation'], readMark: read.body['readMark'] });
    expect(res.status).toBe(409);
    expect((res.body['messageRef'] as { code: string }).code).toBe('session.seen-result-changed');
    expectUnreceived(r.row());
    await flush();
    expect(r.dismissed).toEqual([]);
    expect(r.supervisor.focusCalls).toEqual([]);
    expect(r.marks.size).toBe(0);
  });

  /*
   * The server's memory got the agent's entries one by one; the history read merges consecutive agent entries into one
   * message, which keeps its first 256 KiB and ends with the trimmed mark, so the short final result is not in the
   * answer.
   */
  it('a turns read whose newest message was trimmed to its start: the answer has messages but not the final result, '
    + 'its pick-up gets 409, the result in the server\'s memory stays unreceived', async () => {
    const r = await rig();
    const long = (letter: string): string => letter.repeat(150 * 1024);
    await r.feed(
      { type: 'message', role: 'assistant', blocks: text(long('a')) },
      { type: 'message', role: 'assistant', blocks: text(long('b')) },
      { type: 'message', role: 'assistant', blocks: text('The build is green.') },
    );
    expect(r.row()?.state).toBe('waiting-input');
    expectUnreceived(r.row());
    await r.writeConversation(userLine('build it', 1) + agentLine(long('a'), 1) + agentLine(long('b'), 1)
      + agentLine('The build is green.', 1));
    const read = await r.turns();
    expect(read.status).toBe(200);
    expect(read.body['messages']).toHaveLength(2);
    expect(JSON.stringify(read.body['messages'])).not.toContain('The build is green.');

    const res = await r.post({ by: 'voice-agent', conversation: read.body['conversation'], readMark: read.body['readMark'] });
    expect(res.status).toBe(409);
    expect((res.body['messageRef'] as { code: string }).code).toBe('session.seen-result-changed');
    expectUnreceived(r.row());
    await flush();
    expect(r.dismissed).toEqual([]);
    expect(r.supervisor.focusCalls).toEqual([]);
    expect(r.marks.size).toBe(0);
  });

  /*
   * A short turn typed in the terminal: herdr's `working` shorter than the supervisor's grace never reaches the driver
   * (`HERDR_WORKING_GRACE_MS` in `server/src/herdr/supervisor.ts`), so the manager gets only the turn's messages from
   * the conversation file and herdr's `done` at a higher state number. The state stays `waiting-input` and its
   * `stateSince` stays, so only the server's memory of the session tells the new result from the one the agent read.
   */
  it('a short turn ends after the agent read the session, with no change of state: the pick-up built from that read '
    + 'gets 409, the new result stays unreceived', async () => {
    const r = await rig();
    const read = await r.turns();
    expect(read.status).toBe(200);
    expect(read.body['messages']).not.toEqual([]);
    const since = r.row()?.stateSince;

    await r.feed(
      { type: 'message', role: 'user', blocks: text('and the tests?') },
      { type: 'message', role: 'assistant', blocks: text('All green.') },
      { type: 'agent-state', state: 'idle', stateChangeSeq: 13, seen: false },
    );
    expect(r.row()?.state).toBe('waiting-input');
    expect(r.row()?.stateSince).toBe(since);

    const res = await r.post({
      by: 'voice-agent', conversation: read.body['conversation'], readMark: read.body['readMark'],
    });
    expect(res.status).toBe(409);
    expect((res.body['messageRef'] as { code: string }).code).toBe('session.seen-result-changed');
    expectUnreceived(r.row());
    await flush();
    expect(r.dismissed).toEqual([]);
    expect(r.supervisor.focusCalls).toEqual([]);
    expect(r.marks.size).toBe(0);
    // The result that stays is the short turn's, at its state number.
    expect(await r.post({})).toEqual({ status: 200, body: { ok: true } });
    expect(r.marks.get(KEY)).toEqual({ agentSessionId: ENGINE_SESSION, stateChangeSeq: 13 });
  });

  /*
   * The session's memory holds what the server followed from the conversation file, while herdr reports the states
   * of a turn on its own: a turn whose `working` reaches the session can end before any of its messages do.
   */
  it('a turn with `working` ends after the agent read the session, before its messages reach the server: the pick-up '
    + 'built from that read gets 409, also once the messages arrive', async () => {
    const r = await rig();
    const read = await r.turns();
    expect(read.status).toBe(200);
    expect(read.body['messages']).not.toEqual([]);
    const body = { by: 'voice-agent', conversation: read.body['conversation'], readMark: read.body['readMark'] };

    await r.feed(
      { type: 'agent-state', state: 'working', stateChangeSeq: 13 },
      { type: 'agent-state', state: 'idle', stateChangeSeq: 14, seen: false },
    );
    expect(r.row()?.state).toBe('waiting-input');
    const early = await r.post(body);
    expect(early.status).toBe(409);
    expect((early.body['messageRef'] as { code: string }).code).toBe('session.seen-result-changed');
    expectUnreceived(r.row());

    await r.feed(
      { type: 'message', role: 'user', blocks: text('and the docs?') },
      { type: 'message', role: 'assistant', blocks: text('Updated.') },
    );
    expect((await r.post(body)).status).toBe(409);
    expectUnreceived(r.row());
    await flush();
    expect(r.dismissed).toEqual([]);
    expect(r.supervisor.focusCalls).toEqual([]);
    expect(r.marks.size).toBe(0);
  });

  it('a message reaches the session while the turns route reads the file: the answer carries the mark taken before '
    + 'the read, its pick-up gets 409; a new read picks up', async () => {
    const r = await rig();
    const held = r.holdRead();
    const pending = r.turns();
    await held.reached;
    await r.feed({ type: 'message', role: 'assistant', blocks: text('One more thing: the cache is cold.') });
    held.release();
    const read = await pending;
    expect(read.status).toBe(200);
    expect(read.body['messages']).not.toEqual([]);
    expect(read.body['readMark']).not.toBe(r.manager.companionTarget(ID)?.readMark);

    const res = await r.post({ by: 'voice-agent', conversation: read.body['conversation'], readMark: read.body['readMark'] });
    expect(res.status).toBe(409);
    expect((res.body['messageRef'] as { code: string }).code).toBe('session.seen-result-changed');
    expectUnreceived(r.row());
    expect(r.dismissed).toEqual([]);

    const again = await r.turns();
    expect(again.body['messages']).not.toEqual([]);
    expect(await r.post({ by: 'voice-agent', conversation: again.body['conversation'], readMark: again.body['readMark'] }))
      .toEqual({ status: 200, body: { ok: true } });
    expect(r.row()?.seenBy).toBe('voice-agent');
  });

  it('another read mark: 409 with its sentence, the row stays unreceived', async () => {
    const r = await rig();
    const current = pickUpBody(r)['readMark'] ?? '';
    for (const readMark of [`${current}0`, 'x']) {
      const res = await r.post({ ...pickUpBody(r), readMark });
      expect(res.status, readMark).toBe(409);
      expect(res.body['error']).toBe('bad-state');
      expect((res.body['messageRef'] as { code: string }).code).toBe('session.seen-result-changed');
    }
    expectUnreceived(r.row());
    await flush();
    expect(r.supervisor.focusCalls).toEqual([]);
  });

  it('the token of the conversation the agent read after `/resume` moved the session to another one with the same '
    + 'read mark: 409 with the same sentence, the row stays unreceived; the token of the new one picks up', async () => {
    const r = await rig();
    const read = pickUpBody(r);
    r.supervisor.driver(KEY).queue.push({ type: 'init', engineSessionId: OTHER_CONVERSATION, model: 'claude-opus-5' });
    await flush();
    expect(pickUpBody(r)['readMark']).toBe(read['readMark']);
    for (const conversation of [read['conversation'], conversationToken(undefined)]) {
      const res = await r.post({ ...read, conversation });
      expect(res.status, conversation).toBe(409);
      expect(res.body['error']).toBe('bad-state');
      expect((res.body['messageRef'] as { code: string }).code).toBe('session.seen-result-changed');
    }
    expectUnreceived(r.row());
    await flush();
    expect(r.supervisor.focusCalls).toEqual([]);

    const again = await r.turns();
    expect(again.body['conversation']).toBe(conversationToken(OTHER_CONVERSATION));
    expect(again.body['messages']).not.toEqual([]);
    expect(await r.post({ by: 'voice-agent', conversation: again.body['conversation'], readMark: again.body['readMark'] }))
      .toEqual({ status: 200, body: { ok: true } });
    expect(r.row()?.seenBy).toBe('voice-agent');
  });

  it('`by`, `conversation` and `readMark` all three or none, `by` only `voice-agent`, the token and the mark 1–64 '
    + 'characters: 400 before the gate of the flags', async () => {
    for (const flags of [{ companion: '1', sessions: '1' }, { companion: '1', sessions: '0' }] as const) {
      const r = await rig(flags);
      const body = pickUpBody(r);
      const { by, conversation, readMark } = body;
      const bodies = [
        { by }, { conversation }, { readMark }, { by, conversation }, { by, readMark }, { conversation, readMark },
        { ...body, by: 'human' }, { ...body, by: '' }, { ...body, conversation: '' }, { ...body, conversation: 'c'.repeat(65) },
        { ...body, readMark: '' }, { ...body, readMark: 'm'.repeat(65) },
        // The body of `by`, `stateSince` and `conversation` misses the mark.
        { by, stateSince: r.row()?.stateSince ?? '', conversation },
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
    const unknown = await r.post({ ...pickUpBody(r), readMark: 'x' }, { id: 'herdr-nope' });
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
      const read = await r.turns();
      expect(read.body['messages']).not.toEqual([]);
      const body = { by: 'voice-agent', conversation: read.body['conversation'], readMark: read.body['readMark'] };
      expect((await r.post(body)).status).toBe(200);
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
