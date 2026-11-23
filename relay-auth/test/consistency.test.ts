/**
 * Spójność między obiektami rejestru: przeplatanki `register`, `renew`, `sponsor` i `forget` wymuszone zatrzaskiem
 * w wywołaniu RPC (`LocalRegistry.pause`) i awarie Durable Object między krokami (`failOnce` przed skutkiem,
 * `loseReply` po trwałym skutku, awaria zapisu magazynu). Każdy przypadek kończy się sprawdzeniem tego, co widzi hak
 * relaya, i rozliczenia kwot.
 */
import { describe, expect, it } from 'vitest';
import type { RelayAuthAppRoute } from '../../shared/src/relay-auth.ts';
import { DROP_RETRY_SECONDS, ENTRY_TTL_SECONDS, RESERVATION_TTL_SECONDS, bitsCount } from '../src/registry.ts';
import {
  DAY, SERVER_A, SERVER_B, T0, apnsProof, appKey, deviceCheckProof, harness, hookRequest, json, request,
} from './helpers.ts';
import type { AppKey, Harness } from './helpers.ts';

const signed = async (key: AppKey, route: RelayAuthAppRoute, fields: Readonly<Record<string, unknown>> = {}) =>
  request(route, await key.sign(route, { issuedAt: T0, ...fields }));

async function registered(h: Harness, seed: number, proof = deviceCheckProof('R')): Promise<AppKey> {
  const key = await appKey(seed);
  expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(200);
  return key;
}

async function sponsored(h: Harness, key: AppKey, server: string): Promise<void> {
  expect((await h.call(await signed(key, 'sponsor', { server }))).status).toBe(200);
}

async function hook(h: Harness, endpointId: string): Promise<string> {
  return (await h.call(hookRequest(endpointId))).text();
}

const day = new Date(T0 * 1000).toISOString().slice(0, 10);

describe('register i forget', () => {
  it('forget między sprawdzeniem wpisu a jego przedłużeniem: rejestracja od nowa idzie przez rozliczenie bramki', async () => {
    const h = await harness();
    const proof = deviceCheckProof('R');
    const key = await registered(h, 81, proof);
    expect(h.apple.count('update')).toBe(1);
    const latch = h.registry.pause(key.endpointId, ['admitApp', 'extendApp']);
    const again = h.call(await signed(key, 'register', { proof }));
    await latch.reached;
    expect((await h.call(await signed(key, 'forget'))).status).toBe(200);
    latch.release();
    expect((await again).status).toBe(200);
    // Nowy wpis po `forget` kosztuje jednostkę kwoty urządzenia jak każda nowa rejestracja.
    expect(h.apple.count('update')).toBe(2);
    expect(bitsCount(h.apple.bits.get(proof.token) ?? null, T0)).toBe(2);
  });
});

describe('rozliczenie bramki i utracona odpowiedź wpisu', () => {
  it('odpowiedź admitApp ginie po założeniu wpisu, potem forget: rejestracja od nowa płaci jak nowa', async () => {
    const h = await harness();
    const proof = deviceCheckProof('L');
    const key = await appKey(93);
    h.registry.loseReply(key.endpointId, 'admitApp');
    expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(500);
    expect(await hook(h, key.endpointId)).toBe('true');
    expect((await h.call(await signed(key, 'forget'))).status).toBe(200);
    expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(200);
    // Druga inkarnacja kosztuje drugą jednostkę kwoty urządzenia i hamulca: rozliczenie pierwszej już zużyte.
    expect(h.apple.count('update')).toBe(2);
    expect(bitsCount(h.apple.bits.get(proof.token) ?? null, T0)).toBe(2);
    expect(h.registry.gateStore.data.get(`brake:devicecheck:${day}`)).toBe(2);
  });

  it('jak wyżej z przedłużeniem żywego wpisu pomiędzy: ślad rozliczenia nie daje darmowej inkarnacji', async () => {
    const h = await harness();
    const proof = deviceCheckProof('M');
    const key = await appKey(94);
    h.registry.loseReply(key.endpointId, 'admitApp');
    expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(500);
    expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(200);
    expect(h.apple.count('update')).toBe(1);
    expect((await h.call(await signed(key, 'forget'))).status).toBe(200);
    expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(200);
    expect(h.apple.count('update')).toBe(2);
    expect(h.registry.gateStore.data.get(`brake:devicecheck:${day}`)).toBe(2);
  });
});

