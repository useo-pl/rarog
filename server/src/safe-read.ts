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
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { open } from 'node:fs/promises';
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
