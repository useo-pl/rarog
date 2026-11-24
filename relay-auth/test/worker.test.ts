/**
 * Adapter Workers (`src/worker.ts`) i klasy Durable Objects (`src/objects.ts`) w Node: wiązania to atrapy (przestrzeń
 * Durable Objects tworzy prawdziwe klasy nad atrapą magazynu, KV i liczniki w pamięci), wywołania Apple idą do atrapy
 * globalnego `fetch`. Sprawdza to, czego rdzeń nie widzi: `idFromName` w jurysdykcji UE, `cacheTtl` odmów z KV,
 * adres klienta z nagłówków Cloudflare, `CLOCK_OFFSET`, log problemów konfiguracji raz na izolat, cron bez pracy.
 * Prawdziwy runtime: `workerd.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELAY_AUTH_PATHS } from '../../shared/src/relay-auth.ts';
import { DENY_TTL_SECONDS, ENTRY_TTL_SECONDS, RESERVATION_TTL_SECONDS } from '../src/registry.ts';
import { Admin, Endpoint, Gate } from '../src/objects.ts';
import { DENIED_CACHE_TTL_SECONDS } from '../src/config.ts';
import * as workerModule from '../src/worker.ts';
import worker from '../src/worker.ts';
import type { Env } from '../src/worker.ts';
import {
  APP, KEY_ID, MemoryStore, ORIGIN, SERVER_A, SERVER_B, T0, TEAM_ID, deviceCheckProof, hookRequest, json, manifest,
  productionEnv, request,
} from './helpers.ts';

const ctx = {} as ExecutionContext;

/** Przestrzeń Durable Objects; `jurisdiction()` daje widok, którego identyfikatory niosą jurysdykcję. */
class FakeNamespace<T> {
  readonly instances: Map<string, T>;
  readonly gets: { readonly name: string; readonly jurisdiction: string | undefined; readonly options: unknown }[];
  readonly #make: (name: string) => T;
  readonly #jurisdiction: string | undefined;

  constructor(make: (name: string) => T, parent?: FakeNamespace<T>, jurisdiction?: string) {
    this.#make = make;
    this.instances = parent?.instances ?? new Map<string, T>();
    this.gets = parent?.gets ?? [];
    this.#jurisdiction = jurisdiction;
  }

  jurisdiction(jurisdiction: string): FakeNamespace<T> {
    return new FakeNamespace(this.#make, this, jurisdiction);
  }

  idFromName(name: string): DurableObjectId {
    return { name, jurisdiction: this.#jurisdiction } as unknown as DurableObjectId;
  }

  get(id: DurableObjectId, options?: unknown): T {
    const { name, jurisdiction } = id as unknown as { name: string; jurisdiction: string | undefined };
    this.gets.push({ name, jurisdiction, options });
    // Jak w Cloudflare: ta sama nazwa w innej jurysdykcji to inny obiekt z osobnym magazynem.
    const key = jurisdiction === undefined ? name : `${jurisdiction}/${name}`;
    let instance = this.instances.get(key);
    if (instance === undefined) {
      instance = this.#make(key);
      this.instances.set(key, instance);
    }
    return instance;
  }
}

class FakeKv {
  readonly data = new Map<string, string>();
  readonly gets: { readonly key: string; readonly options: unknown }[] = [];
  readonly puts: { readonly key: string; readonly options: unknown }[] = [];

  async get(key: string, options?: unknown): Promise<string | null> {
    this.gets.push({ key, options });
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string, options?: unknown): Promise<void> {
    this.puts.push({ key, options });
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

class FakeRateLimit {
  readonly keys: string[] = [];

  async limit(options: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(options.key);
    return { success: true };
  }
}

interface Bindings {
  readonly env: Env;
  readonly endpoints: FakeNamespace<Endpoint>;
  readonly gates: FakeNamespace<Gate>;
  readonly admins: FakeNamespace<Admin>;
  readonly stores: Map<string, MemoryStore>;
  readonly kv: FakeKv;
  readonly rlApp: FakeRateLimit;
  readonly rlRegister: FakeRateLimit;
}

const state = (storage: MemoryStore): DurableObjectState => ({ storage }) as unknown as DurableObjectState;

async function bindings(vars: Record<string, string> = {}): Promise<Bindings> {
  const kv = new FakeKv();
  const rlApp = new FakeRateLimit();
  const rlRegister = new FakeRateLimit();
  const stores = new Map<string, MemoryStore>();
  const storeOf = (name: string): MemoryStore => {
    const store = stores.get(name) ?? new MemoryStore();
    stores.set(name, store);
    return store;
  };
  const env = {
    ...(await productionEnv(vars)), DENIED: kv, RL_APP: rlApp, RL_REGISTER: rlRegister,
  } as unknown as Record<string, unknown>;
  const endpoints = new FakeNamespace((name) => new Endpoint(state(storeOf(name)), env as unknown as Env));
  const gates = new FakeNamespace((name) => new Gate(state(storeOf(`gate:${name}`)), env as unknown as Env));
  const admins = new FakeNamespace((name) => new Admin(state(storeOf(`admin:${name}`)), env as unknown as Env));
  env['ENDPOINT'] = endpoints;
  env['GATE'] = gates;
  env['ADMIN'] = admins;
  return { env: env as unknown as Env, endpoints, gates, admins, stores, kv, rlApp, rlRegister };
}

interface AppleCall {
  readonly url: string;
  readonly authorization: string;
}

/** Atrapa Apple pod globalnym `fetch`: DeviceCheck bez bitów, zapis bitów 200. */
function stubApple(): AppleCall[] {
  const calls: AppleCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, authorization: String((init.headers as Record<string, string>)['authorization']) });
    return new Response(url.endsWith('/query_two_bits') ? 'Failed to find bit state' : '', { status: 200 });
  });
  return calls;
}

