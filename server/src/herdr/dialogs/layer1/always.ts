/**
 * The "always" option of a consent channel card (warstwa 1): which `permission_suggestions` the phone may
 * accept as "allow and don't ask again", how the card shows them and the digest the answer file signs.
 *
 * Closed list ({@link consentAlwaysEntries}): `addRules` with `behavior: allow` and the destination `session` or
 * `localSettings`; `setMode` with `acceptEdits` in `session`; `addDirectories` in `session`. Any other entry
 * (`replaceRules`, `removeRules`, `removeDirectories`, `setMode` to another mode, `projectSettings`, `userSettings`),
 * a value with a hidden character and the plan card take the option off the whole card. The hook keeps the same list
 * literally (`alwaysAllowed` in `scripts/hooks/consent.mjs`) and gives back its own stdin list, never this one.
 *
 * Pure functions over explicit inputs, no disk and no clock (`layer1-granica.test.ts`). Decides no `canAllow`.
 */
import { hasCardHiddenChar } from '../../../hidden-chars.ts';
import { canonicalSha256 } from '../hook/canon.ts';
import type { HookSuggestions } from '../hook/suggestions.ts';

/**
 * Version of the "always" answer file (`allow-always`, `permissionsSha256` in the signature). The hook sends it in the
 * registration (`alwaysVersion`) as `ALWAYS_VERSION` of `consent.mjs`; another version is refused with the body.
 */
export const CONSENT_ALWAYS_VERSION = 1;

/** What an entry of the option changes: a permission rule, the session mode or a working directory. */
export type ConsentAlwaysKind = 'rule' | 'mode' | 'directory';

/** Where Claude Code writes the update: the session only or the project's local settings file. */
export type ConsentAlwaysDestination = 'session' | 'localSettings';

/**
 * One update of the option as the card shows it: `rule` = `Tool` or `Tool(content)` (the rule syntax of Claude Code
 * settings), `mode` = the mode name, `directory` = the path, each literally from the suggestion.
 */
export interface ConsentAlwaysEntry {
  readonly kind: ConsentAlwaysKind;
  readonly value: string;
  readonly destination: ConsentAlwaysDestination;
}

/** Tool of the plan card: one approval, after which the session goes back to the mode from before the plan. */
const PLAN_TOOL = 'ExitPlanMode';

const RULE_DESTINATIONS: readonly string[] = ['session', 'localSettings'] satisfies ConsentAlwaysDestination[];

/** The entries of one suggestion on the closed list, or `null` when it is outside it. */
function entriesOf(update: HookSuggestions[number]): ConsentAlwaysEntry[] | null {
  switch (update.type) {
    case 'addRules':
      if (update.behavior !== 'allow' || !RULE_DESTINATIONS.includes(update.destination)) return null;
      return update.rules.map((rule) => ({
        kind: 'rule',
        value: rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`,
        destination: update.destination as ConsentAlwaysDestination,
      }));
    case 'setMode':
      return update.mode === 'acceptEdits' && update.destination === 'session'
        ? [{ kind: 'mode', value: update.mode, destination: 'session' }] : null;
    case 'addDirectories':
      return update.destination === 'session'
        ? update.directories.map((directory) => ({ kind: 'directory', value: directory, destination: 'session' }))
        : null;
    default:
      return null;
  }
}

/**
 * The "always" option of a card of `toolName` with the checked suggestions `suggestions`: every update in stdin
 * order, or `null` (no option) when there are none, one is outside the closed list, a value has a hidden character
 * or the card is the plan card.
 */
export function consentAlwaysEntries(
  toolName: string, suggestions: HookSuggestions | undefined,
): readonly ConsentAlwaysEntry[] | null {
  if (toolName === PLAN_TOOL || suggestions === undefined || suggestions.length === 0) return null;
  const entries: ConsentAlwaysEntry[] = [];
  for (const update of suggestions) {
    const part = entriesOf(update);
    if (part === null) return null;
    entries.push(...part);
  }
  return entries.some((entry) => hasCardHiddenChar(entry.value)) ? null : entries;
}

/** Digest of the updates in the `allow-always` file: sha256 of the canonical list (`hook/canon.ts`), as the hook. */
export function consentPermissionsSha256(suggestions: HookSuggestions): string {
  return canonicalSha256(suggestions);
}

/** Whether two checked lists are the same updates (canonical form, key order aside). */
export function sameConsentSuggestions(a: HookSuggestions | undefined, b: HookSuggestions | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalSha256(a) === canonicalSha256(b);
}
