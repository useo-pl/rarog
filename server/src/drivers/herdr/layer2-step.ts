/**
 * Layer 2 step (`docs/dialog-card.md`, "Answer"): the one function that sends a key from a layer 2 card (a
 * digit, a key of the key row or Esc), bound to the occurrence id and sent only after the checks below, in their
 * binding order. After the key a verify read goes to the audit. It never repeats a key and never touches a newer card.
 * The facade sends the key through its client method and keeps today's cycle after it (decided shield, rearm).
 *
 * Order (each refusal sends no key):
 * 1. the occurrence is known and its card stands; the answer is one label of it (the parallel-tap lock is
 *    `PendingInteractions`);
 * 2. the flag and the engine (`layer2Off`); the pane scope is the facade's, herdr send and read-only are the socket's;
 * 3. `keyShield('dialog')` is `null`, else `hook` or `class-unknown`;
 * 4. a fresh read gives the same print and the same label with the same digit or key, else `screen-changed`;
 * 5. with no `await` up to the key: no hook registration, the same engine session, the driver alive, the card standing;
 * 6. one key; 7. `applied` ends the question by today's cycle; 8. the verify read after {@link VERIFY_AFTER_MS}.
 */
import type { CliWaitingSignal } from '../../cli-version.ts';
import type { AuditCaseShape, HerdrRefuseReason, Layer2KeyKind, Layer2VerifyOutcome } from '../../herdr/audit.ts';
import { LAYER2_CARD_TOOL } from '../../herdr/dialogs/cards/build.ts';
import type { ActiveReq } from '../../herdr/dialogs/cards/build.ts';
import {
  NO_DIGIT_MESSAGE, SCREEN_CHANGED_MESSAGE, STALE_DECISION_MESSAGE, TERMINAL_DIALOG_MESSAGE,
} from '../../herdr/dialogs/copy.ts';
import { LAYER2_CLASS_UNKNOWN, LAYER2_SESSION_MOVED, layer2Off } from '../../herdr/dialogs/layer2/card.ts';
import type { Layer2Why } from '../../herdr/dialogs/layer2/card.ts';
import { readBlock } from '../../herdr/dialogs/layer2/read-block.ts';
import type { Block } from '../../herdr/dialogs/layer2/read-block.ts';
import { layer2Verdict } from '../../herdr/dialogs/layer2/verdict.ts';
import type { Layer2Choice } from '../../herdr/dialogs/layer2/verdict.ts';
import { isKeyRowKey } from '../../herdr/dialogs/send/key-row.ts';
import type { KeyRowKey } from '../../herdr/dialogs/send/key-row.ts';
import type { OwnText } from '@rarog/shared/sentences';
import { APPLIED, STALE, refused } from '../types.ts';
import type { DecisionOutcome } from '../types.ts';
import { layer2HoldsKeys } from './layer2-card.ts';
import type { Layer2Cards, Layer2Occurrence } from './layer2-card.ts';

/**
 * Wait from the key to the verify read (`docs/dialog-card.md`, "Answer"). Measured on CLI 2.1.322: the first screen
 * change came 11–48 ms after a key and the last one by 47 ms in 24 of 26 keys, so 800 ms (the pair gap
 * `STABILITY_GAP_MS`) covers every key that stays in the dialog or closes it to the prompt. Two slower exits (384 ms
 * back to the shell, 2793 ms from Enter on the auto mode warning to the next dialog) are read as they stand at 800 ms.
 */
export const VERIFY_AFTER_MS = 800;

/** The key of one choice as the facade sends it: digits and Esc through `sendKeys`, the key row through its method. */
export type Layer2Key =
  | { readonly via: 'keys'; readonly keys: readonly [string] }
  | { readonly via: 'key-row'; readonly key: KeyRowKey };

/** An audit line of the step: the key (`approve`), a refusal or the verify read. */
export interface Layer2StepEntry extends AuditCaseShape {
  readonly method: 'approve' | 'refuse' | 'layer2-verify';
  readonly toolName: string;
  readonly keys?: readonly string[];
  readonly optionLabel?: string;
  readonly reason?: HerdrRefuseReason;
}

