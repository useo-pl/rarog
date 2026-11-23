/** Rzeczywisty HTTP/SSE + manager: bramki transportu nie mogą udawać przyjęcia ani echa. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import type { ServerEvent } from '@rarog/shared';
import { phaseCounts } from '@rarog/shared/workflow-phases';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createRouter } from '../src/router.ts';
import { createManager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { createMockHerdr } from '../src/demo/mock-herdr.ts';
import { createDemoControl } from '../src/demo/control.ts';
import { SCENARIO_BLOCKED_PROMPT, SCENARIO_BLOCKED_REASON } from '../src/demo/scenarios.ts';
import { DEMO_NOTE_CWD, DEMO_NOTE_UPDATED_AT, createDemoNotes } from '../src/demo/notes.ts';
import { onlyWaitingAgents, tasksBlockRestart, tasksHoldingDonePush } from '../src/herdr/background/work.ts';
import { DEMO_ARTIFACT_TITLES, DEMO_PULL_REQUESTS, DEMO_SCHEDULED_TASKS } from '../src/demo/seeds.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';

const ORIGIN = 'http://127.0.0.1:18999';
const logger = { info() {}, error() {} };
type Stats = {
  sessionId: string | null;
  config: {
    snapshot: string; messageResponse: string; echo: string; unauthorized: boolean; diffList: string; diffFile: string;
    frozenStream: string | null;
  };
  receivedMessages: { sessionId: string; clientMessageId: string | null }[];
  acceptedMessages: { sessionId: string; clientMessageId: string | null; replayed: boolean }[];
  receivedAnswers: { sessionId: string; qId: string }[];
  receivedDecisions: { sessionId: string; permId: string | null }[];
  driverSends: number; driverDecisions: number; driverAnswers: string[][][];
  diffRequests: number; diffListRequests: number; diffFileRequests: number; diffFilePaths: string[];
  notesGets: number; notesPuts: number; noteText: string | null;
  held: { snapshots: number; responses: number; echoes: number; diffs: number; streams: number };
  transcriptMessages: number;
};

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'rarog-control-'));
  const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dataDir, RAROG_ORIGINS: ORIGIN });
  const device = createTestDevice(dataDir, { epoch: config.epoch });
  const mock = createMockHerdr(demoContentPl);
  const manager = await createManager({
    ...config, demoContent: demoContentPl, herdrSupervisor: mock.supervisor, herdrDeps: mock.deps,
  });
  await manager.ready;
  // Notatki demo jak w `index.ts`: jeden magazyn w pamięci dla huba, routera i kontroli testów.
  const notes = createDemoNotes(demoContentPl);
  const hub = new SseHub({
    manager, serverStartId: 'm1-test', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    notesFor: (cwds) => notes.withNotes(cwds),
    // Compression as the demo server starts it (`bootstrap/sse.ts`, `RAROG_SSE_GZIP` on by default).
    gzip: config.sseGzip,
  });
  hub.start();
  const router = createRouter({
    config, manager, hub, serverStartId: 'm1-test', startedAtMs: Date.now(), logger, notes, devices: device.identity,
  });
  const control = createDemoControl(router, config, manager, mock.scenarioPanels, {
    store: notes, announce: (cwd, empty) => { hub.broadcast('global', null, { type: 'notes', cwd, empty }); },
  });
  const server = http.createServer(control.handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${String(port)}`;
  /** Nagłówek klucza urządzenia testowego dla tras aplikacji. */
  const auth = device.headers;
  const controlHeaders = { Origin: ORIGIN, 'X-Rarog-Demo-Token': 'demo', 'Content-Type': 'application/json' };
  const request = (body?: unknown) => fetch(`${base}/api/demo/control`, {
    method: body === undefined ? 'GET' : 'POST', headers: controlHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const stats = async () => (await (await request()).json()) as Stats;
  const command = async (body: unknown) => {
    const response = await request(body);
    expect(response.status).toBe(200);
    return await response.json() as Stats;
  };
  const create = async (scenario: string) => {
    const created = await command({ action: 'create', scenario });
    if (created.sessionId === null) throw new Error('missing M1 sessionId');
    return created.sessionId;
  };
  const send = (id: string, clientMessageId: string, signal?: AbortSignal) => fetch(`${base}/api/sessions/${id}/messages`, {
    method: 'POST', headers: { Origin: ORIGIN, ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'M1 wiadomość trwała', clientMessageId }), signal,
  });
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { Origin: ORIGIN, ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    manager, config, router, mock, hub, base, port, auth, controlHeaders, request, stats, command, create, send, post,
    async close() {
      control.dispose();
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await manager.dispose();
      mock.dispose();
      await rm(dataDir, { force: true, recursive: true });
    },
  };
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('M1 condition timed out');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

function stream(h: Awaited<ReturnType<typeof harness>>, path: string, headers: Record<string, string> = {}) {
  let text = '';
  let encoding: string | undefined;
  let status: number | undefined;
  const req = http.get(`${h.base}${path}`, { headers: { ...h.auth, ...headers } }, (res) => {
    status = res.statusCode;
    encoding = res.headers['content-encoding'];
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => { text += chunk; });
  });
  req.on('error', () => { /* cleanup zabija celowo strumień testowy */ });
  return {
    events: (): ServerEvent[] => text.split('\n\n').flatMap((frame) => {
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      return data === undefined ? [] : [JSON.parse(data) as ServerEvent];
    }),
    /** `Content-Encoding` of the response, `undefined` before the headers or without compression. */
    encoding: () => encoding,
    /** Status code once the headers arrived, `undefined` before. */
    status: () => status,
    /** Every body byte received so far, comments and `retry:` included. */
    raw: () => text,
    close() { req.destroy(); },
  };
}

