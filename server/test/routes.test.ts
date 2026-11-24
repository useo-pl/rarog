/**
 * Route groups (`server/src/routes/`) behind the single gate of `server/src/router.ts`.
 *
 * The router checks `Origin`, the device key and, after the body arrives, the device again (`bodyRechecks` in
 * `readJsonBody`), all before it hands the request to a group. These tests hold that for every group module:
 *
 * 1. the group list below names every module of `server/src/routes/` (a new group without sample routes fails);
 * 2. a request without a key to a sample route of each group is 401 `unauthorized`, for every method;
 * 3. a mutation with a key and a foreign `Origin` is 403 `bad-origin` in each group;
 * 4. a device unpaired while its body is still arriving gets 401 `device-revoked`, and the route does nothing;
 * 5. only `router.ts` imports a group module, and it dispatches after the three checks.
 *
 * Route discovery against the review-mode table lives in `demo-review-routes.test.ts`.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import type { InboxActionResult } from '../src/inbox/index.ts';
import type { InboxRoutesPort } from '../src/routes/inbox.ts';
import type { TermFeature } from '../src/term/index.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { type TestDevice, createTestDevice } from './helpers/urzadzenie.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ROUTES_DIR = path.join(SRC, 'routes');
const ORIGIN = 'http://localhost:8930';
const silent: Logger = { info: () => {}, error: () => {} };

/** A route of a group that reads a body, with a body that passes its schema (a string goes as is). */
interface BodyRoute {
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  readonly body: unknown;
}

interface Group {
  /** Paths outside `/health`, `/api/pair` and `/api/login` (public), one per route the group serves. */
  readonly paths: readonly string[];
  /** Body routes for case 4; `null` = the group reads no body. */
  readonly body: BodyRoute | null;
}

/** Every group module of `server/src/routes/` (file name without `.ts`), `context.ts` aside. */
const GROUPS: Readonly<Record<string, Group>> = {
  system: {
    paths: ['/api/version', '/api/mac', '/api/client-log', '/api/stream', '/api/voice/token', '/api/companion/token'],
    body: { method: 'POST', path: '/api/client-log', body: { events: [] } },
  },
  terminal: {
    paths: ['/api/term', '/api/term/t1', '/api/term/t1/history'],
    body: { method: 'POST', path: '/api/term', body: { cwd: '/Users/demo/Projects/willow' } },
  },
  notes: {
    paths: ['/api/notes'],
    body: { method: 'PUT', path: '/api/notes', body: { cwd: '/Users/demo/Projects/willow', text: 'x', updatedAt: 0 } },
  },
  devices: {
    paths: ['/api/pairings', '/api/devices', '/api/devices/me', '/api/devices/forget', '/api/devices/xyz'],
    // Padded, so the body is still arriving after the first 5 bytes (the schema takes an empty object only).
    body: { method: 'POST', path: '/api/pairings', body: `{}${' '.repeat(16)}` },
  },
  inbox: {
    paths: ['/api/inbox', '/api/inbox/s1', '/api/inbox/s1/remove', '/api/inbox/s1/restore'],
    body: { method: 'POST', path: '/api/inbox/s1/remove', body: { turnId: 't1', version: 'v1' } },
  },
  limits: {
    paths: ['/api/usage', '/api/usage/details'],
    body: null,
  },
  projects: {
    paths: [
      '/api/projects', '/api/projects/recent', '/api/resumable', '/api/resumable/recent', '/api/models', '/api/fs',
      '/api/fs/mkdir',
    ],
    // The demo refuses to create a directory (409), after the body and its device check.
    body: { method: 'POST', path: '/api/fs/mkdir', body: { parent: '/Users/demo/Projects/willow', name: 'nowy' } },
  },
  push: {
    paths: [
      '/api/presence', '/api/push/apns', '/api/push/apns/status', '/api/push/apns/unregister',
      '/api/push/live-activity', '/api/push/live-activity/end',
    ],
    body: { method: 'POST', path: '/api/presence', body: { clientId: 'c1', visible: true } },
  },
  sessions: {
    paths: [
      '/api/sessions',
      ...[
        'answers/q1', 'close', 'commands', 'companion/ask', 'diff', 'diff/files', 'files', 'files/raw', 'focus',
        'interrupt', 'messages', 'mode', 'model', 'permission', 'permissions/p1', 'restart', 'resume', 'seen', 'stream',
        'unseen', 'uploads/x.png',
      ].map((action) => `/api/sessions/s1/${action}`),
    ],
    body: { method: 'POST', path: '/api/sessions/s1/messages', body: { text: 'hello' } },
  },
};