/** What the step needs from the driver facade. */
export interface Layer2StepPort {
  /** The driver is alive and the pane blocked. */
  live(): boolean;
  /** The driver was disposed (its data directory may be gone); the pane state does not count. */
  disposed(): boolean;
  /** The send shield of the prompt queue for class `dialog` (`PromptQueue.keyShield`). */
  keyShield(): Promise<'hook' | 'registry' | null>;
  /** Whether a hook consent request of the session waits (`PromptQueue.keyHookWaits`); synchronous. */
  keyHookWaits(): boolean;
  /** Engine session of the pane now. */
  engineSession(): string;
  /** A fresh screen read past the cache; `null` = the read failed. */
  readFresh(): Promise<string | null>;
  /**
   * Sends the one key and writes `entry` as its `approve` line; on success keeps today's cycle (decided shield,
   * rearm). The client call starts before the first `await`. `false` = herdr refused the call, no key went.
   * `denied`: the key came from a `deny`, which has no answer call in the manager to settle the card, so right after
   * the key the facade reports the card gone if it still stands, as for any card that stops standing.
   */
  sendKey(key: Layer2Key, entry: Layer2StepEntry, denied: boolean): Promise<boolean>;
  audit(entry: Layer2StepEntry): void;
  /** A sentence to the session transcript. */
  system(text: OwnText): void;
  /** Evaluates the screen again: a card the screen no longer shows gets replaced by the normal evaluation. */
  reevaluate(): void;
  sleep(ms: number): Promise<void>;
  enqueue<T>(step: () => Promise<T>): Promise<T | undefined>;
  /** A server log line (English, without screen text). */
  warn(line: string): void;
}

export interface Layer2StepConfig {
  /** Flag `RAROG_DIALOG_LAYER2`. */
  readonly enabled: boolean;
  /** Engine of the pane (`HerdrAgent.engine`). */
  readonly engine: string;
  /** Pane key for log lines. */
  readonly key: string;
  readonly cards: Pick<Layer2Cards, 'occurrence' | 'keySent' | 'issued'>;
  /** Registry read of an engine session (`HerdrDriverDeps.consentRegistryRead`); without it the verify is `unknown`. */
  readonly registryRead?: (engineSessionId: string) => Promise<CliWaitingSignal>;
  /** Default {@link VERIFY_AFTER_MS}; tests pass their own. */
  readonly verifyAfterMs?: number;
}

/** What a tap asks for: a label of the card, or Esc (`deny` over the card). */
type Tap = { readonly label: string } | { readonly escape: true };

/**
 * What a `deny` is bound to when the driver accepts it, before its queue step ({@link Layer2Step.bindEscape}): the
 * layer 2 occurrence standing then (`null` = none) and the number of occurrences issued by then.
 */
export interface Layer2EscapeBinding {
  readonly id: string | null;
  readonly issued: number;
}

/** What the verify read compares against: the block the key went to. */
export interface Before {
  readonly print: string;
  readonly rows: string;
}

const sameSend = (a: Layer2Choice['send'], b: Layer2Choice['send']): boolean => (
  'digit' in a ? 'digit' in b && a.digit === b.digit : 'key' in b && a.key === b.key);

const rowsOf = (block: Block): string => block.rows.map((row) => row.text).join('\n');

/** The choice a tap means on an occurrence; `null` = the card has no such choice. */
function choiceOf(occurrence: Layer2Occurrence, tap: Tap): Layer2Choice | null {
  if ('escape' in tap) {
    return occurrence.choices.find((choice) => 'key' in choice.send && choice.send.key === 'escape') ?? null;
  }
  return occurrence.choices.find((choice) => choice.label === tap.label) ?? null;
}

/** The key of a choice and its kind for the audit. */
function keyOf(send: Layer2Choice['send']): { key: Layer2Key; kind: Layer2KeyKind } {
  if ('digit' in send) return { key: { via: 'keys', keys: [String(send.digit)] }, kind: 'digit' };
  if (isKeyRowKey(send.key)) return { key: { via: 'key-row', key: send.key }, kind: 'key' };
  return { key: { via: 'keys', keys: [send.key] }, kind: 'escape' };
}

