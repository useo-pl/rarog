/**
 * Most do hooków Claude Code: korzenie dla filtra `cwd`, kopia kodu hooka poza checkoutem
 * i odpowiedź na pytanie „czy ten hook w ogóle jest zarejestrowany i czy wykonuje to, co leży w repo".
 * Komendy, wpisy oczekiwane i kształt bloku do wklejenia stoją w `hook-commands.ts`; ten moduł je
 * re-eksportuje, więc jego importerzy widzą jedną definicję.
 *
 * JEDNO źródło prawdy dla czterech czytelników: `pnpm run hooks:install` (kopia),
 * `pnpm run hooks:print` (drukuje blok), `pnpm run hooks:doctor` (porównuje z zainstalowanym)
 * i `/health` (`hook`, `hookSeenAgo`). Rozjazd między tym, co skrypt drukuje, a tym, czego
 * szuka doctor, byłby najgorszą wersją tej funkcji: „mismatch" przy poprawnej instalacji
 * nauczyłby użytkownika ignorować sygnał.
 *
 * KOD HOOKA POZA CHECKOUTEM. Claude Code wykonuje hook poza sandboksem, przy każdym
 * dialogu zgody w każdej sesji konta, a agent w sandboksie zapisuje katalog roboczy, więc skrypt
 * w `scripts/hooks/` mógłby podmienić. Komenda w ustawieniach wskazuje więc KOPIĘ
 * w `~/.claude/hooks/rarog/` — ścieżkę, której Claude Code nie pozwala zapisać z sandboksa
 * („Protected paths”, CLI 2.1.311). Kopię robi {@link installHookCopy},
 * wołane WYŁĄCZNIE z ręcznych komend w terminalu: `hooks:install` i aktualizacja kopii w kroku hooka
 * `rarog setup` (pilnuje `hook-granica-guard.test.ts`), a kopia różna od repo to `stale` w `/health`
 * i w doctorze. Ta sama kopia niesie skrypt `statusLine` Raroga (`rarog-statusline.mjs`) z OSOBNYM stanem:
 * do pola `hook` nie wchodzi.
 *
 * DWA TRYBY, JEDNA KOPIA. Źródłem kopii jest `scripts/hooks/` korzenia instalacji. W klonie repo
 * instalatory biorą wyłącznie stan z commita ({@link committedSources}). W paczce npm gita nie ma: bajty idą
 * z katalogu paczki ({@link installedSources}), a każdy instalator pokazuje różnicę wobec kopii i pyta przed zapisem
 * ({@link HookInstallOptions.review}); bez pytania (wywołanie bez terminala) różna kopia to odmowa. Zapisują się
 * dokładnie bufory, które przeszły bramę i różnicę, nigdy drugi odczyt źródła. Manifest niesie `commit` (klon) albo
 * `version` (paczka), a czytnik zna oba kształty.
 *
 * KOPIA Z INSTALACJI USŁUGI. Kopię obok serwera usługi pisze tylko instalacja, którą usługa startuje: gdy usługa
 * startuje inną (klon obok paczki albo odwrotnie) albo jej celu nie da się odczytać, każdy instalator odmawia bez
 * zapisu, chyba że kopia ma już dokładnie te bajty i nie ma w niej plików z poprzedniej instalacji do usunięcia
 * ({@link HookInstallOptions.serviceRefusal}, {@link foreignService}).
 *
 * Czego ten moduł NIE robi: nie pisze ani jednego bajtu do plików ustawień Claude Code. Własne wpisy Raroga
 * w `~/.claude/settings.json` dopisuje i poprawia wyłącznie pisarz warstwy CLI (`server/src/cli/claude-settings.ts`):
 * `rarog setup` i `rarog hooks install` w terminalu, po różnicy i „y”, z kopią zapasową, a dowiązanie do repo
 * dotfiles zostaje dowiązaniem. Ten moduł daje mu tylko rozpoznanie wpisów ({@link isRarogHookCommand},
 * {@link handlerEntry}). Zapisy pod `~/.claude` z tego modułu to wyłącznie katalog kopii z komendy instalacji
 * i jego usunięcie przy `rarog service uninstall` w paczce ({@link removeHookCopy}).
 * Serwer nie woła instalacji, usunięcia ani pisarza nigdy.
 *
 * Moduł nie sięga też do środowiska procesu — konfigurację Raroga czyta wyłącznie `config.ts`
 * (sekcja „Configuration" w `docs/architecture.md` jest tego strażnikiem, a test
 * `docs-zgodnosc` przewraca się przy każdym nowym czytelniku env). `dataDir`, korzenie,
 * katalog domowy, ścieżki plików ustawień i runner gita przychodzą tu jako argumenty.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { GitArgsRunner } from '../git-status.ts';
import { HOOK_STATUS_MISSING } from '../health.ts';
import type { HookHealth, HookStatus } from '../health.ts';
import { DIFF_HIDDEN_RANGES, inRanges } from '../hidden-chars.ts';
import { INSTALL_ROOT } from '../install/mode.ts';
import type { InstallMode } from '../install/mode.ts';
import { REPAIR, repairCommands } from '../install/repair.ts';
import { readRegularFileSync } from '../safe-read.ts';
import { VERSION_RE } from '../version.ts';
import { lineDiff } from './line-diff.ts';
import {
  CONTEXT_HOOK_FILE, CONTEXT_INSTALLED_SCRIPT_REL, CONTEXT_SCRIPT_REL, HOOK_ENTRY_FILE, HOOK_INSTALL_DIR_REL,
  HOOK_SCRIPT_REL, HOOK_SOURCE_DIR_REL, OLD_ENTRY_FILE, STATUSLINE_ENTRY_FILE, expectedContextEntry,
  expectedHookEntries, hookCommand,
} from './hook-commands.ts';
import type { HookEntry } from './hook-commands.ts';

// Komendy, wpisy oczekiwane i bloki do wydruku mieszkają w `hook-commands.ts`; nazwy są dostępne także stąd.
export {
  CONTEXT_HOOK_EVENT, CONTEXT_HOOK_FILE, CONTEXT_INSTALLED_SCRIPT_REL, HOOK_ANSWER_TIMEOUT_S, HOOK_ANSWER_WAIT_S,
  HOOK_ENTRY_FILE, HOOK_INSTALL_DIR_REL, HOOK_INSTALLED_SCRIPT_REL, HOOK_PERMISSION_EVENT, HOOK_QUESTION_MATCHER,
  HOOK_SCRIPT_REL, HOOK_SOURCE_DIR_REL, HOOK_TIMEOUT_S, STATUSLINE_ENTRY_FILE, STATUSLINE_INSTALLED_SCRIPT_REL,
  contextHookBlock, contextHookCommand, denyReadBlock, denyReadPaths, expectedContextEntry, expectedHookEntries,
  hookBlock, hookCommand, pasteHookBlock, rarogStatuslineChain, renderContextHookBlock, renderHookBlock,
  renderPasteHookBlock, renderStatuslineBlock, statuslineBlock, statuslineCommand, writeBlockRules,
} from './hook-commands.ts';
export type { HookEntry, WriteBlockRules } from './hook-commands.ts';

/** Plik z korzeniami Raroga — czyta go hook PRZED jakimkolwiek zapisem (filtr `cwd`). */
export const HOOK_ROOTS_FILENAME = 'roots.json';

/** Znacznik ostatniego odpalenia hooka — pisze go hook, czyta `/health` i doctor. */
export const HOOK_SEEN_FILENAME = 'hook-seen.json';

/**
 * Znacznik per plik wejściowy: `hook-seen.<nazwa pliku bez .mjs>.json`, pisany obok {@link HOOK_SEEN_FILENAME}
 * tą samą treścią. Po nim `GET /api/version` i doctory mówią, który plik kopii Claude Code woła i kiedy ostatnio
 * (znacznik pliku, którego kopia już nie ma, zostaje w katalogu danych i tylko się starzeje). Kształt nazwy MUSI
 * zgadzać się z `SEEN_PER_FILE` w hooku.
 */
export const HOOK_SEEN_PER_FILE_RE = /^hook-seen\.([a-z][a-z0-9-]{0,63})\.json$/;

/** Sufit liczby znaczników per plik czytanych z katalogu danych. */
const HOOK_SEEN_PER_FILE_MAX = 16;

/**
 * Dziennik odmów strażnika wysokości dialogu — DOPISUJE go hook, sumuje {@link summarizeGuard}, rotuje
 * serwer przy starcie ({@link rotateGuardLog}). Linia to liczby (czas, sesja, czy subagent, szacunek, budżet,
 * źródło budżetu i geometria panelu), nigdy treść komendy.
 */
export const HOOK_GUARD_LOG_FILENAME = 'guard.jsonl';

/** Próg rotacji dziennika strażnika: powyżej plik przechodzi do `.1` (jedna generacja). */
export const HOOK_GUARD_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Źródła budżetu strażnika wysokości dialogu:
 * `pane` — geometria panelu z `COLUMNS`/`LINES` hooka, `phone` — geometrii nie było (stałe telefonu),
 * `floor` — panel poniżej progu (też stałe telefonu). MUSZĄ zgadzać się z `BUDGET_SOURCES`
 * w `scripts/hooks/tall-dialog.mjs` (pilnuje `server/test/pane-guard.test.ts`).
 */
export const HOOK_BUDGET_SOURCES = ['pane', 'phone', 'floor'] as const;
export type HookBudgetSource = (typeof HOOK_BUDGET_SOURCES)[number];

/**
 * Komenda z tym fragmentem wskazuje katalog kopii. Wpis hooka z nim to wpis Raroga także wtedy, gdy wskazuje
 * plik, którego kopia nie ma (inna nazwa pliku wejściowego): doctor pokazuje go jako `mismatch`, a nie `brak`.
 */
const COPY_DIR_MARK = `${HOOK_INSTALL_DIR_REL}/`;

/**
 * Pliki kopii: DOMKNIĘCIE importów hooka (statycznie `node:`, dynamicznie strażnik wysokości, kanonizacja
 * `tool_input` i kanał zgód obok siebie — pilnuje `hook-granica-guard.test.ts`). Kolejność = kolejność instalacji:
 * moduły przed hookiem, a `canon.mjs` przed `consent.mjs`, który go importuje, więc hook odpalony w trakcie widzi
 * najwyżej nowe moduły ze starym hookiem; wynik strażnika w obcym kształcie hook traktuje jak brak strażnika, brak
 * albo błąd `canon.mjs` jak brak skrótu (bez zrzutu per wywołanie i bez czekania), a brak albo błąd `consent.mjs`
 * jak brak kanału zgód (bez decyzji, dialog zostaje przy biurku). Obok leży hook kontekstu {@link CONTEXT_HOOK_FILE}
 * (osobny plik wejściowy). `work-area.mjs` is the `cwd` filter of both hooks and goes in before them; a
 * missing or broken one makes either hook treat the `cwd` as outside the roots, so it does nothing.
 */
export const HOOK_INSTALL_FILES = [
  'tall-dialog.mjs', 'canon.mjs', 'consent.mjs', 'work-area.mjs', 'rarog-context.mjs', HOOK_ENTRY_FILE,
] as const;

/** Pliki kopii skryptu `statusLine` (domknięcie importów: same moduły `node:`, pilnuje `hook-granica-guard.test.ts`). */
export const STATUSLINE_INSTALL_FILES = [STATUSLINE_ENTRY_FILE] as const;

/**
 * Manifest instalacji w katalogu kopii: pochodzenie (commit klonu albo wersja paczki), chwila i skróty — doctor
 * odróżnia „źródło się zmieniło” od „kopię zmieniono po instalacji”.
 */
export const HOOK_MANIFEST_FILENAME = 'manifest.json';

/** Sufit odczytu pliku hooka, kopii i manifestu (`safe-read.ts`): skrypt ma dziś ~50 kB. */
export const HOOK_COPY_MAX_BYTES = 1024 * 1024;

