/*
 * `scripts/ios-demo.sh` — serwer demo dla XCUITest apki natywnej (`scripts/ios-check.sh`).
 *
 * Testujemy ZACHOWANIE biblioteki (źródłowanej przez bash), bez Xcode i bez serwera Raroga:
 * - port zajęty przez usługę, która NIE mówi HTTP, też jest zajęty (sam `curl`
 *   tego nie wykrywa, a sprzątanie zabiłoby potem obcy proces);
 * - serwer startuje w `env -i` z jawną listą — odziedziczony `RAROG_AUTH_TOKEN` (nazwa spoza rejestru)
 *   i `RAROG_MIN_CLIENT_BUILD` nie przechodzą, tryb demo i adresy są jawne, a treść demo jest przypięta na polski
 *   (`RAROG_DEMO_LANG=pl`; domyślnie `en`, a XCUITest szuka polskich tekstów seedów);
 * - sprzątanie zatrzymuje WYŁĄCZNIE drzewo procesów, które wystartowało, a obcy proces
 *   słuchający na porcie żyje dalej.
 *
 * Lint tego pliku jedzie w `pnpm run check` (glob `scripts/*.sh`), nie tutaj.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = path.join(repoRoot, 'scripts/ios-demo.sh');
/** `ios_demo_port_busy` pyta `lsof`: na macOS jest zawsze, obraz Linuksa (CI) bywa bez niego. */
const HAS_LSOF = spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;

