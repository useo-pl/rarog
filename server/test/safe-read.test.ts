/**
 * `server/src/safe-read.ts` wprost: granice sufitu, typy plików i dowiązania, oba warianty odczytu.
 *
 * Wołający (`discover`, `git-watch`, `uploads`, `statusline`, `cli-version`) mają własne reprodukcje z FIFO
 * w procesie potomnym. Tu stoją przypadki brzegowe samego helpera (pusty plik,
 * `maxBytes = 0`, dokładnie sufit, sufit + 1). FIFO czyta tu tylko wariant asynchroniczny: gdyby `O_NONBLOCK`
 * zniknął, zawiśnie wątek puli, a nie pętla zdarzeń, więc vitest zgłosi limit czasu zamiast wisieć.
 *
 * The directory read by identity: each platform's branch on the real disk where it runs, and the Linux descriptor
 * branch with its read through `/proc/self/fd` replaced, so its open, `fstat` and close run on macOS too.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IS_MAC, macOnly } from './platform.ts';

/** The descriptor branch of the directory read runs on the real disk only on Linux. */
const IS_LINUX = process.platform === 'linux';
import {
  DIRECTORY_IO, appendRegularFile, exactReader, openRegularFile, readDirectoryByIdentity, readRegularFile,
  readRegularFileSync,
} from '../src/safe-read.ts';
import type {
  DirectoryIdentity, DirectoryReadIo, ExactPiece, PositionalReader, ReadRegularOptions, RegularFileRead,
} from '../src/safe-read.ts';

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

