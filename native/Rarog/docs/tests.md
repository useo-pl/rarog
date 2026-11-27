# Tests

Part of the app description: [native/Rarog/README.md](../README.md).

```
bash scripts/ios-check.sh                 # package swift test + XCUITest on the simulator + device build
                                          # + languages of the built app (scripts/ios-app-languages.sh)
RAROG_IOS_QUICK=1 bash scripts/ios-check.sh                       # quick: no XCUITest, no device build
RAROG_IOS_QUICK=1 RAROG_IOS_UI_TESTS=ProjectsUITests,PushUITests/testA bash scripts/ios-check.sh
pnpm run check                            # repo gate; the swift-contract step = RarogContract on golden frames
bash scripts/ios-test.sh RarogUIKitTests/HeaderChromeTests  # selected tests, next to a gate (below)
```

`ios-check.sh` and `pnpm run check` run outside the Claude Code sandbox, because the Swift caches live in the
system temporary directory. The scripts set `DEVELOPER_DIR` themselves when `xcode-select` points at
CommandLineTools, which lacks the Swift Testing macros.

**Which tests when.** The full gate takes over an hour; most of it is XCUITest, because every test launches the app
and pairs it with the demo. During work you pick tests explicitly: the classes the change touches, plus the tests of
the packages that depend on the changed one (from the packages' `Package.swift`, transitive dependencies included).
Changed package → package tests to run with it:

- `RarogContract` → all packages;
- `RarogTransport` → `RarogCore`, `RarogUI`, `RarogTerminal`, `RarogIroh`;
- `RarogCore` → `RarogUI`, `RarogTerminal`;
- `RarogUI` → `RarogTerminal`;
- `RarogActivity` → `RarogCore` (its tests only).

The app (`Rarog.xcodeproj`) depends on all of them. The quick gate (`RAROG_IOS_QUICK=1`) is
NOT a selective mode: it runs every package and all of UIKit, picks only the XCUITest classes (`RAROG_IOS_UI_TESTS`),
and its result says "quick gate green — NOT full". The full gate runs once, before merging, and only when the change
touches the contract (`shared/src/protocol.ts`, `RarogContract`) or code shared by many screens.

**Selected tests next to other sessions.** Selected tests do not wait for the full gate's lock (below); they run next
to it, on their own resources. `scripts/ios-test.sh` runs exactly the tests you name and never picks any itself
(without arguments it refuses):

```
bash scripts/ios-test.sh RarogUIKitTests/HeaderChromeTests         # UIKit class, own simulator (template clone)
bash scripts/ios-test.sh RarogUITests/FlowUITests/testPairListTranscriptSendEcho  # XCUITest, fresh demo server
bash scripts/ios-test.sh RarogTerminalTests/SwiftTermSurfaceTests  # UIKit tests of a package (package scheme)
bash scripts/ios-test.sh --package RarogUI --filter CardsTests     # swift test of a package on macOS
bash scripts/ios-test.sh --build                                   # only the app build for the simulator
```

Several `<target>/<Class>[/<test>]` items go into one run; a target alone (a whole test bundle) is refused. The script
runs outside the Claude Code sandbox, like the gate. What it does, and what a hand-written command needs too:

- a package: `RAROG_COPY_LANGUAGE=pl DEVELOPER_DIR=<full Xcode> xcrun swift test --package-path
  native/Rarog/Packages/<Package> --filter <Class>` (`--force-resolved-versions` when the package has a
  `Package.resolved`). The full Xcode directory for `DEVELOPER_DIR` comes from the shell function
  `rarog_xcode_developer_dir`: `source scripts/xcode-toolchain.sh`, then `DEVELOPER_DIR="$(rarog_xcode_developer_dir)"`
  (exit code 1 and no output when there is no full Xcode). Without `RAROG_COPY_LANGUAGE` the test process crashes at
  its first copy lookup (`preconditionFailure` in `CopyLanguage.current`, with a message that names
  `RAROG_COPY_LANGUAGE=pl`; see `docs/localization.md`, "Tests"). The test process locale is `pl_PL` whatever the
  Mac's region, and a test of another region or time zone passes `locale:` and `timeZone:` explicitly.
  `RarogContract` builds its server sentence catalog into `RarogContract_RarogContract.bundle`, which every package
  that depends on it builds too; `ServerCatalogTests` formats from those resources. The script passes no
  `RAROG_DEMO_PORT`, so the package flow tests skip themselves (they run in the full gate, or by hand: "Demo server
  for the gate" below);
- the simulator: one `xcodebuild test` per scheme with `-only-testing:<target>/<Class>`, `-destination id=<udid>` of
  a simulator of the run's own (type `RAROG_IOS_SIMULATOR`, by default the gate's `iPad Pro 11-inch (M5)`), which it
  shuts down and deletes at the end, also after a red or interrupted run; other simulators stay untouched. That
  simulator is a clone (`xcrun simctl clone`) of a template, one per device type and newest iOS runtime, named
  `rarog-ios-test-template-<runtime>-<device type>` and shared by all worktrees. A clone of a template that has
  booted once skips the first boot of a new simulator, the slowest start. The first run that finds no
  template creates it under the lock `$TMPDIR/rarog-ios-test/template.lock` (a second run waits for it): it creates
  `rarog-ios-test-<pid>-template`, boots it until `xcrun simctl bootstatus` ends, shuts it down, and only then gives
  it the template name, so a template under that name has always booted once. With no template (no iOS runtime, a
  failed first boot) or a failed clone, the run creates a new simulator (`xcrun simctl create`) and says so in one
  line. Before the tests the run boots its simulator (`xcrun simctl bootstatus -b`, at most `RAROG_IOS_BOOT_LIMIT`
  seconds, 300 by default) and prints
  `== time: simulator boot: <N> s`; a boot that does not finish is not an error, since `xcodebuild` boots the
  simulator itself. The template stays; delete it with `xcrun simctl delete <udid>`. Every `xcodebuild test`
  gets the `RAROG_XCODE_PACKAGE_ARGS` flags, `-testLanguage pl -testRegion PL`, `-collect-test-diagnostics never` and
  `-test-timeouts-enabled YES -default-test-execution-time-allowance 300`, the same per-test limit as the gate ("Hung
  run" below). For UIKit tests the `Rarog` scheme sets `RAROG_COPY_LANGUAGE=pl`; a package scheme (`xcodebuild test
  -scheme RarogTerminal`, run from the package directory) does not, so the script exports
  `TEST_RUNNER_RAROG_COPY_LANGUAGE=pl`;
- DerivedData: one fixed `-derivedDataPath` per worktree, `$TMPDIR/rarog-ios-test/<worktree directory>-<hash of its
  path>/` with `app/` for the app and `<Package>/` for a package scheme, so the next run in the same worktree builds
  incrementally. It is never in `/tmp` and not in the repo. Its `worktree-path` file holds the worktree's full
  path. `--build` builds into the same `app/`
  (`-destination "generic/platform=iOS Simulator"`), without a simulator;
- XCUITest (`RarogUITests`): a fresh demo server on a free port from 18940–18989, never 8930 (the live Rarog) and
  not 18931, which the full gate takes. The run first reserves the port for itself: it creates the directory
  `$TMPDIR/rarog-ios-test/ports/<port>` with `mkdir`, which only one run wins, writes its pid there and removes it on
  every exit. A port reserved by a live run is skipped; a reservation whose pid is dead is taken over. The server
  starts through `scripts/ios-demo.sh` (`env -i` with an explicit variable list, see "Demo server for the gate") with
  a data directory under that DerivedData directory. The run waits until its own server process is alive, `/health`
  answers and the port's listener belongs to that process tree; an own server that exits first (say, the port was
  taken meanwhile) loses its port, and the run tries the next one, at most three times. The port reaches the tests
  as `TEST_RUNNER_RAROG_DEMO_PORT` exported in the environment of `xcodebuild` (passed as an argument, it becomes a
  build setting, and the flow tests skip themselves). The host push relay (`scripts/ios-push.sh`) runs for the run's
  simulator. At the end the run stops only its own demo and relay, then frees the port reservation;
- output and limits: the full log goes to `<step>.log` in that DerivedData directory and stays only after a failure,
  whose message prints its path. The screen shows failed and skipped tests, errors and one result line with the
  number of tests that ran. A filter that ran no test is a failure ("no tests ran", exit code 1), not green. Each
  `xcodebuild` or `swift` command stops after `RAROG_IOS_TEST_LIMIT` seconds (3600 by default) with exit code 124.
  Stopping an own process, at the limit and at exit, sends SIGTERM to its process tree and SIGKILL after 5 seconds
  to whatever of that tree is still alive, so a process that ignores SIGTERM cannot keep the simulator and the demo;
- a failure: repeat only that test. Check an XCUITest failure first on the gate's simulator type (`iPad Pro 11-inch
  (M5)`, `RAROG_IOS_SIMULATOR`), and establish a regression by comparing with `main`, not from a single failure.
  First shortcut of a process: each app process starts without a hardware keyboard, and XCUITest connects one only
  around each key. On a simulator that has already received a key from XCUITest (the full gate, a whole class), the
  first Cmd+B, Cmd+I or Cmd+U of a new app process never reaches the app (`UIApplication.sendEvent(_:)` gets no
  press), so its menu command does not run; other first keys (Cmd+L, Cmd+J, the right arrow, Option+Cmd+I) and any
  key after a delivered one arrive. The `UIMainMenuSystem` setting `textFormattingPreference = .removed` does not
  change this, and where the key is lost is not established. So a test sends an idle right arrow, with no text
  field focused, before its first shortcut in every app process; `InspectorUITests` does it in
  `launch(shortcuts: true)` and `relaunch`. A lone Shift is not enough: it is sometimes lost too. Only tests with
  shortcuts do it, because a delivered key changes layout: with it the diff window of
  `testLongFileCollapseAndShrinkKeepWindowContent` pins the file header 44 pt higher.

**Queue.** Several gates at once (from different worktrees) overload the Mac: XCUITest slows down several times,
fails on timeouts, and the failures need repeating. `ios-check.sh` therefore waits for its turn on a lock shared by
all worktrees (`/tmp/rarog-ios-check.lock`, `RAROG_IOS_LOCK`); it reports every minute whom it waits for, and fails
after `RAROG_IOS_LOCK_WAIT` (2 h by default). It takes over the lock of a gate whose process is dead. Tests of the
queue and the quick gate: `server/test/scripts-ios-check-demo.test.ts`.

**Hung run.** After a failure `xcodebuild` collects simulator diagnostics by default, for up to 10 minutes, so
`xcodebuild test` runs with `-collect-test-diagnostics never` and the full log goes to a file; the gate shows the
result lines and prints the log path on failure. A log that does not grow for `RAROG_IOS_SILENCE` seconds (600 by
default) ends the gate's own `xcodebuild` (SIGTERM, then SIGKILL after `RAROG_IOS_KILL_GRACE` seconds, 10 by
default) and the gate with exit code 124, at once. Any other failure on the simulator or in the build does not stop
the gate: the remaining steps run (RarogTerminal tests, device build), the result lists the red steps, and the exit
code is the first failure's.

The silence guard does not catch a test that hangs on 60 s steps ("App animations complete notification not
received"), because `xcodebuild` writes a line at every step and such a test can stand for tens of minutes. So every
`xcodebuild test` of the `Rarog` scheme also has a per-test limit, `-test-timeouts-enabled YES
-default-test-execution-time-allowance 300` (about 3× the longest healthy XCUITest). A test over the limit fails with
"Test exceeded execution time allowance of …"; XCTest takes a spindump, restarts the test process and moves on, and
`xcodebuild` ends with code 65. The limit rounds up to a full minute, and `-collect-test-diagnostics never` does not
turn off the spindump. Exception: `TreeListAnchorTests` (UIKit) sets `executionTimeAllowance = 600` in `setUp`,
because its healthy anchor test takes about 150 s and its measuring loops slow down under load. The 60 s steps also
happen on an idle Mac and in full-screen mode; their cause is unknown.

**Waiting for an element.** XCUITest waits through `waitForAppearance(timeout:)` from `DemoServer.swift`, never
`waitForExistence(timeout:)`: the latter checks the element for the first time only after at least 1 s, even when it
is already there. A test reads the frame of an element that may still be moving (a panel animation, the keyboard,
the suggestion list) after `DemoServer.waitUntilStill(_:)`. The guard `server/test/native-ui-test-waits.test.ts`
fails on any use of `waitForExistence` in `RarogUITests` outside the helper.

**App window in the simulator.** iPadOS 26 lets you drag the app out of full screen by the window's top bar.
SpringBoard remembers that window size and opens the app as a floating window from then on, also after a relaunch,
a simulator restart and an uninstall. XCUITest then computes frames in a smaller, shifted window and fails far from
the cause. Two rules:

- the tab bar scrolls with `DemoServer.dragTabs` (a finger along the lower part of the bar), never `swipeLeft()` on
  `tabs.bar`: the bar's frame reaches up to the top of the window, so that gesture starts on the navigation bar and
  moves the window;
- before XCUITest the gate shuts the simulator down and deletes Rarog's remembered window size from its app state
  database (`sim_window_reset` in `ios-check.sh`; key `SBApplicationLastWindowSizePerDisplayOrdinalKey` in
  `Library/FrontBoard/applicationState.db`). This is a private system database: when it is missing or has another
  schema, the gate carries on and says so in the result.

**App identity: one source in the scripts, and a guard.** The app's bundle id (`ai.rarog.app`) for the iOS scripts
lives in one file, `scripts/ios-identity.sh` (`IOS_BUNDLE_ID`). It holds assignments only (no Xcode, no `ios_die`, no
output), so it can be sourced under `set -euo pipefail`. `ios-lib.sh` (build and install; the file is also on the
`ios_scripts_clean` key script list) and `ios-check.sh` (the `simctl push` relay, the window size reset) read it, and
the script tests take the value from it instead of a literal. `server/test/product-identity-guard.test.ts` in
`pnpm run check` keeps the identity sources in step: the bundle id of the `Rarog` target, the widget and notification
extension ids under it, the push relay topic (`APP_TOPIC` in `relay/src/identity.ts`, `RELAY_APP_TOPIC` in
`shared/src/relay.ts`), the display names against `app.appName`, the URL scheme across
`PushRouting`, `LiveActivityPresentation`, `PairingLinkWire` and the server's `PAIRING_LINK_SCHEME`, and the Keychain
groups. Changing one source without the others fails the test with the values and their `file:line`. The negative
half of the guard (the old product name in user-facing text) is described in `docs/localization.md`, "Guards". UI
tests open app URLs only through the `rarog://` scheme.

**Demo server for the gate.** `ios-check.sh` starts a fresh demo server on `127.0.0.1:18931` for the run
(`RAROG_IOS_DEMO_PORT`; a port taken by any service is an error, 8930 never). Package integration tests get the port
through `RAROG_DEMO_PORT` and change the seeds, the demo sessions the server creates at start (`RarogCore` sends a
message to the first sendable session of the list). XCUITest expects untouched seeds, so before `xcodebuild test`
the gate stops its demo, waits up to 5 s for the port, and starts a second fresh demo with a new data directory;
XCUITest gets the same port through `TEST_RUNNER_RAROG_DEMO_PORT`. That demo serves every XCUITest class of the run,
and a seed changed by one class stays changed for the next ones. So the `FlowUITests` test that no key approves a
card uses a card of its own session from the demo control (`/api/demo/control`, scenario `permission`), not the seed card
of `demo-willow`: the test denies its card at the end, and `HeaderChromeUITests`, which runs after it, measures the
amber tab of `demo-willow`, which waits for a permission. The server starts
through `scripts/ios-demo.sh` with `env -i` and an explicit variable list (no inherited `RAROG_MIN_CLIENT_BUILD` or
`RAROG_IROH`), and cleanup stops only its own process tree (`server/test/scripts-ios-demo.test.ts`, phase order in
`server/test/scripts-ios-check-demo.test.ts`). Without `RAROG_DEMO_PORT`, the package flow tests skip themselves.
Manually (port 18931 only when no full gate is running; next to a gate, take another free port):

```
P=18931; D=$(mktemp -d "$TMPDIR/rarog-demo.XXXXXX")
RAROG_DEMO=1 RAROG_PORT=$P RAROG_ORIGINS=http://127.0.0.1:$P RAROG_DATA_DIR=$D pnpm run demo:server &
RAROG_COPY_LANGUAGE=pl RAROG_DEMO_PORT=$P swift test --package-path native/Rarog/Packages/RarogTransport
RAROG_COPY_LANGUAGE=pl RAROG_DEMO_PORT=$P swift test --package-path native/Rarog/Packages/RarogCore  # pairing → echo
```

Never port 8930 (the live Rarog). At the end the gate builds for the device (`generic/platform=iOS`) without
installing anything: unsigned by default (automatic signing needs an Apple account signed in to Xcode, otherwise
xcodebuild ends with "No Accounts"), signed with `RAROG_IOS_SIGN=1`; `RAROG_IOS_SKIP_DEVICE=1` skips it.

**What the tests cover.** The test name says the area; the class's own doc comment says the scenario. The groups:

- packages, `swift test`: logic of each package (reducers, outbox, transport, copy catalogs, markdown, models),
  among them the rule that keeps a running recording in the background (`BackgroundRecordingTests` in RarogCore),
  the background rule of a voice conversation (`VoiceAgentWatchTests`) and
  the locked-phone monitor's hold, heartbeat and lines on a manual clock (`LockedPhoneMonitorTests`, with the store's
  question to the server in `StoreLockedPhoneTests`), what the app's microphone reports for the voice Live Activity:
  a conversation's phase from its status and a waiting prompt, and the session it names by project and name, never
  by a prompt's text (`DictationCenterTests`, `VoiceAgentInboxTests`,
  `VoiceAgentSessionsConversationTests`), and the activity's state, which encodes only its kind, phase, scope, start
  time and the session's project and name cut to their ceiling (`VoiceActivityAttributesTests`), and its words,
  subject line, VoiceOver label, colour of each phase and glyph (`VoiceActivityPresentationTests`);
