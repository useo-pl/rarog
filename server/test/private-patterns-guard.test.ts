/**
 * Strażnik wzorców strukturalnych danych prywatnych (opis: `docs/publishing.md`, „What protects whom”).
 *
 * Wzorce łapią KLASĘ danych, nie konkretną nazwę, więc mieszkają w repo i działają zawsze, także w publicznym CI
 * bez pliku prywatnych literałów: adres e-mail poza domenami przykładowymi, nazwa tailnetu w sufiksie MagicDNS,
 * katalog domowy z loginem spoza zamkniętej listy syntetycznych, katalog tymczasowy macOS, identyfikator API
 * o długości prawdziwego, baner planu konta i licznik limitu, numer zgłoszenia z trackera, goły skrót commita
 * w dokumencie i `git show` na skrócie (odsyłacz do historii, której eksport nie ma).
 *
 * Wyjątki z powodem (`STRUCTURAL_EXCEPTIONS` w `scripts/lib/private-patterns.mjs`, te same w bramce publikacji)
 * zdejmują trafienia jednego wzorca w liniach z fragmentem; wyjątek bez trafienia jest czerwony.
 *
 * Zapadka: liczba trafień per plik i wzorzec nie rośnie wobec {@link BASELINE}; za wysoka baza też jest czerwona.
 * Liczy tylko pliki widoku eksportu (`inExportView` z `private-guard.ts`), więc baza jest ta sama w eksporcie.
 * W bramce publikacji (`PUBLISH_GATE_ENV` z `scripts/lib/private-literals.mjs`) baza nie obowiązuje: zero. Każdy
 * porządek obniża tabelę, aż do zera. Komunikat czerwonego testu podaje gotową tabelę. Ten plik
 * jest pominięty: niesie syntetyczne próbki. Same wzorce stoją w `scripts/lib/private-patterns.mjs`, bo tę samą definicję stosuje
 * anonimizator fixture'ów `scripts/anonymize-fixture.ts`.
 */
import { describe, expect, it } from 'vitest';
import { publishGate } from '../../scripts/lib/private-literals.mjs';
import {
  PATTERN_SAMPLES_FILE, STRUCTURAL_EXCEPTIONS, STRUCTURAL_PATTERNS, structuralHits,
  type StructuralException,
} from '../../scripts/lib/private-patterns.mjs';
import { REPO, inExportView, ratchet, ratchetMessage } from './private-guard.ts';
import { repoTextFiles } from './source-scan.ts';

const SELF = PATTERN_SAMPLES_FILE;

interface Policzone {
  counts: Map<string, number>;
  miejsca: string[];
  /** Wyjątki, które zdjęły choć jedno trafienie. */
  used: Set<StructuralException>;
}

/** Trafienia per `plik [wzorzec]` i miejsca (`plik:linia [wzorzec]`) do komunikatu, poza wyjątkami. */
function policz(
  files: ReadonlyMap<string, string>, exceptions: readonly StructuralException[] = STRUCTURAL_EXCEPTIONS,
): Policzone {
  const counts = new Map<string, number>();
  const miejsca: string[] = [];
  const used = new Set<StructuralException>();
  for (const [file, text] of files) {
    for (const hit of structuralHits(text, file, { exceptions, used })) {
      const key = `${file} [${hit.name}]`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      miejsca.push(`${file}:${String(hit.line)} [${hit.name}]`);
    }
  }
  return { counts, miejsca, used };
}

const jeden = (text: string, file = 'docs/a.md'): string[] => [...policz(new Map([[file, text]])).counts.keys()]
  .map((key) => key.replace(/^.* \[(.*)\]$/, '$1'));

