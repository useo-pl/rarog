# RarogCore: how state flows

Part of the app description: [native/Rarog/README.md](../README.md).

- **Reducer:** `AppState.apply(_:now:timing:)` is the ONLY place that changes state: a pure function
  `(state, event)`; the caller passes the time, and side effects (the outbox on disk) come back as a list of
  `CoreEffect`. Tests replay recorded sequences of golden frames from `shared/fixtures/sse/` on it.
- **`RarogStore`** (`@MainActor @Observable`) runs everything that involves time: the stream loops
  (`StreamSupervisor`, decoding off the main actor, backoff 0.5 → 8 s, `retry:` raises the lower bound; a stream
  is `online` from its first body byte; the stall guard `StreamStallGuard` ends a stream that got no byte for
  1.5 × the `hello.heartbeatMs` of the last global `hello`, 60 s without a valid one, like a drop; each `hello`
  sets the shared `StallThreshold` and logout resets it), the persistent outbox (`RarogStore+Send`,
  `OutboxPersistence`), the Not confirmed countdown, presence, and the `kontrakt:` report in `client.log`.
- **Outbox (format v2, v3):** a manifest `<id>.json` and the attachment content files in `<id>/` (an image already as
  JPEG, a file byte for byte). Creating: content first, then the manifest; deleting: the manifest first. A crash in
  between leaves at most a directory without a manifest, which the next start cleans up. A v1 manifest (text only) is
  read; a newer format is skipped. An entry whose content file is gone comes back as a refusal without Retry. Writes
  go through one chain (`persistInOrder`), so a delete after the echo cannot overtake the creation. A prompt of the
  voice agent across sessions keeps its sender pair (`OutboxEntry.sender`: `source` and the `conversation` token
  it read) and is written as v3, so an app that does not know the pair skips it; every other entry stays v2. Every
  attempt of such an entry, a person's Retry included, puts the pair on the wire as `source` and
  `expectedConversation`.
