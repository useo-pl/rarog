/**
 * Layer 2 card on the driver (`docs/dialog-card.md`): where today's card has no buttons, a block with choices in
 * two equal reads becomes a question card under an occurrence id `l2:<12 hex>`; the module also writes the episode
 * audit line and, after a key, hides the answered block for the decided shield. It sends no key and decides no answer
 * (the layer 2 step does, `layer2-step.ts`); pure rules stay in `herdr/dialogs/layer2/`, here only state and timing.
 */
import { randomBytes } from 'node:crypto';
import type { CliDialogClass } from '@rarog/shared';
import type { AuditCaseShape } from '../../herdr/audit.ts';
import { layer2QuestionCard } from '../../herdr/dialogs/cards/build.ts';
import { DECIDED_SHIELD_MS } from '../../herdr/dialogs/timing.ts';
import type { ActiveReq } from '../../herdr/dialogs/cards/build.ts';
import type { DecideAction } from '../../herdr/dialogs/decide/input.ts';
import {
  LAYER2_NO_BLOCK, LAYER2_UNSTABLE, blockTitleSha, episodeVerdictOf, layer2Gate,
} from '../../herdr/dialogs/layer2/card.ts';
import type { Layer2Context, Layer2EpisodeVerdict, Layer2Why } from '../../herdr/dialogs/layer2/card.ts';
import { readBlock } from '../../herdr/dialogs/layer2/read-block.ts';
import type { Block } from '../../herdr/dialogs/layer2/read-block.ts';
import {
  INITIAL_STABILITY, STABILITY_ATTEMPTS, STABILITY_GAP_MS, observeStability,
} from '../../herdr/dialogs/layer2/stability.ts';
import type { StabilityScope, StabilityState } from '../../herdr/dialogs/layer2/stability.ts';
import type { Layer2Choice, Layer2Verdict } from '../../herdr/dialogs/layer2/verdict.ts';

/** Prefix of a layer 2 occurrence id. */
export const LAYER2_ID_PREFIX = 'l2:';

/** Whether a card id is a layer 2 occurrence id. */
export const isLayer2Id = (reqId: string): boolean => reqId.startsWith(LAYER2_ID_PREFIX);

/**
 * Whether the standing card takes keys only through the layer 2 step (`docs/dialog-card.md`, "Answer"): `allow`
 * refuses, and a `deny` accepted over it is bound to its occurrence id before the driver queue (`Layer2Step.bindEscape`).
 */
export function layer2HoldsKeys(active: Pick<ActiveReq, 'layer2Card'> | null): boolean {
  return active?.layer2Card !== undefined;
}

/**
 * Most rounds of one settle: the first read plus forced reads. A round that does not count as an attempt (a read too
 * early for the gap) must not loop forever on a stopped clock.
 */
const MAX_ROUNDS = STABILITY_ATTEMPTS * 3;

/**
 * Start scope of a screen copy from the driver's cache ({@link Layer2Cards.scopeBeforeRead}): the read that made it
 * began at an unknown point, maybe in another scope, so the stability machine sees the copy as a read across
 * a scope change and starts no pair with it. Pair scopes count from 1, so this one matches none.
 */
const UNKNOWN_START: StabilityScope = { kind: 'blocked', seq: 0 };

type CardAction = Extract<DecideAction, { kind: 'card' | 'screen-dialog' }>;
type ChoicesVerdict = Extract<Layer2Verdict, { kind: 'choices' }>;

/** Verdict of the registry fallback over a pane herdr does not report blocked (`CliReserve.unblockedVerdict`). */
export type FallbackVerdict = 'blocked' | 'wait' | 'none';

/** One issued layer 2 card: what a tap on it may send, and what must still hold before it. */
export interface Layer2Occurrence {
  /** `l2:<12 hex>`, random: the same dialog in two sessions or reopened later gets another id. */
  readonly id: string;
  /** Engine session (CLI conversation) at issue; another one ends the occurrence. */
  readonly engineSession: string;
  /** Registry `waiting` episode at issue; another one (the dialog closed and opened again) ends the occurrence. */
  readonly cliEpisode: number;
  /** Print of the block (`Block.print`) the choices came from. */
  readonly print: string;
  /** Literal label → digit or key, in screen order. */
  readonly choices: readonly Layer2Choice[];
  /** Driver clock at issue. */
  readonly issuedAt: number;
}

