/**
 * `scripts/lib/repo-files.mjs` — lista plików repo dla strażników, skanera prywatnych literałów i bramki publikacji
 * (`docs/publishing.md`, „Repo file list”), oraz wzorce `.gitignore` na pliki, które nie mogą trafić do repo
 * publicznego.
 *
 * Spacer bez gita ma widzieć DOKŁADNIE to, co git: porównanie z `git ls-files --others --exclude-standard` na
 * syntetycznym repo (negacje, katalogi, zakotwiczenia, `**`, `.gitignore` w podkatalogu, dowiązanie) i z
 * `git ls-tree` na eksporcie `git archive` tego repo. Git w podprocesie bez konfiguracji globalnej i systemowej,
 * bo `core.excludesFile` właściciela zmieniałby wynik.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isIgnored, parseGitignore, repoFiles, repoFilesMode, walkRepoFiles } from '../../scripts/lib/repo-files.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (label: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `rarog-repo-files-${label}-`));
  made.push(dir);
  return dir;
};

const GIT_HOME = tempDir('home');
const GIT_ENV = {
  ...process.env, HOME: GIT_HOME, XDG_CONFIG_HOME: GIT_HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 256 * 1024 * 1024 });
const gitUntracked = (cwd: string): string[] =>
  git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter((file) => file !== '').sort();

/** Pliki atrapy: ścieżka → treść (katalogi powstają same). */
function tree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

const hasGit = spawnSync('git', ['--version']).status === 0;

