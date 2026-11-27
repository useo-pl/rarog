/**
 * The queue take-back: prompts waiting in the CLI queue and in Rarog's paste queue go back to the app, so none of them
 * reaches the agent until a person sends them again; the turn runs on. One step of the driver's chain: gates, the CLI
 * queue counted from the file and seen on screen, Rarog's queue out with an awaited write, `up` and the proof in the
 * file, then the prompt field cleared with `ctrl+u` while it shows only taken text (the field record:
 * `take-back-field.ts`). Every key goes after fresh gates and a fresh screen read, any doubt ends with no further key,
 * and the field stays held while it may show taken text. It sends no Enter, digit or Esc, and it does not decide what
 * the manager does with held echoes: it hands over their tokens.
 */
import type { HerdrClient } from '../../herdr/types.ts';
import type { JsonlFollower } from '../../herdr/jsonl-follow.ts';
import { CLI_QUEUE_POPS_KEPT, popsSince } from '../../herdr/jsonl-queue.ts';
import type { CliQueuePops } from '../../herdr/jsonl-queue.ts';
import { cliDialogOnScreen } from '../../herdr/dialogs/presence.ts';
import { TAKE_BACK_UP_KEY } from '../../herdr/dialogs/send/take-back-keys.ts';
import type { TakeBackKey } from '../../herdr/dialogs/send/take-back-keys.ts';
import { humanTextOf } from '../../transcript-import.ts';
import type { QueueTakeBackResult, TakeBackRefusal, TakenEntry } from '../types.ts';
import type { Scheduler } from '../runtime.ts';
import { composerFieldView, composerQueueShown, squashWhitespace } from './commands.ts';
import type { ComposerFieldView } from './commands.ts';
import { PromptGates } from './prompt-gates.ts';
import type { PromptGatesDeps, PromptGatesPort } from './prompt-gates.ts';
import { PROMPT_FIELD_POLL_MS } from './prompt-paste.ts';
import type { PromptQueue, QueuedPrompt } from './prompt-queue.ts';
import { TakeBackField, clearRecord, collapsedText, screenHolds, showsTaken } from './take-back-field.ts';
import type { FieldText, Screen } from './take-back-field.ts';

/**
 * How long the step waits after `up` for the popAll entries in the file, with a forced read of the file each poll.
 * The CLI was up to about 100 ms faster than `up` in the race at a turn end (CLI 2.1.328, `zabranie-wyscig-*`); the
 * ceiling stays well above 2 s, so a slow disk or a busy herdr does not turn a taken queue into "nothing taken". The
 * reads of a field caught half drawn after popAll have the same ceiling.
 */
export const TAKE_BACK_POP_WAIT_MS = 3_000;

