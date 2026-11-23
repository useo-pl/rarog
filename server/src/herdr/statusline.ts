/**
 * Payload status line Claude Code — JEDYNE miejsce, w którym silnik podaje ROZMIAR OKNA sesji.
 *
 * W transkrypcie jsonl rozmiaru okna nie ma (sprawdzone: żadne pole, żaden wpis `init`). Bez status line Rarog
 * musiałby więc okno ZAKŁADAĆ — i sesji 1M pokazywałby procent liczony od 200k, czyli pięciokrotnie za ostro
 * („kompaktuj natychmiast" nad rozmową zajmującą 15% okna).
 *
 * Rozmiar okna jest w payloadzie, który Claude Code wysyła na STDIN komendy `statusLine`
 * z `~/.claude/settings.json` (docs statusline, „Available data”: `context_window.context_window_size`): na starcie
 * sesji, a potem między innymi po każdej nowej wiadomości asystenta, po `/compact` i po zmianie trybu zgód („When
 * the status line updates”).
 * Skrypt użytkownika zrzuca ten payload do `~/.claude/statusline/<session_id>.json` (zapis atomowy: tmp + `mv`),
 * a ten moduł go czyta.
 *
 * Kształt zmierzony na CLI 2.1.239 — pola, które nas obchodzą:
 *
 *     { "session_id": "…",
 *       "model": { "id": "claude-opus-5" },
 *       "context_window": { "context_window_size": 1000000, "used_percentage": 48 } }
 *
 * Moduł jest CZYSTY (parser) plus jedna funkcja I/O, która NIGDY nie rzuca: brak pliku to stan
 * normalny — skrypt paska tej sesji mógł jeszcze nic nie zrzucić, a panel spoza
 * tej maszyny nie zrzuci nigdy. „Nie wiem" wraca jako `null` i wtedy zostaje szacunek z jsonl.
 */
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asRecord } from '../drivers/tool-text.ts';
import { readRegularFile } from '../safe-read.ts';

/** Katalog zrzutów. Sąsiad `~/.claude/projects`, bo to ta sama własność i ten sam cykl życia. */
export function defaultStatuslineRoot(): string {
  return join(homedir(), '.claude', 'statusline');
}

/** Ścieżka zrzutu jednej sesji silnika. */
export function statuslinePath(root: string, engineSessionId: string): string {
  return join(root, `${engineSessionId}.json`);
}

/**
 * Sufit odczytu — zrzut ma ~1 kB, więc cokolwiek większego znaczy „to nie jest ten plik".
 * Czytamy go w pętli followera, a nie raz na życie, więc lepiej odbić dziwny plik niż go wciągać.
 */
export const STATUSLINE_MAX_BYTES = 64 * 1024;

/**
 * Treść zrzutu albo `null` — tylko plik zwykły w sufit {@link STATUSLINE_MAX_BYTES}, bez dowiązania.
 *
 * `~/.claude/statusline/` jest zapisywalny z sandboksa sesji (CLI 2.1.311), więc FIFO pod
 * nazwą zrzutu zajmowało wątek puli libuv bez końca. Skrypt użytkownika zapisuje plik zwykły (tmp + `mv`).
 * Rzuca przy błędzie otwarcia (brak pliku) — wołający i tak łapią.
 */
async function readDump(path: string): Promise<string | null> {
  const read = await readRegularFile(path, { maxBytes: STATUSLINE_MAX_BYTES, followSymlink: false });
  return read === null || read.truncated ? null : read.bytes.toString('utf8');
}

export interface StatuslineState {
  /** `context_window.context_window_size` — rozmiar okna TEJ sesji, wprost od silnika. */
  contextWindow?: number;
  /** `context_window.used_percentage` — procent zajętego okna, liczony z tokenów wejścia (docs statusline). */
  usedPercentage?: number;
  /** `model.id` — identyfikator bieżącego modelu (docs statusline, „Available data”). */
  model?: string;
}

/** Liczba dodatnia i skończona albo `undefined` — cudzy JSON bywa czymkolwiek. */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Tekst zrzutu → interesujące nas pola.
 *
 * @returns stan albo `null`, gdy to nie jest payload status line (uszkodzony JSON, obcy kształt)
 */
export function parseStatusline(text: string): StatuslineState | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (record === null) return null;

  const state: StatuslineState = {};
  const window = asRecord(record['context_window']);
  if (window !== null) {
    const size = positive(window['context_window_size']);
    if (size !== undefined) state.contextWindow = size;
    const used = window['used_percentage'];
    // Zero jest poprawnym procentem (świeża sesja), więc tu NIE używamy `positive`.
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0) state.usedPercentage = used;
  }
  const model = asRecord(record['model']);
  const id = model === null ? undefined : model['id'];
  if (typeof id === 'string' && id !== '') state.model = id;

  return state.contextWindow === undefined && state.usedPercentage === undefined
    && state.model === undefined
    ? null
    : state;
}

