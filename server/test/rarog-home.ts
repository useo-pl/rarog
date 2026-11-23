/**
 * Katalog domowy dla testów CLI `rarog`: `HOME` i `XDG_DATA_HOME` w katalogu tymczasowym,
 * żeby żadna komenda nie dotknęła konfiguracji ani danych właściciela. `realRarogDirsCreated` mówi, czy w PRAWDZIWYM
 * katalogu domowym (z bazy użytkowników, nie z `HOME`) powstał w trakcie testów katalog konfiguracji albo danych
 * `rarog`, dowiązanie `~/.local/bin/rarog`, plist usługi `ai.rarog.server` albo katalog jednostek `systemd --user`
 * (`~/.config/systemd`) — pliki testów sprawdzają to w `afterAll`.
 *
 * Dwa katalogi pod `~/.claude` istnieją u właściciela, więc sprawdzamy, że się NIE ZMIENIŁY: kopia hooka
 * `~/.claude/hooks/rarog` bajt w bajt (nazwy i skróty plików), a katalog zrzutów `~/.claude/statusline` — ten sam
 * i-węzeł i ani jednego wpisu z sesją testów ({@link TEST_SESSION_PREFIX}). Pełnego porównania zrzutów nie da się
 * zrobić: żywe sesje właściciela piszą je przy każdym renderze paska statusu.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';

const REAL_HOME = userInfo().homedir;
const REAL_DIRS = [
  path.join(REAL_HOME, '.config', 'rarog'),
  path.join(REAL_HOME, '.local', 'share', 'rarog'),
  path.join(REAL_HOME, '.local', 'bin', 'rarog'),
  path.join(REAL_HOME, 'Library', 'LaunchAgents', 'ai.rarog.server.plist'),
  // Linux: katalog jednostek `systemd --user` i sama jednostka (gdyby katalog był już wcześniej).
  path.join(REAL_HOME, '.config', 'systemd'),
  path.join(REAL_HOME, '.config', 'systemd', 'user', 'rarog.service'),
  // The herdr unit `rarog setup` writes after its question on Linux.
  path.join(REAL_HOME, '.config', 'systemd', 'user', 'herdr.service'),
  // The herdr agent `rarog setup` writes after its question on macOS, and its log.
  path.join(REAL_HOME, 'Library', 'LaunchAgents', 'ai.rarog.herdr.plist'),
  path.join(REAL_HOME, 'Library', 'Logs', 'rarog-herdr.log'),
];
const REAL_HOOK_COPY = path.join(REAL_HOME, '.claude', 'hooks', 'rarog');
const REAL_STATUSLINE = path.join(REAL_HOME, '.claude', 'statusline');

/** Początek `session_id` w testach skryptu `statusLine` i `rarog setup` — po nim widać zrzut testu w prawdziwym domu. */
export const TEST_SESSION_PREFIX = 'rarogtest-';

/** Czy wpis istnieje (`lstat`: także dowiązanie bez celu). */
function present(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Odcisk kopii hooka: nazwa → sha256 pliku zwykłego albo rodzaj wpisu; `null` = katalogu nie ma. */
function hookCopyPrint(): string | null {
  let names: string[];
  try {
    names = readdirSync(REAL_HOOK_COPY).sort();
  } catch {
    return present(REAL_HOOK_COPY) ? 'nieczytelny' : null;
  }
  return JSON.stringify(names.map((name) => {
    const file = path.join(REAL_HOOK_COPY, name);
    try {
      const info = lstatSync(file);
      if (!info.isFile()) return [name, info.isSymbolicLink() ? 'dowiązanie' : 'inny'];
      return [name, createHash('sha256').update(readFileSync(file)).digest('hex')];
    } catch {
      return [name, 'zniknął'];
    }
  }));
}

/** I-węzeł katalogu zrzutów (`null` = brak). */
function statuslineIno(): number | null {
  try {
    return lstatSync(REAL_STATUSLINE).ino;
  } catch {
    return null;
  }
}

/** Stan sprzed testów: wpis, który już był, nie jest dowodem zapisu. */
const EXISTED_BEFORE = new Set(REAL_DIRS.filter(present));
const HOOK_COPY_BEFORE = hookCopyPrint();
const STATUSLINE_INO_BEFORE = statuslineIno();

export interface TempHome {
  readonly home: string;
  /** Środowisko procesu testów z `HOME` i `XDG_DATA_HOME` w katalogu tymczasowym, bez `RAROG_DATA_DIR`. */
  readonly env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function tempHome(prefix: string): TempHome {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'xdg') };
  delete env['RAROG_DATA_DIR'];
  return { home, env, cleanup: () => { rmSync(home, { recursive: true, force: true }); } };
}

/**
 * Naruszenia prawdziwego domu od startu testów (pusta lista = dobrze): nowe wpisy `rarog`, zmieniona kopia hooka,
 * podmieniony katalog zrzutów albo zrzut z sesją testów.
 */
export function realRarogDirsCreated(): string[] {
  const out = REAL_DIRS.filter((dir) => !EXISTED_BEFORE.has(dir) && present(dir));
  if (hookCopyPrint() !== HOOK_COPY_BEFORE) out.push(`${REAL_HOOK_COPY} (zmieniona kopia)`);
  if (statuslineIno() !== STATUSLINE_INO_BEFORE) out.push(`${REAL_STATUSLINE} (inny katalog)`);
  try {
    for (const name of readdirSync(REAL_STATUSLINE)) {
      if (name.includes(TEST_SESSION_PREFIX)) out.push(path.join(REAL_STATUSLINE, name));
    }
  } catch {
    // Brak katalogu zrzutów — nic do sprawdzenia.
  }
  return out;
}