describe('wzorce strukturalne: mechanizm (dane syntetyczne)', () => {
  it('e-mail: przykładowe domeny, claude.ai i domena produktu przechodzą, inne nie', () => {
    expect(jeden('jan@example.com u@example.invalid a@sub.example.org x@claude.ai push@push.rarog.ai')).toEqual([]);
    expect(jeden('kontakt: jan.kowalski@firma.test')).toEqual(['e-mail']);
  });

  it('tailnet: tylko example i demo', () => {
    expect(jeden('mac.example.ts.net i serwer.demo.ts.net')).toEqual([]);
    expect(jeden('https://mac.tail1234.ts.net/')).toEqual(['tailnet']);
  });

  it('katalog domowy: zamknięta lista loginów syntetycznych; katalog projektu Claude Code też', () => {
    expect(jeden('/Users/u/Projects/atlas /Users/demo/x /Users/<login>/y -Users-u-Projects-')).toEqual([]);
    expect(jeden('/Users/jan/Projects')).toEqual(['katalog-domowy']);
    expect(jeden('~/.claude/projects/-Users-jan-Projects-atlas/')).toEqual(['katalog-domowy']);
  });

  it('katalog tymczasowy macOS, identyfikator API, plan konta, licznik limitu', () => {
    expect(jeden('/var/folders/aa/bb/T/x')).toEqual(['katalog-tymczasowy']);
    expect(jeden(`toolu_01${'Q'.repeat(22)}`)).toEqual(['identyfikator-api']);
    expect(jeden('toolu_01abc i msg_test_1')).toEqual([]);
    expect(jeden('baner: Claude Max')).toEqual(['plan-konta']);
    expect(jeden('baner: Claude Ultra')).toEqual(['plan-konta']);
    expect(jeden('pasek 5h: 42%')).toEqual(['licznik-limitu']);
  });

  it('numer zgłoszenia: publiczne prefiksy przechodzą', () => {
    expect(jeden('SHA-256, ITMS-90683, SE-0423, WWDC25-323')).toEqual([]);
    expect(jeden('gałąź feature/ABC-1234')).toEqual(['zgloszenie']);
  });

  it('goły skrót commita: tylko w `*.md`, poza blokiem kodu i linią sumy kontrolnej', () => {
    const md = ['patrz 1a2b3c4d', '```', 'dane 9f8e7d6c5b', '```', 'sha256: 0a1b2c3d4e5f6a7b', '#a1b2c3d4 kolor'].join('\n');
    expect(policz(new Map([['docs/a.md', md]])).miejsca).toEqual(['docs/a.md:1 [skrot-commita]']);
    expect(jeden('const id = "1a2b3c4d";', 'server/src/a.ts')).toEqual([]);
    expect(jeden('decyzja facade i liczba 1234567')).toEqual([]);
  });

  it('git show na skrócie w każdym pliku', () => {
    expect(jeden('`git show 1a2b3c4:plik`', 'server/test/a.test.ts')).toEqual(['git-show']);
    expect(jeden('git show HEAD:plik')).toEqual([]);
  });

  it('wyjątek zdejmuje tylko swój wzorzec, w swoim pliku i w liniach z fragmentem', () => {
    const wyjatek: StructuralException = {
      plik: 'src/a.swift', wzorzec: 'katalog-tymczasowy', fragment: 'folders/aa/', powod: 'dane testu',
    };
    const tekst = ['/var/folders/aa/bb/T/x', '/var/folders/cc/dd/T/x', '/var/folders/aa/bb/T jan@firma.test'].join('\n');
    const { miejsca, used } = policz(new Map([['src/a.swift', tekst], ['src/b.swift', tekst]]), [wyjatek]);
    expect(miejsca).toEqual([
      'src/a.swift:2 [katalog-tymczasowy]', 'src/a.swift:3 [e-mail]',
      'src/b.swift:1 [katalog-tymczasowy]', 'src/b.swift:2 [katalog-tymczasowy]', 'src/b.swift:3 [e-mail]',
      'src/b.swift:3 [katalog-tymczasowy]',
    ]);
    expect([...used]).toEqual([wyjatek]);
    // Katalog z `/` na końcu obejmuje pliki pod nim; wyjątek bez trafienia nie trafia do `used`.
    const katalog = { ...wyjatek, plik: 'src/' };
    expect(policz(new Map([['src/b.swift', '/var/folders/aa/x']]), [katalog]).miejsca).toEqual([]);
    expect(policz(new Map([['src/b.swift', 'nic']]), [katalog]).used.size).toBe(0);
  });

  it('wyjątek zdejmuje jedno trafienie na wystąpienie fragmentu: drugie trafienie w tej samej linii zostaje', () => {
    const wyjatek: StructuralException = {
      plik: 'src/a.swift', wzorzec: 'katalog-tymczasowy', fragment: 'folders/aa/', powod: 'dane testu',
    };
    const jedna = '/var/folders/aa/bb/T/x /var/folders/zz/qwerty123/T/y';
    expect(policz(new Map([['src/a.swift', jedna]]), [wyjatek]).miejsca).toEqual(['src/a.swift:1 [katalog-tymczasowy]']);
    // Dwa wystąpienia fragmentu zdejmują oba trafienia.
    const obie = '/var/folders/aa/bb/T/x /var/folders/aa/cc/T/y';
    expect(policz(new Map([['src/a.swift', obie]]), [wyjatek]).miejsca).toEqual([]);
  });
});

