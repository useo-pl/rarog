/**
 * Rejestr sekretów hooka i gniazdo rejestracji kanału zgód (warstwa 1): `layer1/registry.ts`,
 * `auth/consent-socket.ts`, trasy kanału na gnieździe administracyjnym (`auth/admin.ts`).
 *
 * Prawdziwe gniazda Unix w katalogu tymczasowym, prawdziwy rejestr, zegar sterowany z testu. Przypadki modelu
 * zagrożeń kanału:
 * - podrobiony `alive.json` nic nie daje: rejestr odmawia według własnego zakresu, listy sesji i killswitcha;
 * - druga, inna rejestracja klucza blokuje go na stałe (409 `key-blocked`), serwer nie podpisze żadną;
 * - sekret nie wychodzi: odpowiedzi gniazd, log, pliki w `dataDir`, widok wpisu i liczniki;
 * - zalew rejestracji: limity sesji i wszystkich, termin życia wpisu, usunięcie, liczniki odmów;
 * - gniazdo rejestracji ma wyłącznie `POST /register`, gniazdo administracyjne nie ma `/register`.
 *
 * Do tego tryb z konfiguracji: przy `off` i `shadow` serwer gniazda rejestracji nie zakłada (start prawdziwego
 * `server/src/index.ts` w trybie `shadow`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_SOCKET_FILENAME, CONSENT_SOCKET_BODY_TIMEOUT_MS, CONSENT_UNAVAILABLE_ERROR, adminSocketPath,
  consentSocketPath, createAdminHandler, createConsentHandler, createDeviceStore, createPairing, startAdminSocket,
  startConsentSocket,
} from '../src/auth/index.ts';
import type { ConsentAdminControl, ConsentSocket, DeviceStore } from '../src/auth/index.ts';
import {
  CONSENT_CHANNEL_ENV, HERDR_LAUNCH_ENV, HERDR_SEND_ENV, HERDR_SOCKET_ENV, PUSH_ENV, TERM_ENV,
} from '../src/config-env.ts';
import { HOOK_ALIVE_FILENAME, HOOK_CHANNEL_MODES } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookChannelMode } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_ADMIN_OFF_ROUTE, CONSENT_ADMIN_RELEASE_ROUTE, CONSENT_ADMIN_ROUTES, CONSENT_REGISTER_BODY_MAX_BYTES,
  CONSENT_REGISTER_ROUTE, CONSENT_REGISTRATIONS_MAX, CONSENT_REGISTRATIONS_PER_SESSION_MAX, CONSENT_SECRET_BYTES,
  CONSENT_SOCKET_FILENAME,
} from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentAdminRelease, ConsentRegistration } from '../src/herdr/dialogs/layer1/contract.ts';
import {
  CONSENT_REGISTER_REFUSALS, CONSENT_REGISTRATION_TTL_MS, consentRegistrationWanted, consentRegistryScopeOf,
  createConsentRegistry, registrationWithoutCard,
} from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry, ConsentResumeExpect } from '../src/herdr/dialogs/layer1/registry.ts';
import { signConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import { DATA_DIR_ENV } from '../../shared/src/data-dir.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = Date.parse('2026-10-30T12:00:00.000Z');
const SESSION = '3f2b8c1e-5a7d-4e9f-b0c6-2d8e4f6a1b3c';
const OTHER_SESSION = '7c4d2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Rejestracja w kształcie, który wysyła hook; `seed` daje inny klucz i skróty, sekret zawsze losowy. */
function registration(seed: string, over: Partial<ConsentRegistration> = {}): ConsentRegistration {
  const promptId = over.promptId ?? `p${sha(`prompt-${seed}`).slice(0, 12)}`;
  return {
    key: `${promptId}-${sha(`nonce-${seed}`).slice(0, 32)}`,
    sessionId: SESSION,
    promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
    inputSha256: sha(`input-${seed}`),
    cardSha256: sha(`card-${seed}`),
    pid: process.pid,
    startedAt: T0 - 1_000,
    ...over,
  };
}

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

/** Żądanie przez gniazdo Unix; `raw` = ciało wysłane bez `JSON.stringify`. */
function socketCall(
  socketPath: string, method: string, route: string, body?: unknown, raw?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? '' : JSON.stringify(body));
    const req = http.request({
      socketPath, path: route, method, headers: { 'Content-Length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, text, body: text === '' ? null : JSON.parse(text) as unknown });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Status odpowiedzi na żądanie wysłane jednym zapisem surowego HTTP. Ciało ponad sufit serwer odcina po odpowiedzi
 * 413, więc klient `http` dostałby EPIPE przy dosyłaniu; jeden zapis mieści się w buforze gniazda.
 */
function rawStatus(socketPath: string, route: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    let text = '';
    const done = (): void => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(text);
      if (status === null) reject(new Error(`brak odpowiedzi: ${text}`));
      else resolve(Number(status[1]));
    };
    conn.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    conn.on('close', done);
    conn.on('error', () => {});
    conn.write(`POST ${route} HTTP/1.1\r\nHost: rarog\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n`
      + `Connection: close\r\n\r\n${body}`);
  });
}

/** Wszystkie pliki pod katalogiem jako tekst (gniazda pomijane). */
function filesUnder(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [file, text] of filesUnder(full)) out.set(file, text);
    else if (entry.isFile()) out.set(full, readFileSync(full, 'utf8'));
  }
  return out;
}

