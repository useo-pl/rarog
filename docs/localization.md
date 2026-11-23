# App language

**TLDR:** English is the source and fallback language of the app, and Polish is a translation. Every text of the
copy registries (`UICopy`, `ToolActivity`, `CoreCopy`, the Live Activity copy) lives in the package's String Catalog
with an `en` and a `pl` value, and the Swift registry calls `L("key", arguments…)`. Composition lives in the catalog
too: plurals, whole sentences with parameters, list separators and date patterns per language. Dates and times come
from the app locale. The system picks the language per app; tests run in Polish, and an English smoke test picks
English explicitly. The wording rules of the English column: `native/Rarog/Localization/TRANSLATION.md`.

Read this before you add or change a text in the app, add a language, or change the language pin in tests
(`DemoServer.makeApp(language:)`, the `Rarog` scheme, `scripts/check.sh`, `scripts/ios-check.sh`).

## How the app picks its language

- **The system decides.** The user picks the language in iOS Settings (Apps → Rarog → Language), when iOS shows that
  row (see "Measured iOS behavior"); the app has no switch of its own and does not write `AppleLanguages`. iOS takes
  the first device language that the process declares, and falls back to `CFBundleDevelopmentRegion`.
- **Regions.** `developmentRegion = en`, `knownRegions = (en, pl, Base)`, and `CFBundleDevelopmentRegion = en` in
  the `Info.plist` of the app, the widget and the notification extension. The source language of the catalogs
  (`defaultLocalization` in the four `Package.swift` files, `sourceLanguage`) is `en`.
- **Declared languages.** iOS picks a process language only from the languages of the process's main bundle, and the
  package catalogs (built as `en.lproj` and `pl.lproj` in the package resources) follow that choice. So the
  `Info.plist` of the app, the widget and the notification extension declares `CFBundleLocalizations = (en, pl)`,
  and the app also has `en.lproj` and `pl.lproj` with its usage descriptions (see "Usage descriptions"). Without
  either, every device gets English (see "Measured iOS behavior"). `scripts/ios-app-languages.sh` checks the built
  app (see "Guards").
- **The process language is fixed once** (`CopyLanguage.current` in `RarogContract/Copy/CopyLanguage.swift`), on the
  first lookup: the `RAROG_COPY_LANGUAGE` variable; a test process without it stops (see "Tests"); in the app and the
  widget, the first language of `Bundle.main.preferredLocalizations`; otherwise the source language
  (`CopyLanguage.development`, `en`). A language is a code (`en`, `pl`, …), not a list in Swift. For an app with
  `en` and `pl`, iOS picks the first device language the app has and falls back to `en`: the device list
  `[de, pl]` gives `pl`, `[de]` gives `en` (`CopyLanguageTests.deviceList`). After a language change in Settings, iOS
  restarts the app.
- **Language row in the app.** The Settings list has a Language row (`AppLanguageRow` in RarogUI, placed by
  `SettingsHubRows.rows`): the label, and as its value the name of the current copy language in that language
  (`pairing.languageValue`: "English", "Polski"). A tap opens the app's page in iOS Settings
  (`UIApplication.openSettingsURLString`). The app's `Info.plist` has `UIPrefersShowingLanguageSettings = YES`, so iOS
  shows the Language row there on a device with one language too. VoiceOver reads the label, the value and a hint
  (`pairing.languageHint`). Test: `PairingCopyTests.languageRow`.
- **Lookup in an explicit language** (`CopyLookup.string`): `Bundle.localizedString(forKey:value:table:localizations:)`
  picks the translation. `String(format:locale:arguments:)` fills in the parameters, with the locale of the same
  language only for a plural pattern (`%#@…@`, also `%1$#@…@`); see "Numbers in sentences". Measured:
  `String(localized:table:bundle:locale:)` does not pick the translation at all. A text without parameters comes
  back verbatim, and a missing key returns the key itself.
- **App locale** (`CopyLocale.current` in `RarogContract/Copy/CopyLocale.swift`): the process copy language with the
  device region and preferences (12/24-hour clock, region overridden in Settings). Dates, times, name sorting and label
  capitals use it. A test process gets the language with its most likely region (`pl` → `pl_PL`), without the Mac's
  preferences.
- **Lookup cache.** `localizedString(…localizations:)` costs about 700 µs per call on macOS 27, so `CopyLookup`
  caches the sentence pattern per catalog, language and key (`Mutex`); a cached lookup takes about 4 µs. Guard:
  `CopyLookupTests.cached` (2000 lookups under 0.5 s).

## Usage descriptions

The camera, local network, microphone and speech recognition texts that iOS shows in its permission dialogs
(`NSCameraUsageDescription`, `NSLocalNetworkUsageDescription`, `NSMicrophoneUsageDescription`,
`NSSpeechRecognitionUsageDescription`) are in English in the app's `Info.plist`. Their translations live in the String
Catalog `native/Rarog/Rarog/InfoPlist.xcstrings` (source language `en`, an `en` and a `pl` value per key, a translator
comment), which Xcode builds into `en.lproj/InfoPlist.strings` and `pl.lproj/InfoPlist.strings` of the app. The `en`
value equals the `Info.plist` text. A text names the button that turns the device on exactly as the app shows it
("Scan QR Code", the microphone button next to the prompt field). The microphone text names no speech recognition
provider: dictation audio goes only to the speech recognition chosen on the "Dictation" screen. It names OpenAI for the
voice agent, whose audio goes there only after the user turns on "Voice Agent" in Settings. The speech recognition text
says when the audio stays on the device and when it goes to Apple's speech recognition servers. The local network text
says that the app connects directly to its own server on the same network and does not look for other devices. The
widget and the notification extension have no usage descriptions.

