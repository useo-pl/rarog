/**
 * Migawka treści demo: wszystko, co klient widzi w demo po polsku, w jednym pliku
 * `server/test/fixtures/demo-content/pl.json`. Plik powstał na kodzie sprzed przeniesienia treści do
 * `server/src/demo/content/`, więc równość z nim dowodzi, że refaktor nie zmienił odpowiedzi demo.
 * Domyślnie test PORÓWNUJE; `RAROG_FIXTURES_WRITE=1` (poza sandboksem: `listen()`) nadpisuje plik.
 *
 * Co jest w migawce: ramka `sessions-snapshot` z `GET /api/stream`, pierwsze ramki strumienia każdej
 * z 8 sesji (`transcript-snapshot` i to, co hub wysyła zaraz po nim), notatki każdego projektu,
 * `GET /api/fs`, `GET /api/projects`, `GET /api/resumable?cwd=` każdego projektu, diff sesji
 * (`…/diff`, `…/diff/files`, `…/diff/file` każdego pliku), zdjęcia seedów (status, typ, skrót bajtów),
 * jedna tura przez manager (ramki sesji po wysyłce, z `git-status` i `lastCommit`) oraz zdarzenia atrapy
 * silnika na wejścia `pytanie`, `czerwone` (zgoda i odmowa), `limit`, `błąd`, `blad`, zwykłe zdania
 * (trzy tury, cały cykl odpowiedzi), obrazki (trzy formy liczby) i scenariusz `streaming` (cały cykl
 * fragmentów).
 *
 * Determinizm:
 * - serwer: fake timery vitest tylko dla `Date`, `setTimeout`, `clearTimeout`, `setInterval`
 *   i `clearInterval`, zegar zamrożony na {@link CHWILA}. Seedy (`demoSeeds(now)`), notatki
 *   (`createDemoNotes(now)`), „teraz” managera i mock nadzorcy biorą `Date.now()`, więc czasy są stałe.
 *   Drivery seedów planują kroki przez globalny `setTimeout` (`systemScheduler`), a ten jest atrapą:
 *   nic nie tyka samo, a turę z wysyłką przewija jawne `vi.advanceTimersByTimeAsync`. HTTP i gniazda
 *   Node chodzą na wewnętrznych timerach, których atrapa nie podmienia, a klient to `node:http`
 *   (nie `fetch`).
 * - atrapa silnika: `MockDriver` na ręcznym zegarze (jak `mock-driver.test.ts`); generator opóźnień
 *   `streaming` ma stałe ziarno.
 * - losowość: `randomUUID` mocka nadzorcy (`launch`) nie jest w użyciu; ramki sesji niosą numery
 *   `seq` z rejestru, nie losowe.
 * - z migawki wypadają (jawna lista {@link POZA_MIGAWKA}): `serverStartId` (identyfikator procesu
 *   z huba). Ramki `hello` nie ma w migawce wcale: niesie tylko pola procesu i protokołu.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createMockHerdr } from '../src/demo/mock-herdr.ts';
import { createDemoNotes } from '../src/demo/notes.ts';
import { MockDriver } from '../src/drivers/mock-driver.ts';
import type { MockScenario } from '../src/drivers/mock-driver.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { createRouter } from '../src/router.ts';
import { createManager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { REPO } from './private-guard.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';

const PLIK = path.join(REPO, 'server/test/fixtures/demo-content/pl.json');
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';
const ORIGIN = 'http://127.0.0.1:18998';
/** Zamrożone „teraz” serwera demo. */
const CHWILA = Date.parse('2026-11-07T09:00:00.000Z');
/** Pola zależne od procesu, usuwane z każdej ramki i odpowiedzi przed zapisem (powód obok). */
const POZA_MIGAWKA: Readonly<Record<string, string>> = {
  serverStartId: 'identyfikator procesu serwera, inny przy każdym starcie',
};
const SESJE = [
  'demo-willow', 'demo-willow-parser', 'demo-rarog', 'demo-fleet-ops', 'demo-data-loader', 'demo-pipe-link',
  'demo-map-view', 'demo-rarog-stop',
] as const;
/** 1×1 px png do echa obrazków atrapy. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Kopia JSON bez pól z {@link POZA_MIGAWKA} (rekurencyjnie). */
function bezProcesu(value: unknown): Json {
  return JSON.parse(JSON.stringify(value, (key, inner: unknown) => (key in POZA_MIGAWKA ? undefined : inner))) as Json;
}

