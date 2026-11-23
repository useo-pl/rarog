/**
 * `permission_suggestions` of a `PermissionRequest` (the permission updates Claude Code offers with the dialog) as the
 * hook carries them in the per-call dump and the consent registration, and the MCP marker of an empty list.
 *
 * The hook passes the stdin value as it is up to {@link HOOK_SUGGESTIONS_MAX_BYTES} and drops it above. The server does
 * not trust it: {@link parseHookSuggestions} keeps the list only when it is whole, every entry in a documented shape
 * (strict objects: a field the server does not know drops the list) and at most {@link HOOK_SUGGESTIONS_MAX_ENTRIES}
 * entries; anything else counts as no suggestions. Nothing here decides a verdict, `canAllow` or the hook's output.
 * Pure functions, no disk.
 */
import { z } from 'zod';

/**
 * Ceiling of `permission_suggestions` the hook carries, as compact JSON in UTF-8 bytes (`SUGGESTIONS_MAX_BYTES` in
 * `scripts/hooks/consent.mjs`). Above it the hook drops the field.
 */
export const HOOK_SUGGESTIONS_MAX_BYTES = 16 * 1024;

/** Entries of one list; a longer list counts as no suggestions. */
export const HOOK_SUGGESTIONS_MAX_ENTRIES = 16;

/** Rules or directories of one entry. */
const ITEMS_MAX = 16;

/** Tool name in a rule: the identifier pattern of the dump reader (`Bash`, `WebFetch`, `mcp__server__tool`). */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

/** Prefix of MCP tool names (`CONSENT_COMPARABLE_TOOL_PREFIX` in `layer1/contract.ts`). */
const MCP_TOOL_PREFIX = 'mcp__';

/** Where an update would be written (Claude Code hooks docs, "Permission update entries"). */
const destination = z.enum(['session', 'localSettings', 'projectSettings', 'userSettings']);
const text = z.string().min(1).max(HOOK_SUGGESTIONS_MAX_BYTES);

const rulesEntry = z.strictObject({
  type: z.enum(['addRules', 'replaceRules', 'removeRules']),
  rules: z.array(z.strictObject({ toolName: z.string().regex(TOOL_NAME_PATTERN), ruleContent: text.optional() }))
    .min(1).max(ITEMS_MAX),
  behavior: z.enum(['allow', 'deny', 'ask']),
  destination,
});
const modeEntry = z.strictObject({
  type: z.literal('setMode'),
  mode: z.string().regex(/^[A-Za-z]{1,32}$/),
  destination,
});
const directoriesEntry = z.strictObject({
  type: z.enum(['addDirectories', 'removeDirectories']),
  directories: z.array(text).min(1).max(ITEMS_MAX),
  destination,
});
const listSchema = z.array(z.discriminatedUnion('type', [rulesEntry, modeEntry, directoriesEntry]))
  .max(HOOK_SUGGESTIONS_MAX_ENTRIES);

/** One permission update in a documented shape, exactly as Claude Code sent it. */
export type HookPermissionUpdate = z.infer<typeof listSchema>[number];

/** `permission_suggestions` after the server's check: the whole list in stdin order. */
export type HookSuggestions = readonly HookPermissionUpdate[];

/**
 * The checked list from the value in a dump or a registration. `undefined` = no suggestions: the hook carried no
 * field (an older hook, stdin without `permission_suggestions`) or the value is outside the check (not a list, over
 * the byte or entry ceiling, an entry outside the documented shapes). Never throws.
 */
export function parseHookSuggestions(raw: unknown): HookSuggestions | undefined {
  if (raw === undefined) return undefined;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8');
  } catch {
    return undefined;
  }
  if (bytes > HOOK_SUGGESTIONS_MAX_BYTES) return undefined;
  const parsed = listSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The MCP marker as a raw fact: an MCP tool whose stdin carried `permission_suggestions` as an empty list. Measured on
 * CLI 2.1.322 the empty list came only with an MCP tool with `requiresUserInteraction` (3 of 3, plain MCP tools 0 of 6),
 * whose dialog a plain `allow` does not close; the sample does not prove the converse, so the marker says what the hook
 * saw, not why. No field, a dropped value and a list with entries are not the fact.
 */
export function mcpEmptySuggestions(toolName: string, suggestions: HookSuggestions | undefined): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX) && suggestions !== undefined && suggestions.length === 0;
}
