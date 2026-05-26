#!/usr/bin/env bash
# write-marker.sh — diagnostic used by the e2e test for Plan 2 Task 25
# (LEV-345 / lifecycle env_group resolution).
#
# Writes the two env vars the test asserts on to a marker file:
#   TEST_MODE   — the literal injected by the `stack-plus-test` env_group
#   DATABASE_URL — the interpolated value inherited from the `stack` parent
#
# Path selection:
#   - $MARKER_PATH (if set) — used when the test wants an explicit location.
#   - else $LICH_HOME/marker.txt — falls back to the per-stack home dir,
#     which the test points at a tmpdir. LICH_HOME survives the env_group
#     chain because `stack-plus-test` extends `stack` (process_env: true by
#     default), so the host shell's LICH_HOME passes through.
#
# Exits non-zero on missing required vars so a regression in env_group
# wiring surfaces as a clear `lich up` failure rather than a silent
# write-empty.

set -euo pipefail

out_path="${MARKER_PATH:-${LICH_HOME:-/tmp}/marker.txt}"

# Ensure the destination directory exists. `mkdir -p` is a no-op when it
# already does (the common case under LICH_HOME).
mkdir -p "$(dirname "$out_path")"

printf 'TEST_MODE=%s\nDATABASE_URL=%s\n' "${TEST_MODE:-}" "${DATABASE_URL:-}" > "$out_path"
