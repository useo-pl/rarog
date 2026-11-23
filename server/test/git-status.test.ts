/**
 * Parser `git status --porcelain=v2 --branch` + throttle.
 *
 * Testy NIE odpalają prawdziwego gita — runner jest wstrzykiwany. Wyjątek: blok `spawnGitArgs` (sam runner) biegnie
 * w repo z `git init` w katalogu tymczasowym.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_DIFF_PATCH_BYTES } from '@rarog/shared';
import {
  DETACHED_BRANCH, GIT_LOG_FORMAT, GitStatusWatcher, clampPatch, collectDiff, gitReadEnv,
  numstatPath, parseGitLog, parseGitStatusV2, parseNameStatus, parseNumstatFiles, parseNumstatZ,
  parsePorcelain, gitArgv, numstatArgs, spawnGitArgs, symlinkPatch,
} from '../src/git-status.ts';
import type { GitArgsRunner, GitCommand, GitRunnerProbe } from '../src/git-status.ts';

/** Osłony konfiguracji przed każdą podkomendą — dosłownie, żeby asercje argv przypinały flagi. */
const G = [
  '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'safe.bareRepository=explicit',
  '-c', 'core.hooksPath=/dev/null', '-c', 'diff.submodule=short',
];

/** `diff` with the runner's own flags, before the caller's arguments. */
const D = ['diff', '--no-textconv', '--no-ext-diff', '--ignore-submodules=dirty'];

const SAMPLE = [
  '# branch.oid 8f4c1d2a',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -0',
  '1 .M N... 100644 100644 100644 8f4c1d2a 8f4c1d2a src/notes.ts',
  '2 R. N... 100644 100644 100644 8f4c1d2a 8f4c1d2a R100 src/new.ts\tsrc/old.ts',
  'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
  '? untracked.txt',
  '! dist/bundle.js',
  '',
].join('\n');

describe('parseGitStatusV2', () => {
  it('czyta gałąź, liczbę brudnych plików i nazwy', () => {
    const status = parseGitStatusV2(SAMPLE);

    expect(status.branch).toBe('main');
    // 1 + 2 + u + ? = 4; wpis `!` (ignorowany przez gita) NIE liczy się jako brudny.
    expect(status.dirtyCount).toBe(4);
    expect(status.files).toEqual([
      'src/notes.ts', 'src/new.ts', 'src/conflict.ts', 'untracked.txt',
    ]);
  });

  it('czyste repo to zero brudnych plików', () => {
    const status = parseGitStatusV2('# branch.oid abc\n# branch.head feat/bridge\n');
    expect(status).toEqual({
      branch: 'feat/bridge', dirtyCount: 0, files: [],
      fileKinds: { added: 0, modified: 0, deleted: 0 },
      // Pusta lista, nie brak pola: czyste repo to WIEDZA „nic się nie zmieniło".
      fileDetails: [],
    });
  });

  it('czyta ahead/behind z „# branch.ab +X -Y"', () => {
    expect(parseGitStatusV2(SAMPLE)).toMatchObject({ ahead: 1, behind: 0 });
    expect(parseGitStatusV2([
      '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -3',
    ].join('\n'))).toMatchObject({ ahead: 0, behind: 3 });
    expect(parseGitStatusV2([
      '# branch.head main', '# branch.upstream origin/main', '# branch.ab +12 -7', '? a.txt',
    ].join('\n'))).toMatchObject({ ahead: 12, behind: 7, dirtyCount: 1 });
  });

  it('brak upstreamu = BRAK pól ahead/behind (nie zera)', () => {
    const status = parseGitStatusV2('# branch.oid abc\n# branch.head feat/bridge\n? a.txt\n');
    expect(status.ahead).toBeUndefined();
    expect(status.behind).toBeUndefined();
    expect(Object.keys(status).sort())
      .toEqual(['branch', 'dirtyCount', 'fileDetails', 'fileKinds', 'files']);
  });

  it('uszkodzony nagłówek branch.ab jest ignorowany, reszta się parsuje', () => {
    const status = parseGitStatusV2('# branch.head main\n# branch.ab dziwne\n? a.txt\n');
    expect(status.ahead).toBeUndefined();
    expect(status).toMatchObject({ branch: 'main', dirtyCount: 1 });
  });

  it('detached HEAD nie wywraca parsera', () => {
    const status = parseGitStatusV2('# branch.oid abc\n# branch.head (detached)\n? a.txt\n');
    expect(status.branch).toBe('(detached)');
    expect(status.dirtyCount).toBe(1);
  });

  it('brak nagłówka branch.head daje etykietę detached', () => {
    expect(parseGitStatusV2('? a.txt\n').branch).toBe(DETACHED_BRANCH);
  });

  it('przycina listę plików do limitu, ale liczy wszystkie', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `? plik-${i}.txt`).join('\n');
    const status = parseGitStatusV2(lines, 3);
    expect(status.dirtyCount).toBe(10);
    expect(status.files).toHaveLength(3);
  });
});

/**
 * Trójka rodzajów (`fileKinds`) — to ona zastąpiła w nagłówku sumy linii.
 *
 * Jeden przebieg parsera liczy i pliki, i rodzaje, więc test pilnuje przede wszystkim
 * NIEZMIENNIKA: suma trójki równa się `dirtyCount`. Gdyby któraś litera wypadła z klasyfikacji,
 * linia nagłówka pokazywałaby mniej plików, niż jest brudnych.
 */
