# Session pull requests

A session pull request is a GitHub PR that Claude Code linked to the session's current conversation with a `pr-link`
entry, whose author is the user's GitHub CLI (`gh`) login and which was created after the conversation's first entry.
This document covers how Rarog builds a session's PR list, what it asks GitHub about each PR and how the list
reaches the app.

**In short.** The main conversation file gives the linked set: one item per PR URL of a `pr-link` entry, with the
time of its first entry. GitHub gives, through the user's `gh` login, the author, creation time, title and state of
each PR and the login itself. The list shows a linked PR only when GitHub says its author is that login and it was
created at or after the conversation's first entry. The list belongs to the conversation: after `/clear` it is
empty, and after a Rarog restart the links are read again and the PRs come back with GitHub's first answer. GitHub is
asked only while an app is connected ("State on GitHub"), so without `gh`, a login or GitHub's answer the list is
empty. The server sends it in the session summary (`SessionSummary.pullRequests`). Code:
`server/src/herdr/background/pull-requests.ts` (recognition, pure), `pull-request-files.ts` (reading),
`server/src/pr-status/` (GitHub) and `server/src/sessions/pr-status-link.ts` (the list).

## Sources

- **The main conversation file** `<uuid>.jsonl` of one Claude Code session in the Claude Code store
  (`~/.claude/projects/<slug>/`), the same file the transcript follower reads. Subagent and workflow agent files are
  not read for PRs: the `pr-link` entry stands in the main file (seen on CLI 2.1.296–2.1.3xx, never in a subagent
  file).
- **GitHub**, through the user's `gh` login: the author, creation time, title and state of each linked PR, and the
  login (`viewer.login`) the verdict compares the author with ("State on GitHub").

Only a Claude session in a pane under `RAROG_HERDR_ROOTS` has a reader (`security-model.md`, "herdr sessions",
item 6); Codex has none.

## Recognition

`pullRequestLinkOf(entry)` in `pull-requests.ts` turns one parsed entry of the main file into a linked PR, without
I/O.

