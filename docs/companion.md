# Voice agent

The voice agent answers spoken questions about one Claude Code session. The server side lives in
`server/src/companion/`: behind `POST /api/sessions/:id/companion/ask` it condenses the session's conversation file
into text, asks Sonnet about it through `claude -p` on the owner's subscription and masks common secret shapes in the
answer. Behind `POST /api/companion/token` it trades the server's OpenAI key for a short-lived Realtime key, and
behind `POST /api/companion/speech-token` it trades the server's Soniox key for a temporary text-to-speech key (the
minter in `server/src/voice/soniox.ts`). It is off unless `RAROG_COMPANION=1` ("Flags" below), and it never runs in
demo mode. It speaks only with the Soniox voice, so it needs two keys on the server: the OpenAI key and the Soniox key
of dictation, from the EU region; without either there is no voice agent. Behind
`GET /api/sessions/:id/companion/turns` the server gives the last turns of a session to the voice agent's mode across
sessions ("Turns route"), and behind `GET /api/companion/sessions` the sessions that mode may see ("Session
catalog"); both are off unless `RAROG_COMPANION_SESSIONS=1` as well. With both flags, that mode sends a prompt
through the ordinary message route, marked as the agent's and bound to the conversation it read ("Sending from the
conversation"). The app side is in "App", the configuration in "Configuration" and the security boundary in
"Security" below.

## Module map

- `server/src/companion/ask.ts`: one question of the route: conversation file, condensing, `claude -p`, answer or
  refusal; the questions in flight with their owner device and engine conversation, and what kills them.
- `server/src/companion/condense.ts`: conversation file → text of turns for the model.
- `server/src/companion/cli.ts`: one `claude -p` call with its isolation, ceilings and limit reading. The only
  place in the server that starts print mode.
- `server/src/companion/cli-literals.ts`: registry of the Claude Code literals the module depends on, each with the
  CLI version it was measured on.
- `server/src/companion/prompt.ts`: the model's instruction, system prompt, message and the parser of the answer.
- `server/src/companion/mask.ts`: mask of common secret shapes.
- `server/src/companion/openai-token.ts`: the server's OpenAI key traded for a short-lived Realtime key behind
  `POST /api/companion/token`.
- `server/src/companion/turns.ts`: the last turns of one session behind `GET /api/sessions/:id/companion/turns`
  ("Turns route").
- `server/src/companion/turns-settle.ts`: the read of the turns route that holds against a new engine conversation
  during the read ("Turns route").
- `server/src/companion/conversation.ts`: the opaque token of a session's engine conversation.
- `server/src/companion/catalog.ts`: the session catalog behind `GET /api/companion/sessions` ("Session catalog").
- `server/src/companion/asks-owner.ts`: whether an agent message asks the owner, for the catalog's `asksOwner`
  ("Session catalog").
- `server/src/companion/index.ts`: the entry of the directory.

`server/test/companion-granice.test.ts` keeps these boundaries: print-mode flags stand only in the registry, the
registry is read only by `cli.ts` and `condense.ts`, no server file imports from `scripts/`, the turns route
reads the conversation file only through the session's history steps, and neither the turns route nor the session
catalog imports the file system or writes a file.

## The route

`POST /api/sessions/:id/companion/ask` takes `{question, clientRequestId}` and answers `{answer, found, prompt?}`
(`companionAskBodySchema` and `companionAskSchema` in `shared/src/rest.ts`). `clientRequestId` is a UUID per
question. The question is about the engine conversation the session writes when the server takes the request: the
wire never carries the id of a session's engine conversation (the turns route carries only an opaque token of it,
"Turns route"), so the app does not name it. An unknown field in the body is
dropped, as in every REST body schema. `GET /api/version` says `companionEnabled: true` only when the voice agent can
work: `RAROG_COMPANION=1`, an OpenAI key ("Short-lived OpenAI key") and the Soniox voice, a Soniox key from the EU
region ("Temporary Soniox speech key"). The name `companion` in `capabilities` says only that the server knows this
contract.

The gate, in order:

- Demo mode: no route (404, as for an unknown path).
- `RAROG_COMPANION` is not `1`: 503 `companion-disabled`.
- A body outside the contract (empty or blank question, over 2000 characters, `clientRequestId` not a UUID): 400.
- Unknown session: 404 `not-found`. A Codex session, a pane out of scope or a session directory outside
  `RAROG_HERDR_ROOTS`: 404 with the sentence `rest.companion-claude-only`. The scope is the one of the commands list
  (`inCommandScope` in `server/src/sessions/companion-scope.ts`).

Then `ask.ts` finds the file of the session's current engine conversation in the Claude Code store (no conversation
or no file yet = no turns), condenses it and asks Sonnet. Outcomes: 200 with the answer, 429 `companion-busy`
(a question about this session, or two on the server, already in flight), 429 `companion-limit`, 503 `companion-cli`
(also for an empty answer), 504 `companion-timeout`.

Four events kill the process of a question in flight, and none of them gets a body:

- The request closes before the answer: nothing is sent.
- The device that asked is revoked (`rarog devices revoke`, Forget Server, expiry): the response closes.
  `server/src/device-effects.ts` calls `closeOwner` and logs the count as `voice agent: N`.
- The session moves to another engine conversation (`/clear`, `/resume` in the pane): the session manager tells
  `ask.ts`, and the response closes. The app drops a late result by the generation of its voice conversation.
- The server shuts down (`SIGTERM`, `SIGINT`): `closeAll` kills every question and waits until each process is gone
  and its working directory removed, before the shutdown fuse starts.

The log line of a question carries the session id, the outcome code, times and counts, never the question, the
transcript or the answer.

## Turns route

`GET /api/sessions/:id/companion/turns?count=1..3` answers `{messages, conversation, stateSince, readMark, complete}`
(`companionTurnsSchema` and `companionTurnsCountSchema` in `shared/src/rest.ts`): the last turns of the engine
conversation the session writes now, for the voice agent's mode across sessions. Code: `server/src/companion/turns.ts`,
the route in `server/src/routes/sessions.ts`.

- **Which file.** The file of the session's current engine conversation in the Claude Code store, as for the ask
  route. No conversation yet, no file, a file that cannot be read, or a new conversation without a prompt (`/clear`
  and nothing after it) gives `messages: []`, `complete: true` and the `readMark` that names no read (below). A new
  conversation is a new file, so nothing from before `/clear` leaves the server this way, also when the pane reports
  `/clear` with an immediate prompt as `/resume`.
- **Which messages.** The tail of the file goes through the steps the session's history takes on the way to the
  phone (`server/src/herdr/history-steps.ts`, then the message shape and byte ceiling of `server/src/sessions/session.ts`):
  the output mark of a local command is dropped, a prompt blocked by a hook is a `system` note with `promptBlocked`,
  and blocks are cut as in the session stream. The messages are the ones the session stream gives the phone for the
  same file; `seq` numbers the messages of this response from 1. The read window starts at 256 KiB and doubles up to
  8 MiB or 500 messages, and stops once it holds one turn start more than asked.
- **Turn boundary.** A turn starts at a human message the app shows as a turn: role `user`, no `notice`, no
  `promptBlocked`, and text outside the server's own sentences (a block without `ref`), an image block or an
  attachment. A background task notification, a blocked prompt, a local command and its output, and an image pasted
  in the terminal (only the `[image]` placeholder) open no turn and stay in `messages` where the history has them.
- **The cut.** `messages` starts at the `count`-th last turn start. When the window reaches the start of the file,
  messages before the first turn drop out, except agent messages. `complete: false` means the window starts inside
  the oldest returned turn (its prompt and first messages are missing), or the byte ceiling of 4 MiB dropped them.
- **`conversation`.** An opaque token of the engine conversation, never its id: HMAC-SHA-256 of the id under a
  random key that the server draws at start and keeps only in memory, cut to 22 base64url characters
  (`server/src/companion/conversation.ts`). The same conversation gives the same token while the server runs; another
  conversation (`/clear`, `/resume` in the pane) gives another token. **A server restart changes every token.**
  A session before its first engine conversation has a token of its own.
- **`stateSince`.** The session's `stateSince`, read together with the conversation before the file is read.
- **`readMark`.** In an answer with messages, an opaque name (1–64 characters) of the newest message the server's
  memory of the session holds and of the session's `stateSince`, taken together with the conversation and
  `stateSince` in the same step, before the file is read (`Session.readMark` in `server/src/sessions/session.ts`).
  Every message the session's transcript gets (a prompt, an agent message, a notice, history imported after
  `/resume`) gives another mark, and so does every new `stateSince` (a state change, a history import that moves it
  back); a session frame or a seen mark while the state stands does not. A card made again under the same id has a
  mark of its own. The voice agent sends it back when it picks up the result ("Picking up a result"); a message or a
  state change that reaches the session during or after the read gives the session another mark, so that pick-up is
  refused and the agent reads again. An answer that did not read the session's result carries a fixed mark that
  names no read (`NO_READ_MARK` in `server/src/companion/turns.ts`): it has no dot, while a session's mark has three
  dot-separated parts, so no pick-up built from it is accepted. Two answers carry it:
  - an answer with no messages, a failed read and a conversation with nothing to read alike;
  - an answer with a message trimmed to the 256 KiB ceiling of one message: the message keeps its start and ends
    with the trimmed mark, a text block with the `transcript.trimmed-mark` sentence (`hasTrimmedMessage`). The
    history merges consecutive agent entries into one message, across the tool results between them, while the
    server's memory of a live session gets them one by one. A long agent turn can thus keep its start in the answer
    and lose its final result, which the memory holds. A trimmed message of an older returned turn counts too.

  The other cuts of the read (the read window, the 500 messages, the cut to turns and the 4 MiB ceiling) drop the
  oldest messages and keep the newest one, so they leave the session's mark in the answer; `complete: false` tells
  that the oldest turn lost messages.
- **A change during the read.** The route takes the session again after each read: another engine conversation by
  then (`/clear`, `/resume`) is read again, after three reads that each saw it change the response closes without a
  body, and a session gone or out of scope gets the gate's 404; a response carries the token, `stateSince` and
  `readMark` taken before the read of the conversation it read (`server/src/companion/turns-settle.ts`), or the mark
  that names no read when it has no messages or a trimmed one. A device unpaired during the read gets 401 and no
  turns.

The gate, in order:

- Demo mode: no route (404, as for an unknown path). Another method than `GET`: 405.
- `RAROG_COMPANION` is not `1`, or the voice agent module is missing: 503 `companion-disabled`, as for the ask route.
- `RAROG_COMPANION_SESSIONS` is not `1`: 503 `companion-sessions-disabled`.
- `count` missing or not one digit from 1 to 3: 400 `bad-request` with `rest.companion-turns-count`.
- Unknown session: 404 `not-found`. A Codex session, a pane out of scope or a session directory outside
  `RAROG_HERDR_ROOTS`: 404 with `rest.companion-claude-only` (`inCommandScope`, as for the ask route).

`GET /api/version` is stricter than this gate: it says `companionSessions: true` only when `companionEnabled` is true
(`RAROG_COMPANION=1`, the OpenAI key and the Soniox voice) and `RAROG_COMPANION_SESSIONS=1`; otherwise the field is
absent, never `false`. The route needs only the two flags and the module, so on a server without the keys it answers
200 while the version has no field. The name `companion-sessions` in `capabilities` says only that the server knows
this contract. The route reads the file of the current conversation (once more for each new conversation during the
read) and keeps nothing between reads: it writes nothing to disk, sends nothing to a pane, writes no log line of its
own (only the router's device check logs a device unpaired during the read) and masks nothing (the turns are what the
session stream already gives the phone).

## Session catalog

`GET /api/companion/sessions` answers `{sessions: [{id, asksOwner?, conversation, stateSince}]}`
(`companionSessionsSchema` in `shared/src/rest.ts`): the sessions the voice agent's mode across sessions may see.
Code: `server/src/companion/catalog.ts`, the route in `server/src/routes/system.ts`.

- **Which sessions.** One row per session of the session list that passes the scope gate of the ask and turns routes
  (`inCommandScope` in `server/src/sessions/companion-scope.ts`): a Claude Code session whose pane herdr reports in
  scope and whose directory lies in the work area of `RAROG_HERDR_ROOTS`, as written and on disk. A Codex session, a
  pane out of scope, a session directory outside the roots and one that a symlink leads into an excluded folder get
  no row. A symlink that leads out of the roots to any other place keeps the verdict of the path as written, as
  everywhere in the work area (`docs/security-model.md`, "Work area: where Rarog starts, lists and reads"). A session
  without a row is not the voice agent's to see.
- **The row.** `id` is the session's id in the session list. `conversation` is the token of the turns route ("Turns
  route"), from the same function, so a row and a turns read of one session compare. `stateSince` is the one the
  session list carries. The row has no name, directory, state or text: the app joins it with the session list it has.
- **`asksOwner`.** Present, only as `true`, while the session is in `waiting-input` and the newest message the
  server holds for it is an agent message in which the app draws the owner's question block: a top-level paragraph
  of a text block whose first inline fragment is bold and starts with `Do Ciebie:` or `To you:` (`MarkdownQuestion`
  in the app). The server follows the app's block structure (`server/src/companion/asks-owner.ts`), so a marker in a
  code block, a list item, a quote, a heading or a table, or after a single line break inside a paragraph, does not
  count. The shared table `shared/fixtures/companion/asks-owner.json` holds the app's verdicts; the server test and
  the app test (`MarkdownQuestionTests`) both read it. Only the newest message counts, and only when it belongs to the
  engine conversation the session writes now: a task notification after the question, or the note of `/clear`, drops
  the field. The driver announces a new conversation (`/clear`, `/resume`) at once, and the session's stream gets the
  note of `/clear` only after a disk probe; the session remembers where the current conversation starts in its memory
  (`Session.conversationStartSeq`, set when the conversation changes), so in that moment the row carries the new
  conversation's token and no `asksOwner` (`Session.lastMessageOfConversation`). After `/resume` the history imported
  for the resumed conversation is that conversation's, so its own last answer counts. A driver that attaches to a
  pane which moved to another conversation while it waited hands over that conversation's history before the `init`
  that names it; the driver tags the history with the conversation it was read from, and history of the conversation
  the `init` names counts as that conversation's (`Session.importedHistory`).
- **Known limits of `asksOwner`.** The server checks the bold marker without the app's inline parser, so an unusual
  opening or closing of the bold (other emphasis characters around the marker, a closing pair after a space, inside
  inline code or escaped) can give another verdict than the app, and so can an escaped backslash before a bar in a
  table cell or white space other than spaces and tabs at the edge of a cell.

The gate, in order, as for the turns route:

- Demo mode: no route (404, as for an unknown path). Another method than `GET`: 405.
- `RAROG_COMPANION` is not `1`, or the voice agent module is missing: 503 `companion-disabled`.
- `RAROG_COMPANION_SESSIONS` is not `1`: 503 `companion-sessions-disabled`.

The catalog is built from the server's memory, with no `await` between the gate and the answer. It reads no
conversation file and no message file; the only disk access is the scope gate's check of each session directory
(`inWorkAreaOnDisk` in `server/src/config/work-area.ts`). It takes the newest message straight from the session's
memory and does not go through the session's transcript read, which marks the session's consent cards as shown. It
keeps nothing between reads, writes nothing to disk, sends nothing to a pane, writes no log line and masks nothing:
the row carries no text.

## Sending from the conversation

The voice agent's mode across sessions sends a prompt through the ordinary message route,
`POST /api/sessions/:id/messages`, with every gate of that route (state, scope, mode read, text guard, throttle,
`RAROG_HERDR_SEND`). Two optional fields of `messageBodySchema` in `shared/src/rest.ts` mark the send as the agent's:

- **`source: "voice-agent"`** is the sender. It is the only value: another one is a 400. It goes to the audit log
  (below).
- **`expectedConversation`** is the `conversation` token the agent read (1–64 characters, from the session catalog
  or the turns route). A session that writes another engine conversation when the server hands the text over answers
  409 `bad-state` with `session.conversation-changed`, and nothing reaches the pane.

The two fields come both or neither: a body with one of them alone is a 400 `bad-request` (`rest.body-contract`),
like any other body that fails the schema, and it gets the 400 before the 503 of the flags below. A body without
them is a message as any other, whatever the flags. The app builds them as one value (`MessageSender` in
`RequestBodies.swift`), so it cannot encode one without the other.

