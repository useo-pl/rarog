/**
 * Diff sesji per plik na PRAWDZIWYM gicie.
 *
 * `git-diff.test.ts` wstrzykuje atrapę runnera i pilnuje logiki na zmierzonych wyjściach. Tu jedzie
 * produkcyjny runner (`spawnGitArgs`) na repozytoriach zakładanych w katalogu tymczasowym: rename,
 * źródło, które stało się katalogiem, zmiana typu pliku, dowiązania poza repo, pliki ignorowane
 * i nazwy, które psują adres URL — to miejsca, w których wyobrażenie o gicie najłatwiej rozjeżdża
 * się z gitem. Ostatni blok prowadzi te nazwy przez prawdziwy router.
 *
 * Konfiguracja gita jest odcięta od Maca (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM`),
 * jak w `git-file-details.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, diffFileListSchema, diffFilePatchSchema } from '@rarog/shared';
import type { DiffFileList, DiffFilePatch } from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import {
  DiffError, collectDiffFile, collectDiffList, headProbeArgs, nameStatusArgs, trackedPatchArgs, untrackedArgs,
  untrackedPatchArgs,
} from '../src/git-diff.ts';
import {
  GIT_NUMSTAT_BUDGET_MS, collectDiff, gitArgv, gitReadEnv, numstatArgs, spawnGitArgs, spawnGitLog, spawnGitStatus,
} from '../src/git-status.ts';
import type { GitArgsRunner, GitCommand } from '../src/git-status.ts';
import { createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

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
  await mkdir(join(dir, file, '..'), { recursive: true });
  await writeFile(join(dir, file), content);
}

function commitAll(dir: string, message = 'start'): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
}

/** Produkcyjne runnery, jak w `manager.ts`: listy i patch z limitem 5 s, liczniki z własnym budżetem. */
const run = (): GitArgsRunner => spawnGitArgs(env());
const list = (cwd: string): Promise<DiffFileList> => collectDiffList(cwd, {
  run: run(), runNumstat: spawnGitArgs(env(), GIT_NUMSTAT_BUDGET_MS),
});
const file = (cwd: string, path: string): Promise<DiffFilePatch> => collectDiffFile(cwd, path, { run: run() });

/** Kod odmowy kolektora albo `null`, gdy obietnica się spełniła. */
async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(DiffError);
    return (error as DiffError).code;
  }
}

/** Runner, który po wskazanym wywołaniu gita zmienia repo — wyścig między listą a patchem. */
function racing(after: (command: GitCommand) => boolean, change: () => Promise<void>): GitArgsRunner {
  const real = run();
  return async (command, cwd) => {
    const result = await real(command, cwd);
    if (after(command)) await change();
    return result;
  };
}

const blocks = (patch: string): number => patch.split('\n').filter((line) => line.startsWith('diff --git ')).length;

