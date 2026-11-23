/**
 * Proces serwera z nasłuchem iroh: prawdziwy `server/src/index.ts` w podprocesie,
 * biblioteka iroh podmieniona hakiem `resolve` (`helpers/iroh-podmiana.mjs`).
 * - Bez flagi serwer wstaje, choć paczki „nie ma na dysku”: nic jej nie ładuje (`startIroh` nie jest wołane), a gniazdo
 *   administracyjne mówi `enabled: false` i kod parowania bez `iroh`.
 * - Z flagą bez paczki albo bez klucza: zdanie na stderr i kod 1, bez klucza w treści.
 * - SIGTERM, gdy `Endpoint.close()` trwa 4 s albo wisi: nasłuch oddaje zamknięcie po swoim terminie 3 s, bezpiecznik
 *   2 s rusza dopiero po nim, proces kończy się kodem 0 w ≤ 5 s od sygnału (z zapasem na planistę systemu).
 * - Linie logu mają czas na początku, więc wzorzec linii `iroh:` dopuszcza prefiks; test z flagą sprawdza, że
 *   łapie żywą linię.
 * Port 0 i wyłączone kanały: serwer nie zderza się z produkcją na 8930, nie zakłada paneli i nie pushuje.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { IROH_LISTENING_LOG } from '../src/iroh/listener.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SWAP = path.join(REPO, 'server/test/helpers/iroh-podmiana.mjs');
const RELAY = 'https://relay.example./';

/** `tsx` z najbliższego `node_modules` w górę drzewa — worktree bywa bez własnego. */
function findTsx(): string {
  let dir = REPO;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('brak node_modules/.bin/tsx');
}

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

interface Running {
  readonly child: ChildProcess;
  readonly dataDir: string;
  output(): string;
  waitFor(pattern: RegExp, ms?: number): Promise<void>;
  readonly exited: Promise<{ code: number | null; at: number }>;
}

function startServer(env: Record<string, string>): Running {
  const home = mkdtempSync(path.join(os.tmpdir(), 'iroh-proc-'));
  temporary.push(home);
  const dataDir = path.join(home, 'dane');
  const child = spawn(findTsx(), ['server/src/index.ts'], {
    cwd: REPO,
    env: {
      PATH: process.env['PATH'] ?? '', HOME: home, TMPDIR: os.tmpdir(), RAROG_DATA_DIR: dataDir,
      RAROG_PORT: '0', RAROG_HERDR_SEND: '0', RAROG_HERDR_LAUNCH: '0', RAROG_PUSH: '0', RAROG_TERM: '0',
      NODE_OPTIONS: `--import=${SWAP}`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  const append = (chunk: Buffer): void => { text += chunk.toString('utf8'); };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const killer = setTimeout(() => { child.kill('SIGKILL'); }, 40_000);
  const exited = new Promise<{ code: number | null; at: number }>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, at: performance.now() });
    });
  });
  return {
    child,
    dataDir,
    output: () => text,
    exited,
    async waitFor(pattern, ms = 20_000) {
      const end = performance.now() + ms;
      while (!pattern.test(text)) {
        if (child.exitCode !== null || performance.now() > end) throw new Error(`brak ${String(pattern)} w:\n${text}`);
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
    },
  };
}

/** Żądanie do gniazda administracyjnego serwera (`<dataDir>/run/admin.sock`). */
function admin(dataDir: string, method: string, route: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dataDir, 'run', 'admin.sock'), path: route, method }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { parts.push(chunk); });
      res.on('end', () => { resolve(JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>); });
    });
    req.on('error', reject);
    req.end();
  });
}

const irohEnv = (key: string): Record<string, string> => ({ RAROG_IROH: '1', RAROG_IROH_KEY: key, RAROG_IROH_RELAY: RELAY });

/** Linia `iroh:` logu serwera: po czasie z prefiksu albo bez niego, gdy zapis prefiksu nie ma. */
const IROH_LINE = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z )?iroh:/mu;

