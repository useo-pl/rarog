/**
 * Zapis atomowy plików kanału cienia (`alive.json`, plik cienia, rekord cyklu): plik tymczasowy w TYM SAMYM
 * katalogu, potem `rename`.
 *
 * Nazwa tymczasowa zaczyna się kropką i kończy `.tmp`, nigdy `.json`: hook bierze KAŻDY plik `<klucz>.json`
 * z `shadow/<sesja>/` od razu (`rename` na `<klucz>.claimed`), więc plik w trakcie zapisu pod nazwą `.json`
 * dałby mu połowę treści. Zapis `wx` z prawami `0600`, katalog `0700`. Błąd = wyjątek, plik tymczasowy
 * sprzątnięty; wołający decyduje, czy porażka coś zmienia (w kanale cienia nie zmienia niczego).
 *
 * Opcja `fsync` (domyślnie wyłączona) wymusza treść pliku tymczasowego na dysk PRZED `rename`: po awarii procesu
 * plik pod docelową nazwą ma całą treść albo go nie ma. Katalogu nie synchronizuje, więc nie chroni kolejności
 * zapisów po utracie zasilania. Bierze ją protokół zapisu kanału zgód (`layer1/cycle.ts`).
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** Przyrostek pliku tymczasowego — sprzątanie rozpoznaje po nim sierotę po przerwanym zapisie. */
export const ATOMIC_TMP_SUFFIX = '.tmp';

export interface WriteAtomicOptions {
  /** `fsync` pliku tymczasowego przed `rename` (domyślnie `false`: zapis jak bez opcji). */
  readonly fsync?: boolean;
}

/** Zapis z `fsync` przed zamknięciem: te same prawa i flaga co `writeFileSync` w ścieżce domyślnej. */
function writeSynced(path: string, body: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    const bytes = Buffer.from(body, 'utf8');
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Zapisuje `body` do `<dir>/<name>` atomowo i oddaje ścieżkę pliku. Rzuca przy każdym błędzie zapisu. */
export function writeAtomic(dir: string, name: string, body: string, options: WriteAtomicOptions = {}): string {
  const file = join(dir, name);
  const tmp = join(dir, `.${name}.${randomBytes(8).toString('hex')}${ATOMIC_TMP_SUFFIX}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (options.fsync === true) writeSynced(tmp, body);
    else writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
    return file;
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Brak pliku tymczasowego (padł `mkdir` albo `open`) — nie ma czego sprzątać.
    }
    throw err;
  }
}