/** Korzeń instalacji Raroga (`server/src/install/mode.ts`): w klonie katalog repo, źródło kopii hooka. */
export function repoRoot(): string {
  return INSTALL_ROOT;
}

/** Absolutna ścieżka skryptu hooka w repo — źródło kopii, NIE to, co wykonuje Claude Code. */
export function hookScriptPath(root: string = repoRoot()): string {
  return join(root, HOOK_SCRIPT_REL);
}

/** Katalog kopii hooka w domu użytkownika: `<home>/.claude/hooks/rarog`. */
export function hookInstallDir(home: string): string {
  return join(home, HOOK_INSTALL_DIR_REL);
}

/**
 * Komenda wskazuje hook kontekstu (kopię albo checkout). Rozpoznanie diagnostyczne, jak {@link isRarogHookCommand};
 * pisarz ustawień (`server/src/cli/claude-settings.ts`) bierze je za granicę konfliktu.
 */
export function isContextCommand(command: string): boolean {
  return command.includes(CONTEXT_INSTALLED_SCRIPT_REL) || command.includes(CONTEXT_SCRIPT_REL);
}

/**
 * Komenda, którą skaner {@link rarogHookEntries} uznaje za wpis hooka zgód Raroga: dowolny plik
 * w katalogu kopii albo skrypt hooka w checkoucie, bez hooka kontekstu. Usunąć wolno tylko część z nich (komendę
 * bieżącą albo historyczną, `hook-commands.ts`); reszta to dla pisarza ustawień konflikt.
 */
export function isRarogHookCommand(command: string): boolean {
  return !isContextCommand(command) && (command.includes(COPY_DIR_MARK) || command.includes(HOOK_SCRIPT_REL));
}

/** Fragment przypisania zmiennej łańcucha `statusLine` (bieżącej i pod starą nazwą produktu). */
const STATUSLINE_CHAIN_MARK = '_STATUSLINE_CHAIN=';

/**
 * Komenda `statusLine` podobna do Raroga: skrypt paska statusu Raroga (kopia albo checkout), dowolny plik w katalogu
 * kopii albo zmienna łańcucha (`…_STATUSLINE_CHAIN=`, także pod starą nazwą produktu). Pisarz ustawień przebudowuje
 * tylko postaci z `rarogStatuslineChain` (`hook-commands.ts`); reszta takich komend to konflikt, nie cudzy łańcuch.
 */
export function isRarogStatuslineCommand(command: string): boolean {
  return command.includes(STATUSLINE_ENTRY_FILE) || command.includes(COPY_DIR_MARK)
    || command.includes(STATUSLINE_CHAIN_MARK);
}

/** Zrzut paska statusu młodszy niż tyle = komenda `statusLine` działa (linia `statusLine` doctora, pisarz ustawień). */
export const STATUSLINE_FRESH_MS = 60 * 60 * 1000;

/** Katalog zrzutów paska statusu: `<home>/.claude/statusline`. */
export function statuslineDumpDir(home: string): string {
  return join(home, '.claude', 'statusline');
}

/**
 * Czas modyfikacji najmłodszego zrzutu w {@link statuslineDumpDir} (zwykły plik `*.json`; katalog albo dowiązanie
 * o takiej nazwie nie świadczy, że pasek statusu coś zapisał). `newest: null` = katalogu albo zrzutu nie ma; `code` =
 * katalogu nie da się przeczytać.
 */
export function newestStatuslineDump(home: string): { readonly newest: number | null } | { readonly code: string } {
  const dir = statuslineDumpDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = errnoCode(err) ?? 'error';
    return code === 'ENOENT' ? { newest: null } : { code };
  }
  let newest: number | null = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let stats;
    try {
      stats = lstatSync(join(dir, name));
    } catch (err) {
      // Zrzut zniknął między `readdir` a `lstat` (skrypt podmienia go przez `rename`): liczy się następny.
      if (errnoCode(err) === 'ENOENT') continue;
      return { code: errnoCode(err) ?? 'error' };
    }
    if (!stats.isFile()) continue;
    if (newest === null || stats.mtimeMs > newest) newest = stats.mtimeMs;
  }
  return { newest };
}

/** Postać kanoniczna wpisu — po niej porównujemy zainstalowane z oczekiwanym. */
function canonical(entry: HookEntry): string {
  return JSON.stringify([entry.event, entry.matcher, entry.type, entry.command, entry.timeout]);
}

/** Dwa wpisy są tym samym wpisem (zdarzenie, matcher, typ, komenda, sufit) — reguła doctora i pisarza ustawień. */
export function sameHookEntry(a: HookEntry, b: HookEntry): boolean {
  return canonical(a) === canonical(b);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Komenda wskazuje skrypt w CHECKOUCIE repo (stary układ instalacji), a nie kopię. */
function pointsAtCheckout(command: string): boolean {
  return command.includes(HOOK_SCRIPT_REL) && !command.includes(COPY_DIR_MARK);
}

/**
 * Wpisy NASZEGO hooka z dowolnego pliku ustawień — rozpoznawane po ścieżce w komendzie: dowolny plik
 * w katalogu kopii (`.claude/hooks/rarog/`; plik inny niż `rarog-pending.mjs` to `mismatch`) ALBO skrypt
 * w checkoucie (`scripts/hooks/rarog-pending.mjs`, stary układ instalacji). Bez drugiej stary wpis byłby `brak` zamiast
 * `mismatch` z powodem. Checkout rozpoznajemy tylko po pełnej nazwie pliku: `scripts/hooks/` bywa w cudzych repo.
 *
 * Reszta pliku nas NIE OBCHODZI: hook herdr `SessionStart`, hooki Codexa, cudze bloki
 * przechodzą nietknięte i nie są błędem. Skanujemy WSZYSTKIE zdarzenia, nie tylko dwa nasze —
 * stara rejestracja `PreToolUse` bez matchera ma być widoczna jako
 * `mismatch`, a nie milcząco pominięta.
 *
 * Wpis hooka kontekstu (`rarog-context.mjs`) NIE jest wpisem hooka zgód: ma własny stan
 * ({@link inspectContextHook}), więc tu go pomijamy — inaczej każda instalacja z nim byłaby `mismatch` w `/health`.
 */
export function rarogHookEntries(settings: unknown): readonly HookEntry[] {
  return scanHookEntries(settings, isRarogHookCommand);
}

/** Wpisy hooka kontekstu z dowolnego zdarzenia pliku ustawień (kopia albo checkout). */
export function contextHookEntries(settings: unknown): readonly HookEntry[] {
  return scanHookEntries(settings, isContextCommand);
}

/** Wpisy hooków z pliku ustawień, których komenda przechodzi `accept`; każde zdarzenie, cudze wpisy pominięte. */
function scanHookEntries(settings: unknown, accept: (command: string) => boolean): readonly HookEntry[] {
  const root = asRecord(settings);
  const hooks = root === null ? null : asRecord(root['hooks']);
  if (hooks === null) return [];
  const found: HookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const record = asRecord(group);
      if (record === null) continue;
      const matcher = typeof record['matcher'] === 'string' ? record['matcher'] : null;
      const list = record['hooks'];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const entry = handlerEntry(event, matcher, item);
        if (entry !== null && accept(entry.command)) found.push(entry);
      }
    }
  }
  return found;
}

/**
 * Jeden handler grupy jako wpis: `matcher` grupy (napis, inaczej `null`), typ (napis, inaczej `''`), komenda i sufit
 * (liczba, inaczej `null`). `null` = handler nie jest obiektem albo nie ma komendy-napisu. Tę samą postać porównuje
 * doctor i pisarz ustawień, więc wpis „zgodny” dla jednego jest zgodny dla drugiego.
 */
export function handlerEntry(event: string, matcher: string | null, handler: unknown): HookEntry | null {
  const hook = asRecord(handler);
  if (hook === null) return null;
  const command = hook['command'];
  if (typeof command !== 'string') return null;
  return {
    event,
    matcher,
    type: typeof hook['type'] === 'string' ? hook['type'] : '',
    command,
    timeout: typeof hook['timeout'] === 'number' ? hook['timeout'] : null,
  };
}

/** Ocena jednego pliku ustawień. */
export interface SettingsInspection {
  readonly path: string;
  /** Plik istnieje i dał się sparsować. Zepsuty JSON = `false` + `status: 'mismatch'`. */
  readonly readable: boolean;
  readonly status: HookStatus;
  readonly entries: readonly HookEntry[];
  /**
   * Któryś wpis Raroga wskazuje skrypt w checkoucie repo (stary układ instalacji). Status jest wtedy `mismatch`, a doctor
   * podaje powód: kod hooka z checkoutu może zmienić agent w sandboksie.
   */
  readonly checkout: boolean;
}

/** Plik ustawień (TYLKO odczyt, przez symlink): `missing` = nie da się przeczytać, `broken` = zły JSON. */
function readSettings(path: string): { readonly parsed: unknown } | 'missing' | 'broken' {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return 'missing';
  }
  try {
    return { parsed: JSON.parse(raw) as unknown };
  } catch {
    return 'broken';
  }
}

/**
 * Czyta plik ustawień (TYLKO odczyt, przez symlink) i porównuje wpisy Raroga z oczekiwanymi.
 *
 * `brak` — pliku nie ma albo nie ma w nim ani jednego wpisu Raroga. `mismatch` — wpisy są,
 * ale inne niż drukowane (checkout zamiast kopii, inny plik w katalogu kopii, brak `timeout`, matcher
 * z poprzedniej wersji), ALBO pliku nie da się sparsować, bo wtedy nie wiemy, co tam stoi (fail-closed).
 * Rejestracja nigdy nie jest `stale`: ten stan daje dopiero kopia ({@link withCopyStatus}).
 *
 * @param expected wpisy dla tego katalogu domowego (`expectedHookEntries(hookCommand(home))`)
 */
export function inspectSettingsFile(path: string, expected: readonly HookEntry[]): SettingsInspection {
  const read = readSettings(path);
  if (read === 'missing') return { path, readable: false, status: HOOK_STATUS_MISSING, entries: [], checkout: false };
  if (read === 'broken') return { path, readable: false, status: 'mismatch', entries: [], checkout: false };
  const entries = rarogHookEntries(read.parsed);
  const checkout = entries.some((entry) => pointsAtCheckout(entry.command));
  if (entries.length === 0) return { path, readable: true, status: HOOK_STATUS_MISSING, entries, checkout };
  const key = (list: readonly HookEntry[]): string => JSON.stringify([...list].map(canonical).sort());
  return { path, readable: true, status: key(entries) === key(expected) ? 'ok' : 'mismatch', entries, checkout };
}

/**
 * Stan rejestracji z listy plików: `ok`, gdy KTÓRYKOLWIEK niesie dokładnie ten blok
 * (user-wide albo projektowy `settings.local.json` — oba ładują hooki, zmierzone);
 * `mismatch`, gdy gdzieś stoją wpisy Raroga, ale żaden komplet się nie zgadza; inaczej `brak`.
 */
export function combineStatus(inspections: readonly SettingsInspection[]): HookStatus {
  if (inspections.some((one) => one.status === 'ok')) return 'ok';
  if (inspections.some((one) => one.status === 'mismatch')) return 'mismatch';
  return HOOK_STATUS_MISSING;
}

/** Stan wpisu hooka kontekstu w jednym pliku ustawień (jak `statusLine`: bez `stale`, kopię liczy stan hooka). */
export type ContextHookStatus = 'ok' | 'missing' | 'mismatch';

export interface ContextHookInspection {
  readonly path: string;
  /** Plik istnieje i dał się sparsować. Zepsuty JSON = `false` + `mismatch`. */
  readonly readable: boolean;
  readonly status: ContextHookStatus;
  readonly entries: readonly HookEntry[];
  /** Któryś wpis wskazuje skrypt w checkoucie repo, a nie kopię. */
  readonly checkout: boolean;
}

/**
 * Wpis hooka kontekstu w pliku ustawień (TYLKO odczyt): `ok` = dokładnie jeden wpis, równy
 * {@link expectedContextEntry}; `missing` = pliku nie ma albo wpisu nie ma; `mismatch` = wpis inny niż drukowany
 * (inne zdarzenie, matcher, sufit, komenda, checkout zamiast kopii, kilka wpisów) albo pliku nie da się sparsować.
 */
