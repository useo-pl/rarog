/**
 * Na jakim wydaniu Claude Code działa proces sesji, a jakie leży zainstalowane.
 *
 * Terminal pokazuje nad polem promptu `✔ Update installed · Restart to update`: instalator
 * natywny pobiera nowe wydanie w tle i przestawia dowiązanie `~/.local/bin/claude`, ale żywy
 * proces zostaje na starym, dopóki człowiek go nie uruchomi ponownie. Rarog odtwarza ten sam
 * sygnał z DWÓCH odczytów dysku, bez ekranu i bez procesu potomnego:
 *
 * 1. **Wydanie zainstalowane** — cel dowiązania `~/.local/bin/claude`
 *    (`…/versions/<X.Y.Z>`, zmierzone na 2.1.283).
 * 2. **Wydanie działającego procesu** — rejestr procesów CLI `~/.claude/sessions/<pid>.json`
 *    (pola `pid`, `sessionId`, `version`, `status`; ten sam zestaw pól w 2.1.280–2.1.283).
 *    Wyjście `claude agents --json` (`live-sessions.ts`; docs `agent-view.md`, „List sessions
 *    as JSON”) ma `pid`, `status` i `sessionId`, ale pola `version` nie ma,
 *    więc wydanie procesu bierzemy z rejestru. Pole `version` w jsonl sesji do tego NIE służy:
 *    mówi, które wydanie zapisało OSTATNI wpis, a bezczynna wznowiona sesja może go nie zapisać
 *    od tygodni.
 *
 * Ten sam rejestr mówi też, że w sesji STOI DIALOG: CLI 2.1.293 pisze `status: "waiting"` i
 * `waitingFor` (klasa dialogu) w chwili pokazania dialogu i wraca do `busy`/`idle` w chwili
 * odpowiedzi. Manager czyta wtedy rejestr co 1,5 s (`CLI_WAITING_POLL_MS`) tym
 * samym czytnikiem, w tej samej kolejce co migawkę wydań — patrz {@link createCliVersionReader}.
 * Rejestr jest tylko SZTURCHNIĘCIEM drivera: nigdy nie upoważnia do klawisza, cyfry dalej
 * pochodzą z ekranu.
 *
 * Trzecia rzecz z tego samego pliku: KIEDY proces wystartował (`startedAt`).
 * Subagent żyje w procesie CLI, a CLI po wyjściu i `claude --resume` nie zostawia o nim żadnego
 * wpisu w pliku rozmowy (pomiar `resume-cli`, CLI 2.1.296). Czas startu jedynego żywego procesu
 * rozmowy ({@link cliProcessStartOf}) pozwala maszynie stanów zadań w tle zamknąć agenta, który
 * należał do poprzedniego procesu (`herdr/background/reducer.ts`, opis: `docs/background-tasks.md`).
 *
 * Reguły odczytu, te same co przy `~/.claude.json` (reguła 10 „Starting sessions from the phone"
 * w `docs/security-model.md`):
 *
 * - **Snajpersko.** Z rejestru bierzemy SZEŚĆ pól (`pid`, `sessionId`, `version`, `status`,
 *   `waitingFor`, `startedAt`) i nic więcej. Inne pliki katalogu (np. `<pid>.<hash>.key`, prawa `0600`)
 *   nie są nawet otwierane — filtr nazw działa przed jakimkolwiek `stat` i `readFile`.
 * - **Nic nie rzuca.** Brak dowiązania, instalacja z npm, wiszący cel, śmieci w rejestrze,
 *   plik zniknięty w trakcie odczytu — to `null` albo pominięty wpis, czyli „nie wiem",
 *   a klient wtedy MILCZY.
 * - **Zero treści w logu.** Linie są dwie i każda leci raz na życie czytnika: „rejestr CLI:
 *   nieznany kształt" i „rejestr CLI: nieznana klasa dialogu" — żeby zmiana formatu CLI nie
 *   zamieniła się w wieczną, niewidoczną ciszę. Druga cytuje samą nazwę klasy, i to tylko
 *   wtedy, gdy wygląda jak nazwa klasy (krótkie małe słowa), nigdy treść pliku.
 */
