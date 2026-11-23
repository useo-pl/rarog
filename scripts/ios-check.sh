#!/usr/bin/env bash
# Bramka natywnej apki (native/Rarog/README.md): `swift test` każdego
# pakietu z native/Rarog/Packages/* na macOS, potem — gdy projekt apki istnieje — `xcodebuild test`
# na symulatorze (XCUITest przeciw ŚWIEŻEMU serwerowi demo na loopbacku) i build na urządzenie
# (`generic/platform=iOS`), BEZ instalacji, a po nim języki zbudowanej apki (`scripts/ios-app-languages.sh`).
# Czerwony krok na symulatorze albo build nie przerywa bramki: kolejne kroki
# idą dalej, a bramka kończy się kodem pierwszej porażki. Chodzi POZA sandboksem Claude Code: swift i xcodebuild
# piszą cache w /var/folders, którego sandbox nie wpuszcza.
#
# Build na urządzenie domyślnie BEZ podpisu (kompilacja pod arm64 iOS): podpis automatyczny wymaga
# konta Apple zalogowanego w Xcode, a bez niego xcodebuild kończy się „No Accounts". Podpis sprawdza
# RAROG_IOS_SIGN=1 (ta sama ścieżka co `scripts/ios-build.sh`, z `-allowProvisioningUpdates`).
#
# Push z hosta (`scripts/ios-push.sh`): na czas XCUITest chodzi przekaźnik, który ładunki APNs
# złożone przez test (pliki w katalogu `TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR`) wysyła `xcrun simctl push`
# na symulator bramki — runner w symulatorze sam `xcrun` nie uruchomi.
#
# Kolejka: bramki z kilku worktree naraz dawały load 150–230 i XCUITest 5–10× wolniejsze,
# z porażkami czasowymi do powtórki. Bramka czeka więc na swoją kolej na blokadzie WSPÓLNEJ dla
# wszystkich worktree (`RAROG_IOS_LOCK`, domyślnie /tmp/rarog-ios-check.lock); blokadę procesu, który
# nie żyje, przejmuje.
#
# Szybka bramka (RAROG_IOS_QUICK=1) dla agentów w trakcie etapu: pakiety i testy na symulatorze BEZ
# XCUITest (te zajmują ok. 85–90% czasu pełnej bramki), plus
# wybrane klasy XCUITest z RAROG_IOS_UI_TESTS („Klasa” albo „Klasa/test”, po przecinku), bez buildu na
# urządzenie. Wynik mówi wprost „NIE pełna”: pełną bramkę puszcza integrator przed scaleniem.
#
# Zmienne: RAROG_IOS_SIMULATOR (nazwa symulatora), RAROG_IOS_SIMULATOR_OS (domyślnie `latest`),
# RAROG_IOS_DEMO_PORT (domyślnie 18931; nigdy 8930), RAROG_IOS_SKIP_DEMO=1 (XCUITest przepływu
# pominięte; wynik niepełny), RAROG_IOS_SIGN=1 (build z podpisem), RAROG_IOS_SKIP_DEVICE=1 (bez niego),
# RAROG_IOS_QUICK=1, RAROG_IOS_UI_TESTS, RAROG_IOS_LOCK, RAROG_IOS_LOCK_WAIT (sekundy, domyślnie 7200),
# RAROG_IOS_LOCK_POLL (sekundy między próbami, domyślnie 5), RAROG_IOS_SILENCE (sekundy ciszy logu xcodebuild do
# przerwania zawieszonego przebiegu, domyślnie 600), RAROG_IOS_SILENCE_POLL (co ile sekund strażnik patrzy, 2),
# RAROG_IOS_KILL_GRACE (sekundy od SIGTERM do SIGKILL zawieszonego xcodebuild, 10).
#
# Pomiar i sprzątanie: pierwsza i ostatnia linia bramki podają obciążenie Maca (`sysctl -n vm.loadavg`), a po każdym
# kroku idzie linia `== time: <krok>: <N> s` (zmienna SECONDS powłoki), także po kroku, który przerwał bramkę.
# Katalogi danych serwerów demo (`rarog-demo.*`) znikają razem z demo; log xcodebuild zostaje tylko po porażce.
# Katalogu sygnałów pusha (`rarog-push.*`) bramka nie kasuje.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `IOS_BUNDLE_ID` (przekaźnik pusha, baza stanu apek symulatora): same przypisania, bez Xcode — `ios-lib.sh` tu nie
# pasuje, bo przy źródłowaniu szuka Xcode i kończy skrypt `ios_die`. Lintuje go glob `scripts/*.sh` w check.sh.
# shellcheck source=/dev/null
source "$ROOT/scripts/ios-identity.sh"
PACKAGES_DIR="$ROOT/native/Rarog/Packages"
XCODE_PROJECT="$ROOT/native/Rarog/Rarog.xcodeproj"
SIMULATOR="${RAROG_IOS_SIMULATOR:-iPad Pro 11-inch (M5)}"
SIMULATOR_OS="${RAROG_IOS_SIMULATOR_OS:-latest}"
DEMO_PORT="${RAROG_IOS_DEMO_PORT:-18931}"
QUICK="${RAROG_IOS_QUICK:-0}"
UI_TESTS="${RAROG_IOS_UI_TESTS:-}"
LOCK_DIR="${RAROG_IOS_LOCK:-/tmp/rarog-ios-check.lock}"
LOCK_WAIT="${RAROG_IOS_LOCK_WAIT:-7200}"
LOCK_POLL="${RAROG_IOS_LOCK_POLL:-5}"
LOCK_HELD=0
SILENCE="${RAROG_IOS_SILENCE:-600}"
SILENCE_POLL="${RAROG_IOS_SILENCE_POLL:-2}"
KILL_GRACE="${RAROG_IOS_KILL_GRACE:-10}"

