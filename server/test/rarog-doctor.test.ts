/**
 * `rarog doctor`: stany linii, porównanie środowiska żywego
 * serwera z konfiguracją, wystąpienie próbne, stan usługi launchd, sekret nigdy na ekranie, linia nasłuchu iroh
 * w czterech stanach.
 *
 * Wszystko na atrapach: `launchctl` (tylko `print`, stan z pliku), `lsof` i `ps` (wyjście z plików), `/health`
 * z serwera HTTP testu, `GET /api/admin/iroh` z serwera HTTP testu na gnieździe administracyjnym. `HOME`
 * tymczasowy; `afterAll` sprawdza, że realne katalogi `rarog` nie powstały.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSocketPath } from '../src/auth/admin.ts';
import {
  compareServerEnv, installationLine, irohLineOf, parsePsEnvironment, rarogInPathLine,
} from '../src/cli/doctor.ts';
import type { AdminRead, InstallationInput, IrohModuleRead, Line } from '../src/cli/doctor.ts';
import type { CliIo } from '../src/cli/io.ts';
import { HERDR_AGENT_LABEL, herdrAgentPlistPath, renderHerdrAgentPlist } from '../src/cli/setup-herdr-agent.ts';
import { packageCommands } from '../src/install/repair.ts';
import { IROH_PACKAGE, irohModuleInfo, irohPlatform } from '../src/iroh/adapter.ts';
import { SDK_PACKAGE, readSdkPin } from '../src/install/sdk.ts';
import { servePath } from '../src/cli/serve.ts';
import { RAROG_BIN, renderServicePlist } from '../src/cli/service.ts';
import { RAROG_VERSION } from '../src/version.ts';
import {
  HOOK_INSTALL_FILES, STATUSLINE_INSTALL_FILES, hookBlock, hookCommand, hookInstallDir,
  statuslineCommand, userSettingsPath, writeBlockRules,
} from '../src/herdr/hook-config.ts';
import { OLD_ENTRY_FILE } from '../src/herdr/hook-commands.ts';
import { IS_MAC, macOnly } from './platform.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import { fakePackage } from './rarog-service-sandbox.ts';
import type { TempHome } from './rarog-home.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'rarog.mjs');
const FAKE_SECRET = 'TEST-ONLY-sekret-doctora-xxxxxxxxxxxxxxxx';
const OTHER_TOKEN = 'inny-sztuczny-token-serwera-fedcba9876543210';
const SERVER_ID = '0123456789abcdef0123456789abcdef';
const PID = '4242';
const COMMAND = '/opt/node/bin/node --require /repo/node_modules/tsx/dist/preflight.cjs server/src/index.ts';

let home: TempHome;
let dir = '';
let bin = '';
let logs = '';
let health: HttpServer | null = null;
let herdr: NetServer | null = null;
let healthBody: unknown = {};
let port = 0;

beforeEach(async () => {
  home = tempHome('rarog-doctor-');
  dir = home.home;
  bin = path.join(dir, 'atrapy');
  logs = path.join(dir, 'logi');
  mkdirSync(bin);
  mkdirSync(logs);
  mkdirSync(path.join(dir, 'tmp'));
  const fake = (name: string, lines: string[]): void => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${lines.join('\n')}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  fake('launchctl', [
    `printf '%s\\n' "$*" >> '${logs}/launchctl'`,
    `touch '${logs}/loaded'`,
    `if [ "$1" = print ] && [ -f '${logs}/launchctl-odmowa' ]; then echo "Operation not permitted" >&2; exit 1; fi`,
    `if [ "$1" = print ]; then grep -qxF "\${2##*/}" '${logs}/loaded' && exit 0 || exit 113; fi`,
    'exit 1',
  ]);
  fake('lsof', [
    `printf '%s\\n' "$*" >> '${logs}/lsof-wywolania'`,
    `if [ -f '${logs}/lsof' ]; then cat '${logs}/lsof'; exit 0; fi`,
    'exit 1',
  ]);
  fake('ps', [
    `if [ -f '${logs}/ps-pada' ]; then echo "ps: operation not permitted" >&2; exit 1; fi`,
    `if [ "$1" = -Eww ]; then cat '${logs}/ps-env'; else cat '${logs}/ps-cmd'; fi`,
  ]);
  healthBody = { ok: true, version: RAROG_VERSION, uptime: 1, herdr: true, term: true, hook: 'ok', authStore: 'ok' };
  health = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(healthBody));
  });
  await new Promise<void>((resolve) => { health?.listen(0, '127.0.0.1', resolve); });
  const address = health.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => { if (health === null) resolve(); else health.close(() => { resolve(); }); });
  await new Promise<void>((resolve) => { if (herdr === null) resolve(); else herdr.close(() => { resolve(); }); });
  health = null;
  herdr = null;
  home.cleanup();
});

afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const write = (file: string, text: string, mode = 0o644): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode });
};
const configDir = (): string => path.join(dir, '.config', 'rarog');
const agents = (): string => path.join(dir, 'Library', 'LaunchAgents');
const herdrSocket = (): string => path.join(dir, 'h.sock');
const dataDir = (): string => path.join(dir, '.local', 'share', 'rarog');
const roots = '/Users/znajomy/My Projects';
/** `TMPDIR` testu: prawdziwy katalog (tsx w procesie `doctor` trzyma tam pamięć podręczną). */
const tmp = (): string => `${path.join(dir, 'tmp')}/`;

/** Gniazdo „herdr” testu; błąd `listen` przewraca test, a nie proces vitest. */
async function listenHerdr(socket: string): Promise<void> {
  mkdirSync(path.dirname(socket), { recursive: true });
  herdr = createNetServer();
  await new Promise<void>((resolve, reject) => {
    herdr?.once('error', reject);
    herdr?.listen(socket, resolve);
  });
}

/** Środowisko `doctor`: jawne, bez zmiennych procesu testów (żadnych sekretów, żadnego `RAROG_*`). */
function doctorEnv(extraPath: string[] = []): NodeJS.ProcessEnv {
  return {
    PATH: [bin, ...extraPath, '/usr/bin', '/bin'].join(':'),
    HOME: dir, USER: 'znajomy', LOGNAME: 'znajomy', SHELL: '/bin/zsh', TMPDIR: tmp(),
  };
}

/**
 * `config.json` of the test. `RAROG_PR_STATUS=0` by default: the PR status line would otherwise look for the real `gh`
 * of this machine (`/opt/homebrew/bin`); its four states have their own test (`doctor-pr-status.test.ts`).
 */
function writeConfig(env: Record<string, string>, wrapper: string[] | null = null): void {
  write(path.join(configDir(), 'config.json'), JSON.stringify({
    version: 1, env: { RAROG_PR_STATUS: '0', ...env }, ...(wrapper === null ? {} : { service: { wrapper } }),
  }));
}

/** Środowisko żywego serwera tak, jak pokazuje je `ps -E` (po poleceniu), dla wartości oczekiwanych. */
function liveEnv(overrides: Record<string, string | null> = {}): string {
  const base: Record<string, string | null> = {
    RAROG_ORIGINS: 'https://rarog.example.net',
    RAROG_PORT: String(port),
    RAROG_PROJECT_ROOTS: roots,
    RAROG_HERDR_SOCKET: herdrSocket(),
    RAROG_PR_STATUS: '0',
    SONIOX_API_KEY: FAKE_SECRET,
    HOME: dir, SHELL: '/bin/zsh', USER: 'znajomy', LOGNAME: 'znajomy', LANG: 'en_US.UTF-8',
    TMPDIR: tmp(),
    PATH: servePath(process.execPath),
    RAROG_DATA_DIR: '', XDG_DATA_HOME: '',
    NODE_PATH: '/repo/node_modules/.pnpm/node_modules', PWD: REPO, SHLVL: '0',
    __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
    ...overrides,
  };
  return Object.entries(base).filter(([, value]) => value !== null).map(([name, value]) => `${name}=${value}`)
    .join(' ');
}

