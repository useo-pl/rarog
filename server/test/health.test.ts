/*
 * `/health` — payload z sondami readiness i sygnałem hooka treści.
 *
 * Kontrakt: dwa boole PONAD „proces żyje" — `herdr` z żywego pingu gniazda (timeout i wyjątek
 * = `false`, nigdy rzut), `term` policzony raz na start — plus `hook` (`ok`/`brak`/`mismatch`).
 * Endpoint jest publiczny, więc payload nie ma prawa nieść niczego poza tym kontraktem,
 * a KAŻDA sonda ma być fail-closed: nic nie wiemy = nic nie obiecujemy.
 *
 * `hookSeenAgo` na tej liście NIE MA: wiek ostatniego odpalenia hooka
 * jest wartością ZMIENNĄ, skorelowaną z aktywnością człowieka w KAŻDEJ sesji Claude pod
 * korzeniami Raroga — także tych prowadzonych przy biurku. Pole żyje za cookie,
 * w `GET /api/version` (test w `router.test.ts`).
 *
 * Who gets the fields: only a TCP request whose `Host` names the loopback address on the server's own port and
 * which carries no proxy header. Everyone else (iroh, a foreign `Host`, a proxy) gets `{"ok":true}` and no probe runs.
 * The rule's table is tested on `fullHealthAllowed`; the HTTP block below checks only what the table cannot see: the
 * route applies the rule, the status stays 200 and the probes stay idle.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { checkServer } from '../src/cli/setup-check.ts';
import { loadConfig } from '../src/config.ts';
import {
  HEALTH_HERDR_TIMEOUT_MS, HOOK_HEALTH_UNKNOWN, NO_HEALTH_PROBES, cacheProbe, fullHealthAllowed, healthPayload,
} from '../src/health.ts';
import type { HealthProbes, HookHealth } from '../src/health.ts';
import { registerIrohPeer } from '../src/iroh/socket.ts';
import { createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { RAROG_VERSION } from '../src/version.ts';
import { FakeManager } from './fake-manager.ts';

const probes = (herdr: () => Promise<boolean>, term: boolean): HealthProbes => ({ herdr, term });

describe('healthPayload', () => {
  it('niesie ok/version/uptime i wyniki sond', async () => {
    const body = await healthPayload(
      '1.2.3', 10_000, probes(() => Promise.resolve(true), true), { nowMs: 17_500 },
    );
    expect(body).toEqual({
      ok: true, version: '1.2.3', uptime: 7, herdr: true, term: true, hook: 'missing', authStore: 'ok', sdk: 'missing',
    });
  });

  it('SDK listy sesji: stan ze startu przechodzi do payloadu, brak stanu = `missing`', async () => {
    for (const state of ['ok', 'stale', 'missing', 'error'] as const) {
      expect((await healthPayload('v', 0, { ...NO_HEALTH_PROBES, sdk: state })).sdk).toBe(state);
    }
    expect((await healthPayload('v', 0)).sdk).toBe('missing');
  });

  it('magazyn kluczy urządzeń: `broken` z sondy przechodzi do payloadu, brak sondy = `ok`', async () => {
    const broken = await healthPayload('v', 0, { ...NO_HEALTH_PROBES, authStore: () => 'broken' });
    expect(broken.authStore).toBe('broken');
    expect((await healthPayload('v', 0)).authStore).toBe('ok');
  });

  it('uptime nigdy nie jest ujemny (zegar cofnięty)', async () => {
    const body = await healthPayload('v', 10_000, NO_HEALTH_PROBES, { nowMs: 9_000 });
    expect(body.uptime).toBe(0);
  });

  it('bez sond (testy, awaria składania) wszystko jest fail-closed', async () => {
    const body = await healthPayload('v', 0);
    expect(body.herdr).toBe(false);
    expect(body.term).toBe(false);
    // Brak sondy hooka = `brak`, nigdy `ok`: Rarog nie ma prawa obiecywać kanału treści,
    // o którym nic nie wie (degradacja do karty ekranowej byłaby wtedy cicha).
    expect(body.hook).toBe('missing');
  });

  describe('sonda hooka', () => {
    const withHook = (hook: () => HookHealth): HealthProbes => ({
      herdr: () => Promise.resolve(true), term: false, hook,
    });

    it('przepisuje status do payloadu — i NIC poza nim', async () => {
      const body = await healthPayload('v', 0, withHook(() => ({ status: 'ok', seenAgo: 42 })));
      expect(body.hook).toBe('ok');
      // Publiczny endpoint nie niesie wieku odpalenia: profil „kiedy i jak gęsto ten człowiek
      // zatwierdza narzędzia" składa się z tej liczby w kilka minut odpytywania w pętli.
      expect(Object.keys(body)).not.toContain('hookSeenAgo');
    });

    it('`mismatch` jedzie osobno od pozostałych sond', async () => {
      const body = await healthPayload(
        'v', 0, withHook(() => ({ status: 'mismatch', seenAgo: null })),
      );
      expect(body.hook).toBe('mismatch');
      expect(body.herdr, 'rozjazd bloku hooków nie ma nic wspólnego z gniazdem herdr').toBe(true);
    });

    it('wyjątek sondy znaczy `brak`, nigdy 500 — /health ma odpowiadać zawsze', async () => {
      const body = await healthPayload('v', 0, withHook(() => {
        throw new Error('EACCES ~/.claude/settings.json');
      }));
      expect(body.hook).toBe(HOOK_HEALTH_UNKNOWN.status);
      expect(body.ok).toBe(true);
    });
  });

  it('wyjątek sondy herdr znaczy `false`, nigdy rzut — health ma odpowiadać zawsze', async () => {
    const body = await healthPayload(
      'v', 0, probes(() => Promise.reject(new Error('gniazdo padło')), false),
    );
    expect(body.herdr).toBe(false);
  });

  it('`term` przechodzi wprost z wartości policzonej przy starcie', async () => {
    const off = await healthPayload('v', 0, probes(() => Promise.resolve(true), false));
    expect(off.term).toBe(false);
    const on = await healthPayload('v', 0, probes(() => Promise.resolve(false), true));
    expect(on.term).toBe(true);
  });

  describe('timeout pingu (half-open herdr)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('sonda, która nigdy nie odpowiada, daje `false` po suficie czasu', async () => {
      const never = (): Promise<boolean> => new Promise<boolean>(() => {});
      const pending = healthPayload('v', 0, probes(never, true));
      await vi.advanceTimersByTimeAsync(HEALTH_HERDR_TIMEOUT_MS);
      const body = await pending;
      expect(body.herdr).toBe(false);
      // Reszta payloadu nie pada razem z herdr — `term` mówi swoje.
      expect(body.term).toBe(true);
    });

    it('szybka odpowiedź wygrywa z zegarem i sprząta timer', async () => {
      const pending = healthPayload('v', 0, probes(() => Promise.resolve(true), false));
      // Zero przesuwania zegara: rozstrzygnięta sonda nie może czekać na timeout.
      const body = await pending;
      expect(body.herdr).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('cacheProbe — publiczny /health nie jest zaproszeniem do sondowania herdr', () => {
  /*
   * Dwa niezależne mechanizmy i oba są potrzebne: TTL ścina ruch ROZŁOŻONY w czasie
   * (watchdog, `restart.sh`, ciekawski peer tailnetu), a wspólna obietnica ścina SZCZYT —
   * bez niej `ab -c 200` dałby dwieście `connect()` do gniazda demona, mimo świeżego cache'u,
   * bo żadne z żądań nie zdążyłoby zobaczyć wyniku poprzedniego.
   */
  it('sto równoległych wywołań daje JEDEN ping (pojedynczy lot)', async () => {
    let pings = 0;
    // Zwolnienie sondy trzymamy w pudełku: `let` przypisywany wyłącznie w executorze obietnicy
    // TS zawęża do `never` i wywołanie przestaje się kompilować.
    const gate: { release: ((value: boolean) => void) | null } = { release: null };
    const probe = cacheProbe(() => {
      pings += 1;
      return new Promise<boolean>((resolve) => { gate.release = resolve; });
    }, { ttlMs: 10_000, now: () => 0 });

    const all = Promise.all(Array.from({ length: 100 }, () => probe()));
    await Promise.resolve();
    expect(pings).toBe(1);
    gate.release?.(true);
    expect(await all).toEqual(Array.from({ length: 100 }, () => true));
    expect(pings).toBe(1);
  });

  it('wynik ma TERMIN WAŻNOŚCI — po nim herdr jest pytany od nowa', async () => {
    let pings = 0;
    let alive = false;
    let clock = 1_000;
    const probe = cacheProbe(() => { pings += 1; return Promise.resolve(alive); },
      { ttlMs: 2_000, now: () => clock });

    expect(await probe()).toBe(false);
    clock += 1_999;
    expect(await probe(), 'w terminie ważności odpowiada cache').toBe(false);
    expect(pings).toBe(1);

    // herdr wstał — Rarog ma to zobaczyć bez własnego restartu.
    alive = true;
    clock += 2;
    expect(await probe()).toBe(true);
    expect(pings).toBe(2);
  });

  it('wyjątek sondy NIE zostaje w cache — powrót herdr nie czeka na TTL', async () => {
    let pings = 0;
    let broken = true;
    const probe = cacheProbe(() => {
      pings += 1;
      return broken ? Promise.reject(new Error('gniazdo padło')) : Promise.resolve(true);
    }, { ttlMs: 10_000, now: () => 0 });

    await expect(probe()).rejects.toThrow('gniazdo padło');
    broken = false;
    expect(await probe()).toBe(true);
    expect(pings).toBe(2);
  });
});

