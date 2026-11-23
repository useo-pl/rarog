/**
 * Terminal PTY — transport WS na całej drodze: prawdziwy `ws`, prawdziwy `http.Server`.
 *
 * Backend jest tu ATRAPĄ (fałszywe gniazdo herdr + fałszywy proces kontrolera), i to jest
 * świadome: po wycofaniu tmuxa nie ma już transportu, który dałoby się postawić bez
 * cudzego demona, a bramki, o które w tym pliku chodzi — autoryzacja upgrade'u i błędy
 * protokołu ramek — leżą w `ws.ts`, PRZED backendem. Żywy panel herdr sprawdza blok
 * `RAROG_TEST_HERDR` na końcu pliku (domyślnie pominięty: zakłada prawdziwy workspace).
 *
 * Sandbox: test woła `listen()`, więc w sandboksie Claude Code idzie poza nim (tak samo jak
 * reszta testów serwera).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDeviceStore, createPairing, deviceAuthorization } from '../src/auth/index.ts';
import type { DeviceStore } from '../src/auth/index.ts';
import { attachDeactivation } from '../src/device-effects.ts';
import { DEFAULT_CLAUDE_ENV_CLEAR, loadConfig } from '../src/config.ts';
import { createHerdrLaunchClient } from '../src/herdr/client.ts';
import { newRarogAgentName, parsePaneLabel, termPaneLabel } from '../src/herdr/provenance.ts';
import { createHerdrSocket } from '../src/herdr/socket.ts';
import { HerdrGoneError } from '../src/herdr/types.ts';
import type { Logger } from '../src/router.ts';
import { createTermBackend, createTermFeature } from '../src/term/index.ts';
import type { TermFeature } from '../src/term/index.ts';
import { RAROG_TERM_TOKEN } from '../src/term/herdr-backend.ts';
import { termIdFor } from '../src/term/lifecycle.ts';
import { TERM_OPEN_LOG, TERM_SPAWN_LOG } from '../src/term/registry.ts';
import { TERM_PASTE_INTERRUPTED_LOG, TERM_PASTE_OVER_CAP_LOG, TERM_REVOKE_TERMINATE_MS } from '../src/term/ws.ts';
import { say } from '@rarog/shared/sentences';
import { FakeController, FakeHerdr } from './fake-term-herdr.ts';
import { addTestDevice, createTestDevice } from './helpers/urzadzenie.ts';

/** Nagłówek `Cookie` w kształcie dawnego logowania tokenem: upgrade go nie czyta, więc niczego nie otwiera. */
const OLD_COOKIE = `rarog_auth=1.1700000000000.${'a'.repeat(64)}`;
const ORIGIN = 'http://localhost:8930';
const silentLogger: Logger = { info: () => {}, error: () => {} };

interface Harness {
  base: string;
  term: TermFeature;
  /** Nagłówek `Authorization` urządzenia testowego (`helpers/urzadzenie.ts`), sparowanego w magazynie terminala. */
  auth: string;
  cwd: string;
  /** Kontrolery w kolejności spawnu — każde nowe gniazdo dostaje własny (`respawnOnAttach`). */
  controllers: FakeController[];
  /** Linie `server.log` z tej instancji — do sprawdzania, że treść wklejki tam nie trafia. */
  logs: string[];
  close(): Promise<void>;
}

/**
 * @param herdr — atrapa gniazda herdr; test, który psuje jej odpowiedzi (odmowa założenia panelu),
 *   podaje własną i trzyma do niej referencję.
 * @param devices — magazyn kluczy złożony przez test; harness dopisuje do niego urządzenie testowe (`auth`).
 *   Bez niego magazyn z samym urządzeniem testowym.
 */
async function startHarness(
  env: NodeJS.ProcessEnv = {}, herdr: FakeHerdr = new FakeHerdr(), devices?: (dataDir: string) => DeviceStore,
): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-term-int-')));
  const config = loadConfig({
    RAROG_ORIGINS: ORIGIN,
    RAROG_PROJECT_ROOTS: root,
    RAROG_TERM: '1',
    RAROG_HERDR_LAUNCH: '1',
    RAROG_HERDR_BIN: '/usr/bin/true',
    RAROG_DATA_DIR: join(root, '.dane'),
    HOME: process.env['HOME'] ?? root,
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    ...env,
  });
  const controllers: FakeController[] = [];
  const logs: string[] = [];
  const logger: Logger = {
    info: (message) => { logs.push(message); },
    error: (message) => { logs.push(message); },
  };
  const own = devices?.(config.dataDir);
  const test = own === undefined
    ? createTestDevice(config.dataDir, { epoch: config.epoch })
    : { ...addTestDevice(own, { epoch: config.epoch }), store: own };
  const store = test.store;
  const term = await createTermFeature(config, logger, {
    herdrLaunchClient: () => herdr,
    herdrSpawn: () => {
      const controller = new FakeController();
      controllers.push(controller);
      return controller;
    },
    devices: store,
  });
  if (term === null) throw new Error('createTermFeature oddało null mimo włączonego RAROG_TERM');
  // Te same skutki odpięcia co w `index.ts` — tu bez SSE i APNs.
  attachDeactivation(store, {
    pairing: createPairing({ store, epoch: config.epoch }), hub: { closeOwner: () => 0 }, term, log: logger.info,
  });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => { term.handleUpgrade(req, socket, head); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    base: `ws://127.0.0.1:${String(port)}`,
    term,
    auth: test.authorization,
    cwd: root,
    controllers,
    logs,
    close: async () => {
      term.dispose();
      /*
       * Atrapa kontrolera nie wychodzi sama po `terminal.release`, więc backend dobija ją po
       * `HERDR_RELEASE_KILL_MS` (2 s), a jej `exit` zapisuje `term-herdr.json` (`mkdir -p`) — już po
       * sprzątnięciu katalogu, gdy plik testów trwa dłużej niż te 2 s. Koniec procesu TERAZ = zapis
       * przed `rm`, a timer nie ma już czego dobijać.
       */
      for (const controller of controllers) controller.kill();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Zbieracz ramek TEKSTOWYCH podpięty PRZED handshake'em.
 *
 * `hello` leci natychmiast po udanym attachu, więc listener dopięty po `open` bywa spóźniony
 * o tę jedną ramkę (przychodzi tym samym pakietem co odpowiedź upgrade'u).
 */
function textFrames(ws: WebSocket): { next(timeoutMs?: number): Promise<unknown> } {
  const seen: unknown[] = [];
  let wake: (() => void) | null = null;
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    seen.push(JSON.parse(data.toString('utf8')));
    wake?.();
  });
  return {
    async next(timeoutMs = 10_000): Promise<unknown> {
      const deadline = Date.now() + timeoutMs;
      while (seen.length === 0) {
        if (Date.now() > deadline) throw new Error('brak ramki tekstowej');
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 50);
        });
        wake = null;
      }
      return seen.shift();
    },
  };
}

