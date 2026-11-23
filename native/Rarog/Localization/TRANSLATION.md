# Rarog app: English copy guide

Rules for the English (`en`) values of the app's String Catalogs: `RarogUI`, `RarogCore` and `RarogActivity`, and
the usage descriptions in `native/Rarog/Rarog/InfoPlist.xcstrings`. The server sentence catalog of `RarogContract`
has its own rules (see "Server sentences"). English is the source and fallback language of the
catalogs, and the other languages translate it. How catalogs, keys, parameters, plurals and dates work is in
`docs/localization.md`; this guide covers the wording of the English column.

The English copy says what the app means in plain English. One concept has one English name across the app, the docs
and the `rarog` command, so the glossary below wins over a writer's own choice.

Sources this guide follows:

- the key comments in the catalogs: where the text sits, what fills its parameters, how much room it has;
- `docs/localization.md` (catalog map, plurals, sentences and lists, dates);
- Apple: HIG Writing <https://developer.apple.com/design/human-interface-guidelines/writing>, HIG Buttons, Alerts,
  Menus and VoiceOver, the Apple Style Guide entry "capitalization"
  (<https://support.apple.com/guide/applestyleguide/c-apsgb744e4a3/web>), and the `accessibilityLabel` and
  `accessibilityHint` reference in the Xcode documentation.

## Voice

Rarog talks to a developer who steers Claude Code sessions from an iPhone or iPad, often away from the desk and in a
hurry. Apple's advice fits that reader: be clear, use the fewest words that work, put the most important fact first,
and write for how people use the device.

- **American English.** canceled, color, behavior, dialog (not dialogue), catalog.
- **Short and active.** "The server isn't responding. Check the network connection." (`app.serverSilent`), not "It
  appears that the server may not be responding at this time."
- **No first person, never "we"** (HIG Writing). Progress is a gerund with an ellipsis: Connecting…, Loading…,
  Pairing…. A finished action is a past participle: "Sent Esc. The pane should cancel the dialog."
  (`cards.dialogDenied`). Doubt is stated about the thing: "Couldn't confirm that the message arrived."
  (`composer.unconfirmedSpoken`). When the actor matters, name it: "Rarog didn't send the answer. Answer in the
  terminal." (`cards.questionRefusedFallback`).
- **You, lowercase.** Use possessives only when they carry meaning (HIG: "Favorites", not "Your Favorites"):
  `notes.takeTheirsEffect` "Your version will be lost." needs it, because the note conflict shows two versions.
- **Contractions** as Apple uses them: isn't, can't, couldn't, didn't, doesn't, won't, you're, it's.
- **Errors say what to do.** What failed, then the next step: "Couldn't load changes. Try again."
  (`header.diffFailed`). Not "Error loading changes" and not "Oops".
- **Gestures.** On screen, a touch is tap and a hardware keyboard key or shortcut is press. Never "click". VoiceOver
  text has its own rule (see "VoiceOver text").
- **Dashes.** On screen, a state and an instruction are two sentences: "Code expired. Generate a new one."
  (`pairing.codeExpired`). A dash stays only inside one thought and is closed up (American usage):
  `cards.allowedWaiting` "Allowed—waiting for the screen to update." Separators that are not prose keep their shape:
  `transcript.timeGap` `— %@ —`, label pairs like `list.usageWindowNames.namedModel.full` `Week — %@`.
- **Quotes** are curly double quotes: `“%@”`. A quoted literal the user types or reads back (a command, a file name, a
  button title) never ends a sentence with a period inside the quotes; reword or put the period outside.
- **Ellipsis** is the single character … (U+2026).
- **Paths in Settings** use the arrow → with spaces, as `rarog pair` prints them: "Settings → Pairing → Pair New
  Device" (`pairing.lead`: the Settings title, the `pairing.issueSection` header, the `pairing.newDevice` button),
  "Settings: Rarog → Microphone" (`composer.microphoneError.denied`). Name iOS places as Apple does: Settings, Lock
  Screen, Home Screen, Dynamic Island, Live Activity.
- **Shortcuts.** On screen, Apple glyphs: ⌘I. In a VoiceOver string, words with a hyphen: Command-I.
- **A sentence that names a control quotes its English title exactly**, in the same case: `pairing.revokedBy.forget`
  “Forget Server” in the app; `header.ultracodeHint` names the segment “No” in the “Model and Effort” sheet;
  `pairing.scannerUnavailable` names the button “I Have a Link”; `pairing.lead` walks the path to Pair New Device.
  Change the title key first, then every sentence that quotes it.
- **Keep the shape a composed text needs** where code composes text (the key fills another key's parameter, or its
  own parameters take other keys): the final punctuation and the capital or lowercase first letter the comment asks
  for. Code adds no words, spaces, punctuation or capitals (`docs/localization.md`, "Sentences and lists"). A key may
  sound odd alone and fine in its sentence; read the comment before changing its shape. Splitting a dash into two
  sentences is for values that stand alone on screen.

## Capitalization

Apple's rule (HIG Writing) is one style per element type, applied everywhere. Rarog uses title case where iOS does
(titles, buttons, menus) and sentence case for everything a person reads as a sentence.

**Title case** (Apple title style): capitalize the first and last word, nouns, pronouns, verbs, adjectives, adverbs,
subordinating conjunctions (If) and prepositions of five letters or more (About, Between). Lowercase articles
(a, an, the), coordinating conjunctions (and, but, or, nor, for, yet, so), to in infinitives, as, and prepositions
of four letters or fewer (at, by, for, from, in, into, of, off, on, onto, out, over, to, up, with), unless the
preposition belongs to a phrasal verb (Log In, Turn On, Set Up). A name that starts lowercase stays lowercase
(herdr, iroh, iPad).

| Element | Style | Example |
|---|---|---|
| Screen, sheet, window title | title case | `newSession.title` New Session |
| Button | title case, verb first, no period | `pairing.codeShare` Share Link |
| Menu item, shortcut title | title case; … if input follows | `shortcuts.closeTab` Close Tab |
| Swipe action | title case | `list.readToggleSwipe.markRead` Read |
| Segment, option capsule | title case | `newSession.startModeShort.manual` Ask |
| Field and row label | title case | `newSession.directoryLabel` Directory |
| Tab title | title case | `shortcuts.tab` Tab %lld: %@ |
| Alert title, fragment | title case, no period | `pairing.scannerTitle` Pairing Code |
| Alert title, verb question | title case with ? | `pairing.forgetConfirmTitle` Forget Server? |
| Body, message, banner, toast | sentence case, full sentences | `list.empty` No sessions yet. |
| Placeholder | sentence case, no period | `cards.questionCustomPlaceholder` |
| Eyebrow, section label | as the value is written | `list.detailEyebrow` Session |
| Status word, badge, pill | lowercase | `list.stateLabel.running` working |
| VoiceOver label | capital first letter, no period | `cards.questionSpokenHeader.single` |
| VoiceOver fragment joined by code | lowercase | `list.macMetricNames.ram.spoken` memory |
| Accessibility hint | third person verb, period | `network.toastOpenHint` Opens the session. |

Notes on the rows:

- **Alert titles.** Apple: a complete sentence gets sentence case and ending punctuation; a fragment gets title case
  and none. A short "Verb Object?" question counts as a fragment with a question mark, as on iOS ("Delete App?").
  Prefer a fragment, and give one screen one style: `pairing.revokedTitle` Device Revoked and `pairing.unknownTitle`
  Device Not Recognized.
- **Buttons.** Prefer a specific verb to OK. A button that cancels is always Cancel; a single dismiss button of a
  sheet is Done or Close. One action, one word in the whole app: a button that repeats a failed connection or load is
  Try Again (`terminal.retry`, `pairing.unknownRetry`); Retry is the button that sends a failed message again
  (`composer.retry`).
- **Eyebrows and section labels** (the `Eyebrow` style and `.textCase(.uppercase)`, also the views with
  `.uppercased()`) show in capitals on screen whatever the value is, and VoiceOver reads the value as written. A
  standalone header has a capital first letter (`list.detailEyebrow` Session, `inspector.finishedTitle` Recently
  finished); a word that is also used inside a list line stays lowercase (`cards.refuseEyebrow.*`, `cards.waiting*`:
  "shared by the card header and the list line"). Values written in capitals stay in capitals: `notes.eyebrow` NOTE,
  `notes.compareTitle` CONFLICT, `notes.mineVersion` YOURS · UNSAVED, `notes.serverVersion`.
- **A product name that starts lowercase** keeps it at the start of a sentence: "herdr is read-only, so sending to
  the pane is off." (`composer.sendBlock.herdrReadOnly`). Reword only when the sentence reads badly.
- **Markers in the transcript** set in a monospaced face (`transcript.toolRunLabel.*`) are lowercase like the other
  metadata, even when they work as a toggle.

## Glossary

One English word per concept. The word in a key's comment that names a UI part (card, pill, sheet) is internal; the
user sees the words below.

**Sessions and agents**

- **session**: one Claude Code or Codex conversation in a herdr pane. Session list, session switcher (on screen:
  Recent Sessions, `switcher.label`).
- **pane**: the herdr pane that holds a session. Never "panel": `projects.closePanel` Close Pane in herdr.
- **workspace**: a herdr workspace.
- **agent, subagent**; **engine** for the model process (`activity.waiting` waiting for the engine…).
- **transcript**; **turn** (`composer.shortcutInterrupt` Interrupt Turn).
- **background, in the background**; **background task**; **own task** (`header.agentWaitingOwnTask` waiting on its
  own task); **(background) command**. A slash command stays as typed: `/model`.
- **notice**: a line the harness adds to the transcript (`transcript.harnessNotice.*`).
- **artifact**; **workflow, run, phase**.
- **message, prompt**; **prompt field**, "the field" once the context is clear (`composer.sendResult` The message is
  back in the field.); **paste** (`terminal.pasteTooBig` Paste too large.); **attachment**, button Attach.
- **queued** (`transcript.queuedRolePrefix` You, queued); **sending** for a message on its way
  (`composer.pendingTile.*`); **outbox** for messages that wait to be sent (`pairing.forgetConfirmBody`).
- **Conversations**: the list of sessions to resume (`newSession.resumeTitle`).

**Decisions**

- **dialog**: a CLI dialog in the pane; **permission**: a tool permission request. Never "approval" for a tool
  permission.
- **Allow, Deny** answer a permission (`cards.allow`, `cards.deny`); **always** keeps the permission
  (`cards.alwaysSpoken` Always allow: %@). Any other CLI dialog is **dismissed**: `cards.dialogDeny` Dismiss Dialog.
- **Approve** is for a plan only (`cards.allowPlanAuto` Approve and Return to Auto); **Apply** confirms a setting
  (`header.modelApply`).
- **Answer** sends a question card (`cards.questionSubmit`); the free text option is Custom Answer.
- **card** (decision, question, permission, state); **decision, question, form**.
- **permission mode** (`newSession.modeLabel` Permission Mode). Mode names are not translated: auto, plan,
  bypass, manual; the segments of a new session are Edits, Auto, Ask, Plan (`newSession.startModeShort.*`).
- **effort, ultracode**: Claude Code setting names, not translated. **Account Default Model**
  (`newSession.modelAccountDefault`), **Account Default** for effort (`newSession.effortAuto`).

**Screens and parts**

- **bubble**: a message in the transcript; **user bubble** for the user's own message.
- **popover**: the small view that opens from a header control (git, background, model, prompts). On iPhone it is a
  sheet, and a sentence that names it says sheet (`header.ultracodeHint`).
- **toast**: the short note at the edge of the screen about another session or after a form closes. The user reads
  it as a message: `network.toastClose` Closes the message.
- **inspector**: the right-hand side of the session screen (`inspector.button` Inspector, `inspector.label` Session
  inspector, `inspector.backgroundOpenInPanel` Open in Inspector).
- **tab**; **project note**; **Terminal** as the feature name (`terminal.title`), **in the terminal** for the herdr
  pane at the desk; **Pop-Up Terminal** for the terminal window (`terminal.shortcutPopupShell`).
- **Live Activity** (never "tile"), **Dynamic Island**, **Lock Screen**.
- **notification, push notification**; **test push**.
- **Usage**: the sheet of plan usage, as the `/usage` command (`list.usageSheetTitle`); **plan usage** in sentences;
  **plan limit** when it ran out (`network.signalKind.limit` Plan Limit); **5-hour window, week**; **per-model
  limit**; **resets** (`list.usageReset`); **As of %@.** (`list.usageSheetStamp`).
- **load, reading** (no reading); **CPU, memory, disk**; **pressure** for memory, **used** for disk,
  **1-minute average** for CPU (`list.macMetricNames.*.detail`); **high, critical** for levels.
- **dictation**, button Dictate (`composer.voiceMic` Dictate message).
- **shell, Clipboard** (Clipboard with a capital C, Apple Style Guide).
- **directory**, not "folder"; **branch, changes** (`inspector.changesTitle` Changes); **relative to HEAD**;
  **to push, to pull**; **new, modified, deleted** for files.
- **Resume, Fork, Restart**; **Launch** starts a new session (`newSession.launch`, the section is Start).
- **read, unread**; **unread result** in VoiceOver (`list.toneSpoken.unread`).
- **you're here** marks the current item (`switcher.here`, `sessionControl.promptsCurrent`).
- **app, Settings** (Settings is the iOS app).

**Pairing and the server**

- **server**: the Rarog server, the process `rarog serve` runs. The machine it runs on is the **Mac** or the
  **VPS** (see "The server's machine").
- **pairing, Pair**; **pairing link, pairing code, QR code**; **Forget Server** (`pairing.forgetServer`).
- **revoke a device** (`rarog devices` prints Revoked); **device key**; **keychain**, lowercase, the device's
  keychain; **Device ID, Access** (rows in Settings).
- **push relay, relay pass** (`app.banner.pushDegraded.passMissing`).
- **start screen, pairing screen**.

**Status words** are shared by the list, the cards, the switcher and the Live Activity, so each has one English word:
working; waiting; done (a session); finished (a task, agent, phase, workflow); error; interrupted; resumable;
starting; idle; unsupported; out of scope; read-only; out of date (never "stale"); stopped; failed; result unknown;
in progress; not started yet; not in plan.

## Not translated

- **Product and service names:** Rarog, herdr, iroh, Claude, Claude Code, Codex, Fable and other model names,
  Tailscale, tailnet, AirDrop, lazygit, git, Apple, iPhone, iPad. Rarog never changes form and takes no possessive:
  "Rarog settings", not "Rarog's settings". `app.appName` stays `Rarog`: a guard ties it to `CFBundleDisplayName`.
- **The language's own name:** `pairing.languageValue`, the value of the Language row in Settings, is the name of
  each column's language in that language (English, Polski), not a translation of the word "English".
- **Commands and literals the user types or sees elsewhere:** `rarog pair`, `rarog devices`, `rarog restart`,
  `/model`, `/usage`, `/clear`, `https://rarog.ai/pair#…`, `~/Projects/…`, `RAROG_HERDR_ROOTS`, `HEAD`, the effort
  value `xhigh`, tool names from the CLI (Bash, Edit). A guard checks that copy names `rarog pair` and `rarog devices`.
- **Keys and glyphs:** Esc, Tab, Ctrl, Cmd, Meta, ⌘, ⌃, ⌄; Escape as the VoiceOver name of the Esc key.
- **Units and abbreviations:** CPU, RAM, MB, the tags 5h and 7d, TS (tailnet). Kilobytes are KB (Apple), not kB.
- **Git words** used as such: commit, diff, HEAD. The `git` marker in the directory browser stays as is; the marker
  beside it is a catalog key (`newSession.historyMarker` history).

## The server's machine

The app's sentences about the machine that runs the Rarog server use one word for it: **Mac** when the server says
`macos` in `GET /api/version` (`system`), **VPS** for `linux`, `other` and a value the app does not know. With no
known system (before the first version probe and with nothing remembered, or a server without the field) the word
is Mac. Each sentence that names the machine has two keys: the base key says Mac, and `<base>.vps` says VPS, with the
same place and parameters. Polish inflects the word (na Macu, na VPS-ie), so the variant is a whole sentence, never a
word put into the base. Keys with a `.vps` variant:

- `list.macLineSpoken`, `list.macLineSpoken.empty`, `list.macLoadingNote`,
  `list.macLoadingSpoken`, `list.macSectionTitle`, `list.macTailnetSpoken`, `list.macUnavailableNote`,
  `list.macUnavailableSpoken`, `list.usageNoModelWindow`, `usage.serverUpdate.detail`;
- `composer.interruptFailed`, `terminal.closeConfirmSpoken`, `notes.offline`;
- `pairing.deviceCreator.mac`, `pairing.newDeviceNotice`, `pairing.newDeviceNotice.at`,
  `pairing.newDeviceNotice.fromMac`, `pairing.revokedBy.admin`, `pairing.serverName`, `settings.devicesFooter`;
- `liveActivity.macLine`, `liveActivity.spoken.mac`.

A variant may say less than its base when the base's extra clause only fits a Mac. `list.macUnsupportedNote` has no
variant: it appears only for a server without `GET /api/mac`, which is older than the `system` field, so its machine
is a Mac.

Before the first connection the app does not know the server's system, so the pairing screen names both:
`pairing.lead` "First device: run rarog pair on your Mac or VPS…". Key names with `mac` (`list.mac*`,
`liveActivity.mac*`, `pairing.*fromMac`, `pairing.deviceCreator.mac`) are internal identifiers, not copy.

## Parameters

- **The same parameters in every language**: count, types and positions; `l10n-check` compares each language with
  the English. `%@` is text, `%lld` an integer, `%02lld` an integer with two digits. Read the comment's parameter
  list to know what fills each one: `%@` often carries a finished phrase from another key, a clock or a server
  sentence.
- **Reordering only through positions.** When a sentence needs another order, number every parameter of that value
  (`%2$@ … %1$@`); never mix numbered and plain parameters in one value.
- **`%%` in a sentence with parameters, a single `%` in one without**, because a value without parameters comes
  back verbatim; `l10n-check` compares the `%%` count per language.
- **A server sentence in `%@` may be in another language** (`docs/localization.md`, "App × server version matrix"):
  the app's language when the app knows its code, otherwise the server's English, or Polish from an older server.
  `composer.sendResult` `%@ The message is back in the field.` puts a server sentence in `%@`, and the English adds
  only its own sentence. `header.modelChangeWarning` and `header.ultracodeHint` say what the server sentences
  `model.change-warning` and `model.ultracode-note` (`shared/src/sentences/model.ts`) say; keep their meaning in step.
- **Content in parameters keeps its language**: questions, options, tool names, session titles and device labels
  come from agents, the CLI and people. Do not build grammar around them (no article or agreement with `%@`).
- **No-break spaces.** Where the English keeps a space between a number and its unit, it is U+00A0:
  `header.filesCount` `%lld file`, `composer.bytes.*`, `notes.showAll`, `format.ago.*`, `terminal.pasteTooBig`.

## Plurals

- **English has two forms: `one` and `other`.** No `zero`, `few` or `many`.
- **Whole sentence in variations** (`variations.plural`): each form is a complete phrase and `other` keeps `%lld`.
  The `one` form may drop the number in a sentence that is read: `composer.voiceLimitSpoken` "One minute of recording
  left.", `liveActivity.spoken.moreWorkflows` "One more workflow" (the test `EnglishCopyTests` in RarogActivity
  builds that catalog and formats 1 and 2). On-screen counters keep the digit (`transcript.newPill` "1 new message",
  `header.filesCount` "1 file"), because a column of numbers is scanned, not read.
