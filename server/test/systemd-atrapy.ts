/**
 * Atrapy Linuksa z `systemd --user` dla testów `rarog restart|service|doctor`. Kształt wyjść powtarza pomiar na
 * prawdziwym systemd 255 (Ubuntu 24.04, procps-ng 4.0.4):
 *
 * - `systemctl --user show rarog.service -p …`: `Klucz=wartość` w kolejności systemd, nie zapytania; brak jednostki
 *   to kod 0 i `LoadState=not-found`; bez magistrali kod 1 „Failed to connect to bus: No medium found”;
 *   `restart` brakującej jednostki kod 5, `daemon-reload`, `enable`, `disable --now`;
 * - `busctl --user --json=short get-property … Manager Environment|UnitPath`: `{"type":"as","data":[…]}`;
 * - `loginctl show-user <user> -p Linger --value`: `yes`/`no`;
 * - `ps`: `-E…` to „error: unsupported SysV option”, kod 1; `eww` (forma BSD) daje polecenie i środowisko po
 *   spacji — atrapa oddaje to z prawdziwego `ps` gospodarza (`-Eww` na macOS), ten sam kształt;
 * - `ss -Hltnp 'sport = :<port>'`: `users:(("node",pid=<n>,fd=<n>),…)`, kilka `pid=` w jednej linii;
 * - `uname -s`: `Linux` (albo treść pliku stanu `uname`).
 *
 * Stan atrap to pliki w katalogu `stan/` (nazwa = właściwość albo przełącznik), log wywołań w `logi/<narzędzie>`.
 * Domyślnie jednostka jest `loaded`, gdy w `$HOME/.config/systemd/user/` leży `rarog.service`, inaczej
 * `not-found` — tak jak w prawdziwym menedżerze po `daemon-reload`. `HOME` w katalogu tymczasowym ({@link tempHome}).
 * `show` innej jednostki (`herdr.service` z `rarog setup`) czyta jej plik w tym samym katalogu i pliki stanu
 * z przedrostkiem nazwy (`herdr.service.active`, `herdr.service.enabled`, `herdr.service.LoadState`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

export const REPO = path.join(import.meta.dirname, '..', '..');
/** Wejście CLI z platformą `linux` (tylko testy). */
export const LINUX_CLI = path.join(import.meta.dirname, 'rarog-linux-cli.mjs');
export const HEALTHY = '{"ok":true,"version":"t","uptime":1,"herdr":true,"term":true}';
/** Ścieżki stanu runtime menedżera z pomiaru (użytkownik `rarog`, uid 1001). */
const RUNTIME = '/run/user/1001';
/** `PATH` of the user manager in the fake `busctl … Environment` (the measured Ubuntu 24.04 value). */
export const MANAGER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games'
  + ':/snap/bin';

export interface LinuxOptions {
  /** `lsof` w `PATH` (Ubuntu 24.04 go nie ma). */
  readonly lsof?: boolean;
  /** `ss` z iproute2 w `PATH`. */
  readonly ss?: boolean;
}

export interface LinuxSandbox {
  readonly home: TempHome;
  readonly homeDir: string;
  readonly bin: string;
  /** Same narzędzia systemowe, których używają atrapy (`cat`, `rm`, `touch`) — do `PATH` bez `/usr/bin`. */
  readonly sys: string;
  /** Systemowa część `PATH` dziecka: `/usr/bin:/bin` bez narzędzi gospodarza z {@link HOST_ONLY_FAKES}. */
  readonly systemPath: string;
  readonly logs: string;
  readonly state: string;
  /** Linie logu atrapy; brak pliku = atrapa nie była wołana. */
  calls(name: string): string[];
  /** Plik stanu atrapy (`LoadState`, `bus-down`, `health`…); `null` usuwa. */
  set(name: string, value: string | null): void;
  /** Środowisko menedżera użytkownika (`busctl … Environment`), domyślnie kształt z pomiaru z `HOME` testu. */
  managerEnv(extra?: Readonly<Record<string, string>>): void;
  /** Środowisko dziecka: atrapy pierwsze w `PATH`, `HOME` testu, bez `XDG_DATA_HOME` i `RAROG_DATA_DIR`. */
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  cleanup(): void;
}

