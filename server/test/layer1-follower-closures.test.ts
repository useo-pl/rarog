/**
 * Pamięć zamknięć followera dla kanału zgód (warstwa 1): skrót wejścia zamkniętego `tool_use` i chwila zamknięcia,
 * którego pamięć już nie ma. Luka odczytu i skrócenie pliku gubią zamknięcia sprzed resetu trackera, więc chwila
 * utraty pokrycia przesuwa się na chwilę resetu: brak prośby w transkrypcie zabiera wtedy dowód każdemu hookowi,
 * który wystartował wcześniej, zamiast zostać niewiadomą. Plik skrócony do zera jest znany i pusty, nie nieznany.
 *
 * Nowy follower, którego okno ogona zaczyna się w środku pliku (podpięcie do długiej rozmowy), nie zna zamknięć sprzed
 * okna: gubi je z chwilą pierwszego wpisu `assistant` wątku głównego w oknie, bo prompt z kolejki (`attachment`
 * `queued_command`) niesie chwilę starszą niż wyniki zapisane przed nim; okno bez takiego wpisu gubi je z chwilą
 * odczytu. Istniejący pusty plik przy pierwszym odczycie nowego followera jest nieznany (`null`), nie znany i pusty.
 */
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectSlug } from '../src/cli-store.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';

vi.setConfig({ testTimeout: 20_000 });

const CWD = '/Users/u/Projects/zamkniecia';
const SESSION = '3a1d6c0e-5b7f-4c2a-9e1d-0f4b8a2c6e71';
/** Rozmowa po `/clear` albo `/resume` w tym samym panelu (`repoint`). */
const SESSION_B = '5c2e8a1f-7d3b-4e6a-8f2c-1b9d0e4a7c35';
const TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };
const BASH = { command: 'echo zamkniecie > /dev/null', description: 'Wywołanie testu' };
const NOW = 1_762_600_000_000;

let root = '';
let dir = '';
const followers: JsonlFollower[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-zamkniecia-'));
  dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  for (const follower of followers.splice(0)) follower.close();
  await rm(root, { recursive: true, force: true });
});