describe('fullHealthAllowed: the fields only for a loopback caller', () => {
  /** A TCP request on `localPort` with this `Host` (none when `undefined`) and extra headers. */
  const tcp = (
    host: string | undefined, localPort = 8930, extra: Record<string, string> = {},
  ): Parameters<typeof fullHealthAllowed>[0] => ({
    headers: { ...(host === undefined ? {} : { host }), ...extra }, socket: { localPort },
  });

  it.each([
    ['127.0.0.1:8930', 8930, true],
    ['localhost:8930', 8930, true],
    ['LOCALHOST:8930', 8930, true],
    ['127.0.0.1:9999', 8930, false],
    ['127.0.0.1', 8930, false],
    ['localhost', 8930, false],
    // `fetch` leaves the default port out, so on port 80 the bare loopback name is the loopback caller.
    ['127.0.0.1', 80, true],
    ['localhost', 80, true],
    ['127.0.0.1:80', 80, true],
    ['evil.example:8930', 8930, false],
    ['mac.example.ts.net', 8930, false],
    ['127.0.0.1.evil.example:8930', 8930, false],
    ['[::1]:8930', 8930, false],
    [undefined, 8930, false],
  ] as const)('Host %s on port %i: full %s', (host, localPort, full) => {
    expect(fullHealthAllowed(tcp(host, localPort))).toBe(full);
  });

  // `Host` is the client's to write and a proxy may pass it on unchanged, so a proxy header alone closes the fields.
  it.each([
    'X-Forwarded-For', 'X-Forwarded-Host', 'Forwarded', 'X-Real-IP', 'Tailscale-User-Login', 'Tailscale-App-Capabilities',
  ])('loopback Host with %s: no fields', (header) => {
    expect(fullHealthAllowed(tcp('127.0.0.1:8930', 8930, { [header.toLowerCase()]: 'x' }))).toBe(false);
  });

  it('a socket without a local port (not TCP): no fields', () => {
    expect(fullHealthAllowed({ headers: { host: '127.0.0.1:8930' }, socket: {} })).toBe(false);
  });

  it('an iroh socket: no fields, whatever its Host and port', () => {
    const peer = registerIrohPeer('a'.repeat(64), () => {});
    const socket = { localPort: 8930 };
    peer.attach(socket);
    try {
      expect(fullHealthAllowed({ headers: { host: '127.0.0.1:8930' }, socket })).toBe(false);
    } finally {
      peer.dispose();
    }
  });
});