import { readdir, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { CliDialogClass } from '@rarog/shared';
import { readRegularFile } from './safe-read.ts';

export type { CliDialogClass };

/** Kształt numeru wydania, jaki CLI pisze w rejestrze i w nazwie katalogu `versions/`. */
const CLI_VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;
/** Nazwa pliku rejestru: sam pid. Wszystko inne (w tym `<pid>.<hash>.key`) odpada. */
const REGISTRY_FILE_RE = /^(\d{1,10})\.json$/;
/** Ten sam kształt uuid co `ENGINE_SESSION_ID_PATTERN` — do rejestru wchodzi tylko uuid. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `status` z rejestru to krótkie słowo (`idle`, `busy`, `shell`); dłuższy tekst = śmieci. */
const STATUS_RE = /^[a-z_-]{1,32}$/;
/** Plik rejestru ma ~550 B; większy nie jest plikiem rejestru, którego kształt znamy. */
export const CLI_REGISTRY_MAX_BYTES = 16 * 1024;

/** `status` procesu, który pokazuje dialog i czeka na człowieka (zmierzone na 2.1.293). */
export const CLI_STATUS_WAITING = 'waiting';

/**
 * Zamknięta lista: wartość `waitingFor` z pliku → klasa Raroga. Typ klasy
 * (`CliDialogClass`) mieszka w `@rarog/shared`, bo jedzie polem `SessionSummary.cliDialog`.
 *
 * Każda wartość ma dowód. Docs `agent-view.md`, „List sessions as JSON”,
 * wymieniają pięć: `permission prompt`, `input needed`, `sandbox request`, `worker request`
 * i `dialog open`. Zmierzone na 2.1.293: `input needed` (każdy wariant
 * `AskUserQuestion`), `permission prompt` (Bash, Edit, Write, MCP, `ExitPlanMode` z planem i bez)
 * i `sandbox request` (sieć sandboksa); `dialog open` przy panelu komendy lokalnej — `/status`
 * (2.1.302) i goły `/goal` (2.1.310, `commands/measured/live-2.1.310.json`).
 * `worker request` zna tylko docs. Każda inna wartość to `other` z linią logu: dialog jest, tylko nie
 * wiemy jaki. Klasa `goal` kontraktu nie ma tu wartości (goły `/goal` dał `dialog open`), więc nie
 * przychodzi; enum i teksty apki zostają.
 */
const WAITING_FOR_CLASSES: ReadonlyMap<string, CliDialogClass> = new Map([
  ['permission prompt', 'permission'],
  ['input needed', 'input'],
  ['sandbox request', 'sandbox'],
  ['worker request', 'worker'],
  ['dialog open', 'dialog'],
]);

/** Nieznaną klasę wolno zacytować w logu tylko wtedy, gdy wygląda jak nazwa klasy. */
const LOGGABLE_CLASS_RE = /^[a-z][a-z ]{0,31}$/;

/** Fraza linii logu o klasie dialogu spoza listy {@link WAITING_FOR_CLASSES} (raz na życie czytnika). */
export const CLI_REGISTRY_UNKNOWN_CLASS_LOG = 'CLI registry: unknown dialog class';
/** Fraza linii logu o rejestrze, z którego nie da się odczytać żadnego wpisu (raz na życie czytnika). */
export const CLI_REGISTRY_UNKNOWN_SHAPE_LOG = 'CLI registry: unknown shape';

/** Jeden żywy proces CLI z rejestru. */
export interface CliRegistryEntry {
  readonly pid: number;
  readonly version: string;
  /**
   * `idle` bez pracy, `busy` w turze, `shell` z powłoką w tle (zmierzone),
   * `waiting` przy stojącym dialogu.
   */
  readonly status: string;
  /**
   * Klasa dialogu — tylko gdy plik niesie `waitingFor`. Znaczy coś wyłącznie razem
   * ze `status: waiting`; przy innym statusie nikt jej nie czyta.
   */
  readonly waitingFor?: CliDialogClass;
  /**
   * Kiedy proces wystartował: milisekundy epoki z pola `startedAt` pliku. Zmierzone
   * na 21 żywych procesach (CLI 2.1.286–2.1.296, wiek od 7 do 233 godzin): liczba
   * całkowita, od 1 do 7 s po starcie procesu z `procStart`, także w procesach, których plik był
   * przepisywany wiele godzin później. Pole nie jest więc przestawiane w trakcie życia procesu.
   * Pole DODATKOWE, jak `waitingFor`: nieobecne, gdy plik go nie niesie albo niesie coś innego
   * niż dodatnią liczbę.
   */
  readonly startedAt?: number;
}

/**
 * `sessionId` → ŻYWE procesy z rejestru. Lista, a nie jeden wpis: dwa pidy z jednym uuid
 * to dwóch pisarzy do jednego jsonl, a tego nie wolno zgubić uśrednieniem.
 */
export type CliRegistry = ReadonlyMap<string, readonly CliRegistryEntry[]>;

/** Wynik jednego odczytu: `null` w polu = „nie wiem". */
export interface CliVersionSnapshot {
  readonly installed: string | null;
  readonly registry: CliRegistry | null;
  /**
   * Numer odczytu w kolejce czytnika — rośnie z każdym odczytem. Wołający, który
   * trzyma wynik u siebie, odrzuca numer niższy od ostatnio przyjętego: starszy odczyt nigdy
   * nie nadpisuje nowszego. Brak pola (atrapy w testach) = bez tej kontroli.
   */
  readonly generation?: number;
  /**
   * Ile ŻYWYCH pidów ma plik rejestru, z którego nie powstał wpis (plik w trakcie pierwszego
   * zapisu, nieznany kształt, plik ponad limit). O takim procesie nie wiadomo, którą rozmowę
   * pisze, więc przy liczbie większej od zera rejestr nie dowodzi, że jakąkolwiek rozmowę pisze
   * JEDEN proces ({@link cliProcessStartOf}). Brak pola (atrapy w testach) = zero.
   */
  readonly unreadablePids?: number;
  /**
   * Rozmowy, które przy wcześniejszym odczycie pisał proces DALEJ ŻYWY, choć jego pliku rejestru
   * nie ma już w katalogu. Taki proces dalej może pisać swoją rozmowę, więc drugi wpis tej
   * rozmowy nie dowodzi, że pisze ją jeden proces. Brak pola (atrapy w testach) = żadnej.
   */
  readonly unlistedSessions?: ReadonlySet<string>;
}

/** Opcje jednego odczytu. */
export interface CliVersionReadOptions {
  /**
   * Sam rejestr, bez dowiązania binarki i z pamięcią `stat` (szybki tik dialogów). `installed`
   * w wyniku to wtedy ostatnio ODCZYTANE wydanie, nie świeży odczyt.
   */
  readonly registryOnly?: boolean;
}

export type CliVersionReader = (opts?: CliVersionReadOptions) => Promise<CliVersionSnapshot>;

/** Wynik `stat` potrzebny pamięci odczytów: rozmiar (limit) i czas zmiany (czy czytać znowu). */
export interface CliFileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

/** Podmienialne wejścia — testy nie dotykają dysku ani cudzych procesów. */
export interface CliVersionIo {
  readlink(path: string): Promise<string>;
  /** Czy cel istnieje (`stat` idzie ZA dowiązaniem). */
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<string[]>;
  /**
   * `stat` pliku rejestru PRZED odczytem: rozmiar (limit {@link CLI_REGISTRY_MAX_BYTES})
   * i czas zmiany — plik o tym samym czasie i rozmiarze nie jest czytany drugi raz.
   */
  stat(path: string): Promise<CliFileStat>;
  readFile(path: string): Promise<string>;
  /** `process.kill(pid, 0)`: `true` = proces żyje (także przy `EPERM`). */
  alive(pid: number): boolean;
}

/** `process.kill(pid, 0)` nie wysyła sygnału — sprawdza tylko, czy proces istnieje. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // `EPERM` = proces istnieje, tylko nie nasz. Każdy inny błąd (`ESRCH`) = nie żyje.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Treść pliku rejestru — tylko plik zwykły w sufit {@link CLI_REGISTRY_MAX_BYTES}, bez dowiązania.
 *
 * `~/.claude/sessions/` jest zapisywalny z sandboksa sesji (CLI 2.1.311), a sam `stat` przed
 * odczytem nie chroni przed podmianą na FIFO, które zajmowało wątek puli libuv bez końca. Odmowa rzuca, jak brak
 * pliku: `readRegistryFile` traktuje oba jako „nie wiem”.
 */
async function readRegistryText(path: string): Promise<string> {
  const read = await readRegularFile(path, { maxBytes: CLI_REGISTRY_MAX_BYTES, followSymlink: false });
  if (read === null || read.truncated) throw new Error('rejestr CLI: to nie jest plik zwykły w sufit');
  return read.bytes.toString('utf8');
}

export const DEFAULT_CLI_VERSION_IO: CliVersionIo = {
  readlink: (path) => readlink(path),
  exists: (path) => stat(path).then(() => true, () => false),
  readdir: (path) => readdir(path),
  stat: (path) => stat(path).then((s) => ({ size: s.size, mtimeMs: s.mtimeMs })),
  readFile: readRegistryText,
  alive: pidAlive,
};

/** `~/.local/bin/claude` — dowiązanie instalatora natywnego. */
export function defaultCliBinLink(home: string = homedir()): string {
  return join(home, '.local', 'bin', 'claude');
}

/** `~/.claude/sessions` — rejestr procesów CLI. */
export function defaultCliRegistryDir(home: string = homedir()): string {
  return join(home, '.claude', 'sessions');
}

/**
 * Porównanie dwóch numerów wydania po trzech liczbach. Kształt sprawdza wołający;
 * tu numer spoza kształtu liczy się jak `0.0.0`, żeby sortowanie nigdy nie rzuciło.
 */
export function compareCliVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Wydanie zainstalowane albo `null`.
 *
 * Cel musi mieć postać `…/versions/<X.Y.Z>` I istnieć: wiszące dowiązanie (katalog wydania
 * sprzątnięty, a dowiązanie nie) obiecywałoby restart na binarce, której nie ma. Instalacja
 * z npm (`…/node_modules/…/cli.js`) nie ma numeru w ścieżce — to „nie wiem", nie błąd.
 */
export async function readInstalledCliVersion(
  link: string, io: CliVersionIo = DEFAULT_CLI_VERSION_IO,
): Promise<string | null> {
  let target: string;
  try {
    target = await io.readlink(link);
  } catch {
    return null;
  }
  const absolute = resolve(dirname(link), target);
  const version = basename(absolute);
  if (!CLI_VERSION_RE.test(version) || basename(dirname(absolute)) !== 'versions') return null;
  return (await io.exists(absolute)) ? version : null;
}

/**
 * Jeden plik rejestru → `[uuid, wpis]` albo `null`. Czyste: bez dysku i bez żywotności.
 *
 * `pid` z treści musi równać się pidowi z NAZWY pliku — plik podrzucony pod cudzą nazwą
 * nie ma prawa opisywać innego procesu.
 *
 * `waitingFor` jest polem DODATKOWYM: jego brak albo śmieć nie odbiera wpisu
 * wydaniu. Wartość spoza zamkniętej listy to klasa `other`, a `onUnknownClass` dostaje
 * surową nazwę — czytnik zapisze z niej jedną linię w logu.
 *
 * `startedAt` też jest polem dodatkowym: brak, napis, zero albo liczba ujemna to wpis bez
 * czasu startu, a nie brak wpisu.
 */
export function parseCliRegistryFile(
  pid: number, text: string, onUnknownClass?: (raw: string) => void,
): [string, CliRegistryEntry] | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { sessionId, version, status } = record;
  if (record['pid'] !== pid) return null;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  if (typeof version !== 'string' || !CLI_VERSION_RE.test(version)) return null;
  if (typeof status !== 'string' || !STATUS_RE.test(status)) return null;
  const raw = record['waitingFor'];
  let waitingFor: CliDialogClass | undefined;
  if (typeof raw === 'string' && raw !== '') {
    waitingFor = WAITING_FOR_CLASSES.get(raw);
    if (waitingFor === undefined) {
      waitingFor = 'other';
      onUnknownClass?.(raw);
    }
  }
  const started = record['startedAt'];
  const startedAt = typeof started === 'number' && Number.isFinite(started) && started > 0
    ? started : undefined;
  return [sessionId, {
    pid, version, status,
    ...(waitingFor === undefined ? {} : { waitingFor }),
    ...(startedAt === undefined ? {} : { startedAt }),
  }];
}

