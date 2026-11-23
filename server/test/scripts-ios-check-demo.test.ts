import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { IS_MAC, macOnly } from './platform.ts';
import { iosBundleId } from './product-identity.ts';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// Katalogi tymczasowe testów (przebieg bramki, baza stanu apek, cudza blokada) znikają po każdym teście.
const made: string[] = [];
function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  made.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Execute the real orchestration with fake external command boundaries. No Swift, Xcode or
// Rarog process is started; each fake demo is still a child process cleaned up by the real helper.
// The fake port is "busy" exactly while a fake demo lives (more `demo-start` than `demo-stop`
// lines), so starting a second demo over the first one would be refused like a real EADDRINUSE.
// The gate's TMPDIR is a directory of its own (`temp`), so a test sees every temporary file the gate leaves behind.
function runGate(extra: NodeJS.ProcessEnv = {}): {
  status: number | null; output: string; stdout: string[]; calls: string[]; lock: string; temp: string;
} {
  const root = tempDir('rarog-ios-check-test-');
  const temp = join(root, 'temp');
  const scripts = join(root, 'scripts');
  const commands = join(root, 'commands');
  const trace = join(root, 'calls');
  const linger = join(root, 'linger');
  const developer = join(root, 'Xcode', 'Contents', 'Developer');
  for (const directory of [scripts, commands, temp, join(developer, 'Platforms'),
    join(root, 'native/Rarog/Packages/RarogCore'), join(root, 'native/Rarog/Rarog.xcodeproj')]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const name of ['ios-check.sh', 'ios-identity.sh', 'ios-demo.sh', 'ios-push.sh', 'xcode-toolchain.sh']) {
    copyFileSync(join(repo, 'scripts', name), join(scripts, name));
  }
  writeFileSync(join(root, 'native/Rarog/Packages/RarogCore/Package.swift'), '// fake package');
  // Języki zbudowanej apki: atrapa skryptu notuje ścieżkę apki; MOCK_LANGUAGES_EXIT czerwieni ten krok.
  writeFileSync(join(scripts, 'ios-app-languages.sh'),
    `echo "languages:$1" >> '${trace}'\nexit \${MOCK_LANGUAGES_EXIT:-0}\n`);
  // MOCK_PACKAGES: dodatkowe pakiety, np. RarogTerminal, który bramka testuje też schematem pakietu na symulatorze.
  for (const name of (extra.MOCK_PACKAGES ?? '').split(',').filter(Boolean)) {
    mkdirSync(join(root, 'native/Rarog/Packages', name), { recursive: true });
    writeFileSync(join(root, 'native/Rarog/Packages', name, 'Package.swift'), '// fake package');
  }
  writeFileSync(trace, '');
  const devices = join(root, 'devices.txt');
  writeFileSync(devices, '== Devices ==\n-- iOS 27.0 --\n    rarog-test (00000000-0000-0000-0000-00000000A001) (Booted) \n');
  writeFileSync(linger, '0');
  const command = (name: string, body: string): void => {
    writeFileSync(join(commands, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  };
  const live = `(( $(grep -c '^demo-start' '${trace}') > $(grep -c '^demo-stop' '${trace}') ))`;
  command('xcode-select', `echo '${developer}'`);
  // Obciążenie Maca na starcie i końcu bramki: stała wartość w formacie `sysctl -n vm.loadavg`; MOCK_LOAD_FAIL:
  // sysctl odmawia (jak w sandboxie) i bramka idzie dalej z `load unknown`.
  command('sysctl', `[[ "$*" == "-n vm.loadavg" && -z "\${MOCK_LOAD_FAIL:-}" ]] || exit 1\necho '{ 1.50 1.25 1.00 }'`);
  // MOCK_PGREP_DENIED: `pgrep` odmawia jak w sandboxie Claude Code (kod 3), więc zabicie drzewa widzi tylko wskazany pid.
  command('pgrep', `if [[ -n "\${MOCK_PGREP_DENIED:-}" ]]; then exit 3; fi\nexec /usr/bin/pgrep "$@"`);
  // Każdy \`tail\` zapisuje swój pid; \`exec\` go zachowuje, więc test sprawdza, czy filtr logu przeżył bramkę.
  command('tail', `echo "tail:$$:$*" >> '${trace}'\nexec /usr/bin/tail "$@"`);
  // Every port probe is traced. MOCK_PORT_LINGER: the socket outlives our demo for N probes
  // (Node closing it); MOCK_PORT_STUCK: a foreign listener takes the port after our demo stops.
  command('lsof', `
if [[ -n "\${MOCK_PORT_BUSY:-}" ]]; then exit "\${MOCK_PORT_BUSY}"; fi
busy=0
if ${live}; then busy=1
elif grep -q '^demo-stop' '${trace}'; then
  if [[ -n "\${MOCK_PORT_STUCK:-}" ]]; then busy=1; fi
  left=$(cat '${linger}')
  if (( left < \${MOCK_PORT_LINGER:-0} )); then echo $((left + 1)) > '${linger}'; busy=1; fi
fi
if ((busy)); then echo lsof:busy >> '${trace}'; exit 0; fi
echo lsof:free >> '${trace}'
exit 1`);
  // The trap is installed and the child exists BEFORE the start is announced, and the stop is
  // written exactly once whichever dies first (the child via kill_tree or the parent via TERM).
  command('pnpm', `
stopped=0
stop() { if ((stopped)); then exit 0; fi; stopped=1; echo "demo-stop:$RAROG_DATA_DIR" >> '${trace}'; exit 0; }
trap stop TERM
sleep 60 &
echo "demo-start:$RAROG_DATA_DIR" >> '${trace}'
echo "demolang:\${RAROG_DEMO_LANG-unset}" >> '${trace}'
wait
stop`);
  command('curl', `for _ in {1..100}; do
  if ${live}; then echo health >> '${trace}'; exit 0; fi
  sleep 0.01
done
exit 7`);
  // \`simctl list\` knows one simulator (\`rarog-test\`) for the host push relay.
  command('xcrun', `
if [[ "$1" == --find ]]; then exit 0; fi
if [[ "$1" == swift ]]; then
  echo "swift:\${RAROG_DEMO_PORT-unset}:\${TEST_RUNNER_RAROG_DEMO_PORT-unset}" >> '${trace}'
  echo "swiftlang:\${RAROG_COPY_LANGUAGE-unset}" >> '${trace}'
  if [[ -n "\${MOCK_LOCK_PERMS:-}" ]]; then
    echo "lockperm:$(stat -f %Lp "$RAROG_IOS_LOCK")/$(stat -f %Lp "$RAROG_IOS_LOCK/pid")/$(stat -f %Lp "$RAROG_IOS_LOCK/owner")" >> '${trace}'
  fi
  exit \${FAIL_SWIFT:-0}
fi
if [[ "$1 $2" == "simctl list" ]]; then
  if [[ -n "\${MOCK_SIMCTL_LIST:-}" ]]; then printf '%s' "$MOCK_SIMCTL_LIST"; else cat '${devices}'; fi
  exit 0
fi
if [[ "$1" == simctl ]]; then
  echo "simctl:\${*:2}" >> '${trace}'
  if [[ "$2" == shutdown ]]; then
    # MOCK_SIMCTL_SHUTDOWN_EXIT: wyłączenie odmówione — stan urządzenia na liście zostaje, jaki był.
    if [[ -n "\${MOCK_SIMCTL_SHUTDOWN_EXIT:-}" ]]; then exit "$MOCK_SIMCTL_SHUTDOWN_EXIT"; fi
    sed -i '' 's/(Booted)/(Shutdown)/' '${devices}'
  fi
  exit 0
fi
# Ścieżka zbudowanej apki dla kroku języków (L2 K3); MOCK_SETTINGS_EMPTY: xcodebuild jej nie podał.
if [[ " $* " == *" -showBuildSettings "* ]]; then
  echo "settings:$*" >> '${trace}'
  if [[ -z "\${MOCK_SETTINGS_EMPTY:-}" ]]; then
    printf 'Build settings for action build and target Rarog:\n    CODESIGNING_FOLDER_PATH = /fake/Derived Data/Rarog.app\n'
  fi
  exit 0
fi
echo "xcode:\${TEST_RUNNER_RAROG_DEMO_PORT-unset}" >> '${trace}'
echo "push:\${TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR:+set}" >> '${trace}'
echo "xcodeargs:$*" >> '${trace}'
echo "xcodelang:\${TEST_RUNNER_RAROG_COPY_LANGUAGE-unset}" >> '${trace}'
if [[ "\${MOCK_XCODE_HANG:-}" == stubborn ]]; then trap '' TERM; fi
if [[ -n "\${MOCK_XCODE_HANG:-}" ]]; then echo 'Testing started'; sleep 30; fi
for ((i = 1; i <= \${MOCK_XCODE_LINES:-0}; i++)); do echo "Test Case '-[A t$i]' passed (0.001 seconds)."; done
if [[ -n "\${MOCK_XCODE_EXIT:-}" ]]; then echo '** TEST FAILED **'; exit "$MOCK_XCODE_EXIT"; fi
# MOCK_XCODE_TEST_EXIT: czerwone tylko akcje \`test\` (apka i RarogTerminal); build na urządzenie przechodzi.
if [[ "$2" == test && -n "\${MOCK_XCODE_TEST_EXIT:-}" ]]; then echo '** TEST FAILED **'; exit "$MOCK_XCODE_TEST_EXIT"; fi
# MOCK_XCODE_BUILD_EXIT: czerwony tylko build na urządzenie.
if [[ "$2" == build && -n "\${MOCK_XCODE_BUILD_EXIT:-}" ]]; then echo 'error: build'; exit "$MOCK_XCODE_BUILD_EXIT"; fi
echo '** TEST SUCCEEDED **'
`);
  const result = spawnSync('/bin/bash', [join(scripts, 'ios-check.sh')], {
    env: { ...process.env, PATH: `${commands}:/usr/bin:/bin`, DEVELOPER_DIR: developer,
      RAROG_IOS_DEMO_PORT: '18999', RAROG_IOS_SKIP_DEVICE: '1', RAROG_IOS_SIMULATOR: 'rarog-test',
      RAROG_IOS_LOCK: join(root, 'lock'), RAROG_IOS_LOCK_POLL: '0.1', RAROG_IOS_SILENCE_POLL: '0.1',
      // Baza stanu apek symulatora: domyślnie jej nie ma, żeby test nigdy nie sięgał do prawdziwego ~/Library.
      RAROG_IOS_SIM_DEVICES: join(root, 'sim'), TMPDIR: temp, ...extra },
    encoding: 'utf8', timeout: 15_000,
  });
  return { status: result.status, output: result.stdout + result.stderr,
    stdout: result.stdout.trim().split('\n').filter(Boolean),
    calls: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
    lock: String(extra.RAROG_IOS_LOCK ?? join(root, 'lock')), temp };
}

/** Indexes of `steps` found in order (each after the previous one); -1 when a step is missing. */
function inOrder(calls: string[], steps: string[]): number[] {
  let from = 0;
  return steps.map((step) => {
    const index = calls.indexOf(step, from);
    if (index >= 0) from = index + 1;
    return index;
  });
}

/** Czeka do 2 s, aż żaden z procesów nie żyje (zabity proces znika z opóźnieniem). */
async function waitGone(pids: number[], alive: (pid: number) => boolean): Promise<boolean> {
  for (let i = 0; i < 40 && pids.some(alive); i += 1) await new Promise((r) => setTimeout(r, 50));
  return !pids.some(alive);
}

function demoDirs(calls: string[], kind: 'start' | 'stop'): string[] {
  const prefix = `demo-${kind}:`;
  return calls.filter((call) => call.startsWith(prefix)).map((call) => call.slice(prefix.length));
}

// Each gate run spawns real bash processes and waits on fake sockets (up to 5 s for a foreign
// listener); under a parallel Xcode build one run took 5.6 s, past vitest's 5 s default.
const GATE_TIMEOUT = { timeout: 20_000 };

describe.skipIf(!IS_MAC)(macOnly('ios-check: a fresh demo for Swift integrations, another fresh one for XCUITest', 'iOS gate: stat -f, sqlite3'), GATE_TIMEOUT, () => {
  it('stops the Swift demo, waits for the port, starts a new data dir and waits for health before Xcode', () => {
    const result = runGate();
    expect(result.status, result.output).toBe(0);
    const starts = demoDirs(result.calls, 'start');
    expect(starts, result.calls.join('\n')).toHaveLength(2);
    const [swiftDemo = '', uiDemo = ''] = starts;
    expect(swiftDemo).not.toBe(uiDemo);
    expect(demoDirs(result.calls, 'stop')).toEqual([swiftDemo, uiDemo]);
    const order = inOrder(result.calls, [
      'lsof:free', `demo-start:${swiftDemo}`, 'health', 'swift:18999:18999',
      `demo-stop:${swiftDemo}`, 'lsof:free', `demo-start:${uiDemo}`, 'health', 'xcode:18999', `demo-stop:${uiDemo}`,
    ]);
    expect(order.every((index) => index >= 0), result.calls.join('\n')).toBe(true);
    expect(result.output).toContain('flow: demo :18999');
  });

  it('waits while the stopped demo still holds the socket instead of failing or starting over it', () => {
    const result = runGate({ MOCK_PORT_LINGER: '3' });
    expect(result.status, result.output).toBe(0);
    const [swiftDemo = '', uiDemo = ''] = demoDirs(result.calls, 'start');
    const stop = result.calls.indexOf(`demo-stop:${swiftDemo}`);
    const start = result.calls.indexOf(`demo-start:${uiDemo}`);
    const probes = result.calls.slice(stop + 1, start);
    expect(probes.filter((call) => call === 'lsof:busy'), probes.join('\n')).toHaveLength(3);
    expect(probes.at(-1)).toBe('lsof:free');
    expect(result.calls).toContain('xcode:18999');
  });

  it('a foreign listener on the port after the Swift demo fails the gate without Xcode or a second demo', () => {
    const result = runGate({ MOCK_PORT_STUCK: '1' });
    expect(result.status).toBe(1);
    expect(result.output).toContain('port 18999 is busy');
    expect(demoDirs(result.calls, 'start')).toHaveLength(1);
    expect(result.calls.some((line) => line.startsWith('xcode:'))).toBe(false);
  });

  it('Swift failure stops the owned demo and never starts Xcode or a second demo', () => {
    const result = runGate({ FAIL_SWIFT: '9' });
    expect(result.status).toBe(9);
    const starts = demoDirs(result.calls, 'start');
    expect(starts).toHaveLength(1);
    expect(demoDirs(result.calls, 'stop')).toEqual(starts);
    expect(result.calls.some((line) => line.startsWith('xcode:'))).toBe(false);
  });

  it('explicit skip discards inherited integration ports and reports an incomplete gate', () => {
    const result = runGate({ RAROG_IOS_SKIP_DEMO: '1', RAROG_DEMO_PORT: '8930', TEST_RUNNER_RAROG_DEMO_PORT: '8930' });
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toContain('swift:unset:unset');
    expect(result.calls).toContain('xcode:unset');
    expect(demoDirs(result.calls, 'start')).toHaveLength(0);
    expect(result.output).toContain('incomplete gate');
    expect(result.output).not.toContain('ios-check: green');
  });

  it('host push relay: XCUITest gets a signal dir only for a known simulator; unknown output from simctl is not fatal', () => {
    const known = runGate();
    expect(known.status, known.output).toBe(0);
    expect(known.calls).toContain('push:set');
    expect(known.output).toContain('host push: simctl push → rarog-test (00000000-0000-0000-0000-00000000A001)');
    for (const env of [{ RAROG_IOS_SIMULATOR: 'brak' }, { MOCK_SIMCTL_LIST: 'nie ta lista' }]) {
      const unknown = runGate(env);
      expect(unknown.status, unknown.output).toBe(0);
      expect(unknown.calls).toContain('push:');
      expect(unknown.output).toContain('host push: skipped');
    }
    const inherited = runGate({ RAROG_IOS_SKIP_DEMO: '1', TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR: '/tmp/obcy' });
    expect(inherited.calls).toContain('push:');
  });

  // Bramka mierzy się sama: czas każdego kroku w sekundach (zmienna SECONDS powłoki) i obciążenie Maca
  // (`sysctl -n vm.loadavg`) w pierwszej i ostatniej linii, także gdy krok przerywa bramkę.
  const LOAD = 'load 1.50 1.25 1.00 (1, 5, 15 min)';
  const stepTimes = (stdout: string[]): string[] => stdout.flatMap((line) => {
    const match = /^== time: (.+): \d+ s$/.exec(line);
    return match ? [match[1] ?? ''] : [];
  });

  it('prints the time of every step in seconds and the load in the first and the last line', () => {
    const result = runGate({ MOCK_PACKAGES: 'RarogTerminal', RAROG_IOS_SKIP_DEVICE: '0' });
    expect(result.status, result.output).toBe(0);
    expect(result.stdout[0]).toBe(`== ios-check: start, ${LOAD}`);
    expect(result.stdout.at(-1)).toMatch(new RegExp(`^== ios-check: end after \\d+ s, ${LOAD.replace(/[(),.]/g, '\\$&')}$`));
    expect(stepTimes(result.stdout), result.stdout.join('\n')).toEqual([
      'queue', 'demo server for Swift integrations', 'swift test RarogCore', 'swift test RarogTerminal',
      'demo server for XCUITest', 'app window in the simulator', 'xcodebuild test Rarog',
      'xcodebuild test RarogTerminal', 'device build', 'app languages',
    ]);
    // Linia czasu stoi po wierszach kroku, przed nagłówkiem następnego.
    const swift = result.stdout.indexOf('== swift test RarogCore');
    const time = result.stdout.findIndex((line) => line.startsWith('== time: swift test RarogCore: '));
    const next = result.stdout.indexOf('== swift test RarogTerminal');
    expect(swift).toBeGreaterThan(-1);
    expect(time).toBeGreaterThan(swift);
    expect(next).toBeGreaterThan(time);
  });

  it('a step that stops the gate still prints its time, and the last line still gives the load', () => {
    const result = runGate({ FAIL_SWIFT: '9' });
    expect(result.status).toBe(9);
    expect(stepTimes(result.stdout)).toEqual(['queue', 'demo server for Swift integrations', 'swift test RarogCore']);
    expect(result.stdout.at(-1)).toContain(`, ${LOAD}`);
    const unknown = runGate({ MOCK_LOAD_FAIL: '1' });
    expect(unknown.status, unknown.output).toBe(0);
    expect(unknown.stdout[0]).toBe('== ios-check: start, load unknown');
    expect(unknown.stdout.at(-1)).toMatch(/, load unknown$/);
  });

  it('rejects production port and occupied port before starting demo or Swift', () => {
    for (const env of [{ RAROG_IOS_DEMO_PORT: '8930' }, { RAROG_IOS_DEMO_PORT: '08930' },
      { RAROG_IOS_DEMO_PORT: '65536' }, { MOCK_PORT_BUSY: '0' }]) {
      const result = runGate(env);
      expect(result.status).toBe(1);
      expect(demoDirs(result.calls, 'start')).toHaveLength(0);
      expect(result.calls.some((call) => call.startsWith('swift:'))).toBe(false);
    }
  });
});

const xcodeArgs = (calls: string[]): string[] =>
  calls.filter((call) => call.startsWith('xcodeargs:')).map((call) => call.slice('xcodeargs:'.length));

/*
 * Szybka bramka: XCUITest to ~95% czasu pełnej bramki (71 testów, 46,5 min), więc agent
 * w trakcie etapu puszcza pakiety i testy bez XCUITest, a z XCUITest tylko wybrane klasy. Wynik
 * nigdy nie udaje pełnej bramki.
 */
describe.skipIf(!IS_MAC)(macOnly('ios-check: szybka bramka', 'iOS gate: stat -f, sqlite3'), GATE_TIMEOUT, () => {
  it('bez XCUITest: jeden xcodebuild z -skip-testing, bez drugiego demo i pusha, wynik „NIE pełna”', () => {
    const result = runGate({ RAROG_IOS_QUICK: '1' });
    expect(result.status, result.output).toBe(0);
    expect(xcodeArgs(result.calls)).toEqual([expect.stringContaining('test -skip-testing:RarogUITests')]);
    expect(demoDirs(result.calls, 'start')).toHaveLength(1);
    expect(result.calls).toContain('push:');
    expect(result.output).toContain('quick gate green — NOT full');
    expect(result.output).not.toContain('ios-check: green');
  });

  it('wybrane XCUITest: drugi xcodebuild z -only-testing na świeżym demo z pushem', () => {
    const result = runGate({ RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: 'ProjectsUITests,PushUITests/testA' });
    expect(result.status, result.output).toBe(0);
    const args = xcodeArgs(result.calls);
    expect(args).toHaveLength(2);
    expect(args[1]).toContain('-only-testing:RarogUITests/ProjectsUITests');
    expect(args[1]).toContain('-only-testing:RarogUITests/PushUITests/testA');
    expect(args[1]).not.toContain('-skip-testing');
    const [, uiDemo = ''] = demoDirs(result.calls, 'start');
    const order = inOrder(result.calls, [`demo-start:${uiDemo}`, 'xcode:18999', 'push:set']);
    expect(order.every((index) => index >= 0), result.calls.join('\n')).toBe(true);
    expect(result.output).toContain('XCUITest only: ProjectsUITests,PushUITests/testA');
  });

  it('odrzuca listę XCUITest z obcymi znakami albo bez szybkiej bramki, zanim cokolwiek ruszy', () => {
    for (const env of [{ RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: 'A;rm' }, { RAROG_IOS_UI_TESTS: 'A' },
      { RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: ',,,' }, { RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: 'A//b' },
      { RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: 'A,,B' }]) {
      const result = runGate(env);
      expect(result.status).toBe(1);
      expect(result.calls).toEqual([]);
    }
  });

  it('domyślnie bez buildu na urządzenie; RAROG_IOS_SKIP_DEVICE=0 go przywraca', () => {
    const quick = runGate({ RAROG_IOS_QUICK: '1', RAROG_IOS_SKIP_DEVICE: '' });
    expect(quick.status, quick.output).toBe(0);
    expect(xcodeArgs(quick.calls).some((args) => args.includes('generic/platform=iOS'))).toBe(false);
    const forced = runGate({ RAROG_IOS_QUICK: '1', RAROG_IOS_SKIP_DEVICE: '0' });
    expect(forced.status, forced.output).toBe(0);
    expect(xcodeArgs(forced.calls).some((args) => args.includes('generic/platform=iOS'))).toBe(true);
  });
});

/*
 * Zawieszony przebieg: pełna bramka stała 4 h po zawieszonym teście, a po każdej porażce xcodebuild
 * zbierał diagnostykę do 10 min. Strażnik ciszy kończy własny xcodebuild, diagnostyka jest wyłączona.
 */
/**
 * Stan okna apki zostaje w symulatorze między przebiegami: apka wyciągnięta z pełnego ekranu wracała
 * jako pływające okno — także po odinstalowaniu — i XCUITest padał daleko od przyczyny. Bramka przed XCUITest
 * wyłącza symulator i kasuje z jego bazy stanu apek zapamiętany rozmiar okna Raroga. Baza jest tu prawdziwym
 * plikiem SQLite o schemacie z symulatora iOS 26; `xcrun` zostaje atrapą.
 */
describe.skipIf(!IS_MAC)(macOnly('ios-check: okno apki w symulatorze', 'iOS gate: stat -f, sqlite3'), GATE_TIMEOUT, () => {
  const udid = '00000000-0000-0000-0000-00000000A001';
  const key = 'SBApplicationLastWindowSizePerDisplayOrdinalKey';
  const shutdown = `simctl:shutdown ${udid}`;
  // Bundle id apki ze `scripts/ios-identity.sh` (to samo źródło, które czyta bramka), nie literał.
  const app = iosBundleId();
  // Kolejność jak w `rows()` (`order by 1`), niezależnie od tego, jak bundle id sortuje się wobec obcej apki.
  const untouched = ['com.apple.mobilesafari:' + key, `${app}:SBApplicationBadgeKey`, `${app}:${key}`].sort();
  const cleared = untouched.filter((row) => row !== `${app}:${key}`);

  /** Katalog urządzeń z bazą stanu apek: rozmiar okna Raroga, jego inny wpis i rozmiar okna obcej apki. */
  function stateDb(sql = `
      create table application_identifier_tab (id integer primary key, application_identifier text);
      create table key_tab (id integer primary key, key text);
      create table kvs (id integer primary key, application_identifier integer, key integer, value blob);
      insert into application_identifier_tab values (1, '${app}'), (2, 'com.apple.mobilesafari');
      insert into key_tab values (1, '${key}'), (2, 'SBApplicationBadgeKey');
      insert into kvs (application_identifier, key, value) values (1, 1, 'okno'), (1, 2, 'znaczek'), (2, 1, 'obce');`,
  ): { devices: string; rows: () => string[] } {
    const devices = tempDir('rarog-ios-sim-');
    const directory = join(devices, udid, 'data/Library/FrontBoard');
    mkdirSync(directory, { recursive: true });
    const db = join(directory, 'applicationState.db');
    const made = spawnSync('/usr/bin/sqlite3', [db, sql], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`sqlite3: ${made.stderr}`);
    const rows = (): string[] => spawnSync('/usr/bin/sqlite3', [db,
      "select a.application_identifier || ':' || k.key from kvs v join key_tab k on v.key = k.id "
      + 'join application_identifier_tab a on v.application_identifier = a.id order by 1;'], { encoding: 'utf8' })
      .stdout.trim().split('\n').filter(Boolean);
    return { devices, rows };
  }

  it('pełna bramka: wyłącza symulator i kasuje rozmiar okna Raroga przed xcodebuild; reszta bazy zostaje', () => {
    const state = stateDb();
    expect(state.rows()).toEqual(untouched);
    const result = runGate({ RAROG_IOS_SIM_DEVICES: state.devices });
    expect(result.status, result.output).toBe(0);
    const order = inOrder(result.calls, [shutdown, 'xcode:18999']);
    expect(order.every((index) => index >= 0), result.calls.join('\n')).toBe(true);
    expect(state.rows()).toEqual(cleared);
    expect(result.output).toContain('app window in the simulator: saved window size deleted');
  });

  it('szybka bramka: tylko przed wybranymi XCUITest, po testach bez XCUITest; bez XCUITest wcale', () => {
    const picked = stateDb();
    const withUi = runGate({ RAROG_IOS_SIM_DEVICES: picked.devices, RAROG_IOS_QUICK: '1',
      RAROG_IOS_UI_TESTS: 'ProjectsUITests' });
    expect(withUi.status, withUi.output).toBe(0);
    const steps = withUi.calls.filter((call) => call.startsWith('xcodeargs:') || call === shutdown)
      .map((call) => (call === shutdown ? 'reset' : call.includes('-only-testing') ? 'ui' : 'unit'));
    expect(steps).toEqual(['unit', 'reset', 'ui']);
    expect(picked.rows()).toEqual(cleared);

    const none = stateDb();
    const withoutUi = runGate({ RAROG_IOS_SIM_DEVICES: none.devices, RAROG_IOS_QUICK: '1' });
    expect(withoutUi.status, withoutUi.output).toBe(0);
    expect(withoutUi.calls.some((call) => call.startsWith('simctl:'))).toBe(false);
    expect(none.rows()).toEqual(untouched);
  });

  it('nieznany symulator, brak bazy i obcy schemat nie przewracają bramki; wynik mówi, co się stało', () => {
    const state = stateDb();
    const unknown = runGate({ RAROG_IOS_SIM_DEVICES: state.devices, RAROG_IOS_SIMULATOR: 'brak' });
    expect(unknown.status, unknown.output).toBe(0);
    expect(unknown.output).toContain('app window in the simulator: skipped (no simulator UDID: brak)');
    expect(state.rows()).toEqual(untouched);

    const fresh = runGate();
    expect(fresh.status, fresh.output).toBe(0);
    expect(fresh.output).toContain('app window in the simulator: skipped (no app state database');
    expect(fresh.calls.some((call) => call.startsWith('simctl:'))).toBe(false);

    const foreign = stateDb('create table inna (id integer primary key);');
    const refused = runGate({ RAROG_IOS_SIM_DEVICES: foreign.devices });
    expect(refused.status, refused.output).toBe(0);
    expect(refused.output).toContain('could not delete the saved window size');
    expect(xcodeArgs(refused.calls)).toHaveLength(1);
  });

  it('bazy działającego symulatora nie rusza: odmowa wyłączenia zostawia wpis; już wyłączony symulator — kasuje', () => {
    // Zignorowany błąd `simctl shutdown` puściłby SQLite w bazę żywego SpringBoardu.
    const live = stateDb();
    const stuck = runGate({ RAROG_IOS_SIM_DEVICES: live.devices, MOCK_SIMCTL_SHUTDOWN_EXIT: '1' });
    expect(stuck.status, stuck.output).toBe(0);
    expect(live.rows()).toEqual(untouched);
    expect(stuck.output).toContain('app window in the simulator: skipped (the simulator did not shut down');
    expect(xcodeArgs(stuck.calls)).toHaveLength(1);

    // `simctl shutdown` kończy się błędem także dla urządzenia, które już stoi wyłączone.
    const off = stateDb();
    const already = runGate({ RAROG_IOS_SIM_DEVICES: off.devices, MOCK_SIMCTL_SHUTDOWN_EXIT: '149',
      MOCK_SIMCTL_LIST: `== Devices ==\n-- iOS 27.0 --\n    rarog-test (${udid}) (Shutdown) \n` });
    expect(already.status, already.output).toBe(0);
    expect(off.rows()).toEqual(cleared);
    expect(already.output).toContain('saved window size deleted');
  });
});

/**
 * Język testów (`docs/localization.md`, „Tests”): proces `swift test` i proces testów xcodebuild mają przypięty język
 * copy (`RAROG_COPY_LANGUAGE`, w xcodebuild z prefiksem `TEST_RUNNER_`), a każde `xcodebuild test` startuje apkę po
 * polsku. Wartość od wywołującego nie przechodzi: test zakłada polskie zdania. Tak samo treść serwera demo
 * (`RAROG_DEMO_LANG=pl`).
 */
describe.skipIf(!IS_MAC)(macOnly('ios-check: język testów przypięty na polski', 'iOS gate: stat -f, sqlite3'), GATE_TIMEOUT, () => {
  it('swift test i każde xcodebuild test dostają pl, także gdy wywołujący ustawił inny język', () => {
    const result = runGate({ RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: 'ProjectsUITests',
      RAROG_COPY_LANGUAGE: 'en', TEST_RUNNER_RAROG_COPY_LANGUAGE: 'en' });
    expect(result.status, result.output).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('swiftlang:'))).toEqual(['swiftlang:pl']);
    expect(result.calls.filter((call) => call.startsWith('xcodelang:'))).toEqual(['xcodelang:pl', 'xcodelang:pl']);
    const args = xcodeArgs(result.calls);
    expect(args).toHaveLength(2);
    for (const call of args) expect(call).toContain('-testLanguage pl -testRegion PL');
  });

  // Treść demo: demo bez `RAROG_DEMO_LANG` mówi po angielsku, a XCUITest szuka polskich tekstów
  // seedów, więc każde demo bramki startuje z `pl` (`ios_demo_start`), także gdy wywołujący ustawił `en`.
  it('demo dla integracji Swift i demo dla XCUITest dostają RAROG_DEMO_LANG=pl', () => {
    const result = runGate({ RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: 'ProjectsUITests', RAROG_DEMO_LANG: 'en' });
    expect(result.status, result.output).toBe(0);
    expect(demoDirs(result.calls, 'start')).toHaveLength(2);
    expect(result.calls.filter((call) => call.startsWith('demolang:'))).toEqual(['demolang:pl', 'demolang:pl']);
  });
});