/** Żądanie z sieci w typie Workers (`cf` z metadanymi wejścia; tu puste). */
const incoming = (req: Request): Request<unknown, IncomingRequestCfProperties> =>
  req as unknown as Request<unknown, IncomingRequestCfProperties>;

const call = (b: Bindings, req: Request): Promise<Response> => worker.fetch(incoming(req), b.env, ctx);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0 * 1000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('worker.fetch nad klasami Durable Objects', () => {
  it('register → sponsor → hak: odpowiedzi manifestu, Apple przez fetch z tokenem dostawcy', async () => {
    const b = await bindings();
    const apple = stubApple();
    const registered = await call(b, request('register', manifest.requests['register.devicecheck'].body));
    expect(await json(registered)).toEqual(manifest.responses['register.ok'].body);
    expect(apple.map((item) => item.url)).toEqual([
      'https://api.devicecheck.apple.com/v1/query_two_bits', 'https://api.devicecheck.apple.com/v1/update_two_bits',
    ]);
    const jwt = /^Bearer ([^.]+)\.([^.]+)\./.exec(apple[0]?.authorization ?? '');
    expect(JSON.parse(atob(jwt?.[1] ?? ''))).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(JSON.parse(atob(jwt?.[2] ?? ''))).toEqual({ iss: TEAM_ID, iat: expect.any(Number) as number });

    expect(await json(await call(b, request('sponsor', manifest.requests.sponsor.body))))
      .toEqual(manifest.responses['sponsor.ok'].body);
    const access = await call(b, hookRequest(SERVER_A));
    expect([access.status, await access.text()]).toEqual([200, 'true']);
    expect(b.kv.gets.every((item) => JSON.stringify(item.options) === JSON.stringify({ cacheTtl: 60 }))).toBe(true);
    expect(DENIED_CACHE_TTL_SECONDS).toBe(60);
    expect(new Set(b.endpoints.gets.map((item) => item.name))).toEqual(new Set([APP, SERVER_A]));
  });

  it('każdy obiekt rejestru w jurysdykcji UE: wpisy, bramka i lista odmów', async () => {
    const b = await bindings();
    stubApple();
    await call(b, request('register', manifest.requests['register.devicecheck'].body));
    await call(b, request('sponsor', manifest.requests.sponsor.body));
    await call(b, request('deny', manifest.admin.deny.body, manifest.headers.admin));
    const gets = [...b.endpoints.gets, ...b.gates.gets, ...b.admins.gets];
    expect([b.endpoints.gets.length, b.gates.gets.length, b.admins.gets.length].every((n) => n > 0)).toBe(true);
    expect(gets.filter((item) => item.jurisdiction !== 'eu' || item.options !== undefined)).toEqual([]);
  });

  it('NO_JURISDICTION=1 (tylko poza produkcją): obiekty bez jurysdykcji i linia `config`', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const b = await bindings({ NO_JURISDICTION: '1' });
    stubApple();
    await call(b, request('register', manifest.requests['register.devicecheck'].body));
    const gets = [...b.endpoints.gets, ...b.gates.gets];
    expect(gets.length > 0 && gets.every((item) => item.jurisdiction === undefined)).toBe(true);
    expect(log.mock.calls.map(([line]) => String(line))).toContain('{"event":"config","problem":"no-jurisdiction"}');
  });

  it('odmowa administratora: KV z terminem roku, hak odmawia od razu; allow zdejmuje', async () => {
    const b = await bindings();
    const admin = manifest.headers.admin;
    expect((await call(b, request('deny', manifest.admin.deny.body, admin))).status).toBe(200);
    expect(b.kv.puts).toEqual([{ key: SERVER_B, options: { expirationTtl: DENY_TTL_SECONDS } }]);
    const denied = await call(b, hookRequest(SERVER_B));
    expect([denied.status, await denied.text()]).toEqual([403, 'false']);
    expect((await call(b, request('allow', manifest.admin.allow.body, admin))).status).toBe(200);
    expect(b.kv.data.size).toBe(0);
  });

  it.each([
    [{ 'cf-connecting-ip': '198.51.100.7' }, '198.51.100.7'],
    [{ 'cf-connecting-ip': '240.0.0.9', 'cf-connecting-ipv6': '2001:db8:a:b::1' }, '2001:0db8:000a:000b::/64'],
    [{ 'cf-connecting-ip': '240.0.0.9' }, '240.0.0.9'],
    [{ 'cf-connecting-ip': '198.51.100.7', 'cf-connecting-ipv6': '2001:db8:a:b::1' }, '198.51.100.7'],
    [{}, 'unknown'],
  ])('adres klienta %o → klucz limitu %s', async (headers, key) => {
    const b = await bindings();
    stubApple();
    const body = manifest.requests['register.devicecheck'].body;
    await call(b, request('register', body, { ...manifest.headers.app, ...headers }));
    expect(b.rlApp.keys).toEqual([key]);
    expect(b.rlRegister.keys).toEqual([key]);
  });

  it('GET /v1/health z ustawień; wada konfiguracji: ok false i linia `config` raz na izolat', async () => {
    const good = await bindings();
    expect(await json(await call(good, request('health')))).toEqual(manifest.responses['health.devicecheck'].body);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const bad = await bindings({ SPONSOR_QUOTA: 'trzy' });
    expect(await json(await call(bad, request('health')))).toMatchObject({ ok: false });
    await call(bad, request('health'));
    const config = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"event":"config"'));
    expect(config).toEqual(['{"event":"config","problem":"sponsor-quota-invalid"}']);
  });

  it('a short secret gives a `config` line by name, and health stays ok because app routes do not need it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const b = await bindings({ ADMIN_SECRET: 'x'.repeat(31), RELAY_HOOK_SECRET: 'y'.repeat(31) });
    expect(await json(await call(b, request('health')))).toMatchObject({ ok: true });
    const config = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"event":"config"'));
    expect(config).toEqual([
      '{"event":"config","problem":"relay-hook-secret-short"}',
      '{"event":"config","problem":"admin-secret-short"}',
    ]);
  });

  it('moduł główny eksportuje wyłącznie handler i klasy Durable Objects (workerd odrzuca inne wartości)', () => {
    expect(Object.keys(workerModule).sort()).toEqual(['Admin', 'Endpoint', 'Gate', 'default']);
  });

  it('cron kończy się bez pracy i bez wiązań', async () => {
    const untouched = new Proxy({}, { get: () => { throw new Error('cron użył wiązania'); } }) as unknown as Env;
    await expect(Promise.resolve(worker.scheduled({} as ScheduledController, untouched, ctx))).resolves.toBeUndefined();
  });
});