// ---------------------------------------------------------------------------
// Serwer demo
// ---------------------------------------------------------------------------

interface Odpowiedz {
  status: number;
  type: string | null;
  body: Json;
}

async function serwer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'rarog-demo-migawka-'));
  const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dataDir, RAROG_ORIGINS: ORIGIN });
  const device = createTestDevice(dataDir, { epoch: config.epoch });
  const mock = createMockHerdr(demoContentPl);
  const manager = await createManager({
    ...config, demoContent: demoContentPl, herdrSupervisor: mock.supervisor, herdrDeps: mock.deps,
  });
  await manager.ready;
  // Notatki demo jak w `index.ts`: jeden magazyn dla huba i routera.
  const notes = createDemoNotes(demoContentPl);
  const hub = new SseHub({
    manager, serverStartId: 'migawka', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
    notesFor: (cwds) => notes.withNotes(cwds),
  });
  hub.start();
  const router = createRouter({
    config, manager, hub, serverStartId: 'migawka', startedAtMs: CHWILA, logger: { info() {}, error() {} }, notes,
    devices: device.identity, readUpload: (cwd, name) => mock.readUpload(cwd, name),
  });
  const server = http.createServer(router);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const headers = { Origin: ORIGIN, ...device.headers };

  /** Żądanie przez `node:http` (bez `fetch`, który mógłby sięgnąć po podmienione timery). */
  const zadanie = (method: string, sciezka: string, body?: unknown): Promise<{ status: number; type: string | null;
    bytes: Buffer; }> => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: sciezka,
      headers: { ...headers, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'] ?? null, bytes: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });

  const json = async (method: string, sciezka: string, body?: unknown): Promise<Odpowiedz> => {
    const res = await zadanie(method, sciezka, body);
    const text = res.bytes.toString('utf8');
    return { status: res.status, type: res.type, body: text === '' ? null : bezProcesu(JSON.parse(text)) };
  };

  /** Strumień SSE słuchany w tle: ramki (pole `data:`) zbierane do `close()`. */
  const sluchaj = (sciezka: string) => {
    let bufor = '';
    const zebrane: Json[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: sciezka, headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bufor += chunk;
        const czesci = bufor.split('\n\n');
        bufor = czesci.pop() ?? '';
        for (const ramka of czesci) {
          const data = /^data: (.*)$/m.exec(ramka)?.[1];
          if (data !== undefined) zebrane.push(bezProcesu(JSON.parse(data)));
        }
      });
    });
    req.on('error', () => { /* rozłączenie w `close()` jest celowe */ });
    return {
      typy: (): string[] => zebrane.map((ramka) => String((ramka as { type?: string }).type)),
      close(): Json[] {
        req.destroy();
        return zebrane;
      },
    };
  };

  /** Ramki SSE (pole `data:`) do pierwszej ramki typu `koniec` włącznie; potem rozłączenie. */
  const ramki = (sciezka: string, koniec: string): Promise<Json[]> => new Promise((resolve, reject) => {
    let bufor = '';
    const zebrane: Json[] = [];
    const req = http.get({ host: '127.0.0.1', port, path: sciezka, headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        bufor += chunk;
        const czesci = bufor.split('\n\n');
        bufor = czesci.pop() ?? '';
        for (const ramka of czesci) {
          const data = /^data: (.*)$/m.exec(ramka)?.[1];
          if (data === undefined) continue;
          const event = JSON.parse(data) as { type?: string };
          zebrane.push(bezProcesu(event));
          if (event.type === koniec) {
            req.destroy();
            resolve(zebrane);
            return;
          }
        }
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'ECONNRESET') reject(err); });
  });

  return {
    zadanie, json, ramki, sluchaj,
    async close() {
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await manager.dispose();
      mock.dispose();
      await rm(dataDir, { force: true, recursive: true });
    },
  };
}

type Serwer = Awaited<ReturnType<typeof serwer>>;

