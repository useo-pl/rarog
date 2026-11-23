/**
 * Zabezpieczenie z `vitest.config.ts`: testy nie dziedziczą zmiennych gita, które wskazują repozytorium (lista
 * i powód: `server/test/helpers/git-repo-env.ts`).
 *
 * Dowód: vitest w podprocesie, z konfiguracją repo i w obu pulach (forks, threads), dostaje w środowisku każdą
 * zmienną z listy, a każda wskazuje repo-atrapę albo ścieżkę w katalogu tymczasowym (`GIT_DIR` jak z
 * `git rebase --exec`). Ten sam plik w trybie sondy (`RAROG_GIT_REPO_ENV_SONDA`) zapisuje nazwy `GIT_*` widziane przez
 * proces roboczy i przez `bash` pod nim, a `bash` zakłada w innym katalogu tymczasowym repo z commitem przez
 * `git -C`. Atrapa ma zostać nietknięta, a zmienne konfiguracji i autora mają przejść.
 *
 * Test nie dotyka prawdziwego repo nawet przy porażce: własne wywołania gita biorą środowisko złożone od zera,
 * a podproces vitest środowisko od zera z wartościami atrapy, więc `GIT_DIR` z zewnątrz do niego nie dociera.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { GIT_REPO_ENV_VARS } from './helpers/git-repo-env.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = path.relative(REPO, fileURLToPath(import.meta.url));
const SONDA = process.env.RAROG_GIT_REPO_ENV_SONDA;

/** Sonda w `bash`: nazwy eksportowanych zmiennych do pliku, potem repo z commitem przez `git -C`. */
const SONDA_BASH = [
  'set -eu',
  'compgen -e > "$1/bash-env.txt"',
  'mkdir "$1/inny"',
  'git -C "$1/inny" init -q',
  'git -C "$1/inny" -c user.name=sonda -c user.email=sonda@example.invalid -c commit.gpgsign=false'
    + ' commit -q --allow-empty -m sonda',
].join('\n');

