/**
 * Wywołanie APNs na atrapie `fetch`: host per środowisko, nagłówki, sufit czasu, odczyt odpowiedzi
 * i rozróżnienie „martwy token” / „inna odpowiedź Apple” / „Apple nie odpowiedział”.
 */
import { describe, expect, it } from 'vitest';
import { callApns, isTokenRejection } from '../src/apns.ts';
import type { ApnsCall, ApnsOutcome } from '../src/apns.ts';
import { T1 } from './helpers.ts';

const request: ApnsCall = {
  environment: 'development',
  token: T1,
  jwt: 'aaa.bbb.ccc',
  headers: { 'apns-push-type': 'alert', 'apns-topic': 'ai.rarog.app' },
  body: '{"aps":{"badge":1}}',
};

const respond = (status: number, body = '') => async (): Promise<Response> => new Response(body, { status });

describe('callApns', () => {
  it('POST na host środowiska z JWT, typem treści i nagłówkami wołającego, ciało bez zmian', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
      seen.push({ url, init });
      return new Response('', { status: 200 });
    };
    await callApns(fetchFn, request);
    await callApns(fetchFn, { ...request, environment: 'production' });
    expect(seen.map(({ url }) => url)).toEqual([
      `https://api.sandbox.push.apple.com/3/device/${T1}`,
      `https://api.push.apple.com/3/device/${T1}`,
    ]);
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.headers).toEqual({
      'apns-push-type': 'alert', 'apns-topic': 'ai.rarog.app', authorization: 'bearer aaa.bbb.ccc',
      'content-type': 'application/json',
    });
    expect(seen[0]?.init.body).toBe(request.body);
  });

  it.each<[string, number, string, ApnsOutcome, boolean]>([
    ['200', 200, '', { kind: 'response', status: 200 }, false],
    ['400 BadDeviceToken', 400, '{"reason":"BadDeviceToken"}', { kind: 'response', status: 400, reason: 'BadDeviceToken' }, true],
    ['400 DeviceTokenNotForTopic', 400, '{"reason":"DeviceTokenNotForTopic"}',
      { kind: 'response', status: 400, reason: 'DeviceTokenNotForTopic' }, true],
    ['410 z timestamp (ms)', 410, '{"reason":"Unregistered","timestamp":1793600000000}',
      { kind: 'response', status: 410, reason: 'Unregistered', timestamp: 1793600000000 }, true],
    ['410 bez ciała', 410, '', { kind: 'response', status: 410 }, true],
    ['400 BadTopic', 400, '{"reason":"BadTopic"}', { kind: 'response', status: 400, reason: 'BadTopic' }, false],
    ['403 klucza', 403, '{"reason":"InvalidProviderToken"}',
      { kind: 'response', status: 403, reason: 'InvalidProviderToken' }, false],
    ['403 środowiska klucza', 403, '{"reason":"BadEnvironmentKeyIdInToken"}',
      { kind: 'response', status: 403, reason: 'BadEnvironmentKeyIdInToken' }, false],
    ['429 Apple', 429, '{"reason":"TooManyRequests"}', { kind: 'response', status: 429, reason: 'TooManyRequests' }, false],
    ['500', 500, '{"reason":"InternalServerError"}', { kind: 'response', status: 500, reason: 'InternalServerError' }, false],
    ['503', 503, '{"reason":"ServiceUnavailable"}', { kind: 'response', status: 503, reason: 'ServiceUnavailable' }, false],
    ['powód spoza wzorca', 400, '{"reason":"Bad Device <token>"}', { kind: 'response', status: 400 }, false],
    ['ciało nie-JSON', 502, '<html>bad gateway</html>', { kind: 'response', status: 502 }, false],
  ])('%s → wynik i „martwy token”', async (_what, status, body, outcome, rejected) => {
    const result = await callApns(respond(status, body), request);
    expect(result).toEqual(outcome);
    expect(isTokenRejection(result)).toBe(rejected);
  });

  it('błąd sieci → unreachable/network (bez komunikatu błędu)', async () => {
    const result = await callApns(async () => { throw new TypeError('connect ECONNREFUSED bearer aaa.bbb.ccc'); }, request);
    expect(result).toEqual({ kind: 'unreachable', cause: 'network' });
    expect(isTokenRejection(result)).toBe(false);
  });

  it('brak odpowiedzi w sufit → żądanie anulowane, unreachable/timeout', async () => {
    let aborted = false;
    const hanging = (_url: string, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });
    expect(await callApns(hanging, request, 20)).toEqual({ kind: 'unreachable', cause: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('ciało odpowiedzi czytane najwyżej do 4 KiB', async () => {
    const huge = `{"reason":"BadTopic","pad":"${'x'.repeat(100_000)}"}`;
    expect(await callApns(respond(400, huge), request)).toEqual({ kind: 'response', status: 400 });
  });
});
