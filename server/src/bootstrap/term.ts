/**
 * Server start: the terminal feature (`RAROG_TERM=1`), loaded lazily with its own herdr socket. `main()` in
 * `server/src/index.ts` builds it before the router, which needs to know whether the terminal exists.
 */
import { redact } from '../auth/index.ts';
import type { DeviceStore, LoginLimiter } from '../auth/index.ts';
import type { RarogConfig } from '../config.ts';
import type { Logger } from '../router.ts';
import type { TermFeature } from '../term/index.ts';

/**
 * Ładuje moduł terminala — DYNAMICZNIE i tylko przy `RAROG_TERM=1` (wzorzec launchera herdr).
 *
 * Powód leniwego importu: wyłączony ficzer nie ma prawa wciągać do procesu ani transportu WS,
 * ani drugiego gniazda herdr, a awaria SAMEGO modułu (`catch` niżej) ma gasić terminal,
 * a nie wywracać start serwera.
 */
export async function loadTerm(
  config: RarogConfig, log: Logger,
  auth: { devices: DeviceStore; limiter: LoginLimiter },
): Promise<TermFeature | null> {
  if (!config.termEnabled) return null;
  try {
    const mod = await import('../term/index.ts');
    /*
     * Backend panelowy potrzebuje WŁASNEGO klienta gniazda herdr i dostaje go tutaj, a nie
     * z nadzorcy: terminal ładuje się leniwie (linia wyżej), a nadzorca składa swój kanał
     * tworzenia w `herdr/supervisor.ts` i nigdzie go nie wystawia. Osobne gniazdo kosztuje
     * jedno połączenie na żądanie (herdr: „jedno żądanie na połączenie") i jest ceną tego,
     * że terminal nie przewierca publicznego kontraktu nadzorcy.
     *
     * `sendEnabled` idzie z configu, więc `RAROG_HERDR_SEND=0` blokuje mutacje TĄ SAMĄ
     * bramką co resztę integracji (`readOnly` w `socket.ts`), a nie osobnym warunkiem.
     */
    const [socketMod, clientMod] = await Promise.all([
      import('../herdr/socket.ts'),
      import('../herdr/client.ts'),
    ]);
    const socket = socketMod.createHerdrSocket({
      socketPath: config.herdrSocket, sendEnabled: config.herdrSend,
    });
    const launchClient = clientMod.createHerdrLaunchClient(socket);
    const feature = await mod.createTermFeature(config, log, {
      herdrLaunchClient: () => launchClient,
      // Ta sama bramka co router: klucz urządzenia, wspólny dławik porażek.
      devices: auth.devices,
      limiter: auth.limiter,
    });
    if (feature === null) {
      socket.dispose();
      return null;
    }
    // Gniazdo ginie razem z ficzerem — inaczej `dispose()` serwera zostawiałby otwarty
    // kanał do demona sterującego panelami użytkownika.
    return { ...feature, dispose: () => { feature.dispose(); socket.dispose(); } };
  } catch (err: unknown) {
    log.error(`term: module unavailable (${redact(err)}); the terminal is OFF.`);
    return null;
  }
}
