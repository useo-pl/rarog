/**
 * The emergency approve button of a consent dialog without a hook, a module of the herdr driver: it gathers the facts
 * the rule `herdr/dialogs/screen-fallback.ts` decides on (the standing episode of `consent-no-hook.ts`, the hook trace
 * now, the thread from the dialog title, the restart grace), stamps the mark on a card, holds a card that may still get
 * it while its episode is in the grace, asks the rule again on a fresh screen right before the key and writes the key
 * and refused key lines. It sends no key and publishes no card: both stay with the facade `drivers/herdr-driver.ts`.
 * Every exception counts as a doubt, and a doubt means no button.
 */
import type { CliDialogClass } from '@rarog/shared';
import {
  consentModeNow, dialogThreadOnScreen, offPathApprove, screenFallbackGuard, screenFallbackKeyLine,
  screenFallbackRefusedLine,
} from '../../herdr/dialogs/index.ts';
import type {
  ActiveReq, ConsentGateSource, DecisionCard, NoHookThread, ScreenFallbackFacts, ScreenFallbackGuard,
  ScreenFallbackKeyLine, ScreenFallbackMark,
} from '../../herdr/dialogs/index.ts';
import { canonicalSha256 } from '../../herdr/dialogs/hook/canon.ts';
import type { ConsentScreenKey } from '../../herdr/dialogs/layer1/screen-key.ts';
import type { ConsentNoHookSources, NoHookStanding } from './consent-no-hook.ts';

/** Driver dependencies the module reads; the same fields as in the driver's deps. */
export interface ScreenFallbackDeps extends ConsentGateSource {
  readonly consentNoHook?: ConsentNoHookSources;
  readonly logger?: (line: string) => void;
  /** Clock of the epoch, the one of the key the consent cycle remembers. */
  readonly now: () => number;
}

export interface ScreenFallbackConfig {
  readonly deps: ScreenFallbackDeps;
  /** The pane is inside the work area; a pane outside it gets no card at all. */
  readonly inScope: boolean;
}

/** Driver state the module reads. */
export interface ScreenFallbackPort {
  agentSessionId(): string;
  /** Registry class of the standing dialog; `null` = the registry does not say `waiting`. */
  cliWaiting(): CliDialogClass | null;
  /** The last screen read: the one the card was built from, or the fresh read before the key. */
  screenText(): string | null;
  /** The standing episode of the no-hook detector (`ConsentNoHook.standing`). */
  standing(): NoHookStanding | null;
  /** A hook consent request of the session stands in the way of a digit (`PromptQueue.keyHookWaits`). */
  keyHookWaits(): boolean;
  /** `tool_use.id` of the transcript entry the driver holds for the waiting call now; `null` = none. */
  pendingCallId(): string | null;
}

/** The answer of the checks right before the key: the key to send, or the guard that refused it. */
export type ScreenFallbackVerdict =
  | { readonly ok: true; readonly key: ConsentScreenKey; readonly line: ScreenFallbackKeyLine }
  | { readonly ok: false; readonly guard: ScreenFallbackGuard };

/** The last card the facade asked about: the one that stands or waits. */
interface LastCard {
  readonly card: DecisionCard;
  /** The card waits for the judgement of its episode and is not published. */
  held: boolean;
}

export class ScreenFallback {
  readonly #deps: ScreenFallbackDeps;
  readonly #inScope: boolean;
  readonly #port: ScreenFallbackPort;
  #last: LastCard | null = null;
  /** The episode each mark was stamped in: a key may only answer the episode its card was judged in. */
  readonly #episodes = new WeakMap<ScreenFallbackMark, string>();

  constructor(config: ScreenFallbackConfig, port: ScreenFallbackPort) {
    this.#deps = config.deps;
    this.#inScope = config.inScope;
    this.#port = port;
  }

  /**
   * The card with the mark when the rule gives it the button now, without any mark otherwise. A card the rule does not
   * concern comes back unchanged. The card is remembered for {@link judged}.
   */
  stamp(card: DecisionCard): DecisionCard {
    const mark = this.#markOf(card);
    let stamped = card;
    if (mark !== undefined) stamped = { ...card, active: { ...card.active, screenFallback: mark } };
    else if (card.active.screenFallback !== undefined) {
      const { screenFallback: _old, ...active } = card.active;
      void _old;
      stamped = { ...card, active };
    }
    this.#last = { card: stamped, held: false };
    return stamped;
  }

