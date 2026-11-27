# Design brief — Rarog

> This brief describes the look of the native app (`native/Rarog`), Rarog's only client. Rarog follows Claude Code
> sessions that run in panes of herdr, a terminal multiplexer on the computer that runs the Rarog server. The brief
> states the rules; the code holds every value and is the source when the two differ: colors in
> `RarogUI/Theme/PaletteTokens.swift` and `Palette.swift` (the color table below copies them), radii in
> `Theme/Radius.swift`, pointer looks in `Theme/PaletteTokens+Hover.swift`, the tab bar in
> `Theme/PaletteTokens+Tabs.swift`, list spacing in `Model/SessionListMetrics.swift` (paths under
> `native/Rarog/Packages/RarogUI/Sources/`). Token names here (`--wait`, `--surface`…) are role names; in Swift the
> same token is `wait`, `surface`, `muted2` (`--muted-2`), `text2` (`--text-2`). Where the app departs from a rule on
> purpose, a code comment says so.

Direction: **a night-time control instrument**, not a chat. People check the app often, one-handed, in a dark room,
so the dark theme is the primary mode. The main screen has one job: answer "is any agent waiting for me?" in under
2 s.

## Core principle

**Color = state, not decoration.** The interface is achromatic (neutral black and white); colors carry the meaning of
session states. Buttons have no accent color of their own: contrast and outline set them apart. Only the default
action has the accent: the amber Send in the message field (only while there is something to send) and Resume on the
state card. So amber next to a session (the dot, the tab mark, the decision card, the Scroll to Decision button) means
"someone is waiting for you", with one warning: a session whose subagent has waited long on its own command (the
`timer` mark, "Tab bar in the session header"). Outside a session amber carries only warnings: `auto` mode (the
mode pill, the new session form), the warning threshold of usage, a modified file in the git line, and the dot of the
dictation status row while recording connects or finishes (while it records, the dot is `--err`). Your own message
bubble follows the rule too: it sits on a tinted grey, not a color ("Colors").

**First exception: syntax highlighting.** The `--hl-*` tokens apply in exactly three places: inside a code block, on
a tool card with a shell command (the collapsed `Tool: target` line and the expanded input), and in the command block
of a permission card with `inputKind: 'shell'`. The limit is structural, not a convention: the colors come from one
scanner only (`RarogUI/Markdown/SyntaxHighlight.swift`). The server sets `inputKind` only when the card text is
literally a shell command, so dialog lines from the screen, a plan and a command the server shortened with a
truncation footer (`clipForDisplay` in `server/src/drivers/tool-text.ts`) stay in one ink. On a permission card the
colors stay inside the command block, never on the header, the buttons or the screen excerpt. Code blocks and tool
cards are machine surfaces: no state dot or decision button sits on them. Under a pending decision tool cards lose
their colors, because the dimmed transcript keeps 7:1 only with plain ink. The hues (violet, cyan, blue, muted green,
ochre) differ on purpose from `--wait`/`--run`/`--err`, so a neighbor never poses as a signal; `--run`/`--err` enter
only on the `+`/`−` lines of a ```` ```diff ```` fence, as in an `Edit` card. Light shades keep ≥ 4.6:1 on every code
surface (`PaletteContrastTests`).

**Second exception: the question stripe in the transcript.** An agent's question to you (a paragraph that starts with
a bold `Do Ciebie:` or `To you:`, to the end of the text block) stands behind a `--wait` stripe. In the transcript
that amber means "a question to you", on answered questions too: the app does not track answers, and questions are
not always answered at once. The exception covers this one transcript ornament: the session list, the tab and push
notifications have no "asks" state. The look of the stripe: "Turns in the transcript".

## Tokens

### Colors

Dark is the primary mode; light follows the system setting. The table copies `PaletteTokens.swift` (`--border` and
`--accent`: `Palette.swift`); when the table and the code differ, the code is right.

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--bg` | `#0A0A0A` | `#F2F2F7` | screen background (neutral black, not `#000`) |
| `--sidebar` | `#111111` | `#EDEDF2` | iPad sides: the list beside a session, the inspector |
| `--surface` | `#171717` | `#FFFFFF` | cards, popovers, the session switcher window |
| `--surface-2` | `#1C1C1C` | `#F7F7FA` | raised: pills, selection plates |
| `--stacked-plate` | `#1C1C1C` | `#FFFFFF` | the stacked list's plate (last opened row, row under a finger) |
| `--input` | `#141414` | `#FFFFFF` | command block and screen excerpt on a card |
| `--composer-rest` | `#111111` | `#F7F7FA` | the model and mode pills in the field card |
| `--mic-plate` | `--text` 14 % | `--text` 10 % | the dictation microphone's plate (over `--composer-rest`) |
| `--mic-plate-live` | `--err` 16 % | `--err` 12 % | the microphone's plate while recording or muted |
| `--border` | white 8 % (22 %¹) | black 10 % (25 %¹) | hairlines, outlines, separators |
| `--text` | `#F5F5F5` | `#1C1C1E` | primary text |
| `--text-2` | `#CCCCCC` | `#36363C` | secondary text |
| `--prose` | `#D4D4D4` | `#1C1C1E` | agent reply prose |
| `--strong` | `#FFFFFF` | `#1C1C1E` | agent bold and headings |
| `--muted` | `#A3A3A3` | `#51515A` | metadata |
| `--muted-2` | `#8E8E93` (`#9E9EA3`¹) | `#6B6B73` (`#5A5A62`¹) | the second muting step |
| `--switch-on` | `#248A3D` | `#248A3D` | the track of a switch that is on; the only green outside states |
| `--idle-ink` | `#58585F` | `#92929A` | the row of an idle agent |
| `--wait` | `#FFB454` | `#9B5700` | **waiting for you**; a long wait on a background task |
| `--run` | `#4ADE80` | `#1C773D` | working |
| `--run-smoked` | `#328D53` | `#52966C` | waits on a background task that does not work (standby subagent, monitor) |
| `--err` | `#F87171` | `#B31B1B` | error, refusal |
| `--new` | `#7EB6FF` | `#0B57D0` | unread result, the NEW line |
| `--done` | `#71717A` (`#8E8E96`¹) | `#676770` (`#55555D`¹) | done, interrupted: silence |
| `--on-state` | `#0A0A0A` | `#FFFFFF` | ink on a full state color |
| `--accent` | = `--wait` | = `--wait` | the default action (Send, Resume) |
| `--ahead` | `#C084FC` | `#6D28D9` | commits to push (`↑3`) |
| `--behind` | `#22D3EE` | `#0E7490` | commits to pull (`↓1`) |
| `--user-plate` | `#262227` | `#E5E1E8` | your message bubble |
| `--note-ink` | `#DDB988` | `#6E4914` | the glyph of a project note with content (= inline code ink) |

A background in a state tone (an error pill, diff lines, the plate under an indicator) is the state token at an
opacity, not a separate color. `--run-smoked` is the exception: `--run` at 62 % (dark) and 75 % (light) over `--bg`,
stored opaque. Dark is a step below 70 % so the smoked green reads as clearly quieter than work; light stays at 75 %,
because 70 % there gave 2.91:1, under the 3:1 a state element needs. It keeps 3:1 over `--bg` and `--surface` in both
modes, and the dark tile digit keeps 4.5:1 on it. `--note-ink` is not a state: it is the warm, muted amber of inline
code, less saturated than `--wait`, and only a note glyph with content carries it. `PaletteContrastTests` checks the
contrasts, so a token value changes together with its test. `--ahead` and `--behind` stand outside the state
vocabulary: no dot or pill carries them, and the arrow reads the same in monochrome (VoiceOver gets "3 commits to
push").

**¹ Increase Contrast strengthens three tokens and nothing else.** With the iOS setting on, `--border`, `--muted-2`
and `--done` take the values marked ¹; every other token keeps one value per mode, and the default look is unchanged.
Each of the three has a strictly higher contrast against the background than without the setting, in both modes;
`--muted-2` stays quieter than `--muted`, and the resting hairline stays weaker than the hover outline. `--idle-ink`
does not change (about 2.8:1, a deliberate exception). Layers that hold a resolved `CGColor` (the message field, the
command suggestions, markdown rules) and the markdown cache follow the setting without a new configuration
(`PaletteContrastTests`, `ThemeChangeTests`).

**The user bubble (your message) sits on plum grey** (`--user-plate`: the plum `#322C34` / `#E0D9E1` at 70 % opacity
over the transcript background). A sent prompt is not a state, and amber, green, red, blue, violet and cyan already
have meanings, so the bubble gets a tinted grey (chroma ~4). Its hue is close to the violet of `--ahead`. That is
accepted, because the `↑` commit arrow stands only in the session header and the project list, never in the
transcript; a cool grey would instead sit on the blue of `--new` and of links. Against a code block (`codeBlockFill`)
the bubble differs in lightness barely (1.10:1 dark, 1.04:1 light), so shape and type (prose, not mono) carry the
rest. The quote bar above the transcript wears the same plate.

### Typography

- **Mono** (the system `.monospaced()` face) is the machine's voice: state labels, timers, the branch and git
  counters, commands, tool lines, section labels (uppercase, 0.08 em tracking).
- **Proportional** system face: the agent's text and yours. Transcript prose uses `callout`; code in a block is
  2 pt smaller.
- Type follows Dynamic Type: sizes are system text styles. Exception: the terminal ("Anti-patterns").
- No fonts of its own: the mono ↔ proportional contrast carries the personality. The only font the app ships is the
  Nerd Fonts symbols in the terminal (powerline glyphs, program icons).
- Comparable numbers (timers, counters) use tabular digits (`monospacedDigit`).

### Layout

- iPhone: one column on a navigation stack (list → session). iPad: the list and session columns, with the session
  inspector (the right-hand panel) on demand. Actions sit low (the message field, decision cards at the bottom of the
  transcript), touch targets are ≥ 44 pt (exceptions: "Shape, surfaces and density"), safe-area insets apply.
- An agent row has NO state rail on its left edge: the dot and the word in the state line carry state
  (`waiting for permission · 4m`: the clock follows the state word without a second "waiting", in every language).
  The branch with `↑`/`↓` sits in the project header.
- List order: pinned projects first, then the rest; in both parts projects by name, alphabetically in the app language
  with numbers in natural order ("app2" before "app10"), then by path; under a project, agents from the oldest. Pins
  are kept per device. Activity and an agent's state NEVER move a project or a row: the agent dot colors answer "is
  anyone waiting?", and a folded project keeps showing the agents that wait. The session switcher (a tap on the
  current tab) lists the tabs of the current project in the order of the tab bar.

## Signature

There is no fixed attention strip at the top of the screen: the state dot colors of the agent rows answer "is
anyone waiting?". Permissions, red ones included, are approved with a TAP: the command text is on the card, so a
press-and-hold would be friction without information; the red card and the `permission · risky` label stay. The
permission footer is one row from the left: Allow, then Deny, and a "Yes, and don't ask again…" option sits under
the pair as a tile with its VERBATIM label (wrapped, never cut).

### Decision cards: layout rules

A permission, a question, a plan and a dialog from the terminal are ONE card family with one set of rules (shared
parts: `Session/Cards/CardChrome.swift`). The principle: **a card is a translated CLI dialog**. The terminal shows a
`1. … 2. … ❯` list; the card shows the same rows to tap, with the digit in a key column.

**Plan card:** the agent asks to leave plan mode and shows its plan. The primary gesture, Approve and Return to Auto,
picks the dialog option that approves the plan and puts the session back in the `auto` permission mode. The server
sends that option as `allowAlways`; the card recognizes the plan by `subject = plan` and a present `alwaysLabel`. The
full plan stays readable before the decision. Without that option the card cannot approve: it says the option is
missing and offers Deny.

