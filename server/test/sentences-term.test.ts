/**
 * Tabela przypadków: zdania terminala (ramki `err`, odmowy rejestru i backendu panelowego) i własne zdania
 * serwera demo powstają przez `say()`. Każdy przypadek idzie drogą produkcyjną (rejestr, backend herdr na atrapie
 * gniazda, gniazdo WS, trasy demo) i sprawdza `ref.code`, argumenty i angielski `text` rejestru. Odpowiedzi demo
 * z pominięciem `errorBodyOf` (405 i 503 diffa) strażnik pochodzenia nie widzi, więc tu jest ich jedyna bramka.
 *
 * Sandbox: część przypadków woła `listen()`, więc w sandboksie Claude Code plik idzie poza nim.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, TERM_SLOTS_MAX } from '@rarog/shared';
import type { ServerSystem } from '@rarog/shared/rest';
import { SENTENCES, isServerSentence, say } from '@rarog/shared/sentences';
import type { AnyText, SentenceCode, SentenceRef } from '@rarog/shared/sentences';
import { loadConfig } from '../src/config.ts';
import type { RarogConfig } from '../src/config.ts';
import type { Logger } from '../src/router.ts';
import { createRouter } from '../src/router.ts';
import { createManager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import type { HerdrLaunchClient } from '../src/herdr/types.ts';
import { termPaneLabel } from '../src/herdr/provenance.ts';
import type { HerdrPaneInfo } from '../src/herdr/types.ts';
import { RAROG_TERM_TOKEN, createHerdrBackend } from '../src/term/herdr-backend.ts';
import { TermRegistry } from '../src/term/registry.ts';
import type { TermClient } from '../src/term/registry.ts';
import { termIdFor } from '../src/term/lifecycle.ts';
import { createTermFeature } from '../src/term/index.ts';
import type {
  TermBackend, TermBackendSession, TermEventFrame, TermHistory, TermReconcileResult, TermSessionHandle, TermStream,
  TermStreamOptions,
} from '../src/term/backend.ts';
import { createMockHerdr, DEMO_LAUNCH_MIN_INTERVAL_MS, DEMO_MAX_PANES } from '../src/demo/mock-herdr.ts';
import { createDemoControl } from '../src/demo/control.ts';
import { createDemoNotes, DEMO_NOTE_CWD } from '../src/demo/notes.ts';
import { NotesFailure } from '../src/notes/store.ts';
import { MockDriver } from '../src/drivers/mock-driver.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import { FakeController, FakeHerdr } from './fake-term-herdr.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';

const silent: Logger = { info: () => {}, error: () => {} };
const CWD = '/Users/testowy/Projects/rarog';
const ORIGIN = 'http://127.0.0.1:18998';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length > 0) await cleanup.pop()?.();
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
};

/** Oczekiwane zdanie: kod, argumenty i angielski tekst rejestru (`say` z tymi samymi argumentami). */
function expected(code: SentenceCode, args?: Record<string, unknown>): { text: string; ref: SentenceRef } {
  const sentence = (say as (c: string, a?: Record<string, unknown>) => { text: string; ref: SentenceRef })(code, args);
  return { text: sentence.text, ref: sentence.ref };
}

/** Zdanie z kodem: marka `say()`, `ref` i tekst. */
function expectSentence(value: AnyText | undefined, code: SentenceCode, args?: Record<string, unknown>): void {
  expect(isServerSentence(value), `${code}: źródło ma być zdaniem z say()`).toBe(true);
  expect({ text: value?.text, ref: (value as { ref?: SentenceRef } | undefined)?.ref }).toEqual(expected(code, args));
}

/** Ramka `err` z kodem: `msg` = angielski tekst, `msgRef` = ref zdania. */
function errOf(code: SentenceCode, args?: Record<string, unknown>): { t: 'err'; msg: string; msgRef: SentenceRef } {
  const e = expected(code, args);
  return { t: 'err', msg: e.text, msgRef: e.ref };
}

async function waitUntil(what: string, predicate: () => boolean): Promise<void> {
  for (let round = 0; round < 400; round += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`nie doczekano: ${what}`);
}

