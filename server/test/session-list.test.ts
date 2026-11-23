/**
 * Adapter oficjalnego API listy sesji (`session-list.ts`).
 *
 * Testy chodzą na PODMIENIONYM wejściu (`lister`), nie na prawdziwym SDK — sprawdzają nasze
 * reguły odsiewu i mapowania, a nie cudzy pakiet. Od kontraktu samego pakietu jest osobny,
 * jedyny test dotykający dysku: `sdk-boundary.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_FIRST_PROMPT_LENGTH } from '@rarog/shared';
import {
  ENGINE_SESSION_FETCH_CAP, clipPrompt, createSessionListReader, toResumableSession,
} from '../src/session-list.ts';
import type { EngineSessionInfo } from '../src/session-list.ts';

const INFO: EngineSessionInfo = {
  sessionId: 'e1d80687-b533-4ca2-9fab-6501df255f83',
  summary: 'Naprawa zapisu notatek',
  lastModified: Date.parse('2026-08-27T10:00:00.000Z'),
  cwd: '/Users/x/Projects/willow',
  firstPrompt: 'Popraw zapis notatek — po restarcie gubi ostatnią zmianę.',
  gitBranch: 'fix/zapis',
};

describe('clipPrompt', () => {
  it('skleja białe znaki i przycina razem z elipsą w limicie', () => {
    expect(clipPrompt('  Popraw\n  zapis notatek.  ')).toBe('Popraw zapis notatek.');
    const clipped = clipPrompt('x'.repeat(200), 120);
    expect(clipped).toHaveLength(120);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('zdejmuje obwódkę <pasted_content> (CLI ≥ 2.1.277, kształt z API zmierzony)', () => {
    expect(clipPrompt('[Image #1] <pasted_content id="636f"> Jak przewijam tekst </pasted_content id="636f">'))
      .toBe('[Image #1] Jak przewijam tekst');
    // Tag bez `id` to treść człowieka, nie hydraulika CLI.
    expect(clipPrompt('co znaczy <pasted_content>?')).toBe('co znaczy <pasted_content>?');
  });
});

describe('toResumableSession', () => {
  it('mapuje wpis API na wpis kontraktu', () => {
    expect(toResumableSession(INFO)).toEqual({
      engineSessionId: INFO.sessionId,
      cwd: INFO.cwd,
      mtime: '2026-08-27T10:00:00.000Z',
      firstPrompt: INFO.firstPrompt,
      title: 'Naprawa zapisu notatek',
      gitBranch: 'fix/zapis',
      liveInHerdr: false,
    });
  });

  /*
   * Pole `cwd` jest w API opcjonalne i pusto bywa CZĘSTO (zmierzone: 18 z 190 wpisów).
   * Bez katalogu nie ma czego wznawiać ani czym zwalidować allow-listy — wiersz byłby
   * przyciskiem prowadzącym w 400.
   */
  it('odrzuca wpis bez `cwd`', () => {
    expect(toResumableSession({ ...INFO, cwd: undefined })).toBeNull();
    expect(toResumableSession({ ...INFO, cwd: '' })).toBeNull();
  });

  /*
   * Brak streszczenia NIE jest powodem do odrzucenia: sesja z samym pierwszym promptem jest
   * wznawialna, a wiersz ma własną etykietę na wpis bez jednego i drugiego. Odsiew dopiero
   * wtedy, gdy nie ma ŻADNEGO tytułu.
   */
  it('puste streszczenie cofa się do pierwszego promptu', () => {
    expect(toResumableSession({ ...INFO, summary: '   ' })?.title).toBe(INFO.firstPrompt);
  });

  it('odrzuca wpis, który nie ma ani streszczenia, ani promptu', () => {
    expect(toResumableSession({ ...INFO, summary: '  ', firstPrompt: '' })).toBeNull();
  });

  it('przycina gałąź tym samym limitem co tytuł', () => {
    const entry = toResumableSession({ ...INFO, gitBranch: 'b'.repeat(300) });
    expect(entry?.gitBranch).toHaveLength(MAX_FIRST_PROMPT_LENGTH);
  });

  /* Kontrakt wymaga `firstPrompt`, API go nie gwarantuje — brakowało go w 20 z 190 wpisów. */
  it('brak `firstPrompt` zastępuje tytułem, zamiast oddawać wiersz bez treści', () => {
    const entry = toResumableSession({ ...INFO, firstPrompt: undefined });
    expect(entry?.firstPrompt).toBe('Naprawa zapisu notatek');
  });

  /* `summary` bywa dłuższe niż kontrakt — zmierzone do 201 znaków przy limicie 120. */
  it('przycina tytuł i pierwszy prompt do limitu kontraktu', () => {
    const entry = toResumableSession({
      ...INFO, summary: 'x'.repeat(300), firstPrompt: 'y'.repeat(300),
    });
    expect(entry?.title).toHaveLength(MAX_FIRST_PROMPT_LENGTH);
    expect(entry?.firstPrompt).toHaveLength(MAX_FIRST_PROMPT_LENGTH);
  });

  it('pustej gałęzi nie przepisuje (pole ma być nieobecne, nie puste)', () => {
    expect(toResumableSession({ ...INFO, gitBranch: '' })).not.toHaveProperty('gitBranch');
  });
});

