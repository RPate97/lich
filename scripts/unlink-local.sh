#!/usr/bin/env bash
# Remove the symlink created by `bun run link`.
#
#   bun run unlink

set -euo pipefail

PREFIX="${LICH_PREFIX:-$HOME/.local}"
LINK_PATH="$PREFIX/bin/lich"

if [ -L "$LINK_PATH" ]; then
  rm "$LINK_PATH"
  echo "✓ Removed $LINK_PATH"
elif [ -e "$LINK_PATH" ]; then
  echo "Warning: $LINK_PATH exists but is not a symlink — leaving it alone." >&2
  echo "If this was installed via install.sh, remove it manually." >&2
  exit 1
else
  echo "Nothing to do: $LINK_PATH does not exist."
fi
