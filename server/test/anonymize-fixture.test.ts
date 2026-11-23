/**
 * Końcowy przebieg anonimizacji fixture'ów `scripts/anonymize-fixture.ts` i jego obietnica fail closed:
 * bez pliku prywatnych literałów odmawia zapisu (kod 2, żadnego pliku).
 * Dane syntetyczne: nazwy klientów z `fixtures/literaly-syntetyczne.json`, ścieżki i loginy zmyślone.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPrivateLiterals, type PrivateLiterals } from '../../scripts/lib/private-literals.mjs';
import { structuralHits } from '../../scripts/lib/private-patterns.mjs';
import { SYNTHETIC_LITERALS_FILE, literalsEnv } from './synthetic-literals.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Moduł spod `scripts/` ładujemy importem dynamicznym po ścieżce (nie należy do projektu `server`). */
interface AnonymizeContext {
  tool: string; literals: PrivateLiterals; home: string; roots: readonly string[]; ids: Map<string, string>;
}
interface Anonymizer {
  ANONYMIZER_VERSION: number;
  CHECKOUT: string;
  PLACEHOLDER_MIGRATIONS: Readonly<Record<number, readonly (readonly [string, string])[]>>;
  migratePlaceholders: (text: string, from?: number) => string;
  FixtureRefused: new (message: string) => Error;
  anonymizeText: (text: string, ctx: AnonymizeContext) => string;
  checkoutRoots: (repo: string) => string[];
  finalizeFixture: (text: string, ctx: AnonymizeContext, file?: string) => string;
  fixtureContext: (tool: string, env: NodeJS.ProcessEnv) => AnonymizeContext;
}
const {
  ANONYMIZER_VERSION, CHECKOUT, FixtureRefused, PLACEHOLDER_MIGRATIONS, anonymizeText, checkoutRoots, finalizeFixture,
  fixtureContext, migratePlaceholders,
} = await import(pathToFileURL(path.join(repoRoot, 'scripts/anonymize-fixture.ts')).href) as Anonymizer;
const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rarog-anonimizator-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function findTsx(): string {
  let dir = repoRoot;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('brak node_modules/.bin/tsx');
}

// Próbki składane z kawałków: dosłowne trafienie wzorca strukturalnego w źródle podniosłoby zapadkę strażnika
// (`private-patterns-guard.test.ts`) dla tego pliku.
const USERS = ['', 'Users'].join('/');
const HOME = `${USERS}/jan`;
const MAIN = `${HOME}/Projekty/firma-x/rarog`;
const SLUG = (login: string): string => `-${'Users'}-${login}-`;
const TMP = `/var/${'folders'}`;
const PLAN = (name: string): string => `Claude ${name}`;
const LIMIT = (value: string): string => `5h:${value}`;
const WORKTREE = `${MAIN}/.claude/worktrees/w1`;

function context(): AnonymizeContext {
  const literals = loadPrivateLiterals({ file: SYNTHETIC_LITERALS_FILE });
  if (literals === null) throw new Error('brak syntetycznego pliku literałów');
  return { tool: 'test', literals, home: HOME, roots: checkoutRoots(WORKTREE), ids: new Map() };
}