- **Substitutions** (`%1$#@name@`): the same name, `argNum` and `formatSpecifier` in every language; inside the forms
  the number is `%arg`. Word-only substitutions stay word-only: `liveActivity.waitingWord`, `workingWord`,
  `finishedWord` are the word under a big number (waiting, working, done), the same in `one` and `other`.
- **A plural where another language has none is allowed**: `liveActivity.moreWorkflows` "+1 workflow",
  "+2 workflows". `l10n-check` accepts it as long as the parameter set matches.
- **Agreement.** Prefer a participle to a verb: "2 waiting", "1 working". When a verb is needed, `one` says is and
  `other` says are (`liveActivity.spoken.waiting` "Rarog: 2 sessions are waiting for a decision").
- **Case keys collapse.** Some languages need one key per grammatical case; English often writes the same text in
  several: `format.spoken.*`, `format.spokenSince.*` and `newSession.spokenAgo.*` are all "%lld minutes";
  `format.spokenAgo.*` is "%lld minutes ago". Keep every key and its value, even when two values match.
- **One preposition, two meanings.** `activity.sinceSpoken` takes a duration ("for %@": for 2 minutes),
  `header.backgroundSince` takes a clock ("since %@": since 8:33 PM). The comment says which.
- **Big numbers.** A plural sentence formats with the language's locale, which writes 1,200; `CopyLookup.ungrouped`
  turns it back into 1200. Write nothing special. The only grouped number is the note counter (`notes.counter`,
  separator `notes.groupSeparator` `,`).

