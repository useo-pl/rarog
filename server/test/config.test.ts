import { lstatSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseServerEvent } from '@rarog/shared';
import {
  ConfigError,
  DEFAULT_HERDR_BIN,
  DEFAULT_MAX_PANES,
  DEFAULT_PORT,
  demoOrigins,
  HERDR_ATTACH_CONCURRENCY,
  HERDR_GIT_MIN_INTERVAL_MS,
  HERDR_HISTORY_MESSAGES,
  HERDR_SEND_HOURLY_CAP,
  HERDR_SEND_MIN_INTERVAL_MS,
  MAX_BODY_BYTES,
  RAROG_HOST,
  assertLoopbackHost,
  defaultHerdrSocket,
  expandTilde,
  isInsideAnyRoot,
  isInsideAnyRootReal,
  loadConfig,
  logSecrets,
  parseGitEnvBase,
  parseHerdrBin,
  parseHerdrRoots,
  parseHerdrSocket,
  parseProjectRoots,
  parseYoloRoots,
  readAccountDefaultEffort,
  readAccountDefaultModel,
  validateProjectCwd,
} from '../src/config.ts';
import { GIT_ENV_PASSTHROUGH } from '../src/config-env.ts';

const demoEnv: NodeJS.ProcessEnv = { RAROG_DEMO: '1' };

/** Wartość o kształcie sekretu, jawnie syntetyczna — `loadConfig` jej nie waliduje. */
const SYNTETYCZNY_SEKRET = 'TEST-ONLY-sekret-xxxxxxxxxxxxxxx';

describe('loadConfig — tryb demo', () => {
  it('daje bezpieczne domyślne bez żadnego innego env', () => {
    const config = loadConfig(demoEnv);
    expect(config.demo).toBe(true);
    expect(config.epoch).toBe('1');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.host).toBe('127.0.0.1');
    expect(config.dataDir).toBe(path.join(os.tmpdir(), 'rarog-demo'));
    expect(config.originAllowList).toEqual([...demoOrigins(DEFAULT_PORT)]);
    expect(config.maxBodyBytes).toBe(MAX_BODY_BYTES);
  });

  it('pozwala nadpisać epokę', () => {
    const config = loadConfig({ ...demoEnv, RAROG_AUTH_EPOCH: '7' });
    expect(config.epoch).toBe('7');
  });

  it('allow-lista origin demo to własny adres serwera na loopbacku (bez originów vite)', () => {
    const config = loadConfig({ ...demoEnv, RAROG_PORT: '18931' });
    expect(config.originAllowList).toEqual(['http://localhost:18931', 'http://127.0.0.1:18931']);
    expect(config.originAllowList.some((o) => o.includes('5273'))).toBe(false);
  });

  it('demo na porcie 80 przyjmuje też origin bez numeru portu', () => {
    const config = loadConfig({ ...demoEnv, RAROG_PORT: '80' });
    expect(config.originAllowList).toContain('http://127.0.0.1');
    expect(config.originAllowList).toContain('http://localhost:80');
  });

  it('demo na porcie 0 bez RAROG_ORIGINS to błąd konfiguracji, nie allow-lista z `:0`', () => {
    expect(() => loadConfig({ ...demoEnv, RAROG_PORT: '0' })).toThrow(/RAROG_PORT=0/);
    expect(loadConfig({ ...demoEnv, RAROG_PORT: '0', RAROG_ORIGINS: 'http://127.0.0.1:4000' }).originAllowList)
      .toEqual(['http://127.0.0.1:4000']);
  });
});

/**
 * `RAROG_ORIGINS` takes only an origin exactly as a browser sends it in `Origin`. A non-canonical entry never
 * matched a real `Origin` except `null`, which a sandboxed frame or a `file:` page does send, so it opened the CSRF
 * gate to any page. It is skipped and reported, and the start goes on: an installation with such an entry works today
 * (e.g. over iroh) and must keep working after the update.
 */
describe('loadConfig — RAROG_ORIGINS entries', () => {
  const GOOD = 'https://ok.example';
  const cases: readonly (readonly [entry: string, accepted: boolean])[] = [
    ['https://mac.example.ts.net', true],
    ['http://127.0.0.1:8930', true],
    ['null', false],
    ['*', false],
    ['https://a.example/', false],
    ['HTTPS://A.EXAMPLE', false],
    ['https://a.example:443', false],
    ['file:///x', false],
  ];

  it.each(cases)('%s → accepted: %s', (entry, accepted) => {
    const config = loadConfig({ RAROG_ORIGINS: `${entry}, ${GOOD}` });
    expect(config.originAllowList).toEqual(accepted ? [entry, GOOD] : [GOOD]);
    expect(config.originsSkipped ?? []).toEqual(accepted ? [] : [entry]);
  });

  it('every entry skipped: the start goes on with an empty allow-list (no TCP mutation passes)', () => {
    const config = loadConfig({ RAROG_ORIGINS: 'null,*' });
    expect(config.originAllowList).toEqual([]);
    expect(config.originsSkipped).toEqual(['null', '*']);
  });

  it('demo with an explicit list skips the same entries instead of falling back to its own origins', () => {
    const config = loadConfig({ ...demoEnv, RAROG_ORIGINS: 'null,http://127.0.0.1:4000' });
    expect(config.originAllowList).toEqual(['http://127.0.0.1:4000']);
    expect(config.originsSkipped).toEqual(['null']);
  });

  it('review demo still refuses a skipped entry next to its one https origin', () => {
    const env: NodeJS.ProcessEnv = {
      RAROG_DEMO: '1', RAROG_DEMO_REVIEW_CODE: 'a'.repeat(43), RAROG_ORIGINS: `null,${GOOD}`,
      RAROG_DATA_DIR: path.join(os.tmpdir(), `rarog-origins-${String(process.pid)}-missing`),
    };
    expect(() => loadConfig(env)).toThrow(/exactly one bare https origin/);
  });
});