ios_die() {
  echo "ios-check: $*" >&2
  exit 1
}

UI_TEST_ITEM='[A-Za-z_][A-Za-z0-9_]*(/[A-Za-z_][A-Za-z0-9_]*)?'
if [[ -n "$UI_TESTS" && ! "$UI_TESTS" =~ ^$UI_TEST_ITEM(,$UI_TEST_ITEM)*$ ]]; then
  ios_die 'RAROG_IOS_UI_TESTS: only Class or Class/test, comma-separated'
fi
if [[ -n "$UI_TESTS" && "$QUICK" != 1 ]]; then
  ios_die "RAROG_IOS_UI_TESTS works only with RAROG_IOS_QUICK=1 (the full gate runs every XCUITest)"
fi

[[ "$SILENCE" =~ ^[1-9][0-9]*$ ]] || ios_die "RAROG_IOS_SILENCE: a number of seconds greater than zero"
[[ "$KILL_GRACE" =~ ^[1-9][0-9]*$ ]] || ios_die "RAROG_IOS_KILL_GRACE: a number of seconds greater than zero"

# Obciążenie Maca: średnie 1, 5 i 15 min z `sysctl -n vm.loadavg` („{ 1.50 1.25 1.00 }”). sysctl leży w /usr/sbin,
# którego w PATH wywołującego bywa brak; odmowa (sandbox) daje „unknown” i nie przewraca bramki.
gate_load() {
  local sysctl raw one five fifteen
  sysctl="$(command -v sysctl || echo /usr/sbin/sysctl)"
  raw="$("$sysctl" -n vm.loadavg 2>/dev/null)" || raw=""
  raw="${raw//[\{\}]/}"
  read -r one five fifteen _ <<<"$raw" || true
  if [[ -n "${fifteen:-}" ]]; then echo "$one $five $fifteen (1, 5, 15 min)"; else echo unknown; fi
}
# Czas kroku: `step_begin` zamyka poprzedni krok i zaczyna nowy, `step_end` wypisuje jego czas. Krok przerwany
# wyjściem bramki (`set -e`, `ios_die`, kod 124) zamyka `gate_exit`.
STEP=""
STEP_START=0
step_end() {
  [[ -n "$STEP" ]] || return 0
  echo "== time: $STEP: $((SECONDS - STEP_START)) s"
  STEP=""
}
step_begin() {
  step_end
  STEP="$1"
  STEP_START=$SECONDS
}
# Wyjście bramki: czas przerwanego kroku, sprzątanie (gdy bramka doszła do jego definicji) i ostatnia linia
# z obciążeniem. Kod wyjścia zostaje ten, z którym bramka kończyła.
gate_exit() {
  step_end
  if declare -F ios_cleanup >/dev/null; then ios_cleanup; fi
  echo "== ios-check: end after $SECONDS s, load $(gate_load)"
}
echo "== ios-check: start, load $(gate_load)"
trap gate_exit EXIT

