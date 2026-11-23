/**
 * Czyszczenie tekstu ekranu panelu: sekwencje ANSI, znaki sterujące C0, końce linii i puste brzegi.
 *
 * Wspólny wstęp czytników ekranu w `dialogs/screen/` i sanityzacji tekstu wysyłanego do panelu
 * (`herdr/commands/guard.ts`). Te wzorce nie zależą od wyglądu CLI, więc nie stoją w rejestrze sygnatur.
 */

/**
 * Sekwencje ANSI: OSC (`ESC ] … BEL|ST`), CSI (`ESC [ … litera`) i krótkie `ESC <znak>`.
 *
 * Wzorzec budujemy z napisów z jawnym zapisem `\u001b`, a nie z literału regex ze znakami
 * sterującymi w kodzie: bajt ESC wklejony wprost do pliku jest niewidoczny w diffie i w review.
 * Ekran przychodzi zwykle z `strip_ansi: true`, ale tego NIE zakładamy — panel jest terminalem.
 */
const ANSI_PATTERN = new RegExp(
  [
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)',
    '\\u001b\\[[0-9;?]*[\\u0020-\\u002f]*[\\u0040-\\u007e]',
    '\\u001b[\\u0040-\\u005a\\u005c-\\u005f]',
  ].join('|'),
  'g',
);

/** Znaki sterujące C0 poza `\t` (0x09) i `\n` (0x0a), plus DEL. `\r` normalizujemy wcześniej. */
const C0_PATTERN = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');

/** Czy w tekście jest cokolwiek do pokazania człowiekowi (litera albo cyfra)? */
export const MEANINGFUL_PATTERN = /[\p{L}\p{N}]/u;

/**
 * ANSI + C0 + normalizacja końców linii.
 *
 * Eksportowane, bo dokładnie tego samego czyszczenia potrzebuje sanityzacja tekstu WYSYŁANEGO
 * do panelu (`commands/guard.ts`). Wzorzec ANSI jest jedynym miejscem w kodzie, gdzie łatwo
 * o subtelny błąd — ma istnieć raz, a nie w dwóch kopiach jadących w przeciwne strony.
 */
export function stripTerminalControl(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(C0_PATTERN, '');
}

/** Wspólny wstęp czytników ekranu: to samo czyszczenie co `stripTerminalControl`. */
export function clean(text: string): string {
  return stripTerminalControl(text);
}

/** Linie bez końcowych spacji, obcięte z pustych brzegów. */
export function trimmedLines(text: string): string[] {
  const lines = clean(text).split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '') === '') start += 1;
  while (end > start && (lines[end - 1] ?? '') === '') end -= 1;
  return lines.slice(start, end);
}
