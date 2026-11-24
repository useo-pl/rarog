/**
 * The prompt Claude Code hands back to its field after Rarog's `escape`. The module keeps the prompt of the turn, reads
 * the prompt field once before the key and, after a delivered `escape`, each for a bounded time; it answers that
 * prompt only when the field was empty before the key and the whole field after it equals the prompt by the
 * take-back's own-text rule (no whitespace, `showsTaken`). It sends no key, does not decide whether an interrupt may go
 * and knows nothing of the app's field.
 */
import type { HerdrClient } from '../../herdr/types.ts';
import type { Scheduler, TimerHandle } from '../runtime.ts';
import type { FollowMessage } from '../../herdr/jsonl-follow.ts';
import { composerFieldView, squashWhitespace } from './commands.ts';
import { PROMPT_FIELD_POLL_MS } from './prompt-paste.ts';
import { screenHolds, showsTaken } from './take-back-field.ts';
import type { FieldText, Screen } from './take-back-field.ts';

/**
 * How long the field is read after a delivered `escape`. On CLI 2.1.329 Esc puts the interrupted prompt back into the
 * field only while the turn has shown no text and no tool, the field is empty and the CLI queue is empty; herdr then
 * reports `done` about 0.3 to 0.4 s after the key. Any other interrupt leaves the field as it was.
 */
export const RETURNED_PROMPT_WAIT_MS = 1_200;

/**
 * How long the `escape` waits for the field read before it. A read that does not answer in time proves nothing and the
 * key goes at once: the socket's own request timeout is longer than the wait of the interrupt route.
 */
export const FIELD_READ_BEFORE_ESCAPE_MS = 250;

/** Driver dependencies the read uses; the same fields as in the driver's deps. */
export interface ReturnedPromptDeps {
  readonly client: Pick<HerdrClient, 'readScreen'>;
  readonly logger?: (line: string) => void;
  readonly promptFieldPollMs?: number;
  /** {@link RETURNED_PROMPT_WAIT_MS}; tests shorten it. */
  readonly returnedPromptWaitMs?: number;
  /** {@link FIELD_READ_BEFORE_ESCAPE_MS}; tests shorten it. */
  readonly fieldReadBeforeEscapeMs?: number;
}

export interface ReturnedPromptConfig {
  readonly deps: ReturnedPromptDeps;
  readonly scheduler: Scheduler;
  readonly key: string;
}

/** What the read needs from the facade. */
export interface ReturnedPromptPort {
  paneId(): string;
}

/** A conversation file entry as the follower gives it. */
export type FileEntry = Pick<FollowMessage, 'role' | 'blocks' | 'notice' | 'commandOutput'>;

export class ReturnedPrompt {
  readonly #deps: ReturnedPromptDeps;
  readonly #scheduler: Scheduler;
  readonly #key: string;
  readonly #port: ReturnedPromptPort;
  /** The prompt of the newest turn: the text Rarog sent to an idle pane, or the newest human prompt of the file. */
  #turnPrompt: string | null = null;
  /**
   * Whether Rarog sent a prompt since the history read of the conversation file began, at construction or at a move to
   * another conversation. That read can end after the send, and its newest prompt is then older than the sent one.
   */
  #sentSinceHistory = false;
  /** The answer of the last delivered `escape`. */
  #answer: Promise<string | null> = Promise.resolve(null);
  /** The end condition of the read behind {@link #answer}; it also holds back the answer once settled. */
  #stale: () => boolean = () => false;

  constructor(config: ReturnedPromptConfig, port: ReturnedPromptPort) {
    this.#deps = config.deps;
    this.#scheduler = config.scheduler;
    this.#key = config.key;
    this.#port = port;
  }

  /** The prompt that started the turn, as the driver sent it to an idle pane. */
  noteSent(text: string): void {
    this.#note(text);
    this.#sentSinceHistory = true;
  }

  /**
   * The history of the conversation file, as {@link noteFile}, unless Rarog sent a prompt since the read began: no
   * history entry is then newer than the sent prompt.
   */
  noteHistory(entries: readonly FileEntry[]): void {
    if (!this.#sentSinceHistory) this.noteFile(entries);
  }

  /**
   * Human prompts of the conversation file, in file order: the newest one is the turn's prompt. A harness notice, a
   * command output and an entry with an image are no prompt the field could show as text.
   */
  noteFile(entries: readonly FileEntry[]): void {
    for (const entry of entries) {
      if (entry.role !== 'user' || entry.notice !== undefined || entry.commandOutput !== undefined) continue;
      const texts = entry.blocks.map((block) => (
        block.type === 'text' && !('ref' in block.text) ? block.text.text : null
      ));
      if (texts.length > 0 && texts.every((text) => text !== null)) this.#note(texts.join('\n'));
    }
  }

  #note(text: string): void {
    if (squashWhitespace(text) !== '') this.#turnPrompt = text;
  }

