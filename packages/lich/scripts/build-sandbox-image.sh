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
tart set "$TARGET_NAME" --memory 4096 --cpu 4 --disk-size 30

echo "Starting VM..."
tart run --no-graphics --detach "$TARGET_NAME" &
TART_PID=$!

echo "Waiting for SSH..."
IP=""
for i in {1..60}; do
  IP=$(tart ip "$TARGET_NAME" 2>/dev/null || echo "")
  if [ -n "$IP" ] && ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
       -o ConnectTimeout=2 admin@"$IP" true 2>/dev/null; then
    echo "VM reachable at $IP"
    break
  fi
  sleep 2
done

if [ -z "$IP" ]; then
  echo "error: VM did not become reachable in 120s" >&2
  exit 1
fi

echo "Copying lich binary and setup script into VM..."
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$LICH_BIN" admin@"$IP":/tmp/lich
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$SCRIPT_DIR/sandbox-image-setup.sh" admin@"$IP":/tmp/setup.sh

echo "Running setup (this takes ~3-5 min)..."
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    admin@"$IP" "sudo bash /tmp/setup.sh"

echo "Stopping VM..."
tart stop "$TARGET_NAME"

echo ""
echo "Image $TARGET_NAME built successfully."
echo "Use with: tart clone $TARGET_NAME my-workspace"
