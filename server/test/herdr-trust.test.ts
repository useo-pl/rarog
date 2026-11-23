/**
 * Predykat zaufania katalogu — jedno pole z `~/.claude.json`, zero wycieków.
 *
 * Dwa powody, dla których ten plik jest tak nieufny wobec własnego modułu:
 *
 * 1. Bez tej flagi pierwszy `claude` w nowym katalogu wchodzi w `blocked` z dialogiem zaufania
 *    i stoi tam bez końca. Dlatego każda niepewność ma dawać `false` (Rarog ostrzega w transkrypcie),
 *    a nie wyjątek i nie „chyba tak".
 * 2. `~/.claude.json` ma ~210 kB i niesie m.in. `mcpServers` z kluczami. Moduł ma zwracać
 *    boolean i nic więcej — także w logach, także w komunikacie wyjątku z `JSON.parse`,
 *    który potrafi zacytować fragment pliku.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRUST_CACHE_MS, createTrustCheck, defaultClaudeJsonPath } from '../src/herdr/trust.ts';
import type { TrustCheck, TrustCheckOptions } from '../src/herdr/trust.ts';

const TRUSTED = '/Users/u/Projects/atlas';
const UNTRUSTED = '/Users/u/Projects/birch';
const SECRET = 'sk-ant-tajny-klucz-z-mcpServers';

let dir = '';
let file = '';

/** Ile razy moduł REALNIE przeczytał plik — licznik owija prawdziwy odczyt. */
let reads = 0;
let clock = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rarog-trust-'));
  file = join(dir, '.claude.json');
  reads = 0;
  clock = 1_000_000;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(content: string): Promise<void> {
  await writeFile(file, content, 'utf8');
}

async function writeProjects(projects: Record<string, unknown>): Promise<void> {
  await write(JSON.stringify({
    numStartups: 42,
    mcpServers: { tajny: { env: { API_KEY: SECRET } } },
    projects,
  }));
}

interface Made {
  isTrusted(cwd: string): Promise<boolean>;
  logs: string[];
}

function make(cacheMs: number = TRUST_CACHE_MS): Made {
  const logs: string[] = [];
  const check = createTrustCheck({
    claudeJsonPath: file,
    cacheMs,
    now: (): number => clock,
    logger: (message: string): void => {
      logs.push(message);
    },
    readFile: async (f: string): Promise<string> => {
      reads += 1;
      return readFile(f, 'utf8');
    },
  });
  return { isTrusted: (cwd: string): Promise<boolean> => check.isTrusted(cwd), logs };
}

describe('defaultClaudeJsonPath', () => {
  it('wskazuje `~/.claude.json`', () => {
    expect(defaultClaudeJsonPath('/Users/u')).toBe('/Users/u/.claude.json');
  });
});

