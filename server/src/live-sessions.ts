/**
 * Które sesje silnika są TERAZ otwarte — pytane oficjalnym wejściem CLI.
 *
 * `claude agents --json` wypisuje aktywne sesje (interaktywne i tłowe) jako tablicę JSON.
 * Zmierzone: 21 wpisów w 0,30 s, komplet zgodny z rejestrem `~/.claude/sessions`.
 * To jest jedyne źródło, które widzi też `claude` uruchomionego w GOŁYM tmuxie — poza herdr,
 * czyli tam, gdzie `agent.list` nie sięga.
 *
 * Dwa czytelniki, o różnej wadze:
 *
 * 1. lista „Ostatnie sesje" — odsiew wpisów, których nie da się wznowić (prezentacja),
 * 2. `#assertResumable` w `sessions/launch-gate.ts` — bramka przed DWOMA PISARZAMI do jednego pliku jsonl.
 *    Tu pomyłka kosztuje uszkodzony transkrypt, nie brakujący wiersz.
 *
 * Dlatego awaria czytnika NIE MOŻE znaczyć „nic nie żyje". Zwracamy `null` — „nie wiem" —
 * a decyzję, co z tym zrobić, podejmuje czytelnik: lista pokazuje wtedy wiersz więcej,
 * bramka zostaje przy tym, co wie z herdr.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { defaultCliBinLink } from './cli-version.ts';
import { LIVE_SESSIONS_ENV_PASSTHROUGH } from './config-env.ts';

/** Ile czekamy na `claude agents --json`, zanim uznamy, że nie odpowie. */
export const LIVE_SESSIONS_TIMEOUT_MS = 3_000;

/**
 * Jak długo wynik jest świeży.
 *
 * Jedno wejście na ekran to jedno wywołanie, nie jedno na wiersz. 5 s jest krótsze niż czas
 * potrzebny człowiekowi na przeczytanie listy i dłuższe niż seria żądań jednego renderu.
 */
export const LIVE_SESSIONS_TTL_MS = 5_000;

/**
 * Jak długo NIE ponawiamy komendy po nieudanym odczycie.
 *
 * Nieudany odczyt nie mówi nic ani w jedną, ani w drugą stronę, więc natychmiastowe ponowienie
 * nie czyni bramki bezpieczniejszą — kosztuje za to pełny `LIVE_SESSIONS_TIMEOUT_MS` przy
 * KAŻDEJ próbie wznowienia, gdy programu `claude` nie ma albo wisi. Sekunda wystarczy, żeby seria żądań
 * jednego tapnięcia nie płaciła tego trzy razy, i jest krótsza niż czas na kolejne tapnięcie.
 */
export const LIVE_SESSIONS_FAIL_TTL_MS = 1_000;

/** Podmienialne wejście — testy nie odpalają procesu. */
export type LiveSessionsProbe = () => Promise<string>;

export interface LiveSessionsOptions {
  probe?: LiveSessionsProbe;
  ttlMs?: number;
  failTtlMs?: number;
  now?: () => number;
}

/**
 * Zbiór `engineSessionId` żywych sesji albo `null`, gdy nie udało się ustalić.
 *
 * `fresh: true` omija pamięć podręczną WYNIKU UDANEGO — to jest tryb dla bramki przed dwoma
 * pisarzami, gdzie pięciosekundowe okno starych danych wystarcza, żeby przepuścić
 * wznowienie sesji, która ruszyła w międzyczasie. Lista ekranu takiej świeżości nie potrzebuje
 * i nie ma powodu płacić procesem potomnym za każdy render.
 */
export type LiveSessionsReader = (opts?: { fresh?: boolean }) => Promise<Set<string> | null>;

/**
 * Env procesu `claude agents --json` z zamkniętej listy `LIVE_SESSIONS_ENV_PASSTHROUGH` (rejestr
 * `config-env.ts`) — brak zmiennej znaczy „nie przekazuj", nie „pusta".
 *
 * Komenda potrzebuje `HOME` (znajduje po nim swoją konfigurację i magazyn sesji) oraz `PATH`
 * (znajduje po nim samą siebie); `LANG` i `TMPDIR` idą, bo bez nich cudze narzędzia potrafią
 * wypisywać byle co i pisać w byle gdzie. Sekrety Raroga (`SONIOX_API_KEY`, `RAROG_APNS_KEY_PATH`,
 * `RAROG_IROH_KEY`) NIE przechodzą — nie są tej komendzie do niczego potrzebne, a jedyny powód,
 * dla którego miałyby tam trafić, to lenistwo `...process.env`. Ta sama reguła co przy PTY
 * (`TERM_ENV_PASSTHROUGH`), tylko krótsza lista.
 */