/** What the module needs from the driver facade. */
export interface Layer2CardPort {
  /** Class of the standing dialog from the CLI registry; `null` = the registry does not say `waiting`. */
  cliClass(): CliDialogClass | null;
  /** Number of the registry `waiting` episode (`CliReserve.cliEpisode`); it restarts with the server. */
  cliEpisode(): number;
  /** Whether the registry fallback holds the dialog (`CliReserve.cliHold`). */
  cliHold(): boolean;
  /** Engine session of the pane. */
  engineSession(): string;
  /** `reqId` of the card standing on the phone; `null` = none. */
  activeReqId(): string | null;
  /** Number of the current herdr lock; with the registry episode and the engine session, the scope of a pair. */
  blockedSeq(): number;
  /** A fresh screen read past the cache; `null` = the read failed. */
  readFresh(): Promise<string | null>;
  /** Whether a screen read without `force` would now return the screen cache instead of reading. */
  screenCached(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Whether the evaluation may still act: the driver is alive and the pane blocked. */
  live(): boolean;
  /** Writes one `layer2-episode` audit line. */
  audit(fields: Layer2EpisodeFields): void;
}

/** Fields of a `layer2-episode` audit line. */
export type Layer2EpisodeFields = Required<Pick<AuditCaseShape, 'episode' | 'layer2Verdict'>>
  & Pick<AuditCaseShape, 'layer2Why' | 'blockTitleSha' | 'optionCount'>;

export interface Layer2CardConfig {
  /** Flag `RAROG_DIALOG_LAYER2`; `false` = the module passes every action through and writes nothing. */
  readonly enabled: boolean;
  /** Engine of the pane (`HerdrAgent.engine`). */
  readonly engine: string;
  /** Occurrence id source; tests pass their own. */
  readonly newId?: () => string;
  /** Episode prefix unique per driver instance (a restart gives a new one); tests pass their own. */
  readonly nonce?: string;
  /** How long the block a key went to stays hidden ({@link Layer2Cards.keySent}); default `DECIDED_SHIELD_MS`. */
  readonly shieldMs?: number;
}

/** The block a key went to: its print within one registry episode and engine session, and when. */
interface Answered {
  readonly print: string;
  readonly cliEpisode: number;
  readonly engineSession: string;
  readonly at: number;
}

/** Today's decision over a newer screen of the same evaluation. */
export interface Layer2Decide {
  /** With the card that stands on the phone, as the driver decides. */
  now(text: string | null): DecideAction;
  /**
   * As if no card stood and no own answer went in this lock: what today's card over this screen is (a standing card,
   * or the window after an own key, hides it behind `keep`). Layer 2 issues a card from it only after a stable pair.
   */
  withoutCard(text: string | null): DecideAction;
}

/** What layer 2 does with today's action over one block. */
export type Layer2Judgement =
  | { readonly kind: 'existing' }
  | { readonly kind: 'none'; readonly why: Layer2Why }
  | { readonly kind: 'choices'; readonly verdict: ChoicesVerdict };

/**
 * Whether today's card has a button: a known screen dialog (model, trust, confirmation), an option without
 * `terminalOnly`, the trust step without digits or a consent card with its call. Layer 2 never takes these.
 */
export function todayHasButtons(action: CardAction): boolean {
  if (action.kind === 'screen-dialog') return (action.resolved?.knownDialog ?? null) !== null;
  const { active, event } = action.card;
  if (active.trustArrow !== undefined || active.options.some((option) => option.terminalOnly !== true)) return true;
  return event.type === 'permission-request' && event.input !== null;
}

/** Layer 2 over today's action and one block, without timing: the rule the golden file of flag `1` records. */
export function judgeLayer2(action: CardAction, block: Block | null, context: Layer2Context): Layer2Judgement {
  if (todayHasButtons(action)) return { kind: 'existing' };
  const verdict = layer2Gate(block, context);
  return verdict.kind === 'none' ? { kind: 'none', why: verdict.why } : { kind: 'choices', verdict };
}

const KEEP: DecideAction = { kind: 'keep', touchSeq: false };
const KEEP_TOUCH: DecideAction = { kind: 'keep', touchSeq: true };

/** Today's card with the layer 2 trace `unstable`: the reason goes to its `block-card` line. */
function withUnstable(action: CardAction, print: string): CardAction {
  const mark = { why: LAYER2_UNSTABLE, print };
  if (action.kind === 'screen-dialog') return { ...action, layer2: mark };
  return { ...action, card: { ...action.card, active: { ...action.card.active, layer2: mark } } };
}

export class Layer2Cards {
  readonly #config: Layer2CardConfig;
  readonly #port: Layer2CardPort;
  readonly #nonce: string;
  #occurrence: Layer2Occurrence | null = null;
  /** Occurrences issued so far ({@link issued}). */
  #issued = 0;
  /** The decided shield of the last key ({@link keySent}); `null` = none. */
  #answered: Answered | null = null;
  #stability: StabilityState = INITIAL_STABILITY;
  /** Real reads observed by the stability machine; each one gets the next number. */
  #gen = 0;
  /** Lock, registry episode and engine session of the current pair scope ({@link #scope}). */
  #scopeKey = '';
  /** Number of the pair scope: grows whenever {@link #scopeKey} changes. */
  #scopeSeq = 0;
  /** Last episode line written, as its JSON: a refresh with the same fields writes nothing. */
  #lastLine = '';
  /** Episode of the last line written: an evaluation without a screen does not overwrite it ({@link noteFallback}). */
  #lastEpisode = '';

