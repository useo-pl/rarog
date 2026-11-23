/**
 * Dławik nieudanych prób uwierzytelnienia (`auth/limiter.ts`), źródło próby do logu i wymazywanie sekretów
 * (`auth/redact.ts`). Klucz urządzenia i bramkę `authenticate` sprawdza `auth-principal.test.ts`.
 */
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { REDACTED, createLoginLimiter, loginPeer, redact } from '../src/auth/index.ts';

const SEKRET = 'super-tajny-sekret-abc123';

/*
 * The public authentication path has an attempt budget: the limiter counts a wrong pairing code and an unknown
 * device key with one budget.
 */
describe('dławik nieudanych prób', () => {
  const T0 = 1_700_000_000_000;

  it('do budżetu odpowiada 401, powyżej 429 z sensownym Retry-After', () => {
    const limiter = createLoginLimiter({ budget: 3, windowMs: 60_000 });
    for (let i = 1; i <= 3; i += 1) {
      expect(limiter.fail('100.64.0.9', T0, 'pairing').limited, `próba ${String(i)}`).toBe(false);
    }
    const czwarta = limiter.fail('100.64.0.9', T0, 'pairing');
    expect(czwarta.limited).toBe(true);
    expect(czwarta.retryAfterSeconds).toBe(60);
  });

  it('loguje pierwszą porażkę i moment przekroczenia budżetu — i nic więcej', () => {
    const limiter = createLoginLimiter({ budget: 2, windowMs: 60_000 });
    const linie = [1, 2, 3, 4, 5, 6]
      .map((i) => limiter.fail('100.64.0.9', T0 + i, i % 2 === 0 ? 'pairing' : 'device key').logLine)
      .filter((line): line is string => line !== undefined);
    expect(linie).toHaveLength(2);
    expect(linie[0]).toBe('failed device key attempt (100.64.0.9)');
    expect(linie[1]).toMatch(/budget 2 .* exhausted/);
    expect(linie[1]).toContain('counted together: pairing, unknown device key');
  });

  it('nowe okno zaczyna budżet i log od zera', () => {
    const limiter = createLoginLimiter({ budget: 1, windowMs: 60_000 });
    expect(limiter.fail('a', T0, 'pairing').limited).toBe(false);
    expect(limiter.fail('a', T0 + 1, 'pairing').limited).toBe(true);
    const poOknie = limiter.fail('a', T0 + 60_000, 'pairing');
    expect(poOknie.limited).toBe(false);
    expect(poOknie.logLine).toBeDefined();
  });

  it('udane parowanie kasuje budżet — cudzy hałas nie zamyka drogi właścicielowi', () => {
    const limiter = createLoginLimiter({ budget: 1, windowMs: 60_000 });
    limiter.fail('obcy', T0, 'pairing');
    expect(limiter.fail('obcy', T0, 'pairing').limited).toBe(true);
    limiter.succeed();
    expect(limiter.fail('obcy', T0, 'pairing').limited).toBe(false);
  });

  it('linia podsumowania wymienia źródła, a resztę zwija do „+N"', () => {
    const limiter = createLoginLimiter({ budget: 10, windowMs: 60_000 });
    let ostatnia: string | undefined;
    for (let i = 1; i <= 11; i += 1) {
      ostatnia = limiter.fail(`10.0.0.${String(i)}`, T0, 'device key').logLine ?? ostatnia;
    }
    expect(ostatnia).toContain('10.0.0.1, 10.0.0.2, 10.0.0.3 +8');
  });
});

describe('loginPeer', () => {
  const req = (headers: Record<string, string>, remote?: string): IncomingMessage => (
    { headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage
  );

  it('bierze pierwszy człon X-Forwarded-For (ten dokłada Caddy)', () => {
    expect(loginPeer(req({ 'x-forwarded-for': '100.64.0.9, 10.0.0.1' }))).toBe('100.64.0.9');
  });

  it('bez nagłówka bierze adres gniazda', () => {
    expect(loginPeer(req({}, '127.0.0.1'))).toBe('127.0.0.1');
    expect(loginPeer(req({}))).toBe('unknown source');
  });

  /*
   * Nagłówek ustawia KLIENT, więc jego wartość musi przejść przez filtr — inaczej jedno
   * żądanie wstrzyknęłoby do `server.log` własną linię albo kilobajt śmieci.
   */
  it('wycina znaki spoza adresu IP i tnie długość', () => {
    expect(loginPeer(req({ 'x-forwarded-for': '1.2.3.4\nfailed pairing attempt (victim)' })))
      .toBe('1.2.3.4');
    expect(loginPeer(req({ 'x-forwarded-for': '9'.repeat(500) })).length).toBe(45);
  });
});

describe('redact', () => {
  it('nie przepuszcza wartości pól o wrażliwych nazwach', () => {
    const out = redact({ token: SEKRET, cookie: 'rarog_auth=1.abc', ok: 'jawne' });
    expect(out).not.toContain(SEKRET);
    expect(out).toContain(REDACTED);
    expect(out).toContain('jawne');
  });

  it('czyści pole o wrażliwej nazwie niezależnie od zagnieżdżenia', () => {
    const out = redact({ req: { path: '/api/pair', body: { secret: SEKRET } } }, [SEKRET]);
    expect(out).not.toContain(SEKRET);
    expect(out).toContain('/api/pair');
  });

  it('wymazuje sekret także z gołego stringa', () => {
    expect(redact(`nieudane żądanie z kluczem ${SEKRET}`, [SEKRET])).not.toContain(SEKRET);
  });

  it('wymazuje sekret z komunikatu wyjątku', () => {
    const out = redact(new Error(`odrzucono ${SEKRET}`), [SEKRET]);
    expect(out).not.toContain(SEKRET);
    expect(out).toContain('Error');
  });

  it('nie wywala się na cyklu ani na tablicach', () => {
    const cykl: Record<string, unknown> = { a: 1 };
    cykl['self'] = cykl;
    expect(() => redact(cykl)).not.toThrow();
    expect(redact([{ authorization: SEKRET }])).not.toContain(SEKRET);
  });

  it('nagłówki requestu: cookie i authorization znikają, reszta zostaje', () => {
    const out = redact({
      'user-agent': 'iPhone',
      cookie: 'rarog_auth=1.abc',
      authorization: 'Bearer xyz',
    });
    expect(out).toContain('iPhone');
    expect(out).not.toContain('Bearer');
    expect(out).not.toContain('1.abc');
  });
});
