/**
 * Tryb efektywny kanału zgód (warstwa 1): `layer1/mode.ts` i jego publikacja.
 *
 * Granica uprawnień: `main` efektywny wyłącznie przy komplecie warunków (konfiguracja `main`, hook `ok`, żywe
 * `consent.sock` i `admin.sock`, `RAROG_MIN_CLIENT_BUILD`, bez wyłącznika). Każdy brak, wyjątek albo nieczytelny
 * status hooka = `shadow` z powodem, a przed rozstrzygnięciem i po wyłączniku `off`; nigdy `main`.
 *
 * Część pierwsza: czysta reguła i cykl źródła trybu, `/health`, trasa `dialogs/release` (odmowa `channel-closed`
 * do podłączenia cyklu kanału) i linie `rarog doctor` (kanał, sandbox z gniazdami pod `run/` i drugi hook
 * `PermissionRequest`). Część druga: prawdziwy `server/src/index.ts` z katalogiem danych i domem w katalogu
 * tymczasowym — `/health consent`, `alive.json` i `alive.jsonl` (do gotowości gniazd `off`), zakres rejestru,
 * `hello.minClientBuild`, `rarog dialogs off` i sekret rejestracji poza logiem, odpowiedziami i `/health`. Część
 * trzecia: sprzątanie startu plików `consent/` i rekordów `consent-records/` wyłącznie przy cyklu (`main`)
 * i po udanym odzyskaniu rekordów; start w `off` i `shadow` oraz nieudane odzyskanie niczego nie kasują.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSENT_CHANNEL_CLOSED_ERROR, adminSocketPath, consentSocketPath, createAdminHandler, createDeviceStore,
  createPairing, deviceAuthorization, startAdminSocket,
} from '../src/auth/index.ts';
import type { UnixSocket } from '../src/auth/unix-socket.ts';
import { main } from '../src/cli/main.ts';
import { channelSettingsLine, consentLineOf } from '../src/cli/doctor.ts';
import {
  CONSENT_CHANNEL_ENV, HERDR_LAUNCH_ENV, HERDR_SEND_ENV, HERDR_SOCKET_ENV, MIN_CLIENT_BUILD_ENV, PUSH_ENV, TERM_ENV,
} from '../src/config-env.ts';
import { healthPayload, NO_HEALTH_PROBES } from '../src/health.ts';
import type { HookStatus } from '../src/health.ts';
import { HOOK_ALIVE_FILENAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookChannelMode } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_ADMIN_RELEASE_ROUTE, CONSENT_DIRNAME, CONSENT_RECORDS_DIRNAME, CONSENT_RECORD_RETENTION_MS,
  CONSENT_REGISTER_ROUTE, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { CONSENT_MODE_REASONS, createConsentMode, effectiveConsentMode } from '../src/herdr/dialogs/layer1/mode.ts';
import type { ConsentModeInputs, ConsentModeState } from '../src/herdr/dialogs/layer1/mode.ts';
import {
  CONSENT_FILE_TTL_MS, readConsentRecords, recoverThenSweepConsent, writeConsentRecord,
} from '../src/herdr/dialogs/layer1/records.ts';
import type { ConsentRecord } from '../src/herdr/dialogs/layer1/records.ts';
import { ALIVE_LOG_FILENAME } from '../src/herdr/dialogs/shadow/alive-log.ts';
import {
  HOOK_INSTALL_DIR_REL, HOOK_INSTALL_FILES, HOOK_SOURCE_DIR_REL, hookCommand, renderHookBlock,
} from '../src/herdr/hook-config.ts';
import { DATA_DIR_ENV } from '../../shared/src/data-dir.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION = '3f2b8c1e-5a7d-4e9f-b0c6-2d8e4f6a1b3c';
const ORIGIN = 'https://serwer.example';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Wejście z kompletem warunków `main`; `over` psuje wybrany. */
function inputs(over: Partial<ConsentModeInputs> = {}): ConsentModeInputs {
  return { hook: () => 'ok', consentSocket: true, adminSocket: true, minClientBuild: 100, ...over };
}