describe('parseGitStatusV2 — rodzaje brudnych plików', () => {
  const kinds = (lines: string[]): ReturnType<typeof parseGitStatusV2>['fileKinds'] =>
    parseGitStatusV2(lines.join('\n')).fileKinds;

  it('nieśledzony (`?`) jest DODANY — jeszcze nie ma go w HEAD', () => {
    expect(kinds(['? nowy.txt'])).toEqual({ added: 1, modified: 0, deleted: 0 });
  });

  it('litera `A` (dodany do indeksu) też jest dodaniem, także z drugą literą', () => {
    const line = (xy: string): string => `1 ${xy} N... 100644 100644 100644 aaa bbb a.ts`;
    expect(kinds([line('A.')])).toEqual({ added: 1, modified: 0, deleted: 0 });
    expect(kinds([line('AM')])).toEqual({ added: 1, modified: 0, deleted: 0 });
  });

  it('litera `D` wygrywa z resztą — plik usunięty to usunięty', () => {
    const line = (xy: string): string => `1 ${xy} N... 100644 100644 000000 aaa bbb a.ts`;
    expect(kinds([line('.D')])).toEqual({ added: 0, modified: 0, deleted: 1 });
    expect(kinds([line('D.')])).toEqual({ added: 0, modified: 0, deleted: 1 });
    expect(kinds([line('AD')])).toEqual({ added: 0, modified: 0, deleted: 1 });
  });

  it('modyfikacja, rename i konflikt liczą się jako ZMIENIONE', () => {
    expect(kinds(['1 .M N... 100644 100644 100644 aaa bbb a.ts']))
      .toEqual({ added: 0, modified: 1, deleted: 0 });
    expect(kinds(['2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts']))
      .toEqual({ added: 0, modified: 1, deleted: 0 });
    expect(kinds(['u UU N... 100644 100644 100644 100644 aaa bbb ccc a.ts']))
      .toEqual({ added: 0, modified: 1, deleted: 0 });
  });

  it('suma trójki równa się dirtyCount (wpis `!` nie liczy się nigdzie)', () => {
    const status = parseGitStatusV2(SAMPLE);
    const { added, modified, deleted } = status.fileKinds;
    expect(added + modified + deleted).toBe(status.dirtyCount);
    // SAMPLE: rename + konflikt = 2 zmienione, nieśledzony = 1 dodany.
    expect(status.fileKinds).toEqual({ added: 1, modified: 3, deleted: 0 });
  });

  it('czyste repo ma trójkę zer, a nie brak pola', () => {
    expect(kinds(['# branch.head main'])).toEqual({ added: 0, modified: 0, deleted: 0 });
  });
});

/**
 * Szczegóły plików (`fileDetails`) powstają w TEJ SAMEJ pętli co `files`: ta sama kolejność,
 * ten sam sufit, ta sama postać ścieżki i ta sama klasyfikacja co trójka `fileKinds`.
 */
