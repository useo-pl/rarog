# Architecture

> This document describes the system as it runs. When the code and this file disagree, the file is wrong: fix it
> together with the change.

Guiding rule: boring technology over clever technology. The server is the only source of truth; the client is thin
and can be rebuilt from the server at any time. What existing infrastructure already solves (a reverse proxy with TLS
on a private network, the tailnet, APNs), Rarog leaves to it.

## What Rarog is and is not

Rarog is a **herdr client**, not a second agent engine. A Rarog session is a `claude` pane in
[herdr](https://herdr.dev) (a terminal multiplexer for agents), started by Rarog or by a person in a terminal. A
`codex` pane is a session too, but only as a status entry without content (item "Codex entry" below). Rarog does not
call `query()` from the Agent SDK, runs no engine process of its own and keeps no session registry: what is alive is
what `agent.list` on the herdr socket says.

Consequences that recur throughout the code:

- **State and control** come from the herdr unix socket; **content** comes from the transcript files
  `~/.claude/projects/…jsonl` that Claude Code writes. Neither source is enough alone.
- **Knowledge about Claude Code lives on the server; the client displays the contract.** Only the server reads tool
  names (`ExitPlanMode`, `Agent`, `Bash`), the answer channel and CLI option texts, and turns them into semantic
  fields (`subject`, `delegation`, `inputKind`, `customAnswer`, `role`). The native app decides by those fields only
  and uses `toolName` and `channel` at most as text for copy. A change in the CLI ships as a server release alone.
- **Rarog reads the CLI store and never modifies it**: the file belongs to Claude Code. The transcript follower
  (`herdr/jsonl-follow.ts`, the reader that follows the end of a transcript file) reads the tail in chunks backwards
  until it has `HERDR_HISTORY_MESSAGES` messages (hard cap `HISTORY_MAX_BYTES`), not a fixed byte window: most bytes
  in the file are `tool_result`, which import drops, so a fixed window held only a few messages. That window is the
  conversation history. The background task list comes from the whole file: after sending the history, the follower
  scans the part before the window (`herdr/background/main-scan.ts`, streaming, with a prefilter before
  `JSON.parse`) and only then feeds the window entries to the task reducer (`background-tasks.md`, "Attach: full scan
  of the main file"). The session directory pulse (`herdr/session-pulse.ts`) samples at most `PULSE_MAX_ENTRIES`
  (400) files by `mtime`, not in `readdir` order, so a directory with more than 400 files does not mute the pulse
  while subagents write.
- **The transcript file can move during a session, and Rarog follows it.** `EnterWorktree` in Claude Code moves the
  file with `rename(2)` to the slug of the worktree directory: same inode and content, another project directory, and
  herdr reports nothing (`agent_session` and the pane `cwd` stay the same). On `ENOENT` at the known path the follower
  runs `#relocate()`: it finds the file by uuid (`transcript-path.ts`, the same glob as the first open), checks that
  the new file continues the previous one (`size >= offset`), moves the watcher and reads on from the same offset, with no
  history replay, no duplicates and no system message. Relocation is not `repoint()`, which handles `/clear` and
  `/resume`, i.e. a different engine session. A glob miss gives one log line and `hasTranscript() === 'no'`; tries
  are capped at `FOLLOW_RELOCATE_TRIES` (5), with growing gaps, so a pane whose file was deleted does not scan the
  store on every tick. The new path goes out in a `relocated` event to the satellites, the three readers that keep
  their own directory cache next to the transcript: the directory pulse, the workflow layout reader and the subagent
  file reader. Each drops its cache on that event (`relocated()` in `session-pulse.ts`, `background/workflow-run.ts`
  and `background/agent-file.ts`; all paths come from `background/satellite.ts`). Without that, the conversation
  would come from the new place while the activity line, the workflow layout and subagent state went silent.
- **Follower emission is batched** (`herdr/jsonl-follow.ts`): ten jsonl lines within 10 ms make one batch, and state
  (usage, meta, pending, background tasks) gives one event per kind per batch. The activity indicator too: a batch
  emits only the one that closes it. The client clears activity on every message and overwrites it with each next
  one, so the other indicators of a batch could never show, and each would cost an SSE frame to the phone.
- **Ultracode from the transcript file.** Ultracode is a Claude Code session setting, separate from the effort
  level, under which Claude plans a workflow for every task. A start with ultracode (`--effort ultracode`) seeds the
  card with the requested value. The ultracode command that `POST …/model` (`{ultracode}`) types into a live session
  changes the card at once only when the screen shows a recognized result. After that, markers in the transcript
  file decide (the attachment of the first turn after the gesture, the command result while idle), counted from the
  start of the current CLI process in the CLI session registry: `--resume` starts a process without ultracode, and an
  attachment from before belongs to a process that is gone. So a new process of the same conversation removes the
  field from the card, including a requested `true` from before the previous process started, and a gap in reading the
  file invalidates the known state, because the skipped part may have carried a switch-off. A missing marker changes
  nothing, with one exception: the first model answer after a requested switch-on without an attachment means the CLI
  did not turn ultracode on. CLI wording: `herdr/ultracode.ts`; transcript excerpts from CLI 2.1.318: the
  `ultracode/` fixtures; rules: `createUltracodeTracker` (`herdr/jsonl-pending.ts`); the state travels in the
  follower's `meta` event to the driver's `init`. Details: `implementation-spec.md`, "Model, effort and permission
  mode".
- **The input channel into a pane is the pty**: `agent.prompt` (text) and `agent.send_keys` (keys from a closed
  allow-list). A message to a Claude pane during a turn goes as a paste without keys (`pane.send_input`), then a
  separate `enter` after checks that no dialog stands (`dialogs.md`, "Sending while a turn runs"). A photo or a PDF
  can enter only as a file path that the agent opens with `Read` (`herdr/uploads.ts`).
  Neither the path nor the bytes enter the transcript: the user echo carries `attachments[]` cards (`kind`, `name`,
  `bytes`, `mime`, and for photos `file`, the bare file name in `.rarog-uploads/`). The app takes the thumbnail from
  process memory or from `GET /api/sessions/:id/uploads/:file` (`RarogStore+Uploads`), the only read path for that
  directory; history from jsonl gets the name from the CLI companion entry `[Image: source: …]` (fixture
  `transcript-sample.jsonl`). After the 48 h sweep the route has nothing to return.
- **Prompt absorbed into a running turn.** The CLI absorbs a prompt that arrives while the agent works into that turn
  at the next tool result. The transcript file records it only as a queue attachment (`attachment` of type
  `queued_command`, prompt mode, origin `human`), without a `user` entry. The transcript parser
  (`transcript-import.ts`) turns it into a plain `user` message; `herdr/background/queued-prompt.ts` recognizes the
  carrier. So the message comes back when the transcript is rebuilt from the file (server restart, pane return,
  Resume), a prompt typed in the terminal reaches Rarog live, and the echo of a send from Rarog is consumed as for a
  plain `user` entry. Task notifications and subagent messages ride the same attachment and are not messages. A
  rebuild from the file has no photo thumbnail. The path of a prompt through the CLI queue, measured live on CLI
  2.1.299 and CLI 2.1.328 (fixtures `<scenario>-<version>.jsonl` in `server/test/fixtures/herdr/queue/measured/`,
  prompts sent with `agent prompt`, as Rarog sends them); both versions write the same entries unless a point says
  otherwise:
  - **Send while the agent works:** a `queue-operation` `enqueue` entry with the prompt text at once; the CLI screen
    shows the prompt at the end of the conversation as `❯ <prompt>` with the hint `ctrl+enter to send now`.
  - **Absorption:** at the next tool result the CLI appends `remove` (`reason: absorbed_mid_turn`) and the
    `queued_command` attachment, which carries the SEND time, so times in the file do not grow.
  - **Turn without tools:** `dequeue` when the turn ends, then a plain `user` entry that opens a new turn. Two queued
    prompts give two `user` entries in send order, but one turn and one answer to both.
  - **Esc over the queue:** the CLI interrupts the turn and takes the queued prompt as a new turn at once; the prompt
    neither returns to the prompt field nor disappears (fixture `esc-nad-kolejka.jsonl`). Esc during a tool call: the
    tool result, the `[Request interrupted by user for tool use]` entry and the queued prompt carry the queued
    prompt's `promptId`. Esc while the model writes text (`esc-w-tekscie`): CLI 2.1.328 gives the
    `[Request interrupted by user]` entry the `promptId` of the interrupted turn and the queued prompt a new one; CLI
    2.1.299 gives the interruption the queued prompt's `promptId`. The consent evidence review
    (`herdr/consent-evidence.ts`) reads every arrangement the same way: an interruption never opens a turn, and a
    human entry with another `promptId` that is not a tool result ends it.
  - **Prompt during `/compact`:** `enqueue` WITHOUT a `content` field; after compaction a plain `user` entry with the
    prompt opens a new turn. CLI 2.1.328 gives that entry its own `promptId`; CLI 2.1.299 gives it the `promptId` of
    the compaction summary and the `/compact` command entries.
  - **`/compact` sent while idle:** CLI 2.1.299 writes a plain `user` entry "/compact", then after the compaction
    summary the `<command-name>/compact</command-name>` entry; CLI 2.1.328 writes only the `<command-name>` entry.
    What the transcript shows: `slash-commands.md`, "Command in the transcript".
- **Queued echo.** A prompt sent from Rarog while the agent works, by a client with `queueAware`, gets no echo at
  once. The manager holds the message (`Session.heldEchoes`, `server/src/sessions/held-echo.ts`), and the follower
  passes the prompt entry from the file through with `echoToken`, so the held message lands where the file puts it:
  the answer goes under it and the rest of the previous turn above it. When the file does not bring the prompt (a
  refusal in the driver, a gap, 10 s after the end of the turn, the driver detached), the message goes to the end of
  the transcript. Before that flush the driver reads the prompt field (`SessionDriver.checkHeldLeftover`, zero keys):
  a prompt that a hook blocked leaves no entry, and the CLI puts its text back into the field, so a field EQUAL to the
  message text gives a "did not arrive" notice under the bubble, and a message pasted during a turn whose text the
  driver never saw in the field gives a "not confirmed" notice. Behavior: `dialogs.md`, "Prompt blocked by a hook";
  gate, flushes and contract: `implementation-spec.md`, "Queued echo"; the app side: `native/Rarog/docs/rarog-core.md`,
  "CLI queue entry".
- **Command in the transcript file.** Import (`transcript-import.ts`) maps slash command entries through
  `herdr/commands/transcript.ts`: a local command, its result (without terminal sequences, up to 8 kB) and "Unknown
  command" become `system` messages; a prompt-type command becomes a `user` message. The follower swallows the call of
  a command sent from Rarog with the echo, and the driver ends a local command with the herdr state, because `idle →
  idle` gives no event. Description and the table of what is shown: `slash-commands.md`, "Command in the transcript".
- **Prompt blocked by a `UserPromptSubmit` hook.** Instead of a `user` entry the CLI (2.1.303) writes a `system` entry
  with `promptSubmitEnding`, which `herdr/commands/transcript.ts` recognizes by structure (`blocked_by_hook`). The
  follower takes it before the command path and swallows with it the echo of a send from Rarog. The driver resolves a
  block only for the LAST EXECUTED send. The stall guard is the driver's retry for a send that herdr reports as
  stalled (`agent_prompt_stalled`: the pane did not start working); for a blocked send it ends without its usual
  recovery: no Esc pair (two Esc keys that empty the prompt field) and no second `prompt`. The CLI puts the blocked
  text back into the field, so the next send empties it with the Esc pair, but only when a screen read of the field
  says `filled` (it holds text, not `empty` or `unknown`). The manager adds a `system` notice with the `promptBlocked`
  field, keeps a ring of recent sends (`recentSends`) and moves `running` → `waiting-input` when the block removes the
  last echo key of the turn. There is no push about a block. A resolved block of a send from Rarog also gives a
  resend button (`SessionSummary.promptBlocked = {seq, id}`). Contract: `implementation-spec.md`, "Prompt blocked by a
  hook"; measurement, behavior and the switch `RAROG_PROMPT_BLOCK`: `dialogs.md`, "Prompt blocked by a hook".
- **Codex entry: state without content.** The input filter (`herdr/client.ts`) admits `agent === 'codex'` next to
  `agent === 'claude'`, only with `RAROG_CODEX_STATUS` ≠ `0` and only with `agent_session.kind === 'id'`. Such an
  entry carries `engine` (`'claude' | 'codex'`), `termId` (the pane's `rarog-term` token after the `TERM_ID_RE`
  check) and, on the card, `observedSessionId` (the Codex rollout uuid, only an address for the "seen" marker). The
  client strips the spinner frame from the Codex title, because each frame would look like a title change. A pane is
  in scope (`inScope`) when Rarog reads its content: jsonl follower, directory pulse and screen read. `scopeOf` in
  the supervisor decides it: a Claude pane is in scope when its `cwd` lies in the work area of `RAROG_HERDR_ROOTS`
  (`insideWorkArea`, `docs/security-model.md`, "Work area: where Rarog starts, lists and reads"), a Codex pane
  never. Reading the permission mode from the screen footer (`readMode`) has its own hard gate on top, because
  `parseMode` does not know the Codex footer and the dialog parser on a foreign screen could produce a false
  `blocked`.
  States map without exception (`working → running`, `idle → waiting-input seen`, `done → waiting-input`, `blocked →
  waiting-permission`), so pushes follow the same policy as for Claude. `gone` of a Codex pane REMOVES the card
  (nothing to resume). **`termId` decides where such an entry leads:** a pane with a `rarog-term` token opens in the
  app as the screen of THAT terminal (list row, banner tap, `rarog://terminal/<termId>?session=<id>`); the Codex
  status screen is only for a pane without a terminal. The server returns no diff for a Codex session (400).
- **Claude in a Rarog terminal: a full session on the server, the terminal as its screen.** `claude` started by hand
  in a terminal tab stands in a pane with a `rarog-term` token, so its card carries `termId`. On the server it is a
  normal in-scope Claude session (follower, screen read, permission hook, background tasks), so the list row, the
  push and the Live Activity know what the agent waits for. The app gives it no tab and no transcript screen: the row,
  a banner tap and the terminal tab lead to the terminal screen with the session status line above it. Two server
  rules apply to such a card only: `gone` REMOVES it from the list, and a token change on a live pane comes as the
  supervisor event `term-changed` and rewrites `termId` without reattaching the driver.
- **Pane provenance and ownership.** After `agent.start` the launcher (`herdr/launcher.ts`) gives the pane the label
  `<tab label> · rarog-claude <key> <trace>` (`pane.rename`; key = 16 hex of `sha256(realpath(cwd))`, trace = 8 hex
  of `sha256` of the tab label set at creation) and a title (`pane.report_metadata`). Label formats and parser:
  `herdr/provenance.ts`. The description in front is the pane's tab label after `normalizeSessionLabel`, cut to 40
  code points, so herdr's "Go to" window and the pane frame name the pane like its tab; an empty description leaves
  the bare `rarog-claude <key> <trace>`. The readers know only the `rarog` prefix (`rarog-claude`, `rarog-term`,
  `rarog-<6 hex>`); any other pane belongs to someone else. They accept a label with or without a description: the
  parser anchors on the suffix at the end, and the supervisor confirms a pane against the label it read, not a
  rebuilt one. The pane label is the only Rarog thing in the herdr snapshot, so it survives a herdr restart.
  OWNERSHIP (`launchedByRarog`: the chip on the card and the `RAROG_MAX_PANES` cap) comes from the herdr agent name,
  which is not the pane label: the launcher passes `rarog-<6 hex>` (`newRarogAgentName`, 3 random bytes) as the
  `name` of `agent.start`. The name can disappear when the herdr start record expires, so the supervisor adds the
  keys of agents the current process started (`launchedKeys`). A key leaves on `forget` and
  when an entry seen with a `rarog-*` name loses it (`namedByRarog`), so a manual `claude` after `/exit` does not
  inherit ownership. A Rarog agent without a name from the start, after `/clear`, cannot be told from another process
  in the same pane and stays Rarog's (a known limit).
- **Tab label = card label.** The manager has ONE place where the label of a herdr session card appears or changes
  (`#setLabel`). Every card label goes through `normalizeSessionLabel` (`server/src/session-label.ts`: control
  characters become a space, whitespace collapses; `labelFromPrompt` keeps 28 characters; an empty result becomes the
  directory name). On a change the manager calls `supervisor.syncTabLabel(key, session.label)`, and the tab gets
  EXACTLY the card text, delayed by 2 s per key (a series of changes = one rename). The tab gets `tab.rename` only when
  the occupant is a `claude` agent, the pane carries a `rarog-claude` label, the tab has ONE pane, and its
  current label is Rarog's (its `sha256[0:8]` equals the trace, or this process left it there). Any other label was
  set by hand and stays untouched. Before EVERY write a fresh `pane.list` confirms the pane address and label; after
  a successful `tab.rename` the pane label gets the card label in front and a NEW trace. With a tab named by hand
  the pane label leads with that name and keeps the old trace. A pane label that already matches gets no write, and
  a tab with more than one pane gets none at all. A pass that ends on a transient obstacle is retried after a
  successful resync (at once, then every 30 s, doubling up to 30 min).
  **Where the label comes from:** a new session's prompt, the pane's terminal title in herdr
  (`terminal_title_stripped`), the first prompt after the `session N` fallback, and the session name from `/rename`.
  The name comes from the transcript: the follower reads the last `custom-title` entry of the current engine session
  (tail window, a needle scan of the part before the window, live growth, a rescan after a truncation, a skipped gap
  or a swapped file with a new `dev:ino`; a newer scan voids an older one), and the driver passes it on as `title`
  with `source: 'custom-title'` in the same read. A known name wins over the terminal title and the first-prompt
  label until the pane writes another conversation (`init` with another engine session ID); `agent-name` does not
  count. Details: `slash-commands.md`, "Session name after `/rename`".
  **Tabs without a provenance label:** a pane with NO label at all, an agent named `rarog-*`, and a single-pane tab
  labelled `basename(cwd)` or `1` → first `pane.rename('<tab label> · rarog-claude <key> <trace of the current tab
  label>')`, then the normal path, on the first sync of a session. It is a heuristic, because the pane may have been
  moved: the worst case of a wrong guess is a renamed tab that holds a Rarog agent. A bare `rarog-claude` label gets
  its description on the same first sync. A closed write channel (`RAROG_HERDR_SEND=0`, an unknown herdr protocol)
  means zero calls and one log line per process. `RAROG_HERDR_TAB_LABELS=0` turns off sync and label adoption; tab
  and pane labels set at creation stay. A tip that Rarog does not apply, because herdr
  configuration belongs to the user: when the herdr sidebar shows `[state_icon, workspace, tab],
  [terminal_title_stripped]`, the second row repeats the Claude tab label; removing `terminal_title_stripped` from the
  second row of `[ui.sidebar.agents]` in `~/.config/herdr/config.toml` is enough.
- **Project workspace.** Where the tab of a new Claude session (launcher) or a new terminal (`term/herdr-backend.ts`)
  goes is decided by the pure function `resolveProjectWorkspace` (`herdr/workspace-resolver.ts`) over a fresh
  `workspace.list` and `pane.list`, with herdr paths passed through `realpath` (`herdr/project-workspace.ts`). A
  CANDIDATE is a workspace whose checkout equals the project directory, or a workspace without a checkout named like
  the directory (`basename`, case-insensitive) or `basename (parent directory)`. Evidence for: a pane with a Rarog
  label of this path (strong) or a pane without a Rarog label with `cwd` in the project (weak); evidence against: a
  Rarog label of another path with the same directory name. A checkout wins; otherwise the only candidate with
  evidence for and none against; a tie goes to the newest workspace this process created for the project. No choice →
  `workspace.create` with the directory name, or `basename (parent directory)` when another workspace has that name.
  Choice AND creation run under a per-process project lock (`withProjectLock(realpath)`, shared by the launcher and
  the terminal), so two simultaneous first creations give one workspace. Lock order: the terminal takes its
  `exclusive` mutex and then the project lock, the launcher only the project lock, `reconcile` only `exclusive`.
  Rarog does not move existing panes
  (`pane.move` is outside the allow-list).
- **Rarog writes to a terminal it does not own.** The rules of that power are security, not architecture, and they
  are binding: `security-model.md`, "herdr sessions".

## Stack

- **Backend:** Node.js and TypeScript through `tsx`, no HTTP framework (`node:http` and a hand-written router in
  `server/src/router.ts`; SSE is a plain `res.write`). Runtime dependencies: `zod` (protocol validation) and `ws`
  (the WebSocket upgrade of the emergency console on the same HTTP server). herdr opens the pseudoterminal; Rarog
  talks to herdr through a process and NDJSON. The only native dependency is `@number0/iroh` 1.2.0 (QUIC, an N-API
  module from a prebuilt platform package for Apple silicon and Linux x64/arm64, no install script) for the iroh
  listener in `server/src/iroh/`. In the server only `adapter.ts` loads it, with a `require()` at call time, so a process
  that does not ask for the library has no native code in memory (guard `server/test/iroh-granice.test.ts`). The
  server asks for it only with `RAROG_IROH=1`; without the flag it starts even with no package on disk. Outside the
  server only the relay canary `scripts/relay-canary.mjs` loads it, in its own process.
  `@anthropic-ai/claude-agent-sdk` has one reader, one function: `listSessions()` in `session-list.ts`, the official
  API for the CLI session list. `install/sdk.ts` loads it once at start, before `listen()`: from the workspace in a
  clone, and in the npm package by explicit path from `<dataDir>/sdk/<version>/`, where `rarog setup` downloads it
  (`distribution.md`, "Claude SDK"). A missing or broken SDK does not stop the start: the server runs with an empty
  session list, and the `sdk` field in `/health` reports the state. The install is THIN, and that is the condition
  for having the package at all: without `ignoredOptionalDependencies` (the CLI platform packages, ~250 MB) and
  `autoInstallPeers: false` (peer dependencies with a whole HTTP stack: express, hono, ajv) `pnpm install` pulls
  that whole stack; with both it is one package of a few megabytes. Only `listSessions` may be imported from the
  package: `query()` needs credentials and costs tokens, and Rarog is a herdr client, not a second engine (guard
  `server/test/sdk-boundary.test.ts`). `drivers/tool-text.ts` repeats a few SDK shapes by hand on purpose, so the
  module stays free of dependencies.
- **Client:** the only client is the native app in `native/Rarog/` (Swift, iPad and iPhone): "Native client" below
  and `native/Rarog/README.md`. There is no web front end.
- **Session engine:** `claude` in a herdr pane. Authentication to Anthropic uses the credentials from `/login` (on
  macOS the Keychain entry `Claude Code-credentials`). `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` and related
  variables are CLEARED in a new pane (`RAROG_CLAUDE_ENV_CLEAR`), so a stale token cannot override a fresh login and
  switch billing to the paid API. The only variable Rarog SETS is `DISABLE_AUTO_UPDATE=true` (`PANE_SHELL_ENV`): the
  pane shell must not ask a question (the oh-my-zsh update prompt) before it takes the command from `agent.start`,
  because such a question eats the first letter of `claude` and the session ends as a card that vanished right after
  start.
- **Infrastructure:** a reverse proxy with TLS on the private network (tailnet) passes only `/api/*` and `/health`
  to `127.0.0.1:8930`; APNs carries pushes to the native app. Outside the server machine run only the relays: the
  push relay (`relay/`) and the iroh relay registry (`relay-auth/`) as Cloudflare Workers, and the iroh relay on a
  VPS (`relay-vps/`); the server itself has no watchdog and no second machine. `rarog serve` starts the server
  (environment from `~/.config/rarog/config.json`, secrets from
  the process environment, an explicit allow-list from the variable registry), and the launchd service
  `ai.rarog.server` from a template keeps it running (`rarog service install`; `RunAtLoad` + `KeepAlive`, domain
  `gui/$UID`, i.e. after the user logs in). `rarog restart` (a lock and the state of the launchd
  services) calls `scripts/restart.sh`, which stops the server and starts it with `launchctl kickstart` (without
  `-k`, which would get the start delayed by launchd), or with `nohup` when no service is loaded. Stopping goes by
  PORT (`lsof -ti tcp:8930 -sTCP:LISTEN`); argv patterns are only a fallback, because
  the command line depends on how tsx builds argv and can stop matching after a tsx update. After the start the
  script compares `uptime` from `/health` with its own start time: an answer from a process that started before the
  restart means the stop missed (the new instance died on EADDRINUSE into the log), and the script exits with an
  error instead of a green OK (`server-config.md`, "`rarog restart`"). The server serves no static client files.

## Transport: SSE and POST, not WebSocket

The SSE stream is a plain `GET`: it carries the device key in the `Authorization` header like every request, and
after a drop the client comes back with `Last-Event-ID` (resume for free). Commands go by POST with the key and an
Origin check. So there is no ticket flow, no credential in a URL and no Origin check for a WebSocket upgrade. iOS
kills EVERY connection when the app goes to the background anyway, so a two-way WebSocket would give nothing.

**One exception: the emergency console runs over WebSocket.** The emergency console is a shell in a herdr pane that
the app shows and types into (killswitch `RAROG_TERM`). It is a different problem: the rule above concerns SESSION
STATE (rare events, free resume, commands by POST), while a terminal is a byte stream in both directions with
keystroke latency that SSE and POST cannot serve. The price is paid openly: the upgrade checks the credential
(`authenticate`: the device key) and `Origin` itself, and a reconnect has no resume. The shell and its history live
in the herdr pane, so a new socket gets a full screen frame instead of a catch-up.

**Second transport: iroh (`RAROG_IROH=1`, `server/src/iroh/`).** iroh is a QUIC library that connects two endpoints
directly over UDP or through a relay. Next to TCP on `127.0.0.1` the server accepts QUIC connections with the ALPN
`rarog-http/1` (`IROH_ALPN` in `shared/src/iroh.ts`), through the relay from `RAROG_IROH_RELAY` or directly over
UDP. Each bidirectional stream is one HTTP/1.1 connection of the same `http.Server`: `listener.ts` wraps the stream
in a `Duplex` (`duplex.ts`) and hands it to `server.emit('connection', …)`, so the router, SSE and the terminal
upgrade have no separate path. The marker in `socket.ts` says that a socket came from iroh; the HTTP layer imports
only that module from `iroh/`. Lifecycle in `index.ts`: the endpoint comes up before `listen` (failure = exit code
1), the accept loop starts after `listen`, and its death outside shutdown = exit code 1. On SIGTERM the listener
shutdown (connections closed with code 0, `Endpoint.close()` with a 3 s deadline) waits together with the manager,
and the 2 s fuse (`shutdown.ts`) starts only after both. The library retries the relay by itself; the listener only
records the start and the first contact (`online()` resolved), the one sign that the relay accepted the server,
which `GET /api/admin/iroh` and the `iroh` line of `rarog doctor` show. `rarog setup` turns the listener on for a new
installation on a machine with the native module (Tailscale next to it when `tailscale` is in `PATH`) and writes the
server key to the secrets file before `config.json`. Authentication boundary and limits: `security-model.md`,
"Layer 1b"; configuration: `server-config.md`, "iroh listener" and "`rarog setup`".

### Two stream scopes (`SseHub`, `server/src/sse.ts`)

- **Global** (`GET /api/stream`): `hello {protocolVersion, serverStartId, minClientBuild?, heartbeatMs?}` →
  `sessions-snapshot` (with `herdrStatus` and `notesCwds`; there is no separate REST call on purpose, because after
  every iOS sleep the herdr banner would lie, and a list of directories with a note would cost a request per list
  row) → deltas. A reconnect always gets a full snapshot.
- **Session** (`GET /api/sessions/:id/stream`): closed messages have `id: <serverStartId>:<seq>` (`seq` is monotonic
  per session, and the prefix names the PROCESS that assigned it); `delta` and `activity` have **no `id`** and do not
  enter the ring buffer. A cursor outside the ring or from ANOTHER `serverStartId` (also one without a prefix)
  gets `transcript-snapshot` + live. The client sends the cursor back verbatim, so the prefix costs the client no
  code. A valid cursor gets the tail from the ring buffer only with 0–1 missed messages; from two on the server sends
  one `transcript-snapshot` frame, because a tail sent frame by frame arrives in bursts and scrolls the transcript
  in the app in several jumps. The snapshot carries the same `seq`, so the app's rows stay.

A heartbeat comment with a `ping` event every 10 s goes to every stream and keeps the reverse proxy and iOS alive;
`hello` announces the interval as `heartbeatMs`. The app ends a stream that got no byte for 1.5 × that interval
(60 s without the field) and reconnects.

The two scopes are SEPARATE connections with no mutual order, so the client keeps one rule: **the session stream
updates a known card but never creates one** (in the app the reducer `RarogCore/Reducer.swift`). Without it a late
`session-changed(done)` from the transcript would revive a card that `sessions-snapshot` had just removed after a
close: a dead card plus an endless "The transcript isn't coming through. Retrying…" banner from a 404 loop.
Likewise `activity`, `permission-pending` and `question-pending` go only to a transcript the client already holds:
an empty transcript would push the ones someone actually read out of the LRU, and the card loses nothing, because
the snapshot carries the full pending lists.

### Event types (`ServerEvent` in `shared/src/protocol.ts`, the source of truth)

`hello` · `sessions-snapshot` · `session-changed` · `transcript-snapshot` · `message` · `delta` · `activity` ·
`permission-pending` · `permission-resolved` · `question-pending` · `question-resolved` · `state` · `git-status` ·
`usage` · `herdr-status` · `notes`.

Card metadata without a frame of its own rides in the session summary (`session-changed`, `sessions-snapshot`), for
example background tasks (`backgroundTasks`, `background-tasks.md`), the artifacts of the current conversation
(`artifacts`, `artifacts.md`) and its pull requests (`pullRequests`, `pull-requests.md`, read from the main file and
all subagent and workflow agent files) and scheduled tasks (`scheduledTasks`, `scheduled-tasks.md`, read from the
main file). The driver sends these fields as events (`background-tasks`, `artifacts`, `pull-requests`,
`scheduled-tasks`); an empty list removes the field, and a change touches neither the session state nor pushes.

Ephemeral (no `seq`, outside replay): `delta`, `activity`, `herdr-status`, `notes`. `notes` carries the project
directory and an `empty` bit; the frame goes to every open client, also one standing in another project, so it
carries no note text, and a client that wants the text fetches `GET /api/notes` ("Project notes" below). There is no
frame about the push channel state: the app learns APNs degradation per token from `POST /api/push/apns/status`.

**Harness notices.** An entry that Claude Code injects into the conversation as a `user` message (the end of a
background task) is recognized by the ORIGIN of the jsonl entry (`origin.kind === 'task-notification'`; fixture
`tasks/measured/postoj.jsonl`, CLI 2.1.296), not by text. The server adds a `notice` field with kind, outcome, name
and exit code (`server/src/herdr/background/notice.ts`, called from `parseImportLine`, so the live path and history
give the same result). A subagent standby (status `completed` with a note that its own background work still runs;
standby means the subagent finished its turn and waits for its own command) gets the outcome `waiting`, not `done`;
the notice asks the same parser as the task list (`background-tasks.md`). The task notification about the end of an
artifact watch gets the kind `artifact-watch` with a title and no outcome (`artifacts.md`). `role` and `blocks` stay
unchanged. Where the server reads `user` messages itself, it applies the effective role: a notice does not swallow a
send echo in the follower and gets no Rarog photos from the companion entry. The Resume list takes the first prompt
from the SDK (`listSessions`), not from these messages. The native client reads only the field: the Swift source
guard forbids harness tag literals.

**The client reads frames with a tolerant decoder, not a strict parser.** A frame that matches the strict contract
passes unchanged. An unknown enum VALUE degrades one field: the `unsupported` sentinel, another fallback value or
no field (list in `implementation-spec.md`). The rest of the frame stays, so a new state of one session does not
take the whole list down. A broken shape and an unknown `type` reject the frame. The reference implementation
of this policy is `shared/src/decode.ts` (subpath `@rarog/shared/decode`): no TypeScript client imports it, and
`shared/test/sse-fixtures.test.ts` checks the golden frame manifest with it (`degrades`), which Swift reads too. The
app has its own decoder in `RarogContract` (a mirror of `decode.ts`; the `DegradationKey` table equals the keys of
`DEGRADATIONS`), and one transport gate (`MutationGate`) stops mutations of `unsupported` sessions; details in
`native/Rarog/docs/code-rules.md`.

**A server sentence travels as text plus its code.** Next to every text the server builds with `say()` the frame or
body carries a `SentenceRef` (`{code, args?}`, fields `…Ref` and the `ref` of a text block), so the app can show the
sentence in its own language and falls back to the English text. A cut text carries `truncation` next to it. A broken
`ref` or `truncation` is a broken shape and rejects the frame. The field list is in `implementation-spec.md`, "Server
sentences".

Every degradation and every rejected frame leaves ONE line in `client.log` (in the app
`RarogCore/ContractReporter.swift`): `kontrakt: /sessions/state=zzz` (path without array indices, value cut to 40
characters) or `kontrakt: odrzucona <type>`. Dedup works on the line text for the life of the process, and the cap
is 50 lines. Dedup remembers only a line that WENT OUT: a line from before login waits in a buffer and goes out after
login.

### HTTP endpoints

This is an overview. Every route, body and response code is in `implementation-spec.md` ("Device keys and pairing",
"Idempotent send", "Per-file diff", "Decision contract: `applied | refused | stale`" and the endpoint chapter).

**Without auth.** `GET /health` always answers 200. A loopback caller gets `{ok, version, uptime, herdr, term, hook,
authStore, sdk, consent}`; every other caller gets `{"ok":true}`, and no probe runs for it (`fullHealthAllowed` in
`server/src/health.ts`). The loopback caller is a TCP request (not iroh) whose `Host`, in any case, is exactly
`127.0.0.1:<port>` or `localhost:<port>` for the server's own local port (on port 80 also without the port, which
`fetch` leaves out) and which carries none of `X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`, `X-Real-IP` or a
`Tailscale-*` header. A tailnet peer, an iroh client and a page that points its own name at the Mac (DNS rebinding)
learn only that the server runs. The CLI (`rarog setup`, `rarog doctor`) and `restart.sh` ask on `127.0.0.1` or
`localhost` and get the fields. The remainder: a proxy that rewrites `Host` to the loopback address and adds none of
these headers gets the fields too. The fields:

- `herdr` is the result of a `ping` on the herdr socket (cap 1.5 s; demo and no integration → `false`) with a 2 s
  validity (`cacheProbe` in the router: TTL plus a single flight). The endpoint needs no key, so probing the socket on
  every request would be amplification: a cheap GET without a key would open a connection to the herdr daemon,
  which controls all panes.
- `term` says whether the emergency console actually came up (`RAROG_TERM=1` + the terminal module), computed once
  at start.
- `hook` (`ok`/`missing`/`mismatch`/`stale`) is the registration of the permission hook (the hook script that hands
  Claude Code permission prompts to Rarog) in `~/.claude/settings.json` and whether the executed copy in
  `~/.claude/hooks/rarog/` matches the repo (`stale` = the entry is correct, the copy differs or holds a file from a
  previous install); 5 s validity, the same logic as `rarog hooks doctor`. `restart.sh` fails on `herdr: false`
  and only prints `hook`.
  The `SessionStart` entry of the context hook (`rarog-context.mjs`, same copy) does not count here: it has its own
  `context:` line in `hooks:doctor`.
- `authStore` (`ok`/`broken`) says whether the device key store `devices.json` loaded at start (`broken` = the file
  and its copy are unreadable, every device pairs again).
- `sdk` (`ok`/`stale`/`missing`/`error`) is the state of the session list SDK at start (`distribution.md`, "Claude
  SDK"); without it the app would show an empty recent sessions list with no explanation.
- `consent` (`{configured, effective, reason}`) is the mode of the consent channel (`server/src/herdr/dialogs/layer1/
  mode.ts`, `server-config.md`, `RAROG_CONSENT_CHANNEL`). It changes only when the server settles the mode after its
  sockets start and on the kill switch (`rarog dialogs off`); the time of the change stays in server memory. A server
  without a mode source (tests, demo) leaves the field out.

Nothing more, on purpose: these fields are STABLE between restarts and reveal nothing that the session list does not
show (or, for the terminal, what anyone sees on the Mac). The age of the last hook run (`hookSeenAgo`, from the
`hook-seen.json` marker, in seconds; `null` = the hook never ran) stands BEHIND auth in `GET /api/version`: the
marker is written on EVERY dialog in every Claude session under Rarog's roots, also at the desk, so on an endpoint
without a key polled every second it would add up to a profile of the person's activity. The second public endpoint
is `POST /api/pair` (pairing by code; the code in the body is the credential). The third, `POST /api/login`, answers
a fixed 410 `login-retired` without reading the body (the server has no token login); over iroh it is 404. In demo
mode without review mode a fourth route comes before the gate: `POST /api/demo/pairing` unpairs every device of the
demo and returns a pairing code `{code, expiresAt, link}` for the app's UI tests, which have no admin socket
(`handleDemoPairing` in `server/src/routes/devices.ts`); anywhere else the path is an unknown route behind the gate.

**Everything else** requires a credential, plus an Origin check for mutations. One function decides,
`authenticate` (`server/src/auth/principal.ts`): the router gate (REST and both SSE streams) and the terminal
WebSocket upgrade call it, and outside `auth/` nothing reads the `Authorization` header (guard
`server/test/auth-principal.test.ts`). The only credential is the device key from pairing (`Authorization:
Rarog-Device <id>.<secret>`); the server does not read `Cookie`. No header → 401 `unauthorized`; a bad or unknown
key → 401 `device-unknown`; the key of a revoked device → 401 `device-revoked` with `revokedAt` and `revokedBy`.

**Global routes:**

- device keys and pairing: `POST /api/pair`, `POST /api/pairings` (a code for a new device), `DELETE /api/pairings`
  (the device cancels its code), `GET /api/devices`, `GET /api/devices/me`, `POST /api/devices/forget`. The
  `/api/admin/*` routes (a code from the Mac and its cancellation, the list, revoking, iroh listener state, release
  and kill switch of the consent channel) exist only on the Unix socket `<dataDir>/run/admin.sock` (`auth/admin.ts`);
  on port 8930 they return 404. The consent channel hook registers its
  secret on a separate socket `<dataDir>/run/consent.sock` with two routes, `POST /register` and the receipt of
  an `allow`, `POST /claim` (`auth/consent-socket.ts`);
- `GET /api/version` → `{version, protocolVersion, serverStartId, voiceEnabled, termEnabled, tailnet, hookSeenAgo,
  hookSeenAgoByFile?, notesEnabled, companionEnabled, companionSpeech, apnsEnabled, capabilities, system, iroh}`.
  `version` comes from the root `package.json`, read once at start (`server/src/version.ts`; `/health` carries the
  same), `hookSeenAgoByFile` is the same age per entry file of the hook copy, `capabilities` lists server capabilities by
  name (`SERVER_CAPABILITIES`), `system` is the server machine's system (`macos`, `linux` or `other`; `serverSystem`
  in `server/src/version.ts`), `iroh` is `{endpointId, relay}` of the iroh listener or `null`. `companionEnabled`
  says that the voice agent works, and `companionSpeech`, equal to it, that it speaks with the Soniox voice
  (`companion.md`, "The route"). The app
  (`VersionInfo` in `RarogContract`) reads a missing `voiceEnabled` as ON, other missing flags as off, missing
  `capabilities` as an empty list, a missing `system` as unknown and a `system` value it does not know as
  `unsupported`, and ignores `hookSeenAgo`. From `system` the app takes the word for the server machine in its
  sentences and on the Live Activity: "Mac" for `macos` and while the system is unknown, "VPS" for any other value
  (`ServerMachine` in `RarogContract`); it keeps the last known system in the device credential, so a start without
  network uses it. A valid `iroh` pair also goes into the device credential, and the next tunnel generation uses it
  (rules: `distribution.md`, "Pairing from the app");
- `GET /api/stream`; `GET /api/projects` (roots and projects from the allow-list); `GET /api/fs?path=` (directory
  listing for New Session, `fs-browse.ts`; `canCreate` says whether the server creates directories);
  `POST /api/fs/mkdir` (one new directory in a listed directory, made by a child process, `fs-mkdir.ts`;
  `security-model.md`, "Creating a directory from the New Session form"); `GET /api/resumable` (the whole history of
  a directory, `listSessions({ dir })`; a conversation alive in a Rarog card carries `liveInHerdr` and that card's
  `sessionId`); `GET /api/resumable/recent?cwd=` (the last few sessions of a project, without open ones); `GET
  /api/projects/recent` (recent PROJECTS: the exact `cwd` of the last 7 days of CLI sessions and of open Rarog
  sessions, the allow-list as a filter before the limit: the recent project pills of the New Session sheet; the
  app's list tree shows only projects with sessions);
- `GET /api/models` (built-in list; the `ultracode` field marks models for which the server turns ultracode on with
  a start flag and a command in a live session); `GET /api/usage` (5 h and weekly plan limits from the
  Claude Code status bar dump whose numbers changed last and the account e-mail from `~/.claude.json`; no account token, no network); `GET
  /api/usage/details` (the usage sheet of the app's `/usage` command: 5 h, week and week per model from the reading
  that Claude Code itself stores in `~/.claude.json`, with its own time; `{}` without a reading); `GET /api/mac` (Mac
  load from the shared sampler `mac-stats.ts`);
- `POST /api/voice/token`: a temporary Soniox key (60 s, `single_use`, `Cache-Control: no-store`);
- `POST /api/companion/token` and `POST /api/companion/speech-token`: the voice agent's short-lived OpenAI Realtime
  key and its temporary Soniox text-to-speech key (`tts_rt`, 600 s, 180 s per stream); both only while the voice
  agent works (`companionEnabled` in `GET /api/version`), no route in demo mode (`companion.md`);
- `POST /api/client-log`: client diagnostics without a cable (NDJSON in `dataDir`). Every line has a `client`
  field: `app/<build>` from the native app (User-Agent `RarogApp/<build>`) or, with another User-Agent, the device
  label from `clientLabel`; version and build are cut to 16 characters `[A-Za-z0-9_.]`;
- project notes (`RAROG_NOTES`; off → 404): `GET /api/notes?cwd=` and `PUT /api/notes` ("Project notes" below);
- `POST /api/presence {clientId, visible, sessionId?}` → 204: the client presence beacon (the app's `scenePhase`)
  that gates notifications ("Notifications" below). Without an APNs channel the beacon is a no-op that answers 204;
- `POST /api/push/apns`, `POST /api/push/apns/unregister`, `POST /api/push/apns/status`, `POST
  /api/push/live-activity` and `POST /api/push/live-activity/end`: token registration, test push, degradation status
  and the Live Activity token. Rules and codes: "Notifications" below and `implementation-spec.md`.

There are no git write routes. Rarog only reads git (the git line, the session diff); `git switch`, `pull` and `push`
from the iPad go through the terminal (`Cmd+G` in the app opens lazygit).

**Session routes:**

- `POST /api/sessions {cwd, prompt, …}` → `{sessionId}`; `cwd` only from `RAROG_PROJECT_ROOTS`;
- `GET /api/sessions/:id/stream`; `GET …/diff/files` and `GET …/diff/file?path=…` (the per-file diff: the list of
  changed files and the patch of ONE file; a path from the request is used only if it is in the list that git printed
  in the same request, `server/src/git-diff.ts`; boundary: `security-model.md`, "Git reads"). The app calls only
  these two; `…/diff` (the whole patch, 512 kB in total) serves app builds that do not call them;
- `GET …/commands`: the slash commands Rarog lets through in the session (`slash-commands.md`, "List for the app");
- `GET …/uploads/:file`: the bytes of a photo from `<session cwd>/.rarog-uploads/` for the transcript thumbnail. The
  directory comes from the session, not the request, and the name must match the pattern of Rarog's own uploads; a
  session out of scope or a Codex entry reads nothing, and a missing file is 404 (`Cache-Control: private,
  max-age=172800, immutable`, because a name is never written twice);
- `POST …/messages`, `…/interrupt`, `…/close`, `…/resume`, `…/restart` (newer Claude Code; with `{resend: {seq,
  id}}` for a prompt blocked by a hook), `…/focus` (`agent.focus`; the app does not call it), `…/seen`, `…/unseen`,
  `…/model` (`{model?, effort?, ultracode?}`), `…/mode` (`plan` ↔ `auto`), `…/permission`, `…/permissions/:permId`,
  `…/answers/:qId`;
- `POST …/companion/ask {question, clientRequestId}` → `{answer, found, prompt?}`: the voice agent asks Sonnet about
  the session's current engine conversation, chosen by the server, through one `claude -p` call
  (`server/src/companion/cli.ts`, the only place that starts print mode); 503 `companion-disabled` without
  `RAROG_COMPANION=1`, no route in demo mode (`companion.md`).

What these routes do beyond the contract:

- **`…/messages`** takes a message only in `running` and `waiting-input`. A pane that Rarog launched gets 409
  `session.not-accepting-messages` in any state until it is ready: it stays in `starting` even when the history of
  a resumed conversation (`init`) or herdr's `idle` arrives first, and it goes back to `starting` when a start
  dialog (trust dialog) closes before readiness. The start prompt of `POST /api/sessions` does not go this way: the
  manager sends it to the pane once the agent is ready (`#finishLaunch`). The app mirrors the rule (`sendBlock` in
  `RarogCore`): the field stays read-only with its draft, and the line under it shows the activity dots and one
  reason sentence.
- **`…/seen`** ("I looked at it on the phone") writes the local marker **and** clears the herdr `done` badge, but
  only for a pane that stands on `done`. herdr has no "mark seen" method; the only lever is `agent.focus`, so the
  price is that every attached herdr client switches its view, remote clients over SSH or mosh included (herdr 0.9.1
  and newer switch all of them). `RAROG_HERDR_SEEN_FOCUS=0` skips the herdr call and keeps only the local marker. The
  app calls it once per `stateSince` for a session on `waiting-input` whose `seen` is not `true` or whose card carries `seenBy`
  (`noteResultViewed` and `seenTarget` in `RarogCore`), so a person opening a result the voice agent picked up takes
  `seenBy` away. In the work states `starting` and `running` the server only clears a waiting push
  (`notifier.seen(id)`), because a glance during a turn does not take a result that does not exist yet. A body
  `{by: "voice-agent", conversation, readMark}` is the voice agent's pick-up of the result it read: the same
  receipt with the same effects, `agent.focus` for a pane on `done` included, plus `seenBy` on the card. The server
  takes it only for a session in `waiting-input` with no decision card waiting on it, in the engine conversation the
  agent read, with no message in its memory newer than the turns read and the `stateSince` of that read (`readMark`),
  and answers 409 with no effect otherwise (`docs/companion.md`, "Picking up a result").
- **`…/unseen`** ("mark as unread") undoes the taking of a STANDING result: on `waiting-input` with `seen: true` the
  field goes back to `undefined`, and the store writes an `unseen` entry under the current state number (it survives
  a Rarog restart). The card then carries `markedUnseen: true` until the result is taken or a turn starts, and loses
  `seenBy`. Local only: no herdr call, no `RAROG_HERDR_SEND` gate, no notifications.
- **Decisions** (`…/permissions/:permId {decision}`, `…/answers/:qId {answers[]}`, `…/permission` for a dialog
  outside jsonl) have four codes, because four things can happen to a tap: **200** the key went out (`applied`);
  **409** the decision on this card was ALREADY made; **410** the request expired or the pane does not show it;
  **422** `{error: 'refused', reason, message}`: Rarog did NOT send a key (screen mismatch, no unambiguous digit, a
  multi-question form, or `in-flight`). After 422 the card STAYS on the phone with the reason at the button, because
  the dialog still stands in the terminal.
- **Question channel.** A question card NAMES its answer channel (`QuestionRequest.channel`; missing = `keys`).
  `keys`: the answer goes as a DIGIT from the screen, so the card carries exactly one value per question. `hook`: the
  answer goes as a FILE for the waiting hook (`answers/` under "Persistent state on disk" below), so the card carries
  ALL questions of the `AskUserQuestion` call, labels come from the payload, and multiple choice is a plain
  selection. Such a card exists only after a screen cross-check with the hook dump; a `tool_use` entry in jsonl is
  then a CHECK, not the decider (CLI 2.1.267).
- **Notes channel.** A `hook` card question with a preview and single choice gets `notes: true` when the Claude Code
  process of the session is release 2.1.288 or newer. `…/answers/:qId` then accepts `notes[]` parallel to
  `answers[]` (`checkAnswerNotes`; otherwise 400), and an answer with a note goes ONLY as a file (otherwise 422
  `send-failed` without a key).
- **Dialogs herdr does not see.** The driver keeps judging a pane as blocked (`#blockedNow`) in two fallbacks
  (`drivers/herdr/form-reserve.ts`, `drivers/herdr/cli-reserve.ts`): a
  waiting `AskUserQuestion` (jsonl or the hook dump) with a form on a fresh screen read, and the CLI session registry
  `~/.claude/sessions/<pid>.json` with `status: waiting` (read every 1.5 s, `CLI_WAITING_POLL_MS`, with
  `RAROG_CLI_WAITING` ≠ `0`; each read nudges a fresh screen read, at most 4 per `waiting` episode,
  `CLI_WAITING_PROBES`). The registry fallback ends when the registry stops saying `waiting` or the screen shows the
  prompt field twice in a row (`CLI_HOLD_MISSES`). Right after Rarog's own answer (a digit from a card, a hook answer
  file, or the digit that confirms a `/model` or `/effort` dialog) the registry fallback does not start and misses do
  not end it, for 8 s (`ANSWERED_HOOK_SHIELD_MS`) or until the first `active` from the registry.
  A card
  without buttons carries `SessionSummary.herdrDialogReason` (`REFUSE_REASONS`) and the dialog class from the
  registry, `SessionSummary.cliDialog` (also after the card, in a `cli-dialog` event); only `herdrDialog` (recognition from a
  closed list of signatures) decides the Allow button. Details: `dialogs.md`, "Dialog block".
- **`SessionSummary.cliUpdate`** rides the GLOBAL channel: the pair of Claude Code releases `{running, installed}`
  when the process of a live in-scope Claude pane runs an older release than the installed one. Every 30 s the
  manager reads the `~/.local/bin/claude` link and the CLI process registry (`server/src/cli-version.ts`); a read
  error = no field. The same read carries `startedAt`, which the background task state machine uses to close
  subagents and monitors from before a CLI process restart (`background-tasks.md`, "CLI process restart: the agent does not
  survive it").
- **Restart** (`POST /api/sessions/:id/restart`) runs in three stages: (1) synchronous gates and the reservation of
  the card before the first `await`; (2) reads without sending (`driver.restartProbe()`, the CLI registry, `claude
  agents --json`) with a 4xx refusal before anything else; (3) `driver.requestExit()` and a 202 answer. In the
  background `#completeRestart` waits until the process is gone, the card goes to `resumable`, and `#recreate` (the
  same path as `resume()`) opens a new tab with `--resume` under the same id; `#finishLaunch` closes the reservation.
  Stages 2 and 3, the reservation and the note after the restart live in `server/src/sessions/session-restart.ts`;
  the manager keeps stage 1, `#recreate` and `#finishLaunch`.
- **Restart with resend:** the body `{resend: {seq, id}}` under the notice of a prompt blocked by a hook. The server
  takes the payload from the `recentSends` ring and passes it through a dry text guard; a field full of OUR prompt is
  cleared first (`driver.clearBlockedLeftover()`, an Esc pair only on `filled`), and the restart goes on only on an
  empty field. After the new process starts, `#finishLaunch` adds the restart notice and sends the prompt by the
  start prompt path. The log entry `restart` has `reason` `cli-update` or `prompt-blocked`.
- **`SessionSummary.waitingFor`** rides the GLOBAL channel too: a summary of the standing decision for the LIST
  (`kind`, `tool`, `text`, `count`, for a permission also `subject`). It is COMPUTED in `#summaryOf` from the
  `#pending` queue and stored nowhere, rides ONLY in the decision states `waiting-permission` and `waiting-question`
  (`DECISION_STATES`), and `text` is the first line of the content cut to `WAITING_TEXT_MAX` (120 characters). The
  client composes the line (in the app `UICopy.waitingLine`).
- **`…/focus`** and **`…/close`** with `closePanel` answer **409** with a sentence on a dead herdr socket, not 500.
- **`…/interrupt`** is the ONLY endpoint that waits for the effect: it returns `202 {ok, session, delivered,
  returnedPrompt?}`, where `delivered` says whether `escape` reached the pane and `returnedPrompt` is the prompt
  Claude Code handed back to its field after a delivered key
  (`implementation-spec.md`, "`returnedPrompt`: the prompt back in the field"). The wait has a deadline
  (`INTERRUPT_WAIT_MS`; after it `'pending'`), because the client retries after 10 s. The manager swallows repeats (one in-flight promise per session
  plus a one-second debounce), because requests also come from a second device and from network retries.

### The `seen` flag

`SessionSummary.seen` is NOT a mirror of the herdr marker. It answers the question "was the result of the CURRENT
turn taken", by the person or by the voice agent; `seenBy` says when it was the voice agent:

- `undefined`: the turn runs or the result waits. The manager resets the field on `turn-start`, `agent-working`,
  `resumed` and `agent-blocked` (a list of EVENTS: `permission-resolved`, `question-resolved` and `driver-init` lead
  to `running` too but start no turn; `agent-blocked` leads elsewhere but starts a turn, because someone moved the
  agent at the desk). The internal memories reset with it: `herdrSeen`, `seenByHuman` and `seenBy`.
- `false`: herdr confirms a standing `done` badge; there is something to take, and ONLY this value allows
  `agent.focus` from `…/seen`.
- `true`: taken: `POST …/seen` from the phone, the voice agent's pick-up (`POST …/seen` with `by`, which also sets
  `seenByHuman` and `seenBy`), `POST …/focus` outside the work states `starting` and `running`, or herdr `idle`
  AFTER `done`. A person's receipt after the pick-up keeps `true` and drops `seenBy`. `POST …/unseen` sets it back
  to `undefined` and resets the internal memories, `seenBy` included. herdr `idle` without `done` before it means
  only "the pane was on top when the turn ended" and does not touch the card; the internal field `Session.herdrSeen`
  keeps the raw value from the driver. The second internal field, `Session.seenByHuman`, remembers that a person or
  the voice agent took the result, so a `done` that arrives AFTER the tap does not undo it (it only moves the
  durable marker to the new state number): the tap comes before `done`, because Rarog sees the end of a turn first
  in jsonl.

The app derives the row rank from it (`listRank` in `RarogCore/Selectors.swift`: an untaken result stands ABOVE the
working sessions, a taken one goes below them) and the dot tone (`statusTone`); the push policy uses the
`resultSeen` field for the `done` class. A known cost: a result read at the desk on a focused pane stays at the top
of the list until a tap on the phone.

### Emergency console

The whole feature goes off with `RAROG_TERM`; then every endpoint below returns 404. Contract of the routes and
frames: `implementation-spec.md`; the power it gives and its limits: `security-model.md`, "Emergency console".

- **`POST /api/term {cwd, slot?}` → `{id, slot}`** registers a PROJECT terminal. A terminal is the pair
  `(directory, slot)`, up to `TERM_SLOTS_MAX` (4) tabs per project. Idempotent: the id is `sha256(realpath(cwd))` for
  slot 1 and `sha256(realpath(cwd) + NUL + N)` for slot N ≥ 2, cut to 16 hex, so the same pair always gives the same
  terminal. **Slot 1 has no suffix**, so a client that sends only `{cwd}` hits slot 1 exactly; the same values sit in
  the `rarog-term` tokens of live panes and in the app's `rarog://terminal/<id>` addresses. `realpath` is NATIVE (the
  spelling on DISK): on macOS `…/RAROG` and `…/rarog` are one directory, while `realpathSync` in JS keeps the input
  spelling and would give a second identity. An entry adopted from the state file with an id from another spelling
  keeps its identity, and the registry finds it by directory in the disk spelling, not by id. `slot: 'next'` means
  "open another one": the SERVER picks the number (the lowest free one, also a gap after a closed tab) and returns it.
  `cwd` goes through `validateProjectCwd`. Refusals are **409**: all slots of the project taken OR `RAROG_TERM_MAX`
  live PTYs in the whole server (two different measures: the first counts registry ENTRIES, the second STREAMS). The
  order of checks is binding (killswitch → `realpath` → EXISTING ENTRY → caps), so RETURNING to an open terminal never
  gets 409.
- **Popup roles `lazygit` and `popup`:** `POST /api/term {cwd, role}` (without `slot`; with it 400) → `{id, slot: 0,
  role}`. A separate herdr pane (tab `rarog lazygit · <directory>` or `rarog popup · <directory>`, the same
  `rarog-term` token), OUTSIDE slots 1–4 (no tabs; the app filters by `role` in `TerminalListState.shells`), but
  counted in `RAROG_TERM_MAX`. Id = `sha256(realpath(cwd) + NUL + <role>)`; `lazygit` and `popup` of one directory
  are TWO panes and may exist at once. The shared question "outside slots" is `isPopupRole` in `shared`. The roles
  differ in EXACTLY one thing, the start command. herdr takes no command at `tab.create`, so for `lazygit` the
  REGISTRY types ` exec lazygit\r` into a FRESH pane (`handle.fresh`), once per entry life, at the first output chunk
  or after 1.5 s; never on respawn, adoption or for the `shell` and `popup` roles. Rarog types NO BYTE into a `popup`
  pane (`armLazygitStart` asks for the exact role, not `isPopupRole`). The end of a popup entry is shared: `q` in
  lazygit or `exit` in the shell ends the shell → the pane dies → clients get `exit`, and the entry LEAVES the
  registry (no `failed`, no fuse); the next POST opens a fresh pane. A FRESH pane dies with its entry
  (`killSession`) only as an orphan: for lazygit when the stream fell before the start went out (otherwise the next
  POST would adopt a pane with a bare shell and `fresh: false`, i.e. without the start), for `popup` ONLY when the
  stream never came up, because the pane runs a shell with a person's work from the first moment. An adopted pane is
  never killed in any role, with one exception: an explicit lazygit open on a pane with a bare shell ("What survives
  a restart" below). Adoption after a restart tries the id of EVERY popup role. `GET /api/term` carries `role` in
  every entry (missing = `shell`).
- **`GET /api/term` → `{terminals: [{id, cwd, live, slot, proc}]}`**: the list for the project tab bar. `proc` is
  the name of the shell's foreground process (`nvim`, `codex`, `zsh`) from `pane.process_info`, through a backend
  cache with a 5 s TTL; **an empty string means "not known yet", not "no process"**. The answer is SYNCHRONOUS and
  does not wait for herdr on purpose (a read is ~110 ms at p90 per pane): it returns the last known value, and the
  refresh starts after the answer. So the first list after a server start carries `proc: ''`.
- **`GET /api/term/:id`: WebSocket upgrade** (outside the HTTP router, under `server.on('upgrade')`). Authorization
  BEFORE `handleUpgrade`: the credential (`authenticate`, the device key from `Authorization`) + `Origin`; every
  refusal is `socket.destroy()`. `?fresh=1` = the client has a FRESH emulator (the app opens every socket with
  `fresh=1` and resets the emulator before the full frame). In practice EVERY new socket respawns the controller
  (`respawnOnAttach` in the backend), with the parameter or without: the herdr controller sends a full frame, i.e.
  anything to draw, only at start, and takes the size from the spawn arguments. `?direct=1` = a try socket WITHOUT a
  preceding `POST /api/term` (the client knows the id; the native app sends it at screen start and on return from the
  background, for a tab shell and the Cmd+F window). Such a socket is dropped wherever only `POST` knows the way out:
  no entry, a `failed` entry, a handle to recompute (`handleStale`) or the `lazygit` role. The gate is
  `TermRegistry.attachableDirect`; the reason goes to `server.log`, and the client answers with `POST` and a normal
  socket. A socket WITHOUT a marker passes with an entry in the registry alone and gets a refusal as an `err`/`exit`
  frame. Refusing every socket on a handle to recompute would spin `POST` in a loop: the handle guard sets it
  asynchronously, after the `POST` answer.
- **Frames.** Server → client: `binary` frames = raw shell bytes; text frames `{"t":"hello","backend"}`,
  `{"t":"exit"}` and `{"t":"err","msg"}`. Client → server, text: `{"t":"in","d"}` (≤ 8 kB), `{"t":"rs","c","r"}`,
  `{"t":"sc","d","c?","r?"}` and `{"t":"pa","d","e"}` (a paste chunk, ≤ 8 kB). A `binary` frame from the client, or
  `in`/`pa` over the limit, closes the connection. `hello` is the FIRST text frame of a socket that passed attach
  (with `failed`/`limit` it is not sent, so it never precedes `err`) and carries a fixed value (`herdr`).
- **A paste goes in `pa` frames, not `in`.** The herdr 0.9.3 controller does not pass `?2004h`, so the client
  emulator does not know about bracketed paste, and a paste in `in` frames would go raw, every line end an Enter. The
  server joins the chunks of one socket up to `e: true`, strips `ESC[200~`/`ESC[201~` markers from the text
  (repeatedly; an end marker in the clipboard would run the rest as keys), turns line ends into `\r`, wraps the whole
  and sends ONE `terminal.input` (`term/paste.ts`, `term/ws.ts`). herdr recognizes exactly one paste and encodes it
  again by the mode of the program in the pane: wrapped with 2004 (zsh and Claude Code keep the lines in the field),
  plain text without 2004. Cap 512 kB of text (`TERM_MAX_PASTE_BYTES`): the app checks it before sending (over the cap
  it sends nothing), and the server drops an excess whole with a log entry, without an `err` frame (that would stop
  reconnect). A dropped socket or an `in` in the middle of a paste empties the buffer; half a paste never goes out.
- **Scroll frames.** `sc` asks to scroll by `d` rows (positive = down, limit ±200 IN ZOD; a frame outside the range does
  not parse and closes the socket with code 1002) and may carry the CELL UNDER THE FINGER (`c`/`r`, 1-based, limits
  as in `rs`): herdr routes the wheel to the app pane under that cell (`column`/`row` in `terminal.scroll`); without
  an address the wheel does NOTHING in an app with panes (lazygit). The server joins frames within 16 ms: the row sum
  and the LAST cell go out in **≤ 8 calls** of `terminal.scroll` (`HERDR_SCROLL_CALLS_PER_TICK`; the first carries the
  surplus, the rest one row each). The split is needed because herdr in a mouse app makes ONE wheel tick from ONE
  call regardless of `lines`, and Rarog cannot recognize such an app: the full controller frame carries no `DECSET
  1000/1002/1006` (only `?2026` and `?25`), so the client does not see the mouse mode and the finger goes as `sc`. For
  the shell scrollback only the row sum counts. Joining is a FREQUENCY cap (8 RPC per 16 ms): every NDJSON line on the
  controller's stdin is an RPC to the herdr daemon, the control plane of all panes. The app sends the surplus over
  ±200 in further frames (`TerminalFrames` in `RarogContract`).
- **`DELETE /api/term/:id` → `{}`** closes the terminal, i.e. kills THAT shell: `pane.close` of the pane with the
  `rarog-term` token.
- **`GET /api/term/:id/history?lines=N` → `{text, truncated}`**: the shell HISTORY as plain text (`pane.read`, source
  `recent_unwrapped`, `strip_ansi`). The scrollback lives in the herdr pane, not in the client emulator, so the app
  shows this text in a History sheet (a read-only `UITextView`) with native selection. `lines` defaults to 1000, cap
  5000; a larger value is CUT, not rejected. Ownership gate as for `DELETE`: a fresh `pane.list` and a `rarog-term`
  token whose VALUE equals the terminal identity; a foreign or missing pane is **404**, a dead herdr socket **503**.
  `RAROG_HERDR_SEND=0` does NOT turn this route off (`pane.read` is a read method); the text goes neither to the log
  nor to disk.

**The herdr PANE keeps the shell alive.** The backend contract is `server/src/term/backend.ts`, the only
implementation `herdr-backend.ts`; the interface stays, because it is a clean registry/transport boundary and it lets
the registry tests inject fakes. The registry holds sockets, the grace period, the cap and the respawn fuse; the
backend answers only "how to create", "how to attach", "how to kill". What follows from that:

- **Where the shell lives.** A PANE in the tab `rarog <slot> · <directory>` (popup roles: `rarog lazygit ·
  <directory>`, `rarog popup · <directory>`), visible on the Mac like any other. The pane carries TWO Rarog marks: the
  token `rarog-term = <id>` (`pane.report_metadata` without TTL; the only gate of power: lookup, `--takeover`,
  `pane.close`, `pane.read`) and the PANE label `<tab label> · rarog-term <id>` (`pane.rename`; proof of origin that
  herdr keeps in its snapshot, so it survives a herdr restart; the token does not; the tab label in front names the
  pane in herdr's "Go to" window). A new pane comes from `tab.create` in the project
  workspace ("Project workspace" above) or from `workspace.create` when there is none, and gets both marks at once; a
  failure of either CLOSES the fresh tab, because a pane without marks is invisible to Rarog and every next `POST`
  would open another one. The token is stamped again at lookup, on every stream attach and on a 4 h tick.
- **Recovery by label (`reconcile`).** One backend operation, one pass at a time, under a mutex shared with pane
  creation: a label without a token → the token comes back; a token without a label → the label; an identity on more
  than one pane, or a label next to another token → a conflict (nothing happens, a log line). A pane that herdr did
  not restore after its restart (`restore_error`) does not exist for the terminal. Before EVERY write a fresh
  `pane.list` confirms the pane at that address, because addresses are positional. Callers: the server start, the
  4 h tick and `ensureSession` before creating a pane. When the start cannot read herdr (socket down), the whole
  start sequence (recovery, reaper, adoption) runs again every 30 s until one pass reads herdr, then stops; not when
  the backend refuses (`RAROG_HERDR_LAUNCH=0` or `RAROG_HERDR_SEND=0`). A pane with THIS terminal's label but
  without its token is a refusal with a sentence in an `err` frame (`term.recovering`), never a second tab. Recovery
  closes and creates nothing; its last step renames single-pane tabs with a short Rarog label to the format above
  and puts the tab label in front of a bare `rarog-term <id>` pane label, both only when the terminal identity
  matches the directory from the state file or the pane's `cwd` (`RAROG_HERDR_TAB_LABELS=0` turns this step off).
- **What carries the stream.** The process `herdr terminal session control <pane> --takeover --cols N --rows N` (the
  herdr binary from `RAROG_HERDR_BIN`) and NDJSON: `terminal.frame` (base64 ANSI, full or differential) up,
  `terminal.input`/`terminal.resize`/`terminal.scroll`/`terminal.release` down. Rarog opens no pseudoterminal itself.
- **Two devices at once: ONE controller per pane.** Every new socket respawns the controller and takes the size of
  the LAST device: the pane on the Mac changes with it while attached (an accepted cost). Rarog's own intended respawn
  is not a takeover: the registry marks it `plannedKill` and mutes the `terminal.closed` that follows.
- **Pane size after release.** After `terminal.release` herdr lifts the size lock WITHOUT recomputing: the pty stays
  at the phone size until a herdr client looks at the tab, and a CLI dialog taller than the pane loses its header. So
  the release after the grace period (and only that one, `release({ restoreSize: true })`) first reads the tab layout
  (`pane.layout`, cap 1 s), sends `terminal.resize` to the size from the layout through Rarog's OWN controller, and
  only then `terminal.release`. The size is the pane rectangle minus the scrollbar gutter column, the herdr 0.9.5
  formula (`termRestoreSize`; measured: rectangle 128×52 → pty 127×52). A split tab, the layout of another pane,
  dimensions outside 1…1000, an error, a dead controller or a successor attached during the read give a plain
  `terminal.release` and a log line. A respawn for a new socket, `DELETE`, server shutdown and a foreign takeover do not
  restore at all. A Rarog restart during the grace period leaves the pane at the phone size.
- **The scrollback is on the other side.** The controller sends the SCREEN, not a stream (a full frame starts with
  `ESC[2J`, differential ones rewrite cells in place), so the client emulator has `scrollback: 0`, and the only
  scrolling without mouse mode is the `sc` frame. To TAKE a piece of history off the phone, Rarog asks herdr
  (`pane.read`, `GET /api/term/:id/history`). A reconnect respawns the controller, which starts with a full frame;
  the controller protocol has no "redraw" command, so that is the only way to get one.
- **What survives a restart.** The shell survives a RAROG restart: the registry lives in RAM and rebuilds from the
  backend's `listSessions()` by pane token. The shell does not survive a HERDR restart (also on `herdr update`): herdr
  restores the panes with a bare shell (a known, accepted cost). The PANE survives: the token comes back from the
  label, so opening the terminal does not create a second tab. An EXPLICIT open of the `lazygit` role on a pane with
  a bare shell closes it and creates a fresh one; a live lazygit and another program stay.
- **When the shell dies.** `DELETE /api/term/:id` → `pane.close`, plus the idle reaper at server start (it closes a
  shell pane that has been silent for `RAROG_TERM_IDLE_DAYS` days, default 7, by the age in `term-herdr.json`), ONLY on a
  pane that carries, in a FRESH `pane.list`, a `rarog-term` token whose VALUE equals this terminal's identity (pane
  addresses are positional, so the mere presence of a token would let the shell of another project under the knife).
  ATTACH uses the same gate, because `--takeover` evicts a foreign controller. Losing the last socket does not kill
  the shell: after the 120 s grace period only the stream dies ("Pane size after release" above).
- **The shell gets one marker.** `tab.create`/`workspace.create` of a terminal carry `RAROG_TERM_PANE=1`, an
  explicit "opened from Rarog", so the shell configuration can behave differently than at the desk (a prompt drawn to
  the right edge leaves a copy at every narrowing of the pane, and herdr fits the pane to the controller at every
  attach). Rarog does not write the shell configuration; the terminal env carries no other Rarog value.
- **Killswitches and state on disk.** Its own `RAROG_TERM` AND, because the shell is a pane, `RAROG_HERDR_LAUNCH` and
  `RAROG_HERDR_SEND` (without them `POST /api/term` returns 409 with `herdr-launch-off`/`herdr-send-off`). On disk:
  one file, `<dataDir>/term-herdr.json`, with the pane age for the reaper and the terminal's creation directory, ZERO
  content.

A foreign takeover of the pane (`terminal.closed` with the reason `taken over`, i.e. another controller came in with
`--takeover`) puts the entry into `failed` with an `err` frame and WITHOUT a respawn; otherwise two Rarogs would
fight over the pane in a loop. There is one way out of `failed`: another `POST /api/term`.

### Protocol version

The protocol version rides in `hello`. A mismatch **does not break the stream**: the app keeps reading but refuses
every mutation with a banner whose text depends on the DIRECTION (`Compatibility` in `RarogCore`): a newer server
asks to update the app; a newer app (a server not restarted after a `PROTOCOL_VERSION` bump) asks to restart the
server (`rarog restart`).

Next to the version, `hello` carries the optional `minClientBuild`: the NATIVE client build threshold from
`RAROG_MIN_CLIENT_BUILD`, absent when the variable is not set. The server refuses nothing by it: it is a signal for
the app (a lower build = `tooOld`, "update the app"), not a permission gate (`implementation-spec.md`, "Native client
build threshold").

The app also knows the server version it ships with (`ServerRelease.version` in RarogCore, equal to `version` in
`package.json`). When `version` from `GET /api/version` is lower by semver, the list footer shows "Server update
available" with the update command in the Usage sheet. It is a hint, not a gate: nothing is refused, and no request
goes out beyond the version probe (`distribution.md`, "Server update indicator").

## Notifications (`server/src/notify/`)

Rarog sends push notifications itself, over ONE channel: **APNs** to the native app. An `alert` banner goes from the
Mac over HTTP/2 to `api.sandbox.push.apple.com` (or `api.push.apple.com`, by the app's `aps-environment`) with a JWT
ES256 provider token, or through the push relay when the entry has a pass (below); a tap opens the session in the
app. The same channel carries the state of the app's aggregate **Live Activity** (below). `RAROG_PUSH=0` turns off
banners and the Live Activity together. Without a complete `RAROG_APNS_*` set and without `RAROG_PUSH_RELAY_URL`
Rarog sends nothing: the scheduler is not created, and `POST /api/presence` is a no-op. The server, not Claude Code
hooks, sends pushes for one reason: **presence**.

The push relay (directory `relay/`) is a stateless Cloudflare Worker that issues passes to servers per token and
sends their pushes with its own APNs key. The server sends entries with a pass through it when
`RAROG_PUSH_RELAY_URL` is set; entries without a pass go with the key on the Mac, when there is one. The APNs
channel exists with a key OR a relay. The `/v1/*` contract, response matrix and operations: `relay/README.md`;
examples: `shared/fixtures/relay/`; server-side schemas: `shared/src/relay.ts`.

Presence cannot be guessed on the Mac: keyboard idle time (`HIDIdleTime`) and the `atime` of all `/dev/ttys*` answer
only "are you touching a TERMINAL". Working in Rarog on the phone touches neither the Mac keyboard nor any tty, so a
push computed from them would go to someone who is looking at the same session on screen.

Rarog does not guess: the client reports visibility with `POST /api/presence`. An open SSE socket alone is NOT
enough (iOS suspends the app, and the socket hangs on for a while), so presence has a **40 s TTL**
(`PRESENCE_TTL_MS` in the protocol, because it is a contract of two sides), the app refreshes it every 20 s
(`presenceInterval`) and sends `visible: false` at once when it goes to the background. **No data = ABSENT**: after a
server restart, on a broken tailnet, with a client that does not send the beacon.

### Module split

- `policy.ts`: PURE rules. `classify()` maps a state machine **event** to a class (`blocking` / `failure` / `done`),
  `decide()` gives the verdict after the window (`send` / `drop`). Both get the number of background tasks that are
  WORKING (computed by `herdr/background/work.ts`): a `done` with live background work is silence, and an armed
  `done` drops when background work started after the end of the turn. `classify()` also gets the turn input since
  the previous turn end (`turnInput`, computed by the manager) and returns silence for a turn without a result
  (`noResultTurn`: a turn caused only by a subagent standby notice or an artifact watch notice, after which the main
  agent used no tool). A `done` owed from a plain turn before it stays owed (`leavesResult`, `doneStaysOwed`): it
  waits while a subagent in standby has a live own command (`waitingOnOwnCommand`) and goes out without a turn when
  the task list stops holding it (`holdsOwedDone` → `NotifierLike.quiet`, the scheduler interface's fourth method
  next to `note`, `seen` and `forget`).
- `presence.ts`: who looks, and at which session.
- `content.ts`: PURE banner content, built with `say()`: a title per event KIND plus the project (the sentence
  `push.title.<kind>`, its code from `shared/src/notify-copy.ts`, the emoji first), a `body` of at most 120 characters
  (tool + session label, the question, the result sentence, the state sentence of an error or a limit), each with its
  `titleRef`/`bodyRef`, `topic` = the short session id (coalescing displaces an older message about the same CASE, and the case
  is the session), `TTL`/`urgency` per class, the badge and the tap TARGET (`kind`, `sessionId`, `termId`).
- `apns-payload.ts`: PURE: content → APNs request. An `alert` is always encrypted: `aps` carries only the placeholder
  with `mutable-content: 1` (`RELAY_ALERT_PLACEHOLDER`; for an entry with the `locKeys` declaration the catalog keys
  `ALERT_PLACEHOLDER_KEYS`), and content plus tap target ride in the `rarog` block (`{v: 3,
  kid, n, c}`) under the push key of ONE device; the plaintext is cut to 2048 B, and a payload over 4096 B skips the
  entry. `done` (`badgeOnly`) is the BADGE ALONE. `apns-collapse-id` = the content `topic`, `apns-expiration` = an
  absolute time, `apns-priority` 10 for urgent cases and 5 for `done`. The same module builds the Live Activity frame
  (`apnsLiveActivityRequest`, push type `liveactivity`); only its `chime` option adds `aps.alert`
  (`LIVE_ACTIVITY_CHIME`, with `locKeys` `LIVE_ACTIVITY_CHIME_KEYS`; sound `skonczyl.caf`).
- `push-crypto.ts`: PURE, no logs: banner encryption in format 3 (HKDF-SHA256 over the device `pushKey` from
  `devices.json`, ChaCha20-Poly1305, padding to a multiple of 256 B). The app side: `PushCrypto.swift` and
  `PushEnvelope.swift` in `RarogContract`; vectors in `shared/fixtures/push-crypto/`.
- `apns.ts`: the direct sender on `node:http2`: one HTTP/2 connection per environment, a JWT ES256 in memory renewed
  every 50 min. `410` and `400` `BadDeviceToken`/`DeviceTokenNotForTopic` → `gone`; `403 ExpiredProviderToken` → a
  new JWT and ONE retry; `InvalidProviderToken`/`BadEnvironmentKeyIdInToken` → the environment is off until restart;
  `5xx` → the environment pauses for 15 min. It logs only the code and reason, never the JWT or the device token.
- `sender.ts`: the ONLY place that picks the route of one send: a valid pass (`usablePass`) → the relay
  (`relay-sender.ts`); without one → the direct sender when there is a key; otherwise no attempt (`pass-missing`). The
  token status (`statusOf`) and the test push wait for a route (`awaitRoute`) live here too.
- `relay-sender.ts`: the relay client (`POST /v1/pass`, `POST /v1/push`; a 10 s cap, no redirects); with fixed inputs
  the requests equal the fixtures in `shared/fixtures/relay/`. Apple results map by the same rule as `apns.ts`, `401`
  = a pass to exchange, `503` = the route is silent for 15 min. It logs the code, never a token, pass or payload.
- `relay-pass.ts`: the ONLY place that orders, renews and removes passes (entries with `RELAY_APP_TOPIC`; after a
  registration, at server start, hourly when expiry is under 7 days away, and on `renewedPass`). The Live Activity
  pass is ordered after a fresh device pass, because the relay issues it at most until that pass expires. The queue
  runs in order with backoff per token and a shared one; `422 BadDeviceToken` without any 200 → `env-mismatch`.
- `apns-devices.ts`: the device registry `apns-devices.json` (fields: "Persistent state on disk" below). One entry per
  device and topic: a new token displaces the device's previous one (a switch of build channel, a token rotation). A
  `liveActivity` block moves to the new entry only in the same environment, because after a restart the app does not
  register an activity it finds, and without the move a live Live Activity would lose its updates and its end.
- `apns-sink.ts`: a banner to EVERY entry with `alerts: true` in parallel. An entry gets a format 3 banner only when
  it declared format 3 (`pushFormats`), the `RAROG_PUSH_E2E` flag is on and its `deviceId` is an ACTIVE device;
  otherwise it is skipped with a reason line. `gone` removes the entry, unless the app registered the token again
  after the revocation time. Result: `delivered | failed | no-receiver`. `sendWhere` filters entries: the
  `device-paired` push goes only to the other active devices.
- `fanout.ts`: the scheduler sink for the one channel (APNs): it catches a sink exception and returns the send report;
  for `done` it calls the Live Activity driver's `chime()` before the badge send.
- `apns-channel.ts`: the ONLY place where the APNs channel is created (registry, sender, sink, Live Activity driver,
  passes, the weekly-limit signal), only with `pushEnabled` and a complete `RAROG_APNS_*` set OR
  `RAROG_PUSH_RELAY_URL`. The server topic `RAROG_APNS_TOPIC` goes only to the router (compared with the
  registration `topic`); the sink and the Live Activity take the topic from the entry.
- `live-activity-state.ts`: PURE: session list → Live Activity content state. Counters: `waiting`
  (`waiting-permission` + `waiting-question`), `working` (`starting` + `running`, plus a session after its turn with
  live background work) and `finished` (`waiting-input` with `seen !== true` and no background work). A subagent in
  standby is not live work; the rules come from `herdr/background/work.ts`. `top` = the tap target. Up to two workflow
  runs from `backgroundTasks[].run`, with a segment per phase (`phaseCounts`) and the current phase from
  `workflow-phase.ts` (the same rule as `ActivityText.currentPhase` in the app). `isBusy` (a decision, work, an open
  run) drives the silence clock; a background command does not hold it, because a dev server would spin forever.
- `live-activity-limits.ts`: plan limits from Claude Code status bar dumps every 60 s, no network; the usage panel
  reads the same dumps (`usage.ts`). Both go through `scanFreshestRateLimits` in `herdr/statusline.ts`. An idle
  session redraws its status bar without an API call, so the newest file is not the freshest one. The scan keeps,
  per dump, a fingerprint of `rate_limits` and `cost.total_api_duration_ms` and the `mtime` at which the fingerprint
  last changed (`changeAt`). The dump with a live window and the latest `changeAt` wins (ties: newer `mtime`, then
  file name), and its `changeAt` is `fetchedAt`. Each scan runs `stat` on every dump and reads only the dumps whose
  `mtime:size` changed, at most 200 per scan; scans of one directory run one after another. The memory lives in the
  server process: after a restart every dump counts as seen for the first time, so the newest `mtime` wins again.
  Next to the winner the scan returns the newest reading of every live weekly reset (`weeklyWindows`, the same
  order as the winner); the poller passes them on to `weekly-limit.ts` and calls it after every read, also an
  unchanged or a failed one. `GET /api/usage` gets the winner only.
- `weekly-limit.ts`: the weekly-limit signal ("Weekly plan limit" below): it evaluates the weekly windows after every
  read of the limits poller and sends through the sink; it lives only with the APNs channel.
- `server/src/mac-stats.ts`: the Mac load sampler (CPU every 10 s, RAM every 30 s, disk every 60 s; used percentages,
  step 5), one per process, read by `GET /api/mac` and the Live Activity driver; it runs also without an APNs channel.
- `live-activity.ts`: the Live Activity driver. It listens to the manager's global events and the limit poller,
  compares CONTENT per activity and sends: a change at most every 15 s, a CHANGE of `waiting` (rise or drop) at once with priority 10,
  a heartbeat of the same content every 10 min. `end` comes after 30 min in which `isBusy` is false, on the `…/end`
  route and on device unregistration. 8 h minus 10 min after registration the driver sends `end` with priority 10
  and immediate dismissal, because after its 8 h limit the system ends the activity and leaves it frozen on the lock
  screen for up to 4 h; a failed one retries every 60 s, and at 8 h the block drops without a send. `aps.timestamp` grows
  strictly per activity, and its marker survives a restart. The app writes only counters onto the Live Activity, with
  a marker a full second before the transition, so a server send after the transition always wins ("Native app:
  aggregate Live Activity" below). **`done` chime:** `chime()` orders a sound for every activity of a device with
  `alerts: true`, outside the 20 s gap (`LIVE_ACTIVITY_CHIME_MIN_GAP_MS`), as an update of the current content with
  priority 10 and a deadline (`LIVE_ACTIVITY_CHIME_TTL_MS`). A late or failed order drops without a retry, and a
  return to Rarog cancels orders that have not gone out (`cancelChimes()`). Logs carry event kinds and numbers, never
  a token, `activityId` or label. New work after the end does NOT resume an activity: the app starts a new one at the
  next open (push-to-start is not used).
- `index.ts`: the scheduler, the only place with state and a clock. Before a send it asks about the session again
  (`look`, built by `sessionLook` with the same `work.ts` rules as arming). It keeps THREE maps per session:
  `#waiting`, `#sent` (without it an identity transition would send a SECOND banner about the same standing dialog)
  and `#owed`. Degradation is counted per token in the device registry (`DEGRADED_AFTER_FAILURES`, three failed
  attempts in a row), not here. The send log line carries the kind, project and result per channel (`push: question
  for rarog — APNs: SENT`), NEVER the banner title or text.

Registry, sender and sink exist with `RAROG_PUSH` ≠ `0`, outside demo, and with a route: a complete `RAROG_APNS_*` set
with a key file that passed the check (mode 600/400, an EC P-256 key) or the relay. The scheduler exists ONLY with the
APNs channel; without it `POST /api/presence` is a no-op (204). The start log says `push: notifications ON (…)` or
`push: notifications off (…)`. The guard "the banner gets the tool name, never the command text" stands where the
content is made (`#notifyDetail` in the manager).

Classification goes by **event, not by state pair**, because a pair loses the cause: `waiting-input` reached by
`result: success` means "there is something to take", while the same `waiting-input` reached by
`interrupt-requested` means "the person pressed Esc".

### Notification rules

1. A notification describes **a state that lasted**, not an event.
2. **End of turn ≠ end of work**: a turn closed with live background tasks is silence. "Live" here means WORKING: a
   command, a workflow, and a subagent that is not in standby. A subagent in standby (`waitingSince`) does not hold
   `done`: it waits for a command that may never end. A monitor does not hold it either: it only watches. The rule
   applies twice: at the end of the turn (the
   push is not armed) and right before the send (an armed push drops when background work started meanwhile).
3. **The end of a turn in which nothing ended is silence.** A subagent standby notice wakes the main agent for a
   short turn. A turn whose only `user` messages since the previous turn end were standby notices (`notice.outcome:
   waiting`) does not arm `done`; anything else in the turn restores normal behavior, and the "waiting for a
   decision" and "work stopped" classes do not know the rule. The manager counts `user` messages from turn end to
   turn end (`Session.turnInput`), including inputs that are not in the transcript, which the follower reports in a
   `turn-input` event. An incomplete tally (after a driver attach, a history chunk or a loss of transcript continuity,
   `turn-input` with `lost: true`) is not passed on, so a normal `done` goes out. A turn after an artifact task
   notification alone in which the agent called no tool is silent too (`artifacts.md`). The result of a plain turn
   whose banner did not go out stays owed and goes out after the first turn with a quiet background, or without a
   turn when the task list stops holding it (`quiet`); an interrupt from Rarog and `/clear` in the pane clear the
   debt. Limits and known gaps: `background-tasks.md`, "Standby-only turn".

The scheduler does NOT need three things, because directly known presence makes them redundant: a condition "you
were present at any time in the window" (the 40 s TTL IS that grace), an explicit cancel token (the scheduler holds at
most one waiting notification per session) and **any delay machinery** (below).

### When a notification goes out

| Class | Window |
| --- | --- |
| waiting for a decision | 3 s |
| work stopped | 3 s |
| `done` | 15 s |

The window waits out a state that reverts by itself, and it is longest for **`done`**: the agent ends a turn and
starts the next one a moment afterwards (a queued prompt, a `/loop` wake). Rarog does not see wakes at a set time, so
the 15 s are for them; a subagent in standby can move in the same window, so the background task guard also runs at
the send. The thresholds for blocking classes are not zero, because Rarog can confirm a command automatically
(`/model`, `/effort`: `dialogs.md`, "Dialog block"), and a push about something that resolved itself is an alarm
about nothing.

**`done` also waits out a 60 s grace after you leave Rarog** (`PRESENCE_GRACE_MS`, `Presence.graceLeftMs`), counted
from the last moment a client was surely visible: a `visible: true` report, or a visible client that reports
`visible: false`. Without `visible: false` (lost network) it counts from the last `visible: true`. A turn that ends
in that minute is checked when the grace runs out, not after 15 s, and a return to Rarog within it clears it like any
return. A short switch to another app is not leaving: without
the grace every turn that ended during a few seconds in the terminal played the tile chime on the device you were
working on. Blocking and failure classes have no grace, because the session stands until someone answers. The log
line names the longer window: `push: armed done for <project> (check in 50 s, grace after leaving Rarog)`.

### What clears a case

- **You look at Rarog**, on the phone or the iPad; presence counts TOGETHER. The case is not armed at all.
- **A return to Rarog clears ALL waiting sends.** Opening the app gives a list with the state of every session at
  once. A known cost: a blocked session whose push did not make it out stays quiet until something in it changes.
- **Viewing the session** (`POST …/seen` or an open transcript).
- **The state passes**: the permission resolved, the error retried, a new turn.
- **Background work that started after the end of the turn**, for `done` only (log `push: quiet for <project> (done,
  state=waiting-input, working in the background: N)`).

There are NO delays: presence clears a case, it does not move it.

### herdr server restart

A full herdr restart (an update without `--handoff`) kills pane processes; herdr restores them with `claude
--resume`, and Rarog sees `gone` of an idle card (within 60 s after the socket returns) and `appeared` of the same
uuid in state `running`. The first `idle` of such a card is not the end of a turn: the manager gives it a one-time
marker (`#herdrGoneIdle` → `#armRestoreQuiet` in `server/src/sessions/herdr-lifecycle.ts`), and `classify()` returns
silence with the line `push: quiet for X (done, herdr restore)`. A card that was in a turn at the moment of `gone` gets
no silence.

### Session start

A session that comes up does not end a turn. A card created in `starting` carries the one-time marker
`Session.awaitingFirstTurn`: every event that starts a turn clears it, and the first exit from a turn consumes it.
That covers a pane found in `unknown`, a session from Rarog before the pane is ready and the zero turn of a session
without a prompt (`#settleEmptyStart`). The scheduler gets it as `afterStart`: `classify()` returns silence for `done`
(`push: quiet for X (done, session start)`), and `leavesResult()` lights no debt. A dialog, a permission, a question,
an error and a plan limit go as any other.

### New version of Claude Code or herdr

`server/src/version-watch.ts` sends ONE banner when the installed Claude Code release or the herdr version differs
from the last one it saw, and writes one log line per changed program: `versions: Claude Code 2.1.321 → 2.1.322
(push: delivered)`. It adds no timer of its own and reads two existing sources:

- Claude Code: the installed release from the manager's full read of the `~/.local/bin/claude` link
  (`cli-version.ts`, every 30 s), not the release of a running process.
- herdr: the version from a validated `ping` after every supervisor resync tick (`HERDR_RESYNC_MS`, 30 s). The socket
  protocol check keeps its result until the socket is lost, so the tick also catches an update under the same socket
  and the same protocol.

The last seen versions live in `versions-seen.json` ("Persistent state on disk" below). A program without a stored
version (the first start) is written without a push and without a line; the same version after a restart sends
nothing. Any other value, also a lower one, opens a 45 s window (`VERSION_PUSH_SETTLE_MS`): changes of both programs
in it go out as one banner. The file is written when the window closes, before the send, so a failed send or no
receiver does not repeat the banner, and a server stopped inside the window reports the change again at the next
start. No read (`null`) or a value outside `VERSION_RE` changes nothing, not even the file. A broken file is written
again from the current versions without a push, with the line `versions: versions-seen.json unreadable — starting
over without a push`.

The banner has no session: kind `version-changed`, title `push.version-title`, body `push.version-body.claude-code`,
`push.version-body.herdr` or `push.version-body.both` with the version numbers only, `topic`
`rarog:version-changed`, priority 10, 24 h in APNs, no badge. It goes to every entry with `alerts: true`. Off in demo
mode; without an APNs channel the file is still kept and the send result is `no-receiver`. The app shows the
decrypted title and body (from its catalog when it knows the sentence code) in the background and in the foreground,
and a tap opens the "Server" screen, as for `device-paired`.

The consent channel has its own gate for a new Claude Code release. Its `channel` proof rule (the approve button
without the top of the screen) holds on the release the package measured and on older ones; on a newer release it
holds only for the request kinds (main thread, subagents) that `<dataDir>/consent-canary.json` lists as passed for
that exact release, and a failed entry there takes it away on any release. The server reads that file at every
consent observation and never writes it, so a new entry counts without a restart (`docs/dialogs.md`, "Proof rule").

A new or changed entry of that file gives one more banner (`server/src/notify/consent-canary-push.ts`): the release,
its main-thread result and the main-thread rule the gate gives that release after it (`consentProofRuleOf` with
`RAROG_CONSENT_PROOF`). Title `push.canary-title`; body `push.canary-body.pass` ("passed"), `.fail` ("failed") or
`.unmeasured` ("not measured"), the last two with "Allow button only with the dialog on screen", because a failed
entry takes `channel` away also from a release that passed before or that the package measured. A release the
package measured keeps `channel` with an `unmeasured` entry, so its body is `.unmeasured-package` ("not measured",
"Allow button also without the dialog on screen"). The `subagents` result is not in the banner. The check runs at the
same full read of the installed release as the
version signal, without a timer of its own, and the log line is `consent-canary: Claude Code 2.1.326 main=pass (push:
delivered)`. The pushed results live in `consent-canary-pushed.json` ("Persistent state on disk" below), written
before the send, so a restart, a failed send or no receiver never repeats a banner. The same result from a new
measurement sends nothing; a changed `main` sends again. The first start, a missing state file or one of another
shape takes the entries already in the canary file as pushed, without a banner (another shape adds the line
`consent-canary: consent-canary-pushed.json unreadable — starting over without a push`). A release removed from the
canary file leaves the state file too, so a new entry for it gives a banner again. A canary file the gate ignores
(mode, type, size, shape) changes nothing; without a canary file there is nothing to push. Kind `version-changed`, so
the app shows and opens it like the version banner; `topic` `rarog:consent-canary:<release>` (a newer result of the
same release takes the place of the older banner), priority 10, 24 h in APNs, no badge, every entry with `alerts:
true`, off in demo mode.

### Weekly plan limit

`server/src/notify/weekly-limit.ts` sends a `weekly-limit` banner at least once for every weekly window of the plan
that reached 97 % (`WEEKLY_LIMIT_ALERT_PERCENT`, compared with the rounded percent of the tile and the list footer).
It lives only with the APNs channel and adds no timer or scan of its own: after every read the limits poller
(`live-activity-limits.ts`, every 60 s) hands it the newest reading of every live weekly reset among the status line
dumps, not only the winner the tile shows, because two or three accounts can work on one Mac at once.

A window qualifies at 97 % or more, with its reset still ahead, without its key in `weekly-limit-alerts.json`
("Persistent state on disk" below) and with a reading at most 15 min old (`CLI_USAGE_STALE_MS`, the `stale` mark of
`GET /api/usage`). Freshness is checked only then, so an old dump of an unused account does not count. After a server
restart freshness counts from the dump's `mtime`, so a redrawn dump of another account at 97 % or more can give one
push for its window. The first try goes at once. After `failed` or `no-receiver` the next tries wait at least 1, 5
and 15 min after the one before, then 15 min each time, on the poller's reads, until `delivered` or the reset; a
queued window needs neither a fresh reading nor the threshold again. `delivered` means that any device answered 200.
The key, the window's reset instant, goes to the file after `delivered`, so the next readings, a restart and switching
accounts send nothing more for that window. A failed write is retried on every read without a second send; a crash
between the 200 and the write can repeat the push after a restart. Log lines carry no content:
`weekly-limit: 97%, resets <ISO> (push: <outcome>)` at every try with `delivered` or `failed` and at the first try
with `no-receiver`; `weekly-limit: weekly-limit-alerts.json unreadable — starting over` (an empty set, the file is
written again at the next `delivered`); `weekly-limit: weekly-limit-alerts.json not written (<code>)`.

The banner has no session: kind `weekly-limit`, title `push.weekly-limit-title` (the percent), body
`push.weekly-limit-body` (the reset instant), no account name (the dump does not carry one; the reset hour tells
accounts apart), priority 10, in APNs until the reset and at most 24 h, `apns-collapse-id` from the reset instant
(two accounts in one week give two banners), no badge. It goes to every entry with `alerts: true`, also while the
owner is looking at Rarog. At shutdown the channel closes the poller, waits for a send in flight and its write (at most
3 s, `WEEKLY_LIMIT_CLOSE_MS`), then closes the passes and the sender; undelivered windows wait in memory only and
qualify again after a restart. The app shows the banner also in the foreground, and a tap opens the session list
(the list footer shows the week with its reset time). An app that does not know the kind shows the decrypted title
and body in the background, a tap opens the app, and in the foreground there is no banner, while APNs still answers
200; so the server counts that banner as delivered.

### Toast about another session

A signal in the app for a session you are **not looking at**, and ONLY when another session stands in the right
column (in the list it would duplicate the state dot). It shows on ENTERING a state: waiting for permission, a
question, an error, a plan limit, and `done` only after real work; never when a session is first seen, nor on a full
list state. The signal is also born on a `state` frame, because the server sends it before `session-changed`. It
disappears after 6 s, or sooner when the person reaches that session. A tap opens the session. Content: the kind word
from `shared/src/notify-copy.ts`, then "project · session". Core state (`AppState.signal`, `Reducer+Signals`):
`native/Rarog/docs/rarog-core.md`.

### Native app: APNs client side

The APNs sender and the token registry are on the server; the app keeps the token, the permission and the tap
target. The system enters the core through two injected protocols (`PushSystem`, `BackgroundWork`), so `RarogCore`
stays free of UIKit.

- **Token and registration.** After login the app asks the system for a token and sends `POST /api/push/apns {token,
  environment, label, alerts}` after the full list state of the CURRENT stream connection, once per cycle (login,
  return from the background, a new token, a permission change). `alerts` = the permission (`denied` gives `false`;
  the entry stays for the Live Activity), `environment` = `aps-environment` from the provisioning profile. `POST
  /api/push/apns/status` is the only source of the "Notifications aren't working." banner.
- **Logout (401).** The app gives the token back to the system (`unregisterForRemoteNotifications`): APNs answers 410
  at the next send, and the server removes the entry.
- **A push in the foreground** gives no banner, except `device-paired`, `version-changed` and `weekly-limit`. A
  **tap** on a banner and the address `rarog://session/<id>` are one path: the target waits in the core for login and
  a full list state of the current connection, then navigation enters the session; an entry with `termId` opens its
  terminal screen. A tap on `device-paired` opens the Settings "Pairing" page, on `version-changed` the "Server"
  page; a tap on `weekly-limit` opens the session list, the same way as `rarog://list` (it also waits for login and
  a fresh list).
- **The badge** in the foreground = sessions waiting for a decision in the current list; in the background
  `aps.badge` from the server carries it. `visible: false` on entering the background goes inside
  `beginBackgroundTask`, so iOS does not suspend the app halfway through the request.

### Native app: aggregate Live Activity

The `RarogWidgets` extension (links only `RarogContract` and `RarogActivity`) draws the Live Activity; the app starts
it, the server sends the full content (driver above), and the app writes the counters too while it is outside the
background. Lifecycle rules live in the core (`RarogStore+LiveActivity`), and ActivityKit enters through the
`ActivityRequesting` protocol, so `RarogCore` stays free of ActivityKit. Look, tap targets and client log lines:
`native/Rarog/docs/app-target.md`, "Live Activity".

- **Start state:** the app builds it from the list of the CURRENT connection by the same rule as the server
  (`aggregateState` ↔ `AppState.liveActivityInput`; golden frames `shared/fixtures/apns/` in `LiveActivityInputTests`).
  The server sends the full state right after the activity token registration.
- **Counter writes from the app:** after a decision in the app the Live Activity shows the new counter at once,
  without waiting for push delivery. The app computes counters and marker from the image of the global stream alone
  (`AppState.globalList`), not from the list on screen. The marker (`AppState.liveActivityAsOf`) is the newest
  `stateSince` of the image, cut to a full second, minus 1 s, i.e. the server clock. ActivityKit skips a write older
  than the last push or write, so the Live Activity never goes behind the server. Known costs: an app write drops
  when the server sent a push in the transition second or the second before, and a write does not extend
  `staleDate`.
- **Run bar** (`LiveActivityPhaseBar`, the same on the Lock Screen and the expanded Dynamic Island): one segment per
  plan phase. With `states` (`docs/implementation-spec.md`), each segment is a full capsule in the color of its phase
  state: not started is gray, in progress is the full `run` green, finished is the same green at 0.60 opacity; no
  percentage fill and no brighter track for the current phase. Without `states`, a segment fills with its phase
  percentage and the current phase has a brighter track. The colors are numbers in `LiveActivityPalette.swift`,
  outside `#if os(iOS)`, so `LiveActivityPhaseContrastTests` checks their order by luminance and their WCAG contrast
  on the reference backgrounds in `swift test` on macOS. VoiceOver reads the state of every phase by number.
- **Start:** the app in the foreground, logged in, a server with an APNs channel, activities allowed, a fresh list,
  and SOMETHING waits, works or spins in the background (`AppState.liveActivityBusy`, the mirror of the server's
  `isBusy`); there is no empty Live Activity. One activity; `pushType: .token`.
- **Activity token** (the first one and each after a rotation) → `POST /api/push/live-activity` with a device token
  the server already accepted (otherwise 409 `apns-device-unknown`), also in the background.
- **End:** after 30 min of silence counted in the foreground (in the background the server ends it), a local `end`
  and `POST …/end`; on logout locally; with `apnsEnabled: false`. Ended from outside (8 h, the server, the person),
  the state disappears, the app calls `end` with immediate dismissal at once, so the ended activity does not stay on
  the lock screen next to a new one, and a new activity starts at the next start conditions. Before a start, on
  logout and without a channel the app also ends activities that are ended but still shown.

## Pane screen parser (`server/src/herdr/dialogs/screen/`)

The full description of dialog handling (sources, decision order, module map, known gaps) is in
[dialogs.md](dialogs.md). From the pane screen Rarog takes exactly four things: the permission mode from the footer,
the dialog excerpt (the card field `herdrDialogScreen`, not a transcript message), the tool name and the option list
(`digit → label`). Patterns over text recognize all of it, so they depend on how Claude Code draws, and they take the
tool name and a known dialog only from the dialog BLOCK (the title under the top rule above the options), never from
the agent's text. Therefore:

- **Every such pattern has an entry in the exported registry `SCREEN_SIGNATURES`**
  (`server/src/herdr/dialogs/screen/signatures.ts`): an identifier, the pattern and the CLI version of the
  measurement. Parser constants take their value FROM THE REGISTRY, so the registry is the only place where these
  values stand. Patterns that do not depend on the CLI look (ANSI sequences, control characters) stay outside it.
- **The test `server/test/herdr-screen-signatures.test.ts` checks that every signature matches at least one fixture**
  in `server/test/fixtures/herdr/`; a signature without a fixture fails the gate. Exceptions are explicit: an entry
  with a `noFixture` field carries a reason, and the test guards a CLOSED list of such entries.
- **Fixtures in `fixtures/herdr/measured/` come from a live measurement** after a CLI update: a tab of its own in
  herdr, thirteen dialog types, a pane capture and `Esc` on each dialog. The measurement approves no permission and
  touches no foreign pane. Every capture lands twice, as `<type>-<CLI version>.txt` (an archive) and `<type>.txt`
  (the carrier of a content diff), after a normalization that blanks the status line and the random plan file name.

After a Claude Code update, `git diff` on the `measured/` directory says whether the look changed, and the
signature test says which signature lost coverage.

## Inbox cards (`server/src/inbox/`)

The server keeps one Inbox card per open session: the last message of the agent's latest turn that ended with a
result, waits for a decision or stopped. `startInbox`
(`server/src/bootstrap/inbox.ts`) joins it to the session manager's events and reads every session's card once after
the start. Devices get card heads on the global stream and card text through routes (`docs/implementation-spec.md`,
"Inbox"); the demo computes its cards from the demo sessions' in-memory events (`server/src/demo/inbox.ts`).

- **Source.** The card comes from the tail of the conversation file the session writes now (`readInputSegments` in
  `server/src/herdr/input-segments.ts`): every turn input opens a segment, and the card text is the assistant text
  after the last tool call of the turn, at most 12,000 characters, cut from the start. A read runs 500 ms
  (`INBOX_DEBOUNCE_MS`) after the last state change, summary change, dialog event, change of the engine conversation
  or message outside `starting` and `running`, one read per session at a time. The same file gives the same card
  live, after a server restart and after a re-attach. A change of the engine conversation drops the card and the
  shown turn of the previous conversation at once, and a read started before the change publishes nothing.
- **Kind** (`composeCard` in `server/src/inbox/card.ts`): `result` in `waiting-input`, `starting` and `running`;
  `decision` in `waiting-permission` and `waiting-question`; `failed` in `error`, `limit-reached` and `interrupted`.
  In `starting` and `running` the card shows the last turn a read in `waiting-input` showed, because a segment of the
  turn in progress has a result from its first tool call; after a server restart in the middle of a turn the session
  has no card until that turn ends.
  A closed session, a Codex session and a pane out of scope have no card. The text is the last segment that leaves a
  result and has text, so a turn without a result (an artifact notice, a subagent standby) and a result turn without
  text (a manual `/compact`) keep the previous card, and a conversation without such a segment (right after `/clear`
  or `/resume`) has no `result` card. A `decision` card carries only the dialog of the session summary (`waitingFor`
  or `herdrDialog`) and the id of the card in the session stream it describes (`requestId`, the `permId` or `qId`),
  not the pending card itself, neither in the tracker nor in the routes: reading that (`ManagerApi.transcript`) marks
  every consent card of the session as shown on a device. The
  id comes from `PendingDialogs` (`server/src/inbox/dialogs.ts`), which folds the session stream's permission and
  question events and picks the card the way the summary's `waitingFor` does. It gives the id only when the folded
  card matches what `waitingFor` says (tool, subject, text line, question count), because a consent card the server
  recovered at start never came as an event and the fold would pick the card behind it; otherwise the card is known
  by `waitingFor`. A consent card the fold knows only from `permission-settled` (recovered at start and shown in a
  snapshot before its first change) holds its place in the fold but gives no id, because that event carries neither
  its tool nor its text. The fold keeps digests of those lines, not their text.
- **A read that proves nothing keeps the shown turn.** A file that cannot be read, or a window that does not begin at
  the first entry of the file (cut by the byte ceiling or by the message ceiling) and holds no result, keeps the turn
  and text of the card; its kind, state and time follow the session state as always.
- **Identity.** `turnId` hashes the engine conversation id and the identity of the entry that opened the turn;
  `version` also changes with late text of the same turn, the kind, the identity of a decision's dialog, the state
  and buttons of its consent channel card (`state`, `canAllow` and `unavailable`, which `permission-settled` changes
  in place; `PendingDialogs.request`) and the moment the session entered a failure state. A dialog's identity is the
  card id (`requestId`), else what the summary says of the card, else the recognised dialog of a pane dialog without
  a card and why it has no buttons; never the moment the session entered its state, which a server restart moves, and
  never the buttons, so a removal holds while they change. Both are opaque.
- **Removal** (`Inbox.remove`, `Inbox.restore`). A removal is stored in `inbox.json` ("Persistent state on disk"
  below) under the turn for a `result`, the turn, the dialog kind and the dialog's identity for a `decision`, and the
  turn and the state's start for a `failed` card. Late text of the same turn keeps the card hidden, and so does the next
  turn while it runs; when that turn ends with a result, its card comes and the removals of the older turns are
  dropped. Removing a `result` card of a `waiting-input` session receives the result like `POST
  …/seen` (`markSeen`, with the herdr focus on the Mac); removing a `decision` or `failed` card only hides it. A
  restore takes back a receipt that the removal made. Both read the card again first, so a request for a turn that
  another turn has followed is stale, and so is a request whose session changed state while that read ran, because
  the read may hold the file from before the change. The receipt and its take-back need a read that took the card's
  turn from the file outside `starting` and `running`: after a read that proves nothing, and during the next turn,
  the card is only hidden or brought back, and the result says `receipt: 'skipped'`. They go after the write, and only
  while the session stays where the read found it and on the same turn, else the stored removal keeps no receipt and
  the result says the same. A request with another turn or an older version does nothing, and a failed write leaves
  the card visible.
- **Cost.** A read that takes over 250 ms (`INBOX_SLOW_READ_MS`) logs one line with the session id and the duration,
  never the card text.

## Data model: what does not exist

1. **There is NO session registry.** At start a `sessions.json` file of an install that had one is renamed to
   `sessions.json.bak` with one log line: a list of ghost cards with their last known state would be worse than none.
   The truth about sessions: `agent.list` + a resync every 30 s.
2. **State machine** (`sessions/state-machine.ts`): ONLY `transition()` computes the state: `starting · running ·
   waiting-input · waiting-permission · waiting-question · limit-reached · error · interrupted · done · resumable`.
   Nothing else assigns `state` by hand (the one exception: demo seeds).
3. **Ring buffer in RAM** per session, the source of tail replay after `Last-Event-ID`. `seq` lives within one
   `serverStartId` and rides with it in the frame `id:`, so a cursor from another process ends in a snapshot. A new
   card under the same id (restart, `resume()`) numbers on after the old card, so a cursor of the old card ends in a
   snapshot too, and the open streams of that id get one before the new card's first frame. The cap
   is **twofold, items AND bytes**: 500 ring events and 500 transcript messages, plus `RING_MAX_BYTES` (4 MB)
   separately for the ring and for the message array that `transcript-snapshot` is built from; a single message over
   `MAX_MESSAGE_BYTES` (256 kB) is cut with an explicit marker, because one message can carry megabytes of base64.
   Both caps push out the oldest entries. `MAX_TRANSCRIPT_MESSAGES` lives in `shared`, and the app cuts its
   transcript with the same cap (`CoreLimits.maxTranscriptMessages` = 500).
4. **Pending decisions in RAM**, first wins: the first decision that reaches the server, from any device, is the one
   sent; every next tap on the same card gets 409, and the session stream broadcasts the outcome to every client that
   watches the session (`permission-resolved`, `question-resolved`). After a restart a pending entry is gone → an explicit
   `expired` event, never a silent disappearance.
5. **Persistent state on disk** (`<dataDir>`: `RAROG_DATA_DIR` or the rule in `shared/src/data-dir.mjs`, i.e.
   `~/.local/share/rarog` for a new install; `server-config.md`, "Data directory"). The server leaves these files
   there:
   - `herdr-hidden.json`: pane aliases + the `seen` marker, also a manual "unread" and who received when it was the
     voice agent (`by`). Writes go through a promise chain
     **with `.catch` at every step**, so one failed write (ENOSPC, foreign permissions) does not poison the chain.
   - `apns-devices.json`: the native app's APNs tokens, `{devices: [{token, environment, label, alerts, createdAt,
     updatedAt, lastOkAt, failures, degradedSince, liveActivity?, deviceId, topic, relayPass?, relayMismatch?,
     pushFormats?}]}`, `0o600`. `deviceId` is the paired device that registered the token (revoking the device
     removes its tokens) and `topic` the app's bundle id; a read skips an entry without either. `liveActivity
     {activityId, updateToken, startedAt, lastTimestamp?}` is the aggregate Live Activity token, `relayPass {pass,
     expiresAt, origin, environment, topic, token}` the relay pass (the same shape inside `liveActivity`),
     `relayMismatch` an `env-mismatch` refusal, `pushFormats` the banner formats of the last registration. Limit 20
     with LRU by `lastOkAt`; a broken file reads as an empty registry. Created only with an APNs channel (a key or
     the relay).
   - `outbox-ids.json`: the idempotent send registry (`server/src/sessions/send-registry.ts`), `{format: 1, entries:
     [{id, sessionId, digest, at}]}`: `clientMessageId`, session id, sha256 of the message and the acceptance time,
     ZERO content; a 24 h window, a cap of 2000 entries, `0o600`; created at the first send with `clientMessageId`.
   - `prompt-queue.json`: the paste queue of messages sent while a turn runs (`server/src/drivers/herdr/prompt-queue-store.ts`),
     `{format: 1, entries: [{id, session, state, text?, at, source?}]}` (`session`: the engine session id; `source`:
     `voice-agent` for a prompt of the voice agent), `0o600`, tmp+rename.
     `state: queued` carries the message TEXT until its first paste, `state: pasted` no text; an entry leaves the file
     when its outcome is known. Read at start (`dialogs.md`, "Sending while a turn runs"); a corrupt file is moved to
     `prompt-queue.json.bad`. Created at the first message that waits in the queue.
   - `inbox.json`: the removed Inbox cards (`server/src/inbox/removals.ts`, "Inbox cards" above), `{format: 1, removed:
     [{sessionId, turnId, card, dialog?, dialogId?, since?, seen?}]}`: the session id, the opaque turn id, the card
     kind, the dialog kind and the opaque digest of the dialog's identity of a `decision` card, the state's start of a
     `failed` card and whether the removal received the result; ZERO content, `0o600`, tmp+rename. The entries of an
     open session's older turns go when a read in `waiting-input` shows a newer turn; entries of closed or vanished
     sessions are capped at 500, the oldest go first. A broken file, or one over 1 MB, reads as an empty store; a file
     of another format (or without one) too, with one log line, and the first write replaces it. Created at the first
     removal; deleting it brings the removed cards back.
   - `versions-seen.json`: the last seen Claude Code and herdr versions (`server/src/version-watch.ts`), `{format: 1,
     versions: {"claude-code"?, herdr?}}`, version numbers only, `0o600`, tmp+rename; created 45 s after the first
     version read outside demo mode ("New version of Claude Code or herdr" above).
   - `consent-canary-pushed.json`: the main-thread result of each release in `consent-canary.json` already announced
     by a push (`server/src/notify/consent-canary-push.ts`), `{format: 1, pushed: {"<release>": "<result>"}}`, release
     numbers and results only, `0o600`, tmp+rename; created at the first full read of the installed release outside
     demo mode ("New version of Claude Code or herdr" above). Deleting it costs at most one missed banner: the next
     read takes the current entries as pushed.
   - `weekly-limit-alerts.json`: the weekly windows with a delivered `weekly-limit` push
     (`server/src/notify/weekly-limit.ts`), `{format: 1, sent: ["<reset instant>", …]}`, reset instants only, `0o600`,
     tmp+rename; a write drops past instants and keeps the 16 newest. Created at the first delivered push, only with
     an APNs channel ("Weekly plan limit" above). Deleting it costs at most one repeated push per live window.
   - `uploads-dirs.json`: the project directories where the server wrote attachments
     (`server/src/herdr/uploads-registry.ts`), `{format: 1, dirs: ["<real path of the cwd>", …]}`, paths only,
     `0o600`, tmp+rename. The start sweep of `.rarog-uploads` reads it instead of walking the roots (the uploads item
     in `security-model.md`). The first start sweep creates it, an attachment write in a new directory adds an
     entry, and the start sweep removes entries without files and entries whose path now leads through a symlink.
     Deleting it costs one walk of the roots at the next start.
   - `devices.json`: device keys from pairing, `{version: 1, serverId, devices: [{id, secretHash, pushKey, kid,
     label, build, createdAt, lastSeenAt, epoch, creator}], revoked: [{id, secretHash, label, createdAt, creator,
     revokedAt, revokedBy}]}`, `0o600`, tmp+rename. There is no secret, only its `sha256`; the file appears at the
     first start with a durable `serverId`. Its backup `devices.json.bak` holds only the active devices and the
     current tombstones (`revoked`); an unreadable main file = the state from the backup, both unreadable = an empty
     store and `authStore: broken`.
   - `devices.demo.json`: the device store of the plain demo (`RAROG_DEMO=1` without `RAROG_DEMO_REVIEW_CODE`), the
     same format and backup (`devices.demo.json.bak`) as `devices.json`. The plain demo never reads or writes
     `devices.json`; the review demo and a server without demo keep `devices.json`.
   - the admin socket `run/admin.sock` (directory `0o700`, socket `0o600`; removed at server shutdown; pairing codes
     live only in memory), and next to it the consent channel registration socket `run/consent.sock` (the same modes
     and lifecycle, only in a channel mode that needs hook registration; hook secrets live only in memory,
     `server/src/auth/consent-socket.ts`).
   - two logs **with one rotation generation**: `herdr-audit.log[.1]` (every write to a pane Rarog does not own, every
     refused decision or slash command, every card without a decision from a screen judgment; 8 MB) and
     `client.log[.1]` from `/api/client-log` (5 MB).
   - the orphan `sessions.json.bak` from item 1.
   - `roots.json`: roots for the `cwd` filter of the permission hook; Rarog writes it at EVERY start from
     `RAROG_HERDR_ROOTS`, the hook reads it; it also carries the excluded folders of the work area (`exclude`) and the
     `tallDialogGuard` switch (`RAROG_TALL_DIALOG_GUARD`).
   - `hook-seen.json` and `hook-seen.<file>.json`: the marker of the last hook run, in total and per entry file of the
     hook copy (sources of `hookSeenAgo` and `hookSeenAgoByFile`).
   - `guard.jsonl[.1]`: the refusal log of the tall dialog guard; the HOOK appends it, ZERO command text, `0o600`;
     the server moves it to `.1` at start when it is over 1 MB.
   - `term-herdr.json`: the ONLY terminal state on disk, `{"<pane_id>": {"seen": ms, "cwd": "…"}}`, `0o600`, ZERO
     content.
   - `pending/<session>.json`: hook dumps with the FULL `tool_input` (command, file content, the whole plan). Removed
     after a decision sent from Rarog (after an answer by file only when the dump carries the same `answerKey`, because
     the hook writes the next question of the turn at once) and swept at server start past their TTL. A dump of a
     decision made in the terminal stays until that sweep. TTL: the hook `timeout` (24 h) for a standing question
     form (`PermissionRequest` + `AskUserQuestion`: one digit closes one question, tabs 2..n have no other source of
     content, and the hook waits for the answer that long), 60 min for a `PermissionRequest` + `Bash` dump (after 10
     min it counts only with proof from the screen), 10 min for every other dump.
   - `answers/<session>/<key>.json`: the ANSWER channel for `AskUserQuestion`: Rarog writes the answers to ALL
     questions of the call (and notes, `annotations`), and the waiting hook process reads the file, removes it and
     hands the CLI `allow` with `updatedInput.answers` (docs: hooks, "PermissionRequest decision control"). `0600`
     in a `0700` directory, atomic write. The HOOK computes the key
     (`<prompt_id>-<sha256(questions), 16 characters>-<nonce>`, the nonce 8 random bytes in hex), so two identical
     calls of one turn do not share a file. The start sweep removes leftovers after 10 min together with empty session directories.
   - `pending/<session>/<key>.json`: the hook dump per call for a tool permission (`0600` in a `0700` directory); the
     hook process removes it on exit. After a hook killed with `SIGKILL`, the shadow mode start cleanup removes it
     when `ps` no longer knows the process, and any such file after 2 h.
   - `markers/<session>/<name>.json`: the request marker of the consent channel with the FULL `tool_input` up to the
     per-call dump's cap (`dialogs.md`, "Per-call dump and shadow mode"), `0600` in a `0700` directory. The HOOK writes
     it only while `alive.json` carries `markers: true` and never removes it; the server removes it once its request
     has left the session pool and at the end of the conversation, and the start cleanup removes any file there older
     than 7 days.
   - `shadow.jsonl`: the lifecycle log of shadow mode (`dialogs.md`, "Permission hook"), written by the HOOK, ZERO
     `tool_input`, `0o600`; `alive.json` and `alive.jsonl`: the server liveness marker for the hook (every 10 s) and
     its transition log, written only by the server. The server rotates `shadow.jsonl` and `alive.jsonl` to `.1` at
     start when they are over 8 MB. `shadow/<session>/<key>.json`: the shadow file, removed by the start cleanup after
     10 min; `decisions/<session>/<key>.json`: its lifecycle record (30 days of retention).
   - `notes/<sha256(realpath(cwd)), 16 characters>.json`: PROJECT NOTES ("Project notes" below), `0600` in a `0700`
     directory. **Rarog's only durable content WITHOUT retention**: only a person deletes it. The `cwd` inside the
     file is the only way to recover notes orphaned by moving the project directory, because the hash is one-way.
   - `refusals/<ISO-ts>-<reason>.txt`: diagnostic dumps of REFUSALS (pane screen text, dump metadata WITHOUT
     `tool_input`), and the screen of a main-thread consent card whose top shows an unknown element
     (`…-top-<member>-<key tail>.txt`, once per card); `0600` in a `0700` directory, 48 h of retention and a cap of
     200 files, swept at server start and after every write; switch `RAROG_REFUSAL_DUMPS=0`. A dump of a layer 2
     dialog (registry class `dialog`) without any consent trace is `…-<reason>.dialog.txt` with 14 days and its own
     cap of 500 files (`dialogs.md`, "Refusal diagnostics").
   - `sdk/<version>/` (npm package only): the session list SDK, written only by `rarog setup` through a staging
     directory `sdk/.tmp-*` and `rename`; the server only reads it, and old versions stay (`distribution.md`, "Claude
     SDK").
   - `server.log`: the service plist gives its path; for a `nohup` start `rarog restart` passes it as `RAROG_LOG`.
   - `companion-cwd/`: the parent of the empty working directories of the voice agent's `claude -p` calls
     (`companion.md`); each call gets a fresh `0o700` directory, removed after the call, so the parent stays empty.

   This list is binding for the runbooks in `security-model.md`, "Emergency runbook" (what to delete, where to look
   for traces): cleaning by a shorter list leaves `.bak` files and older log generations. Transcripts live in the CLI
   store.
6. **Client** (the native app; full list and rules in `native/Rarog/README.md`): a durable send queue, a durable
   draft of every session with attachments, project note drafts and a cache of the last fresh list without decision
   content (`SnapshotCache`, 24 h), all in the server space `Application Support/servers/<space>/`; device memory in
   `UserDefaults` (paths, identifiers, labels and dates, zero conversation content). The device key (with the
   server's routes) and the app's iroh key sit in the Keychain, the push key in a group shared with the notification
   extension `RarogNotificationService`, which decrypts banners (items: `security-model.md`, "Native client: what is
   stored on the iPad"). The client keeps no transcripts on disk.
7. **Git status**: a local `git status --porcelain=v2 --branch --untracked-files=all` (without the last flag a new
   directory would be one entry). Every git the server runs starts from the single runner `spawnGitArgs`, which puts
   `-c core.fsmonitor=false -c log.showSignature=false` before the subcommand and adds `--no-textconv` to `diff`.
   - **Entries.** Every untracked file is a separate entry; a nested repo stays one entry with a trailing `/`.
     Tracked changes come first, so a large new directory does not push them past the cap of 50 files. Status also
     counts the kinds of dirty files (`fileKinds`, the `+3 ~5 −1` triple in the session header), and `git log -1`
     gives the last commit row, throttled.
   - **Per-file line counts** (`fileDetails`, `RAROG_GIT_FILE_DETAILS`, default 1) come from a third process, `git
     --literal-pathspecs diff --no-ext-diff --relative --numstat -z HEAD -- <paths>`, run after `status` with its own
     1.5 s budget. Timeout, error and a repo without HEAD give a frame with kinds only, never guessed zeros. An
     untracked file, a file outside the session directory and a path git quotes have no counts; a non-text file has
     `binary: true`. `server.log` gets one cost line per 5 min window with git activity (`git-stats.ts`).
   - **Triggers.** FIVE events start a read: a closed tool call; opening the transcript; **a card appearing in the
     list**; **the end of a turn** (both throttles skipped, so the `done` card does not show numbers from before the
     last edits); and **a change in the `.git` directory** (`fs.watch` on `HEAD`/`index`/`refs/**`/`logs/**`, because
     a commit in the terminal, lazygit or nvim does not go through a Claude session). The watcher rate is leading +
     trailing per REPO: a read 750 ms after the first event, and one more at the end of a 2 s window.
   - **Dedup.** A forced read (end of turn, watcher) broadcasts only on a change of the ready `git-status` frame. A
     normal read (opening the transcript, seeding a card) always emits, because the file list exists only in that
     event; when a throttle skips the read, the manager re-sends the last stored frame of the session after
     `transcript-snapshot`.
   - **Not in a protected folder.** A card whose directory lies in a macOS-protected folder of home that no root opens,
     as written or through a symlink, gets no read and no `.git` watcher (`SessionGit`, `inExcludedOnDisk`;
     `security-model.md`, "Work area: where Rarog starts, lists and reads"): the read would wait for a privacy prompt
     nobody answers. A card outside the roots elsewhere keeps its git row.
   - **No avalanche.** `#inFlight` in `GitStatusWatcher` joins parallel requests for one directory, and there is one
     watcher per REPO. Rarog's own read does not wake the watcher, because reads run with `GIT_OPTIONAL_LOCKS=0`. No
     `git fetch` in the background (a poller knocking on GitHub ends in an IP block): `↑3 ↓1` comes from the local
     remote-tracking ref and tells the truth about the state after the last fetch. The PR state is the one call to
     GitHub, and it is not this poller: it goes through `gh` only while an app is connected, asks about each PR at
     most every 5 min and never touches git (`pull-requests.md`, "State on GitHub").

## App auth

One credential, the device key, and one function `authenticate(req, devices)` (`server/src/auth/principal.ts`) for
REST, SSE and the terminal WebSocket. The server has no token or cookie login: it does not read `Cookie`, sends no
`Set-Cookie`, and `POST /api/login` answers a fixed 410 `login-retired`.

- **Device key:** `Authorization: Rarog-Device <deviceId>.<secret>` from pairing by code. Records in `devices.json`
  (`devices-store.ts`: the secret hash, expiry after 30 days without use, tombstones, the `.bak` copy, `serverId`), a
  constant-time header check (`device.ts`), pairing codes in memory with one synchronous consumption step
  (`pairing.ts`), and the admin socket with the `/api/admin/*` routes (`admin.ts`; its start is shared with the
  consent channel registration socket, `unix-socket.ts`). Incrementing `RAROG_AUTH_EPOCH`
  and restarting revokes all devices at once. A revocation closes the device's SSE streams and terminals and removes
  its APNs tokens (`server/src/device-effects.ts`). Rules and the limit of the guarantee: `security-model.md`,
  "Pairing and device keys"; pairing from the app and the `rarog` command: `distribution.md`, "Pairing from the app"
  and "The `rarog` command".
- **iroh socket:** the same gate, and a successful key calls `markAuthenticated` (`iroh/socket.ts`), so the QUIC
  connection keeps a set of active devices. The `Origin` rule has one definition, `originAllowed` in
  `auth/origin.ts`: an iroh socket accepts only `IROH_ORIGIN`, TCP only `RAROG_ORIGINS`.

The failure limiter (`limiter.ts`) has one budget for a bad pairing code and an unknown key; when it runs out, 429.

## Configuration (`server/src/config.ts`, the only module that reads `process.env` for configuration)

Every variable, flag and killswitch, with defaults and editing rules, is in `server-config.md`, "Server environment:
variables and flags"; `config.json` and `rarog serve`: "Config file and `rarog serve`" in the same document. Install
values live in the `env` map of `~/.config/rarog/config.json`, from which `rarog serve` builds the environment;
secrets come from the process environment (for the launchd service, from the `service.wrapper` command that starts
the server). The launchd plist carries no environment. The host is not configurable: the server listens only on
`127.0.0.1` (port `RAROG_PORT`, default 8930), and an explicit `RAROG_HOST` with any other value stops the start.

Three kinds of variables matter for the architecture: killswitches that switch a capability off (`RAROG_HERDR_SEND`,
`RAROG_HERDR_LAUNCH`, `RAROG_TERM`, `RAROG_PUSH`, `RAROG_NOTES`; the runbook in `security-model.md` counts them),
preferences that change behavior without removing power (for example `RAROG_HERDR_TAB_LABELS`,
`RAROG_GIT_FILE_DETAILS`, and `RAROG_CODEX_STATUS`, whose `0` makes `codex` panes not exist for Rarog), and secrets
(`SONIOX_API_KEY`, `OPENAI_API_KEY`, the APNs key entries, `RAROG_IROH_KEY`). `RAROG_HERDR_LAUNCH` and `RAROG_TERM` are
OFF by default (an install turns them on in `env`); the other three killswitches are on. The flood guard
`RAROG_MAX_PANES` caps Rarog's live panes at 30 by default.

**Variable names have one home: the registry `server/src/config-env.ts`.** It lists every name the server reads,
with its kind (`secret`, `process`, `passthrough`, `plain`), the `*_ENV` constants and all four pass-through lists.
`config.ts` reads the environment with one function, `readEnv(env, name)`, whose type accepts only registry names; in
bulk it reads only the `GIT_` prefix. The guard `server/test/env-registry.test.ts` gives the server a
spy environment and checks equality both ways.

**Child process environments are closed lists**, so Rarog's secrets have no way into them:

- the terminal shell: `loadConfig` cuts `TERM_ENV_PASSTHROUGH` (`HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR`,
  `PATH`) out of the server env as `termEnvBase`; the terminal module adds only `TERM`/`COLORTERM` (the limit of that
  guarantee: `security-model.md`, "Emergency console");
- `live-sessions.ts` builds the environment of `claude agents --json` from `LIVE_SESSIONS_ENV_PASSTHROUGH` (`HOME`,
  `PATH`, `LANG`, `TMPDIR`);
- `tailnet.ts` does the same (`TAILNET_ENV_PASSTHROUGH`: `HOME`, `PATH`, `TMPDIR`) for `tailscale status`, plus a fixed
  `TERM`; the read gives the tailnet name in the agent list header;
- the child that creates a directory from the New Session form (`node` from `process.execPath`) starts with an
  empty environment, so neither `NODE_OPTIONS` nor `PATH` of the server reaches it;
- `git` reads get `gitEnvBase` from `GIT_ENV_PASSTHROUGH` (`HOME`, `PATH`, `TMPDIR`, `LANG`) plus every `GIT_` variable
  of the server env, and `gitReadEnv` adds `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`. The runner env is a
  required argument, so a "default env" cannot come back through a side door. The reason is not theoretical:
  repository configuration (`core.fsmonitor`, `textconv`, filters) executes on a read with that environment.

## Demo and review mode

`RAROG_DEMO=1` replaces herdr with a fake supervisor over seed sessions and the mock driver. The process loads one
content set (`RAROG_DEMO_LANG`) and passes it to the manager, the fake supervisor and the notes in memory
(`implementation-spec.md`, "Demo mode"). Usage, machine load, the tailnet name, the server name in the pairing answer
and the directory browser are fixed fictions, push and the terminal are off, and the UI tests drive the process
through the M1 control (`POST /api/demo/control`). They pair through `POST /api/demo/pairing`, which revokes every demo
device and returns a pairing code. The plain demo keeps device keys in its own store file, `devices.demo.json`, so
a key from it opens no server without demo on the same data directory (`server-config.md`, "Data directory").

With `RAROG_DEMO_REVIEW_CODE` the same demo serves app review on a public address (`server-config.md`, "Demo review
mode"). `server/src/index.ts` and its start modules in `server/src/bootstrap/` then assemble less: no M1 control, no
hook probe, no tailnet name (`null`) and no dictation stub, and they take the server name and the default model and
effort of a new session from the content set instead of `~/.claude/settings.json`. The process starts no
child process, deletes the previous `client.log` at start, and a route table classifies every request before any
handler (`security-model.md`, "Review demo server").

## Repository layout

Every source directory and every top-level file of `server/src` and `server/src/herdr` has one line in
[code-map.md](code-map.md), kept complete by `server/test/code-map-guard.test.ts`. Outside the map:

```
rarog/
├── shared/fixtures/      # golden SSE frames and REST answers, relay, pairing link and push crypto cases
├── .github/workflows/    # CI without secrets
└── docs/                 # this directory, index in docs/README.md
```

The server listens on `127.0.0.1:8930` (`server/src/index.ts`), and with `RAROG_IROH=1` also through the iroh
listener. The relays (`relay/`, `relay-auth/`) are separate pnpm projects; `relay-vps/` is installed on the VPS by
its `install.sh`.

Tests: `server/test/`, `shared/test/`, `relay-vps/test/` (vitest). herdr fixtures and their anonymization rules:
`server/test/fixtures/herdr/README.md`. Golden SSE frames have a test on each side of the wire: producers → files
(`server/test/sse-fixtures-producenci.test.ts`) and files → decoder (`shared/test/sse-fixtures.test.ts`, no imports
from the server). The product identity guard (`server/test/product-identity-guard.test.ts`) ties together the
sources of the bundle id, the app name, the link scheme and the Keychain groups (`localization.md`, "Guards"). CI
runs typecheck on Ubuntu and the server tests in parts on Ubuntu, on Node 22, the `swift-contract` step on macOS,
`pnpm test` on macOS in a public repository only, and a package install with npm and pnpm on Node 22, 24 and 26
(`publishing.md`, "CI").

## Native client

The native client lives in `native/Rarog/` as a separate app of the same contract; package rules, file owners, tests
and the UI are described in `native/Rarog/README.md`.

- `Packages/RarogContract`: frame and POST body types, the tolerant decoder (a mirror of `shared/src/decode.ts`), the
  source guard (`SourceGuardTests`: Swift code does not know tool names or CLI texts and does not decide by the
  answer channel) and the golden frame test, which reads `shared/fixtures/sse/` straight from the repo. It also runs
  in `pnpm run check` (the `swift-contract` step).
- `Packages/RarogTransport`: the SSE parser on bytes, the REST client with the device key (`Authorization:
  Rarog-Device …`, `User-Agent: RarogApp/<build>`) and one mutation gate (`MutationGate`).
- `Packages/RarogCore` (the `@Observable` store, a pure reducer, stream loops, the durable send queue, presence, the
  `kontrakt:` report to `client.log`) and `Packages/RarogUI` (views, zero domain logic); `Packages/RarogTerminal` is
  the only package that imports SwiftTerm.
- Tunnel to the server over iroh (`RarogTransport/Tunnel/`, without IrohLib; `Packages/RarogIroh`, the only package
  that imports IrohLib and linked only into the app target, adapts it to the tunnel protocols, guard
  `IrohBoundaryTests`): one endpoint per process with its own lifecycle (`EndpointLease`) and generations on top of
  it. The endpoint publishes no address and looks for no devices (`presetMinimal`); it reaches servers through the
  relay of the paired server and of the pairing target. For a direct path to a server on the same network the app
  declares Local Network access (`NSLocalNetworkUsageDescription`). An iroh generation is one connection, a loopback
  proxy (`TunnelProxy`: a listener on `127.0.0.1:0` that moves every accepted TCP connection onto a new bidirectional
  stream) and a `RarogClient` on its port; an HTTPS generation lends the credential's own client. `TunnelMachine` (a
  pure struct) decides when a generation opens and closes (scene, network, background work, failures, the choice between
  iroh and HTTPS: iroh first when the credential has an iroh pair, HTTPS for 2 min after a failed iroh attempt or until
  an HTTPS attempt fails too, and without an address a retry series of 1, 2, 4, 8 s, then every 15 s, with a 30 s
  attempt in the foreground; rules: `distribution.md`, "Pairing from the app"), and `TunnelRuntime` (an actor) carries
  out its commands, owns every loopback client and closes a generation in a fixed order: its ticket stops new requests
  and a probe still in flight is cancelled (on HTTPS too, where the credential's client stays valid), the proxy pairs
  abort (2 s), the connection closes, and the client is invalidated after the ticket drains or after 2 s. The first
  request of an iroh generation, and of an HTTPS generation when the credential also has an iroh pair, is the probe
  `GET /api/version` with the device key; any HTTP answer, 401 included, means ready. A send with an
  attachment on iroh opens its own connection (an upload door), so cancelling it closes only that connection. Its 202
  can arrive well before the echo on the main connection's stream, so the app waits 120 s after the 202 before it shows
  Not confirmed for a message with an attachment (15 s for text only).
- Relay registry client (`RarogTransport/RelayAccess/`, without IrohLib, DeviceCheck, UIKit or `RarogCore`; the tunnel
  does not know it): registers the app with the iroh relay registry (`relay-auth/`) and sponsors its paired servers
  there. `RelayAuthClient` sends requests signed with the app's iroh key, and `SystemRelayAccessStore` keeps two
  Keychain items: a cache (`relay-access`) and the opt-out record (`relay-optout`). `RelayAccessMachine` (a pure
  struct) decides when to sync, what to send and store and which status to show; `RelayAccess` (an actor) runs its
  commands in one queue: one request at a time, automatic triggers during an operation merge into one next sync, and a
  newer pairing or opt-out supersedes the operation in progress, which sends nothing more. `prepareForPairing` returns
  within its budget (`RelayAccess.pairingBudget`, 8 s) and the sync goes on in the background. The registry never
  blocks iroh: a failure is a status, not a refusal.
- The app builds one registry client per process (`RelayAccessWiring.swift`): the signer from the app's iroh identity
  (the same `IrohIdentityStore` as the endpoint's), the DeviceCheck gate (`RelayGates.swift`) and the map and renewal
  period (`RelayAccessSetup.swift`). `TunnelCoordinator` gives it the current credential's iroh pair as the server list
  (on every new credential, an empty list without a credential or without iroh, and again when the pair changes in
  place) and the triggers it sees: a return to the foreground, protected data available, and a failed iroh attempt in
  the lease, which `EndpointLease` reports through an observer closure without knowing the client. Each call goes in a
  task, so the coordinator never waits for the registry. The app adds the cold start trigger, hands the client's
  statuses to the store in order (`RarogStore.relayAccessChanged`) and gives the connector `relayPrepare`
  (`prepareForPairing` with `RelayAccess.pairingBudget`, only for a link with `k`) and `relayForget` (`forget`).
- `RarogCore/Transport/`: `ServerIdentity` (the server of a data space: its origin, or the EndpointId of a server
  reachable only over iroh) and `SwitchingTransport`, the one `RarogTransporting` and `TerminalTransporting` of a
  paired server over the runtime's generations. It borrows a generation's client through the ticket, waits for the
  next generation while one is closing, never retries a request, reports a request cut by the runtime's close as
  `.offline` (so the stream loops reconnect), counts the send limit (200 s with an attachment, 10 s for text) from the
  call and gives the generation number as `routeStamp`. All clients of one credential share one latch for the
  `device-revoked` refusal. The app target assembles them in `TunnelCoordinator` (one per process, one
  `EndpointLease`): every paired server, HTTPS-only too, gets a `SwitchingTransport` over its own `TunnelRuntime`; a
  link with `k` and `r` pairs through a one-shot iroh runtime that closes as soon as `pair` returns (a link with only
  `u` pairs with a plain `RarogClient`); the previous key is forgotten on its server through a one-shot transport
  limited to 10 s. Scene, network and background work with `needsServer` reach the coordinator before the store.
- The app (`Rarog.xcodeproj`) only glues them together: the server from the device key in the Keychain, the tunnel
  coordinator, the relay registry client, presence and streams from `scenePhase`, reconnects from `NWPathMonitor`, data spaces per server in
  `Application Support/servers/`. The `RarogWidgets` extension and the `RarogActivity` package draw the Live Activity.
- Product links: the addresses live in one place, `RarogCore/ProductLinks.swift` (the privacy policy, the server
  setup guide and the support page on `rarog.ai`, and the `support@rarog.ai` mailbox; `product-identity-guard` checks
  them against the push relay domain). The pairing screen shows the three pages under the pairing controls. Settings
  → About shows them again with Report a Problem (`mailto:` with the app version, build, iOS version and device kind,
  `ProblemReport`; the support page when no app accepts `mailto:`), Licenses (`THIRD-PARTY-NOTICES` shipped in the app)
  and the version row. Settings open only after pairing, so before pairing only the three pages are reachable.
- Dictation screen (`RarogUI/Views/Dictation/`): System Dictation (Apple speech recognition, on the device or on
  Apple's servers when the language has no on-device model) and, in a build with Soniox, Soniox with a key from the
  paired server (the audio goes straight to Soniox). Each option's description says what leaves the device, and the
  screen links to the dictation part of the privacy policy. The choice and the build flag come from
  `RarogStore.dictation` (`DictationServices`); the app never changes the choice by itself, and choosing records
  nothing. The Soniox option takes its state from `AppState.sonioxOnServer`: "checking" before the version probe,
  selectable when the server offers it, and visible but inactive when it does not, with a neutral state line and two
  setup steps for the person who runs the server (a project in the EU region at the Soniox console, then `rarog
  dictation set-key` and `rarog restart` on the server) and a link to the console. The app never takes the key.
  Settings → Dictation shows the choice and opens the same screen. A failed system dictation (`DictationFailure`)
  ends the recording with its own message; typed and dictated text stays in the field.
- Dictation route: the microphone stands in every field that takes text (the composer and the project note), whatever
  the server offers. A tap follows `RarogStore.dictationRoute` (`DictationPolicy`): with no choice, or with Soniox
  chosen while the server or the build does not offer it, the composer opens the Dictation screen as a sheet, and the
  note opens it as a page in its own navigation stack, because one sheet stands at a time and a Dictation sheet would
  replace the note. Choosing records nothing; the next microphone tap records. Both routes record under one
  `VoiceRecorder` (`RarogUI/Session/Voice/`): `SonioxStream` with a temporary key from the server at every attempt, or
  `SystemDictationStream` (`Session/Voice/System/`, `SFSpeechRecognizer`), which picks on-device recognition or
  Apple's servers before the microphone opens. A system recording writes two lines to `client.log`, never the text:
  at the start the API, the path and the locale, at the end the number of fragments committed after a pause, of
  closing results skipped as a repeat of the last fragment, and of recognition tasks.

The app terminal uses the wire described in "Emergency console" above; the app keeps up to four terminal screens
parked for 2 min after leaving them, so a return takes the same screen without a new socket. XCUITest runs against a
demo server that `scripts/ios-check.sh` starts on loopback for one run (never port 8930).

## Project notes

The server keeps ONE notes document per project and serves it through the API; the client is the native app (the
popover reads, the form writes; look in `design.md`, "Project note").

- **Store** (`server/src/notes/store.ts`): the file `notes/<sha256(realpath(cwd)), 16 characters>.json` in `dataDir`,
  `{"cwd": "…", "text": "…", "updatedAt": 1756800000000}`, atomic write, a cap of 48 kB of characters, no retention.
  A file in the list shape (`{"notes": [...]}`) is joined on every read (oldest text first) and written in the
  document shape only at the first mutation, so the list file is its own backup until then.
- **Routes** (`GET /api/notes?cwd=`, `PUT /api/notes`): the write is versioned by `updatedAt`; a stale version is
  **409** `conflict` with the current document, so two devices do not silently lose each other's changes. Deleting is
  a write of an empty `text`.
- **Events.** A successful `PUT` broadcasts the ephemeral event `notes {cwd, empty}` to every open client, without
  content. A directory that appears in the stream for the first time gets such an event once (`announceNewCwd` in
  `sse.ts`). The full `sessions-snapshot` frame carries `notesCwds`, the session directories of that frame with a
  non-empty note (`projectsWithNotes`). ONE definition computes emptiness (`notesEmpty` in `@rarog/shared`).
- **Killswitch** `RAROG_NOTES=0`: 404 on `/api/notes` and `sessions-snapshot` without `notesCwds` (the presence of the
  field is the only signal that Rarog speaks about notes); files in `notes/` stay. `notesEnabled` in `GET
  /api/version` carries the flag state.
- **Demo**: notes live in process memory (`server/src/demo/notes.ts`; the router gets the store through
  `RouterDeps.notes`). The seed is one note in the project of the `import` role (`ledger-import` in English,
  `data-loader` in Polish); the test control `reset` (`/api/demo/control`) returns to the seed, and the `note-remote`
  action fakes a write from another device.
- **Model in the app** (`RarogUI/Model`: `ProjectNotes`, `NoteDocument`, `NoteMerge`, `NoteDrafts`, `NoteMirror`):
  ONE document per directory with three versions: `server` (the newest known; it accepts only a higher `updatedAt`),
  `ancestor` (the base of the `PUT` and the common ancestor for Merge) and `conflict` (the version from another
  device). Autosave 2 s after the last change and at once when the form ends; one `PUT` in flight. A clean field
  takes a change from another device silently, a dirty one gets a conflict. The core keeps a "has a note" bit per
  directory (`notesPresent`), a change counter (`notesRevision`) and an epoch (`notesEpoch`, it grows on every
  `sessions-snapshot`, because events from a stream break are lost). Undo after Merge and Use Server Version stands in
  the status row for 5 s (`NoteDocument.undoHold`). Device drafts live in `<server space>/note-drafts/`.
- **Known limit (no fix): a project under two paths** (a symlink) is two documents in the app (`ProjectPath.normalized`
  strips only the trailing `/`) and one file on the server (`realpath`). The `notes` event carries the writer's path,
  so the document under the other path sees the change only in a new epoch, and its write on the stale version gets
  409 (a conflict), it does not overwrite.
