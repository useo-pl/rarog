/**
 * `rarog service install|uninstall`.
 *
 * `rarog service` biegnie naprawdę (`node bin/rarog.mjs service …`) i woła prawdziwy `restart.sh`, ale wszystko, co
 * dotyka systemu, to atrapy w katalogu tymczasowym na początku `PATH`: `launchctl` ze stanem etykiet w pliku
 * (`print` 0 albo 113, a dla `FAKE_UNKNOWN` kod 5, czyli „nie wiem”; `print gui/<uid>` bez etykiety drukuje plik
 * `domena`, czyli blok `environment` domeny, a z plikiem `domena-pada` daje kod 5, z `domena-zabita` SIGKILL;
 * `bootout` zdejmuje, z `FAKE_BOOTOUT_LAG` dopiero po N pytaniach albo nigdy; `bootstrap` dokłada; log wywołań),
 * `curl` (zadany `/health`), `lsof`, `pgrep` i `nohup`.
 * `plutil` jest PRAWDZIWY (`/usr/bin/plutil`): `-lint` w fazie 0 i odczyt plistu w asercjach; atrapa tylko
 * w teście porażki lintu. `service.wrapper` to skrypt-atrapa w katalogu testu (bez menedżera sekretów): zapisuje swoje
 * argumenty i środowisko, eksportuje sztuczny sekret i robi `exec` reszty. Każdy test ma `HOME` w katalogu
 * tymczasowym, a `afterAll` sprawdza, że prawdziwe `~/.config/rarog`, `~/.local/share/rarog`, `~/.local/bin/rarog`
 * i `~/Library/LaunchAgents/ai.rarog.server.plist` nie powstały.
 *
 * Przed każdym uruchomieniem pomocnik sprawdza, że `launchctl` w `PATH` dziecka to atrapa: prawdziwy `bootout`
 * w domenie GUI testującego zatrzymałby serwer właściciela.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSocketPath } from '../src/auth/admin.ts';
import type { CliIo } from '../src/cli/io.ts';
import {
  RAROG_BIN, launchdEnv, renderServicePlist, rollbackLines, serviceCommand, servicePlatformIssue, xmlEscape,
} from '../src/cli/service.ts';
import type { ServiceDeps } from '../src/cli/service.ts';
import { HERDR_AGENT_LABEL, herdrAgentPlistPath } from '../src/cli/setup-herdr-agent.ts';
import {
  hookBlock, hookCommand, hookInstallDir, statuslineCommand, userSettingsPath,
} from '../src/herdr/hook-config.ts';
import { serviceTarget } from '../src/install/service-target.ts';
import { RAROG_VERSION } from '../src/version.ts';
import { PTY_RUN, fakeRestartScript } from './helpers/atrapa-restart-sh.ts';
import { IS_MAC, macOnly } from './platform.ts';
import { realRarogDirsCreated } from './rarog-home.ts';
import {
  FAKE_SECRET, SERVICE, SSH_AUTH_SOCK_ENTRY, UID, asking, assertFakeLaunchctl, domainPrint, fakePackage, makeSandbox,
  target, type FakePackage, type Run, type Sandbox,
} from './rarog-service-sandbox.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'rarog.mjs');
/** Węzeł usługi tej instalacji: przy Node z Homebrew `opt/<formuła>/bin/node`, nie `Cellar` z `process.execPath`. */
const SERVICE_NODE = serviceTarget().node;
const PORT = '18998';
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'rarog-service', `${SERVICE}.plist`);
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';

let sb: Sandbox;

beforeEach(() => { sb = makeSandbox(); });
afterEach(() => { sb.home.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const configDir = (): string => path.join(sb.homeDir, '.config', 'rarog');
const agents = (): string => path.join(sb.homeDir, 'Library', 'LaunchAgents');
const servicePlist = (): string => path.join(agents(), `${SERVICE}.plist`);
const wrapperArgs = (): string[] => [sb.wrapper, 'rarog', '--only', 'SONIOX_API_KEY', '--'];

function writeConfig(value: unknown): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(configDir(), 'config.json'), JSON.stringify(value));
}

function ownerConfig(wrapper: string[] = wrapperArgs()): unknown {
  return {
    version: 1, env: { RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: PORT }, service: { wrapper },
  };
}

/** Sztuczny klucz iroh: prawdziwego testy nie znają. */
const FAKE_IROH_KEY = 'cd'.repeat(32);

/** Konfiguracja właściciela z nasłuchem iroh; klucz przychodzi z wrappera albo nie przychodzi wcale. */
function irohConfig(): unknown {
  return {
    version: 1,
    env: { RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: PORT, RAROG_IROH: '1', RAROG_IROH_RELAY: 'https://relay.example./' },
    service: { wrapper: wrapperArgs() },
  };
}

/**
 * Mac właściciela przed instalacją usługi: usługa niezaładowana, dane w katalogu z reguły, config.json.
 */
function ownerBefore(): void {
  sb.loaded([]);
  mkdirSync(path.join(sb.homeDir, '.local', 'share', 'rarog', 'pending'), { recursive: true });
  writeConfig(ownerConfig());
}

/**
 * Usługa już zainstalowana i załadowana z tego klonu; jej plist (bez wrappera, więc inny niż zapis `install`) to
 * znacznik „nietknięty”. Cel czytelny: plist, którego argv klon nie odczyta, to przypadek z pytaniem.
 */
function serviceLoaded(): string {
  writeConfig(ownerConfig());
  sb.loaded([SERVICE]);
  mkdirSync(agents(), { recursive: true });
  const plist = renderServicePlist({
    programArguments: [SERVICE_NODE, CLI, 'serve'], workingDirectory: REPO,
    log: path.join(sb.homeDir, '.local', 'share', 'rarog', 'server.log'),
  });
  writeFileSync(servicePlist(), plist);
  return plist;
}


function rarog(argv: string[], extra: NodeJS.ProcessEnv = {}): Run {
  const env = sb.env(extra);
  assertFakeLaunchctl(sb, env);
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: sb.home.home, env, encoding: 'utf8', timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * `serviceCommand` w procesie testu (atrapy z `PATH` środowiska `io`, jak w dziecku) z czekaniem po `bootout`
 * skróconym do milisekund — test „launchd nigdy nie zdejmuje etykiety” nie czeka 30 s. `ask` = terminal z tymi
 * odpowiedziami (bez niego jak bez TTY).
 */
async function rarogInProcess(
  argv: string[], extra: NodeJS.ProcessEnv = {}, deps: ServiceDeps = {}, ask?: CliIo['ask'],
): Promise<Run> {
  const env = sb.env(extra);
  assertFakeLaunchctl(sb, env);
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env, cwd: sb.home.home,
    ...(ask === undefined ? {} : { ask }),
  };
  const status = await serviceCommand(argv, io, { timeoutMs: 50, stepMs: 10 }, deps);
  return { status, stdout, stderr };
}

function plistJson(file: string): Record<string, unknown> {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })) as
    Record<string, unknown>;
}


/** Nic nie zostało zatrzymane ani załadowane: `launchctl` tylko pytał. */
function expectNothingStopped(): void {
  const changing = sb.calls('launchctl').filter((call) => !asking(call));
  expect(changing).toEqual([]);
  expect(sb.calls('curl')).toEqual([]);
}

