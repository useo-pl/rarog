/**
 * Skrypt dymny (`scripts/smoke.mjs`) na atrapie przekaźnika: kroki (1)–(4), wybór wpisu po etykiecie i temacie,
 * wypisuje statusy i kody — nigdy tokenów ani przepustek. Prawdziwy przebieg idzie po wdrożeniu przekaźnika.
 * Atrapa przepuszcza każde `/v1/push` przez prawdziwą politykę (`src/policy.ts`), jak `core.ts`.
 */
import { describe, expect, it } from 'vitest';
import goldenTest from '../../shared/fixtures/apns-v3/alert.test.v3.json';
import { CLIENT_HEADER, DEFAULT_LABEL, UNKNOWN_KID, USAGE, parseArgs, pickDevice, runSmoke } from '../scripts/smoke.mjs';
import { ALERT_PLACEHOLDER_KEYS } from '../src/alert-policy.ts';
import { base64Decode } from '../src/bytes.ts';
import type { PushType } from '../src/identity.ts';
import { checkHeaders, checkPayload } from '../src/policy.ts';
import { T1, T2, T3 } from './helpers.ts';

const IPAD_TOKEN = 'b4'.repeat(32);
/** Etykieta, pod którą jest tylko wpis legacy bez tematu (rejestracja sprzed `topic`). */
const LEGACY_ONLY_LABEL = 'iPhone·stary';
/** Urządzenie z buildem TestFlight: token `production`. */
const TF_LABEL = 'iPhone·TestFlight';
const TF_TOKEN = 'd6'.repeat(32);
const devices = {
  devices: [
    { token: T3, environment: 'development', label: DEFAULT_LABEL, topic: 'ai.rarog.app', updatedAt: '2026-10-20T10:00:00.000Z' },
    { token: T1, environment: 'development', label: DEFAULT_LABEL, topic: 'ai.rarog.app', updatedAt: '2026-10-23T10:00:00.000Z' },
    { token: 'c5'.repeat(32), environment: 'development', label: LEGACY_ONLY_LABEL, updatedAt: '2026-10-23T11:00:00.000Z' },
    { token: TF_TOKEN, environment: 'production', label: TF_LABEL, topic: 'ai.rarog.app', updatedAt: '2026-10-24T10:00:00.000Z' },
    {
      token: IPAD_TOKEN, environment: 'development', label: 'iPad·Rarog', topic: 'ai.rarog.app', updatedAt: '2026-10-23T09:00:00.000Z',
      liveActivity: { activityId: 'A1', updateToken: T2, startedAt: '2026-10-23T08:00:00.000Z' },
    },
  ],
};

const PASS = (n: number): string => `v1.k1.development.alert.${'0'.repeat(16)}.1800000000.${String(n).repeat(43)}`;

interface Seen { readonly path: string; readonly body: Record<string, unknown>; readonly headers: Headers }

/** Atrapa przekaźnika: odpowiada według trasy, typu i środowiska; `/v1/push` sprawdza prawdziwa polityka. */
function relay(script: { production?: { status: number; body: Record<string, unknown> }; laPush?: Record<string, unknown> } = {}) {
  const seen: Seen[] = [];
  let issued = 0;
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ path, body, headers: new Headers(init.headers) });
    const json = (status: number, payload: Record<string, unknown>) => new Response(JSON.stringify({ v: 1, ...payload }), { status });
    if (path === '/v1/pass') {
      if (body['environment'] === 'production') {
        const reply = script.production ?? { status: 422, body: { error: 'token-rejected', apnsStatus: 400, reason: 'BadDeviceToken' } };
        return json(reply.status, reply.body);
      }
      issued += 1;
      return json(200, { pass: PASS(issued), expiresAt: '2027-01-31T10:00:00.000Z' });
    }
    const headers = body['headers'] as Record<string, string>;
    const type = headers['apns-push-type'] as PushType;
    const rule = checkHeaders(headers, type) ?? checkPayload(String(body['payload']), type);
    if (rule !== null) return json(400, { error: 'payload-rejected', rule });
    if (headers['apns-push-type'] === 'liveactivity') return json(200, script.laPush ?? { apnsStatus: 200 });
    return json(200, { apnsStatus: 200 });
  };
  return { seen, fetchFn };
}