## Measured iOS behavior (iOS 27.0 simulator)

Measured on trial builds in the simulator (iOS 27.0 24A434, iPhone 17 Pro, Xcode 27.2); not confirmed on a device.

- The app process language, launched with `-AppleLanguages` and read off the pairing screen:

  | The app declares | `(pl)` | `(de, pl)` | `(de)` |
  |---|---|---|---|
  | nothing | en | en | en |
  | only `.lproj` from `InfoPlist.xcstrings` | pl | pl | en |
  | only `CFBundleLocalizations` | pl | pl | en |
  | both (the app as built) | pl | pl | en |

  Either declaration alone is enough; with both, `(en)` gives `en` too.
- The widget extension declares its languages with `CFBundleLocalizations` alone, the mechanism measured in the app
  process above, and its `.appex` carries `RarogActivity_RarogActivity.bundle` with `en.lproj` and `pl.lproj`. In a
  simulator set to English, with the app started under `-AppleLanguages (en)` and paired with the demo, the island
  shows English. Launch arguments reach only the app process: under `-NSDoubleLocalizedStrings YES` the app doubles
  its texts and the island does not.
- `-NSDoubleLocalizedStrings YES` on the app's launch doubles every catalog text, also the lookups through
  `localizedString(forKey:value:table:localizations:)`. Format arguments land only in the second copy: the first
  copy loses its `%` (`%lld in background` shows as `lld in background 1 in background`, `%1$@` as `1$@`), and a
  key with a plural variable (`%#@value@`) shows the raw variable in both copies. Nothing crashes, so the mode
  shows text length, not correct sentences.
- `-NSShowNonLocalizedStrings YES` with the app in English finds no missing catalog text. The app log
  (`com.apple.CFBundle:strings`) names only SwiftUI texts made of a format alone (`·`, `%@ %@`, `%lld`, `%lld%%`,
  `100%`), which SwiftUI looks up in the app's own `Localizable` table; they show unchanged.
- With a single device language, the Language row in the app's Settings page appears only when `Info.plist` has
  `UIPrefersShowingLanguageSettings = YES`. The app has that key.
