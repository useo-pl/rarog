/**
 * Why a consent card from the screen or jsonl has no approve button (`PermissionRequest.unavailable` on a card
 * without `channel`), in the order of `docs/dialogs.md`, "What stays in the terminal in `all`". Pure functions over
 * explicit arguments: the driver passes the channel gate verdict, the mode, the card's origin and what the consent
 * cycle kept from the desk release of the card's call key. The reason only picks the card's sentence; it never gives
 * or takes the approve button (`canAllow` stays the manager's).
 */
import type { ConsentUnavailableReason, ScreenUnavailableReason, Truncation } from '@rarog/shared';
import { hasCardHiddenChar } from '../../hidden-chars.ts';
import type { CardOrigin } from './cards/build.ts';
import type { ConsentDeskRelease } from './layer1/desk-reason.ts';
import type { ConsentEffectiveMode } from './layer1/mode.ts';

/** Reasons a card without `channel` can carry: the shared channel ones and the screen ones. */
export type ScreenCardUnavailable =
  | Extract<ConsentUnavailableReason, 'no-channel' | 'terminal-only' | 'truncated' | 'hidden-chars'>
  | ScreenUnavailableReason;

export interface ScreenCardFacts {
  /** `input` of the card event; `null` = the card Rarog does not understand (degraded): no reason. */
  readonly input: unknown;
  readonly displayText: string;
  readonly truncation?: Truncation | undefined;
  /** The channel mode blocks the consent digit of this card (`consentDigitRefused` in `consent-gate.ts`). */
  readonly blocked: boolean;
  /** Effective channel mode; `null` = unknown. */
  readonly mode: ConsentEffectiveMode | null;
  /** `callKey` and `agentId` of the hook dump that described the card's call; absent = card without such a dump. */
  readonly origin?: Pick<CardOrigin, 'callKey' | 'agentId'> | undefined;
  /** What the consent cycle kept from the desk release of `origin.callKey`; `null` = no such release. */
  readonly release: ConsentDeskRelease | null;
  /** Working directory of the session (the pane's `cwd`). */
  readonly sessionCwd: string;
}

/**
 * The first reason that holds, in this order: a degraded card (`input: null`) has none; a card the channel mode
 * blocks takes the reason of its call's desk release (`settings-changed`, `other-hook`, `unverified-hooks` after the
 * hook list check, `terminal-only` after any other check), else `terminal-only` for a subagent request in `main`,
 * else `no-channel`; any other card without the full text gets `truncated` or `hidden-chars`; otherwise none.
 */
export function screenCardUnavailable(facts: ScreenCardFacts): ScreenCardUnavailable | undefined {
  if (facts.input === null) return undefined;
  if (facts.blocked) return blockedReason(facts);
  if (facts.truncation !== undefined) return 'truncated';
  return hasCardHiddenChar(facts.displayText) ? 'hidden-chars' : undefined;
}

function blockedReason(facts: ScreenCardFacts): ScreenCardUnavailable {
  const release = facts.origin?.callKey === undefined ? null : facts.release;
  if (release !== null) {
    return release.reason === 'other-hooks' ? hookListReason(release, facts.sessionCwd) : 'terminal-only';
  }
  if (facts.mode === 'main' && facts.origin?.agentId !== undefined) return 'terminal-only';
  return 'no-channel';
}

/**
 * The hook list's verdict as the card's reason: a settings file changed after the session started (restarting the
 * session helps), another `PermissionRequest` hook, or anything Rarog could not read. A changed file under the
 * request's own directory, when that is not the session's (a subagent worktree created after the start), is not
 * fixed by a restart, so it reads as unverified.
 */
function hookListReason(release: ConsentDeskRelease, sessionCwd: string): ScreenUnavailableReason {
  const why = release.hooks;
  switch (why?.code) {
    case 'changed':
      return why.detail === null || underRequestDir(why.detail, release.cwd, sessionCwd)
        ? 'unverified-hooks' : 'settings-changed';
    case 'foreign':
    case 'hook-in':
      return 'other-hook';
    default:
      return 'unverified-hooks';
  }
}

/** The file lies under the request's directory and that directory is not the session's; unknown directory = yes. */
function underRequestDir(file: string, requestCwd: string | null, sessionCwd: string): boolean {
  if (requestCwd === null) return true;
  if (requestCwd === sessionCwd) return false;
  return file === requestCwd || file.startsWith(requestCwd.endsWith('/') ? requestCwd : `${requestCwd}/`);
}
