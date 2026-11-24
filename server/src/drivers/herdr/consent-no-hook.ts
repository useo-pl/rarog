/**
 * Consent without a hook, a module of the herdr driver: it recognizes a tool permission dialog in channel mode (`main`,
 * `all`) to which Rarog's `PermissionRequest` hook left no trace within the grace {@link NO_HOOK_GRACE_MS}, gathers the
 * session facts and writes one `consent: no hook` line per dialog episode; it also writes one `consent: no approve
 * button` line per card whose approve button the channel gate took. It only reads and logs: the card, its buttons and
 * every key stay with the facade `drivers/herdr-driver.ts`. The cause rule and the line format live in
 * `herdr/dialogs/no-hook.ts`; the sources (traces, session facts, `ps`, `statusLine`) come from the server start.
 */
import type { CliDialogClass } from '@rarog/shared';
import type { Scheduler, TimerHandle } from '../runtime.ts';
import {
  consentModeNow, noApproveButtonLine, noHookCause, noHookLine, offPathApprove, subagentDialogOnScreen,
} from '../../herdr/dialogs/index.ts';
import type {
  ConsentGateSource, DecisionCard, NoHookThread, StatuslineFreshness,
} from '../../herdr/dialogs/index.ts';
import { consentChannelOpen } from '../../herdr/dialogs/hook/contract.ts';
import type { SessionFacts, SessionFactsQuery } from '../../herdr/dialogs/layer1/hook-list/session-facts.ts';
import type { ConsentProofRules } from '../../herdr/dialogs/layer1/version-gate.ts';

/**
 * The grace from the episode start: a hook trace that comes within it means the hook came. Hooks that came were measured
 * 6–528 ms after the block, and the hook process stands in `ps` 26–154 ms after the CLI registry enters `waiting`
 * (CLI 2.1.330).
 */
export const NO_HOOK_GRACE_MS = 3_000;

/**
 * Evaluations per episode, the first one included. An evaluation reads the session facts and runs `ps`; one that ends
 * without channel mode or the `permission` class goes again at the next registry signal, and a registry that flaps
 * between no answer and `waiting: permission` during the reads would otherwise cost one facts read and one `ps` per
 * flap. Past the budget the episode stays judged and gets no line.
 */
export const NO_HOOK_EVALUATIONS = 3;

/** Reads of the session facts per episode: a read that ends on another process or `cwd` gives none and goes again. */
const FACTS_READS = 2;

/** Card identities remembered for the `no approve button` line; past the cap the memory starts again. */
const BUTTONLESS_MAX = 256;

/** The sources of the facts, one set per server process (`consentNoHookSources` in `bootstrap/consent.ts`). */
export interface ConsentNoHookSources {
  /**
   * Whether any hook trace of the session stands: a registration accepted at or after `since` (ms of the epoch), a
   * channel card holding a dialog, or a request whose record is not settled: in the channel pool, as a per-call dump
   * on disk (the hook lives) or as a request marker on disk. `null` = could not read, which counts as a trace.
   */
  hookTrace(engineSessionId: string, since: number): boolean | null;
  /** The session facts without a hook dump (`createSessionFacts`); `null` = process or registry `cwd` moved. */
  facts(query: SessionFactsQuery): Promise<SessionFacts | null>;
  /** Whether `ps` shows Rarog's hook as a child of the process `pid`; `null` = `ps` unavailable. */
  hookRunning(pid: number): Promise<boolean | null>;
  /** Whether `cwd` lies outside the work area by the hook's rule; `null` = unknown. */
  outsideWorkArea(cwd: string): boolean | null;
  statusline(engineSessionId: string): Promise<StatuslineFreshness>;
  /** The proof rules of the session now; `null` = unknown. */
  proofRules(engineSessionId: string): ConsentProofRules | null;
}

/** Driver dependencies the module reads; the same fields as in the driver's deps. */
export interface ConsentNoHookDeps extends ConsentGateSource {
  readonly consentNoHook?: ConsentNoHookSources;
  readonly logger?: (line: string) => void;
  /** Clock of the epoch, the one of registrations and dumps. */
  readonly now: () => number;
}

export interface ConsentNoHookConfig {
  readonly deps: ConsentNoHookDeps;
  readonly scheduler: Scheduler;
  /** The pane is inside the work area; a pane outside it is not judged. */
  readonly inScope: boolean;
  /** The pane's `cwd`. */
  readonly cwd: string;
}

