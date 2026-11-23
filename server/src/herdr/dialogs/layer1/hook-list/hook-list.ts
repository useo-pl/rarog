/**
 * Lista hooków `PermissionRequest` sesji Claude Code dla dowodu ukrytego kanału zgód.
 * Rarog ustawienia wyłącznie CZYTA: moduł niczego nie zapisuje.
 *
 * Dowód listy hooków zachodzi dla prośby subagenta, gdy jedynym hookiem `PermissionRequest` we wszystkich warstwach,
 * które CLI sesji mogło załadować, jest hook Raroga (komenda z listy `accepted`, `type: "command"`, bez `args`). Ślad
 * decyzji obcego hooka w transkrypcie przed wynikiem nie istnieje (pomiar), więc lista jest pozytywna: wszystko, czego
 * nie da się przeczytać jednoznacznie, to brak dowodu. Źródła i semantyka z dokumentacji Claude Code (hooks, settings,
 * managed-settings, cli-reference, plugins, plugins-reference, plugins/loading, plugins/marketplace-reference,
 * sub-agents, skills, worktrees); kodu CLI moduł nie zna.
 *
 * Warstwy (kolejność odczytu w {@link sessionHookVerdict}):
 *
 * - proces sesji: pid z rejestru CLI (jeden żywy wpis), `ps -o etime=,args=`: start procesu i argumenty. Pid
 *   z innym startem niż `startedAt` rejestru (1–7 s po starcie procesu) = inny proces. `ps` skleja argumenty spacją
 *   i ich granice giną (prompt podany w argumencie wygląda jak flagi), więc z argumentów lista bierze tylko to, co
 *   dokłada pliki do sprawdzenia albo zabiera dowód ({@link parseClaudeArgs}). `--plugin-dir`, `--plugin-url`,
 *   `--agents` i `--add-dir` wnoszą wtyczki, agentów albo ustawienia spoza listy = brak dowodu, w każdym słowie;
 *   `--setting-sources` niczego nie zawęża: hooki liczą się ze wszystkich warstw użytkownika, projektu i local;
 * - `--settings` (plik albo JSON w argumencie, każde wystąpienie) jak każda inna warstwa; ścieżka względna, ze
 *   spacją albo argument niejednoznaczny = brak dowodu;
 * - użytkownik: `<home>/.claude/settings.json` i `settings.local.json`;
 * - projekt: `<cwd>/.claude/settings.json` (bez szukania w katalogach wyżej), local: `.claude/settings.local.json`
 *   w `cwd` i każdym katalogu wyżej (nadzbiór korzenia repozytorium git), dla `cwd` z rejestru sesji i z każdej
 *   prośby. `cwd` w linked worktree gita dokłada te same warstwy i definicje (niżej) głównego checkoutu
 *   (dokumentacja settings: „In a worktree, it uses the file at the main checkout's root”; worktrees: to samo dla
 *   `.claude/agents` i `.claude/commands`), ustalonego z plików `.git` i `commondir` ({@link mainCheckoutOf});
 * - managed (macOS): `/Library/Application Support/ClaudeCode/managed-settings.json`, każdy `*.json` z
 *   `managed-settings.d/`, kopia ustawień z serwera `<home>/.claude/remote-settings.json`; plik preferencji MDM
 *   (`/Library/Managed Preferences/…/com.anthropic.claudecode.plist`, ścieżki dokumentacja nie podaje) = brak dowodu;
 *   reszta katalogu managed jak drzewo skilli niżej. Inne systemy = brak dowodu (ścieżek nie sprawdzono);
 * - wtyczki z `installed_plugins.json`: `enabledPlugins` ze wszystkich warstw (nadzbiór ładowanych, jak dla hooków).
 *   Wtyczka jest wyłączona, gdy `false` stoi w warstwie ładowanej na pewno (`--settings`; `settings.json`
 *   użytkownika, gdy argumenty nigdzie nie mają `--setting-sources`), a żadna warstwa nie ma innej wartości; bez
 *   wzmianki jest włączona (dokumentacja plugins-reference: `defaultEnabled` domyślnie `true`; wartości z manifestu
 *   lista nie czyta, więc liczy nadzbiór). `false` z managed nie wyłącza: domyślnie działa tylko najwyższe źródło
 *   managed z kluczem polityki (dokumentacja managed-settings, `first-wins`). Id włączone bez wpisu instalacji = brak
 *   dowodu. Plik włączonej wtyczki ze słowem `PermissionRequest` (także zakodowanym w JSON albo w nagłówku YAML,
 *   {@link frontmatterEscapeLine}) = obcy hook (nadzbiór `hooks.json`, `plugin.json`, skilli i agentów wtyczki); to
 *   samo dla wpisu wtyczki w pliku jej marketplace'u i katalogu źródłowego wtyczki ładowanej w miejscu
 *   ({@link checkMarketplaceEntry}) oraz każdej wtyczki z `plugins/synced/` (z claude.ai);
 * - definicje agentów, skille i komendy (`.claude/agents`, `.claude/skills`, `.claude/commands` użytkownika
 *   i `cwd` z katalogami wyżej): plik ze słowem `PermissionRequest` albo z zapisem, który bez parsera YAML mógłby
 *   je dać ({@link frontmatterEscapeLine}), = obcy hook (nagłówek z `hooks` agenta działa, póki działa agent,
 *   a skilla do końca sesji), także skille z claude.ai w `skills/synced/`.
 *
 * `disableAllHooks` i `allowManagedHooksOnly` tylko wyłączają hooki, więc lista ich nie bierze (strona „bez dowodu”).
 * Każdy przeczytany plik i katalog musi mieć `ctime` i `mtime` sprzed startu procesu sesji, a ścieżka do niego idzie
 * składnik po składniku ({@link Reader.resolve}): każde dowiązanie po drodze, także pośrednie w łańcuchu, musi być
 * sprzed startu, bo przełączenie dowiązania katalogu zmienia warstwę bez zmiany pliku docelowego. Samo dowiązanie
 * dowodu nie zabiera (ustawienia bywają dowiązaniami do repozytorium dotfiles); katalogi pośrednie, które nie są
 * dowiązaniami, nie są sprawdzane. Dokumentacja nie mówi jednoznacznie, kiedy CLI przeładowuje hooki z plików
 * („normally picked up by the file watcher”, wtyczki do `/reload-plugins`, plik `--settings` wcale), więc zmiana po
 * starcie = brak dowodu do restartu sesji. Plik nieobecny = warstwa pusta (usunięcia pliku po starcie lista nie widzi,
 * przełączenie dowiązania na brak celu tak). Błąd odczytu inny niż brak pliku, JSON nie-obiekt, pętla dowiązań,
 * przekroczony sufit plików, katalogów albo bajtów = brak dowodu.
 *
 * Pliki rozliczeniowe, które CLI przepisuje w trakcie życia sesji (rejestr sesji, zapis synchronizacji z claude.ai,
 * znaczniki `.in_use`, `known_marketplaces.json` z odświeżanym `lastUpdated`; dokumentacja plugins/loading), nie
 * przechodzą przez sprawdzenie startu (dowiązania po drodze do nich tak); ich treść ograniczają reguły w miejscu
 * odczytu.
 *
 * Czego lista nie widzi (opis w `docs/dialogs.md`): mody wbudowane w CLI, wtyczki z `CLAUDE_CODE_PLUGIN_DIRS`
 * i katalogu z `CLAUDE_CODE_PLUGIN_CACHE_DIR` (środowisko procesu sesji niesie sekrety, Rarog go nie czyta), hooki
 * opcji SDK.
 *
 * Werdykt sesji z odczytu rozpoczętego w chwili `c` dotyczy próśb, których hook wystartował nie później niż `c`:
 * hooki zdarzenia startują razem, a pliki do `c` się nie zmieniły. Prośba późniejsza liczy werdykt od nowa; werdykt
 * negatywny żyje {@link HOOK_LIST_RETRY_MS}. A verdict holds only for the session process (registry pid and start)
 * and the `cwd` it was read for ({@link createSessionHookList}).
 *
 * A negative verdict has a kind ({@link hookListVerdictKind}): durable for the session
 * process (the desk fallback sends such a request back at once, `layer1/desk.ts`), transient (read again after
 * {@link HOOK_LIST_TRANSIENT_RETRY_MS}, sooner than the desk fallback's 10 s) or neither (kept as long as a durable one,
 * but the request waits the 10 s).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DISK_LAYOUT } from '../../../commands/registry.ts';
import type { HookCallDump } from '../../hook/contract.ts';
import { parseElapsed } from '../../shadow/liveness.ts';
import { HOOK_PERMISSION_EVENT } from '../../../hook-commands.ts';
import { readRegularFile } from '../../../../safe-read.ts';

/** Zapas na rozdzielczość `etime` (pełne sekundy) i czas samego `ps`. */
export const HOOK_LIST_START_SLACK_MS = 2_000;

