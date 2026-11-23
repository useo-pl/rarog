/**
 * Step screen of a `rarog` command: a line per step with a mark, a title, the result and the time. On a terminal
 * (`tty`) the running step is a live line with a spinner, `n/N`, a ten-cell bar and the time that passes, redrawn
 * in place (`\r`, `ESC[2K`) and never wider than the terminal; colour only when the terminal allows it. Without a
 * terminal and with `--verbose` (`plain`) a finished step is one line `[n/N] ok <title>: <result> (<time>)`, with no
 * escape byte and no `\r`. A step that ended `ok` without a change has no line of its own: the screen
 * counts it and, only in a run in which no step changed anything, writes one line for all of them before the closing
 * `Check`; `--verbose` and the run log keep every step. A step that asked a question has no time on its line.
 * On a terminal without `--verbose` an answered question leaves the screen when its row count is certain.
 * Detail lines go to the run log, and to the screen only with `--verbose`.
 */
import { beforeInterruptExit } from '../child-output.ts';
import { EXIT_INTERRUPTED, type CliTerminal } from '../io.ts';
import { showsDiff } from './ask.ts';
import type { RunLog } from './log.ts';
import {
  clean, dimPaths, formatDuration, layoutOf, paint, shortPath, truncate, visibleWidth, wrapWords, type Layout,
  type Tone,
} from './style.ts';

export type StepStatus = 'ok' | 'fail' | 'warn' | 'skip' | 'wait';

/** Mark and colour of a finished step on a terminal. */
const MARKS: Readonly<Record<StepStatus, readonly [string, Tone]>> = {
  ok: ['✓', 'green'],
  fail: ['✗', 'red'],
  warn: ['!', 'yellow'],
  skip: ['–', 'gray'],
  wait: ['…', 'cyan'],
};

/** Status word of a finished step without a terminal. */
const PLAIN_STATUS: Readonly<Record<StepStatus, string>> = {
  ok: 'ok',
  fail: 'FAIL',
  warn: 'warn',
  skip: 'skip',
  wait: 'wait',
};

export const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
export const SPINNER_MS = 120;
const BAR_CELLS = 10;
const TITLE_WIDTH = 14;
/** Width of the plain status column (`missing` and `ok` line up). */
const PLAIN_STATUS_WIDTH = 7;
/** Narrowest result column, also on a very narrow terminal. */
const MIN_RESULT_WIDTH = 8;

export const INTERRUPTED_RESULT = 'interrupted';
export const INTERRUPTED_LINE = 'Interrupted. Nothing after this step was changed.';
/** Ctrl-C before the first step (the plan question): no step ran. */
export const INTERRUPTED_BEFORE_STEPS = 'Interrupted. Nothing was changed.';

/** Title of the closing step: it always has its own line, and the line of the steps without a change goes before it. */
export const CHECK_TITLE = 'Check';

