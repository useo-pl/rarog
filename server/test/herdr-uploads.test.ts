/**
 * Zdjęcia z telefonu do panelu herdr (`herdr/uploads.ts`).
 *
 * Testy pracują na PRAWDZIWYM katalogu tymczasowym: sednem modułu są prawa dostępu (0700/0600),
 * nazwy plików i sprzątanie po czasie — atrapa `fs` sprawdzałaby atrapę, a nie te trzy rzeczy.
 * Zegar jest wstrzykiwany, więc TTL 48 h da się przetestować bez czekania 48 h.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile,
} from 'node:fs/promises';
import { CHILD_TEST_TIMEOUT_MS, childJson, runInChild, serverModule } from './child-limit.ts';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  EXCLUDE_LINE, FALLBACK_UPLOAD_NAME, MAX_SANITIZED_NAME_CHARS, UPLOAD_DIR_NAME,
  ATTACHMENTS_ONLY_PROMPT, UPLOAD_FILE_NAME_PATTERN, UPLOAD_NAME_PATTERN, UploadError, appendAttachmentPaths,
  createUploads, parseFileDataUrl, parseImageDataUrl, readUploadWithinRoots, sanitizeUploadName,
} from '../src/herdr/uploads.ts';

/** PNG 1×1 (ten sam kształt, który przepuszcza `IMAGE_DATA_URL_PATTERN`). */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
  + 'DUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQ==';
/** „%PDF-1.4\n" — treść pliku jest tu nieistotna, ale ma być rozpoznawalna po odczycie. */
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';
const PDF_BYTES = '%PDF-1.4\n';

const HOUR = 3600 * 1000;

let base = '';
let cwd = '';
/** Sterowany zegar — moduł nie ma prawa wołać `Date.now()` sam z siebie. */
let now = Date.UTC(2026, 7, 22, 12, 0, 0);

const uploads = (): ReturnType<typeof createUploads> => createUploads({ now: () => now });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-uploads-'));
  cwd = join(base, 'projekt');
  await mkdir(cwd, { recursive: true });
  now = Date.UTC(2026, 7, 22, 12, 0, 0);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Test praw dostępu zostawia katalog bez prawa zapisu — inaczej `rm` by go nie ruszyło.
  await chmod(cwd, 0o700).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

const uploadDir = (): string => join(cwd, UPLOAD_DIR_NAME);

