# Claude Code session artifacts

An artifact is a claude.ai page that a Claude Code session published with the `Artifact` tool. This document covers
how Rarog builds a session's artifact list, when an artifact counts as deleted, and what the app shows.

**In short.** Rarog never asks claude.ai anything. It builds the list from the session's transcript file
(`<uuid>.jsonl`) out of two facts: the publish result (URL, title, time) and the task notification that ends the
artifact watch with the "artifact not found" variant (the artifact is deleted). The list belongs to the file: after
`/clear` it is empty, and after a Rarog restart it is rebuilt from the file, usually the whole file (exceptions:
"Lifecycle in the follower"). The server sends it in the session summary (`SessionSummary.artifacts`), and the app
draws an Artifacts section from it in the iPad inspector: a tap opens the page in the browser, and a deleted artifact
stays dimmed. A turn started by the task notification alone, in which the agent used no tool, gives no `done` push.
Code: `server/src/herdr/background/artifacts.ts`.

## Source

The pane's transcript follower (`server/src/herdr/jsonl-follow.ts`) reads the transcript file. On attach it takes the
tail of the file, the tail window (up to 500 messages or 8 MiB), and then reads appends live; it scans the older part
of the file once.

- **A publish** is the `Artifact` tool result: a `toolUseResult` object at the top level of a `user` entry, next to
  the `tool_result` block, like a background task start (`background-tasks.md`, "Sources").
- **A deletion** is a harness notice, an entry that Claude Code itself inserts into the conversation (`origin.kind:
  task-notification`, text `<task-notification>`), read by the parser of task notifications (`notification.ts`).
- Only the session's main file counts (a subagent entry, `isSidechain: true`, is dropped), only a Claude session
  (Codex has no follower, `herdr/types.ts`, `inScope: false`), and only a pane in a directory from
  `RAROG_HERDR_ROOTS`, the directories Rarog reads panes from (`security-model.md`, "herdr sessions", item 6).

## CLI shapes

The literals live in the `CLI_SHAPES` registry (`server/src/herdr/background/cli-shapes.ts`), shared by background
tasks and artifacts. The `artifactPublish` and `artifactWatch` entries carry CLI version 2.1.301: the newest version
in the transcript files the fixtures come from ("After a Claude Code update"). A shape seen only in files from an
older CLI version names that version below.

- **`artifactPublish`:** the result has `url` in the form `https://claude.ai/artifact/<id>` and `title`. A new page
  and a republish carry `updated` (`false` or `true`); a create from a type (`type_url`) carries
  `created_from_type: true` without `updated`. An asset upload (`asset: true`), `read`, `list` and `quickstart` have
  other result fields. An error is a `toolUseResult` string and a `tool_result` block with `is_error: true`.
- **`artifactWatch`:** a task notification without `<task-id>` and `<status>`, with `<task-type>` equal to
  `artifact-watch-lifecycle` and an `<event>` of the form `Watch on <url> ended — …`. Measured summary variants:
  `(artifact not found)` (deleted; in the measurement always with a URL that the same file published before the
  notification), `(public, outside your organization)`, and a change of the signed-in account, without a URL.
- **Carriers of the notification.** A separate turn: a `queue-operation` `enqueue` entry, then a `user` entry with
  `origin.kind: task-notification` and `queueOrigin`. During a turn: a `queued_command` attachment with the origin in
  the attachment itself (`attachment.origin.kind` and `commandMode` equal to `task-notification`), measured in one
  file only, on CLI 2.1.291, in the account-switch variant.
- **Notice in the transcript.** The task notification gets its own notice kind, `artifact-watch` (`noticeFromText`
  in `notice.ts`), in every variant. `name` is the quoted title from the summary (the account-switch variant has
  none); there is no result. The notification stays out of the background task list: it has no `<task-id>`.

## Recognition

`artifactFact(entry)` in `artifacts.ts` turns one parsed entry into a fact or nothing, without I/O.

- **Publish:** a `user` entry outside a subagent, with a timestamp; `toolUseResult` is an object and its `url` is
  EXACTLY an artifact URL (`isArtifactUrl` in `notification.ts`: the prefix and an identifier of ASCII letters and
  digits); plus `created_from_type === true` or a boolean `updated`, at least one `tool_result` block and none with
  `is_error`. Recognition goes by shape, not by tool name, because the call sits in another entry, often before the
  tail window.
