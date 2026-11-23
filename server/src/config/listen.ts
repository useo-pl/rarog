/**
 * Listening address, the Origin allow list and the iroh listener: constants and parsers for `loadConfig`
 * (`server/src/config.ts`). Like every module in `server/src/config/`, it never reads the environment: `config.ts`
 * reads it through `readEnv` and passes the values in.
 */
import { irohRelayUrl } from '@rarog/shared/pairing-link';
import { ConfigError, IROH_ENV, IROH_KEY_ENV, IROH_PORT_ENV, IROH_RELAY_ENV } from '../config-env.ts';

/** Host jest hardcode'owany — nasłuch wystawia Caddy/tailnet, nigdy sam serwer. */
export const RAROG_HOST = '127.0.0.1' as const;

/** Domyślny port backendu. */
export const DEFAULT_PORT = 8930;

/** Twardy limit ciała requestu (dotyczy też /api/client-log). */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Origin allow-lista demo bez `RAROG_ORIGINS`: WŁASNY adres serwera pod dwoma zapisami loopbacku.
 * Tyle wysyła klient, który rozmawia z demo wprost — apka pod XCUITest podaje `Origin` swojego
 * adresu bazowego. Originów vite dev (5273) tu nie ma, bo nie ma PWA.
 */
export function demoOrigins(port: number): readonly string[] {
  const withPort = [`http://localhost:${String(port)}`, `http://127.0.0.1:${String(port)}`];
  // Origin portu domyślnego schematu nie niesie numeru (`http://127.0.0.1`, nie `…:80`).
  return port === 80 ? [...withPort, 'http://localhost', 'http://127.0.0.1'] : withPort;
}

/** Nasłuch iroh: tożsamość serwera, relay i port UDP. */
export interface IrohConfig {
  /**
   * Klucz tajny serwera (`RAROG_IROH_KEY`, 64 znaki hex, sekret: lista {@link logSecrets}). `null` = brak w tym
   * środowisku: przechodzi wyłącznie wstępne `rarog serve --check` przy `service.wrapper`, start serwera odmawia.
   */
  readonly key: string | null;
  /** Relay w postaci kanonicznej `irohRelayUrl`, ten sam co pole `r=` linku parowania. */
  readonly relay: string;
  /** Stały port UDP; `null` = port od systemu. */
  readonly port: number | null;
}

/**
 * Waliduje host nasłuchu. Jedyna dozwolona wartość to 127.0.0.1 — ekspozycja na świat
 * jest zadaniem Caddy, nie serwera (test speca: bind ≠ 127.0.0.1 odrzucony).
 */
export function assertLoopbackHost(host: string): asserts host is typeof RAROG_HOST {
  if (host !== RAROG_HOST) {
    throw new ConfigError(
      `The Rarog server listens only on ${RAROG_HOST} (got: ${host}).`,
    );
  }
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`RAROG_PORT must be a number 0–65535 (got: ${raw}).`);
  }
  return port;
}

/** The Origin allow list and the `RAROG_ORIGINS` entries left out of it. */
export interface OriginList {
  readonly allowed: readonly string[];
  /** Entries that are not an origin in the form a browser sends; they never reach `allowed`. */
  readonly skipped: readonly string[];
}

/**
 * An entry is an origin when it is exactly what a browser sends in `Origin` for an http or https page: lowercase
 * scheme and host, no path or trailing slash, no default port. Anything else (`null`, `*`, …) would either never
 * match or, for `null`, match a sandboxed frame or a `file:` page of any site.
 */
function isOrigin(entry: string): boolean {
  if (!URL.canParse(entry)) return false;
  const url = new URL(entry);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === entry;
}

/**
 * Log and `rarog serve --check` line for one skipped `RAROG_ORIGINS` entry. The entry is JSON-quoted, so a control
 * character in the configuration cannot shape the log.
 */