// ---------------------------------------------------------------------------
// Rejestr terminali (atrapa backendu)
// ---------------------------------------------------------------------------

class FakeStream implements TermStream {
  constructor(readonly opts: TermStreamOptions) {}
  write(): void {}
  resize(): void {}
  scroll(): void {}
  refresh(): void {}
  pause(): void {}
  resume(): void {}
  release(): void {}
}

class FakeBackend implements TermBackend {
  readonly respawnOnAttach = false;
  readonly streams: FakeStream[] = [];
  historyError: Error | null = null;
  refusal(): null { return null; }
  ensureSession(id: string): Promise<TermSessionHandle> { return Promise.resolve({ ref: `panel-${id}`, id, fresh: true }); }
  reconcile(): Promise<TermReconcileResult> {
    return Promise.resolve({
      ran: false, confirmed: new Map(), restored: [], migrated: [], unknown: new Set(), conflicts: new Set(),
    });
  }
  dispose(): void {}
  attach(_handle: TermSessionHandle, opts: TermStreamOptions): Promise<TermStream> {
    const stream = new FakeStream(opts);
    this.streams.push(stream);
    return Promise.resolve(stream);
  }
  listSessions(): Promise<TermBackendSession[]> { return Promise.resolve([]); }
  processName(): string { return ''; }
  killSession(): Promise<void> { return Promise.resolve(); }
  refreshSession(): Promise<boolean> { return Promise.resolve(true); }
  readHistory(): Promise<TermHistory> {
    return this.historyError === null ? Promise.resolve({ text: '', truncated: false }) : Promise.reject(this.historyError);
  }
}

class FakeClient implements TermClient {
  readonly events: TermEventFrame[] = [];
  sendData(): void {}
  sendEvent(frame: TermEventFrame): void { this.events.push(frame); }
  bufferedAmount(): number { return 0; }
  terminate(): void {}
}

function registryOf(opts: { termMax?: number; realPath?: (p: string) => string; system?: ServerSystem } = {}) {
  const backend = new FakeBackend();
  const config = loadConfig({
    RAROG_DEMO: '1', RAROG_TERM: '1', RAROG_TERM_MAX: String(opts.termMax ?? 4),
    RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
  });
  const registry = new TermRegistry({
    config, logger: silent, backend, realPath: opts.realPath ?? ((p) => p),
    setTimer: () => ({ unref: () => {} }) as unknown as NodeJS.Timeout, clearTimer: () => {},
    ...(opts.system === undefined ? {} : { system: opts.system }),
  });
  cleanup.push(() => { registry.dispose(); });
  return { registry, backend };
}

