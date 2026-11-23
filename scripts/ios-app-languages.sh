#!/usr/bin/env bash
# Języki zbudowanej apki (`docs/localization.md`, „How the app picks its language”). iOS wybiera język procesu
# tylko spośród języków jego main bundle (apka: `Rarog.app`, kafel Live Activity: `RarogWidgets.appex`), a katalogi
# copy pakietów idą za tym wyborem. Bez deklaracji każde urządzenie dostaje `CFBundleDevelopmentRegion` (`en`).
#
# Użycie: scripts/ios-app-languages.sh <ścieżka do zbudowanej Rarog.app>
# Woła go `scripts/ios-check.sh` po buildzie na urządzenie; działa też na buildzie na symulator.
#
# Sprawdza każdy wymagany język (`LANGUAGES`, ten sam zestaw co `REQUIRED_LANGUAGES` w `scripts/l10n-check.mjs`):
# 1. `CFBundleLocalizations` w `Info.plist` apki i każdego rozszerzenia z `PlugIns/` (widżet, NSE);
# 2. `<język>.lproj/InfoPlist.strings` w apce (teksty zgód z `InfoPlist.xcstrings`);
# 3. `<język>.lproj` w zasobach każdego pakietu z katalogiem copy
#    (`native/Rarog/Packages/RarogUI/Sources/RarogUI/Copy/Localizable.xcstrings` → `RarogUI_RarogUI.bundle`), w apce
#    i w rozszerzeniach;
#    apka ma zasoby każdego takiego pakietu, widżet — RarogActivity (copy kafla) i RarogContract (katalog zdań
#    serwera), NSE — RarogContract;
# 4. klucze `loc-key` pusha (`LOC_KEYS`, ten sam zestaw co `LOC_KEYS` w `scripts/l10n-check.mjs`) w
#    `<język>.lproj/Localizable.strings` apki i widżetu (katalogi `Rarog/` i `RarogWidgets/Localizable.xcstrings`).
# Kod 0 i podsumowanie albo kod 1 z listą braków; kod 2 przy złym wywołaniu.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANGUAGES=(en pl)
LOC_KEYS=(push.chime.body push.chime.title push.placeholder.body push.placeholder.title)
WIDGET_APPEX="RarogWidgets.appex"
SERVICE_APPEX="RarogNotificationService.appex"

# Pakiety z copy, których zasoby MUSZĄ być w danym rozszerzeniu (poza tym każde znalezione też jest sprawdzane).
# Funkcja zamiast tablicy asocjacyjnej: `/bin/bash` na macOS to 3.2.
required_copy() {
  case "$1" in
    "$WIDGET_APPEX") echo "RarogActivity RarogContract" ;;
    "$SERVICE_APPEX") echo "RarogContract" ;;
  esac
}

die_usage() {
  echo "ios-app-languages: $*" >&2
  echo "usage: scripts/ios-app-languages.sh <path to the built Rarog.app>" >&2
  exit 2
}

