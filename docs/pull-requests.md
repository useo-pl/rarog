# Session pull requests

A session pull request is a GitHub PR that a Claude Code session created with `gh pr create` in the `Bash` tool:
the main agent, a subagent or a workflow agent. This document covers how Rarog builds a session's PR list, how it
learns each PR's state on GitHub and how both reach the app.

**In short.** Rarog builds the list from the session's conversation files out of one fact: a `Bash` call that runs
`gh pr create`, paired with its result that has a line holding exactly the PR URL (for a command that ran in the
background, the output file the CLI names when the command ends). The list belongs to the
conversation: after `/clear` it is empty, and after a Rarog restart it is rebuilt from the files. The state (`open`,
`draft`, `merged`, `closed`) comes from GitHub through the user's GitHub CLI (`gh`) login, only while an app is connected
("State on GitHub"). The server sends both in the session summary (`SessionSummary.pullRequests`). Code:
`server/src/herdr/background/pull-requests.ts` (recognition, pure), `pull-request-files.ts` (reading) and
`server/src/pr-status/` (state).

## Sources

The conversation files of one Claude Code session, in the Claude Code store (`~/.claude/projects/<slug>/`):

- the main file `<uuid>.jsonl`, the same file the transcript follower reads;
- subagent files `<uuid>/subagents/agent-<id>.jsonl`;
- workflow agent files `<uuid>/subagents/workflows/wf_<id>/agent-<id>.jsonl`.

All files count, also those of agents that finished long ago. The subagent and workflow agent files are read only
when `RAROG_AGENT_FILES` allows reading subagent files (`server-config.md`); otherwise only the main file counts.
Only a Claude session in a pane under `RAROG_HERDR_ROOTS` has a reader (`security-model.md`, "herdr sessions",
item 6); Codex has none.

## Recognition

`pullRequestsOf(entry, calls)` turns one parsed entry of one file into PRs and requests to read an output file,
without I/O.

- **Call:** a `tool_use` block of the `Bash` tool whose `input.command` RUNS `gh pr create`: a segment of the command
  chain (split at `&&`, `||`, `;`, `|`, `&`, a newline or a subshell parenthesis) starts with `gh pr create` (also
  `/path/to/gh`), after variable assignments, `env` or `command`, and `timeout` or `gtimeout` with a literal duration
  (`180`, `5m`, `1.5h`) after its options `--preserve-status`, `--foreground`, `-v`, `--verbose`, `-s`/`--signal`
  and `-k`/`--kill-after` (with the value joined or as the next word), and the end of options `--` before the
  duration. A `timeout` of another shape (no duration, an
  unknown option) stays the program, so its segment is neither `create` nor quiet. The same unwrapping holds for
  the other segments: `timeout 5 git push && gh pr create` is recognized. Text in quotes, an `echo` argument,
  a heredoc body and a comment are not a command (`shellSegments`); `&` in a redirection (`2>&1`, `&>file`) does
  not split.
  Every OTHER segment of the command must be quiet, or the result is ambiguous and the call is not recognized: `cd`,
  `pushd`, `popd`, `git`, `export`, `unset`, `set`, `true`, `false`, `sleep`, `test`, `[`, the output filters `tail`,
  `head`, `tee`, `grep`, `wc`, and `echo` or `printf` with literal words only. Also quiet: `cat`, `echo` or `printf`
  whose stdout goes to a file (`cat > body.txt <<'EOF'`; not `>&2` and not a `/dev/` path other than `/dev/null`),
  the file tools `rm`, `mkdir`, `cp`, `mv`, `ln`, `touch`, `chmod` and `mktemp` without a verbose flag, `sed -i`,
  and the line-length check `awk 'length > N {print NR": "length}' file` with files only (no `-` option, no `X=…`
  operand). A redirect is an unquoted word (`">x"` is an argument). A segment with a PR URL in any word is never
  quiet, and these extra rules do not apply to a segment with a command substitution (`$(…)`, backticks): its
  stderr reaches the result. So `gh pr view … || gh pr create`, `printf <url>`, `cat file` or `echo "$B"` next to
  `create` gives nothing. Several `gh pr create` segments in one command all count, but without titles: the result
  does not say which URL belongs to which one. The call is remembered by its `tool_use_id`, at most 64 calls
  without a result per file.
- **Result:** a `tool_result` block with the `tool_use_id` of a call from THE SAME FILE, with a line of its content
  that is EXACTLY `https://github.com/<owner>/<repo>/pull/<number>` (owner of letters, digits and hyphens, repo of
  letters, digits, `.`, `_` and `-`, a positive number of up to 9 digits). The exit code of the whole `Bash` call does
  not decide: `gh pr create --fill && false` creates a PR and ends with an error, so `is_error` filters nothing. The
  content is the output and errors together, the way the CLI writes them (measured on CLI 2.1.216–2.1.319); a line
  right after `gh`'s message `… already exists:` does not count (that PR existed before the call). The time is the
  result entry's `timestamp`; an entry without a time gives no PR.
