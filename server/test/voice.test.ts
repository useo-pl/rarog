/**
 * Dyktowanie, warstwa serwera: mint klucza tymczasowego Soniox + endpoint `POST /api/voice/token`.
 *
 * Testy routera NIE otwierają gniazda (`listen` dostaje w tym środowisku EPERM) — handler
 * jest zwykłą funkcją `(req, res)`, więc wołamy go z atrapami `IncomingMessage`
 * i `ServerResponse`. Dzięki temu ten plik jest zielony wszędzie, a nie „u kogoś".
 */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { voiceTokenSchema } from '@rarog/shared';
import { REDACTED, SENSITIVE_KEY_PARTS, redact } from '../src/auth/index.ts';
import {
  VOICE_TOKEN_HOURLY_CAP, VOICE_TOKEN_MIN_INTERVAL_MS, loadConfig, parseVoiceEnabled,
} from '../src/config.ts';
import type { RarogConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import {
  SONIOX_API_ORIGIN, SONIOX_RT_MODEL, SONIOX_TEMP_KEY_PATH, SONIOX_WEBSOCKET_URI,
  VOICE_AUDIO_FORMAT, VOICE_MAX_SESSION_SECONDS, VOICE_SAMPLE_RATE, VOICE_TOKEN_EXPIRES_IN_SECONDS,
  type FetchLike, createVoiceMinter, isEuHost, sonioxHostname,
} from '../src/voice/soniox.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const ORIGIN = 'http://localhost:8930';
const STALY_KLUCZ = 'sk-staly-klucz-z-macbooka-XYZ';
const TYMCZASOWY = 'temp:WYJ67RBEFUWQXXPKYPD2UGXKWB';
const EXPIRES_AT = '2026-08-23T20:15:00.000Z';

const silentLogger: Logger = { info: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Atrapy: fetch do Soniox
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(
  replies: readonly ({ status: number; payload?: unknown } | 'throw')[],
): { impl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  const impl: FetchLike = (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined || reply === 'throw') {
      return Promise.reject(new Error(`fetch failed for ${STALY_KLUCZ}`));
    }
    return Promise.resolve({
      status: reply.status,
      json: () => Promise.resolve(reply.payload ?? {}),
    });
  };
  return { impl, calls };
}

const OK_REPLY = { status: 201, payload: { api_key: TYMCZASOWY, expires_at: EXPIRES_AT } };

interface MinterOverrides {
  apiKey?: string | undefined;
  apiHost?: string | undefined;
  enabled?: boolean;
  now?: () => number;
  randomId?: () => string;
  log?: (message: string) => void;
}

function minterFor(
  replies: readonly ({ status: number; payload?: unknown } | 'throw')[],
  over: MinterOverrides = {},
) {
  const { impl, calls } = fakeFetch(replies);
  const minter = createVoiceMinter({
    apiKey: 'apiKey' in over ? over.apiKey : STALY_KLUCZ,
    apiHost: over.apiHost,
    enabled: over.enabled ?? true,
    fetchImpl: impl,
    minIntervalMs: VOICE_TOKEN_MIN_INTERVAL_MS,
    hourlyCap: VOICE_TOKEN_HOURLY_CAP,
    ...(over.now !== undefined ? { now: over.now } : {}),
    ...(over.randomId !== undefined ? { randomId: over.randomId } : {}),
    ...(over.log !== undefined ? { log: over.log } : {}),
  });
  return { minter, calls };
}

// ---------------------------------------------------------------------------
// Atrapy: HTTP bez gniazda
// ---------------------------------------------------------------------------

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
}

function fakeRes(): { res: ServerResponse; done: Promise<Captured> } {
  let settle: (value: Captured) => void;
  const done = new Promise<Captured>((resolve) => { settle = resolve; });
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    writeHead(status: number, extra?: Record<string, string>) {
      for (const [name, value] of Object.entries(extra ?? {})) {
        headers[name.toLowerCase()] = value;
      }
      (this as { status?: number }).status = status;
      return this;
    },
    end(payload?: string) {
      const raw = payload ?? '';
      let body: unknown = null;
      try { body = JSON.parse(raw) as unknown; } catch { body = raw; }
      settle({ status: (this as { status?: number }).status ?? 0, headers, body, raw });
    },
  };
  return { res: res as unknown as ServerResponse, done };
}

