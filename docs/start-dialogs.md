# Start dialogs herdr reads as ready

A start dialog is a Claude Code dialog that stands before the prompt field of a new session. herdr reports some of
them as `blocked` (the folder trust dialog, the `bypassPermissions` warning); this document covers the others: a
screen herdr reports as ready (`idle`, `interactive_ready: true`) while `claude` has not reached its prompt field.
Rarog recognizes such a dialog at start, shows a card that says where to answer, and sends no key and no text to it.
The answer is given in the terminal.

The measured member of this class is "Allow external CLAUDE.md file imports?" (Claude Code 2.1.332, herdr 0.9.5):
a project whose `CLAUDE.md` or `.claude/rules` imports a file outside the session directory. Its screen, keys and
captures: `docs/dialogs.md`, "Control set". Claude Code keeps the answer for the project: the
documentation (memory, imports) says "If you decline, the imports stay disabled and the dialog doesn't appear
again", and names no way to undo it. That is why no key goes to it from the phone.

## What herdr and Claude Code show during the dialog

Measured on Claude Code 2.1.332 and herdr 0.9.5:

- herdr: `unknown` with `launch_pending` for the first seconds, then `idle` with `interactive_ready: true` and an
  empty `agent_session` until the answer. herdr's `blocked` rules look for "esc to cancel"; the footer here says
  "Esc to disable".
- Claude Code fires `SessionStart` only after the answer, so herdr learns the session id only then. The CLI process
  registry has no entry during the dialog.
- Keys: Enter on the default option and Esc both answer "No"; `down`, then Enter answers "Yes"; a digit does
  nothing. Text sent as a prompt is lost, and its Enter answers "No".

## How the launcher recognizes it

The launcher (`server/src/herdr/launcher.ts`, `waitReady`) reads the screen only for a sample that is ready without
a session id, or whose readiness flag is gone without `launch_pending` (`startDialogSample` in
`server/src/herdr/start-dialog-wait.ts`). A sample under `launch_pending` is not read, because a cold start keeps the
shell line on the screen for seconds. Two legs end the wait as `blocked` with a start dialog:

- **Signature:** one read with the external imports dialog (`startDialogOf` in
  `server/src/herdr/dialogs/screen/start-dialog.ts`, patterns `startDialogImports*` in `SCREEN_SIGNATURES`): the key
  footer as the last line, above it the closed pair of options with exactly one `❯`, and the measured title under
  the block rule when the rule is on the screen. A long import list pushes the rule and title above the pane edge;
  the footer and the option pair still prove the dialog.
- **Time:** the same screen without the prompt field and without a known signature for `START_DIALOG_STABLE_MS`
  (8 s); the result is an unknown start dialog (`id: null`). A screen that changes restarts the count, and a failed
  read proves nothing. A wrong hit costs one card for a few seconds, because the session id lifts it.

A screen with the prompt field, a blank screen or a read error keeps the launcher waiting as before. After any
`blocked` start without a session id (also the trust dialog, which the imports dialog can follow), a poll of
`agent.get` every `START_DIALOG_SESSION_POLL_MS` (1 s), bounded by `START_DIALOG_SESSION_WATCH_MS` (10 minutes),
notices the session id the answer brings and asks the supervisor to refresh the pane. Without it the full resync
(up to 30 s) would be the first to notice, because herdr reports `idle` before and after the answer. A launch result
that arrives after the supervisor saw the pane ready does not put the pane back to `blocked`.

## The card and its sentence

The session goes to `waiting-permission` like any dialog in the pane. The card has no `permId` (no transcript
entry); it carries the screen excerpt (`herdrDialogScreen`) and no Approve button. Under the card the transcript gets
one sentence per dialog:

- `dialogs.start-dialog.imports`: Claude Code asks in the terminal whether to allow external imports, the answer is
  kept for this project for good, and Rarog sends no key;
- `dialogs.start-dialog.unknown`: Claude Code stands on a start dialog Rarog does not know; answer it in the terminal.

A start prompt waits for the answer without a time limit, as after the trust dialog, and goes once when the pane is
ready. In a project without trust the trust card works as usual (the phone confirms it through the arrow path,
`docs/dialogs.md`, "Folder trust dialog without digits"); the imports dialog that follows in the same process starts
a new card.

## Actions from the phone while the dialog stands

Every action ends without a key or text to the pane; a refusal from the driver adds the sentence
`dialogs.start-dialog.refused` to the transcript.

- **Deny (`POST /api/sessions/:id/permission`, `deny`):** 422 `refused`, reason `terminal-only`; the card is judged
  again.
- **Approve (`allow`):** refused; the card has no Approve button.
- **Interrupt (`POST /api/sessions/:id/interrupt`):** 202 with `delivered: "no"`. After an empty start the card is
  back on its decision before the answer leaves (the answer's session is `waiting-permission`), so a message right
  after it gets 409. During a start with a prompt the session shows `starting` until the driver judges the screen
  again and shows the card back, in about 1.4 s; a message in that gap meets the start reservation (409). A message
  that reaches the driver anyway meets its gate (no text reaches the pane).
- **Message during a start with a prompt:** 409 `session.not-accepting-messages` from the start reservation.
- **Message, slash command or queued prompt after an empty start:** 409; the card's state allows no send.
- **Model command, mode change, session restart:** refused by the manager's gates.
- **Queue take-back:** refused while the dialog is remembered.

## The gate in the driver

`StartDialogGate` (`server/src/drivers/herdr/start-dialog-gate.ts`) works only in the start phase: from the launch
until herdr knows the engine session of the pane (`startPhase()` of the supervisor's attach context). It remembers
the standing dialog: the launcher's dialog from the start, then the dialog of each screen that proves anything
(`readStartDialog`). Every screen the driver and its modules read counts, also the prompt field reads with attributes
(`visible` with `ansi`, judged on their plain text through `clientNotingScreens`). Gone takes positive proof: the
prompt field, or another dialog Rarog reads (a known dialog such as the trust dialog, a question or consent form).
A bare list of numbered options is no proof, because an unknown start dialog may number its options. A failed or
blank read keeps the remembered dialog.

The driver asks the gate before Esc in "Deny" and in the interrupt (after the pause check), before an approval and
the trust step, and before every message or command, with a fresh read and, right before the client call, the
remembered dialog with nothing awaited in between. The dialogs Rarog already reads keep their paths: the trust Esc,
the trust step, a digit on the resume summary and the `bypassPermissions` warning.

## Where the code lives

- `server/src/herdr/dialogs/screen/start-dialog.ts`: the screen predicate;
  `server/src/herdr/dialogs/screen/signatures.ts`: the imports dialog patterns.
- `server/src/herdr/start-dialog-wait.ts`: the time leg and the session id poll; `server/src/herdr/launcher.ts` calls
  it from `waitReady`.
- `server/src/herdr/supervisor.ts`: keeps the launch result's start dialog and offers `startPhase()`.
- `server/src/drivers/herdr/start-dialog-gate.ts`: the gate and the card's sentence; the driver
  (`server/src/drivers/herdr-driver.ts`) calls it.
- `server/src/sessions/interrupt-windows.ts`: the card back after an interrupt that was not delivered.
- `shared/src/sentences/dialogs.ts`: the sentences `dialogs.start-dialog.imports`, `.unknown` and `.refused`.