describe('parseImageDataUrl', () => {
  it('rozpoznaje png i jpeg, odrzuca wszystko inne', () => {
    expect(parseImageDataUrl(PNG)?.ext).toBe('png');
    expect(parseImageDataUrl(JPEG)?.ext).toBe('jpg');
    expect(parseImageDataUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(parseImageDataUrl('/Users/u/zdjecie.png')).toBeNull();
  });
});

describe('parseFileDataUrl', () => {
  it('bierze DOWOLNY typ MIME, ale tylko base64 i tylko niepustą treść', () => {
    expect(parseFileDataUrl(PDF)?.toString('utf8')).toBe(PDF_BYTES);
    expect(parseFileDataUrl('data:text/x-log;base64,YWJj')?.toString('utf8')).toBe('abc');
    expect(parseFileDataUrl('data:text/plain,zwykly')).toBeNull();
    expect(parseFileDataUrl('data:application/pdf;base64,')).toBeNull();
    expect(parseFileDataUrl('/Users/u/raport.pdf')).toBeNull();
  });
});

describe('sanitizeUploadName', () => {
  it('zostawia nazwę, po której człowiek i agent poznają plik', () => {
    expect(sanitizeUploadName('raport-q3.pdf')).toBe('raport-q3.pdf');
    expect(sanitizeUploadName('IMG_2043.HEIC')).toBe('IMG_2043.HEIC');
  });

  it('ze ścieżki bierze samą nazwę — POSIX i Windows', () => {
    // Gdyby przeszła ścieżka, `join(dir, name)` wyprowadziłby zapis poza `.rarog-uploads/`.
    expect(sanitizeUploadName('../../.ssh/authorized_keys')).toBe('authorized_keys');
    expect(sanitizeUploadName('C:\\Users\\u\\tajne.txt')).toBe('tajne.txt');
    expect(sanitizeUploadName('/etc/passwd')).toBe('passwd');
  });

  it('wszystko spoza [A-Za-z0-9._-] zamienia na myślnik', () => {
    // Ta nazwa ląduje w promptcie CUDZEGO terminala — spacje, cudzysłowy i `$(…)` odpadają.
    expect(sanitizeUploadName('raport "q3" $(whoami).pdf')).toBe('raport--q3----whoami-.pdf');
    // Emoji to JEDEN znak, nie dwa: nazwa jest przepisywana po punktach kodowych, więc
    // para zastępcza nie rozpada się na dwa myślniki (ani, gorzej, na pół znaku w nazwie pliku).
    expect(sanitizeUploadName('notatki ąćę 🙂.md')).toBe('notatki------.md');
  });

  it('docięcie nie zostawia nazwy bez ani jednej litery', () => {
    expect(sanitizeUploadName(`${'-'.repeat(MAX_SANITIZED_NAME_CHARS)}a.pdf`))
      .toBe(FALLBACK_UPLOAD_NAME);
  });

  it('nazwa nigdy nie zaczyna się kropką ani nie jest pusta', () => {
    expect(sanitizeUploadName('.env')).toBe(`${FALLBACK_UPLOAD_NAME}-.env`);
    expect(sanitizeUploadName('.gitignore')).toBe(`${FALLBACK_UPLOAD_NAME}-.gitignore`);
    expect(sanitizeUploadName('   ')).toBe(FALLBACK_UPLOAD_NAME);
    expect(sanitizeUploadName('...')).toBe(FALLBACK_UPLOAD_NAME);
  });

  it('docina długą nazwę, ale zostawia jej początek', () => {
    const long = `${'a'.repeat(200)}.pdf`;
    const cut = sanitizeUploadName(long);
    expect(cut).toHaveLength(MAX_SANITIZED_NAME_CHARS);
    expect(cut.startsWith('aaaa')).toBe(true);
  });
});

describe('writeFiles', () => {
  it('zapisuje treść bajt w bajt, 0600, w tym samym katalogu co zdjęcia', async () => {
    const paths = await uploads().writeFiles(cwd, [{ name: 'raport-q3.pdf', dataUrl: PDF }]);

    expect(paths).toHaveLength(1);
    const path = paths[0] ?? '';
    expect(isAbsolute(path)).toBe(true);
    expect(path.startsWith(`${uploadDir()}/`)).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(uploadDir())).mode & 0o777).toBe(0o700);
    expect(await readFile(path, 'utf8')).toBe(PDF_BYTES);
  });

  it('nazwa to czas + entropia + NAZWA ORYGINALNA', async () => {
    await uploads().writeFiles(cwd, [{ name: 'raport q3.pdf', dataUrl: PDF }]);

    const name = (await readdir(uploadDir()))[0] ?? '';
    expect(name).toMatch(UPLOAD_FILE_NAME_PATTERN);
    // Oryginalna nazwa ZOSTAJE: bez niej ani agent, ani człowiek nie wie, co to za plik.
    expect(name.endsWith('-raport-q3.pdf')).toBe(true);
    expect(name.startsWith(`${String(now)}-`)).toBe(true);
  });

  it('nazwa ze ścieżką nie wyprowadza zapisu poza katalog załączników', async () => {
    const paths = await uploads().writeFiles(cwd, [
      { name: '../../.ssh/authorized_keys', dataUrl: PDF },
    ]);

    const path = paths[0] ?? '';
    expect(path.startsWith(`${uploadDir()}/`)).toBe(true);
    expect(await readdir(uploadDir())).toEqual([expect.stringMatching(/-authorized_keys$/)]);
  });

  it('zachowuje kolejność wejścia i nie zderza dwóch plików o tej samej nazwie', async () => {
    const paths = await uploads().writeFiles(cwd, [
      { name: 'a.txt', dataUrl: 'data:text/plain;base64,YQ==' },
      { name: 'a.txt', dataUrl: 'data:text/plain;base64,Yg==' },
    ]);

    expect(paths[0]).not.toBe(paths[1]);
    expect(await readFile(paths[0] ?? '', 'utf8')).toBe('a');
    expect(await readFile(paths[1] ?? '', 'utf8')).toBe('b');
  });

  it('załącznik bez poprawnej treści przerywa wysyłkę wyjątkiem', async () => {
    await expect(uploads().writeFiles(cwd, [{ name: 'a.txt', dataUrl: 'data:text/plain,abc' }]))
      .rejects.toBeInstanceOf(UploadError);
    // „Nic nie zostało wysłane" ma być prawdą także dla dysku.
    expect(await readdir(uploadDir())).toEqual([]);
  });

  it('brak prawa zapisu daje wyjątek z kodem, po którym router robi 400', async () => {
    await chmod(cwd, 0o500);
    const promise = uploads().writeFiles(cwd, [{ name: 'a.txt', dataUrl: PDF }]);
    await expect(promise).rejects.toBeInstanceOf(UploadError);
    await promise.catch((err: unknown) => {
      expect((err as { code?: string }).code).toBe('bad-request');
    });
  });

  it('brak plików nie tworzy katalogu', async () => {
    expect(await uploads().writeFiles(cwd, [])).toEqual([]);
    await expect(stat(uploadDir())).rejects.toThrow();
  });

  it('sprząta stare załączniki i dopisuje wykluczenie do gita — jak zdjęcia', async () => {
    await mkdir(join(cwd, '.git'), { recursive: true });
    await mkdir(uploadDir(), { recursive: true, mode: 0o700 });
    const stale = join(uploadDir(), '1-aaaaaaaa-stary.pdf');
    await writeFile(stale, 'x');
    const when = new Date(now - 72 * HOUR);
    await utimes(stale, when, when);

    await uploads().writeFiles(cwd, [{ name: 'nowy.pdf', dataUrl: PDF }]);

    await expect(stat(stale)).rejects.toThrow();
    const exclude = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n')).toContain(EXCLUDE_LINE);
  });
});

