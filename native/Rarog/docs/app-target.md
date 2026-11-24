# The app (Rarog.xcodeproj)

Part of the app description: [native/Rarog/README.md](../README.md).

- **Project:** iOS 26, Swift 6 (default `MainActor` isolation in the app target), the SwiftUI scene lifecycle,
  `UIApplicationSupportsMultipleScenes = false`, automatic signing with the project's team (`DEVELOPMENT_TEAM` in
  `project.pbxproj`; `scripts/ios-build.sh` puts in another team from `RAROG_IOS_TEAM`). Groups synchronized with
  the `Rarog/` and `RarogUITests/` folders, local packages as dependencies, a shared `Rarog` scheme.
- **`RarogApp` wires up:** the terminal surface factory (`SwiftTermSurface.factory` from `RarogTerminal`, environment
  `terminalSurfaceFactory`; without it the terminal screen says the terminal is unavailable),
  `RarogStore.live(connector:…)` with `AppEnvironment.connector(coordinator:)` (the Keychain with the groups from
  Info.plist, the transports from `TunnelCoordinator`), `RarogRootView(...).id(store.interfaceEpoch)` (a separate
  store property, so the scene root does not recompute at every frame). The root's `.task` runs again whenever the
  root comes back (a full-screen cover over it closes, a new `interfaceEpoch`): the MetricKit subscriber and the
  network monitor start in its first run only, and `store.start()` takes effect once. The scene phase, the network
  change and `protectedDataDidBecomeAvailable` go to the coordinator first and then to the store (`setScenePhase`,
  `reconnectNow`, `protectedDataBecameAvailable()`), so a store request after coming back to the foreground sees the
  new scene; `NWPathMonitor` reports a change of status, interface types, `isExpensive` or gateways
  (`NetworkPathSnapshot` in `RarogTransport/Tunnel/`). Every changed report gets a `network: path …` line in
  `client.log` with the interface types and names and the gateway count, never an address; only a path with network
  and another status, other interface types or other gateways reconnects. A change of `isExpensive` alone only gets
  the line: on cellular it flips back and forth on the same interface. The MetricKit crash report →
  `reportUnhandled`. The device label is `iPad·Rarog` (`iPhone·Rarog` on the iPhone; pairing and the APNs
  registration), the user agent `RarogApp/<CFBundleVersion>`.
- **Notifications:** `@UIApplicationDelegateAdaptor(AppDelegate)`: the APNs token, the registration failure and the
  `UNUserNotificationCenter` delegate set in `didFinishLaunching` (the tap that launched the app reaches it too). The
  delegate uses the `completionHandler` variants: an async `didReceive` without isolation ends in SIGABRT (UIKit
  requires the main thread, measured on iOS 27). Everything goes through `PushInbox` to the store (whatever arrives
  before the store waits). `onOpenURL` with `rarog://session/<id>` takes the same path as a tap. A `device-paired`,
  `version-changed` or `weekly-limit` push in the foreground: `willPresent` returns `[.banner, .list, .sound]` (other
  kinds `[]`, `PushNote.showsBannerInForeground`); a tap, also after a cold start, goes `PushInbox.tapped` →
  `pushTapped` → `openSettingsScreen(_:)` (the "Pairing" page for `device-paired`, "Server" for
  `version-changed`; `RarogRootView` follows it with `openSettings(page:)`) or the session list (`weekly-limit`, the
  `rarog://list` path: `readyLink` → `navigation.openList()`).
  `PushRouting.inspect` reads the kind and target with the push key reader `AppEnvironment.keychain()`
  (`nonisolated`, because the delegate calls it off the main actor), so the test push toast and the foreground
  banners of these kinds work with a v3 banner also when the notification service extension
  did not fill in the content; a v3 the app cannot open goes to the core as
  `pushUnreadable`. Core adapters: `UIKitPushSystem` (`PushEnvironment.swift`; the APNs environment from
  `embedded.mobileprovision`, the simulator is `development`) and `UIKitBackgroundWork` (`BackgroundWorkUIKit.swift`;
  expiry closes the task by itself; work with `needsServer` is reported to the coordinator with its deadline, end and
  expiry, so the tunnel generation lives as long as that work). `Rarog.entitlements` with `aps-environment = development` needs the Push
  Notifications capability on the `ai.rarog.app` App ID (see "Installing on the iPad").
