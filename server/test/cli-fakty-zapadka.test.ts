/**
 * Ban on sentences about Claude Code behavior without proof (description: `docs/distribution.md`, "What the repo
 * knows about Claude Code").
 *
 * `zdaniaBezDowodu` from `cli-bez-binarki.ts` finds text blocks with the word "CLI", a behavior verb and no proof
 * marker (a CLI version, a fixture, a docs page). No export view file (`inExportView`) may hold such a block, so the
 * rule is the same in the source repo and in the export. The script lists the places with the same code
 * (`pnpm exec tsx scripts/audit-cli-facts.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  CZASOWNIK, DOWOD, PODMIOT, blokiBezDowodu, liczbyZdan, miejsceZdania, plikiRepo, zdaniaBezDowodu,
} from './cli-bez-binarki.ts';
import { REPO, inExportView } from './private-guard.ts';

const RADA = [
  'A block about CLI behavior without proof: the word "CLI", a behavior verb and no proof marker.',
  'Add the proof at the sentence (the CLI version it was measured on, a fixture or a docs page), or cut the sentence',
  'or reword it so it no longer claims CLI behavior. Places: pnpm exec tsx scripts/audit-cli-facts.ts.',
] as const;

/** Miejsca (`od-do`) bloków bez dowodu w jednym pliku. */
const miejsca = (plik: string, tekst: string): string[] =>
  blokiBezDowodu(plik, tekst).map((blok) => `${String(blok.od)}-${String(blok.do)}`);

describe('zapadka zdań o CLI bez dowodu: heurystyka', () => {
  it('podmiot to słowo „CLI” z wielkością liter, czasownik to całe słowo z listy, po polsku i po angielsku', () => {
    expect(PODMIOT.test('CLI zapisuje plik')).toBe(true);
    expect(PODMIOT.test('cli zapisuje plik')).toBe(false);
    expect(PODMIOT.test('CLIENT zapisuje plik')).toBe(false);
    expect(CZASOWNIK.test('CLI liczy')).toBe(true);
    expect(CZASOWNIK.test('CLI przeliczy')).toBe(false);
    expect(CZASOWNIK.test('CLI zapisujemy')).toBe(false);
    for (const tekst of ['the CLI writes', 'the CLI truncates', 'the CLI takes', 'the CLI rewrites']) {
      expect(CZASOWNIK.test(tekst), tekst).toBe(true);
    }
    for (const tekst of ['the CLI overwrites', 'the CLI writer', 'the CLI took']) {
      expect(CZASOWNIK.test(tekst), tekst).toBe(false);
    }
  });

  it('dowód: wersja, fixture, docs, dokumentacja, changelog, „niezmierzone”, po polsku i po angielsku; data nie '
    + 'jest dowodem', () => {
    for (const tekst of [
      'zmierzone na 2.1.299', 'fixture `x.txt`', 'docs statusline', 'według dokumentacji', 'CHANGELOG',
      'niezmierzone', 'measured on 2.1.299', 'per the documentation', 'unmeasured',
    ]) expect(DOWOD.test(tekst), tekst).toBe(true);
    expect(DOWOD.test('pomiar 2026-10-14')).toBe(false);
    expect(DOWOD.test('wersja 2.1')).toBe(false);
    expect(DOWOD.test('measured 2026-10-14')).toBe(false);
  });

  it('dokument: akapit to jeden blok, punkt listy, nagłówek, wiersz tabeli i linia bloku kodu osobno', () => {
    const tekst = [
      'Pierwsza linia akapitu, w której CLI',
      'zapisuje plik rozmowy.',
      '',
      '- CLI rysuje dialog.',
      '- drugi punkt, CLI ucina etykietę',
      '  na dwie linie.',
      '## CLI kasuje nagłówek',
      '| CLI | liczy |',
      '```',
      'CLI szuka',
      'w kodzie',
      '```',
      'Akapit z dowodem: CLI bierze plik (zmierzone na 2.1.300).',
      '',
      'Akapit o CLI bez czasownika z listy.',
    ].join('\n');
    expect(miejsca('docs/x.md', tekst)).toEqual(['1-2', '4-4', '5-6', '7-7', '8-8', '10-10']);
  });

  it('blok kodu zamyka znacznik z tego samego znaku, nie krótszy i bez dopisku; ``` w bloku ```` to treść', () => {
    const tekst = [
      '````text',
      '```',
      'CLI',
      'zapisuje',
      '```',
      '````',
      '~~~',
      '```',
      'CLI kasuje',
      '~~~',
      'CLI',
      'zapisuje w akapicie.',
    ].join('\n');
    expect(miejsca('docs/x.md', tekst)).toEqual(['9-9', '11-12']);
  });

  it('kod: ciąg komentarzy to jeden blok, pusta linia komentarza dzieli, linia kodu osobno', () => {
    const tekst = [
      '/**',
      ' * Opis, w którym CLI',
      ' * zamienia klawisz.',
      ' *',
      ' * Osobny akapit: CLI kasuje plik (docs settings).',
      ' */',
      'const a = 1;',
      '// CLI przepisuje',
      '// linię.',
      "it('CLI liczy zakładki', () => {});",
      'const b = 2; // CLI bez czasownika',
      '/* CLI rysuje w jednej linii */',
    ].join('\n');
    expect(miejsca('server/src/x.ts', tekst)).toEqual(['2-3', '8-9', '10-10', '12-12']);
    expect(miejsca('native/X.swift', '/// CLI zapisuje\nlet x = 1')).toEqual(['1-1']);
  });

  it('`#` jest komentarzem tylko w skrypcie powłoki; dane i inne rozszerzenia nie liczą się', () => {
    const tekst = '#!/bin/bash\n# CLI zapisuje\n# plik\necho ok';
    expect(miejsca('scripts/x.sh', tekst)).toEqual(['2-3']);
    expect(miejsca('scripts/x.mjs', '# CLI zapisuje')).toEqual(['1-1']);
    expect(miejsca('server/test/fixtures/x.json', '{"a": "CLI zapisuje"}')).toEqual([]);
    expect(miejsca('server/test/fixtures/x.txt', 'CLI zapisuje')).toEqual([]);
  });

  it('zakres: pliki spoza katalogów strażnika i pliki mechanizmu odpadają; wynik po pliku i linii', () => {
    const pliki = new Map([
      ['server/src/b.ts', '// CLI liczy\n\n// CLI rysuje'],
      ['docs/a.md', 'CLI zapisuje.'],
      ['.github/x.md', 'CLI zapisuje.'],
      ['server/test/cli-fakty-zapadka.test.ts', '// CLI zapisuje'],
      ['scripts/audit-cli-facts.ts', '// CLI zapisuje'],
    ]);
    const zdania = zdaniaBezDowodu(pliki);
    expect(zdania.map(miejsceZdania)).toEqual(['docs/a.md:1', 'server/src/b.ts:1', 'server/src/b.ts:3']);
    expect([...liczbyZdan(zdania)]).toEqual([['docs/a.md', 1], ['server/src/b.ts', 2]]);
    expect(miejsceZdania({ plik: 'docs/a.md', od: 3, do: 5, tekst: '' })).toBe('docs/a.md:3-5');
  });
});

