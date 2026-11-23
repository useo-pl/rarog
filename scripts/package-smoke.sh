#!/usr/bin/env bash
# Test dymny paczki npm z tarballa: zadanie `package` w `.github/workflows/check.yml` (opis: `docs/publishing.md`,
# „CI”). Tarball z `scripts/package.mjs` idzie menedżerem z argumentu (`npm i -g` albo `pnpm add -g`) do katalogów
# w jednym `mktemp`, z tymczasowym HOME; potem:
#
# 1. liczba paczek dodanych przez menedżer = przewidziana: sama paczka, jej zależności z rejestru (spoza
#    `bundleDependencies`) i po jednej paczce platformy na zależność z `optionalDependencies`; SDK Claude nie ma.
#    npm 10 przy paczce z `bundleDependencies` pomija `os` i `cpu` paczek platformy i kładzie wszystkie, więc dla
#    niego przewidziane są wszystkie, a w wyjściu instalacji ma stać ostrzeżenie `EBADENGINE` z `engines.npm`;
# 2. `rarog --help`;
# 3. pobranie SDK Claude z rejestru npm kodem zainstalowanej paczki: `server/test/sdk-install-live.test.ts`
#    z `RAROG_TEST_NETWORK=1` i `RAROG_TEST_PACKAGE_ROOT`, każdy test zaliczony, żaden pominięty;
# 4. `rarog serve --check` z `config.json` demo (SDK niewymagany), start serwera demo z paczki, `/health` z polem
#    `sdk`, wiersz polecenia serwera wobec wzorca stopu `restart.sh`, stop.
#
# Użycie (w katalogu repo po `pnpm install`): bash scripts/package-smoke.sh <npm|pnpm> <rarog-server-<version>.tgz>
# (paczka `@rarog/server`, domyślna nazwa pakowacza).
#
# Każdy krok idzie przez `env -i`: PATH z katalogiem tego węzła i pnpm, HOME, TMPDIR, cache i prefiks menedżera
# w katalogu roboczym, pusty plik konfiguracji npm zamiast `~/.npmrc`. Serwer demo słucha na RAROG_SMOKE_PORT
# (domyślnie 18939, 8930 = odmowa). Sieć: rejestr npm (iroh z paczką platformy, SDK Claude). Bez sekretów.
# Na końcu, także po błędzie, skrypt zatrzymuje drzewo procesów swojego serwera i usuwa katalog roboczy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${RAROG_SMOKE_PORT:-18939}"
W=""
SERVER_PID=""

die() { printf 'package-smoke: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill_tree "$SERVER_PID"; fi
  if [ -n "$W" ]; then rm -rf -- "$W"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

[ "$#" -eq 2 ] || die "usage: bash scripts/package-smoke.sh <npm|pnpm> <rarog-server-<version>.tgz>"
MANAGER="$1"
case "$MANAGER" in
  npm | pnpm) ;;
  *) die "manager $MANAGER: npm or pnpm only" ;;
esac
[ -f "$2" ] || die "no tarball $2"
TARBALL="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
[ "$PORT" != 8930 ] || die "port 8930 belongs to the live installation; set another RAROG_SMOKE_PORT"
NODE="$(command -v node)" || die "no node in PATH"
PNPM="$(command -v pnpm)" || die "no pnpm in PATH"
[ -x "$ROOT/node_modules/.bin/vitest" ] || die "no vitest in $ROOT/node_modules: run pnpm install first"

W="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rarog-smoke.XXXXXX")"
chmod 700 "$W"
mkdir -p "$W/home" "$W/tmp" "$W/pnpm-bin"
: >"$W/empty-npmrc"
# Instalacja i polecenia paczki biegną z katalogu roboczego, nie z repo: bez `.npmrc` i `pnpm-workspace.yaml` repo.
cd "$W"
# `pnpm add -g` wymaga katalogu poleceń w PATH.
CLEAN_PATH="$(dirname "$NODE"):$(dirname "$PNPM"):$W/pnpm-bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Środowisko każdego kroku: nic z powłoki wołającego poza PATH i językiem.
clean() {
  env -i PATH="$CLEAN_PATH" HOME="$W/home" TMPDIR="$W/tmp" LANG="${LANG:-en_US.UTF-8}" \
    npm_config_userconfig="$W/empty-npmrc" npm_config_cache="$W/npm-cache" npm_config_update_notifier=false "$@"
}

if curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/health"; then die "port $PORT is busy"; fi

MANAGER_VERSION="$(clean "$MANAGER" --version)"
# Linia npm, która kładzie wszystkie paczki platformy (opis w nagłówku, punkt 1); 0 = nie ten przypadek.
ALL_PLATFORMS=0
if [ "$MANAGER" = npm ] && [ "${MANAGER_VERSION%%.*}" = 10 ]; then ALL_PLATFORMS=1; fi
step "$MANAGER $MANAGER_VERSION on node $("$NODE" --version): installing $(basename "$TARBALL")"
if [ "$MANAGER" = npm ]; then
  clean npm i -g --prefix "$W/prefix" --ignore-scripts --no-audit --no-fund "$TARBALL" 2>&1 | tee "$W/install.out"
  if [ "$ALL_PLATFORMS" = 1 ] && ! grep -q "EBADENGINE.*npm: '>=11'" "$W/install.out"; then
    die "npm $MANAGER_VERSION without the EBADENGINE warning about engines.npm"
  fi
  ADDED="$(sed -n 's/^added \([0-9][0-9]*\) packages\{0,1\}.*/\1/p' "$W/install.out")"
  PKG="$W/prefix/lib/node_modules/@rarog/server"
  RAROG="$W/prefix/bin/rarog"
else
  clean pnpm add -g --ignore-scripts --store-dir "$W/pnpm-store" --cache-dir "$W/pnpm-cache" \
    --global-dir "$W/pnpm-global" --global-bin-dir "$W/pnpm-bin" "$TARBALL" | tee "$W/install.out"
  ADDED="$(sed -n 's/^Packages: +\([0-9][0-9]*\).*/\1/p' "$W/install.out")"
  PKG="$(find "$W/pnpm-global" -maxdepth 5 -path '*/node_modules/@rarog/server' | head -1)"
  RAROG="$W/pnpm-bin/rarog"
fi
[ -n "$ADDED" ] || die "$MANAGER did not report the number of added packages"
if [ -z "$PKG" ] || [ ! -f "$PKG/package.json" ]; then die "no package directory after installation"; fi
[ -x "$RAROG" ] || die "no $RAROG command after installation"
PKG="$(cd "$PKG" && pwd -P)"
printf 'package: %s\n' "$PKG"

step "added packages against the expected count; Claude SDK not installed"
clean "$NODE" --input-type=module - "$PKG" "$ADDED" "$ALL_PLATFORMS" <<'EOF'
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [pkgDir, added, allPlatforms] = process.argv.slice(2);
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const pkg = read(path.join(pkgDir, 'package.json'));
const inTarball = new Set(pkg.bundleDependencies ?? []);
const registry = Object.keys(pkg.dependencies ?? {}).filter((name) => !inTarball.has(name));
const fromPkg = createRequire(path.join(pkgDir, 'package.json'));
const expected = [pkg.name];
for (const name of registry) {
  const depJson = fromPkg.resolve(`${name}/package.json`);
  expected.push(name);
  const optional = Object.keys(read(depJson).optionalDependencies ?? {});
  if (optional.length === 0) continue;
  const fromDep = createRequire(depJson);
  const platform = optional.filter((one) => {
    try {
      fromDep.resolve(`${one}/package.json`);
      return true;
    } catch {
      return false;
    }
  });
  const want = allPlatforms === '1' ? optional.length : 1;
  if (platform.length !== want) {
    console.error(`${name}: ${String(platform.length)} platform packages instead of ${String(want)} (${platform.join(', ')})`);
    process.exit(1);
  }
  if (allPlatforms === '1') console.log(`${name}: npm 10 installed all ${String(want)} platform packages`);
  expected.push(...platform);
}
let sdk = null;
try {
  sdk = fromPkg.resolve('@anthropic-ai/claude-agent-sdk/package.json');
} catch {
  // Oczekiwane: paczka SDK nie niesie i nie dociąga.
}
console.log(`expected (${String(expected.length)}): ${expected.join(', ')}; added: ${added}`);
if (sdk !== null) {
  console.error(`Claude SDK in the package installation: ${sdk}`);
  process.exit(1);
}
if (Number(added) !== expected.length) {
  console.error(`added packages ${added}, expected ${String(expected.length)}`);
  process.exit(1);
}
EOF
[ -z "$(find "$W" -path '*/@anthropic-ai/*' -print -quit)" ] || die "@anthropic-ai files before the SDK download"