/**
 * Co rejestr mówi o JEDNEJ sesji pod kątem stojącego dialogu.
 *
 * - `waiting` — DOKŁADNIE jeden żywy proces tej rozmowy i ten proces pokazuje dialog;
 * - `active` — dokładnie jeden proces i NIE czeka (`busy`, `idle`, `shell`…);
 * - `unknown` — rejestru nie ma, rozmowy w nim nie ma albo pisze ją kilka procesów naraz.
 *   Dwóch pisarzy to dwa różne stany w dwóch plikach: nie wiadomo, który panel czeka.
 *
 * `version` przy `waiting` i `active` to wydanie tego jednego procesu z TEGO SAMEGO odczytu co stan
 * (bramka wersji reguły dowodu zgody); brak pola (atrapy w testach) = wersja nieznana.
 *
 * `busy` at `active` is set only when that process has the status {@link CLI_STATUS_BUSY}: the CLI is in a turn,
 * which herdr may not report yet (the paste queue reads it). Any other status has no field.
 */
export type CliWaitingSignal =
  | { readonly kind: 'waiting'; readonly dialog: CliDialogClass; readonly version?: string }
  | { readonly kind: 'active'; readonly version?: string; readonly busy?: true }
  | { readonly kind: 'unknown' };

/** `status` of a process in a turn ({@link CliRegistryEntry.status}; measured on CLI 2.1.322 at a turn start). */
export const CLI_STATUS_BUSY = 'busy';

