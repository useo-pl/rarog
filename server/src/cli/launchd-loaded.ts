/**
 * The definition launchd has loaded for a label, read from `launchctl print gui/<uid>/<label>`: its program arguments.
 * launchd reads the plist only at `bootstrap`, and `rarog restart` (`kickstart`) starts the loaded definition, so after
 * an interrupted `rarog service install` the plist on disk and the service that runs can name different
 * installations. This module only reads; it never loads, stops or changes a service.
 */
import { spawnSync } from 'node:child_process';
import type { CliIo } from './io.ts';
import { launchdTarget, printedLoadState } from './restart.ts';

/** The loaded definition of a label: none, its program arguments, or why neither is known. */
export type LoadedDefinition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'loaded'; readonly argv: readonly string[] }
  | { readonly kind: 'unknown'; readonly detail: string };

/** First line of the arguments block in the printout of a service: one tab of indent (measured on macOS 27.2). */
const ARGS_START = '\targuments = {';
/** Its last line. */
const ARGS_END = '\t}';
/** One argument: two tabs, then the argument as launchd keeps it, spaces included. */
const ARGS_ENTRY = /^\t\t(.+)$/su;

/**
 * The program arguments in a `launchctl print gui/<uid>/<label>` printout: the block that starts with exactly
 * `\targuments = {`, one argument per line after two tabs, and ends with `\t}` (blocks nested deeper do not count).
 * Apple does not document this printout as an interface, so no block, a block without its end, a second block, an
 * empty block or a line of another shape inside it gives an issue, never a guess.
 */
export function parseLoadedArguments(
  text: string,
): { readonly argv: readonly string[] } | { readonly issue: string } {
  const argv: string[] = [];
  let blocks = 0;
  let inside = false;
  let issue: string | null = null;
  const lines = text.split('\n');
  // The empty piece after the final line end is not a line of the printout.
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((line, index) => {
    if (!inside) {
      if (line === ARGS_START) {
        inside = true;
        blocks += 1;
      }
      return;
    }
    if (line === ARGS_END) {
      inside = false;
      return;
    }
    const match = ARGS_ENTRY.exec(line);
    if (match === null) {
      issue ??= `line ${String(index + 1)} of the arguments block is not "<tab><tab><argument>"`;
      return;
    }
    argv.push(match[1] ?? '');
  });
  if (blocks === 0) return { issue: 'no arguments block' };
  if (inside) return { issue: 'arguments block not closed' };
  if (blocks > 1) return { issue: `arguments block appears ${String(blocks)} times instead of once` };
  if (issue !== null) return { issue };
  return argv.length === 0 ? { issue: 'empty arguments block' } : { argv };
}

/**
 * The loaded definition of `label` in the user's GUI domain. Loaded or absent follows `rarog restart`'s rule
 * ({@link printedLoadState}); a loaded label whose arguments this module cannot read is unknown, with the reason. Not
 * macOS or no `getuid`: absent, because launchd is not there.
 */
export function loadedDefinition(
  label: string, io: CliIo, platform: NodeJS.Platform = process.platform,
): LoadedDefinition {
  if (platform !== 'darwin') return { kind: 'absent' };
  const target = launchdTarget(label);
  if (target === null) return { kind: 'absent' };
  const result = spawnSync('launchctl', ['print', target], {
    env: io.env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000,
  });
  const state = printedLoadState(result);
  if (state === 'absent') return { kind: 'absent' };
  if (state !== 'loaded') return { kind: 'unknown', detail: `launchctl print ${target}: ${state.unknown}` };
  const parsed = parseLoadedArguments(result.stdout);
  return 'issue' in parsed
    ? { kind: 'unknown', detail: `launchctl print ${target}: ${parsed.issue}` }
    : { kind: 'loaded', argv: parsed.argv };
}
