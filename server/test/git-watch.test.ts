/**
 * Obserwator `.git` (`git-watch.ts`).
 *
 * Większość testów wstrzykuje ATRAPĘ `fs.watch`: liczy się filtr nazw, debounce, liczenie
 * referencji i zachowanie po awarii — a nie to, czy macOS dostarcza zdarzenia. Jeden test
 * na końcu używa prawdziwego `fs.watch` i sam się pomija, gdy piaskownica go nie daje (EMFILE).
 */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { watch } from 'node:fs';
import { GitRepoWatcher, findGitDirs, isRelevantGitPath } from '../src/git-watch.ts';
import { CHILD_TEST_TIMEOUT_MS, childJson, runInChild, serverModule } from './child-limit.ts';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-git-watch-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

/** Zwykłe repo: `.git` jako KATALOG z `HEAD` i `refs/heads`. */
async function makeRepo(dir: string): Promise<string> {
  const gitDir = join(dir, '.git');
  await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true });
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  return gitDir;
}

describe('isRelevantGitPath', () => {
  it('reaguje na HEAD, index, packed-refs, refs/** i logs/**', () => {
    for (const name of ['HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'index', 'packed-refs',
      'refs/heads/main', 'refs/remotes/origin/main', 'logs/HEAD']) {
      expect(isRelevantGitPath(name), name).toBe(true);
    }
  });

  it('ignoruje obiekty, pliki blokad i katalogi worktree', () => {
    for (const name of ['objects/ab/cdef', 'index.lock', 'refs/heads/main.lock', 'worktrees/x/HEAD',
      'config', 'hooks/pre-commit', 'info/exclude']) {
      expect(isRelevantGitPath(name), name).toBe(false);
    }
  });
});

describe('findGitDirs', () => {
  it('znajduje `.git` w katalogu sesji', async () => {
    const gitDir = await makeRepo(root);
    expect(findGitDirs(root)).toEqual({ gitDir, commonDir: null });
  });

  it('idzie w górę z podkatalogu repo (sesja w `rarog/web`)', async () => {
    const gitDir = await makeRepo(root);
    const sub = join(root, 'web', 'src');
    await mkdir(sub, { recursive: true });
    expect(findGitDirs(sub)?.gitDir).toBe(gitDir);
  });

  it('rozwija `.git` będące PLIKIEM (worktree) razem z `commondir`', async () => {
    const main = join(root, 'main');
    const mainGit = await makeRepo(main);
    const wtGit = join(mainGit, 'worktrees', 'feature');
    await mkdir(wtGit, { recursive: true });
    await writeFile(join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n');
    await writeFile(join(wtGit, 'commondir'), '../..\n');
    const wt = join(root, 'feature');
    await mkdir(wt);
    await writeFile(join(wt, '.git'), `gitdir: ${wtGit}\n`);

    expect(findGitDirs(wt)).toEqual({ gitDir: wtGit, commonDir: mainGit });
  });

  it('katalog bez repozytorium daje null, nie wyjątek', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    // Katalog tymczasowy może leżeć pod cudzym repo — sprawdzamy tylko, że nic nie wybucha
    // i że wynik (jeśli jest) NIE wskazuje na `plain`.
    expect(findGitDirs(plain)?.gitDir.startsWith(plain) ?? false).toBe(false);
  });
});

/*
 * `.git` as a `gitdir: X` file and `X/commondir` as a FIFO would hang `findGitDirs` (a synchronous `readFileSync`
 * without a type check) at session registration — an agent in the sandbox writes `.git`. Reproduction in a child
 * process with the parent's limit (`child-limit.ts`). The `gitdir:` target and `commondir` must be directories:
 * `fs.watch` on the target opens it, and a FIFO or a file in that place is not a repository.
 */
