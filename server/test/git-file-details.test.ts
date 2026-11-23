/**
 * Szczegóły plików ramki `git-status` (`fileDetails`) na PRAWDZIWYM gicie.
 *
 * `git-status.test.ts` wstrzykuje runnery i pilnuje parserów na zmierzonych wyjściach. Tu jedzie
 * produkcyjny zestaw (`spawnGitStatus`, `spawnGitLog`, `spawnGitArgs` z budżetem liczników) na
 * repozytoriach zakładanych w katalogu tymczasowym — rename, konflikt, ścieżki ze spacją i z „ => ”,
 * binaria i repo bez HEAD to dokładnie te miejsca, w których zmierzone wyjście gita i wyobrażenie
 * o nim najłatwiej się rozjeżdżają.
 *
 * Konfiguracja gita jest odcięta od Maca (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM`):
 * podpisywanie commitów czy `diff.renames=false` z globalnego configu nie mają prawa zmienić wyniku.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitFileDetail } from '@rarog/shared';
import {
  GIT_NUMSTAT_BUDGET_MS, GIT_NUMSTAT_READ_CAP_BYTES, GitStatusWatcher, collectDiff, gitReadEnv,
  probeUntracked, spawnGitArgs, spawnGitLog, spawnGitStatus,
} from '../src/git-status.ts';
import type { GitArgsRunner, GitCollectSample } from '../src/git-status.ts';

let root = '';

const env = (): NodeJS.ProcessEnv => gitReadEnv({
  PATH: process.env['PATH'] ?? '', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});

/** Git do PRZYGOTOWANIA repo (commity bez podpisu, stała tożsamość). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Rarog', '-c', 'user.email=rarog@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', ...args,
  ], { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function repo(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q');
  return dir;
}

async function write(dir: string, file: string, content: string | Buffer): Promise<void> {
  await writeFile(join(dir, file), content);
}

/** Produkcyjny zestaw runnerów, jak w `manager.ts`; `numstat` podmienialny (budżet, atrapa). */
function watcher(
  samples: GitCollectSample[] = [], runNumstat: GitArgsRunner | null = spawnGitArgs(
    env(), GIT_NUMSTAT_BUDGET_MS, GIT_NUMSTAT_READ_CAP_BYTES,
  ),
): GitStatusWatcher {
  return new GitStatusWatcher({
    run: spawnGitStatus(env()), runLog: spawnGitLog(env()), runNumstat, throttleMs: 0,
    onCollect: (sample) => { samples.push(sample); },
  });
}

