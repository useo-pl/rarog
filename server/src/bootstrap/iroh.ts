/**
 * Server start: the iroh listener next to TCP (`RAROG_IROH=1`). `main()` in `server/src/index.ts` calls it before
 * anything else, so the router knows the EndpointId from the first request.
 */
import type http from 'node:http';
import { redact } from '../auth/index.ts';
import { ConfigError, logSecrets } from '../config.ts';
import type { RarogConfig } from '../config.ts';
import { IROH_ENV, IROH_KEY_ENV } from '../config-env.ts';
import { startIroh } from '../iroh/listener.ts';
import type { IrohListener } from '../iroh/listener.ts';
import type { Logger } from '../router.ts';

/**
 * Nasłuch iroh przy `RAROG_IROH=1` albo `null`. Brak klucza to {@link ConfigError}; porażka otwarcia endpointu
 * (brak modułu natywnego, paczka platformy, zajęty port UDP) to zdanie na stderr i kod 1.
 */
export async function startServerIroh(
  config: RarogConfig, server: http.Server, log: Logger,
): Promise<IrohListener | null> {
  if (config.iroh === null) return null;
  if (config.iroh.key === null) {
    throw new ConfigError(`${IROH_ENV}=1 without ${IROH_KEY_ENV}: the iroh server key comes from the secrets file or`
      + ' from service.wrapper (new key: openssl rand -hex 32).');
  }
  try {
    return await startIroh({
      secretKey: Buffer.from(config.iroh.key, 'hex'), relay: config.iroh.relay, port: config.iroh.port,
    }, server, log);
  } catch (err: unknown) {
    // Samo zdanie z błędu (`IrohLoadError`, „iroh: endpoint did not start…”), bez stosu; klucz wymazany na wszelki wypadek.
    log.error(`Could not start: ${redact(err instanceof Error ? err.message : String(err), logSecrets(config))}`);
    process.exit(1);
  }
}
