/**
 * Push notifications: APNs key types and the key file reader, the push relay origin, and the push switches.
 * `parseApns` stays in `server/src/config.ts`, because it reads the APNs variables through `readEnv`.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PUSH_RELAY_URL_ENV } from '../config-env.ts';

export interface ApnsConfig {
  /** Treść pliku klucza (PEM, EC P-256) — wyłącznie do podpisu JWT i do listy `redact()`. */
  readonly privateKey: string;
  /** Key ID klucza APNs (10 wielkich liter i cyfr) — `kid` w JWT. */
  readonly keyId: string;
  /** Team ID konta (10 wielkich liter i cyfr) — `iss` w JWT. */
  readonly teamId: string;
  /**
   * Temat serwera — bundle id apki, którą ten serwer obsługuje. Rejestracja bez `topic` albo z innym → 400
   * `topic-mismatch`, bez klucza urządzenia → 403 `device-required`; wpis niesie temat dalej jako swój `apns-topic`.
   */
  readonly topic: string;
}

/** Odczyt pliku klucza: prawa (bity `0o777`) i treść. Wstrzykiwany w testach. */
export interface ApnsKeyFile {
  readonly mode: number;
  readonly text: string;
}

export type ApnsKeyReader = (file: string) => ApnsKeyFile;

export const readApnsKeyFile: ApnsKeyReader = (file) => {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error('not-a-file');
  return { mode: stat.mode & 0o777, text: readFileSync(file, 'utf8') };
};

export const APPLE_ID_RE = /^[A-Z0-9]{10}$/;

/**
 * Ścieżka klucza ze środowiska (z menedżera sekretów albo z pliku sekretów) może zaczynać się od `~` albo `$HOME` (powłoka nie rozwija ich
 * w cudzysłowie) — ta sama obsługa co w `scripts/ios-lib.sh` dla klucza ASC.
 */
export function expandHome(raw: string, home: string): string {
  if (raw === '~' || raw.startsWith('~/')) return path.join(home, raw.slice(1));
  return raw.replace(/^\$HOME(?=\/|$)/, home);
}

export interface PushRelayConfig {
  /** `https://host[:port]` — bez ścieżki, zapytania i `#`; wiązanie każdej zapisanej przepustki. */
  readonly origin: string;
}

/**
 * Przekaźnik push albo powód, dla którego go nie ma. Nigdy `ConfigError`: zły adres nie ma prawa zabrać
 * serwera — przekaźnika po prostu nie ma, a log startu mówi czemu. Wartość to SAM origin `https`: przepustka
 * i token idą wyłącznie tam, więc ścieżka, dane logowania w adresie i `http` są odrzucane, a nie poprawiane.
 */
export function parsePushRelay(raw: string | undefined): { readonly relay?: PushRelayConfig; readonly issue?: string } {
  const value = raw?.trim() ?? '';
  if (value === '') return {};
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { issue: `${PUSH_RELAY_URL_ENV} is not a URL` };
  }
  if (url.protocol !== 'https:') return { issue: `${PUSH_RELAY_URL_ENV} must be an https address` };
  if (url.username !== '' || url.password !== '') {
    return { issue: `${PUSH_RELAY_URL_ENV} must not carry credentials in the address` };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(value)) {
    return { issue: `${PUSH_RELAY_URL_ENV} must be a bare origin, without a path, query or #` };
  }
  return { relay: { origin: url.origin } };
}

/**
 * Killswitch powiadomień; brak wartości = WŁĄCZONE.
 *
 * Domyślne „włączone" jest bezpieczne dokładnie dlatego, że sam killswitch nie wystarcza:
 * bez kompletu `RAROG_APNS_*` i bez `RAROG_PUSH_RELAY_URL` w env kanał nie ruszy (patrz `pushEnabled`), a wpisy
 * trzeba świadomie dopisać do środowiska serwera. `0` gasi naraz banery APNs
 * do apki natywnej i aktualizacje jej Live Activity.
 */
export function parsePushEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}

/**
 * Szyfrowanie treści banerów; brak wartości = WŁĄCZONE, `0`/`false` wyłącza (parser jak
 * {@link parsePushEnabled}). Domyślne „włączone” jest bezpieczne, bo baner szyfrowany (format 3) dostaje wyłącznie
 * wpis, który go zadeklarował (`pushFormats` z 3); wpis bez deklaracji banerów nie dostaje wcale.
 */
export function parsePushE2e(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return !(raw === '0' || raw === 'false');
}
