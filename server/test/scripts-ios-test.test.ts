import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// `scripts/ios-test.sh` (testy wybrane) na atrapach granic: `xcrun` (swift, simctl, xcodebuild), `lsof`, `curl`
// i `pnpm` (serwer demo). Żaden symulator, Xcode ani proces Raroga nie startuje. Każdy przebieg dostaje własny
// katalog „worktree” z kopią skryptów; `TMPDIR` przebiegów jest wspólny dla pliku, więc DerivedData dwóch przebiegów
// z tego samego katalogu da się porównać. Wszystko leży pod jednym katalogiem, który `afterAll` kasuje.
const base = mkdtempSync(join(tmpdir(), 'rarog-ios-test-test-'));
const sharedTmp = join(base, 'tmp');
mkdirSync(sharedTmp);
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  expect(existsSync(base)).toBe(false);
});

/** Wzorzec symulatora: typ symulatora bramki i najnowszy runtime iOS atrapy (`simctl list runtimes`). */
const TEMPLATE = 'rarog-ios-test-template-iOS-27-0-iPad Pro 11-inch (M5)';
const FOREIGN = '00000000-0000-0000-0000-00000000F001';
const SCRIPTS = ['ios-test.sh', 'xcode-toolchain.sh', 'ios-identity.sh', 'ios-demo.sh', 'ios-push.sh'];

interface Worktree { root: string; trace: string; commands: string; developer: string }

