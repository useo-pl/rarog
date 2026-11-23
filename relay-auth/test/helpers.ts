/**
 * Wspólne atrapy testów rejestru: magazyn Durable Object w pamięci (z alarmem i awarią zapisu na żądanie), zegar
 * ręczny, rejestr w procesie (prawdziwe maszyny `registry.ts` na atrapie magazynu), atrapa Apple, liczniki limitów,
 * klucze Ed25519 z syntetycznego ziarna i klucz PEM P-256 generowany w czasie testu (żaden klucz nie leży w repo).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import manifestJson from '../../shared/fixtures/relay-auth/manifest.json';
import { RELAY_AUTH_PATHS, relayAuthSigningBytes } from '../../shared/src/relay-auth.ts';
import type {
  RelayAuthAppRoute, RelayAuthEnvironment, RelayAuthRoute, RelayAuthUnsigned,
} from '../../shared/src/relay-auth.ts';
import { prepare } from '../src/config.ts';
import type { Prepared, RelayAuthEnv } from '../src/config.ts';
import { createRelayAuth } from '../src/core.ts';
import type { AuthLimits, RelayAuth, Registry } from '../src/core.ts';
import { fromHex } from '../src/crypto.ts';
import { DenyBook, EndpointBook, GateDesk } from '../src/registry.ts';
import type {
  AppleFailure, AppleGate, AppleResult, Clock, DeviceBits, EndpointApi, EndpointRecord, EndpointState, Store,
} from '../src/registry.ts';
import { base64Decode, hex, sha256Hex } from '../src/wspolne.ts';

export const manifest = manifestJson;
export const ORIGIN = 'https://relay-auth.rarog.ai';
/** `issuedAt` wszystkich żądań manifestu: zegar testów rdzenia stoi tu, żeby podpisy manifestu przeszły. */
export const T0 = 1_793_700_000;
export const DAY = 24 * 3600;
export const APP = manifest.key.endpointId;
export const SERVER_A = 'a1'.repeat(32);
export const SERVER_B = 'b2'.repeat(32);
export const HOOK_BEARER = 'TEST-ONLY-relay-hook-bearer-01234';
export const ADMIN_BEARER = 'TEST-ONLY-admin-bearer-0123456789';
/** Syntetyczne identyfikatory Apple (10 znaków), nie z portalu. */
export const TEAM_ID = 'TEAMID0001';
export const KEY_ID = 'KEYID00001';

/** Oddanie pętli zdarzeń bez progu 1 ms `setTimeout` (test modelowy robi tysiące operacji). */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Magazyn Durable Object w pamięci. Każda operacja oddaje pętlę zdarzeń, więc wyścig bez kolejki byłby widoczny. */
export class MemoryStore implements Store {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  /** Zapis, który ma rzucić (awaria między zapisami); `true` = rzuć. */
  failPut: ((key: string, value: unknown) => boolean) | undefined;
  /** Obserwator udanego zapisu: klucze zapisane razem (test modelowy czyta nim rozliczenia i stan apek). */
  onPut: ((keys: readonly string[]) => void) | undefined;

  async get<T>(key: string): Promise<T | undefined> {
    await tick();
    const value = this.data.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  /** Jeden klucz albo kilka atomowo (jak `DurableObjectStorage`): awaria jednego klucza nie zapisuje żadnego. */
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    await tick();
    const entries = typeof keyOrEntries === 'string' ? [[keyOrEntries, value] as const] : Object.entries(keyOrEntries);
    if (entries.some(([key, item]) => this.failPut?.(key, item) === true)) throw new Error('atrapa: awaria zapisu');
    for (const [key, item] of entries) this.data.set(key, structuredClone(item));
    this.onPut?.(entries.map(([key]) => key));
  }

  async delete(key: string): Promise<boolean> {
    await tick();
    return this.data.delete(key);
  }

  async deleteAll(): Promise<void> {
    await tick();
    this.data.clear();
  }

