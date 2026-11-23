/**
 * Server start: device keys and pairing. The store, the pairing codes and the one failure limiter, and the
 * expiry sweep that runs on its own once the hub, the terminal and the APNs channel exist.
 */
import { createDeviceStore, createLoginLimiter, createPairing, devicesFileName } from '../auth/index.ts';
import type { DeviceStore, LoginLimiter, Pairing } from '../auth/index.ts';
import type { RarogConfig } from '../config.ts';
import { attachDeactivation } from '../device-effects.ts';
import type { DeactivationTargets } from '../device-effects.ts';
import type { Logger } from '../router.ts';

/**
 * Co ile przebieg wygasania kluczy urządzeń chodzi sam, bez żądań: sierota po zgubionej odpowiedzi
 * `/api/pair` ma zniknąć po 10 min także wtedy, gdy nikt o nią nie pyta, a odpięcie wygasłego urządzenia
 * zamyka jego połączenia i kasuje tokeny APNs. Kilka rekordów — przebieg kosztuje pętlę po mapie.
 */
export const DEVICE_SWEEP_MS = 60_000;

export interface DeviceAuth {
  readonly loginLimiter: LoginLimiter;
  readonly devices: DeviceStore;
  readonly pairing: Pairing;
}

export function createDeviceAuth(config: RarogConfig, log: Logger): DeviceAuth {
  /*
   * Klucze urządzeń i parowanie. Magazyn czyta `devices.json` RAZ, synchronicznie, przed
   * terminalem i routerem — obie bramki (`authenticate`) pytają ten sam obiekt. Dławik porażek jest
   * JEDEN dla routera i upgrade'u terminala, bo nieznany klucz w SSE, REST i WebSockecie to ta sama
   * próba. Słuchacz odpięć powstaje później ({@link startDeviceSweep}), gdy istnieją już hub SSE, terminal i kanał
   * APNs.
   * The plain demo reads and writes `devices.demo.json`, never `devices.json` ({@link devicesFileName}).
   */
  const loginLimiter = createLoginLimiter();
  const devices = createDeviceStore({
    dataDir: config.dataDir, fileName: devicesFileName(config), epoch: config.epoch,
    log: (line) => { log.info(line); },
  });
  const pairing = createPairing({ store: devices, epoch: config.epoch });
  return { loginLimiter, devices, pairing };
}

/** Attaches the unpair effects, runs the first sweep and starts the periodic one; `shutdown` clears the timer. */
export function startDeviceSweep(
  devices: DeviceStore, targets: DeactivationTargets,
): ReturnType<typeof setInterval> {
  /*
   * Odpięcie urządzenia (CLI, „Zapomnij serwer”, wygaśnięcie, stara epoka) — jedno miejsce skutków
   * (`device-effects.ts`): kody parowania tego twórcy, trwające strumienie SSE i terminale, pytania agenta głosowego,
   * tokeny APNs.
   */
  attachDeactivation(devices, targets);
  // Pierwszy przebieg PO podpięciu słuchacza: rekord ze starej epoki ma zamknąć wszystko, co do niego należy.
  devices.sweep();
  const deviceSweep = setInterval(() => { devices.sweep(); }, DEVICE_SWEEP_MS);
  deviceSweep.unref();
  return deviceSweep;
}
