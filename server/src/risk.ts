/**
 * Klasyfikator „czerwonych" akcji.
 *
 * UWAGA — to jest mechanizm UX (anty-fatigue), a NIE granica bezpieczeństwa. Zadaniem
 * klasyfikatora jest wymusić dodatkowy, świadomy gest (hold 1,5 s) przy komendach, które
 * typowo kasują dane albo publikują coś na zewnątrz. Każdy klasyfikator na regexach da się
 * obejść (podstawienia shellowe, aliasy, skrypty pomocnicze) — udokumentowane obejścia są
 * w `server/test/risk.test.ts`. Granicą bezpieczeństwa jest zgoda użytkownika na KAŻDE
 * użycie narzędzia (canUseTool) i allow-lista katalogów, nie ten plik.
 *
 * Kierunek błędu jest świadomy: wolimy fałszywy alarm (dodatkowy hold) niż przepuszczoną
 * komendę kasującą dane.
 */
import type { Risk } from '@rarog/shared';

export interface RedRule {
  /** Nazwa reguły — trafia do logu/diagnostyki, nigdy do UI. */
  readonly name: string;
  /**
   * Whether the rule applies to the text. The time is linear in the length of the text: the classifier runs
   * synchronously on text an agent wrote (up to the size limit of a tool input), so a rule whose time grew with the
   * square of a line would hold the whole server.
   */
  readonly matches: (text: string) => boolean;
  /** Po co ta reguła istnieje (czytane przy przeglądzie kodu, nie przez użytkownika). */
  readonly why: string;
}

/** The pattern anywhere in the text. Only for a pattern without `.*`, which does bounded work at each position. */
const anywhere = (pattern: RegExp) => (text: string): boolean => pattern.test(text);

/** The characters `.` does not match. */
const LINE_END = /[\n\r\u2028\u2029]/;

/**
 * `head`, then anything on the same line, then `tail`: what the pattern `head.*tail` asks. That pattern starts again
 * at every `head`, and each start reads the rest of the line, so its time grows with the square of the line. Here a
 * line is searched once for its first `head` and once for a `tail` after it; a later `head` adds nothing, because
 * what follows it follows the first one too.
 */
const onOneLine = (head: RegExp, tail: RegExp) => (text: string): boolean => text.split(LINE_END).some((line) => {
  const found = head.exec(line);
  return found !== null && tail.test(line.slice(found.index + found[0].length));
});

/**
 * A pipe into a shell or an interpreter, also by its path (`| /bin/zsh`): zsh is the default shell on a Mac, and
 * install scripts are piped into `python3` and `node` as well. The word boundary keeps a filter whose name starts
 * like a shell (`shasum`) an ordinary card. The path cannot contain a pipe: a path that ran across pipes made every
 * pipe rescan the rest of the line.
 */
const PIPE_INTO_INTERPRETER = /\|\s*(?:[^\s|]*\/)?(?:(?:ba|z|da|k|fi)?sh|python[\d.]*|node|perl|ruby)\b/i;
const curlIntoInterpreter = onOneLine(/curl /i, PIPE_INTO_INTERPRETER);
const wgetIntoPipe = onOneLine(/wget /i, /\|/);
const forcedPush = onOneLine(/git\s+push\s/i, /--force/i);
const hardReset = anywhere(/git\s+reset\s+--hard/i);

/**
 * Reguły ze speca. Wzorce są case-insensitive — shell rozróżnia wielkość liter, ale
 * klasyfikator ma łapać też zapisy „na pokaz" (np. `SUDO`), a fałszywy alarm jest tani.
 *
 * Odstępstwo od zapisu w specu: ścieżki mają wyescapowaną kropkę (`~/\.ssh` zamiast `~/.ssh`),
 * bo niewyescapowana kropka dopasowałaby też `~/xssh` — to zawężenie, nie rozszerzenie.
 */
export const RED_RULES: readonly RedRule[] = [
  {
    name: 'destrukcyjne-usuwanie',
    matches: anywhere(/\brm\b|\brmdir\b|\bdd\b/i),
    why: 'kasowanie plików / nadpisywanie urządzeń blokowych',
  },
  {
    name: 'git-nadpisanie-historii',
    matches: (text) => forcedPush(text) || hardReset(text),
    why: 'utrata commitów lokalnie albo na zdalnym repo',
  },
  {
    name: 'eskalacja-uprawnien',
    matches: anywhere(/\bsudo\b/i),
    why: 'wyjście poza uprawnienia użytkownika',
  },
  {
    /*
     * `curl` piped into a shell or an interpreter ({@link PIPE_INTO_INTERPRETER}); `wget` is red with any pipe.
     * A pipe at the end of a line continues on the next one, as in the shell, so the whitespace after a pipe is
     * folded to one space before the lines are read.
     */
    name: 'pipe-do-shella',
    matches: (text) => curlIntoInterpreter(text.replace(/\|\s+/g, '| ')) || wgetIntoPipe(text),
    why: 'wykonanie niezweryfikowanego kodu z sieci',
  },
  {
    /*
     * Trzy zapisy tej samej ścieżki, bo agenty piszą je wymiennie: `~/.ssh`, `$HOME/.ssh`
     * i pełne `/Users/<ktoś>/.ssh`. Sam wariant z tyldą zostawiałby
     * wyciek klucza SSH na jednym tapnięciu zamiast na przytrzymaniu 1,5 s.
     * `\b` na końcu trzyma zawężenie z komentarza sekcji: `~/.sshx` nadal nie pasuje.
     */
    name: 'sciezki-sekretow',
    matches: anywhere(/(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s]+)\/\.(?:secrets|ssh|claude)\b/i),
    why: 'dostęp do kluczy i tokenów',
  },
  {
    name: 'deploy-na-zewnatrz',
    matches: anywhere(/wrangler\s+deploy|heroku\s+/i),
    why: 'publikacja na produkcję — skutek widoczny poza maszyną',
  },
];

/**
 * Pierwsza reguła dopasowana do tekstu komendy.
 *
 * @param text pełny tekst pokazywany użytkownikowi (komenda Basha albo opis inputu narzędzia)
 * @returns dopasowana reguła albo `null`, gdy nic nie pasuje
 */
export function matchRedRule(text: string): RedRule | null {
  for (const rule of RED_RULES) {
    if (rule.matches(text)) return rule;
  }
  return null;
}

/**
 * Klasyfikacja ryzyka pojedynczej prośby o zgodę.
 *
 * @param text      tekst komendy / opisu inputu (to samo, co widzi użytkownik)
 * @param toolName  nazwa narzędzia — dziś nieużywana w decyzji, ale trzymana w sygnaturze,
 *                  żeby zawężanie reguł per narzędzie nie wymagało zmiany wołających
 * @returns `'red'` gdy pasuje którakolwiek reguła, inaczej `'normal'`
 */
export function classifyRisk(text: string, toolName?: string): Risk {
  void toolName;
  return matchRedRule(text) === null ? 'normal' : 'red';
}
