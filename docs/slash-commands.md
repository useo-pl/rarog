# Claude Code slash commands in Rarog

What Rarog knows about Claude Code's `/` commands (built-in commands, skills, plugin commands), where that knowledge
comes from, what happens to a command sent from the phone, and how the command shows in the transcript.

**In short.** From the phone, Rarog lets through only the commands in the session catalog: the set of commands Rarog
allows for one session, computed from the pane's directory and the session's CLI version. The catalog holds an
allow-list of built-in commands and skills from the Claude Code 2.1.302 command catalog, plus skills and commands from
disk in a narrow subset of sources. Any other command gets an explicit 400 refusal with its name and a hint, and a
`refuse` entry in `herdr-audit.log`. The code lives in `server/src/herdr/commands/`. Every fact in its CLI literal
registry (`registry.ts`) carries evidence with a version and a date: the docs, the command catalog that a measurement
mod (the probe) reads inside a running session, or a live measurement. The app gets the list of what will pass from
`GET /api/sessions/:id/commands` and suggests it after `/`. In the app's transcript a local command shows as `system`
notices and a prompt-type command as a human message, live and after a server restart.

## What Rarog does with a command

- **Text guard** (`guard.ts`, `assertSendable`): checks the size, the `!` prefix (shell mode), the command against the
  session catalog and the pane mode, then sanitizes the text and repeats the prefix and command checks on the result
  (`<ESC>/usa` fails). Sanitizing drops control bytes and trailing whitespace and backslashes: a backslash right
  before the Enter would add a new line in Claude Code instead of submitting (multiline input, per the
  documentation). It returns the sanitized text and the command the text invokes (`slash`), or throws
  `HerdrCommandRefusedError` with a message for the human and only the token for the log. The internal path
  (`internalCommand`: `/model` and `/effort` from the model endpoint `POST /api/sessions/:id/model`) does not read the
  catalog. It accepts only `/model` or `/effort` with at most one value without spaces (`/model opus[1m]`,
  `/effort high`), or text exactly equal to one of the two ultracode forms (`ULTRACODE_COMMANDS`).
- **The rule** (`shape.ts`, `classifySlashText`) is Rarog's cautious model of the CLI, built from the measurements
  below and the docs (`commands.md`, intro and "How the command menu matches what you type"). A command stands at the
  start of the message, and the text after the name is its arguments. The `/` menu highlights a command in any case,
  also by alias, and Enter runs the highlighted prefix suggestion (live measurement, CLI 2.1.310). The first argument
  can redirect a command (`subcommands`), and an existing path is a prompt. Where the CLI behavior is unmeasured, Rarog
  refuses or takes the redirect target. The steps:
  0. the whole text (after `trim`, in any case) is an exit word from `EXIT_WORDS` (`exit`, `quit`, `:q`, `:q!`, `:wq`,
     `:wq!`) → refusal, because the CLI ends the process (live measurement of each word, 2.1.310);
  1. the first token does not start with `/` → prompt; a lone slash → refusal (Enter would run the first suggestion;
     unmeasured, caution);
  2. the lowercase name is in the catalog → command (`kind` `local` or `prompt`). A redirecting first argument, also
     with further arguments, gives the target when the target is in the catalog (`/design sync` → `/design-sync`),
     otherwise a refusal (`/code-review ultra` → `/ultrareview`, `/design login x` → `/design-login`);
  3. an alias → refusal that names the canonical command;
  4. a name outside Rarog's name shape (`^[A-Za-z0-9_][A-Za-z0-9:_-]*$`): a name with another slash after the leading
     one and without a colon → prompt (a path such as `/tmp/x.log`; every name with a slash in the skills docs
     table, "How a skill gets its command name", has a colon, e.g. `/apps/web:deploy`); otherwise → refusal (the
     skills docs, "Characters a skill name can’t hold", allow a dot, and how the CLI treats such a name is
     unmeasured);
  5. `/name` exists on disk (`statSync`) and is not a prefix of a known name or alias → prompt (`/tmp read the log`);
     when it is a prefix → refusal asking for a trailing slash (the CLI reads `/tmp/` as text);
  6. the rest → refusal with a hint ("Refusals and hints").
- **One classification per send.** The session manager (`sessions/manager.ts`) gets a catalog snapshot for the pane's
  `cwd` and its process's CLI version, calls the guard ONCE and passes the snapshot and the result to the driver in
  `SendOptions.command`. A new session's startup prompt passes the same gate before `launch()`, with the installed CLI
  version. The herdr driver (`drivers/herdr-driver.ts`, the part that types into the pane) never guesses a command
  from text. A `slash` send skips `wait` and the stall guard (the retry that can send a text a second time). Its
  `user` bubble enters the transcript at once and does not wait until the prompt shows in the transcript file
  (`defersEcho`), because the file records a command as `<command-name>`. The send also tells the turn watchdog that
  silence is a normal end for a command; the turn watchdog gives the prompt field back after
  `HERDR_TURN_WATCHDOG_MS` (15 s) with no file activity and the pane neither `working` nor `blocked`. A second guard
  in the driver classifies the text again from THE SAME snapshot; a mismatch with the manager is a refusal, and no byte
  reaches the pane. A caller that passes no classification (`SendOptions.command` absent) gets the driver's guard with
  a snapshot from `deps.commandCatalog` (or the registry alone); a driver built without a guard sends the text as a
  prompt, and its caller guarantees validation.
- **Refusal log.** A refusal writes `method: "refuse"`, `reason: "command-not-allowed"` and `command` with the token
  alone (`/usa`, `quit`) to `herdr-audit.log`, without the rest of the message. The herdr supervisor
  (`herdr/supervisor.ts`, `logCommandRefusal`) writes it for the manager, or the driver's guard does.

## Command in the transcript

Transcript import (`transcript-import.ts`) maps command entries with `transcript.ts`. The mapping is stateless: one
transcript file entry gives at most one message, because the follower (the reader that tails the transcript file)
reads in batches and the history can start anywhere. The one state across entries is the `fileEcho` pairing below,
which each reader runs over the entries in file order. The mapping runs AFTER the `isSidechain`, `isCompactSummary`
and `isMeta` filters, so the caveat (`<local-command-caveat>`), the `/context` Markdown and a skill body give nothing.
History on attach, live reading and history after a restart follow the same rules. Other `user` entries that start
with a CLI tag (`CLI_PLUMBING_TAGS`, e.g. `<system-reminder>`) and other `system` entries are not messages.

