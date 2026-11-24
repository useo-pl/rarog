# native/Rarog: the native iOS and iPadOS app

The only client of the Rarog server and its contract. The product is called **Rarog**: bundle id `ai.rarog.app`, the
name under the icon and in the copy is "Rarog", and app links use the `rarog://` scheme. The directory, the targets,
the modules, the Xcode scheme and `PRODUCT_NAME` are `Rarog` as well.

**TLDR:** the server knows, the app draws. A change in Claude Code or herdr is a server change and a server restart,
not a new app version.

Read this before you change code in `native/Rarog/`, add a test there, or install the app on a device.

## Area documents

This file holds the package map, the external dependencies and the third-party licenses. Each area has its own
document in `docs/`:

- [Code rules](docs/code-rules.md): Swift 6 and isolation, tolerant decoding, authentication, client gates,
  terminal.
- [RarogCore: how state flows](docs/rarog-core.md): the reducer, `RarogStore`, outbox and sending, pairing, push,
  Live Activity, caches and memory limits.
- [RarogUI: how it draws](docs/rarog-ui.md): transcript, markdown, terminal screen, message field, colors,
  accessibility, cards and dictation.
- [Voice agent](../../docs/companion.md): the voice conversation in the session screen, its settings and UI tests
  ("App").
- [File layout and owners](docs/file-layout.md): seams per area and which files each area owns.
- [The app (Rarog.xcodeproj)](docs/app-target.md): project settings, app wiring, notifications, Keychain, data on
  the device, test mode, icon and sounds.
- [Tests](docs/tests.md): the gate, selected tests next to other sessions, waiting for elements, the demo server,
  coverage and acceptance on the device.
- [Installing on the iPad](docs/installing.md): build and install by cable or local network, push and Live Activity
  on a device.

## Principle: the app is the specification

The app is the only client of the server; there is no web front end. The product is specified by the app and by the
contract in `shared/src` (the protocol schemas and the reference decoder `decode.ts`).

## Structure

```
Packages/RarogContract    SSE and terminal frame types, REST, POST bodies, Live Activity state, decoder,
                          golden frames
Packages/RarogTransport   SSE parser, REST client (device key, Origin), Keychain for the device key and the push
                          key reader (`PushKeyReader`), v3 banner opening and the NSE decision
                          (`PushOpening.swift`), mutation gate, terminal socket, the iroh tunnel without IrohLib
                          (`Tunnel/`), the iroh relay registry client (`RelayAccess/`); library
                          `RarogTransportTesting` (fake tunnel and registry, tests only)
Packages/RarogCore        @Observable store, reducers, connection loop, compatibility, outbox, terminal
Packages/RarogUI          SwiftUI and UIKit, copy, presentation models; no domain logic
Packages/RarogTerminal    terminal renderer: SwiftTerm 1.19.0 behind `TerminalSurface` (the only SwiftTerm
                          import), fallback font with Nerd Font glyphs
Packages/RarogActivity    Live Activities: the sessions board and the voice recording (ActivityKit attributes, copy,
                          Lock Screen and Dynamic Island views), the voice recording's End intent
Packages/RarogIroh        iroh adapter: IrohLib 1.2.0 behind the tunnel protocols of `RarogTransport` (the only
                          IrohLib import), `IrohTunnelTransport` and `IrohSigner`
Rarog.xcodeproj           app `ai.rarog.app` (target Rarog), widget extension `ai.rarog.app.widgets` (target
                          RarogWidgets), notification service extension `ai.rarog.app.notification-service`
                          (target RarogNotificationService), XCUITest (RarogUITests, `ai.rarog.app.uitests`)
                          and UIKit tests (RarogUIKitTests, `ai.rarog.app.uikittests`); for scripts:
                          `scripts/ios-identity.sh`
Rarog/                    app code: App, delegate (APNs), configuration, system signals (network, MetricKit),
                          system adapters for the core (notifications, background work, Live Activity), the
                          voice Live Activity's controller (`VoiceActivityController`), icon,
                          translations of the usage texts (`InfoPlist.xcstrings`), the tunnel coordinator
                          (`TunnelCoordinator`, `TunnelTrace`), the relay registry gate (`RelayGates`,
                          `RelayAccessSetup`)
RarogWidgets/             WidgetKit extension: the aggregate Live Activity and the voice Live Activity
                          (`ActivityConfiguration`), own Info.plist
RarogNotificationService/ notification service extension (NSE): v3 banner title and body from decryption,
                          `rarogOpen`; own Info.plist (`NSExtension`, `RarogKeychainSharedGroup`)
RarogUITests/             UI tests against the demo server, plus screenshots on request
RarogUIKitTests/          UIKit tests on real views in the simulator (test process without `UIApplication`)
Info.plist                `CFBundleDisplayName` "Rarog", Keychain groups `RarogKeychainGroup` and
                          `RarogKeychainSharedGroup`, ATS `NSAllowsLocalNetworking`, one scene, English usage texts
                          for the microphone and speech recognition (dictation), the camera (pairing QR
                          scanner) and the local network (`NSLocalNetworkUsageDescription`, a direct iroh path
                          to a server on the same network), the build flag `RarogVoiceSoniox`
                          (`$(RAROG_VOICE_SONIOX)`), the `rarog://` scheme (`CFBundleURLTypes`, `CFBundleURLName`
                          `ai.rarog.app`), `NSSupportsLiveActivities` and `NSSupportsLiveActivitiesFrequentUpdates`
                          (guard `server/test/live-activity-plist-guard.test.ts`), the languages `CFBundleLocalizations`
                          (en, pl; the widget and the NSE declare the same) and `UIPrefersShowingLanguageSettings`
                          (`docs/localization.md`)
