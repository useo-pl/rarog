/**
 * Złożenie kanału APNs (`notify/apns-channel.ts`) — jedyna bramka, przez którą rejestr urządzeń,
 * nadajnik, sink banerów i sterownik Live Activity w ogóle powstają.
 *
 * Do udowodnienia: `RAROG_PUSH=0` (albo brak kompletu `RAROG_APNS_*` i przekaźnika) = NIC — ani kanału, ani pliku
 * `apns-devices.json`, ani Live Activity, ani pollera limitów (kafel v2); z kanałem sterownik Live
 * Activity czyta ten sam rejestr co trasy, bierze sesje leniwie (manager powstaje po kanale) i zamyka
 * poller razem ze sobą. Próbnik obciążenia Maca należy do `index.ts` (wspólny z `GET /api/mac`):
 * kanał dostaje sam odczyt i niczego tu nie zakłada ani nie zamyka. Kanał powstaje też przy samym przekaźniku
 * (`RAROG_PUSH_RELAY_URL` bez klucza) — z przepustkami i tematem apki z jednego źródła. Sink kanału dostaje
 * flagę `RAROG_PUSH_E2E` i migawkę aktywnych urządzeń z magazynu kluczy: wpis z deklaracją formatu 3 i aktywnym
 * urządzeniem dostaje treść zaszyfrowaną (blok `rarog`), przy wyłączonej fladze banerów nie ma.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSummary } from '@rarog/shared';
import { RELAY_APP_TOPIC } from '@rarog/shared/relay';
import type { ApnsRequest } from '../src/notify/apns-payload.ts';
import type { ApnsSender } from '../src/notify/apns.ts';
import { activePushKeys, createApnsChannel } from '../src/notify/apns-channel.ts';
import type { ApnsChannel, ApnsChannelDeps } from '../src/notify/apns-channel.ts';
import { buildContent } from '../src/notify/content.ts';
import type { WeeklyLimitReading } from '../src/notify/live-activity-limits.ts';
import { WEEKLY_LIMIT_ALERTS_FILENAME } from '../src/notify/weekly-limit.ts';
import { makeSummary } from './fake-manager.ts';
import { foreign } from '@rarog/shared/sentences';

/** Atrapy odczytu Maca i pollera: liczą, ile pollerów powstało i ile zamknięto, i dają `onChange` pollera. */
function fakes(windows: readonly WeeklyLimitReading[] = []): {
  deps: Pick<ApnsChannelDeps, 'mac' | 'limitsPoller' | 'pairedDevices'>;
  created: () => number;
  closed: () => number;
  limitsChanged: () => void;
  polled: () => void;
} {
  let created = 0;
  let closed = 0;
  let onChange: () => void = () => {};
  let onPoll: () => void = () => {};
  return {
    deps: {
      mac: () => ({ cpu: 30 }),
      pairedDevices: { active: () => [] },
      limitsPoller: (change, poll) => {
        created += 1;
        onChange = change;
        onPoll = poll;
        return { current: () => ({ fiveHour: 40 }), weeklyWindows: () => windows, close: () => { closed += 1; } };
      },
    },
    created: () => created,
    closed: () => closed,
    limitsChanged: () => { onChange(); },
    polled: () => { onPoll(); },
  };
}

const PEM = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();
const APNS = { privateKey: PEM, keyId: 'ABC123DEFG', teamId: '97TDXJ84WH', topic: 'pl.useo.rarog' };

let dataDir = '';
let channels: ApnsChannel[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-apns-channel-'));
  channels = [];
});