function open(
  h: Harness, id: string, headers: Record<string, string>, query = '',
): WebSocket {
  return new WebSocket(`${h.base}/api/term/${id}${query}`, { headers });
}

const opened = (ws: WebSocket): Promise<void> => new Promise<void>((resolve, reject) => {
  ws.on('open', () => { resolve(); });
  ws.on('error', reject);
});

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Prompt gołej powłoki testu ({@link bareShell}) — w wyjściu panelu tylko jako prompt. */
const BARE_PROMPT = 'rarogP>';

/**
 * Zastępuje powłokę panelu gołym `zsh -f` z promptem {@link BARE_PROMPT}.
 *
 * Panel startuje z zsh UŻYTKOWNIKA i jego konfiguracją, więc prompt bywa dowolny (`❯` zamiast
 * `$`), a wejście wpisane, zanim powłoka
 * wstanie, potrafi przepaść (ta sama klasa wyścigu, którą po stronie launchera opisuje
 * `HERDR_LAUNCH_SHELL_WAIT_MS`). Stąd odczekanie startu, `exec` i własny prompt — echo
 * wpisanego przypisania promptu `'rarog''P> '` nie zawiera ciągu promptu, więc trafienie znaczy „prompt stoi".
 * Spacji za `>` w ciągu nie ma: ramka różnicowa nie musi rysować pustej komórki.
 */
async function bareShell(ws: WebSocket): Promise<void> {
  await sleep(3_000);
  const prompt = waitForOutput(ws, BARE_PROMPT, 30_000);
  ws.send(JSON.stringify({ t: 'in', d: ' exec /bin/zsh -f\r' }));
  await sleep(1_500);
  ws.send(JSON.stringify({ t: 'in', d: "PS1='rarog''P> '\r" }));
  await prompt;
  await sleep(300);
}

/** Wpisuje komendę do gołej powłoki ({@link bareShell}) i czeka na `needle` w wyjściu. */
async function runInShell(ws: WebSocket, command: string, needle: string): Promise<string> {
  const output = waitForOutput(ws, needle);
  ws.send(JSON.stringify({ t: 'in', d: `${command}\r` }));
  return output;
}

/** Czeka, aż strumień binarny z powłoki zawrze `needle` (albo padnie na limicie czasu). */
function waitForOutput(ws: WebSocket, needle: string, timeoutMs = 20_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => {
      reject(new Error(`brak „${needle}" w wyjściu powłoki po ${String(timeoutMs)} ms`));
    }, timeoutMs);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      seen += data.toString('utf8');
      if (!seen.includes(needle)) return;
      clearTimeout(timer);
      resolve(seen);
    });
  });
}

describe('terminal PTY — droga POST → WS jest jedna dla wszystkich klientów', () => {
  let h: Harness;

  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('otwarcie jest idempotentne po realpath', () => {
    const first = h.term.open(h.cwd);
    const second = h.term.open(`${h.cwd}/.`);
    expect(first.ok && second.ok && first.id === second.id).toBe(true);
  });

  /*
   * `hello` carries a CONSTANT value (there is one backend), and the app client does not read it.
   * The value the server sends is part of the WS contract, hence the assertion.
   */
  it('pierwszą ramką tekstową po attachu jest `hello: herdr`', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    const ws = open(h, open1.id, { Authorization: h.auth, Origin: ORIGIN });
    const frames = textFrames(ws);
    await opened(ws);
    expect(await frames.next()).toEqual({ t: 'hello', backend: 'herdr' });
    ws.close();
  });

  it('ramka binarna od klienta zamyka WS (błąd protokołu)', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    const ws = open(h, open1.id, { Authorization: h.auth, Origin: ORIGIN });
    await opened(ws);
    const closed = new Promise<number>((resolve) => { ws.on('close', (code) => { resolve(code); }); });
    ws.send(Buffer.from([0x01, 0x02]), { binary: true });
    expect(await closed).toBe(1002);
  });

  it('wejście ponad 8 kB zamyka WS — wklejkę dzieli klient', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    const ws = open(h, open1.id, { Authorization: h.auth, Origin: ORIGIN });
    await opened(ws);
    const closed = new Promise<number>((resolve) => { ws.on('close', (code) => { resolve(code); }); });
    ws.send(JSON.stringify({ t: 'in', d: 'a'.repeat(8 * 1024 + 1) }));
    expect(await closed).toBe(1002);
  });
});

describe('terminal PTY — autoryzacja upgrade jest fail-closed', () => {
  let h: Harness;

  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  /** Upgrade odrzucony = `socket.destroy()`, czyli błąd po stronie klienta `ws`. */
  const expectDenied = async (ws: WebSocket): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      ws.on('error', () => { resolve(); });
      ws.on('unexpected-response', () => { resolve(); });
      ws.on('open', () => { reject(new Error('upgrade przeszedł, a nie powinien')); });
    });
  };

  it('bez klucza urządzenia', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    await expectDenied(open(h, open1.id, { Origin: ORIGIN }));
  });

  it('z samym cookie dawnego logowania tokenem (bez klucza urządzenia)', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    await expectDenied(open(h, open1.id, { Cookie: OLD_COOKIE, Origin: ORIGIN }));
    expect(h.logs.some((line) => line.includes('upgrade refused (no device key)'))).toBe(true);
  });

  it('z Originem spoza allow-listy (SameSite nie broni WS)', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    await expectDenied(open(h, open1.id, { Authorization: h.auth, Origin: 'https://zly.example' }));
  });

  it('z id spoza rejestru', async () => {
    await expectDenied(open(h, 'ffffffffffffffff', { Authorization: h.auth, Origin: ORIGIN }));
  });

  it('z id w złym kształcie (nie hex)', async () => {
    await expectDenied(open(h, 'nie-jest-hexem--', { Authorization: h.auth, Origin: ORIGIN }));
  });
});

/*
 * Klucz urządzenia w upgrade'zie: ta sama bramka co REST (`authenticate`), zły klucz to odmowa (cookie obok
 * niczego nie zmienia), a odpięcie urządzenia ZAMYKA jego otwarty terminal ramką `err` i kodem 1008 — rejestr
 * pisze do powłoki bez ponownej kontroli, więc samo sprawdzenie przy upgrade'zie by go nie odcięło.
 */