**Gate.** After the body passes the schema, a body with both fields meets the gate of the turns route: 503
`companion-disabled` when `RAROG_COMPANION` is not `1` or the voice agent module is missing, then 503
`companion-sessions-disabled` when `RAROG_COMPANION_SESSIONS` is not `1`. The gate stands in the route
(`server/src/routes/sessions.ts`), before the send registry, so with either flag off nothing marked as the agent's
is sent, a repeat of an accepted id included.

**The conversation check.** `assertSendConversation` in `server/src/sessions/companion-scope.ts` refuses when:

- the token of the engine conversation the session writes (the driver's `init`) is not `expectedConversation`;
- the driver knows the pane runs another conversation: herdr reports `/clear` and `/resume` to the driver before the
  manager hears `init`;
- the driver does not know the pane's conversation (herdr has not reported it yet) while the session has one.

The manager runs the check after every other gate of the send and after its last `await`, then appends the echo and
hands the text to the driver with no `await` in between. From there the driver's send ticket keeps that engine
conversation for every key of the message (`docs/dialogs.md`, "Sending while a turn runs"): an idle pane checks it
after every field read of the leftover clearing and of the stall retry's clearing (right before each Esc pair), right
before `agent.prompt` and before the second `prompt`, the paste queue right before each key. A clearing stopped this
way sends no further key, and the message ends with `commands.send-session-changed`. The check compares with the
conversation the server has heard of: a `/clear` herdr has not reported yet is not visible to it, and a key typed in
that window goes to the pane.

**A queued message.** A message accepted while a turn runs gets its 202 (with `queued: true` for `queueAware`), and
no 409 follows it. When the pane moves to another conversation before its paste, the message ends without a key:
its echo goes back, the transcript gets `commands.send-session-changed`, and the audit log gets no `prompt` entry for
it. The 202 means accepted, not pasted.

**Idempotency.** The send registry runs before the manager's gates ("Idempotent send" in
`docs/implementation-spec.md`). A repeat of an accepted `clientMessageId` answers 202 `replayed: true` without
the conversation check and sends nothing, also after `/clear` and after a server restart, which changes every token.
A refused send (409, 400, 429) keeps the id free. The content hash covers the text and the attachments, not `source`
or `expectedConversation`, so a repeat with a fresh token is a repeat of the accepted message.

**The sender in the audit log.** Each `prompt` entry of the message's text in `<dataDir>/herdr-audit.log` (the
prompt of an idle pane, its stall retry, the paste of the queue) carries `"sender":"voice-agent"` right after `mode`;
the Enter of a paste (`send_keys`) does not. A message without `source` gets no such key. The key is not `source`,
because that key of a line already names a card's source.

**Side effects.**

- The conversation check runs last, so a send that would get the 409 can first get another refusal (400 for an
  unknown mode or a refused text, 429 for the throttle) or take one of the 240 throttle slots of the hour before it is
  refused.
- A server restart keeps a queued message's sender: `prompt-queue.json` stores `source` with the entry, and the
  restored paste carries `sender`. A restored message goes only to a pane of the engine conversation it was accepted
  for and keeps the check before each key; the token changes at the restart, the conversation id the message is bound
  to does not. An entry without the field, or with another value, restores as a message without a sender.
- A restart with the voice agent or its mode across sessions off (the same condition as the gate) takes the queued
  messages of the voice agent too: at start the store drops every `queued` entry with a sender, writes the file
  without them and logs one line with their count and no text (`prompt-queue: <n> voice agent message(s) not sent:
  the voice agent's sends are off`). Nothing of them is pasted and the audit log gets no `prompt` entry. A `pasted`
  mark with a sender stays: it sends no key, and its note after the history is the owner's trace of a paste whose
  outcome is unknown. Queued messages without a sender restore as always.

## Picking up a result

The voice agent's mode across sessions marks a result it read as received through the route the app calls when a
person opens a session, `POST /api/sessions/:id/seen` (`docs/implementation-spec.md`, "Presence, focus
and seen"), with the body `{by: "voice-agent", conversation, readMark}` (`seenBodySchema` in `shared/src/rest.ts`).
`conversation` and `readMark` come from the turns read the agent picks up ("Turns route"), 1–64 characters each. The
catalogue row has no mark, so a pick-up needs a turns read. The rule stands in `markSeen` and `pickUpMeetsResult` in
`server/src/sessions/seen-marks.ts`, the gate in the route in `server/src/routes/sessions.ts`.

- **The same receipt as a person's.** The session gets `seen: true`, its pending push notification is cancelled, and
  `agent.focus` clears the herdr `done` badge under the same condition and gates as for a person: only while herdr
  reports a standing `done` (`seen: false`), and not with `RAROG_HERDR_SEEN_FOCUS=0`, `RAROG_HERDR_SEND=0` or a
  read-only herdr. A pick-up can thus switch the view of every attached herdr client on the Mac.
- **`seenBy`.** The session row carries `seenBy: "voice-agent"` next to `seen: true`, so the app can tell the agent's
  receipt from a person's. The field comes only with `seen: true` and never with `markedUnseen`.
- **Only the result the agent read.** The server accepts a pick-up only when all of these hold; otherwise it answers
  409 `bad-state` with `session.seen-result-changed`, and nothing changes, the push included:
  - a result stands: the session is in `waiting-input`. A turn that waits for a permission or an answer has no
    result yet, and the answer from the phone takes the turn back to `running` without a turn start, so a receipt
    taken there would cover the turn's result;
  - no permission card, question or consent card in `pending` waits on the session. Such a card can arrive after the
    turn end without moving the state, so it can stand over a result in `waiting-input`;
  - the token is the one of the engine conversation the session writes, and the pane runs that same conversation
    (`inReadConversation` in `server/src/sessions/companion-scope.ts`, the same check as for a send). `/clear` and
    `/resume` change the conversation without a change of state or `stateSince`, so the token is what tells the
    result of the new conversation from the one the agent read. A session without an engine conversation yet gets
    the 409 for any token;
  - the session's current read mark is `readMark`: its memory holds no message newer than the read and its
    `stateSince` is the one of the read. herdr's `working` shorter than the supervisor's grace never reaches the
    session, so a short turn typed in the terminal can end with no change of state or `stateSince`; its messages are
    what tells its result from the one the agent read. A turn whose `working` reaches the session moves
    `stateSince`, which tells it before its messages reach the server. Two results stamped in the same millisecond
    differ when the second one adds a message. A turns read that returned no messages read no result, and a turns
    read with a message trimmed to the ceiling of one message can miss the newest result: the mark of both names no
    read ("Turns route"), so their pick-up always gets the 409.

  The checks run in one synchronous step right before the receipt, with no `await` in between.
- **Messages that arrive late.** The session's memory holds what the server followed from the conversation file: the
  follower delivers a file entry in about 0.1 s, up to 2 s after a lost file system event, while herdr reports the
  states of a turn on its own. A turn whose `working` reaches the session moves `stateSince`, so a pick-up built from
  a read before that turn gets the 409, also after the turn's messages arrive. A turn that adds no message (a context
  compaction alone) moves `stateSince` as well and gets the same 409: the server cannot tell it from a turn whose
  messages are late, so the agent reads the session again. One case passes: a turn shorter than the supervisor's
  `working` grace, whose messages are not in the session's memory yet, with the pick-up inside that gap. That turn
  has changed neither the session's state nor its memory then, so the pick-up is accepted, and the receipt stays when
  the messages arrive.
- **A received result stays as it is.** A result that is received already (by a person, by herdr's `done → idle`,
  as an `idle` pane adopted at start, or by a pick-up before) gets 200 and no change: no `seenBy`, no session frame,
  no `agent.focus`.
- **A person takes over.** `POST …/seen` without `by`, as the app sends it when a person opens the session, drops
  `seenBy` in one session frame and keeps `seen: true`, with no `agent.focus`: the result is received, so no `done`
  badge is left to clear. "Show in herdr" (`POST …/focus`) is a person's receipt too and drops `seenBy`. "Mark as
  unread" (`POST …/unseen`) drops `seenBy` and sets `markedUnseen`.
- **Turns.** A late herdr `done` for the same turn keeps the pick-up and moves its durable entry to the `done`
  number, as for a person's receipt. A turn start drops `seen` and `seenBy` together. A turn without a result
  (`noResultTurn`) puts both back at its end (`carrySeenAcrossTurn`).
- **Restart.** The durable entry in `herdr-hidden.json` carries `by: "voice-agent"` (`SeenEntry` in
  `server/src/herdr/identity.ts`). A pane adopted after a Rarog restart gets `seenBy` back only when the entry's
  state number equals the pane's (`seenByOf`): another number may be another result. An entry without `by` loads as
  a person's receipt, and so does an entry with an unknown `by`. A server restart changes every conversation token,
  so a pick-up built from a read before the restart gets the 409 whatever its `readMark`.
- **An app that does not know the field.** `seenBy` is in `DEGRADATIONS` (`shared/src/decode.ts`): an unknown value
  drops the field and keeps the row, so the result reads as a person's receipt.

The gate, in order, after the device credential (401):

- A body with one or two of the three fields, a `by` other than `voice-agent`, or a `conversation` or `readMark`
  outside 1–64 characters: 400 `bad-request` (`rest.body-contract`), before any flag. Other keys drop out before
  the check, `stateSince` too, so a body of `stateSince` alone is a person's receipt.
- A body with the three fields: 503 `companion-disabled` when `RAROG_COMPANION` is not `1` or the voice agent module is
  missing, then 503 `companion-sessions-disabled` when `RAROG_COMPANION_SESSIONS` is not `1`. The flags come before
  the session lookup, so an unknown session id with a flag off gets the 503.
- An unknown session: 404 `not-found`. A session without a row in the session catalog ("Session catalog"): the 404
  of the turns route (`rest.companion-claude-only`).
- The 409 above.

A body without the fields (`{}` or an empty body, as the app sends it) is a person's receipt, whatever the flags. The
route has no `await` between the body and the answer. The server cannot tell such a body from the agent's: the
marking is the app's.

## Short-lived OpenAI key

The phone talks to OpenAI Realtime itself, with a key that lives 60 s. The server's own key (`OPENAI_API_KEY`, set
with `rarog voice-agent set-key`, "`rarog voice-agent`: the OpenAI key and model") never leaves the server. `POST /api/companion/token`
takes an empty body and answers `{value, expiresAt, model}` (`companionTokenBodySchema` and `companionTokenSchema`
in `shared/src/rest.ts`): the short-lived key, its expiry as an ISO date and the Realtime model from
`RAROG_COMPANION_MODEL`. The app fetches a new key for every conversation and every reconnect, never in advance.

`openai-token.ts` sends one `POST https://api.openai.com/v1/realtime/client_secrets` with `Bearer` and the model:
the address is fixed in code, a redirect is an error (the key goes to no other host), the timeout is 5 s and there
is no retry. The gate, in order:

- Demo mode, also review mode: no route (404, as for an unknown path), without the network.
- No device credential: 401; a foreign `Origin`: 403; a field in the body: 400. None of them reaches OpenAI.
- `RAROG_COMPANION` is not `1`, or no `OPENAI_API_KEY`: 503 `companion-disabled`.
- No Soniox voice (no `SONIOX_API_KEY`, or a key outside the EU region): 503 `companion-disabled` with the sentence
  `rest.companion-speech-key-missing` or `rest.companion-speech-disabled`, because the voice agent has no other voice.
- Throttle shared by all devices: an attempt within 3 s of the previous one, or past 60 attempts in an hour, is
  429 `companion-throttled` without the network. The throttle counts attempts, also failed ones.

