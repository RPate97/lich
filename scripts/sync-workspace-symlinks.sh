#!/usr/bin/env bash
# sync-workspace-symlinks.sh — repair stale @levelzero/* workspace symlinks.
#
# BACKGROUND (LEV-220)
# --------------------
# During parallel agent-driven development each agent runs in a temporary git
# worktree under /tmp/levelzero-worktrees/agent-XXX/.  The worktree hook
# symlinks that worktree's node_modules -> main repo's node_modules (to avoid
# a full per-worktree bun install).  If an agent then runs `bun install`
# inside its worktree, Bun resolves the "packages/*" workspace glob relative
# to the WORKTREE's directory and writes @levelzero/* symlinks into what is
# actually the main repo's node_modules.  After the worktree is merged and
# discarded, those symlinks point at stale (or deleted) paths — causing the
# CLI to silently run old code.
#
# HOW THIS SCRIPT WORKS
# ---------------------
# It resolves node_modules to its REAL path (following any symlink created by
# the worktree hook), then re-anchors every @levelzero/* symlink relative to
# that real node_modules location.  Works correctly whether invoked from the
# main repo or any agent worktree.
#
# USAGE
# -----
#   bun run sync-workspace-symlinks      # from the monorepo root
#   bash scripts/sync-workspace-symlinks.sh [--check]
#
# FLAGS
#   --check   Dry-run: report stale/broken links but make no changes (exit 1
#             if any stale or broken symlink is found).
#
# EXIT CODES
#   0  All symlinks are healthy (or were repaired successfully).
#   1  --check mode: at least one stale/broken symlink found.
#   2  Unexpected error.
set -euo pipefail

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Locate node_modules relative to the invocation directory (repo root when
# called via `bun run`).  Then resolve to its REAL path so that even if
# node_modules is a symlink to the main repo we operate on the actual files.
INVOKE_DIR="$(pwd)"
NM_LINK="$INVOKE_DIR/node_modules"

if [[ ! -e "$NM_LINK" && ! -L "$NM_LINK" ]]; then
  echo "node_modules not found in $(pwd); run 'bun install' first." >&2
  exit 2
fi

# python3 -c for cross-platform realpath (macOS lacks GNU readlink -f on older systems).
REAL_NM="$(python3 -c "import os; print(os.path.realpath('$NM_LINK'))")"
REAL_ROOT="$(dirname "$REAL_NM")"
REAL_NM_LEVELZERO="$REAL_NM/@levelzero"
REAL_PACKAGES="$REAL_ROOT/packages"

if [[ ! -d "$REAL_NM_LEVELZERO" ]]; then
  echo "node_modules/@levelzero does not exist; run 'bun install' first." >&2
  exit 2
fi

if [[ ! -d "$REAL_PACKAGES" ]]; then
  echo "packages/ directory not found at $REAL_PACKAGES" >&2
  exit 2
fi

fixed=0
stale=0
broken=0
ok=0

# Use find to enumerate all direct children, including broken symlinks.
# The glob `*/` used in a for-loop skips dangling symlinks, which is exactly
# the case we most need to catch (deleted worktree => BROKEN link).
while IFS= read -r link; do
  pkg="$(basename "$link")"
  expected_pkg_dir="$REAL_PACKAGES/$pkg"

  # Real directory install — not a symlink, leave it alone.
  if [[ ! -L "$link" ]]; then
    ((ok++)) || true
    continue
  fi

  raw_target="$(readlink "$link")"

  # Resolve to absolute, gracefully (target may not exist).
  if [[ "$raw_target" = /* ]]; then
    resolved="$raw_target"
  else
    resolved="$(cd "$(dirname "$link")" && cd "$raw_target" 2>/dev/null && pwd)" || resolved=""
  fi

  # Already correct.
  if [[ "$resolved" == "$expected_pkg_dir" ]]; then
    ((ok++)) || true
    continue
  fi

  # Stale or broken.
  if [[ -z "$resolved" || ! -d "$resolved" ]]; then
    echo "BROKEN: node_modules/@levelzero/$pkg -> $raw_target"
    ((broken++)) || true
  else
    echo "STALE:  node_modules/@levelzero/$pkg -> $resolved"
    ((stale++)) || true
  fi

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    continue
  fi

  if [[ ! -d "$expected_pkg_dir" ]]; then
    echo "  SKIP: packages/$pkg not found in $REAL_ROOT — cannot repair." >&2
    continue
  fi

  # Compute relative path from @levelzero/ dir to the package dir so the
  # symlink remains valid if the whole tree is moved.
  rel_target="$(python3 -c "import os; print(os.path.relpath('$expected_pkg_dir', '$(dirname "$link")'))")"
  ln -sfn "$rel_target" "$link"
  echo "  FIXED -> $rel_target (in $REAL_ROOT)"
  ((fixed++)) || true
done < <(find "$REAL_NM_LEVELZERO" -maxdepth 1 -mindepth 1 2>/dev/null || true)

total_bad=$((stale + broken))

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  if [[ "$total_bad" -gt 0 ]]; then
    echo ""
    echo "CHECK FAILED: $total_bad stale/broken symlink(s) found ($ok healthy)."
    echo "Run 'bun run sync-workspace-symlinks' to repair."
    exit 1
  else
    echo "CHECK OK: all $ok @levelzero/* symlinks are healthy."
    exit 0
  fi
fi

if [[ "$total_bad" -eq 0 ]]; then
  echo "All $ok @levelzero/* symlinks are already healthy — nothing to do."
else
  echo ""
  echo "Repaired $fixed of $total_bad stale/broken symlink(s). $ok were already healthy."
fi
