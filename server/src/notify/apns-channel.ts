/**
 * Złożenie kanału APNs apki natywnej — rejestr urządzeń, nadajnik (z fabryki `sender.ts`),
 * sink banerów, sterownik Live Activity i przepustki przekaźnika powstają RAZEM i WYŁĄCZNIE tutaj.
 *
 * Jedna bramka na wszystko, co wychodzi do APNs: `pushEnabled` (czyli `RAROG_PUSH` ≠ `0` i nie
 * demo) ORAZ któraś droga: komplet `RAROG_APNS_*` z kluczem, który przeszedł kontrolę, ALBO przekaźnik
 * (`RAROG_PUSH_RELAY_URL`; kanał jest, gdy jest którykolwiek nadajnik). Bez niej nie
 * powstaje ani plik `apns-devices.json`, ani połączenie, ani timer Live Activity — ani poller limitów planu
 * (`live-activity-limits.ts`), który kafel v2 czyta przy wysyłce — `RAROG_PUSH=0` gasi banery
 * i aktywności jednym ruchem (test: `server/test/notify-apns-channel.test.ts`). Trasy
 * `/api/push/apns*` i `/api/push/live-activity*` są wtedy no-opem (router).
 *
 * The weekly-limit signal (`weekly-limit.ts`) lives here too, next to the limits poller: the poller's
 * `onPoll` hands it the weekly windows, it sends through the sink. Without the channel there is neither the signal
 * nor its file `weekly-limit-alerts.json`. {@link ApnsChannel.close} closes in order: the poller, then the signal's
 * chain (a send in flight and its write, at most `WEEKLY_LIMIT_CLOSE_MS`), then the passes and the sender.
 *
 * Próbnik obciążenia Maca (`mac-stats.ts`) NIE należy do kanału: zakłada go i zamyka `index.ts`,
 * bo czyta go też `GET /api/mac` — także przy `RAROG_PUSH=0` i bez APNs. Kanał dostaje sam odczyt.
 *
 * Temat APNs: sink i Live Activity biorą go z WPISU urządzenia (`apnsTopicOf`, `apns-devices.ts`), nie
 * z kanału. Temat kanału podaje się wyłącznie routerowi, który przepuszcza tylko rejestrację z tym tematem:
 * przy kluczu `RAROG_APNS_TOPIC`, bez klucza — temat apki przekaźnika z jednego źródła (`RELAY_APP_TOPIC`
 * w `shared/src/relay.ts`, strażnik tożsamości).
 *
 * Apka dostaje cel tapnięcia w ładunku (`rarog.sessionId`, `top.sessionId` aktywności), nie adres,
 * więc kanał nie potrzebuje originu z `RAROG_ORIGINS`.
 *
 * Treść banera szyfrowana end-to-end: sink dostaje flagę `RAROG_PUSH_E2E` (`pushE2e`) i migawkę aktywnych
 * urządzeń z magazynu kluczy (`devices.json`) — z niej klucz push wpisu z deklaracją v2 i filtr tokenów
 * odpiętych urządzeń. Magazyn zakłada `index.ts` przed kanałem; kanał woła wyłącznie jego `active()`.
 */
import type { SessionSummary } from '@rarog/shared';
import type { DeviceStore } from '../auth/index.ts';
import { RELAY_APP_TOPIC } from '@rarog/shared/relay';
import type { RarogConfig } from '../config.ts';
import type { MacStats } from '../mac-stats.ts';
import type { ApnsFeature } from '../router.ts';
import type { ApnsSender, ApnsSenderOptions } from './apns.ts';
import { createApnsDeviceStore } from './apns-devices.ts';
import { createApnsSink } from './apns-sink.ts';
import type { ActivePushKeys, ApnsSink } from './apns-sink.ts';
import { createLiveActivity } from './live-activity.ts';
import type { LiveActivityController } from './live-activity.ts';
import { createLimitsPoller } from './live-activity-limits.ts';
import type { LimitsPoller } from './live-activity-limits.ts';
import { createRelayPasses } from './relay-pass.ts';
import type { RelayPasses } from './relay-pass.ts';
import { createRelayClient } from './relay-sender.ts';
import { createSender } from './sender.ts';
import type { PushSender } from './sender.ts';
import { createWeeklyLimitAlert } from './weekly-limit.ts';

/** Kanał w komplecie: to, co dostaje router, plus to, czego potrzebują harmonogram i zamykanie. */
export interface ApnsChannel extends ApnsFeature {
  readonly sender: PushSender;
  readonly sink: ApnsSink;
  readonly liveActivity: LiveActivityController;
  /** Przepustki przekaźnika; brak = serwer bez `RAROG_PUSH_RELAY_URL`. `start` woła `bootstrap/push.ts`, `close` — {@link close}. */
  readonly passes?: RelayPasses;
  /**
   * Closes the channel for the server shutdown: the Live Activity with the limits poller, then waits for the
   * weekly-limit signal, then the passes and the sender. Resolves at the latest after `WEEKLY_LIMIT_CLOSE_MS`.
   */
  close(): Promise<void>;
}