- **Result of a command in the background:** a recognized call that runs in the background (`run_in_background`,
  or one the CLI moved there after its 120 s timeout) gets a `tool_result` without the output, and the entry's
  `toolUseResult.backgroundTaskId` holds the task id (lower-case letters and digits, at most 32). If that result
  already has a PR URL line, it counts as above. Otherwise the call waits, at most 64 per file, for the CLI's end
  notification in THE SAME FILE: an entry with `origin.kind: "task-notification"` (or the same notification in a
  queued attachment) whose text has a non-empty `<status>`, the call's id in `<tool-use-id>` and the same
  `<task-id>`. A notification without `<status>` leaves the call waiting. The notification asks the reader for the
  file named in `<output-file>` ("Reading", the output file item); its text goes through the same line rule as
  a `tool_result` content, so a line with a prefix (`create 1: <url>`) does not count. The time is the notification
  entry's `timestamp`, the title is the call's. A notification for any other call reads nothing (fixture
  `server/test/fixtures/herdr/tasks/measured/resume-cli-2.1.296.jsonl`).
- **Dropped** (negative tests in `server/test/herdr-pull-requests.test.ts`): `echo "gh pr create" && echo <url>`,
  `grep 'gh pr create'`, `gh pr view`, a URL in a `Read` result, in agent text or in a prompt, the
  `pull/new/<branch>` link that `git push` prints, a URL with a further path, a query or another host, and a result
  whose call the file does not hold before it.
- **Title:** the value of `--title`, `--title=…` or `-t` when the command gives it literally (no `$` expansion or
  command substitution); no control characters, trimmed, at most 120 UTF-16 units. Otherwise no title. Nothing else
  from the command leaves the server: no body, paths or other arguments.

The shape was checked against 83 `gh pr create` results in real conversation files: in every result where `gh`
created a PR, the URL stood in the `tool_result` content as a line of its own.

## The list

`createPullRequestList()` in `pull-requests.ts` keeps one item per URL across all files of the conversation.

- The same URL again adds no row: the earliest time stays (the PR was created at the first result), and the title
  comes from the first call that gave one.
- Newest first (by creation time, then by number), at most `PULL_REQUESTS_MAX = 20`. On overflow the oldest PR drops
  out.
- The list signature (`pullRequestsSignature`) covers the URL, time and title of each item.

## Reading

`createPullRequestFilesReader()` in `pull-request-files.ts` reads the files incrementally, from a remembered offset per
file, in chunks of 1 MiB (one file at a time through `incremental-read.ts`). Only lines that contain `create`, `/pull/`,
`backgroundTaskId` or `task-notification` are parsed; a line longer than 8 MiB is skipped whole. A file that got shorter
or is another file under the same name (another inode) is read again from the start; the list keeps what it had, and a
repeated URL adds nothing. Files are kept under their path relative to the session directory, so a move of the files
(`EnterWorktree`) keeps the offsets.

- **Budget.** One read takes at most 256 MiB from all files together (`PULL_REQUEST_SCAN_BUDGET_BYTES`); the rest
  waits for the next read after a 1 s pause, and nothing is skipped. The subagent files of one session reach hundreds
  of MiB (p99 over 400 MiB in the measured store), so the first read after a Rarog restart can take several passes.
  A read of 8 MiB or more writes a line with its cost to `server.log`: `pull request scan <uuid>: <bytes> B from <n>
  files in <ms> ms`.
- **Main file path.** The driver takes it from the transcript follower (`transcriptOffset`), so the reader looks at
  the same file the follower reads and does not glob the store itself. Until the follower has read the file, the
  reader returns the list it has.
- **When.** The driver (`server/src/drivers/herdr-driver.ts`) schedules a read 5 s (`PULL_REQUESTS_POLL_MS`) after a
  signal; signals in that window share one read. Signals: a follower event (the main file grew; the artifact list
  and a dropped echo do not count), a change of the background task list (a subagent or workflow agent started or
  ended, a workflow layout changed), and right away: the driver attach, `/clear` or `/resume`, and a move of the
  files.
- **`/clear` and `/resume`** move the reader to another conversation: the list and offsets start from zero. Resuming
  a conversation reads its files again, so its PRs come back.
