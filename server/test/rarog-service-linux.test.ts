/**
 * `rarog service install|uninstall` na Linuksie: jednostka `systemd --user`
 * `rarog.service` z szablonu `templates/rarog.service`.
 *
 * Wszystko, co dotyka systemu, to atrapy w kształcie Linuksa z pomiaru kroku 0 (`systemd-atrapy.ts`: `systemctl`
 * z `show`, `daemon-reload`, `enable`, `restart`, `disable --now`; `busctl` z `Environment` i `UnitPath` menedżera;
 * `loginctl`; `uname`, `ps`, `pgrep`, `ss`, `curl`), do tego `systemd-analyze` (log wywołań, porażka na żądanie)
 * i `service.wrapper` w katalogu testu (zapisuje argumenty i środowisko, eksportuje sztuczny sekret i robi `exec`
 * reszty). Odmowy fazy 0 i `uninstall` biegną w procesie testu (`serviceCommand` z platformą `linux`), faza 1 przez
 * wejście testowe `rarog-linux-cli.mjs`, bo woła prawdziwy `restart.sh`. Każdy test ma `HOME` w katalogu
 * tymczasowym, a `afterAll` sprawdza, że prawdziwe katalogi `rarog` i `~/.config/systemd` nie powstały.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_BACKUP_DIRNAME } from '../src/cli/claude-settings.ts';
import type { CliIo } from '../src/cli/io.ts';
import { Refusal } from '../src/cli/io.ts';
import { questionPrompt } from '../src/cli/screen/ask.ts';
import { LAYOUT_DEFAULT } from '../src/cli/screen/style.ts';
import { RAROG_BIN, packageUninstallNotes, serviceCommand, unitRollbackLines } from '../src/cli/service.ts';
import {
  contextHookCommand, denyReadPaths, hookBlock, hookCommand, hookInstallDir, statuslineCommand, userSettingsPath,
  visibleLine,
} from '../src/herdr/hook-config.ts';
import type { ServiceDeps } from '../src/cli/service.ts';
import { UNIT_NAME, parseExecStart, renderServiceUnit, unitFilePath } from '../src/cli/systemd-unit.ts';
import { serviceTarget } from '../src/install/service-target.ts';
import { realRarogDirsCreated } from './rarog-home.ts';
import { fakePackage } from './rarog-service-sandbox.ts';
import { REPO, assertFakeSystemctl, fake, linuxSandbox, rarogLinux } from './systemd-atrapy.ts';
import type { LinuxSandbox, Run } from './systemd-atrapy.ts';

/** Węzeł usługi tej instalacji: przy Node z Homebrew `opt/<formuła>/bin/node`, nie `Cellar` z `process.execPath`. */
const SERVICE_NODE = serviceTarget().node;

const PORT = '18997';
/** Sztuczny sekret — prawdziwych testy nie znają; nie może pojawić się na wyjściu ani w jednostce. */
const FAKE_SECRET = 'TEST-ONLY-sekret-jednostki-xxxxxxxxxxxxxxxx';
const SHOW = `--user show ${UNIT_NAME} -p LoadState -p FragmentPath -p DropInPaths -p NeedDaemonReload`
  + ' -p Environment -p EnvironmentFiles -p PassEnvironment -p UnsetEnvironment';
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'rarog-service', UNIT_NAME);
const WRITE = process.env.RAROG_FIXTURES_WRITE === '1';
const hostHasAnalyze = existsSync('/usr/bin/systemd-analyze') || existsSync('/bin/systemd-analyze');

let sb: LinuxSandbox;
let wrapper: string;

beforeEach(() => {
  // One-letter prefix: the admin socket in the macOS temporary directory, under the vitest run directory, fits in
  // 103 B only with it.
  sb = linuxSandbox('l', { ss: true });
  wrapper = path.join(sb.homeDir, 'wrapper', 'wrapper.sh');
  mkdirSync(path.dirname(wrapper));
  // Wrapper widzi środowisko menedżera (nie testu), więc sterują nim pliki stanu.
  fake(wrapper, [
    `printf '%s\\n' "$*" >> '${sb.logs}/wrapper'`,
    `env | sort > '${sb.logs}/wrapper-env'`,
    `if [ -f '${sb.state}/wrapper-pada' ]; then echo "wrapper: brak sekretów" >&2; exit 7; fi`,
    `if [ ! -f '${sb.state}/wrapper-bez-sekretow' ]; then export SONIOX_API_KEY='${FAKE_SECRET}'; fi`,
    `if [ -f '${sb.state}/wrapper-dane' ]; then export RAROG_DATA_DIR='/srv/inne-dane'; fi`,
    `if [ -f '${sb.state}/wrapper-iroh' ]; then export RAROG_IROH_KEY='${FAKE_IROH_KEY}'; fi`,
    'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done',
    'shift',
    'exec "$@"',
  ]);
  fake(path.join(sb.bin, 'systemd-analyze'), [
    `printf '%s\\n' "$*" >> '${sb.logs}/systemd-analyze'`,
    `if [ -f '${sb.state}/verify-pada' ]; then`,
    '  echo "$2:16: Command /x is not executable: No such file or directory" >&2; exit 1',
    'fi',
  ]);
});
afterEach(() => { sb.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const configDir = (): string => path.join(sb.homeDir, '.config', 'rarog');
const dataDir = (): string => path.join(sb.homeDir, '.local', 'share', 'rarog');
const unitFile = (): string => unitFilePath(sb.homeDir);
const wrapperArgs = (): string[] => [wrapper, 'rarog', '--only', 'SONIOX_API_KEY', '--'];
/** Wywołania `systemctl`, które coś zmieniają (wszystko poza `show`). */
const changing = (): string[] => sb.calls('systemctl').filter((call) => !call.startsWith('--user show'));

function writeConfig(value: unknown, home = sb.homeDir): void {
  const dir = path.join(home, '.config', 'rarog');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(value));
}

/** Sztuczny klucz iroh, który wrapper eksportuje przy pliku stanu `wrapper-iroh`. */
const FAKE_IROH_KEY = 'ef'.repeat(32);

/** Konfiguracja z nasłuchem iroh; klucz tylko z wrappera. */
function irohConfig(): unknown {
  return {
    version: 1,
    env: { RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: PORT, RAROG_IROH: '1', RAROG_IROH_RELAY: 'https://relay.example./' },
    service: { wrapper: wrapperArgs() },
  };
}

function ownerConfig(wrapperValue: string[] = wrapperArgs()): unknown {
  return {
    version: 1, env: { RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: PORT }, service: { wrapper: wrapperValue },
  };
}

/** Jednostka, jaką zapisze install dla `ownerConfig()`. */
function expectedUnit(): string {
  return renderServiceUnit({
    execStart: [...wrapperArgs(), SERVICE_NODE, RAROG_BIN, 'serve'], workingDirectory: REPO,
    log: path.join(dataDir(), 'server.log'),
  });
}

/** `serviceCommand` w procesie testu z platformą `linux` (atrapy z `PATH` środowiska `io`); `deps` = tryb paczki. */
async function inProcess(
  argv: string[], extra: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'linux', deps: ServiceDeps = {},
  ask?: CliIo['ask'],
): Promise<Run> {
  const env = sb.env(extra);
  assertFakeSystemctl(sb, env);
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env, cwd: sb.homeDir, platform,
    ...(ask === undefined ? {} : { ask }),
  };
  const status = await serviceCommand(argv, io, undefined, deps);
  return { status, stdout, stderr };
}