describe('write', () => {
  it('tworzy katalog 0700 i zapisuje pliki 0600 pod ścieżkami bezwzględnymi', async () => {
    const paths = await uploads().write(cwd, [PNG, JPEG]);

    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(isAbsolute(path)).toBe(true);
      const info = await stat(path);
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o777).toBe(0o600);
    }
    const dir = await stat(uploadDir());
    expect(dir.mode & 0o777).toBe(0o700);
  });

  it('nazwa ma znacznik czasu i entropię, a dwa zapisy w tej samej ms się nie zderzają', async () => {
    const [first] = await uploads().write(cwd, [PNG]);
    const [second] = await uploads().write(cwd, [PNG]);

    const names = (await readdir(uploadDir())).sort();
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(UPLOAD_NAME_PATTERN);
    // Ten sam zegar w obu wywołaniach — różnicę robi WYŁĄCZNIE 16 znaków hex.
    expect(first).not.toBe(second);
    expect(names[0]?.startsWith(`${String(now)}-`)).toBe(true);
  });

  it('zachowuje kolejność wejścia i rozszerzenie zgodne z typem obrazka', async () => {
    const paths = await uploads().write(cwd, [JPEG, PNG]);
    expect(paths[0]?.endsWith('.jpg')).toBe(true);
    expect(paths[1]?.endsWith('.png')).toBe(true);
  });

  it('załącznik, który nie jest png/jpeg, przerywa wysyłkę wyjątkiem', async () => {
    await expect(uploads().write(cwd, ['data:text/html;base64,PHNjcmlwdD4=']))
      .rejects.toBeInstanceOf(UploadError);
    // Nic nie mogło zostać zapisane — inaczej „nic nie zostało wysłane" byłoby kłamstwem.
    expect(await readdir(uploadDir())).toEqual([]);
  });

  it('brak prawa zapisu w cwd daje wyjątek, a nie cichą wysyłkę bez zdjęcia', async () => {
    await chmod(cwd, 0o500);
    const promise = uploads().write(cwd, [PNG]);
    await expect(promise).rejects.toBeInstanceOf(UploadError);
    // `code` jest tym, po czym router robi 400 zamiast 500.
    await promise.catch((err: unknown) => {
      expect((err as { code?: string }).code).toBe('bad-request');
    });
  });

  it('brak zdjęć nie tworzy katalogu', async () => {
    expect(await uploads().write(cwd, [])).toEqual([]);
    await expect(stat(uploadDir())).rejects.toThrow();
  });
});

