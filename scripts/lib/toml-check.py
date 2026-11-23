"""Składnia plików TOML dla bramki repo (`scripts/check.sh`, CI): konfiguracja relaya iroh, `relay-vps/*.toml`.

    python3 -I scripts/lib/toml-check.py [<plik.toml> ...]

Parser to `tomllib` z biblioteki standardowej Pythona 3.11+, więc repo nie niesie zależności TOML. Kod 0: każdy plik
się parsuje (także pusta lista); kod 1: plik nie do odczytu albo z błędem składni, po linii `toml: <plik>: <błąd>`
na stderr; kod 2: Python bez `tomllib`. Opis: `docs/publishing.md`, „check.sh --strict”.
"""
import sys

try:
    import tomllib
except ImportError:
    print('toml: no tomllib module (needs Python 3.11+)', file=sys.stderr)
    sys.exit(2)


def main(paths):
    bad = 0
    for name in paths:
        try:
            with open(name, 'rb') as handle:
                tomllib.load(handle)
        except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
            print(f'toml: {name}: {error}', file=sys.stderr)
            bad += 1
    print(f'toml: files checked: {len(paths)}, with errors: {bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