afterEach(async () => {
  for (const channel of channels) {
    channel.liveActivity.close();
    channel.sender.close();
    await channel.devices.flush();
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe('createApnsChannel', () => {
  it('`RAROG_PUSH=0` (pushEnabled: false) z kompletem kluczy → brak kanału, pliku, Live Activity i pollera', async () => {
    const f = fakes();
    const channel = createApnsChannel(
      { pushEnabled: false, pushE2e: true, apns: APNS, dataDir }, { sessions: () => [], log: () => {}, ...f.deps },
    );
    expect(channel).toBeUndefined();
    expect(await readdir(dataDir)).toEqual([]);
    expect(f.created()).toBe(0);
  });

  it('bez kompletu `RAROG_APNS_*` i bez przekaźnika → brak kanału i pollera', () => {
    const f = fakes();
    expect(createApnsChannel({ pushEnabled: true, pushE2e: true, dataDir }, { sessions: () => [], log: () => {}, ...f.deps }))
      .toBeUndefined();
    expect(f.created()).toBe(0);
  });

  it('z kanałem: poller powstaje raz, zmiana limitów budzi przeliczenie, `close` zamyka sam poller', async () => {
    const f = fakes();
    let reads = 0;
    const channel = createApnsChannel({ pushEnabled: true, pushE2e: true, apns: APNS, dataDir }, {
      sessions: () => { reads += 1; return []; },
      log: () => {},
      ...f.deps,
    });
    expect(channel).toBeDefined();
    if (channel === undefined) return;
    channels.push(channel);
    expect(f.created()).toBe(1);
    f.limitsChanged();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reads).toBe(1);
    channel.liveActivity.close();
    expect(f.closed()).toBe(1);
  });

  it('sam przekaźnik (bez klucza): kanał z przepustkami i tematem apki z jednego źródła; bez sieci przy złożeniu', () => {
    const calls: string[] = [];
    const channel = createApnsChannel(
      { pushEnabled: true, pushE2e: true, pushRelay: { origin: 'https://push.rarog.ai' }, dataDir },
      { sessions: () => [], log: () => {}, ...fakes().deps, relayFetch: (url) => { calls.push(String(url)); return Promise.reject(new Error('x')); } },
    );
    expect(channel).toBeDefined();
    if (channel === undefined) return;
    channels.push(channel);
    expect(channel.topic).toBe(RELAY_APP_TOPIC);
    expect(channel.passes).toBeDefined();
    expect(calls).toEqual([]);
    channel.passes?.close();
  });

  it('klucz bez przekaźnika: przepustek nie ma, temat z `RAROG_APNS_TOPIC`; klucz i przekaźnik — temat z klucza', () => {
    const keyOnly = createApnsChannel({ pushEnabled: true, pushE2e: true, apns: APNS, dataDir }, { sessions: () => [], log: () => {}, ...fakes().deps });
    expect(keyOnly?.passes).toBeUndefined();
    expect(keyOnly?.topic).toBe('pl.useo.rarog');
    if (keyOnly !== undefined) channels.push(keyOnly);
    const both = createApnsChannel(
      { pushEnabled: true, pushE2e: true, apns: APNS, pushRelay: { origin: 'https://push.rarog.ai' }, dataDir },
      { sessions: () => [], log: () => {}, ...fakes().deps },
    );
    expect(both?.passes).toBeDefined();
    expect(both?.topic).toBe('pl.useo.rarog');
    if (both !== undefined) channels.push(both);
    both?.passes?.close();
  });

  it('`RAROG_PUSH=0` z przekaźnikiem → brak kanału', () => {
    expect(createApnsChannel(
      { pushEnabled: false, pushE2e: true, pushRelay: { origin: 'https://push.rarog.ai' }, dataDir },
      { sessions: () => [], log: () => {}, ...fakes().deps },
    )).toBeUndefined();
  });

  it('z kanałem: Live Activity powstaje razem z nim, a sesje czyta leniwie (bez żadnej wysyłki)', async () => {
    const sessions: SessionSummary[] = [makeSummary({ state: 'running' })];
    let reads = 0;
    const channel = createApnsChannel({ pushEnabled: true, pushE2e: true, apns: APNS, dataDir }, {
      sessions: () => { reads += 1; return sessions; },
      log: () => {},
      ...fakes().deps,
    });
    expect(channel).toBeDefined();
    if (channel === undefined) return;
    channels.push(channel);
    // Konstrukcja kanału nie pyta managera (jeszcze go nie ma) — dopiero event globalny.
    expect(reads).toBe(0);
    channel.liveActivity.poke();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(reads).toBe(1);
  });

  it.each([true, false])('sink kanału (E2E: %s): migawka z magazynu kluczy, format 3 dla wpisu z deklaracją, flaga wyłącza', async (e2e) => {
    const pushKey = Buffer.alloc(32, 7).toString('base64url');
    const deviceId = 'd'.repeat(32);
    const record = {
      id: deviceId, secretHash: '0'.repeat(64), pushKey, kid: '0a1b2c3d', label: 'iPhone·Rarog', build: null,
      createdAt: '2026-10-23T10:00:00.000Z', lastSeenAt: null, epoch: '1', creator: 'admin',
    };
    let snapshots = 0;
    const sent: ApnsRequest[] = [];
    const direct: ApnsSender = {
      send: (_e, _t, request) => { sent.push(request); return Promise.resolve({ kind: 'ok' }); },
      disabledSince: () => null,
      close: () => {},
    };
    const channel = createApnsChannel({ pushEnabled: true, pushE2e: e2e, apns: APNS, dataDir }, {
      sessions: () => [], log: () => {}, ...fakes().deps, direct: () => direct,
      pairedDevices: { active: () => { snapshots += 1; return [record]; } },
    });
    if (channel === undefined) throw new Error('kanał nie powstał');
    channels.push(channel);
    channel.devices.upsert({
      token: 'ab'.repeat(32), environment: 'development', label: 'iPhone·Rarog', alerts: true,
      topic: 'ai.rarog.app', deviceId, pushFormats: [3],
    });
    expect(await channel.sink.send(buildContent({
      cls: 'blocking', kind: 'permission', project: 'p', sessionId: 's1', detail: foreign('Edit'), badge: 1,
    }))).toBe(e2e ? 'delivered' : 'no-receiver');
    expect(snapshots).toBe(1);
    // `RAROG_PUSH_E2E=0`: banerów nie ma, także przy deklaracji — zero wysyłek.
    expect(sent).toHaveLength(e2e ? 1 : 0);
    // Jedyny blok banera to `rarog` formatu 3.
    if (e2e) expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({ rarog: { v: 3, kid: '0a1b2c3d' } });
  });

  it('`RAROG_PUSH=0` → no weekly-limit signal: no poller, no `weekly-limit-alerts.json`', async () => {
    const f = fakes([{ percent: 99, resetsAt: '2099-01-01T00:00:00.000Z', at: Date.now() }]);
    const channel = createApnsChannel(
      { pushEnabled: false, pushE2e: true, apns: APNS, dataDir }, { sessions: () => [], log: () => {}, ...f.deps },
    );
    expect(channel).toBeUndefined();
    f.polled();
    expect(f.created()).toBe(0);
    expect(await readdir(dataDir)).not.toContain(WEEKLY_LIMIT_ALERTS_FILENAME);
  });

  it('`onPoll` checks the weekly windows; `close` waits for the send and the write, then closes the sender', async () => {
    const pushKey = Buffer.alloc(32, 7).toString('base64url');
    const deviceId = 'd'.repeat(32);
    const record = {
      id: deviceId, secretHash: '0'.repeat(64), pushKey, kid: '0a1b2c3d', label: 'iPhone·Rarog', build: null,
      createdAt: '2026-10-23T10:00:00.000Z', lastSeenAt: null, epoch: '1', creator: 'admin',
    };
    const resetsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const events: string[] = [];
    let answer: (() => void) | undefined;
    const direct: ApnsSender = {
      send: () => {
        events.push('send');
        return new Promise((resolve) => { answer = () => { events.push('answer'); resolve({ kind: 'ok' }); }; });
      },
      disabledSince: () => null,
      close: () => { events.push('sender closed'); },
    };
    const f = fakes([{ percent: 97, resetsAt, at: Date.now() }]);
    const channel = createApnsChannel({ pushEnabled: true, pushE2e: true, apns: APNS, dataDir }, {
      sessions: () => [], log: () => {}, ...f.deps, direct: () => direct,
      pairedDevices: { active: () => [record] },
    });
    if (channel === undefined) throw new Error('no channel');
    channels.push(channel);
    channel.devices.upsert({
      token: 'ab'.repeat(32), environment: 'development', label: 'iPhone·Rarog', alerts: true,
      topic: 'ai.rarog.app', deviceId, pushFormats: [3],
    });
    f.polled();
    await vi.waitFor(() => { expect(events).toEqual(['send']); }, { timeout: 2_000, interval: 5 });
    const closing = channel.close();
    expect(f.closed(), 'the poller closes first').toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events, 'the sender waits for the send in flight').toEqual(['send']);
    answer?.();
    await closing;
    expect(events).toEqual(['send', 'answer', 'sender closed']);
    expect(JSON.parse(await readFile(join(dataDir, WEEKLY_LIMIT_ALERTS_FILENAME), 'utf8')))
      .toEqual({ format: 1, sent: [resetsAt] });
    // After the close the signal evaluates nothing, even if a reading still came.
    f.polled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['send', 'answer', 'sender closed']);
  });

  it('`activePushKeys`: `deviceId` → klucz push i `kid` aktywnych rekordów', () => {
    const keys = activePushKeys({ active: () => [{
      id: 'e'.repeat(32), secretHash: '0'.repeat(64), pushKey: 'k', kid: '01234567', label: 'x', build: null,
      createdAt: '2026-10-23T10:00:00.000Z', lastSeenAt: null, epoch: '1', creator: 'admin',
    }] });
    expect([...keys]).toEqual([['e'.repeat(32), { pushKey: 'k', kid: '01234567' }]]);
  });
});