describe('.git/info/exclude', () => {
  it('dostaje wpis raz, nie dwa razy', async () => {
    await mkdir(join(cwd, '.git'), { recursive: true });

    await uploads().write(cwd, [PNG]);
    await uploads().write(cwd, [PNG]);

    const text = await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8');
    const hits = text.split('\n').filter((line) => line.trim() === EXCLUDE_LINE);
    expect(hits).toHaveLength(1);
  });

  it('dopisuje do istniejącej treści bez sklejania linii', async () => {
    await mkdir(join(cwd, '.git', 'info'), { recursive: true });
    await writeFile(join(cwd, '.git', 'info', 'exclude'), '# własne wykluczenia\n*.log');

    await uploads().write(cwd, [PNG]);

    const lines = (await readFile(join(cwd, '.git', 'info', 'exclude'), 'utf8')).split('\n');
    expect(lines).toContain('*.log');
    expect(lines).toContain(EXCLUDE_LINE);
  });

  it('brak repozytorium nie przeszkadza w zapisie zdjęcia', async () => {
    const paths = await uploads().write(cwd, [PNG]);
    expect(paths).toHaveLength(1);
    await expect(stat(join(cwd, '.git'))).rejects.toThrow();
  });

  /*
   * Agent w sandboksie zapisuje `.git`, a `git clone` nie jest jedyną drogą do jego wnętrza. Dowiązanie
   * w miejscu `exclude` przekierowałoby dopisanie do cudzego pliku; dowiązane `info/` — do cudzego katalogu.
   */
  it('dowiązanie w miejscu `exclude`: cel nietknięty, zdjęcie i tak idzie', async () => {
    await mkdir(join(cwd, '.git', 'info'), { recursive: true });
    const target = join(base, 'cudzy.txt');
    await writeFile(target, 'cudza treść\n');
    await symlink(target, join(cwd, '.git', 'info', 'exclude'));

    expect(await uploads().write(cwd, [PNG])).toHaveLength(1);
    expect(await readFile(target, 'utf8')).toBe('cudza treść\n');
  });

  it('dowiązane `.git/info`: w celu nie powstaje `exclude`, zdjęcie i tak idzie', async () => {
    await mkdir(join(cwd, '.git'), { recursive: true });
    const target = join(base, 'cudzy-katalog');
    await mkdir(target);
    await symlink(target, join(cwd, '.git', 'info'));

    expect(await uploads().write(cwd, [PNG])).toHaveLength(1);
    expect(await readdir(target)).toEqual([]);
  });

  /*
   * FIFO jako `exclude`: odczyt bez `O_NONBLOCK` czekał na pisarza, a po nieudanym odczycie szło `appendFile`,
   * które przy czytelniku zapisuje do kolejki. Test trzyma własny czytelnik (dziecko otwiera FIFO z
   * `O_NONBLOCK`), więc każde dopisanie byłoby widać w kolejce. Reprodukcja w procesie potomnym (`child-limit.ts`):
   * zablokowany wątek puli libuv nie puszcza procesu.
   */
  it('FIFO jako `exclude`: CAŁY upload kończy się, a FIFO nie dostaje zapisu', async () => {
    await mkdir(join(cwd, '.git', 'info'), { recursive: true });
    const fifo = join(cwd, '.git', 'info', 'exclude');
    execFileSync('mkfifo', [fifo]);
    const result = childJson<{ paths: number; queued: string }>(await runInChild(base, `
import { constants, openSync, readSync } from 'node:fs';
import { createUploads } from ${serverModule('herdr/uploads.ts')};
const reader = openSync(${JSON.stringify(fifo)}, constants.O_RDONLY | constants.O_NONBLOCK);
const paths = await createUploads().write(${JSON.stringify(cwd)}, [${JSON.stringify(PNG)}]);
const buffer = Buffer.alloc(4096);
let queued = '';
try {
  queued = buffer.subarray(0, readSync(reader, buffer, 0, buffer.length, null)).toString('utf8');
} catch (error) {
  if (error.code !== 'EAGAIN') throw error;
}
console.log(JSON.stringify({ paths: paths.length, queued }));
process.exit(0);
`));
    expect(result).toEqual({ paths: 1, queued: '' });
  }, CHILD_TEST_TIMEOUT_MS);
});