- After a per-app language choice, the app process has that language first in `Locale.preferredLanguages` (the
  region stays the device's: `en-PL`), and `Bundle.main.preferredLocalizations` and the package catalogs follow it.
- The widget extension (the Live Activity) follows the per-app language when the `.appex` has an `.lproj` for both
  languages.
- iOS builds a push banner with `loc-key` in the device language, not the app language.
- A catalog plural follows the locale of `String(format:locale:)`, not the lookup language.

## Catalog and registry map

Each copy package has a catalog `Copy/Localizable.xcstrings` and a function `Copy/L.swift`:

- **RarogUI**: the registry `Copy/UICopy*.swift` (a facade), the verb dictionary `Copy/ToolActivity.swift`, and
  `Copy/Formatting.swift` (relative time, server time and date), which reads its words and patterns from `format.*`;
- **RarogCore**: the gate refusal sentences in `Copy/CoreCopy.swift`;
- **RarogActivity**: the Live Activity copy in `LiveActivityPresentation.swift`, built as finished `String` values
  before the views.

**RarogContract** holds `CopyLanguage`, `CopyLookup`, `CopyLocale` and `CopyDate`, the server sentence catalog
`Copy/Localizable.xcstrings` with its argument descriptors `Copy/SentenceDescriptors.swift` (see "Server sentence
catalog"), and a sample catalog with `en` and `pl` for `CopyLookupTests`
(`Tests/RarogContractTests/Resources/Localizable.xcstrings`). It has no `L` function. Each copy package has its own
`internal` functions `L(_ key:, _ args…)`, `L(_ key:, language:, _ args…)` and, for tests,
`L(_ key:, language:, arguments:)`, all on its own `Bundle.module`.

**Keys.** The prefix is the registry file (`composer.` from `UICopy+Composer`, `app.` from `UICopy.swift`, `format.`,
`toolActivity.`, `core.`, `liveActivity.`), then the declaration name without the repeated area word
(`terminalTitle` → `terminal.title`), then the variant: a `switch` case (`cards.refuseEyebrow.noJsonl`), an argument
label (`cards.herdrDialog.trust.text`) or a sentence form with an extra parameter (`.named`, `.withText`, `.at`).
Plurals are variations of one key, not keys of their own. Every entry has `extractionState: manual` (Xcode does not
extract keys from `L`, so it does not mark them as unused) and a translator comment: area, section, meaning, case,
the parameters in order, and the room when it is tight (Mac labels of 3 characters, a countdown of 4, the Dynamic
Island, pills: short labels such as the session's mode pill).

**Values that are not sentences** change with the language too: Unicode date patterns (`format.dayPattern` `MMM d` in
English and `d MMM` in Polish, `format.dayNumericPattern` `M/d` and `dd.MM`, `transcript.timeGapDayPattern` and the
other `*Pattern` keys), list separators (`app.list.*`, `liveActivity.list.*`), the sentence end (`app.sentence`,
`liveActivity.sentence` `%@.`), the note counter's thousands separator (`notes.groupSeparator`), the quotes around an
attachment name (`composer.quoted.name`), the percent (`liveActivity.percent` `%lld%%`) and the megabyte fraction
(`composer.bytes.megabytesTenths`).

SwiftPM packages follow the language of the process's main bundle, so the app and the widget declare every language
a screen or the Live Activity should show (see "How the app picks its language"). The notification extension has no
catalog texts: it shows the title and body from the server, and declares the same languages. Xcode copies a package
resource (`RarogActivity_RarogActivity.bundle` and so on) into every target that links the package, including the
widget's `.appex`; `RarogContract_RarogContract.bundle` with the server sentence catalog is in the app, the widget
and the notification extension.

**Push `loc-key` catalogs.** iOS looks up a `loc-key` of an APNs alert in the `Localizable` table of the
app's main bundle (Apple's payload key reference), not in package resources. So the app target
(`Rarog/Localizable.xcstrings`) and, for the Live Activity chime, the widget target
(`RarogWidgets/Localizable.xcstrings`) each have a catalog with exactly the four `loc-key` keys of the server: the
banner placeholder `push.placeholder.title` and `push.placeholder.body`, and the Live Activity chime
`push.chime.title` and `push.chime.body`. Their `en` and `pl` are copies of the same keys in the server sentence
catalog; `l10n-check` keeps them equal. The target folders are synchronized groups in the Xcode project, so a
catalog in the folder is a resource of its target without an entry in `project.pbxproj`.

## Server sentence catalog

The server's sentence registry (`shared/src/sentences/`, a code per sentence with an English template and typed
arguments) is the source of the RarogContract catalog `Copy/Localizable.xcstrings`. `node
scripts/sentences-catalog.mjs --write` writes it together with `Copy/SentenceDescriptors.swift` (the argument kinds
and the `retired` flag of every code); `--check` exits with 1 when either differs from the registry.

- **Keys:** `server.<code>` (`server.rest.bad-request`), and the code itself for the `push` area
  (`push.chime.title`), because push `loc-key` values use it. Every code of the registry has a key, retired codes
  too, and every key has a code.
- **Values:** `en` comes from the registry and is regenerated on every `--write`; change it in the registry, never in
  the catalog. `pl` lives in the catalog: `--write` keeps the `pl` of every existing key, and `--pl <file>` fills only
  missing ones from a JSON file `{codes: [{code, pl}]}`, where `pl` is a string or `{one, few, many, other}` with
  `{name}` placeholders. The translator comment names the area, the code and the arguments with their kinds.
- **Parameters** are always positional, numbered by the argument's place in `ref.args`: `%N$@` for `text`, `code`
  and `instant`, `%N$lld` for `int` and `plural`. A plural is a substitution `%N$#@name@` (`argNum` N,
  `formatSpecifier` `lld`) whose variations hold the whole sentence, with the number itself as `%arg`; `en` has
  `one` and `other`, `pl` has `one`, `few`, `many` and `other`, and a variation may leave the number out. A literal
  `%` is `%%` in a sentence with arguments and `%` in one without.
- **Nested sentences:** when an error that carries a server sentence becomes the reason of another sentence (a send
  that failed, a pane that did not start, a failed restart), `reasonOfError` (`server/src/herdr/types.ts`) decides
  its form. A sentence without arguments goes as a `code` argument of the outer sentence (`commands.send-refused`,
  `commands.panel-send-failed.code`, `commands.interrupt-failed.mac.code` and `.vps.code`,
  `state.herdr-launch-failed.code`, `restart.failed.code`). A sentence with arguments, and the text of any other
  error, go as a `text` argument in English: the outer sentence stays, because it says what failed. In these outer
  sentences the `code` argument stands at the end, because the inner sentence brings its own full stop.
- **Format:** `--write` is deterministic and writes Xcode's style (sorted keys, `" : "`), and `--check` compares the
  parsed content, so a catalog that Xcode reformats still passes.
- **Published codes:** `node scripts/sentences-catalog.mjs --publish` writes `shared/fixtures/sentences/published.json`,
  `{"format": 1, "sentences": [...]}` with one entry per code in code order: `code`, `args` (`name` and `kind` in
  `ref.args` order), `en` with its plural variants and `retired` (`null` or the `since` version). The file only
  grows: when a published code is in neither `SENTENCES` nor `RETIRED`, `--publish` exits with 1, names the code and
  leaves the file as it is, because a code is retired through `RETIRED`, never deleted. A changed definition of
  a published code rewrites its entry, and the output lists such codes for the diff review. Running it twice gives
  the same bytes. `server/test/sentences-published.test.ts` keeps every entry equal to its registry code in
  arguments (name, kind, order) and `en`; the catalog cannot catch such a change, because `--write` regenerates it
  from the changed registry. `--check` does not read the file.

## Server sentences in the app

A server sentence from the registry reaches the app as English text with a `ref` next to it (`code` and string
`args`, fields named `*Ref`: `messageRef`, `labelRef`, `stateDetailRef`, `detailRef`, `ref` of a text block,
`displayTextRef`, `questionRef`, `msgRef`). The app translates it once, where the data enters, with
`ServerText.render(_:_:language:)` of RarogContract, and keeps the `*Ref` fields:

- **Stream frames:** the stream loop of RarogCore (`StreamSupervisor`) passes every decoded frame through
  `ServerEvent.translated(_:)` (`Reducer+Sentences.swift`) before the reducer sees it. The global stream, the session
  stream, the replay after `Last-Event-ID`, the history from the conversation file and `transcript-snapshot` all
  come through this loop. Translated fields: a session's `label` and `stateDetail` (in `sessions-snapshot`,
  `session-changed`), `detail` of `herdrStatus`, of `herdr-status` and of `state`, text blocks with `ref` in
  messages, `displayText` of permission cards and `question` of question cards. A `state` frame without `detail`
  clears both `stateDetail` and `stateDetailRef`.
