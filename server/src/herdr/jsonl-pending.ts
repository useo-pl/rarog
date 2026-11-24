/**
 * Wąski parser surowej linii jsonl — wyłącznie to, czego `parseImportLine` NIE zwraca:
 * `id` i SUROWY `input` czekającego narzędzia, tryb uprawnień, model, effort i `cwd`.
 *
 * Dlaczego osobny parser, a nie rozszerzenie `transcript-import.ts`:
 * tamten moduł celowo GUBI to, czego tu potrzebujemy. `assistantBlocksFrom` zamienia
 * `tool_use` na blok prezentacyjny (`summary` + przycięty `detail`) i wyrzuca `id` oraz pełny
 * `input` — bo jego zadaniem jest transkrypt na telefonie. Karta zgody potrzebuje czegoś
 * dokładnie odwrotnego: PEŁNEGO inputu, żeby `classifyRisk` widział to samo, co widział przy
 * SDK, i `id`, żeby dało się sparować z `tool_result`. Rozszerzenie tamtego parsera znaczyłoby
 * zmianę pliku, który jest read-only dla wszystkich (i którego używa cała warstwa treści).
 *
 * Moduł jest CZYSTY: bez I/O, bez zegara, bez logów. Okno wejściowe wyznacza wołający
 * (`HERDR_HISTORY_BYTES` ogona pliku).
 *
 * REGUŁA, KTÓRA JEST TU WAŻNIEJSZA NIŻ KOD: **tryb uprawnień z jsonl służy WYŁĄCZNIE do chipu
 * w UI i nigdy do bramki wysyłki.** Wpisy `permission-mode` powstają PO turze, więc `shift+tab`
 * naciśnięty przy biurku między turami jest w pliku niewidoczny — panel przełączony na
 * `bypass permissions` wyglądałby w jsonl na `manual` przez całą następną turę. Do bramki
 * (`commands/guard.ts`, reguła 4) tryb bierze się z odczytu stopki ekranu.
 */
import path from 'node:path';
import type { EffortLevel, HerdrMode } from '@rarog/shared';
import { EFFORT_LEVELS, MODEL_ID_PATTERN } from '@rarog/shared';
import { asRecord } from '../drivers/tool-text.ts';
import { CLI_SHAPES } from './background/cli-shapes.ts';
import { canonicalSha256 } from './dialogs/hook/canon.ts';
import { ultracodeMarkerOf } from './ultracode.ts';
import type { UltracodeMarker } from './ultracode.ts';

// ---------------------------------------------------------------------------
// Wspólny parser linii
// ---------------------------------------------------------------------------

/**
 * Jedna linia jsonl → surowy obiekt.
 *
 * Eksportowane, bo follower parsuje każdą linię DOKŁADNIE RAZ i karmi tym wszystkie funkcje
 * tego modułu oraz `jsonl-usage.ts`. Uszkodzona linia (zapis w locie, ucięty ogon) jest
 * normalnym stanem pracy — dlatego `null`, nigdy wyjątek.
 */
