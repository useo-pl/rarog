/**
 * Nazwa pliku planu ze STOPKI dialogu `ExitPlanMode`: `ctrl+g to edit in Nvim · ~/.claude/plans/<nazwa>.md`, ostatnia
 * grupa niepustych linii ekranu, za podpowiedzią CLI opcji 3 (`shift+tab to approve with this feedback`). To jedyne
 * źródło tożsamości planu na ekranie (`ScreenDialog.planFile`): treść planu, scrollback, linie opcji i feedback
 * wpisany w opcji 3 („Tell Claude what to change”, dowolny tekst człowieka) nazwy nie dają, choćby stała w nich pełna
 * ścieżka albo cała imitacja stopki. Opis: `docs/dialogs.md`, „Rules: what must not be relaxed”.
 */
import { SCREEN_SIGNATURES } from './signatures.ts';

/** Stopka sklejona z linii bez wcięć; grupa 1 to nazwa pliku planu. */
const PLAN_FOOTER_PATTERN = SCREEN_SIGNATURES.planFooter.pattern;

/** Podpowiedź CLI pod opcją 3 (linia bez wcięć) — granica między polem opcji a stopką. */
const PLAN_FEEDBACK_HINT_PATTERN = SCREEN_SIGNATURES.planFeedbackHint.pattern;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Nazwa pliku planu ze stopki albo `null`.
 *
 * Układ zmierzony na CLI 2.1.258–2.1.314: ostatnia opcja, podpowiedź CLI, pusta linia, stopka. Feedback opcji 3 stoi
 * w polu opcji, czyli głębiej niż cyfra opcji, a stopka płycej, przy krawędzi dialogu. Warunki, wszystkie naraz:
 *
 * - stopka to ostatnia grupa niepustych linii ekranu, za pustą linią;
 * - najbliższa niepusta linia nad nią to podpowiedź CLI i stoi pod ostatnią linią opcji;
 * - każda linia stopki ma to samo wcięcie, płytsze niż kolumna cyfry ostatniej opcji i niż wcięcie podpowiedzi.
 *
 * Odczyt urwany w feedbacku (imitacja stopki po pustej linii, bez prawdziwej podpowiedzi i stopki niżej) żadnego
 * z tych warunków nie przechodzi, imitacja z przepisaną podpowiedzią odpada na wcięciu. Wąski panel łamie stopkę na
 * kilka linii, także w środku nazwy, więc linie sklejamy po zdjęciu wcięcia bez separatora. Stopka ucięta u dołu,
 * z dodatkową treścią albo z drugą ścieżką nie pasuje do wzorca. Każdy niespełniony warunek daje `null`.
 *
 * @param lines linie ekranu po `trimmedLines`
 * @param lastOption indeks ostatniej linii opcji dialogu w `lines`
 * @param optionColumn kolumna cyfry ostatniej opcji w `lines[lastOption]`; `-1` = nieznana
 */
export function planFooterFile(lines: readonly string[], lastOption: number, optionColumn: number): string | null {
  if (optionColumn < 0) return null;
  let start = lines.length;
  while (start > 0 && (lines[start - 1] ?? '').trim() !== '') start -= 1;
  if (start <= lastOption + 1 || start === lines.length) return null;
  let hint = start - 1;
  while (hint > lastOption && (lines[hint] ?? '').trim() === '') hint -= 1;
  const hintLine = lines[hint] ?? '';
  if (hint <= lastOption || !PLAN_FEEDBACK_HINT_PATTERN.test(hintLine.trim())) return null;
  const footer = lines.slice(start);
  const indent = indentOf(footer[0] ?? '');
  if (indent >= optionColumn || indent >= indentOf(hintLine) || footer.some((line) => indentOf(line) !== indent)) {
    return null;
  }
  return PLAN_FOOTER_PATTERN.exec(footer.map((line) => line.trim()).join(''))?.[1] ?? null;
}