- `RarogUIKitTests`: a separate XCTest target without the production app host, for real view controllers and
  layout (`ComposerPrimaryButtonTests`, `InspectorWidthTests`, `TreeListAnchorTests`, `LiveActivityViewTests`, which
  renders the Live Activity views in both themes and writes PNGs with `TEST_RUNNER_RAROG_LA_SNAPSHOT_DIR=<dir>`;
  `VoiceActivityViewTests`, which keeps the voice Live Activity's Lock Screen tile under 90 pt at the default type
  size (also with names at their ceiling and a waiting prompt), stops it growing past its type limit, checks the
  phase's colour and writes the tile of each state with
  `TEST_RUNNER_RAROG_VOICE_LA_SNAPSHOT_DIR=<dir>`;
  `ListFilterBarTests`, which writes the stacked list under the Needs You segment and, in the light theme, a result
  the voice agent picked up between a fresh and a read one with
  `TEST_RUNNER_RAROG_LIST_SNAPSHOT_DIR=<dir>`, a phone picture with `RAROG_IOS_SIMULATOR="iPhone 17 Pro"`;
  `VoiceAgentSessionsBarTests`, which checks the lit circle in the list bar, in the session header and in the
  Inbox's header by its pixels (the state's tone, a bar in the background colour, on iPhone, in the iPad list column,
  in the session header with the list column hidden and on the Inbox at the root of the iPhone's stack), that the
  Inbox's circle ends the owner's conversation, that from the Inbox to a session opened from a card and back one
  circle and one prompt card stand, that the end sentence stands in one line above the session screen and the Inbox
  and a tap removes it, that the screen does not move while the conversation only runs, and that a long title keeps
  the header's icon group with the circle out of the bar's overflow (an iPhone test, skipped elsewhere: run it with
  `RAROG_IOS_SIMULATOR="iPhone 17 Pro"`), and writes the voice conversation across sessions (the lit circle in both
  themes, the iPad list column in each state, with a three-line and a 1000-character waiting prompt, the mode's
  consent page, the session screen's header and the Inbox on iPhone running, with a waiting prompt and after the
  end, and on iPad with the list column hidden and with both columns; the iPhone pictures with
  `RAROG_IOS_SIMULATOR="iPhone 17 Pro"`) with `TEST_RUNNER_RAROG_VOICE_SESSIONS_SNAPSHOT_DIR=<dir>`), and
  for app files it compiles itself (`membershipExceptions`: `TunnelCoordinator`, `TunnelTrace`, `RelayGates`,
  `VoiceActivityController` and others) with the fake tunnel from `RarogTransportTesting` (`TunnelCoordinatorTests`,
  `RelayGatesTests`, `SettingsSheetServerTests`) or a fake of ActivityKit and a real microphone center with
  recording places of the test's own (`VoiceActivityControllerTests`: the voice Live Activity's start, update and
  end, an update on a new phase or subject that keeps the timer, another kind that starts it anew, whether the
  background rule counts the tile as shown (granted, refused, removed), leftovers at launch, a refused request, the
  End button's handler and its lines);