describe('terminal PTY — klucz urządzenia w upgrade i zamknięcie przy odpięciu', () => {
  let h: Harness;
  let store: DeviceStore;
  let device: { id: string; header: string };

  beforeEach(async () => {
    h = await startHarness({}, new FakeHerdr(), (dataDir) => {
      store = createDeviceStore({ dataDir, epoch: '1' });
      const pairing = createPairing({ store, epoch: '1' });
      const paired = pairing.redeem({ code: pairing.issue('admin').code, label: 'iPad·Rarog' });
      if (!paired.ok) throw new Error('parowanie');
      device = { id: paired.record.id, header: deviceAuthorization(paired.record.id, paired.secret) };
      return store;
    });
  });
  // Zapisy magazynu (`lastSeenAt`, nagrobek) kończą się przed sprzątnięciem katalogu danych.
  afterEach(async () => { await store.flush(); await h.close(); });

  const expectDenied = async (ws: WebSocket): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      ws.on('error', () => { resolve(); });
      ws.on('unexpected-response', () => { resolve(); });
      ws.on('open', () => { reject(new Error('upgrade przeszedł, a nie powinien')); });
    });
  };

  it('upgrade z nagłówkiem `Authorization: Rarog-Device` przechodzi', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    const ws = open(h, open1.id, { Authorization: device.header, Origin: ORIGIN });
    const frames = textFrames(ws);
    await opened(ws);
    expect(await frames.next()).toEqual({ t: 'hello', backend: 'herdr' });
    ws.close();
  });

  it('zły klucz (także z cookie obok) i klucz odpiętego urządzenia — odmowa', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    await expectDenied(open(h, open1.id, {
      Authorization: deviceAuthorization(device.id, 'Z'.repeat(43)), Cookie: OLD_COOKIE, Origin: ORIGIN,
    }));
    store.revoke(device.id, 'admin');
    await expectDenied(open(h, open1.id, { Authorization: device.header, Origin: ORIGIN }));
    expect(h.logs.some((line) => line.includes('upgrade refused (device-unknown)'))).toBe(true);
    expect(h.logs.some((line) => line.includes('upgrade refused (device-revoked)'))).toBe(true);
  });

  /** Zamaskowana ramka tekstowa klienta WebSocket — klient składany ręcznie, który ignoruje zamknięcie. */
  const maskedText = (text: string): Buffer => {
    const payload = Buffer.from(text, 'utf8');
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const header = payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([header, mask, Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0)))]);
  };

  /** Upgrade bez biblioteki `ws`: surowe gniazdo, które nie odpowie na ramkę zamknięcia nigdy. */
  const rawUpgrade = (id: string, headers: Record<string, string>): Promise<Socket> => new Promise((resolve, reject) => {
    const url = new URL(`${h.base.replace('ws:', 'http:')}/api/term/${id}`);
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers,
      },
    });
    req.on('upgrade', (_res, socket) => { resolve(socket); });
    req.on('response', (res) => { reject(new Error(`brak upgrade'u: ${String(res.statusCode)}`)); });
    req.on('error', reject);
    req.end();
  });

  it('klient ignorujący zamknięcie: po odpięciu żadna ramka nie dochodzi do powłoki, gniazdo pada po terminie', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    const before = h.controllers.length;
    const socket = await rawUpgrade(open1.id, { Authorization: device.header, Origin: ORIGIN });
    socket.on('error', () => {});
    await until(() => h.controllers.length > before);
    const inputs = (): string[] => h.controllers.flatMap((controller) => controller.inputs());
    socket.write(maskedText(JSON.stringify({ t: 'in', d: 'przed' })));
    await until(() => inputs().includes('przed'));
    // Czytamy (ramki serwera do kosza), ale na zamknięcie nie odpowiadamy; koniec = serwer zerwał gniazdo.
    const closedAt = new Promise<number>((resolve) => {
      socket.once('end', () => { resolve(Date.now()); });
      socket.once('close', () => { resolve(Date.now()); });
    });
    socket.resume();
    const revokedAt = Date.now();
    store.revoke(device.id, 'admin');
    // Klient nie odpowiada na zamknięcie i pisze dalej: klawisz, cała wklejka, a po chwili znowu klawisz.
    socket.write(maskedText(JSON.stringify({ t: 'in', d: 'po-odpieciu' })));
    socket.write(maskedText(JSON.stringify({ t: 'pa', d: 'wklejka', e: true })));
    await sleep(300);
    socket.write(maskedText(JSON.stringify({ t: 'in', d: 'jeszcze' })));
    const closed = await closedAt;
    // Bez `terminate()` serwer czekałby na odpowiedź do 30 s (`closeTimeout` biblioteki `ws`).
    expect(closed - revokedAt).toBeLessThan(TERM_REVOKE_TERMINATE_MS + 1_500);
    await sleep(100);
    expect(inputs()).toEqual(['przed']);
    socket.destroy();
  }, 15_000);

  it('odpięcie zamyka otwarty terminal urządzenia (ramka `err`, 1008); gniazdo innego urządzenia żyje dalej', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    const viaDevice = open(h, open1.id, { Authorization: device.header, Origin: ORIGIN });
    const deviceFrames = textFrames(viaDevice);
    await opened(viaDevice);
    expect(await deviceFrames.next()).toMatchObject({ t: 'hello' });
    const viaOther = open(h, open1.id, { Authorization: h.auth, Origin: ORIGIN });
    await opened(viaOther);
    const closed = new Promise<number>((resolve) => { viaDevice.on('close', (code) => { resolve(code); }); });
    store.revoke(device.id, 'admin');
    expect(await deviceFrames.next()).toEqual({
      t: 'err', msg: say('rest.device-revoked').text, msgRef: { code: 'rest.device-revoked' },
    });
    expect(await closed).toBe(1008);
    expect(viaOther.readyState).toBe(WebSocket.OPEN);
    expect(h.logs.some((line) => line.includes(`${device.id} revoked (admin) — streams: 0, consoles: 1`))).toBe(true);
    viaOther.close();
  });
});

/*
 * Gniazdo BEZ `POST` (`?direct=1`). Apka, która zna id, łączy
 * się od razu; tam, gdzie wyjście zna tylko `POST` (`failed`, uchwyt do przeliczenia, lazygit,
 * brak wpisu), upgrade odpada, a apka robi `POST` i zwykłe gniazdo. Gniazdo BEZ znacznika (także
 * starsza apka) idzie dokładnie dzisiejszą drogą: wchodzi i dostaje ramkę, która zatrzymuje
 * klienta. Gdyby odmowa obejmowała wszystkie gniazda, uchwyt psuty asynchronicznie po
 * odpowiedzi `POST` kręciłby `POST` w kółko.
 */
