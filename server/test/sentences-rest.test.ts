/**
 * Zdania wycinka REST: odpowiedzi routera, walidacja katalogów, notatki, dyktowanie, karty pytań
 * i wysyłka mówią `say()`, więc ciało błędu niesie angielskie `message` z rejestru i `messageRef` z kodem.
 *
 * Każdy kod ma przypadek drogą produkcyjną: żądanie HTTP do prawdziwego routera (atrapa managera, urządzenie
 * testowe) albo wywołanie funkcji, której wynik router odsyła (`validateProjectCwd`, `browseDirectory`,
 * `checkAnswerNotes`, mint Soniox, `notesPath`; 409 `session.client-id-conflict` sprawdza
 * `ujscia-rest-zdania.test.ts`). Dwie drogi są z zewnątrz nieosiągalne
 * (403 `device-required` za bramką, która przepuszcza tylko urządzenia, i 400 nieczytelnego ciała, po którym
 * gniazdo jest zerwane): dla nich test czyta źródło routera.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_FILE_DATA_URL_BYTES, MAX_IMAGE_DATA_URL_BYTES, PROTOCOL_VERSION, type QuestionRequest,
} from '@rarog/shared';
import { MAX_ANSWER_NOTE_CHARS, PAIR_PROTOCOL_VERSION, errorBodySchema } from '@rarog/shared/rest';
import { type SentenceCode, say, textOf } from '@rarog/shared/sentences';
import { createDeviceStore, createLoginLimiter, createPairing } from '../src/auth/index.ts';
import { loadConfig, validateProjectCwd } from '../src/config.ts';
import { browseDirectory, demoListing } from '../src/fs-browse.ts';
import { notesPath } from '../src/notes/store.ts';
import { type Logger, type RouterDeps, createRouter, errorBodyOf } from '../src/router.ts';
import { createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import { createLiveActivity } from '../src/notify/live-activity.ts';
import { checkAnswerNotes } from '../src/sessions/question-card.ts';
import { SseHub } from '../src/sse.ts';
import { LABEL_FALLBACK, sanitizeLabel } from '../src/text.ts';
import { type FetchLike, createVoiceMinter } from '../src/voice/soniox.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { addTestDevice, createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';
const silent: Logger = { info: () => {}, error: () => {} };
const ROUTER_SRC = ['../src/router.ts', '../src/routes/devices.ts', '../src/routes/push.ts'].map((rel) => readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf8',
)).join('\n');

/** Oczekiwane ciało: angielski tekst rejestru z argumentami i `messageRef` z tym samym kodem. */
const said = (code: SentenceCode, args?: Readonly<Record<string, string | number>>): {
  message: string; messageRef: { code: string; args?: string[] };
} => {
  const sentence = say(code, args as never);
  return { message: sentence.text, messageRef: sentence.ref };
};

interface Harness {
  readonly base: string;
  readonly manager: FakeManager;
  readonly auth: string;
  close(): Promise<void>;
}

