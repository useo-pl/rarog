/**
 * Zdania obszaru `restart`: restart sesji i serwera.
 *
 * Kod ma postać `restart.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const RESTART_SENTENCES = {
  'restart.background-task-running': { en: 'A background task is running. A restart would interrupt it.' },
  'restart.busy': { en: 'The session is working or waiting for a decision. You can restart it once it stops.' },
  'restart.codex': { en: "Restart the Codex pane in herdr. Rarog shows its state but doesn't manage it." },
  'restart.composer-unknown': {
    en: "Couldn't read the prompt field in the pane. Restart the session in the terminal.",
  },
  'restart.done': { en: 'Session restarted.' },
  'restart.done.version': { en: 'Session restarted on Claude Code {version}.', args: ['version:text'] },
  'restart.exit-asked': {
    en: 'Restart canceled: Claude Code asked a question on exit (background work?). The session keeps running.',
  },
  'restart.exit-background-tasks': {
    en: 'Restart canceled: background tasks would stop on exit. The session keeps running.',
  },
  'restart.exit-background-tasks.list': {
    en: '⚠ Restart canceled: the session has background tasks that would stop on exit: {tasks}. The session keeps running; restart it in the terminal or after these tasks finish.',
    args: ['tasks:text'],
  },
  'restart.exit-background-tasks.list-more': {
    en: '⚠ Restart canceled: the session has background tasks that would stop on exit: {tasks} and {more} more. The session keeps running; restart it in the terminal or after these tasks finish.',
    args: ['tasks:text', 'more:int'],
  },
  'restart.exit-timeout': { en: "Restart canceled: Claude Code didn't exit after /exit. Check the pane in herdr." },
  'restart.exit-unconfirmed': {
    en: "The pane closed Claude Code, but the end of the process wasn't confirmed. Resume the conversation in a moment.",
  },
  'restart.exit-note': { en: '⚠ {reason}', args: ['reason:code'] },
  'restart.exiting': { en: 'Exiting the session…' },
  'restart.exiting.version': { en: 'Exiting the session on Claude Code {version}…', args: ['version:text'] },
  'restart.failed': { en: "Couldn't restart" },
  'restart.failed.code': { en: "Couldn't restart: {reason}", args: ['reason:code'] },
  'restart.failed.panel-gone': { en: "Couldn't restart: the pane disappeared before it was ready" },
  'restart.failed.reason': { en: "Couldn't restart: {reason}", args: ['reason:text'] },
  'restart.in-progress': { en: 'This session is restarting right now.' },
  'restart.launching': { en: 'Restarting…' },
  'restart.launching.version': { en: 'Restarting on Claude Code {version}…', args: ['version:text'] },
  'restart.mode-unknown': {
    en: "Couldn't read the permission mode in the pane. Starting in the default mode could give the session more freedom.",
  },
  'restart.multiple-writers': {
    en: 'More than one Claude Code process is driving this conversation. Restart it in the terminal.',
  },
  'restart.no-panel': { en: 'This session has no live pane. To continue the conversation, use the “Resume” button.' },
  'restart.no-update': { en: 'The session is already running the installed version of Claude Code.' },
  'restart.panel-changed': {
    en: 'The pane now holds a different Claude Code session. Refresh the view and try again.',
  },
  'restart.resend-stale': { en: 'This prompt is no longer waiting to be sent again.' },
  'restart.single-writer-unverified': {
    en: "Couldn't confirm that exactly one process is driving this conversation. Try again in a moment.",
  },
  'restart.unsent-prompt.mac': {
    en: "There's unsent text in the prompt field on the Mac. Send it or clear it, then try again.",
  },
  'restart.unsent-prompt.vps': {
    en: "There's unsent text in the prompt field on the VPS. Send it or clear it, then try again.",
  },
  'restart.unsupported': { en: "This pane doesn't support restarting from Rarog." },
  'restart.update-not-applied': {
    en: "⚠ The session restarted, but the process is still on Claude Code {version}. Check which `claude` the pane's shell finds.",
    args: ['version:text'],
  },
  'restart.update-version-unverified': {
    en: "⚠ The session restarted, but I couldn't read its Claude Code version (before the restart: {version}). Check which `claude` the pane's shell finds.",
    args: ['version:text'],
  },
  'restart.waiting-agent': {
    en: 'A subagent with its own task is waiting in the background. A restart would interrupt it.',
  },
} as const satisfies SentenceArea;
