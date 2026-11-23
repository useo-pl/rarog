/**
 * The queue of messages sent while a turn runs: paste, check, separate Enter, one head at a time. A turn
 * herdr does not report yet comes from a fresh session registry read ({@link PromptQueue.registryInTurn}).
 *
 * The module holds the queue, the last Enter whose effect is not known yet, the tokens of messages whose text never
 * showed in the field and the leftover of Rarog's own text in the prompt field. Driver state it reads (pane, mode,
 * blocks, consent signals) and steps that stay in the facade `drivers/herdr-driver.ts` (sending with the audit log,
 * the step chain, refusals, bookkeeping after Enter) come through {@link PromptQueuePort}. Constants and the pure
 * field rules live in `prompt-paste.ts`, the gates asked before every key (what holds the pane, the prompt field
 * read) in `prompt-gates.ts`. The copy on disk that survives a server restart is
 * `prompt-queue-store.ts`: this module pastes only after the store reports the text gone from the file, restores only
 * to the same engine session in scope and tells the store when an outcome is known.
 */
import type { CliDialogClass, HerdrMode } from '@rarog/shared';
import type { MessageSource } from '@rarog/shared/rest';
import { foreign, say } from '@rarog/shared/sentences';
import type { ServerSentence } from '@rarog/shared/sentences';
import type { Scheduler, TimerHandle } from '../runtime.ts';
import type { HerdrClient } from '../../herdr/types.ts';
import type { FollowEvent, JsonlFollower } from '../../herdr/jsonl-follow.ts';
import type { CliWaitingSignal } from '../../cli-version.ts';
import { registryCatalog } from '../../herdr/commands/index.ts';
import type { CommandCatalog } from '../../herdr/commands/index.ts';
import type { HeldLeftover, HeldLeftoverItem } from '../types.ts';
import {
  COMPOSER_CLEAR_ATTEMPTS, ESC_SETTLE_MS, STALLED_PROMPT_MESSAGE, heldLeftoverVerdicts, squashWhitespace,
} from './commands.ts';
import {
  PROMPT_FIELD_POLL_MS, PROMPT_FIELD_WAIT_MS, PROMPT_PASTE_ATTEMPTS, PROMPT_RETRY_MS, PROMPT_SUBMIT_LATE_MS,
  PROMPT_SUBMIT_SETTLE_MS, gluedFieldVerdict, pastedFieldVerdict,
} from './prompt-paste.ts';
import type { PasteMark } from './prompt-paste.ts';
import type { PromptQueueStore } from './prompt-queue-store.ts';
import { PROMPT_STALE_RETRY_MS } from './stale-block.ts';
import { PromptGates } from './prompt-gates.ts';
import type { PromptGatesPort, PromptObstacle } from './prompt-gates.ts';
import { PROMPT_SUBMIT_KEY } from '../../herdr/dialogs/send/prompt-submit.ts';

/**
 * Wiadomość w trakcie tury w kolejce wklejeń drivera: tekst po strażniku, token echa
 * odroczonego, numer wysyłki i ślad wklejenia.
 */
export interface QueuedPrompt {
  readonly text: string;
  /** The engine session the message was accepted for (restored: of its file entry); no key goes to another one. */
  readonly session: string;
  readonly echo: string | undefined;
  readonly generation: number;
  /**
   * Migawka katalogu komend z przyjęcia wiadomości: strażnik tekstu z AKTUALNYM trybem panelu przed każdym klawiszem
   * wpisu klasyfikuje tekst tak samo jak przy przyjęciu; `undefined` = driver bez strażnika.
   */
  readonly catalog: CommandCatalog | undefined;
  /** Who sent the message ({@link SendTicket.source}); its paste entry in the audit log carries it. */
  readonly source?: MessageSource | undefined;
  /** Pole przed ostatnim wklejeniem i po nim ({@link PasteMark}). */
  mark: PasteMark;
  /** Ile razy tekst poszedł do pola ({@link PROMPT_PASTE_ATTEMPTS}). */
  pastes: number;
  /** Koniec ostatniego wywołania wklejenia (zegar drivera) — od niego liczy się próg „Enter późno”. */
  pastedAt: number;
  /** Echo zarejestrowane w oknie followera: raz, przed pierwszym wklejeniem. */
  echoArmed: boolean;
  /** Linia logu „czeka” już poszła — jedna na wiadomość, nie na każdą próbę. */
  holdLogged: boolean;
  /**
   * Wpis promptu z echem tej wiadomości stanął w pliku rozmowy, zanim Rarog nacisnął Enter (Enter przy Macu): CLI wziął
   * tekst, więc wpis kończy się bez Entera i bez ponownego wklejenia.
   */
  confirmed: boolean;
  /**
   * Id of the entry on disk ({@link PromptQueueStore}) while this item owns it; `undefined` = no store or the entry
   * went on to the Enter record ({@link SubmittedPrompt.stored}) or to the unseen tokens.
   */
  stored: string | undefined;
}

/**
 * Enter wiadomości z kolejki wklejeń, którego skutku driver jeszcze nie zna: treść pola przy Enterze (bez białych
 * znaków), token echa i chwila po Enterze (zegar drivera).
 */
export interface SubmittedPrompt {
  readonly text: string;
  readonly echo: string | undefined;
  readonly at: number;
  /** The entry on disk stays `pasted` until this Enter is settled: a restart before that gives a note, not a paste. */
  readonly stored?: string;
}

/**
 * The note after a restart for a message whose paste or Enter had no known outcome. The file
 * keeps no text from the first paste on, so the quote is an ellipsis.
 */
export const RESTORED_UNSEEN_NOTE: ServerSentence = say('session.prompt-unseen', { prompt: foreign('…') });

/** A queue item whose pane switched to another engine session (`/clear`, `/resume`) ends with this, without a key. */
export const SESSION_CHANGED_MESSAGE: ServerSentence = say('commands.send-session-changed');

/** Echo tokens of {@link PromptQueue.unseen}; removing a token calls `onGone` (its entry on disk is settled). */
class UnseenTokens extends Set<string> {
  onGone: (token: string) => void = () => {};

  override delete(token: string): boolean {
    const had = super.delete(token);
    if (had) this.onGone(token);
    return had;
  }
}

/** One `send()` from its acceptance on ({@link PromptQueue.expectSend}). */
export interface SendTicket {
  /** The engine session at `send()`: no key of this message goes to another one. */
  readonly session: string;
  /** Who sent the message (`SendOptions.source`); every `prompt` entry of its text in the audit log carries it. */
  readonly source?: MessageSource | undefined;
  /** The task has chosen its path; a parked message passes its entry's write. The first call wins. */
  readonly chosen: (written?: Promise<unknown>) => void;
  /**
   * The pane runs another engine session than {@link session} now: the check of {@link PromptQueue.sessionMoved}
   * without its log line and note, for a clearing that stops before its next Esc pair; the caller refuses after it.
   */
  readonly away: () => boolean;
}

/** Audit entry of one queue step: the paste goes as `prompt` with its text, the keys as `send_keys`. */
export type PromptQueueEntry = PromptEntry | { method: 'send_keys'; keys: readonly string[] };

/** Audit entry of a prompt's text; `sender` only for a message whose sender is known (`MessageBody.source`). */
export interface PromptEntry { method: 'prompt'; text: string; sender?: MessageSource }