- **Local command call:** a `system` entry with subtype `local_command`, or a `user` entry with `<command-name>` whose
  name (or alias) has `kind: local|panel` in the registry → a `system` notice "/name args" (the name as recorded, the
  arguments without terminal sequences).
- **Output:** `<local-command-stdout>` or `<local-command-stderr>` with its closing tag → a separate `system` notice
  after `stripTerminalControl`, at most 8 kB of UTF-8 (`COMMAND_OUTPUT_MAX_BYTES`, the rest behind `✂ …`); an empty
  output (`/clear`) → nothing.
- **Prompt-type command call** (bundled skill, `/init`, `/insights`, skill from disk, plugin command) → a `user`
  message "/name args". It is a real turn input: the manager counts it among the turn's causes, and the app draws a
  human bubble. Aliases do not pass through Rarog, so the text sent equals the text recorded.
- **Name outside the registry** (skill from disk, plugin command, command of a newer CLI) → a `user` message only when
  the entry is marked as turn input (`origin.kind` or `turnOrigin`, the rule of `isHiddenTurnInput`). A skill call
  carries the marker (fixture `skill-doctor-2.1.294.jsonl`), local commands do not (every command `user` entry in the
  2.1.302 measurement). Without the marker the entry stays a `system` notice, the safer variant for turn state: a local
  command taken for a prompt would fake a turn input, while a prompt taken for a notice loses at most a bubble. The
  mapping reads neither the next entry nor the session catalog, because the history can be older than the disk.
- **"Unknown command:" and "Args from unknown skill:"** (`system/informational`, level `warning`) → a `system` notice.
- **`fileEcho`** (`/compact`): one call can have two carriers, a plain `user` entry "/compact" and the entry with
  `<command-name>`. Each reader (history import and the follower) keeps one per call (`FileEchoPairing`): the entry
  with `<command-name>` right after a plain entry of the same command repeats it and gives nothing. Entries without a
  message (queue operations, the compaction boundary and summary, the caveat) may stand between the two carriers; any
  message ends the pair. A call without a plain entry before it is a `system` notice, like any local command call.
  CLI 2.1.299 writes both carriers, the plain one before the compaction; CLI 2.1.328 writes only the call, after the
  compaction summary (fixtures `queue/measured/compact-2.1.299.jsonl` and `compact-2.1.328.jsonl`).
- **`conversational`** (`ParsedEntry`): `user` and `assistant` messages are speech, `system` notices are not.
  `transcriptHasConversation` uses the field to tell `/clear` from `/resume`: after `/clear` the file holds only the
  "/clear" notice.

What the app shows (entries from the 2.1.302 measurements, `/compact` from 2.1.299 and 2.1.328):

- **Allowed local command from the phone** (`/context`, `/rename x`, `/plan`, `/recap`): the send's `user` bubble and
  an output notice; the call in the file clears as an echo and is not a turn input. The echo key ignores the case
  (the CLI records `/clear`, Rarog lets `/CLEAR` through) and reads a newline or tab before the arguments as a space.
  Sent while a turn runs, `/rename x` leaves only the bubble: on CLI 2.1.325 the CLI renames at once without
  interrupting the turn and writes `custom-title` and `agent-name` but neither the call nor the output (registry rule
  `inTurn: 'silent'`). Its echo then lives only `IN_TURN_COMMAND_ECHO_MS` (10 s): when the turn ends just before the
  Enter, the CLI runs the command idle and writes the call about 0.45 s after the send, which clears as an echo;
  inside the turn nothing clears it, and after the bound it cannot swallow the same command typed in the terminal.
- **Local command typed in the terminal, and any command after a server restart:** a "/name args" notice and an
  output notice, also for commands outside the list (`/config x=1`, `/cd`, `/memory`). After a restart the phone's
  bubble comes back as a notice, because the history does not know who typed the command.
- **Prompt-type command:** one `user` bubble, the send's from the phone (the file's echo clears and counts as turn
  input) or the file's from the terminal. **`/clear`:** the follower's notice that `/clear` started a new Claude Code
  session (a new transcript file) and that the old conversation remains in the terminal.
  **`/compact`:** the notice "Compacted (ctrl+o to see full summary)" after the call. From the phone the call is the
  send's bubble on both CLI versions (the carrier in the file clears as its echo). Typed in the terminal, and in the
  history, the call is a "/compact" bubble on CLI 2.1.299 (the plain entry) and a "/compact" notice on CLI 2.1.328
  (the entry with `<command-name>`).
- **Unknown command typed in the terminal** (`/prms`): "Unknown command: …" notices. **CLI panels** (screens the CLI
  opens in the terminal that wait for keys) closed with Esc (`/status`, `/usage`) and `quit`: nothing, because the
  CLI records nothing.

**Session name after `/rename`** (the card label in the list and the herdr tab). The CLI writes
`{type: 'custom-title', customTitle, sessionId}` and `{type: 'agent-name', agentName, sessionId}` to the transcript
at once and repeats them in the following turns. The follower turns the last `custom-title` of the current engine
session into a `custom-title` event in the same read that brought it: the tail window at attach, a scan of the part before the
window with a `"custom-title"` needle when the window has none, and live growth. After a truncation, a skipped gap or
a replacement by another file (new `dev:ino`, any size) it scans the file again, and a newer scan cancels an older one;
without an entry in the new content the label stays. `EnterWorktree` moves the file with the same inode, so that is not
a replacement. The driver passes the event on as `title`
with `source: 'custom-title'`, and the manager sets the label through `#setLabel` (cut to 28 characters by
`labelFromPrompt`), so the tab follows. A known name wins over the herdr terminal title and over the first-prompt
label. A new conversation in the pane (`init` with another engine session ID after `/clear` or `/resume`) brings back
the terminal title rule, and the label stays until that title changes. `/clear` keeps the name, because the CLI writes
`custom-title` to the new file. `agent-name` does not change the label. On CLI 2.1.319 the `custom-title` line and
the new pane title in herdr (`terminal_title_stripped`) both appear in the first read after Enter (24 ms and 26 ms),
without a turn; the rule does not depend on that timing. Both entries hold exactly `type`, the name and `sessionId`,
as in the synthetic excerpt `server/test/fixtures/herdr/commands/measured/rename-custom-title-2.1.319.jsonl`.