lock_drop() {
  rm -f "$LOCK_DIR/pid" "$LOCK_DIR/owner"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
lock_release() {
  if ((LOCK_HELD)); then
    lock_drop
    LOCK_HELD=0
  fi
}
# `mkdir` jest atomowy: wygrywa dokładnie jedna bramka. Pid właściciela trafia do blokady zaraz po
# niej; blokada bez pidu starsza niż minuta (właściciel padł między `mkdir` a zapisem) też jest martwa.
lock_is_stale() {
  local pid="$1"
  if [[ -n "$pid" ]]; then
    if kill -0 "$pid" 2>/dev/null; then return 1; fi
    return 0
  fi
  [[ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +1 2>/dev/null)" ]]
}
# Przejęcie idzie pod osobnym muteksem i ponownym odczytem pidu: dwie bramki, które zobaczyły tę samą
# martwą blokadę, nie mogą skasować sobie nawzajem świeżej. Muteks starszy niż
# minuta zostawił proces, który padł w trakcie przejęcia — zdejmujemy go.
lock_try_takeover() {
  local seen="$1" now
  if [[ -n "$(find "$LOCK_DIR.takeover" -maxdepth 0 -mmin +1 2>/dev/null)" ]]; then
    rmdir "$LOCK_DIR.takeover" 2>/dev/null || true
  fi
  (umask 077 && mkdir "$LOCK_DIR.takeover") 2>/dev/null || return 0
  now="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -d "$LOCK_DIR" && "$now" == "$seen" ]] && lock_is_stale "$now"; then
    echo "== queue: lock left by a dead gate (pid ${now:-none}) — taking it over"
    lock_drop
  fi
  rmdir "$LOCK_DIR.takeover" 2>/dev/null || true
}
# Blokada leży we wspólnym /tmp, więc jest tylko dla właściciela (700, pliki 600): a tool that runs as another
# user may refuse to start when /private/tmp holds files readable by others.
# Wszystkie worktree chodzą jako ten sam użytkownik, kolejka działa dalej.
# `umask` w podpowłoce — reszta bramki (build, wyniki testów) pisze z maską użytkownika.
lock_acquire() {
  local start=$SECONDS last=-60 pid owner
  step_begin queue
  until (umask 077 && mkdir "$LOCK_DIR") 2>/dev/null; do
    pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    # Po udanym przejęciu od razu próbujemy `mkdir`; gdy przejmuje kto inny, czekamy jak na żywą bramkę.
    if lock_is_stale "$pid"; then
      lock_try_takeover "$pid"
      [[ -d "$LOCK_DIR" ]] || continue
    fi
    if ((SECONDS - start >= LOCK_WAIT)); then
      ios_die "queue: waited over ${LOCK_WAIT} s for $LOCK_DIR — check whether the other gate is alive"
    fi
    if ((SECONDS - last >= 60)); then
      owner="$(cat "$LOCK_DIR/owner" 2>/dev/null || echo '?')"
      echo "== queue: waiting for the gate from $owner (pid ${pid:-?}), $((SECONDS - start)) s"
      last=$SECONDS
    fi
    sleep "$LOCK_POLL"
  done
  LOCK_HELD=1
  (umask 077 && echo $$ >"$LOCK_DIR/pid" && echo "$ROOT" >"$LOCK_DIR/owner")
  step_end
}

# Toolchain z pełnego Xcode, bez przestawiania `xcode-select` (wybór: `scripts/xcode-toolchain.sh`).
# Biblioteki nie śledzimy: lintuje ją osobno glob `scripts/*.sh` w check.sh.
# shellcheck source=/dev/null
source "$ROOT/scripts/xcode-toolchain.sh"
DEVELOPER_DIR="$(rarog_xcode_developer_dir)" \
  || ios_die "no Xcode toolchain (CommandLineTools are not enough: no Swift Testing macros)"
export DEVELOPER_DIR
echo "== Xcode: $DEVELOPER_DIR"

# Serwer demo przed testami pakietów: integracje Swift również używają RAROG_DEMO_PORT. Te testy
# PISZĄ do seedów (`RarogCore` `DemoIntegrationTests.fullFlow` wysyła wiadomość do pierwszej
# wysyłalnej sesji), więc przed `xcodebuild test` bramka stawia DRUGIE świeże demo na tym samym
# porcie: XCUITest zastaje seedy nietknięte. Każde demo ma nowy katalog danych i środowisko `env -i`
# z jawną listą; sprzątanie dotyczy wyłącznie własnego drzewa procesów (`ios-demo.sh`).
# Biblioteki nie śledzimy: lintuje ją osobno glob `scripts/*.sh` w check.sh.
# shellcheck source=/dev/null
source "$ROOT/scripts/ios-demo.sh"

# Biblioteki nie śledzimy: lintuje ją osobno glob `scripts/*.sh` w check.sh.
# shellcheck source=/dev/null
source "$ROOT/scripts/ios-push.sh"

# Nigdy nie dziedziczymy endpointu integracji ani katalogu sygnałów pusha od procesu wywołującego.
unset RAROG_DEMO_PORT TEST_RUNNER_RAROG_DEMO_PORT TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR
# Język testów przypięty na polski (`docs/localization.md`, „Tests”), bez dziedziczenia od wywołującego: język copy
# procesu testów (`swift test` i — prefiksem `TEST_RUNNER_` — proces testów xcodebuild, także schematu pakietu
# RarogTerminal) oraz język i region apki pod testem (`TEST_LANGUAGE_ARGS` przy każdym `xcodebuild test`).
export RAROG_COPY_LANGUAGE=pl TEST_RUNNER_RAROG_COPY_LANGUAGE=pl
TEST_LANGUAGE_ARGS=(-testLanguage pl -testRegion PL)
flow="skipped"
IOS_DEMO_PID=""
IOS_DEMO_DIR=""
PUSH_RELAY_PID=""
XCODE_PID=""
XCODE_FILTER_PID=""
# Katalog danych demo (z jego logiem) znika razem z demo.
demo_stop() {
  if [[ -n "$IOS_DEMO_PID" ]]; then
    ios_demo_kill_tree "$IOS_DEMO_PID"
    wait "$IOS_DEMO_PID" 2>/dev/null || true
    IOS_DEMO_PID=""
  fi
  if [[ -n "$IOS_DEMO_DIR" ]]; then
    rm -r -- "$IOS_DEMO_DIR" 2>/dev/null || echo "ios-check: could not delete $IOS_DEMO_DIR" >&2
    IOS_DEMO_DIR=""
  fi
}
push_relay_stop() {
  if [[ -n "$PUSH_RELAY_PID" ]]; then
    ios_demo_kill_tree "$PUSH_RELAY_PID"
    wait "$PUSH_RELAY_PID" 2>/dev/null || true
    PUSH_RELAY_PID=""
  fi
}
# Drzewo procesów xcodebuild: SIGTERM, a po RAROG_IOS_KILL_GRACE s (domyślnie 10) SIGKILL dla tego, co przeżyło —
# proces ignorujący SIGTERM trzymałby bramkę, demo i blokadę bez końca.
tree_pids() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do tree_pids "$child"; done
  echo "$pid"
}
xcode_kill() {
  local pids _
  pids="$(tree_pids "$1")"
  # shellcheck disable=SC2086 # lista pidów
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 $((KILL_GRACE * 10))); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.1
  done
  # shellcheck disable=SC2086 # lista pidów
  kill -9 $pids 2>/dev/null || true
}
xcode_stop() {
  local pid
  for pid in "$XCODE_PID" "$XCODE_FILTER_PID"; do
    [[ -z "$pid" ]] || ios_demo_kill_tree "$pid"
  done
  # `tail` filtra kończy się na SIGTERM; `wait` zbiera go bez komunikatu powłoki „Terminated”.
  [[ -z "$XCODE_FILTER_PID" ]] || wait "$XCODE_FILTER_PID" 2>/dev/null || true
  XCODE_PID=""
  XCODE_FILTER_PID=""
}
ios_cleanup() {
  xcode_stop
  push_relay_stop
  demo_stop
  lock_release
}
# Świeże demo dla kolejnej fazy: zatrzymuje WŁASNE poprzednie drzewo i czeka (do 5 s), aż port
# zwolni się po nim. Port zajęty dalej albo od początku = cudza usługa: błąd, nikogo nie zabijamy.
demo_fresh() {
  local phase="$1" _
  step_begin "demo server for $phase"
  if [[ -n "$IOS_DEMO_PID" ]]; then
    demo_stop
    for _ in $(seq 1 20); do
      ios_demo_port_busy "$DEMO_PORT" || break
      sleep 0.25
    done
  fi
  if ios_demo_port_busy "$DEMO_PORT"; then
    ios_die "port $DEMO_PORT is busy (any service) — stop it or set RAROG_IOS_DEMO_PORT"
  fi
  IOS_DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rarog-demo.XXXXXX")"
  echo "== demo server on 127.0.0.1:$DEMO_PORT for $phase (data: $IOS_DEMO_DIR)"
  ios_demo_start "$DEMO_PORT" "$IOS_DEMO_DIR" "$IOS_DEMO_DIR/server.log" pnpm -C "$ROOT" run demo:server
  for _ in $(seq 1 60); do
    curl -s -m 1 "http://127.0.0.1:$DEMO_PORT/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  if ! curl -s -m 1 "http://127.0.0.1:$DEMO_PORT/health" >/dev/null 2>&1; then
    # Demo, które nie wstało, zostawia swój katalog z logiem do diagnozy, jak czerwony xcodebuild.
    local kept="$IOS_DEMO_DIR"
    IOS_DEMO_DIR=""
    ios_die "demo server did not come up (log: $kept/server.log)"
  fi
  step_end
}
if [[ "${RAROG_IOS_SKIP_DEMO:-0}" != 1 ]]; then
  command -v pnpm >/dev/null 2>&1 || ios_die "no pnpm — cannot start a fresh demo"
  if [[ ! "$DEMO_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || ((DEMO_PORT > 65535)); then
    ios_die "RAROG_IOS_DEMO_PORT needs a port 1–65535, without leading zeros"
  fi
  [[ "$DEMO_PORT" != 8930 ]] || ios_die "port 8930 is the live Rarog — XCUITest targets the demo only"
fi

trap 'exit 130' INT
trap 'exit 143' TERM
lock_acquire

if [[ "${RAROG_IOS_SKIP_DEMO:-0}" != 1 ]]; then
  demo_fresh "Swift integrations"
  # xcodebuild przekazuje zmienne `TEST_RUNNER_*` do procesu testów bez prefiksu.
  export RAROG_DEMO_PORT="$DEMO_PORT" TEST_RUNNER_RAROG_DEMO_PORT="$DEMO_PORT"
  flow="demo :$DEMO_PORT"
else
  echo "== demo integrations: skipped (RAROG_IOS_SKIP_DEMO=1) — incomplete gate"
fi

tested=0
for manifest in "$PACKAGES_DIR"/*/Package.swift; do
  [[ -e "$manifest" ]] || continue
  package="$(dirname "$manifest")"
  step_begin "swift test $(basename "$package")"
  echo "== swift test $(basename "$package")"
  # Pakiet z zależnością zdalną (RarogTerminal → SwiftTerm) jedzie wyłącznie na pinach z Package.resolved.
  pins=()
  [[ ! -f "$package/Package.resolved" ]] || pins=(--force-resolved-versions)
  xcrun swift test --package-path "$package" ${pins[@]+"${pins[@]}"}
  step_end
  tested=$((tested + 1))
done
((tested > 0)) || ios_die "no packages in $PACKAGES_DIR"

if [[ ! -d "$XCODE_PROJECT" ]]; then
  echo "== xcodebuild: skipped (the app project native/Rarog/Rarog.xcodeproj does not exist)"
  echo "ios-check: incomplete gate ($tested packages; no app project)"
  exit 0
fi

# Integracje Swift zmieniły seedy demo: XCUITest dostaje nowe, świeże demo na tym samym porcie.
# Wywołanie w ciele `if`, nie w liście `||`: tam `set -e` nie działałby wewnątrz funkcji.
ui_flow_prepare() {
  if [[ "$flow" != "skipped" ]]; then
    demo_fresh "XCUITest"
    sim_udid="$(ios_sim_udid "$SIMULATOR" "$SIMULATOR_OS")" || sim_udid=""
    if [[ -n "$sim_udid" ]]; then
      push_signals="$(mktemp -d "${TMPDIR:-/tmp}/rarog-push.XXXXXX")"
      ios_push_relay "$push_signals" "$sim_udid" "$IOS_BUNDLE_ID" &
      PUSH_RELAY_PID=$!
      export TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR="$push_signals"
      echo "== host push: simctl push → $SIMULATOR ($sim_udid), signals in $push_signals"
    else
      echo "== host push: skipped (no simulator UDID: $SIMULATOR) — the push test will skip"
    fi
  fi
}
# Stan okna apki zostaje w symulatorze między przebiegami. iPadOS 26 pozwala wyciągnąć apkę z pełnego
# ekranu przeciągnięciem za górny pasek okna, a SpringBoard zapamiętuje jej ostatni rozmiar okna w bazie stanu apek
# i otwiera ją potem jako pływające okno — także po ponownym starcie, restarcie symulatora i ODINSTALOWANIU apki
# (zmierzone: wpis stoi 40 s po `simctl uninstall`). XCUITest liczy wtedy ramki w mniejszym, przesuniętym oknie
# i pada daleko od przyczyny („+” paska zakładek bez punktu tapnięcia, ekran logowania bez przycisku, panel bez miejsca).
# Przywraca pełny ekran skasowanie samego wpisu przy WYŁĄCZONYM symulatorze (zmierzone zrzutem); xcodebuild
# uruchamia go potem sam. To prywatna baza systemu: brak bazy, inny schemat albo nieznany symulator to nie błąd
# bramki, tylko zdanie w wyniku. Bazy DZIAŁAJĄCEGO symulatora nie rusza: `simctl shutdown` kończy się błędem i przy
# odmowie, i przy urządzeniu już wyłączonym, więc rozstrzyga stan z listy urządzeń.
SIM_WINDOW_KEY=SBApplicationLastWindowSizePerDisplayOrdinalKey
sim_window_reset() {
  local udid db
  step_begin "app window in the simulator"
  udid="$(ios_sim_udid "$SIMULATOR" "$SIMULATOR_OS")" || udid=""
  if [[ -z "$udid" ]]; then
    echo "== app window in the simulator: skipped (no simulator UDID: $SIMULATOR)"
    step_end
    return 0
  fi
  db="${RAROG_IOS_SIM_DEVICES:-$HOME/Library/Developer/CoreSimulator/Devices}/$udid"
  db="$db/data/Library/FrontBoard/applicationState.db"
  if [[ ! -f "$db" ]]; then
    echo "== app window in the simulator: skipped (no app state database — fresh simulator)"
    step_end
    return 0
  fi
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  if ! xcrun simctl list devices 2>/dev/null | grep -F "($udid)" | grep -q "(Shutdown)"; then
    echo "== app window in the simulator: skipped (the simulator did not shut down — the database of a running system stays untouched)"
    step_end
    return 0
  fi
  if sqlite3 "$db" "delete from kvs
      where application_identifier in
        (select id from application_identifier_tab where application_identifier = '$IOS_BUNDLE_ID')
      and key in (select id from key_tab where key = '$SIM_WINDOW_KEY');" >/dev/null 2>&1; then
    echo "== app window in the simulator: saved window size deleted (full screen at launch)"
  else
    echo "== app window in the simulator: could not delete the saved window size (XCUITest may run in a window)"
  fi
  step_end
}
# Wynik każdego testu widać (pominięty ≠ zielony); status zostaje z xcodebuild. Pełny log xcodebuild idzie do
# pliku, a bramka pokazuje z niego wiersze wyników na bieżąco (`fflush` w filtrze).
# Strażnik ciszy: pełna bramka stała 4 h bez postępu po zawieszonym teście i padzie CoreSimulatora.
# Log bez przyrostu przez RAROG_IOS_SILENCE s (domyślnie 600) kończy WŁASNY xcodebuild i bramkę kodem 124.
# `-collect-test-diagnostics never`: po każdej porażce xcodebuild zbierał `simctl diagnose` do 10 min.
# Limit czasu jednego testu: kroki po 60 s („App animations complete notification not received”)
# trzymały zawieszony test 24–46 min, a strażnik ciszy ich nie łapie, bo xcodebuild pisze wiersz przy każdym kroku.
# Test dłuższy niż 300 s (≈ 3× najdłuższy zdrowy XCUITest, 104 s) XCTest kończy porażką, robi spindump, restartuje
# proces testów i idzie do następnego testu. Pomiar z limitem 60 s: porażka „Test exceeded execution time allowance
# of 1 minute”, spindump ~47 s (test w tym czasie biegnie dalej), następny test startuje ~51 s po limicie i przechodzi.
# Wyjątek: `TreeListAnchorTests` (UIKit) ustawia sobie 600 s w `setUp`.
# Funkcja idzie w liście `||` (niżej `step_red`), gdzie `set -e` w niej nie działa: błędy sprawdza jawnie.
xcode_tests() {
  local raw size=-1 since=$SECONDS status=0 code=0 _
  raw="$(mktemp "${TMPDIR:-/tmp}/rarog-xcodebuild.XXXXXX")" || return 1
  xcrun xcodebuild "$@" -project "$XCODE_PROJECT" -scheme Rarog "${RAROG_XCODE_PACKAGE_ARGS[@]}" \
    -destination "platform=iOS Simulator,name=$SIMULATOR,OS=$SIMULATOR_OS" -collect-test-diagnostics never \
    -test-timeouts-enabled YES -default-test-execution-time-allowance 300 \
    "${TEST_LANGUAGE_ARGS[@]}" >"$raw" 2>&1 &
  XCODE_PID=$!
  # The filter reads the log up to the end marker (appended after xcodebuild exits), so the last lines are not lost.
  # `tail` is a background job and awk gets its output through process substitution: `$!` is the pid of `tail`
  # itself and `xcode_stop` kills it directly. After awk exits, `tail -f` waits for a write that never comes, so it
  # lives until someone kills it. With a pipe in a subshell `$!` would point at the subshell and only `pgrep -P`
  # would find `tail`, which the Claude Code sandbox refuses: every gate run in the sandbox would leave an orphan.
  tail -n +1 -f "$raw" > >(awk -v done="$raw.done" '
    $0 == "__RAROG_XCODE_END__" { system("touch \"" done "\""); exit }
    /Test Case .*(passed|failed|skipped)|error:|\*\* TEST/ { print; fflush() }') &
  XCODE_FILTER_PID=$!
  while kill -0 "$XCODE_PID" 2>/dev/null; do
    sleep "$SILENCE_POLL"
    local now
    now="$(wc -c <"$raw")"
    if [[ "$now" != "$size" ]]; then
      size="$now"
      since=$SECONDS
    elif ((SECONDS - since >= SILENCE)); then
      echo "ios-check: xcodebuild log silent for ${SILENCE} s — stopping the hung run (log: $raw)" >&2
      xcode_kill "$XCODE_PID"
      status=124
      break
    fi
  done
  wait "$XCODE_PID" || code=$?
  ((status)) || status=$code
  XCODE_PID=""
  echo "__RAROG_XCODE_END__" >>"$raw"
  for _ in $(seq 1 100); do
    [[ ! -e "$raw.done" ]] || break
    sleep 0.1
  done
  xcode_stop
  rm -f "$raw.done"
  if ((status == 0)); then rm -f "$raw"; else echo "ios-check: full xcodebuild log: $raw" >&2; fi
  return "$status"
}
# Czerwony krok na symulatorze albo build nie kończy bramki: XCUITest ma zawsze znane porażki,
# więc z `set -e` testy RarogTerminal i build na urządzenie nigdy nie ruszały. Bramka zapamiętuje kod pierwszej
# porażki, idzie dalej i kończy się nim na końcu. Zawieszony przebieg (124, strażnik ciszy) kończy ją od razu:
# symulator jest wtedy w złym stanie, a xcodebuild RarogTerminal strażnika ciszy nie ma.
gate_status=0
gate_red=()
step_red() {
  local code="$1" step="$2"
  ((code != 124)) || exit 124
  ((gate_status)) || gate_status="$code"
  gate_red+=("$step")
  echo "ios-check: $step — red (code $code); the gate goes on and exits with the first failure's code" >&2
}
ui_run="all XCUITest"
if [[ "$QUICK" == 1 ]]; then
  step_begin "xcodebuild test Rarog without XCUITest"
  echo "== xcodebuild test Rarog without XCUITest — quick gate ($SIMULATOR, iOS $SIMULATOR_OS)"
  xcode_tests test -skip-testing:RarogUITests || step_red $? "xcodebuild test Rarog without XCUITest"
  step_end
  ui_run="without XCUITest"
  if [[ -n "$UI_TESTS" ]]; then
    only=()
    IFS=',' read -r -a items <<<"$UI_TESTS"
    for item in "${items[@]}"; do [[ -z "$item" ]] || only+=("-only-testing:RarogUITests/$item"); done
    ui_flow_prepare
    sim_window_reset
    step_begin "selected XCUITest"
    echo "== selected XCUITest: $UI_TESTS (flow: $flow)"
    xcode_tests test "${only[@]}" || step_red $? "selected XCUITest"
    step_end
    ui_run="XCUITest only: $UI_TESTS"
  fi
else
  ui_flow_prepare
  sim_window_reset
  step_begin "xcodebuild test Rarog"
  echo "== xcodebuild test Rarog ($SIMULATOR, iOS $SIMULATOR_OS; flow: $flow)"
  xcode_tests test || step_red $? "xcodebuild test Rarog"
  step_end
fi

# Testy UIKit pakietów, których `swift test` na macOS nie uruchomi (`#if os(iOS)`): powierzchnia SwiftTerm
# (`RarogTerminalTests`) na tym samym symulatorze, schematem pakietu. Projekt apki ich nie widzi —
# cel testów pakietu lokalnego dopisany do schematu `Rarog` xcodebuild pomija.
uikit_packages=(RarogTerminal)
for package in "${uikit_packages[@]}"; do
  [[ -f "$PACKAGES_DIR/$package/Package.swift" ]] || continue
  step_begin "xcodebuild test $package"
  echo "== xcodebuild test $package ($SIMULATOR, iOS $SIMULATOR_OS)"
  (cd "$PACKAGES_DIR/$package" && xcrun xcodebuild test -scheme "$package" "${RAROG_XCODE_PACKAGE_ARGS[@]}" \
    -destination "platform=iOS Simulator,name=$SIMULATOR,OS=$SIMULATOR_OS" -collect-test-diagnostics never \
    "${TEST_LANGUAGE_ARGS[@]}" 2>&1) | grep -E "Test run with|✘|error:|\*\* TEST" \
    || step_red $? "xcodebuild test $package"
  step_end
done

# Języki zbudowanej apki (`scripts/ios-app-languages.sh`) po zielonym buildzie na urządzenie: ścieżkę `.app`
# podaje `xcodebuild -showBuildSettings` dla tych samych ustawień (domyślne DerivedData).
app_languages() {
  local app
  app="$(xcrun xcodebuild -showBuildSettings -project "$XCODE_PROJECT" -scheme Rarog -configuration Debug \
    "${RAROG_XCODE_PACKAGE_ARGS[@]}" -destination "generic/platform=iOS" 2>/dev/null \
    | awk '/^Build settings for action build and target Rarog:$/ { target = 1; next }
      /^Build settings for / { target = 0 }
      target && $1 == "CODESIGNING_FOLDER_PATH" { sub(/^[^=]*= /, ""); print; exit }')" || true
  if [[ -z "$app" ]]; then
    echo "ios-check: xcodebuild -showBuildSettings gave no path of the built app" >&2
    return 1
  fi
  echo "== app languages: $app"
  bash "$ROOT/scripts/ios-app-languages.sh" "$app"
}

device="skipped"
if [[ "${RAROG_IOS_SKIP_DEVICE:-$QUICK}" == 1 ]]; then
  echo "== device build: skipped (RAROG_IOS_SKIP_DEVICE=1)"
elif [[ "${RAROG_IOS_SIGN:-0}" == 1 ]]; then
  step_begin "device build"
  echo "== xcodebuild build Rarog (generic/platform=iOS) signed, not installed"
  if xcrun xcodebuild build -quiet -project "$XCODE_PROJECT" -scheme Rarog -configuration Debug \
    "${RAROG_XCODE_PACKAGE_ARGS[@]}" -destination "generic/platform=iOS" -allowProvisioningUpdates; then
    step_begin "app languages"
    app_languages || step_red $? "app languages"
  else
    step_red $? "device build"
  fi
  step_end
  device="signed"
else
  step_begin "device build"
  echo "== xcodebuild build Rarog (generic/platform=iOS) unsigned (RAROG_IOS_SIGN=1 checks signing)"
  if xcrun xcodebuild build -quiet -project "$XCODE_PROJECT" -scheme Rarog -configuration Debug \
    "${RAROG_XCODE_PACKAGE_ARGS[@]}" -destination "generic/platform=iOS" CODE_SIGNING_ALLOWED=NO; then
    step_begin "app languages"
    app_languages || step_red $? "app languages"
  else
    step_red $? "device build"
  fi
  step_end
  device="unsigned"
fi

if ((gate_status)); then
  printf -v red '%s, ' "${gate_red[@]}"
  echo "ios-check: red — ${red%, } ($tested packages; device build $device; exit code of the first failure)" >&2
  exit "$gate_status"
elif [[ "$QUICK" == 1 ]]; then
  echo "ios-check: quick gate green — NOT full ($tested packages; $ui_run; device build $device)."
  echo "The integrator runs the full gate (all XCUITest) before merging."
elif [[ "$flow" == "skipped" ]]; then
  echo "ios-check: incomplete gate ($tested packages; no demo integrations; device build $device)"
else
  echo "ios-check: green ($tested packages; app: tested on the simulator, device build $device)"
fi
