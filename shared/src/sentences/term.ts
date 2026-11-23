/**
 * Zdania obszaru `term`: terminal (ramki `err`, błędy backendu).
 *
 * Kod ma postać `term.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const TERM_SENTENCES = {
  'term.taken-over': { en: 'The terminal was taken over. Open it again.' },
  'term.attach-failed': { en: "The terminal isn't starting. Open it again from the project list." },
  'term.attach-limit': { en: 'Open terminal limit reached. Close another terminal and try again.' },
  'term.dir-unreadable': { en: "Couldn't read the directory." },
  'term.disabled': { en: 'The terminal is turned off (RAROG_TERM).' },
  'term.history-unreadable': { en: "Couldn't read the terminal's history." },
  'term.label-conflict.mac': {
    en: "This terminal's pane has conflicting labels in herdr. Check the tabs on the Mac and try again.",
  },
  'term.label-conflict.vps': {
    en: "This terminal's pane has conflicting labels in herdr. Check the tabs on the VPS and try again.",
  },
  'term.lazygit-changed': { en: 'The lazygit pane changed while it was being checked. Try again.' },
  'term.lazygit-close-failed': { en: "Couldn't close the old lazygit pane. Try again." },
  'term.needs-launch': { en: 'The terminal on herdr requires RAROG_HERDR_LAUNCH=1. Creating panes is turned off.' },
  'term.needs-send': {
    en: 'The terminal on herdr requires RAROG_HERDR_SEND=1. The write channel to herdr is turned off.',
  },
  'term.not-found': { en: "That terminal doesn't exist." },
  'term.not-starting.mac': { en: "The terminal isn't starting. Check the pane in herdr on the Mac and try again." },
  'term.not-starting.vps': { en: "The terminal isn't starting. Check the pane in herdr on the VPS and try again." },
  'term.open-limit': {
    en: { one: 'Limit of {max} open terminal. Close one.', other: 'Limit of {max} open terminals. Close one.' },
    args: ['max:plural'],
  },
  'term.project-limit': {
    en: { one: 'Limit of {max} terminal per project. Close one.', other: 'Limit of {max} terminals per project. Close one.' },
    args: ['max:plural'],
  },
  'term.recovering': { en: 'The terminal is recovering. Try again in a moment.' },
  'term.shutting-down': { en: 'The terminal is shutting down.' },
  'term.slot-out-of-range': { en: 'Terminal number out of range 1–{max}.', args: ['max:int'] },
} as const satisfies SentenceArea;