/** A CLI queue entry v1 does not take back: an image the CLI turned into a marker (the app cannot rebuild it). */
const IMAGE_MARKER = /\[Image #\d+\]/;

/**
 * A popAll entry that is one paste and nothing else, `<pasted_content id="p1">\n<text>\n</pasted_content id="p1">`
 * (CLI 2.1.328, `zabranie-wklejka-*`): the field may show it collapsed to a placeholder. An entry with text beside a
 * paste counts as plain text, its collapsed look is unmeasured.
 */
const WHOLE_PASTE = /^<pasted_content id="([0-9a-z]{1,32})">\n([\s\S]*)\n<\/pasted_content id="\1">$/;
const PASTE_TAG = /<\/?pasted_content id="/;

/** Driver dependencies the take-back reads; the same fields as in the driver's deps. */
export interface QueueTakeBackDeps extends PromptGatesDeps {
  readonly client: Pick<HerdrClient, 'readScreen' | 'sendTakeBackKey'>;
  readonly logger?: (line: string) => void;
  readonly promptRetryMs?: number;
  readonly promptFieldPollMs?: number;
  /** {@link TAKE_BACK_POP_WAIT_MS}; tests shorten it. */
  readonly takeBackPopWaitMs?: number;
}

/** Fixed configuration, taken from the driver once, at construction. */
export interface QueueTakeBackConfig {
  readonly deps: QueueTakeBackDeps;
  readonly scheduler: Scheduler;
  readonly key: string;
  readonly consentCardWaitMs: number;
  /** A Claude pane in scope with a follower; anything else refuses with `pane`. */
  readonly follower: Pick<JsonlFollower, 'cliQueue' | 'cliQueuePops' | 'readNow' | 'claimEcho' | 'forgetEcho'> | null;
  readonly claude: boolean;
  readonly queue: Pick<PromptQueue, 'prompts' | 'submitUnsettled' | 'takeBack'>;
}

/**
 * What the take-back needs from the facade: the driver state the gates read ({@link PromptGatesPort}), the audit line
 * of a key and the driver's chain for the cleanup that goes on after the answer.
 */
export interface QueueTakeBackPort extends PromptGatesPort {
  audit(entry: { readonly method: 'send_keys'; readonly keys: readonly string[] }): void;
  enqueue(step: () => Promise<void>): Promise<unknown>;
  /** A Claude Code start dialog stands in the pane (`start-dialog-gate.ts`): no key goes to it. */
  startDialogStands(): Promise<boolean>;
}

/** The follower of a Claude pane in scope, which every step after the gates has. */
type Follower = NonNullable<QueueTakeBackConfig['follower']>;

/** A popAll entry the file proves taken: the entry for the result and the line count of a paste ({@link WHOLE_PASTE}). */
interface TakenCli {
  readonly entry: TakenEntry;
  readonly pasteLines: number | null;
}

/** What a take-back did after its queue left; the result and a step that throws read it. */
interface Progress {
  /** CLI entries the file proves taken, in file order; they reach the result whatever happens after. */
  readonly cli: TakenCli[];
  /** `up` went to the client, sent or failed: from here on the field may show CLI text. */
  up: boolean;
}

export class QueueTakeBack {
  readonly #deps: QueueTakeBackDeps;
  readonly #scheduler: Scheduler;
  readonly #key: string;
  readonly #follower: QueueTakeBackConfig['follower'];
  readonly #claude: boolean;
  readonly #queue: QueueTakeBackConfig['queue'];
  readonly #port: QueueTakeBackPort;
  /** Own gates over the same driver state as the paste queue's; their retry mark is not shared. */
  readonly #gates: PromptGates;
  readonly #field: TakeBackField;
  /** The caller's mark for the first key of the take-back that runs now; it fires once and goes. */
  #onFirstKey: (() => void) | null = null;

  constructor(config: QueueTakeBackConfig, port: QueueTakeBackPort) {
    this.#deps = config.deps;
    this.#scheduler = config.scheduler;
    this.#key = config.key;
    this.#follower = config.follower;
    this.#claude = config.claude;
    this.#queue = config.queue;
    this.#port = port;
    this.#gates = new PromptGates({ deps: config.deps, consentCardWaitMs: config.consentCardWaitMs }, port);
    this.#field = new TakeBackField({
      deps: config.deps, scheduler: config.scheduler, key: config.key, gates: this.#gates,
    }, {
      disposed: () => port.disposed(),
      enqueue: (step) => port.enqueue(step),
      read: () => this.#read(),
      press: (key) => this.#press(key),
      log: (line) => { this.#log(line); },
    });
  }

  /** The prompt field still holds taken text, or may: pastes and idle sends wait, slash commands do not go. */
  holdsField(): boolean {
    return this.#field.holdsField();
  }

  /** `dispose()` of the driver: the cleanup stops without a key. */
  release(): void {
    this.#field.release();
  }

  /**
   * The take-back, as one step of the driver's chain. A refusal comes before the first key and changes no queue.
   * Rarog's queue goes first, with its write awaited, so a failed write refuses before any key; the CLI queue then
   * goes with `up` and counts only from popAll entries in the file: a history entry after `up` can equal a prompt the
   * CLI has just delivered (CLI 2.1.328, `zabranie-wyscig-*`), so the screen alone never proves a take-back.
   * `onFirstKey` runs once, synchronously, right before the first key of this take-back goes to the client; keys of
   * the cleanup after the answer do not call it.
   */
  async run(onFirstKey?: () => void): Promise<QueueTakeBackResult> {
    this.#onFirstKey = onFirstKey ?? null;
    try {
      return await this.#take();
    } finally {
      this.#onFirstKey = null;
    }
  }

  async #take(): Promise<QueueTakeBackResult> {
    const follower = this.#follower;
    if (!this.#claude || follower === null || this.#port.disposed()) return this.#refuse('pane');
    if (this.#field.holdsField()) return this.#refuse('busy');
    if (await this.#port.startDialogStands()) return this.#refuse('dialog');
    if (this.#port.disposed()) return this.#refuse('pane');
    // The last Enter from Rarog's queue first: a hook may still hand its text back to the field.
    while (this.#queue.submitUnsettled()) {
      await this.#sleep(this.#pollMs);
      if (this.#port.disposed()) return this.#refuse('pane');
    }
    const obstacle = await this.#gates.promptObstacle();
    if (this.#port.disposed()) return this.#refuse('pane');
    if (obstacle !== null) return this.#refuse('dialog');
    const screen = await this.#read();
    if (this.#port.disposed()) return this.#refuse('pane');
    if (screen === undefined) return this.#refuse('unknown');
    if (screenHolds(screen) || cliDialogOnScreen(screen.text) === 'unknown') return this.#refuse('dialog');
    const view = screen.view;
    if (view === null) return this.#refuse('dialog');
    const field = squashWhitespace(view.text);
    const head = this.#queue.prompts[0];
    // Only a head pasted into an empty field: the queue pastes after a draft at the desk, and `ctrl+u` would take both.
    const headInField = field !== '' && head !== undefined && !head.confirmed && head.mark.before === ''
      && head.mark.after === field;
    if (view.cutAtTop || view.history || (field !== '' && !headInField)) return this.#refuse('draft');
    await follower.readNow?.();
    if (this.#port.disposed()) return this.#refuse('pane');
    const cli = follower.cliQueue?.() ?? 'unknown';
    if (cli === 'unknown') return this.#refuse('unknown');
    if (cli.some((text) => IMAGE_MARKER.test(text))) return this.#refuse('queue');
    // The follower keeps only the last CLI_QUEUE_POPS_KEPT popAll texts, so after `up` the file could not prove a
    // longer queue taken (`popsSince` answers `unknown`). Of the refusals, `queue` fits: like an image, it is a
    // CLI queue this take-back does not take back.
    if (cli.length > CLI_QUEUE_POPS_KEPT) return this.#refuse('queue');
    if ((cli.length > 0) !== composerQueueShown(screen.text)) return this.#refuse('unknown');

    const taken = await this.#queue.takeBack();
    if (taken === null) return this.#refuse('disk');
    const rarog = this.#rarogEntries(taken);
    const progress: Progress = { cli: [], up: false };
    let fieldCleanup: 'done' | 'pending';
    try {
      fieldCleanup = await this.#afterCommit(progress, cli.length, headInField ? head : undefined, screen.text);
    } catch (err) {
      this.#log(`take-back: pane ${this.#key} stopped after the queue left: ${errorName(err)}`);
      fieldCleanup = await this.#holdAfterThrow(progress);
    }
    const result = { cli: progress.cli.map(({ entry }) => entry), rarog, fieldCleanup };
    return progress.cli.length < cli.length ? { ...result, cliLeft: true } : result;
  }

  /** Rarog's queue is out: the pasted head leaves the field, then `up` takes the CLI queue (CLI 2.1.328, `zabranie-*`). */
  async #afterCommit(
    progress: Progress, cliCount: number, head: QueuedPrompt | undefined, text: string,
  ): Promise<'done' | 'pending'> {
    if (head !== undefined) {
      const own = { expected: squashWhitespace(head.mark.after ?? ''), collapsed: null };
      const outcome = await this.#field.start(clearRecord(own, [head.text], text));
      const cleanup = this.#field.settleRecord(outcome);
      // `up` only on a field read empty: on a filled field its effect is unmeasured.
      if (outcome !== 'done' || cliCount === 0) return cleanup;
    }
    return cliCount === 0 ? 'done' : this.#takeCli(cliCount, progress);
  }

  /**
   * The CLI part: fresh gates and field, `up`, and the popAll entries after it. A failed `up` may still have reached
   * the pane (a client error after delivery), so the file and the field decide after it too. Once `up` went out, a
   * dispose stops the keys and the screen reads, but not the account of what `up` took.
   */
  async #takeCli(expected: number, progress: Progress): Promise<'done' | 'pending'> {
    const follower = this.#follower;
    if (follower === null) return 'done';
    const mark = follower.cliQueuePops?.();
    if (mark === undefined) return 'done';
    const obstacle = await this.#gates.promptObstacle();
    if (this.#port.disposed() || obstacle !== null) return 'done';
    const before = await this.#read();
    if (this.#port.disposed() || before === undefined || screenHolds(before) || before.view === null) {
      return 'done';
    }
    const { view } = before;
    if (view.cutAtTop || view.history || squashWhitespace(view.text) !== '' || !composerQueueShown(before.text)) {
      return 'done';
    }
    // The queue may have grown since `run` checked it: past the popAll buffer the file could not prove it taken.
    await follower.readNow?.();
    if (this.#port.disposed()) return 'done';
    const queued = follower.cliQueue?.() ?? 'unknown';
    if (queued === 'unknown' || queued.length > CLI_QUEUE_POPS_KEPT) return 'done';
    if (this.#gates.knownObstacle() !== null) return 'done';
    progress.up = true;
    const sent = await this.#press(TAKE_BACK_UP_KEY);
    if (!this.#port.disposed()) {
      let last = await this.#awaitPops(follower, mark, expected, progress.cli);
      if (progress.cli.length > 0) last = await this.#settle(ownText(progress.cli), last);
      if (!this.#port.disposed()) return this.#afterUp(progress.cli, expected, last, sent);
    }
    return this.#popsAfterDispose(follower, mark, progress.cli);
  }

  /**
   * After `up`: a forced read of the file and a read of the field each poll, until the popAll entries cover the queue
   * and the field shows text, or the pop wait passes. A text the file proves taken goes to `out` before the next
   * `await`, so nothing taken is lost if a later step throws. Returns the last screen with a field; while the file
   * proves nothing taken, only the latest read counts, so a field read empty before a read that failed is no proof.
   */
  async #awaitPops(follower: Follower, mark: CliQueuePops, expected: number, out: TakenCli[]): Promise<Screen | null> {
    const deadline = this.#scheduler.now() + this.#popWaitMs;
    let last: Screen | null = null;
    for (;;) {
      await follower.readNow?.();
      const pops = this.#notePops(follower, mark, out);
      const screen = await this.#read();
      if (screen !== undefined && screen.view !== null) last = screen;
      else if (out.length === 0) last = null;
      const field = last?.view ?? null;
      if (pops === 'unknown' || this.#port.disposed()) return last;
      const drawn = field !== null && !field.history && squashWhitespace(field.text) !== '';
      if ((pops.length >= expected && drawn) || this.#scheduler.now() >= deadline) return last;
      await this.#sleep(this.#pollMs);
    }
  }

  /** The popAll texts since `mark` that `out` does not hold yet go there, in file order; `unknown` adds none. */
  #notePops(follower: Follower, mark: CliQueuePops, out: TakenCli[]): readonly string[] | 'unknown' {
    const pops = popsSince(mark, follower.cliQueuePops?.() ?? mark);
    if (pops !== 'unknown') for (const raw of pops.slice(out.length)) out.push(this.#cliEntry(raw));
    return pops;
  }

  /**
   * The driver was disposed during `up` or after it: no key and no screen read any more, but the prompts `up` took are
   * out of the CLI queue, so every popAll entry the follower noted still goes to the result. Dispose closes the
   * follower: the forced read then reads nothing new, and the entries it noted before still count.
   */
  async #popsAfterDispose(follower: Follower, mark: CliQueuePops, out: TakenCli[]): Promise<'done'> {
    try {
      await follower.readNow?.();
    } catch {
      // A failed read leaves what the follower noted before.
    }
    this.#notePops(follower, mark, out);
    return 'done';
  }

  /**
   * After popAll the first read may catch the field half drawn: it is read again until it shows `own` (cut at the top,
   * a part of it), is empty, or the pop wait passes.
   */
  async #settle(own: FieldText, last: Screen | null): Promise<Screen | null> {
    const deadline = this.#scheduler.now() + this.#popWaitMs;
    let screen = last;
    while (!settledOn(own, screen?.view ?? null) && !this.#port.disposed() && this.#scheduler.now() < deadline) {
      await this.#sleep(this.#pollMs);
      const next = await this.#read();
      if (next !== undefined && next.view !== null) screen = next;
    }
    return screen;
  }

  /**
   * The table after `up`: clear the field the file proves taken, leave the history entry, or hold the field without
   * keys. After a failed `up` no `down` goes. Without popAll only a field read empty ends without a hold.
   */
  async #afterUp(
    taken: readonly TakenCli[], expected: number, last: Screen | null, sent: boolean,
  ): Promise<'done' | 'pending'> {
    // `release()` has run: a record now would hold a field nothing watches.
    if (this.#port.disposed()) return 'done';
    const view = last?.view ?? null;
    const field = view === null ? '' : squashWhitespace(view.text);
    if (taken.length > 0) {
      // The only field `ctrl+u` may clear: the texts the file proves taken, one per line as the CLI puts them there,
      // or with each paste as its placeholder.
      const own = clearRecord(ownText(taken), taken.map(({ entry }) => entry.text), last?.text ?? '');
      const whole = taken.length >= expected;
      if (whole && view !== null && !view.history && field !== '' && showsTaken(own, field, view.cutAtTop, false)) {
        return this.#field.settleRecord(await this.#field.start(own));
      }
      this.#log(`take-back: pane ${this.#key} took ${String(taken.length)} of ${String(expected)} CLI prompt(s); `
        + 'the field is held without keys');
      return this.#field.hold(field === '' ? own.expected : field, view?.history ?? false, whole ? own : null);
    }
    if (sent && view?.history === true) {
      this.#log(`take-back: no popAll after up in pane ${this.#key}; a history entry stands, down`);
      return this.#field.settleRecord(await this.#field.start({ kind: 'history', downs: 0 }));
    }
    // An unreadable screen may show the taken queue: it is held like a field with text.
    if (view !== null && field === '' && !view.cutAtTop && !view.history) return 'done';
    this.#log(`take-back: no popAll after ${sent ? 'up' : 'a failed up'} in pane ${this.#key}; the field is held `
      + 'without keys');
    return this.#field.hold(view === null ? null : field, view?.history ?? false, null);
  }

  /**
   * A step threw after the queue left. A record goes on in the background. Without one, once `up` went out, the field
   * is held as it reads now, or as it first reads when it cannot be read or is empty while the file proves taken text;
   * only a field read empty with nothing proven ends. No key.
   */
  async #holdAfterThrow(progress: Progress): Promise<'done' | 'pending'> {
    if (this.#port.disposed()) return 'done';
    if (this.#field.holdsField()) {
      this.#field.schedule();
      return 'pending';
    }
    if (!progress.up) return 'done';
    const view = (await this.#read())?.view ?? null;
    if (this.#port.disposed()) return 'done';
    const field = view === null ? '' : squashWhitespace(view.text);
    const empty = view !== null && field === '' && !view.cutAtTop && !view.history;
    if (empty && progress.cli.length === 0) return 'done';
    return this.#field.hold(view === null || empty ? null : field, view?.history ?? false, null);
  }

  /**
   * A popAll text as the person wrote it (no paste wrapper) with the deferred echo token of its window entry, and the
   * line count of the paste the entry is ({@link WHOLE_PASTE}).
   */
  #cliEntry(raw: string): TakenCli {
    const text = humanTextOf(raw);
    const echo = this.#follower?.claimEcho?.(text);
    return { entry: echo === undefined ? { text } : { text, echo }, pasteLines: pasteLinesOf(raw) };
  }

  /** Rarog's items as taken entries; their echo window entries go, the manager handles the held echoes. */
  #rarogEntries(items: readonly QueuedPrompt[]): TakenEntry[] {
    return items.map((item) => {
      if (item.echo === undefined) return { text: item.text };
      if (item.echoArmed) this.#follower?.forgetEcho(item.echo);
      return { text: item.text, echo: item.echo };
    });
  }

  async #read(): Promise<Screen | undefined> {
    if (this.#port.disposed()) return undefined;
    try {
      const { text } = await this.#deps.client.readScreen(this.#port.paneId(), 'visible', 'ansi');
      return { text, view: composerFieldView(text) };
    } catch {
      return undefined;
    }
  }

  /** The only way a take-back key leaves Rarog; the audit gets the attempt, as for every send. */
  async #press(key: TakeBackKey): Promise<boolean> {
    // Synchronous and right before the call: a driver disposed during the last read or gate sends nothing.
    if (this.#port.disposed()) return false;
    const entry = { method: 'send_keys', keys: [key] } as const;
    this.#firstKey();
    try {
      await this.#deps.client.sendTakeBackKey(this.#port.paneId(), key);
      this.#port.audit(entry);
      return true;
    } catch (err) {
      this.#port.audit(entry);
      this.#log(`take-back: ${key} to pane ${this.#key} failed: ${errorName(err)}`);
      return false;
    }
  }

  /** The caller's first-key mark, once per take-back; a mark that throws does not stop the key. */
  #firstKey(): void {
    const mark = this.#onFirstKey;
    this.#onFirstKey = null;
    try {
      mark?.();
    } catch {
      // The mark only times the take-back.
    }
  }

  #refuse(reason: TakeBackRefusal): QueueTakeBackResult {
    this.#log(`take-back: pane ${this.#key} refused (${reason}), no key`);
    return { refused: reason };
  }

  get #pollMs(): number {
    return this.#deps.promptFieldPollMs ?? PROMPT_FIELD_POLL_MS;
  }

  get #popWaitMs(): number {
    return this.#deps.takeBackPopWaitMs ?? TAKE_BACK_POP_WAIT_MS;
  }

  #log(line: string): void {
    try {
      this.#deps.logger?.(line);
    } catch {
      // The log does not stop the take-back.
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#scheduler.setTimeout(() => { resolve(); }, ms);
    });
  }
}

/**
 * The texts the file proves taken as the field shows them, no whitespace: one per line, or with each paste as its
 * placeholder ({@link collapsedText}).
 */
function ownText(taken: readonly TakenCli[]): FieldText {
  return {
    expected: squashWhitespace(taken.map(({ entry }) => entry.text).join('\n')),
    collapsed: collapsedText(taken.map(({ entry, pasteLines }) => ({ text: entry.text, pasteLines }))),
  };
}

/** The line count of a popAll entry that is one paste ({@link WHOLE_PASTE}); `null` for any other entry. */
function pasteLinesOf(raw: string): number | null {
  const inner = WHOLE_PASTE.exec(raw.trim())?.[2];
  return inner === undefined || PASTE_TAG.test(inner) ? null : inner.split('\n').length;
}

/** The field after popAll needs no further read: it is empty, or it shows `own` ({@link showsTaken}). */
function settledOn(own: FieldText, view: ComposerFieldView | null): boolean {
  if (view === null || view.history) return false;
  const field = squashWhitespace(view.text);
  return field === '' ? !view.cutAtTop : showsTaken(own, field, view.cutAtTop, false);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}
