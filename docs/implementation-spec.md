# Implementation spec

This document is the contract between the Rarog server and its client, and between the server's modules: the SSE
protocol, the HTTP routes, the terminal socket frames, the APNs frames, the golden contract files in
`shared/fixtures/`, and the internal interfaces (state machine, driver, manager). The sources of truth are the files
it names: `shared/src/protocol.ts` (SSE frames and most schemas; area schemas such as terminal, notes, diff, model
and attachments live in `shared/src/protocol/` and `protocol.ts` re-exports them), `shared/src/rest.ts` (REST
responses and request bodies), `server/src/drivers/types.ts` and `server/src/sessions/manager-api.ts`. Code blocks
below are skeletons; the full definitions and field comments live in those files, and where a field list would
repeat a schema, this document gives the rule and points to the schema.

The only client is the native iOS and iPadOS app (`native/Rarog`). Stack and transport:
[architecture.md](architecture.md); a short map of directories: `docs/architecture.md`, "Repository layout"; tokens
and app copy: [design.md](design.md). Environment variables, flags and killswitches are described in full in
`docs/server-config.md`, "Server environment: variables and flags"; this document names only the ones a contract
depends on.

## Environment and hard rules

- Node ≥ 22.15, in the 23 line ≥ 23.11 (`engines`: `>=22.15 <23 || >=23.11`; CI tests the lines 22, 24 and 26), and
  **pnpm 11.4** (`packageManager`: `pnpm@11.4.0`); exact package versions are pinned in the `package.json` files. The
  server listens on **127.0.0.1** only (a fixed bind; any other `RAROG_HOST` is a `ConfigError`), on `RAROG_PORT`,
  default **8930**.
- Workspaces come from `pnpm-workspace.yaml` (packages `shared` and `server`). The push relay (`relay/`, the Worker
  that forwards push notifications to APNs) and the iroh relay registry (`relay-auth/`) are separate projects with
  their own `package.json` and lockfile; `relay-auth/` imports shared modules from `relay/src/`, and its model test
  takes `fast-check` from the root install, so it needs the root install and both projects installed.
- `.npmrc` sets `ignore-scripts=true`, and `allowBuilds` lets no package run an install script.
- From `@anthropic-ai/claude-agent-sdk` the server imports only `listSessions()`. The install is thin (one package
  without optional and peer dependencies; reasons in the comments of `pnpm-workspace.yaml`), and the package is the
  only exception to the release age rule (`minimumReleaseAgeExclude`).
- `.md` files are hard-wrapped at about 120 characters. Code is strict TypeScript. Tests run on vitest with one config
  at the root (`vitest.config.ts`), files in `<package>/test/*.test.ts`.

## Protocol contract (`shared/src/protocol.ts`)

`PROTOCOL_VERSION` grows only with a change that BREAKS an existing client; its value is **3** (a decision can come
back as 422 with a `reason`, and the user echo carries `attachments[]` descriptors instead of `image` blocks with a
`dataUrl`). An additive field does not bump the version, because a decoder drops a key it does not know. Every
variant has a zod schema, and `parseServerEvent(json)` returns `null` for an unknown `type` (the client logs and
ignores it).

```ts
export const PROTOCOL_VERSION = 3;

export type SessionState =
  | 'starting' | 'running' | 'waiting-input' | 'waiting-permission' | 'waiting-question'
  | 'limit-reached' | 'error' | 'interrupted' | 'done' | 'resumable';

export interface SessionSummary {
  id: string;              // rarogId (uuid), the key everywhere; engineSessionId stays on the server
  cwd: string; title: string;           // title = basename(cwd)
  state: SessionState; stateDetail?: string;
  stateSince: string;      // ISO, start of the current state (the "waiting for" timers)
  turnSince?: string;      // ISO, start of the current turn (the turn clock of the activity row)
  createdAt: string; lastActivityAt: string;
  branch?: string; dirtyCount?: number; lastSummary?: string;
  // …plus optional fields described below and in protocol.ts: label, ahead/behind, fileKinds, lastCommit,
  // context, model, effort, ultracode, seen, herdr*, activity, backgroundTasks, artifacts, pullRequests,
  // scheduledTasks, waitingFor…
}

export type ServerEvent =
  | { type: 'hello'; protocolVersion: number; serverStartId: string; minClientBuild?: number; heartbeatMs?: number }
  | { type: 'sessions-snapshot'; sessions: SessionSummary[]; herdrStatus?: HerdrStatus; notesCwds?: string[] }
  | { type: 'session-changed'; session: SessionSummary }
  | { type: 'transcript-snapshot'; sessionId: string; messages: TranscriptMessage[];
      pendingPermissions: PermissionRequest[]; pendingQuestions: QuestionRequest[]; activity?: Activity }
  | { type: 'message'; sessionId: string; message: TranscriptMessage }
  | { type: 'delta'; sessionId: string; text: string }
  | ({ type: 'activity'; sessionId: string } & Activity)
  | { type: 'permission-pending'; request: PermissionRequest }
  | { type: 'permission-resolved'; sessionId: string; permId: string;
      decision: 'allow' | 'allow-always' | 'deny' | 'expired'; by: string }
  | { type: 'permission-settled'; sessionId: string; permId: string; state: ConsentCardState;
      canAllow: boolean; unavailable?: ConsentUnavailableReason; dialogVisible?: boolean; at: string }
  | { type: 'question-pending'; request: QuestionRequest }
  | { type: 'question-resolved'; sessionId: string; qId: string }
  | { type: 'state'; sessionId: string; state: SessionState; detail?: string; since: string }
  | { type: 'git-status'; sessionId: string; branch: string; dirtyCount: number; files: string[];
      ahead?: number; behind?: number; fileKinds?: GitFileKinds; lastCommit?: GitCommit;
      fileDetails?: GitFileDetail[] }
  | { type: 'usage'; sessionId: string; contextTokens: number; contextLimit: number }
  | { type: 'herdr-status'; available: boolean; agentCount: number; readOnly: boolean;
      canLaunch?: boolean; detail?: string }
  | { type: 'notes'; cwd: string; empty: boolean }
  | { type: 'inbox-heads'; heads: InboxHead[] }
  | { type: 'inbox-head'; head: InboxHead }
  | { type: 'inbox-removed'; sessionId: string; turnId: string };
```

The message and card types (field comments in `protocol.ts`):

- **`Block`:** `text`; `tool-call` with `toolName`, `summary`, `detail?`, `detailKind?`, `delegation?` and
  `inputKind?` (`detailKind: 'diff'` = `detail` is a ready mini-diff of `+`/`-`/` ` lines; without it, raw input
  text); `image` with `dataUrl` and `alt?` (an image the engine echoed back).
- **`TranscriptMessage`:** `seq`, `role` (`user`, `assistant`, `system`), `blocks`, `at`, and the optional
  `attachments`, `clientMessageId` (only in the echo of a send that carried one), `notice` and `promptBlocked`.
  `MessageAttachment` is a descriptor, never bytes: `{kind: 'image' | 'file', name, bytes, mime, file?}`, where `file`
  is the photo's name in `.rarog-uploads/` (the thumbnail key).
- **`PermissionRequest`:** `permId`, `sessionId`, `toolName`, `displayText` (the full command or input description),
  `risk` (`normal` or `red`), `cwd`, `createdAt`, and the optional `canAllow`, `alwaysLabel`, `subject`, `inputKind`.
  A consent channel card (`channel: 'hook'`) also carries `state`, `unavailable`, `dialogVisible`,
  `siblingsDenied`, `fields`, `notes` and `always` (below). A screen card with `canAllow: false` may carry
  `unavailable` too: the channel values `no-channel`, `terminal-only`, `truncated`, `hidden-chars` or a screen value
  `settings-changed`, `other-hook`, `unverified-hooks` (`SCREEN_UNAVAILABLE_REASONS`, which only a card without
  `channel` carries; the rule is in `docs/dialogs.md`, "What stays in the terminal in `all`"). A degraded screen card
  (no input to show) has no field, and the app keeps its "deny only" sentence.