describe('read — tylko zwykły plik w granicach sufitu', () => {
  const NAME = '1788361542375-67f5f846e6fe49e7.png';

  it('FIFO pod nazwą zdjęcia: `null`, bez zawieszenia', async () => {
    await mkdir(uploadDir(), { recursive: true });
    execFileSync('mkfifo', [join(uploadDir(), NAME)]);
    const result = childJson<{ image: unknown }>(await runInChild(base, `
import { createUploads } from ${serverModule('herdr/uploads.ts')};
const image = await createUploads().read(${JSON.stringify(cwd)}, ${JSON.stringify(NAME)});
console.log(JSON.stringify({ image }));
process.exit(0);
`));
    expect(result).toEqual({ image: null });
  }, CHILD_TEST_TIMEOUT_MS);

  it('plik rzadki ponad sufit 4 MB: `null`, a nie całość w pamięci', async () => {
    await mkdir(uploadDir(), { recursive: true });
    execFileSync('truncate', ['-s', String(16 * 1024 * 1024), join(uploadDir(), NAME)]);
    // Długość, nie cały wynik: porażka drukowałaby 16 MB bufora.
    expect((await uploads().read(cwd, NAME))?.bytes.length ?? null).toBeNull();
  });
});

describe('sweep', () => {
  /** Kładzie plik z podanym wiekiem w katalogu zdjęć. */
  const aged = async (name: string, ageMs: number): Promise<string> => {
    await mkdir(uploadDir(), { recursive: true, mode: 0o700 });
    const path = join(uploadDir(), name);
    await writeFile(path, 'x');
    const when = new Date(now - ageMs);
    await utimes(path, when, when);
    return path;
  };

  it('kasuje plik starszy niż 48 h i zostawia młodszy', async () => {
    const old = await aged('1-aaaaaaaaaaaaaaaa.png', 49 * HOUR);
    const fresh = await aged('2-bbbbbbbbbbbbbbbb.png', 47 * HOUR);

    await uploads().sweep(cwd);

    await expect(stat(old)).rejects.toThrow();
    expect((await stat(fresh)).isFile()).toBe(true);
  });

  it('sprząta też przy zapisie nowego zdjęcia', async () => {
    const old = await aged('1-cccccccccccccccc.png', 72 * HOUR);

    await uploads().write(cwd, [PNG]);

    await expect(stat(old)).rejects.toThrow();
    expect(await readdir(uploadDir())).toHaveLength(1);
  });

  it('brak katalogu nie jest błędem', async () => {
    await expect(uploads().sweep(join(base, 'nie-ma'))).resolves.toBeUndefined();
  });

  it('sweepAll schodzi w korzenie projektów i pomija node_modules', async () => {
    const nested = join(base, 'Projects', 'klient', 'appka');
    await mkdir(join(nested, UPLOAD_DIR_NAME), { recursive: true });
    const stale = join(nested, UPLOAD_DIR_NAME, '1-dddddddddddddddd.png');
    await writeFile(stale, 'x');
    const when = new Date(now - 72 * HOUR);
    await utimes(stale, when, when);

    const skipped = join(base, 'Projects', 'node_modules', 'paczka', UPLOAD_DIR_NAME);
    await mkdir(skipped, { recursive: true });
    const kept = join(skipped, '2-eeeeeeeeeeeeeeee.png');
    await writeFile(kept, 'x');
    await utimes(kept, when, when);

    await uploads().sweepAll([join(base, 'Projects')]);

    await expect(stat(stale)).rejects.toThrow();
    expect((await stat(kept)).isFile()).toBe(true);
  });

  it('sweepAll ignoruje ścieżki względne i nieistniejące korzenie', async () => {
    await expect(uploads().sweepAll(['relatywna', join(base, 'nie-ma')]))
      .resolves.toBeUndefined();
  });
});

