#!/usr/bin/env bash
# Push z hosta dla XCUITest apki natywnej (scripts/ios-check.sh). Plik jest ŹRÓDŁOWANY.
#
# Runner testów chodzi W symulatorze i `xcrun simctl push` nie uruchomi, więc rozmawia z hostem
# plikami: test kładzie ładunek APNs jako `<nazwa>.request` w katalogu sygnałów (zmienna
# `TEST_RUNNER_RAROG_PUSH_SIGNAL_DIR`, w runnerze bez prefiksu), a pętla stąd wysyła go na wskazany
# symulator i odpisuje `<nazwa>.sent` z `ok` albo `fail`. Wysłany ładunek dostaje nazwę `<nazwa>.done`.
# Nic nie jest kasowane: katalog sygnałów to świeży `mktemp -d` jednego przebiegu.

# UDID symulatora po nazwie i wersji systemu (`latest` = najnowszy runtime iOS z taką nazwą, `27` albo
# `27.0` = dokładnie ten). Czyta tekstowe `simctl list devices available` (bez pythona: jego shim w
# `/usr/bin` zależy od `DEVELOPER_DIR`). Pusty wynik = takiego symulatora nie ma.
ios_sim_udid() {
  local name="$1" os="$2" line version="" best="" best_rank=-1 rank
  while IFS= read -r line; do
    if [[ "$line" =~ ^--\ iOS\ ([0-9]+)\.([0-9]+)\ --$ ]]; then
      version="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
      rank=$((BASH_REMATCH[1] * 100 + BASH_REMATCH[2]))
      continue
    fi
    if [[ "$line" == --* ]]; then
      version=""
      continue
    fi
    [[ -n "$version" ]] || continue
    [[ "$os" == latest || "$os" == "$version" || "$os" == "${version%%.*}" ]] || continue
    # „    <nazwa> (<UDID>) (<stan>)" — nazwa sama może mieć nawiasy („iPad Pro 11-inch (M5)").
    if [[ "$line" =~ ^[[:space:]]+(.+)\ \(([0-9A-Fa-f-]{36})\)\ \([^\(\)]*\)[[:space:]]*$ ]] \
      && [[ "${BASH_REMATCH[1]}" == "$name" ]] && ((rank > best_rank)); then
      best="${BASH_REMATCH[2]}"
      best_rank=$rank
    fi
  done < <(xcrun simctl list devices available 2>/dev/null)
  [[ -z "$best" ]] || echo "$best"
}

# Pętla przekaźnika; chodzi do zabicia (ios-check.sh zatrzymuje ją po testach).
# Użycie: ios_push_relay <katalog sygnałów> <udid> <bundle id>
ios_push_relay() {
  local dir="$1" udid="$2" bundle="$3" request name result error
  while true; do
    for request in "$dir"/*.request; do
      [[ -e "$request" ]] || continue
      name="${request%.request}"
      # Ostatnia linia błędu `simctl` trafia do testu (np. „Source is not authorized" = apka bez zgody).
      if error="$(xcrun simctl push "$udid" "$bundle" "$request" 2>&1 >/dev/null)"; then
        result=ok
      else
        result="fail: ${error##*$'\n'}"
      fi
      mv "$request" "$name.done"
      echo "$result" >"$name.sent"
    done
    sleep 0.2
  done
}
