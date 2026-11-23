/**
 * Strażnik literałów właściciela — dwie części (opis: `docs/publishing.md`).
 *
 * 1. **Literały publiczne z natury** (`PUBLIC_LITERALS`: Team ID Apple z podpisu apki, przedrostek kluczy
 *    wewnętrznych apki i próbka obcego tematu) stoją w repo jawnie, z allow-listą `ALLOWED` o DOKŁADNYCH liczbach
 *    per plik: nowe wystąpienie poza listą przewraca test z miejscem (`plik:linia`), a wpis z większą liczbą niż
 *    w pliku też (lista się skraca).
 *    Dokumentacja (`*.md`) może je cytować.
 * 2. **Literały prywatne** (domena i infrastruktura właściciela, klienci, login w kontekście ścieżki) pochodzą z pliku
 *    poza repo (`scripts/lib/private-literals.mjs`) i NIE mają w repo ani listy, ani allow-listy: tylko zapadkę
 *    liczby trafień per plik (`PRIVATE_BASELINE`), także w `*.md`. Bez pliku ta część się pomija z komunikatem,
 *    wymóg pliku (`REQUIRE_PRIVATE_LITERALS_ENV`) robi z pominięcia porażkę, a bramka publikacji
 *    (`PUBLISH_GATE_ENV`; obie zmienne w `scripts/lib/private-literals.mjs`) wymaga zera. Katalogi fixture'ów
 *    pilnuje ta sama zapadka w `herdr-fixtures.test.ts`.
 *
 * Zakres: pliki widoku eksportu z `repoFiles()` (`git ls-files` albo spacer z regułami `.gitignore` na eksporcie bez
 * `.git`; pliki spoza eksportu odcina `inExportView` z `private-guard.ts`), także testy, projekt Xcode i plisty. Dopasowanie bez wielkości liter. Ten plik jest pominięty w części 1:
 * niesie literały publiczne i ich syntetyczne próbki.
 */
import { describe, expect, it } from 'vitest';
import {
  REPO, describePrivate, inExportView, isFixture, privateContext, privateCounts, ratchet, ratchetMessage, renderBaseline,
} from './private-guard.ts';
import { repoTextFiles } from './source-scan.ts';

const SELF = 'server/test/distribution-guard.test.ts';

/**
 * Literały publiczne z natury: Team ID Apple (jawny w każdej podpisanej apce) i przedrostek kluczy apki w procesie
 * (bez trwałego stanu; ten sam napis to próbki obcego tematu APNs w testach).
 */
const PUBLIC_LITERALS = ['97TDXJ84WH', 'pl.useo.rarog'] as const;
type Literal = typeof PUBLIC_LITERALS[number];
type Allowed = Readonly<Record<string, Readonly<Partial<Record<Literal, number>>>>>;

/**
 * Gdzie literały publiczne wolno trzymać DZIŚ i ile ich jest. Skracać wolno zawsze;
 * wydłużać tylko świadomie, z powodem w komentarzu przy wpisie.
 */