## Dates, times and other values that are not sentences

Unicode date patterns (`DateFormatter.dateFormat`), separators and characters are catalog values too
(`docs/localization.md`, "Dates, times and locale"). Day and month names come from the app locale.

| Key | English | Shows |
|---|---|---|
| `format.dayPattern` | `MMM d` | Oct 9 |
| `format.dayNumericPattern` | `M/d` | 10/9 (narrow field, 5 characters at most) |
| `format.dayYearPattern` | `MMM d, y` | Oct 9, 2026 |
| `transcript.timeGapDayPattern` | `EEE, MMM d` | Fri, Oct 9 |
| `transcript.timeGapSpokenDayPattern` | `EEEE, MMMM d` | Friday, October 9 |
| `format.dayClock` | `%1$@, %2$@` | Oct 9, 9:40 PM |
| `format.dayNumericClock` | `%1$@ %2$@` (U+00A0) | 10/9 9:40 PM |
| `app.list.*`, `liveActivity.list.*` | `, `, ` · `, `; `, ` ` | list separators |
| `app.sentence`, `liveActivity.sentence` | `%@.` | sentence end |
| `notes.groupSeparator` | `,` | 45,120 / 49,152 |
| `composer.quoted.name`, `.file` | `“%@”`, `“file”` | quoted attachment |
| `composer.bytes.megabytesTenths` | `%1$lld.%2$lld MB` (U+00A0) | 2.1 MB |
| `composer.bytes.kilobytes` | `%lld KB` (U+00A0) | 840 KB |
| `liveActivity.percent` | `%lld%%` | 42% |
| `composer.voiceClock` | `%1$lld:%2$02lld` | 4:05 |

