#!/usr/bin/env bash
#
# Pełna bramka repo BEZ skutków dla produkcji (`pnpm run check`).
#
# Nic tutaj nie dotyka serwera na 8930: typecheck i testy czytają źródła, więc równoległa sesja
# agenta może puścić bramkę w worktree.
#
#   bash scripts/check.sh [--strict]
#
# Kroki warunkowe (plik prywatnych literałów, `swift-contract`, relay, `git diff --check` bez `.git`, ShellCheck,
# TOML, zizmor) bez swojego narzędzia mówią „skipped" i bramka jest zielona z listą pominięć w ostatniej linii.
# `--strict` (albo `RAROG_CHECK_STRICT=1`; bramka publikacji) zamienia każde pominięcie w porażkę z nazwą kroku
# (kod 3), a brak pliku literałów w porażkę od razu, przed testami. Opis: `docs/publishing.md`, „check.sh --strict”.
set -euo pipefail
cd "$(dirname "$0")/.."

STRICT=0
if [[ "${RAROG_CHECK_STRICT:-}" == 1 ]]; then STRICT=1; fi
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    *)
      echo "usage: scripts/check.sh [--strict] (unknown argument: $arg)" >&2
      exit 2
      ;;
  esac
done
# Lista pominiętych kroków jako napis: pusta tablica pod `set -u` w bashu 3.2 przewraca rozwinięcie.
POMINIETE=""
pominiete() {
  POMINIETE="${POMINIETE:+$POMINIETE, }$1"
}

# Plik prywatnych literałów spoza repo (`docs/publishing.md`): bez niego strażniki nazw w testach się pomijają,
# a w `--strict` testy dostają `RAROG_REQUIRE_PRIVATE_LITERALS=1` (pominięcie = czerwony test). Zepsuty plik
# przewraca bramkę zawsze (kod 2 loadera), bo nie może wyglądać jak brak.
echo "== private literals"
literaly=0
node scripts/lib/private-literals.mjs || literaly=$?
case "$literaly" in
  0) ;;
  3)
    echo "private literals: file missing, name guards skipped"
    if [[ $STRICT == 1 ]]; then
      echo "check --strict: skipped step: private literals (private literals file missing)" >&2
      exit 3
    fi
    pominiete "private literals"
    ;;
  *)
    echo "check: private literals file is broken (field name above)" >&2
    exit 2
    ;;
esac
if [[ $STRICT == 1 ]]; then export RAROG_REQUIRE_PRIVATE_LITERALS=1; fi

echo "== typecheck"
pnpm run typecheck
echo "== test"
# `RAROG_CHECK_TEST_REPORT=<plik>`: ta sama komenda z dodatkowym raportem JSON vitest, z którego narzędzie
# sprawdzające bramkę czyta liczby testów per plik (`docs/publishing.md`, „check.sh --strict”).
if [[ -n "${RAROG_CHECK_TEST_REPORT:-}" ]]; then
  pnpm test --reporter=default --reporter=json --outputFile.json="$RAROG_CHECK_TEST_REPORT"
else
  pnpm test
fi
# Katalogi copy apki natywnej (`docs/localization.md`, „Guards”): komplet wymaganych języków, liczba mnoga,
# parametry między językami, klucze `L("…")` z kodu. Strażnik literałów poza rejestrem to test
# `server/test/native-copy-guard.test.ts` (wyżej, w `pnpm test`).
echo "== l10n-check (app copy catalogs)"
node scripts/l10n-check.mjs
# Krok `swift-contract`: dekoder Swift apki natywnej przechodzi złote ramki SSE z `shared/fixtures/sse/`,
# więc zmiana `shared/` albo producentów ramek bez zmiany typów Swift przewraca bramkę tutaj.
# Krok warunkowy na pełny Xcode (wybór w `scripts/xcode-toolchain.sh`); brak toolchainu to
# JAWNE „skipped", nie cichy sukces. Poza sandboksem (cache w /var/folders).
echo "== swift-contract (native/Rarog/Packages/RarogContract)"
# Biblioteki nie śledzimy (`source=/dev/null`): lintuje ją glob `scripts/*.sh` niżej, a test
# `scripts-check.test.ts` puszcza ShellCheck na samym check.sh, bez `-x`.
# shellcheck source=/dev/null
source scripts/xcode-toolchain.sh
if xcode_dev="$(rarog_xcode_developer_dir)"; then
  echo "swift-contract: Xcode from $xcode_dev"
  # Język copy procesu testów przypięty (`docs/localization.md`, „Tests”): bez zmiennej `CopyLanguage` zatrzymuje proces.
  RAROG_COPY_LANGUAGE=pl DEVELOPER_DIR="$xcode_dev" xcrun swift test --package-path native/Rarog/Packages/RarogContract
else
  echo "swift-contract: skipped (no Xcode toolchain)"
  pominiete "swift-contract"
fi
# Przekaźnik push (`relay/README.md`): osobny projekt pnpm z własnymi zależnościami (wrangler), więc krok
# warunkowy na `relay/node_modules` (`pnpm -C relay install`). Brak instalacji to JAWNE „skipped", nie sukces;
# przed wdrożeniem przekaźnika runbook wymaga tych samych komend bez względu na ten krok.
echo "== relay (push relay: typecheck and tests)"
if [[ -d relay/node_modules ]]; then
  pnpm -C relay run typecheck
  pnpm -C relay test
