/**
 * Etykieta sesji — człon `sesja` w tytule karty `projekt · sesja`.
 *
 * Osobny, czysty moduł (bez I/O), bo te same reguły czytają DWIE warstwy, które nie mają prawa
 * zależeć od siebie nawzajem: manager (karta w kliencie) i integracja herdr (etykieta TABA w herdr,
 * `herdr/provenance.ts`). Etykieta taba ma być IDENTYCZNA z kartą, więc czyszczenie jest
 * jedno ({@link normalizeSessionLabel}); import managera z modułu herdr zamknąłby cykl, a herdr
 * nie zna warstwy sesji.
 */

/** Control characters U+0000–U+001F, DEL and U+0080–U+009F, plus the Unicode line and paragraph separators. */
const LABEL_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

/**
 * JEDNO czyszczenie etykiety karty: znaki sterujące → spacja,
 * białe znaki zwinięte do pojedynczej spacji, brzegi obcięte. BEZ limitu długości — 28 znaków
 * pilnuje `labelFromPrompt` dla etykiet z promptu i tytułu, a nazwę katalogu (fallback) karta
 * pokazuje całą. Manager przepuszcza przez nią każdą etykietę karty
 * (`#setLabel`), a etykieta taba w herdr dostaje dokładnie ten napis. Pusty wynik = „nie ma
 * etykiety" — zastępczą nazwę wybiera wołający.
 */
export function normalizeSessionLabel(raw: string): string {
  return raw.replace(LABEL_CONTROL_RE, ' ').replace(/\s+/gu, ' ').trim();
}

/** Ile znaków mieści się w członie sesji, zanim UI zacznie go przycinać wielokropkiem. */
export const MAX_LABEL_LENGTH = 28;

/** Ile słów promptu bierzemy do etykiety (spec: 3–5). */
const MAX_LABEL_WORDS = 5;

/**
 * Etykieta z pierwszego promptu: do 5 słów, przycięte do `MAX_LABEL_LENGTH`.
 *
 * Najpierw rezygnujemy z CAŁYCH słów (etykieta ma być czytelna, nie „napraw zapis nota…"),
 * a dopiero jednosłowny prompt dłuższy niż limit tniemy twardo z wielokropkiem.
 *
 * @returns etykieta albo `null`, gdy prompt nie ma ani jednego słowa (wtedy wołający bierze
 *          fallback `sesja N`).
 */
export function labelFromPrompt(prompt: string, maxLength = MAX_LABEL_LENGTH): string | null {
  const words = prompt.trim().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return null;
  let picked = words.slice(0, MAX_LABEL_WORDS);
  while (picked.length > 1 && picked.join(' ').length > maxLength) {
    picked = picked.slice(0, -1);
  }
  const label = picked.join(' ');
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 1).trimEnd()}…`;
}
