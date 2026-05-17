#!/usr/bin/env bash
# WorktreeCreate / WorktreeRemove hook for Claude Code Agent isolation.
# The runtime sends JSON on stdin:
#   { "cwd": "<project root>", "name": "<branch slug>",
#     "hook_event_name": "WorktreeCreate" | "WorktreeRemove", ... }
# On Create the hook writes the absolute worktree path to stdout.
set -euo pipefail

PAYLOAD=$(cat)
PROJECT_DIR=$(jq -r '.cwd // .projectDir // empty' <<<"$PAYLOAD")
BRANCH=$(jq -r '.name // .branchName // empty' <<<"$PAYLOAD")
EVENT=$(jq -r '.hook_event_name // .eventType // empty' <<<"$PAYLOAD")

if [[ -z "$PROJECT_DIR" || -z "$BRANCH" || -z "$EVENT" ]]; then
  echo "worktree hook: missing required fields (cwd=$PROJECT_DIR, name=$BRANCH, event=$EVENT)" >&2
  exit 1
fi

# Sanitize branch for filesystem use (keep [A-Za-z0-9._-]).
SLUG=$(printf %s "$BRANCH" | tr -c 'A-Za-z0-9._-' '_')
WT_ROOT="/tmp/levelzero-worktrees"
WT_DIR="$WT_ROOT/$SLUG"
WT_BRANCH="wt/$SLUG"

mkdir -p "$WT_ROOT"
cd "$PROJECT_DIR"

case "$EVENT" in
  WorktreeCreate)
    # Reuse an existing worktree+branch if both already exist.
    if git worktree list --porcelain | grep -q "^worktree $WT_DIR\$"; then
      echo "$WT_DIR"
      exit 0
    fi
    if git show-ref --verify --quiet "refs/heads/$WT_BRANCH"; then
      git worktree add "$WT_DIR" "$WT_BRANCH" >&2
    else
      git worktree add "$WT_DIR" -b "$WT_BRANCH" >&2
    fi
    # Symlink shared node_modules to avoid per-worktree reinstall.
    # Workspace root + each package's node_modules (post LEV-140 monorepo split).
    if [[ -d "$PROJECT_DIR/node_modules" && ! -e "$WT_DIR/node_modules" ]]; then
      ln -sfn "$PROJECT_DIR/node_modules" "$WT_DIR/node_modules"
    fi
    if [[ -d "$PROJECT_DIR/packages" ]]; then
      for pkg_dir in "$PROJECT_DIR/packages"/*/; do
        pkg_name=$(basename "$pkg_dir")
        if [[ -d "$pkg_dir/node_modules" && ! -e "$WT_DIR/packages/$pkg_name/node_modules" ]]; then
          mkdir -p "$WT_DIR/packages/$pkg_name"
          ln -sfn "$pkg_dir/node_modules" "$WT_DIR/packages/$pkg_name/node_modules"
        fi
      done
    fi
    # Legacy tools/cli/node_modules symlink (only if both paths exist in this worktree)
    if [[ -d "$PROJECT_DIR/tools/cli/node_modules" && -d "$WT_DIR/tools/cli" && ! -e "$WT_DIR/tools/cli/node_modules" ]]; then
      ln -sfn "$PROJECT_DIR/tools/cli/node_modules" "$WT_DIR/tools/cli/node_modules"
    fi
    echo "$WT_DIR"
    ;;

  WorktreeRemove)
    git worktree remove --force "$WT_DIR" >&2 2>/dev/null || true
    git branch -D "$WT_BRANCH" >&2 2>/dev/null || true
    ;;

  *)
    echo "unknown event: $EVENT" >&2
    exit 1
    ;;
esac
