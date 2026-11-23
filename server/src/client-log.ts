/**
 * `POST /api/client-log` — diagnostyka klienta bez kabla.
 *
 * Apka natywna wysyła paczkę zdarzeń (raport `kontrakt:`, `błąd:`, ślady bez treści),
 * serwer dopisuje je jako NDJSON do pliku w `config.dataDir`. `tail -f` zastępuje konsolę
 * Xcode na urządzeniu bez kabla.
 *
 * Limity: 64 kB na request (egzekwowane w routerze przy czytaniu ciała) + prosta rotacja
 * pliku, żeby zapętlony klient nie zapchał dysku.
 */
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ClientLogBody } from '@rarog/shared';
import type { RarogConfig } from './config.ts';

export const CLIENT_LOG_FILENAME = 'client.log';

/** Powyżej tego rozmiaru plik jest rotowany do `client.log.1` (jedna generacja wstecz). */
export const CLIENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Twardy limit rozmiaru pojedynczej paczki (ten sam, co limit ciała requestu). */
export const CLIENT_LOG_MAX_REQUEST_BYTES = 64 * 1024;

/** Ścieżka pliku logu klienta dla danej konfiguracji. */
export function clientLogPath(config: Pick<RarogConfig, 'dataDir'>): string {
  return path.join(config.dataDir, CLIENT_LOG_FILENAME);
}

/** Pliki logu klienta kasowane przy starcie trybu recenzji: bieżący i jedna generacja rotacji. */
const REVIEW_CLEARED_FILES = [CLIENT_LOG_FILENAME, `${CLIENT_LOG_FILENAME}.1`] as const;

/**
 * Start trybu recenzji demo: kasuje `client.log` i `client.log.1`, czyli diagnostykę z telefonów
 * recenzentów z poprzedniego startu. Zwykłe demo i serwer (`demoReview === null`) niczego nie kasują.
 *
 * Brak pliku (`ENOENT`) to nic do zrobienia. Każdy inny błąd kończy kasowanie i rzuca zdaniem z nazwą pliku i kodem
 * błędu, bez ścieżki i treści: `index.ts` przerywa wtedy start. Kasowanie wymaga tego samego prawa do katalogu danych
 * co zapis `devices.json` (tmp+rename), więc serwer, który nie skasuje własnego pliku, nie zapisałby też parowania.
 *
 * @returns nazwy skasowanych plików (pusta lista = nic do zrobienia)
 * @throws {Error} gdy kasowanie padło z kodem innym niż `ENOENT`
 */
export async function clearReviewClientLogs(
  config: Pick<RarogConfig, 'dataDir' | 'demoReview'>,
  deps: { readonly unlink?: (file: string) => Promise<void> } = {},
): Promise<readonly string[]> {
  if (config.demoReview === null) return [];
  const remove = deps.unlink ?? unlink;
  const cleared: string[] = [];
  for (const name of REVIEW_CLEARED_FILES) {
    try {
      await remove(path.join(config.dataDir, name));
      cleared.push(name);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') continue;
      throw new Error(`review demo: could not delete ${name} (${typeof code === 'string' ? code : 'unknown error'})`);
    }
  }
  return cleared;
}

/**
 * Znacznik natywnej apki w User-Agencie → prefiks pola `client`. Numer builda przycięty do
 * 16 znaków `[\w.]` — reszta UA nie trafia do logu.
 */
const NATIVE_UA: readonly (readonly [RegExp, string])[] = [
  /** Natywna apka: `RarogApp/<build>`; inny znacznik nie daje builda. */
  [/RarogApp\/([\w.]{1,16})/, 'app'],
];

/**
 * Pole `client` linii logu: `app/<build>` dla natywnej apki, inaczej gruba etykieta urządzenia
 * (`clientLabel` z routera — np. `curl` z Maca). Numer builda odróżnia w logu wydania apki.
 */
export function clientTag(userAgent: string | undefined, deviceLabel: string): string {
  const ua = userAgent ?? '';
  for (const [pattern, prefix] of NATIVE_UA) {
    const version = pattern.exec(ua)?.[1];
    if (version !== undefined) return `${prefix}/${version}`;
  }
  return deviceLabel;
}

/** Jeden wiersz NDJSON: dane od klienta + czas przyjęcia po stronie serwera. */
function toLine(
  event: ClientLogBody['events'][number], receivedAt: string, client: string | undefined,
): string {
  return `${JSON.stringify({
    at: event.at,
    level: event.level,
    msg: event.msg,
    ...(client === undefined ? {} : { client }),
    receivedAt,
  })}\n`;
}

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    const info = await stat(file);
    if (info.size < CLIENT_LOG_MAX_BYTES) return;
    await rename(file, `${file}.1`);
  } catch {
    // Brak pliku (pierwszy zapis) albo wyścig z inną rotacją — nic nie robimy.
  }
}

/**
 * Dopisuje paczkę zdarzeń do logu klienta.
 *
 * @returns liczba dopisanych wierszy
 * @throws {Error} gdy paczka po serializacji przekracza {@link CLIENT_LOG_MAX_REQUEST_BYTES}
 *   (pole `client` się nie wlicza: to dopisek serwera, a nie dane od klienta — bez tego paczka
 *   przyjmowana przed jego wprowadzeniem mogłaby teraz dostać 500)
 */
export async function appendClientLog(
  config: RarogConfig,
  events: ClientLogBody['events'],
  opts: { client?: string; now?: () => Date } = {},
): Promise<number> {
  if (events.length === 0) return 0;
  const receivedAt = (opts.now ?? (() => new Date()))().toISOString();
  const payload = events.map((e) => toLine(e, receivedAt, opts.client)).join('');
  const clientBytes = opts.client === undefined
    ? 0
    : Buffer.byteLength(`,"client":${JSON.stringify(opts.client)}`, 'utf8');
  const limit = CLIENT_LOG_MAX_REQUEST_BYTES + events.length * clientBytes;
  if (Buffer.byteLength(payload, 'utf8') > limit) {
    throw new Error('Paczka logów klienta przekracza 64 kB.');
  }
  const file = clientLogPath(config);
  await mkdir(path.dirname(file), { recursive: true });
  await rotateIfNeeded(file);
  await appendFile(file, payload, 'utf8');
  return events.length;
}