function fakeReq(opts: {
  method?: string; url?: string; body?: string; authorization?: string; origin?: string | null;
}): IncomingMessage {
  const stream = Readable.from(
    [Buffer.from(opts.body ?? '', 'utf8')],
  ) as unknown as IncomingMessage;
  stream.method = opts.method ?? 'POST';
  stream.url = opts.url ?? '/api/voice/token';
  stream.headers = {
    ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }),
    ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {}),
  };
  return stream;
}

interface RouterHarness {
  call(opts: Parameters<typeof fakeReq>[0]): Promise<Captured>;
  config: RarogConfig;
}

function routerFor(env: NodeJS.ProcessEnv, logger: Logger = silentLogger): RouterHarness {
  const config = loadConfig({ RAROG_DEMO: '1', ...env });
  const device = createTestDevice(config.dataDir, { epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({
    manager, serverStartId: 'start-1', protocolVersion: 1, heartbeatMs: 0,
  });
  const handler = createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger, devices: device.identity,
  });
  return {
    config,
    call: async (opts) => {
      const { res, done } = fakeRes();
      handler(fakeReq({ authorization: device.authorization, ...opts }), res);
      return done;
    },
  };
}

// ---------------------------------------------------------------------------
// Minter
// ---------------------------------------------------------------------------

