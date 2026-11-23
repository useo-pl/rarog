# Dialog card (layer 2)

With `RAROG_DIALOG_LAYER2=1` (`docs/server-config.md`) a Claude Code dialog that the CLI registry reports as class
`dialog` (a picker, a model confirmation, a slash command view) gets a card with the literal choices of its block,
where the card would otherwise have no buttons. With `0` (default) nothing on this page runs and no line on this page
reaches the audit log. Reading the block and the rule that turns it into choices: `docs/dialogs.md`, "Dialog block"
and "Block card without digits".

## When the card appears

The driver first decides the card as it does without the flag (`decideCard`). Layer 2 acts only when that card has no
button: no known screen dialog (model, trust, confirmation), no option without `terminalOnly`, no trust step and no
consent card with its call. A card from the terminal dialog list whose options are all terminal only counts as a card
without buttons.

Then the bottom block of the screen goes through the layer 2 gate (`layer2Gate` in
`server/src/herdr/dialogs/layer2/card.ts`), in this order:

- the flag (`layer2-off`);
- the engine of the pane: Claude Code only (`engine-not-claude`);
- the rule `layer2Verdict` (`layer2/verdict.ts`): the registry class (`class-unknown` without a class,
  `class-not-dialog` for `permission`, `sandbox` and the rest), then the block, its options and the proof of its end.

A verdict without choices leaves the card as it was. Its reason (closed list `LAYER2_WHYS`) goes to the episode line
below.

**Two equal reads.** A verdict with choices waits for a second read of the screen, past the screen cache and at
least 800 ms after the first (`layer2/stability.ts`). The same block fingerprint (`Block.print`) in both reads gives
the card. Another fingerprint starts a new pair. Both reads of a pair belong to one scope: one herdr lock, one registry
episode (one registry `waiting`) and one engine session. A read belongs to the scope it began and ended in: a read
during which the scope changed starts no pair, and neither does a copy from the screen cache, whose read may have
begun in another scope. A dialog the registry reports reopened under the same lock, or another engine session,
starts a new pair. Three attempts without a pair in one scope give the card without buttons with the reason
`unstable`, and the verdict holds until the scope ends. A block with a live timer (the Usage tab of `/status`) changes
its fingerprint every second and often ends `unstable`.

A card that stood before the registry reported the class is judged again at the next evaluation, as if it did not
stand.

**A dialog opened during a turn gets its card when the turn ends.** While the agent works on a turn, a dialog opened
in the terminal or by a command from the phone (`/effort` without a level) leaves herdr at `working` and the CLI
registry at `busy` without a class, so nothing starts an evaluation (CLI 2.1.323). When the turn ends, herdr reports
`blocked`, the registry `dialog open`, and the card comes. A background task alone does not delay it: with only a
background shell running, the registry reports the dialog at once. A command with its argument (`/effort high`,
`/model sonnet`) opens no dialog.

## The card

The card is a `question-request` with channel `keys` and one question:

- `header`: the block title;
- `question`: the whole block, from the title line to the footer, as it stands on the screen;
- `options`: the literal labels of the choices in screen order, numbered options first, then footer keys (Esc).

The card has no free answer and no option for the terminal only. In the audit log its tool name is `dialog:layer2`
and its `block-card` entry has `verdict: buttons` and `layer2: true` (`docs/dialogs.md`, "Case shape in the log").

A block whose footer says "Enter to set as default" has no buttons (`sets-default`), whatever its options: a digit
there acts as Enter and saves the choice as the default for new sessions, which no label says. This is the `/model`
picker (CLI 2.1.322 and 2.1.323).

## Occurrence

The card id is the occurrence id `l2:<12 hex>`, random. The driver module
(`server/src/drivers/herdr/layer2-card.ts`) keeps one record per pane: the engine session, the registry episode, the
block fingerprint, the label of each choice with the digit or key it stands for, and the issue time.

- The occurrence holds while its card stands, the engine session and the registry episode are the same and the block
  keeps its fingerprint. An evaluation over the same block keeps the card; a read without a block (a repaint) and a
  herdr flicker (a new lock in the same registry episode) keep it too.
- A new occurrence (new id) comes with a new pair of reads: a key from the card, the dialog closed and opened again
  with the same content (a new registry episode, also under the same herdr lock), another fingerprint, another engine
  session, a server restart.
- The same dialog in two sessions gives two occurrences with two ids.

## Answer

A tap on a choice sends exactly one key, and only through the layer 2 step
(`server/src/drivers/herdr/layer2-step.ts`). The phone sends the label, as on every question card (`answerQuestion`);
the server takes the digit or key from the occurrence record, never from the client. Esc on the card ("Esc to cancel")
goes the same way, by its label or by `deny` on the card id or on the session (`POST /api/sessions/:id/permission`).
A `deny` is bound to the card that stands when the driver accepts it, before the driver queue (`bindEscape` in
`server/src/drivers/herdr/layer2-step.ts`). Over a layer 2 card it goes only through the step with that occurrence id,
so a second `deny` or a tap on a label of the same occurrence finds it answered and sends no key (HTTP 410). A `deny`
accepted before a layer 2 card was issued sends no key once one has been (`stale-card`, HTTP 422), also when that card
is gone again. `deny` on a card without Esc is refused with `terminal-only` (HTTP 422). `allow` never sends a key:
the manager answers HTTP 409 when no recognized dialog stands, and the driver refuses it with `terminal-only`.

The step checks, in this order; each refusal sends no key:

1. The occurrence is known, its card stands, and the answer is exactly one of its labels. Otherwise `stale-card`
   (HTTP 410) or `no-digit` (HTTP 422). A second tap while the first is in flight gets HTTP 422 `in-flight` from the
   lock of parallel attempts in the manager (`server/src/permissions.ts`); a tap after it gets HTTP 409.