let dir = '';
const slots = new Map<string, string>();
const sockets: UnixSocket[] = [];
const servers: net.Server[] = [];

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'l1t-')); slots.clear(); });
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('reguła trybu efektywnego (`effectiveConsentMode`)', () => {
  it('konfiguracja `off` i `shadow` = ona sama, bez względu na gniazda i hook', () => {
    const broken = inputs({ hook: () => 'missing', consentSocket: false, adminSocket: false, minClientBuild: undefined });
    expect(effectiveConsentMode('off', broken)).toEqual({ effective: 'off', reason: 'configured' });
    expect(effectiveConsentMode('shadow', broken)).toEqual({ effective: 'shadow', reason: 'configured' });
  });

  it('`main` wyłącznie przy komplecie warunków', () => {
    expect(effectiveConsentMode('main', inputs())).toEqual({ effective: 'main', reason: 'configured' });
  });

  it.each<[string, Partial<ConsentModeInputs>, string]>([
    ['hook `missing`', { hook: () => 'missing' }, 'missing'],
    ['hook `mismatch` (niezgodny wpis)', { hook: () => 'mismatch' }, 'mismatch'],
    ['hook `stale`', { hook: () => 'stale' }, 'stale'],
    ['sonda hooka rzuca', { hook: () => { throw new Error('EACCES'); } }, 'missing'],
    ['status hooka spoza listy', { hook: () => 'nowy' as HookStatus }, 'missing'],
    ['brak `consent.sock`', { consentSocket: false }, 'consent-socket'],
    ['brak `admin.sock`', { adminSocket: false }, 'admin-socket'],
    ['brak `RAROG_MIN_CLIENT_BUILD`', { minClientBuild: undefined }, 'min-client-build'],
    ['próg nie jest liczbą całkowitą ≥ 1', { minClientBuild: 0.5 }, 'min-client-build'],
    ['próg zero', { minClientBuild: 0 }, 'min-client-build'],
  ])('`main` + %s → `shadow` z powodem', (_what, over, reason) => {
    expect(effectiveConsentMode('main', inputs(over))).toEqual({ effective: 'shadow', reason });
  });

  it('`all`: te same warunki co `main`; komplet = `all` efektywny, brak = `shadow` z tym samym powodem', () => {
    expect(effectiveConsentMode('all', inputs())).toEqual({ effective: 'all', reason: 'configured' });
    expect(effectiveConsentMode('all', inputs({ minClientBuild: undefined })))
      .toEqual({ effective: 'shadow', reason: 'min-client-build' });
    const braki: readonly (readonly [Partial<ConsentModeInputs>, string])[] = [
      [{ hook: () => 'stale' }, 'stale'], [{ consentSocket: false }, 'consent-socket'],
      [{ adminSocket: false }, 'admin-socket'], [{ hook: () => { throw new Error('EACCES'); } }, 'missing'],
    ];
    for (const [over, reason] of braki) {
      expect(effectiveConsentMode('all', inputs(over)), reason).toEqual(effectiveConsentMode('main', inputs(over)));
      expect(effectiveConsentMode('all', inputs(over)), reason).toEqual({ effective: 'shadow', reason });
    }
  });

  it('kilka braków naraz: powód = pierwszy w kolejności listy powodów', () => {
    const many = inputs({ hook: () => 'stale', consentSocket: false, adminSocket: false, minClientBuild: undefined });
    expect(effectiveConsentMode('main', many).reason).toBe('stale');
    expect(effectiveConsentMode('main', inputs({ adminSocket: false, minClientBuild: undefined })).reason)
      .toBe('admin-socket');
    expect(CONSENT_MODE_REASONS.indexOf('stale')).toBeLessThan(CONSENT_MODE_REASONS.indexOf('consent-socket'));
  });
});

describe('źródło trybu (`createConsentMode`)', () => {
  const clock = { at: 1_000 };
  const control = (configured: HookChannelMode): { mode: ReturnType<typeof createConsentMode>; seen: ConsentModeState[]; logs: string[] } => {
    const seen: ConsentModeState[] = [];
    const logs: string[] = [];
    const mode = createConsentMode({ configured, now: () => clock.at, log: (line) => { logs.push(line); } });
    mode.onChange((state) => { seen.push(state); });
    return { mode, seen, logs };
  };

  it('konfiguracja `main`: `off` do rozstrzygnięcia, potem RAZ tryb z warunków; drugie rozstrzygnięcie nic nie zmienia', () => {
    const { mode, seen, logs } = control('main');
    expect(mode.current()).toEqual({ configured: 'main', effective: 'off', reason: 'starting', since: 1_000 });
    clock.at = 2_000;
    expect(mode.resolve(inputs({ hook: () => 'stale' }))).toMatchObject({ effective: 'shadow', reason: 'stale', since: 2_000 });
    expect(mode.resolve(inputs())).toMatchObject({ effective: 'shadow', reason: 'stale' });
    expect(seen.map((s) => [s.effective, s.reason])).toEqual([['shadow', 'stale']]);
    expect(logs).toEqual(['consent: effective mode shadow (configured main, reason stale)']);
  });

  it('wyłącznik: `off` do restartu, także przed rozstrzygnięciem; rozstrzygnięcie go nie cofa', () => {
    const before = control('main');
    before.mode.kill();
    expect(before.mode.resolve(inputs())).toMatchObject({ effective: 'off', reason: 'killswitch' });
    const after = control('main');
    after.mode.resolve(inputs());
    expect(after.mode.current()).toMatchObject({ effective: 'main', reason: 'configured' });
    after.mode.kill();
    after.mode.kill();
    expect(after.mode.current()).toMatchObject({ configured: 'main', effective: 'off', reason: 'killswitch' });
    expect(after.seen.map((s) => s.effective)).toEqual(['main', 'off']);
  });

  it('konfiguracja `all`: `off` do rozstrzygnięcia, potem RAZ `all` z kompletu warunków; wyłącznik `off`', () => {
    const { mode, seen, logs } = control('all');
    expect(mode.current()).toMatchObject({ configured: 'all', effective: 'off', reason: 'starting' });
    expect(mode.resolve(inputs())).toMatchObject({ configured: 'all', effective: 'all', reason: 'configured' });
    expect(mode.resolve(inputs({ hook: () => 'stale' }))).toMatchObject({ effective: 'all' });
    mode.kill();
    expect(seen.map((s) => [s.effective, s.reason])).toEqual([['all', 'configured'], ['off', 'killswitch']]);
    expect(logs[0]).toBe('consent: effective mode all (configured all, reason configured)');
  });

  it('konfiguracja `off` i `shadow`: tryb od utworzenia, rozstrzygnięcie bez zmiany; wyłącznik działa też tu', () => {
    for (const configured of ['off', 'shadow'] as const) {
      const { mode, seen } = control(configured);
      expect(mode.current()).toMatchObject({ effective: configured, reason: 'configured' });
      mode.resolve(inputs({ hook: () => 'missing' }));
      expect(seen).toEqual([]);
      mode.kill();
      expect(mode.current()).toMatchObject({ effective: 'off', reason: 'killswitch' });
    }
  });

  it('słuchacz, który rzuca, nie zatrzymuje pozostałych; wypisany nie dostaje zmian', () => {
    const { mode, logs } = control('main');
    const later: string[] = [];
    mode.onChange(() => { throw new Error('zły słuchacz'); });
    const off = mode.onChange((state) => { later.push(state.effective); });
    mode.resolve(inputs());
    off();
    mode.kill();
    expect(later).toEqual(['main']);
    expect(logs).toContain('consent: a mode change listener failed');
  });
});

