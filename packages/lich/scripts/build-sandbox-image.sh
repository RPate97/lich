#!/usr/bin/env bash
# Builds the lich-sandbox-base Tart image: clone an Ubuntu base, install
# Docker + Bun + lich inside, save.
#
# Prerequisites:
#   - macOS with Tart (brew install cirruslabs/cli/tart)
#   - lich binary built (cd packages/lich && bun run build)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LICH_BIN="$REPO_ROOT/packages/lich/dist/lich"
BASE_IMAGE="${BASE_IMAGE:-ghcr.io/cirruslabs/ubuntu:latest}"
TARGET_NAME="${TARGET_NAME:-lich-sandbox-base}"

if ! command -v tart >/dev/null 2>&1; then
  echo "error: tart not found. brew install cirruslabs/cli/tart" >&2
  exit 1
fi

if [ ! -x "$LICH_BIN" ]; then
  echo "error: lich binary not found at $LICH_BIN. Run: cd packages/lich && bun run build" >&2
  exit 1
fi

echo "Cleaning up any prior $TARGET_NAME..."
tart delete "$TARGET_NAME" 2>/dev/null || true

echo "Cloning $BASE_IMAGE -> $TARGET_NAME..."
tart clone "$BASE_IMAGE" "$TARGET_NAME"

echo "Setting VM resources..."
# --disk-size resize triggers UnsupportedArchitectureError on M1+macOS Tahoe;
# the cirruslabs base image's default disk is enough for our installs.
tart set "$TARGET_NAME" --memory 4096 --cpu 4

echo "Starting VM..."
# Redirect required: backgrounded `tart run` without redirect dies with
# UnsupportedArchitectureError on M1+macOS Tahoe.
tart run --no-graphics "$TARGET_NAME" > "/tmp/tart-run-$TARGET_NAME.log" 2>&1 &
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
echo "Copying lich binary into VM..."
tart exec --interactive "$TARGET_NAME" sudo tee /tmp/lich >/dev/null < "$LICH_BIN"
tart exec "$TARGET_NAME" sudo chmod +x /tmp/lich

echo "Copying setup script into VM..."
tart exec --interactive "$TARGET_NAME" sudo tee /tmp/setup.sh >/dev/null < "$SCRIPT_DIR/sandbox-image-setup.sh"

echo "Running setup (this takes ~3-5 min)..."
tart exec "$TARGET_NAME" sudo bash /tmp/setup.sh

echo "Stopping VM..."
trap - EXIT
tart stop "$TARGET_NAME"
wait "$TART_PID" 2>/dev/null || true

echo ""
echo "Image $TARGET_NAME built successfully."
echo "Use with: tart clone $TARGET_NAME my-workspace"