describe('wygasła rezerwacja przed alarmem', () => {
  it.each(['renew', 'register', 'forget'] as const)(
    'rezerwacja wygasa bez dokończenia, przed alarmem %s: poręczenie u serwera zdjęte', async (step) => {
    const h = await harness();
    const proof = deviceCheckProof('W');
    const key = await registered(h, 96, proof);
    h.registry.failOnce(key.endpointId, 'commit');
    expect((await h.call(await signed(key, 'sponsor', { server: SERVER_A }))).status).toBe(500);
    expect(await hook(h, SERVER_A)).toBe('true');
    h.clock.advance(RESERVATION_TTL_SECONDS);
    const fields = step === 'renew' ? { servers: [] } : step === 'register' ? { proof } : {};
    expect((await h.call(await signed(key, step, { issuedAt: h.clock.sec, ...fields }))).status).toBe(200);
    h.clock.advance(1);
    await h.registry.fireAlarms();
    expect(await hook(h, SERVER_A)).toBe('false');
    expect(h.registry.entry(SERVER_A)).toBeUndefined();
  });
});

describe('ponowione zdjęcie a nowe poręczenie tego serwera', () => {
  it('zdjęcie wygasłej rezerwacji pada i czeka; nowe poręczenie tej inkarnacji przeżywa ponowienie', async () => {
    const h = await harness();
    const key = await registered(h, 97);
    h.registry.failOnce(key.endpointId, 'commit');
    expect((await h.call(await signed(key, 'sponsor', { server: SERVER_A }))).status).toBe(500);
    h.clock.advance(RESERVATION_TTL_SECONDS);
    h.registry.failOnce(SERVER_A, 'dropSponsor');
    await h.registry.fireAlarms();
    expect(await hook(h, SERVER_A)).toBe('true');
    const again = await h.call(await signed(key, 'sponsor', { server: SERVER_A, issuedAt: h.clock.sec }));
    expect(again.status).toBe(200);
    h.clock.advance(DROP_RETRY_SECONDS);
    await h.registry.fireAlarms();
    expect(h.registry.entry(key.endpointId)).toMatchObject({ sponsored: [{ server: SERVER_A }] });
    expect(await hook(h, SERVER_A)).toBe('true');
  });
});

describe('niezmiennik roszczeń: dwie próby z tym samym poręczeniem', () => {
  it('cancel pierwszej próby po zapisie drugiej: rezerwacja zostaje do zdjęcia, kwota zostaje zużyta', async () => {
    const h = await harness({ SPONSOR_QUOTA: '1' });
    const app = await registered(h, 98);
    const target = await registered(h, 99);
    const latch = h.registry.pause(app.endpointId, ['cancel']);
    const first = h.call(await signed(app, 'sponsor', { server: target.endpointId }));
    await latch.reached;
    expect((await h.call(await signed(target, 'forget'))).status).toBe(200);
    h.registry.failOnce(app.endpointId, 'commit');
    expect((await h.call(await signed(app, 'sponsor', { server: target.endpointId }))).status).toBe(500);
    latch.release();
    expect((await first).status).toBe(409);
    expect(await hook(h, target.endpointId)).toBe('true');
    // Druga próba mogła zapisać (i zapisała), więc jednostka kwoty nie wraca: inny serwer przy kwocie 1 odpada.
    expect((await h.call(await signed(app, 'sponsor', { server: SERVER_B }))).status).toBe(429);
    h.clock.advance(RESERVATION_TTL_SECONDS);
    await h.registry.fireAlarms();
    expect(await hook(h, target.endpointId)).toBe('false');
  });

  it('próba stoi przed zapisem, druga dostaje odmowę serwera: zapis pierwszej dokończony, kwota zostaje', async () => {
    const h = await harness({ SPONSOR_QUOTA: '1' });
    const app = await registered(h, 100);
    const target = await registered(h, 101);
    const latch = h.registry.pause(target.endpointId, ['addSponsor']);
    const first = h.call(await signed(app, 'sponsor', { server: target.endpointId }));
    await latch.reached;
    expect((await h.call(await signed(app, 'sponsor', { server: target.endpointId }))).status).toBe(409);
    expect((await h.call(await signed(target, 'forget'))).status).toBe(200);
    latch.release();
    expect((await first).status).toBe(200);
    expect(await hook(h, target.endpointId)).toBe('true');
    expect(h.registry.entry(app.endpointId)).toMatchObject({ sponsored: [{ server: target.endpointId }], starts: [T0] });
    expect((await h.call(await signed(app, 'sponsor', { server: SERVER_B }))).status).toBe(429);
  });
});

