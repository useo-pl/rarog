/**
 * Diff sesji per plik: lista zmian i patch jednego pliku — kolektory `git-diff.ts`.
 *
 * Testy NIE odpalają prawdziwego gita: runner jest atrapą, która odpowiada zmierzonymi wyjściami
 * (git 2.54, `-z`). Te same przypadki na prawdziwym repozytorium ma `git-diff-repo.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  DiffError, MAX_DIFF_FILE_PATCH_BYTES, MAX_DIFF_LIST_FILES, collectDiffFile, collectDiffList,
  parseNameStatusZ, validateDiffPath,
} from '../src/git-diff.ts';
import { gitArgv } from '../src/git-status.ts';
import type { GitArgsResult, GitArgsRunner, UntrackedEntry } from '../src/git-status.ts';

/** Osłony konfiguracji przed każdą podkomendą — dosłownie, żeby asercje argv przypinały flagi. */
const G = [
  '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'safe.bareRepository=explicit',
  '-c', 'core.hooksPath=/dev/null', '-c', 'diff.submodule=short',
];

/** `diff` with the runner's own flags, before the caller's arguments. */
const D = ['diff', '--no-textconv', '--no-ext-diff', '--ignore-submodules=dirty'];

/** Rekordy `-z`: każde pole domknięte bajtem NUL. */
const z = (...fields: string[]): string => fields.map((field) => `${field}\0`).join('');

const ok = (stdout = ''): GitArgsResult => ({ ok: true, stdout, exitCode: 0 });
/** Odmowa gita: kod ≠ 0 (katalog spoza repo, repo bez `HEAD`). */
const refused = (exitCode = 128): GitArgsResult => ({ ok: false, stdout: '', exitCode });
const timedOut: GitArgsResult = { ok: false, stdout: '', timedOut: true };

interface FakeGit {
  nameStatus?: GitArgsResult;
  untracked?: GitArgsResult;
  numstat?: GitArgsResult;
  /** Patch pliku śledzonego (`diff HEAD -- …`). */
  patch?: GitArgsResult;
  /** Patch pliku nieśledzonego (`diff --no-index`), domyślnie kod 1 jak w gicie. */
  noIndex?: GitArgsResult;
  /** Sonda `HEAD` (`rev-parse --verify`), domyślnie kod 1: repo bez commita albo katalog spoza repo. */
  head?: GitArgsResult;
}

/** Atrapa gita rozpoznająca wywołanie po poleceniu; `calls` zbiera pełne argv (`gitArgv`) do asercji. */
function fakeGit(script: FakeGit = {}, calls: string[][] = []): GitArgsRunner {
  return (command, cwd) => {
    expect(cwd).toBe('/repo');
    calls.push(gitArgv(command));
    const args = command.rest;
    if (command.sub === 'ls-files') return Promise.resolve(script.untracked ?? ok());
    if (command.sub === 'rev-parse') return Promise.resolve(script.head ?? refused(1));
    if (args.includes('--name-status')) return Promise.resolve(script.nameStatus ?? ok());
    if (args.includes('--numstat')) return Promise.resolve(script.numstat ?? ok());
    if (args.includes('--no-index')) {
      return Promise.resolve(script.noIndex ?? { ok: false, stdout: '', exitCode: 1 });
    }
    return Promise.resolve(script.patch ?? ok());
  };
}

const asFile = (): Promise<UntrackedEntry> => Promise.resolve({ kind: 'file' });

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

const NAME_STATUS = z('M', 'src/a.ts', 'R096', 'old.ts', 'new.ts', 'A', 'docs/b.md', 'D', 'gone.ts', 'M', 'bin.dat');
const NUMSTAT = `2\t1\tsrc/a.ts\0` + `1\t0\t\0old.ts\0new.ts\0` + `5\t0\tdocs/b.md\0` + `0\t7\tgone.ts\0`
  + `-\t-\tbin.dat\0`;
const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n a\n+b\n';

