# herdr fixtures: origin and anonymization

herdr is the terminal multiplexer that runs Rarog's Claude Code sessions, one session per pane. Tests of the herdr
integration read pane captures, herdr output and transcript lines from this directory, never from a live herdr
socket, so they repeat without herdr and the content of real work sessions stays out of the repo.

**Anonymization rule for every file here:** paths become `/Users/u/…`; client project names become placeholders in a
measurement capture and neutral names (`demo`, `atlas`, `~/project`, branch `main`) in synthetic or reconstructed
content; conversation titles become generic ones (`refaktor`, `testy`, …); session IDs become deterministic UUIDv5
values from one namespace. No secrets, no conversation content.

**This README describes origin, never the map or the originals.** Only the private literals file knows which
original became which placeholder (its `pseudonyms` field). That file lives outside the repo, at
`RAROG_PRIVATE_LITERALS` or `~/.config/rarog/private-literals.json`; its format is in `docs/publishing.md`,
"Private literals file". The README names only the category ("owner login → `u`").
`server/test/herdr-fixtures.test.ts` counts private literals in fixture directories, so a new capture with a private
name fails before commit. `agent-list.json` and `pane-list.json` share one directory → neutral name mapping (`demo`, `birch`, `cedar`…,
`rarog` stays): the same `pane_id` means the same project in both files.

## New fixture

1. Write the file through the anonymizer's final pass ("Writing a fixture" below). A measurement does this itself;
   a manual capture goes through the anonymizer CLI before `git add`.
2. A dialog that Rarog answers gets a capture from a live pane (`herdr agent read`). A reconstruction (a screen
   retyped from a screenshot or a description) serves only shape tests (frames, ANSI, snippet): typed by hand, it
   misses a rule line inside an option list or a typographic apostrophe.
3. When the Claude Code version is known, the file name carries it ("CLI version in the file name" below).
4. Add the file's entry to `provenance.json` in the same commit; for a file without one, the test prints it ready.
5. Describe the file in this README, in its section or in "Files without their own section" (class, origin, test).
6. Run `pnpm test server/test/herdr-fixtures.test.ts` and the test that reads the file.

A case that never occurred on a live server never goes into a capture: the test builds it by modifying an entry.

## Writing a fixture

Every fixture from a live session goes through `scripts/anonymize-fixture.ts` last. A measurement writes files only
through this module; a manual capture goes through its CLI before `git add`:

    pnpm exec tsx scripts/anonymize-fixture.ts <file>...      # in place; one refusal = no file written
    <capture> | pnpm exec tsx scripts/anonymize-fixture.ts --out <file>
    pnpm exec tsx scripts/anonymize-fixture.ts --require      # checks only the literals file (exit 0 or 2)

A measurement's extract applies the rules of its own format: the measurement directory becomes `/Users/u/projekt`,
IDs are renumbered, and text that does not belong in a fixture gets a placeholder. The placeholders are literal
strings in the files:

- `<tekst poza fixture>`: prompts, model replies and command output (the out-of-fixture placeholder);
- `<komenda poza fixture>` and `opis N (treść poza fixture)`: commands and task descriptions in `tasks/incydent-*`;
- `prompt człowieka N (treść poza fixture)`: human prompts in `tasks/incydent-gotowe-po-postoju-2.1.301/`;
- `✻ <status pracy — gaszony przy zapisie>`: the blanked status line in dialog measurement captures;
- `<email>` and `<sesja>`: the email and session ID in the copies of refusal dumps (`refusals/`).

The pass then adds the rules shared by every format (pane capture, JSON, JSONL):

- placeholders of the previous rule version → current ones (`PLACEHOLDER_MIGRATIONS`, paragraph below);
- checkout root, including a worktree and the slug form in `~/.claude/projects` → `/Users/u/Projects/rarog`;
- home directory and any login not on the synthetic list → `/Users/u` (`-Users-u-` in a slug);
- names from the pseudonym map of the private literals file → placeholders;
- macOS temp directory → `/tmp/folders/` with `x` segments of the same length, `/tmp/claude-<uid>/` →
  `/tmp/claude-uid/`;
- API IDs (`msg_`, `req_`, `toolu_`, `srvtoolu_`) and random UUIDs → numbering of the same length in order of first
  appearance. Version 5 UUIDs (the session IDs from the rule at the top) and UUIDs the extract zeroed
  (`00000000-0000-…`) stay; every other UUID becomes `00000000-0000-4000-9000-…`;
- account plan banner → `Claude Plan`, usage counter in the status bar → dashes of the same length, email →
  `u@example.com`, tailnet name → `mac.example.ts.net`.

The checkout root placeholder is `/Users/u/Projects/rarog` in every file here (slug `-Users-u-Projects-rarog`, form
`~/Projects/rarog`), files with `anonymizer: null` included. A placeholder change is a new rule version
(`ANONYMIZER_VERSION`) with a `PLACEHOLDER_MIGRATIONS` entry: literal pairs "previous placeholder → current" that the
pass applies first, so a file written under a lower version reaches the same text as a fresh write, and a second
pass changes nothing. After a version change, a file with an `anonymizer` version goes through the pass in place
(`pnpm exec tsx scripts/anonymize-fixture.ts <file>`). A file with `anonymizer: null` gets only the migration: the
exported function `migratePlaceholders` in `scripts/anonymize-fixture.ts`, which has no CLI flag. A placeholder of
a lower version fails `server/test/herdr-fixtures.test.ts`.

So three path placeholders appear: `/Users/u/Projects/rarog` for the checkout root, `/Users/u` for any other path
in the home directory (a manual capture outside the checkout included), and `/Users/u/projekt` for the measurement
directory, which only extracts write (a measurement's or an incident's).

Length-preserving rules: placeholder migrations, the macOS temp directory, API IDs, UUIDs, the usage counter, and
the user number in `/tmp/claude-<uid>/` when it has three digits. The others (checkout root, home directory and
login, pseudonyms, plan banner, email, tailnet, and in the extract the measurement directory and the out-of-fixture
placeholder) make a line shorter or longer than on screen, so its right frame edge leaves the column of its
neighbors. When columns are what a capture proves (command wrapping inside a frame, pane width), the original is
swapped by hand for text of the same length, e.g. owner login → `jkowals`, which the pass keeps because it is on the
synthetic login list.

Fail closed: without the private literals file (or with a broken one) the pass refuses to write and exits 2. A literal
or a structural pattern that survives the pass is also a refusal: the message gives the line and the literal number
(`forbidden[3]`), never the content; the literals file then lacks a pseudonym or the extract lacks a rule.
`server/test/anonymize-fixture.test.ts` checks the rules and each producer's refusal without a literals file;
measurement tests give producers a synthetic literals file (`server/test/fixtures/literaly-syntetyczne.json`).

## `provenance.json`: origin of every file

The manifest has an entry for every file in this directory and its subdirectories, except this README,
`provenance.json`, `kontrolny/manifest.json` (it describes the captures next to it) and files whose name starts
with a dot (`.ostatni-pomiar`). The key is the path relative to this directory, with `/`. An entry (one line in the
file):

```json
"commands/measured/catalog-2.1.302.json": {
  "source": "pomiar:katalog-komend", "date": "YYYY-MM-DD", "cli": "2.1.302", "anonymizer": 2
}
```

