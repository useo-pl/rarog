/**
 * Plik prywatnych literałów i skaner (`scripts/lib/private-literals.mjs`, `scripts/lib/private-scan.mjs`; opis:
 * `docs/publishing.md`). Dane są SYNTETYCZNE: literały to zmyślone napisy-wartowniki, a każdy komunikat błędu
 * i każdy wynik skanera sprawdzamy także na to, że wartownika NIE zawiera (komunikat idzie do terminala, logu
 * testów i raportu bramki).
 *
 * Na końcu strażnik nazw w podprocesie vitest z pustym `HOME`: bez pliku pomija się z komunikatem, a z
 * `RAROG_REQUIRE_PRIVATE_LITERALS=1` jest czerwony.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PrivateLiteralsError, applyPseudonyms, findPrivateHits, loadPrivateLiterals, maskPath, parsePrivateLiterals,
  privateLiteralsPath, privateLiteralsRequired, publishGate,
} from '../../scripts/lib/private-literals.mjs';
import { main as scanMain, printableRuns, scanRepo } from '../../scripts/lib/private-scan.mjs';
import { REPO, SKIP_REASON } from './private-guard.ts';

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Katalog mógł już zniknąć.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
const tempDir = (label: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `rarog-private-${label}-`));
  made.push(dir);
  return dir;
};

/** Wartowniki: zmyślone, nie pochodzą z pliku właściciela. */
const SECRET = 'wartownikklient';
const SECRET2 = 'wartownikhost';
const VALID = {
  version: 2,
  forbidden: [{ literal: SECRET, category: 'klient' }, { literal: SECRET2, category: 'infrastruktura' }],
  patterns: [{ name: 'login-w-sciezce', regex: '/Users/testowy\\b' }],
  pseudonyms: { [SECRET]: 'alfa', [`${SECRET}-api`]: 'alfa-api' },
};

/** Błąd parsowania danych `data`: nazwa pola w komunikacie, bez żadnego wartownika. */
function parseError(data: unknown): PrivateLiteralsError {
  try {
    parsePrivateLiterals(data, '/atrapa/private-literals.json');
  } catch (error) {
    if (error instanceof PrivateLiteralsError) return error;
    throw error;
  }
  throw new Error('oczekiwany PrivateLiteralsError');
}
const noSentinel = (text: string): void => {
  for (const sentinel of [SECRET, SECRET2, 'wartownikzly']) expect(text).not.toContain(sentinel);
};