  constructor(config: Layer2CardConfig, port: Layer2CardPort) {
    this.#config = config;
    this.#port = port;
    this.#nonce = config.nonce ?? randomBytes(4).toString('hex');
  }

  /**
   * The standing occurrence with this id; `null` = unknown, answered or replaced (stale tap), or ended: its card is
   * gone, or the registry reports another episode or the pane another engine session ({@link #dropEnded}).
   */
  occurrence(id: string): Layer2Occurrence | null {
    this.#dropEnded();
    return this.#occurrence?.id === id ? this.#occurrence : null;
  }

  /**
   * How many occurrences this driver has issued: a decision accepted before the last issue was taken over another
   * screen than the card that stands or stood since (`Layer2Step.bindEscape`).
   */
  issued(): number {
    return this.#issued;
  }

  /**
   * A key went to `answered`: the occurrence ends, and its block stays hidden for the decided shield. The same print
   * in the same registry episode and engine session gives no card until the shield ends (a read before the repaint,
   * or a key the dialog ignored: the server never repeats it). The key also ends the pair the card came from, so any
   * block, the same one after the shield included, gets its next card only after a new pair of reads.
   */
  keySent(answered: Layer2Occurrence): void {
    this.#answered = {
      print: answered.print, cliEpisode: answered.cliEpisode, engineSession: answered.engineSession,
      at: this.#port.now(),
    };
    this.#stability = INITIAL_STABILITY;
    if (this.#occurrence?.id === answered.id) this.#occurrence = null;
  }