  /**
   * The pane moved to another conversation: its field holds none of the old conversation's prompts, and the answer of
   * an `escape` in the old one answers no repeat in the new one. The new file's history read begins now.
   */
  conversationChanged(): void {
    this.#turnPrompt = null;
    this.#sentSinceHistory = false;
    this.#answer = Promise.resolve(null);
    this.#stale = () => false;
  }

  /**
   * The turn's prompt for the `escape` about to go, or `null` when no hand-back can be proven. `possible` is the
   * driver's gate: a `claude` pane, no prompt in Rarog's queue and no unsettled Enter (the queue would run next), no
   * field held by the take-back (it shows taken text), no dialog and no permission card (a tool has shown). Then one
   * field read within {@link FIELD_READ_BEFORE_ESCAPE_MS}: Esc leaves a draft in place (CLI 2.1.329), so a field equal
   * to the prompt after the key proves the hand-back only when the field was empty before it. An unreadable or late
   * field proves nothing. The driver asks before its pause gate, so that gate stays the last check before the key.
   */
  async beforeEscape(possible: boolean): Promise<string | null> {
    if (!possible || this.#turnPrompt === null) return null;
    let timer: TimerHandle | null = null;
    const late = new Promise<undefined>((resolve) => {
      timer = this.#scheduler.setTimeout(() => { resolve(undefined); },
        this.#deps.fieldReadBeforeEscapeMs ?? FIELD_READ_BEFORE_ESCAPE_MS);
    });
    const screen = await Promise.race([this.#screen(), late]);
    if (timer !== null) this.#scheduler.clearTimeout(timer);
    const view = screen?.view ?? null;
    if (screen === undefined || view === null || screenHolds(screen) || view.cutAtTop || view.history) return null;
    return squashWhitespace(view.text) === '' ? this.#turnPrompt : null;
  }

  /**
   * The answer for the `escape` that just went: `expected` is the prompt of {@link beforeEscape}, or `null` when the
   * key did not go. `stale` ends the read and holds back its answer: the driver is gone, a newer send or interrupt
   * came, or the conversation changed.
   */
  start(expected: string | null, stale: () => boolean): void {
    this.#stale = stale;
    this.#answer = expected === null ? Promise.resolve(null) : this.#bounded(expected, stale);
  }

  /**
   * The prompt the field showed after the last delivered `escape`, else `null`; settles within the read bound. A repeat
   * of the request asks again without a new key, so `stale` is checked again when the answer is handed out.
   */
  answer(): Promise<string | null> {
    const stale = this.#stale;
    return this.#answer.then((found) => (found === null || stale() ? null : found));
  }

  /** The read raced against its bound, so a field read that never returns still answers in time. */
  #bounded(expected: string, stale: () => boolean): Promise<string | null> {
    let over = false;
    let timer: TimerHandle | null = null;
    const bound = new Promise<null>((resolve) => {
      timer = this.#scheduler.setTimeout(() => {
        over = true;
        resolve(null);
      }, this.#deps.returnedPromptWaitMs ?? RETURNED_PROMPT_WAIT_MS);
    });
    const read = this.#read({ expected: squashWhitespace(expected), collapsed: null }, () => over || stale());
    return Promise.race([read, bound]).then((found) => {
      over = true;
      if (timer !== null) this.#scheduler.clearTimeout(timer);
      if (!found) return null;
      this.#deps.logger?.(`interrupt: pane ${this.#key} handed the interrupted prompt back to its field`);
      return expected;
    });
  }

  /**
   * `true` once the whole field, no dialog or form over it, equals the prompt. An empty field or the start of the
   * prompt is read again; a whole field with other text is a draft, which Esc leaves in place (CLI 2.1.329). Each read
   * waits one poll first: right at the key the field still shows what it held before Esc.
   */
  async #read(own: FieldText, done: () => boolean): Promise<boolean> {
    for (;;) {
      await new Promise<void>((resolve) => {
        this.#scheduler.setTimeout(() => { resolve(); }, this.#deps.promptFieldPollMs ?? PROMPT_FIELD_POLL_MS);
      });
      if (done()) return false;
      const screen = await this.#screen();
      if (done()) return false;
      const view = screen?.view ?? null;
      if (screen !== undefined && view !== null && !screenHolds(screen) && !view.cutAtTop && !view.history) {
        const field = squashWhitespace(view.text);
        if (showsTaken(own, field, false, false)) return true;
        if (field !== '' && !showsTaken(own, field, false, true)) return false;
      }
    }
  }

  async #screen(): Promise<Screen | undefined> {
    try {
      const { text } = await this.#deps.client.readScreen(this.#port.paneId(), 'visible', 'ansi');
      return { text, view: composerFieldView(text) };
    } catch {
      return undefined;
    }
  }
}