describe('validateDiffPath', () => {
  it('przepuszcza ścieżkę względną — także ze spacją, plusem, procentem i spoza ASCII', () => {
    for (const path of ['a.ts', 'src/a.ts', 'za ż+%&#.txt', 'tab\there.txt', '.env', '...', 'a..b/c', '-x']) {
      expect(validateDiffPath(path), path).toBe(path);
    }
  });

  it('odrzuca kształty, których git na liście nie wypisze', () => {
    for (const path of [
      '', '/etc/hosts', 'docs/', '..', '../x', 'a/../b', 'a/..', '.', './a', 'a/./b', 'a\0b', '/',
    ]) {
      expect(validateDiffPath(path), JSON.stringify(path)).toBeNull();
    }
    expect(validateDiffPath(null)).toBeNull();
    expect(validateDiffPath(undefined)).toBeNull();
  });

  it('limit 4096 BAJTÓW: 4096 przechodzi, 4097 nie, a znak spoza ASCII waży więcej niż jeden', () => {
    expect(validateDiffPath('a'.repeat(4096))).not.toBeNull();
    expect(validateDiffPath('a'.repeat(4097))).toBeNull();
    expect(validateDiffPath('ż'.repeat(2048))).not.toBeNull();
    expect(validateDiffPath('ż'.repeat(2049))).toBeNull();
  });
});

describe('parseNameStatusZ', () => {
  it('czyta rekordy `-z` w kolejności gita; rename i kopia niosą źródło', () => {
    const map = parseNameStatusZ(z('M', 'a.ts', 'R096', 'old.ts', 'new.ts', 'C100', 'src.ts', 'copy.ts', 'D', 'gone.ts'));
    expect([...map]).toEqual([
      ['a.ts', { status: 'M' }],
      ['new.ts', { status: 'M', origin: 'old.ts' }],
      ['copy.ts', { status: 'A', origin: 'src.ts' }],
      ['gone.ts', { status: 'D' }],
    ]);
  });

  it('zmiana typu i konflikt to zmieniony plik; ścieżka idzie dosłownie (tabulator, „ => ”, nie-ASCII)', () => {
    const map = parseNameStatusZ(z('T', 'typ', 'U', 'konflikt.txt', 'A', 'tab\there.txt', 'M', 'a => b.txt', 'M', 'zaż.txt'));
    expect([...map.keys()]).toEqual(['typ', 'konflikt.txt', 'tab\there.txt', 'a => b.txt', 'zaż.txt']);
    expect(map.get('typ')).toEqual({ status: 'M' });
    expect(map.get('konflikt.txt')).toEqual({ status: 'M' });
    expect(map.get('tab\there.txt')).toEqual({ status: 'A' });
  });

  it('rekord ucięty sufitem odczytu odpada — także rename urwany po źródle', () => {
    expect([...parseNameStatusZ(`${z('M', 'a.ts')}M\0uciety.t`).keys()]).toEqual(['a.ts']);
    expect([...parseNameStatusZ(`${z('M', 'a.ts', 'R100', 'old.ts')}new.t`).keys()]).toEqual(['a.ts']);
    expect([...parseNameStatusZ(`${z('M', 'a.ts')}R1`).keys()]).toEqual(['a.ts']);
  });

  it('puste wyjście i śmieci dają pustą mapę', () => {
    expect(parseNameStatusZ('').size).toBe(0);
    expect(parseNameStatusZ('fatal: not a git repository\n').size).toBe(0);
    expect(parseNameStatusZ(z('nie-litera', 'a.ts')).size).toBe(0);
  });
});