export interface ApnsChannelDeps {
  /** Lista sesji managera w chwili przeliczenia — leniwie, bo manager powstaje PO kanale. */
  readonly sessions: () => readonly SessionSummary[];
  readonly log: (line: string) => void;
  /** Bieżący odczyt WSPÓLNEGO próbnika obciążenia Maca (`index.ts`); kanał go nie zakłada ani nie zamyka. */
  readonly mac: () => MacStats;
  /**
   * Magazyn kluczy urządzeń — źródło migawki aktywnych urządzeń dla sinka: klucz push wpisu z v2
   * i pominięcie tokenów odpiętych. Kanał go nie zakłada ani nie zamyka.
   */
  readonly pairedDevices: Pick<DeviceStore, 'active'>;
  /**
   * Poller limitów planu z paska statusu; `onChange` budzi przeliczenie kafla, `onPoll` (after every read) hands the
   * weekly windows to the weekly-limit signal.
   */
  readonly limitsPoller?: (onChange: () => void, onPoll: () => void) => LimitsPoller;
  /** `fetch` klienta przekaźnika — podmiana wyłącznie w testach (atrapa przekaźnika bez sieci). */
  readonly relayFetch?: typeof globalThis.fetch;
  /** Fabryka nadajnika bezpośredniego — podmiana wyłącznie w testach. */
  readonly direct?: (options: ApnsSenderOptions) => ApnsSender;
  /** Zegar kanału (rejestr, przepustki, nadajnik) — wyłącznie testy. */
  readonly now?: () => number;
}

export function createApnsChannel(
  config: Pick<RarogConfig, 'pushEnabled' | 'pushE2e' | 'apns' | 'pushRelay' | 'dataDir'>, deps: ApnsChannelDeps,
): ApnsChannel | undefined {
  const { apns, pushRelay } = config;
  if (!config.pushEnabled || (apns === undefined && pushRelay === undefined)) return undefined;
  const clock = deps.now === undefined ? {} : { now: deps.now };
  const devices = createApnsDeviceStore({ dataDir: config.dataDir, logger: deps.log, ...clock });
  const relay = pushRelay === undefined ? undefined : createRelayClient({
    origin: pushRelay.origin, log: deps.log, ...clock,
    ...(deps.relayFetch === undefined ? {} : { fetch: deps.relayFetch }),
  });
  // Przepustki powstają po sterowniku Live Activity (budzą jego tory), a nadajnik woła je przy odpowiedzi — późne wiązanie.
  let passes: RelayPasses | undefined;
  // Czym wysłać, rozstrzyga fabryka (`sender.ts`) per wysyłka; kanał pilnuje tylko bramki wyżej.
  const sender = createSender(apns === undefined ? {} : { apns }, {
    log: deps.log, devices, passes: () => passes, ...clock,
    ...(relay === undefined ? {} : { relay }),
    ...(deps.direct === undefined ? {} : { direct: deps.direct }),
  });
  const sink = createApnsSink({
    sender, devices, log: deps.log, ...clock,
    activeDevices: () => activePushKeys(deps.pairedDevices), e2e: config.pushE2e,
  });
  // Za bramką: bez kanału nie ma kafla, więc nie ma po co czytać zrzutów paska statusu.
  let poke: () => void = () => {};
  const weeklyLimit = createWeeklyLimitAlert({
    dataDir: config.dataDir, send: (content) => sink.send(content), log: deps.log, ...clock,
  });
  let limits: LimitsPoller | undefined;
  limits = (deps.limitsPoller ?? ((onChange, onPoll) => createLimitsPoller({ onChange, onPoll })))(
    () => { poke(); },
    () => { if (limits !== undefined) weeklyLimit.check(limits.weeklyWindows()); },
  );
  const poller = limits;
  const liveActivity = createLiveActivity({
    devices, sender, sessions: deps.sessions, log: deps.log,
    limits: () => poller.current(), mac: deps.mac,
    onClose: () => { poller.close(); },
    ...clock,
  });
  poke = () => { liveActivity.poke(); };
  passes = relay === undefined ? undefined : createRelayPasses({
    devices, client: relay, log: deps.log, ...clock,
    onPass: (deviceToken) => { liveActivity.passReady(deviceToken); },
  });
  const relayPasses = passes;
  return {
    devices, sender, sink, liveActivity,
    ...(relayPasses === undefined ? {} : { passes: relayPasses }),
    topic: apns?.topic ?? RELAY_APP_TOPIC,
    async close() {
      // The poller first (through the Live Activity), so no reading wakes the signal; the sender last, so a send in
      // flight and its key write finish.
      liveActivity.close();
      await weeklyLimit.close();
      relayPasses?.close();
      sender.close();
    },
  };
}

/** Migawka aktywnych urządzeń: `deviceId` → klucz push i `kid` (przebieg wygasania odpala `active()`). */
export function activePushKeys(store: Pick<DeviceStore, 'active'>): ActivePushKeys {
  return new Map(store.active().map((record) => [record.id, { pushKey: record.pushKey, kid: record.kid }]));
}
