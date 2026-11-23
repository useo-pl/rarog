#!/usr/bin/env node
// Atrapa Workera rejestru dla testów adaptera (relay-vps/test/adapter.test.ts) i dla prób na żywo na VPS. Nie jest
// usługą produkcyjną. Trasa `POST /v1/access` w kształcie haka iroh-relay: bearer, nagłówek X-Iroh-Endpoint-Id,
// odpowiedź 200 `true` albo 403 `false`. Surowy serwer TCP (nie node:http), żeby odegrać awarie.
//
// Tryby: shadow (zawsze true), enforce (403 false dla kluczy spoza listy zgody), hang, slow-headers, slow-body,
//   partial, partial-close, bad-body, big-body, deny-bad, 500, 401.
// Z wiersza poleceń (VPS, tylko pętla): node fake-worker.mjs [port 8082] [port panelu 8083]; bearer
//   z IROH_RELAY_HTTP_BEARER_TOKEN. Panel: GET /state, POST /mode/<tryb>, POST /allow|unallow|deny|undeny/<id>.

import net from 'node:net';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const MODES = ['shadow', 'enforce', 'hang', 'slow-headers', 'slow-body', 'partial', 'partial-close',
  'bad-body', 'big-body', 'deny-bad', '500', '401'];
const ID_RE = /^[0-9a-f]{64}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const resp = (status, body) => `HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;

/**
 * Startuje atrapę na 127.0.0.1. `opts`: {bearer, mode, port, gapMs}. `gapMs` to odstęp znaków w trybach wolnych
 * (domyślnie 250 ms). Zwraca uchwyt ze stanem (tryb, listy, liczba żądań i ostatnie nagłówki).
 */
export async function startFakeWorker(opts = {}) {
  const state = { mode: opts.mode ?? 'shadow', allow: new Set(), deny: new Set(), requests: 0, last: null };
  const gapMs = opts.gapMs ?? 250;
  const sockets = new Set();

  async function dribble(sock, text) {
    for (const ch of text) {
      if (sock.destroyed) return;
      sock.write(ch);
      await sleep(gapMs);
    }
  }

  async function handle(sock, head) {
    const lines = head.split('\r\n');
    const [method, path] = lines[0].split(' ');
    const h = {};
    for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
    const id = (h['x-iroh-endpoint-id'] ?? '').toLowerCase();
    state.requests += 1;
    state.last = h;
    if (method !== 'POST' || path !== '/v1/access') { sock.end(resp('404 Not Found', '')); return; }
    if (!opts.bearer || h.authorization !== `Bearer ${opts.bearer}`) { sock.end(resp('401 Unauthorized', 'bearer')); return; }
    if (!ID_RE.test(id)) { sock.end(resp('400 Bad Request', 'id')); return; }
    const known = state.allow.has(id) && !state.deny.has(id);
    switch (state.mode) {
      case 'shadow': sock.end(resp('200 OK', 'true')); return;
      case 'enforce': sock.end(known ? resp('200 OK', 'true') : resp('403 Forbidden', 'false')); return;
      case 'hang': return;
      case 'slow-headers': await dribble(sock, resp('200 OK', 'true')); sock.end(); return;
      case 'slow-body':
        sock.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\nconnection: close\r\n\r\n');
        await dribble(sock, 'true'); sock.end(); return;
      case 'partial':
        sock.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\nconnection: close\r\n\r\ntr');
        return;
      case 'partial-close':
        sock.write('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\nconnection: close\r\n\r\ntr');
        sock.destroy(); return;
      case 'bad-body': sock.end(resp('200 OK', 'yes')); return;
      case 'big-body': sock.end(resp('200 OK', 'true' + ' '.repeat(100))); return;
      case 'deny-bad': sock.end(resp('403 Forbidden', 'nope')); return;
      case '500': sock.end(resp('500 Internal Server Error', 'boom')); return;
      case '401': sock.end(resp('401 Unauthorized', 'bearer')); return;
      default: sock.end(resp('500 Internal Server Error', 'mode'));
    }
  }

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    sock.setEncoding('latin1');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      if (buf === null) return;
      buf += d;
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) { const head = buf.slice(0, end); buf = null; void handle(sock, head); }
      else if (buf.length > 8192) sock.destroy();
    });
  });
  await new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    port,
    url: `http://127.0.0.1:${String(port)}/v1/access`,
    close: () => new Promise((resolve) => {
      for (const sock of sockets) sock.destroy();
      server.close(() => resolve());
    }),
  };
}

async function cli() {
  const port = Number(process.argv[2] ?? 8082);
  const adminPort = Number(process.argv[3] ?? 8083);
  const worker = await startFakeWorker({ bearer: process.env.IROH_RELAY_HTTP_BEARER_TOKEN ?? '', port });
  const { state } = worker;
  console.log(`fake-worker: ${worker.url} tryb=${state.mode}`);
  http.createServer((req, res) => {
    const [, op, arg] = (req.url ?? '').split('/');
    const ok = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mode: state.mode, allow: [...state.allow], deny: [...state.deny], requests: state.requests }) + '\n');
    };
    if (req.method === 'GET' && op === 'state') return ok();
    if (req.method === 'POST' && op === 'mode' && MODES.includes(arg)) { state.mode = arg; console.log(`fake-worker: tryb=${arg}`); return ok(); }
    if (req.method === 'POST' && ['allow', 'unallow', 'deny', 'undeny'].includes(op) && ID_RE.test(arg ?? '')) {
      const set = op.endsWith('allow') ? state.allow : state.deny;
      if (op.startsWith('un')) set.delete(arg); else set.add(arg);
      console.log(`fake-worker: ${op} ${arg.slice(0, 10)}`);
      return ok();
    }
    res.writeHead(400);
    res.end('?\n');
  }).listen(adminPort, '127.0.0.1');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();