describe('isTrusted — odczyt jednego pola', () => {
  it('wpis z `hasTrustDialogAccepted: true` → true', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true, allowedTools: [] } });
    await expect(make().isTrusted(TRUSTED)).resolves.toBe(true);
  });

  it('wpis z `false` → false', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: false } });
    await expect(make().isTrusted(TRUSTED)).resolves.toBe(false);
  });

  it('wpis bez tego pola → false', async () => {
    await writeProjects({ [TRUSTED]: { allowedTools: ['Bash'] } });
    await expect(make().isTrusted(TRUSTED)).resolves.toBe(false);
  });

  it('brak wpisu o katalogu → false', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    await expect(make().isTrusted(UNTRUSTED)).resolves.toBe(false);
  });

  it('wartość „prawdziwa", ale nie `true` (np. `1`) → false', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: 1 } });
    await expect(make().isTrusted(TRUSTED)).resolves.toBe(false);
  });

  it('normalizuje ścieżkę zapytania (`/a/b/../b` to `/a/b`)', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    await expect(make().isTrusted(`${TRUSTED}/podkatalog/..`)).resolves.toBe(true);
  });

  it('dziedziczy zaufanie po katalogu nadrzędnym, jak `claude` (CLI 2.1.299)', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    await expect(make().isTrusted(`${TRUSTED}/pakiet/zrodla`)).resolves.toBe(true);
  });

  it('wpis `false` katalogu pośredniego nie zatrzymuje dziedziczenia', async () => {
    // CLI samo zapisuje `false` katalogowi, który wystartował bez dialogu dzięki rodzicowi (pomiar na 2.1.299)
    // (`~/Projects` = true, `~/Projects/ACME` = false, `~/Projects/ACME/rarog`).
    await writeProjects({
      [TRUSTED]: { hasTrustDialogAccepted: true },
      [`${TRUSTED}/pakiet`]: { hasTrustDialogAccepted: false },
    });
    await expect(make().isTrusted(`${TRUSTED}/pakiet/zrodla`)).resolves.toBe(true);
  });

  it('wpis `false` samego katalogu przy zaufanym rodzicu → true', async () => {
    await writeProjects({
      [TRUSTED]: { hasTrustDialogAccepted: true },
      [`${TRUSTED}/pakiet`]: { hasTrustDialogAccepted: false },
    });
    await expect(make().isTrusted(`${TRUSTED}/pakiet`)).resolves.toBe(true);
  });

  it('ukośnik na końcu klucza i zapytania nie psuje dziedziczenia', async () => {
    await writeProjects({ [`${TRUSTED}/`]: { hasTrustDialogAccepted: true } });
    await expect(make().isTrusted(`${TRUSTED}/pakiet/`)).resolves.toBe(true);
  });

  it('wspólny początek nazwy to nie rodzic (`atlas` nie obejmuje `alfabet`)', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    await expect(make().isTrusted(`${TRUSTED}bet`)).resolves.toBe(false);
  });

  it('zaufany podkatalog nie czyni zaufanym rodzica', async () => {
    await writeProjects({ [`${TRUSTED}/pakiet`]: { hasTrustDialogAccepted: true } });
    await expect(make().isTrusted(TRUSTED)).resolves.toBe(false);
  });

  it('brak pliku → false, bez wyjątku', async () => {
    await expect(make().isTrusted(TRUSTED)).resolves.toBe(false);
  });

  it('uszkodzony JSON → false, bez wyjątku', async () => {
    await write('{"projects": {"/a": {"hasTrustDialogAccepted": true}}, ');
    await expect(make().isTrusted('/a')).resolves.toBe(false);
  });

  it('`projects` innego kształtu → false', async () => {
    await write('{"projects": ["/a"]}');
    await expect(make().isTrusted('/a')).resolves.toBe(false);
  });
});

describe('cache', () => {
  it('dwa wywołania w tej samej sekundzie = jeden odczyt pliku', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    const trust = make();
    await trust.isTrusted(TRUSTED);
    await trust.isTrusted(UNTRUSTED);
    expect(reads).toBe(1);
  });

  it('równoległe wywołania też dają jeden odczyt', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    const trust = make();
    const [a, b] = await Promise.all([trust.isTrusted(TRUSTED), trust.isTrusted(TRUSTED)]);
    expect([a, b]).toEqual([true, true]);
    expect(reads).toBe(1);
  });

  it('po wygaśnięciu okna, ale bez zmiany pliku, NIE czyta drugi raz', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    const trust = make();
    await trust.isTrusted(TRUSTED);
    clock += TRUST_CACHE_MS + 1;
    await expect(trust.isTrusted(TRUSTED)).resolves.toBe(true);
    expect(reads).toBe(1);
  });

  it('zmiana pliku unieważnia cache i zmienia odpowiedź', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: false } });
    const trust = make();
    await expect(trust.isTrusted(TRUSTED)).resolves.toBe(false);

    clock += TRUST_CACHE_MS + 1;
    await writeProjects({
      [TRUSTED]: { hasTrustDialogAccepted: true },
      [UNTRUSTED]: { hasTrustDialogAccepted: false },
    });
    await expect(trust.isTrusted(TRUSTED)).resolves.toBe(true);
    expect(reads).toBe(2);
  });

  it('w oknie cache nie widzi zmiany pliku (świadomy koszt gorącego pliku)', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: false } });
    const trust = make();
    await trust.isTrusted(TRUSTED);
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    await expect(trust.isTrusted(TRUSTED)).resolves.toBe(false);
    expect(reads).toBe(1);
  });
});