- **REST:** the REST client decoder translates every response type that carries `*Ref` and every error body;
  `RarogStore.loadModels()` returns the translated model list.
- **Terminal:** `TerminalSession` translates the `err` frame, so a stopped terminal shows the sentence in the app
  language.
- **Notifications:** the server builds the title and body of every banner with `say()` and sends `titleRef` and
  `bodyRef` in the encrypted plain text; the notification extension translates them in
  `PushServiceDecision.decide(userInfo:keys:now:renderer:)` before it replaces the placeholder. The plan limit body is
  the sentence `state.limit-reached`, so the app formats the reset time itself. A text the server had to clip goes
  without its code, so the translation never brings back what the banner cut. A notification without codes (an older
  server) shows its text unchanged.
- **Sentences the app composes from a code** (the refusal on a card without a decision, the truncation footer, the
  alt text of an image without preview) use the facade `ServerText.sentence(code:args:language:)`.

The renderer is injected: `RarogStore(renderer:)` and `TerminalSession(renderer:)` default to
`ServerText.renderer(language: .current)`, tests pass their own. The text in the app state is already in the app
language, while the `*Ref` fields stay for views that need the arguments (the plan limit card reads the reset time
from `stateDetailRef.args[0]`). When anything does not fit (an unknown code, a wrong number of arguments, an argument
that does not parse, a key without a pattern), the app shows the server's text unchanged.

**List cache.** The list cache (`SnapshotCacheFile`) stores the translated text. After a change of the app language
the list from the cache speaks the previous language until the first fresh list, like `lastSummary`. `scrub` drops
`stateDetail` together with `stateDetailRef`, so no sentence argument of the state detail is written to disk.

## Tests

Test assertions use Polish sentences, so every test process has its language pinned:

- **Package tests** (`swift test`, Swift Testing on macOS): `RAROG_COPY_LANGUAGE=pl` in `scripts/check.sh` (the
  `swift-contract` step), in `scripts/ios-check.sh` (the full iOS gate) and in the recipe for selected tests that
  run beside other test runs on the same Mac ("Selected tests next to other sessions" in `native/Rarog/docs/tests.md`).
  Without the variable, `CopyLanguage.current` stops the process with `preconditionFailure` and a message (in
  Polish) that names `RAROG_COPY_LANGUAGE=pl` and points to this section. The reason: on macOS a package catalog
  follows the process's main bundle, and `swiftpm-testing-helper` has no `.lproj`, so the process would get `en`
  even on a Mac set to Polish (measured). A test process is one with XCTest loaded (`NSClassFromString("XCTestCase")`,
  present under Swift Testing too); the app and the widget do not link it.
- **UIKit tests** (`RarogUIKitTests`, no host app): the test action of the `Rarog` scheme sets the variable in its own
  environment (`shouldUseLaunchSchemeArgsEnv = "NO"`: the test action does not take the Run action's arguments and
  environment), and `-testLanguage pl -testRegion PL` on `xcodebuild test` sets the process language and region. Guard:
  `LanguagePinTests`. `TEST_RUNNER_RAROG_COPY_LANGUAGE=en` on `xcodebuild test` overrides the scheme's value, so a
  separate run of a class in English needs no change to the scheme.
- **XCUITest:** the app starts only through `DemoServer.makeApp(language:)`, which adds
  `-AppleLanguages (pl) -AppleLocale pl_PL` by default; tests append their own arguments with `+=`. Another language
  comes only through the parameter, with its own region (`.en`: `-AppleLanguages (en) -AppleLocale en_US`). The app
  under XCUITest gets no `RAROG_COPY_LANGUAGE`: it picks its copy language from `Bundle.main.preferredLocalizations`,
  as on a device. The simulator of the full gate starts in `en_US`, and a fresh simulator from `simctl create` takes
  the Mac's language.
