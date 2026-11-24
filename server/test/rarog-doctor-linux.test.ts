/**
 * `rarog doctor` na Linuksie: linia usługi z jednostki `systemd --user`
 * `rarog.service`, środowisko żywego serwera dokładnie z `/proc/<pid>/environ`, oczekiwane z menedżera użytkownika
 * (`busctl`).
 *
 * Front biegnie przez wejście testowe z platformą `linux` i katalogiem procfs testu (`RAROG_TEST_PROC`, plik
 * `<proc>/<pid>/environ` pisze test). `systemctl`, `busctl`, `loginctl`, `lsof` i `ss` to atrapy z
 * `systemd-atrapy.ts`; `/health` odpowiada serwer HTTP testu, a PID słuchacza to proces testów (atrapy biorą tylko
 * żywe PID-y). `PATH` dziecka to same atrapy i `cat`/`rm`/`touch`, więc prawdziwy `lsof` gospodarza nie odpowiada
 * za atrapę. `HOME` tymczasowy; `afterAll` sprawdza, że realne katalogi `rarog` i `~/.config/systemd` nie powstały.
 *
 * Sprawdza: wszystko zielone (8 linii), wartość ze spacją i `=`, sekret i nazwę spoza rejestru nigdy z wartością
 * w całym wyjściu, `lsof` przed `ss`, brak obu, `ss` bez procesu, brak magistrali (`busctl` i całej), każdy stan
 * jednostki (not-found, masked, obca, drop-in, NeedDaemonReload, środowisko w jednostce, nieaktywna, wyłączona),
 * linger `no` i nieczytelny, nieczytelny `environ`, inną platformę i adapter `/proc` jednostkowo.
 */
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareServerEnv, doctorCommand, parseProcEnvironment } from '../src/cli/doctor.ts';
import { servePath } from '../src/cli/serve.ts';
import { RAROG_BIN } from '../src/cli/service.ts';
import { UNIT_NAME, renderServiceUnit, unitFilePath } from '../src/cli/systemd-unit.ts';
import { SDK_PACKAGE, readSdkPin } from '../src/install/sdk.ts';
import { RAROG_VERSION } from '../src/version.ts';
import {
  HOOK_INSTALL_FILES, hookBlock, hookCommand, hookInstallDir, userSettingsPath, writeBlockRules,
} from '../src/herdr/hook-config.ts';
import { realRarogDirsCreated } from './rarog-home.ts';
import { REPO, fake, linuxSandbox, rarogLinuxAsync } from './systemd-atrapy.ts';
import type { LinuxOptions, LinuxSandbox, Run } from './systemd-atrapy.ts';

const CLI = path.join(REPO, 'bin', 'rarog.mjs');
/** Sztuczne sekrety i wartości spoza rejestru — prawdziwych testy nie znają. */
const FAKE_SECRET = 'TEST-ONLY-sekret-doctora-linuksa-xxxxxxxxxxxxxxxx';
const OTHER_TOKEN = 'inny-sztuczny-klucz-serwera-fedcbafedcbafedc';
const FOREIGN_VALUE = 'wartosc-spoza-rejestru-5f3e1c';
const SERVER_ID = '0123456789abcdef0123456789abcdef';
/** Wartość ze spacją i `=`: w `/proc` granice wpisów są dokładne, więc to jedna wartość. */
const ROOTS = '/home/rarog/My Projects=A';
const PID = String(process.pid);

let sb: LinuxSandbox;
let health: HttpServer | null = null;
let herdr: NetServer | null = null;
let port = 0;

async function setup(options: LinuxOptions = { ss: true }): Promise<void> {
  sb = linuxSandbox('rarog-dl-', options);
  health = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: RAROG_VERSION, uptime: 1, herdr: true, term: true, hook: 'ok', authStore: 'ok' }));
  });
  await new Promise<void>((resolve) => { health?.listen(0, '127.0.0.1', resolve); });
  const address = health.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
}

/** Zamyka serwery testu (HTTP `/health`, gniazdo herdr) i sprząta piaskownicę. */
async function teardown(): Promise<void> {
  await new Promise<void>((resolve) => { if (health === null) resolve(); else health.close(() => { resolve(); }); });
  await new Promise<void>((resolve) => { if (herdr === null) resolve(); else herdr.close(() => { resolve(); }); });
  health = null;
  herdr = null;
  sb.cleanup();
}

