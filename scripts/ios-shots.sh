#!/usr/bin/env bash
# Strona Maca dla zrzutów XCUITest apki natywnej. Zrzut `XCUIApplication.screenshot()` iPada w poziomie wychodzi
# na symulatorze iOS 27 obrócony i ucięty, więc testy zrzutów (`WindowsUITests`, `InspectorUITests`,
# `GlassScreenshotUITests`…) przy `RAROG_SCREENSHOT_SYNC=1` zostawiają w `RAROG_SCREENSHOT_DIR` prośbę
# `<plik>.request` i czekają, aż ten skrypt zrobi zrzut symulatora przez `xcrun simctl io … screenshot`.
#
# Użycie (obok bramki, w tle):
#   bash scripts/ios-shots.sh <katalog> [udid|booted] [limit sekund]
# i w bramce: TEST_RUNNER_RAROG_SCREENSHOT_DIR=<katalog> TEST_RUNNER_RAROG_SCREENSHOT_SYNC=1.
# Kończy się po pliku `stop` w katalogu albo po limicie (domyślnie 2400 s). Zrzuty robi z symulatora o podanym
# UDID; `booted` działa tylko, gdy chodzi dokładnie jeden symulator.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${1:-}"
udid="${2:-booted}"
limit="${3:-2400}"

shots_die() {
  echo "ios-shots: $*" >&2
  exit 1
}

[[ -n "$dir" && -d "$dir" ]] || shots_die "give an existing screenshot directory"
[[ "$limit" =~ ^[1-9][0-9]*$ ]] || shots_die "limit: a number of seconds greater than zero"
[[ "$udid" == booted || "$udid" =~ ^[0-9A-Fa-f-]{36}$ ]] || shots_die "udid: a simulator identifier or booted"

# shellcheck source=/dev/null
source "$ROOT/scripts/xcode-toolchain.sh"
DEVELOPER_DIR="$(rarog_xcode_developer_dir)" || shots_die "no Xcode toolchain"
export DEVELOPER_DIR

start=$SECONDS
while ((SECONDS - start < limit)); do
  [[ ! -e "$dir/stop" ]] || break
  for request in "$dir"/*.request; do
    [[ -e "$request" ]] || continue
    target="${request%.request}"
    part="$target.part.png"
    # Zrzut idzie do pliku obok i wchodzi pod właściwą nazwę tylko, gdy prośba wciąż stoi: test, który się nie
    # doczekał, zdejmuje prośbę i zapisuje zrzut zapasowy, a spóźniony zrzut innego ekranu nie może go nadpisać.
    if xcrun simctl io "$udid" screenshot --type=png "$part" >/dev/null 2>&1 && [[ -e "$request" ]]; then
      mv -f -- "$part" "$target"
      rm -f -- "$request"
      echo "screenshot: $(basename "$target")"
    else
      rm -f -- "$part"
    fi
  done
  sleep 0.3
done