  /**
   * Whether the card waits instead of going out: its episode is still in the grace (or in its first judgement) and the
   * rule could still give it the button once the judgement comes. A fact that refuses the button already (mode, card,
   * thread, class, a hook trace, the restart grace) lets the card go out at once.
   */
  waits(card: DecisionCard): boolean {
    let held = false;
    try {
      const standing = this.#port.standing();
      if (standing?.pending === true && this.#concerns(card)) {
        held = screenFallbackGuard(
          this.#factsOf(card.active, offPathApprove(card.event), this.#port.screenText(), standing, true),
        ) === null;
      }
    } catch {
      held = false;
    }
    if (this.#last?.card === card) this.#last.held = held;
    return held;
  }

  /**
   * A judgement of the standing episode began or ended: whether the facade drops the card that stands and evaluates
   * again. `true` for a card that waits, or when the button of the standing card differs from what the facts give now;
   * the evaluation then builds the card again under the same `reqId` and publishes it with or without the button.
   */
  judged(active: ActiveReq | null): boolean {
    try {
      const last = this.#last;
      if (last === null) return false;
      if (active === null) return last.held;
      if (active !== last.card.active) return false;
      return (this.#markOf(last.card) !== undefined) !== (active.screenFallback !== undefined);
    } catch {
      return false;
    }
  }

  /**
   * The rule once more right before the key, on fresh facts: the call the transcript holds as waiting now, the live
   * mode and class, the thread from the fresh screen `text`, the hook trace and the hook requests now, the judgement
   * of the same episode the card was marked in, the restart grace. Synchronous, so the facade asks it after its last
   * `await` before the key.
   */
  keyGuard(answered: ActiveReq, text: string | null): ScreenFallbackVerdict {
    const refuse = (guard: ScreenFallbackGuard): ScreenFallbackVerdict => ({ ok: false, guard });
    try {
      const mark = answered.screenFallback;
      if (mark === undefined) return refuse('card');
      // The next call with the same input can stand in the same dialog frame before its episode is noted: the card
      // then stands for a call that is no longer waiting, and the key would answer one that had no grace of its own.
      if (this.#port.pendingCallId() !== mark.toolUseId) return refuse('card');
      const standing = this.#port.standing();
      const judgement = standing?.judgement ?? null;
      if (standing === null || judgement === null || this.#episodes.get(mark) !== standing.id) {
        return refuse('judgement');
      }
      const guard = screenFallbackGuard(this.#factsOf(answered, mark.facts.card, text, standing));
      if (guard !== null) return refuse(guard);
      return {
        ok: true,
        key: { toolName: answered.toolName, inputSha256: mark.inputSha256, at: this.#deps.now(), since: mark.since },
        line: {
          sessionId: standing.sessionId, tool: answered.toolName, cause: judgement.cause, card: answered.reqId,
          toolUseId: mark.toolUseId,
        },
      };
    } catch {
      return refuse('judgement');
    }
  }

  /**
   * The guard that takes the button of a marked card under the live mode and class, the ones the card gate read when
   * it refused the digit; `mode` when the rule cannot be asked.
   */
  gateGuard(answered: ActiveReq): ScreenFallbackGuard {
    const mark = answered.screenFallback;
    if (mark === undefined) return 'card';
    try {
      return screenFallbackGuard({
        ...mark.facts, mode: consentModeNow(this.#deps), cliDialog: this.#port.cliWaiting(),
      }) ?? 'mode';
    } catch {
      return 'mode';
    }
  }

  /**
   * The digit is about to go: the consent cycle notes the key, so that a hook of this dialog whose request comes after
   * the note goes back to the terminal at once. Synchronous, right before the key: the cycle ties only a record that
   * comes after the note.
   */
  keyNoted(verdict: Extract<ScreenFallbackVerdict, { ok: true }>): void {
    try {
      this.#deps.consentNoHook?.screenKey?.(verdict.line.sessionId, { ...verdict.key, at: this.#deps.now() });
    } catch {
      // The late hook then goes the desk fallback way.
    }
  }

  /** The digit went out: the `screen fallback key` line. */
  keySent(verdict: Extract<ScreenFallbackVerdict, { ok: true }>): void {
    this.#log(screenFallbackKeyLine(verdict.line));
  }

  /** A tap of the button that sent no key: the `screen fallback refused` line. */
  refused(answered: ActiveReq, guard: ScreenFallbackGuard): void {
    this.#log(screenFallbackRefusedLine({
      sessionId: this.#port.agentSessionId(), tool: answered.toolName, guard, card: answered.reqId,
    }));
  }

  /**
   * The mark the rule gives the card now, `undefined` without one. Only a consent card for a `tool_use` entry of the
   * transcript (a card from the screen alone is tied to no call), never one with a measured consent mark (that path
   * has its own key checks), and only within an episode judged past its grace.
   */
  #markOf(card: DecisionCard): ScreenFallbackMark | undefined {
    try {
      const standing = this.#port.standing();
      const judgement = standing?.judgement ?? null;
      if (standing === null || judgement === null || !this.#concerns(card) || card.event.type !== 'permission-request') {
        return undefined;
      }
      const facts = this.#factsOf(card.active, offPathApprove(card.event), this.#port.screenText(), standing);
      const callId = card.active.callId;
      if (screenFallbackGuard(facts) !== null || callId === undefined) return undefined;
      const { mode: _mode, cliDialog: _class, ...kept } = facts;
      void _mode;
      void _class;
      const mark: ScreenFallbackMark = {
        facts: kept, cause: judgement.cause, toolUseId: callId, inputSha256: canonicalSha256(card.event.input),
        since: standing.t0,
      };
      this.#episodes.set(mark, standing.id);
      return mark;
    } catch {
      return undefined;
    }
  }

  /** A card the rule may concern: sources present, a pane in scope, a transcript entry, no measured mark. */
  #concerns(card: DecisionCard): boolean {
    return this.#deps.consentNoHook !== undefined && this.#inScope && card.active.callId !== undefined
      && card.active.measuredConsent === undefined;
  }

  /**
   * The facts of the rule for a card of the standing episode, with the mode and the class live. `hopeful` assumes that
   * the facts the judgement brings come out well and that the class still on its way is `permission` (a card that waits
   * for them). The cheap facts go first, with the trace, the hook requests and the restart grace at their most lenient:
   * when they refuse already, the full facts refuse too, so the hook trace (a read of the disk) is not read and the
   * facts that come back only name the refusal.
   */
  #factsOf(
    active: ActiveReq, card: boolean, text: string | null, standing: NoHookStanding, hopeful = false,
  ): ScreenFallbackFacts {
    const sources = this.#deps.consentNoHook;
    const judgement = standing.judgement;
    const cliDialog = this.#port.cliWaiting();
    const cheap: ScreenFallbackFacts = {
      mode: consentModeNow(this.#deps), cliDialog: hopeful ? cliDialog ?? 'permission' : cliDialog, card,
      thread: this.#threadOf(active, text), judged: hopeful || judgement !== null, trace: false, hookWaits: false,
      hookRunning: hopeful ? false : judgement?.hookRunning ?? null,
      foreignHook: hopeful ? false : judgement?.foreignHook ?? null, restarting: false,
    };
    if (screenFallbackGuard(cheap) !== null) return cheap;
    return {
      ...cheap, trace: this.#trace(sources, standing), hookWaits: this.#hookWaits(), restarting: this.#restarting(sources),
    };
  }

  /** `subagent` for a card from a subagent's dump, else the title of the dialog on screen; `null` = no title. */
  #threadOf(active: ActiveReq, text: string | null): NoHookThread | null {
    if (active.origin?.agentId !== undefined) return 'subagent';
    return text === null ? null : dialogThreadOnScreen(text);
  }

  /** A hook trace of the session since the previous episode; an exception or no answer counts as one. */
  #trace(sources: ConsentNoHookSources | undefined, standing: NoHookStanding): boolean | null {
    try {
      return sources?.hookTrace(standing.sessionId, standing.since) ?? null;
    } catch {
      return null;
    }
  }

  #hookWaits(): boolean {
    try {
      return this.#port.keyHookWaits();
    } catch {
      return true;
    }
  }

  #restarting(sources: ConsentNoHookSources | undefined): boolean {
    try {
      return sources?.restarting() ?? true;
    } catch {
      return true;
    }
  }

  #log(line: string): void {
    try {
      this.#deps.logger?.(line);
    } catch {
      // The logger itself failed: nothing more to tell.
    }
  }
}
