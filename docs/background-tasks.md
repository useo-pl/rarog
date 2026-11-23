# Background tasks of a Claude Code session

This document covers how Rarog learns about the tasks a Claude Code session runs in the background (commands,
subagents, workflows, monitors), when a task enters and leaves the list, and which tasks count as work.

**In short.** Rarog never asks the system about processes. It builds the `backgroundTasks` list from the session's
transcript file alone (`<uuid>.jsonl`, the Claude Code conversation log). A start is a tool result with a task
identifier. An end is a task notification (a `<task-notification>` text that the CLI inserts into the conversation)
with a final status, or a `TaskStop` or `TaskOutput` result. A subagent has a third state, standby: it finished its
turn but waits for its own background command. Its entry stays on the list with a `waitingSince` field, and a message
from the main agent to the subagent (a resume) clears the field or reopens a closed entry. A waiting subagent that
moves on by itself shows only in its own transcript file, which Rarog reads every 5 s; the same file gives the
subagent's own commands (`ownTasks`). A subagent in standby that has nothing left to wait for and has not moved for a
minute is dormant: it drops off the list until its file grows again. A subagent does not survive a CLI process
restart, so Rarog closes it by the start time of the new process, read from the CLI process registry. On attach the
list comes from the WHOLE file, so a Rarog restart does not lose tasks started long ago. A task without proof of its
end stays open.

The list travels to the app in `SessionSummary.backgroundTasks`. Three places in the server ask it whether anything
works: the `done` push (the push notification at the end of a turn with a result), the Live Activity and the session
restart. A subagent in standby is not work for the first two, but it blocks a restart, which would kill its process.
A turn caused by a standby notification alone gives no `done` push. The code lives in `server/src/herdr/background/`.

## Sources

- **Main transcript file** `~/.claude/projects/<slug>/<uuid>.jsonl`, the only source of the list. The follower
  (`server/src/herdr/jsonl-follow.ts`, the reader that follows the end of the file) reads it incrementally and hands
  every parsed entry to the task reducer. On attach (the follower opens the file) it reads for the conversation
  history only the tail, the tail window: backwards in chunks until it has `HERDR_HISTORY_MESSAGES` messages or reaches
  `HISTORY_MAX_BYTES` (8 MiB). The task reducer gets more: the task lines from the part of the file before the window,
  then the window ("Attach: full scan of the main file").
- **Session directory** `~/.claude/projects/<slug>/<uuid>/` next to the transcript, with two readers:
  - the workflow run layout: phases from `workflows/scripts/<name>-<runId>.js`, agents from
    `subagents/workflows/<runId>/journal.jsonl`, an agent's start time from the `mtime` of `agent-<id>.meta.json`, the
    `[phase · label]` tag from the first line of `agent-<id>.jsonl`. Reader:
    `server/src/herdr/background/workflow-run.ts`;
  - the subagent transcript file `subagents/agent-<id>.jsonl`: the time of its last entry and the subagent's own
    background commands. Reader: `server/src/herdr/background/agent-file.ts` ("Subagent transcript file"). This file
    creates no list entries; it says whether a listed agent that stood by writes again, and what it waits for.
- **The `origin` field of an entry.** By `origin.kind === 'task-notification'` the server recognizes the notice of a
  task end in the transcript; it uses the text only for the description (`server/src/herdr/background/notice.ts`). The
  mere PRESENCE of `origin.kind` or `turnOrigin` in a `user` entry with `isMeta: true` tells the server that something
  entered the conversation outside the transcript (a subagent message, a scheduled wake), which matters for the cause
  of a turn ("Standby-only turn: no `done` push").
