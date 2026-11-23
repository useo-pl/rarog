/**
 * `rarog restart` i parametry `scripts/restart.sh`.
 *
 * `rarog restart` biegnie naprawdę (`node bin/rarog.mjs restart`) i woła prawdziwy `restart.sh`, ale wszystko, co
 * dotyka systemu, to atrapy w katalogu tymczasowym na początku `PATH`: `launchctl` (stan etykiety z `FAKE_LOADED`:
 * `print` daje 0 albo 113 jak prawdziwy; etykieta z `FAKE_UNKNOWN` daje 5, czyli „nie wiem”; `print gui/<uid>` bez
 * etykiety drukuje `FAKE_DOMAIN_PRINT` (domyślnie blok `environment` bez zmiennych katalogu danych), a z
 * `FAKE_DOMAIN_FAIL` daje kod 5 albo sygnał; log wywołań), `curl` (zadany `/health`, log adresu), `nohup` (log
 * komendy startu zamiast startu), `pgrep` i `lsof` („nic nie działa”), węzeł usługi wypisujący zadaną wersję.
 * Każdy test ma `HOME` i `XDG_DATA_HOME` w katalogu
 * tymczasowym (tam leżą `config.json`, plik sekretów, plist usługi i blokada), a `afterAll` sprawdza, że prawdziwe
 * katalogi `rarog` właściciela nie powstały.
 *
 * Sprawdza każdy wiersz tabeli stanów: `ai.rarog.server` załadowana → zmienne katalogu danych puste w powłoce
 * i w domenie launchd (blok `environment` z `launchctl print gui/<uid>`: niepusta = odmowa, wydruk nie do
 * rozstrzygnięcia = ostrzeżenie), `serve --check`, cel usługi (wejście innej instalacji = odmowa, inny węzeł klonu =
 * uwaga), węzeł usługi, katalog jej logu wobec katalogu danych, potem etykieta, port i log; bez usługi → bez
 * `config.json` odmowa z „rarog setup”, z wrapperem bez sekretów odmowa, inaczej `nohup node bin/rarog.mjs serve`.
 * „Nie wiem” o etykiecie (kod `launchctl print` inny niż 0 i 113) → odmowa, zanim `restart.sh` ruszy. Do tego
 * blokada (żywy, martwy i równoległy właściciel), `restart.sh` wprost (bez parametrów odmowa, brak i zła wartość
 * parametru = 64, etykieta niezaładowanej usługi = błąd przed zatrzymaniem, bez `nohup`), `pnpm run restart`
 * i sama reguła `loadState`
 * (0, 113, inny kod, sygnał, brak `launchctl`, poza macOS), a parser bloku `environment` domeny
 * (`parseDomainEnvironment`) na tekstach w kształcie pomiaru.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminSocketPath } from '../src/auth/admin.ts';
import { Refusal } from '../src/cli/io.ts';
import type { CliIo } from '../src/cli/io.ts';
import { TAKEOVER_SUFFIX, acquireLock } from '../src/cli/lock.ts';
import {
  loadState, parseDomainEnvironment, refuseLaunchdDataDirEnv, serviceInstallationMismatch, servicePackageFromClone,
} from '../src/cli/restart.ts';
import { IROH_KEY_UNCHECKED_LINE, SECRETS_UNCHECKED_LINE } from '../src/cli/serve.ts';
import { RESTART_HOOK_REPAIR } from '../src/install/repair.ts';
import { serviceTarget } from '../src/install/service-target.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';
import { fakeRestartScript } from './helpers/atrapa-restart-sh.ts';
import { IS_MAC, macOnly } from './platform.ts';
import { SSH_AUTH_SOCK_ENTRY, domainPrint, fakePackage } from './rarog-service-sandbox.ts';

/** Węzeł usługi tej instalacji: przy Node z Homebrew `opt/<formuła>/bin/node`, nie `Cellar` z `process.execPath`. */
const SERVICE_NODE = serviceTarget().node;

const REPO = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'rarog.mjs');
const UID = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
const SERVICE = 'ai.rarog.server';
const HEALTHY = '{"ok":true,"version":"t","uptime":1,"herdr":true,"term":true}';
const PORT = '18999';
/** Sztuczny sekret — prawdziwych testy nie znają. */
const FAKE_SECRET = 'sztuczny-sekret-restartu-0123456789abcdef';

interface Sandbox {
  readonly home: TempHome;
  readonly bin: string;
  readonly logs: string;
  /** Linie logu atrapy (`launchctl`, `curl`, `nohup`); brak pliku = atrapa nie była wołana. */
  calls(name: string): string[];
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

let sb: Sandbox;

function makeSandbox(): Sandbox {
  const home = tempHome('rarog-restart-');
  const bin = path.join(home.home, 'atrapy');
  const logs = path.join(home.home, 'logi');
  mkdirSync(bin);
  mkdirSync(logs);
  const fake = (name: string, lines: string[]): void => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/bash\n${lines.join('\n')}\n`);
    chmodSync(file, 0o755);
  };
  fake('launchctl', [
    `printf '%s\\n' "$*" >> '${logs}/launchctl'`,
    'case "$1" in',
    '  print)',
    // Domena bez etykiety (`print gui/<uid>`): wydruk `FAKE_DOMAIN_PRINT`, a z `FAKE_DOMAIN_FAIL` kod 5 albo sygnał.
    '    if [[ "$2" != */*/* ]]; then',
    '      case "${FAKE_DOMAIN_FAIL:-}" in',
    '        kod) echo "Could not print domain: 5: Input/output error" >&2; exit 5 ;;',
    '        sygnal) kill -KILL $$ ;;',
    '      esac',
    '      printf \'%s\' "${FAKE_DOMAIN_PRINT:-}"; exit 0',
    '    fi',
    '    case " ${FAKE_UNKNOWN:-} " in *" ${2##*/} "*) echo "Could not print: 5: Input/output error" >&2; exit 5 ;; esac',
    // Brak etykiety to kod 113 (w sandboksie i poza nim); inny kod = „nie wiem”.
    // `FAKE_SERVICE_PID`: the label runs that PID (`pid = N` at the top level of the printout, like launchd; the
    // nested `pid` line before it must not count).
    '    case " ${FAKE_LOADED:-} " in *" ${2##*/} "*)',
    '      if [ -n "${FAKE_SERVICE_PID:-}" ]; then',
    '        printf \'%s = {\\n\\tstate = running\\n\\tendpoints = {\\n\\t\\tpid = 1\\n\\t}\\n\\tpid = %s\\n}\\n\' "$2" "$FAKE_SERVICE_PID"',
    '      fi',
    '      exit 0 ;;',
    '    *) exit 113 ;; esac ;;',
    '  kickstart) sleep "${FAKE_KICKSTART_SLEEP:-0}"; exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
  ]);
  fake('curl', [`printf '%s\\n' "$*" >> '${logs}/curl'`, 'printf \'%s\' "${FAKE_HEALTH:-}"']);
  fake('nohup', [`printf '%s | node=%s\\n' "$*" "$(command -v node)" >> '${logs}/nohup'`]);
  fake('pgrep', [`printf '%s\\n' "$*" >> '${logs}/pgrep'`, 'exit 1']);
  fake('lsof', [`printf '%s\\n' "$*" >> '${logs}/lsof'`, 'exit 0']);
  return {
    home, bin, logs,
    calls: (name) => {
      const file = path.join(logs, name);
      return existsSync(file) ? readFileSync(file, 'utf8').trimEnd().split('\n') : [];
    },
    env: (extra = {}) => ({
      // Atrapy PRZED `/bin`: `launchctl` ani `nohup` z systemu nie mogą tu nic zrobić.
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home.home,
      XDG_DATA_HOME: path.join(home.home, 'xdg'),
      FAKE_HEALTH: HEALTHY,
      FAKE_DOMAIN_PRINT: domainPrint([SSH_AUTH_SOCK_ENTRY]),
      ...extra,
    }),
  };
}

beforeEach(() => { sb = makeSandbox(); });
afterEach(() => { sb.home.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const configDir = (): string => path.join(sb.home.home, '.config', 'rarog');
const lockFile = (): string => path.join(configDir(), 'lock');

function writeConfig(value: unknown): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(configDir(), 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

function writeSecrets(text: string): void {
  const dir = path.join(configDir(), 'secret');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path.join(dir, 'private.env'), text, { mode: 0o600 });
}

const WRAPPER = ['/nieistniejacy/secret-env.sh', 'rarog', '--'];
const OWNER_CONFIG = {
  version: 1, env: { RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: PORT }, service: { wrapper: WRAPPER },
};

/** Nasłuch iroh w `config.json`; klucz jest sekretem, więc nigdy tutaj. */
const IROH_ENV = { RAROG_IROH: '1', RAROG_IROH_RELAY: 'https://relay.example./' };
/** Sztuczny klucz iroh — prawdziwych testy nie znają. */
const FAKE_IROH_KEY = '34'.repeat(32);

/** Wrapper sekretów-atrapa: eksportuje podane zmienne i wykonuje resztę argv po `--`; wywołania w logu `wrapper`. */
function exportingWrapper(exports: Readonly<Record<string, string>>): string[] {
  const file = path.join(sb.home.home, 'wrapper', 'eksport.sh');
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = Object.entries(exports).map(([name, value]) => `export ${name}='${value}'`);
  writeFileSync(file, ['#!/bin/bash', `printf '%s\\n' "$*" >> '${sb.logs}/wrapper'`, ...lines, 'shift', 'exec "$@"', '']
    .join('\n'));
  chmodSync(file, 0o755);
  return [file, '--'];
}

/** Węzeł usługi: skrypt wypisujący zadaną wersję (`null` = pliku nie ma). */
function serviceNode(version: string | null): string {
  const file = path.join(sb.home.home, 'node-uslugi', 'node');
  if (version !== null) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/bash\necho ${version}\n`);
    chmodSync(file, 0o755);
  }
  return file;
}

