/**
 * Idempotentna wysyłka `POST /api/sessions/:id/messages` z `clientMessageId`.
 *
 * Klient natywny ponawia wiadomość z trwałej kolejki TYMI SAMYMI bajtami i TYM SAMYM
 * identyfikatorem, nie wiedząc, czy pierwszy POST doszedł. Te testy pilnują, że do panelu idzie
 * ona najwyżej raz, a każda odmowa zwalnia identyfikator do ponowienia:
 * - kolejność w `sendMessage`: lookup, powtórka albo dołączenie, rezerwacja — PRZED bramkami
 *   stanu i throttle'a (powtórka przy karcie zgody to 202, nie 409, i nie zjada slotu);
 * - rejestr na dysku (`outbox-ids.json`): zapis przed odpowiedzią, restart, uszkodzony plik,
 *   okno 24 h, szeregowanie zapisów, `0600`, zero treści wiadomości;
 * - skrót z TREŚCI załączników: te same metadane z innymi bajtami to 409 `client-id-conflict`.
 *
 * Granica jest ta sama co w złotych ramkach: atrapa nadzorcy herdr i driver sterowany z testu
 * (zero gniazda), prawdziwy manager, prawdziwy router na porcie efemerycznym.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { CLIENT_ID_CONFLICT_ERROR } from '@rarog/shared/rest';
import type { HerdrStatus } from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { type Logger, createRouter } from '../src/router.ts';
import {
  BadStateError, NotFoundError, TooManyRequestsError, createManager,
} from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import {
  CLIENT_ID_CONFLICT_MESSAGE, ClientIdConflictError, SEND_REGISTRY_FILENAME,
  SEND_REGISTRY_FORMAT, SEND_REGISTRY_WINDOW_MS, SEND_REGISTRY_WRITE_FAILED_LOG, createSendRegistry,
  sendDigest, sendRegistryPath,
} from '../src/sessions/send-registry.ts';
import { SseHub } from '../src/sse.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const ROOT = '/Users/demo/Projects';
const KEY = 'w1:p1';
const CID = '3f2b8c1e-7a4d-4e9b-9c21-5d6e7f8a9b0c';
const CID2 = '9d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6';
const T0 = Date.parse('2026-10-04T10:00:00.000Z');

/** 1×1 px png. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
/** Ten sam rozmiar, MIME i nazwa (pusta) co {@link PNG}, inny jeden bajt treści. */
const PNG_OTHER = PNG.replace('AAAACklEQVR4', 'AAAACklEQVR5');
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

// ---------------------------------------------------------------------------
// Atrapy nadzorcy i drivera (granica: zdarzenia, nie gniazdo)
// ---------------------------------------------------------------------------

class FixtureDriver extends AtrapaDrivera {
  push(...events: DriverEvent[]): void {
    for (const event of events) this.queue.push(event);
  }
}

class FixtureSupervisor extends AtrapaNadzorcy<FixtureDriver> {
  readonly onAttach = new Map<string, DriverEvent[]>();

  override status(): HerdrStatus {
    return { available: true, agentCount: this.drivers.size, readOnly: false, canLaunch: false };
  }

  protected nowyDriver(key: string): FixtureDriver {
    return new FixtureDriver(key);
  }

  override attach(key: string): FixtureDriver {
    const driver = super.attach(key);
    driver.push(...(this.onAttach.get(key) ?? []));
    return driver;
  }

