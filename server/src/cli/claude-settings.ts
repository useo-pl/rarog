/**
 * Pisarz `~/.claude/settings.json`: Rarog dopisuje i poprawia WŁASNE wpisy w ustawieniach Claude
 * Code wyłącznie z CLI w terminalu, po jednym pytaniu `[y/N/d]` ({@link entriesQuestion}; `d` pokazuje różnicę) i „y”,
 * pod blokadą Raroga, z kopią zapasową oryginału.
 *
 * Wołają go tylko `rarog setup` (krok ustawień Claude), `rarog hooks install` i `rarog service uninstall` w paczce
 * (strażnik `hook-granica-guard.test.ts`); serwer, `restart` i doctor nigdy (warstwa `server/src/cli/`, strażnik
 * `rarog-cli.test.ts`). Flagi pomijającej pytanie nie ma: bez terminala (`confirm` = `null`) pisarz
 * niczego nie zapisuje; różnicę przed pytaniem dostaje `printDiff`.
 *
 * Operacje, lista zamknięta:
 * - `permission`: hooki zgód (`PermissionRequest` bez matchera, `PreToolUse` z matcherem `AskUserQuestion`);
 * - `context`: hook kontekstu `SessionStart`, osobno, bo można go świadomie pominąć;
 * - `statusLine`: komenda paska statusu wskazująca skrypt z kopii;
 * - `denyRead`: dwie ścieżki Raroga w `sandbox.filesystem.denyRead` (`denyReadPaths` z `hook-commands.ts`);
 * - `writeBlock`: the two `Edit` deny rules of the write block in `permissions.deny` (`writeBlockRules` in
 *   `hook-commands.ts`): a session that loads the user settings writes neither the data directory nor
 *   `~/.config/rarog`;
 * - `remove` (`rarog service uninstall`): odwrotność pozostałych operacji jednym pytaniem i jednym zapisem (niżej).
 * Hooki: każda operacja usuwa z KAŻDEGO zdarzenia handlery Raroga o komendzie bieżącej (dla zgód także historycznej
 * z listy `HISTORICAL_COMMANDS` w `hook-commands.ts`), zostawia na miejscu pierwszy handler równy wpisowi oczekiwanemu,
 * a brakujące wpisy dopisuje jako nowe grupy na końcu tablic. Grupa i zdarzenie opróżnione przez to usunięcie znikają;
 * cudze handlery, matchery, puste grupy i kolejność zostają. Komenda, którą skaner diagnostyczny uznaje za Raroga
 * (`isRarogHookCommand`, `isContextCommand`), a której nie wolno usunąć, oraz zły typ (`hooks` nie obiekt, zdarzenie
 * nie tablica) to konflikt: bez zapisu, komenda pokazana dosłownie.
 * `statusLine`: brak klucza albo komendy = komenda bieżąca; komenda Raroga (bieżąca albo historyczna, z łańcuchem albo
 * bez, `rarogStatuslineChain`) = przebudowa z tym samym łańcuchem; cudza komenda X = bez zmian, gdy w
 * `~/.claude/statusline/` leży zrzut młodszy niż godzina (X sam pisze zrzuty), inaczej łańcuch z X. Inne pola
 * obiektu zostają. Komenda podobna do Raroga spoza tych postaci (`isRarogStatuslineCommand`) to konflikt; `statusLine`
 * nie obiekt, komenda nie napis i nieczytelny katalog zrzutów przy cudzej komendzie = odmowa.
 * `denyRead`: brakujące ścieżki na koniec tablicy, brakujące obiekty powstają; zły typ któregoś poziomu = odmowa.
 * `writeBlock`: the missing rules at the end of `permissions.deny`, compared literally; missing objects are created,
 * a wrong type at any level is a refusal, and a path that gives no rule refuses this operation with its reason.
 * `remove`: z każdego zdarzenia znikają handlery o komendzie bieżącej zgód albo kontekstu i o postaci historycznej
 * hooka; `statusLine` z łańcuchem Raroga wraca do komendy X (inne pola zostają), sama komenda Raroga usuwa klucz,
 * cudza zostaje; z `denyRead` znikają dokładnie dwa napisy Raroga (postać równoważna to wpis użytkownika: `denyRead` jej
 * nie dopisał), and so do the two write block rules from `permissions.deny`. Grupa, zdarzenie, `hooks`, tablice `denyRead`
 * i `deny` oraz obiekty `filesystem`, `sandbox`, `permissions` opróżnione przez to usunięcie znikają, cudze puste
 * zostają. Komenda podobna do Raroga spoza listy postaci (także X, który po zdjęciu
 * łańcucha dalej wygląda jak Raroga) i zły typ `hooks` albo zdarzenia to konflikt CAŁEJ operacji: jedno pytanie, jeden
 * zapis, więc bez zapisu także `statusLine` i `denyRead`. Brak pliku = nic do zdjęcia (pliku nie zakłada); plik po
 * zdjęciu pusty zostaje jako `{}`. Kopii nie potrzebuje.
 *
 * Mechanika jednego zapisu: jeden odczyt (do 4 MB, przez dowiązanie; cel musi być plikiem zwykłym), ścisły JSON
 * (Claude Code odrzuca `//`), wcięcie wykryte z pliku (2 albo 4 spacje, tab; domyślnie 2) i końcowy `\n` jak
 * w oryginale; różnica linii, ścieżka celu i pytanie. Po „y” blokada Raroga na ponowny odczyt i zapis (inne bajty,
 * cel dowiązania albo i-węzeł = odmowa), kopia zapasowa `<dataDir>/claude-settings-backup/` (katalog 0700, plik 0600
 * przez `wx`), plik tymczasowy w katalogu celu (`wx`, prawa celu, `fsync`) i `rename`. Brak pliku: nowy plik 0600
 * przez `link`, z samymi kluczami operacji. Wpisy hooków powstają tylko przy kopii hooka zgodnej ze źródłem,
 * `statusLine` przy zgodnej kopii skryptu (inaczej komenda wskazałaby brakujący albo stary plik); `denyRead`
 * i `writeBlock` kopii nie potrzebują.
 *
 * Claude Code nie zna blokady Raroga: jego własny zapis tego pliku w oknie między ponownym odczytem a `rename`
 * przepada (granica opisana w `docs/security-model.md`, nie zamykana).
 *
 * Poza zapisem moduł daje `rarog service uninstall` ostatnie sprawdzenie przed usunięciem kopii hooka, tym samym
 * odczytem i bez zapisu ({@link copyRemovalCheck}).
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readlinkSync, realpathSync, renameSync,
  unlinkSync, writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import {
  contextHookCommand, denyReadPaths, entryGroup, expectedContextEntry, expectedHookEntries, historicalCommand,
  hookCommand, rarogStatuslineChain, statuslineCommand, writeBlockRules,
} from '../herdr/hook-commands.ts';
import type { HookEntry } from '../herdr/hook-commands.ts';
import {
  STATUSLINE_FRESH_MS, contextHookEntries, handlerEntry, hookCopyReport, isContextCommand, isRarogHookCommand,
  isRarogStatuslineCommand, newestStatuslineDump, rarogHookEntries, sameHookEntry, statuslineCopyReport,
  statuslineDumpDir, userSettingsPath, visibleLine,
} from '../herdr/hook-config.ts';
import type { HookCopyReport } from '../herdr/hook-config.ts';
import { lineDiff } from '../herdr/line-diff.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { Refusal } from './io.ts';
import { acquireLock } from './lock.ts';
import type { Lock } from './lock.ts';

/** A conflict about a command of the user's: the command follows this sentence after one space. */
const LOOKALIKE = "has a command that looks like Rarog's, but is not one Rarog printed:";