/** {@link PromptEntry} of `text`: without `sender` the entry is the same as for any other message. */
export function promptEntry(text: string, source: MessageSource | undefined): PromptEntry {
  return source === undefined ? { method: 'prompt', text } : { method: 'prompt', text, sender: source };
}

/** Driver dependencies the queue reads; the same fields as in the driver's deps. */
export interface PromptQueueDeps {
  readonly client: Pick<HerdrClient, 'getAgent' | 'pasteText' | 'readScreen' | 'sendKeys' | 'sendPromptSubmit'>;
  readonly guard?: (
    text: string,
    opts: { mode: HerdrMode; cwd: string; yoloRoots: readonly string[]; catalog: CommandCatalog },
  ) => unknown;
  readonly yoloRoots: readonly string[];
  readonly now: () => number;
  readonly logger?: (line: string) => void;
  readonly consentRegistryRead?: (engineSessionId: string) => Promise<CliWaitingSignal>;
  readonly consentCardAwaited?: (engineSessionId: string) => number | null;
  readonly consentRegistrationWaits?: (engineSessionId: string) => boolean;
  readonly promptFieldWaitMs?: number;
  readonly promptFieldPollMs?: number;
  readonly promptRetryMs?: number;
  readonly promptSubmitSettleMs?: number;
  readonly escSettleMs?: number;
  readonly promptBlock?: boolean;
  /** The paste queue on disk; absent = the queue lives in RAM only (demo, tests). */
  readonly promptStore?: PromptQueueStore;
}

/** Fixed configuration of the queue, taken from the driver once, at construction. */
export interface PromptQueueConfig {
  readonly deps: PromptQueueDeps;
  readonly scheduler: Scheduler;
  readonly key: string;
  readonly cwd: string;
  readonly consentCardWaitMs: number;
  readonly follower: Pick<JsonlFollower, 'dropEcho' | 'joinEcho'> | null;
  /** The pane is inside `RAROG_HERDR_ROOTS`: with `promptBlock` it decides whether the field is read after a turn. */
  readonly inScope: boolean;
  /**
   * The prompt field holds text taken back from the queues (`queue-take-back.ts`): no paste, so a message never joins
   * it. Absent = never.
   */
  readonly fieldHeld?: () => boolean;
}

/**
 * What the queue needs from the facade: current driver state and the steps that stay there. The driver state the
 * gates read ({@link PromptGatesPort}) comes with it.
 */
export interface PromptQueuePort extends PromptGatesPort {
  mode(): HerdrMode;
  /** One mutating call with the audit log; `false` = it failed (the echo is already refused). */
  send(call: () => Promise<void>, entry: PromptQueueEntry, op: 'message', echo: string | undefined): Promise<boolean>;
  /** A step in the driver's chain. */
  enqueue(step: () => Promise<void>): Promise<void>;
  /** Refusal from an exception: echo back and the "not sent" sentence with the reason. */
  refuseMessage(err: unknown, echo: string | undefined): void;
  /** Echo back and a "not sent" sentence (the message stalled, the pane switched to another engine session). */
  refuse(echo: string | undefined, sentence: ServerSentence): void;
  /** The facade's flag "Rarog left text in the field" (after `ctrl+c`, a hook block, a stall). */
  readonly leftover: { needsEscape: boolean };
  /** Before the Enter key: the send generation reached the pane, the local command expectation ends. */
  beforeSubmit(generation: number): void;
  /** After a delivered Enter: the same bookkeeping as after `agent.prompt`. */
  afterSubmit(echo: string | undefined, generation: number): void;
}

