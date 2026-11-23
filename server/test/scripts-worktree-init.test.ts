/*
 * `scripts/worktree-init.sh`: one command makes a linked worktree ready (store linked to the main checkout's pnpm
 * store, dependencies installed offline). The cases run on a throwaway repository with a fake `pnpm` on PATH that
 * logs its calls, so they need neither this repository's history nor its installed store.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts', 'worktree-init.sh');

/** Environment without a pnpm store variable: the script must work without one. */
function cleanEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(pnpm|npm)_config_store_dir$/i.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-C', cwd, '-c', 'user.name=Rarog', '-c', 'user.email=rarog@example.com', '-c', 'commit.gpgsign=false', ...args,
  ], { encoding: 'utf8' });
}

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Atrapa {
  readonly main: string;
  readonly wt: string;
  readonly log: string;
  readonly run: (cwd: string) => ReturnType<typeof spawnSync>;
  readonly calls: () => string[];
}

/** Main checkout with a store holding `v11`, a linked worktree and a fake `pnpm` that logs `cwd|args|store var`. */
function atrapa(): Atrapa {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'worktree-init-')));
  made.push(root);
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'pnpm.log');
  mkdirSync(main);
  git(main, 'init', '-q');
  writeFileSync(path.join(main, 'pnpm-workspace.yaml'), 'packages:\n  - server\n\nstoreDir: .pnpm-store\n');
  writeFileSync(path.join(main, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(main, '.gitignore'), 'node_modules\n.pnpm-store/\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  mkdirSync(path.join(main, '.pnpm-store', 'v11'), { recursive: true });
  writeFileSync(path.join(main, '.pnpm-store', 'v11', 'index'), 'store\n');
  git(main, 'worktree', 'add', '-q', '--detach', wt);
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'pnpm'), [
    '#!/bin/sh',
    'printf \'%s|%s|store=%s\\n\' "$PWD" "$*" "${pnpm_config_store_dir:-}" >> "$PNPM_LOG"',
    'if [ "$1" = install ]; then mkdir -p node_modules/.pnpm && cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml; fi',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(log, '');
  return {
    main, wt, log,
    run: (cwd) => spawnSync('bash', [SCRIPT], {
      cwd, encoding: 'utf8',
      // The caller's store variable must not leak into the install (the script removes it).
      env: {
        ...cleanEnv(), PATH: `${bin}:${process.env.PATH ?? ''}`, PNPM_LOG: log, pnpm_config_store_dir: '/elsewhere',
      },
    }),
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

describe('scripts/worktree-init.sh (atrapa pnpm)', { timeout: 60_000 }, () => {
  it('worktree bez node_modules: magazyn podlinkowany do magazynu repo, instalacja offline z lockfile', () => {
    const a = atrapa();
    const res = a.run(a.wt);
    expect(res.status, String(res.stderr)).toBe(0);
    expect(a.calls()).toEqual([`${a.wt}|install --offline --frozen-lockfile|store=`]);
    // The store directory stays a real directory (ignored by `.pnpm-store/`), its entry links to the main store.
    expect(lstatSync(path.join(a.wt, '.pnpm-store')).isDirectory()).toBe(true);
    expect(readlinkSync(path.join(a.wt, '.pnpm-store', 'v11'))).toBe(path.join(a.main, '.pnpm-store', 'v11'));
    expect(git(a.wt, 'status', '--porcelain')).toBe('');
    expect(String(res.stdout)).toMatch(/ready\n$/);
  });

  it('drugi przebieg nic nie zmienia i nie woła pnpm', () => {
    const a = atrapa();
    expect(a.run(a.wt).status).toBe(0);
    const lockBefore = lstatSync(path.join(a.wt, 'node_modules', '.pnpm', 'lock.yaml')).mtimeMs;
    const res = a.run(a.wt);
    expect(res.status, String(res.stderr)).toBe(0);
    expect(String(res.stdout)).toBe('worktree-init: already set up; nothing changed\n');
    expect(a.calls()).toHaveLength(1);
    expect(lstatSync(path.join(a.wt, 'node_modules', '.pnpm', 'lock.yaml')).mtimeMs).toBe(lockBefore);
  });

  it('lockfile inny niż zainstalowany: instalacja jeszcze raz', () => {
    const a = atrapa();
    expect(a.run(a.wt).status).toBe(0);
    appendFileSync(path.join(a.wt, 'pnpm-lock.yaml'), '\n');
    const res = a.run(a.wt);
    expect(res.status, String(res.stderr)).toBe(0);
    expect(a.calls()).toHaveLength(2);
  });

  it('w głównym checkoucie: nic do zrobienia, bez pnpm', () => {
    const a = atrapa();
    const res = a.run(a.main);
    expect(res.status, String(res.stderr)).toBe(0);
    expect(String(res.stdout)).toMatch(/is the main checkout, not a linked worktree; nothing to do/);
    expect(a.calls()).toEqual([]);
    expect(existsSync(path.join(a.main, 'node_modules'))).toBe(false);
  });

  it('własny magazyn w worktree (katalog, nie link): odmowa bez zmian i bez pnpm', () => {
    const a = atrapa();
    mkdirSync(path.join(a.wt, '.pnpm-store', 'v11'), { recursive: true });
    writeFileSync(path.join(a.wt, '.pnpm-store', 'v11', 'own'), 'x');
    const res = a.run(a.wt);
    expect(res.status).toBe(1);
    expect(String(res.stderr)).toMatch(/exists and is not a link to the main store; move it out of the worktree/);
    expect(readFileSync(path.join(a.wt, '.pnpm-store', 'v11', 'own'), 'utf8')).toBe('x');
    expect(a.calls()).toEqual([]);
  });

  it('pusty magazyn głównego checkoutu: odmowa z poleceniem instalacji w głównym checkoucie', () => {
    const a = atrapa();
    rmSync(path.join(a.main, '.pnpm-store', 'v11'), { recursive: true });
    const res = a.run(a.wt);
    expect(res.status).toBe(1);
    expect(String(res.stderr)).toContain(`is empty; run pnpm install in ${a.main} first`);
    expect(a.calls()).toEqual([]);
  });

  it('poza repozytorium git: odmowa', () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'worktree-init-norepo-')));
    made.push(dir);
    const res = spawnSync('bash', [SCRIPT], {
      cwd: dir, encoding: 'utf8', env: { ...cleanEnv(), GIT_CEILING_DIRECTORIES: path.dirname(dir) },
    });
    expect(res.status).toBe(1);
    expect(String(res.stderr)).toMatch(/not inside a git repository/);
  });
});