OpenAI's answer maps to Rarog's own sentences, never to OpenAI's text: 401 or 403 is 503 `companion-openai-key`
(the server's key is wrong or revoked), 429 is 429 `companion-openai-limit`, any other status, a timeout, no
connection, a body that is not JSON, without a key or with an expiry in the past is 502 `companion-openai`. A request
closed by the client cancels the call to OpenAI and gets no body. When the key arrives, the server checks the device
again: a device revoked meanwhile gets 401 and the key is dropped; it expires on its own. A key already issued, and
a Realtime connection already open, stay valid until OpenAI ends them: revocation stops only new keys.

The log carries only the outcome: OpenAI's status, `timeout`, `unreachable` or the expiry of the issued key. It never
carries the server's key, the short-lived key, OpenAI's body or the text of a network error, and the server's key is
in `logSecrets`, so `redact` masks it in any log line, also with `RAROG_COMPANION=0`. `OPENAI_API_KEY` does not reach
the environment of `claude -p`, of terminal panes or of git.

Tests: `server/test/companion-openai-token.test.ts`.

## Temporary Soniox speech key

`POST /api/companion/speech-token` gives a paired device a temporary key for Soniox text-to-speech in the EU region,
for the voice agent's voice: whoever holds it can send text to Soniox and get speech audio back. The server's Soniox
key (`SONIOX_API_KEY`, the one dictation uses, set with `rarog dictation set-key`) never leaves the server. The route
takes an empty body and answers `{apiKey, expiresAt, webSocketUri, model, voice, sampleRate}`
(`companionSpeechTokenBodySchema` and `companionSpeechTokenSchema` in `shared/src/rest.ts`): the temporary key, its
expiry as an ISO date, `wss://tts-rt.eu.soniox.com/tts-websocket`, the model `tts-rt-v2`, the voice `Maya` and
24000 Hz. The server picks all of them; the body names none.

The voice agent speaks only with this voice, so the route has the voice agent's gate: `RAROG_COMPANION=1`, an OpenAI
key, a Soniox key and `SONIOX_API_HOST` empty or in the EU region. `GET /api/version` says `companionSpeech: true` and
`companionEnabled: true` together when all of them are there, and `false` for both otherwise.

The minter is the dictation minter (`createVoiceMinter` in `server/src/voice/soniox.ts`) with the kind
`COMPANION_SPEECH_KEY`: one `POST https://api.eu.soniox.com/v1/auth/temporary-api-key` with `usage_type` `tts_rt`,
`expires_in_seconds` 600, `single_use` false, `max_session_duration_seconds` 180 and a random
`client_reference_id`. The key opens new speech streams for 600 s, one conversation, and each stream lasts at most
180 s; an open stream is not cut when the key expires. The address is fixed in code, the timeout is 5 s and there is
no retry. The gate, in order:

- Demo mode, also review mode: no route (404, as for an unknown path), without the network.
- No device credential: 401; a foreign `Origin`: 403; a field in the body: 400. None of them reaches Soniox.
- `RAROG_COMPANION` is not `1`, or no `OPENAI_API_KEY`: 503 `companion-speech-unconfigured`
  (`rest.companion-speech-disabled`).
- No `SONIOX_API_KEY`: 503 `companion-speech-unconfigured` (`rest.companion-speech-key-missing`).
- `SONIOX_API_HOST` outside the EU region: 503 `companion-speech-unconfigured`
  (`rest.companion-speech-foreign-region`), without the network.
- Throttle shared by all devices and apart from dictation's: an attempt within 3 s of the previous one, or past 60
  attempts in an hour, is 429 `companion-speech-throttled` without the network. Failed attempts count.

Soniox's answer maps to Rarog's own sentences, never to Soniox's text: 401 or 403 is 503
`companion-speech-unconfigured` (`rest.companion-speech-key-rejected`), any other status, a timeout, no connection or
a body without a key is 502 `companion-speech-upstream`. When the key arrives, the server checks the device again: a
device revoked meanwhile gets 401 and the key is dropped; it expires on its own. A key already issued, and streams
already open, stay valid until they expire: revocation stops only new keys.

The log carries only the outcome (`companion speech: …`): Soniox's status, `unreachable` or the expiry of the issued
key; never the server's key, the temporary key or Soniox's body.

Tests: `server/test/companion-speech-token.test.ts`.

## Condensed session

A turn starts at a prompt a human wrote and holds the agent's text and one line per tool call:

```
### Turn 3 · 2026-11-09T10:00:00.000Z
USER: the human prompt
AGENT: the agent's text
[tool Bash: the command, at most 160 characters]
```

A prompt the human sent while the agent was working opens a turn too: the CLI keeps it only as a queue attachment,
recognized by `server/src/herdr/background/queued-prompt.ts`. Tool results, thinking, subagent side conversations,
CLI notes, the compaction summary, command tags and interruption entries are left out (entry shapes as measured on
CLI 2.1.322). A harness notification about a background task opens no turn in either of its forms: the queue
attachment lets only a human origin through, and the `user` entry is recognized by its origin with the transcript
notice's rule (`isTaskNotificationOrigin` in `server/src/herdr/background/notice.ts`), because its text does not
always start with a tag.

The text never pretends to be the whole history:

- **Byte ceiling (64 MB).** A longer file is read as a stream from its last 64 MB; the cut first line is dropped and
  the text starts with a note that the start of the session was not read. The read stops at the size measured
  before it, so lines a live session appends meanwhile do not raise it.
- **Character budget (1,000,000).** The oldest whole turns go first, and the note "turns 1–N omitted" stands in their
  place. When the newest turn alone exceeds the budget, its middle is cut with a marker.

## The `claude -p` call

The flags and their purpose stand in `cli-literals.ts`, measured on CLI 2.1.319 and 2.1.322:

- `--model sonnet`: on CLI 2.1.322 the alias runs Sonnet 5.5 on the subscription.
- `--setting-sources project` in a fresh empty directory under `<dataDir>/companion-cwd/` (mode 0700, removed after
  the call, so the parent stays empty): no user settings, so no user hooks, plugins or permission rules.
- `--strict-mcp-config` without an MCP config, `--tools ''`, `--disable-slash-commands`: no MCP servers, tools or
  skills.
- `--no-session-persistence`: no conversation file of the call on disk.
- `--bare` is not used: on CLI 2.1.322 it does not read the subscription login.
- The system prompt goes through file descriptor 3 and the question through stdin, so content is never in argv or on
  disk.
- Environment: only `HOME`, `USER`, `PATH`, `LANG` and `TMPDIR` (`COMPANION_ENV_PASSTHROUGH` in
  `server/src/config-env.ts`). On CLI 2.1.322 the subscription login needs `USER`. Rarog's secrets, `ANTHROPIC_*`,
  `CLAUDE_CODE_*` and `HERDR_*` do not pass.

Ceilings: 60 s per call, 64 kB of stdout and 64 kB of stderr; over a ceiling the process gets `SIGKILL`. One
question per session and two per server can be in flight; one more is refused, not queued.

Outcome codes: `companion-busy` (in flight), `companion-limit` (subscription limit exhausted), `companion-timeout`,
`companion-cli` (no program, no login, non-zero exit, output over a ceiling, no `result` event) and `aborted` (the
caller's signal). The outcome carries a short reason for the log and never content.

## Subscription limit

On CLI 2.1.322 the `rate_limit_event` carries `rate_limit_info.unifiedWindows.<window>.{utilization,status}`. The
module reports the highest utilization over the windows. A status that does not start with `allowed` (for example
`rejected`) means the limit is exhausted; `allowed_warning` (from 75 %) is not. `overageStatus` is not read.

## Model instruction and answer

The instruction is in English and tells Sonnet to answer in the language of the question. The condensed session
stands in a `<transcript>` block as data: a command written in it never applies to Sonnet, and a `<transcript>` tag
inside the data is neutralised. Sonnet returns three tags: `<answer>` (1–3 sentences to read aloud), `<found>` (`yes`
when the session contains the answer) and `<prompt>` (a prompt for the agent when it does not). A question has at most
2000 characters.

On a large session Sonnet sometimes leaves out the opening `<answer>` tag. `parseAnswer` (`prompt.ts`) then takes as
the answer the text before the trailing `<found>`/`<prompt>` block, without an unpaired `<answer>` or `</answer>`;
when nothing stands before it, or there is no such block, the whole text is the answer. Only a complete block that
runs to the end of the text counts, so a tag quoted inside the answer neither cuts it nor feeds `found` and `prompt`,
which are read from that block. The log line says `not well-formed`.

## Secret mask

The answer and the prompt pass through `maskSecrets` before they leave the server. The app masks the session text it
sends to OpenAI with the same rules. The mask is a sieve for common shapes, not a guarantee: `sk-…` keys (also
`sk-proj-…`), GitHub tokens (`ghp_…`, `github_pat_…`), AWS access key IDs (`AKIA…`), Slack tokens (`xox…-`),
`Bearer …` and the `Rarog-Device` credential become `[secret]`. A secret in any other shape passes unchanged.

The rules, their order and a synthetic example of each stand in `shared/fixtures/companion/secret-shapes.json`. The
server test (`server/test/companion-mask.test.ts`) checks that the code has exactly the table's rules and masks every
row as the table says.

## After a Claude Code update

The tests run on a fake process and never start the real CLI, so they do not notice a change in Claude Code. After
an update, check each entry of `cli-literals.ts` against the new version: the flags still isolate the call (no hook
events, no MCP servers, no conversation file), the subscription login works without `--bare`, `stream-json` still
ends with a `result` event, and `rate_limit_event` still carries `unifiedWindows`. Then update the entry's version.

## Configuration

The voice agent needs the OpenAI key (`rarog voice-agent set-key`), the Soniox key of dictation
(`rarog dictation set-key`), because it speaks only with the Soniox voice, and `RAROG_COMPANION=1`. A first
`rarog setup` asks for both keys before it writes `config.json` and sets the flag with both (`docs/server-config.md`,
"`rarog setup`"). Both questions can be answered "n": setup then names `rarog voice-agent set-key` (after
`rarog dictation set-key`) as the way to set it up afterwards, and the app's Voice Agent page in Settings shows where
to get the OpenAI key and the command to run on the Mac; the app takes no key.

### Flags

- `RAROG_COMPANION=0` (default; the demo always runs without it) is the flag of the voice agent routes
  `POST /api/sessions/:id/companion/ask` and `POST /api/companion/token`: `0` or `1`, empty
  means `0`, surrounding whitespace is ignored, anything else stops the start (`RAROG_COMPANION takes 1 or 0 (got:
  …)`). `rarog voice-agent set-key` writes `1` after a question when the secrets file has both keys ("`rarog
  voice-agent`: the OpenAI key and model"), and so does `rarog setup` in the `config.json` it creates. At `1` the
  ask route asks Sonnet about a session through `claude -p` on the subscription Claude Code is logged into on the
  Mac, and with `OPENAI_API_KEY` and a Soniox key from the EU region
  `GET /api/version` says `companionEnabled: true` and `companionSpeech: true`; at `0` the routes answer 503
  (`companion-disabled`, the speech key route `companion-speech-unconfigured`), and so do both key routes without
  either key. The Soniox key is the dictation key; dictation and the speech key route have separate throttles. The
  `claude -p`
  process gets only `HOME`, `USER`, `PATH`, `LANG` and `TMPDIR` from the server's environment, and its working
  directories live under `<dataDir>/companion-cwd/`. Under launchd the Claude Code login must work without a
  terminal: a run that cannot log in answers 503 `companion-cli` ("Security"). The server reads it once, at start.
  Rollback: `0` in `env` in `~/.config/rarog/config.json`, then `rarog restart`.
- `RAROG_COMPANION_SESSIONS=0` (default; the demo always runs without it) is the flag of the voice agent's mode
  across sessions: `0` or `1`, empty means `0`, surrounding whitespace is ignored, anything else stops the start
  (`RAROG_COMPANION_SESSIONS takes 1 or 0 (got: …)`), also in demo. At `1`, next to a working voice agent,
  `GET /api/sessions/:id/companion/turns` and `GET /api/companion/sessions` answer and `GET /api/version` says
  `companionSessions: true`; at `0` both routes answer 503 `companion-sessions-disabled` and the field is absent
  ("Turns route", "Session catalog"), and so do a message whose body carries `source` and `expectedConversation` and
  a `seen` body with `by` ("Picking up a result"); a start at `0` also drops the voice agent's messages still
  queued from before the restart ("Sending from the conversation"). Without
  `RAROG_COMPANION=1` it has no effect. No command writes it. The server reads it once, at start. Rollback: `0` or
  no entry in `env` in `~/.config/rarog/config.json`, then `rarog restart`.
- `RAROG_COMPANION_MODEL=gpt-realtime-2.1` (default) is the OpenAI Realtime model the short-lived keys of
  `POST /api/companion/token` are issued for; the app connects with the model from the response. Empty means the
  default, surrounding whitespace is ignored, a name outside `gpt-realtime[a-z0-9.-]*` stops the start.
  `rarog voice-agent set-model` writes it ("`rarog voice-agent`: the OpenAI key and model"). The server
  reads it once, at start.
- `OPENAI_API_KEY` is a `secret` in the registry (`server/src/config-env.ts`): it comes from the parent
  environment (`service.wrapper`) or from `~/.config/rarog/secret/private.env`, like the other secrets
  (`docs/server-config.md`, "Config file and `rarog serve`"). A value never goes into `config.json`, a script or a
  log. Rotation: `rarog voice-agent set-key` (or the secrets manager behind the wrapper), then `rarog restart`.

### `rarog voice-agent`: the OpenAI key and model

The voice agent's OpenAI key (`OPENAI_API_KEY`) lives only on the server; the app gets short-lived Realtime keys
from `POST /api/companion/token` ("Short-lived OpenAI key"). `rarog voice-agent set-key` saves
the key in `private.env`, `rarog voice-agent set-model <model>` writes `RAROG_COMPANION_MODEL` in `config.json`, and
`rarog voice-agent status` prints the state on disk without the key. None of them restarts the server or calls
OpenAI; the server reads the keys, the model and the flag at start, so a change needs `rarog restart`. Without the
OpenAI key, without the Soniox key or with `RAROG_COMPANION=0`, the server says `companionEnabled: false` and the
OpenAI key route answers 503 `companion-disabled`.

- `set-key` works like `rarog dictation set-key` (`docs/server-config.md`, "`rarog dictation`: the Soniox key"; input,
  refusal under `service.wrapper` before asking, Rarog's lock after the answer, write and cleanup) and changes only
  the `OPENAI_API_KEY` line. It reminds you that every paired device can get short-lived keys paid by this key, so the
  key belongs to a separate OpenAI project with only Realtime access and a budget limit. Without `SONIOX_API_KEY` in
  the secrets file it then names `rarog dictation set-key` as the step before the voice agent and writes no flag.
  With both keys, when `RAROG_COMPANION` in `config.json` is not `1` (missing or `0`), it asks
  `Turn on the voice agent? [y/N]`. "y" writes `RAROG_COMPANION=1` to `config.json`. It uses the `set-model` writer
  and the same refusals, under Rarog's lock taken after the answer, and checks both keys again under the lock. Any
  other answer leaves `config.json` unchanged. With the flag already `1` there is no question. Without a terminal, or
  without `config.json`, it prints only the command that turns the agent on and writes nothing. A failed flag write exits with
  1 and keeps the saved key. The output ends with `run rarog restart`.
- `set-model` takes one name matching `gpt-realtime[a-z0-9.-]*` (e.g. `gpt-realtime-2.1-mini`); anything else is a
  refusal. It follows a symlink and replaces the target (the link stays), and it rewrites only a file in the exact
  layout `rarog setup` writes (two-space JSON with a final newline): only the model value changes, every other byte
  stays. Another layout, a missing `config.json`, a broken symlink, a target that is not a regular file, a file
  over 64 KiB, a file `rarog serve` would refuse or a failed write is a refusal with the original untouched and no
  temporary file left. The write keeps the file's mode and goes through a temporary file next to the target and
  `rename`; right before `rename` the command reads the target again, and other bytes, another inode or another
  link target is a refusal. The same model writes nothing.
- `status` prints the config file and the secrets file (`present` or `missing`), `OPENAI_API_KEY` and
  `SONIOX_API_KEY` as `set` or `not set` (`not checked` under `service.wrapper`, which the command does not run), the
  model (the default
  `gpt-realtime-2.1` when `config.json` has none), the `RAROG_COMPANION` flag and a line for `OPENAI_API_KEY` in
  the shell's environment (`rarog serve` started from that shell uses it instead of the file; `set-key` prints it
  too). It describes the configuration on disk, not the state of the running server.

Tests: `server/test/rarog-voice-agent.test.ts`.

`rarog --help` lists the command, and `rarog voice-agent --help` prints its usage. Code:
`server/src/cli/voice-agent.ts`, with `voice-keys.ts` (the flag rule of both keys, shared with the voice questions
of `rarog setup` in `setup-voice.ts`, and the key read from the input), `config-rewrite.ts` (the `config.json`
writer of `set-model` and the flag),
`secrets-file.ts` (one secret written into the secrets file under Rarog's lock, shared with `rarog dictation set-key`
and the iroh server key of `rarog setup`) and `secret-input.ts` (the question without echo and the whole of standard
input).

## Security

`POST /api/sessions/:id/companion/ask` lets a paired device ask Sonnet what happened in one Claude Code session
("The route"). `RAROG_COMPANION=1` turns it on; it is off by default and in every demo. The ask route sends nothing to
a pane, approves nothing and writes nothing in a project. The only voice agent path to a pane is a prompt of the mode
across sessions through the ordinary message route, and both flags stop it ("Sending from the conversation"). The
only other state the mode changes on the server is the `seen` marker of a result it read ("Picking up a result"),
and both flags stop that too.

- **What leaves the Mac.** The session's condensed conversation file and the question go to Anthropic through
  Claude Code on the owner's subscription, the path the session's own content already takes. The server sends them
  to no other service.
- **The process.** `claude -p` is on the closed list of rule 13 of `docs/security-model.md`, "herdr sessions", and starts only from
  `server/src/companion/cli.ts` (`server/test/companion-granice.test.ts`). It runs with no tools, MCP servers, slash
  commands, user settings or conversation file of its own (flags in `cli-literals.ts`), in a fresh empty 0700
  directory under `<dataDir>/companion-cwd/`, with the environment cut to `HOME`, `USER`, `PATH`, `LANG` and `TMPDIR`:
  Rarog's secrets, `ANTHROPIC_*`, `CLAUDE_CODE_*` and `HERDR_*` do not pass. Content goes through stdin and file
  descriptor 3, never argv. Ceilings: 60 s, 64 kB of stdout and of stderr, one question per session and two per
  server; over a ceiling the process gets `SIGKILL`.
- **The gate.** The device credential and a Claude Code session in scope with its directory in the work area of
  `RAROG_HERDR_ROOTS`. A Codex session or a pane out of scope is 404. The server picks the session's current engine
  conversation itself; the body names none, so the app cannot point the question at another conversation file.
- **The transcript is data.** The instruction tells Sonnet that a command written in the session never applies to
  it, and Sonnet has no tools, so a hostile line in the transcript can bend only the text of the answer.
- **The last turns of any session in scope.** With `RAROG_COMPANION_SESSIONS=1`, a paired device can read the last
  1–3 turns of every Claude Code session in scope through `GET /api/sessions/:id/companion/turns` ("Turns route"),
  also of a session whose screen it does not have open. That is the content the session stream already gives the same
  device, cut to the current engine conversation: nothing from before `/clear` comes out this way. The route goes to
  no other service, writes nothing to disk and keeps nothing between reads; whatever the app does with the turns
  happens on the phone. The response carries an opaque token of the engine conversation, never its id, and the token
  changes with every server restart.
- **Which sessions the mode may see.** `GET /api/companion/sessions` lists only Claude Code sessions in scope, by
  the same gate, with an id, the conversation token, `stateSince` and `asksOwner`, and no text ("Session catalog").
  A Codex session, a pane out of scope and a session directory outside the roots get no row.
- **A prompt from the conversation.** With both flags the voice agent can cause a prompt to be typed into a session
  whose screen the device does not have open; the prompt runs at once and cannot be taken back. What stops it on the
  server: the two flags (503 for a body marked as the agent's), the 409 for a session that moved to another
  conversation, every gate of the message route with its throttle (240 sends an hour for all sessions), and
  `RAROG_HERDR_SEND=0`, which refuses every send. The owner's spoken confirmation lives in the app
  ("Conversation across sessions"); the server does not check it. The server cannot tell a body without the fields
  from a typed message: a paired device can send prompts anyway, and the marking is the app's. The audit log names
  the agent's prompts with `sender` ("Sending from the conversation").
- **A result marked as received.** With both flags the voice agent can mark the result it read as received
  ("Picking up a result"): the row carries `seen: true` and `seenBy`, the session's pending push notification is
  cancelled, and while herdr shows a standing `done` badge `agent.focus` switches the view of every attached herdr
  client on the Mac to that pane, behind the gates of the person's receipt (`RAROG_HERDR_SEEN_FOCUS=0`,
  `RAROG_HERDR_SEND=0`, read-only herdr). What stops it on the server: the two flags (503 for a body with `by`),
  the scope of the session catalog (404) and the 409 for anything but the result the agent read: a session outside
  `waiting-input` or with a decision card waiting on it, another engine conversation than the one of the token, a
  message in the session's memory newer than the turns read or another `stateSince` (another `readMark`), or a mark
  from a turns read that returned no messages or a message trimmed to the ceiling of one message. A turn shorter
  than the supervisor's `working` grace whose messages the server has not followed from the conversation file yet
  is outside the mark ("Picking up a result"). The body without `by` is the app's own receipt, which any paired
  device can send.
- **Secret mask: a sieve, not a guarantee.** Before the answer leaves the server, common secret shapes (`sk-…`,
  GitHub tokens, AWS access key IDs, Slack tokens, `Bearer …`, `Rarog-Device …`) become `[secret]`; the rules stand
  in `shared/fixtures/companion/secret-shapes.json`. A secret in another shape reaches the phone as the session wrote
  it.
- **Kill on revocation.** Revoking the device that asked kills its question's process and closes the response without
  a body (`docs/security-model.md`, "Pairing and device keys", paragraph "Revocation"). A new engine conversation in
  the pane (`/clear`, `/resume`) kills a question about the previous one and closes its response the same way.
- **Log.** A question's log line carries the session id, the outcome code, times and counts, never the question,
  the transcript or the answer.
- **The OpenAI key stays on the server.** The voice conversation runs between the phone and OpenAI Realtime. The
  server's key (`OPENAI_API_KEY`, a `secret` in the registry) is in `logSecrets`, never in a response, and does not
  pass into `claude -p`, terminal panes or git. A paired device gets only short-lived keys (60 s) from
  `POST /api/companion/token` ("Short-lived OpenAI key"): the request goes only to the address
  fixed in code, a redirect is an error, and a throttle shared by all devices (3 s apart, 60 an hour, failed
  attempts included) caps what a stolen device key can spend. Every paired device can spend the account's money
  this way, so the key belongs to a separate OpenAI project with only Realtime access and a budget limit.
- **Revocation and OpenAI.** A revoked device gets no new short-lived key, also when it is revoked while the server
  waits for OpenAI (401, the key is dropped). A short-lived key already issued and a Realtime connection already
  open are not revoked: the key expires within 60 s, and OpenAI ends the connection on its own terms.
- **A leaked server key.** Revoke the key in the OpenAI dashboard, save a new one with
  `rarog voice-agent set-key` (or in the secrets manager behind `service.wrapper`) and run `rarog restart`
  ("`rarog voice-agent`: the OpenAI key and model").
- **The Soniox voice: a second flow.** While the voice agent works, a paired device gets temporary Soniox
  text-to-speech keys from `POST /api/companion/speech-token` ("Temporary Soniox speech key"). Whoever holds such a
  key can send text to Soniox's text-to-speech service in the EU region (`tts-rt.eu.soniox.com`) and get audio back;
  the server sees neither the text nor the audio. With the voice agent off the route answers 503 and no such key
  exists.
- **The Soniox speech key boundary.** The permanent Soniox key stays on the server, as for dictation (point 15 of
  `docs/security-model.md`, "Dictation: microphone, the Soniox key and Apple speech recognition"). The speech key is
  plain, not `single_use`: it opens new streams for 600 s, each stream lasts at most 180 s, and Soniox runs at most 3
  streams at once per organization. A throttle shared by all devices and apart from dictation's (3 s apart, 60 an
  hour, failed attempts included) caps how many keys a stolen device key can get. A revoked device gets no new speech
  key, also when it is revoked while the server waits for Soniox (401, the key is dropped); a key already issued keeps
  opening streams until it expires, up to 600 s on the owner's Soniox account. A leaked permanent key: replace it as
  for dictation (`rarog dictation set-key`, then `rarog restart`).
- **Revocation, a lost phone.** Revoking a device (`rarog devices revoke <id>`, Forget Server, expiry, a stale
  epoch) also kills the `claude -p` process of every voice agent question the device has in flight and closes those
  responses without a body; the device gets no new short-lived OpenAI key, and one already issued expires within
  60 s (`docs/security-model.md`, "Emergency runbook").
- **Turning it off in an emergency.** `RAROG_COMPANION=0` (the default) and `rarog restart` turn every voice agent
  route off, the turns route and the session catalog included, and refuse every message and every `seen` body marked
  as the agent's; `RAROG_COMPANION_SESSIONS=0` turns off only the mode across sessions: those two routes and the
  marked messages and `seen` bodies (`docs/security-model.md`, "Emergency runbook"). The restart that applies
  either flag also drops the voice agent's prompts still waiting in the paste queue ("Sending from the
  conversation"); a prompt already pasted stays in the pane's field.
- **Review demo.** In review mode the voice agent routes are of the class `absent` (404, as for an unknown path),
  like every demo, which has none of them (`docs/security-model.md`, "Review demo server").
- **Work area.** The ask route judges the session directory with the work area predicates of
  `server/src/config/work-area.ts` (`inWorkAreaOnDisk`), like pane scope and the diff (`docs/security-model.md`,
  "Work area: where Rarog starts, lists and reads").
- **Lost Mac.** `OPENAI_API_KEY` is one of the server secrets to restore, next to `SONIOX_API_KEY` (step 2 of
  "Lost Mac" in `docs/security-model.md`, "Emergency runbook").

## App

### Settings

- **Voice agent settings:** Settings → Voice Agent (`RarogUI/Views/VoiceAgent/`, rules in
  `RarogCore/VoiceAgent/VoiceAgentSettings.swift`, attached as `RarogStore.voiceAgent` by
  `AppEnvironment.voiceAgent()`). The row has three states (`VoiceAgentSettingsModel.availability`): hidden in a
  build without Soniox (`RAROG_VOICE_SONIOX`) and before the server's first answer; "Not set up" when the server
  answered and the app does not offer the voice agent (`VoiceAgentAvailability`: `/api/version` says
  `companionEnabled: true` and `companionSpeech: true`; a missing field reads as false, so an older server that
  announces only `companionEnabled` is not set up); and the switch page where it is offered. The not-set-up page has
  no switch and no consent: one line on what the voice agent is, then the setup steps for the person who runs the
  server (dictation with Soniox working on the server, left out once it works; an API key at
  platform.openai.com/api-keys, ideally in a separate project with a budget limit, since every paired device uses
  it; `rarog voice-agent set-key`, then `rarog restart`) and a link to the OpenAI API keys page. A page left open
  while the server's answer goes away keeps the steps. A stored consent stays untouched there and applies again once
  the server offers the agent. The session button, ⌥⌘V and `VoiceAgentWatch` follow `VoiceAgentAvailability` alone.
  The switch turns on only through
  the consent page (what goes to OpenAI, the United States, the API data policies; the text of the agent's answers
  to Soniox in the EU to be read aloud; the OpenAI key on the Rarog server and a short-lived key per conversation
  on the device; the cost of a question at OpenAI and of the reading at Soniox, and the tokens-per-minute limit of
  a new account); a page without "Agree and Turn On" leaves it off. The consent stores the version of the consent text
  (`VoiceAgentSettings.consentVersion`); a consent to an older text counts as none at start, so the switch is off
  until the user agrees again. Turning it off removes the consent. The app stores no OpenAI API key, does not choose
  the model and sends no request to OpenAI from these settings. When the switch is on, the page shows the Voice row
  as Soniox, with a note that the Rarog server sets that voice (there is no voice to choose), and under it a
  Reading Speed picker (`VoiceAgentSettings.speechSpeeds`: 1.0, 1.1, 1.2, 1.3; labels in the app language, "1,2×"
  in Polish, 1.0 marked normal). The choice applies from the next conversation; a stored speed outside the list
  reads as 1.0. The voice conversation across sessions has a consent of its own, with its own text version
  (`VoiceAgentSettings.sessionsConsentVersion`, `sessionsEnabled`, `acceptSessionsConsent`,
  `withdrawSessionsConsent`). The two are stored apart, and turning the switch off leaves the mode's consent stored.
  The mode's text adds to the voice agent's, so the mode runs only with both (`sessionsAllowed`); the conversation at
  a session needs the voice agent's alone. Where the server offers the mode (`AppState.companionSessionsOffered`), the
  page has a second switch, "Talk About All Sessions" (`VoiceAgentSettingsModel+Sessions.swift`), also while the
  voice agent is off, so a mode's consent kept then can be removed: on opens the mode's consent page and stores nothing, its "Agree and
  Turn On" stores the mode's consent and starts no conversation, Cancel leaves the switch off, and off removes the
  mode's consent, so a running conversation across sessions ends as turned off. The mode's consent page
  (`VoiceAgentConsentPage` with the mode's text, `voiceAgent.sessions.consent.*`) names only what the mode adds: to
  OpenAI the list of sessions from all projects the server shares with the voice agent (names, states, the first
  line of a dialog), the recent turns of the sessions the conversation asks about and the answers Rarog gives the
  agent; to Soniox the text of the answers, session names and the text of prompts; and that the agent sends a prompt
  to a session only on the user's word. The consents and the reading speed live in `UserDefaults` (`rarog.voiceAgent.consent`,
  `rarog.voiceAgent.sessionsConsent`, `rarog.voiceAgent.speechSpeed`) and survive Forget Server; a voice an older
  build stored under `rarog.voiceAgent.voice` stays unread. Whether a recording goes on in the background has no
  setting ("Locked phone" below).
  Tests: `VoiceAgentSettingsTests`, `VoiceAgentSettingsModelTests`.

### Conversation

- **Voice agent conversation (`Session/Voice/Realtime/`, settings in `Views/VoiceAgent/`):** the conversation lives in
  the session screen of a Claude Code session, without a window of its own. The voice agent button in the
  composer row, in its left group after the session pills, starts it and ends it. The button stands only when the switch in Settings is on
  and the app offers the voice agent (`VoiceAgentAvailability`: `companionEnabled: true` and `companionSpeech: true`
  in `/api/version`, a build with Soniox; a missing field reads as false), and it is dimmed while dictation
  records: there is one microphone (`VoiceAgentEntry`). A running conversation ends as turned off when the voice
  agent stops being offered, e.g. `companionSpeech` turns false (`VoiceAgentWatch`). ⌥⌘V (`AppShortcut.voiceAgent`,
  changeable on the Settings → Voice Agent page) does what a tap does; it is registered only where the button stands
  or a conversation runs (`VoiceAgentKey`), so without the voice agent the iPadOS menu bar does not name it and the
  shortcut sheet under a held ⌘ drops its row, and while dictation records it does nothing;
  the button's pointer tip reads "Talk with the voice agent (⌥⌘V)". During the conversation the button is filled with
  the color of the state, its label is "End voice conversation", and five bars on it follow the voice of whoever
  speaks: the microphone while the app listens, the played output while it answers, still bars with Reduce Motion. The
  status row above the control row, shared with dictation, says what happens (`VoiceAgentIndicator`): Connecting,
  Listening, Hearing you, Thinking, Checking the session with a seconds counter, Answering, "Prompt in the field"
  (after `show_prompt`, until the next speech, a send or a phase other than listening) and "Sent to the session" for 3
  s after a send of the field, with ↑ or by voice (a send result shows it only in the conversation it came from and
  before a newer prompt, `VoiceAgentSession.SendMark`). One owner of the row at a time (`VoiceStatusOwner`): a running
  conversation owns it, a field edit does not hide it, and its end sentence gives way to dictation and goes on a tap
  or an edit. The screen reader hears a change
  of sentence, not each tick of the counter. During the conversation the composer microphone shows a crossed
  microphone ("Mute Microphone") and a tap or the dictation shortcut (⌥⌘M) mutes the conversation: the mic lights up
  like a dictation recording (ring and icon in the error color, selected, "Unmute Microphone"), and the status row
  says "Muted" where it would say Listening or Hearing you; the other states show as usual. Muted, the audio engine
  keeps running (playback, echo cancellation, Soniox speech), but no microphone audio goes to OpenAI, no input counts
  in the usage, and the microphone level reads zero; the mute sends `input_audio_buffer.clear` once, so a half-spoken
  utterance is dropped, and the agent still finishes its answer. Late VAD events of that utterance order nothing: a
  `speech_started` while muted is ignored, and its `committed` (also after a quick unmute) orders no answer and its
  item is deleted. The mute lasts until the next tap or the end of the conversation;
  each conversation starts unmuted (`RealtimeConversation+Mute.swift`, `VoiceAgentSession.toggleMute`). To dictate,
  the user ends the conversation with the voice agent button first. The transcript above stays visible and scrolls.
  A tap starts three steps side by side (`RealtimeConversation+Start.swift`): the Soniox speech key, the OpenAI key
  and the audio engine. The OpenAI socket opens with both keys in hand, and the conversation leaves Connecting only
  when the engine runs and `session.updated` came, in either order; microphone audio before that goes nowhere and
  does not count. A refused key ends the conversation with its sentence and stops the engine; when both are refused,
  the speech key's sentence wins.
  `VoiceAgentSession` wires
  the conversation to the store, and its session host (`VoiceAgentSessionHost`) gives it the transcript, the tools
  and the end rules: the key comes from `POST /api/companion/token` (`RarogStore.mintCompanionToken`;
  `companion-disabled`, a bad server key, the Rarog throttle and the OpenAI limit end with different sentences, the
  first two name `rarog voice-agent status` and `set-key`), `ask_session` asks `POST /api/sessions/:id/companion/ask`
  (75 s), `show_prompt` writes the prompt into the message field (`VoiceAgentDraft`: an empty field gets the prompt
  alone, a field with text gets it on a new line under the text, an untouched prompt of the agent from before at the end
  of the field gives way to the new one, and a prompt the user edited stays with the new one under it; the prompt
  follows each edit by the range the field reports for it (`ComposerView.lastEdit`: `shouldChangeTextIn` of the text
  view, which the field's own edits ask too through `ComposerTextView.insertFromCode`, i.e. pasted text with an
  address, Shift+Return and a picked command; text from code as the whole field), so an edit whose range covers the
  whole prompt removes it even when the new text shares its first or last characters, a prompt once gone does not
  come back with undo, and only an edit the field does not report is compared as two texts; the cursor goes to the
  end, the prompt is highlighted for 3 s and the draft is saved; while a character is being composed (IME) the
  prompt waits for the end of composing; a hidden or read-only field refuses with its reason; the result
  tells the model where the prompt went and what a send takes, never the field text), and `send_prompt` runs the
  same send operation of the field as ↑ (`SessionViewController.sendField`, typed result `ComposerSendResult`): it
  takes the whole field as it stands, the user's text and the attachments too, once per prompt and only while the
  field still holds the prompt (sent with ↑, cleared or overwritten by the user: the model hears the field no longer
  holds it). It never stops a running turn; a read-only field, a starting agent, an app command (the app handles it
  as with ↑), loading attachments and too many attachments refuse before anything is taken; a refused send gives the
  text back to the field as the user's text; the login of the start is checked before the field is taken, and the
  login of that moment again right before the request (`sendField(byVoice:)`): after a change nothing goes out and
  the model hears "not sent"; the text and the attachments come back to the field only while the screen is attached
  and the space of the server is the same (`RarogStore.interfaceEpoch`), otherwise nothing goes to the attachment
  shelf, which is keyed by the session id alone, the attachment files are discarded and the text goes to the draft
  only in the same space (↑ does not have this check). The model
  hears fixed sentences, a refusal code that is an identifier and fixed names of a read-only field
  (`VoiceAgentToolText.closedField`), never the server's message or the sentence under the field. A key
  or a 401 that returns after a new login or a server change neither starts the conversation nor logs out. The
  conversation ends when the user logs out or unpairs, logs in again, opens another session, turns the feature off,
  the app goes to the background (not a ready conversation while its Live Activity tile stands, or on a device
  without tiles until the screen locks: "Locked phone"), dictation starts outside the composer (a note), the
  message field goes away (a state card or the decision dock),
  the user leaves the screen, or the session starts a new engine conversation (`transcript.repoint-clear`, `-resume`)
  (`VoiceAgentWatch`). It also ends by itself 20 minutes after the tap, whatever happens in between (a mute, an
  answer that plays), with the sentence "The conversation ended after 20 minutes." (`VoiceAgentSession.sessionLimit`:
  one timer on the conversation's clock for every host, and a timer of an ended conversation does not reach the next
  one). `client.log` gets `voice-agent:` lines, never the conversation text: one ready line per
  conversation that got ready, `ready after <total> ms (keys <a> ms, session <b> ms, audio <c> ms)` (keys and audio
  from the tap, session from both keys in hand to `session.updated`), the model
  `session.created` names (and a second line when it differs from the key's), the audio format at start (or, when the
  engine does not start, the step and the system error code, e.g. `audio start failed at engine start -10875`), each `speech
  started` and `speech stopped`, each `noise ignored`, each `muted` and `unmuted`, the time to the first audio, one
  line per
  `response.done` with its status, text and
  audio tokens in (cached ones as a subset), text tokens out (the session has no output audio, so the table prices
  none), and its price, and one end line with the reason (a close by
  `VoiceAgentWatch` adds its cause, e.g. `ended closed (field-hidden)`; the length limit is `ended session-limit`),
  the duration, the number of responses (and of
  those without `usage`), speech starts, the microphone peak (0–1), the `ask_session` and `send_prompt` calls and the
  total price. A repeated `response.done` counts once; the total is marked `partial` when a response came without
  `usage` or was still open at the end; `usage` with non-zero `input_tokens` or `output_tokens` but without their
  details counts as without `usage`. These lines use the voice agent trace budget, the end line passes outside it
  (`TraceBudget`). Prices come from one table, `RealtimePricing` (`gpt-realtime-2.1` and `gpt-realtime-2.1-mini`);
  another model gets tokens without a price (`RealtimeConversation+Usage.swift`, `RealtimePricingTests`).
  `RealtimeConversation` talks to OpenAI Realtime over a WebSocket with a short-lived key from an injected provider
  (the app holds no OpenAI key); `RealtimeEndpoint.socketAuth` picks whether the key rides in the WebSocket protocol
  list or in an `Authorization` header. `session.update` carries the instruction, the tools `ask_session`,
  `show_prompt` and `send_prompt`, far-field noise reduction of the input before the VAD (`noise_reduction`
  `far_field`), `server_vad` without its own responses, without cancelling a response on speech
  (`interrupt_response: false`, the app decides the cut) and without input transcription (the app shows no
  captions), 24 kHz pcm16 input, and text output only, with no output audio and no OpenAI voice.
  `RealtimeProjector` builds the session text from the transcript
  window the store holds (labels as in "Condensed session", budget 15,000 characters, about 5k tokens, because every
  response pays for the whole instruction: the oldest turns go first, `ask_session` answers about them, and a
  note stands in their place) and masks secret shapes with the rules of `shared/fixtures/companion/secret-shapes.json`
  (`RealtimeSecretMask`). After `input_audio_buffer.committed` new session turns go in as a system item, then
  `response.create`. Speech while a reply plays or waits to play (a Soniox item not over, or queued audio) does not
  cut it at once (`RealtimeConversation+Noise.swift`): the playback volume drops to a quarter and a window of 1.2 s
  starts (0.4 s of speech plus the 0.8 s of silence after which the VAD reports the end). At a `speech_stopped`
  within the window the VAD's own times decide: `audio_end_ms` minus `audio_start_ms`, less the 300 ms prefix padding
  and the 0.8 s of silence that the OpenAI reference counts in them (`RealtimeBargeIn.speechLength`). At least 0.4 s
  of speech cuts at once, and the utterance gets its answer. Shorter speech, or an event without its time, is noise:
  the volume comes back, the reply goes on, the utterance orders no answer and its item is deleted, as after a mute.
  Speech that outlasts the window cuts, and so does speech while nothing plays, at once. Tool calls that come during
  the window, and tool work not started yet, wait for the verdict (all three tools): noise runs them in order, the
  cut drops them with the interrupted replies (no result, nothing ordered), and the end and the mute drop them too.
  After noise, tool results and their `response.create` wait until the noise's `committed` deleted its item, so the
  model never answers the noise; the next speech and the mute end the wait too, and the end drops it.
  The cut clears playback, notes the samples actually played (the quiet part counts as heard), drops late deltas,
  sends `response.cancel` for the replies still open, and brings the volume back
  (`RealtimeConversation+Playback.swift`); the conversation is then fixed to the heard text (below). The end of the
  conversation and the mute close the window without a cut. The levels of
  the bars come at most every 0.05 s and only on a change (`RealtimeConversation+Levels.swift`): the microphone peak
  since the last event, and the output peak over the samples played since then (`playedSamples`), so queued audio does
  not move the bars before it plays. Each level rises at once with a peak and in silence falls by a fifth per event
  down to zero, before the change check, so the bars and the dot always come to rest and silence at rest sends no
  events; an interruption, an audio restart and the end set both to zero. A generation number and the set of
  interrupted replies drop late keys, deltas, prompts and tool results; a tool does not start after the end or an
  interruption, and a reply ordered before the last interruption is cancelled with `response.cancel`. A
  `response.create` refused because a reply is still active is sent again after that reply's `response.done`.
  `send_prompt` without a prompt from `show_prompt`, in the same reply, or after the prompt left the field is a tool
  error. A host tool that waits for the user's word in the same way gets the moment of its call
  (`RealtimeToolTurn`): the reply that made it, the count of the user's kept utterances in this conversation
  (noise and muted speech do not count), and whether one of them began after the last reading played out whole
  (below). An OpenAI limit ends the conversation without a retry.
  `SonioxSpeech` (`SonioxSpeech.swift`, frames in `SonioxSpeechFrames.swift`) reads text aloud with Soniox
  text-to-speech. One socket per short-lived key (the key rides in the protocol
  list), one stream per utterance and one stream at a time, so the next utterance waits for `terminated` of the one
  before it; a key within 30 s of its expiry opens no stream: the client asks for a new key and a new socket, and a
  401 asks once. A keepalive goes out every 20 s between streams. Stream errors end that utterance, a dropped socket
  ends the client, both as events; `cancel` drops the late audio of its utterance. The heard text is the spoken
  characters (after Soniox normalized the text) whose end time lies within the played samples
  (`SonioxSpeechTests`). Each start frame carries `speed` (Soniox takes 0.7–1.3, 1.0 normal): the device's reading
  speed from Settings, read when the conversation starts and passed by `VoiceAgentSession` to `VoiceAgentKeys`, which
  puts it in every speech key's config, renewed keys included.
  Soniox speaks every answer; there is no OpenAI voice, and without Soniox (a server that does not announce
  `companionSpeech: true`, or a build without `RAROG_VOICE_SONIOX`) the app offers no voice agent
  (`VoiceAgentAvailability`). In each conversation (`RealtimeConversation+Speech.swift`) the speech key comes from
  `POST /api/companion/speech-token` (`RarogStore.mintCompanionSpeechToken`), fetched beside the OpenAI key; no OpenAI
  socket opens without it. The app takes it only as a `snx_temp_` key with an expiry, a `wss` address and 24 kHz.
  Without it the conversation does not start, with its own sentence (the Soniox voice is off on the server or its
  key does not work, unavailable, or the Rarog throttle). Each answer item goes to Soniox delta by delta in the app
  language (`pl` or `en`) with the voice `Maya`, and its PCM plays on the sample axis of the playback
  (`playedSamples`). An item has three ends: its text (`response.output_text.done`, or its `response.done`), its
  synthesis (`terminated`) and its playback (the queue
  drained after the synthesis); the state stays Answering until the last of them, so a queue that runs dry before the
  synthesis ends changes nothing. A response with a tool call only opens no stream. A key near its expiry is renewed
  through the same route; a Soniox failure during the conversation, or no key at a renewal, ends it with its reason,
  without a retry. The exception is an error frame that ends one stream (`SonioxSpeech.Failure.endsStreamOnly`): the
  stream limit (403 `temp_api_key_session_expired`) and a Soniox backend call past its deadline (408
  `request_timeout`). That item's synthesis ends, what Soniox said plays out, the rest of its text goes nowhere (it is
  not sent again), and the conversation goes on; the next item speaks on the same socket. Any other error on an
  answer item's stream, an error frame for the whole connection and a dropped socket end the conversation (a tool's
  reading: below).
  Speech over the answer (`RealtimeConversation+SpeechBargeIn.swift`) cancels every item not over yet: a running
  stream gets Soniox `cancel`, a waiting one never starts, and late deltas of the interrupted reply open no stream.
  OpenAI then keeps only what the user heard. `conversation.item.truncate` works on audio only, so a text item is
  deleted (`conversation.item.delete`) and created again (`conversation.item.create`, assistant, `output_text`
  with the heard text, `previous_item_id`). The heard text is the Soniox characters that end within the played
  samples of the item. With nothing heard the item is only deleted; an item that played out whole stays. A reply
  still open gets its fixes at its `response.done`, and an utterance committed before that waits with its
  `response.create`, so the fixes always come first. It waits the same way while a reply ordered before the speech
  is not created yet (or refused with `conversation_already_has_active_response`). The items of a reply created
  after the speech are deleted at its `response.done`. After an error that ends one stream the item is fixed the
  same way to what Soniox said.
  A host tool can have a text read aloud before its result (`RealtimeToolAction.workAndRead`,
  `RealtimeConversation+Reading.swift`): its work ends either in the result or in a text and a function that turns
  the reading's outcome into the result. Soniox reads exactly that text as a stream of its own, queued behind the
  items already in the Soniox queue, so it plays after the audio queued before it and before the model's next
  answer. The call's result goes to the model only at the reading's end, with one of two outcomes: played out whole
  (Soniox ended the stream after audio, with no stream limit and no error on it, and the queue drained after that),
  or not read (no audio, the stream limit, an error on its stream, no first audio or no end of the stream in time, the
  playback lost by an engine restart, or no Soniox speech; what Soniox said of it plays out first). Once the
  reading's own stream started (after the streams queued before it ended), the conversation waits 10 s for its first
  audio (`SonioxSpeech.Timing.firstAudioLimit`); past it the stream gets Soniox `cancel` and the reading is not read.
  Once the queue drained with the
  reading's audio played and its stream not ended, the conversation waits 3 s for the end (the wait `SonioxSpeech`
  gives a stream whose `terminated` does not come), started again at the next drain when more audio came; past it
  the stream gets Soniox `cancel` and the reading is not read. An error on the reading's stream does not end the
  conversation; a failure of the whole Soniox connection does. Speech over a reading, also one that waits for its
  stream, goes through the noise window as over an answer: noise lets it go on, and the cut stops its stream with
  Soniox `cancel` and drops the call with the other results in flight, so no result goes and the host hears `cut`.
  While the window is open, the end of a reading (played out, or the playback lost) waits for the verdict: noise, or
  the mute that closes the window, ends it then, once, and the cut drops it. A host may stop the reading itself
  (`RealtimeConversation.stopReading`, the Inbox card's Edit and Send): the same cut at once, with no noise window;
  without a reading in progress it does nothing. The end of the conversation during a
  reading delivers nothing. A reading is no OpenAI conversation item: nothing
  is fixed or deleted for it, and it never counts as an answer played out whole. Its characters and its audio count
  in the Soniox total of the end line; a reading whose synthesis did not end when the conversation ends marks that
  audio `~`, as an answer item does.
  The conversation keeps a position on the input audio axis, the axis of `audio_start_ms`: the milliseconds of
  microphone audio it appended to OpenAI's input buffer since the Realtime session started (audio before the
  readiness gate and while muted is not appended, so it does not count). A reading that starts drops the mark. Only
  the reading started last in the run places it, once it played out whole: an older reading that plays out whole
  while a newer one runs places none, and a last one that is not read, is cut or still runs leaves none. The mark lies
  by capture time. Microphone audio captured before the playback ended can still be on its way from the audio engine
  when the app learns of the end, so the input handler carries the capture time of each tap buffer on the engine's
  host clock (the tap's `AVAudioTime` host time, `nil` when not valid); at the end of the whole reading the
  conversation notes the time on the same clock and the mark is pending. The first appended buffer captured at or
  after that time places it at the input position after that buffer, rounded up to a whole millisecond, so it lies
  after every sample captured before the playback ended; a buffer without a capture time, and muted input, never
  place it. Each kept utterance while a mark stands, pending or placed, is compared with it: the utterance began
  after the reading when the mark is placed and the `audio_start_ms` of its counted `speech_started` is greater than
  the mark. A pending mark, an event without the time, a start that names another item, a `committed` without its
  own `speech_started`, or no mark: not after. The moment of each tool call after that
  (`RealtimeToolTurn.utteranceAfterReading`) says whether a kept utterance since the mark began after it. A new
  conversation starts at position zero with no mark. This compares the app's count with the time OpenAI's VAD gives;
  it is not a guarantee about OpenAI's clock. OpenAI's reference says `audio_start_ms` includes the 300 ms prefix
  padding, so speech that starts within the padding after the reading's end counts as not after. `client.log` gets
  `reading whole, mark pending` (`reading whole, no mark` for an older reading) or `reading not-read <code>`
  (`no-audio`, `stream-limit`, `failed`, `stalled`, `no-first-audio`, `lost-playback`, `no-speech`, `cut`) per reading,
  `reading mark <ms> ms` when the mark is placed, and `utterance start <ms> ms vs mark <ms> ms: after` (`none` for
  the start, `pending` for the mark, `not-after` for the verdict) per kept utterance while a mark stands.
  The conversation tells its host about the answers (`RealtimeConversation+Answer.swift`, `VoiceAgentHost.answer`):
  `playedWhole` once per reply that spoke, called no tool and played out whole (every item's synthesis ended and the
  queue drained after it, and the reply's `response.done` came), and `cut` at every barge-in and every lost playback.
  A reply that calls a tool is a preamble and never counts; an item cut by an error that ends one stream or one with
  no audio keeps its reply from counting; a tool's reading never counts; noise over the answer is no cut. The session
  screen's host ignores both events.
  `client.log` gets `tts start` and `tts end` per item, `tts cancel` per cancelled item, `tts first pcm` (from the
  end of the user's speech to the first Soniox PCM, apart from the time to the first audio), `tts error <code>`
  (an error on a stream adds `(last text <s> s ago, text_end sent)` or `…, no text_end)`: the seconds since the last
  text frame of that stream went out, `none` when none did, and whether its `text_end` went out;
  `SonioxSpeech.StreamText`, because Soniox ends a stream that gets no text for a few seconds without `text_end` with
  408 `request_timeout`), a line per response with the characters that went out to Soniox (not text that waited
  in the queue and was cancelled or cut off by the end), the audio Soniox generated (played or not) and its
  estimated price (`RealtimePricing.speechCost`), and the Soniox total at the end of the end line, its audio marked
  `~` when a stream was cut. Never the text or the key.
  `VoiceChatAudio` (iOS): one `AVAudioEngine`, `.playAndRecord` with `.voiceChat`, the speaker, voice processing on
  input and output, 24 kHz in and out (from a multi-channel voice processing input, as on a Mac, channel 0 only: a
  downmix of its discrete channels gives silence), each microphone chunk with the capture time of its tap buffer
  (`RealtimeHostClock`), the mixer connected to the speaker at the input sample rate when the two differ (on a Mac
  voice processing fails to start otherwise), the playback volume on the player node (kept across a restart); a
  start that returns after `stop()` or a newer start backs out (`RealtimeConversationTests`, `RealtimePlaybackTests`,
  `RealtimeNoiseTests`, `RealtimeProjectionTests`, `VoiceAgentSessionTests`, `VoiceAgentDraftTests`; store
  side `VoiceAgentSessionStoreTests`; on a real session screen `VoiceAgentRowTests` and `VoiceAgentFieldTests`).
- **Microphone and dictation.** During a voice agent conversation the composer microphone and the dictation shortcut
  mute the conversation instead of dictating (above); dictation is described in `native/Rarog/docs/rarog-ui.md`.
- **Diagnostics budget.** `RarogStore.trace(_:budget:)` gives the voice agent conversation lines their own budget of
  240 per hour (`TraceBudget`), and the end line of a conversation always passes
  (`native/Rarog/docs/rarog-core.md`, the diagnostics paragraph).

### Conversation across sessions

The voice conversation across sessions runs on the same conversation core with its own host,
`VoiceAgentSessionsHost`, and its own owner above navigation, `VoiceAgentSessionsConversation`
(`Session/Voice/Realtime/`). It has a consent of its own (Settings above). The root view (`RarogRootView`) builds
the owner once with `live(store:)`, puts it in the environment and passes it the scene phase; the session list
button starts it, and a lit circle in the header on screen (the list header, the session header or the Inbox's
header) shows and ends it (below). Its tools are `list_sessions`,
`read_sessions`, `discuss_session`, `ask_session`, `check_open_requests`, `show_prompt` and `send_prompt`. It changes
two things on the server: the pick-up of a discussed session's result and a prompt the user confirmed (below).
Tests: `VoiceAgentSessionsConversationTests`, `VoiceAgentSessionsHostTests`, `VoiceAgentSessionsHostPromptTests`,
`VoiceAgentSessionsCheckTests`, `VoiceAgentDiscussionTests`.

- **When it is offered.** `AppState.companionSessionsOffered(sonioxAllowed:)`: the voice agent is offered
  (`AppState.voiceAgentOffered`, the rule behind `VoiceAgentAvailability`) and `/api/version` says
  `companionSessions: true`.
- **The owner.** One conversation across sessions at a time for the app. The owner does not depend on the viewed
  session, so a change of the viewed session (list, session, list) keeps the conversation. A view reads `entry`,
  `isActive`, `indicator` (Connecting while the opening list is read, then the conversation's states, after the end
  its end sentence until `dismissNotice()`) and `prompt` (the prompt that waits for the user's word: the project, the
  session name and the exact text; cleared when it is sent or dropped and when the conversation ends), and calls
  `start()`, `end()`, `dismissNotice()` and `scene(_:)` with the scene phase.
  `VoiceAgentSessionsConversation.live(store:)` builds it over the store, the device's voice agent settings, the
  build's Soniox flag and the app's microphone. The owner going away (a new root for another server) ends its
  conversation and tells the host.
- **The list button.** A waveform glyph in the session list bar, before New Session and Settings
  (`VoiceAgentSessionsListButton`, the quiet header glyph with a 44 pt target), labelled "Talk About All Sessions".
  `VoiceAgentSessionsListAction` reads the owner: no button where the entry is `hidden`; at `consent` a tap opens the
  consent sheet; at `start` a tap calls `start()`; while a conversation runs or its opening list is read, the lit
  circle stands in its place (the list header, below) and a tap calls `end()`, also where the mode stopped being
  offered and the conversation has not ended yet. The consent sheet (`VoiceAgentSessionsConsentSheet`, a form through
  `SheetHost`, `AppSheet.voiceAgentSessionsConsent`) follows `VoiceAgentSessionsConsentFlow`: with the voice agent
  turned off it shows the voice agent's consent page first ("Agree and Turn On" turns the voice agent on, as in
  Settings), then the mode's; with the voice agent on, only the mode's. A mode's consent kept while the voice agent
  was off is not asked again. "Agree and Start" stores the mode's consent, closes the sheet and starts the
  conversation once; Cancel, the close button, Esc and the dismiss gesture close it with no start and store nothing
  more. Tests: `VoiceAgentSessionsConsentFlowTests`, and the button and the flow over the owner in
  `VoiceAgentSessionsConversationTests`. The list header ("AGENTS (N)") keeps room for the glyph or the lit circle
  while either stands (`SessionListMetrics.headerMinWidth`, `voiceButton`).
- **Where the state stands.** Three headers, decided by the root's slot with one rule
  (`VoiceAgentSessionsPlacement` in `VoiceAgentSessionsBarPlacement.swift`), so a running conversation shows its lit
  circle once, and an end sentence and a waiting prompt's card stay reachable once:
  - where the session list's header is on screen, the list header carries the conversation (below); on iPad with
    both columns the session header shows no circle;
  - where it is not, the header of the screen on top of the detail column carries the lit circle: the session
    header (below) on every route of `DetailView` (a session, a terminal, a project, the Inbox on iPad, a session
    opened from an Inbox card; on iPhone and a narrow iPad window over the list, on iPad while the list column is
    hidden), or the Inbox's own header at the root of the iPhone's stack (`InboxStackRoot`, below). Above the screen
    stand only a waiting prompt's card and the end sentence's line, so the screen does not move while the
    conversation only runs. The list column can be hidden only with a detail route standing. Sheets do not count:
    the screen under them keeps its place.

  The slot hands the conversation and its place to the views below as `voiceAgentSessionsFeed`. Tests:
  `VoiceAgentSessionsBarPlacementTests` (the header of every layout and route, and that on each of them, with the
  headers that stand on screen there, a running conversation shows one lit circle, an end one end sentence and a
  waiting prompt one card).
- **The session header.** Where the session header carries the conversation, the lit circle
  (`VoiceAgentSessionsHeaderCircle` over `VoiceAgentSessionsLitCircle`) stands first in the header's icon group
  (`HeaderSessionSlot`), with the list's look, tap (`VoiceAgentSessionsListAction`, which ends the conversation),
  VoiceOver and pointer tip. The group holds at most three icons (`HeaderTrailingIcons`): with four the system hides
  the whole group in the bar's overflow, which does not show it. So on a terminal screen without a tab bar (Pop-Up
  Terminal, "⋯", "×") Pop-Up Terminal gives way while the conversation runs, and Cmd+F still opens the window; the
  rule holds on iPad too. The title's ceiling already counts three icons, so a long title does not push the group
  with the circle into the overflow. The icons beside the circle keep their places when it comes and goes. While a
  prompt waits, its card stands above the screen alone, with the caption of the list header's strip ("Send the
  prompt? · <project> · <name>"); after an end with a sentence, the end sentence's line of the list header's strip
  (below) stands above the screen until a tap.
- **The Inbox's header.** The Inbox at the root of the iPhone's stack (`InboxStackRoot`) has a header of its own,
  the title "Inbox" with its count. While the conversation runs, the same lit circle (`VoiceAgentSessionsHeaderCircle`,
  added by `InboxHeaderVoiceSlot`) stands after the title as the header's only trailing item, with the same tap,
  VoiceOver and pointer tip. The title's ceiling on the phone's bar (`HeaderMetrics.phoneTitleMaxWidth`) keeps room
  for it. The circle also stands in that header while a session opened from a card covers the Inbox (a stack shows
  the top screen's bar alone), so it does not appear late when Back uncovers the Inbox. A waiting prompt's card and
  the end sentence's line stand above the Inbox as above a session screen.
- **The list header.** `VoiceAgentSessionsListHeader` decides what the list header shows
  (`VoiceAgentSessionsHeader.swift`, `VoiceAgentSessionsListButton`). "AGENTS (N)" stands in every state. While a
  conversation runs or its opening list is read, the waveform glyph's place holds the lit circle
  (`VoiceAgentSessionsLitCircle`): a 32 pt circle filled with the state's tone (`VoiceStatusView.color`, connecting
  until a state comes), centred in the glyph's 44 pt target, with five bars inside in the background colour, as the
  message field's agent button and End on an Inbox card show a conversation. The bars follow the owner's `levels`
  (the microphone while listening, the playing answer while answering) with the heights of `VoiceAgentBars` scaled to
  the circle, and stand still for a state without motion and with reduced motion; only the bars' view reads the
  levels, so their updates redraw nothing else. A tap on the circle ends the conversation
  (`VoiceAgentSessionsListAction`). VoiceOver reads it as one button, "End voice conversation", with the state's
  sentence as its value. New Session and Settings keep their places, and the list does not move. The circle and its
  bars are colours clipped to a shape, not filled shapes: the list column's navigation bar on iPad draws a filled
  SwiftUI shape white whatever its colour (iOS 27). While a prompt waits for the user's word, its card
  (`VoiceAgentPromptCard`, on a block) stands in a strip under the header, above the banners and the list
  filter (`VoiceAgentSessionsListStrip`); only then the list moves down. Its caption opens with the question in the
  run tone, then, muted, the prompt's project and session name ("Send the prompt? · <project> · <name>"), and the
  muted part truncates first. After an end with a sentence, the glyph comes back and the whole sentence stands in a
  line of that strip (`VoiceAgentSessionsNoticeLine`), at least 44 pt high, with the dot in the state's tone; a tap
  removes it (`dismissNotice()`). VoiceOver reads the line as "Voice conversation about all sessions" with the
  sentence as its value, with a hint and an action that remove it.
- **Above the screen.** Where the list header is not on screen, the root stacks above the split view
  (`VoiceAgentSessionsBar.swift`: `VoiceAgentSessionsBarHost` over the owner, `VoiceAgentSessionsBarSlot`) what the
  place puts there (`VoiceAgentSessionsPlacement.above`): nothing while the conversation only runs, the waiting
  prompt's card while one waits (`VoiceAgentSessionsBar`, the card on a block), and after an end with a sentence the
  same line as in the list header's strip, on the screen's background up to the top edge. The split view starts under
  them, so they cover no navigation bar or control, and the screen under them keeps its identity when they come and
  go. `VoiceAgentSessionsBarContent` decides what there is: nothing without a conversation and without an end
  sentence; the state (`UICopy.voiceAgentStatus`, the source of the conversation at a session; Connecting while no
  state has come) while a conversation runs or its opening list is read; after an end, its sentence, removed by a
  tap. The prompt card (`VoiceAgentPromptCard`) shows the exact text the send sends, unchanged and without markdown,
  on the strip's background; up to six lines show and the rest scrolls inside. A text past the six lines fades out
  at the bottom edge, and its scroll indicator flashes when the card appears and when its text changes;
  scrolled to the end, the fade lies over an empty margin, so the last line reads in full. The card has no buttons,
  because the confirmation is spoken. VoiceOver reads it as one element, "Prompt to send:
  project <project>, session <name>", with the whole text as its value. A sentence left by a logout
  stays in the owner and shows after the next login, until a tap. No view names the discussed session. Tests:
  `VoiceAgentSessionsBarContentTests`, the content over the owner in `VoiceAgentSessionsConversationTests`, and the
  list header, its strip, the session header's and the Inbox header's circle, the prompt card and the end sentence's
  line over the real split view in `VoiceAgentSessionsBarTests` (`RarogUIKitTests`).
- **Entry.** `VoiceAgentSessionsEntry`: `hidden` where the mode is not offered, `consent` where the voice agent is
  turned off or the mode's consent to its current text is missing (`VoiceAgentSettings.sessionsAllowed`), otherwise
  `start`; `start()` returns `notOffered` or `consentNeeded` in the first two cases and builds nothing. The
  conversation at a session does not read the mode's consent: without it the session button and ⌥⌘V work as
  described above.
- **Start.** Each start builds a new host. The host reads the catalog (`prepare()`, `RarogStore.loadCompanionSessions`)
  and puts the opening list into the instructions in a `<sessions>` block; only then does the owner build the
  `VoiceAgentSession` and start it, so no key is asked before the list. A start while a
  conversation runs or its opening list is read builds nothing (`running`). In the background or without the server
  connection no start begins: nothing is read, and the owner shows the end sentence of that reason. A refused
  `prepare()` builds no conversation and asks for no key, and the owner shows an existing end sentence: not logged in
  (also a catalog read the store answers as logged out or cancelled) as logged out, the mode not offered or
  `companion-sessions-disabled` as turned off, a failed catalog read as unavailable. A second start after an end has a
  new host: handles from `s1`, no reads, questions counted from 1. An end reason that the owner sees while the opening
  list is read stops the start with its sentence, also when the reason is gone before the list arrives.
- **One microphone.** A start takes the app's one microphone (`DictationCenter`,
  `Session/Voice/DictationCenter.swift`) before it reads the opening list, also a start that is then refused: a
  running conversation at a session ends, and so does dictation in the message field or in a project note. A
  conversation at a session or dictation that starts while the opening list is read keeps the microphone, and the
  start is given up with no sentence; one that starts while this conversation runs ends it
  (`VoiceAgentSession.handOff`), with no end sentence.
- **The list.** One row per catalog session the app has in its session list: a catalog row the app lacks and a
  session outside the catalog give none, so such a session reaches the model in no form, not even as a count. A row
  has a handle, the project, the name (the label, with `#n` for an identical project and name counted among the rows
  only, so a namesake outside the catalog changes no number; `unnamed` without a label: the list's fallback is a
  piece of the session id), the state from the selectors of the list dot (`finished`, `marked-unread`, `seen`,
  `seen-by-voice`, `working`, `working-background`, `dialog`, `failed`, `other`), minutes since `stateSince`,
  `asks_owner` from the catalog, and at a dialog its kind (`permission`, `plan`, `question`) and first line. Names,
  the project and the dialog line pass `RealtimeSecretMask`, and a `<sessions`, `<transcript` or `<session-update`
  tag written into them loses its `<`. `list_sessions` answers `{"sessions":[…]}`.
- **Handles.** `s1`, `s2`… in the order sessions first appear in this conversation, never reused; a new session gets
  the next one. The server's session id never goes to the model, to OpenAI or to `client.log`. A handle that is not on
  the current list is a refusal, and nothing is read.
- **The catalog before every tool.** Each tool call reads the catalog again (`RarogStore.loadCompanionSessions`) and
  works on that list.
- **Requests only while the mode holds.** Before every request (catalog, turns, question, prompt) and before its
  answer goes to the model, a tool checks the end rules: after a logout, another login, the mode not offered, an end
  reason its owner gives (`VoiceAgentSessionsHost.ownerReason`) or a read session's new conversation, and without an
  opening list, it refuses and sends nothing.
- **After the end.** The owner tells the host every end of its conversation, whatever ended it
  (`VoiceAgentSessionsHost.conversationEnded()`): from the conversation's indicator once the conversation stops, at
  the end action while the opening list is read, at a refused opening list and when the owner goes away. From then
  on every tool refuses and sends nothing, a tool already in flight sends no further request and keeps no read (a
  catalog answer that arrives after the end gives no handle), and the handles, the reads, the opening list and a
  waiting prompt are dropped; a prompt send already in flight is not cancelled (below). A host serves one
  conversation.
- **`read_sessions`.** Takes `handles`, or a `filter`: `finished` (rows in that state) or `asks_owner`, at most three
  sessions, newest `stateSince` first; `turns` (1–3, 3 by default) is the turns route's `count`
  (`RarogStore.loadCompanionTurns`). Per session the result has a header (handle, project, name, state, minutes), a
  note when the answer has no turns or starts inside a turn, and the turns in the form of the session projection. Each
  line passes the mask before the budget counts it; one call has 15,000 characters, split evenly between its sessions,
  and within a share the oldest turns give way to a note that names them, as in the session projection. A refused
  turns read (404 as an unknown handle, `companion-sessions-disabled`, a failure) refuses the whole call and keeps
  nothing. Each read leaves a record (`VoiceAgentSessionRead`): the answer's `conversation` and `readMark` as the
  server sent them, and whether the answer had messages; a newer read of a session replaces it.
- **The discussed session and the pick-up.** `discuss_session` with a handle, and a `read_sessions` call with
  exactly one handle that read one session, make that session the discussed one; every other successful read clears
  it (several handles, a filter, also a filter that picked one session). The instructions tell the model to call
  `discuss_session` when it moves on to talk about one session, before it talks about it. `discuss_session` reads the
  catalog like every tool; an unknown handle is refused with "Unknown handle. Use handles from the session list.", a
  session not read in this conversation with "Read this session first; then call discuss_session again.", and either
  changes nothing; success answers "The app shows this session as the one under discussion.". When the answer that
  follows the pointing plays out whole (`playedWhole`, see "Conversation" above), the host picks up the session's
  result: `RarogStore.pickUpCompanionResult` with the `conversation` and `readMark` of its newest read in this
  conversation, as the server sent them (`POST /api/sessions/:id/seen` with `by: voice-agent`). A read or a
  `discuss_session` that a cut overtook (speech between its start and its return) changes nothing: the conversation
  drops its result, so it leaves no read record, makes no session the discussed one and keeps a pointing made after
  the cut. That first whole answer uses the pointing, and so does a cut: the next whole answer picks up nothing
  until the session is pointed at again; the session stays the discussed one. No pick-up for a read without
  messages, after the end of the conversation or while an end rule holds, and none twice for one read: a newer read
  of the session allows a new one. The outcome changes nothing in
  the app, says nothing to the model and does not end the conversation; when the server accepts, its session frame
  brings `seenBy`, and the list gives that session the state `seen-by-voice`. The rule: `VoiceAgentDiscussion`
  (`VoiceAgentDiscussion.swift`); the host's part: `VoiceAgentSessionsHost+Discussion.swift`.
- **`ask_session`.** A handle from the list and a question, through the question route as on the session screen, with
  the same sentences for its outcomes; at most 30 questions per conversation, the 31st is refused.
- **`check_open_requests`.** The thorough check whether sessions the user has looked at still wait for the user; the
  instructions allow it only on the user's request. The first call only announces: it reads the catalog, picks the
  rows in the state `seen` (not `seen-by-voice`), newest `stateSince` first, at most 10, and answers "The check
  would ask <N> sessions the user has looked at, one by one, about 20 seconds each. Ask the user whether to start.".
  No such row is a tool error and announces nothing; at the ceiling of 30 questions the call is refused with the
  sentence of `ask_session`. The next call is the user's word only when the user heard the announcement and spoke
  after it: an answer played out whole since the announcement (`playedWhole`, see "Conversation" above), the call
  comes in another reply of the model, and the user has at least one kept utterance since the announcement (the
  call's moment from the conversation, `RealtimeToolTurn`). Any other call is refused with a tool error that tells
  the model the user has not agreed and to ask and wait. Either way the announcement is used up, so the next call
  announces again. Speech before that whole answer drops the announcement, so the utterance that cut does not count
  as the user's word: the conversation dropped the result before the model got it, or the user spoke over the
  answer with it. The same holds for a cut during the call. The announcement also ends when the reply to the
  user's answer plays out whole without the check, so a call that comes after it announces and reads the list
  again. A call while a run is in flight is refused. The rule: `VoiceAgentCheck`
  (`VoiceAgentSessionsHost+Check.swift`).
  - **The run.** It reads the catalog, skips an announced session that left it or the state `seen`, and asks the
    rest through the question route (`RarogStore.askCompanion`) one at a time, the next only after the answer to
    the one before, with a fixed question: whether anything in the session still waits for the user (a question,
    a decision or an approval never answered), in at most two sentences, or exactly "Nothing waits for the user.".
    Each question counts toward the ceiling of 30, which the run shares with `ask_session` and checks before every
    question, so a run asks at most what the ceiling leaves, and with none left it is refused with the ceiling
    sentence. The result is plain text: per session a header with the handle,
    project and name, then the answer's text through the secret mask with block tags neutralized, as in
    `read_sessions`; a note on skipped sessions and a note with the cause of a stop close it.
  - **Stops.** A refusal of the route ends the run with the answers it has and the cause: the subscription limit,
    the timeout and a failure with the sentences of `ask_session`, `companion-busy` with a sentence of its own, the
    mode off and a lost session too; the ceiling reached during the run gives the ceiling sentence. When the run
    has no answer, the cause alone is the tool error. The end rules count before each question and after each answer.
  - **Speech and the end.** The run is a task of the host's own. A cut (`answer(.cut)`) and the end of the
    conversation cancel it: the question in flight is cancelled with its request (the store awaits the transport
    inline, so the cancelled task cancels the URL task), and no further question goes out. A run that returns
    answers clears the discussed session, like a read of several sessions, and leaves no read records.
- **`show_prompt` and `send_prompt`.** The app reads the exact prompt aloud and sends it to the named session only
  after the user confirmed in an utterance that began after the reading ended (`VoiceAgentSessionsHost+Prompt.swift`,
  `VoiceAgentSessionsHost+PromptSend.swift`; every sentence for the model in `VoiceAgentSessionsHost+PromptText.swift`).
  A sent prompt runs at once and cannot be taken back, so every doubt ends in a refusal with nothing sent, and a
  prompt never goes out twice.
  - **`show_prompt(handle, text)`.** The text is the argument trimmed. A send in flight refuses the call and keeps its
    prompt. Any other call first, before its first `await`, drops the waiting prompt (the instructions tell the model
    that a new `show_prompt` replaces it) and a waiting announcement of `check_open_requests`, and stamps its
    response. It is then refused, with nothing shown or read and nothing waiting, for an empty text, a text over 1,000
    characters, an end rule and a handle not on the list, and after the catalog read for a session with the same
    project and name as another row (also rows the list numbers with `#n`) and for a session that waits on a dialog.
    Otherwise it captures from the session's row the server's session id, the catalog's `conversation` token, the
    project and the name, keeps the exact text and makes a new `clientMessageId`: the send uses only these values,
    never a token read after the show. The prompt goes to the owner (`prompt`), the session becomes the discussed
    one, and the conversation has Soniox read "Project <project>, session <name>: <text>"
    (`UICopy.voiceAgentSessionsPromptReading`, `RealtimeToolResult.read`), so what is read, shown and sent is one
    string. Played out whole, the prompt is marked
    read and the model hears "The app showed the project, the session and the exact prompt and read them aloud to the
    user. Ask only whether to send it."; not read (no audio, the stream limit, an error on its stream, a lost
    playback), it stays unread and the model is told to call `show_prompt` again. A cut drops the call, so the prompt
    stays unread, and the end of a reading whose prompt a newer `show_prompt` dropped changes nothing.
  - **`send_prompt`.** The checks, in order: a send in flight is joined and its result returned (one request); no
    prompt gives "No prompt waits. Call show_prompt first." (or the kept outcome, below); a call in the response of
    its `show_prompt`, also while that call reads the catalog, gives "The user has not confirmed yet. Ask whether to
    send it and wait for the answer."; a prompt not read whole (its reading cut, not read or still running) tells the
    model to call `show_prompt` again; without a kept utterance that began after the reading's mark
    (`RealtimeToolTurn.utteranceAfterReading`, "Conversation" above) the model hears "not confirmed"; a repeat after
    an outcome that does not say whether the prompt arrived needs a kept utterance since that attempt. Then the
    catalog is read again and the end rules are checked. A refusal there, a session that left the list, another
    `conversation` token in the catalog than the captured one, a dialog on the session, or a session that did not work
    at the show and works at the send drops the prompt with a sentence that names the cause, and nothing is sent.
    Last comes `RarogStore.sendCompanionPrompt` with the captured session id, text, token and `clientMessageId` (the
    server's side: "Sending from the conversation").
  - **Outcomes.** `sent` gives "Sent." and `queued` a sentence that the prompt waits in the queue; both drop the
    prompt. `conversationChanged` is a refusal, and the conversation ends as `session-cleared`, like a read session's
    new conversation. `refused` drops the prompt and passes on the server's or the store's sentence. `loggedOut` drops
    it and asks the core to check the end rules, which end the conversation. `timedOut`, `failed` and `cancelled` do
    not say whether the prompt arrived: the prompt stays with the same `clientMessageId`, so a confirmed repeat is the
    same message for the store and the server, and the sentence says the prompt may have arrived and must not be
    prepared again unless the user asks.
  - **A cut and the end.** Speech since the `send_prompt` call stops the send until the host hands the prompt to
    the app's outbox: a cut during the catalog read sends nothing (`send refused (cut)`), and the prompt stays read
    and waits for a clear word. A sound over a playing answer since the user's last kept utterance stops the send
    too, whatever the app makes of it (`send refused (sound)`): a short no counts as noise in the window of
    `RealtimeConversation+Noise.swift` and never reaches the model, so the host hears each window open with the
    count of kept utterances and refuses a send confirmed by the utterance a sound followed, at the call and again
    before the hand-off. The model is told to ask again, and a repeat needs a new kept utterance. A prompt the
    outbox took is never cancelled by the host: the store answers
    `cancelled` for a cancelled caller before it looks at the echo, so a cut leaves it to the outbox. The end of the
    conversation drops a waiting prompt, unsent, and leaves a send in flight to the outbox too.
  - **One consent at a time.** `show_prompt` drops a waiting announcement of `check_open_requests`, and an
    announcement drops a waiting prompt. While a send is in flight `check_open_requests` is refused and announces
    nothing (`check ended (sending)`): that send may end without saying whether the prompt arrived and keep its prompt.
  - **The kept outcome.** The conversation drops tool results on a cut, so the host keeps the last send's outcome
    with its session, token, text and id until an answer plays out whole with no cut since the call that returned it.
    Until then `send_prompt` with no prompt waiting reports that outcome instead of "No prompt waits"; a
    `show_prompt` of the same session, token and text reuses the old `clientMessageId` when the prompt went out or may
    have, and its result says so; a `show_prompt` of other content notes how the last send ended. A result with such a
    note counts as the outcome returned again, and so does the result of a `send_prompt` that joined the send and
    got its outcome; a joined send refused before the outbox took it leaves an older outcome as it was. Of several
    calls that returned the outcome, the one that started last counts.
- **Refusals.** A refused or failed read and a tool refused by the end rules give the model a fixed sentence, never
  the server's message; the one exception is the server's sentence of a refused prompt.
- **End.** Each end shows an existing end sentence; a reason that a conversation at a session also has shows the
  same sentence there. The end action (`end()`) shows none; during the opening read it ends the start: no
  conversation is built, nothing of the list stays, and the host's catalog answer, when it arrives, logs
  `start refused (ended)`. The app in the background (`scene(_:)`) ends it with the background sentence (always the
  start, the opening read and a conversation not yet ready; a ready one as "Locked phone" says), a logout as
  logged out, another login as a changed server; the mode not offered, the mode's consent removed and the voice
  agent turned off end it as turned off.
  The lost server connection (`AppState.global` offline) ends it with "The conversation ended: the connection to the
  server dropped." and the end line `ended closed (connection-lost)` in `client.log`. An audio interruption and a
  Soniox failure end it with their sentences, and a conversation at a session or dictation that takes the
  microphone with none. When a session read
  in this conversation shows a new `conversation` token in a catalog or a turns answer, it ends as `session-cleared`,
  with the sentence of a session that started a new conversation. A turns answer is compared when it arrives, before
  the next session of the same read is asked. A new token of a session not read changes nothing. The owner's reasons
  (the background, a missing consent, the lost connection) reach the host as `ownerReason`, so they end through
  the core's end check with their reason. While a conversation runs or its opening list is read, each change of the
  store's state or of the two consents checks the end rules, so a removed consent or a logout ends it without a
  call from a view. A reason that comes while the opening list is read keeps the conversation from starting, with
  its sentence.
- **`client.log`.** `voice-agent:` lines with counts only, on the voice agent trace budget: `start with <n>
  sessions`, `list <n> sessions`, `read <n> sessions, <m> reads in this conversation`, `question <n> of 30`, a refusal
  with its code (`read refused (unknown-handle)`; an end rule gives `logged-out`, `server-changed`, `disabled`,
  `not-started`, `conversation-changed`, the owner's reason as `background` or `connection-lost`, a removed consent
  as `disabled`, or `ended` after the end; `discuss refused (not-read)` for a session not read), `discuss` per
  accepted `discuss_session`, `check announced (<n>)`, `check <k> of <n>` per question of a run (`<n>`: the
  sessions it asks after the skips and the ceiling) and `check ended (<code>)` (`done`, `limit`, `busy`, `timeout`,
  `failed`, `off`, `unreachable`, `cut`, `ceiling`, `not-agreed`, `none`, `running` or an end rule's code as
  above), a line when a read session changed its conversation, and per pick-up
  `pick-up accepted` or `pick-up refused (<code>)` with `result-changed`, `off`, `unknown-session`, `logged-out`,
  `cancelled`, `timeout` or `failed` (also a refusal of the app's mutation gate). The prompt pair writes
  `prompt shown`, `prompt read whole`, `prompt not read`, `prompt refused (<code>)` (`sending`, `empty`, `too-long`,
  `unknown-handle`, `ambiguous`, `dialog`, `newer`, `cut`, or a code of the catalog read or of an end rule as
  above), `prompt dropped (check)`, `check ended (prompt)` when a `show_prompt` drops an announcement,
  `send refused (<code>)` (`same-response`, `not-read`, `not-confirmed`, `no-new-utterance`, `no-prompt`, `dropped`,
  `left`, `token-changed`, `dialog`, `working`, `cut`, `sound`, or a code of the catalog read or of an end rule),
  `send joined`,
  `send reported (<code>)` and `send ended (<code>)` with `sent`, `queued`, `conversation-changed`, `refused`,
  `logged-out`, `timeout`, `failed` or `cancelled`. The core adds its own lines
  and the end line with the cause of a close (`ended closed (background)`). The owner writes no line of its own.
  Never a name, a handle's session, a path or text.

### Conversation from an Inbox card

A result card and a decision card of a session with a transcript carry the voice agent button in their bottom row (in
the reply row of a result, in a row of its own under a decision); a failed card and a card of a session without a
transcript (an agent in the Rarog terminal) have none (`InboxRules.takesVoice`). The button stands under the same
conditions as on the session screen (the feature on, consent, a key route). The conversation is the session screen's
conversation for the card's session: the same content, `ask_session` and status sentences (`VoiceAgentInboxHost`
wraps `VoiceAgentSessionHost`), with the card's own prompt pair and prompt rules in place of the message field's
(below). One card talks at a time: a tap on another card ends the running conversation and starts the new one, and
the other buttons are dimmed meanwhile. While the card talks, its bottom row is the voice strip: the level bars, the
state sentence, Mute and End (the card's view: the Inbox screen in `native/Rarog/docs/rarog-ui.md`).

- **Start.** The tap sets the navigation's voice target, so the root view opens the card's transcript stream while
  the Inbox stays on screen (`RarogNavigation.transcriptSessionId`). The stream opens without a cursor
  (`RarogStore.refreshTranscript`), and the conversation starts only after that fresh `transcript-snapshot`; a
  transcript the app already holds is not enough. No snapshot within 10 seconds ends the start as unavailable,
  and a card that shows another turn meanwhile refuses it as a changed card.
- **Prompt block.** `show_prompt` puts the prompt in the card's own prompt block, kept by the conversation's owner
  (`InboxPromptBlock`), and the card's reply field stays as the person left it. The app reads the block's text
  aloud exactly as written (a Soniox reading, as in the conversation across sessions), and the read-along gives the
  heard prefix of the text while it plays (`RealtimeConversation+ReadAlong.swift`); the model does not read the
  prompt itself. A prompt longer than 1000 characters (one Soniox stream) is refused. A new `show_prompt` replaces
  the block while it reads or waits and starts its reading again; while the person edits it or a send is in flight,
  `show_prompt` is refused. The block keeps the card's turn of the moment of `show_prompt`, and every send of it
  answers that turn.
- **Voice send.** `send_prompt` sends the block only when its reading played out whole, the person spoke after that
  reading in a new utterance, the login of the start holds, and no send of this version went before. A reading cut
  by the person's speech or not played out (no audio, the stream limit, a lost playback) leaves the block unsent by
  voice; a new `show_prompt` reads it again. The send is the card's plain reply (`RarogStore.replyFromInbox`: an
  ordinary send of the person, held to the turn the block keeps, without `expectedConversation` or `source`), so it
  needs only `RAROG_COMPANION` with speech, not `RAROG_COMPANION_SESSIONS`, and the card stays in place.
- **Edit and Send in the block.** Edit turns the block into its own text field with the agent's text, in place;
  Cancel goes back to the agent's text. An edited text goes only with the block's Send, never by voice. Edit or
  Send during the reading stops its audio at once, as speech over it would: the version counts as not heard whole
  and `show_prompt` gives the model no result. The block's Send works in every phase but sending, and a blank
  edited text sends nothing. The block stands on the card above the voice strip and lights the heard part of the text
  while the app reads it (the heard prefix of the read-along); the conversation's owner holds it and its actions
  (`edit()`, `editText(_:)`, `cancelEdit()`, `sendBlock()`).
- **Outcome of a send.** Accepted or queued drops the block and shows "Sent to the session"; a refused text stands
  again in the block with its reason, and its outbox entry is deleted; an entry kept in the transcript with Retry
  drops the block. A card that changed before the send, and a text the outbox could not store, drop the block and
  hand its text back. The outcome of an older send never changes a newer block.
- **Hand-back.** The block's text (the person's edit, or else the agent's text) goes back at the end of the
  conversation, and after a send outcome above that drops the block with its text: on top of the card's reply field
  with the reason under it while the Inbox is on screen and the card has its field, answering the turn the card
  shows then (the field writes the session's draft at once), otherwise into the session's draft. Never both. A send
  in flight at the end keeps its text to its own recovery, the reply field's rule after ↑. The model hears these
  rules in the card's own prompt instructions and tool descriptions (`RealtimePromptField.inboxReply`,
  `RealtimeInstructions+InboxHost.swift`); the session screen's edit rule does not apply.
- **Decision card.** It has no reply field: the conversation answers by voice, `show_prompt` refuses and
  `send_prompt` refuses for lack of a prompt.
- **End.** Besides the session screen's rules (logout, the feature off, background with its "Locked phone"
  exception, `/clear` or `/resume` in the
  card's session), the conversation ends when its card leaves the Inbox, when the Inbox closes and when another
  session opens (`VoiceAgentInboxWatch`). An end sentence of a card no longer on screen shows as a notice.
- **Owner.** `VoiceAgentInboxConversation` holds the one conversation of the Inbox screen, its target and the prompt
  block (`VoiceAgentInboxConversation+Prompt.swift`); the reply fields (`InboxReplyHost`) take the block's text back
  and the outcome of a send whose block is gone.

### Locked phone

- **Rule.** `BackgroundRecording` (`RarogCore/VoiceAgent/BackgroundRecording.swift`) is the one definition, with no
  setting: `keeps(running:)` keeps a voice conversation or a message-field dictation that runs (its microphone
  already records) when the app leaves the foreground, by a lock or a switch to another app alike. On a phone it
  keeps it while the recording's voice Live Activity tile stands. Without the tile (refused because Live Activities
  are off, a limit or an error; ended; removed by the person) the background ends the recording, and a tile that
  goes while the app is in the background ends it then. On a device that shows no tiles (an iPad, the app on a Mac:
  the interface idiom and `isiOSAppOnMac`, read once at launch, `AppEnvironment.voiceAgent`) the tile does not
  count: the recording goes on in the background until the screen locks, and the lock ends it then. The lock is
  `UIApplication.protectedDataWillBecomeUnavailableNotification`, which comes only with a passcode set, so such a
  device without a passcode records to the recording's own limit; the app back in the foreground (scene `active`)
  forgets the lock. An iPhone with Live Activities off follows the phone's rule, as at a refused tile. The voice
  activity controller sets the tile (below), the app sets the lock and the scene. Tests: `BackgroundRecordingTests`.
- **Conversation in the background.** The background does not end a voice conversation that is ready (past its
  readiness gate: the audio engine runs and OpenAI took the session, `VoiceAgentSession.isReady`), at a session, at
  an Inbox card or across sessions, while the rule keeps it; every other end rule holds, the 20-minute limit too. The
  background still refuses a start and ends what has no open microphone yet: a conversation that connects, the
  opening read across sessions, a card that waits for its snapshot. The session screen and the Inbox pass
  `BackgroundRecording.keeps(running:)` to `VoiceAgentWatch` as `keepsInBackground`, whose start check refuses the
  background whatever it says, and the owner across sessions applies it in its own reasons. A change of the rule's
  inputs while the app is in the background (the tile gone, the lock) ends a kept conversation with the background
  sentence: the Inbox and the owner across sessions watch the rule in their own checks, and the session screen
  checks its end rules again at each render, which reads the rule while a conversation runs. Tests:
  `BackgroundRecordingTests`, `VoiceAgentWatchTests` and the background cases of `VoiceAgentSessionTests`,
  `VoiceAgentInboxTests` and `VoiceAgentSessionsConversationTests`.
- **Dictation in the background.** The background does not end a message-field recording whose microphone opened
  (`VoiceRecorder.microphoneOpened`) while `BackgroundRecording.keeps(running:)` keeps it: its text keeps landing in
  the same field, which is the session's draft. A change of the rule while the app stays in the background (the tile
  gone, the lock) ends it then, with the end line `background`. A recording still preparing (permission, key,
  microphone opening) ends at the background, and so does a note's recording. A recording that already finishes
  (its second tap, Send, an end from the Lock Screen, silence, the limit) keeps its own end and its own end line
  when the app goes to the background or its tile goes. Its own limits still end a kept recording: a minute of
  silence and the session limit (10 minutes in the message field). A kept recording that finishes in the background
  (those limits, `DictationCenter.endFromLockScreen()`, a field that locks) holds a background task without the
  server (`ComposerDictation.holdFinalization`) from its first finalizing view, which comes before the microphone
  closes, until its last words are in the field and the disk confirmed the draft: the open microphone keeps the app
  running, and once it stops nothing else does. A background entered while a recording finishes takes the same task,
  and so does an end in the background that has no finalizing view (a stream that failed for good), for the draft
  write alone. Every end of a message-field recording hands the field to the session's draft
  (the screen's `persistDraftNow`); a held background task ends once the disk ran that write
  (`ComposerDrafts.written`). An end that a waiting Send takes writes no draft: the send emptied the field, and
  the background task waits until that send has its answer (the message is stored in the queue, or its text is back
  in the field and written to the draft). A field released with its screen mid-recording writes nothing. Each
  message-field recording writes one `client.log` line when it ends,
  `dictation: ended <reason>`, with one word and never the text: `stopped` (second tap), `send`, `field-locked`,
  `background`, `hand-off` (screen left, microphone taken, or the field gone with its screen mid-recording), or for
  a recording that ended by itself `silence`, `session-limit`, `interrupted`, `stream-failed`, `microphone`,
  `dictation-failed`, `refused` (`DictationEndTrace`), `live-activity` for an end through
  `DictationCenter.endFromLockScreen()` (the entry for an end button outside the app's screens, which no screen of
  the app calls), `live-activity-send` for an end through `DictationCenter.sendFromLockScreen()` (below), and
  `ended` when none of these applies.
  Tests: `DictationRouteTests` (the background cases) and `DictationEndTraceTests`.
- **Send from outside the screens.** `DictationCenter.sendFromLockScreen()`, which the app target reaches through
  `AppMicrophone.sendFromLockScreen()`, is the entry for a Send button outside the app's screens; no screen of the
  app calls it. It asks the host that holds the microphone. Only a message-field dictation whose microphone opened
  answers (`ComposerDictation.sendFromLockScreen()`); a conversation, a note's recording and nothing recording give
  `nil`, change nothing and write no line. The press ends the recording as Send during it does: the last words land
  in the field, then the field goes through the session screen's one send (`sendField(byVoice: true, login:)`) with
  the login and the interface of the press, registered as the field's last send, which the end of the recording
  waits for (`dictationEndWait`). A pairing or a server that changed since the press sends nothing and takes
  nothing from the field. A field with attachments in its bar does not go this way: the text and the attachments
  stay in the field. Neither does a field whose whole text is an app command (`/model`, `/usage`, `AppCommand`): the
  command does not run, no sheet opens, and the field stays as it is. One press is one operation: a second call
  while it runs, also after the recording ended and while the request travels, gets the same task. The task gives
  `LockScreenSend` once the field's draft is on disk: `sent` or `queued` (the server took the message; `queued` when
  the server reports it as queued), `unconfirmed` (a timeout, or a send stopped in its progress ring: the entry waits in
  the send queue for "Retry"), and `notSent` for every other result (a refusal, a closed or read-only field, an app
  command, attachments, a field gone with its screen), with the text where the send recovery puts it. Besides the
  end line it writes `dictation: live activity send sent|queued|not-sent|unconfirmed`, never the text. Tests:
  `LockScreenSendTests` and `DictationCenterTests`.
