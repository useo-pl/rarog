/**
 * Allow-lista klawiszy wysyłanych do cudzego panelu — JEDYNE wejście do `agent.send_keys`
 * w całym kodzie Raroga.
 *
 * To NIE jest granica bezpieczeństwa (obok biegnie kanał wolnego tekstu, który potrafi to samo
 * i więcej) — to zabezpieczenie przed pomyłką programisty i przed cichym rozszerzeniem zakresu
 * przy kolejnej zmianie. Lista jest ZAMKNIĘTA: cokolwiek spoza niej rzuca, ZANIM dotknie gniazda.
 *
 * FALA 1: żadnych cyfr i żadnego `enter`. Cyfry mają sens dopiero z parserem ekranu, a bez
 * niego są wyłącznie zestawem do ślepego klikania w cudzy dialog zgody.
 *
 * Cyfry `1`…`9` WCHODZĄ, bo `screen.resolveOptions` daje im znaczenie — cyfra jest wysyłana
 * wyłącznie wtedy, gdy ekran i jsonl mówią o TYM SAMYM narzędziu, i wyłącznie ta, która na
 * ekranie stoi przy WYBRANEJ ETYKIECIE. Cyfra wybiera i zatwierdza w jednym kroku, więc jest
 * jedynym klawiszem decyzji, jakiego Rarog potrzebuje.
 *
 * Świadomie nigdy — i to jest część kontraktu, nie przeoczenie:
 *
 * - `up`, `down`: a choice by POSITION, which Rarog never makes: option numbering can be shuffled, so "third from the
 *   top" and "option number 3" are two different things, and Rarog has only one of these two sources. The arrows go
 *   out only on separate paths, each with its own closed list, its own one-key assertion and its own client method:
 *   the folder trust step (`trust-step.ts`), the key row of a layer 2 card (`key-row.ts`) and the queue take-back
 *   (`take-back-keys.ts`). The queue take-back also owns `ctrl+u`; its keys are for the prompt field, and that path
 *   never sends `enter` or a digit.
 * - `enter` — TU nigdy. Istnieje wyłącznie w OSOBNEJ, jednoelementowej ścieżce
 *   (`form-submit.ts` + `sendFormSubmit` klienta) dla formularza `AskUserQuestion` z preview,
 *   gdzie cyfra tylko podświetla — i idzie dopiero po dowodzie ze świeżego
 *   ekranu, że `❯` stoi na wybranej ETYKIECIE. W tej liście `enter` oznaczałby zatwierdzanie
 *   po pozycji dla KAŻDEJ ścieżki naraz.
 * - `shift+tab` — cykluje tryb uprawnień CAŁEJ sesji użytkownika; ma
 *   OSOBNĄ, jednoelementową ścieżkę (`mode-cycle.ts` + `sendModeCycle`), jak `enter` — tu nigdy,
 * - `ctrl+v` — schowek macOS jest globalny i wyścigowy,
 * - `ctrl+d`, `ctrl+z`, litery, wolny tekst.
 */
import { say } from '@rarog/shared/sentences';
import { HerdrError } from '../../types.ts';

/**
 * Cyfry decyzji: `1`…`9`.
 *
 * Bez `0`, bo CLI numeruje opcje od 1 (`screen.parseOptions` odrzuca ekran z `0.` jako
 * niezrozumiany) — klawisz, którego nie ma po co wysłać, nie ma po co być na liście.
 */
const DECISION_DIGITS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Klawisze, które Rarog ma prawo wysłać do panelu. */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set(['escape', 'ctrl+c', ...DECISION_DIGITS]);

/**
 * Klawisz spoza allow-listy albo pusta tablica klawiszy.
 *
 * Osobna klasa, a nie zwykły `Error`, bo router mapuje wyjątki po `code`/`name`: `bad-request`
 * daje 400 zamiast 500. Zły klawisz to zawsze błąd programisty, nigdy awaria herdr.
 */
export class HerdrKeyNotAllowedError extends HerdrError {
  override readonly code = 'bad-request';
  override readonly name = 'HerdrKeyNotAllowedError';
}

/**
 * Sprawdza CAŁĄ tablicę przed wysłaniem czegokolwiek.
 *
 * Weryfikacja jest „wszystko albo nic": tablica z jednym złym elementem rzuca w całości i nie
 * wysyłamy poprawnego prefiksu. Połowa sekwencji klawiszy w cudzym terminalu jest gorsza niż
 * brak sekwencji — zostawiałaby panel w stanie, którego nikt nie zaplanował.
 *
 * @throws {HerdrKeyNotAllowedError} gdy tablica jest pusta albo zawiera klawisz spoza listy
 */
export function assertAllowedKeys(keys: readonly string[]): void {
  if (keys.length === 0) {
    throw new HerdrKeyNotAllowedError(say('dialogs.keys-empty'));
  }
  for (const key of keys) {
    if (!ALLOWED_KEYS.has(key)) {
      const allowed = [...ALLOWED_KEYS].join(', ');
      throw new HerdrKeyNotAllowedError(
        say('dialogs.key-not-allowed', { key, allowed }),
      );
    }
  }
}