/** Driver state the module reads; times in the scheduler's clock. */
export interface ConsentNoHookPort {
  disposed(): boolean;
  agentSessionId(): string;
  /** The effective block: herdr `blocked`, the form fallback or the CLI registry hold. */
  blockedNow(): boolean;
  /** Number of the effective block. */
  blockedSeq(): number;
  /** Start of the effective block: herdr `blocked` or the entry into the CLI registry hold, whichever came first. */
  blockedAt(): number;
  /** When Rarog's own last key went to the pane. */
  answeredAt(): number;
  /** Registry class of the standing dialog; `null` = the registry does not say `waiting`. */
  cliWaiting(): CliDialogClass | null;
  /** CLI release from the last registry signal; `null` = unknown. */
  cliVersion(): string | null;
  /** Rarog's name of the pane's permission mode (`manual`, `plan`, `auto`, `bypass`); `null` = unknown. */
  permissionMode(): string | null;
  /** The last screen read. */
  screenText(): string | null;
}

/** One consent dialog episode: one dialog identity within one block, until a key, the block end or a new identity. */
interface Episode {
  readonly id: string;
  readonly sessionId: string;
  readonly blockSeq: number;
  /** The episode start and the moment the episode opened, scheduler clock. */
  readonly t0: number;
  readonly openedAt: number;
  /** End of the previous episode, epoch: the trace window of the registration starts here. */
  readonly since: number;
  callId: string | undefined;
  print: string | undefined;
  tool: string;
  screenButton: boolean;
  thread: NoHookThread;
  /** The registry said `waiting: permission` within the episode: a later `active` is a desk decision. */
  waiting: boolean;
  timer: TimerHandle | null;
  /** Evaluations begun so far, bounded by {@link NO_HOOK_EVALUATIONS}. */
  evaluations: number;
  /** `grace` within the grace, `due` past it without a judgement yet, `judged` once judged, `ended` after its end. */
  state: 'grace' | 'due' | 'judged' | 'ended';
}

let episodes = 0;

/** The call the card stands for: the jsonl entry or the hook call key; `undefined` = a card from the screen alone. */
const callIdOf = (card: DecisionCard): string | undefined =>
  card.active.origin?.toolUseId ?? card.active.callId ?? card.active.origin?.callKey;

/**
 * Whether the card shows the dialog of the episode: a card swap within one dialog (a degraded or screen card replaced
 * by the jsonl card) keeps the episode, while another call or another dialog block starts a new one.
 */
function sameDialog(episode: Episode, card: DecisionCard): boolean {
  const callId = callIdOf(card);
  if (episode.callId !== undefined && callId !== undefined && episode.callId !== callId) return false;
  const print = card.active.bodyPrint;
  return episode.print === undefined || print === undefined || episode.print === print;
}

export class ConsentNoHook {
  readonly #deps: ConsentNoHookDeps;
  readonly #scheduler: Scheduler;
  readonly #inScope: boolean;
  readonly #cwd: string;
  readonly #port: ConsentNoHookPort;
  #episode: Episode | null = null;
  /** End of the last episode, epoch; `0` before the first one (registrations of this process only). */
  #since = 0;
  /** Card identities that already have their `no approve button` line. */
  readonly #buttonless = new Set<string>();
  /** Within {@link handover}: the block changes hands, it does not end. */
  #handingOver = false;

  constructor(config: ConsentNoHookConfig, port: ConsentNoHookPort) {
    this.#deps = config.deps;
    this.#scheduler = config.scheduler;
    this.#inScope = config.inScope;
    this.#cwd = config.cwd;
    this.#port = port;
  }

  /**
   * A card for the standing dialog, before the channel gate decides whether it goes out (`#showCard`). The same dialog
   * keeps its episode; a new dialog closes the old one and opens its own that starts at the block start, or at this card
   * when an earlier episode of the same block ended. The grace timer then orders the judgement.
   */
  noteCard(card: DecisionCard): void {
    this.#observe(() => { this.#noteCard(card); });
  }

