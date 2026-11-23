/**
 * `rarog restart` na Linuksie: jednostka `systemd --user` `rarog.service` jako
 * jedyna droga startu, a `scripts/restart.sh` z `RAROG_RESTART_UNIT`.
 *
 * Front biegnie przez wejście testowe z platformą `linux` (`rarog-linux-cli.mjs`) i woła prawdziwy `restart.sh`;
 * wszystko, co dotyka systemu, to atrapy w kształcie Linuksa z pomiaru kroku 0 (`systemd-atrapy.ts`: `uname`,
 * `systemctl`, `busctl`, `ps` bez `-E`, `pgrep`, `ss`, `curl`; `launchctl` i `nohup` tylko logują). Każdy test ma
 * `HOME` w katalogu tymczasowym, a `afterAll` sprawdza, że prawdziwe katalogi `rarog` i `~/.config/systemd`
 * właściciela nie powstały.
 *
 * Sprawdza: każdy stan jednostki (not-found z `config.json` i bez, loaded zdrowa, masked, bad-setting, inny stan,
 * obcy `FragmentPath`, drop-in, brak magistrali), środowisko menedżera (`busctl`, zmienne katalogu danych w powłoce
 * i w menedżerze, `serve --check` na środowisku menedżera), cel usługi z `ExecStart` (wejście innej instalacji,
 * inny węzeł w paczce i w klonie), węzeł z `ExecStart`, katalog logu jednostki, narzędzia `restart.sh` w `PATH`,
 * start (`systemctl --user restart` dokładnie raz, kod ≠ 0 bez `nohup`, kod 0 przy martwym `/health` = czerwony),
 * inną platformę, sam `restart.sh` na Linuksie (odmowa bez parametrów przed `kill`, 64 przy mieszaniu parametrów,
 * `ss` zamiast `lsof`, `ps eww` i ochrona demo) oraz render i parser `ExecStart` w obie strony.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../src/cli/io.ts';
import { Refusal } from '../src/cli/io.ts';
import { restartCommand } from '../src/cli/restart.ts';
import type { RestartDeps } from '../src/cli/restart.ts';
import { IROH_KEY_UNCHECKED_LINE, SECRETS_UNCHECKED_LINE } from '../src/cli/serve.ts';
import { RESTART_HOOK_REPAIR } from '../src/install/repair.ts';
import { serviceTarget } from '../src/install/service-target.ts';
import { RAROG_VERSION } from '../src/version.ts';
import {
  UNIT_NAME, classifyUnit, escapeExecArgument, escapeExecProgram, escapeUnitPath, parseExecStart, parseShow,
  renderExecStart, renderServiceUnit, unitFilePath,
} from '../src/cli/systemd-unit.ts';
import { realRarogDirsCreated } from './rarog-home.ts';
import { REPO, fake, fakeNode, linuxSandbox, rarogLinux } from './systemd-atrapy.ts';
import type { LinuxSandbox, Run } from './systemd-atrapy.ts';

/** Węzeł usługi tej instalacji: przy Node z Homebrew `opt/<formuła>/bin/node`, nie `Cellar` z `process.execPath`. */
const SERVICE_NODE = serviceTarget().node;

const CLI = path.join(REPO, 'bin', 'rarog.mjs');
const PORT = '18999';
const WRAPPER = ['/nieistniejacy/wrapper.sh', 'rarog', '--'];
const OWNER_CONFIG = {
  version: 1, env: { RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: PORT }, service: { wrapper: WRAPPER },
};
const SHOW = `--user show ${UNIT_NAME} -p LoadState -p FragmentPath -p DropInPaths -p NeedDaemonReload`
  + ' -p Environment -p EnvironmentFiles -p PassEnvironment -p UnsetEnvironment';
const RESTART = `--user restart ${UNIT_NAME}`;
/** Sztuczny sekret — prawdziwych testy nie znają. */
const FAKE_SECRET = 'TEST-ONLY-sekret-linuksa-xxxxxxxxxxxxxxxx';

let sb: LinuxSandbox;