const ALLOWED: Allowed = {
  // Apka: przedrostek kluczy w procesie, bez trwałego stanu: nazwy zdarzeń, atrybutów i kolejek, klucz
  // `userInfo` degradacji (usługi Keychaina idą za identyfikatorem apki `ai.rarog.app`).
  'native/Rarog/Packages/RarogContract/Sources/RarogContract/Degradation.swift': { 'pl.useo.rarog': 1 },
  'native/Rarog/Packages/RarogUI/Sources/RarogUI/Markdown/MarkdownDecorations.swift': { 'pl.useo.rarog': 1 },
  'native/Rarog/Packages/RarogUI/Sources/RarogUI/Markdown/MarkdownPlainText.swift': { 'pl.useo.rarog': 1 },
  'native/Rarog/Packages/RarogUI/Sources/RarogUI/Markdown/MarkdownRenderer.swift': { 'pl.useo.rarog': 3 },
  'native/Rarog/Packages/RarogUI/Sources/RarogUI/Markdown/MarkdownTableText.swift': { 'pl.useo.rarog': 1 },
  'native/Rarog/Packages/RarogUI/Sources/RarogUI/Model/DraftsDisk.swift': { 'pl.useo.rarog': 1 },
  'native/Rarog/Packages/RarogUI/Sources/RarogUI/Model/Navigation.swift': { 'pl.useo.rarog': 1 },
  'native/Rarog/Packages/RarogUI/Sources/RarogUI/Model/ToastCenter.swift': { 'pl.useo.rarog': 1 },
  'native/Rarog/Rarog/SystemSignals.swift': { 'pl.useo.rarog': 1 },
  // Zespół podpisu w projekcie Xcode (`DEVELOPMENT_TEAM` w Debug i Release pięciu celów; piąty — NSE).
  'native/Rarog/Rarog.xcodeproj/project.pbxproj': { '97TDXJ84WH': 10 },
  // Przekaźnik push: Team ID USEO jako `APNS_TEAM_ID` (`iss` JWT) produkcji, w testach próbka obcego tematu
  // APNs (temat spoza listy przepustek).
  'relay/test/core.test.ts': { 'pl.useo.rarog': 1 },
  'relay/test/policy.test.ts': { 'pl.useo.rarog': 1 },
  'relay/wrangler.toml': { '97TDXJ84WH': 1 },
  // Rejestr relaya iroh: ten sam Team ID jako `APPLE_TEAM_ID` (`iss` JWT DeviceCheck i próbnego pusha APNs);
  // `relay-auth/test/config.test.ts` pilnuje równości z `APNS_TEAM_ID` przekaźnika.
  'relay-auth/wrangler.toml': { '97TDXJ84WH': 1 },
  // Build apki (zespół podpisu).
  'scripts/ios-build.sh': { '97TDXJ84WH': 1 },
  // Testy: próbki obcego tematu APNs i Team ID z konfiguracji właściciela.
  'server/test/notify-apns-channel.test.ts': { '97TDXJ84WH': 1, 'pl.useo.rarog': 3 },
  'server/test/notify-apns-devices.test.ts': { 'pl.useo.rarog': 2 },
  'server/test/notify-apns.test.ts': { '97TDXJ84WH': 1 },
  'server/test/notify-config.test.ts': { '97TDXJ84WH': 4, 'pl.useo.rarog': 3 },
  'server/test/notify-live-activity.test.ts': { 'pl.useo.rarog': 5 },
  'server/test/notify-relay-pass.test.ts': { 'pl.useo.rarog': 1 },
  'server/test/notify-sender.test.ts': { 'pl.useo.rarog': 1 },
  'shared/fixtures/relay/pass.topic-not-allowed.json': { 'pl.useo.rarog': 1 },
  'shared/test/rest-native-routes.test.ts': { 'pl.useo.rarog': 2 },
};

/** Dokumentacja może cytować literały publiczne bez wpisu na liście. */
const isDoc = (file: string): boolean => file.endsWith('.md');

interface Hit {
  readonly line: number;
  readonly literal: Literal;
}

/** Każde wystąpienie każdego literału publicznego (bez wielkości liter), z numerem linii. */
function hitsIn(text: string): Hit[] {
  const hits: Hit[] = [];
  text.toLowerCase().split('\n').forEach((content, index) => {
    for (const literal of PUBLIC_LITERALS) {
      const needle = literal.toLowerCase();
      for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + needle.length)) {
        hits.push({ line: index + 1, literal });
      }
    }
  });
  return hits;
}

interface GuardReport {
  /** Wystąpienia ponad allow-listę: `plik:linia: „literał” …`. */
  readonly unexpected: string[];
  /** Wpisy allow-listy z liczbą większą niż w pliku (albo z plikiem, którego nie ma). */
  readonly stale: string[];
}