/** Piaskownica z innym zestawem `lsof`/`ss`: najpierw zamyka serwery z `beforeEach`. */
async function resetup(options: LinuxOptions): Promise<void> {
  await teardown();
  await setup(options);
}

beforeEach(async () => { await setup(); });

afterEach(async () => { await teardown(); });

afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const write = (file: string, text: string, mode = 0o644): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode });
};
const configDir = (): string => path.join(sb.homeDir, '.config', 'rarog');
const dataDir = (): string => path.join(sb.homeDir, '.local', 'share', 'rarog');

function writeBlock(): readonly string[] {
  const built = writeBlockRules(dataDir(), sb.homeDir);
  if (!built.ok) throw new Error(built.reason);
  return built.rules;
}
const herdrSocket = (): string => path.join(sb.homeDir, 'h.sock');
const procRoot = (): string => path.join(sb.homeDir, 'proc');

/** `environ` procesu słuchacza w procfs testu: wpisy rozdzielone NUL-em, `null` pomija nazwę. */
function environ(overrides: Record<string, string | null> = {}, extra: readonly string[] = []): void {
  const base: Record<string, string | null> = {
    RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port), RAROG_PROJECT_ROOTS: ROOTS,
    RAROG_HERDR_SOCKET: herdrSocket(), RAROG_PR_STATUS: '0', SONIOX_API_KEY: FAKE_SECRET, RAROG_APNS_KEY_ID: '',
    HOME: sb.homeDir, SHELL: '/bin/bash', USER: 'rarog', LOGNAME: 'rarog', LANG: 'C.UTF-8', TMPDIR: '',
    PATH: servePath(process.execPath, 'linux'), RAROG_DATA_DIR: '', XDG_DATA_HOME: '',
    // Pomijane: dokłada je powłoka shimu tsx.
    NODE_PATH: '/srv/rarog/node_modules/.pnpm/node_modules', PWD: '/srv/rarog', SHLVL: '0',
    ...overrides,
  };
  const entries = [...Object.entries(base).filter(([, value]) => value !== null).map(([n, v]) => `${n}=${String(v)}`),
    ...extra];
  write(path.join(procRoot(), PID, 'environ'), `${entries.join('\0')}\0`);
}

/**
 * Jednostka z szablonu, jak po `rarog service install`: węzeł testów + `<repo>/bin/rarog.mjs serve`; `bin` = wejście
 * innej instalacji.
 */
function writeUnit(bin = CLI): void {
  write(unitFilePath(sb.homeDir), renderServiceUnit({
    execStart: [process.execPath, bin, 'serve'], workingDirectory: REPO, log: path.join(dataDir(), 'server.log'),
  }));
}

/**
 * Instalacja „wszystko zielone”: jednostka aktywna i włączona, konfiguracja, sekret w pliku, hook, herdr, PATH.
 * `RAROG_PR_STATUS=0`: the PR status line would otherwise look for the real `gh` of this machine; its four states have
 * their own test (`doctor-pr-status.test.ts`).
 */
async function greenInstall(): Promise<void> {
  write(path.join(configDir(), 'config.json'), JSON.stringify({ version: 1, env: {
    RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port), RAROG_PROJECT_ROOTS: ROOTS,
    RAROG_HERDR_SOCKET: herdrSocket(), RAROG_PR_STATUS: '0',
  } }));
  write(path.join(configDir(), 'secret', 'private.env'), `SONIOX_API_KEY=${FAKE_SECRET}\n`, 0o600);
  writeUnit();
  sb.set('active', '');
  sb.set('enabled', '');
  write(path.join(dataDir(), 'devices.json'), JSON.stringify({ version: 1, serverId: SERVER_ID, devices: [] }));
  // A server has run with this directory, so its log exists (without a consent-without-a-hook line).
  write(path.join(dataDir(), 'server.log'), '');
  // Kopia hooka zgodna z repo, bez gita: stan po `hooks install` niezależny od niezacommitowanych zmian w checkoutcie.
  mkdirSync(hookInstallDir(sb.homeDir), { recursive: true });
  for (const name of HOOK_INSTALL_FILES) {
    copyFileSync(path.join(REPO, 'scripts', 'hooks', name), path.join(hookInstallDir(sb.homeDir), name));
  }
  write(userSettingsPath(sb.homeDir), JSON.stringify({
    ...(hookBlock(hookCommand(sb.homeDir)) as object),
    statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
    // The write block rules `rarog setup` writes for this installation.
    permissions: { deny: writeBlock() },
  }, null, 2));
  write(path.join(sb.homeDir, '.claude', 'statusline', 'sesja.json'), '{}');
  mkdirSync(path.join(sb.homeDir, '.local', 'bin'), { recursive: true });
  symlinkSync(RAROG_BIN, path.join(sb.homeDir, '.local', 'bin', 'rarog'));
  mkdirSync(path.dirname(herdrSocket()), { recursive: true });
  herdr = createNetServer();
  await new Promise<void>((resolve, reject) => {
    herdr?.once('error', reject);
    herdr?.listen(herdrSocket(), resolve);
  });
  sb.set('listeners', PID);
  environ();
}

