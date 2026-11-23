/**
 * Puls sesji: „coś jeszcze żyje", gdy główny transkrypt milczy.
 *
 * Problem, który ten moduł rozwiązuje (zgłoszenie użytkownika): agent odpala workflow albo
 * subagentów i przez KILKA MINUT nie dopisuje do własnego `<uuid>.jsonl` ani jednej linii.
 * Follower nie ma wtedy czego czytać, wiersz aktywności zamiera i Rarog wygląda na zawieszony —
 * a praca trwa, tylko w innych plikach. Ten moduł ogląda właśnie te inne pliki.
 *
 * ── Struktura katalogu sesji (zmierzona na `~/.claude/projects`, nie z dokumentacji)
 *
 *   <root>/<slug>/<uuid>.jsonl                 główny transkrypt (czyta go `jsonl-follow.ts`)
 *   <root>/<slug>/<uuid>/                      katalog-satelita — powstaje DOPIERO, gdy jest
 *                                              co w nim zapisać (sesje bez narzędzi go nie mają)
 *     subagents/agent-<id>.jsonl               pojedynczy Task/Agent (transkrypt subagenta)
 *     subagents/agent-<id>.meta.json           {agentType, description, toolUseId, spawnDepth, model}
 *     subagents/workflows/wf_<id>/journal.jsonl   wpisy {"type":"started"|"result", key, agentId}
 *     subagents/workflows/wf_<id>/agent-<id>.jsonl(+ .meta.json)   agenci JEDNEGO workflow
 *     workflows/scripts/<nazwa>-wf_<id>.js     skrypt workflow — powstaje NA STARCIE przebiegu
 *     workflows/wf_<id>.json                   podsumowanie — powstaje DOPIERO PO zakończeniu
 *     tool-results/<id>.txt|.json              duże wyniki narzędzi
 *     session-memory/                          (część projektów)
 *
 * Trzy obserwacje z tego pomiaru rządzą całym modułem:
 *
 * 1. **Nazwa workflow jest w NAZWIE PLIKU skryptu**, nie w journalu. Wbrew założeniu z planu
 *    `journal.jsonl` ma wyłącznie wpisy `started`/`result` (bez `meta.name`), a `workflows/
 *    wf_<id>.json` — jedyny plik z polem `workflowName` — powstaje dopiero PO przebiegu, czyli
 *    zawsze za późno. Dlatego nazwę czytamy z listingu `workflows/scripts/` (`<nazwa>-wf_<id>.js`):
 *    same nazwy plików, ZERO czytania cudzej treści.
 * 2. **Świeżość liczy się z `mtime`, nigdy ze zdarzenia watchera.** Na macOS `fs.watch` z
 *    `recursive: true` DZIAŁA (zweryfikowane) i podaje ścieżki względne także dla plików
 *    zagnieżdżonych, ale typ zdarzenia kłamie (dopisanie do pliku przychodzi jako `rename`),
 *    a FSEvents po starcie potrafi odtworzyć krótką historię zmian sprzed chwili. Zdarzenie jest
 *    więc tylko PODPOWIEDZIĄ, gdzie zrobić `stat` — dowodem życia jest wyłącznie `mtime` w oknie.
 * 3. **Watcher rekurencyjny bywa niedostępny** — w piaskownicy Claude Code ten sam kod dostaje
 *    `EMFILE` na zdarzeniu `error` (ulimit jest tu bez znaczenia: blokowany jest FSEvents).
 *    Dlatego skan katalogu nie jest „wersją na Linuksa", tylko ścieżką, która musi działać:
 *    przy awarii watchera moduł po cichu na nią przechodzi.
 *
 * Uczciwość jest ważniejsza niż ładny wiersz: **zero zmian = zero zdarzeń**. Moduł nigdy nie
 * mówi „pracuje", jeśli żaden plik nie urósł — Rarog ma nie udawać życia, którego nie widzi.
 *
 * Koszt: watcher żyje WYŁĄCZNIE w czasie tury (`start()` / `stop()` woła driver). 17 paneli ×
 * rekurencyjny watcher to koszt, którego nikt nie zamawiał; panel bez tury nie ma tu nic.
 */
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { defaultStoreRoot } from '../cli-store.ts';
import { isRunId, locateSatelliteDir } from './background/index.ts';