`EnglishCopyTests` in RarogUI formats these patterns with `en_US` and checks what they show.

- **The clock is not in the catalog.** `CopyDate.clock` uses the `jmm` template with the app locale, so the device
  region decides: a US region gives `9:40 PM` (with a narrow no-break space U+202F), a Polish region gives `21:40`
  in English too. Every value around a clock must read well with both and leave room for three more characters.
- **Relative time** follows the iOS notification style in tight places (no space between number and unit) and
  spelled-out words for VoiceOver: `format.short.*` `12s`, `4m`, `2h 05m`, `3d`; `format.ago.*` `4m ago`, `2h ago`,
  `3d ago`, `just now`; `list.usageCountdown.*` `in 3d`, `in 2h 44m`, `in 38m`, `in 12s`, `any moment`;
  `format.spoken.*` `4 minutes`.
- **Words around a date follow the case of their line**: `notes.time` yesterday %@ (a lowercase status line),
  `pairing.revokedBody.when` %@ at %@.

## VoiceOver text

Keys that end in `Spoken` or `Hint`, and labels such as `composer.voiceMic`, are read aloud, so they are written for
the ear.

- **Full, natural phrases.** Words instead of symbols and abbreviations: phase 2 of 5, not 2/5; 42 percent; 5-hour
  window, not 5h; minutes, not min; a comma, not ·; "to", not → (`header.cliUpdateSpoken` Claude Code update from %@
  to %@: restart the session on the new release). A dash becomes a comma or a colon; VoiceOver pauses on both.
