/**
 * Nadajnik push złożony per wysyłka (`notify/sender.ts`): przepustka z kontekstu wołającego → przekaźnik,
 * bez niej → klucz na Macu (przy przekaźniku tylko `development`), bez obu → brak próby `pass-missing`; status
 * tokenu z drogi jego wpisu.
 * Bez sieci: przekaźnik i nadajnik bezpośredni to atrapy, a prawdziwy nadajnik bezpośredni nie łączy się,
 * dopóki nikt nie wyśle.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApnsEnvironment } from '@rarog/shared/rest';
import type { ApnsResult, ApnsSender, ApnsSenderOptions } from '../src/notify/apns.ts';
import type { ApnsRequest } from '../src/notify/apns-payload.ts';
import type { ApnsDeviceRecord, RelayPass } from '../src/notify/apns-devices.ts';
import type { PassTarget } from '../src/notify/relay-pass.ts';
import type { RelayPushInput, RelayPushOutcome } from '../src/notify/relay-sender.ts';
import { NO_ATTEMPT_REASONS, PASS_MISSING, attempted, createSender } from '../src/notify/sender.ts';
import type { SenderDeps } from '../src/notify/sender.ts';

const PEM = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();
const APNS = { privateKey: PEM, keyId: 'ABC123DEFG', teamId: 'TEAM123456', topic: 'ai.rarog.app' };
const ORIGIN = 'https://push.rarog.ai';
const NOW = Date.parse('2026-11-02T10:00:00.000Z');
const TOKEN = 'ab'.repeat(32);
const LA_TOKEN = 'cd'.repeat(40);
const REQUEST: ApnsRequest = { headers: { 'apns-push-type': 'alert', 'apns-topic': 'ai.rarog.app' }, body: '{"aps":{}}' };

const pass = (over: Partial<RelayPass> = {}): RelayPass => ({
  pass: 'v1.k1.development.alert.0123456789abcdef.1801389600.sig', expiresAt: '2027-01-31T10:00:00.000Z',
  origin: ORIGIN, environment: 'development', topic: 'ai.rarog.app', token: TOKEN, ...over,
});

const record = (over: Partial<ApnsDeviceRecord> = {}): ApnsDeviceRecord => ({
  token: TOKEN, environment: 'development', label: 'iPhone·Rarog', alerts: true,
  createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-02T09:00:00.000Z', lastOkAt: null,
  failures: 0, degradedSince: null, deviceId: 'a'.repeat(32), topic: 'ai.rarog.app', ...over,
});

/** Atrapa nadajnika bezpośredniego z zapisem wysyłek. */
function fakeDirect(disabled: string | null = null): { sender: ApnsSender; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    sender: {
      send: (_env, token) => { sent.push(token); return Promise.resolve({ kind: 'ok' }); },
      disabledSince: () => disabled, close: () => {},
    },
  };
}

/** Atrapa klienta przekaźnika: odpowiedź z kolejki, zapis wejść. */
function fakeRelay(reply: RelayPushOutcome = { result: { kind: 'ok' } }, unavailable: string | null = null): {
  relay: NonNullable<SenderDeps['relay']>; pushed: RelayPushInput[];
} {
  const pushed: RelayPushInput[] = [];
  return {
    pushed,
    relay: {
      origin: ORIGIN,
      push: (input) => { pushed.push(input); return Promise.resolve(reply); },
      unavailableSince: () => unavailable,
    },
  };
}

/** Atrapa przepustek: zapis odnowień i unieważnień, stan „w toku” i „od kiedy brak”. */
type Passes = NonNullable<ReturnType<NonNullable<SenderDeps['passes']>>>;

function fakePasses(state: { pending?: boolean; since?: string | null } = {}): {
  passes: Passes; renewed: PassTarget[]; invalid: PassTarget[]; waited: string[];
} {
  const renewed: PassTarget[] = [];
  const invalid: PassTarget[] = [];
  const waited: string[] = [];
  return {
    renewed, invalid, waited,
    passes: {
      pending: () => state.pending === true,
      missingSince: () => state.since ?? null,
      renewed: (target) => { renewed.push(target); },
      invalid: (target) => { invalid.push(target); },
      waitForDevicePass: (token) => { waited.push(token); return Promise.resolve(); },
      waitPending: (token) => { waited.push(`pending:${token}`); return Promise.resolve(); },
    },
  };
}