describe('odmowy rejestru terminali mówią zdaniem z kodem', () => {
  it('term.shutting-down: `open` po `dispose`', () => {
    const { registry } = registryOf();
    registry.dispose();
    const result = registry.open(CWD);
    expect(result.ok).toBe(false);
    if (!result.ok) expectSentence(result.sentence, 'term.shutting-down');
  });

  it('term.dir-unreadable: katalog, którego nie da się rozwiązać', () => {
    const { registry } = registryOf({ realPath: () => { throw new Error('ENOENT'); } });
    const result = registry.open('/Users/testowy/Projects/zażółć');
    if (!result.ok) expectSentence(result.sentence, 'term.dir-unreadable');
    expect(result.ok).toBe(false);
  });

  it('term.slot-out-of-range: slot spoza 1–max, argument `max`', () => {
    const { registry } = registryOf();
    const result = registry.open(CWD, TERM_SLOTS_MAX + 1);
    if (!result.ok) expectSentence(result.sentence, 'term.slot-out-of-range', { max: TERM_SLOTS_MAX });
    expect(result.ok ? '' : result.sentence.text).toBe(`Terminal number out of range 1–${String(TERM_SLOTS_MAX)}.`);
  });

  it('term.project-limit: wszystkie sloty projektu zajęte, `max` liczbą mnogą', () => {
    const { registry } = registryOf();
    for (let slot = 1; slot <= TERM_SLOTS_MAX; slot += 1) expect(registry.open(CWD, slot).ok).toBe(true);
    const result = registry.open(CWD, 'next');
    if (!result.ok) expectSentence(result.sentence, 'term.project-limit', { max: TERM_SLOTS_MAX });
    expect(result.ok ? '' : result.sentence.text).toBe(`Limit of ${String(TERM_SLOTS_MAX)} terminals per project. Close one.`);
  });

  it('term.open-limit: sufit żywych PTY (`RAROG_TERM_MAX=1`), forma pojedyncza', async () => {
    const { registry, backend } = registryOf({ termMax: 1 });
    const first = registry.open(CWD);
    if (!first.ok) throw new Error('open nieudany');
    expect(registry.attach(first.id, new FakeClient())).toBe('ok');
    await waitUntil('spawn', () => backend.streams.length === 1);
    const result = registry.open('/Users/testowy/Projects/inny');
    if (!result.ok) expectSentence(result.sentence, 'term.open-limit', { max: 1 });
    expect(result.ok ? '' : result.sentence.text).toBe('Limit of 1 open terminal. Close one.');
  });

  it('term.not-found: historia nieznanego terminala', async () => {
    const { registry } = registryOf();
    const result = await registry.history('nie-ma', 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expectSentence(result.sentence, 'term.not-found');
  });

  it('term.history-unreadable: backend nie oddał historii', async () => {
    const { registry, backend } = registryOf();
    const opened = registry.open(CWD);
    if (!opened.ok) throw new Error('open nieudany');
    backend.historyError = new Error('gniazdo milczy');
    const result = await registry.history(opened.id, 10);
    if (!result.ok) expectSentence(result.sentence, 'term.history-unreadable');
    expect(result.ok).toBe(false);
  });

  for (const [system, code] of [['macos', 'term.not-starting.mac'], ['linux', 'term.not-starting.vps']] as const) {
    it(`${code}: bezpiecznik respawnu po trzech padach (system ${system})`, async () => {
      const { registry, backend } = registryOf({ system });
      const opened = registry.open(CWD);
      if (!opened.ok) throw new Error('open nieudany');
      let last = new FakeClient();
      for (let crash = 1; crash <= 3; crash += 1) {
        last = new FakeClient();
        expect(registry.attach(opened.id, last)).toBe('ok');
        await waitUntil(`spawn ${String(crash)}`, () => backend.streams.length === crash);
        backend.streams[crash - 1]?.opts.onExit({ detail: 'atrapa' });
      }
      expect(last.events).toEqual([errOf(code)]);
    });
  }
});

// ---------------------------------------------------------------------------
// Backend panelowy herdr (atrapa gniazda)
// ---------------------------------------------------------------------------

class ScriptedHerdr extends FakeHerdr {
  failStamp = false;
  failClose = false;
  processQueue: { pid: number; name: string; argv0: string }[][] = [];

  override reportPaneMetadata(params: Parameters<FakeHerdr['reportPaneMetadata']>[0]): Promise<void> {
    if (this.failStamp && params.tokens !== undefined) return Promise.reject(new Error('herdr: timeout'));
    return super.reportPaneMetadata(params);
  }

  override readPaneProcess(): ReturnType<FakeHerdr['readPaneProcess']> {
    const next = this.processQueue.shift();
    return next === undefined ? super.readPaneProcess() : Promise.resolve({ processes: next });
  }

  override closePane(paneId: string): Promise<void> {
    return this.failClose ? Promise.reject(new Error('herdr: pane busy')) : super.closePane(paneId);
  }
}

function backendOf(herdr: ScriptedHerdr, env: NodeJS.ProcessEnv = {}, system?: ServerSystem) {
  const dataDir = tmp('rarog-zdania-term-');
  const config: RarogConfig = loadConfig({
    RAROG_ORIGINS: 'https://rarog.example', RAROG_TERM: '1', RAROG_HERDR_BIN: '/usr/bin/true',
    RAROG_HERDR_LAUNCH: '1', RAROG_HERDR_SEND: '1', RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
    RAROG_DATA_DIR: dataDir, HOME: '/Users/testowy', PATH: '/usr/bin:/bin', TMPDIR: dataDir, ...env,
  });
  const backend = createHerdrBackend({
    config, logger: silent, launchClient: (): HerdrLaunchClient => herdr,
    spawn: () => new FakeController(), setTimer: () => ({ unref: () => {} }) as unknown as NodeJS.Timeout,
    ...(system === undefined ? {} : { system }),
  });
  cleanup.push(() => { backend.dispose(); });
  return backend;
}

const ID = termIdFor(CWD);
const LAZY = termIdFor(CWD, 0, 'lazygit');
const HOST: HerdrPaneInfo = { paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', cwd: CWD, tokens: {}, label: null };
const orphan = (paneId: string, id: string): HerdrPaneInfo => ({
  paneId, tabId: `${paneId}t`, workspaceId: 'w1', cwd: CWD, tokens: {}, label: termPaneLabel(id),
});
const STALE_LAZY: HerdrPaneInfo = {
  paneId: 'w1:p5', tabId: 'w1:t5', workspaceId: 'w1', cwd: CWD, tokens: { [RAROG_TERM_TOKEN]: LAZY },
  label: termPaneLabel(LAZY),
};
const ZSH = [{ pid: 1, name: 'zsh', argv0: 'zsh' }];

/** Zdanie odmowy `ensureSession` (`TermBackendRetryError.sentence`). */
async function refusalOf(promise: Promise<unknown>): Promise<AnyText | undefined> {
  try {
    await promise;
  } catch (err: unknown) {
    return (err as { sentence?: AnyText }).sentence;
  }
  throw new Error('ensureSession przeszło bez odmowy');
}

describe('odmowy backendu panelowego herdr mówią zdaniem z kodem', () => {
  it('term.needs-launch i term.needs-send: wyłączone kanały herdr', () => {
    const launch = backendOf(new ScriptedHerdr(), { RAROG_HERDR_LAUNCH: '0' }).refusal();
    expectSentence(launch?.sentence, 'term.needs-launch');
    const send = backendOf(new ScriptedHerdr(), { RAROG_HERDR_SEND: '0' }).refusal();
    expectSentence(send?.sentence, 'term.needs-send');
  });

  it('term.recovering: etykieta bez tokenu, a stempel nie przeszedł', async () => {
    const herdr = new ScriptedHerdr();
    herdr.addPane(HOST);
    herdr.addPane(orphan('w1:p4', ID));
    herdr.failStamp = true;
    expectSentence(await refusalOf(backendOf(herdr).ensureSession(ID, CWD)), 'term.recovering');
  });

  for (const [system, code] of [['macos', 'term.label-conflict.mac'], ['linux', 'term.label-conflict.vps']] as const) {
    it(`${code}: dwa panele z etykietą tego terminala (system ${system})`, async () => {
      const herdr = new ScriptedHerdr();
      herdr.addPane(HOST);
      herdr.addPane(orphan('w1:p4', ID));
      herdr.addPane(orphan('w2:p4', ID));
      expectSentence(await refusalOf(backendOf(herdr, {}, system).ensureSession(ID, CWD)), code);
    });
  }

  it('term.lazygit-changed: panel lazygita zmienił się między odczytami', async () => {
    const herdr = new ScriptedHerdr();
    herdr.addPane(HOST);
    herdr.addPane(STALE_LAZY);
    herdr.processQueue = [ZSH, [{ pid: 7, name: 'lazygit', argv0: 'lazygit' }]];
    const sentence = await refusalOf(backendOf(herdr).ensureSession(LAZY, CWD, 'lazygit', { explicit: true }));
    expectSentence(sentence, 'term.lazygit-changed');
  });

  it('term.lazygit-close-failed: zamknięcie gołej powłoki w panelu lazygita nie przeszło', async () => {
    const herdr = new ScriptedHerdr();
    herdr.addPane(HOST);
    herdr.addPane(STALE_LAZY);
    herdr.processQueue = [ZSH, ZSH];
    herdr.failClose = true;
    const sentence = await refusalOf(backendOf(herdr).ensureSession(LAZY, CWD, 'lazygit', { explicit: true }));
    expectSentence(sentence, 'term.lazygit-close-failed');
  });
});

// ---------------------------------------------------------------------------
// Gniazdo WS terminala
// ---------------------------------------------------------------------------

describe('ramki `err` gniazda terminala', () => {
  async function feature(herdr: ScriptedHerdr) {
    const root = tmp('rarog-zdania-term-ws-');
    const project = join(root, 'rarog');
    const { mkdirSync, realpathSync } = await import('node:fs');
    mkdirSync(project);
    const config = loadConfig({
      RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: realpathSync(root), RAROG_TERM: '1', RAROG_TERM_MAX: '1',
      RAROG_HERDR_LAUNCH: '1', RAROG_HERDR_SEND: '1', RAROG_HERDR_BIN: '/usr/bin/true',
      RAROG_DATA_DIR: join(root, '.dane'), HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root,
    });
    const device = createTestDevice(config.dataDir, { epoch: config.epoch });
    const term = await createTermFeature(config, silent, {
      devices: device.store, herdrLaunchClient: () => herdr, herdrSpawn: () => new FakeController(),
    });
    if (term === null) throw new Error('createTermFeature oddało null');
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('upgrade', (req, socket, head) => { term.handleUpgrade(req, socket, head); });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const sockets: WebSocket[] = [];
    cleanup.push(async () => {
      for (const ws of sockets) ws.terminate();
      term.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    });
    const base = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    /** Pierwsza ramka tekstowa po `hello` (albo zamiast niego) — szukana ramka `err`. */
    const errFrameOf = (id: string): Promise<unknown> => new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base}/api/term/${id}?fresh=1&c=80&r=24`, {
        headers: { ...device.headers, Origin: ORIGIN },
      });
      sockets.push(ws);
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const frame = JSON.parse(data.toString('utf8')) as { t?: string };
        if (frame.t === 'err') resolve(frame);
      });
      ws.on('error', reject);
    });
    const connect = (id: string): Promise<WebSocket> => new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base}/api/term/${id}?fresh=1&c=80&r=24`, {
        headers: { ...device.headers, Origin: ORIGIN },
      });
      sockets.push(ws);
      ws.on('open', () => { resolve(ws); });
      ws.on('error', reject);
    });
    return { term, project: realpathSync(project), device, errFrameOf, connect };
  }

  it('term.attach-limit: drugi żywy strumień ponad `RAROG_TERM_MAX=1`', async () => {
    const herdr = new ScriptedHerdr();
    const f = await feature(herdr);
    const first = f.term.open(f.project);
    const second = f.term.open(f.project, 'next');
    if (!first.ok || !second.ok) throw new Error('open nieudany');
    await f.connect(first.id);
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    expect(await f.errFrameOf(second.id)).toEqual(errOf('term.attach-limit'));
  });

  it('term.attach-failed: wpis `failed` (odmowa backendu) przy podpięciu', async () => {
    const herdr = new ScriptedHerdr();
    const f = await feature(herdr);
    const id = termIdFor(f.project);
    herdr.addPane({ ...HOST, cwd: f.project });
    herdr.addPane({ ...orphan('w1:p4', id), cwd: f.project });
    herdr.addPane({ ...orphan('w2:p4', id), cwd: f.project });
    const opened = f.term.open(f.project);
    if (!opened.ok) throw new Error('open nieudany');
    // Pierwsze gniazdo dostaje odmowę backendu (konflikt etykiet), wpis przechodzi w `failed`.
    expect(await f.errFrameOf(opened.id)).toMatchObject({ t: 'err' });
    expect(await f.errFrameOf(opened.id)).toEqual(errOf('term.attach-failed'));
  });

  it('rest.device-revoked: odpięcie urządzenia zamyka jego terminal ramką `err`', async () => {
    const herdr = new ScriptedHerdr();
    const f = await feature(herdr);
    const opened = f.term.open(f.project);
    if (!opened.ok) throw new Error('open nieudany');
    // Odpięcie dopiero po przyjęciu gniazda (`open` = upgrade po uwierzytelnieniu), bez wyścigu z handshake.
    const ws = await f.connect(opened.id);
    const frame = new Promise<unknown>((resolve) => {
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const parsed = JSON.parse(data.toString('utf8')) as { t?: string };
        if (parsed.t === 'err') resolve(parsed);
      });
    });
    f.device.store.revoke(f.device.id, 'admin');
    f.term.closeOwner(f.device.id);
    expect(await frame).toEqual(errOf('rest.device-revoked'));
  });
});