- **Live Activity:** `LiveActivityController` (`Rarog/LiveActivityController.swift`) is the `ActivityRequesting`
  adapter on `ActivityKit.Activity<RarogActivityAttributes>` (with the module named, because `RarogContract` has its
  own `Activity` type): `request(…, pushType: .token)` with `RarogActivityAttributes(serverSystem:)`, observing
  `pushTokenUpdates`, `contentUpdates` and
  `activityStateUpdates`, `end` and `update(_:alertConfiguration:timestamp:)` (no alert, the timestamp from the core)
  by id off the main actor (`Activity` is not `Sendable`). It hands the core the `content` (state and `staleDate`) of
  the Live Activity with a given id, and `ActivityAuthorizationInfo().frequentPushesEnabled` to `client.log`. The
  rules, including when and what the app writes, live in the core. `Info.plist` has `NSSupportsLiveActivities` and
  `NSSupportsLiveActivitiesFrequentUpdates` (a higher budget of urgent updates; the user can turn it off in
  Settings). The `RarogWidgets` target (`com.apple.product-type.app-extension`, `ai.rarog.app.widgets`, name "Rarog",
  embedded by the "Embed Foundation Extensions" phase) draws it: `ActivityConfiguration` with the views from
  `RarogActivity`, `widgetURL` from `LiveActivityPresentation.link` (the agent list, `rarog://list`), and numbers
  above zero are a `Link` to `rarog://jump/<kind>` (`jumpLink`, the `TallyLink` modifier; the app picks the first
  session of that kind from a fresh list, `AppState.firstSession`). No actions on this Live Activity.
- **Voice Live Activity:** `VoiceActivityController` (`Rarog/VoiceActivityController.swift`, built in `RarogApp`
  after the voice agent settings) shows the running voice conversation or message-field dictation under the
  locked-phone trial, through `ActivityKitVoiceActivities` on `ActivityKit.Activity<VoiceActivityAttributes>`:
  `request(…, pushType: nil)` with a relevance score of 100 (the board's content is built without one), `update` and
  `end(nil, dismissalPolicy: .immediate)` by id off the main actor. `RarogApp` installs the handler of its End
  button (`EndVoiceActivityIntent.handler`). `RarogAppIntents` (`Rarog/RarogAppIntents.swift`) and
  `RarogWidgetIntents` (`RarogWidgets/RarogWidgetIntents.swift`) list the package's `RarogActivityIntents`
  (`AppIntentsPackage`), so the intent is in the `Metadata.appintents` of the app and of the extension. The
  `RarogWidgets` extension draws it with `RarogVoiceActivity`: the views from `RarogActivity` on translucent black
  in the dark theme, like the board. Rules and lines: `docs/companion.md`, "Locked phone (trial)".
- **Live Activity layout:** `LiveActivityPresentation` composes the copy from state fields only (counters, usage,
  the Mac, project, run name, phase number and title; no content, tool, label or work time) and the machine word
  from the attributes (`LiveActivityPresentation(_:machine:)`, `context.attributes.machine` in the widget): the
  metrics line and the VoiceOver sentence say "Mac" or "VPS". Attributes stored before the field decode as `{}`,
  so the word is "Mac".
  - **Lock Screen** (`LiveActivityBoard`) on translucent black (`.activityBackgroundTint(.black.opacity(0.8))` in
    the widget) and always in the dark theme, light mode included, two columns: on the left a row of three counters (34 pt digits, the word
    inflected for the number) and a usage line with only the present windows (percentages bold in the threshold
    color, thresholds 60/90); on the right three vertical Mac bars (`LiveActivityMacBar`: CPU, RAM, disk; colors from
    `LiveActivityPresentation.macLevel`, CPU and RAM 60/80, disk 80/90; the list footer has its own `MacMetric`
    thresholds from `RarogContract`), as tall as the counters and usage pair. Digits and bars scale with the font like
    `.largeTitle` (`@ScaledMetric`). Below, up to two runs, each in one row (`LiveActivityWorkflowLine`: project and
    name, phase number and title, and a bar with one segment per phase; with the server's phase states each segment
    is a full capsule in the color of its state, see "Colors"), then "+N workflows" ("+1 workflow"). In
    silence (0/0/0, no runs) a line says the Live Activity goes away after 30 min of quiet. `isStale` swaps the usage
    line for a stale note with the time, and the Live Activity dims to 0.7.
  - **Dynamic Island:** expanded, the 5h and 7d limits in the top corners, the counters in one row and the runs at
    the bottom; compact, waiting and working on the left and the first run's progress ring on the right (without runs,
    waiting | working); minimal, the waiting count, or working without waiting sessions.
  - **Colors** from `PaletteTokens`: waiting `wait`, working and run bars `run`, finished `new`, usage from 60 % `wait`
    and from 90 % `err`, zero dimmed (`idleInk`). A run bar with phase states (`LiveActivityPalette.phase`): not
    started gray (white 0.28 on the dark Lock Screen, 0.26 on the Dynamic Island, black 0.20 in light mode), in
    progress `run`, finished `run` at 0.60 opacity; without phase states a segment fills with its percentage and the
    current phase has a brighter track. Height at most 160 pt (the system clips above): everything in one
    line, the Lock Screen font grows up to `.xLarge`, the Dynamic Island stays at `.large`; the tallest content with
    Mac bars is 155 pt on the Lock Screen at `.large` and 157 pt at `.xLarge` (gate `testBarsTileFitsAtMaxTypeSize`),
    the expanded Dynamic Island 134 pt, with stale data 153 pt.