- `RarogUITests` (XCUITest against the demo): `FlowUITests` (pair, list, transcript, send, decision cards),
  `CardsUITests`, `HeaderUITests` (status line, git, the diff window, the model pill), `ProjectsUITests`,
  `ProjectTreeUITests`, `QuestionUITests`, `MarkdownUITests`, `AttachmentUITests`, `VoiceUITests`,
  `CommandSuggestionsUITests`, `AccessibilityUITests`, `InspectorUITests`, `AboutUITests` (Settings → About: the
  version row and the Licenses page), `WindowsUITests` (the app gets a fake
  terminal through `RAROG_UI_TEST_FAKE_TERMINAL=1`; its `testMeasure` runs only with `RAROG_E0_MEASURE=1` and writes
  `pomiary-ipad.txt` or `pomiary-iphone.txt` to `RAROG_SCREENSHOT_DIR`), `PushUITests`, `PairingUITests`,
  `LiveActivityUITests`, `EnglishSmokeUITests` (the app in English: pairing, the list, Settings, a permission card),
  `AcceptanceUITests` (drives the demo through `/api/demo/control`; `server/src/demo/control.ts` serves that route
  only in demo mode and only to a loopback connection with an allowed `http:` origin and the header
  `X-Rarog-Demo-Token: demo`);