/** Rejestr CLI pisze `startedAt` 1–7 s po starcie procesu (`cli-version.ts`); zapas do 10 s. */
export const HOOK_LIST_REGISTRY_START_MAX_MS = 10_000;

/** Ile żyje werdykt negatywny, zanim lista policzy go od nowa. */
export const HOOK_LIST_RETRY_MS = 30_000;

/** How long a transient negative verdict lives: shorter than the desk fallback's 10 s, so a mended read counts. */
export const HOOK_LIST_TRANSIENT_RETRY_MS = 2_000;

/**
 * Codes of a negative verdict that hold for the life of the session process: a file or link changed after its start
 * (ctime and mtime only grow), another hook or a hook entry of another shape, an argument, the system, a managed plist.
 */
const DURABLE_CODES: ReadonlySet<string> = new Set([
  'changed', 'foreign', 'hooks-shape', 'hook-in', 'hook-escape', 'marketplace-changed', 'arg', 'platform',
  'managed-plist',
]);

/**
 * Codes of a negative verdict that the next read can mend: a read error, the session process or its registry entry
 * not seen yet, the registry file in the middle of a write, the read budget, a settings file that does not parse.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'io', 'no-process', 'process-start', 'no-registry-entry', 'no-registry-start', 'registry-file', 'budget',
  'unparseable',
]);

/** Kind of a negative verdict; `other` = a code on neither list, kept like a durable one but without its release. */
export type HookListVerdictKind = 'durable' | 'transient' | 'other';

/** Kind of a negative verdict's `why` by its code, the part before the first `:`. */
export function hookListVerdictKind(why: string): HookListVerdictKind {
  const at = why.indexOf(':');
  const code = at < 0 ? why : why.slice(0, at);
  if (DURABLE_CODES.has(code)) return 'durable';
  return TRANSIENT_CODES.has(code) ? 'transient' : 'other';
}

/** Sufity odczytu drzew (wtyczki, skille, agenci): plików, bajtów pliku i bajtów razem. */
export const HOOK_LIST_MAX_FILES = 5_000;
export const HOOK_LIST_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const HOOK_LIST_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Sufit czasu `ps` procesu sesji. */
const PS_TIMEOUT_MS = 1_000;
const PS_PATH = '/bin/ps';

/** Argumenty CLI, które wnoszą wtyczki, agentów albo ustawienia spoza listy. */
const BLOCKED_FLAGS = ['--plugin-dir', '--plugin-url', '--agents', '--add-dir'] as const;
/** Flaga, która mogła wyłączyć warstwę użytkownika (dokumentacja cli-reference: „setting sources to load”). */
const SETTING_SOURCES_FLAG = '--setting-sources';
const SETTING_SOURCES = ['user', 'project', 'local'] as const;

/** Końce linii YAML: `\r\n`, samotny `\r`, `\n` (YAML 1.2) oraz NEL, LS i PS (YAML 1.1). */
const YAML_LINE_BREAK = /\r\n|\r|\n|\u0085|\u2028|\u2029/;
/**
 * Jawny tag YAML (`!!binary`, `!<…>`, `!e!…` z `%TAG`): `!` na początku węzła, czyli na początku linii YAML, po białym
 * znaku albo po `[`, `{`, `,`, `:`. Tagowany węzeł może dać klucz z tekstu bez słowa (base64 w `!!binary`).
 */
