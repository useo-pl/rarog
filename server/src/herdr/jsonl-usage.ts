/**
 * Okno kontekstu sesji z pliku jsonl: ILE tokenów zajmuje rozmowa i czy w ogóle wiemy, ILE się
 * w nią mieści. Czyste funkcje nad surowym wpisem — bez I/O, bez zegara, bez logów.
 *
 * Jedna reguła jest tu ważniejsza niż cały kod: **limitu nigdy nie zgadujemy**.
 *
 * W jsonl nie ma limitu okna, a identyfikator modelu we wpisie `assistant` (`message.model`) okna
 * nie rozstrzyga: ten sam `claude-fable-5` ma domyślnie okno 1M, a przy
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` 200K (docs `model-config.md`, „Extended context” i „Turn off
 * 1M context”; skan 906 transkryptów, wersja CLI nieznana: maksimum 885 852
 * tokeny dla `claude-fable-5`). Wariant wprost niesie tylko `toolUseResult.resolvedModel` wyniku
 * `Agent`, czyli model subagenta (`claude-opus-5-5[1m]`, fixture
 * `tasks/incydent-postoj-agenta-2.1.295.jsonl`). Zgadywanie „najmniejszy próg
 * ≥ maksimum" pokazywałoby sesji 1M ~92 % przy 185k, a potem — po przekroczeniu progu — skok
 * na 18 %. To nie jest kosmetyka: pasek 92 % na telefonie znaczy „kompaktuj albo zaczynaj od
 * nowa", czyli alarm, po którym człowiek przerywa pracę bez powodu.
 *
 * Dopóki limit nie jest POTWIERDZONY, stan to `{kind:'unknown', tokens}`. Potwierdzeniem jest
 * jedno z dwojga, w kolejności wiarygodności:
 *
 * 1. **payload status line** (`statusline.ts`) — silnik podaje `context_window_size` WPROST,
 *    o sobie. To nie jest pomiar ani założenie, tylko odpowiedź, więc bije tabelę modelu,
 *    a przy sesjach spoza tej maszyny (brak zrzutu) po prostu go nie ma;
 * 2. model z `KNOWN_CONTEXT_LIMITS`: podany przez RAROGA we fladze `--model` albo rozwiązany
 *    identyfikator z jsonl (sesja bez flagi modelu jest domyślna, a domyślny model konta może być
 *    wariantem `[1m]`).
 *
 * Granica kompakcji (`compact_boundary`) limitu NIE potwierdza, przy żadnym triggerze. Jej
 * `compactMetadata.preTokens` mówi tylko, ile się w oknie ZMIEŚCIŁO, więc podnosi dolną granicę
 * (`atLeast`), a nie limit. Przy `trigger: "auto"` to próg automatycznej kompakcji, a próg jest
 * ustawieniem, nie rozmiarem okna. Docs `model-config.md` („Default auto-compact thresholds”): bez ustawionego okna kompakcja przychodzi przy limicie kontekstu modelu, ale
 * modele z natywnym 1M kompaktują ok. 967K, a próg zmieniają `/autocompact`, `autoCompactWindow`,
 * `--autocompact` i `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Próg wzięty za okno zawyżyłby procent: przy
 * progu 400k i 340k tokenów w oknie 1M pasek pokazałby 85 % zamiast 34 %.
 * `trigger: "manual"` znaczy tylko tyle, że człowiek nacisnął `/compact`, a to mógł zrobić przy
 * 40k tokenów.
 */
import type { ContextLimitState } from '@rarog/shared';
import { asRecord } from '../drivers/tool-text.ts';

/**
 * Składniki sumy zużycia okna.
 *
 * Wzór jest DOKŁADNIE ten sam, którego używał `extractUsage` ze sdk-drivera — sprawdzone
 * liczbowo na fixture `transcript-usage.jsonl`: suma ostatniego wpisu `assistant` przed
 * granicą kompakcji równa się co do tokena `preTokens` tej granicy (462 682). Zmiana tego
 * zestawu pól rozjechałaby widget kontekstu z tym, co silnik uważa za pełne okno.
 */
const USAGE_FIELDS = [
  'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens',
] as const;

/** Liczba nieujemna i skończona albo `null` — JSON z cudzego pliku bywa czymkolwiek. */
function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Suma zużycia okna z JEDNEGO wpisu `assistant`.
 *
 * Brakujące składniki liczą się jako 0 (starsze CLI nie zapisywało `cache_creation`), ale sam
 * BRAK obiektu `usage` daje `null`, a nie 0: „nie wiem" i „zero tokenów" to dwie różne rzeczy,
 * a licznik cofnięty do zera przy pierwszym wpisie `user` byłby migotaniem widgetu.
 *
 * @param entry sparsowany wpis jsonl (jedna linia pliku)
 * @returns suma tokenów okna albo `null`, gdy wpis nie jest wypowiedzią asystenta z `usage`
 */
