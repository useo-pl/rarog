/**
 * Zdania obszaru `dialogs`: dialogi zgód i pytań, odmowy decyzji.
 *
 * Kod ma postać `dialogs.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const DIALOGS_SENTENCES = {
  'dialogs.consent.allow-always': {
    en: "On this card, “don't ask again” can only be chosen in the terminal. Allow once or answer in the terminal.",
  },
  'dialogs.consent.card-changed': {
    en: 'The card changed before your decision reached Rarog. Look at it again and decide on what it shows now.',
  },
  'dialogs.consent.not-shown': {
    en: "Rarog can't show this request in full, so you can't allow it from here. Answer it in the terminal.",
  },
  'dialogs.consent.release-taken': {
    en: "The hook has already taken the answer, so it can't be safely withdrawn. The transcript will show the result.",
  },
  'dialogs.consent.too-late': {
    en: "It's too late to hand this request back to the terminal: the hook has already finished waiting.",
  },
  'dialogs.degraded-display': {
    en:
      "Rarog couldn't confirm what this dialog is about. From here you can only deny it. Allow it in the " +
      'terminal.',
  },
  'dialogs.degraded-unreadable': {
    en:
      "Rarog can't see this dialog's options on the pane's screen. If the Claude Code view in the terminal is " +
      'scrolled up, scroll it to the bottom. The card refreshes on its own. From here you can only deny it.',
  },
  'dialogs.fallback-question.confirm': { en: 'The pane is waiting for confirmation in the terminal.' },
  'dialogs.fallback-question.tool': { en: 'The pane is waiting for permission to use a tool.' },
  'dialogs.fallback-question.question': { en: 'The agent asked a question in the terminal.' },
  'dialogs.refuse.mismatch': {
    en: "Rarog couldn't confirm that the card matches the dialog in the terminal. Check it there.",
  },
  'dialogs.refuse.unreadable': { en: "Couldn't read the dialog from the pane. Allow it in the terminal." },
  'dialogs.refuse.no-jsonl': { en: "Rarog doesn't know what this dialog says. Allow it in the terminal." },
  'dialogs.refuse.multi-select': { en: 'Make multiple selections in the terminal. Rarog sends only one digit.' },
  'dialogs.refuse.no-digit': { en: "Couldn't match this decision to an option. Allow it in the terminal." },
  'dialogs.refuse.terminal-only': { en: 'This option changes permissions permanently. Choose it in the terminal.' },
  'dialogs.refuse.screen-changed': { en: 'The pane now shows a different dialog. Decide on the new card.' },
  'dialogs.refuse.stale-card': { en: 'The dialog changed in the meantime. Tap again on the new card.' },
  'dialogs.refuse.form-submit': { en: 'Sent the digit but not the confirmation. Check the pane.' },
  'dialogs.refuse.send-failed': { en: 'Nothing reached the pane. Check herdr and try again.' },
  'dialogs.refuse.in-flight': { en: 'A decision from another device is in progress. Wait a moment.' },
  'dialogs.refuse.consent-dialog': {
    en:
      'The pane asks for permission to scan the environment. Answer in the terminal, or press Esc to deny. ' +
      'Messages sent from here wait until the dialog closes.',
  },
  'dialogs.form-submit-abort': {
    en: '⚠ The confirmation (Enter) was not sent: {reason}. Answer on a new card or in the terminal.',
    args: ['reason:code'],
  },
  'dialogs.form-submit-gone': {
    en: '⚠ The dialog changed right after the digit was sent, so the confirmation (Enter) was not sent. Check in the pane whether the answer went through before answering again.',
  },
  'dialogs.form-submit-keys': { en: 'The form confirmation path sends only ["enter"].' },
  'dialogs.hook-answer-partial': {
    en: "⚠ The hook didn't receive the answer (timeout, or the decision was made at the desk). Only the answer to the question “{question}” was sent, as a digit. The rest will come back as separate cards, tab by tab.",
    args: ['question:text'],
  },
  'dialogs.key-not-allowed': {
    en: "The key “{key}” isn't allowed (allowed: {allowed}).",
    args: ['key:text', 'allowed:text'],
  },
  'dialogs.keys-empty': { en: "The key list is empty. There's nothing to send." },
  'dialogs.multi-select': { en: '⚠ Make multiple selections in the terminal. Rarog sends exactly one digit.' },
  'dialogs.no-answer-on-screen': {
    en: "⚠ There's no answer to the question open in the terminal. Choose an option and send again.",
  },
  'dialogs.no-digit': {
    en: "⚠ Couldn't tell which dialog option matches this decision. Confirm it in the terminal. Rarog sent no key.",
  },
  'dialogs.note-no-channel': {
    en: '⚠ Only the hook channel carries a note, and this card answers with a digit. Rarog did not send the answer. Send without the note or answer in the terminal (the n key adds a note).',
  },
  'dialogs.note-not-allowed': {
    en: '⚠ A note applies to one chosen option from the list. Rarog did not send the answer. Choose an option or remove the note.',
  },
  'dialogs.note-not-delivered': {
    en: "⚠ The hook didn't receive the answer with the note (timeout, or the decision was made at the desk). Rarog did not send the digit, because it would lose the note. Answer in the terminal: select the option and add the note with the n key. Your note: “{notes}”",
    args: ['notes:text'],
  },
  'dialogs.note-write-failed': {
    en: "⚠ Couldn't save the answer with the note for the hook. Rarog did not send the answer (a digit would lose the note). Try again or answer in the terminal.",
  },
  'dialogs.pause-escape': {
    en: "⚠ The pane shows “Session paused”. Rarog doesn't send Esc to it, because the effect hasn't been verified. Choose an option in the terminal. Rarog sent no key.",
  },
  'dialogs.screen-changed': {
    en: '⚠ The pane now shows a different dialog than this card. Rarog sent no key. Decide again on the new card or in the terminal.',
  },
  'dialogs.stale-decision': {
    en: "⚠ The answer didn't go through: the dialog in the terminal changed in the meantime. Tap again on the new card. Rarog sent no key.",
  },
  'dialogs.start-dialog.imports': {
    en:
      'Claude Code asks in the terminal whether to allow external imports in the instruction files of this project. ' +
      'Answer it in the terminal: Claude Code keeps the answer for this project for good. Rarog sends no key to it.',
  },
  'dialogs.start-dialog.refused': {
    en: '⚠ A Claude Code start dialog stands in the terminal. Rarog sent no key and no text. Answer it in the terminal.',
  },
  'dialogs.start-dialog.unknown': {
    en:
      "Claude Code stands on a start dialog Rarog doesn't know. Answer it in the terminal; Rarog sends no key to it.",
  },
  'dialogs.submit-abort.not-a-form': { en: 'the screen no longer shows a question form' },
  'dialogs.submit-abort.notes-editing': {
    en: 'the form is in note-editing mode (the digit may have been typed as text; check the field)',
  },
  'dialogs.submit-abort.option-unconfirmed': { en: "the highlight isn't clearly on the chosen option" },
  'dialogs.submit-abort.question-changed': { en: 'the form now shows a different question than the card' },
  'dialogs.terminal-dialog': {
    en: "⚠ You resolve this CLI dialog in the terminal. Rarog shows it on a card but doesn't choose an option in it. Rarog sent no key.",
  },
  'dialogs.terminal-only': {
    en: "⚠ This option permanently changes the pane's permissions. Choose it in the terminal. Rarog sent no key.",
  },
} as const satisfies SentenceArea;