export function inspectContextHook(path: string, command: string): ContextHookInspection {
  const read = readSettings(path);
  if (read === 'missing') return { path, readable: false, status: 'missing', entries: [], checkout: false };
  if (read === 'broken') return { path, readable: false, status: 'mismatch', entries: [], checkout: false };
  const entries = contextHookEntries(read.parsed);
  const checkout = entries.some((entry) => !entry.command.includes(CONTEXT_INSTALLED_SCRIPT_REL));
  if (entries.length === 0) return { path, readable: true, status: 'missing', entries, checkout };
  const ok = entries.length === 1 && entries[0] !== undefined
    && canonical(entries[0]) === canonical(expectedContextEntry(command));
  return { path, readable: true, status: ok ? 'ok' : 'mismatch', entries, checkout };
}

/** Znacznik ostatniego odpalenia hooka (epoch ms) albo `null`. */
export function readHookSeenAt(dataDir: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dataDir, HOOK_SEEN_FILENAME), 'utf8'));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const at = record?.['at'];
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/**
 * Ostatnie odpalenie per plik wejściowy: `{"<plik>.mjs": epoch ms}` ze znaczników
 * {@link HOOK_SEEN_PER_FILE_RE} w katalogu danych. Każdy znacznik czytany jak plik kopii: plik zwykły, bez dowiązania,
 * z sufitem; zły kształt gubi sam wpis. Pusty obiekt = kopia sprzed znaczników per plik albo hook jeszcze nie odpalił.
 */
export function readHookSeenByFile(dataDir: string): Readonly<Record<string, number>> {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return {};
  }
  const result: Record<string, number> = {};
  for (const name of names.filter((one) => HOOK_SEEN_PER_FILE_RE.test(one)).sort().slice(0, HOOK_SEEN_PER_FILE_MAX)) {
    const stem = HOOK_SEEN_PER_FILE_RE.exec(name)?.[1];
    const bytes = readHookFile(join(dataDir, name), 4096);
    if (stem === undefined || typeof bytes === 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    const at = asRecord(parsed)?.['at'];
    if (typeof at === 'number' && Number.isFinite(at)) result[`${stem}.mjs`] = at;
  }
  return result;
}

/**
 * Stan jednego pliku kopii wobec repo: `match` (ten sam sha256), `differs`, `missing` (kopii nie ma) albo `unreadable`
 * (kopia albo źródło to nie plik zwykły — FIFO, dowiązanie, katalog — albo ponad sufit, albo błąd odczytu).
 */
export type HookCopyState = 'match' | 'differs' | 'missing' | 'unreadable';

export interface HookCopyFile {
  readonly name: string;
  readonly state: HookCopyState;
  /** sha256 kopii; `null`, gdy kopii nie da się przeczytać. */
  readonly copySha: string | null;
  /** sha256 pliku w repo; `null`, gdy źródła nie da się przeczytać. */
  readonly repoSha: string | null;
  /** sha256 z manifestu instalacji; `null` bez manifestu albo bez wpisu. */
  readonly manifestSha: string | null;
}

/**
 * Skąd przyszły bajty kopii: commit klonu repo (brama stanu z commita) albo wersja paczki npm (`version`
 * z `package.json` korzenia instalacji). Dokładnie jedno pole jest napisem.
 */
export type HookOrigin =
  | { readonly commit: string; readonly version: null }
  | { readonly commit: null; readonly version: string };

/** Pochodzenie kopii jednym członem zdania: `commit <skrót>` albo `version <wersja>`. */
export function hookOriginText(origin: { readonly commit: string | null; readonly version: string | null }): string {
  if (origin.commit !== null) return `commit ${origin.commit}`;
  return origin.version === null ? 'unknown origin' : `version ${origin.version}`;
}

/**
 * Manifest instalacji (`manifest.json` w katalogu kopii): `commit` z klonu albo `version` z paczki. Czytnik przyjmuje
 * oba kształty (także oba pola naraz), bo kopię z klonu odświeża się potem z paczki i odwrotnie.
 */
export interface HookManifest {
  /** Commit klonu repo, z którego zrobiono kopię; `null` w kopii z paczki. */
  readonly commit: string | null;
  /** Wersja paczki npm, z której zrobiono kopię; `null` w kopii z klonu. */
  readonly version: string | null;
  /** Chwila instalacji, epoch ms. */
  readonly at: number;
  readonly files: Readonly<Record<string, string>>;
}

export interface HookCopyReport {
  readonly dir: string;
  /** `symlink` = katalog kopii jest dowiązaniem: mógłby prowadzić z powrotem do checkoutu, więc nie liczy się. */
  readonly dirKind: 'dir' | 'missing' | 'symlink' | 'other';
  readonly files: readonly HookCopyFile[];
  readonly manifest: HookManifest | null;
  /**
   * Pliki z poprzedniej instalacji, które `hooks:install` usunie ({@link leftoverCopyFiles}); liczy je wyłącznie
   * {@link hookCopyReport}, w {@link statuslineCopyReport} lista jest pusta.
   */
  readonly leftovers: readonly string[];
  /**
   * Kopia jest prawdziwym katalogiem, każdy plik zestawu ({@link HOOK_INSTALL_FILES} w {@link hookCopyReport},
   * {@link STATUSLINE_INSTALL_FILES} w {@link statuslineCopyReport}) ma ten sam sha256 co repo, a plików z poprzedniej
   * instalacji nie ma.
   */
  readonly ok: boolean;
}

