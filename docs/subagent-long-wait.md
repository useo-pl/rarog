# Subagent waiting long on its own command

A subagent in standby has finished its turn while a background command it started itself still runs; it moves on when
that command ends (`background-tasks.md`, "Subagent: working, waiting, finished" and "Subagent's own commands"). When
the command never ends, the subagent waits for hours. A typical case is a wait loop such as
`until ! pgrep -f 'vitest run'; do sleep 30; done`: `pgrep -f` also matches the loop's own shell, so the loop never
exits. The server measures how long such a wait lasts and sends the stage with the task, in the `ownCommandWait` field.

## The `ownCommandWait` field

- **`BackgroundTask.ownCommandWait`** (`'short' | 'long' | 'stuck'`, `shared/src/protocol/background.ts`): `merge.ts`
  sets it exactly on a task of kind `agent` that has `waitingSince` and a non-empty `ownTasks`. A subagent in standby
  without a known own command (it waits on a nested subagent, a monitor or a command of unknown fate) has no field. The
  demo scenario `standby` builds its list without `merge.ts` and sets the field with `ownCommandWaitOf` itself.
- **Additive.** `PROTOCOL_VERSION` stays and a client that does not know the field ignores it. A client that knows it
  drops an unknown value with the degradation `backgroundTasks.ownCommandWait` (`shared/src/decode.ts`); `null` or a
  non-string rejects the frame.
- **The app** decodes it into `BackgroundTask.ownCommandWait` (`OwnCommandWait` in `RarogContract`); it has no
  thresholds and never derives the stage from `waitingSince` or `ownTasks`.
- **Golden frames** (reference SSE frames in `shared/fixtures/sse/`): the task `agent_9b2c` in
  `session-changed.max.json` and `sessions-snapshot.max.json` carries `short`;
  `session-changed.unknown-own-command-wait.json` drops an unknown value, and the `null` and numeric variants are
  rejected.

## Stage and clock

