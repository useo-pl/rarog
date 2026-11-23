/**
 * Wzorce strukturalne danych prywatnych — JEDNA definicja dla strażnika `server/test/private-patterns-guard.test.ts`
 * (zapadka po całym repo) i anonimizatora fixture'ów `scripts/anonymize-fixture.ts` (podmiana i sprawdzian po niej).
 * Opis: `docs/publishing.md`, „What protects whom”.
 *
 * Wzorzec łapie KLASĘ danych, nie konkretną nazwę, więc mieszka w repo i działa bez pliku prywatnych literałów:
 * adres e-mail poza domenami przykładowymi, nazwa tailnetu w sufiksie MagicDNS, katalog domowy z loginem spoza
 * zamkniętej listy syntetycznych, katalog tymczasowy macOS, identyfikator API o długości prawdziwego, baner planu
 * konta i licznik limitu, numer zgłoszenia z trackera, goły skrót commita w dokumencie i `git show` na skrócie.
 *
 * Czysty ESM, wyłącznie wbudowany JavaScript (jak `private-literals.mjs`). Typy: `private-patterns.d.mts`.
 */

/**
 * Plik z syntetycznymi próbkami każdego wzorca (testy mechanizmu strażnika): strażnik i bramka publikacji go pomijają,
 * bo próbki muszą trafiać.
 */
export const PATTERN_SAMPLES_FILE = 'server/test/private-patterns-guard.test.ts';

/** Domeny, pod którymi adres e-mail jest syntetyczny albo publiczny z natury (produkt, Anthropic). */
export const ALLOWED_EMAIL_DOMAINS = /^(?:(?:[a-z0-9-]+\.)*example(?:\.[a-z]+)?|claude\.ai|(?:[a-z0-9-]+\.)*rarog\.ai)$/;

/** Nazwy tailnetu w sufiksie MagicDNS, które są syntetyczne. */
export const ALLOWED_TAILNETS = new Set(['example', 'demo']);

/** Zamknięta lista loginów syntetycznych w ścieżkach `/Users/<login>` (fixture'y, testy, przykłady w docs). */
export const SYNTHETIC_LOGINS = new Set(['u', 'demo', 'x', 'y', 'o', 'a', 'd', 'testowy', 'ktos', 'znajomy', 'jkowals']);

/** Prefiksy publicznych identyfikatorów w kształcie numeru zgłoszenia: skróty, kody Apple, propozycje Swift, sesje WWDC. */
export const PUBLIC_TICKET_PREFIXES = /^(?:SHA|ITMS|SE|WWDC\d\d)$/;

/** Adres e-mail; grupa 1 to domena. */
export const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
/** Host w sufiksie MagicDNS; grupa 1 to nazwa tailnetu. */
export const TAILNET = /\b(?:[a-z0-9-]+\.)*([a-z0-9-]+)\.ts\.net\b/gi;
/** Katalog domowy macOS; grupa 1 to login. */
export const HOME_PATH = /\/Users\/([A-Za-z0-9._-]+)/g;
/** Katalog projektu Claude Code w magazynie CLI (`~/.claude/projects/-Users-<login>-…`); grupa 1 to login. */
export const HOME_SLUG = /-Users-([A-Za-z0-9._]+)-/g;
/** Katalog tymczasowy macOS (`$TMPDIR`: katalog `folders` pod `/var`, dwa segmenty losowe, potem `T`). */
export const TEMP_DIR = /\/var\/folders\//g;
/** Identyfikator API w kształcie prawdziwego (`01` i co najmniej 20 znaków base62); grupa 1 to prefiks. */
export const API_ID = /\b(msg|req|toolu|srvtoolu)_01[A-Za-z0-9]{20,}/g;
/** Nazwa planu konta w banerze powitalnym CLI. */
export const ACCOUNT_PLAN = /\bClaude (?:Max|Pro|Ultra)\b/g;
/** Licznik limitu pięciogodzinnego w pasku statusu (`5h:` i procent). */
export const LIMIT_COUNTER = /\b5h:\s?\d{1,3}\s?%/g;
/** Numer zgłoszenia z trackera; grupa 1 to prefiks. */
export const TICKET = /\b([A-Z][A-Z0-9]{1,5})-\d{3,6}\b/g;
/** `git show` na skrócie commita (odsyłacz do historii, której eksport nie ma). */
export const GIT_SHOW = /\bgit show [0-9a-f]{7,40}\b/g;