/**
 * A conflict reason without the command it quotes from the user's settings, for the run log (which never holds the
 * file's content); a reason that quotes nothing stays whole.
 */
export function conflictWithoutQuote(reason: string): string {
  const at = reason.indexOf(LOOKALIKE);
  return at === -1 ? reason : reason.slice(0, at + LOOKALIKE.length - 1);
}

/**
 * Operacja pisarza (lista zamknięta): hooki zgód, hook kontekstu `SessionStart`, `statusLine`, ścieżki `denyRead`,
 * the write block rules (`writeBlock`) i zdjęcie ich wszystkich przy odinstalowaniu (`remove`).
 */
export type SettingsOperation = 'permission' | 'context' | 'statusLine' | 'denyRead' | 'writeBlock' | 'remove';

/** Sufit odczytu pliku ustawień. */
export const SETTINGS_MAX_BYTES = 4 * 1024 * 1024;

/** Katalog kopii zapasowych w katalogu danych instalacji. */
export const SETTINGS_BACKUP_DIRNAME = 'claude-settings-backup';

/** Prawa nowego pliku ustawień i kopii zapasowej. */
const PRIVATE_FILE_MODE = 0o600;

/** Prawa katalogu kopii zapasowych. */
const BACKUP_DIR_MODE = 0o700;

/** Zdanie przed pytaniem, gdy zapis zmienia też układ pliku poza wpisami Raroga. */
export const REFORMAT_NOTE = 'The file will be reformatted (the diff shows every change).';

/** The entry names in the question and on the setup step line. */
export const ENTRY_NAMES: Readonly<Record<SettingsOperation, string>> = {
  permission: 'permission hook', context: 'context hook', statusLine: 'status line', denyRead: 'sandbox read block',
  writeBlock: 'state write block', remove: 'Rarog entries',
};

/** The names of the operations in one phrase (`permission and context hooks, status line`). */
function entryNames(operations: readonly SettingsOperation[]): string {
  const parts: string[] = [];
  if (operations.includes('permission') && operations.includes('context')) parts.push('permission and context hooks');
  else for (const one of ['permission', 'context'] as const) if (operations.includes(one)) parts.push(ENTRY_NAMES[one]);
  for (const one of ['statusLine', 'denyRead', 'writeBlock'] as const) {
    if (operations.includes(one)) parts.push(ENTRY_NAMES[one]);
  }
  return parts.join(', ');
}

/** `a Rarog entry`, `4 Rarog entries`. */
function entriesCount(count: number): string {
  return `${count === 1 ? 'a' : String(count)} Rarog ${count === 1 ? 'entry' : 'entries'}`;
}

/**
 * The one `[y/N/d]` question of a write, the same in `rarog setup`, `rarog hooks install` and `rarog service
 * uninstall`: who writes how many entries into which file, `also` for a change after the write (herdr's hook in
 * setup), a clause for a value of the user that changes (the user's own `statusLine` command chained behind the Rarog
 * script) and the reformat sentence before it. Without the clauses it fits one line at 60 columns. The
 * entry names and the diff are not part of the question: the answer `d` shows {@link entriesDiff}. The backup is
 * still made; the line of the write and the run log name it. The removal asks to remove the Rarog entries.
 */
export function entriesQuestion(question: BatchQuestion, also: string | null = null): string {
  let sentence: string;
  if (question.changes.includes('remove')) {
    sentence = 'Remove Rarog entries from ~/.claude/settings.json?';
  } else {
    sentence = `Add ${entriesCount(question.changes.length)}${also === null ? '' : ` and ${also}`} to`
      + ' ~/.claude/settings.json';
    if (question.chains) sentence += ', with your own status line command chained behind Rarog\'s';
    sentence += '?';
  }
  return question.reformatted ? `${REFORMAT_NOTE} ${sentence}` : sentence;
}

/** What the answer `d` shows: the entries by name (not for the removal), then the full diff with its target line. */
export function entriesDiff(question: BatchQuestion): string[] {
  if (question.changes.includes('remove')) return [...question.diff];
  const names = `${entriesCount(question.changes.length)}: ${entryNames(question.changes)}`;
  return [`${names.charAt(0).toUpperCase()}${names.slice(1)}`, ...question.diff];
}

/** Operacje na plikach, które testy podmieniają (błąd kopii zapasowej albo `rename`). */
export interface SettingsWriterFs {
  /** Nowy plik (`wx`) z prawami `mode`, treść, `fsync`; przy błędzie po otwarciu plik usunięty. */
  readonly writeExclusive: (file: string, bytes: Buffer, mode: number) => void;
  readonly rename: (from: string, to: string) => void;
  readonly link: (from: string, to: string) => void;
}