- **Sending:** the entry id is the `clientMessageId`, the same on every Retry, which sends the same bytes
  (`MessageBodyWriter` streams the body to a temporary file off the main actor). Limit for the WHOLE send: 10 s for
  text, 200 s with an attachment. A 202 with `replayed: true` settles the entry as accepted; a foreign
  `clientMessageId` in the reply means Not confirmed; a 409 `client-id-conflict` and the 409 of a changed engine
  conversation (sentence code `session.conversation-changed`, only for a voice agent's prompt) are refusals without
  Retry. Upload progress (`sendProgress`) lives only on a `queued` entry. An accepted entry becomes Not confirmed
  when no echo arrives within 15 s of the 202 for text and 120 s with an attachment
  (`CoreTiming.unconfirmedAfter(for:)`, the same rule in `deliver`, after an app restart, at a session stream's
  opening and when the wait for it ends): on iroh the 202 of an upload comes back through its own connection, while
  the echo rides the main connection's stream, which a large upload can hold back. An echo or a transcript snapshot
  with the entry's `clientMessageId` still clears a Not confirmed entry. An accepted entry waits for its session's
  stream (`AppState.waitsForOpenStream`), whoever sent it (the session screen it left, an Inbox card, the voice
  agent), only while the session is on a fresh list (`sessions-snapshot`), can open a transcript stream
  (`SessionSummary.showsTranscript`, so not a Rarog terminal) and that stream is not open. Without a fresh list (none
  yet, or one from the cache) nobody knows whether the session is still there, so its entries wait too. Every check
  (the countdown after the 202, and the idle period and the cap below) is decided when it comes: a waiting entry stays
  accepted, because no echo can reach the app, and opening the session reconciles it with the transcript snapshot; an
  entry that does not wait turns Not confirmed. The countdown starts at the 202 (`deliver`) and again from an app
  restart (`restoreOutbox`; an entry in the CLI queue gets the cap's check from `queuedAt` there). When the wait ends
  without the stream coming online (the session left a fresh list, moved into a Rarog terminal, or the first fresh
  list came without it), the entry gets the countdown again from that moment (`AppState.countdownsAfterTheWait`, run
  by `apply` around every event), also when its check already came while it waited; an entry in the CLI queue turns
  Not confirmed at that check only past its cap. So a session off the list for a moment and back before the countdown
  ends keeps its entries waiting. When the session's stream comes online, the countdown after the 202 starts from then
  (`CoreEffect.scheduleUnconfirmedCheck`) and supersedes the one the entry had (`AppState.unconfirmedOpenings`): a check
  scheduled before changes nothing, and a new 202 brings back the countdown of `deliver`. For an entry in the CLI
  queue the idle period opens as for a typed entry, and the cap's check runs for what is left of the cap since
  `queuedAt` (`CoreEffect.scheduleQueuedCeilingCheck`), also when its check came while the stream was closed and after
  an app restart.
- **Stop (`cancelSend`):** the stop in the progress ring ends the send in flight. Each delivery attempt runs in a task
  of its own, registered under the entry id (`sendFlights`); the registration is the attempt token, so a late result
  or progress report of a stopped attempt never touches the entry, also after an immediate Retry. The stop ends the
  Send or Retry call at once with its own outcome and cancels the attempt's task, which winds down on its own (an
  upload connection can take seconds to close), so a Retry right after the stop is not held back. Before the request
  (the stage is `.encoding`: composing the body, where `MessageBodyWriter` checks for cancellation before each chunk,
  or the transport still waiting for its connection) the entry becomes the refusal `cancelled`, which is not final:
  nothing went out, the temporary body is removed, the content files stay for Retry. Once the transport reports a byte
  sent (read on its own thread, not from the progress on the main actor), the entry becomes Not confirmed, because the
  body may have arrived. Both take the echo of their id, as this or another attempt of the same entry may have
  arrived; a `cancelled` entry takes no echo without an id (by signature), because an echo of another entry with the
  same content would clear it and its content files. The text never goes back to the field. An entry without a send
  in flight is left alone.
- **CLI queue entry (queued echo):** a text-only body carries `queueAware: true`. A 202 with `queued: true` makes the
  entry `sent` with `queuedAt` (the first acceptance) and `isQueued`, WITHOUT the 15 s threshold; the echo arrives
  when Claude Code picks the prompt up. Not confirmed comes only after 15 s of CONTINUOUS session idleness without
  the echo (`queuedIdleSince`, `syncQueuedIdle` after every event; a turn, work or a pending decision closes the
  period) or after the 30 min cap from `queuedAt`. A `replayed` without `queued` for an entry sent with
  `queueAware` (the flag is saved BEFORE the request) does NOT settle it: after a server restart `queued` does not
  come back, so the entry waits for the echo by signature or for Not confirmed. After an app restart an entry with
  `queuedAt` gets only the cap, at its session stream's opening. `queuedAt` is optional in format v2. Constants:
  `CoreTiming.queuedIdleAfter`, `queuedUnconfirmedAfter`.
- **Pairing and device key (`Pairing.swift`, `RarogStore+Pairing`, `RarogStore+Forget`, `Reducer+Pairing`):** the
  only way to a server; the app has no token login.
  - **Endpoint:** `RarogStore.live(connector:…)` picks the endpoint (`ServerEndpoint`) from the Keychain: a key gives
    its server (`device`), no key gives `none` (the pairing screen alone). A `locked` Keychain (before the first
    unlock) makes the start wait (`auth == .unknown`) and retry on `protectedDataBecameAvailable()`. The start takes
    effect once per store: a second `start()` (the scene root runs its `.task` again whenever a full-screen cover over
    it closes or `interfaceEpoch` changes) returns at once, and every login after it goes through `enterLoggedIn`.
    A space the store enters after the start (pairing, unpairing) reads its outbox itself (`restoreEnteredSpace` in
    `RarogStore+Spaces`). A pairing logs in as the start does (`switchEndpoint`): the outbox read first, then the list
    cache, then `.loggedIn` and the streams, so no echo and no send from a session on screen comes before the read.
  - **Pairing:** every path (`offerPairing`, `openLink(.pair)`) ends in the "Pair with <host>?" card
    (`AppState.pairing.flow = .confirming(link)`; a bad link gives `.rejected`). A link with `k` also shows the
    server key fingerprint, the first 16 characters of the EndpointId in groups of 4
    (`ServerIrohConfig.fingerprint`); it only informs. `confirmPairing()` sends `POST /api/pair` along the link's
    target (no credentials, outside the compatibility gate), saves the key in the Keychain (a refusal gives
    `.failed(.keychain)`) and switches over. Over iroh (`.iroh`, `.both`) the relay registry client prepares first;
    when the relay may not admit the server yet (a fresh registration or sponsorship, a preparation that did not
    finish, or a sponsorship less than 60 s before the preparation ended) the card is `.waitingForRelay`, with Cancel,
    from the first pairing request on (`RarogStore+RelayAccess`; `docs/implementation-spec.md`, "iroh relay
    registry").
  - **One server per app:** a link to another server than the paired one gives `PairingState.replacedServer`. The one
    rule is `PairingLink.leadsToAnotherServer`: a link with `k` compares the full EndpointId with the paired iroh key
    (a paired server without one cannot be compared, so it counts as another server), and a link without `k`
    compares origins (`ServerOrigin`). The card then warns that pairing swaps the paired server, names it, and puts
    Cancel first as the default action, with Replace second. `confirmPairing()` sends nothing for such a link
    (`.ignored`); Replace is `confirmPairing(replacing: true)`. Both buttons pass the link the card showed (`shown`),
    and a confirmation of another link than the one in the sheet is dropped, so a link offered between the tap and
    the request does not get the tap's consent. A device without a key (first pairing, revoked) has nothing to
    compare the link with, so its card has no warning.
  - **Switching servers** does NOT rebuild the store: `retire(.switchingServer, unregisterPush: false)` closes
    everything of the previous credential (streams, presence, requests with their login number, terminals, the push
    registration, the Live Activity), the new transport logs in, and the interface is rebuilt from scratch
    (`RarogStore.interfaceEpoch`), because views held objects of the old transport. The previous key is revoked in the
    background (`forgetDevice`) through a one-off transport (`ServerConnector.forgetTransport`).
  - **Server spaces:** app data lives in the server's SPACE (`ServerSpaces`, `RarogStore+Spaces`; layout in "Data on
    the device" under "The app"), named by a persistent pointer, `servers/.current.json`, written atomically and
    BEFORE any `rename`. The pointer holds the directory name and the server identity, `identity`
    (`ServerIdentity`: the normalized `ServerOrigin`, such as `https://host:443`, for a key with an address, or
    `iroh:<EndpointId>` for a key without one); a pointer by address also keeps `origin`, so an older build reads it.
    A key with another identity means a NEW space: the in-memory state is cleared (`.dataWiped`), server-dependent
    preferences are deleted (`NavigationPreferences.serverScoped`, guarded by the marker
    `rarog.server.preferences-space`), and the previous space goes to the trash only after the new pointer is
    written. The same identity stays in the same space, so after pairing the list from memory shows at once; Replace
    is the exception (below). Without a key the pointer stays, so the data waits for pairing with that server. After
    Replace the new key never opens the space of the pairing it swaps, also under the same origin: when its identity
    matches the pointer's, a fresh space goes on the pointer BEFORE the key goes to the Keychain
    (`emptySpaceForReplacement`). A Keychain refusal writes the previous pointer back (`restorePointer`), so the paired
    key keeps its space and data; when the disk refuses that write, or the process is killed before the Keychain
    write, the fresh pointer stays and the paired key opens the empty space at the next start, with the previous data
    in the trash. A disk that refuses the fresh pointer fails the pairing ("Pairing failed. Try again.") before the
    Keychain. The swapped space goes to the trash at the next choice of space. Pairing an iroh-only device again over
    iroh to the same EndpointId, with the same `serverId`, keeps the space under the new key's identity: the pointer
    first gets `successor` (the new identity), then the Keychain gets the key, then the pointer gets the new
    `identity`. A key matching `identity` or `successor` opens the same space; a match on `successor` finishes the
    move, a match on `identity` drops `successor` (the key was not saved). A disk that refuses the pointer with
    `successor` gives a pairing in a new space; one that refuses the last pointer keeps the session in the same
    space, and the next selection finishes the move. The same check runs against the current key before each
    pairing. A Keychain refusal after `successor` was written restores the pointer exactly as it was before. While
    the pointer still has `successor` (the disk refused to settle it), only a pairing with proof of the server key
    and a new key matching `identity` or `successor` goes ahead; any other fails with "Pairing failed. Try again."
    and leaves the pointer and the Keychain as they were. Pairing without a device key first drops `successor` when
    the Keychain has no key at all; a locked or unreadable Keychain keeps it, and the pairing fails the same way.
    Pairing also waits for the pointer: when the start could not read it, pairing reads it once more before the
    request, and a pointer the disk still does not return fails the pairing the same way, with no request to the
    server. An older build skips `successor`.
  - **Correctness does not depend on deleting:** a directory the pointer does not name is garbage nobody reads. A
    late write of an old instance lands in the previous space and never comes back into the state
    (`serverRuntime.spaceChanges`); neither does an outbox read of the previous space (the store's `persistence` is
    swapped at each entry). The state is cleared when the OWNER of in-memory data changes (`serverRuntime.holder`), so
    a session without a space does not carry state from server A to B either. With a `locked` Keychain the space comes
    only after the unlock (`spacesReady`). The outbox of a session without a space lives in this process's directory
    in the trash (`ServerSpaces.scratch`).
  - **Forget Server** first invalidates the data on disk (`dropSpace`), and a disk that refuses aborts Forget before
    the request and the key (`forgetServer()` returns `false`, `PairingState.forgetFailed`). Then
    `POST /api/devices/forget` with the limit of one tunnel attempt (`serverRuntime.forgetLimit`,
    `TunnelMachine.attemptBudget`, 15 s), so an iroh tunnel still connecting after a return from the background gets
    through; without an answer within it the server keeps the device, and Forget goes on locally. Then the Keychain item
    of this `deviceId` goes, `forgetPush` unregisters, the Live Activity ends, the server's
    `rarog.devices.known.<serverId>` and `rarog.devices.notices.<serverId>` go, and the data goes. A `device-revoked`
    during the operation (`serverRuntime.forgettingDevice`) is its own result, so no revoked screen. Forget and
    pairing exclude each other in the core: the reply of one would delete the key of the other.
  - **A 401 for the key** (`handleUnauthorized` reads `transport.credentialRejection`): `device-revoked` for THIS
    device gives `.loggedOut(.deviceRevoked)`, deletes the key and records the revocation (`rarog.server.revoked`,
    until the next pairing); any other 401 gives `.loggedOut(.deviceUnknown)`, keeps the key, and `retryDeviceKey()`
    logs in with a fresh transport. The login number drops a late 401 of an old key.
  - **Server machine:** `AppState.serverSystem` is the server's `system` from the version probe (a probe without the
    field keeps the previous value; login and logout do not clear it). After a probe that changes it, the app writes it
    into the device credential in the Keychain (`DeviceCredential.serverSystem`), so a cold start and a start without
    network begin with the last known system; binding another credential takes that credential's value. A 401
    `device-revoked` copies it into the revocation record (`DeviceRevocation.serverSystem`). `AppState.serverMachine`
    turns it into the word through the one rule `ServerMachine` (`RarogContract`): `macos` and no known system give
    `.mac`, `linux`, `other` and a value this app does not know give `.vps`. A record from before the field, a `null`,
    a wrong type or a value of a newer app never makes the credential or the revocation unreadable
    (`storedServerSystem`). Tests: `ServerMachineTests`, `DeviceCredentialStoredTests`, `StorePairingTests`,
    `ReducerUsageTests`.
  - **Codes and devices:** `issuePairingCode()` gives a link with this server's routes (`u` from the address,
    `k` and `r` from the key's iroh pair) and the server's expiry. `clearPairingCode()` (Hide, leaving the Pairing page
    of Settings or closing Settings) clears the code on screen at once and sends one `DELETE /api/pairings`, which revokes the code on the
    server; an error, a 405 from a server without the route and no connection are ignored, and the code then expires
    by itself. Issue and cancel run one after another: a cancel sent while the code is issuing goes out after the POST
    answer, and a new code waits for a cancel still on its way, so the late cancel does not revoke it. The
    device list is read after each `hello` and on demand (`refreshDevices`, the `device-paired` push); a device outside
    the remembered ones (`rarog.devices.known.<serverId>`) gives a `NewDeviceNotice`. A tap on a `device-paired` or
    `version-changed` push calls `openSettingsScreen(_:)` with the push's `SettingsScreen` (`.pairing`, `.server`);
    the interface opens that Settings page and calls `consumeSettingsScreenRequest()`. Tests: `PairingLinkTests`,
    `StorePairingTests`, `PairingLinkWireTests`.
- **UI inputs:** store methods, one area per file (`RarogStore+<Area>`): `Send`, `Catalog`, `Session`, `Answers`,
  `Decisions`, `SessionControl`, `NewSession`, `Uploads`, `Voice`, `Companion`, `CompanionSend`, `Pairing`. Results are
  typed (`SendOutcome`,
  `DecisionOutcome`, `DiffFetchOutcome`…); RarogUI composes the sentences. Two inputs write to `client.log` through
  the `kontrakt:` buffer and login gate, never with conversation content: `reportUnhandled(_:)` (an unhandled error,
  level `error`, with the report's dedup and cap of 50) and `trace(_:budget:)` (level `debug`, with its OWN budget of
  20 lines per hour, because traces carry times and the dedup does not catch them; `Model/DiagnosticsTrace` composes
  them). The caller names the budget (`TraceBudget`); voice agent lines have their own budget (`docs/companion.md`,
  "Conversation"), and so do connectivity lines, 60 per hour: the tunnel's lines and one `connection:` line when a
  stream comes online after a gap of at least 1 s or with a visible card, giving the gap, how it started (start or
  return, dropped in use, a quick failed attempt, after a failed attempt) and which card stood (`Model/DiagnosticsTrace+Connection.swift`,
  sent from `Views/RarogRootView.swift`).
  `sessionDiff(_:)` for the whole diff exists in the store, but the app does not call it.
- **Session controls (`SessionControls`, `RarogStore+Session`):** model, mode and restart send a request and change
  NOTHING in the session summary; the new state arrives through the list stream. A model change is sent as a
  DIFFERENCE and is blocked during a turn, a start, a pending decision and a dead channel (`modelChangeBlock`). A mode
  switch records an in-flight entry with the target and an 8 s deadline BEFORE the request. A restart has one
  in-flight entry per session and a 20 s limit, through the "↑" pill (`restartCli`) or Restart and Send under the
  blocked-prompt notice (`restartAndResend` with the card's whole `promptBlocked`). From the tap a restart also counts
  as in progress (`pendingRestarts`, `restartInProgress`) until the list shows its end (`settleRestarts` after each
  frame): a `restart.*` sentence other than exiting or launching ends it at once (the sentence already on the card at
  the tap only once the restart showed progress), and so does a refused request (a lost reply only before the list
  showed progress); a card live again after the relaunch (`resumable`/`starting` seen, or a new `paneId` when the app
  missed those frames) ends it without `cliUpdate`, or with it after 5 s (the update did not apply);
  a 90 s limit ends the rest. Meanwhile the header shows a spinner instead of the pill (`StatusPills.cli`).
- **Per-file diff (`RarogStore+Session`):** `sessionDiffFiles` and `sessionDiffFile` return a `DiffFetchOutcome` whose
  refusal carries the server's status and code (`DiffRefusal`), so the diff window tells apart a 405
  (`serverOutdated`), a 404 `diff-file-not-found` (`fileGone`), a 400 `bad-path` and a 503 `git-failed` (retry).
- **Session slash commands (`Commands.swift`, `RarogStore+Commands`):** `AppState.commands` holds the
  `GET /api/sessions/<id>/commands` list of the session on screen; `loadCommandsIfNeeded(_:)` runs at the first "/" in
  the field. A read goes out with no list, 60 s after the last reply (`CommandListTiming.refresh`) or after the
  server refused a command (a 400 on a text matching `SlashCommandText.isCommand`), at most one per session. A 400,
  404 or 405 gives an empty list without a message. Tests: `StoreCommandsTests`.
- **Interrupt and the result (`TurnControl`, `RarogStore+SessionControl`):** Stop and Esc are one action,
  `interrupt(_:)`, available during work or with an outbox entry in flight (`interruptAvailability`; Not confirmed is
  excluded, and an entry in the CLI queue qualifies only while the session is in a turn). Stop is a mode of the Send
  button (`ComposerPrimaryAction.resolve`: an interruptible turn and an empty field, outside 700 ms after a send). The
  gesture gate holds until the request settles, at most 4 s; limit 10 s and one retry after a network error. Verdict:
  `delivered` (missing means success), a 4xx is a Rarog refusal, a 5xx means the pane did not take it, the network
  means "unknown". `delivered(returnedPrompt:)` carries the prompt Claude Code handed back to its field
  (`InterruptResponse.returnedPrompt`, an empty one is none); the app never fills the field from its own
  memory. `AppState.promptText` is one definition of a prompt for the prompt bar. Every request of the area goes through
  `tracked`, so the login number drops late results.
- **Queue take-back (`QueueTakeBack`, `RarogStore+QueueTakeBack`, `Reducer+QueueTakeBack`):**
  `takeBackQueue(_:handOver:)` is `startTakeBack(_:)` (synchronous: the gate, the id and `started`, so the screen
  shows the take-back in the gesture's own turn; `nil` = an ignored gesture) followed by `finishTakeBack(_:handOver:)`,
  which calls `POST /api/sessions/<id>/queue/take-back` (limit
  `RarogClient.queueTakeBackTimeout`, 20 s) through `tracked`. A second gesture while `QueueTakeBackState.inFlight`
  holds the session sends nothing. One `operationId` per take-back: one retry after a network error, and an id
  without a definitive answer (network, 5xx, an answer outside the contract) stays in `QueueTakeBackState.operations`
  for the next gesture, because the server may have taken the prompts and answers the same id with the same body.
  Only the route's answer drops it: a 200 whose texts are durably in the draft, a 4xx refusal, a 404. A refusal from
  before the route (the app's gate sent nothing; a 403 from the origin check or the proxy; a 429 from the auth
  throttle) keeps an id that a request before it, or the timed-out first attempt, may have delivered; a fresh id
  refused that way is not kept. On a 200 the async hand-over runs first and answers whether the texts reached the
  disk (the screen's field written and confirmed, or the stored draft); only `true` lets `taken` remove the outbox
  entries of the returned `clientMessageId`s of that session, whatever their state, and frees the id; `false` keeps
  both (`notSaved`). Verdict: a 4xx is a refusal with the server's sentence, a 404 a server without the route.
  `canTakeBackQueue` (a queued bubble, or a kept id: `keepsTakeBack`) decides whether the gestures exist.
- **Inbox (`Inbox`, `InboxRules`, `RarogStore+Inbox`, `Reducer+Inbox`, `Selectors+Inbox`):** the heads, texts,
  removals with Undo and held cards of the Inbox, and the transcript read that gives a decision card its buttons. When
  a card stands and what counts sit in `InboxRules`; the rules stand in `rarog-ui.md`, in the "Inbox model" entry.
- **Send echo:** `clientMessageId` first: an echo with an id settles ONLY that entry, a foreign id settles nothing. An
  echo without an id goes by the full signature (text plus attachment names and sizes), oldest entry first, and must
  be NEWER than the boundary saved with the entry: the same server process (`serverStartId`) needs a higher `seq`,
  after a server restart a server time above the largest known message time; without a boundary, the send time minus
  60 s. So an old echo does not settle a newer entry after a cold start.
- **Question answers (`RarogStore+Answers`):** one request per card, addressed by the `qId` from the moment of the
  gesture, without queuing. `AnswerRules` drops `terminalOnly` labels (fail-closed next to the server) and requires a
  value for every question; notes are cut to 8192 units and a blank one is `nil`. The server enforces the question's
  `notes` field with a 400 sentence, because a silently lost note would be worse than a refusal. A 409 `conflict` and
  a 410 remove the card with a trace; a 409 `bad-state`, a 400 and a 422 keep it with the server's sentence.
- **Background reads (`RarogStore+Usage`):** `GET /api/usage` every 15 s ONLY with the scene `active` and at once on
  entering the foreground (a 10 s floor); a 503 deletes the numbers, a network error dims them. `GET
  /api/usage/details` is read only by the app's `/usage` sheet. `GET /api/version` after each `hello` and from the loop
  fills `AppState.capabilities`, `tailnet`, `serverSystem` (see "Server machine" under "Pairing and device key") and
  `serverVersion`, which the footer compares with `ServerRelease.version` (`docs/distribution.md`, "Server update
  indicator"). Its `iroh` pair goes into the same Keychain item through `adoptServerIroh` and applies from the next
  generation (`credentialChanged`); a failed write keeps the stored pair (rules: `docs/distribution.md`, "Pairing from
  the app").
  `GET /api/mac` (`RarogStore+Mac`) every 30 s and on a footer tap fills
  `AppState.macLoad`; the numbers live 2 min from the last SUCCESSFUL read, and a 404 means a server without the route
  until another `serverStartId`. **One schedule:** a read outside the loop wakes it, at most one read of each kind is
  in flight, a logout drops results by `isCurrentLogin(_:)`, and tests drive the loop from a `VirtualClock`.
- **Images for thumbnails (`RarogStore+Uploads`):** `GET …/uploads/<file>`, the bytes in process memory
  (`UploadImageCache`, LRU 32 MB). A 404 is remembered until the end of the login; another failure asks again at the
  next display. A logout cancels the reads and clears the memory.
- **Session files (`RarogStore+Files`):** `GET …/files?dir=`, `GET …/files/index` and `GET …/files/raw?path=` go out
  only while the version answer lists the capability `files` (`AppState.filesAvailable`), the index only with
  `file-index` too (`AppState.fileIndexAvailable`); without them the routes return `.unavailable` and send nothing.
  The fetch writes a private copy that the caller owns (`SessionFileFetch.saved`); a file over the limit is
  `.tooLarge(size:maxBytes:)`, from the server's 413 or from a `Content-Length` over the `maxBytes` the caller took
  from the session's latest listing or its file index. A logout cancels the requests in flight
  (`forgetSessionFileReads`), and a result or failure from an ended login (a logout or a new login) is `.loggedOut`,
  with its copy deleted first.
- **File tree of the panel (`FileTreeStore`, `FileTreeRules`, `RarogStore+FileTree`):** `RarogStore.fileTree`, a
  separate `@Observable` object, not a field of `AppState` (listings of up to 1000 entries would be copied by the
  reducer on every frame). It keeps the listings by directory, the latest change list (`GET …/diff/files`), the
  directories that answered 404, the file index of the search and `maxBytes` of the latest listing, else of the
  index (`maxBytes(_:)`), for the open session and the ones opened just before it, three in all
  (`FileTreeStore.retainedSessions`); the hand toggles are kept apart, so
  dropping a session's listings keeps them. A session gone from the server's list loses both. The screen calls
  `panelOpened(_:)`, `panelClosed()` and `setExpanded(_:_:in:)` and reads `snapshot(_:)`; the store itself asks for a
  refresh on the return to the foreground, on a changed `git-status` frame of the open session, on the end of its turn
  (it leaves `starting` or `running`) and when `files` appears, and `retire` drops everything. One rule opens
  directories (`FileTreeRules.isExpanded`: a hand toggle, else a change under it); a directory is listed only when its
  parent's listing shows it and it is open, so a directory known only from the changes (deleted, under a hidden
  directory) is never asked for. At most four requests at once (`FileTreeStore.maxInFlight`), the change list
  included; triggers fold into passes at least `CoreTiming.fileTreeRefreshGap` (1 s) apart, and a request found in
  flight is asked once more after its answer. A directory that becomes reachable and open in the middle of a pass (a new
  change list opens it) is listed in that pass even with a listing in memory. An answer after a switch of the panel's
  session, after `retire` or from an ended login is dropped. A 404 `not-found` of a listing drops that directory's
  listings; a 400 `codex` or `out-of-scope` turns the session to the fallback source (`FileTreeSource.fallback`), as
  do a server without `files`, a Codex entry and a session out of scope: no request, the tree comes from the
  `git-status` frame.
  The file index (`FileTreeStore+Index`, `GET …/files/index`) is read through `fileIndex(_:)` (`FileIndexState`:
  unsupported, not loaded, loading, ready, failed; the last three keep the previous index). The screen reports
  `setSearchActive(_:in:)` when the session's search field starts or stops holding a query that searches the index
  and again on appearing, also without such a query (a logout, a session gone from the list and the panel moving
  to another session forget the query), and
  `reloadFileIndex(_:)` for Retry. A start asks at once when there is no index, it failed, it was invalidated or
  it is older than `CoreTiming.fileIndexRefreshGap` (30 s). The end of the open session's turn, the return to the
  foreground, `panelOpened(_:)` and `file-index` appearing invalidate it, also with an empty field; with a query
  standing an invalidation asks again, no sooner than the gap after the previous answered request (inside the
  gap one request waits for its end). One index request at a time, outside the four of the tree; a `git-status` frame does not
  touch the index. No request without `file-index`, for the fallback source, with the panel closed or for another
  session than the panel's; a 400 `codex` or `out-of-scope` turns the session to the fallback source, any other
  failure is the failed state without a retry of its own. An answer after a switch of the panel's session, after
  `retire` or from an ended login is dropped.
- **APNs notifications (`RarogStore+Push`, `Reducer+Push`):** the system comes in through the `PushSystem` and
  `BackgroundWork` protocols (`PushSystem.swift`); the app plugs in adapters with `attachSystem(…)`, tests pass fakes.
  `BackgroundWork.begin(_:needsServer:)` says whether the work talks to the Rarog server (presence, Live Activity,
  note save, dictation key); only that work keeps a tunnel generation alive. Only the adapter `UIKitBackgroundWork`
  calls `beginBackgroundTask` (guard `server/test/native-background-work-guard.test.ts`). One such work has no
  system task: the voice hold of the app's tunnel coordinator (`TunnelCoordinator.holdForVoice(_:)`,
  `native/Rarog/Rarog/TunnelCoordinator+VoiceHold.swift`), a work under the reserved identifier `UInt64.max` that
  only its release ends. It keeps the generation as a background work does; after the release the generation
  follows the grace of that background stay (`docs/companion.md`, "Locked phone (trial)").
  - **Registration:** after a login the core asks for a token and reads the permission. `POST /api/push/apns` goes
    out after the full list state of the current connection (`AppState.listLive`, not from the cache), once per
    cycle (login, return from the background, new token, permission change); a failure retries at the next
    connection. It carries `topic` = `PushSystem.topic` (a different topic gets a 400 `topic-mismatch`) and
    `pushFormats: [3]`, so the server sends v3 pushes. The server alone turns banner content off (`RAROG_PUSH_E2E=0`,
    `docs/server-config.md`).
  - **Permission and status:** `alerts` follows the permission (`denied` → `false`, without unregistering), and
    `…/apns/status` fills `notificationsDegradedSince` (the `pushDegraded` banner); a known `degradedReason`
    (`pass-missing`, `env-mismatch`) gives a sentence with the reason. The only source is the token status of THIS
    device.
  - **401** (`forgetPush`): the token goes back to the SYSTEM (`unregisterForRemoteNotifications`, because the
    unregister route sits behind the refused key) and the badge goes to 0.
  - **Turn On** (`enablePush`): the system prompt, then a registration with `test: true`; the notice is `working` ONLY
    after the test push arrived, `testMissing` after 15 s. "×" (`snoozePushPrompt`) hides the banner for a week.
  - **Tap target and badge:** the tap target (`openPushTarget`) waits through a logout and enters after the login and
    the current list. A sessionless tap goes by kind (`PushNote`): `device-paired` opens the Settings "Pairing" page
    and `version-changed` the "Server" page, at once (`opensSettings`), `weekly-limit` opens the session list through
    `openLink(.list)` (`opensList`), which waits like a session target. The foreground badge (`syncPushBadge`) is
    `badgeCount` from the same list.
  - **Routing:** `PushRouting` and `ProvisioningProfile` (`PushRouting.swift`) are pure functions for `userInfo`,
    `rarog://session/<id>`, `rarog://terminal/<termId>?session=<id>` and `aps-environment`.
    `PushRouting.inspect(userInfo:keys:)` reads in order the `rarogOpen` added by the notification service extension,
    the `rarog` v3 block decrypted with the app's key (`PushKeyReader`, without checking `exp`), and the plain `rarog`
    v1. The result is `note`, `unreadableV3` (with a `PushRefusal` reason) or `foreign`. `pushReceived` and
    `pushTapped` write one `client.log` line with the `push:` prefix about the source, without content and session id;
    an unreadable v3 gives only the line with the reason, so "it arrived, the app could not open it" does not look like
    "it did not arrive".
  - **Keys and kinds:** a start with a key restores the shared push key from the private copy
    (`restoreSharedPushKey`). Banners come for permission, question, "waiting in the terminal", error and usage limit;
    `done` is a badge only, because the Live Activity and the in-app toast carry the result.
- **Live Activity (`RarogStore+LiveActivity`):** the system comes in through `ActivityRequesting`
  (`LiveActivitySystem.swift`: start with `pushType: .token`, `update` with a timestamp, end, `displayedContent(_:)`,
  the `token`, `ended` and `content` inputs); tests pass a fake with the ActivityKit ordering. The server sends the
  full content by push.
  - **Machine word:** the start passes `AppState.serverSystem` into the activity attributes
    (`RarogActivityAttributes.serverSystem`), and the tile takes its word from there ("Mac" or "VPS", `ServerMachine`).
    The attributes of a live activity cannot change, so when the word from the current system differs from the
    tile's (a first probe after the tile started, on a VPS), the core ends the tile on screen (with `…/end`) and
    starts a new one under the usual start conditions, only in the foreground (`active`). A change that keeps the word
    (`linux` → `other`, unknown → `macos`) leaves the tile alone. Tests: `LiveActivityLifecycleTests`.
  - **Start state:** the app builds only the START state, `AppState.liveActivityInput(now:)`, with the server's rule
    (`aggregateState`): `waiting`, `working`, `finished` and `top`; `nil` with a stale list.
  - **Counter writes:** after the start the app writes ONLY the counters, so the Live Activity does not wait for a
    push after a decision in the app. They come from the global stream's list image alone (`AppState.globalList`,
    `liveActivityWrite(now:)`), and a write goes out only when these counters change, outside the background, with a
    fresh list. A write overlays the counters on the content the system holds
    (`LiveActivityInput.overlay(displayed:local:)`).
  - **Ordering:** the write timestamp is `AppState.liveActivityAsOf`, the newest `stateSince` cut to the second minus
    1 s (server clock). The system rejects a write older than the last push, so the Live Activity never goes behind
    the server, and a push sent after the transition always wins. One writer per activity reads the system's content
    right before the write; a known newer timestamp rejects it without `update`. A push that lost to an accepted
    write during the `update` comes back in one repair write 1 ms newer. The cost: a push in the second of the
    transition can roll the counters back for a moment, until the server's next send.
  - **Busy** (`liveActivityBusy`) mirrors the server's `isBusy`: something waits or works, OR an open `workflow`
    task (see "Background tasks" below).
  - **Start and token:** the start needs the foreground, a login, the APNs channel, the permission, the current list
    and "busy". Orphans of the previous process end first, ended ones still on the Lock Screen included
    (`shownActivityIds()`: `active`, `stale`, `pending` and `ended`). The activity token goes to
    `POST /api/push/live-activity` with `registeredToken`, also in the background (`rarog.live-activity` background
    work); a 409 `apns-device-unknown` re-registers the device once per connection. The start state has
    `stale-date` = now + 15 min.
  - **End:** a 30 min quiet timer (`LiveActivityTiming.quietEnd`) counts in the foreground from the moment "busy"
    drops; at the deadline the app ends the activity and sends `POST …/end`. It also ends on logout, on
    `apnsEnabled: false` and from outside (`ended`/`dismissed`). An end from outside (8 h of the system, `end` from
    the server) leaves the frozen tile on the Lock Screen for up to 4 more hours, so the core calls `end` at once
    (`dismissalPolicy: .immediate`) to remove it: no tile beats a stale one.
  - **Traces in `client.log`** (prefix `live-activity:`): start, token, acceptance, end with a reason, and a stuck
    activity detector when the scene turns `active`: the content age (store clock minus the server's `updatedEpoch`)
    and the app writes since the last such line (ordered, accepted, rejected, rolled back). An age above about 15 min
    means the system stopped the Live Activity (the server sends a heartbeat at least every 10 min). At most once per
    15 min (`LiveActivityRuntime.ageTraceGap`), never the token or the activity id.
- **Dictation key (`RarogStore+Voice`):** `POST /api/voice/token` at EVERY Soniox stream opening, never in
  advance. A 404 or a 503 `voice_unconfigured` makes `AppState.sonioxOnServer` unavailable until a new
  `serverStartId`, a login, a logout or another server; it does not hide the microphone, it changes the route: with
  Soniox chosen the next tap opens the Dictation screen. Another 503, a 429 and a 5xx mean "not now".
- **Voice agent across sessions (`RarogStore+Companion`, `Selectors+Companion`):** two reads without state in
  `AppState`: `loadCompanionSessions()` (`GET /api/companion/sessions`) and `loadCompanionTurns(sessionId:count:)`
  (`GET /api/sessions/:id/companion/turns`, `count` 1–3 checked before the request). A 404 of the catalog and both
  503 codes (`companion-disabled`, `companion-sessions-disabled`) read as "off"; a 404 of the turns route is a
  session outside the catalog, with the server's sentence. The turns come back whole, so `conversation` and
  `readMark` can go back to the server: `pickUpCompanionResult(sessionId:conversation:readMark:)` sends them byte for
  byte with `by: voice-agent` (`POST /api/sessions/:id/seen`, a mutation through the gate) and writes nothing into
  `AppState`, also on success: the session frame brings `seenBy`. Its outcome (`CompanionPickUpOutcome`) names a 409
  (`resultChanged`: the result is not the one read), a 404 (`outsideCatalog`) and both 503 codes (`disabled`); a 401
  logs out the login the request went out in, and an answer after another login is `loggedOut` and changes nothing.
  `AppState.companionSessionsOffered(sonioxAllowed:)` offers the mode only
  where the voice agent is offered and `/api/version` has both `companionSessions` and the capability
  `companion-sessions` (`Capabilities.companionSessions`).
- **Voice agent's prompt (`RarogStore+CompanionSend`):** `sendCompanionPrompt(sessionId:text:conversation:clientMessageId:)`
  sends the text exactly as given through the outbox as a text-only send (`queueAware`), with the sender pair in
  the entry (`OutboxEntry.sender`), and returns `CompanionSendOutcome` after the server's answer: `sent`, `queued`
  (a 202 with `queued: true`), `conversationChanged` (the 409 whose sentence code is
  `session.conversation-changed`, read from `APIFailure.sentenceCode`), `refused` (the app's send gate
  `AppState.sendBlock(for:)` before anything goes out, or a client gate or server refusal with its code and
  sentence), `loggedOut`, `cancelled`, `timedOut` and `failed` (the last two: not known whether it arrived). The
  caller owns the `clientMessageId`, which is the entry id: a call with the id of an accepted entry, or of one
  its echo already settled, answers `sent` or `queued` without a request; a call while another with the same id
  runs shares that send (`companionSends`), and a call while a person's Retry of that entry runs, from its
  manifest write on, waits for that Retry's outcome (`retrying`); a call with the id of a Not confirmed or retryable
  refused entry sends that entry again, with its saved text and pair. Each of these answers only the id's first
  session, text and token, which stay with the send in flight, in the entry and, after the echo, in
  `AppState.echoedPrompts`; another text, session or token under the same id is refused as `client-id-conflict`
  without a request. After the 409 the entry stays as a final refusal with the server's sentence, so no Retry sends
  the prompt into the other conversation; a repeat of that id answers `conversationChanged` again. An end that does
  not know whether the prompt arrived (no answer, a dropped connection, the entry gone while a repeat's manifest was
  written) answers `sent` when the echo of that id already came (`AppState.echoed`), so the model does not ask the
  user to send it again. A person's stop of the send (`cancelSend`) answers `cancelled`; once the request went out,
  the entry stays Not confirmed, because the prompt may have arrived.
- **Dictation route (`Dictation/`):** `DictationPolicy.route` takes the device's choice (`DictationChoiceStore`,
  `UserDefaults` key `rarog.dictation.choice`, kept through Forget Server), `sonioxOnServer` and the build flag
  `RAROG_VOICE_SONIOX` (`DictationServices.sonioxAllowed`) and gives `ask` (the Dictation screen), `system` or
  `soniox`; `RarogStore.dictationRoute` is the same for the views. No choice asks; System Dictation is always
  `system`; Soniox needs the flag and a server that did not refuse it (unknown before the version probe lets the
  mint decide).
- **Areas extend the core in their own files:** actions in `RarogStore+<Area>` (the store exposes `transport`,
  `persistence`, `dispatch`, `currentLogin`, `isCurrentLogin(_:)` and `handleUnauthorized(since:)` as `internal`), one case
  `CoreEvent.<area>(<Area>Event)` with branches in `Reducer+<Area>`, a state field at the end of `AppState`, transport
  methods at the end of `RarogTransporting` (and `FakeTransport`), REST types in `RarogContract/RestResponses+<Area>`.
- **Device memory (`ProjectMemory`):** the project tab (32 entries, LRU), the directory history under Cmd+L (16), the
  list collapse, the projects folded in the tree (`CollapsedProjects`), the projects pinned in the tree
  (`PinnedProjects`, key `rarog.pinnedProjects`: a cap of 64 that drops the earliest pinned directory not in the tree
  and never unpins a project standing in it; a damaged record means no pins) and the remembered model of a new
  session, through `PreferenceStore` (`UserDefaults` in the app,
  `MemoryPreferences` in tests): paths and identifiers only. The same store carries the transcript's "read up to here"
  (`LastSeenMemory`, 32 sessions).
- **Gates:** `MutationRules` is the HTTP client's `MutationPolicy`: it waits up to 5 s for the first `hello` and
  refuses on `tooOld`/`protocolMismatch` and for an `unsupported` session. Refusal sentences live in
  `Copy/CoreCopy.swift`; after a transient refusal (`PolicyRefusal.transient`) the terminal tries again.
- **List cache (`SnapshotCache`, `SnapshotCacheFile`, `RarogStore+Cache`):** one file with the last fresh list (24 h,
  2 MB), without the content of decisions, the screen, activity and background task commands
  (`SnapshotCacheFile.scrub`). It is written at every fresh `sessions-snapshot` and on going to the background, read in
  `start()` and at every pairing before `.loggedIn` (so the first frame with a key is the list), and never written
  back. It lives in `<space>/list/`; a 401 deletes it (`clearCaches`).
  - **Stale list:** `listCache.staleSince` goes away only at a fresh `sessions-snapshot` and at logout; until then
    `listStale` disables project and tab actions, and `awaitingTranscripts` blocks the viewed session's actions until
    its first transcript. Closing waits only for a fresh list (`MutationRules.listOnlyRoutes`), and so does a message
    whose body carries `expectedConversation` (the voice agent's prompt): the request tells the gate so
    (`MessageUpload.expectsConversation`, `MutationGate.check(method:path:expectsConversation:)`), because the agent
    read the session from the server and the server checks the conversation. The voice agent's question about a
    session (`companion/ask`, in `listOnlyRoutes`) needs only the fresh list as well, because the server answers it
    from the session it reads. A typed message still waits for the transcript.
- **List memory (`Reducer+List`):** `AppState.turnStage` holds the last turn stage of each session in a turn (the line
  under the row stays until the end of the turn). `AppState.heldUnread` keeps a seen session with an unread result at
  rank 1 after `seen`, so reading does not move the row, until its `stateSince` changes, a full list state, the
  background or logout.
- **Activity row bases (`Reducer+ActivityRow`, `Selectors+ActivityRow`):** `TranscriptState.turnEvents` grows by
  one for each `activity` other than `idle` and each new message (not a repeat) that arrives on the session's own
  stream while the session is in a turn; the global copy of an activity, snapshots and clock ticks leave it
  (`turnEvents(_:)`). `activityClocks(_:)` gives the row's three time bases: the turn clock from `turnSince`, without
  it from `stateSince`; the tool from the arrival of a `tool` activity minus its `elapsedSeconds`; the silence from
  the most recent of the latest message time (by `at`, not by `seq`) and the start of the latest activity.
- **Background tasks (`BackgroundTaskRules.swift`):** the one place in the app for whether a `backgroundTasks` list
  is work, a mirror of `server/src/herdr/background/work.ts`. Three work rules (`tasksKeepRowWorking` for the row rank
  and tone, `hasBackgroundWork` for the Live Activity `working` counter, `hasOpenWorkflow` for its "busy"), two rules
  about the list (`hasTasks`, `onlyWaitingAgents`) and two about one task (`waitingAgent`, `workingAgent`). A waiting
  subagent (kind `agent` with `waitingSince`) is not work. `BackgroundTaskRulesGuardTests` allows `backgroundTasks`
  outside the rules only on a closed list of exceptions with a reason, and `BackgroundTaskRulesTests` tables each
  rule's answer per list shape. Both sides: `docs/background-tasks.md`. The name is unrelated to the `BackgroundWork`
  protocol in `PushSystem.swift`.
- **Transcript memory (`CoreLimits.maxTranscripts`):** at most 12 transcripts in memory (LRU, the viewed one is never
  evicted), each at most 500 messages; an evicted one comes back as a skeleton, then a `transcript-snapshot`.
- **Session signal (`Reducer+Signals`):** `AppState.signal` records a session ENTERING permission, a question, an
  error, a usage limit or `done` after real work, never at first sight or at a full list state. The view decides
  whether a toast appears (`ToastCenter`).
- **Cards (`RarogStore+Decisions`, `Selectors+Cards`):** permission card decisions (`allowAlways` only with the
  server's verbatim label), a dialog in the pane addressed by the session (`POST …/permission`), Resume for
  `resumable`. The server allows the dialog that stands AT THE MOMENT of the request, so Allow
  carries the card's dialog signature (`HerdrDialogSignature`) and goes out only when exactly that dialog stands
  (otherwise `.changed`); a swap disarms the second tap (`HerdrDialogCards.settle`). The result arrives through the
  stream. The directory trust warning (`trustPrompt`) lives in `AppState.cards` until the session leaves the start.
- **What the core deliberately does not do:** it does not parse harness tags (the server classifies them), does not
  send by itself after a long break (a human retries), does not queue decisions, and does not keep transcripts on
  disk.
