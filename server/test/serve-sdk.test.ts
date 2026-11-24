/**
 * SDK Claude w komendach i przy starcie serwera (`install/sdk.ts`): ścisłe `serve --check` i `rarog restart`
 * w paczce npm (brak SDK = odmowa z pełną ścieżką i `rarog setup`, przed `restart.sh`), stan startu
 * (`loadListSessions`: `ok`, `stale`, `missing`, `error`, nigdy wyjątek) i linia „SDK” w `rarog doctor`.
 *
 * Tryb paczki wchodzi przez parametry (`mode`, sprawdzenie SDK w `checkServeEnv`, `RestartDeps.sdk`), bo testy
 * biegną z klonu repo. Pakiet SDK w katalogu wersji to atrapa `sdk.mjs` z `listSessions`.
 *
 * Czas w liniach logu serwera (`log-timestamps.ts`): prefiks na każdej linii zapisu wielowierszowego, jeden na
 * linię zapisaną kawałkami, i żywy proces `rarog serve` (demo, wolny port), którego każda linia go ma. Later lines
 * of one write carry the continuation mark after the time.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sdkLine, sdkLineOf } from '../src/cli/doctor.ts';
import type { SdkLineInput } from '../src/cli/doctor.ts';
import type { CliIo } from '../src/cli/io.ts';
import { restartCommand } from '../src/cli/restart.ts';
import { buildServeEnv, checkServeEnv, checkServeSdk } from '../src/cli/serve.ts';
import type { ServeSdkCheck } from '../src/cli/serve.ts';
import { renderServiceUnit, unitFilePath } from '../src/cli/systemd-unit.ts';
import {
  SDK_PACKAGE, checkPinnedSdk, loadListSessions, probeCheckedSdkDir, readSdkPin, sdkLogLine, sdkRoot, sdkVersionDir,
} from '../src/install/sdk.ts';
import type { ListSessionsFn, SdkDirProbe } from '../src/install/sdk.ts';
import { LOG_TIME_PREFIX, timestampWrites } from '../src/log-timestamps.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';
import { REPO, fakeNode, linuxSandbox } from './systemd-atrapy.ts';

const VERSION = readSdkPin().version;
const ORIGINS = { RAROG_ORIGINS: 'https://rarog-test.example.ts.net' };
const PROBE_OK: SdkDirProbe = () => Promise.resolve({ ok: true });

let t: TempHome;
let dataDir = '';

beforeEach(() => {
  t = tempHome('serve-sdk-');
  dataDir = path.join(t.home, 'dane');
  mkdirSync(dataDir, { mode: 0o700 });
});
afterEach(() => { t.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

/** Katalog wersji z atrapą pakietu SDK (prawa 700 na `sdk/` i katalogu wersji, jak po `rarog setup`). */
function placeSdk(root: string, version: string, body = 'export async function listSessions() { return []; }\n'): string {
  const dir = sdkVersionDir(root, version);
  const pkg = path.join(dir, 'node_modules', ...SDK_PACKAGE.split('/'));
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: SDK_PACKAGE, version, type: 'module', exports: { '.': { default: './sdk.mjs' } },
  }));
  writeFileSync(path.join(pkg, 'sdk.mjs'), body);
  for (const each of [sdkRoot(root), dir]) chmodSync(each, 0o700);
  return dir;
}

const packageSdk = (probe: SdkDirProbe = PROBE_OK): ServeSdkCheck => (input) => checkPinnedSdk({
  ...input, mode: 'package', probe,
});

async function check(
  values: Record<string, string>, sdk: ServeSdkCheck, dataDirOption?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env: {}, cwd: t.home };
  const built = buildServeEnv({ HOME: t.home }, {
    env: values, mode: 'check', ...(dataDirOption === undefined ? {} : { dataDir: dataDirOption }),
  });
  const result = await checkServeEnv(built, io, 'rarog serve --check', undefined, sdk);
  return { ok: result.ok, stdout, stderr };
}