describe.skipIf(!IS_MAC)(macOnly('rarog service install: faza 0 — odmowa NICZEGO nie zatrzymuje', 'launchd'), { timeout: 60_000 }, () => {
  it('brak config.json → odmowa przed launchctl', () => {
    sb.loaded([]);
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('config.json');
    expect(run.stderr).toContain('Nothing was stopped');
    expectNothingStopped();
    expect(existsSync(servicePlist())).toBe(false);
  });

  it('RAROG_DATA_DIR albo XDG_DATA_HOME w powłoce → odmowa (usługa ich nie dostanie) przed launchctl print gui/<uid>', () => {
    ownerBefore();
    for (const name of ['RAROG_DATA_DIR', 'XDG_DATA_HOME']) {
      const run = rarog(['service', 'install'], { [name]: path.join(sb.homeDir, 'inny') });
      expect(run.status, name).toBe(1);
      expect(run.stderr).toContain(`${name} is set in this shell`);
    }
    expectNothingStopped();
    expect(sb.calls('launchctl')).toEqual([]);
  });

  it('zła konfiguracja, konflikt katalogu danych, zły wrapper → odmowa przed bootout', () => {
    ownerBefore();
    const cases: [() => void, string][] = [
      [() => { writeConfig({ ...ownerConfig() as object, env: { RAROG_MAX_PANES: '0' } }); },
        'the config fails the check'],
      [() => { writeConfig(ownerConfig(['secret-env.sh', '--'])); }, 'an absolute path'],
      [() => { writeConfig(ownerConfig([path.join(sb.homeDir, 'brak.sh'), '--'])); },
        'does not exist or is not executable'],
      [() => {
        writeConfig(ownerConfig());
        const data = path.join(sb.homeDir, '.local', 'share', 'rarog');
        rmSync(data, { recursive: true, force: true });
        writeFileSync(data, 'x');
      }, 'Data directory conflict'],
    ];
    for (const [arrange, needle] of cases) {
      arrange();
      const run = rarog(['service', 'install']);
      expect(run.status, needle).toBe(1);
      expect(run.stderr, needle).toContain(needle);
      expect(run.stderr).toContain('Nothing was stopped');
    }
    expectNothingStopped();
    expect(existsSync(servicePlist())).toBe(false);
  });

  it('pełne serve --check przez wrapper pada → odmowa przed bootout, wyjście wrappera widać', () => {
    ownerBefore();
    writeFileSync(path.join(sb.logs, 'wrapper-pada'), '');
    const run = rarog(['service', 'install']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('wrapper: brak sekretów');
    expect(run.stderr).toContain('failed');
    expectNothingStopped();
  });

  it('wrapper przechodzi, ale nie daje żadnego sekretu → odmowa przed bootout', () => {
    ownerBefore();
    writeFileSync(path.join(sb.logs, 'wrapper-bez-sekretow'), '');
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stdout).toContain('secrets: not checked (supplied by service.wrapper)');
    expect(run.stderr).toContain('service.wrapper supplied no secret at all');
    expect(run.stderr).toContain('Nothing was stopped');
    expectNothingStopped();
  });

  it('RAROG_IROH=1, wrapper daje sekret, ale nie klucz iroh → wstępne --check przechodzi, pełne odmawia przed bootout', () => {
    ownerBefore();
    writeConfig(irohConfig());
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('RAROG_IROH=1 without RAROG_IROH_KEY');
    expect(run.stderr).toContain('through service.wrapper failed');
    expect(run.stderr).toContain('Nothing was stopped');
    expectNothingStopped();
    expect(existsSync(servicePlist())).toBe(false);
  });

  it('RAROG_IROH=1 bez wrappera i bez klucza → odmowa wstępnego --check, przed wrapperem i bootout', () => {
    ownerBefore();
    writeConfig({ ...(irohConfig() as Record<string, unknown>), service: undefined });
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('the config fails the check');
    expect(run.stderr).toContain('RAROG_IROH=1 without RAROG_IROH_KEY');
    expectNothingStopped();
    expect(existsSync(servicePlist())).toBe(false);
  });

  it('RAROG_DATA_DIR albo XDG_DATA_HOME w bloku environment domeny gui/<uid> (także sama spacja) → odmowa', () => {
    ownerBefore();
    const cases: [string, string][] = [
      ['RAROG_DATA_DIR', path.join(sb.homeDir, 'inny')],
      ['XDG_DATA_HOME', path.join(sb.homeDir, 'inny')],
      ['RAROG_DATA_DIR', ' '],
    ];
    for (const [name, value] of cases) {
      const what = `${name}=${JSON.stringify(value)}`;
      writeFileSync(path.join(sb.logs, 'domena'), domainPrint([SSH_AUTH_SOCK_ENTRY, `${name} => ${value}`]));
      const run = rarog(['service', 'install']);
      expect(run.status, what).toBe(1);
      expect(run.stderr, what).toContain(`${name} is set in the launchd domain gui/${UID}`);
      expect(run.stderr, what).toContain(`Terminal.app on the Mac screen, outside herdr (launchctl managername = Aqua):`
        + ` launchctl unsetenv ${name}`);
      expect(run.stderr, what).toContain('Nothing was stopped');
    }
    expect(sb.calls('launchctl')).toEqual(Array(cases.length).fill(`print gui/${UID}`));
    expectNothingStopped();
    expect(existsSync(servicePlist())).toBe(false);
  });

  // Wydruk `launchctl print` nie jest API: to, czego nie da się rozstrzygnąć, ostrzega i nie blokuje instalacji.
  const unchecked: [string, () => void, string][] = [
    ['kod 5', () => { writeFileSync(path.join(sb.logs, 'domena-pada'), ''); },
      `launchctl print gui/${UID}: exit status 5, Could not print domain: 5: Input/output error`],
    ['sygnał', () => { writeFileSync(path.join(sb.logs, 'domena-zabita'), ''); },
      `launchctl print gui/${UID}: signal SIGKILL`],
    ['brak bloku environment', () => {
      writeFileSync(path.join(sb.logs, 'domena'), `gui/${UID} = {\n\ttype = gui\n}\n`);
    }, `launchctl print gui/${UID} output: no environment block`],
    ['linia spoza kształtu', () => {
      writeFileSync(path.join(sb.logs, 'domena'), domainPrint([SSH_AUTH_SOCK_ENTRY, 'bez strzałki']));
    }, `launchctl print gui/${UID} output: line 6 of the environment block does not have the shape "NAME => value"`],
    // Zła struktura z naszą zmienną w środku to ostrzeżenie, nie odmowa.
    ['blok bez zamknięcia z RAROG_DATA_DIR', () => {
      writeFileSync(path.join(sb.logs, 'domena'), `gui/${UID} = {\n\tenvironment = {\n\t\tRAROG_DATA_DIR => /inny\n`);
    }, `launchctl print gui/${UID} output: environment block not closed`],
  ];
  for (const [what, arrange, why] of unchecked) {
    it(`launchctl print gui/<uid> nie rozstrzyga (${what}) → ostrzeżenie „nie sprawdzone”, instalacja idzie dalej`, () => {
      ownerBefore();
      arrange();
      const run = rarog(['service', 'install']);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toContain(`rarog service install: WARNING, not checked: RAROG_DATA_DIR,`
        + ' XDG_DATA_HOME'
        + ` in the launchd domain gui/${UID} (${why}). Installation continues`);
      expect(sb.calls('launchctl')[0]).toBe(`print gui/${UID}`);
      expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([
        `bootstrap gui/${UID} ${servicePlist()}`,
        `kickstart ${target(SERVICE)}`,
      ]);
    });
  }

  it('launchctl print ai.rarog.server z kodem innym niż 0 i 113 → odmowa, nic nie zapisane', () => {
    ownerBefore();
    const run = rarog(['service', 'install'], { FAKE_UNKNOWN: SERVICE });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`launchctl print ${target(SERVICE)} does not tell whether ${SERVICE} is`
      + ' loaded (exit status 5, Could not print: 5: Input/output error)');
    expect(run.stderr).toContain('Nothing was stopped');
    expect(run.stderr).not.toContain('ROLLBACK');
    expectNothingStopped();
    expect(existsSync(servicePlist())).toBe(false);
    expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
  });

  // Serwer tych danych na innym porcie zostałby obok usługi: `restart.sh` zatrzymuje tylko port z konfiguracji.
  it('gniazdo administracyjne danych żyje, a port z konfiguracji milczy → odmowa przed wrapperem, zapisem i bootout', async () => {
    ownerBefore();
    const socket = adminSocketPath(path.join(sb.homeDir, '.local', 'share', 'rarog'));
    mkdirSync(path.dirname(socket), { recursive: true });
    const old = net.createServer();
    await new Promise<void>((resolve, reject) => { old.once('error', reject); old.listen(socket, resolve); });
    try {
      const run = await rarogInProcess(['service', 'install']);
      expect(run.status, run.stderr).toBe(1);
      expect(run.stderr).toContain(`but not on port ${PORT} from the config`);
      expect(run.stderr).toContain('Nothing was stopped');
      expectNothingStopped();
      expect(sb.calls('wrapper')).toEqual([]);
      expect(existsSync(servicePlist())).toBe(false);
      expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => { old.close(() => { resolve(); }); });
    }
  });

  it('gniazdo żyje i port z konfiguracji odpowiada (serwer na swoim porcie) → instalacja idzie dalej', async () => {
    ownerBefore();
    const socket = adminSocketPath(path.join(sb.homeDir, '.local', 'share', 'rarog'));
    mkdirSync(path.dirname(socket), { recursive: true });
    const admin = net.createServer();
    await new Promise<void>((resolve, reject) => { admin.once('error', reject); admin.listen(socket, resolve); });
    const tcp = net.createServer();
    await new Promise<void>((resolve) => { tcp.listen(0, '127.0.0.1', resolve); });
    const livePort = String((tcp.address() as net.AddressInfo).port);
    try {
      writeConfig({ ...ownerConfig() as object, env: { RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: livePort } });
      const run = await rarogInProcess(['service', 'install']);
      expect(run.status, run.stderr).toBe(0);
      expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${livePort}/health`]);
    } finally {
      await new Promise<void>((resolve) => { admin.close(() => { resolve(); }); });
      await new Promise<void>((resolve) => { tcp.close(() => { resolve(); }); });
    }
  });

  // Wrapper z inną zmienną katalogu danych postawiłby usługę na innych danych niż hook i niż log w plistcie.
  it('wrapper ustawia RAROG_DATA_DIR albo XDG_DATA_HOME → odmowa przed bootout i zapisem', () => {
    ownerBefore();
    const dataDir = path.join(sb.homeDir, '.local', 'share', 'rarog');
    const other = path.join(sb.homeDir, 'inne-dane');
    const cases: [string, string][] = [['RAROG_DATA_DIR', other], ['XDG_DATA_HOME', path.join(other, 'rarog')]];
    for (const [name, seen] of cases) {
      writeFileSync(path.join(sb.logs, 'wrapper-export'), `export ${name}='${other}'\n`);
      const run = rarog(['service', 'install']);
      expect(run.status, `${name}: ${run.stderr}`).toBe(1);
      expect(run.stderr, name).toContain(`through service.wrapper sees data directory ${seen} and port ${PORT}, but`
        + ` the check without the wrapper ${dataDir} and ${PORT}`);
      expect(run.stderr, name).toContain('Nothing was stopped');
    }
    expectNothingStopped();
    expect(existsSync(servicePlist())).toBe(false);
    expect(existsSync(other)).toBe(false);
  });

  it('wrapper podmienia HOME na dom z innym portem w config.json → odmowa (inny port)', () => {
    ownerBefore();
    const dataDir = path.join(sb.homeDir, '.local', 'share', 'rarog');
    const otherHome = path.join(sb.homeDir, 'inny-dom');
    mkdirSync(path.join(otherHome, '.config', 'rarog'), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(otherHome, '.config', 'rarog', 'config.json'), JSON.stringify({
      version: 1, env: { RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: '18996' },
    }));
    // Ten sam katalog danych jawnie: różni się tylko port.
    writeFileSync(path.join(sb.logs, 'wrapper-export'), `export HOME='${otherHome}'\nexport RAROG_DATA_DIR='${dataDir}'\n`);
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain(`sees data directory ${dataDir} and port 18996, but the check without the wrapper`
      + ` ${dataDir} and ${PORT}`);
    expectNothingStopped();
    expect(existsSync(servicePlist())).toBe(false);
  });

  // `rarog serve` nie bierze RAROG_PORT ze środowiska rodzica (tylko z config.json i flag), więc wrapper go nie zmieni.
  it('RAROG_PORT z wrappera nie zmienia portu pełnego --check → instalacja przechodzi', () => {
    ownerBefore();
    writeFileSync(path.join(sb.logs, 'wrapper-export'), "export RAROG_PORT='18996'\n");
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`  port: ${PORT}\n`);
    expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
  });

  it('plutil -lint odrzuca plist → odmowa przed bootout', () => {
    ownerBefore();
    writeFileSync(path.join(sb.bin, 'plutil'), '#!/bin/bash\necho "zły plist" >&2\nexit 1\n');
    chmodSync(path.join(sb.bin, 'plutil'), 0o755);
    const run = rarog(['service', 'install']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('plutil -lint');
    expectNothingStopped();
    expect(existsSync(path.join(configDir(), `${SERVICE}.plist.sprawdzany`))).toBe(false);
  });

  it('ścieżka gniazda administracyjnego > 103 B → odmowa', () => {
    sb.homeDir = path.join(sb.home.home, 'd'.repeat(80));
    mkdirSync(sb.homeDir);
    ownerBefore();
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain('the admin socket path');
    expectNothingStopped();
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog service install: faza 1', 'launchd, plutil'), { timeout: 60_000 }, () => {
  it('Mac właściciela: plist z szablonu, bootstrap, restart.sh, dowiązanie', () => {
    ownerBefore();
    const dataDir = path.join(sb.homeDir, '.local', 'share', 'rarog');
    const run = rarog(['service', 'install'], { FAKE_EXPECT_DIR: dataDir });
    expect(run.status, run.stderr).toBe(0);

    const calls = sb.calls('launchctl');
    const changing = calls.filter((call) => !asking(call));
    expect(changing).toEqual([
      `bootstrap gui/${UID} ${servicePlist()}`,
      `kickstart ${target(SERVICE)}`,
    ]);
    expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
    expect(sb.calls('nohup')).toEqual([]);

    const plist = plistJson(servicePlist());
    expect(plist['Label']).toBe(SERVICE);
    expect(plist['ProgramArguments']).toEqual([...wrapperArgs(), SERVICE_NODE, CLI, 'serve']);
    expect(plist['WorkingDirectory']).toBe(REPO);
    expect(plist['StandardOutPath']).toBe(path.join(dataDir, 'server.log'));
    expect(plist['StandardErrorPath']).toBe(plist['StandardOutPath']);
    expect(plist['RunAtLoad']).toBe(true);
    expect(plist['KeepAlive']).toBe(true);
    expect(plist['ProcessType']).toBe('Interactive');
    expect(plist).not.toHaveProperty('EnvironmentVariables');
    expect(spawnSync('/usr/bin/plutil', ['-lint', servicePlist()], { encoding: 'utf8' }).status).toBe(0);

    // Pełne `--check` szło przez wrapper, na środowisku jak pod launchd, bez zmiennych testu.
    expect(sb.calls('wrapper')).toEqual([[...wrapperArgs().slice(1), SERVICE_NODE, CLI, 'serve', '--check']
      .join(' ')]);
    const wrapperEnv = readFileSync(path.join(sb.logs, 'wrapper-env'), 'utf8');
    expect(wrapperEnv).toContain('PATH=/usr/bin:/bin:/usr/sbin:/sbin\n');
    expect(wrapperEnv).not.toContain('FAKE_');
    expect(run.stdout).toContain('secrets: set SONIOX_API_KEY');

    expect(readlinkSync(path.join(sb.homeDir, '.local', 'bin', 'rarog'))).toBe(RAROG_BIN);
    expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
    for (const text of [run.stdout, run.stderr, readFileSync(servicePlist(), 'utf8')]) {
      expect(text).not.toContain(FAKE_SECRET);
    }
    expect(run.stderr).not.toContain('ROLLBACK');
  });

  it('RAROG_IROH=1 z kluczem z wrappera: instalacja przechodzi, wartość klucza nigdzie w wyjściu ani w plistcie', () => {
    ownerBefore();
    writeConfig(irohConfig());
    writeFileSync(path.join(sb.logs, 'wrapper-export'), `export RAROG_IROH_KEY='${FAKE_IROH_KEY}'\n`);
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    // Wstępne `--check` (bez sekretów, wyjście ciche) przeszło z kluczem „niesprawdzonym”; pełne widzi klucz.
    expect(run.stdout).toMatch(/secrets: set SONIOX_API_KEY, RAROG_IROH_KEY/);
    for (const text of [run.stdout, run.stderr, readFileSync(servicePlist(), 'utf8')]) {
      expect(text).not.toContain(FAKE_IROH_KEY);
    }
  });

  it('RAROG_IROH=1 bez wrappera, klucz w pliku sekretów: instalacja przechodzi, wartość klucza nigdzie', () => {
    ownerBefore();
    writeConfig({ ...(irohConfig() as Record<string, unknown>), service: undefined });
    const secretDir = path.join(configDir(), 'secret');
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(secretDir, 'private.env'), `RAROG_IROH_KEY=${FAKE_IROH_KEY}\n`, { mode: 0o600 });
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('rarog serve --check without a wrapper:');
    expect(run.stdout).toMatch(/secrets: set RAROG_IROH_KEY/);
    for (const text of [run.stdout, run.stderr, readFileSync(servicePlist(), 'utf8')]) {
      expect(text).not.toContain(FAKE_IROH_KEY);
    }
  });

  it('pusty HOME (znajomy): katalog danych `rarog` 0700 założony PRZED bootstrap, bez bootout', () => {
    writeConfig(ownerConfig());
    const dataDir = path.join(sb.homeDir, '.local', 'share', 'rarog');
    const run = rarog(['service', 'install'], { FAKE_EXPECT_DIR: dataDir });
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('bootstrap')).toEqual(['katalog-jest']);
    expect((statSync(dataDir).mode & 0o777).toString(8)).toBe('700');
    expect(sb.calls('launchctl').filter((call) => call.startsWith('bootout'))).toEqual([]);
    expect(plistJson(servicePlist())['StandardOutPath']).toBe(path.join(dataDir, 'server.log'));
  });

  it('ponowna instalacja przy załadowanym ai.rarog.server: bootout własnej etykiety, to samo wywołanie', () => {
    writeConfig(ownerConfig());
    let run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    writeFileSync(path.join(sb.logs, 'launchctl'), '');
    run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([
      `bootout ${target(SERVICE)}`,
      `bootstrap gui/${UID} ${servicePlist()}`,
      `kickstart ${target(SERVICE)}`,
    ]);
    expect(run.stdout).toContain('(already there)');
  });

  it('plist wskazuje usuniętą instalację (węzeł i wejście już nie istnieją) → install przechodzi, plist z celem tej', () => {
    writeConfig(ownerConfig());
    sb.loaded([SERVICE]);
    mkdirSync(agents(), { recursive: true });
    const dataDir = path.join(sb.homeDir, '.local', 'share', 'rarog');
    writeFileSync(servicePlist(), renderServicePlist({
      programArguments: [...wrapperArgs(), '/nie/ma/node/bin/node', '/nie/ma/rarog/bin/rarog.mjs', 'serve'],
      workingDirectory: '/nie/ma/rarog', log: path.join(dataDir, 'server.log'),
    }));
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([
      `bootout ${target(SERVICE)}`,
      `bootstrap gui/${UID} ${servicePlist()}`,
      `kickstart ${target(SERVICE)}`,
    ]);
    expect(plistJson(servicePlist())['ProgramArguments']).toEqual([...wrapperArgs(), SERVICE_NODE, CLI, 'serve']);
    expect(plistJson(servicePlist())['WorkingDirectory']).toBe(REPO);
  });

  it('porażka bootstrap → komendy powrotu dosłownie, kod 1', () => {
    ownerBefore();
    const run = rarog(['service', 'install'], { FAKE_BOOTSTRAP_FAIL: '1' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('launchctl bootstrap');
    expect(run.stderr).toContain(rollbackLines(sb.homeDir).join('\n'));
    expect(run.stderr).toContain(`  launchctl bootout gui/$UID/${SERVICE}`);
    expect(sb.calls('curl')).toEqual([]);
  });

  it('the server log is 0600 before bootstrap: created when missing, an existing 0644 one set to 0600, text kept', () => {
    ownerBefore();
    const log = path.join(sb.homeDir, '.local', 'share', 'rarog', 'server.log');
    // A failed bootstrap still finds the file: launchd opens the log for appending when it loads the job.
    expect(rarog(['service', 'install'], { FAKE_BOOTSTRAP_FAIL: '1' }).status).toBe(1);
    expect((statSync(log).mode & 0o777).toString(8)).toBe('600');
    chmodSync(log, 0o644);
    writeFileSync(log, 'earlier line\n', { flag: 'a' });
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect((statSync(log).mode & 0o777).toString(8)).toBe('600');
    expect(readFileSync(log, 'utf8')).toBe('earlier line\n');
  });

  it('ponowna instalacja, porażka bootout → komendy powrotu, bez bootstrap, plist nietknięty', () => {
    const plist = serviceLoaded();
    const run = rarog(['service', 'install'], { FAKE_BOOTOUT_FAIL: '1' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`launchctl bootout ${target(SERVICE)} failed`);
    expect(run.stderr).toContain(rollbackLines(sb.homeDir).join('\n'));
    expect(sb.calls('launchctl').filter((call) => call.startsWith('bootstrap'))).toEqual([]);
    expect(readFileSync(servicePlist(), 'utf8')).toBe(plist);
  });

  it('restart.sh czerwony (herdr: false) → jego kod i komendy powrotu', () => {
    ownerBefore();
    const run = rarog(['service', 'install'], {
      FAKE_HEALTH: '{"ok":true,"version":"t","uptime":1,"herdr":false,"term":true}',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('restart.sh exited with code 2');
    expect(run.stderr).toContain(rollbackLines(sb.homeDir).join('\n'));
  });

  it('wyjątek w fazie 1 (bash do restart.sh nie startuje) → komendy powrotu', () => {
    ownerBefore();
    // PATH bez `bash`: atrapy i narzędzia, których potrzebują, dowiązane pojedynczo.
    const tools = path.join(sb.homeDir, 'narzedzia');
    mkdirSync(tools);
    for (const tool of ['plutil', 'grep', 'mv', 'touch', 'basename', 'cat', 'sleep']) {
      const found = spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(found, path.join(tools, tool));
    }
    const env = sb.env({ PATH: `${sb.bin}:${tools}` });
    const run = spawnSync(process.execPath, [CLI, 'service', 'install'], {
      cwd: sb.home.home, env, encoding: 'utf8', timeout: 120_000,
    });
    expect(run.status, run.stderr).toBe(1);
    expect(sb.calls('launchctl')).toContain(`bootstrap gui/${UID} ${servicePlist()}`);
    expect(run.stderr).toContain('bash');
    expect(run.stderr).toContain(rollbackLines(sb.homeDir).join('\n'));
  });

  // Ta sama etykieta to przypadek „Bootstrap failed: 5”.
  it('ponowna instalacja, launchd zdejmuje ai.rarog.server z opóźnieniem → bootstrap tej etykiety po 113', () => {
    writeConfig(ownerConfig());
    let run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    writeFileSync(path.join(sb.logs, 'launchctl'), '');
    run = rarog(['service', 'install'], { FAKE_BOOTOUT_LAG: '2' });
    expect(run.status, run.stderr).toBe(0);
    const calls = sb.calls('launchctl');
    const from = calls.indexOf(`bootout ${target(SERVICE)}`);
    const to = calls.findIndex((call) => call.startsWith('bootstrap '));
    expect(from).toBeGreaterThan(-1);
    expect(calls.slice(from + 1, to)).toEqual(Array(3).fill(`print ${target(SERVICE)}`));
  });

  it('launchd nie zdejmuje etykiety w limicie → komendy powrotu, bez bootstrap, plist nietknięty', async () => {
    const plist = serviceLoaded();
    const run = await rarogInProcess(['service', 'install'], { FAKE_BOOTOUT_LAG: 'never' });
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain(`after launchctl bootout ${target(SERVICE)} label ${SERVICE} is still loaded`
      + ' after 0.05 s');
    expect(run.stderr).toContain(rollbackLines(sb.homeDir).join('\n'));
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([`bootout ${target(SERVICE)}`]);
    expect(readFileSync(servicePlist(), 'utf8')).toBe(plist);
    expect(sb.calls('curl')).toEqual([]);
    expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
  });

  it('„nie wiem” w trakcie czekania po bootout → komendy powrotu, bez bootstrap', () => {
    serviceLoaded();
    // Pytania o usługę: koniec fazy 0, przed `bootout`, a trzecie (pierwsze po `bootout`) dostaje kod 5.
    const run = rarog(['service', 'install'], { FAKE_UNKNOWN: SERVICE, FAKE_UNKNOWN_FROM: '3' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`after launchctl bootout ${target(SERVICE)} the state is undecided (exit status 5`);
    expect(run.stderr).toContain(rollbackLines(sb.homeDir).join('\n'));
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([`bootout ${target(SERVICE)}`]);
  });

  it('„nie wiem” o ai.rarog.server dopiero w fazie 1, przed bootout → komendy powrotu, nic nie zmienione', () => {
    ownerBefore();
    // Faza 0 pyta usługę raz; drugie pytanie (w fazie 1, przed `bootout`) dostaje kod 5.
    const run = rarog(['service', 'install'], { FAKE_UNKNOWN: SERVICE, FAKE_UNKNOWN_FROM: '2' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`launchctl print ${target(SERVICE)} does not decide whether ${SERVICE} is loaded`);
    expect(run.stderr).toContain('bootout held back');
    expect(run.stderr).toContain(rollbackLines(sb.homeDir).join('\n'));
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([]);
    expect(existsSync(servicePlist())).toBe(false);
    expect(sb.calls('curl')).toEqual([]);
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog service install z klonu, gdy usługa startuje paczkę npm', 'launchd, plutil'), { timeout: 60_000 }, () => {
  const OLD_NODE = '/opt/stary-node/bin/node';
  const dataDir = (): string => path.join(sb.homeDir, '.local', 'share', 'rarog');
  const link = (): string => path.join(sb.homeDir, '.local', 'bin', 'rarog');
  let pkg: FakePackage;
  let before: string;

  /** Usługa załadowana z plistu paczki npm (prefiks względem `HOME`), jak po `service install` z paczki. */
  function packageService(prefix = 'prefiks'): void {
    writeConfig(ownerConfig());
    sb.loaded([SERVICE]);
    pkg = fakePackage(path.join(sb.homeDir, prefix), '0.9.0');
    mkdirSync(agents(), { recursive: true });
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(servicePlist(), renderServicePlist({
      programArguments: [...wrapperArgs(), OLD_NODE, pkg.bin, 'serve'], workingDirectory: pkg.root,
      log: path.join(dataDir(), 'server.log'),
    }));
    before = readFileSync(servicePlist(), 'utf8');
  }

  /** Odmowa bez żadnej zmiany: plist bajt w bajt, bez dowiązania i blokady, `launchctl` tylko pytał. */
  function expectUntouched(): void {
    expect(readFileSync(servicePlist(), 'utf8')).toBe(before);
    expect(existsSync(link())).toBe(false);
    expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
    expectNothingStopped();
  }

  it('bez terminala → odmowa przed fazą 0 (bez wrappera sekretów) z komendą do terminala; nic nie zmienione', () => {
    packageService();
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toBe(`rarog service install: service ${SERVICE} starts the rarog package 0.9.0 (${pkg.root}), and`
      + ` this is the repo clone ${REPO}, so install would switch the service from the package to this clone. Confirm`
      + ' the switch in a terminal: node bin/rarog.mjs service install prints the list of changes there and asks [y/N].'
      + ` Restart the service without switching: '${OLD_NODE}' '${pkg.bin}' restart. Nothing was stopped.\n`);
    expect(run.stdout).toBe('');
    expect(sb.calls('wrapper')).toEqual([]);
    expectUntouched();
  });

  it('w terminalu: lista zmian z powrotem na paczkę po fazie 0; „nie” albo EOF → odmowa, nic nie zatrzymane', async () => {
    packageService();
    for (const [answer, wrapperRuns] of [['n', 1], [null, 2]] as const) {
      const prompts: string[] = [];
      const run = await rarogInProcess(['service', 'install'], {}, {}, (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(answer);
      });
      expect(run.status, run.stderr).toBe(1);
      expect(prompts).toEqual([`Switch service ${SERVICE} from the package to this clone? [y/N] `]);
      const list = run.stdout.slice(run.stdout.indexOf(`Service ${SERVICE} starts`));
      expect(list).toBe([
        `Service ${SERVICE} starts the rarog package 0.9.0 (${pkg.root}); install switches it to this clone. What changes:`,
        `    entry: ${pkg.bin} → ${RAROG_BIN} (repo clone, version ${RAROG_VERSION})`,
        `    node: ${OLD_NODE} → ${SERVICE_NODE}`,
        `    service.wrapper: unchanged (${wrapperArgs().join(' ')})`,
        `    data directory (service log): unchanged (${dataDir()})`,
        `    symlink ${link()}: none → ${RAROG_BIN} (may shadow the rarog command of the package in PATH)`,
        '    server: stopped and started from the code of this clone; apps lose the connection for a few seconds',
        `  Unchanged: devices, config.json and the hook copy in ${path.join(sb.homeDir, '.claude', 'hooks', 'rarog')}`
          + ' (pnpm run hooks:doctor shows whether it matches this clone).',
        `  Back to the package: '${OLD_NODE}' '${pkg.bin}' service install, then rm '${link()}'.`,
        '',
      ].join('\n'));
      expect(run.stderr).toContain('rarog service install: switch declined; the service still starts the rarog'
        + ` package 0.9.0 (${pkg.root}). Nothing was stopped.`);
      // Faza 0 (z pełnym `--check` przez wrapper) przeszła przed pytaniem.
      expect(sb.calls('wrapper')).toHaveLength(wrapperRuns);
      expectUntouched();
    }
  });

  it('„t” → plist wskazuje ten klon, dowiązanie, restart; ponowna instalacja na klonie już nie pyta', async () => {
    packageService();
    const run = await rarogInProcess(['service', 'install'], {}, {}, () => Promise.resolve('t'));
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([
      `bootout ${target(SERVICE)}`,
      `bootstrap gui/${UID} ${servicePlist()}`,
      `kickstart ${target(SERVICE)}`,
    ]);
    const plist = plistJson(servicePlist());
    expect(plist['ProgramArguments']).toEqual([...wrapperArgs(), SERVICE_NODE, CLI, 'serve']);
    expect(plist['WorkingDirectory']).toBe(REPO);
    expect(readlinkSync(link())).toBe(RAROG_BIN);
    const again = await rarogInProcess(['service', 'install'], {}, {}, () => {
      throw new Error('pytanie przy usłudze, która już startuje ten klon');
    });
    expect(again.status, again.stderr).toBe(0);
  });

  it('Ctrl-C at the terminal after the question, while restart.sh runs: SIGTERM to it once, the lock stays until it'
    + ' ended, exit 130', async () => {
    packageService();
    const lock = path.join(configDir(), 'lock');
    const script = fakeRestartScript(sb.home.home, lock);
    assertFakeLaunchctl(sb, sb.env());
    // `bin/rarog.mjs` in a pseudo-terminal: the question opens its prompt (raw mode), so Ctrl-C reaches the
    // command as the SIGINT event of the prompt, not as a process signal.
    const child = spawn('python3', ['-I', '-c', PTY_RUN, process.execPath, CLI, 'service', 'install'], {
      cwd: sb.home.home, env: sb.env({ PATH: `${script.dir}:${sb.bin}:/usr/bin:/bin` }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let screen = '';
    let answered = false;
    let rarogPid = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      screen += chunk.toString('utf8');
      if (!answered && screen.includes('to this clone? [y/N] ')) {
        answered = true;
        child.stdin.write('t\r');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const pid = /PID ([0-9]+)/u.exec(chunk.toString('utf8'))?.[1];
      if (pid !== undefined) rarogPid = Number(pid);
    });
    const closed = new Promise<number | null>((resolve) => { child.on('close', resolve); });
    const late = new Promise<string>((resolve) => { setTimeout(resolve, 20_000, 'still running').unref(); });
    try {
      await script.started(20_000);
      expect(existsSync(lock)).toBe(true);
      child.stdin.write('\x03');
      expect(await Promise.race([closed, late]), screen).toBe(130);
      expect(script.events()).toEqual(['started', 'got TERM', 'lock held', 'cleanup done']);
      expect(existsSync(lock)).toBe(false);
      expect(screen)
        .toContain('restart.sh was interrupted (Ctrl-C) and stopped; the service is loaded, but unhealthy.');
    } finally {
      if (rarogPid > 0) {
        try {
          process.kill(rarogPid, 'SIGKILL');
        } catch {
          // Already ended.
        }
      }
      child.stdin.end();
      script.kill();
    }
  });

  it('dowiązanie polecenia paczki (prefiks ~/.local) → powrót odtwarza jego cel przez ln -sfn, nie rm', async () => {
    packageService('.local');
    // Dowiązanie, które zakłada npm przy prefiksie `~/.local`: względne, do wejścia paczki.
    const npmTarget = path.join('..', 'lib', 'node_modules', 'rarog', 'bin', 'rarog.mjs');
    mkdirSync(path.dirname(link()), { recursive: true });
    symlinkSync(npmTarget, link());
    const run = await rarogInProcess(['service', 'install'], {}, {}, () => Promise.resolve('t'));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`    symlink ${link()}: ${npmTarget} → ${RAROG_BIN} (may shadow the rarog command of`
      + ' the package in PATH)\n');
    const undo = `ln -sfn '${npmTarget}' '${link()}'`;
    expect(run.stdout).toContain(`  Back to the package: '${OLD_NODE}' '${pkg.bin}' service install, then ${undo}.\n`);
    expect(readlinkSync(link())).toBe(RAROG_BIN);
    // Komenda powrotu przywraca polecenie paczki w PATH.
    expect(spawnSync('bash', ['-c', undo]).status).toBe(0);
    expect(realpathSync(link())).toBe(realpathSync(pkg.bin));
  });

  it('usługa na innym klonie (bez zbudowanego main.js) → bez pytania, jak dotąd', async () => {
    writeConfig(ownerConfig());
    sb.loaded([SERVICE]);
    const other = fakePackage(path.join(sb.homeDir, 'inny-klon'), '0.0.1', { built: false });
    mkdirSync(agents(), { recursive: true });
    writeFileSync(servicePlist(), renderServicePlist({
      programArguments: [...wrapperArgs(), OLD_NODE, other.bin, 'serve'], workingDirectory: other.root,
      log: path.join(dataDir(), 'server.log'),
    }));
    const run = rarog(['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(plistJson(servicePlist())['ProgramArguments']).toEqual([...wrapperArgs(), SERVICE_NODE, CLI, 'serve']);
  });

  // Cel, którego klon nie odczyta (tu wejście paczki ze spacją bez węzła przed nim), może być paczką.
  it('plist z nieczytelnym celem → bez terminala odmowa przed fazą 0; w terminalu pytanie, „t” zastępuje', async () => {
    writeConfig(ownerConfig());
    sb.loaded([SERVICE]);
    pkg = fakePackage(path.join(sb.homeDir, 'Rarog Server'), '0.9.0');
    mkdirSync(agents(), { recursive: true });
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(servicePlist(), renderServicePlist({
      programArguments: [pkg.bin, 'serve'], workingDirectory: pkg.root, log: path.join(dataDir(), 'server.log'),
    }));
    before = readFileSync(servicePlist(), 'utf8');
    const issue = `${servicePlist()}: ProgramArguments has no "<node> …/bin/rarog.mjs".`;
    const refused = rarog(['service', 'install']);
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toBe(`rarog service install: service ${SERVICE}: target of the current service unreadable:`
      + ` ${issue} This is the repo clone ${REPO}, so install would replace the service without knowing what it starts`
      + ' (maybe the npm package). Confirm the replacement in a terminal: node bin/rarog.mjs service install prints the'
      + ' list of changes there and asks [y/N]. Nothing was stopped.\n');
    expect(sb.calls('wrapper')).toEqual([]);
    expectUntouched();
    const prompts: string[] = [];
    const declined = await rarogInProcess(['service', 'install'], {}, {}, (prompt) => {
      prompts.push(prompt);
      return Promise.resolve('n');
    });
    expect(declined.status, declined.stderr).toBe(1);
    expect(prompts).toEqual([`Replace service ${SERVICE} with a service of this clone? [y/N] `]);
    expect(declined.stdout.slice(declined.stdout.indexOf(`Service ${SERVICE}: install`))).toBe([
      `Service ${SERVICE}: install replaces it with a service of this clone, without knowing what it starts. What`
        + ' changes:',
      `    target of the current service unreadable: ${issue}`,
      `    entry: ? → ${RAROG_BIN} (repo clone, version ${RAROG_VERSION})`,
      `    node: ? → ${SERVICE_NODE}`,
      `    service.wrapper: ? → ${wrapperArgs().join(' ')}`,
      `    data directory (service log): unchanged (${dataDir()})`,
      `    symlink ${link()}: none → ${RAROG_BIN} (may shadow the rarog command of the package in PATH)`,
      '    server: stopped and started from the code of this clone; apps lose the connection for a few seconds',
      `  Unchanged: devices, config.json and the hook copy in ${path.join(sb.homeDir, '.claude', 'hooks', 'rarog')}`
        + ' (pnpm run hooks:doctor shows whether it matches this clone).',
      '  No command to go back to the previous installation: the service file does not say which one it started.',
      '',
    ].join('\n'));
    expect(declined.stderr).toContain('rarog service install: replacement declined; the service file is unchanged.'
      + ' Nothing was stopped.');
    expect(sb.calls('wrapper')).toHaveLength(1);
    expectUntouched();
    const accepted = await rarogInProcess(['service', 'install'], {}, {}, () => Promise.resolve('t'));
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(plistJson(servicePlist())['ProgramArguments']).toEqual([...wrapperArgs(), SERVICE_NODE, CLI, 'serve']);
  });
});

describe('rarog service: blokada', { timeout: 60_000 }, () => {
  it('blokada żywego procesu → odmowa, launchctl nietknięty', () => {
    ownerBefore();
    writeFileSync(path.join(configDir(), 'lock'), `${String(process.pid)}\n`);
    const run = rarog(['service', 'install']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`another call is running (PID ${String(process.pid)}`);
    expect(sb.calls('launchctl')).toEqual([]);
  });

  it.skipIf(!IS_MAC)(macOnly('równoległy `rarog restart` w trakcie instalacji → odmowa z PID-em instalacji', 'launchd'), async () => {
    ownerBefore();
    const env = sb.env({ FAKE_KICKSTART_SLEEP: '3' });
    assertFakeLaunchctl(sb, env);
    const install = spawn(process.execPath, [CLI, 'service', 'install'], { cwd: sb.home.home, env, stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => { install.on('exit', resolve); });
    try {
      const lock = path.join(configDir(), 'lock');
      for (let i = 0; i < 200 && !existsSync(lock); i += 1) await new Promise((r) => setTimeout(r, 50));
      const restart = rarog(['restart']);
      expect(restart.status).toBe(1);
      expect(restart.stderr).toContain(`another call is running (PID ${String(install.pid)}`);
      expect(await exited).toBe(0);
    } finally {
      install.kill('SIGKILL');
    }
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog service uninstall', 'launchd'), { timeout: 60_000 }, () => {
  it('bootout + usunięcie plistu, dane zostają; wypisuje ponowną instalację', () => {
    sb.loaded([SERVICE]);
    mkdirSync(agents(), { recursive: true });
    writeFileSync(servicePlist(), '<plist/>\n');
    const data = path.join(sb.homeDir, '.local', 'share', 'rarog');
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, 'devices.json'), '{}');
    const run = rarog(['service', 'uninstall']);
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([`bootout ${target(SERVICE)}`]);
    expect(existsSync(servicePlist())).toBe(false);
    expect(existsSync(path.join(data, 'devices.json'))).toBe(true);
    expect(run.stdout).toContain('unloaded (the service server is STOPPED)');
    expect(run.stdout).toContain('Reinstall: node bin/rarog.mjs service install.');
    expect(run.stdout).not.toContain(HERDR_AGENT_LABEL);
  });

  it('the herdr agent stays loaded with its plist; two lines say how to remove it', () => {
    sb.loaded([SERVICE, HERDR_AGENT_LABEL]);
    mkdirSync(agents(), { recursive: true });
    writeFileSync(servicePlist(), '<plist/>\n');
    const agent = herdrAgentPlistPath(sb.homeDir);
    writeFileSync(agent, '<plist/>\n');
    const run = rarog(['service', 'uninstall']);
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([`bootout ${target(SERVICE)}`]);
    expect(existsSync(agent)).toBe(true);
    expect(run.stdout).toContain(`The herdr agent ${HERDR_AGENT_LABEL} stays: it starts herdr at login, apart from`
      + ' Rarog.\n');
    expect(run.stdout).toContain('To remove it: rm ~/Library/LaunchAgents/ai.rarog.herdr.plist (from the next login);'
      + ` launchctl bootout ${target(HERDR_AGENT_LABEL)} also stops herdr and closes its panes at once.\n`);
  });

  it('paczka npm: komenda menedżera i reszta odinstalowania po kolei, katalog danych z logu usługi', async () => {
    sb.loaded([SERVICE]);
    mkdirSync(agents(), { recursive: true });
    const dataDir = path.join(sb.homeDir, 'dane-uslugi');
    writeFileSync(servicePlist(), renderServicePlist({
      programArguments: [process.execPath, CLI, 'serve'], workingDirectory: REPO, log: path.join(dataDir, 'server.log'),
    }));
    mkdirSync(path.join(dataDir, 'sdk'), { recursive: true });
    const run = await rarogInProcess(['service', 'uninstall'], {}, {
      mode: 'package', installRoot: '/opt/homebrew/lib/node_modules/@rarog/server',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(servicePlist())).toBe(false);
    expect(run.stdout).toContain('The data directory, ~/.config/rarog stay.');
    expect(run.stdout).toContain('Reinstall: rarog service install.');
    // Bez ustawień i bez kopii nie ma czego zdejmować: zostają komenda menedżera i katalogi.
    expect(run.stdout).toContain("1. Package: npm uninstall -g --prefix '/opt/homebrew' @rarog/server\n");
    expect(run.stdout).toContain(`rm -r '${dataDir}' '${configDir()}'`);
  });

  it('paczka npm, „y” na oba pytania → wpisy Raroga zdjęte z ustawień, kopia hooka usunięta', async () => {
    sb.loaded([SERVICE]);
    mkdirSync(agents(), { recursive: true });
    const dataDir = path.join(sb.homeDir, 'dane-uslugi');
    writeFileSync(servicePlist(), renderServicePlist({
      programArguments: [process.execPath, CLI, 'serve'], workingDirectory: REPO, log: path.join(dataDir, 'server.log'),
    }));
    mkdirSync(path.join(dataDir, 'sdk'), { recursive: true });
    const settings = userSettingsPath(sb.homeDir);
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, `${JSON.stringify({
      model: 'opus', ...(hookBlock(hookCommand(sb.homeDir)) as object),
      statusLine: { type: 'command', command: statuslineCommand(sb.homeDir) },
    }, null, 2)}\n`);
    mkdirSync(hookInstallDir(sb.homeDir), { recursive: true });
    writeFileSync(path.join(hookInstallDir(sb.homeDir), 'rarog-pending.mjs'), '// kopia\n');
    // Manifest z instalacji kopii ze skrótem treści: katalog bez takiego dowodu to nie kopia Raroga i zostaje.
    writeFileSync(path.join(hookInstallDir(sb.homeDir), 'manifest.json'), `${JSON.stringify({
      version: '1.0.0', at: 1, files: { 'rarog-pending.mjs': createHash('sha256').update('// kopia\n').digest('hex') },
    })}\n`);
    const prompts: string[] = [];
    const answers = ['y', 'y'];
    const run = await rarogInProcess(['service', 'uninstall'], {}, {
      mode: 'package', installRoot: '/opt/homebrew/lib/node_modules/@rarog/server',
    }, (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(answers.shift() ?? null);
    });
    expect(run.status, run.stderr).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(readFileSync(settings, 'utf8')).toBe(`${JSON.stringify({ model: 'opus' }, null, 2)}\n`);
    expect(existsSync(hookInstallDir(sb.homeDir))).toBe(false);
    expect(run.stdout).toContain(`  removed: ${hookInstallDir(sb.homeDir)}\n`);
    expect(run.stdout).toContain("1. Package: npm uninstall -g --prefix '/opt/homebrew' @rarog/server\n");
  });

  it('launchctl print z kodem innym niż 0 i 113 → odmowa, bez bootout, plist zostaje', () => {
    sb.loaded([SERVICE]);
    mkdirSync(agents(), { recursive: true });
    writeFileSync(servicePlist(), '<plist/>\n');
    const run = rarog(['service', 'uninstall'], { FAKE_UNKNOWN: SERVICE });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`launchctl print ${target(SERVICE)} does not tell whether ${SERVICE} is loaded`);
    expect(run.stderr).toContain('Nothing was stopped');
    expectNothingStopped();
    expect(existsSync(servicePlist())).toBe(true);
  });

  it('launchd nie zdejmuje usługi w limicie po bootout → odmowa, plist zostaje', async () => {
    sb.loaded([SERVICE]);
    mkdirSync(agents(), { recursive: true });
    writeFileSync(servicePlist(), '<plist/>\n');
    const run = await rarogInProcess(['service', 'uninstall'], { FAKE_BOOTOUT_LAG: 'never' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`label ${SERVICE} is still loaded after 0.05 s`);
    expect(run.stderr).toContain('The plist stays.');
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([`bootout ${target(SERVICE)}`]);
    expect(existsSync(servicePlist())).toBe(true);
  });

  // „nie wiem” w trakcie czekania po udanym bootout.
  it('„nie wiem” w trakcie czekania po bootout → odmowa, plist zostaje', () => {
    sb.loaded([SERVICE]);
    mkdirSync(agents(), { recursive: true });
    writeFileSync(servicePlist(), '<plist/>\n');
    // Pytania o usługę: przed odmową, przed `bootout`, a trzecie (pierwsze po `bootout`) dostaje kod 5.
    const run = rarog(['service', 'uninstall'], { FAKE_UNKNOWN: SERVICE, FAKE_UNKNOWN_FROM: '3' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`after launchctl bootout ${target(SERVICE)} the state is undecided (exit status 5`);
    expect(run.stderr).toContain('The plist stays.');
    expect(sb.calls('launchctl').filter((call) => !asking(call))).toEqual([`bootout ${target(SERVICE)}`]);
    expect(existsSync(servicePlist())).toBe(true);
  });

  it('niezaładowana i bez plistu → zielono, nic nie zatrzymane', () => {
    const run = rarog(['service', 'uninstall']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('was not loaded');
    expectNothingStopped();
  });

  // Uninstall in a clone removes only its own ~/.local/bin/rarog symlink (the one service install made).
  // The other branches of the symlink check (another clone, a regular file, no symlink) are covered once,
  // in the Linux suite: the function is shared, only its call differs per platform.
  describe('the rarog symlink', () => {
    const link = (): string => path.join(sb.homeDir, '.local', 'bin', 'rarog');

    function placeLink(): void {
      sb.loaded([SERVICE]);
      mkdirSync(agents(), { recursive: true });
      writeFileSync(servicePlist(), '<plist/>\n');
      mkdirSync(path.dirname(link()), { recursive: true });
      symlinkSync(RAROG_BIN, link());
    }

    it('symlink to this clone → removed, with a report line', async () => {
      placeLink();
      const run = await rarogInProcess(['service', 'uninstall']);
      expect(run.status, run.stderr).toBe(0);
      expect(lstatSync(link(), { throwIfNoEntry: false })).toBeUndefined();
      expect(run.stdout).toContain(`Symlink ${link()} removed (it pointed to this clone).\n`);
      expect(run.stdout).toContain('The data directory, ~/.config/rarog stay.');
    });

    it('npm package → the symlink is not touched and not mentioned', async () => {
      placeLink();
      const run = await rarogInProcess(['service', 'uninstall'], {}, {
        mode: 'package', installRoot: '/opt/homebrew/lib/node_modules/@rarog/server',
      });
      expect(run.status, run.stderr).toBe(0);
      expect(readlinkSync(link())).toBe(RAROG_BIN);
      expect(run.stdout).not.toContain(link());
    });
  });
});

describe('rarog service: wywołanie i platforma', { timeout: 60_000 }, () => {
  it('bez akcji, nieznana akcja, nadmiarowy argument → 64; --help → 0; launchctl nietknięty', () => {
    for (const argv of [['service'], ['service', 'start'], ['service', 'install', 'teraz']]) {
      expect(rarog(argv).status, argv.join(' ')).toBe(64);
    }
    const help = rarog(['service', '--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('rarog service install|uninstall');
    expect(sb.calls('launchctl')).toEqual([]);
  });

  it('macOS i Linux bez odmowy, inna platforma z jej nazwą', () => {
    expect(servicePlatformIssue('darwin')).toBeNull();
    expect(servicePlatformIssue('linux')).toBeNull();
    expect(servicePlatformIssue('freebsd')).toContain('this platform is freebsd');
  });

  it('środowisko „jak pod launchd”: dom, przepustki, systemowy PATH, nic więcej', () => {
    expect(launchdEnv({ HOME: '/h', USER: 'u', SHELL: '/bin/zsh', PATH: '/x', NODE_OPTIONS: '--y', XDG_DATA_HOME: '/d' }))
      .toEqual({ HOME: '/h', USER: 'u', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  });
});

describe('szablon plistu', () => {
  const input = {
    programArguments: ['/Users/znajomy/.local/bin/secret-env.sh', 'rarog', '--only', 'A,B', '--',
      '/opt/node-22/bin/node', '/Users/znajomy/repo <&> "rarog"/bin/rarog.mjs', 'serve'],
    workingDirectory: '/Users/znajomy/repo <&> "rarog"',
    log: "/Users/znajomy/.local/share/rarog/server's.log",
  };

  it('render = plik wzorcowy (odśwież: RAROG_FIXTURES_WRITE=1)', () => {
    const text = renderServicePlist(input);
    if (WRITE) {
      mkdirSync(path.dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, text);
    }
    expect(text).toBe(readFileSync(FIXTURE, 'utf8'));
    expect(text).not.toContain('{{');
    expect(text).not.toContain('<key>EnvironmentVariables</key>');
  });

  it.skipIf(!IS_MAC)(macOnly('prawdziwy plutil: -lint OK, wartości po escapowaniu wracają co do znaku', 'plutil'), () => {
    expect(spawnSync('/usr/bin/plutil', ['-lint', FIXTURE], { encoding: 'utf8' }).status).toBe(0);
    const plist = plistJson(FIXTURE);
    expect(plist['ProgramArguments']).toEqual(input.programArguments);
    expect(plist['WorkingDirectory']).toBe(input.workingDirectory);
    expect(plist['StandardOutPath']).toBe(input.log);
    expect(plist['Label']).toBe(SERVICE);
  });

  it('escapowanie XML: pięć znaków specjalnych', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('niewypełnione pole szablonu = błąd, nie plist z dziurą', () => {
    expect(() => renderServicePlist(input, '<string>{{NOWE}}</string>')).toThrow('a template field is left unfilled');
  });
});