describe('loadConfig — bind', () => {
  it('zawsze zwraca host 127.0.0.1', () => {
    expect(loadConfig(demoEnv).host).toBe(RAROG_HOST);
  });

  it('odrzuca próbę bindu na 0.0.0.0', () => {
    expect(() => loadConfig({ ...demoEnv, RAROG_HOST: '0.0.0.0' })).toThrow(ConfigError);
  });

  it('odrzuca bind na adres LAN', () => {
    expect(() => loadConfig({ ...demoEnv, RAROG_HOST: '192.168.1.10' })).toThrow(/127\.0\.0\.1/);
  });

  it('akceptuje jawne RAROG_HOST=127.0.0.1', () => {
    expect(loadConfig({ ...demoEnv, RAROG_HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
  });

  it('assertLoopbackHost przepuszcza tylko loopback', () => {
    expect(() => { assertLoopbackHost('127.0.0.1'); }).not.toThrow();
    expect(() => { assertLoopbackHost('::1'); }).toThrow(ConfigError);
    expect(() => { assertLoopbackHost('localhost'); }).toThrow(ConfigError);
  });
});

describe('loadConfig — poza demo', () => {
  it('wymaga RAROG_ORIGINS', () => {
    expect(() => loadConfig({})).toThrow(/RAROG_ORIGINS/);
  });

  it('czyta allow-listę z env', () => {
    const config = loadConfig({
      RAROG_ORIGINS: 'https://rarog.example, https://drugi.example',
    });
    expect(config.originAllowList).toEqual(['https://rarog.example', 'https://drugi.example']);
    expect(config.dataDir).not.toContain('rarog-demo');
  });

  it('skips commas with nothing between them; a list of nothing but commas is still an error', () => {
    expect(loadConfig({ RAROG_ORIGINS: ' , https://rarog.example,, ' }).originAllowList)
      .toEqual(['https://rarog.example']);
    expect(() => loadConfig({ RAROG_ORIGINS: ' , ,' })).toThrow(/RAROG_ORIGINS/);
  });

  it('odrzuca niepoprawny port', () => {
    expect(() => loadConfig({ ...demoEnv, RAROG_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...demoEnv, RAROG_PORT: '99999' })).toThrow(ConfigError);
  });

  it('zrzuty odmów są domyślnie WŁĄCZONE, a `RAROG_REFUSAL_DUMPS=0` je gasi', () => {
    // Domyślne „włączone" jest świadome: katalog ma retencję i sufit, a jego brak kosztował
    // dzień śledztwa nad jedną odmową. Wyłącznik istnieje, bo zrzut niesie treść ekranu.
    const env = {
      RAROG_ORIGINS: 'https://rarog.example',
    };
    expect(loadConfig(env).refusalDumps).toBe(true);
    expect(loadConfig({ ...env, RAROG_REFUSAL_DUMPS: '0' }).refusalDumps).toBe(false);
    expect(loadConfig({ ...env, RAROG_REFUSAL_DUMPS: 'false' }).refusalDumps).toBe(false);
    // Demo nie dotyka dysku — zrzut z treścią ekranu jest tam wyłączony bezwarunkowo.
    expect(loadConfig({ ...demoEnv, RAROG_REFUSAL_DUMPS: '1' }).refusalDumps).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bez tokenu aplikacji: jedynym poświadczeniem jest klucz urządzenia
// ---------------------------------------------------------------------------

describe('loadConfig — bez tokenu aplikacji', () => {
  it('`RAROG_AUTH_TOKEN` w env niczego nie zmienia: ani start, ani pola konfiguracji, ani lista sekretów do logów', () => {
    const base = { RAROG_ORIGINS: 'https://rarog.example.com', SONIOX_API_KEY: 'sekret-soniox' };
    // Dawny guard siły tokenu (`demo`, krótki) nie istnieje: wartość jest ignorowana w obu trybach.
    for (const env of [{ ...base }, { ...base, RAROG_AUTH_TOKEN: 'demo' }, { ...base, RAROG_AUTH_TOKEN: 'krotki' },
      { ...demoEnv, RAROG_AUTH_TOKEN: SYNTETYCZNY_SEKRET }]) {
      const config = loadConfig(env);
      expect(Object.keys(config).filter((key) => /token|cookie/i.test(key)), JSON.stringify(env)).toEqual([]);
      expect(logSecrets(config)).not.toContain(SYNTETYCZNY_SEKRET);
    }
    expect(logSecrets(loadConfig(base))).toEqual(['sekret-soniox']);
  });

  it('demo pod tailnetowym originem nadal startuje (świadoma decyzja prowadzącego)', () => {
    const config = loadConfig({
      ...demoEnv,
      RAROG_ORIGINS: 'https://rarog.example.com',
    });
    expect(config.originAllowList).toEqual(['https://rarog.example.com']);
  });
});

// ---------------------------------------------------------------------------
// Korzenie projektów
// ---------------------------------------------------------------------------

const HOME = '/Users/testowy';

describe('readAccountDefaultModel', () => {
  it('czyta pole `model` z ~/.claude/settings.json', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const home = await mkdtemp(path.join(os.tmpdir(), 'rarog-home-'));
    try {
      await mkdir(path.join(home, '.claude'));
      await writeFile(
        path.join(home, '.claude', 'settings.json'),
        JSON.stringify({ model: 'claude-fable-5' }),
      );
      expect(readAccountDefaultModel(home)).toBe('claude-fable-5');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('brak pliku, zepsuty JSON i pole bez wartości dają undefined, nigdy wyjątek', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const home = await mkdtemp(path.join(os.tmpdir(), 'rarog-home-'));
    try {
      // Brak pliku.
      expect(readAccountDefaultModel(home)).toBeUndefined();
      await mkdir(path.join(home, '.claude'));
      // Zepsuty JSON.
      await writeFile(path.join(home, '.claude', 'settings.json'), '{nie-json');
      expect(readAccountDefaultModel(home)).toBeUndefined();
      // JSON bez pola `model` / z polem złego typu / z pustym stringiem.
      for (const body of ['{}', '{"model": 7}', '{"model": ""}', '[1,2]']) {
        await writeFile(path.join(home, '.claude', 'settings.json'), body);
        expect(readAccountDefaultModel(home)).toBeUndefined();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('readAccountDefaultEffort', () => {
  /** Katalog domowy z podanym `settings.json` — sprzątany przez wołającego. */
  const withSettings = async (
    body: string, run: (home: string) => void,
  ): Promise<void> => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const home = await mkdtemp(path.join(os.tmpdir(), 'rarog-home-'));
    try {
      await mkdir(path.join(home, '.claude'));
      await writeFile(path.join(home, '.claude', 'settings.json'), body);
      run(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };

  /*
   * This file is the source of both the model and its effort: a session created from Rarog carries the effort
   * that the herdr pane has set, not only the model.
   */
  it('wpis modelu bije wartość globalną', async () => {
    await withSettings(
      JSON.stringify({
        effortLevel: 'medium',
        modelSettings: { 'claude-fable-5': { effortLevel: 'medium' }, 'claude-opus-5': { effortLevel: 'high' } },
      }),
      (home) => {
        expect(readAccountDefaultEffort('claude-opus-5', home)).toBe('high');
        expect(readAccountDefaultEffort('claude-fable-5', home)).toBe('medium');
      },
    );
  });

  it('model bez własnego wpisu spada na globalne `effortLevel`', async () => {
    await withSettings(
      JSON.stringify({ effortLevel: 'xhigh', modelSettings: { 'claude-opus-5': { effortLevel: 'high' } } }),
      (home) => {
        expect(readAccountDefaultEffort('haiku', home)).toBe('xhigh');
        // Bez modelu (panel bez `--model`) pytanie o wpis modelu w ogóle nie ma treści.
        expect(readAccountDefaultEffort(undefined, home)).toBe('xhigh');
      },
    );
  });

  /*
   * The `model` field of the same file holds the CLI alias (`opus`), while the per-model entry stands under the
   * resolved id (`claude-opus-5`): asking for the alias would fall through to the global `effortLevel`.
   */
  it('skrót CLI trafia we wpis pełnego identyfikatora', async () => {
    await withSettings(
      JSON.stringify({ effortLevel: 'low', modelSettings: { 'claude-opus-5': { effortLevel: 'max' } } }),
      (home) => {
        expect(readAccountDefaultEffort('opus', home)).toBe('max');
        // Cudzy skrót nie kradnie cudzego wpisu.
        expect(readAccountDefaultEffort('sonnet', home)).toBe('low');
      },
    );
  });

  it('skrót z wariantem okna (`opus[1m]`) trafia w ten sam wpis rodziny', async () => {
    // Domyślny model konta bywa skrótem `opus[1m]`, a wpis effortu stoi pod `claude-opus-5-5`.
    await withSettings(
      JSON.stringify({ effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } }),
      (home) => {
        expect(readAccountDefaultEffort('opus[1m]', home)).toBe('xhigh');
        expect(readAccountDefaultEffort('opus', home)).toBe('xhigh');
      },
    );
  });

  it('zgodne wpisy jednej rodziny są jednoznaczne, sprzeczne wracają do globalnego', async () => {
    // Wersji nie zgadujemy: przy `claude-opus-4-7: high` obok `claude-opus-5: xhigh` nie
    // wiadomo, na co CLI rozwiąże `opus`, więc seed woli wartość globalną od losowej.
    await withSettings(
      JSON.stringify({
        effortLevel: 'low',
        modelSettings: { 'claude-opus-4-7': { effortLevel: 'high' }, 'claude-opus-5': { effortLevel: 'xhigh' } },
      }),
      (home) => { expect(readAccountDefaultEffort('opus', home)).toBe('low'); },
    );

    await withSettings(
      JSON.stringify({
        effortLevel: 'low',
        modelSettings: { 'claude-opus-4-7': { effortLevel: 'xhigh' }, 'claude-opus-5': { effortLevel: 'xhigh' } },
      }),
      (home) => { expect(readAccountDefaultEffort('opus', home)).toBe('xhigh'); },
    );
  });

  it('wpis DOKŁADNY bije wpis znaleziony po skrócie', async () => {
    await withSettings(
      JSON.stringify({
        effortLevel: 'low',
        modelSettings: { opus: { effortLevel: 'medium' }, 'claude-opus-5': { effortLevel: 'max' } },
      }),
      (home) => {
        expect(readAccountDefaultEffort('opus', home)).toBe('medium');
        expect(readAccountDefaultEffort('claude-opus-5', home)).toBe('max');
      },
    );
  });

  it('poziom spoza kontraktu jest tak samo nieznany jak brak pola', async () => {
    for (const body of [
      '{}',
      '{"effortLevel": "turbo"}',
      '{"effortLevel": 3}',
      '{"modelSettings": {"m": {"effortLevel": "turbo"}}}',
      '{"modelSettings": "nie-obiekt"}',
      '{nie-json',
      '[1,2]',
    ]) {
      await withSettings(body, (home) => {
        expect(readAccountDefaultEffort('m', home)).toBeUndefined();
      });
    }
  });

  it('brak pliku daje undefined, nigdy wyjątek', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const home = await mkdtemp(path.join(os.tmpdir(), 'rarog-home-'));
    try {
      expect(readAccountDefaultEffort('claude-fable-5', home)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('expandTilde', () => {
  it('rozwija `~` i `~/…` do katalogu domowego', () => {
    expect(expandTilde('~', HOME)).toBe(HOME);
    expect(expandTilde('~/Projects', HOME)).toBe(`${HOME}/Projects`);
  });

  it('nie rusza ścieżek bezwzględnych ani `~user` (obce konta to nie nasza sprawa)', () => {
    expect(expandTilde('/srv/kod', HOME)).toBe('/srv/kod');
    expect(expandTilde('~ktos/kod', HOME)).toBe('~ktos/kod');
  });
});

describe('parseProjectRoots', () => {
  it('bez zmiennej daje ~/Projects', () => {
    expect(parseProjectRoots(undefined, HOME)).toEqual([path.join(HOME, 'Projects')]);
    expect(parseProjectRoots('   ', HOME)).toEqual([path.join(HOME, 'Projects')]);
  });

  it('czyta listę po przecinku, rozwija tyldę i normalizuje ścieżki', () => {
    expect(parseProjectRoots(' ~/Projects , /srv/kod/ , /var/tmp/../work ', HOME)).toEqual([
      path.join(HOME, 'Projects'), '/srv/kod', '/var/work',
    ]);
  });

  it('loadConfig wystawia korzenie w konfiguracji', () => {
    expect(loadConfig({ RAROG_DEMO: '1' }).projectRoots)
      .toEqual([path.join(os.homedir(), 'Projects')]);
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_PROJECT_ROOTS: '/srv/kod,/srv/inne' }).projectRoots)
      .toEqual(['/srv/kod', '/srv/inne']);
  });
});

describe('validateProjectCwd', () => {
  const roots = ['/Users/testowy/Projects', '/srv/kod'];
  const istnieje = (candidate: string): boolean => candidate !== '/Users/testowy/Projects/nie-ma';
  // Ścieżki w tym bloku są ZMYŚLONE, więc rozwiązywanie dowiązań musi być tożsamością —
  // prawdziwy `realpathSync` wywaliłby je wszystkie na ENOENT. Granicę po dowiązaniach
  // sprawdza osobny blok niżej, na prawdziwym drzewie w tmp.
  const check = (input: string) =>
    validateProjectCwd(input, roots, { isDirectory: istnieje, home: HOME, realPath: (p) => p });

  it('przepuszcza podkatalog korzenia i sam korzeń', () => {
    expect(check('/Users/testowy/Projects/ACME/rarog'))
      .toEqual({ ok: true, cwd: '/Users/testowy/Projects/ACME/rarog' });
    expect(check('/srv/kod')).toEqual({ ok: true, cwd: '/srv/kod' });
  });

  it('rozwija tyldę i normalizuje wejście', () => {
    expect(check('~/Projects/willow/')).toEqual({ ok: true, cwd: '/Users/testowy/Projects/willow' });
  });

  it('odrzuca ścieżkę poza korzeniami — także przez `..`', () => {
    expect(check('/etc')).toMatchObject({ ok: false });
    expect(check('/Users/testowy/Projects/../../../etc')).toMatchObject({ ok: false });
    // Podobny prefiks to NIE to samo co bycie w środku korzenia.
    expect(check('/srv/kodex')).toMatchObject({ ok: false });
  });

  it('odrzuca katalogi ukryte na dowolnym poziomie', () => {
    const ukryty = check('/Users/testowy/Projects/.git');
    expect(ukryty.ok).toBe(false);
    expect(ukryty.ok === false && ukryty.sentence.ref.code).toBe('rest.cwd-hidden');
    expect(check('/Users/testowy/Projects/a/.cache/b')).toMatchObject({ ok: false });
  });

  it('odrzuca katalog, którego nie ma na dysku', () => {
    const wynik = check('/Users/testowy/Projects/nie-ma');
    expect(wynik.ok).toBe(false);
    expect(wynik.ok === false && wynik.sentence.ref.code).toBe('rest.cwd-not-found');
  });

  it('pusta ścieżka i pusta lista korzeni są fail-closed', () => {
    expect(check('   ')).toMatchObject({ ok: false });
    expect(validateProjectCwd('/cokolwiek', [], { isDirectory: () => true }))
      .toMatchObject({ ok: false });
  });

  /*
   * Znalezisko audytu APP-09: funkcja jest DRUGĄ linią obrony (`manager.#assertAllowedCwd`),
   * więc nie może polegać na tym, że router odsiał wejście względne. Wcześniej `path.resolve`
   * doklejał do niego cwd PROCESU: `.` → katalog serwera, `../../etc` → `<roots>/etc`.
   */
  it('odrzuca ścieżki WZGLĘDNE, zamiast rozwijać je względem katalogu serwera', () => {
    for (const relative of ['.', '..', '../../etc', 'Projects/rarog', './rarog']) {
      const wynik = validateProjectCwd(relative, roots, { isDirectory: () => true, home: HOME });
      expect(wynik.ok).toBe(false);
      expect(wynik.ok === false && wynik.sentence.ref.code).toBe('rest.cwd-not-absolute');
    }
  });

  it('odrzuca `~user` — tylda z nazwą użytkownika nie jest rozwijana', () => {
    const wynik = validateProjectCwd('~root/x', roots, { isDirectory: () => true, home: HOME });
    expect(wynik.ok).toBe(false);
    expect(wynik.ok === false && wynik.sentence.ref.code).toBe('rest.cwd-not-absolute');
  });
});

/*
 * The `RAROG_PROJECT_ROOTS` boundary compares resolved paths, because the only disk access (`statSync`) FOLLOWS
 * symlinks: a lexical comparison would pass `<root>/link -> <base>/outside` with `{ok: true}`, and a `claude`
 * session, the terminal, uploads and `git` would start physically outside the roots.
 *
 * Ten blok jedzie na PRAWDZIWYM drzewie w tmp — dowiązania nie da się sensownie zmyślić.
 */
describe('validateProjectCwd — granica po rozwiązaniu dowiązań', () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    // `realpath` na bazie, bo na macOS `os.tmpdir()` sam jest dowiązaniem (`/var` → `/private/var`)
    // i bez tego test mierzyłby zachowanie systemu plików, a nie granicy.
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rarog-cfg-')));
    root = path.join(base, 'Projects');
    await mkdir(path.join(root, 'wewnatrz'), { recursive: true });
    await mkdir(path.join(base, 'poza-korzeniem'), { recursive: true });
    await symlink(path.join(base, 'poza-korzeniem'), path.join(root, 'skrot-na-zewnatrz'));
    await symlink(path.join(root, 'wewnatrz'), path.join(root, 'skrot-do-srodka'));
    await symlink(root, path.join(base, 'KorzeńPrzezDowiązanie'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('zwykły podkatalog korzenia przechodzi i wraca ŚCIEŻKĄ LEKSYKALNĄ', () => {
    const cel = path.join(root, 'wewnatrz');
    expect(validateProjectCwd(cel, [root])).toEqual({ ok: true, cwd: cel });
  });

  it('dowiązanie prowadzące POZA korzenie odpada, choć leksykalnie jest w środku', () => {
    const link = path.join(root, 'skrot-na-zewnatrz');
    // Dokładnie to przepuszczał stary kod: leksykalnie w korzeniu, fizycznie poza nim.
    expect(isInsideAnyRoot(link, [root])).toBe(true);
    const wynik = validateProjectCwd(link, [root]);
    expect(wynik.ok).toBe(false);
    expect(wynik.ok === false && wynik.sentence.ref.code).toBe('rest.cwd-symlink-escape');
  });

  it('dowiązanie prowadzące W GRANICE korzeni nadal przechodzi', () => {
    const link = path.join(root, 'skrot-do-srodka');
    expect(validateProjectCwd(link, [root])).toEqual({ ok: true, cwd: link });
  });

  it('korzeń będący dowiązaniem nie odcina własnych podkatalogów', () => {
    const korzenLink = path.join(base, 'KorzeńPrzezDowiązanie');
    const cel = path.join(korzenLink, 'wewnatrz');
    expect(validateProjectCwd(cel, [korzenLink])).toEqual({ ok: true, cwd: cel });
  });

  /*
   * The "no hidden directories" rule looks at the PHYSICAL path, like the root boundary. A symlink
   * `<root>/link -> <root>/.git` has no segment starting with a dot lexically and is physically still in the root,
   * so a lexical rule would answer `{ok:true}` for `.git` (and the same for `.ssh` or `.aws`) to EVERY caller, not
   * only the terminal.
   */
  it('dowiązanie do katalogu UKRYTEGO w korzeniu odpada, choć leksykalnie kropki nie ma',
    async () => {
      await mkdir(path.join(root, '.git', 'objects'), { recursive: true });
      await symlink(path.join(root, '.git'), path.join(root, 'skrot-do-ukrytego'));
      const link = path.join(root, 'skrot-do-ukrytego');
      expect(isInsideAnyRootReal(link, [root])).toBe(true);
      const wynik = validateProjectCwd(link, [root]);
      expect(wynik.ok).toBe(false);
      expect(wynik.ok === false && wynik.sentence.ref.code).toBe('rest.cwd-hidden');
      // Także głębiej: `<korzeń>/skrót/objects` fizycznie schodzi przez `.git`.
      expect(validateProjectCwd(path.join(link, 'objects'), [root])).toMatchObject({ ok: false });
    });

  it('korzeń leżący FIZYCZNIE pod katalogiem ukrytym nie odcina swoich podkatalogów',
    async () => {
      // Segmenty ukryte liczymy dopiero POD rozwiązanym korzeniem. Korzeń schowany za
      // dowiązaniem (`~/Projects -> ~/.magazyn/Projects`) jest decyzją z KONFIGURACJI,
      // nie ścieżką z żądania — inaczej sprawdzenie fizyczne odcięłoby legalny projekt.
      await mkdir(path.join(base, '.magazyn', 'Projects', 'projekt'), { recursive: true });
      const korzen = path.join(base, 'KorzeńUkrytyFizycznie');
      await symlink(path.join(base, '.magazyn', 'Projects'), korzen);
      const cel = path.join(korzen, 'projekt');
      expect(validateProjectCwd(cel, [korzen])).toEqual({ ok: true, cwd: cel });
    });

  it('isInsideAnyRootReal jest fail-closed dla ścieżki nie do rozwiązania', () => {
    expect(isInsideAnyRootReal(path.join(root, 'nie-ma-mnie'), [root])).toBe(false);
    // Nieistniejący korzeń zostaje leksykalny — nie może rozszerzać granicy w żadną stronę.
    expect(isInsideAnyRootReal(path.join(root, 'wewnatrz'), [path.join(base, 'nie-ma')]))
      .toBe(false);
  });
});

/*
 * The work area: with the root `~` the macOS-protected folders stay out, and the check comes before any disk
 * access, because a read there makes macOS ask for access and the synchronous check would wait on the event loop.
 */
describe('validateProjectCwd: the work area with the root ~', () => {
  let base: string;
  let home: string;
  const touched: string[] = [];
  const walk = {
    lstat: (file: string) => {
      touched.push(file);
      return lstatSync(file);
    },
    readlink: (file: string) => {
      touched.push(file);
      return readlinkSync(file);
    },
  };

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rarog-cfg-area-')));
    home = path.join(base, 'demo');
    for (const dir of ['inne/x', 'Desktop/y', 'Documents/Projects/p', 'Library/z']) {
      await mkdir(path.join(home, dir), { recursive: true });
    }
    touched.length = 0;
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('~/Desktop/x is refused as protected with no disk access', () => {
    const asked: string[] = [];
    const check = validateProjectCwd(path.join(home, 'Desktop', 'y'), [home], {
      home, walk, isDirectory: (p) => { asked.push(p); return true; },
    });
    expect(check.ok === false && check.sentence.ref.code).toBe('rest.cwd-protected');
    expect(asked).toEqual([]);
    expect(touched).toEqual([]);
    expect(validateProjectCwd('~/Library/z', [home], { home, walk })).toMatchObject({ ok: false });
    expect(touched).toEqual([]);
  });

  it('~/De\u017fktop/sub, which the default macOS disk reads as ~/Desktop/sub, is refused as protected with no disk'
    + ' access', async () => {
    // On a case-sensitive disk the long s spelling is a folder of its own; it exists either way.
    await mkdir(path.join(home, 'De\u017fktop', 'sub'), { recursive: true });
    const asked: string[] = [];
    const check = validateProjectCwd('~/De\u017fktop/sub', [home], {
      home, walk, isDirectory: (p) => { asked.push(p); return true; },
    });
    expect(check.ok === false && check.sentence.ref.code).toBe('rest.cwd-protected');
    expect(asked).toEqual([]);
    expect(touched).toEqual([]);
  });

  it('a session in ~/inne/x is allowed', () => {
    const cwd = path.join(home, 'inne', 'x');
    expect(validateProjectCwd(cwd, [home], { home, walk })).toEqual({ ok: true, cwd });
  });

  it('a root inside ~/Documents opens its own subtree only', () => {
    const roots = [home, path.join(home, 'Documents', 'Projects')];
    const cwd = path.join(home, 'Documents', 'Projects', 'p');
    expect(validateProjectCwd(cwd, roots, { home, walk })).toEqual({ ok: true, cwd });
    const other = validateProjectCwd(path.join(home, 'Documents'), roots, { home, walk });
    expect(other.ok === false && other.sentence.ref.code).toBe('rest.cwd-protected');
  });

  it('a symlink into ~/Desktop is refused and nothing inside Desktop is touched', async () => {
    const link = path.join(home, 'inne', 'x', 'link');
    await symlink(path.join(home, 'Desktop', 'y'), link);
    const check = validateProjectCwd(link, [home], { home, walk });
    expect(check.ok === false && check.sentence.ref.code).toBe('rest.cwd-symlink-escape');
    expect(touched.filter((file) => file.startsWith(path.join(home, 'Desktop')))).toEqual([]);
  });

  it('~/.cache/x stays refused as hidden', () => {
    const check = validateProjectCwd(path.join(home, '.cache', 'x'), [home], { home, walk });
    expect(check.ok === false && check.sentence.ref.code).toBe('rest.cwd-hidden');
  });

  it('a root that is a symlink to home refuses its protected folders without a read there', async () => {
    const dom = path.join(base, 'dom');
    await symlink(home, dom);
    for (const cwd of [path.join(dom, 'Desktop', 'y'), path.join(dom, 'Library', 'z')]) {
      const check = validateProjectCwd(cwd, [dom], { home, walk });
      expect(check.ok === false && check.sentence.ref.code, cwd).toBe('rest.cwd-symlink-escape');
    }
    expect(touched.filter((file) => file.startsWith(path.join(home, 'Desktop'))
      || file.startsWith(path.join(home, 'Library')))).toEqual([]);
    const cwd = path.join(dom, 'inne', 'x');
    expect(validateProjectCwd(cwd, [dom], { home, walk })).toEqual({ ok: true, cwd });
  });
});

describe('loadConfig — próg builda apki natywnej', () => {
  it('RAROG_MIN_CLIENT_BUILD: brak/pusta = brak progu, liczba ≥ 1 = próg, bzdura = ConfigError', () => {
    expect(loadConfig(demoEnv)).not.toHaveProperty('minClientBuild');
    expect(loadConfig({ ...demoEnv, RAROG_MIN_CLIENT_BUILD: '' })).not.toHaveProperty('minClientBuild');
    expect(loadConfig({ ...demoEnv, RAROG_MIN_CLIENT_BUILD: '  ' })).not.toHaveProperty('minClientBuild');
    expect(loadConfig({ ...demoEnv, RAROG_MIN_CLIENT_BUILD: '42' }).minClientBuild).toBe(42);
    expect(loadConfig({ ...demoEnv, RAROG_MIN_CLIENT_BUILD: ' 7 ' }).minClientBuild).toBe(7);
    // Literówka ma wywalić start, a nie po cichu zdjąć bramkę, którą ktoś właśnie stawiał.
    for (const bad of ['0', '-1', '2.5', 'abc', '1e400']) {
      expect(() => loadConfig({ ...demoEnv, RAROG_MIN_CLIENT_BUILD: bad }), bad).toThrow(ConfigError);
    }
  });

  it('granica MAX_SAFE_INTEGER: config przyjmuje DOKŁADNIE to, co przyjmie schemat `hello`', () => {
    const hello = (minClientBuild: number) => ({
      type: 'hello', protocolVersion: 3, serverStartId: 'start-1', minClientBuild,
    });
    const max = String(Number.MAX_SAFE_INTEGER);
    const accepted = loadConfig({ ...demoEnv, RAROG_MIN_CLIENT_BUILD: max }).minClientBuild;
    expect(accepted).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseServerEvent(hello(Number.MAX_SAFE_INTEGER))).not.toBeNull();
    // O jeden więcej: zod (`.int()`) odrzuca, więc serwer nie może tego wystartować.
    expect(parseServerEvent(hello(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
    for (const bad of ['9007199254740992', '1e21']) {
      expect(() => loadConfig({ ...demoEnv, RAROG_MIN_CLIENT_BUILD: bad }), bad).toThrow(ConfigError);
    }
  });
});

describe('loadConfig — bezpieczniki zasobów i trybu yolo', () => {
  it('sufit paneli jest ZAPORĄ PRZECIWPOWODZIOWĄ (30), nie limitem pracy', () => {
    /*
     * The pane cap is not a SECURITY boundary: the same phone has an SSH client, and from a shell any number
     * of `claude` starts without asking Rarog. A low cap would take power from the owner, not from an attacker.
     *
     * Została GÓRNA GRANICA na wypadek powodzi (skrypt/pętla zakładająca panele): 30 to
     * wartość, której ręka nie dotknie (rekord właściciela: 6), a hodowla dotknie szybko.
     * Test pilnuje RZĘDU WIELKOŚCI, bo to on niesie znaczenie: gdyby ktoś ściągnął tę liczbę
     * z powrotem do jednocyfrowej, wróciłby limit pracy pod pozorem bezpiecznika.
     */
    expect(loadConfig(demoEnv).maxPanes).toBe(DEFAULT_MAX_PANES);
    expect(DEFAULT_MAX_PANES).toBe(30);
    expect(DEFAULT_MAX_PANES).toBeGreaterThan(20);
  });

  it('RAROG_MAX_PANES przestawia sufit i odrzuca bzdury', () => {
    expect(loadConfig({ ...demoEnv, RAROG_MAX_PANES: '2' }).maxPanes).toBe(2);
    // „0" NIE znaczy „bez limitu", tylko „ani jednego panelu" — cicha zamiana tych znaczeń
    // jest dokładnie tym błędem, po którym bezpiecznik jest martwy. Stąd odmowa.
    expect(() => loadConfig({ ...demoEnv, RAROG_MAX_PANES: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...demoEnv, RAROG_MAX_PANES: 'dużo' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...demoEnv, RAROG_MAX_PANES: '2.5' })).toThrow(ConfigError);
  });

  it('lista yolo jest domyślnie PUSTA (bypassPermissions nigdzie nie działa)', () => {
    expect(loadConfig(demoEnv).yoloRoots).toEqual([]);
  });

  it('RAROG_YOLO_ROOTS rozwija tyldę i normalizuje ścieżki', () => {
    expect(parseYoloRoots(' ~/Projects/scratch , /srv/tmp/ ', HOME)).toEqual([
      path.join(HOME, 'Projects', 'scratch'), '/srv/tmp',
    ]);
  });

  it('isInsideAnyRoot jest fail-closed dla pustej listy i ścieżek względnych', () => {
    expect(isInsideAnyRoot('/srv/kod/x', ['/srv/kod'])).toBe(true);
    expect(isInsideAnyRoot('/srv/kod', ['/srv/kod'])).toBe(true);
    expect(isInsideAnyRoot('/srv/kodex', ['/srv/kod'])).toBe(false);
    expect(isInsideAnyRoot('/srv/kod/x', [])).toBe(false);
    expect(isInsideAnyRoot('.', ['/srv/kod'])).toBe(false);
  });
});

describe('loadConfig — integracja herdr', () => {
  it('integracja NIE jest opcją: kanał zapisu jest domyślnie otwarty, tworzenia — zamknięty', () => {
    const config = loadConfig(demoEnv);
    // Po wycięciu SDK herdr jest jedynym źródłem sesji, więc `RAROG_HERDR` zniknęło.
    // Zostały DWA rozłączne killswitche — i tylko ten groźniejszy jest domyślnie wyłączony.
    expect(config.herdrSend).toBe(true);
    expect(config.herdrLaunch).toBe(false);
    expect(config.herdrSocket).toBe(defaultHerdrSocket());
  });

  it('RAROG_HERDR_LAUNCH=1 to jedyna droga do kanału tworzenia (opt-in, nie opt-out)', () => {
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_LAUNCH: '1' }).herdrLaunch).toBe(true);
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_LAUNCH: '0' }).herdrLaunch).toBe(false);
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_LAUNCH: 'tak' }).herdrLaunch).toBe(false);
  });

  it('RAROG_HERDR_SEND=0 zostawia podgląd i odcina zapis', () => {
    const config = loadConfig({
      ...demoEnv, RAROG_HERDR_SEND: '0',
      RAROG_HERDR_SOCKET: path.join(os.tmpdir(), 'rarog-brak-gniazda.sock'),
    });
    expect(config.herdrSend).toBe(false);
  });

  it('RAROG_HERDR_SEEN_FOCUS: domyślnie WŁĄCZONE, `0` wyłącza', () => {
    // Opt-out, a nie opt-in — bo to nie jest killswitch WŁADZY: `agent.focus` jest metodą
    // mutującą, więc `RAROG_HERDR_SEND=0` gasi tę ścieżkę niezależnie od tej flagi.
    expect(loadConfig(demoEnv).herdrSeenFocus).toBe(true);
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_SEEN_FOCUS: '0' }).herdrSeenFocus).toBe(false);
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_SEEN_FOCUS: 'false' }).herdrSeenFocus).toBe(false);
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_SEEN_FOCUS: '' }).herdrSeenFocus).toBe(true);
  });

  it('RAROG_HERDR_TAB_LABELS: domyślnie WŁĄCZONE, `0` wyłącza', () => {
    // Preferencja jak `RAROG_HERDR_SEEN_FOCUS`: `tab.rename` i `pane.rename` są mutacjami, więc
    // `RAROG_HERDR_SEND=0` gasi je niezależnie od tej flagi.
    expect(loadConfig(demoEnv).herdrTabLabels).toBe(true);
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_TAB_LABELS: '0' }).herdrTabLabels).toBe(false);
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_TAB_LABELS: 'false' }).herdrTabLabels).toBe(false);
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_TAB_LABELS: '' }).herdrTabLabels).toBe(true);
    expect(loadConfig({ ...demoEnv, RAROG_HERDR_TAB_LABELS: '1' }).herdrTabLabels).toBe(true);
  });

  it('RAROG_CODEX_STATUS: domyślnie WŁĄCZONE, `0` wyłącza, demo zawsze `false`', () => {
    /*
     * FLAGA FUNKCJI, nie ósmy killswitch — jak `RAROG_HERDR_SEEN_FOCUS`. Wpis Codexa nie
     * dokłada Rarogowi żadnej władzy (zero wysyłki, zero odczytu ekranu, `inScope: false`),
     * więc domyślne „włączone" jest tańsze niż przy którymkolwiek killswitchu.
     */
    const env = {
      RAROG_ORIGINS: 'https://rarog.example',
    };
    expect(loadConfig(env).codexStatusEnabled).toBe(true);
    expect(loadConfig({ ...env, RAROG_CODEX_STATUS: '' }).codexStatusEnabled).toBe(true);
    expect(loadConfig({ ...env, RAROG_CODEX_STATUS: '0' }).codexStatusEnabled).toBe(false);
    expect(loadConfig({ ...env, RAROG_CODEX_STATUS: 'false' }).codexStatusEnabled).toBe(false);
    // Demo nie rozmawia z żywym herdr, więc wpis, który bierze się WYŁĄCZNIE z `agent.list`,
    // nie miałby skąd powstać — wyłączamy jawnie, zamiast liczyć na to, że i tak nie zadziała.
    expect(loadConfig({ ...demoEnv, RAROG_CODEX_STATUS: '1' }).codexStatusEnabled).toBe(false);
  });

  it('RAROG_GIT_FILE_DETAILS: domyślnie WŁĄCZONE, `0`/`false` wyłącza; demo jak poza nim', () => {
    // Preferencja, nie killswitch: szczegóły plików tylko czytają repo (jak `RAROG_CLI_WAITING`).
    const env = { RAROG_ORIGINS: 'https://rarog.example' };
    expect(loadConfig(env).gitFileDetails).toBe(true);
    expect(loadConfig({ ...env, RAROG_GIT_FILE_DETAILS: '' }).gitFileDetails).toBe(true);
    expect(loadConfig({ ...env, RAROG_GIT_FILE_DETAILS: '1' }).gitFileDetails).toBe(true);
    expect(loadConfig({ ...env, RAROG_GIT_FILE_DETAILS: '0' }).gitFileDetails).toBe(false);
    expect(loadConfig({ ...env, RAROG_GIT_FILE_DETAILS: 'false' }).gitFileDetails).toBe(false);
    // W demo pole niesie mock (zgodny z `demoDiff`) — wyłącznik działa tak samo.
    expect(loadConfig(demoEnv).gitFileDetails).toBe(true);
    expect(loadConfig({ ...demoEnv, RAROG_GIT_FILE_DETAILS: '0' }).gitFileDetails).toBe(false);
  });

  it('RAROG_AGENT_FILES: domyślnie WŁĄCZONE, `0`/`false` wyłącza; w demo zawsze wyłączone', () => {
    // Preferencja, nie killswitch: czytnik plików subagentów niczego nie zatwierdza i nie wysyła
    // do panelu (jak `RAROG_CLI_WAITING`). `0` = agent po postoju czeka do wznowienia albo końca.
    const env = { RAROG_ORIGINS: 'https://rarog.example' };
    expect(loadConfig(env).agentFiles).toBe(true);
    expect(loadConfig({ ...env, RAROG_AGENT_FILES: '' }).agentFiles).toBe(true);
    expect(loadConfig({ ...env, RAROG_AGENT_FILES: '1' }).agentFiles).toBe(true);
    expect(loadConfig({ ...env, RAROG_AGENT_FILES: '0' }).agentFiles).toBe(false);
    expect(loadConfig({ ...env, RAROG_AGENT_FILES: 'false' }).agentFiles).toBe(false);
    // Demo nie czyta magazynu CLI na Macu, a jego sesje nie mają plików subagentów.
    expect(loadConfig(demoEnv).agentFiles).toBe(false);
    expect(loadConfig({ ...demoEnv, RAROG_AGENT_FILES: '1' }).agentFiles).toBe(false);
  });

  it('RAROG_QUEUE_ECHO: domyślnie WŁĄCZONE, `0`/`false` wyłącza; w demo zawsze wyłączone', () => {
    // Preferencja, nie killswitch: zmienia tylko chwilę, w której echo promptu wchodzi do
    // transkryptu. `0` = echo od razu.
    const env = { RAROG_ORIGINS: 'https://rarog.example' };
    expect(loadConfig(env).queueEcho).toBe(true);
    expect(loadConfig({ ...env, RAROG_QUEUE_ECHO: '' }).queueEcho).toBe(true);
    expect(loadConfig({ ...env, RAROG_QUEUE_ECHO: '1' }).queueEcho).toBe(true);
    expect(loadConfig({ ...env, RAROG_QUEUE_ECHO: '0' }).queueEcho).toBe(false);
    expect(loadConfig({ ...env, RAROG_QUEUE_ECHO: 'false' }).queueEcho).toBe(false);
    // Demo jedzie na mocku bez pliku rozmowy.
    expect(loadConfig(demoEnv).queueEcho).toBe(false);
  });

  it('RAROG_TALL_DIALOG_GUARD: domyślnie WŁĄCZONY, `0`/`false` wyłącza', () => {
    // Serwer tylko przekazuje flagę hookowi polem `tallDialogGuard` w `roots.json`; `0` = pola nie ma.
    const env = { RAROG_ORIGINS: 'https://rarog.example' };
    expect(loadConfig(env).tallDialogGuard).toBe(true);
    expect(loadConfig({ ...env, RAROG_TALL_DIALOG_GUARD: '' }).tallDialogGuard).toBe(true);
    expect(loadConfig({ ...env, RAROG_TALL_DIALOG_GUARD: '1' }).tallDialogGuard).toBe(true);
    expect(loadConfig({ ...env, RAROG_TALL_DIALOG_GUARD: '0' }).tallDialogGuard).toBe(false);
    expect(loadConfig({ ...env, RAROG_TALL_DIALOG_GUARD: 'false' }).tallDialogGuard).toBe(false);
  });

  it('RAROG_CONSENT_CHANNEL: domyślnie `all`, `off`, `shadow` i `main` dozwolone, każdy inny tryb zatrzymuje'
    + ' start', () => {
    const env = { RAROG_ORIGINS: 'https://rarog.example' };
    // Brak zmiennej albo pusta wartość = `all`: świeża instalacja z hookiem i progiem builda startuje z kanałem dla
    // wątku głównego i subagentów; bez kompletu warunków tryb efektywny i tak spada do `shadow` (`layer1/mode.ts`).
    expect(loadConfig(env).consentChannel).toBe('all');
    expect(loadConfig({ ...env, RAROG_CONSENT_CHANNEL: '' }).consentChannel).toBe('all');
    expect(loadConfig({ ...env, RAROG_CONSENT_CHANNEL: '  ' }).consentChannel).toBe('all');
    // Jawny wpis wygrywa z domyślną: instalacja z `main` albo `off` w `config.json` zostaje przy swoim trybie.
    expect(loadConfig({ ...env, RAROG_CONSENT_CHANNEL: 'off' }).consentChannel).toBe('off');
    expect(loadConfig({ ...env, RAROG_CONSENT_CHANNEL: ' shadow ' }).consentChannel).toBe('shadow');
    // `main` to tryb skonfigurowany; efektywny liczy serwer po starcie gniazd (`layer1/mode.ts`).
    expect(loadConfig({ ...env, RAROG_CONSENT_CHANNEL: 'main' }).consentChannel).toBe('main');
    // `all`: kanał także dla subagentów, ten sam tryb skonfigurowany co `main`.
    expect(loadConfig({ ...env, RAROG_CONSENT_CHANNEL: ' all ' }).consentChannel).toBe('all');
    // Literówki i tryby spoza listy: błąd startu z pełną listą, nie ciche `off`.
    for (const bad of ['ALL', 'MAIN', 'SHADOW', '1', 'on', 'wszystko']) {
      expect(() => loadConfig({ ...env, RAROG_CONSENT_CHANNEL: bad }), bad).toThrow(ConfigError);
      expect(() => loadConfig({ ...env, RAROG_CONSENT_CHANNEL: bad }), bad)
        .toThrow(`RAROG_CONSENT_CHANNEL must be one of: off, shadow, main, all (got: ${bad}).`);
    }
    // Demo nie ma hooka: zawsze `off`, także bez zmiennej (domyślne `all` go nie dotyczy); wartości z env nie czyta.
    expect(loadConfig(demoEnv).consentChannel).toBe('off');
    expect(loadConfig({ ...demoEnv, RAROG_CONSENT_CHANNEL: 'shadow' }).consentChannel).toBe('off');
    expect(loadConfig({ ...demoEnv, RAROG_CONSENT_CHANNEL: 'main' }).consentChannel).toBe('off');
    expect(loadConfig({ ...demoEnv, RAROG_CONSENT_CHANNEL: 'all' }).consentChannel).toBe('off');
  });

  it('RAROG_DIALOG_LAYER2: domyślnie wyłączona, `1` włącza, każda inna wartość zatrzymuje start', () => {
    // Nowe nazwy zmiennych: serwer czyta je tak samo jak stare.
    const env = { RAROG_ORIGINS: 'https://rarog.example' };
    expect(loadConfig(env).dialogLayer2).toBe(false);
    expect(loadConfig({ ...env, RAROG_DIALOG_LAYER2: '' }).dialogLayer2).toBe(false);
    expect(loadConfig({ ...env, RAROG_DIALOG_LAYER2: '0' }).dialogLayer2).toBe(false);
    expect(loadConfig({ ...env, RAROG_DIALOG_LAYER2: ' 1 ' }).dialogLayer2).toBe(true);
    // Literówka nie zostawia serwera po cichu w innym trybie: błąd startu z nazwą zmiennej i wartością.
    for (const bad of ['true', 'false', 'on', '2', 'yes', '01']) {
      expect(() => loadConfig({ ...env, RAROG_DIALOG_LAYER2: bad }), bad)
        .toThrow(`RAROG_DIALOG_LAYER2 takes 1 or 0 (got: ${bad}).`);
    }
    expect(() => loadConfig({ ...env, RAROG_DIALOG_LAYER2: 'on' })).toThrow(ConfigError);
    // Flaga kanału zgody jej nie zmienia i odwrotnie.
    const both = loadConfig({ ...env, RAROG_DIALOG_LAYER2: '1', RAROG_CONSENT_CHANNEL: 'shadow' });
    expect([both.dialogLayer2, both.consentChannel]).toEqual([true, 'shadow']);
  });

  it('zmienne zerowane w panelu mają default i dają się nadpisać', () => {
    expect(loadConfig(demoEnv).claudeEnvClear).toContain('CLAUDECODE');
    expect(loadConfig(demoEnv).claudeEnvClear).toContain('CLAUDE_CODE_CHILD_SESSION');
    expect(loadConfig({ ...demoEnv, RAROG_CLAUDE_ENV_CLEAR: 'A, B' }).claudeEnvClear)
      .toEqual(['A', 'B']);
  });

  it('zakres paneli domyślnie równa się korzeniom projektów', () => {
    const config = loadConfig({ ...demoEnv, RAROG_PROJECT_ROOTS: '/srv/kod,/srv/inne' });
    expect(config.herdrRoots).toEqual(['/srv/kod', '/srv/inne']);
  });

  it('RAROG_HERDR_ROOTS zawęża zakres niezależnie od korzeni projektów', () => {
    expect(parseHerdrRoots(' ~/Projects/praca ', ['/srv/kod'], HOME)).toEqual([
      path.join(HOME, 'Projects', 'praca'),
    ]);
    expect(parseHerdrRoots(undefined, ['/srv/kod'], HOME)).toEqual(['/srv/kod']);
  });

  it('gniazdo: ścieżka względna i „..” wywalają START, brak pliku NIE', () => {
    const nigdy = (): boolean | null => null;
    expect(() => parseHerdrSocket('herdr.sock', { home: HOME, isSocket: nigdy }))
      .toThrow(ConfigError);
    expect(() => parseHerdrSocket('/var/run/../etc/herdr.sock', { home: HOME, isSocket: nigdy }))
      .toThrow(ConfigError);
    // Brak pliku = baner, nie ConfigError (nigdy nieudany start przez cudzy demon).
    expect(parseHerdrSocket('/var/run/herdr.sock', { home: HOME, isSocket: nigdy }))
      .toBe('/var/run/herdr.sock');
  });

  it('gniazdo: istniejący plik, który NIE jest gniazdem, wywala start', () => {
    expect(() => parseHerdrSocket('/var/run/herdr.sock', {
      home: HOME, isSocket: () => false,
    })).toThrow(ConfigError);
    expect(parseHerdrSocket('~/gniazdo.sock', { home: HOME, isSocket: () => true }))
      .toBe(path.join(HOME, 'gniazdo.sock'));
  });

  it('RAROG_HERDR_BIN: default `~/.local/bin/herdr`, ścieżka bezwzględna bez „.."', () => {
    expect(parseHerdrBin(undefined, HOME)).toBe(expandTilde(DEFAULT_HERDR_BIN, HOME));
    expect(parseHerdrBin('~/bin/herdr', HOME)).toBe(path.join(HOME, 'bin', 'herdr'));
    // Binarkę spawnowaną z uprawnieniami użytkownika wskazujemy palcem, nie przez PATH.
    expect(() => parseHerdrBin('herdr', HOME)).toThrow(ConfigError);
    expect(() => parseHerdrBin('/usr/local/../bin/herdr', HOME)).toThrow(ConfigError);
  });

  it('stałe integracji są w KODZIE, nie w env (to bezpieczniki, nie pokrętła)', () => {
    expect(HERDR_SEND_MIN_INTERVAL_MS).toBe(1_000);
    expect(HERDR_SEND_HOURLY_CAP).toBe(240);
    expect(HERDR_ATTACH_CONCURRENCY).toBe(4);
    expect(HERDR_GIT_MIN_INTERVAL_MS).toBe(30_000);
    expect(HERDR_HISTORY_MESSAGES).toBe(500);
  });
});

