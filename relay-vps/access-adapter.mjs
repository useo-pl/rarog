#!/usr/bin/env node
// Adapter haka `access.http` programu iroh-relay 1.4.1. Node bez zależności; jednostka relay-access.service.
//
// iroh-relay woła hak bez limitu czasu (main.rs:225-228: klient reqwest bez timeoutu), czeka na całe ciało
// (main.rs:329-337) i każdą odpowiedź inną niż 200 z ciałem dokładnie `true` traktuje jako odmowę, tak samo błąd
// połączenia z hakiem. Adapter daje decyzji twardy termin i fail-open:
//   - woła Worker z AbortSignal.timeout(ADAPTER_DEADLINE_MS) (połączenie, nagłówki i ciało razem),
//   - czyta najwyżej 16 bajtów ciała,
//   - 403 `false` oddaje relayowi tylko przy jawnej odmowie Workera (status 403 i ciało dokładnie `false`),
//   - w każdym innym przypadku (błąd, zwłoka, niepełne albo błędne ciało, 5xx, 401) odpowiada 200 `true`,
//   - pamięta odmowę per EndpointId przez ADAPTER_NEG_TTL_MS (cache ujemny), zgody nie pamięta.
// Zły bearer (Worker 401) też otwiera: linię `why=status:401` w dzienniku wyłapuje relay-watch.mjs i zgłasza alert.
// Log: jedna linia na decyzję, skrót EndpointId (10 znaków hex), bez pełnego identyfikatora.
//
// Zmienne (EnvironmentFile /etc/iroh-relay/access-adapter.conf): WORKER_URL (wymagany, http:// albo https://),
// ADAPTER_HOST (127.0.0.1), ADAPTER_PORT (8081; 0 = port od systemu), ADAPTER_DEADLINE_MS (3000),
// ADAPTER_NEG_TTL_MS (15000).

import http from 'node:http';

const MAX_BODY = 16;
const NEG_MAX = 100_000;
const ID_RE = /^[0-9a-f]{64}$/;

function fail(message) {
  console.error(`access-adapter: ${message}`);
  process.exit(2);
}

/** Liczba całkowita ≥ min ze zmiennej albo wartość domyślna; inaczej kod 2 (zła konfiguracja nie startuje). */
function intEnv(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) fail(`${name} must be an integer ≥ ${String(min)} (got: ${raw})`);
  return value;
}

const HOST = process.env.ADAPTER_HOST || '127.0.0.1';
const PORT = intEnv('ADAPTER_PORT', 8081, 0);
const WORKER_URL = process.env.WORKER_URL ?? '';
const DEADLINE_MS = intEnv('ADAPTER_DEADLINE_MS', 3000, 1);
const NEG_TTL_MS = intEnv('ADAPTER_NEG_TTL_MS', 15000, 0);

if (!/^https?:\/\/[^/]/.test(WORKER_URL)) fail('missing WORKER_URL (http:// or https://)');

/** EndpointId -> chwila wygaśnięcia odmowy (ms od epoki). */
const negative = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, until] of negative) if (until <= now) negative.delete(id);
}, Math.max(NEG_TTL_MS, 1000)).unref();

function log(fields) {
  const parts = [new Date().toISOString()];
  for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`);
  process.stdout.write(parts.join(' ') + '\n');
}

/** Pyta Worker. Zwraca {allow, src, why}; src = worker | failopen. */
async function askWorker(id, authorization) {
  const signal = AbortSignal.timeout(DEADLINE_MS);
  const headers = { 'x-iroh-endpoint-id': id };
  if (authorization) headers.authorization = authorization;
  let res;
  try {
    res = await fetch(WORKER_URL, { method: 'POST', headers, signal, redirect: 'manual' });
  } catch (err) {
    return { allow: true, src: 'failopen', why: `fetch:${err?.name ?? 'Error'}:${err?.cause?.code ?? ''}` };
  }
  const chunks = [];
  let size = 0;
  try {
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) {
          reader.cancel().catch(() => {});
          return { allow: true, src: 'failopen', why: `status:${res.status}:body>${MAX_BODY}B` };
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    return { allow: true, src: 'failopen', why: `status:${res.status}:body:${err?.name ?? 'Error'}` };
  }
  const body = Buffer.concat(chunks).toString('latin1');
  if (res.status === 200 && body === 'true') return { allow: true, src: 'worker', why: '200' };
  if (res.status === 403 && body === 'false') return { allow: false, src: 'worker', why: '403' };
  return { allow: true, src: 'failopen', why: `status:${res.status}:body:${JSON.stringify(body)}` };
}

function reply(res, allow, status = allow ? 200 : 403) {
  const body = allow ? 'true' : 'false';
  res.writeHead(status, { 'content-type': 'text/plain', 'content-length': String(body.length) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const t0 = performance.now();
  if (req.method !== 'POST' || req.url !== '/v1/access') {
    res.writeHead(404, { 'content-length': '0' });
    res.end();
    return;
  }
  req.resume();
  const id = String(req.headers['x-iroh-endpoint-id'] ?? '').toLowerCase();
  if (!ID_RE.test(id)) {
    // Relay zawsze wysyła EndpointId (main.rs:321-324); brak = żądanie nie od relaya.
    reply(res, false, 400);
    log({ decision: 'deny', src: 'bad-request', id: '-', ms: (performance.now() - t0).toFixed(1) });
    return;
  }
  const until = negative.get(id);
  if (until !== undefined && until > Date.now()) {
    reply(res, false);
    log({ decision: 'deny', src: 'cache', id: id.slice(0, 10), ms: (performance.now() - t0).toFixed(1) });
    return;
  }
  askWorker(id, req.headers.authorization).then((d) => {
    if (d.allow) negative.delete(id);
    else if (NEG_TTL_MS > 0) {
      if (negative.size >= NEG_MAX) negative.clear();
      negative.set(id, Date.now() + NEG_TTL_MS);
    }
    reply(res, d.allow);
    log({ decision: d.allow ? 'allow' : 'deny', src: d.src, id: id.slice(0, 10),
      ms: (performance.now() - t0).toFixed(1), why: d.why });
  });
});

server.keepAliveTimeout = 5000;
server.on('clientError', (_err, socket) => socket.destroy());
server.listen(PORT, HOST, () => {
  const addr = server.address();
  log({ event: 'listen', addr: `${addr.address}:${addr.port}`, worker: WORKER_URL, deadlineMs: DEADLINE_MS,
    negTtlMs: NEG_TTL_MS });
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