describe('loader: schemat i błędy z nazwą pola, bez treści', () => {
  it.each([
    ['zła wersja', { ...VALID, version: 1 }, 'version'],
    ['pusta lista', { ...VALID, forbidden: [] }, 'forbidden'],
    ['wpis 2-znakowy', { ...VALID, forbidden: ['wz'] }, 'forbidden[0]'],
    ['duplikat (wielkość liter)', { ...VALID, forbidden: [SECRET, SECRET.toUpperCase()] }, 'forbidden[1]'],
    ['literał w literale', { ...VALID, forbidden: [`${SECRET}-x`, SECRET] }, 'forbidden[0]'],
    ['pseudonim równy literałowi', { ...VALID, pseudonyms: { wartownikzly: SECRET } }, 'pseudonyms[0]'],
    ['pseudonim zawiera nazwę z mapy', { ...VALID, pseudonyms: { wartownikzly: 'x-wartownikzly' } }, 'pseudonyms[0]'],
    ['kategoria z literałem', { ...VALID, forbidden: [{ literal: SECRET, category: `o-${SECRET}` }] }, 'forbidden[0].category'],
    ['nieznane pole', { ...VALID, wartownikzly: 1 }, '(top-level field no. 5)'],
    ['wzorzec pasuje do pustego', { ...VALID, patterns: [{ name: 'x', regex: '.*' }] }, 'patterns[0].regex'],
    ['wzorzec się nie kompiluje', { ...VALID, patterns: [{ name: 'x', regex: '(' }] }, 'patterns[0].regex'],
    ['allow spoza forbidden', { ...VALID, allow: [{ path: 'a.md', literal: 'wartownikzly', reason: 'r' }] }, 'allow[0].literal'],
    ['allow ze ścieżką bezwzględną', { ...VALID, allow: [{ path: '/a.md', literal: SECRET, reason: 'r' }] }, 'allow[0].path'],
    ['allow bez powodu', { ...VALID, allow: [{ path: 'a.md', literal: SECRET, reason: ' ' }] }, 'allow[0].reason'],
  ])('%s', (_label, data, field) => {
    const error = parseError(data);
    expect(error.field).toBe(field);
    expect(error.message).toContain(field);
    noSentinel(error.message);
  });

  it('plik: brak = null; zły JSON, dowiązanie bez celu i brak prawa odczytu = błąd, nigdy null', () => {
    const dir = tempDir('loader');
    expect(loadPrivateLiterals({ file: path.join(dir, 'nie-ma.json') })).toBeNull();
    const bad = path.join(dir, 'zly.json');
    writeFileSync(bad, `{"version": 2, "forbidden": ["${SECRET}"`);
    const dangling = path.join(dir, 'wiszace.json');
    symlinkSync(path.join(dir, 'cel-nie-istnieje.json'), dangling);
    const fields: Record<string, string> = { [bad]: '(JSON)', [dangling]: '(file)' };
    if (process.getuid?.() !== 0) {
      const locked = path.join(dir, 'zablokowany.json');
      writeFileSync(locked, JSON.stringify(VALID));
      chmodSync(locked, 0o000);
      fields[locked] = '(file)';
    }
    for (const [file, field] of Object.entries(fields)) {
      let caught: unknown;
      try {
        loadPrivateLiterals({ file });
      } catch (error) {
        caught = error;
      }
      expect(caught, file).toBeInstanceOf(PrivateLiteralsError);
      expect((caught as PrivateLiteralsError).field, file).toBe(field);
      noSentinel((caught as Error).message);
    }
  });

  it('ścieżka: `RAROG_PRIVATE_LITERALS` albo `~/.config/rarog/` z `HOME`; wymóg i bramka tylko przy „1”', () => {
    expect(privateLiteralsPath({ HOME: '/h' })).toBe('/h/.config/rarog/private-literals.json');
    expect(privateLiteralsPath({ HOME: '/h', RAROG_PRIVATE_LITERALS: '/x.json' })).toBe('/x.json');
    expect(privateLiteralsPath({ HOME: '/h', RAROG_PRIVATE_LITERALS: '' })).toBe('/h/.config/rarog/private-literals.json');
    expect([privateLiteralsRequired({ RAROG_REQUIRE_PRIVATE_LITERALS: '1' }), privateLiteralsRequired({})]).toEqual([true, false]);
    expect([publishGate({ RAROG_PUBLISH_GATE: '1' }), publishGate({ RAROG_PUBLISH_GATE: 'true' })]).toEqual([true, false]);
  });
});

