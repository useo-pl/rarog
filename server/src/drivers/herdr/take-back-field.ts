/**
 * The prompt field after a queue take-back (`queue-take-back.ts`), until it is empty again: the record that holds
 * pastes and idle sends while the field may show taken text, `ctrl+u` while it shows only text the file proves taken,
 * `down` out of a history entry `up` opened. Every key goes after fresh gates and a fresh screen read, through the
 * take-back's one send path in the port; this module decides nothing about the queues.
 */
import { askFormOnScreen, cliDialogOnScreen } from '../../herdr/dialogs/presence.ts';
import { SCREEN_SIGNATURES } from '../../herdr/dialogs/screen/signatures.ts';
import { stripTerminalControl } from '../../herdr/dialogs/screen/text.ts';
import { TAKE_BACK_CLEAR_KEY, TAKE_BACK_DOWN_KEY } from '../../herdr/dialogs/send/take-back-keys.ts';
import type { Scheduler, TimerHandle } from '../runtime.ts';
import { squashWhitespace } from './commands.ts';
import type { ComposerFieldView } from './commands.ts';
import type { PromptGates } from './prompt-gates.ts';
import { PROMPT_FIELD_POLL_MS, PROMPT_RETRY_MS } from './prompt-paste.ts';

/** `down` presses that may bring the field back from a history entry `up` opened on an empty CLI queue. */
const DOWN_ATTEMPTS = 2;

/** `ctrl+u` presses in a row after which a field that did not shrink stops the cleanup. */
const STALLED_PRESSES = 3;

/**
 * The placeholder the CLI draws in the field for a collapsed paste, `[Pasted text #1 +11 lines]` for 12 lines (CLI
 * 2.1.328, `zabranie-wklejka-*`); global, for every placeholder of a field read without whitespace.
 */
const PLACEHOLDER = new RegExp(SCREEN_SIGNATURES.composerPastePlaceholder.pattern.source, 'g');

/**
 * The marks around one placeholder in the canonical form: only the number after `+` (the paste's line count less one)
 * stands between `OPEN` and `CLOSE`, the number after `#` is dropped. A field or a text that holds a mark itself gets no
 * canonical form.
 */
const OPEN = '\u{E000}';
const CLOSE = '\u{E001}';

/**
 * The prompt field after a take-back, until it is empty again. The record holds every paste from Rarog's queue and
 * every idle send (`holdsField`), so a new message never joins the taken text:
 * - `clear`: the field shows taken text, `ctrl+u` deletes one screen line from the end while the field is a prefix of
 *   `expected` or `collapsed` (no whitespace), or, cut at the top, a part of it ({@link showsTaken});
 * - `history`: `up` opened a history entry on an empty CLI queue, `down` brings the empty field back (CLI 2.1.328,
 *   `zabranie-historia-*`);
 * - `hold`: the field may hold taken text; no key, the record ends when the field is empty, or when the whole field,
 *   not cut at the top, fits neither `expected` ({@link showsTaken}, with the same `history` mark) nor the start of
 *   `own`, which proves the field changed at the desk. A field cut at the top never ends it: the lines above may still
 *   hold taken text. `expected: null`: the field could not be read, the first whole field read becomes `expected`.
 *   `own`: the `clear` of the whole CLI queue the file proves taken, while the field did not show it yet; once the
 *   whole field, not cut at the top, is exactly its text, the record turns into that `clear`. A `clear` or `history`
 *   record whose keys stop (key ceiling, a field that does not shrink, a failed key, a step that threw) goes on as a
 *   `hold` without `own`, so the field is never let go while it may show taken text, and the keys stay stopped.
 */
export type FieldRecord =
  | ClearRecord
  | { readonly kind: 'history'; downs: number }
  | { readonly kind: 'hold'; readonly expected: string | null; readonly collapsed: string | null;
      readonly prefix: boolean; readonly history: boolean; readonly own: ClearRecord | null };

/**
 * The taken texts as the field may show them, no whitespace: `expected` with every text in full, `collapsed` with every
 * paste as its placeholder in the canonical form ({@link collapsedText}), `null` when no text is a paste.
 */
export interface FieldText {
  readonly expected: string;
  readonly collapsed: string | null;
}

export interface ClearRecord extends FieldText {
  readonly kind: 'clear';
  readonly ceiling: number;
  presses: number;
  stalled: number;
  last: string | null;
}

/** One text the file proves taken, in pop order: `pasteLines` is the line count of a paste, `null` for plain text. */
export interface TakenText {
  readonly text: string;
  readonly pasteLines: number | null;
}

