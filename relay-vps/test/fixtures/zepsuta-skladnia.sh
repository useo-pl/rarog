#!/usr/bin/env bash
# Celowo zepsuta fikstura testu bramki (`relay-vps/test/bramka.test.ts`): `if` bez `fi`, więc `bash -n` pada.
set -euo pipefail
if [[ -n "${1:-}" ]]; then
  printf '%s\n' "$1"
