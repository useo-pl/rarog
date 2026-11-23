#!/usr/bin/env bash
# Tożsamość natywnej apki dla skryptów iOS: JEDNO źródło bundle id. Plik jest źródłowany (`ios-lib.sh`,
# `ios-check.sh`), nie uruchamiany. Same przypisania: bez Xcode, bez `ios_die`, bez wywołań i bez wyjścia, więc
# działa pod `set -euo pipefail` każdego skryptu, który go źródłuje (także w atrapie testu bramki).
#
# Zgodność z projektem Xcode (`PRODUCT_BUNDLE_IDENTIFIER` celu `Rarog`, prefiks pozostałych celów) i z tematem
# APNs serwera (`RAROG_APNS_TOPIC`) pilnuje `server/test/product-identity-guard.test.ts`.

# Zmienną czytają skrypty, które ten plik źródłują (SC2034 nie widzi ich przez `source`).
# shellcheck disable=SC2034
IOS_BUNDLE_ID="ai.rarog.app"

# Numeryczne Apple ID apki w App Store Connect (`altool --upload-package --apple-id` przy wysyłce do TestFlightu):
# ASC → apka → App Information → Apple ID. Tożsamość produktu, nie sekret. Puste albo nie liczba = TestFlight
# odmawia przed archiwum (pilnuje też `server/test/product-identity-guard.test.ts`).
# shellcheck disable=SC2034
IOS_ASC_APP_APPLE_ID="6826126556"