describe('`/health consent`', () => {
  it('niesie tryb skonfigurowany, efektywny i powód, bez chwili zmiany; brak sondy albo wyjątek = brak pola', async () => {
    const state: ConsentModeState = { configured: 'main', effective: 'shadow', reason: 'stale', since: 123 };
    const body = await healthPayload('v', 0, { ...NO_HEALTH_PROBES, consent: () => state });
    expect(body.consent).toEqual({ configured: 'main', effective: 'shadow', reason: 'stale' });
    expect(JSON.stringify(body)).not.toContain('123');
    expect('consent' in await healthPayload('v', 0)).toBe(false);
    expect('consent' in await healthPayload('v', 0, { ...NO_HEALTH_PROBES, consent: () => { throw new Error('x'); } }))
      .toBe(false);
  });
});

/** Żądanie przez gniazdo Unix. */
function socketCall(socketPath: string, method: string, route: string, body?: unknown): Promise<{
  status: number; text: string; body: Record<string, unknown> | null;
}> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      socketPath, path: route, method, headers: { 'Content-Length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, text, body: text === '' ? null : JSON.parse(text) as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('gniazdo administracyjne: `dialogs/release` z obsługą, która odmawia', () => {
  it('odmowa `channel-closed` = 503 z kodem i zdaniem, bez listy kluczy', async () => {
    const store = createDeviceStore({ dataDir: dir, epoch: '1' });
    const pairing = createPairing({ store, epoch: '1' });
    const logs: string[] = [];
    const socket = await startAdminSocket(dir, createAdminHandler({
      store, pairing, publicUrl: null, log: (line) => { logs.push(line); },
      consent: { release: () => ({ refused: CONSENT_CHANNEL_CLOSED_ERROR }), off: () => {} },
    }), () => {});
    if (socket === null) throw new Error('gniazdo administracyjne nie wstało');
    sockets.push(socket);
    const reply = await socketCall(socket.path, 'POST', CONSENT_ADMIN_RELEASE_ROUTE, { sessionId: SESSION });
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ error: CONSENT_CHANNEL_CLOSED_ERROR });
    expect(reply.body?.['released']).toBeUndefined();
    expect(logs).toContain('consent: release from the admin socket refused — the channel is closed');
  });
});

describe('`rarog doctor`: linia kanału zgód', () => {
  const health = (consent: unknown): { body: Record<string, unknown> } => ({ body: { ok: true, consent } });

  it.each<[string, unknown, string]>([
    ['`main` efektywny', { configured: 'main', effective: 'main', reason: 'configured' }, 'ok'],
    ['`all` efektywny', { configured: 'all', effective: 'all', reason: 'configured' }, 'ok'],
    ['`all` → `shadow` (próg buildu)', { configured: 'all', effective: 'shadow', reason: 'min-client-build' }, 'bad'],
    ['`all` → `shadow` (hook `stale`)', { configured: 'all', effective: 'shadow', reason: 'stale' }, 'bad'],
    ['`all`: wyłącznik', { configured: 'all', effective: 'off', reason: 'killswitch' }, 'warn'],
    ['`all`: start w toku', { configured: 'all', effective: 'off', reason: 'starting' }, 'unknown'],
    ['`off` z konfiguracji', { configured: 'off', effective: 'off', reason: 'configured' }, 'info'],
    ['`shadow` z konfiguracji', { configured: 'shadow', effective: 'shadow', reason: 'configured' }, 'info'],
    ['`main` → `shadow` (hook `stale`)', { configured: 'main', effective: 'shadow', reason: 'stale' }, 'bad'],
    ['`main` → `shadow` (próg buildu)', { configured: 'main', effective: 'shadow', reason: 'min-client-build' }, 'bad'],
    ['`main` → `shadow` (`admin.sock`)', { configured: 'main', effective: 'shadow', reason: 'admin-socket' }, 'bad'],
    ['wyłącznik', { configured: 'main', effective: 'off', reason: 'killswitch' }, 'warn'],
    ['start w toku', { configured: 'main', effective: 'off', reason: 'starting' }, 'unknown'],
    ['serwer bez pola', undefined, 'info'],
  ])('%s → %s', (_what, consent, verdict) => {
    const line = consentLineOf(health(consent));
    expect(line.verdict).toBe(verdict);
    if (verdict === 'bad') expect(line.repair).toMatch(/restart/u);
  });

  it('powód `min-client-build` podaje zmienną; wyłącznik przypomina o wpisie `off` w `config.json`', () => {
    expect(consentLineOf(health({ configured: 'main', effective: 'shadow', reason: 'min-client-build' })).repair)
      .toContain(MIN_CLIENT_BUILD_ENV);
    expect(consentLineOf(health({ configured: 'all', effective: 'shadow', reason: 'min-client-build' })).repair)
      .toContain(MIN_CLIENT_BUILD_ENV);
    expect(consentLineOf(health({ configured: 'all', effective: 'all', reason: 'configured' })).text)
      .toBe('consent channel: all (configured all, reason configured)');
    expect(consentLineOf(health({ configured: 'main', effective: 'off', reason: 'killswitch' })).repair)
      .toContain('RAROG_CONSENT_CHANNEL to "off" in env in ~/.config/rarog/config.json');
  });
});