describe('openRegularFile', () => {
  it('a regular file stays open: the handle reads its bytes and the stats come from the same descriptor', async () => {
    await writeFile(join(dir, 'f'), 'abcde');
    const opened = await openRegularFile(join(dir, 'f'), { followSymlink: false });
    expect(opened).not.toBeNull();
    if (opened === null) return;
    try {
      const path = await stat(join(dir, 'f'), { bigint: true });
      expect(opened.stats.size).toBe(5n);
      expect([opened.stats.dev, opened.stats.ino]).toEqual([path.dev, path.ino]);
      expect((await opened.handle.readFile()).toString('utf8')).toBe('abcde');
    } finally {
      await opened.handle.close();
    }
  });

  it('a directory and a FIFO without a writer are `null` at once; a symlink throws `ELOOP`, a missing file `ENOENT`', async () => {
    await mkdir(join(dir, 'kat'));
    expect(await openRegularFile(join(dir, 'kat'), { followSymlink: false })).toBeNull();
    execFileSync('mkfifo', [join(dir, 'fifo')]);
    expect(await openRegularFile(join(dir, 'fifo'), { followSymlink: false })).toBeNull();
    await writeFile(join(dir, 'cel'), 'x');
    await symlink(join(dir, 'cel'), join(dir, 'link'));
    await expect(openRegularFile(join(dir, 'link'), { followSymlink: false })).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(openRegularFile(join(dir, 'nie-ma'), { followSymlink: false })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('exactReader', () => {
  /** Every piece until `done` or `short`; `between` runs after each piece, before the next read. */
  async function drain(
    next: () => Promise<ExactPiece>, between: (index: number) => Promise<void> = async () => {},
  ): Promise<{ bytes: Buffer; pieces: number[]; end: ExactPiece['kind'] }> {
    const parts: Buffer[] = [];
    for (;;) {
      const piece = await next();
      if (piece.kind !== 'piece') {
        return { bytes: Buffer.concat(parts), pieces: parts.map((part) => part.length), end: piece.kind };
      }
      parts.push(piece.bytes);
      await between(parts.length);
    }
  }

  /** The file open on a descriptor, and a positional reader over that descriptor, as the port's handle reads. */
  async function opened(
    bytes: Buffer,
  ): Promise<{ file: string; handle: FileHandle; reader: PositionalReader; size: number }> {
    const file = join(dir, 'f.bin');
    await writeFile(file, bytes);
    const result = await openRegularFile(file, { followSymlink: false });
    if (result === null) throw new Error('not a regular file');
    const { handle } = result;
    const reader: PositionalReader = {
      read: async (length, position) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead);
      },
    };
    return { file, handle, reader, size: Number(result.stats.size) };
  }

  it('the first `size` bytes in pieces of at most `pieceBytes`, then `done`; empty is `done` at once', async () => {
    const bytes = Buffer.from(Array.from({ length: 10 }, (_, i) => i));
    const { handle, reader, size } = await opened(bytes);
    try {
      expect(await drain(exactReader(reader, size, 4))).toEqual({ bytes, pieces: [4, 4, 2], end: 'done' });
      expect(await drain(exactReader(reader, 0, 4))).toEqual({ bytes: Buffer.alloc(0), pieces: [], end: 'done' });
    } finally {
      await handle.close();
    }
  });

  it('bytes appended while it reads are not read: exactly `size` bytes', async () => {
    const bytes = Buffer.alloc(9, 1);
    const { file, handle, reader, size } = await opened(bytes);
    try {
      const append = async (): Promise<void> => { await appendRegularFile(file, 'more'); };
      const read = await drain(exactReader(reader, size, 4), append);
      expect(read).toEqual({ bytes, pieces: [4, 4, 1], end: 'done' });
    } finally {
      await handle.close();
    }
  });

  it('a file cut while it reads ends `short`, with the bytes read so far', async () => {
    const { file, handle, reader, size } = await opened(Buffer.alloc(12, 2));
    try {
      const read = await drain(exactReader(reader, size, 4), async () => { await writeFile(file, 'ab'); });
      expect(read).toEqual({ bytes: Buffer.alloc(4, 2), pieces: [4], end: 'short' });
    } finally {
      await handle.close();
    }
  });

  it('reads at its own offset: the position of the descriptor does not move what it sends', async () => {
    const bytes = Buffer.from('0123456789');
    const { handle, reader, size } = await opened(bytes);
    try {
      await handle.read(Buffer.alloc(5), 0, 5, null);
      const read = await drain(exactReader(reader, size, 3));
      expect(read.bytes.toString('utf8')).toBe('0123456789');
    } finally {
      await handle.close();
    }
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

describe('readDirectoryByIdentity', () => {
  /** `own` with a directory and a file, `outside` with a name of its own, and the identity of `own`. */
  async function directories(): Promise<{ own: string; outside: string; identity: DirectoryIdentity }> {
    const own = join(dir, 'own');
    await mkdir(join(own, 'sub'), { recursive: true });
    await writeFile(join(own, 'f.txt'), 'f');
    const outside = join(dir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 's');
    const info = await stat(own, { bigint: true });
    return { own, outside, identity: { dev: info.dev, ino: info.ino } };
  }

  /** A symlink to `outside` takes the name of `own`; the directory itself lives on as `own-old`. */
  async function swap(own: string, outside: string): Promise<void> {
    await rename(own, `${own}-old`);
    await symlink(outside, own);
  }

  /** `name:kind` of each entry, sorted. */
  const names = (entries: readonly Dirent<Buffer>[] | null): string[] | null => (entries === null
    ? null
    : entries.map((entry) => `${entry.name.toString('utf8')}:${entry.isDirectory() ? 'dir' : 'file'}`).sort());

  const OWN = ['f.txt:file', 'sub:dir'];

  const codeOf = async (read: Promise<unknown>): Promise<unknown> => {
    const error: unknown = await read.then(() => null, (failure: unknown) => failure);
    return (error as { code?: unknown } | null)?.code;
  };

  it('another platform: `null`, nothing opened', async () => {
    const { own, identity } = await directories();
    let opened = 0;
    const read = await readDirectoryByIdentity(own, identity, {
      platform: 'win32',
      openDirectory: async (target) => {
        opened += 1;
        return DIRECTORY_IO.openDirectory(target);
      },
    });
    expect([read, opened]).toEqual([null, 0]);
  });

  it.skipIf(!IS_MAC)(macOnly(
    'macOS: the entries of that identity, also once a symlink to another directory took its name; '
      + 'the identity of a file throws `ENOTDIR`, of a removed directory `ENOENT`',
    'the directory read by identity'),
    async () => {
      const { own, outside, identity } = await directories();
      expect(names(await readDirectoryByIdentity(own, identity))).toEqual(OWN);
      await swap(own, outside);
      expect(names(await readDirectoryByIdentity(own, identity))).toEqual(OWN);
      const file = await stat(join(`${own}-old`, 'f.txt'), { bigint: true });
      expect(await codeOf(readDirectoryByIdentity(own, { dev: file.dev, ino: file.ino }))).toBe('ENOTDIR');
      await rm(`${own}-old`, { recursive: true });
      expect(await codeOf(readDirectoryByIdentity(own, identity))).toBe('ENOENT');
    },
  );

  it.skipIf(!IS_LINUX)('Linux: the entries through the descriptor; a symlink in place of the directory fails the open (requires Linux)',
    async () => {
      const { own, outside, identity } = await directories();
      expect(names(await readDirectoryByIdentity(own, identity))).toEqual(OWN);
      await swap(own, outside);
      expect(['ELOOP', 'ENOTDIR']).toContain(await codeOf(readDirectoryByIdentity(own, identity)));
    },
  );

  describe('the descriptor branch, with the read through the descriptor replaced', () => {
    // `/proc/self/fd` exists on Linux only; the open with its flags and the `fstat` are the real calls here.
    function linux(readOpen: DirectoryReadIo['readOpen']): { io: Partial<DirectoryReadIo>; opened: FileHandle[] } {
      const opened: FileHandle[] = [];
      const openDirectory = async (target: string): Promise<FileHandle> => {
        const handle = await DIRECTORY_IO.openDirectory(target);
        opened.push(handle);
        return handle;
      };
      return { io: { platform: 'linux', openDirectory, readOpen }, opened };
    }

    it('reads the descriptor of the directory with that identity, then closes it', async () => {
      const { own, identity } = await directories();
      const seen: bigint[] = [];
      const { io, opened } = linux(async (fd) => {
        seen.push(fstatSync(fd, { bigint: true }).ino);
        return readdir(own, { withFileTypes: true, encoding: 'buffer' });
      });
      expect(names(await readDirectoryByIdentity(own, identity, io))).toEqual(OWN);
      expect(seen).toEqual([identity.ino]);
      expect(opened.map((handle) => handle.fd)).toEqual([-1]);
    });

    it('another directory under the path now: `null` without a read, the descriptor closed', async () => {
      const { own, identity } = await directories();
      await rename(own, `${own}-old`);
      await mkdir(own);
      let reads = 0;
      const { io, opened } = linux(async () => {
        reads += 1;
        return [];
      });
      expect(await readDirectoryByIdentity(own, identity, io)).toBeNull();
      expect(reads).toBe(0);
      expect(opened.map((handle) => handle.fd)).toEqual([-1]);
    });

    it('a symlink in place of the directory fails the open, nothing read', async () => {
      const { own, outside, identity } = await directories();
      await swap(own, outside);
      let reads = 0;
      const { io, opened } = linux(async () => {
        reads += 1;
        return [];
      });
      expect(['ELOOP', 'ENOTDIR']).toContain(await codeOf(readDirectoryByIdentity(own, identity, io)));
      expect([reads, opened.length]).toEqual([0, 0]);
    });

    it('an error of the read is thrown and the descriptor closed', async () => {
      const { own, identity } = await directories();
      const { io, opened } = linux(async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      expect(await codeOf(readDirectoryByIdentity(own, identity, io))).toBe('EACCES');
      expect(opened.map((handle) => handle.fd)).toEqual([-1]);
    });
  });
});
