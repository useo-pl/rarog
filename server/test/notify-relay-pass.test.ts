/**
 * Przepustki przekaźnika push (`notify/relay-pass.ts`): kto dostaje zamówienie, jedno w locie na token,
 * kolejka po kolei, odczekanie per token i wspólne, zapis warunkowy (spóźnione odpowiedzi), `401`, `422`
 * (`env-mismatch` albo martwy token), odnowienie, zmiana przekaźnika, start serwera, czekanie pushu próbnego i log.
 * Rejestr prawdziwy (katalog tymczasowy), klient przekaźnika i zegar — atrapy.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApnsDeviceStore, RelayPass } from '../src/notify/apns-devices.ts';
import { createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import {
  RELAY_PASS_LIMITED_MS, RELAY_PASS_RENEW_BEFORE_MS, RELAY_PASS_RETRY_MS, RELAY_PASS_SWEEP_MS, createRelayPasses,
  usablePass,
} from '../src/notify/relay-pass.ts';
import type { RelayPasses } from '../src/notify/relay-pass.ts';
import type { RelayPassInput, RelayPassOutcome } from '../src/notify/relay-sender.ts';

const ORIGIN = 'https://push.rarog.ai';
const TOPIC = 'ai.rarog.app';
const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const TOKEN = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);
const LA = 'c3'.repeat(40);
const LA2 = 'd4'.repeat(40);

let dir = '';
let devices: ApnsDeviceStore;
let clock = T0;
let log: string[] = [];
let passes: RelayPasses | undefined;

/** Ręczne timery: `advance` odpala te, których czas minął, w kolejności terminów. */
const timers = new Map<number, { at: number; cb: () => void }>();
let timerSeq = 0;
const setTimer = (cb: () => void, ms: number): unknown => {
  timerSeq += 1;
  timers.set(timerSeq, { at: clock + ms, cb });
  return timerSeq;
};
const clearTimer = (handle: unknown): void => { timers.delete(handle as number); };
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};
async function advance(ms: number): Promise<void> {
  const until = clock + ms;
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort(([, a], [, b]) => a.at - b.at)[0];
    if (due === undefined) break;
    timers.delete(due[0]);
    clock = Math.max(clock, due[1].at);
    due[1].cb();
    await settle();
  }
  clock = until;
  await settle();
}

/** Atrapa klienta: odpowiedź z funkcji `reply` (domyślnie wydana przepustka) albo trzymana do `release`. */
interface FakeClient {
  readonly calls: RelayPassInput[];
  reply: (input: RelayPassInput) => RelayPassOutcome | Promise<RelayPassOutcome>;
  paused: number;
}
let client: FakeClient;

const issued = (input: RelayPassInput, days = 90): RelayPassOutcome => ({
  kind: 'issued',
  pass: { pass: `v1.k1.${input.environment}.${input.type}.${input.token.slice(0, 4)}.${String(clock)}.sig`,
    expiresAt: new Date(clock + days * DAY).toISOString() },
});

function start(overrides: { origin?: string } = {}): RelayPasses {
  passes = createRelayPasses({
    devices,
    client: {
      origin: overrides.origin ?? ORIGIN,
      requestPass: (input) => { client.calls.push(input); return Promise.resolve(client.reply(input)); },
      pausedUntil: () => (client.paused > clock ? client.paused : 0),
    },
    now: () => clock, setTimeout: setTimer, clearTimeout: clearTimer, log: (line) => { log.push(line); },
    onPass: (token) => { log.push(`onPass ${token === TOKEN ? 'TOKEN' : 'inny'}`); },
  });
  return passes;
}

/** Wpis z własnym urządzeniem na token (pierwsze 32 znaki): jeden wpis na urządzenie i temat. */
const register = (token = TOKEN, extra: { topic?: string; environment?: 'development' | 'production' } = {}): void => {
  devices.upsert({
    token, environment: extra.environment ?? 'development', label: 'iPhone·Rarog', alerts: true,
    deviceId: token.slice(0, 32), topic: extra.topic ?? TOPIC,
  });
};

const binding = (token = TOKEN): { origin: string; environment: 'development'; topic: string; token: string } =>
  ({ origin: ORIGIN, environment: 'development', topic: TOPIC, token });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarog-relay-pass-'));
  clock = T0;
  log = [];
  timers.clear();
  devices = createApnsDeviceStore({ dataDir: dir, now: () => clock });
  client = { calls: [], reply: (input) => issued(input), paused: 0 };
  passes = undefined;
});

