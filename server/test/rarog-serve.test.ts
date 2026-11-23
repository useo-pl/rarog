/**
 * `rarog serve`: środowisko serwera z `~/.config/rarog/config.json`,
 * pliku sekretów i flag, `--print-env`, `--check` na dwóch poziomach i start przez `process.execve`.
 *
 * Sprawdza: odmowy (brak konfiguracji, sekret, zmienna katalogu danych i systemowa w `config.json` albo `--env`, prawa
 * pliku sekretów), pierwszeństwo źródeł, to, że `TERM`, `NODE_OPTIONS` i obce klucze rodzica nie przechodzą (ani do
 * `--print-env`, ani do procesów serwera) i pełny start w trybie demo na wolnym porcie (dwa procesy, SIGTERM kończy
 * oba). Każdy test ma `HOME` i `XDG_DATA_HOME` w katalogu tymczasowym, a `afterAll` sprawdza, że prawdziwe katalogi
 * `rarog` właściciela nie powstały.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_ENV } from '../src/config-env.ts';
import { IROH_PACKAGE, irohModuleInfo, irohPlatform, openEndpoint } from '../src/iroh/adapter.ts';
import { main } from '../src/cli/main.ts';
import type { CliIo } from '../src/cli/io.ts';
import {
  CHECK_DATA_DIR_LABEL, CHECK_PORT_LABEL, IROH_PROBE_ENTRY, PROCESS_NAMES, SECRET_NAMES, buildServeEnv, checkServeEnv,
  probeIrohModule, servePath,
} from '../src/cli/serve.ts';
import type { IrohProbe } from '../src/cli/serve.ts';
import { checkValue } from '../src/cli/service.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'rarog.mjs');
/** Sztuczne wartości sekretów — prawdziwych testy nie znają. */
const FAKE_SECRET = 'TEST-ONLY-sekret-testu-xxxxxxxxxxxxxxxx';
const FAKE_SONIOX = 'sztuczny-klucz-dyktowania';
/** Wartość dawnego tokenu logowania: `RAROG_AUTH_TOKEN` jest dziś nazwą spoza rejestru. */
const FAKE_TOKEN = 'sztuczny-token-testu-0123456789abcdef';

let home: TempHome;
beforeEach(() => { home = tempHome('rarog-serve-'); });
afterEach(() => { home.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const configDir = (): string => path.join(home.home, '.config', 'rarog');

function writeConfig(value: unknown): string {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const file = path.join(configDir(), 'config.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

/** Plik sekretów z podanymi prawami (domyślnie poprawnymi). */
function writeSecrets(text: string, fileMode = 0o600, dirMode = 0o700): string {
  const dir = path.join(configDir(), 'secret');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, dirMode);
  const file = path.join(dir, 'private.env');
  writeFileSync(file, text);
  chmodSync(file, fileMode);
  return file;
}

/** Konfiguracja produkcyjna testu: wszystko, czego `loadConfig` wymaga poza sekretami. */
const BASE_ENV = { RAROG_ORIGINS: 'https://rarog.example.net' };

/** Środowisko rodzica: dom testu, śmieci, które NIE mogą przejść, bez sekretów. */
function parentEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: home.env['PATH'], HOME: home.home, XDG_DATA_HOME: path.join(home.home, 'xdg'),
    USER: 'tester', LOGNAME: 'tester', LANG: '', TMPDIR: path.join(home.home, 'tmp'),
    TERM: 'xterm-256color', OBCY_KLUCZ: 'nie-przechodzi', NODE_OPTIONS: '--max-old-space-size=4096',
    ...extra,
  };
  return env;
}

async function call(
  argv: readonly string[], env: NodeJS.ProcessEnv = parentEnv(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env, cwd: home.home,
  };
  const code = await main(['serve', ...argv], io);
  return { code, stdout, stderr };
}

/** `NAZWA=wartość` → mapa (wartość może zawierać `=`). */
function envMap(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const eq = line.indexOf('=');
    out.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return out;
}

describe('rarog serve: brak konfiguracji', () => {
  it('bez config.json i bez flag: odmowa „brak konfiguracji: rarog setup” w każdym trybie, kod 1', async () => {
    for (const argv of [[], ['--print-env'], ['--check']]) {
      const result = await call(argv);
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.stderr).toContain('no configuration');
      expect(result.stderr).toContain('rarog setup');
    }
    expect(existsSync(configDir())).toBe(false);
  });
});

