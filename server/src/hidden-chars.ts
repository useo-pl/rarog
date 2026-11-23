/**
 * Znaki, które na ekranie nie wyglądają na siebie: sterujące (U+0000–U+001F poza tabulatorem, U+007F–U+009F), znaki kierunku pisma, znaki
 * zerowej szerokości, separatory linii i akapitu, BOM. Ukrywają linię sekwencją ESC albo CR, odwracają kolejność
 * znaków (Trojan Source) albo rozdzielają słowo niewidocznie. Zakresy kodów punktów, obustronnie domknięte, w dwóch
 * nazwanych listach: jedna definicja dla różnicy plików i dla karty zgody.
 * Tag characters (U+E0000–U+E007F) render as nothing, so they can carry text the screen never shows; both lists
 * have them. So do the variation selectors of the supplement (U+E0100–U+E01EF), which render as nothing after a
 * plain letter, and the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), which render as blank space without being
 * a space. The label of a device and a log line from outside use the card list too (`text.ts`).
 */

/** Zakres kodów punktów `[od, do]`, obustronnie domknięty. */
export type CodePointRange = readonly [number, number];

/**
 * Różnica plików przed zapisem kopii hooka (`visibleLine` w `herdr/hook-config.ts`): każdy znak stąd idzie jako
 * `\u{…}`. Plik ze źródła mógł zmienić proces w sandboksie, więc różnica nie może schować linii ani odwrócić
 * kolejności znaków. Lista obejmuje też nową linię (U+000A): różnica pokazuje plik linia po linii, więc znak nowej
 * linii wewnątrz linii jest obcy.
 */
export const DIFF_HIDDEN_RANGES: readonly CodePointRange[] = [
  [0x00, 0x08], [0x0a, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x115f, 0x1160], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0x3164, 0x3164], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

/**
 * Karta zgody: {@link DIFF_HIDDEN_RANGES} bez nowej linii (U+000A: komenda i JSON wejścia mają wiele linii) i bez
 * łącznika emoji (U+200D: składa emoji rodziny i zawodów w jeden widoczny znak). Karta kanału zgód z takim znakiem
 * w treści nie ma przycisku zgody (`hidden-chars`, `herdr/dialogs/layer1/card.ts`): telefon zgadza się na to, co
 * widzi.
 */
export const CARD_HIDDEN_RANGES: readonly CodePointRange[] = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x115f, 0x1160], [0x180e, 0x180e],
  [0x200b, 0x200c], [0x200e, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0x3164, 0x3164],
  [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

/** Czy kod punktu leży w którymś z zakresów. */
export function inRanges(code: number, ranges: readonly CodePointRange[]): boolean {
  return ranges.some(([from, to]) => code >= from && code <= to);
}

/**
 * The inside of a regular expression character class (`u` flag) with the given ranges, so a caller can add classes
 * of its own around them (`text.ts`: `\p{Cc}` next to the card list).
 */
export function rangesClass(ranges: readonly CodePointRange[]): string {
  return ranges.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('');
}

/**
 * Klasa znaków z {@link CARD_HIDDEN_RANGES}: karta kanału sprawdza całą prezentację (do ok. 1 MiB) przy każdej
 * obserwacji, więc jeden przebieg wyrażenia zamiast pętli po zakresach dla każdego znaku.
 */
const CARD_HIDDEN_CLASS = new RegExp(`[${rangesClass(CARD_HIDDEN_RANGES)}]`, 'u');

/** Czy tekst ma znak ukryty na karcie ({@link CARD_HIDDEN_RANGES}). */
export function hasCardHiddenChar(text: string): boolean {
  return CARD_HIDDEN_CLASS.test(text);
}