beforeEach(() => { sb = linuxSandbox('rarog-restart-linux-', { ss: true }); });
afterEach(() => { sb.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

function writeConfig(value: unknown): void {
  const dir = path.join(sb.homeDir, '.config', 'rarog');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

const dataDir = (): string => path.join(sb.homeDir, '.local', 'share', 'rarog');

/**
 * Jednostka z szablonu, jak po `rarog service install`: wrapper + węzeł + `<repo>/bin/rarog.mjs serve`; `bin` =
 * wejście innej instalacji, `log` = log jednostki (domyślnie w katalogu danych z reguły).
 */
function writeUnit(node: string, { bin = CLI, log = path.join(dataDir(), 'server.log') } = {}): string {
  const file = unitFilePath(sb.homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderServiceUnit({ execStart: [...WRAPPER, node, bin, 'serve'], workingDirectory: REPO, log }));
  return file;
}

/** Zdrowa instalacja: `config.json` właściciela, jednostka i węzeł 22.22. */
function greenInstall(): void {
  writeConfig(OWNER_CONFIG);
  writeUnit(fakeNode(sb, 'v22.22.3'));
}

const restarts = (): string[] => sb.calls('systemctl').filter((line) => line.startsWith('--user restart'));

/** Odmowa frontu: kod 1, „Nothing was stopped”, `restart.sh` nie ruszył (pierwszy krok skryptu to `uname`). */
function expectRefusedBeforeScript(run: Run, needle: string): void {
  expect(run.status, run.stderr).toBe(1);
  expect(run.stderr).toContain(needle);
  expect(run.stderr).toContain('Nothing was stopped');
  expect(sb.calls('uname')).toEqual([]);
  expect(restarts()).toEqual([]);
  for (const tool of ['curl', 'nohup', 'launchctl', 'ss', 'pgrep']) expect(sb.calls(tool), tool).toEqual([]);
}

/** Proces, który nic nie robi (atrapa nasłuchu); `exited` = sygnał, którym zszedł. */
function idleProcess(
  env: Readonly<Record<string, string>> = {}, cwd = REPO,
): { pid: number; exited: Promise<string | null> } {
  // `node`, nie `sleep`: `ps -E` macOS nie pokazuje środowiska programów systemowych z `/bin`, a serwer to node.
  // Katalog roboczy jak u serwera tej instalacji (`rarog serve` robi `chdir` do korzenia), chyba że test chce obcy.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    detached: true, stdio: 'ignore', cwd, env: { PATH: '/usr/bin:/bin', ...env },
  });
  child.unref();
  const exited = new Promise<string | null>((resolve) => { child.on('exit', (_code, signal) => { resolve(signal); }); });
  return { pid: child.pid ?? 0, exited };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function killAll(pids: readonly number[]): void {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* już nie żyje */ }
  }
}

