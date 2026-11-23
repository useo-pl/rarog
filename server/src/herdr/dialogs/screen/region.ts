/**
 * Granice dialogu na ekranie: pozioma kreska, góra bloku dialogu ({@link blockTopOf}), kandydaci na region opcji
 * (od najwęższego) i treść dialogu z ramką operacji.
 *
 * Wzorce kresek pochodzą z rejestru sygnatur. Region nie ocenia treści, tylko odgradza dialog od scrollbacku.
 * Moduł nie zna tytułów dialogów ani nazw narzędzi, więc góra bloku stoi tutaj, a nie w `block.ts`: biorą ją
 * i parser (`block.ts`, `parse.ts`, `excerpt.ts`), i warstwa 2 (`layer2/`), której nie wolno sięgać po mapę
 * tytułów.
 */
import { operationText } from './operation.ts';
import type { ScreenOperation } from './operation.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';

/** Ile ostatnich linii ekranu przeszukujemy, gdy na ekranie NIE MA poziomej kreski. */
export const DIALOG_TAIL_LINES = 60;

/**
 * Pozioma kreska oddzielająca dialog od reszty ekranu.
 *
 * To ta sama granica, której używa manifest detekcji herdr (`after_last_horizontal_rule`
 * w regułach `generic_permission_prompt` i `live_blocked_form`) — bierzemy ją stąd, a nie
 * z własnego pomysłu, bo to herdr decyduje, że panel jest `blocked`.
 *
 * Znaki ramki z NAROŻNIKAMI (`╭╮╰╯`) są świadomie poza klasą: `╰──────╯` to dolna krawędź
 * ramki dialogu i stoi POD opcjami. Gdyby liczyła się jako kreska, region zaczynałby się za
 * nią i nie zawierał ani jednej opcji.
 *
 * `▔` (U+2594) i `╌╍`: dialogi potwierdzeń ustawień CLI („Switch model?",
 * „Change effort level?" — zrzut `dialog-model-switch.txt` i zgłoszenie z żywego panelu)
 * odgradzają się od scrollbacku pełną linią `▔▔▔…` — bez tych znaków
 * jedynym kandydatem byłby pełny ogon ekranu razem ze scrollbackiem.
 */
export const HORIZONTAL_RULE_PATTERN = SCREEN_SIGNATURES.horizontalRule.pattern;

/** Goła kreska bloku: ciągła `────` albo `▔▔▔▔`, w dowolnej kolumnie. */
const BLOCK_RULE_PATTERN = SCREEN_SIGNATURES.blockRule.pattern;

/** Kreska `▔▔▔` ze statusem sesji przed końcem („▔▔▔ ◐ medium · /effort ▔”), góra widoku slash-komendy. */
const BLOCK_RULE_WITH_STATUS_PATTERN = SCREEN_SIGNATURES.blockRuleWithStatus.pattern;

/** Rodzaj góry bloku: goła kreska albo kreska ze statusem sesji. */
export type BlockTopKind = 'bare' | 'status';

/** Góra bloku dialogu: indeks linii kreski i jej rodzaj. */
export interface BlockTop {
  readonly line: number;
  readonly kind: BlockTopKind;
}

/**
 * Góra BLOKU dialogu — jedyna definicja kreski bloku: najbliższa nad linią `end` kreska rodzaju z `kinds` (domyślnie
 * obu); `null`, gdy takiej nie ma.
 *
 * - `bare` — goła kreska ({@link BLOCK_RULE_PATTERN}): linia złożona wyłącznie z `─` albo `▔`, co najmniej 8;
 * - `status` — kreska ze statusem sesji ({@link BLOCK_RULE_WITH_STATUS_PATTERN}).
 *
 * Kreskę rodzaju spoza `kinds` szukanie mija. `nearest` żąda NAJBLIŻSZEJ kreski w ogóle: pierwsza nad `end` kreska
 * spoza `kinds`, także pozioma kreska regionu ({@link HORIZONTAL_RULE_PATTERN}, np. ramka `╌╌╌`), kończy szukanie
 * wynikiem `null`.
 *
 * Wołający i ich filtr: blok parsera (`dialogBlock` w `block.ts`: tylko goła, każda kreska nad pierwszą opcją po
 * kolei; przez niego także `blockVisible`), góra odcisku bloku (`parse.ts`: kreska ze statusem jako najbliższa),
 * wycinek bloku na kartę bez przycisków (`excerpt.ts`: oba rodzaje od dołu ekranu), blok warstwy 2
 * (`layer2/read-block.ts`: oba rodzaje, najbliższa nad pierwszą opcją, bez opcji z cyframi od dołu ekranu). Strażnik
 * `server/test/dialogs-layer2-boundaries.test.ts` pilnuje, że wzorców kresek bloku nie czyta nikt inny.
 */
