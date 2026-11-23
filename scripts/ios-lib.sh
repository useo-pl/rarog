#!/usr/bin/env bash
# Wspólne dla scripts/ios-build.sh i scripts/ios-install.sh — natywna apka Rarog
# (native/Rarog/Rarog.xcodeproj, bundle id `IOS_BUNDLE_ID` z scripts/ios-identity.sh). Plik jest źródłowany, nie
# uruchamiany. Wszystko tu chodzi POZA sandboksem Claude Code: xcodebuild, devicectl i swift piszą
# cache w /var/folders, którego sandbox nie wpuszcza.

# Zmienne niżej czytają skrypty, które ten plik źródłują (SC2034 nie widzi ich przez `source`).
# shellcheck disable=SC2034
IOS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC2034
IOS_DIR="$IOS_ROOT/native/Rarog"
# `IOS_BUNDLE_ID`: jedno źródło dla tej biblioteki i bramki `ios-check.sh` (która tej biblioteki nie źródłuje).
# Plik lintuje osobno glob `scripts/*.sh` w check.sh (ShellCheck bez `-x`).
# shellcheck source=/dev/null
source "$IOS_ROOT/scripts/ios-identity.sh"
IOS_BUILD_DIR="${RAROG_IOS_BUILD_DIR:-$IOS_DIR/build}"
# shellcheck disable=SC2034
IOS_APP="$IOS_BUILD_DIR/Build/Products/Debug-iphoneos/Rarog.app"

ios_die() {
  echo "ios: $*" >&2
  exit 1
}

# Toolchain z pełnego Xcode, bez przestawiania `xcode-select` (globalnie bywa CommandLineTools).
# shellcheck source=/dev/null
source "$IOS_ROOT/scripts/xcode-toolchain.sh"
DEVELOPER_DIR="$(rarog_xcode_developer_dir)" || ios_die "no full Xcode (CommandLineTools cannot build the app)"
export DEVELOPER_DIR

# Klucz API App Store Connect: podpis i profile bez konta zalogowanego w Xcode (`xcodebuild`
# z wiersza poleceń konta z Xcode nie widzi: „No Accounts"). Klucz przychodzi WYŁĄCZNIE ze środowiska:
# trzy zmienne RAROG_ASC_* (np. z menedżera sekretów przy starcie skryptu), wszystkie trzy naraz; gdy
# którejś brakuje, klucza nie ma. Do xcodebuild nie wchodzi żadna zmienna środowiska (`ios_xcodebuild`
# niżej), bo ten zamienia je na ustawienia builda i potrafi je wypisać w logu.
# Treść klucza `.p8` czyta tylko xcodebuild — skrypt przekazuje ŚCIEŻKĘ i niczego nie wypisuje.
# Key ID i Issuer ID to identyfikatory, nie sekret: bez pliku `.p8` nic nie podpiszą.
# Wynik: tablica IOS_ASC_ARGS z flagami `-authenticationKey*`; kod 1, gdy klucza nie ma.
# Klucz TestFlighta tej funkcji nie używa: wysyłka do TestFlightu czyta własną trójkę
# `RAROG_ASC_TESTFLIGHT_*` (treść klucza, nie ścieżka; bez klucza `RAROG_ASC_KEY_*`), zapisuje treść
# do pliku tymczasowego i woła tylko wspólną końcówkę `ios_asc_key_args`.

# Skrypty, które dotykają klucza, muszą być zacommitowane: zmiana „wypisz klucz" nie może przejść
# po cichu edycją i od razu uruchomieniem — musi zostać w historii, którą człowiek widzi. Nie jest to
# pancerz (commit też da się zrobić), tylko zamknięcie drogi „zmień i uruchom bez śladu".
# Lista niżej to ta biblioteka, pliki, które źródłuje, i build na urządzenie. Inny skrypt, który źródłuje tę
# bibliotekę i używa klucza, dopisuje się do listy sam (`IOS_KEY_SCRIPTS+=(…)`) przed `ios_scripts_clean`.
IOS_KEY_SCRIPTS=(scripts/ios-lib.sh scripts/ios-identity.sh scripts/ios-build.sh scripts/xcode-toolchain.sh)

ios_scripts_clean() {
  git -C "$IOS_ROOT" diff --quiet HEAD -- "${IOS_KEY_SCRIPTS[@]}"
}

ios_asc_auth() {
  local key_id issuer path
  IOS_ASC_ARGS=()
  ios_scripts_clean \
    || ios_die "uncommitted changes in ${IOS_KEY_SCRIPTS[*]} — review the diff and commit before using the API key"
  key_id="${RAROG_ASC_KEY_ID:-}"
  issuer="${RAROG_ASC_ISSUER_ID:-}"
  path="${RAROG_ASC_KEY_PATH:-}"
  [[ -n "$key_id" && -n "$issuer" && -n "$path" ]] || return 1
  ios_asc_key_args "$key_id" "$issuer" "$path" RAROG_ASC_KEY_PATH
}