- **English smoke test:** `EnglishSmokeUITests` starts the app with `.en` and goes through pairing, the list,
  Settings with the Language row and a session with a permission card. The expected labels are copied from the catalog
  with the key beside each, because the UI test target links no package. XCUITest has no attribute for a VoiceOver
  hint; the test hears the hint of the Language row through VoiceOver (`XCUIVoiceOverService`, iOS 27: a tap with
  VoiceOver on moves the focus, and `currentSpeech()` gives label, value, trait and hint, cut at 64 characters; the
  trait comes in the simulator's language). It turns VoiceOver off before the next tap and in teardown. Server
  sentences (session state, card text) are not checked.
- **English screenshots:** `EnglishScreenshotUITests` (skipped without `RAROG_SCREENSHOT_DIR`) saves the key screens in
  English: pairing, the list, Settings, the session header with the background pill, the permission card, the
  deny-only card, the question card and, on iPhone, the Live Activity on the island. `RAROG_SCREENSHOT_PSEUDO=double`
  starts the app with `-NSDoubleLocalizedStrings YES` and `nonlocalized` with `-NSShowNonLocalizedStrings YES`. The
  test has no label assertions, because the pseudo-languages change the labels.
- **RarogTerminal package scheme** (`xcodebuild test -scheme RarogTerminal`): the scheme has no variable, so
  `ios-check.sh` exports `TEST_RUNNER_RAROG_COPY_LANGUAGE=pl` (xcodebuild passes it to the test process without the
  prefix).
- **Another language or locale in a test:** call `L(_:language:)` with an explicit language, or run a separate
  process with another value of the variable. `LiveActivityPresentation` takes `CopyLanguage.current` and has no
  language parameter, so `LiveActivityViewTests` (with its VPS case, `testVpsServerKeepsMacLayout`) runs in English
  only as such a separate process. There is no global switch, because Swift Testing suites run in
  parallel. A test of another region, hour cycle or time zone passes `locale:` and `timeZone:` explicitly
  (`CopyLocaleTests`, `FormattingTests.serverTimeLocale`).
- **English tests:** `EnglishCopyTests` in RarogUI and RarogActivity call `L(_:language: .en)` beside the pinned
  Polish: plural forms (`one` and `other`, a `one` form without the number, a plural where Polish has none), a plural
  in a substitution, and the date patterns formatted with `en_US`.

Pin guards: `server/test/native-test-language.test.ts` (one place creates `XCUIApplication`, Polish by default,
every language with a region of the same language, no `-AppleLanguages` or `-AppleLocale` outside `DemoServer`, no
assignment to `launchArguments`, the variable in the scheme, the recipe in the README),
`scripts-ios-check-demo.test.ts` (variables and `-testLanguage` in the gate, also when the caller set another
language), `scripts-check.test.ts` (the `swift-contract` line), and `CopyLanguageTests` and `CopyCatalogTests` in the
packages.

## Proof: Polish unchanged — registry texts

A snapshot of every key pins the Polish wording of the catalog (`CopyCatalogTests.everyKeyMatchesBaseLiteral` in
RarogUI, RarogCore and RarogActivity, `Tests/<target>/Fixtures/copy-catalog-baseline.json`, comparison in
`RarogContractFixtures.CopyCatalogBaseline`): the stored literal is compared with `L` called with sample arguments
(the number `12345 + 11·i`, the text `⟦i⟧`). It catches a wrong `%` or specifier, a no-break space, an escape
character, a missing resource and digit grouping. Every key in the snapshot must exist in the catalog. A new key is
not in the snapshot; `l10n-check` checks its value and parameters.

The snapshot has no write mode: when a key's sentence changes on purpose, write the new literal into its entry in
`copy-catalog-baseline.json` by hand (or delete the entry); when the key goes away, delete its entry.

The registry functions on top of the catalog have tests of behavior, not of wording. Plural forms, lists, numbers
and dates are covered by `FrozenCompositionEquivalenceTests` ("Proof: Polish unchanged — composition"). A branch that picks a
sentence part from data or a condition is covered by the tests of the model that calls it or, where no model test
reaches it, by `UICopyBranches*` in RarogUI and `LiveActivityBranchesTests` in RarogActivity; these pin the part
chosen by the input, not the wording around it. A one-to-one switch from a case to a key and an argument inserted
as is have no test of their own: a wrong sentence there is left to review.

## Proof: Polish unchanged — composition

`FrozenCompositionEquivalenceTests` in RarogUI and RarogActivity hold a frozen composition: Swift code in the test target (enum
`Old`) that builds the same texts without the catalog, from literal Polish forms (`PolishPlural.form`,
concatenation, `%02d:%02d`, `DateFormatter` with `pl_PL`, `prefix(1).uppercased()`). The test compares its output
with the catalog composition on the same data: number ranges around every plural and grouping boundary of each
counter, pairs and triples of list parts, every relative-time scale, every minute of the day and every day of the
year in two time zones, and the Live Activity in six layouts. The frozen code holds the current wording of the two
sentences that differ from its forms on purpose (the product name in the Live Activity sentence, `Rarog: `, and the
card `lead` in RarogUI), so the test checks composition, not wording. The model field `TimeMark.spokenDay` carries
the date in the sentence-start form that `TimeGap.spokenDay` gets from the formatter; the registry does not rework
it.

## Numbers in sentences

Numbers in sentences are not grouped, in every language, and use a period in fractions. A sentence without a plural
is formatted without a locale, so a count such as 200 of 12000 and the Keychain error code -25308 come out plain.

A plural sentence needs the language's locale (otherwise Foundation picks the wrong variant), and the locale groups
digits: Polish from 10 000 with a no-break space, English from 1000 with a comma. Measured on macOS 27: neither the
specifier (`%d`, `%ld`, `%lld`, `%u`, flags) nor a custom `NSLocale` subclass turns grouping off, and a dictionary
instead of a locale breaks the formatting. So after formatting, `CopyLookup.ungrouped` turns the grouped form of each
integer argument from 1000 up back into the plain form, longest first. The one grouped number is the note character
counter (`45 120 / 49 152`, separator from `notes.groupSeparator`). Tests: `CopyLookupTests.numberGrouping`,
`ungroupedRule`.

## Plurals

A plural is a set of variations of ONE catalog key (Polish: one, few, many, other, where `other` covers fractions and
equals `many` in the app; English: one, other). Foundation picks the variation by the language's locale, not Swift
code. Two shapes:

- **Whole sentence in variations** (`variations.plural`) when the number is the only parameter: `header.filesCount`,
  `composer.voiceLimitSpoken` (the verb agrees with the number). A form may leave the number out of its text: the
  English `one` of `liveActivity.spoken.moreWorkflows` is "One more workflow". xcstringstool (Xcode 27.2) builds
  such a catalog and Foundation formats it (`EnglishCopyTests` in RarogActivity).
- **Substitution** (`substitutions`, `%1$#@name@` in the sentence) when the sentence has more parameters or a word
  stands without the number: `header.backgroundSpoken`, the Live Activity counter words (`liveActivity.waitingWord`,
  `%#@word@`). Parameters inside substitution variations carry a position (`%arg` or `%N$lld`), and so do all
  parameters of a sentence with several.

Grammatical case is a separate key per context, not inflection in code: relative time has a nominative
(`format.spoken.*`), a genitive after "since" (`format.spokenSince.*`) and a form with "ago" (`format.spokenAgo.*`).
A list with the noun only on its first part has a key with the noun for every part that can come first
(`header.fileKindsSpoken.first.*`) and one without it for every part that can follow (`.next.*`).

## Sentences and lists

A sentence lives in the catalog whole, with parameters; code does not append words, punctuation or spaces. The
exceptions: a few VoiceOver labels and pills join catalog texts or values with a separator in code, `": "` between a
label and its value (`NewSessionSheet+Start.swift:124` and `:141`, `UsageSheet.swift:69`) and `" · "` between parts
(`ToastCenter.swift:106`, `SessionPillsModel.swift:97–105`, `NewSessionSheet.swift:199–200`,
`NewSessionSheet+Project.swift:263`); both read the same in English and Polish. The Paired row in Settings → Server
joins date and time with a space (`SettingsServerPage.swift:41`). The short name of a server reachable only over iroh,
`iroh · ` and the first 8 characters of its EndpointId, is built in code (`ServerIrohConfig.shortName`, RarogCore
`Pairing.swift`) and goes into `pairing.revokedBody.namedServer`; the server row of the Settings list and the pairing card take the same
label from `pairing.serverIroh` and `pairing.confirmTitle.iroh`. A parameter may carry part of a sentence when it is
a phrase from its own key (`activity.sinceSpoken`). A list of equal items goes through `UICopy.list(_:_:)` (Live Activity:
`LiveActivityPresentation.list`) with a separator from the catalog: `.comma` (parts of a VoiceOver sentence), `.dot`
(an on-screen metadata line), `.semicolon` (groups with their own commas), `.sentence` (whole sentences);
`UICopy.sentence(_:)` closes a phrase with the catalog's period. Code does not capitalize finished text (no
`.capitalized`, no `prefix(1).uppercased()`): a word at the start of a sentence has its own key
(`transcript.rolePrefix.*`, `cards.cliDialogLead.*`), and a date there comes from the formatter with the
`.beginningOfSentence` context (`TimeGap.spokenDay`). Joins that are not language stay in code: diff symbols
(`+10 −10`), shell command words, line breaks. One style depends on word order: the bold `+N` in the Live Activity's
`+1 workflow` line reaches the first space (`LiveActivityMoreLine`).