interface Harness {
  readonly base: string;
  readonly device: TestDevice;
  readonly manager: FakeManager;
  readonly termCalls: string[];
  readonly presenceCalls: string[];
  /** Remove and restore calls that reached the Inbox stub. */
  readonly inboxCalls: string[];
  close(): Promise<void>;
}

const open: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An Inbox stub without cards that records remove and restore: a body route must not reach it after unpairing. */
function stubInbox(calls: string[]): InboxRoutesPort {
  const done = (what: string) => (sessionId: string): Promise<InboxActionResult> => {
    calls.push(`${what} ${sessionId}`);
    return Promise.resolve({ kind: 'done', changed: true });
  };
  return {
    visibleCards: () => [], card: () => null, removed: () => false, remove: done('remove'), restore: done('restore'),
  };
}

/** A terminal stub that records calls: a body route must not reach it after the device is unpaired. */
function stubTerm(calls: string[]): TermFeature {
  return {
    enabled: true,
    open: (cwd: string) => { calls.push(`open ${cwd}`); return { ok: true, id: 't1', slot: 1, role: 'shell' }; },
    list: () => { calls.push('list'); return []; },
    close: () => { calls.push('close'); return true; },
    history: () => { calls.push('history'); return Promise.resolve({ ok: true, text: '', truncated: false }); },
    handleUpgrade: () => {},
    closeOwner: () => 0,
    dispose: () => {},
  } as unknown as TermFeature;
}

async function start(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'routes-'));
  dirs.push(dir);
  const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dir });
  const device = createTestDevice(dir, { epoch: config.epoch });
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const termCalls: string[] = [];
  const presenceCalls: string[] = [];
  const inboxCalls: string[] = [];
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger: silent,
    devices: device.identity, term: stubTerm(termCalls), inbox: stubInbox(inboxCalls),
    presence: { note: (clientId: string) => { presenceCalls.push(clientId); } } as never,
  }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const h: Harness = {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    device, manager, termCalls, presenceCalls, inboxCalls,
    close: async () => {
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
  open.push(h);
  return h;
}

interface Reply { readonly status: number; readonly body: unknown }

/** One request; the body is sent only after `release()` when `slow` is set (first 5 bytes at once). */
function request(
  h: Harness, method: string, route: string, headers: Record<string, string>, body?: unknown, slow = false,
): { release(): void; reply: Promise<Reply> } {
  const url = new URL(`${h.base}${route}`);
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  let release = (): void => {};
  const reply = new Promise<Reply>((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname, method,
      headers: {
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
        'Content-Length': String(Buffer.byteLength(payload)), ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = text;
        try { parsed = text === '' ? null : JSON.parse(text) as unknown; } catch { /* SSE or plain text */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
      // A stream that opened (it should not without a key) would never end; the status is enough.
      if (res.headers['content-type']?.startsWith('text/event-stream') === true) req.destroy();
    });
    req.on('error', reject);
    if (slow) {
      req.write(payload.slice(0, 5));
      release = () => { req.end(payload.slice(5)); };
    } else {
      req.end(payload);
    }
  });
  return { release: () => { release(); }, reply };
}

const errorOf = (reply: Reply): unknown => (reply.body as { error?: unknown } | null)?.error;

describe('grupy tras: lista modułów', () => {
  it('każdy moduł `server/src/routes/` poza `context.ts` ma wpis z trasami w GROUPS', () => {
    const modules = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && f !== 'context.ts')
      .map((f) => f.slice(0, -'.ts'.length)).sort();
    expect(modules, 'a group module without sample routes here is not covered by the gate checks')
      .toEqual(Object.keys(GROUPS).sort());
  });

  it('próbki tras każdej grupy stoją w jej pliku (literał ścieżki albo segment)', () => {
    for (const [name, group] of Object.entries(GROUPS)) {
      const code = readFileSync(path.join(ROUTES_DIR, `${name}.ts`), 'utf8');
      for (const route of group.paths) {
        const segments = route.split('/').filter((s) => s !== '');
        // The path or a prefix of it (`pathname.startsWith('/api/devices')`), or the segment test of the group.
        const literal = segments.some((_, i) => i >= 1 && code.includes(`'/${segments.slice(0, i + 1).join('/')}'`));
        const bySegment = code.includes(`segments[1] === '${segments[1] ?? ''}'`);
        expect(literal || bySegment, `${name}: ${route}`).toBe(true);
      }
    }
  });
});

