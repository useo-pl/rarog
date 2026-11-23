/**
 * Piaskownica testów `rarog service`: `HOME` w katalogu tymczasowym, a w nim atrapy na początku `PATH`
 * (`launchctl` ze stanem etykiet w pliku i wydrukiem domeny z pliku `domena`, `curl`, `nohup`, `pgrep`, `lsof`)
 * i wrapper-atrapa. Opis atrap: nagłówek `rarog-service.test.ts`. Przed każdym uruchomieniem dziecka
 * test woła {@link assertFakeLaunchctl}: prawdziwy `bootout` w domenie GUI testującego zatrzymałby serwer właściciela.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

export const UID = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
export const SERVICE = 'ai.rarog.server';
export const HEALTHY = '{"ok":true,"version":"t","uptime":1,"herdr":true,"term":true}';
/** Sztuczny sekret — prawdziwych testy nie znają; nie może pojawić się na wyjściu ani w plistcie. */
export const FAKE_SECRET = 'TEST-ONLY-sekret-uslugi-xxxxxxxxxxxxxxxx';
/** Wpis bloku `environment` domeny, który launchd ma zwykle (gniazdo agenta SSH); nie jest zmienną katalogu danych. */
export const SSH_AUTH_SOCK_ENTRY = 'SSH_AUTH_SOCK => /private/tmp/com.apple.launchd.AbCdEf1234/Listeners';

/**
 * Wydruk `launchctl print gui/<uid>` w kształcie pomiaru: pola domeny z jednym tabulatorem, blok `environment`
 * z wpisami `\t\tNAZWA => wartość` (każdy element `entries` to linia bez wcięcia) i blok usług.
 */
export function domainPrint(entries: readonly string[]): string {
  return [
    `gui/${UID} = {`, '\ttype = gui', `\thandle = ${UID}`,
    '\tenvironment = {', ...entries.map((entry) => `\t\t${entry}`), '\t}',
    '\tservices = {', `\t\t       0      -     ${SERVICE}`, '\t}', '}', '',
  ].join('\n');
}