const file = (): string => join(dir, `${SESSION}.jsonl`);
const line = (entry: Record<string, unknown>): string => `${JSON.stringify({ isSidechain: false, sessionId: SESSION, ...entry })}\n`;
const userLine = (text: string, at: string): string => line({ type: 'user', timestamp: at, message: { role: 'user', content: text } });
const toolUseLine = (id: string, at: string): string => line({
  type: 'assistant', timestamp: at,
  message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id, name: 'Bash', input: BASH }] },
});
const toolResultLine = (id: string, at: string): string => line({
  type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};

/** Follower na pliku z jednym zamkniętym `Bash`; zwraca go po pierwszej historii. */
async function followClosed(maxReadBytes?: number): Promise<JsonlFollower> {
  const tmp = `${file()}.partial`;
  await writeFile(tmp, userLine('zbuduj', '2026-11-08T10:00:00.000Z') + toolUseLine('toolu_z', '2026-11-08T10:00:01.000Z')
    + toolResultLine('toolu_z', '2026-11-08T10:00:02.000Z'));
  await rename(tmp, file());
  const follower = createJsonlFollower({
    cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING, now: () => NOW,
    ...(maxReadBytes === undefined ? {} : { maxReadBytes }),
  });
  followers.push(follower);
  const events: FollowEvent[] = [];
  void (async () => {
    for await (const event of follower.events) events.push(event);
  })();
  await waitFor(() => events.some((e) => e.type === 'history'), 'historia');
  return follower;
}

describe('follower: pamięć zamknięć dla kanału zgód', () => {
  it('zamknięty `tool_use` ze skrótem wejścia i chwilą wyniku, bez utraty pokrycia', async () => {
    const follower = await followClosed();
    expect(follower.closedToolUses?.()).toEqual({
      closed: [{
        id: 'toolu_z', toolName: 'Bash', inputSha256: canonicalSha256(BASH), closedAt: Date.parse('2026-11-08T10:00:02.000Z'),
      }],
      lostAt: null,
    });
  });

  it('luka odczytu (przyrost ponad sufit) → chwila utraty pokrycia = chwila resetu', async () => {
    const follower = await followClosed(2_000);
    await appendFile(file(), userLine('x'.repeat(4_000), '2026-11-08T10:00:03.000Z') + userLine('dalej', '2026-11-08T10:00:04.000Z'));
    await waitFor(() => follower.closedToolUses?.()?.lostAt === NOW, 'utrata pokrycia po luce');
    expect(follower.closedToolUses?.()?.closed).toEqual([]);
  });

  it('skrócenie pliku → chwila utraty pokrycia = chwila resetu', async () => {
    const follower = await followClosed();
    await writeFile(file(), userLine('a', '2026-11-08T10:00:05.000Z'));
    await waitFor(() => follower.closedToolUses?.()?.lostAt === NOW, 'utrata pokrycia po skróceniu');
  });

  it('skrócenie do pustego pliku → plik znany i pusty: `[]` i wszystkie zamknięcia stracone z chwilą resetu, pozycja'
    + ' dla przeglądu bez zmian (`null`)', async () => {
    const follower = await followClosed();
    expect(follower.openToolUses?.()).toEqual([]);
    await writeFile(file(), '');
    await waitFor(() => follower.closedToolUses?.() !== null && follower.closedToolUses?.()?.lostAt === NOW,
      'utrata pokrycia po skróceniu do zera');
    expect(follower.openToolUses?.()).toEqual([]);
    expect(follower.closedToolUses?.()).toEqual({ closed: [], lostAt: NOW });
    expect(follower.transcriptOffset?.()).toBeNull();
    // Plik rośnie od zera: zamknięcia z nowej treści wchodzą do pamięci, utrata pokrycia zostaje.
    await appendFile(file(), toolUseLine('toolu_n', '2026-11-08T10:00:06.000Z') + toolResultLine('toolu_n', '2026-11-08T10:00:07.000Z'));
    await waitFor(() => follower.closedToolUses?.()?.closed.length === 1, 'zamknięcie po skróceniu');
    expect(follower.closedToolUses?.()?.lostAt).toBe(NOW);
  });

  it('przed pierwszym odczytem (pliku jeszcze nie ma) → `null`, jak dotąd', async () => {
    const follower = createJsonlFollower({ cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING, now: () => NOW });
    followers.push(follower);
    expect(follower.openToolUses?.()).toBeNull();
    expect(follower.closedToolUses?.()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(follower.openToolUses?.()).toBeNull();
    expect(follower.closedToolUses?.()).toBeNull();
  });

  it('`repoint()` po skróceniu do zera: plik nowej rozmowy nie dziedziczy stanu „znany i pusty” (`null`, także nad'
    + ' istniejącym pustym plikiem)', async () => {
    const follower = await followClosed();
    await writeFile(file(), '');
    await waitFor(() => follower.closedToolUses?.()?.lostAt === NOW, 'skrócenie do zera');
    expect(follower.openToolUses?.()).toEqual([]);
    await writeFile(join(dir, `${SESSION_B}.jsonl`), '');
    follower.repoint(SESSION_B);
    // Pusty plik nowej rozmowy zostawia pozycję 0 przed odczytem i po nim: wynik nie zależy od chwili sprawdzenia.
    await waitFor(() => follower.hasTranscript() === 'yes', 'plik nowej rozmowy');
    expect(follower.openToolUses?.()).toBeNull();
    expect(follower.closedToolUses?.()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(follower.openToolUses?.()).toBeNull();
    expect(follower.closedToolUses?.()).toBeNull();
  });
});

// ---------------------------------------------------------------- okno ogona w środku pliku

const assistantTextLine = (text: string, at: string): string => line({
  type: 'assistant', timestamp: at, message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text }] },
});
/** Wpis promptu z kolejki: CLI stempluje go chwilą wpisania do kolejki, a zapisuje przy zdjęciu (CLI 2.1.295). */
const queuedLine = (text: string, at: string): string => line({
  type: 'attachment', timestamp: at, attachment: { type: 'queued_command', prompt: text },
});
/** Wpis bez chwili (tytuł panelu). */
const titleLine = (title: string): string => line({ type: 'custom-title', customTitle: title });
/** Długi wpis spoza rozmowy: okno ogona zaczyna się w jego środku, więc follower go nie czyta. */
const fillerLine = (at: string): string => line({ type: 'system', subtype: 'informational', timestamp: at, content: 'x'.repeat(2_000) });

/**
 * Nowy follower (podpięcie do długiej rozmowy) na pliku `prefix + wypełniacz + window`: okno ogona
 * zaczyna się w środku wypełniacza, więc pierwszy pełny wpis okna to pierwszy wpis `window`. Zwraca go po pierwszym
 * odczycie pliku.
 */
async function followWindow(prefix: string, window: string): Promise<JsonlFollower> {
  const filler = fillerLine('2026-11-08T10:00:03.000Z');
  const tmp = `${file()}.partial`;
  await writeFile(tmp, prefix + filler + window);
  await rename(tmp, file());
  const bytes = Buffer.byteLength(window) + Math.floor(Buffer.byteLength(filler) / 2);
  const follower = createJsonlFollower({
    cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING, now: () => NOW,
    historyBytes: bytes, historyMaxBytes: bytes, historyMessages: 1_000,
  });
  followers.push(follower);
  await waitFor(() => follower.closedToolUses?.() !== null, 'pierwszy odczyt');
  return follower;
}

/** Prośba rozstrzygnięta przy biurku przed oknem: prompt, `tool_use` i jego wynik. */
const DESK_PREFIX = userLine('zbuduj', '2026-11-08T10:00:00.000Z') + toolUseLine('toolu_biurko', '2026-11-08T10:00:01.000Z')
  + toolResultLine('toolu_biurko', '2026-11-08T10:00:02.000Z');

