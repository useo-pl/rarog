/**
 * Karty kanału zgód w managerze i przez REST (warstwa 1): prawdziwy cykl (`layer1/cycle.ts`) z prawdziwym
 * rejestrem w katalogu z `$TMPDIR`, prawdziwy manager i router na porcie efemerycznym, atrapy nadzorcy i drivera herdr.
 *
 * Kontrakt apki: decyzja i zwolnienie jadą tym samym `POST …/permissions/:permId`; 200 = przyjęte, 409 `too-late` =
 * hook już nie czeka, 410 = karta wygasła, inne 409 i 422 = odmowa ze zdaniem serwera. Karta kanału nie idzie do
 * drivera: ani cyfry, ani klawisza zgody. `release` wolno wyłącznie na karcie `channel: 'hook'`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { HerdrStatus, PermissionRequest, ServerEvent } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import { consentManagerCards } from '../src/bootstrap/consent.ts';
import { HERDR_ATTACH_CONCURRENCY, loadConfig } from '../src/config.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_MARKERS_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_DIRNAME, CONSENT_HOLDING_STATES, CONSENT_RECORDS_DIRNAME, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentCycle, ConsentCycleIo } from '../src/herdr/dialogs/layer1/cycle.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { createRouter } from '../src/router.ts';
import type { Logger } from '../src/router.ts';
import { BadRequestError, BadStateError, createManager } from '../src/sessions/manager.ts';
import type { ConsentManagerChannel, HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';
import { createCycleWithRead } from './helpers/dowod-z-odczytem.ts';

const PROJECT = '/Users/u/Projects/atlas';
const ENGINE = '11111111-1111-4111-8111-111111111111';
const PROMPT = '22222222-2222-4222-8222-222222222222';
const KEY = 'w9:p72';
/** Drugi panel tej samej rozmowy (wznowienie w nowym panelu). */
const KEY_NEXT = 'w9:p80';
/** Panel herdr rozmowy {@link ENGINE}: klucz i tab. */
interface Pane {
  readonly key: string;
  readonly tabId: string;
}
/** Trzeci panel tej samej rozmowy (kolejne wznowienie). */
const THIRD: Pane = { key: 'w9:p81', tabId: 'w9:t5' };
const BOOT = 'boot-karty-1';
const ORIGIN = 'http://localhost:8930';
const silentLogger: Logger = { info: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Atrapy herdr
// ---------------------------------------------------------------------------

class FakeDriver extends AtrapaDrivera {
  #failure: Error | null = null;

  /** Każda decyzja, która doszła do drivera: przy karcie kanału lista ma zostać pusta. */
  get decisions(): string[] {
    return this.calls.flatMap((call) => (call.method === 'respondPermission' ? [call.decision] : []));
  }

  /** Strumień zdarzeń; po {@link fail} kończy się wyjątkiem (`#failSession` managera). */
  override get events(): AsyncIterable<DriverEvent> {
    const queue = this.queue;
    const failure = (): Error | null => this.#failure;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of queue) yield event;
        const error = failure();
        if (error !== null) throw error;
      },
    };
  }

  fail(error: Error): void {
    this.#failure = error;
    this.queue.close();
  }
}

class FakeSupervisor extends AtrapaNadzorcy<FakeDriver> {
  readonly live = new Map<string, HerdrAgent>();
  closedTabs = 0;
  /** Krok w trakcie zamykania tabu (driver karty już odpięty), przed wynikiem `closeTab`. */
  closing: (() => Promise<void>) | null = null;
  /** Błąd `closeTab` (np. `herdr-gone`: panelu już nie ma). */
  closeError: Error | null = null;
  /** `false` = gniazdo herdr niedostępne (`status().available`). */
  available = true;
  /** Sesje silnika w świeżym `agent.list` (`liveEngineSessions`), np. panel ukryty tej samej rozmowy. */
  readonly liveEngines = new Set<string>();
  /** Błąd odczytu `agent.list` w `liveEngineSessions`. */
  liveError: Error | null = null;
  /** Krok w trakcie odczytu `agent.list`: po migawce sesji silnika, przed odpowiedzią. */
  liveReading: (() => Promise<void>) | null = null;
  /** Liczba odczytów `agent.list` (`liveEngineSessions`). */
  liveReads = 0;
  /** Panele, których driver po podpięciu milczy: slot podpięcia managera trzyma wtedy dopiero sufit czasu. */
  readonly silent = new Set<string>();

  constructor(readonly ownsProcess = false) {
    super();
  }

  override status(): HerdrStatus {
    return { available: this.available, agentCount: 0, readOnly: false, canLaunch: true };
  }

  protected nowyDriver(key: string): FakeDriver {
    const driver = new FakeDriver(key, { ownsProcess: this.ownsProcess });
    if (!this.silent.has(key)) driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    return driver;
  }

  override async closeTab(): Promise<void> {
    this.closedTabs += 1;
    await this.closing?.();
    if (this.closeError !== null) throw this.closeError;
  }

  agentFor(key: string): HerdrAgent | undefined {
    return this.live.get(key);
  }

  override async liveEngineSessions(): Promise<ReadonlySet<string>> {
    this.liveReads += 1;
    // Odpowiedź opisuje panele z chwili odczytu: panel, który pojawi się w trakcie, w niej nie stoi.
    const live = new Set(this.liveEngines);
    if (this.liveReading !== null) await this.liveReading();
    if (this.liveError !== null) throw this.liveError;
    return live;
  }

  appear(agent: HerdrAgent): void {
    this.live.set(agent.key, agent);
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function makeDeps(): HerdrManagerDeps {
  const aliases = new Map<string, string>();
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: (engine) => aliases.get(engine),
    rememberAlias: (engine, id) => { aliases.set(engine, id); },
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

function makeAgent(inScope = true): HerdrAgent {
  return {
    key: KEY, paneId: KEY, agentSessionId: ENGINE, engine: 'claude', termId: null, cwd: PROJECT, status: 'idle',
    title: 's3-back', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
}

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

// ---------------------------------------------------------------------------
// Kanał: zrzut, rejestracja, pliki
// ---------------------------------------------------------------------------

function dumpOf(seed: string, toolInput: unknown = { command: 'npm test' }): HookCallDump {
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const startedAt = Date.now() - 1_000;
  return {
    key: `${PROMPT}-${nonce}`, sessionId: ENGINE, promptId: PROMPT, pid: process.pid, startedAt, toolName: 'Bash',
    toolInput, cwd: PROJECT, at: startedAt + 100, inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
  };
}

function register(reg: ConsentRegistry, dump: HookCallDump): void {
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd, agentId: null,
    permissionMode: dump.permissionMode ?? null,
  });
  const outcome = reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256, cardSha256,
    pid: dump.pid, startedAt: dump.startedAt,
  });
  expect(outcome.status).toBe(200);
}

/** Decyzja w pliku odpowiedzi dla hooka albo `null`, gdy pliku nie ma. */
function answerOf(dir: string, key: string): string | null {
  const file = join(dir, CONSENT_DIRNAME, ENGINE, `${key}.json`);
  if (!existsSync(file)) return null;
  return (JSON.parse(readFileSync(file, 'utf8')) as { decision: string }).decision;
}

// ---------------------------------------------------------------------------

interface Harness {
  readonly dir: string;
  readonly base: string;
  readonly auth: string;
  readonly manager: Manager;
  readonly driver: FakeDriver;
  readonly supervisor: FakeSupervisor;
  readonly cycle: ConsentCycle;
  readonly reg: ConsentRegistry;
  readonly id: string;
  readonly events: ServerEvent[];
  /** Sesje silnika z portu `turnEnded`, w kolejności wywołań. */
  readonly turnEnds: string[];
  /** Sesje silnika z portu `ended` (koniec rozmowy: pula i znaczniki prośby), w kolejności wywołań. */
  readonly ends: string[];
  /** Linie logu managera. */
  readonly logs: string[];
  /** `true` = zmiany kart z cyklu nie dochodzą do managera (jak `recover()` przed managerem w `index.ts`). */
  muted: boolean;
  close(): Promise<void>;
}

interface StartOptions {
  io?: Partial<ConsentCycleIo>;
  throwOnDecide?: boolean;
  /** `false` = panel spoza korzeni (`outOfScope`). */
  inScope?: boolean;
  /** `false` = `RAROG_HERDR_SEND=0`. */
  herdrSend?: boolean;
  /** Driver właścicielem procesu (koniec strumienia i wyjątek = koniec silnika). */
  ownsProcess?: boolean;
  /** Odzyskanie rekordów z katalogu danych przed managerem (restart serwera, jak `index.ts`). */
  recover?: boolean;
  /** Port `retire` odrzuca (zapis pola zdjęcia padł). */
  retireError?: Error;
}

/**
 * Port `turnEnded` jak w `index.ts`, bez transkryptu: tura sesji bez dowodów, zamknięta wymuszonym końcem.
 */
async function forcedTurnEnd(cycle: ConsentCycle, engine: string): Promise<void> {
  for (const target of cycle.evidenceTargets()) {
    if (target.sessionId !== engine) continue;
    await cycle.applyTurn(engine, target.promptId, {
      promptId: target.promptId, ended: false, partial: true, toolUses: [], results: [],
    }, true);
  }
}