  async list<T>(options: { readonly prefix: string }): Promise<Map<string, T>> {
    await tick();
    const keys = [...this.data.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    return new Map(keys.map((key) => [key, structuredClone(this.data.get(key)) as T]));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

/** Zegar rejestru ustawiany ręcznie (sekundy); alarm platformy w tej samej skali co zegar. */
export class ManualClock implements Clock {
  sec: number;

  constructor(sec: number) {
    this.sec = sec;
  }

  nowMs(): number {
    return this.sec * 1000;
  }

  alarmAt(ms: number): number {
    return ms;
  }

  advance(seconds: number): void {
    this.sec += seconds;
  }
}

const monthOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 7);

type AppleCall = 'query' | 'update' | 'probe';

/** Apple w pamięci: bity DeviceCheck per token z miesiącem zegara, próbny push zawsze 200, porażki ze skryptu. */
export class FakeApple implements AppleGate {
  readonly bits = new Map<string, DeviceBits>();
  readonly calls: { readonly call: AppleCall; readonly environment: RelayAuthEnvironment; readonly token: string }[] = [];
  /** Porażka następnego wywołania danego rodzaju (jednorazowa). */
  readonly failNext = new Map<AppleCall, AppleFailure>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  #record(call: AppleCall, environment: RelayAuthEnvironment, token: string): AppleFailure | undefined {
    this.calls.push({ call, environment, token });
    const failure = this.failNext.get(call);
    this.failNext.delete(call);
    return failure;
  }

  async queryBits(environment: RelayAuthEnvironment, token: string): Promise<AppleResult<DeviceBits | null>> {
    await tick();
    const failure = this.#record('query', environment, token);
    return failure === undefined ? { ok: true, value: this.bits.get(token) ?? null } : { ok: false, failure };
  }

  async updateBits(environment: RelayAuthEnvironment, token: string, bit0: boolean, bit1: boolean):
    Promise<AppleResult<null>> {
    await tick();
    const failure = this.#record('update', environment, token);
    if (failure !== undefined) return { ok: false, failure };
    this.bits.set(token, { bit0, bit1, lastUpdate: monthOf(Math.floor(this.#clock.nowMs() / 1000)) });
    return { ok: true, value: null };
  }

  async probe(environment: RelayAuthEnvironment, token: string): Promise<AppleResult<null>> {
    await tick();
    const failure = this.#record('probe', environment, token);
    return failure === undefined ? { ok: true, value: null } : { ok: false, failure };
  }

  count(call: AppleCall): number {
    return this.calls.filter((item) => item.call === call).length;
  }
}

export interface Latch {
  readonly reached: Promise<void>;
  release(): void;
}

/**
 * Jednorazowe przechwycenie wywołania metody wpisu: `before` przed wejściem do maszyny, `lose` = metoda wykonuje się
 * w całości, a odpowiedź ginie (wyjątek po trwałym skutku). `owner`: żądanie, w którym przechwycenie założono
 * ({@link LocalRegistry.within}); działa tylko na jego wywołania. Bez `owner` działa na każde.
 */
interface Intercept {
  readonly id: string;
  readonly methods: readonly string[];
  readonly before?: () => Promise<void>;
  readonly lose?: true;
  readonly owner: object | undefined;
}

/**
 * Żądanie, w którym biegnie wywołanie. Jeden magazyn na moduł: każdy `AsyncLocalStorage` w Node 22 obciąża każdą
 * obietnicę procesu, więc magazyn na rejestr spowalniał test modelowy z każdym przebiegiem.
 */
const requestOwner = new AsyncLocalStorage<object>();

/** Rejestr w procesie: maszyny `registry.ts` na atrapach magazynu i lustro KV w mapie (klucz → termin). */
export class LocalRegistry implements Registry {
  readonly stores = new Map<string, MemoryStore>();
  readonly books = new Map<string, EndpointBook>();
  readonly gateStore = new MemoryStore();
  readonly adminStore = new MemoryStore();
  readonly mirror = new Map<string, number>();
  readonly desk: GateDesk;
  readonly denyBook: DenyBook;
  readonly #clock: ManualClock;
  readonly #intercepts: Intercept[] = [];
  /** Wywołanie Durable Object, które ma rzucić (awaria magazynu przy haku). */
  failStatus = false;
  /** Obserwator udanego zapisu magazynu wpisu `id` (test modelowy czyta nim każdy trwały stan apki). */
  onStorePut: ((id: string, keys: readonly string[]) => void) | undefined;
  /** Obserwator każdego wywołania metody wpisu, które maszyna wykonała do końca (także przy utraconej odpowiedzi). */
  observe: ((id: string, method: string, args: readonly unknown[], result: unknown) => void) | undefined;

  constructor(clock: ManualClock, prepared: Prepared, apple: AppleGate | null) {
    this.#clock = clock;
    const { settings } = prepared;
    this.desk = new GateDesk({
      store: this.gateStore,
      clock,
      settings: {
        gate: settings.gate, registerMonthly: settings.quotas.registerMonthly,
        registerDailyBrake: settings.quotas.registerDailyBrake, graceUntil: settings.graceUntil,
      },
      apple: prepared.registrations ? apple : null,
      endpoint: (id) => this.endpoint(id),
      sha256Hex,
    });
    this.denyBook = new DenyBook(this.adminStore, clock, {
      put: async (id, until) => { this.mirror.set(id, until); },
      delete: async (id) => { this.mirror.delete(id); },
    });
  }

  storeOf(id: string): MemoryStore {
    let store = this.stores.get(id);
    if (store === undefined) {
      store = new MemoryStore();
      store.onPut = (keys) => { this.onStorePut?.(id, keys); };
      this.stores.set(id, store);
    }
    return store;
  }

  bookOf(id: string): EndpointBook {
    let book = this.books.get(id);
    if (book === undefined) {
      book = new EndpointBook(this.storeOf(id), this.#clock, (peer) => this.endpoint(peer));
      this.books.set(id, book);
    }
    return book;
  }

  /**
   * Zatrzask między obiektami: pierwsze wywołanie jednej z `methods` wpisu `id` (RPC, zanim wejdzie do maszyny)
   * czeka na `release()`; `reached` spełnia się, gdy wywołanie doszło. Test wciska w tę chwilę inne żądanie.
   */
  pause(id: string, methods: readonly string[]): Latch {
    let reach = (): void => undefined;
    let free = (): void => undefined;
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    const released = new Promise<void>((resolve) => { free = resolve; });
    this.#intercepts.push({
      id, methods, before: async () => { reach(); await released; }, owner: requestOwner.getStore(),
    });
    return { reached, release: () => { free(); } };
  }

  /** Pierwsze wywołanie `method` wpisu `id` rzuca (Durable Object nie odpowiedział), zanim wejdzie do maszyny. */
  failOnce(id: string, method: string): void {
    this.#intercepts.push({
      id, methods: [method], before: () => Promise.reject(new Error(`atrapa: ${method} nie odpowiada`)),
      owner: requestOwner.getStore(),
    });
  }

  /**
   * Pierwsze wywołanie `method` wpisu `id` wykonuje się w maszynie do końca (stan zapisany), ale wywołujący dostaje
   * wyjątek: odpowiedź RPC zginęła po trwałym skutku.
   */
  loseReply(id: string, method: string): void {
    this.#intercepts.push({ id, methods: [method], lose: true, owner: requestOwner.getStore() });
  }

  /**
   * `task` jako jedno żądanie: przechwycenia założone w nim działają tylko na jego wywołania, także po wznowieniu
   * z zatrzasku, gdy w międzyczasie te same metody wołają inne żądania.
   */
  within<T>(owner: object, task: () => T): T {
    return requestOwner.run(owner, task);
  }

  /** Przechwycenia żądania `owner` (bez argumentu: wszystkie), do których nic nie doszło, znikają. */
  clearIntercepts(owner?: object): void {
    const kept = this.#intercepts.filter((item) => owner !== undefined && item.owner !== owner);
    this.#intercepts.splice(0, this.#intercepts.length, ...kept);
  }

  /** Wpis jak stub RPC: każda metoda przechodzi przez przechwycenia (zatrzask, awaria, utracona odpowiedź). */
  endpoint(id: string): EndpointApi {
    const book = this.bookOf(id);
    return new Proxy(book, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]): Promise<unknown> => {
          if (this.failStatus && property === 'status') throw new Error('atrapa: magazyn nie odpowiada');
          const caller = requestOwner.getStore();
          const index = this.#intercepts.findIndex((item) => item.id === id && item.methods.includes(String(property))
            && (item.owner === undefined || item.owner === caller));
          const intercept = index >= 0 ? this.#intercepts.splice(index, 1)[0] : undefined;
          await intercept?.before?.();
          const result: unknown = await (value as (...values: unknown[]) => unknown).apply(target, args);
          this.observe?.(id, String(property), args, result);
          if (intercept?.lose === true) throw new Error(`atrapa: odpowiedź ${String(property)} zginęła`);
          return result;
        };
      },
    });
  }

  gate(): GateDesk {
    return this.desk;
  }

  admin(): DenyBook {
    return this.denyBook;
  }

  readonly isDenied = async (id: string): Promise<boolean> => {
    const until = this.mirror.get(id);
    return until !== undefined && until > this.#clock.sec;
  };

  /** Alarmy, których termin minął (jak platforma: alarm zdjęty przed wywołaniem). */
  async fireAlarms(): Promise<void> {
    const due = (store: MemoryStore): boolean => store.alarm !== null && store.alarm <= this.#clock.nowMs();
    for (const [id, store] of this.stores) {
      if (!due(store)) continue;
      store.alarm = null;
      await this.bookOf(id).alarm();
    }
    if (due(this.gateStore)) {
      this.gateStore.alarm = null;
      await this.desk.alarm();
    }
    if (due(this.adminStore)) {
      this.adminStore.alarm = null;
      await this.denyBook.alarm();
    }
  }

  /** Surowy stan obiektu EndpointId w magazynie (bez filtrowania terminów). */
  state(id: string): EndpointState | undefined {
    return this.stores.get(id)?.data.get('state') as EndpointState | undefined;
  }

  /** Surowy wpis EndpointId w magazynie (bez filtrowania terminów); brak wpisu = `undefined`. */
  entry(id: string): EndpointRecord | undefined {
    return this.state(id)?.entry ?? undefined;
  }
}

