/**
 * Złote ramki APNs, strona PRODUCENTÓW: kod serwera → pliki `shared/fixtures/apns/` (Live Activity)
 * i `shared/fixtures/apns-v3/` (banery formatu 3).
 *
 * Każdy plik to PEŁNA ramka, którą nadajnik wysyła do APNs: nagłówki (`apns-push-type`,
 * `apns-topic`, `apns-priority`, `apns-expiration`, przy banerze `apns-collapse-id`) i ładunek
 * (`aps` plus klucz `rarog` banera). Buduje je ten sam kod, który wysyła na żywo: `buildContent`
 * + `apnsAlertRequestE2e` dla banerów, `aggregateState` + `apnsLiveActivityRequest` dla Live Activity
 * (stan z seedów demo i z sesji syntetycznych, zegar stały). Ścieżki `:path` z tokenem urządzenia
 * w pliku NIE MA — token to adres, nie kontrakt.
 *
 * Banery formatu 3 (ramki `*.v3.json`) składa `apnsAlertRequestE2e` z kluczem TESTOWYM (32×`0x05`,
 * `kid` `f849d673` — ten sam co w `shared/fixtures/rest/pair.json`) i stałym nonce per ramka (wstrzyknięty WYŁĄCZNIE
 * parametrem fabryki `createPushSealer`); leżą w OSOBNYM katalogu `shared/fixtures/apns-v3/` z własnym manifestem.
 * The `apns/` directory holds Live Activity frames only.
 *
 * Warianty z kluczami lokalizacji (wpis z deklaracją `locKeys`; w manifeście `"locKeys": true`): baner
 * `alert.blocking.loc-keys.v3.json` i dzwonek `live-activity.update.chime.loc-keys.json` to ramki bazowe tych samych
 * wejść (ten sam nonce), w których tekst zastępczy i dzwonek idą kluczami katalogu apki zamiast literałów.
 *
 * Druga strona (pliki → schemat) mieszka w `shared/test/apns-fixtures.test.ts`, trzecia to
 * `ApnsFramesTests` w `native/Rarog/Packages/RarogContract` (ActivityKit dekoduje
 * `aps.content-state` sam, więc dekoder Swift musi przejść CAŁĄ ramkę). Domyślnie test PORÓWNUJE
 * ramki z plikami; `RAROG_FIXTURES_WRITE=1` je nadpisuje.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackgroundTask } from '@rarog/shared';
import type { ApnsRequest } from '../src/notify/apns-payload.ts';
import { apnsAlertRequestE2e, apnsLiveActivityRequest } from '../src/notify/apns-payload.ts';
import {
  buildContent, buildDevicePairedContent, buildStalledContent, buildTestContent, buildVersionContent,
  buildWeeklyLimitContent, stalledTopicFor, topicFor,
} from '../src/notify/content.ts';
import { LIVE_ACTIVITY_CHIME_TTL_MS } from '../src/notify/live-activity.ts';
import { aggregateState } from '../src/notify/live-activity-state.ts';
import { createPushSealer } from '../src/notify/push-crypto.ts';
import { ownCommandWaitOf } from '../src/herdr/background/work.ts';
import { createManager } from '../src/sessions/manager.ts';
import { makeSummary } from './fake-manager.ts';
import { foreign } from '@rarog/shared/sentences';
import { demoContentPl } from '../src/demo/content/pl.ts';

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures/apns');
/** Ramki banerów formatu 3. */
const FIXTURES_V3_DIR = path.resolve(FIXTURES_DIR, '../apns-v3');
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';
const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const NOW_S = NOW / 1000;
const TOPIC = 'ai.rarog.app';
/** Klucz push TESTOWY ramek banerów: 32×`0x05`, `kid` = 8 hex `sha256` surowych bajtów. */
const PUSH_KEY = { pushKey: Buffer.alloc(32, 5).toString('base64url'), kid: 'f849d673' };

interface ManifestEntry {
  pushType: 'alert' | 'liveactivity';
  event?: 'update' | 'end';
  /** Wariant wpisu z deklaracją `locKeys`: klucze katalogu apki zamiast literałów. */
  locKeys?: true;
}