else
  echo "relay: skipped (no relay/node_modules; pnpm -C relay install)"
  pominiete "relay"
fi
# Rejestr relaya iroh (`relay-auth/README.md`): osobny projekt pnpm jak przekaźnik; importuje moduły wspólne
# z `relay/src/`, a te biorą zależności z `relay/node_modules`, więc krok wymaga instalacji obu projektów.
# Brak którejkolwiek to JAWNE „skipped", nie sukces.
echo "== relay-auth (iroh relay registry: typecheck and tests)"
if [[ -d relay-auth/node_modules && -d relay/node_modules ]]; then
  pnpm -C relay-auth run typecheck
  pnpm -C relay-auth test
else
  echo "relay-auth: skipped (no relay-auth/node_modules or relay/node_modules; pnpm -C relay install"
  echo "  and pnpm -C relay-auth install)"
  pominiete "relay-auth"
fi
echo "== git diff --check (whitespace, conflict markers)"
# `.git` bywa katalogiem albo plikiem (worktree); eksport bez historii nie ma żadnego.
if [[ -e .git ]]; then
  git diff --check
  git diff --cached --check
else
  echo "git diff --check: skipped (no .git)"
  pominiete "git diff --check"
fi
# Relay iroh na VPS (`relay-vps/README.md`): skrypty i TOML z samego `relay-vps/`, bez podkatalogów, więc celowo
# zepsute fikstury testu bramki (`relay-vps/test/fixtures/`) jej nie przewracają. Katalog bywa bez skryptów i bez
# TOML: `nullglob` daje wtedy pustą tablicę, a pustą tablicę pod `set -u` bash 3.2 rozwija tylko jako
# `${a[@]+"${a[@]}"}`.
shopt -s nullglob
relay_vps_sh=(relay-vps/*.sh)
relay_vps_toml=(relay-vps/*.toml)
# Shell libraries sourced by `scripts/*.sh`; the directory may hold none.
lib_sh=(scripts/lib/*.sh)
shopt -u nullglob
echo "== bash -n scripts/*.sh scripts/lib/*.sh relay-vps/*.sh"
for f in scripts/*.sh; do bash -n "$f"; done
for f in ${lib_sh[@]+"${lib_sh[@]}"}; do bash -n "$f"; done
for f in ${relay_vps_sh[@]+"${relay_vps_sh[@]}"}; do bash -n "$f"; done
if command -v shellcheck >/dev/null 2>&1; then
  echo "== shellcheck scripts/*.sh scripts/lib/*.sh relay-vps/*.sh"
  shellcheck scripts/*.sh
  if [[ ${#lib_sh[@]} -gt 0 ]]; then shellcheck "${lib_sh[@]}"; fi
  if [[ ${#relay_vps_sh[@]} -gt 0 ]]; then shellcheck "${relay_vps_sh[@]}"; fi
else
  echo "== shellcheck: skipped (not in PATH; brew install shellcheck)"
  pominiete "shellcheck"
fi
# Składnia TOML (`scripts/lib/toml-check.py`): `tomllib` z biblioteki standardowej Pythona 3.11+, bez zależności
# w repo. Krok warunkowy jak ShellCheck: bez `python3` z `tomllib` jawne „skipped”. `-I` trzyma katalog skryptu
# i zmienne `PYTHON*` poza ścieżką modułów.
if python3 -I -c 'import tomllib' >/dev/null 2>&1; then
  echo "== toml relay-vps/*.toml"
  python3 -I scripts/lib/toml-check.py ${relay_vps_toml[@]+"${relay_vps_toml[@]}"}
else
  echo "== toml: skipped (no python3 with tomllib, Python 3.11+)"
  pominiete "toml"
fi
# Audyt workflow GitHub Actions (zizmor): wstrzyknięcia w szablonach, uprawnienia tokenu, cache, przypięcie akcji.
# Wejściem jest cały `.github/`, więc audyt bierze też konfigurację Dependabota, jeśli repo ją ma. Krok warunkowy
# jak ShellCheck: bez `zizmor` w PATH jawne „skipped”. `--offline`: bez sieci i tokenu GitHuba, więc wynik zależy
# tylko od plików repo. `--strict-collection`: plik, którego zizmor nie sparsuje, przewraca bramkę (bez flagi zizmor
# go pomija z ostrzeżeniem i kończy się kodem 0). Każde znalezisko przewraca bramkę.
if command -v zizmor >/dev/null 2>&1; then
  echo "== zizmor .github"
  zizmor --offline --strict-collection .github
else
  echo "== zizmor: skipped (not in PATH; uv tool install zizmor)"
  pominiete "zizmor"
fi
if [[ -n "$POMINIETE" ]]; then
  if [[ $STRICT == 1 ]]; then
    echo "check --strict: skipped steps: $POMINIETE" >&2
    exit 3
  fi
  echo "check: green — production untouched (skipped: $POMINIETE)"
else
  echo "check: green — production untouched"
fi
