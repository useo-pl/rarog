/**
 * Adapter haka `relay-vps/access-adapter.mjs`: prawdziwy proces adaptera przed atrapą Workera (`fake-worker.mjs`).
 * Termin decyzji w testach 400 ms (na VPS 3000 ms), cache ujemny 600 ms (na VPS 15 s): te same ścieżki kodu,
 * krótszy czas. Iroh-relay traktuje każdą odpowiedź inną niż 200 `true` jako odmowę, więc adapter ma oddać 403
 * wyłącznie przy jawnej odmowie Workera, a 200 `true` przy każdej awarii (fail-open).
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countUnauthorized } from '../relay-watch.mjs';
import { startFakeWorker } from './fake-worker.mjs';
import type { FakeMode, FakeWorker } from './fake-worker.mjs';

const ADAPTER = path.resolve(import.meta.dirname, '..', 'access-adapter.mjs');
const DEADLINE_MS = 400;
const NEG_TTL_MS = 600;
const BEARER = 'TEST-ONLY-bearer';
const ID = 'ab'.repeat(32);
const ID2 = 'cd'.repeat(32);

interface Adapter {
  readonly port: number;
  readonly lines: string[];
  readonly proc: ChildProcessWithoutNullStreams;
}

const running: ChildProcessWithoutNullStreams[] = [];
const workers: FakeWorker[] = [];
afterEach(async () => {
  for (const proc of running.splice(0)) proc.kill('SIGKILL');
  await Promise.all(workers.splice(0).map((w) => w.close()));
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startAdapter(workerUrl: string, extra: Record<string, string> = {}): Promise<Adapter> {
  const proc = spawn(process.execPath, [ADAPTER], {
    env: { PATH: process.env.PATH ?? '', WORKER_URL: workerUrl, ADAPTER_PORT: '0',
      ADAPTER_DEADLINE_MS: String(DEADLINE_MS), ADAPTER_NEG_TTL_MS: String(NEG_TTL_MS), ...extra },
  });
  running.push(proc);
  const lines: string[] = [];
  let rest = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    rest += chunk;
    const parts = rest.split('\n');
    rest = parts.pop() ?? '';
    lines.push(...parts);
  });
  for (let i = 0; i < 100; i++) {
    const listen = lines.map((line) => / event=listen addr=127\.0\.0\.1:(\d+) /.exec(line)).find((m) => m !== null);
    if (listen) return { port: Number(listen[1]), lines, proc };
    await sleep(20);
  }
  throw new Error(`adapter nie wystartował: ${lines.join('\n')}`);
}

async function worker(mode: FakeMode): Promise<FakeWorker> {
  const w = await startFakeWorker({ bearer: BEARER, mode, gapMs: 150 });
  workers.push(w);
  return w;
}

async function ask(adapter: Adapter, id = ID, headers: Record<string, string> = { authorization: `Bearer ${BEARER}` }):
  Promise<{ status: number; body: string; ms: number; log: string }> {
  const before = adapter.lines.length;
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${String(adapter.port)}/v1/access`, {
    method: 'POST', headers: { 'x-iroh-endpoint-id': id, ...headers },
  });
  const body = await res.text();
  const ms = performance.now() - t0;
  for (let i = 0; i < 50 && adapter.lines.length === before; i++) await sleep(10);
  return { status: res.status, body, ms, log: adapter.lines.slice(before).join('\n') };
}

describe('access-adapter.mjs: odpowiedzi Workera', () => {
  it('200 `true` = zgoda Workera; adapter przekazuje bearer relaya i EndpointId', async () => {
    const w = await worker('shadow');
    const a = await startAdapter(w.url);
    const res = await ask(a);
    expect(res).toMatchObject({ status: 200, body: 'true' });
    expect(res.log).toMatch(/decision=allow src=worker id=abababab.. ms=[\d.]+ why=200/);
    expect(w.state.last?.authorization).toBe(`Bearer ${BEARER}`);
    expect(w.state.last?.['x-iroh-endpoint-id']).toBe(ID);
  });

  it('403 `false` = jedyna odmowa; log ma skrót EndpointId, nie pełny', async () => {
    const w = await worker('enforce');
    const a = await startAdapter(w.url);
    const res = await ask(a);
    expect(res).toMatchObject({ status: 403, body: 'false' });
    expect(res.log).toMatch(/decision=deny src=worker id=abababab.. /);
    expect(a.lines.join('\n')).not.toContain(ID);
  });

  it('cache ujemny: odmowa trzyma się NEG_TTL bez pytania Workera, zgody adapter nie pamięta', async () => {
    const w = await worker('enforce');
    const a = await startAdapter(w.url);
    expect((await ask(a)).status).toBe(403);
    const second = await ask(a);
    expect(second.status).toBe(403);
    expect(second.log).toContain('src=cache');
    expect(w.state.requests).toBe(1);
    w.state.allow.add(ID);
    await sleep(NEG_TTL_MS + 50);
    expect((await ask(a)).status).toBe(200);
    expect((await ask(a)).status).toBe(200);
    expect(w.state.requests).toBe(3);
  });

  it('cache ujemny jest per EndpointId', async () => {
    const w = await worker('enforce');
    w.state.allow.add(ID2);
    const a = await startAdapter(w.url);
    expect((await ask(a, ID)).status).toBe(403);
    expect((await ask(a, ID2)).status).toBe(200);
  });

  const failopen: [FakeMode, RegExp][] = [
    ['500', /why=status:500:body:"boom"/],
    ['401', /why=status:401:body:"bearer"/],
    ['bad-body', /why=status:200:body:"yes"/],
    ['deny-bad', /why=status:403:body:"nope"/],
    ['big-body', /why=status:200:body>16B/],
    ['partial-close', /why=status:200:body:/],
  ];
  it.each(failopen)('Worker `%s`: fail-open od razu (200 `true`)', async (mode, why) => {
    const w = await worker(mode);
    const a = await startAdapter(w.url);
    const res = await ask(a);
    expect(res).toMatchObject({ status: 200, body: 'true' });
    expect(res.log).toMatch(/decision=allow src=failopen /);
    expect(res.log).toMatch(why);
    expect(res.ms).toBeLessThan(DEADLINE_MS);
  });

  const slow: FakeMode[] = ['hang', 'slow-headers', 'slow-body', 'partial'];
  it.each(slow)('Worker `%s`: fail-open w terminie decyzji (200 `true` po ok. ADAPTER_DEADLINE_MS)', async (mode) => {
    const w = await worker(mode);
    const a = await startAdapter(w.url);
    const res = await ask(a);
    expect(res).toMatchObject({ status: 200, body: 'true' });
    expect(res.log).toMatch(/decision=allow src=failopen .*why=(fetch|status:200:body):TimeoutError/);
    expect(res.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
    expect(res.ms).toBeLessThan(DEADLINE_MS + 500);
  });

  it('Worker nieosiągalny (port zamknięty): fail-open od razu', async () => {
    const w = await worker('shadow');
    const url = w.url;
    await w.close();
    workers.splice(0);
    const a = await startAdapter(url);
    const res = await ask(a);
    expect(res).toMatchObject({ status: 200, body: 'true' });
    expect(res.log).toMatch(/src=failopen .*why=fetch:TypeError:ECONNREFUSED/);
  });

  it('zły bearer (Worker 401) daje linię, którą liczy relay-watch.mjs', async () => {
    const w = await worker('shadow');
    const a = await startAdapter(w.url);
    const res = await ask(a, ID, { authorization: 'Bearer zly' });
    expect(res.status).toBe(200);
    expect(countUnauthorized(res.log)).toBe(1);
    expect(countUnauthorized((await ask(a)).log)).toBe(0);
  });
});

describe('access-adapter.mjs: żądania spoza kontraktu i konfiguracja', () => {
  it('bez poprawnego EndpointId: 400 `false` bez pytania Workera; inna trasa albo metoda: 404', async () => {
    const w = await worker('shadow');
    const a = await startAdapter(w.url);
    expect(await ask(a, 'nie-hex')).toMatchObject({ status: 400, body: 'false' });
    expect(await ask(a, ID.toUpperCase())).toMatchObject({ status: 200, body: 'true' });
    const get = await fetch(`http://127.0.0.1:${String(a.port)}/v1/access`);
    expect(get.status).toBe(404);
    const other = await fetch(`http://127.0.0.1:${String(a.port)}/v1/inna`, { method: 'POST' });
    expect(other.status).toBe(404);
    expect(w.state.requests).toBe(1);
  });

  it.each([
    [{ WORKER_URL: '' }, 'missing WORKER_URL'],
    [{ WORKER_URL: 'ftp://x/' }, 'missing WORKER_URL'],
    [{ WORKER_URL: 'http://127.0.0.1:1/', ADAPTER_DEADLINE_MS: '0' }, 'ADAPTER_DEADLINE_MS'],
    [{ WORKER_URL: 'http://127.0.0.1:1/', ADAPTER_NEG_TTL_MS: 'abc' }, 'ADAPTER_NEG_TTL_MS'],
  ])('zła konfiguracja %j: kod 2 z komunikatem, bez nasłuchu', (env, message) => {
    const res = spawnSync(process.execPath, [ADAPTER], {
      env: { PATH: process.env.PATH ?? '', ADAPTER_PORT: '0', ...env }, encoding: 'utf8', timeout: 5000,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(message);
    expect(res.stdout).not.toContain('event=listen');
  });
});