- **CLI process registry** `~/.claude/sessions/<pid>.json` (reader: `server/src/cli-version.ts`, which also reports a
  process's CLI version and pending dialog). Background tasks use one number from it, `startedAt`, and only when exactly
  one live process holds the conversation ("CLI process restart").

Rarog does NOT read `agent-<id>.meta.json` outside a workflow run, the files of nested agents (a subagent starts them,
so they are not on the list), the content of workflow agents' files beyond the first-line tag, the `tasks/` directory
with command output (for the task list; the pull request reader reads one output file there, that of a recognized
`gh pr create` that ran in the background: `pull-requests.md`, "Reading"), the CLI footer on the pane screen, or the
system process list. A pane out of scope
(`inScope: false`, outside the `RAROG_HERDR_ROOTS` directories) has no follower and no reader, so it has no task list.

## Task lifecycle

The reducer (`server/src/herdr/background/reducer.ts`) is pure: it takes an entry and returns the open tasks in start
order. It skips `isSidechain: true` entries. Each item gives the event, its proof in the main file and the effect.

- **Tool call.** An `assistant` entry with a `tool_use` block of `Bash`, `Agent`, `Task`, `Workflow`, `Monitor` or
  `Skill`. The reducer keeps the description, the command (up to 1000 characters) and `subagent_type` until a result
  with the same `tool_use_id` arrives. The list does not change.
- **Background command start.** A `user` entry with a `tool_result` block and `toolUseResult.backgroundTaskId`: a new
  entry of kind `command`. When the paired call is `Monitor`, the kind is `monitor`, and a call without `description`
  gets its `until` condition as the description. This branch serves older transcripts, in which a monitor start
  carried `backgroundTaskId`; such a monitor has no deadline and no process restart rule.
- **Monitor start.** A result of a paired `Monitor` call with a non-empty `taskId`, no `taskType`, and the field
  `timeoutMs` or `persistent` (the shape `{taskId, timeoutMs, persistent}` in CLI 2.1.319): a new entry of kind
  `monitor`. Without a paired `Monitor` call the shape opens nothing; a text or `null` result opens nothing either.
  A monitor expires without a trace in the file (an `<event>` notification has no `<status>`), so the reducer closes
  it itself:
  - **Deadline.** `persistent: true` has none. Otherwise the deadline is the entry `timestamp` plus `timeoutMs`, or
    plus 30 minutes (the tool's cap) when `timeoutMs` is not a number of 0 or more. An entry without `timestamp`
    counts from the moment the follower reads it. The follower's clock (`expire`) runs on every read and on every
    stat tick, so a monitor expires also when the file does not grow.
  - **New CLI process.** A monitor that started before the `startedAt` of the pane's CLI process closes, the
    persistent one too ("CLI process restart: the agent does not survive it").
  - A notification with a final `<status>` and `TaskStop` close a monitor as any task.
- **Subagent start.** `toolUseResult.agentId`: a new entry of kind `agent` with the description, the subtype
  (`subagent_type` from the call) and the model (`resolvedModel`). A `Skill` run in the background gets the
  description `/<skill> <args>`.
- **A foreground end is not a start.** A result with `agentId` and a final `status` (`completed`, `failed`, `killed`,
  `stopped`), or `forked` without `background: true`, opens no entry: a subagent and a skill fork run in the foreground
  end this way (measured on CLI 2.1.216 and 2.1.296–2.1.303, the skill fork on CLI 2.1.309) and send no end
  notification. The reducer remembers the agent's description, subtype and model, because the result carries
  `canContinueAgent: true` and a resume (`SendMessage`) opens the entry from that data, without `startedAt`. A
  background start has `status: "async_launched"`, or `forked` with `background: true`; a result without `status`
  stays a start.
- **Workflow start.** `toolUseResult.taskId` with a non-empty `taskType`: a new entry of kind `workflow` with the
  summary (`toolUseResult.summary`, up to 120 characters) and the `runId` when it has the `wf_…` form. Resuming a run
  (same `runId`, new `taskId`) closes the older task with that `runId`.
- **Order of start recognition:** the monitor start, then `agentId`, then `taskId` with `taskType`, then
  `backgroundTaskId`.
- **End by notification.** A text with the `<task-notification>` tag, a `<task-id>` and a `<status>` of `completed`,
  `failed`, `killed` or `stopped`. The same notification sits in several entries: `user` with the content as a bare
  string, `queue-operation` (field `content`) and an `attachment` of type `queued_command` (field `prompt`). The entry
  leaves the list and its id joins the settled set; further copies change nothing. The only exception is a subagent
  standby ("Subagent: working, waiting, finished"). A notification without `<status>` (a monitor `<event>`) is not an
  end.
- **Orphan after a CLI restart.** `<status>stopped</status>` and a summary with "No completion record was found": the
  CLI does not know what happened to the task. A command, workflow or monitor stays open. A subagent closes: it lives
  in the CLI process, so nobody appends its real end. The rule looks at the kind of the open entry, not at the summary
  words, because no fixture and no measured transcript holds an orphan notification for an agent; in practice the
  process restart rule closes such a subagent first ("CLI process restart: the agent does not survive it").
- **`TaskStop`.** `toolUseResult.task_id` and a `message` that starts with "Successfully stopped task" close the task,
  which may get no notification at all. **`TaskOutput`**: `toolUseResult` with a non-empty `retrieval_status` and
  `task: {task_id, status}` closes the task when `status` is final; `running` changes nothing.
- **Start of an id that is open or settled** is ignored. A subagent returns to the list by a resume or a standby,
  never by a second start.
- **End without a start.** A notification, `TaskStop` or `TaskOutput` with an id this reducer never opened: mostly the
  end of a subagent's own command (started in its own file, ended through the main file's queue), or the end of a task
  whose start the reducer did not read. The id joins the settled set, the list does not change, and the reducer reports
  the id once in its `unstartedEnds` list.
- **New engine session, file truncation, append skip.** The engine session is the Claude Code conversation behind the
  pane; `/clear` and `/resume` start a new one. An append skip is an increment over the follower's read cap, which it
  jumps over without reading (the line `skipped … B` in `server.log`). The follower creates the reducer from zero and
  rebuilds the list from what it reads after the reset. A new engine session opens a new file with its own full scan;
  a truncation and a skip do NOT repeat the scan, so the list knows only what the follower reads next.
- **Driver swap.** After a break in the connection to the herdr socket (`re-attached`) a new driver (the herdr pane
  adapter, `server/src/drivers/herdr-driver.ts`) and a new follower take over the pane and compute the list from the
  whole file, while the manager (the server's session registry, `server/src/sessions/manager.ts`) keeps the session
  with the previous list. An end the previous follower did not send (appended right before the swap, lost when the
  follower closes) disappears with the new follower's first emission, which always goes out ("How the list reaches
  the app").

A task whose process died without any of these proofs stays open: the reducer does not guess process death. The
exceptions are a subagent and a monitor after a CLI process restart, where the reducer gets the start time of the new
process from the registry instead of guessing, and a monitor past its deadline.

### Subagent: working, waiting, finished

The CLI reports two of a subagent's three states with the same status `completed`. On the list one field tells them
apart: an entry without `waitingSince` works, an entry with `waitingSince` waits, and a finished agent is not on the
list. Shapes measured on CLI 2.1.295 and 2.1.296: the measurement fixtures `postoj.jsonl` and `wznowienie.jsonl` and
the excerpt of a real session `server/test/fixtures/herdr/tasks/incydent-postoj-agenta-2.1.295.jsonl`.

- **Standby.** A notification with an agent summary (`Agent "…" finished`), status `completed` and a `<note>` with the
  phrase "background work of its own still running": the agent finished its turn, but its own background command
  still runs. The entry stays and gets `waitingSince` equal to the `timestamp` of the entry with the first copy of the
  notification. The next, different standby notification moves that time forward; nothing moves it back. A standby of
  a closed or unknown agent opens the entry as waiting.
- **End.** Any other agent notification with a final status (a note with the phrase "no live background children",
  no note, or status `failed`, `killed`, `stopped`), and `TaskStop` or `TaskOutput` as for any task. The entry
  disappears, also when it waited.
- **Resume.** A tool result with a non-empty `toolUseResult.resumedAgentId` and `success` exactly `true`: the CLI's
  confirmation of a `SendMessage` from the main agent to the subagent, without a start field (`agentId`). A waiting
  entry loses `waitingSince`, a working entry does not change, and a closed agent returns with its remembered start
  data (description, subtype, model, `startedAt`) to the position it held.
- **An agent whose start the reducer did not see.** Its standby or resume opens a minimal entry: `id` and kind `agent`,
  without `startedAt`, subtype and model; the description comes from the quotes in the summary of its first
  notification that has one. With the full scan on attach this happens only after a skip or a truncation and in a
  file without a full scan.
- **Notification copies.** One notification sits in 2–3 entries (`enqueue` → `remove` → `attachment`, `enqueue` →
  `user`, `enqueue` → `remove`), which lag by up to a minute and can follow a newer notification of the same agent or
  its resume; the attachment carries the first copy's time, so file times are not monotonic. The reducer remembers a
  fingerprint of every processed notification with a final status (until its reset) and skips every copy. The
  fingerprint covers the notification alone, from `<task-notification>` to the last closing of that tag, because an
  agent result can quote a notification; copies are identical character for character, and two different
  notifications never are.
- **A note the reducer does not know.** An agent notification with a `<note>` that has neither phrase, or both, counts
  as an end, and the follower logs once per process `background tasks: unknown note in an agent task notification`.
  The note is read only from its place: the line right after the closing of the summary, followed by a line that
  starts with `<result>` or closes the notification (the only layout in the measured fixtures). The task name and the
  agent result are model text and can hold any tags, so a `<note>` elsewhere counts as unknown. The note of a command
  stopped on a timeout ("…start it again with `run_in_background`…") belongs to a command summary.
- **A standby in an entry without `timestamp`** (no fixture has one), or under the identifier of a task that is not
  an agent, counts as an end: without a time the entry cannot say since when it waits.

The reducer does not know when a waiting agent moves on by itself: the wake sits in the subagent file and leaves no
trace in the main file that points at the agent. So on the way to the app the list gets an overlay from that file.

### Wake: an agent in standby moves on by itself

The agent's own command ended, the CLI woke the agent, and the agent works on. Proof: an entry in the subagent
transcript file with a `timestamp` newer than `waitingSince`. Effect: the agent travels to the app WITHOUT
`waitingSince`, as working.

- **What it rests on.** In the measured files the first entry in the subagent file after a standby is always a wake or
  a resume (a `user` entry with `origin.kind` `task-notification` or `coordinator`), timed after the standby
  notification (`waitingSince` is the time of its `enqueue` entry), and the last entry before the standby is timed
  before it.
- **Facts compared, not a remembered verdict.** `merge.ts` keeps for each listed agent the time of its file's last
  entry and at EVERY emission compares it with the current `waitingSince` from the follower (`agentView`). A repeated
  follower list undoes nothing, and a read result that arrives after a standby change spoils nothing.
- **When a wake ends.** The next standby notification moves `waitingSince` past everything the agent wrote so far, so
  the agent waits until a newer entry appears. A resume and an end leave the overlay nothing to do.
- **Delay.** The subagent file is read on a 5 s tick (`TASKS_POLL_MS`) and right after each follower list. An agent
  that works longer than a tick shows as working within one tick; a wake shorter than a tick, followed by a new
  standby, may never show. An agent without `waitingSince` is a copy of the follower's object.

### Dormant: an agent in standby that does not come back

The CLI reports a standby when an agent stops while its own background task is alive. When that task ends without
waking the agent, nothing more about the agent appears in the file, and the entry would hang with `waitingSince` until
the CLI process restarts. Measured on CLI 2.1.296: an agent handed back its report with the `SubagentHandback` tool
while a monitor was alive (a notification with the standby note), the monitor expired (an event without `<status>`
stayed in the main file's queue without `remove`), and nothing woke the agent.

- **Rule** (`restsQuietly` and `refreshDormant` in `server/src/herdr/background/merge.ts`). An agent is quiet when:
  1. the follower knows it as waiting (`waitingSince`);
  2. the last read of its file succeeded and the file is known to its last line (`AgentFileFacts.settled`);
  3. the file has no entry newer than `waitingSince`;
  4. the agent has no open own command: every command open according to its file, minus the ends from the main file,
     counts, including commands of unknown fate that `ownTasks` does not show;
  5. the deadline of its other own tasks has passed (`settled.otherWorkUntil`, below).

  Quiet that lasts unbroken for `DORMANT_AFTER_MS` (60 s) makes the agent dormant: `mergedTasks` leaves it out, so the
  background pill (the `N in background` pill in the session header) does not count it, the stage line (the line under
  the session title in its list row that says what the session is doing) does not name it, and it causes no refusal
  of a session restart. Dormancy may
  start only after a file read that ended after the minute passed (otherwise the minute would rest on facts from
  before the read that carries the wake); it may end at any emission.
- **Return.** Dormancy deletes nothing: the follower keeps the entry, and the timer keeps reading the agent file every
  5 s. An entry newer than the standby brings the agent back as working; a new standby notification as waiting, with a
  new minute. A resume, an end and a failed file read work as always.
- **Why condition 4 and a minute.** After a standby with a report handed back the agent often works on, woken by its
  own task or resumed, and every measured standby after which the agent came back had an open own command. The wake
  entry follows the command end in the main file's queue within milliseconds, but the follower may read the agent file
  before it lands, and the next read is a tick away; the minute is a margin over the tick and over what the
  measurement did not cover.
- **File known to its last line** (`settled`, `agent-file.ts`). The reader read the file from the first byte without
  holes, the last read reached the file size, no unfinished line remains, and the last complete line gave its own time.
  An attachment has none, with one exception: the record of a `SubagentStop` hook (`subagentStopHook`), which the CLI
  writes at every stop of the agent, after its last entry and at its own time (CLI 2.1.330). With such a hook it is the
  last line of the file in every standby, so without the exception no agent would go dormant. A hole removes the
  proof until the engine session changes: a skip, a truncation or a swap
  of the file, a line over 8 MiB, a line that matched the prefilter but did not parse. Such a line could carry a task
  start, and without the proof "no newer entry" means only "none seen".
- **Other own tasks** (`settled.otherWorkUntil`). Dormancy lifts the restart block, so an agent that may wait for
  something other than a command stays listed. A `Monitor` call holds it until the call time plus `timeout_ms`, or 30
  minutes without a readable field (the tool's cap in CLI 2.1.296), because a monitor expiry does not show in the file.
  An `Agent`, `Task` or `Workflow` call holds it for good: the reader does not know the fate of such a task. A copy
  of an API request message (`api-request-blob`, `requestBlob`) does not count: it has no time, and its tool calls
  repeat calls already read from their own entries.
- **Clock.** `emitChanged` computes quiet right before every emission, on the driver's clock (`Scheduler.now()`), and
  keeps it in state (`quiet`, `dormant`): the only remembered verdict in `merge.ts`, because elapsed time is a fact
  about the clock, not about the files. The manager checks the task list before the session restart checks and again
  right before `/exit`, because a dormant agent can return while the checks wait for reads.
- **Without the reader** (`RAROG_AGENT_FILES=0`) the rule does not exist: the agent stays waiting until a resume, an
  end or a CLI process restart.

### CLI process restart: the agent does not survive it

A subagent lives in the CLI process, so Rarog assumes that it ends with the process, although the transcript file does
not say so. Measured on CLI 2.1.296 (`measured/resume-cli.jsonl`): after `/exit` with the option "Exit and stop tasks"
the CLI appends one `killed` notification about the subagent's COMMAND, and after `claude --resume` it appends
nothing; nothing about the subagent itself appears. A closed pane and a session restart from Rarog are unmeasured, and
the Claude Code agent view docs (section "The supervisor process") say that under the supervisor, background commands
and subagents pass to the next process; for a herdr pane the rule is a precaution. The missing fact comes from the CLI
process registry.

- **Event and proof.** The CLI process that alone writes this conversation started at time T: the file
  `~/.claude/sessions/<pid>.json` of a live process with this conversation's `sessionId` has `startedAt` (epoch
  milliseconds). Measured on CLI 2.1.286–2.1.296: an integer 1 to 7 s after the process start, unchanged in processes
  whose registry file was rewritten many hours after start.
- **Effect.** The reducer closes every open task of kind `agent` whose last proof of life (the newest `timestamp` of
  its start, resume and standby entries) is older than T. A proof equal to T or newer keeps the agent. A resume or a
  standby with a time after T brings the agent back to its list position with its start data. A monitor of the main
  agent (the "Monitor start" shape) whose start is older than T closes the same way, the persistent one too; a start
  without `timestamp` gets the read moment as its time, so it closes only when T is after that moment.
- **What the rule leaves alone.** Commands, workflows and monitors from a `backgroundTaskId` start: a `killed`
  notification closes a command, and a workflow run can be a separate process. Also an agent without a known time
  (a start or resume in an entry without `timestamp`; no fixture has one); a resume without a time clears the older
  proof, because the agent lived after it.
- **Order does not matter.** The reducer remembers T and applies it to entries read afterwards, so a Rarog that starts
  next to an already restarted CLI gets the same result whether T comes before or after the file history.
- **When the rule does not apply.** The registry cannot be read, the conversation is not in it (the process just
  exited), the entry has no `startedAt`, the start time lies after the server clock's current time, two processes
  write the conversation, or reading the registry is off (`RAROG_CLI_WAITING=0`). The agent from before the restart
  then stays listed (gap "Agent from before a CLI restart when the registry is silent").
- **One entry is not one process.** The registry knows only files that exist and could be read. There is no rule for
  any conversation while a live CLI process has a registry file without an entry (mid first write, an unknown shape,
  over 16 KiB), until the next full read (`unreadablePids` of the snapshot), and none for a conversation while a
  process that wrote it lives without its registry file (`unlistedSessions`: the reader remembers which conversation
  each seen pid wrote, as long as the pid lives). Otherwise an unreadable or vanished file of the older of two writers
  would close its live subagent, and nothing would undo the close.

The fact's path: the manager reads the registry in the same read as dialog detection (every 1.5 s, and every 30 s in
the CLI version snapshot). When the conversation has exactly one live process with a known start time
(`cliProcessStartOf` in `cli-version.ts`), it calls the driver's `noteCliProcessStart`. Three kinds of session card (a
card is one session on Rarog's list, the manager's `Session`) get nothing: a Codex session (Rarog also runs Codex
panes, and Codex is not Claude Code), a pane out of scope, and a card without a herdr pane (`herdrKey`). The driver
facade drops a fact about a conversation other than the pane's (a read from before `/clear` or `/resume`) and hands
the time to the follower (`noteProcessStart`). The follower passes it to
the reducer only when it differs from the last accepted one, sends a `tasks` event after a list change, keeps the time
for reducers it creates after a truncation or a skip, and forgets it on `/clear` and `/resume`. The rule lives in
`reducer.ts` (`processStarted`). Because the manager repeats the time at every read, the fact reaches a new driver, a
conversation after `/clear` and a Rarog that started next to a restarted CLI without a separate path for each case.

### Subagent's own commands (`ownTasks`)

A subagent starts background commands itself, and these are what it waits for in standby. Their start sits in the
subagent file, so they are not separate list tasks: they travel under their agent in the `ownTasks` field (id, command
text up to 1000 characters, start time), under a working agent too.

- **Start.** A subagent file entry with a `tool_result` block and `toolUseResult.backgroundTaskId`, the same shape as
  in the main file, with the command text (`tool_use.input.command`) from the call paired by `tool_use_id`. The same
  machine reads it (`reducer.ts` with the `sidechain` option, which lifts the `isSidechain` gate), one instance per
  subagent file.
- **End, three sources.** (a) A notification in the MAIN file's queue: an end without a start, which the follower
  carries in `ended`. (b) A notification in the subagent's own file, the `user` entry that wakes it. (c) A `TaskStop`
  result in the subagent file. The file reader sees (b) and (c) itself; `merge.ts` hands it (a) at every read, and the
  reader closes such commands for good, so its list does not grow over the agent's life.
- **End before start.** The main file is read at once, the subagent file on the 5 s tick, so the end of a short
  command can come first. `merge.ts` keeps the ids from `ended` for the whole engine session; a command whose id is
  there never appears.
- **Unknown fate.** Every `tasks` event carries `since`, the time of the first entry the reducer saw since its reset:
  after an attach the first entry of the FILE (full scan), after a skip or a truncation the first entry read
  afterwards, in a file without a full scan the first entry of the tail window. An `attachment` does not set `since`,
  because it carries the time of the notification's first copy. The end of a command started before `since` could sit
  where Rarog did not read, so such a command without a known end is NOT shown, nor is a command without a start time,
  nor any command while `since` is unknown.
- **Cap and scope.** At most 20 commands of one agent travel to the phone (`OWN_TASKS_MAX`), the newest, in start
  order. A nested subagent, a workflow run and a monitor started by a subagent do not go into `ownTasks`.

The driver test replays this chain on real files from the fixture `measured/postoj.jsonl`.

## Attach: full scan of the main file

On attach the follower reads the tail of the file (up to 8 MiB), enough for the conversation history. A task list from
the tail alone would miss everything that started before the window: after a Rarog restart a subagent whose start and
resume lie there would stay invisible until its next standby, and older subagent commands would have unknown fate. So
on attach the task reducer gets the task lines from the WHOLE file.

- **When.** At every opening of a file by the follower: a pane attach (also after a Rarog restart) and a new engine
  session (`/clear`, `/resume`). Never during work: an append skip and a file truncation reset the task state without
  a new scan (the artifact list has its own scan then, `artifacts.md`).
- **Order.** The part before the window in file order, then the window entries, because for the reducer order is
  content: a call before its result, a start before its end, the first copy of a notification before its repetition.
- **Tasks and artifacts only.** The scan's second sink is the artifact list (`artifacts.md`, "Lifecycle in the
  follower") with its own prefilter; a line that either prefilter lets through is parsed once. The transcript,
  permissions, context usage and the echo of Rarog's own prompts know only the window. The follower sends the history
  and the window state first and scans after them, so the scan delays only the task list and incremental reading.
- **Streaming.** `server/src/herdr/background/main-scan.ts` reads 1 MiB chunks; memory holds one chunk and one
  unfinished line, and the event loop gets a breather between chunks.
- **Prefilter.** Only a line that can change the list reaches `JSON.parse` (`mayCarryTask`): a tool call with the name
  of a task tool (`TASK_TOOLS` from the reducer), the notification tag, the start fields (`agentId`, `taskType`,
  `backgroundTaskId`, and `timeoutMs` and `persistent` of a monitor start), the resume field (`resumedAgentId`), the
  `TaskStop` sentence and the `TaskOutput` field. Field names are searched in quotes, so a quote inside content (after
  a backslash) does not pass. The literals come from the
  `CLI_SHAPES` registry; one pattern pass per line read byte for byte (`latin1`), without UTF-8 decoding. Until the
  first entry with a time, every line reaches the reducer, so after the scan `since` is the file's first entry.
- **Same result as every line.** A differential test (`herdr-main-scan.test.ts`) compares the reducer state after the
  scan with the state after feeding every line unfiltered: after any line, after the whole file, and for window starts
  mid-file, on fixtures interleaved with noise.
- **Byte-exact boundary.** The window starts mid-line and drops that cut line; the scan takes everything up to and
  including the first `\n` at a position not less than the window start. No line reaches the reducer twice or is lost.
- **Separate reducer.** The scan writes into a fresh reducer, which the follower takes into use only after a successful
  end, together with the window entries; until then the list is empty, never half-built. `/clear` during the scan
  invalidates its result. A late read retry does not start a second scan that would swap out a reducer already fed
  live.
- **Caps.** With more than 1 GiB before the window (`MAIN_SCAN_MAX_BYTES`), or after a read error, the scan does not
  run: the list comes from the window alone, and `server.log` gets one line
  `… background tasks before the tail window are not visible …`. The cap leaves room above the largest transcript
  measured (236 MiB); the scan costs about 2.5 ms per MiB, so a file at the cap takes about 2.5 s, read in chunks
  that yield to the event loop. A line longer than 8 MiB
  (`MAIN_SCAN_LINE_MAX_BYTES`) is skipped without being assembled in memory. For a file over 8 MiB
  (`TASKS_SCAN_LOG_BYTES`) the follower logs the cost:
  `background task scan before the tail window: <bytes> B in <time> ms, parsed <n> of <n> lines`.

One known difference from "every line" is in the reducer, not in the list: an ordinary `Bash` result does not pass the
prefilter, so its call stays in the map of calls waiting for a result until the cap pushes it out
(`PENDING_CALLS_MAX`, the newest 256). A task start comes right after its call, out of the cap's reach.

## How the list reaches the app

1. After each entry the follower compares the list signature (identifier, `waitingSince` and description of each
   task). A `tasks` event goes out on a signature change with a copy of the array. Task objects are shared by
   reference all the way to the session, so the reducer never changes one in place: a state change swaps the object.
   An end without a start also sends an event: the list stays, and `ended` carries the ids closed since the previous
   event (counted from zero after a reducer reset). A `since` set after a non-empty list went out sends an event too,
   and a CLI process start that closed an agent changes the list from outside the file. On attach the first list goes
   out after the full scan, after the history.
   **The first emission after attach always goes out, even empty.** An emission is one `tasks` event; the follower's
   `#payTasks` sends the first one unconditionally (the same rule as for the artifact list), because the receiver
   holds the previous follower's list after a driver swap and only a fresh list overwrites it. Without a
   transcript file the empty emission goes out at once (a glob miss on the uuid, an identifier outside the pattern);
   further misses emit nothing, and a file that appears gives a list like any change. An emission that is armed but
   not yet sent (the first one after attach included) still goes out after `/clear` or a truncation, with the list
   rebuilt from zero. For a file that cannot be read the follower emits nothing.
2. The driver facade hands the list to `noteTasks` (`server/src/herdr/background/merge.ts`). The `tasks` event is not
   a sign of file activity for the driver (like `artifacts` and `echo-dropped`). Two driver timers measure silence
   from the other follower events (message, activity, usage, pending tool, turn input): the stall guard, which
   presses Esc twice and sends the prompt again when herdr reports a stalled prompt and the pane and the file stay
   silent, and the turn watchdog, which after 15 s (`HERDR_TURN_WATCHDOG_MS`) takes a send that did not move the pane
   as stuck. `merge.ts` overlays what it knows from the files next to the transcript: the last read layout (`run`) on
   a workflow task, no `waitingSince` on a subagent whose file has a newer entry ("Wake"), and each subagent's open
   commands (`ownTasks`, without those in `ended` and those from before `since`). It emits `background-tasks`: the
   first list always, even empty (`TasksState.sent` equal to `null`), then only when the merged list differs from the
   last one sent.
3. The manager stores the list in `Session.backgroundTasks`; an empty list removes the field, and an empty list for an
   absent field broadcasts nothing. The event does not change the session state and does not enter the ring buffer;
   clients get `session-changed`. **Driver swap** (`#herdrReattached`) keeps the session object with its list only for
   THE SAME conversation in scope (the pane's `agentSessionId` equals the session's `engineSessionId`), so the pill does
   not flicker and restart keeps its block until the new driver's first emission. When the pane writes another
   conversation or has left `RAROG_HERDR_ROOTS`, the manager removes the field, together with the artifact list,
   before broadcasting the card; otherwise the previous conversation's list would show a background pill, refuse
   restarts and hold back the `done` push. Path test: `server/test/herdr-tasks-integracja.test.ts`.
4. The app gets the list in `SessionSummary.backgroundTasks` (frames `session-changed` and `sessions-snapshot`).

## Contract

The types live in `shared/src/protocol.ts` (`BackgroundTask`, `AgentOwnTask`, `WorkflowRun`, `TranscriptNotice`), and
their Swift mirrors in `RarogContract` (`SessionSummary.swift`, `Transcript.swift`). Fields and their meaning:
`implementation-spec.md`, "Background tasks" and "Harness notices". The server sends three facts about a standby:

- **`BackgroundTask.waitingSince`** (ISO, kind `agent` only): since when the subagent waits for its own background
  task; present means neither working nor finished. The reducer fills it, and `merge.ts` removes it after a wake.
- **`BackgroundTask.ownTasks`** (`{ id, command?, startedAt? }[]`, kind `agent` only): open commands the subagent
  started itself, assembled by `merge.ts`; absent when the server knows no open command.
- **`TranscriptNotice.outcome: 'waiting'`**: the notice of a standby, from `notice.ts` ("Notice in the transcript").

Golden frames (reference SSE frames in `shared/fixtures/sse/`) cover them: the task `agent_9b2c` in
`session-changed.max.json` and `sessions-snapshot.max.json`, the notice in `message.notice-waiting.json` and
`transcript-snapshot.notice-waiting.json`. The app's list cache does not store own command text
(`SnapshotCacheFile.scrub` removes `ownTasks[].command` and keeps `waitingSince`).

### What the app shows

The labels below are the app's English copy; the app also speaks Polish and follows the device language
(`localization.md`). The Background section is one section in two places: the popover of the background pill
(`N in background`) and the inspector, a column on iPad. On iPhone the pill opens the inspector as a sheet. A model
computes the rows (`BackgroundPanel.lines`, `BackgroundTaskRow`, `OwnTaskRow` in
`RarogUI/Model/HeaderStatusModel.swift`), and a shared view draws them
(`Views/Header/BackgroundTasksSection.swift`).

- **A working subagent**: a work dot and the full description, under it a timer from `startedAt`, then the meta line
  `subagent · agent type · model`.
- **A waiting subagent** (`waitingSince`): an hourglass instead of the dot and one line
  `waiting on its own task · 18m`; the timer counts from `waitingSince`. `BackgroundTaskRules.waitingAgent` decides
  that the agent waits; the row takes only the moment from the field, and without a valid time it shows no timer.
- **A finished subagent** has no row. Its end shows as a transcript notice and in the inspector's Recently finished
  section (`FinishedTasks.rows`), where a standby notice never goes. The transcript line of a `waiting` notice:
  `Subagent is waiting on its own background task: “<name>”.` (`UICopy.harnessNotice`).
- **Own commands** stand under their agent on a branch, one per line: the command's tools in monospace and the time
  since `startedAt` (`pnpm test · 21m`). Under a waiting agent the list starts with the line `waiting on:`. An item
  without `command` says `command`, one without `startedAt` has no timer. An agent without `ownTasks` has no line under
  it, because the server hides commands of unknown fate. A list from the app cache has no command text, so until the
  first fresh frame every item says `command`.
- **VoiceOver** reads each line as one sentence, for example `subagent <description>, waiting on its own task for 18
  minutes, <type and model>` and, under a waiting agent, `waiting on: <command tools>, for 21 minutes`; the
  `waiting on:` line itself is silent.
- **Session list and header:** with only subagents in standby, the stage line says `waiting: subagent · <description>`
  (with several, `waiting: 2 subagents`) without the green dot, and the background pill counts all tasks but has no
  dot ("What counts as work").

The app shows a command shortened to its tools (`CommandTools` in `RarogUI/Model/CommandTools.swift`):
`bash /…/batch-run.sh review --uncommitted --dir …` becomes `batch-run.sh review`, `grep -rn x src | head -40` becomes
`grep | head`, `cd server && pnpm install && pnpm test` becomes `pnpm install, pnpm test`. The program name stays
without its path (for tools with subcommands and for scripts also the first word); flags, paths, quotes, variables and
wrappers (`bash`, `xcrun`, `env`) go; `cd`, `echo` and `sleep` stay only when nothing else is left; at most three tools,
then `+N`. A path from a variable or in quotes is a script too (`bash "$W/scripts/ios-check.sh"` becomes
`ios-check.sh`); a bare variable (`$CMD`) is not a tool. This form appears in a task row's meta line
(`command · swift test`), as the first line of a task without a description and in own commands. When the shortening
recognizes nothing, the meta line says only `command`, and a task without a description or an own command shows up to
60 characters and `…` (`CommandTools.clipped`). Copy Command in the context menu and in the VoiceOver actions gives
the raw command.

The server sends the first 1000 UTF-16 code units of a command (`TASK_COMMAND_MAX`, cut by `clipUnits`), enough for
the program name even after long variable assignments. The app treats a command of 1000 units or more, or of exactly
200 (the cap of a server release that sends at most 200; server and app ship separately), as truncated and does not
take its last word for a tool.

The demo server (`pnpm run demo:server`, fakes without herdr) has a controlled pane `standby`
(`server/src/demo/scenarios.ts`): one subagent in standby for 18 min with two own commands (the second without text)
and a standby notice in the history; the `agent-wake` event clears the standby. `StandbyAgentUITests` runs on it.

## Workflow run layout

While the list holds a `workflow` task with a `runId`, `merge.ts` asks the run reader for each open run's layout every
5 s (`TASKS_POLL_MS`), and a layout change sends the list again. A closed run leaves memory at the next follower list.
The same timer reads the files of listed subagents; it runs while the list holds any run with a `runId` or any agent.
The run reader (`server/src/herdr/background/workflow-run.ts`) reads the journal incrementally from a remembered
offset, reads phases and agent descriptions once, and after a run resume filters out agents interrupted before the
last launch.

`server/src/herdr/background/satellite.ts` finds the session directory: a glob on the transcript uuid, then `stat` of
the directory with the same name without the extension. Each of the two readers keeps the address until `repoint()`
(new engine session) or `relocated()` (files moved); both calls invalidate a search that started before them. The
identifier guards in `ids.ts` allow a `runId` only in the form `wf_<id>`, and an agent id only with letters, digits,
`_` and `-`, before either goes into a disk path. A read result enters the state only when the engine session did not
change during the read (`generation` in `TasksState`, bumped by `forgetSession` on `/clear` and `/resume`) and its
task is on the follower's list.

The turn pulse (`server/src/herdr/session-pulse.ts`) watches the same directory for another purpose: during a turn it
tells the activity line that subagents write while the main file is silent. It does not change the task list; it
takes the directory address from `satellite.ts` and keeps its own copy.

## Subagent transcript file

The reader `server/src/herdr/background/agent-file.ts` reads `<session directory>/subagents/agent-<id>.jsonl` of every
subagent on the follower's list and returns two facts: the time of the last entry (`lastEntryAt`) and the open own
commands (`commands`: a start in this file and no end in it or among the ids passed at the read). `merge.ts` decides
"waiting or working" and which commands to show.

- **Incremental.** The reader remembers per agent how many bytes it processed and reads the rest up to the size at
  open time, at most 1 MiB per read (`AGENT_FILE_CHUNK_BYTES`), with a breather for the event loop between chunks. An
  unfinished last line waits in a byte buffer. The memory lasts until `repoint()` or close, also after the agent leaves
  the list, so a resumed agent is not read from zero.
- **Prefilter.** Only lines that can carry a tool call or a command start or end reach `JSON.parse`
  (`mayCarryOwnCommand`: `"tool_use"` in quotes, `backgroundTaskId`, the notification tag, the `TaskStop` sentence,
  the `TaskOutput` field), plus the chunk tail for the time. Ordinary tool results are not parsed, so the reducer gets
  calls whose result never comes; the map of waiting calls drops the oldest above `PENDING_CALLS_MAX` (256).
- **Last entry time.** The reader parses each chunk from the end and stops at the first entry with its own time. An
  `attachment` carries the time of the notification's first copy, so it counts toward the maximum, but the reader does
  not stop at it; the `SubagentStop` hook record is the exception (see "Dormant"). A time once read never moves
  back. Times compare as instants; a `timestamp` that is not a date does
  not count.
- **Skip and other content.** An increment over 256 MiB (`AGENT_FILE_MAX_READ_BYTES`; the first attach counts from
  zero) is not read in full: the reader takes a tail of that length without its first, cut line. A line over 8 MiB
  (`AGENT_FILE_LINE_MAX_BYTES`) is skipped. A file shorter than at the last read, or swapped (another inode under the
  same name), is read from its end. A move (`rename(2)`, `EnterWorktree`) keeps the inode, so after `relocated()`
  reading continues in place. A skip, a truncation and a swap create the agent's reducer anew: commands from before
  them get unknown fate and leave the list, while the last entry time stays.
- **Cost.** The first attach to a file over 1 MiB logs one line per agent:
  `subagent file: first attach to agent-<id>.jsonl: <size> B in <time> ms`.
- **Bounds.** The agent id passes `isAgentId` before it goes into a path. A pane out of scope gets no reader. A missing
  directory or file is "unknown" (`null`), not an error: the agent is just starting.

### The `RAROG_AGENT_FILES` switch

Default `1`. `0` (an `env` entry in the server config file and a restart, `server-config.md`) turns off all reading
of subagent files: the driver creates no reader. A subagent after a standby then stays waiting until a resume or an
end, never goes dormant, and has no `ownTasks`; the 5 s timer runs only for workflow runs. The flag is a preference,
like `RAROG_CLI_WAITING`, not a killswitch (one of the flags that switch a capability off): the reader approves
nothing and sends nothing to the pane. Set it to `0` when the `subagent file: first attach` line shows too high a
cost, or when a Claude Code update changes the layout of subagent files. In demo mode the reading is always off.

## Notice in the transcript

The CLI injects a task end notification into the conversation as a `user` role entry. `parseImportLine`
(`server/src/transcript-import.ts`) recognizes it by `origin.kind === 'task-notification'` and adds a `notice` field to
the message, computed by `noticeFromText` (`server/src/herdr/background/notice.ts`): the kind from the start of
`<summary>`, the result from `<status>` (`completed` → `done`, `failed` → `failed`, `killed` and `stopped` → `halted`;
an orphan has no result), the name from the first quotes (up to 80 characters), the exit code from `exit code N`.
Contract details: `implementation-spec.md`, "Harness notices". The app composes the sentence for the human.

One result does not come from the status: `waiting`, the subagent standby. A standby notification has status
`completed`, but the agent is not finished, so an `agent` notice gets `waiting` instead of `done`. `notice.ts` asks
the same function as the reducer (`isAgentStandby` in `notification.ts`), so a notification after which the list keeps
the agent waiting gives a `waiting` notice, and one that closes the agent gives `done`. The reducer has two more
conditions, about the list, not the content (an entry `timestamp`, no open task of another kind with that id); no
fixture has either case. A notice of another kind, `unknown` included, never gets `waiting`, and a note with unknown
wording gives `done`.

The same carrier reports the end of an ARTIFACT watch: a notification with `<task-type>` `artifact-watch-lifecycle`,
without id and status. The notice gets the kind `artifact-watch` (checked first, and only in the notification header)
with the artifact title as the name and no result; the reducer leaves it alone. The app keeps this notice out of
Recently finished, where it would look like a false task end; the artifact list shows the deletion (`artifacts.md`).

One parser splits the notification text: `parseTaskNotification` in `server/src/herdr/background/notification.ts` (id,
status, summary, name, exit code, whether the summary belongs to an agent, the kind of the `<note>`, and for an
artifact watch end the `<task-type>` and the URL). The reducer takes the id, status, summary and note; `notice.ts`
gives the fields their meaning. The gates differ on purpose: the reducer checks the `<task-notification>` tag in the
text (`isTaskNotification`), because it looks at every queue entry, while the notice goes by `origin` and accepts a
text without the tag.

## What counts as work

Three places in the server ask the list whether anything works, and each asks something different. One module,
`server/src/herdr/background/work.ts`, computes all the answers, and callers only call its functions. In the app the
mirror is `native/Rarog/Packages/RarogCore/Sources/RarogCore/BackgroundTaskRules.swift` (`BackgroundTaskRules`), which
the core selectors and the `RarogUI` view models ask.

**A subagent in standby is not work.** "In standby" means a task of kind `agent` with `waitingSince`; one function
defines it on each side (`waitingAgent` in `work.ts` and in `BackgroundTaskRules.swift`). The rules get the list after
the subagent file overlays, so an agent that moved by itself has no `waitingSince` ("Wake"). `waitingSince` on a task
of another kind means nothing. Own commands (`ownTasks`) enter only the owed `done` rules: an owed `done` is a result
push that the scheduler remembers per session after background work held it back, and sends at the first quiet
moment ("Standby-only turn: no `done` push"). The only exception to the principle is the session restart.

**A monitor is not work either.** A task of kind `monitor` watches for an event and may wait for it for up to
30 minutes or for good, so it neither holds a `done` push, nor counts as live work, nor blocks a session restart;
one function defines it on each side (`watcher`). It stays on the list and in the pill (`hasTasks`).

Server:

- **`done` push, arming**: `tasksHoldingDonePush`, the number of listed tasks minus subagents in standby and
  monitors. The manager
  hands it to the push scheduler (`server/src/notify/index.ts`) at the turn end (`#note` in
  `server/src/sessions/manager.ts`), and `doneOrSilence` (`server/src/notify/policy.ts`) stays silent above zero.
- **`done` push, check before send**: the same number again. The `done` push waits 15 s, and in that time the list
  changes without a session state change, so the scheduler takes a fresh number before sending (`sessionLook`, called
  from `server/src/index.ts`), and `decide` cancels the armed push above zero (`stillHolds` in `policy.ts`). Background
  work does not silence the `blocking` class (waits for a decision) or the `failure` class (work stopped). Only the
  list at check time counts: a subagent that moved and stood by again within the window cancels nothing.
- **Owed `done`**: `waitingOnOwnCommand` (a subagent in standby with a non-empty `ownTasks`), asked at the turn end and
  before send, and `holdsOwedDone` (either rule above), asked before and after every list swap ("Standby-only turn").
- **Session restart on a new CLI**: `tasksBlockRestart` blocks on any listed task except a monitor, a subagent in
  standby included, because the restart kills the CLI process with the agent and the command it waits for. A monitor
  alone does not block: it only watches, and the new process closes it on the list ("CLI process restart").
  `onlyWaitingAgents` picks the refusal: `RESTART_WAITING_AGENT_MESSAGE` (a subagent waits with its own task) for
  only waiting subagents, otherwise `RESTART_TASKS_MESSAGE` (a background task runs), both in
  `server/src/sessions/manager.ts`.
- **Live Activity** (`server/src/notify/live-activity-state.ts`): the working counter (`hasBackgroundWork`) counts a
  session after a turn (`waiting-input`, `done`, `resumable`) with a live task: a non-workflow task that is neither a
  subagent in standby nor a monitor, or an open run (no layout, no agents, or an agent in flight). A session whose
  whole background waits does not count as working, and with an unacknowledged result (`waiting-input`,
  `seen !== true`) counts as finished. The silence timer (`isBusy`) is held only by an open workflow run (`hasOpenWorkflow`), because a
  development server in the background would hold it forever. The run list (`workflowsWithRun`) has the `workflow`
  tasks with a read layout from all sessions.

App, computed without the server:

- **Row rank and tone**: `tasksKeepRowWorking`, a listed task that is neither a subagent in standby nor a monitor
  (`Selectors.swift`:
  `listRank` gives the work rank to a session with an acknowledged result and to a `done` session; `statusTone` turns
  the unread and silence tones into the work tone). A session whose list holds only tasks that do not work (subagents
  in standby, monitors; `hasTasks` without `tasksKeepRowWorking`) gets the tone `backgroundWait` instead of silence
  in `waiting-input` with an acknowledged result, `done` and `resumable`: the smoked green `runSmoked`, without the
  work dot. An unacknowledged result stays unread. Rank, push and the Live Activity count it as silence. The status
  word stays the silence word, so the session tab's VoiceOver sentence adds the tone word after it
  (`UICopy.tabSpoken`), and the tab's status mark keeps full opacity also on a tab that is not current.
- **Live Activity start state**: `hasBackgroundWork` and `hasOpenWorkflow`, as in `work.ts`
  (`Selectors+LiveActivity.swift`, `aggregate` and `matches`). They differ from the row in one case: a run whose agents
  all finished while its task is listed is work for the row, not for the Live Activity.
- **`RarogUI` models** (`native/Rarog/Packages/RarogUI/Sources/RarogUI/Model/`) never test list emptiness themselves,
  because a waiting agent would then get the work sign. The green dot and `working in the background` come from
  `tasksKeepRowWorking`: the state word in `RowStatus` and the stage line dot in `stageLine` (`SessionRowModel.swift`),
  the pill's dot in `BackgroundBadge` (`HeaderStatusModel.swift`). The pill shows for any listed task (`hasTasks`;
  `StatusPills.background` in `SessionPillsModel.swift`), because a waiting agent must stay visible. The stage line
  sentence comes from `onlyWaitingAgents` (`backgroundText` in `ActivityText.swift`).
  An open workflow run on the list comes first on the stage line, during a turn and after it: `openWorkflows`
  (the same openness as `hasOpenWorkflow`) lists them, and `ActivityText.liveWorkflow` picks the first one with an
  agent in flight, otherwise the first one. The line says the phase before the name (`phase 2/3 Review · name`),
  and the phase bar from the run layout stands under the row; with no phases (layout not read yet, or a run without
  tags) the line is the one-task sentence (`background: workflow · name`) with the dot and no bar. So a subagent
  of the main agent or another task on the list does not push the workflow off the row. A pending decision and stale
  data still win: the row then has no stage line. A run whose agents all finished does not take the line.
  With no open workflow on the list: while a session works and its current activity (`SessionSummary.activity`) is
  a delegation of the main agent (a tool call shown as `subagent: …` or `workflow: …`), the stage line shows that
  delegation instead of the rest of the list. Its dot then shows only when no workflow progress bar is drawn under the line, and
  the list is not asked. So a working session with a live delegation and only a subagent in standby on the list has
  a dot on the stage line (someone works in this turn) and none on the pill (nothing on the list works).
  `waitingAgent` gives the pill's VoiceOver words for one task. `workingAgent` supplies the stage line description
  from the working agent, not from the one in standby, when the activity says `subagent working` without a
  description (`ActivityText.cardText`).

