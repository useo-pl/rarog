/**
 * Limity planu Claude (okno 5h / tydzień) — `GET /api/usage` i `GET /api/usage/details`.
 *
 * Jedynym źródłem liczb jest PASEK STATUSU Claude Code. Skrypt `statusLine` użytkownika zrzuca
 * payload każdego renderu do `~/.claude/statusline/<session_id>.json`, a CLI wkłada do niego
 * `rate_limits` po pierwszej odpowiedzi API w sesji (docs `statusline.md`, „Available data”).
 * Najświeższy zrzut z żywym oknem wybiera `readFreshestRateLimits`
 * (`herdr/statusline.ts`, heurystyka świeżości): okna po resecie są wycięte, wygrywa zrzut, którego treść
 * (`rate_limits` albo `cost.total_api_duration_ms`) zmieniła się najpóźniej, a nie ostatnio przerysowany, i ta
 * chwila zmiany (`changeAt`) jest chwilą liczb w `fetchedAt`.
 *
 * Rarog NIE czyta tokenu konta Claude i NIE woła API Anthropic. Zasady Anthropic dla narzędzi
 * zewnętrznych (code.claude.com/docs/en/legal-and-compliance) zabraniają zbierania,
 * przechowywania i pośredniczenia poświadczeń claude.ai, and Rarog is software for other people too.
 *
 * Koszt, przyjęty świadomie:
 * - bez tygodniowego limitu per model (`weeklyModel`) w `get()`: pasek statusu go nie niesie (niesie go
 *   tylko odczyt Claude Code w `details()`, niżej);
 * - liczby są tylko wtedy, gdy jakaś sesja `claude` na Macu narysowała pasek, a skrypt `statusLine`
 *   zrzuca payload do katalogu. Bez tego `get()` oddaje `null`, a router 503 `usage-unavailable`;
 * - liczby stoją, gdy nic nie pracuje. Liczby starsze niż {@link CLI_USAGE_STALE_MS} (od ostatniej zmiany treści
 *   zrzutu, nie od przerysowania paska) dostają `stale: true` i apka pisze pod wierszami, z której godziny są.
 *
 * E-mail konta (`account`) idzie z `~/.claude.json`, pole `oauthAccount.emailAddress`, w trybie
 * snajperskim (reguła 10 sekcji „Starting sessions from the phone" w `docs/security-model.md`): sufit rozmiaru,
 * jedno pole, reszta sparsowanego pliku porzucona, żaden błąd nie trafia do logu z treścią. Ten
 * plik zapisuje każdy proces `claude` na Macu, więc jego e-mail może należeć do innego konta niż
 * liczby limitów. Zwykle oba odczyty mówią o tym samym koncie, bo
 * zrzut pisze sesja CLI zalogowana tym samym `/login`, który zapisuje plik. Zrzut NIE mówi jednak,
 * z jakiego konta jest, więc rozjazd zostaje możliwy: po zmianie konta, dopóki żadna sesja nie
 * zostawi nowego zrzutu, i trwale, gdy najświeższy zrzut zostawia sesja zalogowana inaczej (np.
 * tokenem z env; zrzuty mają wtedy dwa różne resety tygodnia). Rarog tego nie wykrywa.
 *
 * Bez cache'u odpowiedzi: odczyt to `readdir` katalogu zrzutów i `stat` każdego z nich, treść tylko zrzutów
 * zmienionych od poprzedniego skanu i `~/.claude.json` (setki kB) — milisekundy, a apka pyta co 5 min i po wejściu
 * na wierzch. Pamięć procesu w `statusline.ts` trzyma tylko odciski zrzutów i chwile ich zmian, a liczby idą
 * z treści przy każdym żądaniu. Cache odpowiedzi dokładałby drugą, niewidoczną warstwę wieku nad wiekiem liczb,
 * który i tak mierzymy i pokazujemy.
 *
 * `GET /api/usage/details` (`details()`, arkusz „Limity” komendy apki `/usage`) to drugi
 * widok: odczyt limitów, który Claude Code zapisuje SAM w `~/.claude.json` pod kluczem
 * `cachedUsageUtilization` (`{fetchedAtMs, accountUuid, utilization}`). Tylko on niesie tydzień per model
 * (np. Fable). Rarog bierze z niego wyłącznie `utilization.limits[]` (`kind`, `percent`, `resets_at`,
 * `scope.model.display_name`) i `fetchedAtMs`, i tylko wtedy, gdy `accountUuid` równa się
 * `oauthAccount.accountUuid` z tego samego pliku; pozostałe klucze `utilization` nie wchodzą.
 * Chwila tego odczytu nie zależy od Raroga i nie jest chwilą paska statusu, więc widok ma WŁASNY
 * `fetchedAt` i nie miesza się z paskiem statusu —
 * świeższe 5 h i tydzień z `get()` wybiera apka. E-mail i odczyt limitów idą z JEDNEGO odczytu pliku
 * (`readClaudeJson`): jeden sufit, jedno `JSON.parse`, reszta obiektu porzucona.
 *
 * Nic tu nie rzuca: brak katalogu, zrzutu albo pliku to `null` albo brak pola.
 */