export function blockTopOf(
  lines: readonly string[], end: number,
  options: { readonly kinds?: readonly BlockTopKind[]; readonly nearest?: boolean } = {},
): BlockTop | null {
  const kinds = options.kinds ?? ['bare', 'status'];
  for (let i = end - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').trim();
    const kind = BLOCK_RULE_PATTERN.test(line) ? 'bare' : BLOCK_RULE_WITH_STATUS_PATTERN.test(line) ? 'status' : null;
    if (kind !== null && kinds.includes(kind)) return { line: i, kind };
    if (options.nearest === true && (kind !== null || HORIZONTAL_RULE_PATTERN.test(line))) return null;
  }
  return null;
}

/**
 * Treść dialogu z RAMKĄ OPERACJI: nagłówek (tytuł, opis, podpowiedź CLI) + operacja +
 * pytanie, bez kresek i bez licznika auto-odmowy (pytanie przychodzi już bez niego).
 *
 * Nagłówek bierzemy z operacji (`ScreenOperation.header`, jedna definicja z dowodem `Edit`): jest tam
 * wyłącznie wtedy, gdy widać górną kreskę dialogu (`headerVisible`). Inaczej linie nad ramką byłyby
 * scrollbackiem, a treść karty i jej odcisk (`bodyPrint`) zależałyby od cudzej rozmowy.
 */
export function framedDialogText(operation: ScreenOperation, question: string): string {
  const header = operation.header
    .map((line) => line.trim())
    .filter((line) => !HORIZONTAL_RULE_PATTERN.test(line))
    .join('\n');
  return [header, operationText(operation), question.trim()]
    .filter((part) => part !== '')
    .join('\n');
}

/**
 * Kandydaci na fragment ekranu z dialogiem, od NAJWĘŻSZEGO do najszerszego.
 *
 * Wąski kandydat (za ostatnią poziomą kreską) jest lepszy, bo nie ma jak wciągnąć starego
 * wyjścia agenta. Ale na ŻYWYM ekranie kreska potrafi przeciąć samą listę opcji — zmierzone
 * w `rarog-spike` i drugi raz na żywo: formularz `AskUserQuestion` rysuje separator
 * między „4. Type something." a „5. Chat about this", więc wąski region widział JEDNĄ opcję
 * z pięciu. Dlatego kandydatów jest WIELU: poszerzamy region kreska po kresce od dołu ekranu,
 * a rozstrzyga {@link isCompleteOptionSet} — bierzemy pierwszy, który widzi KOMPLETNĄ listę
 * 1…N. Poszerzanie po kreskach (a nie od razu do pełnego ogona) jest tu całą różnicą:
 * scrollback NAD formularzem potrafi nieść własną listę numerowaną (zmierzone —
 * wiadomość agenta „1. Zrestartuj… 2. Przeładuj…" tuż nad dialogiem), a górna kreska
 * formularza jest naturalną granicą, która ją odcina.
 *
 * Pełny ogon zostaje OSTATNIM kandydatem — dla ekranów bez kresek w ogóle.
 *
 * `bounded` mówi, czy region zaczyna się ZA kreską. Rozpoznanie `confirm` wymaga `bounded`:
 * bez widocznej granicy nie wiadomo, czy tekst nad opcjami należy do dialogu, czy do
 * scrollbacku — a treść karty potwierdzenia nie ma prawa nieść cudzej rozmowy (`docs/security-model.md`, „herdr sessions: Rarog writes to a terminal it does not own”, pkt 11).
 */
interface DialogRegion {
  lines: string[];
  bounded: boolean;
}

export function dialogRegions(lines: readonly string[]): DialogRegion[] {
  const floor = Math.max(0, lines.length - DIALOG_TAIL_LINES);
  const tail = lines.slice(floor);
  const candidates: DialogRegion[] = [];
  for (let i = lines.length - 1; i >= floor; i -= 1) {
    if (!HORIZONTAL_RULE_PATTERN.test((lines[i] ?? '').trim())) continue;
    candidates.push({ lines: lines.slice(i + 1), bounded: true });
  }
  candidates.push({ lines: tail, bounded: false });
  return candidates;
}