interface Scene {
  readonly dir: string;
  readonly registry: ConsentRegistry;
  readonly logs: string[];
  sessions: string[];
  send: boolean;
  clock: number;
}

let dir = '';
const sockets: ConsentSocket[] = [];
const stores: DeviceStore[] = [];

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'l1r-')); });
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  // Magazyn urządzeń przy pierwszym starcie zapisuje `devices.json` w tle (mkdir, tmp, rename). Bez czekania zapis
  // trafiał pod obciążeniem w środek `rmSync` i kasowanie padało na `ENOTEMPTY` mimo ponowień.
  for (const store of stores.splice(0)) await store.flush();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** Rejestr z zakresem `main`, sesją na liście i włączoną wysyłką; zegar od stałej chwili startu testu. */
function scene(): Scene {
  const logs: string[] = [];
  const state: Scene = {
    dir,
    logs,
    sessions: [SESSION],
    send: true,
    clock: T0,
    registry: createConsentRegistry({
      bootId: 'boot-1',
      send: () => state.send,
      sessions: () => state.sessions,
      log: (line) => { logs.push(line); },
      now: () => state.clock,
    }),
  };
  state.registry.setScope('main');
  return state;
}

async function consentSocket(registry: ConsentRegistry, logs: string[] = []): Promise<string> {
  const socket = await startConsentSocket(dir, createConsentHandler(registry), (line) => { logs.push(line); });
  if (socket === null) throw new Error('gniazdo rejestracji nie wstało');
  sockets.push(socket);
  return socket.path;
}

async function adminSocket(consent?: ConsentAdminControl): Promise<string> {
  const store = createDeviceStore({ dataDir: dir, epoch: '1' });
  stores.push(store);
  const pairing = createPairing({ store, epoch: '1' });
  const handler = createAdminHandler({
    store, pairing, publicUrl: null, log: () => {}, ...(consent === undefined ? {} : { consent }),
  });
  const socket = await startAdminSocket(dir, handler, () => {});
  if (socket === null) throw new Error('gniazdo administracyjne nie wstało');
  sockets.push(socket);
  return socket.path;
}