describe('serve --check w paczce: SDK ściśle', () => {
  it('brak → odmowa z pełną ścieżką katalogu wersji i komendą rarog setup z tym katalogiem', async () => {
    const run = await check(ORIGINS, packageSdk(), dataDir);
    expect(run.ok).toBe(false);
    expect(run.stderr).toContain(`rarog serve --check: SDK ${VERSION} is not downloaded in`
      + ` ${sdkVersionDir(dataDir, VERSION)}; run rarog setup --data-dir '${dataDir}'.`);
    expect(run.stdout).not.toContain('port:');
  });

  it('brak przy katalogu z reguły → komenda bez --data-dir', async () => {
    const run = await check(ORIGINS, packageSdk());
    const ruled = path.join(t.home, '.local', 'share', 'rarog');
    expect(run.stderr).toContain(`is not downloaded in ${sdkVersionDir(ruled, VERSION)}; run rarog setup.`);
  });

  it('obecny i sonda przechodzi → linia z wersją i katalogiem, potem katalog danych i port', async () => {
    const dir = placeSdk(dataDir, VERSION);
    const run = await check(ORIGINS, packageSdk(), dataDir);
    expect(run.ok, run.stderr).toBe(true);
    expect(run.stdout).toContain(`SDK: ${VERSION} (${dir})\ndata directory: ${dataDir}`);
  });

  it('obecny, a sonda nie przechodzi albo prawa inne niż 700 → odmowa z powodem', async () => {
    const dir = placeSdk(dataDir, VERSION);
    const failing = await check(ORIGINS, packageSdk(() => Promise.resolve({ ok: false, reason: 'listSessions: x' })),
      dataDir);
    expect(failing.stderr).toContain(`SDK ${VERSION} in ${dir} does not work (listSessions: x).`);
    chmodSync(dir, 0o755);
    const loose = await check(ORIGINS, packageSdk(), dataDir);
    expect(loose.ok).toBe(false);
    expect(loose.stderr).toContain(`${dir}: mode 755, required 700`);
  });

  it('demo: SDK niewymagany; klon (sprawdzenie domyślne): z workspace', async () => {
    const demo = await check({ RAROG_DEMO: '1' }, packageSdk());
    expect(demo.ok, demo.stderr).toBe(true);
    expect(demo.stdout).toContain('SDK: not required (demo)');
    const clone = await check(ORIGINS, checkServeSdk, dataDir);
    expect(clone.ok, clone.stderr).toBe(true);
    expect(clone.stdout).toContain(`SDK: from the workspace (${SDK_PACKAGE} ${VERSION})`);
  });
});

describe('rarog restart w paczce: odmowa przed restart.sh', () => {
  it('jednostka zdrowa, SDK brak → odmowa z komendą setup, „Nic nie zostało zatrzymane”, restart.sh nie ruszył', async () => {
    const sb = linuxSandbox('serve-sdk-restart-');
    try {
      const config = path.join(sb.homeDir, '.config', 'rarog');
      mkdirSync(config, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(config, 'config.json'), JSON.stringify({
        version: 1, env: { ...ORIGINS, RAROG_PORT: '18996' }, service: { wrapper: ['/nieistniejacy/wrapper.sh', '--'] },
      }));
      const unit = unitFilePath(sb.homeDir);
      const ruled = path.join(sb.homeDir, '.local', 'share', 'rarog');
      mkdirSync(path.dirname(unit), { recursive: true });
      writeFileSync(unit, renderServiceUnit({
        execStart: ['/nieistniejacy/wrapper.sh', '--', fakeNode(sb, 'v22.22.3'), path.join(REPO, 'bin', 'rarog.mjs'),
          'serve'],
        workingDirectory: REPO, log: path.join(ruled, 'server.log'),
      }));
      let stderr = '';
      const io: CliIo = {
        stdout: () => {}, stderr: (text) => { stderr += text; }, env: sb.env(), cwd: sb.homeDir, platform: 'linux',
      };
      expect(await restartCommand(['restart'], io, { sdk: packageSdk() })).toBe(1);
      expect(stderr).toContain(`SDK ${VERSION} is not downloaded in ${sdkVersionDir(ruled, VERSION)}; run rarog`
        + ' setup.');
      expect(stderr).toContain('rarog restart: Nothing was stopped.');
      expect(sb.calls('uname')).toEqual([]);
      expect(sb.calls('systemctl').filter((line) => line.startsWith('--user restart'))).toEqual([]);
    } finally {
      sb.cleanup();
    }
  });
});