/** `rarog doctor` z platformą `linux`: `PATH` bez systemowych katalogów (prawdziwy `lsof` gospodarza odpada). */
function doctor(): Promise<Run> {
  return rarogLinuxAsync(sb, ['doctor'], {
    PATH: [sb.bin, sb.sys, path.join(sb.homeDir, '.local', 'bin')].join(':'),
    RAROG_TEST_PROC: procRoot(),
  });
}

/** Linie z danym znacznikiem (`ok`, `ERROR`, `unknown`) — sam tekst po znaczniku. */
function marked(run: Run, mark: 'ok' | 'ERROR' | 'unknown'): string[] {
  return run.stdout.split('\n').filter((line) => line.startsWith(mark.padEnd(8, ' '))).map((line) => line.slice(10));
}

const serviceText = (run: Run): string =>
  run.stdout.split('\n').find((line) => line.slice(10).startsWith('service: ')) ?? '';
const envText = (run: Run): string =>
  run.stdout.split('\n').find((line) => line.slice(10).startsWith('live server environment')) ?? '';

describe('adapter /proc/<pid>/environ (jednostkowo)', () => {
  it('granice z NUL-a: spacja i „=” w wartości, pomijane nigdzie, spoza rejestru samą nazwą', () => {
    const live = parseProcEnvironment(Buffer.from([
      `RAROG_PROJECT_ROOTS=${ROOTS}`, 'RAROG_PORT=8930', `SONIOX_API_KEY=${FAKE_SECRET}`, 'NODE_PATH=/n', 'PWD=/p',
      `_=${FOREIGN_VALUE}`, `INVOCATION_ID=${FOREIGN_VALUE}`, `BASH_FUNC_x%%=() { ${FOREIGN_VALUE}; }`,
      `ZLE\nNAZWA=${FOREIGN_VALUE}`, `bez-rownosci-${FOREIGN_VALUE}`, `=${FOREIGN_VALUE}`, '',
    ].join('\0')));
    expect(live.values.get('RAROG_PROJECT_ROOTS')).toBe(ROOTS);
    expect([...live.values.keys()].sort()).toEqual(['RAROG_PORT', 'RAROG_PROJECT_ROOTS', 'SONIOX_API_KEY']);
    expect(live.unknownLead).toEqual([
      '"BASH_FUNC_x%%"', '"ZLE\\nNAZWA"', '(entry without "NAME=")', 'INVOCATION_ID', '_',
    ]);
    expect(live.unknownLead.join('\n')).not.toContain(FOREIGN_VALUE);
    expect(live.repeated).toEqual([]);
  });

  it('porównanie dokładne: wartość z „ X=” to różnica wartości, nie sklejona nazwa; duplikat = „nie wiem”', () => {
    const want = { RAROG_PROJECT_ROOTS: ROOTS, HOME: '/h', SONIOX_API_KEY: FAKE_SECRET };
    const other = parseProcEnvironment(Buffer.from(['RAROG_PROJECT_ROOTS=/srv/Inne X=1', 'HOME=/h',
      `SONIOX_API_KEY=${FAKE_SECRET}`].join('\0')));
    expect(compareServerEnv(want, other, { wrapper: false, exact: true })).toEqual({
      diffs: [`RAROG_PROJECT_ROOTS: expected «${ROOTS}», server «/srv/Inne X=1»`], unsure: [],
    });
    const twice = parseProcEnvironment(Buffer.from(['HOME=/h', 'HOME=/inny', `RAROG_PROJECT_ROOTS=${ROOTS}`,
      `SONIOX_API_KEY=${FAKE_SECRET}`].join('\0')));
    expect(twice.repeated).toEqual(['HOME']);
    expect(compareServerEnv(want, twice, { wrapper: false, exact: true })).toEqual({
      diffs: [], unsure: ['HOME: appears more than once in the process environment — not compared, not shown'],
    });
  });
});