const byPath = (details: readonly GitFileDetail[] | undefined): Record<string, Omit<GitFileDetail, 'path'>> =>
  Object.fromEntries((details ?? []).map(({ path, ...rest }) => [path, rest]));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-git-details-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fileDetails na prawdziwym gicie', () => {
  it('modyfikacja, staged + unstaged, rename, usunięcie, binaria, spacja, „ => ”, nieśledzony', async () => {
    const dir = await repo('pelne');
    await write(dir, 'plain.txt', 'a\nb\nc\n');
    await write(dir, 'with space.txt', 'x\n');
    await write(dir, 'a => b.txt', 'y\n');
    await write(dir, 'old.ts', 'old\n1\n2\n3\n4\n5\n6\n7\n');
    await write(dir, 'bin.dat', Buffer.from([0, 1, 2]));
    await write(dir, 'staged.txt', 'k\n');
    await write(dir, 'gone.txt', 'd\nd\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'start');

    await write(dir, 'plain.txt', 'a\nB\nc\nd\n');
    await write(dir, 'with space.txt', 'x\nx2\n');
    await write(dir, 'a => b.txt', 'y\ny\n');
    git(dir, 'mv', 'old.ts', 'new.ts');
    await write(dir, 'new.ts', 'new\n1\n2\n3\n4\n5\n6\n7\n8\n');
    await write(dir, 'bin.dat', Buffer.from([0, 3]));
    await write(dir, 'staged.txt', 'k2\n');
    git(dir, 'add', 'staged.txt');
    await write(dir, 'staged.txt', 'k3\nk4\n');
    git(dir, 'rm', '-q', 'gone.txt');
    await write(dir, 'nowy.md', 'n\n');

    const samples: GitCollectSample[] = [];
    const status = await watcher(samples).status(dir);
    expect(status?.fileDetails.map((d) => d.path)).toEqual(status?.files);
    expect(byPath(status?.fileDetails)).toEqual({
      'a => b.txt': { kind: 'modified', linesAdded: 1, linesDeleted: 0 },
      'bin.dat': { kind: 'modified', binary: true },
      'gone.txt': { kind: 'deleted', linesAdded: 0, linesDeleted: 2 },
      // Rename ze źródłem w pathspecu: zmiana, nie dziewięć dodanych linii.
      'new.ts': { kind: 'modified', linesAdded: 2, linesDeleted: 1 },
      'plain.txt': { kind: 'modified', linesAdded: 2, linesDeleted: 1 },
      // Staged + unstaged: HEAD kontra drzewo robocze, czyli obie zmiany naraz.
      'staged.txt': { kind: 'modified', linesAdded: 2, linesDeleted: 1 },
      'with space.txt': { kind: 'modified', linesAdded: 1, linesDeleted: 0 },
      'nowy.md': { kind: 'added' },
    });
    expect(status?.fileKinds).toEqual({ added: 1, modified: 6, deleted: 1 });
    expect(samples.map((s) => s.numstat)).toEqual(['ok']);
  });

  it('konflikt to zmieniony plik z licznikami HEAD kontra drzewo (znaczniki konfliktu)', async () => {
    const dir = await repo('konflikt');
    await write(dir, 'c.txt', 'a\nb\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'start');
    git(dir, 'checkout', '-qb', 'inna');
    await write(dir, 'c.txt', 'a\nINNA\n');
    git(dir, 'commit', '-qam', 'inna');
    git(dir, 'checkout', '-q', 'main');
    await write(dir, 'c.txt', 'a\nMAIN\n');
    git(dir, 'commit', '-qam', 'main');
    expect(() => git(dir, 'merge', '-q', 'inna')).toThrow();

    const status = await watcher().status(dir);
    expect(status?.fileDetails).toEqual([
      { path: 'c.txt', kind: 'modified', linesAdded: 4, linesDeleted: 0 },
    ]);
  });

  it('repo bez HEAD: rodzaje są, liczników nie ma (numstat kończy się kodem 128)', async () => {
    const dir = await repo('bez-head');
    await write(dir, 'q.txt', 'q\n');
    git(dir, 'add', 'q.txt');
    await write(dir, 'r.txt', 'r\n');

    const samples: GitCollectSample[] = [];
    const status = await watcher(samples).status(dir);
    expect(status?.fileDetails).toEqual([
      { path: 'q.txt', kind: 'added' }, { path: 'r.txt', kind: 'added' },
    ]);
    expect(status?.lastCommit).toBeUndefined();
    expect(samples.map((s) => s.numstat)).toEqual(['failed']);
  });

  it('katalog poza repo: brak statusu, numstat nie startuje', async () => {
    const dir = join(root, 'zwykly-katalog');
    await mkdir(dir, { recursive: true });
    const samples: GitCollectSample[] = [];
    expect(await watcher(samples).status(dir)).toBeNull();
    expect(samples.map((s) => s.numstat)).toEqual(['skipped']);
  });

  it('budżet liczników minął: ramka z samymi rodzajami, odczyt nie czeka dłużej', async () => {
    const dir = await repo('budzet');
    await write(dir, 'a.txt', 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'start');
    await write(dir, 'a.txt', 'a\nb\n');

    // Liczniki liczy atrapa `git`, która śpi: prawdziwy git z limitem 1 ms bywał szybszy od zegara (Linux), a tak
    // timeout jest pewny na każdym systemie. Status i log jadą prawdziwym gitem.
    const bin = join(root, 'spiacy-git');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'git'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o755 });
    const samples: GitCollectSample[] = [];
    const status = await watcher(samples, spawnGitArgs(gitReadEnv({ PATH: bin }), 100)).status(dir);
    expect(status?.fileDetails).toEqual([{ path: 'a.txt', kind: 'modified' }]);
    expect(samples.map((s) => s.numstat)).toEqual(['timeout']);
  });

  it('ponad 50 plików: lista i szczegóły ucięte na 50, `dirtyCount` liczy wszystkie', async () => {
    const dir = await repo('duzo');
    for (let i = 0; i < 60; i += 1) await write(dir, `p${String(i).padStart(2, '0')}.txt`, 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'start');
    for (let i = 0; i < 60; i += 1) await write(dir, `p${String(i).padStart(2, '0')}.txt`, 'a\nb\n');

    const status = await watcher().status(dir);
    expect(status?.dirtyCount).toBe(60);
    expect(status?.fileDetails).toHaveLength(50);
    expect(status?.fileDetails.every((d) => d.linesAdded === 1 && d.linesDeleted === 0)).toBe(true);
  });

  /*
   * Bez `--untracked-files=all` nowy katalog byłby jednym wpisem `? docs/` i panel nie
   * pokazałby plików w środku. Zagnieżdżonego repo git nie rozwija — zostaje wpisem z `/`.
   */
  it('nowy katalog: każdy plik osobno, także w podkatalogu; zagnieżdżone repo jednym wpisem', async () => {
    const dir = await repo('nowy-katalog');
    await write(dir, 'a.txt', 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'start');
    await mkdir(join(dir, 'docs', 'sub'), { recursive: true });
    await write(dir, 'docs/a.md', 'a\n');
    await write(dir, 'docs/sub/b.md', 'b\n');
    await mkdir(join(dir, 'pusty'));
    await mkdir(join(dir, 'zagniezdzone'));
    git(join(dir, 'zagniezdzone'), 'init', '-q');
    await write(dir, 'zagniezdzone/q.txt', 'q\n');

    const status = await watcher().status(dir);
    expect(status?.fileDetails).toEqual([
      { path: 'docs/a.md', kind: 'added' },
      { path: 'docs/sub/b.md', kind: 'added' },
      { path: 'zagniezdzone/', kind: 'added' },
    ]);
    expect(status?.fileKinds).toEqual({ added: 3, modified: 0, deleted: 0 });
  });

  it('sufit 50 przy dużym nowym katalogu: zmiana śledzona zostaje na liście', async () => {
    const dir = await repo('duzy-nowy-katalog');
    await write(dir, 'z.txt', 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'start');
    await write(dir, 'z.txt', 'a\nb\n');
    await mkdir(join(dir, 'build'));
    for (let i = 0; i < 60; i += 1) await write(dir, `build/f${String(i).padStart(2, '0')}.txt`, 'f\n');

    const status = await watcher().status(dir);
    expect(status?.dirtyCount).toBe(61);
    expect(status?.fileDetails).toHaveLength(50);
    expect(status?.fileDetails[0]).toEqual({ path: 'z.txt', kind: 'modified', linesAdded: 1, linesDeleted: 0 });
  });

  /*
   * `git status` z podkatalogu daje ścieżki względem KATALOGU SESJI (`src/x.ts`,
   * `../top.txt`), a `numstat` bez `--relative` — względem korzenia (`server/src/x.ts`). Liczniki
   * chybiały, a przy tej samej nazwie w korzeniu trafiały do cudzego pliku.
   */
  it('sesja w podkatalogu repo: liczniki swoich plików, `../` bez liczników, kolizja nazw bez pomyłki', async () => {
    const dir = await repo('podkatalog');
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'server', 'src'), { recursive: true });
    await write(dir, 'src/x.ts', 'a\n');
    await write(dir, 'src/y.ts', 'y\n1\n2\n3\n');
    await write(dir, 'server/src/x.ts', 's\n');
    await write(dir, 'server/old.ts', 'o\n1\n2\n3\n4\n5\n6\n7\n');
    await write(dir, 'top.txt', 't\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'start');
    // Ta sama ścieżka `src/x.ts` w korzeniu (+2) i w podkatalogu (+1) — liczniki nie mogą się zamienić.
    await write(dir, 'src/x.ts', 'a\nA\nA\n');
    await write(dir, 'server/src/x.ts', 's\nS\n');
    await write(dir, 'top.txt', 't\nT\n');
    git(dir, 'mv', 'server/old.ts', 'server/new.ts');
    await write(dir, 'server/new.ts', 'n\n1\n2\n3\n4\n5\n6\n7\n');
    // Rename PRZEZ granicę katalogu sesji: `--relative` nie widzi źródła, więc liczników nie ma.
    git(dir, 'mv', 'src/y.ts', 'server/moved.ts');

    const status = await watcher().status(join(dir, 'server'));
    expect(status?.files.sort()).toEqual(['../src/x.ts', '../top.txt', 'moved.ts', 'new.ts', 'src/x.ts']);
    expect(byPath(status?.fileDetails)).toEqual({
      'src/x.ts': { kind: 'modified', linesAdded: 1, linesDeleted: 0 },
      'new.ts': { kind: 'modified', linesAdded: 1, linesDeleted: 1 },
      'moved.ts': { kind: 'modified' },
      '../src/x.ts': { kind: 'modified' },
      '../top.txt': { kind: 'modified' },
    });
  });

  /*
   * Rename z CYTOWANYM źródłem (nie-ASCII) i zwykłym celem. Źródło wypadało
   * z pathspeców, cel zostawał — git nie widział rename'u i liczył cały nowy plik jako dodany.
   */
  it('rename z cytowanym źródłem: wpis bez liczników — bez zmiany treści i z małą edycją', async () => {
    const lines = Array.from({ length: 99 }, (_, i) => `linia ${String(i)}`).join('\n');
    for (const [name, edit] of [['rename-czysty', false], ['rename-edycja', true]] as const) {
      const dir = await repo(name);
      await write(dir, 'zaż.txt', `${lines}\n`);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'start');
      git(dir, 'mv', 'zaż.txt', 'new.ts');
      if (edit) await write(dir, 'new.ts', `${lines.replace('linia 5\n', 'linia piąta\n')}\n`);

      const status = await watcher().status(dir);
      expect(status?.fileDetails, name).toEqual([{ path: 'new.ts', kind: 'modified' }]);
    }
  });

  it('ścieżka nie-ASCII (cytowana przez git): zostaje na liście bez liczników', async () => {
    const dir = await repo('unicode');
    await write(dir, 'zażółć.txt', 'z\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'start');
    await write(dir, 'zażółć.txt', 'z\nz\n');

    const status = await watcher().status(dir);
    expect(status?.fileDetails).toEqual([
      { path: '"za\\305\\274\\303\\263\\305\\202\\304\\207.txt"', kind: 'modified' },
    ]);
  });
});