describe('`rarog doctor`: ustawienia Claude Code wobec kanału', () => {
  const settingsWith = (home: string, extra: Record<string, unknown>): void => {
    const block = JSON.parse(renderHookBlock(hookCommand(home))) as Record<string, unknown>;
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ ...block, ...extra }));
  };

  it('same wpisy Raroga, bez sandboksa = „info”; brak pliku = „info”', () => {
    expect(channelSettingsLine(dir, path.join(dir, 'd')).verdict).toBe('info');
    settingsWith(dir, {});
    expect(channelSettingsLine(dir, path.join(dir, 'd')).verdict).toBe('info');
  });

  it('`allowAllUnixSockets: true` i wpis obejmujący `<dataDir>/run/` = „uwaga”; wpis obok = nic', () => {
    const dataDir = path.join(dir, 'dane');
    for (const network of [
      { allowAllUnixSockets: true },
      { allowUnixSockets: [path.join(dataDir, 'run')] },
      { allowUnixSockets: [path.join(dataDir, 'run', 'admin.sock')] },
      { allowUnixSockets: [`${dataDir}/run/*.sock`] },
      { allowUnixSockets: [`${dataDir}/**`] },
    ]) {
      settingsWith(dir, { sandbox: { network } });
      const line = channelSettingsLine(dir, dataDir);
      expect(line.verdict, JSON.stringify(network)).toBe('warn');
      expect(line.details?.join('\n'), JSON.stringify(network)).toMatch(/sandbox\.network/u);
    }
    settingsWith(dir, { sandbox: { network: { allowUnixSockets: [path.join(dir, 'inne', 'run'), '/var/run/docker.sock'] } } });
    expect(channelSettingsLine(dir, dataDir).verdict).toBe('info');
  });

  it('drugi hook `PermissionRequest` = „uwaga” z komendą; wpis Raroga się nie liczy', () => {
    const block = JSON.parse(renderHookBlock(hookCommand(dir))) as { hooks: Record<string, unknown[]> };
    block.hooks['PermissionRequest']?.push({ hooks: [{ type: 'command', command: 'node /opt/obcy-hook.mjs' }] });
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(block));
    const line = channelSettingsLine(dir, path.join(dir, 'd'));
    expect(line.verdict).toBe('warn');
    expect(line.details).toEqual([expect.stringContaining('node /opt/obcy-hook.mjs')]);
  });
});

// ── Prawdziwy serwer

interface Started {
  readonly port: number;
  readonly dataDir: string;
  readonly home: string;
  output(): string;
  stop(): Promise<void>;
}

type HookFixture = 'ok' | 'stale' | 'mismatch' | 'none';

/** Dom z wpisem hooka i kopią: `ok` = kopia równa repo, `stale` = kopia zmieniona, `mismatch` = wpis bez `timeout`. */
function homeWith(home: string, hook: HookFixture): void {
  mkdirSync(home, { recursive: true });
  if (hook === 'none') return;
  const copy = path.join(home, HOOK_INSTALL_DIR_REL);
  mkdirSync(copy, { recursive: true });
  for (const name of HOOK_INSTALL_FILES) copyFileSync(path.join(REPO, HOOK_SOURCE_DIR_REL, name), path.join(copy, name));
  if (hook === 'stale') appendFileSync(path.join(copy, HOOK_INSTALL_FILES[0]), '\n// zmiana kopii\n');
  const block = JSON.parse(renderHookBlock(hookCommand(home))) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
  if (hook === 'mismatch') delete block.hooks['PermissionRequest']?.[0]?.hooks[0]?.['timeout'];
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(block));
}

/** Żywe gniazdo procesu testu pod ścieżką gniazda serwera: serwer go nie przejmie. */
async function occupy(socketPath: string): Promise<void> {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = net.createServer((conn) => { conn.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  servers.push(server);
}

/** `server/src/index.ts` na porcie 0, herdr pod nieistniejącym gniazdem, bez wysyłki, pushy i terminala. */
async function startServer(name: string, env: Record<string, string>, ready: string, hook: HookFixture,
  before?: (dataDir: string) => Promise<void>): Promise<Started> {
  // A numbered directory per name, not the name itself: the consent socket under it has to fit in 103 B. The same
  // name gets the same directory again (a restart keeps its data).
  if (!slots.has(name)) slots.set(name, String(slots.size + 1));
  const slot = path.join(dir, slots.get(name) ?? name);
  const dataDir = path.join(slot, 'd');
  const home = path.join(slot, 'h');
  mkdirSync(dataDir, { recursive: true });
  homeWith(home, hook);
  await before?.(dataDir);
  const child = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), ['server/src/index.ts'], {
    cwd: REPO,
    env: {
      PATH: process.env['PATH'] ?? '', HOME: home, TMPDIR: tmpdir(), RAROG_ORIGINS: ORIGIN, RAROG_PORT: '0',
      [DATA_DIR_ENV]: dataDir, [HERDR_SOCKET_ENV]: path.join(slot, 'brak.sock'),
      [HERDR_SEND_ENV]: '0', [HERDR_LAUNCH_ENV]: '0', [PUSH_ENV]: '0', [TERM_ENV]: '0', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise<void>((resolve) => { child.on('close', () => { resolve(); }); });
  const stop = async (): Promise<void> => { child.kill('SIGTERM'); await exited; };
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`${name}: serwer nie wstał:\n${output}`)); }, 90_000);
      const onData = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        const listening = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
        if (listening !== null && output.includes(ready)) {
          clearTimeout(timer);
          resolve(Number(listening[1]));
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
    });
    return { port, dataDir, home, output: () => output, stop };
  } catch (failure) {
    await stop();
    throw failure;
  }
}

async function healthOf(port: number): Promise<{ text: string; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
  const text = await response.text();
  return { text, body: JSON.parse(text) as Record<string, unknown> };
}

const aliveField = (dataDir: string, field: string): unknown =>
  (JSON.parse(readFileSync(path.join(dataDir, HOOK_ALIVE_FILENAME), 'utf8')) as Record<string, unknown>)[field];
const aliveMode = (dataDir: string): unknown => aliveField(dataDir, 'mode');
/** `markers: true` = serwer z kanałem zgód czyta znaczniki prośby (tylko przy efektywnym `main`). */
const aliveMarkers = (dataDir: string): unknown => aliveField(dataDir, 'markers');