// ---------------------------------------------------------------------------
// Stałe (świadomie w kodzie, nie w env — to nie jest konfiguracja bezpieczeństwa)
// ---------------------------------------------------------------------------

/** Odstęp między wypłatami pulsu. Wiersz aktywności odświeżany częściej i tak nic nie wnosi. */
export const PULSE_THROTTLE_MS = 3_000;
/** Plik zmieniony w tym oknie liczy się jako „żywy". Musi być > throttle, inaczej gubi ticki. */
export const PULSE_WINDOW_MS = 10_000;
/** Co ile skanujemy katalog MIMO działającego watchera (siatka na ciche zgubienie zdarzeń). */
export const PULSE_VERIFY_MS = 12_000;
/**
 * Ile wpisów wchodzi do JEDNEJ próbki — katalog sesji po długiej pracy ma setki plików.
 *
 * Sufit pada po ŚWIEŻOŚCI, nie w kolejności `readdir`: walk przerwany na 400. wpisie listingu
 * wyciszałby puls katalogu satelity z ponad 400 plikami (na tej maszynie: 682, 512, 481)
 * dokładnie wtedy, gdy subagenci piszą — bo do próbki trafiałyby wpisy, które `readdir` oddał
 * pierwsze, a nie te, które właśnie urosły. Kolejność listingu nie ma nic wspólnego z pracą.
 */
export const PULSE_MAX_ENTRIES = 400;
/**
 * Ile razy więcej plików wolno OBEJRZEĆ, niż zmieści się w próbce.
 *
 * Wybór najświeższych kosztuje `stat` na każdy oglądany plik, więc sufit oglądania zostaje —
 * przesuwa się tylko wyżej. Pięciokrotność mieści z zapasem najgrubszy zmierzony katalog
 * (682 wpisy w zasięgu `PULSE_MAX_DEPTH`), a przy 400 wpisach próbki daje sufit 2000 statów
 * na PEŁNY skan — czyli raz na `PULSE_VERIFY_MS`, dwa rzędy wielkości pod budżetem ticku.
 */
const SCAN_OVERSCAN = 5;
/**
 * Ile składowych ma NAJGŁĘBSZA interesująca nas ścieżka.
 *
 * `subagents/workflows/wf_<id>/agent-<id>.jsonl` to cztery — i to jest dno zmierzonej struktury.
 * Głębiej nie schodzimy: katalog sesji bywa duży, a wszystko, co znaczy „ktoś pracuje", leży
 * na tych czterech poziomach.
 */
export const PULSE_MAX_DEPTH = 4;
/** Zegar systemu plików bywa minimalnie z przodu — tolerancja, żeby nie odrzucać świeżych zmian. */
const CLOCK_SKEW_MS = 2_000;

/**
 * Ile `stat` wolno puścić naraz przy ścieżkach BEZ znanego `mtime`.
 *
 * Cała próbka na raz (`Promise.all` po 400 wpisach) to 400 otwartych operacji na jeden tick —
 * niepotrzebna szpilka na deskryptorach współdzielonych z followerami 17 paneli. Sekwencyjnie
 * zaś tick trwał tyle, ile suma opóźnień dysku. Paczka jest kompromisem: 32 równoległe `stat`
 * mieszczą się w jednym obrocie kolejki zdarzeń i nie widać ich w budżecie ticku.
 */
const STAT_BATCH = 32;

/** Transkrypt subagenta: `agent-<id>.jsonl` (plik `.meta.json` obok NIE jest transkryptem). */
const AGENT_FILE = /^agent-[A-Za-z0-9_-]+\.jsonl$/;
/** Katalog ze skryptami przebiegów — jedyne miejsce, z którego bierzemy NAZWĘ workflow. */
const SCRIPTS_DIR = ['workflows', 'scripts'] as const;

// ---------------------------------------------------------------------------
// Kontrakt
// ---------------------------------------------------------------------------