const YAML_TAG = /(?:^|[\s[{,:])!/;
/**
 * Znaki po ukośniku, z którymi para nie daje litery ani nie skleja słowa: w podwójnych cudzysłowach YAML `\"` to
 * cudzysłów, `\\` ukośnik, a `\n` znak nowej linii; bez cudzysłowów i w apostrofach ukośnik jest dosłowny.
 */
const YAML_SAFE_ESCAPES: ReadonlySet<string> = new Set(['"', '\\', 'n']);

/**
 * Czy linia YAML (bez znaku końca linii) ma ukośnik spoza par {@link YAML_SAFE_ESCAPES}. Pary czyta od lewej, więc
 * `\\` zjada oba znaki; ukośnik na końcu linii stoi przed końcem linii YAML albo przed końcem tekstu.
 */
function hasUnsafeBackslash(line: string): boolean {
  for (let at = line.indexOf('\\'); at >= 0; at = line.indexOf('\\', at + 2)) {
    const next = line[at + 1];
    if (next === undefined || !YAML_SAFE_ESCAPES.has(next)) return true;
  }
  return false;
}

const MANAGED_DIR_DARWIN = '/Library/Application Support/ClaudeCode';
const MANAGED_PREFS_DARWIN = '/Library/Managed Preferences';
const MANAGED_PLIST = 'com.anthropic.claudecode.plist';

/** Katalog pozycji z claude.ai pod `plugins/` i `skills/` użytkownika. */
const SYNCED_DIR = DISK_LAYOUT.synced.dir;

/** Katalogi agentów, skilli i komend (dokumentacja Claude Code: sub-agents, skills, slash commands). */
const DEFINITION_DIRS = ['agents', DISK_LAYOUT.skillsDir, DISK_LAYOUT.commandsDir] as const;

/** Katalog znaczników procesów używających wersji wtyczki (zmienia się przy każdym starcie sesji, hooków nie ma). */
const PLUGIN_IN_USE_DIR = '.in_use';

/** Sufit dowiązań na jednej ścieżce (`MAXSYMLINKS` macOS); więcej = pętla. */
const MAX_LINK_HOPS = 32;

/**
 * Rejestr marketplace'ów użytkownika, katalog ich kopii z gita i plik marketplace'u w `.claude-plugin/`
 * (dokumentacja Claude Code: plugins/loading, „Check which stage a plugin reached”; plugins/marketplace-reference).
 */
const KNOWN_MARKETPLACES = 'known_marketplaces.json';
const MARKETPLACES_DIR = 'marketplaces';
const MARKETPLACE_FILE = 'marketplace.json';

/**
 * Rodzaje źródła marketplace'u, które lista umie przeczytać (dokumentacja plugins/marketplace-reference, pole `path`
 * źródła): kopia repozytorium w `plugins/marketplaces/<nazwa>` albo katalog lub plik czytany w miejscu.
 */
const MARKETPLACE_SOURCES: Readonly<Record<string, 'copy' | 'directory' | 'file'>> = {
  github: 'copy',
  git: 'copy',
  directory: 'directory',
  file: 'file',
};

/** Linked worktree gita: plik `.git` z jedną linią `gitdir: <katalog>`, a w tym katalogu `commondir`. */
const GIT_FILE_PREFIX = 'gitdir: ';
const GIT_COMMONDIR = 'commondir';

/** Stan wpisu bez podążania za dowiązaniem (`lstat`): rodzaj i najpóźniejsza zmiana (`ctime`, `mtime`). */
export interface HookListStat {
  readonly kind: 'file' | 'dir' | 'link' | 'other';
  readonly size: number;
  readonly changedAt: number;
}

/** Proces sesji z `ps`: wiek w sekundach i argumenty. */
export interface HookListProcess {
  readonly elapsedS: number;
  readonly args: string;
}

/** Dysk i `ps` listy; testy podmieniają. `null` = brak pliku; inny błąd leci wyjątkiem. */
export interface HookListIo {
  /** Wpis bez podążania za ostatnim składnikiem; składniki wcześniejsze lista podaje już rozwiązane. */
  lstat(file: string): Promise<HookListStat | null>;
  /** Cel dowiązania tak, jak zapisany: bezwzględny albo względny wobec katalogu dowiązania. */
  readlink(file: string): Promise<string>;
  readFile(file: string): Promise<string | null>;
  readdir(dir: string): Promise<string[] | null>;
  ps(pid: number): Promise<HookListProcess | null>;
}

/** Wpis rejestru CLI sesji: pid i `startedAt` (ms epoki). */
export interface HookListSessionEntry {
  readonly pid: number;
  readonly startedAt?: number;
}

export interface HookListInput {
  readonly sessionId: string;
  readonly home: string;
  /** Komendy hooka Raroga przyjęte na `PermissionRequest`. */
  readonly accepted: readonly string[];
  readonly entry: HookListSessionEntry | null;
  /** `cwd` próśb (z zrzutów hooka). */
  readonly cwds: readonly string[];
  readonly platform: NodeJS.Platform;
  /** Chwila przed `ps` (ms epoki). */
  readonly now: number;
}

/** Werdykt listy: `ok` albo powód braku dowodu (bez treści plików). */
export type HookListVerdict = { readonly ok: true } | { readonly ok: false; readonly why: string };

class HookListNoProof extends Error {}

/** Argumenty procesu sesji ważne dla listy. */
export interface ClaudeArgs {
  readonly settings: readonly ({ readonly kind: 'file'; readonly path: string } | { readonly kind: 'inline'; readonly json: unknown })[];
  /**
   * `--setting-sources` gdziekolwiek w argumentach, także w tekście promptu. Warstw nie zawęża; znaczy tylko, że CLI
   * mogło nie załadować warstwy użytkownika, więc jej `false` w `enabledPlugins` wtyczki nie wyłącza.
   */
  readonly settingSources: boolean;
}

/**
 * Argumenty procesu z `ps -o args=` albo powód braku dowodu. `ps` skleja argumenty spacją, więc granice giną: tekst
 * promptu podanego w argumencie wygląda jak flagi. Dlatego z argumentów idzie tylko to, co dokłada pliki do
 * sprawdzenia albo zabiera dowód: flaga blokująca w każdym słowie (także w wartości innej flagi i w prompcie) = brak
 * dowodu, `--settings` dokłada warstwę (wartość niejednoznaczna: ścieżka ze spacją, względna, JSON bez domknięcia =
 * brak dowodu), a `--setting-sources` jest tylko odnotowane ({@link ClaudeArgs.settingSources}); jego wartość nie
 * zawęża warstw, ale brak wartości albo źródło spoza listy dalej zabiera dowód (słowo po fladze, np. `--settings`, nie
 * staje się wtedy warstwą ładowaną na pewno).
 */
export function parseClaudeArgs(args: string): ClaudeArgs | { readonly why: string } {
  const words = args.split(' ');
  for (const word of words.slice(1)) {
    const flag = word.startsWith('--') && word.includes('=') ? word.slice(0, word.indexOf('=')) : word;
    if ((BLOCKED_FLAGS as readonly string[]).includes(flag)) return { why: `arg:${flag}` };
  }
  const settings: ClaudeArgs['settings'][number][] = [];
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] ?? '';
    const [flag, inlineValue] = word.startsWith('--') && word.includes('=')
      ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined];
    if (flag === SETTING_SOURCES_FLAG) {
      const value = inlineValue ?? words[i + 1];
      if (inlineValue === undefined) i += 1;
      const known = (one: string): boolean => one === '' || (SETTING_SOURCES as readonly string[]).includes(one);
      if (value === undefined || !value.split(',').every(known)) return { why: `arg:${SETTING_SOURCES_FLAG}` };
      continue;
    }
    if (flag !== '--settings') continue;
    const rest = inlineValue !== undefined ? [inlineValue, ...words.slice(i + 1)] : words.slice(i + 1);
    const first = rest[0];
    if (first === undefined || first === '') return { why: 'arg:--settings' };
    if (first.startsWith('{')) {
      // JSON w argumencie: najkrótszy przedrostek, który jest obiektem JSON i po którym jest koniec albo spacja.
      let parsed: { json: unknown; words: number } | null = null;
      for (let n = 1; n <= rest.length && parsed === null; n += 1) {
        const candidate = rest.slice(0, n).join(' ');
        try {
          const json = JSON.parse(candidate) as unknown;
          if (json !== null && typeof json === 'object' && !Array.isArray(json)) parsed = { json, words: n };
        } catch {
          // jeszcze nie domknięty
        }
      }
      if (parsed === null) return { why: 'arg:--settings' };
      settings.push({ kind: 'inline', json: parsed.json });
      i += (inlineValue !== undefined ? 0 : 1) + parsed.words - 1;
      continue;
    }
    const next = rest[1];
    if (!path.isAbsolute(first) || (next !== undefined && !next.startsWith('-'))) return { why: 'arg:--settings' };
    settings.push({ kind: 'file', path: first });
    if (inlineValue === undefined) i += 1;
  }
  return { settings, settingSources: args.includes(SETTING_SOURCES_FLAG) };
}

/**
 * Pierwsza linia YAML (od 1, liczona po każdym końcu linii YAML, {@link YAML_LINE_BREAK}) nagłówka pliku, w której
 * nazwa zdarzenia mogłaby powstać bez dosłownego słowa, albo `null`. Nagłówek: od `---` na początku pliku (przed nim
 * wolno BOM i białe znaki) do następnej linii (po `\n`) równej dokładnie `---`, a bez takiej linii cały tekst;
 * zamknięcie liczone ściśle, więc odcinek nie bywa krótszy niż nagłówek CLI. Liczy się ukośnik spoza par `\"`, `\\`
 * i `\n` czytanych od lewej ({@link hasUnsafeBackslash}): inna ucieczka może dać literę (`\x`, `\u`, `\U`), a ukośnik
 * przed końcem linii YAML (także samotnym CR, NEL, LS albo PS) skleja słowo; do tego jawny tag ({@link YAML_TAG})
 * i linia otwarcia z czymś po `---` (nagłówek w innym języku, np. `---js`). Bez parsera YAML nie widać, czy ukośnik
 * stoi w napisie w cudzysłowie, więc reguła zakłada, że stoi; kotwice, aliasy i klucze złożone nie tworzą słowa
 * (węzeł, do którego prowadzą, jest zapisany w tym samym nagłówku).
 */