export interface SettingsWriteOptions {
  readonly home: string;
  /** Korzeń instalacji: źródło kopii hooka, z którym kopia ma być zgodna. */
  readonly root: string;
  readonly operation: SettingsOperation;
  /** Katalog danych instalacji (kopie zapasowe, ścieżka `<dataDir>/run` w `denyRead`) albo powód, dla którego go nie ma. */
  readonly dataDir: { readonly ok: true; readonly dir: string } | { readonly ok: false; readonly message: string };
  /** Katalog blokady Raroga i nazwa komendy do komunikatu; `held` = wołający już ją trzyma (`rarog service uninstall`). */
  readonly lock: { readonly dir: string; readonly what: string } | 'held';
  /**
   * The question in a terminal (the caller words it with {@link entriesQuestion} and asks `[y/N/d]`); `null` = no
   * terminal: no write.
   */
  readonly confirm: ((question: BatchQuestion) => Promise<boolean>) | null;
  /** Wypisanie jednej linii (wołający dokłada wcięcie). */
  readonly print: (line: string) => void;
  /**
   * Where the diff and its target line go before the question; default {@link SettingsWriteOptions.print}. The diff
   * quotes the user's file, so `rarog setup` sends it to the screen with `--verbose` only and never to its run log,
   * and `rarog hooks install` and `rarog service uninstall` drop it (the answer `d` shows it).
   */
  readonly printDiff?: (line: string) => void;
  /** Komenda, którą człowiek uruchamia ponownie po odmowie (`rarog setup`, `rarog hooks install`, `rarog service uninstall`). */
  readonly again: string;
  readonly fs?: Partial<SettingsWriterFs>;
  /** Czas w nazwie kopii zapasowej i chwila, od której liczy się wiek zrzutów paska statusu. */
  readonly now?: () => Date;
}

export type SettingsWriteResult =
  /** Wpisy już bieżące: bez pytania, zapisu i kopii zapasowej. */
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'written'; readonly target: string; readonly backup: string | null }
  /** „n” albo EOF. */
  | { readonly kind: 'declined' }
  /** Bez terminala: różnica wypisana, nic nie zapisane. */
  | { readonly kind: 'no-terminal' }
  /** Kopia, którą wskazuje wpis (hook albo skrypt `statusLine`), brak albo różna od źródła: wpisu nie ma do czego kierować. */
  | { readonly kind: 'copy-not-ready'; readonly reason: string }
  | { readonly kind: 'conflict'; readonly reasons: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string };

interface Snapshot {
  /** Plik, w którym leżą bajty (cel dowiązania po `realpath`); przy braku pliku ścieżka ustawień. */
  readonly real: string;
  /** Cel dowiązania z `readlink` albo `null` (plik zwykły, brak pliku). */
  readonly link: string | null;
  readonly exists: boolean;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly bytes: Buffer;
}

interface Read {
  readonly snapshot: Snapshot;
  readonly text: string;
  /** Sparsowany korzeń; `null` = pliku nie ma. */
  readonly root: Record<string, unknown> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function errnoCode(failure: unknown): string {
  return isRecord(failure) && typeof failure['code'] === 'string' ? failure['code'] : 'error';
}

/** Napis jako jeden argument powłoki (POSIX). */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function unlinkQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Pliku nie ma (po `rename`) albo nie da się go usunąć — sprzątanie best-effort.
  }
}

/** Nowy plik z `wx`, prawa `mode` niezależnie od umask, pełna treść i `fsync`; przy błędzie plik znika. */
function writeExclusive(file: string, bytes: Buffer, mode: number): void {
  const fd = openSync(file, 'wx', mode);
  let done = false;
  try {
    fchmodSync(fd, mode);
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
    done = true;
  } finally {
    closeSync(fd);
    if (!done) unlinkQuiet(file);
  }
}

const DEFAULT_FS: SettingsWriterFs = { writeExclusive, rename: renameSync, link: linkSync };

/** Plik ustawień: brak, odmowa z powodem albo bajty z korzeniem obiektu i stanem do porównania przed zapisem. */
function readSettings(file: string, again: string): Read | { readonly refused: string } {
  let info: Stats;
  try {
    info = lstatSync(file);
  } catch (failure) {
    if (errnoCode(failure) !== 'ENOENT') return { refused: `cannot check ${file} (${errnoCode(failure)})` };
    const snapshot: Snapshot = {
      real: file, link: null, exists: false, dev: 0, ino: 0, mode: PRIVATE_FILE_MODE, bytes: Buffer.alloc(0),
    };
    return { snapshot, text: '', root: null };
  }
  let real = file;
  let link: string | null = null;
  if (info.isSymbolicLink()) {
    try {
      link = readlinkSync(file);
      real = realpathSync(file);
      info = lstatSync(real);
    } catch (failure) {
      return {
        refused: `${file} is a symlink${link === null ? '' : ` to ${link}`} that leads to no file`
          + ` (${errnoCode(failure)}); fix the link, then run ${again} again`,
      };
    }
  }
  if (!info.isFile()) return { refused: `${real} is not a regular file` };
  let read;
  try {
    read = readRegularFileSync(real, { maxBytes: SETTINGS_MAX_BYTES, followSymlink: false });
  } catch (failure) {
    return { refused: `cannot read ${real} (${errnoCode(failure)})` };
  }
  if (read === null) return { refused: `${real} is not a regular file` };
  if (read.truncated) return { refused: `${real} is larger than 4 MB` };
  const text = read.bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(read.bytes)) {
    return { refused: `${real} is not valid UTF-8; fix it, then run ${again} again` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Bez komunikatu parsera: cytuje fragment pliku, a w ustawieniach bywają klucze (`env`).
    return {
      refused: `${real} is not strict JSON (Claude Code rejects such a file too, e.g. with // comments or a trailing`
        + ` comma); fix it, then run ${again} again`,
    };
  }
  if (!isRecord(parsed)) return { refused: `${real}: the top level is not a JSON object` };
  const snapshot: Snapshot = {
    real, link, exists: true, dev: info.dev, ino: info.ino, mode: info.mode & 0o777, bytes: read.bytes,
  };
  return { snapshot, text, root: parsed };
}

/** Ten sam stan pliku przy pytaniu i pod blokadą: istnienie, cel dowiązania, ścieżka, i-węzeł i bajty. */
function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.exists === b.exists && a.link === b.link && a.real === b.real && a.dev === b.dev && a.ino === b.ino
    && a.bytes.equals(b.bytes);
}

/** Układ tekstu: wcięcie pierwszej wciętej linii (tab, 4 spacje, inaczej 2) i końcowy `\n`. */
interface Layout {
  readonly indent: string | number;
  readonly newline: boolean;
}

const NEW_FILE_LAYOUT: Layout = { indent: 2, newline: true };

function layoutOf(text: string): Layout {
  const unit = /\n([ \t]+)\S/.exec(text)?.[1];
  return { indent: unit === '\t' ? '\t' : unit === '    ' ? 4 : 2, newline: text.endsWith('\n') };
}

function render(value: unknown, layout: Layout): string {
  return `${JSON.stringify(value, null, layout.indent)}${layout.newline ? '\n' : ''}`;
}