- `source`: `pomiar:<category>`, `ręcznie:zrzut`, `ręcznie:wycinek`, `ręcznie:rekonstrukcja` or a test path. The
  first is a measurement, with a category from the closed list `KATEGORIE_POMIARU` in
  `server/test/herdr-fixtures.test.ts` (it names the kind of measurement, not the tool). The next three are manual
  files: a capture, an excerpt, and a reconstruction or synthetic file. A test path (`server/test/<name>.test.ts`)
  names the test that writes a golden file when run with `RAROG_FIXTURES_WRITE=1`. A new kind of measurement adds its
  category to the list in the same commit; a category without files leaves the list.
- `date`: the day the file entered the repo, `YYYY-MM-DD`; a fixed copy `<type>.txt` takes the day and version of
  its versioned twin with the same content.
- `cli`: the Claude Code version, equal to the version in the file name; `null` when none was recorded.
- `anonymizer`: the rule version of the final pass (`ANONYMIZER_VERSION`) the file is stored under; `null` for a
  file that has not been through the pass, anonymized by hand or by its extract.

A manifest, not a header in the file, because a header would change the row count of a pane capture. When a file
name contains a private literal, its manifest key masks the literal (`‹forbidden[i]›`), so the manifest does not
repeat it; ratchet baselines mask paths the same way (`docs/publishing.md`, "Ratchet versus gate").
`server/test/herdr-fixtures.test.ts` fails on a file without an entry, an entry without a file, a source outside the
list, a CLI version that differs from the name, and a file with `anonymizer` that is not a fixed point of the pass
rules.

Per-file origin (source, day, CLI version) lives in the manifest; the sections below say what each file proves. They
use six classes: **capture** (herdr output byte for byte, then anonymized), **measurement** (a capture or an extract
that a measurement procedure wrote), **excerpt** (lines cut from a transcript file), **reconstruction** (a screen
retyped from a screenshot or a failure description), **golden file** (the code's output on the fixture corpus, written
by a test) and **synthetic file** (invented content in a copied shape).

## CLI version in the file name