/** Liczniki limitów: `false` po `max` wywołaniach per klucz albo wyjątek; klucze zapamiętane. */
export class FakeLimits implements AuthLimits {
  readonly keys: { readonly limiter: 'app' | 'register'; readonly key: string }[] = [];
  appMax = Number.POSITIVE_INFINITY;
  registerMax = Number.POSITIVE_INFINITY;
  throwOn: 'app' | 'register' | null = null;

  #count(limiter: 'app' | 'register', key: string, max: number): boolean {
    if (this.throwOn === limiter) throw new Error('atrapa: licznik nie odpowiada');
    this.keys.push({ limiter, key });
    return this.keys.filter((item) => item.limiter === limiter && item.key === key).length <= max;
  }

  async app(key: string): Promise<boolean> {
    return this.#count('app', key, this.appMax);
  }

  async register(key: string): Promise<boolean> {
    return this.#count('register', key, this.registerMax);
  }
}

/** Klucz PEM PKCS#8 P-256 wygenerowany teraz (format klucza z portalu Apple); nigdzie nie zapisywany. */
export async function generatedPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as
    CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  const base64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${base64.replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
}

/** Zmienne Workera jak w produkcji (bramka DeviceCheck, egzekwowanie), z wartościami testowymi. */
export async function productionEnv(extra: RelayAuthEnv = {}): Promise<RelayAuthEnv> {
  return {
    DEPLOY_SHA: 'fixture', GATE_KIND: 'devicecheck', ENFORCE: '1', APPLE_TEAM_ID: TEAM_ID,
    REGISTER_MONTHLY_QUOTA: '3', REGISTER_DAILY_BRAKE: '200', SPONSOR_QUOTA: '3', SPONSORED_LIVE_MAX: '5',
    QUOTA_GRACE_UNTIL: '', DIAG_UNTIL: '', RELAY_HOOK_SECRET: HOOK_BEARER, ADMIN_SECRET: ADMIN_BEARER,
    DEVICECHECK_KEY: await generatedPem(), DEVICECHECK_KEY_ID: KEY_ID, APNS_KEY: await generatedPem(),
    APNS_KEY_ID: KEY_ID, ...extra,
  };
}