describe('collectDiffList', () => {
  it('śledzone w kolejności gita, potem nieśledzone; liczniki, binarny i rename po ścieżce docelowej', async () => {
    const list = await collectDiffList('/repo', {
      run: fakeGit({ nameStatus: ok(NAME_STATUS), untracked: ok(z('nowy.txt', 'docs/plan.md')) }),
      runNumstat: fakeGit({ numstat: ok(NUMSTAT) }),
    });

    expect(list).toEqual({
      files: [
        { path: 'src/a.ts', status: 'M', linesAdded: 2, linesDeleted: 1 },
        { path: 'new.ts', status: 'M', linesAdded: 1, linesDeleted: 0 },
        { path: 'docs/b.md', status: 'A', linesAdded: 5, linesDeleted: 0 },
        { path: 'gone.ts', status: 'D', linesAdded: 0, linesDeleted: 7 },
        { path: 'bin.dat', status: 'M', binary: true },
        // Nieśledzony nie ma liczników: bilans policzy klient z patcha, gdy go pobierze.
        { path: 'nowy.txt', status: 'A' },
        { path: 'docs/plan.md', status: 'A' },
      ],
      truncated: false,
    });
  });

  it('pyta gita dokładnie o dwie listy i liczniki — bez patcha i bez sieci', async () => {
    const calls: string[][] = [];
    await collectDiffList('/repo', { run: fakeGit({}, calls), runNumstat: fakeGit({}, calls) });

    expect(calls.sort((a, b) => a.join(' ').localeCompare(b.join(' ')))).toEqual([
      [...G, '--literal-pathspecs', ...D, '--no-ext-diff', '--relative', '--name-status', '-z', 'HEAD'],
      [...G, '--literal-pathspecs', ...D, '--no-ext-diff', '--relative', '--numstat', '-z', 'HEAD', '--'],
      [...G, 'ls-files', '--others', '--exclude-standard', '-z'],
    ]);
  });

  it('liczniki po budżecie, po odmowie i bez runnera: lista jedzie bez nich', async () => {
    const run = fakeGit({ nameStatus: ok(z('M', 'src/a.ts')) });
    const bare = { files: [{ path: 'src/a.ts', status: 'M' }], truncated: false };

    expect(await collectDiffList('/repo', {
      run, runNumstat: fakeGit({ numstat: { ok: false, stdout: '2\t1\tsrc/a.ts\0', timedOut: true } }),
    })).toEqual(bare);
    expect(await collectDiffList('/repo', { run, runNumstat: fakeGit({ numstat: refused() }) })).toEqual(bare);
    expect(await collectDiffList('/repo', { run, runNumstat: () => Promise.reject(new Error('EMFILE')) }))
      .toEqual(bare);
    expect(await collectDiffList('/repo', { run })).toEqual(bare);
    expect(await collectDiffList('/repo', { run, runNumstat: null })).toEqual(bare);
  });

  it('lista NIE czeka na liczniki dłużej, niż trwa ich własny runner', async () => {
    const order: string[] = [];
    let releaseCounts = (): void => {};
    const runNumstat: GitArgsRunner = () => new Promise((resolve) => {
      releaseCounts = () => { order.push('numstat'); resolve({ ok: false, stdout: '', timedOut: true }); };
    });
    const pending = collectDiffList('/repo', {
      run: fakeGit({ nameStatus: ok(z('M', 'src/a.ts')) }), runNumstat,
    }).then((list) => { order.push('lista'); return list; });
    // Listy już są; odpowiedź wychodzi dopiero, gdy runner liczników odda wynik (jego budżet).
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(order).toEqual([]);
    releaseCounts();
    expect((await pending).files).toEqual([{ path: 'src/a.ts', status: 'M' }]);
    expect(order).toEqual(['numstat', 'lista']);
  });

  it(`sufit ${String(MAX_DIFF_LIST_FILES)} wpisów: lista ucięta z truncated, śledzone przed nieśledzonymi`, async () => {
    expect(MAX_DIFF_LIST_FILES).toBe(500);
    const tracked = Array.from({ length: 300 }, (_, i) => ['M', `t${String(i)}.ts`]).flat();
    const untracked = Array.from({ length: 300 }, (_, i) => `u${String(i)}.txt`);
    const list = await collectDiffList('/repo', {
      run: fakeGit({ nameStatus: ok(z(...tracked)), untracked: ok(z(...untracked)) }),
    });

    expect(list.truncated).toBe(true);
    expect(list.files).toHaveLength(500);
    expect(list.files[299]).toEqual({ path: 't299.ts', status: 'M' });
    expect(list.files[499]).toEqual({ path: 'u199.txt', status: 'A' });

    // Dokładnie na suficie lista jest pełna, a nie „ucięta".
    const exact = await collectDiffList('/repo', {
      run: fakeGit({ nameStatus: ok(z('M', 'a.ts')), untracked: ok(z('b.txt')) }), maxFiles: 2,
    });
    expect(exact).toEqual({ files: [{ path: 'a.ts', status: 'M' }, { path: 'b.txt', status: 'A' }], truncated: false });
  });

  it('lista gita urwana sufitem odczytu jest ucięta, nawet gdy mieści się w suficie wpisów', async () => {
    const list = await collectDiffList('/repo', {
      run: fakeGit({ untracked: { ok: true, stdout: `${z('a.txt')}uciety.t`, capped: true } }),
    });
    expect(list).toEqual({ files: [{ path: 'a.txt', status: 'A' }], truncated: true });
  });

  it('ścieżka z obu list (`git rm --cached`) ma jeden wpis ze statusem gita', async () => {
    const list = await collectDiffList('/repo', {
      run: fakeGit({ nameStatus: ok(z('D', 'x.txt')), untracked: ok(z('x.txt', 'y.txt')) }),
    });
    expect(list.files).toEqual([{ path: 'x.txt', status: 'D' }, { path: 'y.txt', status: 'A' }]);
  });

  it('repo bez HEAD: `diff HEAD` odmawia, lista to same nieśledzone', async () => {
    const list = await collectDiffList('/repo', {
      run: fakeGit({ nameStatus: refused(128), untracked: ok(z('r.txt')) }),
      runNumstat: fakeGit({ numstat: refused(128) }),
    });
    expect(list).toEqual({ files: [{ path: 'r.txt', status: 'A' }], truncated: false });
  });

  it('katalog spoza repo: oba procesy odmawiają, lista jest pusta — to nie błąd', async () => {
    const list = await collectDiffList('/repo', {
      run: fakeGit({ nameStatus: refused(129), untracked: refused(128) }),
    });
    expect(list).toEqual({ files: [], truncated: false });
  });

  it('awaria gita nie udaje pustej listy: limit czasu, nieudany start, sygnał, wyjątek → git-failed', async () => {
    const broken: [string, FakeGit][] = [
      ['limit czasu name-status', { nameStatus: timedOut }],
      ['limit czasu ls-files', { untracked: timedOut }],
      ['nieudany start', { nameStatus: { ok: false, stdout: '', spawnFailed: 'EMFILE' } }],
      // Proces zabity sygnałem nie ma kodu wyjścia: to nie jest odmowa gita.
      ['sygnał', { untracked: { ok: false, stdout: '' } }],
      // `diff HEAD` odpowiada, `ls-files` odmawia: ani „nie repo", ani „bez HEAD".
      ['odmowa samego ls-files', { nameStatus: ok(z('M', 'a.ts')), untracked: refused(128) }],
    ];
    for (const [name, script] of broken) {
      expect(await failure(collectDiffList('/repo', { run: fakeGit(script) })), name).toBe('git-failed');
    }
    expect(await failure(collectDiffList('/repo', { run: () => Promise.reject(new Error('spawn EACCES')) })))
      .toBe('git-failed');
    expect(await failure(collectDiffList('/repo', { run: () => { throw new Error('synchronicznie'); } })))
      .toBe('git-failed');
  });
});