export function frontmatterEscapeLine(text: string): number | null {
  const lead = /^[\s\u0085]*/.exec(text)?.[0] ?? '';
  if (!text.startsWith('---', lead.length)) return null;
  const first = lead.split(YAML_LINE_BREAK).length;
  const rows = text.slice(lead.length).split('\n');
  if ((rows[0] ?? '').slice(3).trim() !== '') return first;
  const close = rows.findIndex((row, i) => i > 0 && row === '---');
  const region = (close < 0 ? rows : rows.slice(0, close)).join('\n');
  for (const [i, line] of region.split(YAML_LINE_BREAK).entries()) {
    if (hasUnsafeBackslash(line) || YAML_TAG.test(line)) return first + i;
  }
  return null;
}

/** Czy wartość JSON (klucz albo napis na dowolnej głębokości) niesie nazwę zdarzenia `PermissionRequest`. */
function mentionsEvent(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'string') return value === HOOK_PERMISSION_EVENT;
  if (Array.isArray(value)) return value.some((one) => mentionsEvent(one, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, one]) => key === HOOK_PERMISSION_EVENT || mentionsEvent(one, depth + 1));
  }
  return false;
}

/** Wpisy `PermissionRequest` warstwy: tylko komendy z `accepted`; inaczej powód. */
function foreignHookOf(layer: Record<string, unknown>, accepted: readonly string[]): string | null {
  const hooks = layer['hooks'];
  if (hooks === undefined) return null;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return 'hooks-shape';
  const groups = (hooks as Record<string, unknown>)[HOOK_PERMISSION_EVENT];
  if (groups === undefined) return null;
  if (!Array.isArray(groups)) return 'hooks-shape';
  for (const group of groups) {
    if (group === null || typeof group !== 'object' || Array.isArray(group)) return 'hooks-shape';
    const handlers = (group as Record<string, unknown>)['hooks'];
    if (!Array.isArray(handlers)) return 'hooks-shape';
    for (const handler of handlers) {
      if (handler === null || typeof handler !== 'object' || Array.isArray(handler)) return 'hooks-shape';
      const h = handler as Record<string, unknown>;
      const args = h['args'];
      const command = h['command'];
      if (h['type'] !== 'command' || typeof command !== 'string' || !accepted.includes(command)) return 'foreign';
      if (args !== undefined && !(Array.isArray(args) && args.length === 0)) return 'foreign';
    }
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Obiekt JSON z treści pliku albo `null` (brak pliku); nie-JSON i nie-obiekt = brak dowodu. */
function objectOf(file: string, text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new HookListNoProof(`unparseable:${file}`);
  }
  if (!isRecord(value)) throw new HookListNoProof(`unparseable:${file}`);
  return value;
}

/** Ścieżka po rozwiązaniu: wpis docelowy (`null` = brak) i najpóźniej zmienione dowiązanie po drodze. */
interface Resolved {
  /** Ścieżka fizyczna: bez dowiązań, `.` i `..`. */
  readonly real: string;
  readonly info: HookListStat | null;
  /** Najpóźniejsza zmiana dowiązania po drodze (`-Infinity` bez dowiązań) i to dowiązanie. */
  readonly linkAt: number;
  readonly link: string;
}

/** Ścieżka z wpisem docelowym. */
type Present = Resolved & { readonly info: HookListStat };

/** Wpis ścieżki bez podążania za dowiązaniem i cel dowiązania. */
interface PathEntry {
  readonly info: HookListStat | null;
  readonly target: string | null;
}

/** Odczyt jednej sesji: pliki z chwilą zmiany sprawdzaną wobec startu procesu i budżet drzew. */
class Reader {
  files = 0;
  bytes = 0;
  dirs = 0;
  /** `lstat` i `readlink` każdej ścieżki raz na werdykt. */
  private readonly entries = new Map<string, Promise<PathEntry>>();
  constructor(private readonly io: HookListIo, private readonly startLow: number) {}

  private entry(file: string): Promise<PathEntry> {
    let found = this.entries.get(file);
    if (found === undefined) {
      found = this.io.lstat(file).then(async (info) => ({
        info, target: info?.kind === 'link' ? await this.io.readlink(file) : null,
      }));
      this.entries.set(file, found);
    }
    return found;
  }

  /**
   * Fizyczne rozwiązanie ścieżki składnik po składniku, jak robi to jądro: cel dowiązania wraca na początek kolejki
   * (bezwzględny od `/`, względny od katalogu dowiązania), `..` cofa się po katalogu już rozwiązanym. Każde
   * dowiązanie po drodze wnosi swoją chwilę zmiany; katalogi pośrednie nie (zmieniają się przy każdym pliku obok).
   */
  async resolve(file: string): Promise<Resolved> {
    if (!path.isAbsolute(file)) throw new HookListNoProof(`path:${file}`);
    const queue = file.split('/');
    let real = '/';
    let hops = 0;
    let linkAt = -Infinity;
    let link = '';
    while (queue.length > 0) {
      const name = queue.shift() ?? '';
      if (name === '' || name === '.') continue;
      if (name === '..') {
        real = path.dirname(real);
        continue;
      }
      const next = path.join(real, name);
      const found = await this.entry(next);
      if (found.info === null) return { real: next, info: null, linkAt, link };
      if (found.info.kind === 'link') {
        hops += 1;
        if (hops > MAX_LINK_HOPS || found.target === null || found.target === '') {
          throw new HookListNoProof(`loop:${file}`);
        }
        if (found.info.changedAt > linkAt) {
          linkAt = found.info.changedAt;
          link = next;
        }
        if (path.isAbsolute(found.target)) real = '/';
        queue.unshift(...found.target.split('/'));
        continue;
      }
      // Ukośnik po nie-katalogu, także końcowy (`plik/`): brak wpisu (ENOTDIR), jak w jądrze.
      if (found.info.kind !== 'dir' && queue.length > 0) return { real: next, info: null, linkAt, link };
      real = next;
    }
    return { real, info: (await this.entry(real)).info, linkAt, link };
  }

  /** Rozwiązanie z każdym dowiązaniem po drodze sprzed startu procesu (chwili samego wpisu nie sprawdza). */
  async linked(file: string): Promise<Resolved> {
    const found = await this.resolve(file);
    if (found.linkAt >= this.startLow) throw new HookListNoProof(`changed:${found.link}`);
    return found;
  }

  /** Stan ścieżki; zmiana dowiązania po drodze albo samego wpisu nie przed startem procesu = brak dowodu. */
  async stable(file: string): Promise<Present | null> {
    const found = await this.linked(file);
    if (found.info === null) return null;
    if (found.info.changedAt >= this.startLow) throw new HookListNoProof(`changed:${file}`);
    return { ...found, info: found.info };
  }

  async text(file: string): Promise<string | null> {
    const found = await this.stable(file);
    return found === null ? null : this.read(file, found);
  }

  /** Treść pliku w budżecie, czytana po ścieżce fizycznej; `file` tylko do powodu. */
  private async read(file: string, found: Present): Promise<string | null> {
    if (found.info.kind !== 'file') throw new HookListNoProof(`not-file:${file}`);
    this.files += 1;
    this.bytes += found.info.size;
    if (found.info.size > HOOK_LIST_MAX_FILE_BYTES || this.files > HOOK_LIST_MAX_FILES
      || this.bytes > HOOK_LIST_MAX_TOTAL_BYTES) throw new HookListNoProof(`budget:${file}`);
    return this.io.readFile(found.real);
  }

  /** Warstwa ustawień JSON: obiekt albo `null` (brak pliku). */
  async layer(file: string): Promise<Record<string, unknown> | null> {
    return objectOf(file, await this.text(file));
  }

  /**
   * Plik rozliczeniowy (opis modułu): obiekt JSON bez sprawdzenia startu samego pliku albo `null` (brak pliku);
   * dowiązania po drodze sprawdzone jak wszędzie.
   */
  async bookkeeping(file: string): Promise<Record<string, unknown> | null> {
    const found = await this.linked(file);
    return found.info === null ? null : objectOf(file, await this.read(file, { ...found, info: found.info }));
  }

  /**
   * Drzewo: każdy plik bez słowa `PermissionRequest` (pliki `.json` także po parsowaniu, z ucieczkami; inne bez zapisu
   * w nagłówku YAML, który mógłby je dać, {@link frontmatterEscapeLine}), każdy katalog i każde dowiązanie stabilne.
   * Rozszerzenie `.json` bez względu na wielkość liter: APFS ich nie rozróżnia, więc CLI szukające `hooks.json` czyta
   * też `hooks.JSON`. `skip` = nazwy pomijane w każdym katalogu; `parents` = ścieżki fizyczne katalogów nad bieżącym
   * (dowiązanie do któregoś z nich = pętla).
   */
  async tree(root: string, skip: readonly string[] = [], parents: readonly string[] = []): Promise<void> {
    const found = await this.stable(root);
    if (found === null) return;
    if (found.info.kind === 'file') {
      const text = await this.read(root, found);
      if (text === null) return;
      if (text.includes(HOOK_PERMISSION_EVENT)) throw new HookListNoProof(`hook-in:${root}`);
      if (root.toLowerCase().endsWith('.json')) {
        let value: unknown = null;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          value = null;
        }
        if (mentionsEvent(value)) throw new HookListNoProof(`hook-in:${root}`);
      } else if (frontmatterEscapeLine(text) !== null) {
        throw new HookListNoProof(`hook-escape:${root}`);
      }
      return;
    }
    if (found.info.kind !== 'dir') throw new HookListNoProof(`not-file:${root}`);
    if (parents.includes(found.real)) throw new HookListNoProof(`loop:${root}`);
    this.dirs += 1;
    if (this.dirs > HOOK_LIST_MAX_FILES) throw new HookListNoProof(`budget:${root}`);
    const names = await this.io.readdir(found.real);
    if (names === null) return;
    for (const name of names.sort()) {
      if (skip.includes(name)) continue;
      await this.tree(path.join(root, name), skip, [...parents, found.real]);
    }
  }
}

