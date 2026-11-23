/**
 * Enter wiadomości wklejonej w trakcie tury (trzeci wyjątek obok formularza z preview i dialogu zaufania) — JEDYNE
 * miejsce w Rarogu, które zna klawisz `enter` wysyłki promptu.
 *
 * Skąd ten moduł: `agent.prompt` herdr wkleja tekst i naciska Enter po stałych 300 ms, a herdr sprawdza blokadę panelu
 * raz, na starcie. Dialog zgody albo formularz, który stanie w tym oknie, dostaje Enter: zatwierdza podświetloną opcję
 * po POZYCJI, a tekst wiadomości przepada (pomiar 0a, CLI 2.1.322: 2 z 20). Wysyłka w trakcie tury idzie więc dwoma
 * krokami: samo wklejenie (`pane.send_input` bez klawiszy), sprawdzenie, że tekst stoi w polu i że nic nie stanęło
 * (rejestr sesji CLI, prośba hooka zgody, ekran), dopiero potem ten klawisz.
 *
 * Granice modułu (wszystkie świadome):
 *
 * - **`enter` NIE wchodzi do `ALLOWED_KEYS`** (`keys.ts`): tamta lista obsługuje każdą wysyłkę klawiszy Raroga, więc
 *   `enter` w niej znaczyłby zatwierdzanie po pozycji na każdej ścieżce naraz. Tu jest osobna, jednoelementowa lista,
 *   osobna asercja i osobna metoda klienta (`sendPromptSubmit`), którą woła wyłącznie ścieżka wysyłki w trakcie tury
 *   w driverze.
 * - **`enter` idzie najwyżej RAZ na wklejenie**, po świeżym dowodzie, że pole trzyma wklejony tekst. Coś stanęło po
 *   wklejeniu: klawisza nie ma, wiadomość wraca na początek kolejki drivera.
 *
 * Moduł jest CZYSTY (bez I/O): decyzję podejmuje driver, wysyła klient.
 */
import { say } from '@rarog/shared/sentences';
import { HerdrKeyNotAllowedError } from './keys.ts';

/** Jedyny klawisz wysłania wklejonej wiadomości. */
export const PROMPT_SUBMIT_KEY = 'enter';

/**
 * Asercja ścieżki wysłania wiadomości: DOKŁADNIE `['enter']`, nic innego, nic więcej.
 *
 * @throws {HerdrKeyNotAllowedError} gdy tablica nie jest dokładnie `['enter']`
 */
export function assertPromptSubmitKeys(keys: readonly string[]): void {
  if (keys.length !== 1 || keys[0] !== PROMPT_SUBMIT_KEY) {
    throw new HerdrKeyNotAllowedError(
      say('dialogs.key-not-allowed', { key: keys.join(', '), allowed: PROMPT_SUBMIT_KEY }),
    );
  }
}