describe('klasy Durable Objects', () => {
  it('CLOCK_OFFSET: wpis liczy terminy zegarem przesuniętym, alarm platformy w czasie prawdziwym', async () => {
    const store = new MemoryStore();
    const env = { ...(await productionEnv({ CLOCK_OFFSET: '3600' })) } as unknown as Env;
    const endpoint = new Endpoint(state(store), env);
    expect(await endpoint.admitApp(APP, { charge: 'c1', at: T0 + 3600 }))
      .toEqual({ ok: true, expiresAt: T0 + 3600 + ENTRY_TTL_SECONDS });
    expect(store.alarm).toBe((T0 + ENTRY_TTL_SECONDS) * 1000);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const b = await bindings({ CLOCK_OFFSET: '3600', DEPLOY_SHA: 'offset' });
    await call(b, request('health'));
    expect(log.mock.calls.map(([line]) => String(line))).toContain('{"event":"config","problem":"clock-offset"}');
  });

  it('Gate bez bramki odmawia bez Apple; alarm Endpoint kasuje wygasły wpis', async () => {
    const b = await bindings({ GATE_KIND: '' });
    const apple = stubApple();
    const gate = new Gate(state(new MemoryStore()), b.env);
    expect(await gate.register(APP, deviceCheckProof('A'), '198.51.100.7')).toEqual({ ok: false, error: 'unavailable' });
    expect(apple).toEqual([]);

    const store = new MemoryStore();
    const endpoint = new Endpoint(state(store), b.env);
    await endpoint.admitApp(APP, { charge: 'c1', at: T0 });
    vi.setSystemTime((T0 + ENTRY_TTL_SECONDS) * 1000);
    await endpoint.alarm();
    expect(store.data.size).toBe(0);
  });

  it('alarm wpisu apki zdejmuje poręczenie u serwera przez wiązanie ENDPOINT w jurysdykcji UE', async () => {
    const b = await bindings();
    const eu = b.endpoints.jurisdiction('eu');
    const stub = (name: string): Endpoint => eu.get(eu.idFromName(name));
    // Obiekt o tej samej nazwie bez jurysdykcji jest innym obiektem: alarm go nie dotyka.
    const plain = (name: string): Endpoint => b.endpoints.get(b.endpoints.idFromName(name));
    await stub(APP).admitApp(APP, { charge: 'c1', at: T0 });
    const reserved = await stub(APP).reserve(SERVER_A, { windowMax: 3, liveMax: 5 });
    if (!reserved.ok) throw new Error('rezerwacja nie przeszła');
    await stub(SERVER_A).addSponsor(APP, reserved.epoch, reserved.ticket, reserved.expiresAt);
    await plain(SERVER_A).addSponsor(APP, reserved.epoch, reserved.ticket, reserved.expiresAt);
    expect(await stub(SERVER_A).status()).toMatchObject({ kind: 'server' });
    vi.setSystemTime((T0 + RESERVATION_TTL_SECONDS) * 1000);
    const before = b.endpoints.gets.length;
    await stub(APP).alarm();
    const byAlarm = b.endpoints.gets.slice(before).filter((item) => item.name === SERVER_A);
    expect(byAlarm.length > 0 && byAlarm.every((item) => item.jurisdiction === 'eu')).toBe(true);
    expect(await stub(SERVER_A).status()).toBeNull();
    expect(await plain(SERVER_A).status()).toMatchObject({ kind: 'server' });
  });

  it('trasa spoza kontraktu przez adapter = 404', async () => {
    const b = await bindings();
    expect((await call(b, new Request(`${ORIGIN}/v1/pass`, { method: 'POST' }))).status).toBe(404);
    expect(RELAY_AUTH_PATHS.access).toBe('/v1/access');
  });
});