describe('rarog restart na Linuksie: jednostka systemd --user', { timeout: 60_000 }, () => {
  it('brak jednostki, bez config.json i z nim → odmowa z „rarog service install”, bez nohup', () => {
    for (const withConfig of [false, true]) {
      if (withConfig) writeConfig(OWNER_CONFIG);
      const run = rarogLinux(sb, ['restart']);
      expectRefusedBeforeScript(run, 'Install it: rarog service install');
      expect(run.stderr).toContain(`no systemd --user unit ${UNIT_NAME}`);
    }
    expect(sb.calls('systemctl')).toEqual([SHOW, SHOW]);
    expect(sb.calls('busctl')).toEqual([]);
  });

  it('jednostka nasza i zdrowa → restart.sh z UNIT, portem i logiem; systemctl restart raz, launchctl nigdy', () => {
    greenInstall();
    const run = rarogLinux(sb, ['restart'], {
      // Parametry z rodzica nie przechodzą: ustawia je wyłącznie `rarog restart` (inaczej UNIT+LABEL = 64).
      RAROG_RESTART_LABEL: 'ai.rarog.server', RAROG_RESTART_SERVE: 'rarog', RAROG_RESTART_PORT: '1234',
      RAROG_RESTART_UNIT: 'inna.service',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(SECRETS_UNCHECKED_LINE);
    expect(run.stdout).toContain(`rarog restart: unit ${UNIT_NAME} — restart.sh with it, port ${PORT}.`);
    expect(run.stdout).toContain(`start: systemd --user (${UNIT_NAME}) — systemctl --user restart`);
    expect(run.stdout).toContain(`log: ${path.join(dataDir(), 'server.log')}`);
    expect(sb.calls('systemctl')).toEqual([SHOW, RESTART]);
    expect(sb.calls('busctl')).toEqual([
      '--user --json=short get-property org.freedesktop.systemd1 /org/freedesktop/systemd1'
        + ' org.freedesktop.systemd1.Manager Environment',
    ]);
    expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
    expect(sb.calls('launchctl')).toEqual([]);
    expect(sb.calls('nohup')).toEqual([]);
    // Na Linuksie `ps` idzie w formie BSD (`eww`), nigdy `-E` (procps-ng: „unsupported SysV option”).
    expect(sb.calls('ps').filter((line) => line.startsWith('-E'))).toEqual([]);
  });

  it.each([
    ['masked', { LoadState: 'masked' }, `Unmask it: systemctl --user unmask ${UNIT_NAME}`],
    ['bad-setting', { LoadState: 'bad-setting' }, 'LoadState=bad-setting'],
    ['inny LoadState', { LoadState: 'error' }, 'LoadState=error'],
    ['obcy FragmentPath', { FragmentPath: '/etc/systemd/user/rarog.service' },
      'loaded from /etc/systemd/user/rarog.service'],
    ['drop-in', { DropInPaths: '/etc/systemd/user/rarog.service.d/env.conf' }, 'has drop-ins'],
    // Plik zmieniony bez daemon-reload i środowisko dopisane w samym pliku jednostki.
    ['NeedDaemonReload=yes', { NeedDaemonReload: 'yes' }, 'without systemctl --user daemon-reload'],
    ['Environment= w pliku jednostki', { Environment: 'XDG_DATA_HOME=/srv/inne-dane' },
      'sets environment in the unit itself (Environment)'],
    ['EnvironmentFile= w pliku jednostki', { EnvironmentFiles: '/srv/env (ignore_errors=no)' },
      'sets environment in the unit itself (EnvironmentFiles)'],
    ['brak magistrali', { 'bus-down': '' }, 'Failed to connect to bus: No medium found'],
  ])('%s → odmowa przed restart.sh', (_name, state, needle) => {
    greenInstall();
    for (const [name, value] of Object.entries(state)) sb.set(name, value);
    const run = rarogLinux(sb, ['restart']);
    expectRefusedBeforeScript(run, needle);
    // Wartości środowiska jednostki nie trafiają na ekran — tylko nazwy właściwości.
    expect(run.stderr).not.toContain('/srv/inne-dane');
    expect(sb.calls('systemctl')).toEqual([SHOW]);
    expect(sb.calls('busctl')).toEqual([]);
  });

  it('busctl nie czyta środowiska menedżera → odmowa', () => {
    greenInstall();
    sb.set('busctl-down', '');
    expectRefusedBeforeScript(rarogLinux(sb, ['restart']), 'systemd --user manager environment');
  });

  it('zmienna katalogu danych w menedżerze albo w powłoce → odmowa przed stopem, nasłuch żyje', async () => {
    greenInstall();
    const listener = idleProcess();
    sb.set('listeners', String(listener.pid));
    try {
      for (const name of ['XDG_DATA_HOME', 'RAROG_DATA_DIR']) {
        sb.managerEnv({ [name]: '/srv/inne-dane' });
        const run = rarogLinux(sb, ['restart']);
        expectRefusedBeforeScript(run, `systemctl --user unset-environment ${name}`);
        // Wartość ze środowiska menedżera nie trafia na ekran.
        expect(run.stderr).not.toContain('/srv/inne-dane');
      }
      sb.managerEnv();
      expectRefusedBeforeScript(rarogLinux(sb, ['restart'], { RAROG_DATA_DIR: '/x' }), 'is set in this shell');
      expect(alive(listener.pid)).toBe(true);
    } finally {
      killAll([listener.pid]);
    }
    await listener.exited;
  });

  it('serve --check biegnie na środowisku menedżera: zły klucz iroh menedżera odmawia, dobry w powłoce nie pomaga', () => {
    const key = '78'.repeat(32);
    writeConfig({ version: 1, env: { ...OWNER_CONFIG.env, RAROG_IROH: '1', RAROG_IROH_RELAY: 'https://relay.example./' } });
    writeUnit(fakeNode(sb, 'v22.22.3'));
    // Przy RAROG_IROH=1 klucz musi mieć 64 znaki hex: „demo” z menedżera przewraca --check.
    sb.managerEnv({ RAROG_IROH_KEY: 'demo' });
    const run = rarogLinux(sb, ['restart'], { RAROG_IROH_KEY: key });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('rarog restart: the config does not pass rarog serve --check');
    expect(run.stderr).toContain('RAROG_IROH_KEY must be 64 hex characters');
    expect(restarts()).toEqual([]);
    expect(sb.calls('uname')).toEqual([]);
    for (const out of [run.stdout, run.stderr]) expect(out).not.toContain(key);
  });

  // Klucz iroh „niesprawdzony” przy wrapperze sprawdza pełne `serve --check` przez wrapper na
  // środowisku menedżera, zanim cokolwiek się zatrzyma.
  it('RAROG_IROH=1 i service.wrapper: klucz z wrappera → restart; wrapper bez klucza → odmowa przed restart.sh', () => {
    const key = '56'.repeat(32);
    const wrapper = path.join(sb.homeDir, 'wrapper', 'eksport.sh');
    mkdirSync(path.dirname(wrapper), { recursive: true });
    const install = (exports: readonly string[]): void => {
      fake(wrapper, [`printf '%s\\n' "$*" >> '${sb.logs}/wrapper'`, ...exports, 'shift', 'exec "$@"']);
      const env = { ...OWNER_CONFIG.env, RAROG_IROH: '1', RAROG_IROH_RELAY: 'https://relay.example./' };
      writeConfig({ ...OWNER_CONFIG, env, service: { wrapper: [wrapper, '--'] } });
    };
    writeUnit(fakeNode(sb, 'v22.22.3'));

    install([`export SONIOX_API_KEY='${FAKE_SECRET}'`]);
    let run = rarogLinux(sb, ['restart']);
    expectRefusedBeforeScript(run, 'through service.wrapper does not see RAROG_IROH_KEY');
    expect(run.stderr).toContain('RAROG_IROH=1 without RAROG_IROH_KEY');

    install([`export RAROG_IROH_KEY='${key}'`]);
    run = rarogLinux(sb, ['restart']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(IROH_KEY_UNCHECKED_LINE);
    expect(sb.calls('wrapper')).toEqual(Array(2).fill(`-- ${SERVICE_NODE} ${CLI} serve --check`));
    expect(restarts()).toEqual([RESTART]);
    for (const out of [run.stdout, run.stderr]) {
      expect(out).not.toContain(key);
      expect(out).not.toContain(FAKE_SECRET);
    }
  });

  it('zła konfiguracja → odmowa przed restart.sh', () => {
    writeUnit(fakeNode(sb, 'v22.22.3'));
    writeConfig({ ...OWNER_CONFIG, env: { ...OWNER_CONFIG.env, RAROG_MAX_PANES: '0' } });
    const run = rarogLinux(sb, ['restart']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('the config does not pass rarog serve --check');
    expect(restarts()).toEqual([]);
    expect(sb.calls('uname')).toEqual([]);
  });

  it('węzeł z ExecStart: brak, 20.x, 22.14 → odmowa przed restart.sh', () => {
    writeConfig(OWNER_CONFIG);
    const cases: [string | null, string][] = [
      [null, 'does not exist or is not executable'],
      ['v20.19.0', 'v20.19.0'],
      ['v22.14.0', 'v22.14.0'],
    ];
    for (const [version, needle] of cases) {
      rmSync(path.join(sb.homeDir, 'node-uslugi'), { recursive: true, force: true });
      writeUnit(fakeNode(sb, version));
      expectRefusedBeforeScript(rarogLinux(sb, ['restart']), needle);
    }
  });

  it('ExecStart z wejściem innej instalacji (jest albo już jej nie ma) → odmowa z jej wersją i service install', () => {
    writeConfig(OWNER_CONFIG);
    const other = path.join(sb.homeDir, 'inna-instalacja');
    const otherBin = path.join(other, 'bin', 'rarog.mjs');
    mkdirSync(path.dirname(otherBin), { recursive: true });
    writeFileSync(otherBin, '');
    writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'rarog', version: '0.9.0' }));
    writeUnit(fakeNode(sb, 'v22.22.3'), { bin: otherBin });
    for (const version of ['version 0.9.0', 'the file is gone']) {
      const run = rarogLinux(sb, ['restart']);
      expectRefusedBeforeScript(run, `the service points to another installation (${otherBin}, ${version})`);
      expect(run.stderr).toContain('run node bin/rarog.mjs service install from this installation');
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('paczka: inny węzeł usługi → odmowa; inne wejście → odmowa z wersją; klon: inny węzeł to uwaga, ten sam — cisza', async () => {
    greenInstall();
    const node = fakeNode(sb, 'v22.22.3');
    const restart = async (deps: RestartDeps): Promise<{ code: number; stderr: string }> => {
      let stderr = '';
      const io: CliIo = {
        stdout: () => {}, stderr: (text) => { stderr += text; }, env: sb.env(), cwd: sb.homeDir, platform: 'linux',
      };
      return { code: await restartCommand(['restart'], io, deps), stderr };
    };
    const otherNode = await restart({ mode: 'package', current: { node: process.execPath, bin: CLI } });
    expect(otherNode.code).toBe(1);
    expect(otherNode.stderr).toContain(`the service starts with node ${node}, but this command runs on`
      + ` ${process.execPath}; run rarog service install so the service starts with this installation's node. Nothing`
      + ' was stopped.');
    const otherBin = await restart({ mode: 'package', current: { node, bin: '/inna/paczka/bin/rarog.mjs' } });
    expect(otherBin.code).toBe(1);
    expect(otherBin.stderr).toContain(`the service points to another installation (${CLI}, version ${RAROG_VERSION}),`
      + ' but this command is /inna/paczka/bin/rarog.mjs');
    expect(otherBin.stderr).toContain('run rarog service install from this installation');
    expect(sb.calls('uname')).toEqual([]);
    expect(restarts()).toEqual([]);
    const clone = rarogLinux(sb, ['restart']);
    expect(clone.status, clone.stderr).toBe(0);
    expect(clone.stderr).toContain(`rarog restart: warning, the service starts with node ${node}, but this command`
      + ` runs on ${process.execPath} — the restart keeps the service's node; node bin/rarog.mjs service install`
      + ' switches it.');
    writeUnit(process.execPath);
    const same = rarogLinux(sb, ['restart']);
    expect(same.status, same.stderr).toBe(0);
    expect(same.stderr).not.toContain('warning, the service starts with node');
  });

  it('log jednostki poza katalogiem danych → odmowa z service install; przez dowiązanie do katalogu danych → restart', () => {
    writeConfig(OWNER_CONFIG);
    const other = path.join(sb.homeDir, 'stare-dane');
    mkdirSync(other, { recursive: true });
    mkdirSync(dataDir(), { recursive: true });
    writeUnit(fakeNode(sb, 'v22.22.3'), { log: path.join(other, 'server.log') });
    const refused = rarogLinux(sb, ['restart']);
    expectRefusedBeforeScript(refused, `The data directory from this shell ${dataDir()} and the directory of the installed`
      + ` service ${other} differ`);
    expect(refused.stderr).toContain('Reinstall the service: node bin/rarog.mjs service install.');
    rmSync(other, { recursive: true });
    symlinkSync(dataDir(), other);
    const run = rarogLinux(sb, ['restart']);
    expect(run.status, run.stderr).toBe(0);
    expect(restarts()).toEqual([RESTART]);
  });

  it('ExecStart spoza gramatyki renderera (słowa bez cudzysłowu, $ w argumencie) → odmowa', () => {
    writeConfig(OWNER_CONFIG);
    const node = fakeNode(sb, 'v22.22.3');
    const file = writeUnit(node);
    for (const execStart of [`${node} ${CLI} serve`, `"${node}" "${CLI}" "serve" "$HOME"`]) {
      writeFileSync(file, `[Service]\nExecStart=${execStart}\n`);
      expectRefusedBeforeScript(rarogLinux(sb, ['restart']), 'ExecStart does not have the shape rarog service'
        + ' install writes');
    }
  });

  it('brak curl, ps i pgrep w PATH → odmowa z listą', () => {
    greenInstall();
    for (const tool of ['curl', 'ps', 'pgrep']) rmSync(path.join(sb.bin, tool));
    const run = rarogLinux(sb, ['restart'], { PATH: `${sb.bin}:${sb.sys}` });
    expectRefusedBeforeScript(run, 'missing in PATH: curl, ps, pgrep');
  });

  it('systemctl --user restart z kodem ≠ 0 → błąd, bez nohup i bez health', () => {
    greenInstall();
    sb.set('restart-rc', '1');
    const run = rarogLinux(sb, ['restart']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`ERROR: systemctl --user restart ${UNIT_NAME} exited with code 1`);
    expect(restarts()).toEqual([RESTART]);
    expect(sb.calls('nohup')).toEqual([]);
    expect(sb.calls('curl')).toEqual([]);
  });

  it('systemctl --user restart z kodem 0, ale /health martwe → czerwony restart (kod 0 to nie zdrowie)', () => {
    greenInstall();
    sb.set('health', null);
    const run = rarogLinux(sb, ['restart']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Server does not respond on /health');
    expect(restarts()).toEqual([RESTART]);
    expect(sb.calls('nohup')).toEqual([]);
  });

  it('inna platforma niż darwin i linux → odmowa bez restart.sh', async () => {
    let stderr = '';
    const io: CliIo = {
      stdout: () => {}, stderr: (text) => { stderr += text; }, env: sb.env(), cwd: sb.homeDir, platform: 'freebsd',
    };
    expect(await restartCommand(['restart'], io)).toBe(1);
    expect(stderr).toContain('this platform is freebsd');
    expect(stderr).toContain('Nothing was stopped');
    expect(sb.calls('systemctl')).toEqual([]);
    expect(sb.calls('launchctl')).toEqual([]);
  });
});

describe('restart.sh na Linuksie (atrapa uname)', { timeout: 60_000 }, () => {
  // Jednostka załadowana (sam `restart.sh` jej nie sprawdza — robi to front; tu tylko `systemctl restart` ma ją znać).
  beforeEach(() => { sb.set('LoadState', 'loaded'); });

  function restartScript(extra: NodeJS.ProcessEnv = {}): Run {
    const result = spawnSync('bash', ['scripts/restart.sh'], {
      cwd: REPO, env: sb.env({
        RAROG_LOG: path.join(sb.homeDir, 'server.log'), RAROG_RESTART_HOOK_REPAIR: RESTART_HOOK_REPAIR, ...extra,
      }), encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('bez parametrów → odmowa przed kill: nasłuch żyje, systemctl ani ss nie wołane', async () => {
    const listener = idleProcess();
    sb.set('listeners', String(listener.pid));
    sb.set('pattern-pids', String(listener.pid));
    try {
      const run = restartScript();
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`on Linux only the systemd --user unit ${UNIT_NAME} starts the server`);
      expect(run.stderr).toContain('Nothing was stopped');
      expect(alive(listener.pid)).toBe(true);
      for (const tool of ['systemctl', 'ss', 'pgrep', 'curl', 'launchctl', 'nohup']) {
        expect(sb.calls(tool), tool).toEqual([]);
      }
    } finally {
      killAll([listener.pid]);
    }
    await listener.exited;
  });

  it('UNIT z SERVE albo z LABEL, obca jednostka i UNIT na macOS → 64, nic nie zatrzymane', () => {
    for (const extra of [
      { RAROG_RESTART_UNIT: UNIT_NAME, RAROG_RESTART_SERVE: 'rarog' },
      { RAROG_RESTART_UNIT: UNIT_NAME, RAROG_RESTART_LABEL: 'ai.rarog.server' },
      { RAROG_RESTART_UNIT: 'inna.service' },
    ]) {
      const run = restartScript({ ...extra, RAROG_RESTART_PORT: PORT });
      expect(run.status, JSON.stringify(extra)).toBe(64);
    }
    sb.set('uname', 'Darwin');
    expect(restartScript({ RAROG_RESTART_UNIT: UNIT_NAME, RAROG_RESTART_PORT: PORT }).status).toBe(64);
    for (const tool of ['systemctl', 'ss', 'pgrep', 'curl', 'launchctl']) expect(sb.calls(tool), tool).toEqual([]);
  });

  it('bez lsof: nasłuch z ss (kilka pid= w linii) dostaje SIGTERM, potem systemctl restart raz', async () => {
    // Warunek testu: żadnego `lsof` w PATH skryptu, także z gospodarza (runner `ubuntu-latest` ma go w /usr/bin).
    const lsof = spawnSync('/bin/bash', ['--norc', '-c', 'command -v lsof'], { env: sb.env(), encoding: 'utf8' });
    expect(lsof.stdout).toBe('');
    const first = idleProcess();
    const second = idleProcess();
    sb.set('listeners', `${String(first.pid)} ${String(second.pid)}`);
    try {
      const run = restartScript({ RAROG_RESTART_UNIT: UNIT_NAME, RAROG_RESTART_PORT: PORT });
      expect(run.status, run.stderr).toBe(0);
      expect(await first.exited).toBe('SIGTERM');
      expect(await second.exited).toBe('SIGTERM');
      expect(sb.calls('ss')[0]).toBe(`-Hltnp sport = :${PORT}`);
      expect(sb.calls('systemctl')).toEqual([RESTART]);
      expect(sb.calls('launchctl')).toEqual([]);
      expect(sb.calls('nohup')).toEqual([]);
      expect(run.stderr).toBe('');
    } finally {
      killAll([first.pid, second.pid]);
    }
  });

  it('wzorzec argv: ps eww zamiast ps -E; demo, obcy port i obcy katalog roboczy przeżywają', async () => {
    const prod = idleProcess();
    const demo = idleProcess({ RAROG_DEMO: '1', RAROG_PORT: '18952' });
    const other = idleProcess({ RAROG_PORT: '18961' });
    // Serwer innego projektu o tym samym argv, bez zmiennych Raroga, w obcym katalogu roboczym.
    const foreign = idleProcess({ PORT: '3000' }, sb.homeDir);
    sb.set('pattern-pids', [prod, demo, other, foreign].map((c) => String(c.pid)).join(' '));
    try {
      const run = restartScript({ RAROG_RESTART_UNIT: UNIT_NAME, RAROG_RESTART_PORT: PORT });
      expect(run.status, run.stderr).toBe(0);
      expect(await prod.exited).toBe('SIGTERM');
      expect(alive(demo.pid)).toBe(true);
      expect(alive(other.pid)).toBe(true);
      expect(alive(foreign.pid)).toBe(true);
      const ps = sb.calls('ps');
      expect(ps).toContain(`eww -o command= -p ${String(demo.pid)}`);
      expect(ps.filter((line) => line.startsWith('-E'))).toEqual([]);
      expect(sb.calls('systemctl')).toEqual([RESTART]);
    } finally {
      killAll([prod.pid, demo.pid, other.pid, foreign.pid]);
    }
  });

  // systemd (`Restart=always`) wskrzesza serwer po jego wyjściu: atrapa `ss` pokazuje wtedy nowy PID z pliku stanu
  // `revived`. Krok stopu czeka tylko na PID, któremu wysłał SIGTERM; nowy należy do `systemctl --user restart`.
  it('stary PID wychodzi po SIGTERM, systemd wskrzesza nowy → bez SIGKILL, nowy nietknięty, systemctl restart raz', async () => {
    fake(path.join(sb.bin, 'ss'), [
      `printf '%s\\n' "$*" >> '${sb.logs}/ss'`,
      'alive() {',
      '  for p in $(cat "$1" 2>/dev/null); do',
      '    st="$(/bin/ps -p "$p" -o stat= 2>/dev/null || true)"',
      '    case "$st" in \'\'|Z*) ;; *) echo "$p" ;; esac',
      '  done',
      '}',
      `out="$(alive '${sb.state}/listeners')"`,
      `[ -n "$out" ] || out="$(alive '${sb.state}/revived')"`,
      '[ -n "$out" ] || exit 0',
      'users=""',
      'for p in $out; do users="${users:+$users,}(\\"node\\",pid=$p,fd=21)"; done',
      'printf \'LISTEN 0      511    127.0.0.1:%s 0.0.0.0:* users:(%s)\\n\' "${2##*:}" "$users"',
    ]);
    const old = idleProcess();
    const revived = idleProcess();
    sb.set('listeners', String(old.pid));
    sb.set('revived', String(revived.pid));
    try {
      const run = restartScript({ RAROG_RESTART_UNIT: UNIT_NAME, RAROG_RESTART_PORT: PORT });
      expect(run.stderr).not.toContain('did not exit after SIGTERM');
      expect(run.status, run.stderr).toBe(0);
      expect(await old.exited).toBe('SIGTERM');
      // Stan z `ps`: zabity sygnałem, a jeszcze nieodebrany przez pętlę zdarzeń proces to zombie, nie żywy.
      const stat = spawnSync('/bin/ps', ['-p', String(revived.pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
      expect(stat).not.toBe('');
      expect(stat).not.toContain('Z');
      expect(sb.calls('systemctl')).toEqual([RESTART]);
    } finally {
      killAll([old.pid, revived.pid]);
    }
    await revived.exited;
  });
});

describe('systemd-unit: render, parser ExecStart i stan jednostki', () => {
  it('program w cudzysłowie bez $$, argumenty z \\ " % $ escapowane, pola ścieżek z %%', () => {
    expect(escapeExecProgram('/opt/$x/n ode%')).toBe('"/opt/$x/n ode%%"');
    expect(escapeExecArgument('a "b" \\c 50% $HOME')).toBe('"a \\"b\\" \\\\c 50%% $$HOME"');
    expect(renderExecStart(['/w r/wrapper.sh', 'rarog', '--'])).toBe('"/w r/wrapper.sh" "rarog" "--"');
    expect(escapeUnitPath('/srv/re po%/x$y', 'WorkingDirectory')).toBe('/srv/re po%%/x$y');
  });

  it('wartości, których jednostka nie przeniesie → Refusal z nazwą pola', () => {
    for (const bad of ['/a\\b', '/a"b', '/a\nb', 'wzgledna/node']) {
      expect(() => escapeExecProgram(bad), bad).toThrow(Refusal);
    }
    for (const bad of ['/a\\b', '/a"b', '/a\nb', 'wzgledna', '/kończy się spacją ']) {
      expect(() => escapeUnitPath(bad, 'WorkingDirectory'), bad).toThrow(/WorkingDirectory/);
    }
    expect(() => escapeExecArgument('a\nb')).toThrow(Refusal);
    expect(() => escapeExecArgument('')).toThrow(Refusal);
  });

  it('render jednostki z szablonu: pola z escapowaniem, bez Environment=, parser oddaje argv', () => {
    const argv = ['/opt/w r/$wrap.sh', '--klucz=a "b" \\c', '50%', '$HOME', '/srv/node 22/bin/node',
      '/srv/re po/bin/rarog.mjs', 'serve'];
    const text = renderServiceUnit({ execStart: argv, workingDirectory: '/srv/re po%', log: '/d a/server.log' });
    expect(text).toContain('WorkingDirectory=/srv/re po%%\n');
    expect(text).toContain('StandardOutput=append:/d a/server.log\n');
    expect(text).toContain('StandardError=append:/d a/server.log\n');
    expect(text).toContain('StartLimitIntervalSec=0\n');
    expect(text).toContain('Restart=always\nRestartSec=2\n');
    expect(text).toContain('WantedBy=default.target\n');
    expect(text).not.toMatch(/^Environment/m);
    expect(text).not.toContain('{{');
    expect(parseExecStart(text)).toEqual({ argv });
  });

  it('pola szablonu podstawiane jednym przebiegiem: znacznik w wartości zostaje dosłowny', () => {
    const argv = ['/opt/{{LOG}}/node', '/srv/{{WORKING_DIRECTORY}}/bin/rarog.mjs', 'serve'];
    const text = renderServiceUnit({ execStart: argv, workingDirectory: '/srv/{{EXEC_START}}', log: '/d/server.log' });
    expect(parseExecStart(text)).toEqual({ argv });
    expect(text).toContain('WorkingDirectory=/srv/{{EXEC_START}}\n');
    expect(() => renderServiceUnit({ execStart: argv, workingDirectory: '/srv', log: '/d/l' }, 'X={{NOWE}}\n'))
      .toThrow('template field {{NOWE}} is left unfilled');
  });

  it('parser i renderer w obie strony dla dowolnych argumentów i programu bez \\ i "', () => {
    const arg = fc.string({ minLength: 1 }).filter((value) => !/[\n\r]/.test(value));
    const program = fc.string().map((value) => `/${value}`).filter((value) => !/[\n\r"\\]/.test(value));
    fc.assert(fc.property(program, fc.array(arg, { maxLength: 6 }), (prog, args) => {
      const unit = `[Service]\nExecStart=${renderExecStart([prog, ...args])}\n`;
      expect(parseExecStart(unit)).toEqual({ argv: [prog, ...args] });
    }));
  });

  it('parser odrzuca to, czego renderer nie pisze', () => {
    for (const line of [
      'ExecStart=/usr/bin/node /x/bin/rarog.mjs serve',
      'ExecStart=-"/usr/bin/node"',
      'ExecStart="/usr/bin/node" "%h/x"',
      'ExecStart="/usr/bin/node" "$HOME"',
      'ExecStart="/usr/bin/node" "a\\nb"',
      'ExecStart="/usr/bin/node" "a"b',
      'ExecStart="/usr/bin/node',
      'ExecStart=',
      'ExecStart="/a"\nExecStart="/b"',
      '[Service]',
    ]) {
      expect(parseExecStart(line), line).toHaveProperty('issue');
    }
  });

  it('stan jednostki: not-found, masked, bad-setting, inny, obcy plik, drop-in, nasza (także przez dowiązanie)', () => {
    const home = '/home/rarog';
    const ours = unitFilePath(home);
    const show = (text: string): ReadonlyMap<string, string> => parseShow(text);
    expect(classifyUnit(show('LoadState=not-found\nFragmentPath=\n'), home)).toEqual({ kind: 'absent' });
    expect(classifyUnit(show(`LoadState=masked\nFragmentPath=${ours}\n`), home).kind).toBe('masked');
    expect(classifyUnit(show('LoadState=bad-setting\n'), home).kind).toBe('bad-setting');
    expect(classifyUnit(show('LoadState=\n'), home)).toEqual({ kind: 'other', detail: 'LoadState=(empty)' });
    expect(classifyUnit(show('LoadState=loaded\nFragmentPath=/etc/systemd/user/rarog.service\n'), home).kind)
      .toBe('foreign');
    expect(classifyUnit(show(`LoadState=loaded\nFragmentPath=${ours}\nDropInPaths=/x.conf\n`), home).kind)
      .toBe('drop-in');
    expect(classifyUnit(show(`LoadState=loaded\nFragmentPath=${ours}\nDropInPaths=\n`), home).kind).toBe('ours');
    expect(classifyUnit(show(`LoadState=loaded\nFragmentPath=${ours}\nNeedDaemonReload=yes\n`), home).kind)
      .toBe('stale');
    expect(classifyUnit(show(`LoadState=loaded\nFragmentPath=${ours}\nPassEnvironment=XDG_DATA_HOME\n`), home))
      .toEqual({ kind: 'environment', detail: 'PassEnvironment' });
    expect(parseShow('Environment=A=b c\n').get('Environment')).toBe('A=b c');
    // Dom pod dowiązaniem: FragmentPath z rozwiniętą ścieżką to ten sam plik.
    const real = path.join(sb.homeDir, 'prawdziwy');
    const link = path.join(sb.homeDir, 'dowiazanie');
    mkdirSync(path.dirname(unitFilePath(real)), { recursive: true });
    writeFileSync(unitFilePath(real), '');
    symlinkSync(real, link);
    expect(classifyUnit(show(`LoadState=loaded\nFragmentPath=${unitFilePath(real)}\n`), link).kind).toBe('ours');
  });
});
