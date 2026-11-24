/**
 * Odczyt i dopisanie WYŁĄCZNIE pliku zwykłego — jedyne miejsce w `server/src`, które otwiera pliki
 * w katalogu projektu i w katalogach, które agent w sandboksie zapisuje (`.git`, `.claude` projektu,
 * `.rarog-uploads`, `~/.claude/statusline`, `~/.claude/sessions`).
 *
 * Po co: agent Claude Code w sandboksie zapisuje katalog projektu, więc jedno `mkfifo` pod nazwą, którą serwer
 * czyta (`SKILL.md`, `.git/info/exclude`, `commondir`), zawieszało go. Synchroniczne `openSync` FIFO bez pisarza
 * zatrzymuje CAŁĄ pętlę zdarzeń, asynchroniczne `open` zajmuje wątek puli libuv na zawsze (domyślna pula ma cztery
 * wątki, a dzielą ją wszystkie operacje `fs` serwera). Urządzenie pod tą nazwą to ta sama klasa.
 *
 * Reguła, jedna dla wszystkich wołających:
 * - otwarcie z `O_NONBLOCK` (FIFO otwiera się od razu, bez pisarza) i `O_NOCTTY`, opcjonalnie `O_NOFOLLOW`;
 * - `fstat` na TYM SAMYM deskryptorze: nie-plik → `null` (między sprawdzeniem a odczytem nie ma okna na podmianę);
 * - odczyt najwyżej `maxBytes` (+1 bajt, żeby wiedzieć, czy plik był dłuższy): wynik `{ bytes, truncated }`.
 *   Wołający decyduje, czy prefiks mu wystarcza (nagłówek skilla), czy przekroczenie to odmowa (zdjęcie).
 *
 * Błędy otwarcia (`ENOENT`, `ELOOP` dowiązania przy `followSymlink: false`, `EACCES`, gniazdo) RZUCAJĄ: każdy
 * wołający ma już własną obsługę „nie da się przeczytać”, a `ensureGitExclude` odróżnia po `ENOENT` brak pliku
 * od pliku, którego nie wolno ruszyć. Pilnuje tego strażnik `server/test/pliki-zwykle-guard.test.ts`: odczyt
 * z `node:fs` poza tym modułem stoi na jego liście wyjątków z powodem.
 *
 * A file sent on in pieces opens with {@link openRegularFile} and is read with {@link exactReader}: exactly the bytes
 * of its `fstat`, from that one descriptor.
 *
 * Besides regular files, one directory read lives here, because on Linux it opens the directory:
 * {@link readDirectoryByIdentity} lists a directory through its `dev` and `ino` rather than its path. On Linux that
 * binds the read to the checked directory; on macOS it narrows the window of a swap but does not close it.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { BigIntStats, Dirent } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export interface ReadRegularOptions {
  /** Sufit odczytu w bajtach; dłuższy plik daje prefiks z `truncated: true`. */
  readonly maxBytes: number;
  /**
   * `false`: dowiązanie w ostatnim członie ścieżki to odmowa (`ELOOP`) — tam, gdzie dowiązanie jest wektorem
   * (`.git`, `.rarog-uploads`). `true`: dowiązanie wolno, bo jest funkcją (skille w `~/.claude/skills`).
   */
  readonly followSymlink: boolean;
}

export interface RegularFileRead {
  /** Najwyżej `maxBytes` bajtów od początku pliku. */
  readonly bytes: Buffer;
  /** Plik miał więcej niż `maxBytes` bajtów. */
  readonly truncated: boolean;
}

/** Pierwszy odczyt bierze rozmiar z `fstat` (+1, żeby od razu zobaczyć koniec); plik rosnący dostaje więcej. */
const GROW_FACTOR = 2;

function openFlags(followSymlink: boolean): number {
  return constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | (followSymlink ? 0 : constants.O_NOFOLLOW);
}