## Dates, times and locale

- **Time** (`CopyDate.clock`, `ServerTime.clock`): the `jmm` template with the app locale, so the 12/24-hour cycle
  follows the device region and preference. A Polish region gives `HH:mm` in English too (`en_PL` → `21:40`); a US
  region gives `h:mm a` (`9:40 PM`, with a narrow no-break space U+202F). One definition in `RarogContract` serves
  the app and the Live Activity.
- **Date** (`CopyDate.string`, `ServerTime.day` and its variants, `TimeGap.day`, `.spokenDay`): a Unicode pattern
  from the catalog per language, day and month names from the app locale, always the Gregorian calendar and an
  explicit time zone. Formatters are cached per pattern, locale and time zone.
- **Sorting and case** follow `CopyLocale.current`: project order (`Selectors+Projects`), UIKit label capitals
  (`Eyebrow.text`) and the directory filter of a new session (`PathField.filter`). A few SwiftUI views uppercase
  without a locale (`.uppercased()` in `BackgroundTasksSection`, `GitChangesSection`, `ModelSheet`,
  `TranscriptMarkerViews`).
- **App locale** (`CopyLocale.make`): the device locale with its language swapped. The region is passed explicitly,
  because swapping only the language code drops it (measured: `en_PL` → `en`).

## Guards

The copy, catalog and product identity guards run in `pnpm run check` (the tests alone: `pnpm vitest run
server/test/native-copy-guard.test.ts server/test/l10n-check.test.ts server/test/product-identity-guard.test.ts`). The
built app check needs a build, so it runs in the full iOS gate; its tests run in `pnpm run check`.