- **Keychain:** `SystemKeychain` (`RarogTransport/DeviceKeychain.swift`) with the groups from Info.plist
  (`RarogKeychainGroup` = `$(AppIdentifierPrefix)ai.rarog.app`, `RarogKeychainSharedGroup` =
  `$(AppIdentifierPrefix)ai.rarog.app.shared`; an unexpanded variable means the process's default group). Two
  `kSecClassGenericPassword` items, `AfterFirstUnlockThisDeviceOnly`, no iCloud: the device key (service
  `ai.rarog.app.server`, account = host, or `iroh:<EndpointId>` for a server reached only over iroh, private group;
  JSON with the credential, its iroh pair and a copy of the push key) and the
  push key for the notification service extension (service `ai.rarog.app.push`, account = `kid`, shared group). The
  extension reads only the second item through `SharedPushKeychain` (`PushKeyReader`, no side effects), never through
  `DeviceKeychain`, because `load()` deletes an unreadable item and `delete` also deletes the shared item. The app
  reads the push key through the same protocol (`SystemKeychain.pushKey(kid:)`) and at a start with a key restores the
  shared item from the copy (`restoreSharedPushKey`; the same value means no write). Service names follow the app's
  bundle id. The new item is written first, then the items of other accounts are deleted (the app knows one server). A
  credential with neither an address nor a valid iroh pair is not saved (`errSecParam`). The groups
  need `keychain-access-groups` in `Rarog.entitlements` (the extension: only the shared group,
  `RarogNotificationService.entitlements`); the group prefix (`$(AppIdentifierPrefix)`) is the signing team id, so
  only builds of the same team see the items.
- **Voice agent:** its Settings row, consent page, conversation and `RAROG_UI_TEST_VOICE_AGENT=1` (the scripted
  conversation for UI tests) are described in `docs/companion.md`, "App".
- **Notification service extension:** target `RarogNotificationService` (`com.apple.product-type.app-extension`,
  `ai.rarog.app.notification-service`, name "Rarog", embedded by the same phase as the widget,
  `SWIFT_DEFAULT_ACTOR_ISOLATION = nonisolated`, because the system calls the extension off the main thread).
  `Info.plist`: `NSExtensionPointIdentifier` = `com.apple.usernotifications.service`, class
  `$(PRODUCT_MODULE_NAME).NotificationService`, `RarogKeychainSharedGroup`. It links `RarogContract` and
  `RarogTransport`. A v3 banner arrives with placeholder text and `mutable-content: 1`; `NotificationService` only
  glues: `PushServiceDecision.decide` (the key from `SharedPushKeychain`, now) → the title and body filled in and
  `rarogOpen = {kind?, sessionId?, termId?}` in `userInfo` (the `rarog` v3 block and `threadIdentifier` stay), or the
  original; `OnceHandler` hands over the content exactly once, also at `serviceExtensionTimeWillExpire`. The original
  stays for a plain v1, a missing key, a locked phone (before the first unlock the key is unreadable, deliberately), a
  wrong `kid`, an AEAD failure, plain text outside the contract and `now > exp + 300 s`. No logs: the content never
  leaves the banner. The app decrypts `rarog` v3 by itself when `rarogOpen` is missing (`PushRouting`, see above), so
  taps and toasts work also when the NSE did not finish. "Finished" (a badge only, without `mutable-content`) does
  not wake the extension.
- **Pairing screens:** the logged-out screen is `PairingStartView` (`RarogUI/Views/Pairing/`); the app has no token
  screen. Without a key it shows the pairing screen alone; after a 401 `device-revoked` it says when and by whom the
  device was revoked, with the pairing controls; after another 401 for the key it says the server did not recognize
  the device, with Try Again; during Forget Server it shows only a forgetting screen (`pair.forgetting`). Controls
  (`PairingControls`): Scan QR Code (VisionKit `DataScannerViewController` in place of the controls, not in a sheet;
  without a camera there is no button), I Have a Link (a field, the system `PasteButton`) and the "Pair with <host>?"
  card; for a link with only `k` and `r` it reads "Pair with iroh · <8 characters>?" with the full EndpointId below,
  to compare with `rarog pair`. While the relay has not admitted a freshly sponsored server yet (`waitingForRelay`,
  from the first pairing request on), the card says "Waiting for the relay to admit the server…" beside Cancel,
  which ends pairing; while the registry client prepares, and during a pairing request without a fresh sponsorship
  (`pairing`), it has no Cancel. Under the controls of every pairing variant stand three product links
  (`ProductLinksRow` in `RarogUI/Views/About/`): Privacy Policy, Set Up a Server and Support, opened by the system in
  the default browser; the addresses are `ProductLinks` in RarogCore. The Soniox console and OpenAI API keys pages,
  linked from the Dictation and Voice Agent setup steps, are `ProviderLinks` in RarogCore, outside the product domain.
- **Settings:** logged in, the gear in the list bar (`SettingsListButton`) opens `SettingsSheet` through `SheetHost`
  (`AppSheet.settings`; code in `RarogUI/Views/Settings/`). The sheet is a list of rows in cards without section
  headers (`SettingsHubRows`, drawn by `SettingsHubRowView`: an icon tile, the title, a muted subtitle or a trailing
  value, a chevron): "Server: <machine name>" (subtitle "Connection, this device, relay, forget server"; an amber dot
  and "Relay needs attention" while the registry state does not heal by itself, `RelayRegistryContent.needsAttention`:
  a refused registration, the clock, unreadable registry storage, a removal not saved or blocked by the admin),
  Pairing ("Pair New Device · N paired" with the server's device list, this device included; only with a paired
  server), Dictation ("<engine> · shortcut <glyphs>"), Voice Agent ("On · shortcut <glyphs>", "Off", or "Not set up"
  where the server answered without the voice agent; hidden in a build without Soniox and before the server's first
  answer), Text Size (the step's name or "System Size"), Language (`AppLanguageRow`: the current app
  language by its own name; a tap opens the app's page in iOS Settings, where the user changes it,
  `docs/localization.md`) and About ("Version <v> · support, licenses"). Without a server the server row is muted and
  does not respond, and Pairing is hidden. The subtitles follow a new shortcut or engine as soon as a page saves it.
  A row pushes its page in the same sheet; Back is the system's chevron in a circle, without a title. Esc and Cmd+W
  close the whole sheet from a page; on the shortcut recorder Esc goes back instead. The pages:
  - **Server** (`SettingsServerPage`): Connection (the machine and its name, then the routes from `ServerRouteRows`:
    the address, and an "iroh" row with the first 8 characters of the EndpointId for a server reached over iroh;
    both rows with both routes), This Device (Name, Device ID, Paired, Access by device key), the relay registry
    (`RelayRegistrySection`: a "This Device" row with the first 8 characters of the app's EndpointId, the app's
    status in the iroh relay registry with a hint, led by a warning glyph in the warning tone, and Remove Me from the
    Registry with a confirmation, hidden once the device has asked to leave and on a device that cannot register; the
    whole section is hidden while the registry client is inactive: no server on a relay of the registry map, or no
    app identity yet) and Forget Server with a confirmation. While forgetting, Back is hidden, so the page cannot be
    left halfway; a finished forget closes the sheet.
  - **Pairing** (`SettingsPairingPage`): Pair New Device with the code's states in place (issuing, a QR code from
    CoreImage with a countdown to the server's deadline from `TimelineView`, Share Link, New Code and Hide Code;
    expired; failed). The three buttons share one row on an iPad; on an iPhone (by device idiom, not by width) Share
    Link takes the full width with the other two below it. Below, the server's read-only device list with the
    footer "Revoke a device on the Mac: rarog devices." ("on the VPS" for a VPS server). Leaving the page revokes the
    code, also one still being issued, like closing the sheet.
  - **Dictation** (`DictationChoiceView` with the `settingsPage` presentation): the choice of the Dictation screen,
    without its lead sentence, and the Keyboard Shortcut section. The Soniox option carries its own server state, so
    the page has no separate server row.
  - **Voice Agent** (`VoiceAgentSettingsPage`): where the server offers the agent, the switch and its consent page
    (`docs/companion.md`, "Settings"), the switch of the conversation across sessions with its own consent page where
    the server offers that mode, and the Keyboard Shortcut section while the agent is on; otherwise the setup steps
    (same section).
  - **Text Size** (`TextSizeSettingsPage`): the seven steps (`native/Rarog/docs/rarog-ui.md`, the "App text size"
    item).
  - **About** (`SettingsAboutPage`): the same three links as the pairing screen, Report a Problem, Licenses and the
    version row "Version 1.0 (123)" from `Info.plist`. Report a Problem opens a `mailto:support@rarog.ai` message
    whose body ends with the line `Rarog <version> (<build>) · iOS <system> · <iPhone|iPad|Mac>` (`ProblemReport` in
    RarogCore); when no app accepts `mailto:` (Mail removed), the button opens the support page instead; Licenses
    pushes `LicensesView` with the `THIRD-PARTY-NOTICES` text shipped in the app.

  Settings open only after pairing, so before pairing only the three links are on screen. Every page carries its own
  `SheetKeyboardAnchor`, so the sheet keeps the keyboard on a page and closing it gives the keyboard back to the
  field under it, also after the shortcut recorder, whose capture view holds the keyboard instead of an anchor
  (`native/Rarog/docs/file-layout.md`, the "Windows, popovers and forms" item). The page is navigation state
  (`RarogNavigation.settingsPage`, `Model/SettingsPage.swift`): a tap on a `device-paired` push opens Settings on the
  Pairing page and on a `version-changed` push on the Server page, also over open Settings and over the pairing card;
  a pairing link opened by the system pops to the list, where its confirmation card stands at the top, and a new card
  wins over a push request that arrived with it (`SettingsRoute`, `followSettingsRoute`). A page change while another
  page stands goes in two steps, `nil`, a main queue turn, then the new page (`openSettings(page:)`), because
  swapping the destination value does not pop a deeper page (the shortcut recorder, Licenses, the consent page).
  Closing the sheet clears the page.