export function skippedOriginLine(entry: string): string {
  return `RAROG_ORIGINS: skipped ${JSON.stringify(entry)}, not an http or https origin as a browser sends it`
    + ' (scheme://host[:port] in lowercase, no path, no default port)';
}

/**
 * A non-origin entry is skipped, never a refusal: such an entry never matched a real `Origin` except `null`, so an
 * installation that has one works today (e.g. over iroh) and keeps working; the caller reports `skipped`.
 */
export function parseOrigins(raw: string | undefined, demo: boolean, port: number, iroh: boolean): OriginList {
  if (raw !== undefined && raw.trim() !== '') {
    const list = raw.split(',').map((o) => o.trim()).filter((o) => o !== '');
    if (list.length === 0) {
      throw new ConfigError('RAROG_ORIGINS contains no valid origin.');
    }
    return { allowed: list.filter(isOrigin), skipped: list.filter((entry) => !isOrigin(entry)) };
  }
  if (demo) {
    // `listen(0)` dostaje port od systemu dopiero przy starcie — tu go nie znamy, a allow-lista
    // z `:0` nie pasowałaby do niczego i każde logowanie kończyłoby się 403.
    if (port === 0) {
      throw new ConfigError('Demo with RAROG_PORT=0 needs an explicit RAROG_ORIGINS (the system assigns the port).');
    }
    return { allowed: demoOrigins(port), skipped: [] };
  }
  // Z iroh serwer ma drogę bez adresu WWW: pusta lista = mutacje po TCP dostają 403, apka jedzie po iroh.
  if (iroh) return { allowed: [], skipped: [] };
  throw new ConfigError(
    'Outside demo mode RAROG_ORIGINS is required (a comma-separated list of origins).',
  );
}

/** Klucz serwera iroh: 32 bajty jako 64 znaki hex (`openssl rand -hex 32`). */
const IROH_KEY_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Nasłuch iroh. Wszystkie cztery nazwy są czytane zawsze (strażnik rejestru wymaga odczytu każdego wpisu),
 * a sprawdzane tylko przy `RAROG_IROH=1`. Treść błędu nigdy nie zawiera klucza.
 */
export function parseIroh(
  flag: string | undefined, key: string | undefined, relay: string | undefined, port: string | undefined,
  demo: boolean,
): IrohConfig | null {
  const value = flag?.trim() ?? '';
  if (value === '' || value === '0') return null;
  if (value !== '1') throw new ConfigError(`${IROH_ENV} takes 1 or 0 (got: ${value}).`);
  // Ścieżka parowania demo stoi przed bramką poświadczeń, więc demo z nasłuchem na świat jest wykluczone.
  if (demo) throw new ConfigError(`${IROH_ENV}=1 does not work in demo mode; turn one of them off.`);
  const keyValue = key?.trim() ?? '';
  if (keyValue !== '' && !IROH_KEY_RE.test(keyValue)) {
    throw new ConfigError(`${IROH_KEY_ENV} must be 64 hex characters (new key: openssl rand -hex 32).`);
  }
  const relayValue = relay?.trim() ?? '';
  if (relayValue === '') throw new ConfigError(`${IROH_ENV}=1 needs ${IROH_RELAY_ENV} (the https address of the iroh relay).`);
  const canonical = irohRelayUrl(relayValue);
  if (canonical === null) {
    throw new ConfigError(`${IROH_RELAY_ENV} is not an iroh relay address: https://host[:port]/ without a path`
      + ` (got: ${relayValue}).`);
  }
  const portValue = port?.trim() ?? '';
  let udpPort: number | null = null;
  if (portValue !== '') {
    udpPort = Number(portValue);
    if (!/^[0-9]+$/.test(portValue) || udpPort < 1 || udpPort > 65535) {
      throw new ConfigError(`${IROH_PORT_ENV} must be a number 1–65535 (got: ${portValue}).`);
    }
  }
  return { key: keyValue === '' ? null : keyValue, relay: canonical, port: udpPort };
}