describe('start serwera: loadListSessions nigdy nie rzuca, stan idzie do /health', () => {
  const fn: ListSessionsFn = () => Promise.resolve([]);
  const fakeImport = (dir: string, version: string): Promise<ListSessionsFn> => {
    imported.push(`${path.relative(dataDir, dir)} ${version}`);
    return Promise.resolve(fn);
  };
  let imported: string[] = [];
  beforeEach(() => { imported = []; });

  it('przypięta wersja → ok z katalogiem wersji', async () => {
    placeSdk(dataDir, VERSION);
    const loaded = await loadListSessions({ dataDir, mode: 'package', importFrom: fakeImport });
    expect(loaded.status).toEqual({
      state: 'ok', pinned: VERSION, version: VERSION, source: sdkVersionDir(dataDir, VERSION), detail: null,
    });
    expect(loaded.listSessions).toBe(fn);
    expect(sdkLogLine(loaded.status)).toBe(`sdk: ok (${SDK_PACKAGE} ${VERSION}, ${sdkVersionDir(dataDir, VERSION)})`);
  });

  it('przypiętej brak, są inne → stale na najnowszej (porównanie liczbowe), z linią logu o rarog setup', async () => {
    placeSdk(dataDir, '0.0.9');
    placeSdk(dataDir, '0.0.10');
    const loaded = await loadListSessions({ dataDir, mode: 'package', importFrom: fakeImport });
    expect(loaded.status).toMatchObject({ state: 'stale', version: '0.0.10' });
    expect(imported).toEqual([`sdk/0.0.10 0.0.10`]);
    expect(loaded.listSessions).toBe(fn);
    expect(sdkLogLine(loaded.status)).toContain(`the pinned ${VERSION} is not downloaded, 0.0.10 runs`);
  });

  it('żadnej wersji → missing bez importu', async () => {
    const loaded = await loadListSessions({ dataDir, mode: 'package', importFrom: fakeImport });
    expect(loaded.status).toEqual({ state: 'missing', pinned: VERSION, version: null, source: null, detail: null });
    expect(loaded.listSessions).toBeNull();
    expect(imported).toEqual([]);
    expect(sdkLogLine(loaded.status)).toContain('the session list stays empty until you run rarog setup');
  });

  it('błąd importu, wyjątek sondy, sonda ponad limit i złe prawa → error z powodem, bez funkcji', async () => {
    placeSdk(dataDir, VERSION);
    const broken = await loadListSessions({
      dataDir, mode: 'package', importFrom: () => Promise.reject(new Error('import padł')),
    });
    expect(broken.status).toMatchObject({ state: 'error', detail: 'import padł' });
    expect(broken.listSessions).toBeNull();
    const throwing = await loadListSessions({
      dataDir, mode: 'package', importFrom: () => Promise.resolve(() => Promise.reject(new Error('magazyn'))),
    });
    expect(throwing.status).toMatchObject({ state: 'error', detail: 'listSessions: magazyn' });
    const hanging = await loadListSessions({
      dataDir, mode: 'package', probeTimeoutMs: 50, importFrom: () => Promise.resolve(() => new Promise(() => {})),
    });
    expect(hanging.status).toMatchObject({ state: 'error', detail: 'listSessions did not finish within 50 ms' });
    chmodSync(sdkRoot(dataDir), 0o755);
    const loose = await loadListSessions({ dataDir, mode: 'package', importFrom: fakeImport });
    expect(loose.status).toMatchObject({ state: 'error' });
    expect(loose.status.detail).toContain('mode 755, required 700');
    expect(sdkLogLine(loose.status)).toMatch(/^sdk: error — .*; the session list stays empty$/u);
  });

  it('import po jawnej ścieżce: prawdziwy importSdkFrom ładuje atrapę z katalogu wersji', async () => {
    placeSdk(dataDir, VERSION);
    const loaded = await loadListSessions({ dataDir, mode: 'package' });
    expect(loaded.status.state).toBe('ok');
    expect(await loaded.listSessions?.({ dir: t.home })).toEqual([]);
  });

  it('poprawny SDK w nadrzędnym node_modules nie liczy się jako lokalna kopia: missing albo error, nigdy ok', async () => {
    const project = path.join(t.home, 'projekt');
    placeSdk(project, VERSION);
    // Katalog danych pod katalogiem z `node_modules` z SDK (rozwiązywanie po nazwie by go znalazło).
    const nested = path.join(project, 'sdk', VERSION, 'dane');
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    expect((await loadListSessions({ dataDir: nested, mode: 'package' })).status.state).toBe('missing');
    mkdirSync(sdkVersionDir(nested, VERSION), { recursive: true });
    for (const each of [sdkRoot(nested), sdkVersionDir(nested, VERSION)]) chmodSync(each, 0o700);
    const empty = await loadListSessions({ dataDir: nested, mode: 'package' });
    expect(empty.status.state).toBe('error');
    expect(empty.listSessions).toBeNull();
  });

  it('wejście z package.json prowadzące poza katalog wersji → error', async () => {
    const dir = placeSdk(dataDir, VERSION);
    const outside = path.join(t.home, 'obcy.mjs');
    writeFileSync(outside, 'export async function listSessions() { return []; }\n');
    writeFileSync(path.join(dir, 'node_modules', ...SDK_PACKAGE.split('/'), 'package.json'), JSON.stringify({
      name: SDK_PACKAGE, version: VERSION, type: 'module', main: path.relative(
        path.join(dir, 'node_modules', ...SDK_PACKAGE.split('/')), outside),
    }));
    const loaded = await loadListSessions({ dataDir, mode: 'package' });
    expect(loaded.status.state).toBe('error');
    expect(loaded.status.detail).toContain('leads outside');
  });

  it('klon: workspace → ok ze źródłem workspace; moduł bez listSessions → error', async () => {
    const ok = await loadListSessions({ dataDir, mode: 'clone', importWorkspace: () => Promise.resolve({ listSessions: fn }) });
    expect(ok.status).toMatchObject({ state: 'ok', source: 'workspace' });
    const bad = await loadListSessions({ dataDir, mode: 'clone', importWorkspace: () => Promise.resolve({}) });
    expect(bad.status).toMatchObject({ state: 'error', detail: `${SDK_PACKAGE}: no listSessions function` });
  });

  it('katalog tymczasowy sondy nie powstaje (TMPDIR bez katalogu) → error z powodem, bez wyjątku', async () => {
    const before = process.env['TMPDIR'];
    process.env['TMPDIR'] = path.join(t.home, 'nie-ma');
    try {
      const loaded = await loadListSessions({
        dataDir, mode: 'clone', importWorkspace: () => Promise.resolve({ listSessions: fn }),
      });
      expect(loaded.status).toMatchObject({ state: 'error', detail: expect.stringContaining('probe directory') });
      expect(loaded.listSessions).toBeNull();
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
      else process.env['TMPDIR'] = before;
    }
  });
});

