/**
 * CLI dialogs recognized on the screen alone: the closed list `TERMINAL_DIALOGS`, the match by title and the whole
 * set of options, the content cap, and the measured keys that let layer 2 give such a dialog buttons. Today's card of
 * such a dialog has no button; this module sends no key and builds no card.
 */
import type { ScreenOption } from '../screen/options.ts';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';

/**
 * Sufit treści dialogu z listy {@link TERMINAL_DIALOGS} — wyższy niż {@link CONFIRM_QUESTION_MAX_CHARS}.
 *
 * Tamten sufit chroni kartę przed scrollbackiem, który wjechał w kandydata. Tu region zaczyna się
 * od tytułu z zamkniętej listy tuż pod kreską, więc treść pod nim należy do dialogu: pauza po fladze
 * zabezpieczeń ma ~480 znaków przy 128 kolumnach, a lista zadań w dialogu wyjścia rośnie z ich liczbą.
 * Dłuższa treść = dialog spoza listy, czyli karta z wycinkiem.
 */
export const TERMINAL_DIALOG_MAX_CHARS = 2000;

/**
 * One key of a {@link TERMINAL_DIALOGS} entry measured on the live CLI: the CLI version of the measurement and the
 * capture of the dialog the key went to (`server/test/fixtures/herdr/kontrolny/…`). The effect of each key stands in
 * `docs/dialogs.md`, "CLI dialogs answered in the terminal".
 */
export interface KeyMeasurement {
  readonly cli: string;
  readonly capture: string;
}

/** The measured keys of an entry: one per option, in the order of its `options`, and Esc. */
export interface KeysMeasured {
  readonly options: readonly KeyMeasurement[];
  readonly escape: KeyMeasurement;
}

/** Keys as recorded; `null` = that key is unmeasured. */
export interface KeyMeasurements {
  readonly options: readonly (KeyMeasurement | null)[];
  readonly escape: KeyMeasurement | null;
}

/**
 * The confirmation of an entry with `optionCount` options: the measurements when every option and Esc has one, else
 * `null` (fail closed: one unmeasured key leaves the whole dialog without buttons).
 */
export function confirmedKeys(measured: KeyMeasurements, optionCount: number): KeysMeasured | null {
  const { options, escape } = measured;
  if (escape === null || options.length !== optionCount) return null;
  const complete = options.filter((key): key is KeyMeasurement => key !== null);
  return complete.length === optionCount ? { options: complete, escape } : null;
}

/** The pause, measured on CLI 2.1.322 after a fake API refusal (control set, fixture `kontrolny/pauza-2.1.322.txt`). */
const PAUSE_M1: KeyMeasurement = { cli: '2.1.322', capture: 'kontrolny/pauza-2.1.322.txt' };

/** The exit with background work under the status rule, measured on CLI 2.1.322 (`kontrolny/wyjscie-tlo-…`). */
const EXIT_M1: KeyMeasurement = { cli: '2.1.322', capture: 'kontrolny/wyjscie-tlo-2.1.322.txt' };

const PAUSE_OPTIONS = [
  SCREEN_SIGNATURES.sessionPausedSwitchOption.pattern,
  SCREEN_SIGNATURES.sessionPausedRetryOption.pattern,
] as const;

const EXIT_OPTIONS = [
  SCREEN_SIGNATURES.backgroundWorkExitOption.pattern,
  SCREEN_SIGNATURES.backgroundWorkDetachOption.pattern,
  SCREEN_SIGNATURES.backgroundWorkStayOption.pattern,
] as const;

/**
 * CLI dialogs Rarog RECOGNIZES on the screen alone. Both stand outside jsonl and without
 * the hook, so without this list they would give a card without content and without buttons (`no-jsonl`).
 *
 * Today's card (`resolveOptions`) carries the title, the content and the LITERAL options, EACH with `terminalOnly`:
 * no button of that card picks an option, and the digit path refuses it whatever the app shows. Buttons come only
 * from layer 2 (`RAROG_DIALOG_LAYER2=1`, `layer2/verdict.ts`), and only for an entry with `keysMeasured`: the
 * measurement of the key and the effect of every option and of Esc (CLI version and control set capture,
 * {@link confirmedKeys}). Without it, or with the flag `0`, the dialog keeps today's card ("answer in the terminal").
 * `docs/security-model.md`, "Starting sessions from the phone: three powers", item 14; `docs/dialogs.md`, "CLI dialogs
 * answered in the terminal".
 *
 * The match is CLOSED in both dimensions: the title in the first line of the region behind a rule and the WHOLE set
 * of options, as many options as patterns, each hit by another pattern. An option off the list rules the match out.
 *
 * - `session-paused-safeguards`: the pause after a model safeguard flag (`Details: [cyber]`), exactly the options
 *   "Switch to …" and "Edit prompt and retry with …". Another pause with this title and another option set stays
 *   a snippet card. The pause has no key footer, so its card never offers Esc, and the driver does not send Esc on
 *   any pause ({@link sessionPausedDialog}).
 * - `background-work-exit`: exit from a session with background tasks. The footer "Esc to cancel" means "Stay" here
 *   (measured on CLI 2.1.322), so the card offers Esc.
 */
export const TERMINAL_DIALOGS = [
  {
    id: 'session-paused-safeguards',
    title: SCREEN_SIGNATURES.sessionPausedTitle.pattern,
    options: PAUSE_OPTIONS,
    keysMeasured: confirmedKeys({ options: [PAUSE_M1, PAUSE_M1], escape: PAUSE_M1 }, PAUSE_OPTIONS.length),
  },
  {
    id: 'background-work-exit',
    title: SCREEN_SIGNATURES.backgroundWorkTitle.pattern,
    options: EXIT_OPTIONS,
    keysMeasured: confirmedKeys({ options: [EXIT_M1, EXIT_M1, EXIT_M1], escape: EXIT_M1 }, EXIT_OPTIONS.length),
  },
] as const;

export type TerminalDialogId = (typeof TERMINAL_DIALOGS)[number]['id'];

/** Identyfikatory listy {@link TERMINAL_DIALOGS} — zamknięta lista pola `dialogTitle` w dzienniku. */
export const TERMINAL_DIALOG_IDS: readonly TerminalDialogId[] = TERMINAL_DIALOGS.map((dialog) => dialog.id);

/**
 * Który dialog z {@link TERMINAL_DIALOGS} to jest — po tytule (pierwsza linia regionu za kreską)
 * i KOMPLECIE opcji. `null` = żaden.
 */
export function matchTerminalDialog(title: string, options: readonly ScreenOption[]): TerminalDialogId | null {
  for (const dialog of TERMINAL_DIALOGS) {
    if (!dialog.title.test(title.trim()) || options.length !== dialog.options.length) continue;
    const taken = new Set<string>();
    const complete = dialog.options.every((pattern) => {
      const hit = options.find((option) => !taken.has(option.digit) && pattern.test(option.label));
      if (hit === undefined) return false;
      taken.add(hit.digit);
      return true;
    });
    if (complete) return dialog.id;
  }
  return null;
}
