# Session scheduled tasks

A session scheduled task is a cron a Claude Code session armed with the `CronCreate` tool: a prompt the session runs
by itself at a set time, once or on a schedule. This document covers how Rarog builds a session's list of armed tasks and
how it reaches the app.

**In short.** Rarog reads the session's main conversation file and keeps the tasks that are armed now. The list
belongs to the conversation: after `/clear` it is the list of the new file, and after a Rarog restart it is rebuilt
from the whole file. The server sends it in the session summary (`SessionSummary.scheduledTasks`). Code:
`server/src/herdr/background/scheduled-tasks.ts` (recognition, pure), `scheduled-task-file.ts` (reading) and
`server/src/drivers/herdr/scheduled-task-poll.ts` (when to read, the payout).

## What is shown

One entry per armed task, newest `createdAt` first, at most 50 (the per-session limit in the Claude Code docs,
"scheduled-tasks"):

- `id`, the job id from `CronCreate`;
- `cron`, the five-field pattern in the Mac's local time, as the session wrote it;
- `recurring`; `false` means one run at the next match of the pattern;
- `prompt`, on one line, without control characters, at most 120 UTF-16 units;
- `createdAt`, `nextFireAt`, `lastFiredAt` (a recurring task that ran) and `expiresAt` (a recurring task with a known
  `createdAt`: `createdAt` plus 7 days, per the Claude Code docs), each when known.

## Where it comes from

The main file `<uuid>.jsonl` in the Claude Code store, the same file the transcript follower reads. Shapes measured
on CLI 2.1.329 (fixtures `server/test/fixtures/herdr/scheduled/measured/`):

- **Create:** a `CronCreate` call paired by tool use id with a result without an error. The prompt and the pattern
  come from the call; `recurring` and `nextFireAt` from the result.
- **Delete:** a `CronDelete` result removes the task.
- **Snapshot:** a `CronList` result removes known tasks it lacks and updates `nextFireAt` of the others. It never
  adds a task, because it also lists a pending `ScheduleWakeup` without a mark.
- **Run:** the `scheduled_task_fire` line removes a one-shot task; a recurring one gets `lastFiredAt` and loses its
  stale `nextFireAt`.
- **Carry:** the `session_cron_carry` attachment (after `/compact`, at the start of a file after `/clear`, after
  "Exit and stop tasks") replaces the list with the carried tasks, minus the ended ones.
- **Process start:** a one-shot task due before the current Claude Code process started and never run is gone: a
  resumed process does not restore it (measured on CLI 2.1.329). The start comes from the CLI process registry.

Only `assistant`, `user`, `system` and attachment entries count, never a subagent's. A cheap prefilter on the raw line
skips `JSON.parse` for lines that cannot change the list.

## Reading and life of the list

- The reader reads the file incrementally from byte zero, at most 256 MiB per read; the rest waits for the next read
  after a one-second pause. A read after the main file grows waits up to 5 seconds, and signals in that window fold into one.
- A file shorter than the read offset or with another inode is read again from zero, and the list is rebuilt. After
  a read that reached the end, the next one follows after 5 seconds also without a signal: a file swapped for another
  of the same size does not grow, so nothing else would wake the reader.
- An empty file, also one truncated to zero, gives an empty list. A file the transcript follower no longer finds
  gives an empty list too, and a file that appears again is read from zero.
- Only a read that reached the end of the file without an error pays the list out. A read error orders the next read
  by itself after 5 seconds, without waiting for the file to grow.
- The first list after the driver attaches goes out also when empty: a task deleted or run while Rarog had no contact
  with herdr must leave the card. After it, a list goes out only when it changes.
- A conversation change (`/clear`, `/resume`) drops the list from the card; the new conversation's first list follows,
  also when empty. A read of the previous conversation that ends late hands out nothing.
- A closed pane drops the list before its card goes out, because the tasks live in the Claude Code process that ended
  with it (also the old process of a session restart). A lost connection to herdr keeps the list: the process may
  still run.
- A pane out of scope and Codex have no list.

## Path to the app

The driver event `scheduled-tasks` carries the whole list to the manager, which sets the card field: an empty list
clears it and an empty array never travels. The app's list cache on the phone drops the field before it writes to
disk (`security-model.md`, "Native client: what is stored on the iPad"). The app shows the list in the session
inspector's Scheduled Tasks section (`design.md`, "Session inspector (iPad)") and as a clock at the end of
the session's list row (`design.md`, "Native app list: project tree").

The demo server (`pnpm run demo:server`) has a `scheduled-tasks` scenario (`server/src/demo/scenarios.ts`): a one-shot
task due in 40 minutes and a recurring one every 30 minutes that ran 10 minutes ago, built from conversation entries
by the same tracker (`demoScheduledTasks` in `server/src/demo/seeds.ts`).

## Not shown

- `ScheduleWakeup` wakeups: their call has no id, and their run carries `taskKind: "loop"` (measured on CLI 2.1.329).
- Subagents' crons.
- The next run of a recurring task after its first run: no line carries it except a new `CronList`, and computing
  it needs a cron evaluator.
- Tasks of a Claude Code process that ended without a dialog: the file does not say they stopped (measured on
  CLI 2.1.329); they come back when the conversation is resumed.