export function usageFrom(entry: unknown): number | null {
  const record = asRecord(entry);
  if (record === null || record['type'] !== 'assistant') return null;
  const message = asRecord(record['message']);
  const usage = message === null ? null : asRecord(message['usage']);
  if (usage === null) return null;
  let sum = 0;
  for (const field of USAGE_FIELDS) sum += asCount(usage[field]) ?? 0;
  return sum;
}

/**
 * Zużycie okna PO kompakcji — z granicy, z KAŻDYM triggerem.
 *
 * `postTokens` jest w tej samej jednostce co `usageFrom` (fixture: granica ma `postTokens`
 * 14 002, a pierwszy wpis asystenta po niej sumuje się dokładnie do 14 002), więc wolno je
 * wstawić wprost jako bieżącą liczbę tokenów.
 *
 * Rozmiaru okna granica nie mówi (nagłówek pliku), ale ILE ZOSTAŁO w oknie mówi każda —
 * i to jest jedyny moment, w którym licznik potrafi spaść BEZ nowej wypowiedzi asystenta.
 * Bez tego widget po `/compact` wisiałby na liczbie sprzed cięcia aż do następnej odpowiedzi.
 *
 * Zero jest wartością POPRAWNĄ (okno wyczyszczone do zera), więc odsiewamy tylko brak pola
 * i śmieci — inaczej `/clear`-podobna granica zostawiłaby starą liczbę.
 *
 * @returns liczba tokenów po kompakcji albo `null`, gdy wpis nie jest granicą z tym polem
 */
export function compactPostTokensFrom(entry: unknown): number | null {
  const meta = compactMetadataOf(entry);
  if (meta === null) return null;
  return asCount(meta['postTokens']);
}

/** The compaction boundary entry (`system`/`compact_boundary`, any trigger, any thread), or `null`. */
function compactBoundaryOf(entry: unknown): Record<string, unknown> | null {
  const record = asRecord(entry);
  if (record === null || record['type'] !== 'system') return null;
  return record['subtype'] === 'compact_boundary' ? record : null;
}

function compactMetadataOf(entry: unknown): Record<string, unknown> | null {
  const record = compactBoundaryOf(entry);
  return record === null ? null : asRecord(record['compactMetadata']);
}

/**
 * A compaction boundary of the main thread, any trigger: a turn input of its own kind. Claude Code compacts
 * an idle conversation before the prompt cache expires, and that turn has no other input (CLI 2.1.325: the
 * boundary with `trigger: "auto"`, the compact summary, attachments, no reply). A subagent boundary is not the
 * main agent's input.
 */
export function isMainCompactBoundary(entry: unknown): boolean {
  const record = compactBoundaryOf(entry);
  return record !== null && record['isSidechain'] !== true;
}

/**
 * `preTokens` granicy kompakcji z KAŻDYM triggerem — DOLNA GRANICA okna, nie okno.
 *
 * Ani `trigger: "manual"` (człowiek mógł nacisnąć `/compact` przy 40k), ani `trigger: "auto"`
 * (próg kompakcji jest ustawieniem, nagłówek pliku) nie mówi, ile okno mieści, ale każdy mówi
 * jedno na pewno: **tyle się w nim ZMIEŚCIŁO**. Sesja, która stała na 744 448 tokenach, nie ma
 * okna 200k — i to wystarczy, żeby nie zakładać najmniejszego progu z drabinki.
 *
 * Bez tego panel Opusa po `/compact` pokazałby `~67%`, licząc 134k od ZAŁOŻONYCH
 * 200k, choć własne granice tej samej sesji dowodzą okna ≥ 744k (prawda: ~13%). Identyfikatora
 * `claude-opus-5` nie ma w `KNOWN_CONTEXT_LIMITS` i nie będzie — okna po nim nie poznać (nagłówek
 * pliku) — więc podpowiedź musi wyjść z SAMEGO pliku sesji.
 *
 * @returns liczba tokenów sprzed cięcia albo `null`, gdy wpis nie jest granicą kompakcji
 */
export function compactPreTokensFrom(entry: unknown): number | null {
  const meta = compactMetadataOf(entry);
  if (meta === null) return null;
  const pre = asCount(meta['preTokens']);
  return pre === null || pre === 0 ? null : pre;
}