**End of a local command** (driver, `opts.command.slash.kind === 'local'`). After the send the manager shows the
session as working, but a local command starts no turn: herdr stays `idle` and sends no status event. So the driver
arms the wait BEFORE the send (the output can arrive before the socket answers) and ends the command with the herdr
state (`idle` or `done`, without a block, so a permission card or a form stays), unless a newer send waits behind it.
It ends on the output notice of THIS command (the follower tags the notice with the name from `commandRun` or from
the last call in the file), or after `HERDR_TURN_WATCHDOG_MS` (15 s) without output, adding the `quietCommandMessage`
notice (the command started no turn) when the file stayed silent. A local command that puts herdr in `working`
(`/compact`) and a prompt-type command end with herdr's ordinary state change, like any turn; output of a command
typed in the terminal ends nothing. A command with the registry rule `inTurn: 'silent'` (`/rename`) sent while
herdr shows the pane `working` or `blocked` has no wait and no watchdog of its own: no output comes, the turn goes
on, and herdr's state change at the end of the turn ends it like any turn. The `done` push after a local command
follows the same rules as after any turn (`server/src/notify/`): it is dropped while the user is in the app. On CLI
2.1.328 a `/compact` typed in the terminal writes no user message, so its turn holds only the compaction and no
`done` push follows it.

## Allow-list v1 (CLI 2.1.302)

- **`kind` `local`** (output inline, back to the prompt field, measured without a CLI panel; type from the 2.1.310 live
  measurement): `/compact`, `/clear`, `/context`, `/plan`, `/recap`, `/rename` (with and without an argument).
- **`kind` `prompt`** (a model turn): `/init` and `/insights` (type from the 2.1.310 live measurement) and
  23 bundled skills from the session catalog: `/artifact-capabilities`, `/artifact-diagramming`, `/batch`,
  `/claude-api`, `/claude-in-chrome`, `/code-review`, `/dataviz`, `/debug`, `/deep-research`, `/design`,
  `/design-sync`, `/doctor`, `/fewer-permission-prompts`, `/loop`, `/plugin-authoring`, `/run`, `/run-skill-generator`,
  `/security-review`, `/simplify`, `/slides`, `/update-config`, `/verify`, `/workflow-authoring`. A bundled skill is a
  prompt for the model, so its tools go through ordinary permissions. The docs mark which entries are skills (Skill
  or Workflow in the "All commands" table; another docs page for `/plugin-authoring` and `/security-review`).
- **Skills and commands from disk** (`kind` `prompt`): "Session catalog and discovery".

The skills `/artifact-design` and `/keybindings-help` stay outside the list. They are in the probe catalog, but the
docs do not know them, and in the 2.1.310 live measurement the CLI did not accept them from a human: Enter starts no
turn, and the CLI appends "This skill can only be invoked by Claude, not directly by users" to the transcript file.
The registry keeps them with `allowed: false`, so the refusal knows the name and suggests a plain message.

Outside the list on purpose: `/statusline` (changes configuration), `/team-onboarding` (no need), every command with
a CLI panel or dialog (`/status`, `/usage`, `/memory`, `/permissions`, `/resume`, `/help`…), configuration and account
(`/config`, `/hooks`, `/mcp`, `/login`, `/plugin`, `/cd`, `/add-dir`…), `/model` and `/effort` with the ultracode forms
(internal path), `/exit` (restart path), `/rc` (Remote Control) and every alias. A new command joins the list once it
appears in the probe catalog and the live measurement gives its type ("After a Claude Code update"), with an entry
here. `herdr-commands-boundary.test.ts` holds the list literally and checks each type against the measurement.

## Refusals and hints

The refusal sentence (`shape.ts`) names the token and ends with a hint that depends on the case:

- **alias of an allowed command** (`/new`, `/reset`, `/name`, `/checkup`, `/review`): write the canonical name;
- **alias of a command outside the list** (`/settings`, `/plugins`, `/allowed-tools`…): names the canonical command
  and points to the terminal;
- **redirect to a command outside the list** (`/code-review ultra`): the text redirects to `/ultrareview`, which Rarog
  does not let through;
- **name outside the name shape** (`/moj.skill`, `/p:x.y`, `/v1.2`): not in Rarog's catalog, and the CLI would run a
  command of that name if one existed;
- **prefix** of an allowed command (`/comp`): Rarog does not complete names, write `/compact`; of commands outside the
  list (`/usa`, `/perm`): the CLI would complete it to commands Rarog does not let through (`/usage`, `/usage-credits`);
- **`/model`, `/effort`:** use the model button in Rarog; **`/exit`, the alias `/quit` and exit words:** end the
  session with the button in Rarog or in the terminal;
- **`/artifact-design`, `/keybindings-help`** (any case, any argument): a skill that only Claude invokes, so write a
  plain message. No pointer to the terminal, because the CLI refuses there too (hint `claude-only` in
  `REFUSAL_HINTS`); a prefix that completes only to these skills (`/keybindings-hel`) gets the same hint;
- **`/foo bar` when `/foo:bar` is in the catalog:** write `/foo:bar`; **bare plugin command name:** write the full
  name (`/pr-review-toolkit:review-pr`);
- **MCP prompt** (`/mcp__…`): run it in the terminal; **claude.ai skill** (`/docx`, `/anthropic-skills:docx`) and
  **hidden skill** (`user-invocable: false`, `skillOverrides: off`): Rarog does not let it through;
- **path that is a prefix of a command:** add a slash (`/us/`); **a lone slash:** write a command name;
- **the rest** (`/rarogxyz`, a missing path that the CLI would swallow without a trace): unknown to Rarog, check the
  name or run it in the terminal.

## Session catalog and discovery

- **Snapshot** (`catalog.ts`, `CommandCatalog`): `commands` (the allowed ones by lowercase name, with the description
  and argument hint of skills from disk), `names` (every name and alias the CLI knows, disallowed ones included, for
  the prefix rule and the refusal sentences), `revision` (a hash of the content with descriptions: the same list gives
  the same `revision` and the same object) and `cli` (the probe catalog version behind the built-in names). The
  process has one `createCommandCatalogs` factory (`server/src/index.ts`).
- **CLI version:** for a running session, from the CLI session registry (`~/.claude/sessions/<pid>.json`,
  `cli-version.ts`); for a startup prompt, the installed release. Every version gets the built-in set of the one
  measured probe catalog (`COMMANDS_CLI`, 2.1.302); a version other than 2.1.302, or an unknown one, also writes one
  log line per version. Without the factory (tests, demo) the manager and the driver use the registry alone
  (`registryCatalog`), so skills from disk are refused.