afterEach(async () => {
  passes?.close();
  await devices.flush();
  await rm(dir, { recursive: true, force: true });
  // Log NIGDY nie niesie tokenu ani przepustki.
  const text = log.join('\n');
  for (const secret of [TOKEN, OTHER, LA, LA2]) expect(text).not.toContain(secret.slice(0, 12));
  expect(text).not.toMatch(/v1\.k1\./);
});

describe('przepustki: kto i kiedy', () => {
  it('wpis apki przekaźnika: jedno zamówienie `alert`, przepustka związana z originem, środowiskiem, tematem i tokenem', async () => {
    register();
    const p = start();
    p.ensure(TOKEN.toUpperCase());
    await settle();
    expect(client.calls).toEqual([{ token: TOKEN, environment: 'development', type: 'alert', topic: TOPIC }]);
    const stored = devices.get(TOKEN)?.relayPass;
    expect(stored).toMatchObject({ origin: ORIGIN, environment: 'development', topic: TOPIC, token: TOKEN });
    expect(usablePass(stored, binding(), clock)).toBe(true);
    expect(log).toContain('push: relay pass issued (device, development)');
    // Ważna przepustka: kolejne `ensure` nic nie zamawia.
    p.ensure(TOKEN);
    await settle();
    expect(client.calls).toHaveLength(1);
  });

  it('obcy temat NIGDY nie dostaje przepustki', async () => {
    register(OTHER, { topic: 'pl.useo.rarog' });
    const p = start();
    p.start();
    p.ensure(OTHER);
    await settle();
    expect(client.calls).toEqual([]);
  });

  it('jedno zamówienie w locie na token: powtórzone `ensure` w trakcie nie zamawia drugi raz', async () => {
    register();
    let release: (o: RelayPassOutcome) => void = () => {};
    client.reply = () => new Promise((resolve) => { release = resolve; });
    const p = start();
    p.ensure(TOKEN);
    p.ensure(TOKEN);
    await settle();
    p.ensure(TOKEN);
    expect(client.calls).toHaveLength(1);
    expect(p.pending(TOKEN)).toBe(true);
    release(issued(client.calls[0] as RelayPassInput));
    await settle();
    expect(p.pending(TOKEN)).toBe(false);
    expect(client.calls).toHaveLength(1);
  });

  it('zamówienia idą po kolei (limit per adres): drugi token czeka, aż pierwsze się rozstrzygnie', async () => {
    register(TOKEN);
    register(OTHER);
    let release: (o: RelayPassOutcome) => void = () => {};
    client.reply = (input) => (input.token === TOKEN ? new Promise((resolve) => { release = resolve; }) : issued(input));
    const p = start();
    p.ensure(TOKEN);
    p.ensure(OTHER);
    await settle();
    expect(client.calls.map((c) => c.token)).toEqual([TOKEN]);
    expect(p.pending(OTHER)).toBe(true);
    release(issued(client.calls[0] as RelayPassInput));
    await settle();
    expect(client.calls.map((c) => c.token)).toEqual([TOKEN, OTHER]);
  });

  it('start serwera: zamówienie dla wpisów bez przepustki, potem przegląd co godzinę (odnowienie milczących)', async () => {
    register(TOKEN);
    register(OTHER);
    const p = start();
    p.start();
    await settle();
    expect(client.calls.map((c) => c.token).sort()).toEqual([TOKEN, OTHER].sort());
    // 84 dni później zostaje < 7 dni: przegląd odnawia oba bez żadnej wysyłki.
    clock += 84 * DAY - RELAY_PASS_SWEEP_MS;
    await advance(RELAY_PASS_SWEEP_MS);
    expect(client.calls).toHaveLength(4);
  });

  it('odnowienie: < 7 dni do terminu → nowe zamówienie; więcej → nic', async () => {
    register();
    devices.setRelayPass({
      pass: 'v1.k1.stara', expiresAt: new Date(clock + RELAY_PASS_RENEW_BEFORE_MS + DAY).toISOString(),
      origin: ORIGIN, environment: 'development', topic: TOPIC, token: TOKEN,
    });
    const p = start();
    p.ensure(TOKEN);
    await settle();
    expect(client.calls).toEqual([]);
    clock += 2 * DAY;
    p.ensure(TOKEN);
    await settle();
    expect(client.calls).toHaveLength(1);
    expect(devices.get(TOKEN)?.relayPass?.pass).not.toBe('v1.k1.stara');
  });

  it('zmiana adresu przekaźnika: przepustka innego originu to brak przepustki — nowe zamówienie', async () => {
    register();
    devices.setRelayPass({
      pass: 'v1.k1.stary-adres', expiresAt: new Date(clock + 80 * DAY).toISOString(),
      origin: ORIGIN, environment: 'development', topic: TOPIC, token: TOKEN,
    });
    const p = start({ origin: 'https://relay.example.net' });
    p.ensure(TOKEN);
    await settle();
    expect(client.calls).toHaveLength(1);
    expect(devices.get(TOKEN)?.relayPass?.origin).toBe('https://relay.example.net');
  });
});