The age of a wait is the server clock (the Mac's) minus `waitingSince`:

| Age | `ownCommandWait` |
| --- | --- |
| under 30 min | `short` |
| 30 to 60 min | `long` |
| 60 min or more | `stuck` |

- **The clock starts at the standby**, not at the start of the command or of the agent. A command meant to run long (a
  dev server started before the standby) does not count, and every new standby starts a new wait from zero.
- **No proof, no escalation.** An unreadable `waitingSince`, or a clock behind it, gives `short`.
- **Every emission computes the stage.** `merge.ts` sets the field with the current clock and compares the list with
  the field in it, so a list whose files did not change goes out again on the first file read tick after a threshold
  (every 5 s, `TASKS_POLL_MS`). The tick runs while an open subagent is on the list, which a wait needs anyway.
- **One wait, one key.** `waitKey` names a wait by its agent and its `waitingSince`: the key stays the same while the
  stage grows and changes after a wake followed by a new standby.

## Situations

| Situation | `ownCommandWait` |
| --- | --- |
| subagent working, own command open | absent |
| standby, no known own command | absent |
| standby on an own command | stage by age |
| the command ends or the agent wakes | absent within 5 s |
| new standby on the same open command | `short`, age from zero |
| Rarog restart during the wait | stage by age after the attach scan |
| standby only on commands of unknown fate | absent (not in `ownTasks`) |
| `RAROG_AGENT_FILES=0` | absent (no `ownTasks`) |

After a Rarog restart the attach scan reads the main file from its first entry, so the subagent's open command keeps a
known fate and the stage comes back by age (`background-tasks.md`, "Attach: full scan of the main file" and "Subagent's
own commands"). The `done` push treats the subagent as any subagent in standby (`background-tasks.md`, "What counts as
work"), and so do the list order below `stuck` and the session row at `short`. The field has these consequences: the
`stalled` alarm ("The alarm cycle"), the session row from `long` on ("Session row"), the warning line and the pill's
mark from `long` on ("Background section and pill"), the `Check` button from `long` on ("Check") and, at `stuck`,
the Live Activity counters ("Live Activity").

## The `stalled` push

The push kind `stalled` says that a subagent of the session has waited over an hour on its own command. The server
sends it once per wait ("The alarm cycle").

- **Content** (`buildStalledContent` in `server/src/notify/content.ts`): the title `push.title.stalled` with the
  project ("⏰ Waiting over 1 h · atlas"); the body `push.detail.stalled` with the subagent's description, flattened
  and clipped before the sentence, so the body keeps its code. Without a description the body is the session label
  (`push.body.label`), and without a label `push.body.fallback.stalled`. The body never carries the command
  (`security-model.md`, "Push notifications").
- **Delivery headers.** Priority 10 and one hour in APNs (`TTL_SECONDS.stalled`): the wait still lasts, so a late
  alarm is still true. The collapse key is `stalledTopicFor(sessionId)`, a hash of the session id with its own
  prefix: the alarm never replaces a decision banner of the same session, and a decision banner never replaces the
  alarm. The `thread-id` is the session's hash as for every session banner, so the alarm sits in the session's group in
  the Notification Center, and a tap opens the session.
- **Old app.** An app that does not know the kind decodes it as no kind and keeps the session target: in the
  background the banner shows its title and body, and a tap opens the session; in the foreground there is no banner.
- **Golden frame:** `shared/fixtures/apns-v3/alert.stalled.v3.json`, produced by
  `server/test/apns-fixtures-producenci.test.ts`; in Swift `ApnsPushKind.stalled` (`ApnsFramesTests`).

## The alarm cycle

- **Edge.** On every task list swap of a session (`server/src/sessions/conversation-lists.ts`), `stuckWaits` in
  `work.ts` compares the previous list with the new one. A wait whose key was `short` or `long` and is now `stuck` is on
  the edge; `short` → `stuck` counts, because a sleeping Mac can skip `long`. A wait without a stage on the previous
  list is not: the first list after a Rarog restart, an agent before its file was read, the first lists after a driver
  swap (below). A session in `done` or `resumable` (a phantom agent) gives no edge; every other state does, `running`
  and the decision states included.
- **Delivery** (`server/src/notify/stalled-wait.ts`). The alarm goes straight through the APNs sink, next to the banner
  scheduler and never through it: a pending decision banner still goes out, a state change does not cancel the alarm,
  and the owed `done` is left alone (it still waits for the end of the wait, `background-tasks.md`, "Standby-only
  turn: no `done` push"). Several waits of one session on the edge in one swap give one push, which names the first.
- **No push, one log line** `push: quiet for <project> (stalled, …)`: the owner is watching Rarog, the session works in
  a temporary directory (a test session), the wait already had its alarm, or more than 1 h has passed since its first
  edge.
- **Tries.** After `failed` or `no-receiver` the next try goes 1 min, then 5 min, then every 15 min after the previous
  outcome, while the wait stays `stuck` and less than 1 h (`STALLED_WAIT_WINDOW_MS`, the push's lifetime in APNs) has
  passed since its first edge; then one line `push: stalled for <project> — not delivered within 1 h, no more tries`.
  Without a receiver the tries go at 0, 1, 6, 21, 36 and 51 min. Before a retry the owner's presence is checked again:
  the owner watching drops the retry.
- **Memory.** In the process, per session and wait key. A wait keeps its first edge and its outcome while its key is on
  the session's list in any stage, so a Mac clock set back (`stuck` → `long` → `stuck`) neither repeats the alarm nor
  renews its window. A wait that leaves `stuck` stops its tries; an outcome that comes back after that marks nothing.
  Removing the session, a new conversation in the pane (`/clear`, `/resume`) and a driver detach drop the session's
  memory and tries. A Rarog restart clears all of it, so a wait already `stuck` at the restart gets no alarm. At
  shutdown the alarm stops its timers before the APNs channel closes.
- **Driver swap.** The new driver starts with a fresh merge state (`TasksState` in `merge.ts`): its first emission
  after the attach scan carries the subagent with `waitingSince` but without `ownTasks`, because the subagent file is
  read only after that emission; the next emission, after the read, carries the stage again. Without a transcript file
  the first emission is empty. The manager keeps the previous list for the same conversation, so the swap goes from a
  list with the stage to one without it, and never makes an edge: no repeated alarm. The cost: a wait that crosses
  60 min between the last list of the old driver and the first read of the new one gets no alarm, and the detach drops
  tries still pending. The field still shows `stuck`.

## Session row

A session after a turn (`waiting-input`) with a wait at `stuck` waits for the owner: the row has the tone `.waiting`
and the word `stuck on a command`, and stands at the top of the list with the decisions. At `long` a received result
only warns: the row keeps its rank and word and gets the tone `.backgroundWaitLong`.

| Session | Word and tone | Rank, segment | Voice agent |
| --- | --- | --- | --- |
| `waiting-input`, `stuck` | stuck on a command, `.waiting` | 0, Needs You | `other` |
| `waiting-input`, received, `long` | idle, `.backgroundWaitLong` | as any standby | as any standby |
| `waiting-input`, unread, `long` | as any standby | as any standby | as any standby |
| `waiting-input`, `short` | as any standby | as any standby | as any standby |
| `starting` or `running`, `stuck` | as the turn, `.working` | 2, Working | `working` |
| decision or error, `stuck` | as the state | as the state | as the state |
| `done` or `resumable`, `stuck` | as any standby | as any standby | as any standby |

- **Over an unread result and other work.** `stuck` wins over an unread result (the row leaves Unread and its dot
  does not pulse) and over a live command or a working task next to the subagent. When the wait ends, the row is again
  what the state and the list say: an unread result returns to Unread.
- **List order.** Rank 0 holds in the order on screen too: a result read and held in place (`heldUnread`) moves up
  when its wait reaches `stuck`, because the threshold does not change `stateSince`.
- **Pills and filters read the tone.** The jump pill counts the row as waiting and Needs You holds it, both from the
  tone `.waiting`. The voice agent's list reads the same tone and gives `other`, as for an interrupted turn.
- **The warning tone at `long`.** `.backgroundWaitLong` takes the place of `.backgroundWait` (a received result with
  nothing else working in the background) when the strongest wait on the list is `long`: the waiting color with the
  mark `timer` (`StateGlyph`), opaque also on a sibling tab, and the reader's tone word "waiting a long time on a
  background task" (`UICopy.toneSpoken`, also after the status word of a tab, `UICopy.tabSpoken`, and of a session
  row, `SessionRowModel.spoken`). Everything else
  treats it as the plain wait: rank 3, no segment besides All, no jump pill, and the
  voice agent's `seen`. An unread result at `long` stays unread, and another working task gives the work tone. A
  project's tone puts it just before the plain wait, so a project that has both shows the warning.
- **Rule:** `BackgroundTaskRules.stuckWait`, the same rule as the Live Activity counter, asked by `statusTone`,
  `listRank` and `listOrderRank` (`Selectors.swift`) and by `RowStatus` (`SessionRowModel.swift`); the warning tone
  asks `BackgroundTaskRules.strongestOwnCommandWait` in `statusTone`.

## Background section and pill

From `long` on, the subagent's row in the Background section (the popover of the background pill and the inspector)
warns, and so does the pill, in every session state but a phantom agent's (`done`, `resumable`).

| Stage | Line in place of `waiting on its own task · 18m` | Pill | VoiceOver of the row |
| --- | --- | --- | --- |
| none, `short` | the state line itself | no mark | waiting on its own task for … |
| `long` | mark `timer`, `waiting 47m on: pgrep, sleep` | `timer` | waiting a long time on: … |
| `stuck` | mark `exclamationmark`, the same line | `exclamationmark` | stuck on: … |

- **The line.** The counter runs from the standby (`waitingSince`), like the row's own counter, so a command without
  `startedAt` changes nothing; without a valid standby time the line says `waiting on: pgrep, sleep`. The tools are
  the summaries of the own commands under the row (`CommandTools.summary`), each summary once, in list order; a
  command without text, or one the summary does not recognize, says `command`, never its text. After an hour
  `since 20:33` follows, quieter. The marks are the session row's marks of the same stage (`StateGlyph`), in the
  waiting colour, so `long` and `stuck` differ by shape; the text stays in the text colour. Without contact with the
  source the mark fades like the row's own mark. The row's hourglass takes the same waiting colour in place of its
  smoked green, and the own commands stay under the row.
- **VoiceOver.** The row says the warning in place of its state: `subagent <description>, waiting a long time on:
  pgrep, sleep, for 47 minutes, <type and model>`, at `stuck` `stuck on: pgrep, sleep, for 1 hour`.
- **The pill.** The background pill gets the mark of the strongest wait on the list after its dot, also during a turn.
  Its sentence says the stage per subagent: `subagent <description> has been waiting a long time on its own task`,
  at `stuck` `subagent <description> is stuck on a command`.
- **Code.** `BackgroundWaitWarning` (`RarogUI/Model/BackgroundWaitWarning.swift`) builds the line from the stage that
  `BackgroundTaskRules.ownCommandWait(of:in:)` gives; `BackgroundPanel.lines` sets it on the row
  (`BackgroundTaskRow.warning`) with the session state and the own command rows; `BackgroundBadge.warning` asks
  `BackgroundTaskRules.strongestOwnCommandWait`. The view is `Views/Header/BackgroundWaitWarningLine.swift`.
- **Demo.** The `create` action of the demo control takes `wait: 'long'` or `'stuck'` with the scenario `standby`: the
  subagent stands 47 or 75 min on `pgrep -f 'demo-build'` and `sleep 30`, after a read result, so the session row
  shows `.backgroundWaitLong` or `stuck on a command`. Without `wait` it stands 18 min (`short`).

## Check

From `long` on, a `Check` button stands under the subagent's row in the Background section (popover and inspector),
above its own commands. A tap sends the main agent one fixed message asking about the subagent's commands; nothing
goes out without a tap.

- **Where it stands.** Only where a typed prompt could go now (`AppState.sendBlock(for:)` gives nothing: a state that
  takes a message, herdr available and the session in contact with its source, not `stale`), on a fresh list and
  never for a phantom agent (`done`, `resumable`). A list from the cache, or a session restored from it before its
  first transcript (`sessionStale`), has no button: the cache has no command texts, and the send gate would hold the
  message anyway.
- **The message.** English, not translated, because a model reads it; one header line, one line per own command (at
  most 5, then `- … and N more`) and one instruction line (the first and the last line are wrapped here; in the
  message each is one line):

  ```text
  [Rarog check] Subagent "<description>" (<agent id>) has been in standby since <standby, ISO>,
    waiting on its own background command(s) for over <30|60> min:
  - task <own task id>: <tools> (started <start, ISO>)
  Check whether each command is still running and making progress. If one hangs, stop it, then collect the
    subagent's report and carry on. Do not start the subagent's work again if it already finished.
  ```

  Without a description the subagent is `Subagent <agent id>`; without a tools summary (`CommandTools.summary`) the
  line has no tools; without a start, no parenthesis. Times are the server's, in UTC, and the threshold comes from
  the stage, so the text does not depend on the phone's clock. The description and the ids go in on one line and
  capped, so they cannot add lines of their own; a quote or backslash in the description is escaped, so it cannot
  close the quotes around it, and an id keeps only ASCII letters, digits and `-`, `_`, `.`, `:`. The message never carries the command text: it lies in the outbox
  on the device's disk until its echo, and that disk never holds commands. It does not say how to stop a command.
- **Same power as a typed prompt.** The tap sends through the outbox like a typed message (`RarogStore.send`), with
  the same route, gates and Retry; during a turn it goes at once (`dialogs.md`, "Sending while a turn runs").
- **Once per wait.** The guard is in the store (`AppState.waitChecks`, by `waitKey`), so a closed popover and the
  inspector see the same answer. A tap reserves the wait before the outbox write, so a second tap during the write
  or the request sends nothing. While the message is in flight the button holds a spinner; a Not confirmed message or
  one refused with Retry keeps the label `Check`, and a tap sends that same entry again (the same `clientMessageId`).
  Once the server took the message, `Sent · 21:40` stands in place of the button until the wait ends; the time is the
  device's moment of the first acceptance, the 202 or the echo, whichever came first.
- **What frees the wait** (the next tap sends a new message): a final refusal or a Discard by hand, both before the
  acceptance; a take-back of the queue (`dialogs.md`, "Taking the queue back"), also after the 202, because the
  message went back to the prompt field and never reached the agent; a send that left no outbox entry; another server
  and Forget Server, which empty the guard together with the outbox (a logout keeps both). A new standby is a new key
  with its own button. The guard lives in memory only: after the app restarts, a tap sends a new message.

## Live Activity

A session after a turn (`waiting-input`) with a wait at `stuck` counts on the Live Activity as waiting: the subagent
will not come back by itself, so the session waits for the owner.

| Session | Counter |
| --- | --- |
| `waiting-input` with `stuck`, acknowledged or not | `waiting`, once |
| `waiting-input` with `short` or `long` | as any standby |
| decision (`waiting-permission`, `waiting-question`) with `stuck` | `waiting`, once |
| `starting` or `running` with `stuck` | `working` |
| `done` or `resumable` with `stuck` (phantom agent) | as any standby |

- **Once.** A stuck session is never `finished` and never `working`, also next to a live command or another working
  task in the background.
- **Not the tap target.** `top` stays the longest waiting session at a decision, otherwise the longest working one;
  the turn of a stuck session is over. In the app, the waiting number leads to the first stuck or deciding session in
  list order (`firstSession(.waiting)`).
- **Lifetime unchanged.** A stuck wait neither holds nor wakes the tile (`isBusy`): a command that never ends would
  hold it for the system's 8 h. With nothing else going on the tile ends after 30 min of silence, before the wait
  reaches 60 min, and the `stalled` push is the signal. While the tile lives, the move to `waiting` is a change of
  `waiting`, so the update goes at once with priority 10 (`server/src/notify/live-activity.ts`).
- **Rule:** `stuckWait(state, tasks)` in `work.ts`, asked by `aggregateState` in
  `server/src/notify/live-activity-state.ts`; in the app `BackgroundTaskRules.stuckWait`, asked by
  `LiveActivityInput.matches` in `Selectors+LiveActivity.swift` (the counters of `aggregate` come from `matches`).
- **Parity:** the golden frame `shared/fixtures/apns/live-activity.update.waiting-agent.json` holds two stuck sessions
  (one unacknowledged, one acknowledged next to a live command): `waiting: 2`, no `top`. The producer sets the stage
  with `ownCommandWaitOf`; `LiveActivityInputTests` builds the same state from the same sessions.

## Changing the rules

- **Rules.** `server/src/herdr/background/work.ts`: `ownCommandWaitOf` (the only reader of the clock), the thresholds
  `WAIT_LONG_MS` and `WAIT_STUCK_MS`, `waitKey`, the Live Activity counter `stuckWait` and the alarm edge
  `stuckWaits`. `merge.ts` only calls `ownCommandWaitOf`. The manager, `conversation-lists.ts`, `session-restart.ts`
  and `server/src/notify/` do not read the field: the guard `server/test/herdr-background-boundary.test.ts` fails on
  `ownCommandWait` there.
- **App rules.** `RarogCore/Sources/RarogCore/BackgroundTaskRules.swift`, the same names (`stuckWait`, `waitKey`)
  and two of its own: `ownCommandWait(of:in:)` (one task's stage, none for a phantom agent) and
  `strongestOwnCommandWait` (the session's strongest stage); no thresholds. `BackgroundTaskRulesGuardTests` fails on
  `ownCommandWait` and `ownTasks` in any other file of `RarogCore/Sources` and `RarogUI/Sources`, except a call of
  the rule and the lines on its closed exception list (drawing the own commands, stripping them before the disk).
- **Check.** The message in `RarogUI/Model/WaitCheckMessage.swift` (`WaitCheckMessage`, set on the row by
  `BackgroundPanel.lines` as `BackgroundTaskRow.check`; the button's model `WaitCheckButtonModel`), the view
  `Views/Header/WaitCheckButton.swift`; in `RarogCore` the guard `WaitCheck.swift`, the action `RarogStore.checkWait`
  (`RarogStore+WaitCheck.swift`), the reducer branches `Reducer+WaitCheck.swift` (it follows the outbox entry) and
  the answer `AppState.waitCheck(_:in:)` (`Selectors+WaitCheck.swift`). It adds no reader of `ownTasks` or
  `waitingSince`: the message takes them from the row models.
- **Alarm delivery.** `server/src/notify/stalled-wait.ts`: memory, tries (`STALLED_WAIT_RETRY_MS`), the window
  (`STALLED_WAIT_WINDOW_MS`), presence and test sessions. It gets the session facts (`title`, `label`, `termId`, test
  session) from `stalledWaitListener` in `server/src/bootstrap/push.ts`.
- **Tests.** The case table in `server/test/herdr-background-work.test.ts` (thresholds as effects at the boundary, the
  cases without a field, `waitKey`, the edge); `server/test/herdr-background-merge-wait.test.ts` (emission on the clock
  without a file change, and a replay of the fixture `server/test/fixtures/herdr/tasks/endless-wait-loop-2.1.332/`);
  `server/test/notify-stalled-wait.test.ts` (tries, memory, presence, cleanup);
  `server/test/conversation-lists.test.ts` (lists in a row → number of alarms, the first lists of a fresh attach);
  `server/test/manager-stalled-wait.test.ts` (the manager hands every list over and forgets a session that is gone);
  `server/test/live-activity-state.test.ts` (the Live Activity counters with a stuck wait), in the app
  `BackgroundTaskRulesTests`, `LiveActivityInputTests`, `SelectorTests` (the row's tone, rank and segments per
  session state), `ProjectsTests` (a project's tone with a long wait), `StateGlyphTests` and `PaletteContrastTests`
  (the warning tone's mark and contrast), `NavigationTests` (the tab's reader sentence), `ListMemoryTests` (a held
  row moves up), `SessionRowTests` (the word and the voice agent's state) and `BackgroundRowTests` (the warning line,
  its minutes and tools, and the pill; `BackgroundWaitWarningTests.swift`), `WaitCheckMessageTests` (the message
  text, which a model reads, so the tests hold it whole; no raw command; the button model) and `StoreWaitCheckTests`
  (one message per wait, Retry of the same entry, what frees the wait, the guard across the popover and the
  inspector and across a data space change, no button where a prompt could not go, no command in the outbox on
  disk); on the server
  `server/test/demo-control.test.ts` (the demo's stage equals `ownCommandWaitOf`).
- **Contract.** `shared/src/protocol/background.ts`, the reference client decoder `shared/src/decode.ts`, and in Swift
  `OwnCommandWait` (`WireEnums.swift`), `BackgroundTask` (`SessionSummary.swift`) and
  `DegradationKey.backgroundTasksOwnCommandWait`. The golden frames come from
  `server/test/sse-fixtures-producenci.test.ts`, which sets the stage with `ownCommandWaitOf`.
- **Alarm content and key.** `buildStalledContent`, `stalledTopicFor` and `TTL_SECONDS` in
  `server/src/notify/content.ts`, the sentences in `shared/src/sentences/push.ts`; tests in
  `server/test/notify-content.test.ts` and the golden frame above.
- **A new stage** is a new wire value next to the old ones, with its Swift case in the same commit; a published value
  keeps its meaning.