/*
 * Env procesów `git` — ta sama reguła co przy PTY (`TERM_ENV_PASSTHROUGH`), `claude agents`
 * (`LIVE_SESSIONS_ENV_PASSTHROUGH`) i `tailscale` (`TAILNET_ENV_PASSTHROUGH`): lista ZAMKNIĘTA.
 * Powód nie jest teoretyczny — konfiguracja repozytorium (`core.fsmonitor`, `textconv`) wykonuje
 * się przy odczycie z tym właśnie środowiskiem.
 */
describe('gitEnvBase — sekrety Raroga nie wchodzą do procesów gita', () => {
  const ENV_SERWERA: NodeJS.ProcessEnv = {
    RAROG_ORIGINS: 'https://rarog.example',
    RAROG_IROH_KEY: SYNTETYCZNY_SEKRET,
    RAROG_AUTH_EPOCH: '4',
    SONIOX_API_KEY: 'sekret-soniox',
    // Kanał APNs: ścieżka pliku klucza i Key ID przechodzą przez `env -i` serwera.
    RAROG_APNS_KEY_PATH: '/Users/x/.secrets.d/klucz-apns',
    RAROG_APNS_KEY_ID: 'ABC123DEFG',
    HOME: '/Users/x',
    PATH: '/usr/bin',
    // Gniazdo ssh-agenta nie przechodzi: Rarog gita tylko czyta.
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    TMPDIR: '/tmp/x/',
    LANG: 'pl_PL.UTF-8',
  };

  it('przepuszcza DOKŁADNIE zamkniętą listę', () => {
    expect([...GIT_ENV_PASSTHROUGH].sort())
      .toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
    expect(Object.keys(loadConfig(ENV_SERWERA).gitEnvBase).sort())
      .toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
  });

  it('klucz iroh, klucz Soniox i wpisy klucza APNs NIE przechodzą', () => {
    const base = loadConfig(ENV_SERWERA).gitEnvBase;
    expect(Object.keys(base)).not.toContain('RAROG_IROH_KEY');
    expect(Object.keys(base)).not.toContain('RAROG_AUTH_EPOCH');
    expect(Object.keys(base)).not.toContain('SONIOX_API_KEY');
    expect(Object.keys(base).filter((k) => k.startsWith('RAROG_APNS'))).toEqual([]);
    expect(Object.values(base)).not.toContain(SYNTETYCZNY_SEKRET);
    expect(Object.values(base)).not.toContain('sekret-soniox');
    expect(Object.values(base)).not.toContain('/Users/x/.secrets.d/klucz-apns');
  });

  it('zmienne `GIT_*` przechodzą hurtem — furtka na GIT_SSH_COMMAND bez edycji kodu', () => {
    const base = parseGitEnvBase({
      ...ENV_SERWERA, GIT_SSH_COMMAND: 'ssh -i ~/.ssh/inny', GITHUB_TOKEN: 'nie-git',
    });
    expect(base['GIT_SSH_COMMAND']).toBe('ssh -i ~/.ssh/inny');
    // `GITHUB_TOKEN` nie ma prefiksu `GIT_` z podkreśleniem — nie wchodzi.
    expect(Object.keys(base)).not.toContain('GITHUB_TOKEN');
  });

  it('pusta wartość znaczy BRAK zmiennej (`env -i` przekazuje puste jawnie)', () => {
    expect(Object.keys(parseGitEnvBase({ ...ENV_SERWERA, LANG: '' })))
      .not.toContain('LANG');
  });
});
