/**
 * Usuwanie kopii hooka przy `rarog service uninstall` w paczce: podmiana katalogu kopii albo jego przodka
 * w trakcie usuwania i błąd `unlink` w połowie.
 *
 * Node nie ma `unlinkat` względem deskryptora katalogu, więc `removeHookCopy` przed KAŻDYM `unlink` i przed `rmdir`
 * sprawdza jeszcze raz ścieżkę rzeczywistą i i-węzeł katalogu z pytania. Okno między sprawdzeniem a `unlink` jest
 * zwężone, nie zamknięte. Atrapa `node:fs` przepuszcza wszystko do prawdziwego modułu i tylko wokół `unlinkSync`
 * woła hak testu: podmianę po n-tym usunięciu albo błąd n-tego wywołania. Każdy test ma dom w katalogu tymczasowym.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOOK_MANIFEST_FILENAME, hookCopyDirState, hookInstallDir, removeHookCopy, type HookCopyDirSeen,
  type HookCopyRemoval,
} from '../src/herdr/hook-config.ts';
import { realRarogDirsCreated, tempHome, type TempHome } from './rarog-home.ts';

/** Hak atrapy: `poUnlink` po n-tym prawdziwym usunięciu, `bladNa` = numer wywołania, które rzuca `EIO`. */
const hak = vi.hoisted(() => ({
  licznik: 0,
  bladNa: 0,
  poUnlink: null as ((n: number) => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    unlinkSync: (path: import('node:fs').PathLike): void => {
      hak.licznik += 1;
      if (hak.licznik === hak.bladNa) throw Object.assign(new Error('EIO: atrapa'), { code: 'EIO' });
      real.unlinkSync(path);
      hak.poUnlink?.(hak.licznik);
    },
  };
});

/** Pliki kopii w {@link kopia}; usuwanie idzie w tej kolejności, manifest na końcu. */
const PLIKI = ['canon.mjs', 'rarog-pending.mjs', 'tall-dialog.mjs'];

let t: TempHome;
let home = '';

beforeEach(() => {
  t = tempHome('rarog-kopia-podmiana-');
  home = join(t.home, 'h');
});

afterEach(() => {
  hak.licznik = 0;
  hak.bladNa = 0;
  hak.poUnlink = null;
  t.cleanup();
});

afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

/** Kopia hooka w domu `home` z manifestem, który wymienia {@link PLIKI} ze skrótami treści. */
function kopia(): string {
  const dir = hookInstallDir(home);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of PLIKI) {
    writeFileSync(join(dir, name), `// ${name}\n`);
    files[name] = createHash('sha256').update(`// ${name}\n`).digest('hex');
  }
  writeFileSync(join(dir, HOOK_MANIFEST_FILENAME), `${JSON.stringify({ version: '1.0.0', at: 1, files })}\n`);
  return dir;
}

/** Stan katalogu kopii z pytania; test bez prawdziwego katalogu kopii nie ma sensu. */
function stan(): HookCopyDirSeen {
  const seen = hookCopyDirState(home);
  if (seen.kind !== 'dir') throw new Error(`katalog kopii nie jest gotowy: ${JSON.stringify(seen)}`);
  return seen;
}

/** `removeHookCopy` z licznikiem atrapy od zera; hak działa tylko w czasie tego wywołania. */
function usun(seen: HookCopyDirSeen): HookCopyRemoval {
  hak.licznik = 0;
  try {
    return removeHookCopy(seen);
  } finally {
    hak.poUnlink = null;
    hak.bladNa = 0;
  }
}

/** Drzewo katalogu: ścieżka względna → treść, `<dir>` albo cel dowiązania (`lstat`, bez wchodzenia w dowiązania). */
function drzewo(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const sciezka = rel === '' ? name : `${rel}/${name}`;
    const info = lstatSync(join(root, sciezka));
    if (info.isSymbolicLink()) out[sciezka] = `-> ${readlinkSync(join(root, sciezka))}`;
    else if (info.isDirectory()) Object.assign(out, { [sciezka]: '<dir>' }, drzewo(root, sciezka));
    else out[sciezka] = readFileSync(join(root, sciezka), 'utf8');
  }
  return out;
}