/** Skrypt bash o podanych liniach, wykonywalny (atrapa narzędzia albo wrappera). */
export function fake(file: string, lines: readonly string[]): void {
  writeFileSync(file, `#!/bin/bash\n${lines.join('\n')}\n`);
  chmodSync(file, 0o755);
}

/** Linia „żywe PID-y z pliku stanu” (zombie i martwe pomijane, jak prawdziwy `lsof`). */
function alivePids(stateFile: string): string[] {
  return [
    'alive=()',
    `for p in $(cat '${stateFile}' 2>/dev/null); do`,
    '  st="$(/bin/ps -p "$p" -o stat= 2>/dev/null || true)"',
    '  case "$st" in \'\'|Z*) ;; *) alive+=("$p") ;; esac',
    'done',
  ];
}

/**
 * Narzędzia, które w piaskownicy dają WYŁĄCZNIE atrapy ({@link LinuxOptions}): Ubuntu z pomiaru nie ma `lsof`,
 * a `ss` ma kształt z pomiaru. Obraz runnera GitHuba `ubuntu-latest` ma oba w `/usr/bin`, więc goły `/usr/bin:/bin`
 * w `PATH` dziecka wpuściłby prawdziwe: `restart.sh` brał wtedy `lsof` gospodarza (nasłuchu atrapy nie widzi)
 * zamiast atrapy `ss`.
 */
const HOST_ONLY_FAKES = ['lsof', 'ss'] as const;
const SYSTEM_DIRS = ['/usr/bin', '/bin'] as const;

/**
 * `/usr/bin:/bin` bez {@link HOST_ONLY_FAKES}: gdy gospodarz ich tam nie ma (macOS: `lsof` w `/usr/sbin`), same
 * katalogi; inaczej katalog `dir` z dowiązaniami do wszystkich pozostałych programów obu katalogów (pierwszy wygrywa,
 * jak w `PATH`).
 */
function systemPathWithoutHostFakes(dir: string): string {
  const leaks = HOST_ONLY_FAKES.filter((tool) => SYSTEM_DIRS.some((sysDir) => existsSync(path.join(sysDir, tool))));
  if (leaks.length === 0) return SYSTEM_DIRS.join(':');
  mkdirSync(dir);
  const seen = new Set<string>(HOST_ONLY_FAKES);
  for (const sysDir of SYSTEM_DIRS) {
    for (const name of readdirSync(sysDir)) {
      if (seen.has(name)) continue;
      seen.add(name);
      symlinkSync(path.join(sysDir, name), path.join(dir, name));
    }
  }
  return dir;
}