/** Warstwa ustawień: `certain` opisane przy {@link collect}. */
interface Layer {
  readonly name: string;
  readonly value: Record<string, unknown>;
  readonly certain: boolean;
}

/** Katalog i wszystkie wyżej, od niego do korzenia. */
function upwards(dir: string): string[] {
  const out: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/** Werdykt listy hooków jednej sesji z jednego odczytu (opis modułu). */
export async function sessionHookVerdict(input: HookListInput, io: HookListIo): Promise<HookListVerdict> {
  try {
    await collect(input, io);
    return { ok: true };
  } catch (err) {
    if (err instanceof HookListNoProof) return { ok: false, why: err.message };
    const code = (err as { code?: unknown }).code;
    return { ok: false, why: `io:${typeof code === 'string' ? code : 'error'}` };
  }
}

async function collect(input: HookListInput, io: HookListIo): Promise<void> {
  if (input.platform !== 'darwin') throw new HookListNoProof('platform');
  const entry = input.entry;
  if (entry === null) throw new HookListNoProof('no-registry-entry');
  if (entry.startedAt === undefined) throw new HookListNoProof('no-registry-start');
  const proc = await io.ps(entry.pid);
  if (proc === null) throw new HookListNoProof('no-process');
  // Start procesu z dokładnością `etime`: przedział [startLow, startHigh].
  const startHigh = input.now - proc.elapsedS * 1_000;
  const startLow = startHigh - HOOK_LIST_START_SLACK_MS;
  if (entry.startedAt < startLow || entry.startedAt > startHigh + HOOK_LIST_REGISTRY_START_MAX_MS) {
    throw new HookListNoProof('process-start');
  }
  const args = parseClaudeArgs(proc.args);
  if ('why' in args) throw new HookListNoProof(args.why);
  const reader = new Reader(io, startLow);
  const claude = path.join(input.home, DISK_LAYOUT.configDir);

  // Plik rejestru sesji: `cwd` sesji i ta sama sesja pod tym pidem. CLI przepisuje go w trakcie życia procesu (pola
  // `status` i `updatedAt`, CLI 2.1.321), więc jego zmiana nie jest zmianą hooków i nie przechodzi przez sprawdzenie
  // startu.
  const registryText = await io.readFile(path.join(claude, 'sessions', `${entry.pid}.json`));
  let registryFile: unknown = null;
  try {
    registryFile = registryText === null ? null : JSON.parse(registryText) as unknown;
  } catch {
    registryFile = null;
  }
  const registryRecord = registryFile !== null && typeof registryFile === 'object' && !Array.isArray(registryFile)
    ? registryFile as Record<string, unknown> : null;
  const registryCwd = registryRecord?.['cwd'];
  if (registryRecord?.['sessionId'] !== input.sessionId || typeof registryCwd !== 'string') {
    throw new HookListNoProof('registry-file');
  }
  const cwds = [...new Set([registryCwd, ...input.cwds])];
  if (cwds.some((cwd) => !path.isAbsolute(cwd))) throw new HookListNoProof('cwd');

  // Hooki i `enabledPlugins` liczą się ze wszystkich warstw (nadzbiór ładowanych: `--setting-sources` z `ps` niczego
  // nie zawęża). `certain`: warstwa ładowana na pewno i bez źródła, które by ją wyłączyło (jej `false`
  // w `enabledPlugins` wyłącza wtyczkę): `--settings` i `settings.json` użytkownika, gdy argumenty nigdzie nie mają
  // `--setting-sources`.
  const layers: Layer[] = [];
  const addLayer = async (name: string, file: string, certain = false): Promise<void> => {
    const value = await reader.layer(file);
    if (value !== null) layers.push({ name, value, certain });
  };

  // Managed (macOS): preferencje MDM (systemowe i per użytkownik) = brak dowodu; pliki, katalog dopisków, kopia
  // z serwera.
  for (const name of await io.readdir(MANAGED_PREFS_DARWIN) ?? []) {
    if (name === MANAGED_PLIST) throw new HookListNoProof('managed-plist');
    const sub = await io.readdir(path.join(MANAGED_PREFS_DARWIN, name));
    if (sub?.includes(MANAGED_PLIST) === true) throw new HookListNoProof('managed-plist');
  }
  await addLayer('managed', path.join(MANAGED_DIR_DARWIN, 'managed-settings.json'));
  const dropIns = await io.readdir(path.join(MANAGED_DIR_DARWIN, 'managed-settings.d'));
  for (const name of (dropIns ?? []).sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    await addLayer('managed', path.join(MANAGED_DIR_DARWIN, 'managed-settings.d', name));
  }
  const managedRest = await io.readdir(MANAGED_DIR_DARWIN);
  for (const name of (managedRest ?? []).sort()) {
    if (name === 'managed-settings.json' || name === 'managed-settings.d') continue;
    await reader.tree(path.join(MANAGED_DIR_DARWIN, name));
  }
  await addLayer('managed', path.join(claude, 'remote-settings.json'));

  // `--settings`.
  for (const one of args.settings) {
    if (one.kind === 'inline') {
      layers.push({ name: 'flag', value: one.json as Record<string, unknown>, certain: true });
    } else {
      const value = await reader.layer(one.path);
      if (value === null) throw new HookListNoProof('settings-file');
      layers.push({ name: 'flag', value, certain: true });
    }
  }

  // Użytkownik, projekt, local; `cwd` w linked worktree dokłada główny checkout (opis modułu).
  await addLayer('user', path.join(claude, DISK_LAYOUT.settings), !args.settingSources);
  await addLayer('user', path.join(claude, DISK_LAYOUT.localSettings));
  const projectDirs = new Set<string>();
  const localDirs = new Set<string>();
  for (const cwd of cwds) {
    const main = await mainCheckoutOf(reader, cwd);
    for (const root of main === null ? [cwd] : [cwd, main]) {
      projectDirs.add(path.resolve(root));
      for (const dir of upwards(root)) localDirs.add(dir);
    }
  }
  for (const dir of [...projectDirs].sort()) {
    await addLayer('project', path.join(dir, DISK_LAYOUT.configDir, DISK_LAYOUT.settings));
  }
  for (const dir of [...localDirs].sort()) {
    await addLayer('local', path.join(dir, DISK_LAYOUT.configDir, DISK_LAYOUT.localSettings));
  }

  for (const layer of layers) {
    const foreign = foreignHookOf(layer.value, input.accepted);
    if (foreign !== null) throw new HookListNoProof(`${foreign}:${layer.name}`);
  }

  // Wtyczki (opis modułu): `enabledPlugins` ze wszystkich warstw; drzewo każdej wersji z wpisu instalacji, wpis
  // marketplace'u i katalog źródłowy wtyczki ładowanej w miejscu.
  const enabled = new Map<string, { on: boolean; off: boolean }>();
  for (const layer of layers) {
    const said = layer.value[DISK_LAYOUT.settingsKeys.enabledPlugins];
    if (said === undefined) continue;
    if (!isRecord(said)) throw new HookListNoProof('enabled-plugins');
    for (const [id, value] of Object.entries(said)) {
      const one = enabled.get(id) ?? { on: false, off: false };
      if (value !== false) one.on = true;
      else if (layer.certain) one.off = true;
      enabled.set(id, one);
    }
  }
  const plugins = path.join(claude, DISK_LAYOUT.plugins.dir);
  const installed = await reader.layer(path.join(plugins, DISK_LAYOUT.plugins.installed));
  const records = installed === null ? {} : installed['plugins'];
  if (!isRecord(records)) throw new HookListNoProof('installed-plugins');
  for (const [id, one] of enabled) {
    if (one.on && !(id in records)) throw new HookListNoProof(`plugin-unknown:${id}`);
  }
  let markets: Promise<Record<string, unknown>> | null = null;
  const marketplaces = (): Promise<Record<string, unknown>> => {
    markets ??= reader.bookkeeping(path.join(plugins, KNOWN_MARKETPLACES)).then((value) => value ?? {});
    return markets;
  };
  for (const [id, list] of Object.entries(records)) {
    const said = enabled.get(id);
    if (said !== undefined && said.off && !said.on) continue;
    if (!Array.isArray(list)) throw new HookListNoProof('installed-plugins');
    for (const one of list) {
      const installPath = (one as Record<string, unknown> | null)?.['installPath'];
      if (typeof installPath !== 'string' || !path.isAbsolute(installPath)) throw new HookListNoProof('installed-plugins');
      if (await reader.stable(installPath) === null) throw new HookListNoProof(`plugin-missing:${id}`);
      await reader.tree(installPath, [PLUGIN_IN_USE_DIR]);
    }
    await checkMarketplaceEntry(reader, { plugins, id, marketplaces, startLow });
  }
  await syncedTrees(io, reader, path.join(plugins, SYNCED_DIR));

  // Agenci, skille, komendy użytkownika i projektu (`cwd` i wyżej); skille z claude.ai w `skills/synced/`.
  const definitionRoots = new Set([claude, ...[...localDirs].map((dir) => path.join(dir, DISK_LAYOUT.configDir))]);
  for (const root of [...definitionRoots].sort()) {
    for (const name of DEFINITION_DIRS) {
      const skip = root === claude && name === DISK_LAYOUT.skillsDir ? [SYNCED_DIR] : [];
      await reader.tree(path.join(root, name), skip);
    }
  }
  await syncedTrees(io, reader, path.join(claude, DISK_LAYOUT.skillsDir, SYNCED_DIR));
}

/**
 * Wtyczki i skille z claude.ai: `synced/<koszyk>/<pozycja>/`. Katalog `synced`, koszyk i pliki koszyka
 * (`manifest.json`, `.last-complete-round`, `*.meta.json`) to zapis synchronizacji przepisywany co rundę, więc nie
 * przechodzą przez sprawdzenie startu; pliki koszyka tylko przez szukanie słowa `PermissionRequest`. Każda pozycja
 * (katalog) przechodzi przez oba, a dowiązania po drodze do koszyka i jego plików przez sprawdzenie startu.
 */
async function syncedTrees(io: HookListIo, reader: Reader, root: string): Promise<void> {
  for (const bucket of (await io.readdir(root) ?? []).sort()) {
    const bucketDir = await reader.linked(path.join(root, bucket));
    if (bucketDir.info?.kind !== 'dir') continue;
    for (const name of (await io.readdir(bucketDir.real) ?? []).sort()) {
      const entry = path.join(root, bucket, name);
      const found = await reader.linked(entry);
      if (found.info?.kind === 'dir') await reader.tree(entry, [PLUGIN_IN_USE_DIR]);
      else if (found.info?.kind === 'file') {
        const text = await io.readFile(found.real);
        if (text?.includes(HOOK_PERMISSION_EVENT) === true) throw new HookListNoProof(`hook-in:${entry}`);
      }
    }
  }
}

/**
 * Główny checkout dla `cwd` w linked worktree gita albo `null` (opis modułu; dokumentacja Claude Code: settings,
 * „Where Claude Code keeps the local file in a git repository”; worktrees, „What worktrees share with the main
 * checkout”). Najbliższy `.git` od `cwd` w górę: katalog = zwykły checkout (`null`); plik = jedna linia
 * `gitdir: <katalog>` (ścieżka bezwzględna albo względna wobec katalogu pliku), a w tym katalogu `commondir` ze
 * wspólnym katalogiem repozytorium; bez `commondir` to nie worktree (submoduł, `--separate-git-dir`), korzeniem jest
 * katalog z plikiem `.git`. Wspólny katalog musi się nazywać `.git`, główny checkout to katalog nad nim; repozytorium
 * bare, `gitdir` bez katalogu i każdy inny układ = brak dowodu. Odczyt bez uruchamiania `git`; pliki `.git` i
 * `commondir` przechodzą przez sprawdzenie startu, katalogi gita nie (zmieniają się przy każdej operacji gita),
 * dowiązania tak.
 */
async function mainCheckoutOf(reader: Reader, cwd: string): Promise<string | null> {
  for (const dir of upwards(cwd)) {
    const dotGit = path.join(dir, DISK_LAYOUT.gitDir);
    const found = await reader.linked(dotGit);
    if (found.info === null) continue;
    if (found.info.kind === 'dir') return null;
    const lines = (await reader.text(dotGit) ?? '').split('\n').filter((line) => line.trim() !== '');
    const line = lines.length === 1 ? lines[0] ?? '' : '';
    const target = line.startsWith(GIT_FILE_PREFIX) ? line.slice(GIT_FILE_PREFIX.length).trim() : '';
    if (target === '') throw new HookListNoProof(`worktree:${dotGit}`);
    const gitDir = await reader.linked(path.isAbsolute(target) ? target : `${path.dirname(found.real)}/${target}`);
    if (gitDir.info?.kind !== 'dir') throw new HookListNoProof(`worktree:${dotGit}`);
    const common = (await reader.text(path.join(gitDir.real, GIT_COMMONDIR)))?.trim();
    if (common === undefined) return null;
    if (common === '' || common.includes('\n')) throw new HookListNoProof(`worktree:${dotGit}`);
    const commonDir = await reader.linked(path.isAbsolute(common) ? common : `${gitDir.real}/${common}`);
    if (commonDir.info?.kind !== 'dir' || path.basename(commonDir.real) !== DISK_LAYOUT.gitDir) {
      throw new HookListNoProof(`worktree:${dotGit}`);
    }
    return path.dirname(commonDir.real);
  }
  return null;
}

/** Ścieżka względna bez wyjścia w górę (`..`), bez ukośnika wstecznego. */
const relativeInside = (rel: string): boolean =>
  !path.isAbsolute(rel) && !rel.includes('\\') && rel.split('/').every((part) => part !== '..');

/**
 * Katalog wtyczki ze ścieżką względną w marketplace'ie o korzeniu `root` (dokumentacja plugins/marketplace-reference,
 * „Relative path plugin source”): `.` albo `./…` od korzenia, goła nazwa pod `metadata.pluginRoot`; inny zapis
 * (wyjście w górę, nazwa bez `pluginRoot`) = `null`.
 */
function inPlaceDir(root: string, source: string, catalog: Record<string, unknown>): string | null {
  if (source === '.' || source === './') return root;
  if (source.startsWith('./')) return relativeInside(source) ? path.resolve(root, source) : null;
  if (source === '' || source === '..' || source.includes('/') || source.includes('\\')) return null;
  const metadata = catalog['metadata'];
  const pluginRoot = isRecord(metadata) ? metadata['pluginRoot'] : undefined;
  return typeof pluginRoot === 'string' && relativeInside(pluginRoot) ? path.resolve(root, pluginRoot, source) : null;
}

/**
 * Wpis włączonej wtyczki `<nazwa>@<marketplace>` w pliku jej marketplace'u (dokumentacja Claude Code:
 * plugins-reference, „How entry fields combine with plugin.json”: hooki wpisu zastępują albo uzupełniają hooki
 * manifestu, a bez `plugin.json` wpis jest manifestem bez względu na `strict`). Wpis ze słowem `PermissionRequest`
 * = obcy hook. Rekord marketplace'u z `known_marketplaces.json` (plik rozliczeniowy, opis modułu):
 *
 * - `github`, `git`: kopia w `<plugins>/marketplaces/<nazwa>` (`installLocation`), plik pod `path` źródła albo
 *   `.claude-plugin/marketplace.json`; wtyczka ładuje się z kopii w cache, którą lista już przeszła;
 * - `directory`, `file`: plik czytany w miejscu (`installLocation` = `path` źródła, `lastUpdated` sprzed startu
 *   sesji), a wtyczka ze ścieżką względną ładuje się w miejscu (dokumentacja plugins/loading, „In-place and copied
 *   plugins”), więc jej katalog źródłowy przechodzi przez to samo drzewo co kopia;
 * - inne źródło (`url`, `npm`, `settings`), brak rekordu, pliku albo dokładnie jednego wpisu o tej nazwie = brak
 *   dowodu.
 */
async function checkMarketplaceEntry(reader: Reader, ctx: {
  readonly plugins: string;
  readonly id: string;
  readonly marketplaces: () => Promise<Record<string, unknown>>;
  readonly startLow: number;
}): Promise<void> {
  const { plugins, id, startLow } = ctx;
  const at = id.indexOf('@');
  if (at <= 0 || at !== id.lastIndexOf('@') || at === id.length - 1) throw new HookListNoProof(`plugin-id:${id}`);
  const name = id.slice(0, at);
  const market = id.slice(at + 1);
  const record = (await ctx.marketplaces())[market];
  if (record === undefined) throw new HookListNoProof(`marketplace-unknown:${market}`);
  const source = isRecord(record) ? record['source'] : undefined;
  const location = isRecord(record) ? record['installLocation'] : undefined;
  if (!isRecord(record) || !isRecord(source) || typeof location !== 'string' || !path.isAbsolute(location)) {
    throw new HookListNoProof(`marketplace-source:${market}`);
  }
  const type = source['source'];
  const kind = typeof type === 'string' && Object.hasOwn(MARKETPLACE_SOURCES, type) ? MARKETPLACE_SOURCES[type] : null;
  const defaultFile = path.join(DISK_LAYOUT.plugins.manifestDir, MARKETPLACE_FILE);
  let catalogFile: string;
  let localRoot: string | null = null;
  if (kind === 'copy') {
    const inRepo = source['path'] ?? defaultFile;
    if (path.dirname(location) !== path.join(plugins, MARKETPLACES_DIR) || typeof inRepo !== 'string'
      || !relativeInside(inRepo)) throw new HookListNoProof(`marketplace-source:${market}`);
    catalogFile = path.join(location, inRepo);
  } else if (kind === 'directory' || kind === 'file') {
    if (source['path'] !== location) throw new HookListNoProof(`marketplace-source:${market}`);
    const updated = typeof record['lastUpdated'] === 'string' ? Date.parse(record['lastUpdated']) : Number.NaN;
    if (!Number.isFinite(updated) || updated >= startLow) throw new HookListNoProof(`marketplace-changed:${market}`);
    // `file`: sam plik marketplace'u, korzeń dwa katalogi wyżej (`<korzeń>/.claude-plugin/marketplace.json`).
    catalogFile = kind === 'directory' ? path.join(location, defaultFile) : location;
    localRoot = kind === 'directory' ? location : path.dirname(path.dirname(location));
  } else {
    throw new HookListNoProof(`marketplace-source:${market}`);
  }
  const catalog = await reader.layer(catalogFile);
  if (catalog === null) throw new HookListNoProof(`marketplace-missing:${market}`);
  const list = catalog['plugins'];
  const entries = Array.isArray(list) ? list.filter((one) => isRecord(one) && one['name'] === name) : [];
  const entry = entries.length === 1 ? entries[0] : undefined;
  if (!isRecord(entry)) throw new HookListNoProof(`marketplace-entry:${id}`);
  if (mentionsEvent(entry)) throw new HookListNoProof(`hook-in:${catalogFile}`);
  const from = entry['source'];
  if (localRoot === null || typeof from !== 'string') return;
  const dir = inPlaceDir(localRoot, from, catalog);
  if (dir === null) throw new HookListNoProof(`marketplace-entry:${id}`);
  if (await reader.stable(dir) === null) throw new HookListNoProof(`plugin-missing:${id}`);
  await reader.tree(dir, [PLUGIN_IN_USE_DIR]);
}

/** `null` = brak pliku albo katalogu; inny błąd leci dalej. */
function absent(err: unknown): null {
  if ((err as { code?: unknown }).code === 'ENOENT' || (err as { code?: unknown }).code === 'ENOTDIR') return null;
  throw err;
}

export const nodeHookListIo: HookListIo = {
  async lstat(file) {
    const info = await fs.lstat(file).catch(absent);
    if (info === null) return null;
    const kind = info.isSymbolicLink() ? 'link' : info.isFile() ? 'file' : info.isDirectory() ? 'dir' : 'other';
    return { kind, size: info.size, changedAt: Math.max(info.ctimeMs, info.mtimeMs) };
  },
  readlink: (file) => fs.readlink(file),
  // Odczyt przez `safe-read.ts`: FIFO albo urządzenie pod nazwą pliku ustawień nie zawiesza serwera. Nie-plik
  // i plik ponad sufit to błąd z kodem, więc lista daje „brak dowodu”, a nie pustą warstwę.
  async readFile(file) {
    let read: Awaited<ReturnType<typeof readRegularFile>>;
    try {
      read = await readRegularFile(file, { maxBytes: HOOK_LIST_MAX_FILE_BYTES, followSymlink: true });
    } catch (err) {
      return absent(err);
    }
    if (read === null) throw Object.assign(new Error(`not a regular file: ${file}`), { code: 'EFTYPE' });
    if (read.truncated) throw Object.assign(new Error(`over the read ceiling: ${file}`), { code: 'EFBIG' });
    return read.bytes.toString('utf8');
  },
  readdir: (dir) => fs.readdir(dir).catch(absent),
  ps: (pid) => new Promise((resolve) => {
    execFile(PS_PATH, ['-ww', '-o', 'etime=,args=', '-p', String(pid)], {
      timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL', env: { LC_ALL: 'C' }, maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err !== null) {
        resolve(null);
        return;
      }
      const line = String(stdout).replace(/\n$/, '').trimStart();
      const cut = line.indexOf(' ');
      const elapsedS = cut < 0 ? null : parseElapsed(line.slice(0, cut));
      resolve(elapsedS === null || line.includes('\n') ? null : { elapsedS, args: line.slice(cut + 1) });
    });
  }),
};