async function start(
  env: NodeJS.ProcessEnv = {},
  extra: Partial<RouterDeps> = {},
  manager = new FakeManager([makeSummary({ id: 's1' })]),
): Promise<Harness> {
  const config = loadConfig({ RAROG_DEMO: '1', ...env });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger: silent,
    devices: device.identity, ...extra,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}`, manager, auth: device.authorization,
    close: async () => {
      hub.closeAll();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

type Call = { method?: string; body?: unknown; auth?: string | null; origin?: string };

async function call(h: Harness, route: string, opts: Call = {}): Promise<{ status: number; body: unknown }> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const auth = opts.auth === undefined ? h.auth : opts.auth;
  const headers: Record<string, string> = {
    Origin: opts.origin ?? ORIGIN, ...(auth === null ? {} : { Authorization: auth }),
    ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };
  const res = await fetch(`${h.base}${route}`, {
    method, headers,
    ...(opts.body === undefined ? {} : { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) as unknown };
}

/** Ciało błędu przechodzi ścisły schemat kontraktu i ma oczekiwane zdanie. */
function expectSentence(
  got: { status: number; body: unknown }, status: number, error: string,
  code: SentenceCode, args?: Readonly<Record<string, string | number>>,
): void {
  expect(got.status, code).toBe(status);
  expect(errorBodySchema.parse(got.body), code).toEqual({ error, ...said(code, args) });
}

describe('router: zdania odpowiedzi REST (demo, urządzenie testowe)', () => {
  let h: Harness;
  beforeAll(async () => { h = await start(); });
  afterAll(async () => { await h.close(); });

  it('ciało: limit 64 kB, zły JSON, niezgodny kontrakt', async () => {
    const big = await call(h, '/api/client-log', {
      body: { events: [{ at: '2026-08-21T10:00:00.000Z', level: 'info', msg: 'x'.repeat(70_000) }] },
    });
    expect(big.status).toBe(413);
    const ref = (big.body as { messageRef: { code: string; args: string[] } }).messageRef;
    expect(ref.code).toBe('rest.payload-too-large');
    expect(big.body).toEqual({ error: 'payload-too-large', ...said('rest.payload-too-large', { limit: ref.args[0] ?? '' }) });
    expectSentence(await call(h, '/api/client-log', { body: 'nie-json' }), 400, 'bad-json', 'rest.bad-json');
    expectSentence(await call(h, '/api/client-log', { body: {} }), 400, 'bad-request', 'rest.body-contract');
  });

  it('nieczytelne ciało: 400 `rest.body-unreadable` (gniazdo zerwane, więc źródło)', () => {
    expect(ROUTER_SRC).toContain("sendError(res, 400, 'bad-request', say('rest.body-unreadable'));");
    expect(say('rest.body-unreadable').text).toBe("Couldn't read the request.");
  });

  it('trasy: 405, nieznany endpoint, obcy origin, 410 logowania tokenem', async () => {
    expectSentence(await call(h, '/api/client-log'), 405, 'method-not-allowed', 'rest.method-not-allowed');
    expectSentence(await call(h, '/api/nie-ma-takiej'), 404, 'not-found', 'rest.endpoint-not-found');
    expectSentence(
      await call(h, '/api/client-log', { body: { events: [] }, origin: 'https://zly.example' }),
      403, 'bad-origin', 'rest.bad-origin',
    );
    expectSentence(await call(h, '/api/login', { body: {} }), 410, 'login-retired', 'rest.login-retired');
  });

  it('bramka: brak klucza i nieznany klucz', async () => {
    expectSentence(await call(h, '/api/sessions', { auth: null }), 401, 'unauthorized', 'rest.device-key-missing');
    expectSentence(
      await call(h, '/api/sessions', { auth: `Rarog-Device ${'0'.repeat(32)}.${'A'.repeat(43)}` }),
      401, 'device-unknown', 'rest.device-unknown',
    );
  });

  it('403 `rest.device-required` za bramką urządzeń (zabezpieczenie typu, więc źródło)', () => {
    const lines = ROUTER_SRC.split('\n').filter((line) => line.includes('sendError(res, 403, DEVICE_REQUIRED_ERROR,'));
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line).toContain("say('rest.device-required')");
  });

  it('parowanie: nieznana wersja i nieważny kod', async () => {
    expectSentence(await call(h, '/api/pair', { body: { v: 99 }, auth: null }), 400, 'pair-version', 'rest.pair-version-unknown');
    expectSentence(
      await call(h, '/api/pair', { body: { v: PAIR_PROTOCOL_VERSION, code: 'ABCD-EFGH', label: 'iPhone' }, auth: null }),
      404, 'pair-unknown', 'rest.pair-code-invalid',
    );
  });

  it('załączniki: za dużo zdjęć i plików (liczba mnoga), za duże zdjęcie i plik', async () => {
    const send = (body: unknown): Promise<{ status: number; body: unknown }> =>
      call(h, '/api/sessions/s1/messages', { body });
    expectSentence(await send({ text: '', images: Array.from({ length: 6 }, () => PNG) }),
      413, 'payload-too-large', 'uploads.too-many-images', { max: 5 });
    const jpeg = 'data:image/jpeg;base64,';
    expectSentence(await send({ text: '', images: [jpeg + 'A'.repeat(MAX_IMAGE_DATA_URL_BYTES - jpeg.length + 1)] }),
      413, 'payload-too-large', 'uploads.image-too-large');
    expectSentence(await send({ text: '', files: Array.from({ length: 5 }, () => ({ name: 'a.txt', dataUrl: PDF })) }),
      413, 'payload-too-large', 'uploads.too-many-files', { max: 4 });
    const pdf = 'data:application/pdf;base64,';
    expectSentence(await send({
      text: '', files: [{ name: 'wielki.pdf', dataUrl: pdf + 'A'.repeat(MAX_FILE_DATA_URL_BYTES - pdf.length + 1) }],
    }), 413, 'payload-too-large', 'uploads.file-too-large');
  });

  it('decyzje: zapadła na innym urządzeniu i wygasła', async () => {
    h.manager.permissionOutcomes = ['conflict', 'gone'];
    const route = '/api/sessions/s1/permissions/perm-1';
    expectSentence(await call(h, route, { body: { decision: 'allow' } }), 409, 'conflict', 'rest.decision-conflict');
    expectSentence(await call(h, route, { body: { decision: 'allow' } }), 410, 'gone', 'rest.decision-expired');
  });

  it('model spoza listy: przy zmianie modelu i przy zakładaniu sesji', async () => {
    expectSentence(await call(h, '/api/sessions/s1/model', { body: { model: 'nie-ma-takiego' } }),
      400, 'model-unknown', 'model.unavailable');
    expectSentence(await call(h, '/api/sessions', { body: { cwd: '/tmp/rarog-demo/willow', model: 'nie-ma-takiego' } }),
      400, 'model-unknown', 'model.unavailable');
  });

  it('diff: zła ścieżka, plik spoza listy, git milczy', async () => {
    const cases = [
      ['bad-path', 400, 'rest.diff-bad-path'], ['diff-file-not-found', 404, 'rest.diff-file-not-found'],
      ['git-failed', 503, 'rest.diff-git-failed'],
    ] as const;
    for (const [code, status, sentence] of cases) {
      h.manager.throwOn['diffFile'] = Object.assign(new Error('opis wewnętrzny'), { code });
      expectSentence(await call(h, '/api/sessions/s1/diff/file?path=src/a.ts'), status, code, sentence);
    }
    delete h.manager.throwOn['diffFile'];
  });

  it('polityka `model`: 409 bez zdania managera → `rest.session-busy`', () => {
    expect(errorBodyOf(409, new Error('x'), 'model')).toEqual({ error: 'busy', ...said('rest.session-busy') });
  });

  it('terminal wyłączony (bez `RAROG_TERM`)', async () => {
    expectSentence(await call(h, '/api/term'), 404, 'not-found', 'term.disabled');
    expectSentence(await call(h, '/api/term', { body: {} }), 404, 'not-found', 'term.disabled');
    expectSentence(await call(h, '/api/term/t1/history'), 404, 'not-found', 'term.disabled');
    expectSentence(await call(h, '/api/term/t1', { method: 'DELETE' }), 404, 'not-found', 'term.disabled');
  });

  it('zdjęcie, którego czytnik nie zna', async () => {
    expectSentence(await call(h, '/api/sessions/s1/uploads/1788361542375-67f5f846e6fe49e7.png'),
      404, 'not-found', 'rest.image-not-found');
  });
});

describe('router: zdania tras z własnymi zależnościami', () => {
  it('nieznany terminal przy zamknięciu', async () => {
    const h = await start({}, { term: { close: () => false } as unknown as RouterDeps['term'] });
    try {
      expectSentence(await call(h, '/api/term/t9', { method: 'DELETE' }), 404, 'not-found', 'term.not-found');
    } finally { await h.close(); }
  });

  it('notatki wyłączone i nieudany zapis notatek', async () => {
    const off = await start({ RAROG_NOTES: '0' });
    try {
      expectSentence(await call(off, '/api/notes?cwd=/tmp/rarog-demo/willow'), 404, 'not-found', 'rest.notes-disabled');
    } finally { await off.close(); }
    const broken = await start({}, {
      notes: {
        read: () => ({ text: '', updatedAt: 0 }),
        write: () => { throw new Error('EIO'); },
      } as unknown as RouterDeps['notes'],
    });
    try {
      expectSentence(
        await call(broken, '/api/notes', { method: 'PUT', body: { cwd: '/tmp/rarog-demo/willow', text: 'x', updatedAt: 0 } }),
        500, 'internal', 'rest.notes-save-failed',
      );
    } finally { await broken.close(); }
  });

  it('nieudany zapis logu klienta', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rarog-e2-rest-'));
    const file = path.join(dir, 'plik');
    await writeFile(file, 'x');
    const h = await start({ RAROG_DATA_DIR: path.join(file, 'dane') });
    try {
      expectSentence(
        await call(h, '/api/client-log', { body: { events: [{ at: '2026-08-21T10:00:00.000Z', level: 'info', msg: 'x' }] } }),
        500, 'internal', 'rest.client-log-failed',
      );
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('limity planu niedostępne: słowo maszyny z systemu serwera', async () => {
    for (const [system, code] of [['macos', 'rest.usage-unavailable.mac'], ['linux', 'rest.usage-unavailable.vps']] as const) {
      const h = await start({}, { usage: { get: () => Promise.resolve(null) } as unknown as RouterDeps['usage'], system });
      try {
        expectSentence(await call(h, '/api/usage'), 503, 'usage-unavailable', code);
      } finally { await h.close(); }
    }
  });

  it('dławik prób: nieznany klucz i parowanie po wyczerpaniu budżetu', async () => {
    const h = await start({}, { loginLimiter: createLoginLimiter({ budget: 0 }) });
    try {
      expectSentence(
        await call(h, '/api/sessions', { auth: `Rarog-Device ${'0'.repeat(32)}.${'A'.repeat(43)}` }),
        429, 'too-many-requests', 'rest.auth-rate-limited',
      );
      expectSentence(
        await call(h, '/api/pair', { body: { v: PAIR_PROTOCOL_VERSION, code: 'ABCD-EFGH', label: 'iPhone' }, auth: null }),
        429, 'too-many-requests', 'rest.pair-rate-limited',
      );
    } finally { await h.close(); }
  });

  it('nieudany zapis parowania', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rarog-e2-rest-'));
    const store = createDeviceStore({ dataDir: dir, epoch: '1' });
    const device = addTestDevice(store);
    const pairing = createPairing({ store, epoch: '1' });
    // Kod od sparowanego urządzenia: kod „z Maca” działa tylko przy pustym magazynie.
    const issued = pairing.issue(device.id);
    store.persist = () => Promise.reject(new Error('EIO'));
    const h = await start({}, { devices: { store, pairing, serverName: 'mac-test' } });
    try {
      expectSentence(
        await call(h, '/api/pair', { body: { v: PAIR_PROTOCOL_VERSION, code: issued.code, label: 'iPhone' }, auth: null }),
        500, 'internal', 'rest.pair-save-failed',
      );
    } finally {
      await h.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('APNs: obcy temat, push próbny w przerwie, aktywność nieznanego urządzenia', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rarog-e2-rest-'));
    const devices = createApnsDeviceStore({ dataDir: dir });
    const liveActivity = createLiveActivity({
      devices, sender: { send: () => Promise.resolve({ kind: 'ok' }) }, sessions: () => [], log: () => {},
    } as never);
    const h = await start({}, {
      apns: {
        devices, sink: { sendTo: () => Promise.resolve('delivered') }, now: () => 1_000_000, liveActivity,
        sender: {
          statusOf: () => ({ degradedSince: null }), awaitRoute: () => Promise.resolve('direct'),
          awaitPending: () => Promise.resolve(),
        },
        topic: 'ai.rarog.app',
      } as unknown as RouterDeps['apns'],
    });
    const register = { token: 'A1B2C3D4'.repeat(8), environment: 'development', label: 'iPad', alerts: true };
    try {
      expectSentence(await call(h, '/api/push/apns', { body: { ...register, topic: 'inna.apka' } }),
        400, 'topic-mismatch', 'rest.apns-topic-mismatch');
      expect((await call(h, '/api/push/apns', { body: { ...register, topic: 'ai.rarog.app', test: true } })).status).toBe(204);
      expectSentence(await call(h, '/api/push/apns', { body: { ...register, topic: 'ai.rarog.app', test: true } }),
        429, 'too-many-requests', 'rest.push-test-cooldown');
      expectSentence(await call(h, '/api/push/live-activity', {
        body: { deviceToken: 'F0'.repeat(32), activityId: 'a1', updateToken: 'B2'.repeat(32) },
      }), 409, 'apns-device-unknown', 'rest.apns-device-unknown');
    } finally {
      liveActivity.close();
      await h.close();
      await devices.flush();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('katalog sesji poza korzeniami (poza demo): 400 z listą korzeni w argumencie', async () => {
    const roots = await mkdtemp(path.join(tmpdir(), 'rarog-e2-rest-'));
    const h = await start({ RAROG_DEMO: '', RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: roots });
    try {
      expectSentence(await call(h, '/api/sessions', { body: { cwd: '/usr' } }),
        400, 'cwd-not-allowed', 'rest.cwd-outside-roots.listed', { roots });
      const got = await call(h, '/api/sessions', { body: { cwd: '/usr' } });
      expect((got.body as { messageRef: { args: string[] } }).messageRef.args[0]).toBe(roots);
    } finally {
      await h.close();
      await rm(roots, { recursive: true, force: true });
    }
  });
});

describe('validateProjectCwd i checkCwd: każdy powód odmowy ma kod', () => {
  const ROOT = '/projekty';
  const dirs = new Set(['/projekty/atlas', '/projekty/link', '/projekty/skrot']);
  const opts = {
    home: '/home/u', isDirectory: (p: string) => dirs.has(p),
    realPath: (p: string) => (p === '/projekty/link' ? '/etc' : p === '/projekty/skrot' ? '/projekty/.git' : p),
  };
  const reasonOf = (input: string, roots: string[] = [ROOT]): unknown => {
    const check = validateProjectCwd(input, roots, opts);
    return check.ok ? null : { text: check.sentence.text, ref: check.sentence.ref };
  };
  const expected = (code: SentenceCode, args?: Readonly<Record<string, string>>): unknown => {
    const s = say(code, args as never);
    return { text: s.text, ref: s.ref };
  };

  it('pusta, względna, ukryta, brak korzeni, poza korzeniami, nie istnieje, dowiązanie, ukryta fizycznie', () => {
    expect(reasonOf('  ')).toEqual(expected('rest.cwd-empty'));
    expect(reasonOf('projekty/atlas')).toEqual(expected('rest.cwd-not-absolute'));
    expect(reasonOf('/projekty/.git')).toEqual(expected('rest.cwd-hidden'));
    expect(reasonOf('/projekty/atlas', [])).toEqual(expected('rest.cwd-not-in-projects'));
    expect(reasonOf('/inne', [ROOT, '/drugi'])).toEqual(expected('rest.cwd-outside-roots.listed', { roots: '/projekty, /drugi' }));
    expect(reasonOf('/projekty/birch')).toEqual(expected('rest.cwd-not-found'));
    expect(reasonOf('/projekty/link')).toEqual(expected('rest.cwd-symlink-escape'));
    expect(reasonOf('/projekty/skrot')).toEqual(expected('rest.cwd-hidden'));
    // A macOS-protected folder of home, refused before the disk.
    expect(reasonOf('/home/u/Desktop/x', ['/home/u'])).toEqual(expected('rest.cwd-protected'));
  });

  it('argument z polską ścieżką zostaje dosłownie', () => {
    const check = validateProjectCwd('/zażółć/x', ['/tmp/zażółć'], opts);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.sentence.ref).toEqual({ code: 'rest.cwd-outside-roots.listed', args: ['/tmp/zażółć'] });
      expect(check.sentence.text).toBe('This directory is outside the allowed projects (/tmp/zażółć).');
    }
  });

  it('checkCwd przez router: pusta i względna ścieżka przy notatkach, demo spoza listy', async () => {
    const h = await start();
    try {
      expectSentence(await call(h, '/api/notes?cwd='), 400, 'cwd-not-allowed', 'rest.cwd-empty');
      expectSentence(await call(h, '/api/notes?cwd=wzgledna'), 400, 'cwd-not-allowed', 'rest.cwd-not-absolute');
      expectSentence(await call(h, '/api/notes?cwd=/nie/na/liscie'), 400, 'cwd-not-allowed', 'rest.cwd-not-in-projects');
    } finally { await h.close(); }
  });
});

describe('browseDirectory i demoListing: zdania odmowy przeglądarki katalogów', () => {
  let base: string;
  beforeAll(async () => { base = await mkdtemp(path.join(tmpdir(), 'rarog-e2-rest-fs-')); });
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  const sentenceOf = async (raw: string, roots: string[]): Promise<unknown> => {
    const result = await browseDirectory(raw, { roots, storeRoot: base });
    return result.ok ? null : result.sentence.ref;
  };

  it('względna, ukryta, poza korzeniami, nie istnieje, dowiązanie poza korzenie', async () => {
    const { symlink, mkdir } = await import('node:fs/promises');
    const root = path.join(base, 'korzen');
    await mkdir(root, { recursive: true });
    await symlink(tmpdir(), path.join(root, 'skok'));
    expect(await sentenceOf('wzgledna', [root])).toEqual({ code: 'rest.cwd-not-absolute' });
    expect(await sentenceOf(path.join(root, '.git'), [root])).toEqual({ code: 'rest.cwd-hidden' });
    expect(await sentenceOf('/usr', [root])).toEqual({ code: 'rest.cwd-outside-roots' });
    expect(await sentenceOf(path.join(root, 'nie-ma'), [root])).toEqual({ code: 'rest.cwd-not-found' });
    expect(await sentenceOf(path.join(root, 'skok'), [root])).toEqual({ code: 'rest.cwd-symlink-escape' });
  });

  it('demo: katalog spoza listy projektów', () => {
    const result = demoListing('/inny', [{ name: 'willow', path: '/tmp/rarog-demo/willow' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.sentence.ref).toEqual({ code: 'rest.cwd-not-in-projects' });
  });
});

describe('notatki, dyktowanie, karta pytań, wysyłka, etykieta urządzenia', () => {
  it('notatki dla katalogu, którego nie ma', () => {
    let failure: unknown;
    try { notesPath('/tmp', '/nie/ma/takiego/katalogu-e2'); } catch (err) { failure = err; }
    expect((failure as { sentence: { ref: unknown; text: string } }).sentence).toMatchObject({
      text: say('rest.notes-cwd-not-allowed').text, ref: { code: 'rest.notes-cwd-not-allowed' },
    });
  });

  it('mint Soniox: każdy powód z kodem, słowo maszyny z systemu serwera', async () => {
    const minter = (over: { apiKey?: string; apiHost?: string; status?: number; system?: 'macos' | 'linux' }) => {
      const fetchImpl: FetchLike = () => Promise.resolve({ status: over.status ?? 500, json: () => Promise.resolve({}) });
      return createVoiceMinter({
        apiKey: over.apiKey ?? 'klucz', apiHost: over.apiHost, fetchImpl, minIntervalMs: 60_000, hourlyCap: 10,
        ...(over.system === undefined ? {} : { system: over.system }),
      });
    };
    const refOf = async (m: ReturnType<typeof minter>): Promise<unknown> => {
      const result = await m.mint();
      return result.ok ? null : { text: textOf(result.sentence), ref: (result.sentence as { ref?: unknown }).ref };
    };
    const exp = (code: SentenceCode): unknown => ({ text: say(code).text, ref: { code } });
    expect(await refOf(minter({ apiKey: '', system: 'macos' }))).toEqual(exp('rest.voice-disabled.mac'));
    expect(await refOf(minter({ apiKey: '', system: 'linux' }))).toEqual(exp('rest.voice-disabled.vps'));
    expect(await refOf(minter({ apiHost: 'api.soniox.com', system: 'macos' }))).toEqual(exp('rest.voice-foreign-region.mac'));
    expect(await refOf(minter({ apiHost: 'api.soniox.com', system: 'linux' }))).toEqual(exp('rest.voice-foreign-region.vps'));
    expect(await refOf(minter({ status: 401, system: 'macos' }))).toEqual(exp('rest.voice-key-rejected.mac'));
    expect(await refOf(minter({ status: 403, system: 'linux' }))).toEqual(exp('rest.voice-key-rejected.vps'));
    expect(await refOf(minter({ status: 500 }))).toEqual(exp('rest.voice-upstream'));
    const throttled = minter({ status: 500 });
    await throttled.mint();
    expect(await refOf(throttled)).toEqual(exp('rest.voice-throttled'));
  });

  it('notatki odpowiedzi na karcie pytań', () => {
    const request = {
      questions: [
        { question: 'Q1', header: 'H', multiSelect: false, notes: true, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Q2', header: 'H', multiSelect: false, options: [{ label: 'C' }] },
      ],
    } as unknown as QuestionRequest;
    const refOf = (answers: string[][], notes: (string | null)[]): unknown => {
      const out = checkAnswerNotes(request, answers, notes);
      return 'error' in out ? { text: out.error.text, ref: (out.error as { ref?: unknown }).ref } : null;
    };
    expect(refOf([['A']], ['x', 'y'])).toEqual({ text: say('session.answer-notes-mismatch').text, ref: { code: 'session.answer-notes-mismatch' } });
    expect(refOf([['A'], ['C']], [null, 'x'])).toEqual({ text: say('session.answer-note-not-allowed').text, ref: { code: 'session.answer-note-not-allowed' } });
    expect(refOf([['A', 'B']], ['x'])).toEqual({ text: say('session.answer-note-needs-option').text, ref: { code: 'session.answer-note-needs-option' } });
    expect(refOf([['A']], ['x'.repeat(MAX_ANSWER_NOTE_CHARS + 1)])).toEqual({
      text: 'The note is too long. Keep it within 8192 characters.',
      ref: { code: 'session.answer-note-too-long', args: [String(MAX_ANSWER_NOTE_CHARS)] },
    });
    const many = { questions: Array.from({ length: 5 }, () => request.questions[0]) } as unknown as QuestionRequest;
    const out = checkAnswerNotes(many, Array.from({ length: 5 }, () => ['A']), Array.from({ length: 5 }, () => 'x'.repeat(8_000)));
    expect('error' in out && (out.error as { ref?: unknown }).ref).toEqual({ code: 'session.answer-notes-too-long' });
  });

  it('etykieta urządzenia bez znaków: identyfikator rekordu po angielsku, bez kodu', () => {
    expect(LABEL_FALLBACK).toBe('device');
    expect(sanitizeLabel('\u0000')).toBe('device');
  });
});