export class PromptQueue {
  readonly #deps: PromptQueueDeps;
  readonly #scheduler: Scheduler;
  readonly #key: string;
  readonly #cwd: string;
  readonly #follower: Pick<JsonlFollower, 'dropEcho' | 'joinEcho'> | null;
  readonly #inScope: boolean;
  readonly #fieldHeld: () => boolean;
  readonly #port: PromptQueuePort;
  /** What holds the pane and the prompt field, asked before every key ({@link PromptGates}). */
  readonly #gates: PromptGates;
  /**
   * Wiadomości w trakcie tury, które czekają na wklejenie albo na Enter, w kolejności
   * przyjęcia. Głowa idzie pierwsza: wiadomość, przy której stanął dialog, wraca na początek, a nowsza staje za nią.
   * Kolejka żyje poza łańcuchem kroków drivera (`#chain`): odpowiedź z karty na dialog, na który wiadomość czeka,
   * nie stoi za nią.
   */
  readonly prompts: QueuedPrompt[] = [];
  /** Zegar następnej próby głowy {@link prompts}; `null` = żadna nie czeka. */
  promptsTimer: TimerHandle | null = null;
  /**
   * Ostatni Enter wiadomości z kolejki wklejeń, którego skutku driver jeszcze nie zna, albo `null`. Hook
   * `UserPromptSubmit` biegnie przy tym Enterze, a zablokowany prompt CLI oddaje do pola bez wpisu w pliku: następna
   * wiadomość czeka więc przed wklejeniem na wpis promptu z pliku (echo albo ta sama treść), pole z oddanym tekstem
   * albo sufit {@link PROMPT_SUBMIT_SETTLE_MS} ({@link submitUnsettled}). Gasi go też nowa rozmowa w panelu.
   */
  get submitted(): SubmittedPrompt | null { return this.#submitted; }
  set submitted(value: SubmittedPrompt | null) {
    const old = this.#submitted?.stored;
    this.#submitted = value;
    if (old !== undefined && old !== value?.stored) this.#settle(old);
    if (this.#submittedTimer !== null) {
      this.#scheduler.clearTimeout(this.#submittedTimer);
      this.#submittedTimer = null;
    }
    // The Enter settles at the ceiling at the latest, even with no later message asking (its entry on disk goes then).
    if (value?.stored === undefined || value.at === Number.POSITIVE_INFINITY) return;
    this.#submittedTimer = this.#scheduler.setTimeout(() => {
      this.#submittedTimer = null;
      if (this.#submitted === value) this.submitted = null;
    }, Math.max(0, value.at + (this.#deps.promptSubmitSettleMs ?? PROMPT_SUBMIT_SETTLE_MS) - this.#scheduler.now()));
  }

  #submitted: SubmittedPrompt | null = null;
  #submittedTimer: TimerHandle | null = null;
  #sent: Promise<void> = Promise.resolve();
  /** Pasted marks restored at start whose notes wait for the history import ({@link followed}). */
  readonly #notes: string[] = [];
  /**
   * Tokeny echa wiadomości z kolejki, których tekstu driver nie zobaczył w polu po wklejeniu i nie wkleił drugi raz
   * (`unseen`) albo których pole opustoszało przy biurku przed Enterem Raroga (`taken`, {@link #promptFieldLost}).
   * Odczyt pola po turze (`checkHeldLeftover` drivera) daje im werdykt `unseen` zamiast `empty` albo `unknown`, więc
   * pod dymkiem staje notka o wysyłce bez potwierdzenia. Token schodzi przy tym odczycie, z wpisem z pliku, który
   * niesie to echo, i z wypadnięciem wpisu z okna echa (`echo-dropped`), a bez odczytu pola po turze
   * ({@link #readsHeldField}) nie powstaje.
   */
  readonly unseen: Set<string> = new UnseenTokens();
  /** Entries on disk of the {@link unseen} tokens: settled when the token goes. */
  readonly #unseenStored = new Map<string, string>();
  /**
   * Pole trzyma NASZ wstrzymany prompt, którego CLI nie przyjął (`checkHeldLeftover` drivera), albo może trzymać
   * tekst wiadomości z kolejki wklejeń po Enterze, odmowie strażnika albo nieudanym Enterze (blokada hooka w trakcie
   * tury oddaje tekst do pola bez wpisu w pliku): treść pola bez białych znaków albo `null`. Następna wysyłka z Raroga
   * czyta pole jeszcze raz i czyści je parą Esc WYŁĄCZNIE wtedy, gdy pole dalej trzyma dokładnie tę treść.
   * W odróżnieniu od `#needsEscape`, które czyści każde pełne pole: pozostałość mogła już wyjść z pola przy Macu,
   * a w polu stoi nowy szkic człowieka. Gasi go zadanie wysyłki, które doszło do
   * czyszczenia, nowa rozmowa w panelu i wpis `user` z pliku z tą samą treścią (pozostałość wysłana).
   */
  heldLeftover: string | null = null;

  constructor(config: PromptQueueConfig, port: PromptQueuePort) {
    this.#deps = config.deps;
    this.#scheduler = config.scheduler;
    this.#key = config.key;
    this.#cwd = config.cwd;
    this.#follower = config.follower;
    this.#inScope = config.inScope;
    this.#fieldHeld = config.fieldHeld ?? ((): boolean => false);
    this.#port = port;
    this.#gates = new PromptGates({ deps: config.deps, consentCardWaitMs: config.consentCardWaitMs }, port);
    (this.unseen as UnseenTokens).onGone = (token) => {
      const stored = this.#unseenStored.get(token);
      this.#unseenStored.delete(token);
      if (stored !== undefined) this.#settle(stored);
    };
  }

  /**
   * Called synchronously in `send()`: the ticket keeps the engine session the message is accepted for, before the
   * driver's chain and the attachment write, so no key of it goes to a conversation the pane switched to meanwhile
   * ({@link sessionMoved}). The `202` of that `send()` waits for {@link SendTicket.chosen} ({@link saved}): the
   * driver's task calls it once it has chosen the path, and a message that parks passes its entry's write
   * ({@link parkPrompt}). No store = no wait.
   */
  expectSend(source?: MessageSource): SendTicket {
    const session = this.#agentSessionId;
    const away = (): boolean => session !== this.#agentSessionId;
    if (this.#deps.promptStore === undefined) return { session, source, chosen: () => {}, away };
    let chosen: (written?: Promise<unknown>) => void = () => {};
    // A promise resolves once: a later call (the net) does not replace the write the park handed over.
    this.#sent = new Promise<unknown>((resolve) => { chosen = resolve; }).then(() => undefined);
    return { session, source, chosen, away };
  }

  /**
   * The pane runs another engine session than `session` (`/clear`, `/resume` while the message waited): the message
   * ends without a key, its echo goes back with {@link SESSION_CHANGED_MESSAGE} and a "not sent" log line. Call it with
   * no `await` between the check and the key.
   *
   * @returns `true` = refused, no key may go
   */
  sessionMoved(session: string, echo: string | undefined): boolean {
    if (session === this.#agentSessionId) return false;
    this.#log(`send: message for pane ${this.#key} not sent: the pane runs another engine session`);
    this.#port.refuse(echo, SESSION_CHANGED_MESSAGE);
    return true;
  }

  /** The last `send()` has its path and, if it parked, its entry on disk ({@link expectSend}). */
  saved(): Promise<void> {
    return this.#sent;
  }

  /**
   * The send shield before the "Yes" digit of a measured consent dialog: `hook` while a hook consent request of
   * the session waits ({@link keyHookWaits}), `registry` when a fresh registry read is not `waiting` with class
   * `expected` (no port, no session or a read error count the same), otherwise `null`. The hook is checked again
   * after the read, and the driver asks {@link keyHookWaits} once more after its fresh screen read.
   */
  async keyShield(expected: CliDialogClass): Promise<'hook' | 'registry' | null> {
    if (this.keyHookWaits()) return 'hook';
    const read = this.#deps.consentRegistryRead;
    if (read === undefined || this.#agentSessionId === '') return 'registry';
    let signal: CliWaitingSignal;
    try {
      signal = await read(this.#agentSessionId);
    } catch {
      return 'registry';
    }
    if (this.keyHookWaits()) return 'hook';
    return signal.kind === 'waiting' && signal.dialog === expected ? null : 'registry';
  }

  /**
   * Whether a hook consent request of the session stands in the way of the "Yes" digit: a channel card holds the
   * dialog, or a live registration of the session, a subagent's too, has no channel card
   * ({@link PromptQueueDeps.consentRegistrationWaits}), however long ago it was accepted: the ceiling of the card wait
   * (`#consentRequestWaits` in `prompt-gates.ts`) is only for messages. Synchronous, so the driver asks it after its
   * last `await` before the key. A port exception counts as waiting.
   */
  keyHookWaits(): boolean {
    if (this.#port.consentCardStands()) return true;
    const waits = this.#deps.consentRegistrationWaits;
    if (waits === undefined || this.#agentSessionId === '') return false;
    try {
      return waits(this.#agentSessionId);
    } catch {
      return true;
    }
  }

  /**
   * Entries of this pane's engine session (not of its positional address) from the file read at start. Queued
   * messages park in their order and go the usual way (check, paste, check, Enter); they carry no echo token, so the
   * prompt entry from the transcript file shows the message, and keep their sender for the audit log. A pasted mark
   * is never pasted again (rule b of the
   * revision): it gives {@link RESTORED_UNSEEN_NOTE} after the history ({@link followed}). A pane out of scope or of
   * another engine drops its entries with a "not sent" log line, without a screen read or a key.
   *
   * @param claude the pane runs Claude
   * @param generation the next send number of the driver, one per restored message
   */
  restore(claude: boolean, generation: () => number): void {
    const store = this.#deps.promptStore;
    const session = this.#agentSessionId;
    if (store === undefined || session === '') return;
    const { queued, pasted } = store.restore(session);
    if (queued.length + pasted.length === 0) return;
    if (!claude || !this.#inScope) {
      for (const id of [...pasted, ...queued.map((entry) => entry.id)]) store.settle(id);
      this.#log(`send: ${String(queued.length + pasted.length)} restored message(s) for pane ${this.#key} not sent: `
        + (claude ? 'out of scope' : 'not a Claude pane'));
      return;
    }
    this.#notes.push(...pasted);
    for (const entry of queued) {
      this.prompts.push({
        text: entry.text, session, source: entry.source, echo: undefined, generation: generation(), catalog: undefined,
        mark: { before: null, after: null, lost: false }, pastes: 0, pastedAt: 0,
        echoArmed: true, holdLogged: false, confirmed: false, stored: entry.id,
      });
    }
    this.#log(`send: restored ${String(queued.length)} queued and ${String(pasted.length)} pasted`
      + ` message(s) for pane ${this.#key}`);
    if (queued.length > 0) void this.#port.enqueue(() => this.drainPrompts());
  }

  /**
   * An event of the follower: its first `artifacts` payout comes after the history import (or a missing transcript
   * file), so restored notes go then and a full history keeps them; a read error (`error`, the history did not
   * import) sends them too, so the notes do not hang on the payout.
   */
  followed(event: FollowEvent['type'], note: (sentence: ServerSentence) => void): void {
    if (event !== 'artifacts' && event !== 'error') return;
    for (const id of this.#notes.splice(0)) {
      note(RESTORED_UNSEEN_NOTE);
      this.#settle(id);
    }
  }

  /**
   * `dispose()` of the driver: the retry timer stops and the messages stay without a key (the manager flushes their
   * held echoes when it detaches the driver). While the server keeps running (pane gone, driver replaced) the queue in
   * RAM goes, so its entries leave the file too; at shutdown the store is closed first and the file stays for the next
   * start.
   */
  release(): void {
    if (this.promptsTimer !== null) {
      this.#scheduler.clearTimeout(this.promptsTimer);
      this.promptsTimer = null;
    }
    for (const item of this.prompts) this.#drop(item);
    this.submitted = null;
    for (const stored of [...this.#unseenStored.values(), ...this.#notes.splice(0)]) this.#settle(stored);
    this.#unseenStored.clear();
  }

  /**
   * The queue take-back: every message not confirmed in the transcript leaves the queue, the head waiting for its Enter
   * included, and leaves the file with a write awaited here. A failed write puts them back at the head of the queue in
   * their order and gives `null`. The caller owns their echo tokens from here on.
   */
  async takeBack(): Promise<QueuedPrompt[] | null> {
    const items = this.prompts.filter((item) => !item.confirmed);
    if (items.length === 0) return [];
    for (const item of items) this.prompts.splice(this.prompts.indexOf(item), 1);
    const ids = items.flatMap((item) => (item.stored === undefined ? [] : [item.stored]));
    const store = this.#deps.promptStore;
    if (store !== undefined && ids.length > 0 && !(await store.remove(ids))) {
      this.prompts.unshift(...items);
      this.#log(`send: ${String(items.length)} queued message(s) for pane ${this.#key} stay: the take-back was not written`);
      return null;
    }
    for (const item of items) item.stored = undefined;
    return items;
  }

  /** The item's outcome is known (sent, refused, confirmed) unless it went on to the Enter record or the unseen tokens. */
  #drop(item: QueuedPrompt): void {
    if (item.stored !== undefined) this.#settle(item.stored);
    item.stored = undefined;
  }

  #settle(stored: string): void {
    this.#deps.promptStore?.settle(stored);
  }

  get #disposed(): boolean { return this.#port.disposed(); }
  get #paneId(): string { return this.#port.paneId(); }
  get #mode(): HerdrMode { return this.#port.mode(); }
  get #agentSessionId(): string { return this.#port.agentSessionId(); }
  get #needsEscape(): boolean { return this.#port.leftover.needsEscape; }
  set #needsEscape(value: boolean) { this.#port.leftover.needsEscape = value; }
  /** The same rule as the driver's field read after a turn: an `unseen` token without that read has no reader. */
  get #readsHeldField(): boolean { return this.#inScope && this.#deps.promptBlock !== false; }

  /**
   * Wiadomość do panelu Claude w trakcie tury staje w kolejce wklejeń ({@link drainPrompts}). Echo odroczone
   * należy od tej chwili do wpisu kolejki: `onDelivered` zdejmuje siatkę `send()`, a każda droga, która kończy wpis bez
   * Entera, oddaje token sama, chyba że wiadomość mogła już pójść (wtedy echo zostaje w oknie).
   *
   * Pozostałości w polu (`#needsEscape`) nie czyścimy tutaj: robi to próba wpisu tuż przed pierwszym wklejeniem, po
   * sprawdzeniu, że nic nie stoi ({@link #clearPromptLeftover}).
   * The session is the ticket's, taken at `send()` ({@link expectSend}): a pane that switched to another conversation
   * meanwhile refuses the message here, with nothing on disk. The entry goes to disk with that engine session id
   * (none = no restore, no entry); the `202` waits for that write. The item keeps the id too: it goes only to that
   * conversation ({@link #sessionMoved}).
   */
  parkPrompt(
    text: string, echo: string | undefined, generation: number, catalog: CommandCatalog | undefined,
    onDelivered: () => void, ticket: SendTicket,
  ): void {
    const { session, chosen, source } = ticket;
    if (this.sessionMoved(session, echo)) {
      chosen();
      onDelivered();
      return;
    }
    const entry = session === '' ? undefined : this.#deps.promptStore?.add(session, text, source);
    chosen(entry?.written);
    this.prompts.push({
      text, session, source, echo, generation, catalog, mark: { before: null, after: null, lost: false }, pastes: 0,
      pastedAt: 0, echoArmed: false, holdLogged: false, confirmed: false, stored: entry?.id,
    });
    onDelivered();
  }

  /**
   * Kolejka wklejeń po kolei, od głowy, w łańcuchu kroków drivera. Głowa, przy której coś stoi, zostaje na początku
   * i czeka na następną próbę za {@link PROMPT_RETRY_MS}; nowsze stoją za nią. Wpis potwierdzony wpisem z pliku
   * rozmowy ({@link noteQueuedEcho}) schodzi bez dalszych prób.
   * An attempt in which a fresh registry read under a stale-able hold said the CLI does not wait tries again after
   * {@link PROMPT_STALE_RETRY_MS}: the dialog closed and only lagging signals hold, so the gap before the next dialog
   * of the same turn is short.
   */
  async drainPrompts(): Promise<void> {
    if (this.promptsTimer !== null) {
      this.#scheduler.clearTimeout(this.promptsTimer);
      this.promptsTimer = null;
    }
    for (;;) {
      const item = this.prompts[0];
      if (item === undefined || this.#disposed) return;
      this.#gates.registryClear = false;
      const result = await this.#pasteAttempt(item);
      if (this.#disposed) return;
      if (result === 'wait' && !item.confirmed) {
        // Nothing pasted yet: the entry gets its text back, so a restart now sends it instead of a note.
        if (item.stored !== undefined && item.pastes === 0) await this.#deps.promptStore?.requeue(item.stored, item.text);
        if (this.#disposed) return;
        const retryMs = this.#deps.promptRetryMs ?? PROMPT_RETRY_MS;
        this.promptsTimer = this.#scheduler.setTimeout(() => {
          this.promptsTimer = null;
          if (!this.#disposed) void this.#port.enqueue(() => this.drainPrompts());
        }, this.#gates.registryClear ? Math.min(retryMs, PROMPT_STALE_RETRY_MS) : retryMs);
        return;
      }
      const at = this.prompts.indexOf(item);
      if (at >= 0) this.prompts.splice(at, 1);
      this.#drop(item);
    }
  }

  /**
   * Werdykty odczytu pola po turze (`checkHeldLeftover` drivera) z polem `region` (`null` = nieczytelne): wpis,
   * który czeka w kolejce, dostaje `unknown`, a token z {@link unseen} schodzi i przy pustym albo nieczytelnym polu
   * daje `unseen`.
   */
  fieldVerdicts(items: readonly HeldLeftoverItem[], region: string | null): Map<string, HeldLeftover> {
    // Wiadomość z kolejki wklejeń nie jest niewziętym promptem: jej tekst stoi w polu,
    // bo czeka na Enter. `unknown` — bez notki, bez zgody na czyszczenie pola i z echem w oknie.
    const parked = new Set(this.prompts.map((prompt) => prompt.echo));
    const free = items.filter((item) => !parked.has(item.token));
    const list = heldLeftoverVerdicts(region, free.map((item) => item.text));
    const verdicts = new Map<string, HeldLeftover>(items.map((item) => [item.token, 'unknown'] as const));
    free.forEach((item, index) => { verdicts.set(item.token, list[index] ?? 'unknown'); });
    for (const item of items) {
      // Tekstu po wklejeniu driver nie zobaczył i nie wkleił drugi raz: puste albo nieczytelne pole niczego nie
      // potwierdza. Pole z tekstem (`not-taken`, `unconfirmed`) mówi więcej i zostaje.
      const verdict = verdicts.get(item.token);
      if (this.unseen.delete(item.token) && (verdict === 'empty' || verdict === 'unknown')) {
        verdicts.set(item.token, 'unseen');
      }
    }
    return verdicts;
  }

  /** Wpis kolejki nie ma już po co próbować: `dispose()` albo wiadomość stoi w pliku rozmowy bez Entera Raroga. */
  #promptGone(item: QueuedPrompt): boolean {
    return this.#disposed || item.confirmed;
  }

  /**
   * Wpis promptu z echem odroczonym przyszedł z pliku rozmowy. Wiadomość z kolejki wklejeń, która jeszcze czeka
   * na Enter Raroga, poszła więc Enterem przy Macu: wpis kończy się bez Entera i bez ponownego wklejenia. Własny Enter
   * zdejmuje wpis z kolejki przed klawiszem, więc jego wpis z pliku tu nie trafia — rozstrzyga za to ten Enter
   * ({@link submitted}: CLI przyjął wiadomość), a wiadomość bez potwierdzenia (`unseen`) ma je teraz.
   */
  noteQueuedEcho(token: string): void {
    if (this.submitted?.echo === token) this.submitted = null;
    this.unseen.delete(token);
    const item = this.prompts.find((prompt) => prompt.echo === token);
    if (item === undefined || item.confirmed) return;
    item.confirmed = true;
    this.#log(`send: message for pane ${this.#key} arrived in the transcript, no Enter from Rarog`);
  }

  /**
   * Strażnik tekstu jeszcze raz, z AKTUALNYM trybem panelu, tuż przed klawiszem wpisu z kolejki: tryb mógł przejść
   * na `bypass` poza `RAROG_YOLO_ROOTS`, kiedy wiadomość czekała na koniec dialogu.
   * Migawka katalogu z przyjęcia i tekst po pierwszym strażniku; liczy się tylko odmowa — klasyfikację komendy
   * rozstrzygnęło przyjęcie (do kolejki trafia wyłącznie tekst bez komendy). Odmowa kończy wpis: echo wraca, a powód
   * stoi w transkrypcie.
   *
   * @returns `true` — strażnik odmówił, klawisz nie idzie
   */
  #queuedGuardRefuses(item: QueuedPrompt, step: 'paste' | 'Enter'): boolean {
    const guard = this.#deps.guard;
    if (guard === undefined) return false;
    try {
      guard(item.text, {
        mode: this.#mode, cwd: this.#cwd, yoloRoots: this.#deps.yoloRoots, catalog: item.catalog ?? registryCatalog(),
      });
      return false;
    } catch (err) {
      this.#log(`send: send guard refused the message for pane ${this.#key} before ${step}`);
      this.#port.refuseMessage(err, item.echo);
      return true;
    }
  }

  /**
   * Jedna próba głowy kolejki — pięć kroków karty 0a:
   *
   * 1. nic nie stoi: blokada w oczach Raroga, prośba hooka zgody tej sesji, świeży rejestr sesji CLI, pole promptu na
   *    wierzchu ekranu (dialog i formularz je zakrywają);
   * 2. sam tekst przez `pane.send_input`, po `agent.get` z tą samą sesją silnika (adres panelu jest pozycyjny)
   *    i po ponownym sprawdzeniu blokady, prośby hooka i świeżego rejestru tuż przed wklejeniem;
   * 3. tekst stoi w polu;
   * 4. drugi raz blokada, prośba hooka i świeży rejestr; od wklejenia minęło ponad {@link PROMPT_SUBMIT_LATE_MS} —
   *    jeszcze raz pole i rejestr, z linią logu;
   * 5. strażnik tekstu z aktualnym trybem ({@link #queuedGuardRefuses}) i `enter` osobnym klawiszem
   *    ({@link HerdrClient.sendPromptSubmit}).
   *
   * Przed pierwszym wklejeniem, po kroku 1, wiadomość czeka na rozstrzygnięcie poprzedniego Entera z kolejki
   * ({@link submitUnsettled}), a potem próba czyści pozostałość w polu: tekst zostawiony przez Raroga (blokada hooka,
   * wiadomość z kolejki po Enterze) — {@link #clearPromptLeftover}. Ponowienie wpisu, którego tekst stoi w polu
   * i czeka na Enter, pola nie czyści. Pole po wklejeniu, które trzyma wcześniejszy tekst Raroga
   * ({@link #gluedVerdict}), kończy wpis bez Entera, bez czyszczenia i bez drugiego wklejenia.
   *
   * Przeszkoda po kroku 2: bez Entera, wiadomość zostaje na początku kolejki, a tekst ZOSTAJE w polu. Pomiar 0a: tekst,
   * który stał w polu, przetrwał dialog 7 z 7 razy i późniejszy Enter go wysłał; czyszczenie wymagałoby `escape`, który
   * nad dialogiem jest odmową. Tekst wklejony w dialog, który już stał, przepadł 6 z 6 razy: pole po dialogu jest
   * takie jak przed wklejeniem, więc następna próba wkleja jeszcze raz — ale tylko z dowodem, że tekst przepadł albo że
   * nie mógł pójść; puste pole bez takiego dowodu kończy wpis bez drugiego wklejenia ({@link pastedFieldVerdict}).
   * Każde inne pole, którego driver nie potrafi uznać za wklejony tekst, kończy wpis bez Entera.
   *
   * @returns `wait` — głowa czeka na następną próbę; `done` — wpis zszedł (wysłany, wzięty przy biurku, odrzucony przez
   *   strażnika albo porzucony z ostrzeżeniem)
   */
  async #pasteAttempt(item: QueuedPrompt): Promise<'wait' | 'done'> {
    if (this.#promptGone(item) || this.#sessionMoved(item)) return 'done';
    // Taken text in the field: the attempt and the take-back are steps of one chain, so this check holds to the key.
    if (this.#fieldHeld()) return this.#promptHeld(item, 'field', false);
    const first = await this.#gates.promptObstacle();
    if (this.#promptGone(item)) return 'done';
    if (first !== null) return this.#promptHeld(item, first, false);
    let field = await this.#gates.readPromptField();
    if (this.#promptGone(item)) return 'done';
    if (field === undefined) return this.#promptHeld(item, 'herdr', false);
    if (field === null) return this.#promptHeld(item, 'screen', false);
    // Pole z tekstem poprzedniego Entera: hook go oddał, Enter rozstrzygnięty (pozostałość czyści krok niżej).
    if (this.submitted !== null && field === this.submitted.text) this.submitted = null;
    if (item.mark.before === null && this.submitUnsettled()) return this.#promptHeld(item, 'submit', false);
    let verdict = pastedFieldVerdict(field, item.mark);
    // Pole zmienione po wklejeniu, którego driver nie zobaczył: wcześniejszy tekst Raroga w nim to nie wklejony tekst.
    if (verdict === 'landed') verdict = this.#gluedVerdict(item, field) ?? verdict;
    if (verdict === 'taken' || verdict === 'changed' || verdict === 'unseen') {
      return this.#promptFieldLost(item, verdict);
    }
    if (verdict === 'landed') {
      item.mark = { before: item.mark.before, after: field, lost: false };
      this.#joinDraftEcho(item);
    }
    if (verdict === 'paste') {
      if (item.pastes >= PROMPT_PASTE_ATTEMPTS) return this.#promptGaveUp(item);
      if (item.mark.before === null) {
        const cleared = await this.#clearPromptLeftover(item, field);
        if (typeof cleared === 'string') return cleared;
        field = cleared.field;
      }
      const placed = await this.#pastePrompt(item, field);
      if (placed !== 'placed') return placed;
    }
    const second = await this.#gates.promptObstacle();
    if (this.#promptGone(item)) return 'done';
    if (second !== null) return this.#promptHeld(item, second, true);
    const elapsed = this.#scheduler.now() - item.pastedAt;
    if (elapsed > PROMPT_SUBMIT_LATE_MS) {
      const late = await this.#lateSubmitObstacle(item);
      if (this.#promptGone(item)) return 'done';
      this.#log(`send: Enter ${String(elapsed)} ms after paste in pane ${this.#key}, checked again: ${late ?? 'clear'}`);
      if (late !== null) return this.#promptHeld(item, late, true);
    }
    if (this.#sessionMoved(item)) return 'done';
    if (this.#queuedGuardRefuses(item, 'Enter')) {
      // Tekst stoi w polu: następna wysyłka z Raroga skasuje go, jeśli pole dalej trzyma dokładnie ten tekst.
      this.#rememberOwnText(item);
      return 'done';
    }
    return this.#submitPrompt(item);
  }

  /**
   * Pozostałość w polu przed pierwszym wklejeniem wpisu: para Esc tylko na pole, które widać w ramce pola promptu,
   * i tylko na tekst zostawiony przez Raroga — `#needsEscape` (blokada hooka poza turą, przerwanie, stall) albo pole
   * równe `heldLeftover` (tekst wiadomości z kolejki po Enterze). Przed każdą parą jeszcze raz blokada, prośba
   * hooka i świeży rejestr, potem świeży odczyt pola i własność pozostałości jeszcze raz (w czasie rejestru pole mogło
   * opustoszeć, zmienić się w szkic albo zniknąć pod dialogiem, a zgoda wygasnąć), stan drivera bez czekania i strażnik
   * tekstu; po parze znów świeży odczyt (dialog albo formularz zakrywa pole: `null`, czekamy). Najwyżej
   * {@link COMPOSER_CLEAR_ATTEMPTS} par, jak przy `#clearComposer`; pole, którego pary nie czyszczą, dostaje wklejenie
   * za swoją treścią.
   *
   * Puste pole kończy `#needsEscape`, a `heldLeftover` tylko wtedy, gdy opróżniła je nasza para: puste pole zaraz po
   * Enterze nie dowodzi, że CLI przyjął wiadomość, bo hook oddaje jej tekst do pola później ({@link #gluedVerdict}).
   *
   * @param field pole odczytane w kroku 1 (bez białych znaków)
   * @returns pole tuż przed wklejeniem albo wynik próby (`wait`, `done`)
   */
  async #clearPromptLeftover(item: QueuedPrompt, field: string): Promise<{ field: string } | 'wait' | 'done'> {
    let current = field;
    let pairs = 0;
    for (;;) {
      if (current === '') {
        this.#needsEscape = false;
        if (pairs > 0) this.heldLeftover = null;
        return { field: current };
      }
      if (!this.#ownsLeftover(current) || pairs >= COMPOSER_CLEAR_ATTEMPTS) {
        // Cudzy szkic albo pole, którego pary nie czyszczą: bez klawiszy, a zgoda na czyszczenie wygasa.
        this.heldLeftover = null;
        return { field: current };
      }
      const obstacle = await this.#gates.promptObstacle();
      if (this.#promptGone(item)) return 'done';
      if (obstacle !== null) return this.#promptHeld(item, obstacle, false);
      // Świeże pole tuż przed parą: para Esc na pustym polu otwiera rewind, a na szkicu przy Macu kasuje go.
      const fresh = await this.#gates.readPromptField();
      if (this.#promptGone(item)) return 'done';
      if (fresh === undefined) return this.#promptHeld(item, 'herdr', false);
      if (fresh === null) return this.#promptHeld(item, 'screen', false);
      if (fresh !== current) {
        if (fresh === '') {
          current = fresh;
          continue;
        }
        // Inna treść niż przy sprawdzeniu własności: następna próba od początku, bez klawiszy.
        return this.#promptHeld(item, 'field', false);
      }
      if (!this.#ownsLeftover(fresh)) continue;
      // Synchronicznie, bez `await` do klawisza: blokada albo prośba hooka, które driver poznał w czasie odczytu.
      const known = this.#gates.knownObstacle();
      if (known !== null) return this.#promptHeld(item, known, false);
      if (this.#sessionMoved(item) || this.#queuedGuardRefuses(item, 'paste')) return 'done';
      const sent = await this.#port.send(
        () => this.#deps.client.sendKeys(this.#paneId, ['escape', 'escape']),
        { method: 'send_keys', keys: ['escape', 'escape'] },
        'message', item.echo,
      );
      if (!sent || this.#promptGone(item)) return 'done';
      pairs += 1;
      await this.#sleep(this.#deps.escSettleMs ?? ESC_SETTLE_MS);
      if (this.#promptGone(item)) return 'done';
      const next = await this.#gates.readPromptField();
      if (this.#promptGone(item)) return 'done';
      if (next === undefined) return this.#promptHeld(item, 'herdr', false);
      if (next === null) return this.#promptHeld(item, 'screen', false);
      current = next;
    }
  }

  /** Pole `field` (bez białych znaków) to tekst zostawiony przez Raroga: `#needsEscape` albo równe `heldLeftover`. */
  #ownsLeftover(field: string): boolean {
    return this.#needsEscape || field === this.heldLeftover;
  }

  /**
   * Poprzedni Enter z kolejki ({@link submitted}) jeszcze czeka na rozstrzygnięcie: od Entera minęło mniej niż
   * {@link PROMPT_SUBMIT_SETTLE_MS}. Po suficie rekord gaśnie; tekst oddany później łapie sprawdzenie sklejki.
   */
  submitUnsettled(): boolean {
    const submitted = this.submitted;
    if (submitted === null) return false;
    const settleMs = this.#deps.promptSubmitSettleMs ?? PROMPT_SUBMIT_SETTLE_MS;
    if (this.#scheduler.now() - submitted.at < settleMs) return true;
    this.submitted = null;
    return false;
  }

  /**
   * Pole po wklejeniu wpisu do pustego pola trzyma wcześniejszy tekst Raroga ({@link heldLeftover}) razem z wklejonym
   * albo zamiast niego ({@link gluedFieldVerdict}): werdykt bez Entera albo `null`. Sklejki Rarog nie czyści, bo pole,
   * które tylko zaczyna się albo kończy jego tekstem, może być szkicem przy Macu, i nie wkleja wiadomości drugi raz.
   */
  #gluedVerdict(item: QueuedPrompt, field: string): 'unseen' | 'changed' | null {
    if (item.mark.before !== '') return null;
    return gluedFieldVerdict(field, squashWhitespace(item.text), this.heldLeftover);
  }

  /**
   * Tekst wpisu został w polu bez Entera Raroga (odmowa strażnika) albo po Enterze, którego skutku driver nie widzi:
   * blokada hooka `UserPromptSubmit` w trakcie tury nie zostawia wpisu w pliku, a CLI oddaje tekst do pola. Następna
   * wysyłka z Raroga czyści pole tylko wtedy, gdy trzyma ono dokładnie ten tekst (`heldLeftover`); wpis `user`
   * z tą treścią w pliku gasi zgodę. Tylko przy polu pustym przed wklejeniem: inaczej w polu stoi też cudzy szkic.
   */
  #rememberOwnText(item: QueuedPrompt): void {
    if (item.mark.before === '' && item.mark.after !== null && item.mark.after !== '') {
      this.heldLeftover = item.mark.after;
    }
  }

  /**
   * Kroki 2 i 3: tożsamość panelu, świeże pole, echo (raz, przed pierwszym wklejeniem), sam tekst i czekanie, aż stoi
   * w polu. Pole z tekstem wcześniejszej wiadomości Raroga kończy wpis bez Entera ({@link #gluedVerdict}).
   *
   * @param before pole tuż przed wklejeniem (bez białych znaków)
   */
  async #pastePrompt(item: QueuedPrompt, before: string): Promise<'placed' | 'wait' | 'done'> {
    if (item.stored !== undefined && item.pastes === 0) {
      // Rule b: the file loses the text BEFORE the checks below, so none of them is stale at the paste and a restart
      // from here on gives a note, not a second paste. A failed write = no paste now; the next attempt writes again.
      const gone = await this.#deps.promptStore?.pasted(item.stored);
      if (this.#promptGone(item)) return 'done';
      if (gone !== true) return this.#promptHeld(item, 'disk', false);
    }
    const agent = await this.#samePaneAgent(item);
    if (this.#promptGone(item)) return 'done';
    if (agent !== null) return this.#promptHeld(item, agent, false);
    /*
     * Pole jeszcze raz, po `agent.get`: w tym czasie hook mógł oddać do pola tekst poprzedniej wiadomości z kolejki
     * albo człowiek przy Macu zaczął szkic. Pole inne niż przed wklejeniem = następna próba od początku, a pozostałość
     * Raroga czyści wtedy {@link #clearPromptLeftover}.
     */
    const fresh = await this.#gates.readPromptField();
    if (this.#promptGone(item)) return 'done';
    if (fresh === undefined) return this.#promptHeld(item, 'herdr', false);
    if (fresh === null) return this.#promptHeld(item, 'screen', false);
    if (fresh !== before) return this.#promptHeld(item, 'field', false);
    /*
     * Rejestr i prośba hooka jeszcze raz, tuż przed wklejeniem: odczyt ekranu i `agent.get` trwają (odczyt p90 ok.
     * 140 ms pod obciążeniem), a tekst wklejony w dialog, który zdążył stanąć, przepada, w formularzu zaś trafia w jego
     * pole wpisywania (pomiar 0a na CLI 2.1.322). Odczyt pliku rejestru kosztuje ok. 0 ms.
     */
    const late = await this.#gates.promptObstacle();
    if (this.#promptGone(item)) return 'done';
    if (late !== null) return this.#promptHeld(item, late, false);
    if (this.#sessionMoved(item) || this.#queuedGuardRefuses(item, 'paste')) return 'done';
    if (!item.echoArmed) {
      // Echo PRZED pierwszym wklejeniem: tekst wysłany Enterem przy biurku też ma zgasić wstrzymaną wiadomość.
      this.#follower?.dropEcho(item.text, item.echo, item.generation);
      item.echoArmed = true;
    }
    item.mark = { before, after: null, lost: false };
    item.pastes += 1;
    const startedAt = this.#scheduler.now();
    // Dziennik dostaje wklejenie jako `prompt` z tekstem: to treść, która poszła do panelu; Enter idzie osobnym wpisem.
    const pasted = await this.#port.send(
      () => this.#deps.client.pasteText(this.#paneId, item.text),
      promptEntry(item.text, item.source),
      'message', item.echo,
    );
    if (!pasted || this.#promptGone(item)) return 'done';
    item.pastedAt = this.#scheduler.now();
    const after = await this.#awaitPastedField(item, before, startedAt);
    if (this.#promptGone(item)) return 'done';
    if (after === 'lost') item.mark = { before, after: null, lost: true };
    if (after === null || after === 'lost') return this.#promptHeld(item, 'field', true);
    const glued = this.#gluedVerdict(item, after.field);
    if (glued !== null) return this.#promptFieldLost(item, glued);
    item.mark = { before, after: after.field, lost: false };
    this.#joinDraftEcho(item);
    return 'placed';
  }

  /**
   * The paste went onto other text in the field (a draft at the desk, which the queue never clears), so the Enter sends
   * that text in front of the message. The echo then also takes a prompt entry with exactly the field
   * after the paste, but only when that field is the text from before the paste followed by
   * the pasted text: a field joined any other way (a paste marker, a cursor moved at the desk) adds nothing.
   */
  #joinDraftEcho(item: QueuedPrompt): void {
    const { before, after } = item.mark;
    if (item.echo === undefined || before === null || before === '' || after === null) return;
    if (after !== before + squashWhitespace(item.text)) return;
    // The key comes from the message with its own whitespace: the upload path rule cuts at whitespace, and a field
    // without whitespace would lose all of it.
    this.#follower?.joinEcho(item.echo, before + item.text);
  }

  /**
   * Krok 5: Enter i księgowość jak po `agent.prompt`. Wpis schodzi z kolejki PRZED klawiszem: wpis z pliku, który
   * przyjdzie po tym Enterze, nie jest już „wysłane przy Macu” ({@link noteQueuedEcho}). Tekst zostaje zapamiętany
   * jako pozostałość Raroga ({@link #rememberOwnText}): blokada hooka w trakcie tury oddaje go do pola bez śladu
   * w pliku, a następna wiadomość dokleiłaby się do niego. Enter staje się też rekordem {@link submitted} jeszcze
   * przed klawiszem (wpis z pliku, który przyjdzie w trakcie wywołania, rozstrzyga go od razu); sufit czekania liczy
   * się od końca wywołania: during the call `at` is infinite, so the record is unsettled and has no timer.
   */
  async #submitPrompt(item: QueuedPrompt): Promise<'done'> {
    const at = this.prompts.indexOf(item);
    if (at >= 0) this.prompts.splice(at, 1);
    this.#port.beforeSubmit(item.generation);
    const pending: SubmittedPrompt = {
      text: item.mark.after ?? '', echo: item.echo, at: Number.POSITIVE_INFINITY,
      ...(item.stored !== undefined ? { stored: item.stored } : {}),
    };
    item.stored = undefined;
    this.submitted = pending;
    const sent = await this.#port.send(
      () => this.#deps.client.sendPromptSubmit(this.#paneId),
      { method: 'send_keys', keys: [PROMPT_SUBMIT_KEY] },
      'message', item.echo,
    );
    if (this.submitted === pending) this.submitted = sent ? { ...pending, at: this.#scheduler.now() } : null;
    if (this.#disposed) return 'done';
    if (sent) this.#port.afterSubmit(item.echo, item.generation);
    this.#rememberOwnText(item);
    return 'done';
  }

  /**
   * Whether a message for a Claude pane the driver does not see mid-turn still goes this queue: a fresh registry read
   * of the session says `busy` (a turn) or `waiting` (a dialog). The driver sees a turn started at the desk 1.6–2.0 s
   * after the registry turns `busy` (measured on CLI 2.1.322; the supervisor also holds a quiet → `working` change
   * for `HERDR_WORKING_GRACE_MS`), and `agent.prompt` in that window presses Enter 300 ms after typing, into a dialog
   * requested meanwhile. A dialog then holds the message, as mid-turn.
   * No port, no engine session, a read error or any other signal = `false`: the idle path is unchanged. Slash commands
   * do not ask: they stay with `agent.prompt`.
   */
  async registryInTurn(): Promise<boolean> {
    const read = this.#deps.consentRegistryRead;
    if (read === undefined || this.#agentSessionId === '') return false;
    try {
      const signal = await read(this.#agentSessionId);
      return signal.kind === 'waiting' || (signal.kind === 'active' && signal.busy === true);
    } catch {
      return false;
    }
  }

  /**
   * Drugie sprawdzenie przy Enterze później niż {@link PROMPT_SUBMIT_LATE_MS} po wklejeniu: pole dalej trzyma dokładnie
   * wklejony tekst (dialog je zakrywa), potem blokada, prośba hooka i świeży rejestr.
   */
  async #lateSubmitObstacle(item: QueuedPrompt): Promise<PromptObstacle | null> {
    const field = await this.#gates.readPromptField();
    if (this.#disposed) return null;
    if (field === undefined) return 'herdr';
    if (field === null || field !== item.mark.after) return 'field';
    return this.#gates.promptObstacle();
  }

  /**
   * Krok 3: pole z wklejonym tekstem — inne niż przed wklejeniem i niepuste. `lost` — dowód, że tekst przepadł
   * w dialogu, który już stał ({@link PasteMark}): pierwszy udany odczyt po wklejeniu, skończony najpóźniej
   * {@link PROMPT_SUBMIT_LATE_MS} od początku wklejenia, pokazał dialog albo formularz w miejscu pola. `null` — pole
   * zniknęło później, sufit {@link PROMPT_FIELD_WAIT_MS} minął albo wpis zszedł. Nieudany odczyt nie przerywa czekania.
   *
   * @param startedAt chwila tuż przed wywołaniem wklejenia (zegar drivera): wejście nie doszło do CLI wcześniej
   */
  async #awaitPastedField(
    item: QueuedPrompt, before: string, startedAt: number,
  ): Promise<{ field: string } | 'lost' | null> {
    const deadline = this.#scheduler.now() + (this.#deps.promptFieldWaitMs ?? PROMPT_FIELD_WAIT_MS);
    let first = true;
    for (;;) {
      const field = await this.#gates.readPromptField();
      if (this.#promptGone(item)) return null;
      if (field === null) return first && this.#scheduler.now() - startedAt <= PROMPT_SUBMIT_LATE_MS ? 'lost' : null;
      if (field !== undefined) {
        first = false;
        if (field !== before && field !== '') return { field };
      }
      if (this.#scheduler.now() >= deadline) return null;
      await this.#sleep(this.#deps.promptFieldPollMs ?? PROMPT_FIELD_POLL_MS);
      if (this.#promptGone(item)) return null;
    }
  }

  /**
   * Agent pod adresem panelu to dalej ta sama sesja Claude i nie stoi (`agent.get` tuż przed wklejeniem: adres panelu
   * jest pozycyjny). `null` = można wklejać.
   * The session herdr reports is compared with the item's own, not with the driver's id, which a `session-changed`
   * may have moved during an `await`.
   */
  async #samePaneAgent(item: QueuedPrompt): Promise<PromptObstacle | null> {
    try {
      const agent = await this.#deps.client.getAgent(this.#paneId);
      if (agent.engine !== 'claude' || agent.agentSessionId !== item.session) return 'agent';
      return agent.status === 'blocked' ? 'herdr' : null;
    } catch {
      return 'agent';
    }
  }

  /**
   * {@link sessionMoved} for a queue item: at the start of each attempt and right before each key (the Esc pair, the
   * paste, the Enter).
   */
  #sessionMoved(item: QueuedPrompt): boolean {
    return this.sessionMoved(item.session, item.echo);
  }

  /** Wiadomość czeka: bez Entera, na początku kolejki. Linia logu raz na wiadomość, a po wklejeniu przy każdym razie. */
  #promptHeld(item: QueuedPrompt, obstacle: PromptObstacle, afterPaste: boolean): 'wait' {
    if (afterPaste) {
      this.#log(`send: ${obstacle} after paste in pane ${this.#key}, no Enter; message stays at the head of the queue`);
    } else if (!item.holdLogged) {
      this.#log(`send: message for pane ${this.#key} waits (${obstacle})`);
    }
    item.holdLogged = true;
    return 'wait';
  }

  /**
   * Pole po wklejeniu trzyma co innego: puste (`taken` — Enter albo czyszczenie przy biurku), cudzy tekst albo sklejkę
   * z wcześniejszym tekstem Raroga (`changed`), albo jest puste, jak przed wklejeniem, albo trzyma samą pozostałość
   * Raroga, a wklejonego tekstu w nim nie widać i nie ma dowodu, że przepadł (`unseen` — mógł pójść Enterem przy Macu
   * przed pierwszym odczytem). Bez wklejenia, bez Entera i bez klawiszy. Przy `changed` wiadomość nie poszła
   * i transkrypt to mówi; przy `taken` i `unseen` echo zostaje w oknie: prompt wysłany przy biurku przyjdzie z pliku
   * rozmowy, a bez wpisu manager spłucze wiadomość po turze, po odczycie pola (`checkHeldLeftover`). Token `taken`
   * i `unseen` trafia do {@link unseen}: wiadomość mogła pójść albo nie (pole opróżnione przy biurku to Enter albo
   * czyszczenie), więc bez wpisu z pliku notka po turze mówi, że wysyłki nikt nie potwierdził.
   */
  #promptFieldLost(item: QueuedPrompt, verdict: 'taken' | 'changed' | 'unseen'): 'done' {
    if (verdict !== 'changed' && item.echo !== undefined && this.#readsHeldField) {
      this.unseen.add(item.echo);
      // The note comes after the turn; until then a restart gives the same note from the mark on disk.
      if (item.stored !== undefined) this.#unseenStored.set(item.echo, item.stored);
      item.stored = undefined;
    }
    if (verdict === 'unseen') {
      this.#log(`send: pasted text never showed in the prompt field of pane ${this.#key}; it may have gone with an Enter`
        + ' at the desk, not pasted again');
      return 'done';
    }
    this.#log(`send: prompt field in pane ${this.#key} ${verdict} after paste, no Enter`);
    if (verdict === 'changed') {
      this.#port.refuse(item.echo, STALLED_PROMPT_MESSAGE);
    }
    return 'done';
  }

  /** Tekst nie został w polu po {@link PROMPT_PASTE_ATTEMPTS} wklejeniach: wiadomość nie poszła. */
  #promptGaveUp(item: QueuedPrompt): 'done' {
    this.#log(`send: message for pane ${this.#key} not placed after ${String(item.pastes)} pastes, not sent`);
    this.#port.refuse(item.echo, STALLED_PROMPT_MESSAGE);
    return 'done';
  }

  #log(line: string): void {
    try {
      this.#deps.logger?.(line);
    } catch {
      // Log nie zatrzymuje wysyłki.
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#scheduler.setTimeout(() => { resolve(); }, ms);
    });
  }
}