- **Pairing links:** the scan and the
  link field accept `rarog://pair#…` and `https://rarog.ai/pair#…` (another prefix is the `notALink` error).
  `onOpenURL` passes both to `PushRouting.link`: `rarog://pair…` and an `https` address with the host
  `PairingLinkWire.host` (any letter case) and the path exactly `/pair` go to the same confirmation card, or to the
  card with the link error; any other `https` address opens just the app. iOS hands the app the universal link
  `https://rarog.ai/pair#…` only through `applinks:rarog.ai` in `com.apple.developer.associated-domains` of
  `Rarog.entitlements` and the association file of `rarog.ai` that names the app; the entitlement needs the
  Associated Domains capability on the `ai.rarog.app` App ID (`native/Rarog/docs/installing.md`, "Installing on the
  iPad"). The link rules (fields, error codes, assembly) are `PairingLinkWire` in `RarogContract`, a
  mirror of `shared/src/pairing-link.ts` checked against the same manifest (`PairingLinkWireTests`); `PairingLink`
  takes the pairing target and the code from it: `u` alone is `.https`, `u` with the iroh fields `k` and `r` is
  `.both`, `k` and `r` alone is `.iroh`, and `k` or `r` without the other is a bad address error. The QR code and Share
  Link of Pair New Device carry the universal link `https://rarog.ai/pair#…` that `PairingLinkWire.link` builds.
  `confirmPairing()` sends `POST /api/pair` through `ServerConnector.pairing(target)` (`.https` over the address,
  `.iroh` and `.both` over a one-shot iroh connection to the link's EndpointId, which proves the server key) and
  saves the key with the address from `u` and the iroh pair from the reply, or from the link when the reply has none
  or a malformed one; `PairingLinkError.init(_:)` maps the contract codes to four screen sentences. The new device
  notice stands in the list's banner strip (`NewDeviceBanner`).
- **Data on the device: spaces per server (`ServerSpaces` in RarogCore, `AppEnvironment.spaces()`):**

  The app's iroh key is a third Keychain item next to the two under "Keychain": service `ai.rarog.app.iroh`, account
  `device`, the private group, `AfterFirstUnlockThisDeviceOnly`, no iCloud, JSON `{version: 1, secret, createdAt}`
  (`IrohIdentityStore` in RarogTransport). It is one per device and belongs to no server: written once before its
  first use and never rewritten, so the app's EndpointId survives re-pairing and Forget Server. A locked, unreadable
  or unsaved item means iroh is unavailable (a line in `client.log`), never a key held only in memory; HTTPS does not
  depend on it. Only the UI test reset deletes it.

  ```
  Application Support/servers/.current.json              pointer to the current space (JSON ServerSpace)
  Application Support/servers/<space>/outbox/             outbox
                                     /list/               list cache (sessions.json)
                                     /drafts/             field drafts with attachments
                                     /note-drafts/        note drafts
  Application Support/servers-trash/                      trash (emptied in the background and at start)
  ```

  A space name is a hash of the server identity (the normalized address, or `iroh:<EndpointId>` for a server reached
  only over iroh) plus a one-time suffix; the file `servers/.current.json`
  names the current one (an atomic file write, because `UserDefaults` persists with a delay, so a process killed right
  after the write could lose the pointer after the directory `rename`). `servers/` and the trash have
  `completeUntilFirstUserAuthentication` protection and `isExcludedFromBackup` (files inherit the directory's class,
  `ServerSpaces.prepare`). The app reads and writes a server's data only in the pointer's space.
- **Test mode (Debug builds only):** launch variables `RAROG_UI_TEST_BASE_URL=http://127.0.0.1:<port>` (the demo
  server's address; the app connects to it only through pairing: `DemoServer.pair` in UI tests takes a code from
  `POST /api/demo/pairing` and opens its fragment as a `rarog://pair#…` link, because the simulator has no association
  with `rarog.ai`), `RAROG_UI_TEST_RESET=1` (removes the device key and the app's iroh key, so the next start has a
  new EndpointId, from the Keychain, which survives a relaunch and a reinstall, the recorded revocation, the
  preferences space marker, the data spaces with the pointer and the trash, the server-dependent preferences, and
  `rarog.collapsedProjects`, `rarog.inspectorOpen`, `rarog.inspectorChangesCollapsed`, `rarog.inspectorWidth`,
  `rarog.listCollapsed` and the dictation choice `rarog.dictation.choice` from the
  previous run; the rest of `UserDefaults` stays), `RAROG_UI_TEST_THEME=light|dark` (an explicit theme for
  screenshots), `RAROG_UI_TEST_VOICE=1|denied` (the microphone, the Soniox stream and system speech recognition from
  the `ScriptedVoice` scenario; the key comes from the demo server), `RAROG_UI_TEST_VOICE_SCRIPT=en` (an English text
  of that scenario, for English screenshots; without it the scenario has its default Polish text in every
  app language), `RAROG_UI_TEST_HIDE_MODEL=1` (no model pill under the message field, for screenshots of demo
  sessions that name no model; `ModelPillModel.hiddenForUITests`),
  `RAROG_UI_TEST_DICTATION=none|system|soniox` (the dictation choice in memory, never in `UserDefaults`; without it
  `RAROG_UI_TEST_VOICE` means `soniox`),
  `RAROG_UI_TEST_PUSH=1` (the APNs channel faked on the app side: the demo has none, and the Turn On banner and the
  test push have to be clicked through) and `RAROG_UI_TEST_PROBE=1` (`Rarog/UITestProbe.swift`: a transparent window
  over the app with buttons that record the first responder and whether the system reports a hardware keyboard
  (`probe.inspect`), perform the Esc key command from the responder chain, which the simulator does not deliver
  (`probe.escape`), read the corner radius of the top presentation (`probe.corners`), and run the VoiceOver "back"
  gesture without VoiceOver (`probe.axescape`, `probe.axescapebar`); the result, class names and layout numbers only,
  stands in `probe.state`). A normal launch targets only the server from the device key.
- **Icon:** the Icon Composer document `Rarog/AppIcon.icon` in the synchronized `Rarog` group (no
  `AppIcon.appiconset`; `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon` names it). The drawing: Rarog, a falcon in the
  shape of `❯`, wings of three flame tongues, the head and inner tongues as one light shape, no glow. The background is
  the document fill, a flat `#13130F` (the ink of the rarog.ai hero), not a layer. The layers are flat SVGs on a
  1024×1024 canvas in `Assets/`, in two groups, top first: "Head" (`eye.svg` without glass, `head.svg` with the
  light gradient as the layer fill, opaque, neutral shadow) and "Flames" (`flame-inner.svg`,
  `flame-middle.svg`, `flame-outer.svg`, both wings of one tone per layer, translucent, shadow in the layer
  color). The system adds the Liquid Glass light and depth and computes the dark, tinted and clear looks; the document
  has no per-look overrides. `actool` makes the PNGs for the bundle. Edit it in Icon Composer (Xcode → Open Developer
  Tool) or in the files; a preview without the GUI, outside the sandbox (rendering needs the GPU):
  `"$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool" Rarog/AppIcon.icon
  --export-image --output-file icon.png --platform iOS --rendition Default --width 1024 --height 1024 --scale 1`
  (renditions `Default`, `Dark`, `TintedLight`, `TintedDark`, `ClearLight`, `ClearDark`).
- **Logo and launch screen:** `Assets.xcassets/RarogLogo.imageset/RarogLogo.svg` is the same icon flattened into one
  vector (background, the three flame layers, the head with its gradient, the eye; no glass and no shadow). It is the
  app's only branding: a 64 pt tile with continuous corners above the title of the pairing screen
  (`PairingStartView`), hidden from VoiceOver. A change of the icon layers goes into this file too. The launch screen
  carries no logo and no text (HIG "Launching"): `UILaunchScreen` in `Info.plist` shows only the `LaunchBackground`
  color from the catalog, and the first frame (`LaunchView`) shows the same background, so launch does not flash.
  `LaunchBackground` copies `PaletteTokens.background` in both modes; `LaunchBackgroundTests` (package `RarogUI`)
  fails when they differ.
- **The `done` chime:** `Rarog/skonczyl.caf` at the root of a synchronized group, so it lands at the root of the
  app, where a push looks up a sound by name (`"sound": "skonczyl.caf"`). The server plays it: for a sent `done` push,
  the Live Activity update carries an alert with this sound (`server/src/notify/live-activity.ts`), only with a live
  Live Activity and notification permission. When Rarog is open on any device (presence), the `done` push stays silent,
  sound included. The app has no code for this: ActivityKit reads the alert. The server keeps the file name in
  `LIVE_ACTIVITY_CHIME` (`apns-payload.ts`), and a server test (`notify-apns-payload.test.ts`) checks that the file
  is here. Source: `hero_simple-celebration-01` from the Material sound resources (Google, CC BY 4.0, which requires
  attribution; attribution with changes: the entry in `THIRD-PARTY-NOTICES`). CAF Linear PCM 16 bit, 44.1 kHz,
  stereo, 1.5 s; volume −3.1 dB against the source (peak −11 dBFS, average −29.7 dBFS):
  `ffmpeg -i hero_simple-celebration-01.ogg -af volume=-3.1dB -ar 44100 -c:a pcm_s16le x.wav`, then
  `afconvert -f caff -d LEI16@44100 x.wav Rarog/skonczyl.caf`. iOS plays a notification sound for up to 30 s and
  uses the default sound for a longer one.