describe('podłożone dowiązanie pod .rarog-uploads', () => {
  /*
   * Wektor z audytu: git przechowuje dowiązania z dowolnym celem, więc `git clone`
   * wrogiego repozytorium do korzenia projektów materializuje `.rarog-uploads -> gdziekolwiek`
   * BEZ powłoki atakującego. Trzy operacje Raroga podążały wtedy za dowiązaniem: `chmod 0700`
   * na cudzym katalogu, zapis zdjęcia w nim i — najgorsze, bo bez żądania z telefonu — sweep
   * startowy kasujący wszystko starsze niż 48 h.
   */
  const HIDDEN = 'notatki.txt';

  /** Cudzy katalog (prawa 0755) z plikiem starszym niż TTL + dowiązanie podłożone w `at`. */
  const trap = async (at: string = cwd, name: string = UPLOAD_DIR_NAME): Promise<string> => {
    const victim = join(base, 'ofiara');
    await mkdir(victim, { recursive: true });
    await chmod(victim, 0o755);
    const file = join(victim, HIDDEN);
    await writeFile(file, 'tajne');
    const when = new Date(now - 72 * HOUR);
    await utimes(file, when, when);
    await mkdir(at, { recursive: true });
    await symlink(victim, join(at, name));
    return victim;
  };

  it('write rzuca zamiast zapisać zdjęcie w cudzym katalogu', async () => {
    const victim = await trap();

    const promise = uploads().write(cwd, [PNG]);

    await expect(promise).rejects.toBeInstanceOf(UploadError);
    // `code` jest tym, po czym router robi 400 — użytkownik ma zobaczyć zdanie, nie „500".
    await promise.catch((err: unknown) => {
      expect((err as { code?: string }).code).toBe('bad-request');
      expect((err as UploadError).sentence).toMatchObject({ ref: { code: 'uploads.dir-not-directory.symlink' } });
    });
    expect(await readdir(victim)).toEqual([HIDDEN]);
  });

  it('writeFiles też rzuca — obie drogi wejścia mają tę samą bramkę', async () => {
    const victim = await trap();

    await expect(uploads().writeFiles(cwd, [{ name: 'raport-q3.pdf', dataUrl: PDF }]))
      .rejects.toBeInstanceOf(UploadError);
    expect(await readdir(victim)).toEqual([HIDDEN]);
  });

  it('nie przestawia praw cudzego katalogu na 0700', async () => {
    const victim = await trap();

    await uploads().write(cwd, [PNG]).catch(() => undefined);

    // 0700 na cudzym katalogu odcięłoby od niego resztę systemu — i to bez śladu w logu.
    expect((await stat(victim)).mode & 0o777).toBe(0o755);
    // Samo dowiązanie zostaje nietknięte: to użytkownik ma je usunąć, nie Rarog.
    expect((await lstat(uploadDir())).isSymbolicLink()).toBe(true);
  });

  it('sweep nie kasuje plików w celu dowiązania i mówi o tym w logu', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const victim = await trap();

    await expect(uploads().sweep(cwd)).resolves.toBeUndefined();

    expect(await readdir(victim)).toEqual([HIDDEN]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(UPLOAD_DIR_NAME));
  });

  it('sweepAll startowy nie kasuje plików w celu dowiązania', async () => {
    // Ta ścieżka leci przy KAŻDYM starcie serwera — bez cookie i bez żądania z telefonu.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const victim = await trap(join(base, 'Projects', 'wrogie-repo'));

    await expect(uploads().sweepAll([join(base, 'Projects')])).resolves.toBeUndefined();

    expect(await readdir(victim)).toEqual([HIDDEN]);
  });

  it('.rarog-uploads jako zwykły plik też jest odmową, a nie 500', async () => {
    await writeFile(uploadDir(), 'nie katalog');

    const promise = uploads().write(cwd, [PNG]);

    await expect(promise).rejects.toBeInstanceOf(UploadError);
    await promise.catch((err: unknown) => {
      expect((err as UploadError).sentence).toMatchObject({ ref: { code: 'uploads.dir-not-directory.file' } });
    });
  });

  it('.git jako dowiązanie nie dostaje wykluczenia, a zdjęcie i tak idzie', async () => {
    const victim = await trap(cwd, '.git');

    const paths = await uploads().write(cwd, [PNG]);

    expect(paths).toHaveLength(1);
    // Bez `lstat` Rarog dopisałby wykluczenie do CUDZEGO repozytorium (i założył w nim `info/`).
    expect(await readdir(victim)).toEqual([HIDDEN]);
  });
});