describe('terminal PTY — gniazdo bez `POST` (`?direct=1`)', () => {
  let h: Harness;
  let herdr: FakeHerdr;

  beforeEach(async () => {
    herdr = new FakeHerdr();
    h = await startHarness({}, herdr);
  });
  afterEach(async () => { await h.close(); });

  const headers = (): Record<string, string> => ({ Authorization: h.auth, Origin: ORIGIN });

  /** Upgrade odrzucony = `socket.destroy()`, czyli błąd po stronie klienta `ws`. */
  const expectDenied = async (ws: WebSocket): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      ws.on('error', () => { resolve(); });
      ws.on('unexpected-response', () => { resolve(); });
      ws.on('open', () => { reject(new Error('upgrade przeszedł, a nie powinien')); });
    });
  };

  const refusedFor = (reason: string): boolean =>
    h.logs.some((line) => line === `term: upgrade refused (direct: ${reason})`);

  it('zdrowy wpis: `direct=1` wchodzi jak gniazdo zwykłe i dostaje `hello`', async () => {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    const ws = open(h, open1.id, headers(), '?fresh=1&direct=1&c=100&r=30');
    const frames = textFrames(ws);
    await opened(ws);
    expect(await frames.next()).toEqual({ t: 'hello', backend: 'herdr' });
    await until(() => h.controllers.length === 1);
    ws.close();
  });

  it('id spoza rejestru: `direct=1` odpada z powodem w logu', async () => {
    await expectDenied(open(h, 'ffffffffffffffff', headers(), '?fresh=1&direct=1'));
    expect(refusedFor('id not in the registry')).toBe(true);
  });

  it('wpis `failed`: `direct=1` odpada, gniazdo bez znacznika dostaje `err`, `POST` otwiera drogę',
    async () => {
      const open1 = h.term.open(h.cwd);
      if (!open1.ok) throw new Error('open nieudany');
      const first = open(h, open1.id, headers(), '?fresh=1');
      const firstFrames = textFrames(first);
      await opened(first);
      expect(await firstFrames.next()).toEqual({ t: 'hello', backend: 'herdr' });
      await until(() => h.controllers.length === 1);
      // Obcy kontroler przejmuje panel — rejestr kładzie wpis w `failed` (jedno wyjście: `POST`).
      h.controllers[0]?.stdout.write(
        `${JSON.stringify({ type: 'terminal.closed', reason: 'taken over by another client' })}\n`,
      );
      expect(await firstFrames.next()).toMatchObject({ t: 'err' });
      first.close();

      await expectDenied(open(h, open1.id, headers(), '?fresh=1&direct=1'));
      expect(refusedFor('entry is failed')).toBe(true);

      // Bez znacznika: dzisiejsza droga — upgrade przechodzi, a odmowa jedzie ramką `err`.
      const plain = open(h, open1.id, headers(), '?fresh=1');
      const plainFrames = textFrames(plain);
      const plainClosed = new Promise<number>((resolve) => { plain.on('close', (code) => { resolve(code); }); });
      await opened(plain);
      expect(await plainFrames.next()).toMatchObject({ t: 'err' });
      expect(await plainClosed).toBe(1008);
      expect(h.controllers).toHaveLength(1);

      // `POST` zdejmuje `failed` — następne gniazdo bez `POST` już wchodzi.
      expect(h.term.open(h.cwd).ok).toBe(true);
      const direct = open(h, open1.id, headers(), '?fresh=1&direct=1');
      const directFrames = textFrames(direct);
      await opened(direct);
      expect(await directFrames.next()).toEqual({ t: 'hello', backend: 'herdr' });
      await until(() => h.controllers.length === 2);
      direct.close();
    });

  it('znacznik inny niż `1` (`direct=0`, `direct=true`, pusty) to gniazdo zwykłe: `failed` daje `err` i 1008',
    async () => {
      const open1 = h.term.open(h.cwd);
      if (!open1.ok) throw new Error('open nieudany');
      const first = open(h, open1.id, headers(), '?fresh=1');
      const firstFrames = textFrames(first);
      await opened(first);
      expect(await firstFrames.next()).toEqual({ t: 'hello', backend: 'herdr' });
      await until(() => h.controllers.length === 1);
      h.controllers[0]?.stdout.write(
        `${JSON.stringify({ type: 'terminal.closed', reason: 'taken over by another client' })}\n`,
      );
      expect(await firstFrames.next()).toMatchObject({ t: 'err' });
      first.close();

      for (const query of ['?fresh=1&direct=0', '?fresh=1&direct=true', '?fresh=1&direct=']) {
        const ws = open(h, open1.id, headers(), query);
        const frames = textFrames(ws);
        const closed = new Promise<number>((resolve) => { ws.on('close', (code) => { resolve(code); }); });
        await opened(ws);
        expect(await frames.next(), query).toMatchObject({ t: 'err' });
        expect(await closed, query).toBe(1008);
      }
      expect(h.logs.some((line) => line.includes('upgrade refused (direct:'))).toBe(false);
    });

  it('uchwyt zepsuty między `POST` a upgrade\'em: bez znacznika ramka `exit` i cisza, `direct=1` odpada',
    async () => {
      const createWorkspace = herdr.createWorkspace.bind(herdr);
      const createTab = herdr.createTab.bind(herdr);
      herdr.createWorkspace = () => Promise.reject(new Error('herdr: workspace.create odrzucone'));
      herdr.createTab = () => Promise.reject(new Error('herdr: tab.create odrzucone'));

      // `POST` odpowiada przed wynikiem `ensureSession`; strażnik uchwytu zatruwa go chwilę później.
      const open1 = h.term.open(h.cwd);
      if (!open1.ok) throw new Error('open nieudany');
      await until(() => h.logs.some((line) => line.includes(`handle ${open1.id} failed`)));

      await expectDenied(open(h, open1.id, headers(), '?fresh=1&direct=1'));
      expect(refusedFor('handle needs recomputing')).toBe(true);

      // Bez znacznika gniazdo wchodzi, a pad spawnu zatrzymuje klienta ramką — bez pętli.
      const plain = open(h, open1.id, headers(), '?fresh=1');
      const plainFrames = textFrames(plain);
      await opened(plain);
      expect(await plainFrames.next()).toEqual({ t: 'hello', backend: 'herdr' });
      expect(await plainFrames.next()).toEqual({ t: 'exit' });
      await expect(plainFrames.next(300)).rejects.toThrow('brak ramki tekstowej');
      expect(h.controllers).toHaveLength(0);
      expect(h.logs.filter((line) => line.includes(`${TERM_SPAWN_LOG} ${open1.id} failed`))).toHaveLength(1);
      plain.close();

      // Wyjście to `POST`: liczy uchwyt od nowa, a gniazdo bez `POST` po nim wchodzi.
      herdr.createWorkspace = createWorkspace;
      herdr.createTab = createTab;
      expect(h.term.open(h.cwd).ok).toBe(true);
      expect(h.logs.some((line) => line.includes(`${TERM_OPEN_LOG} ${open1.id} — handle recomputed`))).toBe(true);
      const direct = open(h, open1.id, headers(), '?fresh=1&direct=1');
      const directFrames = textFrames(direct);
      await opened(direct);
      expect(await directFrames.next()).toEqual({ t: 'hello', backend: 'herdr' });
      await until(() => h.controllers.length === 1);
      direct.close();
    });

  it('rola `lazygit`: `direct=1` odpada — zastany panel sprawdza tylko `POST`', async () => {
    const lazygit = h.term.open(h.cwd, 1, 'lazygit');
    if (!lazygit.ok) throw new Error('open nieudany');
    await expectDenied(open(h, lazygit.id, headers(), '?fresh=1&direct=1'));
    expect(refusedFor('lazygit goes through POST')).toBe(true);
    expect(h.controllers).toHaveLength(0);
  });
});