describe('przepustki: aktywność', () => {
  it('po przepustce urządzenia — przepustka aktywności za `devicePass`, zapis w bloku', async () => {
    register();
    devices.setLiveActivity(TOKEN, { activityId: 'akt-1', updateToken: LA });
    const p = start();
    p.ensure(TOKEN);
    await settle();
    const devicePass = devices.get(TOKEN)?.relayPass?.pass;
    expect(client.calls).toEqual([
      { token: TOKEN, environment: 'development', type: 'alert', topic: TOPIC },
      { token: LA, environment: 'development', type: 'liveactivity', topic: TOPIC, devicePass },
    ]);
    expect(devices.get(TOKEN)?.liveActivity?.relayPass).toMatchObject({ token: LA, origin: ORIGIN });
    expect(log.filter((l) => l.startsWith('onPass'))).toEqual(['onPass TOKEN', 'onPass TOKEN']);
  });

  it('rotacja tokenu aktywności w trakcie zamówienia: spóźniona przepustka nie trafia do bloku; nowa się zamawia', async () => {
    register();
    devices.setRelayPass({
      pass: 'v1.k1.urz', expiresAt: new Date(clock + 80 * DAY).toISOString(),
      origin: ORIGIN, environment: 'development', topic: TOPIC, token: TOKEN,
    });
    devices.setLiveActivity(TOKEN, { activityId: 'akt-1', updateToken: LA });
    let release: (o: RelayPassOutcome) => void = () => {};
    client.reply = (input) => (input.token === LA ? new Promise((resolve) => { release = resolve; }) : issued(input));
    const p = start();
    p.ensure(TOKEN);
    await settle();
    expect(devices.setLiveActivity(TOKEN, { activityId: 'akt-1', updateToken: LA2 })).toBe('rotated');
    release(issued(client.calls[0] as RelayPassInput));
    await settle();
    expect(log).toContain('push: activity pass after an activity change during the request — skipped');
    expect(devices.get(TOKEN)?.liveActivity?.relayPass).toBeUndefined();
    // Przepustka dla nowego tokenu zamawia się sama, po odczekaniu.
    await advance(RELAY_PASS_RETRY_MS[0] ?? 0);
    expect(client.calls.map((c) => c.token)).toEqual([LA, LA2]);
    expect(devices.get(TOKEN)?.liveActivity?.relayPass?.token).toBe(LA2);
  });

  it('`401` na `devicePass`: przepustka urządzenia zdjęta, nowe zamówienie po odczekaniu, potem aktywność', async () => {
    register();
    devices.setRelayPass({
      pass: 'v1.k1.zla', expiresAt: new Date(clock + 80 * DAY).toISOString(),
      origin: ORIGIN, environment: 'development', topic: TOPIC, token: TOKEN,
    });
    devices.setLiveActivity(TOKEN, { activityId: 'akt-1', updateToken: LA });
    client.reply = (input) => (input.type === 'liveactivity' && input.devicePass === 'v1.k1.zla'
      ? { kind: 'pass-invalid' } : issued(input));
    const p = start();
    p.ensure(TOKEN);
    await settle();
    expect(devices.get(TOKEN)?.relayPass).toBeUndefined();
    expect(client.calls).toHaveLength(1);
    await advance(RELAY_PASS_RETRY_MS[0] ?? 0);
    expect(client.calls.map((c) => c.type)).toEqual(['liveactivity', 'alert', 'liveactivity']);
    expect(devices.get(TOKEN)?.liveActivity?.relayPass).toBeDefined();
  });
});

