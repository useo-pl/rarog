#!/usr/bin/env bash
# Wybór toolchainu Xcode dla natywnej apki: `scripts/ios-check.sh` i krok `swift-contract`
# w `scripts/check.sh`. Plik jest ŹRÓDŁOWANY, nie uruchamiany — jedno miejsce tej logiki.
#
# Liczy się WYŁĄCZNIE pełny Xcode (rozpoznawany po katalogu `Platforms/`): CommandLineTools nie
# mają wtyczki makr Swift Testing, więc `#expect` się na nich nie skompiluje. Kolejność:
# 1. jawne `DEVELOPER_DIR`;
# 2. `xcode-select -p` — Xcode bywa w niestandardowym miejscu (np. `Xcode-beta.app`);
# 3. zapas `RAROG_XCODE_DEFAULT` (domyślnie `/Applications/Xcode.app/Contents/Developer`).
# Kandydat bez `Platforms/` albo bez działającego `xcrun --find swift` jest pomijany.

# Zależności zewnętrzne apki (SwiftTerm `exact: "1.19.0"` w native/Rarog/Packages/RarogTerminal):
# xcodebuild bierze wersje WYŁĄCZNIE z zacommitowanego Package.resolved projektu (bez cichego podbicia przy
# rozwiązywaniu) i ufa wtyczce buildu SwiftTerm (`SwiftTermBuildInfoPlugin`) bez okna Xcode — bez tej flagi
# build z wiersza poleceń pada na walidacji wtyczki (zmierzone). Jedno miejsce dla wszystkich skryptów iOS, które
# budują apkę; `swift test` pakietu z Package.resolved dostaje `--force-resolved-versions` (ios-check).
# Strażnik: server/test/native-deps-pin.test.ts.
# shellcheck disable=SC2034
RAROG_XCODE_PACKAGE_ARGS=(-skipPackagePluginValidation -onlyUsePackageVersionsFromResolvedFile)

# Wypisuje katalog Developer Xcode z działającym `swift`; kod 1 i pusty wynik, gdy go nie ma.
rarog_xcode_developer_dir() {
  local candidate
  for candidate in "${DEVELOPER_DIR:-}" "$(xcode-select -p 2>/dev/null || true)" \
    "${RAROG_XCODE_DEFAULT:-/Applications/Xcode.app/Contents/Developer}"; do
    [[ -n "$candidate" && -d "$candidate/Platforms" ]] || continue
    if DEVELOPER_DIR="$candidate" xcrun --find swift >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}