const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

export interface AppKey {
  readonly endpointId: string;
  /** Ciało trasy z `v: 1`, `endpointId` tego klucza i podpisem; `fields` = `issuedAt` i pola trasy. */
  sign(route: RelayAuthAppRoute, fields: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>;
}

/** Klucz Ed25519 apki z ziarna `seedByte` × 32 (syntetyczne, jak w manifeście: `0x07` daje `APP`). */
export async function appKey(seedByte: number): Promise<AppKey> {
  const seed = new Uint8Array(32).fill(seedByte);
  const der = new Uint8Array([...(fromHex(PKCS8_ED25519_PREFIX) ?? []), ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key) as JsonWebKey;
  const endpointId = hex(base64Decode(jwk.x ?? '') ?? new Uint8Array());
  return {
    endpointId,
    async sign(route, fields) {
      const unsigned = { v: 1, endpointId, ...fields };
      const bytes = Uint8Array.from(relayAuthSigningBytes(route, unsigned as unknown as RelayAuthUnsigned<typeof route>));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, bytes));
      return { ...unsigned, sig: hex(sig) };
    },
  };
}

/** Dowód DeviceCheck w kształcie kontraktu (base64 z dopełnieniem), syntetyczny i o niskiej entropii. */
export const deviceCheckProof = (letter: string, environment: RelayAuthEnvironment = 'production') =>
  ({ kind: 'devicecheck', environment, token: btoa(letter.repeat(48)) }) as const;