const devicesOf = (...records: ApnsDeviceRecord[]): SenderDeps['devices'] => {
  const map = new Map(records.map((r) => [r.token, r]));
  return { get: (token) => map.get(token.toLowerCase()) };
};

describe('createSender — fabryka', () => {
  it('składa nadajnik bezpośredni z klucza, `kid` i `iss` konfiguracji oraz logu z zależności', async () => {
    const seen: ApnsSenderOptions[] = [];
    const direct = fakeDirect();
    const log = (): void => {};
    const sender = createSender({ apns: APNS }, {
      log, devices: devicesOf(), direct: (options) => { seen.push(options); return direct.sender; },
    });
    expect(seen).toEqual([{ privateKey: PEM, keyId: 'ABC123DEFG', teamId: 'TEAM123456', log }]);
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    expect(direct.sent).toEqual([TOKEN]);
  });

  it('domyślnie prawdziwy nadajnik APNs: zamknięcie bez połączeń, status bez degradacji', () => {
    const sender = createSender({ apns: APNS }, { log: () => {}, devices: devicesOf() });
    expect(sender.statusOf(record())).toEqual({ degradedSince: null });
    expect(() => { sender.close(); }).not.toThrow();
  });
});

describe('createSender — droga per wysyłka', () => {
  it('przepustka z kontekstu → przekaźnik z gotowym żądaniem, nawet gdy jest klucz', async () => {
    const direct = fakeDirect();
    const { relay, pushed } = fakeRelay();
    const sender = createSender({ apns: APNS }, { log: () => {}, devices: devicesOf(), relay, direct: () => direct.sender });
    const result = await sender.send('development', TOKEN.toUpperCase(), REQUEST, { topic: 'ai.rarog.app', pass: pass() });
    expect(result).toEqual({ kind: 'ok' });
    expect(pushed).toEqual([{ pass: pass().pass, token: TOKEN, environment: 'development', request: REQUEST }]);
    expect(direct.sent).toEqual([]);
  });

  it('bez przepustki: klucz, gdy jest; bez klucza brak próby `pass-missing`', async () => {
    const direct = fakeDirect();
    const { relay, pushed } = fakeRelay();
    const withKey = createSender({ apns: APNS }, { log: () => {}, devices: devicesOf(), relay, direct: () => direct.sender });
    expect(await withKey.send('development', TOKEN, REQUEST, { topic: 'ai.rarog.app' })).toEqual({ kind: 'ok' });
    expect(direct.sent).toEqual([TOKEN]);
    const relayOnly = createSender({}, { log: () => {}, devices: devicesOf(), relay });
    expect(await relayOnly.send('development', TOKEN, REQUEST, { topic: 'ai.rarog.app' })).toEqual(PASS_MISSING);
    expect(pushed).toEqual([]);
  });

  it.each<[string, Partial<RelayPass>, ApnsEnvironment]>([
    ['inny przekaźnik (zmiana adresu)', { origin: 'https://relay.example.net' }, 'development'],
    ['inne środowisko', {}, 'production'],
    ['inny temat', { topic: 'pl.useo.rarog' }, 'development'],
    ['inny token', { token: 'ef'.repeat(32) }, 'development'],
    ['po terminie', { expiresAt: '2026-11-02T09:59:59.000Z' }, 'development'],
  ])('przepustka, która nie pasuje (%s), to brak przepustki', async (_name, over, environment) => {
    const { relay, pushed } = fakeRelay();
    const sender = createSender({}, { log: () => {}, devices: devicesOf(), relay, now: () => NOW });
    expect(await sender.send(environment, TOKEN, REQUEST, { topic: 'ai.rarog.app', pass: pass(over) })).toEqual(PASS_MISSING);
    expect(pushed).toEqual([]);
  });

  it('wysyłka bez tematu w kontekście NIGDY nie idzie przekaźnikiem, nawet z przepustką', async () => {
    const direct = fakeDirect();
    const { relay, pushed } = fakeRelay();
    const sender = createSender({ apns: APNS }, { log: () => {}, devices: devicesOf(), relay, direct: () => direct.sender, now: () => NOW });
    expect(await sender.send('development', TOKEN, REQUEST, { pass: pass() })).toEqual({ kind: 'ok' });
    expect(pushed).toEqual([]);
    expect(direct.sent).toEqual([TOKEN]);
    const relayOnly = createSender({}, { log: () => {}, devices: devicesOf(), relay, now: () => NOW });
    expect(await relayOnly.send('development', TOKEN, REQUEST, { pass: pass() })).toEqual(PASS_MISSING);
  });

  it('bez przekaźnika (puste `RAROG_PUSH_RELAY_URL`) przepustki leżą martwe: wszystko kluczem', async () => {
    const direct = fakeDirect();
    const sender = createSender({ apns: APNS }, { log: () => {}, devices: devicesOf(), direct: () => direct.sender, now: () => NOW });
    expect(await sender.send('development', TOKEN, REQUEST, { topic: 'ai.rarog.app', pass: pass() })).toEqual({ kind: 'ok' });
    expect(direct.sent).toEqual([TOKEN]);
    expect(sender.routeOf(record({ relayPass: pass() }))).toBe('direct');
  });

  it('`renewedPass` i `401` idą do przepustek z celem TEJ wysyłki (urządzenie i aktywność)', async () => {
    const renewedPass = { pass: 'v1.k1.nowa', expiresAt: '2027-02-01T10:00:00.000Z' };
    const f = fakePasses();
    const renewing = fakeRelay({ result: { kind: 'ok' }, renewedPass });
    const sender = createSender({}, { log: () => {}, devices: devicesOf(), relay: renewing.relay, passes: () => f.passes, now: () => NOW });
    await sender.send('development', TOKEN, REQUEST, { topic: 'ai.rarog.app', pass: pass() });
    expect(f.renewed).toEqual([{ kind: 'device', deviceToken: TOKEN, environment: 'development', topic: 'ai.rarog.app', pass: pass().pass }]);

    const laPass = pass({ token: LA_TOKEN, pass: 'v1.k1.development.liveactivity.x.1.sig' });
    const rejecting = fakeRelay({ result: { kind: 'failed', status: null, reason: 'pass-invalid' }, passInvalid: true });
    const la = createSender({}, { log: () => {}, devices: devicesOf(), relay: rejecting.relay, passes: () => f.passes, now: () => NOW });
    const result = await la.send('development', LA_TOKEN, REQUEST, {
      topic: 'ai.rarog.app', pass: laPass, activity: { deviceToken: TOKEN.toUpperCase(), activityId: 'akt-1' },
    });
    expect(result).toEqual({ kind: 'failed', status: null, reason: 'pass-invalid' });
    expect(f.invalid).toEqual([{
      kind: 'activity', deviceToken: TOKEN, activityId: 'akt-1', updateToken: LA_TOKEN, environment: 'development',
      topic: 'ai.rarog.app', pass: laPass.pass,
    }]);
  });

  it('`pass-missing` i `pass-invalid` to porażki BEZ próby (licznik tokenu ich nie widzi)', () => {
    expect([...NO_ATTEMPT_REASONS].sort()).toEqual(['disabled', 'pass-invalid', 'pass-missing', 'paused']);
    expect(attempted(PASS_MISSING)).toBe(false);
    expect(attempted({ kind: 'failed', status: null, reason: 'pass-invalid' })).toBe(false);
    expect(attempted({ kind: 'failed', status: 429, reason: 'relay-limited' })).toBe(true);
    expect(attempted({ kind: 'failed', status: null, reason: 'timeout' })).toBe(true);
    const ok: ApnsResult = { kind: 'ok' };
    expect(attempted(ok)).toBe(true);
  });
});