export interface PulseSample {
  /** Ilu subagentów pisało do swoich transkryptów w oknie (`agent-*.jsonl`). */
  agents: number;
  /**
   * Nazwa workflow z `workflows/scripts/<nazwa>-wf_<id>.js`.
   *
   * Nieobecna znaczy DOKŁADNIE „nie wiem": pojedyncze taski poza workflow albo skrypt, którego
   * nazwy nie dało się odczytać. Zgadywania (np. podstawienia `wf_1a2b…`) tu nie ma — surowy
   * identyfikator przebiegu nic człowiekowi nie mówi.
   */
  workflowName?: string;
  /**
   * Ilu agentów NAJBARDZIEJ zajętego przebiegu już skończyło — liczba wpisów `result`
   * w jego `journal.jsonl`. Nieobecne = „nie wiem":
   * pojedyncze taski bez journala albo journal, którego nie dało się odczytać.
   */
  agentsDone?: number;
  /**
   * Identyfikator NAJBARDZIEJ zajętego przebiegu (`wf_…`, sam id — zero treści). Driver dokleja
   * po nim fakty o fazach z cache'u rozkładu (`background/merge.ts`), którego puls sam nie
   * czyta. Nieobecny = w oknie nie pisał żaden katalog `wf_…`.
   */
  runId?: string;
  /** Inne świeże pliki (journal, meta, wyniki narzędzi) — „coś się dzieje", ale to nie subagent. */
  other: number;
  /** `mtime` najświeższego pliku w próbce (ms). */
  at: number;
}

/**
 * Kandydat do próbki: ścieżka WZGLĘDNA katalogu satelity plus `mtime`, jeśli już go znamy.
 *
 * `mtime` jest opcjonalne, bo do próbki wchodzą dwa różne źródła: listing (statuje przy wyborze
 * najświeższych, więc czas ma) i podpowiedzi watchera na ścieżce niepełnej (`#tick` bez pełnego
 * skanu — tam jest sama nazwa). `#classify` dostatuje tylko te bez czasu.
 */
export interface ScanPath {
  readonly rel: string;
  readonly mtime?: number;
}

export interface SessionPulse {
  /** Włącza obserwację. Idempotentne — druga tura nie zakłada drugiego watchera. */
  start(): void;
  /** Wyłącza obserwację i zamyka watcher. Po `stop()` obiekt wolno wystartować ponownie. */
  stop(): void;
  /** `/clear`: ten sam panel, nowa sesja silnika — czyli INNY katalog satelity. */
  repoint(agentSessionId: string): void;
  /**
   * Ta sama sesja silnika, ale jej pliki PRZENIOSŁY SIĘ (`EnterWorktree`).
   *
   * Adres katalogu jest cache'owany raz na sesję (`#resolveDir`), więc po `rename(2)` puls
   * skanowałby katalog, którego już nie ma — cicho, bo brak katalogu jest tu normalnym stanem
   * pracy. Wołane sygnałem `relocated` followera; następny tick zrobi glob po uuid od nowa.
   */
  relocated(): void;
  /** Koniec życia obiektu (dispose drivera). */
  close(): void;
}

/** Podmienialne parametry czasowe — testy nie mają czekać 3 s na jeden tick. */
export interface PulseTiming {
  throttleMs?: number;
  windowMs?: number;
  verifyMs?: number;
}

export interface SessionPulseOptions {
  cwd: string;
  agentSessionId: string;
  /** Korzeń magazynu CLI. Domyślnie `~/.claude/projects` (testy dają katalog tymczasowy). */
  root?: string;
  /** Wypłata pulsu. Wołana najwyżej raz na `throttleMs` i TYLKO gdy coś naprawdę urosło. */
  onPulse: (sample: PulseSample) => void;
  now?: () => number;
  /** `false` wyłącza `fs.watch` i zostawia sam skan (determinizm w testach). */
  watch?: boolean;
  timing?: PulseTiming;
  maxEntries?: number;
}