function serverProcess(env: string): void {
  writeFileSync(path.join(logs, 'lsof'), `${PID}\n${PID}\n`);
  writeFileSync(path.join(logs, 'ps-cmd'), `${COMMAND}\n`);
  writeFileSync(path.join(logs, 'ps-env'), `${COMMAND} ${env}\n`);
}

/** Pliki z `scripts/hooks/` repo do kopii w `HOME` testu (`~/.claude/hooks/rarog/`), pod tymi samymi nazwami. */
function copyFromRepo(names: readonly string[]): void {
  mkdirSync(hookInstallDir(dir), { recursive: true });
  for (const name of names) {
    copyFileSync(path.join(REPO, 'scripts', 'hooks', name), path.join(hookInstallDir(dir), name));
  }
}

/** The write block rules `rarog setup` writes for this installation. */
function writeBlock(): readonly string[] {
  const built = writeBlockRules(dataDir(), dir);
  if (!built.ok) throw new Error(built.reason);
  return built.rules;
}

/** Instalacja „wszystko zielone”: usługa `ai.rarog.server`, konfiguracja, sekret w pliku, hook, statusLine, herdr. */
async function greenInstall(): Promise<void> {
  writeConfig({
    RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port), RAROG_PROJECT_ROOTS: roots,
    RAROG_HERDR_SOCKET: herdrSocket(),
  });
  write(path.join(configDir(), 'secret', 'private.env'), `SONIOX_API_KEY=${FAKE_SECRET}\n`, 0o600);
  chmodSync(path.join(configDir(), 'secret'), 0o700);
  writeFileSync(path.join(logs, 'loaded'), 'ai.rarog.server\n');
  write(path.join(agents(), 'ai.rarog.server.plist'), renderServicePlist({
    programArguments: [process.execPath, RAROG_BIN, 'serve'], workingDirectory: REPO,
    log: path.join(dataDir(), 'server.log'),
  }));
  write(path.join(dataDir(), 'devices.json'), JSON.stringify({ version: 1, serverId: SERVER_ID, devices: [] }));
  // Kopia hooka zgodna z repo, bez gita: stan po `hooks install` niezależny od niezacommitowanych zmian w checkoutcie.
  copyFromRepo(HOOK_INSTALL_FILES);
  write(userSettingsPath(dir), JSON.stringify({
    ...(hookBlock(hookCommand(dir)) as object),
    statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
    permissions: { deny: writeBlock() },
  }, null, 2));
  write(path.join(dir, '.claude', 'statusline', 'sesja.json'), '{}');
  mkdirSync(path.join(dir, '.local', 'bin'), { recursive: true });
  symlinkSync(RAROG_BIN, path.join(dir, '.local', 'bin', 'rarog'));
  await listenHerdr(herdrSocket());
  serverProcess(liveEnv());
}

interface Run { status: number | null; stdout: string; stderr: string }

/** `doctor` w procesie potomnym, ASYNCHRONICZNIE: `/health` odpowiada serwer w tym procesie testów. */
function doctor(args: string[] = [], env: NodeJS.ProcessEnv = doctorEnv([path.join(dir, '.local', 'bin')])):
  Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'doctor', ...args], { cwd: dir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (status) => { resolve({ status, stdout, stderr }); });
  });
}

/** Linie z danym znacznikiem (`ok`, `ERROR`, `unknown`, `warn`, `info`) — sam tekst po znaczniku. */
function marked(run: Run, mark: 'ok' | 'ERROR' | 'unknown' | 'warn' | 'info'): string[] {
  return run.stdout.split('\n').filter((line) => line.startsWith(mark.padEnd(8, ' ')))
    .map((line) => line.slice(10));
}

describe('podział linii ps -E i porównanie (jednostkowo)', () => {
  const expected = {
    RAROG_PROJECT_ROOTS: roots, RAROG_PORT: '8930', SONIOX_API_KEY: FAKE_SECRET, RAROG_DATA_DIR: '', HOME: '/h',
  };

  it('wartość ze spacją zostaje jedną wartością; pomijane i __CF_* nie są różnicą', () => {
    const live = parsePsEnvironment(`RAROG_PROJECT_ROOTS=${roots} RAROG_PORT=8930 SONIOX_API_KEY=${FAKE_SECRET}`
      + ' HOME=/h NODE_PATH=/n PWD=/p SHLVL=0 __CF_USER_TEXT_ENCODING=0x1F5:0x0:0x0');
    expect(live.values.get('RAROG_PROJECT_ROOTS')).toBe(roots);
    expect(live.unknownLead).toEqual([]);
    expect(compareServerEnv(expected, live, { wrapper: false })).toEqual({ diffs: [], unsure: [] });
  });

  it('inna wartość: obie widać; sekret: sama nazwa, nigdy wartość', () => {
    const live = parsePsEnvironment(`RAROG_PROJECT_ROOTS=/Users/znajomy/Projects RAROG_PORT=8930 HOME=/h`);
    const { diffs } = compareServerEnv(expected, live, { wrapper: false });
    expect(diffs).toEqual([
      `RAROG_PROJECT_ROOTS: expected «${roots}», server «/Users/znajomy/Projects»`,
      'SONIOX_API_KEY: the secrets file has it, the server does not',
    ]);
    const extra = compareServerEnv({ HOME: '/h' }, parsePsEnvironment(`HOME=/h SONIOX_API_KEY=${OTHER_TOKEN}`),
      { wrapper: false });
    expect(extra.diffs.join('\n')).toContain('SONIOX_API_KEY: the server has it');
    expect(extra.diffs.join('\n')).not.toContain(OTHER_TOKEN);
    // Z service.wrapperem sekret spoza pliku daje wrapper: to nie różnica.
    expect(compareServerEnv({ HOME: '/h' }, parsePsEnvironment(`HOME=/h SONIOX_API_KEY=${OTHER_TOKEN}`),
      { wrapper: true })).toEqual({ diffs: [], unsure: [] });
  });

  it('niepusty katalog danych w serwerze = różnica z powodem; nazwa spoza rejestru wartości nie wypisuje', () => {
    const { diffs } = compareServerEnv(expected, parsePsEnvironment(`XPC_FLAGS=0x0 RAROG_PROJECT_ROOTS=${roots}`
      + ` RAROG_PORT=8930 VAULT_TOKEN=${OTHER_TOKEN} SONIOX_API_KEY=${FAKE_SECRET} RAROG_DATA_DIR=/inny HOME=/h`),
    { wrapper: false });
    expect(diffs[0]).toBe('variables outside the registry in the server environment: XPC_FLAGS');
    expect(diffs.join('\n')).toContain('RAROG_DATA_DIR non-empty in the server: the hook in Claude sessions computes'
      + ' the data directory');
    expect(diffs.join('\n')).toContain('RAROG_PORT: a variable outside the registry follows the value (VAULT_TOKEN)');
    expect(diffs.join('\n')).not.toContain(OTHER_TOKEN);
    expect(diffs.join('\n')).not.toContain(FAKE_SECRET);
    // RAROG_DATA_DIR stoi w odczycie po sklejonej nazwie i po sekrecie: jego wartość nie pada na ekran.
    expect(diffs.join('\n')).not.toContain('/inny');
  });

  it('wartość sekretu z „ NAZWA=” w środku nie wycieka jako wartość jawnej zmiennej', () => {
    const want = { HOME: '/h', PATH: '/usr/bin:/bin', SONIOX_API_KEY: FAKE_SECRET };
    const leaks = [
      // Sekret z rejestru, PATH nie ma osobno: odcinek „PATH=…” to fragment sekretu.
      'HOME=/h SONIOX_API_KEY=prefix PATH=TAJNY_FRAGMENT',
      // Nazwa spoza rejestru sklejona z HOME: dalszy odcinek też może być jej wartością.
      'HOME=/h VAULT_TOKEN=prefix PATH=TAJNY_FRAGMENT',
      // Łańcuch: po sekrecie dwie znane nazwy — obie mogą być jego wartością.
      'SONIOX_API_KEY=prefix HOME=TAJNY_FRAGMENT PATH=TAJNY_FRAGMENT',
    ];
    for (const text of leaks) {
      const { diffs, unsure } = compareServerEnv(want, parsePsEnvironment(text), { wrapper: false });
      const shown = [...diffs, ...unsure].join('\n');
      expect(shown, text).not.toContain('TAJNY');
      expect(shown, text).not.toContain('prefix');
      expect(shown, text).toContain('PATH: expected «/usr/bin:/bin», the server has another value (value from ps not shown');
    }
    // Ta sama nazwa dwa razy (fragment sekretu + prawdziwa zmienna) = „nie wiem”, bez wartości i bez różnicy.
    const twice = compareServerEnv(want,
      parsePsEnvironment(`HOME=/h SONIOX_API_KEY=prefix PATH=TAJNY_FRAGMENT PATH=/usr/bin:/bin`), { wrapper: false });
    expect(twice.diffs).toEqual([]);
    expect(twice.unsure).toEqual(['PATH: appears more than once in the ps output (one occurrence is part of'
      + ' another value) — not compared, not shown']);
  });
});