const CLI_UNKNOWN: CliWaitingSignal = { kind: 'unknown' };

export function cliWaitingOf(
  registry: CliRegistry | null, sessionId: string | undefined,
): CliWaitingSignal {
  if (registry === null || sessionId === undefined) return CLI_UNKNOWN;
  const entries = registry.get(sessionId);
  if (entries?.length !== 1) return CLI_UNKNOWN;
  const [entry] = entries;
  if (entry === undefined) return CLI_UNKNOWN;
  if (entry.status === CLI_STATUS_BUSY) return { kind: 'active', version: entry.version, busy: true };
  if (entry.status !== CLI_STATUS_WAITING) return { kind: 'active', version: entry.version };
  // `waiting` bez klasy (starsze CLI, pole wycięte) to dalej dialog — tylko nienazwany.
  return { kind: 'waiting', dialog: entry.waitingFor ?? 'other', version: entry.version };
}

/**
 * Czas startu procesu, który JAKO JEDYNY pisze tę rozmowę (ms epoki), albo `undefined`.
 *
 * `undefined` to „nie wiem" i wołający wtedy nic nie robi: rejestru nie ma, rozmowy w nim nie ma,
 * wpis nie niesie `startedAt` albo rozmowę pisze kilka procesów naraz. Przy dwóch pisarzach
 * nie wiadomo, w którym procesie żyje subagent, więc żaden czas startu niczego nie dowodzi.
 *
 * „Nie wiem" jest też wtedy, gdy rejestr nie widzi wszystkich żywych procesów. Jeden wpis rozmowy
 * to wtedy za mało: niewidoczny proces może być jej drugim pisarzem, a wniosek „jedyny" zamknąłby
 * żywego subagenta tamtego procesu i żaden późniejszy odczyt by go nie przywrócił. Dwa przypadki:
 *
 * - choć jeden żywy pid ma plik rejestru, z którego nie powstał wpis (`unreadablePids`): nie
 *   wiadomo, którą rozmowę pisze, więc „nie wiem" dotyczy KAŻDEJ rozmowy;
 * - tę rozmowę pisał proces, który dalej żyje, choć jego plik rejestru zniknął
 *   (`unlistedSessions`): „nie wiem" dotyczy tej jednej rozmowy.
 */
