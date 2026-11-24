/**
 * The emergency approve button: whether a tool permission card in channel mode (`main`, `all`), whose dialog Rarog's
 * `PermissionRequest` hook left without a trace, may carry the "Yes" digit from the screen, and the log lines of the
 * key and of a refused key. One rule over explicit facts ({@link screenFallbackGuard}): the card gate
 * (`consentDigitBlocked` in `router.ts`, `consentOnlyEvent` in `consent-gate.ts`) and the driver's checks right before
 * the key ask the same function, and every doubt means no button. The driver module `drivers/herdr/screen-fallback.ts`
 * gathers the facts and writes the lines; the card, its proof and the key stay where they are for the `off` path.
 */
import type { CliDialogClass } from '@rarog/shared';
import type { ConsentEffectiveMode } from './layer1/mode.ts';
import { logToken } from './no-hook.ts';
import type { NoHookCause, NoHookThread } from './no-hook.ts';

/**
 * Why the button is not there, in the order the rule checks: the first that holds names the refusal. The rule's own
 * guards come first; `registry`, `screen`, `channel-card` and `always` only come from the checks at the key.
 */
export const SCREEN_FALLBACK_GUARDS = [
  'mode', 'class', 'card', 'thread', 'judgement', 'trace', 'hook', 'hook-running', 'ps', 'hook-list', 'restart',
  'registry', 'screen', 'channel-card', 'always',
] as const;
export type ScreenFallbackGuard = (typeof SCREEN_FALLBACK_GUARDS)[number];

/** What the server knows about the dialog and its session; each `null` is a doubt. */
export interface ScreenFallbackFacts {
  /** Effective consent channel mode; `null` = the mode source failed. */
  readonly mode: ConsentEffectiveMode | null;
  /** Registry class of the standing dialog; `null` = the registry does not say `waiting`. */
  readonly cliDialog: CliDialogClass | null;
  /**
   * The card of the `off` path has the approve button by its own rules (`offPathApprove`: a card the screen proves,
   * whole text, no hidden character) and stands for a `tool_use` entry of the transcript.
   */
  readonly card: boolean;
  /** Thread from the dialog title on screen; `null` = no title line to read it from. */
  readonly thread: NoHookThread | null;
  /** The dialog episode was judged past its grace without a hook trace (`drivers/herdr/consent-no-hook.ts`). */
  readonly judged: boolean;
  /** A hook trace of the session stands now; `null` = it could not be read. */
  readonly trace: boolean | null;
  /** A hook consent request of the session stands in the way of a digit (`PromptQueue.keyHookWaits`). */
  readonly hookWaits: boolean;
  /** `ps` shows the session's hook process without a registration; `null` = `ps` unavailable. */
  readonly hookRunning: boolean | null;
  /** The current content of the session's settings layers holds a foreign `PermissionRequest` hook; `null` = doubt. */
  readonly foreignHook: boolean | null;
  /** The server is within its restart grace, when the hook of a dialog from before the start may still register. */
  readonly restarting: boolean;
}

/**
 * The first guard that refuses the button, or `null` when the card may carry it. Only channel mode and the
 * `permission` class; a card the `off` path would give the button; a title that says the thread, and a subagent's
 * dialog only in `all` (the card cannot tell it from an identical call of the main thread); an episode judged without
 * a trace and nothing in the way now; no hook process in `ps`, and for a subagent `ps` must answer; no foreign hook in
 * the current settings (a settings change after the session start alone does not refuse); outside the restart grace.
 */
export function screenFallbackGuard(facts: ScreenFallbackFacts): ScreenFallbackGuard | null {
  if (facts.mode !== 'main' && facts.mode !== 'all') return 'mode';
  if (facts.cliDialog !== 'permission') return 'class';
  if (!facts.card) return 'card';
  if (facts.thread === null || (facts.thread === 'subagent' && facts.mode !== 'all')) return 'thread';
  if (!facts.judged) return 'judgement';
  if (facts.trace !== false) return 'trace';
  if (facts.hookWaits) return 'hook';
  if (facts.hookRunning === true) return 'hook-running';
  if (facts.hookRunning === null && facts.thread === 'subagent') return 'ps';
  if (facts.foreignHook !== false) return 'hook-list';
  if (facts.restarting) return 'restart';
  return null;
}

/**
 * The mark of a card that may carry the button (`ActiveReq.screenFallback`): the facts it was marked on, without the
 * mode and the registry class, which the gate reads live; the cause of the missing hook and the call for the log line.
 */
export interface ScreenFallbackMark {
  readonly facts: Omit<ScreenFallbackFacts, 'mode' | 'cliDialog'>;
  readonly cause: NoHookCause;
  /** `tool_use.id` of the transcript entry the card stands for. */
  readonly toolUseId: string;
  /** Canonical sha256 of the call input (`hook/canon.ts`): it ties a hook that registers after the key to the key. */
  readonly inputSha256: string;
  /** Start of the dialog episode, epoch ms: a hook that started before it belongs to another dialog. */
  readonly since: number;
}

/** Whether the mark still lets the card's "Yes" digit through under the live mode and registry class. */
export function screenFallbackHolds(
  mark: ScreenFallbackMark, mode: ConsentEffectiveMode | null, cliDialog: CliDialogClass | null,
): boolean {
  return screenFallbackGuard({ ...mark.facts, mode, cliDialog }) === null;
}

export interface ScreenFallbackKeyLine {
  readonly sessionId: string;
  readonly tool: string;
  readonly cause: NoHookCause;
  /** `reqId` of the card. */
  readonly card: string;
  readonly toolUseId: string | null;
}

/** `consent: screen fallback key — …`, at every digit the emergency button sent. */
export function screenFallbackKeyLine(line: ScreenFallbackKeyLine): string {
  return `consent: screen fallback key — session ${logToken(line.sessionId)}, tool ${logToken(line.tool)}, `
    + `cause ${line.cause}, card ${logToken(line.card)}, tool_use ${logToken(line.toolUseId)}`;
}

export interface ScreenFallbackRefusedLine {
  readonly sessionId: string;
  readonly tool: string;
  readonly guard: ScreenFallbackGuard;
  readonly card: string;
}

/** `consent: screen fallback refused — …`, at every tap of the button that sent no key. */
export function screenFallbackRefusedLine(line: ScreenFallbackRefusedLine): string {
  return `consent: screen fallback refused — session ${logToken(line.sessionId)}, tool ${logToken(line.tool)}, `
    + `guard ${line.guard}, card ${logToken(line.card)}`;
}