[[ $# -eq 1 ]] || die_usage "expected one argument"
app="${1%/}"
[[ -d "$app" && -f "$app/Info.plist" ]] || die_usage "$app is not a built app (no Info.plist)"

copy_packages=()
for catalog in "$ROOT"/native/Rarog/Packages/*/Sources/*/Copy/Localizable.xcstrings; do
  [[ -f "$catalog" ]] || continue
  name="$(basename "$(dirname "$(dirname "$catalog")")")"
  copy_packages+=("$name")
done
((${#copy_packages[@]})) || die_usage "no copy catalogs under $ROOT/native/Rarog/Packages"

problems=()
checked=()
loc_checked=()

# Miejsce w komunikacie: ścieżka względem apki, sama apka jako `Rarog.app`.
where() {
  if [[ "$1" == "$app" ]]; then basename "$app"; else echo "${1#"$app"/}"; fi
}

# Języki z `CFBundleLocalizations` jednego `Info.plist` (plist binarny albo XML), po jednym w linii.
declared_languages() {
  plutil -extract CFBundleLocalizations json -o - "$1" 2>/dev/null | tr -d '[]"' | tr ',' '\n'
}

check_plist() {
  local container="$1" declared language
  declared="$(declared_languages "$container/Info.plist" || true)"
  if [[ -z "$declared" ]]; then
    problems+=("$(where "$container"): Info.plist has no CFBundleLocalizations")
    return
  fi
  for language in "${LANGUAGES[@]}"; do
    command grep -qx "$language" <<<"$declared" \
      || problems+=("$(where "$container"): CFBundleLocalizations is missing $language")
  done
}

# Zasoby pakietu `$2` w `$1`: każdy język ma niepusty `.lproj`. `$3` = 1, gdy zasobów nie może zabraknąć.
check_package() {
  local container="$1" package="$2" required="$3" resources language
  resources="$container/${package}_$package.bundle"
  if [[ ! -d "$resources" ]]; then
    ((required == 0)) || problems+=("$(where "$container"): no ${package}_$package.bundle")
    return
  fi
  for language in "${LANGUAGES[@]}"; do
    if [[ -z "$(find "$resources/$language.lproj" -type f 2>/dev/null | head -1)" ]]; then
      problems+=("$(where "$resources"): no $language.lproj")
    fi
  done
  checked+=("$(where "$resources")")
}

# Klucze `loc-key` w `<język>.lproj/Localizable.strings` kontenera `$1` (plik `.strings` binarny albo tekstowy:
# `plutil -convert json` czyta oba). Klucz szukany jako `"klucz":` w zwartym JSON z `plutil`.
check_loc_keys() {
  local container="$1" language file keys key
  for language in "${LANGUAGES[@]}"; do
    file="$container/$language.lproj/Localizable.strings"
    if [[ ! -f "$file" ]]; then
      problems+=("$(where "$container"): no $language.lproj/Localizable.strings (push loc-keys)")
      continue
    fi
    keys="$(plutil -convert json -o - "$file" 2>/dev/null || true)"
    for key in "${LOC_KEYS[@]}"; do
      command grep -qF "\"$key\":" <<<"$keys" \
        || problems+=("$(where "$container"): $language.lproj/Localizable.strings has no $key (push loc-key)")
    done
  done
  loc_checked+=("$(where "$container")")
}

check_plist "$app"
for language in "${LANGUAGES[@]}"; do
  [[ -f "$app/$language.lproj/InfoPlist.strings" ]] \
    || problems+=("$(where "$app"): no $language.lproj/InfoPlist.strings (usage descriptions)")
done
check_loc_keys "$app"
for package in "${copy_packages[@]}"; do check_package "$app" "$package" 1; done

extensions=0
for appex in "$app"/PlugIns/*.appex; do
  [[ -d "$appex" ]] || continue
  extensions=$((extensions + 1))
  check_plist "$appex"
  [[ "$(basename "$appex")" != "$WIDGET_APPEX" ]] || check_loc_keys "$appex"
  required_here=" $(required_copy "$(basename "$appex")") "
  for package in "${copy_packages[@]}"; do
    required=0
    [[ "$required_here" != *" $package "* ]] || required=1
    check_package "$appex" "$package" "$required"
  done
done
for name in "$SERVICE_APPEX" "$WIDGET_APPEX"; do
  [[ -d "$app/PlugIns/$name" ]] || problems+=("PlugIns: no $name")
done

if ((${#problems[@]})); then
  echo "ios-app-languages: ${#problems[@]} problem(s) in $app:" >&2
  printf '  %s\n' "${problems[@]}" >&2
  exit 1
fi
printf -v languages '%s, ' "${LANGUAGES[@]}"
echo "ios-app-languages: green (${languages%, } in $(basename "$app"), $extensions extensions, package resources:" \
  "${checked[*]}, push loc-keys: ${loc_checked[*]})"