describe('appendAttachmentPaths', () => {
  /*
   * Format doklejenia jest ZMIERZONY na żywym panelu, nie wybrany.
   * Ścieżka stojąca w linii SAMA zawiesza prompt w polu wejściowym `claude` — TUI zamienia
   * ją w załącznik `[Image #N]` i przestaje traktować wysyłkę jako gotową. Dlatego ścieżka
   * NIGDY nie zaczyna linii i doklejamy ją po spacji do ostatniej linii tekstu. Na CLI 2.1.302
   * zawisania już nie ma, ale format zostaje — działa na obu wersjach.
   */
  it('dokleja ścieżki po spacji, w ostatniej linii promptu', () => {
    const text = appendAttachmentPaths('Co jest na tym zrzucie?', ['/a/1.png', '/a/2.jpg']);
    expect(text).toBe('Co jest na tym zrzucie? /a/1.png /a/2.jpg');
  });

  it('nowe linie użytkownika zostają, ale ścieżka nie zaczyna żadnej z nich', () => {
    const text = appendAttachmentPaths('pierwszy akapit\n\ndrugi akapit', ['/a/1.png']);
    expect(text).toBe('pierwszy akapit\n\ndrugi akapit /a/1.png');
    expect(text.split('\n').some((line) => line.trimStart().startsWith('/a/'))).toBe(false);
  });

  it('pusty prompt dostaje stały tekst przed ścieżkami, brak ścieżek nie rusza tekstu', () => {
    expect(appendAttachmentPaths('   ', ['/a/1.png'])).toBe(`${ATTACHMENTS_ONLY_PROMPT} /a/1.png`);
    expect(ATTACHMENTS_ONLY_PROMPT).toBe('(załącznik)');
    expect(appendAttachmentPaths('bez zdjęć', [])).toBe('bez zdjęć');
  });

  it('zdjęcia i pliki idą w JEDNYM bloku, w kolejności wejścia', () => {
    // Dwa bloki („zdjęcia tu, pliki tam") to drugi format do zmierzenia na żywym panelu
    // i drugi sposób, w jaki prompt może zawisnąć w cudzym polu wejściowym.
    const text = appendAttachmentPaths('zerknij', ['/a/1.png', '/a/2-raport.pdf']);
    expect(text).toBe('zerknij /a/1.png /a/2-raport.pdf');
    expect(text.split('\n')).toHaveLength(1);
  });
});