function errnoCode(err: unknown): string | undefined {
  return err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

/** Bajty pliku zwykłego do sufitu ({@link HOOK_COPY_MAX_BYTES}); dowiązanie w ostatnim członie = odmowa. */
function readHookFile(path: string, maxBytes = HOOK_COPY_MAX_BYTES): Buffer | 'missing' | 'unreadable' {
  let read;
  try {
    read = readRegularFileSync(path, { maxBytes, followSymlink: false });
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (read === null || read.truncated) return 'unreadable';
  return read.bytes;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Rodzaj wpisu według `lstat` (dowiązanie NIE jest katalogiem). */
function entryKind(path: string): HookCopyReport['dirKind'] {
  let info;
  try {
    info = lstatSync(path);
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? 'missing' : 'other';
  }
  if (info.isSymbolicLink()) return 'symlink';
  return info.isDirectory() ? 'dir' : 'other';
}

const SHA_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Manifest z katalogu kopii albo `null` (brak, zły kształt, nie plik zwykły). */
function readManifest(dir: string): HookManifest | null {
  return readManifestNames(dir)?.manifest ?? null;
}

/**
 * Manifest jak {@link readManifest} razem ze wszystkimi nazwami z `files`, także tymi, których skrót ma zły zapis
 * (`readManifest` je pomija, a dowód pochodzenia kopii przed usunięciem liczy każdą). Jeden odczyt pliku.
 */
function readManifestNames(dir: string): { readonly manifest: HookManifest; readonly names: readonly string[] } | null {
  const bytes = readHookFile(join(dir, HOOK_MANIFEST_FILENAME), 64 * 1024);
  if (typeof bytes === 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const files = asRecord(record?.['files']);
  const commit = record?.['commit'];
  const version = record?.['version'];
  const at = record?.['at'];
  if (files === null) return null;
  // Pole obecne, ale w złym zapisie, psuje cały manifest: nie zgadujemy, które pochodzenie jest prawdziwe.
  if (commit !== undefined && (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit))) return null;
  if (version !== undefined && (typeof version !== 'string' || !VERSION_RE.test(version))) return null;
  if (commit === undefined && version === undefined) return null;
  // Liczba poza zakresem `Date` (np. 1e20) to też manifest nieczytelny: `toISOString()` w doctorze by rzuciło.
  if (typeof at !== 'number' || !Number.isFinite(new Date(at).getTime())) return null;
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(files)) {
    if (typeof value === 'string' && SHA_PATTERN.test(value)) clean[name] = value;
  }
  const manifest: HookManifest = {
    commit: typeof commit === 'string' ? commit : null, version: typeof version === 'string' ? version : null,
    at, files: clean,
  };
  return { manifest, names: Object.keys(files) };
}

/**
 * Wersja instalacji z `<korzeń>/package.json` (odczyt jak plik kopii: plik zwykły, bez dowiązania, sufit) albo
 * `null`, gdy pliku nie ma, nie da się go przeczytać albo wersja ma zły zapis.
 */
export function installedVersion(root: string): string | null {
  const bytes = readHookFile(join(root, 'package.json'));
  if (typeof bytes === 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const version = asRecord(parsed)?.['version'];
  return typeof version === 'string' && VERSION_RE.test(version) ? version : null;
}

/**
 * Kopia hooka wobec repo — jedna funkcja dla `/health` (przez {@link hookHealth}) i dla `hooks:doctor`.
 *
 * Każdy odczyt (kopia, źródło w repo, manifest) idzie przez `readRegularFileSync` z `O_NONBLOCK` i sufitem: FIFO
 * podłożony przez agenta w `scripts/hooks/` daje `unreadable`, a nie zawieszony `/health`. Dowiązanie
 * w miejscu pliku kopii też jest `unreadable`, a dowiązany katalog `rarog` w ogóle się nie liczy: kopia, która
 * prowadzi do checkoutu, ma te same bajty, ale nie tę samą ochronę. Plik z poprzedniej instalacji spoza obecnego
 * zestawu ({@link leftoverCopyFiles}) też odbiera `ok`: `stale` mówi wtedy, że `hooks:install` ma co sprzątnąć.
 */
export function hookCopyReport(home: string, root: string = repoRoot()): HookCopyReport {
  return copyReport(home, root, HOOK_INSTALL_FILES, true);
}

/**
 * Kopia skryptu `statusLine` wobec repo — ta sama reguła co {@link hookCopyReport}, ale dla
 * {@link STATUSLINE_INSTALL_FILES} i bez plików z poprzedniej instalacji. Liczy się wyłącznie wtedy, gdy komenda
 * `statusLine` wskazuje kopię (doctor); do pola `hook` w `/health` nie wchodzi.
 */
export function statuslineCopyReport(home: string, root: string = repoRoot()): HookCopyReport {
  return copyReport(home, root, STATUSLINE_INSTALL_FILES, false);
}

/** Bajty źródła kopii po bramie trybu, z pochodzeniem do manifestu. */
interface Sources {
  readonly ok: true;
  readonly origin: HookOrigin;
  readonly sources: readonly { readonly name: string; readonly bytes: Buffer }[];
}

/** Plik kopii do zapisu: nazwa (ta sama w źródle i w kopii), bufor i jego skrót. */
interface CopyFile {
  readonly name: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** Pliki kopii do zapisu: bajty źródła ze skrótem. */
function copyFiles(sources: readonly { readonly name: string; readonly bytes: Buffer }[]): CopyFile[] {
  return sources.map((source) => ({ name: source.name, bytes: source.bytes, sha256: sha256(source.bytes) }));
}

/**
 * Nazwa z manifestu, którą instalacja może usunąć z katalogu kopii: goła nazwa pliku (bez `/`, `\`, NUL i kropki na
 * początku, więc także bez `.` i `..`), do 128 znaków.
 */
const LEFTOVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Pliki obecnego zestawu kopii i manifest: tych nazw sprzątanie nie rusza nigdy. */
const CURRENT_COPY_NAMES: ReadonlySet<string> = new Set([
  ...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES, HOOK_MANIFEST_FILENAME,
]);

/**
 * Pliki, które instalacja kopii kładła w starszych wersjach, a dziś nie kładzie: plik wejściowy hooka pod starą
 * nazwą produktu. Lista zamknięta, z historii {@link HOOK_INSTALL_FILES} w gicie; nazwa, której instalacja
 * przestaje używać, wchodzi tu w tym samym commicie.
 */
const PREVIOUS_COPY_NAMES: readonly string[] = [OLD_ENTRY_FILE];

/**
 * Pliki, które instalacja kopii kiedykolwiek kładła (bez manifestu): bieżący zestaw i {@link PREVIOUS_COPY_NAMES}.
 * Manifest prawdziwej kopii wymienia wyłącznie te nazwy. Spoza tej listy nic nie znika ani przy instalacji
 * ({@link leftoverCopyFiles}), ani przy `rarog service uninstall` ({@link UNINSTALL_COPY_NAMES}).
 */
const EVER_COPY_FILES: ReadonlySet<string> = new Set([
  ...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES, ...PREVIOUS_COPY_NAMES,
]);

/**
 * Zamknięta lista nazw, które `rarog service uninstall` usuwa z katalogu kopii: {@link EVER_COPY_FILES}
 * i manifest. Manifest niczego do niej nie dodaje: nazwa spoza listy zostaje razem z katalogiem.
 */
const UNINSTALL_COPY_NAMES: ReadonlySet<string> = new Set([...EVER_COPY_FILES, HOOK_MANIFEST_FILENAME]);

/**
 * Pliki z poprzedniej instalacji: do usunięcia (`remove`), pominięte, bo to nie pliki zwykłe (`skipped`), i obce
 * (`foreign`): nazwa z manifestu spoza {@link EVER_COPY_FILES}, pod którą coś leży w katalogu kopii.
 */
interface Leftovers {
  readonly remove: readonly string[];
  readonly skipped: readonly string[];
  readonly foreign: readonly string[];
}

/**
 * Pliki z POPRZEDNIEJ instalacji, których obecny zestaw kopii nie ma (plik wejściowy pod starą nazwą produktu).
 * Kandydatem jest wyłącznie nazwa z manifestu kopii (`manifest`, odczytany {@link readManifest}) i zarazem z zamkniętej
 * listy {@link EVER_COPY_FILES}: manifest niczego do niej nie dodaje (ta sama reguła co przy `rarog service uninstall`).
 * Nazwa spoza manifestu, z obecnego zestawu albo spoza {@link LEFTOVER_NAME_RE} nie wchodzi
 * nigdy. Nazwa z manifestu spoza listy, pod którą coś leży, idzie do `foreign` (zostaje, instalacja to zgłasza).
 * Kandydat do usunięcia to plik zwykły według `lstat` w samym katalogu kopii; dowiązanie, katalog albo FIFO pod tą
 * nazwą idzie do `skipped` (tego Rarog nie założył), nieobecny plik odpada. Manifest nieczytelny (`null`) = nic.
 */
function leftoverCopyFiles(dir: string, manifest: HookManifest | null): Leftovers {
  const remove: string[] = [];
  const skipped: string[] = [];
  const foreign: string[] = [];
  for (const name of Object.keys(manifest?.files ?? {})) {
    if (CURRENT_COPY_NAMES.has(name) || !LEFTOVER_NAME_RE.test(name)) continue;
    let info;
    try {
      info = lstatSync(join(dir, name));
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') (EVER_COPY_FILES.has(name) ? skipped : foreign).push(name);
      continue;
    }
    if (!EVER_COPY_FILES.has(name)) foreign.push(name);
    else (info.isFile() ? remove : skipped).push(name);
  }
  return { remove, skipped, foreign };
}

/** Ta sama lista plików z poprzedniej instalacji (każda z trzech grup), bez względu na kolejność. */
function sameLeftovers(a: Leftovers, b: Leftovers): boolean {
  const key = (one: Leftovers): string => JSON.stringify([
    [...one.remove].sort(), [...one.skipped].sort(), [...one.foreign].sort(),
  ]);
  return key(a) === key(b);
}

function copyReport(home: string, root: string, names: readonly string[], leftovers: boolean): HookCopyReport {
  const dir = hookInstallDir(home);
  const dirKind = entryKind(dir);
  const manifest = dirKind === 'dir' ? readManifest(dir) : null;
  const files = names.map((name): HookCopyFile => {
    const source = readHookFile(join(root, HOOK_SOURCE_DIR_REL, name));
    const repoSha = typeof source === 'string' ? null : sha256(source);
    const manifestSha = manifest?.files[name] ?? null;
    if (dirKind !== 'dir') return { name, state: 'missing', copySha: null, repoSha, manifestSha };
    const copy = readHookFile(join(dir, name));
    if (copy === 'missing') return { name, state: 'missing', copySha: null, repoSha, manifestSha };
    const copySha = copy === 'unreadable' ? null : sha256(copy);
    if (copySha === null || repoSha === null) return { name, state: 'unreadable', copySha, repoSha, manifestSha };
    return { name, state: copySha === repoSha ? 'match' : 'differs', copySha, repoSha, manifestSha };
  });
  const extra = leftovers ? leftoverCopyFiles(dir, manifest).remove : [];
  return {
    dir, dirKind, files, manifest, leftovers: extra,
    ok: dirKind === 'dir' && files.every((one) => one.state === 'match') && extra.length === 0,
  };
}

/**
 * Status rejestracji doprecyzowany kopią: poprawny wpis (`ok`) przy kopii różnej od repo albo jej braku to `stale`.
 * `brak` i `mismatch` zostają — najpierw trzeba wkleić blok, kopia nie poprawia rejestracji.
 */
export function withCopyStatus(status: HookStatus, report: HookCopyReport): HookStatus {
  return status === 'ok' && !report.ok ? 'stale' : status;
}

/**
 * Pole `hook` + `hookSeenAgo` dla `/health` — ta sama logika, co `hooks:doctor`.
 *
 * `hook` to rejestracja w ustawieniach (`ok`/`brak`/`mismatch`) doprecyzowana kopią (`stale`). Sonda czyta
 * pliki ustawień, trzy pliki hooka i manifest; wołający (`index.ts`) trzyma wynik 5 s.
 *
 * `seenAgo` liczymy w SEKUNDACH i nigdy ujemnie (znacznik z przyszłości = zegar hooka biegnie
 * przed naszym; wolimy 0 niż liczbę, której nie umiemy umiejscowić). `seenAgoByFile` to ten sam wiek per plik
 * wejściowy ({@link readHookSeenByFile}); pole jest tylko przy znacznikach per plik i idzie wyłącznie do
 * `GET /api/version`.
 */
export function hookHealth(input: {
  readonly settingsPaths: readonly string[];
  readonly dataDir: string;
  readonly home: string;
  /** Korzeń repo ze źródłem kopii; domyślnie checkout, z którego biegnie ten moduł. */
  readonly root?: string;
  readonly nowMs?: number;
}): HookHealth {
  const expected = expectedHookEntries(hookCommand(input.home));
  const inspections = input.settingsPaths.map((path) => inspectSettingsFile(path, expected));
  const registered = combineStatus(inspections);
  const status = registered === 'ok'
    ? withCopyStatus(registered, hookCopyReport(input.home, input.root ?? repoRoot()))
    : registered;
  const at = readHookSeenAt(input.dataDir);
  const nowMs = input.nowMs ?? Date.now();
  const ago = (when: number): number => Math.max(0, Math.floor((nowMs - when) / 1000));
  const byFile = Object.entries(readHookSeenByFile(input.dataDir));
  return {
    status,
    seenAgo: at === null ? null : ago(at),
    ...(byFile.length === 0 ? {} : { seenAgoByFile: Object.fromEntries(byFile.map(([file, when]) => [file, ago(when)])) }),
  };
}

/** Udana instalacja kopii; `commit` (klon) albo `version` (paczka) to pochodzenie zapisane w manifeście. */
export type HookInstallDone = HookOrigin & {
  readonly ok: true;
  readonly dir: string;
  /** Pliki w kolejności zapisu, ze skrótem. */
  readonly files: readonly { readonly name: string; readonly sha256: string }[];
  /**
   * Pliki z poprzedniej instalacji usunięte z kopii ({@link leftoverCopyFiles}); pusta lista w instalacji tylko
   * brakujących plików (`rarog setup`), która niczego nie usuwa.
   */
  readonly removed: readonly string[];
  /** Ostrzeżenia bez odmowy (np. `~/.claude/hooks` prowadzi poza `~/.claude`). */
  readonly warnings: readonly string[];
};

/** Odmowa instalacji z powodem dla człowieka; nic nie zostało zapisane albo kopia jest nietknięta. */
export interface HookInstallRefused {
  readonly ok: false;
  readonly reason: string;
  /** Człowiek odpowiedział „nie” na pytanie po różnicy (tryb paczki): decyzja, nie błąd. */
  readonly declined?: true;
  /**
   * Różnica, której instalator nie miał komu pokazać z pytaniem (tryb paczki bez {@link HookInstallOptions.review},
   * czyli bez terminala): wołający drukuje ją przed powodem odmowy.
   */
  readonly review?: HookCopyReview;
}

export type HookInstallResult = HookInstallDone | HookInstallRefused;

/**
 * Stan jednego pliku kopii wobec bufora, który instalator zapisze (tryb paczki): `match` (ten sam sha256),
 * `changed` (kopia jest, inne bajty), `new` (w kopii brak) albo `unreadable` (w kopii nie plik zwykły: dowiązanie,
 * FIFO, katalog, ponad 1 MB; zapis go zastąpi albo odmówi).
 */
export type HookCopyChangeState = 'match' | 'changed' | 'new' | 'unreadable';

export interface HookCopyChange {
  /** Nazwa pliku w kopii i w `scripts/hooks/`. */
  readonly name: string;
  readonly state: HookCopyChangeState;
  /** sha256 pliku w kopii; `null` = brak albo nie plik zwykły. */
  readonly copySha: string | null;
  /** sha256 bufora, który pójdzie do kopii. */
  readonly sourceSha: string;
  /** Długość bufora w bajtach. */
  readonly sourceBytes: number;
  /** Hunki różnicy linii kopia → bufor ({@link lineDiff}); puste poza stanem `changed`. */
  readonly diff: readonly string[];
  /** Kopia albo bufor nie jest poprawnym UTF-8: linie różnicy pokazują tekst po dekodowaniu, rozstrzyga sha256. */
  readonly notUtf8: boolean;
}

/** Różnica kopii wobec źródła w paczce, pokazywana przed zapisem (tryb paczki). */
export interface HookCopyReview {
  /** Katalog kopii. */
  readonly dir: string;
  /** Katalog źródeł w paczce (`<korzeń>/scripts/hooks`). */
  readonly sourceDir: string;
  /** Wersja paczki, która trafi do manifestu. */
  readonly version: string;
  /** Manifest obecnej kopii (pochodzenie i chwila instalacji) albo `null`. */
  readonly manifest: HookManifest | null;
  /** Pliki w kolejności zapisu. */
  readonly changes: readonly HookCopyChange[];
  /** Pliki z poprzedniej instalacji, które zapis usunie z kopii ({@link leftoverCopyFiles}). */
  readonly removed: readonly string[];
}

/** Identyfikator obiektu gita dla bajtów pliku (`blob <długość>\0…`), w algorytmie repo (SHA-1 albo SHA-256). */
function gitBlobId(bytes: Buffer, algorithm: 'sha1' | 'sha256'): string {
  return createHash(algorithm).update(`blob ${String(bytes.length)}\0`).update(bytes).digest('hex');
}

/**
 * Zapis pliku kopii: tmp z losowym sufiksem w TYM SAMYM katalogu, `flag: 'wx'` (dowiązanie albo cudzy plik pod
 * nazwą tmp to błąd, nie zapis za nim), prawa 0644 niezależnie od umaska, `rename`. Hook czytany w trakcie widzi
 * stary albo nowy plik, nigdy połowę.
 */
function writeCopyFile(dir: string, name: string, bytes: Buffer | string): void {
  const tmp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, join(dir, name));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Sprzątanie best-effort — tmp bez `rename` nie jest przez nikogo wykonywany.
    }
    throw err;
  }
}

const isInsideReal = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);

const refuse = (reason: string): HookInstallRefused => ({ ok: false, reason });