2. The flag and the engine (`layer2-off`, `engine-not-claude`). The pane scope, herdr send (`RAROG_HERDR_SEND`) and a
   read-only supervisor are gates of the driver and of the socket; they refuse without a key too.
3. The send shield of class `dialog` (`keyShield` in `server/src/drivers/herdr/prompt-queue.ts`): no hook consent
   request waits, and a fresh registry read says `waiting` with class `dialog`. Otherwise `hook` or `class-unknown`.
4. A fresh screen read past the cache gives the same block fingerprint, and the tapped label stands with the same digit
   or key. Otherwise `screen-changed`.
5. With no `await` up to the key: no hook registration, the same engine session (`/clear` or `/resume` give
   `session-moved`), the driver alive and the card still standing.

A refusal in checks 3–5 answers HTTP 422 `screen-changed` and writes the check's reason as `layer2Why` on the `refuse`
entry of the audit log; the card stays until the next evaluation. Then one key goes through the client method of its
path: digits and Esc through `sendKeys` (`ALLOWED_KEYS`), arrows, Tab and Enter through `sendDialogKey`, which asserts
exactly one key from `KEY_ROW_KEYS` (`server/src/herdr/dialogs/send/key-row.ts`) before it touches the socket. The
`approve` entry carries `layer2: true`, the occurrence id (`reqId`), the label and `layer2Key` (`digit`, `key` or
`escape`).

An applied key ends the question with the usual cycle (`question-resolved`). A `deny` has no answer call in the manager
that would end it, so right after its key the driver reports the card gone (`permission-cleared`), as for any card
that stops standing; a newer card issued in its place during the key stays. The answered block stays hidden for the
decided shield (`DECIDED_SHIELD_MS`, 8 s) within the same registry episode and engine session. A block with another
fingerprint gets the next card after a new pair of reads, so a series such as "→", "→", "Enter to confirm" is three
occurrences and three keys. The same block after the shield needs a new pair of reads as well: a key ends the pair its
card came from. The server never repeats a key.

`VERIFY_AFTER_MS` (800 ms) after the key, a screen read and a registry read write a `layer2-verify` entry with the
occurrence id, `layer2Key` and `layer2Outcome`:

- `gone`: no block, or the registry no longer says `waiting`;
- `changed`: a block of the same class with another fingerprint;
- `highlight`: the same block with only the `❯` marker moved;
- `same`: the same block, unchanged;
- `other-dialog`: a dialog of another class; the server log gets a warning line;
- `unknown`: a read failed.

The verify read runs outside the driver queue, changes no card and sends no key, also when a hook or a newer card
arrives meanwhile. The window comes from a measurement on CLI 2.1.322: the first screen change after a key came after
11–48 ms, the last one by 47 ms in 24 of 26 keys. Two exits out of the dialog took longer: the pane back to the shell
after 384 ms, and Enter on the "Auto mode can't check …" screen, whose next dialog settled after 2793 ms. For such keys
the verify read sees the screen as it stands at 800 ms.

## Episode line

Layer 2 writes a `layer2-episode` entry to `herdr-audit.log` for every episode of a registry `waiting` of class
`dialog`, also without a block on the screen and also when today's card has buttons. An episode writes again only when
its fields change; the reader takes the latest line of an episode.

An evaluation can end before layer 2 sees the screen: herdr does not report the pane blocked, and the registry fallback
(`server/src/drivers/herdr/cli-reserve.ts`) finds the prompt field instead of a dialog, cannot read the screen, or
holds the dialog while its reads fail. An episode without a line gets `none` with `no-block` and no block fields there.
The next evaluation that judges the screen refreshes the same episode; an evaluation without a screen never overwrites
a line. Fields:

- `episode`: `<instance>-<n>`, where `<instance>` is random per driver and `<n>` the registry episode number, so the
  key `sessionId` plus `episode` stays unique after a server restart;
- `layer2Verdict`: `choices` (a button besides Esc), `esc-only` (Esc alone), `existing` (today's card had buttons) or
  `none`;
- `layer2Why`: the reason of `none` (`LAYER2_WHYS`);
- `blockTitleSha`: the first 12 hex characters of the SHA-256 of the block title, when the screen has a block;
- `optionCount`: the numbered options of the block, when the screen has a block.

The entry carries no screen text and no key.

## Tests

- `server/test/dialogi-warstwa2-karty-korpusu.test.ts`: golden file `fixtures/herdr/karty-korpusu-warstwa2.json`,
  the card of every corpus screen with the flag on and the class from the truth manifest
  (`fixtures/herdr/warstwa2-prawda.json`); 39 of 55 layer 2 screens get a decision card, 47 a card with Esc at least,
  no screen gets fewer buttons than with the flag off. Refresh: `RAROG_FIXTURES_WRITE=1`.
- `server/test/dialogi-warstwa2-karta.test.ts`: the pair of reads, `unstable`, occurrence ids and the episode line on
  a fake port.
- `server/test/dialogi-warstwa2-karta-driver.test.ts`: the card, the log entries, a tap refused without a registry
  read, the new id of a reopened dialog and the pair after a scope change during a read, through the driver.
- `server/test/layer2-step-driver.test.ts`: the step through the driver: one key per tap, the key row and Esc, each
  check refusing without a key, a `deny` bound to the card standing when it is accepted, the verify read.
- `server/test/herdr-integration.test.ts`: the step through the manager: HTTP 410, 409 and 422 `in-flight`, `deny` as
  one Esc.
- `server/test/key-row.test.ts`: the key row assertion, `sendDialogKey` and the guard on its callers.