/*
 * Katalog czytnika to `session.cwd` — katalog z chwili pojawienia się panelu. Zasięg karty idzie za
 * `cd`, więc sam `outOfScope` nie wystarcza: czytnik sam odmawia katalogom spoza korzeni.
 */
describe('readUploadWithinRoots', () => {
  it('katalog spoza korzeni: null i ani jednego pytania o dysk', async () => {
    const calls: [string, string][] = [];
    const read = readUploadWithinRoots({
      read: (cwd, name) => { calls.push([cwd, name]); return Promise.resolve({ bytes: Buffer.from('x'), mime: 'image/png' }); },
    }, ['/Users/u/Projects']);

    expect(await read('/Users/u/Prywatne/birch', 'a.png')).toBeNull();
    expect(await read('/Users/u/Projects-inne/x', 'a.png')).toBeNull();
    expect(await read('wzgledna/sciezka', 'a.png')).toBeNull();
    expect(calls).toEqual([]);

    expect(await read('/Users/u/Projects/atlas', 'a.png')).toEqual({ bytes: Buffer.from('x'), mime: 'image/png' });
    expect(calls).toEqual([['/Users/u/Projects/atlas', 'a.png']]);
  });

  it('with the root ~: a protected folder and a hidden entry of home give null without a read', async () => {
    const calls: string[] = [];
    const read = readUploadWithinRoots({
      read: (cwd) => { calls.push(cwd); return Promise.resolve({ bytes: Buffer.from('x'), mime: 'image/png' }); },
    }, ['/Users/u'], '/Users/u');
    expect(await read('/Users/u/Desktop/x', 'a.png')).toBeNull();
    expect(await read('/Users/u/.cache/x', 'a.png')).toBeNull();
    expect(calls).toEqual([]);
    expect(await read('/Users/u/inne/x', 'a.png')).not.toBeNull();
  });

  it('bez korzeni nie oddaje niczego', async () => {
    const read = readUploadWithinRoots({ read: () => Promise.resolve({ bytes: Buffer.from('x'), mime: 'image/png' }) }, []);
    expect(await read('/Users/u/Projects/atlas', 'a.png')).toBeNull();
  });

  it('on disk: a symlink into ~/Desktop and a root symlinked to home give null without a read', async () => {
    const home = join(base, 'home');
    const dom = join(base, 'dom');
    await mkdir(join(home, 'Desktop', 'x'), { recursive: true });
    await mkdir(join(home, 'inne', 'x'), { recursive: true });
    await symlink(join(home, 'Desktop', 'x'), join(home, 'inne', 'link'));
    await symlink(home, dom);
    const calls: string[] = [];
    const reader = {
      read: (dir: string) => { calls.push(dir); return Promise.resolve({ bytes: Buffer.from('x'), mime: 'image/png' }); },
    };
    expect(await readUploadWithinRoots(reader, [home], home)(join(home, 'inne', 'link'), 'a.png')).toBeNull();
    expect(await readUploadWithinRoots(reader, [dom], home)(join(dom, 'Desktop', 'x'), 'a.png')).toBeNull();
    expect(calls).toEqual([]);
    expect(await readUploadWithinRoots(reader, [dom], home)(join(dom, 'inne', 'x'), 'a.png')).not.toBeNull();
  });
});
