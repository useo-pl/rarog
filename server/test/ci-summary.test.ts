/**
 * Podsumowanie raportu testów dla zadań CI (`scripts/lib/ci-summary.mjs`, `.github/workflows/check.yml`): liczby,
 * pominięcia według powodu z tytułu i ciche pominięcie (bez powodu) jako kod 1.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FAILED_FILE_REASON, main, renderSummary, skipReason, summarize } from '../../scripts/lib/ci-summary.mjs';
import { SKIP_REASON } from '../../scripts/lib/private-literals.mjs';
import { macOnly } from './platform.ts';

const ROOT = '/repo';

/** Raport vitest JSON: plik → [stan, pełna nazwa] testów. */
function report(files: Record<string, ReadonlyArray<readonly [string, string]>>, failedFile?: string): unknown {
  return {
    testResults: Object.entries(files).map(([name, tests]) => ({
      name: path.join(ROOT, name),
      status: name === failedFile || tests.some(([status]) => status === 'failed') ? 'failed' : 'passed',
      assertionResults: tests.map(([status, fullName]) => ({ status, fullName, title: fullName })),
    })),
  };
}

class Sink {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

describe('skipReason: powód z nawiasu w tytule', () => {
  it('tytuł z `macOnly` i powód z pliku literałów', () => {
    expect(skipReason(`restart ${macOnly('launchd', 'plutil')} pisze plist`)).toBe('macOS only: plutil');
    expect(skipReason(`nazwy klientów (${SKIP_REASON})`)).toBe(SKIP_REASON);
  });

  it('nawias bez znacznika nie jest powodem; znacznik w środku nawiasu liczy się od siebie', () => {
    expect(skipReason('setup (pseudoterminal) (macOS only: launchd) Ctrl-C')).toBe('macOS only: launchd');
    expect(skipReason('migracja (Z4, test 14; requires relay/node_modules)')).toBe('requires relay/node_modules');
    expect(skipReason('zwykły tytuł (pseudoterminal)')).toBeNull();
    expect(skipReason('setup (macOS only: launchd) kopia hooka (requires a git checkout)'))
      .toBe('macOS only: launchd + requires a git checkout');
    expect(skipReason('requires gitleaks, ale bez nawiasu')).toBeNull();
  });

  it('`macOnly` nie przyjmuje powodu z nawiasem: podsumowanie by go nie odczytało', () => {
    expect(() => macOnly('x', 'script(1)')).toThrow(/bez nawiasów/);
  });
});

describe('summarize i renderSummary', () => {
  const data = report({
    'server/test/a.test.ts': [
      ['passed', 'a działa'], ['skipped', 'a (macOS only: launchd) jedno'], ['skipped', 'a (macOS only: launchd) dwa'],
      ['pending', 'a (requires gitleaks) skan'],
    ],
    'server/test/b.test.ts': [['failed', 'b pada'], ['todo', 'b kiedyś']],
    'server/test/c.test.ts': [],
  }, 'server/test/c.test.ts');

  it('liczy stany, pliki z błędem i powody od największej liczby; bez powodu = ciche pominięcie z plikiem', () => {
    expect(summarize(data, ROOT)).toEqual({
      passed: 1, failed: 1, skipped: 4, failedFiles: 2,
      reasons: [['macOS only: launchd', 2], ['requires gitleaks', 1]],
      silent: ['server/test/b.test.ts › b kiedyś'],
    });
  });

  it('Markdown: nagłówek z nazwą zadania, tabela powodów, lista cichych pominięć', () => {
    const text = renderSummary(summarize(data, ROOT), 'Ubuntu');
    expect(text).toContain('### Tests: Ubuntu');
    expect(text).toContain('Passed 1, failed 1, skipped 4, files with errors 2.');
    expect(text).toContain('| macOS only: launchd | 2 |');
    expect(text).toContain('**Skipped without a reason in the title: 1.**');
    expect(text).toContain('- `server/test/b.test.ts › b kiedyś`');
  });

  it('pominięte w pliku z błędem (padnięty `beforeAll`): powód „plik z błędem”, nie ciche pominięcie', () => {
    const hook = report({ 'server/test/d.test.ts': [['skipped', 'd jedno'], ['skipped', 'd (requires lsof) dwa']] },
      'server/test/d.test.ts');
    expect(summarize(hook, ROOT)).toMatchObject({
      skipped: 2, failedFiles: 1, silent: [], reasons: [[FAILED_FILE_REASON, 1], ['requires lsof', 1]],
    });
  });

  it('padnięty `beforeAll` jednego `describe` obok testów, które przeszły: też „plik z błędem”', () => {
    // Kształt raportu vitest 4 (sprawdzony na pliku z hookiem po limicie): plik `failed`, żaden test `failed`,
    // testy grupy `skipped`. Tak wyglądał `git-diff-repo.test.ts` po przestoju runnera macOS.
    const describeHook = report({
      'server/test/e.test.ts': [['passed', 'e działa'], ['skipped', 'e grupa jedno'], ['skipped', 'e grupa dwa']],
    }, 'server/test/e.test.ts');
    expect(summarize(describeHook, ROOT)).toMatchObject({
      passed: 1, skipped: 2, failedFiles: 1, silent: [], reasons: [[FAILED_FILE_REASON, 2]],
    });
  });

  it('to nie raport vitest: wyjątek, nie zera', () => {
    expect(() => summarize({ results: [] })).toThrow(/testResults/);
  });
});

describe('main: kody wyjścia', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rarog-ci-summary-'));
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  const write = (name: string, value: unknown): string => {
    const file = path.join(dir, name);
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const run = (argv: string[]): { code: number; out: string; err: string } => {
    const out = new Sink();
    const err = new Sink();
    const code = main(argv, { out, err, root: ROOT });
    return { code, out: out.text, err: err.text };
  };

  it('każde pominięcie z powodem: kod 0 i podsumowanie na stdout', () => {
    const file = write('ok.json', report({ 'server/test/a.test.ts': [['passed', 'a'], ['skipped', 'a (requires lsof)']] }));
    const result = run([file, 'macOS']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('| requires lsof | 1 |');
    expect(result.err).toBe('');
  });

  it('ciche pominięcie: kod 1, podsumowanie i tak wypisane', () => {
    const file = write('cicho.json', report({ 'server/test/a.test.ts': [['skipped', 'a bez powodu']] }));
    const result = run([file, 'Ubuntu']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('a bez powodu');
    expect(result.err).toContain('without a reason in the title: 1');
  });

  it('brak albo zepsuty raport: kod 1 z nazwą pliku; złe argumenty: kod 2', () => {
    expect(run([path.join(dir, 'nie-ma.json'), 'Ubuntu']).code).toBe(1);
    const broken = run([write('zly.json', '{'), 'Ubuntu']);
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('No readable test report');
    expect(run([]).code).toBe(2);
    expect(run(['raport.json']).code).toBe(2);
    expect(run(['raport.json', 'Ubuntu', 'nadmiar']).code).toBe(2);
  });
});
