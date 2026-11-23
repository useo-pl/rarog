/**
 * Tall dialog guard for the `Bash` permission dialog on the phone.
 *
 * A permission dialog taller than the pane on the phone hides the title and the start of the command above the edge
 * of the screen. A SUBAGENT's permission then has no double proof (no entry in the main transcript file), so
 * Rarog gives a card without buttons, and a human cannot approve it from the phone. This module estimates how many
 * rows the dialog will take, and builds the FORM refusal message for the model. The `rarog-pending.mjs` hook sends
 * the refusal; there is not a single write here.
 *
 * A PURE module: zero dependencies, zero I/O, zero state. The hook loads it dynamically in `try`, so
 * a load error or an exception in the estimate means "behave as without the guard" (dump, dialog).
 *
 * WRAPPING from pane captures. Layout model: at spaces, greedily; a word longer than the frame is cut character by
 * character and starts in the current row, unless starting on a new row saves one cut. Checked on captures from the
 * phone (`dialog-bash-stechly-read-2.1.295`, `dialog-bash-uciety-naglowek-2.1.294`,
 * `measured/zgoda-bash-wysoka-2.1.295`) and from the Mac (128 columns): the model breaks their frames at the same
 * places, line for line (`server/test/dialog-guard.test.ts`).
 * The only difference is invisible: a space after a full row takes a column of the new row, but
 * the screen does not show it.
 *
 * THE ESTIMATE IS AN UPPER BOUND. The layout from the captures is not monotonic in word width,
 * so every uncertainty must raise the result: the estimate counts in `upper` mode (a word longer than the
 * frame always from a new row), and a character's width is never smaller than on the terminal
 * screen ({@link codePointWidth}). An estimate too small gives a card without buttons, too large one
 * more call. Overestimated on purpose: tab (8 columns), control character (1), emoji and characters
 * from U+2E80 (2), single-line command and description wrapped like multi-line ones, in a frame with the `│` bar
 * (two columns narrower), the housing margin. Where it can be UNDERESTIMATED: the housing in a pane narrower than
 * 62 columns (measured at 62), an `ask` rule longer than two rows, CLI warnings longer than the
 * margin. Limits: `docs/dialogs.md`, "Tall dialog guard".
 *
 * PANE GEOMETRY. The estimate counts on the pane the session stands in, not on a fixed phone: the hook gives `COLUMNS`
 * and `LINES` from its environment, and CLI 2.1.309 sets them to the CURRENT pty size at the moment of the call
 * (measurement: 5 × 62/29 with pty 62×29, 1 × 128/52 with 128×52, the CLI started at 127×52). The pane never LOOSENS
 * the guard compared to the phone: wrapping at `min(62, columns)`, budget `min(44, rows − 4)`. Missing or malformed
 * variables = phone constants (`phone`); a pane so low or narrow that it does not fit even the dialog the message asks
 * to send = phone constants too (`floor`), because refusing every `Bash` would stop the session with no way out ({@link
 * dialogBudget}).
 *
 * PHONE CONSTANTS (CLI 2.1.302). Sources: a main session measurement on a 62 × 51 pane (`pane split`; mode `auto` with
 * an `ask` rule in the main thread and in a subagent, `default` with an `ask` rule, `default` outside the sandbox;
 * capture `dialog-bash-opis-telefon-2.1.302.txt`) and the phone fixture {@link PHONE_FIXTURE} (the refusal shape at
 * this width). The test recomputes the widths and the housing from both files, so a new measurement changes the fixture
 * and the constants in one commit.
 */

/** Measurement day the phone constants come from. */
export const PHONE_MEASURED_AT = '2026-10-17';

/** CLI version of the measurement. */
export const PHONE_CLI_VERSION = '2.1.302';

/** Fixture with the shape of a tall dialog on the phone (reconstruction, neutral content). */
export const PHONE_FIXTURE = 'server/test/fixtures/herdr/dialog-bash-subagent-telefon-2.1.302.txt';

/** Capture from the measurement (pane 62 columns): description and command wrapped in `│` frames, the whole dialog. */
export const MEASURED_FIXTURE = 'server/test/fixtures/herdr/dialog-bash-opis-telefon-2.1.302.txt';