export interface SessionHookListOptions {
  readonly home: string;
  readonly accepted: readonly string[];
  /** Wpis rejestru CLI sesji (jeden żywy proces) albo `null`. */
  readonly entry: (sessionId: string) => Promise<HookListSessionEntry | null>;
  readonly io?: HookListIo;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  /** Werdykt sesji przy zmianie (dziennik). */
  readonly onVerdict?: (sessionId: string, verdict: HookListVerdict) => void;
}

/** How long a negative verdict lives before the next read: transient ones shorter ({@link hookListVerdictKind}). */
function retryOf(why: string): number {
  return hookListVerdictKind(why) === 'transient' ? HOOK_LIST_TRANSIENT_RETRY_MS : HOOK_LIST_RETRY_MS;
}

/** The session process a verdict was read for: registry pid and start; `''` without a registry entry. */
function processOf(entry: HookListSessionEntry | null): string {
  return entry === null ? '' : `${String(entry.pid)}@${String(entry.startedAt ?? '')}`;
}

/** Ostatni werdykt sesji: odczyt rozpoczęty w `at`, dla procesu sesji i katalogów próśb. */
interface CachedVerdict {
  readonly at: number;
  readonly proc: string;
  readonly cwds: ReadonlySet<string>;
  readonly verdict: HookListVerdict;
}

