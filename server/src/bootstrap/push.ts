/**
 * Server start: push notifications. Presence, the APNs channel of the native app and the banner scheduler, with
 * the start log lines of the push path. `main()` in `server/src/index.ts` calls it before the manager; the manager
 * comes in late through `managerRef`.
 */
import type { DeviceStore } from '../auth/index.ts';
import type { RarogConfig } from '../config.ts';
import type { MacStatsSampler } from '../mac-stats.ts';
import { createApnsChannel } from '../notify/apns-channel.ts';
import type { ApnsChannel } from '../notify/apns-channel.ts';
import { createFanoutSink } from '../notify/fanout.ts';
import { Notifier, sessionLook } from '../notify/index.ts';
import { Presence } from '../notify/presence.ts';
import type { Logger } from '../router.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';

/** Start log phrase when `RAROG_PUSH_RELAY_URL` has a bad value (`docs/server-config.md`). */
export const PUSH_RELAY_DISABLED_LOG = 'push: push relay off';

export interface PushDeps {
  /** The manager, once it exists: `main()` creates it after push, so every read goes through this getter. */
  readonly managerRef: () => ManagerApi | null;
  /** Device key store: push keys of devices and the filter of unpaired tokens. */
  readonly devices: DeviceStore;
  /** The one Mac load sampler of the process; push reads it and never closes it. */
  readonly macStats: MacStatsSampler;
  readonly log: Logger;
}

export interface Push {
  readonly presence: Presence;
  /** `undefined` = no APNs channel (demo, no complete `RAROG_APNS_*` and no relay, or `RAROG_PUSH=0`). */
  readonly apns: ApnsChannel | undefined;
  /** `null` = Rarog sends no banners; exists only with the APNs channel. */
  readonly notifier: Notifier | null;
}

export function createPush(config: RarogConfig, deps: PushDeps): Push {
  const { managerRef, devices, macStats, log } = deps;
  /*
   * Powiadomienia — banery z Raroga jedynym kanałem: APNs apki
   * natywnej.
   *
   * Kolejność jest wymuszona cyklem: harmonogram musi umieć zapytać managera o AKTUALNY stan
   * sesji w chwili sprawdzenia, a manager musi znać harmonogram, żeby go zawiadamiać o zmianach.
   * Rozwiązane referencją domykaną (`managerRef`), bo alternatywa — setter po konstrukcji —
   * dawałaby okno, w którym manager już zmienia stany, a harmonogram jeszcze nie widzi sesji.
   *
   * `null` znaczy „Rarog nie pushuje" i jest stanem NORMALNYM: demo, brak kompletu
   * `RAROG_APNS_*` w `env -i`, killswitch `RAROG_PUSH=0`. Nigdy błąd startu. Sam `managerRef` stoi w `main()`,
   * przed cyklem kanału zgód.
   */
  /*
   * Powrót do Raroga kasuje wszystkie czekające wysyłki.
   * Late-bound z tego samego powodu co `managerRef`: rejestr obecności powstaje PRZED
   * harmonogramem, bo harmonogram go potrzebuje w konstruktorze.
   */
  let onPresenceBack: () => void = () => {};
  const presence = new Presence({
    log: (line) => { log.info(line); },
    onActive: () => { onPresenceBack(); },
  });

  /*
   * Kanał APNs apki natywnej — rejestr urządzeń, nadajnik złożony (klucz i przekaźnik), sink
   * banerów, sterownik Live Activity i przepustki powstają TYLKO z kompletem `RAROG_APNS_*` albo
   * `RAROG_PUSH_RELAY_URL` i włączonym kanałem (`notify/apns-channel.ts`); bez tego plik `apns-devices.json`
   * nie powstaje, a trasy
   * `/api/push/apns*` i `/api/push/live-activity*` są no-opem. Lista sesji idzie leniwie przez
   * `managerRef` — manager powstaje dopiero po kanale.
   */
  const apns = createApnsChannel(config, {
    sessions: () => managerRef()?.list() ?? [],
    log: (line) => { log.info(line); },
    mac: () => macStats.current(),
    // Klucze push urządzeń i filtr tokenów odpiętych: magazyn `devices.json` powstał wcześniej.
    pairedDevices: devices,
  });
  /*
   * Harmonogram powstaje WYŁĄCZNIE z kanałem APNs — to jedyny kanał zdolny wysłać baner. Bez
   * niego nie ma też obecności w routerze (`main()`), więc `POST /api/presence` jest no-opem.
   */
  const notifier = apns !== undefined
    ? new Notifier({
      presence,
      log: (line) => { log.info(line); },
      // Dźwięk „skończył” z kafla Live Activity: zlecany przy wysłanym „gotowe”.
      sink: createFanoutSink({ apns: apns.sink, chime: () => apns.liveActivity.chime() }),
      look: (id) => sessionLook(managerRef()?.get(id)),
      // Plakietka na ikonie = sesje, które STOJĄ i czekają na człowieka (`waiting-permission`
      // i `waiting-question`). Liczona w chwili WYSYŁKI.
      badge: () => (managerRef()?.list() ?? [])
        .filter((s) => s.state === 'waiting-permission' || s.state === 'waiting-question').length,
    })
    : null;
  if (notifier !== null && apns !== undefined) {
    // Powrót do Raroga kasuje czekające banery i dźwięki kafla, które jeszcze nie wyszły.
    const liveActivity = apns.liveActivity;
    onPresenceBack = (): void => {
      notifier.clearAll();
      liveActivity.cancelChimes();
    };
  }
  if (config.apnsIssue !== undefined) log.info(`push: APNs off — ${config.apnsIssue}`);
  if (config.pushRelayIssue !== undefined) log.info(`${PUSH_RELAY_DISABLED_LOG} — ${config.pushRelayIssue}`);
  if (apns === undefined) {
    log.info('push: notifications off (no complete RAROG_APNS_* set and no RAROG_PUSH_RELAY_URL, or RAROG_PUSH=0)');
  } else {
    // Liczba urządzeń i drogi, nigdy etykiety, tokeny ani przepustki. Origin przekaźnika to nie sekret.
    log.info(`push: notifications ON (APNs: ${String(apns.devices.size)}, key: `
      + `${config.apns === undefined ? 'no' : 'yes'}, push relay: ${config.pushRelay?.origin ?? 'no'}, `
      + `E2E: ${config.pushE2e ? 'yes' : 'no (RAROG_PUSH_E2E=0)'})`);
    // Przepustki dla wpisów, które ich nie mają albo którym kończy się termin; bez przekaźnika — nic.
    apns.passes?.start();
  }
  return { presence, apns, notifier };
}