- **Consent channel card (`channel: 'hook'`).** The answer goes as a signed file to the sleeping `PermissionRequest`
  hook, not as a key to the pane. `permId` is the hook's fixed key: a new card with the same `permId` REPLACES the
  previous one, and `permission-settled` changes `state`, `canAllow`, `unavailable` and `dialogVisible` in place. A
  client without a card of that `permId` ignores `permission-settled`, so a late change never brings back a removed
  card. The card disappears only with `permission-resolved`: at `running` (the hook claimed the answer and the
  dialog is gone; `allow` or `deny` is the decision the hook claimed, `expired` without one), at `unknown` of a card
  no device answered (`expired`: the call ended without the phone's answer) or in a final state
  (`applied` → `allow` or `deny`; `settled-at-desk` with the desk key's decision read from the transcript → `allow`,
  `allow-always` or `deny` with `by: "terminal"`; any other final state → `expired`). At `running`, `allow` means
  "the answer went to the hook", not "the tool ran"; after it no change of that card reaches the client. `state` is `pending`, `sent`,
  `claimed`, `running`, `applied`, `settled-at-desk`, `unknown`, `revoked` or `released` (the server's internal
  `deciding` goes as `sent` with `canAllow: false`).
  `unavailable` is the first reason the phone cannot allow the card: `no-channel`, `truncated`, `no-content`,
  `card-mismatch`, `key-blocked`, `hook-dead`, `no-proof`, `server-restart`, `terminal-only`, `hidden-chars` (the
  shown input or the working directory has a character that does not show on the card: a text direction mark, a zero-width character or
  a control character). `displayText` shows the whole input: for `Bash` the command (`inputKind: 'shell'`) and every
  other input field in `fields` (`{name, value}`, in a fixed order); `notes: ['sandbox-disabled']` marks
  `dangerouslyDisableSandbox: true`. Without a presentation (the input does not fit or cannot be shown)
  `displayText` is the sentence `dialogs.consent.not-shown` and `canAllow` is `false`. `siblingsDenied` counts the
  sibling requests from the same model message that were denied with this card. `always` (only next to the approve
  button) lists the updates of the "always" option, `{kind, value, destination}`: `kind` `rule` (`Tool` or
  `Tool(content)`), `mode` or `directory`, the literal `value`, `destination` `session` or `localSettings`; the
  decision `allow-always` on a card without it is 422 `allow-always` (`docs/dialogs.md`, "Always option"). An unknown
  `kind` or `destination` rejects the frame. The frames come from `server/src/herdr/dialogs/layer1/frames.ts`.
- **`QuestionRequest`:** `qId`, `sessionId`, `questions`, `createdAt`, the optional `channel` (`hook` or `keys`: how
  Rarog delivers the answer; the client does not decide by it) and `customAnswer`. A `Question` has `question`,
  `header`, `multiSelect`, `options`, `notes?` and `review?`; a `QuestionOption` has `label`, `description?`,
  `terminalOnly?`, `role?` and `preview?`.

Four frames are VOLATILE (`seq: null`, outside the ring buffer, no replay after a reconnect): `delta`, `activity`,
`herdr-status` and `notes`. Their start state rides in the snapshots (`sessions-snapshot.herdrStatus`,
`sessions-snapshot.notesCwds`, `transcript-snapshot.activity`), because iOS drops the SSE stream at every sleep. The
three Inbox frames are volatile too and go only to a stream that asks for them ("Inbox"). The
stream carries no push channel state: the app reads it per token from `POST /api/push/apns/status`.

**Turn start and activity age** (`server/src/sessions/activity-clocks.ts`). `SessionSummary.turnSince` is the start
of the current turn: set when the session enters a turn state (`starting`, `running`, `waiting-permission`,
`waiting-question`) from outside one, kept through permission and question inside the turn, gone when the turn ends,
while `stateSince` restarts at every state change. A session first seen inside a turn (a pane adopted mid-turn, a
pane Rarog starts) gets the field at its first move inside the turn, with the start of the state it leaves; until
then a client counts from `stateSince`, the same moment. A history read that moves `stateSince` back to the last
line of the file also moves `turnSince` back to that line when it stood after it. The activity a session holds
(`SessionSummary.activity`, `transcript-snapshot.activity`) carries in `elapsedSeconds` its own value plus the whole
seconds since the server set it, computed when the frame is built, so a client that reconnects keeps the tool and
quiet clocks; under a second the activity goes as it was set. The live `activity` frame carries no age.

**Native client build threshold (`hello.minClientBuild`).** Optional and additive: a safe integer 1…2^53−1 from
`RAROG_MIN_CLIENT_BUILD`. A missing or empty variable means 5614 in a package install and no field and no threshold in
a clone or in demo; a bad value is a `ConfigError` at start, and the schema rejects a `hello` with a value out of range
or `null`. The meaning is a contract for the native client (build from the User-Agent `RarogApp/<build>`): a build
below the threshold reads, does not mutate and asks for an update; a new `hello` with another threshold applies at
once. In the app `Compatibility.evaluate` (`RarogCore/Compatibility.swift`) computes this, and a different
`protocolVersion` wins over the threshold. The field is a client convenience, not a permission boundary: the server
does not refuse mutations by build.

**Heartbeat interval (`hello.heartbeatMs`).** Optional and additive: the interval of the stream ping in ms. The
schema takes any positive integer and rejects a `hello` with `0`, a negative value or `null`. A value outside
1000…60000 (`HELLO_HEARTBEAT_MS` in `shared/src/protocol.ts`) means the same as no field, so a server with another
interval never costs a client its `hello` and the compatibility check in it; in the app `HelloEvent.validHeartbeatMs`
applies the range. The server sends `HEARTBEAT_MS` (10 000) and omits the field when the heartbeat is off (`0`) or
its interval is outside the range. The interval applies to every stream, global and session, though only the global
stream carries `hello`. The native app ends a stream, global or session, that got no byte for 1.5 × the
`heartbeatMs` of the last global `hello` (15 s at 10 000), 60 s without a valid field, counted from the request or
the last body byte, never from the last frame, and reconnects as after a drop; a stream counts as connected from its
first body byte (`retry:`), not from the headers (`StreamStallGuard` in `RarogTransport/StreamStallGuard.swift`,
`StreamSupervisor` in `RarogCore/StreamSupervisor.swift`).

**Harness notices (`TranscriptMessage.notice`).** Claude Code inserts an entry with role `user` when a background
task ends; nobody typed it. The server recognizes it by the ORIGIN of the jsonl entry, `origin.kind ===
'task-notification'`, never by the text (an entry without `origin` stays raw text). `noticeFromText`
(`server/src/herdr/background/notice.ts`) computes `kind` (`command`, `agent`, `workflow`, `monitor-end`,
`monitor-event`, `orphan`, `artifact-watch`, else `unknown`), `outcome` (`done`, `failed`, `halted`, `waiting`; absent
does NOT mean success), `name` (≤ 80 characters) and `exitCode`. The classification lives in `parseImportLine`, so
the live follower (the reader that follows the end of the transcript file) and the history give the same result.
`role` and `blocks` stay unchanged, so a client that does not know the field shows an ordinary message.

**Effective role rule:** a message with `notice` is not a prompt. It takes no part in the echo, the last prompt, the
turn quote, the text returned after Esc or the Resume list: the follower does not settle a send echo with it, the
import does not attach Rarog photos to it, and the Resume list takes the first prompt from the SDK
(`listSessions`), not from these messages. The app draws the notice as a sentence built from the field's facts (`UICopy.harnessNotice`).

**The `waiting` outcome (subagent standby).** Only for kind `agent`: the subagent stopped and waits for its own
background task; it is neither an end nor a result. The task notification of a standby has status `completed`, so
`noticeFromText` gives `waiting` when the `<note>` postscript carries the standby phrase ("background work of its own
still running"); `isAgentStandby` in `herdr/background/notification.ts` judges the same for the task reducer
(`background-tasks.md`, "Notice in the transcript"). A turn whose only `user` messages since the previous turn end
were `waiting` notices does not arm the `done` push (the notification at the end of a turn with a result), unless the
previous ordinary `done` is overdue and no subagent in standby has open `ownTasks` (`noResultTurn` and `leavesResult`
in `notify/policy.ts`; `background-tasks.md`, "Standby-only turn"). The app shows a calm sentence for it and skips it
in the Recently finished list of the inspector (the right-hand session panel). For any other kind the value reads like
a missing outcome. Golden frames: `message.notice-waiting.json`, `transcript-snapshot.notice-waiting.json`.

**The `artifact-watch` kind.** A task notification with `<task-type>` `artifact-watch-lifecycle` (artifact deleted,
made public outside the organization, or account changed), taken only from the notification header. `name` is the
artifact title when the summary quotes one; `outcome` and `exitCode` never appear. A decoder that does not know the
value reads `unknown`. The app draws a quiet line about the end of the watch and does not count it in Recently
finished. A turn with only such notices and no tool call of the main agent does not arm the `done` push
(`noResultTurn`). Golden frame: `message.notice-artifact-watch.json`; description: `artifacts.md`.

**Background tasks (`SessionSummary.backgroundTasks`).** Optional: the tasks the session runs in the background; the
server never sends an empty list. Where the list comes from and when an entry leaves it: `background-tasks.md`.

```ts
export interface BackgroundTask {
  id: string;                                 // non-empty; the key for dedup and closing
  kind: 'command' | 'agent' | 'workflow' | 'monitor';
  description?: string; command?: string;     // command: the `Bash` text, ≤ 1000 UTF-16 units
  agentType?: string; model?: string; summary?: string;   // summary ≤ 120 UTF-16 units
  startedAt?: string;                         // ISO; absent = the start was not seen
  runId?: string; run?: WorkflowRun;          // workflow only: run directory and its layout
  waitingSince?: string;                      // agent only, ISO: since when it waits for its own task
  ownTasks?: AgentOwnTask[];                  // agent only: its open background commands
}
export interface AgentOwnTask { id: string; command?: string; startedAt?: string }
```

- **`waitingSince`:** set to the `timestamp` of the first standby notification and moved by the next one; a resume of
  the agent clears it, and so does a newer entry in the subagent file `subagents/agent-<id>.jsonl`, which the server
  reads every 5 s (so the field can outlive the agent's wake by one tick).
- **`ownTasks`:** the background commands the subagent started (from its own file) whose end the server does not
  know; at most 20, the newest, in start order. A command started before the moment from which the server knows the
  main file is left out, so a missing field does not mean the agent waits for nothing.
- `RAROG_AGENT_FILES=0` switches the subagent file reads off: only a resume clears `waitingSince`, and `ownTasks` is
  absent. Neither field is an enum, so `null` or a wrong type rejects the frame. The app does not count a subagent with
  `waitingSince` as work (`background-tasks.md`, "What counts as work"), and its disk cache drops
  `ownTasks[].command`.

**Session artifacts (`SessionSummary.artifacts`).** Optional: the claude.ai pages the Claude session published in the
current conversation, newest first, at most 20; never an empty list. Item: `{url, title, publishedAt, gone?: true}`
(`url` exactly `https://claude.ai/artifact/<id>`, `title` ≤ 120 UTF-16 units). A missing field means no artifacts or
no reading (Codex, a pane outside `RAROG_HERDR_ROOTS`). `artifacts: null`, an item without a required field and
`gone: false` reject the frame. The schema checks the address type, not its grammar; the app opens only an address
in the server's grammar. A list change sends `session-changed` without a
state transition or a push. Rules: `artifacts.md`; the inspector section: `artifacts.md`, "What the app shows".

**Session pull requests (`SessionSummary.pullRequests`).** Optional: the GitHub PRs that `gh pr create` created in
the current conversation (main agent, subagents, workflow agents), newest first, at most 20; never an empty list.
Item: `{url, repo, number, createdAt, title?, state?}` (`url` exactly
`https://github.com/<owner>/<repo>/pull/<number>`, `repo` is `<owner>/<repo>`, `title` ≤ 120 UTF-16 units, `state`
one of `'open' | 'draft' | 'merged' | 'closed'`). A missing list means no PRs or no reading (Codex, a pane outside
`RAROG_HERDR_ROOTS`); a missing `state` means the state is unknown. `pullRequests: null`, an item without a required
field, and `state: null` or a non-string `state` reject the frame. An unknown `state` string drops only that field on
the client (`DEGRADATIONS['pullRequests.state']`); the strict schema rejects it. The schema checks the address type,
not its grammar. A list change sends `session-changed` without a state transition or a push. Rules:
`pull-requests.md`.

**Session scheduled tasks (`SessionSummary.scheduledTasks`).** Optional: the crons the current conversation has armed
now, newest `createdAt` first, at most 50; never an empty list. Item: `{id, cron, recurring, prompt, createdAt?,
nextFireAt?, lastFiredAt?, expiresAt?}` (times ISO, `cron` five fields in the Mac's local time, `prompt` one line of
at most 120 UTF-16 units). A missing list means no tasks or no reading (Codex, a pane outside `RAROG_HERDR_ROOTS`).
`scheduledTasks: null`, an item without a required field and a non-boolean `recurring` reject the frame. A list
change sends `session-changed` without a state transition or a push. Rules: `scheduled-tasks.md`.

**Semantic fields.** The server computes presentation facts from its knowledge of the CLI, so the client never
decides by tool names, answer channel or English option texts. All are optional in the schema, and the server always
sends them where the field exists; `toolName` and `channel` stay on the wire next to them:

- `subject` (`'tool' | 'plan'`) on `PermissionRequest` and `WaitingFor`: `plan` for `ExitPlanMode`
  (`permissionSubject()` in the manager).
- `delegation` (`'agents' | 'workflow'`) on `Activity` and on a `tool-call` block, and the block's `inputKind`
  (`'shell' | 'json'`): `toolCallSemantics()` in `server/src/drivers/tool-text.ts`.
- `PermissionRequest.inputKind` is the exception to "always": only `'shell'`, and only when the input's string
  `command` equals `displayText` exactly (`permissionSemantics()`); the app syntax-colors that command.
- `QuestionRequest.customAnswer` = `channel === 'hook'`, because free text travels by file.
- `QuestionOption.role` (`'answer' | 'custom' | 'exit'`) from `optionRole()` in `herdr/dialogs/cards/roles.ts` for
  options from the screen (patterns in `SCREEN_SIGNATURES`, measured on CLI 2.1.285); options from a payload are
  `answer`.
- `QuestionOption.preview`: only from the author's payload (hook or `tool_use`), never from the screen; the manager
  clips a copy (`clipQuestionPreviews`: 4000 UTF-16 units per option, 12 000 per frame, last line `✂ …`).
- `Question.notes`: `true` only on the `hook` channel, for a single-choice question with a preview, and with a Claude
  Code release ≥ `CLI_NOTES_MIN_VERSION` (2.1.288, measured) (`withQuestionNotes`).
- `Question.review`: the pairs of a "Review your answers" screen, built by `reviewPairsFrom`
  (`herdr/dialogs/screen/review.ts`); an incomplete pair means no field.

A missing field gives the cautious variant with no fallback to names or texts. In the app `SourceGuardTests` enforces
that Swift code knows no tool names or CLI texts outside the copy dictionary `ToolActivity.swift`.

**`Activity`:** `kind` (`'thinking' | 'tool' | 'waiting' | 'idle'`), `toolName?`, `summary?`, `description?`,
`elapsedSeconds?`, `agents?` (subagents in flight, a NUMBER; the client builds the sentence), `agentsDone?`,
`workflow?`, `delegation?` and `phases?: {title, agents, done}[]` (the run plan from the script). The client computes
the progress bar. `description` is the `description` field of the tool input, trimmed and cut like `summary` (120
characters, at a character boundary), sent for `Bash` only: in an MCP tool the field of that name is often the data
the call writes. An empty or whitespace-only one is no field.

**Activity from the transcript tail** (`server/src/herdr/jsonl-activity.ts`, live tail only; the history read at
attach sends none). Open tool calls are the follower's pending tracker, paired by `tool_use.id`, reset with it on a
file truncation, a read gap and a new conversation. The row shows the most recently opened call that is still open:

- a `tool_use` → `tool` with its `summary` and `description`;
- the result of that call with nothing left open → `{kind: 'thinking'}`;
- the result of that call with calls left open → `tool` of the most recently opened one, with its own fields;
- the result of another call, of an unknown id, or a human message that closes the calls → nothing;
- one activity per batch, the last one, so a `tool_use` and its result read together give only `thinking`.

The session directory pulse sends its generic `thinking` only while the follower has no open call; its delegation
row (`agents > 0`) does not wait for that, because a delegating call stays open while its subagents work.

**Request bodies** (schemas in `protocol.ts` and `shared/src/rest.ts`; each item names its rule):

- `CreateSessionBody {cwd, prompt?, permissionMode?, model?, effort?, resumeFrom?, fork?, ultracode?}`: `resumeFrom`
  matches `ENGINE_SESSION_ID_RE`, `fork` requires `resumeFrom`, `ultracode` only `true` and only with `effort` absent
  or `xhigh`.
- `MessageBody {text, images?, files?, clientMessageId?, queueAware?, source?, expectedConversation?}`: see
  "Idempotent send" and "Queued echo". `source` takes only `voice-agent`; `expectedConversation` is a conversation
  token of the voice agent's mode across sessions, 1–64 characters (`docs/companion.md`, "Sending from the
  conversation").
- `PermissionDecisionBody {decision: 'allow' | 'allow-always' | 'deny', message?}`.
- `AnswersBody {answers: string[][], notes?: (string | null)[]}`: one array per question. On `channel: 'keys'`
  exactly one value, and it must be an option label (a digit types nothing else); on `channel: 'hook'` any text,
  because the file goes to `updatedInput.answers` and the CLI does not compare it with the labels (measured). A value
  is capped at `MAX_ANSWER_TEXT_CHARS` (2000) in the schema, the manager and the hook. A non-empty note is allowed only
  for a question with `notes: true` and an answer that is one ordinary option, up to `MAX_ANSWER_NOTE_CHARS` (8192);
  answers and notes together are capped at `MAX_ANSWERS_TOTAL_CHARS` (32768). The note travels only in the hook file
  (`updatedInput.annotations`); when the file cannot be delivered, the answer ends with 422 `send-failed`.
- `ClientLogBody {events: {at, level, msg}[]}`.

**Tolerant decoder (`shared/src/decode.ts`, export `@rarog/shared/decode`).** The schemas stay strict; tolerance is
client policy in `decodeServerEvent(json) → {event, degradations} | null`. An unknown STRING in an enum field degrades
that field and the rest of the frame stays; `null`, a missing required field, a wrong type, an unknown non-string
value, a broken known block and an unknown frame `type` still give `null`. The fallbacks are the `DEGRADATIONS` list
in the module: the client-only sentinel `'unsupported'` (`state`, `effort`, `engine`, `context.source`,
`backgroundTasks[].kind`, `permission-resolved.decision`, the consent card's `state`, `unavailable` and each of its
`notes`, also in `permission-settled`), an existing protocol value (`herdrMode` → `'unknown'`,
`role` → `'system'`, `attachments[].kind` → `'file'`, `risk` → `'red'`, `fileDetails[].kind` → `'modified'`,
`subject` → `'tool'`, `delegation` → `'agents'`, option `role` → `'answer'`, `notice.kind` → `'unknown'`), a dropped
field (`herdrDialog`, `herdrDialogReason`, `cliDialog`, `detailKind`, `channel`, `inputKind`, `notice.outcome`,
`pullRequests[].state`), a dropped object (`context`, `waitingFor`, `activity`; a volatile `activity` frame gives
`null`) and the placeholder block `{type: 'unsupported'}`. `degradations` names each degraded field by JSON Pointer
with the unknown value and is empty only for a frame that passed the strict contract.

No TypeScript client imports the decoder: it is the reference for the app's own decoder (`EventDecoder` and
`Degradation` in `RarogContract`; `DegradationTableTests` compares the tables). Every degradation and rejected frame
gives one deduplicated line in `client.log` (`ContractReporter` in `RarogCore`, cap 50 lines). The app sends no
mutation for a session whose state is `unsupported` (`MutationGate`, rule `MutationRules.sessionRefusal`).

**Golden SSE frames (`shared/fixtures/sse/`, `manifest.json`).** A file is exactly the `data:` field of one frame,
named `<type>.<case>.json`. `ok` frames are produced by server code in `server/test/sse-fixtures-producenci.test.ts`
(manager over demo seeds and a fake herdr supervisor, transcript import from synthetic jsonl, the session directory
pulse, `SseHub`), checked with the strict `parseServerEvent`; `RAROG_FIXTURES_WRITE=1` rewrites them. The manifest
maps each file to an expectation:

- `ok`: decoded unchanged with no degradations; the optional `strip` names future keys the decoder must drop.
- `degraded`: `base` plus `patch` (an unknown enum string) decodes to the input plus `result`, and `degrades` names the
  `DEGRADATIONS` items it exercises.
- `ignored`: the decoder returns `null` (`"raw": true` = the file holds the raw `data:` text). These frames cover the
  whole rejection matrix of `shared/test/decode.test.ts`, so a client in another language does not guess the boundary.

`shared/test/sse-fixtures.test.ts` imports nothing from `server/` and enforces: manifest and directory match; each of
the 20 types has `<type>.max.json`; each `DEGRADATIONS` item has a `degraded` frame; and every schema path (from
`z.toJSONSchema(serverEventSchema)`, with one path per discriminated variant) occurs in some `ok` frame, so a new field
without golden frames fails `pnpm run check`. `message.unicode` carries Polish letters, emoji outside the BMP and an
escaped U+2028. The app reads the same files in `GoldenFramesTests` (`RarogContract`, the `swift-contract` step): an
`ok` frame must survive a decode and encode round trip.

**Golden REST responses (`shared/src/rest.ts`, `shared/fixtures/rest/`).** REST responses have zod schemas in
`@rarog/shared/rest`, and the router checks itself against them in types (`satisfies`). A file is exactly a response
body; `manifest.json` gives each its `route`, `status` and `schema` (a refusal schema only with status ≥ 400).
`server/test/rest-fixtures-producenci.test.ts` produces them over HTTP from the real router: over the demo manager,
over fakes for restart and the ultracode refusal, over the real device registry and push channel for the APNs routes,
over the real terminal registry with a fake herdr socket, over the real diff collectors with a fake git, and over a
real command scan in a temporary directory. No file is kept by hand (the `FROZEN` set is empty).
`shared/test/rest-fixtures.test.ts` is the mirror, and
`RestFixturesTests` in `RarogContract` decodes every file into the Swift type the schema name points to (a schema
without a Swift type fails `everySchemaHasSwiftType`).

**Native-app route schemas in `@rarog/shared/rest`.** APNs and Live Activity bodies (`apnsRegisterBodySchema`,
`apnsUnregisterBodySchema`, `apnsStatusBodySchema`, `liveActivityRegisterBodySchema`, `liveActivityEndBodySchema`), the
status response `apnsStatusResponseSchema`, the Live Activity state `liveActivityContentStateSchema` (version 2) and
re-exports of the terminal REST schemas. Rules worth stating: the token is hex `APNS_TOKEN_RE`; `topic` follows
`BUNDLE_ID_RE` (the same rule that validates `RAROG_APNS_TOPIC`); `pushFormats` is up to 8 integers; `locKeys` is a
boolean;
`liveActivityEndBodySchema` requires `activityId`, so a late end of a previous activity does not close a new one. The
Live Activity state carries counts, a tap target `top`, up to 2 workflow runs with up to 12 segments, `limits`, `mac`
and `updatedEpoch`; strings are capped at `LIVE_ACTIVITY_TEXT_MAX` = 60 so the payload fits 4 KB, times are integer
epoch seconds, and it has no field for question text, tool, label, summaries, command or `displayText`, because the
activity stays up to 8 h on the lock screen (`shared/test/rest-native-routes.test.ts`). Swift types:
`RequestBodies+Push`, `RestResponses+Push`, `RequestBodies+Terminal`, `RestResponses+Terminal` and
`LiveActivityContentState` in `RarogContract`.

**Golden terminal frames (`shared/fixtures/term/`).** Frames of the socket `/api/term/:id` in both directions and the
input chunking vectors; `manifest.json` gives each file a `kind` (`client`, `server`, `chunk-vectors`). Server frames
come from the real `ws.ts` and registry over a fake herdr (`server/test/term-fixtures-producenci.test.ts`). Client
frames and `chunk-vectors.json` are a frozen specification: a change of the app's chunker changes the file and the
Swift test in one commit. The vectors fix `maxFrameBytes` (8192), `frameOverheadBytes` (17), `maxPasteBytes` (512 kB)
and cases at the caps. Swift side: `TerminalFramesTests` (`RarogContract`) and `TerminalInputChunkerTests`
(`RarogTransport`).

**Golden APNs frames (`shared/fixtures/apns/`, `shared/fixtures/apns-v3/`).** Each file is a full frame the server
sends to APNs, `{headers, payload}`, headers sorted and without the `:path` with the device token. Server code
produces them (`server/test/apns-fixtures-producenci.test.ts`): format 3 banners in `apns-v3/` (permission, a result
for a Codex terminal, test push, device paired) under a test push key of 32 × `0x05` with fixed nonces, frozen format
2 banners in `apns/` as rejection cases, and Live Activity updates and an end (demo seeds, a Codex `termId`, workflow
runs, a subagent in standby, the chime). Frames of an entry with the `locKeys` declaration have `"locKeys": true` in
the manifest (`alert.blocking.loc-keys.v3.json`, `live-activity.update.chime.loc-keys.json`) and differ from their
base frame (the name without `.loc-keys`) only in `aps.alert`. `shared/test/apns-fixtures.test.ts` enforces strict
schemas, a payload ≤ 4096 B, `stale-date` = `timestamp` + 900, an alert only on the chime frames, keys equal to the
relay policy, and decrypts every banner with `node:crypto`.
`ApnsFramesTests` in `RarogContract` decodes the frames with the production `LiveActivityPayload`, `PushEnvelope` and
`PushCrypto`; `LiveActivityInputTests` (`RarogCore`) builds the same start state from the same sessions.

**Banner encryption vectors (`shared/fixtures/push-crypto/`).** `vectors.v3.json` is produced by
`server/test/notify-push-crypto.test.ts` (protocol constants, vectors, and refusals before and after the cipher); its
`rfc` section (RFC 5869 A.1 and RFC 8439 §2.8.2) is typed by hand. The refusal `koperta-formatu-2` is the same text
sealed with the format 2 constants, which the producer holds itself. Read by `PushCryptoTests` (`RarogContract`,
CryptoKit) and the `node:crypto` mirror.

**Golden request bodies (`shared/fixtures/requests/`).** The client produces these: `RequestFixturesTests` in
`RarogContract` encodes the bodies the app sends and compares them with the files (`RAROG_FIXTURES_WRITE=1 swift test
--package-path native/Rarog/Packages/RarogContract` rewrites them). `shared/test/request-fixtures.test.ts` parses each
file with the same zod schema the router uses, strictly and without loss, so a field the server would drop fails
`pnpm test`.

## Server sentences (`shared/src/sentences/`)

Every text the server shows in the app has a typed origin, so a bare `string` does not compile at a sink.

**Registry.** `index.ts` merges one file per area (`rest.ts`, `session.ts`, `herdr.ts`, …); the area is the file name
and the code prefix. An entry maps a code `<area>.<name>` (kebab-case) to an English template with `{name}`
placeholders (`{one, other}` for a plural, whose number a template may leave out) and ordered arguments `name:kind`:
`int`, `plural`, `text` (user data and foreign text, never translated), `code` (a sub-sentence without arguments),
`instant` (ISO 8601); at most 8. A published code never changes its meaning, arguments or template. A code the server
no longer emits moves to `RETIRED` with `since` and stays there. `server/test/sentences-registry.test.ts` checks the
entries. The areas hold every sentence of the server's own that the app shows: REST errors, session state, models,
dialogs, transcript, terminal, herdr status and push. The server builds each with `say()` where it arises (the 422
refusal is `dialogs.refuse.<reason>`, and `REFUSE_MESSAGES` is that English text). The fallback-label pattern matches
`session N` and the same label in Polish, so numbering continues across both and a first prompt replaces either form.

**Two forms of text** (marks the module does not export, so a hand-made object does not pass either):

- `say(code, args)` → `ServerSentence` `{text, ref: {code, args?}}`: the English text plus its code; it throws on an
  unknown or retired code and on a missing, extra or malformed argument;
- `foreign(text)` → `ForeignText`: text from outside (agent, user, herdr, Node, pane screen), applied where it enters
  the server; it never gets a code.

`OwnText` is `ServerSentence` (the name marks sinks that take only the server's own sentence), `AnyText` is
`ServerSentence | ForeignText`, and `textOf()` returns the text. There is no third form: an own sentence without
a code does not compile.

**Sinks.**

- REST: `sendError(res, status, error, OwnText)` for a route's own refusal. `errorBodyOf(status, err, policy)` is the
  only builder of `{error, message}` from an exception: `message` comes from the exception's `sentence` field, never
  from `Error.message`, and an exception without it gets the generic sentence of its status. `sendJson` takes only
  status 200 or 202 and the contract bodies.
- Error classes: `HerdrError` and its subclasses, `UploadError`, `ClientIdConflictError`, the manager's classes,
  `NotesFailure` and `TermBackendRetryError` carry `sentence`.
- Session state: `Session.stateDetail` is `OwnText`, and so are the driver's `agent-state.detail` and `exit.reason`.
- Transcript: the driver's `message` and `history` events, the jsonl follower and the import carry `InternalBlock`,
  whose text is `AnyText`. The wire `Block` is built only in `Session.appendMessage` (`wireBlocks`): a `say()` text
  block carries its `ref`, and a block cut by `clampMessageBlocks` loses it (the trim mark is a separate block with
  its own `ref`). `clipForDisplay` cuts in UTF-16 code units and returns the text with the cut (`truncation`, counted
  in Unicode scalars).
- herdr status (`setStatus({detail})`, `unavailable.reason`), the terminal `err` frame (`errFrame`) and the push
  scheduler's `NoteInput.detail` take `AnyText`.

**On the wire** the text always goes out, and a `say()` sentence also carries its code as a `SentenceRef`
`{code, args?}` (`code` non-empty, at most 8 string `args`) in a field next to the text:

- REST: `messageRef` in error bodies (`errorBody`, 422 refusals, the 409 notes conflict), `warningRef` in the 202 of
  `POST /api/sessions/:id/model`, `labelRef` and `descriptionRef` on a model choice;
- sessions: `labelRef` (any label that reads `session N`, a prompt with that text too, because the label keeps
  only text), `stateDetailRef` (summary) and `detailRef` (`state`, herdr status);
  the usage-limit sentence keeps `stateDetail: "resetAt=<ISO>"` and puts the reset time in `args`;
- transcript and cards: `ref` on a text block, `displayTextRef` on a permission card, `questionRef` on a question;
- terminal: `msgRef` on an `err` frame.

`foreign()` text goes out without a code. A cut travels as `truncation: {cut, footer}` (Unicode
scalars) on a `tool-call` block with `detail` and on a permission card; a cut without its text, or a `footer` longer
than the text, rejects the frame. A stand-in image that keeps a snapshot within its budget has `placeholder: true`.
A broken `ref` (`null`, empty `code`, 9 `args`, a numeric argument) rejects the whole frame or body. The push
plaintext carries `titleRef` and `bodyRef` next to `title` and `body` (see "APNs banner" below for how
`server/src/notify/content.ts` builds them). The golden files hold these fields, and their guards check that the text
next to a code is not Polish.

`server/test/sentence-origin-guard.test.ts` guards what the types do not see: every error class has `sentence` (the
list comes from the source tree; a class outside REST goes to an exception list with a reason), `router.ts` has
a `message` key only in `errorBody` and writes JSON only through its helpers, `cards/build.ts` builds a card's text
only in `cardText` and a question's text only in `questionText` (both take `AnyText`, so the code comes from the
text's origin), and `@rarog/shared/sentences` exports no way to make an own sentence without a code.

## HTTP routes

`docs/architecture.md` gives an overview; this section is the full contract. Every route except `/health`,
`/api/login`, `/api/pair` and, only with `RAROG_DEMO=1`, `POST /api/demo/pairing` requires the device key; the shared
gates stand in "Gates on every route".

### Login and streams

- `POST /api/login` (public) → always 410 `{"error":"login-retired"}`, without reading the body and without a throttle:
  the server has no token login and does not read the `Cookie` header. Another method → 405; the Origin gate runs
  before the route (a POST without `Origin` → 403); on the iroh socket the path is 404 `not-found`. The only
  credential is the device key.
- `GET /api/stream`: the global SSE stream. `GET /api/sessions/:id/stream`: one transcript; messages carry `id:
  <serverStartId>:<seq>`, deltas carry none. With a cursor (`Last-Event-ID` or `?since=`) the server sends the tail
  from the ring buffer, or one `transcript-snapshot` when the tail holds at least 2 messages (log line `sse: replay <n>
  messages → snapshot <kB> kB (session <id>)`). A cursor outside the ring buffer, without a prefix or with another
  `serverStartId` gets `transcript-snapshot` plus live frames. A snapshot has no `id:`; the first live frame moves the
  client's cursor. When a restart or "Resume" puts a new card under the id, every open stream of that id gets a
  `transcript-snapshot` of the new card, and a cursor of the old card gets one too.
- Stream headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`; the body opens with `retry: 3000`, and a `ping` event (with a
  `: ping` comment) comes every 10 s (`hello.heartbeatMs`). Unless `RAROG_SSE_GZIP=0` (`docs/server-config.md`), the response also has
  `Vary: Accept-Encoding`, and a client whose `Accept-Encoding` names `gzip` with a weight above zero gets
  `Content-Encoding: gzip`: the same frames, compressed and flushed after every frame and ping. The replay log line
  then reads `… → snapshot <kB> kB, gzip <kB> kB (session <id>)`.

### Sessions

- `POST /api/sessions`: see "Routes for herdr sessions".
- `POST /api/sessions/:id/messages` → 202 `{ok: true}`; with `clientMessageId` `{ok, clientMessageId, replayed?,
  queued?}`, or 409 `client-id-conflict`. Only `running` and `waiting-input` take a message; any other state, `starting`
  included, gets 409 `bad-state` with `session.not-accepting-messages`. The start prompt of `POST /api/sessions` does
  not go through this route. `source` and `expectedConversation` come both or neither: a body with one of them alone
  is a 400 `bad-request` (`rest.body-contract`), before any flag. A body with both (a prompt of the voice agent) gets
  503 `companion-disabled` (`RAROG_COMPANION` off) or 503 `companion-sessions-disabled` (`RAROG_COMPANION_SESSIONS`
  off) before the send registry, and 409 `bad-state` with `session.conversation-changed` when the session writes
  another engine conversation than the token names, as the last check before the text goes to the driver; nothing
  reaches the pane. A message accepted into the paste queue gets no 409 after its 202. Gate, check and audit field:
  `docs/companion.md`, "Sending from the conversation".
- `POST /api/sessions/:id/permissions/:permId` and `POST /api/sessions/:id/answers/:qId` → 200, 409, 410 or 422
  ("Decision contract").
- `POST /api/sessions/:id/interrupt` → 202 `{ok, session, delivered, returnedPrompt?}`
  ("Esc fixes the state from the response", "`returnedPrompt`: the prompt back in the field").
- `POST /api/sessions/:id/queue/take-back {operationId}` → 200 `{items, incomplete?}`, 409 or 410 with the manager's
  sentence, 400 ("Queue take-back").
- `POST /api/sessions/:id/close` → 200; `POST /api/sessions/:id/resume` → 200, or 409 when not resumable.
- `POST /api/sessions/:id/companion/ask {question, clientRequestId}` (`companionAskBodySchema`) → 200
  `{answer, found, prompt?}` (`companionAskSchema`), about the engine conversation the session writes when the server
  takes the request. Refusals: 503 `companion-disabled` (`RAROG_COMPANION` off), 404 for a session that is not Claude
  Code in scope (`rest.companion-claude-only`), 429 `companion-busy` and `companion-limit`, 503 `companion-cli`, 504
  `companion-timeout`. A new engine conversation while the question waits closes the response without a body. Demo
  mode has no route (404). Gate and process: `docs/companion.md`.
- `GET /api/sessions/:id/companion/turns?count=1..3` (`companionTurnsCountSchema`) → 200
  `{messages, conversation, stateSince, readMark, complete}` (`companionTurnsSchema`): the messages of the last 1–3
  turns of the engine conversation the session writes now, in the shape of the session stream (`seq` from 1 in this
  response), an opaque token of that conversation (another one after `/clear`, `/resume` and after a server restart),
  the session's `stateSince`, an opaque name of the newest message the server's memory of the session held and of its
  `stateSince` before the read (`readMark`, for the pick-up of `POST …/seen`; an answer with no messages or with a
  message trimmed to the ceiling of one message carries a fixed mark that names no read, which no pick-up meets) and
  `complete: false` when the read window starts inside the oldest returned turn. Refusals:
  503 `companion-disabled` (`RAROG_COMPANION` off), 503 `companion-sessions-disabled` (`RAROG_COMPANION_SESSIONS`
  off), 400 for `count` outside 1–3 (`rest.companion-turns-count`), 404 for an unknown session and for a session that
  is not Claude Code in scope (`rest.companion-claude-only`). A new engine conversation during each of three reads
  closes the response without a body. Demo mode has no route (404). Turn boundary and gate: `docs/companion.md`,
  "Turns route".
- `GET /api/companion/sessions` → 200 `{sessions: [{id, asksOwner?, conversation, stateSince}]}`
  (`companionSessionsSchema`): one row per Claude Code session in scope (`inCommandScope`, the gate of the turns
  route), built from the server's memory. `conversation` is the turns route's token of the session; `asksOwner`,
  only as `true`, while the session waits for input and its newest message is an agent message with the app's
  question block. A session out of scope has no row. Refusals: 503 `companion-disabled` (`RAROG_COMPANION` off),
  503 `companion-sessions-disabled` (`RAROG_COMPANION_SESSIONS` off), 405 for another method. Demo mode has no route
  (404). Rows and the `asksOwner` rule: `docs/companion.md`, "Session catalog".
- `POST /api/companion/token` with an empty body (`companionTokenBodySchema`; a field is a 400) → 200
  `{value, expiresAt, model}` (`companionTokenSchema`): a short-lived OpenAI Realtime key for the voice agent.
  Refusals: 503 `companion-disabled` (`RAROG_COMPANION` off, no `OPENAI_API_KEY`, or no Soniox voice: no
  `SONIOX_API_KEY` or a key outside the EU region), 429 `companion-throttled`, 503 `companion-openai-key`, 429
  `companion-openai-limit`, 502 `companion-openai`; a device revoked while the server waits for OpenAI gets 401. Demo
  mode has no route (404). Gate: `docs/companion.md`, "Short-lived OpenAI key".
- `POST /api/companion/speech-token` with an empty body (`companionSpeechTokenBodySchema`; a field is a 400) → 200
  `{apiKey, expiresAt, webSocketUri, model, voice, sampleRate}` (`companionSpeechTokenSchema`): a temporary Soniox
  text-to-speech key for the voice agent's voice (`tts_rt`, 600 s to open streams, 180 s per stream, EU region).
  Refusals: 503 `companion-speech-unconfigured` (`RAROG_COMPANION` off, no `OPENAI_API_KEY`, no Soniox key, a key
  outside the EU region, or Soniox refused the key), 429 `companion-speech-throttled`, 502
  `companion-speech-upstream`; a device revoked while the server waits for Soniox gets 401. Demo mode has no route
  (404). Gate: `docs/companion.md`, "Temporary Soniox speech key".
- `GET /api/projects` → `{projects: [{path, name}]}` (the directory allow-list).
- Git: Rarog only reads git ("Git in a session"). A human pulls and pushes in the terminal.

### Health, version and client log

- `GET /health`, without auth: `{ok, version, uptime, herdr, term, hook, authStore, sdk, consent?}`: readiness, the
  permission hook registration, the device key store (`ok` or `broken`), the session list SDK at start (`ok`,
  `stale`, `missing`, `error`; `docs/distribution.md`, "Claude SDK") and the consent channel mode `{configured,
  effective, reason}` (`configured`: `off`, `shadow`, `main`, `all`; `effective`: `off`, `shadow`, `main`, `all`;
  `reason`: `configured`, `starting`, `missing`, `mismatch`, `stale`, `consent-socket`, `admin-socket`,
  `min-client-build`, `killswitch`; `docs/server-config.md`, `RAROG_CONSENT_CHANNEL`). A server without a mode
  source leaves `consent` out. Only the loopback caller gets these fields: a TCP request whose `Host`, in any case,
  is exactly `127.0.0.1:<port>` or `localhost:<port>` for the server's own local port (on port 80 also without the
  port) and which carries none of `X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`, `X-Real-IP` or a
  `Tailscale-*` header. Every other request (iroh, another `Host`, no `Host`, a proxy header) gets `{"ok":true}`,
  and no probe runs for it. The status is always 200 (`fullHealthAllowed` in `server/src/health.ts`).
- `GET /api/version`: `version`, `protocolVersion`, `serverStartId`, `tailnet` (or `null`), `hookSeenAgo` (or `null`),
  the optional `hookSeenAgoByFile`, the flags `voiceEnabled`, `termEnabled`, `notesEnabled`, `companionEnabled`,
  `companionSpeech` and `apnsEnabled`, the optional `companionSessions` (only `true`, when the voice agent works and
  `RAROG_COMPANION_SESSIONS=1`; `docs/companion.md`, "Turns route"), `capabilities` (from `SERVER_CAPABILITIES` in
  `server/src/version.ts`: `device-auth`, `pair`, `pair-from-device`, `push-relay`, `push-e2e-v2`, `companion`,
  `companion-sessions`, plus `inbox` while the Inbox is on, "Inbox", and `files` while the session file route is on,
  "Session files"), `system` (the server machine's system from `process.platform`: `macos` for `darwin`, `linux`,
  `other` for anything else; the demo server says
  `macos`) and `iroh` (`{endpointId, relay}` or `null`). `companionEnabled` says that the voice agent works
  (`RAROG_COMPANION=1`, the OpenAI key and the Soniox voice), `companionSpeech` is equal to it, and the capability
  `companion` says that the server knows the voice agent contract (`docs/companion.md`). The app calls the
  server machine "Mac" for `macos` and while it knows no system, and "VPS" for `linux`, `other` and a value it does
  not know; it remembers the last known system in the device credential and in the revocation record, and starts the
  Live Activity with it in the activity attributes. A valid `iroh` pair goes into the device credential and serves
  from the next tunnel generation (rules: `docs/distribution.md`, "Pairing from the app").
- `POST /api/client-log`: appends NDJSON to a file in the data directory; at most 64 kB per request.

### Project notes

One document per project; killswitch `RAROG_NOTES` (off → 404).

- `GET /api/notes?cwd=` → `{text, updatedAt}` (no file → `{text: '', updatedAt: 0}`).
- `PUT /api/notes {cwd, text, updatedAt}` → `{updatedAt}`; a stale `updatedAt` gives 409 `{error: 'conflict',
  message, current: {text, updatedAt}}`. Empty `text` is the only delete; there is no `DELETE`.
- Caps: `NOTES_MAX_CHARS` = 48 k characters and `NOTES_BODY_MAX_BYTES` = 256 kB (this route's own body cap). `cwd`
  goes through `checkCwd`, and the store addresses the file by its `realpath`.
- A successful write broadcasts the volatile `notes` event (`empty` = `text.trim() === ''`, no content).
- App side: `NotesDoc`, `NotesSaved`, `NotesConflictBody`, `NotesPutBody` and `NotesRules` (`maxUnits` = 49 152
  UTF-16 units; `isEmpty` with an explicit list of JS `trim` characters) in `RarogContract`; a 409 with `current` is a
  result, not an error.

### Emergency console

A full shell from the phone in a herdr pane, behind `RAROG_TERM` (off → 404).

- `POST /api/term {cwd, slot?, role?}` → 200 `{id, slot, role}`; 409 `term-limit`, `herdr-launch-off`,
  `herdr-send-off`; 500 `internal`. `GET /api/term` → `{terminals}`. `GET /api/term/:id/history?lines=N` → `{text,
  truncated}` (plain scrollback; `lines` is clipped, not rejected). `DELETE /api/term/:id` → 200 `{}`.
- The stream is a WebSocket upgrade on `/api/term/:id` (`?fresh=1`; `?c=` and `?r=` = the size measured before the
  upgrade). The credential check and then the Origin gate run before `handleUpgrade`. `?direct=1` = a socket without a
  preceding `POST`, dropped for a `failed` entry, an entry with a handle to recompute, or the `lazygit` role
  (`TermRegistry.attachableDirect`). A refusal at the cap and a device revoked meanwhile get an `err` frame and close
  1008.
- Frames (`termClientFrameSchema`, `termServerFrameSchema`): the client sends only text JSON, `in` `{t, d}`, `rs`
  `{t, c, r}` (1…1000), `sc` `{t, d, c?, r?}` (±200 rows) and `pa` `{t, d, e}` (a paste chunk; `e: true` = the last);
  the server sends the screen bytes in non-text frames and the text frames `hello`, `exit` and `err`. `d` fits 8 kB
  of UTF-8 (`TERM_MAX_INPUT_BYTES`) and `maxPayload` is 16 kB; anything else closes the socket with 1002.
- Paste: the server joins the `pa` chunks up to `e: true`, strips the bracketed paste markers (also the C1 form),
  replaces lone surrogates, turns line ends into `\r`, wraps the text and sends one `terminal.input`. A paste over
  `TERM_MAX_PASTE_BYTES` (512 kB) is dropped whole with a log line; an `in` frame in the middle of a paste discards
  the paste.

### Usage and Mac load

- `GET /api/usage` → 200 with the 5-hour and weekly windows from the newest Claude Code status line dump
  (`~/.claude/statusline/`), without passed windows, with `source: 'cli'`, `fetchedAt` and `account` (from
  `~/.claude.json`). `stale: true` for a dump older than 15 min (`CLI_USAGE_STALE_MS`). Rarog does not read the account
  token and does not call the Anthropic API. 503 `usage-unavailable` when no dump has a live window. `weeklyModel`
  is sent only in demo.
- `GET /api/usage/details` (the Usage sheet of the app's `/usage` command) → 200 in the `planUsageSchema` shape
  without `source`, from the reading Claude Code writes in `~/.claude.json` (`cachedUsageUtilization`): `fiveHour` from
  the `session` entry, `weekly` from `weekly_all`, `weeklyModel` from `weekly_scoped` (`model` =
  `scope.model.display_name`), the first live entry of each kind, `resetsAt` in ISO with milliseconds; `fetchedAt` is
  the reading's `fetchedAtMs`, `stale: true` past 15 min. Only when the reading's `accountUuid` equals
  `oauthAccount.accountUuid`; a missing file or key, another account, a foreign shape or only passed windows give 200
  `{}`.
- `GET /api/mac` → 200 `{cpu?, ram?, disk?}`: integer percentages used, 0–100 in steps of 5 (CPU = the one-minute
  average, RAM = 100 − `kern.memorystatus_level` on macOS and the share of `MemTotal` outside
  `MemAvailable` (`/proc/meminfo`) on Linux, disk as `df`), from the shared sampler (`server/src/mac-stats.ts`,
  the same one the Live Activity uses), without I/O in the request, `Cache-Control: no-store`; a missing field = no
  reading, `{}` = none (right after the server start, or every reading failed).
- `/api/usage/details` and `/api/mac` are behind the credential (401); another method → 405 (with `Allow: GET` on
  `/api/usage/details`). The app reads a 404 from either (a server without the route) as "the feature does not exist".
- Demo returns fixed numbers (`server/src/demo/usage.ts`, `server/src/demo/mac.ts`); its `/api/usage/details` has a
  reading 47 min old with `stale: true`.

### Push notifications

The only notification channel is APNs of the native app. All routes are behind the credential and the Origin gate;
bodies go through the schemas above (a bad body is 400 `bad-request`).

- `POST /api/push/apns {token, environment, label, alerts, test?, topic, pushFormats?, locKeys?}` → 204: an upsert
  into `apns-devices.json`, keyed by the lower-case token, with the `deviceId` of the request's key. `pushFormats` is
  the banner format declaration of this registration (a missing field clears it; an entry without 3 gets no banners).
  `locKeys: true` declares that the app's catalog has the push localization keys: the entry stores `locKeys: true`
  and gets the banner placeholder and the Live Activity chime as keys instead of the Polish literals; a missing field
  or `false` clears the declaration, and a non-boolean value is 400 `bad-request` with no write. A
  `topic` other than the server's (`RAROG_APNS_TOPIC`, or `RELAY_APP_TOPIC` without a key) or a missing one is 400
  `topic-mismatch` (`APNS_TOPIC_MISMATCH_ERROR`), with no write and no test push. `test: true` with `alerts: true`
  sends a test push (`rarog.kind = 'test'`), throttled to one per token per 60 s (429 `too-many-requests`, which does
  not undo the write); `test` with `alerts: false` sends nothing. The 204 does not wait for delivery. After it the
  server orders a push relay pass when the entry needs one; a test push of an entry with neither a pass nor a key
  waits for the pass up to 10 s, then ends as `pass-missing` in the log.
- Body rules (`apnsRegisterBodySchema` and the other push schemas in `@rarog/shared/rest`): the token is hex
  `APNS_TOKEN_RE` (32–512 characters, any case), `environment` is `development` or `production` (the
  `aps-environment` of the signing profile), `label` is capped at `PUSH_LABEL_MAX_CHARS` (64).
- `POST /api/push/apns/unregister {token}` → 204, idempotent; an entry with an activity first gets the Live Activity
  `end`.
- `POST /api/push/apns/status {token}` → 200 `{enabled, registered, alerts, degradedSince, degradedReason?}`.
  `degradedSince` is an ISO time or `null` (a value, never an absent field; `null` = healthy or an unknown token): the
  third failed attempt in a row to this token, or the moment this entry's send path was switched off (the key by a
  permanent error, the relay after a `503`); for `pass-missing` the first failed pass order (or the entry's creation
  when no pass can be ordered), for `env-mismatch` the pass refusal. `degradedReason` (`APNS_DEGRADED_REASONS`:
  `pass-missing` or `env-mismatch`) comes only together with `degradedSince`. The route waits up to 5 s
  (`STATUS_PASS_WAIT_MS`) for a pass order in progress, then answers without a reason. POST, because a token in a
  query would land in proxy logs.
- Without an APNs channel (no complete `RAROG_APNS_*` set and no `RAROG_PUSH_RELAY_URL`, `RAROG_PUSH=0`, or demo) the
  status is `{enabled: false, registered: false, alerts: false, degradedSince: null}`, and the other routes are a 204
  no-op, never 404, 429 or `topic-mismatch`.
- `POST /api/push/live-activity {deviceToken, activityId, updateToken}` → 204: a new `activityId` replaces the
  device's activity, the same id with a new token is a rotation; 409 `apns-device-unknown` for a device token the
  server does not know. `POST /api/push/live-activity/end {deviceToken, activityId}` → 204; only a matching
  `activityId` ends the activity. Without an APNs channel both are a 204 no-op after the body check.
- The router logs no token, `activityId` or label.

**Push relay** (`server/src/notify/relay-sender.ts`). An entry or activity with a valid pass sends the same APNs
request wrapped in `POST <RAROG_PUSH_RELAY_URL>/v1/push {v: 1, pass, token, environment, headers, payload}`; `POST
/v1/pass` orders a pass. Shapes and responses: `relay/README.md`, schemas `shared/src/relay.ts`, examples
`shared/fixtures/relay/`.

**APNs banner** (`server/src/notify/apns-payload.ts`, `apns-sink.ts`).

- `POST /3/device/<token>`, `apns-push-type: alert`, `apns-topic` = the entry's topic, `apns-priority` 10 (blocking,
  failures, pushes without a session) or 5 (`done`), `apns-collapse-id` = a hash of the session id (without a
  session: of `rarog:<kind>`; `weekly-limit`: of `rarog:weekly-limit:<resetsAt>`; the consent canary result: of
  `rarog:consent-canary:<release>`), `apns-expiration` = now + the TTL
  (600 / 600 / 3600, test push 120, `device-paired` and `version-changed` 24 h, `weekly-limit` the time left to the
  window's reset, at most 24 h), and `authorization: bearer <JWT ES256 {alg, kid}.{iss, iat}>`.
- The banner is always encrypted, format 3. An entry gets it only when `RAROG_PUSH_E2E` is on (the default), its last
  registration declared 3, and its `deviceId` is an active device; otherwise it is skipped with a log line, and there
  is no plain fallback. Live Activity needs no declaration.
- Body ≤ 4096 B: `aps` with the placeholder `RELAY_ALERT_PLACEHOLDER` (for an entry with the `locKeys` declaration
  its keys `ALERT_PLACEHOLDER_KEYS`: `title-loc-key` `push.placeholder.title`, `loc-key` `push.placeholder.body`),
  `mutable-content: 1`, sound, badge and
  `thread-id` (= `apns-collapse-id`, only for session kinds), plus `rarog: {v: 3, kid, n, c}`; a `done` carries the
  badge alone, without `alert`, `sound` and `thread-id`, and without a badge number it is not sent.
- Cipher (`server/src/notify/push-crypto.ts`): the key is HKDF-SHA256 of the 32 raw bytes of the device's `pushKey`
  from `devices.json` (empty salt, info `rarog-push-banner-v1`, 32 B), ChaCha20-Poly1305 with a random 12 B nonce per
  message and AAD `rarog-push/3|<kid>`; `n` = the base64url nonce (16 characters), `c` = base64url(ciphertext‖tag)
  without `=`. The plain text is `{kind, title?, titleRef?, body?, bodyRef?, sessionId?, termId?, exp}`: `kind` is
  `permission`, `question`, `blocked`, `done`, `error`, `limit`, or `test`, `device-paired`, `version-changed` and
  `weekly-limit` (all four without `sessionId`); `termId` = an agent in a Rarog terminal; `exp` = `apns-expiration`.
  Over 2048 B it first drops both `*Ref`, then is clipped by scalars (`body` first, then `title`), and it is padded
  with spaces to a multiple of 256 B. A payload over 4096 B after encryption is skipped, never sent plain. Log line:
  `push: APNs <kind> — v3: N[, skipped: N]`.
- Text (`content.ts`): the title is `push.title.<kind>` with the project; the body of a permission or a terminal
  dialog is `push.body.detail-and-label` (tool name and session label; a fallback label `session N` gives
  `push.body.detail-and-session-number`), of a question or a result `push.body.detail` (the agent's text), of an
  error or a plan limit the state sentence itself (`state.driver-error`, `state.limit-reached` with the reset
  instant), whose `ref` becomes `bodyRef`; without a detail the session label (`push.body.label`, a fallback label
  `session.fallback-label`) or `push.body.fallback.<kind>`. The test push is `push.test-title`/`push.test-body`, the
  device-paired push `push.paired-title` with `push.paired-body.mac` or `.vps` by the server's system, the
  version-changed push `push.version-title` with `push.version-body.claude-code`, `.herdr` or `.both` (version
  numbers only, each up to 20 characters, `VERSION_RE` in `server/src/version-watch.ts`), the consent canary result
  (kind `version-changed`, `buildConsentCanaryContent`) `push.canary-title` with `push.canary-body.pass`, `.fail`,
  `.unmeasured` or `.unmeasured-package` (the release only; the body by the result and the gate's main-thread rule
  after it), the weekly-limit push
  `push.weekly-limit-title` (the whole percent, `int`) with `push.weekly-limit-body` (the window's reset, `instant`),
  built by `buildWeeklyLimitContent`, which gives nothing once the reset has passed. Arguments are
  flattened (one line, no markdown) and clipped before `say()`, so the English body fits 120 characters and `bodyRef`
  renders exactly the text shown; a text that cannot fit that way (a state sentence that needs flattening or
  clipping, a template over the limit) goes without `bodyRef`. The `ref` travels with the event through the
  scheduler's queue and the owed result to the send. The notification extension translates both texts with
  `PushServiceDecision.decide` and its renderer; an unknown code or a wrong argument count keeps the server text.
- The `version-changed` push (`architecture.md`, "New version of Claude Code or herdr") goes to every entry with
  `alerts: true`, without a badge (`shared/fixtures/apns-v3/alert.version-changed.v3.json`). The app shows it also in
  the foreground, and a tap opens the Settings "Server" page (`PushNote.showsBannerInForeground`,
  `PushNote.opensSettings`; a `device-paired` tap opens the "Pairing" page). The `weekly-limit` push
  (`architecture.md`, "Weekly plan limit", `shared/fixtures/apns-v3/alert.weekly-limit.v3.json`) also shows in the
  foreground, and a tap opens the session list (`PushNote.opensList`), the same path as the Live Activity background
  (`AppLink.list`): it waits for login and a fresh list. An app that does not know a kind decodes it without an
  error as no kind (`ApnsPushKind.wire` → `nil`): it shows the title and body in the background, a tap opens the app
  without a target, and in the foreground there is no banner.

**App side of push.** Every token registration carries `pushFormats: [3]` and `locKeys: true`. The notification
extension
`RarogNotificationService` (bundle id `<app>.notification-service`) opens the v3 block with the key found by `kid` in
the shared Keychain group, and while `now ≤ exp + 300 s` puts the plain `title` and `body` into the notification and
adds `rarogOpen` to `userInfo`; otherwise the placeholder stays. `PushRouting.inspect` reads `rarogOpen`, then the v3
block with the app's key, then a plain v1 block. One `client.log` line per push names the source and, for a v3 the
app cannot open, the reason (`PushRefusal`), without content.

**Live Activity update** (`apnsLiveActivityRequest`). `apns-push-type: liveactivity`, topic = the entry's topic +
`.push-type.liveactivity`, priority 10 (a change in the number of waiting sessions, the chime) or 5. The body has no `alert`: `aps` with
`timestamp`, `event` (`update` or `end`), `content-state` and `stale-date` = `timestamp` + 900 (`dismissal-date` =
`timestamp` for `end`). `apns-expiration` is the `stale-date` for an update, `timestamp` + 8 h for `end`, and the
wall-clock moment the chime was ordered + 30 s for an update with the chime. The only alert is the `done` chime,
only on `update`, with fixed texts from `LIVE_ACTIVITY_CHIME` and the sound `skonczyl.caf`; an entry with the
`locKeys` declaration gets the texts as keys, `LIVE_ACTIVITY_CHIME_KEYS` (`{title: {loc-key: push.chime.title},
body: {loc-key: push.chime.body}, sound}`). `timestamp` (epoch
seconds) strictly grows per activity and equals `content-state.updatedEpoch`. Overflow is clipped by scalars: the
second run first (`phase.title`, then `name`, then `project`), then the first run; at the contract caps it never
happens.

The `content-state` (`liveActivityContentStateSchema`, version 2) is `{waiting, working, finished, top?,
workflows?, moreWorkflows?, limits?, mac?, updatedEpoch}`:

- `top` = `{sessionId, termId?}`, the tap target only;
- `workflows` = 1–2 × `{sessionId, project, name, agents, done, phase?, segments, states?}`, with `phase` = `{index,
  count, title}` (`index ≤ count ≤ 12`), `segments` = 1–12 percentages 0–100, and `done ≤ agents`;
- `states` = the state of each phase of the plan, `pending` | `running` | `done`, one per segment in the same order. It
  is present only with `phase`; a run without a phase plan has no `states`. The server derives it from the phase's
  agents that started and finished (a failure counts as finished), not from `currentPhase` or the rounded
  percentage: none started → `pending`, fewer finished than started → `running`, all finished → `done`. Several
  phases can be `running` at once, and a `done` phase with a new agent is `running` again. The app treats a
  `states` that is not an array of known values, has a length other than `segments`, or comes without `phase` as
  absent and decodes the rest of the state; without `states` the bar shows the percentages;
- `moreWorkflows` ≥ 1; `limits` = `{fiveHour?, weekly?}` and `mac` = `{cpu?, ram?, disk?}` in integer percentages
  0–100.

### Presence, focus and seen

- `POST /api/presence {clientId, visible, sessionId?}` → 204: input of the notifier, so a push does not go to a
  screen that shows the session; a no-op without an APNs channel.
- `POST /api/sessions/:id/focus` → 202 `{ok: true}`: `agent.focus` by the herdr pane key, also for a Codex row; the
  effect is on the Mac, not in the response. The app does not call this route.
- `POST /api/sessions/:id/seen` → 200 `{ok: true}`: "I viewed the result on the phone". The local marker is written at
  once, and `agent.focus` runs in the background only when `seen === false` (Rarog knows of a standing `done` in herdr);
  its failure is not an error. The client calls it for a `waiting-input` session with `seen` other than `true` or
  with `seenBy`, deduplicated by `id` + `stateSince`. In work states there is no result yet, so the server writes no marker and only
  cancels the session's pending push notification (`notifier.seen`). The app's body is empty or `{}`; a body
  `{by: "voice-agent", conversation, readMark}` (`seenBodySchema`, all three fields or none, else 400 `bad-request`;
  both values from one answer of the turns route) is the voice agent's pick-up of the result it read: the same
  receipt plus `seenBy` on the row, only for a session in `waiting-input` with no decision card waiting on it, in the
  engine conversation of the token, with no message in its memory newer than `readMark` and the `stateSince` the mark
  names (else 409 `bad-state`, `session.seen-result-changed`, no effect), behind the flags of the mode across
  sessions (503) and the scope of its session catalog (404). Rules and gate order: `docs/companion.md`,
  "Picking up a result".
- `POST /api/sessions/:id/unseen` → 200 `{ok: true}`: mark as unread; no body, only the local marker, no herdr call and
  no notification; without effect outside `waiting-input` with `seen: true` ("Viewed on the phone" below). The app
  also calls both routes from the toggle on the list (`setResultRead`), without dedup.

### Gates on every route

- POST, PUT and DELETE check `Origin` against the allow-list (`RAROG_ORIGINS`; in demo without it, the server's own
  address: `http://localhost:<port>` and `http://127.0.0.1:<port>`, and at port 80 both also without the port). On
  the iroh socket only `IROH_ORIGIN` passes.
- 401 without a valid credential: `unauthorized` (no header), `device-unknown`, `device-revoked`. The server sends no
  `Set-Cookie`.
- `POST /api/demo/pairing`, the route of the plain demo (`RAROG_DEMO=1` without `RAROG_DEMO_REVIEW_CODE`) that
  skips the credential gate, revokes and issues only devices of the demo store `<dataDir>/devices.demo.json`. A
  server without demo and review mode keep their devices in `devices.json`, which the plain demo never reads or
  writes, so a demo key opens neither.
- A request body is capped at `MAX_BODY_BYTES` = 64 kB; only notes (`NOTES_BODY_MAX_BYTES`) and messages
  (`MAX_MESSAGE_BODY_BYTES`) have their own cap.
- The bind is hard-coded to 127.0.0.1, and `redact()` keeps the `/api/pair` body, the `Authorization` header, tokens,
  device secrets and push keys out of every log.

### Device keys and pairing

Threat model: `docs/security-model.md`, "Pairing and device keys"; the `rarog pair` command and client rules:
[distribution.md](distribution.md) and `native/Rarog/docs/rarog-core.md`, "Pairing and device key". Schemas: the device
identity block of `shared/src/rest.ts`; golden responses `pair*.json`, `pairings.json`, `devices*.json`,
`error.pair-unknown.json`, `error.device-*.json`; Swift types in `RestResponses+Devices.swift`.

- **Header:** `Authorization: Rarog-Device <deviceId>.<secret>` in REST, SSE and the terminal upgrade (`deviceId`:
  `DEVICE_ID_RE`, 32 hex; `secret`: `PAIRING_CODE_RE`, 43 base64url; the scheme is case-insensitive). No header → 401
  `unauthorized` (not throttled); a bad key → 401 `device-unknown` (throttled, then 429 with `Retry-After`).
- **Revoked:** 401 `device-revoked` `{error, message, revokedAt, revokedBy}` (`admin`, `forget`, `expired` or a
  `deviceId`), only for someone who knows the revoked secret. A route with a body checks the key again after reading
  the body.
- **Active device:** not revoked, `lastSeenAt` (moved at most once a minute) younger than 30 days, or, with no request
  since pairing, `createdAt` younger than 10 min, and the record's epoch equal to `RAROG_AUTH_EPOCH`.
- `POST /api/pair {v, code, label, build?, pushFormats?}`: public, with the Origin gate. `v` other than 1 → 400
  `pair-version`; a bad, used or expired code → 404 `pair-unknown` (throttled). 200 → `{deviceId, secret, pushKey,
  kid, server: {id, name, version, capabilities, iroh}}`, once, after a durable write (a write error → 500 and the
  code is burned). `kid` = the first 8 hex characters of `sha256(pushKey bytes)`; `server.iroh` is the iroh pair or
  `null` (the app keeps a valid pair, otherwise the pair of the link it paired through). The server ignores
  `pushFormats` here; the declaration that counts goes with token registration.
- `POST /api/pairings {}` → 200 `{code, expiresAt}` (5 min, single use; a new code revokes the previous one).
  `DELETE /api/pairings` (no body) → 204: the calling device's unused code goes at once, also when there was none,
  and codes of other creators stay; redeeming the cancelled code gives 404 `pair-unknown`. A body other than empty or
  `{}` → 400; the Origin gate and the key check after the body apply as on `POST`. No golden file: 204 has no body.
  Review mode refuses it like `POST` (403 `demo-review`). `GET /api/devices` → the active devices without secrets.
  `GET /api/devices/me` → `{device, serverId}`. `POST /api/devices/forget {}` → 204 (revokes itself, `revokedBy:
  forget`). The 403 `device-required` (`DEVICE_REQUIRED_ERROR`, golden file `error.device-required.json`) stands in
  the contract because the app knows the code, but HTTP never returns it: behind the credential gate every client is
  a device, so the router's 403 is only a type safeguard.
- **Pairing link:** `https://rarog.ai/pair#v=1&u=<server address>&k=<EndpointId>&r=<relay>&c=<code>`, the data in
  the fragment (host `PAIRING_LINK_HOST`, Swift `PairingLinkWire.host`). The builders write this universal link; the
  parser also reads the same fragment after the app's custom scheme, `rarog://pair#`. Both prefixes must match
  exactly, ignoring ASCII case: a port, a user, a slash after `pair`, a query, `www` or plain `http` gives
  `not-a-link`.
  One definition, `parsePairingLink` and `buildPairingLink` in `shared/src/pairing-link.ts`, with the Swift mirror
  `PairingLinkWire`; both check the cases in `shared/fixtures/pairing-links/manifest.json`. Valid combinations: `u`,
  `u`+`k`+`r`, and `k`+`r`. `u` is an `https://` origin (`http` only for `127.0.0.1` and `localhost`) kept as written,
  because the app derives `Origin` from it; `k` is 64 lower-case hex (`IROH_ENDPOINT_ID_RE`); `r` is the relay in the
  canonical `RelayUrl` form. The code goes last, so a link cut while copying loses the code, not the address. The
  parser strips whitespace (a link copied from a terminal often breaks at the line end) and returns the first error
  from `PAIRING_LINK_ERRORS`, checked in this order: `not-a-link` (prefix, no `v`, `v` without a value),
  `duplicate-field` (`v` more than once), `unsupported-version` (`v` other than `1`), `duplicate-field` (`u`, `k`, `r`
  or `c` more than once), `bad-address` (a bad `u`), `bad-endpoint-id`, `bad-relay`, `missing-relay` (`k` without
  `r`), `missing-endpoint-id` (`r` without `k`), `bad-address` (neither `u` nor `k`), `bad-code`. Unknown fields are
  skipped. The server builds the link with the same function (`pairingLink` in
  `server/src/auth/admin.ts`), and so does `rarog pair`; for Pair New Device the app builds it with
  `PairingLinkWire` from the code of `POST /api/pairings` and the routes of its credential. In the app `PairingLink`
  (`RarogCore`) turns the link into a `PairingTarget`: `u` alone pairs over HTTPS, `k` with `r` (with or without
  `u`) over iroh (`docs/distribution.md`, "Pairing from the app").
- **Admin socket** `<dataDir>/run/admin.sock` (for `rarog pair` and `rarog devices`, not the app contract): `POST
  /api/admin/pairings` (409 `device-active` when an active device exists), `GET /api/admin/pairings/:pairingId`,
  `DELETE /api/admin/pairings/:pairingId` (`rarog pair` interrupted by SIGINT, SIGTERM or SIGHUP: 204 for a pending
  or expired code, after which the state is `expired`; a newer code of another pairing stays; 404 `pairing-unknown`;
  409 `pairing-redeemed` for a used code), `GET /api/admin/devices`, `POST /api/admin/devices/revoke`,
  `GET /api/admin/iroh` (the iroh listener's state without the key), `POST /api/admin/dialogs/release {sessionId,
  key?}` → `{released: [key]}` (an unknown field or a bad key → 400), `POST /api/admin/dialogs/off` →
  `{mode: "off"}`; both consent channel routes → 503 `consent-unavailable` while the server has no control of the
  channel. The HTTP port does not serve these routes.
- **Consent channel registration socket** `<dataDir>/run/consent.sock` (the `PermissionRequest` hook, not the app
  contract; it exists only in a channel mode that needs registration): the route `POST /register` with the
  body `{key, sessionId, promptId, secret, inputSha256, cardSha256, pid, startedAt, agentId?, permissionSuggestions?,
  alwaysVersion?}` (up to 32 KiB, an unknown field or an `alwaysVersion` other than 1 → 400; type `ConsentRegistration`
  in `server/src/herdr/dialogs/layer1/contract.ts`;
  `permissionSuggestions` outside the checked shape is dropped from the entry, not refused, `hook/suggestions.ts`) →
  `{accepted: true, bootId}` or `{accepted: false, error}`: 400 `bad-request`, 409 `key-blocked`, 429
  `session-limit`|`global-limit`, 503 `channel-closed`|`subagent`|`send-off`|`session-unknown`
  (`CONSENT_REGISTER_REFUSALS` in `layer1/registry.ts`). The route `POST /claim` with the body `{key, at, mac}` (up
  to 1024 B, an unknown field → 400; type `ConsentClaim`; `mac` = HMAC-SHA256 hex with the registration's secret
  over `CONSENT_RECEIPT_MAC_PREFIX` and `sessionId|key|at`) → `{confirmed: true}` or `{confirmed: false, error}`:
  400 `bad-request`, 403 `refused` (a wrong signature or a key without a live registration), 409 `stale` (not the
  record's live `allow` with this `at`) (`CONSENT_CLAIM_REFUSALS` in `layer1/receipt.ts`). Another path → 404,
  another method → 405, a body over the ceiling → 413.
- **Demo:** `POST /api/demo/pairing {}` exists only with `RAROG_DEMO=1`, before the credential gate (the Origin gate
  applies), because XCUITest has no admin socket. It revokes every demo device (`revokedBy: admin`) and returns
  `{code, expiresAt, link}` like a code from the socket. Outside demo the path is an ordinary unknown route (401
  without a credential, 404 with one). Test: `server/test/devices-demo-pairing.test.ts`.
- **The `device-paired` push:** after a pairing, to the other active devices with `alerts: true` and a format
  declaration, each encrypted under its own key (`shared/fixtures/apns-v3/alert.device-paired.v3.json`).

### iroh listener

With `RAROG_IROH=1` the server also accepts QUIC connections of the iroh library (`server/src/iroh/`; shared constants
in `shared/src/iroh.ts`):

- **Address:** the server's EndpointId through a relay (`k` and `r` from the pairing link, `server.iroh` from `POST
  /api/pair` or `iroh` from `GET /api/version`); the connection's TLS authenticates the key.
- **ALPN** `rarog-http/1` (`IROH_ALPN`). Each bidirectional stream is one HTTP/1.1 connection to the same routes as
  over TCP; unidirectional streams and datagrams are stopped.
- **Credential:** the device key; `/api/login` is a 404 here. Mutations and the terminal upgrade need `Origin` exactly
  `IROH_ORIGIN` (`https://iroh.rarog.invalid`), which TCP refuses in turn.
- **Limits:** 16 streams before authentication, 32 after, 60 s to authenticate. Close codes: 0 `bye`, 1 `alpn`, 2
  `busy`, 3 `evicted`, 4 `auth-timeout`, 5 `close-timeout`. Full rules: `docs/security-model.md`, "Layer 1b".
- **Client side (native app):** the app talks to a paired server through generations, one connection at a time, over
  iroh or over HTTPS (how it picks: `docs/architecture.md`, "Native client"). A client on iroh sends `Origin` equal to
  `IrohWire.origin` and connects with `IrohWire.alpn` (`RarogContract`), the mirrors of `IROH_ORIGIN` and `IROH_ALPN`
  (`IrohWireTests` compares them); `TunnelRuntime` takes that client from a factory and owns it. The first request of
  an iroh generation is `GET /api/version`, with the device key when the app has one (pairing over iroh sends none and
  gets 401), and any HTTP answer (401 included) makes the generation ready. Closing a generation aborts the open
  stream pairs with a 2 s deadline and invalidates the client after its requests drain or after 2 s. Where TCP would
  answer 400 or 408, the server resets the stream on iroh, so the app gets `.offline` (for a send: "not confirmed"),
  never a status. On iroh a send with an attachment goes on its own connection, and cancelling it closes that
  connection only (close code 1; the app closes everything else with 0).

### iroh relay registry (`shared/src/relay-auth.ts`)

The Worker `rarog-relay-auth` (`relay-auth/`) keeps the registry of iroh keys the iroh relay lets in. The `/v1/*`
contract has one TypeScript definition (a leaf module without `zod`) and a Swift mirror, `RelayAuthWire` in
`RarogContract`; the cases in `shared/fixtures/relay-auth/manifest.json` keep both in line.

- **Relay → registry map:** `RELAY_AUTH_REGISTRIES` (Swift `RelayAuthWire.registries`, manifest field `registries`)
  maps an iroh relay in the canonical `r=` form to the origin of the Worker that keeps its registry:
  `https://relay.rarog.ai/` → `https://relay-auth.rarog.ai`. A relay outside the map, such as a user's own relay, has
  no registry. `server/test/relay-auth-mapa.test.ts` checks the map against `DEFAULT_IROH_RELAY`, `WORKER_URL` in
  `relay-vps/access-adapter.conf` and the route in `relay-auth/wrangler.toml`.
- **Routes:** app `POST /v1/app/register`, `renew`, `sponsor`, `forget` (signed with the app's iroh key);
  administrator `POST /v1/admin/deny` and `allow` (bearer); public `GET /v1/health`; the relay's hook `POST
  /v1/access`.
- **Bodies:** JSON with `v: 1`; fields are only added, unknown ones are skipped, a breaking change is `/v2/`. Times are
  integer epoch seconds. JSON routes carry `Content-Type: application/json` and `X-Rarog-Relay-Client` (the app sends
  `rarog-app/<version>+<build>`; at most 128 characters, a missing header is 400 `bad-request`).
- **Fields:** shared `endpointId` (64 lower-case hex), `issuedAt` (positive, at most 10 digits), `sig` (128 hex).
  `register` adds `proof {kind: devicecheck | apns, environment: development | production, token}`, with a token of
  the kind's shape (padded base64, or 32–512 hex characters; at most 8192 characters); `renew` adds `servers` (up to
  32, no repeats, the list may be empty); `sponsor` adds `server`, an EndpointId other than `endpointId`; `forget`
  adds nothing. A bad shape is 400 `bad-request`, and validation stops at the first bad field in this order: body,
  `v`, `endpointId`, `issuedAt`, route fields, `sig`.
- **Signature:** Ed25519 over UTF-8 lines joined with `\n`, without a final `\n`:

  ```
  rarog-relay-auth/v1
  <route path, e.g. /v1/app/renew>
  <endpointId>
  <issuedAt in decimal>
  <route fields, each on its own line>
  ```

  `register` gives `proof.kind`, `proof.environment`, `proof.token`; `renew` gives `servers` joined with commas;
  `sponsor` gives `server`; `forget` gives none. An `issuedAt` more than 300 s from the Worker's clock is 401
  `clock-skew`.
- **Responses:** `register` `{v, endpointId, expiresAt}`; `renew` `{v, expiresAt, unsponsored}`; `sponsor` `{v,
  server, expiresAt}`; `forget` `{v, forgotten: true}`; `deny` and `allow` `{v, endpointId, denied}`; `health` `{v, ok,
  version, gate, enforce}` (`gate` = the configured gate or `null`, `enforce: false` = shadow mode); `unsponsored` lists
  the servers without a live sponsorship of this app, for which the app calls `sponsor`. Errors are `{v: 1, error}`
  with the status from `RELAY_AUTH_ERROR_STATUS`; only `gate-mismatch` (400) also carries `gate`, and the Swift mirror
  keeps an unknown code as text.
- **`POST /v1/access`:** `Authorization: Bearer <hook secret>` and `X-Iroh-Endpoint-Id`; 200 with body `true` lets the
  key in, 403 with `false` refuses, anything else is no decision. In shadow mode (`ENFORCE` other than `1`) the answer
  is `true` for everyone. Quotas, the Apple gate and deployment: `relay-auth/README.md`.
- **Pairing over iroh in the app** (`RarogStore+RelayAccess` in `RarogCore`): a link with `k` and `r` (also with `u`)
  first asks the app's registry client to register the app and sponsor the link's server
  (`ServerConnector.relayPrepare`), then sends `POST /api/pair`; a link with `u` alone skips this. The client has an
  8 s budget, and the core waits for it at most 10 s and then pairs anyway, while the client goes on in the
  background. The pairing card stays `pairing` meanwhile, without Cancel; after any preparation result other than
  `fresh` it stays so during the pairing request too.
- **Readiness window:** when that call registered the app or sponsored the server (`fresh`), the relay may not let
  the server in yet, and the first pairing request often waits inside the transport until it does. The card turns
  into `waitingForRelay`, with Cancel, before that first request goes out. A transport failure of the request (no
  tunnel, offline, timeout; not an HTTP answer of the server) repeats it every 10 s with a new pairing transport, up
  to 60 s after the preparation ended. An HTTP answer or the end of the window ends pairing as without a registry.
  Cancel in `waitingForRelay`, also during the first request, ends pairing at once: a late answer saves no key and
  switches nothing, and a request that still reaches the server leaves a device record there that is no longer
  active after 10 min without a request.
- **Status and removal:** the client's statuses become `AppState.relayAccess`; Remove Me from the Registry calls the
  client's `forget` (`ServerConnector.relayForget`) once at a time and keeps the status it returns, unless the
  client reported a status meanwhile, which is newer.

### Idempotent send (`clientMessageId`)

`MessageBody.clientMessageId` is a UUID the client assigns once per message and sends unchanged with every retry (the
native app's outbox). `manager.sendMessage` checks it before all other gates:

1. Lookup by id, with a check of the content hash (`sendDigest` in `server/src/sessions/send-registry.ts`: sha256 of
   the text and, per attachment, kind, name, MIME and the sha256 of its bytes) and the session id.
2. An accepted entry → 202 `{ok: true, clientMessageId, replayed: true}` without a second send. An entry in progress →
   the same promise, so a second POST returns the first one's result.
3. Other content or another session → 409 `client-id-conflict` (`CLIENT_ID_CONFLICT_ERROR`), the only 409 of this
   route that is not `bad-state`; the client needs a new id.
4. A reservation in the same event loop turn as the start of the send; every refusal (400, 404, 409, 410, 429)
   releases it, so a retry with this id gets a new chance.

The registry is `<dataDir>/outbox-ids.json`. Only an acceptance (202) enters it, and the write reaches the disk before
the response (`tmp` + `rename`, `0600`); a write error keeps the 202 and logs `outbox-ids: write failed`. A corrupt
file gives an empty registry. Window 24 h (`SEND_REGISTRY_WINDOW_MS`), cap 2000 entries (`SEND_REGISTRY_MAX`; the
oldest drops out). A new acceptance answers 202 `{ok: true, clientMessageId}`. The echo carries
`clientMessageId`, and the client settles its outbox entry by it, with the content signature as the fallback.

**The guarantee is limited:**

- a process crash between `driver.send` and the registry write allows a duplicate on retry;
- 202 means accepted, not delivered: a driver failure becomes a system message in the transcript;
- the echo goes out before the 202, and a repeat with `replayed: true` has no echo of its own;
- a transcript rebuilt from jsonl after a Rarog restart does not carry `clientMessageId` (the CLI does not store it);
- a prompt sent during a turn is either run after the turn or absorbed into it (a `queued_command` attachment); the
  parser reads both as a `user` message, so the echo settles either way;
- `POST /api/sessions` with a start prompt is outside this mechanism; after 24 h, after the cap pushed the entry out,
  or after the file was deleted, the same id is a new message.

### Queued echo (`queueAware`)

`MessageBody.queueAware: true` says the client can wait for the echo. The server holds the echo when `RAROG_QUEUE_ECHO`
≠ `0`, the body has `clientMessageId`, the session is `running`, the server is not in demo, the message is
text alone, the driver's `defersEcho(text, slash)` agrees, and fewer than 8 echoes are held. Then:

- the manager keeps the message in `Session.heldEchoes`, and the driver registers a token in the follower's echo
  window; the 202 carries `queued: true`, also for a joined or replayed send that still waits;
- when the CLI takes the prompt (the measured queue: `docs/architecture.md`, "Prompt absorbed into a running turn"),
  the follower passes its file entry with `echoToken`, and the manager puts the held message in that place; a token
  entry matches only a file entry not older than the registration minus `ECHO_TOKEN_SKEW_MS` (2 s);
- a flush puts the message at the end of the transcript and logs `queue: <session> flushed <n>: <reason>`. The
  triggers, with the `<reason>` text of the log line in parentheses: the driver event `echo-refused` (`send did not
  reach the pane`), the follower event `echo-dropped` (`entry fell out of the echo window`), the driver event
  `turn-input` with `lost: true` (`gap in the transcript file`), 10 s after the session leaves the turn (`turn ended
  without taking the prompt`; a permission card does not flush the queue, and a return to the turn cancels the
  countdown), a send from Rarog to a session outside a turn (`send from Rarog after the turn`), a driver detach
  (`driver detached`), the end of its stream (`driver stream ended`) and age over `ECHO_TTL_MS` (`age over the echo
  window cap`);
- the 10 s flush and the flush at send first read the prompt field (`docs/dialogs.md`, "Prompt blocked by a hook";
  `RAROG_PROMPT_BLOCK=0` switches the read off): the message text in the field adds a "did not arrive" notice, other
  text a "not confirmed" notice, an empty or unreadable field after a paste whose text the driver never saw in the
  field (`unseen`, `docs/dialogs.md`, "Sending while a turn runs") a "not confirmed" notice without the field, and
  the log line carries `(field: <verdicts>)`;
- `dispose()` and Esc do not flush.

Without `queueAware`, with `RAROG_QUEUE_ECHO=0` and in demo the echo goes at once.

### Queue take-back

`POST /api/sessions/:id/queue/take-back` takes the queued prompts of a Claude pane back to the app: what waits in the
CLI queue and in the driver's paste queue leaves both, and the turn runs on. The keys, the proof in the transcript
file and the prompt field after it: `docs/dialogs.md`, "Taking the queue back". Body `{operationId}`
(`queueTakeBackBodySchema`): a UUID the client assigns once per take-back and sends unchanged with every retry; any
other body is 400 before the manager. Responses:

- **200** `{items: [{text, clientMessageId?}], incomplete?: true}` (`queueTakeBackResponseSchema`): one item per
  prompt, the CLI queue first, then the driver's queue, each in queue order; an empty list means nothing was queued.
  `clientMessageId` marks a message from the app whose echo the server held ("Queued echo"); a prompt typed at the Mac
  has none, and neither has a message pasted onto a draft at the desk, because the taken text is not the message
  alone. `incomplete: true`: part of the CLI queue stayed with Claude Code (the file proves fewer prompts taken than
  the queue held).
- **409** `bad-state` with `session.take-back.<reason>` (`dialog`, `draft`, `unknown`, `queue`, `busy`, `disk`), or
  `restart.in-progress` while a restart of the session is reserved. Nothing was taken and no key went.
- **410** `gone`: an unknown session (`rest.session-not-found`), a session without a driver or a driver refusal
  `pane` (`session.take-back.pane`).
- **400** `bad-request`: a pane out of scope, Codex included (`session.out-of-scope`), the herdr write channel closed
  (`RAROG_HERDR_SEND=0` or read-only herdr, `session.herdr-read-only`), or a driver without a queue
  (`session.take-back.no-queue`).

The manager module (`SessionTakeBack.take` in `server/src/sessions/session-take-back.ts`) looks the `operationId` up
before every gate: a retry while the take-back runs joins it, and a retry after its 200 gets the same body without a
second take-back. A refusal or a thrown gate frees the id, so a retry with it takes back again. Results live in RAM
with the session object, at most 32 per session, for 24 h after the 200 (`TAKE_BACK_RESULT_TTL_MS`, the window of the
send registry); after a server restart the same id is a new take-back. For every taken message with a held echo the
held message leaves `Session.heldEchoes` without a flush, so it does not come back at the end of the transcript after
the turn. The take-back counts as a mutation of the card: a restart requested meanwhile gets 409.

The route has no time limit of its own. The driver step waits up to 3 s for the `popAll` entries after `up` and up to
3 s more for a field caught half drawn (`TAKE_BACK_POP_WAIT_MS`), so about 6 s at worst, plus the first pass of the
field cleanup, the settling of the last Enter from the paste queue and any step ahead of it in the driver's chain
(a paste). An answer before the driver's result would carry nothing, and a client retry with the same `operationId`
joins the take-back in flight.

### Prompt blocked by a hook (`TranscriptMessage.promptBlocked`)

A `UserPromptSubmit` hook can stop a prompt before the model. The CLI then writes no `user` entry, only a `system`
entry with `promptSubmitEnding` (`docs/dialogs.md`, "Prompt blocked by a hook"). The server recognizes it by structure
(`ending.kind === blocked_by_hook`, `herdr/commands/transcript.ts`) and emits a `system` message with one text block
and the field `promptBlocked`:

- the block is the sentence `commands.prompt-blocked` with `ref` (variants `.reason`, `.prompt`, `.reason-and-prompt`):
  the title, the hook's reason (≤ 8 kB) and, in a notice without a prompt bubble, a quote of the prompt
  (`Prompt: …`), so a client without the field still shows a readable notice;
- `promptBlocked.reason` is the reason; `promptBlocked.prompt` (≤ 8 kB) only for a prompt typed in the terminal or
  read from history without a send echo. The notice is not turn input;
- a blocked send from Rarog returns the session from `running` to `waiting-input` (event `prompt-blocked`) only when
  it was the last open send of a turn opened from Rarog; a herdr turn end is then retracted (`retractTurnEnd`), so no
  `done` push goes out, and for 6 s a late `working` does not open a turn;
- `RAROG_PROMPT_BLOCK=0` switches recognition off.

The app draws a notice row from the field, and under the notice whose `seq` matches `SessionSummary.promptBlocked`
shows Restart and Send (`POST …/restart` with `{resend: {seq, id}}`, "Session restart on a newer release"). Golden
frames: `message.prompt-blocked*.json`, `transcript-snapshot.prompt-blocked.json`, and the summaries
`session-changed.prompt-blocked.json` and `sessions-snapshot.prompt-blocked.json`.

### Inbox

The server keeps one Inbox card per open Claude Code session in scope: the last message of the agent's latest turn
that ended with a result, waits for a decision or stopped (`server/src/inbox/`; the card rules stand in
`docs/architecture.md`, "Inbox cards (`server/src/inbox/`)"). A Codex pane, a pane out of scope and a closed session
have none. The capability `inbox` in `GET /api/version` and in the pairing response says the server has it.
`RAROG_INBOX=0` (`docs/server-config.md`) removes the capability and the events, and every route below answers 503
`inbox-disabled` (`rest.inbox-disabled`); `inbox.json` stays untouched. The demo has the same Inbox over its own
sessions (below).

- **Heads on the global stream.** Only a stream opened with `GET /api/stream?inbox=1` gets them: one
  `inbox-heads {heads}` right after `sessions-snapshot`, with every visible card newest first, then
  `inbox-head {head}` when a card becomes visible or its head changes, and `inbox-removed {sessionId, turnId}` when a
  card the stream knows leaves the visible cards (removed on any device, the session closed or its conversation
  changed). A head is `{sessionId, turnId, version, kind, state, at, dialog?}` (`shared/src/protocol/inbox.ts`),
  without the text: `turnId` and `version` are opaque, a new `version` means a changed card to fetch (new text, kind
  or dialog, or other buttons on its consent channel card); `kind` is `result`,
  `decision` or `failed`; `state` is the session state when the card was read (the app hides the card in `starting`
  and `running`); `dialog` (`permission`, `question` or `panel`) is on a decision card only. The three frames are
  volatile (`seq: null`, no `id:`, outside the ring buffer); a stream that opens after a change gets it in
  `inbox-heads`. A message during a turn sends no head, and a head that did not change sends nothing. A stream
  without `inbox=1` gets none of them, so an app that does not ask sees nothing new. A client drops only a head it
  cannot read (an unknown `kind`, `state` or `dialog`, `DEGRADATIONS['inbox.head']`) and keeps the rest of
  `inbox-heads`, so a card kind the app does not know does not empty its Inbox; a malformed head still
  rejects the frame, and a single unreadable `inbox-head` is ignored. The app's `GET /api/inbox` list drops an
  unreadable card the same way.
- `GET /api/inbox` → 200 `{cards}`: every visible card, newest first, as its head plus `text` (the last message of
  the turn, at most 12,000 Unicode scalars, cut from the start) and `truncated`. `GET /api/inbox/:sessionId` → 200
  `{card}`, or `{}` when the session has no visible card now; an unknown session → 404 `not-found`
  (`rest.session-not-found`). The `dialog` of a decision card here is the decision the session summary describes
  (`inboxCardDialogSchema` in `shared/src/rest.ts`): `{kind: permission | question, waitingFor?, requestId?}` or
  `{kind: panel, herdrDialog?, herdrDialogReason?}`. `requestId` is the `permId` or `qId` of the card in the session
  stream; the card itself, with its buttons, comes with the session stream. The routes never read the transcript,
  because that read marks every consent channel card of the session as shown on a device, also the cards the answer
  would not carry, and the next change of such a card then goes as `permission-settled`, which a client without the
  card drops, instead of `permission-pending`.
- `POST /api/inbox/:sessionId/remove` and `POST /api/inbox/:sessionId/restore` with `{turnId, version}` from the head
  (`inboxActionBodySchema`) → 200 `{ok: true, changed}`. `changed: false` = the card already was removed (restored),
  and nothing happened again. Another turn or version, or a session that moved while the card was read again → 409
  `inbox-card-changed` (`rest.inbox-card-changed`) without effect; a failed write of `inbox.json` → 500 `internal`
  (`rest.inbox-save-failed`) and the card stays; an unknown session → 404 `not-found`. Removing a `result` card of a
  session in `waiting-input` receives the result like `POST /api/sessions/:id/seen` from the app (a receipt by a
  person, with `agent.focus` for a standing `done`, "Presence, focus and seen"); removing a `decision` or `failed`
  card only hides it. A restore takes back a receipt the removal gave (`POST …/unseen`). `receipt: "skipped"` = the
  card is removed (restored), but its receipt did not happen (was not taken back), because no read confirmed the
  card's turn or the session moved before the write landed. Every removal and restore reaches every `inbox=1` stream
  as `inbox-removed` or `inbox-head`.
- **Demo.** The cards come from the demo sessions' messages in the server's memory instead of conversation files
  (`server/src/demo/inbox.ts`), and removals go to `inbox.json` of the demo data directory. A turn's identity there
  comes from the times the seeds get at start, so a removal does not survive a demo restart.

## State machine: a pure function

```ts
export type SmEvent =
  | { type: 'driver-init' }            // starting → running
  | { type: 'turn-start' }             // waiting-input|starting → running
  | { type: 'result'; subtype: 'success' | 'error_max_turns' | 'error' }
  | { type: 'permission-requested' } | { type: 'permission-resolved' }
  | { type: 'question-requested' }   | { type: 'question-resolved' }
  | { type: 'interrupt-requested' }  // → waiting-input (Esc = interrupt and keep typing)
  | { type: 'prompt-blocked' }       // starting|running → waiting-input
  | { type: 'driver-exit'; ok: boolean }
  | { type: 'limit-reached'; resetAt?: string }
  | { type: 'backend-restart' }      // any non-terminal → resumable
  | { type: 'closed' }               // → done
  | { type: 'resumed' }              // resumable|interrupted|limit-reached|error → running
  | { type: 'agent-working' } | { type: 'agent-idle' } | { type: 'agent-blocked' };   // herdr supervisor
export function transition(state: SessionState, ev: SmEvent): SessionState;
```

- `result success` → `waiting-input`; `error_max_turns` → `interrupted` with `MAX_TURNS_DETAIL`. `result` acts only
  during a turn; `driver-exit` and `limit-reached` only in live states.
- `interrupt-requested` gives `waiting-input`, not `interrupted`: terminal Claude Code muscle memory.
- An event unknown in a state is identity, never an exception. `done` is terminal.
- One rule lives in the manager, outside the pure function: a pane that Rarog launched does not enter `running` or
  `waiting-input` until it is ready. From `starting` such an event is identity: the `init` from the history of a
  resumed conversation (its model still reaches the card) and herdr's `idle` or `working`. A start dialog (trust
  dialog: `starting → waiting-permission`) is answered as usual, and when it closes before readiness the card goes
  back to `starting`; this is still the start, so it ends no turn and sends no "done" push. Failure and backend
  restart work as usual. Until readiness `…/messages` answers 409 `session.not-accepting-messages` in any state, so
  it cannot reach a pane that would answer `agent_not_ready`. After readiness the start prompt (`turn-start`) or the
  zero turn of an empty start moves the card on. A launcher result `{status: 'blocked', interactiveReady: false}`
  (the start stopped on the trust dialog) is not readiness for a start with a prompt: readiness is then the pane's
  `idle` after the dialog, and a pane that goes away first returns the prompt to the transcript (`docs/dialogs.md`,
  "Folder trust dialog without digits").
- `error` and `limit-reached` do not leave through `agent-idle`, because herdr's `idle` only sees a still screen;
  `agent-blocked` is accepted by `error`, `limit-reached` and `resumable`, because a dialog on the screen means
  someone resumed the turn at the desk.
- Tests cover every transition, the named races and a fast-check property: any sequence ends in a `SessionState`,
  and every non-terminal state has a way out.

### Esc fixes the state from the response, not from the push

`POST …/interrupt` answers `202 {ok: true, session, delivered, returnedPrompt?}`, where `session` is a fresh `SessionSummary` after the
transition (already `waiting-input`, because the transition is synchronous), and sends one `escape` to the pane. In
this section "push" means an SSE frame, not an APNs notification. An open session view learns of the interrupt from an
SSE frame, but a silently dead stream reports no error, and `activity` is volatile, so the client would otherwise wait
for the stall guard of the stream (15 s at a 10 s ping); the response travels on a new connection.

The client (`applyInterruptReply` in `RarogCore/Reducer+SessionControl.swift`) applies a pair: the card state from
`session` and a cleared activity, through one freshness gate. The gate passes only an existing card whose
`stateSince` is not lower than the known one (equality passes), because a late response must neither revive a closed
card nor move a new turn back to "waiting for you". `session` is optional: without it the SSE `state` frame fixes the
state, and the interrupt still counts as successful. A late `working` report from herdr is caught by the server's
grace period `INTERRUPT_WORKING_GRACE_MS` (6 s).

### `delivered`: did the key arrive

`delivered: 'yes' | 'no' | 'pending'` is additive (absent reads as `'yes'`). `SessionDriver.interrupt()` and
`ManagerApi.interrupt()` return `Promise<boolean>` ("the key went") but are not `async`, so the scope and killswitch
gates throw synchronously and stay a 400. The router maps the promise: `true` → `'yes'`, `false` → `'no'` (the driver
reports that the key did not reach the pane: a failed herdr call, a disposed driver, or an Esc refused on the
"Session paused" screen), no answer within `INTERRUPT_WAIT_MS` (3 s) →
`'pending'`; waiting longer would make the client retry (the app retries once after a network error, after 400 ms) and
send a second `escape`. One herdr error counts as sent: `herdr-stalled` (the key went out, herdr only saw no echo on
the screen) gives `true`, but only for a real `agent_prompt_stalled` (`stalledByRemoteCode`: `stallSource ===
'remote-code'`, or the error without that field).

A gate refusal (send killswitch, read-only supervisor, pane outside `RAROG_HERDR_ROOTS`, unknown session, restart in
progress, no driver) is an HTTP 4xx with a sentence, never a 202 body; the app keeps it apart from the key fates
(`InterruptOutcome`). Idempotency lives in the manager's `InterruptWindows`
(`server/src/sessions/interrupt-windows.ts`): `#interruptsInFlight` (a second request joins the same promise) and
`#lastInterruptAtMs` with a 1000 ms window (`INTERRUPT_DEBOUNCE_MS`). An accepted send clears both and restores them when a gate rejects it
(`suspendInterruptWindows`), so a refused send does not leave a fresh interrupt without its grace period.

### `returnedPrompt`: the prompt back in the field

On CLI 2.1.329 Esc puts the interrupted prompt back into Claude Code's prompt field only while the turn has shown no
text and no tool yet (only the spinner or thinking), the field is empty and the CLI queue is empty; herdr reports
`done` about 0.3 to 0.4 s after the key. Every other Esc ends the turn with "Interrupted · What should Claude do
instead?" and leaves the field as it was, empty or with its draft, and a queued prompt starts at once as the next turn.

Before the key the driver (`server/src/drivers/herdr/returned-prompt.ts`) reads the prompt field once (`visible` +
`ansi`, `composerFieldView`) and waits for it at most `FIELD_READ_BEFORE_ESCAPE_MS` (250 ms); a read that does not
answer in time proves nothing and the key goes at once. The read goes before the "Session paused" gate, so the gate
stays the last check before the key. Esc leaves a draft in place, so a draft equal to the prompt would pass for
a hand-back: only a field confirmed empty before the key lets the read after it prove one. After a delivered `escape`
the driver reads the field every `PROMPT_FIELD_POLL_MS` for at most `RETURNED_PROMPT_WAIT_MS` (1.2 s). The bound
races the read, so a screen read that never returns still answers in time. `returnedPrompt` carries the turn's
prompt only when the whole field (not cut at the top, not a history entry, no dialog or form over it) equals that
prompt without whitespace, the take-back's own-text rule (`showsTaken`).

The turn's prompt is the text the driver last sent to an idle pane, or the newest human prompt of the conversation
file (no notice, no command output, no image), taken right before the key; the answer is that text with its line
breaks, not the screen text. The file's history, read when the driver attaches and after a move to another
conversation, does not replace a prompt sent after that read began: the read can end after the send, and its entries
are older. A prompt typed at the desk after the send still counts when it arrives as a new entry of the file. A move
to another conversation drops the turn's prompt and the last answer.

- No read and no field: a pane other than `claude`, Rarog's paste queue holding a prompt or an unsettled Enter, the
  take-back holding the field, a dialog or permission card (a tool has shown), or no known prompt.
- No read after the key and no field: a field before the key that is not confirmed empty (a draft, an unreadable or
  late read, a dialog or form over it), or a key that did not go.
- No field after the read: an empty field or only the start of the prompt at the bound, a whole field with other text
  (a draft), a paste placeholder (`[Pasted text #1 +2 lines]` proves a line count, not the text), a newer send or
  interrupt, another conversation, or a disposed driver.
- A repeat of the request without a new key (the manager's debounce window) gets the last answer only while it is
  fresh: no newer send or interrupt, the same conversation, a live driver.
- One log line says that the prompt was handed back, without its text.

The router asks `ManagerApi.returnedPrompt(id)` only when `delivered` is `'yes'`, so `'no'` and `'pending'` answer
without a field read, and a delivered Esc that hands nothing back waits up to 1.2 s for its answer. The field is
additive: absent means that no hand-back was proven. The golden files hold both cases (`interrupt.json`,
`interrupt.returned-prompt.json`); the Swift type is `InterruptResponse.returnedPrompt` in `RarogContract`.

## Ring buffer

`RingBuffer<T>` (`server/src/sessions/ring-buffer.ts`): capacity `DEFAULT_RING_CAPACITY` = 500, `push(t)→seq`
(monotonic from 1), `since(seq)`, `tooOld(seq)` and helpers. A session caps it at `RING_MAX_BYTES` (4 MB), and a
message larger than `MAX_MESSAGE_BYTES` (256 kB) is clipped. A `seq` is valid only within one `serverStartId`.
A new card under an existing id (restart, "Resume") numbers on after the old card (`startSeq`): a cursor at or below
the old card's last `seq` is `tooOld`, and the open streams of that id get a `transcript-snapshot` of the new card
before its first frame.

There is no session registry on disk: a `<dataDir>/sessions.json` found at start is moved to `sessions.json.bak`.
Sessions come back after a restart from herdr's `agent.list`, with ids from `sessionIdFor(key)` (UUIDv5,
`server/src/herdr/identity.ts`). Only a session restart on a newer Claude Code release emits `backend-restart`.

## Driver interface (`drivers/types.ts`)

Source of truth: `server/src/drivers/types.ts`; the skeleton below shows the main variants.

```ts
export type DriverEvent =
  // model: the id RESOLVED by the engine; effort: what the engine really has (top-level `effort` in jsonl);
  // ultracode: the marker of the current CLI process, `null` = the proof stopped counting
  | { type: 'init'; engineSessionId: string; model: string; effort?: EffortLevel; ultracode?: boolean | null }
  | { type: 'delta'; text: string }
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; blocks: Block[];
      notice?: TranscriptNotice; echoToken?: string }
  | { type: 'permission-request'; reqId: string; toolName: string; input: unknown; displayText: string;
      alwaysLabel?: string; reason?: RefuseReason; screen?: string; cliDialog?: CliDialogClass }
  | { type: 'question-request'; reqId: string; questions: Question[]; channel?: QuestionChannel }
  | { type: 'git-status'; branch: string; dirtyCount: number; files: string[]; /* …as the SSE frame */ }
  | { type: 'result'; subtype: 'success' | 'error_max_turns' | 'error'; summary?: string }
  | { type: 'limit-reached'; resetAt?: string }
  | { type: 'exit'; ok: boolean; reason?: string };
export type DecisionOutcome =
  | { kind: 'applied' } | { kind: 'refused'; reason: RefuseReason } | { kind: 'stale' };
export interface SessionDriver {
  readonly ownsProcess: boolean;   // false = the process belongs to someone else's pane
  events: AsyncIterable<DriverEvent>;
  send(text: string, images?: readonly string[], files?: readonly FileAttachment[], opts?: SendOptions): void;
  respondPermission(reqId: string, decision: 'allow' | 'allow-always' | 'deny', message?: string,
  ): Promise<DecisionOutcome>;   // not `async`: the scope gates throw synchronously
  answerQuestion(reqId: string, answers: string[][], notes?: readonly (string | null)[]): Promise<DecisionOutcome>;
  interrupt(): Promise<boolean>;   // not `async`, as above
  // optional: defersEcho, sendCommands, setMode, restartProbe, requestExit, blockedLeftover,
  // clearBlockedLeftover, checkHeldLeftover, noteCliWaiting, noteCliProcessStart, noteUltracodeRequest,
  // takeBackQueue, returnedPrompt
  dispose(): void;
}
```

The optional methods are optional on purpose: for a driver without one the manager refuses explicitly instead of
pretending it sent. **`DriverFactory` does not exist and must not come back** (the note at the end of `types.ts`):
`server/src/herdr/launcher.ts` creates sessions, and `HerdrSupervisor.attach(key)` gives a driver for a ready pane; a
factory would only add a second creation path. The production driver is `drivers/herdr-driver.ts`; demo uses
`drivers/mock-driver.ts` and `ScenarioDriver` (`server/src/demo/scenarios.ts`) behind a fake supervisor.

The other event variants (comments in `types.ts`):

- `model-set` (`{model?, effort?, ultracode?}`): the pane accepted `/model` or `/effort`; an optimistic pill, no state
  transition.
- `activity`: a volatile "the agent does something" signal, never the content of thinking.
- `history`: the batch at attach; the manager appends it without a broadcast per message and without a git read.
- `agent-state` (`{state: 'working' | 'idle' | 'blocked', seen?, mode?, detail?, stateChangeSeq?}`): the herdr state;
  `seen` counts only as the transition `done → idle`, and the raw value stays in the internal `Session.herdrSeen`.
- `title`: the pane's conversation title changed. `detached`: contact lost while the engine lives (`stale`, not an
  exit).
- `screen-dialog` (`{knownDialog?, reason?, screen?, cliDialog?}`): a dialog in the pane that jsonl does not have;
  `knownDialog` comes only from the dialog block (`docs/dialogs.md`, "Dialog block") and is the only thing that
  enables the Allow button. `cli-dialog`: a class change on a standing card ("CLI session registry").
- `permission-cleared`: a human answered at the desk. `usage` (`{context: ContextLimitState}`): a state, because the
  window limit can be unknown.
- `background-tasks` (`{tasks}`): sent after the overlays from the files next to the transcript, the first one after
  attach always, then on change; an empty list clears the badge. A dormant subagent is left out
  (`background-tasks.md`, "Dormant").
- `artifacts`: the follower's list, passed 1:1. `pull-requests` (`{pullRequests}`): the list from the conversation
  files, only on a change of its signature; an empty list on attach is not sent (`pull-requests.md`).
  `scheduled-tasks` (`{scheduledTasks}`): the list from the main file, the first one after attach and after a
  conversation change always, also empty, then on change (`scheduled-tasks.md`).
  `prompt-blocked`: see "Prompt blocked by a hook". `echo-refused` and
  `echo-dropped` (`{token}`): a held echo gets no substitution; the manager flushes it.
- `turn-input` (`{lost?: true}`): `user` input this stream does not carry as a message (a subagent message, an
  automatic wake with `isMeta`, or a prompt from Rarog when its entry appears in the file). It reaches no client and
  only feeds the turn's tally `Session.turnInput`, which the push scheduler gets at the turn end
  (`NoteInput.turnInput`); `lost: true` admits a lost file continuity, and the manager treats the tally as incomplete.

### Decision contract: `applied | refused | stale`

The manager removes a pending entry only after the driver answers; a first-wins settlement before the driver call
would remove the card for good on any driver refusal while the dialog still stands in the terminal.

- `applied`: the key went; only this removes the pending entry.
- `refused`: nothing went; the card stays on the phone with the reason.
- `stale`: the target is gone; the entry expires with `permission-resolved` and `decision: 'expired'`.

A second decision on the same card while the first runs gets 422 `in-flight`, not 409, because nobody knows yet
whether the first one ends `refused`; 409 stays for a card already settled. A clear that takes the entry while the
driver works (interrupt, close, `permission-cleared`) wins: one `expired` goes out, the driver's result comes back as
410, and the driver gets no extra `deny` (an `escape` after the sent digit would rewind the dialog).

`RefuseReason` is one union (`REFUSE_REASONS` in `shared/src/protocol.ts`: `mismatch`, `unreadable`, `no-jsonl`,
`multi-select`, `no-digit`, `terminal-only`, `screen-changed`, `stale-card`, `form-submit`, `send-failed`,
`in-flight`, `consent-dialog`) for the audit log, the driver contract and the 422 body; human sentences in
`REFUSE_MESSAGES` (the English text of `dialogs.refuse.<reason>`). `mismatch`, `unreadable`, `no-jsonl` and
`consent-dialog` arise only while a card is evaluated, so they never come back as 422. `in-flight` comes from
`PendingInteractions` (`server/src/permissions.ts`) and does not enter the audit log.

HTTP codes for `POST …/permissions/:permId`, `…/answers/:qId` and `…/permission`:

- **200** `{ok: true}`: `applied`; the card disappears after the `permission-resolved` event.
- **409** `{error: 'conflict', message}`: the decision was already made elsewhere (another device or a first tap
  sent its key first); the client clears the card. A consent channel card stays with "decided on another device"
  under it, because `permission-settled` keeps changing it and it can still be released while the hook waits; it
  goes with `permission-resolved` or a 410.
- **409** `{error: 'bad-state', message}`: a manager gate, this card's decision cannot be sent this way (e.g. `allow`
  without digits or for an unrecognized dialog, multiple choice on the `keys` channel); the card stays with the
  server's sentence. A client tells the two 409s apart by `error`, not by the status.
- **410** `{error: 'gone', message}`: `stale` or expired; the card goes away without a decision.
- **422** `{error: 'refused', reason, message}`: the card stays and `message` (one sentence from `REFUSE_MESSAGES`)
  stands at the button; a separate code, because the client reads 409 `conflict` as "decided elsewhere".
- **400**: the scope and permission gates (a pane outside `RAROG_HERDR_ROOTS`, `RAROG_HERDR_SEND=0`) and, on
  `…/answers/:qId`, an answer this channel cannot send (a value over `MAX_ANSWER_TEXT_CHARS`, free text outside the
  option labels on `keys`, a note that breaks the `notes` rules). The manager checks these before the driver runs, so
  this code does not depend on how the decision ends.
- **404**: unknown session.

## ManagerApi

Source of truth: `server/src/sessions/manager-api.ts` (signatures, refusals and their codes in the method comments):

- `list()`, `get(id)`: summary snapshots.
- `create(opts)`: opens a pane in herdr and returns right after `tab.create` (the router answers 202). `prompt` is
  optional (an empty session waits for the first message); only `resume()` passes `sessionId`, so a resumed
  conversation keeps its card. With `resumeFrom` the mode and effort come from the transcript file.
- `sendMessage(id, text, images?, files?, clientMessageId?, opts?)`: asynchronous, because it reads the pane mode and
  writes attachments before the state transition.
- `resolvePermission(id, permId, decision, by, message?)`, `answerQuestion(id, qId, answers, notes?)`: gates throw
  synchronously; the result comes after the driver.
- `interrupt(id)`: the promise says only whether the key reached the engine.
- `returnedPrompt(id)`: the prompt Claude Code handed back to its field after the last delivered key, else `null`
  ("`returnedPrompt`: the prompt back in the field").
- `takeBackQueue(id, operationId)`: the queue take-back ("Queue take-back"); gates throw synchronously, a driver
  refusal rejects the promise.
- `close(id, {closePanel?})`, `resume(id)`, `restart(id, {resend?})`.
- `resumable(cwd)`, `recentResumable(cwd, limit?)`, `recentProjects(limit?)`, `projects()`.
- `models()` (the built-in list, also the allow-list), `commands(id)`, `setModel(id, {model?, effort?, ultracode?})`
  (the only path to `/model` and `/effort`), `setMode(id, {mode})` (the only path to `shift+tab`).
- `focus(id)` (moves someone else's terminal, so it obeys the send switch), `markSeen(id)`, `markUnseen(id)`.
- `diff(id)`, `diffFiles(id)`, `diffFile(id, path)`.
- `transcript(id)` (with `activity`, so a phone entering mid-turn does not see emptiness), `eventsSince(id, seq)`,
  `onEvent(cb)` (one `(scope, seq, event)` subscription for SSE), `onTranscriptReset?(cb)` (a new card under an
  existing id; the hub sends the open streams of that id a snapshot), `herdrStatus?()`.

Finished messages get a `seq` from the session's ring buffer; deltas get `seq: null`. `session-changed` and `state`
go to the `'global'` scope and to the session scope.

## Permissions + risk

First-wins per `permId`: the first decision gets 200 and a broadcast `permission-resolved`; a repeated one about a settled
card gets 409, a parallel one 422 `in-flight`, an unknown or expired one 410. Interrupt, close and restart broadcast
`expired` for pending entries.

`risk.ts` holds the red patterns, all case-insensitive: `rm`, `rmdir`, `dd`, `git push --force`, `git reset --hard`,
`sudo`, `curl … | sh`, `wget … |`, paths to the hidden directories with secrets, SSH keys and Claude settings in the
home directory (as `~`, `$HOME`, `${HOME}` or `/Users/<someone>`), `wrangler deploy` and `heroku`. The test has a
table of examples and a section of bypasses (`sh -c`, an env prefix, relative paths): the classifier is anti-fatigue
UX, NOT a security boundary.

## Demo mode (mock-driver + seeds)

`pnpm run demo:server` (`RAROG_DEMO=1 tsx server/src/index.ts`, with `RAROG_ORIGINS` covering the client's origin;
`scripts/ios-demo.sh` starts it so) runs the manager without herdr, on the fake `createMockHerdr`
(`server/src/demo/mock-herdr.ts`). The data directory is `os.tmpdir()/rarog-demo` without an explicit
`RAROG_DATA_DIR`, the client pairs with a code from `POST /api/demo/pairing`, the project allow-list comes from the
seeds (`/Users/demo/Projects/…`, the real `~/Projects` is not touched), and push is always off. The demo reads no
host data for the client: `GET /api/version` reports the fixed tailnet of the content set (`example.ts.net`) without
running `tailscale`, and the pairing answer names the server `Mac` (`DEMO_SERVER_NAME` in `server/src/demo/mac.ts`)
instead of the host name.
The text the client sees comes from one content set per language in `server/src/demo/content/`: `en.ts` and
`pl.ts`, contract in `types.ts`, picked by `demoContent(lang)` in `index.ts` of that directory. `RAROG_DEMO_LANG`
(`en` or `pl`, unset = `en`; `docs/server-config.md`) chooses the set. A set carries the project names, the seed
transcripts, "Resume existing" entries, the diff patch, the last commit subject, the note, the mock's replies and
triggers, the tailnet name, and the review-mode constants (server name, default model and effort). Both sets have
the same shape:
the same session IDs, states, message and block counts, and a trigger for every effect. The server `index.ts`
loads one set and passes it to the manager, `createMockHerdr` and the demo notes. The M1 scenarios
(`scenarios.ts`, `control.ts`) stay outside the sets and work only with `pl`, the language of the UI tests;
`scripts/ios-demo.sh` starts the demo with `RAROG_DEMO_LANG=pl`.

`RAROG_DEMO_CONTENT` picks a named set instead of the language set, only in the plain English demo
(`demoContent(lang, set)`): the module of that name in the set directory of the install (`DEMO_SET_DIR` in
`named-set.ts`, one resolver for the check at start and for the load), whose default export is a `DemoContent`. A
build without that directory has no named set. A named set can show session states that a seed cannot carry
(permission mode, background run, artifacts, pull requests, a git row with its own files, an approval with the
option of a live dialog, a question card of the hook channel) through the seed scenario's `scene`: driver events that
the mock driver emits right after `init`, so the manager takes them through the same pump as a live session. Artifact
and PR lists of a scene are built by the production readers from entries in the shape of the conversation file
(`DemoSeedKit.artifacts`, `DemoSeedKit.pullRequests` in `seeds.ts`). Two optional fields of `DemoContent` add data
outside the seeds: `extraUploads` puts images of the set's own messages into the demo uploads of a project
(`demoSeedUploads`), and `pullRequestStates` adds the states of the set's PRs to the fixed PR state map of the demo
(`demoPullRequestStates`).

Demo modules in `server/src/demo/`:

- `content/`: the language sets, their contract and the loader of named sets;
- `seeds.ts`: structure of the seeds (project roles and paths, seed building blocks, CLI notice shapes, seed
  photos), the diff and "Resume existing" builders;
- `mock-herdr.ts`: the fake supervisor with panes, launch limits and uploads in RAM;
- `notes.ts`: project notes in memory;
- `usage.ts`, `mac.ts`, `voice.ts`: fake plan limits, machine load and dictation key;
- `scenarios.ts`, `control.ts`: scenarios and the control route for the native UI tests;
- the mock driver itself is `server/src/drivers/mock-driver.ts`.

Projects have a role, which ties the structure (ahead/behind, the seeded note, the seed photos) to a name from the
set. Names per role, `en` / `pl`: `main` quill / willow, `stream` beacon / rarog, `cleanup` orbit-setup / fleet-ops,
`import` ledger-import / data-loader, `bridge` pulse-bridge / pipe-link, `panel` cedar-panel / map-view. Eight
seeds are created at every start:

1. **main** (`demo-willow`): `waiting-permission` for Bash `npm test -- --run src/notes.test.ts`, waiting for
   about 4 min, with a short markdown transcript and an `Edit` call.
2. **main**, second session (`demo-willow-parser`): `done` with a full markdown answer (table, quote, nested list).
3. **stream** (`demo-rarog`): `running`, streams markdown deltas without end in a deterministic cycle.
4. **cleanup** (`demo-fleet-ops`): red `waiting-permission` for `rm -rf ./dist && git push --force origin main`;
   `allow` ends with 422 `terminal-only`.
5. **import** (`demo-data-loader`): `done`, with a plan, four tool steps, a `Write` with a 50-line mini-diff and
   lists (XCUITest checks tool cards and the scroll-to-bottom button here).
6. **bridge** (`demo-pipe-link`): `resumable`, with three harness notices, photo and PDF descriptors (one photo
   after cleanup → 404) and an `image` block in the answer (XCUITest checks notices and thumbnails here).
7. **panel** (`demo-map-view`): `limit-reached` with `resetAt` in 2 h.
8. **stream**, second session (`demo-rarog-stop`): `running` with the driver in `idle`, for Stop and Esc tests.

The interactive mock: `send(text)` → the echo, after 400 ms (`REPLY_DELAY_MS`) about 60 words of deltas, a tool
call, a result and `waiting-input`; photos bounce back as `image` blocks. Prompt triggers are case-insensitive
substrings, kept literal because the code matches them:

- `question` → `question-request` (2 questions, one `multiSelect`);
- `dangerous` → red permission;
- `limit` → `limit-reached` (`resetAt` in 2 h);
- `crash` → exit.

The `pl` set has the same effects in the same order:
`pytanie`, `czerwone`, `limit`, `błąd` or `blad` (XCUITest sends them).

`git-status` goes out after every tool call from the table `DEMO_DIFF_FILES`, shared with `demoDiff`. The mock's
clocks run on an injected `Scheduler` (`server/src/drivers/runtime.ts`), so tests do not wait. Dictation in demo
(`server/src/demo/voice.ts`) gives a fake key and never calls Soniox.

## Client: the native app

The only Rarog client is the iOS and iPadOS app in `native/Rarog` (Swift 6); structure and code rules:
`native/Rarog/README.md`.

- **Packages:** `RarogContract` (frame and body types, the decoder, golden frames), `RarogTransport` (SSE, REST with
  the device key, `Origin` on mutations, the mutation gate, the terminal socket, the iroh tunnel, the relay registry
  client), `RarogCore` (store, reducers, connection loop, outbox, the transport switch between iroh and HTTPS),
  `RarogIroh` (the only package that imports the iroh library), `RarogUI`, `RarogTerminal` (SwiftTerm),
  `RarogActivity` (Live Activity); outside them the targets `RarogWidgets`, `RarogNotificationService`,
  `RarogUIKitTests`, `RarogUITests`.
- **Principle:** the app displays a contract with semantic fields and knows no CLI tool names, channels or texts
  (`SourceGuardTests`), so a change of Claude Code or herdr is a server change, not a new app version.
- **Authentication:** only the device key ("Device keys and pairing"), kept in the Keychain; `URLSession` has no
  cookie store.
- **Gates:** `bash scripts/ios-check.sh` (every package's `swift test`, then XCUITest against a fresh demo server);
  `pnpm run check` runs the `RarogContract` tests as the `swift-contract` step.

## Scripts (root, run with pnpm)

`pnpm test` → `vitest run` · `pnpm run typecheck` and `pnpm run build` → `tsc -b` · `pnpm run demo:server` →
`RAROG_DEMO=1 tsx server/src/index.ts` · `pnpm run check` → `scripts/check.sh` (typecheck, tests, the `swift-contract`
step, the push relay and registry checks, `git diff --check`, shell and TOML checks, a zizmor audit; no effect on
production).

## Message attachments

- `MessageBody.images` (at most `MAX_IMAGES_PER_MESSAGE` = 5 png or jpeg data URLs, each up to
  `MAX_IMAGE_DATA_URL_BYTES` = 1.5 MB; the app shrinks photos itself) and `files` (at most `MAX_FILES_PER_MESSAGE` =
  4 data URLs of any type up to `MAX_FILE_DATA_URL_BYTES` = 27 MB, names up to `MAX_FILE_NAME_CHARS` = 120). Text is
  capped at `MAX_MESSAGE_TEXT_CHARS` = 1 048 576 characters, and the herdr channel adds a lower byte cap
  (`MAX_HERDR_PROMPT_BYTES`, 512 kB).
- `checkMessageImageLimits` checks counts and sizes on the raw body before the schema: excess is 413, a bad shape 400.
  This route's body cap is `MAX_MESSAGE_BODY_BYTES` = 120 MB.
- `IMAGE_DATA_URL_PATTERN` passes only png and jpeg base64 data URLs; this is a security boundary, because
  `data:text/html` or SVG can run a script in a client.
- Files are written to `<session cwd>/.rarog-uploads/` under `UPLOAD_IMAGE_FILE_PATTERN` and never overwritten; the
  prompt gets one block of paths (`appendAttachmentPaths`). Directory and cleanup rules: the uploads item in
  `docs/security-model.md`, "herdr sessions: Rarog writes to a terminal it does not own".
- The user echo carries descriptors, not bytes. A message of attachments alone is valid: the prompt is
  `ATTACHMENTS_ONLY_PROMPT` plus the paths, and the echo has `blocks: []`.
- `GET /api/sessions/:id/uploads/:file` → 200 with the photo bytes (`image/png` or `image/jpeg`, `Cache-Control:
  private, max-age=172800, immutable`, `X-Content-Type-Options: nosniff`); 404 for an unknown or out-of-scope session,
  a Codex entry, a bad name, a missing file or a symlink; 405 for another method. The directory comes from the
  session, and the name must match Rarog's pattern. Demo reads photos from its memory (seeds and sent photos, cap 64).

## Git in a session

Rarog only reads git: `git status --porcelain=v2` in the session directory, without `fetch`. Every git process gets
`-c core.fsmonitor=false -c log.showSignature=false` (`GIT_CONFIG_GUARDS`), and every `git diff` also `--no-ext-diff`
and `--no-textconv`, so the repository config cannot run another program; argv below omits these guards. Threat
model: `docs/security-model.md`, "Git reads".

- `ahead?` and `behind?` from `# branch.ab`; no upstream = no fields. `fileKinds?: {added, modified, deleted}` sums to
  `dirtyCount`. `lastCommit?: {hash, subject, at}` from `git log -1`.
- `fileDetails?` (only in the `git-status` frame): one entry per dirty file, `{path, kind, linesAdded?, linesDeleted?,
  binary?}`, in the order and the cap of 50 of `files`; a missing count means unknown, not zero, and `binary: true`
  means git does not count lines. A frame without the field replaces the previous frame's details.
- Counts come from `git --literal-pathspecs diff --no-ext-diff --relative --numstat -z HEAD -- <paths>` within 1.5 s
  (`GIT_NUMSTAT_BUDGET_MS`); untracked files, paths outside the session directory and quoted paths get none.
  `RAROG_GIT_FILE_DETAILS=0` drops the field and the third git process.
- The next read trigger (a tool call after the throttle, a turn end, `.git`, entering the session) refreshes the frame;
  a client entering within the throttle window gets the last broadcast frame again after `transcript-snapshot`.

### Session diff

`GET /api/sessions/:id/diff` → `{files: [{path, status: 'A'|'M'|'D', linesAdded, linesDeleted}], patch, truncated}`:
`git diff HEAD` with `--numstat`, the patch up to `MAX_DIFF_PATCH_BYTES` = 512 kB, only the session directory
(`--relative`). An untracked regular file enters through `--no-index`; a symlink gets a block the server builds (mode
`120000`); directories and special files are skipped. An out-of-scope session or a Codex entry gets 400. The app's
diff window uses the per-file routes instead.

### Per-file diff

Collectors in `server/src/git-diff.ts`, schemas in `shared/src/protocol/diff.ts`:

- `GET /api/sessions/:id/diff/files` → `{files: DiffListEntry[], truncated}`, `DiffListEntry` = `{path, status,
  linesAdded?, linesDeleted?, binary?: true}`: tracked files from `git diff --name-status -z HEAD`, then untracked
  ones from `git ls-files --others --exclude-standard -z`; literal relative paths; a rename is an `M` under the target
  path. Counts only for tracked files and only within 1.5 s. Cap `MAX_DIFF_LIST_FILES` = 500.
- `GET /api/sessions/:id/diff/file?path=<path>` → `{path, patch, truncated}`; a patch can hold more than one block (a
  type change, or a path on both lists). The path is used only when it stands on git's full lists from the same call.
  Cap `MAX_DIFF_FILE_PATCH_BYTES` = 512 kB, cut at a line boundary; `truncated: true` also when git reached the read
  cap (8 MB). The client encodes `+` as `%2B` (a plus in a query is a space).
- Refusals `{error, message}`: 400 `bad-path` (empty, NUL, over 4096 bytes, leading or trailing `/`, `.` or `..`
  segments); 404 `diff-file-not-found`; 404 `session-not-found`; 400 `bad-request` (Codex, out of scope); 503
  `git-failed` (timeout, failed start, signal, a refused `diff HEAD`). A directory outside a repo is 200 with an empty
  list.
- Known gaps: in a repo without `HEAD` a file added to the index is not listed; a file name that is not valid UTF-8
  gives 404; the entry of a deleted file whose place a directory took also carries the blocks of files under it (the
  pathspec matches descendants).
- A server without these routes answers 405 `method-not-allowed`. Demo: `demoDiffFiles()` and `demoDiffFile(path)`;
  the demo control (`/api/demo/control`) counts the requests and can hold, fail or lengthen a patch for diff window tests.
- Each request that reached git logs `git: diff list|file <ms> ms`, without the path.

## Session files

`GET /api/sessions/:id/files?dir=<rel>` lists one directory of the session; `dir` is relative to the session
directory (`session.cwd`), segments joined with `/`, and empty or missing means the session directory itself. Code:
`server/src/files/` (the gate, the path rule, the listing, the labels, the download); types and schemas in
`shared/src/protocol/files.ts` and `shared/src/rest.ts`. What the server never shows or sends and why:
`docs/security-model.md`, "Session files: listing and download".

- 200 `FileListing` = `{dir, entries: FileEntry[], truncated, maxBytes}`, `FileEntry` = `{name, kind: 'dir' | 'file',
  size?, ignored?: true}`. `dir` echoes the request; `size` (bytes, from `lstat`) is set for files only. The server
  reads the whole directory, sorts it with `compareFileEntries` (directories first, then by the lowercased name, then
  by the name itself, both by UTF-16 code units) and cuts it to `MAX_FILE_ENTRIES` = 1000 with `truncated: true`.
  `maxBytes` is `RAROG_FILES_MAX_MB` in bytes (50 MiB by default): the file size limit every listing announces.
- Left out: a name that starts with a dot, `node_modules` in any letter case, a symlink, a special file (FIFO,
  socket, device), a file with more than one hard link, an entry outside the work area (a macOS-protected folder of
  home under the root `~`) and a name that is not valid UTF-8. A directory the server may not read (`EACCES`,
  `EPERM`) gives an empty listing.
- `ignored: true` marks an entry git ignores, from `git check-ignore` run in the listed directory, so a nested
  repository or a submodule answers with its own rules. The label hides nothing: an ignored entry is listed like any
  other. A git failure (outside a repository, a broken `.git`, a timeout) drops every label of the listing and keeps
  the listing. A file git tracks is never labelled, even when a rule matches it. An empty directory runs no git.
- Refusals `{error, message}` (codes in `shared/src/protocol/files.ts`): 400 `bad-path` (empty segment, `.` or `..`,
  a leading or trailing `/`, NUL, over 4096 bytes); 400 `codex` (a Codex entry); 400 `out-of-scope` (a pane outside
  the work area of `RAROG_HERDR_ROOTS`, a session directory outside it on disk, a session without a herdr pane);
  404 `not-found` (the directory does not exist, the server never shows it, or it changed while it was read; one
  answer, so it tells nothing apart); 404 `session-not-found` (unknown session); 405 for another method. The device is
  checked again after the read, so a device unpaired meanwhile gets 401 and no listing.
- `RAROG_FILES=0` (`docs/server-config.md`): the route answers 404 as an unknown route for every method, and
  `GET /api/version` drops the `files` capability.
- Demo: every demo session lists one fixed project from memory (`server/src/demo/files.ts`, `demoFileEntries`), with
  no disk and no git; it agrees with the demo diff, and its `dist` directory is labelled ignored.

`GET /api/sessions/:id/files/index` gives the paths of the session's files in one response, for the app's file
search; the server matches no query. Code: `server/src/files/file-index.ts`; announced with the `file-index`
capability.

- 200 `FileIndex` = `{paths: string[], truncated, maxBytes}`. `paths` are regular files under the session directory,
  relative to it, segments joined with `/`, in the order of a breadth-first walk: each directory's files in the order
  of its listing, then its subdirectories in turn. `maxBytes` as in a listing, so a preview from a search result does
  not wait for one.
- Every walked directory is read by the listing above, so the index leaves out what a listing leaves out. A
  directory whose listing is refused (swapped, gone) is skipped; a session directory refused that way is 404
  `not-found`.
- Scope from git: inside a repository, `git ls-files -z --cached --others --exclude-standard` run in the session
  directory gives the files git does not ignore. The walk enters only directories above such a file and keeps only
  such files; a nested repository or a submodule (a directory `ls-files` names but does not expand) is walked whole,
  without the filter. Git only narrows: a path git names that the walk does not find is not in the index. Outside a
  repository, or when git fails (a broken `.git`, a timeout, output over the read cap), every file the rule allows,
  ignored ones too.
- Names, one rule for files and directories, per listed directory: a name git gives goes to the entry with exactly
  its bytes; otherwise to the one entry that no git name matched exactly and has the same name in NFC and lower case
  (git on macOS composes decomposed names, and with `core.ignorecase` keeps a name renamed only in letter case under
  its old spelling); with two or more such entries, to none. Only entries a git name goes to are walked or indexed,
  and every path carries the name from the listing.
- `truncated: true` when a directory had more than `MAX_FILE_ENTRIES` entries, or the walk stopped at a ceiling:
  20 000 paths, 2 MiB of JSON body, or the soft budget of 3 s (the git read included), checked between two
  directories.
- One walk at a time per session directory: a request that comes while one runs gets its answer; a finished walk is
  not kept. The gate runs for every request, and the device is checked again after the walk, per request.
- Refusals as on the listing: 400 `codex` | `out-of-scope`; 404 `not-found`; 404 `session-not-found`; 405 for another
  method; `RAROG_FILES=0` → 404 as an unknown route and no `file-index` capability.
- Demo: the files of the fixed project from memory that its git does not ignore (no `dist`), with no disk and no git.

`GET /api/sessions/:id/files/raw?path=<rel>` sends the bytes of one file of the session; `path` is relative to the
session directory like `dir`. The query is decoded as a form, so `+` reads as a space and a plus goes as `%2B`. Code:
`server/src/files/session-download.ts` (the open and the limit) and `server/src/files/send-file.ts` (the sender and
the downloads in flight by device).

- 200: `Content-Type: application/octet-stream`, `Content-Length` = the size from the `fstat` of the open descriptor,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, then exactly `Content-Length` bytes from that one
  descriptor, read in pieces of 64 KiB at their own offsets (`exactReader` in `server/src/safe-read.ts`). Bytes
  appended while the file is sent are not sent. A file that ends before `Content-Length` bytes (cut while it is
  sent) gets its response destroyed: the client sees a body shorter than `Content-Length` and drops it. There is no
  `Range`: every download sends the whole file.
- 413 `file-too-large` = `{error, message, size, maxBytes}` (`FileTooLargeBody`): `size` from the same `fstat` is over
  `maxBytes` (`RAROG_FILES_MAX_MB` in bytes, the value every listing announces); refused before the first byte, with
  the descriptor closed. The sentence gives both in whole megabytes, the size rounded up.
- Refusals as on the listing: 400 `bad-path` | `codex` | `out-of-scope`; 404 `not-found` (also a directory, a
  symlink, a special file, a file with more than one hard link, a file swapped while it was opened); 404
  `session-not-found`; 405 for another method; `RAROG_FILES=0` → 404 as an unknown route. A file git ignores is sent
  like any other.
- The device is checked again after the open and before the headers, so a device unpaired meanwhile gets 401 and no
  byte. Unpairing a device destroys the responses of its downloads in flight and closes their files, over TCP and
  over iroh; a client that goes away closes the file too.
- Demo: the file of the fixed project from memory (`demoFileBytes`), with no disk call.

## Projects, directories and resumable sessions

`waiting-input` does NOT mean "waiting for you": the agent finished. Waiting for a human is only `waiting-permission`
and `waiting-question`; the client builds the attention lane from these two states.

**Project roots.** `RAROG_PROJECT_ROOTS` is a comma-separated list (`~/Projects` when unset; `rarog setup` suggests
`~`). Every `cwd` (sessions, resumable list, notes) goes through `checkCwd` in the router and again through
`validateProjectCwd` in the manager: an absolute path, no hidden segments, in the work area of the roots
(`docs/security-model.md`, "Work area: where Rarog starts, lists and reads"), an existing directory that stays in the
work area also after resolving symlinks; a refusal is 400 `cwd-not-allowed`. A macOS-protected folder of home is
refused before any disk access, with the sentence `rest.cwd-protected`.

**Directory browser** (`server/src/fs-browse.ts`): `GET /api/fs?path=…` → `DirListing`. Without `path`, the
roots; with `path`, a path equal to or inside a root, in the work area as written and after resolving symlinks, with
no hidden segment below the root (else 400 `path-not-allowed`, a missing path 404). A macOS-protected folder of home
is refused before any disk access, and the symlink walk stops before one. Directories only (symlinks are not
followed), no hidden ones, no `node_modules`, only folders in the work area (with the root `~` the protected folders
of home are not listed and get no `stat`), sorted with `localeCompare('pl', {sensitivity: 'base'})`; `git` =
`<dir>/.git` exists, `history` = `~/.claude/projects/<projectSlug(dir)>` exists; over `MAX_DIR_ENTRIES` (300) →
`truncated: true`. `EACCES` gives an empty list. `parent` is `null` for a root and the dirname deeper. The listing of
a directory also carries `git` and `history` of that directory itself, with the meaning of the row fields; the roots
level carries neither, and a listing without them (an older server) leaves them unknown, so the app treats the
directory as unknown. The listing of a directory also carries `canCreate`: `true` when this server creates
directories (below), `false` in the demo and with `RAROG_HERDR_LAUNCH=0` or `RAROG_HERDR_SEND=0`; the roots level
has no such field, and a missing field means no. Demo builds the listing from the seed projects (a
project listing: `git` and `history` `true`, `canCreate` `false`).

**Creating a directory** (`server/src/fs-mkdir.ts`): `POST /api/fs/mkdir {parent, name}` → 200 `DirEntry` of the new
directory, `path` = `parent` joined with the name in NFC (the form a listing of `parent` gives), `git: false`,
`history` as in a listing. The body schema `makeDirBodySchema` checks the shape only (two strings, ceilings of 4096
and 1024 characters); the name rule and the order of checks: `docs/security-model.md`, "Creating a directory from the
New Session form". `parent` is a directory the browser lists. Refusals (`*_ERROR` in `shared/src/rest.ts` beside the
codes of the listing):

- 409 `mkdir-disabled`: the demo, `RAROG_HERDR_LAUNCH=0` or `RAROG_HERDR_SEND=0`;
- 429 `mkdir-busy`: another directory is being created;
- 400 `dir-name-invalid`: the name breaks the rule or names a folder the listing hides;
- 400 `path-not-allowed`: the parent or the new path is outside the work area, or the parent moved before the child
  entered it;
- 404 `not-found`: the parent does not exist;
- 409 `dir-exists`: something already has that name (a directory, a file or a symlink); nothing is overwritten;
- 500 `internal`: any other failure, the child did not start or did not answer in time.

Review mode has no route (404 before routing).

**Recent projects.** `GET /api/projects/recent?limit=` → `{projects: [{cwd, mtime}]}`, at most `MAX_RECENT_PROJECTS` =
13 (twelve chips plus the current project, which the app leaves out), only paths from the allow-list
(`server/src/sessions/recent-projects.ts`). A project is the exact `cwd` of its sessions, without lifting to the
repository. The list holds the Claude Code sessions of the last 7 days and the directories of open Rarog sessions (a live
pane), whatever the age of their history. The session reader is asked with `since`, so it reads past the fetch cap
of 300 to the 7-day boundary, and the allow-list filters before the limit. Order: projects with an open session
first, then the rest, each newest first; `mtime` is the newest session in the directory (an open one counts with its
last activity). A store failure leaves the open projects.

**Resumable sessions.** `GET /api/resumable?cwd=` → `{sessions: ResumableSession[]}`: up to `MAX_RESUMABLE_SESSIONS` =
20 conversations of the directory from `listSessions()` (`server/src/session-list.ts`). An entry is `{engineSessionId,
cwd, mtime, firstPrompt (≤ 120 characters), gitBranch?, liveInHerdr, title?, sessionId?}`. `liveInHerdr: true` means
the conversation is open in a live pane: it has no Resume (two writers on one jsonl), `POST /api/sessions` with that
`resumeFrom` and no `fork` gets 409, and the entry carries its card's `sessionId`. A store failure gives an empty
list. `GET /api/resumable/recent?cwd=&limit=` gives up to `MAX_RECENT_SESSIONS` = 10 recent conversations, without
open ones.

**Resume** is `resumeFrom` (optionally with `fork`) in `POST /api/sessions`; the server checks the `cwd` from the
transcript, so a conversation from another directory or without a file gets 400.

**Ultracode on resume and restart.** `--resume` starts the process without ultracode, which comes back only with the
flag `--effort ultracode`, and that flag sets `xhigh`. The server inherits it only when the conversation ended on
`xhigh`: on a resume from a file, when the last marker in the file's tail says "on" and the request gives no model; on
the card's Resume and on restart, when the card has `ultracode: true` (`false` blocks inheriting; no field leaves it
to the file). Another level, or an installed Claude Code below `ULTRACODE_MIN_CLI` or unknown, starts without
ultracode with the notice `RESUME_WITHOUT_ULTRACODE_MESSAGE`, never a 400. A resumed process with the flag has no
`ultra_effort_enter` in its first turn (measured on CLI 2.1.318), so the first-turn rule is armed only for a new
conversation.

## Session label

`SessionSummary.title` = basename(cwd) is the project part of `project · session`; `label` is the session part. Rules
in `server/src/session-label.ts`: `labelFromPrompt` takes up to 5 words that fit `MAX_LABEL_LENGTH` = 28 characters
(only a single long word is cut with an ellipsis). A session created from Rarog takes the label from its start prompt,
or a numbered fallback until the first message; a pane found in herdr takes the conversation title (a `title` event,
e.g. after `/rename`, moves it). `normalizeSessionLabel` cleans every label. The herdr tab label follows the card
(`RAROG_HERDR_TAB_LABELS`).

## Transcript import from jsonl

`server/src/transcript-import.ts` parses the CLI store (`~/.claude/projects/<projectSlug(cwd)>/<uuid>.jsonl`),
read-only; the follower (`herdr/jsonl-follow.ts`) reads lines with it, and `ENGINE_SESSION_ID_PATTERN` guards every
identifier that enters a path. `importTranscript` reads only the tail (`MAX_IMPORT_BYTES` = 2 MB) and is kept by its
own tests.

- A cut first line and a corrupt line are skipped; no file gives an empty list, never an exception.
- Sidechain entries, compaction summaries and `isMeta` entries are not conversation (an `isMeta` entry gives at most a
  photo name); a `system` entry is a message only as a command entry or a blocked prompt; an `image` block from disk
  becomes the text `IMAGE_PLACEHOLDER`, never a data URL from someone else's file.
- Assistant `text` → text, `tool_use` → `tool-call`, non-empty `thinking` → text (observed in the transcript
  fixtures); consecutive assistant entries up to the next human message are joined into one message.
- `at` comes from `timestamp`; the result is clipped to `MAX_TRANSCRIPT_MESSAGES` (500); model and effort come from
  the last readable assistant entry.

## Model, effort and permission mode

- `SessionSummary.model` is the id resolved by the engine (e.g. `claude-fable-5-1`), not the alias from the form, and
  `effort` a level from `EFFORT_LEVELS` (`low`, `medium`, `high`, `xhigh`, `max`); the client formats the pill
  (`formatModelLabel`). The driver's `init` carries a model or effort only when the transcript newly shows it (an
  entry that changed a known value); an `init` caused by ultracode alone leaves the values that a live change
  (`model-set`) put on the card.
- `SessionSummary.ultracode` (optional bool; `null` rejects the frame) is the CLI session's ultracode, under which
  Claude plans a workflow for every task. The manager copies it from the driver's `init` and `model-set`; a missing
  field means the server does not know. A pane started with ultracode shows `true` and `xhigh` at once; after that
  the transcript file decides.
- The herdr driver reads the markers (`ultracodeMarkerOf` in `herdr/ultracode.ts`: the first turn's
  `ultra_effort_enter|exit` attachment and the command result; excerpts from CLI 2.1.318 in the `ultracode/`
  fixtures), and `createUltracodeTracker` (`herdr/jsonl-pending.ts`) holds the rules: only a marker not older than the
  CLI process start counts, the last marker wins; after a requested switch-on, the first answer to a newer human
  prompt without a marker gives `false`; a read gap, a new conversation in the pane and a new CLI process of the same
  conversation reset the field (`init` with `ultracode: null`).
- `GET /api/models` → `{models}`: a built-in list, `DEFAULT_MODEL_CHOICE` (empty `value` = no `--model` flag) then the
  aliases `fable`, `opus[1m]`, `sonnet` and `haiku` from `FALLBACK_MODEL_CHOICES`. `ModelChoice.ultracode: true` marks
  the models the server can switch ultracode on for (`fable`, `opus[1m]`, `sonnet`). A model outside the list is 400
  `model-unknown`; effort outside a model's levels is not a server error.
- `POST /api/sessions` passes `model`, `effort` and `permissionMode` (`PERMISSION_MODES`: `manual`, `acceptEdits`,
  `auto`, `plan`, `bypassPermissions`) through a closed flag list (`herdr/argv.ts`); `bypassPermissions` requires a
  directory from `RAROG_YOLO_ROOTS`. `ultracode: true` puts `--effort ultracode` in place of `--effort xhigh` and
  requires an installed Claude Code ≥ `ULTRACODE_MIN_CLI` (2.1.284), else 400 `ultracode-refused`
  (`ULTRACODE_REFUSED_ERROR`), before anything happens in herdr; demo skips the gate.

**Changing the model of a live session.** `POST /api/sessions/:id/model` (`sessionModelBodySchema`: `{model?, effort?,
ultracode?}`, at least one) → 202 `{ok: true, warning}` with `MODEL_CHANGE_WARNING` (the global effect of `/model`) or,
for ultracode alone, `ULTRACODE_CHANGE_NOTE`. It is the only path to `/model` in Rarog (the send guard rejects free
text `/model` and `/effort`). The server builds the commands from allow-list values (`modelCommands`: `/model
<alias>`, `/effort <level>`, then the ultracode form) and passes them by an internal path that allows only those
shapes. Gates before the first byte: no command channel, a model off the list, out of scope or `RAROG_HERDR_SEND=0` →
400; a restart in progress → 409; ultracode with a process version below `ULTRACODE_MIN_CLI` or unknown → 400; a
session outside `waiting-input` → 409; an unknown mode outside `RAROG_YOLO_ROOTS` → 400; the throttle → 429. Before
each command of the batch the driver reads the whole CLI prompt field, because `agent.prompt` presses Enter after the
text: Rarog never sends a command into a field that holds other text. Text that Rarog left there (an interrupt, a
stalled or hook-blocked prompt) is cleared first with the Esc pair, as before a send. An empty field → the command;
a field with text → no keys and the system message `model.change-unsent-prompt.mac` or `.vps`; a field that cannot be
read (a dialog, no field frame, a read error) → no keys and `model.change-composer-unknown`. A command that was not
sent emits no `model-set`. A confirmation dialog after the command is handled from the screen; the result comes back
as a system message, and the ultracode result line changes the card at once. The driver reads the screen for about
5 s after each command (`MODEL_CONFIRM_ATTEMPTS` × `MODEL_CONFIRM_POLL_MS`). A dialog or an in-place result line ends
the wait early. For `/effort <level>` the result line is accepted only under a fresh echo: the screen must show more
`❯ /effort <level>` echoes than the read taken before the send. After the driver sent its own digit to
a command dialog, whether or not the send reported success, the next queued step (the next command of the batch, a
message right behind it, or a mode change) first waits for that dialog to leave (`CommandDialogSettle`): it reads the
screen every `MODEL_CONFIRM_POLL_MS`, at most `MODEL_CONFIRM_ATTEMPTS` times, until the prompt field is back and the
CLI registry hold is gone. Only after the wait does a message choose between
the paste queue and `agent.prompt` and do the send gates run, so a block or a registry signal that arrives during the
wait decides the path; the `202` of that message comes after the wait. A wait that did not read the prompt field
back (another dialog, the answered one still drawn at the bound, or a screen that stayed unreadable) keeps the step
out of the prompt field: a message to a Claude pane waits in the paste queue until the dialog ends, a command or a
mode change is refused. Every queued step behind it is held the same way until a read shows the prompt field without a registry
hold; time alone does not release it. Once `ANSWERED_HOOK_SHIELD_MS` has passed since the digit, a step makes one read
instead of the whole wait. The answer shield of the driver's digit covers only the block that stood when the digit
went; a block that begins during the send gets its own card. Each command of the batch emits its own `model-set` and
adds one `server.log` line with the command, the outcome (`confirmed`, `inline`, `no-dialog`, `foreign`, `refused`)
and the milliseconds since the send.

**Changing the mode.** `POST /api/sessions/:id/mode` (`{mode: 'plan' | 'auto'}`) → 202 `{ok: true}`, with the same
gates; the start mode must be known and not `bypass`. The driver presses `shift+tab` and reads the footer after each
press (`herdr/mode-cycle.ts`). The mode chip (`herdrMode`: `manual`, `plan`, `auto`, `bypass`, `unknown`) comes from
the screen footer.

## herdr sessions

The only source of sessions is an agent pane in herdr (`claude`, and `codex` as a view-only entry). A session has no
process of its own: it attaches to a live pane, reads the state from herdr and the content from the CLI jsonl file,
and sends as `agent.prompt` to someone else's terminal. Detaching the driver does not touch the engine
(`ownsProcess: false`).

### Session fields and herdr frames

- `seen`: `true` = the current turn's result was received, `false` = a standing `done` badge in herdr, absent = the
  turn runs or the result waits ("Viewed on the phone" below). `markedUnseen: true`: a person marked the waiting
  result unread by hand (`POST …/unseen`); present only while `seen` is not `true`, absent otherwise. The app does
  not pulse the list dot of such a result. `seenBy: "voice-agent"`: the voice agent picked up the result, not a
  person (`docs/companion.md`, "Picking up a result"); present only with `seen: true`, so never with `markedUnseen`,
  and gone once a person receives the result. An unknown value drops the field on the client
  (`DEGRADATIONS.seenBy`), so the result reads as a person's receipt. `stale`: the herdr socket failed for a
  moment; the state stays the last known, never a transition. `herdrMode`, `outOfScope` (a pane outside
  `RAROG_HERDR_ROOTS`, a card without transcript and mutations), `launchedByRarog`, `paneId`.
- `context?: ContextLimitState`: `{kind: 'unknown', tokens, atLeast?}` or `{kind: 'known', tokens, limit, source}`
  (`source`: `statusline`, the window straight from the engine's status line, or `model` from `KNOWN_CONTEXT_LIMITS`;
  the contract also knows `compact-boundary`, which the server does not send and the app's decoder accepts). The limit
  is never guessed: jsonl does not tell the 1M variant apart, so without confirmation the client shows the number
  without a bar. `atLeast` is a lower bound of the window (what the session already held, including `preTokens` of
  every compaction boundary), not a limit. A compaction boundary does not confirm the limit (Claude Code docs
  `model-config.md`, "Default auto-compact thresholds"). The token count is the sum of the usage fields in jsonl
  (`herdr/jsonl-usage.ts`).
- `activity?`: the last known activity, carried only while the session works; absent never means "unknown".
- `waitingFor?: {kind: 'permission' | 'question', tool?, text?, count?}`: the standing decision for the list, computed
  from the pending queue; `text` is the first line up to `WAITING_TEXT_MAX` = 120 characters (absent for a plan, a
  degraded card and an input without a target key; the path for `Edit` and `Write`).
- `engine?: 'codex'` and `termId?`: a Codex card has no transcript, composer, permissions or resume; `termId` is the
  Rarog terminal where the agent stands (with `RAROG_TERM` on) and is the address of the whole card. The app's send
  block checks `codex` before "out of scope", so the sentence does not blame `RAROG_HERDR_ROOTS`.
- `PermissionRequest.canAllow: false` = Rarog does not know what it approves: only Deny, and the server bounces
  `allow` with 409.
- A session in `waiting-permission` can have an empty `pendingPermissions` list (the dialog stands in the terminal and
  jsonl does not know it): the screen engine then builds the card as `pendingQuestions` with literal options, and only
  an unparseable dialog falls to a card with Dismiss Dialog. The screen excerpt rides on the card
  (`SessionSummary.herdrDialogScreen`); its first line is the refusal reason (`herdrDialogReason`), preceded by the
  dialog class when the CLI registry knows it (`cliDialog`). Without numbered options the excerpt is the dialog block
  from its lowest rule down (`screen/excerpt.ts`; `docs/dialogs.md`, "Dialog block"), capped at 40 lines and 2000
  characters; the card's `reqId` comes from the screen content (`screenFallbackReqId`).
- `herdr-status` is volatile and global; `sessions-snapshot.herdrStatus` carries its start state. The manager
  broadcasts it after `appeared`, `gone` and `re-attached` only when (`canLaunch`, `detail`) changed. `canLaunch` is
  `false` with `RAROG_HERDR_LAUNCH=0`, an unknown herdr protocol, or the pane cap (`RAROG_MAX_PANES`), and `detail`
  gives the reason (`HERDR_PANE_CAP_MESSAGE` for the cap; empty for the killswitch). A missing `canLaunch` means
  "unknown", and the client keeps the last known value.
- `sessions-snapshot.notesCwds?`: the directories with a non-empty note among the frame's sessions, without repeats; a
  missing field (`RAROG_NOTES=0`) clears all bits, an empty list means no project of the frame has a note.
  `SseHub.withNotes` adds it to every such frame, and a new directory gets a one-time `notes` event
  (`SseHub.announceNewCwd`).
- herdr's status `unknown` has no counterpart in the state machine; the driver emits nothing then.

### Routes for herdr sessions

- **`POST /api/sessions`** → 202 `{sessionId, state: 'starting', trustPrompt?}` right after `tab.create`, because a
  blocking POST dies when iOS turns the screen off; the rest goes over SSE. Body as in "Request bodies"; without
  `model` there is no `--model` flag (the account's default model). Errors: 400 `cwd-not-allowed`, 400
  `model-unknown`, 400 `bad-request` with the manager's sentence, 409 `bad-state` (a live writer, the pane cap, the
  creation channel off), 429. `trustPrompt: true` warns that the directory has no `hasTrustDialogAccepted`, so a
  trust dialog will appear and can be confirmed from the phone.
- **`POST /api/sessions/:id/permission`** (no `permId`): a decision about a dialog jsonl does not know. `deny` sends
  `escape` and is always allowed, except on the "Session paused" screen, which the driver refuses with 422
  `terminal-only` after a fresh screen read, and over a standing layer 2 card (`docs/dialog-card.md`, "Answer"),
  refused with 422 `terminal-only` without a key. `allow` passes only for a dialog from
  the closed signature list (`trust`, `model`); the driver takes the digit from the affirmative label. An unrecognized
  dialog gets 409; `allow-always` is always refused here.
- `POST …/messages` refuses with 400 (text over 512 kB, a slash command outside the session's catalog, the `!` prefix,
  out of scope, `RAROG_HERDR_SEND=0`) or 429; the router waits for `sendMessage`, so the 400 reaches the POST and not
  the transcript. The same guard applies to the start prompt, and the driver re-checks the command classification
  (`SendOptions.command`).
- `POST …/interrupt` sends `escape`. `POST …/close {closePanel?}`: without the flag hides the card, with it `tab.close`
  of any Claude pane; 409 for a Codex pane and a session without a pane. `POST …/resume`: 409 with a live pane, else a
  new pane with `--resume` and the same `sessionId` (alias in `herdr-hidden.json`).
- `POST …/answers/:qId` on a screen card: the `keys` channel sends one digit (multiple choice → 409), the `hook`
  channel the full answer set by file; an option that escalates permissions is 422 on both.
- **`GET /api/sessions/:id/commands`** → 200 `CommandList` `{revision, commands: [{name, kind: 'local' | 'prompt',
  source: 'builtin' | 'skill' | 'plugin', description?, argumentHint?}]}`: the same catalog snapshot the send guard
  uses (`commandCatalog(cwd, CLI version)`, `commandListOf` in `herdr/commands/catalog.ts`). `name` has no slash, the
  order is by lower-case name, without aliases or paths; description and argument hint come from the frontmatter,
  folded to one line and clipped to `COMMAND_TEXT_MAX` = 200 UTF-16 units with `…`. 404 for an unknown session, 400
  `bad-request` for a pane or session directory out of scope (also Codex), 401 like every route, 405 for POST. The app
  reads 404 and 405 (a server without the route) as an empty list and drops an entry with an unknown `kind` or
  `source`. Details: `docs/slash-commands.md`.

### Session restart on a newer release

- `SessionSummary.cliUpdate?: {running, installed}`: the process runs an older Claude Code release than the installed
  one, from `CliVersionReader` (every `CLI_VERSION_POLL_MS` = 30 s; the process release from `~/.claude/sessions`, the
  installed one from `~/.local/bin/claude`); only for a live in-scope Claude pane. Absent = current or unknown.
- `POST /api/sessions/:id/restart` (`restartBodySchema`; empty, or `{resend: {seq, id}}`) → 202 `{sessionId}` after
  sending `/exit`; refusals before that go through `managerErrorStatus` (404, 400, 409, 429). Then over SSE: a closing
  detail, `resumable`, a new card under the same id, and a notice with the new release; a failure after `/exit` gives
  `resumable` with the reason or `error`. Driver methods: `restartProbe()` and `requestExit()`; a `resumable` card
  ignores a late `gone`.
- Resending a prompt a hook blocked: `SessionSummary.promptBlocked?: {seq, id}` names the notice and this block (`id`
  is a fresh `randomUUID()`), kept in RAM until the next send, a `user` entry, the restart's `/exit` or a detach. The
  body is `{resend: {seq: <integer>, id: <string>}}`, both fields required (no `id` → 400), carries no text, and the
  client copies both fields unchanged; another `seq` or `id`, or a block that disappeared, gives 409, because a new
  server process numbers from 1 again and `seq` alone is ambiguous. The driver clears the prompt field first
  (`clearBlockedLeftover(engineSessionId)` → `empty`, `filled`, `unknown`, `busy`, `changed` or `stale`), and only
  `empty` lets the restart go on. Swift type: `SessionPromptBlocked`.

### CLI session registry

- **Dialog detection.** `CliVersionReader` also reads `waitingFor` from the registry (`CliDialogClass`: `permission`,
  `input`, `sandbox`, `worker`, `dialog`, `goal`, `other`), every `CLI_WAITING_POLL_MS` = 1.5 s with
  `RAROG_CLI_WAITING` ≠ `0`, and `cliWaitingOf()` turns it into a signal only with one pid for the conversation.
  `SessionSummary.cliDialog` names which dialog stands, only on a card without a decision and only with registry
  `waiting`; it gives no buttons, and digits still come only from the screen. A class change on a standing card goes
  as the event `cli-dialog`, which changes only that field. The client builds the phrases (`UICopy.cliDialogPhrase`);
  an unknown class drops the field.
- **Proof of a process restart.** A registry entry has an optional `startedAt`, and `cliProcessStartOf` returns it only
  with one entry for the conversation, no unreadable pids and the conversation outside `unlistedSessions`. The manager
  passes it to `noteCliProcessStart`, the driver to `JsonlFollower.noteProcessStart`, and the follower to the task
  reducer, which drops the agents of the previous process (`docs/background-tasks.md`, "CLI process restart: the
  agent does not survive it").

### Configuration (`server/src/config.ts`)

The full variable list: `docs/server-config.md`. What the herdr contract depends on:

- `RAROG_HERDR_SOCKET` (default `~/.config/herdr/herdr.sock`): an absolute path without `..`, and an existing file
  must be a unix socket (else `ConfigError`); a missing file is not a config error, because herdr can start after
  Rarog, and an unreachable socket gives a banner, not a failed start.
- `RAROG_HERDR_ROOTS` (default `RAROG_PROJECT_ROOTS`), `RAROG_HERDR_SEND` (the write killswitch; `0` gives
  `HerdrStatus.readOnly`), `RAROG_HERDR_LAUNCH` (default `0`, a deliberate opt-in to starting processes),
  `RAROG_MAX_PANES` (default 30), `RAROG_YOLO_ROOTS`, `RAROG_HERDR_SEEN_FOCUS`, `RAROG_HERDR_TAB_LABELS`,
  `RAROG_CLI_WAITING`.
- `RAROG_CLAUDE_ENV_CLEAR`: variables cleared in a new pane (14 by default, `DEFAULT_CLAUDE_ENV_CLEAR`); see
  `docs/security-model.md`, "Starting sessions from the phone: three powers". The only addition is `PANE_SHELL_ENV`
  (`DISABLE_AUTO_UPDATE=true`).
- Constants live in code, not in env (`config.ts`; the `herdr/*` modules re-export them): `HERDR_RESYNC_MS` 30 s,
  `HERDR_SEND_MIN_INTERVAL_MS` 1 s (`/model` and the mode cycle; prompts skip it), `HERDR_SEND_HOURLY_CAP` 240,
  `HERDR_IDLE_GRACE_MS` 3 s,
  `HERDR_GIT_MIN_INTERVAL_MS` 30 s, `HERDR_HISTORY_BYTES` 1 MB, `HERDR_HISTORY_MESSAGES` 500,
  `HERDR_ATTACH_CONCURRENCY` 4, `HERDR_UPLOAD_TTL_MS` 48 h, `FOLLOW_MAX_READ_BYTES` 16 MiB,
  `HERDR_LAUNCH_READY_TIMEOUT_MS` 60 s, `HERDR_LAUNCH_POLL_MS` 250 ms, `HERDR_LAUNCH_SHELL_WAIT_MS` 5 s,
  `HERDR_LAUNCH_MIN_INTERVAL_MS` 5 s, `HERDR_LAUNCH_HOURLY_CAP` 40, `HERDR_TRANSCRIPT_GRACE_MS` 15 s,
  `HERDR_PENDING_DEBOUNCE_MS` 800 ms, `HERDR_PENDING_RETRY_MS` 500 ms, `HERDR_MODE_FRESH_MS` 15 s.
- `MAX_HERDR_PROMPT_BYTES` = 512 kB (`@rarog/shared`) is the byte limit of a prompt, because `z.string().max()`
  counts characters.

### Modules and their boundaries

- `herdr/argv.ts`: the `claude` argv and the flag allow-list, zero positional arguments; a resume without `fork` does
  not pass `--session-id`, so the session keeps its uuid.
- `herdr/workspace-resolver.ts`: the pure choice of the project's workspace (`null` = a new one, named by
  `newProjectWorkspaceLabel`); `herdr/project-workspace.ts`: the project lock shared by the launcher and the terminal,
  and the herdr reads the resolver needs.
- `herdr/trust.ts`: only `projects[<dir>].hasTrustDialogAccepted` from `~/.claude.json` for `cwd` and its parents, a
  30 s cache, fail-closed.
- `herdr/launcher.ts`: argv → trust → project lock → resolver → `tab.create` or `workspace.create` → registration in
  the supervisor (the 202 returns here) → `agent.start` → provenance label
  `<tab label> · rarog-claude <key> <trace>` → title → poll `agent.get`. It retries only `agent_name_taken` and
  `agent_pane_busy`. **Readiness (measured on herdr 0.9.0):**
  `timeout_ms` (`HERDR_START_WAIT_MS`, 60 s) is the life of the start record; when the record expires before the
  prompt, `waitReady` accepts `idle` or `working` with a matching session and logs `launch record expired`.
  herdr can report `interactive_ready: true` before `agent_session` (herdr 0.9.5): an empty id keeps the poll going
  until the same deadline, and only a different non-empty id fails the start as a session id mismatch.
- `herdr/provenance.ts`: agent names (`RAROG_AGENT_NAME_RE`, the source of `launchedByRarog`) and pane labels
  (`<description> · rarog-claude <key> <trace>`, `<description> · rarog-term <id>`, the description being the tab
  label cut to 40 code points; `parsePaneLabel` reads them with or without the description and returns `null`
  outside the pattern).
- `herdr/jsonl-usage.ts`, `herdr/jsonl-pending.ts`, `herdr/transcript-path.ts`: the context window, the waiting tool,
  and finding the file by uuid. `herdr/jsonl-queue.ts`: the human prompts waiting in the CLI queue, unknown after
  a part of the file the follower did not read or a truncation, until the next turn end. `demo/mock-herdr.ts`:
  supervisor and launcher in memory.

### Dialogs and cards in a herdr pane

How dialogs are recognized and answered: [dialogs.md](dialogs.md). This section holds the driver and follower
contract.

**Missing transcript guard.** The jsonl file appears only with the first message, so the alarm arms only after a
successful `prompt` or on entering `working` (`expectTranscript()` in `herdr/jsonl-follow.ts`); an empty session
never alarms.

**Viewed on the phone (`seen`).** herdr clears `done` only with focus in the terminal, so Rarog records receipt on the
phone. `POST …/seen` writes `{key, agentSessionId, stateChangeSeq, by?}` to `herdr-hidden.json` (sections `aliases`
and `seen`, an LRU of `HERDR_SEEN_LIMIT` = 200); `by: "voice-agent"` marks the voice agent's pick-up
(`docs/companion.md`, "Picking up a result"), absent for a person's receipt. The marker gives way only to a newer
result, compared by equality of the number, because a lower number means a herdr server restart.

- `markSeen()` also calls `agent.focus` in the background, but only when Rarog knows the pane stands on `done`
  (`seen === false`), because the herdr protocol has no "mark viewed" method. Gates: `RAROG_HERDR_SEND=0`,
  `readOnly`, `RAROG_HERDR_SEEN_FOCUS=0`.
- The report also comes from a Rarog terminal screen (`ResultViewedReporter`), which finds the session by `termId`.
- `seen` describes the current turn: every turn start resets it with `Session.herdrSeen`, `Session.seenByHuman`,
  `Session.seenBy` and `Session.unseenByHuman`, so a fresh result has no value and goes to the top of the list. A
  late `done` for the same turn rewrites the marker to its number without taking the receipt back. A turn without a
  result (`noResultTurn`) puts back the receipt of the previous result at its end (`carrySeenAcrossTurn` in
  `seen-marks.ts`).
- `POST …/unseen` writes an `unseen: true` entry (one entry per pane, the last decision wins). A receipt overwrites an
  `unseen` entry at any number, an ordinary entry only at a higher one, or at the same number when the receiver
  changes (a person after the voice agent: the entry loses `by`); `focus()` outside work states writes a receipt.
  The internal `Session.unseenByHuman` carries the card's `markedUnseen`; a pane adopted after a Rarog restart with
  a matching `unseen` entry gets it back, so the mark survives the restart. This holds for an `idle` pane and for a
  pane still on `done` (the receipt went without focus); the `done` pane keeps `seen: false`.
- The internal `Session.seenBy` carries the card's `seenBy`. A person's receipt (the session opened in the app,
  `focus()`) and `POST …/unseen` clear it. A pane adopted after a Rarog restart with `seen: true`
  gets it back from the entry's `by` only when the entry's state number equals the pane's (`seenByOf`).

**Directory trust dialog.** `KNOWN_DIALOGS.trust` matches either wording ("Is this a project you created or one you
trust?", "Do you trust the files in this folder?"), only inside the dialog block (`docs/dialogs.md`, "Dialog block"),
and checks only the `Yes`/`No` prefixes, because the digit comes from the label text. Without numbered options (pane
capture `dialog-trust-2.1.293.txt`, CLI 2.1.293) there is no digit, so the card asks for an answer in the terminal.
Trust passes down from a parent directory (measured on CLI 2.1.299). A pane on the trust dialog has no
`agent_session`, so the launcher hands its status to the supervisor (`HerdrLaunchResult`), and `AgentEntry.seenInList`
keeps a `blocked` entry the list never showed until `pane.list` loses its pane (`'pane-gone'`). After the decision
`claude` re-executes itself; the same `pane_id` within `HERDR_TRUST_REEXEC_GRACE_MS` (15 s) is `re-attached`.

**Status after a dialog answer.** The card goes out with the `idle` push of `pane.agent_status_changed`. A pane from
the launcher joins the event subscription at registration, not at the next resync; a stream renewed this way runs one
resync at its `connected`, because events of the other panes are lost while it reopens. After every dialog answer
herdr accepted (`sendKeys`, `sendTrustStep`, `sendDialogKey`, `sendFormSubmit`; not prompts, pastes or mode cycles)
the supervisor refreshes the pane status with `agent.get` after 1 s and 4 s (`ANSWER_RECHECK_DELAYS_MS`,
`herdr/answer-recheck.ts`), the same update a push gives. herdr pushes `idle` 0.3–0.8 s after the Enter (herdr 0.9.5),
so a lost push no longer leaves the card standing until the 30 s resync. A new answer re-arms the two timers; a gone
entry and `dispose()` drop them, and an answer that arrives after its entry was closed is dropped. A failed refresh
other than a gone or unavailable herdr leaves one log line `herdr: status refresh for <pane> failed: <message>`.

**Universal dialog card: policy per option.** A standing permission dialog has no `tool_use` entry in jsonl until the
decision, so the card is built from the screen (`screenPermissionCard`, `herdr/dialogs/cards/build.ts`): `input:
{screen}`, `displayText` = the dialog's literal content, `toolName` = the tool name from the screen or `dialog`.
Buttons only for a dialog visible in full with content up to `TOOL_QUESTION_MAX_CHARS` (2000); the "don't ask again"
option becomes `allow-always` with its literal `alwaysLabel`. On question and confirmation cards an escalation marker
in the content takes the card away, and in an option label it marks that option `terminalOnly`, whose digit the driver
refuses (`TERMINAL_ONLY_MESSAGE`). Dialogs from `TERMINAL_DIALOGS` (`herdr/dialogs/policy/terminal.ts`) get every
option `terminalOnly`. The apostrophe is folded before matching (`foldApostrophes`; fixture
`dialog-permission-subagent.txt`), because the CLI writes U+2019 while the patterns use `'`; the label on the card
stays literal.

**Transcript follower: safety catches.**

- A shrunk file resets the waiting tool and the background tasks (`#onTruncated`), so no ghost card or hanging task
  survives; a task that never closes would block every following `done` push. `#usage` stays. The new content is not
  replayed (`TRUNCATED_MESSAGE`).
- A read gap (growth over `FOLLOW_MAX_READ_BYTES`) resets the same plus the echo window (`#onGap`, `GAP_MESSAGE`).
- `hasTranscript()` answers `'yes' | 'no' | 'unknown'`; on `'unknown'` the driver waits the jsonl ↔ screen grace (2 ×
  `HERDR_PENDING_DEBOUNCE_MS`) before judging a screen.
- An exception in `#prime` or `#readMore` logs one line and retries at the next tick, because the server has no
  `unhandledRejection` handler.
- When the file opens, background tasks get the whole file (`scanMainFileBefore` in `herdr/background/main-scan.ts`,
  up to `MAIN_SCAN_MAX_BYTES` = 1 GiB before the tail window), everything else the window; `#prime` runs once per
  generation, so `history` never goes out twice.

**The `AskUserQuestion` form on the screen** (fixture `dialog-askuserquestion-multi.txt`). The header comes from the
tab bar (an empty header with more than one tab, fail-closed); an option's description is the indented lines under it
(cap `OPTION_LABEL_MAX_CHARS` = 200); a checkbox is removed from the label before the digit is counted. A form is
multiple choice on any of three signatures (a checkbox in an option, the "✔ Submit" bar together with a "Submit" or
"Next" item, `space to …`), and then there is no question card on the `keys` channel, only an answer-in-the-terminal
card, because reaching "Submit" needs navigation by position. The review screen ("Review your answers" and "Submit
answers") is an ordinary confirmation. A cross-checked hook payload overrides the `multiSelect` heuristic in both
directions (`hookQuestionFrom`, `applyMultiSelectOverride`). Before a digit, `#digitStillHolds` rejects a form that
turned out to be multiple choice (`SCREEN_CHANGED_MESSAGE`).

**The hook dump as card content.** Source precedence: jsonl → hook (after a cross-check) → screen. The permission hook
(`rarog-pending.mjs`; installation and channel state: `docs/dialogs.md`, "Permission hook") writes
`<dataDir>/pending/<engineSessionId>.json` (`0700`/`0600`, atomic) with `sessionId`, `toolName`, `toolInput`, `at` and
optional diagnostics, and for a `PermissionRequest` also one dump per call, `pending/<session>/<key>.json` (name
contract in `herdr/dialogs/hook/contract.ts`). When the hook computed that key, the per-session dump carries it as
`callKey`; the reader keeps it only in the key's shape (`HOOK_CALL_KEY_PATTERN`). It ties a screen card to the
consent record of the same call and only picks the card's `unavailable` reason, never a button.

- The reader schema is loose, but `toolName` must be an identifier; `toolInput` is passed literally, and over 1 MiB of
  serialized UTF-8 (`HOOK_TOOL_INPUT_MAX_BYTES`) the hook writes `{rarogTruncated: true, preview}` with the first
  64 kB as the preview, cut on UTF-8 bytes. A bad or foreign dump, a dump dated ahead of the clock and an expired one
  give `null`.
- TTL: the hook `timeout` (24 h) for a `PermissionRequest` with `AskUserQuestion`, 60 min for one with `Bash` (marked
  `stale` after 10 min, admitted only with proof from the screen), 10 min for everything else.
- A digit deletes the dump, except a question form's dump while the form switches tabs in place; `escape` deletes a
  form's dump. A `Bash` dump of another queued dialog survives the decision (CLI 2.1.318, `docs/dialogs.md`, "When the
  hook gets a request"). An answer by file deletes the dump only with the same `answerKey`.
- The permission cross-check (`hookMatchesScreen`) needs the first 40 characters of the command or path on the screen
  (for `Bash` inside the dialog's frame; for `ExitPlanMode` the plan file name in the footer). It guards against a
  stale dump and against a dump of another request, because `PermissionRequest` fires for every queued request at once
  and the next one overwrites the session dump (CLI 2.1.311, `docs/dialogs.md`, "PermissionRequest hook behavior").
- The question cross-check (`hookQuestionFrom`) needs the question text and the full label set on the screen. A
  `keys` card carries one tab with digits from the screen; a `hook` card carries the full question set from the
  payload, and a `tool_use` entry in jsonl must agree with the dump (`hookMatchesPending`).
- `ExitPlanMode` is settled by closed signatures (`PLAN_DIALOG_PATTERN`, `PLAN_EXIT_CONFIRM_PATTERN` in
  `herdr/dialogs/screen/kinds.ts`); `displayText` is the plan itself, and "Yes, and use auto mode" escalates.
- `OPTION_ESCALATION_PATTERN` (`herdr/dialogs/policy/escalation.ts`) is the only escalation list, with one closed
  exception in the content: the CLI warning about `cd` before git (`cdAdvisory`, CLI 2.1.265).
- Every card without buttons logs a `method: "degrade"` entry in `herdr-audit.log`, and every refused digit a `method:
  "refuse"` entry, with a reason from `REFUSE_REASONS`, the tool name and the case shape (`AuditCaseShape`; fields:
  `docs/dialogs.md`, "Case shape in the log"), never keys or content. `summarizeRefusals` (a 7-day window, sums per
  reason, `refuse` and `degrade` apart) and `summarizeDegradeShapes` in `herdr/audit.ts` read them.
- Every refusal also leaves `<dataDir>/refusals/<ISO-ts>-<reason>.txt` with the screen text and the case shape (`0600`,
  48 h, at most 200 files, `RAROG_REFUSAL_DUMPS=0` switches it off; `docs/security-model.md`, "Starting sessions from
  the phone"). A layer 2 dialog (registry class `dialog`) without any consent trace in the dump leaves
  `<ISO-ts>-<reason>.dialog.txt` instead: 14 days, at most 500 files, counted apart (`docs/dialogs.md`, "Refusal
  diagnostics"). A write error changes neither the card nor the log.

### Files and the session directory pulse

**Files next to photos.** Photos and files travel in separate body fields, but one function writes them to one
directory, and `appendAttachmentPaths` builds one block of paths (rules: `docs/security-model.md`, "herdr sessions").

**The echo signature.** The echo settles the optimistic message by `clientMessageId` first, and by a signature of the
text and the `(name, bytes)` list as the fallback: `EchoMatching.signature(text:attachments:)` in the app, and the
descriptors from `messageAttachments()` on the server, which computes the size from the base64 length
(`dataUrlBytes`) and so gives the same number. A mismatch leaves the bubble on Not confirmed with Retry.

**Session directory pulse** (`server/src/herdr/session-pulse.ts`) answers "is this still alive?" while subagents work
and the main jsonl is silent. The recursive watcher (with a `stat` check, because FSEvents replays history; `EMFILE`
falls back to a scan) runs only during a turn. Constants: `PULSE_THROTTLE_MS` 3 s, `PULSE_WINDOW_MS` 10 s,
`PULSE_VERIFY_MS` 12 s; in `drivers/herdr/transcript.ts` `PULSE_QUIET_MS` 3 s, `PULSE_SILENCE_MS` 10 s,
`PULSE_REFRESH_MS` 30 s. The server sends facts (`agents`, `workflow`, `toolName` `SUBAGENTS_ACTIVITY_TOOL` or
`WORKFLOW_ACTIVITY_TOOL`), and the app builds the sentences. `elapsedSeconds` measures silence in the file, not the
age of the turn. When nothing grows (e.g. `Bash` waits on `sleep 40`) no event goes out, and the app's counter ticks
locally; the manager sends `activity {kind: 'idle'}` at every exit from `starting` or `running`.

### Decision cards: view contract

Client rules the app implements (`RarogUI/Session/Cards/`); the layout rules stand in `docs/design.md`, "Decision
cards: layout rules". Nothing disappears silently, and permission is a tap.

- **The command block cap counts in lines** (10, wide 16; a plan or option preview 20, wide 32,
  `CardBlockCeiling`; the screen excerpt 8), and a real cut shows how many lines are visible. The screen excerpt
  starts from the bottom.
- **Option text wraps and is never cut**, including the literal escalation label.
- **The key column** shows the number of the n-th visible option (the same as keyboard 1–9); a row that cannot be
  chosen shows a dash.
- **Option order:** the option the author recommends stands on top with a badge, the rest in the author's order.
- **Choice:** a single single-choice question without a custom field or previews is answered by a tap; with a preview
  a tap shows it and Answer sends; multiple choice shows `[ ]` / `[x]`.
- **Custom Answer** is the last row and has no digit. **One footer per card;** no card button points to herdr,
  and an exit option (e.g. "Chat about this") stands on the left only for a single question.
- **A recognized dialog in the terminal** (trust, model change) needs a second tap: the button then
  reads Tap Again to Confirm.
- **A standing decision card dims the transcript** and once collapses the open mini-diffs.
- **Permission is always a tap**, risky ones included; look rules: `docs/design.md`, "Decision cards: layout rules".

## Dictation

The app dictates through Soniox or through Apple speech recognition (System Dictation); the person chooses on the
Dictation screen. On the Soniox route the audio goes from the phone straight to Soniox in the EU, and the permanent
key never leaves the server. The server only exchanges it for a temporary ticket (`server/src/voice/soniox.ts`);
Rarog has no audio proxy. The system route never calls the server.

**Contract.** `voiceTokenSchema` / `VoiceToken` = `{apiKey, expiresAt, webSocketUri, model, maxSessionSeconds, config:
{languageHints, audioFormat, sampleRate, numChannels}}`. The client guesses neither host nor format.

**`POST /api/voice/token`** (credential and Origin as any POST): the body is empty and stays so
(`z.strictObject({})`); 200 → `VoiceToken` with `Cache-Control: no-store`; 503 `voice_unconfigured` (no
`SONIOX_API_KEY`, `RAROG_VOICE=0`, a host outside the EU, a rejected key); 502 `voice_upstream` (429/5xx, timeout, no
network, no `api_key`); 429 `voice_throttled`. `GET /api/version` carries `voiceEnabled`: whether the server
offers the Soniox route (a missing field reads as on). The microphone does not depend on it.

**Mint (`createVoiceMinter`).** `POST https://api.eu.soniox.com/v1/auth/temporary-api-key` with `{usage_type:
'transcribe_websocket', expires_in_seconds: 60, single_use: true, max_session_duration_seconds: 900,
client_reference_id: <random 8 B hex>}`; the other fields are pinned in code
(`wss://stt-rt.eu.soniox.com/transcribe-websocket`, `stt-rt-v6`, `pcm_s16le` 16 kHz mono, `['pl', 'en']`).

- The REST host is pinned and `SONIOX_API_HOST` only checked: a key from an EU project works only on EU endpoints.
- `client_reference_id` is random per mint, never derived from the session id, which would be a lasting trace.
- Zero retries, 5 s timeout (`VOICE_MINT_TIMEOUT_MS`). The throttle sits in the minter and protects the Soniox account
  limit: `VOICE_TOKEN_MIN_INTERVAL_MS` 3 s and `VOICE_TOKEN_HOURLY_CAP` 60, and a failed attempt takes a slot too.
- `pcm_s16le` is the name the Soniox documentation gives the raw format; raw PCM avoids the missing `audio/mp4` in its
  auto-detection.

**Configuration and secrets.** `RAROG_VOICE` (default `1`), `SONIOX_API_KEY`, `SONIOX_API_HOST`; `voiceEnabled` =
`RAROG_VOICE≠0` and a key present, and a missing key is not a start error. The permanent key appears in no response
and no log (`logSecrets(config)`), and `SENSITIVE_KEY_PARTS` in `auth/redact.ts` has `api_key`, the field name in
Soniox's response. Tests: `server/test/voice.test.ts`.

**Client** (`RarogUI/Sources/RarogUI/Session/Voice/`): `MicrophoneCapture` (PCM s16le 16 kHz mono, 100 ms frames),
`VoiceRecorder` (auto-stop after 60 s of silence, a countdown from the 13th minute) and one stream per route under it.
`SonioxStream` with `URLSessionVoiceSocket` (a separate URL session without Rarog's credentials) sends the key only in
the WebSocket protocol list and only with the `snx_temp_` prefix; the start frame has no `api_key`. It makes three
attempts, each with a new key; the budget resets at the first result frame, an attempt waits at least 3 s after the
previous key request returned (`VoiceTiming.minMintInterval`, the server throttle), and an error frame with
`error_code` 429 ends the recording without a retry. `SystemDictationStream` (`Session/Voice/System/`) runs
`SFSpeechRecognizer`: on the device when the language has an on-device model, otherwise on Apple's servers; a task
ends after about a minute, so the stream opens a new task and keeps the committed text. After a pause the on-device
recognizer returns a result without `isFinal` but with speech metadata (`speechRecognitionMetadata.speechDuration`
above zero) and starts the next hypotheses of the same task from empty text; the stream commits that fragment and
appends the next one after a space. A closing result (fragment end or final) that comes with no hypothesis since the
last fragment and has the same words repeats that fragment and is not appended again. The core fetches a key at
every Soniox stream open (`RarogStore.mintVoiceToken`). A 404 or a 503 `voice_unconfigured` marks Soniox unavailable
for this server process (`AppState.sonioxOnServer`) until a new `serverStartId`, a login, a logout or another server;
with Soniox chosen, the next tap then opens the Dictation screen. Any other 503 is a transient failure with a retry.
The route of a tap comes from `RarogStore.dictationRoute`; the microphone does not depend on `voiceEnabled`.