/**
 * Czyta zrzut jednej sesji. NIGDY nie rzuca — brak pliku jest normalnym stanem pracy.
 *
 * @returns stan albo `null` (brak pliku, brak uprawnień, śmieci, plik podejrzanie duży)
 */
export async function readStatusline(
  root: string, engineSessionId: string,
): Promise<StatuslineState | null> {
  try {
    const text = await readDump(statuslinePath(root, engineSessionId));
    return text === null ? null : parseStatusline(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Limity planu z paska statusu — jedyne źródło panelu limitów i kafla Live Activity
// ---------------------------------------------------------------------------

/** Okno limitu z paska statusu: procent i ISO resetu (`resets_at` w payloadzie to sekundy epoki, docs statusline). */
export interface StatuslineLimitWindow {
  percent: number;
  resetsAt: string;
}

/**
 * The newest reading of one weekly window (one `seven_day` reset): the raw percent and the `changeAt` of the dump
 * it comes from. The weekly-limit signal reads it for every account on this Mac, not only the winner's.
 */
export interface StatuslineWeeklyWindow {
  percent: number;
  resetsAt: string;
  at: number;
}

export interface StatuslineRateLimits {
  fiveHour?: StatuslineLimitWindow;
  weekly?: StatuslineLimitWindow;
  /**
   * Chwila, z której są liczby (ms epoki): `changeAt` zrzutu, czyli `mtime` odczytu, w którym zmienił się jego
   * odcisk ({@link scanFreshestRateLimits}).
   */
  at: number;
  /**
   * One entry per live weekly reset among the remembered dumps, in reset order: the dump with the latest `changeAt`
   * (tie: newer `mtime`, then name). Independent of the winner above, which the tile and `GET /api/usage` read.
   */
  weeklyWindows: readonly StatuslineWeeklyWindow[];
}

/** The winner alone: what `GET /api/usage` reads ({@link readFreshestRateLimits}). */
export type StatuslineWinner = Omit<StatuslineRateLimits, 'weeklyWindows'>;

/** Live windows of one dump, without the reading instant. */
type DumpLimits = Omit<StatuslineRateLimits, 'at' | 'weeklyWindows'>;

function limitWindow(value: unknown, now: number): StatuslineLimitWindow | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  const percent = record['used_percentage'];
  const resetsAt = record['resets_at'];
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined;
  // Okno po resecie mówi o oknie, którego już nie ma: Claude Code je pomija (docs statusline), stary zrzut nie.
  if (resetsAt * 1000 <= now) return undefined;
  // Liczba skończona, ale poza zakresem `Date` (np. 1e20 s): `toISOString` rzuciłby i zatrzymał cały skan.
  const reset = new Date(resetsAt * 1000);
  if (Number.isNaN(reset.getTime())) return undefined;
  return { percent, resetsAt: reset.toISOString() };
}

/**
 * `rate_limits` z payloadu paska statusu (docs statusline, „Available data”):
 *
 *     "rate_limits": { "five_hour": { "used_percentage": 40, "resets_at": 1787844000 },
 *                      "seven_day": { "used_percentage": 92, "resets_at": 1787842800 } }
 *
 * Według docs obiekt przychodzi tylko u subskrybentów claude.ai Pro, Max i Ultra albo za bramą z limitem wydatków,
 * i dopiero po pierwszej odpowiedzi API w sesji; każde okno (`five_hour`, `seven_day`, `spend_limit`) może osobno
 * nie przyjść. Rarog czyta dwa pierwsze. Okna per model (np. Fable) ani konta docs w payloadzie nie wymieniają.
 * `null` = brak żywego okna.
 */
export function parseStatuslineRateLimits(text: string, now: number): DumpLimits | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return rateLimitsOf(asRecord(value)?.['rate_limits'], now);
}

/** Surowe `rate_limits` → żywe okna; `null` = brak żywego okna. */
function rateLimitsOf(value: unknown, now: number): DumpLimits | null {
  const limits = asRecord(value);
  if (limits === null) return null;
  const fiveHour = limitWindow(limits['five_hour'], now);
  const weekly = limitWindow(limits['seven_day'], now);
  if (fiveHour === undefined && weekly === undefined) return null;
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(weekly === undefined ? {} : { weekly }),
  };
}