/** Nazwy, które psują adres URL albo cytowanie gita: plus, spacja, procent, `&`, `#`, tabulator, nie-ASCII. */
const AWKWARD = ['a+b.ts', 'ze spacją.txt', '100%.txt', 'a&b=c.txt', 'x#y.txt', 'tab\there.txt', 'zażółć.txt', '?q=1.txt'];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-git-diff-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('collectDiffList na prawdziwym gicie', () => {
  it('śledzone z licznikami i rename po ścieżce docelowej, binarny, nieśledzone bez liczników, ignorowane poza listą', async () => {
    const dir = await repo('lista');
    await write(dir, 'plain.txt', 'a\nb\nc\n');
    await write(dir, 'old.ts', 'old\n1\n2\n3\n4\n5\n6\n7\n');
    await write(dir, 'bin.dat', Buffer.from([0, 1, 2]));
    await write(dir, 'gone.txt', 'd\nd\n');
    await write(dir, 'bez-zmian.txt', 'stoi\n');
    await write(dir, '.gitignore', '.env\n');
    commitAll(dir);

    await write(dir, 'plain.txt', 'a\nB\nc\nd\n');
    git(dir, 'mv', 'old.ts', 'new.ts');
    await write(dir, 'new.ts', 'old\n1\n2\n3\n4\n5\n6\n7\n8\n');
    await write(dir, 'bin.dat', Buffer.from([0, 3]));
    git(dir, 'rm', '-q', 'gone.txt');
    await write(dir, '.env', 'SEKRET=1\n');
    await write(dir, 'docs/nowy.md', 'n\n');
    await write(dir, 'za ż+%&#.txt', 'u\n');

    const result = await list(dir);
    expect(result.truncated).toBe(false);
    // Klucze liczników (`numstat -z`) to te same ścieżki co `name-status -z` — założenie planu.
    expect(result.files).toEqual([
      { path: 'bin.dat', status: 'M', binary: true },
      { path: 'gone.txt', status: 'D', linesAdded: 0, linesDeleted: 2 },
      { path: 'new.ts', status: 'M', linesAdded: 1, linesDeleted: 0 },
      { path: 'plain.txt', status: 'M', linesAdded: 2, linesDeleted: 1 },
      { path: 'docs/nowy.md', status: 'A' },
      { path: 'za ż+%&#.txt', status: 'A' },
    ]);
    expect(diffFileListSchema.parse(result)).toEqual(result);
  });

  it('repo bez HEAD: same nieśledzone; katalog spoza repo: pusta lista', async () => {
    const dir = await repo('bez-head');
    await write(dir, 'q.txt', 'q\n');
    git(dir, 'add', 'q.txt');
    await write(dir, 'r.txt', 'r\n');
    // Plik dodany do indeksu nie stoi ani w `diff HEAD`, ani w `ls-files --others` — znana luka.
    expect(await list(dir)).toEqual({ files: [{ path: 'r.txt', status: 'A' }], truncated: false });
    expect((await file(dir, 'r.txt')).patch).toContain('+r\n');
    expect(await failure(file(dir, 'q.txt'))).toBe('diff-file-not-found');

    const plain = join(root, 'zwykly-katalog');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'x.txt'), 'x\n');
    expect(await list(plain)).toEqual({ files: [], truncated: false });
    expect(await failure(file(plain, 'x.txt'))).toBe('diff-file-not-found');
  });

  it('limit czasu gita to git-failed — lista nie udaje pustej, plik nie udaje 404', async () => {
    const dir = await repo('limit');
    await write(dir, 'a.txt', 'a\n');
    commitAll(dir);
    await write(dir, 'a.txt', 'a\nb\n');
    // Atrapa `git`, która śpi: timeout jest pewny na każdym systemie (prawdziwy git z limitem 1 ms bywał
    // szybszy od zegara na Linuksie), a test nie czeka.
    const bin = join(root, 'spiacy-git');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'git'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o755 });
    const late = spawnGitArgs({ ...env(), PATH: bin }, 100);
    expect(await failure(collectDiffList(dir, { run: late }))).toBe('git-failed');
    expect(await failure(collectDiffFile(dir, 'a.txt', { run: late }))).toBe('git-failed');
    // Sam budżet liczników: lista jest, liczników nie ma.
    expect(await collectDiffList(dir, { run: run(), runNumstat: late }))
      .toEqual({ files: [{ path: 'a.txt', status: 'M' }], truncated: false });
  });

  it('sesja w podkatalogu repo: lista i patch tylko z katalogu sesji, ścieżki względem niego', async () => {
    const dir = await repo('podkatalog');
    await write(dir, 'public/a.txt', 'a\n');
    await write(dir, 'private/secret.txt', 'stare\n');
    commitAll(dir);
    await write(dir, 'public/a.txt', 'a\nb\n');
    await write(dir, 'private/secret.txt', 'TAJNE-Z-KATALOGU-OBOK\n');
    await write(dir, 'private/nowy.txt', 'NIESLEDZONY-OBOK\n');
    const session = join(dir, 'public');

    expect(await list(session)).toEqual({
      files: [{ path: 'a.txt', status: 'M', linesAdded: 1, linesDeleted: 0 }], truncated: false,
    });
    expect((await file(session, 'a.txt')).patch).toContain('diff --git a/a.txt b/a.txt');
    // Plik z katalogu obok nie ma postaci, którą dałoby się o niego zapytać.
    expect(await failure(file(session, '../private/secret.txt'))).toBe('bad-path');
    expect(await failure(file(session, 'private/secret.txt'))).toBe('diff-file-not-found');
    expect(await failure(file(session, 'secret.txt'))).toBe('diff-file-not-found');
  });
});