describe('prywatność', () => {
  it('ścieżka sukcesu nie loguje NICZEGO', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    const trust = make();
    await trust.isTrusted(TRUSTED);
    expect(trust.logs).toEqual([]);
  });

  it('log błędu nie zawiera treści pliku ani komunikatu wyjątku', async () => {
    // `JSON.parse` cytuje fragment wejścia w komunikacie („Unexpected token … in JSON at
    // position N"), a wejściem jest plik z kluczami `mcpServers`.
    await write(`{"mcpServers": {"x": {"env": {"API_KEY": "${SECRET}"}}}, "projects": `);
    const trust = make();
    await expect(trust.isTrusted(TRUSTED)).resolves.toBe(false);

    expect(trust.logs).toHaveLength(1);
    const line = trust.logs[0] ?? '';
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('mcpServers');
    expect(line).not.toContain('JSON');
    expect(line).not.toContain('position');
    expect(line).toContain('.claude.json');
  });

  it('log braku pliku nie zawiera ścieżki tymczasowej ani treści błędu systemowego', async () => {
    const trust = make();
    await trust.isTrusted(TRUSTED);
    const line = trust.logs[0] ?? '';
    expect(line).not.toContain('ENOENT');
    expect(line).not.toContain(dir);
  });

  it('zwraca wyłącznie boolean', async () => {
    await writeProjects({ [TRUSTED]: { hasTrustDialogAccepted: true } });
    const value: unknown = await make().isTrusted(TRUSTED);
    expect(typeof value).toBe('boolean');
  });
});

/*
 * Granica repozytorium: wiersze karty zmierzone na CLI 2.1.319. Katalogi są prawdziwe
 * (`.git` jako katalog albo plik), bo moduł szuka repo na dysku; klucze `projects` to ich ścieżki.
 */