describe('przepustki: `401` kafla z `/v1/push` (migracja formatu kafla i rollback)', () => {
  it('zdejmuje TYLKO przepustkę kafla; po 30 s nowe zamówienie kafla za tą samą przepustką urządzenia', async () => {
    register();
    devices.setLiveActivity(TOKEN, { activityId: 'akt-1', updateToken: LA });
    const p = start();
    p.ensure(TOKEN);
    await settle();
    const device = devices.get(TOKEN)?.relayPass as RelayPass;
    const tile = devices.get(TOKEN)?.liveActivity?.relayPass as RelayPass;
    expect(client.calls.map((c) => c.type)).toEqual(['alert', 'liveactivity']);
    // Przekaźnik po wdrożeniu (albo po rollbacku) nie zna formatu tej przepustki kafla: `401` z `/v1/push`.
    p.invalid({
      kind: 'activity', deviceToken: TOKEN, activityId: 'akt-1', updateToken: LA, environment: 'development',
      topic: TOPIC, pass: tile.pass,
    });
    expect(devices.get(TOKEN)?.liveActivity?.relayPass).toBeUndefined();
    expect(devices.get(TOKEN)?.liveActivity?.updateToken).toBe(LA);
    expect(devices.get(TOKEN)?.relayPass).toEqual(device);
    await advance((RELAY_PASS_RETRY_MS[0] ?? 0) - 1);
    expect(client.calls).toHaveLength(2);
    await advance(1);
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2]).toEqual({
      token: LA, environment: 'development', type: 'liveactivity', topic: TOPIC, devicePass: device.pass,
    });
    expect(devices.get(TOKEN)?.liveActivity?.relayPass?.token).toBe(LA);
    expect(devices.get(TOKEN)?.relayPass).toEqual(device);
  });
});