- screenshots for visual review: `ScreenshotUITests`, `ListScreenshotUITests`, `FramesScreenshotUITests`,
  `PadFramesScreenshotUITests`, `FooterScreenshotUITests`, `AcceptanceScreenshotUITests`, `GlassScreenshotUITests`,
  `EnglishScreenshotUITests` (key screens in English; `RAROG_SCREENSHOT_PSEUDO=double` or
  `nonlocalized` adds a Foundation pseudo-language, `docs/localization.md`, "Tests"), and the screenshot-only tests
  `WorkflowPanelUITests.testScreens*` and `InspectorUITests.testScreens*`; each is skipped without
  `RAROG_SCREENSHOT_DIR`.
  `ScreenshotUITests` and `ListScreenshotUITests` leave `<name>.request` in that directory and wait for
  `<name>.done`, which a script outside the repo writes after `xcrun simctl io <udid> screenshot`. Theme and text
  size are set before the run (`xcrun simctl ui <udid> appearance dark`, `… content_size …`). The iPad landscape
  case (below) uses `scripts/ios-shots.sh` instead;
- the contract: `GoldenFramesTests` reads `shared/fixtures/sse/manifest.json` and the frames straight from the repo
  (`RarogContractFixtures`, path from `#filePath`), and an `ok` frame must survive a round trip: a field the Swift
  types do not know drops out when encoding and the test names its path, so a new field in a server frame needs the
  same field in the Swift type in `RarogContract`. `RestFixturesTests` reads `shared/fixtures/rest/`
  (`everySchemaHasSwiftType`: every schema name in its manifest needs a Swift type). `RequestFixturesTests` goes the
  other way: it encodes the app's request bodies into
  `shared/fixtures/requests/` (refresh with `RAROG_FIXTURES_WRITE=1 RAROG_COPY_LANGUAGE=pl swift test`), and
  `shared/test/request-fixtures.test.ts` reads them with the server's schemas. `ApnsFramesTests` reads the full APNs
  frames the server produces (`shared/fixtures/apns/`, `shared/fixtures/apns-v3/`): the Live Activity frame through
  the production `LiveActivityPayload`, the banner frame through the production `PushCrypto` with the frames' test
  key; `encodesBackToFrame` compares `aps.content-state` from the file with the re-encoded state, so a server field
  unknown to Swift fails the test.

