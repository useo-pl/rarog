#!/usr/bin/env bash
# Wybrane testy apki natywnej jedną komendą (native/Rarog/docs/tests.md, „Tests”). Agent sam podaje, co puścić;
# skrypt testów nie wybiera i bez argumentów odmawia. Nie bierze blokady pełnej bramki (`ios-check.sh`): chodzi obok
# innych sesji na własnych zasobach — własny symulator (klon wzorca zakładany i usuwany przez ten przebieg), własne
# DerivedData (stała ścieżka na worktree, więc drugi przebieg buduje przyrostowo), własny port demo. Chodzi POZA
# sandboksem Claude Code (cache swift i xcodebuild w /var/folders).
#
# Wzorzec symulatora: jeden na typ urządzenia i runtime (`rarog-ios-test-template-<runtime>-<typ>`), wspólny dla
# wszystkich worktree. Zakłada go pierwszy przebieg pod blokadą `$TMPDIR/rarog-ios-test/template.lock`: pierwszy
# start do końca `simctl bootstatus`, wyłączenie, dopiero potem nazwa wzorca, więc wzorzec pod tą nazwą zawsze raz
# wystartował. Przebieg klonuje wzorzec (`simctl clone`) i testuje na klonie, więc nie płaci pierwszego startu nowego
# symulatora (najwolniejszego). Bez wzorca albo przy nieudanym klonie przebieg zakłada nowy symulator i mówi to jedną
# linią.
#
#   ios-test.sh <cel>/<Klasa>[/<test>] …         xcodebuild test na własnym symulatorze; cele apki: RarogUIKitTests,
#                                                RarogUITests (XCUITest dostaje świeże demo); cel `<Pakiet>Tests`
#                                                idzie schematem pakietu (np. RarogTerminalTests/SwiftTermSurfaceTests)
#   ios-test.sh --package <Pakiet> [--filter <wzorzec>]   swift test pakietu na macOS
#   ios-test.sh --build                          sam build apki dla symulatora
#
# Wyjście: wiersze porażek, pominięć i błędów oraz wynik; pełny log zostaje tylko przy porażce. Filtr, który nie
# trafił w żaden test, to porażka („no tests ran”), nie zielono.
#
# Zmienne: RAROG_IOS_SIMULATOR (typ zakładanego symulatora, domyślnie typ symulatora bramki), RAROG_IOS_TEST_LIMIT
# (sekundy na jedną komendę xcodebuild albo swift, domyślnie 3600; po nim kod 124), RAROG_IOS_BOOT_LIMIT (sekundy na
# start symulatora, domyślnie 300; po nim przebieg idzie dalej). Zatrzymanie własnego procesu
# (limit, sprzątanie): SIGTERM do jego drzewa, po KILL_GRACE s SIGKILL dla tego, co z drzewa zostało.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PACKAGES_DIR="$ROOT/native/Rarog/Packages"
XCODE_PROJECT="$ROOT/native/Rarog/Rarog.xcodeproj"
DEVICE_TYPE="${RAROG_IOS_SIMULATOR:-iPad Pro 11-inch (M5)}"
LIMIT="${RAROG_IOS_TEST_LIMIT:-3600}"
KILL_GRACE=5
# Sekundy na start symulatora do końca `simctl bootstatus` (zmierzony start: 5–30 s przy load ponad 300).
BOOT_LIMIT="${RAROG_IOS_BOOT_LIMIT:-300}"
APP_TARGETS=(RarogUIKitTests RarogUITests)

ios_test_die() {
  echo "ios-test: $*" >&2
  exit 1
}
usage() {
  cat >&2 <<'EOF'
usage: ios-test.sh <target>/<Class>[/<test>] ...   (targets: RarogUIKitTests, RarogUITests, <Package>Tests)
       ios-test.sh --package <Package> [--filter <pattern>]
       ios-test.sh --build
The script runs only the tests you name; it never picks tests itself.
EOF
  exit 2
}