**Permission card:** Allow (filled with `--run`) and Deny (outlined in `--err`, so a denial is not louder than an
approval) are 36 pt capsules with a 44 pt target, on one row even with the longest label on iPhone; a risky card
spaces the pair wider. Escalation is a TILE under the pair, as wide as its content (an `inner` rectangle on
`--surface-2`, not a capsule): the bold start of the label ("Yes, and don't ask again", "Yes, and always allow", "Yes,
and allow", "Yes, allow reading") over the scope of the rule in small type, with `~` for the home directory and
`$TMPDIR` for the macOS temp directory. No key gives a permission, on a red card too: Allow buttons react only to a
gesture (touch, pointer click, VoiceOver action).

**Surface and header**

- **No tint, no shadow, no padding of its own.** The card is `--surface` with a hairline and the block radius; a tint
  would raise its weight, not its information. Option rows and the footer run edge to edge.
- **The header is one line**: the label, the tool, the path, the clock. Only the metadata shrinks; the uncut path
  stays in the accessibility label, and at accessibility text sizes the header becomes a stack. A question card's
  label wraps beside the clock and is never cut.
- **The label comes from ONE vocabulary** (`UICopy+Cards`, in the `Eyebrow` style), as `<kind>` or
  `<kind> · <detail>`: `permission · Bash`, `permission · risky`, `plan`, `question · Release M1` (a single
  question carries the CLI header in its label; a form has `question` and sections `question 2/3 · <header>`),
  `dialog in the terminal · multi-select`, `directory trust`. It shows before the content, so its form is an interface
  contract: separate strings would give a "permission" that does not say for what. On a red card the word risky wins
  and the tool name moves to the metadata.
- **Red DOUBLES the word risky** and never stands in for it: hue alone is nothing in monochrome and for VoiceOver.

**Rows and the key column**

- **Options are card ROWS** (at least 44 pt, hairlines between them), not boxes or a framed list, which would make a
  second card inside the card. The description sits under the label as a `--muted` block, so it does not drown the
  label in the wide iPad column; an unbreakable string (a path, a rule identifier) wraps.
- **The key column** shows the number of the n-th VISIBLE option, exactly what keys 1–9 address, NOT the number on
  the CLI screen (the card hides chrome and lifts the recommendation). Selection swaps the digit for an amber `❯`;
  multiple choice shows `[ ]` / `[x]`; a row that cannot be picked has `–`.
- **Dimming must not eat legibility**: a terminal-only option dims by COLOR and the `–` key, not by alpha, and a
  "terminal only" note says why. A dashed outline is reserved for the disabled message field, and a control that is
  not a target reacts neither to a finger nor to the pointer.

**One footer**

- **ONE footer per card.** The permission card puts Allow first from the left, then Deny; the question and dialog
  cards have the exit on the LEFT and the main action (Answer) on the RIGHT. The LABEL sets a button's width, not half
  the column: two half-width buttons would read as two equal options where one is an escape from the decision.
- **No button points to herdr**: a card that cannot be approved has Deny and a sentence, because the effect of such a
  button was on the server machine, and the phone showed nothing. The person finds the pane in herdr on their own.
- **There is NO footer where it would carry nothing** (a single single-choice question without Chat about this).

**States**

- **After a tap the card SAYS what went out, and it does not vanish in the same frame.** A status row stands in the
  footer's place (`Sent “Yes” → waiting for the screen to update`, then the acknowledgment). On the permission and
  dialog cards the footer stays in the layout, invisible, so the card keeps its height. After a 200 a consent channel
  card's status row (and VoiceOver) says only that the decision went from this device (`Sent Allow from this
  device.`), because the hook may not have taken the answer yet; the card's state line says how far the channel got.
  The permission card leaves when the server stops waiting. The question card holds the confirmation for 1.5 s. The
  next step of a form arrives only after the server reads the screen again, so the card waits up to 6 s for it
  (`QuestionTiming`). In that window no dialog in the terminal card appears: it would say that Rarog does not know
  what blocks the agent, a second after Rarog itself answered. A refusal (422) and a network error go back to the
  choice with the reason. Unpicked rows dim to 0.4: a transient state, so alpha is allowed.
- **A decision from this device leaves a quiet trace row** in the transcript once the server accepts it (200):
  `Allowed: Bash · npm test`, `Denied: …`, `Approved: plan`, `Answer: Postgres`, and for a form
  `Answers: Postgres · PWA, Swift` (questions split by `·`, values of one question by commas). The subject is the
  card's: the tool name and the command's first line, both cut to 60 characters with `…`, the same for a custom
  answer. The row stands where the decision was taken, under the last message of that moment, so new messages arrive
  below it; it does not fade like the 6 s trace of a card resolved elsewhere. It stays under the same message after
  a server restart, which numbers the transcript anew (the anchor is then the message's server time), and a run of
  tool steps breaks at it, so the run toggle never hides a step from before the decision below the row. It looks
  like a harness notice: a small
  glyph in `--muted-2` (check, cross, reply arrow) and the sentence in `--muted`, no buttons, no red, because the word
  carries the outcome. A decision that did not go through (error, 409, 410) and a decision taken elsewhere leave no
  trace row. A consent channel card gets its row only when it leaves the screen after the server accepted the
  decision, in either order of the 200 and the removal: `Sent Allow: Bash · npm test` or `Sent Deny: …`, never
  `Allowed`, because the 200 means only that the answer went to the hook; the removal leaves no "expired" trace. The
  "sent" state of a card is kept with the decision in the app's store, not in the session screen, so the card still
  says `Sent Allow from this device.` after switching sessions and back. The trace lives in the app's memory only and
  is gone after the app quits.
- The question sentence keeps the screen's line breaks. The Review your answers step is a LIST from `Question.review`
  (the server computes the pairs), one answer per line, so a label with a comma does not merge with the next. The
  Submit answers / Cancel options stay verbatim, because the choice travels by label.

**Content blocks and the screen**

- **The command block** has a cap in LINES: 10, or 16 in the wide iPad column; a plan, text to read before the
  decision, gets 20 and 32 (`CardBlockCeiling`). The cap grows with the text size. A
  `⌄ showing N of M lines—scroll the block` row appears only when the block really cuts.
- **Under a height cap the card is compact** (`decisionDockCeiling`; without a cap nothing changes): the permission
  and dialog cards keep the header (its path on one line) and the footer inside the frame and scroll the content
  between them, with the sandbox warning first; the question card does the same with its sections. A card lower than
  the cap keeps its own height. Sentences next to the buttons (a status row, an error, a lock reason) take at most
  three lines there (two for the status over a footer), cut in the middle for the status, and VoiceOver reads them
  whole. When the header and the footer together are still taller than the cap (large text, low cap), the scrolled
  content keeps its height up to a third of the cap, the header up to another third, and the footer gets the rest; each
  of the three parts scrolls inside its share, so every option, the Type your answer field, the buttons and the error
  stay reachable. A docked card is never taller than the cap (`DecisionDock.compactHeights`). A new card in the dock
  starts scrolled to the top; renders of the same card keep its scroll position and focus.
- **A card without buttons shows the SCREEN, right away.** The dialog in the terminal card and the degraded card carry a
  What the terminal shows block under the refusal reason, with a lower cap of 8 lines. It starts at the BOTTOM
  (`ScreenBlockView`, `⌃ showing N of M lines—scroll up`), because a dialog sits at the bottom of the pane: a card
  that cannot offer a decision must at least show what the decision is about.

**Question text**

- **The question card shows ANSWERS, not the CLI screen item for item.** The chrome Claude Code adds to every form
  tab stays off the card: Type something (a digit in the TUI only OPENS the field, so the answer could never leave
  the phone) and Chat about this (an exit from the form, not a decision). The SERVER marks chrome with the `role`
  field (`custom`/`exit`); the card reads the field, not the text. Every other option goes verbatim, terminal-only
  items included: the card hides chrome, never the author's content.
- **The question card has an EXIT, on the card itself.** Chat about this comes back on the left of the footer as a
  quiet text button that **carries EXACTLY that label**, so the button, the send and the caption after the tap say
  the same thing. The question card does not take `Esc`, and no dialog in the terminal card can appear next to it, so
  the button may not be left out. It is absent only where Rarog does not know its digit: on a multi-question card
  and on a hook-channel card. The server answers a question card by one of two channels (`QuestionRequest.channel`):
  on the `keys` channel it types the digit of the chosen option into the pane; on the `hook` channel it writes an
  answer file that the waiting `PermissionRequest` hook process reads, and no key goes to the pane.
- **Recommendation is carried by POSITION and WORD.** An option with the `(Recommended)` / `(Rekomendacja)` suffix
  goes first with a recommended text badge (no background: on this list a background means selection), and amber
  doubles the word. The label stays VERBATIM, because the server finds the digit to type by the label.
- **A text field exists only where the text can be delivered**: Custom Answer is the last row (key `…`) of every
  question on a hook-channel card and absent on a `keys`-channel card (`customAnswer`, computed by the server),
  because a digit in the TUI only opens the field. The row has no digit: digits 1–9 belong to the author's options.
  Typed text and a selection are TWO answers to one question, and the NEWER one stays; the 2000-character cap is
  shared with the server.
- **A card without Answer says that a tap sends**, in one quiet line and as the VoiceOver hint of every option.
- **An option preview is a command block, not a picture**: the verbatim, unwrapped preview of the SELECTED option (a
  mock-up broken mid-line lies), scrollable on both axes, with the plan cap. On such a card a tap shows the preview
  and Answer sends; a choice without a preview has no block.
- **A note to the choice** is a field under the preview, only with `notes: true` from the server (cap 8192
  characters); it survives a change of choice, goes with Answer, and a refusal (422) keeps its text.

**Keyboard and app frame**

- **A hardware keyboard over a decision card**: `1`–`9` pick the n-th VISIBLE option of a question and `Enter` sends
  the question's answer; on a permission card no key approves. `Esc` with focus on a permission card or a dialog in the
  terminal card means Deny and only that. With focus on a question card Esc does nothing: it is not a decision
  there, and focus in the transcript also keeps Esc from interrupting the turn. Focus on cards is visible (a ring).
  Without card focus, digits and `Enter` go to the first pending question card (with the dock, the docked one); focus
  elsewhere takes them away, so
  `Enter` on a button stays its native activation. A digit in a text field is text, a modifier hands the key to the
  app (`Cmd+1` is the session tabs), and a held key is not a second decision.
- **Two questions on one card** are split by more space than a question and its own options.

## Motion

Minimal and deliberate. On the phone a screen change is the system navigation stack transition; the iPad columns have
none. The activity row's glyph ticks once when the session's own stream brings an event, and the dictation dot moves;
nothing in the activity row moves on its own, and the state dot in the list stands still.

**The transcript does not animate layout.** Disclosures in the transcript (a tool card, a collapsed step series, a
long prompt) change the layout in one step, and an agent delta moves nothing by itself. The step may not take away:

- **the pin to the bottom**: growing content does not unpin a pinned transcript (threshold 40 pt from the bottom);
- **the spot under the finger**: an unpinned transcript keeps the changed element in place (the series disclosure,
  the top of an unfolded prompt, the button of a collapsed one).

Outside the transcript disclosures animate briefly (0.16–0.25 s): projects in the list tree, the inspector's
directories and changes, diff sections, the note conflict banner. The keyboard and VoiceOver unfold by the same path
as a finger: the disclosure state is the truth, not the animation. Reduce Motion turns off disclosure animations and
the scale of the activity glyph's tick (its fade stays); progress stays, because it is information.

## Interface voice (copy)

The app speaks English and Polish and follows the device language; any other language falls back to English
(`docs/localization.md`). The English copy follows Apple's HIG Writing. Screen and sheet titles, buttons and menu
items use title case, with a plain verb first: Allow / Deny / Resume / Stop / Try Again / New Session; the Polish
copy keeps Polish sentence case there. Everything read as a sentence (messages, banners, toasts, empty states) uses
sentence case. State words are lowercase human words: waiting for permission, working, interrupted ("Session
interrupted." with Resume), plan limit ("Plan limit reached. Try again after 14:00."). Errors say what failed, then
what to do next: "The server isn't responding. Check Tailscale." The app never speaks in the first person: progress
is a verb with an ellipsis (Connecting…). An empty transcript says "Tell the agent what to do." from the LEFT, where
the transcript content starts: it is the first line of the conversation, not a poster in the middle of the window.

## Visual direction

Neutral black, hairlines instead of frames, the density of a work tool and a single message field card. What the
direction does not cover: at the end of this section.

### Turns in the transcript

**No role labels.** The bubble and the turn rhythm make a prompt easy to find (more space above a prompt than between
prompt and reply, prose line height 1.5). The bubble sits on the LEFT, where reading starts on a 13" iPad in
landscape, as wide as its content, at most the readable measure, with its time next to it or under it. VoiceOver hears the role
("You:", "Agent:"). There is no button to copy a whole reply: text is copied by selection, a code block by the icon
in its bar. Details: `native/Rarog/docs/rarog-ui.md`, "RarogUI: how it draws".

**Prose at a readable measure.** Paragraphs, lists, quotes and headings end at the line of the widest bubble (47.5 em,
or 38 em in Relaxed spacing), because in an
iPad column in landscape a line would otherwise have 150–190 characters. Code blocks, tables, tool cards and diffs
keep the full width; on iPhone and in a narrow window the limit is off. Settings → Text Size offers Full Width per
device, which drops the limit for agent replies; the prompt bubble keeps its own. Details: `native/Rarog/docs/rarog-ui.md`, "Prose
width".

**Relaxed spacing scales the gaps, not the type.** Settings → Text Size → Transcript Spacing offers Relaxed per device
for more air: every gap between elements (turns, voices, paragraphs, lists, headings) grows by one factor, 1.25, so
the rhythm keeps its order, and the side margin grows with the column (20 pt on a phone, up to 32 pt in a wide iPad
column) while a phone line keeps at least 97% of its width. The message field, the dock and the state card move in to
the same margin, so the foot lines up with the transcript. The readable measure narrows from 47.5 em to 38 em (about 82
characters at 16 pt instead of about 103 on a wide iPad), for the bubble and the quote bar too. The font size, the 1.5
line height and the insides of bubbles, code blocks, tables and tool cards stay, because they belong to the element,
not to the space between elements. Details: `native/Rarog/docs/rarog-ui.md`, "Transcript spacing".

**The quote bar looks like a bubble**: the bar with the previous prompt at the top of the transcript wears the
bubble's plum plate (`userPlate`), aligned with the content, so it reads as the prompt that the content under it
belongs to. Details: `native/Rarog/docs/rarog-ui.md`, "RarogUI: how it draws".

**Adjacent tools as one card.** Consecutive tool rows with nothing between them form one plate with a hairline between
rows, because a wall of separate cards would break up the reply; the disclosure of a collapsed step series
(`UICopy.toolRunLabel`) is a row of that card. Each row unfolds on its own and is a separate VoiceOver element. There
are no error rows: the protocol carries no tool result, and the client does not decide by tool name. Details:
`native/Rarog/docs/rarog-ui.md`, "Tool card".

**A long prompt collapses.** A prompt longer than 15 lines shows 6, fading into the bubble color, with a quiet
Show All · N lines button inside the bubble. The criterion is text length, not paste detection (the server strips
paste markers), and the line count does not depend on the window width. VoiceOver, selection and copy get the whole
text. Details: `native/Rarog/docs/rarog-ui.md`, "Long prompt".

**A question to you behind an amber stripe.** A top-level paragraph of an agent reply that starts with a bold
`Do Ciebie:` or `To you:` (the Polish and English markers of the agents' reply style rule, same rules for both,
`MarkdownQuestion.markers`), and everything under it to the end of the text block, stands behind a `--wait` stripe at
the left content edge, indented like a quote but in prose ink. The stripe runs unbroken through the gaps and looks the
same on every question ("Second exception"). Quotes, list items, headings, code blocks, human bubbles and project notes
do not count; streaming replies do. VoiceOver reads the marker from the text. Simulator screenshot: the demo seed
`demo-map-view`.

### Rhythm and layer tokens

The rule: **a literal in a component rule is a bug** when a token with that role exists. Tokens cover colors
(`PaletteTokens`, `Palette`), radii (`Radius`; a numeric radius appears only there, `CornerRadiusSourceTests` checks
it), the pointer look (`HoverTokens`), the tab bar (`TabTokens`), list spacing (`SessionListMetrics`), the prose
line height (`ProseLeading`) and the transcript's gaps and side margin in both spacing modes (`TranscriptSpacing`).

- **Controls** have a 44 pt touch target; the visible sizes are 32 pt (message field circles), 36 pt (card footer
  buttons) and 40 pt (Send).
- **Hairlines** use one ink, `--border`, for every outline and separator.
- **Selecting in the transcript keeps focus; focus returns to the prompt field after a copy.** A click or a drag in
  the transcript NEVER touches focus, because moving focus to the field would move the selection the person is making.
  The paths back to the field:
  - **A selection copy** with the pointer (Cmd+C, the Copy menu) returns focus right after the copy; after a finger
    it does not, because it would open the on-screen keyboard.
  - **Esc** interrupts the turn; it is not a "back to the field" key. A focused card (Esc = Deny), an open window,
    character composition and the command suggestion list come first; Esc in a window does not interrupt the agent.
  - **Tab** outside an edit field goes to a pending decision card first, otherwise to the prompt field. Inside an
    edit field Tab belongs to the field; Shift+Tab stays with the system.
- **Focus on return to the app** stays in the field it was in.
- **Keyboard focus is visible**: a `--text` ring on list rows and around decision cards; the message field shows
  focus by its text cursor. Focus without a visible indicator may not sit anywhere.
- **Dimming** follows the role, not one number: a disabled main action loses its fill, a disabled card button and
  unpicked options after an answer go to 0.4, a row in flight or frozen to 0.55. The transcript under a decision card
  dims per row ink, at most to 0.8, so dimmed content keeps ≥ 7:1 (`TranscriptDim`).

### Element types

Between the tokens and the screens sits a layer of TYPES: an element of a type takes its definition instead of
repeating it.

- **eyebrow** (`Eyebrow`): a machine label in mono `caption`, medium weight, uppercase, tracked, `--muted`: card,
  popover and inspector section labels, AGENTS (N). Uppercase is visual only: VoiceOver gets normal case. Form
  `Section` headers are system headers in `--muted`, as in Settings.
- **state dot**: the state color stays with the element (`--wait`, `--run`, `--err`, `--new`, `--done`).
- **pill** (`PillLabel`): a capsule with a 44 pt target, mono, one line, a `--border` hairline. A tone (`auto` in
  amber, `plan` in `--new`) changes the text and the background, not the shape.
- **surface**: decision card, state card, banner, popover: `--surface`, a `--border` hairline, `Radius.block` (12 pt).
  An element inside a block (a code block, a command block, a tab plate, the escalation tile) has `Radius.inner`
  (8 pt). The
  component adds elevation, not the type.
- **banner**: a surface card with a tone dot (`--err` or `--done`) and a sentence to the person, never an
  edge-to-edge bar, which reads as a system failure notice. Banners stack in a strip that takes no space when empty.
  The connection is one card in the place of the missing-server banner, in the column the person looks at (the list
  column, or the session column when the list is hidden, also on iPhone): "Connecting to the server…" with a
  `--done` dot while no attempt has failed, then the same card turns into "The server isn't responding" with an
  `--err` dot. A drop while the app is in use shows the card at once; a start and a return from the background show
  it only after 3 s, because iOS drops the stream every time the screen sleeps, the iroh tunnel takes up to ~1.4 s to
  carry requests again after a few minutes in the background, and a card that comes and goes would move the list
  twice on every unlock (`ConnectionMemory.connectionCard`, `Model/BannerSlots`). The red card needs a failed attempt
  that ends 3 s or more into the gap, whatever started it: the first attempt after a return often runs on the tunnel
  that died in the background, and a VPN interface that blinks for a moment makes iOS report a network change and
  restart the streams; in both cases the first attempt fails at once and the stream is back within a few seconds.
  The same gray
  card stands when the open session's stream has not come online for 3 s while the global stream is online, counted
  from whichever comes last, the session stream's start or the global stream coming online, and from zero after a
  session change (`ConnectionMemory.sessionStreamCard`). A failed or dropped session stream shows only "The transcript isn't
  coming through", and the red card comes only from the global stream: one failure, one banner. A scene back from the
  background as inactive, whose streams wait for active, counts as a start. The card enters at its moment by itself,
  with no other change of state (`Views/BannerStack`).
- **popover** (on iPad: git, background tasks, model, prompts): solid `--surface`, NOT the iOS system glass, because
  over the dark transcript glass would drop `--muted-2` to 1.75–3.6:1 and hide `--surface-2` capsules. The color
  covers the WHOLE popover platform, so iOS draws no arrow and the popover is a rounded rectangle at its control, like a
  system menu ("Windows, popovers and forms in the native app").
- **header icon button** (`HeaderIconButton`): no background or outline, the glyph `--muted-2` → `--text` under a
  finger and the pointer, a 44 pt target.
- **main action**: filled with text ink, the label in the background color (Answer, Launch).
- **The touch response is BACKGROUND, never geometry.** A press changes background and outline; a tab dims. There is
  no press scale: on a decision card, where the tap IS the decision, a shrinking row would read as a rendering glitch.
- **Hover belongs to the POINTER, a press to both.** The pointer highlight exists only with a trackpad or a mouse; on
  touch the press is the only signal, and a highlight left on a tapped element would lie about state.
- **A button with a shortcut names it under the pointer** ("New Session (⌘N)"): the app's own tip (`ShortcutTip`)
  appears after the pointer rests on the button for 0.6 s, below it (above it at the bottom edge of the window), on a
  `--surface` plate with a hairline and `inner` corners, and goes away when the pointer leaves or the button is pressed.
  A finger never shows it. The system tip (`help(_:)`) does not appear on the iPad, and on the Mac it would stand next
  to the app's own, so these buttons do not set it. Name and keys come from one definition (`AppShortcut`), which the
  shortcut registrations read too; key glyphs stay outside the catalog, in the order ⌃⌥⇧⌘. VoiceOver does not read the
  tip: the button label names the action, and the hint never spells a glyph. Buttons with a tip: New Session (list
  and the tab bar "+", one line per menu item, with New Terminal ⇧⌘N), the list toggle (⌘B), the inspector (⌘I),
  Terminal in a Window (⌘F), the session and terminal "×" (⌘X), the note (⌘J), the microphone (⌥⌘M, or the
  shortcut chosen in Settings), Send and Stop (↩, Esc), the sheet close button (Esc, ⌘W), Launch in New Session (⌘↩)
  and Select Output on the terminal key bar (⌘Y). The sidebar's icon buttons without a shortcut show their name alone in
  the same tip (`pointerTip`): Settings at the top of the list, and Terminal in a Window, Recent Sessions and the note
  in a project header.

### Shape, surfaces and density

- **Compact over air.** This is a work tool, not a landing page: less padding, more information per screen. An agent
  row has two lines, the session name and a mono state line (tree spacing: "Native app list: project tree"); the
  session header is the navigation bar, the tab bar and the status line with git; the message field grows with its
  content up to 8 lines.
- Radii: one block radius (`Radius.block`, 12 pt: cards, the message field, bubbles, list row selection) and one
  inner radius (`Radius.inner`, 8 pt); the floating message field card near the screen corners is the exception
  with 26 pt; pills,
  buttons are capsules, and the Scroll to Bottom button is a circle. A child radius is ≤ its parent's radius.
- Hairlines instead of strong outlines; where a list is dense (git files, question options), a hairline between rows
  instead of full cards.
- Touch targets STAY ≥ 44 pt: compactness comes from visual padding, not from smaller hit areas. The exceptions live
  in the continuous transcript content: the tool card header (36 pt) and the code block copy icon (44 × 36 pt). One
  more stands in the tab bar: the "×" of the current tab is 28 × 44 pt (at least the tab's height), because
  a 44 pt width would push the glyph far from the label it closes; the tab's label beside it is a target of its own.

### Tab bar in the session header

The sibling bar navigates the sessions of THIS project, so its 44 pt is a fixed cost of every session screen. Siblings
have no chrome: outlined pills would give seven frames in a row with five sessions and a "you are here" to hunt for.
A tab is its text and a state mark before the label; the current tab adds a plate and its
"×". Numbers: `TabTokens`; views: `Views/Projects/ProjectTabBar.swift`, `Views/Projects/TabCloseButton.swift`.

- **State is a MARK before the label, in the color of the session list dot** (`PaletteTokens.tone`): a small square,
  or with a hardware keyboard a tile with the shortcut digit. Quiet tabs are neutral; working, unread, waiting, error
  and waiting on a background task take the full state color. On the smoked green tile the digit is dark in both modes
  (`onRunSmoked` `#0A0A0A`), because white keeps only 3.5:1 there; with "Differentiate Without Color" that tab has an
  hourglass mark, opaque also on a sibling tab (other marks sit at 70 % there, `TabTokens.markAlpha`), and its
  VoiceOver sentence adds "waiting on a background task" after the status word. A session whose subagent has waited
  long on its own command (`backgroundWaitLong`) takes the waiting color with a `timer` mark, opaque on a sibling too
  (the waiting color at 70 % keeps only about 2.9:1 in light mode), and its sentence adds "waiting a long time on a
  background task" (`subagent-long-wait.md`, "Session row"). The mark is ALWAYS there and the tab
  width does not depend on state (`HeaderChromeTests`), so a sibling's state change does not shift the bar; only
  being the current tab adds width (the "×", below). The tile
  is opaque, so its digit keeps 4.5:1 on the current plate too (`PaletteContrastTests`).
- **"You are here" is the plate and the label.** The current tab sits on a plate in the color of a selected agent row
  (`tabPlate`) with a semibold `--text` label; siblings have no background and a `--muted-2` label, and under the
  pointer the plate at half opacity. In light mode the plate barely differs from the background, so the bold label
  carries most of it. A tapped tab dims and comes back in one step: a smooth return would look like a new tab
  lighting up.
- **Terminals and + are ORDINARY tabs at the end of the one list**, in the same scroll: items pinned to the right edge
  would split the bar in two. A terminal carries a label (the process name) and a quiet state mark (`live` is a
  technical fact, not work). The terminal invite and + have no mark: they stand for no shell and no session. The note
  tab and + are glyph-only targets; the note glyph color says whether the note has content (VoiceOver hears it in
  the value), and an `--err` dot says there is text not saved on the device ("Project note").
- **A scrolled bar fades the edge content hides behind** (`TabTokens.edgeFade`), because a letter cut at the edge
  reads as a rendering bug, not as "there is more". The fade grows with the scroll, and the mask covers the scroll
  alone.
- **The current tab sits in the middle of the bar, as far as scrolling allows**, always fully on screen. The bar
  scrolls to it on entering the screen, on a change of the current tab (in the tabs' slide, below) and on every
  other change of the content width (a hardware keyboard, a new or renamed tab; `PhoneTabsUITests` on iPhone). The cost:
  a renamed sibling brings the bar back to the current tab even right after a manual scroll.
- **Each tab is its full-height box**, so the 44 pt target needs no extension; the content sits slightly below the
  middle (`HeaderMetrics.tabLabelDrop`), nearer the git line.
- **The current tab carries its "×"**, so the close sits on the tab it closes: a session tab, and a terminal tab,
  also one with an agent inside it and New Terminal while it opens. After the label stands a divider, the one of the
  N new messages pill: 1 pt in `--border`, half the plate's height, 6 pt after the label. Then the "×": a quiet
  `xmark` in `--muted-2` (`--text` under the pointer) in a target of its own, 28 pt wide and as tall as the tab
  ("Shape, surfaces and density"), outside the tab's button. A tap on the label still opens the session switcher;
  VoiceOver hears the "×" as its own element named by its effect (Close Pane in herdr, for a finished session Remove
  from List, on a terminal Close Terminal), and the tab's sentence goes without it. The plate spans the label, the
  divider and the "×". Siblings, the invite and + have neither. The header's top right corner has no "×", with one
  exception: a terminal opened from a link before the list knows its project has no tab bar, so its "×" stands in
  the header icon group, where an armed press asks "Sure?" in text.
- **A running voice conversation across sessions lights a circle first in the header icon group** where the list
  header is off screen (iPhone with a detail screen over the list, iPad with the list column hidden): the list
  header's 32 pt circle filled with the state's tone, with the voice bars inside, in the same 44 pt target; a tap
  ends the conversation. The group holds three icons at most, so on a terminal without a tab bar Pop-Up Terminal
  gives way to it (`HeaderTrailingIcons`). The Inbox at the root of the iPhone's stack shows the same circle after
  its title. Beside the list column it stands in the list header only. After an end, the end sentence stands in one
  line, a dot in the state's tone and the whole sentence, under the list header or above the screen; a tap removes
  it.
- **The current tab is wider by the divider and the "×", and only by them.** The place for the "×" depends on
  lasting traits alone (a session or terminal tab, current), so a passing state changes the glyph and never the
  width: the list from the cache and a session the app cannot close (Codex, an unknown engine) show a dimmed "×"
  without an action, and so does a terminal whose screen is not attached yet; a close on its way shows a spinner
  (`HeaderChromeTests`).
- **A change of the current tab slides the siblings instead of jumping them.** Every tab has the room for the
  divider and the "×" after its label, open only on the current tab: the old current tab's room closes while the new
  one's opens, in 180 ms ease-out (`TabTokens.closeRoomSlide`), so the tabs between them glide by the room's width.
  Nothing else moves or fades: the plate leaves the old tab and stands on the new one at once and grows with its
  room, and the weight, the colors and the "×" switch in one step, because a plate or a label that eased in would
  look like a tab lighting up. The room clips the "×" while it opens, so it never lies over the next tab. Centring on
  the new tab runs on the rooms' clock: the scroll takes the centred offset at once (`TabBarCentring`), and the row
  and the edge fade are drawn shifted back by the distance still to cover, from the same animation as the rooms
  (`TabBarFollow`), so frames that the new screen's build holds are lost to both alike and the bar never runs ahead
  of the slide. Only a change of the current tab within the same list slides: when a tab comes or goes with it (New
  Terminal, closing the current tab) and with Reduce Motion, the bar takes its new layout and its centring at once
  (`TabCloseRoomMotion`).
- **Closing takes two presses.** The first press, by the "×", ⌘X or the state card's close button, arms for 5 s: the
  "×" turns `--err` on an `--err` wash in the same width, and a card under the bar, on the notice's surface, says
  what the next press does ("Press again to close the pane.", for a finished session "Press again to remove the
  session from the list.", on a terminal "Close terminal: press again to end the shell on the Mac", or on the VPS).
  VoiceOver hears that sentence once, when the close arms, also while an error notice shows instead of the card. The
  card follows the arming: it goes after 5 s, on a tap on another tab, when the message field takes or gives up
  focus, on a screen change, when the app leaves the foreground, and on the confirmation. It takes down only itself,
  and a newer error notice shows instead of it. A second press within the 5 s, by any of the three ways, closes, with
  a spinner in the glyph's place on the way. A terminal arms by its "×" or ⌘X and keeps its own 5 s on the terminal
  screen; the late result of a terminal's close leaves the arming of the tab the human moved to.
- **The shortcut tile.** With a hardware keyboard, every tab that `Cmd+digit` opens shows that digit on a tile:
  positions 1–8, and 9 on the last tab when it sits past the eighth. The other tabs from the ninth on have a square,
  and the terminal invite and + have neither. An open terminal window (Cmd+F, Cmd+G) keeps the tiles, although the
  shortcut is silent then: vanishing tiles would shift the tabs under the window every time it opens.

### Composer

One floating message field card of glass ("Glass"), 26 pt radius, 10 pt from the column's edges (in Relaxed spacing
at the transcript's margin), with a hairline
edge. Its first line is the activity row's band: it opens at the start of a turn (the session working or starting, or
the row with a transient status: interrupting, connecting…, the agent starting) and closes at the turn's end, so the
card keeps its height while the line goes out and comes back in a turn, and an idle card is only as tall as the field.
The card grows and shrinks upwards (its bottom, the field and the buttons stay) over 0.2 s, without motion under
Reduce Motion (`ActivityBand`). Its last line is the message line (a failed send, an interrupt refusal), which wraps and
shows only with a sentence. The text field grows with its content up to 8 lines; under it a row of controls: the
paper clip, the model pill, the permission mode pill, the voice agent's waveform (when the feature is on), the
keyboard dismiss on iPhone, and on the right the microphone and **a round ↑ button** (accessibility name Send). The
microphone is a plate as big as Send (40 pt, `--mic-plate`) with a `--text` icon, 16 pt before Send:
dictation is the main way in, so it outranks the outlined controls without taking the accent. The waveform stands in
the left group, so the two voice controls are not side by side. While recording, or with a voice conversation muted,
the plate turns `--mic-plate-live` and its outline and icon `--err`. Send is filled with the accent when there is something to send
(text other than whitespace, an attachment, dictation in progress), otherwise outlined like the paper clip and still
enabled (a tap focuses the field).
A Codex session has no pills: it has no model or mode to change. Code: `Session/ComposerView.swift`,
`Session/ComposerActionBar.swift` (`RingButton`, `SendButton`).

The transcript runs to the bottom edge of the screen and the foot floats over it: the field card, or with the field
hidden the activity row's narrow card above the dock, the state card or nothing. Around the cards the transcript shows
through, and under them it fades into the system's soft scroll edge. The transcript's bottom inset is the distance
from the top of the foot to the bottom of the screen plus 12 pt, so it follows the activity band; a transcript pinned
to the bottom stays there when the band opens or closes, an unpinned one keeps its rows. The scroll indicator has the
same inset. With the keyboard down the field card, the dock and the state card end as far from the bottom edge as the
content of the list footer bar (`ListFooterMetrics.bottomGap`), so on the iPad the field card ends on the line where
the footer's text does; over a keyboard
they keep 10 pt of air. The Scroll to Bottom button and the toast above the prompt stand 8 pt over the top of the foot. Card choice,
focus rescue and revealing a focused card count only the part of the transcript above the foot.

The field card and the narrow activity card cast a delicate black shadow, radius 16 pt, 4 pt down, at 0.9 in the dark
theme and 0.16 in the light one, drawn only outside the card (`PaletteTokens.cardShadow…`); the field card has no
change of look on focus, and its controls have no glass of their own: among them only a filled Send has a shadow. A
disabled field (the message will not arrive) gets the dashed outline reserved for the disabled state, and its content
dims; the activity row and the message line do not. While the agent starts, the activity row has its start glyph
before the reason sentence. When nothing can be sent (interrupted, limit), a state card with a sentence and an action
(Resume in the accent) stands in the field's place, 10 pt from the edges like the field.

**A waiting decision hides the field.** A permission card, a dialog in the terminal card and a question card stand at
the bottom of the transcript, and while one of them waits for a decision the field is hidden and the foot keeps only
the activity row's reserved band. While the row has something to say (interrupting, connecting…, the agent's work),
it stands there alone, in a narrow card of the field's glass. The foot is one stack of the activity row's card, the
field, the decision dock and the state card; of the last three at most one shows (`FootContent`, placement in
`DecisionDock.placement`). The field also hides during the 2 s grace period before a dialog card
(`DecisionGraceTiming`), when the placeholder without buttons (Waiting for the dialog…) is the last transcript row
and the card that arrives takes its place, and before the first transcript snapshot of a waiting session. The held
confirmation of an answer alone does not hide the field: the session is already running. A locked card (herdr
unavailable or read-only) keeps the field, read-only with its sentence. The field hides with the keyboard,
unless focus is in a card's Type your answer field; dictation in progress ends and keeps its text; the draft,
attachments and dictated text come back after the decision, without the keyboard. VoiceOver focus in the field moves
to the card's cell.

**Decision modes.** One constant, `DecisionDock.mode`, picks where a decision card stands; switching means changing it
and building the app again. `.transcript` (the default) is the behavior above. `.dock` puts the first card of the
queue in the field's place: with more than one card a `1 of N` header on a capsule of the same glass stands above it
and the rest wait in the
transcript; the card is at most `min(0.5 × screen height, room above the keyboard − 120 pt)` tall
(`decisionDockCeiling`), so on an iPhone the Type your answer field stands above the on-screen keyboard; the dock clips
a taller card; under the card stays the same rest as under the field; the grace placeholder stands in the dock, and
before the first snapshot the dock is empty. `.readOnlyComposer` keeps the cards in the transcript and the field under
them read-only with its sentence.

**The MODE pill is a control**: while sending is blocked it stays tappable to say why the change will wait, and a tap
toggles `plan` ↔ `auto` (`POST /api/sessions/:id/mode`). Success does NOT flip the pill: the list stream brings the
new mode after the server reads the pane footer. `auto` has the amber tone (the pane does not ask for permissions),
`plan` the `--new` tone. The MODEL pill opens the model and effort popover (`ModelSheet`; on a phone a sheet as tall as
its content): Model and Effort are rows of the recent project chips of New Session (`Views/Common/RecentChip.swift`)
that flow into further lines when they do not fit, and, for a model the server announces it for, Ultracode is a system
segmented control Yes / No.
A model without effort levels shows a sentence instead of the Effort chips. Without proof on the session card no
Ultracode segment is selected; a session with ultracode ends the model pill text with that word.

**Stop is the same round button as Send**, in `--err` with a ■ icon. It stands in Send's place when the field is
empty and the session works OR has an entry in flight (an optimistic send does not change the session state, and the
phone has no Esc), except for 0.7 s after a send, so a double tap does not interrupt the fresh message. "In flight"
means NOT EXPIRED: an entry Not confirmed 15 s after the server accepted it proves no turn, and a CLI queue entry
proves a turn only while the session is in that queue. An expired entry has a `Not confirmed. [Retry] [Discard]` row:
Retry sends THE SAME entry again (the same `clientMessageId`), Discard drops it locally, for when the message arrived
but its echo did not match.

**Elevation and hover are RANK, not ornament**: only a filled Send gets a shadow, as only it has color; an empty
(outlined) or disabled Send, Stop, the microphone and the paper clip lie flat. Under the pointer the whole row follows
one rule: an outlined control (the empty Send included) gets `--text` ink and a stronger outline
(`HoverTokens.outlineStroke`), a toned pill keeps its color, a filled Send, Stop and the microphone's plate lighten
their fill (`Palette.filledHover`), and a disabled control does not react.

**An interrupted turn speaks in TWO places, split by one question: did the server TOUCH the pane at all. The
transcript carries what happened on the server's side; the message line of the field card carries what the PHONE
knows**
(`Model/InterruptPresentation.swift`).

- **The transcript** carries the RESULT, written by the SERVER: at most one system entry per gesture. The success
  sentence (`INTERRUPT_DONE_MESSAGE` in `server/src/drivers/herdr/commands.ts`) appears only when Esc really found a
  turn in progress. A refusal the pane SHOWED (herdr refused, the pane vanished, read-only mode, an unknown failure)
  goes there as a ⚠ warning with its cause. So the effect reads together with what the agent wrote, survives typing,
  and shows on a second device and after coming back to the session.
- **The activity row** at the top of the field card carries the transient STATUS interrupting, with its own stop glyph
  and the turn clock, in the band the turn already holds open: a new line would shift the field on every Esc, and a
  spinner on Stop fails because the button is sometimes hidden exactly then. When a decision hides the field before
  the interrupt's reply, interrupting stays on screen in the row's own narrow card.
- **The message line** at the bottom of the field card, the one that shows a failed send, is for everything but
  success: "Couldn't confirm
  that the interrupt went through. You can try again." and EVERY refusal. The transcript is sometimes mute (a refusal
  at Rarog's gate writes nothing there, and an event stream can die silently), and without this line a failed
  interrupt would look like a successful one. After a SUCCESSFUL interrupt the line goes out: one event, one trace.
- **The message field** ends as Claude Code's own field does. It gets only the prompt the CLI handed back to its
  field, as the interrupt answer reports it (`returnedPrompt`), never a text from the app's memory: a queued prompt
  runs after Esc, so a copy in the field would be sent twice. An empty field holds the handed-back prompt; text typed
  while the answer travelled stays, with the prompt on its own line before it (the queue take-back's order) and the
  cursor where the typing stopped. Without a hand-back the field stays as it was. VoiceOver hears "Interrupted. The
  prompt is back in the field." or "Interrupted." The prompt belongs to the session, not to the screen of the
  gesture: an answer after that screen closed or gave way to another goes to the field of the session's screen that stands
  then, or else into the session's saved draft, by the same rule. Only an answer from before a logout is dropped.

**A refusal says WHO refused, because the person's next move depends on it.** When Rarog cut the key off before the
pane (sending to herdr disabled, read-only mode, a pane outside the allowed directories, an unknown session), the
pane works, so the sentence does NOT send the person to the Mac: "Rarog didn't interrupt the turn. It isn't allowed
to write to this pane or has no way to." When the key TRIED and failed: "Couldn't interrupt because the pane didn't
accept Esc. Open it in herdr on the Mac and press Esc there." (in `--err`). Interrupting and "Couldn't confirm…" stay
NEUTRAL, because red means an error or a destructive action. A retry is the same gesture again (Esc or Stop), with no
button of its own.

**Whoever had the cursor before a paste keeps it after.** The thumbnail strip enters ABOVE the field, so it is the
only thing in the card that could take the caret. The strip is chrome, and focus goes back ONLY to whoever had it:
pulling the cursor into the field after the paper clip or a drag would open the on-screen keyboard for someone who has
just picked a photo. Programmatic focus shuffling in the field is forbidden.

### Glass

Glass (the system material with blur) makes sense only when something flows under the element. The app uses it for two
small elements over the scrolling transcript: the Scroll to Bottom button and the N new messages pill (with Reduce
Transparency, solid `--surface`), and for the floating cards of the session foot: the message field card, the narrow
activity row card and the "1 of N" header of the decision dock ("Composer"). The list footer bar is a system blur without a
rim ("Native app list: footer bar").
Opacity and blur go together: without blur the transcript letters would pass sharply through the text. Everything else
is solid: popovers, the session switcher and the command suggestions are `--surface` (see the popover type), windows
are `--bg`, and the controls inside a glass card keep their own fills.

The floating cards share one material, which comes from a contrast measurement, not from the system default: in
the dark theme every ink on the message field card keeps 4.5:1 over `--bg` and over the text and code blocks
scrolling beneath it. There a Liquid Glass tint darkens the glass, so the card is untinted `.regular` glass under
a `glassCard` layer (`#1F1F1F` at 0.75); the brightest glass measured under the field (prose and a code block, iPhone screenshots) is
`#3D3D3D`, which the layer turns into about `#272727`, `--muted-2` about 4.5:1. The light theme tints the glass white
at 0.4. Reduce Transparency gives the solid `glassCard` (`#1F1F1F`, white). A 1 px light line draws the edge, white
at 0.22 in the dark theme and 0.9 in the light one, a rim of light like the system glass; with Increase Contrast it
is the `--border` line. Values: `PaletteTokens+Glass`, contrast: `GlassCardContrastTests`. The session foot is UIKit
and uses `GlassSurfaceView` with these values (`Palette.glassCardLayer`, `glassCardTint`, `glassCardEdge`,
`glassCardSolid`). Screen chrome is the system navigation bars; in a sheet glass appears only in the system
navigation layer, not in the content.

### Windows, popovers and forms in the native app

Every presentation is one of three kinds, and the task decides which:

- **popover**: next to a control, fits one screen, losing it costs nothing (git, background tasks, model, prompts, the
  project note for reading);
- **form**: writing or creating something (new session, recent sessions, the project note for writing);
- **window**: large content to read or work in (terminal, lazygit, history, diff, transcript text).

Size says how heavy a thing is, so the differences BETWEEN the kinds stay and the differences WITHIN a kind go. Code:
`Views/Presentation/` (`WindowLayout`, `SheetScaffold`, `PopoverLayout`, `PopoverSurface`).

**A sheet is a system container.** The system gives the geometry and the bar; the app tokens give the ink, the type
and the content surfaces:

- glass appears only in the system navigation bar and its default buttons, as Apple keeps glass in that layer;
- close sits on the LEFT, as an `xmark` (Apple's guideline for sheets, and safety: on the terminal route the × on the
  right kills the shell, so a harmless close may not sit there);
- the title is the kind as an eyebrow, then the project name, the only thing the window content does not show;
- the window has no background, glass or radius of its own: the content paints `--bg`, and a 1 px `--border` outline
  (stronger with Increase Contrast) gives it an edge over the dimmed app;
- windows share one width, `min(window − 32; clamp(window × 0.92; 720…1400))`, and the system size at `compact`;
  content corners stay clear of the system corner arc (`WindowLayout.bottomInset`), except the terminal grid;
- Esc and Cmd+W close a window (otherwise Cmd+W would close the app scene), and a window gives the keyboard back to
  whoever held it.

**Three surface backgrounds**, never side by side: a popover is `--surface`, a window is content on `--bg` with an
outline, a form is the system greys. A custom element takes the background of its presentation.

**One sheet at a time.** A window takes the place of a window (Cmd+F or Cmd+G over a diff or history opens the
terminal there; the same shortcut over its own window closes it). A form holds, because it has state: a window
shortcut over a form is silent. A popover yields to a sheet (Diff in the git popover closes the popover and opens the
window). Under a sheet the screen-changing shortcuts are silent and their menu items disabled (Cmd+1…9, Cmd+L, Cmd+N,
Cmd+Shift+N, Cmd+X, Cmd+B, Cmd+I), and letters typed there do not reach the message field. A screen change from
outside (a notification, a vanishing session) closes a window, not a form.

**Deliberate departures from Apple's guidelines:**

| Departure | Guideline | Reason |
|---|---|---|
| popovers on solid `--surface` | no presentation background | `--muted-2` on glass 1.75–3.6:1 |
| own window width | `.page` or `.form` | terminal, lazygit, history, diff columns |
| own title view in the bar | standard components | project name, subtitle contrast |
| no × on phone popovers | Cancel at the bar start | shortcut, tap outside, swipe down |

**The terminal window** (`Terminal/TerminalWindow.swift`) has a UIKit bar, so terminal focus and Esc can be tested.
The bar is the bar of every window: × on the left, the "KIND project" title, ⋯ on the right. The grid starts below
the bar, so row 0, where `clear` puts the prompt, is never under the glass; the grid bottom touches the corner arc.
The ×, Cmd+F or Cmd+G, Esc in the shell, a tap outside (iPad), a swipe down from the system grabber (iPhone), `exit`
and the VoiceOver back gesture close it; every close only detaches, and the pane in herdr keeps running. The device
decides about the grabber, not the window width. History is a page of the same window (‹, Copy All; Esc, Cmd+W and
Cmd+Y go back to the terminal). Esc in lazygit reaches the program only while it runs.

**The Transcript Text window** (`Session/TranscriptSelectionSheet.swift`) exists because a system selection (a finger,
the pencil) lives in one text view and does not cross transcript cells; a pointer drag selects across messages on the
session screen itself (`native/Rarog/docs/rarog-ui.md`, "RarogUI: how it draws"). Select More… at the end of a
message's selection menu (a table cell's too) and in the right click menu on a pointer selection opens it: one
read-only text view with the loaded messages as plain text, a role and time header line per message, a blank line
between messages, a table as tab-separated rows, a tool card as its line and an image as its VoiceOver label. A handle
drags across messages and the view scrolls under it. The text is taken when the window opens, so a reply arriving
behind it does not change it. The cursor starts at the message the menu came from; the title is the kind and the
project, Copy All sits on the right, and Esc, Cmd+W and × close it, as in History.

**The band around the grid** takes the color of the neighboring cells, so nvim with a theme or lazygit get no frame in
the app color (`Terminal/TerminalEdgeFill.swift`). A row extends always on the alternate screen, and on the main
screen only when no cell has the default background: zsh prints an inverted `%` in column 0 after output without a
final newline, and that block must not reach the window edge. Under a bottom row with a powerline glyph (nvim's
lualine) the band takes the row's most common background, so lualine's rounded capsules get no square "feet".

**The Esc grace window:** for 300 ms after a presentation closes with Esc, another Esc neither interrupts the turn nor
denies the card below.

**The New Session window** (`Views/NewSession/NewSessionSheet.swift`) has three sections and a footer: Project (the
name, the shortened path, Change, and below them one scrolling row of recent project pills ending in More…), Start
(the mode as a system segmented control, model and effort menus, one sentence about the mode, and an ultracode toggle
only for a model that has it), and Conversations (one-line rows in two groups, Open above Resumable, with the status
as muted text: resume a closed one, go to an open one, or Fork). Change and More… open the directory browser in place
of the project row: an Up button followed by the clickable path, a filter field, and compact 44 pt rows with
`current`, `git` and `history` marks, where a tap anywhere on a row opens that directory (the trailing chevron is
only a sign). Up goes to the parent directory and is disabled on the roots level. When the server creates directories
in the listed one, a New Directory button (a folder glyph) ends the path row; it opens a name field in place, with
Cancel and Create beside it (Enter sends too), and the server's sentence under it after a refusal. A created
directory opens at once, and Choose takes it without the warning; when the name is taken, the list reloads under the
sentence. While the browser is open, the
footer holds a hint, Cancel and Choose <name> for the directory on screen in place of the summary and Launch (one
line when they fit, otherwise the buttons one under the other with the name wrapping; no Choose on the roots level),
and the warning before a choice stands there too; Start folds to the settings sentence and Conversations wait for
the choice. Section headers are system headers in `--muted`, as in Settings. Amber in this window marks auto mode and
the warning before choosing a directory that is neither a repository nor has sessions (Choose Anyway is the one amber
button). Forms (New Session, Recent Sessions) share one scaffold (the `.form` size, the system background and bar,
close on the left); while Launch, Resume or Fork runs, the form cannot be closed and its content is disabled.

**Buttons in presentation content** use the app styles, not the system `.bordered`: at most one main action (Launch,
Allow), filled with text ink, which loses its fill when disabled, because a grey fill would look like an active
neutral button; a neutral secondary action (Try Again); in conversation rows the whole row is the target, with Fork as
the only extra button.

**Popovers** (git, background tasks, model, prompts, and Usage from the app's `/usage` command) have one size and one
anatomy:

- width 320–560 pt; the height comes from the MEASURED content up to a 600 pt cap, so a short list leaves no empty
  strip, and longer content scrolls inside;
- iPad: no title bar and no close button (a tap outside and Esc close it), eyebrow labels for sections. Usage sits at
  Send, where the command came from;
- phone: the popover is a sheet with a title bar, detents and a grabber. The device decides, not the window width: in
  a narrowed iPad window the popover is a sheet without a bar, because a bar added on the fly would wipe its state;
- the way to a bigger view is a quiet footer row: Diff in the git popover and Open in Inspector in the background
  tasks popover are the same component.

### Status and git

- Session state in the list is a colored dot and a mono word (`waiting for permission · 3m`): the dot carries the
  color, the word the meaning. In the session header the tab mark says the state ("Tab bar in the session header").
- The status line under the tab bar: `◔ 12% · main · ↓2 ↑1 · +3 ~5 −1`. A context ring with a percentage, the branch,
  the drift from upstream (`↓` in `--behind` to pull, `↑` in `--ahead` to push), then the dirty files: added (`+`,
  `--run`), modified (`~`, `--accent`), deleted (`−`, `--err`). Git counts FILES, not lines. Zeros create no segment;
  without the change kinds the file count alone shows, in `--muted`. Color doubles the sign and never stands in for
  it; VoiceOver gets a sentence. Code: `Views/Header/SessionStatusBar.swift`.
- The line shows no line sums for the WHOLE session: they would say nothing the diff does not, and grow to four
  digits. Lines are PER FILE: on iPad a tap on the status line opens the Changes popover with the changed files (the
  status letter, the path, `+a −b`) and a Diff footer; with the inspector open the tap scrolls the inspector to the
  changes instead. On iPhone the tap opens the session inspector as a sheet ("Session inspector (iPad)").

### Diff window and git popover

**The diff window** (`Views/Header/DiffSheet.swift`) is one scroll in which every changed file is a section; the
section headers are the file list. It uses the shared window frame, titled CHANGES · N files (500+ when the server cut
the list).

- **A section header** is a full-width button on the grid of the inspector's change tree: a chevron, the kind letter
  in the git line color, the path (cut in the middle) and right after it the balance, `+a −b` or `bin` for a file git
  counts no lines in, at the name rather than at the far right edge of a window over a thousand points wide. The
  header sticks to the top of the scroll: a collapsed one is a quiet row, an expanded one a `--surface-2` bar over the
  patch being read.
- **The body** of an expanded section is the patch in mono, added and removed lines on a tint of their color, hunk
  headers in `--new`; several `diff --git` blocks of one file share one header. Loading, a failure with Try Again and
  the truncation notes (a file at 512 kB, the list at 500 files) are sentences. A hairline closes every section, so
  the next collapsed header does not look like a patch line.
- A server without the per-file routes gets "The server is older than the app. Restart the server." A failed refresh
  keeps the last known state on screen, with a sentence and a retry.
- Opening from a file expands that file and scrolls to it once. A refresh neither scrolls back nor blanks the window:
  the header of the file being read stays in place.
- VoiceOver reads a header as "src/notes.ts, modified, 2 lines added, 2 lines deleted", expanded or collapsed; it is a
  heading and a button.

**The git popover** (iPad only, `Views/Header/GitDetailsPanel.swift`) fetches nothing, so it opens at once: the last commit, then
the changed files from the `git-status` frame (at most 50, "showing 50 of N") with the same balance as the window. A
file tap opens the window with that file expanded; the Diff footer opens it from the top. Each file row is a 44 pt
touch target, and the rows touch without overlapping.

### Project note

The rule: **the popover reads, the form writes**. The note is a person's notepad pinned to a directory, and no agent
sees it, so wherever it could be confused with a note to a question option (which does go to the agent) it is called
Project Note. Its one color is `--note-ink` on the glyph of a note with content; the glyph without content is
`--muted-2`. `err` appears only for a failed save, the cap and the copy on the device. Code: `Views/Notes/`,
`Model/NoteTabModel.swift` (shape, color and VoiceOver value of the glyph).

**Entry points** (all vanish with `notesEnabled: false`): the note glyph, ⌘J, Project Note in the project header
context menu, and a NOTE section on the project screen without sessions. The glyph is one model in two places: the
note tab before + in the project tab bar, and a button in every project header of the tree ("The note glyph in the
project header…"). The glyph is always `note.text`: in `--note-ink` when there is content, and a tap opens the
popover; in `--muted-2` when empty or unknown, and a tap opens the form; an `err` dot, or `!` with Differentiate
Without Color, means text not saved on this device, and then the glyph is grey and a tap opens the form with that
text. Only the color tells content from none; VoiceOver hears the state in the glyph's value ("has content",
"empty", "not saved on this device").

**Popover**: a meta row (`saved 14:07`) and the text through the transcript renderer; on the phone a half or full
sheet that leaves the screen under it usable. A tap in the text does nothing (a hold selects, a link opens). The
footer holds Edit (⌘J) and the microphone.

**Form** (`FormSheet`; ×, Esc, ⌘W, ⌘J and the swipe down save and close): a plain text field and a bar above the
keyboard with the save state, one text action (Try Again, Restore, Undo) and a counter from 90 % of the cap. The
states are quiet mono text, such as `saved 14:07`, `saving…` (only after 400 ms),
`can't reach the Mac—the text is waiting in the app`, `empty—closing deletes the note`, `not saved · conflict`.
Read-only (no directory, notes off): a banner with a sentence and Copy.

**The markdown mirror:** the field shows the syntax and hides nothing: no character vanishes and nothing shifts (it is
not WYSIWYG). Markers are muted, headings and `**…**` semibold, inline code and bare URLs styled as in the transcript,
list lines hang-indented; code fences are muted like markers, not drawn as blocks.

**Conflict** (409, a change from a second device while the field is unsaved or recording): the field stays under the
fingers, typing goes on, autosave stops. A banner says the note was changed on another device and offers Compare and
Merge (Merge only when both sides only appended). Compare shows the two versions one under the other, with no green or
red, and offers Merge, Keep Mine, Use Server Version and, when the result fits the cap, Insert Both into the Field;
after a choice that overwrote text, the status row offers Undo for 5 s.

**Dictation:** a microphone in the popover footer and the form bar, and the dictation shortcut (⌥⌘M by default)
anywhere in the form; while recording, the microphone icon turns `err`, like the dictation dot. Until a dictation
method is chosen on the device, a microphone tap opens the Dictation page in the form's stack instead of recording;
choosing returns to the field and the next tap records. With a method chosen, the popover microphone opens the form
WITHOUT the keyboard and records at once, adding a new line at the end; the bar microphone and the shortcut append
after a space, like the message field. While recording, the status row speaks about the recording; a refused
microphone or speech recognition permission adds Settings to it. At
the cap dictation types what fits, stops and says so. Without Soniox on the server the microphone stays and System
Dictation works.

**A toast after the form closes** offers Undo for a deleted empty note and Open for a failed save; it shows over the
list on iPhone too, so Undo is not lost, and Restore in the empty form is the second path back.

### Session inspector (iPad)

The inspector is a third column, not a popover: 320 pt at the right edge by default, separated by the same hairline
as the list; neither glass nor a card. Dragging the hairline sets its width between 280 and 560 pt, live, like the
list's; the device remembers it, and a narrower column narrows the inspector so the transcript keeps 560 pt. Like
the list beside a session, it stands on `--sidebar`, one step from the transcript background, so the work in the
middle reads apart from the sides; the header, tabs and status line stay on `--bg`.
On the phone the list is a screen of its own and keeps `--bg`. Code: `Views/Inspector/InspectorPanel.swift`, the background
rows in `Views/Header/BackgroundTasksSection.swift`.

- The sections stack under eyebrow labels (2 pt larger than the rest of the app's): BACKGROUND · N, RECENTLY
  FINISHED, SCHEDULED TASKS, ARTIFACTS, PULL REQUESTS, CHANGES · N.
- BACKGROUND and RECENTLY FINISHED share one row grammar with the background tasks popover: the FULL description at
  its state mark, under it a `state · time` line (the session list writes `working · 6m` the same way), then an
  optional meta line. The time sits under the description so the description gets the full width. Only work and
  error get color, and standby gets the smoked green. The header adds "2 working · 1 waiting" when something is in
  standby.
- A working task (a command, a monitor, a workflow, a subagent not in standby) has a `--run` dot and a `--muted`
  counter (not green: green numbers ticking every second are noise). The meta line names the kind and the rest:
  `subagent · Explore · Opus 5.5 (1M)`, or for a command its TOOLS, never the whole command (`command · swift test`,
  `pnpm run check`, `grep | head`, at most three, then "+N"; `CommandTools`); Copy Command gives the whole command.
  Without contact with the source the dots go to `--done` and the clocks stop.
- A subagent works (dot and counter), waits for its own task (an hourglass in `--run-smoked` and "waiting on its own
  task · 18m") or has finished (no row). Amber stays for what waits on a human, so standby gets the smoked green of a
  session that waits on a background task; without contact with the source the hourglass goes to `--done` like the
  dot (`BackgroundTaskMark`). From a long wait on its own command the state line becomes a warning line with the
  stage's mark in `--wait` (`subagent-long-wait.md`, "Background section and pill"); the hourglass takes the same
  colour. A subagent's
  own commands hang under it on a BRANCH, one line each (`pnpm test · 21m`). A workflow run uses the same branch:
  working phases and agents ● in `--run`, finished ✓ in `--done` with `--muted` text, pending ○ in `--muted`.
- RECENTLY FINISHED (the last 3, in the inspector and in the popover) is quieter than what runs: a result mark (✓ ■ ? in
  `--done`, ✗ in `--err`; no result does not mean success), the whole name, and a line such as
  `code 1 · 2h ago · 12:31`, or `3d ago · Oct 9` after a day, recounted every 30 s.
- SCHEDULED TASKS (`docs/scheduled-tasks.md`): the crons the session's Claude Code has armed, in server order,
  shown only while at least one row is visible. A row uses the RECENTLY FINISHED grammar without an action: a
  `--muted-2` glyph (`clock` for a task that runs once, `repeat` for a recurring one), the prompt in `--text-2` cut
  at two lines, and a `--muted-2` line that branches on `recurring` first. A one-shot task says `once · Nov 19,
  10:13 PM` from its next run, or from the cron fields without one, whatever the pattern. A recurring task says its
  schedule in words (`every 5 min`, `hourly at :05`, `daily 9:05 AM`, `weekdays 9:05 AM`, any other pattern as
  written), then `next 10:14 PM` while the next run is ahead, otherwise `last 10:12 PM` when a run is known. Run
  times are in the device zone; times from cron fields are the Mac's local time, shown as written. A row whose
  expiry has passed leaves under the panel's 30 s clock and on return to the foreground, without a new frame.
  VoiceOver hears the prompt, the schedule and the time as one sentence (`Model/ScheduledTaskRows.swift`,
  `Views/Inspector/InspectorScheduledSection.swift`).
- ARTIFACTS (`docs/artifacts.md`): claude.ai pages published in the session's current conversation, newest first,
  shown only when there is at least one. A row uses the RECENTLY FINISHED grammar with an `arrow.up.right.square`
  glyph, because the tap leaves the app: the whole row is a link to the default browser, not the Claude app. A live
  artifact has its glyph and title in the transcript link color (`linkInk`, no underline), so it stands out from the
  finished tasks; under the pointer the title goes to `--text`. A deleted artifact stays dimmed (`square.dashed` in
  `--muted-2`, title in `--muted`, `deleted · 1d ago · Oct 15`) and is not a button; a URL outside
  `https://claude.ai/artifact/<id>` gets no link.
- PULL REQUESTS (`docs/pull-requests.md`): PRs that Claude Code linked to the session's current conversation with a
  `pr-link` entry, whose author is the `gh` login and which were created after the conversation's first entry,
  newest first, shown only when there is at least one; the section does not fold, but merged and closed PRs do
  (below). A row speaks the artifact's visual
  language: an `arrow.triangle.pull` glyph and the first line in `linkInk` (no underline; `--text` under the
  pointer). The first line is the PR's title on GitHub, or `owner/repo#n` without one; under it a `--muted-2`
  line `acme/widget#42 · 2h ago · 14:05` (the reference only when the first line is a title). When the server knows
  the GitHub state, a label opens the line: the word (`open`, `draft`, `merged`, `closed`, in the app language;
  `draft` stays `draft` in Polish too) in white `caption2` semibold on a capsule of GitHub's state colour, muted
  (green, grey, purple, red; `PullRequestStateTokens`, the word ≥ 4.5:1 on each fill), drawn 1 pt below the text
  baseline. Without a state there is no label. The tap hands the URL to the system: the default browser, or an app
  that claims github.com links. A URL outside `https://github.com/<owner>/<repo>/pull/<n>` gets no link, and the
  row stays plain text in `--text-2`. Open, draft and unknown-state PRs stay in view in server order; merged and
  closed ones fold under one last row, a button: a `chevron.right` in `--muted-2` in the glyph column (turned
  down when unfolded, like the phase and directory chevrons), "Merged and Closed" in `--text-2` and the count
  "(N)" in `--muted-2`. Folded by default; VoiceOver hears "Merged and closed: N" and the expanded or collapsed
  value. With no merged or closed PR the row is absent; with only those the section holds just this row.
- FILES is the whole tree of the session directory (`Views/Inspector/InspectorFilesSection.swift`, rules in
  `Model/InspectorFiles.swift`), with the number of changes in the header: the changes the tree marks, from the
  change list of the session directory (the bare title while that list is cut or not here yet). The header row folds
  the whole tree, and the device remembers the fold for all sessions (`rarog.inspectorChangesCollapsed`); a directory
  folds by a tap, and directories with a change under them start open. A file row is one line: the kind letter (`A`/`M`/`D` in the git
  colours) on the axis of the directory name above, the name in mono cut in the middle, and the balance `+a −b` on the
  right. A changed file has the name in `--text-2`, an unchanged one in `--muted`, an ignored one in `--muted-2` with
  a crossed eye (`eye.slash`) on the right, a deleted one in `--err`, struck through. A directory with a
  change anywhere under it has an orange dot (`--wait`) after its name, open or folded, and a brighter name
  (`--text-2`); folded, it adds the `+a −b` sum. Under the tree a note says when a listing stopped at the server's
  ceiling and another when the change list does not carry every change. A tap on an existing file is its preview, a
  tap on a deleted file opens the diff on that file; a long press (a right click on a Mac) gives Preview (an existing
  file on a listing), Diff (a changed file) and Copy Path (the path relative to the session directory), on a
  directory Copy Path alone, and VoiceOver gets the same items as actions. Without the server's `files`, for a Codex
  entry and out of scope the tree and its count come from the `git-status` frame only, without Preview, and a tap on
  a changed file opens the diff. A row is 30 pt at the default text size and grows with the text. Under the pointer
  the name of every row (file and directory) goes to `--text` (a deleted file keeps `--err`), without a plate, the
  app's tip shows the whole name, which the row may cut, and the level lines show while the pointer is over the
  tree; a finger lights nothing. The last commit stays in the git popover.
- Under the FILES header stand the Files / Changed Only toggle in the glass capsule of the list filter (equal
  segments, the active one on a plate) and the search field (both gone while the section is folded). Files is the
  whole tree; Changed Only is the tree of the change-list paths with every directory open, a file on a loaded listing
  or in the file index previewed and the rest opened as a diff. The device remembers the choice
  (`rarog.inspectorFilesMode`, Files by default). The fallback tree has only changes anyway, so it has no toggle. The
  field, "Search files" in mono `footnote` on `--input` with a magnifier, matches the path relative to the session
  directory without letter case, in the whole session directory (the server's file index; files git ignores stay in
  the tree only). The `.*` button on the right makes the query a regular expression (lit in the accent when on, a
  device preference `rarog.inspectorFilesRegex`), and "×" clears the field. The result is the tree of the first 500
  hits with their ancestors open, the change markers, the tap and the menu of the tree; a tap on a directory there, as
  in Changed Only, folds it in that tree only and leaves the hand toggles of the whole tree alone. Notes under the
  result: no match, "Showing 500 of N", an invalid or too slow expression (in `--err`), a cut index with the number of
  files searched, a server without the index ("Searching only the open directories."), the index on its way, and a
  failed index with Try Again. Esc in a non-empty field clears it and does nothing else; in an empty field it does
  nothing on the iPad and closes the sheet on iPhone; the field never hands Esc to the session screen, so it never
  interrupts the turn.
- The inspector button (`sidebar.right`) in the header icon group looks pressed while the inspector is open.

**On iPhone the inspector is a sheet**, because a phone has no room for a third column. It is the same view with the
same sections, anchor per session, folds and diff window, in the phone popover container ("Windows, popovers and
forms in the native app": a title bar, Session Inspector, a grabber, half and full height) on `--surface`, without the
fixed width and the hairline. The inspector button in the header icon group opens it at the top
and closes it again, and looks pressed while the sheet is open. A tap on the left part of the status line (the
context ring and git) also opens it at the top, so on a Claude session that part of the line is always a button.
Only while the background pill stands beside it, and git has an expansion, does the line open at CHANGES: the pill
already leads to the top, and without it a jump to the bottom of the panel gets in the way. A tap on the background
pill opens the same sheet at BACKGROUND instead of the background tasks popover. The phone has no git popover, and
with it no last commit row. Only a person opens the sheet; a screen change closes it like any window, and coming
back to the session does not reopen it. Code: `Views/Inspector/InspectorPanel+Sheet.swift`, rules in
`Model/InspectorSheet.swift`.

### Transcript and sidebar

Readability rules for the transcript and the list. They live on the client; the protocol does not know them.

- **Single-line paths keep their last 3 segments** in the tool card summary and the list card's activity line:
  cutting the end would take the file name, the only thing that tells steps apart. The expanded `detail` stays full;
  URLs are never cut. The activity row under the field shows only the file name of a read or an edit.
- **A `— HH:MM —` time marker after a break of ≥ 10 min** stands above a reply, not on tool steps alone, the first
  message or entries in flight. The break counts from the `at` of the previous message, i.e. from the START of a
  merged turn, because the protocol does not know where a turn ends. A prompt shows its time at its bubble. A
  calendar day change gives a date separator (`— Fri, Oct 9 —`) above the first visible row of the new day.
- **The NEW line before the first unread message**: a `--new` machine label between two hairlines, like unread in
  the list, because it is the only spot in the transcript people LOOK for; no motion, no time. The DEVICE's memory
  sets the line, not the server, and during a visit it does not jump with live messages. Coming back from the
  background starts a new visit: the line moves to where the device saved its place. It stands only above a new
  agent message or notice, never above a human prompt or inside a collapsed step series.
- **Copying a reply goes through selection, with no role labels**: no copy-all button, the code block icon copies a
  block, and VoiceOver hears the role ("Turns in the transcript"). With a pointer a drag selects across messages and
  the list scrolls by itself at its top and bottom edge; with a finger a selection across messages goes through
  Select More… in the selection menu, which opens the Transcript Text window.
- **The sticky quote bar is a button** that opens the Prompts in This Session popover: a prompt per row with its time,
  the current one marked, a tap jumps to its turn. The bar hides at the bottom and at the top on purpose: the need to
  navigate comes with scrolling up.
- **Idle agents always stay on the list, muted.** A fold for 24 idle agents would hide the most common place to come
  back to. The row dims on two axes: regular weight instead of medium (a non-color signal) and `--idle-ink`, ~2.8:1 on
  `--bg` and ~2.6:1 on `--sidebar`, a DELIBERATE EXCEPTION to 4.5:1: twenty idle rows are a backdrop for two active ones, and `--muted` and
  `--muted-2` differ too little on a device. The exception covers ONLY a row that does nothing; the accessibility name
  carries the content, and the state dot keeps full color. Rows with an attention rank (a decision, an UNREAD result,
  a failure), a live background task or the open session keep full color, and opening a long-idle session does NOT
  move its row. A stale row (no contact with herdr, a cached list) wins over muting: full ink at opacity 0.55,
  because "I don't know if this is true" matters more than "nothing happens here". No seam separates active and
  muted rows: a line would read as a floor header.
- **The agent list has no state floors** (no "waiting for you" / "working" headers); sessions stand in the project
  tree. A working row has a quiet stage line and a thin `--run` workflow bar, one segment per plan phase, growing in
  steps without animation, because the step is the truth. A state change gets no flash and no vertical motion.
- **The engine label marks a Codex row before the tap**: a Codex row differs in everything the phone cannot do (no
  transcript, no send), so its state line ends with a quiet `codex` tag. It is a TAG, not a state: only the dot may
  have color. The accessibility name says "Codex" INSTEAD OF "out of scope", which would point to
  `RAROG_HERDR_ROOTS`, a setting unrelated to this row.
- **An agent in a Rarog terminal leads to the TERMINAL, not to a screen of its own**, because a screen with one
  sentence and a button to the terminal would be a stopover. Its row and notification open the terminal, with the row
  selection lit on that route, and it gets no tab of its own: its tab is the terminal tab. The sentence "Codex runs in
  a herdr pane, so Rarog sees only its state. Read and answer in herdr." stays for a pane from a MANUAL herdr tab,
  where there is nowhere to go.
- **A session title wraps to 2 lines**, because a cut would take the end of the phrase. **Duplicate sessions get an
  `#n` suffix** by the project + name pair, numbered from the oldest. **The project path shows in the header only for
  an ambiguous name**: under a unique `app` header, `~/Projects/client/app` would repeat the name.
- **Project name and branch never share a line**: the header is the name with the agent count in brackets, and
  under it
  `branch ↑3 ↓1 · path`. On one line every shrink rule would pick WHICH identity gets cut, and a long branch would cut
  both. The branch is cut in the middle, the path from the start, and the arrows never.
- **The note glyph in the project header is a button at EVERY project**: grey `note.text` without a note, amber
  `note.text` with one, so the amber ones still say "you wrote something here" at a glance, and any project's note
  opens or starts with one tap, without entering a session. It stands at the end of the name line; its target
  reaches through the cell's trailing inset past the glyph. The glyph, like the clock before it, is one step below
  the name (`footnote`). Under the pointer the glyph stands on a plate in both colors: a rounded rectangle
  (`Radius.inner`) in the text ink at `HoverTokens.wash`, about 5 pt past the glyph sideways and 4 pt up and down,
  and the grey glyph also turns to the text color. It is the wash of icon buttons, not the tab plate, because the
  header under the pointer already wears the tab plate's `surface2` at half opacity. The header is one VoiceOver
  element that ignores its children, so the glyph is a separate button after it ("Project Note", value "has content"
  or "empty"). The header's context menu keeps Project Note.
- **The Recent Sessions clock stands in the project header, right before the note glyph**, at every project, also
  on a server without notes: `clock.arrow.circlepath` in `--muted-2`, in the text color on the same plate under the
  pointer. A tap opens Recent Sessions of that project without entering a session. For VoiceOver it is a separate
  button after the header ("Recent sessions to resume: <project>"). The session header has no clock.
- **The pop-up terminal glyph stands in the project header, right before the clock**, at every project while the
  server has the terminal on (off, there is no glyph): `terminal` in `--muted-2`, the clock's plate under the
  pointer. A tap opens that project's shell in the Cmd+F window, whatever stands on the screen; a second tap closes
  it. For VoiceOver it is a separate button after the header ("Pop-up terminal in <project>").
- **The header buttons stand close, at equal gaps**: one gap between every two glyphs (terminal, clock, note), the
  smallest from 16 pt up that still gives each button a target 44 pt high and at least 36 pt wide; the targets
  touch and never overlap (`Model/TreeHeaderButtonGeometry`). Narrower than 44 pt on purpose: 44 pt wide targets
  would hold the glyphs about 25 pt apart.
- **The Settings gear at the top of the list stands over the note glyph** of the project headers
  (`NewSessionListButton.groupShift`). Where the server offers the voice conversation across sessions, a waveform
  glyph stands before New Session in the same quiet style (`VoiceAgentSessionsListButton`), and the list title keeps
  room for it (`SessionListMetrics.headerMinWidth`). While that conversation runs, the title stays and a 32 pt circle
  filled with the state's tone, with the voice bars inside, stands where the waveform stood and ends the conversation
  on a tap (`VoiceAgentSessionsLitCircle`); with the list off screen the same circle stands in the session header or
  the Inbox's header.
- **A WAITING row says what it waits for**, in a quiet line that takes precedence over the stage line, in the grammar
  `<kind>: <what> · <tail>`: `permission: Bash · pnpm test` (a path for `Edit`, `Write` or `Read`), `plan`,
  `question 1/3: Which file?`, `dialog: directory trust`, `dialog in the terminal · no digit`; the kind words are SHARED
  with the decision card label. The layout RESERVES the line's height, so a row grows once, with the tone change, and
  the line stays empty for the 1–2 s until the dialog text arrives. A pane outside Rarog's roots, whose screen Rarog
  does not read, gets no reservation. Without contact with herdr the line goes out.
- **The green dot at the background task line and on the N in background pill is a WORK SIGN**: it shows only when a
  task on the list works. A subagent in standby (its turn ended, it waits for its own background command) is not
  work: with only such agents the line says `waiting: subagent · <description>` without a dot, and the pill counts
  every task, also without a dot. A subagent that waits long on its own command adds the warning mark of its stage
  after the pill's dot. An open workflow run on the list takes the line first, during a turn and after it;
  without one, a live delegation from the activity (`subagent: …`, `workflow: …`) takes precedence under a working
  row and keeps its dot.
- **The scroll-to-bottom button is an arrow in a circle, with no text**: a 36 pt circle on the column axis above the
  field, with a 44 × 44 pt touch target. Its name (Scroll to Bottom) reaches VoiceOver and the Large Content Viewer
  only. The arrow is a graphic, so it needs 3:1 against the circle in both themes.
- **The scroll-to-bottom button changes tone and name while a decision waits**: the arrow and the outline turn
  `--wait`, and VoiceOver reads Scroll to Decision. The decision card sits at the BOTTOM of the transcript, so the jump
  down is the jump to it. A card in the decision dock (`DecisionDock.mode = .dock`) is always on screen, so with it the
  button stays plain and reads Scroll to Bottom.
- **The N new messages pill** says how many messages the person missed, at the top of the transcript, only while this
  visit's NEW line is ABOVE the screen; a tap scrolls the line to just under the quote bar. It goes out only when a
  human GESTURE brings the line on screen, and does not come back in this visit: a scroll from code (landing on
  entry, loading, Scroll to Bottom) does not "read" for the person. It appears once the scroll settles, so it does
  not flicker while content loads. The count is agent TEXT BLOCKS from the line down (a merged turn after a server
  restart would count as one message); tools, prompts and notices do not count. It wears the scroll-to-bottom button's
  material ("Glass") at a height of its own (a `footnote` line with 7 pt above and below), and there is no permanent
  jump-to-first button.
- **The × on the pill** closes it and marks the messages as read, without scrolling: the pill and the NEW line vanish
  for the visit, "read" goes to the device memory at once, and VoiceOver offers it as the pill's Mark as read action.

### Native app list: project tree

The only list layout on iPad and iPhone. Code: `Views/List/ProjectTreeList.swift`; spacing in `SessionListMetrics`,
row roles in `ProjectTreeRowLayout` (`Model/ProjectTreeRows.swift`), the guide color in
`Theme/PaletteTokens+Tree.swift`.

- **Tree**: one list over the column. A project header sits on the column background, not on a card: a fold chevron,
  the name in semibold mono followed by the agent count in brackets, `willow (2)`, in `footnote` mono (a step below
  the name, on its baseline) without the weight and in `--muted-2`, in the light theme a step darker (#66666E) to
  hold 4.5:1 in the fringe of the filter glass's shadow (only above zero; the name truncates before it,
  the bracket stays; no state color, the agent rows under the header carry the state), and under it the branch with
  `↑`/`↓` and, for an ambiguous name, the path. The whole header folds and lights up under the pointer as one plate.
  Agents are indented so their dot lines up with the first letter of the project name, and show the session name
  alone. A folded project hides only quiet: an agent that waits, has an unread result or a failure, or works stays
  under its header. The app never folds or unfolds anything by itself; a new project is unfolded.
  Only a project with at least one session has a header: a project leaves the list with its last session and
  comes back with the next new session in its directory (a pinned one comes back on top, its pin kept). Recent
  projects from the session history appear only as pills in the New Session window.
- **Pinned project**: a small `pin.fill` glyph after the name and the count, in the count's quiet color, hidden from
  VoiceOver, which hears "pinned" in the header's value next to the fold state. The name truncates before the glyph,
  and the glyph never pushes the header buttons out. There is no "Pinned" section header.
- **Scrolling on collapse.** The list does not jump when a project unfolds: it stays in place and grows downward.
  1. A manual fold or unfold of one project (the chevron, a tap on the header, Return, a VoiceOver action) does not
     scroll: the header stays to the point, and its agents appear or vanish under it with animation. When the list
     sat at its end and the content shrinks, UIKit trims the offset itself; that is not the anchor.
  2. Any other change of rows (Collapse All, Expand All, Pin and Unpin, a new or closed session, a new project)
     keeps the open session that was FULLY on screen at the same point of the visible list (`TreeListAnchor`), as
     close as the content allows at the end. The two "all" actions animate, so the session moves away and comes back
     (measured in the simulator: up to 197 pt on collapse and 940 pt on expand, over ~0.5 s). A height change alone,
     with no change of identity, is outside the rule.
  3. The anchor does nothing when the open session is not fully on screen, nothing is selected, a finger is on the
     list or it is decelerating, or the list column is hidden (Cmd+B) or absent.
- **The header context menu** (touch and hold, or a right click): New Session, New Terminal, Project Note (when notes
  work), Pin Project or Unpin Project, Collapse All, Expand All; the list has no visible +. VoiceOver gets Pin and
  Unpin as an action of the header. New Session and New Terminal do what the tab bar's +
  menu does: the session starts at once with the remembered settings, the app enters it, and its row stands selected
  under the header without unfolding a folded project. New Terminal is disabled without a terminal on the server, both
  are disabled while creating, and a start block does not disable New Session: the tap says the reason.
- **Rename in place.** An agent row's context menu starts with Rename; a double click with a pointer (trackpad,
  mouse) does the same, while a finger tap still opens the session at once. The row turns into a field: an accent
  outline (`--wait`), the whole name selected, and under it the counter `n / 28` and `↩ save · Esc cancel`. Without
  a hardware keyboard Cancel stands at the end of the field's line (a 44 pt target) and the hint reads
  `✓ save · tap outside to cancel`, because touch has no Esc. The field
  takes at most 28 characters (UTF-16 units, as the server counts a label) and turns a pasted line break into a space.
  Return sends `/rename <name>` to the session the ordinary way of a message, so its bubble stays in the transcript,
  and the row shows the new name at once, as the card will get it (at most five words). An empty name or the current
  one sends nothing; Esc, Cancel, losing focus, a tap elsewhere, opening another screen and the app going to the
  background cancel. Every opening of the field starts over, so Return, Cancel and the tap elsewhere
  act on the next rename of the same row as on the first. Without the server's label within 10 s, or after a
  refused send, the old name comes back and a sentence card says why. The item is there during a turn (Claude Code
  renames at once and the turn goes on); a Codex session, an agent in a terminal, a session without a send channel
  and the cached list have none. Tabs and the session header do not rename.
- **A sentence under the bar in the stack.** A sentence card (a refused start of a session or a terminal, a refused
  close, a rename that did not take) sits under the tab bar; when the list is on top of the stack it lands at the top
  of the list instead, so a refusal never vanishes without a word. VoiceOver hears it once (`RarogNavigation.post`);
  it goes out after 5 s or on a tap.
- **Project borders**: agent indentation, air above each header and a guide set projects apart; none of them is a
  color, because color means state. Gaps are equal within each pair (header → agent and agent ↔ agent; last agent →
  next header) and do not grow with type. A row's height depends only on itself and on the row above, so folding a
  project does not change the rows that stay.
- **The guide** is a one-pixel vertical hairline (`treeGuide`) on the chevron axis, down to the last visible agent;
  a folded project has none. It is ornament, so the 3:1 graphics threshold does not apply; a test keeps it in the
  1.15–1.40:1 band on the column background. The row content draws it, not the cell background, because the list
  reapplies cell backgrounds only after the animation (measured: 0.47 s in a UIKit test, 0.7–4 s on a recording), and
  the guide would break apart on fold and unfold.
- **The active project**, the one whose session or terminal is on screen, has a brighter guide (`treeGuideActive`,
  about 2.6:1 dark and 2.1:1 light, still under the 3:1 of a rule). The Cmd+1–9 digits stand on the tab bar only,
  not in the agent rows.
- **The scheduled-task clock:** an agent row whose session has armed crons (`SessionSummary.scheduledTasks`, without
  the expired ones) ends in a `clock` glyph in the row's metadata ink (`ScheduledClock` in `SessionRow.swift`). Not
  amber: amber means "needs you", and a cron is information. The pointer shows the count and the next run
  ("2 scheduled tasks · next 22:14", the time in the device zone); VoiceOver hears the same at the end of the row
  sentence, and the glyph is hidden (`SessionRowModel.scheduledMark`, `scheduledText`). A list read from the device
  cache has no clock: the cache drops the field.

### Native app list: footer bar

The bottom of the list is one bar docked to the bottom edge, from one side of the column to the other, with the list
scrolling under it. The bar is translucent: a system blur (`ultraThinMaterial`) under a color layer (`footerCardLayer`
in `PaletteTokens+Glass`), black at 0.5 in the dark theme and `#F7F7FA` at 0.6 in the light one, so the rows passing
under it show faintly. It has no Liquid Glass (the glass draws a bright rim), no corners and no shadow; a 1 px
`--border` line along its top edge parts it from the list. With Reduce Transparency the bar is a solid color
(`footerCardSolid`: `#111111` dark, `#F7F7FA` light). The list has no bottom scroll edge effect: the soft one fades the
rows before the bar could show them, and the automatic one turns hard beside an open session (a hairline over the bar
and an opaque band under it). Code: `Views/List/Footer/`; geometry in `ListFooterMetrics`, content in
`ListFooterCardModel`.

- **Place**: the surface reaches the column sides and the bottom edge of the screen. The content stands 16 pt from the
  column sides (10 + 6 pt), 12 pt under the top line (9 pt padding plus `contentDrop` 3 pt), and 15 pt over the
  bottom edge (4 pt padding plus `ListFooterMetrics.bottomGap` 14 pt minus the same 3 pt; more on an iPhone with a
  tall home indicator, where the gap follows the message field's rule); lines 8 pt apart.
  Neither the keyboard nor the iPadOS shortcut bar of a hardware keyboard lifts it; an on-screen keyboard covers it.
- **Lines**: on the left the account e-mail (cut at the end), under it the machine line ("Mac · tailnet", mono, cut
  in the middle), and under that the 5H and 7D fields side by side (one row with the label, a 5 pt bar and the
  percent, the reset under it: "in 2h 44m", from a day on "in 2d · 11/14", or "no reading"). On the right, beside the whole left
  column, a vertical hairline and three machine columns: the number on top, the label (CPU / RAM / DSK) at the bottom
  and between them a bar growing from the bottom that takes the column's height (at least 18 pt). A server without
  the machine route has no columns and no hairline.
- **Type**: 13 pt for the account lines and the reset, 12.5 pt for the labels, 14.5 pt for the percents and 13 pt for
  the machine numbers at the default text size; on the iPhone the left column (account lines and limit fields) is
  1 pt larger, the machine columns keep their size. All follow Dynamic Type.
- **Text colors**: values in `--text-2`, labels `--muted`, quiet lines and missing values `--muted-2`; `--wait` and `--err`
  only on the window or metric above its threshold (label, number and bar). Font sizes follow Dynamic Type.
- **Steady height**: the skeleton has the labels and ghost plates in the place of numbers, and the e-mail and the
  machine line each reserve their line (two at accessibility sizes), so the first reading does not move the bar.
  Larger text drops the machine columns first, then stacks the limit fields; at accessibility sizes the machine
  numbers live only in the Usage sheet.
- **Not a control**: the bar does not react to a tap or the pointer and opens nothing. VoiceOver hears it as one
  static element: one sentence of limits and machine, no hint. The details (per-model window, reading times, what
  each machine number means, stale notes) are in the Usage sheet of the `/usage` app command.
- **Server update**: when the server is older than the app, the bar's first line is a quiet update row, the bar's
  one tap target (≥ 44 pt). It opens the Usage sheet, the only place that shows the update command: a popover
  beside the detail, a sheet in the stack.

### Session switcher

A window in the middle of the app window, with no dimming under it, so the screen stays visible around it. Code:
`Switcher/`. Only a tap (finger or pointer) on the current tab opens it, also on a terminal tab; it has no keyboard
shortcut, and no default shortcut of the app uses Cmd+S or Shift+Cmd+S. The current tab of a terminal that is still
being opened has no id yet, so a tap on it opens nothing. It stays open until a row is picked or the window is closed.

- **Window:** width min(560 pt, window − 32 pt), solid `--surface`, a hairline, the block radius, a shadow, no glass.
  At most 8 rows without scrolling, up to 70 % of the app window at the largest type. It appears and vanishes at
  once, without animation.
- **Row**: a session row has a state dot, "name #n" without the project (the heading names it once), under it in mono
  the state word in its color and the "waiting for" line or the stage line; the time on the right. A session without
  a name shows its tab's short id. A terminal row has the terminal glyph in the place of the dot, the tab label (the
  foreground process) and a quiet line (the slot, "running") in the secondary ink: a terminal has no state color,
  like its tab. Rows are never faded and carry no digits. VoiceOver reads the row sentence without the project, like
  the row.
- **Selection** uses the `switcherSelection` token, a light text-ink plate, never the accent: color stays for states.
  On it secondary text goes `--muted`, because `--muted-2` does not hold 4.5:1 there. Under the pointer a row gets the
  plate at half opacity (`HoverTokens.agentRowAlpha`); the selection wins, and a finger lights nothing.
- **The current tab** has a you're here pill. Every opening puts the selection on it; a Rarog terminal with an agent
  inside is the terminal's tab. Return on the current tab closes the window and gives the focus back.
- **Header and footer:** PROJECT · PROJECT TABS · N (the project's name, then the count), without a state summary,
  in one line: a long project name truncates and the count stays. The footer has the key hints (↑↓ select, ↩ go,
  esc close) only while the window holds the hardware keyboard; without it a row is picked by a tap.
- **Order:** the tabs of the current project in the order of the tab bar (sessions from the oldest, then terminals
  by slot), from the same list the bar draws, with no limit, flat, without group headers. The terminal invite, a
  terminal being opened, the note and "+" are no rows. The rows stay live while the window stands: a new tab comes
  in at its place on the bar, a closed tab leaves, and the selection stays on its tab (on a closed one it goes to
  the next row, from the last row to the previous one). Picking a row does what a tap on its tab does.
- **Keys:** with a hardware keyboard the window takes the keyboard focus, also when the keyboard connects while the
  window stands. ↑/↓, with or without Cmd, move the selection with wrap-around, Return goes to the selected tab,
  Esc closes the window and gives the focus back to where it was, also with Cmd held. None of these keys and no Tab
  reach the screen underneath; other keys without Cmd (digits and S included) do nothing. A Cmd shortcut from the
  menu closes the window and does its own thing (Cmd+1…9 switch tabs as with the window closed); the text size
  shortcuts (Cmd+0 included) leave the window open.

### Shortcut sheet (held Cmd)

Cmd held alone for 1.5 s shows a card of the app's shortcuts; releasing Cmd or pressing any other key hides it, and the
key works as usual. iPadOS 26 shows no shortcut list under a held Cmd, and its menu bar needs Windowed Apps or Stage
Manager, so the app draws its own. Code: `ShortcutSheet/`.

- **Card:** in the middle of the app window, width min(1000 pt, window − 48 pt), solid `--surface`, the block radius,
  a shadow, over the app dimmed black at 55 %. It stands over sheets and forms too, takes no keyboard focus and has
  no entry animation. A touch outside the card reaches the app underneath.
- **Header:** the title in bold `title3` on the left, "Release ⌘ to close" in `--muted-2` on the right.
- **You're here:** the group that works where the focus is (the message field and voice on a session, the terminal,
  the window shortcuts over a sheet) stands first, on `--surface-2` with a hairline and the block radius, its title in
  bold with a `--new` pill, its rows in two columns with labels in `--text`. Without a focus place (a project
  screen) the section is missing.
- **Other groups** in three columns: the header as a section label in `--muted-2`, labels in `--muted`.
- **Keys:** each combination is a row of caps, one per glyph (⇧ ⌘ N), outlined with a hairline and the ghost radius;
  a second combination follows after "or". A row whose feature is missing (notes, the terminal, the voice agent,
  Cmd+B and Cmd+I outside a wide iPad) is left out; a row that is only silent for a moment stays.
- **Narrow window** (iPhone, Slide Over): one column that scrolls inside the card.
- **Silent** before login, while the session switcher window is open, and in the app on a Mac, whose menu bar always
  lists the shortcuts. VoiceOver does not see the card; the menu bar stays the accessible list.

### Command suggestions above the field

The list of slash commands after `/` in the message field (`Session/CommandSuggestionsView.swift`) belongs to the
field, not to the keyboard: it sits right above the field card at its width and floats over the transcript, moving
neither the transcript nor the field. Its surface is the popovers' one: solid `--surface`, a hairline, the block
radius, no glass, no shadow, no animation.

- **Row** on one line with a 44 pt target: `/name`, the argument hint and the description, in falling emphasis. A long
  row is cut at the end, so the name stays whole. Built-in commands have no description.
- **Selection** (hardware keyboard) uses the `switcherSelection` plate. A finger without a keyboard sees no selection,
  because Return on the on-screen keyboard breaks the line.
- **Height**: 1–6 rows, the rest scrolls inside; the top stays under the safe area.
- **Neighbors**: with the list open, the Scroll to Bottom button and the toast above the prompt sit ABOVE it. In a low
  window (a phone in landscape with the keyboard) the button stays on screen and covers the list top: a visible button
  matters more than the first row.

### Inbox (native app)

The last message of every agent that stopped, one card per session, newest first, in the right column (on the iPhone
a screen on the stack). Code: `Views/Inbox/`. The card reads like a short turn of the transcript, not like a
notification: the agent's own words carry it.

- **Button:** the tray glyph (`--text-2`, `--text` while the Inbox is open or under the pointer) in a 48 pt glass
  circle on the right of the list's filter capsule, in the same floating row and of the same glass (the list footer
  card's material, the list scrolls beneath); it stands apart from the capsule because it opens a screen instead of
  filtering. The counter is an amber badge on the circle's top right (`--wait`, the digit dark in the dark theme and
  white in the light one, bold monospaced `caption`); zero shows no badge. Amber, like Needs You, because the counter
  takes the cards that wait for the human or carry an unread result. The open Inbox has the filter's active plate;
  the pointer gives half of it.
- **Header:** the title "Inbox" and after it the number of cards on the screen in monospaced `footnote`, `--muted-2`;
  no number on an empty Inbox. No inspector, status line or tabs.
- **Card:** a `--surface` block with the block radius, 24 pt from the column sides (12 pt on the iPhone), 12 pt
  between cards. The header is the agent row: the state dot (pulsing like the list's on a fresh result), "project ·
  session" in semibold `subheadline`, under it the state word in its color and the clock in `--muted`. On the right
  two quiet icons with 44 pt targets in `--muted-2`, `--text` under the pointer, each with its name in a pointer tip:
  ↗ Open session and ✓ Remove. The message uses the transcript's
  text styles.
- **Long message:** the agent's summary (a paragraph or quote opened by a bold "TLDR:" before the question), or
  the first paragraph when there is none, then a fold row (a hairline on each side of "N more lines · Show all" in
  medium `footnote`, `--text-2`), then the "To you:" block with the transcript's question stripe, so the question is
  always visible. An expanded card has no fold row and folds again when the Inbox opens anew. While the text loads,
  three `--surface-2` bars stand in its place.
- **Decision:** under the message the transcript's own decision card, unchanged; a stop and a result end with the
  message.
- **New cards above** never move the screen under a finger: the pill "N new ↑ · 1 waiting" in the list pill's look
  stands over the cards, and a tap scrolls up.
- **Removal** has no confirmation: ✓, a swipe to the left on the iPhone (the red "Remove" action with a trash glyph)
  or ⌫ on the card with the keyboard focus. The card goes, and the toast offers Undo for 5 s. The keyboard focus is
  the decision cards' 3 pt ring.
- **Empty:** "Nothing new" in `headline` and one sentence in `--muted` `callout` under it, from the top left, at most
  560 pt wide.

### What the direction does not cover

Per-message model switches, a token counter, a blue accent (the accent is the brand amber) and desktop density in the
phone view. The app has the project tree, iPhone included: folding projects keeps the density, and the state dots
of the agent rows, which a folded project keeps when they wait, serve the glance.

## Anti-patterns (what not to do)

- Only the default action of the message field and of the state card carries the amber accent (Send, Resume);
  navigation buttons are achromatic, and any other color on a control means a state or an effect (Stop in `--err`,
  Allow in `--run`). One exception: a switch that is on has the deep green `--switch-on` track, as on iOS, so on
  and off differ at a glance.
- Green ≠ done. Done is grey (nothing to do); green `--run` says working, and outside state it carries only approval
  and what git added (diff lines, `+` in the status line).
- No fireworks skeletons; a skeleton is a faithful layout of the target content.
- No modals for the connection state: a discreet banner or dot, never a screen block.
- No syntax colors (`--hl-*`) outside the code block, the tool card and the permission card command block
  ("First exception"), no scale under a finger ("Element types"), no tint or second frame inside a decision card
  ("Decision cards").
- An action repeated at every content block (the copy icon in a code block bar) is muted and visible WITHOUT hover:
  the phone has no hover, and a dozen highlighted buttons would shout over the reply. It sits on the LEFT of the bar,
  before the language name, because at the right edge of a wide screen it would get lost; the confirmation swaps the
  icon for a check mark, with no state color.
- The terminal type is **13 pt** on iPad and **11 pt** on the phone, in points, not in the text scale; the font is
  Menlo (`TerminalFontSize` in `RarogUI/Terminal/TerminalSurface.swift`).
