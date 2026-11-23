#!/usr/bin/env node
/**
 * Przypięcie SDK Claude dla trybu paczki: `node scripts/sdk-lock.mjs`. Pisze dwa pliki, które `rarog setup` kładzie
 * do `<katalog danych>/sdk/.tmp-*` przed `npm ci`:
 *
 * - `server/src/install/sdk-package.json`: `name`, `private` i wersja `@anthropic-ai/claude-agent-sdk`
 *   z `server/package.json` (dokładna, bez `^` i `~`); `name`, bo lockfile bez niego bierze nazwę z katalogu;
 * - `server/src/install/sdk-lock.json`: lockfile npm z `resolved` i `integrity`, wygenerowany w czystym katalogu
 *   w `os.tmpdir()` komendą `npm install --package-lock-only --legacy-peer-deps --ignore-scripts
 *   --min-release-age=7`. Bez `--legacy-peer-deps` npm dopisałby peery SDK (`@anthropic-ai/sdk`,
 *   `@modelcontextprotocol/sdk`, `zod`) z całym drzewem, które zmienia się przy każdym generowaniu.
 *   `--min-release-age=7` sprawia, że wersja SDK młodsza niż 7 dni pada `ETARGET` już tutaj.
 *
 * npm to `npm-cli.js` obok węzła, który uruchamia skrypt (ta sama reguła co w `rarog setup`), ze środowiskiem bez
 * zmiennych `npm_*`, z pustym plikiem w miejscu `~/.npmrc` i z jawnym rejestrem npm, więc wynik nie zależy od
 * konfiguracji ani poświadczeń wołającego. Sprawdzenie zgodności przypięć: `server/test/sdk-pin.test.ts`. Kody
 * wyjścia: 0 = zrobione, 1 = odmowa albo błąd npm (zdanie na stderr). Importy wyłącznie `node:*`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = '@anthropic-ai/claude-agent-sdk';
const SDK_NAME = 'rarog-sdk';
const REGISTRY = 'https://registry.npmjs.org/';
const INSTALL_DIR = path.join(ROOT, 'server', 'src', 'install');

class Refusal extends Error {}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** `npm-cli.js` obok węzła tego procesu (`<bin>/npm` po `realpath`). */
function npmCli() {
  const candidate = path.join(path.dirname(process.execPath), 'npm');
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Refusal(`no npm next to node (${candidate})`);
  }
  if (path.basename(real) !== 'npm-cli.js') throw new Refusal(`${candidate} → ${real}: expected npm-cli.js`);
  return real;
}

function main() {
  const version = readJson(path.join(ROOT, 'server', 'package.json')).dependencies?.[SDK];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Refusal(`server/package.json: ${SDK} must be an exact x.y.z version (found: ${String(version)})`);
  }
  const manifest = { name: SDK_NAME, private: true, dependencies: { [SDK]: version } };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rarog-sdk-lock-'));
  try {
    fs.writeFileSync(path.join(work, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const userconfig = path.join(work, 'empty-npmrc');
    fs.writeFileSync(userconfig, '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/iu.test(name)));
    const result = spawnSync(process.execPath, [
      npmCli(), 'install', '--package-lock-only', '--legacy-peer-deps', '--ignore-scripts', '--min-release-age=7',
      '--no-audit', '--no-fund', `--registry=${REGISTRY}`, `--userconfig=${userconfig}`,
      `--cache=${path.join(work, 'cache')}`,
    ], { cwd: work, env, encoding: 'utf8', timeout: 300_000 });
    if (result.error !== undefined || result.status !== 0) {
      const said = `${result.stderr ?? ''}`.split('\n').find((line) => line.trim() !== '') ?? '';
      throw new Refusal(`npm install --package-lock-only: ${result.error?.message ?? `exit code ${String(result.status)}`}`
        + `${said === '' ? '' : ` (${said.trim()})`}`);
    }
    const lockText = fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8');
    const entry = JSON.parse(lockText).packages?.[`node_modules/${SDK}`];
    if (entry?.version !== version) {
      throw new Refusal(`lockfile has ${SDK} ${String(entry?.version)}, expected ${version}`);
    }
    fs.writeFileSync(path.join(INSTALL_DIR, 'sdk-package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(INSTALL_DIR, 'sdk-lock.json'), lockText);
    process.stdout.write(`sdk-lock: ${SDK} ${version}, ${String(Object.keys(JSON.parse(lockText).packages).length)}`
      + ' lockfile entries (with the root) → server/src/install/sdk-package.json, sdk-lock.json\n');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (failure) {
  process.stderr.write(`sdk-lock: ${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exitCode = 1;
}
