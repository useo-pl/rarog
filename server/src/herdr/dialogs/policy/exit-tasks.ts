/**
 * Task lines of the CLI exit dialog `background-work-exit` (`TERMINAL_DIALOGS`): what the session restart names
 * when `/exit` meets that dialog instead of ending the process. A pure function over the screen text: the
 * dialog comes from the block (`readBlock`) and the closed match of title and options, the lines from between the
 * list header and the first option. It sends no key and decides nothing about the restart.
 */
import { readBlock } from '../layer2/read-block.ts';
import { OPTION_LINE_PATTERN, unbox } from '../screen/options.ts';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';
import { matchTerminalDialog } from './terminal.ts';

const LIST_HEADER_PATTERN = SCREEN_SIGNATURES.backgroundWorkListHeader.pattern;

/**
 * The task lines of the exit dialog on the screen, top to bottom, trimmed, blank lines skipped, as the CLI drew them
 * (a long task is already cut by the CLI with `…`). `null` = no `background-work-exit` block on the screen, or the
 * block has no list header: the caller then knows nothing about the tasks. `[]` = header with no line under it.
 */
export function exitDialogTasks(screen: string): readonly string[] | null {
  const block = readBlock(screen);
  if (block === null || matchTerminalDialog(block.title, block.options) !== 'background-work-exit') return null;
  const rows = block.rows.filter((row) => row.index > block.titleLine);
  const header = rows.findIndex((row) => LIST_HEADER_PATTERN.test(row.text.trim()));
  if (header === -1) return null;
  const tasks: string[] = [];
  for (const row of rows.slice(header + 1)) {
    if (OPTION_LINE_PATTERN.test(unbox(row.text))) break;
    const line = row.text.trim();
    if (line !== '') tasks.push(line);
  }
  return tasks;
}