/** Phone pane width in columns (measured: 62). */
export const PHONE_COLUMNS = 62;

/** Phone pane height in rows (48: the row count of the measured refusal screen). */
export const PHONE_ROWS = 48;

/**
 * Command wrap width: the pane minus the left margin ` │ ` (3) and one column on the right:
 * measured 58 at 62 columns on CLI 2.1.302 (the CLI cuts a longer word hard at 58). The same
 * formula computes `operationAbove` in `server/src/herdr/dialogs/screen/operation.ts`.
 */
export const FRAME_COLUMNS = PHONE_COLUMNS - 3 - 1;

/**
 * Description wrap width (`tool_input.description`): the CLI draws a multi-line description in the same
 * `│` frame as the command, so also 58 (capture {@link MEASURED_FIXTURE}).
 */
export const DESCRIPTION_COLUMNS = FRAME_COLUMNS;

/**
 * Dialog HOUSING: all rows except the description and the command: the top rule, the title, the `default` mode hint (2
 * rows), two `╌` rules, the `ask` rule (2 rows at 62 columns) with `/permissions`, the question, the options (option 2
 * of `default` mode on 2 rows), empty lines and the footer. Measured: 13 rows in four variants (auto + `ask` in the
 * main thread and in a subagent, default + `ask`, default outside the sandbox).
 */
export const FRAME_ROWS = 13;

/**
 * Housing margin for rows the CLI adds only sometimes: 2 for the option "Yes, allow reading from
 * <directory> from this project" (`cd` outside the project) and 1 for "A variable in this command can't be
 * checked before it runs". Measured.
 */
export const FRAME_RESERVE_ROWS = 3;

/**
 * Budget: the tallest dialog (housing, margin, description and command together) the guard lets through. 48 pane rows
 * minus 4. A margin for what the estimate does not know: the queue marker "k of N" in the title, the new messages bar,
 * an unknown CLI warning. An estimate too small gives a card without buttons, too large costs one call.
 */
export const BUDGET_ROWS = 44;

/**
 * How many lines above the frame the parser looks for the dialog's top rule: MUST equal `HEADER_MAX_LINES`
 * in `operation.ts` (a test checks). The rule stands at most 12 lines above the frame, so between it
 * and the frame fit 11 header lines: the title, the mode hint and the description.
 */
export const HEADER_MAX_LINES = 12;

/** Fixed header lines above the description: the title (1) and the `default` mode hint (2 at 62 columns). */
export const HEADER_FIXED_ROWS = 3;

/** The longest description in rows at which the parser still sees the title above the frame. */
export const MAX_DESCRIPTION_ROWS = HEADER_MAX_LINES - 1 - HEADER_FIXED_ROWS;

/**
 * A tab counted as this many columns: the terminal expands it to the nearest multiple of 8, so
 * it takes at most 8 columns. The guard does not need the exact value: a `Bash` permission with a tab
 * ends with a card without buttons anyway (the frame check refuses, `docs/dialogs.md`,
 * "Permission dialog operation"), and 8 columns only raise the estimate.
 */
export const TAB_COLUMNS = 8;

/** Zero columns: combining characters (Mn, Me), format characters (Cf: ZWJ, ZWNJ, BOM) and variation selectors. */
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;

/**
 * Two columns: emoji (`Extended_Pictographic`, `Emoji_Presentation`), hangul vowels from the block
 * U+1100–U+115F, the brackets U+2329/U+232A and EVERY character from U+2E80 up (CJK, hangul, full
 * width, but also rare narrow scripts: overestimating is safe, see {@link codePointWidth}).
 */
const DOUBLE_WIDTH = /[\p{Extended_Pictographic}\p{Emoji_Presentation}ᄀ-ᅟ〈〉]/u;

/**
 * Width of ONE character (code point) in columns: NO SMALLER than on the terminal screen.
 * Wide and full-width characters (Unicode East Asian Width, UAX #11) and emoji take 2 columns,
 * combining characters and variation selectors zero. The sum over a grapheme's characters is an upper bound, because
 * the set of double characters covers the whole set of wide East Asian Width ones (with excess). Two exceptions to
 * zero, both upward: U+FE0F (emoji presentation, e.g. "❤️" = 2) and U+20E3 (keycap, "1️⃣" = 2).
 * Overestimating the width does not lower the result, because wrapping in `upper` mode is monotonic
 * (`server/test/dialog-guard.test.ts`, property test).
 */