// ---------------------------------------------------------------------------
// Odczyt (nigdy nie rzuca — brak katalogu jest normalnym stanem pracy)
// ---------------------------------------------------------------------------

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * NAJŚWIEŻSZE ścieżki plików pod `dir` (względne), z ograniczeniem głębokości i liczby.
 *
 * `readdir` z `recursive: true` czytałby także katalogi, których nie potrzebujemy, i nie ma
 * sufitu — a katalog sesji po dniu pracy potrafi mieć setki wpisów.
 *
 * `mtime` zbieramy TU, a nie dopiero w `#classify`: sufit próbki musi wybierać po świeżości,
 * a kolejność `readdir` jest wobec pracy przypadkowa (patrz `PULSE_MAX_ENTRIES`). Oglądanie
 * ma własny, wyższy sufit (`SCAN_OVERSCAN`) — inaczej katalog z dziesiątkami tysięcy wyników
 * narzędzi zamieniłby tick w burzę statów.
 *
 * Zmierzony czas WYCHODZI na zewnątrz razem ze ścieżką: `#classify` statował drugi raz to samo,
 * co wybór najświeższych przed chwilą sprawdził — czyli do 400 `stat` na tick w katalogu, w
 * którym nic się nie zmieniło.
 *
 * Wyeksportowane dla testu: przez publiczne API tę regułę dałoby się sprawdzić tylko pośrednio,
 * a wynik zależałby wtedy od kolejności `readdir` — czyli od systemu plików, nie od kodu.
 */
export async function listFiles(dir: string, maxEntries: number): Promise<ScanPath[]> {
  const seen: { rel: string; mtime: number }[] = [];
  const budget = maxEntries * SCAN_OVERSCAN;
  /** @param depth ile składowych ma ścieżka CZYTANEGO katalogu (0 = sam katalog sesji). */
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (seen.length >= budget) return;
    let entries;
    try {
      entries = await readdir(rel === '' ? dir : join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen.length >= budget) return;
      const next = rel === '' ? entry.name : `${rel}${sep}${entry.name}`;
      if (entry.isDirectory()) {
        if (depth + 1 < PULSE_MAX_DEPTH) await walk(next, depth + 1);
      } else if (entry.isFile()) {
        // Plik zniknięty między `readdir` a `stat` nie liczy się do budżetu: nie ma go i tak.
        const mtime = await mtimeOf(join(dir, next));
        if (mtime !== null) seen.push({ rel: next, mtime });
      }
    }
  };
  await walk('', 0);
  seen.sort((a, b) => b.mtime - a.mtime);
  return seen.slice(0, maxEntries);
}

/** Sufit odczytu journala — wpisy `result` niosą CAŁE wyniki agentów, plik bywa duży. */
const JOURNAL_TAIL_BYTES = 256 * 1024;

/**
 * Liczba agentów, którzy JUŻ NIE PRACUJĄ, w OGONIE journala przebiegu — wpisy `result` ORAZ
 * `failed` (zmierzone na żywym przebiegu: 5 `started`, 3 `result`, 2 `failed`;
 * agent, który padł, liczony tylko po `result` „pracował" w liczniku do końca przebiegu).
 * `null` = pliku nie ma / nie da się czytać.
 *
 * Zliczanie po podłańcuchu jest bezpieczne: wewnątrz JSON-owego stringa cudzysłowy są
 * escapowane (`\"type\"`), więc goły `"type":"result"` może pochodzić wyłącznie z pola
 * samego wpisu. Przy journalu większym niż okno wynik jest DOLNYM oszacowaniem — licznik
 * na wierszu aktywności może przez chwilę zaniżać, nigdy nie zmyśla.
 */
async function journalResults(path: string): Promise<number | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - JOURNAL_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, JOURNAL_TAIL_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return text.split('\n')
      .filter((line) => line.includes('"type":"result"') || line.includes('"type":"failed"'))
      .length;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Listing + podpowiedzi watchera → jedna lista pod sufit próbki.
 *
 * Podpowiedzi idą PRZED listingiem, bo `slice` ucina ogon: zdarzenie FSEvents dotyczy pliku,
 * który zmienił się przed chwilą, i jest najmocniejszą przesłanką świeżości, jaką mamy.
 * Kolejność odwrotna (listing, potem `add`) gubiła je w komplecie, gdy sam listing wypełniał
 * sufit — `Set` zachowuje kolejność wstawiania.
 *
 * Klucz scalania to `rel`, a nie cały wpis: podpowiedź niesie samą nazwę, listing tę samą nazwę
 * z `mtime`. `Map.set` na istniejącym kluczu ZOSTAWIA pozycję wstawienia i podmienia wartość,
 * więc podpowiedź, którą listing też zobaczył, dostaje jego czas i nie kosztuje drugiego `stat`.
 *
 * Wydzielone z `#scan`, bo to jedyna reguła tego modułu, której nie da się sprawdzić bez
 * działającego watchera rekurencyjnego (a ten w piaskownicy dostaje `EMFILE` — nagłówek, p. 3).
 */
