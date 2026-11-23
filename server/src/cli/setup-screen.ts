/**
 * What `rarog setup` shows and what it logs. The screen gets one line per step (`screen/steps.ts`); the step's detail
 * lines go to the run log (`<dataDir>/logs/setup-….log`) and to the screen only with `--verbose`, which also keeps
 * the step headers and the `Summary:` block. Blocks to paste stay on the screen and never reach the log, because they
 * can quote the user's settings. The diff of `~/.claude/settings.json` and lines that quote it never reach the log
 * either. The log file appears at the first "yes" or the first `✗` (its `Log:` line), not at a "yes" before the plan
 * screen; a run without either, or without a terminal, writes no file. Steps themselves live in `setup.ts` and the
 * `setup-*.ts` modules.
 */
import { isYes, terminalOf } from './io.ts';
import type { CliIo } from './io.ts';
import { RunLog } from './screen/log.ts';
import { StepScreen, watchInterrupt } from './screen/steps.ts';
import { visibleWidth, wrapWords } from './screen/style.ts';
import type { InstallDataDir } from '../install/data-dir.ts';
import { installationCli, withInstallationCli } from '../install/repair.ts';
import { readPackageVersion } from '../version.ts';
import type { Step } from './setup-context.ts';

/** Command name of the setup run log. */
export const SETUP_LOG_COMMAND = 'setup';

/** What the first hidden key prompt of a run says above it; the prompts after it need it no more. */
export const KEY_PROMPT_NOTE = 'Hidden while you paste; saved only on this computer.';

/** Summary prefixes that repeat the step title; the screen drops them (`tools: all present` → `all present`). */
const TITLE_PREFIXES = [
  'tools', 'secrets', 'tailscale serve', 'hook copy', 'Settings', 'SDK', 'service', 'herdr.service',
];

export interface SetupViewOptions {
  readonly io: CliIo;
  readonly home: string;
  /** `--verbose`: the detail lines, the step headers and the `Summary:` block on the screen, and no step lines. */
  readonly verbose: boolean;
  /** Data directory of the installation: the log lives in its `logs/`. */
  readonly dataDir: InstallDataDir;
  /** Steps with a line on the screen. */
  readonly total: number;
  /**
   * The installation a new terminal may not reach as `rarog` (`newTerminalTarget` in `setup-check.ts`): its `Fix:`
   * lines carry the absolute command; `null` or absent = `rarog`.
   */
  readonly cliTarget?: { readonly node: string; readonly bin: string } | null;
  /** Command name of the run log (`<dataDir>/logs/<command>-….log`); default {@link SETUP_LOG_COMMAND}. */
  readonly command?: string;
}

/** Splits raw writes into lines; a rest without a line end waits for the next write or {@link LineWriter.flush}. */
class LineWriter {
  #rest = '';

  constructor(private readonly emit: (line: string) => void) {}