describe('createSender — status tokenu z drogi wpisu', () => {
  it('droga przekaźnika: degradacja z wyłączenia środowiska PRZEKAŹNIKA, nie klucza', () => {
    const { relay } = fakeRelay(undefined, '2026-11-02T09:30:00.000Z');
    const sender = createSender({ apns: APNS }, {
      log: () => {}, devices: devicesOf(), relay, direct: () => fakeDirect('2026-11-01T00:00:00.000Z').sender, now: () => NOW,
    });
    expect(sender.routeOf(record({ relayPass: pass() }))).toBe('relay');
    expect(sender.statusOf(record({ relayPass: pass() }))).toEqual({ degradedSince: '2026-11-02T09:30:00.000Z' });
    // Wpis bez przepustki idzie kluczem — jego degradacja to wyłączenie środowiska klucza.
    expect(sender.statusOf(record())).toEqual({ degradedSince: '2026-11-01T00:00:00.000Z' });
  });

  it('wpis bez drogi: `pass-missing` od pierwszej porażki zamówienia (albo od założenia wpisu); w toku — bez przyczyny', () => {
    const { relay } = fakeRelay();
    const failing = fakePasses({ since: '2026-11-02T09:45:00.000Z' });
    const sender = createSender({}, { log: () => {}, devices: devicesOf(), relay, passes: () => failing.passes, now: () => NOW });
    expect(sender.routeOf(record())).toBe('none');
    expect(sender.statusOf(record())).toEqual({ degradedSince: '2026-11-02T09:45:00.000Z', degradedReason: 'pass-missing' });
    // Bez porażki zamówienia na koncie: od założenia wpisu.
    const unordered = createSender({}, { log: () => {}, devices: devicesOf(), relay, passes: () => fakePasses().passes, now: () => NOW });
    expect(unordered.statusOf(record())).toEqual({ degradedSince: '2026-11-01T08:00:00.000Z', degradedReason: 'pass-missing' });
    const pending = createSender({}, { log: () => {}, devices: devicesOf(), relay, passes: () => fakePasses({ pending: true }).passes, now: () => NOW });
    expect(pending.statusOf(record())).toEqual({ degradedSince: null });
    // Trzy porażki z rzędu wygrywają z chwilą braku drogi.
    expect(sender.statusOf(record({ degradedSince: '2026-11-02T08:00:00.000Z' })))
      .toEqual({ degradedSince: '2026-11-02T08:00:00.000Z', degradedReason: 'pass-missing' });
  });

  it('`env-mismatch` TEGO przekaźnika i środowiska wpisu — z chwilą odmowy; inny origin albo środowisko to nie odmowa', () => {
    const { relay } = fakeRelay();
    const sender = createSender({}, { log: () => {}, devices: devicesOf(), relay, passes: () => fakePasses().passes, now: () => NOW });
    const mismatch = { since: '2026-11-02T09:50:00.000Z', origin: ORIGIN, environment: 'development' as const };
    expect(sender.statusOf(record({ relayMismatch: mismatch })))
      .toEqual({ degradedSince: '2026-11-02T09:50:00.000Z', degradedReason: 'env-mismatch' });
    expect(sender.statusOf(record({ relayMismatch: { ...mismatch, origin: 'https://relay.example.net' } })).degradedReason)
      .toBe('pass-missing');
    expect(sender.statusOf(record({ relayMismatch: { ...mismatch, environment: 'production' } })).degradedReason)
      .toBe('pass-missing');
  });

  it('push próbny: wpis bez drogi czeka na przepustkę, potem oddaje drogę; wpis z drogą — od razu', async () => {
    const { relay } = fakeRelay();
    let current = record();
    const devices: SenderDeps['devices'] = { get: () => current };
    const f = fakePasses();
    f.passes.waitForDevicePass = (token) => {
      f.waited.push(token);
      current = record({ relayPass: pass() });
      return Promise.resolve();
    };
    const sender = createSender({}, { log: () => {}, devices, relay, passes: () => f.passes, now: () => NOW });
    expect(await sender.awaitRoute(TOKEN, 10_000)).toBe('relay');
    expect(f.waited).toEqual([TOKEN]);
    expect(await sender.awaitRoute(TOKEN, 10_000)).toBe('relay');
    expect(f.waited).toHaveLength(1);
    const unknown = createSender({}, { log: () => {}, devices: devicesOf(), relay, passes: () => f.passes });
    expect(await unknown.awaitRoute(TOKEN, 10_000)).toBe('none');
  });

  it('status: czeka wyłącznie na zamówienie w toku (bez zamawiania); bez przekaźnika — od razu', async () => {
    const { relay } = fakeRelay();
    const f = fakePasses();
    const sender = createSender({}, { log: () => {}, devices: devicesOf(record()), relay, passes: () => f.passes });
    await sender.awaitPending(TOKEN, 5_000);
    expect(f.waited).toEqual([`pending:${TOKEN}`]);
    const keyOnly = createSender({ apns: APNS }, { log: () => {}, devices: devicesOf(record()), direct: () => fakeDirect().sender });
    await expect(keyOnly.awaitPending(TOKEN, 5_000)).resolves.toBeUndefined();
  });
});