Rarog.entitlements        `aps-environment = development` (APNs sandbox), `com.apple.developer.associated-domains`
                          = `applinks:rarog.ai` (the universal pairing link `https://rarog.ai/pair#…`) and
                          `keychain-access-groups` (the app's private group `ai.rarog.app` and
                          `ai.rarog.app.shared` for the NSE); `CODE_SIGN_ENTITLEMENTS` of both configurations
RarogNotificationService.entitlements
                          `keychain-access-groups` = ONLY `ai.rarog.app.shared`: no private group (the NSE cannot
                          see the device secret) and no `aps-environment`
```

**App language** (`docs/localization.md`): texts live in the `Copy/Localizable.xcstrings` catalogs of RarogUI,
RarogCore and RarogActivity. The Swift registries (`RarogUI/Copy/UICopy*`, `ToolActivity`, `CoreCopy`, the Live
Activity copy in `RarogActivity`) are a facade that calls `L("key", arguments…)` from the package's `Copy/L.swift`.
The process language (`CopyLanguage`), lookup in an explicit language with a cache (`CopyLookup`), the app locale
(`CopyLocale`) and dates (`CopyDate`) live in `RarogContract/Copy/`, because every package with copy sees the
contract. Plurals, word order, list separators and date patterns are in the catalog too. A snapshot of every
catalog key that keeps the Polish copy unchanged (`CopyCatalogTests`) and a comparison of catalog composition with a
manual one frozen in the test (`FrozenCompositionEquivalenceTests`): `docs/localization.md`, "Proof". `RarogContract` also carries the
server sentence catalog `Copy/Localizable.xcstrings` (keys `server.*` and `push.*`) and the argument descriptors
`Copy/SentenceDescriptors.swift`, both generated from the server's sentence registry by `node
scripts/sentences-catalog.mjs --write` (`docs/localization.md`, "Server sentence catalog").

**Dependencies point one way:** `RarogTerminal → RarogUI → RarogCore → RarogTransport → RarogContract` (each of these
also depends on `RarogContract` directly), and `RarogActivity → RarogContract`. The `RarogWidgets` extension links
ONLY `RarogContract` and `RarogActivity` (no core, no transport); the `RarogNotificationService` extension links ONLY
`RarogContract` and `RarogTransport` (no core, no UI, no resources; `RarogTransport` is Foundation, Security,
Synchronization, Network (the tunnel's loopback proxy) and `RarogContract`). The app links `RarogActivity` next to its
other packages. Only the `RarogCore` tests depend on `RarogActivity`, the `RarogCore` library does not:
`RarogActivity` builds the address a Live Activity tap opens, `PushRouting` in the core reads it, and a test checks
that both agree. Packages without UIKit test on macOS (`RarogActivity`: copy, links and the voice activity's state;
views, ActivityKit and the End intent sit under `#if os(iOS)`, because ActivityKit is in the macOS SDK but
unavailable).
`RarogUI` does not import SwiftTerm (guard `TerminalSurfaceSourceTests`): the renderer comes in as the
`TerminalSurfaceFactory` from the SwiftUI environment, which the app injects. `RarogIroh → RarogTransport` (tests
also `RarogContract`): only the app target links it, so the extensions and the `swift test` of the other packages
never link IrohLib; the rest of the code sees only the tunnel protocols in `RarogTransport/Tunnel/`.

**External dependencies: only in `RarogTerminal` and `RarogIroh`** (each version pinned at least 7 days after its
release). The pins stand in three files: `Packages/RarogTerminal/Package.resolved` and
`Packages/RarogIroh/Package.resolved` (SwiftPM, `swift test` of each package) and
`Rarog.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` (xcodebuild), which holds the pins of
both packages and nothing else. xcodebuild takes versions only from the project file, and a package's `swift test`
from its own file (`RAROG_XCODE_PACKAGE_ARGS` in `scripts/xcode-toolchain.sh`, `--force-resolved-versions` in
`ios-check.sh`). `server/test/native-deps-pin.test.ts` checks `exact:`, that every package pin equals the project
pin, the flags in `ios-check.sh` and `ios-build.sh`, and the entry for each pin here:

