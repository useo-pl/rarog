#!/usr/bin/env bash
# Build natywnej apki Rarog na sparowanego iPada. Podpis automatyczny zespołu z projektu
# (zespół 97TDXJ84WH, płatne konto; inny: RAROG_IOS_TEAM), kluczem API, gdy jest. Build na
# PODŁĄCZONE urządzenie rejestruje je w koncie.
# Wynik: native/Rarog/build/Build/Products/Debug-iphoneos/Rarog.app.
#
# Numer builda (`CFBundleVersion`, UA `RarogApp/<build>`, porównanie z `hello.minClientBuild`) to
# liczba commitów HEAD z `ios_build_number` w ios-lib.sh: odmowa w płytkim klonie, `RAROG_BUILD_NUMBER`
# tylko w górę. Build z samego Xcode ma numer 1.
set -euo pipefail
# Bibliotekę lintuje osobno glob `scripts/*.sh` w check.sh (ShellCheck bez `-x`).
# shellcheck source=/dev/null
source "$(dirname "${BASH_SOURCE[0]}")/ios-lib.sh"

# Numer najpierw: odmowa (płytki klon, nadpisanie w dół) zanim skrypt zacznie szukać iPada i klucza.
build_number="$(ios_build_number "$(git -C "$IOS_ROOT" rev-list --count HEAD)")"

# Połączony iPad = cel buildu (pierwszy podpis dopisuje go do profilu). Bez niego build idzie
# na „dowolne urządzenie iOS" — wystarczy, gdy profil zna iPada z wcześniejszego buildu.
read -r udid _ <<<"$(ios_device)" || true
if [[ -n "${udid:-}" ]]; then
  destination="id=$udid"
else
  destination="generic/platform=iOS"
  echo "ios: iPad not connected — building without a device (install waits for a connection)" >&2
fi

team_override=()
[[ -z "${RAROG_IOS_TEAM:-}" ]] || team_override=("DEVELOPMENT_TEAM=$RAROG_IOS_TEAM")

# Klucz API App Store Connect, gdy jest (bez niego xcodebuild z wiersza poleceń nie widzi konta
# i nie zarejestruje urządzenia ani nie odnowi profilu).
ios_asc_auth || echo "ios: no API key (three RAROG_ASC_* variables from the environment)" \
  "— signing with existing profiles only" >&2

ios_xcodebuild \
  -project "$IOS_DIR/Rarog.xcodeproj" \
  -scheme Rarog \
  -configuration Debug \
  -destination "$destination" \
  -derivedDataPath "$IOS_BUILD_DIR" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  "${RAROG_XCODE_PACKAGE_ARGS[@]}" \
  ${IOS_ASC_ARGS[@]+"${IOS_ASC_ARGS[@]}"} \
  CURRENT_PROJECT_VERSION="$build_number" \
  ${team_override[@]+"${team_override[@]}"} \
  build

echo "ios: built (build $build_number) → $IOS_APP"