describe.skipIf(!IS_MAC)(macOnly('ios-check: strażnik ciszy i diagnostyka', 'iOS gate: stat -f, sqlite3'), GATE_TIMEOUT, () => {
  it('każde xcodebuild test idzie bez zbierania diagnostyki po porażce', () => {
    const result = runGate({ RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: 'ProjectsUITests' });
    expect(result.status, result.output).toBe(0);
    const args = xcodeArgs(result.calls);
    expect(args).toHaveLength(2);
    for (const call of args) expect(call).toContain('-collect-test-diagnostics never');
    expect(result.output).toContain('** TEST SUCCEEDED **');
  });

  // Limit czasu jednego testu: kroki po 60 s trzymały zawieszony test 24–46 min, a strażnik ciszy ich nie
  // łapie, bo xcodebuild pisze wiersz przy każdym kroku. Pełna i szybka bramka, z XCUITest i bez.
  it('każde xcodebuild test idzie z limitem czasu jednego testu 300 s', () => {
    const runs = [runGate(), runGate({ RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: 'ProjectsUITests' })];
    const args = runs.flatMap((result) => {
      expect(result.status, result.output).toBe(0);
      return xcodeArgs(result.calls).filter((call) => call.startsWith('xcodebuild test '));
    });
    expect(args).toHaveLength(3);
    for (const call of args) {
      expect(call).toContain('-test-timeouts-enabled YES');
      expect(call).toContain('-default-test-execution-time-allowance 300');
    }
  });

  it('log bez przyrostu kończy własny xcodebuild kodem 124, sprząta demo i blokadę', () => {
    const started = Date.now();
    const result = runGate({ RAROG_IOS_QUICK: '1', MOCK_XCODE_HANG: '1', RAROG_IOS_SILENCE: '1' });
    expect(result.status, result.output).toBe(124);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.output).toContain('xcodebuild log silent for 1 s');
    expect(result.output).toContain('full xcodebuild log:');
    const [demo = ''] = demoDirs(result.calls, 'start');
    expect(demoDirs(result.calls, 'stop')).toEqual([demo]);
    expect(existsSync(result.lock)).toBe(false);
  });

  it('proces ignorujący SIGTERM: po RAROG_IOS_KILL_GRACE idzie SIGKILL, bramka kończy się 124 i sprząta', () => {
    const started = Date.now();
    const result = runGate({
      RAROG_IOS_QUICK: '1', MOCK_XCODE_HANG: 'stubborn', RAROG_IOS_SILENCE: '1', RAROG_IOS_KILL_GRACE: '1',
    });
    expect(result.status, result.output).toBe(124);
    expect(Date.now() - started).toBeLessThan(12_000);
    const [demo = ''] = demoDirs(result.calls, 'start');
    expect(demoDirs(result.calls, 'stop')).toEqual([demo]);
    expect(existsSync(result.lock)).toBe(false);
  });

  // Sprzątanie dysku: katalogi danych serwerów demo znikają po każdym przebiegu, log xcodebuild zostaje tylko po
  // porażce. Katalogu sygnałów pusha (`rarog-push.*`) bramka nie kasuje, więc tu go nie liczymy.
  const left = (temp: string, prefix: string): string[] =>
    readdirSync(temp).filter((name) => name.startsWith(prefix)).sort();

  it('po zielonym przebiegu nie zostaje rarog-demo.* ani log xcodebuild', () => {
    for (const env of [{}, { RAROG_IOS_QUICK: '1', RAROG_IOS_UI_TESTS: 'ProjectsUITests' }]) {
      const result = runGate(env);
      expect(result.status, result.output).toBe(0);
      expect(demoDirs(result.calls, 'start')).toHaveLength(2);
      expect(left(result.temp, 'rarog-demo.'), JSON.stringify(env)).toEqual([]);
      expect(left(result.temp, 'rarog-xcodebuild.'), JSON.stringify(env)).toEqual([]);
    }
  });

  it('po porażce nie zostaje rarog-demo.*, a zostaje dokładnie log czerwonego xcodebuild', () => {
    for (const env of [{ RAROG_IOS_QUICK: '1', MOCK_XCODE_EXIT: '65' },
      { RAROG_IOS_QUICK: '1', MOCK_XCODE_HANG: '1', RAROG_IOS_SILENCE: '1' }]) {
      const result = runGate(env);
      expect(result.status, result.output).not.toBe(0);
      expect(left(result.temp, 'rarog-demo.'), JSON.stringify(env)).toEqual([]);
      const logs = left(result.temp, 'rarog-xcodebuild.');
      expect(logs, JSON.stringify(env)).toHaveLength(1);
      expect(result.output).toContain(`full xcodebuild log: ${join(result.temp, logs[0] ?? '')}`);
    }
    const swift = runGate({ FAIL_SWIFT: '9' });
    expect(swift.status).toBe(9);
    expect(left(swift.temp, 'rarog-demo.')).toEqual([]);
  });

  it('kod wyjścia xcodebuild (65) zostaje kodem bramki, a log pełny czeka na miejscu', () => {
    const result = runGate({ RAROG_IOS_QUICK: '1', MOCK_XCODE_EXIT: '65' });
    expect(result.status, result.output).toBe(65);
    expect(result.output).toContain('** TEST FAILED **');
    expect(result.output).toContain('full xcodebuild log:');
  });

  // Czerwony krok nie kończy bramki: XCUITest ma zawsze znane porażki, a z `set -e` testy
  // RarogTerminal i build na urządzenie w pełnej bramce nigdy nie ruszały.
  const step = (call: string): string => (call.includes('generic/platform=iOS') ? 'urządzenie'
    : call.includes('-scheme RarogTerminal') ? 'RarogTerminal' : call.startsWith('xcodebuild test ') ? 'apka' : call);

  it('czerwony xcodebuild test: idą RarogTerminal i build na urządzenie, kod bramki to kod pierwszej porażki', () => {
    const result = runGate({ MOCK_PACKAGES: 'RarogTerminal', MOCK_XCODE_TEST_EXIT: '65', RAROG_IOS_SKIP_DEVICE: '0' });
    expect(result.status, result.output).toBe(65);
    expect(xcodeArgs(result.calls).map(step)).toEqual(['apka', 'RarogTerminal', 'urządzenie']);
    expect(result.output).toContain('xcodebuild test Rarog — red (code 65); the gate goes on');
    expect(result.output).toContain('ios-check: red — xcodebuild test Rarog, xcodebuild test RarogTerminal (');
    expect(result.output).not.toContain('ios-check: green');
    const [demo = '', uiDemo = ''] = demoDirs(result.calls, 'start');
    expect(demoDirs(result.calls, 'stop')).toEqual([demo, uiDemo]);
    expect(existsSync(result.lock)).toBe(false);
  });

  it('kod pierwszej porażki wygrywa z późniejszym; sam czerwony build na urządzenie też czerwieni bramkę', () => {
    const both = runGate({ MOCK_XCODE_TEST_EXIT: '65', MOCK_XCODE_BUILD_EXIT: '70', RAROG_IOS_SKIP_DEVICE: '0' });
    expect(both.status, both.output).toBe(65);
    expect(both.output).toContain('ios-check: red — xcodebuild test Rarog, device build (');
    const build = runGate({ MOCK_XCODE_BUILD_EXIT: '70', RAROG_IOS_SKIP_DEVICE: '0' });
    expect(build.status, build.output).toBe(70);
    expect(build.output).toContain('ios-check: red — device build (');
    expect(build.output).not.toContain('ios-check: green');
  });

  // Języki zbudowanej apki: po zielonym buildzie na urządzenie, na ścieżce z `-showBuildSettings` (ze spacją).
  it('zielony build na urządzenie: skrypt języków dostaje ścieżkę apki; jego porażka czerwieni bramkę', () => {
    const green = runGate({ RAROG_IOS_SKIP_DEVICE: '0' });
    expect(green.status, green.output).toBe(0);
    const settings = green.calls.filter((call) => call.startsWith('settings:'));
    expect(settings).toHaveLength(1);
    expect(settings[0]).toContain('-destination generic/platform=iOS');
    expect(green.calls.filter((call) => call.startsWith('languages:'))).toEqual(['languages:/fake/Derived Data/Rarog.app']);
    const build = green.calls.findIndex((call) => call.startsWith('xcodeargs:xcodebuild build '));
    expect(build).toBeGreaterThan(-1);
    expect(green.calls.indexOf(settings[0] ?? ''), 'ścieżka po buildzie').toBeGreaterThan(build);
    expect(green.output).toContain('== app languages: /fake/Derived Data/Rarog.app');
    const red = runGate({ RAROG_IOS_SKIP_DEVICE: '0', MOCK_LANGUAGES_EXIT: '1' });
    expect(red.status, red.output).toBe(1);
    expect(red.output).toContain('ios-check: red — app languages (');
    const noPath = runGate({ RAROG_IOS_SKIP_DEVICE: '0', MOCK_SETTINGS_EMPTY: '1' });
    expect(noPath.status, noPath.output).toBe(1);
    expect(noPath.output).toContain('ios-check: xcodebuild -showBuildSettings gave no path of the built app');
    expect(noPath.calls.some((call) => call.startsWith('languages:'))).toBe(false);
  });

  it('czerwony build na urządzenie: bez kroku języków', () => {
    const result = runGate({ MOCK_XCODE_BUILD_EXIT: '70', RAROG_IOS_SKIP_DEVICE: '0' });
    expect(result.status, result.output).toBe(70);
    expect(result.calls.some((call) => call.startsWith('settings:') || call.startsWith('languages:'))).toBe(false);
  });

  // Gałąź z podpisem (RAROG_IOS_SIGN=1) ma własne wywołanie buildu, więc i krok języków sprawdzamy w niej osobno.
  it('RAROG_IOS_SIGN=1: build z podpisem, po zielonym kroku języków; po czerwonym bez niego', () => {
    const green = runGate({ RAROG_IOS_SKIP_DEVICE: '0', RAROG_IOS_SIGN: '1' });
    expect(green.status, green.output).toBe(0);
    const builds = xcodeArgs(green.calls).filter((args) => args.startsWith('xcodebuild build '));
    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain('-allowProvisioningUpdates');
    expect(builds[0]).not.toContain('CODE_SIGNING_ALLOWED=NO');
    expect(green.output).toContain('signed, not installed');
    expect(green.calls.filter((call) => call.startsWith('languages:'))).toEqual(['languages:/fake/Derived Data/Rarog.app']);
    const build = green.calls.findIndex((call) => call.startsWith('xcodeargs:xcodebuild build '));
    const settings = green.calls.findIndex((call) => call.startsWith('settings:'));
    expect(settings, 'ścieżka apki po buildzie').toBeGreaterThan(build);
    expect(green.output).toContain('device build signed');
    const languagesRed = runGate({ RAROG_IOS_SKIP_DEVICE: '0', RAROG_IOS_SIGN: '1', MOCK_LANGUAGES_EXIT: '1' });
    expect(languagesRed.status, languagesRed.output).toBe(1);
    expect(languagesRed.output).toContain('ios-check: red — app languages (');
    const red = runGate({ RAROG_IOS_SKIP_DEVICE: '0', RAROG_IOS_SIGN: '1', MOCK_XCODE_BUILD_EXIT: '70' });
    expect(red.status, red.output).toBe(70);
    expect(red.output).toContain('ios-check: red — device build (');
    expect(red.calls.some((call) => call.startsWith('settings:') || call.startsWith('languages:'))).toBe(false);
  });

  it('zawieszony xcodebuild test (124) kończy bramkę od razu: bez RarogTerminal i bez buildu na urządzenie', () => {
    const result = runGate({
      MOCK_PACKAGES: 'RarogTerminal', MOCK_XCODE_HANG: '1', RAROG_IOS_SILENCE: '1', RAROG_IOS_SKIP_DEVICE: '0',
    });
    expect(result.status, result.output).toBe(124);
    expect(xcodeArgs(result.calls).map(step)).toEqual(['apka']);
    expect(existsSync(result.lock)).toBe(false);
  });

  // Filtr jako rura w podpowłoce zostawiałby `tail -f` do znalezienia przez `pgrep -P`, a w sandboxie Claude Code
  // `pgrep` odmawia, więc każda bramka zostawiałaby `tail` na zawsze.
  it('po bramce nie zostaje żaden tail logu xcodebuild, także gdy pgrep odmawia', async () => {
    for (const env of [{}, { MOCK_PGREP_DENIED: '1' }]) {
      const result = runGate({ RAROG_IOS_QUICK: '1', ...env });
      expect(result.status, result.output).toBe(0);
      const followers = result.calls.filter((call) => call.startsWith('tail:') && call.includes(' -f '))
        .map((call) => Number(call.split(':')[1]));
      expect(followers, result.calls.join('\n')).toHaveLength(1);
      const alive = (pid: number): boolean => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      };
      const gone = await waitGone(followers, alive);
      for (const pid of followers.filter(alive)) process.kill(pid, 'SIGKILL');
      expect(gone, JSON.stringify(env)).toBe(true);
      expect(result.output).not.toContain('Terminated');
    }
  });

  it('wszystkie wiersze wyników trafiają do bramki, także te tuż przed wyjściem xcodebuild', () => {
    const result = runGate({ RAROG_IOS_QUICK: '1', MOCK_XCODE_LINES: '400' });
    expect(result.status, result.output).toBe(0);
    expect(result.output.match(/Test Case '-\[A t\d+\]' passed/g)).toHaveLength(400);
    expect(result.output).toContain('** TEST SUCCEEDED **');
  });

  it('odrzuca RAROG_IOS_SILENCE i RAROG_IOS_KILL_GRACE, które nie są liczbą sekund, zanim cokolwiek ruszy', () => {
    for (const env of [{ RAROG_IOS_SILENCE: '0' }, { RAROG_IOS_SILENCE: 'abc' }, { RAROG_IOS_SILENCE: '-5' },
      { RAROG_IOS_KILL_GRACE: '0' }, { RAROG_IOS_KILL_GRACE: 'x' }]) {
      const result = runGate(env);
      expect(result.status).toBe(1);
      expect(result.calls).toEqual([]);
    }
  });
});