export function parseJsonlEntry(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Bloki treści wpisu (`message.content`); nie-tablica = brak bloków. */
function blocksOf(entry: Record<string, unknown>): readonly Record<string, unknown>[] {
  const message = asRecord(entry['message']);
  const content = message === null ? null : message['content'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Record<string, unknown>[] => {
    const block = asRecord(item);
    return block === null ? [] : [block];
  });
}

// ---------------------------------------------------------------------------
// Czekające narzędzie
// ---------------------------------------------------------------------------

export interface PendingTool {
  /** `tool_use.id` — parujemy po nim z `tool_result.tool_use_id`, nigdy po pozycji. */
  id: string;
  toolName: string;
  /**
   * SUROWY `input` narzędzia. Nie przycinamy: na tym liczy się ryzyko
   * (`docs/security-model.md`, „Starting sessions from the phone: three powers”).
   */
  input: unknown;
  /** `timestamp` wpisu; pusty string, gdy wpis go nie miał. */
  at: string;
  /**
   * Katalog WYWOŁANIA (`cwd` z payloadu hooka), względem którego dialog `Edit` pokazuje ścieżkę pliku. Niesie go
   * wyłącznie narzędzie ze zrzutu hooka (`hookPendingFrom`); a transcript entry carries its own call directory in
   * {@link entryCwd}.
   */
  cwd?: string;
  /**
   * The `cwd` field of the transcript entry that carries this `tool_use`, absolute only: the directory the call runs
   * in, also after a Bash `cd`, when the CLI registry and the herdr agent stay on the session start directory
   * (measured on CLI 2.1.330). Absent when the entry has no absolute `cwd`. The file proof of an `Edit` or `Write`
   * card resolves a relative path against it (`expectedFor` in `herdr/dialogs/decide/sources.ts`), and the session
   * facts take it as the call `cwd` (`herdr/dialogs/layer1/hook-list/session-facts.ts`).
   */
  entryCwd?: string;
}

/**
 * Wywołanie wątku głównego, które transkrypt już zamknął: wynikiem (`tool_result` z jego `id`) albo końcem tury
 * (reguła 3 trackera). Kanał zgód (warstwa 1) rozpoznaje po nim, że transkrypt poszedł dalej niż prośba hooka.
 * Pamięć zamknięć trzyma skrót wejścia, nie samo wejście: wpis ma stały rozmiar także przy dużym `Write`.
 */
export interface ClosedTool {
  id: string;
  toolName: string;
  /**
   * `canonicalSha256` SUROWEGO `input` policzony przy zamknięciu (ta sama postać co `inputSha256` zrzutu hooka);
   * `null`, gdy skrótu nie dało się policzyć.
   */
  inputSha256: string | null;
  /** `timestamp` wpisu, który zamknął wywołanie (ms epoki); `null`, gdy wpis go nie miał albo był nieczytelny. */
  closedAt: number | null;
}

/**
 * Ile ostatnich zamkniętych wywołań pamięta tracker. Wpis ma stały rozmiar (id, nazwa, skrót, chwila: ok. 0,2 KB),
 * więc 256 wpisów to ok. 50 KB na follower. Zamknięcie wyparte ponad limit nie przywraca dowodu (kanał zgód bierze
 * {@link PendingTracker.lostAt}), więc limit decyduje tylko o tym, kiedy prośba, której dialog stoi, traci dowód
 * przez serię zamknięć po starcie swojego hooka: 256 to zapas rzędu wielkości ponad wyniki jednej wiadomości
 * z kilkudziesięcioma blokami `tool_use`.
 */
export const CLOSED_TOOLS_MAX = 256;

/**
 * Stan „co czeka na decyzję" liczony PRZYROSTOWO, wpis po wpisie.
 *
 * Follower czyta plik strumieniowo i nie trzyma całego okna w pamięci, więc nie może za każdym
 * razem przeliczać `pendingToolUse(lines)`. Tracker jest tą samą regułą w postaci reduktora:
 * ta sama kolejność, te same warunki, jeden test na obu (funkcja czysta zbudowana na trackerze).
 */
export interface PendingTracker {
  /** Skarmia JEDEN sparsowany wpis (wynik `parseJsonlEntry`). */
  note(entry: unknown): void;
  /** Pierwsze niesparowane narzędzie albo `null`, gdy tura jest domknięta. */
  readonly pending: PendingTool | null;
  /**
   * WSZYSTKIE niesparowane narzędzia w kolejności bloków (kopia) — dowód „dialog stoi” w trybie cienia liczy
   * otwarte wywołania tej samej nazwy i skrótu wejścia (`docs/dialogs.md`, „Server in shadow mode”).
   */
  readonly open: readonly PendingTool[];
  /**
   * Ostatnie zamknięte wywołania (najwyżej {@link CLOSED_TOOLS_MAX}, najstarsze pierwsze; kopia) z chwilą wpisu,
   * który je zamknął. Wynik bez znanego `tool_use` niczego tu nie dodaje, ale przesuwa {@link lostAt}.
   */
  readonly closed: readonly ClosedTool[];
  /**
   * Najpóźniejsza chwila (ms epoki) zamknięcia, którego {@link closed} nie ma, choć mogło się zdarzyć: wpis wyparty
   * ponad {@link CLOSED_TOOLS_MAX}, wynik bez znanego `tool_use` (okno zaczęło się między nimi) albo luka zgłoszona
   * przez {@link lose}. `null` = żadnego takiego. Zamknięcie bez czytelnej chwili niczego tu nie zmienia, bo
   * w {@link closed} też by się nie liczyło.
   */
  readonly lostAt: number | null;
  /**
   * Zgłasza utratę zamknięć do chwili `at` (po stronie wołającego: luka odczytu, skrócenie pliku albo okno ogona
   * zaczęte w środku pliku).
   */
  lose(at: number): void;
}

/**
 * Tworzy tracker czekających narzędzi.
 *
 * Trzy reguły, każda z powodu:
 *
 * 1. **Parowanie po `id`**, nigdy po pozycji. `tool_result` bez znanego `tool_use` (okno ogona
 *    zaczęło się w środku tury, albo plik jest posklejany) zapamiętuje `id` jako ROZLICZONE —
 *    dzięki temu `tool_result` PRZED swoim `tool_use` daje `null`, a nie wyjątek i nie kartę.
 * 2. **Przy kilku czekających bierzemy PIERWSZY** — CLI pyta w kolejności bloków, więc dialog
 *    na ekranie dotyczy najstarszego niesparowanego wywołania.
 * 3. **Wypowiedź człowieka domyka wszystko, co czekało.** Przerwana tura
 *    (`[Request interrupted by user]`) zostawia w pliku `tool_use` bez pary NA ZAWSZE; bez tej
 *    reguły Rarog pokazywałby kartę zgody dla narzędzia, o które nikt już nie pyta. To jest
 *    dopisek wymuszony kształtem realnego pliku — kierunek jest bezpieczny:
 *    gubimy kartę, nigdy jej nie dorabiamy.
 */
export function createPendingTracker(): PendingTracker {
  const open: PendingTool[] = [];
  const settled = new Set<string>();
  const closed: ClosedTool[] = [];
  let lostAt: number | null = null;

  const lose = (at: number | null): void => {
    if (at !== null && (lostAt === null || at > lostAt)) lostAt = at;
  };

  const remember = (tool: PendingTool, closedAt: number | null): void => {
    closed.push({ id: tool.id, toolName: tool.toolName, inputSha256: digestOf(tool.input), closedAt });
    if (closed.length <= CLOSED_TOOLS_MAX) return;
    for (const dropped of closed.splice(0, closed.length - CLOSED_TOOLS_MAX)) lose(dropped.closedAt);
  };

  const close = (id: string, closedAt: number | null): void => {
    const index = open.findIndex((tool) => tool.id === id);
    if (index === -1) {
      // Wynik bez znanego `tool_use`: zamknięcie, którego pamięć nie ma. Powtórny wynik rozliczonego `id` nie.
      if (!settled.has(id)) lose(closedAt);
      settled.add(id);
      return;
    }
    settled.add(id);
    const [tool] = open.splice(index, 1);
    if (tool !== undefined) remember(tool, closedAt);
  };

  return {
    note(value: unknown): void {
      const entry = asRecord(value);
      // Podagent pisze do WŁASNEGO pliku; jego wywołania nie są dialogiem tego panelu.
      if (entry === null || entry['isSidechain'] === true) return;
      /*
       * `isMeta` to wpis WSTRZYKNIĘTY przez silnik w kształcie wypowiedzi człowieka, a nie
       * wypowiedź człowieka. Reguła 3 niżej — „wypowiedź człowieka domyka wszystko, co
       * czekało" — brała go za jedno i drugie, więc pending gasł na `[Image: …]`, na
       * `<local-command-caveat>`, na tiku pętli i (najgorsze) na `cross-session-message` od
       * innej sesji, który przychodzi ASYNCHRONICZNIE — także w środku stojącego dialogu.
       * Karta z pełną treścią była wtedy podmieniana na ekranową albo na fallback, bez
       * żadnego zdarzenia w panelu. Zmierzone na 25 transkryptach z `~/.claude/projects`:
       * 428 wpisów `isMeta`, w tym 29 wiadomości międzysesyjnych, i 4 trafienia w otwarty
       * `tool_use`. Przerwanie tury (`[Request interrupted by user]`) `isMeta` NIE MA
       * (sprawdzone na żywych plikach), więc reguła 3 dalej działa tam, gdzie ma działać.
       */
      if (entry['isMeta'] === true) return;
      const type = entry['type'];
      const blocks = blocksOf(entry);

      if (type === 'assistant') {
        const at = asText(entry['timestamp']);
        const cwd = asText(entry['cwd']);
        const entryCwd = path.isAbsolute(cwd) ? { entryCwd: cwd } : {};
        for (const block of blocks) {
          if (block['type'] !== 'tool_use') continue;
          const id = asText(block['id']);
          const toolName = asText(block['name']);
          if (id === '' || toolName === '') continue;
          if (settled.has(id) || open.some((tool) => tool.id === id)) continue;
          open.push({ id, toolName, input: block['input'], at, ...entryCwd });
        }
        return;
      }

      if (type !== 'user') return;
      const closedAt = epochOf(entry['timestamp']);
      const results = blocks.filter((block) => block['type'] === 'tool_result');
      if (results.length > 0) {
        for (const block of results) {
          const id = asText(block['tool_use_id']);
          if (id !== '') close(id, closedAt);
        }
        return;
      }
      // Wpis `user`, który nie jest wynikiem narzędzia: nowa wypowiedź albo przerwanie tury.
      for (const tool of open.splice(0)) {
        settled.add(tool.id);
        remember(tool, closedAt);
      }
    },
    get pending(): PendingTool | null {
      return open[0] ?? null;
    },
    get open(): readonly PendingTool[] {
      return [...open];
    },
    get closed(): readonly ClosedTool[] {
      return [...closed];
    },
    get lostAt(): number | null {
      return lostAt;
    },
    lose(at: number): void {
      lose(at);
    },
  };
}

/** Skrót wejścia jak `inputSha256` zrzutu hooka; `null`, gdy się nie da (wejście z `JSON.parse` zawsze się da). */
function digestOf(input: unknown): string | null {
  try {
    return canonicalSha256(input);
  } catch {
    return null;
  }
}

/** `timestamp` wpisu jako ms epoki; `null`, gdy go nie ma albo nie da się go odczytać. */
function epochOf(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Chwila (ms epoki) wpisu `assistant` wątku głównego; `null` dla innego wpisu albo wpisu bez czytelnej chwili. Taki wpis
 * nie jest starszy niż żadne zamknięcie zapisane przed nim, więc follower liczy od niego utratę pokrycia okna ogona
 * (`jsonl-follow.ts`, `#primeOnce`).
 */
export function mainAssistantAt(value: unknown): number | null {
  const entry = asRecord(value);
  if (entry === null || entry['type'] !== 'assistant' || entry['isSidechain'] === true) return null;
  return epochOf(entry['timestamp']);
}

/** Otwarte i ostatnie zamknięte wywołania okna (ta sama reguła co tracker followera). */
export interface TranscriptTools {
  readonly open: PendingTool[];
  readonly closed: ClosedTool[];
  /** {@link PendingTracker.lostAt}. */
  readonly lostAt: number | null;
}

/**
 * Otwarte i zamknięte `tool_use` okna — {@link openToolUses} z listą ostatnich zamkniętych (czytnik procesu pomiaru,
 * który czyta plik sam).
 *
 * @param lines linie okna ogona pliku (kolejność zapisu)
 */
export function transcriptToolUses(lines: readonly string[]): TranscriptTools {
  const tracker = createPendingTracker();
  for (const line of lines) tracker.note(parseJsonlEntry(line));
  return { open: [...tracker.open], closed: [...tracker.closed], lostAt: tracker.lostAt };
}

/**
 * Wszystkie niesparowane `tool_use` okna — ta sama reguła co {@link pendingToolUse}, bez zawężenia do pierwszego.
 *
 * @param lines linie okna ogona pliku (kolejność zapisu)
 */
export function openToolUses(lines: readonly string[]): PendingTool[] {
  const tracker = createPendingTracker();
  for (const line of lines) tracker.note(parseJsonlEntry(line));
  return [...tracker.open];
}

/**
 * Ostatni `tool_use`, którego `id` nie ma `tool_result`.
 *
 * @param lines linie okna ogona pliku (kolejność zapisu)
 * @returns czekające narzędzie albo `null`, gdy tura jest domknięta
 */
export function pendingToolUse(lines: readonly string[]): PendingTool | null {
  const tracker = createPendingTracker();
  for (const line of lines) tracker.note(parseJsonlEntry(line));
  return tracker.pending;
}

// ---------------------------------------------------------------------------
// Fakty tury dla kanału zgód (warstwa 1)
// ---------------------------------------------------------------------------

/**
 * Wynik narzędzia z tym, co wpis mówi o rozstrzygnięciu dialogu zgody (CLI 2.1.314): `permissionDecision`
 * wpisu `user` z blokiem `tool_result` (`source`: `hook`, `user_temporary`, `user_permanent`, `user_reject`,
 * `config`…; `decision`: `accept`, `reject`) i przerwanie przy biurku (Esc: wynik z błędem bez źródła).
 */
export interface ToolResultDecision {
  toolUseId: string;
  /** `permissionDecision.decision` albo `null`. */
  decision: string | null;
  /** `permissionDecision.source` albo `null`. */
  source: string | null;
  /** Wynik z błędem i tekstem przerwania przy biurku. */
  interrupted: boolean;
  /** `timestamp` wpisu (ms epoki) albo `null`. */
  at: number | null;
}

/** Tekst wyniku po przerwaniu dialogu przy biurku (Esc) i po odmowie bez hooka. */
const INTERRUPTED_RESULT = /interrupted by user|doesn't want to proceed/;

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    const block = asRecord(item);
    return block === null ? '' : asText(block['text']);
  }).join('\n');
}

