/*
 * `scripts/sekcja.mjs` — jedna sekcja dokumentu Markdown jedną komendą:
 * `node scripts/sekcja.mjs <plik> "<nagłówek>"` wypisuje sekcję do następnego nagłówka tego samego albo wyższego
 * poziomu, `--spis` wypisuje nagłówki z numerem linii i rozmiarem sekcji w znakach. Nagłówek bez dopisku w nawiasie
 * trafia, gdy jest jednoznaczny; kilka pasujących nagłówków daje listę do wyboru i kod 1; plik spoza repo albo nie
 * `.md` to odmowa (kod 2). Linie w blokach kodu (``` i ````) nie są nagłówkami.
 *
 * Przypadek z prawdziwym dokumentem (`docs/dialogs.md`, „Module map”) idzie przez `node`, jak woła go agent; reszta
 * przez `main` z korzeniem w katalogu tymczasowym, żeby dokument testowy nie zależał od treści `docs/`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO, 'scripts', 'sekcja.mjs');

interface Heading { line: number; level: number; text: string; end: number; chars: number }
interface Io { cwd?: string; root?: string; stdout?: (text: string) => void; stderr?: (text: string) => void }
interface Module {
  headings: (text: string) => Heading[];
  main: (argv: string[], io?: Io) => number;
}
const sekcja = await import(pathToFileURL(SCRIPT).href) as Module;

const temporary: string[] = [];
afterAll(() => {
  for (const made of temporary.splice(0)) rmSync(made, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'rarog-sekcja-')));
  temporary.push(dir);
  return dir;
};

/** `main` z korzeniem `root`; zwraca kod i oba strumienie. */
const run = (root: string, argv: string[], cwd = root) => {
  let stdout = '';
  let stderr = '';
  const code = sekcja.main(argv, {
    root, cwd, stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr };
};

const DOC = [
  '# Title',                        // 1
  '',                               // 2
  'Intro.',                         // 3
  '',                               // 4
  '## Alpha',                       // 5
  '',                               // 6
  'Alpha text.',                    // 7
  '',                               // 8
  '```bash',                        // 9
  '# not a heading in a fence',     // 10
  '```',                            // 11
  '',                               // 12
  '### Alpha detail',               // 13
  '',                               // 14
  'Detail text.',                   // 15
  '',                               // 16
  '## Block card (flag `X`)',       // 17
  '',                               // 18
  '````markdown',                   // 19
  '```',                            // 20
  '## also not a heading',          // 21
  '```',                            // 22
  '````',                           // 23
  '',                               // 24
  '### Tests',                      // 25
  '',                               // 26
  'First tests.',                   // 27
  '',                               // 28
  '## Beta',                        // 29
  '',                               // 30
  '### Tests',                      // 31
  '',                               // 32
  'Second tests.',                  // 33
  '',                               // 34
  '## Gamma (one)',                 // 35
  '',                               // 36
  '## Gamma (two)',                 // 37
  '',                               // 38
  'End.',                           // 39
  '',
].join('\n');

const docRoot = () => {
  const root = tempDir();
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs', 'doc.md'), DOC);
  return root;
};

describe('sekcja: prawdziwy dokument', () => {
  it('docs/dialogs.md "Module map" → sama sekcja do następnego nagłówka tego samego albo wyższego poziomu', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'docs/dialogs.md', 'Module map'], {
      cwd: REPO, encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const text = readFileSync(path.join(REPO, 'docs', 'dialogs.md'), 'utf8');
    const start = text.indexOf('\n## Module map\n') + 1;
    expect(start).toBeGreaterThan(0);
    const next = text.slice(start + 1).search(/\n#{1,2} /);
    expect(next).toBeGreaterThan(0);
    const expected = text.slice(start, start + 1 + next).trimEnd();
    expect(result.stdout).toBe(`${expected}\n`);
    expect(result.stdout.startsWith('## Module map\n')).toBe(true);
  });

  it('ścieżka względem katalogu bieżącego', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'dialogs.md', 'Module map'], {
      cwd: path.join(REPO, 'docs'), encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.startsWith('## Module map\n')).toBe(true);
  });
});