`RarogTerminal` is tested in two places: `swift test --force-resolved-versions` on macOS (needs the Metal
Toolchain) for the SwiftTerm core on synthetic bytes, grid edge reading and the Kitty file graphics filter; and its
UIKit part (`SwiftTermSurfaceTests` and neighbours: surface, paste, key repeat, selection, parking) through
`xcodebuild test` with the package scheme, on the same simulator right after the app tests. A local package's test
target added to the `Rarog` scheme is skipped by xcodebuild ("isn't a member of the specified test plan or scheme").

**What the simulator cannot test.** These parts are checked by package tests and by hand on the device:

- Esc and Full Keyboard Access: the simulator does not deliver Esc to the app, and its focus system does not react
  to keys from XCUITest; Return does not reach a screen without a text field (digits do);
- the pointer: `hover()` gives no pointer state in the iOS 27 simulator, so pointer tests end with an explicit skip;
- the on-screen keyboard: the simulator usually reports a hardware keyboard, and with the on-screen keyboard raised
  it uses the first hardware key to switch keyboards;
- the notification service extension (Xcode 27, iOS 27.0): `xcrun simctl push` with `mutable-content: 1` goes
  through the simulator bridge straight into the notification pipeline and never starts `RarogNotificationService`,
  so `PushServiceTests` and the device check the extension, and push XCUITests send a plain `rarog` v1 block. The
  real push comes from the HOST: during XCUITest `ios-check.sh` runs the relay `scripts/ios-push.sh`, the test puts the
  payload as `<name>.request` in `TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR` and waits for `<name>.sent`
  (`server/test/scripts-ios-push.test.ts`);
