#!/usr/bin/env bash
# Build lich + symlink it onto your PATH so you can run the current
# working-tree version as `lich` anywhere.
#
#   bun run link        # from the repo root
#
# The symlink lands at $HOME/.local/bin/lich and points at
# packages/lich/dist/lich. Rebuilding (`bun run build`) updates the
# binary in place — the next `lich` invocation picks up the new code
# without needing to re-link.
#
# The CLI finds `lich-daemon` as a sibling of `process.execPath` after
# following the symlink, so we only need to link `lich` itself; the
# daemon resolves automatically.
#
# Run `bun run unlink` to remove the symlink. Re-running this script
# is safe — `ln -sf` replaces an existing symlink.

set -euo pipefail

# Resolve the repo root from this script's location so `bun run link`
# works regardless of cwd.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${LICH_PREFIX:-$HOME/.local}"
BIN_DIR="$PREFIX/bin"
SOURCE_BIN="$REPO_ROOT/packages/lich/dist/lich"
LINK_PATH="$BIN_DIR/lich"

echo "==> Building lich..."
(cd "$REPO_ROOT" && bun run build)

if [ ! -x "$SOURCE_BIN" ]; then
  echo "Error: build succeeded but $SOURCE_BIN is missing or not executable." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
ln -sf "$SOURCE_BIN" "$LINK_PATH"

echo ""
echo "✓ Linked: $LINK_PATH -> $SOURCE_BIN"
echo ""
echo "Verify:"
echo "  which lich        # should print $LINK_PATH"
echo "  lich --version"
echo ""

# PATH hint — only print if $BIN_DIR isn't already on PATH so we don't
# pester users who've configured their shell.
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "$BIN_DIR is on your PATH — you're ready."
    ;;
  *)
    echo "Note: $BIN_DIR is NOT on your PATH. Add it:"
    case "${SHELL:-}" in
      */zsh)  echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
      */bash) echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
      */fish) echo "  fish_add_path $BIN_DIR" ;;
      *)      echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
    esac
    ;;
esac