/** Czy system plików katalogu tymczasowego przyjmuje nazwę spoza UTF-8 (APFS nie, ext4 tak). */
function nonUtf8NamesAllowed(): boolean {
  const dir = tempDir('proba-nazwy');
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${dir}/z`), Buffer.from([0xff])]), 'x');
    return true;
  } catch {
    return false;
  }
}

describe('reguły `.gitignore` (dane syntetyczne)', () => {
  it('negacja, tylko katalog, zakotwiczenie, `**`, ostatnia reguła wygrywa', () => {
    const rules = parseGitignore([
      '# komentarz', '*.log', '!wazny.log', 'build/', '/tylko-korzen', 'docs/**/szkic.md', 'a/**', '\\#hash',
    ].join('\n'));
    const ignored = (file: string, isDir = false): boolean => isIgnored(file, isDir, rules);
    expect([ignored('x.log'), ignored('g/x.log'), ignored('wazny.log'), ignored('g/wazny.log')]).toEqual([true, true, false, false]);
    expect([ignored('build', true), ignored('build'), ignored('src/build', true)]).toEqual([true, false, true]);
    expect([ignored('tylko-korzen'), ignored('src/tylko-korzen')]).toEqual([true, false]);
    expect([ignored('docs/szkic.md'), ignored('docs/a/b/szkic.md'), ignored('szkic.md')]).toEqual([true, true, false]);
    expect([ignored('a/x'), ignored('a/b/c'), ignored('a', true)]).toEqual([true, true, false]);
    expect(ignored('#hash')).toBe(true);
  });

  it('reguły pliku w podkatalogu działają względem niego i wygrywają z korzeniem', () => {
    const stack = [...parseGitignore('*.tmp\n'), ...parseGitignore('!zostaw.tmp\n/lokalny\n', 'sub')];
    expect(isIgnored('sub/zostaw.tmp', false, stack)).toBe(false);
    expect(isIgnored('zostaw.tmp', false, stack)).toBe(true);
    expect(isIgnored('sub/lokalny', false, stack)).toBe(true);
    expect(isIgnored('lokalny', false, stack)).toBe(false);
  });
});

describe.skipIf(!hasGit)('spacer bez gita = `git ls-files` (fake repo; requires git)', () => {
  const root = tempDir('atrapa');
  git(root, ['init', '-q']);
  tree(root, {
    '.gitignore': ['node_modules', 'dist/', '*.log', '!wazny.log', '/tylko-korzen.txt', 'docs/**/szkic.md',
      'ukryty/', '!ukryty/odzyskany.txt', 'gwiazda/**', '!gwiazda/zostaw.txt', '[ab]x.txt', 'spacja\\ ',
      // Klasa znaków, także zanegowana i z zakresem obejmującym `/`, nie dopasowuje separatora.
      'kl[!a]sa', 'm[--0]n', ''].join('\n'),
    'node_modules/pakiet/index.js': 'x',
    'pakiet/node_modules/inny.js': 'x',
    'dist/out.js': 'x',
    'src/dist': 'plik o nazwie katalogu z regułą „tylko katalog”',
    'src/a.ts': 'x',
    'src/b.log': 'x',
    'src/wazny.log': 'x',
    'tylko-korzen.txt': 'x',
    'src/tylko-korzen.txt': 'x',
    'docs/szkic.md': 'x',
    'docs/a/b/szkic.md': 'x',
    'docs/czysty.md': 'x',
    'ukryty/odzyskany.txt': 'katalog wykluczony: negacja pliku w nim nie działa',
    'gwiazda/zostaw.txt': 'x',
    'gwiazda/inny.txt': 'x',
    'ax.txt': 'x',
    'cx.txt': 'x',
    'sub/.gitignore': '!b2.log\n/lokalny.txt\n',
    'sub/b2.log': 'x',
    'sub/c.log': 'x',
    'sub/lokalny.txt': 'x',
    'sub/glebiej/lokalny.txt': 'x',
    '.ukryty-plik': 'x',
    'kl/sa': 'x',
    'klxsa': 'x',
    'm/n': 'x',
    'm.n': 'x',
  });
  symlinkSync('src/a.ts', path.join(root, 'dowiazanie'));
  symlinkSync('nie-ma-celu', path.join(root, 'wiszace'));

  it('ta sama lista plików, co git, bez wykluczeń po nazwie', () => {
    const expected = gitUntracked(root);
    expect(expected).toContain('src/dist');
    expect(expected).toContain('dowiazanie');
    expect(expected).not.toContain('ukryty/odzyskany.txt');
    expect(expected).toEqual(expect.arrayContaining(['kl/sa', 'm/n']));
    expect(expected).not.toContain('klxsa');
    expect(expected).not.toContain('m.n');
    expect(walkRepoFiles(root).sort()).toEqual(expected);
  });

  it('`repoFiles` z gitem i bez gita daje to samo, także pod podkatalogiem', () => {
    expect(repoFilesMode(root)).toBe('git');
    const withGit = repoFiles(root);
    const copy = tempDir('kopia');
    execFileSync('cp', ['-R', `${root}/.`, copy]);
    rmSync(path.join(copy, '.git'), { recursive: true, force: true });
    expect(repoFilesMode(copy)).toBe('walk');
    expect(repoFiles(copy)).toEqual(withGit);
    expect(repoFiles(copy, 'sub/')).toEqual(repoFiles(root, 'sub'));
    expect(repoFiles(copy, 'sub').every((file) => file.startsWith('sub/'))).toBe(true);
  });

  it('ścieżka spoza UTF-8 z gita to wyjątek, nie plik, który znika z listy', () => {
    const dir = tempDir('zla-nazwa-git');
    git(dir, ['init', '-q']);
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env: GIT_ENV, input: 'x\n', encoding: 'utf8' }).trim();
    const input = Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0x7a, 0xff, 0x2e, 0x74, 0x78, 0x74, 0])]);
    execFileSync('git', ['update-index', '-z', '--add', '--index-info'], { cwd: dir, env: GIT_ENV, input });
    expect(() => repoFiles(dir)).toThrow(/UTF-8/);
  });

  // APFS odmawia takiej nazwy (EILSEQ), więc na Macu przypadek spaceru nie zachodzi; ext4 ją przyjmuje.
  it.skipIf(!nonUtf8NamesAllowed())('ścieżka spoza UTF-8 w spacerze bez gita to wyjątek (skipped on a file system that rejects non-UTF-8 names, e.g. APFS)', () => {
    const dir = tempDir('zla-nazwa-spacer');
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(Buffer.concat([Buffer.from(`${dir}/sub/z`), Buffer.from([0xff])]), 'x');
    expect(() => walkRepoFiles(dir)).toThrow(/UTF-8/);
    expect(() => repoFiles(dir)).toThrow(/UTF-8/);
  });

  it('`.git` jako plik (worktree) to też tryb `git`', () => {
    const dir = tempDir('plik-git');
    writeFileSync(path.join(dir, '.git'), 'gitdir: /atrapa/.git/worktrees/x\n');
    expect(repoFilesMode(dir)).toBe('git');
  });
});

describe.skipIf(!hasGit || !existsSync(path.join(REPO, '.git')))('to repo: eksport bez historii (requires git and a checkout with .git)', () => {
  it('spacer po `git archive HEAD` widzi dokładnie pliki commita (`git ls-tree`)', () => {
    const out = tempDir('eksport');
    execFileSync('/bin/sh', ['-c', 'git archive HEAD | tar -x -C "$1"', 'sh', out], { cwd: REPO, env: GIT_ENV });
    const tracked = git(REPO, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter((file) => file !== '').sort();
    expect(tracked.length).toBeGreaterThan(1000);
    expect(walkRepoFiles(out).sort()).toEqual(tracked);
  });

  it('żaden plik śledzony nie pasuje do wzorców `.gitignore` (`git ls-files -ci`)', () => {
    expect(git(REPO, ['ls-files', '-ci', '--exclude-standard'])).toBe('');
  });
});

describe.skipIf(!hasGit)('`.gitignore` tego repo: pliki lokalne i sekrety poza repo publicznym (requires git)', () => {
  const root = tempDir('wzorce');
  git(root, ['init', '-q']);
  mkdirSync(path.join(root, 'relay'));
  copyFileSync(path.join(REPO, '.gitignore'), path.join(root, '.gitignore'));
  copyFileSync(path.join(REPO, 'relay', '.gitignore'), path.join(root, 'relay', '.gitignore'));
  const IGNORED = [
    '.rarog-uploads/zdjecie.jpg', 'projekt/.rarog-uploads/zdjecie.png', '.claude/worktrees/sesja/plik.ts',
    'inny/.claude/worktrees/sesja/plik.ts', '.claude/settings.local.json', 'CLAUDE.local.md', '.env', '.env.local',
    'server/.env.production', 'klucz.pem', 'native/AuthKey_ATRAPA.p8', 'relay/.dev.vars', 'relay/.dev.vars.production',
    '.claude/.cc-writes/x', '.claude/scheduled_tasks.lock',
  ];
  const KEPT = [
    '.env.example', 'relay/.dev.vars.example', '.claude/settings.json', 'CLAUDE.md', 'docs/env.md', 'server/src/a.ts',
  ];
  tree(root, Object.fromEntries([...IGNORED, ...KEPT].map((file) => [file, 'atrapa'])));

  it('git ignoruje pliki lokalne i sekrety, a szablony `*.example` zostawia', () => {
    for (const file of IGNORED) {
      expect(spawnSync('git', ['check-ignore', '-q', '--no-index', '--', file], { cwd: root, env: GIT_ENV }).status, file).toBe(0);
    }
    for (const file of KEPT) {
      expect(spawnSync('git', ['check-ignore', '-q', '--no-index', '--', file], { cwd: root, env: GIT_ENV }).status, file).toBe(1);
    }
  });

  it('spacer bez gita widzi to samo', () => {
    const expected = gitUntracked(root);
    expect(expected).toEqual([...KEPT, '.gitignore', 'relay/.gitignore'].sort());
    expect(walkRepoFiles(root).sort()).toEqual(expected);
  });
});
