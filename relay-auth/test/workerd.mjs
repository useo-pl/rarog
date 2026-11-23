// Rejestr w lokalnym `workerd` dla `workerd.test.ts`: Worker z `wrangler.toml` przez `unstable_startWorker` wranglera
// (bez konta i bez sieci: `remote: false`, magazyn w pamięci), zmienne i sekrety testowe nadpisują `[vars]`, a każde
// wywołanie Workera na zewnątrz (DeviceCheck, APNs) trafia do atrapy Apple w tym procesie (`outboundService`).
// Log wranglera idzie do `.wrangler/` projektu, nie do katalogu domowego. Przed rejestrem może stanąć prawdziwy
// adapter haka z VPS (`relay-vps/access-adapter.mjs`, osobny proces), tak jak przed Workerem na produkcji.

import { spawn } from 'node:child_process';
import path from 'node:path';

const CONFIG = path.resolve(import.meta.dirname, '..', 'wrangler.toml');
const ADAPTER = path.resolve(import.meta.dirname, '..', '..', 'relay-vps', 'access-adapter.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Atrapa Apple: bity DeviceCheck per token (z miesiącem) i próbny push zawsze 200; liczy wywołania per ścieżka. */
export function createFakeApple(month) {
  const bits = new Map();
  const calls = [];
  async function handle(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.text() : '';
    calls.push({ host: url.host, path: url.pathname, authorization: request.headers.get('authorization') ?? '' });
    if (url.pathname === '/v1/query_two_bits') {
      const token = JSON.parse(body).device_token;
      const state = bits.get(token);
      return state === undefined
        ? new Response('Failed to find bit state', { status: 200 })
        : Response.json({ bit0: state.bit0, bit1: state.bit1, last_update_time: month });
    }
    if (url.pathname === '/v1/update_two_bits') {
      const { device_token: token, bit0, bit1 } = JSON.parse(body);
      bits.set(token, { bit0, bit1 });
      return new Response('', { status: 200 });
    }
    if (url.pathname.startsWith('/3/device/')) return new Response('', { status: 200 });
    return new Response('atrapa Apple: nieznany adres', { status: 599 });
  }
  return { bits, calls, handle };
}

export async function startRegistry({ vars, apple }) {
  // Stan lokalny wranglera (`.wrangler/`, w `.gitignore`): tam bundel i log, który wrangler pisze jeszcze po `dispose`.
  process.env.WRANGLER_LOG_PATH = path.resolve(import.meta.dirname, '..', '.wrangler', 'logs');
  process.env.WRANGLER_SEND_METRICS = 'false';
  const { unstable_startWorker } = await import('wrangler');
  const bindings = Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, { type: 'plain_text', value }]));
  const worker = await unstable_startWorker({
    config: CONFIG,
    bindings,
    dev: {
      server: { hostname: '127.0.0.1', port: 0 },
      inspector: false,
      remote: false,
      persist: false,
      logLevel: 'warn',
      outboundService: (request) => apple.handle(request),
    },
  });
  await worker.ready;
  const url = new URL(String(await worker.url));
  return {
    url,
    fetch: (pathname, init) => worker.fetch(new URL(pathname, url), init),
    dispose: () => worker.dispose(),
  };
}

/** Adapter haka na porcie od systemu, z `WORKER_URL` = `/v1/access` rejestru; zwraca port, linie logu i `stop`. */
export async function startAdapter(workerUrl, { deadlineMs = 3000, negTtlMs = 0 } = {}) {
  const proc = spawn(process.execPath, [ADAPTER], {
    env: { PATH: process.env.PATH ?? '', WORKER_URL: workerUrl, ADAPTER_PORT: '0',
      ADAPTER_DEADLINE_MS: String(deadlineMs), ADAPTER_NEG_TTL_MS: String(negTtlMs) },
  });
  const lines = [];
  let rest = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    rest += chunk;
    const parts = rest.split('\n');
    rest = parts.pop() ?? '';
    lines.push(...parts);
  });
  for (let i = 0; i < 250; i += 1) {
    const listen = lines.map((line) => / event=listen addr=127\.0\.0\.1:(\d+) /.exec(line)).find((m) => m !== null);
    if (listen) {
      return {
        port: Number(listen[1]),
        lines,
        stop: () => new Promise((resolve) => {
          proc.once('exit', () => resolve());
          proc.kill('SIGTERM');
        }),
      };
    }
    await sleep(20);
  }
  proc.kill('SIGKILL');
  throw new Error(`adapter nie wystartował: ${lines.join('\n')}`);
}
