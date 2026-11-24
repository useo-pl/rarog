/**
 * Kanarek relaya `scripts/relay-canary.mjs`: czyste części bez sieci (klucze z sekretu, werdykt transferu,
 * argumenty). Przebieg na żywo idzie z CI (workflow kanarka) albo ręcznie.
 */
import { spawnSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELAY_AUTH_CLIENT_HEADER, parseRelayAuthRequest, relayAuthSigningBytes, relayAuthSigningText,
} from '../../shared/src/relay-auth.ts';
import {
  describeTransfer, endpointIdOf, judgeTransfer, parseKeys, renewEntries, renewSigningText,
} from '../../scripts/relay-canary.mjs';

const CANARY = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'relay-canary.mjs');
const KEY_A = '0a'.repeat(32);
const KEY_B = '0b'.repeat(32);

describe('relay-canary.mjs: klucze z RELAY_CANARY_KEYS', () => {
  it('pusty sekret = brak kluczy (kroki z kluczami mówią „skipped”), dwa klucze hex = bajty', () => {
    expect(parseKeys(undefined)).toEqual({ keys: [] });
    expect(parseKeys('  ')).toEqual({ keys: [] });
    const res = parseKeys(` ${KEY_A.toUpperCase()} , ${KEY_B}`);
    expect(res.keys).toHaveLength(2);
    expect(res.keys?.[0]).toEqual(Array(32).fill(0x0a));
  });

  it('jeden klucz, trzy albo zły hex = błąd bez wartości klucza w komunikacie', () => {
    for (const raw of [KEY_A, `${KEY_A},${KEY_B},${KEY_A}`, `${KEY_A},xyz`]) {
      const res = parseKeys(raw);
      expect(res.error).toMatch(/two keys of 64 hex characters/);
      expect(res.error).not.toContain('0a0a');
    }
  });
});

describe('relay-canary.mjs: werdykt kroku `rate`', () => {
  const ok = { bytes: 60_000_000, burstMs: 1640, totalMs: 15_370 };
  it('całość 14–18 s (burst 16 MB, potem 3 MB/s); szybkość klienta bez znaczenia, byle ponad 4,5 MB/s', () => {
    expect(judgeTransfer(ok)).toBeNull();
    // Nadawca i odbiorca w jednym procesie na VPS relaya: ok. 4,8 MB/s na starcie, całość 15,3 s.
    expect(judgeTransfer({ ...ok, burstMs: 3318, totalMs: 15_281 })).toBeNull();
    expect(judgeTransfer({ ...ok, totalMs: 6000 })).toMatch(/the rx limit does not work/);
    expect(judgeTransfer({ ...ok, burstMs: 1640, totalMs: 20_100 })).toMatch(/no 16 MB burst/);
    expect(judgeTransfer({ ...ok, burstMs: 5333, totalMs: 20_000 })).toMatch(/client or network too slow/);
    // Stałe 4 MB/s bez limitu i bez burstu: 15 s mieści się w oknie, ale pomiar nie odróżnia limitu od sieci.
    expect(judgeTransfer({ ...ok, burstMs: 4000, totalMs: 15_000 })).toMatch(/measurement invalid/);
    // Klient 4,5 MB/s bez limitu kończy w 13,3 s, więc wypada jako brak limitu, nie jako zaliczenie.
    expect(judgeTransfer({ ...ok, burstMs: 3556, totalMs: 13_333 })).toMatch(/the rx limit does not work/);
    expect(judgeTransfer({ ...ok, bytes: 59_000_000 })).toMatch(/received 59000000/);
  });

  it('opis transferu: czasy i tempo obu części', () => {
    expect(describeTransfer(ok)).toBe('60 MB in 15370 ms; first 16 MB in 1640 ms (9.76 MB/s), rest 3.20 MB/s');
  });
});