The app has no counterpart of `tasksHoldingDonePush`, `tasksBlockRestart` and `workflowsWithRun`: pushes, restarts and
the run list are the server's. Two tables hold the answers for every list shape:
`server/test/herdr-background-work.test.ts` and `BackgroundTaskRulesTests.swift`. The golden frame
`shared/fixtures/apns/live-activity.update.waiting-agent.json` guards the shared Live Activity case: four sessions after
a turn give `waiting: 0, working: 2, finished: 1`, and the app core must build the same state
(`LiveActivityInputTests`).

Two guards keep the rules in one place. `server/test/herdr-background-boundary.test.ts` keeps `sessions/manager.ts`,
`sessions/session-restart.ts`, `sessions/conversation-lists.ts` and `notify/**` from computing on tasks (no length,
search, loop, decision by task kind, or reading of `waitingSince` and `ownTasks` outside `work.ts`). In the app,
`BackgroundTaskRulesGuardTests.swift` scans `RarogCore/Sources` and `RarogUI/Sources`: outside
`BackgroundTaskRules.swift` the word `backgroundTasks`, a task kind comparison and a `waitingSince` read may appear only
as an argument of a `BackgroundTaskRules` function or in a line from the test's closed exception list, each with a
reason (an exception whose line is gone fails the test). The guard does not track a list under another name; behavior
tests in `RarogUILogicTests` cover that (`SessionRowStageTests.swift`, `ActivityTextTests.swift`, `BackgroundRowTests`
in `HeaderModelTests.swift`).