/** Pierwsze ramki strumienia sesji: snapshot transkryptu i ramki, które hub wysyła zaraz po nim. */
async function strumienSesji(s: Serwer, id: string): Promise<Json[]> {
  // Ramka `git-status` z powtórki dochodzi tylko po turze; bez niej strumień kończy `transcript-snapshot`.
  return await s.ramki(`/api/sessions/${id}/stream`, 'transcript-snapshot');
}

/** Czeka (oddając pętlę zdarzeń, bez timerów) aż warunek się spełni; po 2000 obrotach błąd. */
async function czekaj(warunek: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (warunek()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  throw new Error('migawka: warunek nie spełniony');
}

async function migawkaSerwera(s: Serwer): Promise<Record<string, Json>> {
  const projekty = await s.json('GET', '/api/projects');
  const sciezki = ((projekty.body as { projects?: { path: string }[] } | null)?.projects ?? []).map((p) => p.path);
  expect(sciezki.length, 'lista projektów demo').toBeGreaterThan(0);

  const global = await s.ramki('/api/stream', 'sessions-snapshot');
  const transkrypty: Record<string, Json> = {};
  for (const id of SESJE) transkrypty[id] = await strumienSesji(s, id);

  const notatki: Record<string, Json> = {};
  const wznow: Record<string, Json> = {};
  for (const cwd of sciezki) {
    const q = encodeURIComponent(cwd);
    notatki[cwd] = (await s.json('GET', `/api/notes?cwd=${q}`)) as unknown as Json;
    wznow[cwd] = (await s.json('GET', `/api/resumable?cwd=${q}`)) as unknown as Json;
  }

  const diffPliki = await s.json('GET', '/api/sessions/demo-willow/diff/files');
  const pliki = ((diffPliki.body as { files?: { path: string }[] } | null)?.files ?? []).map((f) => f.path);
  expect(pliki.length, 'pliki diffu demo').toBeGreaterThan(0);
  const diffPlik: Record<string, Json> = {};
  for (const plik of pliki) {
    diffPlik[plik] = (await s.json('GET', `/api/sessions/demo-willow/diff/file?path=${encodeURIComponent(plik)}`)) as
      unknown as Json;
  }

  // Zdjęcia seedów: nazwy z załączników transkryptów, bajty jako skrót.
  const zdjecia: Record<string, Json> = {};
  for (const id of SESJE) {
    const tekst = JSON.stringify(transkrypty[id]);
    for (const [, plik] of tekst.matchAll(/"file":"([^"]+)"/g)) {
      if (plik === undefined) continue;
      const res = await s.zadanie('GET', `/api/sessions/${id}/uploads/${encodeURIComponent(plik)}`);
      zdjecia[`${id}/${plik}`] = res.type === 'image/png'
        ? { status: res.status, type: res.type, pixels: pngPixels(res.bytes) }
        : {
          status: res.status, type: res.type, sha256: createHash('sha256').update(res.bytes).digest('hex'),
          bytes: res.bytes.byteLength,
        };
    }
  }
  expect(Object.keys(zdjecia).length, 'zdjęcia seedów').toBeGreaterThan(0);

  // Tury przez manager na sesji `demo-willow`: zgoda z seeda prowadzi turę dalej, potem zwykłe zdanie. Strumień
  // sesji słucha od początku, zegar jest przewijany jawnie do końca każdej tury.
  const ucho = s.sluchaj('/api/sessions/demo-willow/stream');
  await czekaj(() => ucho.typy().includes('transcript-snapshot'));
  const zgoda = await s.json('POST', '/api/sessions/demo-willow/permissions/demo-perm-willow', { decision: 'allow' });
  await vi.advanceTimersByTimeAsync(10_000);
  await czekaj(() => ucho.typy().includes('git-status'));
  const wysylka = await s.json('POST', '/api/sessions/demo-willow/messages', {
    text: 'Sprawdź jeszcze raz zapis.', clientMessageId: '00000000-0000-4000-8000-00000000a501',
  });
  await vi.advanceTimersByTimeAsync(10_000);
  await czekaj(() => ucho.typy().filter((typ) => typ === 'git-status').length >= 2);
  const tura = ucho.close();

  return {
    stream: global.filter((ramka) => (ramka as { type?: string }).type === 'sessions-snapshot'),
    transcripts: transkrypty,
    notes: notatki,
    fs: [await s.json('GET', '/api/fs'), await s.json('GET', `/api/fs?path=${encodeURIComponent('/Users/demo/Projects')}`)] as
      unknown as Json,
    projects: projekty as unknown as Json,
    resumable: wznow,
    diff: (await s.json('GET', '/api/sessions/demo-willow/diff')) as unknown as Json,
    diffFiles: diffPliki as unknown as Json,
    diffFile: diffPlik,
    uploads: zdjecia,
    turn: { permission: zgoda as unknown as Json, send: wysylka as unknown as Json, frames: tura },
  };
}