describe('relay-canary.mjs: renewal of the registry entries before `registered`', () => {
  const APP_SECRET = Array<number>(32).fill(0x0a);
  const SERVER_SECRET = Array<number>(32).fill(0x0b);
  const NOW = 1_800_000_000;
  const EXPIRES = NOW + 90 * 24 * 3600;
  const renewed = (unsponsored: string[]) => Response.json({ v: 1, expiresAt: EXPIRES, unsponsored });

  /** The canary against a fake registry: the request it sent and its verdict. */
  async function renewAgainst(answer: () => Promise<Response>) {
    const sent: Request[] = [];
    const result = await renewEntries([APP_SECRET, SERVER_SECRET], {
      registry: 'https://registry.test/', nowSec: () => NOW,
      fetch: async (url: string | URL, init?: RequestInit) => {
        sent.push(new Request(url, init));
        return answer();
      },
    });
    return { result, sent };
  }

  it('key 0 signs `renew` listing key 1; the registry contract accepts the body and the signature', async () => {
    const { result, sent } = await renewAgainst(async () => renewed([]));
    expect(result).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    const [request] = sent as [Request];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://registry.test/v1/app/renew');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get(RELAY_AUTH_CLIENT_HEADER)).toMatch(/^[a-z][a-z0-9-]{0,31}\/[0-9A-Za-z.+-]{1,32}$/);
    const parsed = parseRelayAuthRequest('renew', await request.json());
    if (!parsed.ok) throw new Error(`bad body: ${parsed.field}`);
    const app = endpointIdOf(APP_SECRET);
    expect(parsed.request).toMatchObject({ endpointId: app, issuedAt: NOW, servers: [endpointIdOf(SERVER_SECRET)] });
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(app, 'hex').toString('base64url') }, format: 'jwk',
    });
    const sig = Buffer.from(parsed.request.sig, 'hex');
    expect(verify(null, relayAuthSigningBytes('renew', parsed.request), publicKey, sig)).toBe(true);
  });

  it('the canary signing text is the contract text of `renew`', () => {
    for (const servers of [[], [KEY_B], [KEY_A, KEY_B]]) {
      const unsigned = { v: 1 as const, endpointId: KEY_A, issuedAt: NOW, servers };
      expect(renewSigningText(unsigned)).toBe(relayAuthSigningText('renew', unsigned));
    }
  });

  it.each([
    ['200 with nothing unsponsored', () => renewed([]), null],
    ['200 with key 1 unsponsored', () => renewed([endpointIdOf(SERVER_SECRET)]), /key 1 is not sponsored by key 0/],
    ['404 not-registered', () => Response.json({ v: 1, error: 'not-registered' }, { status: 404 }),
      /key 0 has no app entry/],
    ['503 unavailable', () => Response.json({ v: 1, error: 'unavailable' }, { status: 503 }), /503 unavailable/],
    ['200 without the fields', () => Response.json({ v: 1 }), /unexpected response/],
    ['no answer', () => Promise.reject(new Error('connect ECONNREFUSED')), /registry unreachable/],
  ] as const)('%s', async (_name, answer, failure) => {
    const { result } = await renewAgainst(async () => answer());
    if (failure === null) {
      expect(result).toEqual({ ok: true, text: 'both registry entries renewed until 2027-04-15' });
    } else {
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(failure);
    }
  });

  it('without RELAY_CANARY_KEYS the step is skipped without a request', async () => {
    const result = await renewEntries([], { fetch: () => Promise.reject(new Error('no request expected')) });
    expect(result).toEqual({ skip: expect.any(String) });
  });
});

describe('relay-canary.mjs: argumenty', () => {
  it.each([
    [['--inny'], {}, 'unknown argument --inny'],
    [[], { RELAY_CANARY_MODE: 'open' }, 'RELAY_CANARY_MODE must be shadow or enforce'],
    [[], { RELAY_CANARY_KEYS: KEY_A }, 'RELAY_CANARY_KEYS: expected two keys'],
  ])('%j %j: kod 2 bez sieci', (args, env, message) => {
    const res = spawnSync(process.execPath, [CANARY, ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, timeout: 10_000,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(message);
  });
});