/**
 * Limity z NAJŚWIEŻSZEGO zrzutu, który je ma (heurystyka świeżości, {@link scanFreshestRateLimits}). Zrzuty
 * różnych sesji bywają z różnych kont (zmierzone: dwa różne resety tygodnia), więc wygrywa sesja, która ostatnio
 * rozmawiała z API. NIGDY nie rzuca — nieczytelny katalog to tu też `null`.
 */
export async function readFreshestRateLimits(root: string, now: number): Promise<StatuslineWinner | null> {
  let limits: StatuslineRateLimits | null;
  try {
    limits = await scanFreshestRateLimits(root, now);
  } catch {
    return null;
  }
  if (limits === null) return null;
  // `GET /api/usage` shows the winner only: the list of all weekly windows stays inside the server.
  const { weeklyWindows: _windows, ...winner } = limits;
  return winner;
}

/** Ile zrzutów o zmienionym `mtime:size` czyta jeden skan; reszta czeka na następny skan. */
export const RATE_LIMITS_READS_PER_SCAN = 200;

/** Pamięć skanu o jednym zrzucie, z jego ostatniego udanego odczytu. */
interface DumpMemory {
  /** `mtime:size` z `stat` przed tym odczytem; inny znacznik w następnym skanie = plik do przeczytania. */
  stamp: string;
  /** `mtime` (ms epoki) z tego odczytu. */
  mtime: number;
  /** Odcisk treści: `rate_limits` i `cost.total_api_duration_ms`. */
  fingerprint: string;
  /** `mtime` odczytu, w którym odcisk się zmienił; plik widziany pierwszy raz: `mtime` pierwszego odczytu. */
  changeAt: number;
  /** Surowe `rate_limits`: okna po resecie odpadają w każdym skanie od nowa. */
  rateLimits: unknown;
}

/**
 * Pamięć procesu: katalog zrzutów → nazwa pliku → {@link DumpMemory}. Ginie z restartem serwera i wtedy każdy
 * plik jest widziany pierwszy raz, czyli wraca kolejność po `mtime`.
 */
const dumpMemory = new Map<string, Map<string, DumpMemory>>();

/** Ostatni skan każdego katalogu, na który czeka następny: pamięć {@link dumpMemory} zmienia jeden skan naraz. */
const scansInFlight = new Map<string, Promise<void>>();

/** Odcisk treści zrzutu albo `null` dla urwanego JSON-u i obcego kształtu. */
function fingerprintOf(text: string): { fingerprint: string; rateLimits: unknown } | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (record === null) return null;
  const rateLimits = record['rate_limits'] ?? null;
  const apiMs = asRecord(record['cost'])?.['total_api_duration_ms'] ?? null;
  return { fingerprint: JSON.stringify([rateLimits, apiMs]), rateLimits };
}

/** `ENOENT` albo `ENOTDIR`: pliku nie ma, a nie „chwilowo nieczytelny”. */
function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Kandydat wygrywa z obecnym zwycięzcą: późniejszy `changeAt`, potem nowszy `mtime`, potem nazwa. */
function beats(name: string, dump: DumpMemory, best: { name: string; dump: DumpMemory } | null): boolean {
  if (best === null) return true;
  if (dump.changeAt !== best.dump.changeAt) return dump.changeAt > best.dump.changeAt;
  if (dump.mtime !== best.dump.mtime) return dump.mtime > best.dump.mtime;
  return name < best.name;
}

/**
 * Heurystyka świeżości. Bezczynna sesja rysuje pasek od nowa bez zapytania do API
 * (docs statusline: wygaśnięcie cache'u promptu, osiągnięty `resets_at`, zmiana trybu zgód, `refreshInterval`),
 * więc jej zrzut dostaje najnowszy `mtime` ze starymi liczbami. Wygrywa zatem zrzut z żywym oknem
 * i najpóźniejszym `changeAt`, czyli chwilą, w której zmienił się jego odcisk (`rate_limits` albo
 * `cost.total_api_duration_ms`; zmiana tego pola znaczy „było zapytanie do API”). Remis: nowszy `mtime`, potem
 * nazwa wcześniejsza w porządku znaków. `at` wyniku to `changeAt` zwycięzcy.
 *
 * Każdy skan robi `stat` wszystkich zrzutów, a czyta tylko te o zmienionym `mtime:size`, najnowsze najpierw, do
 * {@link RATE_LIMITS_READS_PER_SCAN}. Urwany JSON i plik chwilowo nieczytelny są pomijane, a pamięć o nich zostaje:
 * kandydatem jest wtedy treść z ostatniego udanego odczytu. Plik, którego nie ma, traci pamięć. Dwa skany naraz
 * (REST i poller kafla) dają tego samego zwycięzcę: skany jednego katalogu idą po kolei, a zapis pamięci jest
 * idempotentny (ten sam plik w tym samym stanie daje ten sam wpis).
 *
 * Nieczytelny KATALOG zrzutów RZUCA zamiast oddać `null`. Poller limitów kafla Live Activity musi odróżnić „żaden
 * zrzut nie ma żywego okna" (prawda: okna znikają) od „nie udało się przeczytać" (zostaje poprzedni odczyt) —
 * wspólne `null` kasowało limity z kafla przy chwilowym błędzie I/O.
 */
