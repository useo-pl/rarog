/**
 * Tryb uprawnień panelu ze stopki ekranu (`⏵⏵ auto mode on`, `⏸  plan mode on` …).
 *
 * Stopka nie jest dialogiem: czytają ją nadzorca (tryb panelu), pętla zmiany trybu (`herdr/mode-cycle.ts`)
 * i bramka wysyłki. Parser bierze kilkanaście ostatnich linii pod ostatnią poziomą kreską i wyrzuca resztę.
 */
import type { HerdrMode } from '@rarog/shared';
import { HORIZONTAL_RULE_PATTERN } from './region.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';
import { MEANINGFUL_PATTERN, trimmedLines } from './text.ts';

/**
 * Ile ostatnich linii ekranu `--source visible` czytamy w poszukiwaniu stopki trybu.
 *
 * Kilka linii to za mało: gdy panel prowadzi subagentów albo workflow, Claude Code rysuje POD
 * stopką trybu tackę agentów (`⏺ main`, `◯ general-purpose …`, po wierszu na agenta) — przy
 * wąskim oknie stopka wypadałaby z niego, `parseMode` oddawałby `unknown`, a po
 * `HERDR_MODE_FRESH_MS` bramka wysyłki odmawiałaby „nie wiem, w jakim trybie jest ten
 * panel" — dokładnie wtedy, gdy człowiek chce dopisać coś pracującej sesji. Okno kończy się
 * na pierwszej poziomej kresce od dołu — nad linią statusu stoi zawsze kreska, a nad nią jest
 * już scrollback, gdzie mogła zostać STARA stopka sprzed `shift+tab`.
 */
export const MODE_FOOTER_LINES = 12;

/**
 * Tryb uprawnień panelu ze stopki ekranu.
 *
 * Pełny słownik stopek ZMIERZONY na żywym panelu (`claude` 2.1.240, cykl
 * `shift+tab` w izolowanej sesji `rarog-spike`):
 *
 *     ⏸  manual mode on · ← 1 agent
 *     ⏵⏵ accept edits on (shift+tab to cycle) · ← 1 agent
 *     ⏸  plan mode on (shift+tab to cycle) · ← 1 agent
 *     ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent
 *     ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
 *
 * Two rules follow from this measurement:
 *
 * 1. **`manual` has its own marker.** "No match → manual" would be false and DANGEROUS: every
 *    screen that hides the footer (the `/status` overlay, a full-screen dialog, a diff) would read
 *    as `manual`, so a pane in `bypass permissions` would lose its chip in Rarog AND the
 *    `RAROG_YOLO_ROOTS` lock. No marker = `unknown` ("don't know"), and the supervisor then keeps
 *    the last known mode.
 * 2. **`accept edits` exists and is not `manual`.** This mode accepts file changes without asking,
 *    so for `HerdrMode` (the contract has no `acceptEdits` variant) we map it to `auto` — the amber
 *    "careful" chip. Showing it as `manual` would promise consent cards that will not come.
 */
export function parseMode(text: string): HerdrMode {
  return collapseFooterMode(parseModeFooter(text));
}

/**
 * Tryb ze stopki DOKŁADNIE tak, jak nazywa go CLI: `acceptEdits` jest tu osobną wartością.
 *
 * Kontrakt `HerdrMode` zlewa `accept edits` z `auto` (chip, bramka wysyłki) i to zostaje —
 * ale pętla zmiany trybu porównuje stopkę z CELEM i musi wiedzieć, że „accept edits"
 * to NIE jest jeszcze `auto` (panel bez prawa do `auto` kończyłby cykl fałszywym sukcesem na
 * `accept edits`).
 */
export type HerdrFooterMode = HerdrMode | 'acceptEdits';

/** `acceptEdits` → `auto`, reszta bez zmian — jedyne miejsce tego zlania. */
export function collapseFooterMode(mode: HerdrFooterMode): HerdrMode {
  return mode === 'acceptEdits' ? 'auto' : mode;
}

export function parseModeFooter(text: string): HerdrFooterMode {
  const lines = trimmedLines(text);
  if (lines.length === 0) return 'unknown';
  /*
   * Od dołu, linia po linii, do `MODE_FOOTER_LINES` w górę albo do pierwszej poziomej kreski
   * — cokolwiek nastąpi wcześniej. Pierwsze trafienie wygrywa: to stopka NAJBLIŻSZA dołu,
   * czyli bieżąca. Pod nią wolno stać tacce agentów (patrz nota przy `MODE_FOOTER_LINES`).
   */
  const stop = Math.max(0, lines.length - MODE_FOOTER_LINES);
  for (let i = lines.length - 1; i >= stop; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (HORIZONTAL_RULE_PATTERN.test(line)) break;
    const mode = modeFromLine(line);
    if (mode !== 'unknown') return mode;
  }
  return 'unknown';
}

/** Tryb z JEDNEJ linii ekranu; `unknown`, gdy nie ma w niej markera stopki. */
function modeFromLine(line: string): HerdrFooterMode {
  if (!MEANINGFUL_PATTERN.test(line)) return 'unknown';
  const lower = line.toLowerCase();
  for (const [marker, mode] of MODE_FOOTER_MARKERS) {
    if (lower.includes(marker)) return mode;
  }
  return 'unknown';
}

/**
 * Słownik stopek trybu, w KOLEJNOŚCI sprawdzania — markery z rejestru sygnatur.
 *
 * `accept edits` nie ma własnego wariantu w kontrakcie `HerdrMode`: `collapseFooterMode` zlewa
 * go z `auto`, bo tak samo jak `auto` wykonuje zmiany bez pytania — tylko w węższym zakresie.
 * Tu, w słowniku, zostaje DOKŁADNY (pętla przełączania trybu musi go odróżnić od celu `auto`).
 */
const MODE_FOOTER_MARKERS: readonly (readonly [string, HerdrFooterMode])[] = [
  [SCREEN_SIGNATURES.modeFooterBypass.pattern, 'bypass'],
  [SCREEN_SIGNATURES.modeFooterAuto.pattern, 'auto'],
  [SCREEN_SIGNATURES.modeFooterAcceptEdits.pattern, 'acceptEdits'],
  [SCREEN_SIGNATURES.modeFooterPlan.pattern, 'plan'],
  [SCREEN_SIGNATURES.modeFooterManual.pattern, 'manual'],
];
