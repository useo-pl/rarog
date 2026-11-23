/**
 * Katalog danych serwera — JEDNA reguła dla serwera (`server/src/config.ts`), CLI `rarog` (`server/src/cli/`: `pair`,
 * `devices`, `hooks doctor`), skryptów narzędziowych (także przez `node -e`) i skryptu dymnego przekaźnika
 * (`relay/scripts/smoke.mjs`). Hook treści (`scripts/hooks/rarog-pending.mjs`) ma TĘ SAMĄ regułę przepisaną w
 * `dataDir()` bez importu tego modułu: obsługuje każdą sesję Claude na Macu, a cichy błąd importu wyłączyłby wszystkie
 * karty bez śladu w `/health`. Równość pilnuje test parytetu (`server/test/data-dir.test.ts`: hook w
 * podprocesie na tej samej macierzy stanów).
 *
 * Reguła:
 * 1. flaga `--data-dir` albo niepuste `RAROG_DATA_DIR` → ta ścieżka;
 * 2. baza = niepuste `XDG_DATA_HOME`, inaczej `~/.local/share`;
 * 3. `<baza>/rarog` nie istnieje, jest katalogiem albo dowiązaniem do katalogu → `<baza>/rarog`;
 * 4. każdy inny stan (plik, dowiązanie bez celu albo do pliku, pętla, błąd odczytu) → KONFLIKT.
 *
 * Konflikt to wynik, nie wyjątek: wołający decyduje, co z nim zrobić. Serwer odmawia startu przed pierwszym
 * zapisem (`loadConfig` rzuca `ConfigError`), CLI odmawia, hook milknie. Powód: start na katalogu, którego nie da się
 * użyć, kończy się błędem w połowie zapisu, a naprawa to jedno `mv`.
 *
 * Czysty ESM, wyłącznie `node:*`: ładuje go goły `node` (CLI, `node -e`) i tsx (serwer). Typy: `data-dir.d.mts`.
 */
import { lstatSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Jawna ścieżka katalogu danych (tylko ze środowiska procesu). */
export const DATA_DIR_ENV = 'RAROG_DATA_DIR';
/** Baza katalogów danych według XDG. */
export const XDG_DATA_HOME_ENV = 'XDG_DATA_HOME';
/** Katalog danych w bazie. */
export const DATA_DIR_NAME = 'rarog';

/** Rodzaj wpisu katalogu według `lstat`: dowiązanie NIE jest katalogiem. Inny błąd niż ENOENT leci wyżej. */
function kindOf(target) {
  let stats;
  try {
    stats = lstatSync(target);
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.code === 'ENOENT') return 'missing';
    throw err;
  }
  if (stats.isSymbolicLink()) return 'link';
  if (stats.isDirectory()) return 'dir';
  return 'other';
}

/** Rodzaj CELU wpisu (`stat`, idzie za dowiązaniem): brak celu to `missing`, pętla i inne błędy lecą wyżej. */
function targetKind(target) {
  let stats;
  try {
    stats = statSync(target);
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.code === 'ENOENT') return 'missing';
    throw err;
  }
  return stats.isDirectory() ? 'dir' : 'other';
}

/** Kod błędu `fs` z obiektem, którego dotyczył — do powodu konfliktu, bez stosu. */
function errorDetail(err) {
  if (err !== null && typeof err === 'object') {
    const code = typeof err.code === 'string' ? err.code : 'error';
    return typeof err.path === 'string' ? `${code}: ${err.path}` : code;
  }
  return String(err);
}

/**
 * Wynik reguły katalogu danych.
 *
 * @param {{ flag?: string, env?: Readonly<Record<string, string | undefined>>, home?: string }} [options]
 *   `flag` — wartość `--data-dir`; `env` — środowisko (czytane tylko `RAROG_DATA_DIR` i `XDG_DATA_HOME`);
 *   `home` — katalog domowy, domyślnie `os.homedir()`.
 * @returns {import('./data-dir.d.mts').DataDirResult}
 */
export function resolveDataDir(options = {}) {
  const { flag, env = process.env, home } = options;
  if (typeof flag === 'string' && flag !== '') return { ok: true, dir: flag, source: 'flag' };
  const explicit = env[DATA_DIR_ENV];
  if (explicit !== undefined && explicit !== '') return { ok: true, dir: explicit, source: 'env' };
  const xdg = env[XDG_DATA_HOME_ENV];
  const base = xdg !== undefined && xdg !== ''
    ? xdg
    : path.join(home !== undefined && home !== '' ? home : os.homedir(), '.local', 'share');
  const defaultDir = path.join(base, DATA_DIR_NAME);
  const conflict = (reason, detail) => ({ ok: false, defaultDir, reason, detail });
  try {
    const current = kindOf(defaultDir);
    if (current === 'other') return conflict('default-not-dir', 'file');
    if (current === 'link') {
      // Dowiązanie musi prowadzić do katalogu: plik, brak celu (np. odmontowany dysk) i pętla (`stat` rzuca ELOOP →
      // `unreadable`) to konflikt, a nie start na katalogu, którego nie da się użyć.
      const target = targetKind(defaultDir);
      if (target === 'missing') return conflict('default-not-dir', 'symlink without a target');
      if (target !== 'dir') return conflict('default-not-dir', 'symlink not to a directory');
    }
    return { ok: true, dir: defaultDir, source: 'default' };
  } catch (err) {
    return conflict('unreadable', errorDetail(err));
  }
}

/** Ścieżka w pojedynczym cudzysłowie powłoki — komenda naprawy ma się dać wkleić. */
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Komunikat konfliktu dla człowieka: ścieżka, powód i komenda naprawy. Jedno zdanie na sprawę, bez stosu.
 *
 * @param {import('./data-dir.d.mts').DataDirConflict} conflict
 * @returns {string}
 */
export function dataDirConflictMessage(conflict) {
  const { defaultDir, reason, detail } = conflict;
  const lead = `Data directory conflict: ${defaultDir}.`;
  const body = reason === 'default-not-dir'
    ? `It exists and is not a directory (${detail}). Fix: mv ${quote(defaultDir)} ${quote(`${defaultDir}.aside`)}.`
    : `Its state cannot be read (${detail}). Check the permissions: ls -ld ${quote(defaultDir)}.`;
  return `${lead} ${body} An explicit directory, outside the rule: ${DATA_DIR_ENV}.`;
}