# Wspólna końcówka obu kluczy: plik klucza `$3` (po rozwinięciu `~` i `$HOME`) musi istnieć i mieć prawa 600 albo
# 400; `$4` to źródło ścieżki w komunikacie. Wynik: IOS_ASC_ARGS z Key ID `$1` i Issuer ID `$2`.
ios_asc_key_args() {
  local key_id="$1" issuer="$2" path="$3" where="$4" mode
  path="${path/#\~/$HOME}"
  path="${path//\$HOME/$HOME}"
  [[ -f "$path" ]] || ios_die "$where does not point to a key file"
  mode="$(stat -f %Lp "$path")"
  [[ "$mode" == 600 || "$mode" == 400 ]] || ios_die "the .p8 key has mode $mode — set chmod 600"
  IOS_ASC_ARGS=(-authenticationKeyPath "$path" -authenticationKeyID "$key_id" \
    -authenticationKeyIssuerID "$issuer")
}

# Numer builda (CFBundleVersion) z liczby commitów HEAD podanej w $1
# (`git -C "$IOS_ROOT" rev-list --count HEAD`): jedna reguła dla każdego skryptu, który buduje apkę. Liczba
# rośnie z każdym commitem, więc nowszy build ma wyższy numer i próg serwera (`RAROG_MIN_CLIENT_BUILD`) da się
# ustawić na „starsze niż ten build”. Płytki klon (`git clone --depth`) zna tylko część historii i zaniża
# liczbę: odmowa, także z nadpisaniem, bo nadpisanie porównuje się z tą samą liczbą. Katalog bez gita też jest
# odmową.
# `RAROG_BUILD_NUMBER` nadpisuje numer W GÓRĘ: build ze starszego commita (np. znacznika) z numerem WYŻSZYM niż
# zainstalowany. Nadpisanie musi być liczbą większą od liczby commitów, inaczej skrypt kończy się błędem.
ios_build_number() {
  local count="$1" override="${RAROG_BUILD_NUMBER:-}" shallow
  [[ "$count" =~ ^[0-9]+$ ]] || ios_die "HEAD commit count unknown (${count:-empty})"
  shallow="$(git -C "$IOS_ROOT" rev-parse --is-shallow-repository 2>/dev/null)" || shallow=""
  [[ "$shallow" != true ]] \
    || ios_die "shallow clone: the HEAD commit count ($count) is too low — fetch the full history:" \
      "git -C \"$IOS_ROOT\" fetch --unshallow"
  [[ "$shallow" == false ]] \
    || ios_die "cannot check whether the clone has the full history" \
      "(git rev-parse --is-shallow-repository in $IOS_ROOT)"
  if [[ -z "$override" ]]; then
    echo "$count"
    return 0
  fi
  [[ "$override" =~ ^(0|[1-9][0-9]*)$ ]] || ios_die "RAROG_BUILD_NUMBER=$override is not a number"
  ((override > count)) || ios_die "RAROG_BUILD_NUMBER=$override must be greater than the HEAD commit count ($count)"
  echo "$override"
}

# xcodebuild w CZYSTYM środowisku: tylko to, czego potrzebuje toolchain i pęk kluczy.
ios_xcodebuild() {
  env -i PATH="$PATH" HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" \
    TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" DEVELOPER_DIR="$DEVELOPER_DIR" \
    xcrun xcodebuild "$@"
}

# Wypisuje „<udid> <identyfikator CoreDevice>" POŁĄCZONEGO iPada: RAROG_IOS_DEVICE (udid albo
# identyfikator) albo pierwszego sparowanego. Pusty wynik = iPad niesparowany, uśpiony albo poza
# siecią lokalną (sparowany iPad bez kabla łączy się sam, gdy jest odblokowany w tej samej sieci).
# Plik z listą urządzeń jest tymczasowy: znika po odczycie, także gdy devicectl albo python3 zawiodą.
ios_device() {
  local json status=0
  json="$(mktemp "${TMPDIR:-/tmp}/rarog-ios-devices.XXXXXX")"
  if xcrun devicectl list devices --json-output "$json" >/dev/null 2>&1; then
    ios_device_pick "$json" || status=$?
  fi
  rm -f "$json"
  return "$status"
}
ios_device_pick() {
  python3 - "$1" "${RAROG_IOS_DEVICE:-}" <<'PY'
import json, sys
with open(sys.argv[1]) as handle:
    devices = json.load(handle).get("result", {}).get("devices", [])
want = sys.argv[2]
for device in devices:
    hardware = device.get("hardwareProperties", {})
    udid = hardware.get("udid", "")
    ident = device.get("identifier", "")
    if want and want not in (udid, ident):
        continue
    if not want and (hardware.get("deviceType") != "iPad" or hardware.get("reality") != "physical"):
        continue
    if device.get("connectionProperties", {}).get("tunnelState") != "connected":
        continue
    print(udid, ident)
    break
PY
}
