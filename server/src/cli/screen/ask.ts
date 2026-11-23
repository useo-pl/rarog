/**
 * Question forms of the step screen: `? <one sentence> [y/N] ` (a foreign file or setting; EOF = no),
 * `[Y/n] ` (confirming a plan; Enter = yes, EOF = no) and `[y/N/d] ` (Claude Code settings; `d` shows the full
 * difference and asks again). The question is asked only through `CliIo.ask`, which exists only on a terminal;
 * there is no flag that answers for the user.
 */
import { isYes } from '../io.ts';
import { wrapWords } from './style.ts';

/** Answer hint at the end of each form; measurements recognise a question by this ending. */
export const ANSWER_HINTS = {
  'y/N': '[y/N] ',
  'Y/n': '[Y/n] ',
  'y/N/d': '[y/N/d] ',
} as const;

export type QuestionForm = keyof typeof ANSWER_HINTS;

/** The answer that shows the difference in the `[y/N/d]` form. */
const DIFF_ANSWER = 'd';

/**
 * `answer` to `prompt` shows the difference and the same question comes again: the answer `d` to a `[y/N/d]`
 * prompt. The step screen keeps such a question and its repeat on the screen.
 */
export function showsDiff(prompt: string, answer: string | null): boolean {
  return answer !== null && prompt.endsWith(ANSWER_HINTS['y/N/d']) && answer.trim().toLowerCase() === DIFF_ANSWER;
}

/**
 * Prompt text: `? ` and the question wrapped at word boundaries to one column less than `width`, continuation lines
 * indented by two spaces, the hint on the last line and a trailing space. A line as wide as the terminal would keep
 * the answered question on the screen.
 */
export function questionPrompt(question: string, form: QuestionForm, width: number): string {
  const hint = ANSWER_HINTS[form].trimEnd();
  const lines = wrapWords(`${question} ${hint}`, width - 3, width - 3);
  return `${lines.map((line, index) => `${index === 0 ? '? ' : '  '}${line}`).join('\n')} `;
}

export interface ConfirmOptions {
  /** Layout width for wrapping the question. */
  readonly width: number;
  /** Shows the full difference on the screen; required by the `[y/N/d]` form. */
  readonly showDiff?: () => void | Promise<void>;
}

/**
 * Asks `question` in `form` and returns the decision. `y`, `yes`, `t` and `tak` mean yes in every form; in `[Y/n]`
 * an empty answer (Enter) means yes too. EOF (`null`) is always no. In `[y/N/d]` the answer `d` calls `showDiff`
 * and asks the same question again.
 */
export async function confirm(
  ask: (prompt: string) => Promise<string | null>,
  question: string,
  form: QuestionForm,
  options: ConfirmOptions,
): Promise<boolean> {
  if (form === 'y/N/d' && options.showDiff === undefined) throw new Error('the [y/N/d] form needs showDiff');
  const prompt = questionPrompt(question, form, options.width);
  for (;;) {
    const answer = await ask(prompt);
    if (answer === null) return false;
    if (showsDiff(prompt, answer) && options.showDiff !== undefined) {
      await options.showDiff();
      continue;
    }
    if (form === 'Y/n' && answer.trim() === '') return true;
    return isYes(answer);
  }
}