- **Monitor.** `LockedPhoneMonitor` (`Session/Voice/LockedPhoneMonitor.swift`, no UIKit; the app's instance from
  `LockedPhoneMonitor+Live.swift`) reads what records from the app's one microphone (`DictationCenter.use`: the kind,
  conversation or dictation, and what of it lives, as the host reports it) and gets each scene phase from the app's
  scene phase change. It starts no microphone, conversation or dictation. One rule, `evaluate()`, runs at
  every change the microphone center reports (a claim, a start, an end, a host's deinit), at every change of the
  background rule's inputs, at every scene change and at every heartbeat: it holds the server connection while
  `BackgroundRecording.keeps(running:)` says yes for what records, in the foreground too, and releases it when the
  answer turns no: the recording ended or its host went away, its tile went, or the screen locked on a device
  without tiles. Only a changed answer reaches the tunnel. On a phone without the tile it never holds.
- **Heartbeat.** Every 30 s while the app is in the background and the hold stands, the monitor asks the server
  once, `GET /api/version` through the current login's transport (`RarogStore.serverAnswers()`, which changes no
  state and asks nothing while signed out), and writes a line when the answer comes, if the app is still in the same
  background stay and the hold still stands. While a question is out, the next heartbeat writes `server=waiting`
  and asks nothing more. Tests: `LockedPhoneMonitorTests`, `StoreLockedPhoneTests`.