  appear(agent: HerdrAgent, onAttach: DriverEvent[]): void {
    this.onAttach.set(agent.key, onAttach);
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function agent(key: string): HerdrAgent {
  return {
    key, paneId: key, tabId: 'w1:t1', agentSessionId: '4b7f0d2e-9c61-4a3b-8e15-2d9f6c0a7b31',
    engine: 'claude', termId: null, cwd: `${ROOT}/atlas`, status: 'idle', title: 'atlas',
    stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true, launchedByRarog: true,
    interactiveReady: true,
  };
}

const idOf = (key: string): string => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`;

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

interface Rig {
  manager: Manager;
  id: string;
  driver: FixtureDriver;
  /** Kolejne odpowiedzi throttle'a (`false` = 429); pusta lista = zawsze slot. */
  slots: boolean[];
  logs: string[];
  clock: { now: number };
  close(): Promise<void>;
}

async function rig(dataDir: string, clock = { now: T0 }): Promise<Rig> {
  const slots: boolean[] = [];
  const logs: string[] = [];
  const supervisor = new FixtureSupervisor();
  const deps: HerdrManagerDeps = {
    sessionIdFor: idOf,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => slots.shift() ?? true,
    writeUploads: (cwd, images) => Promise.resolve(
      images.map((_, i) => `${cwd}/.rarog-uploads/1790000000-000000000000000${String(i)}.png`),
    ),
    writeUploadFiles: (cwd, files) => Promise.resolve(
      files.map((file) => `${cwd}/.rarog-uploads/1790000001-a1b2c3d4e5f60718-${file.name}`),
    ),
    sweepUploads: () => Promise.resolve(),
  };
  const manager = await createManager({
    demo: false, dataDir, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [ROOT],
    now: () => clock.now, gitStatus: null, gitWatcher: null,
    liveSessionsReader: () => Promise.resolve(null),
    logger: (line) => { logs.push(line); },
  });
  await manager.ready;
  supervisor.appear(agent(KEY), [
    { type: 'agent-state', state: 'idle', seen: true, mode: 'auto', stateChangeSeq: 1 },
  ]);
  await flush();
  const driver = supervisor.drivers.get(KEY);
  if (driver === undefined) throw new Error('driver nie został podpięty');
  return {
    manager, id: idOf(KEY), driver, slots, logs, clock,
    close: async () => {
      await manager.dispose();
      supervisor.dispose();
    },
  };
}

interface FileShape {
  format: number;
  entries: { id: string; sessionId: string; digest: string; at: number }[];
}

async function readRegistry(dataDir: string): Promise<FileShape> {
  return JSON.parse(await readFile(join(dataDir, SEND_REGISTRY_FILENAME), 'utf8')) as FileShape;
}

/** Echa wysyłki o danym identyfikatorze w transkrypcie sesji. */
function echoes(r: Rig, clientMessageId: string): number {
  return r.manager.transcript(r.id).messages
    .filter((message) => message.clientMessageId === clientMessageId).length;
}

let dataDir: string;
const rigs: Rig[] = [];

async function open(clock?: { now: number }): Promise<Rig> {
  const r = await rig(dataDir, clock);
  rigs.push(r);
  return r;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-s5-'));
});

afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
  await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

describe('pierwsze przyjęcie', () => {
  it('jedna wysyłka, echo z identyfikatorem, wpis 0600 na dysku zanim obietnica się rozwiąże', async () => {
    const r = await open();
    await expect(r.manager.sendMessage(r.id, 'zrób refaktor', undefined, undefined, CID))
      .resolves.toEqual({ replayed: false });

    expect(r.driver.sent).toEqual(['zrób refaktor']);
    const echo = r.manager.transcript(r.id).messages.at(-1);
    expect(echo).toMatchObject({ role: 'user', clientMessageId: CID });
    // Zapis PRZED 202: plik jest kompletny bez `flush()`.
    expect(await readRegistry(dataDir)).toEqual({
      format: SEND_REGISTRY_FORMAT,
      entries: [{ id: CID, sessionId: r.id, digest: sendDigest('zrób refaktor'), at: T0 }],
    });
    const file = sendRegistryPath(dataDir);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // Dwa identyfikatory, skrót i czas — treści wiadomości w pliku nie ma.
    expect(await readFile(file, 'utf8')).not.toContain('refaktor');
  });

  it('wysyłka BEZ identyfikatora: echo bez pola, rejestr nietknięty', async () => {
    const r = await open();
    await expect(r.manager.sendMessage(r.id, 'stara PWA')).resolves.toEqual({ replayed: false });
    expect(r.driver.sent).toEqual(['stara PWA']);
    expect(r.manager.transcript(r.id).messages.at(-1)).not.toHaveProperty('clientMessageId');
    await expect(stat(sendRegistryPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('powtórki i wyścigi', () => {
  it('dwa równoległe wywołania z jednym id: ta sama obietnica, jedna wysyłka, jedno echo', async () => {
    const r = await open();
    const first = r.manager.sendMessage(r.id, 'raz', undefined, undefined, CID);
    const second = r.manager.sendMessage(r.id, 'raz', undefined, undefined, CID);
    expect(second).toBe(first);
    await expect(Promise.all([first, second]))
      .resolves.toEqual([{ replayed: false }, { replayed: false }]);
    expect(r.driver.sent).toEqual(['raz']);
    expect(echoes(r, CID)).toBe(1);
  });

  it('powtórka przyjętej przy karcie zgody → replayed (nie 409), a NOWA wiadomość dalej odbija', async () => {
    const r = await open();
    await r.manager.sendMessage(r.id, 'uruchom testy', undefined, undefined, CID);
    r.driver.push({
      type: 'permission-request', reqId: 'toolu_1', toolName: 'Bash',
      input: { command: 'pnpm test' }, displayText: 'pnpm test',
    });
    await flush();
    expect(r.manager.get(r.id)?.state).toBe('waiting-permission');

    await expect(r.manager.sendMessage(r.id, 'uruchom testy', undefined, undefined, CID))
      .resolves.toEqual({ replayed: true });
    expect(r.driver.sent).toEqual(['uruchom testy']);
    // Bramki stanu zostają dla wszystkiego, co NIE jest powtórką przyjętej wiadomości.
    expect(() => r.manager.sendMessage(r.id, 'coś nowego', undefined, undefined, CID2))
      .toThrow(BadStateError);
  });

  it('rzut synchroniczny w bramkach zwalnia rezerwację: ten id przechodzi potem gdzie indziej', async () => {
    const r = await open();
    expect(() => r.manager.sendMessage('nie-ma', 'x', undefined, undefined, CID))
      .toThrow(NotFoundError);
    // Bez zwolnienia: `pending` do innej sesji = konflikt, a wiszący wpis = wieczne czekanie.
    await expect(r.manager.sendMessage(r.id, 'x', undefined, undefined, CID))
      .resolves.toEqual({ replayed: false });
    expect(r.driver.sent).toEqual(['x']);
  });

  it('429 nie trafia do rejestru: ponowienie z tym samym id wysyła raz', async () => {
    const r = await open();
    r.slots.push(false);
    await expect(r.manager.sendMessage(r.id, 'druga', undefined, undefined, CID))
      .rejects.toBeInstanceOf(TooManyRequestsError);
    expect(r.driver.sent).toEqual([]);
    expect(echoes(r, CID)).toBe(0);

    await expect(r.manager.sendMessage(r.id, 'druga', undefined, undefined, CID))
      .resolves.toEqual({ replayed: false });
    // Powtórka przyjętej nie bierze slotu: throttle odmówiłby, gdyby go zapytano.
    r.slots.push(false);
    await expect(r.manager.sendMessage(r.id, 'druga', undefined, undefined, CID))
      .resolves.toEqual({ replayed: true });
    expect(r.driver.sent).toEqual(['druga']);
    expect((await readRegistry(dataDir)).entries.map((e) => e.id)).toEqual([CID]);
  });

  it('ten sam id z INNYMI BAJTAMI załącznika (ta sama nazwa, MIME i waga) → konflikt', async () => {
    const r = await open();
    await r.manager.sendMessage(r.id, 'zobacz', [PNG], undefined, CID);
    expect(() => r.manager.sendMessage(r.id, 'zobacz', [PNG_OTHER], undefined, CID))
      .toThrow(ClientIdConflictError);
    // Ten sam id z inną treścią albo do innej sesji też.
    expect(() => r.manager.sendMessage(r.id, 'zobacz inaczej', [PNG], undefined, CID))
      .toThrow(CLIENT_ID_CONFLICT_MESSAGE);
    expect(r.driver.sent).toHaveLength(1);
  });

  it('równoległe przyjęcia RÓŻNYCH id: zapisy szeregowane, plik ma każdy wpis', async () => {
    const r = await open();
    const ids = Array.from({ length: 20 }, () => randomUUID());
    await Promise.all(ids.map((id, i) => r.manager.sendMessage(
      r.id, `wiadomość ${String(i)}`, undefined, undefined, id,
    )));
    expect(r.driver.sent).toHaveLength(20);
    expect((await readRegistry(dataDir)).entries.map((e) => e.id).sort()).toEqual([...ids].sort());
  });
});

describe('rejestr na dysku', () => {
  it('restart Raroga: powtórka z pliku bez drugiej wysyłki, inna treść → konflikt', async () => {
    const first = await rig(dataDir);
    await first.manager.sendMessage(first.id, 'raz', [PNG], [{ name: 'a.pdf', dataUrl: PDF }], CID);
    await first.close();

    const second = await open();
    await expect(second.manager.sendMessage(
      second.id, 'raz', [PNG], [{ name: 'a.pdf', dataUrl: PDF }], CID,
    )).resolves.toEqual({ replayed: true });
    expect(second.driver.sent).toEqual([]);
    expect(() => second.manager.sendMessage(second.id, 'dwa', undefined, undefined, CID))
      .toThrow(ClientIdConflictError);
  });

  it('uszkodzony plik: pusty rejestr, linia w logu, pierwsze przyjęcie zapisuje poprawny plik', async () => {
    await writeFile(sendRegistryPath(dataDir), '{"format":1,"entries":[', 'utf8');
    const r = await open();
    expect(r.logs.filter((line) => line.startsWith('outbox-ids:'))).toEqual([
      'outbox-ids: corrupt file (not JSON) — send registry starts empty',
    ]);
    await expect(r.manager.sendMessage(r.id, 'po awarii', undefined, undefined, CID))
      .resolves.toEqual({ replayed: false });
    expect((await readRegistry(dataDir)).entries.map((e) => e.id)).toEqual([CID]);
  });

  it('nieznana wersja formatu i wpisy-śmieci: czytane jak brak, bez wyjątku', async () => {
    await writeFile(sendRegistryPath(dataDir), JSON.stringify({ format: 2, entries: [] }), 'utf8');
    const newer = await rig(dataDir);
    expect(newer.logs).toContain('outbox-ids: unknown file format — send registry starts empty');
    await newer.close();

    await writeFile(sendRegistryPath(dataDir), JSON.stringify({
      format: SEND_REGISTRY_FORMAT,
      entries: [
        { id: CID, sessionId: idOf(KEY), digest: 'nie-hex', at: T0 },
        { id: CID2, sessionId: idOf(KEY), digest: sendDigest('dobry'), at: Number.NaN },
        null,
        { id: '', sessionId: idOf(KEY), digest: sendDigest('dobry'), at: T0 },
      ],
    }), 'utf8');
    const r = await open();
    await expect(r.manager.sendMessage(r.id, 'inna', undefined, undefined, CID))
      .resolves.toEqual({ replayed: false });
    await expect(r.manager.sendMessage(r.id, 'też inna', undefined, undefined, CID2))
      .resolves.toEqual({ replayed: false });
  });

  it('wpis starszy niż 24 h: ten sam id jest znów nową wiadomością (w RAM i z pliku)', async () => {
    const clock = { now: T0 };
    const r = await open(clock);
    await r.manager.sendMessage(r.id, 'rano', undefined, undefined, CID);
    clock.now += SEND_REGISTRY_WINDOW_MS - 1;
    await expect(r.manager.sendMessage(r.id, 'rano', undefined, undefined, CID))
      .resolves.toEqual({ replayed: true });
    clock.now += 1;
    await expect(r.manager.sendMessage(r.id, 'nazajutrz', undefined, undefined, CID))
      .resolves.toEqual({ replayed: false });
    expect(r.driver.sent).toEqual(['rano', 'nazajutrz']);

    // Z pliku: wpis sprzed okna nie wczytuje się wcale.
    await writeFile(sendRegistryPath(dataDir), JSON.stringify({
      format: SEND_REGISTRY_FORMAT,
      entries: [{ id: CID2, sessionId: idOf(KEY), digest: sendDigest('stara'), at: T0 }],
    }), 'utf8');
    const later = await rig(dataDir, { now: T0 + SEND_REGISTRY_WINDOW_MS });
    rigs.push(later);
    await expect(later.manager.sendMessage(later.id, 'nowa', undefined, undefined, CID2))
      .resolves.toEqual({ replayed: false });
  });

  it('nieudany zapis zostawia przyjęcie (202) i linię w logu; powtórka w tym procesie dalej działa', async () => {
    // `dataDir` będący PLIKIEM: `mkdir` i `writeFile` pod nim padają.
    const blocked = join(dataDir, 'to-jest-plik');
    await writeFile(blocked, 'x', 'utf8');
    const r = await rig(blocked);
    rigs.push(r);
    await expect(r.manager.sendMessage(r.id, 'mimo awarii dysku', undefined, undefined, CID))
      .resolves.toEqual({ replayed: false });
    expect(r.logs.some((line) => line.startsWith(SEND_REGISTRY_WRITE_FAILED_LOG))).toBe(true);
    await expect(r.manager.sendMessage(r.id, 'mimo awarii dysku', undefined, undefined, CID))
      .resolves.toEqual({ replayed: true });
    expect(r.driver.sent).toEqual(['mimo awarii dysku']);
  });
});

describe('moduł rejestru', () => {
  it('skrót liczy BAJTY treści: ta sama waga i MIME z innym bajtem to inny skrót', () => {
    expect(sendDigest('a', [PNG])).toBe(sendDigest('a', [PNG]));
    expect(sendDigest('a', [PNG])).not.toBe(sendDigest('a', [PNG_OTHER]));
    // Kolejność i rodzaj załącznika należą do treści; granic pól nie da się przesunąć tekstem.
    expect(sendDigest('a', [PNG], [{ name: 'x.pdf', dataUrl: PDF }]))
      .not.toBe(sendDigest('a', [], [{ name: 'x.pdf', dataUrl: PDF }]));
    expect(sendDigest('ab', [], [])).not.toBe(sendDigest('a', [], [{ name: 'b', dataUrl: PDF }]));
  });

  it('odrzucona wysyłka zwalnia id; sufit wpisów wypycha najstarszy', async () => {
    let now = T0;
    const registry = createSendRegistry({ dataDir, now: () => now, max: 3 });
    const key = { clientMessageId: CID, sessionId: 's1', digest: sendDigest('x') };
    await expect(registry.run(key, () => Promise.reject(new Error('odmowa')))).rejects.toThrow('odmowa');
    expect(registry.size).toBe(0);
    await expect(registry.run(key, () => Promise.resolve())).resolves.toEqual({ replayed: false });
    expect(registry.size).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      now += 1;
      await registry.run({ clientMessageId: `id-${String(i)}`, sessionId: 's1', digest: key.digest },
        () => Promise.resolve());
    }
    expect(registry.size).toBe(3);
    // Najstarszy (CID) wypadł: ten sam id z inną treścią przechodzi jak nowy.
    await expect(registry.run(
      { ...key, digest: sendDigest('inna') }, () => Promise.resolve(),
    )).resolves.toEqual({ replayed: false });
    await registry.flush();
  });

  it('powtórka W TRAKCIE zapisu czeka na plik: żadnego `replayed` przed zapisem na dysk', async () => {
    const registry = createSendRegistry({ dataDir });
    const key = { clientMessageId: CID, sessionId: 's1', digest: sendDigest('x') };
    let sends = 0;
    const first = registry.run(key, () => { sends += 1; return Promise.resolve(); });
    // Dwie mikrotury: wysyłka się rozwiązała, zapis rejestru (prawdziwe I/O) jeszcze trwa.
    await Promise.resolve();
    await Promise.resolve();
    const replay = registry.run(key, () => { sends += 1; return Promise.resolve(); });
    const outcome = await replay;
    // Plik istnieje w chwili odpowiedzi powtórce — awaria po niej nie zgubi wpisu.
    expect((await readRegistry(dataDir)).entries.map((e) => e.id)).toEqual([CID]);
    expect(outcome).toEqual({ replayed: false });
    expect(await first).toEqual({ replayed: false });
    expect(sends).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost:8930';
const silent: Logger = { info: () => {}, error: () => {} };

async function serve(manager: Manager): Promise<{ post(path: string, body: unknown): Promise<Response>;
  close(): Promise<void> }> {
  const config = loadConfig({ RAROG_DEMO: '1' });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const hub = new SseHub({ manager, serverStartId: 's5', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 's5', startedAtMs: Date.now(), logger: silent, devices: device.identity,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const { port } = server.address() as AddressInfo;
  return {
    post: (path, body) => fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: device.authorization },
      body: JSON.stringify(body),
    }),
    close: async () => {
      hub.closeAll();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

describe('POST /api/sessions/:id/messages', () => {
  it('dwa równoległe POST-y z jednym id: oba 202 z identyfikatorem, jedna wysyłka, jedno echo', async () => {
    const r = await open();
    const api = await serve(r.manager);
    try {
      const path = `/api/sessions/${r.id}/messages`;
      const responses = await Promise.all([
        api.post(path, { text: 'równolegle', clientMessageId: CID }),
        api.post(path, { text: 'równolegle', clientMessageId: CID }),
      ]);
      expect(responses.map((res) => res.status)).toEqual([202, 202]);
      for (const res of responses) {
        expect(await res.json()).toMatchObject({ ok: true, clientMessageId: CID });
      }
      expect(r.driver.sent).toEqual(['równolegle']);
      expect(echoes(r, CID)).toBe(1);
    } finally {
      await api.close();
    }
  });

  it('ciało odpowiedzi: przyjęcie, powtórka z `replayed`, konflikt 409 z własnym kodem', async () => {
    const r = await open();
    const api = await serve(r.manager);
    try {
      const path = `/api/sessions/${r.id}/messages`;
      const first = await api.post(path, { text: 'raz', clientMessageId: CID });
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ ok: true, clientMessageId: CID });

      const again = await api.post(path, { text: 'raz', clientMessageId: CID });
      expect(again.status).toBe(202);
      expect(await again.json()).toEqual({ ok: true, clientMessageId: CID, replayed: true });

      const conflict = await api.post(path, { text: 'dwa', clientMessageId: CID });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({
        error: CLIENT_ID_CONFLICT_ERROR, message: CLIENT_ID_CONFLICT_MESSAGE,
        messageRef: { code: 'session.client-id-conflict' },
      });
      expect(r.driver.sent).toEqual(['raz']);
    } finally {
      await api.close();
    }
  });

  it('bez identyfikatora odpowiedź `{ ok: true }`; identyfikator spoza UUID → 400 bez wysyłki', async () => {
    const r = await open();
    const api = await serve(r.manager);
    try {
      const path = `/api/sessions/${r.id}/messages`;
      const plain = await api.post(path, { text: 'bez id' });
      expect(plain.status).toBe(202);
      expect(await plain.json()).toEqual({ ok: true });

      const bad = await api.post(path, { text: 'zły id', clientMessageId: 'nie-uuid' });
      expect(bad.status).toBe(400);
      expect(r.driver.sent).toEqual(['bez id']);
    } finally {
      await api.close();
    }
  });
});