describe('collectDiffFile — walidacja i lista dozwolona', () => {
  it('zła ścieżka to bad-path, zanim ruszy jakikolwiek git', async () => {
    const calls: string[][] = [];
    for (const path of ['..', '../x', '/etc/hosts', 'docs/', 'a\0b', '', 'a'.repeat(4097)]) {
      expect(await failure(collectDiffFile('/repo', path, { run: fakeGit({}, calls) })), JSON.stringify(path))
        .toBe('bad-path');
    }
    expect(calls).toEqual([]);
  });

  it('ścieżka spoza list gita to diff-file-not-found: plik ignorowany, bez zmian, prawie taka sama nazwa', async () => {
    const calls: string[][] = [];
    const run = fakeGit({ nameStatus: ok(z('M', 'src/a.ts')), untracked: ok(z('nowy.txt')) }, calls);
    for (const path of ['.env', 'src/b.ts', 'src/a.ts ', 'SRC/a.ts', 'src', 'nowy.txt/x', 'old.ts']) {
      expect(await failure(collectDiffFile('/repo', path, { run, probe: asFile })), path)
        .toBe('diff-file-not-found');
    }
    // Żaden patch nie wystartował: same procesy walidacji, po dwa na żądanie.
    expect(calls.every((args) => args.includes('--name-status') || args.includes('ls-files'))).toBe(true);
    expect(calls).toHaveLength(14);
  });

  it('źródło zmiany nazwy nie jest pozycją listy — klient nie dostanie go po ścieżce', async () => {
    const run = fakeGit({ nameStatus: ok(z('R096', 'old.ts', 'new.ts')), patch: ok(PATCH) });
    expect(await failure(collectDiffFile('/repo', 'old.ts', { run }))).toBe('diff-file-not-found');
  });

  it('awaria procesów walidacji to git-failed, nigdy 404', async () => {
    for (const script of [
      { nameStatus: timedOut }, { untracked: timedOut },
      { untracked: { ok: false, stdout: '', spawnFailed: 'ENOENT' } },
      { nameStatus: ok(z('M', 'a.ts')), untracked: refused(128) },
    ] satisfies FakeGit[]) {
      expect(await failure(collectDiffFile('/repo', 'src/a.ts', { run: fakeGit(script) }))).toBe('git-failed');
    }
  });

  it('lista urwana sufitem odczytu: brak ścieżki niczego nie dowodzi (git-failed), obecność wystarcza', async () => {
    const capped: FakeGit = {
      nameStatus: { ok: true, stdout: `${z('M', 'src/a.ts')}M\0src/uciet`, capped: true }, patch: ok(PATCH),
    };
    expect(await failure(collectDiffFile('/repo', 'src/z.ts', { run: fakeGit(capped) }))).toBe('git-failed');
    expect((await collectDiffFile('/repo', 'src/a.ts', { run: fakeGit(capped) })).patch).toBe(PATCH);
  });

  it('katalog spoza repo i repo bez HEAD: plik spoza list to 404, nieśledzony z listy ma patch', async () => {
    const outside = fakeGit({ nameStatus: refused(129), untracked: refused(128) });
    expect(await failure(collectDiffFile('/repo', 'a.ts', { run: outside }))).toBe('diff-file-not-found');

    const noHead = fakeGit({
      nameStatus: refused(128), untracked: ok(z('r.txt')),
      noIndex: { ok: false, stdout: 'diff --git a/r.txt b/r.txt\n+r\n', exitCode: 1 },
    });
    expect((await collectDiffFile('/repo', 'r.txt', { run: noHead, probe: asFile })).patch)
      .toBe('diff --git a/r.txt b/r.txt\n+r\n');
  });
});