export function cliProcessStartOf(
  read: Pick<CliVersionSnapshot, 'registry' | 'unreadablePids' | 'unlistedSessions'>,
  sessionId: string | undefined,
): number | undefined {
  const { registry } = read;
  if (registry === null || sessionId === undefined || (read.unreadablePids ?? 0) > 0) return undefined;
  if (read.unlistedSessions?.has(sessionId) === true) return undefined;
  const entries = registry.get(sessionId);
  if (entries?.length !== 1) return undefined;
  return entries[0]?.startedAt;
}

/** Wynik odczytu rejestru razem z faktem potrzebnym do linii „nieznany kształt". */
interface RegistryRead {
  readonly registry: CliRegistry | null;
  /** Żywe pidy z plikiem rejestru, z których ŻADEN nie dał poprawnego wpisu. */
  readonly unreadable: boolean;
  /** Ile żywych pidów z plikiem rejestru nie dało wpisu (`CliVersionSnapshot.unreadablePids`). */
  readonly unreadablePids: number;
  /** Rozmowy żywych procesów bez pliku rejestru (`CliVersionSnapshot.unlistedSessions`). */
  readonly unlistedSessions: ReadonlySet<string>;
}

/**
 * Pamięć jednego pliku rejestru między odczytami: `stat` z chwili odczytu i wynik.
 * `parsed: null` = ten stan pliku już raz się nie sparsował — nie czytamy go drugi raz.
 */