export function codePointWidth(char) {
  if (char === '\t') return TAB_COLUMNS;
  if (char === '️' || char === '⃣') return 1;
  if (ZERO_WIDTH.test(char)) return 0;
  if (DOUBLE_WIDTH.test(char) || (char.codePointAt(0) ?? 0) >= 0x2E80) return 2;
  return 1;
}

/** Text width in terminal columns: the sum of {@link codePointWidth}. */
export function displayWidth(text) {
  let columns = 0;
  for (const char of text) columns += codePointWidth(char);
  return columns;
}

/**
 * ONE line of text (without `\n`) wrapped to `columns` columns. Two modes:
 *
 * - `cli`: the layout model from the phone and Mac captures (breaks their frames line for line). A word
 *   longer than the frame starts in the current row, unless starting on a new one saves a cut.
 * - `upper`: the same, but a word longer than the frame ALWAYS starts on a new row. The estimate
 *   uses this mode: it gives an UPPER bound for both variants and is monotonic in
 *   word widths. The `cli` mode is not monotonic: a word exactly the frame's width after a full
 *   row takes two rows (the space gets its own), and one a column longer takes one.
 */
function wrapLine(line, columns, mode) {
  const rows = [''];
  let used = 0;
  const push = (start) => {
    rows.push(start);
    used = displayWidth(start);
  };
  const append = (text) => {
    rows[rows.length - 1] += text;
    used += displayWidth(text);
  };
  line.split(' ').forEach((word, index) => {
    const width = displayWidth(word);
    if (index !== 0) {
      // A full row before a space: the space opens a new row and TAKES a column in it. The screen
      // does not show it, but the layout counts it: without it the next word would fit where
      // the capture already breaks (`dialog-bash-uciety-naglowek-2.1.294`, row
      // `"$UDID" 2>/dev/null || true; xcrun simctl delete "$UDID"`).
      if (used >= columns) push('');
      append(' ');
    }
    if (width > columns) {
      if (mode === 'upper') {
        if (used > 0) push('');
      } else {
        const breaksHere = 1 + Math.floor((width - (columns - used) - 1) / columns);
        const breaksNext = Math.floor((width - 1) / columns);
        if (breaksNext < breaksHere) push('');
      }
      // Cutting character by character: a character that does not fit opens a new row,
      // and so does a row filled in the middle of a word.
      const chars = [...word];
      chars.forEach((char, at) => {
        if (used + codePointWidth(char) > columns) push(char);
        else append(char);
        if (used === columns && at < chars.length - 1) push('');
      });
      return;
    }
    if (used + width > columns && used > 0 && width > 0) push('');
    append(word);
  });
  return rows;
}

/**
 * Multi-line text wrapped to `columns` columns: screen rows (an empty line = 1 row).
 *
 * @param {'upper' | 'cli'} [mode] `upper` (default): an upper bound for the estimate; `cli`:
 *        the layout model from captures, for comparisons with captures
 */
export function wrapText(text, columns, mode = 'upper') {
  return text.replace(/\r\n?/gu, '\n').split('\n').flatMap((line) => wrapLine(line, columns, mode));
}

/** How many rows a multi-line text wrapped to `columns` columns takes (mode as in {@link wrapText}). */
export function wrappedRows(text, columns, mode = 'upper') {
  return wrapText(text, columns, mode).length;
}

/**
 * Height estimate of a `Bash` permission dialog: housing + margin + description + command.
 *
 * @param {string} command `tool_input.command`
 * @param {string | undefined} description `tool_input.description` (absent = no description line)
 * @param {number} [frameColumns] width of the command and description frame; the phone by default ({@link
 * FRAME_COLUMNS})
 * @returns {{rows: number, commandRows: number, descriptionRows: number}}
 */
export function estimateDialogRows(command, description, frameColumns = FRAME_COLUMNS) {
  const commandRows = wrappedRows(command, frameColumns);
  const descriptionRows = description === undefined || description === ''
    ? 0
    : wrappedRows(description, frameColumns);
  return {
    rows: FRAME_ROWS + FRAME_RESERVE_ROWS + descriptionRows + commandRows, commandRows, descriptionRows,
  };
}