describe('zapadka zdań o CLI bez dowodu: repo', () => {
  const pliki = plikiRepo(REPO, inExportView);
  /** Places (`file:from-to`) of blocks without proof. */
  const bezDowodu = (mapa: ReadonlyMap<string, string>): string[] => zdaniaBezDowodu(mapa).map(miejsceZdania);

  it('no export view file holds a block about CLI behavior without proof', () => {
    const miejscaRepo = bezDowodu(pliki);
    expect(miejscaRepo, [...RADA, ...miejscaRepo].join('\n')).toEqual([]);
  });

  it('mutation trips the ban: a sentence about the CLI without proof in Polish and in English, in a document and '
    + 'in a comment; with proof it does not', () => {
    const dopisz = (plik: string, dopisek: string): string[] => {
      const mapa = new Map(pliki);
      mapa.set(plik, `${pliki.get(plik)!}\n\n${dopisek}\n`);
      return bezDowodu(mapa);
    };
    const dokument = 'docs/dialogs.md';
    const kod = 'server/src/herdr/jsonl-follow.ts';
    expect(dopisz(dokument, 'CLI ucina etykietę opcji do jednej linii.')).toEqual([expect.stringMatching(/^docs\/dialogs\.md:/u)]);
    expect(dopisz(dokument, 'The CLI truncates the option label to one line.'))
      .toEqual([expect.stringMatching(/^docs\/dialogs\.md:/u)]);
    expect(dopisz(kod, '// The CLI writes the transcript line after the tool result.'))
      .toEqual([expect.stringMatching(/^server\/src\/herdr\/jsonl-follow\.ts:/u)]);
    expect(dopisz(dokument, 'The CLI truncates the option label to one line (measured on 2.1.300).')).toEqual([]);
    expect(dopisz(dokument, 'The CLI truncates the option label to one line (unmeasured).')).toEqual([]);
    expect(dopisz(kod, '// CLI zapisuje linię transkryptu (zmierzone na 2.1.300).')).toEqual([]);
  });
});