describe('rarog serve --print-env', () => {
  it('środowisko z pliku, przepustki z domyślnymi, liczony PATH; TERM, NODE_OPTIONS i obce klucze nie przechodzą', async () => {
    writeConfig({ version: 1, env: { ...BASE_ENV, RAROG_TERM: '1' } });
    const result = await call(['--print-env'], parentEnv({ SHELL: '' }));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toEqual([...lines].sort());
    const env = envMap(result.stdout);
    expect(env.get('RAROG_ORIGINS')).toBe(BASE_ENV.RAROG_ORIGINS);
    expect(env.get('RAROG_TERM')).toBe('1');
    expect(env.get('HOME')).toBe(home.home);
    expect(env.get('SHELL')).toBe('/bin/zsh');
    expect(env.get('LANG')).toBe('en_US.UTF-8');
    expect(env.get('USER')).toBe('tester');
    expect(env.get('PATH')).toBe(servePath());
    for (const name of PROCESS_NAMES) expect(env.has(name), name).toBe(true);
    expect(env.get('RAROG_DATA_DIR')).toBe('');
    for (const name of SECRET_NAMES) expect(env.get(name), name).toBe('<unset>');
    for (const name of ['TERM', 'OBCY_KLUCZ', 'NODE_OPTIONS']) expect(env.has(name), name).toBe(false);
    // Wyłącznie nazwy z rejestru.
    for (const name of env.keys()) expect(Object.hasOwn(SERVER_ENV, name), name).toBe(true);
  });

  it('pierwszeństwo: flagi > rodzic > plik sekretów > config.json', async () => {
    writeConfig({ version: 1, env: { ...BASE_ENV, RAROG_TERM_MAX: '4', RAROG_PORT: '18930' } });
    writeSecrets(`# komentarz\n\nRAROG_APNS_KEY_ID=${FAKE_SECRET}\nSONIOX_API_KEY=${FAKE_SONIOX}\n`);
    const result = await call(
      ['--print-env', '--env', 'RAROG_TERM_MAX=12', '--port', '18999', '--data-dir', 'dane'],
      parentEnv({ RAROG_DATA_DIR: '/rodzic/dane', SONIOX_API_KEY: '' }),
    );
    expect(result.code, result.stderr).toBe(0);
    const env = envMap(result.stdout);
    expect(env.get('RAROG_TERM_MAX')).toBe('12');
    expect(env.get('RAROG_PORT')).toBe('18999');
    expect(env.get('RAROG_DATA_DIR')).toBe(path.join(home.home, 'dane'));
    expect(env.get('RAROG_APNS_KEY_ID')).toBe('<set>');
    // Nazwa obecna w rodzicu, choć pusta, wygrywa z plikiem (jak `${X+x}` w powłoce).
    expect(env.get('SONIOX_API_KEY')).toBe('<unset>');
    expect(result.stdout).not.toContain(FAKE_SECRET);
    expect(result.stdout).not.toContain(FAKE_SONIOX);
  });
});

