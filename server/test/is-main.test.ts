/**
 * Strażnik modułu głównego skryptów (`scripts/lib/is-main.mjs`): Node podaje w `import.meta.url` modułu głównego
 * ścieżkę po rozwinięciu dowiązań, a `process.argv[1]` tak, jak ją podano. Przy checkoucie pod dowiązaniem
 * (`/var` → `/private/var` na macOS, katalog projektu przez symlink) porównanie wprost daje `false`: skrypt
 * kończy się kodem 0 bez `main`, a sprawdzian przepuszcza bez sprawdzenia.
 *
 * Najpierw sam helper na prawdziwym dowiązaniu, potem regresja end-to-end: skrypty uruchomione przez dowiązanie do
 * korzenia checkoutu wykonują `main` (kod i wyjście, których bez `main` nie ma). Plik literałów to atrapa w katalogu
 * tymczasowym albo jego brak; prawdziwego pliku test nie czyta.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isMainModule } from '../../scripts/lib/is-main.mjs';
import { literalsEnv } from './synthetic-literals.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (label: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `rarog-is-main-${label}-`));
  made.push(dir);
  return dir;
};

function findTsx(): string {
  let dir = REPO;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('brak node_modules/.bin/tsx');
}

/** Katalog z plikiem `real/mod.mjs` i dowiązaniem `link` → `real`. */
function linkedModule(): { real: string; viaLink: string } {
  const dir = tempDir('helper');
  mkdirSync(path.join(dir, 'real'));
  const real = path.join(dir, 'real', 'mod.mjs');
  writeFileSync(real, 'export {};\n');
  symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  return { real: realpathSync(real), viaLink: path.join(dir, 'link', 'mod.mjs') };
}

describe('isMainModule', () => {
  it('ścieżka skryptu przez dowiązanie to ten sam moduł (porównanie wprost mówi „nie”)', () => {
    const { real, viaLink } = linkedModule();
    expect(pathToFileURL(viaLink).href).not.toBe(pathToFileURL(real).href);
    expect(isMainModule(pathToFileURL(real).href, viaLink)).toBe(true);
    expect(isMainModule(pathToFileURL(viaLink).href, real)).toBe(true);
    expect(isMainModule(pathToFileURL(real).href, real)).toBe(true);
  });

  it('ścieżka względna liczy się od katalogu procesu', () => {
    const { real, viaLink } = linkedModule();
    expect(isMainModule(pathToFileURL(real).href, path.relative(process.cwd(), viaLink))).toBe(true);
  });

  it('inny plik, brak argv[1], plik, którego nie ma, i adres spoza file: to „nie główny”, bez wyjątku', () => {
    const { real, viaLink } = linkedModule();
    const other = path.join(path.dirname(real), 'inny.mjs');
    writeFileSync(other, 'export {};\n');
    expect(isMainModule(pathToFileURL(real).href, other)).toBe(false);
    expect(isMainModule(pathToFileURL(real).href, undefined)).toBe(false);
    expect(isMainModule(pathToFileURL(real).href, '')).toBe(false);
    expect(isMainModule(pathToFileURL(real).href, path.join(path.dirname(viaLink), 'nie-ma.mjs'))).toBe(false);
    expect(isMainModule(pathToFileURL(path.join(path.dirname(real), 'nie-ma.mjs')).href, real)).toBe(false);
    expect(isMainModule('data:text/javascript,export%20{}', real)).toBe(false);
  });

  it('moduł zaimportowany (tu: ten test pod vitest) nie jest główny; domyślnie argv[1] procesu', () => {
    expect(isMainModule(import.meta.url)).toBe(false);
  });
});

describe('skrypty uruchomione przez dowiązanie do checkoutu wykonują main', () => {
  /** Dowiązanie do korzenia checkoutu w katalogu tymczasowym: ścieżka skryptu nie przechodzi `realpath`. */
  const checkout = (): string => {
    const dir = tempDir('checkout');
    const link = path.join(dir, 'checkout');
    symlinkSync(REPO, link);
    return link;
  };
  const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(command, args, { cwd: tmpdir(), encoding: 'utf8', env, timeout: 60_000 });

  it('private-scan.mjs: atrapa literału w drzewie = kod 1 i podsumowanie', () => {
    const link = checkout();
    const dir = tempDir('scan');
    const tree = path.join(dir, 'drzewo');
    mkdirSync(tree);
    writeFileSync(path.join(tree, 'czysty.txt'), 'zwykła linia\n');
    writeFileSync(path.join(tree, 'trafiony.txt'), 'tu stoi atrapaklienta\n');
    const literals = path.join(dir, 'literaly.json');
    writeFileSync(literals, JSON.stringify({ version: 2, forbidden: [{ literal: 'atrapaklienta', category: 'klient' }] }));
    const res = run(process.execPath, [path.join(link, 'scripts/lib/private-scan.mjs'), '--literals', literals, tree],
      literalsEnv(literals));
    expect(res.stderr).toBe('');
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('private-scan: 2 files');
    expect(res.stdout).toContain('trafiony.txt:1: forbidden[0] (klient)');
    expect(res.stdout).toContain('total: 1 hits in 1 files');
    expect(res.stdout).not.toContain('atrapaklienta');
  });

  it('private-literals.mjs: brak pliku literałów = kod 3', () => {
    const link = checkout();
    const missing = path.join(tempDir('literals'), 'nie-ma.json');
    const res = run(process.execPath, [path.join(link, 'scripts/lib/private-literals.mjs')], literalsEnv(missing));
    expect(res.status).toBe(3);
    expect(res.stdout).toContain('private literals: no file');
  });

  it('anonymize-fixture.ts --require: brak pliku literałów = kod 2 (fail closed), atrapa = kod 0', () => {
    const link = checkout();
    const dir = tempDir('anonymize');
    const script = path.join(link, 'scripts/anonymize-fixture.ts');
    const missing = run(findTsx(), [script, '--require'], literalsEnv(path.join(dir, 'nie-ma.json')));
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('no private literals file');
    expect(run(findTsx(), [script, '--require'], literalsEnv()).status).toBe(0);
  }, 60_000);

  it('l10n-check.mjs: wypisuje werdykt', () => {
    const link = checkout();
    const res = run(process.execPath, [path.join(link, 'scripts/l10n-check.mjs')], process.env);
    expect(`${res.stdout}${res.stderr}`).toMatch(/^l10n-check: /m);
  });

  it('relay/scripts/smoke.mjs bez adresu przekaźnika: kod 2 i użycie, zanim cokolwiek wyśle', () => {
    const link = checkout();
    const res = run(process.execPath, [path.join(link, 'relay/scripts/smoke.mjs')], process.env);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('smoke: missing relay address');
  });
});