describe('niezmiennik roszczeń: powtórka poręczenia tuż przed jego terminem', () => {
  const nearTerm = ENTRY_TTL_SECONDS - 1;

  it.each([
    ['commit pada', (h: Harness, key: AppKey) => { h.registry.failOnce(key.endpointId, 'commit'); }],
    ['odpowiedź addSponsor ginie', (h: Harness) => { h.registry.loseReply(SERVER_A, 'addSponsor'); }],
  ] as const)('%s: przedłużenie zapisane u apki przed zapisem u serwera, forget zdejmuje poręczenie', async (_, fault) => {
    const h = await harness();
    const key = await registered(h, 102);
    await sponsored(h, key, SERVER_A);
    h.clock.advance(nearTerm);
    fault(h, key);
    expect((await h.call(await signed(key, 'sponsor', { server: SERVER_A, issuedAt: h.clock.sec }))).status).toBe(500);
    // Stary termin poręczenia mija: apka nadal trzyma poręczenie, które serwer przedłużył o 90 dni.
    h.clock.advance(2);
    await h.registry.fireAlarms();
    expect(await hook(h, key.endpointId)).toBe('true');
    expect((await h.call(await signed(key, 'forget', { issuedAt: h.clock.sec }))).status).toBe(200);
    expect(await hook(h, SERVER_A)).toBe('false');
  });

  it('commit stoi na zatrzasku po zapisie u serwera: roszczenie apki już ma nowy termin', async () => {
    const h = await harness();
    const key = await registered(h, 103);
    await sponsored(h, key, SERVER_A);
    h.clock.advance(nearTerm);
    const latch = h.registry.pause(key.endpointId, ['commit']);
    const again = h.call(await signed(key, 'sponsor', { server: SERVER_A, issuedAt: h.clock.sec }));
    await latch.reached;
    const server = h.registry.entry(SERVER_A);
    const app = h.registry.entry(key.endpointId);
    expect(server?.kind === 'server' ? server.sponsors[0]?.expiresAt : null).toBe(T0 + nearTerm + ENTRY_TTL_SECONDS);
    expect(app?.kind === 'app' ? app.sponsored[0]?.expiresAt : null).toBe(T0 + nearTerm + ENTRY_TTL_SECONDS);
    latch.release();
    expect((await again).status).toBe(200);
  });
});