describe('rarog doctor na Linuksie (atrapy systemd --user)', { timeout: 60_000 }, () => {
  it('wszystko zielone: dziesięć linii ok z SDK, kod 0, PID z ss, environ z /proc, sekret nie pada na ekran', async () => {
    await greenInstall();
    const run = await doctor();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(marked(run, 'ERROR')).toEqual([]);
    expect(marked(run, 'unknown')).toEqual([]);
    const ok = marked(run, 'ok');
    expect(ok).toHaveLength(10);
    expect(ok[1]).toBe(`service: ${UNIT_NAME} active and enabled, node ${process.execPath}; linger: yes`);
    expect(ok[2]).toBe(`data directory: ${dataDir()} (default); serverId 01234567…`);
    expect(ok[3]).toBe(`SDK: from the workspace (${SDK_PACKAGE} ${readSdkPin().version})`);
    expect(ok[4]).toContain(`process ${PID}`);
    expect(ok[4]).toContain('secrets present: SONIOX_API_KEY');
    expect(run.stdout + run.stderr).not.toContain(FAKE_SECRET);
    // Tylko odczyt: systemctl wyłącznie `show`, ps nigdy (ani `-E`, ani `eww`), ss raz, bez lsof w PATH.
    expect(sb.calls('systemctl').every((call) => call.startsWith(`--user show ${UNIT_NAME} `))).toBe(true);
    expect(sb.calls('ps')).toEqual([]);
    expect(sb.calls('ss')).toEqual([`-Hltnp sport = :${String(port)}`]);
    expect(sb.calls('loginctl')).toHaveLength(1);
  });

  it('wartość ze spacją i „=” inna, sekret i nazwy spoza rejestru: różnice bez wartości w całym wyjściu', async () => {
    await greenInstall();
    environ({ RAROG_PROJECT_ROOTS: '/home/rarog/Inne X=1', RAROG_APNS_KEY_ID: OTHER_TOKEN },
      [`INVOCATION_ID=${FOREIGN_VALUE}`, `_=${FOREIGN_VALUE}`, `JOURNAL_STREAM=${FOREIGN_VALUE}`]);
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(envText(run)).toContain(`ERROR     live server environment = config: process ${PID} differs in 3`);
    expect(run.stdout).toContain('variables outside the registry in the server environment: INVOCATION_ID, JOURNAL_STREAM, _');
    expect(run.stdout).toContain(`RAROG_PROJECT_ROOTS: expected «${ROOTS}», server «/home/rarog/Inne X=1»`);
    expect(run.stdout).toContain('RAROG_APNS_KEY_ID: the server has it, but the config does not provide it');
    expect(run.stdout).toContain(`fix: fix config.json (or the secrets file, service.wrapper); the`
      + ` ${UNIT_NAME} unit picks up changes on rarog restart`);
    const all = run.stdout + run.stderr;
    for (const secret of [FAKE_SECRET, OTHER_TOKEN, FOREIGN_VALUE]) expect(all).not.toContain(secret);
  });

  it('zmienna katalogu danych w menedżerze i w serwerze = różnica (hook liczy katalog bez niej), jak na macOS', async () => {
    await greenInstall();
    sb.managerEnv({ XDG_DATA_HOME: '/srv/dane rarog' });
    environ({ XDG_DATA_HOME: '/srv/dane rarog' });
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('XDG_DATA_HOME=«/srv/dane rarog» in the server: the hook in Claude sessions computes'
      + ' the data directory without this variable, so it writes elsewhere');
  });

  it('lsof w PATH ma pierwszeństwo przed ss', async () => {
    await resetup({ lsof: true, ss: true });
    await greenInstall();
    const run = await doctor();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(sb.calls('lsof')).toHaveLength(1);
    expect(sb.calls('ss')).toEqual([]);
  });

  it('ani lsof, ani ss: „nie wiem” z podpowiedzią, bez ps', async () => {
    await resetup({});
    await greenInstall();
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(envText(run)).toBe('unknown   live server environment = config: neither lsof nor ss in PATH — install'
      + ' lsof or iproute2 (ss) and run doctor again');
    expect(sb.calls('ps')).toEqual([]);
  });

  it('ss widzi gniazdo bez procesu (inny użytkownik): „nie wiem”, a nie „nikt nie nasłuchuje”', async () => {
    await greenInstall();
    fake(path.join(sb.bin, 'ss'), [`echo 'LISTEN 0      511    127.0.0.1:${String(port)} 0.0.0.0:*'`]);
    const run = await doctor();
    expect(envText(run)).toContain(`unknown   live server environment = config: ss sees a socket on port`
      + ` ${String(port)}, but not its process`);
  });

  it('ss: jedno gniazdo z PID, drugie bez — „nie wiem”, nie „ok” dla procesu, który może nie być serwerem', async () => {
    await greenInstall();
    fake(path.join(sb.bin, 'ss'), [
      `echo 'LISTEN 0      511    127.0.0.1:${String(port)} 0.0.0.0:*'`,
      `echo 'LISTEN 0      511        [::1]:${String(port)}    [::]:* users:(("node",pid=${PID},fd=21))'`,
    ]);
    const run = await doctor();
    expect(run.status).toBe(1);
    expect(envText(run)).toContain(`unknown   live server environment = config: ss sees a socket on port`
      + ` ${String(port)}, but not its process`);
  });

  it('environ nieczytelny (proces zniknął): „nie wiem” z powodem', async () => {
    await greenInstall();
    rmSync(path.join(procRoot(), PID, 'environ'));
    const run = await doctor();
    expect(envText(run)).toContain(`unknown   live server environment = config: cannot read`
      + ` ${path.join(procRoot(), PID, 'environ')} (ENOENT)`);
  });

  it('busctl bez magistrali: środowisko „nie wiem”; usługa dalej sprawdzona', async () => {
    await greenInstall();
    sb.set('busctl-down', '');
    const run = await doctor();
    // Treść porażki busctl („kod 1, …”) pochodzi z `systemd-unit.ts`; tu tylko linia doctora i komunikat busctl.
    expect(envText(run)).toContain('unknown   live server environment = config: user manager environment'
      + ' unreadable (busctl … Environment: ');
    expect(envText(run)).toContain('Failed to set bus address');
    expect(serviceText(run)).toContain(`ok        service: ${UNIT_NAME} active and enabled`);
  });

  it('brak config.json wygrywa z brakiem magistrali: czerwone, nie „nie wiem”', async () => {
    await greenInstall();
    rmSync(path.join(configDir(), 'config.json'));
    sb.set('busctl-down', '');
    const run = await doctor();
    expect(envText(run)).toBe('ERROR     live server environment = config: no config.json — nothing to compare'
      + ' against');
  });

  it('busctl z innym kształtem: „nie wiem”, a jego wyjście nie trafia na ekran', async () => {
    await greenInstall();
    sb.set('manager-Environment.json', JSON.stringify({ type: 's', data: `SONIOX_API_KEY=${OTHER_TOKEN}` }));
    const run = await doctor();
    // Opis kształtu wyjścia busctl pochodzi z `systemd-unit.ts`; tu tylko linia doctora.
    expect(envText(run)).toContain('user manager environment unreadable (busctl … Environment: ');
    expect(run.stdout + run.stderr).not.toContain(OTHER_TOKEN);
  });

  it('cała magistrala leży: usługa i środowisko „nie wiem”', async () => {
    await greenInstall();
    sb.set('bus-down', '');
    const run = await doctor();
    expect(serviceText(run)).toContain(`unknown   service: systemctl --user show ${UNIT_NAME} is inconclusive`
      + ' (systemctl --user show: ');
    expect(serviceText(run)).toContain('Failed to connect to bus: No medium found)');
    expect(envText(run)).toContain('user manager environment unreadable');
  });

  const unitCases: readonly [string, () => void, string, string][] = [
    ['brak jednostki', () => { sb.set('LoadState', 'not-found'); },
      `ERROR     service: no systemd --user unit ${UNIT_NAME}`, 'fix: rarog service install'],
    ['masked', () => { sb.set('LoadState', 'masked'); },
      `ERROR     service: ${UNIT_NAME} has LoadState=masked`, `fix: systemctl --user unmask ${UNIT_NAME}`],
    ['obca jednostka', () => { sb.set('FragmentPath', `/etc/systemd/user/${UNIT_NAME}`); },
      `ERROR     service: ${UNIT_NAME} loaded from /etc/systemd/user/${UNIT_NAME}`, 'not the unit from rarog'],
    ['drop-in', () => { sb.set('DropInPaths', `/home/rarog/.config/systemd/user/${UNIT_NAME}.d/env.conf`); },
      `ERROR     service: ${UNIT_NAME} has drop-ins (/home/rarog/.config/systemd/user/${UNIT_NAME}.d/env.conf)`,
      'fix: remove the drop-ins and run systemctl --user daemon-reload'],
    ['plik zmieniony bez daemon-reload', () => { sb.set('NeedDaemonReload', 'yes'); },
      'changed without daemon-reload (NeedDaemonReload=yes)', 'fix: systemctl --user daemon-reload'],
    ['środowisko w jednostce', () => { sb.set('Environment', `XDG_DATA_HOME=/srv/${FOREIGN_VALUE}`); },
      `ERROR     service: ${UNIT_NAME} sets environment in the unit itself (Environment)`,
      'fix: rarog service install (the template has no such entries)'],
    ['nieaktywna', () => { sb.set('active', null); },
      `ERROR     service: ${UNIT_NAME} is not running (ActiveState=inactive), node ${process.execPath}`,
      'fix: rarog restart'],
    ['wyłączona', () => { sb.set('enabled', null); },
      `ERROR     service: ${UNIT_NAME} runs, but will not start on its own (UnitFileState=disabled)`,
      `fix: systemctl --user enable ${UNIT_NAME}`],
  ];
  for (const [name, arrange, line, repair] of unitCases) {
    it(`jednostka: ${name}`, async () => {
      await greenInstall();
      arrange();
      const run = await doctor();
      expect(run.status).toBe(1);
      expect(serviceText(run)).toContain(line);
      expect(run.stdout).toContain(repair);
      expect(run.stdout + run.stderr).not.toContain(FOREIGN_VALUE);
    });
  }

  it('jednostka wskazuje inną instalację = czerwona linia usługi, także przy lingerze „nie wiem”', async () => {
    await greenInstall();
    const otherBin = path.join(sb.homeDir, 'inna-instalacja', 'bin', 'rarog.mjs');
    writeUnit(otherBin);
    const line = `ERROR     service: ${UNIT_NAME} points to another installation (${otherBin}, the file is gone), but`
      + ` this command is ${RAROG_BIN} (version ${RAROG_VERSION})`;
    let run = await doctor();
    expect(run.status).toBe(1);
    expect(serviceText(run)).toBe(line);
    expect(run.stdout).toContain(`${line}\n            fix: node bin/rarog.mjs service install\n`);
    sb.set('linger', 'no');
    run = await doctor();
    expect(serviceText(run)).toBe(line);
  });

  it('linger wyłączony albo nieczytelny: „nie wiem” z komendą enable-linger', async () => {
    await greenInstall();
    sb.set('linger', 'no');
    let run = await doctor();
    expect(run.status).toBe(1);
    expect(serviceText(run)).toContain(`unknown   service: ${UNIT_NAME} active and enabled, node ${process.execPath};`
      + ' linger off (Linger=no) — without a login session (server, reboot) the service will not start; enable it'
      + ' with sudo loginctl enable-linger ');
    sb.set('loginctl-down', '');
    run = await doctor();
    expect(serviceText(run)).toContain('linger: unknown (loginctl show-user: ');
    expect(serviceText(run)).toContain('Failed to get user');
    expect(serviceText(run)).toContain('sudo loginctl enable-linger ');
  });
});