/** Operacja na hookach. */
type HookOperation = 'permission' | 'context';

/** Wynik planu: nowy korzeń, konflikty (komenda podobna do Raroga, zły typ hooków) albo odmowa; dwa ostatnie bez zapisu. */
type Planned =
  | { readonly next: Record<string, unknown> }
  | { readonly conflicts: readonly string[] }
  | { readonly refused: string };

/** Kopia korzenia przez JSON: korzeń pochodzi z `JSON.parse`, więc nic nie ginie, a `__proto__` zostaje własnym polem. */
function copyRoot(root: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
}

/** Wpisy, które operacja ma zostawić w pliku. */
function expectedOf(operation: HookOperation, home: string): readonly HookEntry[] {
  return operation === 'permission'
    ? expectedHookEntries(hookCommand(home))
    : [expectedContextEntry(contextHookCommand(home))];
}

/** Komenda, którą operacja wolno usunąć: bieżąca albo (zgody) z zamkniętej listy postaci historycznych. */
function removable(operation: HookOperation, command: string, home: string): boolean {
  if (operation === 'context') return command === contextHookCommand(home);
  return command === hookCommand(home) || historicalCommand(command, home)?.form.key === 'hooks';
}

/** Komenda, którą skaner diagnostyczny uznaje za wpis tej operacji. */
function lookalike(operation: HookOperation, command: string): boolean {
  return operation === 'context' ? isContextCommand(command) : isRarogHookCommand(command);
}

function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** Hooki na kopii korzenia: nowy korzeń albo konflikty (bez zapisu). */
function planHooks(root: Readonly<Record<string, unknown>>, operation: HookOperation, home: string): Planned {
  const next = copyRoot(root);
  const expected = expectedOf(operation, home);
  const kept = new Set<number>();
  const emptied: string[] = [];
  const conflicts: string[] = [];
  const hasHooks = Object.hasOwn(next, 'hooks');
  const hooks = next['hooks'];
  if (hasHooks && !isRecord(hooks)) return { conflicts: [`"hooks" is ${kindOf(hooks)}, not an object`] };
  for (const [event, groups] of Object.entries(isRecord(hooks) ? hooks : {})) {
    const where = `"hooks.${visibleLine(event)}"`;
    if (!Array.isArray(groups)) {
      conflicts.push(`${where} is ${kindOf(groups)}, not an array`);
      continue;
    }
    const dropGroups: number[] = [];
    groups.forEach((group: unknown, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) return;
      const list = group['hooks'] as unknown[];
      const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : null;
      const drop: number[] = [];
      list.forEach((handler, handlerIndex) => {
        const entry = handlerEntry(event, matcher, handler);
        if (entry === null) return;
        if (!removable(operation, entry.command, home)) {
          if (lookalike(operation, entry.command)) {
            conflicts.push(`${where} ${LOOKALIKE}`
              + ` ${visibleLine(entry.command)}`);
          }
          return;
        }
        const match = expected.findIndex((one, index) => !kept.has(index) && sameHookEntry(one, entry));
        if (match === -1) drop.push(handlerIndex);
        else kept.add(match);
      });
      for (const index of drop.reverse()) list.splice(index, 1);
      if (drop.length > 0 && list.length === 0) dropGroups.push(groupIndex);
    });
    for (const index of dropGroups.reverse()) groups.splice(index, 1);
    if (dropGroups.length > 0 && groups.length === 0) emptied.push(event);
  }
  if (conflicts.length > 0) return { conflicts };
  const missing = expected.filter((_, index) => !kept.has(index));
  if (missing.length > 0 && !hasHooks) next['hooks'] = {};
  const target = next['hooks'] as Record<string, unknown[]>;
  for (const entry of missing) {
    // Zdarzenie to stała z `hook-commands.ts`; istniejąca tablica dostaje grupę na końcu (kolejność kluczy zostaje).
    if (Object.hasOwn(target, entry.event)) target[entry.event]?.push(entryGroup(entry));
    else target[entry.event] = [entryGroup(entry)];
  }
  for (const event of emptied) {
    if (target[event]?.length === 0) delete target[event];
  }
  return { next };
}

/** Zdanie po odmowie z powodu kształtu pliku. */
const handFix = (again: string): string => `fix it by hand, then run ${again} again`;

/**
 * `statusLine` na kopii korzenia. Komenda docelowa: bieżąca bez łańcucha (brak klucza albo komendy), bieżąca z łańcuchem
 * komendy Raroga (ten sam X, jedno owinięcie) albo z łańcuchem cudzej komendy X, chyba że X sam pisze zrzuty (zrzut
 * młodszy niż {@link STATUSLINE_FRESH_MS}): wtedy bez zmian.
 */
function planStatusLine(root: Readonly<Record<string, unknown>>, home: string, now: number, again: string): Planned {
  const next = copyRoot(root);
  const value = Object.hasOwn(next, 'statusLine') ? next['statusLine'] : {};
  if (!isRecord(value)) return { refused: `"statusLine" is ${kindOf(value)}, not an object; ${handFix(again)}` };
  const raw = value['command'];
  if (Object.hasOwn(value, 'command') && typeof raw !== 'string') {
    return { refused: `"statusLine.command" is ${kindOf(raw)}, not a string; ${handFix(again)}` };
  }
  const command = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  let target = statuslineCommand(home);
  if (command !== null) {
    const own = rarogStatuslineChain(command, home);
    if (own !== null) {
      target = statuslineCommand(home, own.chain ?? undefined);
    } else if (isRarogStatuslineCommand(command)) {
      return {
        conflicts: [`"statusLine" ${LOOKALIKE}`
          + ` ${visibleLine(command)}`],
      };
    } else {
      const dump = newestStatuslineDump(home);
      if ('code' in dump) {
        return {
          refused: `cannot read ${statuslineDumpDir(home)} (${dump.code}), so it is unclear whether your statusLine`
            + ' command writes the snapshots; nothing written',
        };
      }
      if (dump.newest !== null && now - dump.newest <= STATUSLINE_FRESH_MS) return { next };
      target = statuslineCommand(home, command);
    }
  }
  if (target === command && value['type'] === 'command') return { next };
  // Istniejące klucze zostają na swoich miejscach; nowe (`type`, `command`) idą na koniec obiektu.
  next['statusLine'] = { ...value, type: 'command', command: target };
  return { next };
}