## Standby-only turn: no `done` push

The CLI inserts every standby notification into the conversation as a `user` role entry. The main agent wakes,
answers with a sentence ("still waiting") and ends the turn. Nothing ended, but the turn end alone would arm a `done`
push, so Rarog stays silent.

- **Rule.** A turn in which, since the previous turn end, the only `user` messages were standby notices
  (`notice.outcome === 'waiting'`) does not arm a `done` push: at least one such notice and no other message.
  `noResultTurn` (`server/src/notify/policy.ts`) holds the rule, and `doneOrSilence` asks it after the background work
  condition. Any other `user` message brings back the ordinary `done`: a human prompt (from Rarog or the terminal), a
  notice with another result, a subagent message, a scheduled wake. A turn without any input gives `done` too: its
  cause is unknown, so there are no grounds for silence.
- **Turn after an artifact notification alone.** Deleting an artifact on claude.ai ends its watch in every session that
  published or read it. The CLI injects an `artifact-watch-lifecycle` notification (notice `artifact-watch`,
  `artifacts.md`), and the model answers on its own ("nothing to do"), even in a session that finished long ago. A
  turn whose only `user` messages were such notices (also with standby notices) and in which the main agent called no
  tool is a turn without a result; one with a tool call after the notification gives `done`. For a standby alone,
  tools change nothing.
