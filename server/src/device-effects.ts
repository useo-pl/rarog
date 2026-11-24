/**
 * Skutki tożsamości urządzeń poza `auth/`: co się dzieje z resztą serwera, gdy urządzenie zostaje
 * odpięte i gdy sparowano nowe. Osobny moduł, bo `index.ts` uruchamia serwer przy imporcie, a te dwie
 * reguły mają testy (`devices-pairing.test.ts`).
 *
 * - {@link attachDeactivation}: odpięcie (komenda `rarog`, „Zapomnij serwer”, wygaśnięcie, stara epoka) unieważnia
 *   kody parowania tego twórcy, zamyka trwające strumienie SSE i otwarte terminale (samo sprawdzenie poświadczenia
 *   przy otwarciu ich nie odcina), zabija pytania agenta głosowego w locie, zdejmuje urządzenie z połączeń iroh
 *   (`revokeDevice`: połączenie bez urządzenia traci limity uwierzytelnionego i ochronę przed wyparciem) i kasuje
 *   tokeny APNs urządzenia — po wcześniejszym zakończeniu jego Live Activity, póki token aktywności jest znany.
 *   It also cuts the device's session file downloads in flight: each response is destroyed and its file closed.
 * - {@link devicePairedNotifier}: po sparowaniu pozostałe AKTYWNE urządzenia dostają push `device-paired`;
 *   tylko tokeny zarejestrowane kluczem urządzenia (`deviceId`), bo „urządzenie” = rekord z parowania,
 *   a `alerts: true` filtruje sink. Best-effort — trwały ślad niesie `GET /api/devices`.
 */
import type { DeviceRecord, DeviceStore, Pairing } from './auth/index.ts';
import { redact } from './auth/index.ts';
import type { ApnsDeviceStore } from './notify/apns-devices.ts';
import type { ApnsSink } from './notify/apns-sink.ts';
import { buildDevicePairedContent } from './notify/content.ts';
import type { LiveActivityController } from './notify/live-activity.ts';
import { revokeDevice } from './iroh/socket.ts';

/** To, co odpięcie zamyka i kasuje. Brak pola = tej części serwera nie ma (terminal, kanał APNs). */
export interface DeactivationTargets {
  readonly pairing: Pairing;
  readonly hub: { closeOwner(owner: string): number };
  readonly term?: { closeOwner(owner: string): number } | undefined;
  /** Voice agent: kills the device's questions in flight; the route closes their responses. */
  readonly companion?: { closeOwner(owner: string): number } | undefined;
  /** Session file downloads in flight (`files/send-file.ts`): destroys their responses and closes their files. */
  readonly files?: { closeOwner(owner: string): number } | undefined;
  readonly apns?: {
    readonly devices: Pick<ApnsDeviceStore, 'list' | 'removeOwnedBy'>;
    readonly liveActivity: Pick<LiveActivityController, 'forgetDevice'>;
  } | undefined;
  readonly log: (line: string) => void;
}

/** Podpina skutki odpięcia pod magazyn; zwraca funkcję odpinającą słuchacza. */
export function attachDeactivation(store: DeviceStore, targets: DeactivationTargets): () => void {
  return store.onDeactivate(({ ids, by }) => {
    for (const id of ids) {
      targets.pairing.invalidateCreator(id);
      const streams = targets.hub.closeOwner(id);
      const sockets = targets.term?.closeOwner(id) ?? 0;
      const questions = targets.companion?.closeOwner(id) ?? 0;
      const downloads = targets.files?.closeOwner(id) ?? 0;
      revokeDevice(id);
      let tokens = 0;
      const apns = targets.apns;
      if (apns !== undefined) {
        for (const record of apns.devices.list()) {
          if (record.deviceId === id) apns.liveActivity.forgetDevice(record.token);
        }
        tokens = apns.devices.removeOwnedBy(id).length;
      }
      targets.log(`devices: ${id} revoked (${by}) — streams: ${String(streams)},`
        + ` consoles: ${String(sockets)}, APNs tokens: ${String(tokens)}, voice agent: ${String(questions)},`
        + ` file downloads: ${String(downloads)}`);
    }
  });
}

/** `onPaired` dla routera: push `device-paired` do pozostałych aktywnych urządzeń. Nigdy nie rzuca. */
export function devicePairedNotifier(
  store: DeviceStore,
  sink: Pick<ApnsSink, 'sendWhere'> | undefined,
  log: (line: string) => void,
): (record: DeviceRecord) => void {
  return (record) => {
    if (sink === undefined) return;
    const others = new Set(store.active().map((r) => r.id).filter((id) => id !== record.id));
    if (others.size === 0) return;
    void sink.sendWhere(
      buildDevicePairedContent(record.label),
      (entry) => others.has(entry.deviceId),
    ).then(
      (outcome) => { log(`push: new device paired → ${outcome}`); },
      (err: unknown) => { log(`push: new device paired: ${redact(err)}`); },
    );
  };
}
