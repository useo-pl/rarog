/**
 * Ekran PRZEGLĄDU odpowiedzi formularza („Review your answers” + „Submit answers”): rozpoznanie ekranu
 * i pary „pytanie → odpowiedzi” czytane z surowych linii.
 */
import type { ScreenOption } from './options.ts';
import type { ScreenDialog } from './parse.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';
import { clean } from './text.ts';

/** Nagłówek ekranu przeglądu odpowiedzi — zmierzony (`…-multi-live-review.txt`). */
const REVIEW_HEADER_PATTERN = SCREEN_SIGNATURES.reviewHeader.pattern;

/** Opcja, którą ekran przeglądu wysyła zebrane odpowiedzi. */
const REVIEW_SUBMIT_PATTERN = SCREEN_SIGNATURES.reviewSubmit.pattern;

/**
 * Ekran PRZEGLĄDU odpowiedzi formularza — warunek NEGATYWNY sygnatury multi-select.
 *
 * Po zaznaczeniu pozycji i „Submit" formularz wielokrotny pokazuje podsumowanie
 * („Review your answers" + lista wybranych + „Ready to submit your answers?") z DWIEMA
 * zwykłymi opcjami: „1. Submit answers" / „2. Cancel". Checkboxów tu nie ma, ale pasek
 * zakładek dalej niesie „✔ Submit" — pierwszy człon sygnatury nr 2 z {@link formMultiSelect}.
 * Bez tego warunku ostatni krok formularza (jedna cyfra, żadnego `space`) zostawał kartą
 * „odpowiedz w terminalu", choć jest dokładnie tym, co Rarog umie zrobić uczciwie.
 *
 * Warunki są DWA i oba muszą trafić: samo zdanie w scrollbacku (agent cytujący „Review your
 * answers") nie ma prawa rozbroić sygnatury multi-select prawdziwego formularza.
 */
export function isReviewScreen(
  region: readonly string[], options: readonly ScreenOption[],
): boolean {
  return region.some((line) => REVIEW_HEADER_PATTERN.test(line.trim()))
    && options.some((option) => REVIEW_SUBMIT_PATTERN.test(option.label));
}

/**
 * To samo rozpoznanie na GOTOWYM dialogu (dla `resolveOptions`, które regionu już nie ma):
 * ekran przeglądu parsuje się jako `confirm`, a jego treść ZACZYNA SIĘ nagłówkiem przeglądu
 * (oba zrzuty: `…-multiq-review.txt`, `…-multi-live-review.txt`). Warunki znów są DWA.
 *
 * Eksport: rezerwa formularza bez blokady herdr uznaje ekran przeglądu
 * za dalszy ciąg TEGO SAMEGO formularza — bez tego gasła na jego ostatnim kroku.
 */
export function isReviewDialog(dialog: ScreenDialog): boolean {
  if (dialog.kind !== 'confirm' || dialog.question === null) return false;
  return isReviewForm({ question: dialog.question.question, options: dialog.options });
}

/**
 * To samo rozpoznanie na formularzu z `resolveOptions` (`questionForm`) — dla pary
 * „pytanie → odpowiedź" na karcie przeglądu. Rodzaj (`confirm`) sprawdza wołający.
 */
export function isReviewForm(
  form: { question: string; options: readonly ScreenOption[] },
): boolean {
  const first = form.question.split('\n')[0] ?? '';
  return REVIEW_HEADER_PATTERN.test(first.trim())
    && form.options.some((option) => REVIEW_SUBMIT_PATTERN.test(option.label));
}

/** Pytanie na liście przeglądu — `● treść`. */
const REVIEW_QUESTION_PATTERN = SCREEN_SIGNATURES.reviewQuestion.pattern;

/** Odpowiedź na liście przeglądu — `→ wartość`; przy wielokrotnym wyborze kilka linii. */
const REVIEW_ANSWER_PATTERN = SCREEN_SIGNATURES.reviewAnswer.pattern;

/** Para ekranu przeglądu: treść pytania i odpowiedzi w kolejności rysowania. */
export interface ScreenReviewPair {
  question: string;
  answers: string[];
}

/**
 * Pary „pytanie → odpowiedzi" z ekranu przeglądu formularza albo `null`.
 *
 * Czytamy SUROWE linie ekranu z wcięciem, nie linie już przycięte przez parser: w nich zawinięte
 * pytanie albo odpowiedź traciłoby dalszy ciąg (linia bez `●`/`→` nie należałaby do niczego). CLI
 * rysuje listę w kolumnach (`● ` od 1, `→ ` od 3; fixture `dialog-askuserquestion-multiq-review.txt`),
 * a zawinięty tekst ciągnie się wcięty pod swoim początkiem. Zasady:
 *
 * - lista zaczyna się pod OSTATNIM nagłówkiem przeglądu (dialog stoi na dole ekranu, wyżej
 *   bywa scrollback z cytatem tego zdania);
 * - linia wcięta, bez `●`/`→`, dokleja się spacją do ostatniego elementu (pytania albo
 *   odpowiedzi) — to jest zawinięcie przez wąski panel;
 * - pusta linia albo linia od kolumny 0 kończy listę („Ready to submit your answers?", opcje).
 *
 * Odpowiedź bez pytania nad sobą i pytanie bez odpowiedzi to ekran, którego nie rozumiemy —
 * `null`, a karta pokazuje wtedy dosłowną treść (fail-closed na treści, nie
 * na decyzji: opcje i cyfry karty i tak pochodzą z ekranu).
 */
export function reviewPairsFrom(text: string): ScreenReviewPair[] | null {
  const lines = clean(text).split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (REVIEW_HEADER_PATTERN.test((lines[i] ?? '').trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const pairs: ScreenReviewPair[] = [];
  let last: 'question' | 'answer' | null = null;
  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '') {
      // Puste linie PRZED listą (odstęp pod nagłówkiem) są normalne; po niej — koniec listy.
      if (pairs.length === 0) continue;
      break;
    }
    const pair = pairs[pairs.length - 1];
    if (REVIEW_QUESTION_PATTERN.test(trimmed)) {
      pairs.push({ question: trimmed.replace(REVIEW_QUESTION_PATTERN, '').trim(), answers: [] });
      last = 'question';
    } else if (REVIEW_ANSWER_PATTERN.test(trimmed)) {
      if (pair === undefined) return null;
      pair.answers.push(trimmed.replace(REVIEW_ANSWER_PATTERN, '').trim());
      last = 'answer';
    } else if (/^\s/.test(raw) && pair !== undefined) {
      // Zawinięcie: dalszy ciąg ostatniego elementu, wcięty pod jego początkiem.
      if (last === 'answer') {
        const index = pair.answers.length - 1;
        pair.answers[index] = `${pair.answers[index] ?? ''} ${trimmed}`;
      } else {
        pair.question = `${pair.question} ${trimmed}`;
      }
    } else {
      break;
    }
  }
  if (pairs.length === 0) return null;
  return pairs.every((pair) => pair.question !== '' && pair.answers.length > 0) ? pairs : null;
}