describe('dopasowanie', () => {
  const literals = parsePrivateLiterals(VALID);

  it('NFKC i wielkość liter: odmiana, wersaliki i znaki pełnej szerokości; numer linii, kategoria, bez treści', () => {
    const fullwidth = [...SECRET].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join('');
    const text = ['czysto', `${SECRET.toUpperCase()}owi`, `x ${fullwidth} y`, `cd /Users/testowy/x ${SECRET2}`].join('\n');
    expect(findPrivateHits(text, literals, 'a.ts')).toEqual([
      { line: 2, ref: 'forbidden[0]', label: 'klient' },
      { line: 3, ref: 'forbidden[0]', label: 'klient' },
      { line: 4, ref: 'forbidden[1]', label: 'infrastruktura' },
      { line: 4, ref: 'patterns[0]', label: 'login-w-sciezce' },
    ]);
    // Dłuższy login nie pasuje (`\b`); doklejony w biegu, bo `private-patterns-guard` liczy loginy spoza listy.
    expect(findPrivateHits(`/Users/testowy${'x'}`, literals)).toEqual([]);
  });

  it('`allow` zdejmuje literał w jednym pliku i tylko tam', () => {
    const allowed = parsePrivateLiterals({ ...VALID, allow: [{ path: 'docs/a.md', literal: SECRET, reason: 'cytat' }] });
    expect(findPrivateHits(SECRET, allowed, 'docs/a.md')).toEqual([]);
    expect(findPrivateHits(SECRET, allowed, 'docs/b.md')).toHaveLength(1);
    expect(findPrivateHits(SECRET2, allowed, 'docs/a.md')).toHaveLength(1);
  });

  it('`maskPath` maskuje literał i wzorzec w ścieżce, czystą zostawia', () => {
    expect(maskPath(`fixtures/${SECRET}-x.txt`, literals)).toBe('fixtures/‹forbidden[0]›-x.txt');
    expect(maskPath('src/Users/testowy/a', literals)).toBe('src‹patterns[0]›/a');
    expect(maskPath('src/a.ts', literals)).toBe('src/a.ts');
  });

  it('pseudonimy: dłuższa nazwa przed krótszą, bez wielkości liter', () => {
    expect(applyPseudonyms(`${SECRET.toUpperCase()}-api i ${SECRET}:x`, literals.pseudonyms)).toBe('alfa-api i alfa:x');
  });

  it('napisy z pliku binarnego: ASCII i UTF-16 w obu kolejnościach bajtów', () => {
    const le = Buffer.from(`\0${SECRET}`, 'utf16le');
    const be = Buffer.from(Buffer.from(SECRET2, 'utf16le').map((_, at, all) => all[at ^ 1] ?? 0));
    const runs = printableRuns(Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('ascii-x'), Buffer.from([0]), le, Buffer.from([0, 0, 0]), be]));
    expect(runs).toContain('ascii-x');
    expect(runs).toContain(SECRET);
    expect(runs).toContain(SECRET2);
  });

  it('napisy UTF-16 zaczęte na bajcie nieparzystym, z niezerowymi sąsiadami, zostają w całości', () => {
    const le = Buffer.from(SECRET, 'utf16le');
    const be = Buffer.from(le.map((_, at, all) => all[at ^ 1] ?? 0));
    for (const [label, body] of [['LE', le], ['BE', be]] as const) {
      for (const lead of [[1], [1, 2]]) {
        const runs = printableRuns(Buffer.concat([Buffer.from(lead), body, Buffer.from([1])]));
        expect(runs, `${label}, przed napisem ${String(lead.length)} B`).toContain(SECRET);
      }
    }
  });
});