function timestampOf(entry: Record<string, unknown>): number | null {
  const parsed = Date.parse(asText(entry['timestamp']));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Wpis wątku głównego (nie subagenta) albo `null`. */
function mainEntry(value: unknown): Record<string, unknown> | null {
  const entry = asRecord(value);
  return entry === null || entry['isSidechain'] === true ? null : entry;
}

/**
 * Wyniki narzędzi wpisu wątku głównego z rozstrzygnięciem dialogu; inny wpis = pusta lista. Moduł nie ocenia skutku:
 * robi to `dialogs/layer1/proof.ts`.
 */
export function toolResultDecisions(value: unknown): ToolResultDecision[] {
  const entry = mainEntry(value);
  if (entry === null || entry['type'] !== 'user') return [];
  const permission = asRecord(entry['permissionDecision']);
  const decision = permission === null ? '' : asText(permission['decision']);
  const source = permission === null ? '' : asText(permission['source']);
  const at = timestampOf(entry);
  return blocksOf(entry).flatMap((block): ToolResultDecision[] => {
    if (block['type'] !== 'tool_result') return [];
    const toolUseId = asText(block['tool_use_id']);
    if (toolUseId === '') return [];
    const interrupted = block['is_error'] === true && INTERRUPTED_RESULT.test(resultText(block['content']));
    return [{ toolUseId, decision: decision === '' ? null : decision, source: source === '' ? null : source,
      interrupted, at }];
  });
}

/** Wywołanie narzędzia z wpisu asystenta: `id`, nazwa i SUROWE wejście (bez `promptId`: wpis go nie niesie). */
export interface TurnToolUseEntry {
  id: string;
  toolName: string;
  input: unknown;
}

/** Wywołania narzędzi wpisu asystenta wątku głównego, w kolejności bloków; inny wpis = pusta lista. */
export function turnToolUses(value: unknown): TurnToolUseEntry[] {
  const entry = mainEntry(value);
  if (entry === null || entry['type'] !== 'assistant') return [];
  return blocksOf(entry).flatMap((block): TurnToolUseEntry[] => {
    if (block['type'] !== 'tool_use') return [];
    const id = asText(block['id']);
    const toolName = asText(block['name']);
    return id === '' || toolName === '' ? [] : [{ id, toolName, input: block['input'] }];
  });
}

/** Wpis przerwania tury (`[Request interrupted by user…]`): niesie `promptId` przerwanej tury, nie otwiera nowej. */
export const INTERRUPTION_TEXT = /^\[Request interrupted/;

/** Tura wpisu `user` (wynik {@link turnPromptOf}). */
export interface TurnPrompt {
  promptId: string;
  /** Wpis człowieka, nie wstrzyknięty przez silnik (`isMeta`). */
  human: boolean;
  /** Wpis z blokiem `tool_result`. */
  result: boolean;
  /** Wpis przerwania tury. */
  interruption: boolean;
}

/**
 * Tura, do której należy wpis `user` wątku głównego. Wyniki narzędzi i przerwanie niosą `promptId` swojej tury,
 * wpisy `tool_use` nie niosą go wcale, więc turę wywołania wyznacza ostatni wcześniejszy wpis z `promptId`.
 * Turę otwiera wpis człowieka, który nie jest ani wynikiem, ani przerwaniem. Inny wpis = `null`.
 */
export function turnPromptOf(value: unknown): TurnPrompt | null {
  const entry = mainEntry(value);
  if (entry === null || entry['type'] !== 'user') return null;
  const promptId = asText(entry['promptId']);
  if (promptId === '') return null;
  const blocks = blocksOf(entry);
  const result = blocks.some((block) => block['type'] === 'tool_result');
  const message = asRecord(entry['message']);
  const content = message === null ? null : message['content'];
  const text = typeof content === 'string' ? content : blocks.map((block) => asText(block['text'])).join('');
  return { promptId, human: entry['isMeta'] !== true, result, interruption: INTERRUPTION_TEXT.test(text) };
}

/** Koniec tury wątku głównego: `system/turn_duration` (także po przerwaniu tury). */
export function isTurnEnd(value: unknown): boolean {
  const entry = mainEntry(value);
  return entry !== null && entry['type'] === 'system' && entry['subtype'] === 'turn_duration';
}

// ---------------------------------------------------------------------------
// Model, effort, tryb
// ---------------------------------------------------------------------------

/**
 * `permissionMode` z jsonl → `HerdrMode`.
 *
 * Lista jest ZAMKNIĘTA, a wszystko spoza niej to `unknown` — **nigdy cichy `manual`**.
 * `manual` znaczy „ten panel zapyta o każdą operację" i jest najłagodniejszym chipem, jaki
 * Rarog potrafi pokazać; wypisanie go dla trybu, którego nie rozumiemy, byłoby obietnicą kart
 * zgody, których nie będzie. `unknown` mówi prawdę: nie wiem.
 */
export const PERMISSION_MODE_MAP: Readonly<Record<string, HerdrMode>> = {
  default: 'manual',
  acceptEdits: 'auto',
  auto: 'auto',
  plan: 'plan',
  bypassPermissions: 'bypass',
};

export interface JsonlMeta {
  /** `message.model` wpisu asystenta — identyfikator ROZWIĄZANY przez silnik. */
  model?: string;
  /** Top-level `effort` wpisu asystenta; `null` w pliku = brak pola. */
  effort?: EffortLevel;
  /** Tryb uprawnień DO CHIPU. Nigdy do bramki wysyłki — patrz nagłówek pliku. */
  mode?: HerdrMode;
  /**
   * Ultracode bieżącego procesu CLI: stan {@link UltracodeTracker} followera, nie pole jednego wpisu
   * ({@link metaOf} go nie ustawia). Brak = brak dowodu, karta bez zmiany. `null` = dowód przestał się liczyć
   * (start nowego procesu CLI tej rozmowy, `/exit` i `claude --resume` przy biurku, albo luka w odczycie pliku):
   * karta traci pole, bo bez tego zostałaby przy stanie, którego nic już nie potwierdza.
   */
  ultracode?: boolean | null;
}

/**
 * Model / effort / tryb z JEDNEGO sparsowanego wpisu.
 *
 * @returns wypełnione pola albo `null`, gdy wpis nie niesie żadnego z nich
 */
export function metaOf(value: unknown): JsonlMeta | null {
  const entry = asRecord(value);
  if (entry === null || entry['isSidechain'] === true) return null;
  const meta: JsonlMeta = {};

  if (entry['type'] === 'assistant') {
    const message = asRecord(entry['message']);
    const model = message === null ? '' : asText(message['model']);
    // `<synthetic>` (błąd API zapisany jako wiadomość) nie przechodzi wzorca i dlatego nie
    // zatruwa pigułki modelu — ta sama reguła co w `transcript-import.ts`.
    if (MODEL_ID_PATTERN.test(model)) meta.model = model;
    const effort = asText(entry['effort']);
    const known = EFFORT_LEVELS.find((level) => level === effort);
    if (known !== undefined) meta.effort = known;
  }

  // `permissionMode` niosą i wpisy `user`, i osobne wpisy `type: "permission-mode"`.
  const mode = entry['permissionMode'];
  if (typeof mode === 'string' && mode !== '') {
    meta.mode = PERMISSION_MODE_MAP[mode] ?? 'unknown';
  }

  return meta.model === undefined && meta.effort === undefined && meta.mode === undefined
    ? null
    : meta;
}

/** To samo co {@link metaOf}, ale dla nieprzeparsowanej linii (wygodne w testach i w managerze). */
export function metaFrom(line: string): JsonlMeta | null {
  return metaOf(parseJsonlEntry(line));
}

// ---------------------------------------------------------------------------
// Ultracode bieżącego procesu CLI
// ---------------------------------------------------------------------------

/**
 * Stan ultracode z pliku rozmowy: reguły nad znacznikami jednego wpisu (`ultracodeMarkerOf` w `ultracode.ts`).
 *
 * Cztery reguły, wszystkie po stronie czytelnika pliku, bo słowa CLI stoją w `ultracode.ts`, a tu tylko ich czas
 * i kolejność:
 *
 * 1. **Liczy się bieżący proces CLI.** Znacznik liczy się, gdy jego `timestamp` nie jest starszy od startu
 *    procesu ({@link UltracodeTracker.processStarted}, rejestr sesji CLI); bez tej chwili od żądania Raroga
 *    ({@link UltracodeTracker.requested}); bez żadnej nie liczy się nic. `--resume` startuje nowy proces bez
 *    ultracode (pomiar 2.1.317), więc załącznik z historii sprzed startu mówi o procesie, którego już nie ma.
 * 2. **Ostatni znacznik wygrywa** (załącznik `ultra_effort_enter|exit` albo wynik komendy w bezczynności).
 * 3. **Pierwsza tura po żądanym włączeniu.** Pomiar (2.1.317): pierwsza tura człowieka po włączeniu zaczyna się
 *    załącznikiem `ultra_effort_enter`; po `--resume` z flagą nie (pomiar 2.1.318), więc tam reguły nie ma
 *    (`requested(…, false)`). Prompt człowieka (`origin.kind` = `human`, bez `isMeta`, poza subagentem) młodszy od
 *    żądania, po którym pierwszy wpis asystenta (z modelem, czyli nie `<synthetic>`) przychodzi bez
 *    znacznika, znaczy „CLI nie włączyło ultracode” (wyłączone workflow, odmowa) → `false`. Reguła tylko po
 *    ŻĄDANIU: kolejne tury bez załącznika niczego nie dowodzą (zmierzone), a wpisy komend lokalnych, notki
 *    o zadaniach w tle i wiadomości subagentów nie są promptem człowieka. Nowy prompt przed odpowiedzią
 *    (przerwana tura) zaczyna okno od nowa; luka w odczycie ({@link UltracodeTracker.lost}) gasi regułę.
 * 4. **Utrata dowodu zdejmuje stan z karty.** Karta może nieść wartość, której tracker w {@link
 *    UltracodeTracker.value} nie ma: żądane `true` z flagi startu albo wynik komendy rozpoznany na ekranie. Dwa
 *    zdarzenia unieważniają i ją, i znany stan.
 *    Nowy proces spoza Raroga: każde uruchomienie przez Raroga (start, „Wznów”, restart) dostaje nowy czytelnik
 *    pliku, więc drugi, późniejszy start w tym samym trackerze to `/exit` i `claude --resume` przy biurku. Żądanie
 *    nie młodsze od startu poprzedniego procesu mówiło o procesie, którego już nie ma, i przepada razem z regułą
 *    pierwszej tury; komenda młodsza od tego startu zostaje, bo mogła trafić już do nowego procesu, o którym
 *    rejestr powie później. Luka w odczycie (przeskok, skrócenie pliku): pominięty kawałek mógł nieść wynik
 *    `Ultracode off` i `ultra_effort_exit`, a kolejne tury znacznika nie powtarzają, więc znany stan przepada,
 *    a chwila żądania zostaje odcięciem. W obu przypadkach tracker zgłasza zmianę, gdy karta mogła coś nieść
 *    (stan albo żądanie), także przy `undefined` przed i po: czytelnik wysyła wtedy `null`, nie brak pola.
 *
 * Brak dowodu to `undefined` („nie wiem”), nigdy `false`: ustawienia Claude Code mogą włączyć ultracode bez
 * wiedzy Raroga. Moduł jest czysty jak reszta pliku: czas wpisów z `timestamp`, chwile od wołającego.
 */
export interface UltracodeTracker {
  /** Bieżący stan; `undefined` = brak dowodu z bieżącego procesu. */
  readonly value: boolean | undefined;
  /** Jeden sparsowany wpis pliku, w kolejności pliku. @returns czy {@link value} się zmieniło */
  note(entry: unknown): boolean;
  /**
   * Start jedynego procesu CLI tej rozmowy (ms epoki). Start późniejszy od znanego to nowy proces spoza Raroga
   * (reguła 4): żądanie nie młodsze od startu poprzedniego procesu przepada razem z regułą pierwszej tury.
   * Wcześniejszy start to poprawka chwili tego samego procesu i przelicza tylko odcięcie.
   * @returns czy karta ma się zmienić: {@link value} inne albo przepadło żądanie, które karta mogła nieść
   */
  processStarted(atMs: number): boolean;
  /**
   * Rarog zażądał włączenia o `atMs` (flaga startu albo komenda). Chwila jest odcięciem bez startu procesu;
   * `firstTurn` (domyślnie tak) uzbraja regułę pierwszej tury, `false` ją gasi: proces wznowiony z flagą
   * (`--resume`) ma ultracode, ale jego pierwsza tura załącznika nie ma (pomiar 2.1.318).
   */
  requested(atMs: number, firstTurn?: boolean): void;
  /**
   * Luka w odczycie (przeskok, skrócenie pliku; reguła 4): znany stan przepada ({@link value} → `undefined`),
   * a reguła pierwszej tury nie ma już z czego wnioskować. Chwila żądania zostaje odcięciem.
   * @returns czy karta mogła coś nieść (stan albo żądanie), czyli czy wysłać „nie wiem”
   */
  lost(): boolean;
}

const HUMAN_ORIGIN = CLI_SHAPES.queuedPrompt.literals;

function entryTime(entry: Record<string, unknown>): number | null {
  const raw = entry['timestamp'];
  if (typeof raw !== 'string') return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

/** Prompt człowieka w wątku głównym: wpis `user` bez `isMeta` z pochodzeniem `human` (pomiar 2.1.317). */
function isHumanPrompt(entry: Record<string, unknown>): boolean {
  return entry['type'] === 'user' && entry['isSidechain'] !== true && entry['isMeta'] !== true
    && asRecord(entry[HUMAN_ORIGIN.origin])?.[HUMAN_ORIGIN.kind] === HUMAN_ORIGIN.human;
}

/** Odpowiedź asystenta wątku głównego z prawdziwym modelem (`<synthetic>`, błąd API, się nie liczy). */
function isAssistantReply(entry: Record<string, unknown>): boolean {
  return entry['type'] === 'assistant' && metaOf(entry)?.model !== undefined;
}

export function createUltracodeTracker(): UltracodeTracker {
  /** Ostatni znacznik pliku albo wynik reguły pierwszej tury, z czasem wpisu. */
  let last: UltracodeMarker | null = null;
  let startedAt: number | null = null;
  let requestedAt: number | null = null;
  /** Reguła pierwszej tury: `armed` czeka na prompt człowieka, `turn` na pierwszą odpowiedź tej tury. */
  let rule: 'off' | 'armed' | 'turn' = 'off';
  let turnAt = 0;
  let value: boolean | undefined;

  const refresh = (): boolean => {
    const from = startedAt ?? requestedAt;
    const next = last === null || last.at === null || from === null || last.at < from ? undefined : last.value;
    if (next === value) return false;
    value = next;
    return true;
  };

  return {
    get value() { return value; },
    note(raw) {
      const entry = asRecord(raw);
      if (entry === null) return false;
      const marker = ultracodeMarkerOf(entry);
      if (marker !== null) {
        last = marker;
        // Jawny znacznik po żądaniu rozstrzyga sam: reguła pierwszej tury nie ma już czego dowodzić.
        if (rule !== 'off' && marker.at !== null && requestedAt !== null && marker.at >= requestedAt) rule = 'off';
        return refresh();
      }
      if (rule === 'off') return false;
      if (isHumanPrompt(entry)) {
        const at = entryTime(entry);
        if (at !== null && requestedAt !== null && at >= requestedAt) {
          rule = 'turn';
          turnAt = at;
        }
        return false;
      }
      if (rule !== 'turn' || !isAssistantReply(entry)) return false;
      rule = 'off';
      last = { value: false, at: turnAt };
      return refresh();
    },
    processStarted(atMs) {
      if (startedAt === atMs) return false;
      // Nowy proces spoza Raroga (reguła 4): żądanie sprzed startu poprzedniego mówiło o procesie, którego nie ma.
      const staleRequest = startedAt !== null && atMs > startedAt && requestedAt !== null && requestedAt <= startedAt;
      if (staleRequest) {
        requestedAt = null;
        rule = 'off';
      }
      startedAt = atMs;
      return refresh() || (staleRequest && value === undefined);
    },
    requested(atMs, firstTurn = true) {
      requestedAt = atMs;
      rule = firstTurn ? 'armed' : 'off';
    },
    lost() {
      const carried = value !== undefined || requestedAt !== null;
      rule = 'off';
      last = null;
      value = undefined;
      return carried;
    },
  };
}

/** Ustawienia, na których rozmowa skończyła — do WZNOWIENIA, nie do chipu. */
export interface ResumeSettings {
  /** `message.model` ostatniego wpisu asystenta — identyfikator ROZWIĄZANY, wyłącznie do karty. */
  model?: string;
  /** `effort` tego samego wpisu. */
  effort?: EffortLevel;
  /**
   * Ostatnie `permissionMode` w SUROWEJ wartości CLI (`default`, `acceptEdits`, `auto`, `plan`,
   * `bypassPermissions`…). Surowej, bo {@link PERMISSION_MODE_MAP} zwija `acceptEdits` do `auto` —
   * dobre dla chipu, złe dla flagi startu.
   */
  permissionMode?: string;
  /**
   * Ostatni znacznik ultracode rozmowy (`ultracodeMarkerOf`), bez odcięcia po czasie: `--resume` startuje
   * nowy proces bez ultracode, więc znacznik mówi o ostatnim stanie rozmowy, nie o procesie, który ją wznowi.
   * Brak = plik o ultracode nic nie mówi.
   */
  ultracode?: boolean;
}

/**
 * Model, effort i tryb, na których rozmowa skończyła — z ogona jej pliku, od końca.
 *
 * Wpisy subagentów (`isSidechain`) pomijamy: niosą model i effort subagenta, nie rozmowy.
 * Model i effort biorą się z JEDNEGO wpisu asystenta (ostatniego z poprawnym modelem), żeby nie
 * skleić modelu jednej tury z effortem innej. Tryb niosą i wpisy `user`, i `permission-mode`.
 * Ultracode: ostatni znacznik z okna (załącznik pierwszej tury albo wynik komendy), niezależnie od tury.
 *
 * Koszt: pętla kończy się, gdy zna turę, tryb i znacznik. Rozmowa bez znacznika ultracode (większość) parsuje więc
 * całe okno ogona (`HERDR_HISTORY_BYTES`, 1 MiB), a nie kilka ostatnich linii. Zmierzone: 3–5 ms na 1 MiB, raz na
 * wznowienie (`settingsOf`, po bramkach katalogu i przed startem panelu), więc wcześniejszego wyjścia nie ma.
 */
export function resumeSettingsFrom(lines: readonly string[]): ResumeSettings {
  const settings: ResumeSettings = {};
  let turnSeen = false;
  let ultracodeSeen = false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = asRecord(parseJsonlEntry(lines[i] ?? ''));
    if (entry === null || entry['isSidechain'] === true) continue;
    if (!ultracodeSeen) {
      const marker = ultracodeMarkerOf(entry);
      if (marker !== null) {
        ultracodeSeen = true;
        settings.ultracode = marker.value;
      }
    }
    if (settings.permissionMode === undefined) {
      const mode = asText(entry['permissionMode']);
      if (mode !== '') settings.permissionMode = mode;
    }
    if (!turnSeen && entry['type'] === 'assistant') {
      const message = asRecord(entry['message']);
      const model = message === null ? '' : asText(message['model']);
      if (MODEL_ID_PATTERN.test(model)) {
        turnSeen = true;
        settings.model = model;
        const effort = EFFORT_LEVELS.find((level) => level === asText(entry['effort']));
        if (effort !== undefined) settings.effort = effort;
      }
    }
    if (turnSeen && settings.permissionMode !== undefined && ultracodeSeen) break;
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Katalog sesji
// ---------------------------------------------------------------------------

/**
 * `cwd` z OSTATNIEGO wpisu, który je niesie.
 *
 * Do walidacji `resumeFrom` (`docs/security-model.md`, „Starting sessions from the phone: three powers”):
 * `--resume <uuid z innego katalogu>` DZIAŁA, a jsonl
 * dopisuje się wtedy do ORYGINALNEGO sluga — więc bez tego odczytu jedno pole w POST
 * ładowałoby na telefon całą historię cudzego projektu i dopisywało do niej dalej.
 * Bierzemy OSTATNI wpis, bo sesja przeniesiona między katalogami ma w ogonie ten katalog,
 * w którym pisze TERAZ.
 *
 * @returns ścieżka albo `null`, gdy żaden wpis okna nie ma `cwd`
 */
export function cwdFrom(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = asRecord(parseJsonlEntry(lines[i] ?? ''));
    if (entry === null) continue;
    const cwd = asText(entry['cwd']);
    if (cwd !== '') return cwd;
  }
  return null;
}