describe('przepustki: kafel z terminem rodzica przy przepustce urządzenia < 7 dni', () => {
  /**
   * Przekaźnik wydaje kafel najwyżej do terminu przepustki urządzenia i nie odnawia go w `/v1/push`. Atrapa przekaźnika
   * liczy termin kafla tą samą regułą (`exp` rodzica z `devicePass` żądania). Serwer zamawia kafel dopiero za ŚWIEŻĄ
   * przepustką urządzenia; przy nieświeżej tylko kafel bez żadnej używalnej przepustki, raz.
   */
  const TWO_HOURS = 2 * 60 * 60_000;
  const passExp = new Map<string, number>();
  let alertOk: () => boolean = () => true;
  let alertCalls = 0;
  let tileAtS: number[] = [];

  beforeEach(() => {
    passExp.clear();
    alertOk = () => true;
    alertCalls = 0;
    tileAtS = [];
    client.reply = (input) => {
      if (input.type === 'alert') {
        alertCalls += 1;
        if (!alertOk()) return { kind: 'failed', status: 502, reason: 'apns-error' };
        const pass = `p${String(alertCalls)}`;
        passExp.set(pass, clock + 90 * DAY);
        return { kind: 'issued', pass: { pass, expiresAt: new Date(clock + 90 * DAY).toISOString() } };
      }
      tileAtS.push((clock - T0) / 1000);
      const parent = passExp.get(input.devicePass ?? '') ?? 0;
      return { kind: 'issued', pass: {
        pass: `la${String(tileAtS.length)}`, expiresAt: new Date(Math.min(clock + 90 * DAY, parent)).toISOString(),
      } };
    };
  });

  /** Wpis z przepustką urządzenia `p0` na `deviceDays` i kaflem (z przepustką na `tileDays` albo bez niej). */
  const seed = (deviceDays: number, tileDays?: number): void => {
    register();
    passExp.set('p0', T0 + deviceDays * DAY);
    devices.setRelayPass({
      pass: 'p0', expiresAt: new Date(T0 + deviceDays * DAY).toISOString(),
      origin: ORIGIN, environment: 'development', topic: TOPIC, token: TOKEN,
    });
    devices.setLiveActivity(TOKEN, { activityId: 'akt-1', updateToken: LA });
    if (tileDays !== undefined) {
      devices.setActivityRelayPass(TOKEN, 'akt-1', {
        pass: 'la0', expiresAt: new Date(T0 + tileDays * DAY).toISOString(),
        origin: ORIGIN, environment: 'development', topic: TOPIC, token: LA,
      });
    }
  };

  const tileExpiry = (): string | undefined => devices.get(TOKEN)?.liveActivity?.relayPass?.expiresAt;
  const shortTileLog = (): string[] => log.filter((l) => l.includes('(activity) shorter than 7 days'));

  it('urządzenie za 3 dni, odnowienie pada (502), kafel z terminem urządzenia: zero zamówień kafla w 2 h', async () => {
    seed(3, 3);
    alertOk = () => false;
    start().start();
    await settle();
    await advance(TWO_HOURS);
    // Przed poprawką: kafel z tym samym terminem co ~30 s (`shortPass` zaczynał drabinę od nowa), 226 zamówień w 2 h.
    expect(tileAtS).toEqual([]);
    // Urządzenie dalej próbuje na drabinie odczekania: 0, 30 s, 2,5 min, 12,5 min, 72,5 min.
    expect(alertCalls).toBe(5);
    expect(tileExpiry()).toBe(new Date(T0 + 3 * DAY).toISOString());
    expect(shortTileLog()).toEqual([]);
  });

  it('odnowienie urządzenia w końcu się udaje: kafel zamówiony zaraz po nim, z terminem nowej przepustki', async () => {
    seed(3, 3);
    alertOk = () => alertCalls > 2;
    start().start();
    await settle();
    await advance(TWO_HOURS);
    // Dwie porażki urządzenia (0 i 30 s), sukces po 2 min odczekania (150 s) — kafel w tej samej chwili.
    expect(alertCalls).toBe(3);
    expect(tileAtS).toEqual([150]);
    expect(tileExpiry()).toBe(new Date(T0 + 150_000 + 90 * DAY).toISOString());
    expect(client.calls.at(-1)).toEqual({
      token: LA, environment: 'development', type: 'liveactivity', topic: TOPIC, devicePass: 'p3',
    });
  });

  it('odnowienie urządzenia przez `renewedPass` (po 502 z `/v1/pass`): kafel dogania przed swoim terminem', async () => {
    // Obie przepustki wygasają za 2 min; zamówienie urządzenia pada, wysyłka banera po 1 s przynosi nową.
    register();
    passExp.set('p0', T0 + 120_000);
    devices.setRelayPass({
      pass: 'p0', expiresAt: new Date(T0 + 120_000).toISOString(),
      origin: ORIGIN, environment: 'development', topic: TOPIC, token: TOKEN,
    });
    devices.setLiveActivity(TOKEN, { activityId: 'akt-1', updateToken: LA });
    devices.setActivityRelayPass(TOKEN, 'akt-1', {
      pass: 'la0', expiresAt: new Date(T0 + 120_000).toISOString(),
      origin: ORIGIN, environment: 'development', topic: TOPIC, token: LA,
    });
    alertOk = () => false;
    const p = start();
    p.start();
    await settle();
    expect(alertCalls).toBe(1);
    await advance(1_000);
    passExp.set('r1', clock + 90 * DAY);
    p.renewed(
      { kind: 'device', deviceToken: TOKEN, environment: 'development', topic: TOPIC, pass: 'p0' },
      { pass: 'r1', expiresAt: new Date(clock + 90 * DAY).toISOString() },
    );
    await settle();
    // Kafel czeka tylko na wspólne odczekanie kolejki po 502 (30 s), nie na przegląd za godzinę.
    await advance(30_000);
    expect(tileAtS).toEqual([30]);
    expect(client.calls.at(-1)?.devicePass).toBe('r1');
    // Termin kafla = termin nowej przepustki urządzenia (wydanej w 1 s), nie 90 dni od zamówienia kafla.
    expect(tileExpiry()).toBe(new Date(T0 + 1_000 + 90 * DAY).toISOString());
    expect(alertCalls).toBe(1);
  });

  it('kafel BEZ przepustki przy nieświeżym urządzeniu: jedno zamówienie, log bez „krótsza niż 7 dni”', async () => {
    seed(3);
    alertOk = () => false;
    start().start();
    await settle();
    await advance(TWO_HOURS);
    // Kolejka: urządzenie (502, wspólne odczekanie 30 s), potem kafel — za `p0`, z jej terminem.
    expect(tileAtS).toEqual([30]);
    expect(tileExpiry()).toBe(new Date(T0 + 3 * DAY).toISOString());
    expect(log.filter((l) => l.startsWith('onPass'))).toEqual(['onPass TOKEN']);
    expect(shortTileLog()).toEqual([]);
    expect(log).toContain('push: relay pass (activity) with the device pass expiry — renews after the device pass'
      + ' renews');
  });

  it('pierwsza przepustka urządzenia krótka, odnowienie po 30 s: kafel od razu, potem z nowym terminem', async () => {
    register();
    devices.setLiveActivity(TOKEN, { activityId: 'akt-1', updateToken: LA });
    // Pierwsze wydanie urządzenia: termin za 5 dni (np. przepustka sprzed odnowienia), drugie — 90 dni.
    client.reply = ((base) => (input: RelayPassInput) => {
      if (input.type === 'alert' && alertCalls === 0) {
        alertCalls += 1;
        passExp.set('p1', T0 + 5 * DAY);
        return { kind: 'issued', pass: { pass: 'p1', expiresAt: new Date(T0 + 5 * DAY).toISOString() } };
      }
      return base(input);
    })(client.reply);
    start().start();
    await settle();
    await advance(60 * 60_000);
    expect(alertCalls).toBe(2);
    expect(tileAtS).toEqual([0, 30]);
    expect(tileExpiry()).toBe(new Date(T0 + 30_000 + 90 * DAY).toISOString());
  });

  it('kontrola: świeże urządzenie, kafel < 7 dni — odnowienie kafla od razu, jedno, z długim terminem', async () => {
    seed(80, 3);
    start().start();
    await settle();
    await advance(TWO_HOURS);
    expect(alertCalls).toBe(0);
    expect(tileAtS).toEqual([0]);
    expect(tileExpiry()).toBe(new Date(T0 + 80 * DAY).toISOString());
    expect(shortTileLog()).toEqual([]);
  });
});