describe('rarog doctor na innej platformie', () => {
  it('usługa i środowisko „nie wiem” z nazwą platformy, bez systemctl i ps', async () => {
    // Without the flag at `0` the PR status line would run the real `gh` of this machine.
    write(path.join(configDir(), 'config.json'), JSON.stringify({ version: 1, env: { RAROG_PR_STATUS: '0' } }));
    const lines: string[] = [];
    const status = await doctorCommand(['doctor', '--port', String(port)], {
      stdout: (text) => { lines.push(text); }, stderr: (text) => { lines.push(text); },
      env: { HOME: sb.homeDir, PATH: `${sb.bin}:${sb.sys}` }, cwd: sb.homeDir, platform: 'freebsd',
    });
    const output = lines.join('');
    expect(status).toBe(1);
    expect(output).toContain('unknown   service: doctor knows launchd (macOS) and systemd --user (Linux), and this'
      + ' platform is freebsd');
    expect(output).toContain('unknown   live server environment = config: doctor knows macOS (ps -E) and Linux'
      + ' (/proc/<pid>/environ), and this platform is freebsd');
    expect(sb.calls('systemctl')).toEqual([]);
    expect(sb.calls('ps')).toEqual([]);
    expect(output).toContain('info      PR status: off (RAROG_PR_STATUS=0)');
  });
});