describe('findGitDirs — pliki specjalne i cele, które nie są katalogiem', () => {
  async function worktreeLayout(): Promise<{ wt: string; wtGit: string }> {
    const wtGit = join(root, 'gitdir-x');
    await mkdir(wtGit, { recursive: true });
    await writeFile(join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n');
    const wt = join(root, 'feature');
    await mkdir(wt);
    await writeFile(join(wt, '.git'), `gitdir: ${wtGit}\n`);
    return { wt, wtGit };
  }

  it('FIFO jako `commondir`: `findGitDirs` wraca, wspólnego katalogu nie ma', async () => {
    const { wt, wtGit } = await worktreeLayout();
    execFileSync('mkfifo', [join(wtGit, 'commondir')]);
    const result = childJson<unknown>(await runInChild(root, `
import { findGitDirs } from ${serverModule('git-watch.ts')};
console.log(JSON.stringify(findGitDirs(${JSON.stringify(wt)})));
`));
    expect(result).toEqual({ gitDir: wtGit, commonDir: null });
  }, CHILD_TEST_TIMEOUT_MS);

  it('`gitdir:` wskazujący zwykły plik nie jest repozytorium', async () => {
    const target = join(root, 'to-nie-katalog');
    await writeFile(target, 'ref: refs/heads/main\n');
    const wt = join(root, 'feature');
    await mkdir(wt);
    await writeFile(join(wt, '.git'), `gitdir: ${target}\n`);
    expect(findGitDirs(wt)?.gitDir.startsWith(root) ?? false).toBe(false);
  });

  it('`commondir` wskazujący zwykły plik: wspólnego katalogu nie ma', async () => {
    const { wt, wtGit } = await worktreeLayout();
    await writeFile(join(root, 'wspolny-plik'), 'x\n');
    await writeFile(join(wtGit, 'commondir'), '../wspolny-plik\n');
    expect(findGitDirs(wt)).toEqual({ gitDir: wtGit, commonDir: null });
  });
});

/** Atrapa `fs.watch`: zapamiętuje listenera, pozwala wstrzyknąć zdarzenie albo błąd. */
interface FakeWatch {
  fn: typeof watch;
  emit: (dir: string, name: string) => void;
  fail: (dir: string, error: Error) => void;
  opened: string[];
  closed: string[];
}

function fakeWatch(): FakeWatch {
  const listeners = new Map<string, (event: string, name: string | null) => void>();
  const emitters = new Map<string, EventEmitter>();
  const opened: string[] = [];
  const closed: string[] = [];
  const fn = ((dir: string, _opts: unknown, listener: (event: string, name: string | null) => void) => {
    const emitter = new EventEmitter();
    listeners.set(dir, listener);
    emitters.set(dir, emitter);
    opened.push(dir);
    const watcher = Object.assign(emitter, { close: () => { closed.push(dir); } });
    return watcher;
  }) as unknown as typeof watch;
  return {
    fn,
    opened,
    closed,
    emit: (dir, name) => { listeners.get(dir)?.('change', name); },
    fail: (dir, error) => { emitters.get(dir)?.emit('error', error); },
  };
}

describe('GitRepoWatcher — atrapa fs.watch', () => {
  it('po zmianie refa woła onChange z katalogami sesji tego repo, po ciszy debounce', async () => {
    vi.useFakeTimers();
    const gitDir = await makeRepo(root);
    const fake = fakeWatch();
    const onChange = vi.fn();
    const watcher = new GitRepoWatcher({ onChange, watchFn: fake.fn, debounceMs: 100 });

    const sub = join(root, 'web');
    await mkdir(sub);
    watcher.watch(root);
    watcher.watch(sub);
    // Jedno repo = jeden `fs.watch`, choć dwa katalogi sesji.
    expect(fake.opened).toEqual([gitDir]);
    expect(watcher.repoCount).toBe(1);

    fake.emit(gitDir, 'refs/heads/main');
    fake.emit(gitDir, 'index');
    vi.advanceTimersByTime(99);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([root, sub]);
  });

  /*
   * Rate limit per REPO. Rebase albo `git gc` sypie zdarzeniami przez kilkanaście
   * sekund: resetujący debounce oddawał JEDEN odczyt po całej burzy, więc wiersz gita stał
   * tyle, ile ona trwała. Dziś pierwsze zdarzenie po ciszy planuje odczyt za 750 ms, a to,
   * co przyjdzie potem, schodzi się w jeden odczyt na końcu okna 2 s.
   */
  it('leading + trailing: 10 zdarzeń w 3 s daje DWA odczyty', async () => {
    vi.useFakeTimers();
    const gitDir = await makeRepo(root);
    const fake = fakeWatch();
    const onChange = vi.fn();
    let clock = 0;
    const watcher = new GitRepoWatcher({
      onChange, watchFn: fake.fn, debounceMs: 750, minIntervalMs: 2_000, now: () => clock,
    });
    watcher.watch(root);
    const step = (ms: number): void => { clock += ms; vi.advanceTimersByTime(ms); };

    for (let i = 0; i < 10; i += 1) {
      fake.emit(gitDir, 'index');
      step(300);
    }
    // Nie dziesięć (zdarzenie na zaplanowanym odczycie dołącza do niego) i nie jeden
    // (burza nie ma prawa odsuwać odczytu w nieskończoność).
    expect(onChange).toHaveBeenCalledTimes(2);

    // Po burzy cisza jest ciszą: żadnego odczytu „na wszelki wypadek".
    step(5_000);
    expect(onChange).toHaveBeenCalledTimes(2);

    // Pojedyncze zdarzenie po ciszy znów czeka 750 ms, nie 2 s.
    fake.emit(gitDir, 'HEAD');
    step(749);
    expect(onChange).toHaveBeenCalledTimes(2);
    step(1);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('pierwsze zdarzenie planuje odczyt, kolejne w tym oknie NIE przesuwają go w przód', async () => {
    vi.useFakeTimers();
    const gitDir = await makeRepo(root);
    const fake = fakeWatch();
    const onChange = vi.fn();
    let clock = 0;
    const watcher = new GitRepoWatcher({
      onChange, watchFn: fake.fn, debounceMs: 100, minIntervalMs: 1_000, now: () => clock,
    });
    watcher.watch(root);
    const step = (ms: number): void => { clock += ms; vi.advanceTimersByTime(ms); };

    fake.emit(gitDir, 'index');
    step(90);
    // Zdarzenie tuż przed terminem: dawny debounce przesunąłby odczyt o kolejne 100 ms.
    fake.emit(gitDir, 'index');
    step(10);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('zdarzenia nieistotne (objects, lock) nie budzą onChange', async () => {
    vi.useFakeTimers();
    const gitDir = await makeRepo(root);
    const fake = fakeWatch();
    const onChange = vi.fn();
    const watcher = new GitRepoWatcher({ onChange, watchFn: fake.fn, debounceMs: 10 });
    watcher.watch(root);

    fake.emit(gitDir, 'objects/ab/cdef0123');
    fake.emit(gitDir, 'index.lock');
    vi.advanceTimersByTime(50);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('liczy referencje: repo puszcza dopiero ostatni unwatch, a zdarzenie w oknie debounce ginie', async () => {
    vi.useFakeTimers();
    const gitDir = await makeRepo(root);
    const fake = fakeWatch();
    const onChange = vi.fn();
    const watcher = new GitRepoWatcher({ onChange, watchFn: fake.fn, debounceMs: 10 });
    watcher.watch(root);
    watcher.watch(root);

    watcher.unwatch(root);
    expect(fake.closed).toEqual([]);
    expect(watcher.watching(root)).toBe(true);

    fake.emit(gitDir, 'HEAD');
    watcher.unwatch(root);
    expect(fake.closed).toEqual([gitDir]);
    expect(watcher.watching(root)).toBe(false);
    vi.advanceTimersByTime(50);
    // Repo puszczone przed końcem ciszy — nie ma komu mówić.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('awaria watchera (EMFILE) jest cicha i trwała: onUnavailable raz, potem cisza', async () => {
    vi.useFakeTimers();
    const gitDir = await makeRepo(root);
    const fake = fakeWatch();
    const onChange = vi.fn();
    const onUnavailable = vi.fn();
    const watcher = new GitRepoWatcher({ onChange, onUnavailable, watchFn: fake.fn, debounceMs: 10 });
    watcher.watch(root);

    fake.fail(gitDir, new Error('EMFILE'));
    fake.fail(gitDir, new Error('EMFILE'));
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(fake.closed).toEqual([gitDir]);
    expect(watcher.watching(root)).toBe(false);

    fake.emit(gitDir, 'HEAD');
    vi.advanceTimersByTime(50);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('worktree obserwuje SWÓJ gitdir i wspólny commondir', async () => {
    const main = join(root, 'main');
    const mainGit = await makeRepo(main);
    const wtGit = join(mainGit, 'worktrees', 'feature');
    await mkdir(wtGit, { recursive: true });
    await writeFile(join(wtGit, 'commondir'), '../..\n');
    const wt = join(root, 'feature');
    await mkdir(wt);
    await writeFile(join(wt, '.git'), `gitdir: ${wtGit}\n`);
    const fake = fakeWatch();
    const watcher = new GitRepoWatcher({ onChange: () => undefined, watchFn: fake.fn });

    watcher.watch(wt);
    expect(fake.opened).toEqual([wtGit, mainGit]);
  });

  it('katalog, który STAŁ SIĘ repo po pierwszym watch, dostaje watcher przy następnym', async () => {
    const fake = fakeWatch();
    const watcher = new GitRepoWatcher({ onChange: () => undefined, watchFn: fake.fn });
    const dir = join(root, 'nowy');
    await mkdir(dir);
    watcher.watch(dir);
    expect(fake.opened).toEqual([]);

    // `git init` z terminala po starcie sesji…
    const gitDir = await makeRepo(dir);
    watcher.watch(dir);
    expect(fake.opened).toEqual([gitDir]);
    expect(watcher.watching(dir)).toBe(true);

    // …a licznik liczy OBA watch: repo puszcza dopiero drugi unwatch.
    watcher.unwatch(dir);
    expect(fake.closed).toEqual([]);
    watcher.unwatch(dir);
    expect(fake.closed).toEqual([gitDir]);
  });

  it('katalog bez repo nie stawia watchera, a close() zamyka wszystko', async () => {
    const gitDir = await makeRepo(root);
    const plain = join(tmpdir(), 'rarog-git-watch-none-' + String(process.pid));
    const fake = fakeWatch();
    const watcher = new GitRepoWatcher({ onChange: () => undefined, watchFn: fake.fn });
    // Katalog nieistniejący na pewno nie ma `.git` po drodze od siebie — `findGitDirs`
    // zaczyna od niego samego, a stat nieistniejącej ścieżki to `null`.
    watcher.watch(join(plain, 'x', 'y'));
    watcher.watch(root);
    expect(fake.opened).toEqual([gitDir]);

    watcher.close();
    expect(fake.closed).toEqual([gitDir]);
    // Po close() nowe watch() nic nie zakłada.
    watcher.watch(root);
    expect(fake.opened).toHaveLength(1);
  });
});

describe('GitRepoWatcher — prawdziwy fs.watch', () => {
  /*
   * Test celowo słaby: sprawdza, że `fs.watch({recursive:true})` na macOS DOSTARCZA zdarzenie
   * o zmianie refa, a w piaskownicy (EMFILE) po prostu się pomija — reguła awarii jest
   * sprawdzona wyżej na atrapie. FSEvents pod obciążeniem (pełny `pnpm test`) potrafi
   * zgubić zapis zrobiony tuż po starcie strumienia, stąd odczekanie i ponawiane zapisy.
   */
  it('zapis refs/heads/main budzi onChange (skipped when the system gives no fs.watch on .git)', { timeout: 15_000 }, async (ctx) => {
    const gitDir = await makeRepo(root);
    let unavailable = false;
    let resolveChange: (cwds: readonly string[]) => void = () => undefined;
    const changed = new Promise<readonly string[]>((r) => { resolveChange = r; });
    const watcher = new GitRepoWatcher({
      onChange: (cwds) => { resolveChange(cwds); },
      onUnavailable: () => { unavailable = true; },
      debounceMs: 50,
    });
    watcher.watch(root);
    if (unavailable) {
      ctx.skip();
      return;
    }
    const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
    await sleep(250);
    let winner: readonly string[] | 'timeout' = 'timeout';
    for (let attempt = 0; attempt < 5 && winner === 'timeout' && !unavailable; attempt += 1) {
      await writeFile(join(gitDir, 'refs', 'heads', 'main'), `abc123${String(attempt)}\n`);
      winner = await Promise.race([
        changed,
        sleep(750).then((): 'timeout' => 'timeout'),
      ]);
    }
    watcher.close();
    if (unavailable) {
      ctx.skip();
      return;
    }
    expect(winner).toEqual([root]);
  });
});