describe('sekcja: wybór nagłówka', () => {
  it('sekcja obejmuje podsekcje i kończy się na nagłówku tego samego poziomu; nagłówek w bloku kodu nie przerywa', () => {
    const { code, stdout } = run(docRoot(), ['docs/doc.md', 'Alpha']);
    expect(code).toBe(0);
    expect(stdout).toBe([
      '## Alpha', '', 'Alpha text.', '', '```bash', '# not a heading in a fence', '```', '',
      '### Alpha detail', '', 'Detail text.', '',
    ].join('\n'));
  });

  it('sekcja niższego poziomu kończy się na nagłówku wyższego poziomu', () => {
    const { code, stdout } = run(docRoot(), ['docs/doc.md', 'Alpha detail']);
    expect(code).toBe(0);
    expect(stdout).toBe('### Alpha detail\n\nDetail text.\n');
  });

  it('nagłówek bez dopisku w nawiasie trafia, gdy jest jednoznaczny; blok ```` z ``` w środku to nadal kod', () => {
    const { code, stdout } = run(docRoot(), ['docs/doc.md', 'Block card']);
    expect(code).toBe(0);
    expect(stdout).toBe([
      '## Block card (flag `X`)', '', '````markdown', '```', '## also not a heading', '```', '````', '',
      '### Tests', '', 'First tests.', '',
    ].join('\n'));
  });

  it('pełny tekst nagłówka i tekst z znakami # też trafiają, wielkość liter bez znaczenia', () => {
    const root = docRoot();
    expect(run(root, ['docs/doc.md', 'Block card (flag `X`)']).code).toBe(0);
    expect(run(root, ['docs/doc.md', '## beta']).stdout.startsWith('## Beta\n')).toBe(true);
  });

  it('dwa pasujące nagłówki → lista do wyboru z numerami linii i kod 1', () => {
    const { code, stdout, stderr } = run(docRoot(), ['docs/doc.md', 'Tests']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('25: ### Tests');
    expect(stderr).toContain('31: ### Tests');
  });

  it('dwa nagłówki różne tylko dopiskiem w nawiasie → lista i kod 1; pełny tekst rozstrzyga', () => {
    const root = docRoot();
    const ambiguous = run(root, ['docs/doc.md', 'Gamma']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain('35: ## Gamma (one)');
    expect(ambiguous.stderr).toContain('37: ## Gamma (two)');
    const exact = run(root, ['docs/doc.md', 'Gamma (two)']);
    expect(exact.code).toBe(0);
    expect(exact.stdout).toBe('## Gamma (two)\n\nEnd.\n');
  });

  it('numer linii z listy wybiera nagłówek', () => {
    const { code, stdout } = run(docRoot(), ['docs/doc.md', '31']);
    expect(code).toBe(0);
    expect(stdout).toBe('### Tests\n\nSecond tests.\n');
  });

  it('brak nagłówka → komunikat z komendą spisu i kod 1', () => {
    const { code, stdout, stderr } = run(docRoot(), ['docs/doc.md', 'Delta']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('--spis');
  });
});

describe('sekcja: --spis', () => {
  it('każdy nagłówek z numerem linii i rozmiarem sekcji w znakach; linie w blokach kodu pominięte', () => {
    const root = docRoot();
    const { code, stdout } = run(root, ['docs/doc.md', '--spis']);
    expect(code).toBe(0);
    const lines = DOC.split('\n');
    const size = (from: number, to: number) => [...lines.slice(from - 1, to - 1).join('\n').trimEnd()].length;
    expect(stdout).toBe([
      ` 1: # Title (${size(1, 41)} chars)`,
      ` 5: ## Alpha (${size(5, 17)} chars)`,
      `13: ### Alpha detail (${size(13, 17)} chars)`,
      `17: ## Block card (flag \`X\`) (${size(17, 29)} chars)`,
      `25: ### Tests (${size(25, 29)} chars)`,
      `29: ## Beta (${size(29, 35)} chars)`,
      `31: ### Tests (${size(31, 35)} chars)`,
      `35: ## Gamma (one) (${size(35, 37)} chars)`,
      `37: ## Gamma (two) (${size(37, 41)} chars)`,
      '',
    ].join('\n'));
    expect(sekcja.headings(DOC).map((h) => h.line)).toEqual([1, 5, 13, 17, 25, 29, 31, 35, 37]);
  });

  it('rozmiar liczy znaki, nie bajty', () => {
    const root = tempDir();
    writeFileSync(path.join(root, 'pl.md'), '# Zażółć\n\nżółw\n');
    expect(run(root, ['pl.md', '--spis']).stdout).toBe(`1: # Zażółć (${'# Zażółć\n\nżółw'.length} chars)\n`);
  });
});

describe('sekcja: odmowy', () => {
  it('plik spoza repo → odmowa, kod 2', () => {
    const outside = tempDir();
    const file = path.join(outside, 'outside.md');
    writeFileSync(file, '# Outside\n');
    const result = spawnSync(process.execPath, [SCRIPT, file, 'Outside'], { cwd: REPO, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('outside the repository');
  });

  it('dowiązanie w repo do pliku spoza repo → odmowa', () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(path.join(outside, 'outside.md'), '# Outside\n');
    symlinkSync(path.join(outside, 'outside.md'), path.join(root, 'link.md'));
    const { code, stderr } = run(root, ['link.md', 'Outside']);
    expect(code).toBe(2);
    expect(stderr).toContain('outside the repository');
  });

  it('plik nie .md → odmowa, kod 2', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'package.json', '--spis'], { cwd: REPO, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('.md');
  });

  it('brak pliku albo argumentów → kod 2', () => {
    const root = docRoot();
    expect(run(root, ['docs/missing.md', '--spis']).code).toBe(2);
    expect(run(root, []).code).toBe(2);
    expect(run(root, ['docs/doc.md']).code).toBe(2);
  });
});