describe('follower: okno ogona w środku pliku gubi zamknięcia sprzed okna', () => {
  it('zamknięcia sprzed okna przepadają z chwilą pierwszego wpisu `assistant` okna (pierwszy wpis okna z chwilą)',
    async () => {
      const follower = await followWindow(DESK_PREFIX, assistantTextLine('dalej', '2026-11-08T10:00:04.000Z')
        + userLine('jeszcze', '2026-11-08T10:00:05.000Z'));
      expect(follower.closedToolUses?.()).toEqual({ closed: [], lostAt: Date.parse('2026-11-08T10:00:04.000Z') });
      expect(follower.openToolUses?.()).toEqual([]);
    });

  it('prompt z kolejki na początku okna ma chwilę starszą niż wynik przed oknem: utrata pokrycia od pierwszego'
    + ' wpisu `assistant`, nie od niego', async () => {
    const follower = await followWindow(DESK_PREFIX, queuedLine('a potem testy', '2026-11-08T10:00:00.500Z')
      + userLine('a potem testy', '2026-11-08T10:00:04.000Z') + assistantTextLine('robię', '2026-11-08T10:00:05.000Z'));
    const lostAt = follower.closedToolUses?.()?.lostAt ?? null;
    expect(lostAt).toBe(Date.parse('2026-11-08T10:00:05.000Z'));
    expect(lostAt).toBeGreaterThanOrEqual(Date.parse('2026-11-08T10:00:02.000Z'));
  });

  it('okno bez wpisu z chwilą albo bez wpisu `assistant` → utrata pokrycia z chwilą odczytu', async () => {
    const bare = await followWindow(DESK_PREFIX, titleLine('refaktor') + titleLine('refaktor 2'));
    expect(bare.closedToolUses?.()).toEqual({ closed: [], lostAt: NOW });
    for (const follower of followers.splice(0)) follower.close();
    const users = await followWindow(DESK_PREFIX, userLine('jeszcze', '2026-11-08T10:00:04.000Z'));
    expect(users.closedToolUses?.()).toEqual({ closed: [], lostAt: NOW });
  });

  it('plik czytany od początku (okno obejmuje cały plik, także z wpisem `assistant`) → bez utraty pokrycia, jak dotąd',
    async () => {
      const tmp = `${file()}.partial`;
      await writeFile(tmp, DESK_PREFIX + assistantTextLine('dalej', '2026-11-08T10:00:04.000Z'));
      await rename(tmp, file());
      const follower = createJsonlFollower({ cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING, now: () => NOW });
      followers.push(follower);
      await waitFor(() => follower.closedToolUses?.() !== null, 'pierwszy odczyt');
      expect(follower.closedToolUses?.()?.lostAt).toBeNull();
      expect(follower.closedToolUses?.()?.closed.map((tool) => tool.id)).toEqual(['toolu_biurko']);
    });
});

describe('follower: kotwica okna ogona (każdy nowy follower)', () => {
  it('kotwica pomija wpis `assistant` podagenta (`isSidechain: true`) i wpis `assistant` bez chwili albo z chwilą'
    + ' nieczytelną', async () => {
    const content = { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'robię' }] };
    const sidechain = line({ type: 'assistant', isSidechain: true, timestamp: '2026-11-08T10:00:04.000Z', message: content });
    const noTime = line({ type: 'assistant', message: content });
    const badTime = line({ type: 'assistant', timestamp: 'wczoraj', message: content });
    const follower = await followWindow(DESK_PREFIX, sidechain + noTime + badTime
      + assistantTextLine('dalej', '2026-11-08T10:00:06.000Z'));
    expect(follower.closedToolUses?.()).toEqual({ closed: [], lostAt: Date.parse('2026-11-08T10:00:06.000Z') });
  });
});

// ---------------------------------------------------------------- pierwszy odczyt istniejącego pustego pliku

/**
 * Nowy follower na pliku o treści `content`, czytanym od początku. Zwraca go po pierwszym odczycie pliku: pierwsza
 * wypłata listy zadań w tle idzie po nim bezwarunkowo, także przy pustym pliku.
 */
async function followFile(content: string): Promise<JsonlFollower> {
  const tmp = `${file()}.partial`;
  await writeFile(tmp, content);
  await rename(tmp, file());
  const follower = createJsonlFollower({ cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING, now: () => NOW });
  followers.push(follower);
  const events: FollowEvent[] = [];
  void (async () => {
    for await (const event of follower.events) events.push(event);
  })();
  await waitFor(() => events.some((e) => e.type === 'tasks'), 'pierwszy odczyt');
  return follower;
}

describe('follower: pierwszy odczyt istniejącego pustego pliku', () => {
  it('nowy follower nad istniejącym pustym plikiem → `null` (transkrypt nieznany; po powrocie gniazda herdr dowód'
    + ' hookom sprzed niego zabiera granica w cyklu kanału zgód)', async () => {
    const follower = await followFile('');
    expect(follower.openToolUses?.()).toBeNull();
    expect(follower.closedToolUses?.()).toBeNull();
  });
});