export function linuxSandbox(prefix: string, options: LinuxOptions = {}): LinuxSandbox {
  const home = tempHome(prefix);
  const homeDir = home.home;
  const bin = path.join(homeDir, 'atrapy');
  const logs = path.join(homeDir, 'logi');
  const state = path.join(homeDir, 'stan');
  const sys = path.join(homeDir, 'systemowe');
  for (const dir of [bin, sys, logs, state]) mkdirSync(dir);
  const systemPath = systemPathWithoutHostFakes(path.join(homeDir, 'system-bez-lsof-ss'));
  for (const tool of ['cat', 'rm', 'touch']) {
    const found = spawnSync('/bin/bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(found, path.join(sys, tool));
  }
  const log = (name: string): string => `printf '%s\\n' "$*" >> '${logs}/${name}'`;
  const unitFile = '$HOME/.config/systemd/user/rarog.service';

  fake(path.join(bin, 'uname'), [log('uname'), `if [ -f '${state}/uname' ]; then cat '${state}/uname'; else echo Linux; fi`]);
  fake(path.join(bin, 'systemctl'), [
    log('systemctl'),
    `S='${state}'`,
    `if [ -f "$S/bus-down" ]; then echo "Failed to connect to bus: No medium found" >&2; exit 1; fi`,
    `F="${unitFile}"; P=''`,
    // `show` innej jednostki (`herdr.service`): jej plik i pliki stanu z przedrostkiem `<jednostka>.`.
    'if [ "$2" = show ] && [ "$3" != rarog.service ]; then F="$HOME/.config/systemd/user/$3"; P="$3."; fi',
    'if [ -f "$S/${P}LoadState" ]; then load="$(cat "$S/${P}LoadState")";',
    'elif [ -e "$F" ] || [ -L "$F" ]; then load=loaded; else load=not-found; fi',
    'prop() {',
    '  if [ -f "$S/$P$1" ]; then cat "$S/$P$1"; return; fi',
    '  case "$1" in',
    '    LoadState) echo "$load" ;;',
    '    FragmentPath) [ "$load" = not-found ] || echo "$F" ;;',
    '    NeedDaemonReload) echo no ;;',
    '    ActiveState) if [ -f "$S/${P}active" ]; then echo active; else echo inactive; fi ;;',
    '    UnitFileState) [ "$load" = not-found ] || { [ -f "$S/${P}enabled" ] && echo enabled || echo disabled; } ;;',
    '  esac',
    '}',
    '[ "$1" = --user ] || exit 1',
    'shift',
    'case "$1" in',
    '  show)',
    '    shift 2; wanted=" "',
    '    while [ "$#" -gt 0 ]; do [ "$1" = -p ] && wanted="$wanted$2 "; shift 2; done',
    // Kolejność wyjścia jak w systemd (pomiar RAW 1/2), nie jak w zapytaniu.
    '    for p in LoadState ActiveState FragmentPath DropInPaths NeedDaemonReload UnitFileState Environment \\',
    '      EnvironmentFiles PassEnvironment UnsetEnvironment; do',
    '      case "$wanted" in *" $p "*) printf \'%s=%s\\n\' "$p" "$(prop "$p")" ;; esac',
    '    done',
    '    exit 0 ;;',
    '  daemon-reload) exit "$(cat "$S/daemon-reload-rc" 2>/dev/null || echo 0)" ;;',
    '  enable)',
    '    rc="$(cat "$S/enable-rc" 2>/dev/null || echo 0)"',
    `    if [ "$rc" = 0 ]; then touch "$S/enabled"; echo "Created symlink $HOME/.config/systemd/user/default.target.wants/$2 → ${unitFile}."; else echo "Failed to enable unit: Unit file $2 does not exist." >&2; fi`,
    '    exit "$rc" ;;',
    '  restart)',
    '    if [ "$load" = not-found ]; then echo "Failed to restart $2: Unit $2 not found." >&2; exit 5; fi',
    '    rc="$(cat "$S/restart-rc" 2>/dev/null || echo 0)"',
    '    if [ "$rc" = 0 ]; then touch "$S/active"; else echo "Job for $2 failed because the control process exited with error code." >&2; fi',
    '    exit "$rc" ;;',
    '  disable)',
    '    rc="$(cat "$S/disable-rc" 2>/dev/null || echo 0)"',
    '    if [ "$rc" = 0 ]; then rm -f "$S/enabled" "$S/active"; echo "Removed \\"$HOME/.config/systemd/user/default.target.wants/$3\\"."; else echo "Failed to disable unit." >&2; fi',
    '    exit "$rc" ;;',
    'esac',
    'exit 1',
  ]);
  fake(path.join(bin, 'busctl'), [
    log('busctl'),
    `S='${state}'`,
    'if [ -f "$S/bus-down" ] || [ -f "$S/busctl-down" ]; then',
    '  echo "Failed to set bus address: \\$DBUS_SESSION_BUS_ADDRESS and \\$XDG_RUNTIME_DIR not defined (consider using --machine=<user>@.host --user to connect to bus of other user)" >&2',
    '  exit 1',
    'fi',
    // `--user --json=short get-property <usługa> <obiekt> <interfejs> <właściwość>`
    'cat "$S/manager-$7.json"',
  ]);
  fake(path.join(bin, 'loginctl'), [
    log('loginctl'),
    `if [ -f '${state}/loginctl-down' ]; then echo "Failed to get user: No such device or address" >&2; exit 1; fi`,
    `cat '${state}/linger' 2>/dev/null || echo yes`,
  ]);
  fake(path.join(bin, 'ps'), [
    log('ps'),
    'case "$1" in',
    '  -E*) printf \'error: unsupported SysV option\\n\\nUsage:\\n ps [options]\\n\' >&2; exit 1 ;;',
    // Prawdziwy `ps` gospodarza testów: na macOS ten kształt daje `-Eww`, na Linuksie `eww`.
    `  eww) shift; exec /bin/ps ${process.platform === 'darwin' ? '-Eww' : 'eww'} "$@" ;;`,
    '  *) exec /bin/ps "$@" ;;',
    'esac',
  ]);
  fake(path.join(bin, 'pgrep'), [
    log('pgrep'),
    ...alivePids(`${state}/pattern-pids`),
    '[ "${#alive[@]}" -gt 0 ] || exit 1',
    'printf \'%s\\n\' "${alive[@]}"',
  ]);
  if (process.platform === 'darwin') {
    // Katalog roboczy kandydata z wzorca stopu (`readlink /proc/<pid>/cwd` w `restart.sh`): gospodarz macOS nie ma
    // `/proc`, więc ten sam fakt daje jego `lsof`. Na Linuksie działa prawdziwy `readlink` z `PATH`.
    fake(path.join(bin, 'readlink'), [
      'case "$1" in',
      '  /proc/*/cwd) p="${1#/proc/}"; /usr/sbin/lsof -a -p "${p%/cwd}" -d cwd -Fn 2>/dev/null | sed -n \'s/^n//p\';'
        + ' exit 0 ;;',
      'esac',
      'exec /usr/bin/readlink "$@"',
    ]);
  }
  if (options.lsof === true) {
    fake(path.join(bin, 'lsof'), [log('lsof'), ...alivePids(`${state}/listeners`),
      '[ "${#alive[@]}" -gt 0 ] || exit 1', 'printf \'%s\\n\' "${alive[@]}"']);
  }
  if (options.ss === true) {
    fake(path.join(bin, 'ss'), [
      log('ss'),
      ...alivePids(`${state}/listeners`),
      '[ "${#alive[@]}" -gt 0 ] || exit 0',
      'users=""',
      'for p in "${alive[@]}"; do users="${users:+$users,}(\\"node\\",pid=$p,fd=21)"; done',
      'printf \'LISTEN 0      511    127.0.0.1:%s 0.0.0.0:* users:(%s)\\n\' "${2##*:}" "$users"',
    ]);
  }
  fake(path.join(bin, 'curl'), [
    log('curl'),
    `body="$(cat '${state}/health' 2>/dev/null || true)"`,
    '[ -n "$body" ] || exit 7',
    'printf \'%s\' "$body"',
  ]);
  for (const name of ['nohup', 'launchctl']) fake(path.join(bin, name), [log(name), 'exit 1']);

  const box: LinuxSandbox = {
    home, homeDir, bin, sys, systemPath, logs, state,
    calls: (name) => {
      const file = path.join(logs, name);
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
    },
    set: (name, value) => {
      const file = path.join(state, name);
      if (value === null) rmSync(file, { force: true });
      else writeFileSync(file, value);
    },
    managerEnv: (extra = {}) => {
      const env: Record<string, string> = {
        HOME: homeDir, LANG: 'C.UTF-8', LOGNAME: 'rarog', PATH: MANAGER_PATH,
        SHELL: '/bin/bash', USER: 'rarog', XDG_RUNTIME_DIR: RUNTIME,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${RUNTIME}/bus`, ...extra,
      };
      box.set('manager-Environment.json',
        JSON.stringify({ type: 'as', data: Object.entries(env).map(([name, value]) => `${name}=${value}`) }));
    },
    env: (extra = {}) => ({
      PATH: `${bin}:${systemPath}`,
      HOME: homeDir,
      USER: 'rarog',
      LOGNAME: 'rarog',
      XDG_RUNTIME_DIR: RUNTIME,
      ...(process.env['TMPDIR'] === undefined ? {} : { TMPDIR: process.env['TMPDIR'] }),
      ...extra,
    }),
    cleanup: () => { home.cleanup(); },
  };
  box.managerEnv();
  // `UnitPath` menedżera przy domyślnym `XDG_CONFIG_HOME` (pomiar RAW 5), z `HOME` testu.
  box.set('manager-UnitPath.json', JSON.stringify({ type: 'as', data: [
    `${homeDir}/.config/systemd/user.control`, `${RUNTIME}/systemd/user.control`, `${RUNTIME}/systemd/transient`,
    `${RUNTIME}/systemd/generator.early`, `${homeDir}/.config/systemd/user`, '/etc/xdg/systemd/user',
    '/etc/systemd/user', `${RUNTIME}/systemd/user`, '/run/systemd/user', `${RUNTIME}/systemd/generator`,
    `${homeDir}/.local/share/systemd/user`, '/usr/local/share/systemd/user', '/usr/share/systemd/user',
    '/usr/local/lib/systemd/user', '/usr/lib/systemd/user', `${RUNTIME}/systemd/generator.late`,
  ] }));
  box.set('health', HEALTHY);
  return box;
}

/** Atrapa `systemctl` jest pierwsza w `PATH` dziecka — inaczej test nie startuje niczego. */
export function assertFakeSystemctl(sb: LinuxSandbox, env: NodeJS.ProcessEnv): void {
  const found = spawnSync('/bin/bash', ['-c', 'command -v systemctl'], { env, encoding: 'utf8' }).stdout.trim();
  expect(found).toBe(path.join(sb.bin, 'systemctl'));
}

export interface Run { status: number | null; stdout: string; stderr: string }

/** `rarog <argv>` z platformą `linux` w procesie potomnym (wejście testowe {@link LINUX_CLI}). */
export function rarogLinux(sb: LinuxSandbox, argv: readonly string[], extra: NodeJS.ProcessEnv = {}): Run {
  const env = sb.env(extra);
  assertFakeSystemctl(sb, env);
  const result = spawnSync(process.execPath, [LINUX_CLI, ...argv], {
    cwd: sb.homeDir, env, encoding: 'utf8', timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * {@link rarogLinux} ASYNCHRONICZNIE: gdy komenda pyta serwer w procesie testów (`/health` w `doctor`), synchroniczny
 * `spawnSync` zablokowałby pętlę zdarzeń, która ma mu odpowiedzieć.
 */
export function rarogLinuxAsync(sb: LinuxSandbox, argv: readonly string[], extra: NodeJS.ProcessEnv = {}):
  Promise<Run> {
  const env = sb.env(extra);
  assertFakeSystemctl(sb, env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LINUX_CLI, ...argv], { cwd: sb.homeDir, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (status) => { resolve({ status, stdout, stderr }); });
  });
}

/** Węzeł usługi: skrypt wypisujący zadaną wersję (`null` = pliku nie ma). */
export function fakeNode(sb: LinuxSandbox, version: string | null): string {
  const file = path.join(sb.homeDir, 'node-uslugi', 'node');
  if (version !== null) {
    mkdirSync(path.dirname(file), { recursive: true });
    fake(file, [`echo ${version}`]);
  }
  return file;
}
