/**
 * Limity planu (`usage.ts`): liczby z paska statusu Claude Code, e-mail z `~/.claude.json`.
 *
 * Każdy provider w tym pliku dostaje katalog zrzutów i plik `~/.claude.json` z katalogu
 * tymczasowego — domyślne ścieżki sięgnęłyby po prawdziwe pliki człowieka. Zrzut ma kształt
 * `rate_limits` paska statusu (CLI ≥ 2.1.247, sekundy epoki), a jego `mtime` to chwila odczytu.
 */
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_JSON_MAX_BYTES, CLI_USAGE_STALE_MS, createUsageProvider,
} from '../src/usage.ts';

/*
 * Strażnik granicy: moduł nie ma prawa uruchomić procesu (np. `security`, który czyta Keychain) ani
 * zapytać sieci. Atrapa `node:child_process` liczy KAŻDĄ próbę, `fetch` jest podmieniony niżej.
 */
const spawnAttempts = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => {
  const refuse = (...args: unknown[]): never => {
    spawnAttempts(...args);
    throw new Error('usage.ts nie uruchamia procesów');
  };
  return {
    execFile: refuse, execFileSync: refuse, exec: refuse, execSync: refuse, spawn: refuse, spawnSync: refuse,
  };
});

const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const FIVE_HOUR_RESET = Date.parse('2026-10-18T13:20:00.000Z');
const WEEK_RESET = Date.parse('2026-10-23T15:00:00.000Z');

/** Payload paska statusu z dwoma oknami limitów; `extra` dopisuje pola spoza `rate_limits`. */
function payload(
  fiveHour = 41, weekly = 63, extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: 's-1',
    model: { id: 'claude-opus-5' },
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: FIVE_HOUR_RESET / 1000 },
      seven_day: { used_percentage: weekly, resets_at: WEEK_RESET / 1000 },
    },
    ...extra,
  });
}

let base = '';
let statuslineRoot = '';
let claudeJsonPath = '';
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-usage-'));
  statuslineRoot = join(base, 'statusline');
  claudeJsonPath = join(base, 'claude.json');
  await mkdir(statuslineRoot);
  spawnAttempts.mockClear();
  fetchSpy = vi.fn(() => { throw new Error('usage.ts nie woła sieci'); });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  // Żaden przypadek w tym pliku nie może dotknąć sieci ani uruchomić procesu.
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(spawnAttempts).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/** Zrzut sesji z `mtime` = `at` (ms epoki). */
async function dump(name: string, text: string, at: number): Promise<void> {
  const file = join(statuslineRoot, `${name}.json`);
  await writeFile(file, text);
  await utimes(file, new Date(at), new Date(at));
}

async function claudeJson(value: unknown): Promise<void> {
  await writeFile(claudeJsonPath, typeof value === 'string' ? value : JSON.stringify(value));
}

function provider(now: () => number = () => NOW, logger?: (line: string) => void) {
  return createUsageProvider({
    statuslineRoot, claudeJsonPath, now, ...(logger === undefined ? {} : { logger }),
  });
}