// ---------------------------------------------------------------------------
// Atrapa silnika na ręcznym zegarze
// ---------------------------------------------------------------------------

/** Zegar sterowany z testu, jak w `mock-driver.test.ts`. */
class ReczyZegar implements Scheduler {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + ms, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  now(): number {
    return this.#now;
  }

  tick(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (due.length === 0) break;
      for (const [id, timer] of due) {
        this.#timers.delete(id);
        this.#now = timer.at;
        timer.fn();
      }
    }
    this.#now = target;
  }
}

const oddaj = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** Driver atrapy z ręcznym zegarem i zbieraniem zdarzeń. */
function atrapa(scenario: MockScenario = { kind: 'idle' }) {
  const zegar = new ReczyZegar();
  const driver = new MockDriver({
    content: demoContentPl, cwd: '/Users/demo/Projects/willow', scenario, scheduler: zegar,
  });
  const zdarzenia: DriverEvent[] = [];
  void (async () => { for await (const event of driver.events) zdarzenia.push(event); })();
  return {
    driver,
    async tick(ms: number): Promise<void> {
      zegar.tick(ms);
      await oddaj();
    },
    zrzut(): Json {
      const out = bezProcesu(zdarzenia);
      zdarzenia.length = 0;
      return out;
    },
  };
}

