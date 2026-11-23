/**
 * Tożsamość sesji herdr i lista ukrytych paneli.
 *
 * `sessionIdFor` musi być deterministyczne, bo od tego zależy, czy zakładka
 * `/sessions/<uuid>` otwarta na telefonie przeżyje restart Raroga. Test wektora RFC jest tu
 * po to, żeby „drobna optymalizacja" algorytmu (inne kodowanie nazwy, inne bity wersji) nie
 * przeszła po cichu — zmieniłaby WSZYSTKIE identyfikatory naraz.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHiddenStore, hiddenStorePath, sessionIdFor, uuidV5,
} from '../src/herdr/identity.ts';

let dataDir = '';

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-herdr-id-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('uuidV5', () => {
  it('zgadza się z wektorem referencyjnym RFC 4122 (przestrzeń DNS)', () => {
    const dns = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuidV5('www.example.com', dns)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('odrzuca niepoprawną przestrzeń nazw', () => {
    expect(() => uuidV5('x', 'nie-uuid')).toThrow();
  });
});

describe('sessionIdFor', () => {
  it('ten sam klucz → ten sam identyfikator (przeżywa restart Raroga)', () => {
    expect(sessionIdFor('w9:p72')).toBe(sessionIdFor('w9:p72'));
  });

  it('inny klucz → inny identyfikator', () => {
    expect(sessionIdFor('w9:p72')).not.toBe(sessionIdFor('w9:p1Y'));
  });

  it('wynik jest poprawnym UUID-em wersji 5 z wariantem RFC', () => {
    const id = sessionIdFor('wQ:p2');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('klucz z sufiksem kolizji daje inny identyfikator niż goły `pane_id`', () => {
    expect(sessionIdFor('w9:p72#1')).not.toBe(sessionIdFor('w9:p72'));
  });
});

describe('HiddenStore (aliasy + `seen`)', () => {
  const ENGINE = '44444444-4444-4444-8444-444444444444';

  it('uszkodzony JSON → pusty stan, nie wyjątek', async () => {
    await writeFile(hiddenStorePath(dataDir), '{to nie jest json', 'utf8');
    const store = createHiddenStore({ dataDir });
    expect(store.aliasFor(ENGINE)).toBeUndefined();
    await expect(store.rememberAlias(ENGINE, 'sesja-1')).resolves.toBeUndefined();
    expect(createHiddenStore({ dataDir }).aliasFor(ENGINE)).toBe('sesja-1');
  });

  it('STARY format (goła tablica kluczy) jest ignorowany bez wywrotki', async () => {
    await writeFile(hiddenStorePath(dataDir), '["w9:p72"]', 'utf8');
    const store = createHiddenStore({ dataDir });
    expect(store.aliasFor(ENGINE)).toBeUndefined();
  });

  it('sekcja `hidden` z pliku sprzed dereleasingu jest ignorowana, aliasy przeżywają',
    async () => {
      await writeFile(
        hiddenStorePath(dataDir),
        JSON.stringify({
          hidden: [{ key: 'w9:p72', agentSessionId: ENGINE }],
          aliases: { [ENGINE]: 'sesja-2' },
        }),
        'utf8',
      );
      const store = createHiddenStore({ dataDir });
      expect(store.aliasFor(ENGINE)).toBe('sesja-2');
      // Pierwszy zapis gubi sekcję `hidden` — plik nie ma jej odtwarzać w nieskończoność.
      await store.rememberAlias('55555555-5555-4555-8555-555555555555', 'sesja-3');
      expect(await readFile(hiddenStorePath(dataDir), 'utf8')).not.toContain('w9:p72');
    });

  it('zapis jest atomowy: nie zostawia pliku tymczasowego i ignoruje osierocony', async () => {
    const file = hiddenStorePath(dataDir);
    // Osierocony `.tmp` po zabitym procesie NIE ma prawa być czytany jako źródło prawdy.
    await writeFile(`${file}.tmp`, '["SMIECI"]', 'utf8');
    const store = createHiddenStore({ dataDir });
    await store.rememberAlias(ENGINE, 'sesja-4');

    expect(await readFile(file, 'utf8')).toContain('sesja-4');
    expect(createHiddenStore({ dataDir }).aliasFor(ENGINE)).toBe('sesja-4');
  });
});

/*
 * Nieudany zapis magazynu jest zdarzeniem realnym (ENOSPC, zniknięty `RAROG_DATA_DIR`,
 * zmienione prawa `~/.local/share/rarog`), a `chain` żyje w supervisorze tak długo jak proces.
 * Odrzucona obietnica byłaby więc podwójną karą: ubiłaby serwer (produkcja woła te metody przez
 * `void`, a w procesie nie ma handlera `unhandledRejection`) i trwale zamroziłaby zapisy.
 */