describe('createUsageProvider — liczby z paska statusu', () => {
  it('świeży zrzut: bez `stale`, ze źródłem, chwilą zrzutu, oknami i e-mailem konta', async () => {
    await dump('s-1', payload(), NOW - 2 * 60_000);
    await claudeJson({ oauthAccount: { emailAddress: 'kto@example.com' }, mcpServers: { x: { env: {} } } });
    expect(await provider().get()).toEqual({
      source: 'cli',
      fetchedAt: '2026-10-18T09:58:00.000Z',
      fiveHour: { percent: 41, resetsAt: '2026-10-18T13:20:00.000Z' },
      weekly: { percent: 63, resetsAt: '2026-10-23T15:00:00.000Z' },
      account: 'kto@example.com',
    });
  });

  it('zrzut starszy niż próg dostaje `stale: true`; równy progowi jest jeszcze świeży', async () => {
    const at = NOW - CLI_USAGE_STALE_MS;
    await dump('s-1', payload(), at);
    expect((await provider().get())?.stale).toBeUndefined();
    const stale = await provider(() => NOW + 1).get();
    expect(stale).toMatchObject({ stale: true, source: 'cli', fetchedAt: new Date(at).toISOString() });
    expect(stale?.fiveHour?.percent).toBe(41);
  });

  it('wygrywa najświeższy zrzut z limitami, a nie ostatni plik w katalogu', async () => {
    await dump('stara', payload(10, 20), NOW - 30 * 60_000);
    await dump('nowa', payload(55, 70), NOW - 60_000);
    await dump('bez-limitow', JSON.stringify({ session_id: 'x' }), NOW - 10_000);
    const usage = await provider().get();
    expect(usage?.fiveHour?.percent).toBe(55);
    expect(usage?.weekly?.percent).toBe(70);
    expect(usage?.fetchedAt).toBe(new Date(NOW - 60_000).toISOString());
  });

  it('okno po resecie wypada; bez żadnego żywego okna = `null`', async () => {
    await dump('s-1', payload(), NOW - 60_000);
    const afterFiveHour = await provider(() => FIVE_HOUR_RESET + 1).get();
    expect(afterFiveHour?.fiveHour).toBeUndefined();
    expect(afterFiveHour?.weekly?.percent).toBe(63);
    expect(await provider(() => WEEK_RESET + 1).get()).toBeNull();
  });

  it('brak zrzutów, brak katalogu, zrzut bez `rate_limits` = `null`', async () => {
    expect(await provider().get()).toBeNull();
    await dump('s-1', JSON.stringify({ session_id: 's-1', model: { id: 'claude-opus-5' } }), NOW);
    expect(await provider().get()).toBeNull();
    const missing = createUsageProvider({ statuslineRoot: join(base, 'nie-ma'), claudeJsonPath, now: () => NOW });
    expect(await missing.get()).toBeNull();
  });

  it('bez cache: nowy zrzut widać w następnym odczycie', async () => {
    const usage = provider();
    await dump('s-1', payload(41), NOW - 60_000);
    expect((await usage.get())?.fiveHour?.percent).toBe(41);
    await dump('s-1', payload(42), NOW);
    expect((await usage.get())?.fiveHour?.percent).toBe(42);
  });

  it('przerysowanie bez zmiany liczb nie odświeża `fetchedAt` ani nie zdejmuje `stale`', async () => {
    const usage = provider(() => NOW + CLI_USAGE_STALE_MS);
    await dump('s-1', payload(41), NOW - 60_000);
    expect(await usage.get()).toMatchObject({ stale: true, fetchedAt: new Date(NOW - 60_000).toISOString() });
    // Bezczynna sesja rysuje pasek od nowa: nowy `mtime`, ta sama treść.
    await dump('s-1', payload(41), NOW);
    expect(await usage.get()).toMatchObject({ stale: true, fetchedAt: new Date(NOW - 60_000).toISOString() });
    await dump('s-1', payload(42), NOW + 1000);
    const changed = await usage.get();
    expect(changed?.stale).toBeUndefined();
    expect(changed).toMatchObject({ fetchedAt: new Date(NOW + 1000).toISOString(), fiveHour: { percent: 42 } });
  });

  it('nigdy nie wysyła okna per model: pasek statusu go nie niesie', async () => {
    await dump('s-1', payload(41, 63, { seven_day_opus: { used_percentage: 90 } }), NOW);
    expect((await provider().get())?.weeklyModel).toBeUndefined();
  });
});

describe('createUsageProvider — e-mail konta z `~/.claude.json`', () => {
  beforeEach(async () => {
    await dump('s-1', payload(), NOW - 60_000);
  });

  it('jedno pole `oauthAccount.emailAddress`, przycięte', async () => {
    await claudeJson({ oauthAccount: { emailAddress: '  kto@example.com\n', displayName: 'Kto' } });
    expect((await provider().get())?.account).toBe('kto@example.com');
  });

  it('brak pliku, brak pola, pole puste albo nie-tekst = liczby bez e-maila', async () => {
    const cases: unknown[] = [
      {}, { oauthAccount: {} }, { oauthAccount: { emailAddress: '  ' } }, { oauthAccount: { emailAddress: 42 } },
      { oauthAccount: 'kto@example.com' }, { emailAddress: 'kto@example.com' }, [],
    ];
    const usage = provider();
    const withoutFile = await usage.get();
    expect(withoutFile?.fiveHour?.percent).toBe(41);
    expect(withoutFile).not.toHaveProperty('account');
    for (const value of cases) {
      await claudeJson(value);
      const read = await usage.get();
      expect(read?.weekly?.percent, JSON.stringify(value)).toBe(63);
      expect(read, JSON.stringify(value)).not.toHaveProperty('account');
    }
  });

  it('zepsuty JSON = bez e-maila, bez wyjątku', async () => {
    await claudeJson('{"oauthAccount": {"emailAddress": "kto@example.com"');
    const usage = await provider().get();
    expect(usage?.fiveHour?.percent).toBe(41);
    expect(usage).not.toHaveProperty('account');
  });

  it('plik ponad sufit = bez e-maila, choć pole w nim jest', async () => {
    const head = JSON.stringify({ oauthAccount: { emailAddress: 'kto@example.com' } }).slice(0, -1);
    const padded = `${head},"pad":"${' '.repeat(CLAUDE_JSON_MAX_BYTES)}"}`;
    await claudeJson(padded);
    expect(JSON.parse(padded)).toMatchObject({ oauthAccount: { emailAddress: 'kto@example.com' } });
    expect(await provider().get()).not.toHaveProperty('account');
  });

  it('katalog w miejscu pliku = bez e-maila', async () => {
    await mkdir(claudeJsonPath);
    expect(await provider().get()).not.toHaveProperty('account');
  });
});