/**
 * Skąd wiemy, ile mieści okno tej sesji — w kolejności WIARYGODNOŚCI.
 *
 * `statusline` to liczba, którą silnik podaje o SOBIE (`context_window_size`), więc nie jest ani
 * pomiarem, ani założeniem — jest odpowiedzią. Bije tabelę modelu i jako jedyna wolno jej limit
 * OBNIŻYĆ: sesja przełączona `/model` na wariant 200k naprawdę ma mniejsze okno niż minutę temu.
 *
 * Kontrakt (`ContextLimitState.source`) zna jeszcze `compact-boundary`. Serwer tej wartości nie
 * wysyła (granica kompakcji limitu nie potwierdza, nagłówek pliku); zostaje dla dekodera apki.
 */
export type ContextLimitSource = 'model' | 'statusline';

export interface UsageTracker {
  /** Zapisuje nową sumę tokenów i oddaje stan do wysłania dalej. */
  note(sum: number): ContextLimitState;
  /**
   * Potwierdza limit okna. `statusline` ustawia go w obie strony; `model` tylko podnosi limit
   * z tabeli i nie rusza limitu ze `statusline`.
   */
  confirmLimit(limit: number, source: ContextLimitSource): void;
  /** Podnosi DOLNĄ GRANICĘ okna („tyle się w nim zmieściło"). Nigdy jej nie obniża. */
  noteFloor(tokens: number): void;
  /** Stan bieżący bez zmiany liczby — po `confirmLimit`, gdy tokeny się nie ruszyły. */
  state(): ContextLimitState;
}

/**
 * Licznik okna kontekstu jednej sesji silnika.
 *
 * Dwie asymetrie, obie zamierzone:
 *
 * - **`tokens` MOŻE zmaleć** i to jest poprawne: po `/compact` suma spada z 462 682 na 14 002
 *   w tym samym pliku (zmierzone). Licznik monotoniczny pokazywałby po kompakcji pełne okno,
 *   czyli dokładnie odwrotność prawdy.
 * - **`limit` z tabeli modelu NIE maleje.** Raz potwierdzone okno jest cechą sesji: drugi wpis
 *   tabeli (flaga Raroga, potem identyfikator z jsonl) może go tylko podnieść. W dół rusza go
 *   wyłącznie odpowiedź silnika (`statusline`).
 *
 * @param known limit z modelu, który RAROG podał we fladze (`KNOWN_CONTEXT_LIMITS`);
 *              brak = sesja startuje jako `unknown` i taka zostaje do zrzutu status line albo
 *              do modelu z tabeli w jsonl
 */
export function createUsageTracker(known?: number): UsageTracker {
  let tokens = 0;
  let limit: number | null = known !== undefined && known > 0 ? known : null;
  let source: ContextLimitSource = 'model';
  /*
   * Największa suma, jaką ta sesja UNIOSŁA — z wpisów asystenta i z `preTokens` każdej granicy
   * kompakcji. To nie jest limit i nigdy się nim nie staje (`kind` zostaje `unknown`): to
   * jedyna twarda przesłanka, jaką plik daje o ROZMIARZE okna, gdy nikt go nie potwierdził.
   * Nie maleje — po `/compact` tokeny spadają, ale wiedza o tym, ile się zmieściło, zostaje.
   */
  let floor = 0;

  const build = (): ContextLimitState => {
    if (limit !== null) return { kind: 'known', tokens, limit, source };
    return floor > 0 ? { kind: 'unknown', tokens, atLeast: floor } : { kind: 'unknown', tokens };
  };

  return {
    note(sum: number): ContextLimitState {
      const value = asCount(sum);
      if (value !== null) {
        tokens = value;
        if (value > floor) floor = value;
      }
      return build();
    },
    noteFloor(value: number): void {
      const seen = asCount(value);
      if (seen !== null && seen > floor) floor = seen;
    },
    confirmLimit(value: number, from: ContextLimitSource): void {
      const confirmed = asCount(value);
      if (confirmed === null || confirmed === 0) return;
      /*
       * Odpowiedź silnika (`statusline`) jest ostateczna: ustawia limit W GÓRĘ i W DÓŁ, a nic
       * poza nowszym odczytem statusline jej nie rusza. To jedyne źródło, które nie zgaduje.
       */
      if (from === 'statusline') {
        limit = confirmed;
        source = from;
        return;
      }
      if (source === 'statusline') return;
      if (limit !== null && confirmed <= limit) return;
      limit = confirmed;
      source = from;
    },
    state: build,
  };
}