/*
 * Diff sesji a dowiązania. `git diff --no-index -- /dev/null <ścieżka>` sprawdza ścieżkę
 * przez `stat`: dla dowiązania do katalogu porównuje `/dev/null` z `<dowiązanie>/null` i oddaje treść pliku
 * spoza repo. Test stawia dokładnie ten układ na prawdziwym gicie.
 */
describe('collectDiff na prawdziwym gicie: nieśledzone dowiązania', () => {
  it('dowiązanie do katalogu poza repo z plikiem `null` nie oddaje jego treści', async () => {
    const dir = await repo('dowiazania');
    await write(dir, 'plain.txt', 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const outside = join(root, 'poza-repo');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'null'), 'TAJNE-SPOZA-REPO\n');
    await writeFile(join(outside, 'cel.txt'), 'TRESC-CELU\n');
    await symlink(outside, join(dir, 'do-katalogu'));
    await symlink(join(outside, 'cel.txt'), join(dir, 'do-pliku'));
    await write(dir, 'nowy.txt', 'nowa linia\n');

    // Układ naprawdę jest groźny: sam git oddaje tu treść spoza repo.
    let raw = '';
    try {
      raw = git(dir, 'diff', '--no-ext-diff', '--no-index', '--', '/dev/null', 'do-katalogu');
    } catch (err) {
      raw = String((err as { stdout?: unknown }).stdout ?? '');
    }
    expect(raw).toContain('TAJNE-SPOZA-REPO');

    const diff = await collectDiff(dir, { run: spawnGitArgs(env()) });
    expect(diff.patch).not.toContain('TAJNE-SPOZA-REPO');
    expect(diff.patch).not.toContain('TRESC-CELU');
    // Dowiązania stoją na liście z celem jako jedyną linią; zwykły plik idzie przez gita jak dotąd.
    expect(diff.files.map((file) => file.path).sort()).toEqual(['do-katalogu', 'do-pliku', 'nowy.txt']);
    expect(diff.patch).toContain(`+++ b/do-katalogu\n@@ -0,0 +1 @@\n+${outside}\n`);
    expect(diff.patch).toContain(`+++ b/do-pliku\n@@ -0,0 +1 @@\n+${join(outside, 'cel.txt')}\n`);
    expect(diff.patch).toContain('+nowa linia');
  });

  it('katalog podmieniony na dowiązanie po wypisaniu listy: plik pod nim nie jest zwykłym plikiem repo', async () => {
    const dir = await repo('podmiana');
    const outside = join(root, 'poza-podmiana');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'new.txt'), 'TAJNE-SPOZA-REPO\n');
    await mkdir(join(dir, 'prawdziwy'), { recursive: true });
    await write(dir, 'prawdziwy/new.txt', 'w repo\n');
    await symlink(outside, join(dir, 'podmieniony'));

    expect(await probeUntracked(dir, 'prawdziwy/new.txt')).toEqual({ kind: 'file' });
    // `lstat` samej ścieżki widzi zwykły plik; odpada dopiero po rozwiązaniu katalogu nadrzędnego.
    expect(await probeUntracked(dir, 'podmieniony/new.txt')).toEqual({ kind: 'other' });
    expect(await probeUntracked(dir, 'nie-ma/new.txt')).toEqual({ kind: 'other' });
  });
});

