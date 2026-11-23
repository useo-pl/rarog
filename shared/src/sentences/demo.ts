/**
 * Zdania obszaru `demo`: serwer demo (tryb `RAROG_DEMO`).
 *
 * Kod ma postać `demo.<nazwa>` w kebab-case. Format wpisu, rodzaje argumentów i reguła „opublikowany kod nie
 * zmienia znaczenia, argumentów ani szablonu”: `index.ts`. Zdanie własne dla apki powstaje wyłącznie przez `say`
 * z kodem z tego pliku.
 */
import type { SentenceArea } from './index.ts';

export const DEMO_SENTENCES = {
  'demo.launch-throttled': { en: 'Too fast. The demo throttles session creation too.' },
  'demo.pane-cap': { en: 'Rarog pane limit reached (demo).' },
  'demo.pane-not-found': { en: "That pane doesn't exist." },
  'demo.review-device-limit': { en: 'Too many devices are paired with the demo. Try again later.' },
  'demo.review-refused': { en: "This isn't available in the demo." },
  'demo.seed-backend-restarted': { en: 'interrupted — backend restarted' },
  'demo.unauthorized': { en: 'Demo: the server rejects the device key.' },
  'demo.would-send': { en: 'Demo: Rarog would send `{command}` to the pane.', args: ['command:text'] },
} as const satisfies SentenceArea;