/** Ścieżka do porównania wpisów `denyRead`: `~` i `~/…` rozwinięte względem domu, postać znormalizowana. */
function denyReadKey(entry: string, home: string): string {
  const expanded = entry === '~' ? home : entry.startsWith('~/') ? path.join(home, entry.slice(2)) : entry;
  const normalized = path.normalize(expanded);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/**
 * `denyRead` na kopii korzenia: brakujące ścieżki Raroga na koniec `sandbox.filesystem.denyRead`, brakujące obiekty powstają.
 * Ścieżka już obecna w równoważnej postaci (`~/…` albo bezwzględnej) się liczy: wpis użytkownika zostaje, bez duplikatu.
 */
function planDenyRead(
  root: Readonly<Record<string, unknown>>, dataDir: SettingsWriteOptions['dataDir'], again: string, home: string,
): Planned {
  if (!dataDir.ok) return { refused: `no data directory for the denyRead path <dataDir>/run: ${dataDir.message}` };
  const next = copyRoot(root);
  let at = next;
  let where = '';
  for (const key of ['sandbox', 'filesystem']) {
    where = where === '' ? key : `${where}.${key}`;
    if (!Object.hasOwn(at, key)) at[key] = {};
    const value = at[key];
    if (!isRecord(value)) return { refused: `"${where}" is ${kindOf(value)}, not an object; ${handFix(again)}` };
    at = value;
  }
  if (!Object.hasOwn(at, 'denyRead')) at['denyRead'] = [];
  const list = at['denyRead'];
  if (!Array.isArray(list)) {
    return { refused: `"sandbox.filesystem.denyRead" is ${kindOf(list)}, not an array; ${handFix(again)}` };
  }
  const present = new Set(list.filter((one): one is string => typeof one === 'string')
    .map((one) => denyReadKey(one, home)));
  for (const one of denyReadPaths(dataDir.dir)) {
    if (!present.has(denyReadKey(one, home))) list.push(one);
  }
  return { next };
}

/**
 * The write block on a copy of the root: the missing rules of {@link writeBlockRules} at the end of `permissions.deny`,
 * missing objects created. A rule counts only when present literally: an equivalent rule in another spelling is the
 * user's, and the Rarog form goes next to it (`rarog doctor` compares literally too).
 */
function planWriteBlock(
  root: Readonly<Record<string, unknown>>, dataDir: SettingsWriteOptions['dataDir'], again: string, home: string,
): Planned {
  if (!dataDir.ok) return { refused: `no data directory for the write block rules: ${dataDir.message}` };
  const built = writeBlockRules(dataDir.dir, home);
  if (!built.ok) return { refused: `no write block rule: ${built.reason}` };
  const next = copyRoot(root);
  if (!Object.hasOwn(next, 'permissions')) next['permissions'] = {};
  const permissions = next['permissions'];
  if (!isRecord(permissions)) {
    return { refused: `"permissions" is ${kindOf(permissions)}, not an object; ${handFix(again)}` };
  }
  if (!Object.hasOwn(permissions, 'deny')) permissions['deny'] = [];
  const list = permissions['deny'];
  if (!Array.isArray(list)) {
    return { refused: `"permissions.deny" is ${kindOf(list)}, not an array; ${handFix(again)}` };
  }
  for (const rule of built.rules) if (!list.includes(rule)) list.push(rule);
  return { next };
}

/** Komenda handlera, którą `remove` zdejmuje: bieżąca zgód albo kontekstu, albo postać historyczna hooka. */
function removableByUninstall(command: string, home: string): boolean {
  return removable('permission', command, home) || removable('context', command, home);
}

/**
 * `remove` na hookach (w miejscu, na kopii korzenia): handlery Raroga znikają, a z nimi opróżnione grupy, zdarzenia
 * i `hooks`.
 */
function removeHooks(next: Record<string, unknown>, home: string, conflicts: string[]): void {
  if (!Object.hasOwn(next, 'hooks')) return;
  const hooks = next['hooks'];
  if (!isRecord(hooks)) {
    conflicts.push(`"hooks" is ${kindOf(hooks)}, not an object`);
    return;
  }
  let emptiedEvent = false;
  for (const [event, groups] of Object.entries(hooks)) {
    const where = `"hooks.${visibleLine(event)}"`;
    if (!Array.isArray(groups)) {
      conflicts.push(`${where} is ${kindOf(groups)}, not an array`);
      continue;
    }
    const dropGroups: number[] = [];
    groups.forEach((group: unknown, groupIndex) => {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) return;
      const list = group['hooks'] as unknown[];
      const matcher = typeof group['matcher'] === 'string' ? group['matcher'] : null;
      const drop: number[] = [];
      list.forEach((handler, handlerIndex) => {
        const entry = handlerEntry(event, matcher, handler);
        if (entry === null) return;
        if (removableByUninstall(entry.command, home)) drop.push(handlerIndex);
        else if (lookalike('permission', entry.command) || lookalike('context', entry.command)) {
          conflicts.push(`${where} ${LOOKALIKE}`
            + ` ${visibleLine(entry.command)}`);
        }
      });
      for (const index of drop.reverse()) list.splice(index, 1);
      if (drop.length > 0 && list.length === 0) dropGroups.push(groupIndex);
    });
    for (const index of dropGroups.reverse()) groups.splice(index, 1);
    if (dropGroups.length > 0 && groups.length === 0) {
      delete hooks[event];
      emptiedEvent = true;
    }
  }
  if (emptiedEvent && Object.keys(hooks).length === 0) delete next['hooks'];
}

/** `remove` na `statusLine`: łańcuch Raroga wraca do komendy X (inne pola zostają), sama komenda Raroga usuwa klucz. */
function removeStatusLine(next: Record<string, unknown>, home: string, conflicts: string[]): void {
  const value = next['statusLine'];
  // Rarog pisze wyłącznie obiekt z komendą-napisem; inny kształt nie jest jego wpisem.
  if (!isRecord(value) || typeof value['command'] !== 'string') return;
  const command = value['command'];
  const own = rarogStatuslineChain(command, home);
  const looks = `"statusLine" ${LOOKALIKE} ${visibleLine(command)}`;
  if (own === null) {
    if (isRarogStatuslineCommand(command)) conflicts.push(looks);
    return;
  }
  if (own.chain === null || own.chain.trim() === '') {
    delete next['statusLine'];
    return;
  }
  // X, który po zdjęciu łańcucha dalej wygląda jak Raroga, zostałby komendą wskazującą usuwaną kopię.
  if (isRarogStatuslineCommand(own.chain)) {
    conflicts.push(looks);
    return;
  }
  value['command'] = own.chain;
}

