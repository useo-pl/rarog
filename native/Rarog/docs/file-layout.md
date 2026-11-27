# File layout and owners

Part of the app description: [native/Rarog/README.md](../README.md).

Large files are split into seams per area, so parallel changes land in different files. An area's owner changes its
own files and only reads the others; an "owner" comment stands at the top of each file. The seams follow one rule:

- **Core:** store actions in `RarogStore+<Area>`, reducer branches in `Reducer+<Area>` (the main `apply` hands its
  events there in one line), selectors in `Selectors+<Area>`; an area without state in the reducer (`+Uploads`,
  `+LiveActivity`, `+Spaces`) has no reducer file. Store fields read by extensions are `internal`.
- **Transport:** an area's endpoints in `RarogClient+<Area>`. Limits that mirror the server live there: the
  `AnswerLimits` caps (answer 2000, note 8192, request total 32768) in UTF-16 units like the server's
  `string.length`; an image from `/uploads` at most 8 MB with a PNG/JPEG signature; the file path in a diff query
  is encoded by `segment` by hand with a closed character set, because the server reads a plus in a query as a
  space (the session files' `dir` and `path` too); tokens travel only in the body. A session file
  (`RarogClient+Files`) streams to a copy in `rarog-preview/` of the temporary directory with complete file
  protection, never whole in memory; the limit is the `maxBytes` of the session's latest listing (else of its file
  index) passed by the caller (the app has no limit of its own), and a body that does not match its `Content-Length`
  or any failure deletes the copy.
- **Tunnel and transport switch:** `RarogTransport/Tunnel/` holds the iroh tunnel without IrohLib: the protocols
  (`TunnelTypes.swift`), the generation ticket and the upload door (`TunnelGeneration.swift`), the generation state
  machine (`TunnelMachine.swift`), the endpoint lease (`EndpointLease.swift`), the loopback proxy (`TunnelProxy.swift`),
  the actor that runs them and owns every loopback client, with the register of tunnel constants
  (`TunnelRuntime.swift`), the app's iroh key (`IrohIdentityStore.swift`), and the network path comparison with its
  client log line (`NetworkPathSnapshot.swift`). The `RarogTransportTesting` library is
  the fake tunnel with faults and a fake clock, for tests of this package and the packages above it; the app does not
  link it (`RarogUIKitTests` does, for `TunnelCoordinatorTests`). `RarogCore/Transport/` holds the server identity
  of a data space (`ServerIdentity.swift`) and `SwitchingTransport.swift`, the one `RarogTransporting` and
  `TerminalTransporting` of a paired server over the runtime's generations. `TunnelForwardingTests` checks that the
  switch forwards every function and variable of both protocols with the same argument labels, because the protocol
  extensions' defaults (404, no refusal, route 0) would swallow a missing one silently. The app target's
  `TunnelCoordinator.swift` (one per process) builds them: one endpoint lease with the device's iroh key, a
  `SwitchingTransport` over a `TunnelRuntime` for the paired server's key (also for a key with only an address), a
  short-lived runtime for pairing over iroh and for `forgetTransport`. The switch's rules (no retries, `.offline`,
  the upload door, one rejection latch): `docs/architecture.md`, "Native client".
  Each generation picks its route in `TunnelMachine.choice`: iroh when the key has an iroh pair and the endpoint lease
  is ready, otherwise HTTPS when the key has an address. One attempt has 15 s (`attemptBudget`), a failed iroh attempt
  sends the next generations to HTTPS for 2 min (`irohRetryDelay`), and the attempt after a failure waits 1 s
  (`cooldown`). With an iroh pair an HTTPS generation passes the same probe as iroh before it is ready; a failed
  HTTPS attempt ends the 2 min early, so the next generation tries iroh, and a ready one stays until it closes. While
  both routes fail the attempts alternate, with one failure line per route until a generation is ready again. A key
  without an address (`TunnelMachine+IrohOnly.swift`) retries iroh after 1, 2, 4, 8 s, then every
  15 s (`irohOnlyRetryDelays`, `irohOnlyRetryCeiling`; a ready generation and a network change start the series
  over) and has 30 s per attempt in the foreground (`irohOnlyAttemptBudget`; the pairing runtime too, so
  `pairingLifetime` is 40 s, and so is `forgetLifetime` of the runtime that revokes a previous key). Every key reports
  an iroh failure to the endpoint lease at most once per `irohRetryDelay`, so quick retries do not rebind the endpoint
  and close an upload door. Pairing retries and the runtimes of `forgetTransport` build a new runtime each, so they
  share one such limit held by the coordinator (`IrohReportThrottle`): the first failure of such a series reaches the
  lease, the next ones only after `irohRetryDelay`, and a success always does.
  A generation lives 8 s after the scene goes to the background (longer while background work that needs the
  server runs). iOS suspends an app without a background task about 2 s after it leaves the screen, so from that
  moment the coordinator holds one system background task without `needsServer` (`rarog.tunnel-grace`, through
  `UIKitBackgroundWork`) until no runtime has a generation in the background, including one a retired runtime is
  still closing (`TunnelRuntime.backgroundTimeReleased()`), or the scene comes back. When the system expires or
  refuses that task, a generation in grace closes at once (`backgroundTimeExpired`), and one held by background work
  closes when that work ends; a return after the deadline closes the old generation even if its deadline tick has
  not run yet, and requests wait for a new one.
  The pairing runtime is one-shot: the coordinator retires it as soon as `pair` returns (answer, error or
  cancellation; `SwitchingTransport.afterPair`), and `pairingLifetime` only caps a call that never returns. Tunnel
  lines reach `client.log` through `TunnelTrace.swift` ahead of the connectivity trace budget: alarms have their own budget
  (6 per hour), other `tunnel:`/`lease:` lines 4 per hour. Alarms are iroh generation failures (without an address
  only the first failure of an outage, plus one `recovered after N attempts, T s` line when iroh is back), a ready
  iroh generation that closes in the foreground (`closed in foreground: network`, `lost` or `abort timed out`) and
  the watchdog; an alarm line ends with the event time (`at HH:mm:ss UTC`). On leaving the
  background the app writes one `tunnel state:` line with `routeStamp` and the coordinator and runtime counters at
  most every 10 minutes, or at once when they exceed the steady state.
  It does not ask which platform it runs on (`IrohBoundaryTests`); `TunnelCoordinatorTests` in `RarogUIKitTests`
  checks it.
