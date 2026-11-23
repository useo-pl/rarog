/**
 * Protocol contract, consent channel area: the "always" option of a channel card (`PermissionRequest.always`).
 * The permission updates the hook writes after "always", taken literally from Claude Code's suggestions
 * (`permission_suggestions`), each with its write destination. The server sends the list only when every suggestion
 * is on the closed list: an `allow` rule in the session or in the project's local settings, mode `acceptEdits` in the
 * session, a working directory in the session. The "always" button also requires `canAllow`.
 *
 * Re-exported unchanged by `shared/src/protocol.ts`; code imports the names from there.
 */
import { z } from 'zod';

/** What an entry changes: a permission rule (`Tool` or `Tool(content)`), the session mode or a working directory. */
export const CONSENT_ALWAYS_KINDS = ['rule', 'mode', 'directory'] as const;
export type ConsentAlwaysKind = (typeof CONSENT_ALWAYS_KINDS)[number];

/** Where Claude Code writes the update: this session only, or the project's local settings (`settings.local.json`). */
export const CONSENT_ALWAYS_DESTINATIONS = ['session', 'localSettings'] as const;
export type ConsentAlwaysDestination = (typeof CONSENT_ALWAYS_DESTINATIONS)[number];

/** One update of the "always" option: kind, literal value and write destination. */
export interface ConsentAlwaysEntry {
  kind: ConsentAlwaysKind;
  value: string;
  destination: ConsentAlwaysDestination;
}

export const consentAlwaysEntrySchema = z.object({
  kind: z.enum(CONSENT_ALWAYS_KINDS),
  value: z.string(),
  destination: z.enum(CONSENT_ALWAYS_DESTINATIONS),
});

/**
 * Why a consent card WITHOUT `channel` (from the screen or the transcript, `canAllow: false`) cannot be approved from
 * the phone, beyond the channel reasons it shares (`no-channel`, `terminal-only`, `truncated`, `hidden-chars`): the
 * session's settings changed after it started (`settings-changed`, restarting the session helps), another
 * `PermissionRequest` hook runs in the session (`other-hook`), Rarog cannot confirm that its hook is the only one
 * (`unverified-hooks`). Only a card without `channel` carries these values; a channel card and `permission-settled`
 * never do, because an older app reads an unknown reason on a channel card as "no buttons at all".
 */
export const SCREEN_UNAVAILABLE_REASONS = ['settings-changed', 'other-hook', 'unverified-hooks'] as const;
export type ScreenUnavailableReason = (typeof SCREEN_UNAVAILABLE_REASONS)[number];
