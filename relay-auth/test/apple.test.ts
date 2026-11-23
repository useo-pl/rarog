/**
 * Klient Apple bramki (`src/apple.ts`) na atrapie `fetch`: adresy i ciała DeviceCheck, nagłówki próbnego pusha APNs,
 * podział odpowiedzi na odrzucony dowód, niedostępne Apple i odmowę naszemu kluczowi, termin. Prawdziwego Apple test
 * nie woła: każde wywołanie idzie do atrapy.
 */
import { describe, expect, it } from 'vitest';
import { DEVICECHECK_ORIGINS, PROBE_PAYLOAD, createAppleGate } from '../src/apple.ts';
import { APP_TOPIC, ProviderTokens } from '../src/wspolne.ts';
import { KEY_ID, TEAM_ID, apnsProof, deviceCheckProof } from './helpers.ts';

const NOW_MS = 1_793_700_000_000;

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type Script = (seen: Seen, signal: AbortSignal | null | undefined) => Promise<Response> | Response;

function gate(script: Script, timeoutMs = 1000) {
  const seen: Seen[] = [];
  const apple = createAppleGate({
    fetch: async (url, init) => {
      const entry: Seen = {
        url, method: String(init.method), headers: { ...(init.headers as Record<string, string>) },
        body: String(init.body),
      };
      seen.push(entry);
      return script(entry, init.signal);
    },
    now: () => NOW_MS,
    tokens: new ProviderTokens(new Uint8Array(32).fill(7), KEY_ID, TEAM_ID),
    transactionId: () => 'tx-0001',
    timeoutMs,
  });
  return { apple, seen };
}

const reply = (status: number, body = ''): Response => new Response(body, { status });
const token = deviceCheckProof('A').token;

describe('DeviceCheck', () => {
  it('query_two_bits: host środowiska, POST JSON z tokenem, transakcją i czasem w ms, token dostawcy ES256', async () => {
    const { apple, seen } = gate(() => reply(200, 'Bit State Not Found'));
    expect(await apple.queryBits('production', token)).toEqual({ ok: true, value: null });
    expect(await apple.queryBits('development', token)).toEqual({ ok: true, value: null });
    expect(seen.map((entry) => entry.url)).toEqual([
      `${DEVICECHECK_ORIGINS.production}/v1/query_two_bits`, `${DEVICECHECK_ORIGINS.development}/v1/query_two_bits`,
    ]);
    expect(DEVICECHECK_ORIGINS).toEqual({
      production: 'https://api.devicecheck.apple.com', development: 'https://api.development.devicecheck.apple.com',
    });
    const [first] = seen;
    expect(first?.method).toBe('POST');
    expect(JSON.parse(first?.body ?? '')).toEqual({ device_token: token, transaction_id: 'tx-0001', timestamp: NOW_MS });
    const jwt = /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(first?.headers['authorization'] ?? '');
    expect(JSON.parse(atob(jwt?.[1] ?? ''))).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(JSON.parse(atob(jwt?.[2] ?? ''))).toMatchObject({ iss: TEAM_ID });
    expect(first?.headers['content-type']).toBe('application/json');
  });

  it('bity z odpowiedzi 200; odpowiedź 200 bez bitów to nie stan (unreachable)', async () => {
    const bits = gate(() => reply(200, '{"bit0":true,"bit1":false,"last_update_time":"2026-11"}'));
    expect(await bits.apple.queryBits('production', token)).toEqual({
      ok: true, value: { bit0: true, bit1: false, lastUpdate: '2026-11' },
    });
    for (const body of ['', '{"bit0":"tak"}', '{"bit0":true,"bit1":true,"last_update_time":"listopad"}', '<html>']) {
      const broken = gate(() => reply(200, body));
      expect(await broken.apple.queryBits('production', token), body).toEqual({
        ok: false, failure: { kind: 'unreachable', status: 200 },
      });
    }
  });

  it('update_two_bits: bity w ciele; 200 = ok', async () => {
    const { apple, seen } = gate(() => reply(200));
    expect(await apple.updateBits('production', token, false, true)).toEqual({ ok: true, value: null });
    expect(seen[0]?.url).toBe(`${DEVICECHECK_ORIGINS.production}/v1/update_two_bits`);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      device_token: token, bit0: false, bit1: true, transaction_id: 'tx-0001', timestamp: NOW_MS,
    });
  });

  it.each([
    [400, 'Missing or badly formatted device token payload', { kind: 'rejected', status: 400 }],
    [400, 'Missing or incorrectly formatted payload', { kind: 'refused', status: 400 }],
    [401, 'Unable to verify authorization token', { kind: 'refused', status: 401 }],
    [403, '', { kind: 'refused', status: 403 }],
    [429, '', { kind: 'unreachable', status: 429 }],
    [500, '', { kind: 'unreachable', status: 500 }],
    [503, '', { kind: 'unreachable', status: 503 }],
  ] as const)('%i %s → %o', async (status, body, failure) => {
    const { apple } = gate(() => reply(status, body));
    expect(await apple.queryBits('production', token)).toEqual({ ok: false, failure });
    expect(await apple.updateBits('production', token, true, false)).toEqual({ ok: false, failure });
  });

  it('błąd sieci i termin: unreachable z przyczyną, bez treści wyjątku', async () => {
    const network = gate(() => { throw new Error('connect ECONNREFUSED Bearer x'); });
    expect(await network.apple.queryBits('production', token)).toEqual({
      ok: false, failure: { kind: 'unreachable', cause: 'network' },
    });
    const slow = gate((_seen, signal) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
    }), 20);
    expect(await slow.apple.queryBits('production', token)).toEqual({
      ok: false, failure: { kind: 'unreachable', cause: 'timeout' },
    });
  });

  it('query_two_bits bez bitów: tekst, który Apple zwraca na produkcji („Failed to find bit state”)', async () => {
    const { apple } = gate(() => reply(200, ' Failed to find bit state\n'));
    expect(await apple.queryBits('production', token)).toEqual({ ok: true, value: null });
  });

  it('query_two_bits: fraza „brak bitów” tylko jako cała odpowiedź, nie fragment innej', async () => {
    const longer = gate(() => reply(200, 'Failed to find bit state due to an internal error'));
    expect(await longer.apple.queryBits('production', token)).toEqual(
      { ok: false, failure: { kind: 'unreachable', status: 200 } });
    const withBits = gate(() => reply(200, JSON.stringify(
      { bit0: true, bit1: true, last_update_time: '2026-11', message: 'Failed to find bit state' })));
    expect(await withBits.apple.queryBits('production', token)).toEqual(
      { ok: true, value: { bit0: true, bit1: true, lastUpdate: '2026-11' } });
  });

  it('długa odpowiedź czytana z sufitem', async () => {
    const { apple } = gate(() => reply(200, `Bit State Not Found${' '.repeat(1_000_000)}`));
    expect(await apple.queryBits('production', token)).toEqual({ ok: true, value: null });
  });
});