/** Nasłuch iroh: sztuczne wartości; prawdziwego klucza ani EndpointId testy nie znają. */
const IROH_ID = 'e0'.repeat(32);
const IROH_RELAY = 'https://relay.example./';
const FAKE_IROH_KEY = '5a'.repeat(32);
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const SOCKET = '/dane/run/admin.sock';
const MODULE_OK: IrohModuleRead = {
  version: '1.2.0', platformPackage: `${IROH_PACKAGE}-darwin-arm64`, platformVersion: '1.2.0',
};

/** Stan nasłuchu z `GET /api/admin/iroh` w kształcie `irohAdminStatus` (bez klucza). */
function listening(relays: string[], since: string | null, extra: Record<string, unknown> = {}): AdminRead {
  return {
    status: 200,
    body: {
      enabled: true, endpointId: IROH_ID, relay: IROH_RELAY, port: 7842, boundSockets: ['0.0.0.0:7842', '[::]:7842'],
      homeRelay: { relays, since }, connections: { authenticated: 1, unauthenticated: 2 }, handshakes: 0, streams: 3,
      pendingCloseOps: 0, refusals: {}, module: MODULE_OK, ...extra,
    },
  };
}

describe('linia iroh (jednostkowo, `irohLineOf`)', () => {
  const line = (flag: string, read: AdminRead | null, module: IrohModuleRead = MODULE_OK, socket: string | null = SOCKET) =>
    irohLineOf({ flag, socket, read, module: () => module, now: NOW });
  const missing: AdminRead = { failure: 'ENOENT', denied: false };

  it('wyłączone: „info” z paczką i modułem z manifestu, bez pytania o moduł przy nasłuchu', () => {
    for (const flag of ['', '0']) {
      expect(line(flag, missing)).toEqual({
        verdict: 'info',
        text: `iroh: off (RAROG_IROH is not 1); package ${IROH_PACKAGE} 1.2.0, module ${IROH_PACKAGE}-darwin-arm64`
          + ' 1.2.0',
      });
    }
    expect(line('', { status: 200, body: { enabled: false } }).verdict).toBe('info');
    expect(line('', { status: 404, body: null }).verdict).toBe('info');
    expect(line('', missing, { version: null, platformPackage: null, platformVersion: null }).text)
      .toBe(`iroh: off (RAROG_IROH is not 1); package ${IROH_PACKAGE} missing`);
    expect(line('', missing, { version: '1.2.0', platformPackage: null, platformVersion: null }).text)
      .toBe(`iroh: off (RAROG_IROH is not 1); package ${IROH_PACKAGE} 1.2.0, but ${irohPlatform()} has no`
        + ' native module');
    // Linia nasłuchu nie czyta manifestu.
    expect(irohLineOf({
      flag: '1', socket: SOCKET, read: listening([IROH_RELAY], null), now: NOW,
      module: () => { throw new Error('manifest czytany bez potrzeby'); },
    }).verdict).toBe('ok');
  });

  it('włączone i nasłuch działa: zielone ze skróconym EndpointId, relayem, wiekiem zdarzenia i połączeniami', () => {
    const ok = line('1', listening([IROH_RELAY], new Date(NOW - 42_000).toISOString()));
    expect(ok).toEqual({
      verdict: 'ok',
      text: `iroh: listener running, EndpointId ${IROH_ID.slice(0, 12)}…, relay ${IROH_RELAY} (last event 42 s`
        + ' ago), connections: 1 with a device, 2 without, UDP 0.0.0.0:7842 [::]:7842',
    });
    // Zaległe operacje zamknięcia i konfiguracja bez flagi przy słuchającym serwerze: szczegóły pod linią.
    const busy = line('', listening([IROH_RELAY], null, { pendingCloseOps: 3 }));
    expect(busy.verdict).toBe('ok');
    expect(busy.text).toContain('(no events since start)');
    expect(busy.details).toEqual([
      'the config has no RAROG_IROH=1 — after a restart the server will not listen on iroh',
      'stream close operations in progress: 3 (growing between doctor runs = the library is stuck)',
    ]);
  });

  it('relay bez adresu: żółte „uwaga” z jedynym sygnałem i naprawą; od startu albo od ostatniego zdarzenia', () => {
    const fresh = line('1', listening([], null));
    expect(fresh.verdict).toBe('warn');
    expect(fresh.text).toBe(`iroh: listener running, EndpointId ${IROH_ID.slice(0, 12)}…, but no relay address since`
      + ' server start; connections: 1 with a device, 2 without');
    expect(fresh.details?.[0]).toContain(`a missing address is the only sign that relay ${IROH_RELAY} is unreachable`);
    expect(fresh.repair).toContain('check RAROG_IROH_RELAY');
    expect(line('1', listening([], new Date(NOW - 90_000).toISOString())).text).toContain('no relay address for 90 s');
  });

  it('first contact with the relay: waiting up to 120 s is info, then a warning with the address and pairing sentence', () => {
    const startedAt = (ago: number): string => new Date(NOW - ago * 1000).toISOString();
    const waiting = line('1', listening([], null, { relayContact: { startedAt: startedAt(60), firstContactAt: null } }));
    expect(waiting).toEqual({
      verdict: 'info',
      text: `iroh: listener running, EndpointId ${IROH_ID.slice(0, 12)}…, waiting for the first contact with relay`
        + ` ${IROH_RELAY} (60 s since start); connections: 1 with a device, 2 without`,
    });
    const late = line('1', listening([], null, { relayContact: { startedAt: startedAt(130), firstContactAt: null } }));
    expect(late).toMatchObject({
      verdict: 'warn',
      text: `iroh: listener running, EndpointId ${IROH_ID.slice(0, 12)}…, but relay ${IROH_RELAY} has not accepted`
        + ' the connection for 130 s; connections: 1 with a device, 2 without',
    });
    expect(late.repair).toBe('check the address in RAROG_IROH_RELAY (DNS, HTTPS, firewall); a relay that admits only'
      + ' registered servers lets this server in after a device pairs with it (rarog pair)');
    // After the contact: as before, the home relay address and the age of its event.
    const contact = { relayContact: { startedAt: startedAt(300), firstContactAt: startedAt(298) } };
    expect(line('1', listening([IROH_RELAY], startedAt(42), contact)).verdict).toBe('ok');
    expect(line('1', listening([], startedAt(42), contact)).text).toContain('no relay address for 42 s');
    // A server without a relay in the configuration (`relayContact: null`): as before.
    expect(line('1', listening([], null, { relayContact: null })).text).toContain('no relay address since server start');
  });

  it('włączone bez nasłuchu albo modułu: czerwone z przyczyną i naprawą', () => {
    const down = line('1', missing);
    expect(down).toMatchObject({
      verdict: 'bad',
      text: `iroh: RAROG_IROH=1, but no listener — the server does not respond on the admin socket ${SOCKET}`
        + ' (ENOENT)',
    });
    expect(down.repair).toContain('rarog serve --check');
    expect(line('1', { status: 200, body: { enabled: false } }).text)
      .toContain('the server runs without the iroh listener (started before the config change?)');
    expect(line('1', { status: 404, body: null }).text).toContain('the server does not know GET /api/admin/iroh');
    const noModule = line('1', missing, { version: '1.2.0', platformPackage: `${IROH_PACKAGE}-darwin-arm64`,
      platformVersion: null });
    expect(noModule).toMatchObject({
      verdict: 'bad',
      text: `iroh: RAROG_IROH=1, but the native module is missing: package ${IROH_PACKAGE} 1.2.0, but`
        + ` ${IROH_PACKAGE}-darwin-arm64 is missing`,
      details: [`the server does not respond on the admin socket ${SOCKET} (ENOENT)`],
    });
    expect(noModule.repair).toContain('pnpm install');
    expect(line('tak', missing)).toMatchObject({ verdict: 'bad', text: expect.stringContaining('RAROG_IROH=tak') });
  });

  it('gniazdo niedostępne (sandbox) albo katalog danych w konflikcie przy włączonym = „nie wiem”', () => {
    expect(line('1', { failure: 'EPERM', denied: true }).verdict).toBe('unknown');
    expect(line('1', null, MODULE_OK, null).verdict).toBe('unknown');
  });
});