- **Deletion:** only a harness notice (a `user` entry or a `queued_command` attachment with the `task-notification`
  origin, outside a subagent) with the `artifact-watch-lifecycle` type, the `(artifact not found)` variant at the end
  of the summary, and the URL from the last `<event>` that starts a line. The title in the summary is model text, so
  the variant phrase or `<event>…</event>` inside the title does not count.
- **Dropped** (negative tests in `server/test/herdr-artifacts.test.ts`): results of `read`, `list`, `quickstart`,
  asset uploads and errors; a URL in a `Bash`, `Read` or `WebFetch` result (it has `url` but no `updated`); a
  subagent entry; a URL outside the grammar (with a port, a further path segment, a query, a fragment, user info,
  another host). These are not a deletion: the `queue-operation` entry itself (of a separate-turn carrier only the
  `user` entry after it counts; `queue-operation` also holds human prompts and agent reports, which can quote a
  notification), a quoted notification in a human prompt, in a message from an agent (`peer`) or in a tool result,
  another variant (also with the phrase "artifact not found" in the title), and "not found" without a URL.

## The list

`createArtifactsTracker()` in `artifacts.ts` keeps the title, the last publish time and a deleted flag per URL.

- A publish sets the title and time and clears the deleted flag; the time never moves back. A deletion applies only
  to a URL this conversation published: a notification about another URL (the session only read that artifact)
  leaves the list unchanged.
- Newest publish first (on equal time, the one further down the file), at most `ARTIFACTS_MAX = 20`. On overflow,
  the artifact with the oldest publish drops out.
- The title has no control characters (`Cc`, U+2028, U+2029; `stripControlChars`), trimmed ends, at most 120 UTF-16
  units without a split character (`clipUnits`, both in `server/src/text.ts`); an empty title becomes the identifier
  from the URL.
- Only the URL, title and time leave the result, never the file `path`, `capabilities`, `instructions` or file lists.
- The list signature (`artifactsSignature`) covers the URL, title, time and deleted flag of each item; the item
  shape is in "Contract and version compatibility".

## Lifecycle in the follower

The follower ("Source") keeps the list. The same follower counts background tasks, so every file entry goes both to
the task list and to the artifact list. An emission is one send of the list to the manager (the server's sessions).

- **Attach** (the follower opens a transcript file: a new pane, a Rarog restart, another conversation in the pane):
  the scan of the file part before the tail window (`main-scan.ts`) has a second sink, the artifact list, with its
  own prefilter (`mayCarryArtifact`: the URL prefix in the line). A line that either prefilter lets through is parsed
  once. The scan skips a line longer than 8 MiB. The window entries come next. When the scan did not run (more than
  1 GiB before the window, `MAIN_SCAN_MAX_BYTES`) or failed, the list comes from the window alone, and
  `server.log` gets the line `… background tasks before the tail window are not visible, the task and artifact lists
  come from the window alone`.
- **The follower's first emission always goes out, even empty.** After a driver swap (a new driver and follower
  after a break in the connection to the herdr socket, "Path to the app") the session still holds the previous
  follower's list, and only this emission overwrites it. It goes after the scan and
  the window, or right away when there is no transcript file. Each next one, also after a `repoint` (below), goes out
  only when the signature changes, batched every 100 ms with background tasks; the task list has the same rule
  (`background-tasks.md`, "How the list reaches the app"). An empty list does not travel to the app: the manager
  removes the field instead.
- **`repoint`** moves the follower to another transcript file (`/clear`, `/resume` of another conversation): the
  list starts from zero. `/clear` starts a new file, so the list is empty; resuming the same conversation appends to
  the same file and keeps the list.
- **File truncation or skip** (an append larger than 16 MiB, `FOLLOW_MAX_READ_BYTES`, which the follower skips
  without reading): the list starts from zero and a background scan reads the file from the start
  (`#restartArtifacts`), because the list only accumulates and would not recover from the lines that follow. The
  scan covers the file up to the point where the follower resumes reading (the new end after a truncation, the
  start of the tail window after a skip). The list is not emitted until the scan ends; facts the follower reads live
  in the meantime are applied on top of the scan result, in the order they were read. A failed scan (the file is
  gone, truncated again, a disk error, more than 1 GiB before that point): the list holds only the facts read live
  after the reset, and the log gets the line `… artifacts before the file truncation or skip are not visible` with
  the reason. From 8 MiB of file (`TASKS_SCAN_LOG_BYTES`) the scan logs its duration: a log threshold, no cap.