describe('createUsageProvider — log', () => {
  it('linia tylko przy zmianie stanu i nigdy z treścią plików', async () => {
    const lines: string[] = [];
    const usage = provider(() => NOW, (line) => { lines.push(line); });
    await usage.get();
    await usage.get();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^rarog: plan usage: unavailable/);

    await dump('s-1', payload(), NOW - 60_000);
    await claudeJson({ oauthAccount: { emailAddress: 'kto@example.com' } });
    await usage.get();
    await usage.get();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('rarog: plan usage: works (Claude Code status line).');

    await claudeJson('{zepsuty');
    await usage.get();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/without the account e-mail/);
    expect(lines.join('\n')).not.toMatch(/kto@example\.com|zepsuty|41|63/);
  });
});

/*
 * Szczegóły limitów (`details()`, `GET /api/usage/details`): odczyt, który Claude Code
 * zapisuje sam w `~/.claude.json` pod `cachedUsageUtilization`. Fixture'y mają WYŁĄCZNIE pola, które Rarog
 * czyta (plus jedno pole spoza listy, żeby sprawdzić, że odpada), i syntetyczne identyfikatory konta.
 */
describe('createUsageProvider — szczegóły z odczytu Claude Code (`cachedUsageUtilization`)', () => {
  const ACCOUNT = '00000000-0000-4000-8000-00000000000a';
  const OTHER = '00000000-0000-4000-8000-00000000000b';
  const FETCHED = NOW - 3 * 60 * 60_000;

  /** Wpis `limits[]` w zmierzonym kształcie (ISO z mikrosekundami). */
  const limit = (kind: string, percent: number, resetsAt: string | null, model?: string): unknown => ({
    kind, percent, resets_at: resetsAt,
    scope: model === undefined ? null : { model: { display_name: model } },
  });
  const limits = (): unknown[] => [
    limit('session', 20, '2026-10-18T13:20:00.403026+00:00'),
    limit('weekly_all', 57, '2026-10-23T15:00:00.403044+00:00'),
    limit('weekly_scoped', 34, '2026-10-23T15:00:00.403187+00:00', 'Fable'),
  ];
  const file = (cache: Record<string, unknown>, own: unknown = ACCOUNT): Record<string, unknown> => ({
    oauthAccount: { emailAddress: 'kto@example.com', accountUuid: own },
    cachedUsageUtilization: cache,
  });
  const cache = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    fetchedAtMs: FETCHED, accountUuid: ACCOUNT, utilization: { limits: limits() }, ...extra,
  });

  it('trzy okna z resetem w ISO, własna chwila odczytu, `stale`, e-mail; bez `source` i bez innych pól', async () => {
    await claudeJson(file(cache({ utilization: { limits: limits(), inny_klucz: { percent: 99 } } })));
    expect(await provider().details()).toEqual({
      stale: true,
      fetchedAt: new Date(FETCHED).toISOString(),
      fiveHour: { percent: 20, resetsAt: '2026-10-18T13:20:00.403Z' },
      weekly: { percent: 57, resetsAt: '2026-10-23T15:00:00.403Z' },
      weeklyModel: { percent: 34, resetsAt: '2026-10-23T15:00:00.403Z', model: 'Fable' },
      account: 'kto@example.com',
    });
  });

  it('odczyt nie starszy niż próg jest świeży; brak zrzutów paska statusu niczego tu nie zmienia', async () => {
    await claudeJson(file(cache({ fetchedAtMs: NOW - CLI_USAGE_STALE_MS })));
    const usage = await provider().details();
    expect(usage.stale).toBeUndefined();
    expect(usage.weeklyModel?.percent).toBe(34);
    expect(await provider().get()).toBeNull();
  });

  it('brak pliku, brak klucza, inne konto, konto nie do porównania = `{}`', async () => {
    expect(await provider().details()).toEqual({});
    const cases: unknown[] = [
      { oauthAccount: { emailAddress: 'kto@example.com', accountUuid: ACCOUNT } },
      file(cache({ accountUuid: OTHER })),
      file(cache(), OTHER),
      file(cache(), null),
      file(cache(), ''),
      file(cache({ accountUuid: null }), null),
      { cachedUsageUtilization: cache() },
    ];
    for (const value of cases) {
      await claudeJson(value);
      expect(await provider().details(), JSON.stringify(value)).toEqual({});
    }
  });

  it('bez `weekly_scoped`: 5 h i tydzień bez okna per model; model bez nazwy zostaje oknem bez `model`', async () => {
    await claudeJson(file(cache({ utilization: { limits: limits().slice(0, 2) } })));
    const usage = await provider().details();
    expect(usage.fiveHour?.percent).toBe(20);
    expect(usage.weekly?.percent).toBe(57);
    expect(usage).not.toHaveProperty('weeklyModel');
    await claudeJson(file(cache({ utilization: { limits: [limit('weekly_scoped', 12, null, '  ')] } })));
    expect((await provider().details()).weeklyModel).toEqual({ percent: 12 });
  });

  it('okna po resecie wypadają; same okna po resecie = `{}`', async () => {
    await claudeJson(file(cache()));
    const afterSession = await provider(() => Date.parse('2026-10-18T13:20:01Z')).details();
    expect(afterSession.fiveHour).toBeUndefined();
    expect(afterSession.weeklyModel?.percent).toBe(34);
    expect(await provider(() => Date.parse('2026-10-23T15:00:01Z')).details()).toEqual({});
  });

  it('obcy kształt: brak albo zły `fetchedAtMs`, `limits` nie-tablica, wpisy spoza kontraktu odpadają', async () => {
    for (const bad of [
      cache({ fetchedAtMs: undefined }), cache({ fetchedAtMs: '1792264706521' }), cache({ fetchedAtMs: 0 }),
      cache({ fetchedAtMs: 1e300 }), cache({ utilization: { limits: {} } }), cache({ utilization: null }),
    ]) {
      await claudeJson(file(bad));
      expect(await provider().details(), JSON.stringify(bad)).toEqual({});
    }
    await claudeJson(file(cache({ utilization: { limits: [
      limit('weekly_scoped', -1, null, 'Fable'), limit('session', Number.NaN, null), null, 'tekst',
      limit('daily', 5, null), limit('weekly_all', 40, 'nie-data'), limit('weekly_all', 41, null),
      limit('session', 7, null), limit('session', 8, null),
    ] } })));
    expect(await provider().details()).toEqual({
      stale: true, fetchedAt: new Date(FETCHED).toISOString(),
      fiveHour: { percent: 7 }, weekly: { percent: 41 }, account: 'kto@example.com',
    });
  });

  it('zepsuty JSON, plik ponad sufit, katalog w miejscu pliku = `{}` bez wyjątku', async () => {
    await claudeJson(JSON.stringify(file(cache())).slice(0, -2));
    expect(await provider().details()).toEqual({});
    const head = JSON.stringify(file(cache())).slice(0, -1);
    await claudeJson(`${head},"pad":"${' '.repeat(CLAUDE_JSON_MAX_BYTES)}"}`);
    expect(await provider().details()).toEqual({});
    await mkdir(join(base, 'katalog.json'));
    const dir = createUsageProvider({ statuslineRoot, claudeJsonPath: join(base, 'katalog.json'), now: () => NOW });
    expect(await dir.details()).toEqual({});
  });

  it('jeden czytnik pliku: e-mail w `get()` i szczegóły z tych samych reguł (inne konto nie zabiera e-maila)', async () => {
    await dump('s-1', payload(), NOW - 60_000);
    await claudeJson(file(cache({ accountUuid: OTHER })));
    expect((await provider().get())?.account).toBe('kto@example.com');
    expect(await provider().details()).toEqual({});
  });

  it('log: linia przy zmianie stanu, z powodem, nigdy z treścią pliku', async () => {
    const lines: string[] = [];
    const usage = provider(() => NOW, (line) => { lines.push(line); });
    await claudeJson(file(cache({ accountUuid: OTHER })));
    await usage.details();
    await usage.details();
    expect(lines).toEqual([
      'rarog: usage details: no Claude Code reading — the usage reading is from a different account than '
        + '`oauthAccount` (or the accounts cannot be compared).',
    ]);
    await claudeJson(file(cache()));
    await usage.details();
    expect(lines[1]).toBe('rarog: usage details: works (Claude Code reading from `~/.claude.json`).');
    await claudeJson('{zepsuty');
    await usage.details();
    expect(lines[2]).toMatch(/unreadable, larger than 4 MiB or not JSON/);
    expect(lines.join('\n')).not.toMatch(/kto@example\.com|zepsuty|Fable|00000000|\b34\b|\b57\b/);
  });
});
