/**
 * Kind of a file dialog (`Edit` "Edit file", `Write` "Create file" and "Overwrite file") whose key footer a narrow pane
 * cut or wrapped. Such a dialog asks about its file, not "Do you want to proceed?", so "Tab to amend" in the footer is
 * its only kind marker (`screen/kinds.ts`); cut with an ellipsis ("One-time Yes only: places not shown · Esc to cancel
 * · …" at 57 columns, CLI 2.1.330) or wrapped, it is gone, and the dialog read as a generic confirmation. This module
 * gives the kind back only when the CLI-drawn parts name the dialog: the block title, the whole frame under the dialog's
 * own two-line header and, under the frame, nothing but the file question about the header's file. It does not name the
 * tool (the block does) and does not prove the call (`screen/edit-frame.ts`).
 */
import { fileDialogTitle } from './block.ts';
import type { DialogBlock } from './block.ts';
import { editShownName } from './edit-frame.ts';
import { editZoneListed } from './edit-zone.ts';
import { operationAbove } from './operation.ts';
import { writeZoneFile } from './write-zone.ts';

/**
 * Whether the dialog over the options is a file dialog by its CLI-drawn parts: a file dialog title on the block
 * ({@link fileDialogTitle}), the frame right above the options region whole under a visible header of two lines (title
 * and path), and the zone between the frame's bottom rule and the first option is only the file question (`Edit`: "Do
 * you want to make this edit to <name>?", `Write`: "Do you want to create|overwrite <name>?", also wrapped) with the
 * base name of the header path. Any other shape gives `false`: the dialog stays `other`, and `parseOptions` gives
 * a block with a file dialog title neither the confirmation kind nor a form.
 *
 * @param lines screen lines after `trimmedLines`
 * @param regionStart index of the first line of the options region
 * @param firstOption index of the first option line
 */
export function fileDialogShown(
  lines: readonly string[], block: DialogBlock, regionStart: number, firstOption: number,
): boolean {
  const file = fileDialogTitle(block);
  if (file === null) return false;
  const operation = operationAbove(lines, regionStart);
  const name = editShownName(operation);
  // The header over the frame starts with the block title: the frame belongs to the titled block.
  if (operation === null || name === null || operation.header[0] !== lines[block.titleLine]) return false;
  const zone = lines.slice(regionStart, firstOption);
  return file === 'edit' ? editZoneListed(zone, name) : writeZoneFile(zone) === name;
}