/** Paczka npm położona przez npm i przez pnpm 11 (układy z `install/evidence.ts`). */
const NPM_ROOT = '/usr/local/lib/node_modules/@rarog/server';
const PNPM_ROOT = '/home/u/.local/share/pnpm/store/v11/links/@rarog/server/1.0.0/abc123/node_modules/@rarog/server';

/** Odmowa fazy 0: kod 1, „Nothing was stopped”, bez zapisu jednostki i bez zmian w menedżerze. */
function expectRefused(run: Run, needle: string): void {
  expect(run.status, run.stderr).toBe(1);
  expect(run.stderr).toContain(needle);
  expect(run.stderr).toContain('Nothing was stopped');
  expect(existsSync(unitFile())).toBe(false);
  expect(changing()).toEqual([]);
  expect(sb.calls('uname')).toEqual([]);
  expect(sb.calls('curl')).toEqual([]);
  expect(existsSync(path.join(configDir(), 'rarog-sprawdzany.service'))).toBe(false);
}

describe('rarog service install na Linuksie: faza 0 — odmowa niczego nie zapisuje ani nie zatrzymuje',
  { timeout: 60_000 }, () => {
    it('RAROG_DATA_DIR albo XDG_DATA_HOME w powłoce → odmowa przed busctl', async () => {
      writeConfig(ownerConfig());
      for (const name of ['RAROG_DATA_DIR', 'XDG_DATA_HOME']) {
        expectRefused(await inProcess(['service', 'install'], { [name]: '/x' }), `${name} is set in this shell`);
      }
      expect(sb.calls('busctl')).toEqual([]);
    });

    it('zmienna katalogu danych w menedżerze → odmowa z unset-environment, wartość nie na ekranie', async () => {
      writeConfig(ownerConfig());
      for (const name of ['RAROG_DATA_DIR', 'XDG_DATA_HOME']) {
        sb.managerEnv({ [name]: '/srv/inne-dane' });
        const run = await inProcess(['service', 'install']);
        expectRefused(run, `systemctl --user unset-environment ${name}`);
        expect(run.stderr).not.toContain('/srv/inne-dane');
      }
    });

    it('busctl nie odpowiada → odmowa', async () => {
      writeConfig(ownerConfig());
      sb.set('busctl-down', '');
      expectRefused(await inProcess(['service', 'install']), 'busctl … Manager Environment');
    });

    it('UnitPath menedżera bez ~/.config/systemd/user (inny XDG_CONFIG_HOME) → odmowa', async () => {
      writeConfig(ownerConfig());
      sb.set('manager-UnitPath.json', JSON.stringify({ type: 'as', data: ['/home/rarog/cfg/systemd/user'] }));
      expectRefused(await inProcess(['service', 'install']), 'manager does not look for units in');
    });

    it('jednostka z drop-inem → odmowa (drop-in przeżyłby ponowną instalację)', async () => {
      writeConfig(ownerConfig());
      sb.set('DropInPaths', `${unitFile()}.d/env.conf`);
      expectRefused(await inProcess(['service', 'install']), 'has drop-ins');
    });

    it('brak curl, ps albo pgrep w PATH → odmowa z listą', async () => {
      writeConfig(ownerConfig());
      rmSync(path.join(sb.bin, 'pgrep'));
      const run = await inProcess(['service', 'install'], { PATH: `${sb.bin}:${sb.sys}` });
      expectRefused(run, 'missing in PATH: pgrep');
    });

    it('brak config.json albo zła konfiguracja → odmowa', async () => {
      expectRefused(await inProcess(['service', 'install']), 'config.json; the service starts');
      writeConfig({ ...(ownerConfig() as object), env: { RAROG_PORT: PORT, RAROG_MAX_PANES: '0' } });
      expectRefused(await inProcess(['service', 'install']), 'the config fails the check');
    });

    it('ścieżka gniazda administracyjnego > 103 B → odmowa', async () => {
      const deep = path.join(sb.homeDir, 'd'.repeat(60), 'e'.repeat(40));
      mkdirSync(deep, { recursive: true });
      writeConfig(ownerConfig(), deep);
      sb.managerEnv({ HOME: deep });
      sb.set('manager-UnitPath.json', JSON.stringify({ type: 'as', data: [path.join(deep, '.config', 'systemd', 'user')] }));
      const run = await inProcess(['service', 'install'], { HOME: deep });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('server creates a socket of at most 103 B');
      expect(changing()).toEqual([]);
      expect(existsSync(unitFilePath(deep))).toBe(false);
    });

    it('service.wrapper: ścieżka względna, plik niewykonywalny, " albo \\ w ścieżce programu → odmowa', async () => {
      writeConfig(ownerConfig(['wrapper.sh', '--']));
      expectRefused(await inProcess(['service', 'install']), 'needs an absolute path');
      writeConfig(ownerConfig(['/nieistniejacy/wrapper.sh', '--']));
      expectRefused(await inProcess(['service', 'install']), 'does not exist or is not executable');
      for (const name of ['wr"ap.sh', 'wr\\ap.sh']) {
        const odd = path.join(sb.homeDir, 'wrapper', name);
        fake(odd, ['exec "$@"']);
        writeConfig(ownerConfig([odd, '--']));
        expectRefused(await inProcess(['service', 'install']), 'ExecStart program');
      }
      expect(sb.calls('systemd-analyze')).toEqual([]);
    });

    it('systemd-analyze verify odrzuca jednostkę → odmowa, plik sprawdzany usunięty', async () => {
      writeConfig(ownerConfig());
      sb.set('verify-pada', '');
      const run = await inProcess(['service', 'install']);
      expectRefused(run, 'fails systemd-analyze verify');
      expect(run.stderr).toContain('is not executable');
      expect(sb.calls('systemd-analyze')).toEqual([`verify ${path.join(configDir(), 'rarog-sprawdzany.service')}`]);
      expect(sb.calls('wrapper')).toEqual([]);
    });

    it('pełne --check przez wrapper pada albo wrapper nie daje sekretu → odmowa', async () => {
      writeConfig(ownerConfig());
      sb.set('wrapper-pada', '');
      expectRefused(await inProcess(['service', 'install']), 'rarog serve --check through service.wrapper failed');
      sb.set('wrapper-pada', null);
      sb.set('wrapper-bez-sekretow', '');
      expectRefused(await inProcess(['service', 'install']), 'supplied no secret at all');
    });

    it('RAROG_IROH=1, wrapper bez klucza iroh → wstępne --check przechodzi, pełne odmawia', async () => {
      writeConfig(irohConfig());
      const run = await inProcess(['service', 'install']);
      expectRefused(run, 'rarog serve --check through service.wrapper failed');
      expect(run.stderr).toContain('RAROG_IROH=1 without RAROG_IROH_KEY');
    });

    it('RAROG_IROH=1 bez wrappera i bez klucza → odmowa wstępnego --check', async () => {
      writeConfig({ ...(irohConfig() as Record<string, unknown>), service: undefined });
      const run = await inProcess(['service', 'install']);
      expectRefused(run, 'the config fails the check');
      expect(run.stderr).toContain('RAROG_IROH=1 without RAROG_IROH_KEY');
      expect(sb.calls('wrapper')).toEqual([]);
    });

    it('wrapper zmienia katalog danych (RAROG_DATA_DIR) → odmowa przed zapisem', async () => {
      writeConfig(ownerConfig());
      sb.set('wrapper-dane', '');
      const run = await inProcess(['service', 'install']);
      expectRefused(run, 'sees data directory /srv/inne-dane');
      expect(run.stderr).toContain(`but the check without the wrapper ${dataDir()}`);
    });

    it('gniazdo administracyjne danych żyje, a port z konfiguracji milczy → odmowa', async () => {
      writeConfig(ownerConfig());
      const socket = path.join(dataDir(), 'run', 'admin.sock');
      mkdirSync(path.dirname(socket), { recursive: true });
      const old = createServer();
      await new Promise<void>((resolve, reject) => { old.once('error', reject); old.listen(socket, resolve); });
      try {
        expectRefused(await inProcess(['service', 'install']), 'but not on port 18997 from the config');
        expect(sb.calls('wrapper')).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => { old.close(() => { resolve(); }); });
      }
    });

    it.each([
      ['zamaskowana', { LoadState: 'masked' }, `systemctl --user unmask ${UNIT_NAME}`],
      ['cudza o tej nazwie', { LoadState: 'loaded', FragmentPath: '/etc/systemd/user/rarog.service' },
        'this is a foreign unit'],
      ['z błędem w pliku', { LoadState: 'bad-setting' }, 'install handles only loaded or not-found'],
    ])('stan jednostki na końcu fazy 0: %s → odmowa', async (_name, state, needle) => {
      writeConfig(ownerConfig());
      for (const [name, value] of Object.entries(state)) sb.set(name, value);
      expectRefused(await inProcess(['service', 'install']), needle);
      // Stan pytany na początku (drop-iny) i na końcu, tuż przed zapisem.
      expect(sb.calls('systemctl')).toEqual([SHOW, SHOW]);
    });

    it('paczka z cache npx albo przez pnpm dlx → odmowa przed blokadą, systemctl i launchctl (macOS i Linux)', async () => {
      writeConfig(ownerConfig());
      const npx = { mode: 'package', installRoot: '/home/u/.npm/_npx/0a1b2c/node_modules/@rarog/server' } as const;
      const dlx = { mode: 'package', installRoot: PNPM_ROOT } as const;
      const agent = { npm_config_user_agent: 'pnpm/11.4.0 npm/? node/v22.22.3 linux x64' };
      for (const platform of ['linux', 'darwin'] as const) {
        const fromNpx = await inProcess(['service', 'install'], {}, platform, npx);
        expectRefused(fromNpx, `started from npx cache (${npx.installRoot})`);
        expect(fromNpx.stderr).toContain('Install permanently: npm i -g @rarog/server (or pnpm add -g @rarog/server)');
        expectRefused(await inProcess(['service', 'install'], agent, platform, dlx), 'pnpm dlx or pnpm exec');
        expect(sb.calls('systemctl')).toEqual([]);
        expect(sb.calls('busctl')).toEqual([]);
        expect(sb.calls('launchctl')).toEqual([]);
        expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
      }
    });

    it('inna platforma niż darwin i linux → odmowa bez systemctl i launchctl', async () => {
      const run = await inProcess(['service', 'install'], {}, 'win32');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('this platform is win32');
      expect(sb.calls('systemctl')).toEqual([]);
      expect(sb.calls('launchctl')).toEqual([]);
    });
  });

