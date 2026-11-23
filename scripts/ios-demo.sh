#!/usr/bin/env bash
# Serwer demo dla XCUITest apki natywnej (scripts/ios-check.sh). Plik jest ŹRÓDŁOWANY.
#
# Trzy reguły:
# - port zajęty przez COKOLWIEK (także usługę nie-HTTP, której `curl` nie rozpozna) = błąd przed
#   startem, nie EADDRINUSE w środku przebiegu;
# - serwer startuje w kontrolowanym środowisku (`env -i` z jawną listą):
#   odziedziczony `RAROG_MIN_CLIENT_BUILD` albo `RAROG_IROH` zmieniałby przebieg testów, a treść demo jest
#   przypięta na polski (`RAROG_DEMO_LANG=pl`), bo XCUITest szuka polskich tekstów seedów (domyślnie `en`);
#   a different set is chosen only explicitly (`--lang`, `--content`), never by an inherited variable;
# - sprzątanie zatrzymuje WYŁĄCZNIE drzewo procesów uruchomione przez ten przebieg (pnpm → tsx →
#   node), nigdy „kogokolwiek, kto słucha na porcie".

# Kod 0, gdy ktokolwiek słucha na porcie TCP (dowolny protokół).
ios_demo_port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

# Zatrzymuje proces i wszystkich jego potomków — nic poza tym drzewem.
ios_demo_kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    ios_demo_kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

# Startuje komendę serwera w tle z jawnym środowiskiem; PID w IOS_DEMO_PID.
# Użycie: ios_demo_start [--lang <en|pl>] [--content <set>] <port> <katalog danych> <log> <komenda…>
# Options, not inherited variables: `--lang` sets RAROG_DEMO_LANG (default pl) and `--content` sets
# RAROG_DEMO_CONTENT (unset by default); the same variables in the caller's environment never reach the server.
ios_demo_start() {
  local lang=pl content=""
  while (($#)); do
    case "$1" in
      --lang) lang="$2"; shift 2 ;;
      --content) content="$2"; shift 2 ;;
      *) break ;;
    esac
  done
  local port="$1" data="$2" log="$3"
  shift 3
  local extra=()
  [[ -z "$content" ]] || extra+=(RAROG_DEMO_CONTENT="$content")
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
    RAROG_DEMO=1 RAROG_DEMO_LANG="$lang" ${extra[@]+"${extra[@]}"} RAROG_PORT="$port" \
    RAROG_ORIGINS="http://127.0.0.1:$port" RAROG_DATA_DIR="$data" \
    "$@" >"$log" 2>&1 &
  # Zmienną czyta skrypt, który źródłuje ten plik (SC2034 tego nie widzi).
  # shellcheck disable=SC2034
  IOS_DEMO_PID=$!
}