describe('parsePorcelain — szczegóły plików i ścieżki dla numstat', () => {
  it('rodzaj każdego pliku = jego szufladka w trójce; kolejność i ścieżki jak `files`', () => {
    const { status } = parsePorcelain(SAMPLE);
    expect(status.fileDetails).toEqual([
      { path: 'src/notes.ts', kind: 'modified' },
      { path: 'src/new.ts', kind: 'modified' },
      { path: 'src/conflict.ts', kind: 'modified' },
      { path: 'untracked.txt', kind: 'added' },
    ]);
    expect(status.fileDetails.map((d) => d.path)).toEqual(status.files);
    expect(parseGitStatusV2(SAMPLE)).toEqual(status);
  });

  it('numstat pyta o śledzone wpisy z listy, przy rename także o ścieżkę źródłową, bez nieśledzonych', () => {
    expect(parsePorcelain(SAMPLE).pathspecs).toEqual([
      'src/notes.ts', 'src/new.ts', 'src/old.ts', 'src/conflict.ts',
    ]);
  });

  it('dodany, usunięty i staged + unstaged (`MM`) dostają rodzaj z pola XY', () => {
    const line = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 aaa bbb ${path}`;
    const { status, pathspecs } = parsePorcelain([
      line('A.', 'nowy.ts'), line('.D', 'stary.ts'), line('MM', 'oba.ts'),
    ].join('\n'));
    expect(status.fileDetails.map((d) => d.kind)).toEqual(['added', 'deleted', 'modified']);
    // Dodany do indeksu jest w HEAD-diffie (cały plik jako dodane linie) — liczymy go.
    expect(pathspecs).toEqual(['nowy.ts', 'stary.ts', 'oba.ts']);
  });

  it('sufit listy obejmuje też szczegóły i ścieżki numstat (licznik `dirtyCount` liczy wszystko)', () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      `1 .M N... 100644 100644 100644 aaa bbb src/plik-${String(i)}.ts`).join('\n');
    const { status, pathspecs } = parsePorcelain(lines, 50);
    expect(status.dirtyCount).toBe(60);
    expect(status.files).toHaveLength(50);
    expect(status.fileDetails).toHaveLength(50);
    expect(pathspecs).toHaveLength(50);
    expect(pathspecs.at(-1)).toBe('src/plik-49.ts');
  });

  it('ścieżka cytowana (`core.quotePath`) zostaje na liście, ale nie idzie do numstat', () => {
    const quoted = '"za\\305\\274\\303\\263\\305\\202\\304\\207.txt"';
    const { status, pathspecs } = parsePorcelain(`1 .M N... 100644 100644 100644 aaa bbb ${quoted}`);
    expect(status.fileDetails).toEqual([{ path: quoted, kind: 'modified' }]);
    expect(pathspecs).toEqual([]);
  });

  it('sesja w podkatalogu: wpisy spoza niego (`../`) zostają na liście, ale nie idą do numstat', () => {
    const { status, pathspecs } = parsePorcelain([
      '1 .M N... 100644 100644 100644 aaa bbb src/x.ts',
      '1 .M N... 100644 100644 100644 aaa bbb ../src/x.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 moved.ts\t../src/y.ts',
    ].join('\n'));
    expect(status.files).toEqual(['src/x.ts', '../src/x.ts', 'moved.ts']);
    expect(pathspecs).toEqual(['src/x.ts']);
  });

  it('rename liczy się w całości albo wcale: cytowane źródło zdejmuje też cel', () => {
    const quoted = '"za\\305\\274.txt"';
    const { status, pathspecs } = parsePorcelain([
      `2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\t${quoted}`,
      `2 R. N... 100644 100644 100644 aaa bbb R100 ${quoted}\told.ts`,
    ].join('\n'));
    expect(status.files).toEqual(['new.ts', quoted]);
    expect(pathspecs).toEqual([]);
  });

  it('spacja i dosłowne „ => ” w nazwie to zwykła ścieżka', () => {
    const { status, pathspecs } = parsePorcelain([
      '1 .M N... 100644 100644 100644 aaa bbb with space.txt',
      '1 .M N... 100644 100644 100644 aaa bbb a => b.txt',
    ].join('\n'));
    expect(status.files).toEqual(['with space.txt', 'a => b.txt']);
    expect(pathspecs).toEqual(['with space.txt', 'a => b.txt']);
  });
});

/** Wyjście `git diff --numstat -z` zmierzone na git 2.54 (pola rozdziela NUL). */
const NUMSTAT_Z = [
  '1\t0\ta => b.txt', '-\t-\tbin.dat', '0\t2\tgone.txt', '2\t1\t', 'old.ts', 'new.ts',
  '2\t1\tplain.txt', '1\t0\twith space.txt', '',
].join('\0');

describe('parseNumstatZ', () => {
  it('liczniki, binaria BEZ liczników, rename po ścieżce docelowej, dosłowne „ => ”', () => {
    expect(Object.fromEntries(parseNumstatZ(NUMSTAT_Z))).toEqual({
      'a => b.txt': { linesAdded: 1, linesDeleted: 0 },
      'bin.dat': { binary: true },
      'gone.txt': { linesAdded: 0, linesDeleted: 2 },
      'new.ts': { linesAdded: 2, linesDeleted: 1 },
      'plain.txt': { linesAdded: 2, linesDeleted: 1 },
      'with space.txt': { linesAdded: 1, linesDeleted: 0 },
    });
  });

  it('ucięte wyjście: rekord bez kończącego NUL (także rename bez ścieżki docelowej) odpada', () => {
    expect([...parseNumstatZ('2\t1\tplain.txt\x003\t4\tpol').keys()]).toEqual(['plain.txt']);
    expect([...parseNumstatZ('2\t1\tplain.txt\x002\t1\t\x00old.ts\x00ne').keys()]).toEqual(['plain.txt']);
    expect(parseNumstatZ('').size).toBe(0);
    expect(parseNumstatZ('śmieci\x00').size).toBe(0);
  });

  it('numstat diffu sesji (bez `-z`) dalej daje binariom zera — wynik `collectDiff` bez zmian', () => {
    expect(parseNumstatFiles('-\t-\tassets/logo.png\n')).toEqual([
      { path: 'assets/logo.png', linesAdded: 0, linesDeleted: 0 },
    ]);
  });
});

describe('GitStatusWatcher — liczniki linii (`fileDetails`)', () => {
  const status = [
    '# branch.head main',
    '1 .M N... 100644 100644 100644 aaa bbb plain.txt',
    '1 .M N... 100644 100644 100644 aaa bbb bin.dat',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts',
    '? nowy.md',
  ].join('\n');
  const run = async (): Promise<{ ok: boolean; stdout: string }> => ({ ok: true, stdout: status });

  it('dokłada liczniki i binarność do wpisów; nieśledzony zostaje z samym rodzajem', async () => {
    const calls: string[][] = [];
    const watcher = new GitStatusWatcher({
      run,
      runNumstat: (command) => {
        calls.push(gitArgv(command));
        return Promise.resolve({ ok: true, stdout: NUMSTAT_Z });
      },
      now: () => 0,
    });
    expect((await watcher.status('/repo'))?.fileDetails).toEqual([
      { path: 'plain.txt', kind: 'modified', linesAdded: 2, linesDeleted: 1 },
      { path: 'bin.dat', kind: 'modified', binary: true },
      { path: 'new.ts', kind: 'modified', linesAdded: 2, linesDeleted: 1 },
      { path: 'nowy.md', kind: 'added' },
    ]);
    expect(calls).toEqual([[
      ...G, '--literal-pathspecs', ...D, '--no-ext-diff', '--relative', '--numstat', '-z', 'HEAD',
      '--', 'plain.txt', 'bin.dat', 'new.ts', 'old.ts',
    ]]);
  });

  it('czyste repo i same nieśledzone: numstat NIE startuje', async () => {
    const runNumstat = vi.fn(async () => ({ ok: true, stdout: '' }));
    const samples: string[] = [];
    for (const stdout of ['# branch.head main\n', '# branch.head main\n? a.txt\n']) {
      const watcher = new GitStatusWatcher({
        run: async () => ({ ok: true, stdout }), runNumstat, now: () => 0,
        onCollect: (sample) => { samples.push(sample.numstat); },
      });
      await watcher.status('/repo');
    }
    expect(runNumstat).not.toHaveBeenCalled();
    expect(samples).toEqual(['skipped', 'skipped']);
  });

  it('timeout, błąd (repo bez HEAD, kod 128) i wyjątek: ramka z samymi rodzajami, nigdy zera', async () => {
    const outcomes: string[] = [];
    for (const runNumstat of [
      () => Promise.resolve({ ok: false, stdout: '2\t1\tplain.txt\0', timedOut: true }),
      () => Promise.resolve({ ok: false, stdout: '' }),
      () => Promise.reject(new Error('spawn EAGAIN')),
    ]) {
      const watcher = new GitStatusWatcher({
        run, runNumstat, now: () => 0, onCollect: (sample) => { outcomes.push(sample.numstat); },
      });
      const details = (await watcher.status('/repo'))?.fileDetails ?? [];
      expect(details.map((d) => Object.keys(d).sort())).toEqual(Array(4).fill(['kind', 'path']));
    }
    expect(outcomes).toEqual(['timeout', 'failed', 'failed']);
  });

  it('bez runnera liczników (`RAROG_GIT_FILE_DETAILS=0`, testy) zostają same rodzaje', async () => {
    const watcher = new GitStatusWatcher({ run, now: () => 0 });
    expect((await watcher.status('/repo'))?.fileDetails.every((d) => d.linesAdded === undefined)).toBe(true);
  });

  it('czas odczytu idzie do `onCollect` (status + log + numstat), także przy porażce statusu', async () => {
    let clock = 1_000;
    const samples: { ms: number; numstat: string }[] = [];
    const watcher = new GitStatusWatcher({
      run: async () => { clock += 40; return { ok: true, stdout: status }; },
      runNumstat: async () => { clock += 25; return { ok: true, stdout: NUMSTAT_Z }; },
      now: () => clock, throttleMs: 0, onCollect: (sample) => { samples.push(sample); },
    });
    await watcher.status('/repo');
    const broken = new GitStatusWatcher({
      run: async () => ({ ok: false, stdout: '' }), now: () => clock,
      onCollect: (sample) => { samples.push(sample); },
    });
    await broken.status('/nie-repo');
    expect(samples).toEqual([{ ms: 65, numstat: 'ok' }, { ms: 0, numstat: 'skipped' }]);
  });
});

describe('GitStatusWatcher — throttle', () => {
  it('drugie pytanie w oknie throttle zwraca null (bez odpalania gita)', async () => {
    let now = 1_000;
    const run = vi.fn(async () => ({ ok: true, stdout: SAMPLE }));
    const watcher = new GitStatusWatcher({
      run, throttleMs: 3_000, now: () => now,
    });

    expect(await watcher.status('/repo')).not.toBeNull();
    expect(await watcher.status('/repo')).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);

    now += 3_000;
    expect(await watcher.status('/repo')).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('throttle jest per katalog', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: SAMPLE }));
    const watcher = new GitStatusWatcher({
      run, throttleMs: 3_000, now: () => 1_000,
    });

    await watcher.status('/repo-a');
    await watcher.status('/repo-b');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('nieudany git (nie-repo, brak binarki) daje null zamiast wyjątku', async () => {
    const watcher = new GitStatusWatcher({
      run: async () => ({ ok: false, stdout: '' }),
      now: () => 0,
    });
    expect(await watcher.status('/nie-repo')).toBeNull();
  });

  it('wyjątek runnera nie wycieka do wołającego', async () => {
    const watcher = new GitStatusWatcher({
      run: () => Promise.reject(new Error('spawn EACCES')),
      now: () => 0,
    });
    expect(await watcher.status('/repo')).toBeNull();
  });

  it('forget() kasuje pamięć throttle', async () => {
    let now = 0;
    const run = vi.fn(async () => ({ ok: true, stdout: SAMPLE }));
    const watcher = new GitStatusWatcher({
      run, throttleMs: 5_000, now: () => now,
    });

    await watcher.status('/repo');
    now += 10;
    watcher.forget('/repo');
    await watcher.status('/repo');

    expect(run).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Diff sesji
// ---------------------------------------------------------------------------

const DIFF_NUMSTAT = [
  '2\t2\tsrc/notes.ts',
  '9\t0\tsrc/notes.test.ts',
  '0\t14\tsrc/stary.ts',
  '-\t-\tassets/logo.png',
  '3\t1\tsrc/{a => b}/plik.ts',
  '',
].join('\n');

const DIFF_NAME_STATUS = [
  'M\tsrc/notes.ts',
  'A\tsrc/notes.test.ts',
  'D\tsrc/stary.ts',
  'M\tassets/logo.png',
  'R096\tsrc/a/plik.ts\tsrc/b/plik.ts',
  '',
].join('\n');

const PATCH = 'diff --git a/src/notes.ts b/src/notes.ts\n@@\n-stare\n+nowe\n';

/** Runner odpowiadający per zestaw argumentów — tak jak prawdziwy git. */
function diffRunner(
  overrides: Partial<Record<
    'patch' | 'numstat' | 'nameStatus' | 'untracked' | 'noIndex', { ok: boolean; stdout: string }
  >> = {},
): GitArgsRunner {
  return (command) => {
    const args = command.rest;
    if (command.sub === 'ls-files') {
      return Promise.resolve(overrides.untracked ?? { ok: true, stdout: '' });
    }
    if (args.includes('--no-index')) {
      // Prawdziwy `git diff --no-index` przy różnicy kończy się kodem 1 — stąd ok: false.
      return Promise.resolve(overrides.noIndex ?? { ok: false, stdout: '' });
    }
    if (args.includes('--numstat')) {
      return Promise.resolve(overrides.numstat ?? { ok: true, stdout: DIFF_NUMSTAT });
    }
    if (args.includes('--name-status')) {
      return Promise.resolve(overrides.nameStatus ?? { ok: true, stdout: DIFF_NAME_STATUS });
    }
    return Promise.resolve(overrides.patch ?? { ok: true, stdout: PATCH });
  };
}

describe('GitStatusWatcher — koalescencja wymuszonych odczytów', () => {
  it('N wymuszeń w oknie lecącego odczytu to JEDEN odczyt po nim, nie N po kolei', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((r) => { release = r; });
      return { ok: true, stdout: SAMPLE };
    });
    const watcher = new GitStatusWatcher({ run, throttleMs: 0, now: () => 0 });

    const first = watcher.status('/repo');
    // Pięć sesji jednego katalogu kończy tury w tej samej sekundzie.
    const forced = [1, 2, 3, 4, 5].map(() => watcher.status('/repo', true));
    release();
    await Promise.all([first, ...forced]);

    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('parseNumstatFiles', () => {
  it('czyta liczniki i ścieżki, binaria zostają z zerami', () => {
    expect(parseNumstatFiles(DIFF_NUMSTAT)).toEqual([
      { path: 'src/notes.ts', linesAdded: 2, linesDeleted: 2 },
      { path: 'src/notes.test.ts', linesAdded: 9, linesDeleted: 0 },
      { path: 'src/stary.ts', linesAdded: 0, linesDeleted: 14 },
      { path: 'assets/logo.png', linesAdded: 0, linesDeleted: 0 },
      { path: 'src/b/plik.ts', linesAdded: 3, linesDeleted: 1 },
    ]);
  });

  it('rozwija rename w obu zapisach gita', () => {
    expect(numstatPath('src/{a => b}/plik.ts')).toBe('src/b/plik.ts');
    expect(numstatPath('stary.ts => nowy.ts')).toBe('nowy.ts');
    expect(numstatPath('zwykly.ts')).toBe('zwykly.ts');
  });
});

describe('parseNameStatus', () => {
  it('mapuje litery gita na A/M/D (rename → M pliku docelowego)', () => {
    const map = parseNameStatus(DIFF_NAME_STATUS);

    expect(map.get('src/notes.ts')).toBe('M');
    expect(map.get('src/notes.test.ts')).toBe('A');
    expect(map.get('src/stary.ts')).toBe('D');
    expect(map.get('src/b/plik.ts')).toBe('M');
  });

  it('kopia liczy się jako nowy plik', () => {
    expect(parseNameStatus('C080\tstary.ts\tkopia.ts').get('kopia.ts')).toBe('A');
  });
});

describe('clampPatch', () => {
  it('nie rusza patcha mieszczącego się w limicie', () => {
    expect(clampPatch(PATCH)).toEqual({ patch: PATCH, truncated: false });
  });

  it('tnie po granicy linii i ustawia truncated', () => {
    const big = `${'+'.repeat(99)}\n`.repeat(20);
    const clamped = clampPatch(big, 500);

    expect(clamped.truncated).toBe(true);
    expect(Buffer.byteLength(clamped.patch, 'utf8')).toBeLessThanOrEqual(500);
    expect(clamped.patch.endsWith('\n')).toBe(true);
    // Żadnej połówki linii — każda zachowana linia ma pełną długość.
    for (const line of clamped.patch.split('\n').filter((l) => l !== '')) {
      expect(line).toHaveLength(99);
    }
  });

  it('limit ze speca to 512 kB', () => {
    expect(MAX_DIFF_PATCH_BYTES).toBe(512 * 1024);
  });
});

describe('collectDiff', () => {
  it('skleja numstat + name-status + patch w jedną odpowiedź', async () => {
    const diff = await collectDiff('/repo', { run: diffRunner() });

    expect(diff.patch).toBe(PATCH);
    expect(diff.truncated).toBe(false);
    expect(diff.files).toEqual([
      { path: 'src/notes.ts', status: 'M', linesAdded: 2, linesDeleted: 2 },
      { path: 'src/notes.test.ts', status: 'A', linesAdded: 9, linesDeleted: 0 },
      { path: 'src/stary.ts', status: 'D', linesAdded: 0, linesDeleted: 14 },
      { path: 'assets/logo.png', status: 'M', linesAdded: 0, linesDeleted: 0 },
      { path: 'src/b/plik.ts', status: 'M', linesAdded: 3, linesDeleted: 1 },
    ]);
  });

  it('pyta gita o `diff HEAD` w trzech formatach plus listę nieśledzonych (bez sieci)', async () => {
    const calls: string[][] = [];
    await collectDiff('/repo', {
      run: (command, cwd) => {
        expect(cwd).toBe('/repo');
        calls.push(gitArgv(command));
        return Promise.resolve({ ok: true, stdout: '' });
      },
    });

    // `--relative` w każdym z trzech: diff obejmuje wyłącznie katalog sesji; osłony konfiguracji.
    expect(calls).toEqual([
      [...G, ...D, '--no-ext-diff', '--relative', 'HEAD'],
      [...G, ...D, '--no-ext-diff', '--relative', '--numstat', 'HEAD'],
      [...G, ...D, '--no-ext-diff', '--relative', '--name-status', 'HEAD'],
      [...G, 'ls-files', '--others', '--exclude-standard'],
    ]);
    // Ani jednego `fetch`/`remote` — diff jest w 100% lokalny.
    expect(calls.flat()).not.toContain('fetch');
  });

  /*
   * Plik NIEŚLEDZONY: `git diff HEAD` go nie pokazuje, a `git status` liczy — bez niego overlay mówiłby
   * „0 plików" przy liczniku „1 plik". Kod wyjścia `--no-index` przy
   * różnicy to 1 (`ok: false`) — liczy się stdout.
   */
  it('plik nieśledzony wchodzi do diffa jako A z patchem z --no-index', async () => {
    const noIndexPatch = 'diff --git a/docs/plan.md b/docs/plan.md\n'
      + 'new file mode 100644\n--- /dev/null\n+++ b/docs/plan.md\n@@\n+linia 1\n+linia 2\n';
    const diff = await collectDiff('/repo', {
      run: diffRunner({
        untracked: { ok: true, stdout: 'docs/plan.md\n' },
        noIndex: { ok: false, stdout: noIndexPatch },
      }),
      probe: () => Promise.resolve({ kind: 'file' }),
    });

    expect(diff.files.at(-1)).toEqual({
      path: 'docs/plan.md', status: 'A', linesAdded: 2, linesDeleted: 0,
    });
    expect(diff.patch.endsWith(noIndexPatch)).toBe(true);
  });

  /*
   * `git diff --no-index -- /dev/null <dowiązanie do katalogu>` porównuje `/dev/null`
   * z `<dowiązanie>/null`, czyli czyta plik spoza repo. Do `--no-index`
   * idzie więc wyłącznie zwykły plik; dowiązanie dostaje blok złożony przez serwer.
   */
  it('nieśledzone dowiązanie nie idzie do --no-index: blok z celem składa serwer', async () => {
    const calls: string[][] = [];
    const runner = diffRunner({ untracked: { ok: true, stdout: 'link\nkatalog\nplik.txt\n' } });
    const diff = await collectDiff('/repo', {
      run: (command, cwd) => { calls.push(gitArgv(command)); return runner(command, cwd); },
      probe: (_cwd, path) => Promise.resolve(
        path === 'link' ? { kind: 'symlink', target: '/Users/u/poza-repo' }
          : path === 'katalog' ? { kind: 'other' } : { kind: 'file' },
      ),
    });

    const noIndex = calls.filter((args) => args.includes('--no-index'));
    expect(noIndex).toEqual([[...G, ...D, '--no-ext-diff', '--no-index', '--', '/dev/null', 'plik.txt']]);
    expect(diff.files).toContainEqual({ path: 'link', status: 'A', linesAdded: 1, linesDeleted: 0 });
    expect(diff.files.map((file) => file.path)).not.toContain('katalog');
    expect(diff.patch).toContain(
      'diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n'
      + '@@ -0,0 +1 @@\n+/Users/u/poza-repo\n\\ No newline at end of file\n',
    );
  });

  it('wpis, którego nie ma na dysku, jest pomijany (domyślny odczyt rodzaju przez lstat)', async () => {
    const calls: string[][] = [];
    const runner = diffRunner({ untracked: { ok: true, stdout: 'nie-ma-takiego-pliku.txt\n' } });
    const diff = await collectDiff('/katalog-ktorego-nie-ma', {
      run: (command, cwd) => { calls.push(gitArgv(command)); return runner(command, cwd); },
    });

    expect(calls.some((args) => args.includes('--no-index'))).toBe(false);
    expect(diff.files.map((file) => file.path)).not.toContain('nie-ma-takiego-pliku.txt');
  });

  it('blok dowiązania niesie cel dosłownie: każda linia z własnym „+”, bez zamiany znaków', () => {
    expect(symlinkPatch('l', 'cel')).toEqual({
      patch: 'diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n'
        + '@@ -0,0 +1 @@\n+cel\n\\ No newline at end of file\n',
      lines: 1,
    });
    // Nazwa z nową linią jest legalna: dwa różne cele nie mogą dać tego samego bloku.
    const twoLines = symlinkPatch('l', 'a\nb');
    expect(twoLines.lines).toBe(2);
    expect(twoLines.patch).toContain('@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n');
    expect(twoLines.patch).not.toBe(symlinkPatch('l', 'a b').patch);
    // Cel zakończony nową linią nie dostaje znacznika braku nowej linii.
    expect(symlinkPatch('l', 'a\n').patch.endsWith('@@ -0,0 +1 @@\n+a\n')).toBe(true);
  });

  /*
   * Nazwa pliku z nową linią rozrywała nagłówek bloku na dwie linie i mogła dopisać własne linie
   * patcha; git takie nazwy bierze w cudzysłów z sekwencjami C.
   */
  it('blok dowiązania cytuje w nagłówkach nazwę z tabulatorem, nową linią, cudzysłowem i „\\”', () => {
    const tab = symlinkPatch('na\tme', 'cel').patch;
    expect(tab.startsWith('diff --git "a/na\\tme" "b/na\\tme"\nnew file mode 120000\n')).toBe(true);
    expect(tab).toContain('\n+++ "b/na\\tme"\n');
    const injected = symlinkPatch('x\ndiff --git a/inny b/inny\n+podrzucone', 'cel').patch;
    expect(injected.split('\n').filter((line) => line.startsWith('diff --git'))).toHaveLength(1);
    expect(injected).toContain('"a/x\\ndiff --git a/inny b/inny\\n+podrzucone"');
    expect(symlinkPatch('a"b\\c\u0001', 'cel').patch).toContain('"a/a\\"b\\\\c\\001"');
    // Zwykła nazwa, także ze spacją i spoza ASCII, zostaje dosłownie.
    expect(symlinkPatch('za ż.txt', 'cel').patch.startsWith('diff --git a/za ż.txt b/za ż.txt\n')).toBe(true);
  });

  it('brak name-status nie gubi plików — status domyślny to M', async () => {
    const diff = await collectDiff('/repo', {
      run: diffRunner({ nameStatus: { ok: false, stdout: '' } }),
    });

    expect(diff.files).toHaveLength(5);
    expect(diff.files.every((f) => f.status === 'M')).toBe(true);
  });

  it('katalog spoza repo daje pusty diff, nie wyjątek', async () => {
    const diff = await collectDiff('/nie-repo', {
      run: () => Promise.resolve({ ok: false, stdout: '' }),
    });

    expect(diff).toEqual({ files: [], patch: '', truncated: false });
  });

  it('wyjątek runnera też nie wycieka', async () => {
    const diff = await collectDiff('/repo', {
      run: () => Promise.reject(new Error('spawn EACCES')),
    });

    expect(diff.files).toEqual([]);
  });

  it('patch ponad limit wraca ucięty z truncated=true', async () => {
    const big = `${'+'.repeat(200)}\n`.repeat(10);
    const diff = await collectDiff('/repo', {
      run: diffRunner({ patch: { ok: true, stdout: big } }),
      maxPatchBytes: 600,
    });

    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.patch, 'utf8')).toBeLessThanOrEqual(600);
    // Lista plików NIE jest ucinana — użytkownik ma wiedzieć, czego patch nie pokazał.
    expect(diff.files).toHaveLength(5);
  });
});

describe('GitStatusWatcher — wymuszony odczyt (po pull/push)', () => {
  it('force pomija throttle', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: SAMPLE }));
    const watcher = new GitStatusWatcher({
      run, throttleMs: 3_000, now: () => 1_000,
    });

    await watcher.status('/repo');
    expect(await watcher.status('/repo')).toBeNull();
    expect(await watcher.status('/repo', true)).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  /*
   * Znalezisko audytu CR-04/APP-06: `status()` sprawdzało `#inFlight` PRZED flagą `force`
   * i oddawało cudzy, już lecący odczyt. Ścieżka produkcyjna: agent domyka tool-call →
   * rusza throttlowany `git status`; w tym oknie użytkownik przytrzymuje Push → wymuszone
   * odświeżenie dostawało stan SPRZED pusha, więc nagłówek dalej pokazywał `↑2`.
   */
  it('force NIE oddaje wyniku odczytu, który wystartował przed akcją', async () => {
    let branch = 'przed-pushem';
    let releaseFirst = (): void => {};
    const first = new Promise<void>((resolve) => { releaseFirst = () => { resolve(); }; });
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      // Git czyta repo w momencie SPAWNU — snapshot bierzemy przed czekaniem, inaczej test
      // udawałby, że pierwszy odczyt zna przyszłość.
      const snapshot = branch;
      if (calls === 1) await first;
      return { ok: true, stdout: `# branch.head ${snapshot}\n` };
    });
    const watcher = new GitStatusWatcher({ run, now: () => 0 });

    const inFlight = watcher.status('/repo');
    // Push zmienia repo w trakcie tamtego odczytu.
    const forced = watcher.status('/repo', true);
    branch = 'po-pushu';
    releaseFirst();

    expect((await inFlight)?.branch).toBe('przed-pushem');
    expect((await forced)?.branch).toBe('po-pushu');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('bez force zwykłe pytanie nadal dołącza się do lecącego odczytu (jeden spawn)', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = () => { resolve(); }; });
    const run = vi.fn(async () => {
      await gate;
      return { ok: true, stdout: SAMPLE };
    });
    const watcher = new GitStatusWatcher({ run, now: () => 0 });

    const a = watcher.status('/repo');
    const b = watcher.status('/repo');
    release();

    expect(await a).toEqual(await b);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Ostatni commit (`git log -1`)
// ---------------------------------------------------------------------------

const LOG_LINE = `5193d1f\u001ffeat(web): widoczne krawędzie chromu — linia między kolumnami\u001f1756890720\n`;

describe('parseGitLog', () => {
  it('czyta skrót, temat i czas commitera (epoka → ISO)', () => {
    expect(parseGitLog(LOG_LINE)).toEqual({
      hash: '5193d1f',
      subject: 'feat(web): widoczne krawędzie chromu — linia między kolumnami',
      at: new Date(1756890720 * 1000).toISOString(),
    });
  });

  it('format wywołania rozdziela pola znakiem US, żeby temat mógł zawierać cokolwiek', () => {
    expect(GIT_LOG_FORMAT).toBe('%h%x1f%s%x1f%ct');
    const withPipes = `abc1234\u001ffix: a | b · c\u001f1756890720`;
    expect(parseGitLog(withPipes)?.subject).toBe('fix: a | b · c');
  });

  it('puste wyjście (repo bez commitów) i śmieci dają null', () => {
    expect(parseGitLog('')).toBeNull();
    expect(parseGitLog('\n')).toBeNull();
    expect(parseGitLog('abc1234 bez separatora')).toBeNull();
    expect(parseGitLog('abc1234\u001ftemat\u001fnie-liczba')).toBeNull();
  });
});

describe('GitStatusWatcher — ostatni commit', () => {
  const okRun = async (): Promise<{ ok: boolean; stdout: string }> =>
    ({ ok: true, stdout: SAMPLE });

  it('dokłada lastCommit z git log -1', async () => {
    const runLog = vi.fn(async () => ({ ok: true, stdout: LOG_LINE }));
    const watcher = new GitStatusWatcher({ run: okRun, runLog, now: () => 0 });

    expect(await watcher.status('/repo')).toMatchObject({
      branch: 'main', lastCommit: { hash: '5193d1f' },
    });
    expect(runLog).toHaveBeenCalledWith('/repo');
  });

  it('błąd loga (świeże repo bez HEAD) zostawia status bez lastCommit', async () => {
    const watcher = new GitStatusWatcher({
      run: okRun, runLog: async () => ({ ok: false, stdout: '' }), now: () => 0,
    });
    const status = await watcher.status('/repo');
    expect(status?.branch).toBe('main');
    expect(status?.lastCommit).toBeUndefined();
  });

  it('bez runLog (domyślnie) wiersz commita po prostu nie istnieje', async () => {
    const watcher = new GitStatusWatcher({ run: okRun, now: () => 0 });
    expect((await watcher.status('/repo'))?.lastCommit).toBeUndefined();
  });
});

describe('gitReadEnv', () => {
  it('wyłącza opcjonalne blokady — własny odczyt nie może budzić watchera `.git`', () => {
    const env = gitReadEnv({ HOME: '/h' });
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.HOME).toBe('/h');
  });
});

/*
 * Konfiguracja repo jest danymi agenta (sandbox zapisuje `.git`). Osłony stoją PRZED podkomendą
 * i przed opcjami globalnymi wołającego, więc żadne polecenie Raroga ich nie pomija ani nie nadpisuje.
 */
describe('gitArgv — osłony konfiguracji repo', () => {
  it('status i log: osłony, potem podkomenda i jej osłony; bez `--no-textconv`', () => {
    expect(gitArgv({ sub: 'status', rest: ['--porcelain=v2'] }))
      .toEqual([...G, 'status', '--ignore-submodules=dirty', '--porcelain=v2']);
    expect(gitArgv({ sub: 'log', rest: ['-1'] })).toEqual([...G, 'log', '--no-ext-diff', '-1']);
    expect(gitArgv({ sub: 'ls-files', rest: ['-z'] })).toEqual([...G, 'ls-files', '-z']);
  });

  it('diff dostaje `--no-textconv` zaraz po podkomendzie; opcja globalna stoi po osłonach', () => {
    expect(gitArgv(numstatArgs(['a.ts']))).toEqual([
      ...G, '--literal-pathspecs', ...D, '--no-ext-diff', '--relative', '--numstat', '-z', 'HEAD',
      '--', 'a.ts',
    ]);
  });

  /*
   * „podkomenda” `-c` z `rest` = `['core.fsmonitor=…', …]` stała po osłonach i je
   * nadpisywała (`git -c core.fsmonitor=false … -c core.fsmonitor=x config --get core.fsmonitor` → `x`).
   * Typ zamyka listę dla kodu, kontrola w biegu — dla rzutowania i atrap.
   */
  it('podkomenda i opcja globalna spoza listy: wyjątek, a runner nie startuje gita', async () => {
    const bypass = { sub: '-c', rest: ['core.fsmonitor=obejscie', 'config', '--get', 'core.fsmonitor'] };
    expect(() => gitArgv(bypass as unknown as GitCommand)).toThrow(/podkomenda spoza listy/);
    expect(() => gitArgv({ sub: 'config', rest: ['--list'] } as unknown as GitCommand)).toThrow(/podkomenda/);
    expect(() => gitArgv({ global: ['-c'], sub: 'status', rest: [] } as unknown as GitCommand))
      .toThrow(/opcja globalna spoza listy/);
    // The runner's own probe has a closed list too: `config --list` cannot come in as a probe.
    // The listing the runner does need is the fixed `config-names` probe (names only, no values), not a free argv.
    expect(gitArgv({ probe: 'version' })).toEqual([...G, 'version']);
    expect(() => gitArgv({ probe: 'config' } as unknown as GitRunnerProbe)).toThrow(/probe outside the list/);
    // The read runs in a repository of its own: outside one the runner answers exit code 128 before it checks
    // the command, so the refusal of the bypass would not be reached (the export view has no `.git`).
    const scratch = mkdtempSync(path.join(tmpdir(), 'rarog-git-bypass-'));
    try {
      execFileSync('git', ['init', '-q', scratch]);
      const env = gitReadEnv({ PATH: process.env['PATH'] ?? '' });
      const refused = await spawnGitArgs(env)(bypass as unknown as GitCommand, scratch);
      expect(refused).toMatchObject({ ok: false, stdout: '', spawnFailed: 'UNKNOWN' });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * Polecenia do testów runnera (runner przyjmuje polecenie z zamkniętej listy podkomend): odczyt z wyjściem
 * i odmowa z kodem ≠ 0. Biegną we własnym repo w katalogu tymczasowym, bo eksport bez historii nie ma `.git`.
 */
const TOPLEVEL: GitCommand = { sub: 'rev-parse', rest: ['--show-toplevel'] };
const UNKNOWN: GitCommand = { sub: 'rev-parse', rest: ['--verify', '--quiet', 'refs/heads/nie-ma-takiej-galezi'] };

/**
 * Timeout jest TRZECIM stanem obok `ok`, a nie jego odmianą: bez tego rozróżnienia wołający
 * mówił „git odmówił" tam, gdzie prawdą było „git nie zdążył".
 */
describe('spawnGitArgs — timeout', () => {
  let scratch = '';
  /** Repo testów: świeże `git init`, więc `rev-parse --show-toplevel` odpowiada bez checkoutu Raroga. */
  let repo = '';
  /** Środowisko z atrapą `git`, która śpi: timeout jest pewny na każdym systemie, a test nie czeka. */
  let sleepy: NodeJS.ProcessEnv = {};
  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'rarog-git-timeout-'));
    repo = path.join(scratch, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    const bin = path.join(scratch, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o755 });
    sleepy = gitReadEnv({ PATH: bin });
  });
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

  it('przekroczony limit czasu oznacza wynik `timedOut`, a zwykła porażka go nie ma', async () => {
    const env = gitReadEnv({ PATH: process.env['PATH'] ?? '' });
    // Prawdziwy git z limitem 1 ms bywał szybszy od zegara (Linux), więc limit przekracza atrapa, która śpi.
    // Zwykłej porażki NIE da się tak wywołać — stąd drugi runner.
    const late = await spawnGitArgs(sleepy, 100)(TOPLEVEL, repo);
    expect(late.ok).toBe(false);
    expect(late.timedOut).toBe(true);

    // Niezerowy kod wyjścia (ref, którego nie ma) NIE jest timeoutem i nie ma prawa nim być.
    const fast = await spawnGitArgs(env)(UNKNOWN, repo);
    expect(fast.ok).toBe(false);
    expect(fast.timedOut).toBeUndefined();
  });

  /*
   * `ok: false` alone cannot tell "exit code ≠ 0" from "the process did not end by itself", and a read cut at the
   * cap would look like `ok: true`. The exit code and `capped` separate these states for the per-file diff
   * (`git diff --no-index` ends with code 1 on every difference).
   */
  it('wynik niesie kod wyjścia procesu, a sufit odczytu znak `capped`', async () => {
    const env = gitReadEnv({ PATH: process.env['PATH'] ?? '' });
    const done = await spawnGitArgs(env)(TOPLEVEL, repo);
    expect(done).toMatchObject({ ok: true, exitCode: 0 });
    expect(done.capped).toBeUndefined();

    const refused = await spawnGitArgs(env)(UNKNOWN, repo);
    expect(refused.ok).toBe(false);
    expect(refused.exitCode).toBeGreaterThan(0);

    // Sufit jednego bajtu: proces jest zabijany, wynik to prefiks — bez kodu wyjścia.
    const capped = await spawnGitArgs(env, 5_000, 1)(TOPLEVEL, repo);
    expect(capped).toMatchObject({ ok: true, capped: true });
    expect(capped.exitCode).toBeUndefined();
    expect(capped.stdout.length).toBeGreaterThan(0);
    expect(done.stdout.startsWith(capped.stdout)).toBe(true);

    const late = await spawnGitArgs(sleepy, 100)(TOPLEVEL, repo);
    expect(late.timedOut).toBe(true);
    expect(late.exitCode).toBeUndefined();
  });
});