/** `   Fix: ` before the first line of a fix; its wrapped lines are indented as deep. */
const FIX_LABEL = '   Fix: ';
/** Indent of the lines after the first line break of a fix (each a command or a line of its own). */
const FIX_OWN_LINE = '     ';
/** A `Fix:` that starts like a command (a program name or a quoted or absolute path), not like a sentence. */
const FIX_COMMAND = /^(?:(?:rarog|node|npm|pnpm|npx|herdr|systemctl|launchctl|tailscale|git|jq|nvm|curl)\s|['"/~])/u;

/** The one line of the steps that ended `ok` without a change (`count` > 0). */
export function unchangedSummary(count: number): string {
  return `${String(count)} ${count === 1 ? 'check' : 'checks'} ok, nothing changed`;
}

export interface StepScreenOptions {
  /** Raw write to stdout. */
  readonly write: (text: string) => void;
  /** What stdout is (`CliIo.terminal`). */
  readonly terminal: CliTerminal;
  /** Home directory: paths on the screen start with `~`. */
  readonly home: string;
  /** Number of steps in this run (`N` in `n/N`). */
  readonly total: number;
  /** `--verbose`: detail lines on the screen, no live line, no colour. */
  readonly verbose?: boolean;
  /** Run log: step results and detail lines go there too. */
  readonly log?: Pick<RunLog, 'line' | 'path'>;
  /**
   * Opens the run log before a `✗` line that has no log to point at yet (a run without a "yes"), so every `✗` gets its
   * `Log:`; the caller decides whether a file may be written at all.
   */
  readonly openLog?: () => void;
  /** Clock in milliseconds (tests pass their own). */
  readonly now?: () => number;
  /** Live columns of the terminal (`CliIo.columnsNow`); without it an answered question stays on the screen. */
  readonly columnsNow?: () => number;
}

/** A question waiting for its answer, as the screen needs it to take the question away. */
interface Asked {
  /** The prompt as written (without colour); `null` = not given, so its rows are unknown. */
  readonly prompt: string | null;
  /** A key prompt: no echo, so the answer adds no width. */
  readonly hidden: boolean;
  /** Live columns when the question was asked; `0` = unknown. */
  readonly columns: number;
  /** Note lines right above the prompt that go with it. */
  readonly note: QuestionNote | null;
  /** The question repeats one answered `d`: it stays, as the one before it and the diff between them. */
  readonly afterDiff: boolean;
}

/** Lines written right before a question that belong to it ({@link StepScreen.questionNote}). */
interface QuestionNote {
  readonly rows: number;
  /** Live columns when the lines were written. */
  readonly columns: number;
  /** Every line narrower than those columns: one row each. */
  readonly fits: boolean;
}

/** Cursor up by `rows`, to the start of the line, and the screen cleared from there down. */
const takeRows = (rows: number): string => `\x1b[${String(rows)}A\r\x1b[J`;

export interface StepEnd {
  /** Duration to show; by default the time since `start`. */
  readonly ms?: number;
  /**
   * Command that fixes the problem (`Fix: …`). The first line is a sentence, wrapped at the screen width under `Fix:`;
   * a line break starts a line of its own (a command to copy whole), indented under `Fix:` and never wrapped; an
   * empty first line leaves `Fix:` alone on its line.
   */
  readonly fix?: string;
  /** Log path to point at (`Log: …`); by default the run log, when it is open. */
  readonly log?: string;
  /**
   * The step wrote, downloaded, installed or restarted something (`Step.changed`), whatever its mark: a `!` or `✗` after
   * a partial write counts too. An `ok` step without it has no line of its own on the screen; one change in the
   * run drops the line of the steps without a change. The run log keeps every step.
   */
  readonly changed?: boolean;
}

interface Running {
  readonly index: number;
  readonly title: string;
  readonly startedAt: number;
  readonly animate: boolean;
  /** A question or a key prompt was asked during the step: its line shows no time. */
  asked: boolean;
  text: string;
  frame: number;
  timer: ReturnType<typeof setInterval> | null;
}

export class StepScreen {
  readonly mode: 'tty' | 'plain';
  readonly color: boolean;
  readonly layout: Layout;
  readonly #write: (text: string) => void;
  readonly #home: string;
  readonly #total: number;
  readonly #verbose: boolean;
  readonly #log: Pick<RunLog, 'line' | 'path'> | undefined;
  readonly #openLog: (() => void) | undefined;
  readonly #now: () => number;
  readonly #columnsNow: (() => number) | undefined;
  #index = 0;
  #running: Running | null = null;
  /** Steps that ended `ok` without a change and without a line of their own, since the last summary line. */
  #unchanged = 0;
  /** A step of this run changed something: no summary line then. */
  #changed = false;
  /** `!` lines of this run: the closing line counts them. */
  #warnings = 0;
  /** A question waits for its answer: the cursor stands after its prompt, not at the start of a line. */
  #asking = false;
  /** The question that waits for its answer. */
  #question: Asked | null = null;
  /** Note lines written right before the next question ({@link questionNote}); any other line drops them. */
  #note: QuestionNote | null = null;
  /** The last answer was `d` to a `[y/N/d]` prompt: the same question comes again and stays. */
  #afterDiff = false;
  /** A step began that the screen does not draw (`--verbose` keeps its own header): see {@link stepSeen}. */
  #stepSeen = false;
  /** A `✗` or `!` line stands on the screen: see {@link flagged}. */
  #flagged = false;

  constructor(options: StepScreenOptions) {
    this.#verbose = options.verbose === true;
    this.mode = options.terminal.tty && !this.#verbose ? 'tty' : 'plain';
    this.color = this.mode === 'tty' && options.terminal.color;
    this.layout = layoutOf(options.terminal.columns);
    this.#write = options.write;
    this.#home = options.home;
    this.#total = Math.max(1, options.total);
    this.#log = options.log;
    this.#openLog = options.openLog;
    this.#now = options.now ?? Date.now;
    this.#columnsNow = options.columnsNow;
  }

  /**
   * Answered questions leave this screen: a terminal without `--verbose` (colour does not matter) with
   * live columns. A question whose rows are uncertain stays even then ({@link answered}).
   */
  get collapses(): boolean {
    return this.mode === 'tty' && this.#columnsNow !== undefined;
  }
  /**
   * A step ended with `✗` or `!` (an interrupt included): the closing line then names no next command, because the
   * run asks for a fix first.
   */
  get flagged(): boolean {
    return this.#flagged;
  }

  /** Steps of this run that ended with `!`: the closing line names their number. */
  get warnings(): number {
    return this.#warnings;
  }

  /**
   * Starts the next step. On a terminal it draws the live line; with `animate` (default) the spinner and the time
   * move every {@link SPINNER_MS} ms, without it (a synchronous step that blocks the event loop) the line stays still.
   */
  start(title: string, options: { readonly animate?: boolean } = {}): void {
    if (clean(title) === CHECK_TITLE) this.summary();
    this.#begin(title, options.animate !== false, true);
  }

  /**
   * A step began without a line on this screen (`--verbose` prints its header as a detail line): an interrupt after
   * it no longer says that nothing was changed.
   */
  stepSeen(): void {
    this.#stepSeen = true;
  }

  /**
   * Writes the one line of the steps that ended `ok` without a change, when there are any and no step of the run
   * changed anything, and starts counting again: ` ✓ <n> checks ok, nothing changed`. `start` of the closing
   * `Check` and `interrupt` call it; a command that ends before its Check may call it itself.
   */
  summary(): void {
    const count = this.#unchanged;
    this.#unchanged = 0;
    if (count === 0 || this.#changed) return;
    const text = unchangedSummary(count);
    const line = this.mode === 'tty'
      ? ` ${paint(MARKS.ok[0], MARKS.ok[1], this.color)} ${text}`
      : `[${PLAIN_STATUS.ok}] ${text}`;
    this.#above(`${line}\n`);
  }

  #begin(title: string, animate: boolean, draw: boolean): void {
    if (this.#running !== null) this.#stopTimer(this.#running);
    this.#index += 1;
    const running: Running = {
      index: this.#index, title: clean(title), startedAt: this.#now(), animate, asked: false, text: '', frame: 0,
      timer: null,
    };
    this.#running = running;
    if (this.mode !== 'tty' || !draw) return;
    this.#drawLive();
    this.#startTimer(running);
  }

  #startTimer(running: Running): void {
    if (!running.animate || running.timer !== null) return;
    running.timer = setInterval(() => {
      running.frame = (running.frame + 1) % SPINNER_FRAMES.length;
      this.#drawLive();
    }, SPINNER_MS);
    running.timer.unref();
  }

  /**
   * Clears the live line and stops its spinner, so a question can take the line; the step keeps running. Nothing
   * without a terminal.
   */
  pause(): void {
    const running = this.#running;
    if (running === null || this.mode !== 'tty') return;
    this.#stopTimer(running);
    this.#write('\r\x1b[2K');
  }

  /** Draws the live line again after {@link pause} and restarts its spinner. */
  resume(): void {
    const running = this.#running;
    if (running === null || this.mode !== 'tty') return;
    this.#drawLive();
    this.#startTimer(running);
  }

  /** Short status text of the running step (`downloading…`); terminal only. */
  progress(text: string): void {
    if (this.#running === null) return;
    this.#running.text = clean(text);
    if (this.mode === 'tty') this.#drawLive();
  }

  /** The running step succeeded; without `changed` it has no line of its own. */
  done(result: string, end: Pick<StepEnd, 'ms' | 'changed'> = {}): void {
    this.#finish('ok', result, end);
  }

  /** The running step finished with a warning; `fix` says what to do. */
  warn(result: string, end: StepEnd = {}): void {
    this.#finish('warn', result, end);
  }

  /** The running step failed: one sentence, then `Fix:` and `Log:` lines. */
  fail(result: string, end: StepEnd = {}): void {
    this.#finish('fail', result, end);
  }

  /** The running step was skipped. */
  skip(result: string, end: Pick<StepEnd, 'changed'> = {}): void {
    this.#finish('skip', result, end);
  }

  /** The running step waits for something outside this run. */
  wait(result: string, end: StepEnd = {}): void {
    this.#finish('wait', result, end);
  }

  /** A step that needs no live line: started and finished at once. */
  step(status: StepStatus, title: string, result: string, end: StepEnd = {}): void {
    this.#begin(title, false, false);
    this.#finish(status, result, { ms: 0, ...end });
  }

  /**
   * A free line (a block, `Done in …`), written between step lines. With `labels` the labels `Fix:` and `Next:` in it
   * are bold on a terminal with colour (the closing lines); a block to paste goes without it, unchanged.
   */
  line(text: string, options: { readonly labels?: boolean } = {}): void {
    const shown = clean(text);
    this.#above(`${options.labels === true ? this.#labels(shown) : shown}\n`);
  }

  /** The header line (`Rarog setup 0.1.0`): `Rarog <command>` bold and the rest dimmed on a terminal with colour. */
  heading(text: string): void {
    const shown = clean(text);
    const match = /^(Rarog \S+)(.*)$/u.exec(shown);
    if (!this.color || match === null) {
      this.#above(`${shown}\n`);
      return;
    }
    this.#above(`${paint(match[1] ?? '', 'bold', true)}${paint(match[2] ?? '', 'gray', true)}\n`);
  }

  /** `?` of a question prompt in cyan on a terminal with colour; the prompt is otherwise unchanged. */
  questionPrompt(prompt: string): string {
    return this.color && prompt.startsWith('? ') ? `${paint('?', 'cyan', true)}${prompt.slice(1)}` : prompt;
  }

  /**
   * A question takes the line: the live line steps aside ({@link pause}) and the cursor stands after the prompt until
   * {@link answered}, so an interrupt starts a new line first. A `hidden` prompt (a key) ends its own line, so neither
   * EOF nor an interrupt adds one. Either way the running step shows no time on its line: the time went to the
   * user's answer, not to the step. `prompt` is the prompt as it is written (its rows); without it the question
   * stays on the screen.
   */
  asking(options: { readonly hidden?: boolean; readonly prompt?: string } = {}): void {
    this.pause();
    if (this.#running !== null) this.#running.asked = true;
    this.#asking = options.hidden !== true;
    const note = this.#note;
    this.#note = null;
    this.#question = {
      prompt: options.prompt ?? null, hidden: options.hidden === true, columns: this.#columns(), note,
      afterDiff: this.#afterDiff,
    };
  }

  /**
   * The question got its answer. EOF (`null`) left the cursor after the prompt (the terminal echoes no line end), so
   * the next line starts on a new one. An answer the terminal ended with its line end takes the question, its echo
   * and its note off the screen when their rows are certain ({@link #rowsOf}). Then the live line comes back
   * ({@link resume}).
   */
  answered(answer: string | null): void {
    if (this.#asking && answer === null) this.#write('\n');
    this.#asking = false;
    const question = this.#question;
    this.#question = null;
    if (question !== null) {
      const rows = this.#rowsOf(question, answer);
      this.#afterDiff = question.prompt !== null && showsDiff(question.prompt, answer);
      if (rows !== null) this.#write(takeRows(rows));
    }
    this.resume();
  }

  /**
   * Lines of a sentence that belongs to the next question, written right above its prompt (what the question is for,
   * `Every paired phone uses this key…`): cyan on a terminal with colour, so they read apart from the step lines, and
   * they leave the screen with that question. Notes written one after another add up; a line written between
   * them and the question keeps them.
   */
  questionNote(lines: readonly string[]): void {
    const before = this.#note;
    const shown = lines.map((line) => clean(line));
    for (const line of shown) this.#above(`${paint(line, 'cyan', this.color)}\n`);
    const columns = this.#columns();
    const fits = shown.every((line) => visibleWidth(line) < columns);
    this.#note = before === null || before.columns !== columns
      ? { rows: shown.length, columns, fits }
      : { rows: before.rows + shown.length, columns, fits: before.fits && fits };
  }

  /**
   * Rows an answered question takes on the screen, or `null` when they are not certain and the question stays:
   * a terminal without `--verbose`, an answer (not EOF), not `d` at `[y/N/d]` nor the question asked again
   * after it, the live columns known and the same at the question and now, every prompt and note line narrower than
   * them, and, with an echo, the last prompt line with the answer narrower too (a line that reaches the width leaves
   * the terminal's cursor in doubt). Then each prompt and note line is one row.
   */
  #rowsOf(question: Asked, answer: string | null): number | null {
    if (!this.collapses || question.prompt === null || answer === null) return null;
    if (question.afterDiff || showsDiff(question.prompt, answer)) return null;
    const columns = question.columns;
    if (columns === 0 || this.#columns() !== columns) return null;
    const lines = question.prompt.split('\n').map((line) => clean(line));
    if (lines.some((line) => visibleWidth(line) >= columns)) return null;
    let rows = lines.length;
    const note = question.note;
    if (note !== null) {
      if (!note.fits || note.columns !== columns) return null;
      rows += note.rows;
    }
    if (!question.hidden) {
      // A control character in the echo has no known width.
      if (/[\x00-\x1f\x7f-\x9f]/u.test(answer)) return null;
      if (visibleWidth(`${lines.at(-1) ?? ''}${answer}`) >= columns) return null;
    }
    return rows;
  }

  /** Live columns now; `0` = unknown. */
  #columns(): number {
    const columns = this.#columnsNow?.() ?? 0;
    return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 0;
  }

  /**
   * A detail line: always to the log, to the screen only with `--verbose`. Text from a child loses escape sequences
   * and `\r` on the screen too (plain mode has none); its line breaks stay.
   */
  detail(text: string): void {
    this.#log?.line(text);
    this.verboseLine(text);
  }

  /** A detail line that never reaches the log (it quotes a file of the user): the screen with `--verbose` only. */
  verboseLine(text: string): void {
    if (this.#verbose) this.#write(text.split(/\r?\n/u).map((part) => `${clean(part)}\n`).join(''));
  }

  /**
   * Ctrl-C: a question left open gets its line end, the steps without a change get their one line, the spinner stops
   * and the running step ends with `✗ <title> interrupted`; then one line says that nothing after this step changed
   * (before the first step: that nothing changed), and the log path stands on a line of its own. Returns 130.
   */
  interrupt(): number {
    if (this.#asking) this.#write('\n');
    this.#asking = false;
    const before = this.#index === 0 && !this.#stepSeen;
    if (this.#running !== null) this.#stopTimer(this.#running);
    this.summary();
    if (this.#running !== null) this.#finish('fail', INTERRUPTED_RESULT, { ms: 0, log: '' });
    const sentence = before ? INTERRUPTED_BEFORE_STEPS : INTERRUPTED_LINE;
    const log = this.#log?.path ?? null;
    this.#write(`${sentence}\n${log === null ? '' : `${this.#logLine(log)}\n`}`);
    this.#log?.line(sentence);
    return EXIT_INTERRUPTED;
  }

  #finish(status: StepStatus, result: string, end: StepEnd): void {
    const running = this.#running;
    if (running === null) throw new Error('no running step to finish');
    this.#note = null;
    this.#stopTimer(running);
    this.#running = null;
    const text = clean(result);
    const time = formatDuration(end.ms ?? this.#now() - running.startedAt);
    const plain = this.#plainLine(status, running, text, time);
    this.#log?.line(plain);
    if (status === 'fail' || status === 'warn') this.#flagged = true;
    if (status === 'warn') this.#warnings += 1;
    if (end.changed === true) this.#changed = true;
    const fix = end.fix ?? '';
    // A `✗` points at the run log, so a run that has not opened it yet opens it now.
    if (status === 'fail' && end.log === undefined && this.#log?.path === null) this.#openLog?.();
    const log = end.log ?? (status === 'fail' ? this.#log?.path ?? '' : '');
    if (status === 'ok' && end.changed !== true && fix === '' && log === '' && !this.#verbose
      && running.title !== CHECK_TITLE) {
      // Counted for the one line before Check; the live line goes away.
      this.#unchanged += 1;
      if (this.mode === 'tty') this.#write('\r\x1b[2K');
      return;
    }
    const help = fix === '' ? [] : this.#fixLines(fix);
    if (log !== '') help.push(this.#logLine(log));
    // The screen line of a step that asked shows no time; the run log keeps it.
    const shownTime = running.asked ? '' : time;
    const body = this.mode === 'tty' ? this.#ttyLines(status, running.title, text, shownTime)
      : [running.asked ? this.#plainLine(status, running, text, '') : plain];
    const out = [...body, ...help].map((line) => `${line}\n`).join('');
    this.#write(this.mode === 'tty' ? `\r\x1b[2K${out}` : out);
  }

  /**
   * `Fix:` lines: the first line of `fix` is a sentence wrapped under `Fix:` (its next lines indented as deep), every
   * further line stands alone, indented and never wrapped (a command to copy whole). The label is bold with colour.
   */
  #fixLines(fix: string): string[] {
    const [first = '', ...rest] = fix.split('\n').map((part) => clean(part));
    const label = `${FIX_LABEL.slice(0, 3)}${paint('Fix:', 'bold', this.color)}`;
    const room = Math.max(MIN_RESULT_WIDTH, this.layout.width - FIX_LABEL.length);
    let lines: string[];
    if (first === '') lines = [label];
    // Text that fits stays byte for byte (spaces inside a quoted argument included).
    else if (visibleWidth(first) <= room) lines = [`${label} ${first}`];
    // A command too wide is never wrapped: a wrapped command copies without its last arguments.
    else if (FIX_COMMAND.test(first)) lines = [label, `${FIX_OWN_LINE}${first}`];
    else {
      lines = wrapWords(first, room, room)
        .map((part, index) => `${index === 0 ? `${label} ` : ' '.repeat(FIX_LABEL.length)}${part}`);
    }
    return [...lines, ...rest.map((part) => `${FIX_OWN_LINE}${part}`)];
  }

  /** `   Log: <path>`, the path shortened to the screen; dimmed with colour. */
  #logLine(log: string): string {
    const room = Math.max(MIN_RESULT_WIDTH, this.layout.width - FIX_LABEL.length);
    return paint(`   Log: ${shortPath(log, this.#home, room)}`, 'gray', this.color);
  }

  /** `Fix:` and `Next…:` bold in a closing line on a terminal with colour. */
  #labels(text: string): string {
    if (!this.color) return text;
    return text.replace(/(^|\s)(Fix:|Next(?: \([^)]*\))?:)/gu, (_, space: string, label: string) =>
      `${space}${paint(label, 'bold', true)}`);
  }

  /** `[n/N] ok      <title>: <result> (<time>)`. */
  #plainLine(status: StepStatus, running: Running, text: string, time: string): string {
    const result = text === '' ? '' : `: ${text}`;
    return `[${String(running.index)}/${String(this.#total)}] ${PLAIN_STATUS[status].padEnd(PLAIN_STATUS_WIDTH)} `
      + `${running.title}${result}${time === '' ? '' : ` (${time})`}`;
  }

  /** Finished step on a terminal: wrapped under the result column, the time right-aligned on the first line. */
  #ttyLines(status: StepStatus, title: string, text: string, time: string): string[] {
    const [mark, tone] = MARKS[status];
    const head = ` ${mark} ${title.padEnd(TITLE_WIDTH)} `;
    const indent = visibleWidth(head);
    const width = this.layout.width;
    const room = Math.max(MIN_RESULT_WIDTH, width - indent);
    const firstRoom = Math.max(MIN_RESULT_WIDTH, room - (time === '' ? 0 : visibleWidth(time) + 1));
    const parts = wrapWords(text, firstRoom, room);
    return parts.map((part, index) => {
      if (index > 0) return `${' '.repeat(indent)}${dimPaths(part, this.color)}`;
      let line = ` ${paint(mark, tone, this.color)} ${title.padEnd(TITLE_WIDTH)} ${dimPaths(part, this.color)}`;
      if (time !== '') {
        const used = indent + visibleWidth(part);
        line += `${' '.repeat(Math.max(1, width - used - visibleWidth(time)))}${paint(time, 'gray', this.color)}`;
      }
      return line.trimEnd();
    });
  }

  /** Redraws the live line: spinner, title, status text, `n/N`, the bar and the time, cut to the terminal. */
  #drawLive(): void {
    const running = this.#running;
    if (running === null) return;
    const frame = SPINNER_FRAMES[running.frame] ?? '⠋';
    const filled = Math.min(BAR_CELLS, Math.round((BAR_CELLS * running.index) / this.#total));
    const bar = `${'━'.repeat(filled)}${'─'.repeat(BAR_CELLS - filled)}`;
    const time = formatDuration(this.#now() - running.startedAt);
    const left = ` ${frame} ${running.title.padEnd(TITLE_WIDTH)} ${running.text === '' ? '' : `${running.text}  `}`;
    const middle = `${String(running.index)}/${String(this.#total)} ${bar}`;
    const max = this.layout.liveMax;
    let line = `${left}${middle}`;
    if (time !== '') {
      const gap = max - visibleWidth(line) - visibleWidth(time);
      line = gap >= 2 ? `${line}${' '.repeat(gap)}${time}` : `${line}  ${time}`;
    }
    line = truncate(line, max);
    // The mark is the second character of every live line; colour it after cutting, so cutting counts columns.
    const chars = [...line];
    const painted = chars.length < 2
      ? line
      : `${chars[0] ?? ''}${paint(chars[1] ?? '', 'cyan', this.color)}${chars.slice(2).join('')}`;
    this.#write(`\r\x1b[2K${painted}`);
  }

  /** Writes finished text above the live line and draws the live line again. */
  #above(text: string): void {
    this.#note = null;
    if (this.mode === 'tty' && this.#running !== null) {
      this.#write(`\r\x1b[2K${text}`);
      this.#drawLive();
      return;
    }
    this.#write(text);
  }

  #stopTimer(running: Running): void {
    if (running.timer !== null) clearInterval(running.timer);
    running.timer = null;
  }
}

/**
 * Ctrl-C while the command has no child process running: the screen ends the running step as interrupted, then
 * `interruptOrExit` (`child-output.ts`, the one Ctrl-C decision, called by `bin/rarog.mjs` on the process signal and
 * on the question prompt) exits with 130. With a child running, the command finishes its step itself. Returns the
 * function that stops watching (call it when the command ends).
 */
export function watchInterrupt(screen: StepScreen): () => void {
  return beforeInterruptExit(() => { screen.interrupt(); });
}