/**
 * What the verify read saw (`docs/dialog-card.md`, "Answer"): the class from the registry, the block from the screen.
 * A failed read on either side is `unknown`.
 */
export function verifyOutcome(
  before: Before, text: string | null, signal: CliWaitingSignal | null,
): Layer2VerifyOutcome {
  if (text === null || signal === null || signal.kind === 'unknown') return 'unknown';
  if (signal.kind !== 'waiting') return 'gone';
  if (signal.dialog !== 'dialog') return 'other-dialog';
  const block = readBlock(text);
  if (block === null) return 'gone';
  if (block.print !== before.print) return 'changed';
  return rowsOf(block) === before.rows ? 'same' : 'highlight';
}

export class Layer2Step {
  readonly #config: Layer2StepConfig;
  readonly #port: Layer2StepPort;

  constructor(config: Layer2StepConfig, port: Layer2StepPort) {
    this.#config = config;
    this.#port = port;
  }

  /** A tap on a choice of the card `id`: exactly one label, in the driver queue. */
  async answer(id: string, answers: readonly (readonly string[])[]): Promise<DecisionOutcome> {
    const outcome = await this.#port.enqueue(() => {
      const group = answers.length === 1 ? answers[0] : undefined;
      const label = group?.length === 1 ? group[0] : undefined;
      if (label !== undefined) return this.#run(id, { label });
      // An expired question comes with empty groups (`expireSession`): no key and no sentence.
      const empty = answers.every((group) => group.length === 0);
      return Promise.resolve(this.#refuse(id, 'no-digit', null, empty ? null : NO_DIGIT_MESSAGE));
    });
    return outcome ?? STALE;
  }

  /** Esc over the card `id` (`deny`), called inside the driver queue step of the decision. */
  escape(id: string): Promise<DecisionOutcome> {
    return this.#run(id, { escape: true });
  }

  /**
   * Binds a `deny` to the card that stands when the driver accepts it, synchronously and before the driver queue: the
   * same occurrence then holds for a tap on a label and for a second `deny`, and the first key ends it for both.
   */
  bindEscape(active: Pick<ActiveReq, 'reqId' | 'layer2Card'> | null): Layer2EscapeBinding {
    const id = active !== null && layer2HoldsKeys(active) ? active.reqId : null;
    return { id, issued: this.#config.cards.issued() };
  }

  /**
   * A bound `deny` inside its driver queue step: over a layer 2 occurrence only through the step with that id, so an
   * answered or replaced one ends without a key, never through today's Esc. A `deny` accepted before a layer 2 card
   * was issued sends no key once one has been (`stale-card`), also when that card is gone again: it was decided over
   * another screen. `null` = no layer 2 card at acceptance or since: today's Esc path.
   */
  escapeBound(binding: Layer2EscapeBinding): Promise<DecisionOutcome> | null {
    if (binding.id !== null) return this.escape(binding.id);
    if (this.#config.cards.issued() === binding.issued) return null;
    return Promise.resolve(this.#refuse(null, 'stale-card', 'stale-card', STALE_DECISION_MESSAGE));
  }

  async #run(id: string, tap: Tap): Promise<DecisionOutcome> {
    const port = this.#port;
    // 1. The occurrence stands, and the tap means one of its choices.
    const occurrence = this.#config.cards.occurrence(id);
    if (occurrence === null) return this.#stale(id);
    const choice = choiceOf(occurrence, tap);
    if (choice === null) {
      return 'escape' in tap
        ? this.#refuse(id, 'terminal-only', null, TERMINAL_DIALOG_MESSAGE)
        : this.#refuse(id, 'no-digit', null, NO_DIGIT_MESSAGE);
    }
    // 2. Today's driver gates: the flag and the engine.
    const off = layer2Off(this.#config);
    if (off !== null) return this.#refuse(id, 'terminal-only', off, TERMINAL_DIALOG_MESSAGE);
    if (!port.live()) return this.#stale(id);
    // 3. The send shield: no hook consent request, and the registry says `waiting` with class `dialog`.
    const shield = await port.keyShield();
    if (shield !== null) return this.#changed(id, shield === 'hook' ? 'hook' : LAYER2_CLASS_UNKNOWN);
    // 4. A fresh read: the same block, and the label with the same digit or key.
    const text = await port.readFresh();
    const block = text === null ? null : readBlock(text);
    const verdict = block === null ? null : layer2Verdict(block, 'dialog');
    const fresh = verdict?.kind === 'choices' && verdict.print === occurrence.print
      ? verdict.choices.find((item) => item.label === choice.label) : undefined;
    if (block === null || fresh === undefined || !sameSend(fresh.send, choice.send)) {
      return this.#changed(id, 'screen-changed');
    }
    // 5. No `await` from here to the key.
    if (port.keyHookWaits()) return this.#changed(id, 'hook');
    if (port.engineSession() !== occurrence.engineSession) return this.#changed(id, LAYER2_SESSION_MOVED);
    if (!port.live() || this.#config.cards.occurrence(id) === null) return this.#stale(id);
    // 6. One key.
    const { key, kind } = keyOf(choice.send);
    const keys = key.via === 'keys' ? key.keys : [key.key];
    const sent = await port.sendKey(key, {
      method: 'approve', keys, toolName: LAYER2_CARD_TOOL, optionLabel: choice.label, reqId: id, source: 'screen',
      layer2: true, layer2Key: kind,
    }, 'escape' in tap);
    if (!sent) return this.#refuse(id, 'send-failed', null, null);
    // 7. Answered: the card is gone with today's cycle (the manager settles a tap, the facade a `deny`), its block hidden
    //    for the decided shield.
    this.#config.cards.keySent(occurrence);
    // 8. The verify read, outside the queue: it writes the audit and nothing else.
    void this.#verify(occurrence, kind, { print: occurrence.print, rows: rowsOf(block) });
    return APPLIED;
  }

  async #verify(occurrence: Layer2Occurrence, kind: Layer2KeyKind, before: Before): Promise<void> {
    await this.#port.sleep(this.#config.verifyAfterMs ?? VERIFY_AFTER_MS);
    const text = await this.#port.readFresh();
    let signal: CliWaitingSignal | null = null;
    try {
      signal = await this.#config.registryRead?.(occurrence.engineSession) ?? null;
    } catch {
      signal = null;
    }
    // A driver disposed during the wait writes nothing: its data directory may already be gone. A pane that left the
    // dialog after the key is the expected outcome (`gone`) and still gets its line.
    if (this.#port.disposed()) return;
    const outcome = verifyOutcome(before, text, signal);
    if (outcome === 'other-dialog') {
      this.#port.warn(`layer2: pane ${this.#config.key}: another dialog class after the key of ${occurrence.id}`);
    }
    this.#port.audit({
      method: 'layer2-verify', toolName: LAYER2_CARD_TOOL, reqId: occurrence.id, layer2: true, layer2Key: kind,
      layer2Outcome: outcome,
    });
  }

  /** The card is no longer the one on the screen: no key, no sentence; the question expires (410). */
  #stale(id: string): DecisionOutcome {
    this.#audit(id, 'stale-card', 'stale-card');
    return STALE;
  }

  /** The screen, the hook or the CLI session changed under the card: no key, the card stays until evaluated again. */
  #changed(id: string, why: Layer2Why): DecisionOutcome {
    this.#audit(id, 'screen-changed', why);
    this.#port.system(SCREEN_CHANGED_MESSAGE);
    this.#port.reevaluate();
    return refused('screen-changed');
  }

  /** `id` `null` = a `deny` bound to no occurrence. */
  #refuse(
    id: string | null, reason: HerdrRefuseReason, why: Layer2Why | null, message: OwnText | null,
  ): DecisionOutcome {
    this.#audit(id, reason, why);
    if (message !== null) this.#port.system(message);
    return refused(reason);
  }

  #audit(id: string | null, reason: HerdrRefuseReason, why: Layer2Why | null): void {
    this.#port.audit({
      method: 'refuse', reason, toolName: LAYER2_CARD_TOOL, layer2: true,
      ...(id === null ? {} : { reqId: id }),
      ...(why === null ? {} : { layer2Why: why }),
    });
  }
}