describe('proces serwera: flaga iroh wyłączona', () => {
  it('start bez paczki na dysku: serwer słucha, gniazdo administracyjne mówi `enabled: false`, SIGTERM = kod 0', async () => {
    const server = startServer({ RAROG_TEST_IROH_SWAP: 'brak', RAROG_ORIGINS: 'https://rarog.example' });
    await server.waitFor(/admin: admin socket/);
    expect(server.output()).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+/);
    expect(server.output()).not.toMatch(IROH_LINE);
    expect(await admin(server.dataDir, 'GET', '/api/admin/iroh')).toMatchObject({ enabled: false });
    const issued = await admin(server.dataDir, 'POST', '/api/admin/pairings');
    expect(issued).toMatchObject({ iroh: null, url: 'https://rarog.example' });
    server.child.kill('SIGTERM');
    expect((await server.exited).code).toBe(0);
  }, 45_000);
});

describe('proces serwera: flaga iroh włączona', () => {
  it('bez paczki: kod 1 i zdanie o module natywnym, przed nasłuchem HTTP', async () => {
    const key = randomBytes(32).toString('hex');
    const server = startServer({ RAROG_TEST_IROH_SWAP: 'brak', ...irohEnv(key) });
    expect((await server.exited).code).toBe(1);
    expect(server.output()).toMatch(/Could not start: no native iroh module for [\w-]+ \(package .+ is not installed\); set RAROG_IROH=0/);
    expect(server.output()).not.toContain('listening on');
    expect(server.output()).not.toContain(key);
  }, 45_000);

  it('bez klucza: kod 1 i błąd konfiguracji z drogą klucza', async () => {
    const server = startServer({ RAROG_TEST_IROH_SWAP: 'atrapa', RAROG_IROH: '1', RAROG_IROH_RELAY: RELAY });
    expect((await server.exited).code).toBe(1);
    expect(server.output()).toContain('Configuration error: RAROG_IROH=1 without RAROG_IROH_KEY');
    expect(server.output()).not.toContain('listening on');
  }, 45_000);

  for (const close of ['4000', 'wisi']) {
    it(`SIGTERM przy \`Endpoint.close()\` ${close === 'wisi' ? 'bez końca' : 'trwającym 4 s'}: kod 0 w ≤ 5 s, bezpiecznik po terminie nasłuchu`, async () => {
      const key = randomBytes(32).toString('hex');
      const server = startServer({ RAROG_TEST_IROH_SWAP: 'atrapa', RAROG_TEST_IROH_CLOSE_MS: close, ...irohEnv(key) });
      await server.waitFor(/admin: admin socket/);
      const status = await admin(server.dataDir, 'GET', '/api/admin/iroh');
      expect(status).toMatchObject({ enabled: true, relay: RELAY, port: null, homeRelay: { relays: [], since: null } });
      const endpointId = status['endpointId'];
      expect(endpointId).toMatch(/^[0-9a-f]{64}$/);
      expect(await admin(server.dataDir, 'POST', '/api/admin/pairings')).toMatchObject({
        url: null, iroh: { endpointId, relay: RELAY },
      });
      expect(server.output()).toContain(`${IROH_LISTENING_LOG} (EndpointId ${String(endpointId)}, relay ${RELAY}`);
      // Strażnik wzorca z pierwszego testu: ten sam `IROH_LINE` łapie żywą linię `iroh:` (z czasem), więc tam nie
      // przechodzi pusto.
      expect(server.output()).toMatch(IROH_LINE);
      expect(server.output()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z iroh:/mu);

      const signalled = performance.now();
      server.child.kill('SIGTERM');
      const { code, at } = await server.exited;
      const elapsed = at - signalled;
      expect(code).toBe(0);
      // Termin `Endpoint.close()` 3 s + bezpiecznik 2 s; przed 3 s + 2 s znaczyłoby bezpiecznik od sygnału.
      expect(elapsed).toBeGreaterThanOrEqual(4_900);
      expect(elapsed).toBeLessThan(5_600);
      expect(server.output()).toContain('iroh: Endpoint.close() timed out after 3000 ms');
      if (close === '4000') expect(server.output()).toContain('iroh: endpoint closed');
      expect(server.output()).not.toContain(key);
    }, 45_000);
  }
});