/** Wejście instalatorów kopii. */
export interface HookInstallOptions {
  readonly home: string;
  /** Korzeń instalacji: źródłem kopii jest `<root>/scripts/hooks/`. */
  readonly root: string;
  /** Tryb instalacji (`install/mode.ts`): wybiera bramę źródła. Wołający podaje go zawsze jawnie. */
  readonly mode: InstallMode;
  /** Runner gita bramy stanu z commita (klon); w paczce nieużywany. */
  readonly git: GitArgsRunner;
  /**
   * Tryb paczki: pokazuje człowiekowi różnicę kopii wobec źródła i pyta; `true` = zapisz dokładnie te bufory.
   * Wołany tylko, gdy kopia różni się od źródła (kopia równa źródłu zapisuje się bez pytania). Brak = wywołanie bez
   * terminala: różna kopia to odmowa z różnicą w {@link HookInstallRefused.review}. W klonie nieużywany.
   */
  readonly review?: (review: HookCopyReview) => Promise<boolean>;
  /**
   * Cel usługi wobec tej instalacji (`copyTargetRefusal` w `server/src/cli/hooks.ts`): napis = usługa startuje inną
   * instalację albo jej celu nie da się odczytać (powód z komendą), `null` = usługi nie ma albo startuje tę. Instalator
   * pyta po bramie źródła, przed różnicą i pytaniem, a w paczce jeszcze raz po odpowiedzi „t”
   * ({@link foreignService}). Wołający podaje go zawsze jawnie.
   */
  readonly serviceRefusal: () => string | null;
}

/** Katalog kopii nadaje się do zapisu (`missing` albo `dir`) albo odmowa z powodem. */
function copyDirKind(dir: string): HookCopyReport['dirKind'] | HookInstallRefused {
  const kind = entryKind(dir);
  if (kind === 'symlink') {
    return refuse(`${dir} is a symlink: the copy could lead back to a directory that is writable `
      + 'from the sandbox. Remove the symlink and run the install again.');
  }
  if (kind === 'other') return refuse(`${dir} exists and is not a directory.`);
  return kind;
}

/**
 * Brama „stan z commita”: `git status --porcelain -- scripts/hooks` pusty, a bajty każdego pliku z `names`
 * równe blobowi w commicie `HEAD` odczytanym RAZ na starcie. Instalujemy wyłącznie stan widoczny w `git log` (agent
 * w sandboksie może commitować, więc to ślad do przejrzenia, nie zapora).
 */
async function committedSources(opts: HookInstallOptions, names: readonly string[]): Promise<Sources | HookInstallRefused> {
  // `--untracked-files=all` jawnie: `status.showUntrackedFiles=no` w konfiguracji repo schowałby nieśledzone pliki.
  const status = await opts.git(
    { sub: 'status', rest: ['--porcelain', '--untracked-files=all', '--', HOOK_SOURCE_DIR_REL] }, opts.root,
  );
  if (!status.ok) return refuse(`git status in ${opts.root} did not answer; cannot tell whether ${HOOK_SOURCE_DIR_REL} `
    + 'is the committed state.');
  if (status.stdout.trim() !== '') {
    return refuse(`${HOOK_SOURCE_DIR_REL} has uncommitted changes; only the committed state is installed:\n`
      + status.stdout.trimEnd());
  }
  const head = await opts.git({ sub: 'rev-parse', rest: ['--verify', 'HEAD^{commit}'] }, opts.root);
  const commit = head.stdout.trim();
  if (!head.ok || !COMMIT_PATTERN.test(commit)) return refuse(`git rev-parse HEAD in ${opts.root} returned no commit.`);

  const sources: { name: string; bytes: Buffer }[] = [];
  for (const name of names) {
    const rel = `${HOOK_SOURCE_DIR_REL}/${name}`;
    const bytes = readHookFile(join(opts.root, rel));
    if (typeof bytes === 'string') return refuse(`${rel}: ${bytes === 'missing' ? 'file missing' : 'not a regular file, or over 1 MB'}.`);
    // Blob z ZAPAMIĘTANEGO commita, nie z ruchomego `HEAD`: równoległy checkout albo commit w trakcie instalacji
    // dałby inaczej bajty z innego commita niż ten w manifeście.
    const blob = await opts.git({ sub: 'rev-parse', rest: ['--verify', `${commit}:${rel}`] }, opts.root);
    const id = blob.stdout.trim();
    if (!blob.ok || gitBlobId(bytes, id.length === 64 ? 'sha256' : 'sha1') !== id) {
      return refuse(`${rel}: bytes on disk differ from ${commit.slice(0, 12)}:${rel}; only the committed state is installed.`);
    }
    sources.push({ name, bytes });
  }
  return { ok: true, origin: { commit, version: null }, sources };
}

/**
 * Źródło kopii w paczce npm: bajty plików `names` z `<korzeń>/scripts/hooks/` czytane RAZ helperem `safe-read.ts`
 * (plik zwykły, bez dowiązania w ostatnim członie, sufit 1 MB) i wersja z `package.json` korzenia. Gita w paczce nie
 * ma, a katalog paczki pod nvm albo pnpm leży w domu, który sandbox sesji może zapisać, więc śladem do przejrzenia
 * jest różnica wobec kopii pokazana przed zapisem ({@link reviewedSources}), nie stan z commita.
 */
function installedSources(root: string, names: readonly string[]): Sources | HookInstallRefused {
  const version = installedVersion(root);
  if (version === null) return refuse(`${join(root, 'package.json')}: no valid "version" field.`);
  const sources: { name: string; bytes: Buffer }[] = [];
  for (const name of names) {
    const rel = `${HOOK_SOURCE_DIR_REL}/${name}`;
    const bytes = readHookFile(join(root, rel));
    if (typeof bytes === 'string') return refuse(`${rel}: ${bytes === 'missing' ? 'file missing' : 'not a regular file, or over 1 MB'}.`);
    sources.push({ name, bytes });
  }
  return { ok: true, origin: { commit: null, version }, sources };
}

/** Tekst bufora i to, czy jest poprawnym UTF-8 (dekodowanie i kodowanie z powrotem daje te same bajty). */
function decoded(bytes: Buffer): { readonly text: string; readonly utf8: boolean } {
  const text = bytes.toString('utf8');
  return { text, utf8: Buffer.from(text, 'utf8').equals(bytes) };
}

/**
 * Różnica kopii w katalogu `dir` (rodzaju `kind`) wobec buforów `files`, w kolejności zapisu, i pliki z poprzedniej
 * instalacji, które zapis usunie (`removed`).
 */
function reviewCopy(
  dir: string, kind: HookCopyReport['dirKind'], files: readonly CopyFile[], sourceDir: string, version: string,
  removed: readonly string[],
): HookCopyReview {
  const changes = files.map((file): HookCopyChange => {
    const base = { name: file.name, sourceSha: file.sha256, sourceBytes: file.bytes.length };
    const copy = kind === 'dir' ? readHookFile(join(dir, file.name)) : 'missing';
    if (copy === 'missing') return { ...base, state: 'new', copySha: null, diff: [], notUtf8: false };
    if (copy === 'unreadable') return { ...base, state: 'unreadable', copySha: null, diff: [], notUtf8: false };
    const copySha = sha256(copy);
    if (copySha === file.sha256) return { ...base, state: 'match', copySha, diff: [], notUtf8: false };
    const before = decoded(copy);
    const after = decoded(file.bytes);
    return {
      ...base, state: 'changed', copySha, diff: lineDiff(before.text, after.text), notUtf8: !before.utf8 || !after.utf8,
    };
  });
  return { dir, sourceDir, version, manifest: kind === 'dir' ? readManifest(dir) : null, changes, removed };
}

/**
 * Linia do pokazania: każdy znak z {@link DIFF_HIDDEN_RANGES} (znaki, które w terminalu nie wyglądają na siebie;
 * zakresy w `server/src/hidden-chars.ts`) jako `\u{<kod szesnastkowo>}`, a dosłowny `\` jako `\\`. Bez podwojenia
 * dosłowny tekst `\u{d}` i prawdziwy CR (który kończy komentarz `//`) wyglądałyby tak samo.
 */
export function visibleLine(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\') out += '\\\\';
    else out += inRanges(code, DIFF_HIDDEN_RANGES) ? `\\u{${code.toString(16)}}` : char;
  }
  return out;
}

/**
 * Opis pliku, którego w kopii nie ma, w różnicy przed zapisem (`  + <plik>: new file, <rozmiar> B, …`); skrypty
 * odbioru paczki szukają go w wyjściu `hooks install`.
 */
export const HOOK_REVIEW_NEW_FILE = 'new file';

/**
 * Różnica do pokazania człowiekowi przed pytaniem: nagłówek z katalogami i wersjami, potem plik po pliku (bez zmian,
 * nowy z rozmiarem i skrótem, nieczytelny w kopii, zmieniony z hunkami linii), na końcu pliki z poprzedniej instalacji
 * do usunięcia. Znaki niewidoczne w terminalu idą jako `\u{…}` ({@link visibleLine}), a treść nowego pliku nie jest
 * drukowana: leży pod podaną ścieżką.
 */
export function renderHookCopyReview(review: HookCopyReview): string {
  const lines = [
    `Diff of the copy ${review.dir} against package version ${review.version} (${review.sourceDir}):`,
    review.manifest === null
      ? `  current copy: no manifest`
      : `  current copy: ${hookOriginText(review.manifest)}, ${new Date(review.manifest.at).toISOString()}`,
  ];
  for (const change of review.changes) {
    const source = join(review.sourceDir, change.name);
    switch (change.state) {
      case 'match':
        lines.push(`  = ${change.name}: unchanged`);
        break;
      case 'new':
        lines.push(`  + ${change.name}: ${HOOK_REVIEW_NEW_FILE}, ${String(change.sourceBytes)} B,`
          + ` sha256 ${change.sourceSha}`, `    content: ${visibleLine(source)}`);
        break;
      case 'unreadable':
        lines.push(`  ! ${change.name}: not a regular file in the copy (symlink, FIFO or over 1 MB), `
          + `new: sha256 ${change.sourceSha}`);
        break;
      case 'changed':
        lines.push(`  ~ ${change.name}: sha256 ${change.copySha ?? '?'} → ${change.sourceSha}`);
        if (change.notUtf8) lines.push('    WARNING: the file is not valid UTF-8; the lines below are the decoded text.');
        if (change.diff.length === 0) lines.push('    (same text lines, different bytes)');
        lines.push(`    --- ${visibleLine(join(review.dir, change.name))}`, `    +++ ${visibleLine(source)}`);
        for (const one of change.diff) lines.push(`    ${visibleLine(one)}`);
        break;
    }
  }
  for (const name of review.removed) {
    lines.push(`  - ${visibleLine(name)}: to be removed from the copy (file from a previous install, outside the current set)`);
  }
  return `${lines.join('\n')}\n`;
}

/** Każdy plik z `files` stoi w kopii jako plik zwykły z dokładnie tymi bajtami. */
function copyMatches(dir: string, files: readonly CopyFile[]): boolean {
  return files.every((file) => {
    const copy = readHookFile(join(dir, file.name));
    return typeof copy !== 'string' && sha256(copy) === file.sha256;
  });
}

/**
 * Kopia z tej instalacji obok usługi, która startuje inną ({@link HookInstallOptions.serviceRefusal}), po cichu
 * przepięłaby kod hooka tamtego serwera na tę instalację (klon obok paczki albo odwrotnie). Odmowa z powodem, gdy
 * zapis zmieniłby kopię: któregoś pliku z `files` w kopii brak albo ma inne bajty, albo instalacja usunęłaby plik
 * z poprzedniej instalacji (`removed`, {@link leftoverCopyFiles}). Kopia równa buforom i bez plików do usunięcia daje
 * `tylko-manifest`: instalator nie pisze wtedy żadnego pliku kodu (zapis starych bajtów po cudzej instalacji w tym
 * oknie cofnąłby ją), najwyżej manifest. `wolno` = usługi nie ma albo startuje tę instalację.
 */