describe('createVoiceMinter — udany mint', () => {
  it('woła pinowany endpoint UE z kluczem stałym w nagłówku i zwraca VoiceToken', async () => {
    const { minter, calls } = minterFor([OK_REPLY]);
    const result = await minter.mint();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SONIOX_API_ORIGIN}${SONIOX_TEMP_KEY_PATH}`);
    expect(calls[0]?.headers['Authorization']).toBe(`Bearer ${STALY_KLUCZ}`);
    expect(calls[0]?.body).toMatchObject({
      usage_type: 'transcribe_websocket',
      expires_in_seconds: VOICE_TOKEN_EXPIRES_IN_SECONDS,
      single_use: true,
      max_session_duration_seconds: VOICE_MAX_SESSION_SECONDS,
    });
    expect(result.token).toEqual({
      apiKey: TYMCZASOWY,
      expiresAt: EXPIRES_AT,
      webSocketUri: SONIOX_WEBSOCKET_URI,
      model: SONIOX_RT_MODEL,
      maxSessionSeconds: VOICE_MAX_SESSION_SECONDS,
      config: {
        languageHints: ['pl', 'en'],
        audioFormat: VOICE_AUDIO_FORMAT,
        sampleRate: VOICE_SAMPLE_RATE,
        numChannels: 1,
      },
    });
    expect(voiceTokenSchema.safeParse(result.token).success).toBe(true);
  });

  it('adres strumienia i format są PINOWANE, a nie brane z odpowiedzi Soniox', async () => {
    const { minter } = minterFor([{
      status: 201,
      payload: {
        api_key: TYMCZASOWY,
        expires_at: EXPIRES_AT,
        // Gdyby upstream kiedyś zaczął podpowiadać host US, klient nie ma prawa go zobaczyć.
        websocket_url: 'wss://stt-rt.soniox.com/transcribe-websocket',
        audio_format: 'mp4',
      },
    }]);
    const result = await minter.mint();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.webSocketUri).toBe(SONIOX_WEBSOCKET_URI);
    expect(result.token.config.audioFormat).toBe('pcm_s16le');
  });

  it('client_reference_id jest LOSOWY na każdy mint (nigdy identyfikator sesji)', async () => {
    let clock = 0;
    const { minter, calls } = minterFor([OK_REPLY], { now: () => clock });
    await minter.mint();
    clock += 10_000;
    await minter.mint();

    const first = calls[0]?.body['client_reference_id'];
    const second = calls[1]?.body['client_reference_id'];
    expect(typeof first).toBe('string');
    expect(first).not.toBe(second);
    // Kształt „rarog-<uuid>" jest wprost zakazany — identyfikator sesji jest stabilny
    // między restartami, więc byłby trwałym śladem u strony trzeciej.
    expect(String(first)).not.toContain('rarog');
  });
});

describe('createVoiceMinter — brak konfiguracji', () => {
  it('brak klucza → 503 voice_unconfigured i ZERO wyjść na sieć', async () => {
    const { minter, calls } = minterFor([OK_REPLY], { apiKey: undefined });
    const result = await minter.mint();
    expect(result).toMatchObject({ ok: false, status: 503, error: 'voice_unconfigured' });
    if (!result.ok) expect(result.sentence.ref.code).toMatch(/^rest\.voice-disabled\.(mac|vps)$/);
    expect(calls).toHaveLength(0);
    expect(minter.available).toBe(false);
  });

  it('RAROG_VOICE=0 wyłącza mint mimo obecnego klucza', async () => {
    const { minter, calls } = minterFor([OK_REPLY], { enabled: false });
    const result = await minter.mint();
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(calls).toHaveLength(0);
  });

  it('host spoza UE → 503 z komunikatem o regionie, bez wyjścia na sieć', async () => {
    const { minter, calls } = minterFor([OK_REPLY], { apiHost: 'https://api.soniox.com' });
    const result = await minter.mint();
    expect(result).toMatchObject({ ok: false, status: 503, error: 'voice_unconfigured' });
    if (!result.ok) expect(result.sentence.ref.code).toMatch(/^rest\.voice-foreign-region\.(mac|vps)$/);
    expect(calls).toHaveLength(0);
  });

  it('SONIOX_API_HOST w obu zapisach (z i bez schematu) przechodzi jako UE', () => {
    expect(isEuHost('api.eu.soniox.com')).toBe(true);
    expect(isEuHost('https://api.eu.soniox.com/')).toBe(true);
    expect(isEuHost(undefined)).toBe(true);
    expect(isEuHost('')).toBe(true);
    expect(isEuHost('https://api.soniox.com')).toBe(false);
    expect(sonioxHostname('HTTPS://API.EU.SONIOX.COM')).toBe('api.eu.soniox.com');
  });
});

describe('createVoiceMinter — błędy upstreamu', () => {
  it('429 z Soniox → 502 voice_upstream (nie przepuszczamy statusu upstreamu)', async () => {
    const { minter } = minterFor([{ status: 429 }]);
    expect(await minter.mint()).toMatchObject({ ok: false, status: 502, error: 'voice_upstream' });
  });

  it('500 z Soniox → 502 voice_upstream', async () => {
    const { minter } = minterFor([{ status: 500 }]);
    expect(await minter.mint()).toMatchObject({ ok: false, status: 502, error: 'voice_upstream' });
  });

  it('401 (klucz odrzucony) → 503 z instrukcją, co poprawić — nie 502 „spróbuj później"', async () => {
    const { minter } = minterFor([{ status: 401 }]);
    const result = await minter.mint();
    expect(result).toMatchObject({ ok: false, status: 503, error: 'voice_unconfigured' });
    if (!result.ok) expect(result.sentence.text).toContain('SONIOX_API_KEY');
  });

  it('odpowiedź bez api_key → 502, nigdy 200 z pustym kluczem', async () => {
    const { minter } = minterFor([{ status: 201, payload: { expires_at: EXPIRES_AT } }]);
    expect(await minter.mint()).toMatchObject({ ok: false, status: 502 });
  });

  it('wyjątek sieciowy → 502, a treść wyjątku (z kluczem!) nie wychodzi do klienta', async () => {
    const { minter } = minterFor(['throw']);
    const result = await minter.mint();
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(result)).not.toContain(STALY_KLUCZ);
  });

  it('zero retry — jeden mint to dokładnie jedno wyjście na sieć', async () => {
    const { minter, calls } = minterFor([{ status: 500 }, OK_REPLY]);
    await minter.mint();
    expect(calls).toHaveLength(1);
  });
});

describe('createVoiceMinter — throttle', () => {
  it('trzy minty w tej samej sekundzie: drugi i trzeci dostają 429', async () => {
    let clock = 1_000;
    const { minter, calls } = minterFor([OK_REPLY], { now: () => clock });

    expect((await minter.mint()).ok).toBe(true);
    clock += 300;
    expect(await minter.mint()).toMatchObject({ ok: false, status: 429, error: 'voice_throttled' });
    clock += 300;
    expect(await minter.mint()).toMatchObject({ ok: false, status: 429 });
    // Odrzucone próby nie wychodzą na sieć — o to w throttle'u chodzi.
    expect(calls).toHaveLength(1);

    clock += VOICE_TOKEN_MIN_INTERVAL_MS;
    expect((await minter.mint()).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('sufit godzinny: 61. mint w oknie godziny dostaje 429', async () => {
    let clock = 0;
    const { minter, calls } = minterFor([OK_REPLY], { now: () => clock });
    for (let i = 0; i < VOICE_TOKEN_HOURLY_CAP; i += 1) {
      clock += VOICE_TOKEN_MIN_INTERVAL_MS;
      expect((await minter.mint()).ok).toBe(true);
    }
    clock += VOICE_TOKEN_MIN_INTERVAL_MS;
    expect(await minter.mint()).toMatchObject({ ok: false, status: 429 });
    expect(calls).toHaveLength(VOICE_TOKEN_HOURLY_CAP);

    // Po wyjściu okna godzinnego licznik zwalnia miejsca.
    clock += 3_600_001;
    expect((await minter.mint()).ok).toBe(true);
  });

  it('slot zabiera także NIEUDANA próba — inaczej pętla błędów obchodzi throttle', async () => {
    let clock = 0;
    const { minter, calls } = minterFor([{ status: 500 }], { now: () => clock });
    await minter.mint();
    clock += 100;
    expect(await minter.mint()).toMatchObject({ ok: false, status: 429 });
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sekrety w logu
// ---------------------------------------------------------------------------

describe('klucze a logi', () => {
  it('log mintu niesie tylko expiresAt — nigdy klucza ani ciała odpowiedzi', async () => {
    const lines: string[] = [];
    const { minter } = minterFor([OK_REPLY], { log: (m) => lines.push(m) });
    await minter.mint();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(EXPIRES_AT);
    expect(lines.join('\n')).not.toContain(TYMCZASOWY);
    expect(lines.join('\n')).not.toContain(STALY_KLUCZ);
  });

  it('log błędu niesie tylko status — bez treści odpowiedzi Soniox', async () => {
    const lines: string[] = [];
    const { minter } = minterFor([
      { status: 500, payload: { detail: `klucz ${STALY_KLUCZ} odrzucony` } },
    ], { log: (m) => lines.push(m) });
    await minter.mint();

    expect(lines.join('\n')).toContain('500');
    expect(lines.join('\n')).not.toContain(STALY_KLUCZ);
  });

  it('redact() ukrywa pole api_key z odpowiedzi Soniox (regresja na SENSITIVE_KEY_PARTS)', () => {
    // `apikey` po lowercase łapie `apiKey`, ale NIE łapie `api_key` — dlatego lista ma
    // obie pozycje. Ten test jest jedynym strażnikiem tej różnicy.
    expect(SENSITIVE_KEY_PARTS).toContain('apikey');
    expect(SENSITIVE_KEY_PARTS).toContain('api_key');

    const dumped = redact({
      apiKey: TYMCZASOWY,
      api_key: TYMCZASOWY,
      SONIOX_API_KEY: STALY_KLUCZ,
      config: { audioFormat: 'pcm_s16le' },
    });
    expect(dumped).not.toContain(TYMCZASOWY);
    expect(dumped).not.toContain(STALY_KLUCZ);
    expect(dumped).toContain(REDACTED);
    // Reszta obiektu ma przeżyć — redakcja nie może zjeść diagnostyki.
    expect(dumped).toContain('pcm_s16le');
  });

  it('redact() wymazuje stały klucz także z gołego tekstu wyjątku', () => {
    const message = `fetch failed: Bearer ${STALY_KLUCZ}`;
    expect(redact(message, [STALY_KLUCZ])).not.toContain(STALY_KLUCZ);
  });
});

// ---------------------------------------------------------------------------
// Konfiguracja
// ---------------------------------------------------------------------------

describe('config — RAROG_VOICE i SONIOX_API_KEY', () => {
  it('parseVoiceEnabled: domyślnie włączone, 0/false wyłącza', () => {
    expect(parseVoiceEnabled(undefined)).toBe(true);
    expect(parseVoiceEnabled('')).toBe(true);
    expect(parseVoiceEnabled('1')).toBe(true);
    expect(parseVoiceEnabled('0')).toBe(false);
    expect(parseVoiceEnabled('false')).toBe(false);
  });

  it('brak klucza → voiceEnabled=false, ale serwer WSTAJE (nigdy ConfigError)', () => {
    const config = loadConfig({ RAROG_DEMO: '1' });
    expect(config.voiceEnabled).toBe(false);
    expect(config.sonioxApiKey).toBeUndefined();
  });

  it('klucz w env → voiceEnabled=true; RAROG_VOICE=0 gasi mimo klucza', () => {
    const on = loadConfig({
      RAROG_DEMO: '1', SONIOX_API_KEY: STALY_KLUCZ,
      SONIOX_API_HOST: 'https://api.eu.soniox.com',
    });
    expect(on.voiceEnabled).toBe(true);
    expect(on.sonioxApiHost).toBe('https://api.eu.soniox.com');

    const off = loadConfig({
      RAROG_DEMO: '1', SONIOX_API_KEY: STALY_KLUCZ, RAROG_VOICE: '0',
    });
    expect(off.voiceEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

describe('POST /api/voice/token', () => {
  const withKey = { SONIOX_API_KEY: STALY_KLUCZ, SONIOX_API_HOST: 'api.eu.soniox.com' };

  it('bez klucza w env → 503 voice_unconfigured z czytelnym komunikatem', async () => {
    const captured = await routerFor({}).call({ body: '{}' });
    expect(captured.status).toBe(503);
    expect(captured.body).toMatchObject({ error: 'voice_unconfigured' });
    expect((captured.body as { messageRef: { code: string } }).messageRef.code).toMatch(/^rest\.voice-disabled\.(mac|vps)$/);
  });

  it('bez klucza urządzenia → 401, zanim ktokolwiek pomyśli o mintowaniu', async () => {
    const { res, done } = fakeRes();
    const config = loadConfig({ RAROG_DEMO: '1', ...withKey });
    createRouter({
      config,
      manager: new FakeManager([makeSummary({ id: 's1' })]),
      hub: new SseHub({
        manager: new FakeManager([]), serverStartId: 's', protocolVersion: 1, heartbeatMs: 0,
      }),
      serverStartId: 's', startedAtMs: Date.now(), logger: silentLogger,
      devices: createTestDevice(config.dataDir, { epoch: config.epoch }).identity,
    })(fakeReq({ body: '{}' }), res);
    expect((await done).status).toBe(401);
  });

  it('POST bez nagłówka Origin → 403 (CSRF)', async () => {
    const captured = await routerFor(withKey).call({ body: '{}', origin: null });
    expect(captured.status).toBe(403);
  });

  it('GET → 405', async () => {
    const captured = await routerFor(withKey).call({ method: 'GET', body: '' });
    expect(captured.status).toBe(405);
  });

  it('ciało z parametrami → 400: konfigurację strumienia ustala serwer', async () => {
    const captured = await routerFor(withKey).call({ body: '{"model":"whisper"}' });
    expect(captured.status).toBe(400);
  });

  it('mint OK → 200, Cache-Control: no-store, ciało zgodne z kontraktem', async () => {
    const { impl } = fakeFetch([OK_REPLY]);
    const config = loadConfig({ RAROG_DEMO: '1', ...withKey });
    const device = createTestDevice(config.dataDir, { epoch: config.epoch });
    const handler = createRouter({
      config,
      manager: new FakeManager([makeSummary({ id: 's1' })]),
      hub: new SseHub({
        manager: new FakeManager([]), serverStartId: 's', protocolVersion: 1, heartbeatMs: 0,
      }),
      serverStartId: 's',
      startedAtMs: Date.now(),
      logger: silentLogger,
      devices: device.identity,
      voice: createVoiceMinter({
        apiKey: config.sonioxApiKey,
        apiHost: config.sonioxApiHost,
        enabled: config.voiceEnabled,
        fetchImpl: impl,
        minIntervalMs: VOICE_TOKEN_MIN_INTERVAL_MS,
        hourlyCap: VOICE_TOKEN_HOURLY_CAP,
      }),
    });
    const { res, done } = fakeRes();
    handler(fakeReq({
      body: '{}',
      authorization: device.authorization,
    }), res);
    const captured = await done;

    expect(captured.status).toBe(200);
    expect(captured.headers['cache-control']).toBe('no-store');
    expect(voiceTokenSchema.safeParse(captured.body).success).toBe(true);
    expect(captured.raw).toContain(TYMCZASOWY);
    // Twarda asercja: klucz STAŁY nie ma prawa pojawić się w odpowiedzi HTTP.
    expect(captured.raw).not.toContain(STALY_KLUCZ);
  });

  it('a device revoked while Soniox answers → 401 `device-revoked`, the temporary key does not leave', async () => {
    const config = loadConfig({ RAROG_DEMO: '1', ...withKey });
    const device = createTestDevice(config.dataDir, { epoch: config.epoch });
    let asked = false;
    let release = (): void => {};
    const handler = createRouter({
      config,
      manager: new FakeManager([makeSummary({ id: 's1' })]),
      hub: new SseHub({ manager: new FakeManager([]), serverStartId: 's', protocolVersion: 1, heartbeatMs: 0 }),
      serverStartId: 's', startedAtMs: Date.now(), logger: silentLogger, devices: device.identity,
      voice: createVoiceMinter({
        apiKey: config.sonioxApiKey, apiHost: config.sonioxApiHost, enabled: config.voiceEnabled,
        fetchImpl: () => {
          asked = true;
          return new Promise((resolve) => {
            release = () => { resolve({ status: OK_REPLY.status, json: () => Promise.resolve(OK_REPLY.payload) }); };
          });
        },
        minIntervalMs: VOICE_TOKEN_MIN_INTERVAL_MS, hourlyCap: VOICE_TOKEN_HOURLY_CAP,
      }),
    });
    const { res, done } = fakeRes();
    handler(fakeReq({ body: '{}', authorization: device.authorization }), res);
    // Revoked only once the body has passed its own check and the request to Soniox is out.
    await vi.waitFor(() => { expect(asked).toBe(true); });
    device.store.revoke(device.id, 'admin');
    release();
    const captured = await done;

    expect(captured.status).toBe(401);
    expect(captured.body).toMatchObject({ error: 'device-revoked' });
    expect(captured.raw).not.toContain(TYMCZASOWY);
  });

  it('żadna odpowiedź endpointu nie niesie klucza stałego — także błędy', async () => {
    const harness = routerFor(withKey);
    for (const body of ['{}', '{"model":"x"}', 'nie-json']) {
      const captured = await harness.call({ body });
      expect(captured.raw).not.toContain(STALY_KLUCZ);
    }
  });

  it('GET /api/version niesie voiceEnabled — PWA nie pokazuje martwego mikrofonu', async () => {
    const off = await routerFor({}).call({ method: 'GET', url: '/api/version', body: '' });
    expect(off.body).toMatchObject({ voiceEnabled: false });

    const on = await routerFor(withKey).call({ method: 'GET', url: '/api/version', body: '' });
    expect(on.body).toMatchObject({ voiceEnabled: true });
    expect(on.raw).not.toContain(STALY_KLUCZ);
  });
});
