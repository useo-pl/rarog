/**
 * Rodzaj dialogu z markerów stopki i nagłówka (te same, których używa herdr) oraz sygnatury dialogu planu
 * i nazwa nadawana przez Raroga dialogowi sieci sandboksa.
 */
import { SCREEN_SIGNATURES } from './signatures.ts';

/** Markery stopki dialogu zgody na narzędzie (`bash_permission_prompt`, `generic_…`). */
const TOOL_DIALOG_MARKERS: readonly string[] = SCREEN_SIGNATURES.toolDialogMarkers.pattern;

/** Markery nawigacji formularza `AskUserQuestion` (`live_blocked_form`). */
const QUESTION_NAV_MARKERS: readonly string[] = SCREEN_SIGNATURES.questionNavMarkers.pattern;

/** Stopka wyboru formularza `AskUserQuestion` — drugi warunek rodzaju `question` obok markera nawigacji. */
const QUESTION_SELECT_FOOTER = SCREEN_SIGNATURES.questionSelectFooter.pattern;

/**
 * Sygnatura dialogu `ExitPlanMode` — jedno zdanie, zmierzone na żywo.
 *
 * Pełny ekran: „Claude has written up a plan and is ready to execute. Would you like to
 * proceed?" + TRZY opcje („Yes, and use auto mode" / „Yes, manually approve edits" / „Tell
 * Claude what to change"). Dopasowujemy sam nagłówek, bo etykiety opcji zmieniają się między
 * wersjami CLI, a cyfra i tak idzie z TREŚCI etykiety.
 */
export const PLAN_DIALOG_PATTERN = SCREEN_SIGNATURES.planDialog.pattern;

/**
 * „Exit plan mode?" — `ExitPlanMode` wywołany BEZ pliku planu. Inny dialog niż
 * z planem: tytuł, zdanie „Claude wants to exit plan mode" i dwie opcje (zrzut
 * `measured/exitplanmode-bez-planu-2.1.293.txt`). Bez tego wzorca parser widziałby tu `confirm`,
 * więc przy wpisie `ExitPlanMode` w jsonl karta kończyłaby się `mismatch/kind`.
 */
export const PLAN_EXIT_CONFIRM_PATTERN = SCREEN_SIGNATURES.planExitConfirm.pattern;

/** Nazwa „narzędzia" karty dialogu sieci sandboksa — nie istnieje w CLI, nadaje ją Rarog. */
export const SANDBOX_NETWORK_TOOL = 'SandboxNetwork';

export type ScreenDialogKind = 'tool' | 'question' | 'confirm' | 'other';

/** Rodzaj dialogu wyłącznie ze stopki i nagłówka — te same markery, których używa herdr. */
export function dialogKind(regionLower: string): ScreenDialogKind {
  if (TOOL_DIALOG_MARKERS.some((marker) => regionLower.includes(marker))) return 'tool';
  if (
    regionLower.includes(QUESTION_SELECT_FOOTER)
    && QUESTION_NAV_MARKERS.some((marker) => regionLower.includes(marker))
  ) {
    return 'question';
  }
  return 'other';
}