if (SONDA !== undefined) {
  it('sonda: zmienne GIT_* procesu roboczego i bash, repo obok przez git -C', () => {
    const names = Object.keys(process.env).filter((name) => name.startsWith('GIT_')).sort();
    writeFileSync(path.join(SONDA, 'proces-env.json'), JSON.stringify(names));
    const bash = spawnSync('bash', ['-c', SONDA_BASH, 'bash', SONDA], { encoding: 'utf8' });
    expect(bash.status, bash.stderr).toBe(0);
  });
} else {
  /** Minimum z incydentu, wpisane niezależnie od listy, żeby jej okrojenie nie osłabiło testu. */
  const MINIMUM = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];
  /** Zmienne z `git rev-parse --local-env-vars`, które zostają: konfiguracja i zachowanie, nie miejsce repo. */
  const KEPT_FROM_GIT_LIST = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_NO_REPLACE_OBJECTS',
    'GIT_REPLACE_REF_BASE'];

  const temporary: string[] = [];
  afterAll(() => {
    for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = (label: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), `rarog-git-repo-env-${label}-`));
    temporary.push(dir);
    return dir;
  };

  /** Git testu: środowisko od zera, bez dziedziczenia, więc żaden `GIT_DIR` z zewnątrz go nie przestawi. */
  const cleanGit = (args: string[], cwd: string): string => {
    const res = spawnSync('git', args, {
      cwd, encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };

  /** Ścieżki i skróty treści plików pod `dir` (bez `skip`), posortowane. */
  const snapshot = (dir: string, skip: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        const rel = path.relative(dir, full);
        if (rel === skip || rel.startsWith(`${skip}${path.sep}`)) return null;
        if (!entry.isFile()) return `${rel}/`;
        return `${rel} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
      })
      .filter((line): line is string => line !== null)
      .sort();

  const vitestPackage = createRequire(import.meta.url).resolve('vitest/package.json');
  const vitestBin = path.join(path.dirname(vitestPackage), 'vitest.mjs');

  describe('testy nie dziedziczą zmiennych gita wskazujących repozytorium (vitest.config.ts)', () => {
    it('lista: minimum z incydentu, bez konfiguracji i autora, pokrywa `git rev-parse --local-env-vars`', () => {
      expect(GIT_REPO_ENV_VARS).toEqual(expect.arrayContaining(MINIMUM));
      const configOrAuthor = /^GIT_(CONFIG_|AUTHOR_|COMMITTER_)|^GIT_CEILING_DIRECTORIES$/u;
      expect(GIT_REPO_ENV_VARS.filter((name) => configOrAuthor.test(name))).toEqual([]);
      const local = cleanGit(['rev-parse', '--local-env-vars'], tempDir('lista')).split('\n').filter(Boolean);
      expect(local).toContain('GIT_DIR');
      const known: readonly string[] = [...GIT_REPO_ENV_VARS, ...KEPT_FROM_GIT_LIST];
      expect(local.filter((name) => !known.includes(name)), 'nowa zmienna gita: dopisz do listy albo do zostających')
        .toEqual([]);
    });

    it.each(['forks', 'threads'])(
      'pula %s: sonda nie widzi zmiennych, `git -C` zakłada repo obok, atrapa nietknięta, konfiguracja przechodzi',
      (pool) => {
        const tmp = tempDir(pool);
        const atrapa = path.join(tmp, 'atrapa');
        const sonda = path.join(tmp, 'sonda');
        for (const dir of [path.join(tmp, 'atrapa-wt'), path.join(tmp, 'zmienne'), path.join(sonda, 'home')]) {
          mkdirSync(dir, { recursive: true });
        }
        cleanGit(['init', '--bare', '-q', atrapa], tmp);

        // Każda zmienna wskazuje miejsce w `tmp`; główne mają wartości, które git przyjmuje, więc bez
        // zabezpieczenia git sondy pisze do atrapy (jak w incydencie), a nie kończy na błędzie składni wartości.
        const repoEnv: Record<string, string> = {};
        for (const name of new Set([...MINIMUM, ...GIT_REPO_ENV_VARS])) {
          repoEnv[name] = path.join(tmp, 'zmienne', name);
        }
        Object.assign(repoEnv, {
          GIT_DIR: atrapa, GIT_COMMON_DIR: atrapa, GIT_OBJECT_DIRECTORY: path.join(atrapa, 'objects'),
          GIT_WORK_TREE: path.join(tmp, 'atrapa-wt'), GIT_IMPLICIT_WORK_TREE: '1', GIT_NAMESPACE: 'atrapa',
          GIT_REFERENCE_BACKEND: 'files', GIT_PREFIX: '',
        });
        const keptEnv = {
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'rarog.sonda', GIT_CONFIG_VALUE_0: 'zostaje', GIT_AUTHOR_NAME: 'Autor Sondy',
          GIT_CEILING_DIRECTORIES: tmp,
        };
        const before = snapshot(tmp, 'sonda');

        const res = spawnSync(process.execPath, [vitestBin, 'run', SELF, `--pool=${pool}`], {
          cwd: REPO, encoding: 'utf8', timeout: 120_000,
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
            HOME: path.join(sonda, 'home'), NO_COLOR: '1', RAROG_GIT_REPO_ENV_SONDA: sonda, ...keptEnv, ...repoEnv,
          },
        });
        const output = `${res.stdout}\n${res.stderr}`;

        const processFile = path.join(sonda, 'proces-env.json');
        const bashFile = path.join(sonda, 'bash-env.txt');
        expect(existsSync(processFile) && existsSync(bashFile), output).toBe(true);
        const inProcess = JSON.parse(readFileSync(processFile, 'utf8')) as string[];
        const inBash = readFileSync(bashFile, 'utf8').split('\n').filter((name) => name.startsWith('GIT_'));
        // `soft`: przy porażce raport pokazuje naraz, które zmienne przeszły i czy git sondy dotknął atrapy.
        expect.soft(inProcess.filter((name) => Object.hasOwn(repoEnv, name)), 'proces roboczy').toEqual([]);
        expect.soft(inBash.filter((name) => Object.hasOwn(repoEnv, name)), 'bash pod procesem roboczym').toEqual([]);
        expect.soft(inProcess, 'konfiguracja i autor w procesie roboczym')
          .toEqual(expect.arrayContaining(Object.keys(keptEnv)));
        expect.soft(inBash, 'konfiguracja i autor w bash').toEqual(expect.arrayContaining(Object.keys(keptEnv)));
        expect.soft(snapshot(tmp, 'sonda'), 'atrapa i ścieżki zmiennych nietknięte').toEqual(before);
        expect(res.status, output).toBe(0);

        const inny = path.join(sonda, 'inny');
        expect(cleanGit(['-C', inny, 'rev-parse', '--absolute-git-dir'], tmp))
          .toBe(realpathSync(path.join(inny, '.git')));
        expect(cleanGit(['-C', inny, 'log', '-1', '--format=%an|%cn|%s'], tmp)).toBe('Autor Sondy|sonda|sonda');
      },
      240_000,
    );
  });
}