/**
 * How many command lines fit a dialog with budget `budget` and a one-sentence description: the number for the message.
 */
export function commandRowsHint(budget) {
  return budget - FRAME_ROWS - FRAME_RESERVE_ROWS - 1;
}

/** {@link commandRowsHint} for the phone budget. */
export const COMMAND_ROWS_HINT = commandRowsHint(BUDGET_ROWS);

/**
 * Pane row margin above the budget: the same as between {@link PHONE_ROWS} and {@link BUDGET_ROWS}
 * (the queue marker "k of N", the new messages bar, an unknown CLI warning).
 */
export const PANE_ROWS_MARGIN = PHONE_ROWS - BUDGET_ROWS;

/**
 * THRESHOLD of the pane budget: the smallest dialog the refusal message asks to send: housing, margin,
 * a one-sentence description and one command line (18 rows, so a pane from 22 rows). Below it every
 * `Bash` call with a description would get a refusal, and the hint "each up to ~0 lines": the model would have
 * no way to comply, so the guard falls back to the phone budget (`floor`).
 */
export const MIN_BUDGET_ROWS = FRAME_ROWS + FRAME_RESERVE_ROWS + 1 + 1;

/**
 * The narrowest pane on which the estimate makes sense: a 16-column frame. Narrower = `floor` (phone budget and
 * wrapping), for the same reason as the row threshold: a sanity limit, not a measurement.
 */
export const MIN_PANE_COLUMNS = 20;

/** The largest `COLUMNS`/`LINES` value the guard takes as pane geometry (above it: garbage). */
export const PANE_MAX = 1000;

/** Budget sources: the pane from `COLUMNS`/`LINES`, the phone (no geometry), the phone under the threshold. */
export const BUDGET_SOURCES = Object.freeze(['pane', 'phone', 'floor']);

/** A number from `COLUMNS`/`LINES`: digits only, no leading zero, 1..{@link PANE_MAX}; otherwise `null`. */
function paneDimension(raw) {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,3}$/u.test(raw)) return null;
  const value = Number(raw);
  return value <= PANE_MAX ? value : null;
}

/**
 * Pane geometry from the hook's environment variables. Both must be valid: half a geometry is a
 * sign that the environment does not come from the CLI, so `null` (phone budget).
 *
 * @param {unknown} columns `process.env.COLUMNS`
 * @param {unknown} lines `process.env.LINES`
 * @returns {{columns: number, rows: number} | null}
 */
export function paneFromEnv(columns, lines) {
  const cols = paneDimension(columns);
  const rows = paneDimension(lines);
  return cols === null || rows === null ? null : { columns: cols, rows };
}

const isPaneDimension = (value) => Number.isInteger(value) && value >= 1 && value <= PANE_MAX;

/**
 * The guard's budget for a pane.
 *
 * - `pane`: budget `min(44, rows − 4)`, wrapping at `min(62, columns) − 4`. Above the threshold
 *   the budget grows with the rows (a lower pane never gets more than a taller one) and never
 *   exceeds the phone, and the frame is never wider than on the phone.
 * - `phone`: no geometry, or a bad one: phone constants.
 * - `floor`: a pane below the threshold ({@link MIN_BUDGET_ROWS}, {@link MIN_PANE_COLUMNS}): phone constants.
 *   The dialog will not fit anyway, and a refusal would not give the model advice it can follow.
 *
 * @param {{columns: number, rows: number} | null | undefined} pane geometry or its absence
 * @returns {{source: 'pane' | 'phone' | 'floor', budget: number, frameColumns: number,
 *            commandRowsHint: number, paneRows?: number, paneCols?: number}}
 */
export function dialogBudget(pane) {
  const phone = (source) => ({
    source, budget: BUDGET_ROWS, frameColumns: FRAME_COLUMNS, commandRowsHint: COMMAND_ROWS_HINT,
  });
  if (pane === null || typeof pane !== 'object' || !isPaneDimension(pane.rows) || !isPaneDimension(pane.columns)) {
    return phone('phone');
  }
  const geometry = { paneRows: pane.rows, paneCols: pane.columns };
  const budget = Math.min(BUDGET_ROWS, pane.rows - PANE_ROWS_MARGIN);
  if (budget < MIN_BUDGET_ROWS || pane.columns < MIN_PANE_COLUMNS) return { ...phone('floor'), ...geometry };
  return {
    source: 'pane',
    budget,
    frameColumns: Math.min(PHONE_COLUMNS, pane.columns) - 3 - 1,
    commandRowsHint: commandRowsHint(budget),
    ...geometry,
  };
}