describe('linia instalacji i rarog w PATH (jednostkowo)', () => {
  const NPM_ROOT = '/usr/local/lib/node_modules/rarog';
  const PNPM_ROOT = '/home/u/.local/share/pnpm/store/v11/links/@/rarog/1.0.0/abc123/node_modules/rarog';
  const input = (over: Partial<InstallationInput>): InstallationInput => ({
    mode: 'package', root: NPM_ROOT, home: '/Users/u', version: '1.0.0', writable: () => true, ...over,
  });
  const UNDER_HOME = 'installation directory under /Users/u: a Claude Code session with write access to the home'
    + ' directory can change the code the service runs outside the sandbox';

  it('tryb, katalog i wersja jako „info”; menedżer paczki z układu katalogu', () => {
    expect(installationLine(input({ mode: 'clone', root: '/srv/rarog' })))
      .toEqual({ verdict: 'info', text: 'installation: repo clone /srv/rarog, version 1.0.0' });
    expect(installationLine(input({}))).toEqual({
      verdict: 'info', text: `installation: npm package (npm) ${NPM_ROOT}, version 1.0.0`,
    });
    expect(installationLine(input({ root: PNPM_ROOT })).text)
      .toBe(`installation: npm package (pnpm) ${PNPM_ROOT}, version 1.0.0`);
    expect(installationLine(input({ root: '/opt/inne/rarog' })).text)
      .toBe('installation: npm package /opt/inne/rarog, version 1.0.0');
  });

  it('katalog pod domem: dopisek o sandboksie, w paczce z radą Node poza domem; werdykt bez zmian', () => {
    const clone = installationLine(input({ mode: 'clone', root: '/Users/u/Projects/rarog' }));
    expect(clone).toEqual({
      verdict: 'info', text: 'installation: repo clone /Users/u/Projects/rarog, version 1.0.0', details: [UNDER_HOME],
    });
    const nvm = installationLine(input({ root: '/Users/u/.nvm/versions/node/v22.22.3/lib/node_modules/rarog' }));
    expect(nvm.verdict).toBe('info');
    expect(nvm.details).toEqual([`${UNDER_HOME}; Node outside the home directory (e.g. Homebrew) narrows this`]);
    // Katalog o nazwie z prefiksem domu to nie dom.
    expect(installationLine(input({ home: '/home/u', root: '/home/u2/lib/node_modules/rarog' })).details).toBeUndefined();
  });

  it('paczka z katalogiem nadrzędnym bez prawa zapisu = „uwaga” z aktualizacją menedżera; klon tego nie sprawdza', () => {
    const asked: string[] = [];
    const line = installationLine(input({ writable: (dir) => { asked.push(dir); return false; } }));
    expect(asked).toEqual(['/usr/local/lib/node_modules']);
    expect(line).toEqual({
      verdict: 'warn', text: `installation: npm package (npm) ${NPM_ROOT}, version 1.0.0`,
      repair: `/usr/local/lib/node_modules is not writable — ${packageCommands('npm', NPM_ROOT).update} will fail with`
        + ' EACCES; use a Node version manager (e.g. nvm), not sudo',
    });
    expect(installationLine(input({ mode: 'clone', root: '/srv/rarog', writable: () => false })).verdict).toBe('info');
  });

  /** Plik wykonywalny `<katalog>/bin/rarog.mjs` w `HOME` testu: wejście instalacji. */
  function entry(name: string): string {
    const file = path.join(dir, name, 'bin', 'rarog.mjs');
    write(file, '', 0o755);
    return realpathSync(file);
  }
  /** Katalog `PATH` z poleceniem `rarog`: dowiązanie do `target` albo skrypt sh (polecenie pnpm). */
  function command(name: string, target: string | null): string {
    const at = path.join(dir, name);
    mkdirSync(at, { recursive: true });
    if (target === null) write(path.join(at, 'rarog'), '#!/bin/sh\nexec node rarog.mjs "$@"\n', 0o755);
    else symlinkSync(target, path.join(at, 'rarog'));
    return realpathSync(at);
  }
  const io = (dirs: string[]): CliIo => ({ stdout: () => {}, stderr: () => {}, env: { PATH: dirs.join(':') }, cwd: dir });

  it('rarog w PATH (paczka): wejście innej instalacji przed paczką = „uwaga”; ta paczka albo skrypt pnpm = ok', () => {
    const pkg = entry('paczka');
    const clone = entry('klon');
    const local = command('lokalne-bin', clone);
    const npm = command('npm-bin', pkg);
    const pnpm = command('pnpm-bin', null);
    expect(rarogInPathLine(io([local, npm]), dir, 'package', pkg)).toEqual({
      verdict: 'warn', text: `rarog in PATH: ${local}/rarog → ${clone}, but this installation is ${pkg} — it shadows`
        + ' the package',
      repair: `remove the other installation's symlink (rm ${local}/rarog) or reorder PATH`,
    });
    expect(rarogInPathLine(io([npm, local]), dir, 'package', pkg))
      .toEqual({ verdict: 'ok', text: `rarog in PATH: ${npm}/rarog → ${pkg}` });
    expect(rarogInPathLine(io([pnpm, local]), dir, 'package', pkg))
      .toEqual({ verdict: 'ok', text: `rarog in PATH: ${pnpm}/rarog` });
    // Klon nie ocenia cudzego wejścia: dowiązanie ~/.local/bin/rarog to jego własne polecenie.
    expect(rarogInPathLine(io([local, npm]), dir, 'clone', pkg).verdict).toBe('ok');
  });

  it('brak rarog w PATH: w paczce katalog poleceń menedżera, bez dowiązania i `node bin/rarog.mjs`; klon bez zmian', () => {
    const empty = io([path.join(dir, 'pusty')]);
    const missing = (repair: string): Line => ({ verdict: 'bad', text: 'rarog in PATH: missing', repair });
    expect(rarogInPathLine(empty, dir, 'package', '/opt/n/lib/node_modules/@rarog/server/bin/rarog.mjs'))
      .toEqual(missing('add /opt/n/bin (the npm bin directory: npm prefix -g, then /bin) to PATH in your shell profile'));
    expect(rarogInPathLine(empty, dir, 'package', `${PNPM_ROOT}/bin/rarog.mjs`))
      .toEqual(missing('add the pnpm bin directory (pnpm bin -g) to PATH in your shell profile'));
    expect(rarogInPathLine(empty, dir, 'package', path.join(dir, 'paczka', 'bin', 'rarog.mjs'))).toEqual(missing(
      'add the package manager bin directory to PATH (npm: npm prefix -g, then /bin; pnpm: pnpm bin -g)'));
    // Klon: polecenie to dowiązanie ~/.local/bin/rarog z `service install`.
    const link = path.join(dir, '.local', 'bin', 'rarog');
    expect(rarogInPathLine(empty, dir, 'clone', RAROG_BIN)).toEqual(missing(
      `rarog service install creates the symlink ${link} → ${RAROG_BIN}; until then node bin/rarog.mjs`));
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(RAROG_BIN, link);
    expect(rarogInPathLine(empty, dir, 'clone', RAROG_BIN)).toEqual({
      verdict: 'bad', text: `rarog in PATH: symlink ${link} exists, but ${path.dirname(link)} is not in PATH`,
      repair: `add ${path.dirname(link)} to PATH in your shell profile`,
    });
    // Paczka: stare dowiązanie klonu poza PATH nie zmienia rady (dopisanie ~/.local/bin przesłoniłoby paczkę).
    expect(rarogInPathLine(empty, dir, 'package', '/opt/n/lib/node_modules/@rarog/server/bin/rarog.mjs'))
      .toEqual(missing('add /opt/n/bin (the npm bin directory: npm prefix -g, then /bin) to PATH in your shell profile'));
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog doctor na atrapach', 'launchd'), { timeout: 60_000 }, () => {
  it('wszystko zielone: dziesięć linii ok z SDK, kod 0, sekret nie pada na ekran', async () => {
    await greenInstall();
    const run = await doctor();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(marked(run, 'ERROR')).toEqual([]);
    expect(marked(run, 'unknown')).toEqual([]);
    const ok = marked(run, 'ok');
    expect(ok).toHaveLength(10);
    expect(ok[1]).toBe(`service: ai.rarog.server loaded, node ${process.execPath}`);
    expect(ok[2]).toBe(`data directory: ${dataDir()} (default); serverId 01234567…`);
    expect(ok[3]).toBe(`SDK: from the workspace (${SDK_PACKAGE} ${readSdkPin().version})`);
    expect(ok[4]).toContain(`process ${PID}`);
    expect(ok[4]).toContain('secrets present: SONIOX_API_KEY');
    expect(run.stdout).toContain('result: ok 10, ERROR 0, unknown 0');
    expect(run.stdout + run.stderr).not.toContain(FAKE_SECRET);
    // `doctor` tylko pyta launchd.
    expect(readCalls('launchctl').every((call) => call.startsWith('print '))).toBe(true);
  });

  it('the herdr agent\'s plist present: a line of its own, info keeps code 0; without it no line', async () => {
    await greenInstall();
    write(herdrAgentPlistPath(dir), renderHerdrAgentPlist({ herdr: process.execPath, home: dir, socket: herdrSocket() }));
    writeFileSync(path.join(logs, 'loaded'), `ai.rarog.server\n${HERDR_AGENT_LABEL}\n`);
    const run = await doctor();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    // Loaded without a pid in the printout while herdr answers: herdr runs outside the agent.
    expect(marked(run, 'info')).toContain(`herdr agent: ${HERDR_AGENT_LABEL} herdr runs outside the agent`);
    expect(readCalls('launchctl').every((call) => call.startsWith('print '))).toBe(true);
  });

  it('herdr down with the herdr agent loaded and not running: both lines advise launchctl kickstart', async () => {
    await greenInstall();
    // herdr stops: closing the listener removes its socket.
    await new Promise<void>((resolve) => { if (herdr === null) resolve(); else herdr.close(() => { resolve(); }); });
    herdr = null;
    healthBody = { ok: true, version: RAROG_VERSION, uptime: 1, herdr: false, term: true, hook: 'ok', authStore: 'ok' };
    write(herdrAgentPlistPath(dir), renderHerdrAgentPlist({ herdr: process.execPath, home: dir, socket: herdrSocket() }));
    writeFileSync(path.join(logs, 'loaded'), `ai.rarog.server\n${HERDR_AGENT_LABEL}\n`);
    const run = await doctor();
    const kickstart = `launchctl kickstart gui/${String(process.getuid?.() ?? 0)}/${HERDR_AGENT_LABEL}`;
    expect(marked(run, 'ERROR')).toContain(`herdr socket: ${herdrSocket()} missing — herdr is not running`);
    expect(marked(run, 'ERROR')).toContain(`herdr agent: ${HERDR_AGENT_LABEL} herdr is not running`);
    expect(run.stdout).not.toContain('fix: start herdr');
    expect(run.stdout.split(`fix: ${kickstart}\n`)).toHaveLength(3);
    expect(readCalls('launchctl').every((call) => call.startsWith('print '))).toBe(true);
  });

  it('log usługi poza katalogiem danych = czerwona linia usługi z „rarog service install”', async () => {
    await greenInstall();
    const log = path.join(dir, '.local', 'share', 'stary-katalog', 'server.log');
    write(path.join(agents(), 'ai.rarog.server.plist'), renderServicePlist({
      programArguments: [process.execPath, RAROG_BIN, 'serve'], workingDirectory: REPO, log,
    }));
    const run = await doctor();
    expect(run.status).not.toBe(0);
    expect(marked(run, 'ERROR')).toEqual([
      `service: ai.rarog.server loaded, but the service log ${log} lies outside the data directory ${dataDir()}`,
    ]);
    expect(run.stdout).toContain('fix: rarog service install');
  });

  it('StandardErrorPath poza katalogiem danych przy dobrym StandardOutPath też czerwieni', async () => {
    await greenInstall();
    const good = path.join(dataDir(), 'server.log');
    const bad = path.join(dir, '.local', 'share', 'stary-katalog', 'server.log');
    const plist = renderServicePlist({
      programArguments: [process.execPath, RAROG_BIN, 'serve'], workingDirectory: REPO, log: good,
    });
    const errKey = '<key>StandardErrorPath</key>';
    const at = plist.indexOf(errKey);
    expect(at).toBeGreaterThan(0);
    write(path.join(agents(), 'ai.rarog.server.plist'),
      plist.slice(0, at) + plist.slice(at).replace(`<string>${good}</string>`, `<string>${bad}</string>`));
    const run = await doctor();
    expect(run.status).not.toBe(0);
    expect(marked(run, 'ERROR')).toEqual([
      `service: ai.rarog.server loaded, but the service log ${bad} lies outside the data directory ${dataDir()}`,
    ]);
  });

  it('/health z inną wersją niż zainstalowana = czerwone /health z „rarog restart”', async () => {
    await greenInstall();
    healthBody = { ...(healthBody as Record<string, unknown>), version: '0.0.1-stary' };
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')).toEqual([`/health 127.0.0.1:${String(port)}: herdr: true, term: true, hook: ok,`
      + ' authStore: ok, version 0.0.1-stary']);
    expect(run.stdout).toContain(`version 0.0.1-stary, installed ${RAROG_VERSION} — the server runs code from before`
      + ' the change\n            fix: rarog restart\n');
  });

  it('plist wskazuje inną instalację = czerwona linia usługi z `service install` tej instalacji', async () => {
    await greenInstall();
    const other = path.join(dir, 'inna-instalacja');
    const otherBin = path.join(other, 'bin', 'rarog.mjs');
    write(otherBin, '');
    write(path.join(other, 'package.json'), JSON.stringify({ name: 'rarog', version: '0.9.0' }));
    write(path.join(agents(), 'ai.rarog.server.plist'), renderServicePlist({
      programArguments: [process.execPath, otherBin, 'serve'], workingDirectory: other,
      log: path.join(dataDir(), 'server.log'),
    }));
    for (const version of ['version 0.9.0', 'the file is gone']) {
      const run = await doctor();
      expect(run.status, version).toBe(1);
      expect(marked(run, 'ERROR')).toEqual([`service: ai.rarog.server points to another installation (${otherBin},`
        + ` ${version}), but this command is ${RAROG_BIN} (version ${RAROG_VERSION})`]);
      expect(run.stdout).toContain('fix: node bin/rarog.mjs service install');
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('klon, plist wskazuje paczkę npm = czerwona linia usługi z restartem paczki i przełączeniem, bez `service install` jako naprawy', async () => {
    await greenInstall();
    const pkg = fakePackage(path.join(dir, 'prefiks'), '0.9.0');
    write(path.join(agents(), 'ai.rarog.server.plist'), renderServicePlist({
      programArguments: [process.execPath, pkg.bin, 'serve'], workingDirectory: pkg.root,
      log: path.join(dataDir(), 'server.log'),
    }));
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')).toEqual([`service: ai.rarog.server starts the rarog package 0.9.0 (${pkg.root}), but`
      + ` this command is the repo clone ${REPO} (version ${RAROG_VERSION})`]);
    expect(run.stdout).toContain(`fix: Restart the service: '${process.execPath}' '${pkg.bin}' restart. This clone's`);
    expect(run.stdout).toContain(`back to the package: '${process.execPath}' '${pkg.bin}' service install.\n`);
    expect(run.stdout).not.toContain('fix: node bin/rarog.mjs service install');
  });

  it('węzeł usługi inny niż węzeł doctor (klon): linia usługi zielona z dopiskiem `service install`', async () => {
    await greenInstall();
    const node = path.join(dir, 'node-uslugi', 'node');
    write(node, '#!/bin/bash\necho v22.22.3\n', 0o755);
    write(path.join(agents(), 'ai.rarog.server.plist'), renderServicePlist({
      programArguments: [node, RAROG_BIN, 'serve'], workingDirectory: REPO, log: path.join(dataDir(), 'server.log'),
    }));
    const run = await doctor();
    expect(marked(run, 'ok')).toContain(`service: ai.rarog.server loaded, node ${node}`);
    expect(run.stdout).toContain(`service: ai.rarog.server loaded, node ${node}\n            the service starts with`
      + ` node ${node}, but this command runs on ${process.execPath}; node bin/rarog.mjs service install switches it\n`);
  });

  it('XDG_DATA_HOME tej powłoki wskazuje inny katalog = czerwona linia katalogu danych z radą', async () => {
    await greenInstall();
    const xdg = path.join(dir, 'xdg');
    const run = await doctor([], { ...doctorEnv([path.join(dir, '.local', 'bin')]), XDG_DATA_HOME: xdg });
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')).toEqual([`data directory: ${dataDir()} (default); serverId 01234567…; this shell`
      + ' computes a different directory']);
    expect(run.stdout).toContain(`The data directory from this shell ${path.join(xdg, 'rarog')} (XDG_DATA_HOME in this`
      + ` shell) and the directory of the service ${dataDir()} differ`);
    expect(run.stdout).toContain('Run without XDG_DATA_HOME.');
    expect(run.stdout).toContain('fix: run Claude sessions and rarog without the data directory variables of this'
      + ' shell');
    // Wystąpienie próbne (`--data-dir`) tej reguły nie dotyczy.
    const trial = await doctor(['--data-dir', dataDir()], {
      ...doctorEnv([path.join(dir, '.local', 'bin')]), XDG_DATA_HOME: xdg,
    });
    expect(trial.stdout).not.toContain('this shell computes a different directory');
  });

  it('nazwa spoza rejestru w config.json: czerwone środowisko z nazwą klucza', async () => {
    await greenInstall();
    writeConfig({
      RAROG_NIE_MA: '1', RAROG_PORT: String(port), RAROG_PROJECT_ROOTS: roots, RAROG_HERDR_SOCKET: herdrSocket(),
    });
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('RAROG_NIE_MA in config.json: name outside the server variable registry');
    expect(run.stdout).not.toContain('stara nazwa zmiennej');
  });

  it('ps nieczytelny (sandbox) = „nie wiem”, nie zielone i nie czerwone; kod różny od 0', async () => {
    await greenInstall();
    writeFileSync(path.join(logs, 'ps-pada'), '');
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')).toEqual([]);
    const unknown = marked(run, 'unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain('ps could not read process 4242 (ps: operation not permitted)');
  });

  it('jedna różnica środowiska: liczba pojedyncza w linii doctora', async () => {
    await greenInstall();
    serverProcess(liveEnv({ RAROG_PROJECT_ROOTS: '/Users/znajomy/Inne' }));
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')).toEqual([`live server environment = config: process ${PID} differs in 1 place`]);
  });

  it('różnica środowiska (wartość ze spacją, inny sekret, katalog danych) = czerwone bez wartości sekretu', async () => {
    await greenInstall();
    serverProcess(liveEnv({
      RAROG_PROJECT_ROOTS: '/Users/znajomy/My Other Projects', SONIOX_API_KEY: OTHER_TOKEN,
      RAROG_DATA_DIR: path.join(dir, 'inny'),
    }));
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')).toEqual([`live server environment = config: process ${PID} differs in 2`
      + ' places']);
    expect(run.stdout).toContain(`RAROG_PROJECT_ROOTS: expected «${roots}», server «/Users/znajomy/My Other`
      + ' Projects»');
    // W odczycie stoi po sekrecie: różnica tak, wartość nie.
    expect(run.stdout).toContain('RAROG_DATA_DIR non-empty in the server');
    expect(run.stdout).not.toContain(path.join(dir, 'inny'));
    expect(run.stdout).toContain('fix: fix config.json');
    expect(run.stdout + run.stderr).not.toContain(OTHER_TOKEN);
    expect(run.stdout + run.stderr).not.toContain(FAKE_SECRET);
  });

  it('wystąpienie próbne: --port i --data-dir celują w drugi serwer i jego katalog', async () => {
    await greenInstall();
    const trial = path.join(dir, 'proba');
    write(path.join(trial, 'devices.json'), JSON.stringify({ version: 1, serverId: 'fedcba9876543210', devices: [] }));
    // Konfiguracja mówi o porcie usługi; próba słucha na porcie serwera HTTP testu.
    writeConfig({
      RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: '1', RAROG_PROJECT_ROOTS: roots,
      RAROG_HERDR_SOCKET: herdrSocket(),
    });
    serverProcess(liveEnv({ RAROG_DATA_DIR: trial }));
    const run = await doctor(['--port', String(port), '--data-dir', trial]);
    expect(run.status, run.stdout).toBe(0);
    expect(run.stdout).toContain(`rarog doctor — port ${String(port)}, data directory ${trial}:`);
    expect(marked(run, 'ok')).toContain(`data directory: ${trial} (flag); serverId fedcba98…`);
    expect(readCalls('lsof-wywolania')).toEqual([`-nP -iTCP:${String(port)} -sTCP:LISTEN -t`]);
  });

  it('launchctl print odmawia (nie 113) = „nie wiem”, bez zalecenia instalacji', async () => {
    await greenInstall();
    writeFileSync(path.join(logs, 'launchctl-odmowa'), '');
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')).toEqual([]);
    expect(marked(run, 'unknown')).toEqual(['service: launchctl print ai.rarog.server is inconclusive (exit status 1,'
      + ' Operation not permitted)']);
    expect(run.stdout).not.toContain('fix: rarog service install');
  });

  it('hook zgodny lokalnie, a /health mówi stale = „nie wiem”, nie zielone', async () => {
    await greenInstall();
    healthBody = { ...(healthBody as object), hook: 'stale' };
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')).toEqual([]);
    const unknown = marked(run, 'unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain('hook: entry and copy match this repo, but /health says stale');
  });

  it('w kopii plik z poprzedniego manifestu spoza zestawu → BŁĄD `stale` z nazwą pliku i `hooks install`', async () => {
    await greenInstall();
    healthBody = { ...(healthBody as object), hook: 'stale' };
    const copy = hookInstallDir(dir);
    writeFileSync(path.join(copy, OLD_ENTRY_FILE), '// poprzednia instalacja\n');
    const files = Object.fromEntries([OLD_ENTRY_FILE, ...HOOK_INSTALL_FILES].map((name) => [
      name, createHash('sha256').update(readFileSync(path.join(copy, name))).digest('hex'),
    ]));
    write(path.join(copy, 'manifest.json'), JSON.stringify({ commit: 'a'.repeat(40), at: 1, files }));
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')).toEqual(['hook: stale — the copy in ~/.claude/hooks/rarog has a leftover file from'
      + ` an older installation (${OLD_ENTRY_FILE})`]);
    expect(run.stdout).toContain('fix: `pnpm run hooks:install`');
    expect(run.stdout).toContain('`pnpm run hooks:install` in your own terminal');
  });

  it('statusLine: świeży katalog o nazwie *.json to nie zrzut', async () => {
    await greenInstall();
    const dumps = path.join(dir, '.claude', 'statusline');
    rmSync(path.join(dumps, 'sesja.json'));
    mkdirSync(path.join(dumps, 'katalog.json'));
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'unknown')).toEqual([`statusLine: command "~/.claude/statusline.sh", but ${dumps} has no`
      + ' dump']);
  });

  it('statusLine wskazuje kopię skryptu: kopii brak albo różna od repo → BŁĄD `stale`; zgodna → ok', async () => {
    await greenInstall();
    const settings = JSON.parse(readFileSync(userSettingsPath(dir), 'utf8')) as Record<string, unknown>;
    write(userSettingsPath(dir), JSON.stringify({ ...settings, statusLine: { type: 'command', command: statuslineCommand(dir) } }));
    const missing = await doctor();
    expect(missing.status).toBe(1);
    expect(marked(missing, 'ERROR')).toEqual([expect.stringContaining('statusLine: stale — the command points to the'
      + ' script copy')]);
    expect(missing.stdout).toContain('rarog hooks doctor, then run rarog hooks install');

    copyFromRepo(STATUSLINE_INSTALL_FILES);
    const ok = await doctor();
    expect(marked(ok, 'ERROR')).toEqual([]);
    expect(ok.stdout).toContain(`statusLine: command "${statuslineCommand(dir)}", last dump`);

    writeFileSync(path.join(hookInstallDir(dir), 'rarog-statusline.mjs'), '// inny\n', { flag: 'a' });
    expect(marked(await doctor(), 'ERROR')).toEqual([expect.stringContaining('statusLine: stale')]);
  });

  it('własny statusLine właściciela: brak kopii skryptu w ~/.claude/hooks/rarog nie zmienia linii', async () => {
    await greenInstall();
    const run = await doctor();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('statusLine: command "~/.claude/statusline.sh", last dump');
    expect(run.stdout).toContain('hook: ok');
  });

  it('Mac bez usługi: czerwone usługa, brak config.json, hook, rarog w PATH', async () => {
    writeFileSync(path.join(logs, 'loaded'), '');
    const data = path.join(dir, '.local', 'share', 'rarog');
    write(path.join(data, 'devices.json'), JSON.stringify({ version: 1, serverId: SERVER_ID, devices: [] }));
    // Stary wpis hooka: wskazuje skrypt w checkoucie repo.
    write(userSettingsPath(dir), JSON.stringify({
      ...(hookBlock(`node ${path.join(REPO, 'scripts', 'hooks', 'rarog-pending.mjs')}`) as object),
      statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
    }));
    write(path.join(dir, '.claude', 'statusline', 'sesja.json'), '{}');
    healthBody = { ...(healthBody as object), hook: 'mismatch' };
    await listenHerdr(path.join(dir, '.config', 'herdr', 'herdr.sock'));
    const run = await doctor(['--port', String(port)], doctorEnv());
    expect(run.status).toBe(1);
    const bad = marked(run, 'ERROR').map((line) => line.split(':')[0]);
    expect(bad).toEqual(['service', 'live server environment = config', 'hook', 'rarog in PATH']);
    expect(run.stdout).toContain('service: no launchd service');
    expect(run.stdout).toContain('no config.json');
    expect(run.stdout).toContain('hook: mismatch — the entry points at the repo checkout');
    expect(marked(run, 'ok')).toContain(`data directory: ${data} (default); serverId 01234567…`);
  });

  it('serwer nie odpowiada → czerwone /health z rarog restart; nieznana opcja → 64', async () => {
    await greenInstall();
    await new Promise<void>((resolve) => { health?.close(() => { resolve(); }); });
    health = null;
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(marked(run, 'ERROR')[0]).toContain(`/health 127.0.0.1:${String(port)}: not responding`);
    expect(run.stdout).toContain('fix: rarog restart');
    const usage = await doctor(['--nie-ma']);
    expect(usage.status).toBe(64);
    expect(usage.stderr).toContain('Unknown rarog doctor option: --nie-ma');
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog doctor: linia iroh z gniazdem administracyjnym', 'launchd'),
  { timeout: 60_000 }, () => {
    let admin: HttpServer | null = null;
    let adminBody: AdminRead = { status: 200, body: { enabled: false } };
    /** Krótki katalog danych próby: ścieżka gniazda Unix mieści najwyżej 103 B. */
    const trial = (): string => path.join(dir, 'd');

    afterEach(async () => {
      await new Promise<void>((resolve) => { if (admin === null) resolve(); else admin.close(() => { resolve(); }); });
      admin = null;
    });

    async function listenAdmin(): Promise<void> {
      mkdirSync(path.join(trial(), 'run'), { recursive: true, mode: 0o700 });
      admin = createHttpServer((req, res) => {
        const reply = req.url === '/api/admin/iroh' && 'status' in adminBody ? adminBody : { status: 404, body: null };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? { error: 'not-found' }));
      });
      await new Promise<void>((resolve, reject) => {
        admin?.once('error', reject);
        admin?.listen(adminSocketPath(trial()), resolve);
      });
    }

    /** Zielona instalacja z `RAROG_IROH=1`: relay w `config.json`, klucz w pliku sekretów i w żywym serwerze. */
    async function irohInstall(): Promise<void> {
      await greenInstall();
      writeConfig({
        RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port), RAROG_PROJECT_ROOTS: roots,
        RAROG_HERDR_SOCKET: herdrSocket(), RAROG_IROH: '1', RAROG_IROH_RELAY: IROH_RELAY,
      });
      write(path.join(configDir(), 'secret', 'private.env'),
        `SONIOX_API_KEY=${FAKE_SECRET}\nRAROG_IROH_KEY=${FAKE_IROH_KEY}\n`, 0o600);
      write(path.join(trial(), 'devices.json'), JSON.stringify({ version: 1, serverId: SERVER_ID, devices: [] }));
      serverProcess(liveEnv({
        RAROG_IROH: '1', RAROG_IROH_RELAY: IROH_RELAY, RAROG_IROH_KEY: FAKE_IROH_KEY, RAROG_DATA_DIR: trial(),
      }));
    }

    const trialArgs = (): string[] => ['--port', String(port), '--data-dir', trial()];

    /*
     * Moduł z manifestów tej maszyny: na Macu Intel albo bez paczki platformy linia mówi o braku
     * modułu, a nie o module, więc oczekiwanie liczy się z tych samych manifestów co doctor.
     */
    const NATIVE = irohModuleInfo().platformVersion !== null;
    function moduleText(): string {
      const info = irohModuleInfo();
      if (info.version === null) return `package ${IROH_PACKAGE} missing`;
      const main = `package ${IROH_PACKAGE} ${info.version}`;
      if (info.platformPackage === null) return `${main}, but ${irohPlatform()} has no native module`;
      return info.platformVersion === null
        ? `${main}, but ${info.platformPackage} is missing` : `${main}, module ${info.platformPackage} ${info.platformVersion}`;
    }

    /** Czerwona linia „iroh” przy gnieździe bez odpowiedzi: brak nasłuchu, a bez modułu brak modułu z powodem. */
    function expectNoListener(run: Run, code: string): void {
      const reason = `the server does not respond on the admin socket ${adminSocketPath(trial())} (${code})`;
      expect(marked(run, 'ERROR')).toEqual([NATIVE
        ? `iroh: RAROG_IROH=1, but no listener — ${reason}`
        : `iroh: RAROG_IROH=1, but the native module is missing: ${moduleText()}`]);
      expect(run.stdout).toContain(reason);
      expect(run.stdout).toContain(NATIVE
        ? 'fix: rarog serve --check (loads the native module), then rarog restart' : 'fix: pnpm install in the repo');
    }

    it('wyłączone: linia „info” z paczką z manifestu, kod 0 przy reszcie zielonej', async () => {
      await greenInstall();
      const run = await doctor();
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(marked(run, 'info')).toEqual([
        `installation: repo clone ${REPO}, version ${RAROG_VERSION}`, `iroh: off (RAROG_IROH is not 1); ${moduleText()}`,
        // `/health` atrapy nie ma pola `consent`, a ustawienia testu nie dają sandboksowi gniazd ani obcego hooka.
        'consent channel: the server does not report it (/health without consent)',
        `consent channel settings: no sandbox access to ${path.join(dataDir(), 'run')}/ and no other PermissionRequest`
          + ` hook in ${path.join(dir, '.claude', 'settings.json')}`,
        'PR status: off (RAROG_PR_STATUS=0)',
      ]);
      expect(run.stdout).toContain('result: ok 10, ERROR 0, unknown 0, warn 0');
    });

    it('włączone i nasłuch działa: zielona linia z gniazda, kod 0, klucz iroh nigdzie', async () => {
      await irohInstall();
      adminBody = listening([IROH_RELAY], new Date(Date.now() - 5_000).toISOString());
      await listenAdmin();
      const run = await doctor(trialArgs());
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const line = marked(run, 'ok').find((text) => text.startsWith('iroh:'));
      expect(line).toMatch(new RegExp(`^iroh: listener running, EndpointId ${IROH_ID.slice(0, 12)}…, relay`
        + ` ${IROH_RELAY.replace(/[./]/g, '\\$&')} \\(last event \\d+ s ago\\), connections: 1 with a device, 2 without`));
      expect(run.stdout).toContain('result: ok 11, ERROR 0, unknown 0, warn 0');
      expect(run.stdout + run.stderr).not.toContain(FAKE_IROH_KEY);
      expect(run.stdout + run.stderr).not.toContain(IROH_ID);
    });

    it('relay bez adresu: żółta linia „uwaga” z naprawą, kod 1', async () => {
      await irohInstall();
      adminBody = listening([], null);
      await listenAdmin();
      const run = await doctor(trialArgs());
      expect(run.status).toBe(1);
      expect(marked(run, 'ERROR')).toEqual([]);
      expect(marked(run, 'warn')).toEqual([`iroh: listener running, EndpointId ${IROH_ID.slice(0, 12)}…, but no relay`
        + ' address since server start; connections: 1 with a device, 2 without']);
      expect(run.stdout).toContain('fix: check RAROG_IROH_RELAY');
      expect(run.stdout).toContain('warn 1');
    });

    it('włączone, a serwer bez nasłuchu (gniazda nie ma): czerwona linia z naprawą', async () => {
      await irohInstall();
      const run = await doctor(trialArgs());
      expect(run.status).toBe(1);
      expectNoListener(run, 'ENOENT');
      expect(run.stdout + run.stderr).not.toContain(FAKE_IROH_KEY);
    });

    it('odpowiedź gniazda zerwana po nagłówkach albo za duża: czerwona linia i podsumowanie, kod 1',
      async () => {
        await irohInstall();
        mkdirSync(path.join(trial(), 'run'), { recursive: true, mode: 0o700 });
        // Zerwana: nagłówki obiecują 100 B, przychodzą 2 B i koniec połączenia (Node: `aborted` i `close`, bez
        // `end`). Za duża: ciało ponad sufit 256 KiB odczytu.
        const cases = [
          { code: 'ECONNRESET', head: 'Content-Length: 100', body: '{}' },
          { code: 'E2BIG', head: 'Content-Length: 300000', body: ' '.repeat(300_000) },
        ];
        for (const { code, head, body } of cases) {
          const raw: NetServer = createNetServer((conn) => {
            // Za dużą odpowiedź doctor przerywa w trakcie zapisu: EPIPE po stronie atrapy to oczekiwany skutek.
            conn.on('error', () => {});
            conn.once('data', () => {
              conn.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n${head}\r\n\r\n${body}`);
              setTimeout(() => { conn.destroy(); }, 50);
            });
          });
          await new Promise<void>((resolve, reject) => {
            raw.once('error', reject);
            raw.listen(adminSocketPath(trial()), resolve);
          });
          try {
            const run = await doctor(trialArgs());
            expect(run.status, run.stdout + run.stderr).toBe(1);
            expectNoListener(run, code);
            expect(run.stdout).toContain('result: ok 10, ERROR 1');
          } finally {
            await new Promise<void>((resolve) => { raw.close(() => { resolve(); }); });
          }
        }
      });
  });

function readCalls(name: string): string[] {
  const file = path.join(logs, name);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
}