/**
 * Plist usługi `ai.rarog.server` w LaunchAgents testu: wrapper + węzeł + `<repo>/bin/rarog.mjs serve` (pkt 7);
 * `bin` = wejście innej instalacji, `log` = `StandardOutPath` (bez niego katalog danych z reguły).
 */
function writeServicePlist(node: string, { bin = CLI, log }: { bin?: string; log?: string } = {}): string {
  const dir = path.join(sb.home.home, 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SERVICE}.plist`);
  const args = [...WRAPPER, node, bin, 'serve'].map((arg) => `<string>${arg}</string>`).join('');
  const logKey = log === undefined ? '' : `<key>StandardOutPath</key><string>${log}</string>`;
  writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0"><dict><key>Label</key><string>${SERVICE}</string>`
    + `<key>ProgramArguments</key><array>${args}</array>${logKey}</dict></plist>\n`);
  return file;
}

interface Run { status: number | null; stdout: string; stderr: string }

function rarogRestart(extra: NodeJS.ProcessEnv = {}, argv: string[] = []): Run {
  expect(existsSync(path.join(sb.bin, 'launchctl'))).toBe(true);
  const result = spawnSync(process.execPath, [CLI, 'restart', ...argv], {
    cwd: sb.home.home, env: sb.env(extra), encoding: 'utf8', timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Jak {@link rarogRestart}, ale bez blokowania pętli zdarzeń testu (gniazda w teście muszą odpowiadać). */
function rarogRestartAsync(extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  expect(existsSync(path.join(sb.bin, 'launchctl'))).toBe(true);
  const child = spawn(process.execPath, [CLI, 'restart'], { cwd: sb.home.home, env: sb.env(extra) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  return new Promise((resolve) => {
    child.on('close', (status) => { resolve({ status, stdout, stderr }); });
  });
}

/** `restart.sh` wprost; zdanie naprawy hooka jak od `rarog restart`, chyba że `extra` je zmienia albo zdejmuje. */
function restartScript(extra: NodeJS.ProcessEnv = {}): Run {
  expect(existsSync(path.join(sb.bin, 'launchctl'))).toBe(true);
  const result = spawnSync('bash', ['scripts/restart.sh'], {
    cwd: REPO, env: sb.env({ RAROG_RESTART_HOOK_REPAIR: RESTART_HOOK_REPAIR, ...extra }), encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const print = (label: string): string => `print gui/${UID}/${label}`;
const kickstart = (label: string): string => `kickstart gui/${UID}/${label}`;
/** Pytanie o blok `environment` domeny launchd przed `check` gałęzi `ai.rarog.server`. */
const DOMAIN = `print gui/${UID}`;
/**
 * Gałąź `ai.rarog.server` odmawia przy zmiennej katalogu danych w powłoce, a piaskownica ustawia `XDG_DATA_HOME`
 * w każdym teście — tu bez niej (katalog danych z `HOME` testu: `~/.local/share/rarog`).
 */
const SERVICE_ONLY: NodeJS.ProcessEnv = { FAKE_LOADED: SERVICE, XDG_DATA_HOME: undefined };

describe('usługa na paczce npm widziana z klonu (`servicePackageFromClone`)', () => {
  it('paczka na dysku → korzeń, wejście, węzeł, wersja; tryb paczki, ten klon, inny klon, brak pliku → bez paczki', () => {
    const pkg = fakePackage(path.join(sb.home.home, 'prefiks'), '1.2.3');
    const otherClone = fakePackage(path.join(sb.home.home, 'inny-klon'), '0.0.1', { built: false });
    const argv = ['/usr/local/bin/w', '--', '/opt/node/bin/node', pkg.bin, 'serve'];
    expect(servicePackageFromClone(argv, 'clone')).toEqual({
      root: pkg.root, bin: pkg.bin, node: '/opt/node/bin/node', version: '1.2.3',
    });
    expect(serviceInstallationMismatch(argv, 'clone')).toMatchObject({
      kind: 'bin', blocking: true, servicePackage: { root: pkg.root },
      what: expect.stringContaining(`starts the rarog package 1.2.3 (${pkg.root}), but this command is the repo clone`
        + ` ${REPO}`),
    });
    expect(servicePackageFromClone(argv, 'package')).toBeNull();
    expect(servicePackageFromClone(['/opt/node/bin/node', CLI, 'serve'], 'clone')).toBeNull();
    for (const bin of [otherClone.bin, path.join(sb.home.home, 'nie-ma', 'bin', 'rarog.mjs')]) {
      expect(servicePackageFromClone(['/opt/node/bin/node', bin, 'serve'], 'clone')).toBeNull();
      expect(serviceInstallationMismatch(['/opt/node/bin/node', bin, 'serve'], 'clone')).toMatchObject({
        servicePackage: null, what: expect.stringContaining('points to another installation'),
      });
    }
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog restart: tabela stanów launchd', 'launchd'), { timeout: 30_000 }, () => {
  it('odziedziczone parametry RAROG_RESTART_* (także UNIT Linuksa) nie przechodzą do restart.sh', () => {
    writeConfig(OWNER_CONFIG);
    writeServicePlist(serviceNode('v22.22.3'));
    // Bez czyszczenia `restart.sh` odmówiłby kodem 64 (jednostka systemd poza Linuksem, etykieta razem z SERVE).
    const run = rarogRestart({
      ...SERVICE_ONLY, RAROG_RESTART_UNIT: 'rarog.service', RAROG_RESTART_PORT: '1234', RAROG_RESTART_SERVE: 'rarog',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('launchctl')).toEqual([print(SERVICE), DOMAIN, print(SERVICE), print(SERVICE), kickstart(SERVICE)]);
    expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
  });

  it('ai.rarog.server załadowana → serve --check bez sekretów, węzeł usługi, etykieta, port i log z konfiguracji', () => {
    writeConfig(OWNER_CONFIG);
    writeServicePlist(serviceNode('v22.22.3'));
    const run = rarogRestart(SERVICE_ONLY);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(SECRETS_UNCHECKED_LINE);
    expect(run.stdout).toContain(`${SERVICE} loaded — restart.sh with this label, port ${PORT}`);
    expect(sb.calls('launchctl')).toEqual([print(SERVICE), DOMAIN, print(SERVICE), print(SERVICE), kickstart(SERVICE)]);
    expect(run.stderr).not.toContain('not checked');
    expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
    expect(run.stdout).toContain(`log: ${path.join(sb.home.home, '.local', 'share', 'rarog', 'server.log')}`);
  });

  // Klucz „niesprawdzony” przy wrapperze nie może przepuścić restartu — sprawdza go pełne
  // `serve --check` przez wrapper, zanim cokolwiek się zatrzyma.
  it('ai.rarog.server załadowana, RAROG_IROH=1, klucz z service.wrapper → pełne --check przez wrapper, restart.sh rusza', () => {
    const wrapper = exportingWrapper({ RAROG_IROH_KEY: FAKE_IROH_KEY });
    writeConfig({ ...OWNER_CONFIG, env: { ...OWNER_CONFIG.env, ...IROH_ENV }, service: { wrapper } });
    writeServicePlist(serviceNode('v22.22.3'));
    const run = rarogRestart(SERVICE_ONLY);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(IROH_KEY_UNCHECKED_LINE);
    expect(sb.calls('wrapper')).toEqual([`-- ${SERVICE_NODE} ${CLI} serve --check`]);
    expect(sb.calls('launchctl')).toContain(kickstart(SERVICE));
    for (const out of [run.stdout, run.stderr]) expect(out).not.toContain(FAKE_IROH_KEY);
  });

  it('ai.rarog.server załadowana, RAROG_IROH=1, service.wrapper bez klucza → odmowa PRZED zatrzymaniem', () => {
    for (const [exports, reason] of [
      [{}, 'the wrapper supplies no secret'],
      [{ SONIOX_API_KEY: FAKE_SECRET }, 'RAROG_IROH=1 without RAROG_IROH_KEY'],
    ] as const) {
      const wrapper = exportingWrapper(exports);
      writeConfig({ ...OWNER_CONFIG, env: { ...OWNER_CONFIG.env, ...IROH_ENV }, service: { wrapper } });
      writeServicePlist(serviceNode('v22.22.3'));
      const run = rarogRestart(SERVICE_ONLY);
      expect(run.status, run.stdout).toBe(1);
      expect(run.stderr).toContain('through service.wrapper does not see RAROG_IROH_KEY');
      expect(run.stderr).toContain(reason);
      expect(run.stderr).toContain('Nothing was stopped');
      expect(sb.calls('launchctl')).not.toContain(kickstart(SERVICE));
      expect(sb.calls('curl')).toEqual([]);
      for (const out of [run.stdout, run.stderr]) expect(out).not.toContain(FAKE_SECRET);
    }
  });

  it('ai.rarog.server załadowana, RAROG_IROH=1, plik sekretów bez klucza iroh → odmowa PRZED zatrzymaniem', () => {
    writeConfig({ ...OWNER_CONFIG, env: { ...OWNER_CONFIG.env, ...IROH_ENV } });
    writeSecrets(`SONIOX_API_KEY=${FAKE_SECRET}\n`);
    writeServicePlist(serviceNode('v22.22.3'));
    const run = rarogRestart(SERVICE_ONLY);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RAROG_IROH=1 without RAROG_IROH_KEY');
    expect(sb.calls('launchctl')).not.toContain(kickstart(SERVICE));
    expect(sb.calls('curl')).toEqual([]);
  });

  it('ai.rarog.server załadowana, zła konfiguracja → odmowa PRZED zatrzymaniem', () => {
    writeServicePlist(serviceNode('v22.22.3'));
    for (const config of [
      { ...OWNER_CONFIG, env: { ...OWNER_CONFIG.env, RAROG_MAX_PANES: '0' } },
      { ...OWNER_CONFIG, env: { ...OWNER_CONFIG.env, RAROG_DATA_DIR: '/x' } },
    ]) {
      writeConfig(config);
      const run = rarogRestart(SERVICE_ONLY);
      expect(run.status, JSON.stringify(config)).toBe(1);
      expect(sb.calls('launchctl')).not.toContain(kickstart(SERVICE));
      expect(sb.calls('curl')).toEqual([]);
    }
  });

  it('ai.rarog.server załadowana, węzeł usługi brak, 20.x, 22.14 albo 23.10 → odmowa PRZED zatrzymaniem', () => {
    writeConfig(OWNER_CONFIG);
    const cases: [string | null, string][] = [
      [null, 'does not exist or is not executable'],
      ['v20.19.0', 'v20.19.0'],
      ['v22.14.0', 'v22.14.0'],
      ['v23.10.0', 'v23.10.0, but the service requires ≥ 22.15, 23.x ≥ 23.11'],
    ];
    for (const [version, needle] of cases) {
      writeServicePlist(serviceNode(version));
      const run = rarogRestart(SERVICE_ONLY);
      expect(run.status, String(version)).toBe(1);
      expect(run.stderr).toContain(needle);
      expect(sb.calls('launchctl')).not.toContain(kickstart(SERVICE));
    }
  });

  it('ai.rarog.server załadowana, węzeł usługi z linii 24 albo 26 → restart.sh rusza', () => {
    writeConfig(OWNER_CONFIG);
    for (const version of ['v24.11.1', 'v26.10.0']) {
      writeServicePlist(serviceNode(version));
      const run = rarogRestart(SERVICE_ONLY);
      expect(run.status, `${version}: ${run.stderr}`).toBe(0);
    }
    expect(sb.calls('launchctl').filter((call) => call === kickstart(SERVICE))).toHaveLength(2);
  });

  it('ai.rarog.server załadowana, plist wskazuje inną instalację (jest albo już jej nie ma) → odmowa z service install', () => {
    writeConfig(OWNER_CONFIG);
    const other = path.join(sb.home.home, 'inna-instalacja');
    const otherBin = path.join(other, 'bin', 'rarog.mjs');
    mkdirSync(path.dirname(otherBin), { recursive: true });
    writeFileSync(otherBin, '');
    writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'rarog', version: '0.9.0' }));
    writeServicePlist(serviceNode('v22.22.3'), { bin: otherBin });
    for (const version of ['version 0.9.0', 'the file is gone']) {
      const run = rarogRestart(SERVICE_ONLY);
      expect(run.status, version).toBe(1);
      expect(run.stderr).toContain(`the service points to another installation (${otherBin}, ${version}), but this`
        + ` command is ${CLI}`);
      expect(run.stderr).toContain('run node bin/rarog.mjs service install from this installation');
      expect(run.stderr).toContain('Nothing was stopped');
      expect(sb.calls('launchctl')).not.toContain(kickstart(SERVICE));
      expect(sb.calls('curl')).toEqual([]);
      rmSync(other, { recursive: true, force: true });
    }
  });

  // Z klonu `service install` przełączyłby usługę z paczki na klon, więc nie jest naprawą: odmowa podaje restart
  // paczki, wdrożenie kodu klonu i przełączenie z komendą powrotu.
  it('klon, plist wskazuje paczkę npm → odmowa z restartem paczki, przełączeniem na klon i powrotem, bez zatrzymania', () => {
    writeConfig(OWNER_CONFIG);
    const pkg = fakePackage(path.join(sb.home.home, 'prefiks'), '0.9.0');
    const node = serviceNode('v22.22.3');
    writeServicePlist(node, { bin: pkg.bin });
    const run = rarogRestart(SERVICE_ONLY);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain(`rarog restart: the service starts the rarog package 0.9.0 (${pkg.root}), but this`
      + ` command is the repo clone ${REPO} (version `);
    expect(run.stderr).toContain(` — a restart from here would run the package code, not this clone. Restart the service:`
      + ` '${node}' '${pkg.bin}' restart. This clone's code reaches the service as a package built from the clone`
      + ' (docs/distribution.md, "Clone next to the package"). Switch the service to this clone: node bin/rarog.mjs'
      + ` service install (shows the changes and asks [y/N]); back to the package: '${node}' '${pkg.bin}' service`
      + ' install. Nothing was stopped.');
    expect(run.stderr).not.toContain('from this installation');
    expect(sb.calls('launchctl')).not.toContain(kickstart(SERVICE));
    expect(sb.calls('curl')).toEqual([]);
  });

  it('ai.rarog.server załadowana, węzeł usługi inny niż węzeł komendy (klon) → uwaga na stderr, restart.sh rusza', () => {
    writeConfig(OWNER_CONFIG);
    const node = serviceNode('v22.22.3');
    writeServicePlist(node);
    const run = rarogRestart(SERVICE_ONLY);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain(`rarog restart: warning, the service starts with node ${node}, but this command runs`
      + ` on ${process.execPath}`);
    expect(sb.calls('launchctl')).toContain(kickstart(SERVICE));
  });

  it('ai.rarog.server załadowana, log usługi poza katalogiem danych → odmowa z service install; przez dowiązanie → restart', () => {
    writeConfig(OWNER_CONFIG);
    const ruled = path.join(sb.home.home, '.local', 'share', 'rarog');
    const other = path.join(sb.home.home, 'stare-dane');
    mkdirSync(other, { recursive: true });
    mkdirSync(ruled, { recursive: true });
    writeServicePlist(serviceNode('v22.22.3'), { log: path.join(other, 'server.log') });
    const refused = rarogRestart(SERVICE_ONLY);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`The data directory from this shell ${ruled} and the directory of the installed service ${other}`);
    expect(refused.stderr).toContain('Reinstall the service: node bin/rarog.mjs service install.');
    expect(refused.stderr).toContain('Nothing was stopped');
    expect(sb.calls('launchctl')).not.toContain(kickstart(SERVICE));
    // Stara nazwa katalogu jako dowiązanie do katalogu z reguły to ten sam katalog.
    rmSync(other, { recursive: true });
    symlinkSync(ruled, other);
    const run = rarogRestart(SERVICE_ONLY);
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('launchctl')).toContain(kickstart(SERVICE));
  });

  it('ai.rarog.server załadowana bez pliku usługi w LaunchAgents → odmowa', () => {
    writeConfig(OWNER_CONFIG);
    const run = rarogRestart(SERVICE_ONLY);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${SERVICE}.plist`);
    expect(sb.calls('launchctl')).not.toContain(kickstart(SERVICE));
  });

  it('bez usługi, bez config.json → odmowa z „rarog setup”, nic nie zatrzymane ani nie wystartowane', () => {
    const run = rarogRestart({ FAKE_LOADED: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`rarog restart: no ${SERVICE} service and no ${path.join(configDir(), 'config.json')}`
      + ' — the server starts only through rarog serve with this config. rarog setup creates it (then rarog'
      + ' service install). Nothing was stopped.');
    expect(sb.calls('launchctl')).toEqual([print(SERVICE)]);
    expect(sb.calls('nohup')).toEqual([]);
    expect(sb.calls('curl')).toEqual([]);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('bez usługi, config.json z service.wrapper, bez sekretów → odmowa, nic nie startuje', () => {
    writeConfig(OWNER_CONFIG);
    const run = rarogRestart({ FAKE_LOADED: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('the secrets come from service.wrapper');
    expect(sb.calls('nohup')).toEqual([]);
    expect(sb.calls('curl')).toEqual([]);
  });

  it('bez usługi, config.json bez wrappera, sekret z pliku → nohup node bin/rarog.mjs serve węzłem rarog, port i log', () => {
    writeConfig({ version: 1, env: OWNER_CONFIG.env });
    writeSecrets(`SONIOX_API_KEY=${FAKE_SECRET}\n`);
    const run = rarogRestart({ FAKE_LOADED: '' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('start: nohup node bin/rarog.mjs serve');
    expect(sb.calls('nohup')).toEqual([`node bin/rarog.mjs serve | node=${process.execPath}`]);
    expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
    expect(run.stdout).toContain(`log: ${path.join(sb.home.home, 'xdg', 'rarog', 'server.log')}`);
    for (const out of [run.stdout, run.stderr]) expect(out).not.toContain(FAKE_SECRET);
  });

  it('bez usługi, RAROG_IROH=1: bez klucza odmowa przed nohup; klucz w pliku sekretów → nohup, wartość nigdzie', () => {
    writeConfig({ version: 1, env: { ...OWNER_CONFIG.env, ...IROH_ENV } });
    let run = rarogRestart({ FAKE_LOADED: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('RAROG_IROH=1 without RAROG_IROH_KEY');
    expect(sb.calls('nohup')).toEqual([]);
    expect(sb.calls('curl')).toEqual([]);
    const key = '12'.repeat(32);
    writeSecrets(`RAROG_IROH_KEY=${key}\n`);
    run = rarogRestart({ FAKE_LOADED: '' });
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('nohup')).toEqual([`node bin/rarog.mjs serve | node=${process.execPath}`]);
    for (const out of [run.stdout, run.stderr]) expect(out).not.toContain(key);
  });

  it('bez usługi, config.json bez wrappera i bez pliku sekretów → --check przechodzi (sekrety opcjonalne), nohup rarog serve', () => {
    writeConfig({ version: 1, env: OWNER_CONFIG.env });
    const run = rarogRestart({ FAKE_LOADED: '' });
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('nohup')).toEqual([`node bin/rarog.mjs serve | node=${process.execPath}`]);
    expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
  });

  /*
   * `restart.sh` zatrzymuje tylko serwer portu z konfiguracji (`production_candidate` odrzuca obcy
   * `RAROG_PORT`), więc po zmianie portu w `config.json` stary serwer bez launchd zostałby obok nowego na tych samych
   * danych. Gniazdo administracyjne katalogu danych żyje, a port milczy → odmowa przed zatrzymaniem.
   */
  it('bez usługi, config.json: serwer tego katalogu danych żyje na innym porcie → odmowa; na porcie z konfiguracji → restart', async () => {
    const dataDir = path.join(sb.home.home, 'xdg', 'rarog');
    const socket = adminSocketPath(dataDir);
    mkdirSync(path.dirname(socket), { recursive: true });
    const admin = net.createServer();
    await new Promise<void>((resolve) => { admin.listen(socket, resolve); });
    const tcp = net.createServer();
    await new Promise<void>((resolve) => { tcp.listen(0, '127.0.0.1', resolve); });
    const livePort = String((tcp.address() as net.AddressInfo).port);
    try {
      writeSecrets(`SONIOX_API_KEY=${FAKE_SECRET}\n`);
      writeConfig({ version: 1, env: { ...OWNER_CONFIG.env, RAROG_PORT: PORT } });
      let run = await rarogRestartAsync({ FAKE_LOADED: '' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`but not on port ${PORT} from the config`);
      expect(run.stderr).toContain('Nothing was stopped');
      expect(sb.calls('nohup')).toEqual([]);
      expect(sb.calls('curl')).toEqual([]);

      writeConfig({ version: 1, env: { ...OWNER_CONFIG.env, RAROG_PORT: livePort } });
      run = await rarogRestartAsync({ FAKE_LOADED: '' });
      expect(run.status, run.stderr).toBe(0);
      expect(sb.calls('nohup')).toHaveLength(1);
      expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${livePort}/health`]);
    } finally {
      admin.close();
      tcp.close();
    }
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog restart: launchctl print does not tell whether the label is loaded', 'launchd'), { timeout: 30_000 }, () => {
  /*
   * An exit status of `launchctl print` other than 0 and 113 does not mean "not loaded": reading it so would take the
   * "none" branch for a loaded service and start `nohup` next to the launchd supervisor. The config and the service
   * node are valid here, so without the refusal every branch would go on to `restart.sh`.
   */
  it('kod inny niż 0 i 113 → odmowa (z config.json i bez), restart.sh nie ruszony', () => {
    writeSecrets(`SONIOX_API_KEY=${FAKE_SECRET}\n`);
    writeServicePlist(serviceNode('v22.22.3'));
    for (const config of [null, { version: 1, env: OWNER_CONFIG.env }]) {
      const what = config === null ? 'bez config.json' : 'z config.json';
      if (config !== null) writeConfig(config);
      rmSync(path.join(sb.logs, 'launchctl'), { force: true });
      const run = rarogRestart({ FAKE_UNKNOWN: SERVICE, FAKE_LOADED: '' });
      expect(run.status, what).toBe(1);
      expect(run.stderr, what).toContain(`launchctl print gui/${UID}/${SERVICE} does not tell whether ${SERVICE} is`
        + ' loaded (exit status 5, Could not print: 5: Input/output error)');
      expect(run.stderr, what).toContain('Nothing was stopped');
      expect(sb.calls('launchctl'), what).toEqual([print(SERVICE)]);
      expect(sb.calls('curl'), what).toEqual([]);
      expect(sb.calls('nohup'), what).toEqual([]);
      expect(existsSync(lockFile()), what).toBe(false);
    }
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog restart, ai.rarog.server: zmienne katalogu danych w powłoce i w domenie launchd', 'launchd'), { timeout: 30_000 }, () => {
  /*
   * Usługa pod launchd nie dostaje zmiennych tej powłoki, a dostaje blok `environment` domeny `gui/<uid>` (wartość
   * z `launchctl setenv` w kontekście `Aqua`): przy którejkolwiek niepustej `check` sprawdziłby inny katalog danych
   * niż ten, na którym wstanie serwer (i niż ten, który liczy hook). Konfiguracja, plist i węzeł usługi są tu
   * poprawne, więc bez odmowy restart.sh by ruszył.
   */
  const ready = (): void => {
    writeConfig(OWNER_CONFIG);
    writeServicePlist(serviceNode('v22.22.3'));
  };
  /** Odmowa przed `restart.sh`: tylko pytania `launchctl` frontu, bez `kickstart`, `curl`, `nohup` i blokady. */
  const expectRefusedBeforeScript = (run: Run, calls: string[], what: string): void => {
    expect(run.status, `${what}: ${run.stderr}`).toBe(1);
    expect(run.stderr, what).toContain('Nothing was stopped');
    expect(sb.calls('launchctl'), what).toEqual(calls);
    expect(sb.calls('curl'), what).toEqual([]);
    expect(sb.calls('nohup'), what).toEqual([]);
    expect(existsSync(lockFile()), what).toBe(false);
  };
  const fresh = (): void => {
    rmSync(path.join(sb.logs, 'launchctl'), { force: true });
    rmSync(path.join(sb.logs, 'curl'), { force: true });
  };
  const inDomain = (...entries: string[]): NodeJS.ProcessEnv => ({
    FAKE_DOMAIN_PRINT: domainPrint([SSH_AUTH_SOCK_ENTRY, ...entries]),
  });

  it('zmienna w tej powłoce → odmowa przed launchctl print gui/<uid> i przed restart.sh', () => {
    ready();
    for (const name of ['RAROG_DATA_DIR', 'XDG_DATA_HOME']) {
      fresh();
      const run = rarogRestart({ ...SERVICE_ONLY, [name]: path.join(sb.home.home, 'inny') });
      expect(run.stderr, name).toContain(`${name} is set in this shell`);
      expect(run.stderr, name).toContain('Run restart without this variable');
      expectRefusedBeforeScript(run, [print(SERVICE)], name);
    }
  });

  it('zmienna w bloku environment domeny gui/<uid> → odmowa z launchctl unsetenv w Terminal.app poza herdr', () => {
    ready();
    for (const name of ['RAROG_DATA_DIR', 'XDG_DATA_HOME']) {
      fresh();
      const run = rarogRestart({ ...SERVICE_ONLY, ...inDomain(`${name} => ${path.join(sb.home.home, 'inny')}`) });
      expect(run.stderr, name).toContain(`${name} is set in the launchd domain gui/${UID} (launchctl setenv)`);
      expect(run.stderr, name).toContain(`Remove it in Terminal.app on the Mac screen, outside herdr (launchctl`
        + ` managername = Aqua): launchctl unsetenv ${name} — from SSH, mosh and herdr, unsetenv reaches another domain`
        + ' (user/<uid>).');
      expectRefusedBeforeScript(run, [print(SERVICE), DOMAIN], name);
    }
  });

  // `resolveDataDir` bierze spację albo tabulator za katalog, więc to nie jest brak zmiennej.
  it('wartość z samych białych znaków w domenie launchd → odmowa', () => {
    ready();
    for (const value of [' ', '\t']) {
      fresh();
      const run = rarogRestart({ ...SERVICE_ONLY, ...inDomain(`RAROG_DATA_DIR => ${value}`) });
      expect(run.stderr, JSON.stringify(value)).toContain('RAROG_DATA_DIR is set in the launchd domain');
      expectRefusedBeforeScript(run, [print(SERVICE), DOMAIN], JSON.stringify(value));
    }
  });

  // Widoczny wpis rozstrzyga sam: linia spoza kształtu obok niego nie zamienia odmowy w ostrzeżenie.
  it('nasza zmienna obok linii spoza kształtu w bloku → odmowa, nie ostrzeżenie', () => {
    ready();
    const run = rarogRestart({ ...SERVICE_ONLY, ...inDomain('bez strzałki', 'XDG_DATA_HOME => /inne') });
    expect(run.stderr).toContain('XDG_DATA_HOME is set in the launchd domain');
    expect(run.stderr).not.toContain('not checked');
    expectRefusedBeforeScript(run, [print(SERVICE), DOMAIN], 'śmieci obok wpisu');
  });

  it('launchctl print gui/<uid> nie rozstrzyga (kod 5, sygnał, brak bloku, zła struktura, linia spoza kształtu) → ostrzeżenie, restart.sh rusza', () => {
    ready();
    const cases: [string, NodeJS.ProcessEnv, string][] = [
      ['kod', { FAKE_DOMAIN_FAIL: 'kod' }, `launchctl print gui/${UID}: exit status 5, Could not print domain: 5:`
        + ' Input/output error'],
      ['sygnał', { FAKE_DOMAIN_FAIL: 'sygnal' }, `launchctl print gui/${UID}: signal SIGKILL`],
      ['brak bloku', { FAKE_DOMAIN_PRINT: `gui/${UID} = {\n\ttype = gui\n}\n` },
        `launchctl print gui/${UID} output: no environment block`],
      ['pusty wydruk', { FAKE_DOMAIN_PRINT: '' }, `launchctl print gui/${UID} output: no environment block`],
      ['śmieci', inDomain('bez strzałki'),
        `launchctl print gui/${UID} output: line 6 of the environment block does not have the shape "NAME => value"`],
      // Zła struktura z naszą zmienną w środku to ostrzeżenie, nie odmowa.
      ['blok bez zamknięcia z RAROG_DATA_DIR', {
        FAKE_DOMAIN_PRINT: `gui/${UID} = {\n\tenvironment = {\n\t\tRAROG_DATA_DIR => /inny\n`,
      }, `launchctl print gui/${UID} output: environment block not closed`],
      ['dwa bloki, w jednym XDG_DATA_HOME', {
        FAKE_DOMAIN_PRINT: domainPrint([SSH_AUTH_SOCK_ENTRY]).replace('\tservices = {',
          '\tenvironment = {\n\t\tXDG_DATA_HOME => /inne\n\t}\n\tservices = {'),
      }, `launchctl print gui/${UID} output: environment block appears 2 times instead of once`],
    ];
    for (const [what, extra, why] of cases) {
      fresh();
      const run = rarogRestart({ ...SERVICE_ONLY, ...extra });
      expect(run.status, `${what}: ${run.stderr}`).toBe(0);
      expect(run.stderr, what).toContain(`rarog restart: WARNING, not checked: RAROG_DATA_DIR,`
        + ` XDG_DATA_HOME in the launchd domain gui/${UID} (${why}). Restart continues`);
      expect(run.stderr, what).toContain('after the start, rarog doctor shows');
      expect(sb.calls('launchctl'), what)
        .toEqual([print(SERVICE), DOMAIN, print(SERVICE), print(SERVICE), kickstart(SERVICE)]);
      expect(sb.calls('curl'), what).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
    }
  });

  it('pusta wartość w powłoce i w domenie launchd to brak zmiennej → restart jak bez niej', () => {
    ready();
    const run = rarogRestart({
      ...SERVICE_ONLY, RAROG_DATA_DIR: '', XDG_DATA_HOME: '', ...inDomain('RAROG_DATA_DIR => ', 'XDG_DATA_HOME =>'),
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).not.toContain('not checked');
    expect(sb.calls('launchctl'))
      .toEqual([print(SERVICE), DOMAIN, print(SERVICE), print(SERVICE), kickstart(SERVICE)]);
  });

  it('launchctl nieuruchamialny albo bez odpowiedzi w 10 s → ostrzeżenie „nie sprawdzone”, bez odmowy (EACCES, ETIMEDOUT)', () => {
    const warning = (env: NodeJS.ProcessEnv): string => {
      let stderr = '';
      const io: CliIo = { stdout: () => {}, stderr: (text) => { stderr += text; }, env, cwd: sb.home.home };
      refuseLaunchdDataDirEnv(io, 'restart');
      return stderr;
    };
    const launchctl = path.join(sb.bin, 'launchctl');
    chmodSync(launchctl, 0o644);
    expect(warning(sb.env({ ...SERVICE_ONLY, PATH: sb.bin }))).toContain(`not checked: RAROG_DATA_DIR,`
      + ` XDG_DATA_HOME in the launchd domain gui/${UID} (launchctl print gui/${UID}: spawnSync launchctl EACCES)`);
    writeFileSync(launchctl, '#!/bin/bash\nexec sleep 30\n');
    chmodSync(launchctl, 0o755);
    expect(warning(sb.env(SERVICE_ONLY))).toContain(`(launchctl print gui/${UID}: spawnSync launchctl ETIMEDOUT)`);
  });
});

describe('parseDomainEnvironment: blok environment z wydruku launchctl print gui/<uid>', () => {
  /** Wydruk w kształcie pomiaru (macOS 27.0.1): pola domeny z jednym tabulatorem, blok i inne bloki obok. */
  const measured = (block: readonly string[], before: readonly string[] = [], after: readonly string[] = []): string =>
    [
      'gui/501 = {', '\ttype = gui', '\thandle = 501', ...before, ...block, ...after,
      '\tservices = {', '\t\t       0      -     ai.rarog.server', '\t}', '}', '',
    ].join('\n');
  const block = (...entries: string[]): string[] => ['\tenvironment = {', ...entries.map((e) => `\t\t${e}`), '\t}'];

  it('blok z dwoma wpisami (pomiar: zmienna z setenv w kontekście Aqua i gniazdo agenta SSH)', () => {
    expect(parseDomainEnvironment(measured(block('RAROG_SONDA => 1', SSH_AUTH_SOCK_ENTRY)))).toEqual({
      entries: [['RAROG_SONDA', '1'], ['SSH_AUTH_SOCK', '/private/tmp/com.apple.launchd.AbCdEf1234/Listeners']],
      issue: null,
    });
  });

  it('blok pusty: bez wpisów, rozstrzyga', () => {
    expect(parseDomainEnvironment(measured(block()))).toEqual({ entries: [], issue: null });
  });

  it('brak bloku (także pusty wydruk) → powód', () => {
    expect(parseDomainEnvironment(measured([]))).toEqual({ entries: [], issue: 'no environment block' });
    expect(parseDomainEnvironment('')).toEqual({ entries: [], issue: 'no environment block' });
  });

  it('bloki z innym wcięciem i inne nazwy obok się nie liczą', () => {
    const nested = ['\tsubdomain = {', '\t\tenvironment = {', '\t\t\tRAROG_DATA_DIR => /zagniezdzone', '\t\t}', '\t}'];
    const inherited = ['\tinherited environment = {', '\t\tXDG_DATA_HOME => /odziedziczone', '\t}'];
    expect(parseDomainEnvironment(measured(block('RAROG_SONDA => 1'), nested, inherited))).toEqual({
      entries: [['RAROG_SONDA', '1']], issue: null,
    });
    // Sam blok o innym wcięciu to brak bloku domeny.
    expect(parseDomainEnvironment(measured([], nested)).issue).toBe('no environment block');
  });

  it('wartość ze spacją i z `=>` w środku, sama spacja, tabulator, pusta (ze spacją po `=>` i bez)', () => {
    const parsed = parseDomainEnvironment(measured(block(
      'RAROG_DATA_DIR => /a b => c', 'A =>  ', 'B => \t', 'C => ', 'D =>', 'Z NAZWĄ ZE SPACJĄ => x', 'E => a\rb',
    )));
    expect(parsed).toEqual({
      entries: [
        ['RAROG_DATA_DIR', '/a b => c'], ['A', ' '], ['B', '\t'], ['C', ''], ['D', ''], ['Z NAZWĄ ZE SPACJĄ', 'x'],
        ['E', 'a\rb'],
      ],
      issue: null,
    });
  });

  it('linia spoza kształtu w bloku → powód z numerem linii, bez jej treści; wpisy obok zostają', () => {
    const parsed = parseDomainEnvironment(measured(block(
      'RAROG_DATA_DIR => /x', 'TAJNY_TOKEN=nie-drukuj', '=> bez nazwy', '\tjeden tabulator za dużo => 1',
    )));
    expect(parsed.entries).toEqual([['RAROG_DATA_DIR', '/x']]);
    expect(parsed.issue).toBe('line 6 of the environment block does not have the shape "NAME => value"');
    expect(parsed.issue).not.toContain('nie-drukuj');
  });

  // Przy złej strukturze nie wiadomo, które wpisy są domeny, więc żaden nie rozstrzyga (odmowy).
  it('blok bez zamknięcia i dwa bloki → powód i żadnych wpisów', () => {
    expect(parseDomainEnvironment('gui/501 = {\n\tenvironment = {\n\t\tRAROG_DATA_DIR => /x\n')).toEqual({
      entries: [], issue: 'environment block not closed',
    });
    expect(parseDomainEnvironment(measured([...block('RAROG_DATA_DIR => /x'), ...block('B => 2')]))).toEqual({
      entries: [], issue: 'environment block appears 2 times instead of once',
    });
  });
});

describe('loadState: jedna reguła stanu etykiety', () => {
  const ioOf = (extra: NodeJS.ProcessEnv = {}): CliIo => ({
    stdout: () => {}, stderr: () => {}, env: sb.env(extra), cwd: sb.home.home,
  });

  it('0 = załadowana, 113 = brak, inny kod = „nie wiem” z kodem i pierwszą linią stderr', () => {
    expect(loadState(SERVICE, ioOf({ FAKE_LOADED: SERVICE }), 'darwin')).toBe('loaded');
    expect(loadState(SERVICE, ioOf({ FAKE_LOADED: 'com.example.inna' }), 'darwin')).toBe('absent');
    expect(loadState(SERVICE, ioOf({ FAKE_UNKNOWN: SERVICE }), 'darwin'))
      .toEqual({ unknown: 'exit status 5, Could not print: 5: Input/output error' });
    expect(sb.calls('launchctl')).toEqual([print(SERVICE), print(SERVICE), print(SERVICE)]);
  });

  it('launchctl zabity sygnałem albo niewykonywalny = „nie wiem”', () => {
    writeFileSync(path.join(sb.bin, 'launchctl'), '#!/bin/bash\nkill -KILL $$\n');
    expect(loadState(SERVICE, ioOf(), 'darwin')).toEqual({ unknown: 'signal SIGKILL' });
    chmodSync(path.join(sb.bin, 'launchctl'), 0o644);
    const state = loadState(SERVICE, ioOf({ PATH: sb.bin }), 'darwin');
    expect(typeof state === 'object' ? state.unknown : state).toContain('EACCES');
  });

  // Timeout to też „nie wiem”, nie brak (sufit `loadState` to 10 s).
  it('launchctl nie odpowiada w 10 s = „nie wiem” (ETIMEDOUT)', { timeout: 30_000 }, () => {
    writeFileSync(path.join(sb.bin, 'launchctl'), '#!/bin/bash\nexec sleep 30\n');
    const state = loadState(SERVICE, ioOf(), 'darwin');
    expect(typeof state === 'object' ? state.unknown : state).toContain('ETIMEDOUT');
  });

  it('bez launchctl w PATH (ENOENT) i poza macOS = brak; poza macOS bez pytania launchctl', () => {
    const empty = path.join(sb.home.home, 'pusty');
    mkdirSync(empty);
    expect(loadState(SERVICE, ioOf({ PATH: empty }), 'darwin')).toBe('absent');
    expect(loadState(SERVICE, ioOf({ FAKE_LOADED: SERVICE, FAKE_UNKNOWN: SERVICE }), 'linux')).toBe('absent');
    expect(sb.calls('launchctl')).toEqual([]);
  });
});

describe('blokada: przejęcie martwej', () => {
  const deadPid = async (): Promise<number> => {
    const child = spawn('true');
    await new Promise((resolve) => { child.on('exit', resolve); });
    return child.pid ?? 0;
  };
  const refusalOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (failure) {
      if (failure instanceof Refusal) return failure.message;
      throw failure;
    }
    return '';
  };

  it('martwa blokada: przejęta, plik przejęcia sprzątnięty, zwolnienie kasuje tylko naszą', async () => {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(lockFile(), `${String(await deadPid())}\n`);
    const lock = acquireLock(configDir(), 'test');
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${String(process.pid)}\n`);
    expect(existsSync(`${lockFile()}${TAKEOVER_SUFFIX}`)).toBe(false);
    lock.release();
    expect(existsSync(lockFile())).toBe(false);
  });

  it('ktoś żywy przejął martwą blokadę między odczytem a przejęciem → odmowa, jego blokada zostaje', async () => {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(lockFile(), `${String(await deadPid())}\n`);
    // Rodzic procesu testów żyje i nie jest nami — stoi tu za „drugie wywołanie, które było szybsze”.
    const other = `${String(process.ppid)}\n`;
    const message = refusalOf(() => acquireLock(configDir(), 'test', Date.now, {
      afterStaleRead: () => { writeFileSync(lockFile(), other); },
    }));
    expect(message).toContain(`another call is running (PID ${String(process.ppid)}`);
    expect(readFileSync(lockFile(), 'utf8')).toBe(other);
    expect(existsSync(`${lockFile()}${TAKEOVER_SUFFIX}`)).toBe(false);
  });

  it('plik przejęcia żywego procesu → odmowa; martwego → przejęty', async () => {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const dead = `${String(await deadPid())}\n`;
    writeFileSync(lockFile(), dead);
    writeFileSync(`${lockFile()}${TAKEOVER_SUFFIX}`, `${String(process.ppid)}\n`);
    expect(refusalOf(() => acquireLock(configDir(), 'test'))).toContain('another process is taking over the dead lock');
    expect(readFileSync(lockFile(), 'utf8')).toBe(dead);
    writeFileSync(`${lockFile()}${TAKEOVER_SUFFIX}`, dead);
    const lock = acquireLock(configDir(), 'test');
    expect(readFileSync(lockFile(), 'utf8')).toBe(`${String(process.pid)}\n`);
    expect(existsSync(`${lockFile()}${TAKEOVER_SUFFIX}`)).toBe(false);
    lock.release();
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog restart: blokada', 'launchd'), { timeout: 30_000 }, () => {
  /** Konfiguracja, plist i węzeł usługi poprawne: restart przy załadowanej usłudze przechodzi. */
  const ready = (): void => {
    writeConfig(OWNER_CONFIG);
    writeServicePlist(serviceNode('v22.22.3'));
  };

  it('blokada żywego procesu → odmowa z jego PID-em, launchctl nietknięty; martwego → zdjęta', async () => {
    ready();
    writeFileSync(lockFile(), `${String(process.pid)}\n`);
    let run = rarogRestart(SERVICE_ONLY);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`another call is running (PID ${String(process.pid)}`);
    expect(sb.calls('launchctl')).toEqual([]);

    const dead = spawn('true');
    await new Promise((resolve) => { dead.on('exit', resolve); });
    writeFileSync(lockFile(), `${String(dead.pid)}\n`);
    run = rarogRestart(SERVICE_ONLY);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('Ctrl-C (SIGINT) while restart.sh runs: SIGTERM to it once, the lock stays until it ended, exit 130', async () => {
    ready();
    const script = fakeRestartScript(sb.home.home, lockFile());
    const env = sb.env({ ...SERVICE_ONLY, PATH: `${script.dir}:${sb.bin}:/usr/bin:/bin` });
    const child = spawn(process.execPath, [CLI, 'restart'], {
      cwd: sb.home.home, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const closed = new Promise<number | null>((resolve) => { child.on('close', resolve); });
    try {
      await script.started();
      expect(existsSync(lockFile())).toBe(true);
      child.kill('SIGINT');
      expect(await closed).toBe(130);
      expect(script.events()).toEqual(['started', 'got TERM', 'lock held', 'cleanup done']);
      expect(existsSync(lockFile())).toBe(false);
      expect(stderr).toContain('rarog restart: restart.sh was interrupted (Ctrl-C) and stopped.');
    } finally {
      child.kill('SIGKILL');
      script.kill();
    }
  });

  it('brak katalogu konfiguracji → blokada zakłada go z prawami 0700 (restart potem odmawia bez config.json)', () => {
    const run = rarogRestart({ FAKE_LOADED: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`no ${SERVICE} service and no`);
    expect((statSync(configDir()).mode & 0o777).toString(8)).toBe('700');
    expect(existsSync(lockFile())).toBe(false);
  });

  it('dwa wywołania naraz: drugie odmawia z PID-em pierwszego, pierwsze kończy restart', async () => {
    ready();
    const first = spawn(process.execPath, [CLI, 'restart'], {
      cwd: sb.home.home, env: sb.env({ ...SERVICE_ONLY, FAKE_KICKSTART_SLEEP: '3' }), stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => { first.on('exit', resolve); });
    try {
      for (let i = 0; i < 100 && !existsSync(lockFile()); i += 1) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(lockFile())).toBe(true);
      const second = rarogRestart(SERVICE_ONLY);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain(`another call is running (PID ${String(first.pid)}`);
      expect(await exited).toBe(0);
      expect(sb.calls('launchctl').filter((call) => call.startsWith('kickstart'))).toEqual([kickstart(SERVICE)]);
      expect(existsSync(lockFile())).toBe(false);
    } finally {
      first.kill('SIGKILL');
    }
  });
});

describe('restart.sh: parametry i odmowa wprost', { timeout: 30_000 }, () => {
  const LOG = (): string => path.join(sb.home.home, 'server.log');

  it.skipIf(!IS_MAC)(macOnly('wprost bez parametrów → odmowa „uruchom pnpm run restart”, nic nie zapytane ani zatrzymane', 'launchd'), () => {
    writeServicePlist(serviceNode('v22.22.3'));
    const run = restartScript({ FAKE_LOADED: SERVICE });
    expect(run.status).toBe(1);
    expect(run.stderr).toBe('restart.sh: this script runs under `rarog restart` — run `pnpm run restart` (rarog restart),'
      + ' which\nchecks the config and passes the parameters to this script. Nothing was stopped.\n');
    expect(sb.calls('launchctl')).toEqual([]);
    expect(sb.calls('curl')).toEqual([]);
    expect(sb.calls('nohup')).toEqual([]);
  });

  it.skipIf(!IS_MAC)(macOnly('z parametrami: etykieta i port z `rarog restart`, bez pytania o plik usługi', 'launchd'), () => {
    writeServicePlist(serviceNode('v22.22.3'));
    const run = restartScript({
      FAKE_LOADED: SERVICE, RAROG_RESTART_LABEL: SERVICE, RAROG_RESTART_PORT: PORT, RAROG_LOG: LOG(),
    });
    expect(run.status, run.stderr).toBe(0);
    expect(sb.calls('launchctl')).toEqual([print(SERVICE), print(SERVICE), kickstart(SERVICE)]);
    expect(sb.calls('curl')).toEqual([`-sf -m 5 http://127.0.0.1:${PORT}/health`]);
  });

  /**
   * `/health` says `herdr: false` for the first `falseCalls` answers, then the healthy body. `sleep` only logs, so
   * the retries cost no time.
   */
  function herdrLateFakes(falseCalls: number): void {
    const count = path.join(sb.logs, 'curl-count');
    const unhealthy = HEALTHY.replace('"herdr":true', '"herdr":false');
    writeFileSync(path.join(sb.bin, 'curl'), [
      '#!/bin/bash',
      `printf '%s\\n' "$*" >> '${sb.logs}/curl'`,
      `n=$(( $(cat '${count}' 2>/dev/null || echo 0) + 1 )); echo "$n" > '${count}'`,
      `if [ "$n" -le ${String(falseCalls)} ]; then printf '%s' '${unhealthy}'; else printf '%s' "$FAKE_HEALTH"; fi`,
      '',
    ].join('\n'));
    writeFileSync(path.join(sb.bin, 'sleep'), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${sb.logs}/sleep'\n`);
    chmodSync(path.join(sb.bin, 'curl'), 0o755);
    chmodSync(path.join(sb.bin, 'sleep'), 0o755);
  }
  const launchdParams = (): NodeJS.ProcessEnv => ({
    FAKE_LOADED: SERVICE, RAROG_RESTART_LABEL: SERVICE, RAROG_RESTART_PORT: PORT, RAROG_LOG: LOG(),
  });
  const HEALTH_CALL = `-sf -m 5 http://127.0.0.1:${PORT}/health`;

  it.skipIf(!IS_MAC)(macOnly('herdr false on the first /health of a busy start, true a moment later → retry, exit 0', 'launchd'), () => {
    writeServicePlist(serviceNode('v22.22.3'));
    herdrLateFakes(3);
    const run = restartScript(launchdParams());
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('herdr: false on the first /health — retrying for up to 10 s');
    expect(run.stdout).toContain('herdr: true · term: true');
    expect(sb.calls('curl')).toEqual(Array<string>(4).fill(HEALTH_CALL));
  });

  it.skipIf(!IS_MAC)(macOnly('herdr false on every /health → exit 2 after the retries', 'launchd'), () => {
    writeServicePlist(serviceNode('v22.22.3'));
    herdrLateFakes(1000);
    const run = restartScript(launchdParams());
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('ERROR: Rarog is up, but the herdr socket does not respond');
    expect(sb.calls('curl')).toEqual(Array<string>(11).fill(HEALTH_CALL));
  });

  it.skipIf(!IS_MAC)(macOnly('etykieta usługi, która nie jest załadowana → błąd przed zatrzymaniem, bez nohup obok plistu', 'launchd'), () => {
    const run = restartScript({
      FAKE_LOADED: '', RAROG_RESTART_LABEL: SERVICE, RAROG_RESTART_PORT: PORT, RAROG_LOG: LOG(),
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toBe(`ERROR: service gui/${UID}/${SERVICE} is not loaded (no nohup start next to the service).`
      + ` Check:\nlaunchctl print gui/${UID}/${SERVICE}, then pnpm run restart. Nothing was stopped.\n`);
    expect(sb.calls('launchctl')).toEqual([print(SERVICE)]);
    expect(sb.calls('lsof')).toEqual([]);
    expect(sb.calls('pgrep')).toEqual([]);
    expect(sb.calls('nohup')).toEqual([]);
    expect(sb.calls('curl')).toEqual([]);
  });

  it.skipIf(!IS_MAC)(macOnly('brak portu, logu albo zdania naprawy hooka = 64, zanim cokolwiek zostanie zapytane albo zatrzymane', 'launchd'), () => {
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ RAROG_RESTART_LABEL: SERVICE, RAROG_LOG: LOG() }, 'RAROG_RESTART_PORT'],
      [{ RAROG_RESTART_SERVE: 'rarog', RAROG_LOG: LOG() }, 'RAROG_RESTART_PORT'],
      [{ RAROG_RESTART_LABEL: SERVICE, RAROG_RESTART_PORT: PORT }, 'RAROG_LOG'],
      [{
        RAROG_RESTART_LABEL: SERVICE, RAROG_RESTART_PORT: PORT, RAROG_LOG: LOG(), RAROG_RESTART_HOOK_REPAIR: undefined,
      }, 'RAROG_RESTART_HOOK_REPAIR'],
      [{ RAROG_RESTART_SERVE: 'rarog', RAROG_RESTART_PORT: PORT, RAROG_LOG: LOG(), RAROG_RESTART_HOOK_REPAIR: '' },
        'RAROG_RESTART_HOOK_REPAIR'],
    ];
    for (const [params, missing] of cases) {
      const run = restartScript({ FAKE_LOADED: SERVICE, ...params });
      expect(run.status, JSON.stringify(params)).toBe(64);
      expect(run.stderr).toBe(`restart.sh: missing parameter ${missing} — only \`rarog restart\` (pnpm run restart)`
        + ' sets it.\n');
      expect(sb.calls('launchctl')).toEqual([]);
      expect(sb.calls('nohup')).toEqual([]);
    }
  });

  it('zła wartość parametru albo etykieta razem z SERVE = 64, zanim cokolwiek zostanie zapytane albo zatrzymane', () => {
    const cases: Record<string, string>[] = [
      { RAROG_RESTART_LABEL: 'com.obcy.agent' },
      { RAROG_RESTART_LABEL: `${SERVICE};id` },
      { RAROG_RESTART_PORT: '0' },
      { RAROG_RESTART_PORT: '08930' },
      { RAROG_RESTART_PORT: '70000' },
      { RAROG_RESTART_PORT: '123456' },
      { RAROG_RESTART_PORT: '89 30' },
      { RAROG_RESTART_SERVE: 'nohup' },
      { RAROG_RESTART_SERVE: 'bash -c id' },
      // Zdanie naprawy hooka jest tylko wypisywane: nowa linia, sekwencja terminala i zdanie ponad 300 znaków = 64.
      { RAROG_RESTART_HOOK_REPAIR: 'napraw\nid' },
      { RAROG_RESTART_HOOK_REPAIR: 'napraw \u001b[2J' },
      { RAROG_RESTART_HOOK_REPAIR: 'x'.repeat(301) },
    ];
    for (const params of cases) {
      const run = restartScript({ FAKE_LOADED: SERVICE, ...params });
      expect(run.status, JSON.stringify(params)).toBe(64);
      expect(run.stderr).toContain(`bad parameter ${Object.keys(params)[0] ?? ''}`);
      expect(sb.calls('launchctl')).toEqual([]);
    }
    const both = restartScript({
      FAKE_LOADED: SERVICE, RAROG_RESTART_LABEL: SERVICE, RAROG_RESTART_SERVE: 'rarog', RAROG_RESTART_PORT: PORT,
      RAROG_LOG: LOG(),
    });
    expect(both.status).toBe(64);
    expect(both.stderr).toContain('RAROG_RESTART_LABEL and RAROG_RESTART_SERVE exclude each other');
    expect(sb.calls('launchctl')).toEqual([]);
  });
});

/*
 * Krok stopu `restart.sh` przy nadzorcy: launchd (`KeepAlive`) wskrzesza serwer zaraz po jego wyjściu, więc „ktoś
 * słucha na porcie” nic nie mówi o starym procesie. Skrypt czeka tylko na PID-y, którym wysłał SIGTERM, i tylko im
 * wysyła SIGKILL. Atrapa `lsof` pokazuje żywe PID-y z pliku stanu `nasluch`, a gdy żaden nie żyje — PID z pliku
 * `wskrzeszony` (instancja nadzorcy); pytanie o katalog roboczy (`-d cwd`) idzie do prawdziwego `lsof`. Atrapa
 * `pgrep` pokazuje żywe PID-y z pliku `wzorce`. Zabite dzieci testu są zombie do końca `spawnSync` (pętla zdarzeń
 * stoi), więc skrypt i atrapy liczą zombie jako proces, który wyszedł.
 */
describe.skipIf(!IS_MAC)(macOnly('restart.sh: stop czeka na PID-y, którym wysłał SIGTERM', 'launchd'), { timeout: 30_000 }, () => {
  const state = (): string => path.join(sb.home.home, 'stan');
  const LAUNCHD_PARAMS = (): NodeJS.ProcessEnv => ({
    FAKE_LOADED: SERVICE, RAROG_RESTART_LABEL: SERVICE, RAROG_RESTART_PORT: PORT,
    RAROG_LOG: path.join(sb.home.home, 'server.log'),
  });

  beforeEach(() => {
    mkdirSync(state());
    const alive = [
      'alive() {',
      '  for p in $(cat "$1" 2>/dev/null); do',
      '    st="$(/bin/ps -p "$p" -o stat= 2>/dev/null || true)"',
      '    case "$st" in \'\'|Z*) ;; *) echo "$p" ;; esac',
      '  done',
      '}',
    ];
    const write = (name: string, lines: string[]): void => {
      writeFileSync(path.join(sb.bin, name), `#!/bin/bash\n${lines.join('\n')}\n`);
      chmodSync(path.join(sb.bin, name), 0o755);
    };
    write('lsof', [
      `printf '%s\\n' "$*" >> '${sb.logs}/lsof'`,
      'case " $* " in *" -d cwd "*) exec /usr/sbin/lsof "$@" ;; esac',
      ...alive,
      `out="$(alive '${state()}/nasluch')"`,
      `[ -n "$out" ] || out="$(alive '${state()}/wskrzeszony')"`,
      '[ -z "$out" ] || printf \'%s\\n\' "$out"',
    ]);
    write('pgrep', [
      `printf '%s\\n' "$*" >> '${sb.logs}/pgrep'`,
      ...alive,
      `out="$(alive '${state()}/wzorce')"`,
      '[ -n "$out" ] || exit 1',
      'printf \'%s\\n\' "$out"',
    ]);
  });

  const setState = (name: string, ...pids: number[]): void => {
    writeFileSync(path.join(state(), name), pids.map(String).join(' '));
  };

  interface Server { readonly pid: number; readonly exited: Promise<string | null>; alive(): boolean; kill(): void }

  /** Proces w katalogu roboczym tej instalacji (jak serwer po `rarog serve`); `stubborn` ignoruje SIGTERM. */
  async function serverProcess(stubborn = false, env: NodeJS.ProcessEnv = {}): Promise<Server> {
    const code = `${stubborn ? "process.on('SIGTERM', () => {}); " : ''}`
      + "process.stdout.write('ready'); setInterval(() => {}, 1000);";
    const child = spawn(process.execPath, ['-e', code], {
      cwd: REPO, env: { PATH: '/usr/bin:/bin', ...env }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = new Promise<string | null>((resolve) => { child.on('exit', (_code, signal) => { resolve(signal); }); });
    // Gotowość: dopiero po niej `stubborn` ma już obsługę SIGTERM.
    await new Promise((resolve) => { child.stdout.once('data', resolve); });
    const pid = child.pid ?? 0;
    return {
      pid, exited,
      // Stan z `ps`, nie z `child.signalCode`: tuż po `spawnSync` pętla zdarzeń nie zdążyła odebrać wyjścia dziecka.
      alive: () => {
        const stat = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
        return stat !== '' && !stat.includes('Z');
      },
      kill: () => { child.kill('SIGKILL'); },
    };
  }

  function launchdRestart(): Run {
    return restartScript(LAUNCHD_PARAMS());
  }

  const kickstarts = (): string[] => sb.calls('launchctl').filter((call) => call.startsWith('kickstart'));
  const SIGKILL_LINE = 'did not exit after SIGTERM';

  it('stary PID wychodzi po SIGTERM, nadzorca od razu wskrzesza nowy → bez SIGKILL, nowy nietknięty, kickstart raz', async () => {
    const old = await serverProcess();
    const revived = await serverProcess();
    setState('nasluch', old.pid);
    setState('wskrzeszony', revived.pid);
    try {
      const run = launchdRestart();
      expect(run.stderr).not.toContain(SIGKILL_LINE);
      expect(run.status, run.stderr).toBe(0);
      expect(await old.exited).toBe('SIGTERM');
      expect(revived.alive()).toBe(true);
      expect(kickstarts()).toEqual([kickstart(SERVICE)]);
    } finally {
      old.kill();
      revived.kill();
    }
  });

  it('stary PID ignoruje SIGTERM → komunikat, SIGKILL dokładnie do niego, potem kickstart raz', async () => {
    const old = await serverProcess(true);
    const revived = await serverProcess();
    setState('nasluch', old.pid);
    setState('wskrzeszony', revived.pid);
    try {
      const run = launchdRestart();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toBe('Server did not exit after SIGTERM — sending SIGKILL.\n');
      expect(await old.exited).toBe('SIGKILL');
      // Wskrzeszony pojawia się na porcie dopiero po SIGKILL starego: sygnału od kroku stopu nie dostaje.
      expect(revived.alive()).toBe(true);
      expect(kickstarts()).toEqual([kickstart(SERVICE)]);
    } finally {
      old.kill();
      revived.kill();
    }
  });

  it('dwa stare PID-y (nasłuch i wzorzec), nasłuch wychodzi, wzorzec nie → SIGKILL tylko do żywego', async () => {
    const listener = await serverProcess();
    const caught = await serverProcess(true);
    const revived = await serverProcess();
    setState('nasluch', listener.pid);
    setState('wzorce', caught.pid);
    setState('wskrzeszony', revived.pid);
    try {
      const run = launchdRestart();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toBe('Server did not exit after SIGTERM — sending SIGKILL.\n');
      expect(await listener.exited).toBe('SIGTERM');
      expect(await caught.exited).toBe('SIGKILL');
      expect(revived.alive()).toBe(true);
      expect(kickstarts()).toEqual([kickstart(SERVICE)]);
    } finally {
      listener.kill();
      caught.kill();
      revived.kill();
    }
  });

  it('port changed in config.json: the service instance listens on the old port → stopped by its launchd PID', async () => {
    // The old server has the old `RAROG_PORT` in its environment and listens on the old port: neither the port nor
    // the argv patterns find it. `kickstart` without `-k` leaves a running instance alone, so only its PID from
    // `launchctl print` stops it.
    const old = await serverProcess(false, { RAROG_PORT: String(Number(PORT) + 1) });
    setState('wzorce', old.pid);
    try {
      const run = restartScript({ ...LAUNCHD_PARAMS(), FAKE_SERVICE_PID: String(old.pid) });
      expect(run.status, run.stderr).toBe(0);
      expect(old.alive()).toBe(false);
      expect(await old.exited).toBe('SIGTERM');
      expect(kickstarts()).toEqual([kickstart(SERVICE)]);
    } finally {
      old.kill();
    }
  });

  it('`ps` zawodzi przy pytaniu o stan → uparty PID dalej liczy się jako żywy i dostaje SIGKILL', async () => {
    const old = await serverProcess(true);
    setState('nasluch', old.pid);
    const psFake = path.join(sb.bin, 'ps');
    writeFileSync(psFake, '#!/bin/bash\ncase " $* " in *" stat= "*) exit 1 ;; esac\nexec /bin/ps "$@"\n');
    chmodSync(psFake, 0o755);
    try {
      const run = launchdRestart();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toBe('Server did not exit after SIGTERM — sending SIGKILL.\n');
      expect(await old.exited).toBe('SIGKILL');
    } finally {
      old.kill();
    }
  });

  it('bez nadzorcy (nohup): serwer, który zaczął słuchać po pierwszym odczycie portu, też dostaje SIGKILL', async () => {
    const late = await serverProcess(true);
    setState('nasluch', late.pid);
    // Pierwsze pytanie o port nie widzi nikogo, kolejne widzą późny serwer.
    const lsofFake = path.join(sb.bin, 'lsof');
    const original = readFileSync(lsofFake, 'utf8').split('\n');
    const first = `if [[ " $* " == *" -ti "* ]] && [ "$(grep -c -- '-ti ' '${sb.logs}/lsof')" -eq 1 ]; then exit 0; fi`;
    writeFileSync(lsofFake, [...original.slice(0, 2), first, ...original.slice(2)].join('\n'));
    try {
      const run = restartScript({
        RAROG_RESTART_SERVE: 'rarog', RAROG_RESTART_PORT: PORT, RAROG_LOG: path.join(sb.home.home, 'server.log'),
      });
      expect(run.stderr).toContain(SIGKILL_LINE);
      expect(await late.exited).toBe('SIGKILL');
      expect(sb.calls('nohup')).toHaveLength(1);
      expect(kickstarts()).toEqual([]);
    } finally {
      late.kill();
    }
  });

  it('nikt nie słucha i nic nie pasuje do wzorców → bez czekania i bez komunikatu, kickstart raz', async () => {
    // Atrapa `sleep` zapisuje argumenty: krok czekania na wyjście śpi po 0,25 s, health po 0,5 s. Liczenie
    // wywołań zamiast czasu przebiegu, bo czas zależy od obciążenia maszyny.
    const sleepFake = path.join(sb.bin, 'sleep');
    writeFileSync(sleepFake, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${sb.logs}/sleep'\nexec /bin/sleep "$@"\n`);
    chmodSync(sleepFake, 0o755);
    const run = launchdRestart();
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(sb.calls('lsof')).toContain(`-ti tcp:${PORT} -sTCP:LISTEN`);
    expect(kickstarts()).toEqual([kickstart(SERVICE)]);
    expect(sb.calls('sleep')).toContain('0.5');
    expect(sb.calls('sleep')).not.toContain('0.25');
  });
});

describe('rarog restart: wywołanie', { timeout: 30_000 }, () => {
  it('`pnpm run restart` to `rarog restart`', () => {
    const scripts = (JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }).scripts;
    expect(scripts['restart']).toBe('node bin/rarog.mjs restart');
  });

  it('argument = złe wywołanie (64), `--help` = 0; w obu nic nie zapytane', () => {
    expect(rarogRestart({ FAKE_LOADED: SERVICE }, ['teraz']).status).toBe(64);
    const help = rarogRestart({ FAKE_LOADED: SERVICE }, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('rarog restart');
    expect(sb.calls('launchctl')).toEqual([]);
  });
});