export interface Sandbox {
  readonly home: TempHome;
  /** `HOME` dziecka (domyślnie katalog tymczasowy; test długiej ścieżki podaje głębszy). */
  homeDir: string;
  readonly bin: string;
  readonly logs: string;
  readonly wrapper: string;
  calls(name: string): string[];
  loaded(labels: readonly string[]): void;
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

export function makeSandbox(): Sandbox {
  // One-letter prefix: `<home>/.local/share/rarog/run/admin.sock` has to fit in 103 B together with the vitest run
  // directory.
  const home = tempHome('s');
  const bin = path.join(home.home, 'atrapy');
  const logs = path.join(home.home, 'logi');
  mkdirSync(bin);
  mkdirSync(logs);
  const fake = (file: string, lines: string[]): void => {
    writeFileSync(file, `#!/bin/bash\n${lines.join('\n')}\n`);
    chmodSync(file, 0o755);
  };
  fake(path.join(bin, 'launchctl'), [
    `printf '%s\\n' "$*" >> '${logs}/launchctl'`,
    `log='${logs}/launchctl'`,
    `state='${logs}/loaded'`,
    'touch "$state"',
    'case "$1" in',
    '  print)',
    // Domena bez etykiety (`print gui/<uid>`): wydruk z pliku `domena`; plik `domena-pada` = kod 5, `domena-zabita`
    // = SIGKILL.
    '    if [[ "$2" != */*/* ]]; then',
    `      if [ -f '${logs}/domena-pada' ]; then echo "Could not print domain: 5: Input/output error" >&2; exit 5; fi`,
    `      if [ -f '${logs}/domena-zabita' ]; then kill -KILL $$; fi`,
    `      cat '${logs}/domena'; exit 0`,
    '    fi',
    // „Nie wiem” (kod 5) dla etykiety `FAKE_UNKNOWN` od jej `FAKE_UNKNOWN_FROM`-tego pytania (domyślnie od pierwszego).
    '    if [ "${FAKE_UNKNOWN:-}" = "${2##*/}" ] && [ "$(grep -cxF "print $2" "$log")" -ge "${FAKE_UNKNOWN_FROM:-1}" ]; then',
    '      echo "Could not print: 5: Input/output error" >&2; exit 5',
    '    fi',
    // Etykieta po `bootout` jeszcze N pytań „załadowana” (`never` = zawsze), jak launchd przy `KeepAlive`.
    '    lag="$log.lag-${2##*/}"',
    '    if [ -f "$lag" ]; then',
    '      n=$(cat "$lag")',
    '      if [ "$n" = never ]; then exit 0; fi',
    '      if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$lag"; exit 0; fi',
    '    fi',
    '    grep -qxF "${2##*/}" "$state" && exit 0 || exit 113 ;;',
    '  bootout)',
    '    if [ -n "${FAKE_BOOTOUT_FAIL:-}" ]; then echo "Boot-out failed: 5: Input/output error" >&2; exit 5; fi',
    '    grep -vxF "${2##*/}" "$state" > "$state.tmp" || true; mv "$state.tmp" "$state"',
    '    if [ -n "${FAKE_BOOTOUT_LAG:-}" ]; then echo "$FAKE_BOOTOUT_LAG" > "$log.lag-${2##*/}"; fi',
    '    exit 0 ;;',
    '  bootstrap)',
    `    if [ -d "\${FAKE_EXPECT_DIR:-/nieistniejacy}" ]; then echo katalog-jest >> '${logs}/bootstrap'; fi`,
    '    if [ -n "${FAKE_BOOTSTRAP_FAIL:-}" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi',
    '    basename "$3" .plist >> "$state"; exit 0 ;;',
    '  kickstart) sleep "${FAKE_KICKSTART_SLEEP:-0}"; exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
  ]);
  writeFileSync(path.join(logs, 'domena'), domainPrint([SSH_AUTH_SOCK_ENTRY]));
  fake(path.join(bin, 'curl'), [`printf '%s\\n' "$*" >> '${logs}/curl'`, 'printf \'%s\' "${FAKE_HEALTH:-}"']);
  fake(path.join(bin, 'nohup'), [`printf '%s\\n' "$*" >> '${logs}/nohup'`]);
  fake(path.join(bin, 'pgrep'), ['exit 1']);
  fake(path.join(bin, 'lsof'), ['exit 0']);
  // Wrapper-atrapa: środowisko widzi takie, jakie da launchd (bez zmiennych testu), więc sterują nim pliki.
  const wrapper = path.join(home.home, 'wrapper', 'secret-env.sh');
  mkdirSync(path.dirname(wrapper));
  fake(wrapper, [
    `printf '%s\\n' "$*" >> '${logs}/wrapper'`,
    `env | sort > '${logs}/wrapper-env'`,
    `if [ -f '${logs}/wrapper-pada' ]; then echo "wrapper: brak sekretów" >&2; exit 7; fi`,
    `if [ ! -f '${logs}/wrapper-bez-sekretow' ]; then export SONIOX_API_KEY='${FAKE_SECRET}'; fi`,
    // Plik `wrapper-export` (linie `export NAZWA=…`): zmienne, które wrapper dokłada przed `exec`.
    `if [ -f '${logs}/wrapper-export' ]; then . '${logs}/wrapper-export'; fi`,
    'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done',
    'shift',
    'exec "$@"',
  ]);
  const box: Sandbox = {
    home, homeDir: home.home, bin, logs, wrapper,
    calls: (name) => {
      const file = path.join(logs, name);
      return existsSync(file) ? readFileSync(file, 'utf8').trimEnd().split('\n').filter((l) => l !== '') : [];
    },
    loaded: (labels) => { writeFileSync(path.join(logs, 'loaded'), labels.map((l) => `${l}\n`).join('')); },
    env: (extra = {}) => ({
      // Atrapy PRZED `/bin`: prawdziwy `launchctl` nie może tu nic zrobić.
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: box.homeDir,
      USER: process.env['USER'] ?? 'test',
      ...(process.env['TMPDIR'] === undefined ? {} : { TMPDIR: process.env['TMPDIR'] }),
      FAKE_HEALTH: HEALTHY,
      ...extra,
    }),
  };
  return box;
}

export interface Run { status: number | null; stdout: string; stderr: string }

/** Atrapa `launchctl` musi być pierwsza w `PATH` dziecka — inaczej test nie startuje niczego. */
export function assertFakeLaunchctl(box: Sandbox, env: NodeJS.ProcessEnv): void {
  const found = spawnSync('bash', ['-c', 'command -v launchctl'], { env, encoding: 'utf8' }).stdout.trim();
  expect(found).toBe(path.join(box.bin, 'launchctl'));
}

/** Atrapa paczki npm na dysku: korzeń i wejście, które wpisuje do usługi `service install` paczki. */
export interface FakePackage {
  readonly root: string;
  readonly bin: string;
}

/**
 * Paczka npm Raroga w układzie npm (`<prefiks>/lib/node_modules/rarog`) z wersją w `package.json`: `bin/rarog.mjs`
 * i zbudowany `server/src/cli/main.js`, po którym `installModeAt` rozpoznaje tryb paczki. Bez `main.js` = inny klon.
 */
export function fakePackage(prefix: string, version: string, { built = true }: { built?: boolean } = {}): FakePackage {
  const root = path.join(prefix, 'lib', 'node_modules', 'rarog');
  const bin = path.join(root, 'bin', 'rarog.mjs');
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, '');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'rarog', version }));
  if (built) {
    mkdirSync(path.join(root, 'server', 'src', 'cli'), { recursive: true });
    writeFileSync(path.join(root, 'server', 'src', 'cli', 'main.js'), '');
  }
  return { root, bin };
}

/** Wywołanie `launchctl`, które tylko pyta (`print` etykiety albo domeny). */
export const asking = (call: string): boolean => call.startsWith('print ');

export const target = (label: string): string => `gui/${UID}/${label}`;
