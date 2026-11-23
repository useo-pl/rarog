/**
 * Payload status line Claude Code (`server/src/herdr/statusline.ts`).
 *
 * To JEDYNE źródło, z którego Rarog zna rozmiar okna kontekstu — w transkrypcie jsonl tej liczby
 * nie ma, a identyfikator modelu nie odróżnia wariantu 1M od 200k. Fixture poniżej jest DOSŁOWNYM
 * payloadem zmierzonym na CLI 2.1.239 (pola nieużywane przycięte, kształt nietknięty).
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHILD_TEST_TIMEOUT_MS, childJson, runInChild, serverModule } from './child-limit.ts';
import {
  defaultStatuslineRoot,
  parseStatusline,
  parseStatuslineRateLimits,
  readFreshestRateLimits,
  readStatusline,
  scanFreshestRateLimits,
  statuslinePath,
  STATUSLINE_MAX_BYTES,
} from '../src/herdr/statusline.ts';

const SESSION = '57d11ce0-84bc-42b4-a703-927075d35229';

/** Payload w kształcie, w jakim CLI podaje go komendzie `statusLine`. */
const PAYLOAD = JSON.stringify({
  session_id: SESSION,
  transcript_path: '/Users/u/.claude/projects/-Users-u-Projects-rarog/57d11ce0.jsonl',
  cwd: '/Users/u/Projects/rarog',
  effort: { level: 'high' },
  session_name: 'visuals',
  model: { id: 'claude-opus-5', display_name: 'Opus 5' },
  version: '2.1.239',
  context_window: {
    total_input_tokens: 477_956,
    context_window_size: 1_000_000,
    current_usage: { input_tokens: 2, cache_read_input_tokens: 476_908 },
    used_percentage: 48,
    remaining_percentage: 52,
  },
  exceeds_200k_tokens: true,
  rate_limits: { five_hour: { used_percentage: 35 } },
});

describe('parseStatusline', () => {
  /**
   * NAJWAŻNIEJSZY TEST MODUŁU: `context_window_size` to liczba, przez którą UI DZIELI. Gdyby
   * parser wziął ją z innego pola (albo zgubił przy zmianie kształtu), Rarog wróciłby do
   * zgadywania okna — czyli do pokazywania 75% nad rozmową zajmującą 15%.
   */
  it('wyciąga rozmiar okna, procent i model z realnego payloadu', () => {
    expect(parseStatusline(PAYLOAD)).toEqual({
      contextWindow: 1_000_000,
      usedPercentage: 48,
      model: 'claude-opus-5',
    });
  });

  it('zero procent jest wartością POPRAWNĄ, nie brakiem odczytu', () => {
    const fresh = JSON.stringify({ context_window: { context_window_size: 200_000, used_percentage: 0 } });
    expect(parseStatusline(fresh)).toEqual({ contextWindow: 200_000, usedPercentage: 0 });
  });

  it('śmieci, obcy kształt i połówka pliku dają `null`, nigdy wyjątek', () => {
    // Zapis jest atomowy (tmp + mv), ale parser i tak nie ma prawa wywrócić followera.
    expect(parseStatusline('{"context_window": {"context_window_')).toBeNull();
    expect(parseStatusline('')).toBeNull();
    expect(parseStatusline('[]')).toBeNull();
    expect(parseStatusline('{"cwd":"/x"}')).toBeNull();
  });

  it('okno o rozmiarze zero albo nie-liczbie jest odrzucane', () => {
    // Dzielenie przez zero dałoby `Infinity%` w nagłówku sesji.
    expect(parseStatusline('{"context_window":{"context_window_size":0}}')).toBeNull();
    expect(parseStatusline('{"context_window":{"context_window_size":"1M"}}')).toBeNull();
  });
});