/** Numery linii dopasowań `regex` (flaga `g`), dla których `keep(dopasowanie)` daje `true`. */
function matchingLines(text, regex, keep = () => true) {
  const out = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(regex)) if (keep(match)) out.push(index + 1);
  });
  return out;
}

/** Goły skrót w dokumencie: 7–40 znaków szesnastkowych z co najmniej jedną cyfrą i jedną literą. */
function commitHashes(text, file) {
  if (!file.endsWith('.md')) return [];
  const out = [];
  let fence = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    // Bloki kodu i linie o sumach kontrolnych (`sha256`) niosą dane, nie odsyłacze do historii.
    if (fence || /sha-?256/i.test(line)) return;
    for (const match of line.matchAll(/(?<![#\w-])[0-9a-f]{7,40}(?![\w-])/g)) {
      if (/[0-9]/.test(match[0]) && /[a-f]/.test(match[0])) out.push(index + 1);
    }
  });
  return out;
}

/** Czy adres e-mail (grupa 1: domena) jest prywatny. */
export const privateEmail = (match) => !ALLOWED_EMAIL_DOMAINS.test((match[1] ?? '').toLowerCase());
/** Czy host MagicDNS (grupa 1: tailnet) jest prywatny. */
export const privateTailnet = (match) => !ALLOWED_TAILNETS.has((match[1] ?? '').toLowerCase());
/** Czy katalog domowy (grupa 1: login) jest prywatny. */
export const privateLogin = (match) => !SYNTHETIC_LOGINS.has(match[1] ?? '');
/** Czy numer zgłoszenia (grupa 1: prefiks) jest prywatny. */
export const privateTicket = (match) => !PUBLIC_TICKET_PREFIXES.test(match[1] ?? '');

/**
 * Wzorce strukturalne: nazwa (klucz zapadki strażnika) → numery linii trafień w tekście pliku `file` (ścieżka
 * względem korzenia repo; skrót commita liczy się tylko w `*.md`). Kilka trafień w linii = kilka wpisów.
 */
export const STRUCTURAL_PATTERNS = [
  { name: 'e-mail', lines: (text) => matchingLines(text, EMAIL, privateEmail) },
  { name: 'tailnet', lines: (text) => matchingLines(text, TAILNET, privateTailnet) },
  {
    name: 'katalog-domowy',
    lines: (text) => [...matchingLines(text, HOME_PATH, privateLogin), ...matchingLines(text, HOME_SLUG, privateLogin)],
  },
  { name: 'katalog-tymczasowy', lines: (text) => matchingLines(text, TEMP_DIR) },
  { name: 'identyfikator-api', lines: (text) => matchingLines(text, API_ID) },
  { name: 'plan-konta', lines: (text) => matchingLines(text, ACCOUNT_PLAN) },
  { name: 'licznik-limitu', lines: (text) => matchingLines(text, LIMIT_COUNTER) },
  { name: 'zgloszenie', lines: (text) => matchingLines(text, TICKET, privateTicket) },
  { name: 'skrot-commita', lines: commitHashes },
  { name: 'git-show', lines: (text) => matchingLines(text, GIT_SHOW) },
];

/**
 * Wyjątki wzorców (`{ plik, wzorzec, fragment, powod }`): trafienie wzorca `wzorzec` w linii pliku `plik` (albo
 * pliku pod katalogiem z `/` na końcu), która zawiera `fragment`, nie liczy się. Wyłącznie dla danych, które mają
 * kształt danych prywatnych z natury rzeczy, z powodem. Wyjątek bez trafienia czerwieni strażnika. Fragment nie
 * może sam trafiać we wzorzec, bo ten plik też jest skanowany (stąd `folders/` bez `/var/` przed nim).
 */
export const STRUCTURAL_EXCEPTIONS = Object.freeze([
  {
    plik: 'native/Rarog/Packages/RarogUI/Sources/RarogUI/Session/Cards/AlwaysLabelParts.swift',
    wzorzec: 'katalog-tymczasowy',
    fragment: 'folders/<a>/<b>/T',
    powod: 'description of the function that shortens the macOS temporary directory to `$TMPDIR`',
  },
  {
    plik: 'native/Rarog/Packages/RarogUI/Tests/RarogUILogicTests/AlwaysLabelPartsTests.swift',
    wzorzec: 'katalog-tymczasowy',
    fragment: 'folders/<a>/<b>/T',
    powod: 'title of the temporary directory shortening test',
  },
  {
    plik: 'native/Rarog/Packages/RarogUI/Tests/RarogUILogicTests/AlwaysLabelPartsTests.swift',
    wzorzec: 'katalog-tymczasowy',
    fragment: 'folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/',
    powod: 'temporary directory shortening test data, segments replaced',
  },
  {
    plik: 'native/Rarog/Packages/RarogUI/Tests/RarogUILogicTests/AlwaysLabelPartsTests.swift',
    wzorzec: 'katalog-tymczasowy',
    fragment: 'folders/aa/',
    powod: 'temporary directory shortening test data, synthetic segments',
  },
  {
    plik: 'native/Rarog/Packages/RarogUI/Tests/RarogUILogicTests/AlwaysLabelPartsTests.swift',
    wzorzec: 'katalog-tymczasowy',
    fragment: 'folders/c/d/T',
    powod: 'temporary directory shortening test data, one-character synthetic segments',
  },
  {
    plik: 'native/Rarog/README.md',
    wzorzec: 'skrot-commita',
    fragment: '**SwiftTerm 1.19.0** — `exact`, commit `',
    powod: 'commit of a pinned Swift dependency: package code, not repo history',
  },
  {
    plik: 'native/Rarog/README.md',
    wzorzec: 'skrot-commita',
    fragment: '**swift-argument-parser 1.8.2** — commit `',
    powod: 'commit of a pinned Swift dependency: package code, not repo history',
  },
  {
    plik: 'native/Rarog/README.md',
    wzorzec: 'skrot-commita',
    fragment: '**IrohLib 1.2.0** — `exact`, commit `',
    powod: 'commit of a pinned Swift dependency: package code, not repo history',
  },
  {
    plik: 'native/Rarog/RarogUITests/AcceptanceUITests.swift',
    wzorzec: 'zgloszenie',
    fragment: '500-tabel-streaming"',
    powod: 'screenshot attachment name in an acceptance test, not an issue number',
  },
].map((wyjatek) => Object.freeze(wyjatek)));

/** Wyjątki pliku `file` dla wzorca `name` (dokładna ścieżka albo katalog z `/` na końcu). */
const exceptionsFor = (exceptions, file, name) => exceptions.filter((w) => w.wzorzec === name
  && (w.plik.endsWith('/') ? file.startsWith(w.plik) : file === w.plik));

/**
 * Trafienia wszystkich wzorców w tekście pliku `file`: `{ line, name }`, posortowane po linii, bez trafień zdjętych
 * przez wyjątki (domyślnie {@link STRUCTURAL_EXCEPTIONS}). Wzorzec podaje linię raz na każde trafienie, a każde
 * wystąpienie fragmentu wyjątku w linii zdejmuje JEDNO trafienie tego wzorca: drugie trafienie obok fragmentu (druga
 * ścieżka, drugi skrót) dalej się liczy. `used` zbiera wyjątki, których fragment zdjął choć jedno trafienie.
 */
export function structuralHits(text, file = '', { exceptions = STRUCTURAL_EXCEPTIONS, used } = {}) {
  const lines = text.split('\n');
  const hits = [];
  const occurrences = (line, fragment) => line.split(fragment).length - 1;
  for (const pattern of STRUCTURAL_PATTERNS) {
    const own = exceptionsFor(exceptions, file, pattern.name);
    const perLine = new Map();
    for (const line of pattern.lines(text, file)) perLine.set(line, (perLine.get(line) ?? 0) + 1);
    for (const [line, count] of perLine) {
      let left = count;
      for (const w of own) {
        if (left === 0) break;
        const covered = Math.min(left, occurrences(lines[line - 1] ?? '', w.fragment));
        if (covered > 0) used?.add(w);
        left -= covered;
      }
      for (let i = 0; i < left; i += 1) hits.push({ line, name: pattern.name });
    }
  }
  return hits.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