export function liveSessionsEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of LIVE_SESSIONS_ENV_PASSTHROUGH) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Czym uruchomić CLI: binarka instalatora natywnego (`~/.local/bin/claude`) z PEŁNEJ ścieżki,
 * a `claude` z `PATH` tylko wtedy, gdy jej nie ma (instalacja z npm).
 *
 * Powód (zmierzone): pod launchd środowisko serwera ma `PATH` z nvm i homebrew, bez
 * `~/.local/bin` — `execFile('claude')` kończył się ENOENT, czytnik oddawał `null` przy KAŻDYM
 * wywołaniu i druga bramka dwóch pisarzy po cichu nie działała od przejścia na launchd,
 * a restart na nowym Claude Code odmawiał zawsze („nie potwierdziłem…").
 */
export function claudeCommand(
  bin: string = defaultCliBinLink(), exists: (path: string) => boolean = existsSync,
): string {
  return exists(bin) ? bin : 'claude';
}

/**
 * Domyślne wejście: `claude agents --json`.
 *
 * `execFile`, nie `exec` — komenda jest stała i nie przechodzi przez powłokę; z żądania nie
 * wchodzi tu ani jeden znak. Program wskazuje {@link claudeCommand}; gdy go nie ma albo
 * wisi, `execFile` zawoła błędem i skończy się to odpowiedzią „nie wiem" — nigdy wywróconym
 * żądaniem.
 */
const cliProbe: LiveSessionsProbe = () => new Promise((resolve, reject) => {
  execFile(
    claudeCommand(), ['agents', '--json'],
    {
      timeout: LIVE_SESSIONS_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: liveSessionsEnv(),
      // Proces, który zignorował SIGTERM, ma zniknąć mimo to — inaczej `timeout` jest życzeniem.
      killSignal: 'SIGKILL',
      windowsHide: true,
    },
    (err, stdout) => {
      if (err !== null) reject(err);
      else resolve(stdout);
    },
  );
});

/**
 * Wyciąga identyfikatory sesji z wyjścia komendy.
 *
 * Czytamy WYŁĄCZNIE `sessionId` — reszta pól (`kind`, `state`, `name`, `cwd`) to informacja
 * o cudzym procesie, której Rarog w tej roli nie potrzebuje. Wpis bez identyfikatora pomijamy;
 * wyjście, które nie jest tablicą, znaczy „nie wiem" (`null`), a nie „pusto".
 */
export function parseLiveSessions(stdout: string): Set<string> | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const id = (item as { sessionId?: unknown }).sessionId;
    if (typeof id === 'string' && id !== '') out.add(id);
  }
  return out;
}

/** Tworzy czytnik żywych sesji z pamięcią podręczną na `ttlMs`. */
export function createLiveSessionsReader(opts: LiveSessionsOptions = {}): LiveSessionsReader {
  const probe = opts.probe ?? cliProbe;
  const ttl = opts.ttlMs ?? LIVE_SESSIONS_TTL_MS;
  const failTtl = opts.failTtlMs ?? LIVE_SESSIONS_FAIL_TTL_MS;
  const now = opts.now ?? ((): number => Date.now());
  let cached: Set<string> | null = null;
  let cachedAt = -Infinity;
  let failedAt = -Infinity;
  let inFlight: Promise<Set<string> | null> | null = null;

  return async ({ fresh = false } = {}) => {
    // Krótka cisza po nieudanym odczycie obowiązuje TAKŻE bramkę: ponowienie i tak nie oddałoby
    // wiedzy, a kosztowałoby pełny timeout przy każdym tapnięciu „Wznów".
    if (now() - failedAt < failTtl) return null;
    if (!fresh && cached !== null && now() - cachedAt < ttl) return cached;
    // Jedno żądanie w locie na raz: wejście na ekran potrafi odpalić kilka odczytów naraz,
    // a każdy z nich to osobny proces potomny.
    inFlight ??= (async () => {
      try {
        return parseLiveSessions(await probe());
      } catch {
        return null;
      }
    })().finally(() => {
      inFlight = null;
    });
    const result = await inFlight;
    if (result !== null) {
      cached = result;
      cachedAt = now();
    } else {
      failedAt = now();
    }
    return result;
  };
}
