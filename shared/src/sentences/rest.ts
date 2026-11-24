/**
 * Zdania obszaru `rest`: odpowiedzi i błędy REST (ciała `{error, message}`, walidacja żądań).
 *
 * Kod ma postać `rest.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const REST_SENTENCES = {
  'rest.bad-request': { en: 'Request rejected.' },
  'rest.session-not-found': { en: "That session doesn't exist." },
  'rest.bad-state': { en: "The session is in a state that doesn't allow this action." },
  'rest.session-closed': { en: 'This session is already closed.' },
  'rest.too-many-requests': { en: 'Too many requests. Try again in a moment.' },
  'rest.internal': { en: 'Server error.' },
  'rest.notes-conflict': { en: 'The notes changed on another device.' },
  'rest.device-revoked': { en: 'This device was revoked. Pair it with the server again.' },
  'rest.apns-device-unknown': {
    en: "This device isn't registered. Register the device token first, then the activity.",
  },
  'rest.apns-topic-mismatch': {
    en: "This app has a different identifier than the one the server handles, so notifications won't reach it.",
  },
  'rest.auth-rate-limited': { en: 'Too many failed attempts. Try again in a moment.' },
  'rest.bad-json': { en: "The request body isn't valid JSON." },
  'rest.bad-origin': { en: 'Request from a disallowed origin.' },
  'rest.body-contract': { en: "The request body doesn't match the expected format." },
  'rest.body-unreadable': { en: "Couldn't read the request." },
  'rest.client-log-failed': { en: "Couldn't save the log." },
  'rest.companion-busy': { en: 'The voice agent is already checking this session. Try again in a moment.' },
  'rest.companion-claude-only': {
    en: 'The voice agent works only with Claude Code sessions in the allowed projects.',
  },
  'rest.companion-cli': {
    en: "Claude Code on the server didn't answer. Check that it's installed and signed in to the subscription.",
  },
  'rest.companion-disabled': { en: 'The voice agent is turned off on the server (RAROG_COMPANION).' },
  'rest.companion-turns-count': { en: 'The voice agent reads 1 to 3 turns of a session (count).' },
  'rest.companion-sessions-disabled': {
    en: "The voice agent's mode across sessions is turned off on the server (RAROG_COMPANION_SESSIONS).",
  },
  'rest.companion-limit': { en: "The Claude plan limit is used up, so the voice agent can't check the session now." },
  'rest.companion-openai': {
    en: "OpenAI didn't give the voice agent a key. Check the model with rarog voice-agent status on the server.",
  },
  'rest.companion-openai-key': {
    en: "OpenAI rejected the server's key. Set a new one with rarog voice-agent set-key on the server.",
  },
  'rest.companion-openai-key-missing': {
    en: 'The voice agent has no OpenAI key on the server. Set it with rarog voice-agent set-key.',
  },
  'rest.companion-openai-limit': { en: 'The OpenAI account limit is reached. Try again later.' },
  'rest.companion-speech-disabled': { en: "The voice agent's Soniox voice is turned off on the server." },
  'rest.companion-speech-foreign-region': {
    en: "The voice agent's Soniox voice is turned off. The Soniox key is from outside the EU region. Fix SONIOX_API_HOST on the server.",
  },
  'rest.companion-speech-key-missing': {
    en: 'The voice agent has no Soniox key on the server. Set it with rarog dictation set-key.',
  },
  'rest.companion-speech-key-rejected': {
    en: "Soniox rejected the server's key. Check SONIOX_API_KEY in the server environment.",
  },
  'rest.companion-speech-upstream': { en: "Soniox didn't give the voice agent a key. Try again in a moment." },
  'rest.companion-throttled': { en: 'Too soon. Wait a moment and start the conversation again.' },
  'rest.companion-timeout': { en: 'Checking the session took too long. Try again.' },
  'rest.cwd-empty': { en: 'Enter the path to a project directory.' },
  'rest.cwd-folder-denied': {
    en: "macOS doesn't let Rarog into this folder. Change it in System Settings on the Mac "
      + '(Privacy & Security → Files & Folders).',
  },
  'rest.cwd-folder-unchecked': { en: "Rarog can't check access to this folder. The server log has the details." },
  'rest.cwd-folder-waiting': {
    en: "Rarog can't open this folder: macOS is probably waiting for someone to click Allow on the Mac.",
  },
  'rest.cwd-hidden': { en: "Hidden directories (those starting with a dot) aren't allowed." },
  'rest.cwd-not-absolute': { en: 'Enter the full directory path, starting with “/” or “~/”.' },
  'rest.cwd-not-found': { en: "That directory doesn't exist." },
  'rest.cwd-not-in-projects': { en: "This directory isn't in the project list." },
  'rest.cwd-outside-roots': { en: 'This directory is outside the allowed projects.' },
  'rest.cwd-outside-roots.listed': {
    en: 'This directory is outside the allowed projects ({roots}).',
    args: ['roots:text'],
  },
  'rest.cwd-protected': {
    en: 'macOS protects this folder. To work in it, add it to the project directories on the server.',
  },
  'rest.cwd-symlink-escape': { en: 'This directory leads through a symlink outside the allowed projects.' },
  'rest.decision-conflict': { en: 'This was already decided on another device.' },
  'rest.decision-expired': { en: 'The request expired. Resume the session.' },
  'rest.device-key-missing': { en: 'No device key. Pair this device with the server.' },
  'rest.device-required': { en: 'This action requires the key of a paired device.' },
  'rest.device-unknown': { en: "The server doesn't recognize this device. Pair it again." },
  'rest.diff-bad-path': { en: 'Invalid file path.' },
  'rest.dir-exists': { en: 'Something with that name already exists here.' },
  'rest.dir-name-chars': {
    en: "The name can't contain “/”, “:” or invisible characters, and can't start or end with a space.",
  },
  'rest.dir-name-empty': { en: 'Enter a name for the new directory.' },
  'rest.dir-name-invalid': { en: "This name can't be used for a directory here." },
  'rest.dir-name-too-long': { en: 'The name is too long.' },
  'rest.diff-file-not-found': { en: "That file isn't in the list of changes. The list may have changed." },
  'rest.diff-git-failed': { en: "Git didn't respond. Try again." },
  'rest.endpoint-not-found': { en: "That endpoint doesn't exist." },
  'rest.file-too-large': {
    en: 'This file has {size} MB. The server sends files up to {limit} MB (RAROG_FILES_MAX_MB).',
    args: ['size:int', 'limit:int'],
  },
  'rest.files-codex': { en: "Rarog only observes the Codex pane, so it doesn't show the files in its directory." },
  'rest.files-no-pane': { en: "This session has no herdr pane, so Rarog doesn't show the files in its directory." },
  'rest.files-not-found': { en: "That file or directory isn't there, or Rarog doesn't show it." },
  'rest.files-out-of-scope': {
    en: 'The pane is outside RAROG_HERDR_ROOTS. Rarog shows its state but not the files in its directory.',
  },
  'rest.image-not-found': { en: "That photo doesn't exist." },
  'rest.inbox-card-changed': { en: 'This Inbox card changed in the meantime, so nothing happened.' },
  'rest.inbox-disabled': { en: 'The Inbox is turned off on the server (RAROG_INBOX).' },
  'rest.inbox-save-failed': { en: "Couldn't save the change to the Inbox." },
  'rest.login-retired': { en: 'Token sign-in no longer exists. Pair the device (rarog pair).' },
  'rest.method-not-allowed': { en: 'Method not allowed.' },
  'rest.mkdir-busy': { en: 'Another directory is being created. Try again in a moment.' },
  'rest.mkdir-disabled': { en: 'Creating directories is turned off on this server.' },
  'rest.mkdir-failed': { en: "Couldn't create the directory." },
  'rest.mkdir-moved': { en: 'This directory moved, so nothing was created. Open it again.' },
  'rest.notes-cwd-not-allowed': { en: "That directory doesn't exist. Notes are attached to an existing project." },
  'rest.notes-disabled': { en: 'Notes are turned off (RAROG_NOTES).' },
  'rest.notes-save-failed': { en: "Couldn't save the notes." },
  'rest.pair-code-invalid': { en: "The pairing code isn't valid. Generate a new one and try again." },
  'rest.pair-rate-limited': { en: 'Too many failed pairing attempts. Try again in a moment.' },
  'rest.pair-save-failed': { en: "Couldn't save the pairing. Generate a new code and try again." },
  'rest.pair-version-unknown': { en: 'Unknown pairing version. Update the app or the server.' },
  'rest.payload-too-large': { en: 'The request exceeds the limit of {limit}.', args: ['limit:text'] },
  'rest.push-test-cooldown': { en: 'A test push was just sent. Wait a minute.' },
  'rest.session-busy': { en: 'The session is busy right now.' },
  'rest.usage-unavailable.mac': {
    en: "Plan usage isn't available. No Claude Code session on the Mac has left a status line with limits.",
  },
  'rest.usage-unavailable.vps': {
    en: "Plan usage isn't available. No Claude Code session on the VPS has left a status line with limits.",
  },
  'rest.voice-disabled.mac': { en: 'Dictation is turned off. The Mac has no Soniox key.' },
  'rest.voice-disabled.vps': { en: 'Dictation is turned off. The VPS has no Soniox key.' },
  'rest.voice-foreign-region.mac': {
    en: 'Dictation is turned off. The Soniox key is from outside the EU region. Fix SONIOX_API_HOST on the Mac.',
  },
  'rest.voice-foreign-region.vps': {
    en: 'Dictation is turned off. The Soniox key is from outside the EU region. Fix SONIOX_API_HOST on the VPS.',
  },
  'rest.voice-key-rejected.mac': {
    en: 'Soniox rejected the key from the Mac. Check SONIOX_API_KEY in the server environment.',
  },
  'rest.voice-key-rejected.vps': {
    en: 'Soniox rejected the key from the VPS. Check SONIOX_API_KEY in the server environment.',
  },
  'rest.voice-throttled': { en: 'Too soon. Wait a moment and tap the microphone again.' },
  'rest.voice-upstream': { en: "Soniox didn't respond. Try again in a moment." },
} as const satisfies SentenceArea;