- **Output file of a background command.** The only file outside the conversation files that the reader opens, and
  only on the end notification of a recognized `gh pr create` call ("Recognition"). The path from `<output-file>`
  must be absolute and already normal (no `..`, `.`, `//` or trailing `/`), named `<task id>.output` with the
  call's task id, in a directory `tasks` whose parent is a conversation uuid; the CLI writes
  `<tmp>/claude-<uid>/<slug>/<uuid>/tasks/<task id>.output` (measured on CLI 2.1.296 and 2.1.316). Any other path
  is not opened. The file is read through `server/src/safe-read.ts` (`readRegularFile`): no symlink in the last
  part, a regular file only (a FIFO or a device gives nothing and does not block), at most 64 KiB
  (`PULL_REQUEST_OUTPUT_MAX_BYTES`); a longer file gives no PR, not its first part. A missing file or an error gives
  no PR. The agent in the sandbox can write that directory, which is why these checks exist; for an agent task the
  CLI puts a symlink there, which is refused. Only the PR URL leaves the file. After a Rarog restart the reader
  reads the conversation files from zero, so it reads the output file again while it exists.

## State on GitHub

The server asks GitHub for the state of the PRs on the session lists with the user's `gh` login for `github.com`.
Code: `server/src/pr-status/` (`gh.ts` the `gh` source, `tracker.ts` the URL → state map and its rhythm),
`server/src/sessions/pr-status-link.ts` (the manager's side) and `server/src/bootstrap/pr-status.ts` (start).

- **Program.** The first executable `gh` in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`,
  `/home/linuxbrew/.linuxbrew/bin` and `~/.local/bin` (`~` is the server's `HOME`), looked up at the first read; no
  `PATH` lookup. It starts without a shell and gets only `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR` and `PATH` of
  the server environment: no Rarog secret and no `GH_TOKEN`. The token stays with `gh` (on macOS in the login
  keychain); Rarog never reads it.
- **Query.** One `gh api graphql --hostname github.com --input -` call for up to 50 PRs. The query text names only
  alias indices; owner, repository and number travel as GraphQL variables on stdin, so no repository name stands in
  argv. A call is killed after 20 s, and over 1 MiB of stdout or of stderr. One call at a time: 60 PRs are two calls,
  one after the other. stdout decides whatever the exit code, because `gh` exits 1 when one PR is not found and
  still prints the others.
- **State.** The query asks for `state` and `isDraft`. GitHub's `OPEN` with `isDraft: true` is `draft`; `OPEN` with
  `isDraft` false, missing or not a boolean is `open`. `MERGED` and `CLOSED` are `merged` and `closed` whatever
  `isDraft` says, because only an open PR can be a draft. Any other value means no state.
- **Rhythm.** Only while at least one app has the SSE stream open: with no client there is no call. A new URL is
  asked 5 s after it first appears, and a connecting app gets everything overdue at once. Then an `open`, `draft`
  or `closed` PR is asked every 5 min and a PR without a state every 30 min; `merged` is final and never asked again.
  A URL in two sessions is asked once. A URL that no session lists any more leaves the map.
- **Failures.** No `gh` in the directories: no state until a restart, one line in `server.log`. Not logged in, an
  error or a timeout: every query, new URLs included, pauses for 30 min, so after `gh auth login` the states come
  when the pause ends, without a restart. GitHub's rate limit: a pause until its reset time, at most 1 h. A known
  state stays through a failure. A log line names the failure kind and the number of PRs, never a repository, a URL,
  the output of `gh` or a token.
- **Where the state lives.** In the URL → state map, not in the session: the manager lays the known state over the
  list when it builds the summary. So a list the driver pays out again carries the known states in the same frame,
  and a result that comes after the list changed (`/clear` during a query) cannot bring the old list back.
- **Frames.** A state change sends `session-changed` to every current session that lists the URL; the same state
  again sends nothing. It touches neither the session state, nor the `seen` marker, nor push notifications.
- **No state** on a PR means one of: not read yet (the first seconds, or no app connected since the list came), not
  found on GitHub (a deleted repository, or the `gh` account has no access), `gh` missing or not logged in, a
  failure pause, or `RAROG_PR_STATUS=0`.
- **Flag** `RAROG_PR_STATUS` (`server-config.md`, "Preferences and feature flags"): on by default; `0` means no
  tracker, no `gh` call and no `state` field on the wire. `rarog doctor` has a line for it: `gh` found and logged in,
  or what is missing. The outbound channel and its limits: `security-model.md`, "PR status: the state of session
  PRs from GitHub".
- **Demo and review mode** answer from a fixed map (`demoPullRequestStates` in `server/src/demo/seeds.ts`: the demo
  PRs and those of the content set, read without delay) and never look for `gh`; there the `rarog doctor` line is
  `info` and starts no process.

## Path to the app

Reader → driver → manager (the server's sessions) → session summary → SSE stream frames to the app:
`session-changed` (one session) and `sessions-snapshot` (all).

- **Driver** sends the event `pull-requests` only when the list signature changes. It starts from the empty list's
  signature, so a pane without PRs sends nothing on attach.
- **Manager** (`server/src/sessions/manager.ts`, the list rule in `server/src/sessions/conversation-lists.ts`): a
  non-empty list sets the field and broadcasts the session in a `session-changed` frame; an empty one removes the field;
  an empty list when the field is absent broadcasts nothing. A list change does not touch the session state, the `seen`
  marker or push notifications. The list goes to the PR status tracker, and the summary carries each known state ("State
  on GitHub"). A driver swap keeps the field only for the same conversation in scope; when the pane writes another
  conversation or has left `RAROG_HERDR_ROOTS`, the manager removes it before the broadcast, together with the artifacts
  (`artifacts.md`).
- **App** (iPad session inspector, `design.md`, "Session inspector"): a "Pull requests" section between Artifacts and
  Changes, only when the list is not empty. Rows in server order, deduplicated by URL (`PullRequestRows` in
  `RarogUI/Model/InspectorSections.swift`): the title or `owner/repo#n`, then `owner/repo#n`, how long ago and the
  time, after a label with the state word on GitHub's state colour when the server sent one. Open, draft and
  unknown-state PRs stay in view; merged and closed ones fold under one "Merged and Closed (N)" row at the end of
  the section (`PullRequestRows.split`), folded by default, and a tap unfolds them. Switching to another session
  or closing the panel folds them again. A row is a link only when its URL is in the server's grammar; the tap hands
  the URL to the system. iPhone, iPad at compact width,
  a Claude session in a Rarog terminal and Codex have no inspector, so no section.
- **Demo server** (`pnpm run demo:server`): the `pull-requests` scenario (`server/src/demo/scenarios.ts`) has three
  PRs built from conversation entries by `sessionPullRequests`: a titled one that is `merged`, one without a title
  and without a state, and one created with `--draft` that is a `draft`.

## Contract and version compatibility

- **Field** `SessionSummary.pullRequests?: SessionPullRequest[]` (`shared/src/protocol.ts`), item `url`, `repo`
  (`owner/name`), `number`, `createdAt` (ISO), an optional `title` and an optional `state` (`open`, `draft`,
  `merged`, `closed`); newest first, at most 20. A missing list means no PRs or nothing read; an empty list does not travel.
  A missing `state` means the state is unknown ("State on GitHub", "No state"). Both fields are additive:
  `PROTOCOL_VERSION` does not change.
- **The frame schema** rejects the whole frame on a wrong type (`pullRequests: null`, an item without a required
  field, `state: null` or a number). It does not check the URL grammar: the app opens only a URL in the grammar.
  An unknown `state` string drops only that field on the client (`DEGRADATIONS['pullRequests.state']`).
- **Golden frames:** the list in `session-changed.max.json` and `sessions-snapshot.max.json` (items with a title and
  without, one per state and one without a state); `session-changed.unknown-pull-request-state.json` (degraded),
  `session-changed.null-pull-request-state.json` and `session-changed.numeric-pull-request-state.json` (rejected).
- **Swift** (`RarogContract`): `SessionPullRequest` with `PullRequestState`, and the field in `SessionSummary`.
- **The on-disk list cache** of the app does not keep PRs (`SnapshotCacheFile.scrub`): the title is agent text and
  the URL names the repository, also a private one. After a cold start without network the PRs come with the first
  frame.
- **Compatibility.** A newer app with an older server gets no field. An older app with a newer server skips the
  unknown field (decoder without `allKeys`). An app that does not know the `draft` state drops the field and shows
  the row without a state.

## Known gaps

- **A PR created another way** (`gh api`, `hub`, a `git push` with a server-side hook, the GitHub web page, an MCP
  tool) is not on the list, and neither is a PR the conversation only mentions.
- **`gh pr create` inside a script** (`bash -c "…"`, `./release.sh`) is not a recognized call: the command text does
  not run `gh` directly. The same holds for a retry loop that captures the output (`out=$(gh pr create …)`) and
  prints it with a prefix.
- **A command that ran in the background** counts only through its output file ("Reading"). The CLI deletes these
  files after some days (unmeasured): until then a Rarog restart finds the PR again, after that the PR is gone from
  the list after the next restart (a running server keeps it). A notification that lands in another conversation file than the
  call, or a call evicted after 64 others waiting in the same file, gives no PR.
- **No checks or reviews:** the state is only `open`, `draft`, `merged` or `closed`.
- **GitHub Enterprise** hosts other than `github.com` are not recognized, and the state is asked only of
  `github.com`.