describe('rarog service install na Linuksie: faza 1', { timeout: 60_000 }, () => {
  it('pusty dom: jednostka z szablonu, daemon-reload, enable, katalog danych 0700, restart.sh, dowiązanie', () => {
    writeConfig(ownerConfig());
    const run = rarogLinux(sb, ['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(unitFile(), 'utf8')).toBe(expectedUnit());
    expect(sb.calls('systemctl')).toEqual([
      SHOW, SHOW, '--user daemon-reload', `--user enable ${UNIT_NAME}`, `--user restart ${UNIT_NAME}`,
    ]);
    expect(sb.calls('busctl').map((call) => call.split(' ').at(-1))).toEqual(['Environment', 'UnitPath']);
    expect(sb.calls('systemd-analyze')).toEqual([`verify ${path.join(configDir(), 'rarog-sprawdzany.service')}`]);
    expect(existsSync(path.join(configDir(), 'rarog-sprawdzany.service'))).toBe(false);
    expect(run.stdout).toContain('systemd-analyze verify OK');
    // Pełne `--check` przez wrapper, na środowisku menedżera (PATH menedżera, nie atrap testu).
    expect(sb.calls('wrapper')).toEqual([`rarog --only SONIOX_API_KEY -- ${SERVICE_NODE} ${RAROG_BIN} serve --check`]);
    const wrapperEnv = readFileSync(path.join(sb.logs, 'wrapper-env'), 'utf8');
    expect(wrapperEnv).toContain('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    expect(wrapperEnv).not.toContain(sb.bin);
    expect(statSync(dataDir()).mode & 0o777).toBe(0o700);
    expect(readlinkSync(path.join(sb.homeDir, '.local', 'bin', 'rarog'))).toBe(RAROG_BIN);
    expect(run.stdout).toContain(`restart.sh with unit ${UNIT_NAME}, port ${PORT}`);
    expect(run.stdout).toContain('linger: yes');
    expect(run.stdout).toContain(`rarog service install: done — ${UNIT_NAME} is running`);
    expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
    expect(sb.calls('launchctl')).toEqual([]);
    expect(sb.calls('nohup')).toEqual([]);
    for (const text of [run.stdout, run.stderr, readFileSync(unitFile(), 'utf8')]) expect(text).not.toContain(FAKE_SECRET);
  });

  it('RAROG_IROH=1 z kluczem z wrappera: instalacja przechodzi, wartość klucza nigdzie w wyjściu ani w jednostce', () => {
    writeConfig(irohConfig());
    sb.set('wrapper-iroh', '');
    const run = rarogLinux(sb, ['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/secrets: set SONIOX_API_KEY, RAROG_IROH_KEY/);
    for (const text of [run.stdout, run.stderr, readFileSync(unitFile(), 'utf8')]) expect(text).not.toContain(FAKE_IROH_KEY);
  });

  it('ponowna instalacja nad naszą jednostką zmienioną ręcznie (Environment=) → nadpisana szablonem', async () => {
    writeConfig(ownerConfig());
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), '[Service]\nEnvironment=XDG_DATA_HOME=/srv/inne-dane\nExecStart="/x"\n');
    sb.set('Environment', 'XDG_DATA_HOME=/srv/inne-dane');
    sb.set('active', '');
    // `ExecStart="/x"` nie ma celu, który klon odczyta: zapis tylko po „t” w terminalu.
    const run = await inProcess(['service', 'install'], {}, 'linux', {}, () => Promise.resolve('t'));
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(unitFile(), 'utf8')).toBe(expectedUnit());
  });

  // Węzeł bez cudzysłowu, ścieżka paczki ze spacją: `unitArgv` celu nie odczyta, a to może być paczka.
  it('klon, jednostka z nieczytelnym celem → bez terminala odmowa przed fazą 0; w terminalu pytanie, „nie” = bez zmian', async () => {
    writeConfig(ownerConfig());
    const pkg = fakePackage(path.join(sb.homeDir, 'Rarog Server'), '0.9.0');
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    const unit = `[Service]\nExecStart=/usr/bin/node "${pkg.bin}" "serve"\n`;
    writeFileSync(unitFile(), unit);
    const refused = await inProcess(['service', 'install']);
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain(`rarog service install: service ${UNIT_NAME}: target of the current service unreadable:`
      + ` ${unitFile()}: ExecStart does not have the shape rarog service install writes`);
    expect(refused.stderr).toContain(`This is the repo clone ${REPO}, so install would replace the service without knowing what it`
      + ' starts (maybe the npm package).');
    expect(sb.calls('wrapper')).toEqual([]);
    expect(sb.calls('busctl')).toEqual([]);
    const prompts: string[] = [];
    const declined = await inProcess(['service', 'install'], {}, 'linux', {}, (prompt) => {
      prompts.push(prompt);
      return Promise.resolve('nie');
    });
    expect(declined.status, declined.stderr).toBe(1);
    expect(prompts).toEqual([`Replace service ${UNIT_NAME} with a service of this clone? [y/N] `]);
    expect(declined.stdout).toContain(`    target of the current service unreadable: ${unitFile()}: ExecStart does not have the shape`);
    expect(declined.stdout).toContain('  No command to go back to the previous installation');
    expect(declined.stderr).toContain('replacement declined; the service file is unchanged.');
    expect(sb.calls('wrapper')).toHaveLength(1);
    expect(readFileSync(unitFile(), 'utf8')).toBe(unit);
    expect(changing()).toEqual([]);
    expect(existsSync(path.join(sb.homeDir, '.local', 'bin', 'rarog'))).toBe(false);
    expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
  });

  it('linger wyłączony → ostrzeżenie z komendą enable-linger, instalacja zielona', () => {
    writeConfig(ownerConfig());
    sb.set('linger', 'no');
    const run = rarogLinux(sb, ['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('WARNING: linger disabled (Linger=no)');
    expect(run.stdout).toContain('sudo loginctl enable-linger ');
  });

  it.skipIf(hostHasAnalyze)('bez systemd-analyze → linia „nie sprawdzone”, instalacja idzie dalej (skipped on a host with systemd-analyze)', () => {
    writeConfig(ownerConfig());
    rmSync(path.join(sb.bin, 'systemd-analyze'));
    const run = rarogLinux(sb, ['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('systemd-analyze verify not checked');
  });

  it.each([
    ['daemon-reload', 'daemon-reload-rc', []],
    ['enable', 'enable-rc', ['--user daemon-reload']],
  ])('porażka %s → komendy powrotu, bez restartu', (step, rcFile, before) => {
    writeConfig(ownerConfig());
    sb.set(rcFile, '1');
    const run = rarogLinux(sb, ['service', 'install']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`systemctl --user ${step}`);
    for (const line of unitRollbackLines(sb.homeDir)) expect(run.stderr).toContain(line);
    expect(changing().slice(0, before.length)).toEqual(before);
    expect(changing().filter((call) => call.startsWith('--user restart'))).toEqual([]);
    expect(sb.calls('curl')).toEqual([]);
  });

  it('stara jednostka wskazuje usuniętą instalację (węzeł i wejście nie istnieją) → install przechodzi', () => {
    writeConfig(ownerConfig());
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), renderServiceUnit({
      execStart: [...wrapperArgs(), '/nie/ma/node/bin/node', '/nie/ma/rarog/bin/rarog.mjs', 'serve'],
      workingDirectory: '/nie/ma/rarog', log: path.join(dataDir(), 'server.log'),
    }));
    sb.set('active', '');
    const run = rarogLinux(sb, ['service', 'install']);
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(unitFile(), 'utf8')).toBe(expectedUnit());
  });

  // Z klonu przy jednostce na paczce npm install przełączyłby produkcję na klon: tylko po pytaniu w terminalu.
  it('klon, jednostka startuje paczkę npm: bez terminala odmowa przed fazą 0, „nie” po liście zmian; jednostka bez zmian', async () => {
    writeConfig(ownerConfig());
    const oldNode = '/opt/stary-node/bin/node';
    const pkg = fakePackage(path.join(sb.homeDir, 'prefiks'), '0.9.0');
    const link = path.join(sb.homeDir, '.local', 'bin', 'rarog');
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    const unit = renderServiceUnit({
      execStart: [...wrapperArgs(), oldNode, pkg.bin, 'serve'], workingDirectory: pkg.root,
      log: path.join(dataDir(), 'server.log'),
    });
    writeFileSync(unitFile(), unit);
    const refused = await inProcess(['service', 'install']);
    expect(refused.status, refused.stderr).toBe(1);
    expect(refused.stderr).toContain(`rarog service install: service ${UNIT_NAME} starts the rarog package 0.9.0`
      + ` (${pkg.root}), and this is the repo clone ${REPO}, so install would switch the service from the package to`
      + ' this clone.');
    expect(refused.stderr).toContain(`Restart the service without switching: '${oldNode}' '${pkg.bin}' restart.`);
    expect(sb.calls('wrapper')).toEqual([]);
    expect(sb.calls('busctl')).toEqual([]);
    const declined = await inProcess(['service', 'install'], {}, 'linux', {}, () => Promise.resolve('nie'));
    expect(declined.status, declined.stderr).toBe(1);
    expect(declined.stdout).toContain(`Service ${UNIT_NAME} starts the rarog package 0.9.0 (${pkg.root}); install`
      + ' switches it to this clone.');
    expect(declined.stdout).toContain(`    node: ${oldNode} → ${SERVICE_NODE}\n`);
    expect(declined.stdout).toContain(`  Back to the package: '${oldNode}' '${pkg.bin}' service install, then rm`
      + ` '${link}'.\n`);
    expect(declined.stderr).toContain('switch declined');
    expect(sb.calls('wrapper')).toHaveLength(1);
    expect(readFileSync(unitFile(), 'utf8')).toBe(unit);
    expect(changing()).toEqual([]);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
  });

  it('paczka npm: bez dowiązania ~/.local/bin/rarog; porażka → komendy powrotu bez cd do repo', async () => {
    writeConfig(ownerConfig());
    const run = await inProcess(['service', 'install'], {}, 'linux', { mode: 'package', installRoot: NPM_ROOT });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(path.join(sb.homeDir, '.local', 'bin', 'rarog'))).toBe(false);
    expect(run.stdout).not.toContain('symlink');
    expect(run.stdout).toContain('Check: rarog doctor.');
    sb.set('restart-rc', '1');
    const failed = await inProcess(['service', 'install'], {}, 'linux', { mode: 'package', installRoot: NPM_ROOT });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(unitRollbackLines(sb.homeDir, 'package').join('\n'));
    expect(failed.stderr).toContain('  rarog service uninstall\n');
    expect(failed.stderr).not.toContain('  cd ');
    expect(unitRollbackLines(sb.homeDir, 'clone')).toContain(`  cd '${REPO}'`);
  });

  it('restart.sh czerwony (systemctl restart z kodem ≠ 0) → jego kod i komendy powrotu', () => {
    writeConfig(ownerConfig());
    sb.set('restart-rc', '1');
    const run = rarogLinux(sb, ['service', 'install']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('restart.sh exited with code 1');
    expect(run.stderr).toContain(`systemctl --user disable --now ${UNIT_NAME}`);
    expect(existsSync(unitFile())).toBe(true);
  });
});

describe('rarog service uninstall na Linuksie', { timeout: 60_000 }, () => {
  /** Zainstalowana jednostka: plik, włączona i działająca. */
  function installed(): void {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), expectedUnit());
    sb.set('enabled', '');
    sb.set('active', '');
    mkdirSync(dataDir(), { recursive: true });
  }

  it('nasza jednostka → disable --now, usunięcie pliku, daemon-reload; dane zostają', async () => {
    installed();
    const run = await inProcess(['service', 'uninstall']);
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('systemctl')).toEqual([SHOW, `--user disable --now ${UNIT_NAME}`, '--user daemon-reload']);
    expect(existsSync(unitFile())).toBe(false);
    expect(existsSync(dataDir())).toBe(true);
    expect(run.stdout).toContain('the service server is STOPPED');
  });

  it('herdr.service written by rarog setup stays byte for byte; uninstall touches only rarog.service', async () => {
    installed();
    const herdrUnit = path.join(path.dirname(unitFile()), 'herdr.service');
    const text = '[Service]\nExecStart="/h/herdr" server\n';
    writeFileSync(herdrUnit, text);
    const run = await inProcess(['service', 'uninstall']);
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(herdrUnit, 'utf8')).toBe(text);
    expect(sb.calls('systemctl').filter((one) => one.includes('herdr'))).toEqual([]);
  });

  it('paczka npm albo pnpm: reszta odinstalowania po kolei, z komendą menedżera i katalogiem danych usługi', async () => {
    for (const [root, command] of [
      [NPM_ROOT, "npm uninstall -g --prefix '/usr/local' @rarog/server"], [PNPM_ROOT, 'pnpm remove -g @rarog/server'],
    ]) {
      installed();
      mkdirSync(path.join(dataDir(), 'sdk'), { recursive: true });
      const run = await inProcess(['service', 'uninstall'], {}, 'linux', { mode: 'package', installRoot: root });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('The data directory, ~/.config/rarog stay.');
      expect(run.stdout).toContain('Reinstall: rarog service install.');
      // Bez ustawień i bez kopii nie ma czego zdejmować: zostają komenda menedżera i katalogi.
      const steps = ['Rarog entries in ~/.claude/settings.json', '  none left, nothing to remove',
        'Copy of the hook code', '  not there, nothing to remove', 'Uninstalling Rarog, the remaining steps:',
        `1. Package: ${command}`,
        `2. When you are done with Rarog (data, devices, SDK and config): rm -r '${dataDir()}' '${configDir()}'`];
      const at = steps.map((step) => run.stdout.indexOf(step));
      expect(at.every((index) => index >= 0), run.stdout).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  it('z drop-inem → zdjęta, drop-iny wymienione jako zostające', async () => {
    installed();
    sb.set('DropInPaths', `${unitFile()}.d/env.conf`);
    const run = await inProcess(['service', 'uninstall']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('The drop-ins');
  });

  it('brak jednostki i pliku → zielono, nic nie zmienione', async () => {
    const run = await inProcess(['service', 'uninstall']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`${UNIT_NAME} was not loaded`);
    expect(changing()).toEqual([]);
  });

  it.each([
    ['brak magistrali', { 'bus-down': '' }, 'does not decide the unit state'],
    ['cudza o tej nazwie', { FragmentPath: '/etc/systemd/user/rarog.service' }, 'this is not a unit from rarog service'],
    ['zamaskowana', { LoadState: 'masked' }, 'unmask it'],
  ])('%s → odmowa, plik zostaje', async (_name, state, needle) => {
    installed();
    for (const [name, value] of Object.entries(state)) sb.set(name, value);
    const run = await inProcess(['service', 'uninstall']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(needle);
    expect(run.stderr).toContain('Nothing was changed');
    expect(existsSync(unitFile())).toBe(true);
    expect(changing()).toEqual([]);
  });

  it('disable --now pada → odmowa, plik zostaje', async () => {
    installed();
    sb.set('disable-rc', '1');
    const run = await inProcess(['service', 'uninstall']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('The unit file stays');
    expect(existsSync(unitFile())).toBe(true);
  });

  // Uninstall in a clone removes only its own ~/.local/bin/rarog symlink (the one service install made).
  describe('the rarog symlink', () => {
    const link = (): string => path.join(sb.homeDir, '.local', 'bin', 'rarog');
    const otherClone = '/elsewhere/rarog-clone/bin/rarog.mjs';

    function placeLink(kind: 'this-clone' | 'other-clone' | 'file' | 'none'): void {
      installed();
      if (kind === 'none') return;
      mkdirSync(path.dirname(link()), { recursive: true });
      if (kind === 'file') writeFileSync(link(), '#!/bin/sh\n');
      else symlinkSync(kind === 'this-clone' ? RAROG_BIN : otherClone, link());
    }

    it('symlink to this clone → removed, with a report line', async () => {
      placeLink('this-clone');
      const run = await inProcess(['service', 'uninstall']);
      expect(run.status, run.stderr).toBe(0);
      expect(lstatSync(link(), { throwIfNoEntry: false })).toBeUndefined();
      expect(run.stdout).toContain(`Symlink ${link()} removed (it pointed to this clone).\n`);
      expect(run.stdout).toContain('The data directory, ~/.config/rarog stay.');
    });

    it('symlink to another clone → stays, with a report line', async () => {
      placeLink('other-clone');
      const run = await inProcess(['service', 'uninstall']);
      expect(run.status, run.stderr).toBe(0);
      expect(readlinkSync(link())).toBe(otherClone);
      expect(run.stdout).toContain(`Symlink ${link()} stays: it points to ${otherClone}, not to this clone.\n`);
    });

    it('a regular file → stays, with a report line', async () => {
      placeLink('file');
      const run = await inProcess(['service', 'uninstall']);
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(link(), 'utf8')).toBe('#!/bin/sh\n');
      expect(run.stdout).toContain(`${link()} stays: it is not a symlink.\n`);
    });

    it('no symlink → no line about it', async () => {
      placeLink('none');
      const run = await inProcess(['service', 'uninstall']);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).not.toContain(link());
      expect(run.stdout).not.toContain('symlink');
    });

    it('npm package → the symlink is not touched and not mentioned', async () => {
      placeLink('this-clone');
      const run = await inProcess(['service', 'uninstall'], {}, 'linux', { mode: 'package', installRoot: NPM_ROOT });
      expect(run.status, run.stderr).toBe(0);
      expect(readlinkSync(link())).toBe(RAROG_BIN);
      expect(run.stdout).not.toContain(link());
    });
  });
});

describe('rarog service uninstall w paczce: wpisy w ustawieniach i kopia hooka po pytaniach', {
  timeout: 60_000,
}, () => {
  /** Regular files under `root` whose bytes contain `needle`, relative to `root`, sorted (symlinks not followed). */
  function filesContaining(root: string, needle: string): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && readFileSync(file).includes(needle)) found.push(path.relative(root, file));
      }
    };
    walk(root);
    return found.sort();
  }

  /** Hook herdr `SessionStart` (kształt z `herdr integration install claude`): uninstall go nie dotyka. */
  const HERDR = { type: 'command', command: "'/h/.claude/hooks/herdr-agent-state.sh' session-start" };
  /** Cudza komenda paska statusu, którą setup owinął łańcuchem. */
  const FOREIGN = "bash -c 'echo pasek'";
  /** The `[y/N/d]` question about the Rarog entries, as the form wraps it without a terminal width. */
  const REMOVE_PROMPT = questionPrompt('Remove Rarog entries from ~/.claude/settings.json?',
    'y/N/d', LAYOUT_DEFAULT);
  /** A value in a foreign field of the settings file that must never reach a log; not token-shaped on purpose. */
  const MARKER = 'settings-file-content-never-in-a-log';
  const settings = (): string => userSettingsPath(sb.homeDir);
  const copyDir = (): string => hookInstallDir(sb.homeDir);
  const backupDir = (): string => path.join(dataDir(), SETTINGS_BACKUP_DIRNAME);
  const canonical = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

  /** Plik kanoniczny sprzed setup: cudze wpisy w kluczach, których setup dotyka. */
  const before = (): Record<string, unknown> => ({
    model: 'opus',
    hooks: { SessionStart: [{ hooks: [HERDR] }] },
    statusLine: { type: 'command', command: FOREIGN, padding: 2 },
    sandbox: { enabled: true },
  });

  /** Ten sam plik po krokach 5–8 setup (kolejność kluczy jak u pisarza: nowe na końcu). */
  function afterSetup(): Record<string, unknown> {
    const home = sb.homeDir;
    const groups = (hookBlock(hookCommand(home)) as { hooks: Record<string, unknown[]> }).hooks;
    return {
      model: 'opus',
      hooks: {
        SessionStart: [{ hooks: [HERDR] }, { hooks: [{ type: 'command', command: contextHookCommand(home), timeout: 5 }] }],
        ...groups,
      },
      statusLine: { type: 'command', command: statuslineCommand(home, FOREIGN), padding: 2 },
      sandbox: { enabled: true, filesystem: { denyRead: [...denyReadPaths(dataDir())] } },
    };
  }

  /** Pliki kopii hooka w {@link packageInstalled} (obok nich manifest, który je wymienia). */
  const COPY_FILES = ['rarog-pending.mjs', 'rarog-statusline.mjs'];

  /** Usługa paczki zainstalowana, katalog danych z `sdk/`, ustawienia po setup i kopia hooka z manifestem. */
  function packageInstalled(value: unknown = afterSetup()): string {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), expectedUnit());
    sb.set('enabled', '');
    sb.set('active', '');
    mkdirSync(path.join(dataDir(), 'sdk'), { recursive: true });
    mkdirSync(path.dirname(settings()), { recursive: true });
    const body = canonical(value);
    writeFileSync(settings(), body);
    mkdirSync(copyDir(), { recursive: true });
    for (const name of COPY_FILES) writeFileSync(path.join(copyDir(), name), `// ${name}\n`);
    // Skróty treści jak z instalacji: bez zgodnego skrótu katalog nie jest kopią Raroga i zostaje.
    const files = Object.fromEntries(COPY_FILES.map((name) => [
      name, createHash('sha256').update(`// ${name}\n`).digest('hex'),
    ]));
    writeFileSync(path.join(copyDir(), 'manifest.json'), canonical({ version: '1.0.0', at: 1, files }));
    return body;
  }

  /** Terminal, który przy pytaniu o kopię najpierw robi `meanwhile` (zapis z zewnątrz w czasie pytania), potem „y”. */
  function meanwhileAtCopy(meanwhile: () => void): { readonly ask: CliIo['ask']; readonly prompts: string[] } {
    const prompts: string[] = [];
    return {
      prompts,
      ask: (prompt) => {
        prompts.push(prompt);
        if (prompt !== REMOVE_PROMPT) meanwhile();
        return Promise.resolve('y');
      },
    };
  }

  /** Terminal z kolejnymi odpowiedziami; pytania trafiają do `prompts`, odpowiedź poza listą to EOF. */
  function terminal(...answers: string[]): { readonly ask: CliIo['ask']; readonly prompts: string[] } {
    const prompts: string[] = [];
    return {
      prompts,
      ask: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(answers.shift() ?? null);
      },
    };
  }

  const uninstall = (ask?: CliIo['ask'], mode: 'package' | 'clone' = 'package'): Promise<Run> =>
    inProcess(['service', 'uninstall'], {}, 'linux', { mode, installRoot: NPM_ROOT }, ask);

  /** Napisy `needles` stoją w `text` w tej kolejności. */
  function inOrder(text: string, needles: readonly string[]): void {
    let at = 0;
    for (const needle of needles) {
      const found = text.indexOf(needle, at);
      expect(found, `${needle}\n--- w wydruku ---\n${text}`).toBeGreaterThanOrEqual(0);
      at = found + needle.length;
    }
  }

  it('„y”, „y” → ustawienia bajt w bajt sprzed setup, kopia usunięta, kopia zapasowa w ostatnim kroku', async () => {
    const original = canonical(before());
    packageInstalled();
    const t = terminal('y', 'y');
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(settings(), 'utf8')).toBe(original);
    expect(existsSync(copyDir())).toBe(false);
    expect(t.prompts).toEqual([
      REMOVE_PROMPT, '  Remove these files and the directory? [y/N] ',
    ]);
    const [backup] = readdirSync(backupDir());
    const backupFile = path.join(backupDir(), backup ?? '');
    expect(readFileSync(backupFile, 'utf8')).toBe(canonical(afterSetup()));
    inOrder(run.stdout, [
      'The data directory, ~/.config/rarog stay.', 'Reinstall: rarog service install.',
      'Rarog entries in ~/.claude/settings.json (hook entries, statusLine, denyRead paths, write block rules):',
      `  written: ${settings()}; backup: ${backupFile} (to undo: cp '${backupFile}' '${settings()}')`,
      `Copy of the hook code and of the statusLine script: ${copyDir()}\n`,
      '  to remove: manifest.json, rarog-pending.mjs, rarog-statusline.mjs\n',
      `  removed: ${copyDir()}\n`,
      'Uninstalling Rarog, the remaining steps:',
      "1. Package: npm uninstall -g --prefix '/usr/local' @rarog/server",
      `2. When you are done with Rarog (data, devices, SDK and config): rm -r '${dataDir()}' '${configDir()}'\n`
        + `   The data directory also holds the backups of ~/.claude/settings.json ('${backupDir()}', the one from this`
        + ` run: '${backupFile}'); rm -r removes them too.\n`,
    ]);
    expect(run.stdout).not.toContain('remove by hand');
    // The diff is not printed up front: only the answer `d` shows it.
    expect(run.stdout).not.toContain(`--- ${settings()}`);
  });

  it('„d” → różnica na ekranie i to samo pytanie; „n” → ustawienia bajt w bajt, kroki ręczne', async () => {
    const body = packageInstalled();
    const t = terminal('d', 'n');
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(t.prompts).toEqual([REMOVE_PROMPT, REMOVE_PROMPT]);
    expect(readFileSync(settings(), 'utf8')).toBe(body);
    expect(existsSync(backupDir())).toBe(false);
    inOrder(run.stdout, [
      `  --- ${settings()}`, `  target: ${settings()}`,
      '  answer no: nothing removed; remove them by hand (step 1 below)',
      '1. In ~/.claude/settings.json remove by hand',
    ]);
  });

  for (const reply of ['y', 'n', 'd'] as const) {
    it(`a foreign settings value never reaches a log or the output after "${reply}"`, async () => {
      packageInstalled();
      // One line, so the whole file is one changed line of the diff.
      writeFileSync(settings(), JSON.stringify({ ...afterSetup(), env: { SOME_TOKEN: MARKER } }));
      const t = reply === 'd' ? terminal('d', 'n') : terminal(reply, 'n');
      const run = await uninstall(t.ask);
      expect(run.status, run.stderr).toBe(0);
      // Only the answer `d` puts the file on the screen; the command writes no log of its own.
      expect(run.stdout.includes(MARKER)).toBe(reply === 'd');
      expect(run.stderr).not.toContain(MARKER);
      const backups = path.relative(sb.homeDir, backupDir());
      expect(filesContaining(sb.homeDir, MARKER).filter((one) => !one.startsWith(backups)))
        .toEqual([path.relative(sb.homeDir, settings())]);
    });
  }

  for (const [name, answers] of [['„n”', ['n']], ['EOF', []]] as const) {
    it(`${name} → dzisiejsze kroki „remove by hand”, ustawienia i kopia bez zmian, kod 0`, async () => {
      const body = packageInstalled();
      const t = terminal(...answers);
      const run = await uninstall(t.ask);
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(settings(), 'utf8')).toBe(body);
      expect(existsSync(path.join(copyDir(), 'rarog-pending.mjs'))).toBe(true);
      expect(existsSync(backupDir())).toBe(false);
      expect(t.prompts).toEqual([REMOVE_PROMPT]);
      expect(run.stdout).not.toContain(`--- ${settings()}`);
      inOrder(run.stdout, [
        '  answer no: nothing removed; remove them by hand (step 1 below)',
        'Uninstalling Rarog, step by step (the service is already removed):',
        '1. In ~/.claude/settings.json remove by hand the hook entries of this block (keep the rest of `hooks`):',
        hookCommand(sb.homeDir), contextHookCommand(sb.homeDir),
        '   and the statusLine key, when it points to the copy of the Rarog script:',
        `   and the paths "~/.config/rarog/secret" and "${path.join(dataDir(), 'run')}" from sandbox.filesystem.denyRead,`,
        `   and the rules "Edit(/${dataDir()}/**)" and "Edit(/${configDir()}/**)" from permissions.deny.`,
        `2. Copy of the hook code and of the statusLine script: ${copyDir()} (remove after the entries).`,
        "3. Package: npm uninstall -g --prefix '/usr/local' @rarog/server",
        `4. When you are done with Rarog (data, devices, SDK and config): rm -r '${dataDir()}' '${configDir()}'`,
      ]);
    });
  }

  it('brak terminala → bez różnicy, kroki ręczne, nic nie zapisane, kod 0', async () => {
    const body = packageInstalled();
    const run = await uninstall();
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(settings(), 'utf8')).toBe(body);
    expect(existsSync(copyDir())).toBe(true);
    expect(run.stdout).not.toContain(`--- ${settings()}`);
    inOrder(run.stdout, [
      '  without a terminal nothing removed; remove them by hand (step 1 below)',
      '1. In ~/.claude/settings.json remove by hand', '2. Copy of the hook code', '3. Package:', '4. When you are done',
    ]);
  });

  it('„y”, „n” → wpisy zdjęte, kopia zostaje z komendą `rm -r`', async () => {
    packageInstalled();
    const t = terminal('y', 'n');
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(settings(), 'utf8')).toBe(canonical(before()));
    expect(existsSync(path.join(copyDir(), 'rarog-pending.mjs'))).toBe(true);
    expect(run.stdout).toContain(`  kept; remove it by hand: rm -r '${copyDir()}'\n`);
    expect(run.stdout).toContain('Uninstalling Rarog, the remaining steps:');
  });

  it('katalog kopii podmieniony w czasie pytania o kopię → nic nie znika, bez komendy `rm -r` dla nowego katalogu',
    async () => {
      packageInstalled();
      const stary = `${copyDir()}-stary`;
      const t = meanwhileAtCopy(() => {
        renameSync(copyDir(), stary);
        mkdirSync(copyDir());
        writeFileSync(path.join(copyDir(), 'rarog-pending.mjs'), '// cudzy\n');
      });
      const run = await uninstall(t.ask);
      expect(run.status, run.stderr).toBe(0);
      expect(readdirSync(copyDir())).toEqual(['rarog-pending.mjs']);
      expect(readFileSync(path.join(copyDir(), 'rarog-pending.mjs'), 'utf8')).toBe('// cudzy\n');
      expect(readdirSync(stary).sort()).toEqual(['manifest.json', ...COPY_FILES]);
      inOrder(run.stdout, [
        `  ${copyDir()} changed during the question; nothing removed. Check it yourself.\n`,
        'Uninstalling Rarog, the remaining steps:',
      ]);
      expect(run.stdout).not.toContain(`rm -r '${copyDir()}'`);
    });

  it('dowiązanie w miejscu katalogu kopii → odmowa bez pytania, dowiązanie i jego cel zostają', async () => {
    packageInstalled();
    const target = path.join(sb.homeDir, 'gdzie-indziej');
    rmSync(copyDir(), { recursive: true });
    mkdirSync(target);
    writeFileSync(path.join(target, 'plik'), 'x');
    symlinkSync(target, copyDir());
    const t = terminal('y', 'y');
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(t.prompts).toEqual([REMOVE_PROMPT]);
    expect(lstatSync(copyDir()).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(target, 'plik'), 'utf8')).toBe('x');
    expect(run.stdout).toContain(`  ${copyDir()} is a symlink; only a real directory is removed.`);
  });

  it('konflikt (komenda spoza listy postaci) → bez pytań i zapisu, komenda dosłownie, kroki ręczne', async () => {
    const odd = `${hookCommand(sb.homeDir)}; curl x`;
    const body = packageInstalled({
      ...afterSetup(), hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: odd }] }] },
    });
    const t = terminal('y', 'y');
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(t.prompts).toEqual([]);
    expect(readFileSync(settings(), 'utf8')).toBe(body);
    expect(existsSync(copyDir())).toBe(true);
    inOrder(run.stdout, [
      '  conflict: nothing removed; remove them by hand (step 1 below)',
      `    "hooks.PermissionRequest" has a command that looks like Rarog's, but is not one Rarog printed: ${odd}`,
      '1. In ~/.claude/settings.json remove by hand', '2. Copy of the hook code',
    ]);
  });

  it('bez pliku ustawień → nic do zdjęcia, pytanie tylko o kopię', async () => {
    packageInstalled();
    rmSync(settings());
    const t = terminal('y');
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(settings())).toBe(false);
    expect(existsSync(copyDir())).toBe(false);
    expect(t.prompts).toEqual(['  Remove these files and the directory? [y/N] ']);
    inOrder(run.stdout, ['  none left, nothing to remove', `  removed: ${copyDir()}`, '1. Package:']);
  });

  it('`~/.claude/hooks` dowiązane do `~/Projects`: projekt `~/Projects/rarog` bez manifestu kopii → odmowa bez'
    + ' pytania o kopię, projekt nietknięty', async () => {
    packageInstalled();
    const hooks = path.dirname(copyDir());
    rmSync(hooks, { recursive: true });
    const project = path.join(sb.homeDir, 'Projects', 'rarog');
    mkdirSync(path.join(project, 'src'), { recursive: true });
    writeFileSync(path.join(project, 'package.json'), '{"name":"rarog-app"}\n');
    writeFileSync(path.join(project, 'src', 'app.ts'), 'export {};\n');
    symlinkSync(path.join(sb.homeDir, 'Projects'), hooks);
    const t = terminal('y', 'y');
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(path.join(project, 'package.json'), 'utf8')).toBe('{"name":"rarog-app"}\n');
    expect(readFileSync(path.join(project, 'src', 'app.ts'), 'utf8')).toBe('export {};\n');
    expect(t.prompts).toEqual([REMOVE_PROMPT]);
    inOrder(run.stdout, [
      `Copy of the hook code and of the statusLine script: ${copyDir()}\n`,
      `  ${copyDir()} has no Rarog copy manifest (manifest.json)`, 'Uninstalling Rarog, the remaining steps:',
    ]);
  });

  it('nieznany plik i podkatalog w katalogu kopii → zostają i są wypisane; pliki kopii znikają, katalog zostaje',
    async () => {
      packageInstalled();
      writeFileSync(path.join(copyDir(), 'notatki.txt'), 'moje\n');
      mkdirSync(path.join(copyDir(), 'moje'));
      writeFileSync(path.join(copyDir(), 'moje', 'plik'), 'x\n');
      const t = terminal('y', 'y');
      const run = await uninstall(t.ask);
      expect(run.status, run.stderr).toBe(0);
      expect(readdirSync(copyDir()).sort()).toEqual(['moje', 'notatki.txt']);
      expect(readFileSync(path.join(copyDir(), 'moje', 'plik'), 'utf8')).toBe('x\n');
      expect(t.prompts).toEqual([
        REMOVE_PROMPT, '  Remove these files? The directory stays with the rest. [y/N] ',
      ]);
      inOrder(run.stdout, [
        `Copy of the hook code and of the statusLine script: ${copyDir()}\n`,
        '  to remove: manifest.json, rarog-pending.mjs, rarog-statusline.mjs\n',
        '  stays, not from a Rarog install: moje/, notatki.txt\n',
        `  removed: rarog-pending.mjs, rarog-statusline.mjs, manifest.json; ${copyDir()} stays with: moje/,`
          + ' notatki.txt\n',
        'Uninstalling Rarog, the remaining steps:',
      ]);
    });

  it('nieznany plik, „n” → wszystko zostaje, komenda ręczna wymienia tylko pliki kopii', async () => {
    packageInstalled();
    writeFileSync(path.join(copyDir(), 'notatki.txt'), 'moje\n');
    const t = terminal('y', 'n');
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(readdirSync(copyDir()).sort()).toEqual(['manifest.json', 'notatki.txt', ...COPY_FILES]);
    const file = (name: string): string => `'${path.join(copyDir(), name)}'`;
    expect(run.stdout).toContain(`  kept; remove the Rarog files by hand: rm ${file('manifest.json')}`
      + ` ${file('rarog-pending.mjs')} ${file('rarog-statusline.mjs')}\n`);
  });

  it('katalog kopii bez manifestu → odmowa bez pytania o kopię, nic nie usunięte', async () => {
    packageInstalled();
    rmSync(path.join(copyDir(), 'manifest.json'));
    const t = terminal('y', 'y');
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(readdirSync(copyDir()).sort()).toEqual(COPY_FILES);
    expect(t.prompts).toEqual([REMOVE_PROMPT]);
    expect(run.stdout).toContain(`  ${copyDir()} has no Rarog copy manifest (manifest.json)`);
  });

  for (const [name, start] of [['`written`', afterSetup], ['`unchanged`', before]] as const) {
    it(`po ${name}: wpis Raroga dopisany w czasie pytania o kopię → kopia zostaje, powód i kroki ręczne`, async () => {
      packageInstalled(start());
      const meanwhile = canonical(afterSetup());
      const t = meanwhileAtCopy(() => { writeFileSync(settings(), meanwhile); });
      const run = await uninstall(t.ask);
      expect(run.status, run.stderr).toBe(0);
      expect(readdirSync(copyDir()).sort()).toEqual(['manifest.json', ...COPY_FILES]);
      expect(readFileSync(settings(), 'utf8')).toBe(meanwhile);
      inOrder(run.stdout, [
        `  ${settings()} has Rarog entries again; nothing removed\n`,
        `    "hooks.PermissionRequest": ${hookCommand(sb.homeDir)}\n`,
        `    "hooks.SessionStart": ${contextHookCommand(sb.homeDir)}\n`,
        `    "statusLine": ${visibleLine(statuslineCommand(sb.homeDir, FOREIGN))}\n`,
        'Uninstalling Rarog, step by step (the service is already removed):',
        '1. In ~/.claude/settings.json remove by hand',
        `2. Copy of the hook code and of the statusLine script: ${copyDir()} (remove after the entries).`,
      ]);
      expect(run.stdout).not.toContain('the remaining steps');
    });
  }

  it('zepsuty JSON w czasie pytania o kopię → kopia zostaje, powód z plikiem i kroki ręczne', async () => {
    packageInstalled();
    const t = meanwhileAtCopy(() => { writeFileSync(settings(), '{ "model": "opus", }\n'); });
    const run = await uninstall(t.ask);
    expect(run.status, run.stderr).toBe(0);
    expect(readdirSync(copyDir()).sort()).toEqual(['manifest.json', ...COPY_FILES]);
    inOrder(run.stdout, [
      `  ${settings()} is not strict JSON`, '; nothing removed\n',
      'Uninstalling Rarog, step by step (the service is already removed):',
    ]);
  });

  it('klon repo → bez pytań, ustawienia i kopia bez zmian (`packageUninstallNotes` zwraca pustą listę)', async () => {
    const body = packageInstalled();
    const run = await uninstall(() => Promise.reject(new Error('pytanie w klonie')), 'clone');
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(settings(), 'utf8')).toBe(body);
    expect(existsSync(copyDir())).toBe(true);
    expect(run.stdout).not.toContain('Rarog entries');
    expect(packageUninstallNotes(sb.homeDir, 'clone')).toEqual([]);
  });
});

