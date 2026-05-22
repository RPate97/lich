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

# link_and_verify <source> <dest>
# Creates a symlink at <dest> pointing to <source>, then asserts the
# resulting link both exists (-L) and resolves to a real path (-e).
# On failure logs to stderr and returns non-zero so the caller can fall
# back to a real install. Idempotent: if <dest> already exists as a
# valid symlink to <source> the function is a no-op.
link_and_verify() {
  local src="$1" dest="$2"
  ln -sfn "$src" "$dest"
  if [[ -L "$dest" && -e "$dest" ]]; then
    return 0
  fi
  echo "worktree hook: symlink verification failed for $dest -> $src" >&2
  return 1
}

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
    # Each link is verified after creation; on verification failure we fall
    # back to a real `bun install` inside the worktree so the agent still
    # gets a working tree (slower, but correct beats silent breakage).
    root_ok=1
    if [[ -d "$PROJECT_DIR/node_modules" && ! -e "$WT_DIR/node_modules" ]]; then
      if ! link_and_verify "$PROJECT_DIR/node_modules" "$WT_DIR/node_modules"; then
        root_ok=0
      fi
    fi

    if [[ -d "$PROJECT_DIR/packages" ]]; then
      for pkg_dir in "$PROJECT_DIR/packages"/*/; do
        pkg_name=$(basename "$pkg_dir")
        if [[ -d "$pkg_dir/node_modules" && ! -e "$WT_DIR/packages/$pkg_name/node_modules" ]]; then
          mkdir -p "$WT_DIR/packages/$pkg_name"
          if ! link_and_verify "$pkg_dir/node_modules" "$WT_DIR/packages/$pkg_name/node_modules"; then
            # A bad per-package link is enough to force a full reinstall —
            # the workspace is consistent or it isn't.
            root_ok=0
          fi
        fi
      done
    fi

    # Legacy tools/cli/node_modules symlink (only if both paths exist in this worktree)
    if [[ -d "$PROJECT_DIR/tools/cli/node_modules" && -d "$WT_DIR/tools/cli" && ! -e "$WT_DIR/tools/cli/node_modules" ]]; then
      link_and_verify "$PROJECT_DIR/tools/cli/node_modules" "$WT_DIR/tools/cli/node_modules" || root_ok=0
    fi

    # Fallback: if any symlink verification failed, drop the bad links and
    # do a real install inside the worktree. Slower but the worktree ends
    # up usable instead of subtly broken.
    if [[ "$root_ok" -eq 0 ]]; then
      echo "worktree hook: falling back to 'bun install' inside $WT_DIR" >&2
      # Strip broken symlinks so bun install can populate fresh.
      [[ -L "$WT_DIR/node_modules" ]] && rm -f "$WT_DIR/node_modules"
      if [[ -d "$WT_DIR/packages" ]]; then
        for pkg_dir in "$WT_DIR/packages"/*/; do
          [[ -L "$pkg_dir/node_modules" ]] && rm -f "$pkg_dir/node_modules"
        done
      fi
      (cd "$WT_DIR" && bun install >&2) || \
        echo "worktree hook: 'bun install' fallback also failed; worktree may be broken" >&2
    fi

    # LEV-220: Re-anchor @levelzero/* workspace symlinks in the shared node_modules.
    # When bun install runs inside a worktree (the fallback path above, or any agent
    # that runs `bun install` manually), Bun resolves the "packages/*" workspace glob
    # relative to the worktree's directory and writes @levelzero/* symlinks that point
    # at that worktree's packages/.  Since the worktree's node_modules is actually a
    # symlink to the main repo's node_modules, those stale symlinks persist after the
    # worktree is removed.  We fix this every time a worktree is created so that the
    # shared node_modules always reflects the main repo's packages/.
    if [[ -f "$PROJECT_DIR/scripts/sync-workspace-symlinks.sh" ]]; then
      echo "worktree hook: re-anchoring @levelzero/* workspace symlinks in shared node_modules" >&2
      (cd "$PROJECT_DIR" && bash scripts/sync-workspace-symlinks.sh >&2) || \
        echo "worktree hook: sync-workspace-symlinks failed (non-fatal)" >&2
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