describe('przepustki: spóźnione odpowiedzi i zapis warunkowy', () => {
  const held = (): { release: (o?: RelayPassOutcome) => void } => {
    const box = { release: (_o?: RelayPassOutcome): void => {} };
    client.reply = (input) => new Promise((resolve) => { box.release = (o) => { resolve(o ?? issued(input)); }; });
    return box;
  };

  it('wyrejestrowanie (odpięcie, 410) w trakcie: spóźniona przepustka NIE odtwarza wpisu', async () => {
    register();
    const box = held();
    const p = start();
    p.ensure(TOKEN);
    await settle();
    devices.remove(TOKEN);
    box.release();
    await settle();
    expect(devices.get(TOKEN)).toBeUndefined();
    expect(devices.size).toBe(0);
  });

  it('rejestracja z innym środowiskiem w trakcie: przepustka nie trafia do wpisu; idzie nowe zamówienie', async () => {
    register();
    const box = held();
    const p = start();
    p.ensure(TOKEN);
    await settle();
    register(TOKEN, { environment: 'production' });
    box.release();
    await settle();
    expect(log).toContain('push: relay pass after an entry change during the request — skipped');
    expect(devices.get(TOKEN)?.relayPass).toBeUndefined();
    // Nowe zamówienie po odczekaniu (wpis zmieniany w kółko nie zmieli kolejki).
    client.reply = (input) => issued(input);
    await advance(RELAY_PASS_RETRY_MS[0] ?? 0);
    expect(client.calls.map((c) => c.environment)).toEqual(['development', 'production']);
    expect(devices.get(TOKEN)?.relayPass?.environment).toBe('production');
  });

  it('nowsza przepustka (odnowienie z `/v1/push` w trakcie) nie jest nadpisana starszą odpowiedzią', async () => {
    register();
    const box = held();
    const p = start();
    p.ensure(TOKEN);
    await settle();
    const late = issued(client.calls[0] as RelayPassInput, 89);
    p.renewed(
      { kind: 'device', deviceToken: TOKEN, environment: 'development', topic: TOPIC, pass: 'x' },
      { pass: 'v1.k1.nowsza', expiresAt: new Date(clock + 90 * DAY).toISOString() },
    );
    box.release(late);
    await settle();
    expect(devices.get(TOKEN)?.relayPass?.pass).toBe('v1.k1.nowsza');
  });
});