/*
 * Kolejka: bramki z kilku worktree naraz dawały load 150–230 i testy 5–10× wolniejsze.
 * Blokada jest wspólna; bramka czeka na żywą, przejmuje martwą i zawsze sprząta swoją.
 */
describe.skipIf(!IS_MAC)(macOnly('ios-check: kolejka bramek', 'iOS gate: stat -f, sqlite3'), GATE_TIMEOUT, () => {
  const heldLock = (pid: number): string => {
    const lock = join(tempDir('rarog-ios-lock-'), 'lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${pid}\n`);
    writeFileSync(join(lock, 'owner'), '/inny/worktree\n');
    return lock;
  };

  it('zwalnia swoją blokadę po zielonej bramce i po porażce', () => {
    for (const env of [{}, { FAIL_SWIFT: '9' }]) {
      const result = runGate(env);
      expect(existsSync(result.lock), result.output).toBe(false);
    }
  });

  // Blokada leży we wspólnym /tmp: runner AI review (osobny użytkownik) odmawia startu, gdy w /private/tmp są
  // pliki czytelne dla innych. Katalog 700, pliki 600 — także przy luźnej masce wywołującego.
  it('trzyma blokadę tylko dla właściciela (700, pliki 600)', () => {
    const result = runGate({ MOCK_LOCK_PERMS: '1' });
    expect(result.status, result.output).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('lockperm:'))[0]).toBe('lockperm:700/600/600');
  });

  it('czeka na żywą bramkę obok i kończy się błędem po limicie, nie ruszając demo ani Swift', () => {
    const neighbour = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const lock = heldLock(neighbour.pid!);
      const result = runGate({ RAROG_IOS_LOCK: lock, RAROG_IOS_LOCK_WAIT: '1' });
      expect(result.status).toBe(1);
      expect(result.output).toContain('waiting for the gate from /inny/worktree');
      expect(result.output).toContain('queue: waited over 1 s');
      expect(result.calls).toEqual([]);
      expect(readFileSync(join(lock, 'pid'), 'utf8').trim()).toBe(String(neighbour.pid));
    } finally {
      neighbour.kill('SIGKILL');
    }
  });

  it('przejmuje blokadę po martwej bramce i przechodzi', () => {
    const dead = spawnSync('true');
    const lock = heldLock(dead.pid);
    const result = runGate({ RAROG_IOS_LOCK: lock });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('lock left by a dead gate');
    expect(existsSync(lock)).toBe(false);
  });

  // Muteks przejęcia trzyma inna bramka (właśnie przejmuje): nie kasujemy blokady, czekamy. Muteks starszy niż
  // minuta to ślad bramki, która padła w trakcie przejęcia — zdejmujemy go i przejmujemy sami.
  it('nie przejmuje martwej blokady, gdy przejmuje ją ktoś inny; zdejmuje porzucony muteks', () => {
    const dead = spawnSync('true');
    const busy = heldLock(dead.pid);
    mkdirSync(`${busy}.takeover`);
    const waiting = runGate({ RAROG_IOS_LOCK: busy, RAROG_IOS_LOCK_WAIT: '1' });
    expect(waiting.status).toBe(1);
    expect(waiting.output).not.toContain('lock left by a dead gate');
    expect(readFileSync(join(busy, 'pid'), 'utf8').trim()).toBe(String(dead.pid));

    const abandoned = heldLock(dead.pid);
    mkdirSync(`${abandoned}.takeover`);
    spawnSync('touch', ['-t', '202001010000', `${abandoned}.takeover`]);
    const result = runGate({ RAROG_IOS_LOCK: abandoned });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('lock left by a dead gate');
    expect(existsSync(`${abandoned}.takeover`)).toBe(false);
  });
});