# --- argumenty ---------------------------------------------------------------------------------------------------
mode=""
package=""
filter=""
items=()
while (($#)); do
  case "$1" in
    --build) [[ -z "$mode" ]] || usage; mode=build ;;
    --package) [[ -z "$mode" && $# -ge 2 ]] || usage; mode=package; package="$2"; shift ;;
    --filter) [[ "$mode" == package && -z "$filter" && $# -ge 2 && -n "$2" ]] || usage; filter="$2"; shift ;;
    -*) usage ;;
    *) [[ -z "$mode" || "$mode" == tests ]] || usage; mode=tests; items+=("$1") ;;
  esac
  shift
done
[[ -n "$mode" ]] || usage
[[ "$LIMIT" =~ ^[1-9][0-9]*$ ]] || ios_test_die "RAROG_IOS_TEST_LIMIT: a number of seconds greater than zero"
[[ "$BOOT_LIMIT" =~ ^[1-9][0-9]*$ ]] || ios_test_die "RAROG_IOS_BOOT_LIMIT: a number of seconds greater than zero"

NAME='[A-Za-z_][A-Za-z0-9_]*'
app_only=()
declare -a scheme_packages=()
if [[ "$mode" == package ]]; then
  [[ "$package" =~ ^$NAME$ && -f "$PACKAGES_DIR/$package/Package.swift" ]] \
    || ios_test_die "no package $package in native/Rarog/Packages"
elif [[ "$mode" == tests ]]; then
  for item in "${items[@]}"; do
    # Klasa jest obowiązkowa: sam cel to cały zestaw (RarogUITests ≈ godzina), a wybór ma być jawny.
    [[ "$item" =~ ^$NAME/$NAME(/$NAME(\(\))?)?$ ]] \
      || ios_test_die "$item: expected <target>/<Class> or <target>/<Class>/<test>"
    target="${item%%/*}"
    if [[ " ${APP_TARGETS[*]} " == *" $target "* ]]; then
      app_only+=("-only-testing:$item")
    elif [[ "$target" == *Tests && -f "$PACKAGES_DIR/${target%Tests}/Package.swift" ]]; then
      [[ " ${scheme_packages[*]-} " == *" ${target%Tests} "* ]] || scheme_packages+=("${target%Tests}")
    else
      ios_test_die "$target: unknown test target (RarogUIKitTests, RarogUITests or <Package>Tests)"
    fi
  done
fi

# --- środowisko ---------------------------------------------------------------------------------------------------
[[ -n "${TMPDIR:-}" && -d "$TMPDIR" ]] || ios_test_die "TMPDIR is not set — DerivedData never goes to /tmp"
# Stała ścieżka na worktree: nazwa katalogu repo (czytelna w `ls`) i skrót pełnej ścieżki (dwa worktree o tej samej
# nazwie się nie mieszają). DerivedData nie leży w repo: grep, vitest i review czytałyby gigabajty buildu.
WORKTREE_KEY="$(basename "$ROOT")-$(printf '%s' "$ROOT" | shasum | cut -c1-8)"
STATE="${TMPDIR%/}/rarog-ios-test/$WORKTREE_KEY"
mkdir -p "$STATE"
# Właściciel katalogu stanu: pełna ścieżka worktree. Po niej widać, czy katalog jest osierocony.
printf '%s\n' "$ROOT" >"$STATE/worktree-path"

# Toolchain z pełnego Xcode, bez przestawiania `xcode-select`. Bibliotek nie śledzimy: lintuje je glob
# `scripts/*.sh` w check.sh.
# shellcheck source=/dev/null
source "$ROOT/scripts/xcode-toolchain.sh"
# shellcheck source=/dev/null
source "$ROOT/scripts/ios-identity.sh"
# shellcheck source=/dev/null
source "$ROOT/scripts/ios-demo.sh"
# shellcheck source=/dev/null
source "$ROOT/scripts/ios-push.sh"
DEVELOPER_DIR="$(rarog_xcode_developer_dir)" \
  || ios_test_die "no Xcode toolchain (CommandLineTools are not enough: no Swift Testing macros)"
export DEVELOPER_DIR

# Nic nie dziedziczymy od wywołującego: endpoint demo i katalog sygnałów pusha ustawia ten przebieg. Język testów
# przypięty na polski (`docs/localization.md`, „Tests”): `swift test` i — prefiksem `TEST_RUNNER_` — proces
# testów xcodebuild, także schematu pakietu, który `RAROG_COPY_LANGUAGE` sam nie ustawia.
unset RAROG_DEMO_PORT TEST_RUNNER_RAROG_DEMO_PORT TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR
export RAROG_COPY_LANGUAGE=pl TEST_RUNNER_RAROG_COPY_LANGUAGE=pl
TEST_LANGUAGE_ARGS=(-testLanguage pl -testRegion PL)
# Limit jednego testu jak w bramce (README, „Hung run”); `-collect-test-diagnostics never`: bez 10 min `simctl diagnose`.
TEST_LIMIT_ARGS=(-collect-test-diagnostics never -test-timeouts-enabled YES -default-test-execution-time-allowance 300)

# --- sprzątanie: wyłącznie własne zasoby ----------------------------------------------------------------------------
SIM_UDID=""
IOS_DEMO_PID=""
PUSH_RELAY_PID=""
STEP_PID=""
PORT_LOCK=""
TEMPLATE_PREP=""
TEMPLATE_LOCK=""

# Proces i wszyscy jego potomkowie (pid w wierszu) — nic poza tym drzewem.
tree_pids() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do tree_pids "$child"; done
  echo "$pid"
}
# Zatrzymuje własny proces z całym drzewem i zbiera go: SIGTERM, do KILL_GRACE s czekania, potem SIGKILL dla tego, co
# z drzewa przeżyło (także potomków, którzy doszli w międzyczasie). Proces ignorujący SIGTERM trzymałby bez końca
# `wait`, a z nim symulator i demo (wzór: `xcode_kill` w ios-check.sh). Dopiero potem `wait`.
stop_tree() {
  local root="$1" pids pid left _
  pids="$(tree_pids "$root")"
  # shellcheck disable=SC2086 # lista pidów
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 $((KILL_GRACE * 10))); do
    left=""
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then left="$left $pid"; fi
    done
    [[ -n "$left" ]] || break
    sleep 0.1
  done
  if [[ -n "$left" ]]; then
    kill -0 "$root" 2>/dev/null && left="$left $(tree_pids "$root")"
    # shellcheck disable=SC2086 # lista pidów
    kill -9 $left 2>/dev/null || true
  fi
  wait "$root" 2>/dev/null || true
}

