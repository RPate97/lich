#!/bin/bash
# Builds the lich-sandbox-base Tart image: clone an Ubuntu base, install
# Docker + Bun + lich inside, save.
#
# Prerequisites:
#   - macOS with Tart (brew install cirruslabs/cli/tart)
#   - bun on PATH (the Linux guest binaries are cross-compiled here)
set -euo pipefail

# Virtualization.framework refuses to create a VM from a translated (x86_64)
# process — Tart reports it as UnsupportedArchitectureError. An x86_64 bash on
# PATH (Intel Homebrew) re-execs us under Rosetta; force back to native arm64.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
  exec arch -arm64 /bin/bash "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LICH_DIR="$REPO_ROOT/packages/lich"
BASE_IMAGE="${BASE_IMAGE:-ghcr.io/cirruslabs/ubuntu:latest}"
TARGET_NAME="${TARGET_NAME:-lich-sandbox-base}"

if ! command -v tart >/dev/null 2>&1; then
  echo "error: tart not found. brew install cirruslabs/cli/tart" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun not found on PATH." >&2
  exit 1
fi

# The guest is Linux; a host (Mach-O) binary fails with ENOEXEC. Tart on Apple
# Silicon only runs arm64 guests, so cross-compile for bun-linux-arm64.
echo "Cross-compiling lich + lich-daemon for the Linux guest (arm64)..."
( cd "$LICH_DIR"
  bun build --compile --target=bun-linux-arm64 --outfile=dist/lich-linux-arm64 src/bin/lich.ts
  bun build --compile --target=bun-linux-arm64 --outfile=dist/lich-daemon-linux-arm64 src/bin/lich-daemon.ts
)
LICH_LINUX="$LICH_DIR/dist/lich-linux-arm64"
DAEMON_LINUX="$LICH_DIR/dist/lich-daemon-linux-arm64"

echo "Cleaning up any prior $TARGET_NAME..."
tart stop "$TARGET_NAME" 2>/dev/null || true
tart delete "$TARGET_NAME" 2>/dev/null || true

echo "Cloning $BASE_IMAGE -> $TARGET_NAME..."
tart clone "$BASE_IMAGE" "$TARGET_NAME"

echo "Setting VM resources..."
tart set "$TARGET_NAME" --memory 4096 --cpu 4

echo "Starting VM..."
tart run --no-graphics "$TARGET_NAME" &
TART_PID=$!
trap 'tart stop "$TARGET_NAME" 2>/dev/null || true; kill "$TART_PID" 2>/dev/null || true' EXIT

echo "Waiting for VM to accept exec..."
ready=""
for _ in {1..60}; do
  if tart exec "$TARGET_NAME" true 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "error: VM did not become reachable in 120s" >&2
  exit 1
fi

# tart exec authenticates with the image's default credentials, so no key
# injection is needed. Stream files in over stdin via tee.
echo "Copying lich binaries into VM..."
tart exec -i "$TARGET_NAME" sudo tee /tmp/lich >/dev/null < "$LICH_LINUX"
tart exec -i "$TARGET_NAME" sudo tee /tmp/lich-daemon >/dev/null < "$DAEMON_LINUX"
tart exec "$TARGET_NAME" sudo chmod +x /tmp/lich /tmp/lich-daemon

echo "Copying setup script into VM..."
tart exec -i "$TARGET_NAME" sudo tee /tmp/setup.sh >/dev/null < "$SCRIPT_DIR/sandbox-image-setup.sh"

echo "Running setup (this takes ~3-5 min)..."
tart exec "$TARGET_NAME" sudo bash /tmp/setup.sh

echo "Flushing + stopping VM..."
tart exec "$TARGET_NAME" sudo sync
trap - EXIT
tart stop "$TARGET_NAME"
wait "$TART_PID" 2>/dev/null || true

echo ""
echo "Image $TARGET_NAME built successfully."
echo "Use with: tart clone $TARGET_NAME my-workspace"
