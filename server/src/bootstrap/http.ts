/**
 * Server start: the HTTP router with the tailnet name reader and the device identity it gets, and the `http.Server`
 * limits and error handler. The HTTP entry points themselves (`createServer`, the `request`
 * and `upgrade` listeners) stay in `server/src/index.ts`, where the review demo guard reads them.
 */
import { hostname } from 'node:os';
import type http from 'node:http';
import type { DeviceStore, LoginLimiter, Pairing } from '../auth/index.ts';
import { redact } from '../auth/index.ts';
import type { CompanionFeature } from '../companion/index.ts';
import type { RarogConfig } from '../config.ts';
import type { DemoReviewConstants } from '../demo/content/types.ts';
import type { DemoNotes } from '../demo/notes.ts';
import { devicePairedNotifier } from '../device-effects.ts';
import type { FileDownloads } from '../files/send-file.ts';
import type { HealthProbes } from '../health.ts';
import type { UploadImage } from '../herdr/uploads.ts';
import type { MacStatsSampler } from '../mac-stats.ts';
import type { ApnsChannel } from '../notify/apns-channel.ts';
import type { Notifier } from '../notify/index.ts';
import type { Presence } from '../notify/presence.ts';
import { createRouter } from '../router.ts';
import type { Logger, RequestHandler, RouterDeps } from '../router.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';
import type { SseHub } from '../sse.ts';
import { tailnetReader } from '../tailnet.ts';
import type { TermFeature } from '../term/index.ts';

export interface RouterAssembly {
  readonly config: RarogConfig;
  readonly manager: ManagerApi;
  readonly hub: SseHub;
  readonly serverStartId: string;
  readonly startedAtMs: number;
  readonly log: Logger;
  readonly health: HealthProbes;
  readonly system: RouterDeps['system'];
  readonly macStats: MacStatsSampler;
  /** Demo plan limits stub, or `undefined` (real status line reader). */
  readonly demoUsage: RouterDeps['usage'];
  /** Demo dictation key stub, or `undefined` (real minter, 503 without a key). */
  readonly demoVoice: RouterDeps['voice'];
  readonly demoNotes: DemoNotes | undefined;
  readonly readUpload: ((cwd: string, name: string) => Promise<UploadImage | null>) | undefined;
  readonly term: TermFeature | null;
  /** Voice agent, or `undefined` when `RAROG_COMPANION` is off or in demo mode. */
  readonly companion: CompanionFeature | undefined;
  /** Presence goes to the router only with a scheduler: `null` = Rarog sends no banners. */
  readonly notifier: Notifier | null;
  readonly presence: Presence;
  readonly apns: ApnsChannel | undefined;
  readonly loginLimiter: LoginLimiter;
  readonly irohPair: RouterDeps['iroh'];
  readonly devices: DeviceStore;
  readonly pairing: Pairing;
  /** Constants of the review demo, or `null` outside it. */
  readonly reviewConstants: DemoReviewConstants | null;
  /**
   * Fixed host data of the demo (the tailnet of the content set and the demo server name), or `null` outside the demo.
   */
  readonly demoHost: DemoHost | null;
  /** The Inbox card tracker (`bootstrap/inbox.ts`); `null` = `RAROG_INBOX=0`, the Inbox routes answer 503. */
  readonly inbox: RouterDeps['inbox'] | null;
  /** Session file downloads in flight: the same registry the unpair effects stop (`startDeviceSweep`). */
  readonly fileDownloads: FileDownloads;
}

/** What the plain demo answers instead of reading the host: no demo mode reveals the machine that runs it. */
export interface DemoHost {
  /** Tailnet name in `GET /api/version` instead of `tailscale status`; `null` = the demo answers `null`. */
  readonly tailnet: string | null;
  /** Server name in the pairing answer instead of `hostname()`. */
  readonly serverName: string;
}

export function buildRouter(assembly: RouterAssembly): RequestHandler {
  const {
    config, manager, hub, serverStartId, startedAtMs, log, health, system, macStats, demoUsage, demoVoice, demoNotes,
    term, companion, notifier, presence, apns, loginLimiter, irohPair, devices, pairing, reviewConstants, demoHost,
    inbox, fileDownloads,
  } = assembly;
  /*
   * Nazwa tailnetu dla nagłówka AGENCI. Czytana LENIWIE i z terminem
   * ważności — `tailnetReader` spawnuje `tailscale status` najwyżej raz na minutę i nigdy
   * nie rzuca, więc `/api/version` nie czeka na `tailscale`, a serwer bez
   * Tailscale'a po prostu mówi `null`.
   * No demo mode runs `tailscale status`: the review mode has no reader at all (the router answers `null`), the
   * plain demo answers with the fixed name of its content set, also when that name is `null`. The branch goes by
   * `demoHost`, never by its value: a `null` name must not fall through to `tailnetReader()`.
   */
  const tailnet = reviewConstants !== null ? undefined
    : demoHost !== null ? () => Promise.resolve(demoHost.tailnet) : tailnetReader();

  return createRouter({
    config, manager, hub, serverStartId, startedAtMs, logger: log, health, system, fileDownloads,
    ...(tailnet === undefined ? {} : { tailnet }),
    mac: () => macStats.current(),
    ...(demoUsage === undefined ? {} : { usage: demoUsage }),
    ...(demoVoice === undefined ? {} : { voice: demoVoice }),
    ...(demoNotes === undefined ? {} : { notes: demoNotes }),
    ...(assembly.readUpload === undefined ? {} : { readUpload: assembly.readUpload }),
    ...(term !== null ? { term } : {}),
    ...(companion === undefined ? {} : { companion }),
    // Rejestr obecności jedzie do routera TYLKO wtedy, gdy Rarog faktycznie pushuje (jest kanał
    // APNs) — bez kanału nie ma czego bramkować, a beacon staje się no-opem (patrz `RouterDeps`).
    ...(notifier !== null ? { presence } : {}),
    ...(apns !== undefined ? { apns } : {}),
    ...(inbox === null || inbox === undefined ? {} : { inbox }),
    loginLimiter,
    iroh: irohPair,
    devices: {
      store: devices,
      pairing,
      serverName: reviewConstants?.serverName ?? demoHost?.serverName ?? hostname().replace(/\.local$/, ''),
      // Push bezpieczeństwa do pozostałych aktywnych urządzeń — reguła w `device-effects.ts`.
      onPaired: devicePairedNotifier(devices, apns?.sink, (line) => { log.info(line); }),
    },
  });
}

/** Timeouts for long SSE streams and the start error handler of the TCP listener. */
export function configureHttpServer(server: http.Server, config: RarogConfig, log: Logger): void {
  // SSE trzyma połączenie w nieskończoność — domyślne timeouty Node musiałyby je zrywać.
  // `requestTimeout` nie rozróżnia GET-a SSE od POST-a z ciałem, więc zostaje wyłączony,
  // a sufit czasu na odebranie CIAŁA żądania pilnuje `readBody` (`BODY_TIMEOUT_MS` w routerze).
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 76_000;

  // Bez tego `listen` na zajętym porcie leci jako nieobsłużony 'error' i użytkownik dostaje
  // surowy stack trace Node zamiast informacji, co zrobić.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(
        `Port ${String(config.port)} on ${config.host} is in use;`
        + ' is another Rarog running? Stop it or set RAROG_PORT.',
      );
    } else {
      log.error(`HTTP server error: ${redact(err)}`);
    }
    process.exit(1);
  });
}