describe('renew, sponsor i forget', () => {
  it('forget w trakcie renew: spóźniony zapis poręczenia u serwera nie zostaje', async () => {
    const h = await harness();
    const key = await registered(h, 82);
    await sponsored(h, key, SERVER_A);
    const latch = h.registry.pause(SERVER_A, ['addSponsor']);
    const renewing = h.call(await signed(key, 'renew', { servers: [SERVER_A] }));
    await latch.reached;
    expect((await h.call(await signed(key, 'forget'))).status).toBe(200);
    expect(await hook(h, SERVER_A)).toBe('false');
    latch.release();
    expect((await renewing).status).toBe(200);
    expect(await hook(h, SERVER_A)).toBe('false');
    expect(h.registry.entry(SERVER_A)).toBeUndefined();
  });

  it('forget i nowa rejestracja w trakcie renew: poręczenie starej inkarnacji nie przechodzi na nową', async () => {
    const h = await harness();
    const key = await registered(h, 83);
    await sponsored(h, key, SERVER_A);
    const latch = h.registry.pause(SERVER_A, ['addSponsor']);
    const renewing = h.call(await signed(key, 'renew', { servers: [SERVER_A] }));
    await latch.reached;
    expect((await h.call(await signed(key, 'forget'))).status).toBe(200);
    expect((await h.call(await signed(key, 'register', { proof: deviceCheckProof('R') }))).status).toBe(200);
    latch.release();
    expect((await renewing).status).toBe(200);
    expect(await hook(h, SERVER_A)).toBe('false');
    expect(h.registry.entry(key.endpointId)).toMatchObject({ sponsored: [], reservations: [], starts: [] });
  });

  it('forget i nowa rejestracja w trakcie sponsor: poręczenie nie trafia do nowej inkarnacji bez kwoty', async () => {
    const h = await harness();
    const key = await registered(h, 84);
    const latch = h.registry.pause(SERVER_A, ['addSponsor']);
    const sponsoring = h.call(await signed(key, 'sponsor', { server: SERVER_A }));
    await latch.reached;
    expect((await h.call(await signed(key, 'forget'))).status).toBe(200);
    expect((await h.call(await signed(key, 'register', { proof: deviceCheckProof('R') }))).status).toBe(200);
    latch.release();
    const response = await sponsoring;
    expect(response.status).toBe(404);
    expect(await json(response)).toMatchObject({ error: 'not-registered' });
    expect(await hook(h, SERVER_A)).toBe('false');
    expect(h.registry.entry(key.endpointId)).toMatchObject({ sponsored: [], starts: [] });
  });

  it('forget w trakcie renew i awaria sprawdzenia po zapisie: alarm zapomnianej inkarnacji zdejmuje poręczenie', async () => {
    const h = await harness();
    const key = await registered(h, 85);
    await sponsored(h, key, SERVER_A);
    const latch = h.registry.pause(SERVER_A, ['addSponsor']);
    const renewing = h.call(await signed(key, 'renew', { servers: [SERVER_A] }));
    await latch.reached;
    expect((await h.call(await signed(key, 'forget'))).status).toBe(200);
    h.registry.failOnce(key.endpointId, 'orphans');
    latch.release();
    expect((await renewing).status).toBe(500);
    expect(await hook(h, SERVER_A)).toBe('true');
    h.clock.advance(DAY);
    await h.registry.fireAlarms();
    expect(await hook(h, SERVER_A)).toBe('false');
  });

  it('sponsor pada przed dokończeniem i nikt nie ponawia: wygasła rezerwacja zdejmuje poręczenie u serwera', async () => {
    const h = await harness();
    const key = await registered(h, 86);
    h.registry.failOnce(key.endpointId, 'commit');
    expect((await h.call(await signed(key, 'sponsor', { server: SERVER_A }))).status).toBe(500);
    expect(await hook(h, SERVER_A)).toBe('true');
    h.clock.advance(RESERVATION_TTL_SECONDS);
    await h.registry.fireAlarms();
    expect(await hook(h, SERVER_A)).toBe('false');
    // Jednostka kwoty poręczeń zostaje zużyta: awaria nigdy nie daje poręczenia za darmo.
    expect(h.registry.entry(key.endpointId)).toMatchObject({ sponsored: [], reservations: [], starts: [T0] });
  });
});

