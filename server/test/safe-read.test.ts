/**
 * `server/src/safe-read.ts` wprost: granice sufitu, typy plików i dowiązania, oba warianty odczytu.
 *
 * Wołający (`discover`, `git-watch`, `uploads`, `statusline`, `cli-version`) mają własne reprodukcje z FIFO
 * w procesie potomnym. Tu stoją przypadki brzegowe samego helpera (pusty plik,
 * `maxBytes = 0`, dokładnie sufit, sufit + 1). FIFO czyta tu tylko wariant asynchroniczny: gdyby `O_NONBLOCK`
 * zniknął, zawiśnie wątek puli, a nie pętla zdarzeń, więc vitest zgłosi limit czasu zamiast wisieć.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync, readSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRegularFile, readRegularFile, readRegularFileSync } from '../src/safe-read.ts';
import type { ReadRegularOptions, RegularFileRead } from '../src/safe-read.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarog-safe-read-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const VARIANTS: readonly [string, (path: string, opts: ReadRegularOptions) => Promise<RegularFileRead | null>][] = [
  ['sync', (path, opts) => Promise.resolve().then(() => readRegularFileSync(path, opts))],
  ['async', readRegularFile],
];

const text = (read: RegularFileRead | null): { text: string; truncated: boolean } | null =>
  read === null ? null : { text: read.bytes.toString('utf8'), truncated: read.truncated };

describe.each(VARIANTS)('readRegularFile (%s)', (_name, read) => {
  const nofollow = (maxBytes: number): ReadRegularOptions => ({ maxBytes, followSymlink: false });

  it('pusty plik: zero bajtów, bez `truncated`; także przy `maxBytes = 0`', async () => {
    await writeFile(join(dir, 'pusty'), '');
    expect(text(await read(join(dir, 'pusty'), nofollow(10)))).toEqual({ text: '', truncated: false });
    expect(text(await read(join(dir, 'pusty'), nofollow(0)))).toEqual({ text: '', truncated: false });
  });

  it('granice sufitu: dokładnie `maxBytes` w całości, `maxBytes + 1` daje prefiks z `truncated`', async () => {
    await writeFile(join(dir, 'f'), 'abcde');
    expect(text(await read(join(dir, 'f'), nofollow(5)))).toEqual({ text: 'abcde', truncated: false });
    expect(text(await read(join(dir, 'f'), nofollow(6)))).toEqual({ text: 'abcde', truncated: false });
    expect(text(await read(join(dir, 'f'), nofollow(4)))).toEqual({ text: 'abcd', truncated: true });
    expect(text(await read(join(dir, 'f'), nofollow(0)))).toEqual({ text: '', truncated: true });
  });

  it('plik większy niż jeden odczyt wraca w całości, gdy mieści się w sufit', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
    await writeFile(join(dir, 'duzy'), big);
    const result = await read(join(dir, 'duzy'), nofollow(4 * 1024 * 1024));
    expect(result?.truncated).toBe(false);
    expect(result?.bytes.equals(big)).toBe(true);
  });

  it('katalog to `null`; brak pliku rzuca `ENOENT`', async () => {
    await mkdir(join(dir, 'kat'));
    expect(await read(join(dir, 'kat'), nofollow(10))).toBeNull();
    await expect(read(join(dir, 'nie-ma'), nofollow(10))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('dowiązanie: `followSymlink: false` rzuca `ELOOP`, `true` czyta cel', async () => {
    await writeFile(join(dir, 'cel'), 'treść');
    await symlink(join(dir, 'cel'), join(dir, 'link'));
    await expect(read(join(dir, 'link'), nofollow(10))).rejects.toMatchObject({ code: 'ELOOP' });
    expect(text(await read(join(dir, 'link'), { maxBytes: 64, followSymlink: true })))
      .toEqual({ text: 'treść', truncated: false });
  });
});

describe('readRegularFile — FIFO', () => {
  it('FIFO bez pisarza: `null` od razu, bez zajęcia wątku puli', async () => {
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    expect(await readRegularFile(join(dir, 'fifo'), { maxBytes: 10, followSymlink: false })).toBeNull();
  });
});

describe('appendRegularFile', () => {
  it('brak pliku: tworzy go z prawami 0644 (przed umaskiem) i dopisuje; drugi raz dopisuje na koniec', async () => {
    const file = join(dir, 'exclude');
    expect(await appendRegularFile(file, 'a\n')).toBe(true);
    expect(await appendRegularFile(file, 'b\n')).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('a\nb\n');
    expect((await stat(file)).mode & 0o022).toBe(0);
    expect((await stat(file)).mode & 0o644).toBe((0o644 & ~process.umask()) & 0o644);
  });

  it('dowiązanie rzuca `ELOOP`, a cel zostaje nietknięty; katalog rzuca', async () => {
    await writeFile(join(dir, 'cel'), 'stare\n');
    await symlink(join(dir, 'cel'), join(dir, 'link'));
    await expect(appendRegularFile(join(dir, 'link'), 'x\n')).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await readFile(join(dir, 'cel'), 'utf8')).toBe('stare\n');
    await mkdir(join(dir, 'kat'));
    await expect(appendRegularFile(join(dir, 'kat'), 'x\n')).rejects.toThrow();
  });

  it('FIFO bez czytelnika rzuca `ENXIO`; z czytelnikiem daje `false` i nie wysyła ani bajtu', async () => {
    const fifo = join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    await expect(appendRegularFile(fifo, 'x\n')).rejects.toMatchObject({ code: 'ENXIO' });
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      expect(await appendRegularFile(fifo, 'x\n')).toBe(false);
      const buffer = Buffer.alloc(16);
      let got = 0;
      try {
        got = readSync(reader, buffer, 0, buffer.length, null);
      } catch (error) {
        // Pusta kolejka przy otwartym pisarzu: `EAGAIN`; bez pisarza `read` daje 0.
        expect((error as NodeJS.ErrnoException).code).toBe('EAGAIN');
      }
      expect(got).toBe(0);
    } finally {
      closeSync(reader);
    }
  });
});