export function scanFreshestRateLimits(root: string, now: number): Promise<StatuslineRateLimits | null> {
  const run = (scansInFlight.get(root) ?? Promise.resolve()).then(() => scanOnce(root, now));
  // Następny skan czeka na koniec tego, także po wyjątku; ostatni skan sprząta po sobie wpis.
  const done = run.then(() => undefined, () => undefined);
  scansInFlight.set(root, done);
  void done.then(() => { if (scansInFlight.get(root) === done) scansInFlight.delete(root); });
  return run;
}

async function scanOnce(root: string, now: number): Promise<StatuslineRateLimits | null> {
  const names = (await readdir(root)).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
  let memory = dumpMemory.get(root);
  if (memory === undefined) {
    memory = new Map();
    dumpMemory.set(root, memory);
  }
  const known = memory;
  const listed = new Set(names);
  for (const name of known.keys()) if (!listed.has(name)) known.delete(name);

  const present = new Set<string>();
  const changed: { name: string; stamp: string; mtime: number }[] = [];
  await Promise.all(names.map(async (name) => {
    try {
      const info = await stat(join(root, name));
      if (!info.isFile() || info.size > STATUSLINE_MAX_BYTES) {
        known.delete(name);
        return;
      }
      present.add(name);
      const stamp = `${String(info.mtimeMs)}:${String(info.size)}`;
      if (known.get(name)?.stamp !== stamp) changed.push({ name, stamp, mtime: info.mtimeMs });
    } catch (error) {
      // Chwilowo nieczytelny: pomijany w tym skanie, pamięć zostaje.
      if (isGone(error)) known.delete(name);
    }
  }));

  changed.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
  for (const entry of changed.slice(0, RATE_LIMITS_READS_PER_SCAN)) {
    let text: string | null;
    try {
      text = await readDump(join(root, entry.name));
    } catch (error) {
      // Zniknął między `stat` a odczytem: pamięć wypada. Inny błąd: pamięć zostaje do następnego skanu.
      if (isGone(error)) {
        known.delete(entry.name);
        present.delete(entry.name);
      }
      continue;
    }
    const content = text === null ? null : fingerprintOf(text);
    if (content === null) continue;
    // Podmiana pliku między `stat` a odczytem: odcisk jest z nowej treści, a `mtime` ze starego `stat`, więc
    // `changeAt` byłby za wczesny i utrwaliłby się w pamięci. Bez zapisu: następny skan zobaczy nowy znacznik.
    try {
      const after = await stat(join(root, entry.name));
      if (`${String(after.mtimeMs)}:${String(after.size)}` !== entry.stamp) continue;
    } catch {
      continue;
    }
    const previous = known.get(entry.name);
    known.set(entry.name, {
      stamp: entry.stamp,
      mtime: entry.mtime,
      fingerprint: content.fingerprint,
      changeAt: previous !== undefined && previous.fingerprint === content.fingerprint
        ? previous.changeAt
        : entry.mtime,
      rateLimits: content.rateLimits,
    });
  }

  let best: { name: string; dump: DumpMemory; limits: DumpLimits } | null = null;
  // Weekly reset → the dump with the newest reading of that window, by the same order as the winner.
  const weeks = new Map<string, { name: string; dump: DumpMemory; percent: number }>();
  for (const name of present) {
    const dump = known.get(name);
    if (dump === undefined) continue;
    let limits: DumpLimits | null;
    try {
      limits = rateLimitsOf(dump.rateLimits, now);
    } catch {
      // Zła treść jednego zrzutu nie odbiera limitów z pozostałych.
      continue;
    }
    if (limits === null) continue;
    if (beats(name, dump, best)) best = { name, dump, limits };
    const week = limits.weekly;
    if (week !== undefined && beats(name, dump, weeks.get(week.resetsAt) ?? null)) {
      weeks.set(week.resetsAt, { name, dump, percent: week.percent });
    }
  }
  if (best === null) return null;
  const weeklyWindows = [...weeks.entries()]
    .sort(([a], [b]) => Date.parse(a) - Date.parse(b))
    .map(([resetsAt, entry]) => ({ percent: entry.percent, resetsAt, at: entry.dump.changeAt }));
  return { ...best.limits, at: best.dump.changeAt, weeklyWindows };
}
