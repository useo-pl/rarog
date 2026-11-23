#!/usr/bin/env bash
# Celowo zepsuta fikstura testu bramki (`relay-vps/test/bramka.test.ts`): składnia poprawna, więc `bash -n`
# przechodzi, ale ShellCheck zgłasza SC2086 (zmienna bez cudzysłowu).
set -euo pipefail
katalog="${1:-}"
printf '%s\n' $katalog
