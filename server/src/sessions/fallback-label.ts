/**
 * The fallback label `session N` of a card without a prompt: the next number in a project and whether a label is still
 * a fallback (the first prompt may overwrite it). Pure functions over the labels; the manager owns the cards.
 */
import { say } from '@rarog/shared/sentences';

/**
 * Wzorzec fallbacku — po nim liczy się kolejny numer w projekcie. Przyjmuje dzisiejsze `session N` (zdanie
 * `session.fallback-label`) i dawne `sesja N` z rejestru sprzed angielskich zdań: numeracja idzie dalej po restarcie,
 * a pierwszy prompt nadpisuje obie formy.
 */
const FALLBACK_LABEL = /^(?:sesja|session) (\d+)$/;

/**
 * Kolejny fallback `session N` dla projektu.
 *
 * N liczymy jako `max(dotychczasowe N) + 1`, a NIE jako „liczba sesji + 1": zamknięcie
 * środkowej sesji nie może przenumerować pozostałych (spec, punkt 1). Etykiety pochodzą
 * z rejestru, więc numeracja przeżywa restart backendu.
 */
export function nextFallbackLabel(existingLabels: Iterable<string | undefined>): string {
  let max = 0;
  for (const label of existingLabels) {
    if (label === undefined) continue;
    const match = FALLBACK_LABEL.exec(label);
    if (match === null) continue;
    const n = Number(match[1]);
    // Etykieta z promptu („session 99999999999999999999”) wygląda jak fallback; numer, którego następnik nie jest
    // bezpieczną liczbą całkowitą, pomijamy, bo `say()` odrzuciłby go i zakładanie sesji by padło.
    if (Number.isSafeInteger(n + 1) && n > max) max = n;
  }
  return say('session.fallback-label', { n: max + 1 }).text;
}

/** Czy etykieta jest jeszcze fallbackiem (czyli wolno ją nadpisać pierwszym promptem)? */
export function isFallbackLabel(label: string | undefined): boolean {
  return label !== undefined && FALLBACK_LABEL.test(label);
}