describe('collectDiffFile na prawdziwym gicie: pliki śledzone', () => {
  it('rename: patch z `rename from/to` i samą różnicą, źródła nie da się pobrać osobno', async () => {
    const dir = await repo('rename');
    await write(dir, 'old.ts', 'old\n1\n2\n3\n4\n5\n6\n7\n');
    commitAll(dir);
    git(dir, 'mv', 'old.ts', 'new.ts');
    await write(dir, 'new.ts', 'old\n1\n2\n3\n4\n5\n6\n7\n8\n');

    const result = await file(dir, 'new.ts');
    expect(result.path).toBe('new.ts');
    expect(result.truncated).toBe(false);
    expect(result.patch).toContain('rename from old.ts\nrename to new.ts\n');
    expect(result.patch).toContain('\n+8\n');
    // Bez źródła w pathspecu git pokazałby dziewięć dodanych linii — tu jest jedna.
    expect(result.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')))
      .toEqual(['+8']);
    expect(diffFilePatchSchema.parse(result)).toEqual(result);
    expect(await failure(file(dir, 'old.ts'))).toBe('diff-file-not-found');
  });

  it('rename ze źródłem, które stało się katalogiem (`old/extra`): bez cudzych bloków', async () => {
    const dir = await repo('rename-katalog');
    await write(dir, 'old', 'old\n1\n2\n3\n4\n5\n6\n7\n');
    commitAll(dir);
    git(dir, 'mv', 'old', 'new');
    await write(dir, 'old/extra', 'TRESC-CUDZEGO-PLIKU\n');
    git(dir, 'add', 'old/extra');

    // Układ naprawdę wciąga cudzy plik: pathspec źródła dopasowuje też potomków katalogu.
    const raw = git(dir, '--literal-pathspecs', 'diff', '--no-ext-diff', '--relative', 'HEAD', '--', 'new', 'old');
    expect(blocks(raw)).toBe(2);
    expect(raw).toContain('TRESC-CUDZEGO-PLIKU');

    const result = await file(dir, 'new');
    expect(blocks(result.patch)).toBe(1);
    expect(result.patch).not.toContain('TRESC-CUDZEGO-PLIKU');
    // Bez źródła plik pokazuje się jako nowy w całości.
    expect(result.patch).toContain('new file mode 100644');
    expect((await list(dir)).files.map((entry) => entry.path)).toEqual(['new', 'old/extra']);
    expect(blocks((await file(dir, 'old/extra')).patch)).toBe(1);
  });

  /*
   * `diff.renames=copies` w konfiguracji repo: git zgłasza kopię (`C`), a jej źródło jest osobną,
   * zmienioną pozycją listy. Źródło w pathspecu dołożyłoby do patcha kopii blok tamtego pliku.
   */
  it('kopia ze źródłem, które samo jest pozycją listy: patch kopii bez bloku źródła', async () => {
    const dir = await repo('kopia');
    await write(dir, 'old.ts', Array.from({ length: 30 }, (_, i) => `linia ${String(i)}\n`).join(''));
    commitAll(dir);
    git(dir, 'config', 'diff.renames', 'copies');
    await write(dir, 'new.ts', Array.from({ length: 30 }, (_, i) => `linia ${String(i)}\n`).join(''));
    await write(dir, 'old.ts', `${Array.from({ length: 30 }, (_, i) => `linia ${String(i)}\n`).join('')}ZMIANA-ZRODLA\n`);
    git(dir, 'add', '-A');

    const raw = git(dir, '--literal-pathspecs', 'diff', '--no-ext-diff', '--relative', 'HEAD', '--', 'new.ts', 'old.ts');
    expect(blocks(raw)).toBe(2);
    expect((await list(dir)).files.map((entry) => [entry.path, entry.status]))
      .toEqual([['new.ts', 'A'], ['old.ts', 'M']]);

    const result = await file(dir, 'new.ts');
    expect(blocks(result.patch)).toBe(1);
    expect(result.patch).not.toContain('ZMIANA-ZRODLA');
    expect((await file(dir, 'old.ts')).patch).toContain('+ZMIANA-ZRODLA\n');
  });

  /*
   * Znane ograniczenie (`docs/implementation-spec.md`, „Per-file diff”): pathspec dopasowuje też potomków
   * katalogu, więc wpis usuniętego pliku, którego miejsce zajął katalog, niesie także bloki plików
   * spod niego. To dalej wyłącznie zmiany z listy tego samego katalogu sesji.
   */
  it('plik zastąpiony katalogiem: patch usuniętego pliku niesie też bloki spod katalogu', async () => {
    const dir = await repo('plik-katalog');
    await write(dir, 'typ', 'x\n');
    commitAll(dir);
    await unlink(join(dir, 'typ'));
    await write(dir, 'typ/x', 'y\n');
    git(dir, 'add', '-A');

    expect((await list(dir)).files.map((entry) => [entry.path, entry.status]))
      .toEqual([['typ', 'D'], ['typ/x', 'A']]);
    expect(blocks((await file(dir, 'typ')).patch)).toBe(2);
    expect(blocks((await file(dir, 'typ/x')).patch)).toBe(1);
  });

  it('zmiana typu pliku (zwykły plik → dowiązanie): dwa bloki pod jedną ścieżką', async () => {
    const dir = await repo('typ');
    await write(dir, 'plain.txt', 'a\n');
    await write(dir, 'typ', 'x\n');
    commitAll(dir);
    await unlink(join(dir, 'typ'));
    await symlink('plain.txt', join(dir, 'typ'));

    expect((await list(dir)).files).toEqual([{ path: 'typ', status: 'M', linesAdded: 1, linesDeleted: 1 }]);
    const result = await file(dir, 'typ');
    expect(blocks(result.patch)).toBe(2);
    expect(result.patch).toContain('deleted file mode 100644');
    expect(result.patch).toContain('new file mode 120000');
  });

  it('nazwa z gwiazdką to ŚCIEŻKA, nie wzorzec: jeden blok, nie wszystkie pasujące pliki', async () => {
    const dir = await repo('wzorzec');
    await write(dir, 'a.md', 'a\n');
    await write(dir, 'b.md', 'b\n');
    await write(dir, '*.md', 'gwiazdka\n');
    commitAll(dir);
    await write(dir, 'a.md', 'a\nTRESC-A\n');
    await write(dir, 'b.md', 'b\nTRESC-B\n');
    await write(dir, '*.md', 'gwiazdka\nTRESC-GWIAZDKI\n');

    const result = await file(dir, '*.md');
    expect(blocks(result.patch)).toBe(1);
    expect(result.patch).toContain('TRESC-GWIAZDKI');
    expect(result.patch).not.toContain('TRESC-A');
    // Magia pathspeców też jest ścieżką: takiego pliku nie ma, więc nie ma go na liście.
    expect(await failure(file(dir, ':(glob)**'))).toBe('diff-file-not-found');
    expect(await failure(file(dir, ':/'))).toBe('bad-path');
  });

  it('konflikt scalania i submoduł: patch względem HEAD', async () => {
    const dir = await repo('konflikt');
    await write(dir, 'c.txt', 'a\nb\n');
    commitAll(dir);
    git(dir, 'checkout', '-qb', 'inna');
    await write(dir, 'c.txt', 'a\nINNA\n');
    git(dir, 'commit', '-qam', 'inna');
    git(dir, 'checkout', '-q', 'main');
    await write(dir, 'c.txt', 'a\nMAIN\n');
    git(dir, 'commit', '-qam', 'main');
    expect(() => git(dir, 'merge', '-q', 'inna')).toThrow();
    const conflict = await file(dir, 'c.txt');
    expect(conflict.patch).toContain('+<<<<<<< HEAD\n');
    expect(conflict.patch).toContain('+>>>>>>> inna\n');

    // Zagnieżdżone repo dodane jako gitlink: git pokazuje zmianę commita, nie plików w środku.
    const outer = await repo('submodul');
    const inner = await repo('submodul/mod');
    await write(inner, 'f', '1\n');
    commitAll(inner, 'one');
    git(outer, 'add', 'mod');
    git(outer, 'commit', '-qm', 'outer');
    await write(inner, 'f', '2\n');
    commitAll(inner, 'two');
    expect((await list(outer)).files.map((entry) => entry.path)).toEqual(['mod']);
    const submodule = await file(outer, 'mod');
    expect(submodule.patch).toMatch(/-Subproject commit [0-9a-f]{40}\n\+Subproject commit [0-9a-f]{40}\n/);
  });

  it('plik bez zmian i plik ignorowany to diff-file-not-found', async () => {
    const dir = await repo('spoza-listy');
    await write(dir, 'bez-zmian.txt', 'stoi\n');
    await write(dir, 'a.txt', 'a\n');
    await write(dir, '.gitignore', '.env\n');
    commitAll(dir);
    await write(dir, 'a.txt', 'a\nb\n');
    await write(dir, '.env', 'SEKRET-IGNOROWANY=1\n');

    expect(await failure(file(dir, 'bez-zmian.txt'))).toBe('diff-file-not-found');
    expect(await failure(file(dir, '.env'))).toBe('diff-file-not-found');
    expect(await failure(file(dir, '.git/config'))).toBe('diff-file-not-found');
    expect((await file(dir, 'a.txt')).patch).toContain('+b\n');
  });

  it('HEAD przesunięty między listą a patchem: zmiany już nie ma, więc 404', async () => {
    const dir = await repo('wyscig-head');
    await write(dir, 'a.txt', 'a\n');
    commitAll(dir);
    await write(dir, 'a.txt', 'a\nb\n');
    const runner = racing((command) => command.rest.includes('--name-status'), async () => { commitAll(dir, 'po liście'); });
    expect(await failure(collectDiffFile(dir, 'a.txt', { run: runner }))).toBe('diff-file-not-found');
  });

  it('duży plik: cięcie do sufitu z truncated, a sufit odczytu procesu też daje truncated', async () => {
    const dir = await repo('duzy');
    await write(dir, 'big.txt', 'start\n');
    commitAll(dir);
    await write(dir, 'big.txt', `${'x'.repeat(99)}\n`.repeat(9000));

    const clamped = await collectDiffFile(dir, 'big.txt', { run: run(), maxPatchBytes: 64 * 1024 });
    expect(clamped.truncated).toBe(true);
    expect(Buffer.byteLength(clamped.patch, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(clamped.patch.endsWith('\n')).toBe(true);

    // Proces zabity na suficie odczytu (tu 32 kB zamiast 8 MB) oddaje prefiks — plik jest ucięty.
    const capped = await collectDiffFile(dir, 'big.txt', { run: spawnGitArgs(env(), 5_000, 32 * 1024) });
    expect(capped.truncated).toBe(true);
    expect(capped.patch.startsWith('diff --git a/big.txt b/big.txt\n')).toBe(true);
    expect(capped.patch.endsWith('\n')).toBe(true);
    // Mały plik w tym samym repo mieści się cały, niezależnie od dużego obok.
    await write(dir, 'maly.txt', 'm\n');
    expect(await file(dir, 'maly.txt')).toMatchObject({ truncated: false });
  });
});

describe('collectDiffFile na prawdziwym gicie: pliki nieśledzone', () => {
  it('dowiązanie do pliku i do katalogu poza repo: cel jako jedyna linia, treść spoza repo nie wychodzi', async () => {
    const dir = await repo('dowiazania');
    await write(dir, 'plain.txt', 'a\n');
    commitAll(dir);
    const outside = join(root, 'poza-repo');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'null'), 'TAJNE-SPOZA-REPO\n');
    await writeFile(join(outside, 'cel.txt'), 'TRESC-CELU\n');
    await symlink(outside, join(dir, 'do-katalogu'));
    await symlink(join(outside, 'cel.txt'), join(dir, 'do-pliku'));
    await write(dir, 'nowy.txt', 'nowa linia\n');

    expect((await list(dir)).files).toEqual([
      { path: 'do-katalogu', status: 'A' }, { path: 'do-pliku', status: 'A' }, { path: 'nowy.txt', status: 'A' },
    ]);
    const toDir = await file(dir, 'do-katalogu');
    expect(toDir.patch).toContain(`new file mode 120000\n--- /dev/null\n+++ b/do-katalogu\n@@ -0,0 +1 @@\n+${outside}\n`);
    expect(toDir.patch).not.toContain('TAJNE-SPOZA-REPO');
    const toFile = await file(dir, 'do-pliku');
    expect(toFile.patch).toContain(`+${join(outside, 'cel.txt')}\n`);
    expect(toFile.patch).not.toContain('TRESC-CELU');
    expect((await file(dir, 'nowy.txt')).patch).toContain('+nowa linia\n');
    // `ls-files` nie schodzi w dowiązanie, więc pliku pod nim nie ma na liście.
    expect(await failure(file(dir, 'do-katalogu/null'))).toBe('diff-file-not-found');
    expect(await failure(file(dir, 'do-katalogu/cel.txt'))).toBe('diff-file-not-found');
  });

  it('katalog podmieniony na dowiązanie PO wypisaniu listy: 404, treść spoza repo nie wychodzi', async () => {
    const dir = await repo('podmiana');
    await write(dir, 'plain.txt', 'a\n');
    commitAll(dir);
    const outside = join(root, 'poza-podmiana');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'new.txt'), 'TAJNE-SPOZA-REPO\n');
    await write(dir, 'pod/new.txt', 'w repo\n');

    const calls: string[][] = [];
    const real = racing((command) => command.sub === 'ls-files', async () => {
      await rename(join(dir, 'pod'), join(dir, 'pod-odsuniety'));
      await symlink(outside, join(dir, 'pod'));
    });
    const runner: GitArgsRunner = (command, cwd) => { calls.push(gitArgv(command)); return real(command, cwd); };
    expect(await failure(collectDiffFile(dir, 'pod/new.txt', { run: runner }))).toBe('diff-file-not-found');
    // Git nie dostał tej ścieżki do odczytu: `--no-index` nie wystartował.
    expect(calls.some((args) => args.includes('--no-index'))).toBe(false);
  });

  it('plik usunięty między listą a patchem: 404 przed gitem i po nim', async () => {
    const dir = await repo('wyscig-plik');
    await write(dir, 'plain.txt', 'a\n');
    commitAll(dir);
    const gone = (): GitArgsRunner => racing((command) => command.sub === 'ls-files', () => unlink(join(dir, 'nowy.txt')));
    // Plik znika zaraz po wypisaniu listy: sonda (`lstat`) już go nie widzi.
    await write(dir, 'nowy.txt', 'n\n');
    expect(await failure(collectDiffFile(dir, 'nowy.txt', { run: gone() }))).toBe('diff-file-not-found');
    // Sonda widziała plik, git już nie: `--no-index` kończy się kodem 1 z pustym wyjściem.
    await write(dir, 'nowy.txt', 'n\n');
    const calls: string[][] = [];
    const racer = gone();
    expect(await failure(collectDiffFile(dir, 'nowy.txt', {
      run: (command, cwd) => { calls.push(gitArgv(command)); return racer(command, cwd); },
      probe: () => Promise.resolve({ kind: 'file' }),
    }))).toBe('diff-file-not-found');
    expect(calls.some((args) => args.includes('--no-index'))).toBe(true);
  });

  it('`git rm --cached`: jeden wpis na liście, w patchu blok usunięcia i blok pliku z dysku', async () => {
    const dir = await repo('rm-cached');
    await write(dir, 'x.txt', 'stare\n');
    commitAll(dir);
    git(dir, 'rm', '-q', '--cached', 'x.txt');
    await write(dir, 'x.txt', 'nowe\n');

    expect((await list(dir)).files).toEqual([{ path: 'x.txt', status: 'D', linesAdded: 0, linesDeleted: 1 }]);
    const result = await file(dir, 'x.txt');
    expect(blocks(result.patch)).toBe(2);
    expect(result.patch).toContain('deleted file mode 100644');
    expect(result.patch).toContain('-stare\n');
    expect(result.patch).toContain('+nowe\n');
  });
});