/** Porównuje treść plików (ścieżka względem korzenia → tekst) z allow-listą literałów publicznych. */
function checkLiterals(files: ReadonlyMap<string, string>, allowed: Allowed): GuardReport {
  const unexpected: string[] = [];
  const stale: string[] = [];
  for (const [file, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (isDoc(file)) continue;
    const hits = hitsIn(text);
    for (const literal of PUBLIC_LITERALS) {
      const lines = hits.filter((hit) => hit.literal === literal).map((hit) => hit.line);
      const limit = allowed[file]?.[literal] ?? 0;
      if (lines.length > limit) {
        const where = limit === 0 ? 'poza allow-listą' : `allow-lista pozwala na ${String(limit)}, jest ${String(lines.length)}`;
        for (const line of lines) unexpected.push(`${file}:${String(line)}: „${literal}” — ${where}`);
      } else if (lines.length < limit) {
        stale.push(`${file}: „${literal}” — allow-lista mówi ${String(limit)}, w pliku ${String(lines.length)}: skróć listę`);
      }
    }
  }
  for (const [file, counts] of Object.entries(allowed)) {
    if (files.has(file)) continue;
    for (const [literal, limit] of Object.entries(counts)) {
      stale.push(`${file}: „${literal}” — allow-lista mówi ${String(limit)}, pliku nie ma: skróć listę`);
    }
  }
  return { unexpected, stale };
}

describe('strażnik literałów publicznych: mechanizm', () => {
  /** Sample literal: one constant for the input and the expectations. */
  const TOPIC = 'pl.useo.rarog';
  const allowed: Allowed = { 'scripts/a.sh': { '97TDXJ84WH': 1 }, 'scripts/b.sh': { [TOPIC]: 2 } };

  it('nowe wystąpienie poza listą: plik, linia i literał w komunikacie', () => {
    const report = checkLiterals(new Map([
      ['scripts/a.sh', 'x\nTEAM=97TDXJ84WH\n'],
      ['scripts/b.sh', `${TOPIC} ${TOPIC}\n`],
      ['server/src/nowy.ts', `const a = 1;\nconst topic = "${TOPIC}";\n`],
    ]), allowed);
    expect(report.unexpected).toEqual([`server/src/nowy.ts:2: „${TOPIC}” — poza allow-listą`]);
    expect(report.stale).toEqual([]);
  });

  it('więcej wystąpień niż na liście w dozwolonym pliku; wielkość liter nie ma znaczenia', () => {
    const report = checkLiterals(new Map([
      ['scripts/a.sh', '97TDXJ84WH\n97tdxj84wh\n'],
      ['scripts/b.sh', `${TOPIC} ${TOPIC.toUpperCase()}\n`],
    ]), allowed);
    expect(report.unexpected).toEqual([
      'scripts/a.sh:1: „97TDXJ84WH” — allow-lista pozwala na 1, jest 2',
      'scripts/a.sh:2: „97TDXJ84WH” — allow-lista pozwala na 1, jest 2',
    ]);
  });

  it('mniej wystąpień albo brak pliku: lista do skrócenia', () => {
    const report = checkLiterals(new Map([['scripts/b.sh', `${TOPIC}\n`]]), allowed);
    expect(report.unexpected).toEqual([]);
    expect(report.stale).toEqual([
      `scripts/b.sh: „${TOPIC}” — allow-lista mówi 2, w pliku 1: skróć listę`,
      'scripts/a.sh: „97TDXJ84WH” — allow-lista mówi 1, pliku nie ma: skróć listę',
    ]);
  });

  it('dokumentacja (`*.md`) może cytować literały publiczne', () => {
    const report = checkLiterals(new Map([
      ['docs/cokolwiek.md', '97TDXJ84WH pl.useo.rarog'],
      ['native/Rarog/README.md', 'DEVELOPMENT_TEAM = 97TDXJ84WH'],
    ]), {});
    expect(report).toEqual({ unexpected: [], stale: [] });
  });
});

describe('strażnik literałów publicznych: repo', () => {
  const files = repoTextFiles(REPO, undefined, (file) => file === SELF || !inExportView(file));

  it('lista plików jest pełna (repoFiles widzi kod, skrypty i ten katalog testów)', () => {
    expect(files.has('server/src/index.ts')).toBe(true);
    expect(files.has('scripts/restart.sh')).toBe(true);
    expect(files.has('server/test/auth.test.ts')).toBe(true);
    expect(files.size).toBeGreaterThan(500);
  });

  it('literały publiczne stoją wyłącznie tam, gdzie pozwala allow-lista, w dokładnej liczbie', () => {
    const report = checkLiterals(files, ALLOWED);
    expect(report.unexpected, `Nowe wystąpienia literałów publicznych (usuń je albo dopisz do ALLOWED z powodem):\n${
      report.unexpected.join('\n')}`).toEqual([]);
    expect(report.stale, `Allow-lista do skrócenia:\n${report.stale.join('\n')}`).toEqual([]);
  });

  it('allow-lista nie wymienia dokumentacji (`*.md` jest dozwolone z reguły)', () => {
    expect(Object.keys(ALLOWED).filter(isDoc)).toEqual([]);
  });
});

describe('strażnik literałów prywatnych: zapadka (dane syntetyczne)', () => {
  it('wzrost wobec bazy: ścieżka i liczby w komunikacie, potem cała tabela do wklejenia', () => {
    const current = new Map([['server/src/a.ts', 2], ['docs/b.md', 1]]);
    const report = ratchet(current, { 'server/src/a.ts': 1, 'docs/b.md': 1 }, false);
    expect(report).toEqual({ grown: ['server/src/a.ts: 2, baza 1'], stale: [] });
    expect(ratchetMessage('repo', report, current)).toContain("WZROST server/src/a.ts: 2, baza 1\naktualna baza:\n  'docs/b.md': 1,\n  'server/src/a.ts': 2,");
  });

  it('baza za wysoka albo plik bez trafień z bazą: do obniżenia', () => {
    expect(ratchet(new Map([['a.ts', 1]]), { 'a.ts': 3, 'b.ts': 1 }, false)).toEqual({
      grown: [], stale: ['a.ts: baza 3, jest 1 — obniż', 'b.ts: baza 1, jest 0 — obniż'],
    });
  });

  it('bramka publikacji ignoruje bazę: każde trafienie to porażka', () => {
    expect(ratchet(new Map([['a.ts', 1]]), { 'a.ts': 1 }, true)).toEqual({
      grown: ['a.ts: 1 — bramka publikacji wymaga zera'], stale: [],
    });
  });

  it('klucz o nazwie pola prototypu nie dziedziczy bazy', () => {
    const current = new Map([['constructor', 1], ['toString', 1], ['__proto__', 1], ['hasOwnProperty', 1]]);
    expect(ratchet(current, {}, false).grown).toEqual([
      '__proto__: 1, baza 0', 'constructor: 1, baza 0', 'hasOwnProperty: 1, baza 0', 'toString: 1, baza 0',
    ]);
  });

  it('tabela do wklejenia: posortowana, bez zer', () => {
    expect(renderBaseline(new Map([['b.ts', 2], ['a.ts', 1], ['c.ts', 0]]))).toBe("  'a.ts': 1,\n  'b.ts': 2,");
  });
});

/**
 * Baza zapadki literałów prywatnych poza katalogami fixture'ów: zamaskowana ścieżka →
 * liczba trafień. Ścieżki i liczby nie są prywatne. Skracać wolno zawsze, podnosić tylko po zmianie pliku
 * literałów (komunikat czerwonego testu podaje gotową tabelę).
 */
const PRIVATE_BASELINE: Readonly<Record<string, number>> = {};

const PRIVATE = privateContext();

describePrivate('strażnik literałów prywatnych: repo poza fixture’ami (zapadka)', PRIVATE, (literals) => {
  const { counts, errors, files } = privateCounts(literals, (file) => !isFixture(file));

  it('skan widzi repo i czyta każdy plik', () => {
    expect(files).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
  });

  it('liczba trafień per plik nie rośnie wobec bazy, także w `*.md` (w bramce publikacji: zero)', () => {
    const report = ratchet(counts, PRIVATE_BASELINE, PRIVATE.gate);
    expect(report, ratchetMessage('repo poza fixture’ami', report, counts)).toEqual({ grown: [], stale: [] });
  });
});
