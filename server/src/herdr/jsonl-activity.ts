/**
 * The activity row from the transcript tail: the `tool` activity of one call (summary, description, delegation) and
 * what the row shows when a call's result arrives.
 *
 * Pure functions over raw jsonl entries, without I/O. Open calls come from the follower's `PendingTracker`
 * (`jsonl-pending.ts`): this module pairs nothing itself. The follower (`jsonl-follow.ts`) decides when an event goes
 * out, and only on the live tail.
 */
import type { Activity } from '@rarog/shared';
import { SUMMARY_MAX_CHARS, summarizeToolInput } from '../drivers/tool-summary.ts';
import { asRecord, shorten, toolDelegation } from '../drivers/tool-text.ts';
import { toolResultDecisions } from './jsonl-pending.ts';
import type { PendingTool } from './jsonl-pending.ts';

/** Ile znaków opisu delegacji mieści się w wierszu aktywności na telefonie. */
const DELEGATION_MAX_CHARS = 80;
/** Nagłówek skryptu workflow, w którym stoi `export const meta = { name: … }` (zmierzone). */
const SCRIPT_HEAD_CHARS = 400;

/**
 * Opis delegacji z SUROWEGO inputu narzędzia; `''` = nie wiem (i wtedy nic nie dopisujemy).
 *
 * Osobno od `summarizeToolInput`, bo tamta funkcja szuka kluczy `command`/`file_path`/`path`/…,
 * a input delegacji ma `description` (Task/Agent) albo `script` (Workflow) — zmierzone na
 * realnych wpisach. `summarizeToolInput` zwraca dla nich samą nazwę narzędzia, czyli
 * dokładnie to, co użytkownik już widzi.
 */
export function delegationSummary(input: unknown): string {
  const record = asRecord(input);
  if (record === null) return '';
  const description = record['description'];
  if (typeof description === 'string' && description.trim() !== '') {
    return shorten(description.trim(), DELEGATION_MAX_CHARS);
  }
  const script = record['script'];
  if (typeof script === 'string') {
    // Nazwa przebiegu z nagłówka skryptu — ta sama, którą niesie `session-pulse.ts`
    // (nazwa pliku w `workflows/scripts/`), żeby oba źródła mówiły o workflow tak samo.
    const name = /\bname:\s*['"`]([^'"`\n]{1,120})['"`]/.exec(script.slice(0, SCRIPT_HEAD_CHARS));
    const value = name?.[1]?.trim() ?? '';
    if (value !== '') return shorten(value, DELEGATION_MAX_CHARS);
  }
  return '';
}

/**
 * The tool's own words about the call: the `description` field of its input, trimmed and cut like the summary
 * (`SUMMARY_MAX_CHARS`, at a character boundary). Empty or whitespace = no description.
 */
function toolDescription(input: unknown): string | undefined {
  const value = asRecord(input)?.['description'];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : shorten(trimmed, SUMMARY_MAX_CHARS);
}

/**
 * The `tool` activity of one call, from its name and RAW input.
 *
 * A delegating call (`Task`, `Agent`, `Workflow`) says what work it handed down (`delegationSummary`); its
 * `description` is that summary already, so the field stays off. Any other tool carries the input summary (the
 * command, the file, the pattern: the row tells which command runs); `Bash` also its own `description`. The tool
 * name alone is no summary: the row already shows it. `delegation` comes from `toolDelegation`, the rule of the
 * imported block.
 */
export function toolActivity(toolName: string, input: unknown): Activity {
  const activity: Activity = { kind: 'tool', toolName };
  const delegation = toolDelegation(toolName);
  if (delegation !== undefined) {
    activity.delegation = delegation;
    const summary = delegationSummary(input);
    if (summary !== '') activity.summary = summary;
    return activity;
  }
  const summary = summarizeToolInput(toolName, input);
  if (summary !== toolName) activity.summary = summary;
  const description = DESCRIBED_TOOLS.has(toolName) ? toolDescription(input) : undefined;
  if (description !== undefined) activity.description = description;
  return activity;
}

/**
 * Tools whose input `description` describes the call itself. In an MCP tool the same field is often the data the
 * call writes (the body of a task it creates), so it is never read as the row's label.
 */
const DESCRIBED_TOOLS: ReadonlySet<string> = new Set(['Bash']);

/**
 * RAW inputs of the entry's `tool_use` blocks, per tool name, in block order.
 *
 * The follower pairs them with the imported `tool-call` blocks by ORDER within one name, not by `tool_use.id`,
 * because the imported block carries no id. Both lists come from the same entry, so the order is the same; a block
 * the import dropped can at most lose its input, never take another call's, as each name has its own queue.
 */
export function toolInputsByName(entry: unknown): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  const record = asRecord(entry);
  const message = record === null ? null : asRecord(record['message']);
  const content = message === null ? null : message['content'];
  if (!Array.isArray(content)) return out;
  for (const item of content) {
    const block = asRecord(item);
    if (block === null || block['type'] !== 'tool_use') continue;
    const name = typeof block['name'] === 'string' ? block['name'] : '';
    const queue = out.get(name) ?? [];
    queue.push(block['input']);
    out.set(name, queue);
  }
  return out;
}

/**
 * What the row shows after one entry of the tail, given the tracker's open calls before and after it; `null` = no
 * event.
 *
 * The row shows the most recently opened call that is still open: each `tool_use` puts its call on the row, and
 * this rule moves the row only when that call ends. Its result with nothing left open gives `thinking` (the model
 * works on the result; without it the row would name a finished tool until the next message). With calls left open,
 * the row goes back to the most recently opened one, with its own summary and description. A result of another call,
 * of an unknown id, or an entry that closes nothing gives no event. A human message also closes every open call
 * (tracker rule 3), but it is a message, and a message replaces the row on the client.
 */
export function toolEndActivity(
  entry: unknown, before: readonly PendingTool[], after: readonly PendingTool[],
): Activity | null {
  const shown = before.at(-1);
  if (shown === undefined || after.some((tool) => tool.id === shown.id)) return null;
  if (!toolResultDecisions(entry).some((result) => result.toolUseId === shown.id)) return null;
  const next = after.at(-1);
  return next === undefined ? { kind: 'thinking' } : toolActivity(next.toolName, next.input);
}