describe('przepustki: odmowy i porażki', () => {
  it('`422 BadDeviceToken` dla tokenu bez żadnego 200 → `env-mismatch`, wpis zostaje i nie zamawia w kółko', async () => {
    register();
    client.reply = () => ({ kind: 'token-rejected', apnsStatus: 400, reason: 'BadDeviceToken' });
    const p = start();
    p.ensure(TOKEN);
    await settle();
    expect(devices.get(TOKEN)?.relayMismatch).toEqual({ since: new Date(T0).toISOString(), origin: ORIGIN, environment: 'development' });
    expect(p.pending(TOKEN)).toBe(false);
    await advance(2 * RELAY_PASS_SWEEP_MS);
    p.ensure(TOKEN);
    await settle();
    expect(client.calls).toHaveLength(1);
    // Rejestracja w innym środowisku zdejmuje odmowę i zamawia od nowa.
    client.reply = (input) => issued(input);
    register(TOKEN, { environment: 'production' });
    p.ensure(TOKEN);
    await settle();
    expect(devices.get(TOKEN)?.relayMismatch).toBeUndefined();
    expect(devices.get(TOKEN)?.relayPass?.environment).toBe('production');
  });

  it('martwy token (`BadDeviceToken` po 200, 410) wypada jak `gone`; zarejestrowany od nowa po 410 — zostaje', async () => {
    register();
    devices.noteDelivered(TOKEN);
    client.reply = () => ({ kind: 'token-rejected', apnsStatus: 400, reason: 'BadDeviceToken' });
    const p = start();
    p.ensure(TOKEN);
    await settle();
    expect(devices.get(TOKEN)).toBeUndefined();

    register(OTHER);
    client.reply = () => ({ kind: 'token-rejected', apnsStatus: 410, reason: 'Unregistered', timestamp: clock - 60_000 });
    p.ensure(OTHER);
    await settle();
    expect(devices.get(OTHER)).toBeDefined();
    expect(log.some((l) => l.includes('but registered again — kept'))).toBe(true);
    // Wpis zostaje, ale bez mielenia: jedno zamówienie, następne po odczekaniu.
    expect(client.calls).toHaveLength(2);
  });

  it('`502`: odczekanie per token i WSPÓLNE odczekanie kolejki; po nim ponowienie; `missingSince` od pierwszej porażki', async () => {
    register(TOKEN);
    register(OTHER);
    client.reply = () => ({ kind: 'failed', status: 502, reason: 'apns-unreachable' });
    const p = start();
    p.ensure(TOKEN);
    await settle();
    p.ensure(OTHER);
    await settle();
    expect(client.calls).toHaveLength(1);
    expect(p.missingSince(TOKEN)).toBe(new Date(T0).toISOString());
    expect(p.pending(TOKEN)).toBe(false);
    // Drugi token czeka za wspólnym odczekaniem: nie „w toku”, tylko bez drogi od pierwszej porażki przekaźnika.
    expect(p.pending(OTHER)).toBe(false);
    expect(p.missingSince(OTHER)).toBe(new Date(T0).toISOString());
    client.reply = (input) => issued(input);
    await advance(RELAY_PASS_RETRY_MS[0] ?? 0);
    expect(client.calls.map((c) => c.token)).toEqual([TOKEN, OTHER, TOKEN]);
    expect(p.missingSince(TOKEN)).toBeNull();
    expect(log.some((l) => l.includes('failed (502 apns-unreachable) — retry in 30 s'))).toBe(true);
  });

  it('`429`: wspólne odczekanie 60 s — inne tokeny też czekają', async () => {
    register(TOKEN);
    client.reply = () => ({ kind: 'failed', status: 429, reason: 'relay-limited' });
    const p = start();
    p.ensure(TOKEN);
    await settle();
    register(OTHER);
    client.reply = (input) => issued(input);
    p.ensure(OTHER);
    await advance(RELAY_PASS_LIMITED_MS - 1);
    expect(client.calls).toHaveLength(1);
    await advance(1);
    expect(client.calls.map((c) => c.token)).toEqual([TOKEN, OTHER, TOKEN]);
    expect(devices.get(OTHER)?.relayPass).toBeDefined();
    expect(devices.get(TOKEN)?.relayPass).toBeDefined();
  });

  it('droga przekaźnika milczy w środowisku (`503`): zamówienie czeka do końca ciszy, bez liczenia porażki', async () => {
    register(TOKEN);
    client.paused = clock + 15 * 60_000;
    const p = start();
    p.ensure(TOKEN);
    await settle();
    expect(client.calls).toEqual([]);
    await advance(15 * 60_000 - 1);
    expect(client.calls).toEqual([]);
    await advance(1);
    expect(client.calls).toHaveLength(1);
    expect(devices.get(TOKEN)?.relayPass).toBeDefined();
    // `503` z `/v1/pass`: następna próba najwcześniej po ciszy drogi (klient ją ustawia).
    register(OTHER);
    client.reply = () => { client.paused = clock + 15 * 60_000; return { kind: 'failed', status: 503, reason: 'environment-unavailable' }; };
    p.ensure(OTHER);
    await settle();
    client.reply = (input) => issued(input);
    await advance(15 * 60_000 - 1);
    expect(client.calls).toHaveLength(2);
    await advance(1);
    expect(client.calls).toHaveLength(3);
    expect(devices.get(OTHER)?.relayPass).toBeDefined();
  });

  it('`401` z `/v1/push`: zdejmuje TĘ przepustkę (nie nowszą), nowe zamówienie po odczekaniu; token zostaje', async () => {
    register();
    const p = start();
    p.ensure(TOKEN);
    await settle();
    const current = devices.get(TOKEN)?.relayPass as RelayPass;
    p.invalid({ kind: 'device', deviceToken: TOKEN, environment: 'development', topic: TOPIC, pass: 'v1.k1.inna' });
    expect(devices.get(TOKEN)?.relayPass).toEqual(current);
    p.invalid({ kind: 'device', deviceToken: TOKEN, environment: 'development', topic: TOPIC, pass: current.pass });
    expect(devices.get(TOKEN)?.relayPass).toBeUndefined();
    expect(devices.get(TOKEN)).toBeDefined();
    p.ensure(TOKEN);
    await settle();
    expect(client.calls).toHaveLength(1);
    // Nieaktualne unieważnienie nie podbiło odczekania: zamówienie po pierwszym szczeblu (30 s), nie po drugim.
    await advance(RELAY_PASS_RETRY_MS[0] ?? 0);
    expect(client.calls).toHaveLength(2);
    expect(devices.get(TOKEN)?.relayPass).toBeDefined();
  });

  it('cztery równoległe `401` tej samej przepustki: jedno zdjęcie, jedno odczekanie 30 s i zamówienie po nim', async () => {
    register();
    const p = start();
    p.ensure(TOKEN);
    await settle();
    const current = devices.get(TOKEN)?.relayPass as RelayPass;
    const target = { kind: 'device' as const, deviceToken: TOKEN, environment: 'development' as const, topic: TOPIC, pass: current.pass };
    for (let i = 0; i < 4; i += 1) p.invalid(target);
    expect(devices.get(TOKEN)?.relayPass).toBeUndefined();
    expect(log.filter((l) => /refused the (?:device )?pass/u.test(l))).toEqual([
      'push: relay refused the pass (device, 401) — dropped, new request in 30 s',
    ]);
    await advance((RELAY_PASS_RETRY_MS[0] ?? 0) - 1);
    expect(client.calls).toHaveLength(1);
    await advance(1);
    expect(client.calls).toHaveLength(2);
    expect(devices.get(TOKEN)?.relayPass).toBeDefined();
  });

  it('przepustka krótsza niż próg odnowienia nie zamawia się w kółko', async () => {
    register();
    client.reply = (input) => issued(input, 3);
    const p = start();
    p.ensure(TOKEN);
    await settle();
    await settle();
    expect(client.calls).toHaveLength(1);
    expect(log.some((l) => l.includes('shorter than 7 days'))).toBe(true);
  });
});