/*
 * Adres: `new URL('…?path=src/a+b.ts').searchParams.get('path')` oddaje `src/a b.ts` — plus w adresie
 * to spacja. Klient koduje ścieżkę (`encodeURIComponent`: `+` → `%2B`, `#` → `%23`, tabulator →
 * `%09`), a serwer musi oddać gitowi dokładnie tę nazwę, którą git wypisał na liście.
 */
/*
 * Trzy przypadki brzegowe, każdy na prawdziwym gicie.
 */
describe('błąd konfiguracji gita, zagnieżdżone repo, nazwa dowiązania z tabulatorem', () => {
  it('`diff HEAD` z kodem 128 przy istniejącym HEAD to git-failed, nie pusta lista ani 404', async () => {
    const dir = await repo('zla-konfiguracja');
    await write(dir, 'a.txt', 'a\n');
    commitAll(dir);
    await write(dir, 'a.txt', 'a\nb\n');
    await write(dir, 'nowy.txt', 'n\n');
    /*
     * `diff.orderFile` na nieistniejący plik: `git diff` kończy się 128, `ls-files` odpowiada. Wpis idzie do
     * konfiguracji repo, bo runner nie przyjmuje `-c` od wołającego (osłony konfiguracji stoją pierwsze).
     */
    const broken = run();
    const nameStatus: GitCommand = { sub: 'diff', rest: ['--name-status', 'HEAD'] };
    expect((await broken(nameStatus, dir)).ok).toBe(true);
    git(dir, 'config', 'diff.orderFile', '/nie-ma-takiego-pliku');
    expect((await broken(nameStatus, dir)).exitCode).toBe(128);

    expect(await failure(collectDiffList(dir, { run: broken }))).toBe('git-failed');
    expect(await failure(collectDiffFile(dir, 'a.txt', { run: broken }))).toBe('git-failed');
    expect(await failure(collectDiffFile(dir, 'nowy.txt', { run: broken }))).toBe('git-failed');
  });

  it('nieśledzone zagnieżdżone repozytorium nie wchodzi na listę', async () => {
    const dir = await repo('z-zagniezdzonym');
    await write(dir, 'a.txt', 'a\n');
    commitAll(dir);
    const nested = await repo('z-zagniezdzonym/nested');
    await write(nested, 'w-srodku.txt', 'x\n');
    commitAll(nested);
    await write(dir, 'obok.txt', 'o\n');
    // Sam git wypisuje tu katalog z ukośnikiem.
    expect(git(dir, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')).toContain('nested/');

    expect((await list(dir)).files.map((entry) => entry.path)).toEqual(['obok.txt']);
    expect(await failure(file(dir, 'nested/'))).toBe('bad-path');
    expect(await failure(file(dir, 'nested/w-srodku.txt'))).toBe('diff-file-not-found');
  });

  it('dowiązanie z tabulatorem w nazwie: blok serwera przechodzi przez parser gita', async () => {
    const dir = await repo('dowiazanie-tab');
    await write(dir, 'a.txt', 'a\n');
    commitAll(dir);
    await symlink('a.txt', join(dir, 'na\tme'));
    const patch = (await file(dir, 'na\tme')).patch;
    expect(patch.startsWith('diff --git "a/na\\tme" "b/na\\tme"\n')).toBe(true);
    const numstat = execFileSync('git', ['apply', '--numstat', '-z', '-'], {
      cwd: dir, env: env(), input: patch, encoding: 'utf8',
    });
    expect(numstat).toBe('1\t0\tna\tme\0');
  });
});

/*
 * Repository config that an agent in the sandbox writes (`.git/config` of the repo next to the work tree,
 * `.gitattributes`) can start programs on Rarog's reads: `core.fsmonitor` on every command, `diff.<drv>.textconv`
 * on a patch, `gpg.program` on `git log` with `log.showSignature=true` and a signed commit (the signature need not
 * be real: verification starts the program anyway), `filter.<drv>.clean` on the diff of a file changed in the tree.
 * Markers instead of harmful code: each program appends its name to a file. The control at the start shows that
 * plain git starts them — without it the test would also pass on a broken setup.
 */
describe('konfiguracja repo nie uruchamia programów przy odczytach Raroga', () => {
  let dir = '';
  let firedLog = '';

  async function fired(read: () => Promise<unknown>): Promise<string[]> {
    await rm(firedLog, { force: true });
    await read();
    const text = await readFile(firedLog, 'utf8').catch(() => '');
    return [...new Set(text.split('\n').filter((line) => line !== ''))].sort();
  }

  beforeAll(async () => {
    dir = await repo('markery');
    firedLog = join(root, 'markery.log');
    const marker = async (name: string, body: string): Promise<string> => {
      const path = join(root, `marker-${name}.sh`);
      await writeFile(path, `#!/bin/sh\necho ${name} >> '${firedLog}'\n${body}\n`, { mode: 0o755 });
      return path;
    };
    const programs = {
      fsmonitor: await marker('fsmonitor', 'exit 1'),
      textconv: await marker('textconv', 'cat "$1"'),
      clean: await marker('clean', 'cat'),
      gpg: await marker('gpg', 'exit 1'),
    };
    await write(dir, '.gitattributes', '*.txt diff=marker filter=marker\n');
    await write(dir, 'a.txt', 'a\n');
    commitAll(dir);
    // Commit z nagłówkiem `gpgsig` bez prawdziwego klucza: `git log` z `log.showSignature` i tak go weryfikuje.
    const signed = git(dir, 'cat-file', 'commit', 'HEAD').replace(
      /^(committer .*)$/m, '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQ==\n -----END PGP SIGNATURE-----',
    );
    const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: dir, env: env(), input: signed, encoding: 'utf8',
    }).trim();
    git(dir, 'update-ref', 'HEAD', sha);
    git(dir, 'config', 'core.fsmonitor', programs.fsmonitor);
    git(dir, 'config', 'diff.marker.textconv', programs.textconv);
    git(dir, 'config', 'filter.marker.clean', programs.clean);
    git(dir, 'config', 'log.showSignature', 'true');
    git(dir, 'config', 'gpg.program', programs.gpg);
    await write(dir, 'a.txt', 'a\nb\n');
    await write(dir, 'nowy.txt', 'n\n');
  });

  it('kontrola: goły git odpala fsmonitor, textconv i gpg (układ naprawdę jest groźny)', async () => {
    expect(await fired(async () => { git(dir, 'status', '--porcelain=v2'); })).toContain('fsmonitor');
    expect(await fired(async () => { git(dir, 'log', '-1', '--format=%h'); })).toContain('gpg');
    expect(await fired(async () => { git(dir, 'diff', 'HEAD', '--', 'a.txt'); })).toContain('textconv');
  });

  it('żaden odczyt Raroga nie odpala fsmonitor, textconv ani gpg; dane dalej przychodzą', async () => {
    const reads: Record<string, () => Promise<unknown>> = {
      'status': () => spawnGitStatus(env())(dir),
      'log -1': () => spawnGitLog(env())(dir),
      'numstat': () => run()(numstatArgs(['a.txt']), dir),
      'name-status': () => run()(nameStatusArgs(), dir),
      'ls-files': () => run()(untrackedArgs(), dir),
      'rev-parse': () => run()(headProbeArgs(), dir),
      'diff pliku śledzonego': () => run()(trackedPatchArgs('a.txt'), dir),
      'diff pliku nieśledzonego': () => run()(untrackedPatchArgs('nowy.txt'), dir),
      'diff sesji (stara trasa)': () => collectDiff(dir, { run: run() }),
      'lista zmian': () => list(dir),
    };
    for (const [name, read] of Object.entries(reads)) expect(await fired(read), name).toEqual([]);
    expect((await spawnGitLog(env())(dir)).stdout).toMatch(/^[0-9a-f]+\u001f/);
    expect((await file(dir, 'a.txt')).patch).toContain('+b\n');
  });

  /*
   * The `clean` filter is no longer an open boundary (`docs/security-model.md`, "Git reads"): the runner empties
   * every filter driver it finds in the config before git starts. Plain git still runs it on the same diff.
   */
  it('`clean` from repository config does not run on a diff of the working tree', async () => {
    expect(await fired(async () => { git(dir, 'diff', 'HEAD', '--', 'a.txt'); }), 'control').toContain('clean');
    expect(await fired(() => run()(trackedPatchArgs('a.txt'), dir))).toEqual([]);
  });
});