describe('reguły przebiegu (dane syntetyczne)', () => {
  it('korzeń checkoutu w każdej formie → jeden korzeń bez nazwy wydawcy', () => {
    expect(checkoutRoots(WORKTREE)).toEqual([WORKTREE, MAIN]);
    expect(checkoutRoots(MAIN)).toEqual([MAIN]);
    const text = [`${MAIN}/docs`, `${WORKTREE}/server`, '/Users/u/Projekty/firma-x/rarog/x', '~/Projekty/firma-x/rarog',
      `${SLUG('jan')}Projekty-firma-x-rarog/1.jsonl`].join('\n');
    expect(anonymizeText(text, context()).split('\n')).toEqual([`${CHECKOUT}/docs`, `${CHECKOUT}/server`, `${CHECKOUT}/x`,
      '~/Projects/rarog', '-Users-u-Projects-rarog/1.jsonl']);
  });

  it('zastępniki wersji 1 → bieżące w każdej formie, z zachowaniem długości; drugi przebieg niczego nie zmienia', () => {
    expect(ANONYMIZER_VERSION).toBe(2);
    const pairs = PLACEHOLDER_MIGRATIONS[1] ?? [];
    expect(pairs.map(([, to]) => to)).toEqual([CHECKOUT, '-Users-u-Projects-rarog', '~/Projects/rarog']);
    for (const [from, to] of pairs) {
      expect(to.length, from).toBe(from.length);
      const text = `a ${from}/x "${from}" ${from}--claude-worktrees-w1`;
      const once = anonymizeText(text, context());
      expect(once).toBe(`a ${to}/x "${to}" ${to}--claude-worktrees-w1`);
      expect(anonymizeText(once, context())).toBe(once);
      expect(migratePlaceholders(once)).toBe(once);
      expect(migratePlaceholders(text, ANONYMIZER_VERSION)).toBe(text);
    }
  });

  it('katalog domowy i login spoza listy syntetycznych → `/Users/u`; syntetyczny zostaje', () => {
    expect(anonymizeText(`${HOME}/a ${USERS}/ewa/b ${SLUG('ewa')}c /Users/demo/d`, context()))
      .toBe('/Users/u/a /Users/u/b -Users-u-c /Users/demo/d');
  });

  it('pseudonimy z pliku literałów, bez wielkości liter', () => {
    expect(anonymizeText('plugin Acmepol:raport i zmyslonyogrod', context())).toBe('plugin alfa:raport i gamma');
  });

  it('katalog tymczasowy i numer użytkownika: zastępniki tej samej długości', () => {
    const tmp = `/private${TMP}/3m/abc123def/T/probe.xY`;
    const out = anonymizeText(tmp, context());
    expect(out).toBe('/private/tmp/folders/xx/xxxxxxxxx/T/probe.xY');
    expect(out.length).toBe(tmp.length);
    expect(anonymizeText('/private/tmp/claude-501/x /tmp/claude-77/y', context()))
      .toBe('/private/tmp/claude-uid/x /tmp/claude-uid/y');
  });

  it('katalog tymczasowy bez końcowego ukośnika nie zjada sąsiedniego pola JSON', () => {
    const json = JSON.stringify({ path: `${TMP}/aa/b_1`, next: '/tmp/file', cwd: `${TMP}/cc/dd/T/x` });
    const out = anonymizeText(json, context());
    expect(JSON.parse(out)).toEqual({ path: '/tmp/folders/xx/xxx', next: '/tmp/file', cwd: '/tmp/folders/xx/xx/T/x' });
    expect(out.length).toBe(json.length);
  });

  it('identyfikatory API: numeracja tej samej długości, spójna w procesie, poza wzorcem strażnika', () => {
    const ctx = context();
    const a = `toolu_01${'A'.repeat(22)}`;
    const b = `toolu_01${'B'.repeat(22)}`;
    const m = `msg_01${'C'.repeat(22)}`;
    const out = anonymizeText(`${a} ${b} ${a} ${m}`, ctx).split(' ');
    expect(out).toEqual([`toolu_${'0'.repeat(23)}1`, `toolu_${'0'.repeat(23)}2`, `toolu_${'0'.repeat(23)}1`, `msg_${'0'.repeat(23)}1`]);
    expect(out[0]?.length).toBe(a.length);
    expect(structuralHits(out.join('\n'))).toEqual([]);
    expect(anonymizeText(a, ctx)).toBe(out[0]);
  });

  it('UUID losowe → numeracja; v5 i zastępniki wyciągów zostają', () => {
    const v4 = '3f2b8c1a-9d4e-4c7a-8b1f-0e6d5a4c3b2a';
    const v5 = '7d2dd80f-012c-5c17-b97d-cf436a305158';
    const synthetic = '00000000-0000-4000-8000-000000000001';
    expect(anonymizeText(`${v4} ${v5} ${synthetic} ${v4}`, context()))
      .toBe(`00000000-0000-4000-9000-000000000001 ${v5} ${synthetic} 00000000-0000-4000-9000-000000000001`);
  });

  it('baner planu konta, licznik limitu, e-mail, tailnet', () => {
    const sample = `Sonnet 5 · ${PLAN('Max')} · ${LIMIT('42%')} · jan@${'firma.test'} · mac.tail1234.${'ts.net'} · u@example.com`;
    expect(anonymizeText(sample, context()))
      .toBe('Sonnet 5 · Claude Plan · 5h:--% · u@example.com · mac.example.ts.net · u@example.com');
    expect(anonymizeText(`Sonnet 5.5 with medium effort · ${PLAN('Ultra')}`, context()))
      .toBe('Sonnet 5.5 with medium effort · Claude Plan');
  });

  it('przebieg jest idempotentny (fixture po przebiegu to punkt stały)', () => {
    const text = `${MAIN}/a ${USERS}/ewa/b acmepol ${TMP}/aa/bb/T/ toolu_01${'Z'.repeat(22)} ${PLAN('Pro')} ${LIMIT(' 7%')}`;
    const once = anonymizeText(text, context());
    expect(anonymizeText(once, context())).toBe(once);
  });
});