  #noteCard(card: DecisionCard): void {
    if (this.#deps.consentNoHook === undefined || !this.#inScope || this.#port.disposed()) return;
    const sessionId = this.#port.agentSessionId();
    if (sessionId === '') return;
    const current = this.#episode;
    if (current !== null && this.#stands(current) && sameDialog(current, card)) {
      this.#describe(current, card);
      return;
    }
    const now = this.#scheduler.now();
    const sameBlock = current !== null && current.blockSeq === this.#port.blockedSeq();
    // The previous dialog ended at Rarog's key after it opened, otherwise now, when another dialog replaced it; an
    // episode the block end already ended keeps that moment.
    const answeredAt = this.#port.answeredAt();
    if (current !== null) this.#end(current, answeredAt > current.openedAt ? Math.min(now, answeredAt) : now);
    episodes += 1;
    const t0 = sameBlock ? now : Math.min(now, this.#port.blockedAt());
    const episode: Episode = {
      id: `no-hook:${String(episodes)}`, sessionId, blockSeq: this.#port.blockedSeq(), t0, openedAt: now,
      since: this.#since, callId: undefined, print: undefined, tool: card.active.toolName, screenButton: false,
      thread: 'main', waiting: this.#port.cliWaiting() === 'permission', timer: null, evaluations: 0, state: 'grace',
    };
    this.#describe(episode, card);
    this.#episode = episode;
    episode.timer = this.#scheduler.setTimeout(() => {
      episode.timer = null;
      if (episode.state === 'grace') episode.state = 'due';
      this.#observe(() => { this.#judge(episode); });
    }, Math.max(0, t0 + NO_HOOK_GRACE_MS - now));
  }

  /**
   * A card that goes out: when the channel gate took its approve button (the `off` path card would have it), one
   * `consent: no approve button` line per card identity.
   */
  cardShown(card: DecisionCard, event: DecisionCard['event']): void {
    this.#observe(() => { this.#cardShown(card, event); });
  }

  #cardShown(card: DecisionCard, event: DecisionCard['event']): void {
    if (event.type !== 'permission-request' || event.canAllow !== false || !offPathApprove(card.event)) return;
    const reqId = card.active.reqId;
    if (this.#buttonless.has(reqId)) return;
    if (this.#buttonless.size >= BUTTONLESS_MAX) this.#buttonless.clear();
    this.#buttonless.add(reqId);
    const sessionId = this.#port.agentSessionId();
    const rules = this.#proofRules(sessionId);
    const thread = this.#threadOf(card);
    this.#log(noApproveButtonLine({
      sessionId, reason: event.unavailable ?? null, tool: card.active.toolName, channel: consentModeNow(this.#deps),
      rule: rules === null ? null : rules[thread === 'main' ? 'main' : 'subagents'], cli: this.#port.cliVersion(),
    }));
  }

  /**
   * A registry signal came. `closed` (the registry says `active`) after the registry said `waiting: permission` within
   * the episode is a desk decision, which ends it; an `active` before that is a read from before the dialog. Otherwise
   * an episode past its grace that waited for the `permission` class is judged now.
   */
  registrySignal(closed = false): void {
    this.#observe(() => { this.#registrySignal(closed); });
  }

  #registrySignal(closed: boolean): void {
    const episode = this.#episode;
    if (episode === null || episode.state === 'ended') return;
    if (closed && episode.waiting) {
      this.#end(episode, this.#scheduler.now());
      return;
    }
    if (this.#port.cliWaiting() === 'permission') episode.waiting = true;
    if (episode.state === 'due') this.#judge(episode);
  }

  /**
   * `drop` hands the effective block over within one block (herdr's own `blocked` follows the CLI registry
   * hold): a block end signalled while the block is between its two holders does not end the episode, which keeps its
   * start and its grace timer.
   */
  handover(drop: () => void): void {
    this.#handingOver = true;
    try {
      drop();
    } finally {
      this.#handingOver = false;
    }
  }

  /** The effective block ended: the dialog is gone or answered at the desk, so its episode ends. */
  blockEnded(): void {
    if (this.#handingOver) return;
    this.#observe(() => {
      const episode = this.#episode;
      if (episode !== null && episode.state !== 'ended') this.#end(episode, this.#scheduler.now());
    });
  }

  dispose(): void {
    const episode = this.#episode;
    this.#episode = null;
    this.#observe(() => {
      if (episode?.timer !== null && episode?.timer !== undefined) this.#scheduler.clearTimeout(episode.timer);
    });
  }

  /**
   * One step of the detector, called from the card, the poll, the registry signal and the grace timer. The detector
   * only observes, so its failure never reaches them: the episode may lose its line, the card and the block go on.
   * The evaluation past the grace that reads the facts goes on after the step returned; its failure takes the same
   * `#failed` line.
   */
  #observe(step: () => void): void {
    try {
      step();
    } catch (err: unknown) {
      this.#failed(err);
    }
  }

  /** The line of a detector failure, by the error's name only. */
  #failed(err: unknown): void {
    try {
      this.#deps.logger?.(`consent: no hook detector failed (${err instanceof Error ? err.name : typeof err})`);
    } catch {
      // The logger itself failed: nothing more to tell.
    }
  }

  /** The card's tool, the `off` path button and the thread, from the latest card of the episode. */
  #describe(episode: Episode, card: DecisionCard): void {
    episode.callId ??= callIdOf(card);
    episode.print ??= card.active.bodyPrint;
    episode.tool = card.active.toolName;
    episode.screenButton = offPathApprove(card.event);
    episode.thread = this.#threadOf(card);
  }

  /** Whether the episode still stands: same session and block, no own key since it opened, not ended. */
  #stands(episode: Episode): boolean {
    return episode.state !== 'ended' && !this.#port.disposed() && this.#port.agentSessionId() === episode.sessionId
      && this.#port.blockedNow() && this.#port.blockedSeq() === episode.blockSeq
      && this.#port.answeredAt() <= episode.openedAt;
  }

  /** Ends the episode at `at` (scheduler clock): the next episode's registration window starts there. */
  #end(episode: Episode, at: number): void {
    if (episode.timer !== null) this.#scheduler.clearTimeout(episode.timer);
    episode.timer = null;
    if (episode.state === 'ended') return;
    episode.state = 'ended';
    this.#since = Math.max(this.#since, this.#epochOf(at));
  }

  /** A scheduler time as epoch ms: the scheduler and the epoch clock differ in tests. */
  #epochOf(at: number): number {
    return this.#deps.now() - (this.#scheduler.now() - at);
  }

  /**
   * The judgement past the grace: only in channel mode, for the `permission` class from the registry and without a hook trace.
   * Without the class yet it waits for the next registry signal.
   */
  #judge(episode: Episode): void {
    const sources = this.#deps.consentNoHook;
    if (sources === undefined || this.#episode !== episode || episode.state !== 'due') return;
    if (!this.#stands(episode)) {
      this.#end(episode, this.#scheduler.now());
      return;
    }
    if (!consentChannelOpen(consentModeNow(this.#deps)) || this.#port.cliWaiting() !== 'permission') return;
    episode.state = 'judged';
    if (this.#traced(sources, episode)) return;
    episode.evaluations += 1;
    void this.#judgeFacts(sources, episode).catch((err: unknown) => { this.#failed(err); });
  }

  async #judgeFacts(sources: ConsentNoHookSources, episode: Episode): Promise<void> {
    let facts: SessionFacts | null = null;
    for (let read = 0; read < FACTS_READS && facts === null; read += 1) {
      facts = await sources.facts({ sessionId: episode.sessionId, episode: episode.id }).catch((): null => null);
    }
    const pid = facts?.process?.pid;
    const [hookRunning, statusline] = await Promise.all([
      pid === undefined ? null : sources.hookRunning(pid).catch((): null => null),
      sources.statusline(episode.sessionId).catch((): StatuslineFreshness => 'none'),
    ]);
    // The reads take time: a trace or an end (a desk decision included) that came meanwhile wins over the line, and
    // without channel mode or the `permission` class now the judgement waits for the next registry signal again, while
    // the episode has evaluations left.
    if (this.#episode !== episode || !this.#stands(episode) || this.#traced(sources, episode)) return;
    if (!consentChannelOpen(consentModeNow(this.#deps)) || this.#port.cliWaiting() !== 'permission') {
      if (episode.evaluations < NO_HOOK_EVALUATIONS) episode.state = 'due';
      return;
    }
    const layers = facts?.layers ?? null;
    this.#log(noHookLine({
      sessionId: episode.sessionId,
      cause: noHookCause({
        hookRunning, outsideWorkArea: this.#outsideWorkArea(sources, facts?.cwd ?? null),
        disableAllHooks: layers?.disableAllHooks ?? null, allowManagedHooksOnly: layers?.allowManagedHooksOnly ?? null,
        rarogEntry: layers?.rarogEntry ?? null,
      }),
      tool: episode.tool, cli: this.#port.cliVersion(), mode: this.#port.permissionMode(), thread: episode.thread,
      afterMs: this.#scheduler.now() - episode.t0, hooks: facts?.verdict ?? null, statusline,
      screenButton: episode.screenButton,
    }));
  }

  /** A trace of the hook since the previous episode; a source that throws or cannot read counts as one. */
  #traced(sources: ConsentNoHookSources, episode: Episode): boolean {
    try {
      return sources.hookTrace(episode.sessionId, episode.since) !== false;
    } catch {
      return true;
    }
  }

  /** The session `cwd` from the registry outside the work area; the pane's own `cwd` is in scope already. */
  #outsideWorkArea(sources: ConsentNoHookSources, cwd: string | null): boolean | null {
    if (cwd === null) return null;
    if (cwd === this.#cwd) return false;
    try {
      return sources.outsideWorkArea(cwd);
    } catch {
      return null;
    }
  }

  #threadOf(card: DecisionCard): NoHookThread {
    if (card.active.origin?.agentId !== undefined) return 'subagent';
    const screen = this.#port.screenText();
    return screen !== null && subagentDialogOnScreen(screen) ? 'subagent' : 'main';
  }

  #proofRules(sessionId: string): ConsentProofRules | null {
    try {
      return this.#deps.consentNoHook?.proofRules(sessionId) ?? null;
    } catch {
      return null;
    }
  }

  #log(line: string): void {
    this.#deps.logger?.(line);
  }
}