describe('kontrolowany odbiór demo, wyłącznie w trybie demo', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  it('poza demo nie instaluje endpointu; token i Origin chronią każde sterowanie i statystyki', async () => {
    expect(createDemoControl(h.router, { ...h.config, demo: false }, h.manager, h.mock.scenarioPanels).handler).toBe(h.router);
    for (const headers of [
      { ...h.controlHeaders, 'X-Rarog-Demo-Token': 'wrong' },
      { ...h.controlHeaders, Origin: 'https://evil.test' },
      { 'X-Rarog-Demo-Token': 'demo' },
    ]) {
      const response = await fetch(`${h.base}/api/demo/control`, { headers });
      expect(response.status).toBe(403);
    }
    expect((await h.request({ action: 'configure', extra: true })).status).toBe(400);
    expect((await h.request({ action: 'emit', sessionId: '../foreign', event: 'delta' })).status).toBe(400);
    const response = await fetch(`${h.base}/api/demo/control`, {
      method: 'POST', headers: h.controlHeaders, body: 'x'.repeat(8193),
    });
    expect(response.status).toBe(413);
    // GET aplikacji nadal używa zwykłego klucza urządzenia, bez nagłówków kontroli demo.
    expect((await fetch(`${h.base}/api/projects`, { headers: h.auth })).status).toBe(200);
    expect((await fetch(`${h.base}/api/projects`)).status).toBe(401);
  });

  it('reset usuwa tylko własny panel, a historia500 i karty powstają przez managera', async () => {
    const seeds = h.manager.list().map((session) => session.id);
    const stress = await h.create('stress500');
    expect(h.manager.transcript(stress).messages).toHaveLength(500);
    expect(h.manager.transcript(stress).messages[0]?.blocks).toEqual([
      { type: 'text', text: expect.stringContaining('M1 wiadomość 001') },
    ]);
    expect(h.manager.transcript(stress).messages[499]?.blocks).toEqual([
      { type: 'text', text: expect.stringContaining('| Zadanie | Stan |') },
    ]);
    const question = await h.create('question');
    const pending = h.manager.transcript(question).pendingQuestions[0];
    expect(pending).toMatchObject({ qId: 'm1-question', customAnswer: true, channel: 'hook' });
    expect(pending?.questions[0]?.options[1]?.terminalOnly).toBe(true);
    const permission = await h.create('cannot-allow');
    expect(h.manager.transcript(permission).pendingPermissions[0]).toMatchObject({ permId: 'm1-permission', canAllow: false });
    await h.command({ action: 'reset' });
    expect(h.manager.list().map((session) => session.id)).toEqual(seeds);
  });

  it('permission: zwykła zgoda na komendę we własnej sesji, odrzucenie ją zdejmuje, a karty seedów stoją dalej', async () => {
    const seedCards = () => h.manager.list().flatMap((session) =>
      h.manager.transcript(session.id, { peek: true }).pendingPermissions.map((request) => request.permId));
    const before = seedCards();
    expect(before).toContain('demo-perm-willow');
    const id = await h.create('permission');
    expect(h.manager.transcript(id).pendingPermissions).toEqual([expect.objectContaining({
      permId: 'm1-permission', toolName: 'Bash', canAllow: true, displayText: 'npm test -- --run src/notes.test.ts',
    })]);
    const denied = await h.post(`/api/sessions/${id}/permissions/m1-permission`, { decision: 'deny' });
    expect(denied.status).toBe(200);
    expect(h.manager.transcript(id).pendingPermissions).toEqual([]);
    expect(await h.stats()).toMatchObject({
      driverDecisions: 1, receivedDecisions: [{ sessionId: id, permId: 'm1-permission' }],
    });
    await h.command({ action: 'reset' });
    // Odbiór zgody zostaje w panelu odbioru: zgody seedów, z których korzystają kolejne testy UI, stoją nietknięte.
    expect(seedCards()).toEqual(before);
    expect(await h.stats()).toMatchObject({ sessionId: null, driverSends: 0, transcriptMessages: 0 });
  });

  it('create z katalogiem: sesja w podanym katalogu (długa nazwa projektu w nagłówku telefonu)', async () => {
    const cwd = '/Users/demo/Projects/przeprojektowanie-naglowka-telefonu';
    const created = await h.command({ action: 'create', scenario: 'idle', cwd });
    expect(h.manager.get(created.sessionId ?? '')?.cwd).toBe(cwd);
    expect((await h.request({ action: 'create', scenario: 'idle', cwd: 'Projects/wzgledna' })).status).toBe(400);
  });

  it('liczy odczyty diffa każdej sesji (panel apki nie pobiera patcha sam), reset zeruje licznik', async () => {
    const seed = h.manager.list()[0]?.id;
    if (seed === undefined) throw new Error('demo bez sesji');
    expect((await h.stats()).diffRequests).toBe(0);
    const diff = await fetch(`${h.base}/api/sessions/${seed}/diff`, { headers: h.auth });
    expect(diff.status).toBe(200);
    await fetch(`${h.base}/api/projects`, { headers: h.auth });
    expect((await h.stats()).diffRequests).toBe(1);
    await h.command({ action: 'reset' });
    expect((await h.stats()).diffRequests).toBe(0);
  });

  /*
   * Notatki projektu: demo trzyma je w pamięci, a test UI apki dowodzi licznikami, że dymek czyta, a zamknięcie
   * formularza zapisuje. `reset` wraca do zasiewu, bo klasy testów UI dzielą jeden serwer demo.
   */
  it('notatki demo: odczyt zasiewu, zapis, 409, liczniki GET/PUT, reset zasiewa od nowa', async () => {
    const url = `${h.base}/api/notes`;
    const read = await fetch(`${url}?cwd=${encodeURIComponent(DEMO_NOTE_CWD)}`, { headers: h.auth });
    expect(await read.json()).toEqual({ text: demoContentPl.noteText, updatedAt: DEMO_NOTE_UPDATED_AT });
    const put = (text: string, updatedAt: number) => fetch(url, {
      method: 'PUT', headers: { Origin: ORIGIN, ...h.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: DEMO_NOTE_CWD, text, updatedAt }),
    });
    expect((await put('dopisek z testu', DEMO_NOTE_UPDATED_AT)).status).toBe(200);
    expect((await put('spóźniony', DEMO_NOTE_UPDATED_AT)).status).toBe(409);
    expect(await h.stats()).toMatchObject({ notesGets: 1, notesPuts: 2, noteText: 'dopisek z testu' });
    await h.command({ action: 'reset' });
    expect(await h.stats()).toMatchObject({ notesGets: 0, notesPuts: 0, noteText: demoContentPl.noteText });
  });

  it('note-remote: zapis „z innego urządzenia" to nowa wersja i event `notes` na strumieniu listy', async () => {
    const global = stream(h, '/api/stream');
    await until(() => global.events().some((event) => event.type === 'sessions-snapshot'));
    const snapshot = global.events().find((event) => event.type === 'sessions-snapshot');
    expect(snapshot?.type === 'sessions-snapshot' ? snapshot.notesCwds : undefined).toContain(DEMO_NOTE_CWD);
    expect(await h.command({ action: 'note-remote', text: 'z iPhone\'a' })).toMatchObject({ noteText: 'z iPhone\'a' });
    await until(() => global.events().some((event) => event.type === 'notes'));
    expect(global.events().find((event) => event.type === 'notes')).toEqual({
      type: 'notes', cwd: DEMO_NOTE_CWD, empty: false,
    });
    global.close();
  });

  /*
   * Trasy per plik. `diffRequests` zostaje SUMĄ wszystkich tras diffa (asercje „zero bez
   * stuknięcia" pilnują więc także nowych), a liczniki obok mówią, KTÓRA trasa i o jaki plik —
   * po nich test UI dowodzi, że poszedł patch jednego, stukniętego pliku.
   */
  it('liczy listę zmian i patch pliku osobno, zapisuje ścieżki żądań; demo oddaje 3 pliki i ich bloki', async () => {
    const seed = h.manager.list()[0]?.id;
    if (seed === undefined) throw new Error('demo bez sesji');
    const get = (path: string) => fetch(`${h.base}/api/sessions/${seed}/${path}`, { headers: h.auth });

    const list = await get('diff/files');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      files: [
        { path: 'src/notes.ts', status: 'M', linesAdded: 2, linesDeleted: 2 },
        { path: 'src/notes.test.ts', status: 'A', linesAdded: 9, linesDeleted: 0 },
        { path: 'src/notes-legacy.ts', status: 'D', linesAdded: 0, linesDeleted: 4 },
      ],
      truncated: false,
    });
    const file = await get('diff/file?path=src%2Fnotes.ts');
    expect(file.status).toBe(200);
    expect(await file.json()).toMatchObject({ path: 'src/notes.ts', truncated: false });
    // Odmowy też są żądaniami, które doszły do serwera — licznik ich nie pomija.
    expect((await get('diff/file?path=src%2Fnie-ma.ts')).status).toBe(404);
    expect((await get('diff/file?path=..%2Fx')).status).toBe(400);
    expect((await get('diff')).status).toBe(200);

    expect(await h.stats()).toMatchObject({
      diffRequests: 5, diffListRequests: 1, diffFileRequests: 3,
      diffFilePaths: ['src/notes.ts', 'src/nie-ma.ts', '../x'],
    });
    await h.command({ action: 'reset' });
    expect(await h.stats()).toMatchObject({
      diffRequests: 0, diffListRequests: 0, diffFileRequests: 0, diffFilePaths: [],
    });
  });

  /*
   * Stany okna diffa, których sam demo-diff nie wywoła (strona apki): serwer sprzed tras per plik,
   * awaria gita przy patchu i patch w drodze. Kontrola podmienia WYŁĄCZNIE odpowiedź: żądanie dalej jest
   * liczone, a stara trasa i druga trasa per plik zostają nietknięte.
   */
  it('trasy diffa pod kontrolą: lista jak sprzed tras (405), patch z awarią gita (503) i wstrzymany do release', async () => {
    const seed = h.manager.list()[0]?.id;
    if (seed === undefined) throw new Error('demo bez sesji');
    const get = (path: string) => fetch(`${h.base}/api/sessions/${seed}/${path}`, { headers: h.auth });
    expect((await h.stats()).config).toMatchObject({ diffList: 'pass', diffFile: 'pass' });

    // Wzorzec: tak router odpowiada na nieznany GET pod sesją — i tak odpowiada na listę serwer bez trasy `diff/files`.
    const guard = await get('nie-ma-takiej-trasy');
    await h.command({ action: 'configure', diffList: 'outdated' });
    const outdated = await get('diff/files');
    expect(outdated.status).toBe(405);
    expect([outdated.status, outdated.headers.get('allow')]).toEqual([guard.status, guard.headers.get('allow')]);
    // Kod i status jak w routerze; zdanie demo z kodem (`messageRef`), jak każde ciało błędu.
    const guardBody = await guard.json() as { error: string };
    expect(await outdated.json()).toEqual({
      error: guardBody.error, message: say('rest.method-not-allowed').text, messageRef: { code: 'rest.method-not-allowed' },
    });
    expect((await get('diff/file?path=src%2Fnotes.ts')).status).toBe(200);
    expect((await get('diff')).status).toBe(200);

    await h.command({ action: 'configure', diffList: 'pass', diffFile: 'fail' });
    expect((await get('diff/files')).status).toBe(200);
    const failed = await get('diff/file?path=src%2Fnotes.ts');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error: 'git-failed', message: say('rest.diff-git-failed').text, messageRef: { code: 'rest.diff-git-failed' },
    });

    // Długi patch: okno diffa da się przewinąć w głąb pliku (pliki demo mają po kilka linii).
    await h.command({ action: 'configure', diffFile: 'long' });
    const long = await (await get('diff/file?path=src%2Fnotes.test.ts')).json() as { path: string; patch: string; truncated: boolean };
    expect(long).toMatchObject({ path: 'src/notes.test.ts', truncated: false });
    expect(long.patch.startsWith('diff --git a/src/notes.test.ts b/src/notes.test.ts\nnew file mode 100644\n')).toBe(true);
    expect(long.patch.split('\n').filter((line) => line.startsWith('+  linia '))).toHaveLength(400);
    expect(long.patch.endsWith('\n')).toBe(true);

    await h.command({ action: 'configure', diffFile: 'hold' });
    let settled = false;
    const pending = get('diff/file?path=src%2Fnotes.test.ts').then((response) => { settled = true; return response; });
    await until(async () => (await h.stats()).held.diffs === 1);
    expect(settled).toBe(false);
    expect((await h.stats()).config).toMatchObject({ diffList: 'pass', diffFile: 'hold' });
    await h.command({ action: 'release', target: 'diff' });
    const released = await pending;
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ path: 'src/notes.test.ts', truncated: false });
    // `release` przywraca przepuszczanie, jak przy pozostałych bramkach.
    expect(await h.stats()).toMatchObject({
      config: { diffFile: 'pass' }, held: { diffs: 0 }, diffListRequests: 2, diffFileRequests: 4,
      diffFilePaths: ['src/notes.ts', 'src/notes.ts', 'src/notes.test.ts', 'src/notes.test.ts'],
    });

    await h.command({ action: 'configure', diffList: 'outdated', diffFile: 'fail' });
    await h.command({ action: 'reset' });
    expect((await get('diff/files')).status).toBe(200);
    expect((await get('diff/file?path=src%2Fnotes.ts')).status).toBe(200);
    expect((await h.request({ action: 'configure', diffFile: 'outdated' })).status).toBe(400);
  });

  it('wstrzymuje snapshot listy po hello, a `unauthorized` daje 401 bez `Set-Cookie` i bez ruszania urządzenia', async () => {
    await h.command({ action: 'configure', snapshot: 'hold' });
    const sse = stream(h, '/api/stream');
    await until(async () => (await h.stats()).held.snapshots > 0);
    expect(sse.events().map((event) => event.type)).toEqual(['hello']);
    await h.command({ action: 'release', target: 'snapshot' });
    await until(() => sse.events().some((event) => event.type === 'sessions-snapshot'));
    sse.close();
    await h.command({ action: 'configure', unauthorized: true });
    const response = await fetch(`${h.base}/api/projects`, { headers: h.auth });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await h.stats()).config.unauthorized).toBe(true);
    await h.command({ action: 'reset' });
    expect((await fetch(`${h.base}/api/projects`, { headers: h.auth })).status).toBe(200);
  });

  it('przed202: przyjęcie jest realne, zerwanie odpowiedzi i retryid nie wysyłają ponownie', async () => {
    const id = await h.create('idle');
    const clientMessageId = randomUUID();
    await h.command({ action: 'configure', messageResponse: 'hold', echo: 'hold' });
    const abort = new AbortController();
    const pending = h.send(id, clientMessageId, abort.signal).catch(() => null);
    await until(async () => (await h.stats()).held.responses === 1);
    expect(await h.stats()).toMatchObject({ driverSends: 1, transcriptMessages: 1,
      acceptedMessages: [{ sessionId: id, clientMessageId, replayed: false }] });
    abort.abort();
    await pending;
    await h.command({ action: 'release', target: 'response' });
    const replay = await h.send(id, clientMessageId);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ ok: true, clientMessageId, replayed: true });
    const stats = await h.stats();
    expect(stats.driverSends).toBe(1);
    expect(stats.receivedMessages.map((message) => message.clientMessageId)).toEqual([clientMessageId, clientMessageId]);
    expect(stats.acceptedMessages.map((message) => message.replayed)).toEqual([false, true]);
  });

  it('wysyłka odrzucona przez router (bez klucza urządzenia) też jest liczona', async () => {
    const id = await h.create('idle');
    const refused = await fetch(`${h.base}/api/sessions/${id}/messages`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'M1 bez klucza', clientMessageId: randomUUID() }),
    });
    expect(refused.status).toBe(401);
    const stats = await h.stats();
    expect(stats.receivedMessages.map((message) => message.sessionId)).toEqual([id]);
    expect(stats.acceptedMessages).toEqual([]);
    expect(stats.driverSends).toBe(0);
  });

  it('po202: zatrzymuje oryginalne echo i reconnect snapshot, wydaje je bez zmiany danych', async () => {
    const id = await h.create('idle');
    const sse = stream(h, `/api/sessions/${id}/stream`);
    await until(() => sse.events().some((event) => event.type === 'transcript-snapshot'));
    await h.command({ action: 'configure', echo: 'hold' });
    const clientMessageId = randomUUID();
    expect((await h.send(id, clientMessageId)).status).toBe(202);
    await until(async () => (await h.stats()).held.echoes > 0);
    expect(sse.events().filter((event) => event.type === 'message')).toHaveLength(0);
    const heldBeforeRestart = (await h.stats()).held.echoes;
    const restarted = stream(h, `/api/sessions/${id}/stream`);
    await until(async () => (await h.stats()).held.echoes > heldBeforeRestart);
    expect(restarted.events().some((event) => event.type === 'transcript-snapshot')).toBe(false);
    await h.command({ action: 'release', target: 'echo' });
    await until(() => restarted.events().some((event) => event.type === 'transcript-snapshot'));
    await until(() => sse.events().some((event) => event.type === 'message'));
    const snapshot = restarted.events().find((event) => event.type === 'transcript-snapshot');
    expect(snapshot).toMatchObject({ messages: h.manager.transcript(id).messages });
    expect(sse.events().find((event) => event.type === 'message')).toMatchObject({
      message: { clientMessageId, role: 'user' },
    });
    expect((await h.stats()).driverSends).toBe(1);
    sse.close(); restarted.close();
  });

  it('sterowane delty/system/message nie dopisują systemu do odpowiedzi; clear usuwa prawdziwą kartę', async () => {
    const id = await h.create('question');
    const sse = stream(h, `/api/sessions/${id}/stream`);
    await until(() => sse.events().some((event) => event.type === 'transcript-snapshot'));
    await h.command({ action: 'emit', sessionId: id, event: 'clear-question' });
    expect(h.manager.transcript(id).pendingQuestions).toHaveLength(0);
    await h.command({ action: 'emit', sessionId: id, event: 'system', text: 'M1 system' });
    await h.command({ action: 'emit', sessionId: id, event: 'delta', text: 'M1 delta' });
    await until(() => sse.events().some((event) => event.type === 'delta'));
    await h.command({ action: 'emit', sessionId: id, event: 'message', text: 'M1 koniec' });
    await until(() => sse.events().filter((event) => event.type === 'message').length === 2);
    expect(h.manager.transcript(id).messages.map((message) => message.role)).toEqual(['system', 'assistant']);
    expect(sse.events().find((event) => event.type === 'delta')).toMatchObject({ text: 'M1 delta' });
    await h.command({ action: 'emit', sessionId: id, event: 'detach' });
    expect(h.manager.get(id)?.stale).toBe(true);
    expect((await h.request({ action: 'emit', sessionId: randomUUID(), event: 'delta' })).status).toBe(404);
    sse.close();
  });

  // The app's rename on the list row waits for the label Claude Code takes from `/rename`: the demo gives it on demand.
  it('emit title: the custom title becomes the card label', async () => {
    const created = await h.command({ action: 'create', scenario: 'idle', label: 'Old name' });
    const id = created.sessionId ?? '';
    await until(() => h.manager.get(id)?.label === 'Old name');
    await h.command({ action: 'emit', sessionId: id, event: 'title', text: 'Brand new name' });
    await until(() => h.manager.get(id)?.label === 'Brand new name');
  });

  /*
   * Panel „zmiany w katalogu”: demo nie ma repo, więc ramkę gita podaje `emit git-status` — te same
   * trzy pliki co `demoDiff` („Pokaż diff”), z rodzajami i licznikami. W każdym scenariuszu.
   */
  it('emit git-status: ramka strumienia sesji z `fileDetails` zgodnymi z diffem demo', async () => {
    const id = await h.create('idle');
    const sse = stream(h, `/api/sessions/${id}/stream`);
    await until(() => sse.events().some((event) => event.type === 'transcript-snapshot'));
    await h.command({ action: 'emit', sessionId: id, event: 'git-status' });
    await until(() => sse.events().some((event) => event.type === 'git-status'));
    const git = sse.events().find((event) => event.type === 'git-status');
    const diff = await h.manager.diff(id);
    expect(git).toMatchObject({
      sessionId: id, branch: 'main', dirtyCount: 3, behind: 1,
      files: diff.files.map((file) => file.path),
      fileDetails: diff.files.map((file) => ({
        path: file.path, linesAdded: file.linesAdded, linesDeleted: file.linesDeleted,
      })),
    });
    expect(h.manager.get(id)).toMatchObject({ branch: 'main', dirtyCount: 3 });
    sse.close();
  });

  /*
   * Statystyki to obserwacja: ich odczyt nie pisze do strumienia sesji. `transcript()` managera w demo ponawia
   * ostatnią ramkę `git-status` (otwarcie transkryptu), a każda taka ramka to dla apki nowy stan
   * repozytorium, czyli odświeżenie okna diffa. Testy UI odpytują statystyki co 100 ms, więc odczyt
   * z tym skutkiem odświeżałby otwarte okno bez końca i liczniki diffa by nie stanęły.
   */
  it('odczyt statystyk nie ponawia ramki git-status na strumieniu sesji', async () => {
    const id = await h.create('idle');
    const sse = stream(h, `/api/sessions/${id}/stream`);
    await until(() => sse.events().some((event) => event.type === 'transcript-snapshot'));
    await h.command({ action: 'emit', sessionId: id, event: 'git-status' });
    await until(() => sse.events().some((event) => event.type === 'git-status'));
    for (let poll = 0; poll < 5; poll += 1) await h.stats();
    // Ponowienie idzie w mikrozadaniu: chwila na dojazd ramek, których ma nie być.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(sse.events().filter((event) => event.type === 'git-status')).toHaveLength(1);
    sse.close();
  });

  /*
   * Panel „w tle” apki: rozkład przebiegu idzie zwykłym zdarzeniem `background-tasks`
   * przez pump managera i ramki listy — bez zmiany kontraktu i managera. Każdy `emit` to kolejny
   * rozkład (dopisany agent, koniec agentów, nowa faza, koniec przebiegu).
   */
  it('workflow w tle: rozkład przez managera i ramki listy, kolejne rozkłady przez emit', async () => {
    const id = await h.create('workflow');
    const task = () => h.manager.get(id)?.backgroundTasks?.[0];
    const run = () => task()?.run ?? { phases: [], agents: [] };
    const live = () => run().agents.filter((agent) => !agent.done).map((agent) => agent.label);
    expect(task()).toMatchObject({ id: 'm1-workflow', kind: 'workflow', description: 'przegląd M1', runId: 'wf_m1' });
    expect(h.manager.get(id)?.state).toBe('waiting-input');
    expect(run().phases).toEqual(['Implementacja', 'Review', 'Poprawki']);
    expect(phaseCounts(run())).toEqual([
      { title: 'Implementacja', agents: 12, done: 12 },
      { title: 'Review', agents: 45, done: 44 },
      { title: 'Poprawki', agents: 0, done: 0 },
    ]);
    expect(live()).toEqual(['review:45']);
    expect(run().agents.every((agent) => agent.startedAt !== undefined && agent.id.startsWith('m1-wf-'))).toBe(true);
    const sse = stream(h, '/api/stream');
    await until(() => sse.events().some((event) => event.type === 'sessions-snapshot'
      && event.sessions.some((session) => session.id === id && session.backgroundTasks?.[0]?.run?.agents.length === 57)));

    await h.command({ action: 'emit', sessionId: id, event: 'workflow-agent' });
    expect(run().agents.at(-1)).toMatchObject({ phase: 'Review', label: 'review:46', done: false });
    await h.command({ action: 'emit', sessionId: id, event: 'workflow-agent', text: 'Implementacja' });
    expect(run().agents.at(-1)).toMatchObject({ phase: 'Implementacja', label: 'impl:13', done: false });
    await until(() => sse.events().some((event) => event.type === 'session-changed'
      && event.session.id === id && event.session.backgroundTasks?.[0]?.run?.agents.length === 59));
    await h.command({ action: 'emit', sessionId: id, event: 'workflow-phase' });
    expect(live()).toEqual(['fix:01']);
    expect(phaseCounts(run())?.map((phase) => phase.done)).toEqual([13, 46, 0]);
    await h.command({ action: 'emit', sessionId: id, event: 'workflow-done' });
    expect(live()).toEqual([]);
    // Fazy spoza planu: tożsamość agenta jest unikalna w całym przebiegu, także gdy
    // dwie fazy dają ten sam przedrostek etykiety — wiersze panelu są nią kluczowane.
    for (const phase of ['Audyt', 'Testy', 'Audyt!']) {
      await h.command({ action: 'emit', sessionId: id, event: 'workflow-phase', text: phase });
    }
    const ids = run().agents.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(run().agents.slice(-3).map((agent) => agent.label)).toEqual(['audyt:01', 'testy:01', 'audyt:01']);
    await h.command({ action: 'emit', sessionId: id, event: 'workflow-end' });
    expect(h.manager.get(id)?.backgroundTasks).toBeUndefined();
    sse.close();

    // Przebieg tylko w scenariuszu `workflow`: emit gdzie indziej nie udaje sukcesu.
    const idle = await h.create('idle');
    expect((await h.request({ action: 'emit', sessionId: idle, event: 'workflow-agent' })).status).toBe(409);
    expect(h.manager.get(idle)?.backgroundTasks).toBeUndefined();
  });

  /*
   * Sekcja „w tle” apki, trzy stany subagenta: scenariusz `standby` stawia agenta w postoju z dwiema
   * własnymi komendami (druga bez treści) i notką o postoju w historii. Lista idzie zwykłym zdarzeniem
   * `background-tasks`, notkę liczy z tekstu meldunku ta sama funkcja co na produkcji.
   */
  it('standby: subagent w postoju z własnymi komendami i notką waiting; agent-wake zdejmuje postój', async () => {
    const id = await h.create('standby');
    const tasks = () => h.manager.get(id)?.backgroundTasks;
    const task = () => tasks()?.[0];
    expect(tasks()).toHaveLength(1);
    expect(task()).toMatchObject({
      id: 'm1-standby', kind: 'agent', description: 'Przegląd pokrycia testami', agentType: 'general-purpose',
    });
    const since = Date.parse(task()?.waitingSince ?? '');
    expect(Date.now() - since).toBeGreaterThanOrEqual(18 * 60_000);
    expect(Date.parse(task()?.startedAt ?? '')).toBeLessThan(since);
    expect(task()?.ownTasks).toEqual([
      { id: 'm1-standby-cmd-1', command: 'pnpm test -- --coverage', startedAt: expect.any(String) as string },
      { id: 'm1-standby-cmd-2', startedAt: expect.any(String) as string },
    ]);
    expect(h.manager.get(id)?.state).toBe('waiting-input');
    // Sam czekający subagent: nic nie pracuje, więc nie wstrzymuje „gotowe”; restart dalej by go przerwał.
    expect(tasksHoldingDonePush(tasks())).toBe(0);
    expect(onlyWaitingAgents(tasks())).toBe(true);
    expect(tasksBlockRestart(tasks())).toBe(true);
    // Notka o postoju: wynik `waiting`, nie `done`, z nazwą agenta — z tekstu meldunku, nie z ręki.
    const messages = h.manager.transcript(id).messages;
    expect(messages).toHaveLength(4);
    expect(messages.flatMap((message) => (message.notice === undefined ? [] : [message.notice]))).toEqual([
      { kind: 'agent', outcome: 'waiting', name: 'Przegląd pokrycia testami' },
    ]);
    const sse = stream(h, '/api/stream');
    await until(() => sse.events().some((event) => event.type === 'sessions-snapshot'
      && event.sessions.some((session) => session.id === id
        && session.backgroundTasks?.[0]?.waitingSince !== undefined && session.backgroundTasks[0].ownTasks?.length === 2)));

    // Agent rusza sam: bez `waitingSince`, skończona komenda schodzi, druga dalej leci.
    await h.command({ action: 'emit', sessionId: id, event: 'agent-wake' });
    expect(task()?.waitingSince).toBeUndefined();
    expect(task()?.ownTasks).toEqual([{ id: 'm1-standby-cmd-2', startedAt: expect.any(String) as string }]);
    expect(tasksHoldingDonePush(tasks())).toBe(1);
    expect(onlyWaitingAgents(tasks())).toBe(false);
    await until(() => sse.events().some((event) => event.type === 'session-changed' && event.session.id === id
      && event.session.backgroundTasks?.[0]?.waitingSince === undefined
      && event.session.backgroundTasks?.[0]?.ownTasks?.length === 1));
    // Drugie wybudzenie: ostatnia komenda schodzi, pole `ownTasks` znika (pusta lista nie jedzie).
    await h.command({ action: 'emit', sessionId: id, event: 'agent-wake' });
    expect(task()).toMatchObject({ id: 'm1-standby', kind: 'agent' });
    expect(task()?.ownTasks).toBeUndefined();
    sse.close();

    // `agent-wake` tylko w scenariuszu `standby`: emit gdzie indziej nie udaje sukcesu.
    const idle = await h.create('idle');
    expect((await h.request({ action: 'emit', sessionId: idle, event: 'agent-wake' })).status).toBe(409);
    const workflow = await h.create('workflow');
    expect((await h.request({ action: 'emit', sessionId: workflow, event: 'agent-wake' })).status).toBe(409);
  });

  /*
   * Sekcja ARTEFAKTY prawego panelu: scenariusz `artifacts` stawia sesję z dwoma artefaktami — raport
   * poprawiony 2 h temu i szkic sprzed doby, usunięty na claude.ai — oraz notką o końcu obserwacji szkicu.
   * Listę liczy z wpisów pliku rozmowy ta sama maszyna co follower, notkę ta sama funkcja co import.
   */
  it('artifacts: dwa artefakty (jeden usunięty) w karcie i notka `artifact-watch` w historii', async () => {
    const id = await h.create('artifacts');
    const artifacts = h.manager.get(id)?.artifacts ?? [];
    expect(artifacts.map((item) => [item.title, item.gone === true])).toEqual([
      [DEMO_ARTIFACT_TITLES.report, false], [DEMO_ARTIFACT_TITLES.draft, true],
    ]);
    for (const item of artifacts) expect(item.url).toMatch(/^https:\/\/claude\.ai\/artifact\/[A-Za-z0-9]+$/);
    const age = (item: { publishedAt: string } | undefined): number => Date.now() - Date.parse(item?.publishedAt ?? '');
    // Raport: ostatnia publikacja 2 h temu; szkic: ponad dobę (apka pokazuje wtedy dzień zamiast godziny).
    expect(age(artifacts[0])).toBeGreaterThanOrEqual(2 * 60 * 60_000);
    expect(age(artifacts[0])).toBeLessThan(3 * 60 * 60_000);
    expect(age(artifacts[1])).toBeGreaterThan(24 * 60 * 60_000);
    expect(h.manager.get(id)?.state).toBe('waiting-input');
    const messages = h.manager.transcript(id).messages;
    expect(messages).toHaveLength(6);
    expect(messages.flatMap((message) => (message.notice === undefined ? [] : [message.notice]))).toEqual([
      { kind: 'artifact-watch', name: DEMO_ARTIFACT_TITLES.draft },
    ]);
    const sse = stream(h, '/api/stream');
    await until(() => sse.events().some((event) => event.type === 'sessions-snapshot'
      && event.sessions.some((session) => session.id === id && session.artifacts?.length === 2
        && session.artifacts[1]?.gone === true)));
    sse.close();
  });

  /*
   * Sekcja PULL REQUESTY prawego panelu: scenariusz `pull-requests` stawia sesję z dwoma PR-ami z wpisów pliku
   * rozmowy (`gh pr create` i jego wynik) — z tytułem sprzed 2 h i bez tytułu sprzed doby. Listę liczy ta sama
   * funkcja co czytnik na produkcji.
   */
  it('pull-requests: trzy PR-y (jeden bez tytułu, jeden draft) w karcie, najnowszy pierwszy, ramka listy', async () => {
    const id = await h.create('pull-requests');
    const prs = h.manager.get(id)?.pullRequests ?? [];
    expect(prs.map((pr) => [pr.url, pr.repo, pr.number, pr.title])).toEqual([
      [DEMO_PULL_REQUESTS.titled, 'acme/widget', 42, DEMO_PULL_REQUESTS.title],
      [DEMO_PULL_REQUESTS.bare, 'acme/widget-docs', 7, undefined],
      [DEMO_PULL_REQUESTS.draft, 'acme/widget', 45, DEMO_PULL_REQUESTS.draftTitle],
    ]);
    const age = (pr: { createdAt: string } | undefined): number => Date.now() - Date.parse(pr?.createdAt ?? '');
    expect(age(prs[0])).toBeGreaterThanOrEqual(2 * 60 * 60_000);
    expect(age(prs[0])).toBeLessThan(3 * 60 * 60_000);
    expect(age(prs[1])).toBeGreaterThan(24 * 60 * 60_000);
    expect(age(prs[2])).toBeGreaterThan(48 * 60 * 60_000);
    expect(h.manager.get(id)?.state).toBe('waiting-input');
    expect(h.manager.transcript(id).messages).toHaveLength(4);
    const sse = stream(h, '/api/stream');
    await until(() => sse.events().some((event) => event.type === 'sessions-snapshot'
      && event.sessions.some((session) => session.id === id && session.pullRequests?.length === 3)));
    sse.close();
    // Inne scenariusze PR-ów nie mają: sekcja w apce stoi tylko przy PR-ach.
    const idle = await h.create('idle');
    expect(h.manager.get(idle)?.pullRequests).toBeUndefined();
  });

  it('scheduled-tasks: a one-shot task due ahead and a recurring one that ran, newest first, in the list frame',
    async () => {
      const id = await h.create('scheduled-tasks');
      const tasks = h.manager.get(id)?.scheduledTasks ?? [];
      expect(tasks.map((task) => [task.prompt, task.recurring])).toEqual([
        [DEMO_SCHEDULED_TASKS.oneShot, false],
        [DEMO_SCHEDULED_TASKS.recurring, true],
      ]);
      const [oneShot, recurring] = tasks;
      expect(Date.parse(oneShot?.nextFireAt ?? '')).toBeGreaterThan(Date.now());
      expect(recurring).toMatchObject({ cron: '*/30 * * * *' });
      expect(recurring?.nextFireAt).toBeUndefined();
      expect(Date.parse(recurring?.lastFiredAt ?? '')).toBeLessThan(Date.now());
      expect(Date.parse(recurring?.expiresAt ?? '')).toBeGreaterThan(Date.now());
      expect(h.manager.transcript(id).messages).toHaveLength(4);
      const sse = stream(h, '/api/stream');
      await until(() => sse.events().some((event) => event.type === 'sessions-snapshot'
        && event.sessions.some((session) => session.id === id && session.scheduledTasks?.length === 2)));
      sse.close();
    });

  /*
   * Notka o prompcie zablokowanym przez hook z przyciskiem „Uruchom ponownie i wyślij”: scenariusz
   * `prompt-blocked` wysyła prompt zwykłą wysyłką managera, a hook demo blokuje każdy prompt. Panel demo nie ma
   * restartu, więc przycisk w apce dostaje zdanie odmowy przed `/exit` i zostaje — tak test UI sprawdza odmowę.
   */
  it('prompt-blocked: dymek, notka z powodem i blokada na karcie; restart odmawia zdaniem, kolejny prompt — nowa notka', async () => {
    const id = await h.create('prompt-blocked');
    const blocked = h.manager.get(id)?.promptBlocked;
    if (blocked === undefined) throw new Error('karta bez blokady');
    expect(h.manager.get(id)?.state).toBe('waiting-input');
    const messages = h.manager.transcript(id).messages;
    expect(messages.map((message) => message.role)).toEqual(['user', 'system']);
    expect(messages[0]?.blocks).toEqual([{ type: 'text', text: SCENARIO_BLOCKED_PROMPT }]);
    // Prompt z Raroga stoi dymkiem, więc notka nie cytuje go drugi raz.
    expect(messages[1]?.seq).toBe(blocked.seq);
    expect(messages[1]?.promptBlocked).toEqual({ reason: SCENARIO_BLOCKED_REASON });
    expect((await h.stats()).driverSends).toBe(1);

    const stale = await h.post(`/api/sessions/${id}/restart`, { resend: { seq: blocked.seq, id: 'inna-blokada' } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      message: 'This prompt is no longer waiting to be sent again.', messageRef: { code: 'restart.resend-stale' },
    });
    const refused = await h.post(`/api/sessions/${id}/restart`, { resend: blocked });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      message: "This pane doesn't support restarting from Rarog.", messageRef: { code: 'restart.unsupported' },
    });
    expect(h.manager.get(id)?.promptBlocked).toEqual(blocked);

    // Kolejny prompt z Raroga: hook blokuje go znowu — nowa notka, przycisk przechodzi pod nią z nowym `id`.
    expect((await h.send(id, randomUUID())).status).toBe(202);
    await until(() => h.manager.transcript(id).messages.length === 4
      && h.manager.get(id)?.promptBlocked?.seq === h.manager.transcript(id).messages[3]?.seq);
    expect(h.manager.get(id)?.promptBlocked?.id).not.toBe(blocked.id);
    expect(h.manager.get(id)?.state).toBe('waiting-input');
  });

  it('POST odpowiedzi i decyzji sesji odbioru jest widoczny, także gdy driver go nie dostał', async () => {
    const question = await h.create('question');
    await h.command({ action: 'emit', sessionId: question, event: 'clear-question' });
    // Spóźniona cyfra po zniknięciu karty: serwer odmawia, driver milczy — licznik drivera tego nie widzi.
    const late = await h.post(`/api/sessions/${question}/answers/m1-question`, { answers: [['Sprawdź aplikację']] });
    expect(late.status).toBe(410);
    const afterLate = await h.stats();
    expect(afterLate.driverAnswers).toEqual([]);
    expect(afterLate.receivedAnswers).toEqual([{ sessionId: question, qId: 'm1-question' }]);
    // Obce sesje (seedy) nie trafiają do statystyk odbioru.
    const seed = h.manager.list().find((session) => session.id !== question)?.id ?? '';
    await h.post(`/api/sessions/${seed}/answers/m1-question`, { answers: [['x']] });
    expect((await h.stats()).receivedAnswers).toHaveLength(1);

    const permission = await h.create('cannot-allow');
    expect((await h.stats()).receivedAnswers).toEqual([]);
    await h.post(`/api/sessions/${permission}/permissions/m1-permission`, { decision: 'deny' });
    await h.post(`/api/sessions/${permission}/permission`, { decision: 'deny' });
    expect((await h.stats()).receivedDecisions).toEqual([
      { sessionId: permission, permId: 'm1-permission' }, { sessionId: permission, permId: null },
    ]);
    await h.command({ action: 'reset' });
    expect(await h.stats()).toMatchObject({ receivedAnswers: [], receivedDecisions: [] });
  });

  it('gates hold the list snapshot and the echo also for a client that accepts gzip, as the app does', async () => {
    // The app's URLSession sends `Accept-Encoding: gzip`, and the server compresses streams by default. The gates read
    // SSE frames as text, so the demo answers such a client without compression.
    const gzip = { 'Accept-Encoding': 'gzip, deflate' };
    const id = await h.create('idle');
    await h.command({ action: 'configure', snapshot: 'hold', echo: 'hold' });
    const global = stream(h, '/api/stream', gzip);
    const session = stream(h, `/api/sessions/${id}/stream`, gzip);
    await until(async () => (await h.stats()).held.snapshots > 0);
    await until(() => session.events().some((event) => event.type === 'transcript-snapshot'));
    expect([global.encoding(), session.encoding()]).toEqual([undefined, undefined]);
    expect(global.events().map((event) => event.type)).toEqual(['hello']);
    expect((await h.send(id, randomUUID())).status).toBe(202);
    await until(async () => (await h.stats()).held.echoes > 0);
    expect(session.events().filter((event) => event.type === 'message')).toHaveLength(0);
    await h.command({ action: 'release', target: 'all' });
    await until(() => global.events().some((event) => event.type === 'sessions-snapshot'));
    await until(() => session.events().some((event) => event.type === 'message'));
    global.close(); session.close();
  });

  it('release listy i echa są niezależne, zachowują kolejność oryginalnych ramek sesji', async () => {
    const id = await h.create('idle');
    await h.command({ action: 'configure', snapshot: 'hold', echo: 'hold' });
    const global = stream(h, '/api/stream');
    const session = stream(h, `/api/sessions/${id}/stream`);
    await until(async () => (await h.stats()).held.snapshots > 0);
    await until(() => session.events().some((event) => event.type === 'transcript-snapshot'));
    const clientMessageId = randomUUID();
    expect((await h.send(id, clientMessageId)).status).toBe(202);
    await until(async () => (await h.stats()).held.echoes > 0);
    await h.command({ action: 'emit', sessionId: id, event: 'system', text: 'po echu' });
    await h.command({ action: 'emit', sessionId: id, event: 'message', text: 'koniec' });
    await h.command({ action: 'release', target: 'snapshot' });
    await until(() => global.events().some((event) => event.type === 'sessions-snapshot'));
    expect(session.events().filter((event) => event.type === 'message')).toHaveLength(0);
    expect((await h.stats()).held.echoes).toBeGreaterThan(0);
    await h.command({ action: 'release', target: 'echo' });
    await until(() => session.events().filter((event) => event.type === 'message').length === 3);
    expect(session.events().filter((event) => event.type === 'message').map((event) => event.message.role))
      .toEqual(['user', 'system', 'assistant']);
    expect((await h.stats()).held).toEqual({ snapshots: 0, responses: 0, echoes: 0, diffs: 0, streams: 0 });
    global.close(); session.close();
  });

  it('freeze-stream silences one session stream: open connections go quiet, new ones get headers and no byte', async () => {
    const [frozen, other] = h.manager.list().map((session) => session.id);
    if (frozen === undefined || other === undefined) throw new Error('demo needs two sessions');
    const global = stream(h, '/api/stream');
    const open = stream(h, `/api/sessions/${frozen}/stream`);
    const neighbour = stream(h, `/api/sessions/${other}/stream`);
    await until(() => global.events().some((event) => event.type === 'sessions-snapshot'));
    await until(() => open.events().some((event) => event.type === 'transcript-snapshot'));
    await until(() => neighbour.events().some((event) => event.type === 'transcript-snapshot'));
    expect((await h.request({ action: 'freeze-stream' })).status).toBe(400);
    expect(await h.command({ action: 'freeze-stream', sessionId: frozen })).toMatchObject({
      config: { frozenStream: frozen },
    });
    const openBefore = open.raw();
    const fresh = stream(h, `/api/sessions/${frozen}/stream`);
    // `retry:` and the transcript snapshot of the new connection are held: the headers arrive, the body does not.
    await until(() => fresh.status() !== undefined);
    await until(async () => (await h.stats()).held.streams > 0);
    h.hub.sendHeartbeat();
    await until(() => global.raw().includes(': ping') && neighbour.raw().includes(': ping'));
    expect(fresh.status()).toBe(200);
    expect(fresh.raw()).toBe('');
    expect(open.raw()).toBe(openBefore);
    // `reset` lifts the freeze and hands the held bytes over in their original order.
    await h.command({ action: 'reset' });
    expect((await h.stats()).config.frozenStream).toBeNull();
    await until(() => fresh.events().some((event) => event.type === 'transcript-snapshot'));
    expect(fresh.raw().startsWith('retry: ')).toBe(true);
    expect(fresh.raw()).toContain(': ping');
    await until(() => open.raw().slice(openBefore.length).includes(': ping'));
    global.close(); open.close(); neighbour.close(); fresh.close();
  });

  it('release of the stream gate resumes a frozen session stream, other gates stay held', async () => {
    const id = await h.create('idle');
    const session = stream(h, `/api/sessions/${id}/stream`);
    await until(() => session.events().some((event) => event.type === 'transcript-snapshot'));
    await h.command({ action: 'configure', snapshot: 'hold' });
    await h.command({ action: 'freeze-stream', sessionId: id });
    await h.command({ action: 'emit', sessionId: id, event: 'system', text: 'during the freeze' });
    const global = stream(h, '/api/stream');
    await until(async () => {
      const held = (await h.stats()).held;
      return held.streams > 0 && held.snapshots > 0;
    });
    expect(session.events().filter((event) => event.type === 'message')).toHaveLength(0);
    await h.command({ action: 'release', target: 'stream' });
    await until(() => session.events().some((event) => event.type === 'message'));
    expect(await h.stats()).toMatchObject({ config: { frozenStream: null, snapshot: 'hold' } });
    expect((await h.stats()).held).toMatchObject({ streams: 0 });
    expect(global.events().map((event) => event.type)).toEqual(['hello']);
    // A later write to the same connection flows again.
    await h.command({ action: 'emit', sessionId: id, event: 'system', text: 'after the release' });
    await until(() => session.events().filter((event) => event.type === 'message').length === 2);
    global.close(); session.close();
  });

  // An echo on a frozen session stream is held by two gates. Whichever is released first, the echo and every later
  // frame of that connection wait for the other one, and they leave in their original order.
  it.each([
    { setup: 'echo held, then freeze', freezeFirst: false, releaseFirst: 'echo' },
    { setup: 'echo held, then freeze', freezeFirst: false, releaseFirst: 'stream' },
    { setup: 'freeze, then echo', freezeFirst: true, releaseFirst: 'echo' },
    { setup: 'freeze, then echo', freezeFirst: true, releaseFirst: 'stream' },
  ] as const)('$setup: release of $releaseFirst first keeps the echo behind the other gate', async (
    { freezeFirst, releaseFirst },
  ) => {
    const id = await h.create('idle');
    const session = stream(h, `/api/sessions/${id}/stream`);
    const global = stream(h, '/api/stream');
    await until(() => session.events().some((event) => event.type === 'transcript-snapshot'));
    await until(() => global.events().some((event) => event.type === 'sessions-snapshot'));
    await h.command({ action: 'configure', echo: 'hold' });
    if (freezeFirst) await h.command({ action: 'freeze-stream', sessionId: id });
    expect((await h.send(id, randomUUID())).status).toBe(202);
    await until(async () => {
      const held = (await h.stats()).held;
      return freezeFirst ? held.streams > 0 : held.echoes > 0;
    });
    if (!freezeFirst) await h.command({ action: 'freeze-stream', sessionId: id });
    await h.command({ action: 'emit', sessionId: id, event: 'system', text: 'behind the echo' });

    const released = await h.command({ action: 'release', target: releaseFirst });
    const other = releaseFirst === 'echo' ? 'streams' : 'echoes';
    expect(released.held[other]).toBeGreaterThan(0);
    expect(released.held[releaseFirst === 'echo' ? 'echoes' : 'streams']).toBe(0);
    // The global stream gets its ping after anything the session connection would have sent.
    h.hub.sendHeartbeat();
    await until(() => global.raw().includes(': ping'));
    expect(session.events().filter((event) => event.type === 'message')).toHaveLength(0);

    await h.command({ action: 'release', target: releaseFirst === 'echo' ? 'stream' : 'echo' });
    await until(() => session.events().filter((event) => event.type === 'message').length === 2);
    expect(session.events().filter((event) => event.type === 'message').map((event) => event.message.role))
      .toEqual(['user', 'system']);
    expect((await h.stats()).held).toEqual({ snapshots: 0, responses: 0, echoes: 0, diffs: 0, streams: 0 });
    global.close(); session.close();
  });

  it('a frozen client that disconnects leaves the buffer, and a later release of the stream gate is a no-op', async () => {
    const id = await h.create('idle');
    await h.command({ action: 'freeze-stream', sessionId: id });
    const frozen = stream(h, `/api/sessions/${id}/stream`);
    await until(async () => (await h.stats()).held.streams > 0);
    frozen.close();
    await until(async () => (await h.stats()).held.streams === 0);
    // Writes that still reach the closed connection are not buffered.
    h.hub.sendHeartbeat();
    await h.command({ action: 'emit', sessionId: id, event: 'system', text: 'after the disconnect' });
    expect((await h.stats()).held.streams).toBe(0);
    const released = await h.command({ action: 'release', target: 'stream' });
    expect(released).toMatchObject({ config: { frozenStream: null }, held: { streams: 0 } });
  });
});
