# RarogUI: how it draws

Part of the app description: [native/Rarog/README.md](../README.md).

- **Split:** SwiftUI for navigation (`NavigationSplitView`, on the iPad the list stays next to the detail), the
  session list, pairing, banners and cards; UIKit where SwiftUI gives no control: the transcript and the message
  field. Files with UIKit or SwiftUI sit under `#if os(iOS)`; copy (`Copy/`), row models (`Model/`) and the markdown
  parser compile on macOS and have `swift test` tests (`RarogUILogicTests`).
- **Copy lives in the catalog** `Copy/Localizable.xcstrings` (`docs/localization.md`); the `Copy/UICopy*.swift`
  registry is a facade (`static var x: String { L("area.key") }`, `L("area.key", a, b)`). Plurals are variants of one
  key, a sentence stands whole in the catalog, and a list goes through `UICopy.list(_:_:)` ("Plurals" and "Sentences
  and lists" in `docs/localization.md`). Time and date come from `Copy/Formatting.swift` on the app locale. The tool
  verb dictionary lives only in `Copy/ToolActivity.swift`, the only exception of the CLI name guard. A sentence that
  names the server machine takes the word as a parameter (`UICopy.macSectionTitle(_:)`, `UICopy.revokedBody(_:_:)`…,
  a `ServerMachine`) and picks the base key or its `.vps` variant; views and models pass `store.state.serverMachine`
  ("The server's machine" in `native/Rarog/Localization/TRANSLATION.md`).
- **Transcript:** `SessionViewController` is a `UICollectionView` (compositional list) with a diffable data source and
  stable ids (`m<seq>.<block>`, `t<seq>`, `r<seq>`, `c<seq>`, `open`, `o<entry>`, `p<permId>`). The pure function
  `TranscriptRows.build` assembles the rows; a changed row is reconfigured and the rest stays, so a streaming reply
  rebuilds only the `open` cell, at most every 60 ms. `MarkdownCache.live` keeps the last version of the streaming
  reply, and the finished message takes it without a new render. A message text is ONE `UITextView` on TextKit 2
  (selection across the whole reply, tappable links); cards, tool lines and outbox statuses are SwiftUI in
  `UIHostingConfiguration`.
- **Entry in flight:** an outbox entry uses the same markdown render as its echo, so the bubble does not jump on
  confirmation. A shimmer runs across the dimmed bubble while the entry waits for its echo (`Session/PlateShimmer`),
  including an entry in the CLI queue (`pending(queued:)`), which can wait for minutes; VoiceOver hears the queued
  role prefix there (`UICopy.queuedRolePrefix`). With Reduce Motion there is no band, only the dimming. Not confirmed
  and a refusal stay dimmed, without the band, with a status row (`pending.status`); a queued entry gets one only
  while its queue is being taken back ("Queue take-back" below). All bands move in one phase: each
  starts at a cycle boundary of one shared clock (media time, `PlateShimmerClock`), so a new bubble, a reused cell
  and a band re-added after the app returns from the background join the others in step. An attachment-only entry
  gets the band over its tile (`EchoWaitShimmer`), on the same clock.
- **Turn boundaries:** 32 pt above a prompt, 10 pt between a prompt and the reply (Standard spacing; Relaxed scales
  them, "Transcript spacing" below). `TurnBoundaries` computes the
  boundary at the MESSAGE level, and the first VISIBLE row of the message block carries it (`TranscriptRow.turn`,
  `TurnGap`), including a time marker or the NEW line standing above it. A prompt is a human message
  (`isHumanPrompt`); a harness notice with the raw role `user` does not start a turn. Outside a boundary the row rule
  applies (a voice change 12 pt, a run of one voice 2 pt). A SwiftUI row cell is as tall as its content
  (`UIHostingConfiguration.minSize(height: 0)`), because the system minimum row height would center a short row in a
  taller cell; each row keeps its own touch target of at least 44 pt.
- **Prompt bubble, roles and time:** a prompt stands in a bubble on the LEFT, as wide as its content. The text lays
  out at min(column, the readable measure) minus 12 pt insets (`MessageContentView.plateCap`: 47.5 em in Standard
  spacing, 16 pt → 760 pt; 38 em in Relaxed, 608 pt), and the bubble
  background is a decoration as wide as the widest line from `usageBoundsForTextContainer`, so one layout pass, and
  the render cache key does not depend on the bubble width. A bubble with a code block, a table or a rule takes the
  full allowed width. There are no role labels on screen: spacing and the bubble carry the turn. VoiceOver always
  hears the role first (`UICopy.rolePrefix`), and the first row of each prompt has the header trait, so the rotor
  jumps between prompts. The time (`caption`, fixed-width digits, `muted2`) stands at the LAST row of a human message
  (`TurnMark.clock`): beside the bubble's last line when it fits (`MessageContentView.clockFitsBeside`), otherwise
  under it; VoiceOver reads it as "sent at".
- **Reply time:** a closed agent reply gets one time, its last agent text row's message time, ALWAYS under that
  row's last line, from the prose's left edge, 4 pt below (`MessageContentConfiguration.clockUnder`); the row grows by
  that line, and a reply ending in a code block keeps the time below the box. Same font and color as the prompt
  time; VoiceOver reads it as "replied at". A reply is closed by the next human prompt, and the last one once the
  turn is over (`TranscriptRows.turnEnded`: the session outside the turn states of `ActivityBand`, no card waiting
  for a decision, no streaming row); the time then appears without a reload. Text between tools, tool cards, notes,
  the streaming row and a reply without text have no time.
- **No Copy under a reply:** reply text is copied by selection, a code block by the icon in its bar.
- **Select More:** a system selection lives in one text view and does not cross cells, so the edit menu of a
  message text (`MessageContentView`, `textView(_:editMenuForTextIn:suggestedActions:)`) ends with Select More…, also
  in a table cell, whose own text field (`MarkdownTableView`) asks the message above it for that menu. It
  opens the Transcript Text window (`Session/TranscriptSelectionSheet`, `AppSheet.transcriptText`): one read-only
  `UITextView` with the loaded messages as plain text, a role and time header line per message and a blank line
  between messages, Markdown without markup, a table as tab-separated rows, a tool card as its line, an image as its
  VoiceOver label. The pure function `TranscriptSelectionText.build` makes the text when the window opens, so a reply
  arriving behind it does not change it, and nothing is fetched from the server. The cursor starts at the message the
  menu came from; Copy All and closing work as in terminal History. Tests: `TranscriptSelectionTextTests`,
  `TranscriptSelectionSheetTests`.
- **Tool card:** consecutive tool rows with nothing between them draw as ONE card: a `toolCard` fill, corners rounded
  only on the outside (`UnevenRoundedRectangle.block(top:bottom:)`), a one-pixel `border` line where rows meet. The
  chain is computed over ROWS, across message boundaries (live, each call can be a separate message):
  `ToolChains.mark` gives `.tool` and `.toolRun` a `ToolChainPlace` (alone, first, middle, last). Any other row breaks
  the chain, and so does a turn boundary or a voice change; an edit's mini diff does not. The run toggle
  (`UICopy.toolRunLabel`) is a row of the card. Each row is its own cell and VoiceOver element (`tool.<id>`,
  `transcript.toolRun`). There is no header with kinds and no error rows: the `ToolCallBlock` contract carries no
  result, and the client does not decide by tool name (that knowledge lives on the server).
- **Long prompt:** a human message longer than 15 lines collapses to 6 lines with a Show All · N lines button at the
  bottom of the bubble; expanded, it shows Show Less. The criterion is LENGTH, not paste detection: the server strips
  the `pasted_content` markers, and Rarog sends almost everything by pasting. Lines come from the text, not the
  layout (`PromptFolds.lines`): each source line is ⌈characters / 100⌉, an empty line is 1, a character is a
  grapheme, so the number does not depend on the width, font or rotation. It counts per text BLOCK. The fold
  (`PromptFold`) rides on the echo's text row and on the entry in flight by the same rule (`markPrompt`), so the
  bubble does not jump at the echo; the expanded state lives in the visit (`TranscriptReading.expandedPrompts`) and
  passes from the entry to its echo (`carryPrompts`).
  - **View:** the text view keeps its full height inside a window (`clipView`) clipped to 6 line heights
    (`MessageContentView.foldHeight`), with the bottom half line fading into the bubble (`PromptFoldFade`). So
    VoiceOver, selection and the code block icon get the WHOLE text, and expanding does not widen the bubble.
  - **Button** (`PromptFoldButton`): under the text window, `footnote`, `muted`, a target of at least 44 pt that never
    covers the last line when expanded; id `<field>.fold`. Expanding keeps the TOP of the bubble in place, collapsing
    keeps the bottom of the row, so the button stays under the finger (`togglePromptFold`); a pinned transcript stays
    pinned. The prompt bar and the "Prompts in This Session" list show the prompt shortened. Tests: `PromptFoldTests`.
- **Markdown (own parser, no dependency):** `MarkdownParser` (blocks) and `MarkdownInlineParser` (code, links, bare
  addresses, emphasis, strikethrough, `\*` escapes) → `MarkdownLayout` (paragraphs with a role, gap and quote depth)
  → `MarkdownRenderer` (iOS: `NSAttributedString`, Dynamic Type through `UIFontMetrics`). Everything except the last
  step has macOS tests.
  - **Sizes and ink:** transcript text `callout`, 16 pt; a table 13 pt; a code block 14 pt monospaced; inline code on
    `inlineCodeBackground` in the warm `inlineCodeInk`. An agent reply uses `Palette.prose` and its bold and headings
    `Palette.strong`, so bold stands out by lightness; in the light theme both are `text`.
  - **Question to the user:** a paragraph from a bold `MarkdownQuestion.markers` entry (`Do Ciebie:` or `To you:`)
    to the end of the text stands behind a 3 pt `wait` bar (`MarkdownLayoutFragment.questionBar`), only in an agent
    reply (`MarkdownRenderer.Style.questions`).
  - **Fold:** `MarkdownFold.fold` decides what a collapsed message shows. Lines are source lines with a visible
    character. Up to 12 lines the text stands whole; a longer one gives its first paragraph (the first 4 lines when
    it does not start with a paragraph), the question block to the end, and the number of lines hidden between
    them. A question in the first block, or a fold that would hide fewer than 2 lines, leaves the text whole.
    No screen calls it. Tests: `MarkdownFoldTests`.
  - **Links:** a `https://claude.ai/…` address gets `#no_universal_links`, so the browser opens it, not the Claude app
    (`BrowserLinks`).
  - **Decorations:** `MarkdownLayoutFragment` draws the rule, quote bars and the inline code background (4 pt
    corners; `.kern` makes room for the side margin, so the background does not cover punctuation). The code block
    background with its bar is a view UNDER the text (`CodeBlockBox`), because fragment views lie above the selection
    highlight. Pixel test: `CodeBlockTests`.
  - **Table:** a TextKit 2 attachment with a horizontally scrolling view (`MarkdownTableAttachment`) and its OWN text
    view (`MarkdownTableText`: a row is a paragraph, columns on tab stops). It selects as in a browser, and a copy goes
    by cells (`MarkdownPlainText.tableCopy`). Tests: `MarkdownTableTextTests`, `MarkdownTableSelectionTests`.
  - **Plain text:** layout characters carry `MarkdownReplacement`, so the clipboard and VoiceOver get the text, not
    the layout (`MarkdownPlainText`).
- **Prose leading:** paragraphs, list items, quotes and headings stand at 1.5 times the font size (16 pt → a line
  every 24 pt) at every Dynamic Type size, through `lineSpacing` (`ProseLeading`): `minimumLineHeight` and
  `lineHeightMultiple` would put the padding ABOVE the glyphs, also above a first line. The padding is computed from
  the NATURAL line spacing of the TextKit 2 layout, measured once per typeface and size, not from `UIFont.lineHeight`
  (TextKit 2 sets 16 pt lines every 21 pt, the metrics say 19.09). `TextKitTypesetProbeTests` checks these facts.
- **Prose width:** paragraphs, list items, quotes and headings end at most the readable measure of the text font
  from the content edge (`TranscriptSpacing.readableEm`, per density: 47.5 em in Standard, 16 pt → 760 pt, where the
  widest prompt bubble ends; Relaxed below). Code blocks, tables, rules, tool cards and diffs span the whole column.
  The limit is a fixed positive `tailIndent` (`MarkdownRenderer.tailIndent`) counted from the container edge and
  clamped to it, so on the iPhone lines wrap as without the limit, and a rotation changes only the TextKit 2
  container: the text is not rebuilt, the selection stays, and the render cache key does not depend on the width.
  Settings → Text Size → Transcript Width chooses Readable (the default) or Full Width per device (`TranscriptWidth`,
  key `rarog.transcriptWidth`): full width sets `MarkdownRenderer.Style.fullWidth` on agent replies and notices, so
  their prose runs to the container edge (`TranscriptSpacing.proseCap(fullWidth:)` is `nil`); the prompt bubble and
  the quote bar keep their cap. The mode is part of the style, so of the render cache key, and of `TranscriptLook`;
  the session screen follows it (`TranscriptWidth.follow`) and rebuilds its cells at once.
- **Transcript spacing:** Settings → Text Size → Transcript Spacing chooses Standard (the default) or Relaxed per
  device (`TranscriptDensity`, key `rarog.transcriptDensity`; no entry or an unknown value means Standard). Both
  read one token table, `TranscriptSpacing`: Standard is the base and draws exactly the values above. Relaxed
  multiplies every vertical gap BETWEEN elements by one factor, 1.25, rounded to whole points: the turn gaps
  (32 → 40, 10 → 13, photos under the bubble 4 → 5), the row rule (voice change 12 → 15, a run of one voice 2 → 3,
  the bottom margin 2 → 3), a time marker 14 → 18, and the markdown gaps in em (`MarkdownGap`: item 0.3 → 0.375,
  paragraph 0.65 → 0.8125, block 0.85 → 1.0625, section 1.5 → 1.875). One factor keeps the order turn > voice
  change > run and section > block > paragraph > item, and a Relaxed paragraph break stands at least 1.5 line
  pitches (WCAG 1.4.8). The side margin of transcript content grows with the column: 16 pt in Standard; in Relaxed
  20 pt below a 600 pt column, 24 pt from 600 pt, 32 pt from 840 pt. The column is the list's width without its side
  safe areas. Every cell keeps its own 16 pt; the rest is an inset of the list section around the cells
  (`SessionViewController+Spacing`), measured from the side safe areas and asked on every layout pass and safe-area
  change, and the quote bar follows the same margin. The foot follows it too: in Relaxed the field card, the
  activity row's own card, the dock and the state card stand at the transcript's margin from the safe area, so their
  edges line up with the content. Each keeps its own 10 pt (`ListFooterMetrics.cardSide`); the rest is a margin of
  the foot stack's arrangement (`SessionViewController.placeFootSides`), so the stack itself, the container of the
  soft scroll edge, keeps the full width. Standard keeps the foot at its own 10 pt. Relaxed also narrows the readable
  measure to 38 em (16 pt → 608 pt, about 82 characters of average text, near the 80 of WCAG 1.4.8): readable prose,
  the prompt bubble and the quote bar end there, in both width modes for the bubble and the bar; code blocks and
  tables still span the column. Line height (1.5), the insides of elements (bubble, code block, table, tool card
  padding) and the header stay as in Standard. The density is part of `MarkdownRenderer.Style`, so of the render
  cache key, and of `TranscriptLook`; the session screen follows it (`TranscriptDensity.follow`), rebuilds its cells
  and asks the layout for the new insets at once; hosted rows read the tokens from the `transcriptSpacing`
  environment value.
- **Syntax highlighting:** `Markdown/SyntaxHighlight` is an own token scanner without dependencies: language families
  with word lists (JS/TS, JSON, shell, Python, Ruby, Go, Rust, the C family, SQL, CSS, YAML/TOML/INI, HTML/XML tags,
  diffs; aliases in `familyByName`), a cap of 40,000 characters, one pass without backtracking, output in UTF-16
  ranges. `MarkdownLayout` highlights the WHOLE block, so a block comment and a heredoc cross lines. Finished blocks
  take tokens from `SyntaxCache` (64 blocks, 250,000 tokens, LRU). The renderer sets one color attribute per token
  (`Palette.syntax`), so selection, the clipboard and VoiceOver see the same code. A shell command in a tool card and
  a permission card with `inputKind: shell` (not a plan) are colored; under a pending decision the transcript falls
  back to the line ink (`MarkdownRenderer.withoutSyntax`), because dimmed colors would not keep 7:1. Tests:
  `SyntaxHighlightTests`, contrast in `PaletteContrastTests`.
- **Copying:** the code block icon (`Session/Copy/CopyButtons`) is an ordinary button ABOVE the text; the
  confirmation is a checkmark for 1.6 s, a failure says so in a sentence. After a copy by pointer the focus returns to
  the message field (`SessionViewController+Copy`).
- **Reading the transcript** (visit state `TranscriptReading`): a tool card expands its full input; an edit stands
  with its mini diff open (12 lines, the tail behind "… N more lines"), and a decision card collapses such diffs ONCE.
  A run of 3 or more tool-only messages collapses to the newest step with the `r<seq>` toggle (see "Tool card").
  - **Markers** are separate rows: `t<seq>` is a `— HH:MM —` separator after a gap of 10 min or more (not above a
    prompt or a tool step), and a calendar day change gives the date (device time zone; tests inject the calendar).
  - **The NEW line** (`new`) is decided on a fresh state from the server and then stays.
  - **Dimming:** under a pending decision every cell except the cards dims, but ink never drops below 7:1
    (`Model/TranscriptDim`).
- **Bottom of the transcript:** the list reaches the bottom of the screen and the foot floats over it
  (`SessionViewController+UnderFoot`). The foot is one stack (`footStack`): the narrow activity card
  (`FootActivityCard`), the field card, the decision dock and the state card. `adjustedContentInset.bottom` is the
  distance from the top of the foot stack (`footTop`: the field card, whose first line is the activity band open for a
  turn, or with the field hidden the narrow card's reserved band) to the bottom of the view plus 12 pt
  (`transcriptBottomInset`, `FootRest.transcriptInset`); the scroll indicator gets the same inset. The foot carries
  the system soft scroll edge over the transcript (`UIScrollEdgeElementContainerInteraction`, bottom edge). An inset
  change keeps the offset while it stays in the legal range, otherwise the offset comes down to the bottom. The Scroll
  to Bottom button and the toast hang 8 pt over `footTopAnchor`. Card choice and focus rescue use only the part
  above the foot (`uncoveredCells`). Tests: `TranscriptUnderFootTests`.
- **Pinned to the bottom** is layout state: only a gesture changes it (within 40 pt of the bottom = pinned); growing
  content, a card and the keyboard do not, and sending pins. The bottom arrives in ONE frame (`settleAtBottom`): the
  list lays out, goes to the bottom and repeats until the content height settles (at most 5 passes, no animation).
  An animated Scroll to Bottom jump suspends the automatic descent until its animation ends (`jumpAnimating`).
  - **Scroll to Bottom button** (`JumpToBottomBar`): an arrow in a 36 pt circle, no title, a 44 × 44 pt touch target;
    the name goes to `accessibilityLabel` and `largeContentTitle`. With a decision outside the dock it is named Scroll
    to Decision, and only the arrow and the outline change, to the waiting color. Shown when unpinned, its jump pins,
    and it disappears at once after a tap. Its background is always an explicit color, because `nil` in a button
    configuration means the tint color, which is the text color here.
  - **New messages pill** (`NewMessagesPill`): at the top when the NEW line lies above the screen
    (`NewMarkerDecision.pill`); its height comes from its own insets (`verticalInset`), not from the circle. Only the
    line coming on screen under a gesture or a tap removes it.
  - **Reading position** when unpinned (row plus offset, not pixels) lives in process memory
    (`TranscriptPositionMemory`, 32 sessions): a return to the session and a window size change go back to that row,
    and every manual content change updates it (`TranscriptReading.takeMoved()`).
- **Terminal navigation (`Model/Navigation+Terminal`):** the route `.terminal(id)` (a tab, a notification target with
  `termId`) and `.openingTerminal` (the invite = slot 1; New Terminal and Cmd+Shift+N = `slot: next`).
  - **Identity:** `terminalRoute(state)` gives the session target and the screen IDENTITY (the view's `.id`). The
    first `POST` reply moves the New Terminal route to `.terminal(id)` with the same identity (`terminalIdentified`),
    so the controller, the session and the socket stay; a terminal the server moves under another id does the same. A
    New Terminal view rebuilt BEFORE the first reply does not ask for `next` again (`claimsOpening`); it says it is
    unknown whether the terminal was created and offers Try Again. A Codex entry with `termId` draws its terminal with
    the same identity as its tab. Navigation remembers the directory of a terminal `GET /api/term` does not list yet
    (`terminalCwds`). The screen's "×" (`terminalClosed`) goes back to the project's last active session, then another
    session, then the list (`AppState.terminalExitSession`).
  - **Tab bar** (`projectTabModels`): sessions oldest first, then terminals by slot with a
    glyph and the process label (at most 12 characters), without a state tone; Codex with `termId` has no tab of its
    own. The bar, the Cmd+1…9 numbering and taps use one list (`stripTabs`). A project without a terminal shows the
    invite (`tabs.terminal-invite`); with `termEnabled: false` it is dimmed and a tap explains that the server has the
    terminal off; without the version probe it is absent (`AppState.terminalFeature`). "+" is a menu with New Session
    and New Terminal; New Terminal states in a sentence that creating is blocked or all 4 slots are taken
    (`terminalRefusal`). The terminal list refreshes at least every 5 s while a detail is on screen (`watchTerminals`).
    The bar's look: `docs/design.md`, "Tab bar in the session header".
  - **Windows Cmd+F (`popup`) and Cmd+G (`lazygit`):** `togglePopup` toggles the pair (role, project), one window at a
    time. A Cmd+F window whose `popup` pane the terminal list knows connects without `POST`
    (`AppState.projectPopupTerminal`); lazygit and an unlisted window go through `POST`. The header's Pop-Up Terminal
    icon (`header.terminalPopup`) has the same action and gate (`canTogglePopup`); on a phone terminal screen it
    moves into the "⋯" menu. The terminal glyph in a project header of the tree (`tree.terminal.<name>`) toggles the
    window for that project (`togglePopup(_:in:state:)`), shown only while the terminal is on. While a window is open,
    Cmd+F and Cmd+G act on its project, not on the one on screen, also with no project on screen. A screen change
    closes the window, and an open window blocks Cmd+1…9.
  - **Window** (`Terminal/TerminalWindow`): a sheet over the whole split view, a `UINavigationController` with
    `TerminalPopupController` as root (UIKit, so UIKit tests can check terminal focus and Esc). The close button on the
    LEFT only detaches; the "×" of a route kills the shell. The bar title is "KIND project" as in the other windows
    (`terminal.popup.title`). Size: the shared window frame (`windowFrame(width:)` in `SheetScaffold`, measured from
    the app WINDOW); the terminal fills the window below the bar, 8 pt from the sides, with the bottom gap from the
    corner radius the system reports (`WindowLayout.terminalBottomInset(radius:)`). The window takes the keyboard in
    `viewIsAppearing` and again in `viewDidAppear`.
  - **Esc** (`EscapePolicy`, `Views/Presentation/EscapeDismiss`): it closes the shell window (Cmd+F); in the lazygit
    window (Cmd+G) it goes to the program as an ESC byte while the program lives, otherwise it closes the window.
    Cmd+. and the key bar's Escape key give the byte in the shell window. One decision covers both key paths
    (`TerminalScreenViewController.takeEscape`), a sheet above the terminal goes first (`PresentedSheet.above`), and
    Esc commands do not repeat (`repeatBehavior`): a held key must not close the next layer, interrupt a turn or deny a
    card under a closed window.
  - **History** (`Terminal/TerminalHistorySheet`, `TerminalHistoryModel`): a read-only `UITextView` scrolled to the
    end, the row count, the 1000 line cut and a button to load up to 5000 lines. From a route it is an app sheet; from
    the terminal window it is a PAGE of that window (`TerminalHistoryPage`): the terminal stays the root with the same
    connection and sends nothing while the page is on top (`inputSuspended`). Both draw `TerminalHistoryBody`. After
    loading, the text takes the keyboard (`SheetKeyboardAnchor.handKeyboard`), so Cmd+A and Cmd+C work at once.
- **Terminal screen** (navigation plugs in the route, tabs, history and windows; see "Terminal navigation"):
  `Terminal/TerminalScreenViewController` is the surface and the key bar in one stack pinned to `keyboardLayoutGuide`;
  while the on-screen keyboard slides, the surface moves with the key bar and its grid changes where it is out of
  sight (see "Size").
  "⋯" (Copy, Paste, History) and "×" stand in the navigation bar's icon group (`TerminalChrome` for
  `HeaderSessionSlot`). Keys draw at 36 pt in a 44 pt target (Paste is a `UIPasteControl`, which takes touches only on
  itself). The status line overlaps the top of the surface, so connection messages do not change the grid; otherwise
  every connection and gesture would give two SIGWINCH in the pane.
  - **Surface:** the `TerminalSurface` protocol (`SwiftTermSurface` from `RarogTerminal`), created from a target
    (`store.terminalSession(target)`) or an existing session, and handed to SwiftUI through `TerminalScreen` in a NEW
    `TerminalScreenHolder` each time the tab shows. `shutdown()` closes the socket, drops late results and releases
    the renderer (`TerminalSurface.close()`, because SwiftTerm's `CADisplayLink` would keep the emulator in memory).
  - **Kitty graphics** enter the emulator only with the content inside the sequence (`t=d`):
    `KittyFileTransmissionFilter` breaks commands from a file (`t=f`), a temporary file (`t=t`) and shared memory
    (`t=s`), with their continuations, before SwiftTerm runs them: no `stat`, no image, no reply. Paths from a herdr
    pane point to Mac files. The filter tracks SwiftTerm's parser state between chunks and buffers no bytes.
  - **Screen parking.** Leaving a tab and closing a Cmd+F/Cmd+G window do not end the screen at once: the tab
    container (dismantle of `TerminalScreenHolder`) and the window (`TerminalPopupController.dismantle`) hand it to
    `TerminalScreenParking` (created next to the store in `RarogApp`). A screen with a live session waits up to 2 min,
    at most 4 at a time, a tab under its terminal id and a window under `.popup(ProjectPath.normalized(cwd), role)`;
    the ledger (`TerminalParkingLedger`) is pure logic. A return takes the same screen, session and socket; a window
    builds a NEW `TerminalPopupController` around it. `park()` gives up the keyboard, suspends input and detaches the
    callbacks; `activate(parkedFor:resumesInput:)` reattaches them and leaves a trace. A screen without an id, after
    `shutdown()` or with a session that is not reusable (`isReusable`) ends at once, and so does everything when the
    scene goes to the background, on a memory warning and on logout. The order of SwiftUI make and dismantle is not
    guaranteed: parking remembers the last screen issued under a key, an older screen parked under the key of a newer
    one ends (one socket per terminal), and a window acts on the screen only while it is its child (`holdsScreen`).
    Bytes reach the emulator outside the window, and after the return the view draws the current screen
    (`SwiftTermSurfaceParkingTests`).
  - **Closing:** a second press of "×" sends `DELETE`. A refusal keeps the screen and reconnects; no reply ends with a
    sentence and Try Again without reconnecting, because a `POST` would create a new shell if the `DELETE` did arrive.
  - **Input:** one input path (`sendInput`: armed modifiers of the bar → `in` frames) and a separate paste path
    (`paste` → `pa` frames). The surface NEVER wraps a paste and never guesses mode 2004; SwiftTerm's `paste(_:)` is
    overridden, and the edit menu, Cmd+V, `UIPasteControl` and a text drop hand over the raw clipboard text.
  - **Size:** `ResizeSettler` (pure logic) lets through the last size after 250 ms of quiet, within 1…1000 and on an
    active scene. Surface focus on a live socket marks the next settled `rs` as forced and restarts the quiet: the
    on-screen keyboard that comes up after the tap extends it, so ONE `rs` with `force` goes out, with the grid after
    the keyboard (an `rs` with the old grid would make herdr redraw the old screen into the smaller grid). Without a
    layout change the same grid goes out again, because after another client of the same terminal leaves, the pane
    keeps that client's size and the server does not say so. When that quiet ends on an inactive scene, the forced
    `rs` waits and goes out after the scene's activation. Before the socket is live focus adds nothing: the
    opening socket sends its own forced `rs`. A new socket resets the emulator before the first bytes.
    The surface (`SwiftTermSurface.layoutSubviews`) does not pass a layout to SwiftTerm while the view is smaller
    than one cell or its scene is not `foregroundActive`: grid and content stay and `onResize` does not fire,
    because without history (`scrollback: 0`) a smaller grid drops the top rows for good. On its scene's activation
    the surface lays out again. A view without a window or a scene lays out as usual, and so does the first layout
    of a new surface: there is no content to keep yet and a new socket takes its grid from the layout.
    The container places the surface itself in every layout pass and clips it (`placeSurface()`,
    `TerminalScreenViewController+Keyboard`; rule: `TerminalKeyboardSlide`), so the on-screen keyboard changes the
    grid only where the change is out of sight. Keyboard up (a layout pass inside an animation that brings the
    keyboard layout guide above the safe area, with no hardware keyboard and the stack not held by a closing
    window): the surface keeps its height and, in the keyboard's animation, its top moves up by the rows SwiftTerm
    will drop from the top (`TerminalSurface.rowsLeavingTop(shrinkingTo:)`: rows below the cursor go first, the rest
    leaves the top), so the text travels with the key bar and the top rows go under the container's top edge. At the
    end of the slide (`keyboardDidShowNotification` or `keyboardDidHideNotification`) the surface takes the
    container's height without animation: the grid shrinks then and draws the same rows in the same places. A
    settler quiet that ends during the hold waits for that end, so a tap still gives ONE `rs`, with the grid after
    the keyboard. Keyboard down: the surface takes the final height at once, outside the animation; the grid grows
    in the first frame and the new rows wait under the key bar until it slides away. Any other layout (rotation,
    split view, a hardware keyboard and its shortcut bar, the keyboard already up, a width change during the hold)
    resizes the surface in the same pass, as part of its animation. Edge bands of a held surface stop at the
    container. The surface's scroll edge effects are off: a held surface stands under the header, and the top
    effect blurred the rows going up. The rise comes from the cursor in the layout pass that changes the container:
    output that moves the cursor many rows further into the slide makes the text jump at its end. If the hold ends
    before the keyboard arrives (it turns back), the waiting `rs` still goes out after a new quiet.
    The surface layer does not scale its drawing to animated bounds (`contentMode = .topLeft`): the text
    stands at its final size and place, and a strip the drawing does not cover shows the layer background in the
    terminal's theme colour. SwiftTerm's own layout runs without animation, so the caret jumps to its row instead of
    sliding across the text (`SwiftTermSurfaceKeyboardAnimationTests`, `TerminalKeyboardSlideTests`,
    `TerminalKeyboardSlideScreenTests`).
  - **First screen:** the first screen of every fresh socket collects bytes for 80 ms from the first byte
    (`firstScreenWindow`), then a `reset` and all `feed` calls in one pass, so SwiftTerm paints them in one frame and
    the server's full frame joins the program's redraw after SIGWINCH. A retry, suspend, disconnect or error discards
    the window, `exit` flushes it, and typing during the window goes out at once.
  - **Opening trace** (`TerminalOpenTrace`): the first screen of a fresh attempt leaves one `client.log` line with the
    `terminal:` prefix and the time to the first screen split into `POST`, socket, first bytes and the window. Numbers
    and fixed words only, a sub-budget of 6 per hour (`TerminalOpenTraceBudget`) within the app's 20 per hour; a
    screen from parking writes its own line with the parked time.
  - **Return trace** (`TerminalReturnTrace`): from `UIScene.willDeactivateNotification` (handled at once on the main
    thread) the screen notes every grid change and every layout the surface skipped, each with the scene state at
    that layout: `a` active, `n` inactive in the foreground, `t` background. Only a return from the background
    writes lines; deactivation and activation without the background drop what was noted. From the scene's
    activation it samples the layout every 50 ms and on every grid change for 3 s, then writes up to three
    `terminal:` lines. The first holds the background section (`n134×26` for a grid, `n~410pt` for a skipped
    layout with the height of the surface view; repeats in a row merge, at most 6, the rest as `+N`), the first
    screen of the new socket and the byte chunks after it (closer than 100 ms merged, at most 6). One or two layout
    lines follow with the samples in order. A sample holds the surface container height, `x` and `y` of its top left
    corner in window coordinates, the grid, `p` (`contentOffset.y`) and `w` (`adjustedContentInset.bottom`) of the
    surface view, `k` (keyboard layout guide above the bottom of the screen view) and focus. Equal samples merge;
    the first sample of a line lists every field, the next ones only the fields that changed. All times are ms from
    activation. `RarogStore.trace` keeps 200 characters, so every line stays within 200: the first line drops byte
    chunks from the end, then elements of the background section, and the last layout line drops samples (also
    those beyond 12); what is dropped becomes a trailing `+N` count. Read-only, numbers only, a
    sub-budget of 4 returns per hour (`TerminalReturnTraceBudget`, one check per return). A parked, shut down or demo
    screen, or one without a window, collects nothing; a new background or shutdown inside the window drops it
    without a line.
  - **Key bar** (`TerminalKeyBar`, `TerminalArrowPad`): only without a hardware keyboard (`TerminalKeyboard.isConnected`
    over `GCKeyboard.coalesced`; in Debug `RAROG_UI_TEST_NO_HW_KEYBOARD=1` fakes its absence and
    `RAROG_UI_TEST_HW_KEYBOARD=1` its presence, because the simulator reports a hardware keyboard inconsistently).
  - **Hardware keys** (`TerminalSurfaceContainer`, map `TerminalKeyMap`): Cmd+. = Esc, Cmd+←/→ = Home/End in SS3,
    Cmd+↑/↓ = PageUp/PageDown, Cmd+K = Ctrl+L (the shell clears the screen like `clear` and keeps the typed line),
    Cmd+letter = Meta except the app's letters (`TerminalKeyMap.appLetters`), Cmd+Y =
    History, Cmd+X = the terminal's "×" (the first press arms, the second within 5 s closes the shell; off in the
    Cmd+F/Cmd+G window through `closesByKey`).
  - **Arrow repeat** (`TerminalKeyRepeat`): the surface, not SwiftTerm, repeats hardware arrows: the first at once,
    then every 33 ms after 300 ms, bytes 1:1 with SwiftTerm's non-kitty path (`TerminalKeyMap.arrowBytes`). The series
    stops on the release of THAT arrow (`TerminalSurface.hardwareKeysEnded`), a new key, focus loss, leaving the window
    or a keyboard disconnect; the fallbacks are `GCKeyboard` and a 20 s cap. A fallback in the `client.log` trace
    means the release did NOT reach the container.
  - **Selection** has two paths. TOUCH: SwiftTerm's taps ×1/×2/×3 and long press with its menu. POINTER (trackpad,
    mouse): the surface's own recognizer (`pointerSelection`, `TerminalClickCounter`) works as on a Mac: a click clears
    and sets focus, a drag selects by cells, ×2 by words, ×3 by rows, no menu on release. Two fingers scroll and clear
    the selection. The selection covers the visible screen; longer text comes from History.
  - **Copy:** every path (Cmd+C, Copy in the selection menu, the key bar and "⋯") ends in
    `TerminalScreenViewController.handleCopy`: it copies the selection or the visible screen, removes the selection
    (`TerminalSurface.clearSelection`) and reports "Copied to the Clipboard." as an app toast in the confirmation style
    (`onCopied`, wired by the tab and the Cmd+F/Cmd+G window to `ToastCenter.confirmation`). An empty screen still
    reports in the status line, and so does a screen whose host has no toast center.
  - **Status line** (`TerminalStatus`) states each state in a sentence and offers Restart or Try Again only by gesture;
    every `err` is the server's sentence. Paste from the "⋯" menu reads the clipboard in code, so iOS may ask.
  - **Font** (`TerminalFontSize`): Menlo 13 pt on the iPad and 11 pt on the phone, with the Symbols Nerd Font Mono
    cascade (see "External dependencies"), at the system's text size. The app's text size moves it like body text:
    points = 13 or 11 × body(effective category) / body(system's category), rounded to a whole point
    (`TerminalFontSize+TextScale`, both categories passed as traits), so with no step stored, or the system at an
    accessibility size, it stays 13 and 11 pt; neighbouring steps may round to the same point. A step reaches the
    living surface on the next turn of the main actor (`SwiftTermSurface+TextScale`, Observation of `TextScale`):
    the four Menlo fonts change and the next layout changes the grid like a rotation, one `onResize` and `rs`, without
    a new connection or a reset of the terminal's modes; a parked surface resizes when it returns. The history sheet
    keeps its own scaling (`UIFontMetrics` of body text). Tests: `RarogTerminalTests/TerminalFontScaleTests`.
    Content stands 8 pt from the sides (`sideInset`) as the SwiftTerm view's frame, not a content inset, so columns
    and selection points hit the same cells (`TerminalScreenInsetTests`). In the Cmd+F/G window `TerminalEdgeFill`
    paints that gap with the color of the outermost cells (`TerminalEdgeReader`).
- **Harness notices:** a message with a `notice` field is one `harnessNotice` row in the system voice, without the raw
  entry. The wire `role` stays `user`; the effective role comes from `TranscriptMessage.effectiveRole` and
  `isHumanPrompt` (RarogCore, `EffectiveRole.swift`), and anyone looking for human messages asks there.
  `UICopy.harnessNotice` composes the sentence from server facts (kind, result, name, exit code). A missing result
  says the result is unknown, not success; the `waiting` result gives a waiting subagent a calm sentence.
- **Prompt blocked by a hook:** a `system` message with a `promptBlocked` field is a `.promptBlocked` row (`m<seq>.b`,
  `Model/PromptBlockedRows`, `Rows/PromptBlockedRowView`): a `wait` triangle, a fixed title, the hook's reason and an
  optional quote of the prompt; over 8 lines it folds like a long prompt. The Restart and Send button stands only
  under the notice whose `seq` matches `SessionSummary.promptBlocked`; one tap, no arming (the server checks the
  gates). A refusal stands as the server's sentence under the button, and the button stays; the screen keeps the
  outcome by the block `id` (`TranscriptUIState.promptBlocked`). Tests: `PromptBlockedRowTests`,
  `PromptBlockedUITests`.
- **Images in messages:** a `media` row: consecutive `image` blocks as one gallery, message attachments as one row
  under the content (`m<seq>.a`). A tile keeps the image's aspect ratio (`ThumbnailGeometry.tileSize`): 96 pt high,
  up to 256 pt wide, down to 48 pt high for wide images, and cropped (never with empty bands) outside 16:3…1:2. The
  skeleton and the "Photo" tile (a 404) are 96 pt, so loading changes the row height only for wide images. A tile has
  the identity of its content key (`.id(key)`), so a reused cell never shows an old image. ImageIO decodes off the
  main actor; decoded thumbnails stay in memory until the end of the login (`cacheKey(sessionId:)`). A tap opens
  QuickLook inside the app's navigation (`ImagePreviewNavigation`), because QuickLook presented alone exposes no
  close button to VoiceOver.
- **Outbox entry attachments (`Model/PendingMedia`, `Rows/PendingMediaRowView`):** the `attachments` row (`a<entry>`)
  has the layout of the echo's image row, so nothing jumps on confirmation. An image in transit has a dark overlay
  with a thin white ring (`PendingIndicator`): a spinning arc while preparing, a ring filling with the byte fraction
  while uploading, and a fade at the 202. Not confirmed and a refusal put a warning triangle in place of the ring; a
  file chip has the same ring in place of its icon. VoiceOver hears the name and the state with a percentage. The
  echo takes over the decoded image in the render in which the entry settled (`EchoThumbnailHandoff`), only when the
  message is still the entry's echo.
- **Message field** (`ComposerView`) stands on `view.keyboardLayoutGuide`: above a raised keyboard (also a floating
  one) the foot ends at its top.
  - **Shortcut bar pill:** with a hardware keyboard iPadOS reports the shortcut bar pill as a guide across the whole
    window, so the height decides: a guide lower than 150 pt (`FootRest.shortcutBarMaxHeight`) lets the foot go under
    it, to rest. A `client.log` trace (up to six lines per process) gives the guide's size and the field's gap.
  - **At rest** the field card (or the dock or the state card in its place) ends `ListFooterMetrics.bottomGap` from
    the bottom of the screen; the list footer bar's text ends 1 pt above it (the gap minus `contentDrop` 3 pt plus
    the 4 pt padding), so on the iPad both meet one line:
    `FootRest.gap` (`safeBottom > 0 ? max(12, safeBottom − 16) : 8`) with a 14 pt floor. The 10 pt band under the
    card (`ComposerView.bottomInset`) is part of that distance and the air over a raised keyboard. `SessionScreen`
    and the detail background ignore all safe area regions; with the container's safe area alone SwiftUI would count the
    shortcut bar pill as a separate region and the field would stand 33 pt above the edge. A source guard
    (`FootRestTests`) checks both modifiers, because the simulator shows neither the pill nor the keyboard.
  - **Keys and editing:** Enter on a hardware keyboard sends, Shift+Enter and Cmd+Enter break the line, and during
    IME composition Enter belongs to the editor. The field clears after Send by an edit
    (`ComposerTextView.replace(all:)`), so Cmd+Z gives the sent text back. The shortcut bar gets no groups from the
    field (`ComposerShortcutsBarTests`). A refusal puts the text back into the field.
  - **Command text traits:** text starting with `/` goes without autocorrection, capitalization, spell checking and
    smart punctuation (`Session/ComposerTextTraits`), because iOS turns `--force` into `—force`; only a change of the
    set reloads a raised keyboard. The core gives the "this is a command" rule (`SlashCommandText`).
  - **Slash command suggestions** (`Session/CommandSuggestions`, `CommandSuggestionsView`): a token from `/` to the end
    of the field opens the session's command list above the field card while the field has focus. The filter is a
    case-insensitive name prefix; a row shows `/name`, the argument hint and the description, 1 to 6 rows of 44 pt.
    The list floats over the transcript without moving the layout. A tap puts `/name ` in place of the token as a
    keyboard edit (with undo). With a hardware keyboard ↑/↓, Tab and the first Return pick a command (a second Return
    sends); Esc with the list open only closes it (`EscapeInterruptRule.suggestionsOpen`). Tests:
    `CommandSuggestionsTests`, `CommandSuggestionsKeysTests`, `CommandSuggestionsUITests`.
  - **Queue take-back** (`+QueueTakeBack`, `RarogStore.takeBackQueue`, `docs/dialogs.md`, "Taking the queue back"):
    while the session has a queued bubble or keeps a take-back without an answer (`AppState.canTakeBackQueue`), ↑ on
    an empty field without an open suggestion list, a tap on a queued bubble (`MessageContentView+TakeBack`: anywhere
    on the bubble except "Show all" and a code block's copy icon) and the bubble's VoiceOver action take the whole
    queue back. While a take-back is kept, a Not confirmed bubble has the same tap and action
    (`TranscriptRow.pending`, `replaysTakeBack`), so the replay stays reachable after 15 s of idle; a reconnect does
    not replay by itself. The texts stand one per line in queue order before the field's text (`QueueTakeBackField`);
    the cursor goes to the end of the field after ↑ and to the end of the tapped bubble's text after a tap. Where the
    texts go is decided at answer time, by whose live field writes the session's draft next: the latest screen of the
    session in a window (screens register in `ComposerDrafts`; also a screen opened after the gesture), or else the
    latest one still alive out of the window, which keeps its field when it comes back. That screen first takes a
    failed send's text that waits for it into the field (`takeWaitingDraft`, as under `SendRecovery` below), then
    merges the taken texts once before the field's text and writes the field to the draft; only with no screen
    of the session alive do they go on top of the stored draft (`ComposerDrafts.saveTaken`).
    The store removes the bubbles of the returned `clientMessageId`s and frees the id only after the disk confirmed
    the write (`persistDraftConfirmed`); a refused write keeps the bubbles and the id, takes the taken texts out of the
    field again unless it changed meanwhile (a failed send's text it took stays), and says so under the field
    (`composer.takeBackNotSaved`). A prompt without
    `clientMessageId` (typed at the Mac, or a message pasted onto a draft at the desk) only adds its text, so the
    bubble of such a message stays until Not confirmed. A refusal leaves the bubbles and puts the server's sentence
    under the field, a 404 the server update, `incomplete` a note that part of the queue stayed in the terminal. A
    second gesture during the request sends nothing; a request without a definitive answer keeps its `operationId`
    for the automatic retry and the next gesture. Esc still interrupts the turn.
    The gesture shows at once, because the server answers only after a second or more: the store starts the
    take-back synchronously (`RarogStore.startTakeBack`, then `finishTakeBack` in a task), the screen renders in the
    same turn (`renderNow`) and gives one light haptic tap (`queueTakeBackFeedback`); an ignored gesture (one in
    flight) gives neither. Until the answer every queued bubble of the session is taking back
    (`TranscriptRow.pending`, `takingBack`): dimmed further than a queued bubble (`MessageContentView.alpha`; the
    shimmer fades with the bubble, its band and timing unchanged), with the muted status row "Taking back…" under it
    (`PendingStatus.takingBack`, no buttons) and the same state in its VoiceOver label
    (`transcript.takingBackRolePrefix`). The answer ends it: taken bubbles leave, after a refusal or an unsaved draft
    the bubbles look as before and the sentence stands under the field. A Not confirmed bubble keeps its own status
    row during a replay.
    Tests: `StoreQueueTakeBackTests`, `QueueTakeBackFieldTests`, `TranscriptRowsTests`, `QueueTakeBackUIKitTests`.
  - **App commands** (`docs/slash-commands.md`, "App commands"): `AppCommand.all` (`Session/AppCommands`: `/model`,
    `/effort`, and `/usage` with the aliases `/cost`, `/stats`). The whole field text is an app command when it is `/`
    and a name or alias from the list, followed by the end or whitespace; `/modelx` goes the usual way. Send handles it
    at the start of `send()` (`+AppCommands`): no request, outbox or echo. `/model` and `/effort` open the model
    pill's popover (`ModelSheetRequests`); a blocked popover or a session without a pill gives a sentence and the text
    stays. `/usage` opens the Usage sheet (`+UsageSheet`, `Views/Usage/UsageSheet`), which reads `GET
    /api/usage/details` once per opening. In the suggestion list app commands stand between the server's commands with
    a note (`AppCommand.merged`). Tests: `AppCommandsTests`, `UsageSheetModelTests`, `UsageUITests`.
  - **Model and Effort sheet** (`Views/Header/ModelSheet`, rules in `ModelSheetModel` and `ModelDraft`): three rows
    with the field name above. Model: one horizontally scrolling row of chips (`Views/Common/RecentChip`, the recent
    project chip of New Session) with the positions of `ModelSheetModel.options`. Effort: chips of the chosen
    model's levels (`ModelSheetModel.efforts`) in the same kind of row; a model without levels shows a sentence in its
    place (`header.effortNone`). Ultracode, only for a model with `ModelChoice.ultracode`: a system segmented control
    Yes / No; without proof on the card no segment is selected, and No sends an explicit `false`. Each chip row fades
    out over its last 12 % and scrolls the selected chip into view when it appears. A tap only chooses; Apply,
    18 pt under the last row, sends the difference (`ModelSheetModel.patch`). On a phone the sheet is as tall as its
    content (`popoverSheetChrome(title:fitsContent:)` leaves the detent to the sheet). The sheet that sent Apply keeps
    its form with the spinner until the reply (`AppState.modelSheetReason(for:ownRequest:)`), closes on 202 and shows
    the server's sentence on a refusal. Tests: `SessionPillsTests`, `HeaderUITests.testModelSheetApply`.
  - **Model pill in flight** (`ModelPill` in `Session/ComposerPills`, `ModelPillModel.make(_:choices:target:)`): Apply
    in the model popover records the sent body as the session's change in flight (`SessionControlsState.modelChanges`,
    before the request). Until the list shows every sent value, or 20 s pass (`SessionControlTiming.modelChangeWait`),
    the pill shows the target set over the session's values in the quiet tone (`muted2`) with a mini spinner, and
    VoiceOver hears "…, switching…". The core ends the change on the first list frame that shows every non-empty
    target value, compared exactly (`ultracode: false` needs `false` on the card), and does not bring it back when the
    next frames report the engine's model id. A refusal or the deadline removes only its own attempt. While a change
    is in flight a second Apply sends nothing (`.inFlight`), and a tap on the pill or `/model` and `/effort` open the
    popover with the in-flight sentence and no Apply (`modelChangeReason`); the command text stays in the field.
    Tests: `ReducerSessionTests`, `StoreSessionTests`, `SessionPillsTests`.
  - **Look:** the placeholder starts where typed text starts (`ComposerLayoutTests`). The field card is glass
    (`Views/Common/GlassSurfaceView`, the material of `glassCard`, `docs/design.md`, "Glass") with a `border` line,
    radius 26 pt (`ComposerView.cardRadius`), 10 pt from the column's sides (`ListFooterMetrics.cardSide`; in Relaxed
    spacing at the transcript's margin, "Transcript spacing"), the
    `callout` font. Its first line is the activity row in a band (`activitySlot`) open from the start of a turn to
    its end and closed while idle (`Model/ActivityBand`, `SessionViewController.placeActivityBand`: the card grows
    upwards over 0.2 s, none with Reduce Motion), its last line the message line (`composer.hint`), which wraps and
    grows the card upwards. A disabled field dims its content to 0.7, not the card (alpha on a glass ancestor breaks
    the effect), and swaps the edge line for a dashed outline. The
    paperclip is a 32 pt circle, the microphone a plate (`RingButton.plated`) and Send (`SendButton`) are both 40 pt with a 44 pt target,
    and the model and mode pills are
    monospaced `caption` with a `border` line on a clear fill, like the circles (`PillLabel.restFill`). Tests:
    `ComposerCardTests`.
  - **Activity row placement** (`+FootActivity`): one `ActivityRowView`, reparented. With the field shown it is the
    field card's first line; with the field hidden (a decision, the state card, the grace period) it stands in the
    narrow glass card (`FootActivityCard`), which shows its glass only while the row has content. The row's clock,
    glyph tick and VoiceOver sentences run only while it is on screen (`ActivityRowView.isOnScreen`,
    `visibilityChanged()`; `ActivityRowViewTests`).
  - **Activity row line** (`Session/ActivityRowView`, model `Model/ActivityRowLine`): one quiet line of a
    glyph (SF Symbols, 16 pt box), the label (`footnote` medium, `prose`), the detail (`footnote`, `muted2`, monospaced
    only for read, search, edit and run tools), the delegation segments (2 pt, one per plan phase) and the turn clock
    in a fixed field at the trailing edge (`muted2`, digits of one width). The detail truncates first, then the
    label; the clock never, also at the largest text size. The label is the tool's own description, else the action
    of a known tool, a readable MCP name (`mcp__server__tool` → "Server tool") or the raw name; "Thinking" while no
    tool runs, "Quiet for 2m" after 90 s of silence, the delegation sentence; the detail is the summary
    (the file name for a read or an edit), "still running · 3m" after 60 s of one tool, "last update 42s ago" on a
    broken stream. The glyph is green (`run`) only in a turn on a live stream; quiet, offline and interrupt are
    `muted2`; the row uses no amber or red. Tool names choose the glyph and the typeface only in
    `Copy/ToolActivity` (the one exception of `SourceGuardTests`). Three time bases (`ActivityClocks` in RarogCore):
    the turn clock from `turnSince` (without it `stateSince`), standing on a broken stream; the tool time from the
    tool activity's start; the silence from the newer of the last message and the last activity.
  - **Hold and motion:** every render and clock tick passes the candidate line through `ActivityLineHold`: a line
    stays at least 0.7 s and a tool gives way to thinking only after 1.5 s of it; an empty line (end of turn, a
    decision), offline, interrupt and the agent start pass at once. The row repaints once more at the moment the hold
    returns (`wakeAt`), not at the next clock tick. Motion comes only from data: when the session's own stream
    brings an event in a turn (`AppState.turnEvents`) and the row is on screen, the glyph ticks once (scale 1 → 1.12
    → 1, opacity 0.5 → 1 → 0.75, its resting opacity, 450 ms ease-out); a new event restarts it, events seen while
    the row was hidden do not tick when it shows again, and Reduce Motion keeps the fade only. While the line says
    the agent works (`ActivityRowLine.isWorking`: thinking before the silence threshold, an open tool call, a
    delegation, on a live stream) and the row is on screen, the glyph breathes (`.breathe.plain`: scale only, full opacity) and a light
    band sweeps the label (`ShimmerLabel`: a gradient mask, text at 65 %, a 1.6 s sweep and a 0.8 s rest); waiting,
    silence, offline, agent start, interrupt and Reduce Motion stand still, decided again on every paint. A glyph
    change uses
    the `replace` symbol transition, a label change a 0.2 s cross-fade. VoiceOver hears the label, the detail and the turn time on
    a change of the line's content key (`contentKey`, without numbers), not on clock ticks. The list card line keeps
    `ActivityText.cardText`.
- **Store observation:** `withObservationTracking` in `SessionViewController` (one state change = one ordered render);
  SwiftUI views read `store.state` directly.
- **Color = state:** tokens from `docs/design.md` in `Theme/PaletteTokens.swift` (values, compile on macOS) and
  `Theme/Palette.swift` (UIKit colors). Amber means only "someone is waiting" and Send; Allow is filled green, Deny a
  red outline. The light `muted` is `#51515A`, because the dimmed transcript must stay above 7:1 and the neighboring
  `#52525B` has 6.93:1. `PaletteContrastTests` checks the thresholds. The only color outside the state vocabulary is
  syntax (`hl*`), only in code; every syntax color keeps at least 4.5:1 on its backgrounds. System buttons use an
  achromatic tint (`.tint` = `text`). The list column stands on `background`, not the system `.sidebar` background,
  on which `muted2` would drop to 4.228:1.
- **Corner radii = one scale** (`Theme/Radius.swift`): `block` 12 pt for every standalone block (bubble, tool row,
  cards, banners, the prompt bar, the message field, the list row selection); `inner` 8 pt for an element inside a
  block (code block, form fields, the command block, thumbnails in the field, the current tab plate); `focusRing` =
  `block + 3`; `ghost` 4 pt (skeletons, the shortcut digit tile); `tabSquare` 2.5 pt. Pills, buttons and dots stay
  capsules. The curve is always continuous (`.block`, `.inner`, `.ghost` in SwiftUI, `CALayer.roundCorners(_:)` in
  UIKit). Blocks share one radius, because close radii side by side read as inconsistency. `CornerRadiusSourceTests`
  catches a radius outside the scale.
- **Pointer hover without system glass** (`Views/Common/Hover`): `RarogHoverReader`, `.rarogHover(.ink(rest:))`,
  `.rarogHover(.fill)` and `RarogHoverTracker` for UIKit; values in `Theme/PaletteTokens+Hover` (`HoverTokens`). Each
  element has its own response (a row gets the selection fill at half opacity, icons go ink → `text`, pills get the
  `hoverStroke` line). `onHover` does not hear touch, so the pointer response never lights under a finger, and
  allowing still goes only by gesture. The one touch response on the list is separate: an agent row of the stacked
  list (iPhone, narrow window) shows the full selection plate while its UIKit cell is highlighted (`PlainListRow`,
  `ListCellFocusBridge`), a background change only, which waits for the list's touch delay and goes out when it
  scrolls. The simulator cannot produce pointer state, so UIKit tests set it directly. `RarogUI` has no system
  pointer effect (`.hoverEffect`); `HoverTokensTests` checks this.
- **Layer colors follow the theme:** a `CGColor` is resolved from the view's traits (`resolvedColor(with:)`, never a
  bare `.cgColor`) and computed again in `registerForTraitChanges`. When going to the background iOS takes app
  switcher snapshots in both themes, so the code block background is a view with a dynamic color (`CodeBlockBox`),
  and a text cell refreshes decoration colors in the foreground ONLY when the theme and font differ from its
  configuration (`SessionViewController+Look`), so returning to the same theme changes neither heights nor selection.
- **Accessibility:**
  - **One announcement channel:** every VoiceOver sentence goes through `Announcer.shared.say` (`Model/Announcer`),
    with iOS 17 priorities `urgent`, `normal` and `ambient`; the same sentence within 1 s is one announcement, and
    events carry an `eventID`. The gates are view values tested on macOS: `ActivitySpeechGate` (the activity row
    speaks at the first activity, on a kind change, otherwise at most every 20 s) and `DecisionCardSpeech` (a card
    born during the visit announces its header).
  - **State never by color alone:** a row dot has a state word, a project header has no state mark (its grey
    agent count in brackets only counts; the header's sentence names the most urgent state), a tab a VoiceOver sentence
    and, with Differentiate Without Color, a glyph shape (`Model/StateGlyph`), the note glyph a VoiceOver value,
    usage thresholds use font weight (`UsageInk.weight`), and a risky permission has the word "risky" in the header.
  - **Dynamic Type:** `Fonts` go through `UIFontMetrics`. The list footer bar steps down (`ViewThatFits`): without the
    machine columns, then with the limit fields stacked, always so at accessibility sizes (the machine numbers are in
    the Usage sheet); project names wrap, the tab bar takes its height from the content. The field's
    pills grow up to xxxLarge (`PillLabel.barCeiling`), then the large content viewer. Text never uses `caption2`,
    which does not scale (guard `DynamicTypeSourceTests`). A UIKit font, or a size derived from one, takes the
    view's text size, never the system's (`preferredFont` and `UIFontMetrics` without traits give the system's):
    a label with `adjustsFontForContentSizeCategory`, `compatibleWith:` the view's traits, or SwiftUI's
    `dynamicTypeSize`. So a text size set on the scene reaches the card block ceilings, the dictation row's
    "Settings" title, the note reader (it renders again on a trait change) and the shortcut sheet's key caps, also
    on a view already on screen (`RarogUIKitTests/TextScaleOverrideTests`).
  - **Motion and transparency:** Reduce Motion keeps only the fade of the activity glyph's tick, stops the
    activity glyph's breath and label shimmer, the skeleton pulse and the tab bar slide; Reduce Transparency turns
    glass into a plain `surface` (`Palette.glassFallback`), and the list footer bar into the solid `footerCardSolid`
    (`Views/List/Footer/ListFooter`). The New Session footer is always opaque.
  - **Temporarily unavailable controls** stay tappable and muted: a tap gives the reason, and VoiceOver hears it in the
    hint. A hard `.disabled` stays only for actions in progress (guard in `HeaderModelTests`).
- **Decision card look:** the header is the shared `.eyebrow(...)` label (monospaced small caps, red for a risky
  permission, amber for permission, question and dialog); VoiceOver gets it as a plain sentence. The command block and
  screen excerpt are an `input` field (`commandBlock()`). Footer buttons are 36 pt capsules with a 44 pt target
  (`FootButtonMetrics`); the main action of a presentation is `PrimaryButtonStyle`. `RarogUI` has no system
  `.bordered` styles (guard `PresentationSourceTests`). The escalating option is a tile in a SEPARATE row under
  Allow/Deny: the bold start of the label and the rule's scope under it, with the home directory as `~`. The split
  knows four label starts from the permission dialogs; another label stands whole (`AlwaysLabelParts`), and VoiceOver
  hears it verbatim.
- **Allowing only by gesture:** Allow, the escalating option and allowing a recognized dialog are a
  `GestureOnlyButton`, not a `Button`, because a system button also fires on Space/Enter with focus (Full Keyboard
  Access). The default accessibility action allows only under VoiceOver and only without a hardware keyboard, because
  VO+Space arrives through the same action as a tap (`ApprovalGate`). Cost: VoiceOver with a keyboard, Voice Control
  and Switch Control allow by touch without VoiceOver or in the terminal.
- **Keyboard on cards (`+KeysCards`, `Model/CardKeys`):** keyboard focus lands only on cards with a decision and shows a
  `CardFocusRing`. Esc on a permission or dialog card is Deny; on a question card it is no decision. Tab with a card
  standing focuses the card. During a decision the session screen takes the keyboard (`claimKeyboardForCards`), and
  afterwards it goes back to the field.
- **State card instead of the field:** the field and `stateCardSlot` share one stack; a usage limit, an interrupted
  session, an error, `resumable`, `done`, an unsupported session, Codex and a pane out of reach show a card
  (`StateCards.make`). An action's result belongs to the card it came from (`StateCardModel.key`).
- **Dictation (`Session/Voice/`):** `VoiceRecorder` (states, a minute of silence, the session limit, a countdown
  from the 13th minute) over one `DictationStream` per route, on an injected clock, socket and microphone
  (`VoiceTests`, `SonioxBacklogTests`). The order is `prepare()` → microphone → `start()`, so a refusal in
  `prepare()` never opens the microphone; on the Soniox route with the microphone permission already granted,
  `start()` (the key fetch and the socket) runs while the microphone opens, and a refused microphone ends it with
  no socket left. Recording starts when the microphone opens: until the first connection streams, `SonioxStream`
  keeps the speech (the last 5 s) and sends it in one burst right after the config frame; a first attempt that
  fails keeps it for the next, reconnects after the first connection drop audio, and an edit of the field drops
  what was not sent yet. `SonioxStream`: a key from the server at every attempt, three attempts, a wait for the
  last words of 2.5 s plus the speech sent in the burst; a stop while speech waits for the first connection waits
  for it at most 3 s and ends with the failure notice when it does not open, or when it fails before its first
  result (a 429 frame gives the rate-limit notice). After an edit of the field it skips tokens that start before
  the audio already shown (`start_ms`, per connection), so the hypothesis Soniox confirms after a pause does not
  land in the field twice. A Soniox recording writes one `client.log` line when it is ready, with the stage times
  from the tap (microphone, key, socket) and the burst length, never the text.
  `SystemDictationStream` (`Session/Voice/System/`, `SystemDictationTests`): `SFSpeechRecognizer` on the device when
  the language has a model there, otherwise on Apple's servers (`SystemDictationPolicy`); a new task after the
  one-minute task limit and after an edit of the field; it downloads no speech assets. `MicrophoneCapture` sends
  16 kHz mono frames of 100 ms; `URLSessionVoiceSocket` is a separate URL session without cookies, straight to Soniox
  in the EU. The microphone stands in every field that takes text; a tap follows `RarogStore.dictationRoute`: `ask`
  opens the Dictation screen (`Views/Dictation/`; a sheet from the composer, a page in the note) without recording,
  and the next tap records. A system recording writes one `client.log` line with the API, the path (on the device or
  Apple's servers) and the locale, never the text. During a voice agent conversation the composer microphone and the
  dictation shortcut mute the conversation instead of dictating (`docs/companion.md`, "Conversation").
  `VoiceFieldText` and `ComposerDictation` keep typed text and the dictation apart; the background, a call and closing
  the screen end the recording with the text in the field, saved into the persistent draft. Send during a recording
  ends it like a second microphone tap, waits for the last words (at most the finalization wait above, plus up to
  3 s for a first connection that still holds the speech) and sends the whole text once; leaving the screen during
  that wait sends what the field holds then.
- **Changeable shortcuts (`Model/AppShortcutSettings`, `Views/ShortcutSettings/`):** the Dictation page of Settings
  has a Keyboard Shortcut section with the dictation row (⌥⌘M by default), and the Voice Agent page, while the agent
  is on, one with the voice agent row (⌥⌘V by default); the value is the glyphs of the shortcut in force, and the
  Settings list repeats them in the subtitles of both rows. The first-mic Dictation sheet and the note's Dictation
  page have no shortcut section. A tap on the row opens a page that records the next key press
  with modifiers from a hardware keyboard (without one it says so), shows the glyphs and saves on Save Shortcut;
  Esc without modifiers leaves the page, Restore Default gives the default back. The choice belongs to the device
  (`UserDefaults`, keys `rarog.shortcut.<name>`), nothing saved means the default, and it does not go to the server.
  A combination is refused with one sentence under the field and not saved when it lacks ⌘, ⌥ or ⌃ (Shift alone does
  not count), its key is not a letter or a digit, the system owns it (`AppShortcutSettings.systemCombinations`: ⌘M,
  ⌘H, ⌘Q, ⌘Tab, ⌘Space, ⌘, and the text editing ⌘A, ⌘C, ⌘V, ⌘Z, ⇧⌘Z), or another app shortcut that works at the same
  time uses it (`AppShortcut.overlaps`, the menu's ⌘1–9 and ⌘0 included; dictation and the voice agent exclude each
  other). ⌘= and ⌘- of the text size are refused as not a letter or a digit.
  A stored value a rule refuses today reads as the default. `AppShortcut.key` and `modifiers` read the setting, so
  the session screen's key commands, the note form's shortcut, the pointer tips, the shortcut sheet and the menu bar
  follow a save without their own code; SwiftUI draws again through Observation (`AppShortcutSettingsTests`).
- **App text size (`Model/TextScale`, `Views/TextScale/`):** with a hardware keyboard ⌘+ (registered as ⌘= and
  ⇧⌘=) makes the app's text one step bigger, ⌘- one step smaller and ⌘0 (Actual Size) gives the system's size back;
  the menu bar lists them under View and the shortcut sheet in Tabs and View. The steps are the seven standard
  Dynamic Type sizes, Extra Small to Extra Extra Extra Large; the first step starts from the system's size, and a
  command at the end of the range is disabled. The step goes on the scene
  (`UIWindowScene.traitOverrides.preferredContentSizeCategory`, `TextScaleSceneBinding`), so every text that follows
  the system slider follows it too, ceilings and layout thresholds included; the terminal scales its Menlo size by
  the same ratio ("Terminal screen", "Font"). The
  choice belongs to the device (`UserDefaults`, key `rarog.textSize`), applies when the scene connects, and an
  unknown stored value means none. Nothing stored follows the system. While the system uses an accessibility size the
  app follows the system, ⌘+ and ⌘- are disabled, and the stored step comes back when the system leaves it; the
  system's size is read from the screen, because the scene carries the override, and followed through
  `UIContentSizeCategory.didChangeNotification`. With the session switcher open ⌘0 picks the window's row 0 instead.
  The Text Size row of Settings shows the state (System Size or the step's name) and opens the Text Size page
  (`Views/TextScale/TextSizeSettingsPage`, rules in `TextScaleSettingsRow`): the seven steps, each name drawn in its
  own size, a check on the stored step, and Use System Size, shown only while a step is stored: the way back without
  a keyboard. A tap stores the step, also the one equal to the system's size; only Use System Size and ⌘0 follow the
  system again. While the system uses an accessibility size the steps are disabled and none is checked, and Use
  System Size still forgets a stored step (`TextScaleTests`, `RarogUIKitTests/TextScaleSceneTests`,
  `RarogUITests/TextScaleUITests`). The accessibility audit walks the main screens at both ends, the system at Small
  with the largest step and the system at Extra Extra Extra Large with the smallest, without its Dynamic Type check:
  that check moves the system's size, which the app's step holds back on purpose.
  The iPad app on a Mac gets one size per text style at every content size category, in UIKit and SwiftUI alike, so
  the override moves no font there and the app scales the text itself (the flat path, `Theme/TextStyle/`).
  `TextStyleScaling.isFlat` measures it once per process (body at Extra Small equals body at Extra Extra Extra
  Large). `TextStyleTable` holds the size of eleven text styles at the seven steps. Every font goes through the
  contract: `AppFont` and `.appFont(_:)` in SwiftUI, `TextStyleScaling.font` and `Fonts` in UIKit,
  `@AppScaledMetric` and `TextStyleScaling.scale` for lengths that grow with a style. On the flat path they take the
  table size at the model's category (`TextScale.effective`) and build the font from the style's descriptor, which
  keeps the style's leading. Every root of SwiftUI views carries `.textScaleHost()` (`Views/TextScale/TextScaleHost`):
  the app's root, `SheetHost`, and each `UIHostingController` or `UIHostingConfiguration` inside UIKit. On the flat
  path it puts the model's category on the views as `.dynamicTypeSize` and the body font as the default font, so
  text without a font grows too; local `.dynamicTypeSize` ceilings below it hold. UIKit views set their fonts again
  after a step (`Fonts.follow`, `TextScaleObservation`), because no trait change comes with it there, and the
  terminal takes its ratio from the table. The accessibility sizes give the table's largest step, so on a Mac text
  stops at Extra Extra Extra Large. The commands, the Text Size page and the stored step work the same on both
  paths. On the standard path (iPad, iPhone) the contract makes exactly the system's call (`preferredFont`,
  `UIFontMetrics`, the SwiftUI text style) and the host adds nothing. `FontContractSourceTests` refuses a font taken
  from the system's text styles outside the contract and names the replacement (`RarogUIKitTests/TextStyleTableTests`,
  `AppFontTests`, `TextScaleMacPathTests`, `TextScaleMacPathPanelTests`).
- **A failed send keeps the text (`SendRecovery`):** with the session screen alive the text goes back into the field;
  when the screen is gone the refusal entry STAYS in the outbox with Retry and Discard, and text without an entry goes
  into the session's draft and attachments onto the shelf. A screen still alive out of the window (under a full-screen
  presentation) leaves that text waiting in `ComposerDrafts` memory. Before a write of its changed field (after a
  typing pause, on leaving the screen, on going to the background) and before a take-back answer's write, the screen
  takes the waiting text on top of the field (`takeWaitingDraft`), without the stored draft under it, which the field
  already holds (`ComposerDrafts.takeWaiting`), so the write does not drop it. An unchanged field writes nothing, and
  the text keeps waiting, with its reason, for the next opening.
- **Persistent draft (`ComposerDrafts`, `+Drafts`):** each session's text and unsent attachments live in
  `<server space>/drafts/` (a manifest `<key>.json` and content files in `<key>/`; protected until the first unlock,
  excluded from backup, at most 64 drafts). Saved 300 ms after the last CHANGE of the field
  (`Model/DraftSaveSchedule`), on leaving the screen and on going to the background; an empty state deletes the draft.
  The previous files go only after the manifest is saved, so a refused write keeps the previous draft whole. An
  attachment set loading onto the shelf reaches the draft after loading (`persistAfterLoading`).
- **Rename on the list row (`Model/SessionRename`, `Views/List/SessionRenameField`):** the look and the rules for
  the person are in `docs/design.md`, "Native app list: project tree". `SessionRename` holds the rules (when the row
  offers the item, the field's limit and line breaks, the save, the label the card will get); `SessionRenamer`, one
  per list (`SessionListView`), knows which row is a field, the name that field started with (Return compares the
  draft with it, not with what the row shows by then), and which names wait for the server's label; the row model
  shows a pending name through `SessionRowModel.renamed`. The field is a `UITextField` (`RenameTextFieldView`): it
  passes every keystroke and paste through `SessionRename.edit`, which inserts only what fits in the room left and
  keeps the rest of the name, so a full field refuses a character typed anywhere. It selects all when it takes focus
  (retrying while the context menu leaves), hears Esc as a key command with priority, and treats losing focus as
  a cancel. While it is open, the list (the nearest scroll view above it) carries a tap recognizer (`TapBeside`) that
  neither delays nor cancels touches: a tap beside the field cancels it, and the tapped row still opens. The list may
  hand the next field of a row the text field view of the previous one (`makeUIView` does not run again), so
  `SessionRenamer.begin` counts the edits (`edit`) and `RenameTextFieldView.start` starts the view over on a new
  number: the name, Return, `TapBeside` and the focus with all selected; the same number leaves the typing alone.
  Without a hardware keyboard (`TerminalKeyboard.isConnected`) a borderless Cancel button (`list.renameCancel`)
  stands at the end of the field's line and cancels like Esc; the hint is `SessionRename.hint(hardwareKeyboard:)`.
  `SessionListView` cancels the field when `RarogNavigation.detail` changes and when the scene goes to the
  background. Return decides the save before the first suspension (`Task.immediate` in `ProjectTreeRows`), so a
  cancel right after it cannot drop the save. The pointer
  double click is a two-tap `UITapGestureRecognizer` on the list cell limited to `.indirectPointer` that neither
  delays nor cancels touches (`RenameDoubleClickView`). A save goes through `RarogStore.send(text:to:)`. The
  confirmation window of `SessionRename.confirmWithin` starts at Return and ends the wait itself, however long the
  send takes. The list watches the labels of the waiting rows (`SessionRenamer.awaitedLabels`): a change to the new
  name's card label ends the wait at once, and the row shows the server's label from then on; the label the row had
  at Return confirms nothing, so a new name with the same card label waits out the window. A refusal, or no label
  by the end of the window, brings the old name back with `RarogNavigation.post`; a refusal after the window posts
  its sentence too. A paste over a selection moves the caret after the kept part even when the text stays the same,
  and a field that leaves the list without Return or Esc takes `TapBeside` off it (`didMoveToWindow`).
- **Filter segments over the list (`Views/List/ListFilterBar`, `Model/Navigation+ListFilter`):** one row under the
  navigation bar and the banners (a notice about the app comes first), in the list's top inset: All · Needs You ·
  Working · Unread, each a glyph with its count (`ListFilterBar.glyph`: a list, a question bubble, a bolt and a check
  mark); the word is what VoiceOver says and the pointer's tip (`pointerTip`). Under the
  pointer a segment lights like an agent row and a tab: its plate at half opacity (`HoverTokens.agentRowAlpha`). A session belongs
  to a segment by its dot (`AppState.listFilterContains`): Needs You is waiting or failed; Working is working, also a working background
  task; Unread is a fresh result whose dot pulses (`AppState.freshResult`). So the segments never overlap, a result
  marked unread by hand (a still blue dot) is in no segment but All, a result held on the list after it was read is
  not Unread (its tone is quiet), and an unread result with a working background task counts under Working. Counts
  take every session, also in folded projects; Needs You is amber (`Palette.wait`), Unread the unread blue, All and
  Working secondary text, zero muted. The active segment sits on a `surface2` plate with the block radius, the others
  have no background; a segment's target is at least 44 pt. The row rises 12 pt into the empty space the
  navigation bar leaves under the title (`ListFilterBar.rise`), so the plates stand close under it; the bar keeps the
  taps on the top few points of the plates. The segments share the column's width, so the row fits
  without scrolling; only when even the glyphs do not fit it scrolls sideways instead of truncating. It stands from
  the first frame: on the skeleton and on an empty list the segments are disabled and the counts muted, so the list
  appearing does not move the top inset. VoiceOver hears a "Filter" group and segments such as "Needs You, 4" with
  the selected trait. The filter is a parameter of the tree,
  `AppState.projectTree(collapsed:filter:held:)`; `RarogNavigation.treeRows` gives the rows to the list and to the
  anchor's announcement on a fold (`ProjectTreeRows.toggle`), so both see the same rows. Under a segment other than
  All an agent row stands when the unfiltered tree shows it and it belongs to the segment, is held, or is the
  selected session (`AppState.listSelection`; recently opened rows are not kept). Held rows are the segment's sessions
  shown under the current segment choice: a row that leaves the segment (an agent finishes, a permission is answered)
  stays until another segment is chosen, the active segment is tapped again or the app goes to the background, so no
  row disappears under a finger. Order never changes; a header stands only over a project with a visible row, and its
  "collapsed, N of M shown" counts the filtered rows. A segment with no visible member starts the list with one sentence
  row (`ProjectTreeRow.emptyFilter`, a tree row, so the collection's items stay the tree's rows), with any held or
  selected row under it; All on an empty list keeps the list's own sentence. The chosen segment and the held rows live
  in memory only: the app always starts on All, because a forgotten filter would hide sessions without a trace.
- **Jump pill (`Model/ListJumpPill`, `Views/List/ListJumpPillTracker`, `Views/List/ListJumpPillView`):** a capsule at
  the bottom or top edge of the list says how many agent rows that need the human stand below or above the visible
  part (under the bar, the filter segments and the banners, above the footer card): `3 below ↓ · 1 waiting, 1 failed,
  1 unread`, or for one row its state and name (`1 waiting below ↓ · rotate keys`, the tree row's
  `SessionRowModel.treeTitle`). A row counts by its dot, like the segments: waiting, failed, or an unread result
  whose dot pulses; work and a result marked unread by hand make no pill. The rule takes the filtered tree rows
  (`ListJumpPill.Row.init(_:)`), the ids the collection holds
  and the collection's frames: a row is on screen when half of the smaller of its height and the visible part's lies
  in the visible part; a row off screen is below when its center is under the visible part's center; on a side that
  has a pill, rows the pill would cover (its measured touch frame) count too, so a row visible just over the
  footer does not call up a pill over itself. The target is the nearest row off screen. `ListJumpPillTracker` counts
  on every layout of the collection (a scroll, new content, size or safe area, through a helper view laid out after
  the collection), on every list body (a row changing state or name with the same ids), after the collection applies
  new rows and when a pill's height changes; the observed result changes only when it differs, so scrolling redraws
  nothing. It hears the collection through `TreeListAnchor.addRecipient`, the same report `TreeReturnScroll` hears.
  The pills are overlays on the list inside its safe area: "below" its 44 pt touch target on the footer card, "above"
  at the top edge, the lower capsule centered inside; they change no inset or margin. The capsule hugs its text (10 pt
  over and under it, at the ends its radius, so the air looks the same on every side), translucent: `surface2` at 60 %
  over a thin material, without a stroke, with the shadow of the transcript's floating controls
  (`JumpToBottomBar.lift`); the count and direction are in text ink, each state in its color (amber, red, unread
  blue), the name last and cut at its end; at accessibility sizes the text may take two lines. VoiceOver hears one
  button with the whole sentence and the hint "Scrolls to the nearest one." A tap centers the target (`scrollToItem`,
  without animation under Reduce Motion) and changes no selection. When the motion ends (the animation stops, or its
  offset stands still between two checks 50 ms apart) and the target is not on screen, because its height was an
  estimate, one correction places it without animation; a finger on the list, another segment or the target leaving
  the tree cancels it, and while the collection still holds an older tree than the list's rows it waits for the new
  rows, so it never takes the target's old index. No pill on the skeleton, on an empty list or with the list column
  hidden (Cmd+B).