import { readFile, stat } from 'node:fs/promises';
import { asRecord } from './drivers/tool-text.ts';
import { defaultStatuslineRoot, readFreshestRateLimits } from './herdr/statusline.ts';
import { defaultClaudeJsonPath } from './herdr/trust.ts';

/** Zrzut paska statusu starszy niż to jest „nieświeży": odpowiedź dostaje `stale: true`. */
export const CLI_USAGE_STALE_MS = 15 * 60_000;

/**
 * Sufit odczytu `~/.claude.json`. Plik ma dziś ~280 kB i rośnie z historią projektów;
 * większy niż 4 MiB to nie jest plik, który znamy, więc e-maila wtedy nie ma.
 */
export const CLAUDE_JSON_MAX_BYTES = 4 * 1024 * 1024;

export interface UsageWindow {
  /** Zużycie okna w procentach (0–100, wartość z paska statusu bez własnej arytmetyki). */
  percent: number;
  /** ISO końca okna; nieobecne, gdy źródło go nie podało. */
  resetsAt?: string;
}

export interface PlanUsage {
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  /**
   * Tygodniowy limit per model (np. „Fable"). `GET /api/usage` go nie wysyła (pasek statusu go
   * nie niesie); niesie go `GET /api/usage/details` z odczytu Claude Code i stałe liczby demo.
   */
  weeklyModel?: UsageWindow & { model?: string };
  /** E-mail konta z `~/.claude.json`; nieobecny, gdy pola nie da się odczytać. */
  account?: string;
  /** `true` = liczby starsze niż {@link CLI_USAGE_STALE_MS}. */
  stale?: boolean;
  /**
   * ISO chwili, z której są liczby: ostatnia zmiana treści zrzutu paska statusu (`changeAt` heurystyki świeżości)
   * albo `fetchedAtMs` odczytu CLI.
   */
  fetchedAt?: string;
  /**
   * `'cli'` = liczby z paska statusu Claude Code; jedyne źródło `GET /api/usage`. Widok
   * `details()` i demo go nie podają.
   */
  source?: 'cli';
}

export interface UsageProvider {
  /** `null` = nie wiem: żaden zrzut paska statusu nie ma żywego okna. */
  get(): Promise<PlanUsage | null>;
  /**
   * Odczyt limitów zapisany przez Claude Code w `~/.claude.json` (`cachedUsageUtilization`), z jego
   * własną chwilą w `fetchedAt`. `{}` = odczytu nie ma (brak pliku albo klucza, inne konto, obcy
   * kształt, same okna po resecie). Nigdy nie rzuca.
   */
  details(): Promise<PlanUsage>;
}

export interface UsageProviderOptions {
  /** Katalog zrzutów paska statusu; domyślnie `~/.claude/statusline`. */
  statuslineRoot?: string;
  /** Plik z e-mailem konta i odczytem limitów Claude Code; domyślnie `~/.claude.json`. */
  claudeJsonPath?: string;
  now?: () => number;
  /** Linia o zmianie stanu odczytu (działa / dlaczego nie); nigdy z treścią plików. */
  logger?: (line: string) => void;
}

/** Rodzaj wpisu `limits[]` odczytu CLI, który Rarog rozumie; inne rodzaje odpadają. */
type CachedLimitKind = 'session' | 'weekly_all' | 'weekly_scoped';

/** Jeden wpis `cachedUsageUtilization.utilization.limits[]` po odsianiu: reszta pól wpisu porzucona. */
interface CachedLimit {
  kind: CachedLimitKind;
  window: UsageWindow;
  /** `scope.model.display_name` wpisu `weekly_scoped` („Fable"). */
  model?: string;
}

/** Odczyt limitów Claude Code z `~/.claude.json` konta z `oauthAccount`. */
interface CachedUsage {
  /** `fetchedAtMs` — kiedy CLI pytało o limity. */
  at: number;
  limits: CachedLimit[];
}

/** Dlaczego odczytu limitów Claude Code nie ma — stała etykieta do logu, nigdy z treścią pliku. */
type CachedUsageMiss = 'file' | 'no-key' | 'other-account' | 'shape';