function foreignService(
  opts: HookInstallOptions, dir: string, kind: HookCopyReport['dirKind'], files: readonly CopyFile[],
  removed: readonly string[],
): 'wolno' | 'tylko-manifest' | HookInstallRefused {
  const reason = opts.serviceRefusal();
  if (reason === null) return 'wolno';
  return kind === 'dir' && removed.length === 0 && copyMatches(dir, files) ? 'tylko-manifest' : refuse(reason);
}

/** Bufory po bramie i różnicy; `manifestOnly` = usługa innej instalacji przy kopii równej buforom ({@link foreignService}). */
interface ReviewedSources {
  readonly ok: true;
  readonly origin: HookOrigin;
  readonly files: readonly CopyFile[];
  readonly manifestOnly: boolean;
}

/**
 * Brama źródła trybu (`committedSources` w klonie, `installedSources` w paczce), cel usługi ({@link foreignService}),
 * potem w paczce różnica, pytanie i cel usługi jeszcze raz (pytanie mogło trwać). Wynik niesie bufory gotowe do zapisu:
 * te same, które przeszły bramę i różnicę. `removed` (pliki z poprzedniej instalacji do usunięcia) różnica pokazuje,
 * ale same nie wymagają pytania: usunięcie nie wnosi kodu do kopii.
 */
async function reviewedSources(
  opts: HookInstallOptions, dir: string, kind: HookCopyReport['dirKind'], names: readonly string[],
  removed: readonly string[] = [],
): Promise<ReviewedSources | HookInstallRefused> {
  const gate = opts.mode === 'package' ? installedSources(opts.root, names) : await committedSources(opts, names);
  if (!gate.ok) return gate;
  const files = copyFiles(gate.sources);
  const done = (check: 'wolno' | 'tylko-manifest'): ReviewedSources =>
    ({ ok: true, origin: gate.origin, files, manifestOnly: check === 'tylko-manifest' });
  const first = foreignService(opts, dir, kind, files, removed);
  if (typeof first !== 'string') return first;
  if (gate.origin.version === null) return done(first);
  const review = reviewCopy(dir, kind, files, join(opts.root, HOOK_SOURCE_DIR_REL), gate.origin.version, removed);
  if (review.changes.every((one) => one.state === 'match')) return done(first);
  const install = repairCommands(opts.mode, opts.root).hooksInstall;
  if (opts.review === undefined) {
    return {
      ok: false, review,
      reason: `the copy differs from the package, and it is written only after you review the diff and answer \`y\``
        + ` in a terminal. Run \`${install}\` in your own terminal.`,
    };
  }
  if (!(await opts.review(review))) {
    return { ok: false, declined: true, reason: 'the diff was not approved; the copy is unchanged.' };
  }
  const second = foreignService(opts, dir, kind, files, removed);
  return typeof second === 'string' ? done(second) : second;
}

/** Manifest kopii jako tekst pliku: pochodzenie (`commit` albo `version`), chwila i skróty plików. */
function manifestText(origin: HookOrigin, at: number, files: readonly { name: string; sha256: string }[]): string {
  const from = origin.commit !== null ? { commit: origin.commit } : { version: origin.version };
  const manifest = { ...from, at, files: Object.fromEntries(files.map((one) => [one.name, one.sha256])) };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Zakłada `~/.claude/hooks` i katalog kopii, gdy ich brak; ostrzeżenie, gdy `~/.claude/hooks` prowadzi poza
 * `~/.claude`. Rzuca błędy systemu plików (łapie je wołający przez {@link writeRefusal}).
 */
function prepareCopyDir(home: string, dir: string, kind: HookCopyReport['dirKind']): string[] | HookInstallRefused {
  const warnings: string[] = [];
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  const realParent = realpathSync(parent);
  const realClaude = realpathSync(join(home, '.claude'));
  if (!isInsideReal(realParent, realClaude)) {
    warnings.push(`${parent} leads outside ${join(home, '.claude')} (real path: ${realParent}). `
      + 'Check that no agent session has write access there.');
  }
  if (kind === 'missing') mkdirSync(dir, { mode: 0o755 });
  if (entryKind(dir) !== 'dir') return refuse(`${dir} stopped being a directory during the install.`);
  return warnings;
}

/** Odmowa po błędzie zapisu: brak prawa (sandbox Claude Code) z prośbą o własny terminal, inny błąd z kodem. */
function writeRefusal(dir: string, err: unknown): HookInstallRefused {
  const code = errnoCode(err);
  if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
    return refuse(`no write permission in ${dirname(dir)} (${code}). Run \`${REPAIR.hooksInstall}\` in your own `
      + 'terminal, outside the Claude Code sandbox: Claude Code protects this path from writes from the sandbox.');
  }
  return refuse(`writing the copy to ${dir} failed (${code ?? String(err)}).`);
}

/**
 * `rarog hooks install` / `pnpm run hooks:install`: kopiuje {@link HOOK_INSTALL_FILES} i
 * {@link STATUSLINE_INSTALL_FILES} ze `scripts/hooks/` do `<home>/.claude/hooks/rarog/`, usuwa z kopii pliki
 * z poprzedniej instalacji spoza obecnego zestawu ({@link leftoverCopyFiles}: tylko nazwy z poprzedniego manifestu
 * i z zamkniętej listy {@link EVER_COPY_FILES}, tylko pliki zwykłe) i zapisuje manifest z czterema plikami,
 * nadpisując istniejące (`rename`). Wołają ją WYŁĄCZNIE ręczne komendy w terminalu: `rarog hooks install`
 * (`server/src/cli/hooks.ts`) i `rarog setup` przy kopii różnej od źródła, po `git log` albo różnicy i „t”
 * (`server/src/cli/setup.ts`); brakującą kopię setup zakłada wariantem bez nadpisywania
 * ({@link installMissingHookCopy}). Serwer nigdy (strażnik `hook-granica-guard.test.ts`). Pliku ustawień nie dotyka.
 *
 * Odmowy (nic nie zapisane): `rarog` jest dowiązaniem albo nie katalogiem; brama źródła trybu (klon:
 * {@link committedSources}, `git status` niepusty albo bajty różne od bloba w zapamiętanym commicie, przesunięty
 * w trakcie `HEAD` = odmowa; paczka: {@link installedSources}, potem różnica i pytanie, bez pytania albo po „nie”
 * różna kopia zostaje); usługa startuje inną instalację albo jej celu nie da się odczytać, a kopia ma inne bajty
 * albo instalacja usunęłaby z niej plik z poprzedniej instalacji ({@link foreignService}); lista plików
 * z poprzedniej instalacji zmieniła się w trakcie bramy albo pytania (równoległa instalacja); źródło nie jest plikiem
 * zwykłym; brak prawa zapisu (`EPERM`/`EACCES` — komenda uruchomiona w sandboksie Claude Code). Ostrzeżenia bez
 * odmowy: `~/.claude/hooks` prowadzi poza `~/.claude`; pod nazwą z poprzedniego manifestu stoi coś innego niż plik
 * zwykły (dowiązanie, katalog, FIFO — zostaje nietknięte); poprzedni manifest wymienia nazwę spoza
 * {@link EVER_COPY_FILES}, pod którą coś leży (zostaje nietknięte).
 *
 * Kolejność: `tall-dialog.mjs`, `canon.mjs`, `rarog-pending.mjs`, `rarog-statusline.mjs`, usunięcie plików
 * z poprzedniej instalacji, manifest. Błąd usuwania to odmowa bez nowego manifestu, więc stary dalej wymienia plik
 * i następna instalacja spróbuje znowu.
 *
 * @param opts.git runner gita z osłonami (`spawnGitArgs(gitReadEnv(…))`); środowisko daje wołający
 */
export async function installHookCopy(opts: HookInstallOptions & { readonly now?: () => number }): Promise<HookInstallResult> {
  const dir = hookInstallDir(opts.home);
  const kind = copyDirKind(dir);
  if (typeof kind !== 'string') return kind;
  const leftovers = leftoverCopyFiles(dir, kind === 'dir' ? readManifest(dir) : null);
  const gate = await reviewedSources(opts, dir, kind, [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES],
    leftovers.remove);
  if (!gate.ok) return gate;
  // Brama i pytanie mogą trwać dowolnie długo. Gdy równoległa instalacja dopisała w tym czasie plik do manifestu,
  // stara lista zgubiłaby go z nowego manifestu, a tryb „tylko manifest” przeszedłby mimo pliku do usunięcia.
  const kindNow = copyDirKind(dir);
  if (typeof kindNow !== 'string') return kindNow;
  if (!sameLeftovers(leftovers, leftoverCopyFiles(dir, kindNow === 'dir' ? readManifest(dir) : null))) {
    return refuse(`the copy in ${dir} changed during the install (files from a previous install); nothing`
      + ' is written. Run the install again.');
  }
  try {
    const warnings = prepareCopyDir(opts.home, dir, kind);
    if (!Array.isArray(warnings)) return warnings;
    const files = gate.files.map((one) => ({ name: one.name, sha256: one.sha256 }));
    const manifest = manifestText(gate.origin, (opts.now ?? Date.now)(), files);
    if (gate.manifestOnly) {
      // Kod kopii zostaje nietknięty; manifest tylko, gdy kopia dalej ma te bajty (inna instalacja mogła ją zmienić).
      // Plików z poprzedniej instalacji do usunięcia w tym trybie nie ma ({@link foreignService}).
      if (!copyMatches(dir, gate.files)) {
        return refuse(`the copy in ${dir} changed during the install (the service starts another installation);`
          + ' nothing is written. Run the install again.');
      }
    } else {
      for (const one of gate.files) writeCopyFile(dir, one.name, one.bytes);
    }
    const removed: string[] = [];
    const skipped = [...leftovers.skipped];
    for (const name of leftovers.remove) {
      const outcome = removeLeftover(dir, name);
      if (outcome === 'removed') removed.push(name);
      else if (outcome === 'other') skipped.push(name);
    }
    for (const name of skipped) {
      warnings.push(`${join(dir, name)} is in the previous manifest, but it is not a regular file (symlink, directory `
        + 'or FIFO); it stays in place: check it and remove it yourself.');
    }
    for (const name of leftovers.foreign) {
      warnings.push(`${join(dir, name)} is in the previous manifest, but no Rarog copy ever had a file of that name;`
        + ' it stays in place: check it and remove it yourself.');
    }
    writeCopyFile(dir, HOOK_MANIFEST_FILENAME, manifest);
    return { ok: true, dir, ...gate.origin, files, removed, warnings };
  } catch (err) {
    return writeRefusal(dir, err);
  }
}

/**
 * Usuwa plik z poprzedniej instalacji, gdy w chwili usuwania dalej jest plikiem zwykłym (`lstat` jeszcze raz: przy
 * pytaniu w trybie paczki od wyboru mija dowolnie długo). `missing` = już go nie ma, `other` = coś innego niż plik zwykły
 * (nietknięte). `unlink` usuwa sam wpis katalogu, także gdy w międzyczasie stanęło tam dowiązanie: niczego za nim nie
 * rusza. Inne błędy rzuca (łapie je wołający przez {@link writeRefusal}).
 */
function removeLeftover(dir: string, name: string): 'removed' | 'missing' | 'other' {
  const path = join(dir, name);
  try {
    if (!lstatSync(path).isFile()) return 'other';
    unlinkSync(path);
    return 'removed';
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return 'missing';
    throw err;
  }
}

/**
 * Pliki `names` (i manifest, gdy `manifestAt` podane) w kopii, WYŁĄCZNIE gdy ich brak: każdy plik to plik tymczasowy,
 * potem `link` na docelową nazwę, więc istniejący plik (także zapisany w międzyczasie przez drugi `setup` albo
 * `hooks install`) daje odmowę `EEXIST`, a nie nadpisanie. Ta sama brama źródła co {@link installHookCopy} (w paczce
 * z różnicą i pytaniem; brakujące pliki są w niej nowe). Odmowa po części zapisu zostawia pliki zapisane wcześniej
 * w tym wywołaniu (każdy to bajty po bramie, żaden niczego nie zastąpił).
 */