describe('szablon jednostki rarog.service', () => {
  const input = {
    execStart: ['/home/rarog/bin/$wrap 50%.sh', 'rarog', '--only', 'A,B', '--klucz=a "b"', 'c\\d', '$HOME', '--',
      '/home/rarog/.nvm/versions/node/v22.22.3/bin/node', '/home/rarog/repo z %spacją$/bin/rarog.mjs', 'serve'],
    workingDirectory: '/home/rarog/repo z %spacją$',
    log: '/home/rarog/dane 50%/server.log',
  };

  it('render = plik wzorcowy (odśwież: RAROG_FIXTURES_WRITE=1)', () => {
    const text = renderServiceUnit(input);
    if (WRITE) {
      mkdirSync(path.dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, text);
    }
    expect(text).toBe(readFileSync(FIXTURE, 'utf8'));
  });

  it('pola: program bez $$, argumenty z \\ " $$, wszędzie %%; parser oddaje argv', () => {
    const text = renderServiceUnit(input);
    expect(text).toContain('WorkingDirectory=/home/rarog/repo z %%spacją$\n');
    expect(text).toContain('StandardOutput=append:/home/rarog/dane 50%%/server.log\n');
    expect(text).toContain('ExecStart="/home/rarog/bin/$wrap 50%%.sh" "rarog" "--only" "A,B" "--klucz=a \\"b\\""'
      + ' "c\\\\d" "$$HOME" "--"');
    expect(text).toContain('"/home/rarog/repo z %%spacją$$/bin/rarog.mjs" "serve"\n');
    expect(parseExecStart(text)).toEqual({ argv: input.execStart });
  });

  it('" albo \\ w katalogu repo i w katalogu danych → odmowa z nazwą pola', () => {
    for (const bad of ['/home/rarog/re"po', '/home/rarog/re\\po']) {
      expect(() => renderServiceUnit({ ...input, workingDirectory: bad })).toThrow(Refusal);
      expect(() => renderServiceUnit({ ...input, workingDirectory: bad })).toThrow(/WorkingDirectory/);
      expect(() => renderServiceUnit({ ...input, log: `${bad}/server.log` })).toThrow(/server log/);
    }
  });
});
