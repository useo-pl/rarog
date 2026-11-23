/*
 * `scripts/ios-push.sh` — push z hosta dla XCUITest apki natywnej (`scripts/ios-check.sh`).
 *
 * Testujemy ZACHOWANIE biblioteki (źródłowanej przez bash) z atrapą `xcrun` na PATH, bez Xcode
 * i bez symulatora:
 * - UDID symulatora po nazwie z tekstowego `simctl list`: najnowszy runtime iOS przy `latest`, dokładna
 *   wersja, nazwa z nawiasami, brak = pusto;
 * - przekaźnik wysyła ładunek `simctl push` na wskazany symulator i odpisuje `.sent` — `ok` albo
 *   `fail: <ostatnia linia błędu>` (test UI pokazuje ją w porażce, np. apka bez zgody).
 *
 * Lint tego pliku jedzie w `pnpm run check` (glob `scripts/*.sh`), nie tutaj.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { iosBundleId } from './product-identity.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = path.join(repoRoot, 'scripts/ios-push.sh');

// Tekstowe `simctl list devices available` (nazwa sama może mieć nawiasy, linie kończą się spacją).
const DEVICES = [
  '== Devices ==',
  '-- iOS 26.2 --',
  '    rarog-ipad (00000000-0000-0000-0000-000000000026) (Shutdown) ',
  '-- iOS 27.0 --',
  '    rarog-ipad (00000000-0000-0000-0000-000000000027) (Booted) ',
  '    iPad Pro 11-inch (M5) (00000000-0000-0000-0000-0000000000A5) (Shutdown) ',
  '-- watchOS 12.0 --',
  '    rarog-ipad (00000000-0000-0000-0000-0000000000AA) (Shutdown) ',
].join('\n');

/** Katalogi tymczasowe założone przez ten plik: `afterAll` kasuje je i sprawdza, że żaden nie został w `$TMPDIR`. */
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Katalog z atrapą `xcrun`: `simctl list` oddaje listę, `simctl push` notuje argumenty. */
function fakeXcrun(): { bin: string; calls: string } {
  const dir = tempDir('rarog-ios-push-');
  const calls = path.join(dir, 'calls.log');
  writeFileSync(path.join(dir, 'devices.txt'), `${DEVICES}\n`);
  const script = `#!/usr/bin/env bash
if [[ "$1 $2" == "simctl list" ]]; then cat "${dir}/devices.txt"; exit 0; fi
if [[ "$1 $2" == "simctl push" ]]; then
  echo "$3 $4 $(basename "$5")" >> "${calls}"
  if grep -q ODMOWA "$5"; then
    echo "An error was encountered processing the command (domain=UNErrorDomain, code=2003):" >&2
    echo "	Repository could not save notification. Source is not authorized." >&2
    exit 211
  fi
  echo "Notification sent"
  exit 0
fi
exit 64
`;
  const bin = path.join(dir, 'xcrun');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return { bin: dir, calls };
}

function bash(script: string, bin: string): { status: number | null; stdout: string } {
  const env = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` };
  const res = spawnSync('bash', ['-c', `source "${LIB}"\n${script}`], { encoding: 'utf8', env });
  return { status: res.status, stdout: res.stdout.trim() };
}

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  expect(tempDirs.filter((dir) => existsSync(dir))).toEqual([]);
});

describe('ios-push.sh — UDID symulatora po nazwie', () => {
  it('`latest` = najnowszy runtime iOS z tą nazwą; wersja dokładna; nawiasy w nazwie; obca nazwa = pusto', () => {
    const { bin } = fakeXcrun();
    expect(bash('ios_sim_udid rarog-ipad latest', bin).stdout).toBe('00000000-0000-0000-0000-000000000027');
    expect(bash('ios_sim_udid rarog-ipad 26.2', bin).stdout).toBe('00000000-0000-0000-0000-000000000026');
    expect(bash('ios_sim_udid rarog-ipad 27', bin).stdout).toBe('00000000-0000-0000-0000-000000000027');
    expect(bash("ios_sim_udid 'iPad Pro 11-inch (M5)' latest", bin).stdout).toBe('00000000-0000-0000-0000-0000000000A5');
    expect(bash('ios_sim_udid brak latest', bin).stdout).toBe('');
    expect(bash('ios_sim_udid rarog-ipad 25', bin).stdout).toBe('');
  });
});

describe('ios-push.sh — przekaźnik `simctl push`', () => {
  it('ładunek idzie na wskazany symulator i apkę; `.sent` = `ok` albo `fail: <ostatnia linia błędu>`', async () => {
    const { bin, calls } = fakeXcrun();
    const signals = tempDir('rarog-ios-push-signals-');
    // Bundle id jak w bramce (`ios-check.sh` podaje `$IOS_BUNDLE_ID` ze `scripts/ios-identity.sh`).
    const app = iosBundleId();
    const relay = spawn('bash', ['-c', `source "${LIB}"\nios_push_relay "${signals}" SIM-27 "${app}"`], {
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      stdio: 'ignore',
    });
    cleanup.push(() => relay.kill('SIGKILL'));

    // Test UI pisze `.tmp` i zmienia nazwę na `.request` (atomowo) — przekaźnik czyta tylko `.request`.
    writeFileSync(path.join(signals, 'a.tmp'), '{"aps":{"alert":"x"},"rarog":{"v":1,"kind":"test"}}');
    renameSync(path.join(signals, 'a.tmp'), path.join(signals, 'a.request'));
    writeFileSync(path.join(signals, 'b.tmp'), '{"aps":{"alert":"ODMOWA"}}');
    renameSync(path.join(signals, 'b.tmp'), path.join(signals, 'b.request'));

    const sent = (name: string): string => readFileSync(path.join(signals, `${name}.sent`), 'utf8').trim();
    expect(await waitFor(() => existsSync(path.join(signals, 'a.sent')) && existsSync(path.join(signals, 'b.sent')))).toBe(true);
    expect(sent('a')).toBe('ok');
    expect(sent('b')).toBe('fail: \tRepository could not save notification. Source is not authorized.');
    expect(existsSync(path.join(signals, 'a.request'))).toBe(false);
    expect(existsSync(path.join(signals, 'a.done'))).toBe(true);
    expect(readFileSync(calls, 'utf8').trim().split('\n').sort()).toEqual([
      `SIM-27 ${app} a.request`,
      `SIM-27 ${app} b.request`,
    ]);
  });
});
