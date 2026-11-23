/**
 * Czy na ekranie stoi dialog albo formularz — odpowiedzi dla rezerw fasady drivera: formularza
 * `AskUserQuestion` i rejestru sesji CLI.
 *
 * Obie funkcje mają trzecią odpowiedź, `unknown`: odczyt, który niczego nie dowodzi, nie jest ani
 * obecnością, ani zniknięciem dialogu.
 */
import { isReviewDialog } from './screen/review.ts';
import { parseOptions, screenOnlyDialog } from './screen/parse.ts';
import { matchKnownDialog } from './screen/known.ts';
import { standingConsentDialog } from './policy/consent.ts';
import { composerRegionState } from '../../drivers/herdr/commands.ts';

/**
 * Czy na ekranie stoi dialog — dla rezerwy z rejestru sesji CLI.
 *
 * - `dialog`: parser widzi dialog o znanym kształcie (zgoda, pytanie, potwierdzenie), dialog
 *   z zamkniętej listy, dialog zgody CLI albo dialog sieci sandboksa;
 * - `none`: widać pole promptu (ramka `────` nad i pod `❯`) — CLI chowa je pod każdym
 *   dialogiem, więc to jedyny pozytywny dowód „dialogu NIE MA";
 * - `unknown`: ani jedno, ani drugie — `/login`, ekran w trakcie rysowania, dialog bez cyfr.
 *   Przy rejestrze `waiting` to dalej dialog, tylko nieczytelny: karta bez decyzji.
 *
 * Numerowana lista z odpowiedzi agenta parsuje się jako `other` i nie jest tu dowodem niczego.
 */
export function cliDialogOnScreen(text: string): 'dialog' | 'none' | 'unknown' {
  const dialog = parseOptions(text);
  if (dialog !== null && (dialog.kind !== 'other' || matchKnownDialog(text, dialog) !== null)) {
    return 'dialog';
  }
  if (standingConsentDialog(text) !== null || screenOnlyDialog(text)) return 'dialog';
  return composerRegionState(text) === 'unknown' ? 'unknown' : 'none';
}

/**
 * Czy na ekranie stoi formularz `AskUserQuestion` — wyłącznie dla rezerwy formularza.
 *
 * `form` obejmuje też ekran PRZEGLĄDU odpowiedzi („Review your answers" + „Submit answers"):
 * to ostatni krok tego samego formularza na torze cyfry, który parser czyta jako `confirm`
 * (`decide/decide.ts`, `reviewStep`). `unknown` = ekranu nie udało się odczytać — to nie jest dowód
 * ani obecności, ani zniknięcia formularza.
 */
export function askFormOnScreen(text: string | null): 'form' | 'none' | 'unknown' {
  if (text === null) return 'unknown';
  const dialog = parseOptions(text);
  if (dialog === null) return 'none';
  return dialog.kind === 'question' || isReviewDialog(dialog) ? 'form' : 'none';
}
