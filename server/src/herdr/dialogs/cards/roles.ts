/**
 * Rola opcji odczytanej Z EKRANU: odpowiedź, „wpisz własną odpowiedź" albo wyjście z formularza.
 * Brzmienia chrome CLI biorą się z rejestru sygnatur.
 */
import type { QuestionOptionRole } from '@rarog/shared';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';

/** Pozycja „Type something." — chrome CLI; wzorzec z datą pomiaru stoi w rejestrze sygnatur. */
const CUSTOM_ANSWER_OPTION = SCREEN_SIGNATURES.customAnswerOption.pattern;
/** Pozycja „Chat about this" — WYJŚCIE z formularza; wzorzec w rejestrze sygnatur. */
const CHAT_ABOUT_OPTION = SCREEN_SIGNATURES.chatAboutOption.pattern;

/**
 * Rola opcji Z EKRANU: `custom` dla „wpisz własną odpowiedź", `exit` dla „porozmawiajmy
 * o tym" (wyjście z formularza), `answer` dla reszty. Klient buduje kartę z roli, a brzmienia
 * chrome CLI nie zna — zmiana tekstu w CLI to poprawka sygnatury tutaj, nie wydanie frontu.
 *
 * Wyłącznie dla opcji odczytanych z ekranu. Opcje z payloadu autora (`tool_input`, karta kanału
 * hooka) są zawsze `answer`: chrome CLI w payloadzie nie występuje, a etykieta o tym samym
 * brzmieniu jest tam treścią autora pytania.
 */
export function optionRole(label: string): QuestionOptionRole {
  const text = label.trim();
  if (CUSTOM_ANSWER_OPTION.test(text)) return 'custom';
  if (CHAT_ABOUT_OPTION.test(text)) return 'exit';
  return 'answer';
}