describe('collectDiffFile — plik śledzony', () => {
  it('argumenty gita co do znaku: opcja globalna, `--` i sama ścieżka', async () => {
    const calls: string[][] = [];
    const run = fakeGit({ nameStatus: ok(z('M', 'docs/*.md')), patch: ok(PATCH) }, calls);
    const result = await collectDiffFile('/repo', 'docs/*.md', { run });

    expect(result).toEqual({ path: 'docs/*.md', patch: PATCH, truncated: false });
    expect(calls.at(-1)).toEqual([
      ...G, '--literal-pathspecs', ...D, '--no-ext-diff', '--relative', 'HEAD', '--', 'docs/*.md',
    ]);
    expect(calls).toHaveLength(3);
  });

  it('rename dokłada źródło z listy gita (klient go nie wysyła)', async () => {
    const calls: string[][] = [];
    const run = fakeGit({ nameStatus: ok(z('M', 'a.ts', 'R096', 'old.ts', 'new.ts')), patch: ok(PATCH) }, calls);
    await collectDiffFile('/repo', 'new.ts', { run });
    expect(calls.at(-1)?.slice(-3)).toEqual(['--', 'new.ts', 'old.ts']);
  });

  it('źródło, które stało się katalogiem albo osobną pozycją, odpada — bez cudzych bloków', async () => {
    const cases: [string, FakeGit][] = [
      // `git mv old new`, potem `old/extra` dodany do indeksu.
      ['śledzony pod źródłem', { nameStatus: ok(z('A', 'old/extra', 'R100', 'old', 'new')) }],
      ['nieśledzony pod źródłem', { nameStatus: ok(z('R100', 'old', 'new')), untracked: ok(z('old/untr')) }],
      // `diff.renames=copies`: źródło kopii jest osobną, zmienioną pozycją.
      ['źródło jako pozycja', { nameStatus: ok(z('C100', 'old', 'new', 'M', 'old')) }],
      ['lista urwana', { nameStatus: { ok: true, stdout: z('R100', 'old', 'new'), capped: true } }],
    ];
    for (const [name, script] of cases) {
      const calls: string[][] = [];
      await collectDiffFile('/repo', 'new', { run: fakeGit({ ...script, patch: ok(PATCH) }, calls) });
      expect(calls.at(-1)?.slice(-2), name).toEqual(['--', 'new']);
    }
    // Sąsiad o wspólnym prefiksie nazwy (`old2`, `older/x`) to nie potomek źródła.
    const calls: string[][] = [];
    await collectDiffFile('/repo', 'new', {
      run: fakeGit({ nameStatus: ok(z('R100', 'old', 'new', 'M', 'old2', 'A', 'older/x')), patch: ok(PATCH) }, calls),
    });
    expect(calls.at(-1)?.slice(-3)).toEqual(['--', 'new', 'old']);
  });

  it('wszystkie bloki odpowiedzi idą pod jedną ścieżką: zmiana typu, konflikt, submoduł, binarny', async () => {
    const typeChange = 'diff --git a/typ b/typ\ndeleted file mode 100644\n--- a/typ\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
      + 'diff --git a/typ b/typ\nnew file mode 120000\n--- /dev/null\n+++ b/typ\n@@ -0,0 +1 @@\n+plain.txt\n'
      + '\\ No newline at end of file\n';
    const conflict = 'diff --git a/c.txt b/c.txt\n@@ -1,2 +1,6 @@\n a\n+<<<<<<< HEAD\n MAIN\n+=======\n+INNA\n+>>>>>>> inna\n';
    const submodule = 'diff --git a/mod b/mod\n--- a/mod\n+++ b/mod\n@@ -1 +1 @@\n-Subproject commit dea2a9d\n'
      + '+Subproject commit 68e7093\n';
    const binary = 'diff --git a/bin.dat b/bin.dat\nindex e899662..9de10b8 100644\nBinary files a/bin.dat and b/bin.dat differ\n';
    for (const [path, letter, patch] of [
      ['typ', 'T', typeChange], ['c.txt', 'U', conflict], ['mod', 'M', submodule], ['bin.dat', 'M', binary],
    ] as const) {
      const result = await collectDiffFile('/repo', path, {
        run: fakeGit({ nameStatus: ok(z(letter, path)), patch: ok(patch) }),
      });
      expect(result, path).toEqual({ path, patch, truncated: false });
    }
  });

  it(`cięcie na ${String(MAX_DIFF_FILE_PATCH_BYTES / 1024)} kB na granicy linii z truncated`, async () => {
    expect(MAX_DIFF_FILE_PATCH_BYTES).toBe(512 * 1024);
    const line = `+${'x'.repeat(99)}\n`;
    const big = line.repeat(6000);
    const result = await collectDiffFile('/repo', 'big.txt', {
      run: fakeGit({ nameStatus: ok(z('M', 'big.txt')), patch: ok(big) }),
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.patch, 'utf8')).toBeLessThanOrEqual(MAX_DIFF_FILE_PATCH_BYTES);
    expect(result.patch.endsWith(line)).toBe(true);
    expect(Buffer.byteLength(result.patch, 'utf8') % line.length).toBe(0);
  });

  it('sufit odczytu procesu to truncated, a urwana ostatnia linia odpada', async () => {
    const result = await collectDiffFile('/repo', 'big.txt', {
      run: fakeGit({
        nameStatus: ok(z('M', 'big.txt')), patch: { ok: true, stdout: `${PATCH}+polowa lin`, capped: true },
      }),
    });
    expect(result).toEqual({ path: 'big.txt', patch: PATCH, truncated: true });
  });

  it('limit czasu, nieudany start i odmowa patcha to git-failed', async () => {
    for (const patch of [timedOut, { ok: false, stdout: '', spawnFailed: 'EAGAIN' }, refused(128)]) {
      const run = fakeGit({ nameStatus: ok(z('M', 'a.ts')), patch });
      expect(await failure(collectDiffFile('/repo', 'a.ts', { run }))).toBe('git-failed');
    }
  });

  it('pusty patch pozycji z listy (HEAD przesunął się między listą a patchem) to diff-file-not-found', async () => {
    const run = fakeGit({ nameStatus: ok(z('M', 'a.ts')), patch: ok('') });
    expect(await failure(collectDiffFile('/repo', 'a.ts', { run }))).toBe('diff-file-not-found');
  });
});

