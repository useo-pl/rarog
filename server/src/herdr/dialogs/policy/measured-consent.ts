/**
 * Consent dialogs measured for the "Yes" digit while the consent channel is on: the
 * sandbox network dialog and the dialog of an MCP tool with `requiresUserInteraction`. Neither has a working hook
 * path (the network dialog sends no `PermissionRequest`; a plain `allow` does not close the MCP one, CLI 2.1.322), so
 * the phone answers them with the digit of option "Yes", and only when the screen proves the dialog.
 *
 * Proof (all of it, otherwise `null`): the measured block is the last block on screen and the only thing under its
 * rule, its title line has no queue counter, every line is the measured one (title, frame, question, the complete
 * option list, the lines under it), and its identity is read from the frame (network: the host; MCP: the header and
 * the argument lines). The card keeps the mark of the screen it came from, and right before the key a fresh read has
 * to give the same mark. Pure functions over the screen text; the read and the key belong to the driver. The CLI look
 * comes from `SCREEN_SIGNATURES` and the option line from the layer 2 shape registry.
 */
import { SHAPE_OPTION_LINE } from '../layer2/shapes.ts';
import { queueOnScreen } from '../screen/queue.ts';
import { blockTopOf } from '../screen/region.ts';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';
import { trimmedLines } from '../screen/text.ts';

const S = SCREEN_SIGNATURES;

/** Measured shape: the sandbox network dialog or the MCP dialog of a tool that requires user interaction. */
export type MeasuredConsentKind = 'network' | 'mcp-interaction';

/** The proof a card carries from the screen it came from (`ActiveReq.measuredConsent`). */
export interface MeasuredConsentMark {
  readonly kind: MeasuredConsentKind;
  /** Registry class the dialog stands under (`sandbox request` and `permission prompt` in the measurement). */
  readonly cliDialog: 'sandbox' | 'permission';
  /** What the dialog is about, as the screen shows it: the host, or the MCP header and the argument frame lines. */
  readonly identity: string;
  /** Host of the network dialog; absent for MCP. */
  readonly host?: string;
  /** Argument frame lines of the MCP dialog; absent for the network dialog. */
  readonly frame?: readonly string[];
  /** Digit of option "Yes": the only digit this path sends. */
  readonly allow: string;
}

/** One option line of the block: digit and label, with indentation and the focus marker `❯` taken off. */
function optionOf(line: string): { readonly digit: string; readonly label: string } | null {
  const hit = SHAPE_OPTION_LINE.pattern.exec(line);
  return hit?.[1] === undefined ? null : { digit: hit[1], label: hit[2] ?? '' };
}

/** `lines[at]` is option `digit` with a label that matches `label` as a whole; returns the match or `null`. */
function option(lines: readonly string[], at: number, digit: string, label: RegExp): RegExpExecArray | null {
  const read = optionOf(lines[at] ?? '');
  return read?.digit === digit ? label.exec(read.label) : null;
}

const isRule = (line: string | undefined): boolean => line !== undefined && S.operationRule.pattern.test(line);

/** Network dialog: title, frame with the host, question and the three options, nothing under them. */
function networkOf(lines: readonly string[]): MeasuredConsentMark | null {
  if (lines.length !== 8 || !S.sandboxNetworkDialog.pattern.test(lines[0] ?? '')) return null;
  if (!isRule(lines[1]) || !isRule(lines[3]) || !S.sandboxNetworkQuestion.pattern.test(lines[4] ?? '')) return null;
  const host = S.sandboxNetworkHost.pattern.exec(lines[2] ?? '')?.[1];
  if (host === undefined) return null;
  const always = option(lines, 6, '2', S.sandboxNetworkAlways.pattern);
  if (option(lines, 5, '1', S.measuredConsentYes.pattern) === null || always?.[1] !== host
    || option(lines, 7, '3', S.sandboxNetworkNo.pattern) === null) {
    return null;
  }
  return { kind: 'network', cliDialog: 'sandbox', identity: host, host, allow: '1' };
}

