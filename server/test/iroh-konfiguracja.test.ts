/**
 * Nasłuch iroh za flagą: konfiguracja (`RAROG_IROH*` w `loadConfig`), `RAROG_ORIGINS` opcjonalne
 * przy iroh, klucz na liście `logSecrets`, link parowania z `k=`/`r=`, gniazdo administracyjne (`iroh` w kodzie
 * parowania, `GET /api/admin/iroh`) i bezpiecznik zamknięcia procesu (`shutdown.ts`). Start procesu z flagą i bez:
 * `iroh-proces.test.ts`; `rarog serve --check`: testy `rarog-serve`, `rarog-service*` i `rarog-restart`.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { irohRelayUrl, parsePairingLink } from '@rarog/shared/pairing-link';
import { createAdminHandler, createDeviceStore, createPairing, pairingLink, redact } from '../src/auth/index.ts';
import { DEFAULT_IROH_RELAY } from '../src/cli/setup.ts';
import { ConfigError, loadConfig, logSecrets } from '../src/config.ts';
import { irohModuleInfo } from '../src/iroh/adapter.ts';
import { irohAdminStatus } from '../src/iroh/listener.ts';
import type { IrohListener } from '../src/iroh/listener.ts';
import { exitAfter } from '../src/shutdown.ts';

const ORIGIN = 'https://rarog.example.net';
const RELAY = 'https://relay.example./';
const KEY = randomBytes(32).toString('hex');
const IROH = { RAROG_IROH: '1', RAROG_IROH_KEY: KEY, RAROG_IROH_RELAY: RELAY };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Środowisko produkcyjne testu: katalog danych w tmp, bez tokenu. */
function production(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(path.join(tmpdir(), 'iroh-konf-'));
  dirs.push(dir);
  return { RAROG_ORIGINS: ORIGIN, RAROG_DATA_DIR: path.join(dir, 'dane'), HOME: dir, ...extra };
}