interface CachedRegistryFile {
  readonly mtimeMs: number;
  readonly size: number;
  readonly parsed: readonly [string, CliRegistryEntry] | null;
}

/** Stan czytnika żyjący między odczytami — wyłącznie w zamknięciu `createCliVersionReader`. */
interface RegistryMemory {
  readonly files: Map<number, CachedRegistryFile>;
  /**
   * Pid → rozmowa, którą ten proces pisał przy ostatnim UDANYM odczycie jego pliku. Osobno
   * od `files`: tamta pamięć ginie razem z plikiem, a ta żyje, dopóki żyje PROCES. Plik rejestru
   * potrafi zniknąć przed procesem (po `/exit` wpis znika z rejestru, zmierzone na 2.1.312; ktoś
   * posprzątał katalog), a proces bez pliku dalej może pisać rozmowę. Cena: pid martwego CLI przejęty przez obcy,
   * długo żyjący proces trzyma swoją dawną rozmowę jako „nie wiem", dopóki ten proces żyje.
   */
  readonly writers: Map<number, string>;
  readonly onUnknownClass: (raw: string) => void;
}

/**
 * Jeden plik rejestru: `stat`, a odczyt TYLKO, gdy plik się zmienił (albo `force`).
 *
 * Plik, który się nie sparsował, oddaje JESZCZE RAZ ostatni poprawny wpis: CLI przepisuje
 * plik przy zmianie `status` (zmierzone na 2.1.293), a odczyt trafiony w zapis może zobaczyć połowę
 * JSON-u — jeden taki odczyt nie jest wiedzą „procesu nie ma", tylko „nie wiem, co nowego". Następny odczyt tego
 * samego stanu pliku daje już `null`, więc trwale zepsuty plik nie trzyma starego wpisu.
 */