describe('skaner (`private-scan.mjs`) na atrapie bez `.git`', () => {
  /** Atrapa: trafienie w treści, w nazwie pliku, w celu dowiązania i w napisach binarium; plik ignorowany. */
  function atrapa(): { root: string; literalsFile: string } {
    const root = tempDir('skan');
    const files: Record<string, string | Buffer> = {
      '.gitignore': 'ignorowany/\n',
      'src/czysty.ts': 'export const x = 1;\n',
      'src/tresc.ts': `// linia 1\nconst host = '${SECRET2}';\n`,
      [`fixtures/${SECRET}-zrzut.txt`]: 'czysta treść\n',
      'ignorowany/plik.txt': SECRET,
      'obraz.bin': Buffer.concat([Buffer.from([0x89, 0, 1]), Buffer.from(`meta ${SECRET}`), Buffer.from([0])]),
    };
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), body);
    }
    symlinkSync(`/srv/${SECRET2}/x`, path.join(root, 'dowiazanie'));
    const literalsFile = path.join(tempDir('literaly'), 'private-literals.json');
    writeFileSync(literalsFile, JSON.stringify(VALID));
    return { root, literalsFile };
  }
  const run = (argv: readonly string[], env: Record<string, string> = {}): { code: number; out: string; err: string } => {
    let out = '';
    let err = '';
    const code = scanMain(argv, {
      env: { HOME: tempDir('home'), ...env }, out: { write: (text: string) => (out += text) }, err: { write: (text: string) => (err += text) },
    });
    return { code, out, err };
  };

  it('treść, nazwa pliku, cel dowiązania i napisy binarium; plik ignorowany poza skanem', () => {
    const { root, literalsFile } = atrapa();
    const literals = loadPrivateLiterals({ file: literalsFile });
    if (literals === null) throw new Error('brak atrapy pliku literałów');
    const result = scanRepo(root, literals);
    expect(result.errors).toEqual([]);
    expect(result.findings.map(({ file, where, ref }) => `${maskPath(file, literals)}:${where}:${ref}`).sort()).toEqual([
      'dowiazanie:symlink:forbidden[1]',
      'fixtures/‹forbidden[0]›-zrzut.txt:name:forbidden[0]',
      'obraz.bin:strings:forbidden[0]',
      'src/tresc.ts:2:forbidden[1]',
    ]);
    expect([...result.counts.keys()].join(' ')).not.toContain(SECRET);
  });

  it('CLI: kod 1 i wynik bez treści literału, z podsumowaniem per kategoria; czysto = 0', () => {
    const { root, literalsFile } = atrapa();
    const res = run(['--literals', literalsFile, root]);
    expect(res.code, res.err).toBe(1);
    expect(res.out).toContain('src/tresc.ts:2: forbidden[1] (infrastruktura)');
    expect(res.out).toContain('  klient: 2\n');
    expect(res.out).toContain('total: 4 hits in 4 files');
    noSentinel(res.out + res.err);
    const clean = tempDir('czysto');
    writeFileSync(path.join(clean, 'a.ts'), 'x\n');
    expect(run(['--literals', literalsFile, clean]).code).toBe(0);
  });

  it('nieczytelny plik repo = kod 2, nie pominięcie', () => {
    if (process.getuid?.() === 0) return;
    const { root, literalsFile } = atrapa();
    const locked = path.join(root, 'src', 'zablokowany.ts');
    writeFileSync(locked, 'x');
    chmodSync(locked, 0o000);
    const res = run(['--literals', literalsFile, root]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('src/zablokowany.ts: unreadable');
  });

  it('bez pliku literałów, z zepsutym i ze złym argumentem: kod 2', () => {
    const { root } = atrapa();
    const missing = run([root]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('no private literals file');
    const broken = path.join(tempDir('zepsuty'), 'p.json');
    writeFileSync(broken, JSON.stringify({ ...VALID, version: 3 }));
    expect(run([root], { RAROG_PRIVATE_LITERALS: broken }).code).toBe(2);
    expect(run(['--gate', '--baseline', root]).code).toBe(2);
    expect(run(['--nie-ma']).code).toBe(2);
  });

  it('`--gate`: bez `publish.config.json` kod 2; binarium spoza listy `binaries` to znalezisko', () => {
    const { root, literalsFile } = atrapa();
    const noConfig = run(['--gate', '--literals', literalsFile, root]);
    expect(noConfig.code).toBe(2);
    expect(noConfig.err).toContain('publish.config.json');
    writeFileSync(path.join(root, 'publish.config.json'), JSON.stringify({ binaries: [] }));
    const outside = run(['--gate', '--literals', literalsFile, root]);
    expect(outside.code).toBe(1);
    expect(outside.out).toContain('obraz.bin:allowlist: binaries (non-text file not listed in publish.config.json)');
    writeFileSync(path.join(root, 'publish.config.json'), JSON.stringify({ binaries: [{ path: 'obraz.bin', reason: 'ikona' }] }));
    expect(run(['--gate', '--literals', literalsFile, root]).out).not.toContain('allowlist');
    writeFileSync(path.join(root, 'publish.config.json'), JSON.stringify({ binaries: [{ path: 'obraz.bin' }] }));
    expect(run(['--gate', '--literals', literalsFile, root]).code).toBe(2);
  });

  it('`--config <plik>`: konfiguracja spoza skanowanego korzenia (eksport jej nie ma); jawny brak pliku to kod 2', () => {
    const { literalsFile } = atrapa();
    const root = tempDir('eksport');
    writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'obraz.bin'), Buffer.from([0x89, 0, 1, 2]));
    const config = path.join(tempDir('zrodlo'), 'publish.config.json');
    writeFileSync(config, JSON.stringify({ binaries: [{ path: 'obraz.bin', reason: 'ikona' }] }));
    expect(run(['--gate', '--literals', literalsFile, root]).code).toBe(2);
    const gate = run(['--gate', '--literals', literalsFile, '--config', config, root]);
    expect(gate.code, gate.err).toBe(0);
    expect(gate.out).not.toContain('not checked');
    writeFileSync(config, JSON.stringify({ binaries: [] }));
    expect(run(['--gate', '--literals', literalsFile, '--config', config, root]).code).toBe(1);
    const missing = run(['--gate', '--literals', literalsFile, '--config', path.join(root, 'nie-ma.json'), root]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('nie-ma.json');
    expect(run(['--literals', literalsFile, '--config', path.join(root, 'nie-ma.json'), root]).code).toBe(2);
    expect(run(['--literals', literalsFile, '--config']).code).toBe(2);
  });

  it('`--gate`: literał w napisach UTF-16 dozwolonego binarium, zaczęty na bajcie nieparzystym, przewraca bramkę', () => {
    const { root, literalsFile } = atrapa();
    writeFileSync(path.join(root, 'obraz.bin'), Buffer.concat([Buffer.from([0x89, 1]), Buffer.from(`x${SECRET}`, 'utf16le'), Buffer.from([1])]));
    writeFileSync(path.join(root, 'publish.config.json'), JSON.stringify({ binaries: [{ path: 'obraz.bin', reason: 'ikona' }] }));
    const res = run(['--gate', '--literals', literalsFile, root]);
    expect(res.code).toBe(1);
    expect(res.out).toContain('obraz.bin:strings: forbidden[0] (klient)');
  });

  it('dwa różne pliki pod jednym kluczem zamaskowanym to błąd skanu, nie suma liczników', () => {
    const { root, literalsFile } = atrapa();
    const fullwidth = [...SECRET].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join('');
    writeFileSync(path.join(root, 'fixtures', `${fullwidth}-zrzut.txt`), 'czysta treść\n');
    const literals = loadPrivateLiterals({ file: literalsFile });
    if (literals === null) throw new Error('brak atrapy pliku literałów');
    expect(scanRepo(root, literals).errors).toEqual(['fixtures/‹forbidden[0]›-zrzut.txt: two different files under the same masked key']);
    expect(run(['--literals', literalsFile, root]).code).toBe(2);
  });

  it('zapadka poza repo: `--update-baseline` zapisuje (0600), `--baseline` czerwony przy wzroście, bez bazy kod 2', () => {
    const { root, literalsFile } = atrapa();
    const baseline = path.join(path.dirname(literalsFile), 'private-literals.baseline.json');
    expect(run(['--baseline', '--literals', literalsFile, root]).code).toBe(2);
    expect(run(['--update-baseline', '--literals', literalsFile, root]).code).toBe(0);
    expect(statSync(baseline).mode & 0o777).toBe(0o600);
    noSentinel(readFileSync(baseline, 'utf8'));
    expect(run(['--baseline', '--literals', literalsFile, root]).code).toBe(0);
    writeFileSync(path.join(root, 'src', 'tresc.ts'), `${SECRET}\n${SECRET}\n`);
    const grown = run(['--baseline', '--literals', literalsFile, root]);
    expect(grown.code).toBe(1);
    expect(grown.out).toContain('GROWTH src/tresc.ts: 2 > baseline 1');
    const other = path.join(tempDir('baza'), 'b.json');
    expect(run(['--update-baseline', '--baseline-file', other, '--literals', literalsFile, root]).code).toBe(0);
    expect(existsSync(other)).toBe(true);
  });

  it('proces `node scripts/lib/private-scan.mjs` daje ten sam kod wyjścia', () => {
    const { root, literalsFile } = atrapa();
    const res = spawnSync(process.execPath, [path.join(REPO, 'scripts/lib/private-scan.mjs'), '--literals', literalsFile, root], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: tempDir('home') },
    });
    expect(res.status, res.stderr).toBe(1);
    noSentinel(res.stdout + res.stderr);
  });
});

