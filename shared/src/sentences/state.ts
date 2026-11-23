/**
 * Zdania obszaru `state`: szczegół stanu sesji (`stateDetail`: limit planu, błąd sterownika, koniec tur).
 *
 * Kod ma postać `state.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const STATE_SENTENCES = {
  'state.herdr-unknown': { en: 'pane state not known yet' },
  'state.limit-reached': { en: 'Plan limit reached. Try again after {reset}.', args: ['reset:instant'] },
  'state.driver-error': { en: 'the engine finished with an error' },
  'state.driver-error.reason': { en: 'the engine finished with an error: {reason}', args: ['reason:text'] },
  'state.driver-gone': { en: 'the engine stopped responding' },
  'state.herdr-gone': { en: 'the pane disappeared from herdr' },
  'state.herdr-hidden': { en: 'hidden in Rarog (the pane stays in herdr)' },
  'state.herdr-launch-failed': { en: "couldn't create the pane" },
  'state.herdr-launch-failed.code': { en: "couldn't create the pane: {reason}", args: ['reason:code'] },
  'state.herdr-launch-failed.reason': { en: "couldn't create the pane: {reason}", args: ['reason:text'] },
  'state.herdr-launching': { en: 'creating the pane in herdr' },
  'state.interrupted': { en: 'interrupted by the user' },
  'state.max-turns': { en: 'turn limit reached, resume the session' },
} as const satisfies SentenceArea;