/** `remove` na `denyRead`: znikają dokładnie dwa napisy Raroga; tablica i obiekty opróżnione przez to znikają. */
function removeDenyRead(next: Record<string, unknown>, dataDir: string): void {
  const sandbox = next['sandbox'];
  if (!isRecord(sandbox)) return;
  const filesystem = sandbox['filesystem'];
  if (!isRecord(filesystem)) return;
  const list = filesystem['denyRead'];
  if (!Array.isArray(list)) return;
  const ours = new Set(denyReadPaths(dataDir));
  const kept = list.filter((one: unknown) => typeof one !== 'string' || !ours.has(one));
  if (kept.length === list.length) return;
  if (kept.length > 0) {
    filesystem['denyRead'] = kept;
    return;
  }
  delete filesystem['denyRead'];
  if (Object.keys(filesystem).length > 0) return;
  delete sandbox['filesystem'];
  if (Object.keys(sandbox).length === 0) delete next['sandbox'];
}

/**
 * `remove` on the write block: exactly the two Rarog rules leave `permissions.deny`; the array and `permissions` emptied by
 * that go too. A path that gives no rule had none written, so there is nothing to remove.
 */
function removeWriteBlock(next: Record<string, unknown>, dataDir: string, home: string): void {
  const built = writeBlockRules(dataDir, home);
  const permissions = next['permissions'];
  if (!built.ok || !isRecord(permissions)) return;
  const list = permissions['deny'];
  if (!Array.isArray(list)) return;
  const kept = list.filter((one: unknown) => typeof one !== 'string' || !built.rules.includes(one));
  if (kept.length === list.length) return;
  if (kept.length > 0) {
    permissions['deny'] = kept;
    return;
  }
  delete permissions['deny'];
  if (Object.keys(permissions).length === 0) delete next['permissions'];
}

/** `remove` na kopii korzenia: zdjęcie wszystkich wpisów Raroga albo konflikty (bez zapisu czegokolwiek). */
function planRemove(
  root: Readonly<Record<string, unknown>>, home: string, dataDir: SettingsWriteOptions['dataDir'],
): Planned {
  if (!dataDir.ok) {
    return {
      refused: 'no data directory (backups, the denyRead path <dataDir>/run, the write block rules):'
        + ` ${dataDir.message}`,
    };
  }
  const next = copyRoot(root);
  const conflicts: string[] = [];
  removeHooks(next, home, conflicts);
  removeStatusLine(next, home, conflicts);
  removeDenyRead(next, dataDir.dir);
  removeWriteBlock(next, dataDir.dir, home);
  return conflicts.length > 0 ? { conflicts } : { next };
}

/** Plan operacji na kopii korzenia. */
function plan(
  root: Readonly<Record<string, unknown>>, operation: SettingsOperation,
  options: Pick<WriterBase, 'home' | 'again' | 'dataDir'>, now: number,
): Planned {
  switch (operation) {
    case 'permission':
    case 'context':
      return planHooks(root, operation, options.home);
    case 'statusLine':
      return planStatusLine(root, options.home, now, options.again);
    case 'denyRead':
      return planDenyRead(root, options.dataDir, options.again, options.home);
    case 'writeBlock':
      return planWriteBlock(root, options.dataDir, options.again, options.home);
    case 'remove':
      return planRemove(root, options.home, options.dataDir);
  }
}

/**
 * Kopia, którą wskazuje wpis operacji: kopia hooka, kopia skryptu `statusLine`; `denyRead`, `writeBlock`
 * i zdjęcie wpisów żadnej.
 */
function copyOf(
  operation: SettingsOperation, options: Pick<WriterBase, 'home' | 'root'>,
): { readonly report: HookCopyReport; readonly what: string } | null {
  switch (operation) {
    case 'permission':
    case 'context':
      return { report: hookCopyReport(options.home, options.root), what: 'hook copy' };
    case 'statusLine':
      return { report: statuslineCopyReport(options.home, options.root), what: 'statusLine script copy' };
    case 'denyRead':
    case 'writeBlock':
    case 'remove':
      return null;
  }
}

/** Różnica `before` → `after` (także dla nowego pliku wobec pustej treści) i linia celu. */
function diffLines(file: string, read: Read, after: string): string[] {
  const lines = [
    `--- ${visibleLine(file)}${read.snapshot.exists ? '' : ' (no file yet)'}`, `+++ ${visibleLine(file)} (after the change)`,
    ...lineDiff(read.text, after).map(visibleLine),
  ];
  if (!read.snapshot.exists) lines.push(`target: ${visibleLine(file)} (new file, mode 600)`);
  else if (read.snapshot.link !== null) {
    lines.push(`target: ${visibleLine(read.snapshot.real)} (${visibleLine(file)} is a symlink to it and stays one)`);
  } else lines.push(`target: ${visibleLine(read.snapshot.real)}`);
  return lines;
}

/** Katalog kopii zapasowych tuż przed zapisem: prawdziwy katalog tego użytkownika z prawami 0700. */
function unsafeBackupDir(dir: string): string | null {
  let info: Stats;
  try {
    info = lstatSync(dir);
  } catch (failure) {
    return `cannot check the backup directory ${dir} (${errnoCode(failure)})`;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return `the backup directory ${dir} is a symlink or not a directory`;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    return `the backup directory ${dir} is owned by another user`;
  }
  if ((info.mode & 0o777) !== BACKUP_DIR_MODE) {
    return `the backup directory ${dir} has mode ${(info.mode & 0o777).toString(8)}, expected 700`;
  }
  return null;
}

/** Kopia zapasowa bajtów oryginału: `<dataDir>/claude-settings-backup/settings.<czas>.<sufiks>.json`, 0600, `wx`. */
function backup(
  options: WriterBase, bytes: Buffer, fs: SettingsWriterFs,
): { readonly file: string } | { readonly refused: string } {
  if (!options.dataDir.ok) return { refused: `no directory for the backup: ${options.dataDir.message}` };
  const dir = path.join(options.dataDir.dir, SETTINGS_BACKUP_DIRNAME);
  try {
    mkdirSync(options.dataDir.dir, { recursive: true, mode: BACKUP_DIR_MODE });
    try {
      mkdirSync(dir, { mode: BACKUP_DIR_MODE });
    } catch (failure) {
      if (errnoCode(failure) !== 'EEXIST') throw failure;
    }
  } catch (failure) {
    return { refused: `cannot create the backup directory ${dir} (${errnoCode(failure)})` };
  }
  const issue = unsafeBackupDir(dir);
  if (issue !== null) return { refused: issue };
  const at = (options.now ?? (() => new Date()))().toISOString().replaceAll(':', '-');
  const file = path.join(dir, `settings.${at}.${randomBytes(4).toString('hex')}.json`);
  try {
    fs.writeExclusive(file, bytes, PRIVATE_FILE_MODE);
  } catch (failure) {
    return { refused: `cannot write the backup ${file} (${errnoCode(failure)})` };
  }
  return { file };
}

