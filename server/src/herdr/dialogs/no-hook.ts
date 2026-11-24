/**
 * Consent without a hook: the cause why a tool permission dialog in channel mode got no trace of Rarog's
 * `PermissionRequest` hook, the two log lines that name it, and whether the card of the `off` path would carry the
 * approve button. Pure functions over explicit arguments: the driver module `drivers/herdr/consent-no-hook.ts` gathers
 * the facts and writes the lines. Nothing here gives or takes a button; the card stays as the decision built it.
 */
import { cardShowsAll } from '../../drivers/tool-text.ts';
import type { DecisionCard } from './cards/build.ts';
import { hookListWhyCode } from './layer1/hook-list/hook-list.ts';
import type { HookListVerdict } from './layer1/hook-list/hook-list.ts';

/** Causes in the order they are checked: the first that holds names the dialog. */
export const NO_HOOK_CAUSES = [
  'hook-running', 'outside-work-area', 'hooks-disabled', 'not-in-session-hooks', 'unexplained',
] as const;
export type NoHookCause = (typeof NO_HOOK_CAUSES)[number];

/** What the server knows about the session; `null` = unknown, which never makes a cause hold. */
export interface NoHookFacts {
  /** `ps` shows the session's hook process (a child of the session process); `null` = `ps` unavailable. */
  readonly hookRunning: boolean | null;
  /** The registry `cwd` differs from the pane `cwd` and lies outside the work area by the hook's rule. */
  readonly outsideWorkArea: boolean | null;
  /** `disableAllHooks` after the session's settings precedence. */
  readonly disableAllHooks: boolean | null;
  /** `allowManagedHooksOnly` from the managed settings. */
  readonly allowManagedHooksOnly: boolean | null;
  /** Rarog's `PermissionRequest` entry stands in some settings layer of the session (a superset read). */
  readonly rarogEntry: boolean | null;
}

/**
 * The first cause that holds: the hook process runs without a registration; the session `cwd` lies outside the work
 * area; hooks are off by settings; the session's settings layers have no Rarog entry; otherwise `unexplained` (the CLI
 * did not call the hook, or the hook left quietly for a reason the server cannot see). Only a certain value decides:
 * the layer read is a superset, so only `rarogEntry: false` is sure, and only a `true` turns hooks off.
 */
export function noHookCause(facts: NoHookFacts): NoHookCause {
  if (facts.hookRunning === true) return 'hook-running';
  if (facts.outsideWorkArea === true) return 'outside-work-area';
  if (facts.disableAllHooks === true || facts.allowManagedHooksOnly === true) return 'hooks-disabled';
  if (facts.rarogEntry === false) return 'not-in-session-hooks';
  return 'unexplained';
}

/**
 * Whether the card the `off` path shows would carry the approve button by today's rules: a consent card the driver
 * understood (`input`), with the button (`canAllow`), whose whole text the card shows (`cardShowsAll`, the manager's
 * rule for the button). Read from the card before the channel gate (`consentOnlyEvent`), which does not change it.
 */
export function offPathApprove(event: DecisionCard['event']): boolean {
  return event.type === 'permission-request' && event.input !== null && event.canAllow !== false
    && cardShowsAll(event.displayText, event.truncation);
}

/** Thread of the dialog: `subagent` when its title carries the subagent suffix or its card came from a subagent dump. */
export type NoHookThread = 'main' | 'subagent';

/** `statusLine` dump of the session: written within the freshness window, older, or none. */
export type StatuslineFreshness = 'fresh' | 'stale' | 'none';

/** Characters a log value may carry: an identifier, a name or a version, never a path, a command or free text. */
const TOKEN = /^[A-Za-z0-9_.:+-]{1,80}$/;

/** A value fit for a log line, or `?` for anything else (unknown, empty, a path, spaces, separators). */
export function logToken(value: string | null | undefined): string {
  return typeof value === 'string' && TOKEN.test(value) ? value : '?';
}

/** The hook list verdict as a log value: `ok` or the code of its reason, never the file it names; `?` without one. */
export function hooksToken(verdict: HookListVerdict | null): string {
  if (verdict === null) return '?';
  return verdict.ok ? 'ok' : logToken(hookListWhyCode(verdict.why));
}

export interface NoHookLine {
  readonly sessionId: string;
  readonly cause: NoHookCause;
  readonly tool: string | null;
  readonly cli: string | null;
  /** Rarog's name of the pane's permission mode (`manual`, `plan`, `auto`, `bypass`); `null` = unknown. */
  readonly mode: string | null;
  readonly thread: NoHookThread;
  /** Milliseconds from the episode start to the line. */
  readonly afterMs: number;
  readonly hooks: HookListVerdict | null;
  readonly statusline: StatuslineFreshness;
  /** {@link offPathApprove} of the episode's card. */
  readonly screenButton: boolean;
}

/** `consent: no hook — …`, one per consent dialog episode without a hook trace. */
export function noHookLine(line: NoHookLine): string {
  return `consent: no hook — session ${logToken(line.sessionId)}, cause ${line.cause}, tool ${logToken(line.tool)}, `
    + `cli ${logToken(line.cli)}, mode ${logToken(line.mode)}, thread ${line.thread}, `
    + `after ${String(Math.max(0, Math.round(line.afterMs)))} ms, hooks ${hooksToken(line.hooks)}, `
    + `statusline ${line.statusline}, screen-button ${line.screenButton ? 'yes' : 'no'}`;
}

export interface NoApproveButtonLine {
  readonly sessionId: string;
  /** `unavailable` of the card (`screen-unavailable.ts`); `null` = none. */
  readonly reason: string | null;
  readonly tool: string | null;
  /** Effective consent channel mode; `null` = unknown. */
  readonly channel: string | null;
  /** Proof rule of the card's thread (`channel`, `screen`); `null` = unknown. */
  readonly rule: string | null;
  readonly cli: string | null;
}

/** `consent: no approve button — …`, one per card identity whose approve button the channel gate took. */
export function noApproveButtonLine(line: NoApproveButtonLine): string {
  return `consent: no approve button — session ${logToken(line.sessionId)}, reason ${logToken(line.reason)}, `
    + `tool ${logToken(line.tool)}, channel ${logToken(line.channel)}, rule ${logToken(line.rule)}, `
    + `cli ${logToken(line.cli)}`;
}
