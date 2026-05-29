#!/usr/bin/env bash
# install-git-hooks.sh — install project git hooks from scripts/git-hooks/.
#
# Run once after cloning (or after a new hook is added to the repo):
#   bun run install-git-hooks
#   bash scripts/install-git-hooks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_HOOKS_SRC="$SCRIPT_DIR/git-hooks"
GIT_HOOKS_DEST="$PROJECT_DIR/.git/hooks"

if [[ ! -d "$GIT_HOOKS_DEST" ]]; then
  echo "No .git/hooks directory found at $GIT_HOOKS_DEST" >&2
  echo "Make sure you are running this from the main repository, not a git worktree." >&2
  exit 1
fi

installed=0
for hook_file in "$GIT_HOOKS_SRC"/*; do
  hook_name="$(basename "$hook_file")"
  dest="$GIT_HOOKS_DEST/$hook_name"

  if [[ -e "$dest" && ! -L "$dest" ]]; then
    # Real file already exists — skip to avoid overwriting a custom hook.
    echo "SKIP: .git/hooks/$hook_name already exists (not a symlink). Remove it to install ours."
    continue
  fi

  cp "$hook_file" "$dest"
  chmod +x "$dest"
  echo "Installed: .git/hooks/$hook_name"
  ((installed++)) || true
done

echo ""
echo "$installed git hook(s) installed."
