/**
 * Testy przeglądarki katalogów (`fs-browse.ts`) na prawdziwym tmp-fixture.
 *
 * Rdzeń to granica bezpieczeństwa: `..`, symlink, katalog ukryty i ścieżka spoza korzeni MUSZĄ
 * odpaść, zanim ktokolwiek zobaczy listing. Reszta (sort, znaczniki, truncation, EACCES) to
 * kontrakt UI: pole ścieżki + lista wierszy w formularzu nowej sesji.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MAX_DIR_ENTRIES } from '@rarog/shared';
import { PATH_NOT_ALLOWED, browseDirectory, demoListing } from '../src/fs-browse.ts';
import type { BrowseResult } from '../src/fs-browse.ts';
import { projectSlug } from '../src/cli-store.ts';

/** Wyciąga listing albo wywala test z czytelną diagnostyką (zamiast `!` w każdej asercji). */
function listing(result: BrowseResult): Extract<BrowseResult, { ok: true }>['listing'] {
  if (!result.ok) throw new Error(`spodziewano listingu, jest ${result.error}: ${result.sentence.text}`);
  return result.listing;
}

describe('browseDirectory', () => {
  let base: string;
  let root: string;
  let store: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'rarog-fs-'));
    root = join(base, 'Projects');
    store = join(base, 'store');
    await mkdir(join(root, 'willow', '.git'), { recursive: true });
    await mkdir(join(root, 'willow', 'src'), { recursive: true });
    await mkdir(join(root, 'willow', 'node_modules'), { recursive: true });
    await mkdir(join(root, 'willow', '.cache'), { recursive: true });
    await mkdir(join(root, 'Ćwiczenia'), { recursive: true });
    await mkdir(join(root, 'atlas'), { recursive: true });
    await writeFile(join(root, 'plik.txt'), 'x', 'utf8');
    await mkdir(join(store, projectSlug(join(root, 'willow'))), { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const browse = (path: string | null, roots: readonly string[] = [root]): Promise<BrowseResult> =>
    browseDirectory(path, { roots, storeRoot: store, home: base });

  it('bez ścieżki oddaje poziom korzeni (path i parent = null)', async () => {
    const result = listing(await browse(null));
    expect(result.path).toBeNull();
    expect(result.parent).toBeNull();
    expect(result.entries.map((e) => e.path)).toEqual([root]);
    expect(result.entries[0]?.name).toBe('Projects');
  });

  it('pusta ścieżka jest tym samym co jej brak', async () => {
    expect(listing(await browse('  ')).path).toBeNull();
  });

  it('`canCreate` given by the route: on a directory listing as given, never on the roots level', async () => {
    const opts = { roots: [root], storeRoot: store, home: base };
    for (const canCreate of [true, false]) {
      expect(listing(await browseDirectory(join(root, 'willow'), { ...opts, canCreate })).canCreate).toBe(canCreate);
      expect(listing(await browseDirectory(null, { ...opts, canCreate }))).not.toHaveProperty('canCreate');
    }
    expect(listing(await browseDirectory(join(root, 'willow'), opts))).not.toHaveProperty('canCreate');
  });

  describe('kolizja nazw korzeni (zgłoszenie: dwa razy „Projects" w dropdownie)', () => {
    it('kolidujące korzenie dostają segment rodzica, reszta zostaje przy basename', async () => {
      const drugi = join(base, 'Documents', 'Projects');
      const inny = join(base, 'Kod');
      await mkdir(drugi, { recursive: true });
      await mkdir(inny, { recursive: true });

      const result = listing(await browse(null, [root, drugi, inny]));
      expect(result.entries.map((e) => e.name)).toEqual([
        `${basename(base)}/Projects`, 'Documents/Projects', 'Kod',
      ]);
      // Ścieżki są nietknięte — ujednoznacznienie dotyczy WYŁĄCZNIE etykiety.
      expect(result.entries.map((e) => e.path)).toEqual([root, drugi, inny]);
    });

    it('gdy dwa segmenty nadal kolidują, etykietą zostaje pełna ścieżka', async () => {
      const a = join(base, 'x', 'wspolny', 'Projects');
      const b = join(base, 'y', 'wspolny', 'Projects');
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });

      const result = listing(await browse(null, [a, b]));
      expect(result.entries.map((e) => e.name)).toEqual([a, b]);
    });

    it('podkatalogi ujednoznacznienia NIE dostają — w jednym katalogu nazwy są unikalne',
      async () => {
        // `willow` leży w korzeniu o basename „Projects" i mimo to zostaje samym „willow".
        const drugi = join(base, 'Documents', 'Projects');
        await mkdir(drugi, { recursive: true });
        const result = listing(await browse(root, [root, drugi]));
        expect(result.entries.map((e) => e.name)).toEqual(['atlas', 'Ćwiczenia', 'willow']);
      });
  });

  it('listuje wyłącznie katalogi, bez ukrytych i bez node_modules, po polsku posortowane',
    async () => {
      const result = listing(await browse(root));
      expect(result.entries.map((e) => e.name)).toEqual(['atlas', 'Ćwiczenia', 'willow']);
      expect(result.path).toBe(root);
      // Korzeń → `parent: null` (cofnięcie wraca na poziom korzeni, a nie nad korzeń).
      expect(result.parent).toBeNull();
      expect(result.truncated).toBe(false);
    });

  it('znaczniki: `.git` daje git, katalog w magazynie CLI daje historię', async () => {
    const entries = listing(await browse(root)).entries;
    const willow = entries.find((e) => e.name === 'willow');
    expect(willow).toMatchObject({ git: true, history: true });
    expect(entries.find((e) => e.name === 'atlas')).toMatchObject({ git: false, history: false });
  });

  it('katalog głębiej ma rodzica, a jego podkatalogi są bez ukrytych', async () => {
    const result = listing(await browse(join(root, 'willow')));
    expect(result.parent).toBe(root);
    expect(result.entries.map((e) => e.name)).toEqual(['src']);
  });

  it('`..` po normalizacji nie wychodzi poza korzeń', async () => {
    const result = await browse(join(root, 'willow', '..', '..'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toBe('path-not-allowed');
  });

  it('ścieżka spoza korzeni odpada z 400', async () => {
    const result = await browse('/etc');
    expect(result).toMatchObject({ ok: false, status: 400, error: 'path-not-allowed' });
  });

  it('ścieżka względna odpada z 400 (nie rozwija się do katalogu serwera)', async () => {
    expect(await browse('willow')).toMatchObject({ ok: false, status: 400 });
    expect(await browse('.')).toMatchObject({ ok: false, status: 400 });
  });

  it('segment ukryty odpada z 400, nawet wewnątrz korzenia', async () => {
    const result = await browse(join(root, 'willow', '.git'));
    expect(result).toMatchObject({ ok: false, status: 400, error: 'path-not-allowed' });
  });

  it('pusta lista korzeni nie przepuszcza niczego (fail-closed)', async () => {
    expect(await browse(root, [])).toMatchObject({ ok: false, status: 400 });
  });

  it('tylda rozwija się do katalogu domowego i podlega tym samym regułom', async () => {
    // `home` fixture'a to `base`, więc `~/Projects` == korzeń.
    expect(listing(await browse('~/Projects')).path).toBe(root);
    expect(await browse('~/gdzieindziej')).toMatchObject({ ok: false, status: 400 });
  });

  it('nieistniejący katalog wewnątrz korzenia to 404', async () => {
    const result = await browse(join(root, 'nie-ma'));
    expect(result).toMatchObject({ ok: false, status: 404, error: 'not-found' });
  });

  it('plik (nie katalog) też jest 404', async () => {
    expect(await browse(join(root, 'plik.txt'))).toMatchObject({ ok: false, status: 404 });
  });

  it('symlink do katalogu NIE jest pokazywany (nie rozwijamy dowiązań)', async () => {
    await symlink('/', join(root, 'skrót-do-korzenia'));
    const names = listing(await browse(root)).entries.map((e) => e.name);
    expect(names).not.toContain('skrót-do-korzenia');
  });

  /*
   * The `isDirectory()` filter guards the ROWS of a listing, not the `?path=` parameter: `stat` follows a symlink, so
   * a string comparison would let `GET /api/fs?path=<root>/link` list a directory outside the roots.
   */
  it('wejście W dowiązanie prowadzące poza korzenie jest odmową, nie listingiem', async () => {
    const poza = join(base, 'poza-korzeniem');
    await mkdir(join(poza, 'sekrety'), { recursive: true });
    const link = join(root, 'skrót-na-zewnątrz');
    await symlink(poza, link);

    const result = await browse(link);
    expect(result).toMatchObject({ ok: false, status: 400, error: PATH_NOT_ALLOWED });
    expect(result.ok === false && result.sentence.ref.code).toBe('rest.cwd-symlink-escape');
  });

  it('dowiązanie prowadzące W GRANICE korzeni nadal się otwiera', async () => {
    const link = join(root, 'skrót-do-środka');
    await symlink(join(root, 'willow'), link);
    expect(listing(await browse(link)).entries.map((e) => e.name)).toContain('src');
  });

  it('ponad limit wpisów → ucięte i truncated', async () => {
    const dir = join(root, 'dużo');
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 12 }, (_, i) => mkdir(join(dir, `d${String(i)}`))));
    const result = listing(await browseDirectory(dir, {
      roots: [root], storeRoot: store, home: base, maxEntries: 5,
    }));
    expect(result.entries).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('domyślny limit wpisów pochodzi z kontraktu', async () => {
    // Kontrakt (`dirListingSchema`) nie przepuści listy dłuższej niż `MAX_DIR_ENTRIES`.
    expect(listing(await browse(root)).entries.length).toBeLessThanOrEqual(MAX_DIR_ENTRIES);
  });

  it('brak uprawnień do katalogu daje pustą listę, a nie błąd', async () => {
    const locked = join(root, 'zamknięty');
    await mkdir(locked, { recursive: true });
    await mkdir(join(locked, 'środek'), { recursive: true });
    await chmod(locked, 0o000);
    try {
      const result = listing(await browse(locked));
      expect(result.entries).toEqual([]);
      expect(result.parent).toBe(root);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('wiele korzeni: listuje oba i przepuszcza wnętrze każdego', async () => {
    const second = join(base, 'Praca');
    await mkdir(join(second, 'raporty'), { recursive: true });
    const roots = [root, second];
    expect(listing(await browse(null, roots)).entries.map((e) => e.name))
      .toEqual(['Projects', 'Praca']);
    expect(listing(await browse(second, roots)).entries.map((e) => e.name)).toEqual(['raporty']);
  });
});

describe('demoListing — tryb demo nie dotyka dysku', () => {
  const projects = [
    { path: '/Users/demo/Projects/willow', name: 'willow' },
    { path: '/Users/demo/Projects/rarog', name: 'rarog' },
  ];

  it('bez ścieżki oddaje projekty demo jako korzenie', () => {
    const result = listing(demoListing(null, projects));
    expect(result.path).toBeNull();
    expect(result.entries.map((e) => e.name)).toEqual(['willow', 'rarog']);
  });

  it('projekt demo listuje się jako pusty katalog (można w nim założyć sesję)', () => {
    const result = listing(demoListing('/Users/demo/Projects/willow', projects));
    expect(result).toMatchObject({
      path: '/Users/demo/Projects/willow', parent: null, entries: [], truncated: false,
    });
  });

  it('the demo creates no directories: `canCreate: false` on a project, no field on the roots level', () => {
    expect(listing(demoListing('/Users/demo/Projects/willow', projects)).canCreate).toBe(false);
    expect(listing(demoListing(null, projects))).not.toHaveProperty('canCreate');
  });

  it('ścieżka spoza listy projektów demo odpada z 400', () => {
    expect(demoListing('/etc', projects)).toMatchObject({ ok: false, status: 400 });
  });
});