- **Entry:** a top-level entry `{type: "pr-link", sessionId, prNumber, prUrl, prRepository, timestamp}` (the shape
  seen on CLI 2.1.296–2.1.3xx; the literals stand in `CLI_SHAPES.prLink`). Per the Claude Code docs ("Create pull
  requests" in common workflows, "Pull request status" in the agent view), a session is tied to a PR when Claude
  creates it, edits, comments on, closes or marks ready an existing PR through `gh`, or checks out or pushes to a
  branch with an open PR; the name of the entry is an observation, not documented.
- **Valid:** `prUrl` is EXACTLY `https://github.com/<owner>/<repo>/pull/<number>` (owner of letters, digits and
  hyphens, repo of letters, digits, `.`, `_` and `-`, a positive number of up to 9 digits), `prNumber` and
  `prRepository` (`<owner>/<repo>`) agree with the URL, and `timestamp` is a valid time. `sessionId` is not checked:
  a forked conversation copies the entries of its parent, and they count.
- **Dropped** (negative tests in `server/test/herdr-pull-requests.test.ts`): a URL with another host (GitLab,
  GitHub Enterprise), a further path or a query, a number or repository that disagrees with the URL, an entry
  without a valid `timestamp`, a link entry only in a subagent file, and a PR URL in any other entry (the result of
  a command that created the PR, agent text, a prompt).
- **Window:** the `timestamp` of the first entry of the main file that has a valid top-level one; a nested
  `timestamp` does not count. It is the lower bound of the conversation ("The list").

## The list

The linked set (`createLinkedPullRequests()` in `pull-requests.ts`) keeps one item per URL: the earliest entry time
is its `createdAt`, the same URL again adds no row, and above `LINKED_PULL_REQUESTS_MAX = 100` URLs the oldest
drops out. It carries no title and no state. The driver pays out the set and the window together; their signature
(`pullRequestLinksSignature`) covers the window and the URL and time of each item.

The card shows `visiblePullRequests()` of `server/src/sessions/pr-status-link.ts`, a pure function of the linked
set, the window, the `gh` login and the facts from GitHub:

- a linked PR is shown only when GitHub says its author is the `gh` login and its creation time is at or after the
  window (equal counts); no login, no window or no facts for the PR = not shown;
- the title is GitHub's, `createdAt` stays the time of the first link entry;
- newest first (by `createdAt`, then by number), at most `PULL_REQUESTS_MAX = 20`, cut after the filter, so newer
  PRs of other authors do not push the user's own PR out.

The verdict runs again when the set or the window changes, when GitHub answers facts or a title for a linked URL,
and for every session with links when the `gh` login changes. Only the shown URLs enter the state map ("State on
GitHub"). The same URL in two conversations has one set of facts and a verdict per window.

## Reading

`createPullRequestFilesReader()` in `pull-request-files.ts` reads the main file incrementally, from a remembered
offset, in chunks of 1 MiB (`incremental-read.ts`). Until the window is known it parses every line; after that only
lines that contain `pr-link` are parsed. A line longer than 8 MiB is skipped whole. A file that got shorter or is
another file under the same name (another inode) is read again from the start: the set keeps what it had, and the
window is found again.

- **Budget.** One read takes at most 256 MiB (`PULL_REQUEST_SCAN_BUDGET_BYTES`); the rest waits for the next read
  after a 1 s pause, and nothing is skipped. A read of 8 MiB or more writes a line with its cost to `server.log`:
  `pull request scan <uuid>: <bytes> B in <ms> ms`.
- **Main file path.** The driver takes it from the transcript follower (`transcriptOffset`), so the reader looks at
  the same file the follower reads and does not glob the store itself. Until the follower has read the file, the
  reader returns the set it has.
- **When.** The driver (`server/src/drivers/herdr-driver.ts`) schedules a read 5 s (`PULL_REQUESTS_POLL_MS`) after a
  signal; signals in that window share one read. Signals: a follower event (the main file grew; the artifact list
  and a dropped echo do not count), a `pr-link` entry on its own (the follower reports it without a transcript
  event), and right away: the driver attach, `/clear` or `/resume`, and a move of the files.
- **`/clear` and `/resume`** move the reader to another conversation: the set, the window and the offset start from
  zero, and the manager drops the previous conversation's set, window and list. Resuming a conversation reads its
  file again, so its PRs come back.

## State on GitHub

The server asks GitHub about the PRs of the conversations with the user's `gh` login for `github.com`: once for the
author, creation time and title of each linked PR, and on a rhythm for the state and title of each shown PR. Code:
`server/src/pr-status/` (`gh.ts` the `gh` source, `facts.ts` the facts memory and the one-time verification,
`tracker.ts` the URL → state map and the rhythm of every read), `server/src/sessions/pr-status-link.ts` (the
manager's side) and `server/src/bootstrap/pr-status.ts` (start).

- **Program.** The first executable `gh` in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`,
  `/home/linuxbrew/.linuxbrew/bin` and `~/.local/bin` (`~` is the server's `HOME`), looked up at the first read; no
  `PATH` lookup. It starts without a shell and gets only `HOME`, `USER`, `LOGNAME`, `LANG`, `TMPDIR` and `PATH` of
  the server environment: no Rarog secret and no `GH_TOKEN`. The token stays with `gh` (on macOS in the login
  keychain); Rarog never reads it.
- **Query.** One `gh api graphql --hostname github.com --input -` call for up to 50 PRs. The query text names only
  alias indices; owner, repository and number travel as GraphQL variables on stdin, so no repository name stands in
  argv. Each PR alias asks for `state`, `isDraft`, `title`, `createdAt` and `author{login}`; the query also asks for
  `viewer{login}` (the `gh` login) and the rate limit. A call is killed after 20 s, and over 1 MiB of stdout or of
  stderr. One call at a time: 60 PRs are two calls, one after the other. stdout decides whatever the exit code,
  because `gh` exits 1 when one PR is not found and still prints the others.
- **State.** GitHub's `OPEN` with `isDraft: true` is `draft`; `OPEN` with `isDraft` false, missing or not a boolean
  is `open`. `MERGED` and `CLOSED` are `merged` and `closed` whatever `isDraft` says, because only an open PR can be
  a draft. Any other value means no state.
- **Facts.** An answer with an author, a creation time and the `gh` login stores the PR's author and creation time
  in process memory until restart, shared by every conversation, and never asks for them again. A PR that GitHub
  says does not exist (also a repository the `gh` account cannot see), any other error on the PR's alias, incomplete
  facts or an answer without `viewer.login` store nothing: the PR is asked again after 30 min. The title follows
  every answer: the state read of a shown PR every 5 min brings a changed title. The title is sanitised: no control
  characters, trimmed, at most 120 UTF-16 units. The `gh` login is kept in memory only, from the last answer that
  had one.
- **Rhythm.** Only while at least one app has the SSE stream open: with no client there is no call. A new linked
  URL without facts and a newly shown URL are asked 5 s after they appear, and a connecting app gets everything
  overdue at once. Then a shown `open`, `draft` or `closed` PR is asked every 5 min and a shown PR without a state
  every 30 min; `merged` is final and never asked again. A PR that is not shown is never refreshed. A URL in two
  sessions is asked once; one call carries the state reads first and fills the rest with verifications. A URL that
  no session shows any more leaves the map; one that no session links leaves the verification queue, and its facts
  stay.
- **Failures.** No `gh` in the directories: nothing is asked until a restart, one line in `server.log`. Not logged
  in, an error or a timeout: every query, new URLs and verifications included, pauses for 30 min, so after
  `gh auth login` the PRs come when the pause ends, without a restart. GitHub's rate limit: a pause until its reset
  time, at most 1 h. Known facts and a known state stay through a failure, and a failure stores no facts. A log
  line names the failure kind and the number of PRs, never a repository, a URL, an author, a title, the login, the
  output of `gh` or a token.
- **Where the state lives.** In the URL → state map, not in the session: the manager lays the known state over the
  shown list when it builds the summary. So a list that changes carries the known states in the same frame, and an
  answer that comes after the conversation changed (`/clear` during a query) only fills the facts memory and cannot
  bring the old list back.
- **Frames.** A `session-changed` frame goes to a session when its shown list changed (a PR verified, a title, the
  login) or a URL it shows changed state; the same answer again sends nothing. It touches neither the session state,
  nor the `seen` marker, nor push notifications.
- **No state** on a shown PR means one of: not read yet (the first seconds after it was shown), not found on GitHub
  any more, or a failure pause.
- **Flag** `RAROG_PR_STATUS` (`server-config.md`, "Preferences and feature flags"): on by default; `0` means no
  tracker and no `gh` call, so session cards show no PRs. `rarog doctor` has a line for it: `gh` found and logged
  in, or what is missing and that session cards show no PRs without it. The outbound channel and its limits:
  `security-model.md`, "PR status: the state of session PRs from GitHub".
- **Demo and review mode** answer from a fixed map (`demoGitHub` in `server/src/demo/seeds.ts`: the demo login as
  author of every demo PR, the states and titles of the demo PRs and of the content set), read without delay and
  whether an app is connected or not, and never look for `gh`; there the `rarog doctor` line is `info` and starts no
  process.

## Path to the app

Reader → driver → manager (the server's sessions) → session summary → SSE stream frames to the app:
`session-changed` (one session) and `sessions-snapshot` (all).

- **Driver** sends the event `pull-requests` (the linked set and the window) only when their signature changes. It
  starts from the empty set's signature, so a pane without links sends nothing on attach.
- **Manager** (`server/src/sessions/manager.ts`, the list rules in `server/src/sessions/conversation-lists.ts` and
  `pr-status-link.ts`): the event stores the set and the window on the session and recomputes the shown list
  ("The list"); a `session-changed` frame goes out only when the shown list changed. An empty shown list removes the
  field. A list change does not touch the session state, the `seen` marker or push notifications. The summary
  carries each known state ("State on GitHub"). A driver swap keeps the fields only for the same conversation in
  scope; when the pane writes another conversation or has left `RAROG_HERDR_ROOTS`, the manager removes them before
  the broadcast, together with the artifacts (`artifacts.md`).
- **App** (iPad session inspector, `design.md`, "Session inspector"): a "Pull requests" section between Artifacts and
  Changes, only when the list is not empty. Rows in server order, deduplicated by URL (`PullRequestRows` in
  `RarogUI/Model/InspectorSections.swift`): the title or `owner/repo#n`, then `owner/repo#n`, how long ago and the
  time, after a label with the state word on GitHub's state colour when the server sent one. Open, draft and
  unknown-state PRs stay in view; merged and closed ones fold under one "Merged and Closed (N)" row at the end of
  the section (`PullRequestRows.split`), folded by default, and a tap unfolds them. Switching to another session
  or closing the panel folds them again. A row is a link only when its URL is in the server's grammar; the tap hands
  the URL to the system. iPhone, iPad at compact width,
  a Claude session in a Rarog terminal and Codex have no inspector, so no section.
- **Demo server** (`pnpm run demo:server`): the `pull-requests` scenario (`server/src/demo/scenarios.ts`) links three
  PRs through `pr-link` entries read by the production rule (`demoPullRequests`): a titled one that is `merged`, one
  without a title and without a state, and one that is a `draft`; the titles and states come from the demo's fixed
  GitHub.

## Contract and version compatibility

- **Field** `SessionSummary.pullRequests?: SessionPullRequest[]` (`shared/src/protocol.ts`), item `url`, `repo`
  (`owner/name`), `number`, `createdAt` (ISO), an optional `title` and an optional `state` (`open`, `draft`,
  `merged`, `closed`); newest first, at most 20. A missing list means no shown PRs or nothing read; an empty list
  does not travel. A missing `state` means the state is unknown ("State on GitHub", "No state"). Both fields are
  additive: `PROTOCOL_VERSION` does not change.
- **The frame schema** rejects the whole frame on a wrong type (`pullRequests: null`, an item without a required
  field, `state: null` or a number). It does not check the URL grammar: the app opens only a URL in the grammar.
  An unknown `state` string drops only that field on the client (`DEGRADATIONS['pullRequests.state']`).
- **Golden frames:** the list in `session-changed.max.json` and `sessions-snapshot.max.json` (items with a title and
  without, one per state and one without a state); `session-changed.unknown-pull-request-state.json` (degraded),
  `session-changed.null-pull-request-state.json` and `session-changed.numeric-pull-request-state.json` (rejected).
- **Swift** (`RarogContract`): `SessionPullRequest` with `PullRequestState`, and the field in `SessionSummary`.
- **The on-disk list cache** of the app does not keep PRs (`SnapshotCacheFile.scrub`): the title is text from
  GitHub and the URL names the repository, also a private one. After a cold start without network the PRs come
  with the first frame.
- **Compatibility.** A newer app with an older server gets no field. An older app with a newer server skips the
  unknown field (decoder without `allKeys`). An app that does not know the `draft` state drops the field and shows
  the row without a state.

## Known gaps

- **The list needs `gh` and a login.** Without `gh` in one of the five directories, without a `gh` login, offline,
  during a failure pause (up to 30 min after an error, up to 1 h at GitHub's rate limit) and after a Rarog restart
  until GitHub's first answer (which needs a connected app), the list is empty.
- **A PR created by a subagent or a workflow agent** is on the list only when Claude Code writes its `pr-link`
  entry in the main file. Unmeasured: no conversation with a PR created by a subagent was available to check it.
- **Claude Code before 2.1.296** writes no `pr-link` entry (none seen on older CLI versions), so its conversations
  have no PRs.
- **Clock skew.** The window is the time of the conversation's first entry on the Mac's clock, the creation time is
  GitHub's. A Mac clock ahead of GitHub can hide a PR created in the first moments of a conversation.
- **`gh auth switch`** changes the login the verdict compares with, so the list of every conversation changes. Rarog
  notices it at the next GitHub read, not at the switch. That read comes with a newly linked PR, the refresh of a
  shown PR that is not merged, or a restart; while none comes (every linked PR verified, every shown PR merged or
  none shown), the lists keep the verdicts of the old login.
- **More than 100 newer linked URLs** in one conversation push an older one out of the linked set, and with it off
  the list.
- **A PR of the user from another conversation** that this conversation edits, comments on or pushes to after its
  first entry is on this conversation's list when GitHub's creation time is after that first entry, so it can show
  in two conversations. Two parallel conversations of the user can both list the same PR; Rarog does not tell which
  one created it.
- **No checks or reviews:** the state is only `open`, `draft`, `merged` or `closed`.
- **GitHub Enterprise** hosts other than `github.com` are not recognized, and GitHub is asked only about
  `github.com`.