describe('readStatusline', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarog-statusline-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('czyta zrzut po identyfikatorze sesji silnika', async () => {
    await writeFile(statuslinePath(root, SESSION), PAYLOAD);
    expect(await readStatusline(root, SESSION)).toEqual({
      contextWindow: 1_000_000, usedPercentage: 48, model: 'claude-opus-5',
    });
  });

  /**
   * TEST OBOWIĄZKOWY. Brak pliku to NORMALNY stan pracy: panel spoza tej maszyny nigdy nic nie
   * zrzuci, a panel bezczynny zrzuci dopiero przy najbliższym renderze stopki. To nie może być
   * ani błąd, ani log — Rarog ma po prostu wrócić do szacunku z jsonl.
   */
  it('brak pliku i brak katalogu to `null`, bez wyjątku', async () => {
    expect(await readStatusline(root, SESSION)).toBeNull();
    expect(await readStatusline(join(root, 'nie-ma'), SESSION)).toBeNull();
  });

  it('plik podejrzanie duży jest odbijany zamiast wciągany', async () => {
    await writeFile(statuslinePath(root, SESSION), 'x'.repeat(STATUSLINE_MAX_BYTES + 1));
    expect(await readStatusline(root, SESSION)).toBeNull();
  });

  it('domyślny katalog stoi obok magazynu rozmów', () => {
    expect(defaultStatuslineRoot().endsWith(join('.claude', 'statusline'))).toBe(true);
  });

  /*
   * `~/.claude/statusline/` jest zapisywalny z sandboksa sesji (pomiar na CLI 2.1.311), więc FIFO pod nazwą
   * zrzutu bez ochrony zajęłoby wątek puli libuv bez końca. Reprodukcja w procesie potomnym.
   */
  it('FIFO pod nazwą zrzutu: `null`, bez zawieszenia', async () => {
    execFileSync('mkfifo', [statuslinePath(root, SESSION)]);
    const result = childJson<{ state: unknown }>(await runInChild(root, `
import { readStatusline } from ${serverModule('herdr/statusline.ts')};
console.log(JSON.stringify({ state: await readStatusline(${JSON.stringify(root)}, ${JSON.stringify(SESSION)}) }));
process.exit(0);
`));
    expect(result).toEqual({ state: null });
  }, CHILD_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Limity planu z paska statusu — jedyne źródło panelu limitów i kafla Live Activity
// ---------------------------------------------------------------------------

/** Kształt `rate_limits` zmierzony na CLI 2.1.288. */
function withLimits(five: number | null, week: number | null): string {
  return JSON.stringify({
    session_id: SESSION,
    rate_limits: {
      ...(five === null ? {} : { five_hour: { used_percentage: five, resets_at: 1791163800 } }),
      ...(week === null ? {} : { seven_day: { used_percentage: week, resets_at: 1791594000 } }),
    },
  });
}

const BEFORE_RESETS = Date.parse('2026-10-04T20:40:00Z');

describe('parseStatuslineRateLimits', () => {
  it('czyta 5h i tydzień; sekundy epoki zamienia na ISO', () => {
    expect(parseStatuslineRateLimits(withLimits(0, 33), BEFORE_RESETS)).toEqual({
      fiveHour: { percent: 0, resetsAt: '2026-10-05T01:30:00.000Z' },
      weekly: { percent: 33, resetsAt: '2026-10-10T01:00:00.000Z' },
    });
  });

  it('okno po resecie znika; bez żywego okna i bez pola = null', () => {
    const afterFiveHour = Date.parse('2026-10-05T02:00:00Z');
    expect(parseStatuslineRateLimits(withLimits(40, 33), afterFiveHour)).toEqual({
      weekly: { percent: 33, resetsAt: '2026-10-10T01:00:00.000Z' },
    });
    expect(parseStatuslineRateLimits(withLimits(40, 33), Date.parse('2026-10-11T00:00:00Z')))
      .toBeNull();
    expect(parseStatuslineRateLimits(JSON.stringify({ session_id: SESSION }), 0)).toBeNull();
    expect(parseStatuslineRateLimits('nie json', 0)).toBeNull();
    expect(parseStatuslineRateLimits(JSON.stringify({
      rate_limits: { five_hour: { used_percentage: 'dużo', resets_at: 1791163800 } },
    }), 0)).toBeNull();
  });
});

describe('readFreshestRateLimits', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rarog-statusline-limity-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function dump(name: string, text: string, mtimeSec: number): Promise<void> {
    const path = join(root, name);
    await writeFile(path, text);
    await utimes(path, mtimeSec, mtimeSec);
  }

  it('bierze NAJŚWIEŻSZY zrzut z limitami, a czas zrzutu oddaje jako chwilę liczb', async () => {
    await dump('stary.json', withLimits(10, 20), 1791000000);
    await dump('nowy.json', withLimits(0, 33), 1791001000);
    await dump('bez-limitow.json', JSON.stringify({ session_id: 'x' }), 1791002000);
    await dump('.tmp.json', withLimits(99, 99), 1791003000);
    expect(await readFreshestRateLimits(root, BEFORE_RESETS)).toEqual({
      fiveHour: { percent: 0, resetsAt: '2026-10-05T01:30:00.000Z' },
      weekly: { percent: 33, resetsAt: '2026-10-10T01:00:00.000Z' },
      at: 1791001000_000,
    });
  });

  it('brak katalogu i same zrzuty bez limitów = null, bez wyjątku', async () => {
    expect(await readFreshestRateLimits(join(root, 'nie-ma'), BEFORE_RESETS)).toBeNull();
    await dump('a.json', JSON.stringify({ session_id: 'x' }), 1791000000);
    expect(await readFreshestRateLimits(root, BEFORE_RESETS)).toBeNull();
  });
});

/*
 * Heurystyka świeżości. Bezczynna sesja przerysowuje
 * pasek bez zapytania do API (docs statusline: wygaśnięcie cache'u promptu, `resets_at`, zmiana trybu,
 * `refreshInterval`), więc jej zrzut dostaje najnowszy `mtime` ze starymi liczbami. Wygrywa więc plik, którego
 * ODCISK (`rate_limits` i `cost.total_api_duration_ms`) zmienił się najpóźniej, a nie plik przerysowany najpóźniej.
 */
describe('scanFreshestRateLimits — heurystyka świeżości', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rarog-statusline-k5-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  /** Sekundy epoki przed resetami z {@link withLimits}; kolejne zrzuty dostają tę wartość plus `n`. */
  const T0 = 1791000000;

  /** Zrzut z oknem 5 h i czasem API: dwa składniki odcisku. */
  function dumpText(five: number, apiMs: number): string {
    return JSON.stringify({
      session_id: SESSION,
      cost: { total_api_duration_ms: apiMs },
      rate_limits: { five_hour: { used_percentage: five, resets_at: 1791163800 } },
    });
  }

  async function dump(name: string, text: string, mtimeSec: number): Promise<void> {
    const path = join(root, name);
    await writeFile(path, text);
    await utimes(path, mtimeSec, mtimeSec);
  }

  async function winner(): Promise<{ five: number | undefined; at: number } | null> {
    const limits = await scanFreshestRateLimits(root, BEFORE_RESETS);
    return limits === null ? null : { five: limits.fiveHour?.percent, at: limits.at };
  }

  it('A przerysowany później bez zmiany odcisku, B zmienił odcisk później → B', async () => {
    await dump('a.json', dumpText(10, 100), T0 + 1000);
    await dump('b.json', dumpText(20, 200), T0 + 900);
    expect(await winner()).toEqual({ five: 10, at: (T0 + 1000) * 1000 });
    await dump('b.json', dumpText(25, 300), T0 + 2000);
    // Bezczynna sesja A rysuje pasek od nowa: nowszy `mtime`, ta sama treść.
    await dump('a.json', dumpText(10, 100), T0 + 3000);
    expect(await winner(), '`fetchedAt` = `changeAt` zwycięzcy').toEqual({ five: 25, at: (T0 + 2000) * 1000 });
  });

  it('oba pliki widziane pierwszy raz → nowszy `mtime` (po restarcie serwera dzisiejsza kolejność)', async () => {
    await dump('a.json', dumpText(10, 100), T0 + 1000);
    await dump('b.json', dumpText(20, 200), T0 + 2000);
    expect(await winner()).toEqual({ five: 20, at: (T0 + 2000) * 1000 });
  });

  it('dwa pliki zmieniają odcisk między odczytami → wygrywa późniejszy `mtime` z tego odczytu', async () => {
    await dump('a.json', dumpText(10, 100), T0 + 1000);
    await dump('b.json', dumpText(20, 200), T0 + 900);
    await dump('c.json', dumpText(30, 300), T0 + 800);
    expect(await winner()).toEqual({ five: 10, at: (T0 + 1000) * 1000 });
    await dump('a.json', dumpText(11, 110), T0 + 3000);
    await dump('b.json', dumpText(21, 210), T0 + 2500);
    // C tylko przerysowany: najnowszy `mtime`, ale bez zmiany odcisku.
    await dump('c.json', dumpText(30, 300), T0 + 4000);
    expect(await winner()).toEqual({ five: 11, at: (T0 + 3000) * 1000 });
  });

  it('25 plików przerysowanych bez zmiany odcisku i jeden starszy ze zmianą → ten starszy', async () => {
    const redrawn = Array.from({ length: 25 }, (_, i) => `przerysowany-${String(i).padStart(2, '0')}.json`);
    for (const [i, name] of redrawn.entries()) await dump(name, dumpText(50, 5000 + i), T0 + 1000 + i);
    await dump('starszy.json', dumpText(5, 50), T0 + 500);
    expect(await winner()).toEqual({ five: 50, at: (T0 + 1024) * 1000 });
    for (const [i, name] of redrawn.entries()) await dump(name, dumpText(50, 5000 + i), T0 + 5000 + i);
    await dump('starszy.json', dumpText(7, 70), T0 + 4000);
    expect(await winner()).toEqual({ five: 7, at: (T0 + 4000) * 1000 });
  });

  it('urwany JSON → pominięty, zwycięzca bez zmian', async () => {
    await dump('a.json', dumpText(10, 100), T0 + 1000);
    await dump('b.json', dumpText(20, 200), T0 + 500);
    expect(await winner()).toEqual({ five: 10, at: (T0 + 1000) * 1000 });
    // Zwycięzca chwilowo urwany i nowy plik urwany: oba pominięte, pamięć o A zostaje.
    await dump('a.json', dumpText(10, 100).slice(0, 40), T0 + 3000);
    await dump('nowy.json', dumpText(90, 900).slice(0, 40), T0 + 4000);
    expect(await winner()).toEqual({ five: 10, at: (T0 + 1000) * 1000 });
    // A znów cały, z tym samym odciskiem: `changeAt` się nie przesuwa.
    await dump('a.json', dumpText(10, 100), T0 + 5000);
    expect(await winner()).toEqual({ five: 10, at: (T0 + 1000) * 1000 });
  });

  it('zrzut z `resets_at` poza zakresem `Date` nie zatrzymuje skanu: poprawny zrzut dalej wygrywa', async () => {
    const outOfRange = JSON.stringify({
      session_id: SESSION,
      cost: { total_api_duration_ms: 1 },
      rate_limits: { five_hour: { used_percentage: 99, resets_at: 1e20 } },
    });
    await dump('dobry.json', dumpText(10, 100), T0 + 1000);
    await dump('zly-starszy.json', outOfRange, T0 + 500);
    expect(await winner()).toEqual({ five: 10, at: (T0 + 1000) * 1000 });
    await dump('zly-nowszy.json', outOfRange, T0 + 2000);
    expect(await winner()).toEqual({ five: 10, at: (T0 + 1000) * 1000 });
  });

  it('dwa skany naraz dają tego samego zwycięzcę', async () => {
    await dump('a.json', dumpText(10, 100), T0 + 1000);
    await dump('b.json', dumpText(20, 200), T0 + 900);
    await winner();
    await dump('b.json', dumpText(25, 300), T0 + 2000);
    await dump('a.json', dumpText(10, 100), T0 + 3000);
    const [first, second] = await Promise.all([winner(), winner()]);
    expect(first).toEqual({ five: 25, at: (T0 + 2000) * 1000 });
    expect(second).toEqual(first);
    expect(await winner()).toEqual(first);
  });

  it('plik, który zniknął, traci pamięć: wraca jako widziany pierwszy raz', async () => {
    await dump('a.json', dumpText(10, 100), T0 + 1000);
    await dump('b.json', dumpText(20, 200), T0 + 900);
    expect(await winner()).toEqual({ five: 10, at: (T0 + 1000) * 1000 });
    await rm(join(root, 'a.json'));
    expect(await winner()).toEqual({ five: 20, at: (T0 + 900) * 1000 });
    // Ta sama treść pod starszym `mtime`: bez pamięci `changeAt` = `mtime`, więc B zostaje.
    await dump('a.json', dumpText(10, 100), T0 + 800);
    expect(await winner()).toEqual({ five: 20, at: (T0 + 900) * 1000 });
  });
});