describe('GET /health over HTTP: the route applies the rule', () => {
  interface Calls { herdr: number; hook: number; authStore: number; consent: number }

  /** A demo router on a random loopback port, with probes that count their calls. */
  async function serve(): Promise<{ port: number; calls: Calls; close: () => Promise<void> }> {
    const calls: Calls = { herdr: 0, hook: 0, authStore: 0, consent: 0 };
    const dir = mkdtempSync(path.join(tmpdir(), 'health-'));
    const config = loadConfig({ RAROG_DEMO: '1', HOME: dir, RAROG_DATA_DIR: path.join(dir, 'data') });
    const manager = new FakeManager([]);
    const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
    hub.start();
    const health: HealthProbes = {
      herdr: () => { calls.herdr += 1; return Promise.resolve(true); },
      term: true,
      hook: () => { calls.hook += 1; return { status: 'ok', seenAgo: 1 }; },
      authStore: () => { calls.authStore += 1; return 'ok'; },
      sdk: 'ok',
      consent: () => {
        calls.consent += 1;
        return { configured: 'main', effective: 'main', reason: 'configured', since: 0 };
      },
    };
    const server = http.createServer(createRouter({
      config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(),
      logger: { info: () => {}, error: () => {} }, health, healthProbeTtlMs: 0,
    }));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const { port } = server.address() as AddressInfo;
    return {
      port, calls,
      close: async () => {
        hub.closeAll();
        server.closeAllConnections();
        await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      },
    };
  }

  /** `GET /health` with these headers (`Host` included); status and parsed body. */
  function get(port: number, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/health', headers, agent: false }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { parts.push(chunk); });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** An HTTP/1.0 request without `Host`, written by hand (Node's client always sends one). */
  function getWithoutHost(port: number): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => { socket.write('GET /health HTTP/1.0\r\n\r\n'); });
      const parts: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => { parts.push(chunk); });
      socket.on('error', reject);
      socket.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        const status = Number(/^HTTP\/1\.[01] (\d{3})/u.exec(text)?.[1] ?? 0);
        resolve({ status, body: JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4)) as unknown });
      });
    });
  }

  it('a foreign Host, a proxy header or no Host: 200 {"ok":true} and no probe runs; the loopback Host: the fields',
    async () => {
      const s = await serve();
      try {
        const loopback = `127.0.0.1:${String(s.port)}`;
        const alive = { status: 200, body: { ok: true } };
        expect(await get(s.port, { Host: `evil.example:${String(s.port)}` }), 'DNS rebinding').toEqual(alive);
        expect(await get(s.port, { Host: loopback, 'X-Forwarded-For': '100.64.0.7' }), 'proxy header').toEqual(alive);
        expect(await getWithoutHost(s.port), 'HTTP/1.0 without Host').toEqual(alive);
        expect(s.calls, 'no probe runs for a caller without the fields')
          .toEqual({ herdr: 0, hook: 0, authStore: 0, consent: 0 });

        const full = await get(s.port, { Host: loopback });
        expect(full.status).toBe(200);
        expect(full.body).toMatchObject({ ok: true, herdr: true, term: true, hook: 'ok', authStore: 'ok', sdk: 'ok' });
        expect(s.calls).toEqual({ herdr: 1, hook: 1, authStore: 1, consent: 1 });
      } finally {
        await s.close();
      }
    });

  // The closing check of `rarog setup` reads `/health` with `fetch` on 127.0.0.1: the rule must count it as the loopback
  // caller, or the check would see no version and ask for a restart of a healthy server.
  it('a real reader: the `Check` step of `rarog setup` gets the version and the fields', async () => {
    const s = await serve();
    try {
      const details: string[] = [];
      const result = await checkServer({
        service: 'running', port: s.port, packageVersion: RAROG_VERSION,
        commands: { restart: 'rarog restart', doctor: 'rarog doctor', afterUpdate: 'rarog restart' },
        timeoutMs: 2_000, pollMs: 50, detail: (line) => { details.push(line); },
      });
      expect(result).toEqual({ status: 'ok', result: 'hook · SDK · herdr · consent ok', answered: true });
      expect(details.join('\n')).toContain(`version ${RAROG_VERSION}, herdr true`);
    } finally {
      await s.close();
    }
  });
});