describe('gniazdo rejestracji `<dataDir>/run/consent.sock`', () => {
  it('powstaje obok gniazda administracyjnego: katalog 0o700, gniazdo 0o600, rejestracja przez gniazdo', async () => {
    const s = scene();
    const adminPath = await adminSocket();
    const consentPath = await consentSocket(s.registry);
    expect(consentPath).toBe(consentSocketPath(dir));
    expect(path.basename(consentPath)).toBe(CONSENT_SOCKET_FILENAME);
    expect(path.dirname(consentPath)).toBe(path.dirname(adminPath));
    expect(lstatSync(consentPath).isSocket()).toBe(true);
    expect(statSync(path.dirname(consentPath)).mode & 0o777).toBe(0o700);
    expect(statSync(consentPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(consentPath)).sort()).toEqual([ADMIN_SOCKET_FILENAME, CONSENT_SOCKET_FILENAME]);

    const reg = registration('a');
    const reply = await socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, reg);
    expect(reply).toMatchObject({ status: 200, body: { accepted: true, bootId: 'boot-1' } });
    expect(s.registry.secretOf(SESSION, reg.key)).toBe(reg.secret);
  });

  it('żywe gniazdo innego procesu zostaje, martwe jest zastępowane, za długa ścieżka = gniazda nie ma', async () => {
    const s = scene();
    const first = await consentSocket(s.registry);
    const logs: string[] = [];
    expect(await startConsentSocket(dir, createConsentHandler(s.registry), (line) => { logs.push(line); })).toBeNull();
    expect(logs.some((line) => line.includes('another live process'))).toBe(true);
    expect((await socketCall(first, 'POST', CONSENT_REGISTER_ROUTE, registration('b'))).status).toBe(200);
    await sockets.splice(0)[0]?.close();
    expect(existsSync(first)).toBe(false);
    // Martwe gniazdo po awarii procesu: plik zostaje bez słuchacza.
    spawnSync(process.execPath, ['-e',
      `require('node:net').createServer().listen(${JSON.stringify(first)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    expect(lstatSync(first).isSocket()).toBe(true);
    const replaced = await consentSocket(s.registry);
    expect((await socketCall(replaced, 'POST', CONSENT_REGISTER_ROUTE, registration('c'))).status).toBe(200);
    const deep = path.join(dir, 'x'.repeat(120));
    expect(await startConsentSocket(deep, createConsentHandler(s.registry), (line) => { logs.push(line); })).toBeNull();
    expect(logs.some((line) => line.startsWith('consent: socket path longer than'))).toBe(true);
  });

  it('ciało: ponad sufit 413, zły JSON i obce pole 400, klucz spoza `promptId` 400', async () => {
    const s = scene();
    const consentPath = await consentSocket(s.registry);
    const big = JSON.stringify({ ...registration('d'), pad: 'x'.repeat(CONSENT_REGISTER_BODY_MAX_BYTES) });
    expect(Buffer.byteLength(big)).toBeGreaterThan(CONSENT_REGISTER_BODY_MAX_BYTES);
    expect(await rawStatus(consentPath, CONSENT_REGISTER_ROUTE, big)).toBe(413);
    expect(await socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, undefined, '{nie json'))
      .toMatchObject({ status: 400, body: { accepted: false, error: 'bad-request' } });
    expect((await socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, { ...registration('e'), message: 'x' })).status)
      .toBe(400);
    const foreign = registration('f');
    expect((await socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, { ...foreign, promptId: 'inny' })).status)
      .toBe(400);
    for (const field of ['secret', 'inputSha256', 'cardSha256'] as const) {
      expect((await socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, { ...registration(field), [field]: 'ab' }))
        .status, field).toBe(400);
    }
    expect(s.registry.entries()).toEqual([]);
    expect(s.registry.stats().refused['bad-request']).toBe(5);
  });

  it('adres, którego `URL` nie przetworzy, dostaje 400, a oba gniazda obsługują następne żądanie', async () => {
    const s = scene();
    const consentPath = await consentSocket(s.registry);
    const adminPath = await adminSocket();
    // Parser HTTP Node przepuszcza taki adres; `new URL` go odrzuca.
    expect(await rawStatus(consentPath, 'http://[', '')).toBe(400);
    expect((await socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, registration('u'))).status).toBe(200);
    expect(await rawStatus(adminPath, 'http://[', '')).toBeGreaterThanOrEqual(400);
    expect((await socketCall(adminPath, 'POST', '/api/admin/dialogs/off')).status).toBe(503);
  });

  it(`ciało, które nie przychodzi, dostaje 400 po ${String(CONSENT_SOCKET_BODY_TIMEOUT_MS)} ms`, async () => {
    const s = scene();
    const consentPath = await consentSocket(s.registry);
    const started = Date.now();
    const reply = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        socketPath: consentPath, path: CONSENT_REGISTER_ROUTE, method: 'POST', headers: { 'Content-Length': '100' },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.write('{"key":');
    });
    expect(reply).toBe(400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(CONSENT_SOCKET_BODY_TIMEOUT_MS - 50);
  }, 10_000);
});

describe('gniazda: jedna trasa rejestracji, władza właściciela osobno', () => {
  const ADMIN_ROUTES = [
    ['POST', '/api/admin/pairings'], ['GET', '/api/admin/pairings/x'], ['GET', '/api/admin/devices'],
    ['POST', '/api/admin/devices/revoke'], ...CONSENT_ADMIN_ROUTES.map((route) => ['POST', route]),
  ] as const;

  it('`consent.sock` ma wyłącznie `POST /register`: trasy administracyjne 404, inna metoda 405', async () => {
    const s = scene();
    const consentPath = await consentSocket(s.registry);
    for (const [method, route] of ADMIN_ROUTES) {
      const reply = await socketCall(consentPath, method, route, method === 'POST' ? { all: true } : undefined);
      expect(reply, `${method} ${route}`).toMatchObject({ status: 404, body: { accepted: false, error: 'not-found' } });
    }
    for (const route of ['/', '/register/', '/api/register', `${CONSENT_REGISTER_ROUTE}x`]) {
      expect((await socketCall(consentPath, 'POST', route, registration(route))).status, route).toBe(404);
    }
    for (const method of ['GET', 'PUT', 'DELETE']) {
      expect((await socketCall(consentPath, method, CONSENT_REGISTER_ROUTE)).status, method).toBe(405);
    }
    expect(s.registry.entries()).toEqual([]);
  });

  it('`admin.sock` nie ma `/register`; trasy kanału stoją tylko na nim', async () => {
    const s = scene();
    const calls: string[] = [];
    const adminPath = await adminSocket({ release: () => { calls.push('release'); return []; }, off: () => { calls.push('off'); } });
    const consentPath = await consentSocket(s.registry);
    const reply = await socketCall(adminPath, 'POST', CONSENT_REGISTER_ROUTE, registration('g'));
    expect(reply).toMatchObject({ status: 404, body: { error: 'not-found' } });
    expect(s.registry.entries()).toEqual([]);
    expect((await socketCall(adminPath, 'POST', CONSENT_ADMIN_OFF_ROUTE)).status).toBe(200);
    expect((await socketCall(consentPath, 'POST', CONSENT_ADMIN_OFF_ROUTE)).status).toBe(404);
    expect(calls).toEqual(['off']);
  });
});

describe('gniazdo administracyjne: trasy kanału zgód', () => {
  it('bez sterowania kanałem obie trasy oddają 503 `consent-unavailable`', async () => {
    const adminPath = await adminSocket();
    for (const route of CONSENT_ADMIN_ROUTES) {
      const reply = await socketCall(adminPath, 'POST', route, { sessionId: SESSION });
      expect(reply, route).toMatchObject({ status: 503, body: { error: CONSENT_UNAVAILABLE_ERROR } });
    }
  });

  it('`dialogs/release` przekazuje sprawdzone ciało i oddaje klucze; złe ciało 400 bez wywołania', async () => {
    const released: ConsentAdminRelease[] = [];
    const key = registration('h').key;
    const adminPath = await adminSocket({
      release: (request) => { released.push(request); return request.key === undefined ? [key] : [request.key]; },
      off: () => {},
    });
    expect(await socketCall(adminPath, 'POST', CONSENT_ADMIN_RELEASE_ROUTE, { sessionId: SESSION }))
      .toMatchObject({ status: 200, body: { released: [key] } });
    expect(await socketCall(adminPath, 'POST', CONSENT_ADMIN_RELEASE_ROUTE, { sessionId: SESSION, key }))
      .toMatchObject({ status: 200, body: { released: [key] } });
    expect(released).toEqual([{ sessionId: SESSION }, { sessionId: SESSION, key }]);
    for (const body of [{}, { sessionId: '' }, { sessionId: SESSION, key: 'zly klucz' }, { sessionId: SESSION, all: true },
      { sessionId: 's'.repeat(129) }]) {
      expect((await socketCall(adminPath, 'POST', CONSENT_ADMIN_RELEASE_ROUTE, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await socketCall(adminPath, 'GET', CONSENT_ADMIN_RELEASE_ROUTE)).status).toBe(405);
    expect(released).toHaveLength(2);
  });

  it('`dialogs/off` woła wyłącznik i oddaje `off`; inna metoda 405', async () => {
    let offs = 0;
    const adminPath = await adminSocket({ release: () => [], off: () => { offs += 1; } });
    expect(await socketCall(adminPath, 'POST', CONSENT_ADMIN_OFF_ROUTE)).toMatchObject({ status: 200, body: { mode: 'off' } });
    expect((await socketCall(adminPath, 'GET', CONSENT_ADMIN_OFF_ROUTE)).status).toBe(405);
    expect(offs).toBe(1);
  });
});

describe('rejestr odmawia według własnego stanu, nie `alive.json`', () => {
  it('zakres `closed` = 503 dla każdego, także przy podrobionym `alive.json` z trybem kanału', async () => {
    const s = scene();
    s.registry.setScope('closed');
    writeFileSync(path.join(dir, HOOK_ALIVE_FILENAME),
      `${JSON.stringify({ ts: T0, bootId: 'boot-1', mode: 'main', send: true, sessions: [SESSION] })}\n`);
    const consentPath = await consentSocket(s.registry);
    const reply = await socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, registration('i'));
    expect(reply).toMatchObject({ status: 503, body: { accepted: false, error: 'channel-closed' } });
    expect(s.registry.entries()).toEqual([]);
  });

  it('zakres `main`: subagent, killswitch wysyłki i sesja spoza listy = 503; zmiana zakresu nie rusza wpisów', async () => {
    const s = scene();
    const consentPath = await consentSocket(s.registry);
    const post = (reg: ConsentRegistration): Promise<Reply> => socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, reg);
    expect((await post(registration('j', { agentId: 'agent-1' }))).body).toEqual({ accepted: false, error: 'subagent' });
    s.send = false;
    expect((await post(registration('k'))).body).toEqual({ accepted: false, error: 'send-off' });
    s.send = true;
    expect((await post(registration('l', { sessionId: OTHER_SESSION }))).body)
      .toEqual({ accepted: false, error: 'session-unknown' });
    for (const error of ['subagent', 'send-off', 'session-unknown'] as const) {
      expect(CONSENT_REGISTER_REFUSALS[error]).toBe(503);
    }
    const ok = registration('m');
    expect((await post(ok)).status).toBe(200);
    s.registry.setScope('closed');
    expect((await post(registration('n'))).status).toBe(503);
    expect(s.registry.secretOf(SESSION, ok.key)).toBe(ok.secret);
    expect(s.registry.stats().refused).toMatchObject({ 'subagent': 1, 'send-off': 1, 'session-unknown': 1, 'channel-closed': 1 });
  });

  it('zakres `all`: rejestracja z `agentId` przyjęta, wpis niesie `agentId`; przy `main` ta sama = 503'
    + ' `subagent`; killswitch i sesja spoza listy dalej odmawiają', async () => {
    const s = scene();
    s.registry.setScope('all');
    expect(s.registry.scope()).toBe('all');
    const consentPath = await consentSocket(s.registry);
    const post = (reg: ConsentRegistration): Promise<Reply> => socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, reg);
    const sub = registration('sub-all', { agentId: 'agent-1' });
    expect(await post(sub)).toMatchObject({ status: 200, body: { accepted: true, bootId: 'boot-1' } });
    expect(s.registry.entry(SESSION, sub.key)).toMatchObject({ agentId: 'agent-1', blocked: false });
    expect(s.registry.secretOf(SESSION, sub.key)).toBe(sub.secret);
    s.send = false;
    expect((await post(registration('sub-all-send', { agentId: 'agent-1' }))).body)
      .toEqual({ accepted: false, error: 'send-off' });
    s.send = true;
    expect((await post(registration('sub-all-obca', { agentId: 'agent-1', sessionId: OTHER_SESSION }))).body)
      .toEqual({ accepted: false, error: 'session-unknown' });
    s.registry.setScope('main');
    expect(await post(registration('sub-main', { agentId: 'agent-1' })))
      .toMatchObject({ status: 503, body: { accepted: false, error: 'subagent' } });
    // Zmiana zakresu nie rusza przyjętego wpisu subagenta.
    expect(s.registry.secretOf(SESSION, sub.key)).toBe(sub.secret);
  });

  it('zakres rejestru z trybu efektywnego: `all` → `all`, `main` → `main`, reszta → `closed`', () => {
    expect(['off', 'shadow', 'main', 'all', 'nowy', null].map((mode) => consentRegistryScopeOf(mode)))
      .toEqual(['closed', 'closed', 'main', 'all', 'closed', 'closed']);
  });
});

describe('druga rejestracja klucza', () => {
  it('pierwsza wygrywa; identyczna powtórka przyjęta; inny sekret blokuje klucz na stałe', async () => {
    const s = scene();
    const consentPath = await consentSocket(s.registry);
    const first = registration('o');
    const post = (reg: ConsentRegistration): Promise<Reply> => socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, reg);
    expect((await post(first)).status).toBe(200);
    expect((await post({ ...first })).status).toBe(200);
    expect(s.registry.stats()).toMatchObject({ accepted: 1, repeated: 1 });
    expect(s.registry.entry(SESSION, first.key)).toMatchObject({ blocked: false, acceptedAt: T0 });

    const intruder = { ...first, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex') };
    expect(await post(intruder)).toMatchObject({ status: 409, body: { accepted: false, error: 'key-blocked' } });
    expect(s.registry.entry(SESSION, first.key)).toMatchObject({ blocked: true, cardSha256: first.cardSha256 });
    expect(s.registry.secretOf(SESSION, first.key)).toBeNull();
    // Po blokadzie nie przechodzi nawet pierwsza rejestracja: serwer nie wie, która była hookiem.
    expect((await post(first)).status).toBe(409);
    expect(s.logs.filter((line) => line.includes('blocked'))).toHaveLength(1);
  });

  it('ten sam sekret z innym pidem, skrótem albo z innej sesji też blokuje', () => {
    const s = scene();
    s.sessions = [SESSION, OTHER_SESSION];
    const variants: ((reg: ConsentRegistration) => ConsentRegistration)[] = [
      (reg) => ({ ...reg, pid: reg.pid + 1 }),
      (reg) => ({ ...reg, cardSha256: sha('inna karta') }),
      (reg) => ({ ...reg, inputSha256: sha('inne wejście') }),
      (reg) => ({ ...reg, sessionId: OTHER_SESSION }),
    ];
    variants.forEach((change, i) => {
      const first = registration(`p${String(i)}`);
      expect(s.registry.register(first).status).toBe(200);
      expect(s.registry.register(change(first))).toEqual({ status: 409, body: { accepted: false, error: 'key-blocked' } });
      expect(s.registry.secretOf(SESSION, first.key), String(i)).toBeNull();
    });
  });

  it('dwie rejestracje naraz przez gniazdo: jedna przyjęta, druga 409, klucz bez sekretu do podpisu', async () => {
    const s = scene();
    const consentPath = await consentSocket(s.registry);
    const a = registration('q');
    const b = { ...a, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex') };
    const replies = await Promise.all([a, b].map((reg) => socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, reg)));
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(s.registry.secretOf(SESSION, a.key)).toBeNull();
  });
});

describe('sekret nie wychodzi z rejestru', () => {
  it('odpowiedzi obu gniazd, log, pliki w `dataDir`, widok wpisu i liczniki bez sekretu; odpowiedź i log bez skrótu karty', async () => {
    const s = scene();
    const socketLogs: string[] = [];
    const consentPath = await consentSocket(s.registry, socketLogs);
    const adminPath = await adminSocket();
    const reg = registration('r');
    const texts: string[] = [];
    const post = async (body: unknown): Promise<void> => {
      texts.push((await socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, body)).text);
    };
    await post(reg);
    await post(reg);
    await post({ ...reg, pid: reg.pid + 1 });
    await post({ ...reg, agentId: 'agent-1' });
    await post({ ...reg, extra: reg.secret });
    texts.push((await socketCall(consentPath, 'GET', CONSENT_REGISTER_ROUTE)).text);
    texts.push((await socketCall(adminPath, 'POST', CONSENT_REGISTER_ROUTE, reg)).text);
    texts.push((await socketCall(adminPath, 'POST', CONSENT_ADMIN_RELEASE_ROUTE, { sessionId: SESSION, key: reg.key })).text);
    const views = JSON.stringify([s.registry.entries(), s.registry.entry(SESSION, reg.key), s.registry.stats()]);
    const files = [...filesUnder(dir).values()];
    const everything = [...texts, ...s.logs, ...socketLogs, views, ...files].join('\n');
    expect(texts.length).toBe(8);
    expect(s.logs.length).toBeGreaterThan(0);
    expect(everything).not.toContain(reg.secret);
    expect(everything.toUpperCase()).not.toContain(reg.secret.toUpperCase());
    expect([...texts, ...s.logs, ...socketLogs].join('\n')).not.toContain(reg.cardSha256);
  });
});

describe('registration without a channel card holds back the measured "Yes" digit', () => {
  it('any live registration of the session without a card, a subagent\'s too, of any age; card, other session and'
    + ' TTL end it', () => {
    const s = scene();
    s.sessions = [SESSION, OTHER_SESSION];
    s.registry.setScope('all');
    const sub = registration('sub', { agentId: 'agent-1' });
    expect(s.registry.register(sub).status).toBe(200);
    const carded = (keys: readonly string[]) => ({
      registry: s.registry, cycle: { cards: () => keys.map((permId) => ({ permId })) },
    });
    expect(registrationWithoutCard(carded([]), SESSION)).toBe(true);
    s.clock = T0 + 60_000;
    expect(registrationWithoutCard(carded([]), SESSION)).toBe(true);
    expect(registrationWithoutCard(carded([sub.key]), SESSION)).toBe(false);
    expect(registrationWithoutCard(carded([]), OTHER_SESSION)).toBe(false);
    expect(registrationWithoutCard({ registry: s.registry, cycle: null }, SESSION)).toBe(true);
    expect(registrationWithoutCard({ registry: null, cycle: null }, SESSION)).toBe(false);
    s.clock = T0 + CONSENT_REGISTRATION_TTL_MS;
    expect(registrationWithoutCard(carded([]), SESSION)).toBe(false);
  });
});

describe('zalew rejestracji', () => {
  it(`najwyżej ${String(CONSENT_REGISTRATIONS_PER_SESSION_MAX)} żywych wpisów na sesję, potem 429`, () => {
    const s = scene();
    s.sessions = [SESSION, OTHER_SESSION];
    for (let i = 0; i < CONSENT_REGISTRATIONS_PER_SESSION_MAX; i += 1) {
      expect(s.registry.register(registration(`s${String(i)}`)).status).toBe(200);
    }
    expect(s.registry.register(registration('s-over')))
      .toEqual({ status: 429, body: { accepted: false, error: 'session-limit' } });
    expect(s.registry.register(registration('s-other', { sessionId: OTHER_SESSION })).status).toBe(200);
    // Usunięty wpis (proces hooka nie żyje) zwalnia miejsce.
    const gone = registration('s0');
    expect(s.registry.forget(SESSION, gone.key)).toBe(true);
    expect(s.registry.forget(SESSION, gone.key)).toBe(false);
    expect(s.registry.register(registration('s-after-forget')).status).toBe(200);
    expect(s.registry.stats().refused['session-limit']).toBe(1);
  });

  it(`najwyżej ${String(CONSENT_REGISTRATIONS_MAX)} żywych wpisów razem, potem 429`, () => {
    const s = scene();
    const perSession = CONSENT_REGISTRATIONS_PER_SESSION_MAX;
    const sessionCount = Math.ceil(CONSENT_REGISTRATIONS_MAX / perSession) + 1;
    s.sessions = Array.from({ length: sessionCount }, (_, i) => `sesja-${String(i)}`);
    let accepted = 0;
    let refused = 0;
    for (const sessionId of s.sessions) {
      for (let i = 0; i < perSession; i += 1) {
        const outcome = s.registry.register(registration(`${sessionId}-${String(i)}`, { sessionId }));
        if (outcome.status === 200) accepted += 1;
        else {
          expect(outcome.body).toEqual({ accepted: false, error: 'global-limit' });
          refused += 1;
        }
      }
    }
    expect(accepted).toBe(CONSENT_REGISTRATIONS_MAX);
    expect(refused).toBe(sessionCount * perSession - CONSENT_REGISTRATIONS_MAX);
    expect(s.registry.entries()).toHaveLength(CONSENT_REGISTRATIONS_MAX);
    expect(s.registry.stats().refused['global-limit']).toBe(refused);
  });

  it('wpis żyje do terminu hooka z zapasem; po nim znika razem z sekretem i zwalnia miejsce', () => {
    const s = scene();
    const regs = Array.from({ length: CONSENT_REGISTRATIONS_PER_SESSION_MAX }, (_, i) => registration(`t${String(i)}`));
    for (const reg of regs) expect(s.registry.register(reg).status).toBe(200);
    const first = regs[0]!;
    s.clock = T0 + CONSENT_REGISTRATION_TTL_MS - 1;
    expect(s.registry.secretOf(SESSION, first.key)).toBe(first.secret);
    expect(s.registry.register(registration('t-over')).status).toBe(429);
    s.clock = T0 + CONSENT_REGISTRATION_TTL_MS;
    expect(s.registry.secretOf(SESSION, first.key)).toBeNull();
    expect(s.registry.entry(SESSION, first.key)).toBeNull();
    expect(s.registry.entries()).toEqual([]);
    expect(s.registry.register(registration('t-after')).status).toBe(200);
    // Ten sam klucz po terminie to nowa rejestracja, nie blokada.
    expect(s.registry.register(first).status).toBe(200);
  });

  it('wpis innej sesji nie wychodzi pod cudzą sesją', () => {
    const s = scene();
    const reg = registration('u');
    expect(s.registry.register(reg).status).toBe(200);
    expect(s.registry.entry(OTHER_SESSION, reg.key)).toBeNull();
    expect(s.registry.secretOf(OTHER_SESSION, reg.key)).toBeNull();
    expect(s.registry.forget(OTHER_SESSION, reg.key)).toBe(false);
    expect(s.registry.secretOf(SESSION, reg.key)).toBe(reg.secret);
  });
});

describe('gniazdo rejestracji tylko w trybie, który go wymaga', () => {
  it('`off` i `shadow` nie wymagają rejestracji; `main`, `all` i każdy inny tryb wymaga', () => {
    const wanted = Object.fromEntries(HOOK_CHANNEL_MODES.map((mode) => [mode, consentRegistrationWanted(mode)]));
    expect(wanted).toEqual({ off: false, shadow: false, main: true, all: true });
    expect(consentRegistrationWanted('nowy' as HookChannelMode)).toBe(true);
  });

  it('serwer w trybie `shadow` startuje jak dotąd: gniazdo administracyjne jest, gniazda rejestracji nie ma', async () => {
    const dataDir = path.join(dir, 'd');
    const home = path.join(dir, 'h');
    mkdirSync(dataDir);
    mkdirSync(home);
    const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), ['server/src/index.ts'], {
      cwd: REPO,
      // Port 0, herdr pod nieistniejącym gniazdem, bez pushy, terminala, wysyłki i zakładania paneli: serwer nie
      // dotyka niczego poza katalogiem testu.
      env: {
        PATH: process.env['PATH'] ?? '', HOME: home, TMPDIR: tmpdir(),
        RAROG_ORIGINS: 'https://serwer.example', RAROG_PORT: '0',
        [DATA_DIR_ENV]: dataDir, [CONSENT_CHANNEL_ENV]: 'shadow', [HERDR_SOCKET_ENV]: path.join(dir, 'brak.sock'),
        [HERDR_SEND_ENV]: '0', [HERDR_LAUNCH_ENV]: '0', [PUSH_ENV]: '0', [TERM_ENV]: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const exited = new Promise<number | null>((resolve) => { child.on('close', (code) => { resolve(code); }); });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`serwer nie wstał:\n${output}`)); }, 40_000);
        const onData = (chunk: Buffer): void => {
          output += chunk.toString('utf8');
          const listening = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
          if (listening !== null && output.includes('admin: admin socket')) {
            clearTimeout(timer);
            resolve(Number(listening[1]));
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
      });
      const health = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(health.status).toBe(200);
      expect(existsSync(adminSocketPath(dataDir))).toBe(true);
      expect(existsSync(consentSocketPath(dataDir))).toBe(false);
      expect(readdirSync(path.dirname(adminSocketPath(dataDir)))).toEqual([ADMIN_SOCKET_FILENAME]);
      expect(output).toContain('hook consent channel shadow');
      expect(output).not.toContain('consent: registration socket');
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  }, 60_000);
});

describe('second registration of a key after a server restart (restart grace)', () => {
  const GRACE_MS = 45_000;

  /** {@link scene} with the restart grace and scope `all`; `graceMs` 0 = no grace, `null` = no option. */
  function graceScene(graceMs: number | null = GRACE_MS): Scene {
    const logs: string[] = [];
    const state: Scene = {
      dir, logs, sessions: [SESSION], send: true, clock: T0,
      registry: createConsentRegistry({
        bootId: 'boot-2', send: () => state.send, sessions: () => state.sessions,
        log: (line) => { logs.push(line); }, now: () => state.clock,
        ...(graceMs === null ? {} : { restartGraceMs: graceMs }),
      }),
    };
    state.registry.setScope('all');
    return state;
  }

  /** What the recovered record of `reg` expects: its call identity and card digest. */
  function expectOf(reg: ConsentRegistration, over: Partial<ConsentResumeExpect> = {}): ConsentResumeExpect {
    return {
      key: reg.key, sessionId: reg.sessionId, promptId: reg.promptId, agentId: reg.agentId ?? null, pid: reg.pid,
      startedAt: reg.startedAt, inputSha256: reg.inputSha256, cardSha256: reg.cardSha256, ...over,
    };
  }

  /** `reg` under another `promptId`: the key keeps its nonce and takes the new prefix. */
  const withPrompt = (reg: ConsentRegistration, promptId: string): ConsentRegistration =>
    ({ ...reg, promptId, key: `${promptId}${reg.key.slice(reg.promptId.length)}` });

  it('equal in every field: 200 with `resumed: true` and the new `bootId` through the socket; the entry signs, a repeat'
    + ' stays resumed, another secret then blocks the key', async () => {
    const s = graceScene();
    const consentPath = await consentSocket(s.registry);
    const reg = registration('w1');
    s.registry.expectResume(expectOf(reg));
    s.clock += 20_000;
    const post = (body: ConsentRegistration): Promise<Reply> =>
      socketCall(consentPath, 'POST', CONSENT_REGISTER_ROUTE, body);
    const first = await post(reg);
    expect(first).toMatchObject({ status: 200 });
    expect(first.body).toEqual({ accepted: true, bootId: 'boot-2', resumed: true });
    expect(s.registry.entry(SESSION, reg.key)).toMatchObject({ resumed: true, blocked: false, acceptedAt: T0 + 20_000 });
    expect(s.registry.secretOf(SESSION, reg.key)).toBe(reg.secret);
    expect((await post({ ...reg })).body).toEqual({ accepted: true, bootId: 'boot-2', resumed: true });
    // One line for the second registration, none for its repeat.
    expect(s.logs.filter((line) => line.includes(`key ${reg.key}`))).toHaveLength(1);
    expect(s.logs.join('\n')).not.toContain(reg.secret);
    const other = { ...reg, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex') };
    expect(await post(other)).toMatchObject({ status: 409, body: { accepted: false, error: 'key-blocked' } });
    expect(s.registry.secretOf(SESSION, reg.key)).toBeNull();
  });

  it.each([
    ['promptId', (reg: ConsentRegistration): ConsentRegistration => withPrompt(reg, `${reg.promptId}x`)],
    ['agentId', (reg: ConsentRegistration): ConsentRegistration => ({ ...reg, agentId: 'agent-1' })],
    ['pid', (reg: ConsentRegistration): ConsentRegistration => ({ ...reg, pid: reg.pid + 1 })],
    ['startedAt', (reg: ConsentRegistration): ConsentRegistration => ({ ...reg, startedAt: reg.startedAt + 1 })],
    ['inputSha256', (reg: ConsentRegistration): ConsentRegistration => ({ ...reg, inputSha256: sha('other input') })],
    ['cardSha256', (reg: ConsentRegistration): ConsentRegistration => ({ ...reg, cardSha256: sha('other card') })],
  ] as const)('different `%s`: 409 `key-blocked`, the entry blocked, no secret to sign with', (_field, change) => {
    const s = graceScene();
    const reg = registration('w2');
    const changed = change(reg);
    s.registry.expectResume(expectOf(reg, { key: changed.key }));
    expect(s.registry.register(changed)).toEqual({ status: 409, body: { accepted: false, error: 'key-blocked' } });
    expect(s.registry.entry(SESSION, changed.key)).toMatchObject({ blocked: true });
    expect(s.registry.secretOf(SESSION, changed.key)).toBeNull();
    expect(s.registry.register({ ...changed }).status).toBe(409);
    expect(s.logs.filter((line) => line.includes(`key ${changed.key} blocked`))).toHaveLength(1);
  });

  it('another session under the expected key: 409, the key blocked', () => {
    const s = graceScene();
    s.sessions = [SESSION, OTHER_SESSION];
    const reg = registration('w3');
    s.registry.expectResume(expectOf(reg));
    expect(s.registry.register({ ...reg, sessionId: OTHER_SESSION }).status).toBe(409);
    expect(s.registry.register(reg).status).toBe(409);
  });

  it('a written answer file: the secret must verify its signature; the same fields with another secret block the key',
    () => {
      const reg = registration('w4');
      const file = signConsentFile(reg.secret, {
        key: reg.key, sessionId: SESSION, decision: 'allow', reasonId: 'allow', inputSha256: reg.inputSha256,
        cardSha256: reg.cardSha256, at: T0 - 500,
      });
      const answer = { file, permissionsSha256: null };
      const good = graceScene();
      good.registry.expectResume(expectOf(reg, { answer }));
      expect(good.registry.register(reg)).toMatchObject({ status: 200, body: { resumed: true } });
      const bad = graceScene();
      bad.registry.expectResume(expectOf(reg, { answer }));
      const forged = { ...reg, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex') };
      expect(bad.registry.register(forged)).toMatchObject({ status: 409, body: { error: 'key-blocked' } });
      expect(bad.registry.register(reg).status).toBe(409);
    });

  it('the channel refusals come first and keep the expectation: 503 until the session is observed, then resumed', () => {
    const s = graceScene();
    const reg = registration('w5');
    s.registry.expectResume(expectOf(reg));
    s.registry.setScope('closed');
    expect(s.registry.register(reg)).toMatchObject({ status: 503, body: { error: 'channel-closed' } });
    s.registry.setScope('all');
    s.sessions = [];
    expect(s.registry.register(reg)).toMatchObject({ status: 503, body: { error: 'session-unknown' } });
    s.sessions = [SESSION];
    expect(s.registry.register(reg)).toMatchObject({ status: 200, body: { resumed: true } });
  });

  it('after the grace, after `cancelResume` and without the grace: a first registration, without `resumed`', () => {
    const late = graceScene();
    const a = registration('w6');
    late.registry.expectResume(expectOf(a));
    late.clock += GRACE_MS;
    expect(late.registry.register(a)).toEqual({ status: 200, body: { accepted: true, bootId: 'boot-2' } });

    const cancelled = graceScene();
    const b = registration('w7');
    cancelled.registry.expectResume(expectOf(b));
    cancelled.registry.cancelResume(SESSION, b.key);
    expect(cancelled.registry.register(b)).toEqual({ status: 200, body: { accepted: true, bootId: 'boot-2' } });

    for (const graceMs of [0, null]) {
      const none = graceScene(graceMs);
      const c = registration(`w8-${String(graceMs)}`);
      none.registry.expectResume(expectOf(c));
      expect(none.registry.register(c)).toEqual({ status: 200, body: { accepted: true, bootId: 'boot-2' } });
      expect(none.registry.entry(SESSION, c.key)?.resumed).toBeUndefined();
    }
  });

  it('`onResumed` gets the second registration time once: not for its repeat, a refused registration or one after the'
    + ' grace; a callback that throws leaves the answer as it is', () => {
    const s = graceScene();
    const calls: string[] = [];
    const expectTold = (reg: ConsentRegistration): void => {
      s.registry.expectResume({ ...expectOf(reg), onResumed: (at) => { calls.push(`${reg.key}@${String(at)}`); } });
    };
    const resumed = registration('w9');
    expectTold(resumed);
    s.clock += 20_000;
    expect(s.registry.register(resumed)).toMatchObject({ status: 200, body: { resumed: true } });
    s.clock += 1;
    expect(s.registry.register({ ...resumed })).toMatchObject({ status: 200, body: { resumed: true } });
    const refused = registration('w10');
    expectTold(refused);
    expect(s.registry.register({ ...refused, pid: refused.pid + 1 }).status).toBe(409);
    const late = registration('w11');
    expectTold(late);
    s.clock += GRACE_MS;
    expect(s.registry.register(late)).toEqual({ status: 200, body: { accepted: true, bootId: 'boot-2' } });
    expect(calls).toEqual([`${resumed.key}@${String(T0 + 20_000)}`]);

    const throwing = registration('w12');
    s.registry.expectResume({ ...expectOf(throwing), onResumed: () => { throw new Error('callback failed'); } });
    expect(s.registry.register(throwing))
      .toEqual({ status: 200, body: { accepted: true, bootId: 'boot-2', resumed: true } });
  });
});