describe('grupy tras: bramka routera przed każdą grupą', () => {
  for (const [name, group] of Object.entries(GROUPS)) {
    it(`${name}: bez klucza każda trasa i metoda → 401 \`unauthorized\``, async () => {
      const h = await start();
      for (const route of group.paths) {
        for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
          const reply = await request(h, method, route, method === 'GET' ? {} : { Origin: ORIGIN }, method === 'GET'
            ? undefined : {}).reply;
          expect([reply.status, errorOf(reply)], `${method} ${route}`).toEqual([401, 'unauthorized']);
        }
      }
      expect(h.manager.calls.filter((c) => c.method !== 'get' && c.method !== 'list')).toEqual([]);
      expect(h.termCalls).toEqual([]);
    });

    it(`${name}: z kluczem i obcym \`Origin\` mutacja → 403 \`bad-origin\``, async () => {
      const h = await start();
      for (const route of group.paths) {
        const reply = await request(h, 'POST', route, { ...h.device.headers, Origin: 'https://evil.example' }, {}).reply;
        expect([reply.status, errorOf(reply)], `POST ${route}`).toEqual([403, 'bad-origin']);
      }
    });

    const body = group.body;
    if (body !== null) {
      it(`${name}: urządzenie odpięte w trakcie ciała ${body.method} ${body.path} → 401 \`device-revoked\``, async () => {
        const h = await start();
        const pending = request(h, body.method, body.path, { ...h.device.headers, Origin: ORIGIN }, body.body, true);
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        h.device.store.revoke(h.device.id, 'admin');
        pending.release();
        const reply = await pending.reply;
        expect([reply.status, errorOf(reply)]).toEqual([401, 'device-revoked']);
        expect(h.manager.calls.filter((c) => c.method === 'sendMessage')).toEqual([]);
        expect(h.termCalls).toEqual([]);
        expect(h.presenceCalls).toEqual([]);
        expect(h.inboxCalls).toEqual([]);
      });

      it(`${name}: ta sama trasa bez odpięcia przechodzi bramkę (kontrola próbki)`, async () => {
        const h = await start();
        const reply = await request(h, body.method, body.path, { ...h.device.headers, Origin: ORIGIN }, body.body).reply;
        // The route's own answer (2xx, or 400 for a demo path outside the roots), never the gate's refusal.
        expect([401, 403, 404, 405], JSON.stringify(reply.body)).not.toContain(reply.status);
      });
    }
  }
});

describe('grupy tras: tylko router je woła', () => {
  const tsFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

  it('moduł grupy importuje wyłącznie `router.ts` i inne moduły `routes/`', () => {
    const importers: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel === 'router.ts' || rel.startsWith('routes/')) continue;
      if (/from '(?:\.\.?\/)+(?:[\w-]+\/)*routes\//u.test(readFileSync(file, 'utf8'))) importers.push(rel);
    }
    expect(importers, 'a group called from outside the router skips the Origin, key and body checks').toEqual([]);
  });

  it('`handle` w `router.ts` rozdziela na grupy po Origin, kluczu i rejestracji ponownego sprawdzenia', () => {
    const code = readFileSync(path.join(SRC, 'router.ts'), 'utf8');
    const handle = code.slice(code.indexOf('async function handle('));
    const at = (needle: string): number => {
      const i = handle.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const dispatch = at('for (const group of ROUTE_GROUPS)');
    for (const check of ['originAllowed(req, config)', 'authenticate(req, ', 'bodyRechecks.set(req, ', 'classifyReviewRoute(']) {
      expect(at(check), check).toBeLessThan(dispatch);
    }
  });
});