- **Races:** `repoint`, closing the follower and another reset invalidate a running scan; a `repoint` during the
  attach scan invalidates it the same way as the task scan.

## Path to the app

Follower → driver (the herdr pane adapter) → manager (the server's sessions) → session summary → SSE stream frames
to the app: `session-changed` (one session) and `sessions-snapshot` (all).

- **Driver** (`server/src/drivers/herdr-driver.ts`) maps the follower event 1:1 to the manager event `artifacts`.
  Unlike most follower events, this one is not a sign that the file grew, because the first emission also goes out
  without a file. The driver's guards against a stuck send or turn measure file silence from real growth only.
- **Manager** (`server/src/sessions/manager.ts`, the list rule in `server/src/sessions/conversation-lists.ts`): a
  non-empty list sets the field and broadcasts the session in a `session-changed` frame; an empty one removes the
  field. An empty list when the field is absent broadcasts nothing, because otherwise a Rarog restart would send a
  frame for every pane. A list change does not touch the session
  state, the `seen` marker or push notifications.
- **Driver swap** (after a break in the connection to the herdr socket) keeps the session with its list only for the
  same conversation in scope: the new follower's first emission overwrites it, so the section does not flicker. When
  the pane writes another conversation or has left `RAROG_HERDR_ROOTS`, the manager removes the field before the
  broadcast, together with the background task list (`background-tasks.md`, "How the list reaches the app").

## Task notification and the `done` push

The task notification that ends the watch arrives as a `user` role entry in every session that published or read the
artifact, even one that finished long ago. The model answers on its own, usually "nothing to do", and ends the turn.
This is a real turn: herdr reports work and its end, and the turn start clears `seen`. Without the rule below, its end
would give a `done` push and a sound on the Live Activity in a session where nothing happened.

- **Rule.** A turn in which, since the previous turn end, the only `user` messages were `artifact-watch` notices
  (also together with notices that a background subagent stopped and waits) and the main agent called no tool gives
  no `done` push, in every variant of the notification. `noResultTurn` in `server/src/notify/policy.ts` decides, the
  same function as for a turn after a standby alone (`background-tasks.md`, "Standby-only turn").
- **The `done` push stays** when the agent used a tool after the notification, when the turn held something else
  (a human prompt, a subagent report, a command end), and when the turn tally is incomplete (the first turn after the
  driver attaches, after a Rarog restart, after `/clear`). An ordinary turn before the notification whose `done`
  push was held back by running background work leaves an owed `done` push (the push scheduler remembers it per
  session). The quiet turn does not create one, but it releases an existing one with the ordinary turn's banner, the
  same as a turn with only a subagent standby (`background-tasks.md`, same section).
- **Tally.** The manager counts `artifact-watch` notices (`Session.turnInput.artifactWatch`) and the main agent's
  tool calls from the main file (`toolCalls`) from turn end to turn end. The push does not wait for a late call: a
  call that arrives from the file up to 10 s after the end of a quiet turn makes the manager hand that turn end to the
  push scheduler a second time, this time with an ordinary `done` push (`Session.quietTurnEnd`).
- **Trace** in `server.log`: `push: quiet for <project> (done, turn after an artifact task notification alone)`.
- **The row stays as it was.** When the previous result was received, the end of the quiet turn puts the receipt
  back (`seen`), so the row and the Live Activity do not show a new result; a late tool call takes it back
  (`background-tasks.md`, "Standby-only turn: no `done` push").

## Contract and version compatibility

- **Field** `SessionSummary.artifacts?: SessionArtifact[]` (`shared/src/protocol.ts`), item `url`, `title`,
  `publishedAt` (ISO) and `gone?: true`; newest publish first, at most 20. A missing field means no artifacts or
  nothing read; an empty list does not travel. The field is additive: `PROTOCOL_VERSION` does not change, and the
  field has no entry in `DEGRADATIONS`, the list of fields where the app swaps an unknown value for a fallback.
- **The frame schema** rejects the whole frame on a wrong type, and a rejected `sessions-snapshot` frame delivers no
  session to the app. `gone: false`, `artifacts: null` and an item without a required field are such errors (the
  server never sends them). The schema does not check the URL grammar, because a bad URL should cost at most a row
  without a link: the app opens only a URL in the grammar ("What the app shows").
- **Notice kind** `artifact-watch` (`NoticeKind`), an additive value.
- **Golden frames** (reference SSE frames in `shared/fixtures/sse/` that tests check the server and the app decoder
  against): the list in `session-changed.max.json` and `sessions-snapshot.max.json` (an ordinary and a deleted item),
  the notice in `message.notice-artifact-watch.json`, the rejections `session-changed.null-artifacts`,
  `session-changed.artifact-without-url` and `session-changed.false-artifact-gone`.
- **Swift** (`RarogContract`): `SessionArtifact` with `gone: Bool` (on the wire the literal `true` or no field), the
  field in `SessionSummary`, the case `NoticeKind.artifactWatch`.
- **Compatibility.** A newer app with an older server gets no field, so it has no section, and sees the notification
  as `unknown`. An older app with a newer server skips the unknown field (decoder without `allKeys`), and
  `artifact-watch` degrades to `unknown` (`notice.kind` in `DEGRADATIONS` and `Degradation.swift`).

## What the app shows

- **iPad inspector at regular width:** an Artifacts section between Recently finished (background tasks that just
  ended) and Changes, only with at least one item, not collapsible. Rows keep the server's
  order; a repeated URL stays once, in the first, newest row (`ArtifactRows.rows`). A row: an icon on the left (an
  arrow out of a square with a link, a square with a dashed edge without one), the full title, under it the age and
  publish time (`2h ago · 14:05`), after a day the age and date (`3d ago · Oct 9`), recomputed every 30 s.
  Look: `docs/design.md`, "Session inspector (iPad)".
- **Opening.** The whole row is a link (accessibility trait `.isLink`). The app checks the URL on its own,
  independent of the server: it opens only a string that is entirely of the form `https://claude.ai/artifact/<id>`
  with an identifier of ASCII letters and digits (`ArtifactRows.link`). Any other URL, including `http` or one with a
  non-ASCII character, gives a row without a link. A tap hands the URL to the system with `#no_universal_links`
  appended, so the default browser opens it, not the Claude app. The link cannot be copied (no menu).
- **A deleted artifact** stays dimmed: the title in `muted`, the line `deleted · 1d ago · Oct 15`, plain text with
  no button. VoiceOver adds "deleted" to the label; for a live artifact it says that the row opens the browser.
- **No section** on iPhone, on iPad at compact width, in a Claude session started in a Rarog terminal (a
  shell in a herdr pane opened from the app; it has no inspector) and in a Codex session.
- **Recently finished** does not show the `artifact-watch` notice (`FinishedTasks.kindWord` → `nil`): a deletion
  shows only as a dimmed row in the Artifacts section.
- **Transcript:** a quiet line saying that the artifact watch ended, with the quoted title when the summary has one
  (`UICopy.harnessNotice`).
- **The on-disk list cache** does not keep artifacts (`SnapshotCacheFile.scrub`): after a cold start without network
  the section appears with the first frame.
- **Demo server** (`pnpm run demo:server`, fakes without herdr): the `artifacts` scenario
  (`server/src/demo/scenarios.ts`) has two artifacts, one deleted, and a watch-end notice in the history.

## After a Claude Code update

Recognition rests on shapes measured on a specific CLI version. The `artifactPublish` and `artifactWatch` registry
entries carry that version, and a guard ties them to fixtures from real transcript files.

- **Comparison.** Recognition is checked two ways on the same transcript files: publishes counted independently from
  the `tool_use` input (`Artifact`, action `publish`, without `asset: true`, a result without `is_error`) versus
  publishes recognized by `artifacts.ts`, with the difference by `tool_use_id`. A difference means that the CLI and
  the server disagree on a shape.
- **Fixtures** in `server/test/fixtures/herdr/artifacts/measured/`: `publikacje.jsonl` (a call and result pair for
  each shape) and `meldunki.jsonl` (a line for each carrier and variant), each also as a copy
  `<name>-<CLI version>.jsonl` (the newest CLI version that wrote any of its lines), plus `.ostatni-pomiar` (the
  list of versioned copies the last measurement wrote). The source is the account's transcript files in
  `~/.claude/projects` from the last days before the measurement, so a shape the CLI no longer writes disappears
  from the fixtures only once it falls out of that window of days. No page content: every
  URL and title is the same placeholder URL and title; from the input only `action`, `asset` and the presence of
  `type_url` remain, from the result the values of `updated` and `created_from_type` and the names of all fields
  (`_klucze`); the write goes through the anonymizer (`scripts/anonymize-fixture.ts`).
- **Guard** `server/test/herdr-background-fixtures.test.ts` requires every `artifactPublish` and `artifactWatch`
  literal to appear in the fixtures where the code reads it, and the entry version to be the version in the name of
  the copy that is byte-for-byte equal to the unversioned file.
- **A new shape or variant** (a new line in `publikacje.jsonl` or `meldunki.jsonl`) comes with a decision whether
  recognition counts it: a fix in `artifacts.ts`, a registry entry (version, date) and a literal rule in the guard.

## Module map

Each section above names its server modules; the rest is here.

- Server: `server/src/herdr/background/notification.ts` (`taskType` reads `<task-type>` only from the notification
  header, before the first `<summary>`, because the task name and the agent result are model text; `watchedUrl`
  takes the URL from the event), `server/src/sessions/session.ts` (the `artifacts` field), and the turn tally in the
  manager (`#noteTurnInput`, `#noteToolCalls`).
- App: `RarogContract/SessionSummary.swift` and `Transcript.swift`, `RarogCore/SnapshotCacheFile.swift`,
  `RarogUI/Model/InspectorSections.swift` (`ArtifactRow`, `ArtifactRows`), `RarogUI/Views/Inspector/InspectorPanel.swift`
  (`InspectorArtifactsSection`, `ArtifactRowView`), `RarogUI/Model/BrowserLinks.swift`, copy in
  `RarogUI/Copy/UICopy+Inspector.swift` and `UICopy+Transcript.swift`.
- Server tests in `server/test/`: `herdr-artifacts.test.ts`, `herdr-main-scan.test.ts` (a differential test of both
  sinks), `herdr-jsonl-follow-artifacts.test.ts`, `herdr-artifacts-integracja.test.ts` (the real follower, driver and
  manager: publish, dimming, `/clear`, driver swap, leaving scope), `herdr-background-fixtures.test.ts`,
  `herdr-background-boundary.test.ts`, `notify-policy.test.ts`, `notify-harmonogram.test.ts`, `manager-herdr.test.ts`,
  `demo-control.test.ts`, `sse-fixtures-producenci.test.ts`. App tests: `ArtifactRowsTests.swift`,
  `InspectorTests.swift` (`FinishedTasksTests`), `BrowserLinksTests.swift`, `InspectorUITests.swift`
  (`testArtifactsSection`).

## Known gaps

- **Deletion during a turn** is measured only in the account-switch variant; the attachment carries the
  `task-notification` origin, so the rule covers it. The "not found" variant during a turn has not occurred in the
  measurement. If it arrived without the origin, the row would not be dimmed (the safe direction).
- **Deletion by the session itself** (`Artifact` with `action: "delete"`): the result shape is unmeasured. If the
  watch then ends with a "not found" notification, the row dims on its own; if not, it stays ordinary.
- **A title change on republish** is unmeasured; the list takes the title from the last publish.
- **File truncation mid-line.** After a truncation the follower drops the unfinished last line (transcript, tasks
  and the artifact list; the scan after the reset does not take it either). If someone appended the rest of that
  line, a publish from it would return only on the next attach. The scenario is unmeasured: Claude Code appends whole
  lines and does not truncate the file.
- **Browser instead of the Claude app** works as long as claude.ai's `apple-app-site-association` file (the list of
  URLs that iOS opens in the Claude app) excludes `no_universal_links`; the app does not check this.
- **Blue row after the notification** ("Task notification and the `done` push"). Only the transcript file knows the
  agent's tools (a `tool_use` entry): a turn in which the agent used only a tool without such an entry would be quiet
  (`background-tasks.md`, "Known gaps").
- **Out of scope:** subagent artifacts, Claude Docs documents (`mcp__claude_ai_Claude_Docs__*`), Codex, page content
  previews and thumbnails. The server fetches nothing from claude.ai.