- **Turn after a context compaction alone.** The CLI compacts an idle conversation before the prompt cache expires
  (setting `"idleCompaction"`). The pane works for under a minute, and the main file gets a compaction boundary
  (`type: "system"`, `subtype: "compact_boundary"`, `compactMetadata.trigger: "auto"`, as for an automatic compaction
  during work), the compact summary (a `user` entry with `isCompactSummary: true`, not a message), attachments and an
  informational `system` line, with no assistant entry (measured on CLI 2.1.325). The follower reports a boundary of
  the main thread (`isMainCompactBoundary` in `server/src/herdr/jsonl-usage.ts`; a subagent boundary does not count)
  with a `turn-input` event of kind `compaction`, which the manager counts apart from other input. A turn whose only
  input was compaction boundaries (also with standby notices) and in which the main agent called no tool is a turn
  without a result, with the same late tool call path as an artifact notification. A manual `/compact` brings its
  prompt, and a compaction during work sits in a turn with its own cause, so both give `done`. Rarog does not read
  the sentence of the informational line. A boundary that reaches the manager only after the turn end leaves that
  turn with an empty tally, so it gives an ordinary `done`.
- **Owed `done`.** A `done` held back by background work would never go out when the first quiet moment comes after a
  turn without a result. So the push scheduler (`server/src/notify/index.ts`, map `#owed`) remembers per session, in
  process memory, that a result is owed, with its banner content (project, label, result sentence, `termId`). The flag:
  - **is set** by every ordinary turn end (`leavesResult` in `policy.ts`): a `done` class event that is neither a turn
    without a result nor the first `idle` after herdr comes back, also when `done` arms at once, because an armed
    banner can vanish without a send. Esc pressed in the terminal comes from herdr like a turn end and sets the flag;
  - **is cleared** by a sent `done`; the session opened in Rarog or its result picked up by the voice agent
    (`POST /api/sessions/:id/seen`, an open transcript at the check); the result seen on the Mac
    (`NoteInput.resultSeen`); a person watching Rarog while the session is quiet (judged on a fresh task list); an
    interrupt from Rarog (`interrupt-requested`, also in `waiting-input`); a new conversation in the pane (`forget`
    at `init` with another `engineSessionId`, which also takes down an armed banner); the session disappearing;
  - **is not cleared** by background work at the check (`doneStaysOwed` in `policy.ts`), a subagent in standby with a
    live own command, the start of a turn that took down an armed banner, or a look into Rarog while the background
    works: the quiet moment is still ahead.

  With the flag set, a turn without a result and with nothing working takes the ordinary `done` path (15 s window,
  presence, check before send).
- **Owed `done` waits for a subagent with its own command.** A turn without a result does not release an owed `done`
  while the list holds a subagent in standby with a non-empty `ownTasks` (`waitingOnOwnCommand` in `work.ts`). The
  check runs at the turn end (`NoteInput.waitingOnOwnCommand`) and before send, because a command reaches `ownTasks`
  only after a read of the subagent file (`sessionLook` sees the agent, `stillHolds` silences, `doneStaysOwed` keeps
  the flag). The case: a stage report starts the next stage's subagent, the subagent stops at its own command (review,
  final tests), its standby wakes the main agent, which writes "the stage is still running"; without the rule this turn
  would release the `done` mid-stage. `server/test/notify-incydent-gotowe-po-postoju.test.ts` replays a whole real
  session through the reducer, the subagent file reader, `merge.ts` and the real scheduler: one `done` after the last
  turn with the rule, four without it. The rule does not touch the Live Activity, the row tone or the app.
- **Owed `done` on background quiet without a turn.** The list changes without a session state transition (an own
  command ends and the agent goes dormant; a background task ends). At every `background-tasks` event the manager asks
  `holdsOwedDone` (`work.ts`) about the list before and after the swap, and on a drop from "holds" to "does not hold"
  calls `NotifierLike.quiet`. `Notifier.quiet` arms `done` from the remembered content when the flag is set, nothing
  else is armed, and the session is in `waiting-input` or `done`; window, check and send conditions are those of a turn
  without a result, and a turn start within the window takes the arming down. An own command end removes the command
  from `ownTasks` at once, while the wake shows only after the next file read (up to 5 s), so quiet may arm a `done`
  that the check after 15 s cancels, keeping the flag.