- **Labels** (what an element is): start with a capital letter, no period, no element type. "Play", not "Play
  button" (Apple, `accessibilityLabel`): `transcript.inlineImageLabel` Image in message.
- **Hints** (what happens on activation): a brief description of the result, third person verb, a period, without
  naming the gesture or the element (Apple, `accessibilityHint`: "Selects the message", not "Tap this row to select
  the message"): `composer.stopHint` Interrupts the agent's turn. Keys whose comment shows the text on screen
  (`newSession.directoryHint`, `pairing.scannerHint`) follow the body text rule instead.
- **Accepted exceptions.** `terminal.keyPadHint` names the gesture, because the arrow pad takes direct touch
  (`allowsDirectInteraction`) and the gesture is the instruction.
- **The second press of a two-step control.** A control that a hardware keyboard also reaches says press:
  `projects.closeArmed.closePanel` "Press again to close the pane.", `terminal.closeConfirmSpoken`. A control that
  only touch reaches says activate: `header.cliRestartArmed` "Restart the session? Activate again to confirm.",
  `cards.dialogConfirmSpoken`, `header.modePillSpoken.target`.
- **Fragments joined by code** keep the shape their comment asks for: lowercase when the key is a part after a comma
  (`liveActivity.spoken.working`), a capital when it opens the sentence (`transcript.rolePrefix.*` You, Agent,
  System), a period only where the value has one (`app.sentence` adds the others).
- **No shouting.** An all-caps word may be spelled letter by letter; write normal case except for acronyms (CPU, RAM,
  HEAD). Shortcuts in words: `projects.jumpSpoken` Command-L target.

## Tight keys

These keys have a fixed room; the comment says how much. Any change must fit the same room.

| Key | Room | English |
|---|---|---|
| `list.macMetricNames.*.short` | 3 characters | CPU, RAM, DSK |
| `list.usageWindowNames.{fiveHour,weekly}.short` | 3 characters | 5h, 7d |
| `list.usageCountdownShort.*` | 4 characters with the number | 3d, 14h, 2h44, 38m, <1m |
| `format.short.*` | counter field | 12s, 4m, 2h 05m, 3d |
| `format.dayNumericPattern` | 5 characters | M/d |
| `header.modeText.*` | mode pill, one word | auto, bypass, manual, plan, mode? |
| `header.modelUnknown` | model pill | model? |
| `header.backgroundSplit.*` | header pill | 2 working · 1 waiting |
| `header.ultracodeOn`, `Off` | two capsules in one row | On, Off |
| `list.codexTag` | row badge, one word | codex |
| `list.tailnetLabel` | two-letter tag | TS · %@ |
| `inspector.binary` | 3 characters | bin |
| `newSession.startModeShort.*` | 4 segments in one row | Edits, Auto, Ask, Plan |
| `newSession.historyMarker` | one short lowercase word | history |
| `switcher.hints.*` | one word beside a key | select, go, jump, close |
| `terminal.tabFallback` | tab label, 12 characters | terminal |
| `list.readToggleSwipe.*` | swipe action | Read, Unread |
| `activity.phaseHead`, `.titled` | stage line; a phase title over 24 is dropped | phase %lld/%lld |
| `liveActivity.limit.*` | 3 characters, Dynamic Island | 5h, 7d |
| `liveActivity.*Word` | word under a number, Dynamic Island | waiting, working, done |
| `liveActivity.percent` | Dynamic Island | %lld%% |
| `liveActivity.mac.*` | Lock Screen metric label | CPU, RAM, disk |
| `liveActivity.macLine` | Lock Screen line | `Mac` + 2 spaces + `%@`, keep both spaces |
| `liveActivity.usageLead` | one short word | usage |
| `liveActivity.moreWorkflows` | short; bold ends at the first space | +%lld workflow, +%lld workflows |
| `liveActivity.row.phase`, `.titled` | run line; phase title 24 by code | phase %lld/%lld · %@ |
| `liveActivity.staleNote` | one line | out of date · as of %@ |

Other places to watch for truncation: the session title on iPhone, the pills under the prompt field, the Mac labels
of the footer and the Dynamic Island. Attachment names are cut to 32 characters by code (`composer.quoted.*`).

## Usage descriptions

`NSCameraUsageDescription`, `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` stand in the
iOS permission dialog, outside the app. The English text is in the app's `Info.plist` and is the `en` value of
`InfoPlist.xcstrings`; `l10n-check` keeps the two equal.

- **Full sentences** that say when the device turns on, what it does, and where the data goes: "The microphone turns
  on only when you tap the microphone button to dictate, or while you talk with the voice agent. Dictation audio goes
  only to the speech recognition you chose on the “Dictation” screen. Voice agent audio goes to OpenAI, and only after
  you turn on “Voice Agent” in Settings."
- **A button by its exact title,** in quotes: "Scan QR Code" (`pairing.scan`). A button without a visible title is
  named by what it is: the microphone button (`composer.voiceMic`).
- **Commands stay as they are:** `rarog pair` (see "Not translated").

## Server sentences

The `RarogContract` catalog (`Copy/Localizable.xcstrings`) holds the sentences of the server's sentence registry
(`shared/src/sentences/`): keys `server.<code>` and `push.<name>`. Its English column is the registry's English
template, written by `node scripts/sentences-catalog.mjs --write`, so an English change goes into the registry,
not into the catalog, and follows this guide there. The Polish column is edited in the catalog; `--write` keeps it.
The comment names the arguments in the order of their positions (`%1$@`, `%2$lld`): `text` is content from agents
or people and keeps its language, `code` is another server sentence, `instant` a point in time, `int` and `plural`
numbers. `node scripts/sentences-catalog.mjs --check` and `shared/test/sentences-catalog-lustro.test.ts` keep the
catalog equal to the registry (see "Server sentence catalog" in `docs/localization.md`).

The app also composes a few of these sentences itself from the code, so they have no key in the `RarogUI` catalog:
the reason on a card for a terminal dialog the app cannot answer (`server.dialogs.refuse.<reason>`), the footer after
text the server cut (`server.transcript.truncation-footer`, a plural of the cut characters, starting with a line
break) and the label of the stand-in the server sends for an image that does not fit the transcript's image budget
(`server.transcript.snapshot-image-alt`). Translate them in the `RarogContract` catalog like every other server
sentence.

## Check

- `node scripts/l10n-check.mjs` checks every key in every required language: a `translated` value, the parameter set
  compared with the English, the plural forms of each language, and that the key is used.
- It does not check the glossary, capitalization, room or the VoiceOver rules. A reviewer reads those by hand, with
  this guide open:
  1. every glossary word and status word as listed;
  2. title case and sentence case by element type;
  3. tight keys within their room;
  4. VoiceOver text without symbols, hints in the third person with a period;
  5. no first person, no "we", no "click", no dash between two sentences on screen.
