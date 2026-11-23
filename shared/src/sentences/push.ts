/**
 * Zdania obszaru `push`: powiadomienia push (tytuły, treści, teksty zastępcze).
 *
 * Kod ma postać `push.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const PUSH_SENTENCES = {
  'push.placeholder.title': { en: 'Rarog' },
  'push.placeholder.body': { en: 'New notification' },
  'push.chime.title': { en: 'Agent finished' },
  'push.chime.body': { en: 'The result is waiting in Rarog' },
  'push.body.detail': { en: '{detail}', args: ['detail:text'] },
  'push.body.detail-and-label': { en: '{detail} — {label}', args: ['detail:text', 'label:text'] },
  'push.body.detail-and-session-number': { en: '{detail} — session {n}', args: ['detail:text', 'n:int'] },
  'push.body.fallback.blocked': { en: 'A dialog is open in the terminal. Open to see it.' },
  'push.body.fallback.done': { en: 'The result is waiting for you.' },
  'push.body.fallback.error': { en: 'The turn failed. Open to see why.' },
  'push.body.fallback.limit': { en: 'Open to see when to try again.' },
  'push.body.fallback.permission': { en: 'Open to decide.' },
  'push.body.fallback.question': { en: 'The agent asked a question. Answer in Rarog.' },
  'push.body.label': { en: '{label}', args: ['label:text'] },
  'push.paired-body.mac': {
    en: "{label}. If this wasn't you, revoke it on the Mac: rarog devices",
    args: ['label:text'],
  },
  'push.paired-body.vps': {
    en: "{label}. If this wasn't you, revoke it on the VPS: rarog devices",
    args: ['label:text'],
  },
  'push.paired-title': { en: '🔐 New device paired' },
  'push.test-body': { en: 'Tapping this opens Rarog. Notifications from sessions take you straight to the session.' },
  'push.test-title': { en: '🔔 Notifications are working' },
  'push.title.blocked': { en: '⛔ Waiting in the terminal · {project}', args: ['project:text'] },
  'push.title.done': { en: '✅ Done · {project}', args: ['project:text'] },
  'push.title.error': { en: '❌ Error · {project}', args: ['project:text'] },
  'push.title.limit': { en: '✋ Plan limit · {project}', args: ['project:text'] },
  'push.title.permission': { en: '⏳ Waiting for permission · {project}', args: ['project:text'] },
  'push.title.question': { en: '❓ Question · {project}', args: ['project:text'] },
  'push.version-title': { en: '🔄 Version changed' },
  'push.version-body.claude-code': { en: 'Claude Code {from} → {to}', args: ['from:text', 'to:text'] },
  'push.version-body.herdr': { en: 'herdr {from} → {to}', args: ['from:text', 'to:text'] },
  'push.version-body.both': {
    en: 'Claude Code {cliFrom} → {cliTo}, herdr {herdrFrom} → {herdrTo}',
    args: ['cliFrom:text', 'cliTo:text', 'herdrFrom:text', 'herdrTo:text'],
  },
  'push.weekly-limit-title': { en: '⚠️ Weekly limit at {percent}%', args: ['percent:int'] },
  'push.weekly-limit-body': { en: 'Resets {reset}.', args: ['reset:instant'] },
  'push.canary-title': { en: '🐤 Consent canary' },
  'push.canary-body.pass': { en: 'Claude Code {version}: passed.', args: ['version:text'] },
  'push.canary-body.fail': {
    en: 'Claude Code {version}: failed, Allow button only with the dialog on screen.',
    args: ['version:text'],
  },
  'push.canary-body.unmeasured': {
    en: 'Claude Code {version}: not measured, Allow button only with the dialog on screen.',
    args: ['version:text'],
  },
  'push.canary-body.unmeasured-package': {
    en: 'Claude Code {version}: not measured, Allow button also without the dialog on screen (package measurement).',
    args: ['version:text'],
  },
} as const satisfies SentenceArea;