- **Copy literals outside the registry** (`server/test/native-copy-guard.test.ts`). In the Swift sources of the app,
  the extensions and the packages (tests excluded), it counts literals with a letter in a call that shows text
  (`Text`, `Button`, `Label`, `title:`, `text:`, `placeholder:`, `.accessibilityLabel`, assignments to `.text`, and
  more) and any literal with Polish letters. The registry (`Copy/`) and diagnostics (`trace`, `fatalError`, `Logger`,
  …) are exempt. Two lists carry an exact count per file: `NOT_COPY` (permanent exceptions with a reason, such as
  loading skeletons and Xcode preview data) and `PENDING` (copy outside the registry that waits to move into it;
  empty, and its cap `PENDING_CEILING` is zero, so it admits nothing). A new literal fails the test with its
  `file:line`; fewer occurrences than listed means the list must shrink.
- **Catalogs** (`scripts/l10n-check.mjs`, no dependencies, tests in `server/test/l10n-check.test.ts`). Every key has
  a non-empty `translated` value in every required language (`REQUIRED_LANGUAGES`, `['en', 'pl']`), and every plural
  has all categories of its language, also in substitutions and nested variations. Parameters match the source
  language in count, types, positions and the number of `%%`; `%%` in a sentence without parameters, a `*` width
  and a substitution without a definition are errors. `sourceLanguage` is `en`. Every `L("…")` key in a package's
  sources exists in its catalog, a key that is not a plain literal is an error, and so is a catalog key that no
  `L("…")` calls. It also checks the RarogContract sample catalog, and the app's `InfoPlist.xcstrings` against
  `Info.plist`: every `NS…UsageDescription` key of the `Info.plist` has a catalog entry and the other way round, and
  the `en` value equals the `Info.plist` text. `CFBundleLocalizations` in the `Info.plist` of the app, the widget and
  the notification extension lists exactly the required languages. The server sentence catalog of RarogContract gets
  the value and parameter rules and a key prefix `server.` or `push.`, but not the `L("…")` rules, because nothing
  calls `L` with its keys. The push `loc-key` catalogs of the app and the widget get the value and parameter rules,
  exactly the four `loc-key` keys (`LOC_KEYS`), and the `en` and `pl` of each key equal to the server sentence
  catalog.
- **Server sentence catalog** (`shared/test/sentences-catalog-lustro.test.ts`, generator tests in
  `server/test/sentences-catalog.test.ts`, `node scripts/sentences-catalog.mjs --check`). The catalog and the
  descriptors mirror the registry: a key for every code and a code for every key, `en` equal to the registry
  template, each parameter's specifier matching its argument kind in both languages, every argument except the plural
  used, plurals with all categories, `pl` present, `push.*` keys equal to the `push` area, and the descriptors equal to
  the registry. RarogUI has no `cards.refuseMessage.*`: the app composes a refusal from
  `server.dialogs.refuse.<reason>`. `ServerCatalogTests` in RarogContract formats a plural from the built catalog.
- **Built app** (`scripts/ios-app-languages.sh <Rarog.app>`, tests in `server/test/scripts-ios-app-languages.test.ts`,
  run by the full iOS gate `scripts/ios-check.sh` after the device build). In the app and every extension it checks
  `CFBundleLocalizations`, in the app `<language>.lproj/InfoPlist.strings`, and a non-empty `<language>.lproj` in the
  resources of every package with a copy catalog (`RarogUI_RarogUI.bundle` and the others; the widget must carry
  `RarogActivity_RarogActivity.bundle` and `RarogContract_RarogContract.bundle`, the notification extension
  `RarogContract_RarogContract.bundle`). In the app and the widget every `<language>.lproj/Localizable.strings` has
  the four push `loc-key` keys.