/** Zapis treści: plik tymczasowy w katalogu celu i `rename` (istniejący plik) albo `link` (nowy). Napis = odmowa. */
function replace(snapshot: Snapshot, text: string, fs: SettingsWriterFs, again: string): string | null {
  const dir = path.dirname(snapshot.real);
  const tmp = path.join(dir, `.${path.basename(snapshot.real)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    if (!snapshot.exists) mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeExclusive(tmp, Buffer.from(text, 'utf8'), snapshot.exists ? snapshot.mode : PRIVATE_FILE_MODE);
    if (snapshot.exists) fs.rename(tmp, snapshot.real);
    else fs.link(tmp, snapshot.real);
    return null;
  } catch (failure) {
    if (!snapshot.exists && errnoCode(failure) === 'EEXIST') {
      return `${snapshot.real} appeared meanwhile; nothing written, run ${again} again`;
    }
    return `cannot write ${snapshot.real} (${errnoCode(failure)})`;
  } finally {
    unlinkQuiet(tmp);
  }
}

/** Po „y”: blokada, ponowny odczyt, kopia zapasowa i zapis; `operations` = te, które zmieniają plik. */
function commit(
  options: WriterBase, operations: readonly SettingsOperation[], file: string, first: Read, after: string,
): SettingsWriteResult {
  let lock: Lock | null = null;
  if (options.lock !== 'held') {
    try {
      lock = acquireLock(options.lock.dir, options.lock.what);
    } catch (failure) {
      if (failure instanceof Refusal) return { kind: 'refused', reason: failure.message };
      throw failure;
    }
  }
  try {
    const now = readSettings(file, options.again);
    if ('refused' in now) return { kind: 'refused', reason: now.refused };
    if (!sameSnapshot(first.snapshot, now.snapshot)) {
      return { kind: 'refused', reason: `${file} changed meanwhile; nothing written, run ${options.again} again` };
    }
    // Kopię sprawdzamy drugi raz pod blokadą: mogła zniknąć albo się zmienić w czasie pytania.
    for (const operation of operations) {
      const copy = copyOf(operation, options);
      if (copy !== null && !copy.report.ok) {
        return {
          kind: 'refused',
          reason: `the ${copy.what} in ${copy.report.dir} changed meanwhile; nothing written, run ${options.again} again`,
        };
      }
    }
    const fs: SettingsWriterFs = { ...DEFAULT_FS, ...options.fs };
    const saved = now.snapshot.exists ? backup(options, now.snapshot.bytes, fs) : { file: null };
    if ('refused' in saved) return { kind: 'refused', reason: `${saved.refused}; settings unchanged` };
    const failed = replace(now.snapshot, after, fs, options.again);
    if (failed !== null) return { kind: 'refused', reason: `${failed}; settings unchanged` };
    const target = now.snapshot.real;
    options.print(saved.file === null
      ? `written: ${visibleLine(target)} (new file, mode 600; to undo: rm ${visibleLine(shellQuote(target))})`
      : `written: ${visibleLine(target)}; backup: ${visibleLine(saved.file)} (to undo: cp`
        + ` ${visibleLine(shellQuote(saved.file))} ${visibleLine(shellQuote(target))})`);
    return { kind: 'written', target, backup: saved.file };
  } finally {
    lock?.release();
  }
}

/** Wynik {@link copyRemovalCheck}: kopię wolno usunąć albo powód i wpisy Raroga (zdarzenie albo klucz z komendą). */
export type CopyRemovalCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly entries: readonly string[] };

/**
 * Ostatnie sprawdzenie przed usunięciem kopii hooka przez `rarog service uninstall` (po drugim „y”, tuż przed
 * `removeHookCopy`): `~/.claude/settings.json` tym samym odczytem co pisarz, bez zapisu, a w nim żaden wpis Raroga,
 * czyli handler hooka zgód albo kontekstu (`rarogHookEntries`, `contextHookEntries`) ani `statusLine` podobny do
 * Raroga (`isRarogStatuslineCommand`). Po `remove` z zapisem albo bez niczego do zdjęcia takich wpisów nie ma (inaczej byłby
 * konflikt), więc znaleziony to wpis dopisany w czasie pytania: po usunięciu wskazywałby brakujący plik. Brak pliku =
 * wolno; odmowa odczytu (błąd, zły JSON, nie plik zwykły) = nie wolno.
 */
export function copyRemovalCheck(home: string, again: string): CopyRemovalCheck {
  const file = userSettingsPath(home);
  const read = readSettings(file, again);
  if ('refused' in read) return { ok: false, reason: read.refused, entries: [] };
  if (read.root === null) return { ok: true };
  const entries = [...rarogHookEntries(read.root), ...contextHookEntries(read.root)]
    .map((entry) => `"hooks.${visibleLine(entry.event)}": ${visibleLine(entry.command)}`);
  const status = read.root['statusLine'];
  if (isRecord(status) && typeof status['command'] === 'string' && isRarogStatuslineCommand(status['command'])) {
    entries.push(`"statusLine": ${visibleLine(status['command'])}`);
  }
  return entries.length === 0 ? { ok: true } : { ok: false, reason: `${file} has Rarog entries again`, entries };
}

/**
 * Operacja `operation` na `~/.claude/settings.json`: plan, różnica, pytanie i zapis. Wypisuje różnicę z celem przed
 * pytaniem (`printDiff`) i linię z kopią zapasową po zapisie; konflikty, odmowy i blok do wklejenia wypisuje wołający.
 * One batch of one operation ({@link writeClaudeSettingsBatch}), its outcome or the write as one result.
 */
export async function writeClaudeSettings(options: SettingsWriteOptions): Promise<SettingsWriteResult> {
  const { operation, ...base } = options;
  const result = await writeClaudeSettingsBatch({ ...base, operations: [operation] });
  const outcome = result.outcomes.get(operation);
  if (outcome !== undefined && outcome.kind !== 'change' && outcome.kind !== 'unchanged') return outcome;
  return result.write;
}

/** What one operation of a batch does to the file, planned on the result of the operations before it. */
export type OperationOutcome =
  | { readonly kind: 'unchanged' }
  /** `chains` = the user's own `statusLine` command goes behind the Rarog script (a value of the user changes). */
  | { readonly kind: 'change'; readonly chains: boolean }
  | { readonly kind: 'copy-not-ready'; readonly reason: string }
  | { readonly kind: 'conflict'; readonly reasons: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string };

/** What the question of a batch gets: the operations that change the file, and the diff for the `d` answer. */
export interface BatchQuestion {
  readonly changes: readonly SettingsOperation[];
  /** The user's own `statusLine` command is chained behind the Rarog script. */
  readonly chains: boolean;
  /** The write also changes the layout of the file outside the Rarog entries. */
  readonly reformatted: boolean;
  /** There is no settings file yet: the write creates it, so there is no backup. */
  readonly newFile: boolean;
  /** The full diff with its target line: the screen only, never a log (the file can hold tokens in `env`). */
  readonly diff: readonly string[];
}

/** Options of the writer without the operation. */
type WriterBase = Omit<SettingsWriteOptions, 'operation'>;

export interface SettingsBatchOptions extends WriterBase {
  /** In this order; each one is planned on the result of those before it. One question for all that change the file. */
  readonly operations: readonly SettingsOperation[];
}

export interface SettingsBatchResult {
  /** Each operation's own outcome; a conflict, refusal or missing copy drops that operation alone. */
  readonly outcomes: ReadonlyMap<SettingsOperation, OperationOutcome>;
  /**
   * The one write: `unchanged` = no operation changes the file (no question), `refused` = the file could not be read
   * or written as a whole; `copy-not-ready` and `conflict` never stand here.
   */
  readonly write: SettingsWriteResult;
}

/**
 * Operations on `~/.claude/settings.json` with one read, one diff, one question and one write with one backup.
 * An operation in conflict, refused or waiting for its copy drops out with its
 * own outcome; the rest go on.
 */
export async function writeClaudeSettingsBatch(options: SettingsBatchOptions): Promise<SettingsBatchResult> {
  const file = userSettingsPath(options.home);
  const first = readSettings(file, options.again);
  if ('refused' in first) return { outcomes: new Map(), write: { kind: 'refused', reason: first.refused } };
  const { outcomes, changes, chains, current } = planBatch(options, first);
  const done = (write: SettingsWriteResult): SettingsBatchResult => ({ outcomes, write });
  if (changes.length === 0) return done({ kind: 'unchanged' });
  if (first.snapshot.exists && !options.dataDir.ok) {
    return done({ kind: 'refused', reason: `no directory for the backup: ${options.dataDir.message}` });
  }
  const layout = first.root === null ? NEW_FILE_LAYOUT : layoutOf(first.text);
  const after = render(current, layout);
  const diff = diffLines(file, first, after);
  const print = options.printDiff ?? options.print;
  for (const one of diff) print(one);
  if (options.confirm === null) return done({ kind: 'no-terminal' });
  const reformatted = first.root !== null && render(first.root, layout) !== first.text;
  if (!(await options.confirm({ changes, chains, reformatted, newFile: !first.snapshot.exists, diff }))) return done({ kind: 'declined' });
  return done(commit(options, changes, file, first, after));
}

/** What planning a batch on the file as read gives: each outcome, the operations that change it, and the result. */
interface BatchPlan {
  readonly outcomes: ReadonlyMap<SettingsOperation, OperationOutcome>;
  readonly changes: readonly SettingsOperation[];
  readonly chains: boolean;
  readonly current: Record<string, unknown>;
}

/** What {@link plannedOutcomes} needs: the writer's inputs without the question, the printers and the lock. */
export type PlanOptions = Pick<SettingsBatchOptions, 'home' | 'root' | 'dataDir' | 'again' | 'now' | 'operations'>;

/**
 * Each operation's outcome on the settings file as it is now, without a diff, a question or a write: `rarog setup`
 * offers the missing `statusLine` script only when its operation waits for that copy. `null` = the file cannot be read
 * (the write would say why).
 */
export function plannedOutcomes(options: PlanOptions): ReadonlyMap<SettingsOperation, OperationOutcome> | null {
  const first = readSettings(userSettingsPath(options.home), options.again);
  return 'refused' in first ? null : planBatch(options, first).outcomes;
}

/** The operations planned in order, each on the result of those before it. */
function planBatch(options: PlanOptions, first: Read): BatchPlan {
  const outcomes = new Map<SettingsOperation, OperationOutcome>();
  const now = (options.now ?? (() => new Date()))().getTime();
  let current: Record<string, unknown> = first.root ?? {};
  const changes: SettingsOperation[] = [];
  let chains = false;
  for (const operation of options.operations) {
    // Zdjęcie wpisów bez pliku: nie ma czego zdjąć, a pliku nie zakładamy.
    if (first.root === null && operation === 'remove') {
      outcomes.set(operation, { kind: 'unchanged' });
      continue;
    }
    const planned = plan(current, operation, options, now);
    if ('refused' in planned) {
      outcomes.set(operation, { kind: 'refused', reason: planned.refused });
      continue;
    }
    if ('conflicts' in planned) {
      outcomes.set(operation, { kind: 'conflict', reasons: planned.conflicts });
      continue;
    }
    if (first.root !== null && JSON.stringify(planned.next) === JSON.stringify(current)) {
      outcomes.set(operation, { kind: 'unchanged' });
      continue;
    }
    const copy = copyOf(operation, options);
    if (copy !== null && !copy.report.ok) {
      outcomes.set(operation, {
        kind: 'copy-not-ready',
        reason: `the ${copy.what} in ${copy.report.dir} is missing or differs from the source, so the`
          + ` ${operation === 'statusLine' ? 'command' : 'entries'} would point at a missing or old file`,
      });
      continue;
    }
    const chained = operation === 'statusLine' && chainsUserCommand(current, options.home);
    chains ||= chained;
    outcomes.set(operation, { kind: 'change', chains: chained });
    changes.push(operation);
    current = planned.next;
  }
  return { outcomes, changes, chains, current };
}

/** The `statusLine` command before the operation is the user's own (neither missing nor one Rarog wrote). */
function chainsUserCommand(root: Readonly<Record<string, unknown>>, home: string): boolean {
  const value = root['statusLine'];
  const command = isRecord(value) ? value['command'] : undefined;
  return typeof command === 'string' && command.trim() !== '' && rarogStatuslineChain(command, home) === null;
}