describe('konfiguracja iroh (`loadConfig`)', () => {
  it('brak flagi, `0` i pusta = wyłączony (`iroh: null`), także gdy reszta zmiennych stoi', () => {
    for (const flag of [undefined, '0', '', ' ']) {
      const env = production({ ...IROH, RAROG_IROH: flag });
      expect(loadConfig(env).iroh, String(flag)).toBeNull();
    }
    // Wyłączony nie sprawdza reszty: zły klucz i relay bez flagi nie zatrzymują startu.
    expect(loadConfig(production({ RAROG_IROH_KEY: 'zly', RAROG_IROH_RELAY: 'http://x' })).iroh).toBeNull();
  });

  it('inna wartość flagi = ConfigError', () => {
    for (const flag of ['true', '2', 'tak']) {
      expect(() => loadConfig(production({ ...IROH, RAROG_IROH: flag })), flag).toThrow(ConfigError);
    }
  });

  it('`1`: klucz, relay w postaci kanonicznej, port UDP albo `null`', () => {
    expect(loadConfig(production(IROH)).iroh).toEqual({ key: KEY, relay: RELAY, port: null });
    const custom = loadConfig(production({
      ...IROH, RAROG_IROH_RELAY: 'https://Relay.Example.net:443', RAROG_IROH_PORT: '7842',
    })).iroh;
    expect(custom).toEqual({ key: KEY, relay: 'https://relay.example.net/', port: 7842 });
  });

  it('zły klucz: ConfigError bez wartości klucza w treści', () => {
    for (const bad of [KEY.slice(1), `${KEY}0`, `${KEY.slice(2)}zz`]) {
      let message = '';
      try {
        loadConfig(production({ ...IROH, RAROG_IROH_KEY: bad }));
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ConfigError);
        message = (err as Error).message;
      }
      expect(message).toContain('RAROG_IROH_KEY must be 64 hex characters');
      expect(message).not.toContain(bad);
      expect(message).not.toContain(bad.slice(0, 16));
    }
  });

  it('brak klucza przechodzi `loadConfig` z `key: null` (odmawia start serwera i `--check` bez wrappera)', () => {
    expect(loadConfig(production({ ...IROH, RAROG_IROH_KEY: undefined })).iroh).toEqual({
      key: null, relay: RELAY, port: null,
    });
  });

  it('relay: brak albo nie adres relaya = ConfigError; port spoza 1–65535 = ConfigError', () => {
    for (const relay of [undefined, '', 'http://relay.example', 'https://relay.example/sciezka', 'relay.example',
      'https://[::1]/']) {
      expect(() => loadConfig(production({ ...IROH, RAROG_IROH_RELAY: relay })), String(relay)).toThrow(ConfigError);
    }
    for (const port of ['0', '65536', 'abc', '1.5', '-1']) {
      expect(() => loadConfig(production({ ...IROH, RAROG_IROH_PORT: port })), port).toThrow(/RAROG_IROH_PORT/);
    }
    expect(loadConfig(production({ ...IROH, RAROG_IROH_PORT: '65535' })).iroh?.port).toBe(65535);
  });

  it('`DEFAULT_IROH_RELAY` (`rarog setup`) przechodzi walidację `RAROG_IROH_RELAY` i jest w postaci kanonicznej', () => {
    expect(new URL(DEFAULT_IROH_RELAY).host).toBe('relay.rarog.ai');
    expect(irohRelayUrl(DEFAULT_IROH_RELAY)).toBe(DEFAULT_IROH_RELAY);
    expect(loadConfig(production({ ...IROH, RAROG_IROH_RELAY: DEFAULT_IROH_RELAY })).iroh?.relay).toBe(DEFAULT_IROH_RELAY);
  });

  it('demo z `RAROG_IROH=1` = ConfigError', () => {
    expect(() => loadConfig({ RAROG_DEMO: '1', ...IROH })).toThrow(/does not work in demo mode/);
  });

  it('`RAROG_ORIGINS` opcjonalne tylko przy iroh: pusta lista', () => {
    const withoutOrigins = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...production(extra), RAROG_ORIGINS: undefined });
    expect(loadConfig(withoutOrigins(IROH)).originAllowList).toEqual([]);
    expect(() => loadConfig(withoutOrigins({}))).toThrow(/RAROG_ORIGINS is required/);
  });

  it('klucz jest na liście `logSecrets`, więc `redact` go wymazuje', () => {
    const config = loadConfig(production(IROH));
    expect(logSecrets(config)).toContain(KEY);
    expect(redact(`błąd z kluczem ${KEY}`, logSecrets(config))).not.toContain(KEY);
  });
});