- **iroh relay registry client:** `RarogTransport/RelayAccess/` holds the client of the registry Worker
  (`RelayAuthClient`, `POST /v1/app/*`, 10 s per request): `RelayAccessMachine` decides when to register the app,
  sponsor the paired server, renew (every 6 h) and forget, `RelayAccess` is the actor that runs it, and
  `SystemRelayAccessStore` keeps its two Keychain items (`relay-access`, `relay-optout`) in the service of the iroh
  key. The app target holds the gate (`RelayGates.swift`: a DeviceCheck token for `register`) and its values
  (`RelayAccessSetup.swift`); Debug builds read `RAROG_RELAY_FAKE_GATE`, `RAROG_RELAY_AUTH_MAP` and
  `RAROG_RELAY_RENEW_EVERY` (guard `server/test/relay-debug-guard.test.ts`). `RelayAccessWiring.swift` builds the one
  `RelayAccess` of the process in `RarogApp`, gives the connector its registry calls and forwards the statuses to the
  store; `TunnelCoordinator` passes it the server list and the triggers.
- **Session screen:** `Session/SessionViewController*.swift`: the core (lifecycle, layout, render) and extensions per
  area (`+Cells`, `+Send`, `+Decisions`, `+Answers`, `+Pinning`, `+UnderFoot`, `+StateCard`, `+Reading`, `+Keys<Area>`,
  `+Controls`, `Voice/+Voice`, `+Interrupt`, `+Drafts`, `+PromptBar`, `+Toast`, `+CommandSuggestions`,
  `+AppCommands`, `+Diagnostics`, `+PointerSelection`, `+PointerAutoscroll`, `+FileOpen`, `+FileHover`). The core
  calls each area's `build…`/`render…`/`leave…` in one line, and the area's fields live in its own chrome type
  (`ReadingChrome`, `TurnChrome`, `ToastChrome`, `TranscriptPointerChrome`, `TranscriptFileChrome`). The pointer
  selection's model has no view and compiles on macOS (`Model/TranscriptPointerSelection*.swift`: the selection, its
  copy text, the autoscroll curve and the trace budget); a message row's part of it, the highlight and the geometry under the
  pointer (also the inline code under a click or tap), is `Session/MessageContentView+PointerHighlight.swift`. A path
  in inline code opens the session file: `+FileOpen` holds the finger's tap recognizer and the screen's one opener,
  and the pointer's click reaches it through `+PointerSelection`; `+FileHover` holds the pointer's hover over such
  code, and `Session/MessageContentView+FileHover.swift` its underline and pointer shape. Its logic compiles on macOS:
  `Model/TranscriptFilePath` (the candidate in one inline code run and its match in the file index) and
  `Model/TranscriptFileOpener` (its own index load and refresh, the newest tap, the pending limit, the miss trace,
  then `Model/FilePreviewModel`). The cell factory picks
  a cell by row kind and calls the area's function; `keyCommands` and `canPerformAction` assemble the areas' lists,
  so a new area adds one element. `+KeysInterrupt` stands BEHIND the card keys in `keyCommands`, so Esc on a
  focused card or a sheet wins.
