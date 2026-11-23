/**
 * Tekst spoza serwera w drodze na drut — małe reguły, wspólne dla kilku list w `SessionSummary`
 * i dla etykiet urządzeń.
 *
 * Czysty moduł bez stanu, importuje tylko listy znaków ukrytych (`hidden-chars.ts`): wołają go reduktor zadań w tle
 * (`herdr/background/reducer.ts`: komenda i streszczenie zadania), lista artefaktów sesji
 * (`herdr/background/artifacts.ts`: tytuł) oraz rejestr tokenów APNs i parowanie (etykieta urządzenia,
 * {@link sanitizeLabel}). Każde z tych pól jedzie w KAŻDEJ ramce snapshotu albo na listę urządzeń, więc ma sufit,
 * a dekoder JSON apki nie wybacza połowy znaku.
 *
 * {@link clipUnits} stoi tu, bo tej samej reguły potrzebuje kilka modułów. {@link sanitizeLabel}
 * re-eksportuje dalej `notify/apns-devices.ts`, a parowanie (`auth/pairing.ts`) bierze tę samą
 * etykietę stąd, bez importu z `notify/`.
 *
 * Device label, build number and a log line from outside: the label and a log line lose every character the
 * consent card hides (`CARD_HIDDEN_RANGES`) besides `\p{Cc}`, so a label or a peer's error text cannot reorder,
 * hide or drive the terminal of whoever reads the device list or `server.log`; a build is ASCII digits or nothing.
 */
import { CARD_HIDDEN_RANGES, rangesClass } from './hidden-chars.ts';

/**
 * Tekst przycięty do `max` jednostek UTF-16 (komenda, podsumowanie zadania). Cięcie w środku pary surogatów
 * (emoji na granicy) zostawiłoby połowę znaku: `JSON.stringify` wysyła ją jako `\udXXX`, a dekoder JSON apki
 * odrzuca wtedy CAŁĄ ramkę z listą zadań (sprawdzone na `JSONDecoder`). Połowę
 * zastępuje U+FFFD: długość zostaje równa limitowi, po którym apka poznaje uciętą komendę
 * (`CommandTools.serverCut`).
 */
export function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? `${cut.slice(0, -1)}\ufffd` : cut;
}

/**
 * Znaki sterujące (kategoria Unicode `Cc`: C0, DEL) oraz separatory linii i akapitu (U+2028, U+2029).
 * Formatujących (`Cf`) celowo nie ma: należy do nich łącznik zerowej szerokości, który skleja emoji
 * z kilku znaków (rodzina, flaga), a jego usunięcie rozbija znak na kawałki.
 */
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu;

/**
 * Tekst bez znaków sterujących — USUNIĘTYCH, nie zamienionych na spację, i bez sklejania białych znaków.
 *
 * Do pola, które apka pokazuje jako jedną linię, a które przychodzi z pliku pisanego przez kogoś innego
 * (tytuł artefaktu z wyniku narzędzia CLI). Znak nowej linii albo ESC w takim polu nie ma czego
 * znaczyć w wierszu listy. Brzegi i długość zostają wołającemu: to nie jest pełna normalizacja
 * etykiety jak `normalizeSessionLabel` (`session-label.ts`) ani `sanitizePaneTitle`
 * (`herdr/provenance.ts`), które sklejają białe znaki i mają własne sufity.
 */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

/** Etykieta urządzenia liczy PUNKTY KODOWE, nie jednostki UTF-16 — jak nazwy uploadów. */
export const LABEL_MAX_CODEPOINTS = 64;

/**
 * Etykieta po sanityzacji pusta → ta; człowiek musi coś zobaczyć na liście urządzeń. To identyfikator rekordu, nie zdanie
 * (bez kodu, apka go nie tłumaczy), więc po angielsku jak reszta serwera.
 */
export const LABEL_FALLBACK = 'device';

/**
 * Control characters and every character hidden on the consent card: a text direction override, a zero width
 * character, a tag. U+200D and variation selectors are not in the card list, so emoji keep their shape.
 */
const HIDDEN_FROM_OUTSIDE = new RegExp(`[\\p{Cc}${rangesClass(CARD_HIDDEN_RANGES)}]`, 'gu');

/**
 * Etykieta urządzenia jest WEJŚCIEM Z TELEFONU i traktujemy ją jak każde inne: znaki kontrolne (w tym
 * `\n`, który rozbiłby linię logu, i `\r`) i znaki ukryte na karcie zgody wypadają, białe znaki zwijają się
 * do spacji, długość liczona w punktach kodowych (emoji w nazwie iPhone'a to normalna rzecz). Removal comes before
 * the whitespace fold, so a tab or a newline disappears instead of becoming a space. The device list and the admin
 * list apply it again on the way out, so a record written under an older rule shows the same.
 */
export function sanitizeLabel(raw: string | undefined): string {
  if (raw === undefined) return LABEL_FALLBACK;
  const cleaned = raw
    .replace(HIDDEN_FROM_OUTSIDE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const codepoints = [...cleaned].slice(0, LABEL_MAX_CODEPOINTS).join('').trim();
  return codepoints === '' ? LABEL_FALLBACK : codepoints;
}

/** A build number: the app sends `CFBundleVersion` as an integer, so ASCII digits, at most 10 of them. */
const BUILD_PATTERN = /^[0-9]{1,10}$/;

/**
 * Build number of a device, on the way in and out: after `trim()` up to 10 ASCII digits, anything else is
 * `null`. The field is printed in the device list and by `rarog devices`, so it carries nothing but digits.
 */
export function sanitizeBuild(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return BUILD_PATTERN.test(trimmed) ? trimmed : null;
}

/** Ceiling of a log detail from outside, in UTF-16 units. */
export const LOG_TEXT_MAX = 120;

/**
 * Text from outside on a log line (a peer's handshake error, a refused request path): every control character and
 * every character hidden on the consent card becomes `?`, so the line cannot clear or move the terminal that shows
 * `server.log`, and the text is cut to `max` UTF-16 units without half of a surrogate pair ({@link clipUnits}).
 */
export function sanitizeLogText(text: string, max: number = LOG_TEXT_MAX): string {
  return clipUnits(text.replace(HIDDEN_FROM_OUTSIDE, '?'), max);
}