step "rarog --help"
clean "$RAROG" --help >"$W/help.out"
[ "$(head -1 "$W/help.out")" = 'Usage:' ] || die "rarog --help without a Usage: line"

step "Claude SDK from the npm registry by package code (server/test/sdk-install-live.test.ts)"
(cd "$ROOT" && clean RAROG_TEST_NETWORK=1 RAROG_TEST_PACKAGE_ROOT="$PKG" node_modules/.bin/vitest run \
  server/test/sdk-install-live.test.ts --reporter=default --reporter=json --outputFile.json="$W/live.json")
# Pominięty test to brak sprawdzenia, nie zieleń.
clean "$NODE" -e "const r = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
  console.log('SDK tests: passed', r.numPassedTests, 'of', r.numTotalTests);
  if (r.numTotalTests === 0 || r.numPassedTests !== r.numTotalTests) process.exit(1);" "$W/live.json" \
  || die "SDK test with a skip or without tests"

CONFIG_DIR="$W/home/.config/rarog"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
printf '{"version":1,"env":{"RAROG_DEMO":"1","RAROG_PORT":"%s","RAROG_ORIGINS":"http://127.0.0.1:%s"}}\n' \
  "$PORT" "$PORT" >"$CONFIG_DIR/config.json"

step "rarog serve --check (demo)"
clean "$RAROG" serve --check

step "demo server from the package on port $PORT"
# `exec` w podpowłoce: `$!` to PID serwera (env → rarog → `execve` na node), nie powłoki z funkcją `clean`.
( exec env -i PATH="$CLEAN_PATH" HOME="$W/home" TMPDIR="$W/tmp" LANG="${LANG:-en_US.UTF-8}" \
    npm_config_userconfig="$W/empty-npmrc" npm_config_cache="$W/npm-cache" "$RAROG" serve ) \
  >"$W/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >"$W/health.json" 2>/dev/null; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$W/server.log" >&2; die "server exited before /health"; }
  sleep 0.5
done
[ -s "$W/health.json" ] || { tail -20 "$W/server.log" >&2; die "/health did not answer in 30 s"; }
cat "$W/health.json"
echo
clean "$NODE" -e "const h = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
  console.log('sdk in /health:', h.sdk);
  if (!['ok', 'stale', 'missing', 'error'].includes(h.sdk)) process.exit(1);" "$W/health.json" \
  || die "/health without an sdk field"
COMMAND="$(ps -o command= -p "$SERVER_PID")"
printf 'server process: %s\n' "$COMMAND"
case "$COMMAND" in
  *'node server/src/index.js'*) ;;
  *) die "the server command line does not match the restart.sh stop pattern" ;;
esac

step "stopping the demo server"
kill_tree "$SERVER_PID"
for _ in $(seq 1 20); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$SERVER_PID" 2>/dev/null; then die "demo server alive 10 s after SIGTERM"; fi
SERVER_PID=""
if curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/health"; then die "port $PORT answers after the stop"; fi

step "done: $MANAGER, the package from $(basename "$TARBALL") worked"