- **The received result stays received.** The turn start resets the `seen` marker, but when the previous result was
  received (`seen === true` before the reset; a result marked unread by hand is not), the end of a turn without a
  result puts it back: `seen` and `seenByHuman` return to `true` (with `seenBy` when the voice agent received that
  result), the durable marker moves to the current state
  number, and the session frame carries the receipt, so the row, the list rank and the Live Activity do not show a new
  result. A herdr `done` after the turn end keeps the receipt; Rarog does not call `agent.focus`, so the badge stays
  in herdr on the Mac. A late tool call that makes an artifact turn an ordinary one takes the receipt back and leaves
  an "unread" entry in the durable store at the current state number; a real receipt in between (opening the session,
  "Show in herdr", `done → idle` from herdr) ends the carried one, so the late call leaves it alone. When the previous
  result was not received, the row stays unread, because that result still waits. `carrySeenAcrossTurn`,
  `dropCarriedSeen` and `noteHumanReceipt` in `server/src/sessions/seen-marks.ts` hold the rule, with
  `Session.seenCarry`.
- **What the rule leaves alone.** The `blocking` and `failure` classes (a dialog and an error go out as always) and an
  incomplete tally: the row after such a turn behaves as after any turn.
- **Tally.** The manager (`server/src/sessions/manager.ts`) keeps a tally per session, `Session.turnInput`, from turn
  end to turn end: standby notices, artifact watch end notices, compaction boundaries, everything else
  (`#noteTurnInput`, `tallyTurnInput`; `notice.ts` gives the kind from the `CLI_SHAPES` registry) and the main agent's
  tool calls (`#noteToolCalls`, every `tool_use` entry of
  the main file). History does not count, and tool calls alone do not fill an empty tally. The manager passes the tally
  at every event (`NoteInput.turnInput`), and `policy.ts` decides. A `user` message enters the tally three ways: a
  prompt sent from Rarog (counted at send and again when it appears in the file, because a prompt sent during a turn
  may run only in the next one), a message from the file (a terminal prompt, a harness notice, or a human prompt
  absorbed into a running turn, which `queued-prompt.ts` makes into the same message), and input that is not in the
  transcript (below).
- **Late tool call.** The follower delivers a call entry 0.1 s after it is written, up to 2 s after a lost file system
  event, while herdr reports the turn end independently. A call that arrives before any input of the next turn belongs
  to the turn that ended. When that turn was silent as a turn after an artifact notification or a compaction alone
  (no tool call), the session is outside a turn and at most 10 s passed (`LATE_TOOL_CALL_MS`), the manager hands that
  turn end to the scheduler again, with a tool (`Session.quietTurnEnd`).
- **Incomplete tally.** Silence needs proof that the manager saw everything that caused the turn; without it the
  scheduler gets no tally and gives an ordinary `done`. The tally is incomplete:
  - after the driver attaches (Rarog restart, new pane, herdr return) and after every history batch, because the
    prompt of a running turn sits in the history. A card that comes up has not yet had a turn of its own, so its
    first turn exit neither closes the tally nor gives `done` (`Session.awaitingFirstTurn`). The cases: the first
    `idle` of a pane found in state `unknown` or of a session from Rarog before it is ready, the same after the
    `driver-init` event (the driver read the file history and moved the card to `running`), and the zero turn, the
    start-up turn of a session that got no prompt (a new empty session, a resume, a session restart);
  - after a loss of file continuity (`/clear`, `/resume`, a truncation, an append skip), which the follower reports
    with a `turn-input` event with `lost: true` before what it reads afterwards;
  - after a turn end with an empty tally: every turn has input, so the manager missed it (`nextTurnInput`).