/** Pliki obce pod nazwami z kopii w katalogu `dir`. */
function obce(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of [...PLIKI.slice(1), HOOK_MANIFEST_FILENAME]) writeFileSync(join(dir, name), `obcy: ${name}\n`);
}

describe('usuwanie kopii hooka: podmiana w trakcie i błąd w połowie', () => {
  it('przodek podmieniony po pierwszym `unlink` (`~/.claude/hooks` → `~/Projects`): stop, projekt nietknięty,'
    + ' wynik mówi, co usunięte, a co nie', () => {
    const dir = kopia();
    const hooks = dirname(dir);
    const projekt = join(home, 'Projects', 'rarog');
    obce(projekt);
    const przed = drzewo(projekt);
    const seen = stan();
    hak.poUnlink = (n) => {
      if (n !== 1) return;
      renameSync(hooks, `${hooks}-stare`);
      symlinkSync(join(home, 'Projects'), hooks);
    };
    const wynik = usun(seen);
    expect(drzewo(projekt)).toEqual(przed);
    expect(wynik).toMatchObject({
      ok: false, why: 'changed', reason: expect.stringContaining('changed during the removal'),
      removed: ['canon.mjs'], notRemoved: ['rarog-pending.mjs', 'tall-dialog.mjs', HOOK_MANIFEST_FILENAME],
    });
    expect(readdirSync(join(`${hooks}-stare`, 'rarog')).sort())
      .toEqual([HOOK_MANIFEST_FILENAME, 'rarog-pending.mjs', 'tall-dialog.mjs']);
  });

  it('katalog kopii zastąpiony innym pod tą samą ścieżką po pierwszym `unlink` (inny i-węzeł): stop, nowy katalog'
    + ' nietknięty', () => {
    const dir = kopia();
    const seen = stan();
    hak.poUnlink = (n) => {
      if (n !== 1) return;
      renameSync(dir, `${dir}-stary`);
      obce(dir);
    };
    const wynik = usun(seen);
    expect(drzewo(dir)).toEqual({
      [HOOK_MANIFEST_FILENAME]: `obcy: ${HOOK_MANIFEST_FILENAME}\n`, 'rarog-pending.mjs': 'obcy: rarog-pending.mjs\n',
      'tall-dialog.mjs': 'obcy: tall-dialog.mjs\n',
    });
    expect(wynik).toMatchObject({
      ok: false, why: 'changed', removed: ['canon.mjs'],
      notRemoved: ['rarog-pending.mjs', 'tall-dialog.mjs', HOOK_MANIFEST_FILENAME],
    });
  });

  it('podmiana tuż przed `rmdir`: pusty katalog pod tą samą ścieżką zostaje, pliki kopii usunięte', () => {
    const dir = kopia();
    const seen = stan();
    hak.poUnlink = (n) => {
      if (n !== PLIKI.length + 1) return;
      renameSync(dir, `${dir}-stary`);
      mkdirSync(dir);
    };
    const wynik = usun(seen);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(wynik).toMatchObject({
      ok: false, why: 'changed', removed: [...PLIKI, HOOK_MANIFEST_FILENAME], notRemoved: [],
    });
  });

  it('błąd usunięcia drugiego pliku: stop, manifest zostaje; drugi przebieg kończy usuwanie', () => {
    const dir = kopia();
    hak.bladNa = 2;
    const pierwszy = usun(stan());
    expect(pierwszy).toMatchObject({
      ok: false, why: 'failed', reason: expect.stringContaining('failed (EIO)'), removed: ['canon.mjs'],
      notRemoved: ['rarog-pending.mjs', 'tall-dialog.mjs', HOOK_MANIFEST_FILENAME],
    });
    expect(readdirSync(dir).sort()).toEqual([HOOK_MANIFEST_FILENAME, 'rarog-pending.mjs', 'tall-dialog.mjs']);
    const drugi = stan();
    expect(drugi).toMatchObject({ remove: [HOOK_MANIFEST_FILENAME, 'rarog-pending.mjs', 'tall-dialog.mjs'], keep: [] });
    expect(usun(drugi)).toEqual({
      ok: true, dirRemoved: true, removed: ['rarog-pending.mjs', 'tall-dialog.mjs', HOOK_MANIFEST_FILENAME], left: [],
    });
    expect(existsSync(dir)).toBe(false);
  });
});