/** Wzorzec z karty planu: czas ISO 8601 w UTC z milisekundami i jedna spacja. */
const STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /u;

describe('czas w liniach logu serwera', () => {
  /** Strumień-atrapa: zbiera to, co dociera do oryginalnego `write`, z czasem przesuwanym o 1 ms na zapis. */
  function stamped(): { stream: { write: (chunk: unknown, ...rest: unknown[]) => boolean }; text: () => string } {
    const parts: Buffer[] = [];
    const stream = {
      write: (chunk: unknown, ...rest: unknown[]): boolean => {
        parts.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array));
        const done = rest.find((each) => typeof each === 'function') as (() => void) | undefined;
        done?.();
        return true;
      },
    };
    let ms = Date.parse('2026-11-10T16:59:23.123Z');
    timestampWrites(stream as unknown as NodeJS.WritableStream, () => new Date(ms++));
    return { stream, text: () => Buffer.concat(parts).toString('utf8') };
  }

  it('an error of three lines in one write: the first line gets the prefix, the later lines the continuation mark',
    () => {
      const { stream, text } = stamped();
      stream.write('Error: boom\n    at a (x.ts:1:1)\n    at b (y.ts:2:2)\n');
      expect(text()).toBe('2026-11-10T16:59:23.123Z Error: boom\n2026-11-10T16:59:23.123Z |     at a (x.ts:1:1)\n'
        + '2026-11-10T16:59:23.123Z |     at b (y.ts:2:2)\n');
      for (const line of text().split('\n').filter((each) => each !== '')) expect(line).toMatch(STAMPED);
    });

  it('a line in one write that copies a whole log line cannot pass for a line of its own', () => {
    const { stream, text } = stamped();
    stream.write('watch: cwd /outside/\nconsent: no hook — session sess-a, cause hooks-disabled\n');
    const [, second] = text().split('\n');
    expect(second).toBe('2026-11-10T16:59:23.123Z | consent: no hook — session sess-a, cause hooks-disabled');
    expect(second?.replace(LOG_TIME_PREFIX, '').startsWith('consent:')).toBe(false);
  });

  it('a write that ends a line begun earlier and starts another: the new line is a continuation of this write',
    () => {
      const { stream, text } = stamped();
      stream.write('sse: client ');
      stream.write('connected\nmore\n');
      stream.write('next\n');
      expect(text()).toBe('2026-11-10T16:59:23.123Z sse: client connected\n2026-11-10T16:59:23.124Z | more\n'
        + '2026-11-10T16:59:23.125Z next\n');
    });

  it('linia zapisana w dwóch fragmentach → jeden prefiks; następna linia dostaje własny', () => {
    const { stream, text } = stamped();
    stream.write('sse: client ');
    stream.write(Buffer.from('connected\n', 'utf8'));
    stream.write('next\n');
    expect(text()).toBe('2026-11-10T16:59:23.123Z sse: client connected\n2026-11-10T16:59:23.124Z next\n');
  });

  it('`DataView` i widok z przesunięciem liczą się jak bajty: koniec linii w nich daje prefiks następnej linii', () => {
    const { stream, text } = stamped();
    stream.write('fragment');
    stream.write(new DataView(Uint8Array.of(0x0a).buffer));
    const padded = Buffer.from('xxnext\n', 'utf8');
    stream.write(new DataView(padded.buffer, padded.byteOffset + 2, padded.byteLength - 2));
    stream.write('last\n');
    expect(text()).toBe('2026-11-10T16:59:23.123Z fragment\n2026-11-10T16:59:23.124Z next\n'
      + '2026-11-10T16:59:23.125Z last\n');
  });

  it('kodowanie i callback zapisu przechodzą; pusty zapis nie zmienia stanu linii', () => {
    const { stream, text } = stamped();
    let called = 0;
    stream.write('', () => { called += 1; });
    stream.write(Buffer.from('ok\n').toString('hex'), 'hex', () => { called += 1; });
    expect(called).toBe(2);
    expect(text()).toBe('2026-11-10T16:59:23.123Z ok\n');
    expect(text()).toMatch(LOG_TIME_PREFIX);
  });

  it('żywy proces z `rarog serve`: każda linia stdout i stderr zaczyna się od czasu', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => { resolve(typeof address === 'object' && address !== null ? address.port : 0); });
      });
    });
    const child = spawn(process.execPath, [
      path.join(REPO, 'bin', 'rarog.mjs'), 'serve', '--env', 'RAROG_DEMO=1', '--port', String(port),
      '--data-dir', dataDir,
    ], {
      cwd: t.home,
      env: { PATH: process.env['PATH'] ?? '', HOME: t.home, XDG_DATA_HOME: path.join(t.home, 'xdg'), TMPDIR: t.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const exited = new Promise<void>((resolve) => { child.on('exit', () => { resolve(); }); });
    try {
      const deadline = Date.now() + 45_000;
      while (!output.includes(`listening on http://127.0.0.1:${String(port)}`)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`serwer nie wstał; wyjście:\n${output}`);
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
    const lines = output.split('\n').filter((line) => line !== '');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toMatch(STAMPED);
  }, 60_000);
});

