/**
 * Karta bloku bez cyfr warstwy 2: wycinek bloku dialogu z ekranu bez opcji z cyframi (widok slash-komendy, zaufanie
 * bez cyfr), z sufitem warstwy 2.
 *
 * Funkcja jest czysta, nad tekstem ekranu. Blok czyta `readBlock` (`read-block.ts`, góra bloku z `blockTopOf`).
 * Wycinek to linie od tytułu bloku do dołu ekranu, ten sam tekst co `blockExcerpt` (`screen/excerpt.ts`) daje karcie
 * bez flagi, ale z wyższym sufitem ({@link LAYER2_EXCERPT_MAX_LINES}, {@link LAYER2_EXCERPT_MAX_CHARS}), więc cały
 * widok `/skills` mieści się na karcie. Ogon ekranu (`screen/snippet.ts`) zostaje przy swoim sufitcie.
 *
 * Odcisk bloku (`Block.print`) jedzie z kartą: ta sama tożsamość karty (tytuł bloku) i inny odcisk znaczą, że widok
 * pod kartą się zmienił (następna zakładka `/status`), więc decyzja odświeża wycinek zamiast trzymać stary.
 *
 * Woła ją decyzja (`decide/decide.ts`) wyłącznie przy fladze warstwy 2, która dociera parametrem. Wycinek i tytuł
 * trafiają WYŁĄCZNIE na kartę tej jednej sesji; do dziennika idzie sam powód z {@link LAYER2_WHYS}.
 *
 * The file also holds the gate of the layer 2 card with buttons ({@link layer2Gate}: flag, engine, then the rule
 * `layer2Verdict`) and the episode verdict of the audit line ({@link episodeVerdictOf}). Both are pure; the occurrence
 * record, the pair of reads and the audit line live in the driver module `drivers/herdr/layer2-card.ts`.
 */
import { createHash } from 'node:crypto';
import type { CliDialogClass } from '@rarog/shared';
import { readBlock } from './read-block.ts';
import type { Block } from './read-block.ts';
import { layer2Verdict } from './verdict.ts';
import type { Layer2Verdict } from './verdict.ts';
import { MEANINGFUL_PATTERN, trimmedLines } from '../screen/text.ts';

/** Sufit wycinka bloku warstwy 2 w liniach (`/skills` na CLI 2.1.310: 44 linie). */
export const LAYER2_EXCERPT_MAX_LINES = 60;

/** Sufit wycinka bloku warstwy 2 w znakach (`/skills` na CLI 2.1.310: ok. 3300 znaków). */
export const LAYER2_EXCERPT_MAX_CHARS = 4000;

/**
 * Reasons for no buttons that come from reading the block: the dialog is there, but the rule cannot say what its
 * options are. The layer 2 audit counts them as "unknown".
 */
export const LAYER2_READ_ERRORS = [
  'no-block', 'numbering', 'foreign-line', 'extra-below', 'submit-unknown', 'frame', 'multi-select', 'submenu',
  'block-no-digits', 'label-ambiguous',
] as const;

/**
 * Refusals out of caution: the block reads, but a key could land in the wrong place or outside layer 2, or do more
 * than its label says (`sets-default`: the footer says Enter saves a default for new sessions).
 */
export const LAYER2_CAUTION = [
  'unstable', 'class-not-dialog', 'class-unknown', 'terminal-dialog', 'too-many', 'label-cut', 'scroll', 'cut-bottom',
  'rule-above', 'engine-not-claude', 'layer2-off', 'sets-default',
] as const;

/** Refusals at the tap: the card stood, but the screen, the hook or the CLI session changed under it. */
export const LAYER2_TAP_REFUSALS = ['screen-changed', 'stale-card', 'hook', 'session-moved'] as const;

/**
 * Reason of a layer 2 card without buttons (`block-card.layer2Why` in the audit log): the one closed list, in three
 * groups above. A value off the list does not reach the log file. A new value needs an entry here and a test.
 */
export const LAYER2_WHYS = [...LAYER2_READ_ERRORS, ...LAYER2_CAUTION, ...LAYER2_TAP_REFUSALS] as const;
export type Layer2Why = (typeof LAYER2_WHYS)[number];

/** Ślad warstwy 2 na karcie: powód do dziennika i odcisk bloku, z którego powstał wycinek. */
export interface Layer2Mark {
  readonly why: Layer2Why;
  /** Odcisk bloku (`Block.print`, 16 znaków hex): inny przy tej samej tożsamości karty = odświeżyć wycinek. */
  readonly print: string;
}