/** One screen read for one decision: the text with attributes and the prompt field in it. */
export interface Screen {
  readonly text: string;
  readonly view: ComposerFieldView | null;
}

export type StepOutcome = 'done' | 'wait' | 'dead';

/** A key of the field cleanup: `ctrl+u` of a `clear` record, `down` of a `history` record. */
export type FieldKey = typeof TAKE_BACK_CLEAR_KEY | typeof TAKE_BACK_DOWN_KEY;

/** Fixed configuration, taken from the take-back once, at construction. */
export interface TakeBackFieldConfig {
  /** The driver's deps, read at each use as by the take-back. */
  readonly deps: { readonly promptRetryMs?: number; readonly promptFieldPollMs?: number };
  readonly scheduler: Scheduler;
  readonly key: string;
  /** The take-back's own gates, asked before every key. */
  readonly gates: Pick<PromptGates, 'promptObstacle' | 'knownObstacle'>;
}

/** What the field needs from the take-back: driver state and chain, the screen read, the send path, the log. */
export interface TakeBackFieldPort {
  disposed(): boolean;
  enqueue(step: () => Promise<void>): Promise<unknown>;
  read(): Promise<Screen | undefined>;
  press(key: FieldKey): Promise<boolean>;
  log(line: string): void;
}

export class TakeBackField {
  readonly #deps: TakeBackFieldConfig['deps'];
  readonly #scheduler: Scheduler;
  readonly #key: string;
  readonly #gates: TakeBackFieldConfig['gates'];
  readonly #port: TakeBackFieldPort;
  #record: FieldRecord | null = null;
  #timer: TimerHandle | null = null;
  /** The last background step threw: the next throw in a row is not logged again. */
  #threw = false;

  constructor(config: TakeBackFieldConfig, port: TakeBackFieldPort) {
    this.#deps = config.deps;
    this.#scheduler = config.scheduler;
    this.#key = config.key;
    this.#gates = config.gates;
    this.#port = port;
  }

  /** The prompt field still holds taken text, or may: pastes and idle sends wait, slash commands do not go. */
  holdsField(): boolean {
    return this.#record !== null;
  }