describe('wyjątki wzorców strukturalnych (`STRUCTURAL_EXCEPTIONS`)', () => {
  const nazwy = new Set(STRUCTURAL_PATTERNS.map((pattern) => pattern.name));

  it('każdy wpis: znany wzorzec, niepusty fragment i powód, fragment sam nie trafia we wzorzec', () => {
    for (const w of STRUCTURAL_EXCEPTIONS) {
      expect(nazwy.has(w.wzorzec), `${w.plik}: wzorzec ${w.wzorzec}`).toBe(true);
      expect(w.fragment.trim(), w.plik).not.toBe('');
      expect(w.powod.trim(), w.plik).not.toBe('');
      expect(structuralHits(w.fragment, 'scripts/lib/private-patterns.mjs', { exceptions: [] }), w.fragment)
        .toEqual([]);
    }
  });
});

/**
 * Baza zapadki: `plik [wzorzec]` → liczba trafień. Ścieżki i liczby nie
 * są prywatne. Skracać wolno zawsze; podnosić nie wolno (nowe trafienie: podmień wartość na syntetyczną).
 */
const BASELINE: Readonly<Record<string, number>> = {};

describe('wzorce strukturalne: repo (zapadka)', () => {
  const files = repoTextFiles(REPO, undefined, (file) => file === SELF || !inExportView(file));
  const { counts, miejsca, used } = policz(files);

  it('lista plików jest pełna', () => {
    expect(files.has('docs/architecture.md')).toBe(true);
    expect(files.size).toBeGreaterThan(1000);
  });

  it('liczba trafień per plik i wzorzec nie rośnie wobec bazy (w bramce publikacji: zero)', () => {
    const report = ratchet(counts, BASELINE, publishGate());
    const grownFiles = new Set(report.grown.map((line) => line.replace(/ \[.*$/, '')));
    const where = miejsca.filter((miejsce) => grownFiles.has(miejsce.replace(/:\d+ \[.*$/, '')));
    expect(report, `${ratchetMessage('wzorce strukturalne', report, counts)}\nmiejsca wzrostu:\n${where.join('\n')}`)
      .toEqual({ grown: [], stale: [] });
  });

  it('każdy wyjątek zdejmuje choć jedno trafienie (martwy wpis do usunięcia)', () => {
    const martwe = STRUCTURAL_EXCEPTIONS.filter((w) => !used.has(w))
      .map((w) => `${w.plik} [${w.wzorzec}] „${w.fragment}”`);
    expect(martwe, 'wyjątek bez trafienia: usuń wpis z STRUCTURAL_EXCEPTIONS').toEqual([]);
  });
});