- **Voice conversation core and its host** (`Session/Voice/Realtime/`): the core is `VoiceAgentSession` with its
  `RealtimeConversation` (keys, audio, socket, Soniox speech, the prompt confirmation lock, the login check, the
  indicator, `client.log` lines). It knows no session screen: what the conversation is about comes from a host, the
  `VoiceAgentHost` protocol (`VoiceAgentHost.swift`). A host gives `RealtimeConversation.Content` (the instructions
  with the opening content in a character budget, the content that is new after each closed utterance, and the tools
  as `RealtimeToolSpec`: name, schema, `client.log` tally and an action that is an answer at once, work with or
  without the checking phase, work that also gets the moment of its call (`workAtTurn`: the reply that called, the
  user's kept utterances and whether one began after the last reading played out whole, `RealtimeToolTurn`), such
  work that may end in a text the conversation reads aloud before the result goes (`workAndRead`,
  `RealtimeConversation+Reading.swift`, with the heard prefix of the text while it plays and the host's stop of the
  reading; the alignment of Soniox's characters to the text is `RealtimeConversation+ReadAlong.swift`), or the prompt
  pair `showPrompt`/`sendPrompt` whose effects and words the host gives),
  and the end rules (`startRefusal`, `endReason`); a host may follow the answers (`answer`: a spoken answer played
  out whole, a cut; `RealtimeConversation+Answer.swift`). The session screen's host is `VoiceAgentSessionHost`
  (`VoiceAgentSessionHost.swift`): the transcript projection (`VoiceAgentTranscriptSource`), `ask_session`,
  `show_prompt`, `send_prompt` (`RealtimeInstructions+SessionHost.swift`), `VoiceAgentWatch`, and the field closures
  and app state input that `SessionViewController+VoiceAgent` sets in `connectVoiceAgent`. The Inbox card's host
  `VoiceAgentInboxHost` (`VoiceAgentInboxHost.swift`, owner `VoiceAgentInboxConversation.swift`) wraps it with the
  card's own prompt pair, prompt rules and prompt tool descriptions (`RealtimeInstructions+InboxHost.swift`); the
  prompt block's states and its voice lock are the pure type `InboxPromptBlock` (`InboxPromptBlock.swift`), and the
  owner's part of it (the show, the reading, the block's actions, the send with its recovery, the hand-back of the
  text) is `VoiceAgentInboxConversation+Prompt.swift`. The host of the
  conversation across sessions is `VoiceAgentSessionsHost` (`VoiceAgentSessionsHost.swift`): its route to Rarog
  `VoiceAgentSessionsBackend` (the store), the session list with handles and states (`VoiceAgentSessionList.swift`),
  `read_sessions` with its read records (`VoiceAgentSessionReads.swift`), the discussed session and the pick-up of
  its result (the rule `VoiceAgentDiscussion.swift`, the host's part `VoiceAgentSessionsHost+Discussion.swift`),
  `check_open_requests` with its rule of the user's word (`VoiceAgentSessionsHost+Check.swift`), the prompt pair:
  `show_prompt` with the prompt lock (`VoiceAgentSessionsHost+Prompt.swift`), `send_prompt` with its outcomes
  (`VoiceAgentSessionsHost+PromptSend.swift`) and every sentence the pair gives the model
  (`VoiceAgentSessionsHost+PromptText.swift`), and the instructions and tool schemas
  (`RealtimeInstructions+SessionsHost.swift`). Its owner above navigation is
  `VoiceAgentSessionsConversation` (`VoiceAgentSessionsConversation.swift`, built once by the root view): the entry
  rule (`VoiceAgentSessionsEntry`) with the mode's own consent, one host per start, the ends and the scene phase. Its
  views (the list button, the consent sheet and its flow, the lit circle with its bars, its place in the session
  header and the Inbox's header, the end sentence's line and the strip under the list header in
  `VoiceAgentSessionsHeader.swift`, what stands above the screen with the waiting prompt's card in
  `VoiceAgentSessionsBar.swift`, and the rule of where the state stands in `VoiceAgentSessionsBarPlacement.swift`)
  stand in `Views/VoiceAgent/`; the session header's icon group (`HeaderSessionSlot`) only places the circle, and the
  Inbox at the root of the stack (`InboxStackRoot`) only mounts `InboxHeaderVoiceSlot`. A
  new host adds its own files and does not change the core. The app's one microphone, `DictationCenter` with the
  `DictationHost` protocol, stands without UIKit in `Session/Voice/DictationCenter.swift`, so the macOS tests use
  it: the message field's, a project note's and an Inbox card's dictation and the voice conversations take it over
  from each other. The Inbox card's dictation is the third host of a recording, written out like the other two:
  `Views/Inbox/InboxDictation.swift` (the recording, ↑ during it, the ends), with the card's field as dictation sees
  it in `Model/InboxDictationTarget.swift`, without UIKit.
  Next to the center, also without UIKit, the locked-phone monitor `LockedPhoneMonitor`
  (`Session/Voice/LockedPhoneMonitor.swift`) reads what records there, holds the server connection and writes its
  `client.log` lines; the app's instance (`LockedPhoneMonitor+Live.swift`) wires the center, the store and the app's
  `TunnelCoordinator.holdForVoice`, and the store's question to the server for its heartbeat stands in
  `RarogCore/RarogStore+LockedPhone.swift`; the rule it holds by, `BackgroundRecording`, stands in
  `RarogCore/VoiceAgent/BackgroundRecording.swift` (`docs/companion.md`, "Locked phone"). The app target reaches the
  center only through `AppMicrophone` (`Session/Voice/AppMicrophone.swift`, public): what records, its phase and its
  subject (`MicrophonePhase`, `MicrophoneSubject` in `Session/Voice/DictationCenter.swift`; the subject carries
  only a session's project and name), its changes, and the end and the Send from outside the screens (the Send's
  outcome `LockScreenSend` in `Session/Voice/LockScreenSend.swift`). Its one user is the voice Live Activity's
  controller in the app, `VoiceActivityController` (`Rarog/VoiceActivityController.swift`: the rules, the send from
  the tile, the ActivityKit adapter behind `VoiceActivitySystem`); the activity's state, copy, views and the intents
  of its buttons stand in `RarogActivity` (`VoiceActivity*.swift`, `EndVoiceActivityIntent.swift`,
  `SendDictationActivityIntent.swift`), and the `RarogWidgets` extension draws it (`RarogVoiceActivity.swift`).
- **Row model:** `TranscriptRows.swift` holds the `TranscriptRow` enum (Swift cannot extend an enum: a new case goes
  at the end) and `build`; messages in `TranscriptRows+Messages`, outbox and cards in `+Tail`; reading rules in
  `ToolRows`, `PromptFolds`, `TranscriptMarkers` and `TranscriptReading`.
- **Copy:** `UICopy.swift` and its extensions `UICopy+<Area>`; an empty area is an empty `extension` with a comment.
- **Views:** `Views/<Area>/` (`List`, `Header`, `Inspector`, `Inbox`, `Notes`, `NewSession`, `Projects`,
  `SessionControl`, `Presentation`, `Settings`, `Usage`, `Banners`, `Common`), cards and rows in `Session/Cards/` and
  `Session/Rows/`, the terminal in `RarogUI/Terminal/`, the session switcher in `Switcher/`, attachments in
  `Session/Attachments/`.

Behavior of the surfaces that the sections above do not describe:

- **Question card** (`Model/QuestionCardModel`, screen state `Model/QuestionCardState`): the draft (`QuestionDraft`:
  selections and the custom answer, the fresher one wins) lives in an observed `QuestionDraftBook`, so typing and
  selecting do not rebuild the transcript. After an answer the confirmation window lasts 1.5 s with a next card and
  6 s without one (`QuestionFlight`). Keys: a digit is the n-th visible option of the question that has the keyboard,
  Enter is Answer, without system repeats (`QuestionKeyRepeat`). An option preview (`QuestionOption.preview`) stands
  UNDER the section's options as a monospaced block scrolling in both axes, with the permission card's plan cap
  (`CardBlockCeiling`: 20 lines); a question with a preview is not `instant`. The form review screen
  (`Question.review`) shows question → answer pairs. The Note field appears only with `Question.notes == true`: the
  server computes it, and the app derives nothing; a note concerns ONE option from the list, so with a custom answer
  the card does not send (`noteRejected`, the server's rule mirrored in `submission`).
- **Project tree** (`Views/List/ProjectTreeList`, the only list layout): one list over the whole height, project headers
  ordered with the pinned ones first (`RarogCore/PinnedProjects`, `rarog.pinnedProjects`, pinned from the header's
  context menu through `ProjectTreeRows.pin`), each part by the alphabet of the app language (`CopyLocale`, numbers in
  natural order), then the path, and under them agents oldest first, also Codex in a Rarog terminal. The header arrow is
  a separate 44 pt button (`tree.toggle.<name>`); a header with agents collapses or expands without moving the route,
  without agents it enters the project (`ProjectTreeHeaderModel.tap`). Collapsing remembers `rarog.collapsedProjects`
  (only what a human collapsed) and hides only quiet rows (`AppState.treeShows`: rank ≤ 2, the selected row and the last
  opened one stay). `Views/List/TreeListAnchor` keeps the selected session in place when rows change above it. The guide
  line (`ProjectTreeGuide`) is drawn in the row content by `Views/List/TreeGuideLine`; while a row is swiped it stays in
  place: a stand-in above the cell, at the cell's resting place, replaces it until the row is back. The list lays swipe
  actions out from the cell's edge, and an agent's plate starts 33 pt into its cell, so for the same swipe
  `Views/List/TreeSwipeActionsShift` moves the list's actions view by that inset while the leading actions show: their
  pill stands 10 pt from the plate like the trailing one, clear of the guide. At the end of a header's first line stand
  up to three buttons drawn over hidden placeholders (the header ignores its children for VoiceOver): the pop-up
  terminal (`Views/List/TreeTerminalButton`, `tree.terminal.<name>`), the Recent Sessions clock
  (`Views/List/TreeRecentButton`, `tree.recent.<name>`) and the note glyph (`tree.note-glyph.<name>`); their geometry is
  in `Model/TreeHeaderButtonGeometry` with the sizes in `SessionListMetrics`.
- **List** (`Views/List/SessionListView`): close by swipe or context menu without a question; closes of different
  sessions run in parallel (`RarogNavigation.closing` is a set). The swipe pill has no destructive role, so the row
  leaves only with the server's list snapshot: with the role UIKit deleted it at the tap and the list could crash
  on mismatched item counts (`ListSwipeCloseCrashTests`). The 320 pt column stands on `background`; the
  selection is an own background with a 12 pt radius (`ListRowHighlight`, `PlainListRow`): beside the detail the
  open session's row on `surface2`; in the stack (iPhone, narrow window) the row of the last opened session the app
  still knows (`RarogNavigation.lastVisitedSession`, from the persisted session history, so it is there after a cold
  start too) on `stackedPlate`, with full ink like a selected row. During the push the tapped session already holds
  it, and the pop clears the selection while the history holds the same session, so the plate does not blink on the
  way back. Coming back from a session or terminal screen, the stacked list centers that row when no point of it is
  in the visible part (under the bar, above the footer card), once per return (`Model/ListReturnScroll`: the rule
  and `RarogNavigation.takeListReturn()`, recorded when the route is cleared). A row visible even partly, a row hidden
  in a collapsed project and the list beside the detail stay as they are. The scroll (`Views/List/TreeReturnScroll`)
  runs in the first layout of the collection back in the window. A pop by the back button or by the route cleared in
  code does that layout before its first frame (measured on iOS 27), so the list slides in already in place; the
  interactive edge swipe is not measured. In the stack an agent row also shows that plate while a finger holds its cell
  (`isHighlighted` observed by `ListCellFocusBridge`, which waits for the touch delay and goes out on scroll).
  `ListCellFocusBridge` also removes the system focus halo and `selectionFollowsFocus` (otherwise Cmd+L would reopen
  the old session). A row without contact with its source (`SessionRowModel.frozen`) is dimmed and its clock stops.
  The status dot of a fresh unread result glows (a soft halo of its color breathes under the full-color dot, 1.8 s a
  cycle; plain under Reduce Motion): `SessionRowModel.freshResult` from `AppState.freshResult`, which leaves out a
  result marked unread by hand (the server's `markedUnseen`, and this device's `TurnControlState.manualUnread` until
  that frame) and a frozen row; the session switcher's dot stays still. A received result the voice agent picked up
  (`seenBy`) has the state word "discussed by voice" in place of "idle" (`RowStatus`), with the dot and dimming of a
  received result; "working in the background" wins over it. The footer (`Views/List/Footer/`) is a
  floating glass card over the list (`safeAreaBar`, the list scrolls under it; geometry in `Model/ListFooterMetrics`, content in
  `Model/ListFooterCardModel`): on the left the account, under it the machine line ("Mac · tailnet") and the 5H and
  7D fields (percent, bar, the reset "in 2h 44m" or "in 2d · 11/14"); on the right, the height of the whole left
  column, three machine columns (CPU, RAM, DSK; none on a server without `GET /api/mac`) whose bars take the column's
  height. The card is not a control: one static accessibility element (`list.usage`, the spoken sentence, no hint),
  no tap, popover or pointer effect. The details are in the Usage sheet of the `/usage` app command (the limits'
  stale note, the machine section with metric details and its own stale note). The server update row, when shown,
  is the card's first line, in link ink, and its one target (`list.serverUpdate`): it opens the update steps
  (`Views/List/Footer/ServerUpdateSheet`: versions, the command with a copy button, what it does). Banners:
  `Views/BannerStack`, column placement in `Model/BannerSlots` (`bannerSlots(in:)`), the push
  invite at the end (`pushPromptVisible(in:global:now:)`). The macOS folder card (`Views/Banners/MacFolderBanner`,
  texts in `Copy/UICopy+MacFolders`) draws the folders the server keeps closed: `AppState.macFolders` from the
  `folder-access` frame (`Reducer+MacFolders`), the sessions they hold from `macFolder(holding:)`,
  `macFolder(forSession:)` and `macFolderSessions` (`Selectors`).
- **Navigation** (`Model/Navigation`, `RarogNavigation`): the right column (session, project without a session,
  terminal), tab and project memory, the list collapse (Cmd+B and `HeaderListToggle`), the 5 s arming of "×" (the
  current tab's "×" and the arming card: `Model/TabClose`), the notice under the tab bar and the inspector. In the
  stack on the iPhone and in a narrow iPad window (`compact`) `MainSplitView` binds `preferredCompactColumn` to the
  route (`compactShowsDetail`), not to the list selection, because a terminal and a project without a session have no
  row. While the Inbox stands there (`Navigation+Inbox`), the detail stack's root is the Inbox
  (`Views/Inbox/InboxStackRoot`) and its path is `compactInboxPath`, so a session opened from a card is pushed above
  the Inbox; the list does not select that session, because a new list selection makes the collapsed split pop the
  detail stack. `RarogNavigation.post` announces the notice once. The visit history is `SessionHistory` (RarogCore):
  the last 32 session ids on this device, stored under `rarog.sessionHistory` in `NavigationPreferences.serverScoped`,
  so a server change clears it. `RarogRootView` calls `RarogNavigation.noteSessionVisit` on every change of
  `listSelection` (a session screen, or a Rarog terminal with an agent inside, also when the agent appears there); a
  repeat of the newest id writes nothing. `lastVisitedSession` reads the newest id the app still knows, for the list's
  mark of the last visit.
- **Session header** (`Views/Header/SessionHeader`): slot modifiers `HeaderTitleSlot`, `HeaderStatusSlot`,
  `HeaderTabsSlot`, `HeaderSessionSlot`; `HeaderMetrics` (macOS tests) holds the insets: the first tab mark, the
  context ring and the right edge of the pills stand 16 pt from the column edge, like the transcript text in Standard
  spacing. The session and terminal "×" are not header buttons: they stand in the current tab
  (`Views/Projects/TabCloseButton`, the arming card under the bar `Views/Projects/CloseArmCard`); only a terminal
  without a known project directory, which has no tab bar, keeps its "×" in the icon group. The header
  buttons are ONE toolbar item (an `HStack` every 2 pt), at most three (`HeaderTrailingIcons`): with four, or with
  a title wider than `HeaderMetrics.phoneTitleMaxWidth`, the system hides the group in an overflow menu that does
  not show it. The lit circle of a running voice conversation across sessions counts among them and stands first
  where the list header is off screen; where it would be a fourth, Pop-Up Terminal gives way.
  `Header/HeaderIconButton` is a style of its own, because the iOS 26/27 toolbar draws `Label` and `Image` itself
  and ignores `.font`.
- **Status line** (`SessionStatusBar`): the context ring and git on the left, the "N in background" and
  "↑ <release>" pills on the right; tapping git opens `GitDetailsPanel`, which fetches NOTHING (the rows come from the
  `git-status` frame through `GitChangesModel.rows(fresh:)`). With the inspector visible the background pill goes
  away and tapping git scrolls the panel to its changes. What a tap does is decided by `RarogNavigation.gitLineTap`
  and `backgroundPillTap` (`Model/InspectorSheet`): on iPhone (`PopoverLayout.sheetBar`, the device, not the width)
  both open the inspector as a sheet, and the git popover is iPad only.
- **Per-file diff window (`Views/Header/DiffSheet`, `Model/DiffWindowModel`):** one scroll, a section per file; a
  section header is a sticky button (arrow, letter, path, balance; id `diff.file.<path>`), and the patch appears only
  after expanding. The window fetches the list (`sessionDiffFiles`) and the patch of EXPANDED files only
  (`sessionDiffFile`). `DiffWindowModel` (macOS tests) runs the requests through one pump (`run`): ONE at a time,
  the file tapped last first; a reply for a file whose section still stands ALWAYS reaches the screen, even when the
  repository state number (`TranscriptState.repoRevision`) grew meanwhile, because during agent work it grows every
  few seconds; refreshes coalesce into one pass at a time; the previous content stays during a read, and a section's
  identity is its path, so the reading position does not jump; collapsing drops the file from the queue and keeps
  its patch; a 404 `diff-file-not-found` refreshes the list once, and a 405 on the list route says the server is
  older than the app. Opening from a tapped file (`DiffFocus`, by PATH) expands it and scrolls to it once; a path
  ending in `/` is the first file under it, a git-quoted path matches after unquoting (`PathText.gitUnquoted`), a
  file outside a TRUNCATED list gets its own section on top. `Model/GitChangesModel` parses the patch
  (`PatchParser.rows`; LF or CRLF line ends, because in Swift `\r\n` is one character). `DiffSections` rebuilds the
  scroll view (`rebuild(at:)`) when a file read in the middle collapses or the content shrinks under the reading
  position, because a lazy stack with sticky headers is left with no rows on screen (measured on the iPad
  simulator, iOS 27.0).
- **Background tasks panel** (`Views/Header/BackgroundTasksSection`, shared by the `BackgroundTasksPanel` popover and
  the inspector): a flat list of lines with stable identities (`BackgroundPanel.lines`): the task row, under a
  subagent its own commands (`ownTasks` → `OwnTaskRow`, the command shortened to its tools by `Model/CommandTools`,
  never the whole command; Copy Command takes `rawCommand`), and under a `workflow` task with `run` its section (a
  summary, the phase list, live agents, and a toggle for the finished ones). The layout is ALWAYS the same, without a
  threshold on the agent count. A waiting subagent has an hourglass and the waiting time from `clockSince`; from a
  long wait on its own command the state line gives way to the warning line (`Views/Header/BackgroundWaitWarningLine`,
  model `Model/BackgroundWaitWarning`), and the Check button stands under the row (`Views/Header/WaitCheckButton`, message
  and button model `Model/WaitCheckMessage`; the guard in `RarogCore`: `WaitCheck`, `RarogStore+WaitCheck`,
  `Reducer+WaitCheck`, `Selectors+WaitCheck`). Without
  contact with the source (`WorkflowRunModel.frozen`) clocks stop and the panel says it shows the last known state.
- **Inspector (iPad):** `Views/Inspector/InspectorPanel` next to a Claude session screen; rules in
  `Model/Inspector` (`InspectorModel.fits`: a closed panel appears from a column of 920 pt, an open one stays down to
  880 pt, whatever its width), Cmd+I and `InspectorToggleButton`. Width: 320 pt by default; dragging the handle on
  its left hairline (`Views/Inspector/InspectorResizeHandle`, a 12 pt strip around the line, also adjustable with
  VoiceOver in 40 pt steps) sets 280–560 pt live and saves the device preference `rarog.inspectorWidth` once, at the
  end of the gesture (`RarogInspector.drag`, `endDrag`). The width shown is `InspectorModel.displayedWidth`: the
  transcript keeps at least 560 pt, so a narrower column narrows the panel without changing the preference. Over
  the strip the iPad pointer is a vertical beam with arrows to both sides, and on a Mac a double arrow shape, since
  the Mac draws the beam as the text cursor (UIKit `UIPointerInteraction`; SwiftUI `PointerStyle` is unavailable on
  iOS). Content in one `ScrollView` with ONE anchor: background tasks, recently
  finished (`FinishedTasks`, up to three finish notices from the transcript tail), scheduled tasks
  (`ScheduledTaskRows.rows` in the server's order, chosen under the panel's 30 s clock `ScheduledTasksClock` and on
  return to the foreground, so an expired one leaves without a frame), artifacts (`ArtifactRows.rows` in the server's
  order; a live artifact is a link with `#no_universal_links`), pull requests (`PullRequestRows`) and Files
  (`Views/Inspector/InspectorFilesSection`): the whole file tree of the session directory, rows of 30 pt
  (`FileTreeMetrics`), collapsible, with the Files / Changed only toggle (the glass capsule of the list filter,
  `ListFilterBar`, without its shadow) and the search field under the header
  (`Views/Inspector/InspectorFilesSearch`: the field is a `UITextField` with its own Esc key command); the store wiring
  (mode, query per session, the index state through `FileSearchIndexMemo`, `setSearchActive`, result folds) is
  `Views/Inspector/InspectorFilesContainer`, and `Model/FileSearchRunner` runs the search after a 150 ms pause, off the
  main actor, one run at a time, the newest winning. `Model/FileTree` builds the rows from `FileTreeStore.snapshot` of RarogCore
  (listings merged with the change markers, virtual rows for changed paths no listing carries, the two truncation
  flags, and the fallback tree from the `git-status` frame); `Model/InspectorFiles` holds the rules of a row: the
  tap, the long-press menu (Preview, Diff, Copy Path), the copied path, the ink and the VoiceOver label.
  `Model/FileTree+Paths` builds the tree of given paths (Changed only, a search result: every directory open, no
  listing awaited), and `Model/FileSearch` holds the file search: the paths searched (the server's file index, or the
  loaded listings and the changes), the plain or regex match stopped by a newer query or a 250 ms budget, the result
  of the first 500 hits and its notes; `Model/FileSearch+Index` maps the tree store's index state to the search's
  (`FileSearchIndexMemo` builds the search index once per index the store holds). The Files mode and the `.*`
  button are device preferences of `RarogInspector`. The panel
  tells the tree store when it stands (`panelOpened(_:)` on appearing, `panelClosed()` on leaving, only while the
  tree is still its own, because the panel is rebuilt per session) and hands it the directory toggles; only
  `DiffSheet` reads a patch. Preview (`InspectorPanel.preview(_:)`): `Model/FilePreviewModel` fetches the file with
  the limit from the session's latest listing (else its file index) and owns the copy until
  `Views/Inspector/FilePreviewPresenter` shows it in QuickLook from the panel's own view controller (over the sheet
  on iPhone, so closing returns to the panel);
  `FilePreviewController` deletes the copy when the preview closes. Only the last tap shows; a copy of an older tap,
  of a panel that left and of a refused presentation is deleted. `Model/FilePreviewType` gives a text file whose
  extension QuickLook does not show (`router.ts`, `main.go`, `Makefile`, `config.yaml`, `styles.css`) a `.txt` copy
  when its first 8 KB are UTF-8 without NUL; plain text and source code, HTML, XML, JSON, RTF, calendar events,
  contacts, images and documents keep their extension. The title stays the real name. Over the limit, offline and
  refused, the app's bubble says so and the tree stays.
  On iPhone the same view stands in a sheet (`InspectorPlacement.sheet`, `Views/Inspector/InspectorPanel+Sheet`):
  `RarogInspector.sheet` holds the session, `RarogNavigation.openInspectorSheet` sets its anchor (the header button
  goes through `toggleInspectorSheet`, at the top), and a change of
  `detail` closes it; `DetailView` presents it, because it gets the transcript stream memory for the stale note
  (`TranscriptConnectionMemory`, kept by `RarogRootView` next to the global one, because the list column reads it
  for the connecting card too).
- **Model and mode pills** (`Session/ComposerPills`, rules in `Model/SessionPillsModel`): in the control row UNDER the
  field (`docs/design.md`, "Composer"). The model opens the `ModelSheet` popover: the choice remembers only fields
  touched by hand (`ModelDraft`), and the Apply reply goes only to the presentation it came from
  (`SheetPresentation`). The Ultracode row appears only for a model with `ModelChoice.ultracode`, and No sends an
  explicit `false`. Mode: a tap toggles `plan` ↔ `auto`.
- **Toast** (`Model/ToastCenter`, in the environment from `RarogRootView`): one toast at a time; the 6 s timer and
  the queued VoiceOver announcement start in the center, not in the view. Four placements (`ToastPlacement`): on the
  session screen with a transcript the toast stands ABOVE THE PROMPT inside the screen
  (`Session/SessionViewController+Toast`, 8 pt above the top of the foot, or above the Scroll to Bottom
  button), covering the last transcript lines, not the field or the keyboard; on other right-column screens it is an
  overlay at the bottom of the column (`Views/ToastHost`); while the Cmd+F/Cmd+G terminal window is open, the same
  overlay stands at the bottom of the window (`TerminalWindowToast`), because the sheet covers the column, and the
  column overlay stays silent; while the phone's session panel sheet is open (`inspectorSheet`), the same overlay
  stands at the bottom of the sheet (`Views/Inspector/InspectorPanel+Sheet`), so a refused file preview or a signal
  of another session is seen there, and the session screen and the column under the sheet stay silent. An iPad,
  whose panel is a column, never gets the sheet placement. Its center is the center of the column in the safe area.
  The lightest kind is a confirmation (`notice(_:hold:)`, a check mark before the sentence, 2 s; the terminal's copy
  result): it never replaces a session toast or a toast with an action (VoiceOver still hears it), only a plain
  notice or another confirmation.
  The animation belongs to the toast alone (opacity and an 8 pt slide; opacity only with Reduce Motion). A tap removes
  it at once and opens the session only in the NEXT frame (`ToastHandoff`: `CATransaction.flush()`, then a one-shot
  `CADisplayLink`), so the toast is gone before the new screen is built; the opening does nothing if the human moved
  to another screen meanwhile (`RarogNavigation.screenRevision`). A core signal becomes a toast ONLY when another
  session stands in the right column; it goes away after 6 s or when the human reaches that session. Tests:
  `ToastLifecycleTests`, `SessionToastTests`, `ToastUITests` (column axis ±1 pt).
- **Windows, popovers and forms (`Views/Presentation/`):** every presentation is a popover (at a control: git,
  background, model, prompts), a form (typing or creating: new session, recent sessions) or a window (large content:
  terminal, lazygit, history, diff, transcript text). `SheetScaffold` (`WindowSheet`) gives a `NavigationStack`, the
  close button on the LEFT, the window title in `.principal`, an achromatic tint, Esc and Cmd+W; `FormSheet` does the same for forms
  (`locked` blocks closing during a request). Popovers (`popoverLayout`) are 320/420/560 pt wide and up to 600 pt
  tall, and stand on a plain `surface` (`popoverSurface()`, `PopoverChrome`), not on system glass, because glass over
  the dark transcript gives a gray blur and lowers contrast (guard `PopoverSurfaceSourceTests`). One sheet at a time:
  windows and forms are one state `RarogNavigation.sheet` (`Model/AppSheet`) and one `.sheet(item:)` on the root
  (`Views/Presentation/SheetHost`); a window replaces a window, a form holds; a screen change closes a window, not a
  form; logout removes every sheet. `SheetKeyboardAnchor` takes the keyboard for a window and hands it back. A page
  pushed in a sheet takes the keyboard with its own anchor, because the page under it leaves the window; an anchor
  that takes the keyboard from another anchor keeps the responder that anchor remembers (the field under the sheet),
  so closing the sheet from a page gives the keyboard back to that field. An anchor coming back into the window
  after a pop keeps the responder it remembered while that one is still on screen, so whoever held the keyboard on
  the page above (a shortcut row listening for keys) does not take its place (`SheetKeyboardAnchorTests`). Guard
  `PresentationSourceTests`; tests `AppSheetTests`.
- **Settings** (`Views/Settings/`, the page state and the routes from outside the sheet in `Model/SettingsPage`):
  `SettingsSheet` is the list and binds the pages with one `navigationDestination(item:)`; the Server, Pairing and
  About pages have their own files there, and the Dictation, Voice Agent and Text Size pages live in their areas
  (`Views/Dictation/`, `Views/VoiceAgent/`, `Views/TextScale/`). The row data are plain types without SwiftUI
  (`SettingsHubRows`, `ServerRouteRows`, the model part of `RelayRegistrySection`), so `swift test` checks them on
  macOS (`SettingsHubTests`, `ServerRouteRowsTests`, `RelayRegistrySectionTests`); the screen is described in
  `native/Rarog/docs/app-target.md`, the "Settings" item.
- **Message field files:** `Session/ComposerView.swift` (the card, its layout and state), `ComposerTextView.swift`
  (the text view and its keys), `ComposerView+Suggestions.swift` (slash command suggestions) and
  `ComposerView+Attachments.swift` (the strip, its sources and the paper clip menu).
- **Field controls** (`ComposerView`, `ComposerActionBar`): paperclip, pills, on the iPhone a hide keyboard button
  while the field has focus, the dictation microphone, Send. There is no separate Stop: `SendButton` has the modes
  `.send` and `.stop(enabled:)`, `+Interrupt` sets the mode at every render, and a tap uses the mode from the moment of
  TOUCH (`SendButton.actionMode`), so a gesture started on Send never ends as Stop. Hardware Enter stays with
  `onSend`, so it never interrupts on an empty field.
- **Attachments** (`Session/Attachments/*`): limits after base64 (`AttachmentRules`), an image becomes a JPEG of at
  most 2048 px through ImageIO (`ImagePreparer`, quality first, then pixels; a white background under transparency),
  sources are the paperclip (`PHPicker` without library permission, `UIDocumentPicker` with a copy), drag and drop
  onto the session screen and paste in the field. The session's shelf (`AttachmentShelf`) is the ONLY state of the
  strip: removal, sending and restoring are shelf operations. Working files live in `tmp/rarog-attachments`, cleaned
  at the first use in a process; the outbox gets copies (an APFS clone).
- **New Session form** (`Views/NewSession/*`, rules in `Model/NewSessionForm` and `Model/DirectoryBrowser`): sections
  Project (the project row with recent project pills from `RecentChips`, or the open directory browser), Start (mode,
  model and effort menus, the ultracode switch only for a model with `ModelChoice.ultracode`; it is off by default and
  not remembered, and when on it pins effort to `StartSettings.launchEffort` = xhigh; folded to one sentence while the
  browser is open) and Conversations (`ResumeRowView` in the `ResumeGroups` groups, the whole row is the target, Fork
  next to it). `DirectoryBrowser` owns the chosen directory apart from the browsed one: a row tap opens a directory
  (`enter`), Up goes to the listing's parent (`up`, `goUp()`), the browser changes the chosen directory only through
  `choose()` on the directory on screen (or `chooseAnyway()` after the warning), `cancel()` restores the previous
  one, and a listing that arrives late commits nothing. New Directory lives in `DirectoryBrowser+Create`: the field
  state (`DirectoryCreate`: name, sending, sentence) and the request go through the create action the sheet passes
  in (`RarogStore.createDirectory`), a late reply is dropped by the same request number as a listing, and a directory
  created in the form is chosen without the warning. Launch uses text ink; amber in this form means the auto mode
  and the warning before choosing a directory that is neither a repository nor has sessions. `NewSessionSheet` holds the
  state, the footer and the launch actions; each section is an extension in its own file (`NewSessionSheet+Project`,
  `+Start`, `+Conversations`), and the footer while browsing (hint, Cancel, Choose, the warning) is
  `NewSessionChooseBar`.
- **Prompt bar** (`Session/PromptBarView`, rules in `Model/PromptBar`): the prompt bubble's plate (a full
  `userPlate` background, no glass, `Radius.block` on the bottom corners) hanging from the header's edge, the
  transcript's side margin from the safe area (16 pt in Standard spacing), as wide as its content up to min(column −
  2 × that margin, the bubble's cap); the "Prompts in This Session" popover is a timeline, newest first.
- **Global shortcuts** (`Views/RarogCommands`): Cmd+1…9 for sessions and terminals, Cmd+L, Cmd+N, Cmd+Shift+N,
  Cmd+F, Cmd+G, Cmd+B, Cmd+I and the text size Cmd+=, Cmd+- and Cmd+0, published as a scene
  value (`focusedSceneValue`), so the tab number matches what the bar shows. Cmd+1…9 carries the tab id from the
  moment the menu was drawn. Cmd+X is not a menu command (the system Cut takes it) but a screen shortcut. Cmd+L
  accepts one call per 0.3 s (`acceptsPreviousProject`), because the menu can fire it twice in the same millisecond.
- **Changeable shortcuts** (`Model/AppShortcutSettings`, logic without UIKit; `Views/ShortcutSettings/`): the
  dictation and voice agent combinations chosen on the Settings pages of dictation and the voice agent
  (`ShortcutPageSection`), changed in the row (`ShortcutRowEditor`, the row's rules without UIKit;
  `ShortcutCaptureView`, the key receiver while the row listens), stored per device, checked before saving and read
  by `AppShortcut` (`native/Rarog/docs/rarog-ui.md`, the "Changeable shortcuts" item).
- **App text size** (`Model/TextScale`, logic without UIKit; `Views/TextScale/`): the step of Cmd+=, Cmd+- and
  Cmd+0 stored per device, put on the scene by `TextScaleSceneBinding`, the Shift+Cmd+= key on an invisible button
  (`TextScaleAlternateKeys`, at the root and in `SheetHost`) and the Text Size page of Settings
  (`TextSizeSettingsPage`; `native/Rarog/docs/rarog-ui.md`,
  the "App text size" item). Text style scaling for a system that gives every text style one size (the iPad app on
  a Mac) lives in `Theme/TextStyle/`: the size table (`TextStyleTable`), the path switch, metrics and UIKit fonts
  (`TextStyleScaling`), the SwiftUI font (`AppFont`, `.appFont(_:)`) and `@AppScaledMetric`; `.textScaleHost()`
  (`Views/TextScale/TextScaleHost.swift`, at the root and in `SheetHost`) puts the model's step on the views there.
  On an iPad and an iPhone each of them gives exactly the system's font or metric.
- **Transcript width** (`Model/TranscriptWidth`, logic without UIKit): Readable or Full Width stored per device, chosen
  in a section of the Text Size page and followed by the session screen (`native/Rarog/docs/rarog-ui.md`, the "Prose
  width" item).
- **Transcript spacing** (`Model/TranscriptDensity`, `Model/TranscriptSpacing`, logic without UIKit): Standard or
  Relaxed stored per device, chosen in a section of the Text Size page; one token table for the gaps and the side
  margin of both modes. The session screen applies it in `Session/SessionViewController+Spacing`
  (`native/Rarog/docs/rarog-ui.md`, the "Transcript spacing" item).
- **Session switcher** (`Switcher/`): only a tap on the current tab (`ProjectTabModel.tap`) opens a window in the
  center with the tabs of the current project in the order of the bar, sessions and terminals; the window has no
  keyboard shortcut and stays open until a row is picked or it is closed. `SessionSwitcher` holds the machine without
  UIKit (`SwitcherMachine`, rows and selection as `ProjectTabRef`; phases `idle` and `open`; `open` knows whether the
  window holds the keyboard; an opening needs a current tab and selects it; `tabsChanged` follows the bar while the
  window stands, the selection staying on its tab; moves at most every 100 ms), `SessionSwitcherRows` the rows from
  the bar's list (`RarogNavigation.stripTabs` → `SwitcherRows.rows`: tabs with a target only, a session row titled
  without the project or a terminal row) and the heading (`SwitcherRows.heading`: the project's name once, then the
  count), the jump goes through `RarogNavigation.openTab`,
  `SwitcherKeyResponder` the window's first responder (the `SheetKeyboardAnchor` pattern: it takes the focus only with
  a hardware keyboard, remembers the previous responder weakly and gives it back after any close without a jump),
  `SwitcherPresentationGate` keeps the tap silent while anything is presented, `SwitcherWatch` closes the open
  window when the scene goes inactive or a presentation appears (asked every 250 ms) and hands it a hardware keyboard
  connected while it stands (`GCKeyboardDidConnect` → `keyboardConnected`), and `SessionSwitcherOverlay` draws the
  window. With the window open, ↑/↓ (with or without Cmd) move the selection, Return goes, Esc and Cmd+. close, Tab
  is swallowed and other keys without Cmd (digits included) do nothing; Cmd+1…9 stay the menu's tab shortcuts, which
  close the window like the other menu shortcuts except text size; the window closes when another responder takes
  the focus. Esc guards in the field, the card and the terminal stay as a safety net (`SessionSwitcher.absorbsEscape`
  is true while the window is open).
- **Shortcut sheet (held Cmd)** (`ShortcutSheet/`, logic without UIKit): `CommandKeyEvent` turns a HID key usage
  (`GCKeyCode.rawValue`) into Cmd down or up with its side, or another key; Shift, Option and Control are other
  keys. `CommandHold` is the hold machine on a caller's clock: Cmd held alone for `CommandHold.threshold` (1.5 s)
  shows the sheet, if the window is the key window, the app is logged in, the session switcher is closed and the
  app does not run on a Mac. Any other key, before or during the hold, spoils the hold until every Cmd is released;
  releasing Cmd or another key hides a standing sheet. At the threshold and every 250 ms while the sheet stands the
  caller passes the keyboard's own word on whether a Cmd is down: no Cmd or no keyboard hides it and forgets the
  keys, as do the app going inactive, the window losing key status and the keyboard disconnecting (`reset`).
  `ShortcutSheetContent` lists five groups of rows (label, one or two combinations from `AppShortcut`, or ⌘1–8,
  ⌘9, ⌘C and ⌘V); a row whose feature is missing (`ShortcutSheetCapabilities`: notes, terminal, voice agent, iPad
  in regular width) drops. The group of the focus place (`RarogNavigation.shortcutSheetPlace`: a form or another
  sheet → windows, the terminal window or a terminal on screen → terminal, a session → message and voice) stands
  apart under "You're here"; the rest fills three columns. `ShortcutSheetTrace` writes the trace lines and splits a
  combination into key caps. In the app (UIKit): `HardwareKeys` holds the one `keyChangedHandler` subscription and
  passes `CommandKeyEvent`s to its listeners; `ShortcutSheetController` feeds them to the hold, asks it at
  `nextCheck` with `HardwareKeys.commandPressed`, resets it when the scene deactivates, the window resigns key or the
  keyboard disconnects, and puts `ShortcutSheetPanel` on the window (a subview over the sheets, like the pointer
  tip); `ShortcutSheetHost` wires it in `RarogRootView`.