// ---------------------------------------------------------------------------
// Serwer demo
// ---------------------------------------------------------------------------

describe('własne zdania serwera demo', () => {
  async function demo() {
    const dataDir = tmp('rarog-zdania-demo-');
    const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dataDir, RAROG_ORIGINS: ORIGIN });
    const device = createTestDevice(dataDir, { epoch: config.epoch });
    const mock = createMockHerdr(demoContentPl);
    const manager = await createManager({
      ...config, demoContent: demoContentPl, herdrSupervisor: mock.supervisor, herdrDeps: mock.deps,
    });
    await manager.ready;
    const notes = createDemoNotes(demoContentPl);
    const hub = new SseHub({
      manager, serverStartId: 'e2-term', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      notesFor: (cwds) => notes.withNotes(cwds),
    });
    hub.start();
    const router = createRouter({
      config, manager, hub, serverStartId: 'e2-term', startedAtMs: Date.now(), logger: silent, notes,
      devices: device.identity,
    });
    const control = createDemoControl(router, config, manager, mock.scenarioPanels, { store: notes, announce: () => {} });
    const server = http.createServer(control.handler);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    cleanup.push(async () => {
      control.dispose();
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await manager.dispose();
      mock.dispose();
    });
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const configure = async (body: Record<string, unknown>): Promise<void> => {
      const res = await fetch(`${base}/api/demo/control`, {
        method: 'POST', body: JSON.stringify({ action: 'configure', ...body }),
        headers: { Origin: ORIGIN, 'X-Rarog-Demo-Token': 'demo', 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);
    };
    const seed = manager.list()[0]?.id;
    if (seed === undefined) throw new Error('demo bez sesji');
    const get = (path: string) => fetch(`${base}/api/sessions/${seed}/${path}`, { headers: device.headers });
    return { configure, get };
  }

  it('rest.method-not-allowed i rest.diff-git-failed: trasy diffa w trybie `outdated` i `fail`', async () => {
    const d = await demo();
    await d.configure({ diffList: 'outdated' });
    const outdated = await d.get('diff/files');
    expect(outdated.status).toBe(405);
    const e405 = expected('rest.method-not-allowed');
    expect(await outdated.json()).toEqual({ error: 'method-not-allowed', message: e405.text, messageRef: e405.ref });

    await d.configure({ diffList: 'pass', diffFile: 'fail' });
    const failed = await d.get('diff/file?path=src%2Fnotes.ts');
    expect(failed.status).toBe(503);
    const e503 = expected('rest.diff-git-failed');
    expect(await failed.json()).toEqual({ error: 'git-failed', message: e503.text, messageRef: e503.ref });
  });

  it('demo.unauthorized: demo odrzuca klucz urządzenia', async () => {
    const d = await demo();
    await d.configure({ unauthorized: true });
    const res = await d.get('diff/files');
    expect(res.status).toBe(401);
    const e = expected('demo.unauthorized');
    expect(await res.json()).toEqual({ error: 'unauthorized', message: e.text, messageRef: e.ref });
  });

  it('demo.launch-throttled, demo.pane-cap i demo.pane-not-found: atrapa herdr', async () => {
    const mock = createMockHerdr(demoContentPl);
    cleanup.push(() => { mock.dispose(); });
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const launch = () => mock.supervisor.launch({ cwd: '/Users/demo/Projects/rarog' } as never);
    await launch();
    expectSentence(await refusalOf(launch()), 'demo.launch-throttled');
    for (let n = 1; n < DEMO_MAX_PANES; n += 1) {
      now += DEMO_LAUNCH_MIN_INTERVAL_MS;
      await launch().catch(() => {});
    }
    now += DEMO_LAUNCH_MIN_INTERVAL_MS;
    expectSentence(await refusalOf(launch()), 'demo.pane-cap');
    expectSentence(await refusalOf(mock.supervisor.closeTab('w0:nie-ma')), 'demo.pane-not-found');
  });

  it('rest.notes-conflict: notatki demo zmienione na innym urządzeniu', () => {
    const notes = createDemoNotes(demoContentPl);
    let failure: unknown;
    try {
      notes.write(DEMO_NOTE_CWD, 'nowe', 1);
    } catch (err: unknown) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(NotesFailure);
    expectSentence((failure as NotesFailure).sentence, 'rest.notes-conflict');
  });
});