export function mergeScanPaths(
  hints: readonly string[], listed: readonly ScanPath[], maxEntries: number,
): ScanPath[] {
  if (hints.length === 0) return listed.slice(0, maxEntries);
  const merged = new Map<string, ScanPath>();
  for (const rel of hints) merged.set(rel, { rel });
  for (const path of listed) merged.set(path.rel, path);
  return [...merged.values()].slice(0, maxEntries);
}

/** NAJBARDZIEJ zajęty przebieg workflow (po liczbie świeżych plików agentów). */
function busiestRun(runs: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const [run, count] of runs) {
    if (count > bestCount) {
      best = run;
      bestCount = count;
    }
  }
  return best;
}

/** Ścieżka względna z watchera jest WEJŚCIEM: `..` czytałoby pliki spoza katalogu sesji. */
function safeRelative(name: string): string[] | null {
  if (name === '') return null;
  const parts = name.split(/[\\/]/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts;
}

// ---------------------------------------------------------------------------
// Puls
// ---------------------------------------------------------------------------

class Pulse implements SessionPulse {
  readonly #root: string;
  readonly #cwd: string;
  readonly #now: () => number;
  readonly #onPulse: (sample: PulseSample) => void;
  readonly #useWatch: boolean;
  readonly #throttleMs: number;
  readonly #windowMs: number;
  readonly #verifyMs: number;
  readonly #maxEntries: number;

  #uuid: string;
  /** Katalog satelity (`<transkrypt bez .jsonl>/`); `null` = jeszcze nieustalony. */
  #dir: string | null = null;
  #running = false;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #watcher: FSWatcher | null = null;
  /** Watcher rekurencyjny padł (EMFILE w piaskownicy) — od tej chwili sam skan. */
  #watchFailed = false;
  /** Ścieżki podpowiedziane przez watcher od ostatniego ticku. */
  #hints = new Set<string>();
  #ticking = false;
  /** Kiedy ostatnio zrobiliśmy PEŁNY skan (siatka na zgubione zdarzenia watchera). */
  #verifiedAt = 0;
  /** `wf_<id>` → nazwa z listingu skryptów. `''` = sprawdzone i nieznane (nie pytamy drugi raz). */
  readonly #names = new Map<string, string>();

  constructor(opts: SessionPulseOptions) {
    this.#root = opts.root ?? defaultStoreRoot();
    this.#cwd = opts.cwd;
    this.#now = opts.now ?? Date.now;
    this.#onPulse = opts.onPulse;
    this.#useWatch = opts.watch ?? true;
    const t = opts.timing ?? {};
    this.#throttleMs = t.throttleMs ?? PULSE_THROTTLE_MS;
    this.#windowMs = t.windowMs ?? PULSE_WINDOW_MS;
    this.#verifyMs = t.verifyMs ?? PULSE_VERIFY_MS;
    this.#maxEntries = opts.maxEntries ?? PULSE_MAX_ENTRIES;
    this.#uuid = opts.agentSessionId;
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------

  start(): void {
    if (this.#closed || this.#running) return;
    this.#running = true;
    this.#hints.clear();
    this.#verifiedAt = 0;
    this.#schedule();
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#stopWatch();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#hints.clear();
  }

  repoint(agentSessionId: string): void {
    if (this.#closed) return;
    const wasRunning = this.#running;
    this.stop();
    this.#uuid = agentSessionId;
    this.#dir = null;
    this.#names.clear();
    if (wasRunning) this.start();
  }

  relocated(): void {
    if (this.#closed || this.#dir === null) return;
    // Watcher wisi na STARYM katalogu (i po `rename` nie pokazuje już niczego, co nas dotyczy).
    this.#stopWatch();
    this.#dir = null;
    this.#hints.clear();
    // Podpowiedzi z watchera przepadły razem z nim — najbliższy tick ma zrobić PEŁNY skan.
    this.#verifiedAt = 0;
  }

  close(): void {
    if (this.#closed) return;
    this.stop();
    this.#closed = true;
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  #schedule(): void {
    if (!this.#running || this.#closed || this.#timer !== null) return;
    const timer = setTimeout(() => {
      this.#timer = null;
      void this.#tick().finally(() => { this.#schedule(); });
    }, this.#throttleMs);
    timer.unref?.();
    this.#timer = timer;
  }

  async #tick(): Promise<void> {
    if (!this.#running || this.#closed || this.#ticking) return;
    this.#ticking = true;
    try {
      const dir = await this.#resolveDir();
      // Katalogu satelity nie ma (sesja bez subagentów i bez dużych wyników) — cisza, nie zdarzenie.
      if (dir === null || !this.#running) return;
      this.#startWatch(dir);

      const now = this.#now();
      const full = this.#watcher === null || now - this.#verifiedAt >= this.#verifyMs;
      const hints = [...this.#hints];
      this.#hints.clear();
      // Ścieżka niepełna niesie SAME nazwy z watchera — czas dla nich policzy `#classify`.
      const paths = full ? await this.#scan(dir, hints) : hints.map((rel) => ({ rel }));
      if (full) this.#verifiedAt = now;
      if (!this.#running || this.#closed) return;

      const sample = await this.#classify(dir, paths);
      if (sample === null || !this.#running || this.#closed) return;
      this.#onPulse(sample);
    } finally {
      this.#ticking = false;
    }
  }

  /** Pełny listing + podpowiedzi watchera (plik mógł zniknąć z listingu między jednym a drugim). */
  async #scan(dir: string, hints: readonly string[]): Promise<ScanPath[]> {
    return mergeScanPaths(hints, await listFiles(dir, this.#maxEntries), this.#maxEntries);
  }

  /**
   * Ścieżki → jedna próbka. `null` = nic świeżego, czyli ŻADNEGO zdarzenia (uczciwość).
   *
   * Dowodem świeżości jest `mtime`, nie zdarzenie watchera: FSEvents potrafi odtworzyć historię
   * sprzed startu obserwacji (patrz nagłówek pliku). Czas z listingu jest tym samym dowodem
   * i wystarcza — statujemy WYŁĄCZNIE ścieżki, które przyszły bez niego (podpowiedzi watchera),
   * i to paczkami po {@link STAT_BATCH}.
   */
  async #classify(dir: string, paths: readonly ScanPath[]): Promise<PulseSample | null> {
    const now = this.#now();
    let agents = 0;
    let other = 0;
    let at = 0;
    /** `wf_<id>` → ilu jego agentów jest świeżych (0 = był tylko journal/meta). */
    const runs = new Map<string, number>();

    const entries: { parts: string[]; mtime: number | null }[] = [];
    for (const path of paths.slice(0, this.#maxEntries)) {
      const parts = safeRelative(path.rel);
      if (parts === null) continue;
      entries.push({ parts, mtime: path.mtime ?? null });
    }
    const missing = entries.filter((entry) => entry.mtime === null);
    for (let i = 0; i < missing.length; i += STAT_BATCH) {
      const batch = missing.slice(i, i + STAT_BATCH);
      const times = await Promise.all(batch.map((e) => mtimeOf(join(dir, ...e.parts))));
      for (const [j, entry] of batch.entries()) entry.mtime = times[j] ?? null;
    }

    for (const { parts, mtime } of entries) {
      // Plik zniknięty między listingiem a `stat` (albo katalog, albo brak uprawnień).
      if (mtime === null) continue;
      if (now - mtime > this.#windowMs || mtime - now > CLOCK_SKEW_MS) continue;
      if (mtime > at) at = mtime;

      const base = parts[parts.length - 1] ?? '';
      // Katalog jednego przebiegu workflow — kształt `wf_<id>` pilnuje `background/satellite.ts`.
      const run = parts.find((part) => isRunId(part));
      const isAgent = parts[0] === 'subagents' && AGENT_FILE.test(base);
      if (isAgent) agents += 1;
      else other += 1;
      if (run !== undefined) runs.set(run, (runs.get(run) ?? 0) + (isAgent ? 1 : 0));
    }

    if (agents === 0 && other === 0) return null;
    const sample: PulseSample = { agents, other, at };
    const best = busiestRun(runs);
    if (best !== null) {
      sample.runId = best;
      const name = await this.#workflowName(dir, best);
      if (name !== null) sample.workflowName = name;
      // Journal czytamy CO TICK (≤ raz na 3 s): licznik „skończyli" rośnie właśnie wtedy,
      // gdy pliki agentów przestają rosnąć — cache byłby cache'em nieaktualności.
      const done = await journalResults(
        join(dir, 'subagents', 'workflows', best, 'journal.jsonl'),
      );
      // ZERO from an existing journal is a fact too ("nobody has finished yet"): dropped as a filler,
      // it would leave the run's first agent without a bar. No journal = `null` = the field is absent.
      if (done !== null) sample.agentsDone = done;
    }
    return sample;
  }

  /** Nazwa przebiegu z listingu skryptów; `null`, gdy nazwy nie znamy. */
  async #workflowName(dir: string, best: string): Promise<string | null> {

    const cached = this.#names.get(best);
    if (cached !== undefined) return cached === '' ? null : cached;

    let entries: string[];
    try {
      entries = await readdir(join(dir, ...SCRIPTS_DIR));
    } catch {
      // Katalog skryptów może jeszcze nie istnieć — NIE zapamiętujemy porażki, spróbujemy znów.
      return null;
    }
    const suffix = `-${best}.js`;
    const hit = entries.find((entry) => entry.endsWith(suffix) && entry.length > suffix.length);
    const name = hit === undefined ? '' : hit.slice(0, hit.length - suffix.length);
    this.#names.set(best, name);
    return name === '' ? null : name;
  }

  // -------------------------------------------------------------------------
  // Katalog i watcher
  // -------------------------------------------------------------------------

  /**
   * Katalog satelity dla bieżącej sesji silnika.
   *
   * Adres liczy `locateSatelliteDir` (`background/satellite.ts`) — ten sam, z którego korzysta
   * czytnik przebiegów. `null` to także „katalogu jeszcze nie ma": powstaje dopiero przy pierwszym
   * subagencie albo dużym wyniku, więc spróbujemy za tick. Pamięć adresu zostaje TUTAJ, bo puls
   * ma własny cykl życia (watcher, `stop()`), a `relocated()` pyta, czy adres był już znany.
   */
  async #resolveDir(): Promise<string | null> {
    if (this.#dir !== null) return this.#dir;
    const dir = await locateSatelliteDir(this.#root, this.#cwd, this.#uuid);
    if (dir === null || this.#closed) return null;
    this.#dir = dir;
    return dir;
  }

  #startWatch(dir: string): void {
    if (!this.#useWatch || this.#watchFailed || this.#watcher !== null || !this.#running) return;
    try {
      // `persistent: false` — obserwator pulsu nie ma prawa trzymać procesu przy życiu.
      const watcher = watch(dir, { recursive: true, persistent: false }, (_event, name) => {
        if (typeof name !== 'string' || this.#hints.size >= this.#maxEntries) return;
        this.#hints.add(name);
      });
      watcher.on('error', () => {
        // EMFILE (piaskownica) i każda inna awaria: schodzimy na skan i nie próbujemy więcej.
        this.#watchFailed = true;
        this.#stopWatch();
      });
      this.#watcher = watcher;
    } catch {
      this.#watchFailed = true;
      this.#watcher = null;
    }
  }

  #stopWatch(): void {
    if (this.#watcher === null) return;
    const watcher = this.#watcher;
    this.#watcher = null;
    try {
      watcher.close();
    } catch {
      // Watcher po `error` bywa już zamknięty — to nie jest awaria.
    }
  }
}

/**
 * Tworzy puls dla JEDNEJ sesji panelu.
 *
 * Obiekt startuje wyłączony: obserwacja zaczyna się dopiero, gdy panel wejdzie w turę
 * (`start()` woła driver). Nic tu nie rzuca — brak katalogu, brak uprawnień i padnięty watcher
 * są normalnym stanem pracy.
 */
export function createSessionPulse(opts: SessionPulseOptions): SessionPulse {
  return new Pulse(opts);
}