const manifest = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as
  Record<string, ManifestEntry>;
const manifestV3 = JSON.parse(readFileSync(path.join(FIXTURES_V3_DIR, 'manifest.json'), 'utf8')) as
  Record<string, ManifestEntry>;
/** Reset of the weekly window in `alert.weekly-limit.v3.json`: more than a day after `NOW`, so the TTL is one day. */
const WEEKLY_RESET = '2026-10-10T15:00:00.000Z';

/** Ramka w pliku: nagłówki w stałej kolejności i ładunek jako obiekt (nie tekst). */
const frame = (request: ApnsRequest): unknown => ({
  headers: Object.fromEntries(Object.entries(request.headers).sort(([a], [b]) => a.localeCompare(b))),
  payload: JSON.parse(request.body) as unknown,
});

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('złote ramki APNs: producenci → pliki', () => {
  const produced = new Map<string, unknown>();
  const producedV3 = new Map<string, unknown>();
  let dataDir = '';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'rarog-apns-fixtures-'));

    // Format 3 banners — content from `buildContent`: a consent carries only the tool name and the session label;
    // a fixed nonce per frame.
    const alert = (content: Parameters<typeof apnsAlertRequestE2e>[0], nonceByte: number, locKeys = false): unknown => {
      const request = apnsAlertRequestE2e(content, {
        topic: TOPIC, nowMs: NOW, key: PUSH_KEY, sealer: createPushSealer({ nonce: () => Buffer.alloc(12, nonceByte) }),
        locKeys,
      });
      if (request === undefined) throw new Error('ramka banera ponad 4096 B');
      return frame(request);
    };
    const blocking = buildContent({
      cls: 'blocking', kind: 'permission', project: 'willow', label: 'zapis notatek', sessionId: 'demo-willow',
      detail: foreign('Edit'), badge: 2,
    });
    producedV3.set('alert.blocking.v3.json', alert(blocking, 0x11));
    // Wpis z deklaracją `locKeys`: ta sama treść i nonce, tekst zastępczy kluczami katalogu apki.
    producedV3.set('alert.blocking.loc-keys.v3.json', alert(blocking, 0x11, true));
    producedV3.set('alert.done.v3.json', alert(buildContent({
      cls: 'done', kind: 'done', project: 'codex-proba', sessionId: 'demo-codex', termId: '0123456789abcdef',
      detail: foreign('Testy zielone, zmiana gotowa do przeglądu.'), badge: 0,
    }), 0x12));
    producedV3.set('alert.test.v3.json', alert(buildTestContent(), 0x13));
    // Push bezpieczeństwa: sparowano nowe urządzenie — bez sesji i bez wątku, etykieta w treści.
    producedV3.set('alert.device-paired.v3.json', alert(buildDevicePairedContent('iPad·Rarog', 'macos'), 0x14));
    // Nowa wersja Claude Code i herdr naraz (`version-watch.ts`): bez sesji i bez wątku, numery wersji w treści.
    // An app that does not know this kind reads it as no kind (`ApnsFramesTests`, `PushServiceTests`).
    producedV3.set('alert.version-changed.v3.json', alert(buildVersionContent([
      { product: 'claude-code', from: '2.1.321', to: '2.1.322' }, { product: 'herdr', from: '0.9.5', to: '0.9.6' },
    ]), 0x15));
    // Weekly plan limit at 97% (`weekly-limit`): no session, no thread, the percent and the reset in the text. A kind
    // newer than format 2; an app that does not know it reads it as no kind (`ApnsFramesTests`, `PushServiceTests`).
    const weekly = buildWeeklyLimitContent(97, WEEKLY_RESET, NOW);
    if (weekly === undefined) throw new Error('weekly-limit: no content');
    producedV3.set('alert.weekly-limit.v3.json', alert(weekly, 0x16));
    // A subagent waits over an hour on its own command (`stalled`): a session kind with its own collapse key, the
    // subagent's description in the text, never the command. An app that does not know this kind reads it as no kind.
    producedV3.set('alert.stalled.v3.json', alert(buildStalledContent({
      project: 'atlas', label: 'login flow', sessionId: 'demo-atlas', agent: 'Fix the flaky login test', badge: 1,
    }), 0x17));

    // Live Activity — stan z seedów demo (2 czekają, 2 pracują, wiodąca zgoda) z kompletem pól spoza
    // listy sesji: limity planu i obciążenie Maca (kafel v2).
    const live = (
      state: Parameters<typeof apnsLiveActivityRequest>[0], event: 'update' | 'end', priority: 'high' | 'low',
    ): unknown => frame(apnsLiveActivityRequest(
      { ...state, updatedEpoch: NOW_S }, { topic: TOPIC, event, timestamp: NOW_S, priority },
    ));
    const manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir, now: () => NOW });
    try {
      await manager.ready;
      produced.set('live-activity.update.json', live(aggregateState(manager.list(), NOW, {
        limits: { fiveHour: 42, weekly: 81 }, mac: { cpu: 35, ram: 70, disk: 60 },
      }), 'update', 'high'));
    } finally {
      await manager.dispose();
    }
    // Wpis Codexa: tap w aktywność prowadzi do terminala — `top.termId`.
    produced.set('live-activity.update.codex.json', live(aggregateState([makeSummary({
      id: 'demo-codex', title: 'codex-proba', engine: 'codex', termId: '0123456789abcdef',
      state: 'waiting-permission', stateSince: new Date(NOW - 90_000).toISOString(),
    })], NOW), 'update', 'high'));
    // Trzy przebiegi workflow w dwóch sesjach: dwa najstarsze na kaflu (z planem faz i bez planu),
    // trzeci jako „+1"; sesja po turze z przebiegiem w locie liczy się do „pracuje" (jak „pracuje
    // w tle" na liście), nie do „skończyły". Przebieg z planem ma fazę w każdym z trzech stanów (Zbieranie 2/2
    // skończona, Weryfikacja 1/2 w pracy, Synteza niezaczęta); przebieg bez planu stanu faz nie ma.
    const startedAt = (ago: number): string => new Date(NOW - ago).toISOString();
    produced.set('live-activity.update.workflow.json', live(aggregateState([
      makeSummary({
        id: 'demo-rarog', title: 'rarog', state: 'waiting-input', stateSince: startedAt(600_000),
        backgroundTasks: [{
          id: 'w1', kind: 'workflow', description: 'audyt-docs', runId: 'wf_audyt', startedAt: startedAt(900_000),
          run: {
            phases: ['A1 Zbieranie', 'A2 Weryfikacja', 'A3 Synteza'],
            agents: [
              { id: 'a1', phase: 'A1 Zbieranie', done: true }, { id: 'a2', phase: 'A1 Zbieranie', done: true },
              { id: 'a3', phase: 'A2 Weryfikacja', done: true }, { id: 'a4', phase: 'A2 Weryfikacja', done: false },
            ],
          },
        }],
      }),
      makeSummary({
        id: 'demo-atlas', title: 'atlas-web', state: 'running', stateSince: startedAt(300_000),
        backgroundTasks: [
          {
            id: 'w2', kind: 'workflow', description: 'review-changes', runId: 'wf_review',
            startedAt: startedAt(600_000),
            run: { phases: [], agents: [{ id: 'b1', done: true }, { id: 'b2', done: false }, { id: 'b3', done: false }] },
          },
          {
            id: 'w3', kind: 'workflow', description: 'migracja', runId: 'wf_migracja', startedAt: startedAt(60_000),
            run: { phases: [], agents: [] },
          },
        ],
      }),
    ], NOW), 'update', 'low'));
    // Subagent w postoju pracą nie jest. Cztery sesje po turze, każda z innym tłem: sam czekający
    // subagent z wynikiem nieodebranym liczy się do „skończyły", z wynikiem odebranym do niczego,
    // a czekający obok komendy i subagent pracujący (bez `waitingSince`) do „pracuje". Żadna nie jest
    // celem tapnięcia: `top` to sesja czekająca na decyzję albo pracująca w turze.
    // Two more sessions after a turn have a subagent stuck on its own command for over an hour, one unacknowledged and
    // one acknowledged next to a live command: each counts once, as waiting, and neither is the tap target.
    const waitingAgent = (id: string, standbyMs = 1_080_000): BackgroundTask => {
      const task: BackgroundTask = {
        id, kind: 'agent', description: 'Shared views of panel sections', agentType: 'general-purpose',
        startedAt: startedAt(standbyMs + 2_520_000), waitingSince: startedAt(standbyMs),
        ownTasks: [{ id: 'bjvzo6rnl', command: 'until grep -q TEST log.txt; do sleep 5; done' }],
      };
      const stage = ownCommandWaitOf(task, NOW);
      return stage === undefined ? task : { ...task, ownCommandWait: stage };
    };
    produced.set('live-activity.update.waiting-agent.json', live(aggregateState([
      makeSummary({
        id: 'demo-rarog', title: 'rarog', state: 'waiting-input', stateSince: startedAt(1_080_000),
        backgroundTasks: [waitingAgent('agent_w1')],
      }),
      makeSummary({
        id: 'demo-map-view', title: 'map-view', state: 'waiting-input', stateSince: startedAt(900_000),
        seen: true, backgroundTasks: [waitingAgent('agent_w2')],
      }),
      makeSummary({
        id: 'demo-atlas', title: 'atlas-web', state: 'waiting-input', stateSince: startedAt(600_000),
        backgroundTasks: [
          waitingAgent('agent_w3'),
          { id: 'c1', kind: 'command', command: 'pnpm test', startedAt: startedAt(120_000) },
        ],
      }),
      makeSummary({
        id: 'demo-willow', title: 'willow', state: 'waiting-input', stateSince: startedAt(300_000),
        backgroundTasks: [
          { id: 'agent_r1', kind: 'agent', description: 'przegląd logu', startedAt: startedAt(240_000) },
        ],
      }),
      makeSummary({
        id: 'demo-stuck', title: 'demo', state: 'waiting-input', stateSince: startedAt(5_400_000),
        backgroundTasks: [waitingAgent('agent_s1', 5_400_000)],
      }),
      makeSummary({
        id: 'demo-atlas-api', title: 'atlas-api', state: 'waiting-input', stateSince: startedAt(4_200_000),
        seen: true, backgroundTasks: [
          waitingAgent('agent_s2', 4_200_000),
          { id: 'c2', kind: 'command', command: 'pnpm dev', startedAt: startedAt(4_500_000) },
        ],
      }),
    ], NOW), 'update', 'low'));
    // Dźwięk „skończył”: zwykła aktualizacja kafla z alertem o STAŁYCH tekstach,
    // priorytet 10, `apns-expiration` = zegar ścienny + 30 s. Stan z chwili „gotowe”: sesja 15 s po turze
    // z wynikiem nieodebranym obok sesji pracującej.
    const chime = (locKeys: boolean): unknown => frame(apnsLiveActivityRequest(
      {
        ...aggregateState([
          makeSummary({ id: 'demo-rarog', title: 'rarog', state: 'waiting-input', stateSince: startedAt(15_000) }),
          makeSummary({ id: 'demo-atlas', title: 'atlas-web', state: 'running', stateSince: startedAt(300_000) }),
        ], NOW),
        updatedEpoch: NOW_S,
      },
      {
        topic: TOPIC, event: 'update', timestamp: NOW_S, priority: 'high',
        chime: { expiresAtSec: NOW_S + LIVE_ACTIVITY_CHIME_TTL_MS / 1000, locKeys },
      },
    ));
    produced.set('live-activity.update.chime.json', chime(false));
    // Wpis z deklaracją `locKeys`: ten sam dzwonek kluczami katalogu apki.
    produced.set('live-activity.update.chime.loc-keys.json', chime(true));
    // Koniec po 30 min ciszy: ostatnia treść „0 czeka · 0 pracuje", `dismissal-date` = teraz.
    produced.set('live-activity.end.json', live(aggregateState([], NOW), 'end', 'low'));

    if (!WRITE) return;
    for (const [name, value] of produced) writeFileSync(path.join(FIXTURES_DIR, name), serialize(value));
    for (const [name, value] of producedV3) writeFileSync(path.join(FIXTURES_V3_DIR, name), serialize(value));
  }, 60_000);

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Frames of the `apns/` directory: Live Activity frames only, all produced by code. */
  const liveNames = Object.keys(manifest).sort();

  it('code produces exactly the Live Activity frames of the `apns/` manifest', () => {
    expect([...produced.keys()].sort()).toEqual(liveNames);
    for (const entry of Object.values(manifest)) expect(entry.pushType).toBe('liveactivity');
  });

  /** Wariant `locKeys` i jego ramka bazowa: nazwa bez członu `.loc-keys`. */
  const keyedNames = [...Object.entries(manifest), ...Object.entries(manifestV3)]
    .filter(([, entry]) => entry.locKeys === true).map(([name]) => name).sort();

  it('warianty `locKeys`: baner i dzwonek; każdy ma ramkę bazową, od której różni się wyłącznie `aps.alert`', () => {
    expect(keyedNames).toEqual(['alert.blocking.loc-keys.v3.json', 'live-activity.update.chime.loc-keys.json']);
    for (const name of keyedNames) {
      const pick = (file: string): { headers: unknown; payload: { aps: Record<string, unknown> } & Record<string, unknown> } =>
        (producedV3.get(file) ?? produced.get(file)) as never;
      const keyed = pick(name);
      const base = pick(name.replace('.loc-keys', ''));
      expect(base, name).toBeDefined();
      expect(keyed.headers, name).toEqual(base.headers);
      expect({ ...keyed.payload, aps: { ...keyed.payload.aps, alert: base.payload.aps['alert'] } }, name)
        .toEqual(base.payload);
      expect(keyed.payload.aps['alert'], name).not.toEqual(base.payload.aps['alert']);
    }
  });

  it.each(liveNames)('%s: rodzaj ramki z manifestu', (name) => {
    const entry = manifest[name];
    const value = produced.get(name) as { headers: Record<string, string>; payload: { aps: Record<string, unknown> } };
    expect(value.headers['apns-push-type']).toBe(entry?.pushType);
    if (entry?.event !== undefined) expect(value.payload.aps['event']).toBe(entry.event);
  });

  it.each(liveNames)('%s = to, co dziś produkuje kod (odśwież: RAROG_FIXTURES_WRITE=1)', (name) => {
    const stored = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as unknown;
    expect(produced.get(name)).toEqual(stored);
  });

  it('format 3: kod produkuje dokładnie ramki z manifestu `apns-v3/`, same banery', () => {
    expect([...producedV3.keys()].sort()).toEqual(Object.keys(manifestV3).sort());
    for (const entry of Object.values(manifestV3)) expect(entry.pushType).toBe('alert');
  });

  it('weekly limit: expiry one day after the producer clock, collapse key from the reset instant', () => {
    const weekly = producedV3.get('alert.weekly-limit.v3.json') as { headers: Record<string, string> } | undefined;
    expect(weekly?.headers['apns-expiration']).toBe(String(NOW_S + 86400));
    expect(weekly?.headers['apns-collapse-id']).toBe(topicFor(`rarog:weekly-limit:${WEEKLY_RESET}`));
    expect(weekly?.headers['apns-priority']).toBe('10');
  });

  it('stalled wait: one hour in APNs, urgent, own collapse key, thread of the session', () => {
    const stalled = producedV3.get('alert.stalled.v3.json') as
      { headers: Record<string, string>; payload: { aps: Record<string, unknown> } } | undefined;
    expect(stalled?.headers['apns-expiration']).toBe(String(NOW_S + 3600));
    expect(stalled?.headers['apns-priority']).toBe('10');
    expect(stalled?.headers['apns-collapse-id']).toBe(stalledTopicFor('demo-atlas'));
    expect(stalled?.headers['apns-collapse-id']).not.toBe(topicFor('demo-atlas'));
    expect(stalled?.payload.aps['thread-id']).toBe(topicFor('demo-atlas'));
  });

  it.each(Object.keys(manifestV3).sort())('%s = to, co dziś produkuje kod (odśwież: RAROG_FIXTURES_WRITE=1)', (name) => {
    const stored = JSON.parse(readFileSync(path.join(FIXTURES_V3_DIR, name), 'utf8')) as unknown;
    expect(producedV3.get(name)).toEqual(stored);
  });
});