async function run(options: Partial<Parameters<typeof runSmoke>[0]> = {}, script = {}) {
  const lines: string[] = [];
  const fake = relay(script);
  const ok = await runSmoke({
    relayUrl: 'https://push.rarog.ai', devices, label: DEFAULT_LABEL, activityLabel: 'iPad·Rarog',
    steps: [1, 2, 3], fetch: fake.fetchFn, print: (line: string) => { lines.push(line); },
    nowMs: Date.parse('2026-11-02T10:00:00.000Z'), ...options,
  });
  return { ok, lines, seen: fake.seen };
}

describe('smoke.mjs', () => {
  it('kroki 1–3: kolejność tras, najnowszy wpis Raroga, ładunki zgodne z polityką', async () => {
    const { ok, lines, seen } = await run();
    expect(ok).toBe(true);
    const kind = (s: Seen): string => String(s.body['type'] ?? (s.body['headers'] as Record<string, string>)['apns-push-type']);
    expect(seen.map((s) => `${s.path} ${kind(s)} ${String(s.body['environment'])}`))
      .toEqual([
        '/v1/pass alert development', '/v1/push alert development', '/v1/pass alert production',
        '/v1/pass alert development', '/v1/pass liveactivity development', '/v1/push liveactivity development',
      ]);
    expect(seen[0]?.body['token']).toBe(T1);
    // Nagłówki, których przekaźnik wymaga na trasach POST: bez nich skrypt dostałby 400 na każdym kroku.
    expect(CLIENT_HEADER).toBe('x-rarog-relay-client');
    for (const s of seen) {
      expect(s.headers.get('content-type')).toBe('application/json');
      expect(s.headers.get(CLIENT_HEADER)).toBe('rarog-smoke/0.1.0');
      expect([...s.headers.keys()].sort()).toEqual(['content-type', CLIENT_HEADER].sort());
    }
    expect(seen[3]?.body['token']).toBe(IPAD_TOKEN);
    expect(seen[4]).toMatchObject({ body: { token: T2, devicePass: PASS(2) } });
    const aps = { alert: { title: 'Rarog', body: 'Nowe powiadomienie' }, 'mutable-content': 1, sound: 'default' };
    expect(JSON.parse(String(seen[1]?.body['payload']))).toEqual({ aps, rarog: { v: 1, kind: 'test' } });
    expect(lines).toEqual([
      '(1) /v1/pass development: 200',
      '(1) /v1/push alert: 200 apnsStatus=200 — check the banner „Rarog / Nowe powiadomienie” on iPhone·Rarog',
      '(2) /v1/pass production: 422 error=token-rejected apnsStatus=400 reason=BadDeviceToken'
        + ' — as expected: the key is accepted in production',
      '(3) /v1/pass development (device): 200',
      '(3) /v1/pass liveactivity: 200',
      '(3) /v1/push liveactivity: 200 apnsStatus=200 — the key covers the Live Activity topic',
    ]);
  });

  it('wyniki „źle”: 502 apns-error w produkcji (bez pól Apple), TopicDisallowed kafla', async () => {
    const { lines } = await run({}, {
      production: { status: 502, body: { error: 'apns-error' } },
      laPush: { apnsStatus: 400, reason: 'TopicDisallowed' },
    });
    // Przekaźnik nie mówi anonimowemu wołającemu, co Apple odpowiedział: status i powód są w `wrangler tail`.
    expect(lines).toContain('(2) /v1/pass production: 502 error=apns-error'
      + ' — Apple refused: check apns_status and reason in wrangler tail (403 = the key does NOT work in production)');
    expect(lines).toContain('(3) /v1/push liveactivity: 200 apnsStatus=400 reason=TopicDisallowed — the key does NOT cover the Live Activity topic');
  });

  it('nigdy nie wypisuje tokenów ani przepustek', async () => {
    const { lines } = await run({ steps: [1, 2, 3, 4] });
    const text = lines.join('\n');
    for (const secret of [T1, T2, T3, IPAD_TOKEN, PASS(1), PASS(2), PASS(3), '0'.repeat(16)]) {
      expect(text.includes(secret)).toBe(false);
    }
  });

  it('brak wpisu o etykiecie (albo tylko wpis legacy bez tematu) → komunikat i false', async () => {
    const { ok, lines, seen } = await run({ label: LEGACY_ONLY_LABEL });
    expect(ok).toBe(false);
    expect(lines).toEqual([`no Rarog entry labelled „${LEGACY_ONLY_LABEL}” (topic ai.rarog.app) in apns-devices.json`]);
    expect(seen).toEqual([]);
  });

  it('pickDevice: etykieta + temat Raroga, najnowszy updatedAt; śmieci → undefined', () => {
    expect(pickDevice(devices, DEFAULT_LABEL)?.token).toBe(T1);
    expect(pickDevice({}, DEFAULT_LABEL)).toBeUndefined();
    expect(pickDevice(null, DEFAULT_LABEL)).toBeUndefined();
  });

  // Koperta v3 poprawna dla odbiorcy (NSE dochodzi do szukania klucza), ale z `kid`, którego urządzenie nie
  // zna — NSE zostawia alert z kluczy `push.placeholder.*` (`keyMissing`), a nie odrzuca koperty
  // (`envelopeInvalid`). Kształt porównujemy ze złotym plikiem serwera, nie z kopią w teście.
  it('krok 4: alert z kluczy przechodzi politykę, koperta v3 jak złoty plik, zmieniony tylko kid', async () => {
    const { ok, lines, seen } = await run({ steps: [4] });
    expect(ok).toBe(true);
    expect(seen.map((s) => `${s.path} ${String(s.body['environment'])}`))
      .toEqual(['/v1/pass development', '/v1/push development']);
    expect(seen[0]?.body).toMatchObject({ token: T1, type: 'alert', topic: 'ai.rarog.app' });
    const push = seen[1];
    expect(push?.body).toMatchObject({ pass: PASS(1), token: T1 });
    const headers = push?.body['headers'] as Record<string, string>;
    const payloadText = String(push?.body['payload']);
    expect(checkHeaders(headers, 'alert')).toBeNull();
    expect(checkPayload(payloadText, 'alert')).toBeNull();
    expect(headers['apns-push-type']).toBe(goldenTest.headers['apns-push-type']);
    expect(headers['apns-topic']).toBe(goldenTest.headers['apns-topic']);
    expect(headers['apns-priority']).toBe(goldenTest.headers['apns-priority']);

    const payload = JSON.parse(payloadText) as { aps: Record<string, unknown>; rarog: Record<string, unknown> };
    expect(payload.aps['alert']).toEqual(ALERT_PLACEHOLDER_KEYS);
    expect(payload.aps['mutable-content']).toBe(1);
    expect(Object.keys(payload).sort()).toEqual(Object.keys(goldenTest.payload).sort());

    const golden = goldenTest.payload.rarog;
    const rarog = payload.rarog;
    expect(Object.keys(rarog).sort()).toEqual(Object.keys(golden).sort());
    expect(rarog['v']).toBe(golden.v);
    // `kid`: format odbiorcy (`PushWire.isKid`: 8 znaków hex), ale inny niż `kid` złotego pliku.
    expect(rarog['kid']).toBe(UNKNOWN_KID);
    expect(rarog['kid']).toMatch(/^[0-9a-f]{8}$/);
    expect(rarog['kid']).not.toBe(golden.kid);
    // `n` i `c`: base64url bez dopełnienia, te same długości co w złotym pliku (12 B nonce, kubełek 256 B + tag).
    for (const key of ['n', 'c'] as const) {
      const value = String(rarog[key]);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(value.length).toBe(golden[key].length);
      expect(base64Decode(value)?.length).toBe(base64Decode(golden[key])?.length);
    }
    expect(lines).toEqual([
      '(4) /v1/pass development: 200',
      '(4) /v1/push alert (unknown kid): 200 apnsStatus=200 — check on iPhone·Rarog the fallback banner in the device'
        + ' language: „Rarog / Nowe powiadomienie” in Polish, „Rarog / New notification” in English',
    ]);
  });

  it('krok 4: środowisko z wpisu urządzenia (build TestFlight = production), każda wysyłka z nowym n i c', async () => {
    const production = { status: 200, body: { pass: PASS(7), expiresAt: '2027-01-31T10:00:00.000Z' } };
    const first = await run({ steps: [4], label: TF_LABEL }, { production });
    expect(first.seen.map((s) => `${s.path} ${String(s.body['environment'])}`))
      .toEqual(['/v1/pass production', '/v1/push production']);
    expect(first.seen[1]?.body['token']).toBe(TF_TOKEN);
    const second = await run({ steps: [4], label: TF_LABEL }, { production });
    const block = (r: typeof first) => (JSON.parse(String(r.seen[1]?.body['payload'])) as { rarog: Record<string, string> }).rarog;
    expect(block(second)['kid']).toBe(block(first)['kid']);
    expect(block(second)['n']).not.toBe(block(first)['n']);
    expect(block(second)['c']).not.toBe(block(first)['c']);
  });

  it('krok 4 bez wpisu o etykiecie → komunikat i false, nic nie wysyła', async () => {
    const { ok, seen } = await run({ steps: [4], label: LEGACY_ONLY_LABEL });
    expect(ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it('parseArgs: adres https, ścieżka domyślna z RAROG_DATA_DIR albo z reguły katalogu danych, opcje', () => {
    // Pusty (tu: nieistniejący) katalog domowy = nowa instalacja: reguła `shared/src/data-dir.mjs` daje `rarog`.
    // Pozostałe stany `rarog` i konflikty sprawdza macierz w `server/test/data-dir.test.ts`.
    expect(parseArgs(['https://push.rarog.ai/'], {}, '/home/u')).toEqual({
      relayUrl: 'https://push.rarog.ai', devicesPath: '/home/u/.local/share/rarog/apns-devices.json',
      label: 'iPhone·Rarog', activityLabel: 'iPad·Rarog', steps: [1, 2, 3],
    });
    expect(parseArgs(['https://r.example'], { XDG_DATA_HOME: '/x' }, '/h').devicesPath).toBe('/x/rarog/apns-devices.json');
    expect(parseArgs(['https://r.example', 'x.json', '--steps', '2', '--label', 'iPad·Rarog'], { RAROG_DATA_DIR: '/d' }, '/h'))
      .toMatchObject({ devicesPath: 'x.json', label: 'iPad·Rarog', steps: [2] });
    // Krok 4 tylko na żądanie: domyślne kroki go nie wysyłają.
    expect(parseArgs(['https://r.example', '--steps', '4'], {}, '/h').steps).toEqual([4]);
    expect(parseArgs(['https://r.example'], { RAROG_DATA_DIR: '/d' }, '/h').devicesPath).toBe('/d/apns-devices.json');
    expect(() => parseArgs(['http://push.rarog.ai'], {}, '/h')).toThrow(/https/);
    expect(() => parseArgs(['https://r.example', '--nope'], {}, '/h')).toThrow(/unknown option/);
  });

  // Adres bez wartości domyślnej: skrypt nie zgaduje, który przekaźnik sprawdzić, i nie podsuwa żadnej domeny.
  it('bez adresu: odmowa z instrukcją użycia, bez domeny w komunikacie', () => {
    let message = '';
    try {
      parseArgs(['--steps', '1'], {}, '/h');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('missing relay address');
    expect(message).toContain('`routes` in relay/wrangler.toml');
    expect(message).toContain(USAGE);
    expect(message).not.toMatch(/https?:\/\/[a-z]/i);
  });
});