  /** `dispose()` of the driver: the cleanup stops without a key. */
  release(): void {
    if (this.#timer !== null) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = null;
    this.#record = null;
  }

  /** The record takes the field and does its first step now; {@link settleRecord} settles the outcome. */
  start(record: FieldRecord): Promise<StepOutcome> {
    this.#record = record;
    return this.#fieldStep();
  }

  hold(expected: string | null, history: boolean, own: ClearRecord | null): 'pending' {
    this.#record = { kind: 'hold', expected, collapsed: null, prefix: false, history, own };
    this.schedule();
    return 'pending';
  }

  /**
   * The record's work until the field is empty, an obstacle stands or the record holds without keys (`wait`), or the
   * field is not the record's any more or `release()` took the record (`dead`, no key). Before each key: fresh gates,
   * a fresh screen read, the field check and the synchronous gate.
   */
  async #fieldStep(): Promise<StepOutcome> {
    for (;;) {
      const record = this.#record;
      if (record === null || this.#port.disposed()) return 'dead';
      if (record.kind !== 'hold') {
        const obstacle = await this.#gates.promptObstacle();
        if (this.#released(record)) return 'dead';
        if (obstacle !== null) return 'wait';
      }
      const screen = await this.#port.read();
      if (this.#released(record)) return 'dead';
      if (screen === undefined || screenHolds(screen) || screen.view === null) return 'wait';
      const next = this.#nextKey(record, screen.view);
      if (next !== TAKE_BACK_CLEAR_KEY && next !== TAKE_BACK_DOWN_KEY) return next;
      if (this.#gates.knownObstacle() !== null) return 'wait';
      const sent = await this.#port.press(next);
      if (this.#released(record)) return 'dead';
      if (!sent && record.kind !== 'hold') return this.#stopKeys(record, screen.view, `${next} failed`);
      await this.#sleep(this.#pollMs);
    }
  }

  /** `release()` cleared the record or put another in its place during an `await`, or the driver is gone. */
  #released(record: FieldRecord): boolean {
    return this.#record !== record || this.#port.disposed();
  }

  /** What the record does with the field it sees: a key, or an outcome without one. */
  #nextKey(record: FieldRecord, view: ComposerFieldView): StepOutcome | FieldKey {
    const field = squashWhitespace(view.text);
    const empty = field === '' && !view.cutAtTop && !view.history;
    if (empty) return 'done';
    if (record.kind === 'hold') {
      // Only the whole field proves anything: under a cut top, whatever its bottom shows, the lines above may still
      // hold taken text, so a cut field neither ends the hold, nor turns it into a `clear`, nor becomes `expected`.
      if (view.cutAtTop) return 'wait';
      const { own } = record;
      if (own !== null && !view.history && showsTaken(own, field, false, false)) {
        this.#port.log(`take-back: the held field in pane ${this.#key} shows the taken texts; it is cleared`);
        this.#record = { ...own };
        return 'wait';
      }
      const { expected } = record;
      if (expected === null) {
        this.#record = { ...record, expected: field, history: view.history };
        return 'wait';
      }
      const same = view.history === record.history
        && showsTaken({ expected, collapsed: record.collapsed }, field, false, record.prefix);
      // The start of `own` is taken text too: the field half drawn, or its end taken by a key that took effect.
      const ownStart = own !== null && !view.history && showsTaken(own, field, false, true);
      // A field that ends inside an unclosed bracket may be a paste placeholder half drawn: it proves nothing, so the
      // hold waits when the text before the bracket is the start of the taken texts. It never starts clearing.
      const head = own !== null && own.collapsed !== null && !view.history ? openBracketHead(field) : null;
      const halfDrawn = own !== null && head !== null && showsTaken(own, head, false, true);
      return same || ownStart || halfDrawn ? 'wait' : this.#dead('the field changed at the desk');
    }
    if (record.kind === 'history') {
      if (!view.history) {
        this.#record = { kind: 'hold', expected: field, collapsed: null, prefix: false, history: false, own: null };
        return 'wait';
      }
      if (record.downs >= DOWN_ATTEMPTS) return this.#stopKeys(record, view, 'down did not leave the history entry');
      record.downs += 1;
      return TAKE_BACK_DOWN_KEY;
    }
    if (view.history || !showsTaken(record, field, view.cutAtTop, true)) {
      // A placeholder wrapped over the cut top shows only its end: no proof the field is the record's, and no proof
      // it changed either. The field is held as it reads now.
      if (!view.history && view.cutAtTop && record.collapsed !== null) {
        this.#port.log(`take-back: field cleanup in pane ${this.#key} sends no more keys (a cut field with a paste `
          + 'placeholder); the field is held');
        this.#record = { kind: 'hold', expected: field, collapsed: null, prefix: false, history: false, own: null };
        return 'wait';
      }
      return this.#dead('the field changed at the desk');
    }
    record.stalled = field === record.last ? record.stalled + 1 : 0;
    record.last = field;
    if (record.presses >= record.ceiling || record.stalled >= STALLED_PRESSES) {
      return this.#stopKeys(record, view, 'the field did not empty within the key ceiling');
    }
    record.presses += 1;
    return TAKE_BACK_CLEAR_KEY;
  }

  #dead(why: string): 'dead' {
    this.#port.log(`take-back: field cleanup in pane ${this.#key} stops without a key: ${why}`);
    return 'dead';
  }

  /**
   * The keys stop, but taken text may still stand in the field: the record goes on as a `hold`. A `clear` record keeps
   * its text with the prefix rule, so a key that took effect after all still leaves a field the hold knows; a
   * `history` record keeps the entry it saw.
   */
  #stopKeys(record: Exclude<FieldRecord, { kind: 'hold' }>, view: ComposerFieldView, why: string): 'wait' {
    this.#port.log(`take-back: field cleanup in pane ${this.#key} sends no more keys (${why}); the field is held`);
    this.#record = record.kind === 'clear'
      ? heldClear(record)
      : {
        kind: 'hold', expected: squashWhitespace(view.text), collapsed: null, prefix: false, history: view.history,
        own: null,
      };
    return 'wait';
  }

  /** A step's outcome: `wait` goes on in the background; `done` (an empty field) and `dead` end the record. */
  settleRecord(outcome: StepOutcome): 'done' | 'pending' {
    if (outcome === 'wait') {
      this.schedule();
      return 'pending';
    }
    this.#record = null;
    return 'done';
  }

