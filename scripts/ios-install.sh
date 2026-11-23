#!/usr/bin/env bash
# Instaluje i uruchamia natywną apkę Rarog na sparowanym iPadzie (po scripts/ios-build.sh).
# Przez sieć działa tylko w tej samej sieci lokalnej co Mac; przez Tailscale nie zakładamy.
# Apka łączy się z serwerem, z którym ją sparowano (klucz w Keychainie); bez klucza — ekran parowania.
set -euo pipefail
# Bibliotekę lintuje osobno glob `scripts/*.sh` w check.sh (ShellCheck bez `-x`).
# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/ios-lib.sh"

app="${1:-$IOS_APP}"
[[ -d "$app" ]] || ios_die "no $app — run bash scripts/ios-build.sh first"

read -r _ device <<<"$(ios_device)" || true
[[ -n "${device:-}" ]] || ios_die "iPad not connected — unlock it on the same Wi-Fi network as the Mac or connect a cable"

xcrun devicectl device install app --device "$device" "$app"
xcrun devicectl device process launch --device "$device" "$IOS_BUNDLE_ID"