/** `vitest` z najbliższego `node_modules` w górę drzewa — worktree bywa bez własnego. */
function findVitest(): string {
  let dir = REPO;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'vitest');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('brak node_modules/.bin/vitest');
}

describe('strażnik nazw w podprocesie z pustym `HOME`', () => {
  const vitest = (env: Record<string, string>): ReturnType<typeof spawnSync> => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RAROG_')
      && key !== 'VITEST' && !key.startsWith('VITEST_')));
    return spawnSync(findVitest(), ['run', '--reporter', 'verbose', 'server/test/herdr-fixtures.test.ts'], {
      cwd: REPO, encoding: 'utf8', env: { ...clean, HOME: tempDir('pusty-home'), ...env }, timeout: 120_000,
    });
  };

  it('bez pliku: pominięcie z komunikatem, kod 0; z `RAROG_REQUIRE_PRIVATE_LITERALS=1`: czerwono', () => {
    const skipped = vitest({});
    expect(skipped.status, String(skipped.stdout)).toBe(0);
    expect(String(skipped.stdout)).toContain(SKIP_REASON);
    const required = vitest({ RAROG_REQUIRE_PRIVATE_LITERALS: '1' });
    expect(required.status).not.toBe(0);
    expect(String(required.stdout) + String(required.stderr)).toContain('plik prywatnych literałów jest wymagany');
  }, 240_000);
});