/** Wycinek bloku bez cyfr na kartę bez przycisków. */
export interface Layer2BlockExcerpt {
  /** Blok od tytułu do dołu ekranu, bez ANSI, linie przycięte z prawej. */
  readonly text: string;
  /** Tytuł bloku bez białych znaków na brzegach — do tożsamości karty, nigdy do dziennika. */
  readonly title: string;
  readonly mark: Layer2Mark;
}

/**
 * Wycinek bloku bez opcji z cyframi albo `null`: ekran bez bloku z tytułem, blok z opcjami, blok bez litery i cyfry
 * albo ponad sufit warstwy 2. Przy `null` decyzja zostaje przy dzisiejszym wycinku (`blockExcerpt`) albo ogonie
 * ekranu.
 */
export function blockNoDigitsExcerpt(text: string): Layer2BlockExcerpt | null {
  const block = readBlock(text);
  if (block === null || block.options.length > 0) return null;
  const lines = trimmedLines(text).slice(block.titleLine);
  const out = lines.join('\n');
  if (lines.length > LAYER2_EXCERPT_MAX_LINES || out.length > LAYER2_EXCERPT_MAX_CHARS
    || !MEANINGFUL_PATTERN.test(out)) {
    return null;
  }
  return { text: out, title: block.title, mark: { why: 'block-no-digits', print: block.print } };
}

/** Reason of a block that stood in no pair of equal reads ({@link LAYER2_WHYS}); today's card stays. */
export const LAYER2_UNSTABLE: Layer2Why = 'unstable';

/** Reason of a screen without a block (a read in mid-repaint): a standing layer 2 card stays. */
export const LAYER2_NO_BLOCK: Layer2Why = 'no-block';

/** Tap refusal: the registry does not say `waiting` with class `dialog` right before the key (`keyShield`). */
export const LAYER2_CLASS_UNKNOWN: Layer2Why = 'class-unknown';

/** Tap refusal: the pane runs another engine session than the one the card was issued in (`/clear`, `/resume`). */
export const LAYER2_SESSION_MOVED: Layer2Why = 'session-moved';

/** What layer 2 knows about the pane besides the screen. */
export interface Layer2Context {
  /** Flag `RAROG_DIALOG_LAYER2`. */
  readonly enabled: boolean;
  /** Engine of the pane (`claude`, `codex`): layer 2 reads Claude Code dialogs only. */
  readonly engine: string;
  /** Class of the standing dialog from the CLI registry (`waitingFor`); `null` = the registry does not say `waiting`. */
  readonly cliClass: CliDialogClass | null;
}

/**
 * The layer 2 verdict for a block in its context: the flag first (`layer2-off`), then the engine
 * (`engine-not-claude`), then the rule over the block (`layer2Verdict`: class, top, options, end proof). It says what
 * buttons the block would get; whether today's card already has buttons the caller decides before it asks.
 */
export function layer2Gate(block: Block | null, context: Layer2Context): Layer2Verdict {
  const off = layer2Off(context);
  return off === null ? layer2Verdict(block, context.cliClass) : { kind: 'none', why: off };
}

/** The flag and engine gates of {@link layer2Gate} alone: the reason layer 2 does not run, `null` = it runs. */
export function layer2Off(context: Pick<Layer2Context, 'enabled' | 'engine'>): Layer2Why | null {
  if (!context.enabled) return 'layer2-off';
  if (context.engine !== 'claude') return 'engine-not-claude';
  return null;
}

/**
 * Verdict of a layer 2 episode in the audit line `layer2-episode`: `choices` (at least one button besides Esc),
 * `esc-only` (Esc alone), `existing` (today's card had buttons, layer 2 did not act) and `none` (no buttons, with a
 * reason from {@link LAYER2_WHYS}). Closed list, read by the episode audit.
 */
export const LAYER2_EPISODE_VERDICTS = ['choices', 'esc-only', 'existing', 'none'] as const;
export type Layer2EpisodeVerdict = (typeof LAYER2_EPISODE_VERDICTS)[number];

/** Episode verdict of a rule verdict: Esc alone counts apart from a decision. */
export function episodeVerdictOf(verdict: Layer2Verdict): Exclude<Layer2EpisodeVerdict, 'existing'> {
  if (verdict.kind === 'none') return 'none';
  const decision = verdict.choices.some((choice) => !('key' in choice.send) || choice.send.key !== 'escape');
  return decision ? 'choices' : 'esc-only';
}

/** First 12 hex characters of the SHA-256 of the block title: an episode key for the audit, without the text. */
export function blockTitleSha(title: string): string {
  return createHash('sha256').update(title, 'utf8').digest('hex').slice(0, 12);
}