describe('nieudany zapis magazynu nie zatruwa łańcucha', () => {
  const ENGINE = '66666666-6666-4666-8666-666666666666';

  /** `dataDir`, którego nie da się założyć: rodzic jest zwykłym plikiem → ENOTDIR z `mkdir`. */
  const blockedDataDir = async (): Promise<{ dir: string; blocker: string }> => {
    const blocker = join(dataDir, 'blocker');
    await writeFile(blocker, 'to jest PLIK, nie katalog\n', 'utf8');
    return { dir: join(blocker, 'dane'), blocker };
  };

  it('obietnica zapisu jest SPEŁNIONA mimo awarii — `void` w produkcji nie jest bombą', async () => {
    const { dir } = await blockedDataDir();
    const store = createHiddenStore({ dataDir: dir });

    await expect(store.rememberAlias(ENGINE, 'sesja-1')).resolves.toBeUndefined();
    await expect(store.markSeen('w9:p72', ENGINE, 7)).resolves.toBeUndefined();
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it('łańcuch leczy się sam: pierwszy zapis po ustąpieniu awarii dochodzi na dysk', async () => {
    const { dir, blocker } = await blockedDataDir();
    const store = createHiddenStore({ dataDir: dir });
    await store.rememberAlias(ENGINE, 'sesja-1');

    // Awaria ustępuje: przeszkoda znika, więc `mkdir(recursive)` ma się gdzie udać.
    await unlink(blocker);
    await store.markSeen('w9:p72', ENGINE, 7);
    await store.flush();

    // To jest sedno znaleziska: gdyby `chain` został odrzucony, ten zapis zostałby POMINIĘTY,
    // a aliasy i „widziane" żyłyby do końca procesu wyłącznie w RAM.
    const reloaded = createHiddenStore({ dataDir: dir });
    expect(reloaded.aliasFor(ENGINE)).toBe('sesja-1');
    expect(reloaded.seenSeq('w9:p72', ENGINE)).toBe(7);
  });

  it('awaria zostawia po sobie jedną linię w logu, a nie ciszę', async () => {
    const lines: string[] = [];
    const { dir } = await blockedDataDir();
    const store = createHiddenStore({ dataDir: dir, logger: (m) => { lines.push(m); } });
    await store.rememberAlias(ENGINE, 'sesja-1');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('herdr-hidden');
  });

  it('stan w RAM przeżywa awarię zapisu — karta nie wraca do sekcji uwagi od razu', async () => {
    const { dir } = await blockedDataDir();
    const store = createHiddenStore({ dataDir: dir });
    await store.markSeen('w9:p72', ENGINE, 7);

    expect(store.seenSeq('w9:p72', ENGINE)).toBe(7);
  });
});

describe('aliasy engineSessionId → sessionId', () => {
  const ENGINE = '33333333-3333-4333-8333-333333333333';

  it('alias przeżywa restart procesu', async () => {
    const first = createHiddenStore({ dataDir });
    expect(first.aliasFor(ENGINE)).toBeUndefined();
    await first.rememberAlias(ENGINE, 'sesja-raroga-1');

    // To jest cały powód istnienia aliasu: po wznowieniu panel jest NOWY, więc
    // `sessionIdFor(key)` dałby inne id — a deep-link z telefonu ma dalej działać.
    expect(createHiddenStore({ dataDir }).aliasFor(ENGINE)).toBe('sesja-raroga-1');
  });

  it('LRU tnie listę do 200 wpisów, zachowując najnowsze', async () => {
    const store = createHiddenStore({ dataDir });
    for (let i = 0; i < 205; i += 1) {
      await store.rememberAlias(`engine-${String(i)}`, `sesja-${String(i)}`);
    }
    expect(store.aliasFor('engine-0')).toBeUndefined();
    expect(store.aliasFor('engine-204')).toBe('sesja-204');
  });

  it('aliasy i `seen` żyją w JEDNYM pliku i nie kasują się nawzajem', async () => {
    const store = createHiddenStore({ dataDir });
    await store.markSeen('w9:p72', '11111111-1111-4111-8111-111111111111', 7);
    await store.rememberAlias(ENGINE, 'sesja-raroga-2');

    const reloaded = createHiddenStore({ dataDir });
    expect(reloaded.seenSeq('w9:p72', '11111111-1111-4111-8111-111111111111')).toBe(7);
    expect(reloaded.aliasFor(ENGINE)).toBe('sesja-raroga-2');
  });
});

describe('znacznik „widziane z telefonu"', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';

  it('przeżywa restart Raroga — po deployu karta nie wraca do sekcji uwagi', async () => {
    const first = createHiddenStore({ dataDir });
    expect(first.seenSeq('w9:p72', UUID_A)).toBeUndefined();
    await first.markSeen('w9:p72', UUID_A, 57);

    expect(createHiddenStore({ dataDir }).seenSeq('w9:p72', UUID_A)).toBe(57);
  });

  it('liczy się TYLKO przy zgodnym uuidzie sesji silnika', async () => {
    const store = createHiddenStore({ dataDir });
    await store.markSeen('w9:p72', UUID_A, 57);
    // Po restarcie serwera herdr adresy paneli startują od nowa: pod tym adresem może dziś
    // stać cudza sesja, a jej świeży wynik nie ma prawa zniknąć z sekcji uwagi.
    expect(store.seenSeq('w9:p72', UUID_B)).toBeUndefined();
  });

  it('nowszy znacznik przesuwa numer, starszy go NIE cofa', async () => {
    const store = createHiddenStore({ dataDir });
    await store.markSeen('w9:p72', UUID_A, 57);
    await store.markSeen('w9:p72', UUID_A, 12);
    expect(store.seenSeq('w9:p72', UUID_A)).toBe(57);
    await store.markSeen('w9:p72', UUID_A, 90);
    expect(store.seenSeq('w9:p72', UUID_A)).toBe(90);
  });

  it('znacznik i aliasy żyją w jednym pliku i się nie kasują', async () => {
    const store = createHiddenStore({ dataDir });
    await store.rememberAlias('engine-x', 'sesja-x');
    await store.markSeen('w9:p72', UUID_A, 5);

    const reloaded = createHiddenStore({ dataDir });
    expect(reloaded.aliasFor('engine-x')).toBe('sesja-x');
    expect(reloaded.seenSeq('w9:p72', UUID_A)).toBe(5);
  });

  it('LRU tnie znaczniki do 200, zachowując najnowsze', async () => {
    const store = createHiddenStore({ dataDir });
    for (let i = 0; i < 205; i += 1) {
      await store.markSeen(`w9:p${String(i)}`, UUID_A, i);
    }
    expect(store.seenSeq('w9:p0', UUID_A)).toBeUndefined();
    expect(store.seenSeq('w9:p204', UUID_A)).toBe(204);
  });

  it('wpis-śmieć (numer nie-liczba) jest odrzucany, a reszta pliku żyje', async () => {
    await writeFile(
      hiddenStorePath(dataDir),
      JSON.stringify({
        hidden: [{ key: 'wA:p2T', agentSessionId: UUID_B }],
        seen: [
          { key: 'w9:p72', agentSessionId: UUID_A, stateChangeSeq: 'dużo' },
          { key: 'wB:p3', agentSessionId: UUID_A, stateChangeSeq: 4 },
        ],
      }),
      'utf8',
    );
    const store = createHiddenStore({ dataDir });
    expect(store.seenSeq('w9:p72', UUID_A)).toBeUndefined();
    expect(store.seenSeq('wB:p3', UUID_A)).toBe(4);
  });
});

describe('ręczne „nieprzeczytane"', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';

  it('wpis „nieprzeczytane" i „obejrzane" wykluczają się — ostatnia decyzja wygrywa', async () => {
    const store = createHiddenStore({ dataDir });
    await store.markSeen('w9:p72', UUID_A, 57);
    await store.markUnseen('w9:p72', UUID_A, 57);
    expect(store.seenSeq('w9:p72', UUID_A)).toBeUndefined();
    expect(store.unseenSeq('w9:p72', UUID_A)).toBe(57);

    // Odbiór przy RÓWNYM numerze nadpisuje „nieprzeczytane" (dzisiejsza bramka „tylko wyższy" by go zgubiła).
    await store.markSeen('w9:p72', UUID_A, 57);
    expect(store.seenSeq('w9:p72', UUID_A)).toBe(57);
    expect(store.unseenSeq('w9:p72', UUID_A)).toBeUndefined();
  });

  it('odbiór przy NIŻSZYM numerze też nadpisuje „nieprzeczytane" (licznik herdr po restarcie jego serwera)', async () => {
    const store = createHiddenStore({ dataDir });
    await store.markUnseen('w9:p72', UUID_A, 57);
    await store.markSeen('w9:p72', UUID_A, 2);
    expect(store.seenSeq('w9:p72', UUID_A)).toBe(2);
    expect(store.unseenSeq('w9:p72', UUID_A)).toBeUndefined();
    // Zwykły wpis „obejrzane" dalej przyjmuje tylko numer wyższy.
    await store.markSeen('w9:p72', UUID_A, 1);
    expect(store.seenSeq('w9:p72', UUID_A)).toBe(2);
  });

  it('liczy się tylko przy zgodnym uuidzie i przeżywa restart Raroga', async () => {
    const first = createHiddenStore({ dataDir });
    await first.markUnseen('w9:p72', UUID_A, 12);
    expect(first.unseenSeq('w9:p72', UUID_B)).toBeUndefined();

    const reloaded = createHiddenStore({ dataDir });
    expect(reloaded.unseenSeq('w9:p72', UUID_A)).toBe(12);
    expect(reloaded.seenSeq('w9:p72', UUID_A)).toBeUndefined();
  });

  it('plik bez pola `unseen` i z polem nie-`true` wczytuje się jako „obejrzane"', async () => {
    await writeFile(
      hiddenStorePath(dataDir),
      JSON.stringify({
        seen: [
          { key: 'w9:p72', agentSessionId: UUID_A, stateChangeSeq: 4 },
          { key: 'wB:p3', agentSessionId: UUID_A, stateChangeSeq: 5, unseen: 'tak' },
        ],
      }),
      'utf8',
    );
    const store = createHiddenStore({ dataDir });
    expect(store.seenSeq('w9:p72', UUID_A)).toBe(4);
    expect(store.seenSeq('wB:p3', UUID_A)).toBe(5);
    expect(store.unseenSeq('wB:p3', UUID_A)).toBeUndefined();
  });
});