  schedule(): void {
    if (this.#timer !== null || this.#port.disposed()) return;
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = null;
      void this.#port.enqueue(async () => {
        if (this.#record === null) return;
        let outcome: StepOutcome;
        try {
          outcome = await this.#fieldStep();
        } catch (err) {
          this.#holdAfterThrow(err);
          return;
        }
        this.#threw = false;
        this.settleRecord(outcome);
      });
    }, this.#deps.promptRetryMs ?? PROMPT_RETRY_MS);
  }

  /**
   * A background step threw. The driver's chain swallows the throw, so without a new timer nothing would read the
   * field again: the record goes on as a `hold` with a timer and sends no more keys. A `clear` keeps its text with the
   * prefix rule; a `history` record takes the next field it reads.
   */
  #holdAfterThrow(err: unknown): void {
    const record = this.#record;
    if (record === null || this.#port.disposed()) return;
    if (!this.#threw) {
      this.#port.log(`take-back: field step in pane ${this.#key} threw (${errorName(err)}); the field is held`);
    }
    this.#threw = true;
    if (record.kind === 'clear') this.#record = heldClear(record);
    if (record.kind === 'history') {
      this.#record = { kind: 'hold', expected: null, collapsed: null, prefix: false, history: false, own: null };
    }
    this.schedule();
  }

  get #pollMs(): number {
    return this.#deps.promptFieldPollMs ?? PROMPT_FIELD_POLL_MS;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#scheduler.setTimeout(() => { resolve(); }, ms);
    });
  }
}

/**
 * A `clear` record with its press ceiling: one `ctrl+u` deletes one screen line (CLI 2.1.328, 29 presses for three
 * long prompts at 26 columns), so the ceiling is twice the screen lines of the texts at the pane width, plus slack.
 */
export function clearRecord(text: FieldText, texts: readonly string[], screen: string): ClearRecord {
  const width = Math.max(0, ...stripTerminalControl(screen).split('\n').map((line) => [...line].length));
  const columns = Math.max(8, width - 4);
  const lines = texts.flatMap((item) => item.split('\n'))
    .reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].length / columns)), 0);
  return {
    kind: 'clear', expected: text.expected, collapsed: text.collapsed, ceiling: 2 * lines + 4, presses: 0, stalled: 0,
    last: null,
  };
}

/**
 * The taken texts in pop order with every paste as its placeholder in the canonical form, no whitespace; `null` when
 * no text is a paste. The CLI shows a paste of K + 1 lines as `[Pasted text #N +K lines]` (CLI 2.1.328,
 * `zabranie-wklejka-*`); whether it collapses a short paste too is unmeasured, so the full text stays a match as well.
 */
export function collapsedText(taken: readonly TakenText[]): string | null {
  if (taken.every(({ pasteLines }) => pasteLines === null) || taken.some(({ text }) => hasMark(text))) return null;
  return taken.map(({ text, pasteLines }) => (
    pasteLines === null ? squashWhitespace(text) : `${OPEN}${String(pasteLines - 1)}${CLOSE}`
  )).join('');
}

/**
 * Whether the field (no whitespace) may show the taken texts: in full or with every paste as its placeholder, each by
 * {@link fits}. A placeholder is all or nothing: a field that ends inside one, or starts inside one under a cut top,
 * matches no canonical form.
 */
export function showsTaken(text: FieldText, field: string, cutAtTop: boolean, prefix: boolean): boolean {
  if (fits(text.expected, field, cutAtTop, prefix)) return true;
  if (text.collapsed === null || hasMark(field)) return false;
  const canonical = field.replace(PLACEHOLDER, (_placeholder, lines: string) => `${OPEN}${lines}${CLOSE}`);
  return fits(text.collapsed, canonical, cutAtTop, prefix);
}

/** The field before its last `[` when no `]` closes it, else `null`. */
function openBracketHead(field: string): string | null {
  const open = field.lastIndexOf('[');
  return open < 0 || field.includes(']', open) ? null : field.slice(0, open);
}

function hasMark(text: string): boolean {
  return text.includes(OPEN) || text.includes(CLOSE);
}

/** A `clear` record whose keys stop: a hold of its texts with the prefix rule, so a key that took effect still fits. */
function heldClear(record: ClearRecord): FieldRecord {
  return {
    kind: 'hold', expected: record.expected, collapsed: record.collapsed, prefix: true, history: false, own: null,
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}

/** A dialog or a form on screen, or a screen without a readable prompt field. */
export function screenHolds(screen: Screen): boolean {
  return screen.view === null || askFormOnScreen(screen.text) === 'form' || cliDialogOnScreen(screen.text) === 'dialog';
}

/**
 * Whether the field (no whitespace) may show `expected`: all of it, with `prefix` also its start (`ctrl+u` deletes from
 * the end), and, cut at the top, any part of it, since only the bottom of the field is on screen.
 */
export function fits(expected: string, field: string, cutAtTop: boolean, prefix: boolean): boolean {
  if (cutAtTop) return expected.includes(field);
  return prefix ? expected.startsWith(field) : field === expected;
}
