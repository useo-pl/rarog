/**
 * Emergency console settings: the killswitch, the cap and reaper age of live terminals, the herdr binary path,
 * and the token that marks a terminal pane. `parseTermEnvBase` stays in `server/src/config.ts`, because it reads
 * the environment through `readEnv`.
 */
import os from 'node:os';
import path from 'node:path';
import { ConfigError, HERDR_BIN_ENV, TERM_IDLE_DAYS_ENV, TERM_MAX_ENV } from '../config-env.ts';
import { expandTilde } from './roots.ts';

// ---------------------------------------------------------------------------
// Terminal PTY — killswitch, sufit, żniwiarz, binarka herdr
// ---------------------------------------------------------------------------

/** Domyślny sufit żywych PTY. Cztery: tyle projektów człowiek trzyma otwartych naraz. */
export const DEFAULT_TERM_MAX = 4;

/** Domyślny wiek bezczynności do żniw. */
export const DEFAULT_TERM_IDLE_DAYS = 7;

/** Domyślna ścieżka binarki herdr — tam kładzie ją instalator herdr (`~/.local/bin`). */
export const DEFAULT_HERDR_BIN = '~/.local/bin/herdr';

/** Killswitch terminala. Opt-in (`1`/`true`), tak jak prawo zakładania paneli. */
export function parseTermEnabled(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/** Wspólny parser dodatnich liczb całkowitych dla bezpieczników terminala. */
function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${name} must be an integer ≥ 1 (got: ${raw}).`);
  }
  return value;
}

export function parseTermMax(raw: string | undefined): number {
  return parsePositiveInt(raw, DEFAULT_TERM_MAX, TERM_MAX_ENV);
}

export function parseTermIdleDays(raw: string | undefined): number {
  return parsePositiveInt(raw, DEFAULT_TERM_IDLE_DAYS, TERM_IDLE_DAYS_ENV);
}

/**
 * Waliduje `RAROG_HERDR_BIN`: ścieżka bezwzględna bez `..`. To jest binarka spawnowana
 * z uprawnieniami użytkownika, więc literówka ma wywalić START, a nie odpalić coś innego
 * niż widać w configu.
 */
export function parseHerdrBin(raw: string | undefined, home: string = os.homedir()): string {
  const trimmed = raw?.trim() ?? '';
  const expanded = expandTilde(trimmed === '' ? DEFAULT_HERDR_BIN : trimmed, home);
  if (!path.isAbsolute(expanded)) {
    throw new ConfigError(`${HERDR_BIN_ENV} must be an absolute path (got: ${raw ?? ''}).`);
  }
  if (expanded.split(path.sep).includes('..')) {
    throw new ConfigError(`${HERDR_BIN_ENV} must not contain a ".." segment.`);
  }
  return path.resolve(expanded);
}

/**
 * Takt JEDYNEGO tykającego procesu terminala (4 h): odzyskiwanie paneli po etykiecie
 * (`reconcile`) → adopcja tego, czego rejestr jeszcze nie zna → odświeżenie tokenów wpisów.
 *
 * Tokeny `rarog-term` nie mają TTL (TTL w herdr to opcja, nie wymóg): token z TTL wygasał
 * i terminal, do którego nikt nie zajrzał przez dobę, stawał się dla Raroga CUDZY. Tokeny giną przy restarcie serwera herdr — takt odzyskuje je z etykiety panelu także wtedy, gdy
 * rejestr jest pusty (Rarog wstał, gdy herdr nie odpowiadał). Cztery godziny dają sześć szans
 * na dobę; szybciej odzyskuje każdy `POST /api/term`, który panelu nie znalazł.
 */
export const TERM_TOKEN_REFRESH_MS = 4 * 3600 * 1000;

/**
 * Retry period of the terminal start sequence (recovery → reaper → adoption) when herdr could not be read
 * at start. Runs only until one pass reads herdr, then stops for the life of the process. 30 s matches
 * the herdr supervisor resync tick, so terminals come back about when the sessions do.
 */
export const TERM_START_RETRY_MS = 30 * 1000;

/**
 * Klucz w `tokens` panelu TERMINALA Raroga; wartością jest tożsamość terminala (`TERM_ID_RE`).
 *
 * Mieszka tu, a nie w `term/herdr-backend.ts`,
 * bo czyta go DRUGI moduł: filtr wejściowy herdr (`normalizeAgentInfo`) rozpoznaje po
 * nim Codexa uruchomionego w terminalu Raroga. Fasada gniazda nie ma prawa zależeć od modułu
 * terminala, a dwie kopie literału to dwa miejsca do rozjechania się.
 */
export const RAROG_TERM_PANE_TOKEN = 'rarog-term';

/**
 * Tożsamość terminala z tokenów panelu: wartość pod kluczem {@link RAROG_TERM_PANE_TOKEN}. Jedyny czytnik tokenu
 * dla filtra wejściowego herdr i backendu terminala; inny klucz w mapie panelu nie jest tożsamością.
 */
export function termPaneTokenOf(tokens: Readonly<Record<string, string>> | null | undefined): string | undefined {
  return tokens?.[RAROG_TERM_PANE_TOKEN];
}