describe('rarog doctor: sonda SDK po sprawdzeniu katalogów', () => {
  it('sdk/ albo katalog wersji z prawami innymi niż 700 → czerwona, kod SDK nie uruchomiony', async () => {
    const dir = placeSdk(dataDir, VERSION);
    const calls: string[] = [];
    const probe: SdkDirProbe = (each) => { calls.push(each); return Promise.resolve({ ok: true }); };
    expect(await probeCheckedSdkDir(dataDir, VERSION, probe)).toEqual({ ok: true });
    for (const loose of [sdkRoot(dataDir), dir]) {
      chmodSync(loose, 0o755);
      expect(await probeCheckedSdkDir(dataDir, VERSION, probe))
        .toMatchObject({ ok: false, reason: expect.stringContaining('probe not run') });
      const line = await sdkLine(dataDir, null, {}, 'package');
      expect(line).toMatchObject({ verdict: 'bad', text: expect.stringContaining('probe not run') });
      chmodSync(loose, 0o700);
    }
    expect(calls).toEqual([dir]);
  });
});

describe('rarog doctor: linia „SDK”', () => {
  const base: SdkLineInput = {
    mode: 'package', pinned: VERSION, dataDir: '/d', versions: [{ version: VERSION, bytes: 4_805_217 }],
    probe: { ok: true }, health: 'ok',
  };
  const dir = sdkVersionDir('/d', VERSION);

  it('pobrany, sonda i /health ok → zielona z katalogiem i rozmiarem', () => {
    expect(sdkLineOf(base)).toEqual({ verdict: 'ok', text: `SDK ${VERSION}: ${dir} (4.8 MB) (/health: ok)`, details: [] });
  });

  it('aktualizacja i restart przez nadzorcę: przypiętej brak, działa stara (stale) → czerwona z rarog setup', () => {
    const line = sdkLineOf({ ...base, versions: [{ version: '0.0.9', bytes: 1_000_000 }], probe: null, health: 'stale' });
    expect(line).toMatchObject({
      verdict: 'bad', text: `SDK ${VERSION} missing, 0.0.9 installed — after a restart the server runs the old SDK`
        + ' (/health: stale)', repair: 'rarog setup',
    });
    expect(line.details).toEqual([`other versions in /d/sdk: 0.0.9 (1.0 MB)`]);
  });

  it('żadnej wersji → czerwona z pustą listą w apce i rarog setup', () => {
    expect(sdkLineOf({ ...base, versions: [], probe: null, health: 'missing' })).toMatchObject({
      verdict: 'bad', text: expect.stringContaining(`missing in ${dir} — the Recent sessions list in the app is empty`),
      repair: 'rarog setup',
    });
  });

  it('pobrany, a serwer mówi missing (wystartował przed pobraniem) → czerwona z rarog restart', () => {
    expect(sdkLineOf({ ...base, health: 'missing' })).toMatchObject({ verdict: 'bad', repair: 'rarog restart' });
  });

  it('sonda nie przeszła → czerwona z powodem; konflikt katalogu → nie wiem', () => {
    expect(sdkLineOf({ ...base, probe: { ok: false, reason: 'x' } }))
      .toMatchObject({ verdict: 'bad', text: expect.stringContaining('probe failed — x') });
    expect(sdkLineOf({ ...base, dataDir: null }).verdict).toBe('unknown');
  });

  it('inne wersje obok przypiętej: rozmiary w szczegółach, bez komendy kasowania', () => {
    const line = sdkLineOf({ ...base, versions: [...base.versions, { version: '0.0.9', bytes: 2_500_000 }] });
    expect(line.verdict).toBe('ok');
    expect(line.details).toEqual(['other versions in /d/sdk: 0.0.9 (2.5 MB)']);
    expect(JSON.stringify(line)).not.toMatch(/\brm\b/u);
  });

  it('klon: zielona „z workspace”, czerwona tylko przy /health error', () => {
    expect(sdkLineOf({ ...base, mode: 'clone', versions: [], probe: null, health: null }))
      .toEqual({ verdict: 'ok', text: `SDK: from the workspace (${SDK_PACKAGE} ${VERSION})` });
    expect(sdkLineOf({ ...base, mode: 'clone', health: 'missing' }).verdict).toBe('ok');
    expect(sdkLineOf({ ...base, mode: 'clone', health: 'error' }).verdict).toBe('bad');
  });
});