async function installMissing(
  opts: HookInstallOptions, names: readonly string[], manifestAt: number | null,
): Promise<HookInstallResult> {
  const dir = hookInstallDir(opts.home);
  const kind = copyDirKind(dir);
  if (typeof kind !== 'string') return kind;
  const targets = manifestAt === null ? names : [...names, HOOK_MANIFEST_FILENAME];
  if (kind === 'dir') {
    for (const name of targets) {
      if (entryKind(join(dir, name)) !== 'missing') return refuse(`${join(dir, name)} already exists; nothing is overwritten.`);
    }
  }
  const gate = await reviewedSources(opts, dir, kind, names);
  if (!gate.ok) return gate;
  const raced = (name: string): HookInstallRefused => refuse(`${join(dir, name)} appeared during the install (another `
    + '`setup` or `hooks install`); nothing is overwritten.');
  // Kopia równa buforom przy usłudze innej instalacji: pliki, których przed bramą nie było, ktoś już zapisał.
  if (gate.manifestOnly) return raced(gate.files[0]?.name ?? HOOK_MANIFEST_FILENAME);
  try {
    const warnings = prepareCopyDir(opts.home, dir, kind);
    if (!Array.isArray(warnings)) return warnings;
    for (const one of gate.files) {
      if (!createCopyFile(dir, one.name, one.bytes)) return raced(one.name);
    }
    const files = gate.files.map((one) => ({ name: one.name, sha256: one.sha256 }));
    if (manifestAt !== null
      && !createCopyFile(dir, HOOK_MANIFEST_FILENAME, Buffer.from(manifestText(gate.origin, manifestAt, files)))) {
      return raced(HOOK_MANIFEST_FILENAME);
    }
    return { ok: true, dir, ...gate.origin, files, removed: [], warnings };
  } catch (err) {
    return writeRefusal(dir, err);
  }
}

/**
 * Cała kopia (pliki hooka, skrypt `statusLine`, manifest), WYŁĄCZNIE gdy żadnego z tych plików nie ma — krok hooka
 * w `rarog setup` (`server/src/cli/setup.ts`, jedyny wołający). W odróżnieniu od {@link installHookCopy} (`rename`,
 * czyli nadpisanie) każdy plik idzie przez `link`: kopia założona w trakcie pytania przez drugi proces zostaje.
 * Niczego nie usuwa, także plików z poprzedniej instalacji (to robi wyłącznie {@link installHookCopy}).
 */
export async function installMissingHookCopy(
  opts: HookInstallOptions & { readonly now?: () => number },
): Promise<HookInstallResult> {
  return installMissing(opts, [...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES], (opts.now ?? Date.now)());
}

/**
 * Sama kopia skryptu `statusLine` ({@link STATUSLINE_INSTALL_FILES}), WYŁĄCZNIE gdy jej brak — dla kroku
 * `statusLine` w `rarog setup` (`server/src/cli/setup.ts`, jedyny wołający), który nie ma prawa przepisać plików
 * hooka. Plików hooka ani manifestu nie rusza (zapis jak w {@link installMissingHookCopy}). Manifest dostaje wpis
 * skryptu przy następnym `rarog hooks install`; do tego czasu doctor pokazuje stan kopii skryptu bez skrótu
 * z manifestu.
 */
export async function installStatuslineCopy(opts: HookInstallOptions): Promise<HookInstallResult> {
  return installMissing(opts, STATUSLINE_INSTALL_FILES, null);
}

/**
 * Katalog kopii widziany przed pytaniem o jego usunięcie: ścieżka rzeczywista i i-węzeł do porównania przed każdym
 * usunięciem, pliki kopii do usunięcia i reszta, która zostaje.
 */
export interface HookCopyDirSeen {
  readonly kind: 'dir';
  readonly dir: string;
  /** `realpath(dir)` w chwili pytania. */
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
  /**
   * sha256 bajtów manifestu, na którym stał dowód pochodzenia przy pytaniu: po „y” manifest musi mieć te same bajty,
   * inaczej dowód nie obowiązuje (manifest podmieniony w czasie pytania).
   */
  readonly manifestSha: string;
  /**
   * Nazwy z zamkniętej listy {@link UNINSTALL_COPY_NAMES} obecne jako pliki zwykłe, posortowane; manifest jest wśród
   * nich zawsze.
   */
  readonly remove: readonly string[];
  /** Reszta wpisów (inne nazwy, dowiązania, katalogi z ukośnikiem na końcu), posortowana: zostaje z katalogiem. */
  readonly keep: readonly string[];
}

/** Katalog kopii przed pytaniem o usunięcie: brak, odmowa z powodem albo prawdziwy katalog ({@link HookCopyDirSeen}). */
export type HookCopyDirState =
  | { readonly kind: 'missing'; readonly dir: string }
  | { readonly kind: 'refused'; readonly dir: string; readonly reason: string }
  | HookCopyDirSeen;

/** Wpisy katalogu po nazwie, posortowane; katalog (według `lstat`) z ukośnikiem na końcu, wpis znikający pominięty. */
function copyDirEntries(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    try {
      out.push(lstatSync(join(dir, name)).isDirectory() ? `${name}/` : name);
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') out.push(name);
    }
  }
  return out;
}

/** Ile obcych nazw z manifestu pokazuje odmowa; resztę liczy. */
const FOREIGN_NAMES_SHOWN = 5;

/**
 * Dowód, że katalog pochodzi z instalacji kopii Raroga, zanim cokolwiek z niego zniknie: manifest to plik zwykły
 * w kształcie {@link readManifest}, wymienia wyłącznie nazwy z {@link EVER_COPY_FILES} (więc żadnej z `/`, `..`
 * ani ścieżki bezwzględnej) i co najmniej jeden wymieniony plik leży w katalogu jako plik zwykły z treścią o skrócie
 * sha256 z manifestu. `null` = dowód jest; napis = powód odmowy.
 */
function copyProvenanceRefusal(dir: string): string | null {
  const read = readManifestNames(dir);
  if (read === null) {
    return `${dir} has no Rarog copy manifest (${HOOK_MANIFEST_FILENAME}), so it may not be Rarog's; nothing removed.`
      + ' Check it yourself.';
  }
  const foreign = read.names.filter((name) => !EVER_COPY_FILES.has(name));
  if (foreign.length > 0) {
    const rest = foreign.length - FOREIGN_NAMES_SHOWN;
    const more = rest > 0 ? ` and ${String(rest)} more` : '';
    const names = foreign.slice(0, FOREIGN_NAMES_SHOWN).map((name) => JSON.stringify(name)).join(', ');
    return `${dir} is not a Rarog copy: its manifest lists ${names}${more}, which no Rarog install writes; nothing`
      + ' removed. Check it yourself.';
  }
  const proven = Object.entries(read.manifest.files).some(([name, sha]) => {
    const bytes = readHookFile(join(dir, name));
    return typeof bytes !== 'string' && sha256(bytes) === sha;
  });
  return proven ? null : `${dir} is not a Rarog copy: no file its manifest lists has the content (sha256) the manifest`
    + ' records; nothing removed. Check it yourself.';
}

/**
 * Stan katalogu kopii dla `rarog service uninstall` w paczce. Usunięcie dotyczy
 * wyłącznie nazw z zamkniętej listy {@link UNINSTALL_COPY_NAMES} obecnych jako pliki zwykłe, i to tylko
 * w prawdziwym katalogu tego użytkownika pod `realpath(HOME)`, z dowodem pochodzenia ({@link copyProvenanceRefusal}).
 * Odmowa: dowiązanie w miejscu katalogu, coś innego niż katalog, katalog innego użytkownika, ścieżka, która przez
 * dowiązanie przodka wypada na sam katalog domowy, nad nim albo poza nim (`~/.claude/hooks` → `/home` przy
 * `HOME=/home/rarog`), oraz katalog bez dowodu: to nie kopia Raroga, choćby stał w nim plik o nazwie z zestawu albo
 * manifest w jej kształcie (projekt użytkownika pod `~/Projects/rarog`, gdy `~/.claude/hooks` → `~/Projects`). Tylko
 * czyta.
 */
export function hookCopyDirState(home: string): HookCopyDirState {
  const dir = hookInstallDir(home);
  const refused = (reason: string): HookCopyDirState => ({ kind: 'refused', dir, reason });
  let info;
  try {
    info = lstatSync(dir);
  } catch (err) {
    const code = errnoCode(err);
    return code === 'ENOENT' ? { kind: 'missing', dir } : refused(`cannot check ${dir} (${code ?? 'error'})`);
  }
  if (info.isSymbolicLink()) {
    return refused(`${dir} is a symlink; only a real directory is removed. Check where it leads, then remove the symlink`
      + ' by hand.');
  }
  if (!info.isDirectory()) return refused(`${dir} is not a directory; check it, then remove it by hand.`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    return refused(`${dir} belongs to another user; nothing removed.`);
  }
  let real: string;
  let entries: string[];
  try {
    real = realpathSync(dir);
    const realHome = realpathSync(home);
    if (isInsideReal(realHome, real)) {
      return refused(`${dir} leads to the home directory or above it through a symlink (real path: ${real}); nothing`
        + ' removed.');
    }
    if (!isInsideReal(real, realHome)) {
      return refused(`${dir} leads outside HOME through a symlink (real path: ${real}); nothing removed.`);
    }
    entries = copyDirEntries(dir);
  } catch (err) {
    return refused(`cannot read ${dir} (${errnoCode(err) ?? 'error'})`);
  }
  const notOurs = copyProvenanceRefusal(dir);
  if (notOurs !== null) return refused(notOurs);
  const manifestBytes = readHookFile(join(dir, HOOK_MANIFEST_FILENAME));
  if (typeof manifestBytes === 'string') return refused(`cannot read the manifest in ${dir} (${manifestBytes})`);
  const manifestSha = sha256(manifestBytes);
  const remove: string[] = [];
  const keep: string[] = [];
  for (const entry of entries) {
    let regular = false;
    try {
      regular = UNINSTALL_COPY_NAMES.has(entry) && lstatSync(join(dir, entry)).isFile();
    } catch {
      // Wpis zniknął albo nie da się go sprawdzić: zostaje na liście tego, co zostaje.
    }
    (regular ? remove : keep).push(entry);
  }
  return { kind: 'dir', dir, real, dev: info.dev, ino: info.ino, manifestSha, remove, keep };
}

/**
 * Wynik {@link removeHookCopy}: pliki usunięte (manifest ostatni) i katalog usunięty albo zostawiony z resztą wpisów
 * (`left`); zatrzymanie z powodem, z tym, co usunięte, i tym, co nie.
 */
export type HookCopyRemoval =
  | {
    readonly ok: true;
    readonly removed: readonly string[];
    readonly dirRemoved: boolean;
    /** Wpisy, które zostały w katalogu (jak {@link HookCopyDirSeen.keep}); pusta lista, gdy katalog usunięty. */
    readonly left: readonly string[];
  }
  | {
    readonly ok: false;
    /** `changed` = pod ścieżką nie ma już katalogu z pytania; `failed` = błąd usunięcia pliku albo katalogu. */
    readonly why: 'changed' | 'failed';
    readonly reason: string;
    /** Pliki usunięte przed zatrzymaniem, w kolejności usuwania. */
    readonly removed: readonly string[];
    /** Pliki z listy `remove`, które zostały (także te, które w chwili usuwania nie były już plikami zwykłymi). */
    readonly notRemoved: readonly string[];
  };

/**
 * Pod ścieżką katalogu kopii dalej stoi katalog z pytania: prawdziwy katalog (nie dowiązanie) o tym samym i-węźle
 * i tej samej ścieżce rzeczywistej ({@link HookCopyDirSeen.real}). Node nie ma `unlinkat` względem deskryptora
 * katalogu, więc {@link removeHookCopy} sprawdza to przed każdym `unlink` i przed `rmdir`: okno między sprawdzeniem
 * a usunięciem jest zwężone, nie zamknięte. Sesja w sandboksie Claude Code nie zapisze pod `~/.claude/hooks/`
 * (chroniona ścieżka, zmierzone), a proces tego użytkownika spoza sandboksa i tak może te pliki usunąć sam.
 */