describe('collectDiffFile — plik nieśledzony', () => {
  const noIndexPatch = 'diff --git a/nowy.txt b/nowy.txt\nnew file mode 100644\n--- /dev/null\n+++ b/nowy.txt\n'
    + '@@ -0,0 +1 @@\n+linia\n';

  it('zwykły plik idzie przez --no-index; kod wyjścia 1 znaczy „jest różnica”', async () => {
    const calls: string[][] = [];
    const run = fakeGit({
      untracked: ok(z('nowy.txt')), noIndex: { ok: false, stdout: noIndexPatch, exitCode: 1 },
    }, calls);
    const result = await collectDiffFile('/repo', 'nowy.txt', { run, probe: asFile });

    expect(result).toEqual({ path: 'nowy.txt', patch: noIndexPatch, truncated: false });
    expect(calls.at(-1)).toEqual([
      ...G, '--literal-pathspecs', ...D, '--no-ext-diff', '--no-index', '--', '/dev/null', 'nowy.txt',
    ]);
  });

  it('dowiązanie nie idzie do --no-index: blok z celem składa serwer, celu nikt nie otwiera', async () => {
    const calls: string[][] = [];
    const run = fakeGit({ untracked: ok(z('do-katalogu', 'do-pliku')) }, calls);
    const probe = (_cwd: string, path: string): Promise<UntrackedEntry> => Promise.resolve({
      kind: 'symlink', target: path === 'do-katalogu' ? '/Users/u/poza-repo' : '/Users/u/poza-repo/cel.txt',
    });

    expect((await collectDiffFile('/repo', 'do-katalogu', { run, probe })).patch).toBe(
      'diff --git a/do-katalogu b/do-katalogu\nnew file mode 120000\n--- /dev/null\n+++ b/do-katalogu\n'
      + '@@ -0,0 +1 @@\n+/Users/u/poza-repo\n\\ No newline at end of file\n',
    );
    expect((await collectDiffFile('/repo', 'do-pliku', { run, probe })).patch)
      .toContain('+/Users/u/poza-repo/cel.txt\n');
    expect(calls.some((args) => args.includes('--no-index'))).toBe(false);
  });

  it('katalog, plik specjalny, podmieniony katalog nadrzędny i wpis, który zniknął, to 404', async () => {
    const calls: string[][] = [];
    const run = fakeGit({ untracked: ok(z('pod/new.txt')) }, calls);
    // `probeUntracked` oddaje `other` także wtedy, gdy katalog nadrzędny po rozwiązaniu dowiązań
    // wychodzi poza katalog sesji (podmiana po wypisaniu listy) — test na dysku w `git-diff-repo`.
    const probe = (): Promise<UntrackedEntry> => Promise.resolve({ kind: 'other' });
    expect(await failure(collectDiffFile('/repo', 'pod/new.txt', { run, probe }))).toBe('diff-file-not-found');
    expect(await failure(collectDiffFile('/repo', 'pod/new.txt', {
      run, probe: () => Promise.reject(new Error('EACCES')),
    }))).toBe('diff-file-not-found');
    expect(calls.some((args) => args.includes('--no-index'))).toBe(false);
    // Domyślna sonda czyta dysk: wpisu z listy tam nie ma, więc też 404.
    expect(await failure(collectDiffFile('/repo', 'pod/new.txt', { run }))).toBe('diff-file-not-found');
  });

  it('plik usunięty między listą a patchem: kod 1 z pustym wyjściem to 404, nie błąd', async () => {
    const run = fakeGit({ untracked: ok(z('nowy.txt')), noIndex: { ok: false, stdout: '', exitCode: 1 } });
    expect(await failure(collectDiffFile('/repo', 'nowy.txt', { run, probe: asFile })))
      .toBe('diff-file-not-found');
  });

  it('--no-index: limit czasu, nieudany start, sygnał i kod inny niż 0/1 to git-failed', async () => {
    for (const noIndex of [
      timedOut, { ok: false, stdout: '', spawnFailed: 'EMFILE' }, { ok: false, stdout: '' },
      { ok: false, stdout: 'usage: git diff --no-index', exitCode: 129 },
    ] satisfies GitArgsResult[]) {
      const run = fakeGit({ untracked: ok(z('nowy.txt')), noIndex });
      expect(await failure(collectDiffFile('/repo', 'nowy.txt', { run, probe: asFile }))).toBe('git-failed');
    }
  });

  it('--no-index urwany sufitem odczytu to truncated', async () => {
    const run = fakeGit({
      untracked: ok(z('nowy.txt')), noIndex: { ok: true, stdout: `${noIndexPatch}+pol`, capped: true },
    });
    expect(await collectDiffFile('/repo', 'nowy.txt', { run, probe: asFile }))
      .toEqual({ path: 'nowy.txt', patch: noIndexPatch, truncated: true });
  });

  it('ścieżka z obu list (`git rm --cached`): blok usunięcia z HEAD i blok pliku z dysku', async () => {
    const deleted = 'diff --git a/x.txt b/x.txt\ndeleted file mode 100644\n--- a/x.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-stare\n';
    const added = 'diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+nowe\n';
    const run = fakeGit({
      nameStatus: ok(z('D', 'x.txt')), untracked: ok(z('x.txt')), patch: ok(deleted),
      noIndex: { ok: false, stdout: added, exitCode: 1 },
    });
    expect(await collectDiffFile('/repo', 'x.txt', { run, probe: asFile }))
      .toEqual({ path: 'x.txt', patch: deleted + added, truncated: false });
  });
});