function bash(script: string, env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string } {
  const res = spawnSync('bash', ['-c', `source "${LIB}"\n${script}`], { encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

/** Katalogi tymczasowe założone przez ten plik: `afterAll` kasuje je i sprawdza, że żaden nie został w `$TMPDIR`. */
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  expect(tempDirs.filter((dir) => existsSync(dir))).toEqual([]);
});

describe('ios-demo.sh — zajętość portu niezależnie od protokołu', () => {
  it.skipIf(!HAS_LSOF)('usługa nie-HTTP na porcie = zajęty; po jej zamknięciu wolny (requires lsof)', async () => {
    // Surowy TCP, który od razu zamyka połączenie: `curl` nie dostałby od niego odpowiedzi HTTP.
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    expect(bash(`ios_demo_port_busy ${port}`).status).toBe(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(bash(`ios_demo_port_busy ${port}`).status).toBe(1);
  });
});

describe('ios-demo.sh — kontrolowane środowisko serwera', () => {
  it('odziedziczony token i próg builda nie przechodzą; tryb demo, język treści pl i adresy są jawne', async () => {
    const dir = tempDir('rarog-ios-demo-');
    const log = path.join(dir, 'env.log');
    const env = {
      ...process.env, RAROG_AUTH_TOKEN: 'odziedziczony-sekret', RAROG_MIN_CLIENT_BUILD: '999', OBCA: 'x',
      RAROG_DEMO_LANG: 'en',
    };
    bash(`ios_demo_start 18999 "${dir}" "${log}" env\nwait "$IOS_DEMO_PID"`, env);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const vars = Object.fromEntries(lines.map((line) => [line.split('=')[0], line.slice(line.indexOf('=') + 1)]));
    expect(vars['RAROG_AUTH_TOKEN']).toBeUndefined();
    expect(vars['RAROG_MIN_CLIENT_BUILD']).toBeUndefined();
    expect(vars['OBCA']).toBeUndefined();
    expect(vars['RAROG_DEMO']).toBe('1');
    expect(vars['RAROG_DEMO_LANG']).toBe('pl');
    expect(vars['RAROG_PORT']).toBe('18999');
    expect(vars['RAROG_ORIGINS']).toBe('http://127.0.0.1:18999');
    expect(vars['RAROG_DATA_DIR']).toBe(dir);
    expect(Object.keys(vars).sort()).toEqual(
      ['HOME', 'LANG', 'PATH', 'RAROG_DATA_DIR', 'RAROG_DEMO', 'RAROG_DEMO_LANG', 'RAROG_ORIGINS', 'RAROG_PORT', 'TMPDIR'],
    );
  });

  /** `env` uruchomione przez `ios_demo_start` z podanymi opcjami: zmienne, które dostał serwer. */
  function serverEnv(options: string, env: NodeJS.ProcessEnv): Record<string, string> {
    const dir = tempDir('rarog-ios-demo-');
    const log = path.join(dir, 'env.log');
    bash(`ios_demo_start ${options} 18999 "${dir}" "${log}" env\nwait "$IOS_DEMO_PID"`, env);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    return Object.fromEntries(lines.map((line) => [line.split('=')[0]!, line.slice(line.indexOf('=') + 1)]));
  }

  it('odziedziczone RAROG_DEMO_CONTENT nie przechodzi; bez opcji dalej pl i bez zestawu', () => {
    const vars = serverEnv('', { ...process.env, RAROG_DEMO_CONTENT: 'sample', RAROG_DEMO_LANG: 'en' });
    expect(vars['RAROG_DEMO_LANG']).toBe('pl');
    expect(vars['RAROG_DEMO_CONTENT']).toBeUndefined();
  });

  it('--lang en --content sample: serwer dostaje RAROG_DEMO_LANG=en i RAROG_DEMO_CONTENT=sample, reszta bez zmian',
    () => {
      const vars = serverEnv('--lang en --content sample', { ...process.env, OBCA: 'x' });
      expect(vars['RAROG_DEMO_LANG']).toBe('en');
      expect(vars['RAROG_DEMO_CONTENT']).toBe('sample');
      expect(vars['RAROG_PORT']).toBe('18999');
      expect(Object.keys(vars).sort()).toEqual([
        'HOME', 'LANG', 'PATH', 'RAROG_DATA_DIR', 'RAROG_DEMO', 'RAROG_DEMO_CONTENT', 'RAROG_DEMO_LANG',
        'RAROG_ORIGINS', 'RAROG_PORT', 'TMPDIR',
      ]);
    });

  it('samo --lang en: język bez zestawu treści', () => {
    const vars = serverEnv('--lang en', process.env);
    expect(vars['RAROG_DEMO_LANG']).toBe('en');
    expect(vars['RAROG_DEMO_CONTENT']).toBeUndefined();
  });
});

describe('ios-demo.sh — sprzątanie tylko własnego drzewa procesów', () => {
  it('zabija proces i jego potomków, a obcy proces na porcie żyje dalej', async () => {
    // Obcy proces słuchający na porcie — dawne `lsof … | xargs kill` by go zabiło.
    const stranger = spawn(process.execPath, ['-e', "require('net').createServer().listen(0, '127.0.0.1'); setInterval(() => {}, 1000)"], {
      stdio: 'ignore',
    });
    cleanup.push(() => stranger.kill('SIGKILL'));
    // Własne drzewo: bash → (sleep, bash → sleep), jak pnpm → tsx → node.
    const tree = spawn('bash', ['-c', 'sleep 60 & bash -c "sleep 60 & wait" & wait'], { stdio: 'ignore' });
    const root = tree.pid as number;
    cleanup.push(() => tree.kill('SIGKILL'));
    const descendants = (): number[] => {
      const all: number[] = [];
      const walk = (pid: number): void => {
        const res = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
        for (const child of res.stdout.split('\n').filter((x) => x !== '').map(Number)) {
          all.push(child);
          walk(child);
        }
      };
      walk(root);
      return all;
    };
    // sleep + bash pośredni + jego sleep.
    expect(await waitFor(() => descendants().length >= 3)).toBe(true);
    const members = [root, ...descendants()];
    bash(`ios_demo_kill_tree ${root}`);
    expect(await waitFor(() => members.every((pid) => !alive(pid)))).toBe(true);
    expect(alive(stranger.pid as number)).toBe(true);
  });
});