async function migawkaAtrapy(): Promise<Record<string, Json>> {
  const wynik: Record<string, Json> = {};
  const zwykle = async (wejscie: string): Promise<Json> => {
    const a = atrapa();
    await a.tick(0);
    a.driver.send(wejscie);
    await a.tick(20_000);
    const out = a.zrzut();
    a.driver.dispose();
    return out;
  };
  for (const wejscie of ['limit', 'błąd', 'blad']) wynik[wejscie] = await zwykle(wejscie);

  // Trzy zwykłe tury: cały cykl odpowiedzi i licznik brudnych plików 1 → 3.
  {
    const a = atrapa();
    await a.tick(0);
    const tury: Json[] = [a.zrzut()];
    for (const zdanie of ['Zrób przegląd modułu.', 'Popraw to.', 'Puść testy.']) {
      a.driver.send(zdanie);
      await a.tick(20_000);
      tury.push(a.zrzut());
    }
    a.driver.dispose();
    wynik['zwykłe zdanie'] = tury;
  }

  // Pytanie i odpowiedź na nie.
  {
    const a = atrapa();
    await a.tick(0);
    a.driver.send('Mam pytanie o zapis.');
    await a.tick(1_000);
    const przed = a.zrzut();
    const reqId = ((przed as { type?: string; reqId?: string }[]).find((e) => e.type === 'question-request'))?.reqId;
    expect(reqId, 'reqId pytania atrapy').toBeTypeOf('string');
    const odp = await a.driver.answerQuestion(reqId ?? '', [['SQLite'], ['Jednostkowe', 'Integracyjne']]);
    await a.tick(20_000);
    wynik['pytanie'] = { request: przed, outcome: bezProcesu(odp), after: a.zrzut() };
    a.driver.dispose();
  }

  // Czerwona komenda: zgoda i odmowa.
  for (const decyzja of ['allow', 'deny'] as const) {
    const a = atrapa();
    await a.tick(0);
    a.driver.send('Zrób to na czerwone.');
    await a.tick(1_000);
    const przed = a.zrzut();
    const reqId = ((przed as { type?: string; reqId?: string }[]).find((e) => e.type === 'permission-request'))?.reqId;
    expect(reqId, 'reqId zgody atrapy').toBeTypeOf('string');
    const odp = await a.driver.respondPermission(reqId ?? '', decyzja);
    await a.tick(20_000);
    wynik[`czerwone ${decyzja}`] = { request: przed, outcome: bezProcesu(odp), after: a.zrzut() };
    a.driver.dispose();
  }

  // Echo obrazków: trzy formy liczby.
  for (const n of [1, 2, 5]) {
    const a = atrapa();
    await a.tick(0);
    a.zrzut();
    a.driver.send('Zobacz zrzut.', Array.from({ length: n }, () => PNG));
    await a.tick(20_000);
    wynik[`obrazki ${String(n)}`] = a.zrzut();
    a.driver.dispose();
  }

  // Scenariusz `streaming`: dwie domknięte wiadomości, cały cykl fragmentów.
  {
    const a = atrapa({ kind: 'streaming' });
    await a.tick(31_000);
    wynik['streaming'] = a.zrzut();
    a.driver.dispose();
  }
  return wynik;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identity of a PNG without its compression: SHA-256 of the IHDR chunk and the inflated IDAT data. The demo seeds
 * compress with `deflateSync`, whose bytes depend on the zlib that Node links (Homebrew's Node uses the system
 * library), so the byte hash and size changed with the machine while the image stayed the same. The signature and
 * every chunk CRC are checked first, since a decoder rejects a PNG with a broken CRC that the pixels would not show.
 */
function pngPixels(png: Buffer): string {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG: signature');
  const parts: Buffer[] = [];
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (at + 12 + length > png.length || crc32(png.subarray(at + 4, at + 8 + length)) !== png.readUInt32BE(at + 8 + length)) {
      throw new Error(`PNG chunk ${type}: CRC mismatch`);
    }
    if (type === 'IHDR') parts.push(data);
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  parts.push(inflateSync(Buffer.concat(idat)));
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}

/** PNG attachment sizes in frames depend on the zlib too (see {@link pngPixels}): the snapshot keeps a marker. */
function bezRozmiaruPng(value: Json): Json {
  if (Array.isArray(value)) return value.map(bezRozmiaruPng);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) out[key] = bezRozmiaruPng(item);
  if (out['kind'] === 'image' && out['mime'] === 'image/png' && typeof out['bytes'] === 'number' && out['bytes'] > 0) {
    out['bytes'] = 'png';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Producent
// ---------------------------------------------------------------------------

describe('pngPixels', () => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  // A 1×1 grey image: IHDR (width, height, depth 8, colour type 0), one row with filter byte 0.
  const png = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 0x80]))), chunk('IEND', Buffer.alloc(0))]);

  it('the same pixels under another compression give the same identity', () => {
    const other = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
      chunk('IDAT', deflateSync(Buffer.from([0, 0x80]), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
    expect(other.equals(png)).toBe(false);
    expect(pngPixels(other)).toBe(pngPixels(png));
  });

  it('a broken chunk CRC is rejected', () => {
    const broken = Buffer.from(png);
    broken.writeUInt32BE(0, 8 + 8 + 13);
    expect(() => pngPixels(broken)).toThrow(/IHDR: CRC mismatch/);
  });
});

describe('migawka treści demo PL', () => {
  let s: Serwer;
  beforeAll(async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: CHWILA,
    });
    s = await serwer();
  });
  afterAll(async () => {
    await s.close();
    vi.useRealTimers();
  });

  it('odpowiedzi demo równe migawce (odśwież: RAROG_FIXTURES_WRITE=1)', async () => {
    const migawka = bezRozmiaruPng({ server: await migawkaSerwera(s), driver: await migawkaAtrapy() } as Json);
    const tekst = `${JSON.stringify(migawka, null, 2)}\n`;
    if (WRITE) {
      mkdirSync(path.dirname(PLIK), { recursive: true });
      writeFileSync(PLIK, tekst);
    }
    expect(existsSync(PLIK), `brak ${PLIK}: zapisz go RAROG_FIXTURES_WRITE=1`).toBe(true);
    expect(tekst).toBe(readFileSync(PLIK, 'utf8'));
  }, 60_000);
});