/**
 * The guard's verdict for the `tool_input` of a `Bash` permission.
 *
 * @param {unknown} toolInput `tool_input` from the payload
 * @param {{columns: number, rows: number} | null} [pane] pane geometry ({@link paneFromEnv});
 *        absent = phone constants
 * @returns `null`: the dialog fits, or the input does not have the shape of a `Bash` permission (the command is not
 *          a string, the description is present but not a string): the hook then behaves as without the guard.
 *          An object: a form refusal: the reason (`rows` = the whole dialog too tall, `header` = the description alone
 *          pushes the title out of the parser's reach), numbers from the budget ({@link dialogBudget}) and a message
 *          for the model.
 */
export function tallDialogVerdict(toolInput, pane = null) {
  if (toolInput === null || typeof toolInput !== 'object') return null;
  const command = toolInput.command;
  const description = toolInput.description;
  if (typeof command !== 'string') return null;
  if (description !== undefined && typeof description !== 'string') return null;
  const budget = dialogBudget(pane);
  const estimate = estimateDialogRows(command, description, budget.frameColumns);
  const tooTall = estimate.rows > budget.budget;
  const headerTooTall = estimate.descriptionRows > MAX_DESCRIPTION_ROWS;
  if (!tooTall && !headerTooTall) return null;
  const reason = tooTall ? 'rows' : 'header';
  return {
    reason,
    rows: estimate.rows,
    budget: budget.budget,
    budgetSource: budget.source,
    ...(budget.paneRows === undefined ? {} : { paneRows: budget.paneRows, paneCols: budget.paneCols }),
    frameColumns: budget.frameColumns,
    descriptionRows: estimate.descriptionRows,
    maxDescriptionRows: MAX_DESCRIPTION_ROWS,
    message: denyMessage(reason, estimate.rows, estimate.descriptionRows, budget),
  };
}

/**
 * Refusal message for the MODEL (it reaches it as a tool result with an error). It says plainly that this is not a
 * block of the operation, and asks to split the work into calls ONE AFTER ANOTHER: parallel permissions stand in the
 * dialog queue, which Rarog cannot show. The numbers (budget, command lines and width) come from the same budget as the
 * decision; the pane is called a pane only with a budget from its geometry.
 *
 * @param {ReturnType<typeof dialogBudget>} [budget] the phone by default
 */
export function denyMessage(reason, rows, descriptionRows, budget = dialogBudget(null)) {
  const intro = 'This is NOT a block on this operation. The Rarog hook rejected only the FORM: ';
  const pane = budget.source === 'pane'
    ? `the terminal pane where this session runs (${String(budget.paneCols)}×${String(budget.paneRows)})`
    : null;
  if (reason === 'header') {
    return `${intro}${pane === null ? 'on the phone' : 'in the pane'}, the description (\`description\`) `
      + `takes ~${String(descriptionRows)} rows, `
      + `and the permission dialog header holds ${String(MAX_DESCRIPTION_ROWS)}. Shorten the description to one `
      + 'sentence and make the same call again. Shortening the description is expected here and is not '
      + 'circumventing a block.';
  }
  const screen = pane ?? 'the phone screen from which the user approves permissions';
  return `${intro}the permission dialog would take ~${String(rows)} rows, and ${screen} `
    + `holds ${String(budget.budget)}. Do the same thing in shorter calls, ONE AFTER `
    + 'ANOTHER (wait for the result of the previous one, do not send them in parallel): change files with the '
    + 'Edit/Write tools instead of scripts in Bash, split steps (build, test, export) into separate Bash calls, '
    + `each up to ~${String(budget.commandRowsHint)} lines of at most ~${String(budget.frameColumns)} characters, `
    + 'and the description (`description`) in one sentence. Splitting is expected here and is not circumventing '
    + 'a block.';
}