/** Ramka wklejki jako tekst do `WebSocket.send`. */
const pa = (d: string, e: boolean): string => JSON.stringify({ t: 'pa', d, e });

/** Czeka na warunek (wejście idzie do herdr asynchronicznie, przez obietnicę strumienia). */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('warunek nie spełniony w czasie');
    await sleep(20);
  }
}

/*
 * Wklejka jedną ramką. herdr 0.9.3 traktuje `terminal.input` jako wklejkę tylko wtedy,
 * gdy jego treść to DOKŁADNIE jedno `ESC[200~…ESC[201~` — dlatego asercje patrzą na to, co
 * backend wpisał na stdin kontrolera, a nie na to, co przyszło gniazdem.
 */
describe('terminal PTY — wklejka jedną ramką `pa`', () => {
  let h: Harness;

  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  const inputs = (): string[] => h.controllers.flatMap((controller) => controller.inputs());

  /** Gniazdo po attachu — kontroler już stoi, więc wejście ma dokąd iść. */
  async function connect(): Promise<WebSocket> {
    const open1 = h.term.open(h.cwd);
    if (!open1.ok) throw new Error('open nieudany');
    const before = h.controllers.length;
    const ws = open(h, open1.id, { Authorization: h.auth, Origin: ORIGIN });
    await opened(ws);
    await until(() => h.controllers.length > before);
    return ws;
  }

  it('kawałki `pa` dochodzą do herdr JEDNYM `terminal.input`, owinięte, z Enterem jako CR', async () => {
    const ws = await connect();
    ws.send(pa('echo raz\n', false));
    ws.send(pa('echo dwa\r\n', false));
    ws.send(pa('echo trzy', true));
    await until(() => inputs().length > 0);
    await sleep(100);
    expect(inputs()).toEqual(['\u001b[200~echo raz\recho dwa\recho trzy\u001b[201~']);
    ws.close();
  });

  /*
   * Granica bezpieczeństwa wklejki: znacznik końca w treści zamknąłby wklejkę w zsh przed czasem,
   * a reszta pojechałaby jak klawisze — z `\r` na końcu, czyli wykonana.
   */
  it('znacznik końca w schowku NIE zamyka wklejki — `ESC[201~rm …\\r` zostaje treścią', async () => {
    const ws = await connect();
    ws.send(pa('ok\u001b[201~rm -rf ~/x\r', true));
    await until(() => inputs().length > 0);
    const [input] = inputs();
    expect(input).toBe('\u001b[200~okrm -rf ~/x\r\u001b[201~');
    expect(input?.indexOf('\u001b[201~')).toBe((input?.length ?? 0) - '\u001b[201~'.length);
    ws.close();
  });

  it('zerwane gniazdo w środku wklejki: bufor do kosza, nowe gniazdo nie dosyła połowy', async () => {
    const first = await connect();
    first.send(pa('echo POLOWA\n', false));
    const closed = new Promise<void>((resolve) => { first.on('close', () => { resolve(); }); });
    first.close();
    await closed;
    const second = await connect();
    second.send(pa('ogon', true));
    await until(() => inputs().length > 0);
    await sleep(100);
    expect(inputs()).toEqual(['\u001b[200~ogon\u001b[201~']);
    second.close();
  });

  it('`in` w środku wklejki: klawisz dochodzi, wklejka i jej reszta idą do kosza', async () => {
    const ws = await connect();
    ws.send(pa('echo raz\n', false));
    ws.send(JSON.stringify({ t: 'in', d: 'x' }));
    ws.send(pa('echo dwa\n', false));
    ws.send(pa('echo trzy', true));
    ws.send(pa('cała', true));
    await until(() => inputs().length >= 2);
    await sleep(100);
    expect(inputs()).toEqual(['x', '\u001b[200~cała\u001b[201~']);
    expect(h.logs.some((line) => line.includes(TERM_PASTE_INTERRUPTED_LOG))).toBe(true);
    ws.close();
  });

  /*
   * Odmowa sufitu NIE jest ramką `err`: ta zatrzymuje automat reconnectu klienta, a wklejka
   * za duża to nie awaria terminala. Gniazdo żyje, następna wklejka przechodzi, log mówi
   * „ile", nigdy „co".
   */
  it('wklejka ponad sufit: nic do herdr, gniazdo żyje bez `err`, log bez treści', async () => {
    const ws = await connect();
    // Zbieracz po attachu — `hello` już przeszło, więc KAŻDA ramka tekstowa tu byłaby odmową.
    const texts = textFrames(ws);
    const piece = `TAJNE${'A'.repeat(7_995)}`;
    for (let i = 0; i < 66; i += 1) ws.send(pa(piece, i === 65));
    ws.send(pa('po', true));
    await until(() => inputs().length > 0);
    await sleep(100);
    expect(inputs()).toEqual(['\u001b[200~po\u001b[201~']);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await expect(texts.next(300)).rejects.toThrow('brak ramki tekstowej');
    expect(h.logs.some((line) => line.includes(TERM_PASTE_OVER_CAP_LOG))).toBe(true);
    expect(h.logs.some((line) => line.includes('TAJNE'))).toBe(false);
    ws.close();
  });

  it('kawałek `pa` ponad 8 kB zamyka gniazdo kodem 1002 — tak jak `in`', async () => {
    const ws = await connect();
    const closed = new Promise<number>((resolve) => { ws.on('close', (code) => { resolve(code); }); });
    ws.send(pa('a'.repeat(8 * 1024 + 1), true));
    expect(await closed).toBe(1002);
    expect(inputs()).toEqual([]);
  });
});

/*
 * Killswitche: `pa` nie ma własnej bramki i mieć jej nie powinna — jedzie TYM SAMYM
 * gniazdem co `in`, a gniazdo istnieje tylko dla wpisu rejestru. `RAROG_HERDR_SEND=0` nie
 * wpuszcza wpisu (`registry.open` → `herdr-send-off`, także przy adopcji), więc upgrade odpada;
 * `RAROG_TERM=0` nie składa ficzeru wcale.
 */