describe('who received the result (`by`)', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const file = (): string => hiddenStorePath(dataDir);
  const entries = async (): Promise<Record<string, unknown>[]> =>
    (JSON.parse(await readFile(file(), 'utf8')) as { seen: Record<string, unknown>[] }).seen;

  it('the voice agent\'s receipt keeps `by` across a reload; the entry keeps the fields an older reader takes', async () => {
    const store = createHiddenStore({ dataDir });
    await store.markSeen('w9:p72', UUID_A, 12, 'voice-agent');
    expect(store.seenBy('w9:p72', UUID_A)).toBe('voice-agent');
    // An older Rarog copies `key`, `agentSessionId` and `stateChangeSeq` and skips the rest: a receipt for it too.
    expect(await entries()).toEqual([
      { key: 'w9:p72', agentSessionId: UUID_A, stateChangeSeq: 12, by: 'voice-agent' },
    ]);
    const reloaded = createHiddenStore({ dataDir });
    expect(reloaded.seenSeq('w9:p72', UUID_A)).toBe(12);
    expect(reloaded.seenBy('w9:p72', UUID_A)).toBe('voice-agent');
  });

  it('a human receipt at the same number drops `by`, also on disk; a higher number moves it', async () => {
    const store = createHiddenStore({ dataDir });
    await store.markSeen('w9:p72', UUID_A, 12, 'voice-agent');
    await store.markSeen('w9:p72', UUID_A, 13, 'voice-agent');
    expect(await entries()).toEqual([
      { key: 'w9:p72', agentSessionId: UUID_A, stateChangeSeq: 13, by: 'voice-agent' },
    ]);
    await store.markSeen('w9:p72', UUID_A, 13);
    expect(store.seenBy('w9:p72', UUID_A)).toBeUndefined();
    expect(store.seenSeq('w9:p72', UUID_A)).toBe(13);
    expect(await entries()).toEqual([{ key: 'w9:p72', agentSessionId: UUID_A, stateChangeSeq: 13 }]);
  });

  it('"unread" at the same number drops `by`; another engine session has none', async () => {
    const store = createHiddenStore({ dataDir });
    await store.markSeen('w9:p72', UUID_A, 12, 'voice-agent');
    expect(store.seenBy('w9:p72', '22222222-2222-4222-8222-222222222222')).toBeUndefined();
    await store.markUnseen('w9:p72', UUID_A, 12);
    expect(store.seenBy('w9:p72', UUID_A)).toBeUndefined();
    expect(await entries()).toEqual([{ key: 'w9:p72', agentSessionId: UUID_A, stateChangeSeq: 12, unseen: true }]);
  });

  it('a file of an older Rarog loads as before; an unknown `by` reads as a human receipt', async () => {
    await writeFile(
      file(),
      JSON.stringify({
        seen: [
          { key: 'w9:p72', agentSessionId: UUID_A, stateChangeSeq: 4 },
          { key: 'wB:p3', agentSessionId: UUID_A, stateChangeSeq: 5, by: 'robot' },
          { key: 'wC:p4', agentSessionId: UUID_A, stateChangeSeq: 6, unseen: true, by: 'voice-agent' },
        ],
      }),
      'utf8',
    );
    const store = createHiddenStore({ dataDir });
    expect(store.seenSeq('w9:p72', UUID_A)).toBe(4);
    expect(store.seenBy('w9:p72', UUID_A)).toBeUndefined();
    expect(store.seenSeq('wB:p3', UUID_A)).toBe(5);
    expect(store.seenBy('wB:p3', UUID_A)).toBeUndefined();
    expect(store.unseenSeq('wC:p4', UUID_A)).toBe(6);
    expect(store.seenBy('wC:p4', UUID_A)).toBeUndefined();
  });
});
