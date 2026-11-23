/**
 * Zatwierdzanie formularza `AskUserQuestion` w wariancie z preview — JEDYNE miejsce w Rarogu,
 * które zna klawisz `enter`.
 *
 * Skąd ten moduł: pomiary na żywych panelach (CLI 2.1.246) pokazały, że formularze
 * pytań mają DWA tryby zatwierdzania. Bez preview cyfra wybiera i zatwierdza w jednym kroku
 * (także w formularzu wielopytaniowym, gdzie sama przechodzi do następnego pytania). Z preview
 * cyfra TYLKO przesuwa podświetlenie `❯`, a zatwierdza dopiero `enter` — i obu klawiszy NIE
 * wolno wysłać w jednej ramce: zmierzone dwukrotnie, cyfra ginie, a `enter` zatwierdza opcję
 * DOMYŚLNĄ (najgorszy możliwy skutek). Jedyna uczciwa droga to dwa kroki z odczytem pomiędzy:
 * cyfra → świeży ekran → dowód, że `❯` stoi na wybranej etykiecie → `enter`.
 *
 * Granice modułu (wszystkie świadome):
 *
 * - **`enter` NIE wchodzi do `ALLOWED_KEYS`** (`keys.ts`). Tamta lista obsługuje każdą wysyłkę
 *   klawiszy Raroga; `enter` w niej oznaczałby, że KAŻDA ścieżka umie zatwierdzać po pozycji —
 *   dokładnie to, czego Rarog nie robi nigdy. Tu jest osobna, jednoelementowa lista i osobna asercja,
 *   a klient gniazda ma dla niej osobną metodę (`sendFormSubmit`).
 * - **`enter` idzie najwyżej RAZ na decyzję.** Ponowienie po niepowodzeniu wysyłki albo po
 *   nieudanej weryfikacji byłoby strzałem w ekran, którego nikt nie widział.
 * - **Weryfikacja jest fail-closed w każdą stronę**: brak formularza, inne pytanie, zero albo
 *   dwa podświetlenia, cudza etykieta, tryb edycji notatki — wszystko kończy się odmową
 *   i zdaniem do człowieka, nigdy „spróbujmy mimo to".
 *
 * Moduł jest CZYSTY (bez I/O): decyzję podejmuje na tekście ekranu, wysyła driver.
 */
import { say } from '@rarog/shared/sentences';
import { parseOptions } from '../screen/parse.ts';
import type { LabelGuide, ScreenOption } from '../screen/options.ts';
import { HerdrKeyNotAllowedError } from './keys.ts';

/** Jedyny klawisz zatwierdzania formularza — i jedyne miejsce, które go zna. */
export const FORM_SUBMIT_KEY = 'enter';

/**
 * Asercja ścieżki zatwierdzania: DOKŁADNIE `['enter']`, nic innego, nic więcej.
 *
 * Osobna od `assertAllowedKeys` z tych samych powodów, dla których `enter` nie wchodzi do
 * `ALLOWED_KEYS`: wspólna lista rozszerzałaby uprawnienia każdej ścieżki naraz. Ta asercja
 * pilnuje też, żeby nikt „przy okazji" nie dokleił do zatwierdzenia drugiego klawisza.
 *
 * @throws {HerdrKeyNotAllowedError} gdy tablica nie jest dokładnie `['enter']`
 */
export function assertFormSubmitKeys(keys: readonly string[]): void {
  if (keys.length !== 1 || keys[0] !== FORM_SUBMIT_KEY) {
    throw new HerdrKeyNotAllowedError(
      say('dialogs.form-submit-keys'),
    );
  }
}

/** Czego dowodzimy przed `enter`: że ekran TERAZ podświetla dokładnie tę opcję. */
export interface FormSubmitExpectation {
  /** Opcja, którą wybrała cyfra Raroga (etykieta kanoniczna + cyfra z karty). */
  option: ScreenOption;
  /**
   * Treść pytania z karty, na którą tapnięto — `null`, gdy karta jej nie niosła.
   * Porównujemy PYTANIE, nie tylko etykietę: formularz wielopytaniowy
   * przełącza zakładki bez mignięcia statusu, a opcje sąsiednich pytań potrafią brzmieć
   * identycznie („Tak"/„Nie") — sama etykieta nie dowodzi, że patrzymy na to samo pytanie.
   */
  question: string | null;
  /**
   * `multiSelect` z payloadu hooka, jeżeli karta powstała po cross-checku — ten sam
   * override, który dostał `parseOptions` przy budowie karty. Bez niego formularz uznany za
   * wielokrotny WYŁĄCZNIE przez glify ekranu oddawałby tu `question: null` i weryfikacja
   * kończyłaby się `question-changed` po wysłanej już cyfrze.
   */
  multiSelect?: boolean | undefined;
  /** Etykiety karty — prowadzą odtworzenie etykiet zawiniętych przez wąski panel. */
  labels?: readonly LabelGuide[] | undefined;
}

export type FormSubmitVerdict =
  | { ok: true }
  | {
    ok: false;
    reason:
      /** Ekran nie jest już formularzem pytania (dialog zniknął albo się przemalował). */
      | 'not-a-form'
      /** Formularz stoi, ale nad INNYM pytaniem niż karta, na którą tapnięto. */
      | 'question-changed'
      /** Tryb edycji notatki — cyfra poszła w POLE TEKSTOWE, nie w wybór. */
      | 'notes-editing'
      /** Zero albo więcej niż jedno podświetlenie `❯` — nie wiadomo, co zatwierdziłby enter. */
      | 'no-single-highlight'
      /** Podświetlona jest INNA opcja niż wybrana na karcie. */
      | 'wrong-option';
  };

/**
 * Czy wolno dosłać `enter`? Dowód z ŚWIEŻEGO ekranu, czytanego PO wysłaniu cyfry.
 *
 * Kolejność sprawdzeń od najtwardszej dyskwalifikacji: brak formularza → tryb notatki
 * (cyfra już poszła w tekst — `enter` zamknąłby notatkę, ale wysyłać go i tak nie wolno,
 * bo o „odpowiedzi" nie ma mowy) → inne pytanie → podświetlenie.
 */
export function confirmFormSubmit(
  screenText: string | null,
  expected: FormSubmitExpectation,
): FormSubmitVerdict {
  const dialog = screenText === null
    ? null
    : parseOptions(screenText, { multiSelect: expected.multiSelect, labels: expected.labels });
  if (dialog === null || dialog.kind !== 'question') return { ok: false, reason: 'not-a-form' };
  if (dialog.notesEditing) return { ok: false, reason: 'notes-editing' };
  if (
    expected.question !== null
    && (dialog.question === null || dialog.question.question !== expected.question)
  ) {
    return { ok: false, reason: 'question-changed' };
  }
  const selected = dialog.selected;
  if (selected === null) return { ok: false, reason: 'no-single-highlight' };
  if (selected.label !== expected.option.label || selected.digit !== expected.option.digit) {
    return { ok: false, reason: 'wrong-option' };
  }
  return { ok: true };
}