describe('nazwy plików przez router: lista gita → adres → patch tego samego pliku', () => {
  class RepoManager extends FakeManager {
    readonly cwd: string;

    constructor(cwd: string) {
      super([makeSummary({ id: 's1', cwd })]);
      this.cwd = cwd;
    }

    override async diffFiles(): Promise<DiffFileList> { return list(this.cwd); }

    override async diffFile(_id: string, path: string): Promise<DiffFilePatch> { return file(this.cwd, path); }
  }

  it('plus, spacja, procent, `&`, `#`, tabulator i znaki spoza ASCII dochodzą do gita bez zmiany', async () => {
    const dir = await repo('adres');
    await write(dir, 'plain.txt', 'a\n');
    for (const name of AWKWARD.slice(0, 4)) await write(dir, name, 'stare\n');
    commitAll(dir);
    // Połowa śledzona (patch z `diff HEAD`), połowa nieśledzona (`--no-index`).
    for (const name of AWKWARD) await write(dir, name, `TRESC ${JSON.stringify(name)}\n`);

    const config = loadConfig({ RAROG_DEMO: '1' });
    const device = createTestDevice(config.dataDir, { epoch: config.epoch });
    const manager = new RepoManager(dir);
    const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
    hub.start();
    const server = http.createServer(createRouter({
      config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(),
      logger: { info: () => {}, error: () => {} }, devices: device.identity,
    }));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/sessions/s1/diff`;
    const headers = device.headers;
    try {
      const listed = diffFileListSchema.parse(await (await fetch(`${base}/files`, { headers })).json());
      expect(listed.files.map((entry) => entry.path).sort()).toEqual([...AWKWARD].sort());

      for (const entry of listed.files) {
        const res = await fetch(`${base}/file?path=${encodeURIComponent(entry.path)}`, { headers });
        expect(res.status, entry.path).toBe(200);
        const body = diffFilePatchSchema.parse(await res.json());
        // Ścieżka wraca co do znaku, a patch niesie treść TEGO pliku.
        expect(body.path).toBe(entry.path);
        expect(body.patch, entry.path).toContain(`+TRESC ${JSON.stringify(entry.path)}\n`);
        expect(blocks(body.patch), entry.path).toBe(1);
      }

      // Plus NIEZAKODOWANY to spacja: pliku `a b.ts` nie ma, więc 404 — nigdy cudzy plik.
      const plus = await fetch(`${base}/file?path=a+b.ts`, { headers });
      expect(plus.status).toBe(404);
      expect(await plus.json()).toMatchObject({ error: 'diff-file-not-found' });
      for (const [query, status, error] of [
        ['?path=../plain.txt', 400, 'bad-path'], ['?path=%2Fetc%2Fhosts', 400, 'bad-path'],
        ['?path=a%00b', 400, 'bad-path'], ['', 400, 'bad-path'], ['?path=', 400, 'bad-path'],
        ['?path=plain.txt', 404, 'diff-file-not-found'], ['?path=.git%2Fconfig', 404, 'diff-file-not-found'],
      ] as const) {
        const res = await fetch(`${base}/file${query}`, { headers });
        expect(res.status, query).toBe(status);
        expect(await res.json(), query).toMatchObject({ error });
      }
    } finally {
      hub.closeAll();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }
  });
});
