#!/usr/bin/env bash
# worktree-verify.sh — assert that the shared-node_modules symlinks in a
# Claude Code agent worktree are healthy.
#
# Usage:
#   bash .claude/hooks/worktree-verify.sh [WORKTREE_DIR]
#
# Exits 0 and prints "OK" if every expected symlink either:
#   - is absent (nothing to verify),
#   - is a real directory (a per-worktree install — not our concern), or
#   - is a symlink whose target is reachable.
#
# Exits 1 and prints a one-line diagnosis otherwise. The output is
# designed for `tail -1` consumption by the orchestrator.
#
# Diagnoses (printed to stdout, one per failure):
#   BROKEN: <relpath> -> <target>     symlink exists but target unreachable
#   STALE:  <relpath> -> <target>     symlink points outside PROJECT_DIR (likely
#                                     a sibling worktree from a prior agent)
#   MISSING: node_modules             expected root symlink absent entirely
#
# Recovery (run from inside the worktree):
#   rm -rf node_modules/@lich && bun install
# or, for a full reset:
#   rm node_modules packages/*/node_modules && bun install
set -euo pipefail

WT_DIR="${1:-$(pwd)}"
WT_DIR=$(cd "$WT_DIR" && pwd)  # absolute

# Project dir is where the symlinks should point. Default matches the
# WorktreeCreate hook's expectation; override with LICH_PROJECT_DIR.
PROJECT_DIR="${LICH_PROJECT_DIR:-/Users/ryan/Desktop/programming/levelzero}"

fail=0
report() {
  echo "$1"
  fail=1
}

check_link() {
  local rel="$1"
  local full="$WT_DIR/$rel"

  # Path doesn't exist at all.
  if [[ ! -e "$full" && ! -L "$full" ]]; then
    # The root node_modules MUST exist (or be a symlink) for the workspace
    # to resolve. Per-package node_modules are optional.
    if [[ "$rel" == "node_modules" ]]; then
      report "MISSING: $rel"
    fi
    return
  fi

  # Not a symlink — that's fine, it's a real install in the worktree.
  if [[ ! -L "$full" ]]; then
    return
  fi

  local target
  target=$(readlink "$full")

  # Symlink exists but target is unreachable (the [ -e ] test follows links).
  if [[ ! -e "$full" ]]; then
    report "BROKEN: $rel -> $target"
    return
  fi

  # Symlink resolves, but points outside the project dir. That usually means
  # a sibling worktree's node_modules — stale code from a prior agent.
  # Resolve to absolute path for comparison.
  local resolved
  if [[ "$target" = /* ]]; then
    resolved="$target"
  else
    resolved=$(cd "$(dirname "$full")" && cd "$(dirname "$target")" 2>/dev/null && pwd)/$(basename "$target")
  fi
  case "$resolved" in
    "$PROJECT_DIR"/*) : ;;  # ok
    *) report "STALE: $rel -> $resolved" ;;
  esac
}

# Root node_modules — required.
check_link "node_modules"

# Per-package node_modules — optional, but if present, must be healthy.
if [[ -d "$WT_DIR/packages" ]]; then
  for pkg_dir in "$WT_DIR/packages"/*/; do
    pkg_name=$(basename "$pkg_dir")
    check_link "packages/$pkg_name/node_modules"
  done
fi

# Legacy tools/cli/node_modules — only check if path exists.
if [[ -e "$WT_DIR/tools/cli/node_modules" || -L "$WT_DIR/tools/cli/node_modules" ]]; then
  check_link "tools/cli/node_modules"
fi

if [[ "$fail" -eq 0 ]]; then
  echo "OK"
  exit 0
fi
exit 1
