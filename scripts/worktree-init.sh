#!/usr/bin/env bash
# Makes a linked git worktree ready to work in with one command: dependencies installed from the main checkout's pnpm
# store, offline.
#
#   bash scripts/worktree-init.sh        run anywhere inside the worktree
#
# `pnpm-workspace.yaml` sets a relative `storeDir`, so every worktree would otherwise get its own empty store and an
# offline install (or `pnpm pack --offline`) would fail there. The script creates the worktree's store directory and
# links each entry of the main checkout's store into it (`<storeDir>/v11 -> <main>/<storeDir>/v11`). The store
# directory stays a real directory, so the `.gitignore` entry for it still applies. After that, `pnpm store path` in
# the worktree resolves to the main store with no environment variable.
#
# Then, when `node_modules` does not match `pnpm-lock.yaml`, it runs `pnpm install --offline --frozen-lockfile`.
# The install never touches the network and never approves install scripts (`.npmrc` has `ignore-scripts=true`);
# a package missing from the main store fails the install, and the fix is `pnpm install` in the main checkout.
# A second run changes nothing. In the main checkout, or with an absolute `storeDir`, there is no store to link.
#
# Exit codes: 0 ready or nothing to do, 1 the worktree cannot be prepared (the message says why and what to do).
set -euo pipefail

fail() {
  echo "worktree-init: $*" >&2
  exit 1
}

TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git repository"
GIT_DIR_ABS="$(git rev-parse --path-format=absolute --git-dir)"
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"

if [[ "$GIT_DIR_ABS" == "$COMMON_DIR" ]]; then
  echo "worktree-init: $TOP is the main checkout, not a linked worktree; nothing to do"
  exit 0
fi
[[ "$(basename "$COMMON_DIR")" == ".git" ]] \
  || fail "the main repository at $COMMON_DIR has no checkout; nothing to link"
MAIN="$(dirname "$COMMON_DIR")"
cd "$TOP"

changed=0

# The store: storeDir from pnpm-workspace.yaml, relative to the checkout.
store_dir=""
if [[ -f pnpm-workspace.yaml ]]; then
  store_dir="$(sed -n 's/^storeDir:[[:space:]]*//p' pnpm-workspace.yaml | head -n 1)"
  store_dir="${store_dir%\"}"; store_dir="${store_dir#\"}"
  store_dir="${store_dir%\'}"; store_dir="${store_dir#\'}"
fi
if [[ -n "$store_dir" && "$store_dir" != /* ]]; then
  main_store="$MAIN/$store_dir"
  wt_store="$TOP/$store_dir"
  [[ -d "$main_store" ]] || fail "the main checkout has no pnpm store at $main_store; run pnpm install in $MAIN first"
  entries=0
  for src in "$main_store"/*; do
    [[ -e "$src" ]] || continue
    entries=$((entries + 1))
    dest="$wt_store/$(basename "$src")"
    if [[ -L "$dest" ]]; then
      [[ "$(readlink "$dest")" == "$src" ]] && continue
      fail "$dest links to $(readlink "$dest"), not to $src; remove the link and run again"
    fi
    if [[ -e "$dest" ]]; then
      fail "$dest exists and is not a link to the main store; move it out of the worktree and run again"
    fi
    mkdir -p "$wt_store"
    ln -s "$src" "$dest"
    echo "worktree-init: linked $store_dir/$(basename "$src") -> $src"
    changed=1
  done
  ((entries > 0)) || fail "the pnpm store at $main_store is empty; run pnpm install in $MAIN first"
fi

# Dependencies: pnpm keeps a copy of the lockfile it installed in node_modules/.pnpm/lock.yaml.
if ! cmp -s node_modules/.pnpm/lock.yaml pnpm-lock.yaml; then
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is not on PATH"
  echo "worktree-init: installing dependencies offline from the pnpm store"
  # A store variable from the caller's environment would override the link above and record another store path
  # in node_modules, which a later plain `pnpm` call in this worktree would reject.
  env -u pnpm_config_store_dir -u npm_config_store_dir pnpm install --offline --frozen-lockfile \
    || fail "pnpm install --offline failed; for a package missing from the store run pnpm install in $MAIN," \
      "then run this again"
  changed=1
fi

if ((changed)); then
  echo "worktree-init: ready"
else
  echo "worktree-init: already set up; nothing changed"
fi
