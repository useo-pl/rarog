/**
 * Atrapy dla testów rdzenia: klucz APNs generowany WebCrypto (nigdy z dysku), `fetch` do Apple ze scenariuszem,
 * liczniki limitów, zegar i szpieg loggera. Sieci nie ma: każde wywołanie Apple trafia do `calls`.
 */
import { createRelay } from '../src/core.ts';
import type { Relay, RequestContext } from '../src/core.ts';
import type { RelayEnv } from '../src/config.ts';

/**
 * Token urządzenia (64 znaki hex, małe litery) i token aktywności (160 znaków, jak bywa u ActivityKit). Wartości
 * są jawnie syntetyczne (powtórzony wzór), ale w formacie walidatora: przekaźnik sprawdza tylko hex i długość.
 */
export const T1 = 'c0ffee00'.repeat(8);
export const T2 = 'a3'.repeat(80);
export const T3 = '0123456789abcdef'.repeat(4);

/** Chwila testów: 2026-11-02T10:00:00Z (ta sama co w `shared/fixtures/relay/manifest.json`). */
export const NOW_MS = Date.parse('2026-11-02T10:00:00.000Z');
export const DAY_S = 24 * 60 * 60;

/** Klucze HMAC przepustek: base64 tekstu, który sam mówi, że to wartość testowa. */
export const TEST_PASS_KEYS = JSON.stringify({
  k1: btoa('TEST-ONLY relay fixture key k1, not a secret'),
  k0: btoa('TEST-ONLY relay fixture key k0, rotated out!'),
});
/** Klucze „innego przekaźnika” (inne `PASS_KEYS`, np. przyszły osobny staging). */
export const OTHER_PASS_KEYS = JSON.stringify({ k1: btoa('TEST-ONLY other relay key k1, not a secret!!') });

export interface TestKey {
  readonly pem: string;
  readonly publicKey: CryptoKey;
}

export async function generateApnsKey(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('oczekiwano pary kluczy');
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return {
    pem: ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n'),
    publicKey: pair.publicKey,
  };
}

let sharedKey: Promise<TestKey> | undefined;
/** Jeden klucz na plik testów (generowanie kosztuje). */
export const testKey = (): Promise<TestKey> => (sharedKey ??= generateApnsKey());

export function baseEnv(pem: string, overrides: Partial<Record<keyof RelayEnv, string | undefined>> = {}): RelayEnv {
  return {
    APNS_TEAM_ID: 'TEAMID0001',
    APNS_KEY_ID: 'KEYID00001',
    APNS_KEY: pem,
    APNS_ENVIRONMENTS: 'development,production',
    ALERT_POLICY: 'v2',
    PASS_KEYS: TEST_PASS_KEYS,
    PASS_KID: 'k1',
    DEPLOY_SHA: 'test',
    ...overrides,
  };
}

/** Jedno wywołanie Apple widziane przez atrapę `fetch`. */
export interface ApnsCallRecord {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Odpowiedź atrapy Apple: status z ciałem, błąd sieci albo brak odpowiedzi (czeka na `abort`). */
export type ApnsReply = { readonly status: number; readonly body?: string } | 'network' | 'timeout';

/** Werdykt licznika: stały, wyjątek bindingu albo funkcja klucza (np. okno liczone w teście). */
export type LimitVerdict = boolean | 'throw' | ((key: string) => boolean);

export interface LimitScript {
  readonly pass?: LimitVerdict;
  readonly push?: LimitVerdict;
  readonly pushAddr?: LimitVerdict;
}

export interface Harness {
  readonly relay: Relay;
  readonly calls: ApnsCallRecord[];
  readonly lines: string[];
  readonly limitKeys: { pass: string[]; push: string[]; pushAddr: string[] };
  readonly clock: { ms: number };
  context(clientAddress?: string | null): RequestContext;
}

export interface HarnessOptions {
  readonly env: RelayEnv;
  /** Kolejne odpowiedzi Apple; ostatnia powtarza się. Brak = Apple nie powinien być wołany (rzuca). */
  readonly apns?: readonly ApnsReply[];
  readonly limits?: LimitScript;
  readonly nowMs?: number;
  readonly timeoutMs?: number;
}

/** Komunikat błędu sieci z „tajemnicą” — dowód, że rdzeń nie przepisuje komunikatów do logu. */
export const LEAKY_ERROR = 'connect failed: authorization bearer LEAK-SENTINEL';

export function harness(options: HarnessOptions): Harness {
  const calls: ApnsCallRecord[] = [];
  const lines: string[] = [];
  const limitKeys = { pass: [] as string[], push: [] as string[], pushAddr: [] as string[] };
  const clock = { ms: options.nowMs ?? NOW_MS };
  const replies = options.apns ?? [];

  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) }, body: String(init.body) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply === undefined) throw new Error('Apple nie miał być wołany');
    if (reply === 'network') throw new TypeError(LEAKY_ERROR);
    if (reply === 'timeout') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => { reject(new Error(LEAKY_ERROR)); });
      });
    }
    return new Response(reply.body ?? '', { status: reply.status });
  };

  const relay = createRelay(options.env, {
    fetch: fetchFn,
    now: () => clock.ms,
    log: (line) => { lines.push(line); },
    apnsTimeoutMs: options.timeoutMs ?? 50,
  });

  const limit = (kind: 'pass' | 'push' | 'pushAddr') => async (key: string): Promise<boolean> => {
    limitKeys[kind].push(key);
    const verdict = options.limits?.[kind] ?? true;
    if (verdict === 'throw') throw new Error(`limit ${kind}: ${key}`);
    return typeof verdict === 'function' ? verdict(key) : verdict;
  };

  return {
    relay, calls, lines, limitKeys, clock,
    context: (clientAddress = '203.0.113.7') => ({
      clientAddress, limits: { pass: limit('pass'), push: limit('push'), pushAddr: limit('pushAddr') },
    }),
  };
}

/** Nagłówki, których przekaźnik wymaga na trasach POST — te same, które wysyła serwer (`relay-sender.ts`). */
export const POST_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  'x-rarog-relay-client': 'rarog-server/0.1.0',
};

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://relay.test${path}`, {
    method: 'POST',
    headers: { ...POST_HEADERS, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export const get = (path: string): Request => new Request(`https://relay.test${path}`);

export async function call(h: Harness, request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await h.relay.handle(request, h.context());
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** `/v1/pass` typu `alert` z 200 Apple → przepustka (pomocnik do testów `/v1/push`). */
export async function issueDevicePass(
  env: RelayEnv, token = T1, environment: 'development' | 'production' = 'development', nowMs = NOW_MS,
): Promise<string> {
  const h = harness({ env, apns: [{ status: 200 }], nowMs });
  const { status, body } = await call(h, post('/v1/pass', { v: 1, token, environment, type: 'alert', topic: 'ai.rarog.app' }));
  if (status !== 200 || typeof body['pass'] !== 'string') throw new Error(`przepustka: ${String(status)}`);
  return body['pass'];
}