/**
 * One hook list answer: the keys and the `why` of the negative verdict they came from (`null` with `ok` and when no
 * verdict holds for the call). Keys and `why` come from one verdict read for the session's current process and covering
 * every `cwd` of the call.
 */
export interface SessionHookAnswer {
  readonly keys: ReadonlySet<string>;
  readonly why: string | null;
}

const NO_ANSWER: SessionHookAnswer = { keys: new Set(), why: null };

/**
 * The session hook list as the source of the hook list check: the keys alone, and the keys with the `why` of the same
 * verdict.
 */
export interface SessionHookList {
  (sessionId: string, dumps: readonly HookCallDump[]): Promise<ReadonlySet<string>>;
  readonly answer: (sessionId: string, dumps: readonly HookCallDump[]) => Promise<SessionHookAnswer>;
}

/**
 * Lista hooków sesji jako źródło dowodu listy hooków w obserwacji (`ConsentSessionHooks` w
 * `dialogs/layer1/observe.ts`): klucze próśb, których hook wystartował nie później niż odczyt z werdyktem `ok` (opis
 * modułu). `answer` adds the reason of a negative verdict; only the desk release keeps it, it never reaches devices.
 *
 * A verdict holds only for the session process it was read for (registry pid and start, asked on every call) and for
 * the `cwd` it was read for: a session restarted under the same id, or a call with a `cwd` the verdict does not cover,
 * reads again, also while another read runs. A read after which the registry names another process answers nothing
 * (no keys, no `why`), because a durable `why` sends the request back to the desk at once.
 */