describe('przepustki: czekanie pushu próbnego', () => {
  it('czeka na zamówienie w toku i kończy się z nim; bez zamówienia — od razu; sufit czasu', async () => {
    register();
    let release: (o: RelayPassOutcome) => void = () => {};
    client.reply = () => new Promise((resolve) => { release = resolve; });
    const p = start();
    let done = false;
    void p.waitForDevicePass(TOKEN, 10_000).then(() => { done = true; });
    await settle();
    expect(done).toBe(false);
    release(issued(client.calls[0] as RelayPassInput));
    await settle();
    expect(done).toBe(true);
    // Przepustka jest — od razu.
    await p.waitForDevicePass(TOKEN, 10_000);
    // Zamówienie wisi dłużej niż sufit — czekanie kończy timer.
    register(OTHER);
    let late = false;
    void p.waitForDevicePass(OTHER, 10_000).then(() => { late = true; });
    await settle();
    expect(late).toBe(false);
    await advance(10_000);
    expect(late).toBe(true);
  });
});

describe('przepustki: stan dla statusu tokenu', () => {
  it('wpis czekający w kolejce za wspólnym odczekaniem NIE jest „w toku”: brak drogi od pierwszej porażki przekaźnika', async () => {
    register(TOKEN);
    client.reply = () => ({ kind: 'failed', status: null, reason: 'ECONNREFUSED' });
    const p = start();
    p.ensure(TOKEN);
    await settle();
    clock += 1_000;
    register(OTHER);
    p.ensure(OTHER);
    await settle();
    expect(client.calls).toHaveLength(1);
    expect(p.pending(OTHER)).toBe(false);
    expect(p.missingSince(OTHER)).toBe(new Date(T0).toISOString());
    expect(p.missingSince(TOKEN)).toBe(new Date(T0).toISOString());
  });

  it('wpis usunięty w trakcie odczekania: jego odczekanie znika przy następnym `ensure`', async () => {
    register(TOKEN);
    client.reply = () => ({ kind: 'failed', status: 400, reason: 'bad-request' });
    const p = start();
    p.ensure(TOKEN);
    await settle();
    expect(p.missingSince(TOKEN)).not.toBeNull();
    devices.remove(TOKEN);
    p.ensure(TOKEN);
    expect(p.missingSince(TOKEN)).toBeNull();
  });
});