async function readRegistryFile(
  file: string, pid: number, io: CliVersionIo, memory: RegistryMemory, force: boolean,
): Promise<readonly [string, CliRegistryEntry] | null> {
  let stats: CliFileStat;
  try {
    stats = await io.stat(file);
  } catch {
    // Proces skończył się między `readdir` a odczytem — plik zniknął razem z nim.
    memory.files.delete(pid);
    return null;
  }
  if (stats.size > CLI_REGISTRY_MAX_BYTES) {
    memory.files.delete(pid);
    return null;
  }
  const cached = memory.files.get(pid);
  const same = cached !== undefined
    && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size;
  if (same && !force) return cached.parsed;
  let text: string;
  try {
    text = await io.readFile(file);
  } catch {
    memory.files.delete(pid);
    return null;
  }
  const parsed = parseCliRegistryFile(pid, text, memory.onUnknownClass);
  memory.files.set(pid, { mtimeMs: stats.mtimeMs, size: stats.size, parsed });
  if (parsed === null && !same) return cached?.parsed ?? null;
  return parsed;
}

async function readRegistry(
  dir: string, io: CliVersionIo, memory: RegistryMemory, force: boolean,
): Promise<RegistryRead> {
  let names: string[];
  try {
    names = await io.readdir(dir);
  } catch {
    memory.files.clear();
    return { registry: null, unreadable: false, unreadablePids: 0, unlistedSessions: new Set() };
  }
  const registry = new Map<string, CliRegistryEntry[]>();
  const live = new Set<number>();
  let alivePids = 0;
  let unreadablePids = 0;
  for (const name of names) {
    const match = REGISTRY_FILE_RE.exec(name);
    if (match === null) continue;
    const pid = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !io.alive(pid)) continue;
    alivePids += 1;
    live.add(pid);
    const parsed = await readRegistryFile(join(dir, name), pid, io, memory, force);
    if (parsed === null) {
      unreadablePids += 1;
      continue;
    }
    const [sessionId, entry] = parsed;
    memory.writers.set(pid, sessionId);
    const list = registry.get(sessionId);
    if (list === undefined) registry.set(sessionId, [entry]);
    else list.push(entry);
  }
  // Pamięć martwych pidów idzie do kosza — pid wraca do puli i nowy proces nie ma prawa
  // dostać wpisu poprzednika.
  for (const pid of [...memory.files.keys()]) {
    if (!live.has(pid)) memory.files.delete(pid);
  }
  // Proces, którego plik zniknął z katalogu: żywy dalej może pisać swoją rozmowę, martwy wypada.
  const unlistedSessions = new Set<string>();
  for (const [pid, sessionId] of [...memory.writers]) {
    if (live.has(pid)) continue;
    if (io.alive(pid)) unlistedSessions.add(sessionId);
    else memory.writers.delete(pid);
  }
  return {
    registry, unreadable: alivePids > 0 && registry.size === 0, unreadablePids, unlistedSessions,
  };
}

/**
 * Wydanie procesu tej sesji: NAJNIŻSZE z żywych wpisów, albo `undefined`.
 *
 * Najniższe, bo pytanie brzmi „czy coś tu działa na starym wydaniu" — przy dwóch pisarzach
 * (bramka restartu i tak odmówi) lepiej pokazać znacznik niż go schować.
 */
export function runningCliVersion(
  registry: CliRegistry | null, sessionId: string | undefined,
): string | undefined {
  if (registry === null || sessionId === undefined) return undefined;
  const entries = registry.get(sessionId);
  if (entries === undefined || entries.length === 0) return undefined;
  return entries.reduce((low, entry) => (
    compareCliVersions(entry.version, low) < 0 ? entry.version : low
  ), entries[0]?.version ?? '');
}