/** Pola `~/.claude.json`, których Rarog potrzebuje; reszta sparsowanego obiektu idzie do kosza. */
interface ClaudeJsonFields {
  /** `oauthAccount.emailAddress`, przycięty; `null` = brak pola, pusty, nie-tekst. */
  email: string | null;
  cachedUsage: CachedUsage | CachedUsageMiss;
}

const CACHED_LIMIT_KINDS: ReadonlySet<unknown> = new Set<CachedLimitKind>(['session', 'weekly_all', 'weekly_scoped']);

/** Tekst niepusty po przycięciu albo `null`. */
function trimmedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Wpis `limits[]` → okno. `percent` liczba skończona ≥ 0 (bez własnej arytmetyki); `resets_at` (ISO
 * z mikrosekundami, np. `2026-10-22T15:00:00.403187+00:00`) przepisany na ISO z milisekundami, brak
 * albo `null` = okno bez resetu, tekst nieczytelny = wpis odpada (nie wiadomo, czy okno żyje).
 */
function cachedLimitOf(value: unknown): CachedLimit | null {
  const entry = asRecord(value);
  if (entry === null || Array.isArray(entry)) return null;
  const kind = entry['kind'];
  if (!CACHED_LIMIT_KINDS.has(kind)) return null;
  const percent = entry['percent'];
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return null;
  const window: UsageWindow = { percent };
  const resets = entry['resets_at'];
  if (resets !== undefined && resets !== null) {
    const at = typeof resets === 'string' ? Date.parse(resets) : Number.NaN;
    if (!Number.isFinite(at)) return null;
    window.resetsAt = new Date(at).toISOString();
  }
  const limit: CachedLimit = { kind: kind as CachedLimitKind, window };
  if (kind === 'weekly_scoped') {
    const model = trimmedText(asRecord(asRecord(entry['scope'])?.['model'])?.['display_name']);
    if (model !== null) limit.model = model;
  }
  return limit;
}

/**
 * `cachedUsageUtilization` konta zalogowanego w tym samym pliku. Konto liczy się po `accountUuid`
 * odczytu i `oauthAccount.accountUuid` (oba niepuste i równe): odczyt sprzed `/login` na inne konto
 * mówi o cudzych limitach, a e-mail obok należałby do nowego.
 */
function cachedUsageOf(root: Record<string, unknown>): CachedUsage | CachedUsageMiss {
  const cache = asRecord(root['cachedUsageUtilization']);
  if (cache === null) return 'no-key';
  const own = trimmedText(asRecord(root['oauthAccount'])?.['accountUuid']);
  if (own === null || cache['accountUuid'] !== own) return 'other-account';
  const at = cache['fetchedAtMs'];
  const limits = asRecord(cache['utilization'])?.['limits'];
  // `toISOString` rzuca poza zakresem dat (np. 1e300) — taki odczyt to obcy kształt, nie wyjątek trasy.
  if (typeof at !== 'number' || !(at > 0) || !Number.isFinite(new Date(at).getTime())) return 'shape';
  if (!Array.isArray(limits)) return 'shape';
  return { at, limits: limits.map(cachedLimitOf).filter((limit) => limit !== null) };
}

/** Pola z treści `~/.claude.json`; zły JSON = brak obu. */
function claudeJsonFieldsOf(text: string): ClaudeJsonFields {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    // Świadomie bez treści wyjątku: komunikat parsera potrafi zacytować fragment pliku.
    return { email: null, cachedUsage: 'file' };
  }
  const root = asRecord(raw);
  if (root === null || Array.isArray(root)) return { email: null, cachedUsage: 'no-key' };
  return {
    email: trimmedText(asRecord(root['oauthAccount'])?.['emailAddress']),
    cachedUsage: cachedUsageOf(root),
  };
}

/**
 * JEDYNY czytnik `~/.claude.json` w tym module (reguła 10 w `docs/security-model.md`): sufit
 * {@link CLAUDE_JSON_MAX_BYTES}, jedno `JSON.parse`, z obiektu e-mail i odczyt limitów CLI, reszta
 * porzucona. NIGDY nie rzuca i nic nie loguje.
 */
async function readClaudeJson(file: string): Promise<ClaudeJsonFields> {
  const unreadable: ClaudeJsonFields = { email: null, cachedUsage: 'file' };
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > CLAUDE_JSON_MAX_BYTES) return unreadable;
    const bytes = await readFile(file);
    // Plik rośnie między `stat` a odczytem (pisze go każdy `claude`): sufit liczy się też tutaj.
    return bytes.length > CLAUDE_JSON_MAX_BYTES ? unreadable : claudeJsonFieldsOf(bytes.toString('utf8'));
  } catch {
    return unreadable;
  }
}