describe('karty kanału zgód w managerze i przez REST', () => {
  const closers: (() => Promise<void>)[] = [];
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-karty-kanalu-'));
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(options: StartOptions = {}): Promise<Harness> {
    const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [ENGINE], log: () => {} });
    reg.setScope('main');
    let managerRef: Manager | null = null;
    const gate = { muted: false };
    const turnEnds: string[] = [];
    const ends: string[] = [];
    const cycle: ConsentCycle = createCycleWithRead({
      dataDir: dir, bootId: BOOT, registry: reg,
      onCard: (view) => {
        if (gate.muted) return;
        managerRef?.applyConsentCard?.(view, cycle.record(view.sessionId, view.permId)?.decision ?? null);
      },
      ...(options.io === undefined ? {} : { io: options.io }),
    });
    if (options.recover === true) await cycle.recover();
    // Port jak w `index.ts`: karta zdjęta na końcu sesji niesie znacznik z rekordu cyklu.
    const consent: ConsentManagerChannel = {
      cards: (engine) => consentManagerCards(cycle, engine),
      decide: (engine, permId, decision) => {
        if (options.throwOnDecide === true) throw new Error('cykl padł');
        return cycle.decide(engine, permId, decision);
      },
      release: (engine, permId) => cycle.release(engine, permId),
      revoke: (engine, cause) => cycle.revokeSession(engine, cause),
      retire: async (engine, permId) => {
        if (options.retireError !== undefined) throw options.retireError;
        await cycle.retire(engine, permId);
      },
      turnEnded: (engine) => {
        turnEnds.push(engine);
        return forcedTurnEnd(cycle, engine);
      },
      reattached: async (engines) => {
        await Promise.all(engines.map((engine) => cycle.markReattached(engine)));
      },
      ended: (engine) => {
        ends.push(engine);
        cycle.endPool(engine);
      },
    };
    const supervisor = new FakeSupervisor(options.ownsProcess === true);
    const logs: string[] = [];
    const manager = await createManager({
      demo: false, dataDir: dir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: makeDeps(), herdrRoots: [PROJECT],
      herdrSend: options.herdrSend ?? true, consent, logger: (line) => { logs.push(line); },
    });
    await manager.ready;
    managerRef = manager;
    const events: ServerEvent[] = [];
    manager.onEvent((_scope, _seq, event) => { events.push(event); });
    supervisor.appear(makeAgent(options.inScope ?? true));
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');

    const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: join(dir, 'router') });
    const device = createTestDevice(config.dataDir, { epoch: config.epoch });
    const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
    hub.start();
    const server = http.createServer(createRouter({
      config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now() - 5_000, logger: silentLogger,
      devices: device.identity,
    }));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const { port } = server.address() as AddressInfo;
    const close = async (): Promise<void> => {
      hub.closeAll();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await manager.dispose();
      supervisor.dispose();
    };
    closers.push(close);
    return {
      dir, base: `http://127.0.0.1:${String(port)}`, auth: device.authorization, manager, driver: supervisor.driver(KEY),
      supervisor, cycle, reg, id, events, turnEnds, ends, logs, close,
      get muted() { return gate.muted; },
      set muted(value: boolean) { gate.muted = value; },
    };
  }

  /** Decyzja z urządzenia przez adres karty `sessionId` (karta tej sesji albo inna karta tej samej rozmowy). */
  async function decideAt(
    h: Harness, sessionId: string, permId: string, decision: string,
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${h.base}/api/sessions/${sessionId}/permissions/${encodeURIComponent(permId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: h.auth, Origin: ORIGIN },
      body: JSON.stringify({ decision }),
    });
    return { status: res.status, body: await res.json() as unknown };
  }

  function decide(h: Harness, permId: string, decision: string): Promise<{ status: number; body: unknown }> {
    return decideAt(h, h.id, permId, decision);
  }

  async function card(
    h: Harness, seed: string, signal: 'standing' | 'unknown' = 'standing', driver: FakeDriver = h.driver,
  ): Promise<HookCallDump> {
    // Panel staje na dialogu (`agent-state: blocked`) przed kartą, jak na żywo.
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    const dump = dumpOf(seed);
    register(h.reg, dump);
    await h.cycle.observe(ENGINE, dump.key, signal, dump);
    await flush();
    return dump;
  }

  function channelCards(h: Harness, sessionId: string = h.id): PermissionRequest[] {
    return h.manager.transcript(sessionId).pendingPermissions.filter((p) => p.channel === 'hook');
  }

  it('karta kanału idzie zdarzeniem i snapshotem raz, z adresem sesji Raroga; `allow` = plik dla hooka, 0 klawiszy', async () => {
    const h = await start();
    const dump = await card(h, 'allow');
    const pending = h.events.filter((e) => e.type === 'permission-pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      request: { permId: dump.key, sessionId: h.id, channel: 'hook', canAllow: true, state: 'pending' },
    });
    expect(channelCards(h)).toHaveLength(1);
    expect(h.manager.list().find((s) => s.id === h.id)?.state).toBe('waiting-permission');

    expect(await decide(h, dump.key, 'allow')).toMatchObject({ status: 200 });
    await flush();
    expect(answerOf(h.dir, dump.key)).toBe('allow');
    expect(h.driver.decisions).toEqual([]);
    // Reconnect w trakcie `sent`: snapshot niesie kartę raz, w bieżącym stanie.
    expect(channelCards(h)).toEqual([expect.objectContaining({ permId: dump.key, state: 'sent', canAllow: false })]);
    expect(h.events.some((e) => e.type === 'permission-settled')).toBe(true);
    // Druga decyzja o tej samej karcie: 409 `conflict` (decyzja zapadła), plik bez zmiany.
    expect(await decide(h, dump.key, 'deny')).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(answerOf(h.dir, dump.key)).toBe('allow');
  });

  it('`allow-always` na karcie kanału = 422 bez pliku; `allow` bez `canAllow` = 409 `card-changed`, `deny` przechodzi', async () => {
    const h = await start();
    const always = await card(h, 'always');
    expect(await decide(h, always.key, 'allow-always')).toMatchObject({ status: 422, body: { error: 'allow-always' } });
    expect(answerOf(h.dir, always.key)).toBeNull();

    const blind = await card(h, 'bez-dowodu', 'unknown');
    expect(channelCards(h).find((p) => p.permId === blind.key)).toMatchObject({ canAllow: false });
    expect(await decide(h, blind.key, 'allow')).toMatchObject({ status: 409, body: { error: 'card-changed' } });
    expect(answerOf(h.dir, blind.key)).toBeNull();
    expect(await decide(h, blind.key, 'deny')).toMatchObject({ status: 200 });
    expect(answerOf(h.dir, blind.key)).toBe('deny');
    expect(h.driver.decisions).toEqual([]);
  });

  it('`release` na karcie kanału: 200 i podpisany `release`; po przejęciu odpowiedzi przez hook 409 `release-taken`', async () => {
    const h = await start();
    const free = await card(h, 'release');
    expect(await decide(h, free.key, 'release')).toMatchObject({ status: 200 });
    expect(answerOf(h.dir, free.key)).toBe('release');

    const taken = await card(h, 'release-po-przejeciu');
    expect(await decide(h, taken.key, 'allow')).toMatchObject({ status: 200 });
    const base = join(h.dir, CONSENT_DIRNAME, ENGINE, taken.key);
    renameSync(`${base}.json`, `${base}.claimed`);
    await h.cycle.tick();
    expect(h.cycle.record(ENGINE, taken.key)?.state).toBe('claimed');
    expect(await decide(h, taken.key, 'release')).toMatchObject({ status: 409, body: { error: 'release-taken' } });
    expect(h.driver.decisions).toEqual([]);
  });

  it('`release` poza kartą kanału = 422 bez klawisza: karta z ekranu i dialog adresowany sesją', async () => {
    const h = await start();
    h.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    h.driver.queue.push({
      type: 'permission-request', reqId: 'tool-1', toolName: 'Bash', input: { command: 'ls' }, displayText: 'ls',
    });
    await flush();
    const screen = h.manager.transcript(h.id).pendingPermissions.find((p) => p.channel !== 'hook');
    expect(screen).toBeDefined();
    expect(await decide(h, screen?.permId ?? '', 'release')).toMatchObject({ status: 422, body: { error: 'not-channel' } });
    const res = await fetch(`${h.base}/api/sessions/${h.id}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: h.auth, Origin: ORIGIN },
      body: JSON.stringify({ decision: 'release' }),
    });
    expect(res.status).toBe(422);
    expect(h.driver.decisions).toEqual([]);
  });

  it('nieznana karta = 410; błąd zapisu i wyjątek cyklu = 422, nigdy zgoda', async () => {
    const h = await start({ io: { writeFile: () => { throw new Error('pełny dysk'); } } });
    expect(await decide(h, `${PROMPT}-${'0'.repeat(32)}`, 'allow')).toMatchObject({ status: 410 });
    const dump = await card(h, 'zapis-pada');
    expect(await decide(h, dump.key, 'allow')).toMatchObject({ status: 422, body: { error: 'write-failed' } });
    expect(answerOf(h.dir, dump.key)).toBeNull();
    expect(channelCards(h)).toEqual([expect.objectContaining({ permId: dump.key, state: 'pending' })]);

    await h.close();
    closers.splice(0);
    const t = await start({ throwOnDecide: true });
    const other = await card(t, 'cykl-rzuca');
    expect(await decide(t, other.key, 'allow')).toMatchObject({ status: 422, body: { error: 'send-failed' } });
    expect(answerOf(t.dir, other.key)).toBeNull();
    expect(t.driver.decisions).toEqual([]);
  });

  it('przerwanie tury przy karcie `pending` = podpisany `release`, nie cyfra', async () => {
    const h = await start();
    const dump = await card(h, 'przerwanie');
    await h.manager.interrupt(h.id);
    await flush(8);
    expect(answerOf(h.dir, dump.key)).toBe('release');
    expect(h.driver.decisions).toEqual([]);
  });

  it('koniec karty z cyklu: `permission-resolved` od hooka, karta znika ze snapshotu', async () => {
    const h = await start();
    const dump = await card(h, 'koniec');
    await h.cycle.observe(ENGINE, dump.key, 'gone', dump);
    await flush();
    const resolved = h.events.filter((e) => e.type === 'permission-resolved');
    expect(resolved).toEqual([{ type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'expired', by: 'hook' }]);
    expect(channelCards(h)).toEqual([]);
    expect(h.manager.list().find((s) => s.id === h.id)?.state).toBe('running');
  });
  // -------------------------------------------------------------------------
  // Bramki zgody, końce sesji, jedna karta na dialog
  // -------------------------------------------------------------------------

  /** Decyzje we wszystkich plikach odpowiedzi `.json` sesji silnika (klucz → decyzja). */
  function answers(h: Harness): Record<string, string> {
    const base = join(h.dir, CONSENT_DIRNAME, ENGINE);
    if (!existsSync(base)) return {};
    const out: Record<string, string> = {};
    for (const name of readdirSync(base).filter((n) => n.endsWith('.json'))) {
      out[name.slice(0, -'.json'.length)] = (JSON.parse(readFileSync(join(base, name), 'utf8')) as { decision: string }).decision;
    }
    return out;
  }

  /** Karty otwarte według zdarzeń (pojawienie się minus zdjęcie), w kolejności pojawienia się. */
  function openByEvents(h: Harness): string[] {
    const open: string[] = [];
    for (const event of h.events) {
      if (event.type === 'permission-pending' && event.request.sessionId === h.id) open.push(event.request.permId);
      if (event.type === 'permission-resolved' && event.sessionId === h.id) {
        const at = open.indexOf(event.permId);
        if (at >= 0) open.splice(at, 1);
      }
    }
    return open;
  }

  function resolvedIds(h: Harness): string[] {
    return h.events.flatMap((e) => (e.type === 'permission-resolved' ? [e.permId] : []));
  }

  /** Karta z ekranu (bez kanału) w driverze sesji. */
  async function screenCard(h: Harness, reqId: string): Promise<string> {
    h.driver.queue.push({
      type: 'permission-request', reqId, toolName: 'Bash', input: { command: 'npm test' }, displayText: 'npm test',
    });
    await flush();
    return reqId;
  }

  async function sentCard(
    h: Harness, seed: string, at: { id: string; driver: FakeDriver } = { id: h.id, driver: h.driver },
  ): Promise<HookCallDump> {
    const dump = await card(h, seed, 'standing', at.driver);
    expect(await decideAt(h, at.id, dump.key, 'allow')).toMatchObject({ status: 200 });
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('sent');
    return dump;
  }

  /** Odpowiedź odebrana przez hook (`rename` na `.claimed`) i rekord `claimed` po sprawdzeniu plików. */
  async function claim(h: Harness, dump: HookCallDump): Promise<void> {
    const base = join(h.dir, CONSENT_DIRNAME, ENGINE, dump.key);
    renameSync(`${base}.json`, `${base}.claimed`);
    await h.cycle.tick();
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('claimed');
  }

  /**
   * Ta sama rozmowa (sesja silnika {@link ENGINE}) w drugim panelu (domyślnie {@link KEY_NEXT}): nowa karta Raroga,
   * wpis w indeksie pisarzy, własny driver. `agent` niesie pola panelu dla `re-attached`.
   */
  async function successor(
    h: Harness, inScope = true, pane: Pane = { key: KEY_NEXT, tabId: 'w9:t4' },
  ): Promise<{ id: string; agent: HerdrAgent }> {
    const agent: HerdrAgent = { ...makeAgent(inScope), key: pane.key, paneId: pane.key, tabId: pane.tabId };
    h.supervisor.appear(agent);
    await flush();
    const id = h.manager.list().find((s) => s.paneId === pane.key)?.id ?? '';
    expect(id).not.toBe('');
    expect(id).not.toBe(h.id);
    return { id, agent };
  }

  it('panel spoza korzeni: `allow` na karcie kanału = 400 bez pliku; `deny` i `release` przechodzą', async () => {
    const h = await start({ inScope: false });
    const denied = await card(h, 'zasieg-deny');
    expect(await decide(h, denied.key, 'allow')).toMatchObject({ status: 400 });
    expect(answerOf(h.dir, denied.key)).toBeNull();
    expect(h.cycle.record(ENGINE, denied.key)?.state).toBe('pending');
    expect(await decide(h, denied.key, 'deny')).toMatchObject({ status: 200 });
    expect(answerOf(h.dir, denied.key)).toBe('deny');
    const freed = await card(h, 'zasieg-release');
    expect(await decide(h, freed.key, 'release')).toMatchObject({ status: 200 });
    expect(answerOf(h.dir, freed.key)).toBe('release');
    expect(Object.values(answers(h))).not.toContain('allow');
    expect(h.driver.decisions).toEqual([]);
  });

  it('`RAROG_HERDR_SEND=0`: `allow` na karcie kanału = 400 bez pliku; `deny` przechodzi', async () => {
    const h = await start({ herdrSend: false });
    const dump = await card(h, 'tylko-odczyt');
    expect(await decide(h, dump.key, 'allow')).toMatchObject({ status: 400 });
    expect(answerOf(h.dir, dump.key)).toBeNull();
    expect(await decide(h, dump.key, 'deny')).toMatchObject({ status: 200 });
    expect(answerOf(h.dir, dump.key)).toBe('deny');
    expect(Object.values(answers(h))).not.toContain('allow');
    expect(h.driver.decisions).toEqual([]);
  });

  it('`release` na nieznanym `permId` = 410 (karta wygasła); na karcie z ekranu = 422', async () => {
    const h = await start();
    expect(await decide(h, `${PROMPT}-${'f'.repeat(32)}`, 'release')).toMatchObject({ status: 410 });
    h.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    const screen = await screenCard(h, 'tool-release');
    expect(await decide(h, screen, 'release')).toMatchObject({ status: 422, body: { error: 'not-channel' } });
    expect(answers(h)).toEqual({});
    expect(h.driver.decisions).toEqual([]);
  });

  /**
   * Wyzwalacze `#expirePending` (i `stale`) z kartą kanału `pending` i `sent`. `release` = podpisany plik zwolnienia
   * dla obu, `stays` = obie bez zmiany, `hook-dead` = obie odwołane z tą przyczyną, bez pliku `.json`, a urządzenia
   * dostają zdjęcie obu kart. Utrata kontaktu z panelem (`stale`) kart nie rusza: odpowiedź idzie plikiem do hooka,
   * a śmierć hooka widzi obserwacja cyklu. Podmiana drivera przy nowym panelu (`#attachDriver`) poza demo nie trafia
   * w sesję z driverem; tę samą podmianę niesie `re-attached`.
   */
  const TRIGGERS: readonly {
    name: string; expect: 'release' | 'stays' | 'hook-dead'; ownsProcess?: boolean;
    run: (h: Harness) => Promise<unknown>;
  }[] = [
    { name: 'przerwanie z telefonu', expect: 'release', run: (h) => h.manager.interrupt(h.id) },
    { name: 'zamknięcie panelu z telefonu', expect: 'release', run: (h) => h.manager.close(h.id, { closePanel: true }) },
    { name: 'ukrycie karty', expect: 'stays', run: (h) => h.manager.close(h.id) },
    { name: '`dispose` managera', expect: 'stays', run: (h) => h.manager.dispose() },
    { name: '`permission-cleared` z drivera', expect: 'stays', run: async (h) => { h.driver.queue.push({ type: 'permission-cleared' }); } },
    {
      name: 'powrót panelu po awarii gniazda (`re-attached`, nowy driver)', expect: 'stays',
      run: async (h) => { h.supervisor.lifecycle.push({ type: 're-attached', agent: makeAgent() }); },
    },
    { name: 'wyjście procesu (`exit`)', expect: 'hook-dead', run: async (h) => { h.driver.queue.push({ type: 'exit', ok: true }); } },
    {
      name: 'koniec strumienia drivera z własnym procesem', expect: 'hook-dead', ownsProcess: true,
      run: async (h) => { h.driver.queue.close(); },
    },
    {
      name: 'wyjątek strumienia drivera z własnym procesem', expect: 'hook-dead', ownsProcess: true,
      run: async (h) => { h.driver.fail(new Error('strumień padł')); },
    },
    { name: 'panel `gone`', expect: 'hook-dead', run: async (h) => { h.supervisor.lifecycle.push({ type: 'gone', key: KEY }); } },
    {
      name: 'koniec strumienia drivera bez własnego procesu (`stale`)', expect: 'stays',
      run: async (h) => { h.driver.queue.close(); },
    },
    {
      name: 'wyjątek strumienia drivera bez własnego procesu (`stale`)', expect: 'stays',
      run: async (h) => { h.driver.fail(new Error('strumień padł')); },
    },
    {
      name: 'gniazdo herdr niedostępne (`unavailable`, `stale`)', expect: 'stays',
      run: async (h) => { h.supervisor.lifecycle.push({ type: 'unavailable', reason: foreign('gniazdo padło') }); },
    },
  ];

  it.each(TRIGGERS)('wyzwalacz: $name → $expect', async (trigger) => {
    const h = await start({ ownsProcess: trigger.ownsProcess === true });
    const pending = await card(h, `${trigger.name}-pending`);
    const sent = await sentCard(h, `${trigger.name}-sent`);
    await trigger.run(h);
    await flush(12);
    const records = [h.cycle.record(ENGINE, pending.key), h.cycle.record(ENGINE, sent.key)];
    switch (trigger.expect) {
      case 'release':
        expect(records).toEqual([
          expect.objectContaining({ state: 'sent', decision: 'release' }),
          expect.objectContaining({ state: 'sent', decision: 'release' }),
        ]);
        expect(answers(h)).toEqual({ [pending.key]: 'release', [sent.key]: 'release' });
        break;
      case 'stays':
        expect(records.map((r) => r?.state)).toEqual(['pending', 'sent']);
        expect(answers(h)).toEqual({ [sent.key]: 'allow' });
        expect(resolvedIds(h).filter((permId) => permId === pending.key || permId === sent.key)).toEqual([]);
        break;
      default:
        expect(records).toEqual([
          expect.objectContaining({ state: 'revoked', cause: trigger.expect }),
          expect.objectContaining({ state: 'revoked', cause: trigger.expect }),
        ]);
        expect(answers(h)).toEqual({});
        // Zdjęcie obu kart dociera do urządzeń także po odpięciu drivera i po `gone`; snapshot sesji bez nich.
        expect(resolvedIds(h)).toEqual(expect.arrayContaining([pending.key, sent.key]));
        expect(channelCards(h)).toEqual([]);
    }
    expect(h.driver.decisions).toEqual([]);
  });

  /** Znacznik prośby rozmowy {@link ENGINE} na dysku (treści cykl przy końcu rozmowy nie czyta, liczy się nazwa). */
  function markerFile(h: Harness, seed: string): string {
    const dir = join(h.dir, HOOK_MARKERS_DIRNAME, ENGINE);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${dumpOf(seed).key}.json`);
    writeFileSync(file, '{}', { mode: 0o600 });
    return file;
  }

  /**
   * Koniec rozmowy (port `ended`): pula sesji z pamięci i znaczniki prośby z dysku schodzą tylko na końcu procesu
   * sesji (`#endConsentSession`: wyjście procesu, panel `gone`). Przerwanie z telefonu, utrata kontaktu (`stale`),
   * ukrycie karty i zamknięcie z telefonu (karta zapomniana przed `gone`) znaczników nie ruszają.
   */
  const MARKER_TRIGGERS = TRIGGERS.map((trigger) => ({
    ...trigger, markers: trigger.expect === 'hook-dead' ? 'znikają' : 'zostają',
  }));

  it.each(MARKER_TRIGGERS)('koniec rozmowy przy wyzwalaczu: $name → znaczniki prośby $markers', async (trigger) => {
    const h = await start({ ownsProcess: trigger.ownsProcess === true });
    const marker = markerFile(h, `${trigger.name}-znacznik`);
    await trigger.run(h);
    await flush(12);
    if (trigger.markers === 'znikają') {
      expect(h.ends).toEqual([ENGINE]);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(h.dir, HOOK_MARKERS_DIRNAME, ENGINE))).toBe(false);
    } else {
      expect(h.ends).toEqual([]);
      expect(existsSync(marker)).toBe(true);
    }
  });

  it('koniec rozmowy przy drugim żywym panelu: znaczniki zostają, aż zniknie i on', async () => {
    const h = await start();
    await successor(h);
    const marker = markerFile(h, 'drugi-panel');
    h.supervisor.lifecycle.push({ type: 'gone', key: KEY });
    await flush(12);
    expect(h.ends).toEqual([]);
    expect(existsSync(marker)).toBe(true);
    h.supervisor.lifecycle.push({ type: 'gone', key: KEY_NEXT });
    await flush(12);
    expect(h.ends).toEqual([ENGINE]);
    expect(existsSync(marker)).toBe(false);
  });

  /**
   * Panele innych rozmów, których driver milczy, zajmują wszystkie sloty podpięcia managera (każdy do sufitu czasu
   * pierwszego zdarzenia drivera): następny panel dostaje kartę od razu, a driver dopiero po zwolnieniu slotu.
   */
  async function fillAttachSlots(h: Harness): Promise<void> {
    for (let n = 0; n < HERDR_ATTACH_CONCURRENCY; n += 1) {
      const key = `w9:p9${String(n)}`;
      h.supervisor.silent.add(key);
      h.supervisor.appear({
        ...makeAgent(), key, paneId: key, tabId: `w9:t9${String(n)}`,
        agentSessionId: `33333333-3333-4333-8333-33333333333${String(n)}`,
      });
    }
    await flush();
    expect([...h.supervisor.silent].filter((key) => h.supervisor.drivers.has(key))).toHaveLength(HERDR_ATTACH_CONCURRENCY);
  }

  it.each([
    { name: 'przed odczytem `agent.list`', during: false },
    { name: 'w trakcie odczytu `agent.list` (odpowiedź bez tej rozmowy)', during: true },
  ])('koniec rozmowy, a nowy panel tej rozmowy pojawia się $name i czeka na slot podpięcia bez drivera: znaczniki'
    + ' i pula zostają; po zniknięciu i jego schodzą', async ({ during }) => {
    const h = await start();
    const marker = markerFile(h, 'czeka-na-slot');
    const request = dumpOf('czeka-na-slot');
    h.cycle.notePool(ENGINE, [request], { kind: 'unknown', why: 'writers' }, Date.now());
    const poolKeys = (): string[] => h.cycle.pool(ENGINE).candidates.map((candidate) => candidate.dump.key);
    expect(poolKeys()).toEqual([request.key]);
    await fillAttachSlots(h);
    let answer = (): void => {};
    if (during) {
      h.supervisor.liveReading = () => new Promise<void>((resolve) => { answer = resolve; });
    } else {
      await successor(h);
    }
    h.supervisor.lifecycle.push({ type: 'gone', key: KEY });
    await flush();
    if (during) {
      expect(h.supervisor.liveReads).toBe(1);
      await successor(h);
    }
    // Karta nowego panelu stoi na liście, jej driver czeka na slot podpięcia.
    expect(h.supervisor.drivers.has(KEY_NEXT)).toBe(false);
    h.supervisor.liveReading = null;
    answer();
    await flush(12);
    expect(h.ends).toEqual([]);
    expect(existsSync(marker)).toBe(true);
    expect(poolKeys()).toEqual([request.key]);
    // Karta czekająca na slot widoczna już przed odczytem: `agent.list` nie jest pytany.
    expect(h.supervisor.liveReads).toBe(during ? 1 : 0);
    h.supervisor.lifecycle.push({ type: 'gone', key: KEY_NEXT });
    await flush(12);
    expect(h.ends).toEqual([ENGINE]);
    expect(existsSync(marker)).toBe(false);
    expect(poolKeys()).toEqual([]);
  });

  /**
   * Jedna rozmowa w kilku panelach: karta A ({@link KEY}) z driverem, karty B ({@link KEY_NEXT}) i C ({@link THIRD})
   * czekają na slot podpięcia bez drivera, a panele znikają (`gone`) w podanej kolejności. Koniec rozmowy nie zależy
   * od tego, która karta ją obsługuje (kończy ją też karta bez drivera), a karta `done` niczego nie blokuje: pula
   * i znaczniki zostają, póki żyje któryś panel rozmowy, i schodzą raz, przy końcu ostatniego.
   */
  const GONE_ORDERS: readonly { readonly order: string; readonly keys: readonly string[] }[] = [
    { order: 'C, A, B', keys: [THIRD.key, KEY, KEY_NEXT] },
    { order: 'A, C, B', keys: [KEY, THIRD.key, KEY_NEXT] },
    { order: 'A, B, C', keys: [KEY, KEY_NEXT, THIRD.key] },
    { order: 'B, A, C', keys: [KEY_NEXT, KEY, THIRD.key] },
    { order: 'B, C, A', keys: [KEY_NEXT, THIRD.key, KEY] },
    { order: 'C, B, A', keys: [THIRD.key, KEY_NEXT, KEY] },
    { order: 'A, B (bez C)', keys: [KEY, KEY_NEXT] },
    { order: 'B, A (bez C)', keys: [KEY_NEXT, KEY] },
  ];

  it.each(GONE_ORDERS)('koniec rozmowy: A z driverem, B i C czekają na slot podpięcia, `gone` $order → pula'
    + ' i znaczniki zostają do końca ostatniego panelu, `ended` raz', async ({ keys }) => {
    const h = await start();
    const marker = markerFile(h, 'kilka-paneli');
    const request = dumpOf('kilka-paneli');
    h.cycle.notePool(ENGINE, [request], { kind: 'unknown', why: 'writers' }, Date.now());
    const poolKeys = (): string[] => h.cycle.pool(ENGINE).candidates.map((candidate) => candidate.dump.key);
    await fillAttachSlots(h);
    await successor(h);
    if (keys.includes(THIRD.key)) await successor(h, true, THIRD);
    for (const [n, key] of keys.entries()) {
      // Karty B i C stoją na liście bez drivera do końca przypadku: ich podpięcie czeka na slot.
      expect([KEY_NEXT, THIRD.key].filter((waiting) => h.supervisor.drivers.has(waiting))).toEqual([]);
      h.supervisor.lifecycle.push({ type: 'gone', key });
      await flush(12);
      const last = n === keys.length - 1;
      expect(h.ends).toEqual(last ? [ENGINE] : []);
      expect(existsSync(marker)).toBe(!last);
      expect(poolKeys()).toEqual(last ? [] : [request.key]);
    }
    // Żywą kartę rozmowy widać przed odczytem: `agent.list` pytany raz, przy końcu ostatniego panelu.
    expect(h.supervisor.liveReads).toBe(1);
  });

  it('wyjście procesu (`exit`), potem `gone` tego panelu: karta `done` nie kończy rozmowy drugi raz', async () => {
    const h = await start();
    const marker = markerFile(h, 'exit-potem-gone');
    h.driver.queue.push({ type: 'exit', ok: true });
    await flush(12);
    expect(h.manager.list().find((s) => s.id === h.id)?.state).toBe('done');
    expect(h.ends).toEqual([ENGINE]);
    expect(existsSync(marker)).toBe(false);
    h.supervisor.lifecycle.push({ type: 'gone', key: KEY });
    await flush(12);
    expect(h.ends).toEqual([ENGINE]);
    expect(h.supervisor.liveReads).toBe(1);
  });

  it.each([
    {
      name: 'panel ukryty tej samej rozmowy w świeżym `agent.list`',
      prepare: (h: Harness) => { h.supervisor.liveEngines.add(ENGINE); },
    },
    { name: 'błąd odczytu `agent.list`', prepare: (h: Harness) => { h.supervisor.liveError = new Error('gniazdo padło'); } },
  ])('koniec rozmowy, a $name: znaczniki i pula zostają', async ({ prepare }) => {
    const h = await start();
    const marker = markerFile(h, 'ukryty-panel');
    prepare(h);
    h.supervisor.lifecycle.push({ type: 'gone', key: KEY });
    await flush(12);
    expect(h.ends).toEqual([]);
    expect(existsSync(marker)).toBe(true);
  });

  it('zamknięcie z telefonu, gdy `closeTab` pada: znaczniki zostają', async () => {
    const h = await start();
    const marker = markerFile(h, 'zamkniecie-pada');
    const failure = new Error('herdr odrzucił zamknięcie tabu');
    h.supervisor.closeError = failure;
    await expect(h.manager.close(h.id, { closePanel: true })).rejects.toBe(failure);
    await flush(12);
    expect(h.ends).toEqual([]);
    expect(existsSync(marker)).toBe(true);
  });

  it('okablowanie produkcyjne: port `ended` w `server/src/index.ts` kończy pulę i znaczniki rozmowy w cyklu', () => {
    const src = readFileSync(new URL('../src/bootstrap/consent.ts', import.meta.url), 'utf8');
    expect(src).toMatch(new RegExp([
      String.raw`ended: \(engineSessionId: string\) => \{`,
      String.raw`\s+consentCycle\.endPool\(engineSessionId\);`,
      String.raw`\s+\},`,
    ].join('')));
  });

  it('zamknięcie karty historycznej po `gone`: karty zostają odwołane, bez pliku zwolnienia i bez zamykania tabu', async () => {
    const h = await start();
    const pending = await card(h, 'historyczna-pending');
    const sent = await sentCard(h, 'historyczna-sent');
    h.supervisor.lifecycle.push({ type: 'gone', key: KEY });
    await flush(12);
    await h.manager.close(h.id, { closePanel: true });
    await flush(12);
    for (const dump of [pending, sent]) {
      expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    }
    expect(answers(h)).toEqual({});
    expect(h.supervisor.closedTabs).toBe(0);
  });

  it('karta znana tylko ze snapshotu (jak odtworzona przed managerem): zmiana = `permission-settled`, koniec ='
    + ' `permission-resolved`', async () => {
    const h = await start();
    h.muted = true;
    const decided = await card(h, 'snapshot-decyzja');
    const ended = await card(h, 'snapshot-koniec');
    h.muted = false;
    expect(h.events.filter((e) => e.type === 'permission-pending')).toEqual([]);
    expect(channelCards(h).map((p) => p.permId)).toEqual([decided.key, ended.key]);

    expect(await decide(h, decided.key, 'allow')).toMatchObject({ status: 200 });
    await flush();
    expect(h.events.filter((e) => e.type === 'permission-pending')).toEqual([]);
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'permission-settled', permId: decided.key, state: 'sent' }));

    await h.cycle.observe(ENGINE, ended.key, 'gone', ended);
    await flush();
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'permission-resolved', permId: ended.key }));
    expect(h.events.filter((e) => e.type === 'permission-pending')).toEqual([]);
  });

  it('kolejność ekran → kanał: karta kanału zdejmuje kartę z ekranu; w snapshocie i zdarzeniach jedna karta', async () => {
    const h = await start();
    h.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    const screen = await screenCard(h, 'tool-ekran-pierwszy');
    expect(h.manager.transcript(h.id).pendingPermissions.map((p) => p.permId)).toEqual([screen]);
    const dump = await card(h, 'ekran-potem-kanal');
    expect(h.manager.transcript(h.id).pendingPermissions.map((p) => p.permId)).toEqual([dump.key]);
    expect(openByEvents(h)).toEqual([dump.key]);
    expect(h.events).toContainEqual({
      type: 'permission-resolved', sessionId: h.id, permId: screen, decision: 'expired', by: 'system',
    });
    // Spóźnione tapnięcie w zdjętą kartę z ekranu: 410, bez klawisza.
    expect(await decide(h, screen, 'allow')).toMatchObject({ status: 410 });
    expect(h.driver.decisions).toEqual([]);
  });

  it('kolejność kanał → ekran: przy żywej karcie kanału karta z ekranu nie powstaje', async () => {
    const h = await start();
    const dump = await card(h, 'kanal-potem-ekran');
    await screenCard(h, 'tool-ekran-drugi');
    expect(h.manager.transcript(h.id).pendingPermissions.map((p) => p.permId)).toEqual([dump.key]);
    expect(openByEvents(h)).toEqual([dump.key]);
    expect(h.events.filter((e) => e.type === 'permission-pending')).toHaveLength(1);
    expect(await decide(h, 'tool-ekran-drugi', 'allow')).toMatchObject({ status: 410 });
    expect(h.driver.decisions).toEqual([]);
  });

  it('karta kanału z odpowiedzią odebraną (`claimed`) nie trzyma dialogu: następna karta z ekranu idzie', async () => {
    const h = await start();
    const dump = await sentCard(h, 'odebrana-potem-ekran');
    const base = join(h.dir, CONSENT_DIRNAME, ENGINE, dump.key);
    renameSync(`${base}.json`, `${base}.claimed`);
    await h.cycle.tick();
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('claimed');
    const screen = await screenCard(h, 'tool-nastepny-dialog');
    expect(h.manager.transcript(h.id).pendingPermissions.map((p) => p.permId)).toEqual([screen, dump.key]);
  });

  it.each([
    { name: '`/exit` (wyjście procesu)', end: (h: Harness) => { h.driver.queue.push({ type: 'exit', ok: true }); } },
    { name: 'panel `gone`', end: (h: Harness) => { h.supervisor.lifecycle.push({ type: 'gone', key: KEY }); } },
  ])('zgoda odebrana przez hook (`claimed`), potem $name bez `tool_result`: rekord `unknown`, karta schodzi'
    + ' z urządzeń, migawka sesji `done` bez karty kanału', async ({ end }) => {
    const h = await start();
    const dump = await sentCard(h, 'koniec-po-przejeciu');
    await claim(h, dump);
    end(h);
    await flush(12);
    expect(h.turnEnds).toContain(ENGINE);
    // Rekord zostaje taki, jaki dał dowód (audyt): odebrana odpowiedź bez skutku w turze = `unknown`.
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', cause: 'no-tool-use' });
    // Po końcu sesji późnego dowodu nie będzie: karta schodzi jak karta z ekranu, nie wisi bez przycisków.
    expect(h.events).toContainEqual({
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'expired', by: 'system',
    });
    expect(h.events.filter((e) => e.type === 'permission-settled' && e.permId === dump.key && e.state === 'unknown'))
      .toEqual([]);
    expect(h.manager.list().find((s) => s.id === h.id)?.state).toBe('done');
    expect(channelCards(h)).toEqual([]);
    expect(openByEvents(h)).toEqual([]);
    expect(answers(h)).toEqual({});
    // Spóźnione tapnięcie w zdjętą kartę: 410, bez pliku.
    expect(await decide(h, dump.key, 'release')).toMatchObject({ status: 410 });
    expect(answers(h)).toEqual({});
  });

  it('bezczynność sesji po turze: port końca tury wołany, karty `pending` i `sent` zostają', async () => {
    const h = await start();
    const pending = await card(h, 'bezczynnosc-pending');
    const sent = await sentCard(h, 'bezczynnosc-sent');
    h.driver.queue.push({ type: 'result', subtype: 'success' });
    await flush(12);
    expect(h.manager.list().find((s) => s.id === h.id)?.state).toBe('waiting-input');
    expect(h.turnEnds).toContain(ENGINE);
    expect(h.cycle.record(ENGINE, pending.key)?.state).toBe('pending');
    expect(h.cycle.record(ENGINE, sent.key)?.state).toBe('sent');
    expect(answers(h)).toEqual({ [sent.key]: 'allow' });
  });

  it('powrót gniazda herdr (`re-attached`): karty kanału sprzed powrotu tracą przycisk zgody od razu (`allow` = 409'
    + ' `card-changed` bez pliku, `deny` przechodzi); hook rozpoczęty po powrocie, a przed pierwszą obserwacją nowego'
    + ' drivera ze znanym transkryptem, też bez przycisku; hook rozpoczęty po tej obserwacji z przyciskiem', async () => {
    const h = await start();
    const before = await card(h, 'przed-powrotem-allow');
    const denied = await card(h, 'przed-powrotem-deny');
    const buttons = (): unknown[] => channelCards(h).map((p) => [p.permId, p.state, p.canAllow]);
    expect(buttons()).toEqual([[before.key, 'pending', true], [denied.key, 'pending', true]]);
    h.supervisor.lifecycle.push({ type: 're-attached', agent: makeAgent() });
    await flush(12);
    expect(buttons()).toEqual([[before.key, 'pending', false], [denied.key, 'pending', false]]);
    expect(await decide(h, before.key, 'allow')).toMatchObject({ status: 409, body: { error: 'card-changed' } });
    expect(answerOf(h.dir, before.key)).toBeNull();
    expect(await decide(h, denied.key, 'deny')).toMatchObject({ status: 200 });
    expect(answerOf(h.dir, denied.key)).toBe('deny');
    // Hook rozpoczęty po powrocie gniazda, przed pierwszą obserwacją nowego drivera ze znanym transkryptem: bez przycisku.
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    const driver = h.supervisor.driver(KEY);
    expect(driver).not.toBe(h.driver);
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    const duringAt = Date.now();
    const during: HookCallDump = { ...dumpOf('w-okresie-powrotu'), startedAt: duringAt, at: duringAt + 100 };
    register(h.reg, during);
    await h.cycle.observe(ENGINE, during.key, 'standing', during);
    await flush();
    expect(channelCards(h).find((p) => p.permId === during.key)).toMatchObject({ state: 'pending', canAllow: false });
    expect(await decide(h, during.key, 'allow')).toMatchObject({ status: 409, body: { error: 'card-changed' } });
    expect(answerOf(h.dir, during.key)).toBeNull();
    // Pierwsza obserwacja nowego drivera ze znanym transkryptem kończy okres (krok `observe.ts`; harness bez zrzutów
    // na dysku woła cykl wprost). Hook rozpoczęty po niej: dowód z kompletu, przycisk zgody.
    h.cycle.noteTranscript(ENGINE, Date.now());
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    const startedAt = Date.now();
    const late: HookCallDump = { ...dumpOf('po-powrocie'), startedAt, at: startedAt + 100 };
    register(h.reg, late);
    await h.cycle.observe(ENGINE, late.key, 'standing', late);
    await flush();
    expect(channelCards(h).find((p) => p.permId === late.key)).toMatchObject({ state: 'pending', canAllow: true });
    expect(await decide(h, late.key, 'allow')).toMatchObject({ status: 200 });
    expect(answerOf(h.dir, late.key)).toBe('allow');
    expect([...h.driver.decisions, ...driver.decisions]).toEqual([]);
  });

  it('okablowanie produkcyjne: port `reattached` w `server/src/index.ts` stawia granicę w cyklu dla każdej sesji silnika',
    () => {
      const src = readFileSync(new URL('../src/bootstrap/consent.ts', import.meta.url), 'utf8');
      expect(src).toMatch(new RegExp([
        String.raw`reattached: async \(engineSessionIds: readonly string\[\]\) => \{`,
        String.raw`\s+await Promise\.all\(engineSessionIds\.map\(\(id\) => consentCycle\.markReattached\(id\)\)\);`,
        String.raw`\s+\},`,
      ].join('')));
    });

  // -------------------------------------------------------------------------
  // Właściciel rozmowy, utrata kontaktu z herdr, stany, które trzymają dialog
  // -------------------------------------------------------------------------

  it('rozmowa wznowiona w nowym panelu, który `re-attached` wyprowadza poza korzenie: `allow` przez oba adresy bez'
    + ' pliku (nowa karta 400, stara 410); `deny` i `release` przez starą 410, przez nową 200', async () => {
    const h = await start();
    h.supervisor.lifecycle.push({ type: 'gone', key: KEY });
    await flush(12);
    expect(h.manager.list().find((s) => s.id === h.id)?.state).toBe('done');
    const next = await successor(h);
    h.supervisor.lifecycle.push({ type: 're-attached', agent: { ...next.agent, inScope: false } });
    await flush(12);
    const driver = h.supervisor.driver(KEY_NEXT);
    const denied = await card(h, 'wznowiona-deny', 'standing', driver);
    const freed = await card(h, 'wznowiona-release', 'standing', driver);

    expect(await decideAt(h, next.id, denied.key, 'allow')).toMatchObject({ status: 400 });
    expect(await decide(h, denied.key, 'allow')).toMatchObject({ status: 410 });
    expect(await decide(h, denied.key, 'deny')).toMatchObject({ status: 410 });
    expect(await decide(h, freed.key, 'release')).toMatchObject({ status: 410 });
    expect(answers(h)).toEqual({});
    expect(await decideAt(h, next.id, denied.key, 'deny')).toMatchObject({ status: 200 });
    expect(await decideAt(h, next.id, freed.key, 'release')).toMatchObject({ status: 200 });
    expect(answers(h)).toEqual({ [denied.key]: 'deny', [freed.key]: 'release' });
    // Karty rozmowy niesie wyłącznie karta, która ją obsługuje; karta historyczna (`done`) nie niesie żadnej.
    expect(channelCards(h, next.id).map((p) => p.permId)).toEqual([denied.key, freed.key]);
    expect(channelCards(h)).toEqual([]);
    expect([...h.driver.decisions, ...driver.decisions]).toEqual([]);
  });

  it('ta sama rozmowa w dwóch żywych panelach, jeden poza korzeniami: `allow` bez pliku przez oba adresy, `deny`'
    + ' przez kartę, która obsługuje rozmowę, przechodzi', async () => {
    const h = await start({ inScope: false });
    const next = await successor(h);
    const driver = h.supervisor.driver(KEY_NEXT);
    const dump = await card(h, 'dwa-panele', 'standing', driver);
    // Hook może należeć do panelu spoza korzeni: przy wątpliwości odmowa.
    expect(await decideAt(h, next.id, dump.key, 'allow')).toMatchObject({ status: 400 });
    expect(await decide(h, dump.key, 'allow')).toMatchObject({ status: 410 });
    expect(answers(h)).toEqual({});
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('pending');
    expect(await decideAt(h, next.id, dump.key, 'deny')).toMatchObject({ status: 200 });
    expect(answers(h)).toEqual({ [dump.key]: 'deny' });
  });

  it.each([
    { name: 'zamknięcie z telefonu, potem `gone`', order: ['close', 'gone'] as const },
    { name: '`gone`, potem zamknięcie z telefonu', order: ['gone', 'close'] as const },
  ])('rozmowa wznowiona w innym panelu: karta historyczna ($name) nie odwołuje i nie zwalnia kart następcy',
    async ({ order }) => {
      const h = await start();
      const next = await successor(h);
      const driver = h.supervisor.driver(KEY_NEXT);
      const pending = await card(h, 'nastepca-pending', 'standing', driver);
      const sent = await sentCard(h, 'nastepca-sent', { id: next.id, driver });
      const turnEnds = h.turnEnds.length;
      for (const step of order) {
        if (step === 'close') await h.manager.close(h.id, { closePanel: true });
        else h.supervisor.lifecycle.push({ type: 'gone', key: KEY });
        await flush(12);
      }
      expect([pending, sent].map((d) => h.cycle.record(ENGINE, d.key)?.state)).toEqual(['pending', 'sent']);
      expect(answers(h)).toEqual({ [sent.key]: 'allow' });
      expect(channelCards(h, next.id).map((p) => p.permId)).toEqual([pending.key, sent.key]);
      expect(resolvedIds(h).filter((permId) => permId === pending.key || permId === sent.key)).toEqual([]);
      expect(h.turnEnds).toHaveLength(turnEnds);
    });

  it('zamknięcie panelu z telefonu przy karcie `claimed`: karta schodzi z urządzeń i nie wraca na kartę rozmowy'
    + ' wznowionej w nowym panelu', async () => {
    const h = await start();
    const dump = await sentCard(h, 'zamkniecie-po-przejeciu');
    await claim(h, dump);
    await h.manager.close(h.id, { closePanel: true });
    await flush(12);
    expect(h.supervisor.closedTabs).toBe(1);
    expect(h.events).toContainEqual({
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'expired', by: 'system',
    });
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', cause: 'no-tool-use' });
    const next = await successor(h);
    expect(channelCards(h, next.id)).toEqual([]);
    expect(h.events.filter((e) => e.type === 'permission-pending' && e.request.sessionId === next.id)).toEqual([]);
    expect(await decideAt(h, next.id, dump.key, 'release')).toMatchObject({ status: 410 });
  });

  it('gniazdo herdr niedostępne i powrót (`available`, `re-attached`): karty `pending` i `sent` żyją, `allow` na'
    + ' `pending` zapisuje plik; hook martwy w przerwie = `revoked` z `hook-dead` po powrocie', async () => {
    const h = await start();
    const allowed = await card(h, 'przerwa-allow');
    const orphan = await card(h, 'przerwa-hook-umiera');
    const sent = await sentCard(h, 'przerwa-sent');
    const states = (): (string | undefined)[] => [allowed, orphan, sent].map((d) => h.cycle.record(ENGINE, d.key)?.state);

    h.supervisor.lifecycle.push({ type: 'unavailable', reason: foreign('gniazdo padło') });
    await flush(12);
    expect(h.manager.list().find((s) => s.id === h.id)?.stale).toBe(true);
    expect(states()).toEqual(['pending', 'pending', 'sent']);
    expect(channelCards(h).map((p) => p.permId)).toEqual([allowed.key, orphan.key, sent.key]);
    expect(await decide(h, allowed.key, 'allow')).toMatchObject({ status: 200 });
    expect(answerOf(h.dir, allowed.key)).toBe('allow');

    h.supervisor.lifecycle.push({ type: 'available' });
    await flush(12);
    expect(states()).toEqual(['sent', 'pending', 'sent']);
    h.supervisor.lifecycle.push({ type: 're-attached', agent: makeAgent() });
    await flush(12);
    expect(h.manager.list().find((s) => s.id === h.id)?.stale).not.toBe(true);
    expect(states()).toEqual(['sent', 'pending', 'sent']);

    // Następna obserwacja po powrocie ocenia kartę od nowa: hook umarł w przerwie.
    await h.cycle.observe(ENGINE, orphan.key, 'dead', orphan);
    await flush();
    expect(h.cycle.record(ENGINE, orphan.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    expect(channelCards(h).map((p) => p.permId)).toEqual([allowed.key, sent.key]);
    expect(resolvedIds(h)).toEqual([orphan.key]);
    expect(answers(h)).toEqual({ [allowed.key]: 'allow', [sent.key]: 'allow' });
  });

  /** Karta kanału doprowadzona do stanu `state`; `holds` = karta trzyma dialog (hook czeka na plik). */
  const HOLDING: readonly { state: string; holds: boolean; reach: (h: Harness) => Promise<HookCallDump> }[] = [
    { state: 'pending', holds: true, reach: (h) => card(h, 'stan-pending') },
    { state: 'sent', holds: true, reach: (h) => sentCard(h, 'stan-sent') },
    {
      state: 'claimed', holds: false,
      reach: async (h) => { const dump = await sentCard(h, 'stan-claimed'); await claim(h, dump); return dump; },
    },
    {
      state: 'running', holds: false,
      reach: async (h) => {
        const dump = await sentCard(h, 'stan-running');
        await claim(h, dump);
        await h.cycle.observe(ENGINE, dump.key, 'gone', dump);
        await flush();
        return dump;
      },
    },
    {
      state: 'unknown', holds: false,
      reach: async (h) => {
        const dump = await sentCard(h, 'stan-unknown');
        await claim(h, dump);
        await forcedTurnEnd(h.cycle, ENGINE);
        await flush();
        return dump;
      },
    },
  ];

  it.each(HOLDING)('karta kanału `$state` (trzyma dialog: $holds): karta z ekranu następnego dialogu powstaje tylko'
    + ' bez dialogu w rękach kanału', async ({ state, holds, reach }) => {
    const h = await start();
    const dump = await reach(h);
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe(state);
    expect((CONSENT_HOLDING_STATES as readonly string[]).includes(state)).toBe(holds);
    h.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    const screen = await screenCard(h, `tool-po-${state}`);
    expect(h.manager.transcript(h.id).pendingPermissions.some((p) => p.permId === screen)).toBe(!holds);
  });

  // -------------------------------------------------------------------------
  // Karty zdjęte na końcu sesji nie wracają: drugi żywy panel rozmowy, restart serwera
  // -------------------------------------------------------------------------

  /** Zdarzenia karty `permId` (prośba, zmiana, zdjęcie) na karcie sesji `sessionId`. */
  function cardEvents(h: Harness, permId: string, sessionId?: string): ServerEvent[] {
    return h.events.filter((e) => {
      if (e.type === 'permission-pending') {
        return e.request.permId === permId && (sessionId === undefined || e.request.sessionId === sessionId);
      }
      return (e.type === 'permission-settled' || e.type === 'permission-resolved') && e.permId === permId
        && (sessionId === undefined || e.sessionId === sessionId);
    });
  }

  it.each([
    { name: '`closeTab` przyjęte', gone: false },
    { name: '`herdr-gone`', gone: true },
  ])('dwa żywe panele rozmowy, karta `claimed` panelu, który ją obsługuje: zamknięcie go z telefonu ($name) zdejmuje'
    + ' dokładnie tę kartę, drugi panel jej nie dostaje (decyzja przez niego 410), a karta zgłoszona po odpięciu'
    + ' drivera idzie do drugiego panelu', async ({ gone }) => {
    const h = await start();
    const owner = await successor(h);
    const ownerDriver = h.supervisor.driver(KEY_NEXT);
    const dump = await sentCard(h, 'dwa-panele-claimed', { id: owner.id, driver: ownerDriver });
    await claim(h, dump);
    expect(channelCards(h, owner.id).map((p) => p.permId)).toEqual([dump.key]);
    expect(channelCards(h)).toEqual([]);
    const after: { dump?: HookCallDump } = {};
    h.supervisor.closing = async () => {
      // Driver zamykanego panelu jest już odpięty: hook drugiego panelu zgłasza nową kartę rozmowy.
      after.dump = await card(h, 'po-odpieciu', 'standing', h.driver);
    };
    if (gone) h.supervisor.closeError = Object.assign(new Error('panel zniknął'), { code: 'herdr-gone' });
    await h.manager.close(owner.id, { closePanel: true });
    await flush(12);
    expect(h.supervisor.closedTabs).toBe(1);
    expect(h.events).toContainEqual({
      type: 'permission-resolved', sessionId: owner.id, permId: dump.key, decision: 'expired', by: 'system',
    });
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown' });
    expect(cardEvents(h, dump.key, h.id)).toEqual([]);
    const next = after.dump?.key ?? '';
    expect(next).not.toBe('');
    expect(channelCards(h).map((p) => p.permId)).toEqual([next]);
    expect(cardEvents(h, next, h.id)).toEqual([expect.objectContaining({ type: 'permission-pending' })]);
    for (const decision of ['allow', 'deny', 'release']) {
      expect(await decide(h, dump.key, decision), decision).toMatchObject({ status: 410 });
    }
    expect(answers(h)).toEqual({});
    expect([...h.driver.decisions, ...ownerDriver.decisions]).toEqual([]);
  });

  it('zgoda `claimed`, potem `/exit` bez `tool_result`, potem restart (nowy cykl i manager na tym samym katalogu'
    + ' danych): rekord `unknown` z polem zdjęcia, wznowiona rozmowa bez karty w migawce i bez `permission-pending`,'
    + ' decyzja 410; późny wynik hooka bez potwierdzenia odbioru nie zmienia rekordu ani urządzeń', async () => {
    const h = await start();
    const dump = await sentCard(h, 'zdjeta-restart');
    await claim(h, dump);
    h.driver.queue.push({ type: 'exit', ok: true });
    await flush(12);
    expect(h.events).toContainEqual({
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'expired', by: 'system',
    });
    const onDisk = (): unknown => readConsentRecords(h.dir).find((r) => r.key === dump.key);
    expect(onDisk()).toMatchObject({ state: 'unknown', retired: { at: expect.any(Number) as number } });
    await h.close();
    closers.splice(0);

    const t = await start({ recover: true });
    expect(t.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown' });
    expect(channelCards(t)).toEqual([]);
    expect(cardEvents(t, dump.key)).toEqual([]);
    for (const decision of ['allow', 'deny', 'release']) {
      expect(await decide(t, dump.key, decision), decision).toMatchObject({ status: 410 });
    }
    expect(answers(t)).toEqual({});

    // Późny wynik hooka bez potwierdzenia odbioru (W-a): rekord bez zmian, urządzenia nie dostają nic.
    const at = Date.now();
    await t.cycle.applyTurn(ENGINE, PROMPT, {
      promptId: PROMPT, ended: true, partial: false,
      toolUses: [{ id: 'toolu_zdjeta', name: 'Bash', inputSha256: dump.inputSha256, line: 1 }],
      results: [{ toolUseId: 'toolu_zdjeta', line: 2, at, decision: 'accept', source: 'hook', interrupted: false }],
    });
    await flush();
    expect(t.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', late: false });
    expect(onDisk()).toMatchObject({ state: 'unknown', retired: { at: expect.any(Number) as number } });
    expect(cardEvents(t, dump.key)).toEqual([]);
    expect(channelCards(t)).toEqual([]);
  });

  it.each([
    { name: 'bez pola (rekord sprzed zmiany)', retired: undefined },
    { name: 'pole w złym kształcie: tekst', retired: 'tak' },
    { name: 'pole w złym kształcie: `at` nie liczbą', retired: { at: 'wczoraj' } },
    { name: 'pole w złym kształcie: `null`', retired: null },
  ])('restart z kartą `claimed` ($name): karta wraca w migawce wznowionej rozmowy jak dotąd', async ({ retired }) => {
    const h = await start();
    const dump = await sentCard(h, 'restart-bez-zdjecia');
    await claim(h, dump);
    await h.close();
    closers.splice(0);
    if (retired !== undefined) {
      const file = join(h.dir, CONSENT_RECORDS_DIRNAME, ENGINE, `${dump.key}.json`);
      const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      writeFileSync(file, `${JSON.stringify({ ...record, retired })}\n`);
    }
    const t = await start({ recover: true });
    expect(t.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'claimed' });
    expect(channelCards(t)).toEqual([expect.objectContaining({ permId: dump.key, state: 'claimed' })]);
    expect(await decide(t, dump.key, 'release')).toMatchObject({ status: 409, body: { error: 'release-taken' } });
  });

  // -------------------------------------------------------------------------
  // Zamknięcie z telefonu: zdjęcie kart i pole na dysku przed zamknięciem tabu
  // -------------------------------------------------------------------------

  /** Pole zdjęcia rekordu `permId` na dysku (`undefined` = brak pola albo rekordu). */
  function retiredOnDisk(h: Harness, permId: string): unknown {
    return readConsentRecords(h.dir).find((r) => r.key === permId)?.retired;
  }

  /** Zdjęcia kart kanału od systemu (`expired`, `system`) na karcie sesji `sessionId`. */
  function expiredIds(h: Harness, sessionId: string = h.id): string[] {
    return h.events.flatMap((e) => (e.type === 'permission-resolved' && e.sessionId === sessionId
      && e.decision === 'expired' && e.by === 'system' ? [e.permId] : []));
  }

  it('zamknięcie panelu z telefonu przy kartach `pending` i `claimed`: w chwili `closeTab` urządzenia mają już'
    + ' zdjęcie obu kart, a rekordy obu kart pole zdjęcia na dysku; `pending` dostaje podpisany `release`', async () => {
    const h = await start();
    const claimed = await sentCard(h, 'przed-rpc-claimed');
    await claim(h, claimed);
    const pending = await card(h, 'przed-rpc-pending');
    const seen: { expired?: string[]; claimed?: unknown; pending?: unknown } = {};
    h.supervisor.closing = async () => {
      seen.expired = expiredIds(h);
      seen.claimed = retiredOnDisk(h, claimed.key);
      seen.pending = retiredOnDisk(h, pending.key);
    };
    await h.manager.close(h.id, { closePanel: true });
    await flush(12);
    expect(h.supervisor.closedTabs).toBe(1);
    expect(seen.expired).toEqual(expect.arrayContaining([pending.key, claimed.key]));
    expect(seen.claimed).toMatchObject({ at: expect.any(Number) as number });
    expect(seen.pending).toMatchObject({ at: expect.any(Number) as number });
    expect(h.cycle.record(ENGINE, pending.key)).toMatchObject({ state: 'sent', decision: 'release' });
    expect(answers(h)).toEqual({ [pending.key]: 'release' });
    // Każda karta schodzi raz.
    expect(expiredIds(h).filter((permId) => permId === pending.key)).toHaveLength(1);
    expect(expiredIds(h).filter((permId) => permId === claimed.key)).toHaveLength(1);
    expect(h.driver.decisions).toEqual([]);
  });

  it('zapis pola zdjęcia pada (port `retire` odrzuca): karta schodzi z urządzeń, zamknięcie tabu idzie dalej, błąd'
    + ' w logu', async () => {
    const h = await start({ retireError: new Error('dysk pełny') });
    const claimed = await sentCard(h, 'zapis-pola-pada');
    await claim(h, claimed);
    const seen: { expired?: string[] } = {};
    h.supervisor.closing = async () => { seen.expired = expiredIds(h); };
    await h.manager.close(h.id, { closePanel: true });
    await flush(12);
    expect(h.supervisor.closedTabs).toBe(1);
    expect(seen.expired).toEqual([claimed.key]);
    expect(retiredOnDisk(h, claimed.key)).toBeUndefined();
    expect(h.logs).toContainEqual(expect.stringContaining(`consent: card ${claimed.key} retire not saved: dysk pełny`));
    expect(h.manager.list().find((s) => s.id === h.id)).toBeUndefined();
    expect(await decide(h, claimed.key, 'release')).toMatchObject({ status: 410 });
  });

  it('zamknięcie tabu pada błędem innym niż `herdr-gone`, a hook w tym czasie przejmuje podpisany `release`:'
    + ' telefon dostał zdjęcie karty, migawka bez niej, decyzja 410, błąd idzie do klienta', async () => {
    const h = await start();
    const pending = await card(h, 'blad-rpc-pending');
    const failure = new Error('herdr odrzucił zamknięcie tabu');
    h.supervisor.closing = async () => {
      // Hook przejmuje plik zwolnienia w trakcie RPC: cykl zmienia kartę na `released`.
      await flush();
      const base = join(h.dir, CONSENT_DIRNAME, ENGINE, pending.key);
      renameSync(`${base}.json`, `${base}.claimed`);
      await h.cycle.tick();
      await flush();
    };
    h.supervisor.closeError = failure;
    await expect(h.manager.close(h.id, { closePanel: true })).rejects.toBe(failure);
    await flush(12);
    expect(h.cycle.record(ENGINE, pending.key)?.state).toBe('released');
    expect(cardEvents(h, pending.key, h.id)).toEqual([
      expect.objectContaining({ type: 'permission-pending' }),
      { type: 'permission-resolved', sessionId: h.id, permId: pending.key, decision: 'expired', by: 'system' },
    ]);
    expect(channelCards(h)).toEqual([]);
    for (const decision of ['allow', 'deny', 'release']) {
      expect(await decide(h, pending.key, decision), decision).toMatchObject({ status: 410 });
    }
    expect(answers(h)).toEqual({});
    expect(h.driver.decisions).toEqual([]);
  });

  it('restart serwera w trakcie zamykania tabu (nowy cykl i manager na stanie dysku z chwili `closeTab`): karta'
    + ' `claimed` zamykanego panelu nie wraca ani na drugi żywy panel rozmowy, ani na rozmowę wznowioną po restarcie',
  async () => {
    const h = await start();
    const owner = await successor(h);
    const ownerDriver = h.supervisor.driver(KEY_NEXT);
    const dump = await sentCard(h, 'restart-w-rpc', { id: owner.id, driver: ownerDriver });
    await claim(h, dump);
    const snapshot = await mkdtemp(join(tmpdir(), 'rarog-karty-zrzut-'));
    try {
      h.supervisor.closing = async () => {
        // Stan dysku w chwili RPC: tyle zobaczy serwer uruchomiony po awarii w trakcie zamykania tabu.
        cpSync(h.dir, snapshot, { recursive: true });
      };
      await h.manager.close(owner.id, { closePanel: true });
      await flush(12);
      expect(channelCards(h)).toEqual([]);
      expect(cardEvents(h, dump.key, h.id)).toEqual([]);
      await h.close();
      closers.splice(0);

      await rm(dir, { recursive: true, force: true });
      cpSync(snapshot, dir, { recursive: true });
      const t = await start({ recover: true });
      expect(retiredOnDisk(t, dump.key)).toMatchObject({ at: expect.any(Number) as number });
      expect(channelCards(t)).toEqual([]);
      expect(cardEvents(t, dump.key)).toEqual([]);
      for (const decision of ['allow', 'deny', 'release']) {
        expect(await decide(t, dump.key, decision), decision).toMatchObject({ status: 410 });
      }
      expect(answers(t)).toEqual({});
    } finally {
      await rm(snapshot, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'gniazdo herdr niedostępne (409)', herdrSend: true, error: BadStateError },
    { name: '`RAROG_HERDR_SEND=0` (400)', herdrSend: false, error: BadRequestError },
  ])('zamknięcie z telefonu odmówione przed zamknięciem tabu ($name): karty i rekordy bez zmian', async (variant) => {
    const h = await start({ herdrSend: variant.herdrSend });
    const claimed = await card(h, 'odmowa-claimed');
    // Odpowiedź wprost w cyklu: przy `RAROG_HERDR_SEND=0` `allow` z urządzenia = 400.
    expect(await h.cycle.decide(ENGINE, claimed.key, 'allow')).toMatchObject({ ok: true });
    await flush();
    await claim(h, claimed);
    const pending = await card(h, 'odmowa-pending');
    if (variant.herdrSend) h.supervisor.available = false;
    const before = h.events.length;
    const turnEnds = h.turnEnds.length;
    await expect(h.manager.close(h.id, { closePanel: true })).rejects.toBeInstanceOf(variant.error);
    await flush(12);
    expect(h.supervisor.closedTabs).toBe(0);
    expect([claimed, pending].map((d) => h.cycle.record(ENGINE, d.key)?.state)).toEqual(['claimed', 'pending']);
    expect([claimed, pending].map((d) => retiredOnDisk(h, d.key))).toEqual([undefined, undefined]);
    expect(answers(h)).toEqual({});
    expect(h.events.slice(before).filter((e) => e.type === 'permission-resolved')).toEqual([]);
    expect(channelCards(h).map((p) => p.permId)).toEqual([claimed.key, pending.key]);
    expect(h.turnEnds).toHaveLength(turnEnds);
  });
});

describe('jedna definicja stanów karty kanału, które trzymają dialog', () => {
  const source = (rel: string): string => readFileSync(join(import.meta.dirname, '..', 'src', rel), 'utf8');

  /** Ciało funkcji albo metody: od linii nagłówka do pierwszej linii z samym `}` na wcięciu nagłówka. */
  function body(text: string, header: string): string {
    const at = text.indexOf(header);
    expect(at, header).toBeGreaterThanOrEqual(0);
    const lineStart = text.lastIndexOf('\n', at) + 1;
    const indent = text.slice(lineStart, at);
    const end = text.indexOf(`\n${indent}}\n`, at);
    expect(end, header).toBeGreaterThan(at);
    return text.slice(at, end);
  }

  it('stała `CONSENT_HOLDING_STATES` = `pending` i `sent`', () => {
    expect(CONSENT_HOLDING_STATES).toEqual(['pending', 'sent']);
  });

  it('port drivera w `bootstrap/consent.ts` (`consentCardLive`) i manager (`consentCardStands`) liczą stany z tej stałej', () => {
    const port = body(source('bootstrap/consent.ts'), 'export function consentCardLive(');
    expect(port).toContain('CONSENT_HOLDING_STATES');
    expect(port).not.toContain('CONSENT_FINAL_STATES');
    const manager = body(source('sessions/consent-cards.ts'), 'consentCardStands(session: Session): boolean {');
    expect(manager).toContain('CONSENT_HOLDING_STATES');
    expect(manager).not.toContain("'pending'");
  });
});