// ---------------------------------------------------------------------------
// Atrapa silnika (mock-driver)
// ---------------------------------------------------------------------------

class ManualScheduler implements Scheduler {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + ms, fn });
    return id;
  }
  clearTimeout(handle: TimerHandle): void { this.#timers.delete(handle as number); }
  now(): number { return this.#now; }
  tick(ms: number): void {
    this.#now += ms;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at > this.#now) continue;
      this.#timers.delete(id);
      timer.fn();
    }
  }
}

function collect(driver: { events: AsyncIterable<DriverEvent> }): DriverEvent[] {
  const events: DriverEvent[] = [];
  void (async () => { for await (const event of driver.events) events.push(event); })();
  return events;
}

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

describe('zdania atrapy silnika', () => {
  it('demo.would-send: komenda sterująca w demo, argument `command` dosłownie', async () => {
    const driver = new MockDriver({
      content: demoContentPl, cwd: '/x', scenario: { kind: 'idle' }, scheduler: new ManualScheduler(),
    });
    const events = collect(driver);
    driver.sendCommands(['/model zażółć']);
    await flush();
    const message = events.find((event) => event.type === 'message');
    const block = message?.type === 'message' ? message.blocks[0] : undefined;
    expectSentence(block?.type === 'text' ? block.text : undefined, 'demo.would-send', { command: '/model zażółć' });
    expect(block?.type === 'text' ? block.text.text : '').toBe('Demo: Rarog would send `/model zażółć` to the pane.');
    driver.dispose();
  });

  it('state.driver-error: symulowana awaria silnika kończy się zdaniem rejestru', async () => {
    const scheduler = new ManualScheduler();
    const driver = new MockDriver({ content: demoContentPl, cwd: '/x', scenario: { kind: 'idle' }, scheduler });
    const events = collect(driver);
    scheduler.tick(0);
    await flush();
    void driver.send('pokaż błąd');
    scheduler.tick(60_000);
    await flush();
    const exit = events.find((event) => event.type === 'exit');
    expect(exit).toMatchObject({ type: 'exit', ok: false });
    expectSentence(exit?.type === 'exit' ? exit.reason : undefined, 'state.driver-error');
    driver.dispose();
  });
});

/** Kody tej tabeli: każdy kod z rejestru (literał dla skryptu pokrycia). */
it('każdy kod tabeli jest w rejestrze', () => {
  const codes: SentenceCode[] = [
    'rest.diff-git-failed', 'rest.method-not-allowed', 'term.not-found', 'term.recovering', 'term.label-conflict.mac',
    'term.label-conflict.vps', 'term.lazygit-changed', 'term.lazygit-close-failed', 'term.needs-launch',
    'term.needs-send', 'term.shutting-down', 'term.dir-unreadable', 'term.slot-out-of-range', 'term.project-limit',
    'term.open-limit', 'term.history-unreadable', 'term.not-starting.mac', 'term.not-starting.vps',
    'term.attach-limit', 'term.attach-failed', 'demo.unauthorized', 'demo.launch-throttled', 'demo.pane-cap',
    'demo.pane-not-found', 'demo.would-send', 'rest.device-revoked', 'rest.notes-conflict', 'state.driver-error',
  ];
  for (const code of codes) expect(Object.hasOwn(SENTENCES, code), code).toBe(true);
});