- **SwiftTerm 1.19.0** — `exact`, commit `464df520`, maintainer `migueldeicaza`, MIT. Terminal emulator and view.
  Pinned exactly because upstream `main` is in a refactor toward 2.0. It compiles a Metal shader, so the build and
  the package's `swift test` need the Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`). Its build
  plugin `SwiftTermBuildInfoPlugin` writes a random trigger and runs on every build, so xcodebuild needs
  `-skipPackagePluginValidation` (SwiftPM on the command line does not ask).
- **swift-argument-parser 1.8.2** — commit `6a52f325`, organization `apple` (released by `natecook1000`), many
  maintainers. A SwiftTerm dependency only for its `Termcast` tool: it is not linked into the app, but it stands in
  `Package.resolved`. SwiftPM 6.4 prunes `swift-docc-plugin` (and its `swift-docc-symbolkit`): no target uses it, so
  it is not in `Package.resolved`.
- **IrohLib 1.2.0** — `exact`, commit `66a8d619`, organization `n0-computer` (product of the `iroh-ffi` package),
  MIT OR Apache-2.0. Swift bindings and a prebuilt static library for iroh connections (QUIC through a relay or
  directly). The library comes as an xcframework zip from the n0 release (about 40 MB; SwiftPM checks it against the
  SHA-256 sum in the iroh-ffi manifest), with slices `ios-arm64`, `ios-arm64_x86_64-simulator`,
  `ios-arm64-maccatalyst` and `macos-arm64`; it links `SystemConfiguration` and `Network`. Pinned exactly so that the
  compiled library does not change under the pin. `RarogIroh` uses it with `presetMinimal` (no address publishing, no
  discovery), connects without waiting for `online()` and maps library errors to `TunnelFailure`. The live tests
  (`IrohLiveTests`, two endpoints in one process without a relay) run only with `RAROG_TEST_IROH=1` and outside the
  Claude Code sandbox, where `bind` fails on the network monitor.
- **Symbols Nerd Font Mono v3.5.1** — a font file in `Sources/RarogTerminal/Resources/NerdFontsSymbols/` (2.6 MB),
  `ryanoasis/nerd-fonts` (a project with many maintainers), MIT; the icon sets inside have their own licenses
  (CC BY 4.0, Apache 2.0, OFL, Unlicense). SHA-256 sums and attribution are in `NOTICE.txt` next to it, the notices
  and license texts in `THIRD-PARTY-NOTICES` (see "Third-party asset licenses"). Reason: the system font has no
  glyphs from the Unicode Private Use Area, so without this font the p10k (Powerlevel10k) shell prompt shows "?"
  instead of Powerline separators and icons. The font joins the Menlo cascade (`TerminalSymbolsFont`, registered for
  the process); Menlo stays the main font. The base is Menlo, not the system monospace font: the system font ignores
  `kCTFontCascadeListAttribute` and takes a missing glyph from LastResort ("?" in a box instead of the icon;
  `SwiftTermSurfaceTests` checks which font `CTLine` uses for the icon). Cost: size in the repo and the app, and a
  glyph 1 em wide in a cell of about 0.6 em. An icon overlaps the next cell (p10k puts a space after it), a Powerline
  separator fits almost whole, and the left-pointing separator of the prompt's right side starts in the middle of a
  cell.

**Third-party asset licenses.** The repo code is MIT (`LICENSE` at the root). Third-party material in the app has
entries with notices in `THIRD-PARTY-NOTICES` at the repo root, and the full license texts stand at its end:
SwiftTerm compiled into the app (with libsixel code and Unicode tables inside), IrohLib and the Rust crates compiled
into its static library, the palette port in
`TerminalEdgeReader.swift` (a notice with the MIT text next to the code, from `SPDX-SnippetBegin` to
`SPDX-SnippetEnd`), the Symbols Nerd Font Mono font with fourteen icon sets, and the sound `skonczyl.caf` (CC BY 4.0:
attribution and the list of changes in its entry). The guard `server/test/third-party-notices-guard.test.ts` fails
the gate when a non-text or media file, a directory with a license file, or an `SPDX-SnippetBegin` fragment has no
complete entry, and when a license text differs from the reference checked at the source (SHA-256 in the guard).
Own files (the Rarog icon layers in `Rarog/AppIcon.icon/` and their flattened copy, the logo in
`Rarog/Assets.xcassets/RarogLogo.imageset/`) stand on the guard's `OWN` list. The app shows the
notices in Settings → About → Licenses (`LicensesView`, the file text in English, paragraph by paragraph) and carries
them: `THIRD-PARTY-NOTICES` from the repo root is a resource of the `Rarog` target (reference
`../../THIRD-PARTY-NOTICES` in `project.pbxproj`, no copy in `native/`) and sits at the root of `Rarog.app`, and
the font's `LICENSE` and `NOTICE.txt` sit in `RarogTerminal_RarogTerminal.bundle/NerdFontsSymbols/`. The extensions
live inside the app, so they carry no copy of their own. The same guard checks the reference and the Resources phase
of the `Rarog` target.