describe('createSender — wpis `production` tylko przekaźnikiem', () => {
  const PROD = 'production' as const;
  const prodPass = (over: Partial<RelayPass> = {}): RelayPass =>
    pass({ pass: 'v1.k1.production.alert.0123456789abcdef.1801389600.sig', environment: PROD, ...over });
  const laRequest = (event: 'update' | 'end'): ApnsRequest => ({
    headers: { 'apns-push-type': 'liveactivity', 'apns-topic': 'ai.rarog.app.push-type.liveactivity' },
    body: JSON.stringify({ aps: { event, timestamp: 1 } }),
  });

  it('baner: `production` bez przepustki przy kluczu i przekaźniku nie woła klucza — `pass-missing`, droga `none`', async () => {
    const direct = fakeDirect();
    const { relay, pushed } = fakeRelay();
    const f = fakePasses({ since: '2026-11-02T09:45:00.000Z' });
    const sender = createSender({ apns: APNS }, {
      log: () => {}, devices: devicesOf(), relay, passes: () => f.passes, direct: () => direct.sender, now: () => NOW,
    });
    expect(await sender.send(PROD, TOKEN, REQUEST, { topic: 'ai.rarog.app' })).toEqual(PASS_MISSING);
    // Przepustka innego środowiska to brak przepustki — też bez klucza.
    expect(await sender.send(PROD, TOKEN, REQUEST, { topic: 'ai.rarog.app', pass: pass() })).toEqual(PASS_MISSING);
    // Wysyłka bez kontekstu (bez tematu) przy przekaźniku: `production` nie ma drogi.
    expect(await sender.send(PROD, TOKEN, REQUEST)).toEqual(PASS_MISSING);
    expect(direct.sent).toEqual([]);
    expect(pushed).toEqual([]);
    expect(sender.routeOf(record({ environment: PROD }))).toBe('none');
    expect(sender.statusOf(record({ environment: PROD })))
      .toEqual({ degradedSince: '2026-11-02T09:45:00.000Z', degradedReason: 'pass-missing' });
    // Zamówienie w toku: status oczekiwania, bez przyczyny.
    const pending = createSender({ apns: APNS }, {
      log: () => {}, devices: devicesOf(), relay, passes: () => fakePasses({ pending: true }).passes,
      direct: () => direct.sender, now: () => NOW,
    });
    expect(pending.statusOf(record({ environment: PROD }))).toEqual({ degradedSince: null });
  });

  it('baner: `production` z ważną przepustką → przekaźnik; klucz nietknięty', async () => {
    const direct = fakeDirect();
    const { relay, pushed } = fakeRelay();
    const sender = createSender({ apns: APNS }, {
      log: () => {}, devices: devicesOf(), relay, direct: () => direct.sender, now: () => NOW,
    });
    expect(await sender.send(PROD, TOKEN, REQUEST, { topic: 'ai.rarog.app', pass: prodPass() })).toEqual({ kind: 'ok' });
    expect(pushed.map((p) => p.environment)).toEqual([PROD]);
    expect(direct.sent).toEqual([]);
    expect(sender.routeOf(record({ environment: PROD, relayPass: prodPass() }))).toBe('relay');
  });

  it('push próbny `production` bez przepustki czeka na zamówienie, zamiast od razu iść kluczem', async () => {
    const direct = fakeDirect();
    const { relay } = fakeRelay();
    let current = record({ environment: PROD });
    const f = fakePasses();
    f.passes.waitForDevicePass = (token) => {
      f.waited.push(token);
      current = record({ environment: PROD, relayPass: prodPass() });
      return Promise.resolve();
    };
    const sender = createSender({ apns: APNS }, {
      log: () => {}, devices: { get: () => current }, relay, passes: () => f.passes, direct: () => direct.sender, now: () => NOW,
    });
    expect(await sender.awaitRoute(TOKEN, 10_000)).toBe('relay');
    expect(f.waited).toEqual([TOKEN]);
    // Bez przepustki po czekaniu: `none` (push próbny kończy się `pass-missing`), nigdy `direct`.
    const never = fakePasses();
    const stuck = createSender({ apns: APNS }, {
      log: () => {}, devices: devicesOf(record({ environment: PROD })), relay, passes: () => never.passes,
      direct: () => direct.sender, now: () => NOW,
    });
    expect(await stuck.awaitRoute(TOKEN, 10_000)).toBe('none');
    expect(never.waited).toEqual([TOKEN]);
    expect(direct.sent).toEqual([]);
  });

  it.each<[string, RelayPass | undefined]>([
    ['bez przepustki kafla', undefined],
    ['z wygasłą przepustką kafla', prodPass({ token: LA_TOKEN, expiresAt: '2026-11-02T09:59:59.000Z' })],
    ['z przepustką kafla innego środowiska', pass({ token: LA_TOKEN })],
  ])('kafel `production` z ważną przepustką urządzenia, ale %s: aktualizacja i koniec nie idą kluczem', async (_n, la) => {
    const direct = fakeDirect();
    const { relay, pushed } = fakeRelay();
    const sender = createSender({ apns: APNS }, {
      log: () => {}, devices: devicesOf(record({ environment: PROD, relayPass: prodPass() })), relay,
      passes: () => fakePasses().passes, direct: () => direct.sender, now: () => NOW,
    });
    const context = {
      topic: 'ai.rarog.app', ...(la === undefined ? {} : { pass: la }),
      activity: { deviceToken: TOKEN, activityId: 'akt-1' },
    };
    expect(await sender.send(PROD, LA_TOKEN, laRequest('update'), context)).toEqual(PASS_MISSING);
    expect(await sender.send(PROD, LA_TOKEN, laRequest('end'), context)).toEqual(PASS_MISSING);
    expect(direct.sent).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it('kafel `production` z ważną przepustką kafla → przekaźnik', async () => {
    const direct = fakeDirect();
    const { relay, pushed } = fakeRelay();
    const sender = createSender({ apns: APNS }, { log: () => {}, devices: devicesOf(), relay, direct: () => direct.sender, now: () => NOW });
    const laPass = prodPass({ token: LA_TOKEN, pass: 'v1.k1.production.liveactivity.x.1.sig' });
    expect(await sender.send(PROD, LA_TOKEN, laRequest('update'), {
      topic: 'ai.rarog.app', pass: laPass, activity: { deviceToken: TOKEN, activityId: 'akt-1' },
    })).toEqual({ kind: 'ok' });
    expect(pushed.map((p) => [p.environment, p.token])).toEqual([[PROD, LA_TOKEN]]);
    expect(direct.sent).toEqual([]);
  });

  it('`development` bez przepustki przy przekaźniku dalej idzie kluczem (baner i kafel)', async () => {
    const direct = fakeDirect();
    const { relay, pushed } = fakeRelay();
    const sender = createSender({ apns: APNS }, { log: () => {}, devices: devicesOf(), relay, direct: () => direct.sender, now: () => NOW });
    expect(await sender.send('development', TOKEN, REQUEST, { topic: 'ai.rarog.app' })).toEqual({ kind: 'ok' });
    expect(await sender.send('development', LA_TOKEN, laRequest('update'), {
      topic: 'ai.rarog.app', activity: { deviceToken: TOKEN, activityId: 'akt-1' },
    })).toEqual({ kind: 'ok' });
    expect(direct.sent).toEqual([TOKEN, LA_TOKEN]);
    expect(pushed).toEqual([]);
    expect(sender.routeOf(record())).toBe('direct');
  });

  it('serwer bez przekaźnika: `production` bezpośrednio kluczem (baner i kafel)', async () => {
    const direct = fakeDirect();
    const sender = createSender({ apns: APNS }, { log: () => {}, devices: devicesOf(), direct: () => direct.sender, now: () => NOW });
    expect(await sender.send(PROD, TOKEN, REQUEST, { topic: 'ai.rarog.app' })).toEqual({ kind: 'ok' });
    expect(await sender.send(PROD, LA_TOKEN, laRequest('end'), {
      topic: 'ai.rarog.app', activity: { deviceToken: TOKEN, activityId: 'akt-1' },
    })).toEqual({ kind: 'ok' });
    expect(direct.sent).toEqual([TOKEN, LA_TOKEN]);
    expect(sender.routeOf(record({ environment: PROD }))).toBe('direct');
  });
});