- **Product identity** (`server/test/product-identity-guard.test.ts`, sources read in
  `server/test/product-identity.ts`). The app name in copy is identity, not ordinary text: `app.appName` in the
  RarogUI catalog must equal `CFBundleDisplayName` of the app, the widget and the notification extension, because
  the user sees both side by side. The app name is `Rarog`. The same test ties the link scheme (`rarog`), the
  bundle id (`ai.rarog.app`, `IOS_BUNDLE_ID` in `scripts/ios-identity.sh`), the push relay topic and the Keychain
  groups to one value across their sources. In the texts an app user sees (catalog values, usage descriptions
  `NS…UsageDescription` in `Info.plist` and in every language of `InfoPlist.xcstrings`, push texts and the server
  sentences, that is the registry's area files in `SERVER_TEXT_SOURCES`), the CLI commands are `rarog pair` and
  `rarog devices`. A failure prints every source with its value and `file:line`. Not app text: the refusal message
  that the tall dialog guard (`scripts/hooks/tall-dialog.mjs`, a hook that denies a too-tall permission dialog before
  it appears) returns to the Claude model as a tool result, because the app does not show tool results (see "Tall
  dialog guard" in `docs/dialogs.md`).

The guards do not prove that no text is assembled in a model from variables and words without Polish letters outside a
display call (such places live in the registry, except the iroh short name in `Pairing.swift`), the quality of a
translation, or whether a text fits on screen. The copy guard's lexer does not know regex literals `/…/`: it takes a
quote inside one for the start of a string. The three such patterns in `Session/Cards/AlwaysLabelParts.swift` produce
no false hits.

## Adding a text

A new text is two entries, both in the same commit:

1. **Catalog entry** (`Copy/Localizable.xcstrings` of the package, by hand or in Xcode's catalog editor): the key by
   the rule in **Keys**, `extractionState: manual`, an `en` and a `pl` value in state `translated` (the English by
   `native/Rarog/Localization/TRANSLATION.md`), and a translator comment
   (where the text sits, what the parameters mean, how much room there is when it is tight). Parameters: `%lld` for
   `Int`, `%@` for `String`, in the order the call passes them. Write `%` as `%%` in a sentence with parameters and
   single in one without, because a text without parameters comes back verbatim. A no-break space is the U+00A0
   character in the value. A plain text (no plural or other variation) takes one command, without opening the
   catalog:

   ```bash
   node scripts/l10n-add.mjs RarogUI <area.key> --en "<English>" --pl "<Polish>" --comment "<translator comment>"
   ```

   It puts the key in its sorted place with `extractionState: manual` and both values `translated`, and writes the
   file in Xcode's layout, so the diff is the new entry alone. It refuses an existing key, values that break a
   catalog rule (parameters that differ between languages, `%%` without parameters), the RarogContract server
   sentence catalog and a catalog not in Xcode's layout (exit 1 or 2, nothing written).
2. **Registry entry:** a constant as a computed `static var x: String { L("area.key") }` (not `static let`, so no
   constant caches catalog text), a function as `L("area.key", a, b)`. The key is always a literal.

Write whole sentences with parameters, plurals as variations of one key, and lists of equal items through `UICopy.list`
(see "Plurals" and "Sentences and lists"). `pnpm run check` checks both entries: the catalog (`l10n-check`: value,
parameters, the key is used and exists) and literals outside the registry (see "Guards"). Content from agents, the CLI
and people (questions, options, the transcript, skill descriptions, session titles, the device label) stays in the
original and does not enter the catalog; neither do key glyphs (`⌘I`) and addresses (`rarog://…`, the product pages
and the support mailbox in `RarogCore/ProductLinks.swift`), nor the technical line of Report a Problem (`Rarog 1.0
(123) · iOS 26.1 · iPad`, `ProblemReport`), which support reads the same in every language. License and notice
texts (`LICENSE`, `THIRD-PARTY-NOTICES`, the font's `NOTICE.txt` in RarogTerminal, the port note in
`TerminalEdgeReader.swift`) stay in English: they are legal text in their authors' words. The Licenses page in
Settings → About (`about.licensesTitle`) has a translated title over the English text.

**Logic does not compare text.** A sentence depends on the app language, so a decision goes by a field or an enum, and
the registry builds the sentence at the end. For example, a refusal of the mutation gate (the app's check before a
request that changes something on the server, `MutationGate.swift`) carries `PolicyRefusal.transient` when it passes by
itself (the server's `hello` or a fresh session list is missing within the wait limit); the app's terminal retries
after a transient refusal and stops after a permanent one (`TerminalSession.openFailure`, `RefusalKindTests`);
the list card asks `ActivityText.delegationForm` instead of comparing a sentence; background task kinds are deduplicated
by `BackgroundTaskKind`, not by word; a stale Live Activity has its own VoiceOver key
(`liveActivity.spokenLabel.stale`). `CopyRegistryMovesTests` pins the wording of texts that live in the registry instead
of models and views.

## Adding a language

A language needs no Swift change (`CopyLanguage` is a code, not a list), because lookup takes the translation from
the catalog column. A new language is a column in every catalog (`InfoPlist.xcstrings` too), an entry in
`knownRegions`, its code in `CFBundleLocalizations` of the app, the widget and the notification extension, and in
`REQUIRED_LANGUAGES` of `scripts/l10n-check.mjs` and `LANGUAGES` of `scripts/ios-app-languages.sh`, and its own name
as the value of `pairing.languageValue`. Number grammar, the order of sentence parts, list separators, date
patterns and characters (quotes, percent, decimal comma, the note counter's thousands separator) live in the
catalog, so the new column translates them too (see **Values that are not sentences**).

## App × server version matrix

The app language changes neither the protocol nor the server. The server does not know the device language. The
sentences it builds from its sentence registry (`shared/src/sentences/`) are in English and carry a code (`*Ref`).
Without a code go only the agent's own texts and, for an app registered without `locKeys`, the Polish banner
placeholder and Live Activity chime. What a screen shows depends on both versions:

- **App with the translator × server with codes:** a sentence with a known code is shown in the app language; an
  unknown code shows the server's English text.
- **App with the translator × server without codes:** there are no `*Ref` fields, so the app shows the server's text
  as it is. The plan limit card reads the reset time from the `resetAt=<ISO>` token of `stateDetail`.
- **App without the translator × server with codes:** the decoders skip the `*Ref` fields and the app shows the
  English text. For the plan limit `stateDetail` stays the `resetAt=<ISO>` token, which that app reads; the
  notification banner shows the English sentence with the reset instant.
- **Change of the app language:** stream frames and REST responses arrive in the new language at once; the list
  from the cache keeps the previous language until the first fresh list (see "Server sentences in the app").