/*
 * Weekly windows per reset: next to the winner the scan hands over, for every live `seven_day` reset, the
 * newest reading of that window. Two or three accounts work on one Mac at once, so the winner alone can hide a
 * window that just crossed the weekly-limit threshold. The winner and `GET /api/usage` stay as they were.
 */
describe('scanFreshestRateLimits — weekly windows per reset', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rarog-statusline-k19-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const T0 = 1791000000;
  /** Three weekly resets after {@link BEFORE_RESETS}, one before it. */
  const RESET_X = 1791594000;
  const RESET_Y = 1791640800;
  const RESET_Z = 1791680400;
  const RESET_PAST = 1791140000;
  const isoOf = (sec: number): string => new Date(sec * 1000).toISOString();

  function weekText(week: number, reset: number, apiMs: number, five?: number): string {
    return JSON.stringify({
      session_id: SESSION,
      cost: { total_api_duration_ms: apiMs },
      rate_limits: {
        ...(five === undefined ? {} : { five_hour: { used_percentage: five, resets_at: 1791163800 } }),
        seven_day: { used_percentage: week, resets_at: reset },
      },
    });
  }

  async function dump(name: string, text: string, mtimeSec: number): Promise<void> {
    const path = join(root, name);
    await writeFile(path, text);
    await utimes(path, mtimeSec, mtimeSec);
  }

  it('two dumps of one reset → the window takes the percent of the dump with the later `changeAt`', async () => {
    await dump('a.json', weekText(90, RESET_X, 100), T0 + 1000);
    await dump('b.json', weekText(95, RESET_X, 200), T0 + 900);
    expect((await scanFreshestRateLimits(root, BEFORE_RESETS))?.weeklyWindows)
      .toEqual([{ percent: 90, resetsAt: isoOf(RESET_X), at: (T0 + 1000) * 1000 }]);
    // B asks the API again (new fingerprint); A only redraws its bar with the old numbers.
    await dump('b.json', weekText(96, RESET_X, 300), T0 + 2000);
    await dump('a.json', weekText(90, RESET_X, 100), T0 + 3000);
    expect((await scanFreshestRateLimits(root, BEFORE_RESETS))?.weeklyWindows)
      .toEqual([{ percent: 96, resetsAt: isoOf(RESET_X), at: (T0 + 2000) * 1000 }]);
  });

  it('one window per live reset, in reset order; the winner of the tile stays the same', async () => {
    await dump('a.json', weekText(97, RESET_X, 100), T0 + 1000);
    await dump('c.json', weekText(99.4, RESET_Z, 300), T0 + 1100);
    await dump('b.json', weekText(40, RESET_Y, 200, 12), T0 + 2000);
    const limits = await scanFreshestRateLimits(root, BEFORE_RESETS);
    expect(limits?.weekly).toEqual({ percent: 40, resetsAt: isoOf(RESET_Y) });
    expect(limits?.fiveHour?.percent).toBe(12);
    expect(limits?.at).toBe((T0 + 2000) * 1000);
    expect(limits?.weeklyWindows).toEqual([
      { percent: 97, resetsAt: isoOf(RESET_X), at: (T0 + 1000) * 1000 },
      { percent: 40, resetsAt: isoOf(RESET_Y), at: (T0 + 2000) * 1000 },
      { percent: 99.4, resetsAt: isoOf(RESET_Z), at: (T0 + 1100) * 1000 },
    ]);
  });

  it('a window past its reset is left out; a dump with only a five-hour window adds none', async () => {
    await dump('stary.json', weekText(98, RESET_PAST, 100), T0 + 3000);
    await dump('a.json', weekText(70, RESET_X, 200), T0 + 1000);
    await dump('piec.json', JSON.stringify({
      session_id: SESSION, rate_limits: { five_hour: { used_percentage: 5, resets_at: 1791163800 } },
    }), T0 + 4000);
    const limits = await scanFreshestRateLimits(root, BEFORE_RESETS);
    expect(limits?.weeklyWindows).toEqual([{ percent: 70, resetsAt: isoOf(RESET_X), at: (T0 + 1000) * 1000 }]);
    // The winner is still the newest dump with a live window (the five-hour one).
    expect(limits?.fiveHour?.percent).toBe(5);
    expect(limits?.weekly).toBeUndefined();
  });

  it('`readFreshestRateLimits` (`GET /api/usage`) gets the winner only, without the window list', async () => {
    await dump('a.json', weekText(97, RESET_X, 100), T0 + 1000);
    await dump('b.json', weekText(40, RESET_Y, 200), T0 + 2000);
    expect(await readFreshestRateLimits(root, BEFORE_RESETS)).toEqual({
      weekly: { percent: 40, resetsAt: isoOf(RESET_Y) },
      at: (T0 + 2000) * 1000,
    });
  });
});