function makeWorktree(packages: string[] = ['RarogUI', 'RarogActivity']): Worktree {
  const root = mkdtempSync(join(base, 'wt-'));
  const commands = join(root, '.fake-bin');
  const trace = join(root, '.calls');
  const developer = join(root, '.Xcode', 'Contents', 'Developer');
  for (const directory of [join(root, 'scripts'), commands, join(developer, 'Platforms'),
    join(root, 'native/Rarog/Rarog.xcodeproj')]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const name of SCRIPTS) copyFileSync(join(repo, 'scripts', name), join(root, 'scripts', name));
  for (const name of packages) {
    mkdirSync(join(root, 'native/Rarog/Packages', name), { recursive: true });
    writeFileSync(join(root, 'native/Rarog/Packages', name, 'Package.swift'), '// fake package');
  }
  writeFileSync(trace, '');
  const command = (name: string, body: string): void => {
    writeFileSync(join(commands, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  };
  const live = `(( $(grep -c '^demo-start' '${trace}') > $(grep -c '^demo-stop' '${trace}') ))`;
  command('xcode-select', `echo '${developer}'`);
  // MOCK_BUSY_PORTS: porty zajęte przez cudze usługi (po spacji; słuchacz o pid 1). Port, na którym słucha atrapa
  // demo, zwraca jej pid (`.listen-<port>`). Każde zapytanie o port trafia do śladu.
  command('lsof', `
port="\${2#-iTCP:}"
for p in \${MOCK_BUSY_PORTS:-}; do
  if [[ "$p" == "$port" ]]; then echo "lsof:busy:$port" >> '${trace}'; echo 1; exit 0; fi
done
own="$(cat '${root}'/.listen-"$port" 2>/dev/null)"
if [[ -n "$own" ]] && kill -0 "$own" 2>/dev/null; then echo "lsof:own:$port" >> '${trace}'; echo "$own"; exit 0; fi
echo "lsof:free:$port" >> '${trace}'
exit 1`);
  // Atrapa serwera demo dostaje środowisko `env -i`, więc porażkę startu zamawia plik `.demo-fail`: `always` albo
  // `first` (pierwszy start pada, następne słuchają). Padający start kończy się kodem 1, zanim zacznie słuchać.
  command('pnpm', `
stopped=0
stop() {
  if ((stopped)); then exit 0; fi
  stopped=1; rm -f '${root}'/.listen-"$RAROG_PORT"; echo "demo-stop:$RAROG_PORT" >> '${trace}'; exit 0
}
echo "demo-start:$RAROG_PORT" >> '${trace}'
fail="$(cat '${root}/.demo-fail' 2>/dev/null)"
if [[ "$fail" == always ]] || { [[ "$fail" == first ]] && mkdir '${root}/.demo-failed' 2>/dev/null; }; then exit 1; fi
trap stop TERM
sleep 60 &
echo $$ > '${root}'/.listen-"$RAROG_PORT"
wait
stop`);
  // MOCK_CURL_ALWAYS: na porcie odpowiada cudzy \`/health\`, niezależnie od atrapy demo.
  command('curl', `if [[ -n "\${MOCK_CURL_ALWAYS:-}" ]]; then exit 0; fi
for _ in {1..100}; do
  if ${live}; then exit 0; fi
  sleep 0.01
done
exit 7`);
  command('xcrun', `
if [[ "$1" == --find ]]; then exit 0; fi
if [[ "$1" == swift ]]; then
  echo "swift:\${*:2}" >> '${trace}'
  echo "swiftlang:\${RAROG_COPY_LANGUAGE-unset}:\${RAROG_DEMO_PORT-unset}" >> '${trace}'
  if [[ -n "\${MOCK_NO_TESTS:-}" ]]; then
    echo 'Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds'
    echo 'warning: No matching test cases were run'
    echo '✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.'
  else
    echo "Test Case '-[RarogUITests.CardsTests testA]' passed (0.001 seconds)."
    echo '✔ Test run with 2 tests in 1 suite passed after 0.001 seconds.'
  fi
  exit \${MOCK_SWIFT_EXIT:-0}
fi
if [[ "$1" == simctl ]]; then
  # Rejestr symulatorów atrapy: wiersz \`<udid><TAB><nazwa>\`; wspólny dla dwóch worktree przez MOCK_SIMS.
  sims="\${MOCK_SIMS:-${root}/.sims}"
  touch "$sims"
  lock() { until mkdir "$sims.lock" 2>/dev/null; do sleep 0.01; done; }
  unlock() { rmdir "$sims.lock"; }
  new_udid() {
    local n
    n=$(( $(cat "$sims.n" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$sims.n"
    printf '00000000-0000-0000-0000-%s%011d' "$1" "$n"
  }
  without() { awk -F'\\t' -v u="$1" '$1 != u' "$sims" > "$sims.tmp"; mv "$sims.tmp" "$sims"; }
  if [[ "$2" == list ]]; then
    if [[ "$3" == runtimes ]]; then
      echo '== Runtimes =='
      if [[ -z "\${MOCK_NO_RUNTIME:-}" ]]; then
        echo 'iOS 26.2 (26.2 - 23C54) - com.apple.CoreSimulator.SimRuntime.iOS-26-2'
        echo 'iOS 27.0 (27.0 - 24A434) - com.apple.CoreSimulator.SimRuntime.iOS-27-0'
      fi
      exit 0
    fi
    printf -- '== Devices ==\\n-- iOS 27.0 --\\n    other (${FOREIGN}) (Booted) \\n'
    awk -F'\\t' '{ printf "    %s (%s) (Shutdown) \\n", $2, $1 }' "$sims"
    exit 0
  fi
  echo "simctl:\${*:2}" >> '${trace}'
  case "$2" in
    create)
      if [[ -n "\${MOCK_CREATE_FAIL:-}" ]]; then exit 1; fi
      lock; udid="$(new_udid B)"; printf '%s\\t%s\\n' "$udid" "$3" >> "$sims"; unlock
      echo "$udid" ;;
    clone)
      if [[ -n "\${MOCK_CLONE_FAIL:-}" ]]; then exit 1; fi
      lock
      if ! awk -F'\\t' -v u="$3" '$1 == u { found = 1 } END { exit !found }' "$sims"; then unlock; exit 1; fi
      udid="$(new_udid C)"; printf '%s\\t%s\\n' "$udid" "$4" >> "$sims"; unlock
      echo "$udid" ;;
    rename)
      lock
      awk -F'\\t' -v u="$3" -v n="$4" 'BEGIN { OFS = "\\t" } $1 == u { $2 = n } { print }' "$sims" > "$sims.tmp"
      mv "$sims.tmp" "$sims"; unlock ;;
    delete) lock; without "$3"; unlock ;;
    bootstatus)
      sleep "\${MOCK_BOOT_SLEEP:-0}"
      if [[ -n "\${MOCK_BOOT_FAIL:-}" ]]; then exit 1; fi ;;
  esac
  exit 0
fi
if [[ "$1" == xcodebuild ]]; then
  echo "xcodebuild:\${*:2}" >> '${trace}'
  echo "xcodeenv:$PWD:\${TEST_RUNNER_RAROG_COPY_LANGUAGE-unset}:\${TEST_RUNNER_RAROG_DEMO_PORT-unset}:\${TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR:+push}" >> '${trace}'
  if [[ -n "\${MOCK_XCODE_HANG:-}" ]]; then echo 'Testing started'; sleep 30; fi
  # Proces ignoruje SIGTERM (dziedziczy to też \`sleep\`); pętla ograniczona, żeby atrapa nie żyła wiecznie.
  if [[ -n "\${MOCK_XCODE_IGNORE_TERM:-}" ]]; then
    trap '' TERM
    echo "xcodepid:$$" >> '${trace}'
    for _ in $(seq 1 400); do sleep 0.1; done
  fi
  if [[ -n "\${MOCK_XCODE_EXIT:-}" ]]; then
    echo "Test Case '-[RarogUIKitTests.HeaderChromeTests testA]' failed (1.000 seconds)."
    echo '** TEST FAILED **'; exit "$MOCK_XCODE_EXIT"
  fi
  if [[ "$2" == build ]]; then echo 'CompileSwift normal arm64'; echo '** BUILD SUCCEEDED **'; exit 0; fi
  # Wiersze jak u prawdziwego xcodebuild (Xcode 27, iOS 27.0): filtr bez trafień to kod 0, puste zestawy
  # z „Executed 0 tests” i „** TEST SUCCEEDED **”.
  echo "Test Suite 'Selected tests' started at 2026-11-10 18:33:25.507."
  executed=0
  if [[ -n "\${MOCK_ONE_TEST:-}" ]]; then
    echo "Test Case '-[RarogUITests.FlowUITests testPairListTranscriptSendEcho]' passed (41.204 seconds)."
    executed=1
  elif [[ -z "\${MOCK_NO_TESTS:-}" ]]; then
    echo "Test Case '-[RarogUIKitTests.HeaderChromeTests testA]' passed (1.000 seconds)."
    echo "Test Case '-[RarogUIKitTests.HeaderChromeTests testB]' skipped (0.001 seconds)."
    executed=2
  fi
  echo "Test Suite 'Selected tests' passed at 2026-11-10 18:33:25.508."
  echo "	 Executed $executed tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds"
  echo '** TEST SUCCEEDED **'
  exit 0
fi
echo "unexpected xcrun $*" >&2
exit 99`);
  return { root, trace, commands, developer };
}

function scriptEnv(wt: Worktree, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${wt.commands}:/usr/bin:/bin`, DEVELOPER_DIR: wt.developer, TMPDIR: sharedTmp,
    RAROG_DEMO_PORT: '1', TEST_RUNNER_RAROG_DEMO_PORT: '2', TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR: '/nowhere',
    RAROG_COPY_LANGUAGE: 'en', TEST_RUNNER_RAROG_COPY_LANGUAGE: 'en', ...extra };
}

function run(wt: Worktree, args: string[], extra: NodeJS.ProcessEnv = {}): {
  status: number | null; output: string; calls: string[];
} {
  writeFileSync(wt.trace, '');
  const result = spawnSync('/bin/bash', [join(wt.root, 'scripts/ios-test.sh'), ...args], {
    env: scriptEnv(wt, extra), encoding: 'utf8', timeout: 20_000,
  });
  return { status: result.status, output: result.stdout + result.stderr,
    calls: readFileSync(wt.trace, 'utf8').trim().split('\n').filter(Boolean) };
}

const starting = (calls: string[], prefix: string): string[] => calls.filter((call) => call.startsWith(prefix));
/** Wartość flagi `name` w wierszu śladu (argumenty bez spacji w wartościach poza `-destination`). */
function flag(call: string, name: string): string | undefined {
  const words = call.split(' ');
  const index = words.indexOf(name);
  return index < 0 ? undefined : words[index + 1];
}

const RUN_TIMEOUT = { timeout: 30_000 };
const XCUITEST = 'RarogUITests/FlowUITests/testPairListTranscriptSendEcho';
const ALL_PORTS = Array.from({ length: 50 }, (_, i) => 18940 + i);
/** MOCK_BUSY_PORTS: zajęte wszystkie porty zakresu poza podanymi. */
const busyExcept = (...free: number[]): string => ALL_PORTS.filter((port) => !free.includes(port)).join(' ');
const portLocks = join(sharedTmp, 'rarog-ios-test', 'ports');
/** Rezerwacje portów demo, które zostały po przebiegach (wspólne dla wszystkich worktree). */
const reservations = (): string[] => (existsSync(portLocks) ? readdirSync(portLocks).sort() : []);
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const pidOf = (calls: string[]): number => Number(starting(calls, 'xcodepid:')[0]?.split(':')[1] ?? 'NaN');
/** UDID symulatora przebiegu z linii `== own simulator: …`. */
const ownSim = (output: string): string => /== own simulator: .*\(([0-9A-F-]{36})\)/.exec(output)?.[1] ?? 'none';
/** Nazwy symulatorów w rejestrze atrapy po przebiegu (bez cudzego, którego atrapa tylko wypisuje). */
function simulators(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\t')[1] ?? '').sort()
    : [];
}
const registry = (wt: Worktree): string[] => simulators(join(wt.root, '.sims'));

describe('ios-test: selected tests of the app', RUN_TIMEOUT, () => {
  it('a UIKit class: one xcodebuild test with -only-testing, Polish language, a 300 s limit and stable DerivedData', () => {
    const wt = makeWorktree();
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests']);
    expect(result.status, result.output).toBe(0);
    const builds = starting(result.calls, 'xcodebuild:');
    expect(builds, result.calls.join('\n')).toHaveLength(1);
    const [call = ''] = builds;
    expect(call).toMatch(/^xcodebuild:test /);
    expect(call).toContain(' -only-testing:RarogUIKitTests/HeaderChromeTests');
    expect(call).toContain(' -testLanguage pl -testRegion PL');
    expect(call).toContain(' -test-timeouts-enabled YES -default-test-execution-time-allowance 300');
    expect(call).toContain(' -collect-test-diagnostics never');
    expect(call).toContain(` -destination id=${ownSim(result.output)}`);
    const derived = flag(call, '-derivedDataPath') ?? '';
    expect(derived.startsWith(join(sharedTmp, 'rarog-ios-test', `${basename(wt.root)}-`)), derived).toBe(true);
    expect(derived).toMatch(/-[0-9a-f]{8}\/app$/);
    // Język procesu testów z prefiksem TEST_RUNNER_, bez dziedziczenia `en`; UIKit nie dostaje demo ani pusha.
    expect(starting(result.calls, 'xcodeenv:')).toEqual([`xcodeenv:${wt.root}:pl:unset:`]);
    expect(starting(result.calls, 'demo-start:')).toEqual([]);
    expect(result.output).toContain("HeaderChromeTests testB]' skipped");
    expect(result.output).not.toContain("testA]' passed");
    expect(result.output).toContain('test-Rarog — green, 2 tests');
  });

  it('one test that ran is "1 test"; the "Executed N tests" suite lines do not count', () => {
    const wt = makeWorktree();
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests/testA'], { MOCK_ONE_TEST: '1' });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('test-Rarog — green, 1 test\n');
  });

  it('a package class: swift test with RAROG_COPY_LANGUAGE=pl, no simulator and no xcodebuild', () => {
    const wt = makeWorktree();
    const result = run(wt, ['--package', 'RarogUI', '--filter', 'CardsTests']);
    expect(result.status, result.output).toBe(0);
    expect(starting(result.calls, 'swift:')).toEqual([
      `swift:test --package-path ${wt.root}/native/Rarog/Packages/RarogUI --filter CardsTests`]);
    // Endpoint demo nie przechodzi z otoczenia: testy przepływu pakietu pomijają się, zamiast trafić w cudzy port.
    expect(starting(result.calls, 'swiftlang:')).toEqual(['swiftlang:pl:unset']);
    expect(starting(result.calls, 'xcodebuild:')).toEqual([]);
    expect(starting(result.calls, 'simctl:')).toEqual([]);
    expect(result.output).toContain('swift-test-RarogUI — green, 3 tests');
  });

  it('a package with Package.resolved runs on the pinned versions', () => {
    const wt = makeWorktree(['RarogTerminal']);
    writeFileSync(join(wt.root, 'native/Rarog/Packages/RarogTerminal/Package.resolved'), '{}');
    const result = run(wt, ['--package', 'RarogTerminal']);
    expect(result.status, result.output).toBe(0);
    expect(starting(result.calls, 'swift:')).toEqual([
      `swift:test --package-path ${wt.root}/native/Rarog/Packages/RarogTerminal --force-resolved-versions`]);
  });

  it('--build: only the simulator build of the app, without a simulator of its own', () => {
    const wt = makeWorktree();
    const result = run(wt, ['--build']);
    expect(result.status, result.output).toBe(0);
    const builds = starting(result.calls, 'xcodebuild:');
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatch(/^xcodebuild:build -project \S+Rarog\.xcodeproj -scheme Rarog /);
    expect(builds[0]).toContain(' -destination generic/platform=iOS Simulator ');
    expect(builds[0]).toMatch(/-derivedDataPath \S+\/app$/);
    expect(starting(result.calls, 'simctl:')).toEqual([]);
    expect(starting(result.calls, 'swift:')).toEqual([]);
    expect(result.output).toContain('** BUILD SUCCEEDED **');
    expect(result.output).not.toContain('CompileSwift');
  });

  it('a filter that matched no test fails with "no tests ran" (xcodebuild and swift test)', () => {
    const wt = makeWorktree();
    const app = run(wt, ['RarogUIKitTests/NoSuchTests'], { MOCK_NO_TESTS: '1' });
    expect(app.status, app.output).not.toBe(0);
    expect(app.output).toContain('no tests ran');
    const pkg = run(wt, ['--package', 'RarogUI', '--filter', 'NoSuchTests'], { MOCK_NO_TESTS: '1' });
    expect(pkg.status, pkg.output).not.toBe(0);
    expect(pkg.output).toContain('no tests ran');
  });

  it('a second run in the same worktree uses the same DerivedData; another worktree gets its own', () => {
    const wt = makeWorktree();
    const paths = [run(wt, ['RarogUIKitTests/HeaderChromeTests']), run(wt, ['--build'])]
      .map((result) => flag(starting(result.calls, 'xcodebuild:')[0] ?? '', '-derivedDataPath'));
    expect(paths[0]).toBeDefined();
    expect(paths[1]).toBe(paths[0]);
    const other = run(makeWorktree(), ['--build']);
    expect(flag(starting(other.calls, 'xcodebuild:')[0] ?? '', '-derivedDataPath')).not.toBe(paths[0]);
  });

  it('the first run makes the template (one boot, shut down, renamed) and a clone; the second run only clones', () => {
    const wt = makeWorktree();
    const first = run(wt, ['RarogUIKitTests/HeaderChromeTests']);
    expect(first.status, first.output).toBe(0);
    const simctl = starting(first.calls, 'simctl:');
    const made = /^simctl:create (rarog-ios-test-\d+-template) iPad Pro 11-inch \(M5\) /.exec(simctl[0] ?? '');
    expect(made, simctl.join('\n')).not.toBeNull();
    const prep = made?.[1] ?? '';
    const template = '00000000-0000-0000-0000-B00000000001';
    const clone = ownSim(first.output);
    expect(simctl).toEqual([
      `simctl:create ${prep} iPad Pro 11-inch (M5) com.apple.CoreSimulator.SimRuntime.iOS-27-0`,
      `simctl:bootstatus ${template} -b`, `simctl:shutdown ${template}`, `simctl:rename ${template} ${TEMPLATE}`,
      `simctl:clone ${template} ${prep.replace(/-template$/, '')}`,
      `simctl:bootstatus ${clone} -b`, `simctl:shutdown ${clone}`, `simctl:delete ${clone}`]);
    expect(first.output).toMatch(/== time: simulator boot: \d+ s/);
    expect(first.output).toContain('clone of the template');
    expect(registry(wt)).toEqual([TEMPLATE]);
    const second = run(wt, ['RarogUIKitTests/HeaderChromeTests']);
    expect(second.status, second.output).toBe(0);
    const again = ownSim(second.output);
    expect(again).not.toBe(clone);
    expect(starting(second.calls, 'simctl:')).toEqual([
      `simctl:clone ${template} ${/simctl:clone \S+ (\S+)/.exec(starting(second.calls, 'simctl:clone')[0] ?? '')?.[1]}`,
      `simctl:bootstatus ${again} -b`, `simctl:shutdown ${again}`, `simctl:delete ${again}`]);
    expect(registry(wt)).toEqual([TEMPLATE]);
    expect([...first.calls, ...second.calls].join('\n')).not.toContain(FOREIGN);
  });

  it('the clone is shut down and deleted after the tests, also after a red test', () => {
    const wt = makeWorktree();
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests'], { MOCK_XCODE_EXIT: '65' });
    expect(result.status, result.output).toBe(65);
    const clone = ownSim(result.output);
    expect(result.calls.indexOf(`simctl:delete ${clone}`))
      .toBeGreaterThan(result.calls.findIndex((call) => call.startsWith('xcodebuild:')));
    expect(registry(wt)).toEqual([TEMPLATE]);
  });

  it('two runs at once make one template; both test on their own clones, which are gone afterwards', {
    timeout: 30_000,
  }, async () => {
    const shared = join(base, `sims-${Date.now()}`);
    const runs = [makeWorktree(), makeWorktree()].map((wt) => new Promise<{ code: number | null; calls: string[] }>(
      (done) => {
        const child = spawn('/bin/bash', [join(wt.root, 'scripts/ios-test.sh'), 'RarogUIKitTests/HeaderChromeTests'], {
          env: scriptEnv(wt, { MOCK_SIMS: shared, MOCK_BOOT_SLEEP: '1' }), stdio: 'ignore' });
        child.on('exit', (code) => done({
          code, calls: readFileSync(wt.trace, 'utf8').trim().split('\n').filter(Boolean) }));
      }));
    const results = await Promise.all(runs);
    for (const result of results) expect(result.code, result.calls.join('\n')).toBe(0);
    const calls = results.flatMap((result) => result.calls);
    expect(calls.filter((call) => /^simctl:create rarog-ios-test-\d+-template /.test(call))).toHaveLength(1);
    expect(starting(calls, 'simctl:rename')).toHaveLength(1);
    expect(starting(calls, 'simctl:clone')).toHaveLength(2);
    expect(simulators(shared)).toEqual([TEMPLATE]);
  });

  it('a failed clone falls back to a new simulator of its own and says so in one line', () => {
    const wt = makeWorktree();
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests'], { MOCK_CLONE_FAIL: '1' });
    expect(result.status, result.output).toBe(0);
    expect(result.output.match(/could not clone the template simulator.*creating a new simulator/g)).toHaveLength(1);
    const own = ownSim(result.output);
    expect(result.calls).toContain(`simctl:create rarog-ios-test-${/rarog-ios-test-(\d+)-template/.exec(
      result.calls.join('\n'))?.[1]} iPad Pro 11-inch (M5)`);
    expect(starting(result.calls, 'xcodebuild:')[0]).toContain(` -destination id=${own}`);
    expect(result.calls).toContain(`simctl:delete ${own}`);
    expect(registry(wt)).toEqual([TEMPLATE]);
  });

  it('a template that does not boot is deleted and the run goes on a new simulator, with one line', () => {
    const wt = makeWorktree();
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests'], { MOCK_BOOT_FAIL: '1' });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/no template simulator: .*creating a new simulator/);
    expect(starting(result.calls, 'simctl:rename')).toEqual([]);
    expect(starting(result.calls, 'simctl:clone')).toEqual([]);
    expect(registry(wt)).toEqual([]);
  });

  it('a boot over the boot limit does not end the run: no template, a new simulator, xcodebuild still runs', () => {
    const wt = makeWorktree();
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests'], { MOCK_BOOT_SLEEP: '4', RAROG_IOS_BOOT_LIMIT: '1' });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/boot-template over 1 s \(the boot limit\)/);
    expect(result.output).toMatch(/no template simulator: .*creating a new simulator/);
    expect(result.output).toMatch(/boot-simulator over 1 s \(the boot limit\)/);
    expect(result.output).toMatch(/did not report a finished boot; xcodebuild boots it itself/);
    expect(starting(result.calls, 'xcodebuild')).toHaveLength(1);
    expect(starting(result.calls, 'simctl:rename')).toEqual([]);
    expect(registry(wt)).toEqual([]);
  });

  it('without an iOS runtime in the list the run uses a new simulator, as before templates', () => {
    const wt = makeWorktree();
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests'], { MOCK_NO_RUNTIME: '1' });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/no template simulator: no iOS simulator runtime/);
    expect(starting(result.calls, 'simctl:create')).toHaveLength(1);
    expect(registry(wt)).toEqual([]);
  });

  it('a red run keeps its full log and names it; a green run leaves no log', () => {
    const wt = makeWorktree();
    const red = run(wt, ['RarogUIKitTests/HeaderChromeTests'], { MOCK_XCODE_EXIT: '65' });
    const log = /full log: (\S+)/.exec(red.output)?.[1] ?? '';
    expect(log, red.output).toMatch(/test-Rarog\.log$/);
    expect(readFileSync(log, 'utf8')).toContain('** TEST FAILED **');
    expect(red.output).toContain("testA]' failed");
    const green = run(wt, ['RarogUIKitTests/HeaderChromeTests']);
    expect(green.status, green.output).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it('a run over RAROG_IOS_TEST_LIMIT stops xcodebuild with code 124 and still deletes its simulator', () => {
    const wt = makeWorktree();
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests'], { MOCK_XCODE_HANG: '1', RAROG_IOS_TEST_LIMIT: '1' });
    expect(result.status, result.output).toBe(124);
    expect(result.output).toContain('over 1 s');
    expect(result.calls).toContain(`simctl:delete ${ownSim(result.output)}`);
    expect(registry(wt)).toEqual([TEMPLATE]);
  });

  it('a step that ignores SIGTERM is killed after the limit: code 124, the simulator deleted, nothing left alive', {
    timeout: 30_000,
  }, () => {
    const wt = makeWorktree();
    const started = Date.now();
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests'], {
      MOCK_XCODE_IGNORE_TERM: '1', RAROG_IOS_TEST_LIMIT: '1' });
    expect(result.status, result.output).toBe(124);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.output).toContain('over 1 s');
    const own = ownSim(result.output);
    expect(starting(result.calls, 'simctl:').slice(-2)).toEqual([`simctl:shutdown ${own}`, `simctl:delete ${own}`]);
    expect(registry(wt)).toEqual([TEMPLATE]);
    const pid = pidOf(result.calls);
    expect(Number.isInteger(pid), result.calls.join('\n')).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it('SIGTERM to the run stops a step that ignores SIGTERM, the demo and the simulator, and frees the port', {
    timeout: 30_000,
  }, async () => {
    const wt = makeWorktree();
    writeFileSync(wt.trace, '');
    const child = spawn('/bin/bash', [join(wt.root, 'scripts/ios-test.sh'), XCUITEST], {
      env: scriptEnv(wt, { MOCK_XCODE_IGNORE_TERM: '1', MOCK_BUSY_PORTS: busyExcept(18977) }), stdio: 'ignore' });
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    const calls = (): string[] => readFileSync(wt.trace, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = 0; i < 100 && !starting(calls(), 'xcodepid:').length; i++) {
      await new Promise((ready) => setTimeout(ready, 100));
    }
    const started = Date.now();
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = pidOf(calls());
    expect(Number.isInteger(pid), calls().join('\n')).toBe(true);
    expect(alive(pid)).toBe(false);
    expect(calls()).toContain('demo-stop:18977');
    // Przerwany przebieg kasuje swój klon; zostaje sam wzorzec.
    const clone = /simctl:bootstatus (\S+) -b/.exec(calls().filter((call) => call.startsWith('simctl:')).at(-3) ?? '');
    expect(calls()).toContain(`simctl:delete ${clone?.[1]}`);
    expect(registry(wt)).toEqual([TEMPLATE]);
    expect(reservations()).toEqual([]);
  });

  it('XCUITest gets a fresh demo on a free port, never 8930 or 18931, through the environment, stopped at the end', () => {
    const wt = makeWorktree();
    const result = run(wt, [XCUITEST], { MOCK_BUSY_PORTS: busyExcept(18977) });
    expect(result.status, result.output).toBe(0);
    expect(starting(result.calls, 'demo-start:')).toEqual(['demo-start:18977']);
    expect(starting(result.calls, 'demo-stop:')).toEqual(['demo-stop:18977']);
    expect(starting(result.calls, 'xcodeenv:')).toEqual([`xcodeenv:${wt.root}:pl:18977:push`]);
    const [call = ''] = starting(result.calls, 'xcodebuild:');
    expect(call).toContain(' -only-testing:RarogUITests/FlowUITests/testPairListTranscriptSendEcho');
    expect(call).not.toContain('DEMO_PORT');
    expect(result.calls.indexOf('demo-stop:18977')).toBeGreaterThan(result.calls.indexOf(call));
    const probed = starting(result.calls, 'lsof:').map((line) => Number(line.split(':')[2]));
    expect(probed.every((port) => port >= 18940 && port <= 18989), probed.join(' ')).toBe(true);
    expect(reservations()).toEqual([]);
  });

  it('a port reserved by another live run is skipped; the reservation stays untouched', () => {
    const wt = makeWorktree();
    const lock = join(portLocks, '18977');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(process.pid));
    try {
      const result = run(wt, [XCUITEST], { MOCK_BUSY_PORTS: busyExcept(18977) });
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('no free demo port');
      expect(starting(result.calls, 'demo-start:')).toEqual([]);
      expect(starting(result.calls, 'xcodebuild:')).toEqual([]);
      expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid));
      expect(reservations()).toEqual(['18977']);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it('a reservation left by a dead run is taken over and released at the end', () => {
    const wt = makeWorktree();
    const dead = spawnSync('/usr/bin/true').pid;
    const lock = join(portLocks, '18977');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(dead));
    try {
      const result = run(wt, [XCUITEST], { MOCK_BUSY_PORTS: busyExcept(18977) });
      expect(result.status, result.output).toBe(0);
      expect(starting(result.calls, 'demo-start:')).toEqual(['demo-start:18977']);
      expect(starting(result.calls, 'xcodeenv:')).toEqual([`xcodeenv:${wt.root}:pl:18977:push`]);
      expect(reservations()).toEqual([]);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  it('an own demo that exits before it is ready loses its port even when a foreign /health answers there', () => {
    const wt = makeWorktree();
    writeFileSync(join(wt.root, '.demo-fail'), 'first');
    const result = run(wt, [XCUITEST], { MOCK_BUSY_PORTS: busyExcept(18977, 18978), MOCK_CURL_ALWAYS: '1' });
    expect(result.status, result.output).toBe(0);
    const ports = starting(result.calls, 'demo-start:').map((line) => Number(line.split(':')[1]));
    expect(ports.sort()).toEqual([18977, 18978]);
    const [first, second] = starting(result.calls, 'demo-start:').map((line) => line.split(':')[1]);
    expect(first).not.toBe(second);
    expect(starting(result.calls, 'xcodeenv:')).toEqual([`xcodeenv:${wt.root}:pl:${second}:push`]);
    expect(starting(result.calls, 'demo-stop:')).toEqual([`demo-stop:${second}`]);
    expect(reservations()).toEqual([]);
  });

  it('an own demo that keeps exiting ends the run with a sentence and no tests; no reservation is left', () => {
    const wt = makeWorktree();
    writeFileSync(join(wt.root, '.demo-fail'), 'always');
    const result = run(wt, [XCUITEST], { MOCK_CURL_ALWAYS: '1' });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('demo server exited before it was ready');
    expect(starting(result.calls, 'demo-start:')).toHaveLength(3);
    expect(starting(result.calls, 'xcodebuild:')).toEqual([]);
    expect(result.calls).toContain(`simctl:delete ${ownSim(result.output)}`);
    expect(reservations()).toEqual([]);
  });

  it('a package UIKit class goes through the package scheme from the package directory', () => {
    const wt = makeWorktree(['RarogTerminal']);
    const result = run(wt, ['RarogTerminalTests/SwiftTermSurfaceTests']);
    expect(result.status, result.output).toBe(0);
    const builds = starting(result.calls, 'xcodebuild:');
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatch(/^xcodebuild:test -scheme RarogTerminal /);
    expect(builds[0]).toContain(' -only-testing:RarogTerminalTests/SwiftTermSurfaceTests');
    expect(builds[0]).toContain(' -testLanguage pl -testRegion PL');
    expect(builds[0]).toMatch(/-derivedDataPath \S+\/RarogTerminal /);
    expect(starting(result.calls, 'xcodeenv:')).toEqual([
      `xcodeenv:${wt.root}/native/Rarog/Packages/RarogTerminal:pl:unset:`]);
  });
});

describe('ios-test: no gate lock, no choice of its own', RUN_TIMEOUT, () => {
  it('runs while the full gate holds its lock and leaves the lock untouched', () => {
    const wt = makeWorktree();
    const lock = join(wt.root, 'gate.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), String(process.pid));
    const result = run(wt, ['RarogUIKitTests/HeaderChromeTests'], { RAROG_IOS_LOCK: lock });
    expect(result.status, result.output).toBe(0);
    expect(readdirSync(lock)).toEqual(['pid']);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid));
    const source = readFileSync(join(repo, 'scripts/ios-test.sh'), 'utf8');
    expect(source).not.toContain('rarog-ios-check.lock');
    expect(source).not.toContain('RAROG_IOS_LOCK');
    expect(source).not.toMatch(/source .*ios-check\.sh/);
  });

  it.each([
    [[] as string[]],
    [['RarogUITests']],
    [['--package']],
    [['--filter', 'CardsTests']],
    [['--build', 'RarogUIKitTests/HeaderChromeTests']],
  ])('refuses %j without running anything', (args) => {
    const wt = makeWorktree();
    const result = run(wt, args);
    expect(result.status, result.output).not.toBe(0);
    expect(result.calls).toEqual([]);
  });

  it('without arguments it says it never picks tests itself', () => {
    const result = run(makeWorktree(), []);
    expect(result.status).toBe(2);
    expect(result.output).toContain('never picks tests itself');
  });

  it('an unknown target or package is an error before any simulator exists', () => {
    const wt = makeWorktree();
    for (const args of [['SomeTests/HeaderChromeTests'], ['--package', 'NoSuchPackage']]) {
      const result = run(wt, args);
      expect(result.status, result.output).toBe(1);
      expect(result.calls).toEqual([]);
    }
  });
});