/*
 * Kod ≠ 0 z `diff HEAD` nie dowodzi, że nie ma repo albo `HEAD`. Zła
 * konfiguracja gita (`diff.orderFile` na nieistniejący plik) też daje 128, przy poprawnym repo.
 */
describe('odmowa `diff HEAD` przy istniejącym HEAD to awaria, nie pusta lista', () => {
  it('lista i plik dostają git-failed; sonda HEAD pytana tylko po odmowie', async () => {
    const calls: string[][] = [];
    const run = fakeGit({ nameStatus: refused(128), untracked: ok(z('nowy.txt')), head: ok('abc\n') }, calls);
    expect(await failure(collectDiffList('/repo', { run }))).toBe('git-failed');
    expect(await failure(collectDiffFile('/repo', 'nowy.txt', { run, probe: asFile }))).toBe('git-failed');
    expect(calls.filter((args) => args.includes('rev-parse'))).toEqual([
      [...G, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], [...G, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    ]);

    // Zdrowa lista sondy nie odpala wcale.
    const healthy: string[][] = [];
    await collectDiffList('/repo', { run: fakeGit({ nameStatus: ok(z('M', 'a.ts')) }, healthy) });
    expect(healthy.some((args) => args.includes('rev-parse'))).toBe(false);
  });

  it('sonda bez odpowiedzi to też git-failed; sonda z odmową zostawia same nieśledzone', async () => {
    const stuck = fakeGit({ nameStatus: refused(128), untracked: ok(z('nowy.txt')), head: timedOut });
    expect(await failure(collectDiffList('/repo', { run: stuck }))).toBe('git-failed');
    const noHead = fakeGit({ nameStatus: refused(128), untracked: ok(z('nowy.txt')), head: refused(1) });
    expect(await collectDiffList('/repo', { run: noHead })).toEqual({
      files: [{ path: 'nowy.txt', status: 'A' }], truncated: false,
    });
  });
});

describe('nieśledzone zagnieżdżone repozytorium (`nested/` z ls-files)', () => {
  it('wpis katalogowy nie wchodzi na listę — nie dałoby się go rozwinąć', async () => {
    const run = fakeGit({ untracked: ok(z('nested/', 'plik.txt', 'inne/repo/')) });
    expect(await collectDiffList('/repo', { run })).toEqual({
      files: [{ path: 'plik.txt', status: 'A' }], truncated: false,
    });
    expect(await failure(collectDiffFile('/repo', 'nested/', { run, probe: asFile }))).toBe('bad-path');
  });
});
