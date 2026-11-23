/**
 * Licznik automatycznej odmowy dialogu (zmierzone na CLI 2.1.294; nowe brzmienie na 2.1.316).
 *
 * W sesji bez obsługi CLI dopisuje pod operacją zdanie „⚠ Claude Code will automatically deny this
 * request in 1:58, to avoid blocking progress on an unattended session" (2.1.294) albo „⚠ Claude Code
 * will automatically block this request in 1:38, to avoid holding up an unattended session" (2.1.316)
 * i po ~2 minutach sam odrzuca dialog. Rejestr zna oba brzmienia, bo panele chodzą na różnych wersjach
 * CLI naraz. Licznik tyka co sekundę, więc nie jest treścią dialogu: w tekście pytania
 * zmieniałby odcisk karty z ekranu przy każdej ocenie (nowa karta co 4 s) i przy kontroli tuż
 * przed cyfrą (fałszywe „ekran się zmienił"). Wycinamy go z tekstu przed złożeniem pytania.
 *
 * Wycinamy WYŁĄCZNIE blok interfejsu: zdanie zaczynające linię (glif `⚠` na początku). To samo
 * zdanie zacytowane w środku pytania autora zostaje — inaczej pytanie
 * traciłoby treść, a jego dopasowanie do zrzutu hooka by padało.
 */
import { SCREEN_SIGNATURES } from './signatures.ts';

const COUNTDOWN = new RegExp(`(^|\\n)[ \\t]*${SCREEN_SIGNATURES.autoDenyCountdown.pattern.source}`, 'gu');

/**
 * Linie regionu bez zdania licznika; liczba linii zostaje ta sama (linie licznika są puste),
 * bo zdanie zawija się przez wąski panel na dwie linie.
 */
export function withoutAutoDeny(region: readonly string[]): string[] {
  const joined = region.join('\n');
  COUNTDOWN.lastIndex = 0;
  if (!COUNTDOWN.test(joined)) return [...region];
  COUNTDOWN.lastIndex = 0;
  return joined
    .replace(COUNTDOWN, (match, lead: string) => lead + match.slice(lead.length).replace(/[^\n]/gu, ''))
    .split('\n');
}