The version in the name (`<type>-<CLI version>.txt`, `<scenario>-<CLI version>.jsonl`) is the Claude Code version
that produced the record. It comes from the first token of `claude --version` for a measurement; from the session
screen (the `/help` banner, the `Version` field in `/status`) for a manual capture, otherwise the version installed
that day; from the version installed on the day of a reconstruction (the file's item says when the original session
ran another one); and from the newest version that wrote any line for an extract over many transcript files. Without
a version in the name: a fixed copy `<type>.txt` (its `cli` is its versioned twin's) and a file whose version was not
recorded (`cli: null`). Pane width or geometry is in the name (`-26kol`, `-62x29`, `-waski-`) when the layout
depends on it.

## herdr output

- **`agent-list.json`, `pane-list.json`** (captures of `herdr agent list` and `herdr pane list`, herdr 0.8.2,
  protocol 20): 17 agents; 27 panes with 14 distinct `cwd`. Structure, `pane_id`, `tab_id`, `workspace_id`,
  `agent_status`, `state_change_seq`, `revision` and `scroll` are unchanged; `cwd`, `foreground_cwd`,
  `terminal_title`, `agent_session.value` and `terminal_id` are swapped, and `focused` in `pane-list.json` is zeroed
  (focus is momentary, not shape). Project directories carry neutral names, and the one outside the
  roots is `/Users/u/Desktop/inne`. `pane list` is the only herdr response with `cwd`, so path evidence for choosing a
  workspace comes from it. Covered: several panes in one `cwd` (`cwd` is never an identity key), panes outside
  `RAROG_HERDR_ROOTS` (`inScope: false`), 10 panes without an agent that the launcher must not count, a workspace
  with two directories (`wN`), a `foreground_cwd` deeper than `cwd` (match only by `cwd`), no `cwd` in two
  workspaces, and no `tokens` field: `pane.report_metadata` expires in herdr memory, so a missing field means "not my
  pane". Not covered: a `codex` agent, an `agent_session.kind` other than `id`, statuses `blocked`, `done` and
  `unknown`. Tests build those by modifying an entry, never by adding them here.
- **`api-schema.json`** (capture excerpt, herdr 0.9.5, protocol 22): from `herdr api schema --json`, the request
  variant of each socket allow-list method (`methods`), the response variants Rarog parses (`responses`, including
  `pong` with `capabilities`), the `event`, `subscription_event` and `error_response` schemas (`events`), and the
  transitive `$ref` closure of all of them (`defs`, key `<schema>/<name>`). The protocol number is the evidence for
  the tested set `KNOWN_PROTOCOLS` in `socket.ts`; only the set's minimum gates, so a newer number gets full
  integration before it is in the set. Read the file before a client:
  `AgentReadParams` requires `source`, and Rarog never sends the optional `lines` (0.2 ms vs 380 ms); `wait` in
  `AgentPromptParams` is optional, and Rarog sends it only with ordinary prompts, because slash commands start no
  turn and would give a false stall (`client.ts`, `prompt`); `SubscriptionEventKind` has three dotted variants
  (`pane.output_matched`, `pane.agent_status_changed`, `pane.scroll_changed`), while `EventKind` of `events.wait`
  uses underscores (`pane_created`, …): two separate namespaces.
- **`footer-auto.txt`, `footer-auto-tacka.txt`** (a capture and a reconstruction with a synthetic task line): the
  last lines of `herdr agent read --source visible`
  with the mode footer `⏵⏵ auto mode on (shift+tab to cycle)`. The other modes cannot be captured without changing
  someone else's pane, so tests build them by swapping the last line; a screen without a known pattern is `manual`,
  an unreadable one `unknown`. In `-tacka` Claude Code draws the agent tray (`⏺ main`, `◯ general-purpose …`) below
  the footer, so `parseMode` must look above the last three lines; without a mode, a send to a working session
  refuses. Its status line path and task description are synthetic, the task description with the original length.

## Dialogs in the root directory

- **`dialog-permission.txt`, `dialog-askuserquestion.txt`** (reconstructions from herdr's detection manifest
  `~/.local/state/herdr/agent-detection/remote/claude.toml`, version 2026.08.21.1): the markers of the
  `bash_permission_prompt`, `generic_permission_prompt` and `live_blocked_form` rules. Tests use them for frame
  stripping, ANSI, trimming and the `screen.snippet` hash, never as evidence that the parser handles a real screen:
  option numbering varies and the manifest updates remotely.
- **`dialog-askuserquestion-live.txt`** (capture): a real `AskUserQuestion` screen with a horizontal rule inside the
  option list, between "3. Type something." and "4. Chat about this". A parser that reads only below the last rule
  sees one option of four; the reconstruction lacks the rule, so this file is the only evidence.
- **`dialog-askuserquestion-scrollback.txt`** (capture of a live failure; synthetic conversation text with the
  original columns and wraps): a five-entry form with a rule inside the list, under scrollback with its own numbered
  list. A narrow region sees only option 5, a wide one judges the screen contradictory through duplicate digits; so
  region candidates widen rule by rule from the bottom, and a contradictory candidate drops out instead of
  disqualifying the screen.
- **`dialog-permission-subagent.txt`** (reconstruction of a live failure; synthetic command and description, wrapped at the
  original width): a subagent's `Bash` permission whose option 2, "Yes, and don’t ask again for: cd *", has a typographic
  apostrophe (U+2019). A pattern with a straight apostrophe misses it in `optionEscalates` (the option would reach
  the phone as a live button) and in `affirmativeOption` (two "Yes…" options take approval away from the card).
- **`dialog-permission-cd-advisory-2.1.265.txt`** (reconstruction from a screenshot): the two lines Claude Code
  2.1.265 adds under a command that runs `cd` before git ("…which can execute untrusted hooks from the target
  directory. Approve only if you trust it."). "untrusted" and "trust" hit `escalationContent`, so the closed
  signature `cdAdvisory` removes the sentence (whitespace as `\s+`); otherwise the permission becomes a card without
  buttons.
- **`dialog-permission-mcp.txt`, `dialog-permission-mcp-supabase.txt`** (captures, Claude Code 2.1.258; the server
  `catalog`, its tool `get_project_tree_layout` and the description lines are same-length neutral replacements, also
  in `measured/zgoda-mcp*.txt` and `measured/zgoda-siec*.txt`; `dialog-permission-mcp.txt` is therefore a
  reconstruction): an MCP
  permission shows `<server> — <tool title> Tool: (MCP)` under the generic header "Tool use" (not in
  `TOOL_DIALOG_HEADERS`), with no `⏺ mcp__…(` line. The human title does not map back to the tool name
  (`catalog_get_project_tree_layout` gives "Get Project Tree Layout"), so only the server is read
  (`ScreenDialog.mcpServer`) and compared with
  `mcp__<server>__<tool>`. The two servers keep the signature from fitting one of them.
- **`dialog-permission-ask-rule-auto.txt`** (reconstruction from a PWA screenshot of a live failure): option 2, "Yes,
  and allow … commands", adds permanent permission rules without "don't ask again" or "always".
  `OPTION_ESCALATION_PATTERN` catches it with `yes, and allow`, and both option selectors share that one dictionary.
- **`dialog-trust.txt`, `dialog-model-switch.txt`** (captures; origin at `KNOWN_DIALOGS` in
  `server/src/herdr/dialogs/screen/known.ts`): the folder trust dialog ("Accessing workspace:", "Quick safety check:
  …") and "Switch model?". A known dialog is recognized only inside the dialog block (`docs/dialogs.md`, "Dialog
  block"), so a test screen needs a rule above the title; tests build other CLI wordings synthetically, with a rule.
- **`dialog-effort-change.txt`** (reconstruction from a screenshot of a live failure): "Change effort level?" appears
  with a delay after `/effort`, so Rarog cannot treat the command as accepted after a short read window. The full
  `▔` line (U+2594) above it is in `HORIZONTAL_RULE_PATTERN`. Tested: class `confirm` (`confirmFrom`),
  `commandDialogMatches`, no match to the `model` signature.
- **`dialog-askuserquestion-multi.txt`** (reconstruction from an iPad screenshot, Claude Code 2.1.246): a
  `multiSelect: true` form with the tab bar `← ☒ … ✔ Submit →`, checkboxes in option lines (outside the label, or
  the `label → digit` key would change with every toggle), a "Submit" entry (`FORM_CHROME_PATTERN`) and no
  `space to …` footer. Every multi-question form has the "✔ Submit" bar, so the multi-select signature also needs a
  checkbox or a "Submit"/"Next" entry below the last option. Tests derive the single-question variant by removing the
  checkboxes and the bar tail.
- **`dialog-askuserquestion-multi-live-{start,submit,review}.txt`** (captures): such a form after successive keys
  (keys: `docs/implementation-spec.md`, "Dialogs and cards in a herdr pane"). A digit toggles a checkbox and approves
  nothing. `-review` ("Review your answers", `1. Submit answers` / `2. Cancel`) has the multi-select bar but is
  a two-digit confirmation, which the parser detects with a negative condition; this file is its only evidence.
- **`dialog-askuserquestion-multiq-*.txt`** (captures, Claude Code 2.1.257): the tabs of a three-question form
  (`-tab1-jednokrotne`, `-tab2-multiselect-next`, `-tab3-ostatnie`), a question in a `│` quote frame
  (`-pytanie-w-ramce`, for `unbox` and `questionFrom`), the review screen (`-review`) and a one-question
  `multiSelect` form (`-jednopytaniowy-submit`). "Next" below the options is form chrome (`^next$`). The label in the
  hook payload matches the screen character for character, backticks included, so `hookQuestionFrom` is tested on
  these files.
- **`dialog-exitplanmode.txt`** (transcribed from a live measurement, with a `⏺ Read(…)` scrollback added on
  purpose): the parser must take `ExitPlanMode` from the closed signature, which matches only the header sentence,
  not `Read` from the `⏺` line. The byte-for-byte capture is `measured/exitplanmode-<version>.txt`.
- **`dialog-trust-preapproved-2.1.332.txt`** (reconstruction from a refusal dump of a live session in a 139-column
  pane, Claude Code 2.1.332; neutral folder and permission names of the same lengths): the folder trust dialog
  without digits with the warning "⚠ This folder pre-approves 10 tool permissions in …:". The first line of the
  permission list has a three-space margin, the indent of an option line; the list wraps at a space onto the
  one-space margin and ends with "…, and 2 more". The trust parser recognizes it
  (`server/test/dialogi-zaufanie-strzalka.test.ts`).
- **`dialog-exitplanmode-50kol-2.1.331.txt`** (reconstruction from a screenshot of a live failure in a 50-column
  pane, Claude Code 2.1.331; neutral plan text and plan file name): the question wraps after "ready to", so the
  signature sentence "Claude has written up a plan and is ready to execute" spans two lines, and the footer breaks
  after `~/.claude/plans/`. The lines from the dialog's top rule to the footer follow the screenshot; the status rule
  and the "Ready to code?" block with the plan frame above them follow `measured/exitplanmode-2.1.258.txt` at the
  narrower width. The plan signatures read the dialog region with its lines joined by a space, so the dialog keeps
  the name `ExitPlanMode`, the options of a wide pane and the plan file name from the footer
  (`server/test/parse-plan-dialog.test.ts`).
- **`dialog-askuserquestion-linia-nazwy{,-luka}-2.1.281.txt`** (captures, CLI 2.1.281): the session name line
  `──── pomiar-nazwy ─` (after `/rename pomiar-nazwy`) under the form footer. herdr detection rules below 2026.10.11.1
  take it for the last rule (`done` or `idle` instead of `blocked`), so Rarog falls back to `#formFallbackVerdict`;
  rules 2026.10.11.1 give `blocked` through `live_blocked_form_named_session` (`docs/dialogs.md`, "Dialog detection
  in herdr"). In `-luka` the name line sits 55 rows below the footer of a tall pane, so the form falls outside
  `DIALOG_TAIL_LINES`: a known limitation the test pins.

## Refusal captures: `dialog-bash-*`

A refusal dump is the diagnostic file Rarog writes to `<dataDir>/refusals/` when it cannot handle a dialog: a header
with metadata, then the pane screen.

- **`dialog-bash-*-2.1.29x.txt` with `*.command.json`** (refusal screens from incidents, next to the `Bash` command
  from the transcript, `{ toolName, command }`): the anonymization keeps length (owner login → `jkowals`), because
  the `commandMatches` tests check wrapping inside the frame. `-uciety-naglowek-2.1.294` starts inside the frame,
  above the auto-deny counter; `-stechly-read-2.1.295` and `-stechly-read-szeroki-2.1.295` show a full `Bash`
  dialog while the transcript still shows a pending `Read`: the follower (`server/src/herdr/jsonl-follow.ts`, the
  incremental transcript reader) skipped the growth that held its result, because it exceeded the read cap
  `FOLLOW_MAX_READ_BYTES`. `zgoda-bash-wysoka-2.1.295.command.json` belongs to
  `measured/zgoda-bash-wysoka-2.1.295.txt`.
- **`dialog-bash-subagent-naglowek-2.1.302`** (reconstruction of a CLI 2.1.300 refusal with neutral content):
  a subagent's whole `Bash` dialog under scrollback with the main agent's running command, whose transcript entry is
  newer than the hook dump (the pending tool call that the hook `scripts/hooks/rarog-pending.mjs` writes to
  `<dataDir>/pending/`; `docs/dialogs.md`, "Sources"). The card source is chosen by the screen: the older `Bash`
  hook dump wins over the transcript entry (`olderBashHook`) only when the entry does not fit the screen and the
  screen shows the dialog title and the whole command frame, equal to the dump's command.
- **`dialog-bash-kolejka-licznik-2.1.319`** (capture of a live pane; the prompt is a placeholder): a main thread
  `Bash` dialog in default mode on top of a queue of two read-only commands run at once ("Bash command … 1 of 2"),
  with no `Ask rule` line. `.command.json` is the request on top. The title with a counter is not in the title map,
  so the block has no tool name.
- **`dialog-bash-cytat-2.1.321`** (capture of a live pane, cut below the conversation): a main thread `Bash`
  dialog outside the sandbox raised by an `ask` rule, for a command with `"$(…)"`. The zone under the frame starts
  with "Quoted text in this command can't be checked before it runs" above the `Ask rule` line and its hint.
  `.command.json` is the request.
- **`dialog-bash-licznik-block-2.1.316`** (reconstruction: dialog chrome copied by script from a refusal screen,
  command and scrollback neutral): the 2.1.316 auto-deny counter ("…block this request in 1:38, to avoid holding up
  an unattended session") under a "Dangerous rm operation" warning. Tests swap the counter value; the card
  fingerprint stays.
- **`dialog-bash-opis-telefon-2.1.302`, `dialog-bash-subagent-telefon-2.1.302`**: the source of the phone constants
  of the tall dialog guard (`scripts/hooks/tall-dialog.mjs`), recomputed by
  `server/test/dialog-guard.test.ts`. The first is a capture of a 62-column pane (19 rows: chrome 13,
  description 3, command 3); the second reconstructs a 48-row refusal at that width, wrapped by the guard module in
  `cli` mode.
- **`dialog-bash-subagent-uciety-62x29-2.1.309`, `dialog-session-paused-2.1.309`,
  `dialog-background-work-exit-2.1.309`**: dialogs the phone does not handle
  (`server/test/dialogs-unhandled.test.ts`); pause and exit are confirmation cards from
  `TERMINAL_DIALOGS` (`server/src/herdr/dialogs/policy/terminal.ts`) with every option `terminalOnly`. The first
  is a refusal capture whose pane had 63 columns, not the 62 of the name (`pane-guard.test.ts` uses it on pane
  geometry); its command (`.command.json`, the same text in the frame) is synthetic, every word as long as the
  original, so it wraps the same; the other two are reconstructions with the dialog region copied literally from
  refusal screens.

## `refusals/`: whole refusal dumps

Eight whole dumps: a `key: value` header (`renderDump` in `server/src/herdr/dialogs/refusals.ts`), a separator line
and the screen. The header carries what the screen lacks: `reason`, card `source` (`screen`, `hook` or `jsonl`),
hook dump metadata, `reqId`, shape (`optionCount`, `mismatchReason`) and pane height (`paneRows`).
`server/test/dialogs-refusal-dumps.test.ts` compares the parser
and decision result with it, and `dialogs-block-on-card.test.ts` pins the block shown on a card without
buttons. The copies carry the email and session placeholders; a one-off script removed the trailing `\n` that
`renderDump` appends, then `scripts/anonymize-fixture.ts --out` ran.

- `widok-skills`, `widok-help`, `widok-status` (2.1.310): slash command views during a block, without digits,
  reason `unreadable`. `widok-status-stechly-zrzut` sits next to a hook dump for a request no longer on screen.
- `zaufanie-bez-cyfr-2.1.311`: the folder trust dialog without digits, reason `unreadable`.
- `zgoda-edit-uciety-naglowek-63x28` (reconstruction): an `Edit` permission with the title above the screen edge;
  result `mismatch`, reason `tool-name`.
- `powloka-zawiniete-polecenie`, `powloka-komunikat-przed-promptem` (`mode-unknown`): the mode check before a send
  (`ensureFreshMode` in `server/src/herdr/supervisor.ts`, which reads the mode footer on demand) read a shell with
  `claude --session-id …` typed, before the CLI started, so there was no footer.

## `measured/`: dialog measurement

The dialog measurement asks the model for each dialog type on a closed list in its own herdr tab, saves
`herdr agent read --source visible`, dismisses the dialog with `Esc` and closes the tab. It runs by hand after every
Claude Code update (`docs/dialogs.md`, "After a Claude Code update"). Each capture lives in two files:
`<type>-<CLI version>.txt` archives the version, and `<type>.txt` is a copy that `git diff` compares across updates
(the versioned name would show only an add and a delete). A changed `<type>.txt` means a review of
`SCREEN_SIGNATURES` in `server/src/herdr/dialogs/screen/signatures.ts`; a missing file means this CLI version could
not raise the dialog, and the measurement fails.

Before the final pass the measurement writes the measurement directory as `/Users/u/projekt` and `$HOME` as
`/Users/u`, and blanks what changes on every run: the status line under a reply (a random verb and a wall clock) and
the random plan file name (`~/.claude/plans/<plan>.md`). No screen signature rests on either. Without the private
literals file it refuses before opening a tab.

The types are `pytanie-jednokrotne`, `pytanie-preview`, `wielopytaniowy-jednokrotne`, `multiselect`,
`wielopytaniowy-multiselect` (and `-zakladka2` after one `Tab`, with both multi-select signals), `zgoda-bash`,
`zgoda-bash-wysoka`, `zgoda-edit`, `zgoda-write`, `zgoda-mcp`, `zgoda-siec`, `exitplanmode` and
`exitplanmode-bez-planu`. `zgoda-bash` reads `Bash command (unsandboxed)`: with the sandbox an ordinary `echo` runs
without asking, so only a command the sandbox would not run raises the dialog. `zgoda-bash-wysoka` (CLI 2.1.295) has
a 92-line command in a 28×63 pane: the screen starts inside the frame, and the CLI does not truncate the command
(`docs/dialogs.md`, "Known gaps"). The captures have no mode footer, because a pane with an open dialog does not draw
it. The CLI 2.1.328 set (the `<type>.txt` copies hold it) comes from a wide pane: 113 columns for the first three
types (`pytanie-jednokrotne`, `multiselect`, `wielopytaniowy-jednokrotne`), 128 for the rest. On CLI 2.1.328
`zgoda-bash` has no "always allow access to <directory> from this project" option (the CLI 2.1.293 capture has it)
and draws a barred sentence about the path outside the working directories above its question, and
`zgoda-bash-wysoka` draws `↑ <N> more lines` under its options. Captures taken by hand on the same procedure:

- `measured/zgoda-*-2.1.311.txt` (eleven files, 26×60 panes named `-waski-` and 63×28 panes, no `<type>.txt`): the
  `WebFetch`, `WebSearch`, `NotebookEdit` and `Skill` permissions an `ask` rule raises, and `Bash` commands with a
  `─` rule in the description or the command string, behind the `│` bar. A path broken under `$TMPDIR` carries
  a hand-inserted `/tmp/claude-uid`, because the pass does not join lines.
- `picker-effort-2.1.312-26kol`, `picker-model-2.1.312-26kol`: `/effort` is a slider without digits (the card shows
  a snippet titled "Effort"), `/model` a `1.`–`7.` list with a `↓` indicator (kind `other`, a card without buttons);
  both block top rules are bare, also with `--effort medium`. Tests: `dialogs-block-fingerprint.test.ts`,
  `dialogs-block-on-card.test.ts`, `dialogs-splitter.test.ts`,
  `dialogs-block.test.ts`.

## `kontrolny/`: control set of dialog blocks

Dialog block shapes from the live CLI (Claude Code 2.1.314 to 2.1.332) and `manifest.json`, which describes each
shape, plus three captures outside the directory (the pickers in `measured/` and
`refusals/zaufanie-bez-cyfr-2.1.311.txt`); fields: `docs/dialogs.md`, "Control set". The measurement session had
its own `HOME` and config directory and a fake API for the model, so the account is an API key
(`API Usage Billing`). The fake API answers a prompt marked `ZESTAW-KONTROLNY-FORMULARZ` with a fixed `AskUserQuestion`
and any other prompt with `ok` (except the `Bash` marker of the ultracode measurement). Shapes: the trust dialog
(also after `down`, with `❯` on "Yes, I trust this folder"), `/usage`, a question form, the `/model` picker,
"Switch model?" (also after `/model <alias>`, under rules with and without the effort indicator), the `/effort`
slider (also with ultracode on and right after `/effort status`), the start dialog of
`--permission-mode bypassPermissions` and the start dialog "Allow external CLAUDE.md file imports?"
(`importy-zewnetrzne-…`: the project memory file imports `../shared/notes.md`; also after `down`, with a list of
15 imports in a low pane, and after the trust dialog of a project without trust; each dismissed with `Esc`). The
`zgoda-bash-…` and `zgoda-edit-…` captures are consent dialogs (Claude
Code 2.1.319, 2.1.321 and 2.1.328, 119-column pane; the `zgoda-bash-dangerous-rm-sredni-…`, `-telefon-…` and
`-waski-…` captures 99, 62 and 57 columns) from a session on a separate herdr server: the fake API answers the marked
prompt with fixed tool calls (the commands of the root `*.command.json` files, or a harmless command with the same
syntax), the session runs in `default` or `auto` permission mode with `ask` rules in its own `--settings` file
(in the `-user`, `-project` and `-local` captures in the user's, the project's or the local project settings
instead), and each dialog is dismissed with `Esc`. The `zgoda-mcp-interakcja-…` and `zgoda-siec-…` captures (Claude
Code 2.1.322, 127-column pane, a subscription account) come from the consent measurement: the dialog of an MCP tool with
`requiresUserInteraction` from a local stdio server, and the sandbox network dialog of a `curl` run in the sandbox.
The `zatwierdzenie-workflow-…` captures (Claude Code 2.1.322, a separate herdr server, a session with `--effort
ultracode`) are the workflow approval dialog "Run a dynamic workflow?": the fake API answers the marked prompt with
one `Workflow` call, and each dialog is dismissed with `Esc`. Variants: the phase summary in a 119-column pane and in
a 57-column pane (`-waski`), the raw script view after `2` (`-skrypt`) and the `auto` mode variant without digits
shown when the fake API does not pass the safety check (`-auto-bez-kontroli`; its text holds the run's local port).
The `zgoda-edit-wrap-…` and `zgoda-write-wrap-…` captures (Claude Code 2.1.330, `default` mode, the pane width
before the version: 57, 99 or 119 columns) are `Edit` and `Write` "Create file" dialogs whose frame wraps file lines
longer than the frame. Before the session the measurement writes the file to edit (in `-claude-md-` the
`.claude/CLAUDE.md` of the session's own `HOME`, with a `Read` allow rule so that only the `Edit` asks), and
`<capture>.input.json` next to each capture holds the exact tool input (`toolName`, `input`), the session directory
(`cwd`) and the seeded files (`seeded`, path and content), with the repository paths `/Users/u/projekt` and
`/Users/u`. The content is synthetic: letters `a` to `z` in order, so a column can be counted, and one English
sentence. Geometry on 2.1.330, with C the pane width (the dialog rule) and d the digits of the largest line number
in the frame: a file line breaks hard at the content width W, also inside a word; a continuation row has a blank
number field and the same marker; content starts at column d + 4; W = C − 3 − d for `Edit` and W = C − 4 − d for
`Write`. A space at column W is a blank cell at the row end, which the read drops (a row of W − 1); a space at
W + 1 is a leading space of the continuation. A no-break space at W looks like a space at W, and a wide character
with one free cell moves to the continuation and leaves a row of W − 1. Variants by name: `space-w`,
`space-after`, `space-both` (a space at W, at W + 1, at both), `nbsp`, `wide` (U+6F22), `ideo` (U+3000), `nfd`
(`e` and U+0301 at W), `zwsp` (U+200B after column W, shown as U+FFFD), `polish` (Polish letters in NFC across
the boundary), `tab`, `digits` (a continuation that starts with `42 -x`, `42 x` in `Write`), `fake-frame` (a frame
rule and a dialog title inside a wrapped line), `change` (a wrapped `-`/`+` pair), `hunks` (`replace_all` with two
places: one hunk and the note "The diff doesn't show all of what this edit changes"), `line10` and `line100`
(number fields of two and three digits across 9 → 10 and 99 → 100), `geo` (a line over three rows and an English
sentence).
Each frame has a row of full width W.
The `zgoda-bez-hooka-…` captures (Claude Code 2.1.330, 119-column pane) are consent dialogs from a session whose own
`HOME` has Rarog's `PermissionRequest` hook installed, next to a logging probe in the same settings file, with a
separate Rarog server in mode `all` and hook status `ok`; `<capture>.input.json` holds the tool input as above, and
each dialog is dismissed with `Esc`. `bash-control` is a `Bash` dialog with the hook running; `bash-hooks-off` is the
same dialog with `disableAllHooks: true` in the project's `.claude/settings.local.json`, where neither the hook nor
the probe runs. `claude-md-default` edits the `.claude/CLAUDE.md` of the session's own `HOME` (option 2 allows edits
in the `~/.claude` folder for the session), and in `-link` the user `settings.json` is a symbolic link to a file
outside `~/.claude`. `edit-relative` edits `notes.txt` in the session directory; `edit-relative-cd` edits
`sub/notes.txt` after `cd sub` in `Bash`, so the dialog shows `notes.txt`, while the `cwd` field of its
`.input.json` stays the session directory. `claude-md-auto` and `claude-md-auto-link` are the same edit in `auto`
mode. The fake API does not pass the auto mode safety check, so the dialog "Auto mode can't check actions in this
session" comes first; after Enter on it ("stay in auto mode") this consent dialog follows, with "No" (focused) and
"Yes" and no digits, and the hook does not run. Per the Claude Code documentation ("Protected paths"), in `auto` mode
with a working safety check this write goes to the classifier, which decides whether the dialog appears at all. The
text above the dialog holds the run's local port.
`settings-target-auto` edits, also in `auto` mode, the target of that symbolic link, `~/dotfiles/settings.json` in the
session's own `HOME`; there no "Auto mode can't check" dialog comes first, the consent dialog with digits appears at
once (option 2 allows access to the target's folder for the session), and the hook runs.
Shapes that never appeared stand under `missing` ("Change effort level?", a start dialog of `--permission-mode auto`
and the auto-deny countdown, which the fake API cannot raise). The manifest has no `provenance.json` entry. Test:
`dialogs-control-set.test.ts`.

## `ultracode/`: captures and transcript excerpts with ultracode

ultracode is the Claude Code effort level that `--effort ultracode` and `/effort ultracode` turn on. The ultracode
measurement writes these files in the isolation of `kontrolny/`. Captures from Claude Code 2.1.317 without a dialog
block: `start-ultracode` (the `──── ultracode ─` label above the prompt field), `wynik-effort-ultracode` and
`-off` (for the `ultracodeEcho` and `ultracodeInlineResult` signatures), `rename-ultracode`, `zgoda-bash-ultracode`
and `start-ultracode-niedostepny` (`CLAUDE_CODE_DISABLE_WORKFLOWS=1`). Transcript excerpts from 2.1.318 keep the
fields the server reads and the `ultra_effort_*` attachments in full; prompts and replies get a placeholder, times
are shifted to a fixed start, and `_pomiar` lines mark what was sent. They cover a start with the flag, `/effort
ultracode` and `off` while idle and during a turn, `/clear`, disabled workflows, and a resume with and without the
flag: `ultra_effort_enter` and `ultra_effort_exit` appear only in the first turn after a change. Tests:
`ultracode-dumps.test.ts`, `server/test/ultracode.test.ts` (`createUltracodeTracker`),
`herdr-jsonl-pending.test.ts` (`resumeSettingsFrom`), `transcript-import.test.ts` and
`server/test/herdr-driver.test.ts`, "sendCommands — ultracode".

## `restart/`: exit dialog variants for the session restart

Synthetic screens for the session restart that meets the exit dialog after `/exit`, kept out of the root and of
`kontrolny/`, so the card corpora do not read them. `wyjscie-tlo-harmonogram-2.1.322.txt` is
`kontrolny/wyjscie-tlo-2.1.322.txt` with a scheduled task in place of its one task line, cut with `…` the way the
CLI cuts it (`scheduled task · Runs once in 3d · Check the build…`); the rest of the screen is the capture byte for
byte. Tests: `server/test/restart-zadania-wyjscia.test.ts`.

## Golden files: `karty-korpusu.json`, `karty-korpusu-pelne.json`

- **`karty-korpusu.json`**: the cards with buttons that the card decision (`decideCard`) offers for every corpus
  screen (`.txt` here, in `measured/` and `refusals/`) when it sees only the screen, with no transcript entry and no
  hook dump; each card with `reqId` and options. It pins the buttons the
  block fingerprint (`bodyPrint`) leaves unchanged. `server/test/dialogs-block-fingerprint.test.ts` writes it
  with `RAROG_FIXTURES_WRITE=1` and otherwise compares; it masks the macOS temp directory in labels
  (`/var/<folders>/`), so the file does not raise the `server/test/private-patterns-guard.test.ts` ratchet.
- **`karty-korpusu-pelne.json`**: the evaluation of every corpus screen (also `queue/measured/` and `kontrolny/`) as
  hashes and metadata. Its `context` header records the evaluation context: `RAROG_DIALOG_LAYER2=0` (`layer2: 0`),
  the hook consent channel off (`consentChannel: "off"`), `cliDialogClass: null`, no hook dump, no transcript entry.
  `server/test/dialogs-full-cards.test.ts` writes it the same way.
- **`karty-korpusu-warstwa2.json`**: the same corpus as hashes and metadata with the layer 2 flag on
  (`RAROG_DIALOG_LAYER2=1`), where a layer 2 verdict with choices replaces today's card;
  `server/test/dialogi-warstwa2-karty-korpusu.test.ts` writes it the same way.
- **`warstwa2-prawda.json`** (hand-written, not produced by code): the layer 2 ground truth for every `.txt` screen of
  the corpus (category, CLI class, expected layer 2 verdict, digit pairs read off the screen), checked against the
  screens by `server/test/dialogi-warstwa2-prawda.test.ts`.

## Transcripts: `transcript-*.jsonl`

- **`transcript-sample.jsonl`** (excerpt from this repo): 30 lines of a spike session's
  `~/.claude/projects/<slug>/<uuid>.jsonl`, strings at most 400 characters, image data a 1×1 PNG.
  `parseTranscriptTail` turns it into 7 messages. It covers `tool_use` with its `tool_result`, an interruption (its
  marker is not a message), an `image` block (`[obraz]`), `isMeta` and entry types the follower must ignore. Its IDs
  match
  `transcript-pending.jsonl` (`TOOL_ID` in `server/test/herdr-jsonl-pending.test.ts`).
- **`transcript-pending.jsonl`** (excerpt): the first 11 lines of `transcript-sample.jsonl`, ending with an unpaired
  `tool_use` (`AskUserQuestion`) and five plumbing entries. That shape is the only transcript signal that the agent
  waits; `working` vs `blocked` comes from herdr.
- **`transcript-usage.jsonl`** (excerpt from this repo: real usage numbers, swapped content): 8 `assistant`
  entries with rising usage up to 462,682, a `compact_boundary` whose `preTokens` equals that sum, and one entry
  at 14,002 after compaction. So the transcript formula equals `extractUsage` of the sdk driver, and the counter is
  not monotonic.
  `compactMetadata.trigger` is `"auto"` here (`"manual"` in the source). No boundary confirms the window limit: an
  automatic boundary's `preTokens` is a threshold setting (Claude Code docs `model-config.md`, "Default auto-compact
  thresholds") and only raises the lower bound (`atLeast`).
- **`transcript-foreign-cwd.jsonl`** (synthetic file): two turns with a `cwd` outside Rarog's roots, for
  `#assertResumable`. `--resume` of a UUID from another directory works and appends to the original slug, so without
  the `cwd` check one POST field would stream a foreign project's history to the phone. The test expects 400 and no
  herdr call.

## `tasks/measured/`, `queue/measured/`, `artifacts/measured/`: transcript measurements

These measurements write trimmed JSONL lines, not screens. Each scenario lives in two files, as dialog captures do:
`<scenario>-<CLI version>.jsonl` (the archive) and `<scenario>.jsonl` (the `git diff` reference). Keys with an
underscore (`_plik`, `_klucze`, `_pomiar`) come from the measurement; the rest are CLI fields.
`server/test/herdr-background-fixtures.test.ts` requires every literal of the `CLI_SHAPES` registry to hit one of
these fixtures or a test sample.

- **`tasks/measured/`** (CLI 2.1.296): background task scenarios run in the measurement's own tab: `postoj` (a
  subagent waiting for its own command), `wznowienie` (a `SendMessage` resume), `taskoutput-w-postoju` (with a marker
  that this CLI has no `TaskOutput` tool) and `resume-cli` (`/exit` with "Exit and stop tasks", then
  `claude --resume`; the only scenario that approves a dialog, with `1`, when it lists only its own `sleep 307`).
  Procedure, line format and normalization: `docs/background-tasks.md`, "After a Claude Code update" and
  "Measurement fixtures".
- **`queue/measured/`** (CLI 2.1.299 and 2.1.328; the reference files `<scenario>.jsonl` hold 2.1.328): prompts
  sent during agent work the way Rarog sends them (`agent prompt`, keys
  only `esc`): `wchloniecie` (absorbed mid-turn), `dequeue`, `dwa-naraz` (two prompts, one turn), `esc-nad-kolejka`
  and `esc-w-tekscie` (Esc with a queued prompt), `kolejka-przed-startem` and `compact` (a prompt during `/compact`).
  A scenario not measured has no file. Literal text is only a measurement prompt, the CLI's interruption sentence and
  bare slash command wrappers; times are consecutive seconds in the order of the real times. The screen snippets
  `<scenario>-przed-esc-<CLI version>.txt` and `-po-esc-` are versioned only, because they hold a spinner word and
  the hour. Procedure: `docs/dialogs.md`, "After a Claude Code update"; results: `docs/architecture.md`, item Prompt
  absorbed into a running turn.
- **`queue/measured/zabranie*`** (CLI 2.1.328): taking queued prompts back into the prompt field with `up`. The
  measurement pastes its own queued prompts the way Rarog does (paste, a field read, then a separate Enter) in a
  26-column pane split off its own tab; the `-szeroki` scenarios run in the tab's wider root pane. Keys are only `esc`,
  `up`, `down` and `ctrl+u`, never Enter or a digit in a dialog or a form, which Esc rejects. Scenarios: `zabranie`
  and `zabranie-szeroki` (two queued prompts, `up`, `ctrl+u` until the field is empty), `zabranie-meldunek` (a
  background task notification and a prompt in the queue), `zabranie-historia` and `zabranie-historia-szeroki` (`up`
  on an empty queue, then `down`), `zabranie-dialog` and `zabranie-formularz` (the three keys while a permission
  dialog or an AskUserQuestion form stands), `zabranie-wyscig-wynik` and `zabranie-wyscig-koniec` (`up` right after a
  tool result and right after the closing answer of a turn), `zabranie-dlugie` (queued prompts taller than the
  screen), `zabranie-wklejka` and `zabranie-wklejka-szeroki` (a pasted 12-line text in the queue, `up`, then `ctrl+u`
  with a snippet after 1, 2, 4… presses and after the last one). The last line, `_pomiar: obserwacje`, holds what
  the script saw on screen: the field frame width, the field read code, the history header, the number of `ctrl+u`
  presses. Screen snippets `<scenario>-<moment>-<CLI version>.txt` are versioned only; a dialog snippet after a key
  is written only when the screen changed. The prompt history is shared by the working directory, so a history entry
  stays in a snippet only when it is a measurement prompt; otherwise one placeholder line replaces it.
- **`artifacts/measured/`** (CLI 2.1.273 to 2.1.301, named 2.1.301): no session, the measurement reads main
  transcript files of the last 30 days in `~/.claude/projects`. `publikacje.jsonl` holds the `Artifact` tool result
  shapes, `meldunki.jsonl` the carriers and variants of the artifact watch notification. Every URL and title is one
  placeholder; times are consecutive seconds from midnight UTC on 1 January 2026. Details: `docs/artifacts.md`,
  "After a Claude Code update".
- **`scheduled/measured/`** (CLI 2.1.329): the session's scheduled tasks, excerpts taken by hand from a live
  measurement in an own herdr tab, one file per conversation: `recurring-one-shot-compact` (a recurring and a one-shot
  task, their runs, `CronList`, `/compact`, then `--resume`), `after-clear` (the file `/clear` opens, starting with
  the carry of the armed task), `exit-resume` (`/exit` with "Exit and stop tasks", resume, a closed pane, `/compact`),
  `resume-missed-one-shot` (a one-shot due while the process was down, then one still ahead; a pending
  `ScheduleWakeup`) and `loop-wakeup-carry` (`/loop 5m`, a `ScheduleWakeup` run, a carry with two tasks). Lines are
  the CLI's own; the extract dropped the working directory, branch, usage and cost keys, and in the last two files
  strings over 300 characters are cut. Times and epoch values stay as measured. A `_pomiar: process-start` line marks where a new
  Claude Code process of the conversation started (`startedAt` from Claude Code's process registry). Read by
  `server/test/scheduled-tasks.test.ts`.

## `commands/`: slash command evidence

Results and procedure: `docs/slash-commands.md`.

- **`measured/catalog-2.1.302.json`**: the session's `$.command.list()` at start (names, sources, plugins, no
  descriptions). Client names in skill and plugin names are placeholders, and a client plugin's skills are numbered
  over the sorted set of its skill names (`<placeholder>:skill-01`…), so the same set gives the same numbers everywhere;
  `skillSets` holds an HMAC fingerprint of each set (`docs/slash-commands.md`, step 1). A `<placeholder>:<skill>` name
  without a number fails the write. In the committed `catalog-2.1.302.json` and `live-2.1.310.json` the client plugin
  is renamed to `demo` (`demo:skill-NN`, the `skillSets` key too) and the user's own skills to `user-skill-01`…`28` in
  name order, by hand after the write: counts, order and numbers are unchanged.
- **Transcript excerpts taken by hand** in an own herdr tab (text only through `herdr agent prompt`, keys only
  `esc`), in `measured/`: `config-plugin-cd-2.1.302.jsonl`, `nieznane-sciezki-plan-context-2.1.302.jsonl`,
  `kandydaci-allow-listy-2.1.302.jsonl`, `rename-clear-2.1.302.jsonl` (a new `sessionId` after `/clear`) and
  `skill-doctor-2.1.294.jsonl` (the built-in `/doctor` from the keyboard: `origin: human` and an `isMeta` skill entry
  with `turnCompanion: true`). `_pomiar` lines mark what was sent and what was on screen. IDs become
  `00000000-0000-4000-8000-0000000000NN` in order of first appearance; times and SGR are unchanged.
- **`measured/rename-custom-title-2.1.319.jsonl`**: a synthetic transcript with two `/rename` calls, each with its
  `system/local_command` pair, a `custom-title` and an `agent-name` entry. The entry shapes (keys, types and order)
  come from CLI 2.1.311–2.1.319 transcripts, the values are made up. Read by the session name tests in
  `server/test/herdr-jsonl-follow.test.ts`.
- **`measured/rename-in-turn-2.1.325.jsonl`**: a synthetic transcript of `/rename demo-csv` sent while a Bash call
  runs: `custom-title` and `agent-name` between the tool call and its result, no `system/local_command` entry, the
  `isMeta` reminder written at the end of the turn with the time of the rename, then the repeated name entries. Entry
  kinds, their order and the times come from a CLI 2.1.325 measurement, the values are made up. Evidence of the
  registry's `inTurn` rule, read by `server/test/turn-guard.test.ts`.
- **`measured/prompt-block-<scenario>-2.1.303.jsonl`**: a prompt blocked by a `UserPromptSubmit` hook
  (`docs/dialogs.md`, "Prompt blocked by a hook"); the block entry keeps `content` literally, the rest is trimmed as
  in `queue/measured/`. `prompt-block-prawdziwy-2.1.302.jsonl` is a reconstruction of one real block entry with a
  synthetic hook path and reason; its fields and their shape are as the CLI wrote them.
- **`measured/live-2.1.310.json`**: the live slash command measurement (`docs/slash-commands.md`, "After a Claude
  Code update"): every trial with menu rows, hook events, CLI registry state and new transcript entry kinds, no
  conversation content; client skills carry the catalog numbers.
- **`measured/ultracode-2.1.318.json`**: the hand-assembled evidence for ultracode words (docs facts with URL and
  fetch date, measured words with the excerpts that hold them), guarded by `server/test/ultracode-boundary.test.ts`.
- **`docs/commands.json`**: facts from the "All commands" table of `code.claude.com/docs/en/commands.md` with
  URL and fetch date, no documentation text.

`server/test/herdr-commands-boundary.test.ts` requires each marker, field and fact of the command registry to stand
in these files or on a closed exception list (`EVIDENCE`); `server/test/herdr-fixtures.test.ts` checks anonymization.

## Incident extracts in `tasks/`

Both are one-off extracts from real sessions in the owner's transcript files, trimmed by the rules of
`tasks/measured/`; no extraction tool is in the repo, and the measurement does not touch them. Times, line order,
agent and task IDs, statuses and `<note>` additions are real, because the tests rest on them. Prompts, task
descriptions and commands get the placeholders above; `<result>` and `<event>` get neutral text with the notification
number (equal across copies of one notification), tool call IDs `toolu_NNN`, paths `/Users/u/projekt`, session IDs
zeros.

- **`tasks/incydent-postoj-agenta-2.1.295.jsonl`** (CLI 2.1.295): 244 task lines of a main file whose subagent stood
  in standby again and again waiting for its own background command; `server/test/herdr-jsonl-tasks-incydent.test.ts`
  replays it. Covered: three copy layouts of a task notification, an attachment with the first copy's time after
  newer entries, 13 standbys within 6 minutes, a resume after the end and agents started before the extract. Not
  covered: a copy after a resume of the same agent, an older notification after a newer one, an orphan after a CLI
  restart and the subagent file.
- **`tasks/incydent-gotowe-po-postoju-2.1.301/`** (CLI 2.1.301): a main file (`glowny.jsonl`) and 16 subagent files
  in which a turn after only a subagent's standby releases stale `done` pushes;
  `server/test/notify-incydent-gotowe-po-postoju.test.ts` replays it against `docs/background-tasks.md`,
  "Standby-only turn: no `done` push". It keeps everything the task reducer and the turn accounting read; the subagent
  files add content-free time entries next to gaps over 20 s, so each wake keeps its exact time. Not covered: the
  follower, the manager and the herdr grace period.

A reconstruction sits next to them:

- **`tasks/endless-wait-loop-2.1.332/`** (reconstruction, neutral content, line shapes copied from
  `tasks/measured/postoj-2.1.296.jsonl`): a main file (`main.jsonl`) and one subagent file. The subagent starts its
  tests in the shell background, then waits on them with `until ! pgrep -f 'vitest run'; do sleep 30; done` as its own
  background command, and stops in standby about ten minutes after its start. The loop never ends, because `pgrep -f` also matches
  the loop's own shell, so no end of the command ever reaches either file.
  `server/test/herdr-background-merge-wait.test.ts` replays it against `docs/subagent-long-wait.md`, "Stage and clock":
  the wait stage goes `short`, `long`, `stuck` on the clock from the standby, and the agent never goes dormant. Not
  covered: a wake, a second standby and the follower.

## Files without their own section

All are manual captures: a **work capture** is a pane from real work (content from the Rarog repo or from a client
project under a placeholder), a **test capture** a session with a test prompt.

- **`composer-empty-2.1.258.ansi.txt`, `composer-ghost-suggestion-2.1.258.ansi.txt`** (work captures with
  SGR): an empty prompt field and a dimmed CLI suggestion in it; both are `empty`, because field state goes by
  attribute, not by characters. `server/test/herdr-composer.test.ts`.
- **`composer-region-{empty,leading-blank,one-line,wrapped}-2.1.283.ansi.txt`** (test capture): the whole prompt
  field with SGR, for `composerRegionState` and `composerRegionText`. `herdr-composer.test.ts`.
- **`dialog-askuserquestion-2126.txt`** (test capture, CLI 2.1.246): a one-question form with option descriptions,
  `4. Type something.` and `5. Chat about this` behind a rule, and a footer without `n to add notes`; a digit
  submits, and markers count only in the region footer. `dialog-askuserquestion-multi.txt` copies its banner and
  prompt echo. `herdr-screen.test.ts`, `dialogs-block.test.ts`, `dialogs-splitter.test.ts`.
- **`dialog-askuserquestion-notes.txt`** (test capture): a form in note editing mode, where a digit types as
  text (signature: `ctrl+g` in the footer). `herdr-screen.test.ts`, `form-submit.test.ts`.
- **`dialog-askuserquestion-preview.txt`** (test capture): a form with a preview column, where a label read to
  the end of the line picks up preview text; only `enter` after verification approves. `herdr-screen.test.ts`,
  `herdr-driver.test.ts`, `form-submit.test.ts`.
- **`dialog-automode-teach-2.1.258.txt`** (work capture): "Teach auto mode about your environment?" with the
  pane `idle`, which herdr does not see; Rarog offers a card without approval and holds sends.
  `herdr-screen.test.ts` (`standingConsentDialog`), `herdr-driver.test.ts`, `herdr-supervisor.test.ts`.
- **`dialog-permission-odczyt-z-projektu.txt`, `dialog-permission-odczyt-z-projektu-waski.txt`** (test
  capture): the option "Yes, allow reading from ... from this project", wide and at 63 columns (wrapped over
  three lines). `read-label-from-project.test.ts`.
- **`dialog-permission-opis.txt`** (work capture): a `Bash` permission with a call description below the
  command. `herdr-screen.test.ts`.
- **`dialog-permission-read-2.1.278.txt`** (test capture): a `Read` permission (header "Read file", a
  `Read(...)` line without a bullet). `herdr-screen.test.ts`, `read-label-from-project.test.ts`,
  `dialogs-subagent-consent.test.ts`.
- **`dialog-permission-unsandboxed.txt`** (test capture, CLI 2.1.246): a retry outside the sandbox, header
  `Bash command (unsandboxed)` without a `⏺ Bash(...)` line. `herdr-screen.test.ts`.
- **`dialog-resume-summary-2.1.258.txt`** (test capture): `claude --resume` of a large session offers resuming
  from a summary or the full session; an ordinary CLI confirmation, not a pause. `herdr-screen.test.ts`,
  `dialogs-unhandled.test.ts`.
- **`ekran-login-2.1.293.txt`** (test capture): the `/login` screen, without a mode footer and options.
  `dialogs-consents.test.ts`, `herdr-driver.test.ts`.
- **`model-set-inline-2.1.258.txt`** (reconstruction of a work capture; synthetic reply text, path and session name, the numbered list
  and its wrap kept): the `/model` result printed in place (`⎿ Set model to ...`) below a list in the agent's reply.
  `herdr-driver.test.ts`.