function initialBuffer(size: number, limit: number): Buffer {
  return Buffer.allocUnsafe(Math.max(1, Math.min(limit, size + 1)));
}

function grown(buffer: Buffer, filled: number, limit: number): Buffer {
  const next = Buffer.allocUnsafe(Math.min(limit, buffer.length * GROW_FACTOR));
  buffer.copy(next, 0, 0, filled);
  return next;
}

function result(buffer: Buffer, filled: number, maxBytes: number): RegularFileRead {
  const truncated = filled > maxBytes;
  return { bytes: buffer.subarray(0, truncated ? maxBytes : filled), truncated };
}

/** Plik zwykły albo `null` (FIFO, urządzenie, katalog). Rzuca przy błędzie otwarcia albo odczytu. */
export function readRegularFileSync(path: string, opts: ReadRegularOptions): RegularFileRead | null {
  const fd = openSync(path, openFlags(opts.followSymlink));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return null;
    const limit = opts.maxBytes + 1;
    let buffer = initialBuffer(info.size, limit);
    let filled = 0;
    for (;;) {
      if (filled === buffer.length) {
        if (buffer.length >= limit) break;
        buffer = grown(buffer, filled, limit);
      }
      const read = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    return result(buffer, filled, opts.maxBytes);
  } finally {
    closeSync(fd);
  }
}

/** Bliźniak asynchroniczny {@link readRegularFileSync}: ta sama reguła na `FileHandle`. */
export async function readRegularFile(path: string, opts: ReadRegularOptions): Promise<RegularFileRead | null> {
  const handle = await open(path, openFlags(opts.followSymlink));
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const limit = opts.maxBytes + 1;
    let buffer = initialBuffer(info.size, limit);
    let filled = 0;
    for (;;) {
      if (filled === buffer.length) {
        if (buffer.length >= limit) break;
        buffer = grown(buffer, filled, limit);
      }
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return result(buffer, filled, opts.maxBytes);
  } finally {
    await handle.close();
  }
}

/** A regular file left open: the handle and the `fstat` of that same descriptor, with `dev` and `ino` exact. */
export interface OpenedRegularFile {
  readonly handle: FileHandle;
  readonly stats: BigIntStats;
}

/**
 * The open of {@link readRegularFile} without the read, for a caller that sends the file on in pieces: the same
 * flags and the `fstat` on the descriptor; not a regular file → the handle is closed and the result is `null`. The
 * caller closes the handle. Throws on an error of the open, like the readers.
 */