describe('link parowania i gniazdo administracyjne z iroh', () => {
  const SERVER_IROH = { endpointId: 'e'.repeat(64), relay: RELAY };

  it('`pairingLink`: adres, iroh albo oba; bez obu brak linku', () => {
    const code = 'C'.repeat(43);
    const both = pairingLink(ORIGIN, SERVER_IROH, code);
    expect(parsePairingLink(both)).toEqual({ ok: true, fields: { server: ORIGIN, iroh: SERVER_IROH, code } });
    const irohOnly = pairingLink(null, SERVER_IROH, code);
    expect(irohOnly).not.toBeNull();
    expect(irohOnly).not.toContain('u=');
    expect(parsePairingLink(irohOnly ?? '')).toEqual({ ok: true, fields: { server: null, iroh: SERVER_IROH, code } });
    expect(pairingLink(ORIGIN, null, code)).toBe(`https://rarog.ai/pair#v=1&u=${encodeURIComponent(ORIGIN)}&c=${code}`);
    expect(pairingLink(null, null, code)).toBeNull();
  });

  async function admin(deps: Partial<Parameters<typeof createAdminHandler>[0]>): Promise<{
    call(method: string, route: string): Promise<{ status: number; body: Record<string, unknown> }>;
    close(): Promise<void>;
  }> {
    const dir = mkdtempSync(path.join(tmpdir(), 'iroh-adm-'));
    dirs.push(dir);
    const store = createDeviceStore({ dataDir: dir, epoch: '1', log: () => {} });
    const pairing = createPairing({ store, epoch: '1' });
    const server = http.createServer(createAdminHandler({ store, pairing, publicUrl: null, log: () => {}, ...deps }));
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;
    return {
      call: (method, route) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: route, method }, (res) => {
          const parts: Buffer[] = [];
          res.on('data', (chunk: Buffer) => { parts.push(chunk); });
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown> });
          });
        });
        req.on('error', reject);
        req.end();
      }),
      close: async () => {
        await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
        await store.flush();
      },
    };
  }

  it('`POST /api/admin/pairings`: `iroh` w odpowiedzi; bez adresu link z samym `k=`/`r=`, bez obu `null`', async () => {
    const withIroh = await admin({ iroh: SERVER_IROH });
    const issued = await withIroh.call('POST', '/api/admin/pairings');
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ url: null, iroh: SERVER_IROH });
    expect(issued.body['link']).toBe(pairingLink(null, SERVER_IROH, issued.body['code'] as string));
    await withIroh.close();
    const bare = await admin({});
    const plain = await bare.call('POST', '/api/admin/pairings');
    expect(plain.body).toMatchObject({ url: null, iroh: null, link: null });
    await bare.close();
  });

  it('`GET /api/admin/iroh`: stan z `index.ts`, bez niego `enabled: false`; inna metoda 405', async () => {
    const status = { enabled: true, endpointId: 'e'.repeat(64) };
    const enabled = await admin({ irohStatus: () => status });
    expect(await enabled.call('GET', '/api/admin/iroh')).toEqual({ status: 200, body: status });
    expect((await enabled.call('POST', '/api/admin/iroh')).status).toBe(405);
    await enabled.close();
    const disabled = await admin({});
    expect(await disabled.call('GET', '/api/admin/iroh')).toEqual({ status: 200, body: { enabled: false } });
    await disabled.close();
  });

  it('`irohAdminStatus`: wyłączony podaje moduł, włączony migawkę z portem i chwilą relaya w ISO, bez klucza', () => {
    const module = irohModuleInfo();
    expect(irohAdminStatus(null, null, module)).toEqual({ enabled: false, module });
    const listener: IrohListener = {
      endpointId: 'e'.repeat(64), relay: RELAY, close: () => Promise.resolve(),
      snapshot: () => ({
        endpointId: 'e'.repeat(64), relay: RELAY, boundSockets: ['0.0.0.0:7842'],
        homeRelay: { relays: [RELAY], since: Date.parse('2026-10-31T10:00:00.000Z') },
        relayContact: { startedAt: Date.parse('2026-10-31T09:59:00.000Z'), firstContactAt: null },
        connections: { authenticated: 1, unauthenticated: 2 }, handshakes: 0, streams: 3, pendingCloseOps: 0,
        refusals: { origin: 1 } as never,
      }),
    };
    const status = irohAdminStatus(listener, 7842, module);
    expect(status).toMatchObject({
      enabled: true, port: 7842, endpointId: 'e'.repeat(64), relay: RELAY,
      homeRelay: { relays: [RELAY], since: '2026-10-31T10:00:00.000Z' },
      relayContact: { startedAt: '2026-10-31T09:59:00.000Z', firstContactAt: null },
      connections: { authenticated: 1, unauthenticated: 2 }, streams: 3, module,
    });
    expect(JSON.stringify(status)).not.toMatch(/key/i);
  });
});

describe('bezpiecznik zamknięcia procesu (`shutdown.ts`)', () => {
  it('bezpiecznik startuje dopiero po wszystkich zamknięciach, także po porażce jednego', async () => {
    const exits: number[] = [];
    let releaseSlow = (): void => {};
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const done = exitAfter([slow, Promise.reject(new Error('dispose'))], (code) => { exits.push(code); }, 10);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(exits, 'bezpiecznik przed końcem wolnego zamknięcia').toEqual([]);
    releaseSlow();
    await done;
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(exits).toEqual([0]);
  });
});