# Blokada między przebiegami (także z innych worktree): katalog zakładany przez `mkdir` (atomowo: wygrywa jeden
# przebieg) z pidem właściciela w pliku `pid`. Znika w sprzątaniu przy każdym wyjściu skryptu. Blokadę po martwym
# procesie (SIGKILL, padnięty Mac) przejmuje następny przebieg: `kill -0` na zapisanym pidzie nie przechodzi, więc
# katalog idzie pod nazwę jednorazową (`mv`, atomowo) i zakładany jest od nowa. Blokada bez pidu to właściciel między
# `mkdir` a zapisem; martwa jest dopiero po minucie. Kod 1: blokadę trzyma ktoś inny.
dir_lock() {
  local lock="$1" owner stale
  mkdir -p "$(dirname "$lock")"
  if ! mkdir "$lock" 2>/dev/null; then
    owner="$(cat "$lock/pid" 2>/dev/null || true)"
    if [[ "$owner" =~ ^[0-9]+$ ]]; then
      if kill -0 "$owner" 2>/dev/null; then return 1; fi
    elif [[ -z "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]]; then
      return 1
    fi
    stale="$(dirname "$lock")/.stale-$$-$(basename "$lock")"
    mv "$lock" "$stale" 2>/dev/null || return 1
    if [[ "$(cat "$stale/pid" 2>/dev/null || true)" != "$owner" ]]; then
      # Między odczytem a `mv` blokadę przejął ktoś inny: oddajemy ją.
      if [[ ! -e "$lock" ]]; then mv "$stale" "$lock" 2>/dev/null || true; fi
      [[ ! -e "$stale" ]] || rm -r -- "$stale"
      return 1
    fi
    rm -r -- "$stale"
    mkdir "$lock" 2>/dev/null || return 1
  fi
  echo "$$" >"$lock/pid"
}
# Zwalnia wyłącznie własną blokadę (pid w niej to ten przebieg).
dir_unlock() {
  if [[ "$(cat "$1/pid" 2>/dev/null || true)" == "$$" ]]; then
    rm -r -- "$1" 2>/dev/null || echo "ios-test: could not delete the lock $1" >&2
  fi
}

# Rezerwacja portu demo: blokada `$PORT_LOCKS/<port>`.
PORT_LOCKS="${TMPDIR%/}/rarog-ios-test/ports"
port_reserve() {
  dir_lock "$PORT_LOCKS/$1" || return 1
  PORT_LOCK="$PORT_LOCKS/$1"
}
port_release() {
  [[ -n "$PORT_LOCK" ]] || return 0
  dir_unlock "$PORT_LOCK"
  PORT_LOCK=""
}

cleanup() {
  if [[ -n "$STEP_PID" ]]; then stop_tree "$STEP_PID"; STEP_PID=""; fi
  if [[ -n "$PUSH_RELAY_PID" ]]; then stop_tree "$PUSH_RELAY_PID"; PUSH_RELAY_PID=""; fi
  if [[ -n "$IOS_DEMO_PID" ]]; then stop_tree "$IOS_DEMO_PID"; IOS_DEMO_PID=""; fi
  # Rezerwacja portu znika dopiero po zatrzymaniu demo: następny przebieg nie trafi na jego serwer.
  port_release
  sim_delete "$SIM_UDID"
  SIM_UDID=""
  # Wzorzec przerwany w trakcie przygotowania nie dostał jeszcze nazwy wzorca: kasujemy go, blokada znika po nim.
  sim_delete "$TEMPLATE_PREP"
  TEMPLATE_PREP=""
  if [[ -n "$TEMPLATE_LOCK" ]]; then dir_unlock "$TEMPLATE_LOCK"; TEMPLATE_LOCK=""; fi
}
sim_delete() {
  [[ -n "$1" ]] || return 0
  xcrun simctl shutdown "$1" >/dev/null 2>&1 || true
  xcrun simctl delete "$1" >/dev/null 2>&1 \
    || echo "ios-test: could not delete the simulator $1 — delete it: xcrun simctl delete $1" >&2
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Katalog roboczy przebiegu w $STATE: czyszczony na starcie, więc nic się nie zbiera między przebiegami.
fresh_dir() {
  [[ ! -e "$STATE/$1" ]] || rm -r -- "${STATE:?}/$1"
  mkdir -p "$STATE/$1"
  echo "$STATE/$1"
}

# --- jedna komenda z limitem, krótkim wyjściem i licznikiem testów ------------------------------------------------
# Pełny log idzie do `$STATE/<nazwa>.log`; na ekran trafiają na bieżąco wiersze porażek, pominięć, błędów i wyników.
# Liczba testów: wiersze XCTest „Test Case '…' passed|failed|skipped” plus N z „Test run with N tests” (Swift
# Testing). Zero przy zielonym kodzie = filtr nie trafił („no tests ran”, kod 1).
SHOW='Test [Cc]ase .*(failed|skipped)|error:|\*\* (TEST|BUILD) |Test run with|✘|No matching test'
count_tests() {
  awk '
    /^Test Case .* (passed|failed|skipped)/ { upper++ }
    /^Test case .* (passed|failed|skipped)/ { lower++ }
    match($0, /Test run with [0-9]+ test/) { s = substr($0, RSTART + 14); swift += s + 0 }
    END { print (upper ? upper : lower) + swift }' "$1"
}
# Limit kroku: RAROG_IOS_TEST_LIMIT, a start symulatora BOOT_LIMIT (podany przez `STEP_LIMIT=… run_step`).
# Przekroczony limit testów kończy skrypt kodem 124. Przekroczony limit startu symulatora tylko zwraca 124:
# wywołujący ma własną drogę dalej (nowy symulator zamiast wzorca, start przez xcodebuild).
run_step() {
  local name="$1" counts="$2" log shown=0 lines start=$SECONDS status=0 ran limit="${STEP_LIMIT:-$LIMIT}"
  local which=RAROG_IOS_TEST_LIMIT
  [[ -z "${STEP_LIMIT:-}" ]] || which="the boot limit"
  shift 2
  log="$STATE/$name.log"
  "$@" >"$log" 2>&1 &
  STEP_PID=$!
  while kill -0 "$STEP_PID" 2>/dev/null; do
    sleep 0.5
    lines="$(wc -l <"$log" | tr -d ' ')"
    if ((lines > shown)); then
      sed -n "$((shown + 1)),${lines}p" "$log" | grep -E "$SHOW" || true
      shown=$lines
    fi
    if ((SECONDS - start >= limit)); then
      echo "ios-test: $name over ${limit} s ($which) — stopping it" >&2
      stop_tree "$STEP_PID"
      STEP_PID=""
      echo "ios-test: full log: $log" >&2
      [[ -z "${STEP_LIMIT:-}" ]] || return 124
      exit 124
    fi
  done
  wait "$STEP_PID" || status=$?
  STEP_PID=""
  sed -n "$((shown + 1)),\$p" "$log" | grep -E "$SHOW" || true
  if ((status != 0)); then
    echo "ios-test: $name — red (code $status); full log: $log" >&2
    return "$status"
  fi
  if [[ "$counts" == yes ]]; then
    ran="$(count_tests "$log")"
    if ((ran == 0)); then
      echo "ios-test: $name — no tests ran (the filter matched nothing); full log: $log" >&2
      return 1
    fi
    if ((ran == 1)); then
      echo "ios-test: $name — green, 1 test"
    else
      echo "ios-test: $name — green, $ran tests"
    fi
  else
    echo "ios-test: $name — green"
  fi
  rm -f -- "$log"
}

# --- tryby ----------------------------------------------------------------------------------------------------------
if [[ "$mode" == package ]]; then
  pins=()
  [[ ! -f "$PACKAGES_DIR/$package/Package.resolved" ]] || pins=(--force-resolved-versions)
  only=()
  [[ -z "$filter" ]] || only=(--filter "$filter")
  echo "== swift test $package${filter:+ --filter $filter}"
  run_step "swift-test-$package" yes xcrun swift test --package-path "$PACKAGES_DIR/$package" \
    ${pins[@]+"${pins[@]}"} ${only[@]+"${only[@]}"}
  exit 0
fi

if [[ "$mode" == build ]]; then
  echo "== xcodebuild build Rarog for the simulator (DerivedData: $STATE/app)"
  run_step build-simulator no xcrun xcodebuild build -project "$XCODE_PROJECT" -scheme Rarog \
    "${RAROG_XCODE_PACKAGE_ARGS[@]}" -destination "generic/platform=iOS Simulator" -derivedDataPath "$STATE/app"
  exit 0
fi

# Testy na symulatorze: własny symulator tego przebiegu (klon wzorca), nigdy cudzy ani symulator bramki.
UDID_RE='^[0-9A-Fa-f-]{36}$'
TEMPLATE_LOCK_DIR="${TMPDIR%/}/rarog-ios-test/template.lock"

# UDID symulatora o dokładnie tej nazwie z `simctl list devices` (wiersz `    <nazwa> (<udid>) (<stan>)`).
sim_named() {
  local name="$1" line
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ "$line" == "$name ("* ]] || continue
    line="${line#"$name ("}"
    if [[ "$line" =~ ^([0-9A-Fa-f-]{36})\)\ \( ]]; then
      echo "${BASH_REMATCH[1]}"
      return 0
    fi
  done < <(xcrun simctl list devices 2>/dev/null || true)
  return 1
}

# Wzorzec gotowy do klonowania w TEMPLATE_UDID i nazwa w TEMPLATE_NAME; kod 1 z powodem w TEMPLATE_WHY. Szukanie
# i zakładanie idą pod blokadą, więc dwa przebiegi naraz nie zakładają dwóch wzorców; drugi czeka, aż pierwszy skończy.
TEMPLATE_UDID=""
TEMPLATE_NAME=""
TEMPLATE_WHY=""
template_ready() {
  local runtime waited=0 status=0
  runtime="$(xcrun simctl list runtimes 2>/dev/null \
    | awk '/^iOS / && !/unavailable/ { id = $NF } END { print id }')" || runtime=""
  if [[ "$runtime" != com.apple.CoreSimulator.SimRuntime.* ]]; then
    TEMPLATE_WHY="no iOS simulator runtime in xcrun simctl list runtimes"
    return 1
  fi
  TEMPLATE_NAME="rarog-ios-test-template-${runtime##*.}-$DEVICE_TYPE"
  until dir_lock "$TEMPLATE_LOCK_DIR"; do
    if ((waited >= LIMIT)); then
      TEMPLATE_WHY="the template lock $TEMPLATE_LOCK_DIR is still held after ${LIMIT} s"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  TEMPLATE_LOCK="$TEMPLATE_LOCK_DIR"
  TEMPLATE_UDID="$(sim_named "$TEMPLATE_NAME")" || TEMPLATE_UDID=""
  if [[ -z "$TEMPLATE_UDID" ]]; then
    template_make "$runtime" || status=1
  fi
  dir_unlock "$TEMPLATE_LOCK"
  TEMPLATE_LOCK=""
  return "$status"
}
# Nowy wzorzec: symulator `rarog-ios-test-<pid>-template`, pierwszy start do końca `bootstatus`, wyłączenie i dopiero
# wtedy nazwa wzorca. Porażka kasuje niedokończony wzorzec.
template_make() {
  local start=$SECONDS
  TEMPLATE_PREP="$(xcrun simctl create "rarog-ios-test-$$-template" "$DEVICE_TYPE" "$1" 2>/dev/null)" \
    || TEMPLATE_PREP=""
  if [[ ! "$TEMPLATE_PREP" =~ $UDID_RE ]]; then
    TEMPLATE_PREP=""
    TEMPLATE_WHY="could not create one ($DEVICE_TYPE, $1)"
    return 1
  fi
  echo "== template simulator: first boot of $TEMPLATE_NAME ($TEMPLATE_PREP), once per device type and runtime"
  if STEP_LIMIT=$BOOT_LIMIT run_step boot-template no xcrun simctl bootstatus "$TEMPLATE_PREP" -b \
    && xcrun simctl shutdown "$TEMPLATE_PREP" >/dev/null 2>&1 \
    && xcrun simctl rename "$TEMPLATE_PREP" "$TEMPLATE_NAME" >/dev/null 2>&1; then
    echo "== time: template simulator: $((SECONDS - start)) s"
    TEMPLATE_UDID="$TEMPLATE_PREP"
    TEMPLATE_PREP=""
    return 0
  fi
  sim_delete "$TEMPLATE_PREP"
  TEMPLATE_PREP=""
  TEMPLATE_WHY="its first boot failed"
  return 1
}

sim_kind=""
if template_ready; then
  SIM_UDID="$(xcrun simctl clone "$TEMPLATE_UDID" "rarog-ios-test-$$" 2>/dev/null)" || SIM_UDID=""
  if [[ "$SIM_UDID" =~ $UDID_RE ]]; then
    sim_kind="clone of the template $TEMPLATE_NAME"
  else
    SIM_UDID=""
    echo "ios-test: could not clone the template simulator $TEMPLATE_NAME ($TEMPLATE_UDID)" \
      "— creating a new simulator" >&2
  fi
else
  echo "ios-test: no template simulator: $TEMPLATE_WHY — creating a new simulator" >&2
fi
if [[ -z "$sim_kind" ]]; then
  SIM_UDID="$(xcrun simctl create "rarog-ios-test-$$" "$DEVICE_TYPE" 2>/dev/null)" || SIM_UDID=""
  [[ "$SIM_UDID" =~ $UDID_RE ]] || { SIM_UDID=""; ios_test_die "could not create a simulator ($DEVICE_TYPE)"; }
  sim_kind="new"
fi
echo "== own simulator: $DEVICE_TYPE ($SIM_UDID), $sim_kind, deleted at the end"
# Start przed testami: czas startu widać osobno od testów. Porażka nie kończy przebiegu, xcodebuild startuje go sam.
boot_start=$SECONDS
STEP_LIMIT=$BOOT_LIMIT run_step boot-simulator no xcrun simctl bootstatus "$SIM_UDID" -b \
  || echo "ios-test: the simulator did not report a finished boot; xcodebuild boots it itself" >&2
echo "== time: simulator boot: $((SECONDS - boot_start)) s"

# XCUITest chodzi przeciw świeżemu demo na wolnym porcie: nigdy 8930 (żywy Rarog) ani 18931 (pełna bramka). Start
# skanu zależy od worktree, więc dwa worktree rzadko sięgają po ten sam port; gdy sięgną, rozstrzyga rezerwacja
# (`port_reserve` przy sprzątaniu wyżej).

# Gotowość demo: WŁASNY proces żyje, `/health` odpowiada i na porcie słucha proces z jego drzewa (pnpm → tsx → node).
# Sam `/health` nie wystarcza: odpowiedziałby cudzy serwer, który zajął port przed naszym (nasz pada na EADDRINUSE).
# Kod 0 gotowe, 1 własne demo skończyło się przed gotowością, 2 brak gotowości w 30 s.
demo_ready() {
  local port="$1" pid tree _
  for _ in $(seq 1 60); do
    kill -0 "$IOS_DEMO_PID" 2>/dev/null || return 1
    if curl -s -m 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      tree=" $(tree_pids "$IOS_DEMO_PID" | tr '\n' ' ') "
      for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
        if [[ "$tree" == *" $pid "* ]]; then return 0; fi
      done
    fi
    sleep 0.5
  done
  return 2
}

if [[ " ${app_only[*]-} " == *" -only-testing:RarogUITests/"* ]]; then
  command -v pnpm >/dev/null 2>&1 || ios_test_die "no pnpm — cannot start a demo server for XCUITest"
  offset=$((16#$(printf '%s' "$ROOT" | shasum | cut -c1-4) % 50))
  demo_port=""
  demo_failures=0
  for i in $(seq 0 49); do
    candidate=$((18940 + (offset + i) % 50))
    port_reserve "$candidate" || continue
    if ios_demo_port_busy "$candidate"; then port_release; continue; fi
    demo_dir="$(fresh_dir demo)"
    echo "== demo server on 127.0.0.1:$candidate (data: $demo_dir)"
    ios_demo_start "$candidate" "$demo_dir" "$demo_dir/server.log" pnpm -C "$ROOT" run demo:server
    ready=0
    demo_ready "$candidate" || ready=$?
    if ((ready == 0)); then demo_port=$candidate; break; fi
    stop_tree "$IOS_DEMO_PID"
    IOS_DEMO_PID=""
    port_release
    ((ready == 1)) || ios_test_die "demo server did not come up (log: $demo_dir/server.log)"
    # Własne demo padło (np. port zajęty w międzyczasie): ten port odpada, próbujemy następnego, najwyżej trzy razy.
    demo_failures=$((demo_failures + 1))
    echo "ios-test: the demo server on port $candidate exited before it was ready (log: $demo_dir/server.log)" >&2
    ((demo_failures < 3)) \
      || ios_test_die "the demo server exited before it was ready on $demo_failures ports (log: $demo_dir/server.log)"
  done
  if [[ -z "$demo_port" ]]; then
    ((demo_failures == 0)) || ios_test_die "the demo server exited before it was ready (log: $demo_dir/server.log)"
    ios_test_die "no free demo port in 18940–18989"
  fi
  # Przekazane jako argument xcodebuild stałoby się ustawieniem buildu, a testy przepływu by się pominęły.
  export TEST_RUNNER_RAROG_DEMO_PORT="$demo_port"
  push_dir="$(fresh_dir push)"
  ios_push_relay "$push_dir" "$SIM_UDID" "$IOS_BUNDLE_ID" &
  PUSH_RELAY_PID=$!
  export TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR="$push_dir"
fi

status=0
if ((${#app_only[@]})); then
  echo "== xcodebuild test Rarog: ${app_only[*]#-only-testing:} (DerivedData: $STATE/app)"
  run_step test-Rarog yes xcrun xcodebuild test -project "$XCODE_PROJECT" -scheme Rarog \
    "${RAROG_XCODE_PACKAGE_ARGS[@]}" -destination "id=$SIM_UDID" -derivedDataPath "$STATE/app" \
    "${TEST_LIMIT_ARGS[@]}" "${TEST_LANGUAGE_ARGS[@]}" "${app_only[@]}" || status=$?
fi
for pkg in ${scheme_packages[@]+"${scheme_packages[@]}"}; do
  only=()
  for item in "${items[@]}"; do [[ "${item%%/*}" != "${pkg}Tests" ]] || only+=("-only-testing:$item"); done
  echo "== xcodebuild test $pkg: ${only[*]#-only-testing:} (DerivedData: $STATE/$pkg)"
  # Schemat pakietu widać tylko z katalogu pakietu (projekt apki pomija cele testów pakietów lokalnych). Bez
  # podpowłoki: limit czasu kończy wtedy cały skrypt i jego sprzątanie (`exit 124` w `run_step`).
  cd "$PACKAGES_DIR/$pkg"
  run_step "test-$pkg" yes xcrun xcodebuild test -scheme "$pkg" \
    "${RAROG_XCODE_PACKAGE_ARGS[@]}" -destination "id=$SIM_UDID" -derivedDataPath "$STATE/$pkg" \
    "${TEST_LIMIT_ARGS[@]}" "${TEST_LANGUAGE_ARGS[@]}" "${only[@]}" || { code=$?; ((status)) || status=$code; }
  cd "$ROOT"
done
((status == 0)) || exit "$status"