describe('forget z awarią zdejmowania', () => {
  it('dropSponsor u serwera pada: 500, ponowienie forget kończy zdejmowanie', async () => {
    const h = await harness();
    const key = await registered(h, 87);
    await sponsored(h, key, SERVER_A);
    await sponsored(h, key, SERVER_B);
    h.registry.failOnce(SERVER_A, 'dropSponsor');
    expect((await h.call(await signed(key, 'forget'))).status).toBe(500);
    expect(await hook(h, SERVER_B)).toBe('false');
    expect((await h.call(await signed(key, 'forget'))).status).toBe(200);
    expect(await hook(h, SERVER_A)).toBe('false');
    expect(h.registry.entry(SERVER_A)).toBeUndefined();
  });

  it('dropSponsor pada i nikt nie ponawia: alarm wpisu apki kończy zdejmowanie, także po drugiej porażce', async () => {
    const h = await harness();
    const key = await registered(h, 88);
    await sponsored(h, key, SERVER_A);
    h.registry.failOnce(SERVER_A, 'dropSponsor');
    expect((await h.call(await signed(key, 'forget'))).status).toBe(500);
    h.registry.failOnce(SERVER_A, 'dropSponsor');
    h.clock.advance(DAY);
    await h.registry.fireAlarms();
    expect(await hook(h, SERVER_A)).toBe('true');
    h.clock.advance(DAY);
    await h.registry.fireAlarms();
    expect(await hook(h, SERVER_A)).toBe('false');
    expect(h.registry.storeOf(key.endpointId).data.size).toBe(0);
    expect(h.registry.storeOf(key.endpointId).alarm).toBeNull();
  });
});

describe('bramka: rozliczenie przed wpisem', () => {
  it('APNs przy kwocie 1: awaria zapisu licznika nie zostawia wpisu bez rozliczenia; drugi EndpointId 429', async () => {
    const h = await harness({ GATE_KIND: 'apns', REGISTER_MONTHLY_QUOTA: '1' });
    const proof = apnsProof('ab');
    const [first, second] = await Promise.all([appKey(89), appKey(90)]);
    let failing = true;
    h.registry.gateStore.failPut = (key) => {
      if (!failing || !key.startsWith('apns:')) return false;
      failing = false;
      return true;
    };
    expect((await h.call(await signed(first, 'register', { proof }))).status).toBe(500);
    expect((await h.call(await signed(first, 'register', { proof }))).status).toBe(200);
    const response = await h.call(await signed(second, 'register', { proof }));
    expect(response.status).toBe(429);
    expect(await json(response)).toMatchObject({ error: 'quota-exceeded' });
  });

  it('APNs: wpis pada po rozliczeniu, ponowienie kończy bez drugiego naliczenia i bez drugiego pusha', async () => {
    const h = await harness({ GATE_KIND: 'apns', REGISTER_MONTHLY_QUOTA: '1' });
    const key = await appKey(91);
    const proof = apnsProof('cd');
    h.registry.failOnce(key.endpointId, 'admitApp');
    expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(500);
    expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(200);
    expect(h.apple.count('probe')).toBe(1);
    const counters = [...h.registry.gateStore.data].filter(([name]) => name.startsWith('apns:'));
    expect(counters.map(([, times]) => times)).toEqual([[T0]]);
    expect(h.registry.gateStore.data.get(`brake:apns:${day}`)).toBe(1);
  });

  it('DeviceCheck: awaria zapisu hamulca nie daje wpisu bez hamulca; bity Apple zapisane przed awarią kosztują jednostkę', async () => {
    const h = await harness();
    const key = await appKey(92);
    const proof = deviceCheckProof('B');
    let failing = true;
    h.registry.gateStore.failPut = (name) => {
      if (!failing || !name.startsWith('brake:')) return false;
      failing = false;
      return true;
    };
    expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(500);
    expect((await h.call(await signed(key, 'register', { proof }))).status).toBe(200);
    expect(h.registry.gateStore.data.get(`brake:devicecheck:${day}`)).toBe(1);
    expect(bitsCount(h.apple.bits.get(proof.token) ?? null, T0)).toBe(2);
  });
});