/*
 * Sesja w podkatalogu repo: gdy korzeniem Raroga jest tylko `repo/public`, diff nie może oddać
 * zmian z `repo/private`. `--relative` ogranicza wszystkie trzy odczyty do katalogu sesji.
 */
describe('collectDiff na prawdziwym gicie: sesja w podkatalogu repo', () => {
  it('diff obejmuje wyłącznie katalog sesji, ścieżki względem niego', async () => {
    const dir = await repo('podkatalog');
    await mkdir(join(dir, 'public'), { recursive: true });
    await mkdir(join(dir, 'private'), { recursive: true });
    await write(dir, 'public/a.txt', 'a\n');
    await write(dir, 'private/secret.txt', 'stare\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    await write(dir, 'public/a.txt', 'a\nb\n');
    await write(dir, 'private/secret.txt', 'TAJNE-Z-KATALOGU-OBOK\n');
    await write(dir, 'private/nowy.txt', 'NIESLEDZONY-OBOK\n');

    const diff = await collectDiff(join(dir, 'public'), { run: spawnGitArgs(env()) });
    expect(diff.files).toEqual([{ path: 'a.txt', status: 'M', linesAdded: 1, linesDeleted: 0 }]);
    expect(diff.patch).toContain('diff --git a/a.txt b/a.txt');
    expect(diff.patch).not.toContain('TAJNE-Z-KATALOGU-OBOK');
    expect(diff.patch).not.toContain('NIESLEDZONY-OBOK');
    expect(diff.patch).not.toContain('secret.txt');

    // Z korzenia repo widać wszystko — zawężenie dotyczy katalogu sesji, nie repozytorium.
    const whole = await collectDiff(dir, { run: spawnGitArgs(env()) });
    expect(whole.files.map((file) => file.path).sort())
      .toEqual(['private/nowy.txt', 'private/secret.txt', 'public/a.txt']);
  });
});