- notification permission: without it `simctl push` ends with "Source is not authorized". On a freshly erased
  simulator `notificationSettings()` hangs for about 2 minutes after boot (iOS 27), so boot a new simulator and wait
  before the gate. On a simulator with a `pl-PL` system the permission button carries a Polish label the test does
  not know; switch it to English first (`simctl spawn <udid> defaults write "Apple Global Domain" AppleLanguages
  -array en` and restart the simulator);
- the QR scanner (VisionKit has no camera there) and the Live Activity on the iPad lock screen, which XCUITest
  cannot reach;
- iPad landscape screenshots from XCUITest come out rotated and cut to 1032 pt (iOS 27 simulator). With
  `RAROG_SCREENSHOT_SYNC=1` (from the gate: `TEST_RUNNER_RAROG_SCREENSHOT_DIR=<dir>
  TEST_RUNNER_RAROG_SCREENSHOT_SYNC=1`) tests such as `WindowsUITests`, `InspectorUITests` and
  `GlassScreenshotUITests` leave `<file>.request` in the screenshot directory and wait. You start the Mac side
  yourself, in the background next to the gate: `bash scripts/ios-shots.sh <dir> [udid|booted] [limit in seconds]`
  (also `pnpm run ios:shots`) takes `xcrun simctl io <udid> screenshot` for each request, saves it as `<file>`,
  removes the request, and ends at a `stop` file in the directory or after the limit (2400 s by default).

**Terminal acceptance on the device.** No test replaces it: the demo has no terminal, the simulator reports a
hardware keyboard and does not pass Esc to the app, and it cannot reproduce sleep, network changes or a Magic
Keyboard. After a change in `RarogUI/Terminal/`, `RarogTerminal` or `TerminalSession`, go through each point once on
the iPad: lock for a minute and return (the screen repaints by itself, the prompt answers); Wi-Fi ↔ LTE (the
connecting notice goes away by itself); the on-screen keyboard raised and hidden (the key bar sits above it);
rotation (the prompt has no step); the Cmd+F and Cmd+G windows opened and closed (keys go back to the terminal); a
20 kB paste into `cat > /dev/null` without running a line, and three lines in the Claude Code field (they stay in
the field); fast finger scrolling in nvim and in lazygit.