/**
 * MCP dialog of a tool with `requiresUserInteraction`: "Tool use", the MCP header, the argument frame (at least one
 * line), "About the …" with the description bar lines, the question, exactly "1. Yes" and "2. No" and the footer.
 * A dialog without the argument frame (a call with `{}`) was not measured and gets no mark.
 */
function mcpOf(lines: readonly string[]): MeasuredConsentMark | null {
  const header = lines[1] ?? '';
  if (lines[0] !== S.toolUseTitle.pattern || !S.mcpDialogHeader.pattern.test(header) || !isRule(lines[2])) {
    return null;
  }
  const close = lines.findIndex((line, at) => at > 3 && isRule(line));
  if (close === -1) return null;
  const args = lines.slice(3, close);
  const about = S.mcpToolAbout.pattern.exec(lines[close + 1] ?? '')?.[1];
  if (args.some((line) => line === '') || about === undefined || !header.startsWith(about)) return null;
  let at = close + 2;
  const bars = at;
  while (S.operationBar.pattern.test(lines[at] ?? '')) at += 1;
  if (at === bars || lines[at] !== '' || lines[at + 1] !== S.proceedQuestion.pattern) return null;
  if (option(lines, at + 2, '1', S.measuredConsentYes.pattern) === null
    || option(lines, at + 3, '2', S.measuredConsentNo.pattern) === null) {
    return null;
  }
  if (lines[at + 4] !== '' || lines[at + 5] !== S.permissionFooter.pattern || lines.length !== at + 6) return null;
  return {
    kind: 'mcp-interaction', cliDialog: 'permission', identity: [header, ...args].join('\n'), frame: args, allow: '1',
  };
}

/**
 * The measured consent dialog on screen, or `null`. The block starts at the last bare block rule on screen; every
 * line from there to the bottom belongs to the shape, so a second dialog, a queue counter, a cut or wrapped line or
 * an extra option means `null`.
 */
export function measuredConsentOf(text: string | null): MeasuredConsentMark | null {
  if (text === null || queueOnScreen(text).kind === 'counter') return null;
  const all = trimmedLines(text);
  const top = blockTopOf(all, all.length, { kinds: ['bare'] });
  if (top === null) return null;
  const lines = all.slice(top.line + 1).map((line) => line.trim());
  return networkOf(lines) ?? mcpOf(lines);
}

/**
 * Whether `digit` may go into the dialog on the fresh screen `text` for a card with `mark`: the digit is option "Yes"
 * of the mark and the fresh screen gives the same kind and identity. A card without a mark is not this path (`true`).
 */
export function measuredConsentHolds(
  mark: MeasuredConsentMark | undefined, text: string | null, digit: string,
): boolean {
  if (mark === undefined) return true;
  if (digit !== mark.allow) return false;
  const fresh = measuredConsentOf(text);
  return fresh !== null && fresh.kind === mark.kind && fresh.identity === mark.identity;
}

/**
 * Whether the argument frame of an MCP mark shows exactly the call `input` of the card: one line `<key>: "<value>"` per
 * argument, in any order, nothing else. Measured only for short string arguments (`text: "e0-rui"`, CLI 2.1.322,
 * fixture `kontrolny/zgoda-mcp-interakcja-2.1.322.txt`), so any other value (number, list, object, a string JSON would
 * escape) and a wrapped line mean `false`: the card stays without the "Yes" digit.
 */
export function mcpFrameShows(mark: MeasuredConsentMark, input: unknown): boolean {
  if (mark.kind !== 'mcp-interaction' || mark.frame === undefined) return false;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const shown = Object.entries(input).map(([key, value]) => (
    typeof value === 'string' && JSON.stringify(value) === `"${value}"` && !/[\p{C}]/u.test(value)
      ? `${key}: "${value}"` : null
  ));
  if (shown.length === 0 || shown.some((line) => line === null)) return false;
  return shown.length === mark.frame.length && [...shown].sort().join('\n') === [...mark.frame].sort().join('\n');
}