  write(text: string): void {
    const parts = (this.#rest + text).split('\n');
    this.#rest = parts.pop() ?? '';
    for (const part of parts) this.emit(part);
  }

  flush(): void {
    if (this.#rest !== '') this.emit(this.#rest);
    this.#rest = '';
  }
}

export class SetupView {
  readonly verbose: boolean;
  readonly screen: StepScreen;
  readonly log: RunLog;
  /** Question on the terminal through the screen (the live line steps aside), `null` without a terminal. */
  readonly ask: ((prompt: string) => Promise<string | null>) | null;
  /**
   * {@link ask} for a question before the plan screen: its "yes" opens no run log, because only "Continue?" starts the
   * writes. `null` without a terminal.
   */
  readonly askBeforePlan: ((prompt: string) => Promise<string | null>) | null;
  /**
   * Hidden question (a key) on the terminal through the screen: the log gets the prompt, never the answer. `null`
   * without a terminal, so a run without one never asks for a key.
   */
  readonly askSecret: ((prompt: string) => Promise<string | null>) | null;
  readonly #io: CliIo;
  readonly #dataDir: InstallDataDir;
  readonly #cliTarget: { readonly node: string; readonly bin: string } | null;
  readonly #writers: LineWriter[] = [];
  /** {@link KEY_PROMPT_NOTE} stood above a key prompt of this run. */
  #keyNoteShown = false;

  constructor(options: SetupViewOptions) {
    this.verbose = options.verbose;
    this.#io = options.io;
    this.#dataDir = options.dataDir;
    this.#cliTarget = options.cliTarget ?? null;
    this.log = new RunLog({ command: options.command ?? SETUP_LOG_COMMAND });
    this.screen = new StepScreen({
      write: options.io.stdout, terminal: terminalOf(options.io), home: options.home, total: options.total,
      verbose: options.verbose, log: this.log,
      ...(options.io.columnsNow === undefined ? {} : { columnsNow: options.io.columnsNow }),
      // A `✗` opens the log in a terminal run without a "yes" yet; without a terminal nothing is written.
      openLog: () => { if (this.ask !== null) this.#openLog(); },
    });
    const ask = options.io.ask;
    this.ask = ask === undefined ? null : async (prompt) => this.#ask(ask, prompt, true);
    this.askBeforePlan = ask === undefined ? null : async (prompt) => this.#ask(ask, prompt, false);
    const askSecret = options.io.askSecret;
    this.askSecret = ask === undefined || askSecret === undefined ? null
      : async (prompt) => this.#askSecret(askSecret, prompt);
  }

  /** First line of the run: the version on the screen; with `--verbose` the sentence it printed so far. */
  header(sentence: string): void {
    if (this.verbose) {
      this.detail(sentence);
      return;
    }
    this.log.line(sentence);
    const version = packageVersion();
    if (this.ask === null) {
      this.screen.line(`rarog setup ${version}: no terminal, checks only`);
      return;
    }
    // No blank line under it: the first setup screen fits its budget at 60 columns: 20 lines and 4
    // questions when the dictation question gets "n", 21 lines and 7 when it gets "y" (the key prompts count).
    this.screen.heading(`Rarog setup ${version}`);
  }

  /**
   * A header line of another command (`Rarog update 0.1.0 → 0.2.0`): the log and the screen, bold and dimmed with
   * colour; with `--verbose` a detail line.
   */
  heading(text: string): void {
    if (this.verbose) {
      this.detail(text);
      return;
    }
    this.log.line(text);
    this.screen.heading(text);
  }

  /** A closing line (`Done in N s. Next: …`): on the screen in every mode, `Next:` bold with colour, not in the log. */
  closing(text: string): void {
    this.screen.line(text, { labels: true });
  }

  /** A detail line: to the log, and to the screen with `--verbose`. */
  detail(text: string): void {
    this.screen.detail(text);
  }

  /**
   * A line of a step the user reads in every mode (`dictation: on (Soniox key saved)`): to the log, and to the screen
   * indented by two and wrapped at its width.
   */
  note(text: string): void {
    this.screen.detail(`  ${text}`);
    if (this.verbose) return;
    for (const part of this.#noteLines(text)) this.screen.line(part);
  }

  /**
   * A {@link note} that belongs to the next question, right above its prompt (what the question is for, `Every paired
   * phone uses this key…`): cyan on a terminal with colour; on the screen it leaves together with that question once
   * answered. Call it only right before asking, so a run without a terminal has none.
   */
  questionNote(text: string): void {
    this.screen.detail(`  ${text}`);
    if (this.verbose) return;
    this.screen.questionNote(this.#noteLines(text));
  }

  /**
   * A short line in place of an answer that left the screen (`dictation: off`): on the screen only when answered
   * questions leave it; the log has the full line from the step already.
   */
  answerNote(text: string): void {
    if (this.screen.collapses) this.screen.line(`  ${text}`);
  }

  #noteLines(text: string): string[] {
    const width = this.screen.layout.width - 2;
    return wrapWords(text, width, width).map((part) => `  ${part}`);
  }

  /**
   * A block to paste or a sentence the user acts on: on the screen in every mode, never in the log. A block can quote
   * the user's own settings (the `statusLine` command a block chains behind the Rarog script).
   */
  block(text: string): void {
    this.screen.line(text);
  }

  /**
   * The diff of `~/.claude/settings.json` and lines that quote the file (a conflict's reasons): the screen with
   * `--verbose`, never the log.
   */
  settingsDiff(text: string): void {
    if (this.verbose) this.#io.stdout(`${text}\n`);
  }

  /** A line for the log only (what happened to `~/.claude/settings.json`, without its content). */
  logOnly(text: string): void {
    this.log.line(text);
  }

  /** The calls' `CliIo` with stdout and stderr as detail lines (`rarog service install`). */
  detailIo(): CliIo {
    return this.#ioWith((line) => { this.detail(line); });
  }

  /** The calls' `CliIo` with stdout and stderr as blocks on the screen (the blocks to paste of the steps). */
  blockIo(): CliIo {
    return this.#ioWith((line) => { this.block(line); });
  }

  /**
   * Header of a step (`[n/11] title`, a detail line) and its live line on the screen. With `--verbose` the header is
   * the step's line, as before the step screen, so the output keeps its old shape for the measurements.
   */
  startStep(header: string, title: string, animate: boolean): void {
    this.detail(header);
    if (!this.verbose) this.screen.start(title, { animate });
    else this.screen.stepSeen();
  }

  /** End of a step on the screen; `null` = not applicable on this platform. */
  endStep(step: Step | null, home: string): void {
    this.flush();
    if (step === null) this.detail('  not applicable on this platform');
    if (this.verbose) return;
    if (step === null) {
      this.screen.skip('not applicable on this platform');
      return;
    }
    const result = resultText(step.result ?? step.summary, home);
    // A change counts whatever the mark: a `!` after a partial write drops the "nothing changed" line too.
    const changed = step.changed === true;
    const end = { ...step.fix === undefined ? {} : { fix: this.screenFix(step.fix) }, changed };
    switch (step.state) {
      case 'ok':
      case 'info':
        if (step.skipped === true) this.screen.skip(result, { changed });
        else this.screen.done(result, { changed });
        return;
      case 'warn':
      case 'missing':
        if (step.skipped === true) this.screen.skip(result, { changed });
        else this.screen.warn(result, end);
        return;
      case 'problem':
        // A problem left to an earlier step (`waits for`): that step's line carries the fix.
        if (step.skipped === true) this.screen.skip(result, { changed });
        else this.screen.fail(result, end);
    }
  }

  /** A `Fix:` sentence with `rarog <command>` in the absolute form when a new terminal may not find `rarog`. */
  absoluteFix(text: string): string {
    return this.#cliTarget === null ? text : withInstallationCli(text, this.#cliTarget);
  }

  /**
   * {@link absoluteFix} for the step screen: a `Fix:` line wider than the screen gets each absolute command on a line
   * of its own ({@link fixLines}), so the command can be copied whole; the step screen indents those lines.
   */
  screenFix(text: string): string {
    const fix = this.absoluteFix(text);
    if (this.#cliTarget === null) return fix;
    const width = this.screen.layout.width;
    if (visibleWidth(`${FIX_LABEL}${fix}`) <= width) return fix;
    return fixLines(fix, installationCli(this.#cliTarget), width).join('\n');
  }

  /** Ctrl-C ended a step: its line ends as interrupted, then the `Interrupted.` line; returns 130. */
  interrupted(): number {
    this.flush();
    return this.screen.interrupt();
  }

  /** Ctrl-C with no child running ends the running step on the screen before the exit; returns the stop function. */
  watchInterrupt(): () => void {
    return watchInterrupt(this.screen);
  }

  /** The user accepted the plan ("Continue?" with Enter or "y"): the log file from here on. */
  accepted(): void {
    this.#openLog();
  }

  /** Writes out the lines calls left without a line end. */
  flush(): void {
    for (const writer of this.#writers) writer.flush();
  }

  #ioWith(emit: (line: string) => void): CliIo {
    const writer = new LineWriter(emit);
    this.#writers.push(writer);
    const write = (text: string): void => { writer.write(text); };
    const { ask } = this;
    return { ...this.#io, stdout: write, stderr: write, ...(ask === null ? {} : { ask }) };
  }

  async #ask(
    ask: (prompt: string) => Promise<string | null>, prompt: string, opensLog: boolean,
  ): Promise<string | null> {
    this.flush();
    this.screen.asking({ prompt });
    this.log.line(`question: ${prompt.trim()}`);
    let answer: string | null = null;
    try {
      answer = await ask(this.screen.questionPrompt(prompt));
    } finally {
      this.screen.answered(answer);
    }
    this.log.line(`answer: ${answer === null ? '(end of input)' : answer.trim()}`);
    if (opensLog && isYes(answer)) this.#openLog();
    return answer;
  }

  async #askSecret(askSecret: (prompt: string) => Promise<string | null>, prompt: string): Promise<string | null> {
    this.flush();
    if (!this.#keyNoteShown) {
      this.#keyNoteShown = true;
      this.questionNote(KEY_PROMPT_NOTE);
    }
    this.screen.asking({ hidden: true, prompt });
    this.log.line(`question: ${prompt.trim()}`);
    let answer: string | null = null;
    try {
      answer = await askSecret(this.screen.questionPrompt(prompt));
      return answer;
    } finally {
      this.screen.answered(answer);
    }
  }

  /** The log file from the first "yes" on: before it, and without a terminal, the lines stay in memory. */
  #openLog(): void {
    if (this.log.path !== null || !this.#dataDir.ok) return;
    try {
      this.log.open(this.#dataDir.dir);
    } catch {
      // A log that cannot be written must not stop the setup; the lines stay in memory.
    }
  }
}

/** The step's summary for its screen line: without a prefix that repeats the title, the home directory as `~`. */
/** `Fix:` and its indent on the step screen (`screen/steps.ts`); the lines under it are indented by two more. */
const FIX_LABEL = '   Fix: ';
const FIX_INDENT = 5;

/** `text` as a literal part of a regular expression. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Lines of a `Fix:` sentence that names the absolute `command` of the installation: the first line follows `Fix:`
 * (empty when the sentence starts with the command), the others stand under it. Each command (the absolute form and
 * its arguments: words, and quoted values, up to `,`, `;`, `)` or the end) is alone on its line; the sentence parts
 * between them are wrapped at `width`, without the punctuation that joined them to a command.
 */
export function fixLines(text: string, command: string, width: number): string[] {
  const commands = new RegExp(`${literal(command)}(?: (?:'(?:[^']|'\\\\'')*'|[^\\s,;)']+))*`, 'gu');
  const lines: string[] = [];
  const sentence = (part: string, afterCommand: boolean): void => {
    const words = (afterCommand ? part.replace(/^[\s,;)]+/u, '') : part).replace(/[\s(]+$/u, '');
    if (words === '') return;
    const room = width - FIX_INDENT;
    lines.push(...wrapWords(words, lines.length === 0 ? width - FIX_LABEL.length : room, room));
  };
  let at = 0;
  for (const match of text.matchAll(commands)) {
    sentence(text.slice(at, match.index), at > 0);
    if (lines.length === 0) lines.push('');
    lines.push(match[0]);
    at = match.index + match[0].length;
  }
  sentence(text.slice(at), at > 0);
  return lines;
}

function resultText(summary: string, home: string): string {
  let text = summary;
  for (const prefix of TITLE_PREFIXES) {
    if (text.startsWith(`${prefix}: `)) {
      text = text.slice(prefix.length + 2);
      break;
    }
  }
  return home === '' || home === '/' ? text : text.split(`${home}/`).join('~/');
}

/** Version of this installation for the header; unreadable = `?` (the header must not stop the setup). */
function packageVersion(): string {
  try {
    return readPackageVersion();
  } catch {
    return '?';
  }
}