describe('próbny push APNs', () => {
  const device = apnsProof('ab').token;

  it('cichy push w tle na token urządzenia: host środowiska, temat apki, priorytet 5, bez przechowania', async () => {
    const { apple, seen } = gate(() => reply(200));
    expect(await apple.probe('development', device)).toEqual({ ok: true, value: null });
    expect(await apple.probe('production', device)).toEqual({ ok: true, value: null });
    expect(seen.map((entry) => entry.url)).toEqual([
      `https://api.sandbox.push.apple.com/3/device/${device}`, `https://api.push.apple.com/3/device/${device}`,
    ]);
    expect(seen[0]?.headers).toMatchObject({
      'apns-push-type': 'background', 'apns-priority': '5', 'apns-topic': APP_TOPIC, 'apns-expiration': '0',
      'content-type': 'application/json',
    });
    expect(seen[0]?.headers['authorization']).toMatch(/^bearer [^.]+\.[^.]+\.[^.]+$/);
    expect(seen[0]?.body).toBe(PROBE_PAYLOAD);
    expect(JSON.parse(PROBE_PAYLOAD)).toEqual({ aps: { 'content-available': 1 } });
  });

  it.each([
    [410, '{"reason":"Unregistered","timestamp":1793700000000}', { kind: 'rejected', status: 410, reason: 'Unregistered' }],
    [400, '{"reason":"BadDeviceToken"}', { kind: 'rejected', status: 400, reason: 'BadDeviceToken' }],
    [400, '{"reason":"DeviceTokenNotForTopic"}', { kind: 'rejected', status: 400, reason: 'DeviceTokenNotForTopic' }],
    [403, '{"reason":"InvalidProviderToken"}', { kind: 'refused', status: 403, reason: 'InvalidProviderToken' }],
    [400, '{"reason":"TopicDisallowed"}', { kind: 'refused', status: 400, reason: 'TopicDisallowed' }],
    [429, '{"reason":"TooManyProviderTokenUpdates"}',
      { kind: 'unreachable', status: 429, reason: 'TooManyProviderTokenUpdates' }],
    [503, '', { kind: 'unreachable', status: 503 }],
  ] as const)('%i %s → %o', async (status, body, failure) => {
    const { apple } = gate(() => reply(status, body));
    expect(await apple.probe('production', device)).toEqual({ ok: false, failure });
  });

  it('błąd sieci = unreachable', async () => {
    const { apple } = gate(() => { throw new TypeError('fetch failed'); });
    expect(await apple.probe('production', device)).toEqual({ ok: false, failure: { kind: 'unreachable', cause: 'network' } });
  });
});
