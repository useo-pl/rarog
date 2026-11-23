/**
 * Tailscale only for a new `config.json` of `rarog setup`: the app reaches the server only through the Tailscale
 * address, iroh stays off (`RAROG_IROH=0`, its relay kept for a switch back). `--tailscale-only` chooses it; without the
 * flag a first setup in a terminal, on a machine with the iroh module and `tailscale` in `PATH`, asks one question
 * before the plan screen. The answer only changes the transport plan (`setup-transport.ts`): it opens no run log and
 * writes nothing, so "Continue?" stays the one consent to write. An existing `config.json` keeps its transport; the
 * flag then writes nothing and points at the docs, which say how to switch by hand.
 */
import path from 'node:path';
import { confirm as confirmForm } from './screen/ask.ts';
import { CONFIG_FILENAME, rarogConfigDir } from './serve.ts';
import { entry } from './setup-context.ts';
import type { Ctx } from './setup-context.ts';
import { TAILSCALE_ONLY_CHOSEN, tailscaleOrigin } from './setup-transport.ts';

/** The flag that chooses Tailscale only without the question. */
export const TAILSCALE_ONLY_FLAG = '--tailscale-only';

/** The question before the plan screen; "n", Enter and EOF keep the standard transport. */
export const TAILSCALE_ONLY_QUESTION = 'Connect the app only through Tailscale?';

/**
 * What the question is for, right above it (one line each at 60 columns): both ways are encrypted; the answer decides
 * only where the app can connect from.
 */
export const TAILSCALE_ONLY_NOTES: readonly string[] = [
  'Standard: encrypted, the app connects from any network.',
  'y: encrypted too, the app connects only in your tailnet.',
];

/** The plan item of a new `config.json` with Tailscale only (it has no server key). */
export const TAILSCALE_ONLY_PLAN_ITEM = `config, ${TAILSCALE_ONLY_CHOSEN}`;

/** Why the run stops before the plan screen: detail lines for the run log, one sentence and its fix on the screen. */
export interface StopBeforePlan {
  readonly lines: readonly string[];
  readonly sentence: string;
  readonly fix: string;
}

/**
 * The question in the `[y/N]` form, through the view's question that opens no run log: a "y" here writes nothing, and
 * the log file appears only with "Continue?". `false` without a terminal.
 */
async function askTailscaleOnly(ctx: Ctx): Promise<boolean> {
  const ask = ctx.view.askBeforePlan;
  if (ask === null) return false;
  for (const note of TAILSCALE_ONLY_NOTES) ctx.view.questionNote(note);
  return confirmForm(ask, TAILSCALE_ONLY_QUESTION, 'y/N', { width: ctx.view.screen.layout.width });
}

/**
 * Before the plan screen, after the tools check: the flag, or the question, sets `ctx.tailscaleOnly` (with `relay`,
 * the relay `config.json` keeps for a switch back), and in a terminal a choice Tailscale cannot serve stops the run
 * here with nothing written: no `tailscale` in `PATH`, or a client that is logged out or stopped (read again after
 * "Continue?"). An existing `config.json` with the flag stops too, because setup does not switch it. `null` = go on.
 */
export async function tailscaleOnlyBeforePlan(
  ctx: Ctx, options: { readonly flag: boolean; readonly relay: string },
): Promise<StopBeforePlan | null> {
  const flag = TAILSCALE_ONLY_FLAG;
  if (entry(path.join(rarogConfigDir(ctx.io.env), CONFIG_FILENAME)) !== 'missing') {
    if (!options.flag) return null;
    return {
      lines: [`${flag}: ${CONFIG_FILENAME} exists, and setup does not change its transport`],
      sentence: `${flag} is for a new ${CONFIG_FILENAME}; nothing changed.`,
      fix: 'switch by hand: docs/server-config.md, "Tailscale only"',
    };
  }
  const asks = !options.flag && ctx.ask !== null && ctx.iroh.ready && ctx.tailscale;
  if (!options.flag && !(asks && await askTailscaleOnly(ctx))) return null;
  ctx.tailscaleOnly = { relay: options.relay };
  // Without a terminal nothing is written anyway; without the iroh module the tools check has judged Tailscale.
  if (ctx.ask === null || !ctx.iroh.ready) return null;
  const again = options.flag ? `rarog setup ${flag}` : 'rarog setup';
  const chosen = `transport: ${TAILSCALE_ONLY_CHOSEN}`;
  if (!ctx.tailscale) {
    return {
      lines: [chosen, 'MISSING tailscale — not in PATH'],
      sentence: 'Rarog cannot run without tailscale; nothing changed.', fix: `install Tailscale, then ${again}`,
    };
  }
  const status = tailscaleOrigin(ctx);
  if (!('failure' in status) || (status.down !== 'logged out' && status.down !== 'stopped')) return null;
  const loggedOut = status.down === 'logged out';
  return {
    lines: [chosen, `MISSING ${status.failure}`],
    sentence: `Rarog cannot run without ${loggedOut ? 'a logged-in' : 'a running'} Tailscale; nothing changed.`,
    fix: `${loggedOut ? 'log in to' : 'start'} Tailscale (tailscale up), then ${again}`,
  };
}