function sameCopyDir(seen: HookCopyDirSeen): boolean {
  try {
    const info = lstatSync(seen.dir);
    return !info.isSymbolicLink() && info.isDirectory() && info.dev === seen.dev && info.ino === seen.ino
      && realpathSync(seen.dir) === seen.real;
  } catch {
    return false;
  }
}

/**
 * Manifest ma dalej bajty z chwili pytania ({@link HookCopyDirSeen.manifestSha}), więc dowód pochodzenia dalej
 * obowiązuje. Ten sam katalog z podmienionym manifestem (np. cudzym `manifest.json` projektu) = stop przed usunięciem.
 */
function sameManifest(seen: HookCopyDirSeen): boolean {
  const bytes = readHookFile(join(seen.dir, HOOK_MANIFEST_FILENAME));
  return typeof bytes !== 'string' && sha256(bytes) === seen.manifestSha;
}

/** Zdanie po odmowie zapisu albo usuwania w chronionej ścieżce (`EPERM`/`EACCES`: sandbox Claude Code). */
function sandboxHint(code: string | undefined): string {
  return code === 'EPERM' || code === 'EACCES'
    ? ' Run the command in your own terminal, outside the Claude Code sandbox, which protects this path.' : '';
}

/**
 * Usuwa pliki kopii widziane przy pytaniu ({@link hookCopyDirState}, lista `remove`): przed każdym plikiem i przed
 * `rmdir` sprawdza, że pod ścieżką stoi dalej katalog z pytania ({@link sameCopyDir}), a inaczej staje i mówi, co
 * usunęło i co zostało. Każdy plik tylko wtedy, gdy dalej jest plikiem zwykłym (`unlink` samego wpisu, bez
 * wchodzenia w dowiązania), manifest na końcu, żeby przerwane usuwanie zostawiło katalog, który następne `uninstall`
 * dalej rozpozna jako kopię. Potem `rmdir`, które przechodzi tylko na pustym katalogu; reszta wpisów zostaje i trafia
 * do wyniku. Woła WYŁĄCZNIE `rarog service uninstall` w paczce (`server/src/cli/service.ts`), po drugim „y”
 * i dopiero wtedy, gdy w ustawieniach nie ma wpisów Raroga, które wskazują kopię (strażnik
 * `hook-granica-guard.test.ts`, reguła 7).
 */
export function removeHookCopy(seen: HookCopyDirSeen): HookCopyRemoval {
  const order = [
    ...seen.remove.filter((name) => name !== HOOK_MANIFEST_FILENAME),
    ...seen.remove.filter((name) => name === HOOK_MANIFEST_FILENAME),
  ];
  const removed: string[] = [];
  /** Pliki z listy, które w chwili usuwania nie były już plikami zwykłymi: zostały nietknięte. */
  const skipped: string[] = [];
  const stop = (why: 'changed' | 'failed', reason: string, at: number): HookCopyRemoval => ({
    ok: false, why, reason, removed: [...removed], notRemoved: [...skipped, ...order.slice(at)],
  });
  const changed = (at: number): HookCopyRemoval => stop('changed', removed.length === 0 && skipped.length === 0
    ? `${seen.dir} changed during the question; nothing removed. Check it yourself.`
    : `${seen.dir} changed during the removal: it is no longer the directory from the question; stopped. Check it`
      + ' yourself.', at);
  for (const [at, name] of order.entries()) {
    if (!sameCopyDir(seen) || !sameManifest(seen)) return changed(at);
    try {
      const outcome = removeLeftover(seen.dir, name);
      if (outcome === 'removed') removed.push(name);
      else if (outcome === 'other') skipped.push(name);
    } catch (err) {
      const code = errnoCode(err);
      return stop('failed', `removing ${join(seen.dir, name)} failed (${code ?? String(err)}); stopped.`
        + sandboxHint(code), at);
    }
  }
  if (!sameCopyDir(seen)) return changed(order.length);
  try {
    rmdirSync(seen.dir);
    return { ok: true, removed, dirRemoved: true, left: [] };
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') {
      return stop('failed', `removing the directory ${seen.dir} failed (${code ?? String(err)}); the directory`
        + ` stays.${sandboxHint(code)}`, order.length);
    }
  }
  let left: readonly string[];
  try {
    left = copyDirEntries(seen.dir);
  } catch {
    left = seen.keep;
  }
  return { ok: true, removed, dirRemoved: false, left };
}

/**
 * Zapis pliku kopii TYLKO gdy go brak: tmp z losowym sufiksem (`wx`, 0644), `link` na docelową nazwę, tmp usunięty.
 * `false` = nazwa już zajęta (`EEXIST`); inne błędy rzuca.
 */
function createCopyFile(dir: string, name: string, bytes: Buffer): boolean {
  const tmp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o644 });
    chmodSync(tmp, 0o644);
    linkSync(tmp, join(dir, name));
    return true;
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Sprzątanie best-effort — tmp z kropką na początku nikt nie wykonuje.
    }
  }
}

/**
 * Domyślna ścieżka ustawień użytkownika (bywa dowiązaniem do repo dotfiles). Serwer i doctor ją czytają; własne wpisy
 * hooków pisze tylko pisarz CLI (`server/src/cli/claude-settings.ts`), przez dowiązanie do jego celu.
 */
export function userSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

/** Ustawienia projektowe, wariant `--local` (w `.gitignore` większości repo). */
export function localSettingsPath(projectDir: string): string {
  return join(projectDir, '.claude', 'settings.local.json');
}

/**
 * Zapisuje korzenie Raroga dla filtra `cwd` w hooku — atomowo (tmp + rename), bo hook czyta
 * ten plik w cudzym procesie i nie ma prawa zobaczyć połowy zapisu.
 *
 * Wołane przy KAŻDYM starcie serwera: `RAROG_HERDR_ROOTS` bywa zmieniane w środowisku serwera, a hook
 * nie ma skąd znać tej zmiennej. Pusta lista korzeni jest zapisywana jak każda inna — hook
 * traktuje ją jak brak pliku, czyli nie pisze nigdzie (fail-closed).
 *
 * `tallDialogGuard` (flaga `RAROG_TALL_DIALOG_GUARD`) jedzie tym samym
 * plikiem, bo hook nie zna środowiska serwera. Pole stoi WYŁĄCZNIE przy włączonym strażniku:
 * jego brak znaczy dla hooka „strażnika nie ma”, więc stary plik i flaga `0` dają to samo.
 *
 * `exclude`: the folders the work area leaves out (`excludedFolders` in `config/work-area.ts`). With the
 * field the hook applies the work area rule (no hidden entry of a root, no excluded folder unless a root lies in
 * it); a hook copy from before reads only `roots` and keeps the plain root check.
 */
export function writeHookRoots(
  dataDir: string, roots: readonly string[],
  options: { readonly tallDialogGuard?: boolean; readonly exclude?: readonly string[] } = {},
): void {
  const file = join(dataDir, HOOK_ROOTS_FILENAME);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Losowy sufiks i `wx`: pod przewidywalną nazwą `<plik>.<pid>.tmp` dowiązanie przekierowywało zapis,
  // a `rename` stawiało je w miejscu `roots.json`. Istniejąca nazwa, także dowiązanie, to teraz błąd.
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const body = {
    roots,
    ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
    ...(options.tallDialogGuard === true ? { tallDialogGuard: true } : {}),
  };
  try {
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Sprzątanie best-effort — tmp bez rename i tak nie jest przez nikogo czytany.
    }
    throw err;
  }
}

/** Korzenie zapisane dla hooka — do diagnostyki (`hooks:doctor`), nie do decyzji. */
export function readHookRoots(dataDir: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dataDir, HOOK_ROOTS_FILENAME), 'utf8'));
  } catch {
    return null;
  }
  const raw = asRecord(parsed)?.['roots'];
  if (!Array.isArray(raw)) return null;
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/**
 * Rotacja dziennika strażnika — wołana RAZ przy starcie serwera, obok żniwiarza `pending/`.
 *
 * Rotuje serwer, a nie hook: hooki odpalają się równolegle (kilku agentów naraz), a dwa procesy
 * rotujące ten sam plik mogłyby nadpisać `.1` jednym wpisem. Ceną jest
 * to, że między restartami plik rośnie bez sufitu — przy ~150 B na odmowę to i tak kilobajty
 * dziennie. Brak pliku i każdy błąd = nic się nie dzieje (best-effort, jak żniwiarz).
 *
 * @returns `true`, gdy plik przeszedł do `.1`
 */
export function rotateGuardLog(dataDir: string, maxBytes: number = HOOK_GUARD_LOG_MAX_BYTES): boolean {
  const file = join(dataDir, HOOK_GUARD_LOG_FILENAME);
  try {
    if (statSync(file).size <= maxBytes) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/** Suma odmów strażnika wysokości dialogu z linii `guard.jsonl` (bez treści, same liczby). */
export interface GuardSummary {
  readonly total: number;
  /** Odmowy zgód SUBAGENTA (payload z `agent_id`) — główna przyczyna, dla której strażnik jest. */
  readonly subagent: number;
  /** `rows` = cały dialog za wysoki, `header` = sam opis wypychał tytuł poza zasięg parsera. */
  readonly byReason: Readonly<Record<string, number>>;
  /** Najwyższy szacunek w oknie (wiersze dialogu) — `null`, gdy odmów nie było. */
  readonly maxRows: number | null;
  /**
   * Źródło budżetu → liczba odmów. Klucze z {@link HOOK_BUDGET_SOURCES}; `missing` = linia
   * bez pola źródła budżetu, `other` = wartość spoza listy.
   */
  readonly byBudgetSource: Readonly<Record<string, number>>;
  /** Najmniejsza liczba wierszy panelu (`paneRows`) wśród odmów — `null`, gdy żadna jej nie niesie. */
  readonly minPaneRows: number | null;
  /** Linie nie do sparsowania (zwykle ogon po rotacji albo zapis przerwany w połowie). */
  readonly skipped: number;
}

/**
 * Sumuje linie dziennika strażnika z okna czasu — czysta funkcja dla audytu odmów.
 *
 * @param lines linie obu generacji (`guard.jsonl.1` i `guard.jsonl`), puste są pomijane
 * @param since epoch ms początku okna; linia bez liczbowego `at` liczy się jako nieczytelna
 */
export function summarizeGuard(lines: readonly string[], since: number): GuardSummary {
  let total = 0;
  let subagent = 0;
  let skipped = 0;
  let maxRows: number | null = null;
  let minPaneRows: number | null = null;
  const byReason: Record<string, number> = {};
  const byBudgetSource: Record<string, number> = {};
  const sources = new Set<string>(HOOK_BUDGET_SOURCES);
  for (const line of lines) {
    if (line.trim() === '') continue;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      record = null;
    }
    const at = record?.['at'];
    if (record === null || typeof at !== 'number' || !Number.isFinite(at)) {
      skipped += 1;
      continue;
    }
    if (at < since) continue;
    total += 1;
    if (record['subagent'] === true) subagent += 1;
    const reason = typeof record['reason'] === 'string' ? record['reason'] : '?';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    const rows = record['rows'];
    if (typeof rows === 'number' && Number.isFinite(rows)) maxRows = Math.max(maxRows ?? rows, rows);
    const source = record['budgetSource'];
    const sourceKey = typeof source !== 'string' ? 'missing' : (sources.has(source) ? source : 'other');
    byBudgetSource[sourceKey] = (byBudgetSource[sourceKey] ?? 0) + 1;
    const paneRows = record['paneRows'];
    if (typeof paneRows === 'number' && Number.isInteger(paneRows) && paneRows > 0) {
      minPaneRows = Math.min(minPaneRows ?? paneRows, paneRows);
    }
  }
  return { total, subagent, byReason, maxRows, byBudgetSource, minPaneRows, skipped };
}