- **`client.log` lines.** On the voice agent budget, never any content; the prefix is `voice-agent` for a
  conversation and `dictation` for a dictation. A scene change while something records writes
  `<prefix>: background` or `<prefix>: foreground`; the `inactive` step of a lock or an unlock writes nothing. Where
  the rule does not keep what records, the screens end it at the same scene change, and nothing orders the monitor
  against them, so the background line may be missing. The heartbeat:
  `<prefix>: background <s> s: audio=running|stopped openai=open|closed soniox=open|closed server=online|offline|waiting`;
  `<s>` counts the seconds since the app left the foreground, at the moment of the line, on the clock of the system's
  awake time (`ProcessInfo.systemUptime`, which Apple's page describes as the time the system has been awake since
  its last restart); `audio` is a microphone frame within the last 2 s (`MicrophoneUse.frameWindow`); `openai` is
  the conversation's Realtime socket (a dictation has none); `soniox` is the conversation's speech socket or the
  dictation's stream on the Soniox route while it streams. `server=online` says the server answered that one
  request, which in the background may itself open a new generation; the tunnel's own lines say whether the
  generation stayed. Nothing records: no line.
- **Voice Live Activity.** While something records, the app shows a second Live Activity beside the sessions
  board: `VoiceActivityController` (`native/Rarog/Rarog/VoiceActivityController.swift`) reads the app's microphone
  through `AppMicrophone` (RarogUI), and the views and the button intents stand in `RarogActivity`. The Lock Screen
  tile has three lines and its buttons: the kind ("Voice agent" or "Dictation") with a system timer, a phase word and
  a subject line; End for a conversation, Stop and Send (two round icons) for a dictation. The microphone center
  reports the phase (`MicrophonePhase`): a conversation is "Working", "Listening", "Answering", "Reading the session",
  "Send the prompt?" while a prompt waits for a spoken yes or no, or "Muted"; a dictation is "Dictating". It also
  reports the subject (`MicrophoneSubject`): "All sessions" for a conversation across sessions that discusses no
  single session, else the session's project and name joined by a dot, "One session" when the app cannot name it,
  and "Say yes or no" first while a prompt waits. Names go through the voice agent's secret mask and are cut to 80
  characters; no prompt, dictated text or question reaches the state. One activity at most: requested once per
  recording, without a push type and with a relevance score, which the board's content does not carry (Apple's
  documentation: the score orders an app's Live Activities), updated when the kind, the phase or the subject changes
  and never for an equal state; a new phase or subject keeps the timer, another kind starts it anew. It ends at once
  (`.immediate`) when nothing records; at launch every voice activity the system still shows ends (one a stopped
  process left). The controller tells `BackgroundRecording` whether the tile of what records stands: from a granted
  request until the controller ends it, or until ActivityKit reports the activity's state `ended` or `dismissed`
  (Apple's documentation: a person, the app or the system ended it, or a person or the system removed it); a
  refused request gives no tile, and a recording whose tile went gets no new one. A refused request writes one line,
  `voice-agent: live activity not started (<reason>)`, with the `voice-agent` prefix for both kinds and the reason
  `disabled` (Live Activities off for the app), `background` (the app not in the foreground), `limit` or `failed`,
  and the next request waits until nothing records; a request the limit refused while the end of the activity
  before it is on its way is tried once more after that end. Each button runs its intent in the app's process with
  the id of the activity it stands on (`context.activityID`); a press on another activity than the current one
  changes no recording and writes no line (End takes only that old activity off). End and Stop run
  `EndVoiceActivityIntent`; its handler, which the app installs at launch, calls `DictationCenter.endFromLockScreen()`,
  so a conversation ends as with its end button and a dictation keeps its text in the field without sending. It
  writes `voice-agent: ended from live activity` or `dictation: ended from live activity` (nothing when nothing
  records) and ends every voice activity that stood when it was pressed, so a recording started meanwhile keeps its
  own; a dictation that still finishes its text gets no new activity. While a send from the tile runs, Stop does
  nothing.
- **Send from the tile.** Send runs `SendDictationActivityIntent`; its handler
  (`VoiceActivityController.sendFromLiveActivity`) calls `AppMicrophone.sendFromLockScreen()` (above) and returns once
  the send runs. From the press until the outcome is on the tile, the controller holds a background work that needs
  the server (`RarogStore.beginBackgroundWork(_:needsServer:expired:)`); the recording's own finalization keeps its
  `holdFinalization` task. The tile then says "Sending…" in the waiting tone, with a stale date 30 s after the press,
  where its timer stops: past it the system shows the tile as "Not confirmed", also when the app's process no longer
  runs. The recording's last reports and its end leave that tile alone; a second Send gets the same send. `sent` and
  `queued` end the tile at once, and so does any outcome while the app is in the foreground. Otherwise `notSent` and
  `unconfirmed` end it as "Not sent" or "Not confirmed" with "Check the app" under it, in the error tone and with the
  timer stopped at the outcome, and leave it on the Lock Screen for 5 minutes (`.after`); the app coming to the
  foreground and a new recording, before it asks for its own tile, take it off. A background work the system expires
  before the outcome, also inside the call that starts it, ends the tile as "Not confirmed" and writes
  `dictation: live activity send expired`; an outcome that still comes as `sent` or `queued` takes it off. A refused
  background work writes `dictation: live activity send no background time`, and the send runs anyway. A new
  recording takes the microphone and gets its own tile; the send goes on, and its outcome no longer changes a
  tile. Unlocking: observed on an iPhone, the system asks for the
  unlock before it runs a Live Activity button on the Lock Screen (`docs/security-model.md`, "Push notifications").
  Tests: `VoiceActivityControllerTests`, `VoiceActivityViewTests`, `VoiceActivityAttributesTests`,
  `VoiceActivityPresentationTests`.
- **Server connection hold.** `TunnelCoordinator.holdForVoice(_:)` (`TunnelCoordinator+VoiceHold.swift`), asked for
  by `LockedPhoneMonitor`, is one background work that needs the server, under a reserved identifier and without a
  system task, so only its release ends it. While it lives, the tunnel keeps its generation as it does for any
  background work, and in the background a request may open a new generation. In the foreground it changes nothing.
  Released in the background within the 8 s grace of that stay, the generation goes back to that grace; released
  after the grace deadline, or after the system expired the tunnel's grace task, it closes at once. Tests: the voice
  hold cases of `TunnelCoordinatorTests`.
- **Background mode.** The app declares `UIBackgroundModes: audio` (`native/Rarog/Info.plist`). Apple's
  documentation says that with this background mode an app's audio continues
  when people switch to another app or lock the device (AVFoundation, "Configuring your app for media playback"),
  and that the `record` and `playAndRecord` audio session categories can record in the background (Human Interface
  Guidelines, "Playing audio"). Dictation records in `record` (`MicrophoneCapture`), the conversation in
  `playAndRecord` with the `voiceChat` mode (`VoiceChatAudio`), and the app activates its audio session only for a
  conversation or a dictation the user started. Whether the sockets, the timers and the server connection live on a
  locked phone is what the monitor's lines measure.

### UI tests

- `RAROG_UI_TEST_VOICE_AGENT=1`: a scripted voice agent conversation (`ScriptedVoiceAgent`): the key, the Realtime
  socket and the audio play a fixed script in which the user speaks and the answer calls `show_prompt`; the voice
  agent button stands although the demo server offers no voice agent and the switch in Settings is off. With
  `RAROG_UI_TEST_VOICE_AGENT=hearing` the user never stops speaking, so the conversation stays in "Hearing you" (a
  still screen for screenshots). The other launch variables: `native/Rarog/docs/app-target.md`.
- `VoiceAgentScreenshotUITests`: the status rows "Hearing you" and "Prompt in the field" of a scripted voice agent
  conversation; skipped without `RAROG_SCREENSHOT_DIR` (`native/Rarog/docs/tests.md`).

### Source directories

- `native/Rarog/Packages/RarogCore/Sources/RarogCore/VoiceAgent/` — voice agent settings: consent, voice choice,
  and the rule that keeps a running recording in the background (`BackgroundRecording`).
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/Voice/Realtime/` — voice agent: session projection, secret
  mask, OpenAI Realtime client, the voice chat audio engine, the tools wired to the store, the end-of-conversation
  rules, the composer button with its bars and the states of the status row.
- `native/Rarog/Packages/RarogUI/Sources/RarogUI/Views/VoiceAgent/` — voice agent settings page and consent.