const aliveLog = (dataDir: string): Array<Record<string, unknown>> =>
  readFileSync(path.join(dataDir, ALIVE_LOG_FILENAME), 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** Rejestracja w kształcie hooka z podanym sekretem. */
function registration(secret: string): Record<string, unknown> {
  const promptId = `p${sha('prompt').slice(0, 12)}`;
  return {
    key: `${promptId}-${sha('nonce').slice(0, 32)}`, sessionId: SESSION, promptId, secret,
    inputSha256: sha('input'), cardSha256: sha('card'), pid: process.pid, startedAt: Date.now() - 1_000,
  };
}

/** Pierwsza ramka `hello` strumienia globalnego. */
function helloFrame(port: number, headers: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { req.destroy(); reject(new Error('brak ramki hello')); }, 15_000);
    const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers, agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (const frame of buffer.split('\n\n')) {
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (data === undefined) continue;
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed['type'] === 'hello') {
            clearTimeout(timer);
            req.destroy();
            resolve(parsed);
          }
        }
      });
    });
    req.on('error', () => { /* zerwanie po `hello` jest celowe */ });
  });
}

/** Wszystkie pliki pod katalogiem jako tekst (gniazda pomijane). */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(readFileSync(full, 'utf8'));
  }
  return out;
}

/** CLI `rarog` w procesie testu z jawnym środowiskiem. */
async function rarog(argv: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env: { HOME: home }, cwd: dir,
  });
  return { code, stdout, stderr };
}

const MAIN_READY = 'consent: effective mode';
const MAIN_ENV = { [CONSENT_CHANNEL_ENV]: 'main', [MIN_CLIENT_BUILD_ENV]: '100' };
const ALL_ENV = { [CONSENT_CHANNEL_ENV]: 'all', [MIN_CLIENT_BUILD_ENV]: '100' };