describe('terminal PTY — killswitche zamykają `pa` tą samą drogą co `in`', () => {
  it('`RAROG_HERDR_SEND=0`: brak wpisu, upgrade odpada, do herdr nie idzie nic', async () => {
    const h = await startHarness({ RAROG_HERDR_SEND: '0' });
    try {
      const refused = h.term.open(h.cwd);
      expect(refused).toMatchObject({ ok: false, error: 'herdr-send-off' });
      const ws = open(h, termIdFor(h.cwd), { Authorization: h.auth, Origin: ORIGIN });
      await new Promise<void>((resolve, reject) => {
        ws.on('error', () => { resolve(); });
        ws.on('unexpected-response', () => { resolve(); });
        ws.on('open', () => { reject(new Error('upgrade przeszedł przy RAROG_HERDR_SEND=0')); });
      });
      expect(h.controllers).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('`RAROG_TERM=0`: ficzeru nie ma — nie ma gniazda, którym `pa` mogłaby przyjść', async () => {
    const config = loadConfig({
      RAROG_ORIGINS: ORIGIN, RAROG_TERM: '0', RAROG_HERDR_LAUNCH: '1',
    });
    expect(await createTermFeature(config, silentLogger)).toBeNull();
  });
});

/*
 * ŻYWY herdr — blok domyślnie POMIJANY (`RAROG_TEST_HERDR=1`, żeby go włączyć).
 *
 * Nie chodzi o brak binarki (tę wykryłby `existsSync`), tylko o SKUTKI: test zakłada
 * prawdziwy workspace w terminalu użytkownika i zamyka go na końcu. Ani CI, ani zwykłe
 * `pnpm test` nie mają prawa tego robić bez jawnej zgody — dlatego bramką jest zmienna
 * środowiskowa, a nie obecność herdr.
 *
 * Sprzątanie: `term.close()` woła `pane.close` na panelu z tokenem `rarog-term`, więc
 * zamyka WYŁĄCZNIE to, co ten test założył (workspace zostaje pusty, ale nie osierocony —
 * `pane.close` ostatniego panelu zamyka tab po stronie herdr).
 *
 * Uwaga: start ficzeru (i drugi backend w teście odzyskiwania) puszcza `reconcile` po
 * CAŁYM herdr użytkownika, nie tylko po panelach testu — tak jak produkcja. Panele terminala
 * Raroga w starym formacie (token bez etykiety) dostają wtedy etykietę `rarog-term <id>`, a sieroty
 * z etykietą — token. Niczego nie zamyka i nie zakłada (cofnięcie etykiety:
 * `herdr pane rename <pane> --clear`).
 */
const HERDR_LIVE = process.env['RAROG_TEST_HERDR'] === '1';
/*
 * Osobny serwer herdr zamiast herdr użytkownika: `RAROG_HERDR_BIN` i `RAROG_HERDR_SOCKET` z env procesu testu
 * przechodzą do konfiguracji bloku, więc blok da się puścić w `env -i` z innym HOME przeciw serwerowi herdr, który
 * stoi w tym HOME. Bez tych zmiennych blok idzie na herdr z HOME procesu testu.
 */
const LIVE_HERDR_TARGET: { RAROG_HERDR_BIN?: string; RAROG_HERDR_SOCKET?: string } = Object.fromEntries(
  (['RAROG_HERDR_BIN', 'RAROG_HERDR_SOCKET'] as const)
    .filter((name) => (process.env[name] ?? '') !== '')
    .map((name) => [name, process.env[name]]),
);

describe.skipIf(!HERDR_LIVE)('terminal PTY — backend herdr na ŻYWYM panelu (only with RAROG_TEST_HERDR=1)', () => {
  let h: Harness;
  let disposeSocket: () => void = () => {};
  /** Ten sam klient gniazda, którego używa backend — do sprawdzenia tokenu panelu. */
  let launchClient: ReturnType<typeof createHerdrLaunchClient>;
  /** Terminale założone przez test — sprzątane w `afterEach` także po porażce. */
  let liveIds: string[] = [];
  /** Konfiguracja bieżącego testu — drugi backend składa się z tej samej. */
  let liveConfig: ReturnType<typeof loadConfig>;

  beforeEach(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rarog-term-herdr-')));
    const config = loadConfig({
      RAROG_ORIGINS: ORIGIN,
      RAROG_PROJECT_ROOTS: root,
      RAROG_TERM: '1',
      // Zakładanie panelu to władza „launch", stemplowanie i zamykanie — „send".
      RAROG_HERDR_LAUNCH: '1',
      RAROG_HERDR_SEND: '1',
      RAROG_DATA_DIR: join(root, '.dane'),
      HOME: process.env['HOME'] ?? root,
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      SHELL: '/bin/sh',
      TMPDIR: process.env['TMPDIR'] ?? '/tmp',
      ...LIVE_HERDR_TARGET,
    });
    // Jawny plik herdr i gniazdo (osobny serwer herdr) mają wygrać z domyślnymi z HOME.
    if (LIVE_HERDR_TARGET.RAROG_HERDR_SOCKET !== undefined) {
      expect(config.herdrSocket).toBe(LIVE_HERDR_TARGET.RAROG_HERDR_SOCKET);
    }
    if (LIVE_HERDR_TARGET.RAROG_HERDR_BIN !== undefined) {
      expect(config.herdrBin).toBe(LIVE_HERDR_TARGET.RAROG_HERDR_BIN);
    }
    liveConfig = config;
    const socket = createHerdrSocket({
      socketPath: config.herdrSocket, sendEnabled: config.herdrSend,
    });
    disposeSocket = () => { socket.dispose(); };
    launchClient = createHerdrLaunchClient(socket);
    const device = createTestDevice(config.dataDir, { epoch: config.epoch });
    const term = await createTermFeature(config, silentLogger, {
      herdrLaunchClient: () => launchClient, devices: device.store,
    });
    if (term === null) throw new Error('createTermFeature oddało null przy żywym herdr');
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socketRaw, head) => { term.handleUpgrade(req, socketRaw, head); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;
    h = {
      base: `ws://127.0.0.1:${String(port)}`,
      term,
      auth: device.authorization,
      cwd: root,
      // Żywy herdr: kontrolery są prawdziwymi procesami, a logi idą do ciszy.
      controllers: [],
      logs: [],
      close: async () => {
        term.dispose();
        await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
        await rm(root, { recursive: true, force: true });
      },
    };
  });

  afterEach(async () => {
    /*
     * Panel testu NIE ma zostać w herdr użytkownika, także gdy test padł w połowie. `close` zwraca `false` dla terminala,
     * który test zamknął sam — czekamy wtedy tylko, aż panel zniknie z listy.
     */
    for (const id of liveIds) {
      h.term.close(id);
      const deadline = Date.now() + 5_000;
      while (
        Date.now() < deadline
        && (await launchClient.listPanes()).some((pane) => pane.tokens[RAROG_TERM_TOKEN] === id)
      ) await sleep(100);
    }
    liveIds = [];
    await h.close();
    disposeSocket();
  });

  it('zakłada panel, mówi `hello: herdr`, przepuszcza wejście i przewijanie', async () => {
    const opened = h.term.open(h.cwd);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    liveIds.push(opened.id);

    const ws = open(h, opened.id, { Authorization: h.auth, Origin: ORIGIN });
    const frames = textFrames(ws);
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    expect(await frames.next()).toEqual({ t: 'hello', backend: 'herdr' });

    ws.send(JSON.stringify({ t: 'rs', c: 80, r: 24 }));
    await bareShell(ws);
    expect(await runInShell(ws, 'echo rarog""OK', 'rarogOK')).toContain('rarogOK');
    // Przewinięcie w historię panelu: herdr ma je przyjąć bez zerwania strumienia —
    // także z komórką pod palcem (`column`/`row` w `terminal.scroll`).
    ws.send(JSON.stringify({ t: 'sc', d: -5 }));
    ws.send(JSON.stringify({ t: 'sc', d: 5, c: 10, r: 5 }));
    expect(await runInShell(ws, 'echo po""Scrollu', 'poScrollu')).toContain('poScrollu');
    ws.close();

    // Panel NOSI token terminala — bez niego nie dałoby się go ani adoptować, ani zamknąć.
    const panes = await launchClient.listPanes();
    expect(panes.some((pane) => pane.tokens[RAROG_TERM_TOKEN] === opened.id)).toBe(true);

    // Sprzątanie JEST asercją: panel testowy ma dać się zamknąć z Raroga i zniknąć z listy.
    expect(h.term.close(opened.id)).toBe(true);
  }, 120_000);

  /*
   * Wklejka na ŻYWYM herdr — ten test należy do procedury po `herdr update` (`docs/security-model.md`,
   * reguła 9): cała wklejka jedzie przez to, że herdr rozpoznaje JEDNO `terminal.input`
   * z treścią `ESC[200~…ESC[201~` i koduje je od nowa według trybu programu w panelu. Zmiana
   * tego zachowania po aktualizacji przywróciłaby wklejkę surową (linie jako Entery) albo
   * wstawiała `^[[200~` programom bez 2004 — i nic poza tym testem by tego nie zauważyło.
   *
   * Powłoka panelu to zsh użytkownika z jego konfiguracją (prompt bywa dowolny), więc test
   * zastępuje ją gołym `zsh -f` z własnym promptem. Bracketed paste zsh ≥ 5.1 włącza sam,
   * bez plików rc (`zle_bracketed_paste`).
   */
  it('wklejka `pa`: zsh trzyma linie w buforze, `cat -v` bez 2004 dostaje sam tekst', async () => {
    const opened = h.term.open(h.cwd);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    liveIds.push(opened.id);

    const ws = open(h, opened.id, { Authorization: h.auth, Origin: ORIGIN });
    const frames = textFrames(ws);
    let seen = '';
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) seen += data.toString('utf8');
    });
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    expect(await frames.next()).toEqual({ t: 'hello', backend: 'herdr' });
    ws.send(JSON.stringify({ t: 'rs', c: 100, r: 30 }));
    const waitSeen = async (needle: string, timeoutMs = 20_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!seen.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`brak „${needle}" w wyjściu panelu`);
        await sleep(50);
      }
    };
    const type = (text: string): void => { ws.send(JSON.stringify({ t: 'in', d: text })); };

    await bareShell(ws);

    // zsh na prompcie (2004 włączone): dwie linie zostają w buforze, żadna się nie wykonuje.
    seen = '';
    ws.send(pa('echo rarog""A1\necho rarog""A2\n', true));
    await waitSeen('rarog""A2');
    await sleep(1_500);
    expect(seen).not.toContain('rarogA1');
    expect(seen).not.toContain('rarogA2');
    type('\u0003');
    await sleep(500);
    type('echo rarog""Z\r');
    await waitSeen('rarogZ');
    expect(seen).not.toContain('rarogA1');

    // `cat -v` (zsh wyłącza 2004 przed uruchomieniem komendy): sam tekst, bez `^[[200~`.
    type('cat -v\r');
    await sleep(1_500);
    seen = '';
    ws.send(pa('kotC1\nkotC2\n', true));
    await waitSeen('kotC2');
    await sleep(1_000);
    expect(seen.split('kotC1').length - 1).toBeGreaterThanOrEqual(2);
    expect(seen).not.toContain('[200~');
    expect(seen).not.toContain('[201~');
    expect(seen).not.toContain('^[');
    type('\u0004');
    await waitSeen(BARE_PROMPT);
    ws.close();

    expect(h.term.close(opened.id)).toBe(true);
  }, 120_000);

  /*
   * Pomiar na herdr 0.9.3 (CLI 3.1.6): etykieta PANELU
   * (`pane.rename`) jest dowodem pochodzenia tylko wtedy, gdy herdr NIE rusza jej przy wykryciu
   * agenta, przy jego wyjściu ani przy kolejnym uruchomieniu w tej samej powłoce. Ten test
   * należy do procedury po `herdr update` razem z testem wklejki — gdyby herdr zaczął czyścić etykietę
   * przy zmianie agenta, panele Raroga przestałyby być rozpoznawalne po restarcie herdr.
   *
   * Wyłącznie klient Raroga i metody z allow-listy: etykieta przez `pane.rename`, pierwszy agent
   * przez `agent.start` z nazwą Raroga (droga launchera), drugi wpisany ręcznie w powłokę,
   * obecność agenta przez `agent.get`, ekran przez `pane.read`. `claude` startuje w świeżym
   * katalogu tymczasowym, więc staje na dialogu zaufania — wyjście to Enter na podświetlonym
   * „No, exit", sprawdzonym na ekranie PRZED naciśnięciem (inny domyślny wybór = porażka testu,
   * a nie zaufanie do katalogu). Do modelu nie idzie ani jedno zapytanie.
   *
   * Powłoka terminala dziedziczy env serwera herdr, a terminal NICZEGO nie zeruje (zerowanie dotyczy
   * paneli launchera). Odziedziczony klucz API dałby dialog „Do you want to use this API key?"
   * zamiast „No, exit" i timeout niezwiązany z etykietą — dlatego przed pierwszym `claude` powłoka
   * dostaje `unset` tej samej listy, którą zeruje launcher (`DEFAULT_CLAUDE_ENV_CLEAR`).
   */
  it('etykieta panelu przeżywa wykrycie agenta, wyjście i kolejne uruchomienie', async () => {
    const opened = h.term.open(h.cwd);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    liveIds.push(opened.id);

    const ws = open(h, opened.id, { Authorization: h.auth, Origin: ORIGIN });
    const frames = textFrames(ws);
    await new Promise<void>((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    expect(await frames.next()).toEqual({ t: 'hello', backend: 'herdr' });
    ws.send(JSON.stringify({ t: 'rs', c: 100, r: 30 }));
    await bareShell(ws);
    // Marker z pustym łańcuchem w środku: echo wpisanej komendy go nie zawiera, więc trafienie
    // znaczy „`unset` WYKONANE", a nie „wpisane".
    await runInShell(ws, `unset ${DEFAULT_CLAUDE_ENV_CLEAR.join(' ')}; echo rarog""UNSET`, 'rarogUNSET');

    const pane = (await launchClient.listPanes())
      .find((candidate) => candidate.tokens[RAROG_TERM_TOKEN] === opened.id);
    if (pane === undefined) throw new Error('panel terminala bez tokenu `rarog-term`');
    const label = termPaneLabel(opened.id);
    await launchClient.renamePane(pane.paneId, label);
    const labelNow = async (): Promise<string | null> => (await launchClient.listPanes())
      .find((candidate) => candidate.paneId === pane.paneId)?.label ?? null;
    expect(await labelNow()).toBe(label);

    const agentPresent = async (): Promise<boolean> => {
      try {
        await launchClient.probeAgent(pane.paneId);
        return true;
      } catch (err) {
        if (err instanceof HerdrGoneError) return false;
        throw err;
      }
    };
    const until = async (what: string, check: () => Promise<boolean>, ms = 40_000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`nie doczekałem się: ${what}`);
        await sleep(250);
      }
    };
    const EXIT_HIGHLIGHTED = '❯ No, exit';
    const dialogs = async (): Promise<number> => (
      await launchClient.readPaneHistory(pane.paneId, 400)
    ).text.split(EXIT_HIGHLIGHTED).length - 1;

    const typeClaude = async (): Promise<void> => {
      ws.send(JSON.stringify({ t: 'in', d: 'claude\r' }));
    };
    const rounds: { name: string; start: () => Promise<void> }[] = [
      {
        name: '`agent.start` z nazwą Raroga',
        start: async () => {
          await launchClient.startAgent({
            name: newRarogAgentName(), kind: 'claude', paneId: pane.paneId, args: [],
          });
        },
      },
      { name: 'ręczny `claude` po wyjściu', start: typeClaude },
      { name: 'kolejny ręczny `claude`', start: typeClaude },
    ];
    for (const round of rounds) {
      const before = await dialogs();
      await round.start();
      await until(`agent w panelu (${round.name})`, agentPresent);
      expect(await labelNow(), `${round.name}: po wykryciu agenta`).toBe(label);
      await until(
        `dialog z podświetlonym „No, exit" (${round.name})`,
        async () => (await dialogs()) > before,
      );
      /*
       * Enter dopiero przy `blocked` z herdr: Claude Code 2.1.296 rysuje dialog zaufania, zanim
       * zacznie czytać klawisze, i Enter wysłany zaraz po narysowaniu przepada — także przez
       * `pane.send_keys`, czyli to nie kontroler terminala (zmierzone na herdr 0.9.4:
       * 3 z 6 przebiegów czerwone; `blocked` przychodzi 3–4 s po starcie, gdy dialog już czeka).
       */
      await until(
        `stan \`blocked\` (${round.name})`,
        async () => (await launchClient.probeAgent(pane.paneId)).status === 'blocked',
      );
      ws.send(JSON.stringify({ t: 'in', d: '\r' }));
      await until(`wyjście agenta (${round.name})`, async () => !(await agentPresent()));
      expect(await labelNow(), `${round.name}: po wyjściu agenta`).toBe(label);
    }
    ws.close();

    expect(h.term.close(opened.id)).toBe(true);
  }, 240_000);

  /*
   * Odzyskanie tokenu na ŻYWYM herdr (herdr 0.9.3): restart serwera herdr kasuje
   * tokeny paneli (RAM demona), a etykieta panelu zostaje (snapshot). Restartu herdr test nie
   * robi — zabiłby powłoki użytkownika — więc symuluje jego skutek dla JEDNEGO panelu: token
   * zdejmuje komenda z runbooka „zapomnij" (`--clear-token`), etykieta zostaje. Drugi backend
   * złożony z tej samej konfiguracji to Rarog po restarcie: jego przebieg odzyskiwania ma
   * przywrócić token z etykiety, a `ensureSession` oddać TEN panel, bez drugiego taba.
   *
   * Druga połowa sprawdza CAŁY runbook „zapomnij panel" (`docs/security-model.md`): zdjęte etykieta
   * i token → kolejny „restart Raroga" nie podejmuje panelu. Kolejność argumentów CLI jest tu
   * częścią asercji (zmierzone na herdr 0.9.3): adres panelu PRZED opcjami — przy
   * odwrotnej `pane rename` bierze `--clear` za adres, a `report-metadata` odmawia składni.
   */
  it('token skasowany jak po restarcie herdr wraca z etykiety panelu', async () => {
    const opened = h.term.open(h.cwd);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    liveIds.push(opened.id);

    // `open` zakłada panel w tle (uchwyt-obietnica) — czekamy, aż stanie z tokenem i etykietą.
    const deadline = Date.now() + 20_000;
    let pane = (await launchClient.listPanes()).find((p) => p.tokens[RAROG_TERM_TOKEN] === opened.id);
    while (pane === undefined || pane.label === null) {
      if (Date.now() > deadline) throw new Error('panel terminala nie powstał z tokenem i etykietą');
      await sleep(200);
      pane = (await launchClient.listPanes()).find((p) => p.tokens[RAROG_TERM_TOKEN] === opened.id);
    }
    expect(parsePaneLabel(pane.label)).toEqual({ kind: 'term', value: opened.id });
    const paneId = pane.paneId;
    const panesBefore = (await launchClient.listPanes()).length;

    const herdrCli = (args: string[]): Promise<void> => new Promise<void>((resolve, reject) => {
      execFile(liveConfig.herdrBin, args, (err) => { if (err === null) resolve(); else reject(err); });
    });
    const clearToken = ['pane', 'report-metadata', paneId, '--source', 'rarog-term', '--clear-token', RAROG_TERM_TOKEN];
    await herdrCli(clearToken);
    const stripped = (await launchClient.listPanes()).find((p) => p.paneId === paneId);
    expect(stripped?.tokens[RAROG_TERM_TOKEN]).toBeUndefined();
    expect(stripped?.label).toBe(pane.label);

    const restarted = createTermBackend(liveConfig, {
      logger: silentLogger, herdrLaunchClient: () => launchClient,
    });
    const result = await restarted.reconcile();
    expect(result.restored).toContain(paneId);
    const restored = (await launchClient.listPanes()).find((p) => p.paneId === paneId);
    expect(restored?.tokens[RAROG_TERM_TOKEN]).toBe(opened.id);

    expect(await restarted.ensureSession(opened.id, h.cwd)).toEqual({ ref: paneId, id: opened.id, fresh: false });
    expect((await launchClient.listPanes()).length).toBe(panesBefore);
    restarted.dispose();

    // Runbook „zapomnij panel": etykieta i token zdjęte → kolejny start Raroga panelu nie podejmuje.
    await herdrCli(['pane', 'rename', paneId, '--clear']);
    await herdrCli(clearToken);
    const forgetful = createTermBackend(liveConfig, {
      logger: silentLogger, herdrLaunchClient: () => launchClient,
    });
    const after = await forgetful.reconcile();
    expect(after.restored).not.toContain(paneId);
    expect(after.migrated).not.toContain(paneId);
    const forgotten = (await launchClient.listPanes()).find((p) => p.paneId === paneId);
    expect(forgotten?.label ?? null).toBeNull();
    expect(forgotten?.tokens[RAROG_TERM_TOKEN]).toBeUndefined();
    forgetful.dispose();

    // Sprzątanie: panel jest już „cudzy" dla bramki własności, więc test zamyka SWÓJ panel wprost.
    await launchClient.closePane(paneId);
    expect((await launchClient.listPanes()).some((p) => p.paneId === paneId)).toBe(false);
  }, 60_000);
});