- **Freshness:** the signature is the stamps (`mtime`, size, inode, or absent) of EVERY file and directory read and of
  every checked path that did not exist. It is checked at most every 5 s (`CATALOG_CHECK_MS`), with a full rescan at
  least every 60 s (`CATALOG_RESCAN_MS`), so an edited `SKILL.md` and a new `.claude/skills` directory show after the
  check. The scan runs synchronously in the send gate.
- **Sources** (`discover.ts`, no other files; paths and keys in the registry's `DISK_LAYOUT`):
  - user skills `~/.claude/skills/<dir>/SKILL.md`: the command is the directory name. `name` from the frontmatter is a
    second name only when no built-in name or alias, other skill's name or other skill's second name uses it (the
    skills docs: "unless another command already uses that name"). The `synced` directory (reserved in the skills
    docs, "Choose where skills load") and directories outside the name-segment shape (`.trash`, `.staging`) are
    skipped;
  - user commands `~/.claude/commands/<file>.md`, top level only: the command is the file name, `name` from the
    frontmatter does not count, a symlinked directory is read;
  - project: the same two directories under `<dir>/.claude/` for `cwd` and its parents up to and including the first
    `.git`, no higher than the root from `RAROG_HERDR_ROOTS`;
  - plugins from `~/.claude/plugins/installed_plugins.json` (version 2): `scope: user`, and `scope: project` with
    `projectPath` equal to the repo root of `cwd`, installed under `~/.claude/plugins/` (after realpath). Enabled per
    `enabledPlugins` (`<cwd>/.claude/settings.local.json` > `<cwd>/.claude/settings.json` > `~/.claude/settings.json`,
    only `true` enables; no entry → the manifest's `defaultEnabled`, `true` by default). Only `skills/<dir>/SKILL.md`
    (`/<plugin>:<name|dir>`, a plugin prefix in `name` is not doubled) and `commands/<file>.md` (`/<plugin>:<file>`)
    count. The plugin name comes from the manifest or the key; a manifest with its own `commands` or `skills` skips
    the plugin with one log line.
- **Filters:** a `user-invocable` value other than `true`, `1`, `yes` or `on` (any case; the skills docs, "Frontmatter
  reference", describe a boolean field, so an empty or unknown value hides the skill as a precaution) and
  `skillOverrides[name] === "off"` (user and project skills) hide a skill. So does a name outside Rarog's shape, with a
  dot, or equal to a built-in command: the skills docs ("Resolve skills that share a name") say the skill then runs in
  a local terminal session, but Rarog keeps the built-in. A read error gives an empty source and one log line (path
  and error code, no content); scan log lines go out once per process.
- **What it reads from files:** two keys from the settings; scope, `projectPath` and install path from
  `installed_plugins.json`; `name`, `defaultEnabled` and the presence of `commands` or `skills` from the manifest; from
  skills and commands only the frontmatter in the first 64 kB: `name` and `user-invocable` for names and filters,
  `description` and `argument-hint` for the app list; from `skills/synced/` only directory names, for the refusal hint
  and the prefix rule ("Out of scope"; `security-model.md`, "Starting sessions from the phone", rule 10).
- **Regular files only.** Every source file (settings, `installed_plugins.json`, manifest, `SKILL.md`, command) goes
  through `head` and `readRegularFileSync` (`server/src/safe-read.ts`): an open with `O_NONBLOCK` and `fstat` on that
  descriptor. A FIFO, a device or a directory under that name gives an empty source and the log line "command
  catalog: not reading file … (not a regular file)", and the scan does not hang. A sandboxed agent can write the
  project's `.claude`, and the scan runs synchronously in the send gate, so without this rule one `mkfifo` would hang
  the whole server. Symlinks are read: a symlinked `SKILL.md` and symlinked `~/.claude/skills` directories are
  legitimate (`security-model.md`, "Special files in the project directory").

## List for the app (`GET /api/sessions/:id/commands`)

- **What it is.** The commands that the session's send guard lets through. `manager.commands(id)` gets the snapshot
  `commandCatalog(pane cwd, process CLI version)` the same way as `#sendToHerdr` (`#sessionCatalog`), and
  `commandListOf` (`catalog.ts`) builds the response, so the same `revision` in the app and in the guard means the same
  list. The app list block in `server/test/manager-herdr.test.ts` checks this and tries each item with `assertSendable`.
- **Shape** (`CommandList`, `commandListSchema` in `shared/src/protocol.ts`): `{revision, commands: [{name, kind,
  source, description?, argumentHint?}]}`. `name` has no slash and keeps the source's case; `kind` is `local` or
  `prompt`; `source` is `builtin`, `skill` (skills and commands from disk, the account's and the project's) or
  `plugin`. Sorted by lowercase name, with no aliases, argument redirects or file paths.
- **Description and argument hint:** only from the frontmatter of a skill or command on disk (`frontmatterText` in
  `discover.ts`): one line; `>`, `|` and an indented continuation joined with a space, quotes stripped, control
  characters dropped, at most 200 UTF-16 characters with `…` (`COMMAND_TEXT_MAX`). A missing field, a list or a map
  gives no field. Rarog does not take the body's first paragraph, as the CLI does. Built-ins have no description. A
  skill's second name has the same description as the directory name.
- **Gates** (`manager.commands`): an unknown session → 404; a pane out of reach, and any Codex pane → 400 with the send
  sentence; a session directory outside `RAROG_HERDR_ROOTS` (the pane started outside and did `cd` under a root) →
  400, as for the diff, because the list carries names and descriptions from that directory's `.claude/`; 401 as on
  every route. A session without a live pane gets the list for its directory. Demo: the registry alone.
- **App side** (`RarogContract`, `RarogTransport`): `RarogClient.commands(sessionId:)` reads 404 and 405 (a server
  without this route) as `CommandList.unavailable`, an empty list with an empty `revision`, not an error; 401 is
  `.unauthorized`. An entry with a `kind` or `source` this app version does not know drops off the list; `null`, an
  empty `revision` and a wrong type reject the response.
- **Golden responses:** `shared/fixtures/rest/commands.json` (demo, registry alone) and `commands.disk.json` (a disk
  scan in a temp directory), produced by `server/test/rest-fixtures-producenci.test.ts`. Both change with the registry
  (`revision`): after a change to `registry.ts`, run
  `RAROG_FIXTURES_WRITE=1 pnpm test server/test/rest-fixtures-producenci.test.ts`.

## App

- **Prompt field:** text that starts with `/` after leading whitespace goes without autocorrect, autocapitalization,
  spell checking and smart punctuation (`ComposerTextTraits.swift`), so `--force` and straight quotes reach the CLI
  unchanged. The whitespace set is the server's `trimStart` (`RarogCore/SlashCommandText.swift`).
- **Suggestions after `/`** (`RarogUI/Session/CommandSuggestions*.swift`): a token from `/` to the end of the field,
  without whitespace, opens the session's command list above the field. The filter is a PREFIX match on the name in
  any case, without fuzzy matches or aliases, in server order; a row shows `/name`, the dimmed argument hint and a
  one-line description, and a tap inserts `/name ` in place of the token. A space after the name, deleting `/`, a
  send, a hidden keyboard and a session switch close the list. An error or `CommandList.unavailable` gives no session
  commands and no message. The list sits in the field's view hierarchy, not in the keyboard region.
- **Hardware keyboard:** with the list open, ↑/↓ move the selection (wrapping), Tab and the first Return insert the
  selected command (a second Return sends), and Esc closes the list without interrupting the turn; the model popover
  takes Esc first. A hidden list takes no keys, and neither does an open one during IME composition. None of these
  keys reaches the herdr pane. A row picked with ↑/↓ stays picked when commands change under the list
  (`CommandSuggestions.picked`).
- **Refresh** (`RarogCore/RarogStore+Commands.swift`): the app reads the viewed session's list on the first `/`, then
  at most every 60 s (on the next `/`), and right after a 400 refusal of a send that starts with `/`, because the
  catalog may have changed. One read per session is in flight at a time. A 401 takes the lost-login path, a 400 or a
  response outside the contract gives an empty list until the next due time, and a dropped network keeps the last
  list. A switch of the viewed session and a sign-in clear the list.

### App commands

An app command is text that the app handles ITSELF and never sends to the pane. The one list is `AppCommand.all` in
`RarogUI/Session/AppCommands.swift`: `/model`, `/effort`, and `/usage` with the aliases `/cost` and `/stats`.

- **Recognition** (`AppCommand.recognize`): the WHOLE field text is an app command when, after leading whitespace
  (`SlashCommandText`), it is `/`, a listed name or alias in any case, then the end of the text or whitespace and an
  argument. The argument changes nothing: `/model opus` and `/effort ultracode off` only open the popover, which sets
  the value with a warning about the global effect (ultracode is the `/effort` setting from the `model-config` docs,
  switched in the popover's Ultracode menu). `/modelx`, `/mode`, `text /model`, `/model:x`, `/usa` and
  `/usage-credits` go to the server.
- **Interception** (`SessionViewController+AppCommands`, at the start of `send()` in `+Send`): the Send button and
  Return on a hardware keyboard share the path, so both check for an app command first. Nothing leaves: no request,
  no outbox entry, no echo, no grace window of the Send button (the moment after a send in which the button stays
  Send instead of Stop); attachments stay in the bar.
- **`/model` and `/effort`** open the Model and Effort popover of the model pill (`Session/ComposerPills.swift`; a
  sheet on iPhone) through `ModelSheetRequests`, the same way as a tap, with the same locks
  (`AppCommand.modelSheetRoute`). A popover with a choice clears the field. During a turn, and before a fresh session
  state, the popover gives the reason and a Close button, and the text stays for another Send. Without a pill (Codex,
  a session the app does not know) a sentence with the reason stands under the field, and the text stays.
- **`/usage`, `/cost`, `/stats`** open the Usage sheet (`Views/Usage/UsageSheet.swift`; a popover at the Send button on
  iPad, a sheet on iPhone). An opened sheet clears the field, because usage belongs to the Claude account on the Mac,
  not to the session; over an open window no second one opens. Each open reads `GET /api/usage/details` once (the
  usage reading that Claude Code keeps in `~/.claude.json`) and refreshes `GET /api/usage` (the status bar), without
  polling. The rows show the 5 h window, the week and the per-model week (Fable); 5 h and week come as a pair from
  the FRESHER reading (`Model/UsageSheetModel.swift`).
- **Suggestion list:** app commands appear with an in-app note in place of the description (`UICopy.appCommandNote`),
  merged by name among the server's commands (`AppCommand.merged`); a server entry with the name or alias of an app
  command gives way. A tap, Tab and the first Return insert `/model ` like any row; only Send opens the popover.
- **Server:** it refuses `/model`, `/effort` and `/usage` (a CLI panel) in free text (`REFUSAL_HINTS`), so an app build
  without app commands gets a refusal. `GET /api/usage/details` lives in `server/src/usage.ts` (the boundary for
  reading `~/.claude.json`: `security-model.md`, rule 10). The popover's `/model` and `/effort` go to the pane only
  into an empty CLI prompt field: text left in the field after an interrupt is cleared first, and any other text
  stops the change with a system message (`implementation-spec.md`, "Changing the model of a live session").

## Out of scope

- **claude.ai skills** (`~/.claude/skills/synced/<id>_<id>/<name>/SKILL.md`, one directory per organization and
  account). In the 2.1.302 probe catalog they have source `user` and a bare name (`docx`), with a prefix on a
  collision (`anthropic-skills:deep-research`). Which subdirectory the CLI reads is unmeasured, and the docs give the
  bare name only when no other command uses it ("When a synced skill name matches another command"), so Rarog cannot
  know which name the CLI accepts. Their names serve only the refusal hint and the prefix rule.
- **Bare plugin command names** (`/review-pr` for `/pr-review-toolkit:review-pr`): the CLI accepts them when the name
  is free; Rarog refuses with the full name as a hint.
- **MCP prompts**, nested `.claude/` directories below `cwd`, `commands/` subdirectories (`/a:b`), a `SKILL.md` at a
  plugin root, `--add-dir` directories, plugins enabled by managed settings or as a dependency, plugins with their own
  paths in the manifest, `scope: local`, skills with `skillOverrides: off` (the probe lists them), and plugin skills
  whose directory has spaces (the CLI normalizes them to hyphens).
- A plugin enabled on disk but inactive in the open session (without `/reload-plugins`) passes and gets "Unknown
  command" from the CLI: one failed send, accepted.

## Module map

- `server/src/herdr/commands/index.ts`: the public entry and the module map.
- `server/src/herdr/commands/guard.ts`: the text guard before a send, and the send throttle.
- `server/src/herdr/commands/shape.ts`: the recognition rule (`classifySlashText`) and the name shape, one definition.
- `server/src/herdr/commands/catalog.ts`: the session catalog snapshot, the factory with a cache per `cwd`, and the app
  list (`commandListOf`).
- `server/src/herdr/commands/discover.ts`: skills and commands from disk, with description and argument hint.
- `server/src/herdr/commands/transcript.ts`: a command entry in the transcript file → a transcript message; also a
  prompt blocked by a `UserPromptSubmit` hook (`dialogs.md`).
- `server/src/herdr/commands/registry.ts`: the ONLY place for CLI literals about commands, each with evidence, a
  version and a date.

Outside the directory, on purpose: the `/exit` restart text, the confirmation dialogs of `/model` and `/effort` and
the in-place ultracode result (`drivers/herdr/commands.ts`), and building `/model` and `/effort` from the sheet's
values (`sessions/manager.ts`, with the ultracode forms from the registry). The guard
`server/test/herdr-commands-boundary.test.ts` checks that no registry literal (tag, message prefix, exit word, quoted
command name, on-disk skill layout name or key) appears in `server/src/**` outside the directory, that the shape
pattern and `classifySlashText` live only in `shape.ts`, and that production code has no `slashCommandToken` or
`isSlashCommandText` (no guessing a command from text without the catalog).

Data: `server/test/fixtures/herdr/commands/measured/` (the probe catalog, the live measurement results
`live-<version>.json`, the ultracode evidence file `ultracode-<version>.json`, transcript excerpts) and
`server/test/fixtures/herdr/commands/docs/` (docs facts `commands.json`, the fetch date in its `fetched` field);
origin and contents in `server/test/fixtures/herdr/README.md`. The `catalog` and `live` files come only from the final pass of the fixture
anonymizer (`scripts/anonymize-fixture.ts`, test `server/test/anonymize-fixture.test.ts`).

## Registry (`registry.ts`)

- **`EVIDENCE`:** four evidence files under `server/test/fixtures/herdr/commands/`, each with a CLI version and a date:
  the probe catalog (`measured/catalog-2.1.302.json`, the built-in name set), the docs facts
  (`docs/commands.json`: names, aliases, Skill and Workflow markers, redirects), the live measurement
  (`measured/live-2.1.310.json`: menu aliases, exit words and the types of the closed list, i.e. the commands that
  the live measurement sends with Enter to learn their type) and ultracode
  (`measured/ultracode-2.1.318.json`: command forms and flag value from the `model-config` docs, attachment names and
  command output measured on a live CLI). `COMMANDS_CLI` and `COMMANDS_MEASURED` are the probe catalog's version and
  date.
- **`BUILTIN_COMMANDS`** (100 entries, 8 `allowed`): the built-in commands, field by field:
  - `name`, `aliases`: without the slash; names from the probe catalog or the docs, aliases from the menu or the docs;
  - `kind`: `local` (prints output and returns to the field), `panel` (the CLI opens a panel and waits for keys),
    `prompt` (a model turn). Measured only on the live measurement's closed list (the commands it sends with Enter,
    "After a Claude Code update"), with the version in `kindEvidence`; the rest have `panel`, a cautious value
    that `buildCatalog` never lets through;
  - `listed`: whether the probe catalog had the command (`/diff`, `/stop` and `/ultraplan` have docs evidence only);
  - `allowed`: the allow-list ("Allow-list v1"), never with `kind: 'panel'`;
  - `observed`: a sentence from a live CLI measurement with its version; `fileEcho: 'plain-user-entry'`
    (`/compact`): two possible carriers of one call, a plain `user` entry and the entry with `<command-name>`, of
    which the transcript keeps one ("Command in the transcript"); `inTurn` (`/rename`, rule
    `silent`, CLI 2.1.325): sent while a turn runs, the command runs at once, the turn goes on and the transcript
    gets no call or output entry (synthetic excerpt `measured/rename-in-turn-2.1.325.jsonl`);
  - `cli`: the version of the name's evidence (for `listed: false`, "unknown").
- **`BUNDLED_SKILLS`** (25 entries, 23 `allowed`): skills built into the CLI, without a file on disk: `builtin`
  names from the probe catalog that the docs show as skills. `skillEvidence` gives the source: `docs-marker` (Skill or
  Workflow in the docs table), `docs-text` (another docs page: `/plugin-authoring`, `/security-review`) or `none`
  (`/artifact-design`, `/keybindings-help`). All but the two `none` skills are `allowed`; those two keep their names
  in the registry, so that the refusal knows them and a disk skill with that name stays out. `subcommands` are
  first-argument redirects, also with further arguments: `/code-review ultra` → `/ultrareview` (docs) and
  `/design sync|login|consent|revoke` → `/design-…` (a rule on the probe catalog: a skill `S` with a docs marker and
  a command `S-x` give `x` → `S-x`).
- **`EXIT_WORDS`:** `exit`, `quit`, `:q`, `:q!`, `:wq`, `:wq!`, the words that as the whole text ended the session in
  the live measurement (2.1.310).
- **`REFUSAL_HINTS`:** commands with a hint other than the terminal (`model`, `effort`, `exit`, and `claude-only` for
  `artifact-design` and `keybindings-help`). **`MCP_PROMPT_PREFIX`** (`mcp__`) and **`MCP_PROMPT_MARKER`** (`(MCP)`
  after the name in the menu): docs `mcp.md`, "Execute MCP prompts".
- **`DISK_LAYOUT`:** the on-disk layout of skills, commands and plugins and the settings keys that `discover.ts` reads;
  its comment names the sources (skills and plugins docs sections, `installed_plugins.json` version 2 and `synced/`
  observed on disk). It reserves only `synced` (`reservedDirs`); the name-segment shape filters out `.trash` and
  `.staging`.
- **`TRANSCRIPT_TAGS`**, **`TRANSCRIPT_ENTRY`**, **`CLI_PLUMBING_TAGS`:** the transcript tags and fields that
  `transcript.ts` reads (`command-name`, `local-command-stdout`, subtype `local_command`, "Unknown command: /", "Args
  from unknown skill: "…). `TRANSCRIPT_MEASURED.withoutFixture` names the tag without a fixture entry
  (`local-command-stderr`) and why. The fields of a prompt ended by a hook (`promptSubmitEnding`, `blocked_by_hook`,
  `stopped_by_hook`, `promptKept`, `Original prompt: `) come from a measurement on CLI 2.1.303; `transcript.ts` reads
  `blocked_by_hook` from them, while a `stopped_by_hook` prompt sits in a plain `user` entry (`dialogs.md`, "Prompt
  blocked by a hook").
- **`INTERNAL_SLASH_COMMANDS`:** `/model` and `/effort` on the guard's internal path; there is no deny-list.
- **`ULTRACODE_COMMANDS`:** the two ultracode forms from the docs, `/effort ultracode` and `/effort ultracode off`,
  both confirmed by measurement (`EVIDENCE.ultracode`); the manager sends them on the internal path at the end of the
  model endpoint's batch. The other ultracode words (startup flag value, attachment names, the start of the command
  output and of the refusal when workflows are off) and the readers `ultracodeMarkerOf` and `ultracodeResultOf` live in
  `server/src/herdr/ultracode.ts`, and no other `server/src/**` file holds them (guards
  `server/test/herdr-commands-boundary.test.ts`, `server/test/ultracode-boundary.test.ts`).

## Measurements (Claude Code 2.1.302)

Manual measurements in a herdr tab of their own (text only through `herdr agent prompt`, Esc as the only key) give the
CLI behavior the guard relies on. Their transcript excerpts are `config-plugin-cd-2.1.302.jsonl`,
`nieznane-sciezki-plan-context-2.1.302.jsonl`, `kandydaci-allow-listy-2.1.302.jsonl` and `rename-clear-2.1.302.jsonl`
in `server/test/fixtures/herdr/commands/measured/` (contents in the fixtures README).

- **A prefix with Enter runs the suggestion**, in any case: `/usa` → `/usage`, `/perm` → `/permissions`, `/Usage` →
  `/usage`. An alias runs its command: `/settings x=1` → `/config x=1` sets the value without a dialog.
- **A fuzzy match does not run:** `/prms`, `/usg`, `/stts` give "Unknown command: /usg. Did you mean /bg?".
- **No dialog** for `/plugin install x@y` and `/cd <dir>` (the pane's `cwd` in herdr stays).
- **Path:** a token that exists on disk is a prompt (`/tmp …`, `/var …`, `/Users/<account> …`, `/tmp/pomiar.log …`); a
  missing one (`/rarognieistnieje …`) gives "Unknown command" and "Args from unknown skill" entries, and the model gets
  nothing.
- **Text sent while a CLI panel is open is lost.** The driver's fallback catches it: while the CLI session registry
  says `waiting`, the driver treats the pane as blocked.
- **Transcript records:** a local command leaves `system/local_command` entries (`/config`, `/cd`, `/context`,
  `/rename`), `user` entries with `<command-name>` (`/plugin`, `/plan`) or a mix (`/recap`, `/clear`). `/clear` starts
  a NEW transcript file (a new `sessionId` in herdr and in the CLI session registry). `/compact` is a plain `user`
  entry plus one with `<command-name>` on CLI 2.1.299 and only the `<command-name>` entry on CLI 2.1.328
  (`server/test/fixtures/herdr/queue/measured/compact-2.1.299.jsonl`, `compact-2.1.328.jsonl`). A skill call
  (`/doctor`, CLI 2.1.294, `skill-doctor-2.1.294.jsonl`) carries `origin: human` and `turnOrigin: human`, and its
  body follows as `isMeta` with `turnCompanion: true`.

## Live measurement (Claude Code 2.1.310)

The live measurement (`measured/live-2.1.310.json`; method in "After a Claude Code update", item 3) ran without a
single model turn and gives the registry these facts:

- **Aliases:** the `/` menu shows an alias in parentheses next to the name (`/na` → `/rename (name)`), and the
  highlighted row is the suggestion that Enter runs (`/q` → `/exit`). A plugin skill gets parentheses too
  (`/demo:skill-09 (skill-09)`, a client skill under its catalog number); whether the short name invokes it is
  unmeasured. An alias with no parentheses in the menu and no docs entry is not in the registry ("Known gaps").
- **Types on the closed list:** `prompt` for `/init`, `/insights`, `/team-onboarding` (the hook stopped the prompt);
  `local` for `/recap`, `/compact`, `/context`, `/rename` with an argument, `/clear`, `/plan` (the hook got nothing and
  the prompt field stayed); `panel` for bare `/goal` (CLI session registry `waiting`, `waitingFor: dialog open`, no
  transcript entry). `/artifact-design` and `/keybindings-help` behave as `local` and get the "only be invoked by
  Claude" line ("Allow-list v1").
- **Exit words:** `exit`, `quit`, `:q`, `:q!`, `:wq`, `:wq!` end the session (hook `SessionEnd`, reason
  `prompt_input_exit`); `:x`, `bye` and `ZZ` do not. `logout` was not sent.
- **Menu gaps:** `/pr-comments`, `/stop`, `/ultraplan` and `/vim` (in the docs) have no menu row, and some built-ins
  appear only under their full name (`/agents`, `/heapdump`, `/claim-credit`, `/setup-vertex`, …).

## After a Claude Code update

Facts about commands come from the documentation and from observing the running program, never from its code
(`distribution.md`, "What the repo knows about Claude Code"). The registry rests on four evidence files (`EVIDENCE`:
items 1–3 and the ultracode file), and the evidence test in `server/test/herdr-commands-boundary.test.ts` compares the
value and metadata of each fact with them. After a CLI update the evidence is measured again and the registry is
compared with it (item 4). The ultracode file (`measured/ultracode-<version>.json`) comes from the `model-config` docs
and from a live CLI measurement, with transcript excerpts in `server/test/fixtures/herdr/ultracode/`;
`server/test/ultracode-boundary.test.ts` compares `server/src/herdr/ultracode.ts` and the command forms with it.

1. **Session command catalog** (`measured/catalog-<version>.json`): the probe's `$.command.list()` at session start in
   a live herdr, without a prompt to the model. Client names become pseudonyms (`alfa`, …) from the `pseudonyms` field
   of the private literals file outside the repo (`docs/publishing.md`), a client plugin's skills become numbers in
   name order (`alfa:skill-01`…), and `builtin` entries stay literal. The `skillSets` field fingerprints each client
   plugin's skill set (HMAC-SHA256 of the sorted names, keyed with the pseudonym's private names, 16 characters), so a
   changed set of the same size shows; without the literals file the fingerprint can be neither checked nor reversed.
   The catalog and the live measurement file come only from a final pass of `scripts/anonymize-fixture.ts` (fixtures
   README, "Writing a fixture"), and no file is written without the literals file or when a literal or a structural
   pattern (a name without a pseudonym) survives. A new evidence file gets an entry in
   `server/test/fixtures/herdr/provenance.json`.
2. **Docs facts** (`docs/commands.json`, from the "All commands" table of
   `code.claude.com/docs/en/commands.md`): names, aliases (an "Alias for …" row is an alias, not a command), Skill and
   Workflow markers, "Removed", arguments from the first column (`/design consent`) and the redirects that the docs
   describe as "`/x` is an alias" for a call with an argument. No documentation text.
3. **Live measurement** (`measured/live-<version>.json`, live herdr, no model turns): successive
   `claude --model haiku --permission-mode default` sessions in a herdr tab of their own, with a test hook passed
   through `--settings` that stops EVERY prompt (exit code 2) and logs session start and end. The probes read the `/`
   menu without Enter (prefixes, every docs name and alias, every `builtin` name from the probe catalog, and a scan
   over `/a`…`/z`, `/0`…`/9`, `/_` with a growing prefix) and press Enter only on a closed list of commands and on the
   exit words. A result file is written only when no transcript of the run has an `assistant` entry and the client
   plugin skill sets in the menu match the catalog. It holds the summaries and every probe, with client names as
   pseudonyms and client plugin skills under their catalog numbers.
4. **Registry against evidence, disk against the catalog.** Six parts: names against the probe catalog and the docs,
   aliases (docs and menu), exit words, closed-list types, argument redirects (docs or probe catalog), and disk against
   the catalog; a missing evidence file is a difference too. "Rarog lets through, the probe catalog does not know"
   means `discover.ts` yields a name the session's CLI does not know: fix the rule or the source subset. Differences go
   into `registry.ts`. A new command whose `kind` matters joins the closed list, and the measurement runs again. A
   change to `allowed` changes the permission boundary and needs an entry in "Allow-list v1". The behaviors from
   "Measurements" (a path at the start of a prompt, the fuzzy match) are measured again by hand when they change.
   Tests after a registry change: `server/test/herdr-commands-boundary.test.ts`,
   `server/test/herdr-commands-guard.test.ts`, `server/test/herdr-commands-discover.test.ts`.

## Known gaps

- The scan sees only what the menu shows: a command hidden in the menu is known only as a full-name candidate (docs,
  probe catalog), and one outside both sources is missed. The menu also skips some prefix matches when it is not full
  (on 2.1.310 `/i` gave four lines without `/install-github-app` and `/install-slack-app`); a full-name probe catches
  such a built-in.
- `kind` is measured only on the closed list, and `logout` not at all. Commands outside the closed list have `panel`
  (a cautious value): the allow-list does not change, but `/statusline` typed in the terminal shows as a `system`
  notice, not a `user` bubble. Its type is not measured, because the measurement would change the Claude Code
  settings.
- The report confirms an argument redirect only from the docs ("`/x` is an alias") or from the probe catalog (a name
  `<skill>-<argument>` next to a skill with a docs marker); any other redirect comes out as "without evidence".
- The probe catalog comes from session start and can be older than the installed CLI: MCP commands and plugins added
  during the session (`/reload-plugins`) may be missing, and scan completeness is checked against the catalog version
  in `evidence.catalogCli`.
- The prefix rule knows only names from the registry and the disk: an MCP prompt, or a skill outside discovery, whose
  name starts with the name of an existing directory in `/` would pass as a prompt, and the CLI would complete it. The
  same holds for a path that is a prefix of a nested skill's name (`/apps/web` next to `/apps/web:deploy`).
- A local command sent from the phone is a `user` bubble live and a `system` notice after a server restart; there is
  no duplicate in either case. A call with a redirect (`/design sync`; the CLI probably records `/design-sync`,
  unmeasured) misses the send echo and shows twice: a bubble from the phone and one from the file.
- A call of a command named outside the registry without a turn-input marker (for example a skill on a CLI older than
  2.1.277, which has no `turnOrigin`, when the entry also lacks `origin`) is a `system` notice, not a bubble.
- An output without its closing tag (a clipped entry, an unknown shape) is not a notice.
- The history and the follower each run their own `fileEcho` pairing. On CLI 2.1.299 a session attached during a
  compaction, with the plain "/compact" entry in the history and the call in the live tail, shows the call twice:
  a bubble from the history and a notice from the tail.
- `/cd` typed in the terminal splits the pane's `cwd` in herdr from the CLI session's directory, and Rarog computes
  the catalog from herdr's `cwd`.
- `/effort ultracode` or `/effort ultracode off` typed in the terminal DURING a turn (CLI 2.1.317) leaves no echo, no
  `⎿` row and no transcript entry, only a notification above the field. The transcript gets no notice, and the card
  sees the change from the next turn's attachment (`ultracode/off-w-turze.jsonl`). From the app an ultracode command
  goes only while the session is idle (the model endpoint refuses during a turn).
- **Names without evidence are not in the registry.** The registry keeps a name or alias only with evidence (docs, the
  live measurement's menu, probe catalog), so a `/<name>` outside them gets the step 6 refusal. The risk, for a user
  whose CLI has a command without such evidence: a disk skill of the same name passes from the phone as a prompt. Per
  the skills docs ("Resolve skills that share a name"), the skill then runs in a local terminal session, except for a
  name equal to a built-in command's alias, where the built-in runs. The same holds for commands of a new release until
  the measurement after the update sees them.
- A redirect counts also with further arguments (`/design login x` is refused); how the CLI runs such text is
  unmeasured, and Rarog takes the target. `/run` and `/run-skill-generator` fit the rule skill `S` + command `S-x`, but
  neither the docs nor the registry has that redirect. Both are allowed, so if the CLI ran `/run skill-generator` as
  `/run-skill-generator`, the only effect would be a file entry whose name does not match the send: no echo match,
  and a second bubble.
- The docs reserve `synced` in any case and do not load a skill named `anthropic-skills`; `discover.ts` compares
  `synced` literally and does not filter out `anthropic-skills`. Such a directory would pass as a skill and get
  "Unknown command" from the CLI (one failed send).