describe('isTrusted — granica repozytorium', () => {
  let tree = '';
  let home = '';

  beforeEach(async () => {
    tree = await mkdtemp(join(tmpdir(), 'rarog-trust-tree-'));
    home = join(tree, 'dom');
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(tree, { recursive: true, force: true });
  });

  async function repo(dir: string): Promise<string> {
    await mkdir(join(dir, '.git'), { recursive: true });
    return dir;
  }

  function check(extra: Partial<TrustCheckOptions> = {}): TrustCheck {
    return createTrustCheck({ claudeJsonPath: file, home, now: (): number => clock, ...extra });
  }

  it('katalog bez `.git` pod rodzicem z `true` → zaufany', async () => {
    const parent = join(tree, 'projekty');
    await mkdir(join(parent, 'nowy'), { recursive: true });
    await writeProjects({ [parent]: { hasTrustDialogAccepted: true } });
    await expect(check().isTrusted(join(parent, 'nowy'))).resolves.toBe(true);
  });

  it('katalog z własnym `.git` pod rodzicem z `true`, bez własnego wpisu → NIEzaufany', async () => {
    const parent = join(tree, 'projekty');
    const clone = await repo(join(parent, 'klon'));
    await writeProjects({ [parent]: { hasTrustDialogAccepted: true } });
    await expect(check().isTrusted(clone)).resolves.toBe(false);
  });

  it('ten sam katalog z `.git` i własnym `true` → zaufany', async () => {
    const parent = join(tree, 'projekty');
    const clone = await repo(join(parent, 'klon'));
    await writeProjects({
      [parent]: { hasTrustDialogAccepted: true },
      [clone]: { hasTrustDialogAccepted: true },
    });
    await expect(check().isTrusted(clone)).resolves.toBe(true);
  });

  it('podkatalog repo, korzeń repo z `true` → zaufany', async () => {
    const root = await repo(join(tree, 'repo'));
    await mkdir(join(root, 'pakiet', 'zrodla'), { recursive: true });
    await writeProjects({ [root]: { hasTrustDialogAccepted: true } });
    await expect(check().isTrusted(join(root, 'pakiet', 'zrodla'))).resolves.toBe(true);
  });

  it('podkatalog repo, `true` tylko u rodzica repo → NIEzaufany', async () => {
    const parent = join(tree, 'projekty');
    const root = await repo(join(parent, 'repo'));
    await mkdir(join(root, 'pakiet'), { recursive: true });
    await writeProjects({ [parent]: { hasTrustDialogAccepted: true } });
    await expect(check().isTrusted(join(root, 'pakiet'))).resolves.toBe(false);
  });

  it('podkatalog repo z własnym `true`, bez wpisu korzenia → NIEzaufany (kluczem jest korzeń repo)', async () => {
    const root = await repo(join(tree, 'repo'));
    await mkdir(join(root, 'pakiet'), { recursive: true });
    await writeProjects({ [join(root, 'pakiet')]: { hasTrustDialogAccepted: true } });
    await expect(check().isTrusted(join(root, 'pakiet'))).resolves.toBe(false);
  });

  it('repo zagnieżdżone w zaufanym repo (klon w środku) → NIEzaufany bez własnego wpisu', async () => {
    const outer = await repo(join(tree, 'zewnetrzne'));
    const inner = await repo(join(outer, 'vendor', 'wewnetrzne'));
    await writeProjects({ [outer]: { hasTrustDialogAccepted: true } });
    await expect(check().isTrusted(inner)).resolves.toBe(false);
  });

  it('submoduł (`.git` jako plik z `gitdir` w `.git/modules`) zaufanego repo → NIEzaufany bez własnego wpisu',
    async () => {
      const outer = await repo(join(tree, 'zewnetrzne'));
      const sub = join(outer, 'lib', 'sub');
      await mkdir(sub, { recursive: true });
      await mkdir(join(outer, '.git', 'modules', 'sub'), { recursive: true });
      await writeFile(join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n', 'utf8');
      await writeProjects({ [outer]: { hasTrustDialogAccepted: true } });
      await expect(check().isTrusted(sub)).resolves.toBe(false);
    });

  it('submoduł z własnym `true` → zaufany (kluczem jest katalog submodułu)', async () => {
    const outer = await repo(join(tree, 'zewnetrzne'));
    const sub = join(outer, 'lib', 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n', 'utf8');
    await writeProjects({ [sub]: { hasTrustDialogAccepted: true } });
    await expect(check().isTrusted(sub)).resolves.toBe(true);
  });

  it('worktree (`.git` jako plik, `gitdir` w `<repo>/.git/worktrees/…`), główny checkout z `true` → zaufany',
    async () => {
      const main = await repo(join(tree, 'repo'));
      await mkdir(join(main, '.git', 'worktrees', 'galaz'), { recursive: true });
      const wt = join(tree, 'drzewa', 'galaz');
      await mkdir(join(wt, 'src'), { recursive: true });
      await writeFile(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'galaz')}\n`, 'utf8');
      await writeProjects({ [main]: { hasTrustDialogAccepted: true } });
      await expect(check().isTrusted(wt)).resolves.toBe(true);
      await expect(check().isTrusted(join(wt, 'src'))).resolves.toBe(true);
    });

  it('worktree bez wpisu głównego checkoutu, pod zaufanym rodzicem → NIEzaufany', async () => {
    const main = await repo(join(tree, 'repo'));
    const wt = join(tree, 'drzewa', 'galaz');
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'galaz')}\n`, 'utf8');
    await writeProjects({ [join(tree, 'drzewa')]: { hasTrustDialogAccepted: true } });
    await expect(check().isTrusted(wt)).resolves.toBe(false);
  });

  it('katalog domowy → NIEzaufany, także z wpisem `true` (CLI 2.1.319 nie zapisuje tego zaufania na dysk)', async () => {
    await writeProjects({ [home]: { hasTrustDialogAccepted: true }, [tree]: { hasTrustDialogAccepted: true } });
    await expect(check().isTrusted(home)).resolves.toBe(false);
  });

  it('błąd `stat` przy szukaniu `.git` → NIEzaufany (ostrzeżenie zamiast odmowy)', async () => {
    const parent = join(tree, 'projekty');
    await mkdir(join(parent, 'nowy'), { recursive: true });
    await writeProjects({ [parent]: { hasTrustDialogAccepted: true } });
    const denied = Object.assign(new Error('brak dostępu'), { code: 'EACCES' });
    const trust = check({ statGit: async (): Promise<never> => { throw denied; } });
    await expect(trust.isTrusted(join(parent, 'nowy'))).resolves.toBe(false);
  });

  it('własny wpis `false` katalogu bez repo nie przesłania `true` rodzica', async () => {
    const parent = join(tree, 'projekty');
    await mkdir(join(parent, 'nowy'), { recursive: true });
    await writeProjects({
      [parent]: { hasTrustDialogAccepted: true },
      [join(parent, 'nowy')]: { hasTrustDialogAccepted: false },
    });
    await expect(check().isTrusted(join(parent, 'nowy'))).resolves.toBe(true);
  });
});