describe('prawdziwy serwer z konfiguracją `main`', () => {
  it('komplet warunków: `main` efektywny, `alive.json` przed gniazdami `off`, z `main` niesie `markers: true`, `hello`'
    + ' z progiem, wyłącznik do restartu (bez `markers`), sekret poza logiem i odpowiedziami', async () => {
    const server = await startServer('pelny', MAIN_ENV, MAIN_READY, 'ok');
    try {
      const { dataDir, home, port } = server;
      expect((await healthOf(port)).body['consent']).toEqual({ configured: 'main', effective: 'main', reason: 'configured' });
      expect(aliveMode(dataDir)).toBe('main');
      expect(aliveMarkers(dataDir)).toBe(true);
      // Do gotowości obu gniazd plik niesie `off`: pierwsza linia procesu to `start` z `off`, potem przejście.
      const lines = aliveLog(dataDir);
      expect(lines[0]).toMatchObject({ ev: 'start', mode: 'off' });
      expect(lines.map((line) => line['mode'])).toContain('main');
      expect(server.output()).toContain('consent: effective mode main (configured main, reason configured)');

      // Zakres rejestru otwarty: rejestracja przechodzi zakres i staje na killswitchu wysyłki (`send-off`).
      const secret = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
      const open = await socketCall(consentSocketPath(dataDir), 'POST', CONSENT_REGISTER_ROUTE, registration(secret));
      expect(open).toMatchObject({ status: 503, body: { error: 'send-off' } });

      // `hello` na uruchomionym serwerze niesie próg buildu apki.
      const issued = await socketCall(adminSocketPath(dataDir), 'POST', '/api/admin/pairings');
      const paired = await fetch(`http://127.0.0.1:${String(port)}/api/pair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ v: 1, code: issued.body?.['code'], label: 'iPhone·Test' }),
      });
      const device = await paired.json() as Record<string, unknown>;
      const hello = await helloFrame(port, {
        Origin: ORIGIN, Authorization: deviceAuthorization(String(device['deviceId']), String(device['secret'])),
      });
      expect(hello['minClientBuild']).toBe(100);

      // `rarog dialogs off`: `off` do restartu, konfiguracja bez zmian, wyjście przypomina o wpisie w `config.json`.
      const configFile = path.join(home, '.config', 'rarog', 'config.json');
      mkdirSync(path.dirname(configFile), { recursive: true });
      const config = `${JSON.stringify({ version: 1, env: { [CONSENT_CHANNEL_ENV]: 'main' } })}\n`;
      writeFileSync(configFile, config);
      const off = await rarog(['dialogs', 'off', '--data-dir', dataDir], home);
      expect(off.code, off.stderr).toBe(0);
      expect(off.stdout).toContain('until the server restarts');
      expect(off.stdout).toContain(`set ${CONSENT_CHANNEL_ENV} to "off" in env in ${configFile}`);
      expect(readFileSync(configFile, 'utf8')).toBe(config);
      expect((await healthOf(port)).body['consent']).toEqual({ configured: 'main', effective: 'off', reason: 'killswitch' });
      expect(aliveMode(dataDir)).toBe('off');
      expect(aliveMarkers(dataDir)).toBeUndefined();
      const closed = await socketCall(consentSocketPath(dataDir), 'POST', CONSENT_REGISTER_ROUTE, registration(secret));
      expect(closed).toMatchObject({ status: 503, body: { error: 'channel-closed' } });

      // `rarog dialogs release`: do podłączenia cyklu kanału odmowa z kodem 1.
      const release = await rarog(['dialogs', 'release', SESSION, '--data-dir', dataDir], home);
      expect(release.code).toBe(1);
      expect(release.stderr).toContain('consent channel is closed');

      // Sekret rejestracji: ani w logu, ani w odpowiedziach gniazd, ani w `/health`, ani w plikach katalogu danych.
      const seen = [server.output(), open.text, closed.text, (await healthOf(port)).text, ...filesUnder(dataDir)];
      for (const text of seen) expect(text).not.toContain(secret);
    } finally {
      await server.stop();
    }
  }, 180_000);

  it('brak warunku = `shadow` z powodem w `/health` i `alive.json` (bez `markers`), zakres rejestru zamknięty; `off`'
    + ' startuje', async () => {
    const cases: Array<{ name: string; env: Record<string, string>; hook: HookFixture; reason: string;
      before?: (dataDir: string) => Promise<void> }> = [
      { name: 'stale', env: MAIN_ENV, hook: 'stale', reason: 'stale' },
      { name: 'mismatch', env: MAIN_ENV, hook: 'mismatch', reason: 'mismatch' },
      { name: 'bez-hooka', env: MAIN_ENV, hook: 'none', reason: 'missing' },
      { name: 'bez-progu', env: { [CONSENT_CHANNEL_ENV]: 'main' }, hook: 'ok', reason: 'min-client-build' },
      { name: 'bez-consent', env: MAIN_ENV, hook: 'ok', reason: 'consent-socket',
        before: (dataDir) => occupy(consentSocketPath(dataDir)) },
      { name: 'bez-admin', env: MAIN_ENV, hook: 'ok', reason: 'admin-socket',
        before: (dataDir) => occupy(adminSocketPath(dataDir)) },
    ];
    const started = await Promise.all(cases.map((one) => startServer(one.name, one.env, MAIN_READY, one.hook, one.before)));
    try {
      for (const [index, one] of cases.entries()) {
        const server = started[index];
        if (server === undefined) throw new Error(one.name);
        expect((await healthOf(server.port)).body['consent'], one.name)
          .toEqual({ configured: 'main', effective: 'shadow', reason: one.reason });
        expect(aliveMode(server.dataDir), one.name).toBe('shadow');
        expect(aliveMarkers(server.dataDir), one.name).toBeUndefined();
        expect(aliveLog(server.dataDir)[0], one.name).toMatchObject({ ev: 'start', mode: 'off' });
        if (one.reason !== 'consent-socket') {
          const reply = await socketCall(consentSocketPath(server.dataDir), 'POST', CONSENT_REGISTER_ROUTE,
            registration(randomBytes(CONSENT_SECRET_BYTES).toString('hex')));
          expect(reply, one.name).toMatchObject({ status: 503, body: { error: 'channel-closed' } });
        }
      }
    } finally {
      await Promise.all(started.map((server) => server.stop()));
    }

    // Sekwencja powrotu: konfiguracja `off` startuje serwer bez gniazda rejestracji, `alive.json` z `off`.
    const off = await startServer('off', { [CONSENT_CHANNEL_ENV]: 'off' }, 'admin: admin socket', 'ok');
    try {
      expect((await healthOf(off.port)).body['consent']).toEqual({ configured: 'off', effective: 'off', reason: 'configured' });
      expect(aliveMode(off.dataDir)).toBe('off');
      expect(aliveMarkers(off.dataDir)).toBeUndefined();
      expect(existsSync(consentSocketPath(off.dataDir))).toBe(false);
    } finally {
      await off.stop();
    }
  }, 240_000);
});

describe('prawdziwy serwer z konfiguracją `all`', () => {
  it('komplet warunków: `all` efektywny w `/health`, `alive.json` z `mode: "all"` i `markers: true`, linia logu;'
    + ' rejestracja z `agentId` przechodzi zakres (przy `main` odmowa `subagent`); `dialogs release` bez odmowy'
    + ' `channel-closed`', async () => {
    const [all, main] = await Promise.all([
      startServer('all-pelny', ALL_ENV, MAIN_READY, 'ok'),
      startServer('main-subagent', MAIN_ENV, MAIN_READY, 'ok'),
    ]);
    try {
      expect((await healthOf(all.port)).body['consent']).toEqual({ configured: 'all', effective: 'all', reason: 'configured' });
      expect(aliveMode(all.dataDir)).toBe('all');
      expect(aliveMarkers(all.dataDir)).toBe(true);
      expect(aliveLog(all.dataDir)[0]).toMatchObject({ ev: 'start', mode: 'off' });
      expect(aliveLog(all.dataDir).map((line) => line['mode'])).toContain('all');
      expect(all.output()).toContain('consent: effective mode all (configured all, reason configured)');

      // Wysyłka wyłączona w tym serwerze: rejestracja subagenta przechodzi zakres i staje na `send-off`.
      const sub = { ...registration(randomBytes(CONSENT_SECRET_BYTES).toString('hex')), agentId: 'agent-1' };
      expect(await socketCall(consentSocketPath(all.dataDir), 'POST', CONSENT_REGISTER_ROUTE, sub))
        .toMatchObject({ status: 503, body: { error: 'send-off' } });
      expect(await socketCall(consentSocketPath(main.dataDir), 'POST', CONSENT_REGISTER_ROUTE, sub))
        .toMatchObject({ status: 503, body: { error: 'subagent' } });

      // Zwolnienie z gniazda administracyjnego przy `all` idzie do cyklu: sesja bez kart, kod 0.
      const release = await rarog(['dialogs', 'release', SESSION, '--data-dir', all.dataDir], all.home);
      expect(release.code, release.stderr).toBe(0);
      expect(release.stdout).toContain('No consent channel card to release in this session.');
    } finally {
      await Promise.all([all.stop(), main.stop()]);
    }
  }, 180_000);

  it('`all` bez `RAROG_MIN_CLIENT_BUILD` = `shadow` z powodem `min-client-build`, `alive.json` bez `markers`, zakres'
    + ' rejestru zamknięty', async () => {
    const server = await startServer('all-bez-progu', { [CONSENT_CHANNEL_ENV]: 'all' }, MAIN_READY, 'ok');
    try {
      expect((await healthOf(server.port)).body['consent'])
        .toEqual({ configured: 'all', effective: 'shadow', reason: 'min-client-build' });
      expect(aliveMode(server.dataDir)).toBe('shadow');
      expect(aliveMarkers(server.dataDir)).toBeUndefined();
      const reply = await socketCall(consentSocketPath(server.dataDir), 'POST', CONSENT_REGISTER_ROUTE,
        { ...registration(randomBytes(CONSENT_SECRET_BYTES).toString('hex')), agentId: 'agent-1' });
      expect(reply).toMatchObject({ status: 503, body: { error: 'channel-closed' } });
    } finally {
      await server.stop();
    }
  }, 180_000);

  it('świeża instalacja bez `RAROG_CONSENT_CHANNEL`: z hookiem i progiem builda `all` efektywny, bez progu'
    + ' `shadow` z powodem `min-client-build`, bez hooka `shadow` z powodem `missing`', async () => {
    const cases: Array<{ name: string; env: Record<string, string>; hook: HookFixture; effective: string;
      reason: string }> = [
      { name: 'domyslny-pelny', env: { [MIN_CLIENT_BUILD_ENV]: '100' }, hook: 'ok', effective: 'all', reason: 'configured' },
      { name: 'domyslny-bez-progu', env: {}, hook: 'ok', effective: 'shadow', reason: 'min-client-build' },
      { name: 'domyslny-bez-hooka', env: { [MIN_CLIENT_BUILD_ENV]: '100' }, hook: 'none', effective: 'shadow',
        reason: 'missing' },
    ];
    const started = await Promise.all(cases.map((one) => startServer(one.name, one.env, MAIN_READY, one.hook)));
    try {
      for (const [index, one] of cases.entries()) {
        const server = started[index];
        if (server === undefined) throw new Error(one.name);
        expect((await healthOf(server.port)).body['consent'], one.name)
          .toEqual({ configured: 'all', effective: one.effective, reason: one.reason });
        expect(aliveMode(server.dataDir), one.name).toBe(one.effective);
        expect(aliveMarkers(server.dataDir), one.name).toBe(one.effective === 'all' ? true : undefined);
        expect(server.output(), one.name).toContain('shadow: hook consent channel all');
      }
    } finally {
      await Promise.all(started.map((server) => server.stop()));
    }
  }, 180_000);
});

// ── Sprzątanie startu kanału zgód

const CONSENT_SESSION = '3f2b8c1e-5a7d-4e9f-b0c6-2d8e4f6a1b3d';
const keyOf = (seed: string): string => `p${sha('prompt').slice(0, 12)}-${sha(seed).slice(0, 32)}`;
const OLD_KEY = keyOf('stary-rekord');
const YOUNG_KEY = keyOf('mlody-rekord');
const SENT_KEY = keyOf('wyslany');

/** Rekord kanału sprzed restartu (`bootId` poprzedniego procesu) w podanym stanie. */
function consentRecordOf(key: string, state: 'applied' | 'sent', at: number): ConsentRecord {
  return {
    v: 1, key, sessionId: CONSENT_SESSION, promptId: `p${sha('prompt').slice(0, 12)}`, toolName: 'Bash',
    inputSha256: sha(`wejscie-${key}`), cardSha256: sha(`karta-${key}`), agentId: null, pid: 4242,
    hookStartedAt: at - 2_000, bootId: 'poprzedni', state, decision: 'allow', reasonId: 'allow', decisionAt: at - 1_000,
    correlation: state === 'applied' ? 'bound' : 'open', toolUseId: state === 'applied' ? 'toolu_01' : null, cause: null,
    late: false, checkpoint: null,
    times: { pending: at - 1_500, deciding: at - 1_000, sent: at - 1_000, ...(state === 'applied' ? { settled: at } : {}) },
  };
}

/** Plik z czasem modyfikacji `ageMs` wstecz. */
function aged(file: string, ageMs: number): void {
  const at = (Date.now() - ageMs) / 1_000;
  utimesSync(file, at, at);
}

const answerFile = (dataDir: string, name: string): string => path.join(dataDir, CONSENT_DIRNAME, CONSENT_SESSION, name);
const recordFile = (dataDir: string, key: string): string =>
  path.join(dataDir, CONSENT_RECORDS_DIRNAME, CONSENT_SESSION, `${key}.json`);

/**
 * Katalog danych poprzedniego procesu: pliki `consent/` stary i młody, rekordy końcowe stary (ponad retencję)
 * i młody, rekord `sent`, którego hook przejął odpowiedź (`.claimed` z decyzją i `at` rekordu), starsza niż termin
 * pliku odpowiedzi.
 */
function seedConsent(dataDir: string): Promise<void> {
  const now = Date.now();
  mkdirSync(path.join(dataDir, CONSENT_DIRNAME, CONSENT_SESSION), { recursive: true, mode: 0o700 });
  writeFileSync(answerFile(dataDir, `${keyOf('obcy-stary')}.json`), '{}\n');
  aged(answerFile(dataDir, `${keyOf('obcy-stary')}.json`), CONSENT_FILE_TTL_MS + 60_000);
  writeFileSync(answerFile(dataDir, `${keyOf('obcy-mlody')}.json`), '{}\n');
  aged(answerFile(dataDir, `${keyOf('obcy-mlody')}.json`), 60_000);
  writeConsentRecord(dataDir, consentRecordOf(OLD_KEY, 'applied', now - CONSENT_RECORD_RETENTION_MS));
  aged(recordFile(dataDir, OLD_KEY), CONSENT_RECORD_RETENTION_MS + 60_000);
  writeConsentRecord(dataDir, consentRecordOf(YOUNG_KEY, 'applied', now - 60_000));
  const sent = consentRecordOf(SENT_KEY, 'sent', now - CONSENT_FILE_TTL_MS - 120_000);
  writeConsentRecord(dataDir, sent);
  writeFileSync(answerFile(dataDir, `${SENT_KEY}.claimed`), JSON.stringify({ decision: 'allow', at: sent.decisionAt }));
  aged(answerFile(dataDir, `${SENT_KEY}.claimed`), CONSENT_FILE_TTL_MS + 60_000);
  return Promise.resolve();
}

/** Pliki `consent/` i `consent-records/` z `seedConsent` (nazwy względem katalogu danych), posortowane. */
function consentFilesOf(dataDir: string): string[] {
  const out: string[] = [];
  for (const top of [CONSENT_DIRNAME, CONSENT_RECORDS_DIRNAME]) {
    const root = path.join(dataDir, top, CONSENT_SESSION);
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) out.push(`${top}/${name}`);
  }
  return out.sort();
}

const SEEDED = [
  `${CONSENT_DIRNAME}/${keyOf('obcy-mlody')}.json`, `${CONSENT_DIRNAME}/${keyOf('obcy-stary')}.json`,
  `${CONSENT_DIRNAME}/${SENT_KEY}.claimed`, `${CONSENT_RECORDS_DIRNAME}/${OLD_KEY}.json`,
  `${CONSENT_RECORDS_DIRNAME}/${SENT_KEY}.json`, `${CONSENT_RECORDS_DIRNAME}/${YOUNG_KEY}.json`,
].sort();

/** Po starcie w `main`: `.claimed` rozliczony, przeterminowane pliki skasowane, młode zostają. */
const AFTER_MAIN = [
  `${CONSENT_DIRNAME}/${keyOf('obcy-mlody')}.json`, `${CONSENT_RECORDS_DIRNAME}/${SENT_KEY}.json`,
  `${CONSENT_RECORDS_DIRNAME}/${YOUNG_KEY}.json`,
].sort();

describe('`recoverThenSweepConsent`: sprzątanie startu tylko po udanym odzyskaniu rekordów', () => {
  it('udany `recover` widzi `.claimed` rekordu `sent`, potem przeterminowane pliki znikają, a młode zostają',
  async () => {
    await seedConsent(dir);
    const lines: string[] = [];
    const failures: unknown[] = [];
    let seenAtRecover: string[] = [];
    const ok = await recoverThenSweepConsent(() => {
      seenAtRecover = consentFilesOf(dir);
      return Promise.resolve({ records: 3, changed: 1 });
    }, dir, { info: (line) => { lines.push(line); }, failed: (err) => { failures.push(err); } });
    expect(ok).toBe(true);
    expect(seenAtRecover).toEqual(SEEDED);
    expect(consentFilesOf(dir)).toEqual(AFTER_MAIN);
    expect(lines).toEqual([
      'consent: recovered 3 records, 1 changed', 'consent: start cleanup — consent/ 2, consent-records/ 1',
    ]);
    expect(failures).toEqual([]);
  });

  it('`recover` rzuca (atrapa): błąd do `failed`, żaden plik nie znika, bez linii sprzątania', async () => {
    await seedConsent(dir);
    const lines: string[] = [];
    const failures: unknown[] = [];
    const broken = new Error('atrapa: odzyskanie nie wyszło');
    const ok = await recoverThenSweepConsent(() => Promise.reject(broken), dir,
      { info: (line) => { lines.push(line); }, failed: (err) => { failures.push(err); } });
    expect(ok).toBe(false);
    expect(failures).toEqual([broken]);
    expect(lines).toEqual([]);
    expect(consentFilesOf(dir)).toEqual(SEEDED);
  });
});

describe('prawdziwy serwer: sprzątanie startu kanału zgód tylko przy cyklu (`main`), po `recover`', () => {
  it('start w `off` albo `shadow` ze starym `.claimed` i rekordem `sent` niczego nie kasuje; następny start w `main`'
    + ' najpierw rozlicza `.claimed` (`claimed`, nie `revoked: restart`), potem kasuje przeterminowane pliki',
  async () => {
    const cases = [
      { name: 'sprzatanie-off', env: { [CONSENT_CHANNEL_ENV]: 'off' } },
      { name: 'sprzatanie-shadow', env: { [CONSENT_CHANNEL_ENV]: 'shadow' } },
    ] as const;
    // Stan po poprzednim procesie w `main` (rekordy z `bootId` „poprzedni”), potem start bez cyklu.
    const without = await Promise.all(
      cases.map((one) => startServer(one.name, one.env, 'listening on', 'ok', seedConsent)));
    try {
      for (const [index, one] of cases.entries()) {
        const server = without[index];
        if (server === undefined) throw new Error(one.name);
        expect(consentFilesOf(server.dataDir), one.name).toEqual(SEEDED);
        expect(readConsentRecords(server.dataDir).find((record) => record.key === SENT_KEY), one.name)
          .toMatchObject({ state: 'sent', cause: null });
        expect(server.output(), one.name).not.toContain('consent: start cleanup — consent/');
      }
    } finally {
      await Promise.all(without.map((server) => server.stop()));
    }

    // Ten sam katalog danych, start w `main`: odzyskanie widzi `.claimed`, sprzątanie dopiero po nim.
    const withCycle = await Promise.all(cases.map((one) => startServer(one.name, MAIN_ENV, 'listening on', 'ok')));
    try {
      for (const [index, one] of cases.entries()) {
        const server = withCycle[index];
        if (server === undefined) throw new Error(one.name);
        const { dataDir } = server;
        expect(readConsentRecords(dataDir).find((record) => record.key === SENT_KEY), one.name)
          .toMatchObject({ state: 'claimed', cause: null });
        expect(consentFilesOf(dataDir), one.name).toEqual(AFTER_MAIN);
        expect(server.output(), one.name).toContain('consent: start cleanup — consent/ 2, consent-records/ 1');
        expect(server.output(), one.name).not.toContain('record recovery failed');
      }
    } finally {
      await Promise.all(withCycle.map((server) => server.stop()));
    }
  }, 240_000);
});
