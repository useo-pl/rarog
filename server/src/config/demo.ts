/**
 * Demo review mode, the demo content language and the demo content set: parsers for `loadConfig`
 * (`server/src/config.ts`), which passes in the values it read through `readEnv`.
 */
import { PAIRING_CODE_RE } from '@rarog/shared/rest';
import { ConfigError, DEMO_CONTENT_ENV, DEMO_LANG_ENV, DEMO_REVIEW_CODE_ENV } from '../config-env.ts';
// The resolver of named sets loads no set, so the production process still reads no demo content.
import { DEMO_SET_NAME, DEMO_SET_ROOT, demoSetFile, noSuchDemoSet } from '../demo/content/named-set.ts';
// Sam typ (import bez kodu): proces produkcyjny nie wczytuje treści demo.
import type { DemoLang, DemoSet } from '../demo/content/types.ts';

/** `RAROG_DEMO` turns the demo on (`1` or `true`); its review mode needs it too (`parseDemoReview`). */
export function demoEnabled(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/** Sufit aktywnych urządzeń trybu recenzji: kod recenzenta przy tylu aktywnych urządzeniach dostaje 429. */
export const DEMO_REVIEW_MAX_DEVICES = 10;

/**
 * Tryb recenzji demo: stały kod parowania dla recenzenta App Store (`auth/pairing.ts`,
 * `redeemReview`). Kod nie zużywa się i nie wygasa; rotacja = nowa wartość i restart, odpięcie wszystkich = nowa epoka.
 */
export interface DemoReviewConfig {
  /** Wartość {@link DEMO_REVIEW_CODE_ENV} w kształcie `PAIRING_CODE_RE`. Sekret: lista {@link logSecrets}. */
  readonly code: string;
  /** {@link DEMO_REVIEW_MAX_DEVICES}. */
  readonly maxDevices: number;
}

/**
 * Tryb recenzji: {@link DEMO_REVIEW_CODE_ENV} pusty albo brak = `null`. Ustawiony wymaga demo,
 * kształtu kodu parowania i jawnego katalogu danych: demo bez `RAROG_DATA_DIR` pisze `devices.demo.json` do tmp,
 * a tryb recenzji trzyma urządzenia recenzentów na trwałym woluminie. Origin sprawdza osobno {@link assertDemoReviewOrigins}.
 * Żaden komunikat nie cytuje wartości: to sekret.
 */
export function parseDemoReview(
  raw: string | undefined, demo: boolean, dataDir: string | undefined,
): DemoReviewConfig | null {
  const code = raw?.trim() ?? '';
  if (code === '') return null;
  if (!demo) throw new ConfigError(`${DEMO_REVIEW_CODE_ENV} works only with RAROG_DEMO=1.`);
  if (!PAIRING_CODE_RE.test(code)) {
    throw new ConfigError(`${DEMO_REVIEW_CODE_ENV} must be 43 base64url characters, the shape of a pairing code`
      + " (new code: openssl rand -base64 32 | tr '+/' '-_' | tr -d '=').");
  }
  if (dataDir === undefined || dataDir === '') {
    throw new ConfigError(`${DEMO_REVIEW_CODE_ENV} needs an explicit RAROG_DATA_DIR (a persistent directory for`
      + ' devices.json).');
  }
  return { code, maxDevices: DEMO_REVIEW_MAX_DEVICES };
}

/** Języki treści demo, które zna {@link DEMO_LANG_ENV}. */
const DEMO_LANGS: readonly DemoLang[] = ['en', 'pl'];

/**
 * Język treści demo: {@link DEMO_LANG_ENV} brak albo pusty = `en` (domyślny język produktu).
 * Inna wartość niż `en`/`pl` to `ConfigError` także poza demo: literówka nie może dać po cichu innego języka.
 * Tryb recenzji pokazuje recenzentowi tylko angielskie demo, więc `pl` z kodem recenzenta to też `ConfigError`.
 */
export function parseDemoLang(raw: string | undefined, review: boolean): DemoLang {
  const value = raw?.trim() ?? '';
  if (value === '') return 'en';
  const lang = DEMO_LANGS.find((known) => known === value);
  if (lang === undefined) throw new ConfigError(`${DEMO_LANG_ENV} must be en or pl (got: ${value}).`);
  if (review && lang !== 'en') {
    throw new ConfigError(`${DEMO_LANG_ENV}=${lang} does not work with ${DEMO_REVIEW_CODE_ENV}: the review demo is in`
      + ' English (unset the variable or set en).');
  }
  return lang;
}

/**
 * Named demo content set (`RAROG_DEMO_CONTENT`, `demo/content/named-set.ts`): unset or empty = `null`, the set of
 * {@link DEMO_LANG_ENV}. A named set works only in the plain English demo, so a value that is not a set name (also
 * outside the demo), a set outside the demo, with the review code, with a language other than `en` or without a module
 * in `root` is a `ConfigError`: a typo must not quietly show another set, a build without the set must not start, and
 * the review demo stays the reviewer's set. No message quotes the review code.
 */
export function parseDemoContent(
  raw: string | undefined, context: { demo: boolean; review: boolean; lang: DemoLang }, root: string = DEMO_SET_ROOT,
): DemoSet | null {
  const set = raw?.trim() ?? '';
  if (set === '') return null;
  if (!DEMO_SET_NAME.test(set)) {
    throw new ConfigError(`${DEMO_CONTENT_ENV} must be a demo set name: lowercase letters, digits and hyphens,`
      + ` starting with a letter (got: ${set}).`);
  }
  if (!context.demo) throw new ConfigError(`${DEMO_CONTENT_ENV} works only with RAROG_DEMO=1.`);
  if (context.review) {
    throw new ConfigError(`${DEMO_CONTENT_ENV}=${set} does not work with ${DEMO_REVIEW_CODE_ENV}: the review demo keeps`
      + ' its own set (unset the variable).');
  }
  if (context.lang !== 'en') {
    throw new ConfigError(`${DEMO_CONTENT_ENV}=${set} needs ${DEMO_LANG_ENV}=en (unset it or set en).`);
  }
  if (demoSetFile(set, root) === null) throw noSuchDemoSet(set);
  return set;
}

/**
 * Tryb recenzji: allow-lista `Origin` to dokładnie jeden goły origin `https` — publiczny adres demo za reverse proxy.
 * Loopback `http` (domyślne `demoOrigins`), druga pozycja albo ścieżka to `ConfigError`: link parowania niesie ten
 * adres (`publicUrlOf`), a mutacje z innego originu dostają 403.
 */
export function assertDemoReviewOrigins(origins: readonly string[]): void {
  const only = origins.length === 1 ? origins[0] ?? '' : '';
  const url = URL.canParse(only) ? new URL(only) : null;
  if (url === null || url.protocol !== 'https:' || url.origin !== only) {
    throw new ConfigError(`${DEMO_REVIEW_CODE_ENV} needs RAROG_ORIGINS set to exactly one bare https origin, the`
      + ' public address of the demo (e.g. https://demo.example.com).');
  }
}
