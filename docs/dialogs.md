# Claude Code dialogs

This document covers how Rarog recognizes Claude Code dialogs in herdr panes (tool permissions, `AskUserQuestion`
questions, the plan, CLI dialogs) and how it answers them from the phone. A pane is a herdr terminal pane that runs
`claude`; herdr is the terminal multiplexer Rarog attaches to. Power boundaries: `docs/security-model.md`, "herdr
sessions: Rarog writes to a terminal it does not own".

**In short.** Rarog sees a dialog on the pane SCREEN and learns what it is about from the jsonl TRANSCRIPT and from
the HOOK DUMP (a file the permission hook writes). The card content comes from the transcript or the hook, the option
digit from the screen, and any disagreement ends in a card with only Deny. Only the screen parser and its signature
registry know what the CLI looks like; the fixtures show after a Claude Code update whether that look changed
("After a Claude Code update").

## Sources

- **Pane screen** (`agent.read` from herdr, source `detection`). The only source of option digits and the only proof
  that a dialog really stands. Parser: `server/src/herdr/dialogs/screen/`.
- **jsonl transcript**, read incrementally by the follower `server/src/herdr/jsonl-follow.ts`. The pending tool
  tracker (`server/src/herdr/jsonl-pending.ts`) returns the FIRST `tool_use` without a `tool_result`; a human message
  closes all of them. On CLI 2.1.267 and newer the `tool_use` entry is in the file before the dialog shows. One read
  of new bytes has the cap `FOLLOW_MAX_READ_BYTES` (16 MiB). The follower skips a larger increment and treats it as
  lost continuity: the pending tool, background tasks and the echo window reset, the transcript gets `GAP_MESSAGE`,
  and `server.log` a `skipped … B` line. Safe direction: a card from jsonl is lost, a phantom card never appears.
- **Hook dump** (`scripts/hooks/rarog-pending.mjs` → `<dataDir>/pending/<session>.json`, reader
  `server/src/herdr/dialogs/hook/dump.ts`). `PermissionRequest` writes it on every permission dialog (full
  `tool_input`, no `tool_use_id`, one file per session, TTL 10 min; a question form up to the hook `timeout` (24 h),
  `Bash` 60 min, and a `Bash` dump older than 10 min gets the dump flag `stale` and counts only with proof from the
  screen, "Flow" item 2; the hook copy state `stale` in `/health` is another thing, "Permission hook: installation and
  channel state"), `PreToolUse` for `AskUserQuestion`. A subagent request carries `agentId` (`agent_id` from the
  payload); Rarog uses it only for the refusal log. The dump also carries the call's `cwd` from the payload (absolute
  path; a bad shape drops only the field): the match of an `Edit` dump with the dialog header rests on it ("Permission
  dialog operation"). A jsonl entry carries no `cwd`. The hook is installed by hand ("Permission hook"). A dump is a
  hint, not proof. With a QUEUE of dialogs ("1 of 2": several calls at once, such as two background subagents) the
  hook fires when a request enters the queue, not when its dialog reaches the screen: the second request's dump
  overwrites the first one's while the screen shows the first (CLI 2.1.302; the "k of N" marker stands in the dialog
  title line, so a frame cut at the top hides it). For a tool permission the hook also writes a per-call dump
  `pending/<session>/<key>.json` with `inputSha256` ("Per-call dump and shadow mode"); the server reads it only in
  shadow mode.
- **CLI session registry** `~/.claude/sessions/<pid>.json` (`server/src/cli-version.ts`), read every 1.5 s:
  `status: waiting` wakes a screen read when herdr reports `working` over a dialog.
- **herdr status** (`blocked`) and the driver's fallbacks (one after `/rename`, one from the CLI registry) give the
  effective blocked state (`#blockedNow` in the driver).

## Flow: from a blocked pane to a digit

1. **Trigger.** `blocked` from herdr, a `pending` event from the follower, the evaluation timer every 4 s over a
   standing blocked state, a signal from the CLI registry, the `/rename` fallback, a CLI permission dialog from the
   supervisor. All end in an evaluation, `#evaluateOnce` in `server/src/drivers/herdr-driver.ts`.
2. **Read.** Screen (`#readDialog`), pending jsonl entry, hook dump (`#hookPending`). With a jsonl entry present, the
   dump enters when it is a matching `AskUserQuestion` form (`hookMatchesPending`) or COMPETES with the entry: a
   `PermissionRequest` dump of another call that is not older (`competingHook`), or a `Bash` dump of another call
   OLDER than the entry (`olderBashHook`), which is a subagent permission whose call has no entry in the main file
   while the main agent runs its own tool alongside.
   The evaluation identity is `evaluationReqId`, built from source ids: a jsonl entry has its `tool_use.id`, a
   `PermissionRequest` dump `hook:<at>`, the time of its write (the dump GENERATION). The first part is the card
   source, the part after `~` the other source: with competition the dump leads (`<dump>~<entry>`), with a doubly
   proven `Bash` the entry leads and the dump is its second proof (`<entry>~<dump>`). A dump that arrives after the
   first evaluation therefore gives a new evaluation instead of a stop at the "same card" gate. With a `Bash` dump
   older than the entry the evaluation identity is the entry alone. A card from a dump older than the entry, and a
   card from a younger `Bash` dump the screen decided for, have the dump's own identity (`hook:<generation>`), so
   the main agent's next tools do not replace it and two dialogs shown one after another under the same sources have
   different identities.
   A `stale` `Bash` dump (older than 10 min) enters the read only when the screen proves it by itself (`admittedHook`
   in `decide/sources.ts`, the condition from item 4); without proof the evaluation goes as without a dump. A subagent
   permission can wait in the queue longer than 10 min, and the hook fires once, when the CLI decides to ask (CLI
   2.1.318). A `stale` dump with proof whose command differs from the standing card's command (`ActiveReq.command`)
   passes the "same card" gate (`staleDumpProvesOther`): that is a desk decision (a key pressed in the terminal
   itself, not sent by Rarog) on the dialog ahead in the queue, and the dump's dialog card gets the dump's own
   identity.
3. **Decision.** The pure function `decideCard` (`server/src/herdr/dialogs/decide/decide.ts`) runs gates in a fixed
   order: a screen-only dialog (sandbox network) → competing sources (`settleCompeting`: the screen checks the jsonl
   entry and the dump by name and content; both match → a card without buttons; the same non-`Bash` tool without
   the entry content on screen → also a card without buttons; item 4) → screen recognition and cross-check
   (`resolveOptions`) → one read retry → shield after an answer by file (after a question answered through the hook
   file, the same questions in the same blocked state get no new card until a dump with another answer key comes,
   `ANSWERED_HOOK_SHIELD_MS`) → hook channel card (question) → `ok` card
   with content from jsonl or hook → form review screen → multi-select from the hook → the same card (no flicker) → a
   card built from the screen (question, confirmation, generic permission; a confirmation from the `TERMINAL_DIALOGS`
   list without any button, "CLI dialogs answered in the terminal") → a dialog from the closed list `KNOWN_DIALOGS`
   (recognized only in the dialog block, "Dialog block") → a card without buttons (`degradedCard`).
4. **Cross-check** (`resolveOptions`, `herdr/dialogs/screen/resolve.ts`). The dialog kind from the screen must agree
   with the tool from jsonl or the hook, and a tool permission requires the LITERAL name from the dialog BLOCK
   ("Dialog block"): the title under the top rule from a closed map ("Bash command", "Edit file", "Fetch"…), the
   rule line under the operation frame (`Ask rule Name(…)`, on CLI 2.1.328 `Rule Name(…) from …`), and for MCP the
   server AND the tool title under "Tool use".
   A `⏺ Bash(…)` line is not a name. The `Write` question under the frame with the header above the screen edge
   names the dialog for display only: with a matching name it gives `mismatch` with reason `operation` ("Dialog
   block", `Write` with its header above the screen edge). A different name gives `mismatch`, an ambiguous block
   `mismatch` with reason `ambiguous`. A missing name gives `mismatch`, with one exception: `Bash` with its header
   above the screen edge passes with double proof (a jsonl entry and a hook dump with literally the same command,
   shown by the frame). With an operation frame on screen a `Bash` permission must show in it the command of the card
   source, otherwise `mismatch` with reason `operation`; a frame cut at the top is enough only with double proof.
   A `Write` or `Edit` card from a jsonl entry or a hook dump needs the screen to prove the call
   (`ExpectedDecision.fileCall`, `fileCallShown` in `screen/edit-frame.ts`): the header path resolved against the
   directory (the dump's `cwd`, for a jsonl entry the session directory the driver passes as `DecideInput.cwd`) gives
   `file_path`, and the frame shows that content or that edit literally ("Create file" only; "Overwrite file" never
   proves; a wrapped line only under the measured geometry, "Permission dialog operation"), otherwise `mismatch`
   with reason `operation`.
   Dump against screen: `hookMatchesScreen` (for framed `Bash` `commandMatches`, for `Edit` `editMatchesOperation`
   with that dump's `cwd`, "Permission dialog operation") and `hookQuestionFrom`
   (`server/src/herdr/dialogs/cross-check.ts`).
   A `Bash` dump older than the entry wins only with the WHOLE frame (`bashFrameProven` in `decide/sources.ts`): the
   entry does not match the screen, the block title is `Bash` (a title with the "k of N" counter misses the map, so
   the title under the counter and `Ask rule Bash(…)` count), the top rules of dialog and frame are visible, and the
   frame equals the dump's whole command. A cut frame or no visible title gives `mismatch`: such a dump is never a
   second proof. The same condition admits a `stale` `Bash` dump (item 2).
   An entry and a dump of the SAME non-`Bash` tool: the name does not tell two calls apart, so the entry wins only
   when the screen POSITIVELY confirms its content (`screenConfirmsInput`: the start of the `command`, `file_path`,
   `url` or `pattern` field; for `Edit` the header path and the frame diff, which a relative path never confirms
   without `cwd`; for a plan the plan file name). An input without such a field (`NotebookEdit`, typical MCP)
   confirms nothing. Otherwise the card has no buttons, as with "both match", and carries the entry's call
   fingerprint (`callPrint`), so Deny on it sets the post-decision shield (item 6). An `Edit` entry drops out only when
   the screen CONTRADICTS it (`editContradictsScreen`: the header path cannot point at its `file_path` from any
   directory). Different tool names and `Bash` keep the rules above.
   Plan exception (`planAddedByCli` in `cross-check.ts`): an `ExitPlanMode` entry without `plan` and `planFilePath`
   and a dump with the same input plus both fields added by the CLI are one call. When the dialog footer shows the
   dump's plan file name (`ctrl+g to edit … · ~/.claude/plans/<name>.md`), the card source is the dump: plan, buttons,
   the dump's fingerprint and the identity `<dump>~<entry>`. Otherwise the card has no buttons.
5. **Card** (`server/src/herdr/dialogs/cards/build.ts`): `decisionCard` (content from jsonl or hook),
   `screenPermissionCard` and `screenQuestionCard` (from the screen), `screenDialogCard` (known dialogs),
   `degradedCard` (no buttons, `input: null`, so the manager gives red risk and only Deny; on a name mismatch it
   carries the name from the screen). The card's own sentences come from the sentence registry in English: the
   degraded card text (`dialogs.degraded-display`, `dialogs.degraded-unreadable` in `dialogs/copy.ts`) and the
   fallback question of a screen card without question text (`dialogs.fallback-question.<kind>`); the 422 refusal
   says `dialogs.refuse.<reason>`. A screen-only card for a framed permission gets buttons only when the whole
   dialog is on screen; cut at the top, it is a snippet card without buttons. This holds for any identity and also
   for a frame without the `│` bar (`Write` content, `Edit` diff) that `operationAbove` does not read: its header
   is above the edge by `headerAboveEdge`, so `parseOptions` gives no question and neither the screen-only
   card nor the screen fallback after a hook dump gets a permission form. Any permission form from the screen also
   needs the top of the dialog block: the block rule above the options with a title or tool header line under it
   (for a plan dialog, the question under its rule). A screen that starts at the question, with the header and the
   whole frame above the edge, has no frame for `headerAboveEdge` to see and still gets no form. A framed
   permission card remembers a fingerprint of the dialog content (`ActiveReq.bodyPrint`), a plan dialog card the
   fingerprint of the plan file name (a screen card also has the name in `reqId`, because two plans can have the
   same question and options), and question, confirmation and known dialog cards the block fingerprint ("Dialog
   block").
   A card without buttons from the jsonl or hook path has the identity `degradedReqId`: the base id (`decideReqId`:
   `tool_use.id`, the dump id, or `screen:<blocked state number>` for a screen dialog) plus `:d:` and a hash of the
   tool name from the screen, so the timer keeps reading the screen under it: a dialog that became readable gets a card with
   buttons. The two cards from competing sources (item 4) keep the bare base and stand until the sources change.
   A card without buttons over a screen without digit options (a slash command view, a trust dialog the trust parser
   rejects, login) shows the dialog block, not the screen tail (`server/src/herdr/dialogs/screen/excerpt.ts`): from the
   first non-empty line under the lowest `▔▔▔` rule (also a status rule, `▔▔▔ ◐ medium · /effort ▔`) or a `───` rule
   with a key line under it, to the bottom of the screen. The screen tail (the last 40 lines, at most 2000 characters)
   stays when there is no rule, when the block exceeds that cap, when the prompt field is visible, and on a refusal card
   from a hook dump. The block's first line enters the card identity ("Card identity" in "CLI dialogs answered in the
   terminal"). `RAROG_DIALOG_LAYER2=1` raises the block cap and refreshes it under the same card ("Block card without
   digits").
   Replacing a card leaves in the app, for 6 s, the trace "The permission request expired."
   (`cards.permissionExpired`; `permission-cleared` → `expired`). The event goes to the manager
   (`server/src/sessions/manager.ts`) and from there in an SSE frame to the app.
6. **Answer.** `respondPermission` / `answerQuestion` in the driver. A question with the `hook` channel goes by file
   `<dataDir>/answers/…` (`server/src/herdr/dialogs/hook/answers.ts`), everything else by digit. Before the digit
   `#digitStillHolds` reads the screen once more and checks the label and digit, the dialog kind and identity from
   the block (`ActiveReq.dialogIdentity`; an ambiguous block never passes), the fingerprint the card carries
   (`bodyPrint` of a framed dialog, the plan file name or the block), the generation of the hook dump that gave the
   card its content or second proof (`proofHookAt`), and for screen cards the whole card (`#sameScreenPermission`).
   In an `AskUserQuestion` form with a preview the digit only moves the `❯` highlight, so the form then gets `enter`
   by a separate path (`server/src/herdr/dialogs/send/form-submit.ts`): only after a fresh screen shows `❯` on the
   chosen label, at most once per decision, without retries. `enter` is not on the allowed key list
   (`ALLOWED_KEYS` in `server/src/herdr/dialogs/send/keys.ts`: `escape`, `ctrl+c`, digits), so no other path can
   confirm by position.
   After a successful digit or `escape` the driver drops the session's hook dump (`#clearHookAfterDecision`), except a
   question form dump that still stands and a `Bash` dump of ANOTHER dialog (`otherDialogDump`: the whole frame before
   the key shows the decided card's command, and the dump has another). That is a subagent permission queued behind
   the decided dialog: the hook fires once, so without the dump its dialog would come up without buttons.
   The same key sets the **post-decision shield** (`#decided`, `DECIDED_SHIELD_MS` = 8 s, `DecideInput.decided`): in
   the same blocked state the evaluation does not put up again a card Rarog has just decided. It recognizes it by
   `reqId` and, when that changed (a dropped dump, a card from a late jsonl entry), a tool permission by the call
   fingerprint (`callPrint`: name and canonical JSON of the input) or by the same dialog on screen (`screenFormReqId`
   or `bodyPrint`); a question only by `reqId` with the tab fingerprint, so the next tab gets a card. It also puts up
   no card without buttons for a closing dialog or the same dialog still standing; another readable dialog gets a card
   at once. The driver records the shield snapshot (blocked state number, dump generation, fingerprints of the screen
   the digit or `escape` went to, the jsonl entry) BEFORE the key. A card without buttons has no fingerprint of its
   own, so after Deny on it only the screen fingerprint recognizes the same dialog still standing.
   The shield is lifted by a new blocked state, another jsonl entry, a new `PermissionRequest` dump generation,
   another tab and the deadline. For a card from a dump, an entry YOUNGER than the dump is a live main agent tool next
   to a subagent permission and does not lift the shield (`pendingYounger`). A dump of another dialog that the
   decision kept does not lift it either (`keptHookAt`); its dialog passes with another identity and fingerprint.
   A hook answer channel card has no shield (the answer by file has its own). Price: a call with identical content in
   the same blocked state without a new dump or jsonl entry, and a digit the CLI lost, get a card up to 8 s late.
7. **Refusal.** Every card without buttons and every send refusal goes to the log (`degrade` / `refuse` in
   `herdr-audit.log`, `server/src/herdr/audit.ts`) and to a dump in `<dataDir>/refusals/` (`dialogs/refusals.ts`),
   together with the case SHAPE ("Case shape in the log").

## Permission dialog operation

On CLI 2.1.286 and newer the permission dialog draws what the human approves (a `Bash` command, an `Edit` diff, the
`Write` content) in a frame of dashed `╌╌╌` rules under the header ("Bash command (unsandboxed)" plus a
description), above the question and the options. A multi-line operation has a `│` bar on the left. The parser
returns it in `ScreenDialog.operation` (`server/src/herdr/dialogs/screen/operation.ts`):

- `complete`: the top `╌╌╌` rule is visible, so the whole frame is; `headerVisible`: the top solid `────` rule of the
  dialog is visible too, so the header and the description are. A long command in a narrow pane (a phone in Blink)
  pushes the header and the start of the frame above the screen edge; the CLI does not truncate the command
  (measurement `zgoda-bash-wysoka`, CLI 2.1.295).
- `commandMatches(operation, command)`: whether the frame shows this command. Inside a frame line characters,
  spaces included, compare literally (the indent at the line start is free). At line boundaries: when the next word
  would have fit on the previous line, the break must be a new line of the command; after a full-width line the CLI
  may have cut a word (any whitespace run, also empty); otherwise a space or a new line. Frame width: the pane rule
  minus the left margin and one column (wide characters count double). A whole frame must equal the whole command,
  a cut frame the end of the command, at least 40 non-whitespace characters. A tab drawn as spaces or control
  characters give a refusal.
- `header`: the non-empty header lines between the dialog's top rule and the frame's top rule (title, file path,
  description), raw, with the left margin; an empty list when the header is not wholly visible. A framed card takes
  its header from here too (`framedDialogText`).
- `editMatchesOperation(input, operation, cwd)` (`screen/edit-frame.ts`): whether an `Edit` dialog shows this edit.
  Under the title "Edit file" the dialog draws the file path relative to the call's directory (a file outside it:
  shape unmeasured), and in the frame a diff: line number, space, marker ` `/`+`/`-`, content; a long line breaks
  hard, and the continuation has an empty number field and the same marker (measurement `zgoda-edit-2.1.293`, screen
  from CLI 2.1.317; the line pattern `editDiffLine` in the signature registry; wrapped lines: below). A match
  requires the whole frame under a visible two-line header (title and path), a path that, resolved against the
  call's `cwd` (or `~/…`, or absolute), gives the absolute `file_path`, and a diff in which replacing `old_string`
  with `new_string` on the old side (context and `-`) gives the new side (context and `+`). `cwd` is
  `PendingTool.cwd` of that source (hook dump
  only); `fileCallShown` gives a jsonl entry the session directory instead. A `file_path` ending in whitespace gives
  a refusal, because the screen trims it at the line end.
  `hookMatchesScreen` takes the frame only from a dialog whose block title is `Edit` and without a queue counter
  ("k of N"). The path comes from one line without the margin, unjoined and untrimmed: a wrapped path or a third
  header line gives a refusal.
- Kind of a file dialog (`screen/file-dialog.ts`): an `Edit` or `Write` dialog asks about its file, not "Do you
  want to proceed?", so "Tab to amend" in the key footer is its only kind marker. A narrow pane cuts the footer with
  `…` (after the `replace_all` note "One-time Yes only: places not shown" at 57 columns, CLI 2.1.330,
  `kontrolny/zgoda-edit-wrap-hunks-57-2.1.330`) or wraps it ("Tab to" and "amend" on two rows, CLI 2.1.328,
  `queue/measured/zabranie-dialog-przed-2.1.328`). Such a dialog is still a permission (`tool`, title identity) when
  the block title is "Edit file", "Create file" or "Overwrite file", the frame right above the options is whole under
  the dialog's own two-line header (it starts with the block title line), and only the file question about the
  header's file stands between the frame and the first option ("Do you want to make this edit to <name>?", "Do you
  want to create <name>?" or "overwrite", also wrapped). A block with one of these titles is never a confirmation:
  its question reads as one, and a confirmation card would approve the file without the diff. Any other shape under
  such a title (a header of more than two lines, for instance a header path the pane breaks over two rows; another
  line in that zone; a question about another file or the other tool's question) keeps the kind `other` without
  a form: the screen-only card has no approve button, and a pending call from jsonl or the hook dump ends in
  `mismatch/kind`. It does not become a permission either, because then the pending call would reach the frame
  proofs, which do not read the zone. Other tools without the marker are not covered ("Known gaps").
- Content rule for `Edit` and `Write` (`frameFileLines`, `editDiffSides`, `editExplainsDiff`, `createdLines`,
  `contentLines`): a line of the file is one frame row, or several rows when the frame wraps it (below), and the
  content compares literally. Spaces inside a line, the indent and line boundaries count, so `rm -rf / safe` on
  screen is not `rm -rf /safe` in the call. Only one final newline of a `Write` and a single `\r` right before `\n`
  (CRLF) are left out.
- Whitespace at the end of a line is never proven. The screen draws it as an empty cell and the read trims the row
  end, so `printf '%s\n' safe \` and the same line with a space after the backslash (another script) look the same.
  Content with whitespace at the end of any line (a space, a tab, a `\r` not followed by `\n`, any other whitespace)
  gives a refusal, and a frame row proves only its line without such whitespace. For `Write` that is every line of
  `content`, the last one too. For `Edit` every piece of `old_string` and `new_string` before a newline ends a line of
  the file and is checked directly. The last piece ends where the call text ends, often inside a line (`foo ` taken
  from `foo bar`), where a space is visible, so the literal comparison decides: neither side of the diff has
  whitespace at a line end, so a replacement result with it does not match.
- A line the frame wraps joins back from its rows only under the measured geometry (`frameFileLines`,
  `FILE_FRAME_GEOMETRY` in the signature registry, CLI 2.1.330, `kontrolny/zgoda-edit-wrap-…` and
  `kontrolny/zgoda-write-wrap-…`). C is the frame rule width and d the digits of the largest line number in the
  frame. The number field is d columns wide for `Edit` and d + 1 for `Write`, right-aligned after one margin column,
  and the content starts at column index d + 3. The content width is W = C − 3 − d for `Edit` and W = C − 4 − d for
  `Write`. The CLI breaks a longer line hard after W characters, inside a word too, and each further row has a blank
  number field and the same marker. The formula alone is not trusted, because a frame from another version or
  terminal layout can be narrower (`measured/zgoda-write-dluga-linia-2.1.322` is two columns short of it). So the
  frame must hold a row exactly W wide, and a row wider than W gives a refusal.
  A space at column W is an empty cell that the read drops, and a space at W + 1 is the first cell of the next row:
  the two give different screens. A row that does not end its line is therefore padded with spaces to W.
  Every character of a wrapped line must be on a closed list measured at one column: printable ASCII and six
  measured Polish letters in NFC (`wrapChars` in `FILE_FRAME_GEOMETRY`). The list leaves out what the screen cannot
  tell from a space or misplaces: a no-break space at W looks like a space, a wide character with one free cell
  moves to the next row and leaves an empty cell, a combining mark shares the cell of its letter, and a zero-width
  space shows as U+FFFD.
  A refusal also follows from a continuation that reads as a numbered row once the margin is gone (`42 -x`), a
  continuation as the first row or under a number-only row, a marker other than its line's, and a number field of
  another width. A tab is drawn as spaces, so content with a tab gives a refusal too. An empty row and a row outside
  the line pattern give a refusal, as does a row without the left margin (the `replace_all` note "The diff doesn't
  show all of what this edit changes" stands in the frame without it).
- The comparison is linear in the length of the call: it splits at newlines and uses `trimEnd`, with no regular
  expression that backtracks over a run of spaces, because a jsonl entry or a hook dump has no length limit. For one
  `Edit` replacement only the positions where the common start and end of both sides fit are checked.
- `editContradictsOperation(input, operation)`: whether an `Edit` dialog CONTRADICTS the call, without `cwd`: the
  relative path is not an end of `file_path` along whole segments (absolute and `~/…` compare directly). An unknown
  (a cut dialog, another header shape, an input without `file_path`, `..` in the path) does not contradict. A diff
  proves no contradiction: a real edit can be unexplained (a wrapped line the frame does not prove, a tab,
  whitespace at the end of `old_string` at a line end), and an `old_string` with unchanged lines reaches past the
  hunk context. It only rules out a jsonl entry, never proves.
- `writeMatchesOperation(input, operation, cwd)`: whether a `Write` dialog shows this write. The header has the
  same shape and path rule as `Edit`. Under "Create file" the frame shows the new file: line number, space,
  content, no diff marker (signature `writeContentLine`, measurements `zgoda-write-2.1.322`,
  `zgoda-write-falszywy-naglowek-2.1.322` with an indented line). The rows must be numbered from 1 without gaps, and
  under the content rule above they must be the lines of the WHOLE `content`; the bottom rule of the whole frame ends
  the file. "Overwrite file" never proves the write. It shows a diff of the old and new file in the `Edit` diff shape
  (`zgoda-write-nadpisanie-2.1.322`), and nothing in it shows that the diff covers the whole file: a single hunk
  (lines 50–51, or from line 1 with the rest of the file not drawn) has a new side equal to a stale, shorter content.
  The measured frame changes every line, so it does not show how many context lines the CLI draws. Another title,
  another frame row or an input without `file_path` and `content` gives a refusal.

A dialog without a `╌╌╌` frame (MCP, question, plan) has `operation: null`.

## Dialog block

The tool name, the known dialog and the card identity come only from the dialog BLOCK the CLI draws. The agent or the
model writes the `⏺ Tool(…)` line, the call description, the command, the option labels and the scrollback, so none
of them names a dialog: a "Switch model" in the scrollback must not turn a `Bash` permission into the `model` dialog,
and a "Read file" in a description must not rename it to `Read`. Code: `dialogBlock` and `toolNaming` in
`server/src/herdr/dialogs/screen/block.ts`, `blockKnownDialog` in `screen/known.ts`; guard
`server/test/blok-dialogu-guard.test.ts`; blocks of real CLI dialogs in the control set fixtures
(`server/test/fixtures/herdr/kontrolny/`, "Control set").

- **Block.** A block rule is a line made only of `─` or `▔` (at least 8), in any column. Above the first option the
  parser collects every pair "rule + first non-empty line under it" (a box edge `╭──╮` is skipped) in which that line
  is a title from a closed list: the permission title map (`TOOL_DIALOG_HEADERS` and the pattern `Use skill "…"?`;
  the agent suffix ` · from the … agent` comes off before the ` (unsandboxed)` suffix), "Tool use", the sandbox
  network dialog title, the plan dialog titles and the `KNOWN_DIALOGS` titles.
- **The block top has one definition**, `blockTopOf` in `screen/region.ts`. It walks up from a given line and returns
  the first block rule with its kind: bare (`blockRule`) or with the session status (`blockRuleWithStatus`). The
  caller picks the kinds. `dialogBlock` takes only bare rules, from the one nearest the options upwards. The block
  fingerprint top takes only a status rule and only the nearest one: another horizontal rule nearer the options means
  no top. The excerpt for a card without buttons (`screen/excerpt.ts`) takes the lowest rule of either kind, and
  `blockVisible` gets the top from `dialogBlock`. Nothing but `blockTopOf` reads the block rule patterns (guard
  `server/test/dialogs-layer2-boundaries.test.ts`). `region.ts` knows no titles or tool names, so code that
  does not import the title map (`layer2/`) takes the block top from it too.
- **More than one pair = an ambiguous block** (`identity: ambiguous`): no name, no known dialog, no question content.
  The jsonl path ends in `mismatch` with reason `ambiguous`, the path without jsonl in a card without buttons and
  without a form, and the `degrade` entry has `mismatchReason: ambiguous`. An agent can take the buttons from its own
  permission this way, but cannot swap the name.
- **Options are the numbered run above the footer** (`screen/option-run.ts`). The option region is the narrowest
  region behind a rule with a complete set `1…N`. When a numbered list in the dialog body repeats the option digits
  (the phases of "Run a dynamic workflow?", CLI 2.1.322), the options are the last run: the bottom option line and
  the option lines above it, up to the first line at or left of its digit column that is not the description of an
  option above it (a description may start in the digit column), with only blank lines and footer chrome under it.
  A digit repeated inside that run (a repaint, or a repeated digit under a description) still leaves the region
  unreadable. Numbered lines with a digitless choice under them (a `❯` line without a digit, then a key footer) are
  body, not options. The card text of every kind, a confirmation included, runs up to the first option of the run,
  so the body list stays on the card and counts toward the text limit. Wrapped labels are joined within the run.
- **Exactly one pair** gives a title only when its rule is the NEAREST rule above the options. A pair higher up (in
  the scrollback above a dialog without a listed title) does not name the dialog under it.
- **Permission name**, in this order: the name Rarog gives the plan dialog (`ExitPlanMode`) and the sandbox network
  dialog (`SandboxNetwork`); the server and title from the MCP header in the first line under "Tool use"; the title
  from the map; an `Ask rule Name(` line (on CLI 2.1.328 `Rule Name(`, the rule in parentheses required) in the
  dialog region above the options, only when the dialog has an operation frame (a cut header takes its name this
  way, `dialog-bash-subagent-uciety-62x29-2.1.309.txt`); without a block title, `Write` from the question under the
  `╌╌╌` frame when the dialog header is above the screen edge (below). A call trace in the region (`⏺`, a title from
  the map, `Ask rule` or `Rule` line; `regionCallTrace`) is only a negative signal: it takes away the confirmation
  shape and the plan or network recognition.
- **`Write` with its header above the screen edge** (`screen/write-zone.ts`, CLI 2.1.322,
  `measured/zgoda-write-dluga-tresc-2.1.322.txt`). File content taller than the pane pushes the title ("Create file",
  "Overwrite file") and the frame top over the edge. The name then comes only from the lines between the frame's
  bottom `╌╌╌` rule and the first option: they must be exactly "Do you want to create <name>?" or "Do you want to
  overwrite <name>?" (wrapped lines joined by a space; the auto-deny countdown counts as an empty line). Any other
  line gives no name, and the dialog still has no permission form. The header counts as above the edge when the
  dialog top rule is not visible over the frame (`headerAboveEdge` in `screen/operation.ts`), also for a frame without
  the `│` bar whose top `╌╌╌` rule is off screen. A visible header with a title outside the map gives no name. The
  `⏺ Write(…)` line stands above the dialog top rule, so with the header above the edge it is off screen too; a line
  of that shape on screen is frame content and gives no name. This name is for display only. The "k of N" queue
  counter and the frame top are above the edge, so the screen cannot tell two queued `Write` dialogs apart, and the
  jsonl and hook paths compare only the name for `Write`. Such a dialog gets no buttons and no digit on any path and in
  any consent channel mode: a jsonl entry or hook dump gives `mismatch` with reason `operation`, the screen alone
  gives no permission form (a card with the screen excerpt and Esc), and the check before the digit refuses
  `file-question`.
- **MCP**: the header server equals the server from `mcp__<server>__<tool>` AND the title equals the tool name after
  normalization (`mcpTitleMatches`: no `<server>_` prefix, lower case, words joined by a space). A title that does not
  repeat the name gives `mismatch`. A one-word server must equal the identifier server literally (`catalog`). A server
  of several words with single spaces is a claude.ai connector name (CLI 2.1.322: "Claude Docs — Guide Tool: (MCP)"
  for `mcp__claude_ai_Claude_Docs__guide`): the identifier server must be `claude_ai_` followed by the name with
  every space written as `_` (`mcpServerMatches` in `screen/resolve.ts`).
- **Known dialog** (`trust`, `model`): kind `confirm` or `other`, a region bounded by a rule, options at the very
  bottom of the region, no dialog from `TERMINAL_DIALOGS`; a block title from the list ("Switch model?", "Accessing
  workspace:") or, without a listed title, the trust sentence in the block content (from the rule to the options,
  lines joined by a space); a separate option for `^Yes` and for `^No`. Kinds `tool` and `question` are never known
  dialogs (the agent writes the question).
- **Identity** (`ScreenDialog.identity`): `title` or `ask-rule` with the name, `file-question` with `Write` and the
  file name from the question, `mcp` with server and title, `known` with the id, `form` (question, confirmation,
  permission without a name) or `ambiguous`. A digit card carries kind and identity in `ActiveReq.dialogIdentity`,
  and `#digitStillHolds` requires the same on the fresh screen; `file-question` and `ambiguous` equal nothing, not
  even themselves (`sameDialogIdentity`). For MCP the identity compares, not `toolName`, because the parser gives MCP
  `toolName: null`.
- **Block fingerprint** (`ScreenDialog.bodyPrint` of kinds `question`, `confirm` and `other`; `blockPrint` in
  `screen/parse.ts`). An ambiguous block has none. Rule 1: the fingerprint top is the block rule when the option
  region is bounded by a rule and starts right under it. Rule 2: otherwise the top is the nearest rule above the
  first option, provided it is a `▔▔▔` status rule (`blockRuleWithStatus`) within the last 60 screen lines
  (`DIALOG_TAIL_LINES`); a bare rule nearer the options or no rule gives the fingerprint `null`. Inside the parser
  only the fingerprint reads the status rule: block recognition, kind, identity, known dialog and options do not know
  it. Outside the parser it is the block top for the excerpt on a card without buttons and for `readBlock` (below).
  The fingerprint covers the lines from the top to the bottom of the screen (SHA-256, 16 hex characters): an option
  line without cursor and box (`unbox`), the auto-deny countdown line without the countdown, every other line
  literally, with indent, box edges and the characters `> * · ↑ ↓`. Question and confirmation cards
  (`screenQuestionCard`), known dialog cards (`screenDialogCard`) and hook channel question cards carry it
  (`hookQuestionFrom`: from the same read and parse as its options, with the label hint from the payload; without it
  wrapped labels with a shared first line give no dialog and no fingerprint). A change of any block line between card
  and tap gives the refusal `screen-changed` and zero keys, and the evaluation puts the card up again: a changed
  question gives a new `reqId`, a changed option description or footer the same `reqId` with a new fingerprint. A
  tool permission (`tool`) has the framed content fingerprint ("Flow", item 6).

**Agent-written rules in a `Bash` permission (CLI 2.1.311, `measured/zgoda-bash-*-2.1.311.txt`).** A new line from the
call description reaches the screen, but a multi-line description, a multi-line command and a one-line command longer
than the pane stand in the block behind a `│` bar in column 1. A rule the agent writes is therefore not a bare rule in
the block, and its width is its length in the description (12), not the pane width (63). The bare one stands above the
dialog, in the scrollback (`⎿ $ echo 'x` and below): a pair there gives `ambiguous`. The ambiguity rule stays as
defense in depth, because CLI 2.1.293 drew a one-line description without the bar (`zgoda-bash-2.1.293.txt`).

**Picker rules (CLI 2.1.312, 26-column pane, `measured/picker-{effort,model}-2.1.312-26kol.txt`).** The `/effort` and
`/model` pickers have a bare `▔` rule above them (25 characters), also in a session with `--effort medium`. The
`/model` picker (kind `other`, unrecognized) has a fingerprint from under the bare rule; `/effort` is a slider
without digit options, so the dialog parser does not see it.

**Status rule as the fingerprint top (CLI 2.1.314 to 2.1.319, `kontrolny/`).** The session status rule
(`▔▔▔ ◐ medium · /effort ▔`) stands above the `/help` view (CLI 2.1.310), the plan dialog (CLI 2.1.278), and
"Switch model?" and the `/model` picker while the CLI shows the effort indicator ("Control set"). No other rule then
stands above their options, so the fingerprint top is the status rule (rule 2). The status rule does not bound the
option region, so such a "Switch model?" has kind `other`; under a bare rule
(`potwierdzenie-model-opus-2.1.316.txt`) it has kind `confirm` and the top from rule 1. The fingerprint counts the
lines UNDER the rule, so the same dialog gives the same fingerprint under both rules. A plan dialog under a status rule
is a tool permission with the framed content fingerprint. Synthetic screens: `server/test/dialogs-block-fingerprint.test.ts`.

**Rules in an ultracode session (CLI 2.1.317 and 2.1.318, captures `ultracode/` and `kontrolny/`).** ultracode is
the Claude Code effort level that `--effort ultracode` and `/effort ultracode` turn on. Its effort indicator carries
the word `ultracode`, and the rule above the prompt field ends in the label `──── ultracode ─` or, after `/rename`, in
the session name. A `/effort` slider opened while the indicator stands has the status rule
`▔▔▔ ◉ xhigh · ultracode · /effort ▔` above the block, which `blockRuleWithStatus` takes as the top (the status text
may be anything without `▔`). A `Bash` permission and the slider without the indicator stand under a bare rule.
`server/test/ultracode-dumps.test.ts` checks these captures.

**Layer 2 block and the shape registry** (`server/src/herdr/dialogs/layer2/`). Layer 2 reads a CLI dialog from its
block alone, without the title map; the server calls it for the block card without digits under
`RAROG_DIALOG_LAYER2=1` (below) and, with any flag, for "Switch model?" after `/model` (next paragraph). `readBlock`
takes the nearest block rule above the first option, bare or with status (`blockTopOf`), as the top; another rule
nearer the options or no rule gives no block. Without digit options the top
is the lowest block rule, and a bare `────` rule counts only with a key footer under it. The block carries the title
(the first non-empty line under the top), the content down to the first option, the raw option lines, the lines
between and under them, the footer and a fingerprint by the `blockPrint` formula (equal to the parser's on every
corpus screen that has one). Buttons come only from a match with a shape in `BLOCK_SHAPES` (`shapeOf`): top kind,
literal title, content and option labels matching the patterns as a whole, the same digits, no extra lines, and the
same value (the model name) in content and label. A button goes to a shape digit that `optionPolicy` does not block.
The registry has one shape, `model-confirm` ("Switch model?" from CLI 2.1.314 to 2.1.319 under either rule).
`server/test/dialogs-layer2-properties.test.ts` checks screen mutations (a cut, an inserted line, a
wrapped option, the "k of N" counter, SGR, another model name, swapped digits).

**The `/model` and `/effort` commands.** `commandDialogMatches` has one path: a dialog of class `confirm` whose
question contains the command name or whose option carries its value. "Switch model?" under the session status rule
has kind `other` (CLI 2.1.314 to 2.1.319), so it is read from its block instead (`confirmModelSwitch` in
`server/src/drivers/herdr/commands.ts`), with any value of `RAROG_DIALOG_LAYER2`, because the phone already chose the
model. The block must match the shape `model-confirm` with a layer 2 verdict, and the model in "Yes, switch to …" must
be of the family the sent alias names (`MODEL_SWITCH_FAMILIES`: `fable`, `opus`, `opus[1m]`, `sonnet`, `haiku`,
measured on CLI 2.1.316; the family, not the version, because an alias names the latest model). Then, in this order:
the send shield of class `dialog` (no hook consent request, the registry `waiting` with class `dialog`), a fresh read
with the same block fingerprint and the same label under the same digit, and, with no `await` before the key, no hook
registration, the same engine session and a live driver. Another command, an alias outside the table or a failed
check is a foreign dialog: zero digits. The digit has the audit line of a bare rule (`model_change`, `dialog:model`).
The in-place result line of `/model`
(`commandResultInline`) counts only as the first non-empty line under the LAST `❯ /model …` echo. `/effort <level>`
has no dialog either (CLI 2.1.319, `kontrolny/potwierdzenie-model-opus-2.1.319.txt`): under the echo stands
"⎿  Set effort level to low (saved as your default for new sessions)", and on a narrow pane the line wraps. Its
result counts when the LAST `❯ /effort …` echo is exactly the sent command, the first non-empty line under it starts
with "⎿ Set effort level to" and the sent level (signature `effortInlineResult`, prefix only, because the ending
is not measured for every level), and the echo is fresh: the screen shows more echoes of that command than the detection read
taken before the send. Without that read or without the line the driver waits the whole window. The ultracode
commands (`/effort ultracode`, `/effort ultracode off`) have no dialog (CLI 2.1.317 prints the result in place,
captures `ultracode/wynik-effort-ultracode-*`), so `commandDialogMatches` returns `false` for them and any dialog after
them is foreign: zero digits. The result counts only as the first non-empty line under the LAST `❯ /effort …` echo
(signatures `ultracodeEcho`, `ultracodeInlineResult`), when that echo is exactly the sent command and the line speaks
of the sent value: a stale "Ultracode on" in the scrollback does not confirm `off`, and an echo `/effort xhigh` from
the same batch confirms nothing. The refusal line with workflows off ("Ultracode needs dynamic workflows…") ends the
wait with a refusal sentence. No line in the read window (a command during a turn prints nothing) gives the sentence
that the result was not seen, with no optimistic card change; the transcript file confirms the state.

**Auto-deny countdown**: in an unattended session a line under the operation reads "⚠ Claude Code will automatically
deny this request in 1:58, to avoid blocking progress on an unattended session" (CLI 2.1.294) or "⚠ Claude Code will
automatically block this request in 1:38, to avoid holding up an unattended session" (CLI 2.1.316), and after about
2 minutes the CLI denies the dialog itself. The signature registry knows both wordings, because panes run different
CLI versions at once. The countdown ticks every second, so the parser cuts the sentence out of the question text
(`server/src/herdr/dialogs/screen/auto-deny.ts`); otherwise a screen card's fingerprint would change at every
evaluation.

### Block card without digits (flag `RAROG_DIALOG_LAYER2`)

The flag `RAROG_DIALOG_LAYER2` takes `0` and `1` (`docs/server-config.md`). With `0` (default) the server runs
without layer 2, also in the log. The server reads the flag once, at start (log line
`dialogs: layer 2 RAROG_DIALOG_LAYER2=<0|1>`), passes it to the driver as a parameter (`HerdrDriverDeps.dialogLayer2`),
and the driver to the decision (`DecideInput.layer2`); dialog modules do not read the environment. With `1` only the
card without buttons over a screen without digit options changes (a slash command view, trust without digits, login,
the `/effort` slider):

- **Block with a higher cap.** `readBlock` reads the block (`blockNoDigitsExcerpt` in `layer2/card.ts`): from the
  block title to the bottom of the screen, the same text as the block excerpt without the flag, with a cap of 60 lines
  and 4000 characters instead of 40 and 2000. The `/skills` view (CLI 2.1.310, 44 lines) then fits on the card with its
  title, and the title enters the card identity. A block over the layer 2 cap, a block with digit options and a screen
  without a block get the excerpt as without the flag. The screen tail keeps its cap.
- **Reason in the log, card unchanged.** The `block-card` entry of such a card gets at the end of its shape the fields
  `layer2: true` and `layer2Why: block-no-digits` (closed list `LAYER2_WHYS`). The card keeps the reason
  `unreadable`, so the app shows the reason sentence above the block.
- **Refresh.** The card carries the block fingerprint (`ActiveReq.layer2`). The same card identity (the same block
  title) with another fingerprint gives the action `refresh` instead of `keep`: the driver swaps the fingerprint on the
  standing card without clearing it (no `permission-cleared`, no new log entry) and sends a `dialog-screen` event with
  the new block. The manager assigns the block to `herdrDialogScreen` when the text differs from the standing one (full
  text, not length) and sends the session summary. The SSE contract and the app do not change. This is how a `/status`
  view tab (Status → Usage) and the timer on the Usage tab refresh.

`server/test/dialogs-layer2-no-digits.test.ts` lists the corpus screens that get the layer 2 trace with
`1` and those whose card changes (`/skills` and a form with a gap in option numbering). The same test compares the
driver's log lines with `0` against constants stored in the test and checks the refresh through driver and manager.

With `1` a block of class `dialog` whose options layer 2 reads gets a card with buttons instead of the card without
buttons, and every episode of class `dialog` writes a `layer2-episode` line: `docs/dialog-card.md`.

## Control set

The control set is the dialog block shapes measured on the live CLI, each with its expected block and button verdict.
The captures are in `server/test/fixtures/herdr/kontrolny/`, and `manifest.json` there lists them together with
captures from `measured/` and `refusals/`. Fields of a shape entry:

- `file`, `cli`, `columns`, `billing`: the capture, the CLI version (the same as in the file name and in
  `provenance.json`), the pane width and the session's account kind (`api-key` or `plan`; `/usage` and the model list
  look different per kind);
- `waitingFor`: the CLI process registry class at capture time, `status` and `value` (the `waitingFor` field of the
  session's `<pid>.json`). `status: null` means the registry had no entry for the session; the whole field is `null`
  for a capture whose class was not measured;
- `shape`: the layer 2 registry shape (`layer2/shapes.ts`) the capture matches, or `null`;
- `block`: the expected block: top (`bare-rule` or `status-rule`, the session status rule), title, digit options, key
  footer and `complete` (the whole block stands on screen, also without a footer when the measurement showed the
  block end);
- `today`: the card the current code puts up over the capture without jsonl and without a hook: event kind, reason of
  a card without a decision, known dialog, buttons and block fingerprint;
- `policy`: the button policy verdict (`buttons`, `partial`, `no-buttons`, the same values as `verdict` in a
  `block-card` entry), the button list and the reason.

The `missing` list names the shapes that did not appear in the measurement, with a reason and the nearest corpus file.

`today` and `policy` differ for "Switch model?" under the session status rule (`▔▔▔ ◐ medium · /effort ▔`): the known
dialog `model` recognizes only a bare rule, so the card has no buttons. The status in the rule is the effort
indicator, which the CLI shows briefly after start, after an effort change and after every `/model` result, also
"Kept model as …" (on 2.1.319 for about 10 s). After that the same dialog stands under a bare rule and the current
recognition gives it buttons 1 and 2. The `/model` and `/effort` pickers have the no-buttons verdict, because a choice
in them is saved in the Claude Code settings as the default for new sessions, and the phone changes no Claude Code
setting (only `rarog setup` and `rarog hooks install`, in a terminal, write Rarog's own entries there: "Writing the
hook entries"). This is the verdict of the control set; with the layer 2 flag on, the `/model` picker still has no
buttons (`docs/dialog-card.md`, "The card"). The start dialog of `--permission-mode bypassPermissions`
and the `/usage` panel have no buttons either. The folder trust dialog has no digit buttons: its card is the known
dialog `trust`, approved by the arrow path ("Folder trust dialog without digits").

The captures come from a measurement isolated from the user's Claude Code settings: its own `HOME` and config
directory, and a fake API on `127.0.0.1` as the model, so no request leaves the machine. At each capture it reads
the class from the measurement session's CLI process registry and the herdr agent status.

Result on CLI 2.1.319 (127-column pane):

- Registry class: "Switch model?", both pickers and `/usage` are `dialog open`; the question form is `input needed`.
  Before `/model <alias>` the registry says `idle`, so `dialog open` belongs to "Switch model?" itself. The trust
  dialog and the `bypassPermissions` start dialog stand before the REPL starts, so the registry has no session entry
  yet and there is no class.
- herdr does not see "Switch model?" or the `/model` picker as blocked: the agent status stays what it was before the
  dialog. herdr sees the question form, the `/effort` picker, the trust dialog and the `bypassPermissions` start
  dialog as `blocked`.
- The label of option 1 is "Yes, switch to" and the resolved model name. The alias `opus[1m]` on an API key account
  gives the same label and content as `opus`.
- The trust dialog has no digits and starts with `❯` on "No, exit". `down` moves `❯` to "Yes, I trust this folder"
  and the dialog stays (`zaufanie-po-down-2.1.319.txt`); Enter then accepts it, Esc ends the CLI process, and `2`
  does nothing. Both captures give the same card identity.
- `--permission-mode bypassPermissions` without the setting that skips its prompt shows the start dialog "WARNING:
  Claude Code running in Bypass Permissions mode" with "No, exit" (under `❯`) and "Yes, I accept", also without
  digits; Esc ends the process. `--permission-mode auto` shows no start dialog: the session reaches the prompt field
  with "auto mode on", so that shape is on the `missing` list.
- "Change effort level?" did not appear, neither after a choice in the `/effort` picker nor after `/effort low`: the
  CLI changes the level at once and prints the result in place ("Set effort level to …"). The nearest corpus file is
  the reconstruction `dialog-effort-change.txt` without a CLI version.

On CLI 2.1.317 with `--effort ultracode` the `/effort` slider has the toggle "Ultracode  on" and the line
"Ultracode: dynamic workflows on every task", registry class `dialog open`, herdr `blocked`.

The workflow approval captures (`zatwierdzenie-workflow-…`, CLI 2.1.322) come from sessions with `--effort ultracode`
where the fake API returns one scripted `Workflow` call with a two-phase script; each dialog is dismissed with Esc, so
no run starts. "Run a dynamic workflow?" stands under a bare rule: the script description, the numbered list of
the script's phases with their agent prompts, a token cost warning, the options "1. Yes, run it", "2. View raw script" and
"3. No", the footer "Esc to cancel · Tab to amend" and the line "ctrl+g to edit script in $EDITOR". The registry class
is `permission prompt` and herdr says `blocked` (its rule `dynamic_workflow_prompt`), so the policy verdict is
no-buttons. `acceptEdits` gives a byte-identical screen, and `default` or `auto` without ultracode give the same
block. `2` swaps the phase list for the script with line numbers (option 2 becomes "View workflow summary", and `2`
again goes back), `down` moves `❯`, and Esc or `3` cancels with the line "Dynamic workflow cancelled". A 57-column pane
wraps the text and keeps the options.

In `auto` mode with ultracode the fake API does not pass the server-side safety check, so on CLI 2.1.322 the screen
"Auto mode can't check actions in this session" comes first (class `dialog open`, herdr `done`). After Enter ("stay
in auto mode") the approval stands without digits, with `❯` on "No" and the line "Auto mode can't check actions in
this session, so this one needs your approval" (`zatwierdzenie-workflow-auto-bez-kontroli-2.1.322.txt`). Per the
Claude Code docs, auto mode with ultracode on skips the approval; a fake API cannot show that case.

The numbered phase list repeats the option digits; the options are the numbered run above the footer ("Dialog
block"). So `today` over the phase summary and over the script view is a tool consent with buttons 1–3 (the phase
list stays in the card text), and over the `auto` variant, where the phase list stands above a choice without digits,
it is `unreadable` without buttons.

The `Bash` and `Edit` consent captures (`zgoda-bash-…`, `zgoda-edit-…`, CLI 2.1.319, 2.1.321 and 2.1.328,
119-column pane; three removal captures in 99, 62 and 57 columns) come from sessions where the fake API returns one
scripted tool call, in `default` mode or in `auto` mode with a `permissions.ask` rule (passed with `--settings`, or in
the user's, the project's or the local project settings); each dialog is dismissed with Esc. All of them have the
registry class `permission prompt` and herdr `blocked`, so their policy verdict is no-buttons, while `today` (screen
only) has buttons. In `auto` mode
without a matching `ask` rule the CLI shows "Auto mode can't check actions in this session" instead of a consent
dialog: the screen says the safety check runs on the server and does not get through the local address. The auto-deny
countdown therefore did not appear and is on the `missing` list.

The wrapped-line captures (`zgoda-edit-wrap-…`, `zgoda-write-wrap-…`, CLI 2.1.330, 57, 99 and 119 columns, `default`
mode) are `Edit` and `Write` "Create file" dialogs over a file the measurement writes before the session, also the
`.claude/CLAUDE.md` of the session's own `HOME`. Each has the exact tool input and the file content next to it
(`<capture>.input.json`). The frame breaks a long file line hard at the content width, a continuation row has a
blank number field, and a space at the break stays on screen as a blank cell at the row end or a leading space of
the next row; geometry and variants: `server/test/fixtures/herdr/README.md`, "`kontrolny/`: control set of dialog
blocks". The proof joins a wrapped line back under the measured geometry ("Permission dialog operation"): 49 of the
94 captures prove their own call, and the table in `server/test/edit-frame.test.ts` gives the reason for each of
the others. The top of the consent channel matches the own call of every `Edit` capture that proves it and stays
`unknown` for the rest (`server/test/layer1-top-corpus.test.ts`); `Write` has no channel identity. The screen-only
card of these captures has buttons either way, since it takes its content from the same screen.

`server/test/dialogs-control-set.test.ts` checks that the manifest tells the truth about the files
(each file has an entry, versions agree with names and `provenance.json`, the block stands on screen, `today` is the
card from the code, the verdict agrees with the buttons, `waitingFor` passes the server's registry reader, and a shape
with buttons has no permission class, except a measured consent dialog with only its "Yes" digit under its own
class). The MCP and network consent captures (`zgoda-mcp-interakcja-…`, `zgoda-siec-…`, CLI 2.1.322, 127-column
pane) are the two measured consent dialogs; their policy verdict is `partial` with the "Yes" digit only.
`server/test/dialogs-layer2-block.test.ts` checks that every registry shape has a `buttons` capture
with the same digits and CLI version, every non-question `buttons` entry has a shape, and `shapeOf` matches exactly
the captures with a `shape` field. `readBlock` reads each manifest block with its recorded digits, except tool
consents (with an operation frame above the options, layer 2 reads no block). `KNOWN_MISREADS` in that test pins
the digits of a block read otherwise (empty today), so a reader fix fails there and the entry goes.

## Folder trust dialog without digits

The folder trust dialog on CLI 2.1.319 has no digits: "❯ No, exit", "Yes, I trust this folder" and the footer
"Enter to confirm · Esc to cancel". `2` does nothing, `down` moves `❯` to "Yes" and the dialog stays, Enter accepts,
Esc ends the `claude` process (control set `zaufanie-2.1.319.txt`, `zaufanie-po-down-2.1.319.txt`). The digit path
cannot answer it, so it has its own path (an exception to the digit path, modeled on the form submit path):

- **Parser** (`screen/trust-arrow.ts`): only a full render is recognized: a bare block rule, the title "Accessing
  workspace:", the trust sentence in the block, the folder on one line under the title, exactly two options in the
  order "No, exit", "Yes, I trust this folder" (or "Yes, proceed") with exactly one `❯`, and the footer as the last
  line. The indents are the measured ones: block text has a one-space margin, an option line has the cursor column
  after it. The folder is the line without that margin, so spaces in the name stay. A folder wrapped over more lines
  gives no recognition: the wrap hides the space at the break (the block's sentences break on a space that neither
  line shows), so "/Users/u/My" and "project" can be `/Users/u/Myproject` or `/Users/u/My project`. Outside the
  option pair the block has no `❯` and no option-shaped line (indented to the cursor column, an option label, a
  numbered option), also past a blank line. A third option, a cut top or bottom, digits or another label give no
  recognition either, so the card has no button. The block fingerprint takes the option lines without `❯`, so it is
  the same before and after `down`.
- **Card**: `resolveOptions` gives `no-jsonl` with `knownDialog: 'trust'`, no options (no made-up digits), the
  identity `known`/`trust` and the fingerprint. The card carries the folder and the engine session id
  (`ActiveReq.trustArrow`); the app card is the known dialog card it was.
- **Approval** (`send/trust-step.ts`, driver `#approveTrustArrow`, client `sendTrustStep`): a fresh read, then `down`
  only when `❯` stands on "No", a pause and a second fresh read, then `enter`. Before each key the screen must show
  the trust dialog with the card's fingerprint and folder, the folder must equal the session `cwd` (`~` expanded with
  the server's home directory), the card must still stand, and the blocked state and engine session must be the ones
  of the first read. The card, blocked state and engine session are checked after the read and again right before
  the key, with nothing awaited between that check and the client call: a pane event (a new engine session, a status
  change) comes in only at an `await`, so a change that arrives after the read stops the key. A read with `❯` already
  on "Yes" (a second tap after `down` alone) sends `enter` only.
- **Refusals**: any other read sends no further key (never `escape`): `screen-changed`, the card goes out and the
  evaluation builds it again from the screen. A send error is `send-failed` without a retry; the card stays. The
  dialog gone before the tap sends nothing.
- **Log**: `down` is a `send_keys` entry, `enter` an `approve` entry, both with `toolName` `dialog:trust` and the
  "Yes" label. The trust report to the supervisor (`markTrustDialog`) goes out at the card and right before `enter`,
  after the state check, so a refused `enter` sends no report.

`down` and `enter` of this path are not in `ALLOWED_KEYS`; `server/test/dialogi-zaufanie-strzalka.test.ts` guards that
no other send path uses them.

**Start prompt behind the dialog.** A session started from Rarog in an untrusted folder stops on this dialog, and the
launcher settles `ready` at once with `{status: 'blocked', interactiveReady: false}`. That is not readiness: a prompt
sent then gets `agent_blocked`. The manager (`#awaitStartReady`) keeps the start prompt and the card's reservation
(`launchPending`, so a message from the phone gets 409 and cannot overtake it) until the pane is `idle` after the
dialog: an `agent-state` `idle` from the driver while the supervisor does not report `interactive_ready: false`, or,
when the wait begins, a supervisor entry already `idle` and ready. A driver swap on the way (`claude` re-executes
after "Yes", `re-attached`) keeps the wait. "No, exit" (the pane's agent is `gone`), a driver `exit` and closing or
hiding the card cancel it: the prompt, with its attachment chips, goes to the transcript with `session.prompt-lost`.
A start without a prompt does not wait.

## CLI dialogs answered in the terminal

Two CLI dialogs appear outside jsonl and without the hook. Rarog shows them on the phone in full, and today's card
picks none of their options. Buttons come only from layer 2, for an entry with measured keys ("Buttons from layer 2"
below). The list `TERMINAL_DIALOGS` is in `server/src/herdr/dialogs/policy/terminal.ts`, the patterns in
`SCREEN_SIGNATURES` (CLI 2.1.309, fixtures `dialog-session-paused-2.1.309.txt` and
`dialog-background-work-exit-2.1.309.txt`):

- `session-paused-safeguards`: the "Session paused" pause after a model safeguard flag, with the options "Switch to
  <model>" and "Edit prompt and retry with <model>", above them a CLI description and `Details: [cyber]`;
- `background-work-exit`: "Background work is running" on exit from a session with background tasks: "Exit and stop
  tasks", "Move to background and exit", "Stay", footer "Enter to confirm · Esc to cancel".

**Measured keys** (`keysMeasured`). An entry records, for every option and for Esc, the CLI version of the
measurement and the control set capture of the dialog (`server/test/fixtures/herdr/kontrolny/`). One unmeasured key
leaves the whole entry unconfirmed (`confirmedKeys` gives `null`). A test fails when a measurement points to a capture
that is not in `kontrolny/` or does not show the dialog. Both entries are confirmed on CLI 2.1.322, one session per key
(fixtures `kontrolny/wyjscie-tlo-2.1.322.txt` and `kontrolny/pauza-2.1.322.txt`):

- exit, measured on CLI 2.1.322: `1` "Exit and stop tasks" ends the session process with "Resume this session with:
  claude --resume <id>" and stops the background tasks. `2` "Move to background and exit" returns the pane to the
  shell with "backgrounded · <id>", and the session lives on under the CLI daemon (`claude agents --json` lists it as
  `kind: background`), so for Rarog it leaves the pane without ending. `3` "Stay" and Esc close the dialog to the
  prompt field, and the background tasks keep running;
- pause, measured on CLI 2.1.322 with a fake API refusal and `switchModelsOnFlag: false`: `1` "Switch to <model>"
  switches the session to that model and sends the request again. `2` "Edit prompt and retry with <model>" sends no
  request: the prompt goes back to the edit field and the model stays. Esc sends no request either: the pause goes,
  the transcript gets an "API Error: … safeguards flagged this session" line and the model stays.

**Buttons from layer 2.** With `RAROG_DIALOG_LAYER2=1` a confirmed entry gets the layer 2 card instead of today's card
(`docs/dialog-card.md`): the literal labels as buttons, each key sent only by the layer 2 step after a fresh read
(`docs/dialog-card.md`, "Answer"). The exit card has "Exit and stop tasks", "Move to background and exit", "Stay" and
"Esc to cancel" (Esc means "Stay" here), and its footer proves the block end. The pause card has its two options and
no Esc: the pause has no key footer, and the closed match (title and the whole option set) proves the block end.
`deny` over the pause card is the pause refusal ("Esc on the pause" below) and sends no key. Another pause with this
title and another option set gets no buttons (`terminal-dialog`). Without a confirmation, or with the flag `0`, both
dialogs keep today's card below.

**Under the status rule** (`▔▔▔ ◐ medium · /effort ▔`, fixture `kontrolny/wyjscie-tlo-2.1.322.txt`) the layer 2 card
is the same as under a bare rule. Today's card is not: the match below needs a region behind a rule
(`horizontalRule`), and the status rule is not one, so without layer 2 the exit dialog under it is a snippet card
(`no-jsonl`).

The workflow approval dialog "Run a dynamic workflow?" (options "Yes, run it", "View raw script" and "No", measured
on CLI 2.1.322 in "Control set") is not on the list. Its registry class is `permission prompt`, so its policy
verdict is no-buttons, and Rarog promises no card with buttons for it. The New Session window says so in a sentence
under the enabled ultracode toggle. The screen-only card does not hold to that verdict: over the phase summary and
the script view it has buttons 1–3 (`today` in "Control set").

**Match** (`matchTerminalDialog`, in `confirmFrom`): the confirmation shape (a region behind a rule, no
`⏺ Tool(…)` line, options at the bottom, under them at most a key footer, no escalation markers in the content), the
title in the FIRST line of the region and the FULL option set: as many options as patterns, each hit by a different
pattern. Such a dialog needs no question mark, and its content cap is `TERMINAL_DIALOG_MAX_CHARS` (2000 characters),
not 600. A last option wrapped by a very narrow pane leaves text under the list, so the confirmation shape fails and a
snippet card stays.

**Another pause with this title**, with another option set, is not on the list: the set does not match and the dialog
stays a snippet card (`no-jsonl`). No other pause variant has been measured; Esc does not go on it either
(`sessionPausedDialog`, below).

**Today's card** (`resolveOptions` → `screenQuestionCard`): a `confirm` question card with the title in the header
(`header`), the rest of the content in the question and the literal options, EACH with `terminalOnly`, so the app draws
them without a button. `knownDialog` is `null`, and the dialog card options (the send path, `options` in `no-jsonl`)
are empty. The SSE contract does not change. The card carries the list id in `ActiveReq.terminalDialog`, and the
driver refuses (`terminal-only`, the sentence `TERMINAL_DIALOG_MESSAGE` instead of the permission sentence):

- digits from `answerQuestion`: every option is `terminalOnly`;
- `allow` and `allow-always`: before the option search (`affirmativeOption` looks at labels, not at the flag);
- auto-confirmations after `/model` and `/effort` (`commandDialogMatches` → `foreign`, zero keys).

In the log the card is a card without a decision: a `degrade` entry with reason `no-jsonl` (with a hook dump the
screen contradicted, the reason from its path), source `screen` and `dialogTitle` with the id ("Case shape in the
log"). The same dialog over a standing card ends the evaluation without an event (`sameForm`). The CLI registry
fallback treats both as a dialog on screen (`cliDialogOnScreen`), because they are not of kind `other`.

**Esc on the pause.** Rarog sends Esc on no pause. The measured pause has no key footer, so nothing on the screen
names Esc, and other pause variants are not raised on purpose to measure them (it is a model safety mechanism).
So Deny (`respondPermission('deny')`, both routes: `POST …/permission`
and `…/permissions/:permId`) and interrupt (`interrupt()`: the app keyboard's Esc with focus outside the card goes
this way; Esc with focus on a question card is not a decision in the app) read a FRESH screen right before the key in
every blocked state (`#pauseBlocksEscape`). Neither the card nor the last read is enough: a dialog can swap in place
before the evaluation reads the screen. A pause here is any variant (`sessionPausedDialog`): the title "Session
paused" in the region behind a rule, or the option "Edit prompt and retry with …" (title above the pane edge). Every
dialog screen read leaves a pause trace in this blocked state (`#pauseSeq`); the trace survives a refusal, a cleared
card and a screen without a dialog, and a read with another readable dialog or the end of the blocked state removes
it. The refusal is `terminal-only` with the sentence `PAUSE_ESCAPE_MESSAGE` in the transcript when the pause stands on
the fresh screen or, with a pause card or a pause trace, when the read failed or the screen shows no dialog. Another
readable dialog means the pause is gone and Esc goes. Without a blocked state (a plain turn interrupt) Esc goes without
a read. On the exit dialog Esc stays: the footer "Esc to cancel" means "Stay". Neither the pause nor a listed dialog
gets a digit from any card but its own layer 2 card: the check before the digit of today's cards (`#digitStillHolds`)
refuses with `screen-changed` when the fresh screen shows such a dialog (a stale question card labelled "Switch to
Opus 4.8" would pass the label check). The layer 2 step does not go through that check; it holds to its own
occurrence and block fingerprint.

**Card identity.** A listed card computes `reqId` from the title, content and labels (`screenFormReqId`), so another
pause with the same options is a new card. A snippet card (a dialog off the list) has the dialog title in its
fingerprint too (`ScreenDialog.title`, `screenFallbackReqId`): two dialogs with the same labels under different titles
give two cards. A title revealed above the same options turns a snippet card into a content card. A screen card
without digit options takes its title from the first line of the dialog block when the parser read nothing and the
block worked: `/status` after `/help` in the same blocked state gives a new card with a new block. A card with
the screen tail has a fingerprint without a title.

## Rules: what must not be relaxed

- Content from jsonl or the hook, digits from the screen, a mismatch = a card without buttons. The digit comes from
  the label TEXT, never from the position.
- An option that widens permissions ("don't ask again", "switch to auto mode") gets `terminalOnly`
  (`optionEscalates` in `dialogs/policy/escalation.ts`): on a QUESTION card it is visible, without a button. A
  PERMISSION card has one exception: exactly one affirmative escalating option ("Yes, and don't ask again…") gets a
  separate always button (`allow-always`, `alwaysOption`) with the literal label; the sandbox network dialog has no
  such button. A dialog from the `TERMINAL_DIALOGS` list has `terminalOnly` on EVERY option.
- One function builds the option rule, `optionPolicy` (`dialogs/policy/option-policy.ts`), with an answer channel:
  `digit` (a digit to the pane) or `hook` (the hook file). `terminalOnly` (escalation or a `TERMINAL_DIALOGS` dialog)
  blocks the option in both channels. Question cards that know the payload compute `terminalOnly` on the full label
  with collapsed whitespace, not cut to `OPTION_LABEL_MAX_CHARS` (200): a `hook` channel card, a `keys` channel card
  from a jsonl entry with one question that `hookQuestionFrom` did not match to the screen, and a `keys` channel card
  matched by `hookQuestionFrom`, which has labels from the screen and computes the flag on the screen label and on
  the full payload label. The label meets the server gate in canonical form (`canonicalLabel`, collapsed and cut). In
  the `hook` channel the gate compares it with the card's list of blocked labels (`HookAnswerTarget.blocked`): every
  `terminalOnly` option is on it, under the canonical key, so such an option never goes out by file. The digit gate
  first checks the list of options a `decisionCard` question card marked `terminalOnly`
  (`ActiveReq.terminalOnlyLabels`, also under the canonical key): the full label and its bare prefix get the same
  refusal, even when the screen label has no marker. Then it looks up this form in the screen options and judges the
  screen label. The answer file gets the literal label. In the `digit` channel multi-select and an open note also
  block the digit (`digitBlocked`), because the digit then toggles a checkbox or types as text. `terminalOnly` does not
  depend on them in any channel, and in the `hook` channel they block nothing, because the hook file carries text.
  Only the `dialogs/policy/` directory calls `optionEscalates`.
- `escape` (deny, interrupt) goes unconditionally, with three exceptions: the "Session paused" pause (a fresh screen
  read before the key) and, for a deny, a dialog that a channel card holds or a standing layer 2 card
  (`docs/dialog-card.md`, "Answer").
- A message to a Claude pane during a turn never goes by `agent.prompt`: herdr pastes and presses Enter after a fixed
  300 ms, so a dialog that stands up in that window takes the Enter. The text goes as a paste without keys, and
  `enter` follows only after the text stands in the field and nothing signals a dialog ("Sending while a turn runs").
- With the effective consent channel mode `off` or `shadow` the hook never approves a tool call: a permission goes
  only by a key on the screen. The hook returns two things: the human's answer to `AskUserQuestion` (as `allow` with
  `updatedInput.answers`; that tool executes nothing, so this `allow` approves no operation), and the FORM refusal of
  a too-tall `Bash` dialog ("Tall dialog guard"), its only decision without a human.
- With the effective mode `main`, and with a mode the server cannot read, the classes `permission` and `sandbox`
  get no digit and no approve key on any path: both decision endpoints, a live dump, a stale dump with a frame, no
  dump, main thread and subagents (`consentDigitBlocked` in `dialogs/router.ts`, checked at the digit step of the
  driver). A main thread tool permission is approved only by the signed answer file of a channel card ("Channel
  cycle"); everything else waits in the terminal. A digit passes only for a known dialog card (trust, model) and
  for an answer to a question form, and an answer on a card from the screen only with the registry class `input` or
  `dialog`. A screen or jsonl tool card at `main` has no approve button and no always button. The mode does not gate
  `escape` (deny); a dialog a channel card holds gets no key (below). An error, missing data or an unclear card state
  means no approve button, never a digit.
- One exception to the rule above: the digit of option "Yes" of a measured consent dialog (invariant N4,
  `dialogs/policy/measured-consent.ts`). Two shapes are measured, both without a working hook answer: the sandbox
  network dialog (class `sandbox`, no `PermissionRequest`) and the dialog of an MCP tool with
  `requiresUserInteraction` (class `permission`, a plain `allow` does not close it), CLI 2.1.322, fixtures
  `kontrolny/zgoda-siec-2.1.322.txt` and `kontrolny/zgoda-mcp-interakcja-2.1.322.txt`. The card carries the mark of
  its screen (`ActiveReq.measuredConsent`) only when the whole block under the last block rule is the measured shape:
  no queue counter, every line as measured, the complete option list and nothing under it. Its identity is the host
  for the network dialog and, for MCP, the header plus the argument frame; an MCP card also has to be built from its
  `tool_use` entry (a card from a hook dump alone gets no mark), whose input the frame shows exactly (one
  `<key>: "<value>"` line per string argument, `mcpFrameShows`), so MCP without the entry, with a non-string argument
  or a wrapped line has no approve button. The digit goes only through `respondPermission` `allow`, never
  `allow-always`. Right before the key the driver checks, in this order, the send shield (`PromptQueue.keyShield`: no
  hook consent request waiting, a fresh registry read `waiting` with the class of the mark), then a fresh screen read
  that gives the same mark (`measuredConsentHolds`) next to the usual label, block print and identity checks, and
  after that read, with no wait before the key, the hook check once more. A hook consent request waits while a
  channel card holds the dialog or a live registration of the session, a subagent's too (at `all` its dialog stands
  in the same pane), has no channel card, however long ago it was accepted (`PromptQueue.keyHookWaits`, port
  `consentRegistrationWaits`; the card-wait ceiling is only for messages); a port error counts as waiting. Anything
  else, including another dialog on top, means no digit.
- A screen or jsonl permission card the user cannot read in full has no approve button and no always button in any
  consent mode (`canAllow: false`, `allow` gets 409; `cardShowsAll` in `server/src/drivers/tool-text.ts`, checked by
  the manager when it builds `permission-pending`): its text was cut by the server (`truncation`, over
  `MAX_DISPLAY_TEXT`, 20,000 characters) or contains a character hidden on the card (`CARD_HIDDEN_RANGES` in
  `server/src/hidden-chars.ts`: control characters except tab and newline, text direction marks, zero-width characters
  except the emoji joiner U+200D, line and paragraph separators, BOM, tag characters U+E0000–U+E007F, the variation
  selectors U+E0100–U+E01EF, which show as nothing, and the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, which
  show as blank space). The text stays on the card and Deny works. A multi-line command or JSON input keeps the button. Such a card has no `text` in the
  list row's `waitingFor`, like any card without the approve button.
- A decision on a channel card goes only through the session card that handles the conversation (a live pane of the
  engine session); through another card of the same conversation (a pane the conversation moved away from, a `done`
  card) `allow`, `deny` and `release` are 410 with no file. A channel card passes the same gates as a screen card,
  computed on that card. `allow` on a pane outside the roots (`outOfScope`), with another live card of the same
  conversation outside the roots, with `RAROG_HERDR_SEND=0` or with a read-only supervisor is 400 before the cycle
  writes a file. `deny` and `release` always pass: they approve nothing and take the card off the phone.
- One dialog has one card. The first appearance of a channel card removes the session's consent cards from the screen
  and jsonl, without a key to the driver; a screen card that arrives while a channel card holds the dialog (`pending`,
  `sent`: the hook waits for the file) is not shown. No decision key from the screen (the deny `escape`, a consent
  digit) goes to a dialog a channel card holds, also when the card appears during the fresh screen read before the
  key: the screen card expires (410). One constant, `CONSENT_HOLDING_STATES` (`layer1/contract.ts`), defines the
  holding states for the driver port (`consentCardLive` in `server/src/bootstrap/consent.ts`) and the manager.
- A channel card does not outlive its session. An interrupt or a close from the phone releases the session's cards,
  the pane gone or a process exit revokes them; hiding the card, `dispose`, a driver swap and lost contact with herdr
  (`stale`) leave them, because the pane and the hook live on. At the session end (the pane gone, a process exit, a
  close from the phone) every non-final card of the conversation leaves the devices (`permission-resolved`,
  `expired`, `by: "system"`) and comes back on no card, also after the conversation resumes in a new pane; the cycle
  record follows the evidence. A `done` card carries no channel cards. The full list is in "Channel cycle", "Session
  end triggers".
- The dialog identity (tool name, MCP server and title, known dialog) comes only from the dialog block ("Dialog
  block"), never from the `⏺` line, the description, the command, the options or the scrollback. A known dialog is
  never a tool permission or a question. An ambiguous block = a card without buttons.
- The plan file name that ties an `ExitPlanMode` dump to the dialog comes only from the CLI footer
  `ctrl+g to edit in … · ~/.claude/plans/<name>.md` (`ScreenDialog.planFile`, `screen/plan-file.ts`). The footer is the
  last group of non-empty screen lines. The nearest non-empty line above it must be the CLI hint of option 3
  (`shift+tab to approve with this feedback`, under the last option), and each footer line has the same indent,
  shallower than the digit column of the last option and than the hint's indent. Option 3 feedback stands in the
  option field, deeper than the digit, so an imitated footer in the feedback (also in a read cut before the real
  hint) is not a footer. A footer broken in a narrow pane is joined from consecutive lines, also when the break splits
  the name. The scrollback, the plan content, option lines and feedback give no name, even with a full path in them.
  No hint above the footer, or an incomplete, unrecognized or two-path footer, means no match.
- A card with a fingerprint (`bodyPrint`: a framed permission, a plan dialog with a footer, a question, a
  confirmation, a known dialog) gets a digit only with the same fingerprint on the fresh screen; a fresh screen
  without a fingerprint is a refusal. A card without a fingerprint (the block top condition does not hold) has the
  label, digit, kind and identity check. In a parser dialog the session status rule marks only the fingerprint top,
  never the block, kind, dialog identity or options. It is a block top only for a card without buttons over a screen
  without digit options (the block excerpt, `readBlock` under the flag), and the title under it then enters that
  card's identity, and for the layer 2 reading: the layer 2 card under the flag and the "Switch model?" confirmation
  of `/model` with any flag ("Dialog block").
- Any doubt ends in a refusal, never in a guess.

## Module map

`server/src/herdr/dialogs/` holds dialog handling; its `server/src/herdr/dialogs/index.ts` has the per-file module
map, the public API for the driver facade, the import rules and the dependency direction (guard
`server/test/herdr-dialogs-boundary.test.ts`). Subdirectories:

- `screen/`: the screen parser (`parse.ts`, `block.ts`, `options.ts`, `region.ts`, …) and the signature registry
  (`signatures.ts`), the only place that knows the CLI look;
- `decide/`: `decideCard` and its input, competition of sources, refusal reasons;
- `cards/`: card types, builders, card identifiers, the `block-card` log record;
- `policy/`: option policy, escalation, terminal-only dialogs, the pause, consent dialogs herdr does not see;
- `hook/`: the contract with `scripts/hooks/rarog-pending.mjs`, canonical input, answer channel, dump reader;
- `shadow/`: the shadow channel ("Server in shadow mode");
- `send/`: the key allow-list, form submit, the trust step and the `enter` of a message sent during a turn;
- `layer1/`: the consent channel (layer 1). `contract.ts`: cycle states, reasons for a card without an approve
  button, `reasonId` with deny texts, the `consent/` and `consent-records/` directories, the routes of the
  registration socket `consent.sock` and of the admin socket, the HMAC signature prefix, limits, the record version.
  `sign.ts`: the HMAC-SHA256 signature of the answer file, its check and the card hash `cardSha256`; the message is
  the versioned prefix and the file fields joined with `|`, a file with a field outside the contract (e.g.
  `message`) is invalid, `mac` is compared in constant time; shared vectors computed outside Node:
  `server/test/fixtures/hook-kanon/podpis.json`. `registry.ts`: the in-memory hook secret registry for registrations
  from `<dataDir>/run/consent.sock` (channel scope, main-thread request, sending, session on the list), a key block on
  a second, different registration (`key-blocked`), limits of 64 per session and 1024 in total, the entry lifetime,
  the secret for the signature. `receipt.ts`: the check of the hook's `POST /claim` receipt of an `allow` (the
  receipt signature with the registration's secret, the same refusal for a wrong signature and an unknown key) and
  the rule which record takes it. The card and the card store (`card.ts`, `cards.ts`), records and their sweep
  (`records.ts`), binding to the call (`bind.ts`), proof and effect (`proof.ts`), the version gate of the proof rule
  with the canary file (`version-gate.ts`), the match of a dump to the top of the screen (`top.ts`), the key state
  machine with the session pool (`cycle.ts`), the desk fallback with its clock (`desk.ts`), the reason code of a desk
  release (`desk-reason.ts`), the session hook list (`hook-list/`) and the observation of one session (`observe.ts`):
  "Channel cycle". The registry and the socket exist only in a
  channel mode that needs registration (`consentRegistrationWanted`), not with `off` and `shadow`; the power boundary
  of both sockets: `docs/security-model.md`, "Pairing and device keys". `layer1/` imports neither the transcript
  nor herdr driver modules, and `shadow/` does not import `layer1/` (`server/test/layer1-granica.test.ts`);
- `layer2/`: layer 2 block reading, shapes and the block card without digits.

Outside the directory:

- `server/src/drivers/herdr-driver.ts`: the state machines (evaluation, fallbacks, hook channel, check before the
  digit, refusals); the only writer to the pane;
- `server/src/herdr/jsonl-follow.ts`, `jsonl-pending.ts`: the transcript and the pending tool;
- `server/src/herdr/consent-evidence.ts`: the consent channel's transcript check from the checkpoint, outside the
  follower window ("Channel cycle");
- `server/src/herdr/consent-subagent.ts`: the subagent file of a subagent target in that check
  (`<session>/subagents/agent-<agentId>.jsonl`, or a workflow agent's file under one run,
  `subagents/workflows/wf_<id>/`), and the same facts for the observation at effective `all` ("Dialog signals" in
  "Channel cycle");
- `scripts/hooks/rarog-pending.mjs` (the hook), `tall-dialog.mjs` (dialog height estimate for the guard),
  `canon.mjs` (canonical `tool_input` and sha256 of the per-call dump), `consent.mjs` (the consent channel in the
  hook: registration, claim and signature check of the answer file), `work-area.mjs` (the `cwd` filter of both hooks:
  the work area, resolved one segment at a time);
- `server/src/herdr/supervisor.ts`, `trust.ts`: folder trust, CLI permission dialog;
- `server/src/drivers/herdr/commands.ts`: `/model` and `/effort` command dialogs, the prompt field;
- `server/src/drivers/herdr/command-dialog-settle.ts`: the block the driver's digit in a command dialog answers, and the
  wait of the next queued step for that dialog to leave before it chooses its path and runs the send gates ("Model,
  effort and permission mode" in `docs/implementation-spec.md`);
- `server/src/cli-version.ts`: the CLI session registry;
- `server/src/sessions/consent-cards.ts`: consent channel cards in the session manager: cards on the wire and in
  the snapshot, a device decision on a card with its gates, the cards' end with the session ("Channel cycle");
- `server/src/sessions/claim-window.ts`: the session state right after a hook's claim, herdr `blocked` held for a
  short window ("Channel cycle");
- `server/src/herdr/audit.ts`: the refusal log.

## CLI look: signature registry

Each screen pattern has an entry in `SCREEN_SIGNATURES` (`server/src/herdr/dialogs/screen/signatures.ts`: pattern, CLI
version), and parser, policy and card constants take their value from the registry.
`server/test/herdr-screen-signatures.test.ts` checks that each signature hits at least one fixture in
`server/test/fixtures/herdr/`. Exceptions to the registry: ANSI sequences, control characters, whitespace, `mcp__…`
names from the payload. The registry also holds the prompt field look (`composerRule`, `composerPrompt`, and the
top rules of a field cut at the top and of a history entry, `composerRuleCut` and `composerRuleHistory`), which
`server/src/drivers/herdr/commands.ts` reads (`composerRegionText`; `composerFieldView` also reads the two other
top rules). `server/test/herdr-screen-signatures-guard.test.ts` keeps any
`server/src/**` file outside the registry from repeating a registry literal in code: a string equal to a marker, a
pattern with the same source, or a string equal to a pattern source. Comments do not count. Only `blockTopOf`
(`screen/region.ts`) reads both block rules, bare (`blockRule`) and `▔▔▔` with the session status before the end
(`blockRuleWithStatus`). Only the block excerpt for a card without buttons (`screen/excerpt.ts`), the layer 2 block
(`readBlock` in `layer2/read-block.ts`, which the server calls only under the flag: the block card without digits
and the layer 2 card, `docs/dialog-card.md`) and the block fingerprint top (`statusRuleTop` in `screen/parse.ts`)
take the status rule from it; `dialogBlock` asks only for the bare one.

## Dialog detection in herdr

herdr computes the `blocked` status over a dialog from the pane screen with the rules in `claude.toml` (the detection
manifest). herdr fetches these rules FROM THE NETWORK, independently of `herdr update`: the catalog
`herdr.dev/agent-detection/index.toml`, a copy in `~/.local/state/herdr/agent-detection/remote/`, the time of the last
check in `status.toml` next to it. herdr's verdict over a dialog can therefore change on any day, and the procedure
after `herdr update` (`docs/security-model.md`, rule 9 of "herdr sessions: Rarog writes to a terminal it does not
own") will not notice.

The verdict can be checked without the socket and without a live pane, on the parser fixtures (in `measured/` the glob
`*.txt`):

    cd server/test/fixtures/herdr
    for f in dialog-*.txt; do
      printf '%s\t%s\n' "$(herdr agent explain --file "$f" --agent claude --json \
        | jq -r '[.state, (.matched_rule.id // "-")] | @tsv')" "$f"
    done

`.manifest_version` in the same JSON gives the rules version. On rules 2026.10.11.1 every dialog fixture gives
`blocked` except `dialog-automode-teach-2.1.258.txt`, `dialog-bash-przewiniety-widok-2.1.295.txt`,
`dialog-effort-change.txt`, `dialog-model-switch.txt`, `dialog-session-paused-2.1.309.txt`, the form with a preview
in a 63-column pane (`measured/pytanie-preview-2.1.293.txt`; the 128-column `measured/pytanie-preview-2.1.328.txt`
gives `blocked`), "Exit plan mode?" without a plan (`measured/exitplanmode-bez-planu*`) and the narrow
`/effort` and `/model` pickers (`measured/picker-*-2.1.312-26kol.txt`), which give `idle`; the CLI session registry
fallback covers them. In ultracode sessions (CLI 2.1.317 and 2.1.318) the `Bash` permission and the `/effort` slider give
`blocked`, and screens with the labelled prompt field give `idle` (`live_prompt_box`).

Another result means herdr changed its rules. Read the difference in `src/detect/manifests/claude.toml` of the
`herdrdev/herdr` repo and check whether a driver fallback (the CLI registry, `/rename`, CLI permission dialogs outside
the blocked state) became unnecessary or has become the only way to a card. The check sees only the screen. On a live
pane the rule `osc_title_working` (a terminal title with a spinner, priority 1100) beats all screen rules, so a live
pane can be `working` where the check gives `blocked`.

## Permission hook: installation and channel state

    rarog hooks install               # copy of the hook code in ~/.claude/hooks/rarog/ (state from the commit),
                                      # then the hook entries in ~/.claude/settings.json after [y/N/d]
    rarog hooks print                 # the same entries as a JSON block to paste by hand
    rarog hooks print --local         # the same for <project>/.claude/settings.local.json
    rarog hooks doctor                # ok / missing / mismatch / stale + age of the last hook run

In a clone, `pnpm run hooks:install|print|doctor` are shims of these commands, with the same output and exit codes.
The code is in `server/src/cli/hooks.ts`.
`rarog hooks statusline [--chain <command>]` prints the status line block ("`statusLine` script from the copy").

**Module map of the installation.**

- `server/src/herdr/hook-commands.ts`: the one definition of what Rarog puts into Claude Code settings: the current
  commands (permission hook, context hook, `statusLine`), the expected entries, the Rarog paths of
  `sandbox.filesystem.denyRead`, the printed blocks built from those entries, and the closed list of command forms
  that Rarog no longer prints but a user may still have pasted, each a pattern for the whole string with its print
  dates and decision. Pure code, no I/O.
- `server/src/herdr/hook-config.ts`: roots for the `cwd` filter, the copy and its manifest, removing the copy
  directory at uninstall, reading a settings file and comparing Rarog's entries with the expected ones, the age of the
  newest status line dump, the `hook` field of `/health`. It re-exports the names of `hook-commands.ts`.
- `server/src/cli/claude-settings.ts`: the settings writer, the only code that writes `~/.claude/settings.json`
  ("Writing the hook entries"). Only `server/src/cli/setup.ts`, `server/src/cli/hooks.ts` and
  `server/src/cli/service.ts` import it.
- `server/src/cli/hooks.ts` (`rarog hooks install|print|doctor|statusline`), `server/src/cli/setup.ts` (the copy
  and settings steps of `rarog setup`), `server/src/cli/doctor.ts` (the hook and `statusLine` lines of
  `rarog doctor`), `server/src/cli/service.ts` (removing Rarog's entries and the copy after
  `rarog service uninstall` in the package, or the blocks to remove by hand);
  `scripts/hooks-config.ts` is the `pnpm run hooks:*` shim in a clone.
- `server/src/bootstrap/health.ts` (`hookHealthProbe`): the `/health` probe; `server/src/herdr/line-diff.ts`: the copy diff;
  `server/src/install/repair.ts`: the repair commands the messages print.
- `scripts/hooks/`: the code Claude Code runs, from the copy.

Installation runs only from a command you start in your terminal. The hook code lives in the repo in `scripts/hooks/`
(`rarog-pending.mjs`, the guard module `tall-dialog.mjs`, the canonicalization module `canon.mjs`, the consent channel
module `consent.mjs`, the `cwd` filter module `work-area.mjs` and the context hook `rarog-context.mjs`), but Claude
Code runs a COPY: `hooks:install` copies these six files and the status line script `rarog-statusline.mjs` to
`~/.claude/hooks/rarog/` and writes a
`manifest.json` there (commit or package version, time, sha256 of the files), and the entries it then writes to
`~/.claude/settings.json` point at the copy (`node '<home>/.claude/hooks/rarog/rarog-pending.mjs' --answer-wait=86398`).
The `SessionStart` entry of the context hook (`docs/distribution.md`, "What Rarog needs from Claude Code
configuration") is written by the Settings step of `rarog setup` and is part of the `hooks:print` block; its state stays out of
the `hook` field, and `hooks:doctor` shows it on its own `context:` line. Reason: Claude Code runs the hook outside
the sandbox on every permission dialog in every session, while an agent in the sandbox can change the repo checkout;
Claude Code protects `~/.claude/hooks` from sandbox writes. You run `hooks:install` in your own
terminal, outside the sandbox. It installs only the committed state: it refuses on an uncommitted change or an
untracked file in `scripts/hooks/`, on bytes that differ from `HEAD`, and when `rarog` is a symlink; it warns when
`~/.claude/hooks` leads outside `~/.claude`. Each file goes through a temporary file and `rename`, mode 0644, the
modules before `rarog-pending.mjs`.

**Files from the previous installation.** A regular file listed in the previous `manifest.json` but missing from the
current set is removed from the copy after the files are written and before the new manifest, and its name is
printed, but only when the name is on the closed list in the code of every file a Rarog copy has had. The manifest
adds nothing to that list: another name it lists stays in place with a warning. A symlink or directory under a listed
name stays with a warning, a file outside the manifest stays silently, and a failed removal keeps the manifest, so the
next `hooks:install` tries again. A list that changed during the run (a parallel installation) gives a refusal
without writing. In `rarog setup` only the copy update of the hook copy step removes such files, after its question; adding a
missing copy or the status line script removes nothing.

**Two install modes, one copy.** In the npm package (`rarog hooks install`) the copy source is the installation
directory, which has no git, so the gate is the human at the screen: the command reads the files from
`<package dir>/scripts/hooks/` once, prints the diff against the current copy (sha256 and line hunks; control,
direction and zero-width characters escaped as `\u{…}`) and asks `[y/N]`. "y" writes exactly the bytes from the diff.
A copy equal to the package is written without a question. Without a terminal a different copy gives a refusal with
exit code 1. The manifest carries `commit` (clone) or `version` (package). The `rarog` command: `docs/distribution.md`.

**The copy is written by the installation the service starts.** The copy runs next to the service's server, so a copy
from another installation would swap the production hook code. `hooks:install`, `rarog hooks install` and both copy
steps of `rarog setup` read the service target from its file in the home directory (the plist `ai.rarog.server` or the
unit `rarog.service`), as `rarog restart` does. When the service starts another `bin/rarog.mjs`, they write nothing
and print the command from the service's installation (`'<node>' '<bin>' hooks install`). A service file without a
readable target, and a copy directory that leads outside HOME through a symlink, also give a refusal. Exception: a
copy that already has the source bytes and no files to remove gets only the manifest written.

`rarog-pending.mjs` dumps the content of the standing dialog (`PermissionRequest`) and of the `AskUserQuestion`
question (`PreToolUse`) to `<dataDir>/pending/`, so the card in the app has the full `tool_input`. On
`PermissionRequest` for `AskUserQuestion` it also WAITS for the file `<dataDir>/answers/<session>/<key>.json` that
Rarog creates and returns it to the CLI as `allow` with `updatedInput.answers`. Hence TWO `timeout` values in the
block: `86400` (24 h) for `PermissionRequest` (the hook waits for the decision from the phone: the form answer, or
the permission with the consent channel; a dialog can stand overnight) and `5` for `PreToolUse` (the hook only
dumps). The hook's own wait cap, `--answer-wait=86398`, is 2 s below that `timeout`, so the hook ends the wait
itself: a hook the CLI kills at its `timeout` dies silently. **After a block change run `hooks:install` again**:
`hooks:doctor` shows an old entry as `mismatch`, and `hooks:install` swaps it for the current entry after a
question. Rules that are not cosmetic:

- **Rarog writes only its own entries in `~/.claude/settings.json`, and only from the `rarog` command in a
  terminal.** `hooks:install` (after the copy) writes the hook entries, the Settings step of `rarog setup`
  the hook entries, `statusLine` and the Rarog paths in `sandbox.filesystem.denyRead`, and `rarog service uninstall`
  in the package removes all of them, each after one `[y/N/d]` question (`d` shows the diff;
  "Writing the hook entries"). `hooks:print` prints all four entries as a block,
  `hooks:doctor` only reads. Project settings files are never
  written. The other writes under `~/.claude` are the copy directory from `hooks:install` and `rarog setup` (a
  missing copy, or the update of a copy that differs from the source, after a question) and its removal by
  `rarog service uninstall` after a question. The server, `rarog restart` and the doctors write neither
  (guard `server/test/hook-granica-guard.test.ts`). Rarog always uses `~/.claude/settings.json` and ignores
  `CLAUDE_CONFIG_DIR`.
- **After every change in `scripts/hooks/` the copy is stale.** `/health`, `restart.sh` and `hooks:doctor` then say
  `stale`: the copy differs from the repo, is missing, is a symlink, cannot be read, or holds a file from a previous
  installation. Order: `hooks:doctor` (which file), a review with `git log <commit from the manifest>..HEAD --
  scripts/hooks` (doctor prints it), only then `hooks:install`: a difference after agents worked can be a swap in the
  repo, and `hooks:install` would carry it out of the sandbox. In the npm package doctor gives the versions and
  `rarog hooks install`, whose diff deserves the same care, because a package under nvm or pnpm lives in the home
  directory (`docs/security-model.md`, "Guarantee boundary"). Doctor also warns about a copy changed after
  installation. Step 5 of `rarog setup` follows the same order: it prints the same `git log` (in the npm package, the
  diff), asks, and after "y" runs the same installation as `hooks:install`; a copy changed after installation gets
  the doctor's warning and no question. A copy older than the server loses at most new dump fields, not decisions
  (the reader is a `z.looseObject`).
- The hook writes ONLY for a `cwd` in Rarog's work area: the directories whose herdr panes Rarog shows in full
  (`RAROG_HERDR_ROOTS`, by default the project roots; `docs/server-config.md`, "Server environment: variables and
  flags"). The server writes them to `<dataDir>/roots.json` at every start, `{"roots": [...], "exclude": [...]}`:
  `exclude` lists the macOS-protected folders of the real home (`<home>/Desktop`, `<home>/Library`…). With the
  field the hook applies the work area rule (`docs/security-model.md`, "Work area: where Rarog starts, lists and
  reads"): no hidden entry directly in a root (`~/.cache/…` under the root `~`) and no excluded folder unless a root
  lies in it, checked on `cwd` as given before any disk access for it, against the roots as written and resolved
  (only the roots go through `realpath`, so a root that is a symlink into a protected folder opens the physical path
  a session reports), then resolved one segment at a time (`work-area.mjs`, which stops before an excluded folder, so
  a symlink into `~/Desktop` gets no read there), and checked again on the resolved path; a `cwd` that does not
  resolve is outside. A file without the field (an older server) gets the plain root check, a field that is not a
  list of absolute paths counts as no file, and a hook copy that does not know the field reads only `roots`, which is
  why `rarog setup` offers home as the work area only with a copy that matches the install. No file = no write; after
  a roots change the server needs a restart. The context hook (`rarog-context.mjs`) applies the same rule through the
  same module.
- **In a programmatic session the hook does nothing.** When `CLAUDE_CODE_ENTRYPOINT` is `sdk-cli`, `sdk-ts` or
  `sdk-py`, the hook reads its input and exits with code 0 and empty stdout, without any trace, as for a `cwd` outside
  the roots. Rarog does not handle programmatic sessions (`claude -p`, the Agent SDK). `sdk-cli` is measured: CLI
  2.1.314 sets it on `-p` when the variable is missing or inherited as `cli`. `sdk-ts` and `sdk-py` are not measured;
  Rarog treats them as programmatic too, by their name. An interactive `claude` keeps an inherited `sdk-*` and so
  loses Rarog's hooks. Panes Rarog creates clear the variable (`RAROG_CLAUDE_ENV_CLEAR`). Name and values:
  `HOOK_PROGRAMMATIC_ENTRYPOINT` in `server/src/herdr/dialogs/hook/contract.ts`.
- Outside the consent channel the hook never approves a tool call, and on `PreToolUse` it never waits (a waiting
  `PreToolUse` holds back the form render in the terminal). There a permission goes by a key on the screen. The only
  `allow` the hook returns there is the ANSWER to `AskUserQuestion` (a tool that executes nothing), and only when
  Rarog wrote a file in `answers/`; its only other output is the FORM refusal of a too-tall `Bash` dialog ("Tall
  dialog guard"). In the consent channel the hook returns `allow`, a bare `deny` or nothing, only from an answer file
  it claimed and whose signature it checked ("Consent channel in the hook"). The answer
  can carry a NOTE on the chosen option (`updatedInput.annotations`, CLI 2.1.288 and newer). `RAROG_HERDR_SEND=0`
  closes this channel at the source. A file the hook did not take is deleted after 3 s, and the answer falls back to
  the digit (an answer with a note: to a refusal with the note text in the transcript). The digit goes only while the
  card the answer came for still stands; a card swapped during the wait gives the refusal `stale-card` without a key.
- In shadow mode the hook also waits on a tool permission but returns no result, and the dialog in the terminal stays
  ("Per-call dump and shadow mode"). In mode `main` or `all` it waits for a signed answer instead ("Consent channel
  in the hook"). Without `<dataDir>/alive.json` in one of these modes it does not wait.
- The channel lives = `hook: ok` in `/health` AND `hookSeenAgo` RETURNING to zero after every dialog. `hookSeenAgo` is
  the marker's AGE in seconds, so steady growth means the hook stopped firing (a removed block, a `cwd` outside the
  roots, no `roots.json`). The field is BEHIND AUTH, in `GET /api/version`, because the marker is written on every
  dialog of every Claude session under Rarog's roots. `mismatch` means the settings hold ANOTHER block than the
  printed one (for example one that points at the repo checkout); `stale` is above. `hook:` in the `restart.sh` output
  does NOT fail the restart. On `stale` `restart.sh` adds the line "hook: the copy in ~/.claude/hooks/rarog/ differs
  from the repo — review the changes (`rarog hooks doctor`), then `rarog hooks install`" (in a clone with the
  `pnpm run hooks:*` shims).
- Next to `hook-seen.json` the hook writes a marker per entry file, `hook-seen.<file without .mjs>.json`, which shows
  which copy file Claude Code calls; `hookSeenAgoByFile` in `GET /api/version` carries the age per file.
- The hook does not create the data directory: the server does. The hook creates subdirectories under it one segment
  at a time, so a directory moved during a call gives a write error and a silent hook, not a re-created path.

### Writing the hook entries

`rarog hooks install` (after the copy: the permission entries) and `rarog setup` write Rarog's entries in
`~/.claude/settings.json`. Setup asks one question for the permission entries, the context hook entry, `statusLine`,
the Rarog paths in `sandbox.filesystem.denyRead` and the write block rules in `permissions.deny`, and applies them in
that order in one write: each operation
works on the result of the ones before it, and one in conflict, refused or waiting for its copy drops out with its
own line while the rest goes in. When herdr's Claude integration is missing, the same question covers
`herdr integration install claude`, which runs after Rarog's write (herdr writes its own entry). `rarog service
uninstall` in the npm package removes Rarog's entries with the same writer. Code: `server/src/cli/claude-settings.ts`
(`writeClaudeSettingsBatch`), the setup step in `server/src/cli/setup-settings.ts`. Claude Code picks up hook edits in the
settings files by itself, so running sessions get the new hook entries without a restart.

- **What changes.** In every event Rarog removes its handlers whose command is the current one or an older form Rarog
  printed (the closed list in `server/src/herdr/hook-commands.ts`), keeps the first handler equal to an expected entry
  in place, and appends each missing entry as a new group at the end of its event. A group or event that this removal
  leaves empty disappears; other handlers, matchers, empty groups and the order stay. Current entries give no
  question, no write and no backup.
- **`statusLine`.** No key or no command: the command of the script copy. Rarog's command, current or an older form
  from the closed list, with or without a chain: the current command with the same chained command. A custom command
  stays when `~/.claude/statusline/` holds a dump (a regular `*.json` file) younger than one hour, because the command
  then writes the dumps itself, and setup reports it as `info`; otherwise it is chained behind the Rarog script
  (`RAROG_STATUSLINE_CHAIN='<command>' node '…'`). Other fields of the object, such as `padding`, stay, and `type`
  becomes `command`. A command that looks like Rarog's but has another form is a conflict; `statusLine` that is not an
  object, a command that is not a string, or an unreadable dump directory next to a custom command is a refusal.
- **`sandbox.filesystem.denyRead`.** The missing ones of `~/.config/rarog/secret` and `<dataDir>/run` go to the end
  of the list; missing `sandbox` and `filesystem` objects are created. A level of the wrong type (for example
  `"denyRead": "x"` or `"filesystem": []`) is a refusal.
- **The write block in `permissions.deny`.** The missing ones of `Edit(//<dataDir>/**)` and
  `Edit(//<home>/.config/rarog/**)` go to the end of the list; missing `permissions` and `deny` are created, and a
  level of the wrong type is a refusal. One function, `writeBlockRules` in `server/src/herdr/hook-commands.ts`,
  builds both rules for the write, the printed block, the removal and `rarog doctor`: `Edit(/`, the absolute path,
  `/**)`. A rule counts only when it is there literally, so an equivalent rule in another spelling stays and Rarog's
  form goes next to it. A path with a character that a permission rule reads as a pattern or as rule syntax (`*`, `?`,
  `[`, `]`, `{`, `}`, `!`, `#`, `\`, `(`, `)` or a control character) gives no rule: the operation is refused with the
  path and the reason, and the other entries are written. The data directory is the installed service's, the same
  one setup uses for the backups. What the rules do in a session: `docs/security-model.md`, "Pairing and device
  keys".
- **Conflict.** A command that looks like Rarog's but is not one Rarog printed (for example the current command with
  `; curl x` appended), `hooks` that is not an object, or an event that is not an array: nothing is written, the
  command is shown verbatim, and the printed block (`hooks:print` with all four entries, or
  `rarog hooks statusline` for `statusLine` alone) is the way to fix it by hand.
- **Refusal, file unchanged.** A file that is not strict JSON (Claude Code rejects `//` comments too), not valid
  UTF-8, over 4 MB, not a regular file, or with a top level that is not an object. The parser message is not printed,
  because it would quote part of the file.
- **The question and the diff.** The diff covers the whole file (a missing file is diffed against empty text) and
  ends with the target (for a symlink its target; the symlink stays a symlink). `rarog setup`, `rarog hooks install`
  and `rarog service uninstall` ask the same `[y/N/d]` question: one sentence that says how many entries go into
  which file (with its own clause for a custom `statusLine` command chained behind Rarog's script). The names of the
  entries and the diff are not printed up front: `d` shows them on the screen, never in a log, and asks again
  (`rarog setup --verbose` also prints the diff before the question). The backup is still made; the line of the
  write or the run log names it. The indent (two or four spaces, a tab) and the final newline follow the file. A
  file not in that canonical `JSON.stringify` layout changes outside Rarog's keys too, so the question then starts
  with "The file will be reformatted". Without a terminal nothing is written and no diff is printed;
  `rarog hooks install` then exits with code 1, and so it does after "n" or Ctrl-D. No flag skips the question.
- **One write.** After "y" Rarog takes its lock, reads the file again and refuses ("changed meanwhile") when the bytes,
  the symlink target or the inode differ from what the diff showed. The original goes to
  `<dataDir>/claude-settings-backup/settings.<time>.<random>.json` (a real directory with mode 0700, the file 0600,
  never overwritten), then a temporary file in the target directory with the target's mode, `fsync` and `rename`. A
  missing file becomes a new file with mode 0600. An error leaves the settings unchanged and no temporary file behind.
  After the write Rarog prints the backup path and the `cp` command that restores it (`rm` for a new file).
- **Only with a matching copy.** The hook entries are written only when the hook copy matches its source, and
  `statusLine` only when the script copy matches; otherwise they would point at a missing or old file, and the
  command says so. The `denyRead` paths and the write block rules need no copy.
- **Known limit.** Claude Code does not know Rarog's lock and rewrites the whole file when it saves a setting. A Claude
  Code write in the milliseconds between Rarog's second read and the `rename` is lost.
- **Removal at `rarog service uninstall`.** In the npm package, after the service is gone, one `[y/N/d]` question
  removes all of Rarog's entries: the handlers with the current or an older Rarog command (other handlers
  stay), Rarog's `statusLine` (a chained command goes back to the `command` field, other fields stay; Rarog's command
  alone removes the key), exactly the two `denyRead` strings that step 8 writes and exactly the two write block rules.
  A group, event, `hooks`, `denyRead`, `filesystem`, `sandbox`, `deny` or `permissions` that this removal leaves empty
  disappears; empty ones of your own stay. A missing file means nothing to remove. A conflict blocks the whole
  removal, also of `statusLine`, `denyRead` and the write block. The
  removal needs no copy. Then the command shows what goes from the copy directory `~/.claude/hooks/rarog/`: only
  names from a closed list in the code (the copy set, `manifest.json` and the hook entry file name that older installs
  used), each only as a regular file; everything else is listed as staying, and a name in the manifest adds nothing
  to the list. Before that the directory has to prove it is a Rarog copy: its manifest lists only names from that
  list and at least one listed file has the sha256 the manifest records. After `[y/N]` it reads
  `~/.claude/settings.json` once more and removes nothing when a Rarog entry is back or the file cannot be read.
  Otherwise it removes those files, `manifest.json` last, and the directory only when it is then empty. Before each
  file and before the directory it checks again that the path still leads to the directory from the question (same
  real path and inode); otherwise it stops and prints what it removed and what is left. A directory without that
  proof, a symlink in place of the directory or of the manifest, a directory of another user, and a path that a
  symlinked parent leads to the home directory, above it or outside it are refused without a question. "n", no
  terminal, a conflict, a refusal or a Rarog entry that is back print the manual steps instead, and `uninstall` still
  exits with code 0.
- **Two settings files.** The entries belong in the user-wide file. With Rarog entries also in
  `<project>/.claude/settings.local.json`, identical handlers fire once and different ones (for example an old
  command) fire twice in that project; `hooks:doctor` warns about it. `/health` reads only the user-wide file.

### Per-call dump and shadow mode

On `PermissionRequest` for a tool (everything except `AskUserQuestion`) the hook does more after the per-session
dump: it leaves a request marker when the server asks for one, leaves a per-call dump and checks whether it may wait
in shadow mode or in the consent channel.
Shadow mode is a hook channel in which Rarog puts its phone decision in a file the waiting hook claims without
returning it to the CLI; the dialog is still answered by a key. The consent channel returns the decision to the CLI
(below). File names and shapes are in `server/src/herdr/dialogs/hook/contract.ts` (the
`.mjs` literals are checked by `server/test/hook-contract.test.ts`), process behavior by
`server/test/hook-shadow.test.ts`. `AskUserQuestion` keeps only the answer channel above.

- **Per-call dump** `<dataDir>/pending/<session>/<key>.json`. The key is `<prompt_id>-<nonce>` with 16 random hex
  bytes, so two identical requests of one turn have different keys. The file carries `key`, `sessionId`, `promptId`,
  `pid` and the hook process start (`startedAt`), `agentId` (subagent only), `permissionMode`, `toolName`,
  `toolInput` (with the same 1 MiB cap and truncation marker as the per-session dump), `cwd`, `at` and `inputSha256`.
  A consent channel request adds `permissionSuggestions` ("Permission suggestions" below).
  It is written `0600` in a `0700` directory, through a temporary file and `rename`. The same process deletes it on
  every exit, also after a signal, and removes an empty session directory, so the dump lives as long as the hook that
  wrote it. A dump after a `SIGKILL` is swept by the server at start ("Server in shadow mode"). Without a `prompt_id`
  of identifier shape there is no dump. The per-session dump still feeds the card and carries the same key as
  `callKey`, which ties a screen card to the consent record of that call ("What stays in the terminal in `all`").
- **`inputSha256`** is the sha256 of the canonical form of `tool_input`: object keys sorted recursively, arrays in
  their order, primitive values as `JSON.stringify` writes them, no whitespace, from UTF-8 bytes.
  `scripts/hooks/canon.mjs` computes it, loaded dynamically: a missing or failing module means no per-call dump and
  no waiting. The server's twin is `server/src/herdr/dialogs/hook/canon.ts`, and shared vectors in
  `server/test/fixtures/hook-kanon/wektory.json` keep both equal. With a truncated `tool_input` the hash covers the
  whole input, not the preview.
- **Request marker** `<dataDir>/markers/<session>/<name>.json` (`HookMarkerFile` in the contract), only when
  `alive.json` has a valid shape, a fresh `ts`, the session on the list, mode `main` or `all` and `markers: true`. The
  hook writes it after it computes the key and the hash and before it picks a route: before the tall dialog guard, the
  consent channel, shadow mode, the registration, the truncation check and every exit without waiting, so also for a
  request whose dialog never appears. A restart break comes before it, so the marker follows the next server's
  `alive.json` ("Restart break" below). The name is the per-call key, the same as in the per-call dump and the
  registration; without a `prompt_id` of identifier shape it is `anon-<pid>-<startedAt>` with `key: null`. The fields
  are the per-call dump's without `permissionMode`, and `inputSha256` is `null` when `canon.mjs` fails. It is written
  `0600` in a `0700` directory, through a temporary file and `rename`. The hook never deletes it and swallows a write
  error; the server reads it into the session pool and removes it ("Top of the screen" below). The time from the
  hook's start to the write (Node start, the `canon.mjs` import, the hash), a signal before the write and a write
  error leave a request without a marker.
- **When the hook waits.** Only with all conditions at once: the session is not programmatic, `cwd` is in the roots,
  the request has no `agent_id`, the per-call dump is written and not truncated, and `<dataDir>/alive.json` has
  `mode: "shadow"`, `send: true`, the session on the `sessions` list, a non-empty `bootId` and a `ts` no more than
  30 s from the hook's clock (either way). A missing file, bad JSON, a missing field or another mode (also `off` and a
  mode the hook does not know) mean do not wait in shadow mode; `main` and `all` take the consent channel below, and a
  hook that starts during a server restart first waits for the next server ("Restart break" below). The
  hook reads `alive.json` at every poll, every 250 ms; when a condition stops holding it ends the wait in under a
  second.
- **Shadow file** `<dataDir>/shadow/<session>/<key>.json`, in a directory apart from `answers/`. The waiting hook
  claims it with `rename` to `<key>.claimed` and exits WITHOUT A RESULT: empty stdout, code 0. The file content
  (`decision`, `inputSha256`) goes only to the log, because in shadow mode the file decides nothing. `<key>.revoked`
  ends the wait without a claim. The wait has the cap from `--answer-wait`. SIGTERM, SIGINT and SIGHUP during a cycle
  end the process with code 0 and no result. The tall dialog guard's form refusal works the same in shadow mode: no
  per-call dump and no waiting.
- **Log `<dataDir>/shadow.jsonl`.** The hook appends (`O_APPEND`, `0600`) a line for each cycle step: `start` (tool,
  `prompt_id`, subagent yes or no, permission mode), `pauza` (a restart break, below), `czekam` (with `bootId` and
  `ts` from `alive.json` as `aliveTs`,
  and `inputSha256`) or `bez-czekania` with a reason, `odbior` (the decision from the file and whether key, session
  and hash match), `sygnal`, `wyjscie` with a reason, the time since process start and whether it waited. A `wyjscie`
  from an `alive.json` veto whose file had a valid shape (for example `alive-ts` or `tryb-nieznany`) also carries that
  file's `bootId` and `aliveTs`; with `tryb-off` after a wait `aliveTs` is the time `mode: "off"` was written. Every
  line has `at`, `pid`, `sessionId` and the key when computed; it never holds `tool_input` content. The reason list:
  `HOOK_SHADOW_REASONS` in the contract. The server rotates the log at start: a file over 8 MB moves to
  `shadow.jsonl.1`. The consent channel writes the same log (below).

**Consent channel in the hook** (`scripts/hooks/consent.mjs`, names and signature in
`server/src/herdr/dialogs/layer1/contract.ts` and `layer1/sign.ts`; process behavior in
`server/test/hook-channel.test.ts`):

- **Route.** The request takes the channel when `alive.json` has a valid shape, a fresh `ts`, `send: true`, the
  session on the list and mode `main` with no `agent_id` in the request, or mode `all`. Any other request takes the
  path above unchanged. A channel request skips the tall dialog guard: the card shows the whole input.
- **Registration before the per-call dump** and before the first log line with the key: the hook draws a 32-byte
  secret and sends `POST /register` to `<dataDir>/run/consent.sock` with `key`, `sessionId`, `promptId`, the
  secret, `inputSha256`, `cardSha256` (sha256 of the canonical `sessionId`, `toolName`, `toolInput`, `cwd`,
  `agentId`, `permissionMode`), `pid`, `startedAt`, `agentId` when present and `permissionSuggestions` with
  `alwaysVersion: 1` when stdin carries them ("Permission suggestions" and "Always option" below). The answer is due
  within 500 ms. A
  missing socket, a refusal or the deadline = the per-call dump and exit without waiting (`rejestracja`, with the
  status or `socket`, `deadline`, `response` in `szczegol`). The secret lives only in the hook's memory and the
  registration body: never in argv, the environment, a dump, the log, a file or stdout. The receipt signature
  (below) is computed from the secret; the secret itself does not leave the hook again.
- **Permission suggestions** (`server/src/herdr/dialogs/hook/suggestions.ts`, `carriedSuggestions` in
  `consent.mjs`). The hook carries the stdin `permission_suggestions` as they are, up to 16 KiB of compact JSON, in
  the registration body and the per-call dump; over that, or when the value does not serialize, it drops the field and
  the request goes on as without suggestions. The server keeps a list only whole: every entry of a documented shape
  (`addRules`, `replaceRules`, `removeRules` with rules of a tool name, `setMode`, `addDirectories`,
  `removeDirectories`; destination `session`, `localSettings`, `projectSettings` or `userSettings`) without an
  unknown field, at most 16 entries and 16 rules or directories per entry. Any other value counts as no suggestions:
  it never refuses the registration or makes the dump invalid, and the registration's log line says only
  `permission_suggestions dropped`, never the content. Apart from the "always" option (next item), the list decides
  nothing, with one exception: an MCP tool whose
  list is empty gets the marker `mcpEmptySuggestions` in the dump, and its card has no approve button (`no-proof`;
  deny and release stay). The channel sends such a request back at once (`release`, `releaseCause: mcp-interaction`,
  "Channel cycle"), so the dialog stands in the pane and the phone answers it with the measured screen card ("Rules:
  what must not be relaxed"). The marker is the raw stdin fact. On CLI 2.1.322 the empty list came only with an MCP tool
  with `requiresUserInteraction` (3 of 3, plain MCP tools 0 of 6), whose dialog a plain `allow` does not close, but
  that sample does not prove the converse. Without the field (an older hook copy, `ExitPlanMode`) everything stays
  as without suggestions. A newer hook against an older server, whose registration schema has no such field, gets a
  refusal for a request with suggestions (`rejestracja`, `400`) and leaves the dialog in the terminal.
- **Always option** (N2; `layer1/always.ts`, `alwaysAllowed` in `consent.mjs`, flag `RAROG_CONSENT_ALWAYS`). A card
  with the approve button offers "always" (`always` in the frame: kind `rule`, `mode` or `directory`, the literal
  value and the destination) only when the flag is on, the registration carries `alwaysVersion` 1 (a version the
  server does not know = 400), the dump's suggestions equal the registration's, and every entry is on the closed list:
  `addRules` with behavior `allow` in `session` or `localSettings`, `setMode` `acceptEdits` in `session`,
  `addDirectories` in `session`, at most 16 entries, no character that does not show on the card, never for
  `ExitPlanMode`. Measured on CLI 2.1.322: `Read` outside the project suggests `Read(//<dir>/**)` in `session`,
  `WebFetch` `WebFetch(domain:<host>)`, `Bash` the exact command in `localSettings`, `Edit` and `Write` `setMode`
  `acceptEdits` in `session`. `decide(allow-always)` passes the same gates as `allow` and checks the option again
  before `deciding` and before the signature; the file is `allow` with `reasonId: allow-always` and
  `permissionsSha256`, the sha256 of the canonical registered list, inside the MAC. The record carries the written
  list (`permissions`). The hook accepts such a file only when the digest equals its own stdin list and that list is
  on the same closed list (else `permissions`), and answers `allow` with `updatedPermissions` equal to its stdin
  `permission_suggestions`: never a value from the file or the server. Claude Code applies each entry to its
  destination (docs: https://code.claude.com/docs/en/hooks, "Permission update entries"). An older hook copy sends no
  `alwaysVersion`: its card has no "always", and an `allow-always` file fails its shape check. With the flag off no
  card gets the option.
- **Wait.** After the per-call dump (`obciety` = no waiting) the line `czekam` also carries the mode. At every poll,
  every 250 ms, and before every claim the hook checks the `--answer-wait` cap and `alive.json`: a `bootId` other
  than the one from the registration answer = `restart`, `off` or `shadow` (and `main` for a request with
  `agent_id`) = `tryb-nizszy`, a mode the hook does not know = `tryb-nieznany`, then `send` and the session list as
  in shadow mode.
- **Claim before reading.** The hook moves `<dataDir>/consent/<session>/<key>.json` to `<key>.claimed` with `rename`
  and only then reads the claimed file (a regular file, no symlink, at most 64 KiB) and verifies it: the HMAC-SHA256
  signature with its secret, compared in constant time, session and key, `inputSha256` and `cardSha256` from stdin,
  `at` not more than 60 s before the registration, the exact field set (a `message` field makes the file invalid).
  Only the claimed content is executed, so a swap of the file between the server's write and the claim cannot reach
  the CLI. An invalid file moves to `<key>.<n>.rejected` and the wait goes on; the log line `odrzucony` carries the
  reason (`podpis`, or `karta-inna` for another input, card or permissions hash), `szczegol` (the verification
  failure) and `n`. An `allow-always` file also needs `permissionsSha256` equal to the hash of the hook's own stdin
  suggestions ("Always option" above).
- **Receipt before `allow`.** A valid `allow` goes to the CLI only after `POST /claim` on the same socket with the
  key, the file's `at` and `mac`: HMAC-SHA256 with the secret over the prefix `rarog-consent-receipt-v1|` and
  `sessionId|key|at` (`CONSENT_RECEIPT_MAC_PREFIX`, `consentReceiptMac` in `layer1/sign.ts`). The server confirms
  only when the record's decision is that `allow` with the same `decisionAt` and the record is `sent` or `claimed`;
  the answer is due within 500 ms. A copy of an old `allow` (a `.revoked` file renamed back, a file written back
  after a revoke or a `release`) keeps a valid file signature, but the record has moved on, so the receipt is
  refused. A refusal, the deadline, a socket without the route (404) or a module without it = exit without a
  decision, reason `potwierdzenie` with the status or `socket`, `deadline`, `response`, `modul` in `szczegol`.
  `deny` and `release` need no receipt.
- **Output.** `allow` without `updatedInput` (for `ExitPlanMode` the `tool_input` from stdin as `updatedInput`), a
  bare `deny` with the fixed text "The user denied this from the phone. Stop and wait for the user's message."
  (`CONSENT_DENY_MESSAGE`; the file carries only a `reasonId`, never text), or nothing for `release` (reason
  `release`: the dialog stays at the desk). `allow-always` = `allow` with `updatedPermissions` equal to the stdin
  `permission_suggestions` ("Always option" above); no other path sets `updatedPermissions`, and never `interrupt`.
  The `odbior` line carries the decision and the `reasonId` in `szczegol`.
- **Every error path ends without a decision**, and the dialog stays at the desk: a missing or failing `consent.mjs`
  (`modul`, also a copy without the file, which `hooks:doctor` shows as `stale`), a failed registration, a veto, the
  cap, an `allow` without the receipt, a signal or an exception.

#### Restart break

A hook that starts while the server restarts would see `mode: "off"` and exit, so its dialog would stay at the desk.
With a restart grace G (`RAROG_CONSENT_RESTART_GRACE`, default 45 s, only on a server with the channel configured
`main` or `all`; `docs/server-config.md`) the server marks the break in `alive.json` (`HookAliveFile` in the
contract):

- **`stop: {ts, graceMs}`** in the stop write of a normal stop (SIGTERM, SIGINT): the stop time and G in ms. A process
  killed without a stop leaves no field.
- **`phase: "starting"`** in every write of a new process from its first one until the first one with a session after
  its effective mode is resolved. Until then the file says `off` because the server is still starting, so a session
  on the list does not end the phase.

After `rarog dialogs off` the server writes neither field until it ends, also in the stop write, so hooks exit as at
`off`.

A tool request (`PermissionRequest`, not `AskUserQuestion`) whose hook sees either field at its start waits before
the request marker, the route and the tall dialog guard (`waitThroughRestart` in `scripts/hooks/consent.mjs`; line
`pauza` with `szczegol` `stop` or `starting` and the file's `bootId` and `aliveTs`). The break lasts until
`stop.ts + graceMs`, with only `phase` until the file's `ts` plus 45 s (`HOOK_RESTART_GRACE_DEFAULT_MS`), and never
more than G from the hook's start; a `stop` with `graceMs` outside 1 ms to 600 s is no break. The hook takes the time
left once from the wall clock and spends it on the monotonic clock, so a wall clock set back does not stretch the wait
past G; a wall clock past the end ends it too, because the monotonic clock stands while the machine sleeps. Every
250 ms the hook first checks the end, so a hook woken after it ends the break without the channel whatever the file
says, then reads `alive.json` again:

- **The channel opens for this request** (a fresh file, `send: true`, `all` or `main` without `agent_id`, the session
  on the list): the break ends and the request takes the consent channel above: marker, registration, per-call dump,
  wait.
- **A server settles without the channel for this request** (a fresh file without both fields and with `off`, as
  `rarog dialogs off` writes it, `shadow`, `send: false`, or `main` for a subagent): the request takes the path it
  would take without the break.
- **Anything else** (the old server's stop file, also stale, no file, `phase`, a channel mode whose list does not have
  the session yet): the hook keeps waiting.

When the break ends without the channel, the hook writes the per-session dump and exits without waiting and without a
decision (`przerwa`), so the dialog stays at the desk. During the break the hook registers nothing, writes no per-call
dump, claims no file and decides nothing; a signal ends it like any wait.

A hook that was already waiting in the channel pauses the same way (`waitResuming` in `scripts/hooks/consent.mjs`).
When `alive.json` ends its wait (the `off` of the stop write, a new `bootId`, a stale file, the session off the list)
and the read that ended it shows either field, it logs `pauza` and claims no file; any other end goes as before. Every
250 ms it reads `alive.json` again:

- **The channel opens for this request:** the hook registers again with the same body and secret, with a deadline of
  at most the time left of the pause. The answer `resumed` from a server with a new `bootId` ends the pause, and the
  hook waits on under that `bootId` (a second `czekam` line); a decision the old server wrote is taken then. An answer
  under the old `bootId` (the old server's socket still answers) and a refusal of a channel still opening (503, no
  socket, the deadline) are tried again at the next poll. Any other answer (409, accepted without `resumed`) ends the
  wait without a decision (`restart`, with the HTTP status or `accepted` in `szczegol`). An answer that comes after
  the pause has ended is not taken.
- **A server settles without the channel for this request:** the wait ends as it would without the break.
- **Anything else:** the pause goes on. A second restart inside the pause does not lengthen it.

A pause ends at the end of its break, counted as above; the pauses of one wait last at most 2G together, G of its first
break. Past either, the hook exits without a decision (`przerwa`). What the new server expects of the second
registration and what a resumed card offers: "Channel cycle", recovery after start. The break a hook waits through at
its start does not count toward the 2G.
`RAROG_CONSENT_RESTART_GRACE=0` = no field and no break: a waiting hook exits at the stop write. Process behavior:
`server/test/hook-channel-restart.test.ts`; through a real server restart:
`server/test/layer1-index.test.ts`.

### Server in shadow mode

`RAROG_CONSENT_CHANNEL` selects the configured mode (`docs/server-config.md`). The shadow steps below follow the
EFFECTIVE mode, which the herdr driver reads at every step: effective `shadow` (configured `shadow`, or configured
`main` or `all` that runs as `shadow`, e.g. a clone without `RAROG_MIN_CLIENT_BUILD`) gets the shadow file before a
phone key and the orphan release; effective `off`, `main` and `all` get neither. Code: `server/src/herdr/dialogs/shadow/`.

- **`<dataDir>/alive.json`** is written by the server every 10 s in either mode, atomically (a temporary file, then
  `rename`): `ts`, `bootId` (a random id of the process start), `mode` from the flag, `send` from `RAROG_HERDR_SEND`
  and `sessions`, the `session_id`s of the Claude sessions Rarog watches within `RAROG_HERDR_ROOTS`. A server with
  the consent channel (configured `main` or `all`) adds `markers: true` while the effective mode is `main` or `all`,
  so the hook writes request markers; with another mode, and on a server without the channel, the field is absent,
  and the transition log below never carries it. A server stop
  (SIGTERM, SIGINT) writes `mode: "off"` with an empty list, so waiting hooks exit at their next poll. With a restart
  grace that write also carries `stop: {ts, graceMs}` (a hook waiting in the consent channel pauses instead), and a
  starting server's writes carry `phase: "starting"` until the first list with a session; the transition log carries
  neither ("Restart break" above). A process killed
  without a stop leaves the last `ts`, and hooks stop waiting within 30 s. The first write after start can have an
  empty session list, because the supervisor does not know the panes yet. When the supervisor adds an agent while
  the written list is empty and the current one is not, the file is written at once, not at the next 10 s tick
  (`AliveWriter.sessionsChanged`, wired by `server/src/bootstrap/alive-sessions.ts`), so a hook started during a
  server restart sees its session soon after the new server reads the herdr pane list. The demo writes no file.
- **Transition log `<dataDir>/alive.jsonl`** (`shadow/alive-log.ts`; only the server writes it, the hook does not read
  it). `alive.json` is overwritten, so the state a hook saw while waiting remains only here. A line
  `{at, ev, bootId, mode, send, sessions}` follows a successful `alive.json` write, with its `ts` as `at`, only on a
  transition: `start` (the process's first write), `zmiana` (a change: `mode`, `send` or the session set differ from
  this process's last line) and `stop` (the `mode: "off"` write at stop); the list is `ALIVE_LOG_EVENTS`. It is one
  append (`0600`), best effort: a line that did not go in waits in a queue of at most 50 lines and goes in order at
  the next write; an overflow drops the oldest, and the next line carries `luka: true` (the history before it is
  incomplete). Under launchd the server is a child of `tsx`, which forwards SIGTERM and SIGINT and kills with
  `SIGKILL` a child that does not confirm the signal in time (tsx 4.23). A process killed without a stop has no `stop`
  line: its end is unknown, before the next `start`.
- **Proof that a dialog stands** (`shadow/evidence.ts`, a pure function over explicit inputs, for a main thread
  request without `agent_id`). Only the full set proves it: a live hook process (pid and start time from the dump
  agree with `ps`) and a fresh (at most 5 s) CLI session registry read `waiting` with the class `permission`.
  The start time agrees when the start from `ps` lies at most 2 s after the dump's `startedAt` and at most 30 s
  before it (`livenessFromPs` in `shadow/liveness.ts`). The hook takes `startedAt` from inside Node, so it trails
  the exec by the Node startup time, which reached 3.5 s on a Mac under full CPU load. A process that took over the
  pid of a dead hook started after that hook, so a start before `startedAt` still means the same process.
  Negative signals only take away: a registry without `waiting` read at least 2 s after the dump; zero open
  `tool_use` of that name in the transcript; an input hash without an open counterpart while another live dump of
  that name has one; a screen queue counter ("k of N", `N − k + 1` standing) lower than the number of live dumps. An
  unknown (a registry without an entry, two writers, a screen without the whole block, an unknown transcript, `ps`
  without an answer) neither proves nor disproves. Two live dumps of the same name and hash are explicitly
  ambiguous: with consecutive calls one is a hook process after a desk decision (the CLI does not kill it, CLI
  2.1.314), with parallel calls the screen does not say which one is on top. A subagent request and a truncated dump
  have no proof. The open `tool_use` come from `openToolUses` (`server/src/herdr/jsonl-pending.ts`) over the
  session's transcript follower; the transcript is unknown until the follower has read something.
- **Shadow file before a phone key** (`shadow/channel.ts`). With `shadow`, an allow (digit) and a deny (`escape`) from
  a tool card have a step before the key; screen dialogs (`dialog:*`) and `AskUserQuestion` do not. The server reads
  the session's per-call dumps, asks `ps` about their hook processes (one call per pid, in parallel, cap 200 ms),
  computes the proof and picks the dump that matches the card: the same tool name and, when the card has a call
  fingerprint (`callPrint`), the same fingerprint of the dump's `toolInput`. Exactly one candidate with proof = a
  shadow file `{key, sessionId, decision, inputSha256, at}` written atomically, then the key. Zero or several
  candidates = no file and a line `shadow: … no file: <reason>` in the server log. The step has a 250 ms wall time
  cap (`SHADOW_DEADLINE_MS` in `timing.ts`): after it, or on an error, the key goes without a file. The keys and the
  fresh screen gates are the same as with `off`. A key that did not go out revokes the file at once. With `off` the
  server reads no per-call dumps and writes no shadow files.
- **Cycle `<dataDir>/decisions/<session>/<key>.json`** (only the server creates it, without `tool_input` content):
  `pending` right before the shadow file, `sent` after it, then one final state. `claimed`: the hook took the file.
  `anulowany`: the server revoked it (`rename` to `<key>.revoked`), because the hook process vanished without claiming
  (the CLI kills a main thread hook on `escape`, CLI 2.1.314), 60 s passed or the key did not go out. `unknown`: the
  write failed, or the file vanished without a claim and without a revoke. The record carries the times (`pendingAt`,
  `shadowAt` of the file write, `keyAt` and `keySent` of the key, `settledAt`), the final state reason, the hook pid
  and start, and the server's `bootId`. The server checks the file 0.3, 1, 2, 5, 15, 30 and 61 s after the write
  (`SHADOW_WATCH_DELAYS_MS`), and the last check revokes it regardless of the hook. The first `rename` decides the
  race: a hook faster than the revoke gives `claimed`.
- **Server restart.** At start, in both modes, the server closes the records of the process before it: `pending`
  without a shadow file = `unknown` (reason `restart`), `pending` with a file = `sent`, `sent` with `.claimed` =
  `claimed`, `sent` older than 60 s without `.claimed` = `anulowany`; a younger one with a live hook stays watched.
- **Orphan release** (`release` in `shadow/channel.ts`, rules `orphanHooks` in `shadow/evidence.ts`). The CLI leaves
  alive a main thread hook whose request was decided at the desk (CLI 2.1.314); it would wait up to the
  `--answer-wait` cap and make the next identical request ambiguous. With `shadow` the server checks the session's
  per-call dumps without `agent_id` at every registry read (every 1.5 s). An orphan is a dump with a live hook process
  that a negative signal took proof from (the transcript signal only 5 s after the dump; with twins the oldest dumps
  above the number of open `tool_use`). In a queue the registry stays `waiting`, so the first request's hook goes out
  only with its tool's result in the transcript. An orphan gets a `<key>.revoked` marker (an unclaimed `<key>.json`
  moves there, otherwise the server creates `{reason: "sierota", at}`). The hook exits without a result (reason
  `odwolane` in `shadow.jsonl`), so the only effect is the end of its wait. An unknown never releases. The server does
  not touch a subagent dump, a `.claimed` file or a key with a cycle in progress. With `off`, and without registry
  reads (`RAROG_CLI_WAITING=0`), there is no release.
- **Log `herdr-audit.log`.** With `shadow` the `approve` entry and the `send_keys` entry of a phone deny have the
  field `shadow` (`written`, `ambiguous`, `no-dump`, `no-match`, `no-proof`, `error`), with `written` also
  `shadowKey`, and `shadowDetail` with the reason for `no-proof`, the cause for `error` and the result for `no-match`
  (closed list `SHADOW_DETAILS` in `server/src/herdr/audit.ts`). There is no `tool_input` content.
- **Start sweep** (`shadow/sweep.ts`, in both modes, after the records are closed). `shadow.jsonl` and `alive.jsonl`
  over 8 MB move to `.1`. Files older than 10 min go from `shadow/<session>/`; per-call dumps of dead hook processes
  and any file older than the hook `timeout` plus 1 h from `pending/<session>/`; records older than 30 days from
  `decisions/<session>/`; empty session directories in these three places. Files in `pending/` itself belong to the
  per-session dump reaper (`sweepPendingHooks`). The sweep does not touch symlinks. The `dumpAge` option switches the
  age rule of `pending/<session>/` to the consent channel rule: a dump of a live process stays whatever its age, and
  past the given age only a dump whose process `ps` did not report goes. The server does not pass this option.
  Request markers older than 7 days go from `markers/<session>/`, with empty session directories there
  (`sweepMarkerFiles`, in every mode); the server logs `consent: start cleanup — markers/ <n>`.

### Channel cycle

The consent channel (layer 1) hands a decision from the phone straight to the `PermissionRequest` hook: the server
writes the signed file `consent/<session>/<key>.json`, the hook claims it (`rename` to `.claimed`), checks the
signature and returns the decision to Claude Code. `server/src/herdr/dialogs/layer1/cycle.ts` runs the cycle of one key.
The server runs the cycle only with configured `main` or `all` (the registration registry exists;
`server/src/bootstrap/consent.ts`). Effective `all` is `main` plus the subagent requests: their cards, the own proof of a subagent
request from its file ("Dialog signals") and the desk fallback below.

- **In the server.** At start `recover` runs before the first card; the cards it publishes reach the devices through the
  session snapshot. Every recovered `running` card then gets `retire` (`retireRunningAfterRecover` in
  `layer1/frames.ts`) before the first transcript check, so a turn end without effect does not bring it back. Then
  every second a file check (`tick`) and a transcript check run. The herdr driver calls an observation of its session
  at every registry read (every 1.5 s) while the effective mode is `main` or `all` (`layer1/observe.ts`, the same code
  the channel measurement server runs). An accepted registration of the session and the session card's entry into
  herdr `blocked` start one at once: the manager reads the registry again and hands the read only to the drivers of
  that engine session, which observe only with `waiting` of the `permission` class (an observation without a screen
  leaves the card without the allow button); such a nudge during a running observation runs one more right after it. At
  effective `all`, while the session has a subagent card in `pending`, the driver also starts the next observation at
  most 1 s after the start of the previous one (`CONSENT_SUBAGENT_OBSERVE_MS`), with or without a registry read in
  between, and each such observation reads the session registry itself, with the time before that read; a failed read
  gives the last registry read of that session (none after a new conversation in the pane). A new conversation also
  cancels the scheduled observation, and one that comes due runs only while the same session still has a subagent
  card in `pending`. With a registry read `waiting` of the `permission` class the driver first reads the pane screen
  for that observation and passes the text with the time the read started (before the herdr query); with any other
  registry read, or a failed screen read, the observation has no screen. A manager registry read without `waiting` of
  the `permission` class that arrives during that screen read drops the observation as late, and the next one runs
  right after it with the newer read. Every registry read without `waiting` of the `permission` class goes to the
  cycle at once, with its time ("Proof rule" below): a manager read, a nudge (which starts no observation) and the
  observation's own read (before the observation goes on). The observation: the per-call dumps and the
  request markers into the session pool, from `ps` the hook
  processes of the dumps and of the marked subagent candidates ("Top of the screen" below), the dialog signals (the
  shadow proof rules without the screen queue counter, the memory of closed `tool_use` and the top of the screen) and
  one cycle step per key; an `AskUserQuestion` dump gets no card. At effective `all` the observation also reads, for
  every subagent dump, the agent's run in the subagent file (`consent-subagent.ts`): one pass per agent file and
  observation, the reads of one session one after another, with nothing read at `main`. The `ps` read comes after
  these reads and takes the hook's age at its own time, so a slow file read does not make a live hook dead. A card
  whose dump vanished gets `dead`. After an incomplete dump read (below) a card whose dump file is still on disk is
  only outside this observation's read: it gets `unknown`, which keeps its registration but drops the proof it held,
  so `deny` and `release` still reach the live hook and `allow` waits for a read of its dump. Every step carries the
  session facts for a claimed answer: the registry read, whether another live main-thread dump
  (`AskUserQuestion` included; at effective `all` also a subagent dump) is in the session and whether the card's dump
  is alone on top of the screen. Every 5 s
  the server checks the hook process of every registry entry with `ps` (pid and start time): a dead one goes to the
  cycle as `dead` without session facts, also an entry without a card (the hook left before the driver saw its dump); an
  unknown `ps` answer keeps the entry. A drop of the effective mode to `off` or `shadow` (the kill switch) runs
  `off`. The
  manager channel gets `revoke(engineSessionId, 'hook-dead')`, which runs `revokeSession` in every mode, and
  `turnEnded(engineSessionId)`, also in every mode: for every main-thread turn of the session with keys waiting for
  proof the transcript facts, read to the current end of the file, go to `applyTurn` with a forced end (no file = a
  turn without facts); a subagent turn waits for the agent's own end. A second call while one for the same session
  runs does nothing. `retire(engineSessionId, permId)`, in every mode, runs the cycle's `retire` for a card removed
  from the devices (session end, `running`), and every card the manager
  reads carries `retired: true` when its record has the `retired` field. `reattached(engineSessionIds)`, in every mode,
  runs the cycle's `markReattached` for every given engine session: the manager calls it on `re-attached` of a known
  pane right before it detaches the old driver, in the same synchronous step, with the engine session of the card and
  the conversation of the agent snapshot when the two differ; a Codex pane calls nothing. `ended(engineSessionId)`, in
  every mode, runs the cycle's `endPool`: the session pool and the session's final cards leave memory (records and
  non-final cards stay) and the session's request markers leave the disk (a marker that cannot be removed stays for
  the start sweep, with the log line
  `consent: session <id> marker <name> not removed: <error>`). The manager calls it at the end of the process of any
  card of the conversation (Session end triggers below), also of a card that does not handle the conversation (a pane
  waiting for its attach slot), only when no other live pane runs the conversation: no other card of the conversation
  describes a live pane, with a driver or waiting for its attach slot (the card the manager's index of herdr panes
  points to), and no pane is in a fresh `agent.list` of the supervisor (the pane of a hidden card). It checks the
  cards before the read and again after it: a pane that appears during the read may be missing from the answer and
  usually has no driver yet. A `done` card (a pane the conversation moved away from or whose process exited) blocks
  nothing, and the `gone` of its pane does not call it. Without the supervisor and on a failed read it does not call
  it. `rarog dialogs release` goes through `release` for the `pending` and `sent` cards of the session (all of them or
  one by `--key`) and answers with the released keys; outside the effective `main` and `all` it answers
  `channel-closed`.
- **Cards on the wire** (`server/src/sessions/consent-cards.ts`). Every non-final card of the conversation, except a
  `running` card, an `unknown` card no device answered and a removed card (session end, `running`, `unknown` without
  an answer), is in `pendingPermissions` of the transcript snapshot of
  the session card that handles the conversation, addressed by its Rarog session id, with `channel: "hook"` and the
  current state, once; another card of the same conversation and a `done` card carry none. The first change of a
  card goes as `permission-pending`, the next ones as `permission-settled`, a final state as `permission-resolved`
  with `by: "hook"` (`applied` with the decision the hook claimed, `expired` otherwise). A `settled-at-desk` card with
  the desk key's decision from the result (`deskDecision`) goes with that decision (`allow`, `allow-always`, `deny`)
  and `by: "terminal"`, so the devices say it was decided elsewhere, not that it expired. A card a device got only from
  the snapshot (e.g. one `recover` published before the manager) counts as shown: its next change goes as
  `permission-settled`, `running` or a final state as `permission-resolved`. `waitingFor` and the push count only
  `pending`.
  `running` removes the card from the devices at once, without waiting for the effect in the transcript:
  `permission-resolved` with `by: "hook"` and the record's decision (`allow` or `deny`, `expired` without one), then
  `retire`, as at the session end. `allow` here means "the answer went to the hook", not "the tool ran". The card
  comes back on no session card, also after a server restart and after the conversation moves to another pane, and a
  decision on it is 410; its record follows the evidence (`applied`, `unknown`, an audit), but no change of it reaches
  the devices. A card first seen in `running` (e.g. a record `recover` published before the manager) goes nowhere and
  gets `retire` too. A claimed answer whose bound result settles it as `unknown` goes through `running` first, so the
  card leaves the devices the same way. `pending` → `unknown` (the call ended without our answer: another hook, a
  result without a known source such as a denial no hook gave, two identical calls) leaves the devices the same way
  too, as `permission-resolved` with `expired` and `by: "hook"`, then `retire`: no device answered the card (the
  record's `decision` is `null`), so it has no button and nothing left to show, and the record stays `unknown` for the
  audit. Such a card first seen without `retired` (e.g. a record `recover` published before the manager) goes nowhere
  and gets `retire` from the first snapshot. `claimed` → `unknown` without `running` (the end of the turn without a result, or the dialog still
  standing after the claim) keeps the card, without buttons, because the phone did answer it. The manager keeps a
  removal in memory until `retire` writes the `retired` field (a failed write keeps it to the end of the process and
  goes to the log). A subagent card at effective `all` follows the same rule: a record reaches `running` only from
  `claimed` with `allow` or `deny` (a claimed `release`, the desk fallback included, ends in `released`), so the
  hidden proof and the desk fallback, which act only in `pending`, have nothing left to decide.
  One card per dialog in both orders: while a channel card of the
  engine session holds the dialog (`pending`, `sent`), the driver sends no second consent card from the screen or
  jsonl and no decision key from the screen, and the manager drops a screen card that arrives meanwhile. A driver
  consent card without the allow button also waits while the engine session has a live main-thread registration
  (a subagent registration does not count) without a channel card, at most 3 s from its acceptance
  (`HERDR_CONSENT_CARD_WAIT_MS`), then goes out; the first
  appearance of a channel card in one of these states removes the session's screen and jsonl consent cards
  (`permission-resolved`, `expired`, `by: "system"`, no key to the driver, a decision on them after that = 410). A
  claimed answer (`claimed`, `running`) and `unknown` hold no dialog: the next dialog gets a screen card. Card events
  go to the session card that handles the conversation: the live pane of the engine session index, then another live
  pane of the conversation, then the last card in memory; a `done` card gets no new card and no change.
- **Session state after a claim** (`server/src/sessions/claim-window.ts`). A card change out of `pending` (the
  phone's answer: `sent`, `claimed`) moves the session from `waiting-permission` to `running` when no other decision
  stands. The answered dialog stays on the pane for a moment after the hook claims the answer, so herdr repeats
  `blocked`. For `CONSENT_CLAIM_WINDOW_MS` (2 s) from the card's `claimed`, `allow` or `deny`, herdr `blocked` of
  that session leaves the state alone. The window ends early on another herdr status, a new hook registration in the
  engine session (main thread or subagent), a `pending` card of another request and a dialog card from the screen or
  the transcript (consent card, question form, dialog outside the transcript); the card sets the state itself, and the
  next `blocked` moves the session to `waiting-permission`. The end of the turn, an interrupt or close from the phone,
  and another conversation in the pane (`/clear`, `/resume`) end the window and drop a held `blocked`: it is older than
  that change. A held `blocked` that herdr still reports in the same conversation moves the state to
  `waiting-permission` at the end of the window or on a new registration, with the log line
  `consent: claim window of session <id> ended (window over|registration): <state> → waiting-permission (herdr: blocked)`;
  the first held `blocked` of a window logs
  `consent: claim window of session <id> holds herdr blocked (<ms> ms after the claim)`. The cycle, the cards and
  their frames do not change.
- **Card timing in the log** (the manager, every mode). `dialog timing: session <id> blocked` when a session card
  enters herdr `blocked`, then `dialog timing: session <id> first card <kind> +<ms> ms from blocked` at the first card
  of that block. A card up to 5 s before the block logs `first card <kind>, not blocked yet` and then
  `first card <kind> -<ms> ms from blocked`. Kinds: `hook` (channel card), `jsonl` (driver consent card with content),
  `screen` (driver consent card without content), `question`, `dialog` (a dialog outside the transcript). No content.
- **Session end triggers** (the manager). Only the card that handles the conversation applies them to the channel
  cards, so a historical card (a pane the conversation moved away from) never touches a successor's cards. The pane
  `gone` and the process exit of any card of the conversation that is not `done` end the conversation's pool and
  request markers (`ended`, without another live pane of the conversation); every other trigger leaves them.
  - Interrupt from the phone, closing the pane from the phone = `release` of the `pending` and `sent` cards.
  - The pane `gone`, the process exit (`exit`; the end or an error of the event stream of a driver that owns the
    process) = on the card that handles the conversation, the non-final cards of the conversation leave the devices
    (`permission-resolved`, `expired`, `by: "system"`), then `revoke(…, 'hook-dead')` and `turnEnded`; on any card of
    the conversation, the one that handles it or not, without another live pane of the conversation, `ended`. Closing
    the pane from the phone removes the non-final cards from the devices the same way before the tab close: after the
    socket check (409) and the write gate (400), after `release` and `turnEnded`, and it waits for the `retired` field
    on disk before calling `closeTab` (a failed write goes to the log and the close goes on), so a server restart during
    the tab close does not bring them back. A failed `closeTab` restores nothing and its error goes to the client: the
    `pending` and `sent` cards are already released, and claimed cards without buttons do not come back on the pane that
    survived; the devices then miss any further change of these cards. A refusal before that (409, 400) leaves the cards
    and their records as they were. The removed cards are the ones the session card carries when the session ends,
    counted before its driver detaches: with a second live pane of the same conversation they do not move to that pane,
    while a card that appears after the detach goes to it. Such a card comes back on no card, also after the
    conversation resumes and after a server restart (the manager calls `retire`, and the record keeps the `retired`
    field), and a decision on it is 410; its record follows the evidence (an audit), but no change of it reaches the
    devices.
  - Lost contact with the pane (`stale`: the end or an error of the event stream of a driver without its own process,
    an unreachable socket, a failed attach) leaves the cards: the answer goes to the hook by file, not through the
    pane, and a dead hook shows in the cycle's observation, which judges the cards again when contact returns.
  - Hiding the card, `dispose`, the driver swap after a socket failure (`re-attached`) and `permission-cleared` leave
    the cards; the next channel observation judges them. After `re-attached` a `pending` card has no allow button
    until the first observation with a known transcript, and a card whose hook started before that observation never
    gets it back (Dialog signals below).
  - Entering a turn-end state (`waiting-input`, `done`, `error`, `interrupted`, `limit-reached`; hiding and closing
    excluded) and closing the pane from the phone call `turnEnded`: claimed answers without a result become
    `unknown` (no approve button), `pending` and `sent` stay.
- **Decisions from devices** go by the same endpoint as other cards, `POST /api/sessions/:id/permissions/:permId`, to
  the cycle and never to the driver; outside the effective `main` and `all` the card counts as expired (410). Only
  the session
  card that handles the conversation takes a decision: through another card of the same conversation, a `done` card
  or a card removed at the session end every decision is 410 with no file. `allow` then passes the screen card gates
  on that card: a pane outside the roots, another live card of the conversation outside the roots,
  `RAROG_HERDR_SEND=0` or a read-only supervisor = 400 with no file; `deny` and `release` always pass. `allow` and
  `deny` use the write protocol below, `release` the release. Answers: 200 accepted; 409 `conflict` (already
  decided), 409 `card-changed` (an allow without the approve button), 409 `release-taken` (a release after the hook
  claimed the answer), 409 `too-late` (the hook does not wait, state `unknown`); 410 (no such card, revoked, removed
  at the session end, or addressed through a card that does not handle the conversation);
  422 `allow-always` (the card has no "always" option, `no-always`), 422 `not-signable`, 422 `write-failed` and 422
  `send-failed` (a cycle error); `release` on an existing card outside the channel (a screen card or the
  session-addressed dialog, `POST /api/sessions/:id/permission`) = 422 `not-channel`, on an unknown card 410. A
  refusal never writes an answer file.

Below is what the module code does.

- **States** (`CONSENT_CYCLE_STATES` in `layer1/contract.ts`): `pending` (a card with buttons), `deciding` (the
  decision is in the record, the file is not there yet; `sent` without buttons on the wire), `sent` (the file is
  there), `claimed` (the hook claimed the file), `running` (the dialog disappeared after the claim), `unknown` (an
  outcome without a certain effect: the end of the turn without an effect or without a binding, an ambiguous binding,
  another hook, a hook `allow` without the hook's receipt, a hook answer signed under another call) and
  the final states `applied`, `settled-at-desk`, `revoked`, `released`. The causes of `unknown` and `revoked` are in the
  contract. Every state change other than the decision write protocol below checks the transition table
  `CONSENT_TRANSITIONS` (`assertConsentTransition` in `layer1/cycle.ts`); a pair outside it is a program error, not
  a card state. A final state has no way out, except
  from `revoked`: `settled-at-desk` (a key at the desk after the card was removed) and `unknown` or `applied` (a hook
  result bound to the key after the revocation, see Effect below). `pending` → `unknown`: the card's call ended
  without our answer and its result does not say who decided it; the card leaves the devices at once (see Cards on
  the wire), and `unknown` has no way out but `applied`, which needs an answer of the record.
- **Key queue.** Every input of a key (decision, release, kill switch, dialog signal, file check, transcript facts,
  recovery) goes through one queue. The first `allow` or `deny` that writes `deciding` wins; the next one gets the
  refusal `decided`.
- **Decision write protocol.** (1) The `deciding` record with `fsync`; a failure (e.g. a full disk) = the refusal
  `write-failed`, no file. An allow then checks the approve button a second time, because the `fsync` takes time:
  without it (the proof deadline passed, the request is no longer the pool winner) the record goes back to `pending`,
  the refusal is `card-changed` and no file is written. (2) The signed answer file with `fsync`; a failure = the
  record goes back to `pending`, refusal `write-failed`. (3) The `sent` record. An allow needs the approve button on
  the card at the moment of the decision (otherwise `card-changed`), a deny and a release need a live, unblocked
  registration (otherwise `not-signable`). The order protects against a process crash, not against power loss: the
  directory gets no `fsync`.
- **File check** (`tick`). `sent` with `.claimed` = `claimed` (`released` for a release); only a `.claimed` with the
  decision and `at` of the current answer counts, not another one under the same key. No `.json` but `.rejected` =
  `revoked` (`signature`); `sent` older than 60 s = the file is revoked (`rename` to `.revoked`) and `revoked`
  (`claim-timeout`). A revocation that lost to the hook (the file is already `.claimed`) gives `claimed`. A `rename`
  that failed for a reason other than a missing file leaves `sent`: the signed answer may still be there, so the next
  check tries again, and a release writes no new file (`write-failed`). The same check publishes every `pending` card
  whose view changed without an observation (the proof deadline passed, another pool candidate took the proof, the
  registration expired); a card whose view did not change sends nothing.
- **Receipt** (`confirmReceipt`, the check in `layer1/receipt.ts`). The hook's `POST /claim` for its key: the
  body is checked first (key pattern, `at` as a whole number, `mac` as 64 lowercase hex characters, no other field:
  400 `bad-request`), then the receipt signature with the secret of the key's live, unblocked registration, in
  constant time. A wrong signature and a key without a live registration both get 403 `refused`, so the answer does
  not tell whether the key exists. Then, in the key queue: a record whose decision is `allow` with this `decisionAt`
  and whose state is `sent` or `claimed` gets `receipt` (the confirmed `decisionAt`, the registration's
  `inputSha256`, the time), written with `fsync` before the answer; `sent` moves to `claimed`. A repeat for the same
  `decisionAt` is confirmed again. Any other record (another state, decision or `at`, a revoke or a `release` that
  came first, a failed write) = 409 `stale`. `claimed` takes the receipt too, because the file check or a revoke
  may see the hook's `.claimed` before the receipt comes. The receipt survives a restart with the record.
- **Proof rule** (`RAROG_CONSENT_PROOF`; `consentKeyRule` and `consentHiddenKeyRule` in `layer1/proof.ts`, the
  version gate in `layer1/version-gate.ts` and `createConsentProofGate` in `layer1/observe.ts`). `channel` (the
  default) gives a main-thread request outside MCP
  the allow button from the channel alone: a live hook with an accepted registration, the full card content (the
  card reasons in "Card" below), the dump's own proof and a fresh registry read `waiting` with the `permission` class.
  The top of the screen, the session pool with its start lock and an incomplete dump or marker read do not count. The
  proof deadline is the registry read plus 5 s (`REGISTRY_MAX_AGE_MS`), checked like the deadline of the top: in the
  key queue step, in the card view and at an allow before and after the `deciding` write. Past it the card has no
  allow button, and the next fresh read gives it back. The time of the registry read, not of the screen read or the
  observation, also orders the verdicts: an older registry read does not overwrite the verdict of a newer one. Every
  registry read of the session without `waiting` of the `permission` class (`active`, another dialog class, several
  processes, no entry), from the manager tick, a nudge or an observation's own read, takes the channel proof of every
  read up to its time at once (`noteConsentRegistryRead` in `drivers/herdr/consent-registry-read.ts`,
  `noteRegistryNotWaiting` in `layer1/cycle.ts`), also while an observation with such a read is still running; that
  observation then changes no verdict, and the next read `waiting` of the `permission` class gives the button back.
  Two live calls of the same name and input (two identical `Edit` calls) each get the button, because a hook claims
  only an answer signed with its own secret, and a late `allow` after a desk decision runs nothing (CLI 2.1.322 and
  2.1.325). An allow with this proof has `proofKind: "channel"` in the record.
  - The version gate gives a session two rules: one for main-thread requests and one for subagent requests. The
    release comes from the same registry read as the `waiting` state of the observation: the release of the single
    live process of the session in that read (`version` in `cliWaitingOf`). A session without a known release (no
    live entry, several live processes, a registry not read yet) counts `screen` for both. For a known release and
    each request kind the first matching row wins: (1) the canary file has `fail` for that release and kind:
    `screen`; (2) the release is not above `CONSENT_CHANNEL_MEASURED_CLI` in `hook/contract.ts`, the release on
    which the package measured that contract (2.1.325): `channel`; (3) the canary file has `pass` for that release
    and kind: `channel`; (4) anything else (no entry, `unmeasured`, no file, an ignored file): `screen`. Only exact
    releases count, so a release without its own entry gets `screen` even between two passed ones. The constant
    goes up only after the same measurement on the new release ("`PermissionRequest` hook behavior").
  - The canary file `<dataDir>/consent-canary.json` holds the results of a measurement of that contract on new
    releases. The server only reads it, never writes it:
    `{"format": 1, "versions": {"<release>": {"main": "pass", "subagents": "unmeasured"}}}`, each kind `pass`, `fail`
    or `unmeasured` (a missing kind is `unmeasured`; other fields are not read). It is read at every observation with
    a known release and parsed again after a change of its inode, size, `mtime` or `ctime`, so a new entry changes
    the rules of a live session without a restart. Any doubt makes the server ignore the whole file, which then
    counts as no file: the constant alone, never more (`channel` up to the constant, `screen` above it; only a
    `fail` in a file the server reads gives `screen` up to the constant). The doubts: a symlink or another
    non-regular file, a mode other than `0600`, over 256 KiB, not JSON, a `format` other than 1, a key outside the
    release shape, a value outside the three results. An install without the file works on the constant alone.
  - A kind's change to `screen` takes away at once every proof taken under its `channel` rule: the main-thread
    proof from the channel and a subagent's hidden proof taken under `channel`. The rule is the one of each request
    (`consentHiddenKeyRule`), so the full hidden proof of a background MCP request, taken under `screen` also while
    the subagents' rule is `channel`, keeps its button after the change. The cycle asks the gate for the
    session's rules again (`current` of `createConsentProofGate`: the release of the session's latest observation,
    the canary file read again) at every check of such a proof: the observation's step, each view of a card with
    the approve button, the decision and the check before the signature. So an observation that took `channel` and
    ends after a newer `screen` verdict gives no button, and an `allow` after a `fail` written since the last
    observation is refused with `card-changed`. A change to `channel` counts from the next observation.
  - A change of a session's rules logs one line, and so does the first observation of a session, unless both its
    rules are `channel` from the constant alone: `consent: session <id> runs Claude Code <version>: proof rule
    main=<rule>, subagents=<rule> (measured <version>; <canary>)`, where `<canary>` is `no canary file`,
    `canary file ignored: <reason>`, `canary file: no entry` or `canary file: main=<result>, subagents=<result>`.
    Rollback: `RAROG_CONSENT_PROOF=screen` (every request by the top, whatever the file says) or removing the file
    (the constant alone).
  - `screen`, MCP tools and subagent requests keep the top of the screen ("Top of the screen" below). A subagent
    request outside MCP gets the button under the subagents' `channel` rule from the hidden proof without the top,
    the background start, the registry state and the session hook list ("Hidden proof" below); under `screen` a
    background subagent request also has the full hidden proof. MCP stays there, also under `channel`, because no
    `allow` closes the dialog of an MCP tool with `requiresUserInteraction` ("`PermissionRequest` hook behavior"). An
    MCP dump with an empty suggestion list has no approve button at all ("Permission suggestions" below): its first
    observation writes the `pending` record without publishing it and sends a signed `release` at once
    (`releaseCause: mcp-interaction`); a release that did not go out publishes the card without the approve button,
    and a `write-failed` is retried at the next observation of the key. A list with entries does not prove a plain MCP
    tool, so it keeps the top of the screen.
  - A verdict `standing` without a proof read (a cycle step without an observation) gives no allow button, under
    either rule.
- **Dialog signals** (`layer1/proof.ts`). `standing` needs the full set: the dump's own proof, a fresh (at most 5 s)
  registry read `waiting` with the `permission` class and, under the `screen` rule ("Proof rule" above), the dump
  alone on top of the screen ("Top of the screen" below). The own proof follows the shadow mode proof without the
  screen queue counter, and two live dumps of the same name and hash are not ambiguous in it: under `screen` the top
  decides between them, under `channel` both stand. A negative signal takes only the
  dump's own proof and never gives the proof to another dump. The own proof has three differences from the shadow
  mode. The first: an input hash without an open counterpart takes nothing and makes no orphan, also while another
  live dump of that name has one, because the top of the screen and the full pool tell requests of one name apart; the
  request's own closure still takes the proof by the second difference. The second difference: a request missing
  from the transcript (zero open `tool_use` of its name) takes the proof and gives `gone` only once the transcript
  has gone past it: a `tool_use` of that name and input hash closed, by its result or by the end of the turn,
  in an entry stamped at or after the hook process start (`transcriptPassed`). `ExitPlanMode` matches by name alone,
  because the CLI rewrites its input between the hook and the entry; one such closure counts for every live dump of the
  name. The follower keeps the input hash, name and time of the last 256 closed calls, not their input. A closure it no
  longer has (pushed out of that memory, a result whose `tool_use` it never read, a read gap, a truncated file) stamped
  at or after the hook process start counts as the closure of that request, so lost coverage takes the proof. A
  follower whose first read starts mid-file (attaching to a long conversation) counts the closures before its window
  as lost at the time of the window's first main-thread `assistant` entry, which in the measured transcripts is never
  older than a closure written before it (a `queued_command` attachment carries the time it was queued, CLI 2.1.295),
  or at the read time when the window has no such entry. A file truncated to zero is a known empty transcript, not an
  unknown one. Before any of that it is an unknown: with several `tool_use` blocks in one message the hook of the first
  starts before the CLI writes any of them, and the CLI writes them together with their results (CLI 2.1.319).
  The third difference: a lost proof stays lost. The cycle keeps two facts in process memory, never on disk: a key
  the transcript went past in any observation (`transcriptPassed` for every dump, whatever the open `tool_use` of its
  name), recorded only while the key has no record or a `pending` one, and per engine session the `re-attached`
  period and boundary. A server restart loses both facts, so a `pending` record that waits for its hook after the
  restart ("Recovery after start" below) counts the restart as a `re-attached` with the boundary after its hook
  start: no allow button (`server-restart`) in that server process, also after the second registration. The button
  needs the transcript history continuous from the hook start, and nobody read the transcript while the server was
  down: a "Yes" at the desk followed by a truncation back to the open call reads like a call still waiting, so neither a
  known transcript nor a fresh proof gives the button back. Unlike a hook start at or before a `re-attached` boundary,
  this hold alone gives no `gone` after 5 s, so deny and release stay on the card. A `pending` record nobody resumes
  is revoked. The period runs from `re-attached` until the first
  observation with a known transcript that started after it and covers every dump of the session; that observation
  ends it and sets the boundary to its own time, while an unknown transcript (no file, a read error) does not end it.
  The manager detaches the old driver in the same synchronous step as the `re-attached` call, and a detached driver
  starts no observation, so only a read of the new follower ends the period. An observation records the keys its
  transcript went past, and ends the period, at its start, before it asks `ps`, so a decision during the `ps` read
  already sees them. A dump that has either fact (for the second, an open period or a hook start at or before the
  boundary), with no record or a record in any state except `deciding`, `sent`, `claimed` and `running`, loses the
  proof before the twin rule (orphans among dumps of one
  name and hash), does not count in it, and 5 s after the dump gives `gone` with any transcript, an unknown one
  included. So a revoked card stays out of that rule while its hook lives: revoking a `pending` record writes no
  decision file, the hook keeps waiting until the hook release below reaches it, or up to the `--answer-wait` cap
  where the cycle does not release it, and of the dump signals a final or `unknown` record uses only `dead`, which
  forgets the registration entry. The card view applies the facts too, so a fact set
  during an observation or before a queued decision takes the allow button at once. For the boundary the card view
  takes the hook start from the hook's registration on the socket, as the verdict does (`canAllow`), not from the
  first dump, which is not authenticated; a card without a registration entry has no allow button. A hook started
  after the boundary gets the proof from the full set. The cost: a card standing before `re-attached`, or one whose
  hook started before the end of the period, loses the allow button and leaves after 5 s, with the decision at the
  desk; a session without a readable conversation file after `re-attached` has no allow button until the first
  successful read; of two identical live calls, one decided at the desk takes the button of the other for good; the
  closure of one of two live `ExitPlanMode` dumps takes the button of both; at the first attach, the result of a call
  from before the window, written after the hook started, takes the button of that hook for good. `deciding`, `sent`,
  `claimed` and `running` records follow the raw signal, in their own verdict and in the rules of the other dumps.
  A subagent request (a dump with `agentId`) has the own proof only at effective `all`, and only while the facts of
  the agent's run in its file `<session>/subagents/agent-<agentId>.jsonl` are known to the end: the read saw an
  opening entry, found no unparsable line in the file and no unfinished line, and reached the end of the file. The
  run starts at the file's last opening entry and lasts to the end of the file. An opening entry is the agent's task
  (a human entry: not a result, not an interruption, not a compaction summary) or the resume message of
  `SendMessage` (an `isMeta` entry with `origin.kind: coordinator`); a compaction (`system/compact_boundary` and an
  `isCompactSummary` entry) opens no run (CLI 2.1.322). The hook's `promptId` does not bind a request to a run: a
  main-thread message written while the agent runs moves it on the agent's next requests and entries, with no
  opening entry carrying it ("Hook input"). The facts are the calls of the run and the results of the whole file.
  A workflow agent's file is `<session>/subagents/workflows/wf_<id>/agent-<agentId>.jsonl`, read when the flat file
  is missing and exactly one run directory (`wf_<id>` shape) has it. Otherwise (no such file, the file
  under two runs, `RAROG_AGENT_FILES=0`, a read error) and at `main` it has none, as in shadow mode. With those facts
  the same rules apply, with three changes. Its own file is its transcript: the main-thread transcript does not
  concern it; a result of a `tool_use` read in the run closes that call at the time of the result entry, and a result
  without a `tool_use` read in the run (also one of a run before a resume) is a closure the memory lacks, at the
  entry time or, without one, at the observation time. `transcriptPassed` runs over these closures, the key the file
  went past is kept like a main-thread one, and 5 s after the dump it gives `gone`. A registry read other than
  `waiting` takes its proof (`unknown`) but never gives `gone`: a background subagent's request waits with the
  registry `busy`. Twins count per thread (the main
  thread, each agent), so an identical main-thread call neither makes it an orphan nor is made one; the top of the
  screen still decides between them, and a foreground subagent's frame differs from the main thread's only by the
  title suffix, so both match and neither gets the button.
  `pending`: a dead hook = `revoked` (`hook-dead`), a negative signal = `revoked` (`dialog-gone`) and the hook
  release, except a subagent card with a live registration, which stays `pending` (its hook does not read
  `.revoked`; the desk fallback below ends it). `sent`: a dead hook = the file is revoked. `claimed` with a live
  hook: the dialog disappeared = `running`. `claimed` whose hook left (the
  dump vanished) or died (`claimedDialogSignal`): another live main-thread dump in the session, or a registry read at or
  after the claim that is no older than 5 s and says something other than `waiting` with the `permission` class =
  `running`; such a registry read that says `waiting` with the `permission` class at least 2 s after the claim, with
  the card's dump alone on top of the screen of that observation and before its deadline, = the dialog stands; an
  unknown or older registry read, a read before the claim, `waiting` within 2 s of the claim or without the card's
  dump alone on top, and `dead` without session facts change nothing. Under the `channel` rule the top does not count
  there, and a `claimed` card whose hook still lives counts its `standing` only without another live dump in the
  session. The dialog still stands 30 s after the claim = `unknown` (`no-effect`).
  An unknown signal changes nothing. `dead` (a confirmed death of the hook process) also forgets the key's registry
  entry, with or without a record; nothing else removes the entry of a live hook before its lifetime ends.
- **Hidden proof** (`consentHiddenProofs` in `layer1/proof.ts`, effective `all` only). A background subagent's
  request has no dialog on screen while its hook waits (registry `busy`), so it never has the full set above. It gets
  the approve button from the hidden proof instead. An observation computes it when it read every dump of the session
  and the subagent files; the cycle gives it to a subagent card in `pending` in place of an `unknown` signal.
  Under the subagents' `channel` proof rule ("Proof rule" above) a subagent request outside MCP
  (`consentHiddenKeyRule`) has it from the live hook, no closure, deadline and mode conditions alone: every subagent,
  so also a foreground, nested, resumed or workflow agent and a background subagent while another permission dialog
  stands, and the hidden proof goes before the top of the screen for it. A signed `allow` reaches only the hook of its
  own key, which waits for its own call, and a hook's `allow` runs the request of a nested agent, of a workflow agent
  and of a background subagent while a main-thread dialog stands ("`PermissionRequest` hook behavior"); a decision by
  another hook ends as an `unknown` effect ("Effect").
  Under `screen`, and for MCP tools, a dump has it when all of these hold:
  - background start: the main transcript has, after the request's checkpoint, an `Agent` result
    `async_launched` (or `forked` with `background: true`) with the dump's `agentId`, and that read reached the end
    of the file on a whole line (same size and `inode` before and after it, last byte a newline) with every whole line
    after the checkpoint parsed as JSON; a line that does not parse could hold the start or the end of the agent, so
    the request gets no hidden proof. The checkpoint is the main-thread line of the `Agent` call that started the
    agent, the `toolUseId` of `<session>/subagents/agent-<agentId>.meta.json` ("Subagent requests"), searched
    backward from the end of the file; without the meta file or that line it is the main turn of the hook's
    `promptId`. So a hook `promptId` of a new main-thread message and a `SendMessage` resume keep the start. A nested
    agent (its start call is in its parent's file) and a workflow agent have no such start, so they get no hidden
    proof and the desk fallback applies;
  - live hook: the hook is alive by `ps`, the input hash matches the dump, and no closure fact covers the key
    (`transcriptPassed`, the lost-proof facts above); the cycle also needs an accepted registration;
  - no closure: the agent's run in the subagent file is known to its end (as for the own proof above), the file
    has no result of the call and no interrupted result stamped at or after the hook start, and the main transcript
    has no end of the agent (a `<task-notification>` with its `<task-id>` and a final status, `killed` included) stamped
    at or after the hook start. An end before the hook start (the run before a `SendMessage` resume) counts for
    nothing;
  - top of the screen: a screen read in which the dump matches the top (`match`, twins included) takes its
    hidden proof for good, from the start of that read (`createConsentTopLoss`, process memory per session; a dump
    leaves it when a complete read no longer has it);
  - deadline: the proof holds for `CONSENT_PROOF_TTL_MS` (2 s) from the oldest read it rests on, the session
    registry read or the observation start, whichever is older; the cycle checks it at every card view and signature;
  - mode: effective `all`, checked by the cycle at every card view and signature, so a drop to `main` takes the button
    at once;
  - registry: a known registry read of the session at most 5 s old that is not `waiting` with the `permission`
    class (a dialog in the session could be this request's);
  - sole hook: Rarog's hook is the only `PermissionRequest` hook the session can have loaded ("Session hook list"
    below).

  A read older than the one the cycle accepted for the key changes nothing, so an observation that computed the hidden
  proof before a matching screen read but reached the cycle after it does not bring the button back. One window stays
  open: an observation whose facts were read after a matching screen read started, but before that read was noted, can
  keep the button until the next observation; one pane per session runs its observations one after another. An `allow`
  decided on the hidden proof carries `proofKind: "hidden"`. Esc in the subagent view's prompt and `ctrl+x ctrl+k`
  leave an interrupted result in the subagent file ("`PermissionRequest` hook behavior"), so they take the proof (no
  closure) even while the hook process still looks alive, and a late `allow` finds no button.
- **Session hook list** (`server/src/herdr/dialogs/layer1/hook-list/hook-list.ts`, the sole hook condition). Another
  hook's decision on a hidden request leaves no trace before the tool result ("`PermissionRequest` hook behavior"), so
  the list is positive: whatever cannot be read without doubt means no sole hook. The server only reads the settings,
  it never writes them. The session process is the one live entry of the CLI registry for the session, with its start
  and arguments from `ps`; a registry start outside the process start window means another process. The list reads,
  following the Claude Code documentation (hooks, settings, managed settings, CLI reference, plugins, plugins
  reference, plugin loading, plugin marketplaces, subagents, skills, worktrees):
  - `--settings`, a file or inline JSON, every occurrence; a relative path, a path with a space, unclosed JSON or a
    missing file means no sole hook;
  - user `~/.claude/settings.json` and `settings.local.json`, project `<cwd>/.claude/settings.json`, and local
    `.claude/settings.local.json` in `cwd` and every directory above it, for the `cwd` of the session's registry
    file and of every request. All of them count for hooks and `enabledPlugins` whatever `--setting-sources` says:
    `ps` joins the arguments with spaces, so a prompt passed as an argument can look like that flag;
  - for a `cwd` in a linked git worktree, the same project and local layers and the agent, skill and command
    definitions of the main checkout, wherever the worktree lies (settings documentation: "In a worktree, it uses the
    file at the main checkout's root"). The list finds the main checkout without running `git`: the nearest `.git`
    above `cwd` is a file with one `gitdir:` line, that directory holds `commondir`, and the common directory it names
    is called `.git`; the main checkout is its parent. A `.git` directory is a plain checkout, and a `.git` file
    without `commondir` (a submodule) makes its own directory the root. A bare repository, a `gitdir` that is not a
    directory and any other layout mean no sole hook;
  - managed settings: `/Library/Application Support/ClaudeCode/managed-settings.json`, every `*.json` in
    `managed-settings.d/`, the rest of that directory as a tree, and the server-managed copy
    `~/.claude/remote-settings.json`. A `com.anthropic.claudecode.plist` under `/Library/Managed Preferences` means no
    sole hook, and so does any system other than macOS;
  - plugins from `~/.claude/plugins/installed_plugins.json`. `enabledPlugins` counts in every layer the list reads.
    A plugin is off only when `false` stands in a layer that surely applies (`--settings`, or the user
    `settings.json` when no argument mentions `--setting-sources`) and no layer gives it another value; a plugin no
    layer names is on (`defaultEnabled` defaults to `true`; the list does not read it, so it scans a superset). A
    managed `false` does not turn a plugin off, because by default only the highest managed source with a policy key
    applies (managed settings documentation). An enabled id that is not installed means no sole hook, and so does any file
    of an enabled plugin, or of a plugin synced from claude.ai (`plugins/synced`), that contains `PermissionRequest`;
  - the entry of every enabled plugin in its marketplace file, because the entry's hooks replace or extend the
    manifest's, and with no `plugin.json` the entry is the manifest whatever `strict` says (plugins reference
    documentation). An entry that contains `PermissionRequest` means no sole hook. The marketplace record comes from
    `~/.claude/plugins/known_marketplaces.json`: a `github` or `git` marketplace must be its copy in
    `~/.claude/plugins/marketplaces/<name>`, with the file at the source's `path` or `.claude-plugin/marketplace.json`;
    a `directory` or `file` marketplace is read in place and must not have been refreshed since the session start
    (`lastUpdated`). A relative-path plugin of a marketplace added from a local path loads in place (plugin loading
    documentation), so its source directory is scanned like the cache copy. Any other marketplace source (`url`,
    `npm`, `settings`), a missing record or file, an entry that is missing or appears twice, or a plugin path that
    leaves the marketplace means no sole hook;
  - agent, skill and command definitions in `~/.claude` and in `.claude` of `cwd` and every directory above it, skills
    synced from claude.ai included: a file that contains `PermissionRequest` means no sole hook, because agent frontmatter
    hooks and skill hooks are live hooks.

  A scanned file (plugin, synced plugin, definition, the rest of the managed directory) contains `PermissionRequest`
  when the word stands in its text. A `.json` file, whatever the letter case of its name (the macOS file system
  ignores case, so the CLI opening `hooks.json` reads `hooks.JSON`), is also checked after JSON decoding. The server
  has no YAML parser, so in any other file the frontmatter (from a `---` at the start, after an optional BOM and white
  space, to the next line that is exactly `---`, or the whole text without such a line) means no sole hook
  (`hook-escape:<file>`) when it holds a backslash outside the pairs `\"`, `\\` and `\n`, an explicit tag (`!` at the
  start of a node, as in `!!binary`) or text after the opening `---` (a frontmatter in another language). Backslashes
  are read in pairs from the left, so `\\` uses up both characters. In double quotes the three pairs give a quote, a
  backslash and a newline, so they neither produce a letter nor join a word; without quotes or in single quotes a
  backslash is literal. Any other backslash means no sole hook, also one before a YAML line break or at the end of the text:
  an escape such as `\x`, `\u` or `\U` can produce a letter, a backslash before a line break joins a word, and without
  a parser the server cannot tell whether a backslash stands in a quoted string. Only the closing `---` is looked for
  on lines split at LF (`---` before CRLF does not close the frontmatter); tags and the reported line number use lines
  split at every YAML line break: CRLF, LF, a lone CR, NEL, LS and PS. Anchors, aliases and complex keys need no rule:
  the node they lead to is written in the same frontmatter.

  Every `PermissionRequest` entry in a layer that counts must be a `command` hook with Rarog's exact command
  (`hookCommand`) and no `args`; an entry written by another Rarog version (another `--answer-wait`) is foreign. A
  file or directory changed at or after the session process start (`ctime` or `mtime`, 2 s slack for `etime`) means
  no sole hook until the session restarts, because the documentation does not say when the CLI reloads hooks. The list
  resolves every path one component at a time, so every symbolic link on the way, an intermediate link of a chain
  included, must predate the session start too: switching a directory link changes a layer without touching the
  file it ends at. A link alone keeps the sole hook (settings files are often links into a dotfiles repository), and
  intermediate directories that are not links are not checked. The sync bookkeeping of claude.ai buckets, the
  `.in_use` markers of plugin versions and `known_marketplaces.json`, whose `lastUpdated` changes while sessions run
  (plugin loading documentation), skip the start check; links on the way to them do not. A slash after a file, a
  trailing one in a link target included, means no file, as in the kernel. An unreadable file, a FIFO or device
  under a file name (files are opened through `safe-read.ts`), JSON that is not an object, a link loop and too many
  files, directories or bytes mean no sole hook, and so do `--plugin-dir`, `--plugin-url`, `--agents` and `--add-dir`
  anywhere in the arguments, inside another flag's value or a prompt included, and so does a `--setting-sources`
  whose value is missing or names a source other than `user`, `project` and `local`. A prompt passed as an
  argument that contains `--settings` is read as that flag: its hooks count, and a `false` in its `enabledPlugins`
  turns a plugin off for the list.
  `disableAllHooks` and `allowManagedHooksOnly` only turn hooks off, so the list ignores them. The list cannot see
  hooks of mods built into the CLI, plugins from `CLAUDE_CODE_PLUGIN_DIRS` or from a `CLAUDE_CODE_PLUGIN_CACHE_DIR`
  cache (the session environment carries secrets, so the server does not read it), hooks passed as SDK options, a
  file deleted after the session start, or a marketplace added again from another source after the session start. A
  verdict from a read started at time `c` covers the requests whose hook started at or before `c`; a request after
  `c` reads again. A verdict holds only for the session process it was read for (the pid and start of the registry
  entry, asked on every call) and for the `cwd` of the requests it was read for: a session restarted under the same
  id, or a call with a `cwd` the verdict does not cover, reads again, also while another read runs. A negative
  verdict answers only a call with the very same `cwd` set, since its cause may lie in a `cwd` a narrower call does
  not ask about; an `ok` over a wider set also answers a narrower one. A read whose
  process changed by its end gives no sole hook and no reason, so it releases nothing early. The keys and the reason of one
  call come from the same verdict. A negative verdict has a kind by its code, the part before the first `:`
  (`hookListVerdictKind`). Durable for the session process: `changed`, `foreign`,
  `hooks-shape`, `hook-in`, `hook-escape`, `marketplace-changed`, `arg`, `platform` and `managed-plist`; it lives
  30 s (`HOOK_LIST_RETRY_MS`), and the desk fallback sends a request without the approve button back at once
  ("Channel cycle"). Transient: `io`, `no-process`, `process-start`, `no-registry-entry`, `no-registry-start`,
  `registry-file`, `budget` and `unparseable`; it lives 2 s (`HOOK_LIST_TRANSIENT_RETRY_MS`), so a mended read gives
  the sole hook before the desk fallback's 10 s run out. Any other code lives 30 s and keeps the 10 s.
  Without the CLI registry reader (demo) there is no list and no sole hook. A change of a session's verdict logs `consent:
  session hooks <session> ok` or `consent: session hooks <session> no (<reason>)`.
- **Top of the screen** (`layer1/top.ts`, the pool in `layer1/cycle.ts`) is the only part of the `standing` proof that
  carries the identity of a request: the allow button goes only to the request that, alone in the full session pool,
  matches the freshly read top of the screen. It applies under the `screen` proof rule, and under `channel` to MCP and
  subagent requests ("Proof rule" above); the pool takes every request under either rule.
  - The pool holds every request the process has read in the session, one candidate per key, from two sources: the
    per-call dumps and the request markers (the marker name as the key). Subagent, `AskUserQuestion` and truncated
    requests are included, whatever `ps` says and whatever the card state. The dumps of an observation go in before its
    markers, so a request read from both at once keeps the dump's fields, and one first read from its marker keeps the
    marker's. A candidate known only from a marker (its hook exited before any observation read its dump, or an `anon-…`
    marker) has no own proof and gets no card, but it takes the button from a twin like any candidate. The pool lives in
    process memory; after a restart it starts from what is on disk: the dumps of live hooks and every marker left. A
    vanished dump, a dead hook, a revoked card, a lost proof and a transcript closure keep the candidate in the pool,
    because a hook that exits without a result leaves its dialog at the desk.
  - Exits, for good. A main-thread candidate exits at a fresh registry read without `waiting` at least 2 s after its
    request was written (the `at` of the record the pool read first). A subagent candidate with a marker exits only
    after its hook is surely dead, `ps` saying `false` for its `pid` and `startedAt` in an observation with a complete
    read, and then at a fresh registry read without `waiting` at least 2 s after that observation: while a background
    subagent's hook waits the registry says `busy`, its dialog appears only after the hook exits without a result, and
    while that dialog stands the registry says `waiting` (CLI 2.1.312 and 2.1.318, "When the hook gets a request"). `ps`
    without an answer is no death, and neither is an answer about a `pid` the observation asked with two different
    starts. Every observation asks `ps` about the hooks of at most 64 such candidates without a dump in it
    (`CONSENT_HOOK_CHECKS_MAX`), the least recently checked first. A hook counts as checked after an observation with
    a complete read asked about it, whatever `ps` answered, and a new candidate counts as checked when the pool reads
    it, so it queues behind the others. The observations go round the list: every such hook is checked within a
    bounded number of observations with a complete read, whatever `ps` says about the others. A subagent candidate
    without a marker never leaves.
  - Pool memory: a candidate keeps only what the match reads (`topFieldsOf` in `layer1/top.ts`) besides its key,
    write time, agent, hook process, whether a marker names it and when its hook was seen dead: the tool name, and for
    `Bash`, `ExitPlanMode` and `Edit` also the input, its hash and the `cwd`. Once its exit is older than the 2 s
    deadline, so every screen read that could compare it has expired, a candidate stays as its key and exit time only,
    and the server removes its marker; a failed removal leaves the file and logs
    `consent: session <id> marker <name> not removed: <error>`. Its dump, still on disk while its hook waits, and its
    marker do not come back as a new candidate. The cap counts the candidates without an exit: above 1024 of them the
    session has no proof until the process restarts, the pool content is released, and the server logs
    `consent: session <id> pool over 1024 candidates, no proof until restart`: no candidate is dropped, because a
    dropped one could be on top. The dumps and markers an observation adds count against the cap before the exits of
    the same observation.
  - Start lock: a session has no proof until a fresh registry read without `waiting` arrives at least 2 s after the
    channel cycle was created and before the screen read starts; the server logs
    `consent: session <id> start lock released` once per session. The process never read the dumps that vanished
    before it started, and only such a registry read shows that none of their dialogs still stands. Markers left by
    the previous process come back into the pool at the session's first observation: a main-thread candidate among
    them exits at the same registry read that releases the lock, a subagent candidate by its own rule, so the twin of
    such a subagent request stays without the button after the lock is released.
  - The match (`matchTop`) gives `match`, `no` or `unknown` per dump. A top without the full identity of a request gives
    `unknown` for every dump. The full identity is a whole `Bash` frame under a listed title or on top of a queue,
    a plan dialog with the plan file name in its footer, or an `Edit` frame without a queue counter, each under the
    rules below. A request of another tool gives `no`, a truncated one and a marker without an input hash
    (`inputSha256: null`) `unknown`. `Bash`: `commandMatches` on the whole frame gives `match`, otherwise `no`, so two
    commands that the wrapped frame shows the same (a space or a new line at the wrap) both match. `ExitPlanMode`: the
    footer file name equal to the name in `planFilePath` gives `match` (every plan version of that name), another name
    `no`, no `planFilePath` `unknown`. `Edit`: `editMatchesOperation` with the dump's `cwd` gives `match`, a proven
    contradiction (`editContradictsOperation`: the header path cannot point to the dump's `file_path` from any
    directory) gives `no`, anything else `unknown`. A diff the match cannot explain proves no other call: a real
    dialog with a wrapped line the frame does not prove or with a tab shows a diff that `editMatchesOperation` does
    not explain. Two
    calls with the same diff both match (a `replace_all` of `a b` → `x` on the line `a b ab` and a single
    `a b ab` → `x ab`).
  - A title and a frame on screen do not give the identity alone, because the agent can type both into the content
    of another dialog. The identity also needs the part of the dialog that the CLI draws under the content (the zone
    between the frame's bottom rule and the first option) and the bottom of the read. A `Bash` or `Edit` top needs a
    read whose last non-empty line is a permission footer from the closed list below, or that footer with one session
    name edge under it (`dialogBottomAnchored` in `screen/dialog-bottom.ts`): a real dialog stands at the bottom of
    the pane (so does every capture of the corpus test below apart from its listed exceptions, e.g.
    `measured/zgoda-bash-2.1.293`), and a whole dialog typed into the transcript of a scrolled view has more
    transcript under it. The plan dialog takes its file name only from the footer that is the last group of lines of
    the read (`planFooterFile`).
  - A `Bash` dialog reaches the top in two ways. Under a listed title the block identity is `title` and the whole
    frame comes from `wholeBashFrame` (`decide/sources.ts`). On top of a queue the title line ends with "k of N", so
    the block has no tool name: its identity is `form` in default mode (no `Ask rule` line,
    `dialog-bash-kolejka-licznik-2.1.319`, CLI 2.1.319) or `ask-rule` when an `Ask rule` line (on CLI 2.1.328 a
    `Rule Bash(…) from …` line) stands under the frame.
    It must be `form` or `ask-rule` naming `Bash`, and the title without a valid counter (1 ≤ k ≤ N, N ≥ 2) must be
    a `Bash` title. For this match only (`bashTop` in `layer1/top.ts`) both ways then go through the same rule, and
    the whole frame counts as the top when all of these hold: above the first option there is exactly one pair of
    a bare block rule and a title, counting titles from the closed list and lines that end with a counter together,
    and it is the pair of that way on the nearest rule, a listed title or a counter title (`titlePair` in
    `screen/block.ts`); the whole frame sits under the header of that block, and that header has no region rule, so
    the block holds one frame; the zone holds only lines from the closed list below and one question "Do you want to
    proceed?" as its last line, empty lines aside (`bashZoneListed` in `screen/bash-zone.ts`). The last two
    conditions check what the CLI draws, because a rule, a `Bash` title (listed or "… 1 of 2") and a frame typed into
    the content of another dialog (`Read`, `Write`, `Edit`, MCP and others) are the only pair on the screen once that
    dialog's title stands above the top edge of the read, and an `Ask rule Bash(…)` line typed under a typed frame
    gives the `ask-rule` identity. The agent writes the lines above the typed pair, so a margin below the edge proves
    nothing, and the read does not say where the pane was cut. Any line outside the list gives `unknown`: another
    tool's question, a `Read(…)` line, an MCP tool description, a permission rule of another tool, a second frame,
    text appended to a listed line, a second question, and an auto-mode classifier reason that is not listed, so a
    dialog with such a line is decided at the desk. A typed pair with the other dialog's title on screen, a second
    title pair (also a counter pair above a listed title), a counter title in a block above a dialog without a listed
    title, a counter pair typed into the frame, a conflicting `Ask rule`, a wrong counter (`0 of 2`, `3 of 2`,
    `1 of 1`) and a frame cut at the top or without its header also give `unknown`. The dialog identity for the rest
    of the engine, `wholeBashFrame` and the dump rules of the card path do not change.
  - An `Edit` top (`editTop` in `layer1/top.ts`) needs a header of two lines (the title and the path) and a zone that
    holds only the question "Do you want to make this edit to <name>?" with the base name of the header path
    (`editZoneListed` in `screen/edit-zone.ts`; measured on 2.1.258 to 2.1.293, `measured/zgoda-edit-2.1.293`). The
    question may wrap: its lines, one under another and without the callout bar, are joined with a space (a narrow
    pane wraps the `NotebookEdit` question onto three lines, `measured/zgoda-notebookedit-waski-2.1.311`). Another
    tool's question, another file name or a full path, appended text, a callout bar, an empty line inside the
    question, a second frame and any other line give `unknown`. No measured `Edit` dialog has a CLI line above its
    question (a permission rule or the auto-deny countdown), so such a dialog is decided at the desk. A footer
    wrapped in a narrow pane splits the permission marker, so the `Edit` dialog then has no permission kind and gives
    `unknown`, as the narrow `NotebookEdit` does.
  - The closed lists of the zone and the bottom live in the screen signature registry (`screen/signatures.ts`);
    a line joins a list only with a fixture and the CLI version it was measured on. A `Bash` zone line (`bashZone…`
    entries) matches exactly or by a pattern anchored on the whole line. It may wrap, and its screen lines are joined
    with a space: up to six consecutive lines that all carry the callout bar `│ `, or two lines without it (measured
    on 2.1.302, 2.1.309, 2.1.311, and 2.1.294 for the countdown; four barred lines on 2.1.328), so six leave a margin
    of two lines for a narrower pane. A joined run counts only when its whole text matches one listed line, and every
    zone line belongs to exactly one such line. Where the zone splits in more than one way, the shortest run that
    still lets the rest split wins, so two listed lines under each other stay two lines even when their join is also
    listed. A seventh barred line, a third line without the bar, a bar on only some lines of a run or an empty line
    inside it gives `unknown`. The rule in the parentheses of the `Ask rule`, `Permission rule` and
    `Rule Bash(…) from` lines is free text, so a barred run that starts with such a line's opening and ends with its
    closing passes whatever its lines between say, up to six lines. The `Bash` question itself does not wrap and has
    no bar. The `Bash` zone list:
    - `Ask rule Bash(<rule>) overrides auto mode for this command.` (2.1.295, `dialog-bash-ask-rule-2.1.295`; wrapped:
      `dialog-bash-opis-telefon-2.1.302`, with the bar `dialog-bash-subagent-uciety-62x29-2.1.309`) and
      `/permissions to let auto mode decide` (2.1.295, same fixture);
    - `Permission rule Bash requires confirmation for this command.`, also with the `ask` rule from the user's
      settings in parentheses, `Permission rule Bash(<rule>) requires confirmation for this command.`, and
      `/permissions to update rules` (2.1.311, `measured/zgoda-bash-komenda-z-kreska-2.1.311`, wrapped with the bar;
      2.1.321, `kontrolny/zgoda-bash-regula-bash-2.1.321`, with the rule
      `kontrolny/zgoda-bash-cytat-default-regula-2.1.321`);
    - the same rule lines as CLI 2.1.328 words them, with the rule's source after `from`: `Rule Bash(<rule>) from
      <source> overrides auto mode.` in auto mode (`kontrolny/zgoda-bash-cytat-auto-2.1.328`) and `Rule Bash from
      <source> says to ask.`, bare or with the rule in parentheses, in default mode
      (`kontrolny/zgoda-bash-regula-bash-2.1.328`, `kontrolny/zgoda-bash-cytat-default-regula-2.1.328`), under them
      the same `/permissions …` hints. The source is a closed list of measured phrases: `command line arguments`
      (rules passed with `--settings`), `user settings` (the user's `settings.json`), `shared project settings`
      (the project's `.claude/settings.json`) and `project local settings` (the project's
      `.claude/settings.local.json`), each in both modes with the rule in parentheses
      (`kontrolny/zgoda-bash-cytat-auto-{user,project,local}-2.1.328`,
      `kontrolny/zgoda-bash-cytat-default-regula-{user,project,local}-2.1.328`). Managed settings were not measured;
      a rule from them or any other source gives `unknown`. An empty parenthesis does not pass;
    - command check warnings, exact text: `Parser skipped input between top-level statements` (2.1.295,
      `dialog-bash-ask-rule-2.1.295`), `Contains brace with quote character (expansion obfuscation)` (2.1.295,
      `dialog-bash-stechly-read-2.1.295`), `Tilde in assignment value — bash may expand at assignment time`
      (2.1.295, `dialog-bash-stechly-read-szeroki-2.1.295`), `A variable in this command can't be checked before it
      runs` (2.1.302, `dialog-bash-subagent-telefon-2.1.302`), `Quoted text in this command can't be checked before
      it runs` (2.1.321, `dialog-bash-cytat-2.1.321`), `This shell -c script runs rm and could not be checked`
      (2.1.294, `dialog-bash-uciety-naglowek-2.1.294`), `Dangerous rm operation not ruled out — the shell may read
      this command differently than it was parsed` (2.1.316, `dialog-bash-licznik-block-2.1.316`, with the bar),
      `Shell expansion syntax in paths requires manual approval` (2.1.295, `measured/zgoda-bash-wysoka-2.1.295`);
    - the removal warning as CLI 2.1.328 words it, one paragraph with the bar, exact: `Claude Code can't be sure it
      read this command the way the shell will, so it can't rule out a dangerous removal. Read the command, and
      don't go ahead if you can't tell what it does.` The CLI flows it to the pane width: two screen lines in a
      119-column pane (`kontrolny/zgoda-bash-dangerous-rm-2.1.328`) and in a 99-column one, where the second line
      starts mid-sentence (`kontrolny/zgoda-bash-dangerous-rm-sredni-2.1.328`), and four lines in a 62-column pane,
      the width of a phone pane (`kontrolny/zgoda-bash-dangerous-rm-telefon-2.1.328`), and in a 57-column one
      (`kontrolny/zgoda-bash-dangerous-rm-waski-2.1.328`); each layout joins into this one listed line;
    - `This command requires approval`, exact text, in default mode without an `ask` rule (2.1.321,
      `kontrolny/zgoda-bash-shell-c-rm-2.1.321`);
    - the auto-deny countdown (`autoDenyCountdown`, both wordings: 2.1.316 `dialog-bash-licznik-block-2.1.316`,
      2.1.294 `dialog-bash-uciety-naglowek-2.1.294`).

    The auto-mode classifier reason is free text: only the measured sentence above is listed, word for word, so any
    other reason stays a cost. The same holds for the sentence CLI 2.1.328 draws with the bar above the question of
    a command that touches a path outside the working directories (`<command> in '<path>' needs approval. The path
    is outside the working directories for this session ('<cwd>'). Allowing runs the command as written.`,
    `measured/zgoda-bash-2.1.328`): it carries the command and the path, so it is not listed, and such a dialog is
    decided at the desk. The `cd` advisory before `git` (`cdAdvisory`) is measured only in the layout without
    a frame (2.1.265), so its place in the zone is not measured and it is not listed. The bottom list
    (`dialogBottomAnchored`) holds the last non-empty line of the read, or the last one above a session name edge:
    - the permission footer `Esc to cancel · Tab to amend` (`permissionFooter`), exact (2.1.293,
      `measured/zgoda-bash-2.1.293`) or wrapped onto two consecutive lines joined with a space (2.1.311,
      `measured/zgoda-notebookedit-waski-2.1.311`, `measured/zgoda-skill-waski-2.1.311`);
    - the footer with the subagent hint, `Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background
      agents` (`permissionFooterAgents`), exact (2.1.302, `dialog-bash-subagent-naglowek-2.1.302`) or cut at the
      pane width: a strict start of it longer than the plain footer, then `…` (`footerTruncation`; 2.1.302
      `dialog-bash-subagent-telefon-2.1.302`, 2.1.309 `dialog-bash-subagent-uciety-62x29-2.1.309`);
    - one session name edge under the footer, empty lines between them aside (`──── <name> ─` after `/rename`,
      `sessionNameEdge`; 2.1.316, `dialog-bash-licznik-block-2.1.316`).

    Text under the footer or appended to it, a second edge, an edge without a name, another dialog's footer and
    a footer wrapped onto three lines or with an empty line inside give `unknown`. The corpus test
    (`server/test/layer1-top-corpus.test.ts`) runs the production match on every fixture with a
    `Bash`, `Edit`, `Write`, `NotebookEdit` or plan dialog against a frozen table, and holds the `Bash` zone of each
    fixture on the zone list or on a list of exceptions with a reason (the outside-path sentence above), and the
    bottom of each fixture on the bottom list or on a list of exceptions with a reason (layouts without an operation
    frame from before CLI 2.1.286, a scrolled view, a plan dialog without a plan file).
  - The winner is the only candidate with `match` while every other gives `no`. The candidates compared are the
    pool minus the exits recorded before the screen read started (an exit at the same instant keeps the candidate);
    a candidate kept as its key only, with an exit at or after the start of the read, means no proof for anyone.
    An `unknown` from any candidate, two matches or none = no proof for anyone. The proof holds only while the
    request is the winner of the current pool for the screen of the proof, and the cycle computes the winner at
    every check (`topWinner`): the key queue step of the observation, the card view (published or read), and both
    checks of an allow. A dump that an observation of another pane of the session adds takes the proof at once, also
    from a card that already has the button; a candidate with `no` takes nothing.
  - Dump read (`scanCallDumps` in `shadow/files.ts`): an observation knows whether it read every dump of the session.
    The read is incomplete when it reached the cap of 64 dumps, or when a file named as a dump could not be read or
    accepted: it vanished between `readdir` and the read, it is not a regular file or is over the size cap, it is not
    valid JSON, or it does not have the shape, session and key of a dump under its name. An incomplete read gives no
    proof to anyone in that observation, because the missing dump could be the dialog on top; its screen read still
    replaces the verdicts of older reads. The shadow mode reads the same list (`readCallDumps`) without the flag. A
    dump the hook removed before any observation read it reaches the pool only through its marker.
  - Marker read (`scanMarkers` in `shadow/files.ts`): the observation lists `markers/<session>/` and parses only the
    names that neither the pool nor the dumps of this observation know, at most 1024 new names per observation
    (`CONSENT_POOL_MAX`, not the dump cap). A file whose name is not a call key or `anon-<pid>-<startedAt>` followed by
    `.json` is skipped, the hook's temporary files among them. The read is incomplete, and the observation gives no
    proof to anyone, past the budget and when a file named as a marker vanished between `readdir` and the read, is not a
    regular file or is over the size cap, is not valid JSON, or does not have the shape, session and name of a marker: a
    key equal to the name with a `promptId`, or for `anon-…` no key, no `promptId` and the `pid` and `startedAt` of the
    name. A broken marker therefore keeps the session without proof until it is removed: by the end of the conversation,
    by the start sweep after 7 days, or by hand for a directory under a marker name. Without markers (a hook copy that
    does not write them) the pool works on the dumps alone, and no observation asks `ps` beyond its dumps.
  - What markers do not cover: a request whose marker is not published (`rename` done) when a screen read starts. That
    is the time from the hook's start to the marker write (Node start, the `canon.mjs` import, the hash), while a
    main-thread dialog already stands, and a request without a marker (a signal before the write, a write error, a hook
    copy without markers). Such a request is unknown to the pool, like a dump no observation read, so a screen read that
    starts in that window can give the button to a request while another request of the same identity (the same tool and
    command, plan file or edit) stands on top or stood there in the previous registry read: the benign case, in which
    the phone approves a request identical to the dialog on top, not necessarily that dialog. The next observation that
    reads the marker takes the button away.
  - Deadline: the proof lasts 2 s from the start of the screen read (`CONSENT_PROOF_TTL_MS`: the 1.5 s registry
    tick plus a margin for `ps` and the read). The observation checks it after every `await`, the cycle in the key
    queue step, the card view and the allow decision again: past it the card has no allow button (`no-proof`), and
    an allow gets `card-changed`. The card reads (`card`, `cards`, the session snapshot) compute the view at the
    moment of the read, and the file check publishes the changed view, so the devices lose the button within a
    second of the deadline, also while the observations of the session fail (e.g. `ps` throws). A verdict from an
    older screen read does not overwrite one from a newer read, and an observation without a screen neither gives
    the proof nor extends it.
  - The cost, for the requests under the top: only the dialog on top gets the button, and the rest of a queue waits
    for its turn; two identical calls,
    two commands the wrapped frame shows the same, and two plans of the same file name get no button while both are in
    the pool; other tools (MCP, `Read`, `Write`, `Edit` in a queue) get no button; a subagent request blocks the button
    of a main-thread request of the same identity while it is in the pool: with a marker while its hook lives or its
    dialog stands, without one until the process restarts; an `ExitPlanMode` dump without `planFilePath` blocks the
    button of a plan on top while it is in the pool; two `Edit` calls of the same file get no button while both are in
    the pool, so in a sequence of edits of one file the next dialogs, standing while the registry says `waiting`, keep
    the first candidate in the pool and get no button, also after an allow from the phone; an observation with an
    incomplete dump or marker read (a hook that exits between `readdir` and the read, 64 dumps or more, more than 1024
    new markers) gives no button, and a broken marker keeps it so until it is removed; an observation that comes after
    the proof deadline (`ps` or the screen read slower than the margin of the deadline, e.g. under load) leaves the card
    without the button until it publishes the card; after a server restart a session has no button until the start lock
    is released, and the twin of a subagent request whose marker survived the restart has none until that candidate
    exits. A session waiting for a permission costs one screen read per registry read, and every observation a listing
    of the session's marker directory and `ps` for at most 64 marked subagent hooks. A pane closed from the phone leaves
    its conversation's markers on disk and its pool in memory until the conversation is observed again or the start
    sweep removes the markers after 7 days.
- **Session end** (`revokeSession`, cause `hook-dead` or `dialog-gone`): `pending` = `revoked` with the cause, `sent`
  = the file is revoked as with the kill switch (a hook faster than the revocation = `claimed`); `claimed`, `running`
  and final states do not change, and no answer file is written. `hook-dead` also forgets every registry entry of the
  session. The answer is the keys of the cards whose state changed, in card order.
- **Release** (`release`). `pending` with a registration = a signed `release` file, without one `released` at once;
  a failed write = the refusal `write-failed`, the record stays `pending` and `releaseFailed` grows by 1.
  `sent`: the file is revoked and a `release` file takes its place; a hook faster than the revocation = the refusal
  `too-late`; a new file that fails to write = `revoked` (`write-failed`), the hook keeps waiting and the dialog stays
  in the terminal until the hook release below writes the file. `claimed`, `running` and `unknown` = `too-late` with
  no new file: the hook may already have acted on the claimed answer, so the transcript decides (an `unknown` with a
  late hook result and a proven effect, see Effect below, becomes `applied`).
- **Desk fallback** (effective `all` only). A subagent card in `pending` with a live, unblocked registration and no
  approve button gets a signed `release` once it has been without proof for `CONSENT_SUBAGENT_GRACE_MS` (10 s,
  `layer1/contract.ts`), counted from the accepted registration or from the moment it lost the button. The time
  does not run while a fresh registry read of the session (at most 5 s old) says `waiting` with the `permission`
  class, also between the registration and the first check of the record; an older read holds it only until it is
  5 s old, and a read older than the newest one taken changes nothing (no period is held twice). One case does not
  wait: under the `screen` hidden rule (`consentHiddenKeyRule`) a durable verdict of the session hook list ("Session
  hook list"), read for the session's current process and the request's `cwd`, at the key's last observation
  releases a card without the approve button at its first check, while `waiting: permission` holds too, because the sole hook
  cannot come back while the session process lives (`consentDeskAtOnce`). The check runs in
  the key queue at every observation and every `tick`. The record keeps `releaseCause: "desk-fallback"` through
  `sent`, the claim and a restart, and the
  hook exits without a decision, so the dialog is answered in the terminal. A written release logs `consent: key
  <key> (subagent) released to the desk after <ms> ms without proof (reason: <code>)`, where the code
  (`layer1/desk-reason.ts`) is `other-hooks` after a durable list verdict and otherwise names the first check that
  failed at the key's last observation: `unknown` (no
  observation facts), `dump-unread` (its dump not read), `scan-incomplete` (dump or marker read incomplete);
  the subagent file: `file-unknown` (no facts: no file, an agent file under two workflow runs, agent files off,
  a read error), `reader-partial` (no opening entry of a run), `file-behind` (not read to the end),
  `file-unsettled` (an unfinished or unparsed line); `hook-not-alive`, `digest`, `passed` (the call closed in the
  agent file), `lost` (a proof-loss fact); the hidden proof: `registry-unknown`, `interrupted`,
  `main-file-unknown`, `not-background` (background start), `run-ended`, `top-seen` (top of the screen),
  `other-hooks` (sole hook); the top proof, when the registry says a fresh `waiting: permission`: `top-twins` (two
  dumps match the top), `top-miss`; and
  `unexplained` (no check failed: the proof expired after that observation). A failed write leaves `pending`, adds 1
  to `releaseFailed` and logs `consent: release of key <key> (subagent) not written, retrying at the next
  observation`; the next check tries again. A main-thread card, a card in any state other than `pending`
  (`deciding`, `sent`, `claimed` and the rest) and a card without a registration never get it.
- **Hook release** (`releaseHook`). A card that ends without a claimed answer while its hook may still wait gets a
  signed `release` file under its key, the same file as a release from a device, so the hook exits without a result at
  its next poll. The transitions: a negative signal on `pending` (`dialog-gone`: the CLI settled the request by
  itself, by a desk key or by the auto mode deny, and does not stop the hook, CLI 2.1.319), the end of the turn
  without the call (`turn-ended`, from `pending` and from `sent` after its file was revoked), a desk key that the
  transcript shows before any negative signal (`pending` → `settled-at-desk`) and a release from a device whose file
  failed to write (`write-failed`). A subagent card with a live registration gets none on a negative signal or when
  its run ends without a result from `pending` (it stays `pending` for the desk fallback, whose failed writes count in
  `releaseFailed`), nor from `sent` with a `release` file. The record, its cause and the card stay as the transition
  left them; the file sends no card event. A `release` never runs the tool, so after a false negative signal the
  dialog stays at the desk, as after a release from a device. Without a live, unblocked registration nothing is
  written. A failed write logs `consent: release file <key> (<cause>) not written, retried at the next observation:
  <error>` once, and every observation with a live dump of the key tries again until the write works, the hook is dead
  or the registration is gone; a written file logs `consent: hook of key <key> released (<cause or state>)`. The file
  check does not look at final records, so the claimed `release` changes nothing. Failed writes are kept in process
  memory only: after a restart the old hook exits (on the new `bootId` in `alive.json`, or with the restart grace
  when its second registration is not resumed, "Restart break"), and `recover` writes no second file. No release for
  a dead hook, a restart, the kill switch (the hook exits on the lower mode in `alive.json`), the session end
  (`revokeSession`: the CLI stops its hooks at `/exit`, CLI 2.1.319, and `hook-dead` forgets the registrations), the
  claim deadline (the hook did not take a signed file for 60 s) and a file the hook set aside (a second file with the
  same signature inputs would fail the same check).
- **Kill switch** (`off`): `pending` = `revoked` (`off`), `sent` = the file is revoked; claimed answers do not change.
- **Recovery after start** (`recover`, before the first card), in this order: `.claimed` of the current answer =
  `claimed` (`released` for a release); `.rejected` without `.json` = `revoked` (`signature`); `.json` = `sent`, and
  60 s after the write the file is revoked (`restart`); nothing with `deciding` and `pending` = `revoked`
  (`restart`). `claimed`, `running` and `unknown` wait for the transcript check. With the restart grace G
  (`restartGraceMs` of the cycle and of the registry, the server's `RAROG_CONSENT_RESTART_GRACE`, with `ps` for the
  cycle; 0 turns all of this off)
  three kinds of record wait for their hook instead, when `ps` finds it alive (pid and start of the registration the
  decision is signed under, else of the first dump): `pending` whose first dump has the card digest of its
  registration, `sent` before its claim deadline, and a `claimed` `allow` without a receipt. `deciding` never waits.
  For G the registry expects the hook's second registration of the key and takes it only with the record's
  `sessionId`, `promptId`, `agentId`, pid, hook start, `inputSha256` and `cardSha256`, and for a decided record only
  with a secret that verifies the record's answer file. The answer is `{"accepted": true, "bootId": <new>,
  "resumed": true}`, the log line `consent: registration accepted — … (resumed after the restart)`, and the record
  keeps its state. A registration that differs blocks the key (409 `key-blocked`); no registration within G, or a
  hook that is dead, gives the outcome above (`revoked`, `restart`; for `sent` the file is revoked), logged as
  `consent: key <key> not resumed after the restart (expired|refused)`. A registration after G, or of a key that
  did not wait, is a first registration (no `resumed`). A waiting `sent` whose file the hook takes before its second
  registration (`claimed`, an `allow` without a receipt) waits on with the same deadline and the same secret check;
  any other change of state ends the wait. A resumed `sent` record counts its claim deadline from the second
  registration and keeps that start in the record (`claimFrom`), so the recovery after another restart counts from
  it too; the hook's `/claim` is confirmed with the secret it sent again. A `pending` card that waited has no allow
  button (`server-restart`) for good, also after the second registration ("Dialog signals" above, the third
  difference); deny and release work once the hook is resumed. A record with `retired` recovers
  the same way, and its card goes to the card store but not to the devices.
- **Removal from the devices** (`retire`, at the session end or at `running`): a non-final record gets `retired`
  (`{at}`) once; the state, the files and the registry do not change. From then on every change of the record goes
  to the card store and the record file, never to `onCard`, also after a restart. A final record and a missing record
  give `false` and no field.
- **Card** (`layer1/card.ts`, store `layer1/cards.ts`, `permId` equal to the key). It shows every input field in full:
  `Bash` as a command block and the other fields in a fixed order (`dangerouslyDisableSandbox: true` adds a note),
  other tools as JSON. A missing approve button has one reason, the first in this order: `terminal-only` (subagent at
  effective `main`), `no-channel`, `key-blocked`, `card-mismatch` (a registration of another call), `truncated` (the
  dump was cut), `no-content` (an empty input; an MCP tool with `{}` is a call without arguments and keeps its card),
  `truncated` (a presentation over `CONSENT_DISPLAY_MAX`, the hook's 1 MiB input ceiling plus 64 KiB for indentation,
  so only an input that indentation inflates hits it; its text does not leave the server, the card says it is not
  shown),
  `hidden-chars` (the text, a field name, a field value or the working directory has a character that does not show on
  the card: C0 and C1 controls other than tab and newline, text direction marks, zero-width characters other than the
  emoji joiner U+200D, line and paragraph separators, BOM, tag characters U+E0000–U+E007F, the variation selectors
  U+E0100–U+E01EF, the Hangul fillers; `CARD_HIDDEN_RANGES` in `server/src/hidden-chars.ts`),
  `card-mismatch` (`cardSha256`), `hook-dead`, `no-proof` (also an MCP dump with the empty suggestion marker,
  "Permission suggestions" below). The verdict and the card view carry the dump's checked `permissionSuggestions` as
  data; no frame sends them to devices. A card with the approve button also carries `always`, the literal updates of
  the "always" option ("Always option" in "Per-call dump and shadow mode"). A card without a verdict, e.g. after a
  restart, has the reason `server-restart`.
  In the app a card text over 32 KiB (the command or one field value) shows as a preview in the card block, cut at a
  line end; the button "Show Full Request · N lines" under the block opens the whole input in a read-only window that
  scrolls and selects (`ConsentInputPreview` in `RarogUI/Model/`, `ConsentInputSheet` in `RarogUI/Session/Cards/`).
  The approve button, the "always" option and the plan approval stay on the card, greyed until that window has
  appeared for the card on the session screen; deny always works (the rule and its limits: `docs/security-model.md`).
  At effective `all` a subagent card skips `terminal-only` and gets the approve button with
  the same full set as a main-thread card ("Dialog signals") or with the hidden proof ("Hidden proof"). The deny
  button needs a live, unblocked registration, for a subagent card also effective `all`. A final state (`applied`,
  `settled-at-desk`, `revoked`, `released`) goes to `onCard` with the full view; right after that the cycle drops the
  dump, the verdict and the screen read of the key from memory, and the store keeps the view without the presentation
  (`presentation: null`, the reason and `createdAt` stay). The record stays in memory until a restart. `endPool`
  removes the session's final cards from the store; a non-final card stays, a subagent card whose hook waits for its
  file included.
- **Proof log** (`layer1/cycle.ts`). A main thread card in `pending` that goes out without the approve button for
  `no-proof` logs `consent: proof of key <key> missing: <members>` once, and again only when the set of members
  changes; when the button comes back, `consent: proof of key <key> ok` once. The members, separated by spaces, name
  each part of the proof that failed:
  - `top=`: the top of the screen did not pick this key. Before the comparison: `no-screen` (no screen read),
    `scan-incomplete` (dumps or markers not fully read), `start-lock`, `pool-overflow`, `exit-unread`, `no-pool`,
    `expired` (the proof deadline passed without a new observation). The screen has no identity: `no-options`,
    `bottom` (text under the dialog footer), `title-pair`, `frame`, `bash-question`, `edit-queue`, `edit-zone`,
    `other-dialog`, `bash-zone(unlisted=<n>,chars=<a>/<b>,bar=<no>/<yes>)` (zone lines outside the list: their
    count, their length in characters and the `│ ` bar, in screen order). The screen has an identity (`screen=bash`,
    `plan` or `edit` in brackets): `other-key` (another key won), `ambiguous`, `no-match`, `unknown`,
    `other-unknown`; `changed` = the top changed between the observation and the card.
  - `registry=`: `not-waiting`, `stale`, `newer-not-waiting`, `class-<class>`, `unknown-<reason>`.
  - `own=` (the hook's own proof): `subagent`, `digest`, `hook-dead`, `hook-unknown`, `transcript-missing`,
    `transcript-digest`, `queue`, `transcript-passed`.
  - `lost=` (lost for good): `transcript-passed`, `reattach`, `before-reattach` (by the registered hook start).
  - `proof=unread`: the verdict had the proof, but no proof read stands behind it (a cycle step without an observation).
  - `rule=screen`: the verdict had the proof from the channel, but the session's main-thread rule is now `screen`.
  - `mcp=empty-suggestions`: the dump carries the MCP marker of an empty suggestion list.

  A card under the `channel` proof rule has no `top=` member: a registry read whose deadline passed, before the card
  step or after it, logs `registry=stale`, and a registry read up to the time of a newer read without `waiting` of the
  `permission` class logs `registry=newer-not-waiting`. A step of the cycle without the observation's findings logs
  `signal=<signal>`; no named member logs `unexplained`.
  The line carries no screen text, command or path. A subagent card logs no proof line, with either proof. A line
  whose top member is `bash-zone(…)`, `edit-zone` or `bottom` (a screen element outside Rarog's closed lists) also
  writes the screen of the proof read to `<dataDir>/refusals/`, once per card ("Refusal diagnostics"): an agent can
  write such a line, so its text goes only to that dump. The dump follows the line, so a subagent card gets none. The
  dump changes nothing on the card.
- **Binding to the call** (`layer1/bind.ts`). `PermissionRequest` carries no `tool_use_id` and a `tool_use` entry
  carries no `promptId` (CLI 2.1.314), so a key binds to a call from the facts of the whole main-thread turn, after
  the turn ends (`system/turn_duration` or a human entry with another `promptId`). Before the end only a key whose
  call is surely over binds (`bindDuringTurn`): its chosen candidate already has a result (a line written after it
  can neither overlap it nor take it, because a hook that starts after that result drops it), or every remaining
  candidate of an ambiguous key has one; a binding made then stays at the end of the turn. A `bound` binding stays
  only when its call's result confirmed it (`bindingConfirmed` in the record): one written at a forced end without a
  result, or a record without the mark, is computed again from the facts of the next check. `Bash`, `Write`, `Edit`,
  `Read`, `WebFetch`, `NotebookEdit`, `WebSearch`, `Workflow`, `Artifact` and MCP tools: the candidate has the same
  name and input `canonicalSha256`; `ExitPlanMode`: the same name; other tools = `incomparable-input`. A candidate
  whose result was written before the hook process started drops out, and the key takes the first remaining one in
  line order. A chosen candidate that was open together with another matching call, a candidate chosen by two keys
  and a matching result without `timestamp` give `ambiguous-tool-use`. Without a candidate the binding stays `open`
  with the cause `no-tool-use`.
- **Subagent turn** (`bindAgentTurn` in `layer1/bind.ts`, effective `all` only). The turn state key is (`sessionId`,
  `agentId`, `promptId`), with `agentId = null` for the main thread: check targets, closed turns and `applyTurn` live
  under it. A subagent key's candidates are the `tool_use` entries of its own file
  `<session>/subagents/agent-<agentId>.jsonl` (a workflow agent: its file under one run, as in "Dialog signals") in
  the key's own run, read with the same rules (CLI 2.1.314, fixtures `subagent-*`). The file's calls are kept for
  every run, each marked with its run; the key's run is the one whose opening entry is the last one written at or
  before the hook process start. So a `SendMessage` resume does not take a key's call of the run before it, an identical
  call after a resume does not settle a hook whose run ended without its call, and a call of a finished run left
  without a result does not make a request of the resumed run ambiguous. An opening entry without a readable
  `timestamp`, or a hook older than the first opening entry, gives `ambiguous-tool-use`. A
  workflow agent has no end in the main file, so its key settles from its result in the file. Its turn ends with the
  agent's end in the main file, read from the main turn's checkpoint to the end of the file: an `Agent` result with
  the agent's `agentId` and a final status (foreground), or a `<task-notification>` with its `<task-id>` and a final
  status in any carrier, standby included (background, CLI 2.1.319, fixtures `m8-*`). The
  `async_launched` result is a start, not an end. An end counts for a key only when it is not older than the hook
  process start: the end of the run before a `SendMessage` resume leaves a request of the resumed run open. The end of
  the main-thread turn, from the transcript or from the caller, does not close a subagent turn, and the end of one
  subagent does not close another. Without the subagent file, with the file not known to its end (an unfinished last
  line, a full line that does not parse, no opening entry seen) or with `RAROG_AGENT_FILES=0`, the key stays
  `open`.
- **Effect** (`layer1/proof.ts`) comes only from the result of the bound call, and settles the key in the check that
  reads it, also before the end of the turn (Binding to the call, above). `permissionDecision.source: "hook"` with the
  claimed decision = `applied` when the effect is proven (`consentAnswerProven`), one rule for both decisions. The
  call's identity: the record binds its call by fields it took from its first dump (the tool name, the input digest,
  the turn's `promptId`, the agent and the hook process start `hookStartedAt`, before which results drop out), and a
  dump is not authenticated. The hook's registration on the socket is, and the hook checks the answer file against
  its `inputSha256` and `cardSha256` (tool name, whole input, session, `cwd`, agent, permission mode). So the decision
  keeps the registration its answer is signed under (the record's `signed`: the card digest and the call identity,
  `CONSENT_CALL_FIELDS` in `layer1/contract.ts`: `promptId`, `agentId`, `pid`, `hookStartedAt`, `inputSha256`), and
  the answer of this `decisionAt` is proven only when each call identity field equals the record's own and the card
  digest equals the one the server computed from the first dump (`dumpCardSha256`, which covers the tool name). A
  mismatch means the bound call may not be the one the phone answered. The key and the session are the registration's
  own slot. `server/test/layer1-binding-registration.test.ts` fails on a record field filled from a dump
  outside these. Delivery: an `allow` also needs the hook's receipt of the answer (`consentReceiptOf`: the record's
  `receipt` for its `decisionAt`, over the record's own `inputSha256`); the hook gives a `deny` without one, and its
  `reject` of the bound call is the effect the phone asked for, whichever copy of the answer gave it. Without the
  proof, including a first dump the hook truncated (no card digest) and a record without the fields (also a `signed`
  without the call identity), such a result = `unknown` (`no-receipt`), fail-closed. With another decision = `unknown`
  (`foreign-decision`); `user_*` or an interruption without a source ("interrupted by user", "doesn't want to
  proceed") = `settled-at-desk`, with the desk decision (`deskDecision`: `user_permanent` with `accept` =
  `allow-always`, another `accept` = `allow`, the rest `deny`); another source = `unknown` (`desk-unknown`). A
  `.claimed` file proves no effect, and the `hook_permission_decision` attachment is not read: it comes in the same
  write as the result with `permissionDecision.source: "hook"` (CLI 2.1.322). A `pending` card whose call has a
  hook result or another source = `unknown` (`foreign-decision`, `desk-unknown`) with the hook release, and the card
  leaves the devices as `expired` ("Cards on the wire"); a `sent`
  answer the hook has not claimed when its call has a result is revoked (`dialog-gone`), the hook released, and the
  result settles the `revoked` record; with a desk key the revocation is not published, so the devices get one
  `permission-resolved` with the desk decision and `by: "terminal"`. An ambiguous key whose candidates all have a
  result = `unknown`
  (`ambiguous-tool-use`) from `pending`, `claimed` and `running`. A `revoked` record with a bound hook result: the
  record's decision with a proven effect = `applied`, without the proof `unknown` (`no-receipt`), another decision or
  none =
  `unknown` (`foreign-decision`); the record keeps the revocation (`revocation`) and stays off the devices
  (`retired`). A claimed answer without a result by the end of the turn = `unknown` (`no-effect`); `pending` and
  `sent` after the end of the turn = `revoked` (`turn-ended`) with the hook release. An `unknown` whose hook result
  arrives in the next check becomes `applied` with the `late` marker only with a proven effect, after a restart too:
  the check reads an `unknown` record's turn again until it sees the turn end. An end of turn given by
  the caller (the session went idle) settles only claimed answers; a `pending` or `sent` card it binds without its
  call's result (any binding but a confirmed `bound`) stays in the check like an unbound one, so a result appended
  to the file settles it and the real end of the turn revokes it. A claim the file check has not seen yet settles
  the same turn result; a claimed answer without a settlement waits for proof also after the turn is closed. A
  subagent `pending`
  record with a live registration stays `pending` after its turn ends without a result: the hook does not read
  `.revoked`, and the desk fallback releases it. For the same reason a subagent `sent` record with a `release`
  decision and a live registration stays `sent`, its file in place: the file check settles the claim (`released`) or
  the claim timeout revokes it. A `sent` record with `allow` or `deny` is revoked and gets the hook release. Esc in
  the subagent view's prompt leaves in the subagent file a result with `is_error` ("doesn't want to proceed") and no
  source (CLI 2.1.319), so it is `settled-at-desk`.
- **Transcript check** (`server/src/herdr/consent-evidence.ts`, outside the follower window) streams the turn facts from
  the record checkpoint: the file, its `inode` and the byte where the turn's first line starts. The server runs it on
  the 1 s tick (`createConsentEvidenceReview`). The file is the session's main-thread transcript
  (`~/.claude/projects/*/<session>.jsonl`), found by the session uuid; a checkpoint path outside that directory is not
  read.
  A record without a checkpoint gets one at the first tick: from the end of the file the check searches back, at most
  64 MiB, for a human entry with the turn's `promptId`; without a certain start the checkpoint is the start of the
  file. A turn gets a pass at once, then every 30 s, and on every tick while a pass has not reached the end of the
  file or while the turn has a card the devices show (`pending`, `sent`, `claimed`: target `live`), so that card
  changes in the tick its call's result is in the file; the facts go to `applyTurn`. One pass reads at most 16 MiB
  and the next one reads on; an unfinished line, also one longer than the ceiling, waits in the check's memory for
  the rest. After a restart the check starts from the
  checkpoint. Another file, another `inode`, a file shorter than the position or a check that began mid-turn = from the
  start of the file. A main-thread turn skips subagent entries (`isSidechain`). A subagent turn reads the main file
  from its checkpoint without stopping at the main turn's end, then the subagent file from its start, with the same
  ceiling per file and the same rules for an unfinished line, another `inode` and a shorter file. The check covers only
  turns with keys without proof (`evidenceTargets`), a `pending` or `sent` card until a confirmed binding or the
  turn end; a `revoked` record with a signed `allow` or `deny` and no binding
  stays in it also after a restart (the hook may have run a copy of the file), a card revoked by a signal only in
  the process that revoked it.
- **Records** `consent-records/<session>/<key>.json` (`layer1/records.ts`, `v: 1`): state, times, decision,
  `reasonId`, binding, checkpoint, `promptId`, hook pid and start, `bootId`, cause; no `tool_input` and no secret.
  The optional `buttonless` (`{reason, at}`) is set once, when a main thread card (at effective `all` also a
  subagent card) in `pending` with a live hook and an accepted registration first goes to the devices without the
  approve button; a subagent card at effective `main`, a card without a registration and a card with the button
  have no such field. The optional `releaseCause` marks a release the server wrote on its own: `desk-fallback` (the
  desk fallback) or `mcp-interaction` (an MCP request with an empty suggestion list, sent back at its first
  observation). `releaseFailed` counts failed writes of a `release` from `pending` (the desk fallback, the MCP
  release and a release from a device or `rarog dialogs release`). The optional `retired` (`{at}`) marks a card removed from the
  devices at the session end or at `running` (above). The optional `proofKind` on an `allow` decision names the proof
  that admitted it: `top` (the top of the screen), `hidden` (the hidden proof) or `channel` (the `channel` proof rule);
  other decisions have no such field. The optional `deskDecision` (`allow`, `allow-always`, `deny`) of a
  `settled-at-desk` record is the desk key's decision from the result, and the optional `revocation`
  (`{cause, at}`) keeps the revoke cause and time of a record that left `revoked` (Effect, above). The optional
  `bindingConfirmed` (`true`) marks a `bound` binding written with its call's result (Binding to the call, above).
  The optional `dumpCardSha256` is the card digest of the first dump, absent for a dump the hook truncated, and the
  optional `signed` (`{decisionAt, cardSha256, promptId, agentId, pid, hookStartedAt, inputSha256}`) keeps the
  registration the decision's answer file is signed under: its card digest and call identity (Effect, above). The
  optional `claimFrom` (`{decisionAt, at}`) keeps the claim deadline start of a `sent` decision resumed after a
  restart (Recovery after start, above); the `sent` time and the signed `decisionAt` stay, another decision ignores
  it, and without it the deadline counts from the `sent` time. A field
  in a bad shape is dropped on read and the record stays, so a `retired` in a bad shape acts as no field, and a
  `signed` without the call identity as no `signed`. The directory is separate from `decisions/`, so the shadow mode
  reader does not see them. `rarog dialogs last-approval --since <time> [--data-dir <dir>]` reads them without a
  server and writes nothing: it prints the `decisionAt` (ISO) of the newest `applied` record with a device `allow`
  decided at or after `--since`, or exits 1; desk decisions, releases, denials and records in a bad shape do not
  count (`latestDeviceApprovalAt`). The sweep (`sweepConsentFiles`) deletes `consent/`
  files older than the hook `timeout` plus 10 min and records older than 30 days. The server runs it at start only
  with the cycle (`main` or `all` configuration) and only after a successful `recover`, so a `sent` record from
  before the restart sees its answer file first, and logs
  `consent: start cleanup — consent/ <n>, consent-records/ <n>`. A start in `off` or `shadow` and a failed `recover`
  delete nothing: `consent/` files come only from `main` and `all` and wait for the next start with the cycle, which
  settles them first.

### What stays in the terminal in `main`

With the effective mode `main` the phone approves only main-thread tool permissions with a channel card. These are
answered in the terminal; the card says why or has no approve button:

- **"Always" options.** A channel card offers "always" only for the closed list of updates ("Always option" in
  "Per-call dump and shadow mode"); any other suggestion (`replaceRules`, `removeRules`, `bypassPermissions`,
  `projectSettings`, `userSettings`) and a plan card stay at the desk, and at `main` a screen or jsonl tool card has
  no always button ("Rules: what must not be relaxed"). "Switch to auto mode" stays at the desk.
- **The sandbox network dialog.** It sends no `PermissionRequest` (CLI 2.1.311, "`PermissionRequest` hook
  behavior"), so it has no channel card. Its screen card gets the "Yes" digit only as a measured consent dialog
  ("Rules: what must not be relaxed"). "Yes" lets the next connections to the same host in the same session through
  without a dialog (CLI 2.1.322, 2 of 2), so it is not a one-connection consent. "Yes, and don't ask again for
  <host>" writes a `WebFetch(domain:<host>)` rule to the project's `.claude/settings.local.json` and stays at the
  desk.
- **Subagent permissions.** At `main` the hook of a request with `agent_id` does not wait for the channel; its card
  has the reason `terminal-only`.
- **A request without the channel.** A main-thread card without an accepted registration, or one the server cannot
  sign, has the reason `no-channel`.
- **Requests standing during a server restart.** Without the restart grace the record is revoked (`restart`) and
  the waiting hook exits without a result at the stop write, so its dialog stays at the desk. A recovered card
  without a verdict has the reason `server-restart`. With the restart grace the waiting hook pauses and registers
  again ("Restart break"), and the server first waits up to G for a live hook to do so and keeps the record when it
  does ("Recovery after start" in "Channel cycle"); a kept `pending` card can be denied or released from the phone,
  and approved only at the desk. A request whose hook starts during the restart waits for the new server's channel
  instead ("Restart break").

### What stays in the terminal in `all`

With the effective mode `all` subagent permissions get channel cards too, so the list above holds without its
subagent item. Its restart item covers hidden requests as well: a hook that is not resumed exits, and the dialog
appears at the desk. A subagent request also ends at the desk, or waits without an approve button, in these cases:

- **A subagent request without proof.** A subagent card in `pending` without the approve button for
  `CONSENT_SUBAGENT_GRACE_MS` (10 s) gets a signed `release` with `releaseCause: "desk-fallback"`, and the hook exits
  without a decision, so the dialog is answered in the terminal ("Channel cycle", desk fallback). Until then the phone
  can deny it. Under the `channel` proof rule such requests are: a subagent file not read to the end or with a
  closure of the call, the same workflow agent file under two runs, `RAROG_AGENT_FILES=0`, and an MCP tool, which
  keeps the rules below. Under `screen` such requests are: a foreground subagent whose dialog is not alone on top of
  the screen (an identical main-thread call matches the same frame), a nested, resumed (`SendMessage`) or workflow
  agent (no background start in the main turn), a subagent file not read to the end, `RAROG_AGENT_FILES=0`, and
  a session hook list that could not be read this time (a read error, the session process or its registry entry not
  seen yet; "Session hook list").
- **A request in a session without the sole hook, at once** (`screen` rule and MCP tools). The session hook list ("Session hook
  list") found another `PermissionRequest` hook in any layer, a settings, agent, skill, command, plugin or
  marketplace file or a link on the way changed after the session start (until the session restarts), a frontmatter
  tag or a frontmatter backslash outside the pairs `\"`, `\\` and `\n` (the server has no YAML parser),
  `--plugin-dir`, `--plugin-url`, `--agents` or `--add-dir`, a managed plist, or a system other than macOS. Such
  a request cannot get the approve button while the session process lives, so the desk fallback releases it at its
  first check, without the 10 s and also while a permission dialog stands, and its screen card says why (below).
- **A hidden request while a permission dialog stands** (`screen` rule and MCP tools). A background subagent's hidden
  request has no approve button while the session's CLI registry says `waiting` with the `permission` class, because
  the standing dialog could be this request's (the registry condition, "Hidden proof"). The desk fallback clock stands still meanwhile, so
  the card stays on the phone; after that dialog's decision the button can come back. A session without the sole hook (the item
  above) does not wait.

A screen card of a tool permission has no approve button in `main` and `all`, because both modes (and a mode the
server cannot read) block its screen digit, except on a measured consent dialog ("Rules: what must not be relaxed").
Its `unavailable` names the reason, first match wins (`server/src/herdr/dialogs/screen-unavailable.ts`):

- **`settings-changed`.** The card's call key (`callKey` of the per-session dump) names a record the desk fallback
  released with the reason `other-hooks`, and the session hook list failed with `changed:<file>`: a file changed
  after the session start. A restart of the session fixes it. A file under the request's directory, when that is not
  the session's directory (a subagent worktree created after the start), gives `unverified-hooks` instead.
- **`other-hook`.** The same release, and the list found another `PermissionRequest` hook (`foreign:`, `hook-in:`).
- **`unverified-hooks`.** The same release with any other verdict of the list (a read error, a marketplace changed
  after the start).
- **`terminal-only`.** A desk release for any other reason, or a subagent request in `main`.
- **`no-channel`.** Any other blocked card: a main-thread card without a channel card, a finished channel card whose
  dialog still stands, a sandbox or MCP dialog without its measured mark, an unknown mode, a card without a call
  key, a release the server no longer remembers.
- **`truncated`, `hidden-chars`.** A card whose digit is not blocked but whose input the card does not show in full.

A degraded card (no input to show) carries no reason and keeps the "deny only" sentence. The cycle remembers the
desk reason and the list verdict of a release in memory, keyed by the call, while the record stays released and the
session lives; after a server restart the card falls back to `no-channel`. The list verdict and the file path stay in
the server: only the reason goes to the app. The channel card and `permission-settled` never carry the screen values
(`server/test/layer1-rama-wartosci-ekranu.test.ts`), because an older app reads an unknown reason on a channel card
as a card without buttons; on a screen card it ignores the field.

### `statusLine` script from the copy

The server takes the session window size and the plan limits from the Claude Code status line payload, which a
`statusLine` script dumps to `~/.claude/statusline/<session_id>.json` (reader: `server/src/herdr/statusline.ts`). The
repo has its own script, `scripts/hooks/rarog-statusline.mjs`. Claude Code runs the `statusLine` command outside the
sandbox at every status line render, so this script also runs from the copy in `~/.claude/hooks/rarog/`, not from the
checkout.

    rarog hooks statusline                      # {"statusLine": …} block pointing at the script copy
    rarog hooks statusline --chain '<command>'  # the same, chained to your own status line script

The block command is `node '<home>/.claude/hooks/rarog/rarog-statusline.mjs'`, with a chain
`RAROG_STATUSLINE_CHAIN='<command>' node '…'`. `rarog setup` writes this command itself in its Settings step,
after its question, and chains a custom command that writes no dumps ("Writing the hook entries"); the block is for pasting
by hand after "n".

- **What the script does.** It reads stdin (at most 64 KiB within 1 s; more, or no EOF, = no dump), checks that it is
  a JSON object with a `session_id` matching `^[A-Za-z0-9-]{1,128}$`, and writes the payload byte for byte through a
  temporary file (a leading dot in the name, `wx`, 0600) and `rename`. The dump directory must be a real directory of
  the user (`lstat`: not a symlink, the same owner); a missing one gets `mkdir` 0700. On stdout it prints the model
  and the window percentage. It always exits with code 0, also on an error: a broken status line script means an
  empty status line in every session.
- **Chain.** With `RAROG_STATUSLINE_CHAIN` the script runs `sh -c '<command>'` after the dump with the same payload
  on stdin and prints its output. After 2 s it kills the command's process group and prints its own line. It also
  kills the group at every end of the script: after a normal exit (a background child) and after the signal with
  which Claude Code interrupts a render at the next status line refresh. Your own script that dumps the payload to
  `~/.claude/statusline/<session>.json` itself (a temporary file and `rename`) is enough too.
- **Separate state.** The `hook` field in `/health` and the hook line in `rarog doctor` and `hooks:doctor` count only
  the hook files. A copy without the script (only hook files, a manifest without its entry) still gives `hook: ok`;
  the next `hooks:install` adds the script and its hash to the manifest. `rarog setup` with such a copy adds only the
  script (after a question), without touching the hook files and the manifest, and then writes `statusLine` (after its
  own diff and question). `hooks:doctor` shows the script copy state on its own line, with no effect on the exit code.
- **`rarog doctor`, the `statusLine` line.** When the command points at the script copy and the copy is missing or
  differs from the repo, the line is red (`stale`) with the fix "review `rarog hooks doctor`, then run
  `rarog hooks install`". A user's own command does not get this check; for it the line says what it always says (a
  fresh dump in `~/.claude/statusline/`).

## `PermissionRequest` hook behavior (measured on CLI 2.1.311)

How Claude Code treats a `PermissionRequest` hook that WAITS for a decision and returns it to the CLI. Measured on
CLI 2.1.311 (and on the version given where it differs) with a measurement hook in separate sessions (own
`--settings` file, own data directory), not with Rarog's hook: `rarog-pending.mjs` returns only the `AskUserQuestion`
answer and the form refusal ("Permission hook"). A desk decision is a key in the terminal; a plain deny is `deny`
with `message`, without `interrupt`.

**Hook input.** Keys: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`,
`effort`, `hook_event_name`, `tool_name`, `tool_input`, `permission_suggestions`. A subagent request adds `agent_id`
and `agent_type`, an MCP tool the field `mcp_server` (`{"name":…,"source":"dynamic"}`). There is no `tool_use_id`
(`PreToolUse` has it). A mode started as `--permission-mode manual` arrives as `permission_mode: "default"`.
`prompt_id` equals the `prompt_id` of the turn's `UserPromptSubmit` for every call of the turn, also from a subagent
started in it (foreground and background); a new user prompt gets a new one. A subagent's request gets the newest
main-thread `prompt_id` at the hook start: a new main-thread prompt while a background subagent runs moves that
subagent too, its next requests get the new `prompt_id` and every `user` entry written to its file from then on
(results included) carries it as `promptId`, while its opening entry keeps the `promptId` of the turn that started
it, and a `SendMessage` resume opens with an `isMeta` entry, not a human one (CLI 2.1.322). The hook's `prompt_id`
can so be newer than every entry of the agent file. The triple (`session_id`, `prompt_id`, `agent_id`) therefore
does not point at one agent's run; a subagent request is bound to the agent's run in its file ("Dialog signals").

**A main-thread `Workflow` call asks the hook** (CLI 2.1.322, `default` mode, fake API with one scripted call). Before
"Run a dynamic workflow?" the hook gets `PermissionRequest` with `tool_name: "Workflow"` and `tool_input` with the
single key `script`, about 40 ms after `PreToolUse` of the same call; the input has no `permission_suggestions`
(a `Bash` request in the same run has it). A hook that returns no decision leaves the dialog on screen with options
1–3, the same block as in "Control set".

**Hook request and the `tool_use` entry** (CLI 2.1.314).

- `PreToolUse` of the same request has `tool_use_id`, the same `tool_input` and `prompt_id`, and starts just before
  `PermissionRequest`.
- The `assistant` entry with `tool_use` has no `promptId`, also in a subagent file. The `user` entry before it marks
  the turn: a human message (`origin.kind: "human"`) or a subagent prompt that carries the main turn's `promptId`.
- The hook's `tool_input` is the `input` stored in the entry, not the model's input: on CLI 2.1.314 the CLI strips a
  `cd <session dir> && ` prefix from a `Bash` command and adds `replace_all: false` to `Edit` before the hook sees it.
  The canonical input hash of hook and entry was equal for `Bash`, `Write`, `Edit`, `Read`, `WebFetch` and MCP; on
  CLI 2.1.322 also for `NotebookEdit`, `WebSearch` and MCP with arguments, with `{}` and with
  `requiresUserInteraction`.
- The `tool_use` entry reaches the file after the hook starts, although its `timestamp` precedes that start. Two
  `Bash` from one message: on CLI 2.1.314 the CLI asks about them one after another and adds both `tool_use` entries
  only after the decision on the first, together with its result. Two `Read` from one message: both requests at once,
  both entries before the results.
- After Esc the turn ends with a `user` entry "[Request interrupted by user for tool use]" and `turn_duration`. A
  background subagent's end arrives as a `user` entry with `origin.kind: "task-notification"` and a new `promptId`.
- A hook killed by SIGKILL before printing anything is an exit without a result: the dialog stands and the desk key
  works.

**When the hook gets a request.**

- Main thread and foreground subagent: the dialog stands in the terminal the whole time the hook waits, and the CLI
  registry says `waiting: permission prompt` (herdr in the main thread: `blocked`); `AskUserQuestion` gives
  `waiting: input needed`.
- Background subagent: while the hook waits there is no dialog on screen (registry `busy`, herdr `working`). The
  dialog appears right after the hook exits without a result, with `waiting: permission prompt` and herdr `blocked`
  (CLI 2.1.312).
- Every request has its own hook process, also in a queue ("1 of 2") and for two identical calls. A decision for a
  request hidden in the queue runs only that one. The hook gets the request when the CLI decides to ask, not when its
  dialog reaches the top: a background subagent dialog queued behind a main thread dialog shows up as "2 of 2" after
  the decision on top, without a second hook call (CLI 2.1.318). A subagent request under an `ask` rule in auto mode
  reaches the hook with `agent_id` and `permission_mode: "auto"` (CLI 2.1.318).
- No `PermissionRequest` for `Skill` (no dialog), for auto mode without a dialog (with an `ask` rule the hook gets the
  request) and for the sandbox network dialog.
- `claude -p` sends `PermissionRequest` like an interactive session and has a CLI registry entry (`busy`, then
  `idle`); in a herdr pane it is a `claude` agent (herdr 0.9.5; CLI 2.1.312 and 2.1.314). It waits for the hook while
  the hook lives. A hook that exits without a result gives a refusal without a dialog: `permissionDecision`
  `config/reject`, a `tool_result` "Claude requested permissions to … but you haven't granted it yet." and exit code 0
  (CLI 2.1.312). Rarog's hook exits at once in a `-p` session ("Permission hook"), so such a request always ends in
  `config/reject` with nothing executed (CLI 2.1.314).

**Subagent requests** (CLI 2.1.319).

- A background subagent's `Agent` result `async_launched` (`toolUseResult.status`, `isAsync: true`, `agentId`) is in
  the main transcript 1.6–2.0 s before the subagent's first `PermissionRequest` hook starts (CLI 2.1.319). The
  subagent's `meta.json` has `toolUseId` equal to the `Agent` call's `tool_use.id` (CLI 2.1.319). The subagent's end
  arrives as a `queue-operation` `enqueue` entry with `<task-notification>` and a `user` entry 1.1–1.4 s after the
  tool result (CLI 2.1.319). The model may pass `run_in_background` as the string `"true"` (CLI 2.1.319).
- While a background subagent's request is hidden, the main thread's dialog shows no "k of N" counter, and
  approving the hidden request leaves the main dialog unchanged (CLI 2.1.319). After the main thread's decision the
  hidden request stays hidden and its hook keeps waiting (CLI 2.1.319). The CLI registry says `busy` for a hidden
  request alone and `waiting: permission prompt` when a main thread dialog stands next to it (CLI 2.1.319).
- After the hook exits without a result, the hidden request's dialog appears within 0.4 s, with the footer "ctrl+x
  ctrl+k twice to stop background agents" (CLI 2.1.319). With a main thread dialog on top, the main dialog becomes
  "1 of 2" and the released request waits as "2 of 2" titled "Bash command · from the general-purpose agent"; the
  first desk key decides the main request (CLI 2.1.319).
- At the desk a hidden request cannot be seen or approved while its hook waits: `/tasks` shows the command under
  "Progress" with no sign that it needs consent, and neither the agent list, the subagent view nor `f` (foreground)
  shows a dialog (CLI 2.1.319). Esc with the focus on the agent list only removes the focus (CLI 2.1.319). Esc in the
  subagent view's prompt rejects the hidden request: the hook gets SIGTERM, nothing runs, and the subagent transcript
  gets a `tool_result` with `is_error: true` ("User rejected tool use") and "[Request interrupted by user for tool
  use]" (CLI 2.1.319). A prompt typed in the subagent view goes to the subagent (CLI 2.1.319).
- A foreground subagent's dialog frame differs from the main thread's frame for the same `Bash` call only by the
  title suffix " · from the general-purpose agent" (CLI 2.1.319). Main thread and foreground subagent requests
  never stand at the same time: the subagent's comes first, the main one after its decision (CLI 2.1.319).
- A late `allow` or `deny` from an orphaned subagent hook after a desk decision changes nothing: no run, no new
  request, no dialog, and the transcript keeps the desk decision (CLI 2.1.319).
- When another `PermissionRequest` hook approves a hidden request, the transcripts show nothing before the tool
  result: the only trace is a `hook_permission_decision` attachment (`decision`, `toolUseID`, `hookEvent`, no hook
  name) in the subagent transcript, written together with the `tool_result` (CLI 2.1.319). The waiting hook is not
  told and keeps waiting (CLI 2.1.319).
- Pressing `ctrl+x ctrl+k` twice while a background subagent's request is hidden stops the subagent: the waiting
  `PermissionRequest` hook gets SIGTERM 1.1–1.3 s after the first chord, nothing runs, no dialog appears and
  `SubagentStop` does not fire (CLI 2.1.319). The subagent transcript gets a `tool_result` with `is_error: true`
  ("User rejected tool use", no `permissionDecision`) and "[Request interrupted by user for tool use]" (CLI
  2.1.319). At the same moment the main transcript gets a `system` entry `agents_killed` without an agent id, a
  `queue-operation` `enqueue` and a `user` entry with `origin.kind: "task-notification"` whose plain text is
  `Background agent "<description>" was stopped by the user.`, with no `<task-id>`; `<description>` is the
  `description` in the subagent's `meta.json`, which gets `stoppedByUser: true` (CLI 2.1.319).
- A new main thread turn does not close a hidden request: `Stop` fires, the model answers, and the hidden request's
  hook keeps waiting with no dialog (CLI 2.1.319). `/exit` with a hidden request does not exit: the CLI asks
  "Background work is running" with "1. Exit and stop tasks", "2. Move to background and exit" and "3. Stay", and
  the hook keeps waiting while the question stands (CLI 2.1.319). "Exit and stop tasks" ends the session: the hook
  gets SIGTERM within 0.1 s, nothing runs and the session leaves the CLI registry (CLI 2.1.319). Neither transcript
  records the end of the request: no `tool_result`, no interruption entry, no notification and no `agents_killed`;
  the main transcript gets only the `/exit` command entries (CLI 2.1.319).
- In auto mode with an `ask` rule, the hook input of a hidden request has `permission_mode: "auto"`, and the request
  waits at least 150 s with no dialog and no auto-deny countdown; an `allow` after that runs the call (CLI 2.1.319).
  In auto mode a background subagent's end reaches the main transcript twice: first a `user` entry with
  `origin.kind: "peer"` and `handback: true` that carries the subagent's report, then the `<task-notification>` with
  `<task-id>` (CLI 2.1.319).
  In `default` mode a hidden request waits at least 10 minutes without a decision, with the CLI registry `busy` and
  herdr `working` the whole time; an `allow` after that runs the call (CLI 2.1.319).
- `SendMessage` to a finished background subagent needs no consent and resumes the same agent (`resumedAgentId`
  equal to its `agentId`, `success: true`) (CLI 2.1.319). The resumed agent's request has the same `agent_id`, is
  hidden like the first one, and has the `prompt_id` of the human prompt before `SendMessage`, not the one of the
  first request (CLI 2.1.319). The first completion notification does not come back after the resume; a new one
  follows the new result (CLI 2.1.319).
- A subagent started by a background subagent writes `subagents/agent-<id>.jsonl` next to its parent's file, and
  its `meta.json` has `spawnDepth: 2`, `parentAgentId` and the parent's `Agent` call id as `toolUseId` (CLI
  2.1.319). The parent's `Agent` call returns `async_launched` even without `run_in_background`, and the nested
  request is hidden, with `agent_id` and `agent_type` in the hook input (CLI 2.1.319).
- A workflow agent's request is not hidden: its dialog stands at the desk while the hook waits, titled `Bash
  command · from the "<workflow>" workflow`, with option 3 "Yes, and switch to auto mode · workflows run best with
  it on", and the CLI registry says `waiting: permission prompt` (CLI 2.1.319). Its transcript is
  `subagents/workflows/wf_<id>/agent-<id>.jsonl`; `meta.json` has `agentType: "workflow-subagent"`, `spawnDepth:
  1`, no parent and no `toolUseId`, and the hook input has `agent_type: "workflow-subagent"` (CLI 2.1.319).
- A hook's `allow` runs a subagent's request without a key also for a nested agent (`spawnDepth` 2, no dialog on
  screen while the hook waits), for a background subagent while a main-thread dialog stands (that dialog stays), and
  for a workflow agent (its dialog with four options closes); the subagent file then has a
  `hook_permission_decision` attachment and the result `permissionDecision` with `source: "hook"` (7 of 7, CLI
  2.1.322).
- A subagent's `meta.json` has `requestShape`: `"background"` with `requestNonInteractive: true` for a background
  subagent and for a subagent nested in it, `"foreground"` with `requestNonInteractive: false` for a foreground
  subagent and for a workflow agent (CLI 2.1.319). When the CLI writes `meta.json` relative to the hook start is
  unmeasured.

**Effect of the decision.**

- `allow`: the tool runs once, with decision source `hook` in the transcript. `allow` with `updatedInput.answers`
  answers `AskUserQuestion`. `allow` with `updatedInput` approves `ExitPlanMode` with a plan (`tool_input`: `plan`,
  `planFilePath`); without a plan (`{}`) a bare `allow` does not close the dialog. MCP with
  `requiresUserInteraction`: no `allow` closes the dialog; after the hook exits, key `1` runs the tool (CLI 2.1.312).
- `allow` with `updatedInput` under an `ask` rule runs nothing: the CLI evaluates `updatedInput` again, also when
  identical, and asks in the terminal with the command from `updatedInput`. A bare `allow` under the same rule runs
  the tool. `updatedInput` with a command a `deny` rule covers is a refusal without a dialog (CLI 2.1.314).
- `ExitPlanMode`: option 1 without a plan ("Yes, and switch to default…") and option 2 with a plan ("Yes, manually
  approve edits") end the plan with `permission_mode: "default"` (CLI 2.1.312). Approval by hook restores the mode
  from before the plan: a session started in plan mode moves to `default`, one that entered with `/plan` from
  `acceptEdits` or `auto` returns there (CLI 2.1.314).
- The hook's `ExitPlanMode` `tool_input` and the transcript's `tool_use.input` can differ: a model that wrote the plan
  file and called the tool with `{}` has `{}` in the transcript, and the hook gets `plan` and `planFilePath` from the
  file (CLI 2.1.314). A call fingerprint from the entry `{}` does not match the dump, so the card of such a call comes
  from the dump when the dialog footer shows its plan file name ("Flow", item 4); without that name the card has no
  buttons.
- The plan dialog footer carries the plan file name, `ctrl+g to edit in Nvim · ~/.claude/plans/<name>.md`, on one
  line (CLI 2.1.278 and 2.1.314) or broken after `·` into two lines in a 63-column pane (CLI 2.1.258 and 2.1.293).
  The layout is the same on all of them: the last option, the hint `shift+tab to approve with this feedback` indented
  deeper than the option digit, an empty line, the footer indented at the level of the `❯` marker.
- A plain deny: the tool does not run, `message` reaches the model as a tool error, and the turn goes on. With a
  message that the user denied from the phone and the model should stop and wait, the model ended the turn in every
  attempt without another tool call (opus, fable and haiku, main thread and foreground subagent; CLI 2.1.314). A deny
  for a subagent ends the subagent, and the main thread ends its turn too.
- A plain deny does not cancel the other calls from THE SAME model message: the CLI runs them one after another, each
  as a new request. The same triple with `prompt_id` lets them be denied without a human (CLI 2.1.314).
- `deny` with `interrupt: true` interrupts the turn in the main thread, and only the subagent in a foreground
  subagent. A late `interrupt` interrupts the turn also after a desk decision: it kills a tool that already runs.
- Decision source in the transcript (`permissionDecision`): `hook/accept` from the hook, `user_temporary/accept` from
  the allow key, no decision and a `null` result with an interrupt after Esc in the main thread, `user_reject/reject`
  after Esc on a foreground subagent dialog (CLI 2.1.312). A `systemMessage` from the decision appears neither on
  screen nor in the transcript; the screen shows "Allowed by PermissionRequest hook".

**Desk decision while the hook waits.** The hook of a dialog decided by key gets no signal and lives on. Its late
`allow` or plain deny changes nothing: not the running tool, not the next request in the queue. The hook has no sure
sign that the dialog was decided: the CLI registry moves to `busy` only without a queue, and the transcript shows the
decision only with the tool result. The same holds for a twin request with identical input from the same turn: only
its own hook's decision runs it (CLI 2.1.314).

**Signals and waiting time.**

- Esc on a main thread dialog: the hook gets SIGTERM within tens of ms, and the turn is interrupted. Esc on a
  foreground subagent dialog is a deny: the hook gets no signal, the subagent ends, the turn goes on.
- `ctrl+x ctrl+k` twice (stop background subagents): a subagent's waiting hook gets SIGTERM, and the tool does not
  run; a waiting main thread hook is not touched (CLI 2.1.312).
- The hook's own `timeout`: SIGTERM at the limit, the dialog stays. The CLI accepts a `timeout` of 86400 s, and an
  `allow` after over 3600 s still worked (CLI 2.1.311 and 2.1.314). A session reads `timeout` from the `--settings`
  file at start (CLI 2.1.314); a change in the user settings file while the session runs is unmeasured.
- `/exit` with a waiting main thread hook: the hook gets SIGTERM before the session entry leaves the CLI registry, so
  no orphan stays (CLI 2.1.312).

**Write to the hook data directory.** In default mode a `Bash` that writes to `answers/` raises a dialog. In
`acceptEdits` mode with `--add-dir` over the data directory, `Write` writes to `answers/` without asking.

**Session with the user settings.** A hook from `--settings` gets requests next to the hooks from
`~/.claude/settings.json`. A session started by a command in a herdr pane shell is detected, and its hook works.

**Several `PermissionRequest` hooks.** The hooks of one request start together and run in parallel. The first
decision settles it, and the others' subsequent decisions change nothing. A hook still waiting then gets no signal
and lives until its own decision or `timeout`; the CLI does not kill it (CLI 2.1.314).

## Tall dialog guard

A `Bash` permission dialog taller than the pane hides its title and the start of the command above the screen edge.
A subagent permission then has no double proof, so its card comes without buttons. The permission hook refuses the
FORM of such a dialog before the dialog appears: it returns `deny` with a message for the model (without
`interrupt`). The model gets it as a tool error and does the same with shorter calls, one after another. The
operation is not blocked, and the hook never allows anything.

Conditions, all at once: the session is not programmatic ("Permission hook"), the event is `PermissionRequest`, the
tool `Bash`, `tool_input.command` is a string, `cwd` is in Rarog's work area, the session runs in a herdr pane
(`HERDR_ENV=1`), and `roots.json` has `tallDialogGuard: true` (the server writes it from `RAROG_TALL_DIALOG_GUARD`, on
by default; `docs/server-config.md`). The guard covers the main thread and subagents.

The estimate (`scripts/hooks/tall-dialog.mjs`, a pure module loaded in `try`) is an UPPER bound of the height: the
command and the description wrap word by word on the frame width, a word longer than the frame is cut hard, and two
rules round up against the CLI layout. A word longer than the frame always starts on a new row, and a character is
never narrower than the CLI draws it (combining characters, ZWJ and variation selectors zero, emoji and characters
from U+2E80 two, a tab eight). The CLI layout is not monotonic in word width, and without these rules the estimate
came out too small. The result is a chrome of 13 rows, a margin of 3, the description rows and the command rows. The
refusal comes when the result exceeds the budget or the description is longer than 8 rows, because the parser looks
for the title at most 12 lines above the frame (`HEADER_MAX_LINES`). The phone constants come from a measurement on
CLI 2.1.302 (a 62×48 pane: frame 58 columns, budget 44; fixtures `dialog-bash-subagent-telefon-2.1.302.txt` and
`dialog-bash-opis-telefon-2.1.302.txt` in `server/test/fixtures/herdr/`). `server/test/dialog-guard.test.ts`
compares the CLI layout with real captures and checks by properties that the estimate never falls below it.

**Pane geometry.** The budget and the frame come from the pane the session runs in. The hook takes `COLUMNS` and
`LINES` from its environment: CLI 2.1.309 sets them to the current pty size at call time. No process spawn, no herdr
socket. The rule (`dialogBudget`):

- **`pane`**: frame `min(62, columns) − 4`, budget `min(44, rows − 4)`. A pane never loosens the guard against the
  phone, and above the threshold a lower pane never gets a larger budget than a taller one (property test). Examples:
  62×29 → budget 25, frame 58; 128×52 → 44, 58; 40×32 → 28, 36.
- **`phone`**: the variables are missing or not integers 1..1000: the phone constants.
- **`floor`**: a budget below 18 rows (the smallest call that triggers the refusal message; a pane lower than 22
  rows) or a pane narrower than 20 columns. Also the phone constants: the dialog does not fit anyway, and refusing
  every `Bash` with a description would give the model no feasible advice.

The refusal message and its length hint (lines = budget − 17, characters = frame) come from the same numbers as the
decision. With `pane` the message names the session's terminal pane and its size; with `phone` and `floor` it speaks
of the phone screen.

A refusal writes no dump to `pending/` (the dialog will not appear) and leaves an existing one untouched. It
refreshes `hook-seen.json` and appends a line to `<dataDir>/guard.jsonl` (`0600`): time, session, subagent yes or no,
estimate, budget, `budgetSource` and, with valid variables, `paneRows` and `paneCols`, without the command. The server
moves a file over 1 MB to `.1` at start (`rotateGuardLog`). A request the guard evaluated and LET THROUGH carries the
same three fields in its `pending/` dump, and a card without a decision logs them ("Case shape in the log"). A failure
to load the module or compute the estimate, a result of a foreign shape and a wrong field type give the behavior
without the guard. Switch: `RAROG_TALL_DIALOG_GUARD=0` and a restart. Sessions call the hook copy in
`~/.claude/hooks/rarog/`, so a rule change takes effect at `hooks:install`, and a change of the server's dump reader
at a restart.

The model splits the work only when its instructions allow it. An instruction that forbids working around a hook
block makes the model end the turn with a request to the human instead, unless it has an exception for this refusal.

Guarantee limits (the estimate can be too small, and the card then falls back to the state without the guard):

- **Chrome in a pane narrower than 62 columns.** The command and description wrap on the pane's frame, but the chrome
  and the header limit are measured at 62 columns; the 4-row margin takes part of the difference.
- **Geometry other than at hook time.** A pane shrunk after `PermissionRequest` (a herdr client, Rarog's terminal with
  the keyboard) hides the header of a dialog already standing. Trace in the log: the dump's `hookPaneRows` next to
  `paneRows` from herdr at `degrade`.
- **No geometry, or a pane under the threshold** (`budgetSource: phone|floor`): a lower pane gets a dialog taller than
  itself.
- **A long `ask` rule in the footer.** The hook does not know the rule text, and the chrome counts two rows for it.
- **A queue of permissions from independent subagents** ("1 of 2"): the screen shows the first, the dump describes
  the second. The message only asks to split one agent's calls.
- **CLI warnings longer than the 3-row margin** (such as the three-row `cd` warning with "Yes, allow reading from…").
- **A pane shrunk by Rarog's terminal** returns to the tab layout size only on release after the grace period
  (`docs/architecture.md`, "Pane size after release"). The CLI redraws a dialog that appears in that time after the
  resize, so the header comes back on screen.

## Prompt blocked by a hook

A `UserPromptSubmit` hook (for example a policy check in a plugin) can stop a prompt before it reaches the
model. Rarog recognizes the block entry and shows a notice under the prompt bubble; a prompt sent during a turn
leaves no entry, and Rarog recognizes it by the prompt field after the turn ("What Rarog does"). The app draws the
notice with the button "Restart and Send" (`transcript.promptBlockedResend`). CLI behavior below is measured on
CLI 2.1.303 with a measurement hook and on a real entry from CLI 2.1.302.

**Transcript entry.** A blocked prompt gets NO `user` entry. The CLI (2.1.303) adds one `system` entry with
`subtype: informational`, `level: warning`, `preventContinuation: true` and the field `promptSubmitEnding`
(`ending.kind`, `ending.reason`, `promptKept`). The literals live in `TRANSCRIPT_ENTRY`
(`server/src/herdr/commands/registry.ts`).

- `kind: blocked_by_hook`: the hook exited with code 2 or answered `{"decision":"block"}`, `promptKept: false`.
  `content` starts with `UserPromptSubmit operation blocked by hook:` and a newline. With code 2 the label
  `[<hook command>]: ` and the stderr follow, for a plugin hook also `This hook comes from the <plugin> plugin.`. It
  ends with `Original prompt: <prompt>` after an empty line. `reason` is the stderr without the final newline, or
  `reason` from the JSON.
- `kind: stopped_by_hook`: the hook answered `{"continue":false}`. The prompt stands in an ordinary `user` entry,
  followed by an `isMeta` entry `Operation stopped by hook: <reason>` and a `system` entry with `promptKept: true`.
- Hook input: `session_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `prompt_id`, `permission_mode`,
  `hook_event_name`, `prompt`.

**Quote fidelity.** The quote after `Original prompt: ` equals the sent text literally only for short prompts. A
longer or multi-line pasted prompt comes wrapped in a paste envelope (`<pasted_content id="…">` … `</pasted_content
id="…">`), with every tab turned into four spaces (CLI 2.1.304). An image path (`appendAttachmentPaths`) becomes
`[Image #N]` at the START of the prompt. The hook gets the same rewritten text in `prompt`. After the normalization
the import applies to a `user` entry and after `echoKey` (every run of spaces and tabs is one space), the quote
matched the sent text in every measured variant. Rarog strips trailing whitespace and backslashes before sending
(`assertSendable`).

**Prompt sent during a turn.** The hook runs AT ONCE on send, not when the prompt leaves the queue. The blocked
prompt leaves NO entry in the file (no `queue-operation`, no block entry, no `user` entry). The text returns to the
prompt field and stays there after the turn ends, and the running turn goes on unchanged.

**herdr and ordering.** The block entry reaches the file a few hundred ms after `agent.prompt`. `agent.prompt` with
the wait for `working` (3000 ms, as in `client.ts`) mostly ends in `timeout`: the pane stays `idle`, or herdr shows
`working` right after the entry and `done` shortly after. After the block the CLI leaves the prompt in the field: the
text literally or `[Pasted text #N +K lines]`.

**Slash command.** A skill typed as a prompt passes the hook with the raw command text: the entry is
`blocked_by_hook` with that text in the quote, and the prompt field stays empty. A local command (`/context`) does not
reach the hook. A hook given with `claude --settings <file>` runs too.

**What Rarog does.**

- **Recognition.** An entry with `ending.kind: blocked_by_hook` (by structure, not by the hook's message) gives the
  part `prompt-blocked` (`herdr/commands/transcript.ts`): the reason from `ending.reason` without terminal sequences,
  and the quote after the first `Original prompt: ` past the end of the reason, through `humanTextOf`.
  `stopped_by_hook` and unmeasured kinds are skipped.
- **Follower.** The entry goes BEFORE the command path, in the tail and in the history. The quote clears the echo of a
  send from Rarog (`#takeEcho`: the file entry no older than the registration minus 2 s), and a hit uses up the
  window entry. Live it is always a `prompt-blocked` event; from the history only on an echo hit, otherwise a notice
  with the quote at its position. There is never a `user` bubble with the quote, nor a `turn-input`.
- **Driver.** The send number rides in the echo window entry (`dropEcho`) and comes back from the hit, so the block
  points at the send it blocked, also when an identical text ("yes") got through before. Only the last EXECUTED send
  matters. The stall guard checks for a block after every `await`: no Esc pair, no second `prompt`, no "prompt
  stuck". `#needsEscape` stays, because the CLI put the prompt back into the field: the next send from Rarog reads the
  field and sends the Esc pair only on a confirmed `filled`. `blockedLeftover` (`drivers/herdr/turn-guard.ts`, the
  permission to clear the field before a restart) goes out on the next send, Esc, a new conversation, a `user`
  entry, a turn start from the file and a block of a prompt from outside Rarog, NOT on `working`. A block of an older
  send, when a newer one already entered the pane, gives the notice alone (`decided: false`), and so does a block
  entry of the conversation the pane has left that reaches the driver after the move: a new conversation has no
  executed send yet, so the entry sets neither `#needsEscape` nor `blockedLeftover`.
- **Manager.** A `system` notice, the sentence `commands.prompt-blocked` (`server/src/herdr/commands/transcript.ts`):
  the title, the reason (variant `.reason`), and for a prompt from outside Rarog also `Prompt: <quote>` (`.prompt`,
  `.reason-and-prompt`); the field `promptBlocked` for the app
  (`docs/implementation-spec.md`, reason and quote cut to 8 kB). Only a block of the sends that opened this turn takes
  the session out of "working" (`turnOpenedBySend`, echo keys of sends the CLI has not taken yet, at most 60 s). When
  the block removes the last key, a session in `starting`/`running` moves to `waiting-input`; when herdr `idle` came
  first, the manager retracts the turn end in the schedule (`retractTurnEnd`). For 6 s a late `working` from herdr
  does not open a turn. There is no push about a block. `server.log`:
  `rarog: prompt blocked by a hook (session <id>, from Rarog: yes|no)`.
- **Restart with resend.** A decided block of a send from Rarog puts `promptBlocked: {seq, id}` on the card, with the
  button "Restart and Send" under that notice. `POST …/restart` with `{resend: {seq, id}}` restarts THIS session
  (`/exit`, `--resume`, also without a newer release) and sends the prompt to the new process once, by the start
  prompt path; the server takes the text from the send ring. A driver task clears the field holding OUR prompt before
  `/exit` (the Esc pair only on `filled`). When the hook blocks the prompt in the new process too, a new notice with a
  new button comes: there is no loop without a tap. Gates and refusals: `docs/security-model.md`, "Session restart adds
  no power"; the app side: `native/Rarog/docs/rarog-ui.md`.
- **Prompt sent during a turn.** There is no block entry, so the held echo gets nothing from the file. Before the
  timer flushes it 10 s after the turn ends, the driver reads the prompt field in the send queue (`checkHeldLeftover`,
  zero keys): the text of the field area between the frame lines (`composerRegionText`), because the history above
  also shows sent prompts. A message is "in the field" only when the field text, with whitespace collapsed, EQUALS its
  text or the concatenation of consecutive messages; containment is not enough (a short "ok" sits inside a longer
  draft). Result per message:
  - field equal to the message (`not-taken`): the bubble and the notice `heldNotTakenText`
    (`server/src/sessions/manager.ts`). The driver remembers the field text (`heldLeftover`); the next send from Rarog
    clears the field with the Esc pair only when it STILL holds exactly that text. The message token leaves the echo
    window, so the same prompt sent at the desk afterwards stands as an ordinary message;
  - field full but not equal (`unconfirmed`: a draft at the desk, our text with an addition, a pasted text marker):
    the bubble and the notice `heldUnconfirmedText`. Rarog does not touch the field;
  - field empty or unreadable: the bubble alone. A message whose pasted text the driver never saw in the field and
    did not paste again (`unseen`, "Sending while a turn runs") gets the bubble and the notice `heldUnseenText`,
    because nothing confirms that it went.

  This case gets no resend button: the CLI saved no reason anywhere. A return into a turn, another driver, a restart
  reservation and a newer read (`heldCheckOp`) cancel a read from the timer. `server.log`: `queue: <session> flushed
  <n>: turn ended without taking the prompt (field: <verdicts>)` or `… send from Rarog after the turn`.
- **Switch** `RAROG_PROMPT_BLOCK=0` (`docs/server-config.md`): the behavior without recognition as a whole, together
  with the button, the field clearing and the field read after the turn.

## Sending while a turn runs

A message from the app to a Claude pane while a turn runs (herdr `working` or `blocked`), or while an older such
message still waits, goes in two steps: a paste of the text alone, then a separate `enter`. A pane of another engine,
a send outside a turn and a slash command keep `agent.prompt` with the refusal gates.

**A turn the driver does not see yet.** The driver sees a turn started at the desk as `working` 1.6–2.0 s after the
CLI registry turns `busy` (measured on CLI 2.1.322; the supervisor also holds a quiet → `working` change for
`HERDR_WORKING_GRACE_MS`), and `agent.prompt` in that window can press its Enter into a dialog requested meanwhile
(below). So a message without a slash command to a Claude pane herdr reports idle asks a fresh registry read first
(`PromptQueue.registryInTurn`, the same `consentRegistryRead` port as step 1): `busy` or `waiting` sends it down this
path, where a standing dialog holds it until it closes instead of refusing it. Any other status, `unknown`, a read
error or no port keeps `agent.prompt`. The `202` and the notes are the same as for a message during a turn.

**Why not `agent.prompt`.** herdr pastes the text and presses Enter after a fixed 300 ms, and checks the pane block
once, at the start. A permission dialog or a question form that stands up in that window gets the Enter: it approves
the highlighted option or sends the form with the message text, and the message is lost (2 of 20 attempts, measured
on CLI 2.1.322 with herdr 0.9.5).

**Measured facts the path rests on (CLI 2.1.322, herdr 0.9.5, 53 attempts with a dialog −200…+400 ms around the send:
0 approvals, 0 lost messages).**

- The CLI session registry (`~/.claude/sessions/<pid>.json`) shows `waiting` 6–7 ms (p50) after the CLI requests a
  dialog, at most 38 ms on the main thread and 115 ms for a background subagent. The consent hook shows the request
  after about 32 ms (p50). herdr `blocked` comes 0.3–0.46 s late (p50), up to 3 s, and stays after the dialog closes.
- A dialog requested after the CLI took keyboard input (a paste, an Enter) is drawn at least 441 ms after the last
  input. An Enter that arrives before that lands in the prompt field.
- Text pasted into a standing permission dialog is ignored and lost; the field after the dialog is as before the
  paste. Text pasted into a standing question form lands in its "Type something" field.
- Text that already stood in the field when a dialog stood up stays there through the dialog and after it; an Enter
  after the dialog sends it without a new paste.

**The path** (`drainPrompts` and `#pasteAttempt` in `drivers/herdr/prompt-queue.ts`, rules in
`drivers/herdr/prompt-paste.ts`, the checks of step 1 in `drivers/herdr/prompt-gates.ts`):

1. Nothing stands: herdr not `blocked` in the driver's view, no CLI consent dialog herdr does not see and no
   form fallback held by the driver, no consent hook request of this session (a channel card holds the dialog,
   or a hook registration has no card yet, within the card wait), a FRESH registry read without `waiting`
   (`consentRegistryRead`; without the port, the last registry signal from the manager), and the prompt field
   visible on the screen (`composerRegionText` on the read with attributes; a dialog or a form hides it).
2. A fresh `agent.get` shows the Claude session the message was accepted for at the pane address and not `blocked`
   (another session ends the message without a key, as described below at the server restart); a fresh field read shows
   the same field as before (another field sends the message to the next attempt); herdr, the hook request and a
   fresh registry read pass once more, and the text gate passes again (below). Then the text alone goes by
   `pane.send_input` (`HerdrClient.pasteText`, body `pane_id` and `text`, no `keys`).
3. The text stands in the field: the field differs from the one before the paste and is not empty (reads every
   40 ms, at most 4 s). After a paste into an empty field, a field that is, starts with or ends with Rarog's own
   leftover (`heldLeftover`) and is not the message text alone ends the message with no Enter, no clearing and no
   new paste (`gluedFieldVerdict`): the hook returned a previous message while this one went in, or a draft at the
   desk starts or ends with that text. The leftover alone is `unseen` (the pasted text is not in the field and may
   have gone with an Enter at the desk); the leftover together with anything else (the pasted text, a paste marker,
   a draft) is `changed`. Both end as in the list below, "When something stood up after the paste".
4. The second check: herdr, the hook request and a fresh registry read again. When more than 300 ms passed since the
   paste, the driver also reads the field (it must still hold exactly the pasted text) and the registry once more,
   and writes `send: Enter <ms> ms after paste in pane <pane>, checked again: <result>` to `server.log`.
5. The text gate again, then `enter` by `HerdrClient.sendPromptSubmit` (`dialogs/send/prompt-submit.ts`: exactly
   `['enter']`, its own assertion, outside `ALLOWED_KEYS`). The message leaves the queue before the Enter.
   Bookkeeping as after `agent.prompt` (turn watchdog, the send number).

**herdr `blocked` after the dialog closed.** herdr's own status (`agent.get`) leaves `blocked` up to 0.35 s after a
consent dialog closes, and the driver's status, which follows herdr's events, stayed `blocked` through the whole gap
before the next dialog of the same turn in 14 of 30 attempts (two `Bash` dialogs about 0.85 s apart, CLI 2.1.322,
herdr 0.9.5). The registry fallback hold lags the same way: it follows the manager's last registry signal. A
message that waited for the end of those holds went as a new turn. So when the only holds in steps 1 and 4 are these
two lagging signals (no CLI consent dialog herdr does not see, no form fallback, no hook request), the queue reads
again (`drivers/herdr/stale-block.ts`): a fresh registry signal without `waiting` (`active`), then the prompt field
visible on a fresh screen read, end those holds for this check. The end covers only the hold those reads judged:
the driver numbers each start of these holds (herdr status into `blocked`, the registry fallback hold set), so a hold
that starts after the reads began holds the message, also when the next registry read still returns `active`.
`waiting`, `unknown` or a registry read error keep them; a covered field or a failed screen read keep them too, and
then the next attempt comes after 100 ms instead of 300 ms (`PROMPT_STALE_RETRY_MS`), because the dialog is closed
and only the signals lag. The other checks stay as they are: the hook request, the fresh registry read, the
`agent.get` before the paste (it must not say `blocked`), the field reads and the second check before the Enter,
which makes the same judgement again, so a dialog that covers the field or a registry `waiting` between the paste
and the Enter still stops the Enter. The Esc pair that clears a leftover still waits for the end of both holds.

**The text gate before every key.** A message waits in the queue as long as a dialog stands, and the pane's mode can
change meanwhile. Before every key of a queued message (an Esc pair that clears the field, the paste, the Enter) the
driver runs the send gate (`assertSendable`) again with the CURRENT mode, on the text after the first gate and with
the command catalog from when the message was accepted. A refusal (`bypass` outside `RAROG_YOLO_ROOTS`) ends the
message: no key, the echo is returned, and the transcript gets the reason (`commands.send-refused`). `server.log`:
`send: send guard refused the message for pane <pane> before paste|Enter`. A text refused before the Enter stays in
the field and counts as Rarog's leftover (below).

**After an Enter from the queue.** A `UserPromptSubmit` hook runs on the Enter, and the CLI puts a prompt it blocked
back into the field without a file entry ("Prompt blocked by a hook", CLI 2.1.303). Before the first paste of the
next message, after step 1, the driver waits until the previous Enter is settled: a prompt entry from the file with that message's
echo token or text (the CLI took it), the field holding exactly the text sent with that Enter (the hook returned it,
and the leftover clearing below removes it), or 1.5 s after the Enter (`PROMPT_SUBMIT_SETTLE_MS` in
`prompt-paste.ts`, with the reasoning behind the number). Meanwhile the message is tried again every 300 ms;
`server.log`: `send: message for pane <pane> waits (submit)`. Only a message that follows a queue Enter within 1.5 s
waits, and in that time a plain message to a pane outside a turn takes this path too. A text the hook returns after
that wait is caught by the field check after the paste (step 3).

**Leftover in the field.** Before the FIRST paste of a message (never when its own text waits in the field for the
Enter), after step 1 and the wait above, the driver clears text that Rarog left in the field: any text when
`#needsEscape` is set (a hook block of a send outside a turn, an interrupt, a stall), or a field that equals exactly
the text the queue left there after an Enter, a gate refusal or a failed Enter (`heldLeftover`). A
`UserPromptSubmit` hook that blocks a prompt during a turn leaves no entry in the file, and the CLI puts the text back
into the field ("Prompt blocked by a hook"), so without this the next message would join that text in the field. The
Esc pair goes only on a field visible between its frame lines (a dialog or a form hides it, and the message waits),
after herdr, the hook request and a fresh registry read pass again, after a fresh field read that still shows the
same text owned by Rarog, and after the text gate; at most 3 pairs, each followed by a fresh field read. The fresh
read matters because the Esc pair on an empty field opens the rewind menu: a field that emptied meanwhile goes
on to the paste without keys, other text sends the message to the next attempt, and a marker that went out meanwhile
leaves the field as a draft. A field with other text (a draft at the desk) gets no keys. An empty field ends
`#needsEscape`; `heldLeftover` ends when Rarog's own pair empties the field, a `user` entry with the same text
arrives, a field with other text gets the paste, or a new conversation starts in the pane, but not on an empty field
alone, because the hook can return the text after the first read. A new conversation in the pane (`/clear`,
`/resume`) ends `#needsEscape` too: text in its field is not known to be Rarog's, so on every path it is a draft at
the desk and gets no keys. This queue and a send outside a turn send the message after it, and its Enter sends the
draft too; a control command refuses (`model.change-unsent-prompt.mac` or `.vps`), also when the conversation changes
during the field read of a clearing it has begun: the flag is read again after every field read, before each Esc pair.

**When something stands.** The message waits in the driver queue without a refusal sentence and is tried again every
300 ms; newer messages stand behind it, and a slash command behind it is refused (`commands.send-held.cli-dialog`),
because its text would join the waiting one in the field. The queue runs outside the driver's step chain, so a card
answer for the dialog does not wait behind the message. `server.log`: `send: message for pane <pane> waits (<signal>)`
once per message.

**When something stood up after the paste.** No Enter. The message stays at the head of the queue and its text stays
in the field (clearing it would need `escape`, which is a deny over a dialog). `server.log`: `send: <signal> after
paste in pane <pane>, no Enter; message stays at the head of the queue`. The next attempt compares the field with the
paste trace (`pastedFieldVerdict`):

- the field holds exactly the pasted text: Enter without a new paste;
- the field is as before the paste and the text provably did not go: the first successful read after the paste,
  done within 300 ms of the paste start, showed a dialog or a form instead of the field (a dialog requested after an
  input is drawn no sooner than 441 ms after it, so this one stood before the paste and the text went into it and was
  lost),
  or the field still holds the non-empty text from before the paste (an Enter would have taken it): paste again, at
  most 3 times per message, then the message is not sent, the echo is returned and the transcript gets
  `commands.send-stalled`;
- the field is empty, as before the paste, the driver never saw the text in it and has no such proof: the text may
  have gone with an Enter at the desk before the first read, so no paste and no Enter, and the echo stays in the
  window. `server.log`: `send: pasted text never showed in the prompt field of pane <pane>; it may have gone with an
  Enter at the desk, not pasted again`;
- the field is empty after it held the text (sent or cleared at the desk): no paste, no Enter, and the echo stays in
  the window; the message may have gone or not, so it gets the same notice after the turn as a text never seen;
- the field turned into other non-empty text, and the driver never saw the paste in it (a herdr stall): the text
  counts as the paste and gets the Enter without a new paste, unless step 3 finds Rarog's own leftover in it;
- the field holds other text (a draft at the desk, a field glued with Rarog's own leftover in step 3), or it changed
  after a paste that provably did not go: no paste, no Enter, no other key, the echo is returned and the transcript
  gets `commands.send-stalled`. `server.log`: `send: prompt field in pane <pane> changed after paste, no Enter`.

**Rules for a field Rarog cannot prove its own.** Data safety goes before convenience:

1. Keys that clear the field go only on text that is exactly Rarog's own: the whole field equals the text Rarog left
   there, never a field that only starts or ends with it. A field glued with that text stays as it is.
2. A message is pasted again only with proof that the last paste did not go: the first read after the paste showed a
   dialog or a form within 300 ms of the paste start (`lost`), or the field still holds the non-empty text from
   before the paste.
3. Every other unclear field ends the message with no Enter. When the message may have gone (`unseen`, or `taken`:
   the field emptied at the desk before Rarog's Enter), the echo stays, and the bubble after the turn gets the notice
   that nothing confirmed the send (`session.prompt-unseen`).
   When it did not go (`changed`), the echo is returned with `commands.send-stalled`.

The first rule has one exception: `#needsEscape` (a hook block of a send outside a turn, an interrupt, a stall)
clears any text in the field of the conversation it was set in before the first paste ("Leftover in the field",
"Residual risk").

**Held echo.** The echo token belongs to the queue entry: the driver registers it in the follower's echo
window once, before the first paste, and returns it on every path that ends without an Enter, except when the text
went or may have gone at the desk (the file entry below, an empty field after it held the text, a text never seen, a
field that holds Rarog's leftover alone). A prompt entry with the message's token that arrives from the file while
the message still waits in the queue (an Enter at the desk) ends the entry without an Enter and without a new paste
(`send: message for pane <pane> arrived in the transcript, no Enter from Rarog`); the entry after Rarog's own Enter
does not count, because the message left the queue before it. A message pasted onto other text in the field (a draft
at the desk, which the queue leaves as it is) gets a second expected text: the field right after the paste, when that
field is the text from before the paste followed by the pasted text (`#joinDraftEcho`, follower `joinEcho`, compared
without whitespace, as the field read sees it). A `user` entry equal to it ends the echo the same way as an entry
with the message's own text, but never a hook-blocked prompt: there the second text would make the whole field
Rarog's and the next send would clear the desk draft. An entry that only contains, starts or ends with either text
does not end the echo, and an entry equal to one message's own text goes to that message before another message's
second text. A field joined any other
way (a long paste folded into a marker, a cursor moved at the desk) adds no second text. The bubble in the app keeps
the message's own text. The field read after a turn (`checkHeldLeftover`)
answers `unknown` for a message that still waits in the queue, so its text in the field is neither a "not taken"
prompt nor cleared by the Esc pair. The driver remembers the token of a message that ended `unseen` or `taken`: when
no entry with it comes from the file, the field read after the turn answers `unseen` for an empty or unreadable
field, and the manager puts the notice `heldUnseenText` (`session.prompt-unseen`) under the bubble. Rarog does not
paste that message again. The token goes with that read, with a file entry that carries it, and when its entry falls
out of the echo window (`echo-dropped`: the manager flushes the message at once, without a field read). With
`RAROG_PROMPT_BLOCK=0` or outside the roots the driver reads no field after the turn and keeps no token.

**The queue survives a server restart.** The copy on disk is `<dataDir>/prompt-queue.json`
(`server/src/drivers/herdr/prompt-queue-store.ts`). A message is written when the driver's task parks it in this
queue; a message that takes `agent.prompt` leaves nothing on disk. The manager answers `202` only after that task has
chosen the path and, for a parked message, after the write (`SessionDriver.queueSaved`). A failed write keeps the
`202` and logs `prompt-queue: write failed`; the message then waits in RAM only. An entry carries the engine session
id, not the pane key, because a pane address is positional: after a restart only a driver of the same engine session,
in scope and running Claude, takes the entries, so a moved pane keeps its messages and an agent in an old address
gets none. A pane out of scope or of another engine drops them with `send: <n> restored message(s) for pane <key> not
sent: out of scope` (or `not a Claude pane`), without a screen read or a key. A session that no pane runs 30 s after
the first full resync loses them with `prompt-queue: <n> message(s) for session <id> not sent: no pane runs it after
the restart`. A start with the voice agent or its mode across sessions off drops every queued message of the voice
agent (an entry with `source`) at load, with `prompt-queue: <n> voice agent message(s) not sent: the voice agent's
sends are off` (`docs/companion.md`, "Sending from the conversation"). Every message keeps the engine session of the
moment `send()` accepted it, taken before the driver's chain and the attachment write; a restored entry keeps the
session of its file entry. The `agent.prompt` path checks it before the clearing of a leftover, after every field
read inside it (right before each Esc pair) and right before `prompt`, and again after every field read of the stall
retry's clearing and before its second `prompt`; a clearing stopped by it sends no further key. The paste queue
checks it when the message parks (before the disk write), at the start of each attempt and right before each key
(the Esc pair, the paste, the Enter), and `agent.get` compares herdr's session with the message's own. When the pane
runs another one (`/clear`, `/resume`), the message ends without a key and without a file entry:
`send: message for pane <key> not sent: the pane runs another engine session` in the log, its echo back and
`commands.send-session-changed` in the transcript. Text pasted before the switch stays in the field of the new
conversation without an Enter.

Before the first paste the entry loses its text (state `pasted`), and only after that write succeeds do the fresh
checks run (the engine session in the pane, the field, the registry, the hook request) and the paste go. A failed
write means no paste now: the message stays at the head and the next attempt writes again. A check that stops the
attempt before the paste gives the entry its text back (`queued`). A restart after the write and before the paste
gives the note below instead of the message. The entry leaves the file when its outcome is known: an Enter settled (a
file entry, the text back in the field, or the 1.5 s ceiling counted from the end of the key call; while the call
runs the Enter is unsettled), a refusal, a file entry before Rarog's Enter, or the field read after the turn for a
message that ended `unseen` or `taken`. Restored queued messages park in their order and go the usual way (check,
paste, check, Enter) without an echo token: the held echoes went with the old process, so the prompt entry from the
transcript file shows the message. A voice agent message keeps its sender in the entry (`source`), so its restored
paste carries `sender` in the audit log. A `pasted` entry is never pasted again: after the history import (or when
there is no transcript file, or when the follower reports that the history cannot be read) the transcript gets
`session.prompt-unseen` with "…" as the quote, so a full history does not push the note out. The follower reports the
read error only once it expects a transcript (after a send from Rarog or a turn start the driver sees), so a pane
closed before that takes the mark out of the file without the note. A note sent after a read error can still be
pushed out when a full history imports after it. A queued entry older than 6 h is not restored.
A retry with the same `clientMessageId` after the restart gets `replayed` from the send registry and adds nothing.
A pane closed while the server runs takes its entries out of the file; at shutdown the file is left as it is.
A corrupt file or one in an unknown format is moved to `prompt-queue.json.bad` with one log line, and the queue
starts empty.

**Residual risk (measured on CLI 2.1.322, herdr 0.9.5).** An Enter that herdr delays by more than about 440 ms after
the paste is no longer protected by the CLI's deferral: a dialog requested in the gap between the last check and the
Enter is drawn within about 40 ms and takes the Enter. Measured: the Enter call took up to 438 ms, and paste end →
Enter end exceeded 441 ms in 3 of 46 Enters (herdr stalls). The second check after 300 ms narrows the gap to the
duration of the Enter call itself. A message to an idle pane (outside a turn) keeps `agent.prompt`, so a dialog of a
background subagent that stands up within its 300 ms is not covered by this path. Without the proof of loss (the
first read after the paste finished more than 300 ms after its start, or herdr dropped the text without an error)
an empty field ends the message without a second paste; when no entry comes from the file, the bubble after the turn
carries the notice that nothing confirmed the send (with `RAROG_PROMPT_BLOCK=0` or outside the roots, the bubble
alone).

How long a hook takes to return a blocked text to the field during a turn is not measured. A text returned after the
1.5 s wait that lands between the field check after the paste and the Enter goes out together with the next message.
A text returned after the NEXT message's Enter is no longer recognized as Rarog's (`heldLeftover` holds the newer
text), so the message that follows is pasted after it; the same holds for a long message that comes back as a paste
marker other than the one seen before its Enter. A field glued with Rarog's own leftover stays as it is after
`changed`: the next message from the app is pasted after it, as after a draft at the desk, and its Enter sends the
glued text too. A message the hook returned and the next message's Esc pair cleared gets no notice after the turn:
the field read finds the field empty. A slash command does not wait for the previous Enter to settle.

The field check after the paste counts any field that differs from the one before the paste and is not empty as the
paste, because the CLI folds a long paste into a marker without its text (`[Pasted text #N +K lines]`, CLI 2.1.303):
text typed at the desk at the moment of the paste goes out with the message's Enter. `#needsEscape` clears any text in
the field before the first paste, so text typed at the desk after a hook block of a send outside a turn, an interrupt
or a stall is cleared as well.

## Taking the queue back

Claude Code takes queued prompts back into its prompt field with Up on an empty field, and the turn runs on ("Take
back what you queued", per the documentation `code.claude.com/docs/en/interactive-mode`). Rarog mirrors this for the
app: `POST /api/sessions/:id/queue/take-back` (`docs/implementation-spec.md`, "Queue take-back") takes every prompt
waiting in the CLI queue and in Rarog's paste queue out of both and returns their texts, so none of them reaches the
agent until a person sends it again. The response lists the CLI queue first, then Rarog's queue, each in queue order,
one item per prompt. Only a Claude pane in scope with a transcript file has the take-back. The app calls it on Up in an
empty message field while a queued message stands, on a tap on a queued message and on its VoiceOver action, and puts
the texts one per line before the field's draft; Esc still interrupts the turn. A take-back without a definitive
answer keeps its `operationId` in the app until the texts are in the app's stored draft: Up and a tap on a Not
confirmed message replay it, and the server answers the same id with the same texts.

**Measured facts (CLI 2.1.328, herdr 0.9.5, fixtures `server/test/fixtures/herdr/queue/measured/zabranie*`, panes
of 26 and 113 columns).**

- `up` on an empty field takes every prompt of the CLI queue into the field, one per line, and the transcript file
  gets one `queue-operation` `popAll` entry per prompt; the turn runs on (`zabranie`, `zabranie-szeroki`, CLI 2.1.328).
- `ctrl+u` deletes one screen line of the field without interrupting the turn, 29 presses for three long prompts at
  26 columns; a cleared field never sends the prompts, and clearing writes nothing to the file (CLI 2.1.328).
- `popAll` leaves a background task notification in the CLI queue, and the CLI absorbs it after that
  (`zabranie-meldunek`, CLI 2.1.328).
- `up` on an empty CLI queue opens a history entry: the field's top frame reads `─── History N/M ───`, with three
  dashes for a short entry, and `down` brings the field back (`zabranie-historia*`, CLI 2.1.328).
- When the CLI takes the queue in the same instant (a tool result about 33 ms before `up`, a turn end about 100 ms
  before), `up` shows a history entry equal to the prompt the CLI has just delivered, and the file has no `popAll`;
  never both (`zabranie-wyscig-wynik`, `zabranie-wyscig-koniec`, CLI 2.1.328). Only the file proves a take-back.
- A field taller than the screen has the top frame `─── ↑ N more ───` and shows only its bottom (`zabranie-dlugie`,
  CLI 2.1.328).
- A paste of K + 1 lines stands in the field as `[Pasted text #N +K lines]`, and its `popAll` text is the paste
  wrapped in `<pasted_content id="…">` (`zabranie-wklejka`, `zabranie-wklejka-szeroki`, CLI 2.1.328).
- In a standing permission dialog or `AskUserQuestion` form `up` and `down` move the highlight and `ctrl+u` does
  nothing (`zabranie-dialog`, `zabranie-formularz`, CLI 2.1.328). The three keys have their own send path outside
  `ALLOWED_KEYS`: `docs/security-model.md`, "herdr sessions: Rarog writes to a terminal it does not own".

**The step** (`QueueTakeBack.run` in `drivers/herdr/queue-take-back.ts`) is one step of the driver's chain, never run
alongside a paste or a card answer. Every key goes after fresh gates and a fresh screen read, and any doubt ends with
no further key:

1. The last Enter from Rarog's queue settles first (`submitUnsettled`, as in "After an Enter from the queue" above).
2. The gates of a paste (step 1 of "The path" above), then a screen read: a dialog, a form, or a field the screen does
   not show refuses with `dialog`.
3. The field is empty, or holds exactly the head of Rarog's queue, pasted into an empty field and waiting for its
   Enter. Any other field (a draft at the desk, a field cut at the top, a history entry) refuses with `draft`.
4. The CLI queue, counted twice: from the file (`herdr/jsonl-queue.ts`: `queue-operation` entries in order, where
   task notifications and empty `enqueue` entries hold a place but never count; a missed part of the file or a
   contradiction makes the queue `unknown` until the next turn end of the main thread) and from the screen
   (`composerQueueShown`: the dimmed hint `Press up to edit queued…` in the field, or the `ctrl+enter to send now`
   line under the queued prompts, CLI 2.1.328). A queue the file does not know, or file and
   screen that disagree, refuse with `unknown`; an image marker `[Image #N]` in the queue, or more prompts than the
   follower keeps `popAll` texts for (64, `CLI_QUEUE_POPS_KEPT`), refuse with `queue`.
5. Rarog's queue leaves first: every message not confirmed in the transcript, the head waiting for its Enter included,
   with the write of `prompt-queue.json` awaited (`PromptQueue.takeBack`). A failed write puts them back at the head
   in their order and refuses with `disk`, before any key. A head pasted into the field is cleared from it next.
6. With CLI prompts queued: fresh gates, a fresh field (empty, no history entry), the queue counted again, then `up`.
   Each 40 ms poll forces a read of the file and reads the screen, until the `popAll` entries cover the queue and the
   field shows text, or 3 s pass (`TAKE_BACK_POP_WAIT_MS`); a field caught half drawn after `popAll` is read again
   for up to another 3 s.
7. After `up`: `popAll` entries for the whole queue and a field that shows exactly the taken texts start the cleanup
   (below); fewer entries, or another field, hold the field without keys. No `popAll` and a history entry: `down`. No
   `popAll` and an empty field: nothing taken from the CLI. Any other case holds the field without keys.

The CLI part of the result counts only `popAll` entries in the file. When they cover fewer prompts than the queue held
at the gates (a gate before `up` stopped, `popAll` came short, or the CLI took the queue in the instant before `up`,
CLI 2.1.328), the response carries `incomplete: true`. A `popAll` text loses its paste wrapper and takes the echo
token of its entry in the follower's echo window (`claimEcho`, "Held echo" above); Rarog's entries carry their own
token. The manager turns a token into the message's `clientMessageId` (`server/src/sessions/session-take-back.ts`).
While a take-back runs, no held echo of the session is flushed, neither by a send after the turn nor by the
end-of-turn timer, so a message it takes never lands in the transcript; once it answers, the held echoes it did not
take get the end-of-turn flush again (`pauseHeldFlush` in `server/src/sessions/held-echo.ts`). A send from the app
that arrives meanwhile waits for the take-back's answer before its echo and its prompt, so the transcript keeps the
order in which the CLI got the messages (`whenTakeBackSettles`). `server.log` times each answered take-back from the
request: `take-back: <session> gave back N prompt(s) in T ms (first key after F ms)`, or `(no key)` when no key went;
an incomplete answer adds `; part of the CLI queue stayed`.

**The field hold** (`TakeBackField` in `drivers/herdr/take-back-field.ts`). From `popAll` on, and from the moment a
pasted head leaves the queue, the driver holds the prompt field while it may show taken text. Meanwhile every paste
from Rarog's queue and every send to an idle pane waits (`send: message for pane <pane> waits (field)`), so a new
message never joins the taken text, and a slash command is refused with `commands.send-stalled`, because its Enter
would send the taken text with it. The record is one of three:

- `clear`: `ctrl+u` while the field (without whitespace) is the start of the taken texts, one per line, or, cut at
  the top, a part of them. The press ceiling is twice the screen lines of the texts at the pane width plus 4; three
  presses that do not shrink the field stop the keys.
- `history`: at most two `down` out of the history entry `up` opened.
- `hold`: no key. It ends when the field is empty, or when the whole field, not cut at the top, fits neither the text
  it expects nor the start of the taken texts: the field changed at the desk, and the next send from the app takes the
  path of a draft at the desk. `server.log`: `take-back: field cleanup in pane <pane> stops without a key: the field
  changed at the desk`. A field cut at the top never ends a hold, because the lines above may still hold taken text.

A `clear` or `history` record whose keys stop (the ceiling, a field that does not shrink, a failed key, a step that
threw) goes on as a `hold`, so the field is never let go while it may show taken text. A dialog during the cleanup
holds the keys until it closes. The first pass runs before the response; the rest goes on in the background every
300 ms (`PROMPT_RETRY_MS`), and a new take-back meanwhile refuses with `busy`.

**Pastes: the placeholder rule.** The CLI draws a multi-line paste in the field as `[Pasted text #N +K lines]` (CLI
2.1.328, `zabranie-wklejka*`), so the field does not show the taken text. The take-back proves such a field its own by
the placeholder: a `popAll` text that is one paste and nothing else also has a collapsed form, in which the paste is
its placeholder with the line count K (the number after `#` does not count), and the field matches when it shows
either the full texts or the collapsed form (`collapsedText`, `showsTaken`). A placeholder counts whole or not at all:
a field that ends inside one, or that starts inside one under a cut top, matches neither form. A field half drawn
inside a placeholder (it ends after an unclosed `[`, and the text before it is the start of the taken texts) keeps the
hold but never starts clearing. A placeholder wrapped over a cut top stops the keys and holds the field. Whether the
CLI collapses a short paste too is unmeasured, so the full text stays a match as well; an entry with text beside a
paste counts as plain text, since its collapsed look is unmeasured.

**Refusals.** A refusal comes before the first key and changes no queue; `server.log`: `take-back: pane <pane> refused
(<reason>), no key`. Each reason has its own sentence, `session.take-back.<reason>`:

- `pane` (410): not a Claude pane in scope with a transcript file, or the driver is gone;
- `dialog` (409): a dialog, a form or a hook consent request stands, or the screen does not show the field;
- `draft` (409): the field holds text that is not Rarog's;
- `unknown` (409): the CLI queue is not known, or the file and the screen disagree;
- `queue` (409): an image in the CLI queue, or more than 64 prompts in it;
- `busy` (409): the field still holds text of the previous take-back;
- `disk` (409): Rarog's queue could not be written without the taken messages; they stay queued.

**Gaps.** `popAll` lines the CLI writes but the follower has not read when the driver is disposed are missing from the
result, although the prompts left the CLI queue (CLI 2.1.328). A CLI queue that grows past 64 prompts between the last
count and `up` cannot be proven taken, so that part is missing from the result and the response says `incomplete`. A
message from the app that was pasted onto a draft at the desk comes back without `clientMessageId`, because its text
is not the message alone (`docs/implementation-spec.md`, "Queue take-back").

## After a Claude Code update

The screen parser recognizes dialogs by the CLI's LOOK, and an update can change that look: the phone card then
silently falls back to "answer in the terminal". `pnpm run check` runs no live measurement. The fixtures under
`server/test/fixtures/herdr/measured/`, `kontrolny/`, `ultracode/` and `commands/measured/` are recorded by hand
after an update, each set from a live session in its own herdr tab. For `measured/` the session raises 13 dialog
types (questions, `Bash`, `Edit`, `Write`, MCP, sandbox network, the plan) and dismisses each with Esc, so nothing
is approved; each capture is saved as `<type>-<version>.txt` and `<type>.txt`. Each one passes the anonymizer
(`scripts/anonymize-fixture.ts`; rules in `server/test/fixtures/herdr/README.md`, "Writing a fixture"). After new
captures of a new CLI version:

1. **Dialog look.** An empty `git diff server/test/fixtures/herdr/measured/` means the look did not change. Changed
   content: review the `SCREEN_SIGNATURES` entries it touches and fix them with the version. New file NAMES
   only carry a new version number.
2. **Gate.** `pnpm run check` runs the orphan signature test and the parser tests on the fixtures. It checks only
   that every registry signature hits some fixture.
3. **herdr verdict** on the new captures: the loop from "Dialog detection in herdr". `idle` over a new dialog means
   herdr does not see it, and only the driver fallback (CLI registry) can give a card.
4. **CLI process registry.** The "newer Claude Code" pill reads the undocumented registry
   `~/.claude/sessions/<pid>.json`. When its shape changes, the pill goes quiet and `server.log` gets the line
   `CLI registry: unknown shape` ONCE: fix `parseCliRegistryFile` in `server/src/cli-version.ts`. The restart reads
   the prompt field from the frame (`composerRegionState`, fixtures `composer-region-*`); a new frame look is a refusal
   to restart, never a blind `/exit`. The line `CLI registry: unknown dialog class "…"` (also once) is a new
   `waitingFor` value; the card then says what it says without a class (`other`). Map it to a Rarog class in
   `WAITING_FOR_CLASSES` with evidence in a comment: the docs page or a measurement with version and date. A new Rarog
   class is a contract change (`CLI_DIALOG_CLASSES`, the Swift type, `UICopy.cliDialogPhrase`, golden frames).
5. **New CLI dialogs.** The repo has no list of CLI dialogs beyond the measured ones, so Rarog learns about a new
   dialog only when it stands in a session. Signals: the Claude Code changelog (measure a new or changed dialog live
   before it gets a signature), class `other` among cards without a decision in `herdr-audit.log` (its screen is in
   `<dataDir>/refusals/`, "Refusal diagnostics"), and the `unknown dialog class` line. A few days after the update,
   count the `degrade` entries in `herdr-audit.log` by reason: more cards without buttons than before means a dialog
   the captures missed.
6. **Control set.** Compare new captures in `server/test/fixtures/herdr/kontrolny/` with the previous version's. A
   changed or new shape goes into `manifest.json` after a review of the capture (block, `waitingFor`, `today`, policy
   verdict, `shape`), with an entry in `provenance.json`. A shape with buttons whose class came out
   `permission prompt` or `sandbox request` needs a decision before it enters the set; an option that changes session
   permissions or settings gets a verdict without buttons. An entry with verdict `buttons` outside the question form
   needs a shape in `layer2/shapes.ts`. A new capture changes the corpus, so refresh the full golden card file
   (`karty-korpusu-pelne.json`) with `server/test/dialogs-full-cards.test.ts` in write mode (the variable
   in the test header) and review the diff. A screen whose card gets a layer 2 trace at `RAROG_DIALOG_LAYER2=1` goes
   into `LAYER2_BLOCKS` in `server/test/dialogs-layer2-no-digits.test.ts`, and into
   `LAYER2_CARD_CHANGES` when the flag also changes its card identity or snippet.
7. **Ultracode.** When an update changes `/effort`, the `ultra_effort_*` attachments or the prompt field rule, a
   changed CLI word (command result, attachment name, refusal with workflows off) is fixed in
   `server/src/herdr/ultracode.ts` or in `ULTRACODE_COMMANDS`, with a new evidence file (`docs/slash-commands.md`,
   "After a Claude Code update"); a changed look of the echo or result line in the signatures `ultracodeEcho` and
   `ultracodeInlineResult`.
8. **Prompt block.** A changed entry shape or literal in the new `prompt-block-*-<version>.jsonl` fixtures: fix
   `TRANSCRIPT_ENTRY` with the version, then `server/test/herdr-commands-boundary.test.ts`.
9. **Consent top: zone and bottom.** `server/test/layer1-top-corpus.test.ts` runs the top match
   ("Channel cycle") on every capture with a `Bash`, `Edit`, `Write`, `NotebookEdit` or plan dialog. A changed row of
   its frozen table, or a `Bash` zone or dialog bottom off the closed lists, means a new look of the lines under the
   frame or of the footer: the top match then gives `unknown`, so such a dialog gets no approve button from the
   consent channel. A new line joins the registry with its fixture and CLI version; a changed table row needs a
   reason. An `Edit` dialog with a CLI line above its question is not measured, so it stays at the desk until a
   capture adds that line to the `Edit` tail list.
10. **Consent channel.** The channel cycle stands on the hook facts in "`PermissionRequest` hook behavior" (CLI
    2.1.311 to 2.1.318): the hook gets the request while the dialog stands, a signed `allow` closes the dialog and
    runs the tool once, the result carries `permissionDecision.source: "hook"`, and an unattended dialog has the CLI's
    own auto-deny countdown ("Dialog block"). Measure them again after an update. A changed fact shows in the consent
    records: claimed answers with a receipt end in `unknown` with `no-effect` or `foreign-decision` instead of
    `applied`. On a release above the measured one the approve button without the top of the screen waits for that
    release's `pass` in the canary file ("Proof rule").

The same step for other areas: `docs/background-tasks.md`, `docs/artifacts.md` and `docs/slash-commands.md`, each
"After a Claude Code update"; the prompt queue: `docs/architecture.md`, "Prompt absorbed into a running turn".

## Refusal diagnostics

- `<dataDir>/refusals/<time>-<reason>.txt`: the screen, the hook dump metadata (without `tool_input`), the pending
  jsonl entry, the CLI class and the case shape in the same fields as the log entry (`key: value` lines above the
  screen, the literal `brak` = `null`); the time in the name is the event time, the same as the entry's `ts`.
  Retention 48 h, cap 200 files, `RAROG_REFUSAL_DUMPS=0` turns it off.
- A dump of a layer 2 dialog (a picker, a slash command view, a model confirmation) is
  `<time>-<reason>.dialog.txt` and lives 14 days, cap 500 files: such a screen carries no tool input, and the dumps
  are the corpus the layer 2 rule is replayed on. Only a dump without any consent trace gets the marker
  (`isLayer2Dump` in `dialogs/refusals.ts`): registry class `dialog`; no tool name other than a screen card's
  (`dialog`, `dialog:<kind>`); no hook dump; no jsonl entry; no tool identifiers in the case shape (`source` other
  than `screen`, `toolUseId`, `promptId`, `agentId`); a screen read, and on it neither a tool consent nor a question
  form (their footer markers anywhere in the text, or a parsed dialog of kind `tool` or `question`, with a tool name,
  or the answer review). The class alone is not enough: the registry can say `dialog` while the last screen read
  still shows a consent dialog and the standing card is a tool's. Any doubt keeps the plain name.
- Every other dump (class `permission`, `sandbox`, no class, or a class `dialog` dump with a consent trace) keeps
  48 h and 200 files, because a consent dialog screen shows commands with their values. The sweeper caps the two
  kinds separately, so a burst of one never evicts the other; the name decides the kind, so a `.txt` dump without
  the marker falls under 48 h whatever its header says.
- Reasons: `mismatch` (the screen says something other than the jsonl entry or the hook), `no-jsonl`, `unreadable`,
  `multi-select`, `no-digit`, `screen-changed` and the others from `REFUSE_REASONS` (`shared/src/protocol.ts`).
- **A screen card without the approve button** carries its reason in `unavailable` ("What stays in the terminal in
  `all`"). The facts behind `settings-changed`, `other-hook` and `unverified-hooks` are in `server.log`:
  `consent: session hooks <session> no (<why>)` names the list verdict with the file, and `consent: key <key>
  (subagent) released to the desk … (reason: other-hooks)` the release of that call.
- The consent channel cycle (`layer1/cycle.ts`) writes `<time>-top-<member>-<key tail>.txt` for a main-thread card
  without proof whose proof log line names an unknown top element: `top-bash-zone`, `top-edit-zone`, `top-bottom`
  ("Proof log"; a subagent card has no proof log line, so no dump). One dump per card, not per read; the key tail
  is the last 12 characters of the card key, because two cards under one screen read share the time and the reason.
  The header adds `key:` (card key) and `proof:` (the proof log members); the time is the start of the screen read.
- **View scrolled up** (`tui: fullscreen`). Scrolling in the terminal (wheel, trackpad, a finger in Blink) hides the
  dialog below the screen edge, and `agent.read` returns the transcript alone, without the prompt field and the
  dialog. The refusal dump sometimes has the pill `N new messages (click) ↓` or the rule `── N new messages ──`, not
  always. Result: `unreadable` and a card with the hint to scroll down. After scrolling down the card comes back by
  itself at the next timer tick (up to 4 s). Rarog does not scroll by itself: a key would reach the standing dialog.

### Case shape in the log

`approve`, `degrade` and `refuse` entries carry identifiers and numbers that rebuild the case SHAPE without the
screen; they contain no screen text and no option labels. Fields (`AuditCaseShape` in `server/src/herdr/audit.ts`; a
value of the wrong shape or outside the closed list does not reach the file):

- `reqId`: card identity (`ActiveReq.reqId`: `tool_use.id` or `hook:<dump generation>`, with a fingerprint suffix),
  the same as in the SSE frame; it links a `degrade` with a subsequent `refuse` or `approve` of that card. For `refuse`
  it is the card standing at the refusal (for `stale-card` not the one tapped).
- `source`: where the card took the tool and input compared with the screen: `jsonl`, `hook` or `screen`.
- `toolUseId` (jsonl entry, `PreToolUse` dump), `promptId` and `agentId` (hook dump; `agentId` = a subagent request).
  A card from a `Bash` entry with double proof gets the dump identifiers too.
- `mismatchReason` (`degrade` only): the subreason from the FIRST screen recognition: `kind`, `tool-name`,
  `multi-select`, `operation`, `ambiguous` (an ambiguous dialog block) or `ambiguous-sources` (the screen matches
  entry and dump at once, or does not confirm the content of an entry of the same tool).
- `headerVisible`: whether the dialog's top rule shows above the operation frame; no field = no frame or no dialog.
  `optionCount`: the number of options with digits (`0` = none, no field = an unreadable screen). For `degrade` from
  this evaluation's screen, for `refuse` from the last screen read (the one in the refusal dump).
- `blockVisible`: whether the WHOLE dialog block stands in one screen read (`screen/block-visible.ts`): top rule,
  title, all options `1…N` and the key footer. `false` = a dialog cut at the top, a scrolled view, no dialog, or a
  dialog without a footer ("Session paused", the sandbox network request, "Switch model?"), because without a footer
  the read does not prove that no option follows. For `approve` from the fresh read before the key. Neither card nor
  digit depends on it.
- `dialogTitle`: a dialog from `TERMINAL_DIALOGS` recognized on screen (`session-paused-safeguards`,
  `background-work-exit`; "CLI dialogs answered in the terminal"); `null` = a dialog outside the list.
- `paneRows` (`degrade` only): the pane's terminal rows from herdr, `scroll.viewport_rows` in `pane.list`
  (`HerdrClient.readPaneRows`), not the `pane.layout` rectangle, which describes the tab layout. The herdr 0.9.5
  socket API gives no columns. The driver waits for the read at most 500 ms (`HERDR_PANE_ROWS_WAIT_MS`); past the
  budget or on an error the entry goes without the field. The card does not wait for it.
- `budgetSource`, `hookPaneRows`, `hookPaneCols`: the tall dialog guard at HOOK time (budget source and the pty from
  the hook's `LINES`/`COLUMNS`), from the dump of a passed `Bash` permission. A difference from `paneRows` means the
  pane was resized between the hook and the screen evaluation.
- `cliDialog` (entries with a card): the dialog class from the CLI session registry (`waitingFor`) when the registry
  says `waiting`. No field in an entry with `route` means it does not (no registry, an active session, two processes
  of one conversation).
- `route`, `routeReason`: the verdict of the layer router (`server/src/herdr/dialogs/router.ts`) from the registry
  class, the `PermissionRequest` hook dump (none, main thread, subagent) and the same screen read. The verdict names
  the layer MEANT to handle the dialog, not today's card, and goes only to the log, so the entries count how many
  dialogs each layer would take. Layer 1 is a hook channel for tool permissions (address and content from the dump,
  decision by answer file); today no permission is decided this way, and a permission goes by a key (shadow mode only
  rehearses layer 1, "Per-call dump and shadow mode"). Layer 2 reads a CLI dialog from its block on screen ("Layer 2
  block and the shape registry"). `route`: `layer1` (a tool permission with a live dump), `terminal-only` (a
  permission without a dump, or the sandbox network request), `question-form` (a question form, class `input`),
  `layer2` (a CLI dialog, class `dialog`), `none` (no buttons: class `worker` or `other`, the registry does not say
  `waiting`, or the screen does not fit the class). `routeReason` comes from `DIALOG_ROUTE_REASONS`, one per row of
  the router table (for example `permission-dump`, `permission-agent-dump`, `permission-no-dump`, `dump-no-class`).
  The verdict is NOT the entry's decision: `decideCard` picks card, buttons and keys. The field shows where they part:
  an `approve` by digit with `route` `layer1` or `terminal-only` is a tool permission approved from the screen.
  Classes `permission` and `sandbox` never give a verdict with a digit (`question-form` and `layer2` are the only such
  verdicts).

A `block-card` entry (block card issued) is left by every card built from the screen alone (`source` = `screen`).
It carries the card identity (`reqId`, `source`, `toolName`), `cliDialog`, the screen shape (`optionCount`,
`headerVisible`, `dialogTitle`) and its own fields (`blockCardRecord` in `cards/build.ts`): `print` (the block
fingerprint `bodyPrint`, 16 hex characters), `verdict` (`BLOCK_CARD_VERDICTS`: `buttons`, `partial` with some options
terminal only, `no-buttons`) and, only for a layer 2 card at `RAROG_DIALOG_LAYER2=1` ("Block card without digits"),
`layer2: true` with `layer2Why` (`LAYER2_WHYS`: `block-no-digits`, `unstable`); the layer 2 card with buttons has
`layer2: true` without a reason (`docs/dialog-card.md`). The entry decides nothing (golden file
`fixtures/herdr/karty-korpusu.json`), timer ticks over the same card do not repeat it, and a card without a decision
has a `degrade` entry with the same `reqId` next to it.

Example entry shape (a subagent `Bash` permission, frame cut at the top, hook dump alone; illustrative values,
shortened identifiers):

    {"ts":"…","sessionId":"…","key":"wQ:pJ7","paneId":"wQ:pJ7","cwd":"…",
     "method":"degrade","mode":"auto","reason":"mismatch","reqId":"hook:1792750627234:f:3c0d…",
     "source":"hook","promptId":"…","agentId":"afeedfacedeadbeef","mismatchReason":"operation",
     "headerVisible":false,"optionCount":2,"blockVisible":false,"dialogTitle":null,"paneRows":28,
     "route":"layer1","routeReason":"permission-agent-dump","cliDialog":"permission","toolName":"Bash"}

An `approve` entry (a digit on a main thread permission with a live dump) carries the card origin, the whole block
and the verdict, without `headerVisible`, `optionCount` and `dialogTitle`:

    {"ts":"…","key":"wQ:pJ7","paneId":"wQ:pJ7","cwd":"…","method":"approve","mode":"auto","keys":["1"],
     "reqId":"toolu_01AbCd…","source":"jsonl","toolUseId":"toolu_01AbCd…","blockVisible":true,
     "route":"layer1","routeReason":"permission-dump","cliDialog":"permission","toolName":"Bash",
     "optionLabel":"Yes"}

## Known gaps

Where an entry below gives a permission card buttons from the screen or jsonl, that holds only with the effective
consent mode `off` or `shadow`: at `main` such a card has no approve button ("Rules: what must not be relaxed"). The
last two entries are gaps of the consent channel itself.

- **Permissions without a name from the block (CLI 2.1.311).** `WebSearch` has the title "Tool use" without an MCP
  header, so the jsonl path ends in `mismatch/tool-name`. `WebFetch` ("Fetch") asks "Do you want to allow Claude to
  fetch this content?" without a permission footer, so the kind is `confirm` and the path gives `mismatch/kind`; so
  does `NotebookEdit` in a 26-column pane, whose footer breaks (an `Edit` or `Write` dialog with a cut or wrapped
  footer keeps its kind or gets no form: "Permission dialog operation"). `Glob` and `Grep` did not appear on this
  CLI version, so their title is unmeasured and a permission for them ends in `mismatch/tool-name`; so does any tool
  outside the title map. Detection: `mismatch` with `tool-name` in `herdr-audit.log`.
- **Trust card on a live pane is unmeasured (CLI 2.1.319).** The arrow path ("Folder trust dialog without digits")
  is tested on the control set captures, not on a live pane from the app. The driver reports the trust dialog to the
  supervisor (`markTrustDialog`) at the card and before `enter`, so `HERDR_TRUST_REEXEC_GRACE_MS` (15 s) holds the
  session when `claude` briefly leaves `agent.list` after the approval. A trust dialog the parser rejects (a cut
  render) still gets a card without buttons and no report.
- **Queued permission with a counter in the title (CLI 2.1.314).** The title line ends with "k of N" ("Read file …
  2 of 2"), and the title map knows the title without it: `mismatch/tool-name`, no buttons. At "1 of 2" this is the
  safe side, because the hook dump then describes the second request.
- **A screen-only card does not see an escalation further in the label.** Without a payload the label is the
  option's first line, or the wrapped label cut at `OPTION_LABEL_MAX_CHARS` (200), so a marker further on is missed by
  `screenQuestionCard` and the digit gate. Cards that know the payload compute `terminalOnly` on the full label.
- **Hook dump and entry content compared with the whole screen.** `hookMatchesScreen` (for tools other than framed
  `Bash`, `Edit` and the plan) and `screenConfirmsInput` look for a fragment in the whole pane text, also in the
  scrollback, so a line with the full path of a stale entry above a dialog for another file lets that entry win with
  buttons. An entry and a dump of DIFFERENT tools of the same MCP server follow the plain rule, so a dump with a
  `command`/`file_path`/`url`/`pattern` field loses to the entry. Neither was measured on a live pane.
- **A `Write` dump does not match a file dialog in the session directory (CLI 2.1.293).** "Create file" shows the
  relative path, and `hookMatchesScreen` looks for the absolute `file_path`, so a `Write` dump without a jsonl entry
  drops out and a screen-only card has no buttons over 2000 characters.
- **An "Overwrite file" card from the jsonl entry or hook dump has no button.** The diff does not show that it covers
  the whole file, so the screen never proves the write; the dialog is answered in the terminal.
- **A `Write` or `Edit` card from the jsonl entry or hook dump has no button when the frame does not prove a wrapped
  line or the content has a tab or whitespace at the end of a line.** The tab width is unmeasured and whitespace at
  a line end is an empty cell, so the screen does not prove the content (content rule in "Permission dialog
  operation"). A wrapped line proves only under the measured geometry, with a row exactly W wide in the same frame
  and every character of the line on the closed list, so a wrapped line with an accented letter off the list, an
  emoji or a CJK character gets no button, nor does any wrapped line in a frame drawn on another geometry. A
  continuation row that reads as a numbered row once the margin is gone also gets none: in `Write` that is any
  continuation starting with digits followed by a space or by nothing (`2024 was`), in `Edit` one starting with
  digits, a space and a marker (`42 -x`). The same holds for the `Edit` dump against the screen
  (`hookMatchesScreen`, `matchTop`).
- **An invisible cell at the wrap in a context line reads as a space.** A no-break space at column W looks like a
  space there, and a tab across the break is drawn as spaces whose cells at the row end the read drops
  (`kontrolny/zgoda-edit-wrap-tab-57`: the row is three cells short of W). The proof pads such a row with spaces,
  so an `Edit` context line the call does not cover can differ from the file while the edit still proves: the
  call's replacement is the same either way. A line the call covers compares with the call literally, so a no-break
  space or a tab there gives no button.
- **Whitespace at a line end in the call the dialog shows is invisible.** The screen proves only content without
  whitespace at line ends. A dialog whose call has it (a space after a final `\` of a script line) looks like a call
  without it, so a jsonl entry or a dump without that whitespace matches the screen, and its button confirms the
  dialog's call. No screen rule can tell the two apart.
- **A permission dialog cut at the top has no button from the phone.** A diff or file content taller than the pane
  pushes the header, the queue counter and the frame top over the edge (`Edit`:
  `refusals/zgoda-edit-uciety-naglowek-63x28.txt`; `Write`: `measured/zgoda-write-dluga-tresc-2.1.322.txt`, CLI
  2.1.322). The same holds when the whole frame is above the edge too and the screen starts at the question.
  The screen then cannot tell which dialog stands, so every path gives a card without buttons and the
  dialog is answered in the terminal (Esc works from the phone). The exception is `Bash` on the jsonl and hook path,
  whose `│` frame proves the command: the whole frame with an `Ask rule Bash(…)` name, or a frame cut at the top with
  double proof (cross-check, item 4).
- **Two `Edit` edits that differ only in whitespace cannot be told apart**, because the diff compares without
  whitespace; an entry and a dump that both match give a card without buttons.
- **An `Edit` dump of another request with another `cwd` matches when relative path and edit are the same.** The
  screen does not show the call directory. When the hook wrote no dump of the current request and an older dump edits
  a file with the same relative path identically in another directory (two worktrees), the card names its file, and
  the digit approves the dialog's file.
- **File name with trailing whitespace.** The screen trims it, so a dialog for `a.txt␠` matches a dump for `a.txt`.
- **Trust folder with trailing whitespace.** The trust block has no right border and the screen trims trailing
  whitespace, so a trust dialog for `/Users/u/project␠` reads as `/Users/u/project` and passes the `cwd` check of a
  session in `/Users/u/project`.
- **A card from an `Edit` dump without a jsonl entry lives until the dump expires (10 min).** Then the evaluation
  returns to the screen alone, and over 2000 characters the card loses its buttons.
- **A subagent permission queued longer than 10 min has buttons only with a whole `Bash` frame.** Its per-session dump
  then enters only with screen proof ("Flow", items 2 and 4). A frame cut at the top, a tool other than `Bash`, and a
  dialog standing over 60 min (`PENDING_HOOK_BASH_TTL_MS`) give a card without buttons when the jsonl entry points at
  an open main thread tool (route `permission-no-dump`). The same when Rarog decides a dialog before it whose frame
  is not whole on screen at the key ("Flow", item 6). Whether such a dialog stays after `escape` on the main thread
  dialog is unmeasured.
- **After a desk decision in a queue the top dialog's card stays until its tool result.** While the decided tool's
  jsonl entry has no result and the hook dump does not change, the evaluation identity stands and the "same card" gate
  ends the evaluation before the screen read: the decided card keeps its buttons and the subagent permission now on
  top has no card. A tap sends no key (`screen-changed`) and lets the subagent permission get its card; a `Bash` dump
  older than 10 min with screen proof ends the gap without a tap ("Flow", item 2).
- **The trace "The permission request expired." on a card swap.** The driver puts out the previous card with
  `permission-cleared`, the manager turns it into `permission-resolved` with `expired`, and the app keeps the trace
  (`cards.permissionExpired`) for 6 s (`CoreTiming.noticeLifetime`), also when a card for the same dialog takes its
  place at once. The fix needs an app change.
- **Header cut off without a hook.** A `Bash` permission with its header above the screen edge passes only with a hook
  dump that agrees with the jsonl entry; without a hook (or for `Edit`/`Write`) it ends in `mismatch`.
- **Pane width change** between card and tap changes the fingerprints: a `screen-changed` refusal and a new card
  (safe, but a second tap). The same for a question tab switched at the desk when the answer falls back to a digit.
- **The block fingerprint does not prove completeness**, only that the block did not change between the card read and
  the read before the digit. An option list cut the same way in both reads gives the same fingerprint.
- **Plan dialog without a footer.** A plan card issued without the footer has no fingerprint, so the check before the
  digit stays with label, digit, kind, identity and dump generation, and a plan swapped under it for one with the same
  question and options passes. The same plan file name in two consecutive dialogs gives the same fingerprint.
- **Screens without a block fingerprint** (no block rule or status rule right above the options) keep the check
  before the digit at label, digit, kind and identity: in the corpus the inline `/model` result
  (`model-set-inline-2.1.258.txt`), both `WebFetch` permissions and the narrow `NotebookEdit` from CLI 2.1.311.
- **Long screen-only content.** A permission card without a jsonl entry and without a hook dump, with content longer
  than 2000 characters, has no buttons.
- **`/skills` over the snippet cap.** Without the layer 2 flag the skill list block exceeds 40 lines or 2000
  characters, and the card shows the screen tail without the view title; at `RAROG_DIALOG_LAYER2=1` it fits ("Block
  card without digits"). `/usage` is measured only on an API key account (`kontrolny/usage-klucz-api-*`).
- **Tab in the same view.** Without the layer 2 flag a tab switch (Status → Usage in `/status`) keeps the block title,
  so the card keeps the block from when it was issued; at `RAROG_DIALOG_LAYER2=1` the block refreshes.
- **Rule in the middle of a view.** The snippet starts under the LOWEST dialog rule, so a view with a `▔▔▔` or `───`
  rule and a key line under it mid-content loses everything above it on the card. A rule and footer faked in an
  agent's answer reach the card as a dialog block; the card has no buttons.
- **Esc right after the pause appears.** The Esc refusal on "Session paused" reads the screen at the blocked state
  (`#blockedNow`). An interrupt sent before herdr or the CLI registry reports the blocked state goes without a read.
- **The 422 sentence for the Esc refusal on the pause.** The reason `terminal-only` is the closest one in
  `REFUSE_REASONS`, so the 422 body carries its contract sentence (`REFUSE_MESSAGES`) about an option that changes
  permissions; the exact explanation stands in the transcript (`PAUSE_ESCAPE_MESSAGE`). A pause card from the list is
  a question card without a deny button, so this reaches only the Dismiss Dialog button of a snippet card and a
  client that sends `deny` itself.
- **A typed `Bash` frame right above the bare question of another dialog.** `Read`, MCP, `Skill` and `WebSearch`
  dialogs ask the bare "Do you want to proceed?", the last line of a listed `Bash` zone. When such a dialog shows
  multi-line text without a CLI prefix right above its question, that text ends with a typed bare rule, a `Bash`
  title and a frame, and the dialog's own title stands above the top edge of the read, the top match ("Channel
  cycle") sees one pair, a listed zone (the dialog's own question) and a listed footer, so a `Bash` request whose
  command equals the typed frame gets `match`. The button then goes to that real request of the pool, the card shows
  the content of its dump, and the consent goes to its hook. Control case:
  `server/test/layer1-top-matching.test.ts` (`it.fails`).
- **A whole typed dialog at the bottom of a scrolled view.** A dialog typed into the transcript from its block rule
  to its footer passes the top match when the read of a scrolled view ends exactly at the typed footer; with more
  transcript under it the bottom gives `unknown`. The read carries no scroll position. The effect is the same: the
  button goes to a real request of the pool whose content the typed dialog shows, the card shows the content of its
  dump, and the consent goes to its hook. Control case: the same test file (`it.fails`).
