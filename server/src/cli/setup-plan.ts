/**
 * The plan screen of `rarog setup`: what this run creates of Rarog's own (`config.json` with the server key, the hook
 * copy, the herdr agent or unit, the Claude SDK, the service), one line on the work area of a new `config.json`, and
 * one question `Continue? [Y/n]` for all of it, in at most 7 lines above the question at 60 columns. "n" or EOF stops
 * the run before any write; on a plan of the herdr item alone it declines just that item and the run goes on.
 * Questions about the user's own files and settings stay with their steps; this module writes nothing.
 */
import { PROJECT_ROOTS_ENV } from '../config-env.ts';
import { SDK_TERMS_URL } from '../install/sdk.ts';
import { confirm as confirmForm } from './screen/ask.ts';
import { wrapWords } from './screen/style.ts';
import { CONFIG_FILENAME } from './serve.ts';
import type { Ctx, PlanItem } from './setup-context.ts';

/** The question of the plan screen; measurements and tests recognise it by its `[Y/n]` ending. */
export const PLAN_QUESTION = 'Continue?';

/** The line after "n" on the plan screen: the one sentence. */
export const PLAN_DECLINED = 'Nothing changed.';

/** One thing the plan creates: its name, where it goes (a path or a label) when it has a place, and lines under it. */
export interface PlanEntry {
  readonly item: PlanItem;
  readonly what: string;
  readonly where?: string;
  readonly notes?: readonly string[];
}

/** Width of the "what" column of the plan lines. */
const WHAT_WIDTH = 22;

/** `~` in place of the home directory (the plan and the questions of the steps show paths this way). */
export function tilde(file: string, home: string): string {
  return file === home ? '~' : file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

/**
 * The Claude Agent SDK this run downloads, in two lines: the version, its size and Anthropic's terms, then the link
 * alone on its line, so it opens or copies whole.
 */
export function sdkPlanEntry(version: string): PlanEntry {
  return { item: 'sdk', what: `Claude Agent SDK ${version}, 5 MB, Anthropic's terms:`, notes: [SDK_TERMS_URL] };
}

/** The first line of the plan: the machine as the user calls it (a Linux machine is not "this Mac"). */
export function planHeader(platform: NodeJS.Platform): string {
  return `Rarog will set up on this ${platform === 'darwin' ? 'Mac' : 'machine'}:`;
}

/**
 * The line on the work area of a new `config.json`: home, and the key that narrows it in the file the plan
 * creates. One line at 60 columns; which folders stay out and the second root key are in `config.json` and the docs.
 */
export function workAreaSentence(): string {
  return `Work area: home (${PROJECT_ROOTS_ENV} in ${CONFIG_FILENAME}).`;
}

/**
 * Shows the plan and asks once. `true` = go on (also with nothing to create, where nothing is asked); the accepted
 * items land in `ctx.accepted`. Without a terminal nothing is shown or accepted. "n" on a plan of the herdr item alone
 * goes on with it in `ctx.declined`: the rest of the run (questions about the user's files, the closing check) does not
 * depend on it, so "Nothing changed." would not hold.
 */
export async function confirmPlan(ctx: Ctx, entries: readonly PlanEntry[]): Promise<boolean> {
  if (entries.length === 0 || ctx.ask === null) return true;
  const width = ctx.view.screen.layout.width;
  const show = (text: string): void => { ctx.view.block(text); };
  show(planHeader(ctx.platform));
  for (const entry of entries) {
    const { what, where } = entry;
    const head = where === undefined ? `  • ${what}` : `  • ${what.padEnd(WHAT_WIDTH)} ${where}`;
    if (where === undefined || head.length <= width) show(head);
    else {
      show(`  • ${what}`);
      show(`    ${where}`);
    }
    for (const note of entry.notes ?? []) {
      for (const one of wrapWords(note, width - 4, width - 4)) show(`    ${one}`);
    }
  }
  if (entries.some((entry) => entry.item === 'config')) {
    for (const one of wrapWords(workAreaSentence(), width, width)) show(one);
  }
  const yes = await confirmForm(ctx.ask, PLAN_QUESTION, 'Y/n', { width });
  if (!yes) {
    if (entries.every((entry) => entry.item === 'herdr')) {
      for (const entry of entries) ctx.declined.add(entry.item);
      return true;
    }
    show(PLAN_DECLINED);
    return false;
  }
  ctx.view.accepted();
  for (const entry of entries) ctx.accepted.add(entry.item);
  return true;
}