export async function openRegularFile(
  path: string, opts: Pick<ReadRegularOptions, 'followSymlink'>,
): Promise<OpenedRegularFile | null> {
  const handle = await open(path, openFlags(opts.followSymlink));
  try {
    const stats = await handle.stat({ bigint: true });
    if (stats.isFile()) return { handle, stats };
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return null;
}

/** One step of {@link exactReader}: the next piece, the end of the first `size` bytes, or a file found shorter. */
export type ExactPiece =
  | { readonly kind: 'piece'; readonly bytes: Buffer }
  | { readonly kind: 'done' }
  | { readonly kind: 'short'; readonly read: number };

/** Bytes per piece of {@link exactReader} by default. */
export const EXACT_PIECE_BYTES = 64 * 1024;

/**
 * Reads the first `size` bytes of a file open on `handle` (the `fstat` size of {@link openRegularFile}), one piece
 * of at most `pieceBytes` per call, each at its own offset: the position of the descriptor does not matter, and bytes
 * appended past `size` are never read. `short`: the file ended before `size` bytes, so it was cut since its `fstat`
 * and what was read is not the file. The caller calls it one step at a time, owns the handle and closes it; an error
 * of the read rejects.
 */
export function exactReader(
  handle: Pick<FileHandle, 'read'>, size: number, pieceBytes: number = EXACT_PIECE_BYTES,
): () => Promise<ExactPiece> {
  let position = 0;
  return async () => {
    if (position >= size) return { kind: 'done' };
    const buffer = Buffer.allocUnsafe(Math.min(pieceBytes, size - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return { kind: 'short', read: position };
    position += bytesRead;
    return { kind: 'piece', bytes: bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead) };
  };
}

/** `dev` and `ino` of a directory, from a `stat` with `bigint: true`. */
export interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** The system calls of {@link readDirectoryByIdentity}; a test replaces one to run the Linux branch elsewhere. */
export interface DirectoryReadIo {
  readonly platform: NodeJS.Platform;
  /** Opens the directory itself: `O_DIRECTORY | O_NOFOLLOW`, so a symlink in the last segment fails the open. */
  readonly openDirectory: (dir: string) => Promise<FileHandle>;
  /** Entries of the directory open on `fd`, through `/proc/self/fd/<fd>`, which leads to the descriptor. */
  readonly readOpen: (fd: number) => Promise<Dirent<Buffer>[]>;
}

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const entriesOf = (dir: string): Promise<Dirent<Buffer>[]> => readdir(dir, { withFileTypes: true, encoding: 'buffer' });

export const DIRECTORY_IO: DirectoryReadIo = {
  platform: process.platform,
  openDirectory: (dir) => open(dir, DIRECTORY_FLAGS),
  readOpen: (fd) => entriesOf(`/proc/self/fd/${String(fd)}`),
};

/**
 * Entries of the directory `dir` whose `stat` gave `identity`, names as bytes, read through that identity instead of
 * the path:
 * - macOS: `/.vol/<dev>/<ino>`. The kernel turns the inode back into its current path and looks that path up within
 *   the one call (a parent without search permission refuses it), so a swap made before the call does not redirect
 *   it. A swap that lands inside the call still can: Node has no descriptor-based directory read on macOS, so this
 *   narrows the race and the caller's checks after the read narrow it further, but neither closes it.
 * - Linux: the directory opened with `O_DIRECTORY | O_NOFOLLOW`, its `fstat` must carry `identity`, and the entries
 *   come through `/proc/self/fd/<fd>`, that is from the open descriptor. The descriptor is closed on every path.
 *
 * `null`: another platform, or another directory stands under `dir` now. Throws on an error of the open or the read,
 * as `readdir` does (`EACCES` for a directory the server may not read, `ENOENT` for one removed).
 */
export async function readDirectoryByIdentity(
  dir: string, identity: DirectoryIdentity, io: Partial<DirectoryReadIo> = {},
): Promise<Dirent<Buffer>[] | null> {
  const { platform, openDirectory, readOpen } = { ...DIRECTORY_IO, ...io };
  if (platform === 'darwin') return entriesOf(`/.vol/${String(identity.dev)}/${String(identity.ino)}`);
  if (platform !== 'linux') return null;
  const handle = await openDirectory(dir);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino) return null;
    return await readOpen(handle.fd);
  } finally {
    await handle.close();
  }
}

/**
 * Dopisuje `text` na koniec pliku zwykłego, tworząc go, gdy go nie ma (prawa `0644` przed umaskiem).
 *
 * Deskryptor `O_WRONLY | O_APPEND | O_CREAT | O_NONBLOCK | O_NOFOLLOW` i `fstat` na nim PRZED zapisem: dowiązanie
 * w ostatnim członie rzuca (`ELOOP`), FIFO bez czytelnika rzuca (`ENXIO`), a FIFO z czytelnikiem i urządzenie dają
 * `false` bez jednego bajtu zapisu.
 *
 * @returns `true` = dopisane; `false` = to nie jest plik zwykły, nic nie zapisano.
 */
export async function appendRegularFile(path: string, text: string): Promise<boolean> {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK
    | constants.O_NOFOLLOW | constants.O_NOCTTY;
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, flags, 0o644);
    if (!(await handle.stat()).isFile()) return false;
    await handle.appendFile(text);
    return true;
  } finally {
    await handle?.close();
  }
}
