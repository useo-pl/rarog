/**
 * Testy integracyjne warstwy HTTP: prawdziwy `node:http` na porcie efemerycznym,
 * atrapa ManagerApi. Sprawdzamy kontrakt ze speca: klucz urządzenia → 401 bez klucza, `/api/login` → 410,
 * Origin check, mapowanie 409/410, limit 64 kB.
 */
import {
  MAX_FILE_DATA_URL_BYTES, MAX_IMAGE_DATA_URL_BYTES, MAX_MESSAGE_BODY_BYTES,
  MAX_MESSAGE_TEXT_CHARS,
  MODEL_CHANGE_WARNING, PROTOCOL_VERSION, REFUSE_MESSAGES, ULTRACODE_CHANGE_NOTE, commandListSchema,
  decisionRefusedBodySchema,
  dirListingSchema,
  modelListSchema,
} from '@rarog/shared';
import {
  ULTRACODE_REFUSED_ERROR, liveActivityMacSchema, planUsageSchema, versionResponseSchema,
} from '@rarog/shared/rest';
import type { SessionSummary } from '@rarog/shared';
import { foreign, say } from '@rarog/shared/sentences';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LoginLimiter, createDeviceStore, createLoginLimiter, createPairing, deviceAuthorization, hashSecret, pushKeyId,
} from '../src/auth/index.ts';
import type { DeviceStore } from '../src/auth/index.ts';
import { clientLogPath } from '../src/client-log.ts';
import { type RarogConfig, loadConfig } from '../src/config.ts';
import {
  type ApnsFeature, BODY_TIMEOUT_MS, INTERRUPT_WAIT_MS, type Logger, PUSH_TEST_COOLDOWN_MS,
  type RouterDeps, checkCwd, clientLabel, createRouter, managerErrorStatus, readBody,
} from '../src/router.ts';
import type { ManagerApi } from '../src/sessions/manager-api.ts';
import { BadStateError as ManagerBadStateError } from '../src/sessions/manager.ts';
import type { HealthProbes } from '../src/health.ts';
import { SseHub } from '../src/sse.ts';
import type { MacStats } from '../src/mac-stats.ts';
import { serverSystem } from '../src/version.ts';
import { Presence } from '../src/notify/presence.ts';
import type { PushContent, SendOutcome } from '../src/notify/content.ts';
import { type ApnsDeviceStore, createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import type { ApnsResult } from '../src/notify/apns.ts';
import type { ApnsRequest } from '../src/notify/apns-payload.ts';
import { createApnsSink } from '../src/notify/apns-sink.ts';
import { buildContent } from '../src/notify/content.ts';
import { type LiveActivityController, createLiveActivity } from '../src/notify/live-activity.ts';
import {
  BadRequestError, BadStateError, FakeManager, GoneError, NotFoundError, TooManyRequestsError,
  makeSummary,
} from './fake-manager.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';

/** 1×1 px png — minimalny poprawny załącznik. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
/** Załącznik plikowy — „%PDF-1.4" w base64. */
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

const silentLogger: Logger = { info: () => {}, error: () => {} };

interface Harness {
  base: string;
  manager: FakeManager;
  config: RarogConfig;
  /** Nagłówek `Authorization` urządzenia testowego (jedyne poświadczenie serwera). */
  auth: string;
  close(): Promise<void>;
}

async function startHarness(
  env: NodeJS.ProcessEnv = {},
  sessions = [makeSummary({ id: 's1' })],
  // Dławik i logger są wstrzykiwane tylko tam, gdzie SĄ przedmiotem testu — reszta
  // harnessu ma zostać niezmieniona, żeby nie przemycić im cudzego budżetu prób.
  opts: {
    logger?: Logger; loginLimiter?: LoginLimiter; presence?: Presence;
    apns?: ApnsFeature;
    /**
     * Urządzenia z parowania; domyślnie magazyn z jednym urządzeniem testowym. Własny magazyn idzie
     * razem z `auth` — kluczem urządzenia, które w nim jest.
     */
    devices?: RouterDeps['devices'];
    auth?: string;
    health?: HealthProbes; healthProbeTtlMs?: number;
    tailnet?: () => Promise<string | null>;
    /** Odczyt próbnika obciążenia Maca — atrapa zamiast `sysctl` i `statfs`. */
    mac?: RouterDeps['mac'];
    /** Odczyt zdjęcia do miniatury — atrapa `HerdrUploads.read`. */
    readUpload?: RouterDeps['readUpload'];
    /** Limity planu — atrapa zamiast prawdziwego dostawcy (ten czytałby `~/.claude.json` człowieka). */
    usage?: RouterDeps['usage'];
    /** System maszyny serwera w `/api/version`; brak = system procesu testu. */
    system?: RouterDeps['system'];
    // Przerwanie: własny manager (obietnica sterowana z testu — wtedy to ON niesie sesje,
    // a lista wyżej jest ignorowana) i skrócony termin czekania na dostarczenie klawisza.
    manager?: FakeManager; interruptWaitMs?: number;
  } = {},
): Promise<Harness> {
  const config = loadConfig({ RAROG_DEMO: '1', ...env });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const manager = opts.manager ?? new FakeManager(sessions);
  const hub = new SseHub({
    manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
  });
  hub.start();
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now() - 5_000,
    logger: opts.logger ?? silentLogger,
    loginLimiter: opts.loginLimiter,
    ...(opts.presence === undefined ? {} : { presence: opts.presence }),
    ...(opts.apns === undefined ? {} : { apns: opts.apns }),
    devices: opts.devices ?? device.identity,
    ...(opts.health === undefined ? {} : { health: opts.health }),
    ...(opts.healthProbeTtlMs === undefined ? {} : { healthProbeTtlMs: opts.healthProbeTtlMs }),
    ...(opts.tailnet === undefined ? {} : { tailnet: opts.tailnet }),
    ...(opts.mac === undefined ? {} : { mac: opts.mac }),
    ...(opts.readUpload === undefined ? {} : { readUpload: opts.readUpload }),
    ...(opts.usage === undefined ? {} : { usage: opts.usage }),
    ...(opts.system === undefined ? {} : { system: opts.system }),
    ...(opts.interruptWaitMs === undefined ? {} : { interruptWaitMs: opts.interruptWaitMs }),
  }));
  // `listen` musi odrzucić promise przy błędzie — bez tego środowisko blokujące bind
  // (np. sandbox z EPERM na 127.0.0.1) zawiesza cały `vitest run` zamiast go wywalić.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}`,
    manager,
    config,
    auth: opts.auth ?? device.authorization,
    close: async () => {
      hub.closeAll();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

async function post(
  h: Harness, path: string, body: unknown,
  opts: { origin?: string | null; auth?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  // Klucz z `opts.headers` wygrywa z domyślnym kluczem harnessu.
  const auth = opts.auth === undefined ? h.auth : opts.auth;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', ...(auth === null ? {} : { Authorization: auth }), ...opts.headers,
  };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers['Origin'] = origin;
  return fetch(`${h.base}${path}`, {
    method: 'POST', headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function get(
  h: Harness, path: string, opts: { auth?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const auth = opts.auth === undefined ? h.auth : opts.auth;
  const headers: Record<string, string> = { ...(auth === null ? {} : { Authorization: auth }), ...opts.headers };
  return fetch(`${h.base}${path}`, { headers });
}

/**
 * Manager, w którym „klawisz doszedł" rozstrzyga TEST, a nie zwykłe `Promise.resolve(true)`.
 *
 * `FakeManager.interrupt` oddaje gotową prawdę, więc na nim nie da się zbadać jedynej rzeczy,
 * dla której endpoint dostał termin: kolejki drivera, w której `escape` stoi czasem
 * sekundami — za cudzą wysyłką, bo dzieli z nią kolejkę.
 */
class HeldInterruptManager extends FakeManager {
  /** Co melduje driver; `null` = obietnica NIE rozstrzyga się sama (domyka ją `settle`). */
  deliver: boolean | null = true;

  #held: ((sent: boolean) => void) | null = null;

  override interrupt(id: string): Promise<boolean> {
    // Bramki i zapis wywołania zostają z atrapy bazowej — zmieniamy wyłącznie moment prawdy.
    void super.interrupt(id);
    if (this.deliver !== null) return Promise.resolve(this.deliver);
    return new Promise<boolean>((resolve) => { this.#held = resolve; });
  }

  /** Domyka wstrzymane przerwanie — po teście, żeby obietnica nie przeżyła harnessu. */
  settle(sent: boolean): void {
    this.#held?.(sent);
    this.#held = null;
  }
}

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

describe('/health', () => {
  it('działa bez auth i zwraca {ok, version, uptime, herdr, term}', async () => {
    const res = await get(h, '/health', { auth: null });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; version: string; uptime: number; herdr: boolean; term: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(h.config.version);
    expect(body.uptime).toBeGreaterThanOrEqual(4);
    // Harness nie wstrzykuje sond — fail-closed znaczy `false`, a nie brak pola.
    expect(body.herdr).toBe(false);
    expect(body.term).toBe(false);
  });

  it('z wstrzykniętymi sondami raportuje ich wynik', async () => {
    let pings = 0;
    const withProbes = await startHarness({}, [makeSummary({ id: 's1' })], {
      health: { herdr: () => { pings += 1; return Promise.resolve(true); }, term: true },
    });
    try {
      const one = await (await get(withProbes, '/health', { auth: null })).json();
      expect(one).toMatchObject({ herdr: true, term: true });
      expect(pings).toBe(1);
    } finally {
      await withProbes.close();
    }
  });

  /*
   * `/health` jest w `PUBLIC_PATHS`, więc każdy peer tailnetu dosięga go BEZ klucza urządzenia
   * (`docs/security-model.md`, „Emergency runbook”, akapit o `/health`). Bez pamięci wyniku jedno takie
   * żądanie znaczyłoby jedno nowe połączenie do `herdr.sock` — gniazda demona sterującego wszystkimi panelami tmux.
   * Nie wywracałoby to integracji (`MAX_INFLIGHT = 8`), ale dokładało tani, nieuwierzytelniony wpis do kolejki
   * współdzielonej z `agent.list`/`agent.read` Raroga. Wynik ma więc TERMIN WAŻNOŚCI.
   */
  it('publiczny /health nie sonduje gniazda herdr przy każdym żądaniu', async () => {
    let pings = 0;
    const withProbes = await startHarness({}, [makeSummary({ id: 's1' })], {
      health: { herdr: () => { pings += 1; return Promise.resolve(true); }, term: true },
      healthProbeTtlMs: 10_000,
    });
    try {
      for (let i = 0; i < 12; i += 1) {
        const body = await (await get(withProbes, '/health', { auth: null })).json();
        expect(body).toMatchObject({ herdr: true });
      }
      expect(pings, 'dwanaście GET-ów bez klucza ma dać JEDEN ping gniazda').toBe(1);
    } finally {
      await withProbes.close();
    }
  });

  it('wynik sondy STARZEJE SIĘ — herdr wraca po restarcie bez restartu Raroga', async () => {
    let alive = false;
    let pings = 0;
    const withProbes = await startHarness({}, [makeSummary({ id: 's1' })], {
      health: { herdr: () => { pings += 1; return Promise.resolve(alive); }, term: true },
      // Zero znaczy „każde żądanie jest już po terminie" — czyli zachowanie sprzed cache'u.
      healthProbeTtlMs: 0,
    });
    try {
      expect(await (await get(withProbes, '/health', { auth: null })).json())
        .toMatchObject({ herdr: false });
      alive = true;
      expect(await (await get(withProbes, '/health', { auth: null })).json())
        .toMatchObject({ herdr: true });
      expect(pings).toBe(2);
    } finally {
      await withProbes.close();
    }
  });
});

describe('auth', () => {
  it('bez klucza urządzenia każdy endpoint API zwraca 401 `unauthorized`, bez `Set-Cookie`', async () => {
    for (const path of ['/api/version', '/api/projects', '/api/stream']) {
      const res = await get(h, path, { auth: null });
      expect(res.status, path).toBe(401);
      expect((await res.json() as { error: string }).error, path).toBe('unauthorized');
      expect(res.headers.get('set-cookie'), path).toBeNull();
    }
  });

  it('klucz urządzenia otwiera API', async () => {
    const projects = await get(h, '/api/projects');
    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual({ projects: h.manager.allowedProjects });
  });

  it('`POST /api/login` → stałe 410 `login-retired` bez `Set-Cookie`, także z tokenem w ciele i z kluczem', async () => {
    for (const body of [{ token: 'token-testowy-123' }, { token: '' }, {}, 'nie-json']) {
      for (const auth of [null, h.auth]) {
        const res = await post(h, '/api/login', body, { auth });
        expect(res.status, JSON.stringify(body)).toBe(410);
        expect(await res.json()).toMatchObject({ error: 'login-retired' });
        expect(res.headers.get('set-cookie')).toBeNull();
      }
    }
    expect((await get(h, '/api/login', { auth: null })).status).toBe(405);
  });

  it('`/api/login` stoi za bramką Origin jak każda mutacja: brak Origin → 403', async () => {
    const res = await post(h, '/api/login', { token: 'token-testowy-123' }, { auth: null, origin: null });
    expect(res.status).toBe(403);
  });

  it('cookie `rarog_auth` niczego nie otwiera, a `RAROG_AUTH_TOKEN` w env serwera niczego nie zmienia', async () => {
    const token = 'token-testowy-123';
    const issued = String(Date.now());
    // Kształt dawnego cookie logowania: `<epoka>.<data wydania>.<HMAC tokenu>`, podpisany poprawnie.
    const mac = createHmac('sha256', token).update(`1.${issued}`).digest('hex');
    const cookie = `rarog_auth=1.${issued}.${mac}`;
    const zTokenem = await startHarness({ RAROG_AUTH_TOKEN: token });
    try {
      expect(Object.keys(zTokenem.config).filter((key) => /token|cookie/i.test(key))).toEqual([]);
      const bezKlucza = await get(zTokenem, '/api/projects', { auth: null, headers: { Cookie: cookie } });
      expect(bezKlucza.status).toBe(401);
      expect((await bezKlucza.json() as { error: string }).error).toBe('unauthorized');
      // Klucz rozstrzyga sam: cookie obok ważnego klucza jest ignorowane, obok obcego klucza nie ratuje.
      expect((await get(zTokenem, '/api/projects', { headers: { Cookie: cookie } })).status).toBe(200);
      const obcy = deviceAuthorization('f'.repeat(32), 'Z'.repeat(43));
      expect((await get(zTokenem, '/api/projects', { auth: obcy, headers: { Cookie: cookie } })).status).toBe(401);
      const login = await post(zTokenem, '/api/login', { token }, { auth: null });
      expect(login.status).toBe(410);
      expect(login.headers.get('set-cookie')).toBeNull();
    } finally {
      await zTokenem.close();
    }
  });
});

/*
 * An authentication failure on the public surface must not append an identical line to the UNROTATED
 * `server.log` without a limit, a counter or a trace of the sender: an unauthenticated tailnet peer would get
 * a free, invisible channel to fill the Mac's disk. The same throttle counts an unknown device key (here) and
 * a wrong pairing code (`devices-pairing.test.ts`).
 */
describe('dławik nieudanych prób: nieznany klucz urządzenia', () => {
  const OBCY = deviceAuthorization('f'.repeat(32), 'Z'.repeat(43));
  const startZDlawikiem = async (budget: number): Promise<{ h: Harness; log: string[] }> => {
    const log: string[] = [];
    const harness = await startHarness({}, [makeSummary({ id: 's1' })], {
      logger: { info: (m) => log.push(m), error: () => {} },
      loginLimiter: createLoginLimiter({ budget, windowMs: 60_000 }),
    });
    return { h: harness, log };
  };

  it('powyżej budżetu porażek odpowiada 429 z Retry-After', async () => {
    const { h: hh } = await startZDlawikiem(3);
    try {
      const statusy: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statusy.push((await get(hh, '/api/projects', { auth: OBCY })).status);
      }
      expect(statusy).toEqual([401, 401, 401, 429, 429]);

      const ostatnia = await get(hh, '/api/projects', { auth: OBCY });
      expect(Number(ostatnia.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await ostatnia.json() as { error: string }).error).toBe('too-many-requests');
    } finally {
      await hh.close();
    }
  });

  it('ważny klucz przechodzi mimo wyczerpanego budżetu — dławik liczy wyłącznie porażki', async () => {
    const { h: hh } = await startZDlawikiem(2);
    try {
      for (let i = 0; i < 4; i += 1) {
        await get(hh, '/api/projects', { auth: OBCY });
      }
      // Właściciel NIE może zostać zamknięty poza własnym Rarogiem przez cudzy hałas.
      expect((await get(hh, '/api/projects')).status).toBe(200);
      expect((await get(hh, '/api/projects', { auth: OBCY })).status).toBe(429);
    } finally {
      await hh.close();
    }
  });

  it('30 porażek zostawia najwyżej 2 linie logu — z licznikiem i źródłem, bez sekretu', async () => {
    const { h: hh, log } = await startZDlawikiem(10);
    try {
      for (let i = 0; i < 30; i += 1) {
        await get(hh, '/api/projects', { auth: OBCY });
      }
      expect(log.length).toBeLessThanOrEqual(2);
      expect(log[0]).toContain('127.0.0.1');
      expect(log[1]).toMatch(/budget 10/);
      expect(log.join('\n')).not.toContain('Z'.repeat(43));
    } finally {
      await hh.close();
    }
  });

  /*
   * `X-Forwarded-For` dokłada Caddy, ale ustawić go może KAŻDY — wartość jest poszlaką,
   * nie dowodem, i dlatego do logu idzie tylko jej adresowy prefiks. Sam `\n` odsiewa już
   * warstwa HTTP; tu pilnujemy doklejonego tekstu, który przez nią przechodzi.
   */
  it('źródło z X-Forwarded-For trafia do logu obcięte do samego adresu', async () => {
    const { h: hh, log } = await startZDlawikiem(10);
    try {
      await get(hh, '/api/projects', {
        auth: OBCY, headers: { 'X-Forwarded-For': '100.64.0.9 udane parowanie (podszywka)' },
      });
      expect(log).toEqual(['failed device key attempt (100.64.0.9)']);
    } finally {
      await hh.close();
    }
  });
});

describe('Origin check (CSRF)', () => {
  it('obcy Origin → 403 zanim manager cokolwiek zrobi', async () => {
    const res = await post(h, '/api/sessions/s1/messages', { text: 'hej' }, {
      origin: 'https://zly.example',
    });
    expect(res.status).toBe(403);
    expect(h.manager.calls).toHaveLength(0);
  });

  it('brak Origin → 403', async () => {
    const res = await post(h, '/api/sessions/s1/messages', { text: 'hej' }, { origin: null });
    expect(res.status).toBe(403);
  });

  it('drugi origin z allow-listy (127.0.0.1) przechodzi', async () => {
    const res = await post(h, '/api/sessions/s1/messages', { text: 'hej' }, {
      origin: 'http://127.0.0.1:8930',
    });
    expect(res.status).toBe(202);
  });

  it('GET SSE nie wymaga Origin (chroni go SameSite=Strict)', async () => {
    const res = await get(h, '/api/version');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: h.config.version, protocolVersion: PROTOCOL_VERSION, serverStartId: 'start-1',
      voiceEnabled: h.config.voiceEnabled,
      // Flaga terminala PTY jedzie tym samym kanałem co `voiceEnabled` i z tego
      // samego powodu: PWA nie ma prawa pokazać wiersza, który oddaje 404. Harness routera
      // nie wstrzykuje ficzeru, więc `false` jest tu stanem poprawnym.
      termEnabled: false,
      /*
       * Ta sama rola i ten sam kanał dla notatek projektu: apka ma wiedzieć, czy pokazać
       * wejście, ZANIM ktoś w nie stuknie. Harness jedzie w trybie demo, a tam notatki działają
       * w pamięci procesu (`demo/notes.ts`) — `true` to domyślne `RAROG_NOTES`.
       */
      notesEnabled: true, companionEnabled: false, companionSpeech: false, // agent głosowy: demo nie ma trasy
      /*
       * Nazwa tailnetu dla nagłówka AGENCI. Harness nie wstrzykuje czytnika,
       * więc `null` — i to jest stan poprawny: serwer, który o Tailscale nic nie wie, ma
       * milczeć, a nie zgadywać. Pole jest w tym `toEqual` celowo: gdyby wyciekło do
       * `/health` (publiczny!) albo zniknęło z kontraktu, ten test to złapie.
       */
      tailnet: null,
      /*
       * Wiek ostatniego odpalenia hooka treści. Mieszka TUTAJ, a nie
       * w publicznym `/health`: znacznik pisze się przy KAŻDYM dialogu w każdej sesji
       * Claude pod korzeniami Raroga, więc odpytywany w pętli bez klucza składał się
       * w profil aktywności człowieka. Harness nie wstrzykuje sondy hooka → `null`.
       */
      hookSeenAgo: null,
      /*
       * Kanał APNs apki natywnej. Serwer nie ma nadajnika APNs, więc `false` — apka nie
       * pokazuje banera „Włącz powiadomienia".
       */
      apnsEnabled: false,
      // Server capabilities by name (`version.ts`): device keys and pairing, the voice agent and its mode across sessions.
      capabilities: ['device-auth', 'pair', 'pair-from-device', 'push-relay', 'push-e2e-v2', 'companion', 'companion-sessions', 'files', 'file-index'],
      // System maszyny: harness go nie wstrzykuje, więc router mówi system procesu testu (Mac albo Linux w CI).
      system: serverSystem(),
      // Serwer iroh: serwer bez nasłuchu iroh mówi `null`, apka łączy się przez HTTPS.
      iroh: null,
    });
  });

  it('system maszyny z zależności routera ląduje w `/api/version` (słowo „Mac” albo „VPS” w apce)', async () => {
    for (const system of ['macos', 'linux', 'other'] as const) {
      const withSystem = await startHarness({}, [makeSummary({ id: 's1' })], { system });
      try {
        const version = versionResponseSchema.parse(await (await get(withSystem, '/api/version')).json());
        expect(version.system, system).toBe(system);
      } finally {
        await withSystem.close();
      }
    }
  });

  it('wiek odpalenia hooka jest ZA AUTH — `/api/version` go niesie, `/health` nie', async () => {
    const withHook = await startHarness({}, [makeSummary({ id: 's1' })], {
      health: {
        herdr: () => Promise.resolve(false), term: false,
        hook: () => ({ status: 'ok', seenAgo: 12 }),
      },
    });
    try {
      const version = await (await get(withHook, '/api/version')).json() as {
        hookSeenAgo?: unknown;
      };
      expect(version.hookSeenAgo).toBe(12);
      // `/health` jest PUBLICZNY: zostaje samo SŁOWO stanu konfiguracji, bez ani jednej
      // liczby skorelowanej z tym, kiedy człowiek zatwierdza narzędzia.
      const health = await (await fetch(`${withHook.base}/health`)).json() as
        Record<string, unknown>;
      expect(health['hook']).toBe('ok');
      expect(Object.keys(health)).not.toContain('hookSeenAgo');
      // Bez znaczników per plik klucza `hookSeenAgoByFile` nie ma (złota odpowiedź `version.json` bez zmian).
      expect(Object.keys(version)).not.toContain('hookSeenAgoByFile');
    } finally {
      await withHook.close();
    }
  });

  it('wiek per plik wejściowy hooka też jest ZA AUTH — `/api/version` go niesie, `/health` nie', async () => {
    const byFile = { 'stary-pending.mjs': 40, 'rarog-pending.mjs': 3 };
    const withHook = await startHarness({}, [makeSummary({ id: 's1' })], {
      health: {
        herdr: () => Promise.resolve(false), term: false,
        hook: () => ({ status: 'stale', seenAgo: 3, seenAgoByFile: byFile }),
      },
    });
    try {
      const version = versionResponseSchema.parse(await (await get(withHook, '/api/version')).json());
      expect(version.hookSeenAgoByFile).toEqual(byFile);
      const health = await (await fetch(`${withHook.base}/health`)).json() as Record<string, unknown>;
      expect(JSON.stringify(health)).not.toContain('pending.mjs');
    } finally {
      await withHook.close();
    }
  });

  it('nazwa tailnetu z czytnika ląduje w `/api/version` — i tylko tam', async () => {
    const withTailnet = await startHarness({}, [makeSummary({ id: 's1' })], {
      tailnet: () => Promise.resolve('example.com'),
    });
    try {
      const version = await (await get(withTailnet, '/api/version')).json() as {
        tailnet?: unknown;
      };
      expect(version.tailnet).toBe('example.com');
      // `/health` jest PUBLICZNY (bez klucza) — nazwa sieci nie ma prawa się w nim pojawić.
      const health = await fetch(`${withTailnet.base}/health`);
      expect(JSON.stringify(await health.json())).not.toContain('example.com');
    } finally {
      await withTailnet.close();
    }
  });
});

describe('sesje', () => {
  it('wiadomość → 202 i przekazanie do managera', async () => {
    const res = await post(h, '/api/sessions/s1/messages', { text: 'zrób to' });
    expect(res.status).toBe(202);
    expect(h.manager.calls.at(-1)).toEqual({ method: 'sendMessage', args: ['s1', 'zrób to'] });
  });

  it('wiadomość do sesji w `starting` → 409 `session.not-accepting-messages` ze zdaniem managera', async () => {
    h.manager.throwOn['sendMessage'] = new ManagerBadStateError(
      say('session.not-accepting-messages', { id: 's1', state: 'starting' }),
    );
    const res = await post(h, '/api/sessions/s1/messages', { text: 'za wcześnie' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; messageRef?: { code: string; args?: string[] } };
    expect(body.error).toBe('bad-state');
    expect(body.messageRef).toEqual({ code: 'session.not-accepting-messages', args: ['s1', 'starting'] });
  });

  it('echo odroczone: `queueAware` dochodzi do managera, `queued` wraca w 202', async () => {
    const cid = '7e1d3c5b-2a4f-4c8e-9b6d-0f1e2d3c4b5a';
    h.manager.sendResult = { replayed: false, queued: true };
    const res = await post(h, '/api/sessions/s1/messages', { text: 'dopisek', clientMessageId: cid, queueAware: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, clientMessageId: cid, queued: true });
    expect(h.manager.calls.at(-1))
      .toEqual({ method: 'sendMessage', args: ['s1', 'dopisek', [], [], cid, { queueAware: true }] });

    // `queueAware: false` na drucie nie istnieje (literał `true` albo brak pola).
    expect((await post(h, '/api/sessions/s1/messages', { text: 'x', queueAware: false })).status).toBe(400);
  });

  it('wiadomość do nieznanej sesji → 404', async () => {
    expect((await post(h, '/api/sessions/nieznana/messages', { text: 'x' })).status).toBe(404);
  });

  it('złe ciało → 400', async () => {
    expect((await post(h, '/api/sessions/s1/messages', { tekst: 'x' })).status).toBe(400);
    expect((await post(h, '/api/sessions/s1/messages', 'to nie json')).status).toBe(400);
  });

  it('wiadomość z obrazkami → 202 i przekazanie załączników do managera', async () => {
    const res = await post(h, '/api/sessions/s1/messages', { text: 'popraw', images: [PNG, PNG] });
    expect(res.status).toBe(202);
    expect(h.manager.calls.at(-1))
      .toEqual({ method: 'sendMessage', args: ['s1', 'popraw', [PNG, PNG]] });
  });

  it('ponad 5 obrazków → 413 (a nie 400)', async () => {
    const res = await post(h, '/api/sessions/s1/messages', {
      text: '', images: Array.from({ length: 6 }, () => PNG),
    });
    expect(res.status).toBe(413);
    expect((await res.json() as { error: string }).error).toBe('payload-too-large');
    // Limit sprawdzany PRZED managerem — nic do niego nie doszło.
    expect(h.manager.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('obrazek ponad 1,5 MB → 413', async () => {
    const prefix = 'data:image/jpeg;base64,';
    const zaDuzy = prefix + 'A'.repeat(MAX_IMAGE_DATA_URL_BYTES - prefix.length + 1);
    const res = await post(h, '/api/sessions/s1/messages', { text: '', images: [zaDuzy] });
    expect(res.status).toBe(413);
    expect(h.manager.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('wiadomość z plikami → 202 i przekazanie ich do managera obok obrazków', async () => {
    const files = [{ name: 'raport.pdf', dataUrl: PDF }];
    const res = await post(h, '/api/sessions/s1/messages', { text: 'przejrzyj', files });
    expect(res.status).toBe(202);
    expect(h.manager.calls.at(-1))
      .toEqual({ method: 'sendMessage', args: ['s1', 'przejrzyj', [], files] });

    // Oba komplety naraz: pliki NIE wypierają obrazków i odwrotnie.
    await post(h, '/api/sessions/s1/messages', { text: 'oba', images: [PNG], files });
    expect(h.manager.calls.at(-1))
      .toEqual({ method: 'sendMessage', args: ['s1', 'oba', [PNG], files] });
  });

  it('ponad 4 pliki → 413 z komunikatem O PLIKACH, nie o obrazkach', async () => {
    const res = await post(h, '/api/sessions/s1/messages', {
      text: '', files: Array.from({ length: 5 }, () => ({ name: 'a.txt', dataUrl: PDF })),
    });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('payload-too-large');
    // Komunikat niesie instrukcję: „odepnij plik", a nie „zmniejsz zdjęcie".
    expect(body).toMatchObject({ message: 'At most 4 files per message.', messageRef: { code: 'uploads.too-many-files', args: ['4'] } });
    expect(h.manager.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('plik ponad limit → 413', async () => {
    const prefix = 'data:application/pdf;base64,';
    const zaDuzy = prefix + 'A'.repeat(MAX_FILE_DATA_URL_BYTES - prefix.length + 1);
    const res = await post(h, '/api/sessions/s1/messages', {
      text: '', files: [{ name: 'wielki.pdf', dataUrl: zaDuzy }],
    });
    expect(res.status).toBe(413);
    expect((await res.json() as { messageRef: { code: string } }).messageRef.code).toBe('uploads.file-too-large');
    expect(h.manager.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('plik ze ścieżką w nazwie albo bez treści base64 → 400', async () => {
    const zlaNazwa = await post(h, '/api/sessions/s1/messages', {
      text: '', files: [{ name: '../../.ssh/id_rsa', dataUrl: PDF }],
    });
    expect(zlaNazwa.status).toBe(400);

    const zlaTresc = await post(h, '/api/sessions/s1/messages', {
      text: '', files: [{ name: 'a.txt', dataUrl: 'data:text/plain,abc' }],
    });
    expect(zlaTresc.status).toBe(400);
    expect(h.manager.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('obrazek w złym formacie (svg/html) → 400', async () => {
    const res = await post(h, '/api/sessions/s1/messages', {
      text: '', images: ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    });
    expect(res.status).toBe(400);
  });

  it('limit ciała na /messages to 12 MB, nie 64 kB (ciało 200 kB przechodzi)', async () => {
    // Regresja na `readBody`: sufit CIAŁA musi zostawiać miejsce na zdjęcia z LTE. Ciało jest
    // tu duże od obrazków, bo sam `text` ma osobny, dużo mniejszy sufit (niżej).
    const res = await post(h, '/api/sessions/s1/messages', {
      text: 'x'.repeat(60_000),
      images: [PNG, PNG, PNG],
    });
    expect(res.status).toBe(202);
  });

  it('tekst ponad 64 kB → 400 (nie leci bracketed paste do cudzego panelu)', async () => {
    const res = await post(h, '/api/sessions/s1/messages', {
      text: 'x'.repeat(MAX_MESSAGE_TEXT_CHARS + 1),
    });
    expect(res.status).toBe(400);
    const graniczny = await post(h, '/api/sessions/s1/messages', {
      text: 'x'.repeat(MAX_MESSAGE_TEXT_CHARS),
    });
    expect(graniczny.status).toBe(202);
  });

  it('ciało /messages ponad 12 MB → 413', async () => {
    const res = await post(h, '/api/sessions/s1/messages', {
      text: 'x'.repeat(MAX_MESSAGE_BODY_BYTES + 1_000),
    });
    expect(res.status).toBe(413);
  });

  it('interrupt → 202, close → 200', async () => {
    expect((await post(h, '/api/sessions/s1/interrupt', {})).status).toBe(202);
    expect((await post(h, '/api/sessions/s1/close', {})).status).toBe(200);
  });

  /*
   * Odpowiedź na przerwanie niesie ŚWIEŻE `SessionSummary`, bo `fetch` idzie nowym
   * połączeniem i dojeżdża także wtedy, gdy `EventSource` umarł po cichu (klient czeka wtedy
   * 60–75 s na własnego watchdoga). `ok` zostaje dla klienta, który czyta wyłącznie status.
   */
  it('interrupt oddaje świeżą kartę sesji, nie samo `ok`', async () => {
    const res = await post(h, '/api/sessions/s1/interrupt', {});
    const body = await res.json() as { ok: boolean; session?: SessionSummary };
    expect(body.ok).toBe(true);
    expect(body.session?.id).toBe('s1');
    expect(body.session?.state).toBe(h.manager.get('s1')?.state);
  });

  /*
   * Los KLAWISZA jest trzystanowy, bo „przyjąłem żądanie" i „Esc doszedł do silnika" to
   * dwie różne chwile. Bez trzeciej wartości „jeszcze czekam" wchodzi klientowi w ścieżkę
   * sukcesu: apka mówi „przerwane" nad ŻYWĄ turą i oddaje prompt do pola, z którego jedno
   * tapnięcie dokleja tekst do tury, która trwa.
   */
  it('dostarczony escape → 202 z `delivered: "yes"`', async () => {
    const res = await post(h, '/api/sessions/s1/interrupt', {});
    expect(res.status).toBe(202);
    expect((await res.json() as { delivered?: string }).delivered).toBe('yes');
  });

  it('klawisz, który NIE poszedł, to nadal 202 ze świeżą kartą — `delivered: "no"`, nie błąd',
    async () => {
      /*
       * Przejście stanu poszło do klienta SYNCHRONICZNIE, więc 500 nad nim byłby gorszym
       * kłamstwem niż uczciwe „nie dostarczono".
       *
       * UWAGA na granicę odpowiedzialności: `false` z drivera znaczy tu „nie doszło", ale
       * przy `herdr-stalled` komenda się WYKONAŁA (herdr tylko nie doczekał się echa) i to
       * driver ma zamienić ten kod na `true` — router nie widzi kodu błędu i nie ma z czego
       * tego odróżnić.
       */
      const manager = new HeldInterruptManager([makeSummary({ id: 's1' })]);
      manager.deliver = false;
      const held = await startHarness({}, [], { manager });
      try {
        const res = await post(held, '/api/sessions/s1/interrupt', {});
        expect(res.status).toBe(202);
        const body = await res.json() as {
          ok: boolean; session?: SessionSummary; delivered?: string;
        };
        expect(body.delivered).toBe('no');
        expect(body.ok).toBe(true);
        expect(body.session?.id).toBe('s1');
      } finally {
        await held.close();
      }
    });

  it('po terminie endpoint odpowiada `delivered: "pending"` i NIE wisi na obietnicy drivera',
    async () => {
      /*
       * Termin jest warunkiem poprawności, nie wygodą: klient przerywa żądanie po 10 s
       * i PONAWIA je, więc endpoint czekający dłużej sam wyprodukowałby drugi `escape`.
       * Serwer nie utnie tego za nas (`server.requestTimeout = 0`), a `runManagerAction`
       * robi gołe `await`.
       */
      const manager = new HeldInterruptManager([makeSummary({ id: 's1' })]);
      manager.deliver = null;
      const held = await startHarness({}, [], { manager, interruptWaitMs: 40 });
      try {
        const started = Date.now();
        const res = await post(held, '/api/sessions/s1/interrupt', {});
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(res.status).toBe(202);
        const body = await res.json() as { session?: SessionSummary; delivered?: string };
        expect(body.delivered).toBe('pending');
        // Karta jedzie także przy `pending`: to nadal jedyna świeża prawda, gdy SSE milczy.
        expect(body.session?.id).toBe('s1');
      } finally {
        // Spóźnione rozstrzygnięcie nie ma już komu odpowiedzieć — i nie ma prawa niczego wywrócić.
        manager.settle(true);
        await held.close();
      }
    });

  it('odmowa przerwania nadal wraca jako 400, mimo asynchronicznego endpointu', async () => {
    // Odmowy (`outOfScope`, `RAROG_HERDR_SEND=0`) lecą z managera SYNCHRONICZNIE — gdyby
    // zamieniły się w odrzuconą obietnicę, telefon dostawałby 500 zamiast zdania mówiącego,
    // dlaczego Rarog nie dotyka tego panelu.
    h.manager.throwOn['interrupt'] = new BadRequestError('Panel leży poza korzeniami Raroga.');
    const res = await post(h, '/api/sessions/s1/interrupt', {});
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('bad-request');
  });

  it('domyślny termin przerwania jest KRÓTSZY niż timeout klienta', () => {
    // Klient przerywa żądanie po 10 s i ponawia je.
    // Termin równy albo dłuższy zamieniłby każde wolne przerwanie w drugi `escape`.
    expect(INTERRUPT_WAIT_MS).toBeLessThan(10_000);
  });

  it('resume niewznawialnej sesji → 409', async () => {
    h.manager.throwOn['resume'] = new BadStateError('sesja nie jest resumable');
    const res = await post(h, '/api/sessions/s1/resume', {});
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('bad-state');
  });

  it('resume działającej sesji → 200 z podsumowaniem', async () => {
    const res = await post(h, '/api/sessions/s1/resume', {});
    expect(res.status).toBe(200);
    expect((await res.json() as { sessionId: string }).sessionId).toBe('s1');
  });

  it('restart: 202 po wysłaniu /exit, odmowa managera → 409 z polskim zdaniem', async () => {
    const ok = await post(h, '/api/sessions/s1/restart', {});
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ sessionId: 's1' });
    expect(h.manager.calls.some((c) => c.method === 'restart' && c.args[0] === 's1')).toBe(true);

    h.manager.throwOn['restart'] = new BadStateError('Sesja pracuje — uruchomisz ją ponownie, gdy stanie.');
    const busy = await post(h, '/api/sessions/s1/restart', {});
    expect(busy.status).toBe(409);
    const body = await busy.json() as { error: string; message?: string };
    expect(body.error).toBe('bad-state');
    expect(body.message).toContain('uruchomisz ją ponownie');
  });

  it('restart z ponowną wysyłką: `seq` i `id` jadą do managera, tekst z ciała NIGDY', async () => {
    const plain = await post(h, '/api/sessions/s1/restart', {});
    expect(plain.status).toBe(202);
    const resend = await post(h, '/api/sessions/s1/restart', {
      resend: { seq: 7, id: 'b1', text: 'cudzy prompt' }, text: 'też cudzy',
    });
    expect(resend.status).toBe(202);
    const calls = h.manager.calls.filter((c) => c.method === 'restart').map((c) => c.args);
    expect(calls).toEqual([['s1', {}], ['s1', { resend: { seq: 7, id: 'b1' } }]]);
    expect(JSON.stringify(calls)).not.toContain('cudzy');

    const bad = await post(h, '/api/sessions/s1/restart', { resend: { seq: '7', id: 'b1' } });
    expect(bad.status).toBe(400);
    const fraction = await post(h, '/api/sessions/s1/restart', { resend: { seq: 7.5, id: 'b1' } });
    expect(fraction.status).toBe(400);
    // Sam `seq` nie wskazuje blokady (po restarcie karty numer się powtarza) — `id` jest wymagany.
    const noId = await post(h, '/api/sessions/s1/restart', { resend: { seq: 7 } });
    expect(noId.status).toBe(400);
    const numericId = await post(h, '/api/sessions/s1/restart', { resend: { seq: 7, id: 7 } });
    expect(numericId.status).toBe(400);
    expect(h.manager.calls.filter((c) => c.method === 'restart')).toHaveLength(2);
  });

  it('restart nieznanej sesji → 404', async () => {
    const res = await post(h, '/api/sessions/nie-ma/restart', {});
    expect(res.status).toBe(404);
  });

  it('nowa sesja tylko z cwd na allow-liście, a odpowiedź to 202 z samym sessionId', async () => {
    const zly = await post(h, '/api/sessions', { cwd: '/etc', prompt: 'hej' });
    expect(zly.status).toBe(400);
    expect((await zly.json() as { error: string }).error).toBe('cwd-not-allowed');

    const dobry = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/rarog', prompt: 'hej' });
    /*
     * 202, nie 200: panel powstaje w 1,4 ms, ale agent staje się gotowy po ~5 s. Blokujący
     * POST na te 5 s ginie przy zgaszeniu ekranu iOS i zostawia telefon ze spinnerem przy
     * ŻYWYM panelu — reszta startu jedzie po SSE.
     */
    expect(dobry.status).toBe(202);
    const body = await dobry.json() as { sessionId: string; state: string };
    expect(body.state).toBe('starting');
    expect(h.manager.get(body.sessionId)?.cwd).toBe('/tmp/rarog-demo/rarog');
  });

  it('nowa sesja BEZ promptu przechodzi (pusta sesja)', async () => {
    const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/rarog' });
    expect(res.status).toBe(202);
    expect(h.manager.calls.at(-1))
      .toEqual({ method: 'create', args: [{ cwd: '/tmp/rarog-demo/rarog' }] });
  });

  it('wznowienie z magazynu CLI to POLE w ciele, nie osobny endpoint', async () => {
    const res = await post(h, '/api/sessions', {
      cwd: '/tmp/rarog-demo/rarog',
      resumeFrom: '11111111-1111-4111-8111-111111111111',
    });
    expect(res.status).toBe(202);
    expect(h.manager.calls.at(-1)?.args).toEqual([{
      cwd: '/tmp/rarog-demo/rarog', resumeFrom: '11111111-1111-4111-8111-111111111111',
    }]);
  });

  it('`fork` bez `resumeFrom` odpada na kontrakcie (rozwidlać nie ma czego)', async () => {
    const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/rarog', fork: true });
    expect(res.status).toBe(400);
    expect(h.manager.calls.some((c) => c.method === 'create')).toBe(false);
  });

  it('`POST /api/sessions/resume-external` NIE ISTNIEJE (zastąpiony przez resumeFrom)', async () => {
    const res = await post(h, '/api/sessions/resume-external', {
      cwd: '/tmp/rarog-demo/rarog', engineSessionId: 'e1',
    });
    // Segment jest teraz zwykłym identyfikatorem sesji, a takiej sesji nie ma.
    expect(res.status).toBe(404);
  });

  /*
   * A mapping `HerdrUntrustedCwdError` → `herdr-untrusted` would be a DEAD branch: no production line
   * throws this error (missing trust travels in the `trustPrompt` field of the 202). Code the server never
   * emits protects nothing; this test guards that the branch does not appear unnoticed.
   */
  it('błąd o nazwie `HerdrUntrustedCwdError` NIE dostaje już osobnego kodu (gałąź usunięta)',
    async () => {
      const err = Object.assign(new Error('Ten katalog nie jest jeszcze zaufany przez Claude Code.'), {
        sentence: foreign('Ten katalog nie jest jeszcze zaufany przez Claude Code.'),
      });
      err.name = 'HerdrUntrustedCwdError';
      (err as { code?: string }).code = 'bad-state';
      h.manager.throwOn['create'] = err;

      const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/rarog' });
      expect(res.status).toBe(409);
      // Komunikat managera jedzie dosłownie — zmienia się WYŁĄCZNIE kod.
      expect(await res.json()).toEqual({ error: 'bad-state', message: err.message });
    });

  it('inne 409 przy zakładaniu zostaje przy `bad-state` (kod jest dla JEDNEJ sytuacji)',
    async () => {
      const err = new Error('Limit paneli Raroga osiągnięty.');
      err.name = 'BadStateError';
      h.manager.throwOn['create'] = err;

      const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/rarog' });
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toBe('bad-state');
    });

  it('prompt złego typu nadal jest odrzucany', async () => {
    const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/rarog', prompt: 42 });
    expect(res.status).toBe(400);
  });

  it('nieznany błąd managera → 500 (nie wywala procesu)', async () => {
    h.manager.throwOn['interrupt'] = new Error('coś padło');
    expect((await post(h, '/api/sessions/s1/interrupt', {})).status).toBe(500);
  });
});

describe('wznawianie sesji z magazynu CLI', () => {
  const WPIS = {
    engineSessionId: 'e1',
    cwd: '/tmp/rarog-demo/rarog',
    mtime: '2026-08-21T10:00:00.000Z',
    firstPrompt: 'Popraw zapis notatek.',
    gitBranch: 'fix/zapis',
    liveInHerdr: false,
  };

  it('GET /api/resumable oddaje listę dla katalogu z allow-listy', async () => {
    h.manager.resumableResult = [WPIS];
    const res = await get(h, '/api/resumable?cwd=%2Ftmp%2Frarog-demo%2Frarog');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [WPIS] });
    expect(h.manager.calls.at(-1))
      .toEqual({ method: 'resumable', args: ['/tmp/rarog-demo/rarog'] });
  });

  it('GET /api/resumable bez cwd albo z cwd spoza listy → 400 i zero pytań do managera', async () => {
    for (const path of ['/api/resumable', '/api/resumable?cwd=/etc']) {
      const res = await get(h, path);
      expect(res.status, path).toBe(400);
      expect((await res.json() as { error: string }).error).toBe('cwd-not-allowed');
    }
    expect(h.manager.calls.some((c) => c.method === 'resumable')).toBe(false);
  });

  it('GET /api/projects/recent oddaje ostatnie projekty i ścina `limit` do sufitu', async () => {
    const projekt = { cwd: '/tmp/rarog-demo/rarog', mtime: '2026-09-10T10:00:00.000Z' };
    h.manager.recentProjectsResult = [projekt];
    const res = await get(h, '/api/projects/recent');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projects: [projekt] });
    expect(h.manager.calls.at(-1)).toEqual({ method: 'recentProjects', args: ['13'] });
    for (const [query, expected] of [['?limit=3', '3'], ['?limit=99', '13'], ['?limit=x', '13']] as const) {
      await get(h, `/api/projects/recent${query}`);
      expect(h.manager.calls.at(-1), query).toEqual({ method: 'recentProjects', args: [expected] });
    }
  });

  it('GET /api/projects/recent wymaga klucza urządzenia i metody GET', async () => {
    expect((await get(h, '/api/projects/recent', { auth: null })).status).toBe(401);
    const res = await post(h, '/api/projects/recent', {});
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('GET /api/resumable/recent oddaje ostatnie sesje WSKAZANEGO projektu', async () => {
    h.manager.recentResumableResult = [WPIS];
    const res = await get(h, '/api/resumable/recent?cwd=%2Ftmp%2Frarog-demo%2Frarog');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [WPIS] });
    expect(h.manager.calls.at(-1))
      .toEqual({ method: 'recentResumable', args: ['/tmp/rarog-demo/rarog', '10'] });
  });

  it('GET /api/resumable/recent bez `cwd` albo z cwd spoza listy → 400', async () => {
    for (const path of ['/api/resumable/recent', '/api/resumable/recent?cwd=/etc']) {
      const res = await get(h, path);
      expect(res.status, path).toBe(400);
      expect((await res.json() as { error: string }).error).toBe('cwd-not-allowed');
    }
  });

  it('GET /api/resumable/recent przycina `limit` do sufitu kontraktu', async () => {
    h.manager.recentResumableResult = [];
    const cwd = 'cwd=%2Ftmp%2Frarog-demo%2Frarog';
    for (const [query, expected] of [['&limit=3', '3'], ['&limit=999', '10'], ['&limit=abc', '10'],
      ['&limit=-2', '10'], ['&limit=2.7', '2']] as const) {
      await get(h, `/api/resumable/recent?${cwd}${query}`);
      expect(h.manager.calls.at(-1), query)
        .toEqual({ method: 'recentResumable', args: ['/tmp/rarog-demo/rarog', expected] });
    }
  });

  it('GET /api/resumable/recent wymaga klucza urządzenia i metody GET', async () => {
    expect((await get(h, '/api/resumable/recent?cwd=/tmp/rarog-demo/rarog', { auth: null })).status)
      .toBe(401);
    const res = await post(h, '/api/resumable/recent', {});
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('GET /api/resumable wymaga klucza urządzenia i metody GET', async () => {
    expect((await get(h, '/api/resumable?cwd=/tmp/rarog-demo/rarog', { auth: null })).status)
      .toBe(401);
    const res = await post(h, '/api/resumable', {});
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

});

describe('permissions i answers — first-wins', () => {
  it('200 dla pierwszej decyzji, 409 dla kolejnej, 410 dla wygasłej', async () => {
    h.manager.permissionOutcomes = ['ok', 'conflict', 'gone'];
    const body = { decision: 'allow' as const };
    const p = '/api/sessions/s1/permissions/perm-1';
    expect((await post(h, p, body)).status).toBe(200);
    expect((await post(h, p, body)).status).toBe(409);
    expect((await post(h, p, body)).status).toBe(410);
  });

  it('przekazuje decyzję, message i etykietę urządzenia jako `by`', async () => {
    h.manager.permissionOutcomes = ['ok'];
    await post(h, '/api/sessions/s1/permissions/perm-1', { decision: 'deny', message: 'nie' });
    expect(h.manager.calls.at(-1)?.args)
      .toEqual(['s1', 'perm-1', 'deny', 'iPhone·test', 'nie']);
  });

  it('odrzuca decyzję spoza enum', async () => {
    const res = await post(h, '/api/sessions/s1/permissions/perm-1', { decision: 'moze' });
    expect(res.status).toBe(400);
  });

  it('answers mapuje 200/409/410 tak samo', async () => {
    h.manager.answerOutcomes = ['ok', 'conflict', 'gone'];
    const p = '/api/sessions/s1/answers/q-1';
    const body = { answers: [['tak']] };
    expect((await post(h, p, body)).status).toBe(200);
    expect((await post(h, p, body)).status).toBe(409);
    expect((await post(h, p, body)).status).toBe(410);
  });

  it('odmowa drivera to 422 z powodem — NIE 409 (karta ma zostać na ekranie)', async () => {
    /*
     * 409 znaczy dla PWA „drugie urządzenie było pierwsze" i gasi kartę. Po odmowie dialog
     * stoi dalej w terminalu, a pending w managerze nie został zużyty — więc karta ma zostać,
     * a przy przycisku ma stanąć powód. Stąd osobny kod.
     */
    h.manager.permissionOutcomes = [{ outcome: 'refused', reason: 'terminal-only' }];
    const res = await post(h, '/api/sessions/s1/permissions/perm-1', { decision: 'allow' });
    expect(res.status).toBe(422);
    const parsed = decisionRefusedBodySchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.reason).toBe('terminal-only');
    expect(parsed.data?.message).toBe(REFUSE_MESSAGES['terminal-only']);
  });

  it('to samo dla odpowiedzi na pytanie agenta', async () => {
    h.manager.answerOutcomes = [{ outcome: 'refused', reason: 'multi-select' }];
    const res = await post(h, '/api/sessions/s1/answers/q-1', { answers: [['tak']] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: 'refused', reason: 'multi-select',
      message: 'Make multiple selections in the terminal. Rarog sends only one digit.',
      messageRef: { code: 'dialogs.refuse.multi-select' },
    });
  });

  it('dialog adresowany sesją też oddaje 422 (ta sama ścieżka, inny endpoint)', async () => {
    h.manager.permissionOutcomes = [{ outcome: 'refused', reason: 'screen-changed' }];
    const res = await post(h, '/api/sessions/s1/permission', { decision: 'allow' });
    expect(res.status).toBe(422);
    expect((await res.json() as { error?: string }).error).toBe('refused');
  });
});

describe('client-log', () => {
  it('przyjmuje paczkę zdarzeń', async () => {
    const res = await post(h, '/api/client-log', {
      events: [{ at: '2026-08-21T10:00:00.000Z', level: 'error', msg: 'onerror: boom' }],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, written: 1 });
  });

  it('User-Agent apki daje pole `client` zapisanej linii, inny User-Agent — etykietę urządzenia z parowania', async () => {
    const events = [{ at: '2026-10-02T10:00:00.000Z', level: 'debug', msg: 'natyw start' }];
    const app = await post(h, '/api/client-log', { events }, {
      headers: { 'User-Agent': 'RarogApp/1416 CFNetwork/3896 Darwin/27.0.0' },
    });
    const phone = await post(h, '/api/client-log', { events }, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)' },
    });
    expect([app.status, phone.status]).toEqual([202, 202]);
    const lines = (await readFile(clientLogPath(h.config), 'utf8')).trimEnd().split('\n');
    expect(lines.slice(-2).map((line) => (JSON.parse(line) as { client?: string }).client))
      .toEqual(['app/1416', 'iPhone·test']);
  });

  it('User-Agent natywnej apki (`RarogApp/<build>`) daje w linii `client: app/<build>`', async () => {
    const events = [{ at: '2026-10-04T10:00:00.000Z', level: 'info', msg: 'apka start' }];
    const res = await post(h, '/api/client-log', { events }, {
      headers: { 'User-Agent': 'RarogApp/42 CFNetwork/3896 Darwin/27.0.0' },
    });
    expect(res.status).toBe(202);
    const lines = (await readFile(clientLogPath(h.config), 'utf8')).trimEnd().split('\n');
    expect((JSON.parse(lines.at(-1) ?? '{}') as { client?: string }).client).toBe('app/42');
  });

  it('ciało ponad 64 kB → 413', async () => {
    const res = await post(h, '/api/client-log', {
      events: [{ at: '2026-08-21T10:00:00.000Z', level: 'info', msg: 'x'.repeat(70_000) }],
    });
    expect(res.status).toBe(413);
  });
});

describe('SSE przez prawdziwy socket', () => {
  it('/api/stream oddaje nagłówki SSE, hello i sessions-snapshot', async () => {
    const res = await fetch(`${h.base}/api/stream`, { headers: { Authorization: h.auth } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('sessions-snapshot')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(text).toContain('retry: 3000');
    expect(text).toContain('"type":"hello"');
    expect(text).toContain(`"protocolVersion":${String(PROTOCOL_VERSION)}`);
    expect(text).toContain('"type":"sessions-snapshot"');
  });

  it('strumień nieznanej sesji → 404', async () => {
    expect((await get(h, '/api/sessions/nieznana/stream')).status).toBe(404);
  });

  /*
   * Kursor niesie PROCES, który go nadał: `id:` ramki to `<serverStartId>:<seq>`, a klient
   * odsyła go dosłownie. Bez prefiksu kursor jest obcy i kończy się snapshotem — patrz niżej.
   */
  it('?since= działa jak Last-Event-ID dla świeżego EventSource', async () => {
    h.manager.eventsSinceResult = { tooOld: false, events: [] };
    const res = await fetch(`${h.base}/api/sessions/s1/stream?since=start-1%3A17`, {
      headers: { Authorization: h.auth },
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(h.manager.calls.some((c) => c.method === 'eventsSince' && c.args[1] === 17)).toBe(true);
  });

  it('nagłówek Last-Event-ID wygrywa z ?since= (kanon SSE ma pierwszeństwo)', async () => {
    h.manager.eventsSinceResult = { tooOld: false, events: [] };
    const res = await fetch(`${h.base}/api/sessions/s1/stream?since=start-1%3A17`, {
      headers: { Authorization: h.auth, 'Last-Event-ID': 'start-1:42' },
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(h.manager.calls.some((c) => c.method === 'eventsSince' && c.args[1] === 42)).toBe(true);
  });

  /*
   * Kursor z POPRZEDNIEGO procesu (restart serwera — a ten leci po każdej zmianie w `server/`)
   * ma inny prefiks, więc nie ma prawa uruchomić replayu: `seq` z tamtego procesu nie znaczy
   * w tym ring bufferze nic, a replay zamiast snapshotu gubił odtworzone karty zgody.
   */
  it('?since= z kursorem obcego procesu → snapshot, nie replay', async () => {
    h.manager.eventsSinceResult = { tooOld: false, events: [] };
    const res = await fetch(`${h.base}/api/sessions/s1/stream?since=poprzedni%3A17`, {
      headers: { Authorization: h.auth },
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(h.manager.calls.some((c) => c.method === 'eventsSince')).toBe(false);
    expect(h.manager.calls.some((c) => c.method === 'transcript')).toBe(true);
  });

  it('śmieciowe ?since= to brak kursora (pełny snapshot), a nie 500', async () => {
    h.manager.eventsSinceResult = { tooOld: false, events: [] };
    const res = await fetch(`${h.base}/api/sessions/s1/stream?since=abc`, {
      headers: { Authorization: h.auth },
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    // Brak kursora = pełny snapshot: `eventsSince` nie ma po co pytać.
    expect(h.manager.calls.some((c) => c.method === 'eventsSince')).toBe(false);
    expect(h.manager.calls.some((c) => c.method === 'transcript')).toBe(true);
  });
});

describe('routing brzegowy', () => {
  it('nieznana ścieżka → 404', async () => {
    expect((await get(h, '/api/nie-ma')).status).toBe(404);
  });

  it('zła metoda → 405 z nagłówkiem Allow', async () => {
    const res = await post(h, '/api/projects', {});
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

describe('mapowanie błędów managera', () => {
  it('rozpoznaje NotFound i BadState po code/name', () => {
    expect(managerErrorStatus(new NotFoundError('x'))).toBe(404);
    expect(managerErrorStatus(new BadStateError('x'))).toBe(409);
    expect(managerErrorStatus(new Error('x'))).toBe(500);
    expect(managerErrorStatus(null)).toBe(500);
    expect(managerErrorStatus({ code: 'BAD_STATE' })).toBe(409);
  });

  it('BadRequest z managera (np. cwd spoza allow-listy) → 400', () => {
    expect(managerErrorStatus({ name: 'BadRequestError' })).toBe(400);
  });

  it('BadRequest z create nie kończy się 500', async () => {
    h.manager.throwOn['create'] = Object.assign(new Error('cwd spoza listy'), {
      name: 'BadRequestError', sentence: foreign('cwd spoza listy'),
    });
    const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/rarog', prompt: 'hej' });
    expect(res.status).toBe(400);
    // Inna odmowa niż bramka ultracode zostaje przy ogólnym kodzie: apka pokazuje ją przy polu ścieżki.
    expect(await res.json()).toEqual({ error: 'bad-request', message: 'cwd spoza listy' });
  });

  it('wyjątek bez zdania (`sentence`) dostaje zdanie ogólne statusu — `err.message` nie wychodzi', async () => {
    h.manager.throwOn['create'] = Object.assign(new Error('ENOENT: /Users/u/tajny/katalog'), {
      name: 'BadRequestError',
    });
    const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/rarog', prompt: 'hej' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'bad-request', message: 'Request rejected.', messageRef: { code: 'rest.bad-request' },
    });
  });

  it('zdanie obce (`foreign`) w wyjątku też jedzie dosłownie: `errorBodyOf` czyta każdą formę tekstu', async () => {
    h.manager.throwOn['create'] = Object.assign(new Error('x'), {
      name: 'BadStateError', sentence: foreign('herdr: pane is busy'),
    });
    const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/rarog', prompt: 'hej' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'bad-state', message: 'herdr: pane is busy' });
  });
});

/*
 * Te przypadki są UNIT-owe (bez socketu), bo dziura, której pilnują, jest niewidoczna
 * w harnessie demo: `path.resolve('')` to katalog roboczy SERWERA, a atrapa managera zawsze
 * zwraca tę samą, stałą listę projektów. W trybie realnym lista projektów powstaje ze SKANU
 * `RAROG_PROJECT_ROOTS`, więc katalog, z którego uruchomiono serwer, zwykle NA NIEJ JEST —
 * i wtedy żądanie bez `cwd` przechodziło jako „to jeden z projektów".
 */
describe('checkCwd — ścieżki względne nie mogą wskazać katalogu serwera', () => {
  const real = (roots: string): RarogConfig =>
    loadConfig({ RAROG_ORIGINS: ORIGIN, RAROG_PROJECT_ROOTS: roots });

  /** Atrapa listy projektów zawierającej katalog roboczy serwera — jak w trybie realnym. */
  const managerWithCwdProject = (): ManagerApi => ({
    ...new FakeManager([]),
    projects: () => [{ path: process.cwd(), name: 'rarog' }],
  } as unknown as ManagerApi);

  it('pusty cwd nie rozwija się do katalogu serwera, tylko daje komunikat o brakującej ścieżce', () => {
    const config = real(process.cwd());
    for (const input of ['', '   ']) {
      const check = checkCwd(input, config, managerWithCwdProject());
      expect(check.ok, JSON.stringify(input)).toBe(false);
      if (!check.ok) expect(check.sentence.ref.code).toBe('rest.cwd-empty');
    }
  });

  it('`.` i `..` też odpadają — inaczej celowałyby w katalog roboczy serwera', () => {
    const config = real(process.cwd());
    for (const input of ['.', '..', 'Projects/rarog']) {
      const check = checkCwd(input, config, managerWithCwdProject());
      expect(check.ok, input).toBe(false);
    }
  });

  it('ścieżka bezwzględna z listy projektów nadal przechodzi', () => {
    const check = checkCwd(process.cwd(), real(process.cwd()), managerWithCwdProject());
    expect(check).toEqual({ ok: true, cwd: process.cwd() });
  });

  it('tylda leci do walidacji korzeni surowa (to ona ją rozwija)', () => {
    // Korzeń nie zawiera `~/nie-ma`, więc oczekujemy odmowy Z WALIDACJI, nie z guardu.
    const check = checkCwd('~/nie-ma-takiego-katalogu', real(process.cwd()), managerWithCwdProject());
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.sentence.ref.code).not.toBe('rest.cwd-not-absolute');
  });
});

describe('clientLabel', () => {
  const req = (headers: Record<string, string>) =>
    ({ headers } as unknown as Parameters<typeof clientLabel>[0]);

  it('rozpoznaje urządzenia po user-agent', () => {
    expect(clientLabel(req({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0)' })))
      .toBe('iPhone');
    expect(clientLabel(req({ 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 26_0)' }))).toBe('iPad');
    expect(clientLabel(req({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' })))
      .toBe('Mac');
    expect(clientLabel(req({}))).toBe('another device');
  });

  it('jawny nagłówek X-Rarog-Client wygrywa i jest przycinany', () => {
    expect(clientLabel(req({ 'x-rarog-client': 'iPhone Jana' }))).toBe('iPhone Jana');
    expect(clientLabel(req({ 'x-rarog-client': 'a'.repeat(80) }))).toHaveLength(40);
  });
});

// ---------------------------------------------------------------------------
// git pull/push, diff
// ---------------------------------------------------------------------------

/*
 * Klient nie ma mutacji gita: z apki `git pull`/`push` idzie wyłącznie przez terminal. Strażnik
 * pilnuje, żeby żadna z tych tras nie powstała po cichu — także z poprawnym kluczem i originem.
 */
describe('dawne trasy gita nie istnieją', () => {
  it.each([
    ['POST', '/api/sessions/s1/git/pull'],
    ['POST', '/api/sessions/s1/git/push'],
    ['GET', '/api/git/status?cwd=/x'],
    ['POST', '/api/git/checkout'],
    ['POST', '/api/git/push'],
  ] as const)('%s %s → 404', async (method, url) => {
    const res = method === 'GET' ? await get(h, url) : await post(h, url, {});
    expect(res.status).toBe(404);
  });
});

describe('GET /api/sessions/:id/diff', () => {
  it('oddaje kształt kontraktowy z managera', async () => {
    h.manager.diffResult = {
      files: [{ path: 'src/notes.ts', status: 'M', linesAdded: 3, linesDeleted: 1 }],
      patch: 'diff --git a/src/notes.ts b/src/notes.ts\n',
      truncated: false,
    };

    const res = await get(h, '/api/sessions/s1/diff');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(h.manager.diffResult);
  });

  it('nieznana sesja to 404', async () => {
    const res = await get(h, '/api/sessions/nie-ma/diff');
    expect(res.status).toBe(404);
  });

  it('POST na diff jest niedozwolony (read-only)', async () => {
    const res = await post(h, '/api/sessions/s1/diff', {});
    expect(res.status).toBe(405);
  });

  it('bez klucza 401', async () => {
    const res = await get(h, '/api/sessions/s1/diff', { auth: null });
    expect(res.status).toBe(401);
  });
});

/*
 * Diff per plik: dwie trasy obok starej. Kolektory i granicę ścieżki pilnują
 * `git-diff.test.ts` i `git-diff-repo.test.ts` — tu stoi warstwa HTTP: dowóz parametru `path`
 * co do znaku i jawne mapowanie odmów na status, KOD i zdanie.
 */
describe('GET /api/sessions/:id/diff/files i /diff/file', () => {
  it('lista: kształt kontraktowy z managera, bez cache', async () => {
    h.manager.diffFilesResult = {
      files: [
        { path: 'src/notes.ts', status: 'M', linesAdded: 3, linesDeleted: 1 },
        { path: 'logo.png', status: 'M', binary: true },
        { path: 'docs/nowy.md', status: 'A' },
      ],
      truncated: true,
    };

    const res = await get(h, '/api/sessions/s1/diff/files');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(h.manager.diffFilesResult);
    expect(h.manager.calls).toEqual([{ method: 'diffFiles', args: ['s1'] }]);
  });

  it('plik: `path` dochodzi do managera co do znaku — plus, spacja, procent, `&`, `#`, tabulator, nie-ASCII', async () => {
    h.manager.diffFilePatch = 'diff --git a/x b/x\n';
    for (const name of [
      'src/notes.ts', 'a+b.ts', 'ze spacją.txt', '100%.txt', '%2e%2e/x', 'a&b=c.txt', 'x#y.txt', 'tab\there.txt',
      'zażółć/ś.txt', '?path=inna', 'a\\b.txt', '-x',
    ]) {
      h.manager.calls.length = 0;
      const res = await get(h, `/api/sessions/s1/diff/file?path=${encodeURIComponent(name)}`);
      expect(res.status, name).toBe(200);
      expect(await res.json(), name).toEqual({ path: name, patch: 'diff --git a/x b/x\n', truncated: false });
      expect(h.manager.calls, name).toEqual([{ method: 'diffFile', args: ['s1', name] }]);
    }
  });

  it('plus NIEZAKODOWANY to spacja, a brak parametru to pusty napis — manager dostaje to, co stoi w adresie', async () => {
    await get(h, '/api/sessions/s1/diff/file?path=src/a+b.ts');
    await get(h, '/api/sessions/s1/diff/file');
    await get(h, '/api/sessions/s1/diff/file?path=pierwsza&path=druga');
    expect(h.manager.calls.map((call) => call.args[1])).toEqual(['src/a b.ts', '', 'pierwsza']);
  });

  it('odmowy kolektora mają status, kod i zdanie: bad-path 400, diff-file-not-found 404, git-failed 503', async () => {
    for (const [code, status] of [['bad-path', 400], ['diff-file-not-found', 404], ['git-failed', 503]] as const) {
      // Komunikat wyjątku NIE wychodzi do klienta: zdanie dobiera router po kodzie.
      h.manager.throwOn['diffFile'] = Object.assign(new Error('wewnętrzny opis'), { code });
      const res = await get(h, '/api/sessions/s1/diff/file?path=src/a.ts');
      expect(res.status, code).toBe(status);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe(code);
      expect(body.message).not.toBe('');
      expect(JSON.stringify(body)).not.toContain('wewnętrzny opis');
      expect(JSON.stringify(body)).not.toContain('src/a.ts');
    }
    h.manager.throwOn['diffFiles'] = Object.assign(new Error('x'), { code: 'git-failed' });
    const list = await get(h, '/api/sessions/s1/diff/files');
    expect(list.status).toBe(503);
    expect(await list.json()).toEqual({
      error: 'git-failed', message: "Git didn't respond. Try again.", messageRef: { code: 'rest.diff-git-failed' },
    });
  });

  it('brak sesji to 404 `session-not-found` — inny kod niż `not-found` nieznanej trasy', async () => {
    for (const path of ['/api/sessions/nie-ma/diff/files', '/api/sessions/nie-ma/diff/file?path=a.ts']) {
      const res = await get(h, path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({
        error: 'session-not-found', message: "That session doesn't exist.", messageRef: { code: 'rest.session-not-found' },
      });
    }
    // Stara trasa zostaje przy swoim ciele (stara apka czyta je bez zmian).
    expect(await (await get(h, '/api/sessions/nie-ma/diff')).json())
      .toEqual({ error: 'not-found', message: "That session doesn't exist.", messageRef: { code: 'rest.session-not-found' } });
  });

  it('wpis Codexa i sesja poza zasięgiem: 400 `bad-request` ze zdaniem managera', async () => {
    const sentence = 'Panel jest poza RAROG_HERDR_ROOTS — Rarog pokazuje jego stan, ale nie zmiany w katalogu.';
    h.manager.throwOn['diffFiles'] = new BadRequestError(sentence);
    h.manager.throwOn['diffFile'] = new BadRequestError(sentence);
    for (const path of ['/api/sessions/s1/diff/files', '/api/sessions/s1/diff/file?path=a.ts']) {
      const res = await get(h, path);
      expect(res.status, path).toBe(400);
      expect(await res.json(), path).toEqual({ error: 'bad-request', message: sentence });
    }
  });

  it('nieznany wyjątek to 500 bez treści wyjątku', async () => {
    h.manager.throwOn['diffFiles'] = new Error('ENOENT: /Users/u/tajny/katalog');
    const res = await get(h, '/api/sessions/s1/diff/files');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal', message: 'Server error.', messageRef: { code: 'rest.internal' } });
  });

  it('obie trasy są tylko do odczytu (405 na POST) i stoją za kluczem urządzenia (401)', async () => {
    for (const path of ['/api/sessions/s1/diff/files', '/api/sessions/s1/diff/file?path=a.ts']) {
      const posted = await post(h, path, {});
      expect(posted.status, path).toBe(405);
      expect(posted.headers.get('allow'), path).toBe('GET');
      expect((await get(h, path, { auth: null })).status, path).toBe(401);
    }
    expect(h.manager.calls).toEqual([]);
  });

  /*
   * Po tym nowa apka pozna serwer SPRZED tych tras: `GET` pod `/api/sessions/:id/…`, którego router
   * nie zna, wpada w strażnika metody i dostaje 405 `method-not-allowed` — a nie 404 `not-found`
   * („That endpoint doesn't exist."), które dostają nieznane trasy poza sesją. Podtrasa obok
   * (`/diff/inne`) idzie dziś dokładnie tą drogą, którą na starszym serwerze szły `/diff/files`.
   */
  it('nieznana podtrasa diffa: 405 ze strażnika metody, manager nietknięty', async () => {
    for (const path of ['/api/sessions/s1/diff/inne', '/api/sessions/s1/diff/files/x', '/api/sessions/s1/diff/file/x']) {
      const res = await get(h, path);
      expect(res.status, path).toBe(405);
      expect(await res.json(), path).toMatchObject({ error: 'method-not-allowed' });
    }
    expect((await get(h, '/api/nie-ma-takiej-trasy')).status).toBe(404);
    expect(h.manager.calls).toEqual([]);
  });
});

/*
 * Znalezisko audytu APP-10: `server.requestTimeout = 0` (konieczne dla SSE) zdejmowało sufit
 * czasu z KAŻDEGO żądania, a po 413 serwer w nieskończoność sączył ciało, które już odrzucił.
 * Limit siedzi teraz tam, gdzie faktycznie czytamy ciało — i musi domykać obie ścieżki.
 */
describe('readBody — sufit czasu na odebranie ciała', () => {
  /** Atrapa `IncomingMessage`: tyle strumienia, ile `readBody` naprawdę czyta. */
  class FakeRequest extends EventEmitter {
    resumed = 0;
    destroyed = 0;

    resume(): this {
      this.resumed += 1;
      return this;
    }

    destroy(): this {
      this.destroyed += 1;
      return this;
    }
  }

  const asRequest = (req: FakeRequest): Parameters<typeof readBody>[0] =>
    req as unknown as Parameters<typeof readBody>[0];

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('żądanie domówione w czasie czyta się normalnie i nie zrywa gniazda', async () => {
    const req = new FakeRequest();
    const promise = readBody(asRequest(req), 1024, 1_000);
    req.emit('data', Buffer.from('{"a":1}'));
    req.emit('end');

    await expect(promise).resolves.toEqual({ ok: true, text: '{"a":1}' });
    expect(req.destroyed).toBe(0);
  });

  it('ciało dosyłane bez końca zrywa gniazdo po limicie', async () => {
    const req = new FakeRequest();
    const promise = readBody(asRequest(req), 1024, 1_000);
    req.emit('data', Buffer.from('a'));

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(promise).resolves.toEqual({ ok: false, reason: 'io-error' });
    expect(req.destroyed).toBe(1);
  });

  it('po 413 sączenie reszty ciała też ma koniec', async () => {
    const req = new FakeRequest();
    const promise = readBody(asRequest(req), 4, 1_000);
    req.emit('data', Buffer.from('ponad limit'));

    // Klient dostaje 413 od razu — gniazdo jeszcze żyje, żeby odpowiedź do niego doszła.
    await expect(promise).resolves.toEqual({ ok: false, reason: 'too-large' });
    expect(req.resumed).toBe(1);
    expect(req.destroyed).toBe(0);

    // ...ale nie w nieskończoność.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(req.destroyed).toBe(1);
  });

  it('domyślny limit jest skończony i ma zapas na 12 MB zdjęć z LTE', () => {
    expect(BODY_TIMEOUT_MS).toBeGreaterThan(60_000);
    expect(Number.isFinite(BODY_TIMEOUT_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Modele, effort i przeglądarka katalogów
// ---------------------------------------------------------------------------

describe('GET /api/models', () => {
  it('oddaje kontraktowy kształt listy modeli', async () => {
    const res = await get(h, '/api/models');
    expect(res.status).toBe(200);
    const body = modelListSchema.parse(await res.json());
    expect(body.models.map((m) => m.value)).toContain('fable');
    // Pola `source` nie ma: po wycięciu SDK nie istnieje drugie źródło listy.
    expect('source' in body).toBe(false);
  });

  it('oddaje dokładnie to, co dał manager', async () => {
    h.manager.modelList = {
      models: [{ value: 'claude-fable-5-1', label: 'Fable 5.1', effortLevels: ['high', 'max'] }],
    };
    const body = modelListSchema.parse(await (await get(h, '/api/models')).json());
    expect(body.models).toHaveLength(1);
  });

  it('bez klucza 401, POST to 405', async () => {
    expect((await get(h, '/api/models', { auth: null })).status).toBe(401);
    expect((await post(h, '/api/models', {})).status).toBe(405);
  });
});

describe('GET /api/sessions/:id/commands', () => {
  it('oddaje kontraktowy kształt listy, dokładnie to, co dał manager dla TEJ sesji', async () => {
    h.manager.commandList = {
      revision: 'abc123',
      commands: [
        { name: 'compact', kind: 'local', source: 'builtin' },
        { name: 'handoff', kind: 'prompt', source: 'skill', description: 'Przekazanie', argumentHint: '[cel]' },
      ],
    };
    const res = await get(h, '/api/sessions/s1/commands');
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(commandListSchema.parse(body)).toEqual(h.manager.commandList);
    expect(h.manager.calls.filter((call) => call.method === 'commands')).toEqual([{ method: 'commands', args: ['s1'] }]);
  });

  it('identyfikator sesji dekodowany z segmentu (`w0:p1` z apki przychodzi jako `w0%3Ap1`)', async () => {
    h.manager.sessions.set('w0:p1', makeSummary({ id: 'w0:p1' }));
    expect((await get(h, '/api/sessions/w0%3Ap1/commands')).status).toBe(200);
    expect(h.manager.calls.at(-1)).toEqual({ method: 'commands', args: ['w0:p1'] });
  });

  it('nieznana sesja 404, odmowa managera 400 z jego zdaniem (panel poza zasięgiem)', async () => {
    const missing = await get(h, '/api/sessions/nie-ma/commands');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not-found' });
    h.manager.throwOn.commands = new BadRequestError('Panel jest poza RAROG_HERDR_ROOTS — Rarog go pokazuje, ale do niego nie pisze.');
    const refused = await get(h, '/api/sessions/s1/commands');
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'bad-request', message: 'Panel jest poza RAROG_HERDR_ROOTS — Rarog go pokazuje, ale do niego nie pisze.',
    });
  });

  it('bez klucza 401 (manager nie pytany), POST to 405 z `Allow: GET`, podtrasa dalej to 405 starego routera', async () => {
    expect((await get(h, '/api/sessions/s1/commands', { auth: null })).status).toBe(401);
    expect(h.manager.calls.some((call) => call.method === 'commands')).toBe(false);
    const posted = await post(h, '/api/sessions/s1/commands', {});
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET');
    // Ścieżka dłuższa o segment to nie ta trasa — zostaje przy dawnym 405 „tylko POST”.
    expect((await get(h, '/api/sessions/s1/commands/x')).status).toBe(405);
  });
});

describe('GET /api/mac', () => {
  it('oddaje bieżący odczyt próbnika: kształt `liveActivityMacSchema`, zero to wartość, bez cache', async () => {
    let stats: MacStats = { cpu: 0, ram: 75, disk: 95 };
    const local = await startHarness({}, undefined, { mac: () => stats });
    try {
      const res = await get(local, '/api/mac');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body: unknown = await res.json();
      expect(liveActivityMacSchema.parse(body)).toEqual(body);
      expect(body).toEqual({ cpu: 0, ram: 75, disk: 95 });
      // Każde żądanie czyta próbnik od nowa — nic nie zastyga w routerze.
      stats = { disk: 95 };
      expect(await (await get(local, '/api/mac')).json()).toEqual({ disk: 95 });
    } finally {
      await local.close();
    }
  });

  it('bez próbnika (harness) — pusty obiekt, czyli „brak odczytu", nie błąd', async () => {
    const res = await get(h, '/api/mac');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('bez klucza 401, inna metoda 405', async () => {
    expect((await get(h, '/api/mac', { auth: null })).status).toBe(401);
    const posted = await post(h, '/api/mac', {});
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET');
  });
});

describe('GET /api/usage/details', () => {
  const details = {
    stale: true, fetchedAt: '2026-10-17T19:18:26.521Z',
    weekly: { percent: 57, resetsAt: '2026-10-22T15:00:00.403Z' },
    weeklyModel: { percent: 34, resetsAt: '2026-10-22T15:00:00.403Z', model: 'Fable' },
  };
  let calls: string[] = [];
  const fake: NonNullable<RouterDeps['usage']> = {
    get: () => { calls.push('get'); return Promise.resolve(null); },
    details: () => { calls.push('details'); return Promise.resolve(details); },
  };

  it('200 z odczytem dostawcy: kształt `planUsageSchema`, bez cache, `/api/usage` nietknięte', async () => {
    calls = [];
    const local = await startHarness({}, undefined, { usage: fake });
    try {
      const res = await get(local, '/api/usage/details');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body: unknown = await res.json();
      expect(planUsageSchema.parse(body)).toEqual(body);
      expect(body).toEqual(details);
      expect(calls).toEqual(['details']);
      // Limity z paska statusu dalej idą swoją trasą (tu: dostawca nie wie → 503).
      expect((await get(local, '/api/usage')).status).toBe(503);
      expect(calls).toEqual(['details', 'get']);
    } finally {
      await local.close();
    }
  });

  it('odczytu nie ma: 200 `{}`, nie błąd', async () => {
    const local = await startHarness({}, undefined, {
      usage: { ...fake, details: () => Promise.resolve({}) },
    });
    try {
      const res = await get(local, '/api/usage/details');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    } finally {
      await local.close();
    }
  });

  it('bez klucza 401 (dostawca nie pytany), inna metoda 405 z `Allow: GET`', async () => {
    calls = [];
    const local = await startHarness({}, undefined, { usage: fake });
    try {
      expect((await get(local, '/api/usage/details', { auth: null })).status).toBe(401);
      const posted = await post(local, '/api/usage/details', {});
      expect(posted.status).toBe(405);
      expect(posted.headers.get('allow')).toBe('GET');
      expect(calls).toEqual([]);
    } finally {
      await local.close();
    }
  });
});

describe('GET /api/fs', () => {
  it('w demo bez ścieżki oddaje projekty demo jako korzenie', async () => {
    const res = await get(h, '/api/fs');
    expect(res.status).toBe(200);
    const body = dirListingSchema.parse(await res.json());
    expect(body.path).toBeNull();
    expect(body.entries.map((e) => e.name)).toEqual(['willow', 'rarog']);
  });

  it('w demo wejście w projekt daje pustą listę, a nie 404 z nieistniejącego dysku', async () => {
    const res = await get(h, '/api/fs?path=%2Ftmp%2Frarog-demo%2Fwillow');
    const body = dirListingSchema.parse(await res.json());
    expect(body).toMatchObject({ path: '/tmp/rarog-demo/willow', entries: [], truncated: false });
  });

  it('ścieżka spoza allow-listy to 400 path-not-allowed', async () => {
    const res = await get(h, '/api/fs?path=%2Fetc');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'path-not-allowed' });
  });

  it('bez klucza 401, POST to 405', async () => {
    expect((await get(h, '/api/fs', { auth: null })).status).toBe(401);
    expect((await post(h, '/api/fs', {})).status).toBe(405);
  });

  it('poza demo listuje prawdziwy katalog wewnątrz korzeni i oddaje 404 dla nieistniejącego',
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'rarog-router-fs-'));
      await mkdir(join(base, 'willow', 'src'), { recursive: true });
      const prod = await startHarness({
        RAROG_DEMO: '',
        RAROG_ORIGINS: ORIGIN,
        RAROG_PROJECT_ROOTS: base,
      });
      try {
        const roots = dirListingSchema.parse(await (await get(prod, '/api/fs')).json());
        expect(roots.entries.map((e) => e.path)).toEqual([base]);

        const inside = dirListingSchema.parse(
          await (await get(prod, `/api/fs?path=${encodeURIComponent(base)}`)).json(),
        );
        expect(inside.entries.map((e) => e.name)).toEqual(['willow']);

        const missing = await get(prod, `/api/fs?path=${encodeURIComponent(join(base, 'nie-ma'))}`);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({ error: 'not-found' });
      } finally {
        await prod.close();
        await rm(base, { recursive: true, force: true });
      }
    });
});

describe('POST /api/sessions/:id/model', () => {
  it('przekazuje model i effort do managera i oddaje 202 z OSTRZEŻENIEM', async () => {
    /*
     * 202, a nie 200: komendę `/model` panel przyjmuje od razu, ale dialog potwierdzenia
     * czyta się z ekranu już PO odpowiedzi. Ciało niesie ostrzeżenie o skutku globalnym —
     * to samo zdanie, które arkusz pokazał przed wysłaniem (`MODEL_CHANGE_WARNING`), bo
     * dwa różne brzmienia tej samej prawdy to najkrótsza droga do nieufności wobec ostrzeżeń.
     */
    const res = await post(h, '/api/sessions/s1/model', { model: 'opus[1m]', effort: 'xhigh' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, warning: MODEL_CHANGE_WARNING.text });
    expect(h.manager.calls.at(-1)).toMatchObject({
      method: 'setModel', args: ['s1', { model: 'opus[1m]', effort: 'xhigh' }],
    });
  });

  it('POST /api/sessions/:id/mode → 202 i cel do managera; zły cel to 400', async () => {
    const res = await post(h, '/api/sessions/s1/mode', { mode: 'plan' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.manager.calls.at(-1)).toMatchObject({ method: 'setMode', args: ['s1', { mode: 'plan' }] });
    // `bypass` jako cel nie istnieje — schemat odrzuca go PRZED managerem.
    expect((await post(h, '/api/sessions/s1/mode', { mode: 'bypass' })).status).toBe(400);
  });

  it('sam effort (bez modelu) jest poprawnym żądaniem, a `null` czyści effort', async () => {
    expect((await post(h, '/api/sessions/s1/model', { effort: 'low' })).status).toBe(202);
    const res = await post(h, '/api/sessions/s1/model', { effort: null });
    expect(res.status).toBe(202);
    expect(h.manager.calls.at(-1)).toMatchObject({
      method: 'setModel', args: ['s1', { effort: null }],
    });
  });

  it('throttle z managera to 429 z jego komunikatem, nie ogólne „spróbuj za chwilę"', async () => {
    // `/model` jest wysyłką do panelu jak każda inna, więc podlega temu samemu throttle'owi
    // — a „poczekaj" i „nie wolno" to dla człowieka dwie różne odpowiedzi.
    h.manager.throwOn['setModel'] = new TooManyRequestsError('Za szybko — daj panelowi chwilę.');
    const res = await post(h, '/api/sessions/s1/model', { model: 'opus[1m]' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'too-many-requests', message: 'Za szybko — daj panelowi chwilę.',
    });
  });

  it('puste ciało (ani model, ani effort) to 400', async () => {
    expect((await post(h, '/api/sessions/s1/model', {})).status).toBe(400);
  });

  it('ultracode: `true` i `false` przechodzą schemat i dochodzą do managera bez zmian; null to 400', async () => {
    for (const ultracode of [true, false]) {
      const res = await post(h, '/api/sessions/s1/model', { ultracode });
      expect(res.status).toBe(202);
      // Sam ultracode: zdanie o koszcie w tej sesji, nie ostrzeżenie o ustawieniach konta.
      expect(await res.json()).toEqual({ ok: true, warning: ULTRACODE_CHANGE_NOTE.text });
      expect(h.manager.calls.at(-1)).toMatchObject({ method: 'setModel', args: ['s1', { ultracode }] });
    }
    const before = h.manager.calls.length;
    expect((await post(h, '/api/sessions/s1/model', { ultracode: null })).status).toBe(400);
    expect(h.manager.calls).toHaveLength(before);
  });

  it('ultracode obok modelu: ostrzeżenie o ustawieniach konta; `effort: ultracode` to 400 (nie poziom)', async () => {
    const res = await post(h, '/api/sessions/s1/model', { model: 'opus[1m]', ultracode: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, warning: MODEL_CHANGE_WARNING.text });
    const before = h.manager.calls.length;
    expect((await post(h, '/api/sessions/s1/model', { effort: 'ultracode' })).status).toBe(400);
    expect(h.manager.calls).toHaveLength(before);
  });

  it('model spoza listy serwera to 400 model-unknown — i manager nie jest wołany', async () => {
    const before = h.manager.calls.length;
    const res = await post(h, '/api/sessions/s1/model', { model: 'gpt-9' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'model-unknown' });
    expect(h.manager.calls).toHaveLength(before);
  });

  it('model o niepoprawnym KSZTAŁCIE odpada na schemacie (400 bad-request)', async () => {
    const res = await post(h, '/api/sessions/s1/model', { model: 'Model Z Spacją' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad-request' });
  });

  it('BadState z managera to 409 busy z komunikatem dla człowieka', async () => {
    h.manager.throwOn['setModel'] =
      new BadStateError('Agent pracuje — zmień model, gdy skończy turę.');
    const res = await post(h, '/api/sessions/s1/model', { model: 'opus[1m]' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'busy', message: 'Agent pracuje — zmień model, gdy skończy turę.',
    });
  });

  it('Gone z managera to 410', async () => {
    h.manager.throwOn['setModel'] = new GoneError('Sesja jest zamknięta — załóż nową.');
    const res = await post(h, '/api/sessions/s1/model', { model: 'opus[1m]' });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: 'gone' });
  });

  it('nieznana sesja to 404, GET to 405, brak klucza to 401', async () => {
    expect((await post(h, '/api/sessions/nie-ma/model', { model: 'opus[1m]' })).status).toBe(404);
    expect((await get(h, '/api/sessions/s1/model')).status).toBe(405);
    expect((await post(h, '/api/sessions/s1/model', { model: 'opus[1m]' }, { auth: null })).status)
      .toBe(401);
  });
});

describe('POST /api/sessions/:id/focus', () => {
  it('woła managera i oddaje 202 — skutek jest na Macu, nie w tej odpowiedzi', async () => {
    const res = await post(h, '/api/sessions/s1/focus', {});
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.manager.calls.at(-1)).toMatchObject({ method: 'focus', args: ['s1'] });
  });

  it('ciała nie potrzebuje — endpoint nie ma żadnych parametrów', async () => {
    expect((await post(h, '/api/sessions/s1/focus', undefined)).status).toBe(202);
  });

  it('BadState z managera to 409 z JEGO komunikatem', async () => {
    // „Ta sesja nie ma panelu w herdr" jest jedynym zdaniem, które mówi, dlaczego przycisk
    // nic nie zrobił — ogólne „Sesja jest w stanie…" nie mówi nic.
    h.manager.throwOn['focus'] = new BadStateError('Ta sesja nie ma panelu w herdr.');
    const res = await post(h, '/api/sessions/s1/focus', {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ message: 'Ta sesja nie ma panelu w herdr.' });
  });

  it('nieznana sesja to 404, GET to 405, brak klucza to 401', async () => {
    expect((await post(h, '/api/sessions/nie-ma/focus', {})).status).toBe(404);
    expect((await get(h, '/api/sessions/s1/focus')).status).toBe(405);
    expect((await post(h, '/api/sessions/s1/focus', undefined, { auth: null })).status).toBe(401);
  });
});

describe('POST /api/sessions/:id/seen', () => {
  it('woła managera i oddaje 200 — skutek jest w całości po stronie Raroga', async () => {
    const res = await post(h, '/api/sessions/s1/seen', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.manager.calls.at(-1)).toMatchObject({ method: 'markSeen', args: ['s1'] });
  });

  it('ciała nie potrzebuje — endpoint nie ma żadnych parametrów', async () => {
    expect((await post(h, '/api/sessions/s1/seen', undefined)).status).toBe(200);
  });

  it('NIE jest to `focus` — do herdr nie idzie nic', async () => {
    await post(h, '/api/sessions/s1/seen', {});
    expect(h.manager.calls.some((c) => c.method === 'focus')).toBe(false);
  });

  it('nieznana sesja to 404, GET to 405, brak klucza to 401', async () => {
    expect((await post(h, '/api/sessions/nie-ma/seen', {})).status).toBe(404);
    expect((await get(h, '/api/sessions/s1/seen')).status).toBe(405);
    expect((await post(h, '/api/sessions/s1/seen', undefined, { auth: null })).status).toBe(401);
  });
});

describe('POST /api/sessions/:id/unseen', () => {
  it('woła managera i oddaje 200 — ciała nie potrzebuje', async () => {
    const res = await post(h, '/api/sessions/s1/unseen', undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.manager.calls.at(-1)).toMatchObject({ method: 'markUnseen', args: ['s1'] });
    // Do herdr nie idzie nic: ani fokus, ani odbiór.
    expect(h.manager.calls.some((c) => c.method === 'focus' || c.method === 'markSeen')).toBe(false);
  });

  it('nieznana sesja to 404, GET to 405, brak klucza to 401', async () => {
    expect((await post(h, '/api/sessions/nie-ma/unseen', {})).status).toBe(404);
    expect((await get(h, '/api/sessions/s1/unseen')).status).toBe(405);
    expect((await post(h, '/api/sessions/s1/unseen', undefined, { auth: null })).status).toBe(401);
  });
});

// Endpointów ukrytych paneli nie ma — nieznana ścieżka = zwykłe 404.
describe('endpointy ukrytych paneli nie istnieją', () => {
  it('GET /api/hidden i POST /api/hidden/restore to zwykłe 404', async () => {
    expect((await get(h, '/api/hidden')).status).toBe(404);
    expect((await post(h, '/api/hidden/restore', { key: 'w9:p72' })).status).toBe(404);
  });
});

describe('POST /api/sessions — model i effort', () => {
  it('przekazuje model i effort do managera', async () => {
    const res = await post(h, '/api/sessions', {
      cwd: '/tmp/rarog-demo/willow', prompt: 'zadanie', model: 'sonnet', effort: 'high',
    });
    expect(res.status).toBe(202);
    expect(h.manager.calls.at(-1)?.args[0]).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('model spoza listy to 400 model-unknown zamiast sesji', async () => {
    const before = h.manager.sessions.size;
    const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/willow', model: 'gpt-9' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'model-unknown' });
    expect(h.manager.sessions.size).toBe(before);
  });

  it('nieznany effort odpada na schemacie', async () => {
    const res = await post(h, '/api/sessions', {
      cwd: '/tmp/rarog-demo/willow', effort: 'turbo',
    });
    expect(res.status).toBe(400);
  });

  it('ultracode: `true` z xhigh albo bez effortu przechodzi; `false` i inny effort odpadają na schemacie', async () => {
    const cwd = '/tmp/rarog-demo/willow';
    for (const body of [{ cwd, ultracode: true }, { cwd, ultracode: true, effort: 'xhigh', model: 'opus[1m]' }]) {
      expect((await post(h, '/api/sessions', body)).status).toBe(202);
      expect(h.manager.calls.at(-1)?.args[0]).toMatchObject({ ultracode: true });
    }
    const before = h.manager.calls.length;
    for (const body of [{ cwd, ultracode: false }, { cwd, ultracode: true, effort: 'high' }]) {
      expect((await post(h, '/api/sessions', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.manager.calls).toHaveLength(before);
  });

  it('odmowa bramki ultracode w managerze to 400 `ultracode-refused` ze zdaniem managera, nie `bad-request`', async () => {
    const message = 'Nie znam wersji Claude Code, a ultracode wymaga wersji 2.1.284 albo nowszej.';
    h.manager.throwOn['create'] = Object.assign(new Error(message), {
      code: ULTRACODE_REFUSED_ERROR, sentence: foreign(message),
    });
    const res = await post(h, '/api/sessions', { cwd: '/tmp/rarog-demo/willow', ultracode: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ULTRACODE_REFUSED_ERROR, message });
  });
});

describe('sesje herdr — zachowanie istniejących endpointów', () => {
  /** Sesja przypięta do żywego panelu (ma `paneId`) obok zwykłej sesji bez panelu. */
  function addHerdrSession(id = 'h1'): void {
    h.manager.sessions.set(id, makeSummary({
      id, paneId: 'w9:p72', state: 'waiting-permission',
    }));
  }

  it('zatwierdzenie zgody schodzi do managera — to ON wie, czy karta ma cyfry', async () => {
    /*
     * `allow` przechodzi, ale wyłącznie dla karty, która ma cyfry
     * z cross-checku jsonl ↔ ekran. Rozstrzyga to MANAGER (tylko on wie, czy driver ma czym
     * zatwierdzić), a router nie ma prawa odmawiać w ciemno — bo wtedy poprawna karta zgody
     * z telefonu byłaby nieklikalna.
     */
    addHerdrSession();
    h.manager.permissionOutcomes = ['ok'];
    const res = await post(h, '/api/sessions/h1/permissions/p1', { decision: 'allow' });

    expect(res.status).toBe(200);
    expect(h.manager.calls.some((c) => c.method === 'resolvePermission')).toBe(true);
  });

  it('zatwierdzenie karty BEZ cyfr niesie 409 z komunikatem managera (fail-closed)', async () => {
    addHerdrSession();
    h.manager.throwOn['resolvePermission'] = new BadStateError(
      'Tego dialogu Rarog nie rozpoznał — zatwierdź go w terminalu.',
    );
    const res = await post(h, '/api/sessions/h1/permissions/p1', { decision: 'allow' });

    expect(res.status).toBe(409);
    expect((await res.json() as { message: string }).message).toContain('terminal');
  });

  it('odrzucenie dialogu w sesji herdr przechodzi do managera', async () => {
    addHerdrSession();
    h.manager.permissionOutcomes = ['ok'];
    const res = await post(h, '/api/sessions/h1/permissions/p1', { decision: 'deny' });

    expect(res.status).toBe(200);
    expect(h.manager.calls.at(-1)).toMatchObject({ method: 'resolvePermission' });
  });

  it('„Odrzuć dialog (Esc)" trafia w endpoint BEZ permId i schodzi do managera', async () => {
    /*
     * PWA woła `POST /api/sessions/:id/permission` (liczba pojedyncza), bo dialog stojący
     * w terminalu nie ma `permId` — Rarog go nigdy nie zarejestrował (sesja herdr
     * w `waiting-permission` ma pustą listę pending). Bez tej trasy jedyny przycisk decyzji
     * w sesji herdr dostawał 404, czyli funkcja z planu 3.5 nie istniała.
     */
    addHerdrSession();
    h.manager.permissionOutcomes = ['ok'];
    const res = await post(h, '/api/sessions/h1/permission', { decision: 'deny' });

    expect(res.status).toBe(200);
    expect(h.manager.calls.at(-1)).toMatchObject({ method: 'resolvePermission' });
  });

  it('zatwierdzenie przez endpoint bez permId niesie 409 z komunikatem managera', async () => {
    addHerdrSession();
    h.manager.throwOn['resolvePermission'] = new BadStateError(
      'Zgodę zatwierdź w terminalu — Rarog potrafi tylko odrzucić dialog (Esc).',
    );
    const res = await post(h, '/api/sessions/h1/permission', { decision: 'allow' });

    expect(res.status).toBe(409);
    expect((await res.json() as { message: string }).message).toContain('terminal');
  });

  it('odpowiedź na pytanie agenta schodzi do managera (jedna cyfra = jedna opcja)', async () => {
    addHerdrSession();
    h.manager.answerOutcomes = ['ok'];
    const res = await post(h, '/api/sessions/h1/answers/q1', { answers: [['tak']] });

    expect(res.status).toBe(200);
    expect(h.manager.calls.some((c) => c.method === 'answerQuestion')).toBe(true);
  });

  it('wielokrotny wybór odrzuca manager, a jego komunikat wraca dosłownie', async () => {
    addHerdrSession();
    h.manager.throwOn['answerQuestion'] = new BadStateError(
      'Wielokrotny wybór zrób w terminalu — Rarog wyśle jedną odpowiedź.',
    );
    const res = await post(h, '/api/sessions/h1/answers/q1', { answers: [['a', 'b']] });

    expect(res.status).toBe(409);
    expect((await res.json() as { message: string }).message).toContain('Wielokrotny wybór');
  });

  it('sesja SDK dalej przyjmuje zatwierdzenie zgody (żadnej regresji)', async () => {
    h.manager.permissionOutcomes = ['ok'];
    const res = await post(h, '/api/sessions/s1/permissions/p1', { decision: 'allow' });
    expect(res.status).toBe(200);
  });

  it('odrzucona wysyłka niesie POWÓD z managera, nie ogólne „Żądanie odrzucone"', async () => {
    // Bez tej ścieżki użytkownik dostaje pusty composer i zero informacji, dlaczego jego
    // zdanie nie poszło do panelu.
    h.manager.throwOn['sendMessage'] = new BadRequestError(
      'Komenda /hooks jest zablokowana — zrób to w terminalu.',
    );
    const res = await post(h, '/api/sessions/s1/messages', { text: '/hooks add' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'bad-request',
      message: 'Komenda /hooks jest zablokowana — zrób to w terminalu.',
    });
  });

  it('throttle wysyłki to 429 z komunikatem „poczekaj", a nie 400', async () => {
    h.manager.throwOn['sendMessage'] = new TooManyRequestsError(
      'Za szybko — daj panelowi chwilę i wyślij ponownie.',
    );
    const res = await post(h, '/api/sessions/s1/messages', { text: 'druga w tej samej sekundzie' });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'too-many-requests' });
  });

  it('router CZEKA na asynchroniczną wysyłkę (uploady) przed odpowiedzią', async () => {
    // Sesja herdr zapisuje zdjęcia na dysk PRZED przejściem stanu — gdyby router nie czekał,
    // błąd zapisu wracałby do telefonu jako 202 „wysłano".
    const manager = h.manager as unknown as {
      sendMessage: (id: string, text: string) => Promise<{ replayed: boolean }>;
    };
    manager.sendMessage = async () => {
      await Promise.resolve();
      throw new BadRequestError('Nie udało się zapisać zdjęcia w katalogu projektu.');
    };
    const res = await post(h, '/api/sessions/s1/messages', { text: 'zdjęcie', images: [PNG] });

    expect(res.status).toBe(400);
    expect((await res.json() as { message: string }).message).toContain('zdjęcia');
  });

  it('zmiana modelu sesji herdr to 400 z copy dla człowieka', async () => {
    addHerdrSession();
    h.manager.throwOn['setModel'] = new BadRequestError('Model sesji herdr zmieniasz w terminalu.');
    const res = await post(h, '/api/sessions/h1/model', { model: 'sonnet' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'bad-request', message: 'Model sesji herdr zmieniasz w terminalu.',
    });
  });

  it('wznowienie sesji herdr to 409 z managera', async () => {
    addHerdrSession();
    h.manager.throwOn['resume'] = new BadStateError(
      'Sesja herdr żyje w terminalu — nie ma czego wznawiać.',
    );
    const res = await post(h, '/api/sessions/h1/resume', {});
    expect(res.status).toBe(409);
  });

  it('„Ukryj" (close bez ciała) NIE zamyka panelu — to dwie różne władze', async () => {
    addHerdrSession();
    const res = await post(h, '/api/sessions/h1/close', {});
    expect(res.status).toBe(200);
    expect(h.manager.calls.at(-1)).toMatchObject({
      method: 'close', args: ['h1', { closePanel: false }],
    });
  });

  it('`closePanel: true` przechodzi do managera (i tylko on sprawdza własność panelu)', async () => {
    addHerdrSession();
    const res = await post(h, '/api/sessions/h1/close', { closePanel: true });
    expect(res.status).toBe(200);
    expect(h.manager.calls.at(-1)).toMatchObject({
      method: 'close', args: ['h1', { closePanel: true }],
    });
  });

  it('zamknięcie CUDZEGO panelu to 409 z komunikatem managera', async () => {
    addHerdrSession();
    h.manager.throwOn['close'] = new BadStateError(
      'Ten panel otworzył ktoś inny — Rarog może go tylko ukryć.',
    );
    const res = await post(h, '/api/sessions/h1/close', { closePanel: true });
    expect(res.status).toBe(409);
    expect((await res.json() as { message: string }).message).toContain('ktoś inny');
  });

  it('wznowienie sesji żywej w herdr to 409 z komunikatem managera', async () => {
    h.manager.throwOn['create'] = new BadStateError(
      'Ta sesja jest otwarta w herdr — wejdź do niej zamiast wznawiać.',
    );
    const res = await post(h, '/api/sessions', {
      cwd: '/tmp/rarog-demo/willow', resumeFrom: '11111111-1111-4111-8111-111111111111',
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { message: string }).message).toContain('otwarta w herdr');
  });

  it('lista wznawialnych niesie liveInHerdr', async () => {
    h.manager.resumableResult = [{
      engineSessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/tmp/rarog-demo/willow',
      mtime: '2026-08-22T10:00:00.000Z',
      firstPrompt: 'napraw zapis notatki',
      liveInHerdr: true,
    }];
    const res = await get(h, '/api/resumable?cwd=/tmp/rarog-demo/willow');

    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: { liveInHerdr: boolean }[] };
    expect(body.sessions[0]?.liveInHerdr).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/presence — beacon obecności
// ---------------------------------------------------------------------------

describe('POST /api/presence', () => {
  let h: Harness;
  let presence: Presence;

  beforeEach(async () => {
    presence = new Presence();
    h = await startHarness({}, [makeSummary({ id: 's1' })], { presence });
  });

  afterEach(async () => { await h.close(); });

  it('zgłoszona widoczność czyni użytkownika obecnym', async () => {
    const res = await post(h, '/api/presence', { clientId: 'telefon', visible: true });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(presence.active()).toBe(true);
  });

  it('zejście w tło gasi obecność', async () => {
    await post(h, '/api/presence', { clientId: 'telefon', visible: true });
    await post(h, '/api/presence', { clientId: 'telefon', visible: false });
    expect(presence.active()).toBe(false);
  });

  it('otwarty transkrypt jedzie osobnym polem', async () => {
    await post(h, '/api/presence', { clientId: 'telefon', visible: true, sessionId: 's1' });
    expect(presence.watching('s1')).toBe(true);
    expect(presence.watching('s2')).toBe(false);
  });

  it('GET na tę ścieżkę to 405', async () => {
    const res = await get(h, '/api/presence');
    expect(res.status).toBe(405);
  });

  it('bez klucza 401 — obecność jest stanem konta, nie ruchem publicznym', async () => {
    const res = await post(h, '/api/presence', { clientId: 'x', visible: true }, { auth: null });
    expect(res.status).toBe(401);
    expect(presence.active()).toBe(false);
  });

  it('POST bez Origin z allow-listy to 403 (CSRF)', async () => {
    const res = await post(
      h, '/api/presence', { clientId: 'x', visible: true }, { origin: 'https://zly.example' },
    );
    expect(res.status).toBe(403);
  });

  it('ciało niezgodne ze schematem to 400, nie cicha obecność', async () => {
    expect((await post(h, '/api/presence', { visible: true })).status).toBe(400);
    expect((await post(h, '/api/presence', { clientId: 'x' })).status).toBe(400);
    expect((await post(h, '/api/presence', { clientId: '', visible: true })).status).toBe(400);
    expect(presence.active()).toBe(false);
  });

  /*
   * Apka wysyła beacon ZAWSZE — nie ma powodu wiedzieć, czy serwer ma akurat kanał APNs.
   * Endpoint, który raz jest, a raz go nie ma, zamieniłby konfigurację serwera w 404
   * do zdiagnozowania na telefonie.
   */
  it('bez kanału powiadomień endpoint dalej odpowiada 204 (no-op, nie 404)', async () => {
    const bez = await startHarness();
    try {
      const res = await post(bez, '/api/presence', { clientId: 'telefon', visible: true });
      expect(res.status).toBe(204);
    } finally {
      await bez.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Web Push nie istnieje — trasy subskrypcji też nie
// ---------------------------------------------------------------------------

describe('trasy Web Push nie istnieją', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it('`/api/push/config`, `subscribe` i `unsubscribe` to 404 — kanału nie ma i nie udaje, że jest', async () => {
    expect((await get(h, '/api/push/config')).status).toBe(404);
    expect((await post(h, '/api/push/subscribe', { label: 'x' })).status).toBe(404);
    expect((await post(h, '/api/push/unsubscribe', { endpoint: 'https://web.push.apple.com/x' })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// APNs i Live Activity apki natywnej — kontrakt tras bez nadajnika
// ---------------------------------------------------------------------------

describe('APNs i Live Activity — trasy apki natywnej bez kanału', () => {
  const TOKEN = 'a1b2c3d4'.repeat(8);
  const ACTIVITY = { deviceToken: TOKEN, activityId: 'akt-1', updateToken: '0f1e2d3c'.repeat(10) };
  const register = { token: TOKEN, environment: 'development', label: 'iPad·Rarog', alerts: true };
  const noop: [string, unknown][] = [
    ['/api/push/apns', register],
    ['/api/push/apns', { ...register, test: true }],
    // Bez kanału nie ma tematu serwera do porównania: temat apki, jakikolwiek, to dalej 204 no-op.
    ['/api/push/apns', { ...register, topic: 'ai.example.app' }],
    ['/api/push/apns/unregister', { token: TOKEN }],
    ['/api/push/live-activity', ACTIVITY],
    ['/api/push/live-activity/end', { deviceToken: TOKEN, activityId: 'akt-1' }],
  ];

  it('poprawne ciało → 204 no-op (nigdy 404 ani 429)', async () => {
    for (const [route, body] of noop) {
      expect((await post(h, route, body)).status, route).toBe(204);
    }
  });

  it('status tokenu idzie POST-em i mówi „kanału nie ma"', async () => {
    const res = await post(h, '/api/push/apns/status', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, registered: false, alerts: false, degradedSince: null });
    // GET z tokenem w query nie istnieje — token nie ma prawa trafić do logów Caddy.
    expect((await get(h, `/api/push/apns/status?token=${TOKEN}`)).status).toBe(405);
  });

  it('ciało spoza kontraktu → 400: zły token, brak `activityId` przy końcu, nieznane środowisko', async () => {
    const bad: [string, unknown][] = [
      ['/api/push/apns', { ...register, token: 'nie-hex' }],
      ['/api/push/apns', { ...register, environment: 'sandbox' }],
      ['/api/push/apns', { ...register, topic: 'bez-kropki' }],
      ['/api/push/apns', { ...register, topic: '' }],
      ['/api/push/apns/unregister', {}],
      ['/api/push/apns/status', { token: TOKEN.slice(0, 10) }],
      ['/api/push/live-activity', { deviceToken: TOKEN, activityId: 'akt-1' }],
      ['/api/push/live-activity/end', { deviceToken: TOKEN }],
    ];
    for (const [route, body] of bad) {
      expect((await post(h, route, body)).status, `${route} ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('GET → 405, bez klucza 401, zły Origin 403 — te same bramki co reszta mutacji', async () => {
    for (const [route, body] of [...noop, ['/api/push/apns/status', { token: TOKEN }] as [string, unknown]]) {
      expect((await get(h, route)).status, route).toBe(405);
      expect((await post(h, route, body, { auth: null })).status, route).toBe(401);
      expect((await post(h, route, body, { origin: 'https://zly.example' })).status, route).toBe(403);
    }
  });

  it('log nie niesie tokenu ani etykiety urządzenia', async () => {
    const logged: string[] = [];
    const logging = await startHarness({}, undefined, {
      logger: { info: (m) => { logged.push(m); }, error: (m) => { logged.push(m); } },
    });
    try {
      for (const [route, body] of noop) await post(logging, route, body);
      await post(logging, '/api/push/apns/status', { token: TOKEN });
      await post(logging, '/api/push/apns', { ...register, token: 'zly' });
    } finally {
      await logging.close();
    }
    const text = logged.join('\n');
    expect(text).not.toContain(TOKEN.slice(0, 16));
    expect(text).not.toContain('0f1e2d3c');
    expect(text).not.toContain('iPad·Rarog');
  });
});

// ---------------------------------------------------------------------------
// APNs apki natywnej — trasy Z kanałem
// ---------------------------------------------------------------------------

describe('APNs — trasy apki natywnej z kanałem', () => {
  const TOKEN = 'A1B2C3D4'.repeat(8);
  const LOWER = TOKEN.toLowerCase();
  const register = { token: TOKEN, environment: 'development', label: 'iPad·Rarog', alerts: true, topic: 'ai.rarog.app' };
  /** Sparowane urządzenie: rejestracja APNs idzie jego kluczem (domyślny klient harnessu). */
  const PHONE = 'f0e1d2c3'.repeat(4);
  const PHONE_SECRET = Buffer.alloc(32, 9).toString('base64url');
  const PHONE_PUSH_KEY = Buffer.alloc(32, 5).toString('base64url');
  const asPhone = { headers: { Authorization: deviceAuthorization(PHONE, PHONE_SECRET) } };

  let apnsHarness: Harness;
  let dir: string;
  let devices: ApnsDeviceStore;
  let paired: DeviceStore;
  let sendTo: ReturnType<typeof vi.fn<(token: string, content: PushContent) => Promise<SendOutcome>>>;
  let disabledSince: string | null;
  let clock: number;
  let logged: string[];
  /** Wysyłki Live Activity (atrapa nadajnika) — token aktywności i ciało `aps`. */
  let laSent: { token: string; request: ApnsRequest }[];
  let liveActivity: LiveActivityController;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-apns-router-'));
    devices = createApnsDeviceStore({ dataDir: dir });
    paired = createDeviceStore({ dataDir: dir, epoch: '1' });
    paired.add({
      id: PHONE, secretHash: hashSecret(PHONE_SECRET), pushKey: PHONE_PUSH_KEY, kid: pushKeyId(PHONE_PUSH_KEY),
      label: 'iPad·Rarog', build: null, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      epoch: '1', creator: 'admin',
    });
    sendTo = vi.fn(async (): Promise<SendOutcome> => 'delivered');
    disabledSince = null;
    clock = 2_000_000;
    logged = [];
    laSent = [];
    liveActivity = createLiveActivity({
      devices,
      sender: {
        send: (_env, token, request): Promise<ApnsResult> => {
          laSent.push({ token, request });
          return Promise.resolve({ kind: 'ok' });
        },
      },
      sessions: () => [makeSummary({ id: 's1', state: 'waiting-permission' })],
      log: (m) => { logged.push(m); },
    });
    apnsHarness = await startHarness({}, [makeSummary({ id: 's1' })], {
      logger: { info: (m) => { logged.push(m); }, error: (m) => { logged.push(m); } },
      apns: {
        devices, sink: { sendTo }, now: () => clock, liveActivity,
        // Atrapa drogi wpisu: degradacja z licznika tokenu albo „wyłączonego środowiska” (status per token).
        sender: {
          statusOf: (record) => ({ degradedSince: record.degradedSince ?? disabledSince }),
          awaitRoute: () => Promise.resolve('direct'),
          awaitPending: () => Promise.resolve(),
        },
        topic: 'ai.rarog.app',
      },
      devices: { store: paired, pairing: createPairing({ store: paired, epoch: '1' }), serverName: 'mac-test' },
      auth: deviceAuthorization(PHONE, PHONE_SECRET),
    });
  });

  afterEach(async () => {
    liveActivity.close();
    await apnsHarness.close();
    await devices.flush();
    await paired.flush();
    await rm(dir, { recursive: true, force: true });
  });

  it('`/api/version` mówi `apnsEnabled: true` i nie niesie już pól Web Push', async () => {
    const body = await (await get(apnsHarness, '/api/version')).json() as Record<string, unknown>;
    expect(body['apnsEnabled']).toBe(true);
    expect(body).not.toHaveProperty('webPushMutedClasses');
  });

  it('rejestracja zapisuje wpis (204, token małymi literami, etykieta z apki, urządzenie i temat), bez pusha bez `test`', async () => {
    const res = await post(apnsHarness, '/api/push/apns', register, asPhone);
    expect(res.status).toBe(204);
    expect(devices.get(LOWER)).toMatchObject({
      token: LOWER, environment: 'development', label: 'iPad·Rarog', alerts: true, deviceId: PHONE, topic: 'ai.rarog.app',
    });
    expect(sendTo).not.toHaveBeenCalled();
  });

  it('status: nieznany token, potem zarejestrowany ze zgodą i bez degradacji', async () => {
    const before = await (await post(apnsHarness, '/api/push/apns/status', { token: TOKEN })).json();
    expect(before).toEqual({ enabled: true, registered: false, alerts: false, degradedSince: null });
    await post(apnsHarness, '/api/push/apns', { ...register, alerts: false }, asPhone);
    const after = await (await post(apnsHarness, '/api/push/apns/status', { token: LOWER })).json();
    expect(after).toEqual({ enabled: true, registered: true, alerts: false, degradedSince: null });
  });

  it('status mówi o degradacji PER TOKEN: trzy porażki z rzędu albo środowisko wyłączone', async () => {
    await post(apnsHarness, '/api/push/apns', register, asPhone);
    for (let i = 0; i < 3; i += 1) devices.noteFailed(TOKEN);
    const degraded = await (await post(apnsHarness, '/api/push/apns/status', { token: TOKEN })).json() as { degradedSince: string | null };
    expect(degraded.degradedSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    devices.noteDelivered(TOKEN);
    disabledSince = '2026-10-07T10:00:00.000Z';
    const disabled = await (await post(apnsHarness, '/api/push/apns/status', { token: TOKEN })).json() as { degradedSince: string | null };
    expect(disabled.degradedSince).toBe('2026-10-07T10:00:00.000Z');
  });

  it('`test: true` ze zgodą → JEDEN push próbny do tego tokenu, PO zapisie; 204 nie czeka na dostawę', async () => {
    let release: (outcome: SendOutcome) => void = () => {};
    sendTo.mockImplementationOnce(() => new Promise<SendOutcome>((resolve) => { release = resolve; }));
    const res = await post(apnsHarness, '/api/push/apns', { ...register, test: true }, asPhone);
    // 204 przyszło, choć push próbny jeszcze wisi — „Powiadomienia działają" pokazuje apka
    // dopiero po ODEBRANYM pushu, nie po tej odpowiedzi.
    expect(res.status).toBe(204);
    expect(sendTo).toHaveBeenCalledTimes(1);
    const [token, content] = sendTo.mock.calls[0] as [string, PushContent];
    expect(token).toBe(TOKEN);
    expect(content.kind).toBe('test');
    expect(devices.get(TOKEN)).toBeDefined();
    release('delivered');
    await vi.waitFor(() => { expect(logged).toContain('push: APNs test push → delivered'); });
  });

  it('drugi `test` w ciągu 60 s → 429 (dławik per token, wielkość liter bez znaczenia); zapis i tak się stał', async () => {
    expect((await post(apnsHarness, '/api/push/apns', { ...register, test: true }, asPhone)).status).toBe(204);
    clock += PUSH_TEST_COOLDOWN_MS - 1;
    const second = await post(apnsHarness, '/api/push/apns', { ...register, token: LOWER, label: 'iPad·Rarog 2', test: true }, asPhone);
    expect(second.status).toBe(429);
    expect((await second.json() as { error: string }).error).toBe('too-many-requests');
    expect(sendTo).toHaveBeenCalledTimes(1);
    expect(devices.get(TOKEN)?.label).toBe('iPad·Rarog 2');
    clock += 1;
    expect((await post(apnsHarness, '/api/push/apns', { ...register, test: true }, asPhone)).status).toBe(204);
    expect(sendTo).toHaveBeenCalledTimes(2);
  });

  it('`test: true` BEZ zgody → bez pusha i bez dławika (baner i tak by się nie pokazał), 204', async () => {
    for (let i = 0; i < 2; i += 1) {
      expect((await post(apnsHarness, '/api/push/apns', { ...register, alerts: false, test: true }, asPhone)).status).toBe(204);
    }
    expect(sendTo).not.toHaveBeenCalled();
    expect(devices.get(TOKEN)?.alerts).toBe(false);
    // Zgoda przyszła chwilę później — pierwszy próbny NIE czeka minuty za próbami bez zgody.
    expect((await post(apnsHarness, '/api/push/apns', { ...register, test: true }, asPhone)).status).toBe(204);
    expect(sendTo).toHaveBeenCalledTimes(1);
  });

  describe('temat apki (`topic`) — temat per wpis', () => {
    it('temat równy tematowi serwera → 204, wpis niesie temat', async () => {
      expect((await post(apnsHarness, '/api/push/apns', register, asPhone)).status).toBe(204);
      expect(devices.get(TOKEN)?.topic).toBe('ai.rarog.app');
    });

    it('brak `topic` → 400 `topic-mismatch`, wpis niezapisany', async () => {
      const { topic: _topic, ...noTopic } = register;
      void _topic;
      const res = await post(apnsHarness, '/api/push/apns', { ...noTopic, test: true }, asPhone);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe('topic-mismatch');
      expect(devices.size).toBe(0);
      expect(sendTo).not.toHaveBeenCalled();
      expect(logged).toContain('push: APNs registration refused — app topic (none) ≠ server topic ai.rarog.app');
    });

    it('temat różny od tematu serwera → 400 `topic-mismatch`, wpis niezapisany, push próbny nie wychodzi', async () => {
      const res = await post(apnsHarness, '/api/push/apns', { ...register, topic: 'ai.example.app', test: true }, asPhone);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe('topic-mismatch');
      expect(body.message).not.toBe('');
      expect(devices.get(TOKEN)).toBeUndefined();
      expect(devices.size).toBe(0);
      expect(sendTo).not.toHaveBeenCalled();
      // Log mówi oba tematy (to bundle id, nie sekret), bez tokenu i etykiety.
      expect(logged).toContain('push: APNs registration refused — app topic ai.example.app ≠ server topic ai.rarog.app');
      expect(logged.join('\n')).not.toContain(LOWER);
    });

    it('odmowa tematu nie rusza istniejącego wpisu tego tokenu', async () => {
      await post(apnsHarness, '/api/push/apns', register, asPhone);
      const before = devices.get(TOKEN);
      expect((await post(apnsHarness, '/api/push/apns', { ...register, alerts: false, topic: 'ai.example.app' }, asPhone)).status)
        .toBe(400);
      expect(devices.get(TOKEN)).toEqual(before);
    });
  });

  describe('deklaracja kluczy lokalizacji `locKeys`', () => {
    const declared = { ...register, pushFormats: [3], locKeys: true };
    const PLACEHOLDER_KEYS = { 'title-loc-key': 'push.placeholder.title', 'loc-key': 'push.placeholder.body' };
    const PLACEHOLDER = { title: 'Rarog', body: 'Nowe powiadomienie' };
    const CHIME_KEYS = {
      title: { 'loc-key': 'push.chime.title' }, body: { 'loc-key': 'push.chime.body' }, sound: 'skonczyl.caf',
    };
    const CHIME = { title: 'Agent skończył', body: 'Wynik czeka w Rarogu', sound: 'skonczyl.caf' };

    /** Magazyn odczytany od nowa (restart serwera) i ładunki banera i dzwonka, które z niego wychodzą. */
    async function afterRestart(): Promise<{ banner: Record<string, unknown>; chime: Record<string, unknown> }> {
      await devices.flush();
      const reopened = createApnsDeviceStore({ dataDir: dir });
      const sent: ApnsRequest[] = [];
      const sink = createApnsSink({
        devices: reopened, e2e: true, now: () => clock,
        activeDevices: () => new Map([[PHONE, { pushKey: PHONE_PUSH_KEY, kid: pushKeyId(PHONE_PUSH_KEY) }]]),
        sender: { send: (_env, _token, request) => { sent.push(request); return Promise.resolve({ kind: 'ok' }); } },
      });
      expect(await sink.send(buildContent({
        cls: 'blocking', kind: 'permission', project: 'rarog', sessionId: 's1', detail: foreign('Bash'), label: 'visuals',
      }))).toBe('delivered');
      const chimes: ApnsRequest[] = [];
      const controller = createLiveActivity({
        devices: reopened,
        sender: { send: (_env, _token, request) => { chimes.push(request); return Promise.resolve({ kind: 'ok' }); } },
        sessions: () => [makeSummary({ id: 's1', state: 'running' })],
      });
      try {
        expect(controller.register(TOKEN, { activityId: 'akt-1', updateToken: '0f1e2d3c'.repeat(10) })).toBe('started');
        expect(controller.chime()).toBe(1);
        await vi.waitFor(() => { expect(chimes.some((r) => r.body.includes('"alert"'))).toBe(true); });
      } finally {
        controller.close();
        await reopened.flush();
      }
      const apsOf = (request: ApnsRequest | undefined): Record<string, unknown> =>
        (JSON.parse(request?.body ?? '{}') as { aps: Record<string, unknown> }).aps;
      return { banner: apsOf(sent[0]), chime: apsOf(chimes.find((r) => r.body.includes('"alert"'))) };
    }

    it('rejestracja z `locKeys: true` → wpis z deklaracją; po restarcie magazynu baner i dzwonek kluczami', async () => {
      expect((await post(apnsHarness, '/api/push/apns', declared, asPhone)).status).toBe(204);
      expect(devices.get(TOKEN)).toMatchObject({ pushFormats: [3], locKeys: true });
      const { banner, chime } = await afterRestart();
      expect(banner['alert']).toEqual(PLACEHOLDER_KEYS);
      expect(chime['alert']).toEqual(CHIME_KEYS);
    });

    it.each([['bez pola', undefined], ['z `false`', false]] as const)(
      'ponowna rejestracja %s zdejmuje deklarację; baner i dzwonek z polskimi literałami',
      async (_what, locKeys) => {
        expect((await post(apnsHarness, '/api/push/apns', declared, asPhone)).status).toBe(204);
        const again = { ...register, pushFormats: [3], ...(locKeys === undefined ? {} : { locKeys }) };
        expect((await post(apnsHarness, '/api/push/apns', again, asPhone)).status).toBe(204);
        expect(devices.get(TOKEN)).not.toHaveProperty('locKeys');
        const { banner, chime } = await afterRestart();
        expect(banner['alert']).toEqual(PLACEHOLDER);
        expect(chime['alert']).toEqual(CHIME);
      },
    );

    it('`locKeys: "yes"` → 400 z kodem kontraktu ciała tej trasy; wpis bez zmian', async () => {
      expect((await post(apnsHarness, '/api/push/apns', declared, asPhone)).status).toBe(204);
      const before = devices.get(TOKEN);
      const res = await post(apnsHarness, '/api/push/apns', { ...declared, alerts: false, locKeys: 'yes' }, asPhone);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      // Ten sam kod co przy innym ciele spoza kontraktu tej trasy (zły token).
      const other = await post(apnsHarness, '/api/push/apns', { ...declared, token: 'nie-hex' }, asPhone);
      expect(other.status).toBe(400);
      expect(body.error).toBe((await other.json() as { error: string }).error);
      expect(body.error).toBe('bad-request');
      expect(devices.get(TOKEN)).toEqual(before);
      expect(devices.size).toBe(1);
    });
  });

  it('wyrejestrowanie usuwa wpis; nieznany token też 204', async () => {
    await post(apnsHarness, '/api/push/apns', register, asPhone);
    expect((await post(apnsHarness, '/api/push/apns/unregister', { token: LOWER })).status).toBe(204);
    expect(devices.size).toBe(0);
    expect((await post(apnsHarness, '/api/push/apns/unregister', { token: TOKEN })).status).toBe(204);
  });

  describe('Live Activity', () => {
    const UPDATE = '0f1e2d3c'.repeat(10);
    const activity = { deviceToken: TOKEN, activityId: 'akt-1', updateToken: UPDATE };
    const event = (i: number): unknown =>
      (JSON.parse(laSent[i]?.request.body ?? '{}') as { aps?: { event?: unknown } }).aps?.event;

    it('token aktywności dla NIEZAREJESTROWANEGO urządzenia → 409 `apns-device-unknown`, nic nie zapisane', async () => {
      const res = await post(apnsHarness, '/api/push/live-activity', activity);
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toBe('apns-device-unknown');
      expect(devices.size).toBe(0);
      expect(laSent).toEqual([]);
    });

    it('po rejestracji urządzenia: 204, blok w rejestrze i od razu stan serwera na token aktywności', async () => {
      await post(apnsHarness, '/api/push/apns', register, asPhone);
      expect((await post(apnsHarness, '/api/push/live-activity', activity)).status).toBe(204);
      expect(devices.get(TOKEN)?.liveActivity).toMatchObject({ activityId: 'akt-1', updateToken: UPDATE });
      await vi.waitFor(() => { expect(laSent).toHaveLength(1); });
      expect(laSent[0]?.token).toBe(UPDATE);
      expect(event(0)).toBe('update');
    });

    it('`…/end` z innym `activityId` → 204 i nic; zgodny → 204, blok skasowany, `end` do aktywności', async () => {
      await post(apnsHarness, '/api/push/apns', register, asPhone);
      await post(apnsHarness, '/api/push/live-activity', activity);
      await vi.waitFor(() => { expect(laSent).toHaveLength(1); });
      expect((await post(apnsHarness, '/api/push/live-activity/end', { deviceToken: TOKEN, activityId: 'stara' })).status)
        .toBe(204);
      expect(devices.get(TOKEN)?.liveActivity?.activityId).toBe('akt-1');
      expect((await post(apnsHarness, '/api/push/live-activity/end', { deviceToken: LOWER, activityId: 'akt-1' })).status)
        .toBe(204);
      expect(devices.get(TOKEN)?.liveActivity).toBeUndefined();
      await vi.waitFor(() => { expect(event(1)).toBe('end'); });
    });

    it('`…/end` bez `activityId` → 400 (id jest wymagany, kontrakt K)', async () => {
      expect((await post(apnsHarness, '/api/push/live-activity/end', { deviceToken: TOKEN })).status).toBe(400);
    });

    it('wyrejestrowanie urządzenia (wylogowanie) kończy jego aktywność, potem usuwa wpis', async () => {
      await post(apnsHarness, '/api/push/apns', register, asPhone);
      await post(apnsHarness, '/api/push/live-activity', activity);
      await vi.waitFor(() => { expect(laSent).toHaveLength(1); });
      expect((await post(apnsHarness, '/api/push/apns/unregister', { token: TOKEN })).status).toBe(204);
      expect(devices.size).toBe(0);
      await vi.waitFor(() => { expect(event(1)).toBe('end'); });
      expect(laSent[1]?.token).toBe(UPDATE);
    });
  });

  it('log niesie liczby — nigdy tokenu ani etykiety', async () => {
    await post(apnsHarness, '/api/push/apns', { ...register, label: 'iPad Jana·Rarog', test: true }, asPhone);
    await post(apnsHarness, '/api/push/apns/status', { token: TOKEN });
    await post(apnsHarness, '/api/push/apns/unregister', { token: TOKEN });
    await vi.waitFor(() => { expect(logged.some((m) => m.includes('test push'))).toBe(true); });
    const text = logged.join('\n');
    expect(text).toContain('push: APNs device saved (devices: 1)');
    expect(text).not.toContain(LOWER.slice(0, 16));
    expect(text).not.toContain(TOKEN.slice(0, 16));
    expect(text).not.toContain('Jana');
  });
});

describe('GET /api/sessions/:id/uploads/:file — miniatura zdjęcia z .rarog-uploads', () => {
  const NAME = '1788361542375-67f5f846e6fe49e7.png';
  const BYTES = Buffer.from('PNG-bajty');
  /** Atrapa `uploads.read`: zna jedno zdjęcie w cwd sesji `s1` i zapisuje, o co ją pytano. */
  const readUpload = (): { fn: RouterDeps['readUpload']; calls: [string, string][] } => {
    const calls: [string, string][] = [];
    const fn: RouterDeps['readUpload'] = (cwd, name) => {
      calls.push([cwd, name]);
      return Promise.resolve(
        cwd === '/tmp/rarog-demo/willow' && name === NAME ? { bytes: BYTES, mime: 'image/png' } : null,
      );
    };
    return { fn, calls };
  };

  it('oddaje bajty z MIME, cache immutable i nosniff — katalog z cwd SESJI, nie z żądania', async () => {
    const reader = readUpload();
    const h = await startHarness({}, undefined, { readUpload: reader.fn });
    try {
      const res = await get(h, `/api/sessions/s1/uploads/${NAME}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toContain('immutable');
      expect(res.headers.get('cache-control')).toContain('private');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
      expect(reader.calls).toEqual([['/tmp/rarog-demo/willow', NAME]]);
    } finally {
      await h.close();
    }
  });

  it('bez klucza → 401, zanim ktokolwiek dotknie dysku', async () => {
    const reader = readUpload();
    const h = await startHarness({}, undefined, { readUpload: reader.fn });
    try {
      const res = await get(h, `/api/sessions/s1/uploads/${NAME}`, { auth: null });
      expect(res.status).toBe(401);
      expect(reader.calls).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('nieznana sesja, nieznane zdjęcie i brak czytnika (demo) → 404, nigdy 500', async () => {
    const reader = readUpload();
    const h = await startHarness({}, undefined, { readUpload: reader.fn });
    try {
      expect((await get(h, `/api/sessions/nie-ma/uploads/${NAME}`)).status).toBe(404);
      expect((await get(h, '/api/sessions/s1/uploads/1-zla.png')).status).toBe(404);
      // Nieznana sesja nie pyta czytnika wcale — nie ma cwd, którym mógłby się posłużyć.
      expect(reader.calls).toEqual([['/tmp/rarog-demo/willow', '1-zla.png']]);
    } finally {
      await h.close();
    }
    const demo = await startHarness();
    try {
      expect((await get(demo, `/api/sessions/s1/uploads/${NAME}`)).status).toBe(404);
    } finally {
      await demo.close();
    }
  });

  /*
   * Sesja poza zasięgiem i wpis Codexa nie oddają niczego z katalogu panelu: ta sama granica
   * co transkrypt i diff. Czytnik nie jest pytany wcale.
   */
  it('sesja poza zasięgiem i wpis Codexa → 404, czytnik nie rusza', async () => {
    const reader = readUpload();
    const h = await startHarness({}, [
      makeSummary({ id: 'poza', cwd: '/tmp/rarog-demo/willow', outOfScope: true }),
      makeSummary({ id: 'codex', cwd: '/tmp/rarog-demo/willow', engine: 'codex' }),
    ], { readUpload: reader.fn });
    try {
      expect((await get(h, `/api/sessions/poza/uploads/${NAME}`)).status).toBe(404);
      expect((await get(h, `/api/sessions/codex/uploads/${NAME}`)).status).toBe(404);
      expect(reader.calls).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('inna metoda niż GET → 405', async () => {
    const h = await startHarness({}, undefined, { readUpload: readUpload().fn });
    try {
      const res = await post(h, `/api/sessions/s1/uploads/${NAME}`, {});
      expect(res.status).toBe(405);
    } finally {
      await h.close();
    }
  });
});
