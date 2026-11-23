/**
 * Zdania obszaru `session`: sesje (start, wysyłka, przerwanie, etykieta zapasowa, klasy błędów managera).
 *
 * Kod ma postać `session.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const SESSION_SENTENCES = {
  'session.fallback-label': { en: 'session {n}', args: ['n:int'] },
  'session.answer-multi-select': { en: 'Make multiple selections in the terminal. Rarog sends a single answer.' },
  'session.answer-note-needs-option': {
    en: 'A note applies to a chosen option. Choose one option from the list or remove the note.',
  },
  'session.answer-note-not-allowed': {
    en: "This question doesn't accept a note from the app. Add it in the terminal.",
  },
  'session.answer-note-too-long': {
    en: { one: 'The note is too long. Keep it within {max} character.', other: 'The note is too long. Keep it within {max} characters.' },
    args: ['max:plural'],
  },
  'session.answer-notes-mismatch': { en: "The notes don't match this card's questions." },
  'session.answer-notes-too-long': { en: 'The answers with notes are too long. Shorten a note.' },
  'session.answer-own-text': {
    en: 'Type a custom answer in the terminal. Rarog sends the digit of one of the options.',
  },
  'session.answer-too-long': {
    en: { one: 'The answer is too long. Keep it within {max} character.', other: 'The answer is too long. Keep it within {max} characters.' },
    args: ['max:plural'],
  },
  'session.bypass-outside-yolo-roots': {
    en: 'bypassPermissions mode is allowed only in directories under RAROG_YOLO_ROOTS.',
  },
  'session.cli-dialog.input': { en: 'question or form' },
  'session.cli-dialog.open': { en: 'open CLI dialog, e.g. /login or /model' },
  'session.cli-dialog.other': { en: 'CLI dialog' },
  'session.cli-dialog.permission': { en: 'tool permission' },
  'session.cli-dialog.sandbox': { en: 'network permission' },
  'session.client-id-conflict': {
    en: 'A message with this ID already arrived with different content. Nothing was sent.',
  },
  'session.close-not-owned': { en: "This session has no pane in herdr, so there's nothing to close." },
  'session.codex-close': { en: "Close the Codex pane in herdr. Rarog shows its state but doesn't manage it." },
  'session.codex-git': {
    en: 'Rarog only observes the Codex pane. Manage git in this project from the terminal or from herdr.',
  },
  'session.conversation-changed': {
    en: 'The session moved to another conversation after the voice agent read it. Nothing was sent.',
  },
  'session.cwd-denied': { en: "The directory {cwd} isn't allowed. {reason}", args: ['cwd:text', 'reason:code'] },
  'session.cwd-denied.outside-roots': {
    en: "The directory {cwd} isn't allowed. This directory is outside the allowed projects ({roots}).",
    args: ['cwd:text', 'roots:text'],
  },
  'session.cwd-outside-allow-list': {
    en: "The directory {cwd} isn't on the list of allowed projects.",
    args: ['cwd:text'],
  },
  'session.dialog-stands': {
    en: 'Sending is on hold: a dialog is waiting in the terminal ({dialog}). Answer in the terminal or on the card, then send again.',
    args: ['dialog:code'],
  },
  'session.dialog-unrecognized': {
    en: "Rarog didn't recognize this dialog. Allow it in the terminal. From here you can only deny it.",
  },
  'session.double-writer': { en: 'This session is open in herdr. Switch to it instead of resuming.' },
  'session.focus-no-panel': { en: "This session has no pane in herdr, so there's nothing to show." },
  'session.herdr-read-only': { en: 'herdr is read-only. Nothing was sent.' },
  'session.herdr-unavailable': { en: "herdr is unavailable right now. Try again when it's back." },
  'session.launch-off': { en: 'Creating sessions from Rarog is turned off (RAROG_HERDR_LAUNCH=0).' },
  'session.launch-throttled.mac': { en: 'Too many sessions too fast. Give the Mac a moment and try again.' },
  'session.launch-throttled.vps': { en: 'Too many sessions too fast. Give the VPS a moment and try again.' },
  'session.mode-busy': {
    en: 'The agent is working or waiting for a decision. Change the mode when it finishes its turn.',
  },
  'session.mode-bypass': { en: 'The pane is in bypass mode. Switch it in the terminal.' },
  'session.mode-footer-unknown': {
    en: "The mode footer isn't visible in this pane. A question or an overlay is probably covering it. Sending is on hold. Answer in the terminal, then send again.",
  },
  'session.mode-no-channel': {
    en: 'The mode is set when the session is created. This pane has no channel for changing it.',
  },
  'session.no-longer-accepting': { en: "Session {id} isn't accepting messages anymore.", args: ['id:text'] },
  'session.not-accepting-messages': {
    en: "Session {id} isn't accepting messages right now (state: {state}).",
    args: ['id:text', 'state:text'],
  },
  'session.out-of-scope': { en: "The pane is outside RAROG_HERDR_ROOTS. Rarog shows it but doesn't write to it." },
  'session.out-of-scope-diff': {
    en: 'The pane is outside RAROG_HERDR_ROOTS. Rarog shows its state but not the changes in its directory.',
  },
  'session.prompt-lost': { en: "The pane disappeared before this message could be sent. It wasn't delivered." },
  'session.prompt-not-taken.mac': {
    en: "⚠ The prompt “{prompt}” didn't reach the agent. The CLI didn't accept it, and the text is still in the field on the Mac. A hook is the most common cause.",
    args: ['prompt:text'],
  },
  'session.prompt-not-taken.vps': {
    en: "⚠ The prompt “{prompt}” didn't reach the agent. The CLI didn't accept it, and the text is still in the field on the VPS. A hook is the most common cause.",
    args: ['prompt:text'],
  },
  'session.prompt-unconfirmed.mac': {
    en: "Couldn't confirm that the agent received the prompt “{prompt}”. There's unsent text in the field on the Mac.",
    args: ['prompt:text'],
  },
  'session.prompt-unconfirmed.vps': {
    en: "Couldn't confirm that the agent received the prompt “{prompt}”. There's unsent text in the field on the VPS.",
    args: ['prompt:text'],
  },
  'session.prompt-unseen': {
    en: "Couldn't confirm that the agent received the prompt “{prompt}”. Rarog didn't paste it again. Check the terminal.",
    args: ['prompt:text'],
  },
  'session.resume-foreign-cwd': {
    en: 'This session belongs to a different directory. Resume it where it was created.',
  },
  'session.resume-not-found': { en: "Couldn't find this session's transcript in the CLI's storage." },
  'session.resume-unreadable': {
    en: "This session's transcript is unreadable or no longer exists. Start a new session.",
  },
  'session.resume-unverifiable': {
    en: "Couldn't verify which directory this session belongs to, so the resume was rejected.",
  },
  'session.seen-result-changed': {
    en: "The voice agent didn't read the session's current result. Nothing was marked as seen.",
  },
  'session.send-throttled': { en: 'Too fast. Give the pane a moment and send again.' },
  // The queue take-back: one sentence per refusal of the driver (`TakeBackRefusal`), plus a driver without a queue.
  'session.take-back.pane': { en: "This session's pane can't be reached. Nothing was taken back." },
  'session.take-back.dialog': { en: 'A dialog stands in the terminal. Answer it, then take the queue back.' },
  'session.take-back.draft': {
    en: 'The prompt field in the terminal holds text typed at the Mac. Nothing was taken back.',
  },
  'session.take-back.unknown': { en: "Rarog can't tell what's queued in this session. Nothing was taken back." },
  'session.take-back.queue': { en: "This queue can't be taken back from the app. Take it back in the terminal." },
  'session.take-back.busy': { en: 'The terminal is still clearing the last take-back. Try again in a moment.' },
  'session.take-back.disk': { en: "Couldn't save the queue without these messages. They stay queued." },
  'session.take-back.no-queue': { en: 'This session has no queue Rarog can take back.' },
  'session.trust-prompt': {
    en: "Claude Code hasn't trusted this folder yet, so the pane will ask whether you trust it. Answer on the card, or in the terminal when the card has no button.",
  },
} as const satisfies SentenceArea;