describe('createSessionListReader', () => {
  it('przekazuje katalog i limit, oddaje zmapowane wpisy', async () => {
    const lister = vi.fn().mockResolvedValue([INFO]);
    const read = createSessionListReader({ lister });
    const out = await read({ dir: '/Users/x/Projects/willow', limit: 5 });
    expect(lister).toHaveBeenCalledWith({ dir: '/Users/x/Projects/willow', limit: 5 });
    expect(out).toHaveLength(1);
  });

  it('bez `dir` pyta o wszystkie projekty (pole nie leci jako `undefined`)', async () => {
    const lister = vi.fn().mockResolvedValue([]);
    await createSessionListReader({ lister })({});
    expect(lister).toHaveBeenCalledWith({ limit: ENGINE_SESSION_FETCH_CAP });
  });

  it('limit ponad sufit przycina do sufitu', async () => {
    const lister = vi.fn().mockResolvedValue([]);
    await createSessionListReader({ lister, fetchCap: 10 })({ limit: 999 });
    expect(lister).toHaveBeenCalledWith({ limit: 10 });
  });

  /** The SDK stand-in: `count` sessions newest first, one minute apart, cut to `limit` like `listSessions()`. */
  const corpusLister = (count: number) => vi.fn(async ({ limit }: { limit?: number }) => Array.from(
    { length: Math.min(count, limit ?? count) },
    (_, i) => ({ ...INFO, sessionId: `s${String(i)}`, lastModified: INFO.lastModified - i * 60_000 }),
  ));

  it('with `since` it reads past the cap until it crosses the boundary and drops older entries', async () => {
    const lister = corpusLister(25);
    const since = INFO.lastModified - 14 * 60_000;
    const out = await createSessionListReader({ lister, fetchCap: 10 })({ since, limit: 3 });
    expect(lister.mock.calls.map(([opts]) => opts)).toEqual([{ limit: 10 }, { limit: 20 }]);
    expect(out.map((entry) => entry.engineSessionId)).toEqual(Array.from({ length: 15 }, (_, i) => `s${String(i)}`));
  });

  it('with `since` it stops when the corpus ends', async () => {
    const lister = corpusLister(12);
    const out = await createSessionListReader({ lister, fetchCap: 10 })({ since: 0 });
    expect(lister.mock.calls.map(([opts]) => opts)).toEqual([{ limit: 10 }, { limit: 20 }]);
    expect(out).toHaveLength(12);
  });

  /*
   * Magazyn należy do CLI, a pakiet jest cudzy i wydawany codziennie. Awaria któregokolwiek
   * ma dać PUSTY ekran z wyjaśnieniem, nigdy 500 — to ta sama reguła, którą miał czytnik
   * magazynu przed przejściem na API.
   */
  it('awaria API to pusta lista, nigdy wyjątek', async () => {
    const read = createSessionListReader({ lister: () => Promise.reject(new Error('padło')) });
    await expect(read({ dir: '/Users/x/Projects/willow' })).resolves.toEqual([]);
  });

  /*
   * A failure of a later, wider fetch with `since` drops the whole answer, the first page too: a prefix cut by count
   * would pass for the full time window, and recent projects would silently lose the older ones.
   */
  it('with `since` a failure of the wider fetch after a good first one gives an empty list', async () => {
    const good = corpusLister(25);
    const lister = vi.fn(async (opts: { limit?: number }) => {
      if (lister.mock.calls.length > 1) throw new Error('EACCES');
      return good(opts);
    });
    const since = INFO.lastModified - 14 * 60_000;
    const out = await createSessionListReader({ lister, fetchCap: 10 })({ since });
    expect(lister.mock.calls.map(([opts]) => opts)).toEqual([{ limit: 10 }, { limit: 20 }]);
    expect(out).toEqual([]);
  });

  it('wpisy nie do użycia wypadają, reszta zostaje', async () => {
    const lister = vi.fn().mockResolvedValue([INFO, { ...INFO, cwd: undefined }, INFO]);
    const out = await createSessionListReader({ lister })({});
    expect(out).toHaveLength(2);
  });
});