describe('rarog serve: odmowy config.json', () => {
  const refused = async (config: unknown, needle: string): Promise<void> => {
    writeConfig(config);
    const result = await call(['--print-env']);
    expect(result.code, JSON.stringify(config)).toBe(1);
    expect(result.stderr).toContain(needle);
    expect(result.stdout).toBe('');
  };

  it('zmienna katalogu danych, sekret, zmienna systemowa i nazwa spoza rejestru — odmowa z nazwą klucza', async () => {
    for (const name of PROCESS_NAMES) await refused({ version: 1, env: { [name]: '/x' } }, `${name} in config.json`);
    for (const name of SECRET_NAMES) await refused({ version: 1, env: { [name]: 'x' } }, `${name} in config.json: this is a secret`);
    for (const name of ['TERM', 'PATH', 'HOME']) await refused({ version: 1, env: { [name]: 'x' } }, `${name} in config.json`);
    await refused({ version: 1, env: { RAROG_COS_NOWEGO: '1' } }, 'RAROG_COS_NOWEGO in config.json: name outside the server variable registry');
    await refused({ version: 1, env: { constructor: '1' } }, 'constructor in config.json: name outside the server variable registry');
  });

  it('format: version, wartości napisami, znane klucze, service.wrapper, JSON', async () => {
    await refused({ version: 2, env: {} }, 'version 2');
    await refused({ env: {} }, 'version missing');
    await refused({ version: 1, env: { RAROG_TERM: 1 } }, 'env.RAROG_TERM must be a string');
    await refused({ version: 1, env: [] }, 'env must be an object');
    await refused({ version: 1, inne: true }, 'unknown key "inne"');
    await refused({ version: 1, service: { wrapper: [] } }, 'service.wrapper must be a non-empty list');
    await refused({ version: 1, service: { wrapper: ['ok', ''] } }, 'service.wrapper must be a non-empty list');
    await refused({ version: 1, service: { start: 'x' } }, 'unknown key "service.start"');
    await refused('{"version": 1,', 'not valid JSON');
    await refused('[]', 'expected a JSON object');
  });

  it('zły JSON z sekretem bez cudzysłowu: komunikat bez fragmentu wejścia (V8 cytuje go w `JSON.parse`)', async () => {
    await refused(`{"version": 1, "env": {"SONIOX_API_KEY": ${FAKE_SECRET}}}`, 'not valid JSON');
    const result = await call(['--check']);
    expect(result.stderr).not.toContain(FAKE_SECRET.slice(0, 8));
  });

  it('znak NUL w wartości config.json albo pliku sekretów = odmowa przed startem, sama nazwa', async () => {
    writeConfig({ version: 1, env: { ...BASE_ENV, RAROG_AUTH_EPOCH: 'pierwsza\u0000druga' } });
    for (const mode of ['--check', '--print-env']) {
      const result = await call([mode], parentEnv({ SONIOX_API_KEY: FAKE_SECRET }));
      expect(result.code, mode).toBe(1);
      expect(result.stderr).toContain('RAROG_AUTH_EPOCH: the value contains a NUL character');
      expect(result.stderr).not.toContain('pierwsza');
    }
    writeConfig({ version: 1, env: BASE_ENV });
    writeSecrets(`SONIOX_API_KEY=${FAKE_SECRET}\u0000ogon\n`);
    const result = await call(['--check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SONIOX_API_KEY: the value contains a NUL character');
    expect(result.stderr).not.toContain(FAKE_SECRET);
    expect(result.stdout).toBe('');
  });

  it('config.json jako dowiązanie do pliku jest przyjęty (np. do repo z konfiguracją Maca)', async () => {
    const real = path.join(home.home, 'repo-config.json');
    writeFileSync(real, JSON.stringify({ version: 1, env: BASE_ENV }));
    mkdirSync(configDir(), { recursive: true });
    symlinkSync(real, path.join(configDir(), 'config.json'));
    const result = await call(['--print-env']);
    expect(result.code, result.stderr).toBe(0);
    expect(envMap(result.stdout).get('RAROG_ORIGINS')).toBe(BASE_ENV.RAROG_ORIGINS);
  });
});

describe('rarog serve: a withdrawn name (`RAROG_COMPANION_SPEECH`)', () => {
  it.each(['0', '1', 'on'])('`RAROG_COMPANION_SPEECH=%s` in config.json and in --env: accepted, dropped, check green',
    async (value) => {
      writeConfig({ version: 1, env: { ...BASE_ENV, RAROG_COMPANION_SPEECH: value } });
      const printed = await call(['--print-env', '--env', `RAROG_COMPANION_SPEECH=${value}`]);
      expect(printed.stderr).toBe('');
      expect(printed.code).toBe(0);
      expect(envMap(printed.stdout).has('RAROG_COMPANION_SPEECH')).toBe(false);
      const check = await call(['--check']);
      expect(check.stderr).toBe('');
      expect(check.code).toBe(0);
    });

  it('the server variable registry no longer has the name', () => {
    expect(Object.hasOwn(SERVER_ENV, 'RAROG_COMPANION_SPEECH')).toBe(false);
  });
});

describe('rarog serve: flagi', () => {
  it('`--env` z sekretem, zmienną katalogu danych, systemową albo spoza rejestru = złe wywołanie (64) bez wartości', async () => {
    writeConfig({ version: 1, env: BASE_ENV });
    for (const name of [...SECRET_NAMES, ...PROCESS_NAMES, 'TERM', 'RAROG_NIEZNANA']) {
      const result = await call(['--print-env', '--env', `${name}=wartosc-ktorej-nie-wolno-pokazac`]);
      expect(result.code, name).toBe(64);
      expect(result.stderr).toContain(`${name} in --env`);
      expect(result.stderr).not.toContain('wartosc-ktorej-nie-wolno-pokazac');
      expect(result.stdout).toBe('');
    }
  });

  it('złe wartości i sprzeczności flag = 64', async () => {
    writeConfig({ version: 1, env: BASE_ENV });
    for (const argv of [
      ['--port', 'abc'], ['--port', '0'], ['--port', '70000'], ['--port'], ['--env', 'BEZ_ROWNA'],
      ['--port', '1', '--env', 'RAROG_PORT=2'], ['--print-env', '--check'], ['--cos'], ['--data-dir', '1', '--data-dir', '2'],
    ]) {
      expect((await call(argv)).code, argv.join(' ')).toBe(64);
    }
  });
});

describe('rarog serve: plik sekretów', () => {
  beforeEach(() => { writeConfig({ version: 1, env: BASE_ENV }); });

  it('prawa inne niż 0600 w katalogu 0700 albo dowiązanie zamiast pliku = odmowa', async () => {
    writeSecrets(`SONIOX_API_KEY=${FAKE_SECRET}\n`, 0o644);
    let result = await call(['--print-env']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mode 644, required 600');
    writeSecrets(`SONIOX_API_KEY=${FAKE_SECRET}\n`, 0o600, 0o755);
    result = await call(['--print-env']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mode 755, required 700');
    const file = writeSecrets('', 0o600, 0o700);
    const real = path.join(home.home, 'prawdziwy.env');
    writeFileSync(real, `SONIOX_API_KEY=${FAKE_SECRET}\n`, { mode: 0o600 });
    execFileSync('rm', [file]);
    symlinkSync(real, file);
    result = await call(['--print-env']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('expected a regular file');
    for (const out of [result.stdout, result.stderr]) expect(out).not.toContain(FAKE_SECRET);
  });

  it('tylko sekrety z rejestru, bez powtórzeń; zła linia nie wypisuje swojej treści', async () => {
    const cases: [string, string][] = [
      ['RAROG_ORIGINS=https://x\n', 'RAROG_ORIGINS is not a secret'],
      ['RAROG_DATA_DIR=/x\n', 'RAROG_DATA_DIR is not a secret'],
      ['NIEZNANA_NAZWA=1\n', 'line 1: name outside the server secret registry'],
      [`# a\n${FAKE_SECRET}\n`, 'line 2: expected NAME=value'],
      [`SONIOX_API_KEY=${FAKE_SECRET}\nSONIOX_API_KEY=${FAKE_SECRET}\n`, 'line 2: SONIOX_API_KEY appears twice'],
    ];
    for (const [text, needle] of cases) {
      writeSecrets(text);
      const result = await call(['--print-env']);
      expect(result.code, needle).toBe(1);
      expect(result.stderr).toContain(needle);
      expect(result.stderr).not.toContain(FAKE_SECRET);
      expect(result.stderr).not.toContain('NIEZNANA_NAZWA');
    }
  });
});

describe('rarog serve --check', () => {
  it('bez sekretów, z service.wrapper: zielony, „sekrety: niesprawdzone”, bez ostrzeżeń APNs', async () => {
    writeConfig({
      version: 1, env: { ...BASE_ENV, RAROG_APNS_TEAM_ID: 'ABCDE12345', RAROG_APNS_TOPIC: 'ai.example.app' },
      service: { wrapper: ['/bin/echo', 'wrapper'] },
    });
    const result = await call(['--check']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('secrets: not checked (supplied by service.wrapper)');
    expect(result.stdout).not.toContain('apnsIssue');
    expect(result.stdout).toContain(`data directory: ${path.join(home.home, 'xdg', 'rarog')}`);
    expect(result.stdout.trimEnd().endsWith('OK')).toBe(true);
  });

  it('z sekretami: `loadConfig` na prawdziwym środowisku, `apnsIssue` i `pushRelayIssue` jako ostrzeżenia bez wartości', async () => {
    writeConfig({
      version: 1,
      env: {
        ...BASE_ENV, RAROG_APNS_TEAM_ID: 'ABCDE12345', RAROG_APNS_TOPIC: 'ai.example.app',
        RAROG_PUSH_RELAY_URL: 'http://push.example.net',
      },
    });
    const keyPath = path.join(home.home, 'brak-klucza.p8');
    writeSecrets(`SONIOX_API_KEY=${FAKE_SECRET}\nRAROG_APNS_KEY_PATH=${keyPath}\nRAROG_APNS_KEY_ID=ABCDEFGHIJ\n`);
    const result = await call(['--check']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'secrets: set SONIOX_API_KEY, RAROG_APNS_KEY_PATH, RAROG_APNS_KEY_ID; missing OPENAI_API_KEY, RAROG_IROH_KEY',
    );
    expect(result.stdout).toContain('warning apnsIssue: RAROG_APNS_KEY_PATH does not point to a readable file');
    expect(result.stdout).toContain('warning pushRelayIssue: RAROG_PUSH_RELAY_URL must be an https address');
    for (const value of [FAKE_SECRET, keyPath, 'ABCDEFGHIJ']) expect(result.stdout).not.toContain(value);
  });

  it('zła wartość w config.json = odmowa z kodem 1; bez sekretów i bez wrappera przechodzi (sekrety opcjonalne)', async () => {
    writeConfig({ version: 1, env: { ...BASE_ENV, RAROG_MAX_PANES: '0' }, service: { wrapper: ['w'] } });
    let result = await call(['--check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('RAROG_MAX_PANES must be an integer ≥ 1');
    writeConfig({ version: 1, env: BASE_ENV });
    result = await call(['--check']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('secrets: none (neither in the environment nor in the secrets file)');
  });

  it('a skipped RAROG_ORIGINS entry: green check with a warning line naming it, without secrets too', async () => {
    writeConfig({ version: 1, env: { RAROG_ORIGINS: `null, ${BASE_ENV.RAROG_ORIGINS}` } });
    const result = await call(['--check']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('warning RAROG_ORIGINS: skipped "null"');
    expect(result.stdout).not.toContain(`skipped "${BASE_ENV.RAROG_ORIGINS}"`);
  });

  it('linie katalogu danych i portu: `checkValue` z `service install` czyta z nich wartości tej konfiguracji', async () => {
    writeConfig({ version: 1, env: { ...BASE_ENV, RAROG_PORT: '8931' } });
    const result = await call(['--check']);
    expect(result.code, result.stderr).toBe(0);
    expect(checkValue(result.stdout, CHECK_DATA_DIR_LABEL)).toBe(path.join(home.home, 'xdg', 'rarog'));
    expect(checkValue(result.stdout, CHECK_PORT_LABEL)).toBe('8931');
  });
});

/**
 * Logowania tokenem nie ma: `RAROG_AUTH_TOKEN` jest nazwą spoza rejestru. W pliku sekretów, w `config.json`
 * i w `--env` to odmowa bez wartości, a ze środowiska rodzica nie przechodzi do serwera (jak każdy obcy klucz).
 */
describe('rarog serve: RAROG_AUTH_TOKEN spoza rejestru', () => {
  it('w pliku sekretów: odmowa „nazwa spoza rejestru sekretów serwera” z numerem linii, bez wartości', async () => {
    writeConfig({ version: 1, env: BASE_ENV });
    writeSecrets(`SONIOX_API_KEY=${FAKE_SONIOX}\nRAROG_AUTH_TOKEN=${FAKE_TOKEN}\n`);
    for (const mode of ['--check', '--print-env']) {
      const result = await call([mode]);
      expect(result.code, mode).toBe(1);
      expect(result.stderr).toContain('private.env, line 2: name outside the server secret registry.');
      for (const out of [result.stdout, result.stderr]) {
        expect(out).not.toContain(FAKE_TOKEN);
        expect(out).not.toContain(FAKE_SONIOX);
      }
    }
  });

  it('w config.json i w --env: odmowa „nazwa spoza rejestru zmiennych serwera”, bez wartości', async () => {
    writeConfig({ version: 1, env: { ...BASE_ENV, RAROG_AUTH_TOKEN: FAKE_TOKEN } });
    for (const mode of ['--check', '--print-env']) {
      const result = await call([mode]);
      expect(result.code, mode).toBe(1);
      expect(result.stderr).toContain('RAROG_AUTH_TOKEN in config.json: name outside the server variable registry');
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(FAKE_TOKEN);
    }
    writeConfig({ version: 1, env: BASE_ENV });
    const flag = await call(['--print-env', '--env', `RAROG_AUTH_TOKEN=${FAKE_TOKEN}`]);
    expect(flag.code).toBe(64);
    // A bad argument wraps at the screen width.
    expect(flag.stderr.replace(/\s+/gu, ' '))
      .toContain('RAROG_AUTH_TOKEN in --env: name outside the server variable registry');
    expect(flag.stdout).toBe('');
    expect(flag.stderr).not.toContain(FAKE_TOKEN);
  });

  it('w środowisku rodzica: nie przechodzi do środowiska serwera, --check zielony bez sekretów', async () => {
    writeConfig({ version: 1, env: BASE_ENV });
    const printed = await call(['--print-env'], parentEnv({ RAROG_AUTH_TOKEN: FAKE_TOKEN }));
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stderr).toBe('');
    expect(envMap(printed.stdout).has('RAROG_AUTH_TOKEN')).toBe(false);
    expect(printed.stdout).not.toContain('RAROG_AUTH_TOKEN');
    expect(printed.stdout).not.toContain(FAKE_TOKEN);
    const checked = await call(['--check'], parentEnv({ RAROG_AUTH_TOKEN: FAKE_TOKEN }));
    expect(checked.stderr).toBe('');
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain('secrets: none (neither in the environment nor in the secrets file)');
    expect(checked.stdout).not.toContain('RAROG_AUTH_TOKEN');
    expect(checked.stdout).not.toContain(FAKE_TOKEN);
  });
});

/** Nasłuch iroh: klucz jest sekretem, więc przychodzi z pliku sekretów, z powłoki albo z `service.wrapper`. */
describe('rarog serve --check: nasłuch iroh', () => {
  const IROH = { ...BASE_ENV, RAROG_IROH: '1', RAROG_IROH_RELAY: 'https://relay.example./' };
  const FAKE_IROH_KEY = 'ab'.repeat(32);

  it('bez sekretów, z service.wrapper: zielony, „klucz iroh: niesprawdzony” obok „sekrety: niesprawdzone”', async () => {
    writeConfig({ version: 1, env: IROH, service: { wrapper: ['/bin/echo', 'wrapper'] } });
    const result = await call(['--check']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('secrets: not checked (supplied by service.wrapper)');
    expect(result.stdout).toContain('iroh key: not checked (supplied by service.wrapper)');
  });

  it('bez klucza i bez wrappera albo z innymi sekretami: odmowa z drogą klucza', async () => {
    writeConfig({ version: 1, env: IROH });
    let result = await call(['--check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('rarog serve --check: RAROG_IROH=1 without RAROG_IROH_KEY');
    expect(result.stderr).toContain('openssl rand -hex 32');
    writeConfig({ version: 1, env: IROH, service: { wrapper: ['/bin/echo', 'wrapper'] } });
    writeSecrets(`SONIOX_API_KEY=${FAKE_SECRET}\n`);
    result = await call(['--check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('RAROG_IROH=1 without RAROG_IROH_KEY');
    expect(result.stdout).not.toContain('iroh key: not checked');
  });

  it('klucz w pliku sekretów: zielony, w `--print-env` jako `<ustawione>`, wartość nigdzie', async () => {
    writeConfig({ version: 1, env: IROH });
    writeSecrets(`RAROG_IROH_KEY=${FAKE_IROH_KEY}\n`);
    const result = await call(['--check']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/secrets: set RAROG_IROH_KEY;/);
    expect(result.stdout).not.toContain('iroh key: not checked');
    const printed = await call(['--print-env']);
    expect(envMap(printed.stdout).get('RAROG_IROH_KEY')).toBe('<set>');
    for (const text of [result.stdout, printed.stdout, printed.stderr]) expect(text).not.toContain(FAKE_IROH_KEY);
  });

  it('zły klucz w pliku sekretów: odmowa bez wartości klucza', async () => {
    writeConfig({ version: 1, env: IROH });
    const bad = `${'ab'.repeat(31)}zz`;
    writeSecrets(`RAROG_IROH_KEY=${bad}\n`);
    const result = await call(['--check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('RAROG_IROH_KEY must be 64 hex characters');
    expect(`${result.stdout}${result.stderr}`).not.toContain(bad);
  });

  /*
   * Moduł natywny: `--check` robi PRAWDZIWE `loadIroh()` w próbie
   * (`iroh/module-probe.ts`, osobny proces na środowisku serwera), bez otwierania endpointu i bez wiązania portu.
   * Brak modułu i atrapę daje próbie hak `resolve` (`helpers/iroh-podmiana.mjs`) przez `command` próby;
   * zdanie odmowy i wstępne sprawdzenie przy wrapperze — próba podana `checkServeEnv`.
   */
  /** Ta maszyna ma paczkę platformy iroh (Apple silicon, Linux x64/arm64), więc moduł ładuje się naprawdę. */
  const NATIVE = irohModuleInfo().platformVersion !== null;
  const LIVE = process.env['RAROG_TEST_IROH'] === '1';
  const MODULE_LINE = `iroh: native module loaded (${IROH_PACKAGE} 1.2.0, ${irohPlatform()}); UDP port`
    + ' not checked, only the server binds it';
  const SWAP = path.join(REPO, 'server', 'test', 'helpers', 'iroh-podmiana.mjs');
  const MISSING = `no native iroh module for ${irohPlatform()} (package ${IROH_PACKAGE} is not installed);`
    + ' set RAROG_IROH=0 or run on Apple silicon or Linux';
  /** Polecenie próby z biblioteką podmienioną hakiem `resolve` (tryb w `RAROG_TEST_IROH_SWAP` środowiska próby). */
  const SWAPPED = [process.execPath, `--import=${SWAP}`, '--import', 'tsx', IROH_PROBE_ENTRY];
  const PROBE_ENV = { PATH: servePath(), RAROG_TEST_IROH_SWAP: 'brak' };

  /** `checkServeEnv` w procesie testu, z próbą podaną przez test. */
  async function checkWith(probe: IrohProbe): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env: parentEnv(), cwd: home.home,
    };
    const built = buildServeEnv(parentEnv(), { env: {}, mode: 'check' });
    return { ok: (await checkServeEnv(built, io, 'rarog serve --check', probe)).ok, stdout, stderr };
  }

  it('próba modułu: brak paczki = zdanie `loadIroh()`, atrapa = zielono, bez sekretów w środowisku próby', async () => {
    expect(await probeIrohModule(PROBE_ENV, SWAPPED)).toEqual({ ok: false, reason: MISSING });
    expect(await probeIrohModule({ ...PROBE_ENV, RAROG_TEST_IROH_SWAP: 'atrapa' }, SWAPPED)).toEqual({ ok: true });
    const secrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, 'sztuczny-sekret']));
    const leak = [process.execPath, '-e', `process.exit(${JSON.stringify(SECRET_NAMES)}.some((n) => n in process.env)`
      + ' ? 5 : 0)'];
    expect(await probeIrohModule({ ...PROBE_ENV, ...secrets }, leak)).toEqual({ ok: true });
    expect(await probeIrohModule(PROBE_ENV, [path.join(home.home, 'nie-ma')])).toEqual({
      ok: false, reason: 'the iroh native module probe failed (ENOENT)',
    });
    expect(await probeIrohModule(PROBE_ENV, [process.execPath, '-e', 'console.error("pad"); process.exit(3)']))
      .toEqual({ ok: false, reason: 'the iroh native module probe exited with code 3: pad' });
  });

  it('próba nie przechodzi: odmowa ze zdaniem i kodem 1, także na wstępnym sprawdzeniu przy wrapperze', async () => {
    writeConfig({ version: 1, env: IROH });
    writeSecrets(`RAROG_IROH_KEY=${FAKE_IROH_KEY}\n`);
    const seen: Record<string, string>[] = [];
    const missing: IrohProbe = (env) => {
      seen.push({ ...env });
      return Promise.resolve({ ok: false, reason: MISSING });
    };
    let result = await checkWith(missing);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe(`rarog serve --check: RAROG_IROH=1, but ${MISSING}\n`);
    expect(`${result.stdout}${result.stderr}`).not.toContain(FAKE_IROH_KEY);
    // Próba dostaje środowisko serwera (flaga z konfiguracji), nie środowisko procesu CLI.
    expect(seen[0]?.['RAROG_IROH']).toBe('1');
    expect(seen[0]?.['OBCY_KLUCZ']).toBeUndefined();
    // Wstępne sprawdzenie bez sekretów przy wrapperze (`rarog restart`, `service install`): klucz niesprawdzony,
    // a moduł i tak sprawdzony — restart odmawia, zanim zatrzyma działającą usługę.
    writeSecrets('');
    writeConfig({ version: 1, env: IROH, service: { wrapper: ['/bin/echo', 'wrapper'] } });
    result = await checkWith(missing);
    expect(result.ok).toBe(false);
    expect(result.stdout).toContain('iroh key: not checked (supplied by service.wrapper)');
    expect(result.stderr).toContain('RAROG_IROH=1, but no native iroh module');
    // Bez flagi próby nie ma wcale.
    writeConfig({ version: 1, env: BASE_ENV });
    seen.length = 0;
    expect((await checkWith(missing)).ok).toBe(true);
    expect(seen).toEqual([]);
  });

  it.runIf(NATIVE)('`NAPI_RS_*` procesu CLI nie psują próby (requires the iroh platform package)', () => {
    // Ładowacz paczki czyta `NAPI_RS_NATIVE_LIBRARY_PATH` z `process.env`. Serwer tej zmiennej nie
    // dostaje, więc `--check` w procesie CLI odmawiałby startu, który by się udał.
    writeConfig({ version: 1, env: IROH });
    writeSecrets(`RAROG_IROH_KEY=${FAKE_IROH_KEY}\n`);
    mkdirSync(path.join(home.home, 'tmp'), { recursive: true });
    const run = spawnSync(process.execPath, [CLI, 'serve', '--check'], {
      cwd: home.home, encoding: 'utf8', timeout: 60_000,
      env: parentEnv({ NAPI_RS_NATIVE_LIBRARY_PATH: path.join(home.home, 'nie-ma.node') }),
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(MODULE_LINE);
  });

  it.runIf(NATIVE)('moduł ładuje się naprawdę, linia z paczką (requires the iroh platform package)', async () => {
    writeConfig({ version: 1, env: IROH });
    writeSecrets(`RAROG_IROH_KEY=${FAKE_IROH_KEY}\n`);
    const result = await call(['--check']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(MODULE_LINE);
    // Bez flagi moduł nie jest sprawdzany: nic nowego w wyjściu.
    writeConfig({ version: 1, env: BASE_ENV });
    expect((await call(['--check'])).stdout).not.toContain('iroh:');
  });

  it.skipIf(NATIVE)('bez modułu: odmowa ze zdaniem (skipped with the iroh platform package)', async () => {
    writeConfig({ version: 1, env: IROH });
    writeSecrets(`RAROG_IROH_KEY=${FAKE_IROH_KEY}\n`);
    const result = await call(['--check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`rarog serve --check: RAROG_IROH=1, but no native iroh module for ${irohPlatform()}`);
  });

  it.runIf(NATIVE)('zajęty stały port UDP: --check przechodzi bez kolizji (requires the iroh platform package)',
    async () => {
      // Port trzyma gniazdo UDP testu. Prawdziwe `bind()` iroh na zajętym porcie pada na „Address already in use”
      // (fakt 11 w `adapter.ts`; zmierzone także wobec gniazda `dgram`), więc `--check` z wiązaniem
      // przewróciłby ten test.
      const holder = dgram.createSocket('udp4');
      await new Promise<void>((resolve, reject) => { holder.once('error', reject); holder.bind(0, '0.0.0.0', resolve); });
      const port = holder.address().port;
      try {
        writeConfig({ version: 1, env: { ...IROH, RAROG_IROH_PORT: String(port) } });
        writeSecrets(`RAROG_IROH_KEY=${FAKE_IROH_KEY}\n`);
        const result = await call(['--check']);
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(MODULE_LINE);
        const probe = dgram.createSocket('udp4');
        const taken = await new Promise<string>((resolve) => {
          probe.once('error', (failure: NodeJS.ErrnoException) => { resolve(failure.code ?? 'bez kodu'); });
          probe.bind(port, '0.0.0.0', () => { resolve('wolny'); });
        });
        probe.close();
        expect(taken, 'port dalej należy do „działającego nasłuchu”').toBe('EADDRINUSE');
      } finally {
        holder.close();
      }
    });

  it.runIf(LIVE)('żywy endpoint na stałym porcie: --check przechodzi (only with RAROG_TEST_IROH=1)',
    async () => {
      const running = await openEndpoint({ secretKey: new Uint8Array(randomBytes(32)), relay: null, port: null });
      try {
        const v4 = running.boundSockets().find((address) => address.startsWith('0.0.0.0:'));
        const port = Number(v4?.split(':').pop());
        expect(port).toBeGreaterThan(0);
        writeConfig({ version: 1, env: { ...IROH, RAROG_IROH_PORT: String(port) } });
        writeSecrets(`RAROG_IROH_KEY=${FAKE_IROH_KEY}\n`);
        const result = await call(['--check']);
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        expect(running.boundSockets()).toContain(v4);
        // Kontrola: wiązanie tego portu (to, czego `--check` nie robi) pada.
        await expect(openEndpoint({ secretKey: new Uint8Array(randomBytes(32)), relay: null, port }))
          .rejects.toThrow(/Address already in use/);
      } finally {
        await running.close();
      }
    });
});

describe('rarog serve: start', () => {
  it('service.wrapper bez sekretów w środowisku: odmowa startu zamiast padu w loadConfig', async () => {
    writeConfig({ version: 1, env: BASE_ENV, service: { wrapper: ['w'] } });
    const result = await call([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('service.wrapper');
  });

  it('Node bez `process.execve`: komunikat zamiast stosu', async () => {
    writeConfig({ version: 1, env: { RAROG_DEMO: '1' } });
    const saved = Object.getOwnPropertyDescriptor(process, 'execve');
    Object.defineProperty(process, 'execve', { value: undefined, configurable: true, writable: true });
    try {
      const result = await call([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('has no process.execve');
    } finally {
      if (saved !== undefined) Object.defineProperty(process, 'execve', saved);
    }
  });
});

/** Wolny port na loopbacku. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => { resolve(typeof address === 'object' && address !== null ? address.port : 0); });
    });
  });
}

/** Status of an empty `POST /api/login` with the given `Origin`: 403 = the origin gate refused it. */
function postWithOrigin(port: number, origin: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/login', method: 'POST', timeout: 1_000,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': '0' },
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => { resolve(0); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

function health(port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1_000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => { resolve(0); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

/**
 * Środowisko procesu: pary `NAZWA=wartość` po spacji, jak w `ps -E` po komendzie (macOS). Linux nie ma `ps -E`,
 * więc tam źródłem jest `/proc/<pid>/environ` w tym samym kształcie. Pusto, gdy proces zszedł.
 */
function processEnvNames(pid: number): string {
  if (process.platform === 'linux') {
    try {
      return ` ${readFileSync(`/proc/${String(pid)}/environ`, 'utf8').split('\0').filter((entry) => entry !== '').join(' ')}`;
    } catch {
      return '';
    }
  }
  const result = spawnSync('ps', ['-Eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return result.stdout ?? '';
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('rarog serve: pełny start przez execve (demo, wolny port)', () => {
  it('dwa procesy serwera, bez TERM, NODE_OPTIONS, obcych kluczy i RAROG_AUTH_TOKEN; SIGTERM kończy oba', async () => {
    const port = await freePort();
    const data = path.join(home.home, 'dane-demo');
    const child = spawn(process.execPath, [
      CLI, 'serve', '--env', 'RAROG_DEMO=1', '--port', String(port), '--data-dir', data,
    ], { cwd: home.home, env: parentEnv({ RAROG_AUTH_TOKEN: FAKE_TOKEN }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
      child.on('exit', (code, signal) => { resolve(signal ?? code); });
    });
    const pid = child.pid!;
    let kids: number[] = [];
    try {
      const deadline = Date.now() + 30_000;
      while (await health(port) !== 200) {
        if (Date.now() > deadline || !alive(pid)) throw new Error(`serwer nie wstał; wyjście:\n${output}`);
        await new Promise((resolve) => { setTimeout(resolve, 200); });
      }
      // execve zachowuje PID: proces `rarog serve` JEST teraz rodzicem serwera (cli.mjs), a jego dziecko to loader.
      const parentCommand = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
      expect(parentCommand).toContain('cli.mjs server/src/index.ts');
      kids = (spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout ?? '')
        .split('\n').filter((line) => line !== '').map(Number);
      const commands = kids.map((kid) =>
        `${String(kid)}: ${spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(kid)], { encoding: 'utf8' }).stdout.trim()}`);
      expect(kids, `dzieci procesu ${String(pid)}:\n${commands.join('\n')}`).toHaveLength(1);
      expect(spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(kids[0])], { encoding: 'utf8' }).stdout)
        .toContain('server/src/index.ts');
      for (const one of [pid, ...kids]) {
        const env = processEnvNames(one);
        expect(env, `ps -E ${String(one)}`).toContain(`RAROG_PORT=${String(port)}`);
        expect(env).toContain('RAROG_DEMO=1');
        for (const name of ['OBCY_KLUCZ=', 'NODE_OPTIONS=', ' TERM=', 'RAROG_AUTH_TOKEN=']) {
          expect(env, `${String(one)}: ${name}`).not.toContain(name);
        }
        expect(env).not.toContain(FAKE_TOKEN);
      }
      child.kill('SIGTERM');
      await exited;
      const deadlineKids = Date.now() + 10_000;
      while (kids.some(alive) && Date.now() < deadlineKids) await new Promise((resolve) => { setTimeout(resolve, 100); });
      expect(kids.filter(alive)).toEqual([]);
    } finally {
      for (const one of [pid, ...kids]) {
        try { process.kill(one, 'SIGKILL'); } catch { /* już nie żyje */ }
      }
    }
  }, 60_000);

  it('a RAROG_ORIGINS entry `null` next to a good origin: the server starts, logs the skipped entry, and only the good'
    + ' origin passes the gate', async () => {
    const port = await freePort();
    const good = `http://127.0.0.1:${String(port)}`;
    const child = spawn(process.execPath, [
      CLI, 'serve', '--env', 'RAROG_DEMO=1', '--env', `RAROG_ORIGINS=null,${good}`, '--port', String(port),
      '--data-dir', path.join(home.home, 'dane-demo'),
    ], { cwd: home.home, env: parentEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const exited = new Promise<void>((resolve) => { child.on('exit', () => { resolve(); }); });
    const pid = child.pid!;
    let kids: number[] = [];
    try {
      const deadline = Date.now() + 30_000;
      while (await health(port) !== 200) {
        if (Date.now() > deadline || !alive(pid)) throw new Error(`server did not come up; output:\n${output}`);
        await new Promise((resolve) => { setTimeout(resolve, 200); });
      }
      kids = (spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout ?? '')
        .split('\n').filter((line) => line !== '').map(Number);
      expect(output).toContain('RAROG_ORIGINS: skipped "null"');
      // The good origin passes the gate and reaches the route (410 `login-retired`); `null` stops at the gate.
      expect(await postWithOrigin(port, good)).toBe(410);
      expect(await postWithOrigin(port, 'null')).toBe(403);
      child.kill('SIGTERM');
      await exited;
    } finally {
      for (const one of [pid, ...kids]) {
        try { process.kill(one, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }, 60_000);
});