export function createSessionHookList(options: SessionHookListOptions): SessionHookList {
  const io = options.io ?? nodeHookListIo;
  const clock = options.now ?? Date.now;
  const cache = new Map<string, CachedVerdict>();
  const running = new Map<string, Promise<CachedVerdict | null>>();

  async function compute(
    sessionId: string, entry: HookListSessionEntry | null, cwds: ReadonlySet<string>,
  ): Promise<CachedVerdict | null> {
    const at = clock();
    const verdict = await sessionHookVerdict({
      sessionId, home: options.home, accepted: options.accepted, entry, cwds: [...cwds],
      platform: options.platform ?? process.platform, now: at,
    }, io);
    const proc = processOf(entry);
    if (processOf(await options.entry(sessionId)) !== proc) return null;
    const before = cache.get(sessionId)?.verdict;
    const done: CachedVerdict = { at, proc, cwds, verdict };
    cache.set(sessionId, done);
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(verdict)) {
      options.onVerdict?.(sessionId, verdict);
    }
    return done;
  }

  const answer = async (sessionId: string, dumps: readonly HookCallDump[]): Promise<SessionHookAnswer> => {
    const asked = dumps.filter((dump) => dump.sessionId === sessionId && dump.agentId !== undefined);
    if (asked.length === 0) {
      cache.delete(sessionId);
      return NO_ANSWER;
    }
    const cwds = new Set(asked.map((dump) => dump.cwd));
    const newest = Math.max(...asked.map((dump) => dump.startedAt));
    const entry = await options.entry(sessionId);
    const proc = processOf(entry);
    const cached = cache.get(sessionId);
    // An `ok` over a wider scope holds for a narrower one; a negative verdict may come from a `cwd` this call does not
    // ask about, so it holds only for the very same scope.
    const fresh = cached !== undefined && cached.proc === proc && [...cwds].every((cwd) => cached.cwds.has(cwd))
      && (cached.verdict.ok
        ? cached.at >= newest
        : cached.cwds.size === cwds.size && clock() - cached.at < retryOf(cached.verdict.why));
    let found = fresh ? cached : null;
    if (found === null) {
      // One read per process and scope at a time; a call for another process or `cwd` does not wait for this one.
      const key = JSON.stringify([sessionId, proc, [...cwds].sort()]);
      let job = running.get(key);
      if (job === undefined) {
        job = compute(sessionId, entry, cwds).finally(() => running.delete(key));
        running.set(key, job);
      }
      found = await job;
    }
    if (found === null) return NO_ANSWER;
    if (!found.verdict.ok) return { keys: NO_ANSWER.keys, why: found.verdict.why };
    const at = found.at;
    return { keys: new Set(asked.filter((dump) => dump.startedAt <= at).map((dump) => dump.key)), why: null };
  };
  const list = async (sessionId: string, dumps: readonly HookCallDump[]): Promise<ReadonlySet<string>> =>
    (await answer(sessionId, dumps)).keys;
  return Object.assign(list, { answer });
}