- **Input that is not in the transcript.** A subagent message (a report or a message during work) sits in the main
  file as a `user` entry with `isMeta: true` and `origin.kind: "peer"`, which Rarog does not show. The follower reports
  such an entry with a contentless `turn-input` event, which the manager counts as other input (the follower sends the
  same event when it drops a Rarog prompt's echo). `isHiddenTurnInput` (`server/src/transcript-import.ts`) takes a live
  `user` entry outside a subagent, with `isMeta: true`, that has `origin.kind` or `turnOrigin`; the rule checks
  presence, not values. Measured on CLI 2.1.273–2.1.296: subagent messages (`origin.kind: "peer"`, from CLI 2.1.277
  also `turnOrigin: "peer"`), scheduled wakes (`turnOrigin: "scheduled"`), system messages between sessions
  (`turnOrigin: "system"`) and a resume after a usage limit reset (`origin.kind: "auto-continuation"`) carry these
  fields; other meta entries (a photo companion, skill content, local command notes) carry neither.
- **Turn boundary.** A turn end is the session leaving the turn states (`running`, a pending decision) for any other
  state (`inTurn`, `#applyTransition` in the manager); for a herdr session it is `agent-state: idle` from the
  supervisor (`agent-idle`). An interrupt, an error, a limit and a driver exit also end a turn. The tally runs from turn
  end to turn end because a standby notice comes from the file at once, while `working` from herdr comes only after
  the 1.5 s grace (`HERDR_WORKING_GRACE_MS`), and their order is not guaranteed.
- **A turn the manager did not see.** A turn after a standby notification takes about 2 s. When `working` does not hold
  for 1.5 s, the supervisor does not apply it, and without a turn end there is no push. The tally then covers
  everything until the next turn end the manager sees.
- **Input absorbed into a running turn.** Input that arrives during a turn sits in the file as an `attachment` of type
  `queued_command`, without a `user` entry. The tally counts a human prompt from it, not notifications and subagent
  messages. For a standby this is intended, because the absorbing turn had its own cause; in the measured session files
  no standby-only turn absorbed other input.
- **Trace in `server.log`.** The quiet lines name the reason. At the turn end:
  `push: quiet for <project> (done, turn after a subagent standby alone)`,
  `(done, turn after an artifact task notification alone)`,
  `(done, turn after an artifact task notification and a subagent standby alone)` and
  `(done, turn after a context compaction alone)` (the causes of a mixed turn joined with "and"); an owed `done` that
  waits for a subagent with its own command adds `, owed waits: the subagent waits for its own command`. At the check
  before send: `push: quiet for <project> (done, state=<state>, working in the background: N)` or
  `(done, state=<state>, owed waits: the subagent waits for its own command)`. An owed `done` arms with
  `push: armed done for <project> (check in 15 s, owed after a turn with a subagent standby alone)` (or `with an
  artifact task notification alone`, `with a context compaction alone`, or with the causes joined) or `(…, owed after
  the background went quiet)`. Quiet in the background that clears the owed flag without a banner logs
  `(done, owed after the background went quiet, you are watching Rarog)` or `(…, result seen)`. A late tool call logs
  `push: <project> — tool call arrived after the turn end that followed an artifact task notification or a context
  compaction; turn end handed to the scheduler again`.

## Module map

Each file's header describes it; this list says where to look. The directory `server/src/herdr/background/`:

- `server/src/herdr/background/index.ts`: the module map and public API of the directory.
- `server/src/herdr/background/cli-shapes.ts`: the `CLI_SHAPES` registry ("CLI shapes").
- `server/src/herdr/background/notification.ts`: the only notification text parser; standby note and fingerprint.
- `server/src/herdr/background/reducer.ts`: the pure state machine from entries to open tasks.
- `server/src/herdr/background/notice.ts`: notification to transcript notice.
- `server/src/herdr/background/artifacts.ts`: the session's artifact list (`artifacts.md`), here because its
  notification shares the carrier and the registry.
- `server/src/herdr/background/pull-requests.ts`: the session's PR list (`pull-requests.md`), next to the artifact
  list because it reads the same conversation files and travels the same way to the app.
- `server/src/herdr/background/scheduled-tasks.ts`: the session's scheduled tasks (crons) from the main conversation
  file, and the prefilter for its raw lines; here because the registry holds its CLI words.
- `server/src/herdr/background/pull-request-files.ts`: the reader of all conversation files for the PR list.
- `server/src/herdr/background/scheduled-task-file.ts`: the reader of the main conversation file for the scheduled
  tasks (`scheduled-tasks.md`).
- `server/src/herdr/background/incremental-read.ts`: one incremental read of one conversation file (offset, chunks,
  byte budget, restart on truncation or another inode, read errors reported), used by `pull-request-files.ts` and
  `scheduled-task-file.ts`.
- `server/src/herdr/background/queued-prompt.ts`: a human prompt absorbed into a running turn (same queue attachment).
- `server/src/herdr/background/ids.ts`: identifier shape guards.
- `server/src/herdr/background/satellite.ts`: the session directory address and relocation.
- `server/src/herdr/background/workflow-run.ts`: the workflow run layout reader.
- `server/src/herdr/background/agent-file.ts`: the subagent transcript file reader.
- `server/src/herdr/background/main-scan.ts`: the full scan of the main file before the tail window.
- `server/src/herdr/background/jsonl-lines.ts`: byte chunks to complete lines, for `agent-file.ts`, `main-scan.ts`
  and `incremental-read.ts`.
- `server/src/herdr/background/merge.ts`: the follower list merged with layouts and subagent file facts; read timer.
- `server/src/herdr/background/work.ts`: the work rules and the only definitions of a subagent in standby and of a
  monitor as a watcher.

The directory does not import the driver facade, the manager or the supervisor (`server/src/drivers/herdr-driver.ts`,
`server/src/sessions/manager.ts`, `server/src/herdr/supervisor.ts`); they call it. Only `satellite.ts`,
`workflow-run.ts`, `agent-file.ts`, `main-scan.ts`, `pull-request-files.ts`, `scheduled-task-file.ts` and
`incremental-read.ts` read the disk.
`cli-shapes.ts`, `ids.ts`, `jsonl-lines.ts`, `notification.ts`, `reducer.ts`, `notice.ts`, `artifacts.ts`,
`pull-requests.ts`, `scheduled-tasks.ts` and `work.ts` have no I/O and no clock, and a purity guard keeps them from
importing `node:*` or disk modules. `merge.ts` runs the read timer with state, readers and clock from the driver facade.

Callers outside the directory: `server/src/herdr/jsonl-follow.ts` (owns the main file reducer, emits `tasks`, orders the
full scan with `#primeTasks`, gives the reducer its monitor clock, reports `turn-input`),
`server/src/drivers/herdr-driver.ts` (the pane's task state and readers, `background-tasks`),
`server/src/cli-version.ts` (the CLI process registry), `server/src/herdr/session-pulse.ts` (the turn pulse),
`server/src/sessions/manager.ts` (the turn tally), `server/src/sessions/conversation-lists.ts` (stores the list),
`server/src/notify/index.ts` and `server/src/notify/policy.ts` (the push scheduler and its silence rules),
`server/src/notify/live-activity-state.ts`, `server/src/transcript-import.ts` (`origin` gate, `isHiddenTurnInput`),
`server/src/demo/scenarios.ts` and `server/src/demo/seeds.ts` (demo data; `seeds.ts` is the only file allowed to hold
CLI notification literals) and `shared/src/protocol.ts` (the contract).

App: `RarogContract` (`SessionSummary.swift`, `Transcript.swift` with `NoticeOutcome`); `RarogCore`
(`BackgroundTaskRules.swift`, `Selectors.swift`, `Selectors+LiveActivity.swift`, `Reducer+List.swift`,
`SnapshotCacheFile.swift`); `RarogUI/Model/` (`SessionRowModel.swift`, `SessionPillsModel.swift`,
`HeaderStatusModel.swift`, `ActivityText.swift`, `WorkflowRunModel.swift`, `CommandTools.swift`,
`InspectorSections.swift` with `FinishedTasks`); `RarogUI/Views/` (`Header/BackgroundTasksSection.swift`,
`Header/BackgroundTasksPanel.swift`, `Header/SessionPills.swift`, `Inspector/InspectorPanel.swift`,
`List/SessionRow.swift`); copy in `RarogUI/Copy/UICopy+Activity.swift`, `UICopy+Header.swift` and
`UICopy+Transcript.swift`.

Server tests in `server/test/`: `herdr-jsonl-tasks.test.ts` (reducer, process restart rule, the `resume-cli` replay),
`herdr-jsonl-tasks-incydent.test.ts` (a line-by-line replay of a session with standbys), `herdr-jsonl-follow.test.ts`,
`herdr-tasks-integracja.test.ts` (driver swap), `herdr-main-scan.test.ts`, `cli-version.test.ts`,
`cli-registry.test.ts`, `herdr-workflow-run.test.ts`, `herdr-agent-file.test.ts`, `herdr-driver.test.ts`,
`herdr-phase-progress.test.ts`, `harness-notices.test.ts`, `notify-live-activity.test.ts`,
`herdr-background-work.test.ts`, `notify-policy.test.ts`, `notify-harmonogram.test.ts`, `manager-herdr.test.ts`,
`session-restart.test.ts`, `transcript-import.test.ts`, `notify-incydent-gotowe-po-postoju.test.ts`,
`apns-fixtures-producenci.test.ts`, `scheduled-tasks.test.ts`, `herdr-background-boundary.test.ts` and
`herdr-background-fixtures.test.ts`.

## CLI shapes

Everything above depends on how Claude Code writes its entries. Every literal by which Rarog recognizes a background
task or its notification lives in the `CLI_SHAPES` registry (`server/src/herdr/background/cli-shapes.ts`), and the
directory's modules take the values from it, so the registry is code, not description. Dialog detection keeps its
measured screen shapes the same way (`SCREEN_SIGNATURES` in `server/src/herdr/dialogs/screen/signatures.ts`).

- **A registry entry** is one measured shape: a description (`what`), literals under the names the code uses
  (`literals`) and the CLI version (`cli`). `UNKNOWN` means nobody measured the version. Seventeen entries carry
  a version. From the live measurement on CLI 2.1.296 ("After a Claude Code update"): `notification`,
  `notificationOrigin`, `summaryExitCode`, `toolResult`, `agentResume` and `agentNote` (its `relayed` literal
  measured by hand). Measured by hand on session files: `queuedPrompt` and `monitorTool` (CLI
  2.1.296), `foregroundEnd` (CLI 2.1.309), `monitorStart` and `taskStop` (CLI 2.1.319),
  `subagentStopHook` and `requestBlob` (CLI 2.1.330); `skillFork` carries CLI 2.1.258. From the store measurement on CLI
  2.1.301: `artifactPublish` and `artifactWatch` (`artifacts.md`). From hand excerpts of a live measurement on CLI
  2.1.329: `scheduledTasks` (fixtures in `server/test/fixtures/herdr/scheduled/measured/`). An entry whose every
  literal appears in a measured fixture must carry the current fixtures' CLI version
  (`server/test/herdr-background-fixtures.test.ts`).
- **Entry families:** notification text (`notification`, `terminalStatuses`, `unknownFate`, `summaryKinds`,
  `summaryExitCode`, `agentNote`), notification carriers (`notificationCarriers`, `notificationOrigin`), a human prompt
  in the same queue attachment (`queuedPrompt`), tool results (`toolResult`, `taskStart`, `agentResume`,
  `foregroundEnd`, `taskDescription`, `taskWho`, `workflowRun`, `monitorStart`, `taskStop`, `taskOutput`), tool
  calls (`taskTools`,
  `monitorTool`, `skillFork`), subagent file entries (`subagentStopHook`, `requestBlob`), session artifacts
  (`artifactPublish`, `artifactWatch`) and the session's scheduled tasks (`scheduledTasks`).
- **Standby rests on two phrases, not on sentences.** `agentNote` holds the standby phrase ("background work of its own
  still running") and the end phrase ("no live background children"); the rest of the note may change wording without
  harm. The notification has no structural field for it.
- **What follows the note.** The agent result (`<result>`) or the end of the notification; for an agent that read
  artifact content, first the tag `<artifact-content-authored-by-others/>` with a warning line (`agentNote.relayed`;
  measured by hand on a live session file, CLI 2.1.296). Without this layout the parser would take the note for
  unknown and count the notification as an end.
- **Monitor.** `monitorTool.timeout` is the call field `timeout_ms` (measured by hand: call
  `{description, timeout_ms, command}`). Only the subagent file reader uses it, for the deadline in "Dormant". The
  task list reads the result (`monitorStart`: `{taskId, timeoutMs, persistent}` on CLI 2.1.319, "Monitor start").
  `TaskStop` of a monitor has the same result as for a command (`{command, message, task_id, task_type}`, `task_type`
  `local_bash`), and no notification follows it.
- **Words in the registry, grammar in the modules.** `notification.ts` knows that the tag has a closing, that the exit
  code follows `exit code`, that an agent summary starts with `Agent` as a whole word and where the note sits;
  `notice.ts` that the kind starts the summary as a whole word; `reducer.ts` which result field means a start and which
  a resume.
- **Guard** (`server/test/herdr-background-boundary.test.ts`): a registry literal appears in `server/src/**` code only
  in `cli-shapes.ts` (comments are free). Field names are searched as quoted strings, texts literally. Two exceptions,
  on closed lists in the test: literals marked `common` (common words such as `status`, `message`, `Bash`) and
  `server/src/demo/seeds.ts`, which assembles sample notifications as demo data.
- **Outside the registry, on purpose:** the general transcript entry format (`type`, `message.content`, `tool_use` and
  `tool_result` blocks, `isSidechain`), the quotes around the task name, the identifier shape (`ids.ts`) and the
  workflow run files (journal, script, harness frame; `workflow-run.ts`, next to their measurements).

## After a Claude Code update

The live measurement checks whether the installed CLI produces entries in the shapes the `CLI_SHAPES` registry
assumes. Its output is the fixtures in `server/test/fixtures/herdr/tasks/measured/` ("Measurement fixtures"), and their
`git diff` shows a shape change. The measurement is manual (live herdr, a paid model); `pnpm run check` does not run it.

Each scenario runs in a fresh `claude` session with a random id, in its own herdr tab that the measurement closes at the
end, also after an error. The session runs without `--dangerously-skip-permissions` (the only added permission rule is
`Bash(sleep:*)`), and the measurement sends no signal to any process. Its only keys are `esc` and, in the `resume-cli`
scenario, the digit `1`, which picks "Exit and stop tasks" in the exit dialog "Background work is running" only when
exactly that dialog is on screen and its list "The following will stop when you exit:" names only the run's own
`sleep` command; any other screen gets `esc`, and the scenario ends unmeasured. "Move to background and exit" is never
picked. A digit picks by label and, in this dialog, confirms at once (measured on CLI 2.1.296). A fixture comes only
out of a final anonymizer pass (`scripts/anonymize-fixture.ts`); without the private literals file (`publishing.md`)
no fixture is written.

Scenarios, each in a fresh session:

- **`postoj`**: a subagent starts its own background command and ends its turn; when the command ends, the CLI wakes
  the subagent, and it finishes for real. It gives both `<note>` variants and a notification about the subagent's
  command.
- **`wznowienie`**: a subagent finishes, the main agent sends it a `SendMessage`, and it finishes a second time.
- **`taskoutput-w-postoju`**: the main agent is asked to call `TaskOutput` on a subagent in standby. CLI 2.1.296 has no
  such tool (`ToolSearch` with `select:TaskOutput` returns empty `matches`); the marker `narzedzieTaskOutput` in the
  fixture says whether the tool exists, and with the tool the scenario records two results.
- **`resume-cli`**: `/exit` with a subagent in standby, "Exit and stop tasks", the end of the CLI process,
  `claude --resume <session>` in the same pane and a short prompt. The fixture markers `koniec-procesu-cli` and
  `claude-resume` separate what the CLI appended while ending the process from what it appended after the resume. The
  last line of the main file holds the observations: `koniecProcesuCli` (`exit-and-stop-tasks`, or `exit` without the
  dialog) and whether the subagent's `sleep` process lives before the exit, 2 s after it and after the resume.

How to read the result:

- `git diff server/test/fixtures/herdr/tasks/measured/` is clean: the shapes did not change.
- `<scenario>.jsonl` has changed content: fix the `CLI_SHAPES` entry the change concerns, with its version,
  and the literal rule in `server/test/herdr-background-fixtures.test.ts`.
- The `<note>` in `postoj.jsonl` or `wznowienie.jsonl` changed: fix the `agentNote` phrases. Until then a running
  server treats a standby as an end and logs `background tasks: unknown note in an agent task notification`.
- New names `<scenario>-<version>.jsonl` with unchanged content: only the CLI version number changed.
- An unmeasured scenario writes no fixture; repeat the measurement.

### Measurement fixtures

Only the measurement writes `server/test/fixtures/herdr/tasks/measured/`. Each scenario has two files:
`<scenario>-<CLI version>.jsonl` (the version archive) and `<scenario>.jsonl` (the `git diff` reference, a copy of the
first). The extraction does not use the `CLI_SHAPES` registry on purpose: a measurement that recognized entries by the
registry's words would miss exactly the CLI change it should show.

- **What stays:** calls of task tools (`Agent`, `Bash` with `run_in_background`, `SendMessage`, `TaskOutput`,
  `TaskStop` and related ones) with selected input fields, their results (selected `toolUseResult` fields and
  `_klucze`, the names of all result fields), the full text of notifications from every carrier, and the main agent's
  turn end entries (`system` with `subtype: turn_duration`). A placeholder stands for prompts and model answers. A
  notification stays only from the entry the CLI inserted it into (`origin.kind: task-notification`, or a text that is
  exactly one notification), not from a quote in a prompt. Of a tool result's text only the recognized CLI sentence
  stays (for example "Resuming agent …").
- **Underscore keys** come from the measurement: `_plik` (`glowny` or `subagent:<id>`), `_klucze`, `_pomiar` (a marker
  or an observation). The rest are CLI fields in their original nesting.
- **Normalization:** identifiers get sequence numbers, a notification's `<result>` gets a neutral text with the
  notification number (the same in copies), the numbers in `<usage>` become zeros, paths become `/Users/u/projekt`.
  Times are consecutive seconds in event order, shared by both files; `remove` and `dequeue` get the previous main
  file line's time plus milliseconds, because `remove` races the wake entry in the subagent file. Two independent runs
  of each scenario on CLI 2.1.296 gave identical files.

What the fixtures show on CLI 2.1.296:

- `Agent` has no `run_in_background` parameter; every subagent starts in the background (`isAsync: true`,
  `status: async_launched`).
- `turn_duration` carries `pendingBackgroundAgentCount` when a subagent works at the turn end; after a turn caused by
  a standby notification the field is absent.
- An agent notification carries `<tool-use-id>` after the start and after `SendMessage` (the id of that call), not
  after a wake by its own task.
- The end notification of a subagent's own command stands in the main file as `enqueue` and `remove` with
  `reason: delivered_to_agent`, and in the subagent file as a `user` entry with `origin.kind: task-notification`.
- A resume stands in the subagent file as a `user` entry with `origin.kind: coordinator`, before the `SendMessage`
  result in the main file.
- The last line of a turn (`assistant` with text) has `stop_reason` `end_turn` or `null`; it cannot serve as proof.
- The exit dialog with a subagent in standby lists only its command (`shell · sleep 307`), not the subagent.
- Exit with "Exit and stop tasks": the main file gains one `enqueue` entry with a notification about the subagent's
  COMMAND (`<status>killed</status>`, summary `Background command "…" was stopped`, `<tool-use-id>` of its `Bash`
  call), which nothing consumes, also after the resume. Neither file gets anything about the subagent, and the `sleep`
  process is dead after the exit.
- After `claude --resume` the main file grows on with nothing about the subagent or its command, and with no orphan
  notification. The turn after the resume has no `pendingBackgroundAgentCount`, and the `sleep` process stays dead.

## Diagnostics

- **A subagent left the Background section, but the CLI shows it.** Check for dormancy ("Dormant"): the agent stood in
  standby, `subagents/agent-<id>.jsonl` has no entry newer than the standby notification, all its commands
  (`backgroundTaskId`) have an end notification, and its monitor deadline (the `Monitor` call time plus `timeout_ms`)
  passed. It returns when its file grows.
- **A task does not show.** Find its start: `grep -n '<task id>' <uuid>.jsonl`. No `user` entry whose `toolUseResult`
  carries the id means a subagent started it (see `<uuid>/subagents/agent-<id>.jsonl`; the command then stands under
  its agent in `ownTasks`). A start in the file without a listed task: look in `server.log` for `skipped … B` and
  `… background tasks before the tail window are not visible …`.
- **A subagent's command does not show.** The agent must be listed; the command start must be newer than the main
  file's `since`; an agent shows at most 20 commands; `RAROG_AGENT_FILES` must be on. A monitor and a nested subagent
  never show under an agent.
- **A subagent's command hangs although it ended.** None of the three end sources arrived: a notification in the main
  file's queue (`grep '<command id>' <uuid>.jsonl`), one in the subagent file, or a `TaskStop` result.
- **A task disappeared too early.** Look for a notification with that `<task-id>` and a final status; a subagent
  disappears only after one without the standby note. Gone at a standby: look in `server.log` for
  `background tasks: unknown note in an agent task notification`.
- **A subagent shows waiting but works in the CLI.** Check that `<uuid>/subagents/agent-<id>.jsonl` has an entry with a
  `timestamp` newer than `waitingSince`, that the pane is in scope, that `RAROG_AGENT_FILES=0` is not set, and that a
  tick (5 s) passed.
- **A subagent shows waiting or working although the CLI restarted.** The restart rule got no start time. Check that
  `~/.claude/sessions/` has exactly one live process file with this `sessionId` and a numeric `startedAt`, that
  `RAROG_CLI_WAITING` is not `0`, and that the agent's last start, resume or standby is older than `startedAt`.
- **A subagent disappeared after a CLI restart, while it worked.** Expected; it returns when the main agent resumes it.
  One that returned without a description or timer is a minimal entry: the reducer did not read its start.
- **After a Rarog restart a task from many hours ago returned.** Expected when the file has no end for it (gap "A task
  without proof of its end returns after every attach").
- **A `done` push came while a subagent is listed.** Expected when the subagent waits. When it worked, check whether
  the list at the turn end still had its `waitingSince`: a wake shows up to 5 s late ("Wake").
- **No `done` push although the turn ended.** Look in `server.log` for a `push: quiet for <project> (…)` line, whose
  reason says why ("Standby-only turn: no `done` push"); `working in the background: N` usually means a subagent woke
  within the 15 s. Without a `push: armed done` line the push never armed, and background work at the turn end is the
  only reason without its own line. The other reasons log `(done, you are watching Rarog)`, `(done, a banner about
  this matter already went out)`, `(done, herdr restore)`, `(done, session start)`, `(done, turn after a subagent
  standby alone)` and `(done, turn after an artifact task notification alone)`.
- **An artifact was deleted, an idle session turned blue, and no push came.** Expected: the watch end notification
  woke the agent, and a turn without tools gives no `done`. Mark as Read in the row menu clears the blue.
- **A `done` push came after a turn with a standby.** The turn held other input (a prompt, an end notice, a subagent
  message, a scheduled wake), the manager missed the previous turn end (shorter than the herdr grace), or the tally was
  incomplete. The log then has no standby-only turn line.
- **Restart refused because of a subagent that does nothing.** Expected: `RESTART_WAITING_AGENT_MESSAGE` means only
  waiting subagents are listed, and a restart would kill them with the commands they wait for.
- **A task hangs.** No notification, `TaskStop` or `TaskOutput` with its id. A command, workflow or monitor from a
  `backgroundTaskId` start stays after a killed CLI process until a new engine session; the next process start closes
  a subagent and a monitor. A monitor of the main agent stays past its deadline only when its result has
  `persistent: true`, or when the registry gives no process start.
- **The list went empty or changed all at once.** `/clear` or `/resume`, a file truncation (the system message
  `TRUNCATED_MESSAGE` in the transcript) or a skip (`skipped … B` in `server.log`).
- **No workflow layout.** The task has no `runId`, the session directory is missing, or the pane is out of scope. A run
  with a script from `scriptPath` has no entry in `workflows/scripts/`, so no phases.

## Known gaps

- **A subagent that will not come back can stay waiting.** Dormancy needs proof. The agent stays until the CLI process
  restarts when it called `Agent`, `Task` or `Workflow`, has an own command without proof of its end, or has a file
  not known to its last line (a skip, a truncation, over 256 MiB, a line over 8 MiB or an unreadable line, a file that
  ends on an attachment); every agent stays with `RAROG_AGENT_FILES=0`. An agent with a monitor leaves up to 31 minutes
  after its standby. Workaround: restart Claude Code in the terminal.
- **A dormant agent that waits for something Rarog does not see does not block restart.** The rule knows commands,
  monitors and `Agent`, `Task`, `Workflow` calls, not other own tasks such as a skill run in the background: such an
  agent goes dormant after a minute, and a restart from Rarog kills it without a refusal.
- **A wake shows up to 5 s late, and one shorter than the tick sometimes not at all.** An agent that moved and stood by
  again between two reads stays waiting with a newer `waitingSince` and cancels no armed `done`. A check before send
  that falls into the tick window sees a woken agent as waiting and can let a `done` through; an own command end opens
  the same window for an owed `done`.
- **After a turn without a result herdr shows `done` on the Mac.** Rarog puts back the receipt of the previous result,
  but does not focus the pane, so the herdr badge stays until someone opens the pane.
- **Only the transcript file knows the main agent's tools.** A turn after an artifact notification in which the agent
  used only a tool without a `tool_use` entry in the main file (a server-side API tool) is silent. A call entry that
  arrives more than 10 s after the turn end, or after the next turn started, leaves the turn silent too.
- **An owed `done` waits for a list change.** A list that holds a task without proof of its end (a command or workflow
  after a killed CLI process, a subagent in standby at a command without an end) holds the result until an ordinary
  turn or a CLI restart.
- **A report from subagent X while subagent Y waits at its own command gives `done`.** A subagent with its own command
  holds back an owed `done` only after a turn without a result, and X's report starts an ordinary turn. Holding every
  `done` for such a subagent would delay `done` pushes after prompts and reports by hours.
- **The owed flag does not survive a Rarog server restart.** It lives in process memory, and the first turn end of
  each session after a restart counts as ordinary (incomplete tally).
- **Turn input that misses the tally.** A standby notice that arrives after its turn ended leaves the turn with an
  empty tally, so that turn and the next give `done` (normally the notice is far ahead: 0.1 s against a turn of about
  2 s). Other input of a turn that arrives after its end leaves a standby-only turn silent. Input without
  `origin.kind` and `turnOrigin` (a scheduled wake in CLI versions before 2.1.277) counts as no `user` message, and so
  does a subagent report or a command end absorbed into a running turn. The `peer` entry shape has no measurement
  fixture: the extraction keeps only entries with a notification.
- **Skip, truncation and a file without a full scan.** After an append skip or a truncation of the main file, and in a
  file without a full scan (over 1 GiB before the window, a read error), the list starts from zero: a task started
  before the gap stays invisible until its end, a subagent returns as a minimal entry at its next standby or resume,
  and subagent commands started before the gap have unknown fate and do not show. In a file without a full scan, when
  the window starts between a notification's first copy and its repetition, the reducer takes the repetition for a
  new notification. A line over 8 MiB before the window is skipped, even if it carried a task.
- **A task without proof of its end returns after every attach.** The full scan reads the whole file, so such a task is
  listed after every Rarog restart until a new engine session: a command, workflow or monitor from a
  `backgroundTaskId` start after a killed CLI process. A subagent and a monitor of the main agent close by the process
  restart rule, provided the registry gives the next process start; a monitor with a deadline also closes once the
  deadline passes.
- **A command cut before its program has no short form.** The server sends 1000 characters (`TASK_COMMAND_MAX`,
  which `security-model.md` also sets as the limit of command text that leaves the Mac). When the program name stands
  further on, the row says only `command`.
- **Commands only.** A monitor, a nested subagent and a workflow run started by a subagent do not go into `ownTasks`,
  and Rarog reads no own tasks of nested or workflow agents.
- **Notification content.** Deduplication rests on the measurement that two different notifications never share
  content, so two identical notifications about two stops would lose the second. A task name with its own
  `</summary>`, a newline and `<result>` or `<note>` could not be told from the real layout; tags within one line of
  the name spoil nothing.
- **Registry coverage.** The workflow run file shapes are outside the registry (`workflow-run.ts`), and `agentId` is an
  unguarded registry literal, because the run journal carries the same word. The measurement scenarios call no
  workflow, monitor, background `Skill`, `TaskStop`, orphan, absorbed notification or human prompt (`queuedPrompt`),
  foreground subagent or skill fork (`foregroundEnd`); these literals have only test samples (the list with reasons is
  in `herdr-background-fixtures.test.ts`). The wording `Background Agent` has no sample.
- **A skill fork interrupted or failed in the foreground: shape unmeasured.** A result with `status: "forked"` without
  `background: true`, or without a `toolUseResult` object, opens nothing; a result with `agentId` and no `status` would
  open an entry that never gets an end notification.
- **Agent from before a CLI restart when the registry is silent.** Only the start of the NEXT process of the
  conversation, seen in the registry, triggers the rule ("CLI process restart: the agent does not survive it").
  Without it the agent stays listed until a new engine session: after `/exit` without a new CLI start, with two
  processes of one conversation, with an entry without `startedAt`, with `RAROG_CLI_WAITING=0`, and while any live CLI
  process has a registry file Rarog cannot read. The same while the pid of the conversation's previous process lives
  without a registry file; the system can reuse a dead CLI's pid, and Rarog cannot tell. The agent's command in
  `ownTasks` disappears first (the `killed` notification is an end without a start), so an agent without commands
  remains.
- **Process ends nobody measured.** Nobody knows whether the subagent and its commands live on after "Move to
  background and exit", or how the registry looks then; if a new process picks up the conversation, the restart rule
  closes a live agent until its next standby or resume. A process end without `/exit` (a killed process, a closed
  pane) is unmeasured too; the rule looks only at the next process start.
- **`TaskOutput`.** CLI 2.1.296 has no such tool; the reducer branch serves transcripts from CLI versions that have it.
- **Driver swap for the same conversation whose file cannot be read.** The list stays as before the swap until the new
  follower reads the file, so a task that ended meanwhile blocks restart and holds back the `done` push. Another
  conversation and a pane out of scope do not have this gap (the manager removes the list at the swap).