/** Dowód APNs: token urządzenia hex, syntetyczny. */
export const apnsProof = (pair: string, environment: RelayAuthEnvironment = 'development') =>
  ({ kind: 'apns', environment, token: pair.repeat(32) }) as const;

/** Żądanie HTTP trasy kontraktu z nagłówkami apki z manifestu (albo podanymi). */
export function request(route: RelayAuthRoute, body?: unknown,
  headers: Readonly<Record<string, string>> = manifest.headers.app): Request {
  const method = route === 'health' ? 'GET' : 'POST';
  return new Request(`${ORIGIN}${RELAY_AUTH_PATHS[route]}`, {
    method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

/** Żądanie haka dokładnie takie, jakie adapter na VPS przekazuje Workerowi: POST bez ciała, dwa nagłówki. */
export function hookRequest(endpointId: string, bearer = HOOK_BEARER): Request {
  return new Request(`${ORIGIN}${RELAY_AUTH_PATHS.access}`, {
    method: 'POST', headers: { 'x-iroh-endpoint-id': endpointId, authorization: `Bearer ${bearer}` },
  });
}

export interface Harness {
  readonly prepared: Prepared;
  readonly clock: ManualClock;
  readonly apple: FakeApple;
  readonly registry: LocalRegistry;
  readonly limits: FakeLimits;
  readonly lines: string[];
  readonly auth: RelayAuth;
  call(request: Request, clientAddress?: string | null): Promise<Response>;
  /** Linie logu jako obiekty. */
  logged(): Record<string, unknown>[];
}

/** Rdzeń Workera nad rejestrem w procesie; zegar od `start`, zmienne produkcyjne z nadpisaniem. */
export async function harness(extra: RelayAuthEnv = {}, start = T0): Promise<Harness> {
  const prepared = await prepare(await productionEnv(extra));
  const clock = new ManualClock(start);
  const apple = new FakeApple(clock);
  const registry = new LocalRegistry(clock, prepared, apple);
  const limits = new FakeLimits();
  const lines: string[] = [];
  const auth = createRelayAuth(prepared, {
    registry, isDenied: registry.isDenied, now: () => clock.nowMs(), log: (line) => { lines.push(line); },
  });
  return {
    prepared, clock, apple, registry, limits, lines, auth,
    call: (req, clientAddress = '198.51.100.7') => auth.handle(req, { clientAddress, limits }),
    logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export async function json(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}
