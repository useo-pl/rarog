/**
 * Sink harmonogramu (`notify/fanout.ts`) — adapter jedynego kanału banerów: APNs apki natywnej.
 *
 * Do udowodnienia: treść idzie do sinka APNs bez zmian, wynik wraca pod nazwą kanału (linia logu
 * mówi nim, którym kanałem poszedł baner), a wyjątek sinka to `failed`, nigdy wyjątek wysyłki.
 * „Skończył” zleca dźwięk z kafla przed wysyłką plakietki; inne rodzaje
 * nie, a wyjątek zlecenia to zero zleceń, nie zepsuta wysyłka.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import type { ApnsDeviceStore } from '../src/notify/apns-devices.ts';
import { createApnsSink } from '../src/notify/apns-sink.ts';
import { buildContent } from '../src/notify/content.ts';
import type { PushContent, SendOutcome } from '../src/notify/content.ts';
import { createFanoutSink } from '../src/notify/fanout.ts';
import { foreign } from '@rarog/shared/sentences';

const content = buildContent({
  cls: 'blocking', kind: 'permission', project: 'rarog', sessionId: 's1', detail: foreign('Bash'),
});

const fixed = (outcome: SendOutcome, seen: PushContent[] = []): { send: (c: PushContent) => Promise<SendOutcome> } => ({
  send: (c) => { seen.push(c); return Promise.resolve(outcome); },
});

describe('createFanoutSink', () => {
  it('APNs dostaje TĘ SAMĄ treść, a wynik wraca pod jego nazwą', async () => {
    const seen: PushContent[] = [];
    const report = await createFanoutSink({ apns: fixed('delivered', seen) }).send(content);
    expect(report).toEqual({ channels: { apns: 'delivered' } });
    expect(seen).toEqual([content]);
  });

  it('trójstan sinka przechodzi bez zmian — `no-receiver` to nie `failed`', async () => {
    for (const outcome of ['delivered', 'failed', 'no-receiver'] as const) {
      expect(await createFanoutSink({ apns: fixed(outcome) }).send(content)).toEqual({ channels: { apns: outcome } });
    }
  });

  it('wyjątek sinka to `failed`, nigdy wyjątek wysyłki', async () => {
    const throwing = { send: (): Promise<SendOutcome> => Promise.reject(new Error('apns boom')) };
    await expect(createFanoutSink({ apns: throwing }).send(content)).resolves.toEqual({ channels: { apns: 'failed' } });
  });
});

describe('dźwięk „skończył” z kafla', () => {
  const done = buildContent({
    cls: 'done', kind: 'done', project: 'rarog', sessionId: 's1', detail: foreign('Testy zielone.'), badge: 0,
  });

  it('„skończył” woła `chime` PRZED wysyłką plakietki; raport niesie liczbę zleceń poza mapą kanałów', async () => {
    const order: string[] = [];
    const sink = createFanoutSink({
      apns: { send: () => { order.push('apns'); return Promise.resolve('delivered'); } },
      chime: () => { order.push('chime'); return 2; },
    });
    expect(await sink.send(done)).toEqual({ channels: { apns: 'delivered' }, chime: 2 });
    expect(order).toEqual(['chime', 'apns']);
  });

  it('inne rodzaje nie wołają `chime`; raport bez pola', async () => {
    let calls = 0;
    const sink = createFanoutSink({ apns: fixed('delivered'), chime: () => { calls += 1; return 1; } });
    for (const other of [
      content,
      buildContent({ cls: 'blocking', kind: 'question', project: 'rarog', sessionId: 's1', detail: foreign('Który?') }),
      buildContent({ cls: 'failure', kind: 'error', project: 'rarog', sessionId: 's1', detail: foreign('Tura padła.') }),
    ]) {
      expect(await sink.send(other)).toEqual({ channels: { apns: 'delivered' } });
    }
    expect(calls).toBe(0);
  });

  it('zero zleceń (nikt nie ma kafla) też jedzie w raporcie — linia logu mówi „0”', async () => {
    const sink = createFanoutSink({ apns: fixed('delivered'), chime: () => 0 });
    expect(await sink.send(done)).toEqual({ channels: { apns: 'delivered' }, chime: 0 });
  });

  it('rzucający `chime` = 0 zleceń, a plakietka i tak idzie do APNs', async () => {
    const seen: PushContent[] = [];
    const sink = createFanoutSink({ apns: fixed('delivered', seen), chime: () => { throw new Error('kafel boom'); } });
    expect(await sink.send(done)).toEqual({ channels: { apns: 'delivered' }, chime: 0 });
    expect(seen).toEqual([done]);
  });

  it('wyjątek APNs nie gubi zleceń dźwięku', async () => {
    const throwing = { send: (): Promise<SendOutcome> => Promise.reject(new Error('apns boom')) };
    const sink = createFanoutSink({ apns: throwing, chime: () => 1 });
    expect(await sink.send(done)).toEqual({ channels: { apns: 'failed' }, chime: 1 });
  });

  it('sink bez `chime` (konfiguracja bez kafla) — raport bez pola, także dla „skończył”', async () => {
    expect(await createFanoutSink({ apns: fixed('delivered') }).send(done)).toEqual({ channels: { apns: 'delivered' } });
  });
});

/*
 * Na PRAWDZIWYM rejestrze urządzeń (katalog tymczasowy) i prawdziwym sinku APNs, z atrapą nadajnika:
 * raport harmonogramu mówi to, co stało się z urządzeniami.
 */
describe('z prawdziwym sinkiem APNs', () => {
  const APP_TOKEN = 'a1b2c3d4'.repeat(8);
  let dir = '';
  let devices: ApnsDeviceStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-fanout-'));
    devices = createApnsDeviceStore({ dataDir: dir });
  });

  afterEach(async () => {
    await devices.flush();
    await rm(dir, { recursive: true, force: true });
  });

  /** Sparowane urządzenie z kluczem push: baner (format 3) dostaje tylko wpis aktywnego urządzenia. */
  const DEVICE = 'd'.repeat(32);
  const KEY = { pushKey: Buffer.alloc(32, 7).toString('base64url'), kid: '00000000' };
  const sink = (): ReturnType<typeof createFanoutSink> => createFanoutSink({
    apns: createApnsSink({
      sender: { send: () => Promise.resolve({ kind: 'ok' }) }, devices,
      activeDevices: () => new Map([[DEVICE, KEY]]), e2e: true,
    }),
  });
  const register = (alerts: boolean): void => {
    devices.upsert({
      token: APP_TOKEN, environment: 'development', label: 'iPad·Rarog', alerts, deviceId: DEVICE, topic: 'ai.rarog.app',
      pushFormats: [3],
    });
  };

  it('pusty rejestr → `no-receiver`; urządzenie ze zgodą → `delivered`', async () => {
    expect(await sink().send(content)).toEqual({ channels: { apns: 'no-receiver' } });
    register(true);
    expect(await sink().send(content)).toEqual({ channels: { apns: 'delivered' } });
  });

  it('urządzenie bez zgody na powiadomienia nie dostaje banera → `no-receiver`', async () => {
    register(false);
    expect(await sink().send(content)).toEqual({ channels: { apns: 'no-receiver' } });
  });
});