/** Okno, którego reset jeszcze nie minął (albo którego resetu odczyt nie podał). */
function isLive(window: UsageWindow, at: number): boolean {
  return window.resetsAt === undefined || Date.parse(window.resetsAt) > at;
}

/** Zdanie do logu przy braku odczytu CLI — bez treści pliku. */
const CACHED_USAGE_MISS_NOTE: Record<CachedUsageMiss | 'expired', string> = {
  file: '`~/.claude.json` unreadable, larger than 4 MiB or not JSON',
  'no-key': 'Claude Code did not write a usage reading (`cachedUsageUtilization`)',
  'other-account': 'the usage reading is from a different account than `oauthAccount` (or the accounts cannot be compared)',
  shape: 'usage reading in an unknown shape',
  expired: 'every window of the usage reading is past its reset',
};

export function createUsageProvider(opts: UsageProviderOptions = {}): UsageProvider {
  const statuslineRoot = opts.statuslineRoot ?? defaultStatuslineRoot();
  const claudeJsonPath = opts.claudeJsonPath ?? defaultClaudeJsonPath();
  const now = opts.now ?? Date.now;
  let lastState: string | null = null;
  let lastDetailsState: string | null = null;

  /** Linia tylko przy ZMIANIE stanu: apka pyta co kilka minut, log ma dostać jedną. */
  const note = (state: string): void => {
    if (state === lastState) return;
    lastState = state;
    opts.logger?.(`rarog: plan usage: ${state}`);
  };

  /** To samo dla widoku szczegółów (arkusz „Limity”): własny stan, bo pytają o niego inne chwile. */
  const noteDetails = (state: string): void => {
    if (state === lastDetailsState) return;
    lastDetailsState = state;
    opts.logger?.(`rarog: usage details: ${state}`);
  };

  return {
    async get(): Promise<PlanUsage | null> {
      const at = now();
      const limits = await readFreshestRateLimits(statuslineRoot, at);
      if (limits === null) {
        note('unavailable — no Claude Code status line dump has a live `rate_limits` window '
          + '(the `statusLine` script must dump the payload to `~/.claude/statusline/`).');
        return null;
      }
      const usage: PlanUsage = {
        ...(at - limits.at > CLI_USAGE_STALE_MS ? { stale: true } : {}),
        source: 'cli',
        fetchedAt: new Date(limits.at).toISOString(),
      };
      if (limits.fiveHour !== undefined) usage.fiveHour = limits.fiveHour;
      if (limits.weekly !== undefined) usage.weekly = limits.weekly;
      // E-mail opisuje liczby, więc bez liczb nie ma po co czytać `~/.claude.json`.
      const account = (await readClaudeJson(claudeJsonPath)).email;
      if (account !== null) usage.account = account;
      note(account === null
        ? 'works (Claude Code status line), without the account e-mail from `~/.claude.json`.'
        : 'works (Claude Code status line).');
      return usage;
    },

    async details(): Promise<PlanUsage> {
      const at = now();
      const { email, cachedUsage } = await readClaudeJson(claudeJsonPath);
      if (typeof cachedUsage === 'string') {
        noteDetails(`no Claude Code reading — ${CACHED_USAGE_MISS_NOTE[cachedUsage]}.`);
        return {};
      }
      const usage: PlanUsage = {
        ...(at - cachedUsage.at > CLI_USAGE_STALE_MS ? { stale: true } : {}),
        fetchedAt: new Date(cachedUsage.at).toISOString(),
      };
      // Pierwszy żywy wpis każdego rodzaju.
      for (const limit of cachedUsage.limits) {
        if (!isLive(limit.window, at)) continue;
        if (limit.kind === 'session') usage.fiveHour ??= limit.window;
        if (limit.kind === 'weekly_all') usage.weekly ??= limit.window;
        if (limit.kind === 'weekly_scoped' && usage.weeklyModel === undefined) {
          usage.weeklyModel = { ...limit.window, ...(limit.model === undefined ? {} : { model: limit.model }) };
        }
      }
      if (usage.fiveHour === undefined && usage.weekly === undefined && usage.weeklyModel === undefined) {
        noteDetails(`no Claude Code reading — ${CACHED_USAGE_MISS_NOTE.expired}.`);
        return {};
      }
      if (email !== null) usage.account = email;
      noteDetails(usage.weeklyModel === undefined
        ? 'works (Claude Code reading from `~/.claude.json`), without a per-model window.'
        : 'works (Claude Code reading from `~/.claude.json`).');
      return usage;
    },
  };
}