describe('sprawdzian po przebiegu i fail closed', () => {
  it('literał bez zastępnika w `pseudonyms` zostaje → odmowa z odnośnikiem, bez treści', () => {
    const base = context();
    const ctx = { ...base, literals: { ...base.literals, pseudonyms: [] } };
    let message = '';
    try {
      finalizeFixture('linia\nplugin acmepol', ctx);
    } catch (error) {
      expect(error).toBeInstanceOf(FixtureRefused);
      message = (error as Error).message;
    }
    expect(message).toContain('line 2: forbidden[0] (klient)');
    expect(message).not.toContain('acmepol');
  });

  it('bez pliku albo z zepsutym: odmowa', () => {
    const dir = tempDir();
    const broken = path.join(dir, 'zepsuty.json');
    writeFileSync(broken, JSON.stringify({ version: 1, forbidden: ['x'] }));
    expect(() => fixtureContext('t', literalsEnv(path.join(dir, 'nie-ma.json')))).toThrow(/no private literals file/);
    expect(() => fixtureContext('t', literalsEnv(broken))).toThrow(FixtureRefused);
  });

  it('CLI: `--require`, filtr `--out` i zapis w miejscu (odmowa jednego pliku = żaden nie zmieniony)', () => {
    const dir = tempDir();
    const run = (args: string[], input = '', literals?: string) => spawnSync(findTsx(), ['scripts/anonymize-fixture.ts', ...args],
      { cwd: repoRoot, encoding: 'utf8', input, env: literalsEnv(literals) });
    expect(run(['--require']).status).toBe(0);
    const missing = run(['--require'], '', path.join(dir, 'nie-ma.json'));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('no private literals file');
    const out = path.join(dir, 'zrzut.txt');
    expect(run(['--out', out], `baner · ${PLAN('Max')}\nacmepol\n`).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('baner · Claude Plan\nalfa\n');
    const good = path.join(dir, 'dobry.txt');
    const bad = path.join(dir, 'zly.txt');
    writeFileSync(good, `${PLAN('Max')}\n`);
    writeFileSync(bad, 'zostaje: bez-zastepnika\n');
    const literals = path.join(dir, 'literaly.json');
    writeFileSync(literals, JSON.stringify({ version: 2, forbidden: [{ literal: 'bez-zastepnika', category: 'klient' }] }));
    const refused = run([good, bad], '', literals);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('forbidden[0] (klient)');
    expect(refused.stderr).not.toContain('bez-zastepnika');
    expect(readFileSync(good, 'utf8')).toBe(`${PLAN('Max')}\n`);
  });
});