  /**
   * Today's action after layer 2. A card without buttons over a block with choices waits for a second, forced read
   * at least `STABILITY_GAP_MS` later; two equal prints give the layer 2 card, `STABILITY_ATTEMPTS` misses give today's
   * card with the reason `unstable`. A standing occurrence over the same block stays (`keep`), also over a read
   * without a block (a repaint) and over a new herdr lock; another registry episode or engine session ends it
   * ({@link #dropEnded}). Today's card that already stands (`keep`) is judged as it would be shown without it
   * ({@link Layer2Decide.withoutCard}): the CLI class may arrive after the card. `scopeAtRead` is the scope taken
   * right before the read that gave `text` ({@link scopeBeforeRead}): a read across a scope change starts no pair.
   */
  async settle(
    action: DecideAction, text: string | null, decide: Layer2Decide, scopeAtRead: StabilityScope,
  ): Promise<DecideAction> {
    if (!this.#config.enabled) return action;
    let current = action;
    let screen = text;
    let scopeAtStart = scopeAtRead;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      this.#dropEnded();
      const judgedAction = this.#judgedAction(current, screen, decide);
      if (judgedAction === null) return current;
      const block = screen === null ? null : readBlock(screen);
      const judged = judgeLayer2(judgedAction, block, this.#context());
      if (judged.kind === 'existing') {
        this.#note('existing', null, block);
        return current;
      }
      if (judged.kind === 'none') {
        if (judged.why === LAYER2_NO_BLOCK && this.#occurrence !== null) return KEEP;
        this.#observe(null, round > 0, scopeAtStart);
        this.#note('none', judged.why, block);
        return current;
      }
      const { verdict } = judged;
      if (this.#shielded(verdict.print)) {
        this.#note(episodeVerdictOf(verdict), null, block);
        return KEEP;
      }
      if (this.#occurrence?.print === verdict.print) {
        this.#note(episodeVerdictOf(verdict), null, block);
        return KEEP_TOUCH;
      }
      this.#observe(verdict.print, round > 0, scopeAtStart);
      if (this.#stability.verdict === 'stable') return this.#issue(verdict, block);
      // Neither stable nor pending: the attempts of this scope are used up.
      if (this.#stability.verdict !== 'pending') return this.#unstable(current, verdict.print, block);
      await this.#port.sleep(STABILITY_GAP_MS);
      if (!this.#port.live()) return KEEP;
      scopeAtStart = this.#scope();
      screen = await this.#port.readFresh();
      if (!this.#port.live()) return KEEP;
      current = decide.now(screen);
    }
    const block = screen === null ? null : readBlock(screen);
    return this.#unstable(current, block?.print ?? '', block);
  }

  /**
   * The registry fallback ends the evaluation before {@link settle}, without a screen for layer 2: `none` (the prompt
   * field instead of a dialog, a failed read, no probe left) or `wait` while it holds the dialog (a failed read, the
   * prompt field not yet confirmed). `wait` outside a hold means the premises changed during the read, and the change
   * brings its own evaluation. An episode of a registry `waiting` of class `dialog` without a line yet gets one with
   * the verdict of the gate over no block (`none`, `no-block` in a Claude Code pane), so the audit counts it; a later
   * evaluation that reaches `settle` refreshes the same episode.
   */
  noteFallback(verdict: FallbackVerdict): void {
    if (verdict === 'blocked' || (verdict === 'wait' && !this.#port.cliHold())) return;
    if (!this.#config.enabled || this.#lastEpisode === this.#episode()) return;
    const gate = layer2Gate(null, this.#context());
    if (gate.kind === 'none') this.#note('none', gate.why, null);
  }

  /**
   * Scope of the read whose screen the driver hands to {@link settle}, taken right before that read: both reads of
   * a pair began and ended in one scope. A read without `force` that the screen cache answers gets
   * {@link UNKNOWN_START}: its source read began before, maybe in another scope, so it is never the first of a pair.
   */
  scopeBeforeRead(force: boolean): StabilityScope {
    return !force && this.#port.screenCached() ? UNKNOWN_START : this.#scope();
  }

  /** The action layer 2 judges: today's card, or the card a standing one hides; `null` = nothing to judge. */
  #judgedAction(current: DecideAction, screen: string | null, decide: Layer2Decide): CardAction | null {
    if (current.kind === 'card' || current.kind === 'screen-dialog') return current;
    if (current.kind !== 'keep' || this.#occurrence !== null || this.#port.cliClass() !== 'dialog') return null;
    const hidden = decide.withoutCard(screen);
    return hidden.kind === 'card' || hidden.kind === 'screen-dialog' ? hidden : null;
  }

  /** Whether the decided shield of the last key hides this print now; an expired shield ends here. */
  #shielded(print: string): boolean {
    const answered = this.#answered;
    if (answered === null) return false;
    if (this.#port.now() - answered.at >= (this.#config.shieldMs ?? DECIDED_SHIELD_MS)) {
      this.#answered = null;
      return false;
    }
    return answered.print === print && answered.cliEpisode === this.#port.cliEpisode()
      && answered.engineSession === this.#port.engineSession();
  }

  #context(): Layer2Context {
    return { enabled: this.#config.enabled, engine: this.#config.engine, cliClass: this.#port.cliClass() };
  }

  /**
   * Ends the occurrence that no longer holds: its card is gone, or the registry reports another episode (the dialog
   * closed and opened again, also under the same herdr lock) or the pane runs another engine session.
   */
  #dropEnded(): void {
    const standing = this.#occurrence;
    if (standing === null) return;
    if (this.#port.activeReqId() !== standing.id || this.#port.cliEpisode() !== standing.cliEpisode
      || this.#port.engineSession() !== standing.engineSession) this.#occurrence = null;
  }

  /**
   * Scope of a pair of reads: one herdr lock within one registry episode and one engine session. A dialog reopened
   * under the same lock or another engine session starts a new pair, and `unstable` lasts only to the end of the scope;
   * the stability machine compares the number alone.
   */
  #scope(): StabilityScope {
    const key = [this.#port.blockedSeq(), this.#port.cliEpisode(), this.#port.engineSession()].join('|');
    if (key !== this.#scopeKey) {
      this.#scopeKey = key;
      this.#scopeSeq += 1;
    }
    return { kind: 'blocked', seq: this.#scopeSeq };
  }

  /** One read for the stability machine: the evaluation's own read first, then forced reads. */
  #observe(print: string | null, forced: boolean, scopeAtStart: StabilityScope): void {
    this.#gen += 1;
    this.#stability = observeStability(this.#stability, {
      gen: this.#gen,
      scopeAtStart,
      scopeAtEnd: this.#scope(),
      endedAt: this.#port.now(),
      print,
      forced,
    });
  }

  #issue(verdict: ChoicesVerdict, block: Block | null): DecideAction {
    const id = this.#config.newId?.() ?? `${LAYER2_ID_PREFIX}${randomBytes(6).toString('hex')}`;
    this.#issued += 1;
    this.#occurrence = {
      id, engineSession: this.#port.engineSession(), cliEpisode: this.#port.cliEpisode(), print: verdict.print,
      choices: verdict.choices, issuedAt: this.#port.now(),
    };
    this.#note(episodeVerdictOf(verdict), null, block);
    return { kind: 'card', card: layer2QuestionCard(id, verdict, this.#port.blockedSeq()), audit: null };
  }

  /** Today's action with the reason `unstable`; a card that already stands keeps standing as it is. */
  #unstable(action: DecideAction, print: string, block: Block | null): DecideAction {
    this.#note('none', LAYER2_UNSTABLE, block);
    if (action.kind !== 'card' && action.kind !== 'screen-dialog') return action;
    return print === '' ? action : withUnstable(action, print);
  }

  /** Episode key of the audit line: the instance nonce keeps it unique across server restarts. */
  #episode(): string {
    return `${this.#nonce}-${String(this.#port.cliEpisode())}`;
  }

  /** The episode line, only for a `waiting` of class `dialog` and only when its fields changed. */
  #note(verdict: Layer2EpisodeVerdict, why: Layer2Why | null, block: Block | null): void {
    if (this.#port.cliClass() !== 'dialog') return;
    const fields: Layer2EpisodeFields = {
      episode: this.#episode(),
      layer2Verdict: verdict,
      ...(why === null ? {} : { layer2Why: why }),
      ...(block === null ? {} : { blockTitleSha: blockTitleSha(block.title), optionCount: block.options.length }),
    };
    const line = JSON.stringify(fields);
    if (line === this.#lastLine) return;
    this.#lastLine = line;
    this.#lastEpisode = fields.episode;
    this.#port.audit(fields);
  }
}