/**
 * `{ running, installed }` wyłącznie wtedy, gdy oba są znane i zainstalowane jest NOWSZE.
 *
 * Kierunek jest tu rozstrzygalny, więc przy wydaniu
 * zainstalowanym STARSZYM niż działające (ręczny rollback) milczymy — restart byłby cofnięciem.
 */
export function cliUpdateFor(
  running: string | undefined, installed: string | null,
): { running: string; installed: string } | undefined {
  if (running === undefined || installed === null) return undefined;
  return compareCliVersions(installed, running) > 0 ? { running, installed } : undefined;
}

export interface CliVersionReaderOptions {
  readonly binLink?: string;
  readonly registryDir?: string;
  readonly io?: CliVersionIo;
  readonly logger?: (line: string) => void;
}

/**
 * Czytnik obu faktów naraz; każda linia logu leci najwyżej raz na jego życie.
 *
 * JEDNA KOLEJKA. Szybki tik dialogów (`registryOnly`, co 1,5 s), migawka wydań
 * (co 30 s) i odczyty bramek restartu idą przez ten sam łańcuch obietnic, po kolei:
 * odczyt startuje dopiero po końcu poprzedniego, a numer `generation` rośnie w tej samej
 * kolejności. Dwa odczyty w locie mogłyby skończyć się w odwrotnej kolejności i starszy
 * stan rejestru nadpisałby nowszy — kolejka wyklucza to z konstrukcji, a numer pozwala
 * wołającemu to sprawdzić.
 *
 * Bez `fs.watch` z rozmysłem: pliki rejestru przepisuje każdy proces CLI przy każdej zmianie
 * stanu, a 1–2 s świeżości wystarcza (pomiar na 2.1.293: dialog trzymany 20 s). Odczyt płaci
 * `readdir` i `stat` żywych pidów; `readFile` tylko dla plików, które się zmieniły. Pełna
 * migawka czyta wszystkie pliki od nowa — to siatka pod pamięcią `stat`.
 */
export function createCliVersionReader(opts: CliVersionReaderOptions = {}): CliVersionReader {
  const io = opts.io ?? DEFAULT_CLI_VERSION_IO;
  const binLink = opts.binLink ?? defaultCliBinLink();
  const registryDir = opts.registryDir ?? defaultCliRegistryDir();
  let warned = false;
  let warnedClass = false;
  let installed: string | null = null;
  let generation = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const memory: RegistryMemory = {
    files: new Map(),
    writers: new Map(),
    onUnknownClass: (raw) => {
      if (warnedClass) return;
      warnedClass = true;
      const name = LOGGABLE_CLASS_RE.test(raw) ? `"${raw}"` : '(name outside the pattern)';
      opts.logger?.(`rarog: ${CLI_REGISTRY_UNKNOWN_CLASS_LOG} ${name} — Rarog shows `
        + 'it as a plain CLI dialog; add it to the list in cli-version.ts after a CLI update.');
    },
  };
  const read = async (registryOnly: boolean): Promise<CliVersionSnapshot> => {
    generation += 1;
    const own = generation;
    const [fresh, registryRead] = await Promise.all([
      registryOnly ? Promise.resolve(installed) : readInstalledCliVersion(binLink, io),
      readRegistry(registryDir, io, memory, !registryOnly),
    ]);
    installed = fresh;
    if (registryRead.unreadable && !warned) {
      warned = true;
      opts.logger?.(`rarog: ${CLI_REGISTRY_UNKNOWN_SHAPE_LOG} (~/.claude/sessions) — `
        + 'the Claude Code update marker stays silent; check the format after a CLI update.');
    }
    return {
      installed: fresh, registry: registryRead.registry, generation: own,
      unreadablePids: registryRead.unreadablePids, unlistedSessions: registryRead.unlistedSessions,
    };
  };
  return (readOpts = {}) => {
    const step = chain.then(() => read(readOpts.registryOnly === true));
    // Błąd jednego odczytu nie zrywa kolejki — następny startuje normalnie.
    chain = step.catch(() => undefined);
    return step;
  };
}
