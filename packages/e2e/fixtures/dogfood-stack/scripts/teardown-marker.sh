#!/usr/bin/env bash
# teardown-marker.sh — diagnostic for the dogfood-stack's top-level
# `lifecycle.before_down` hook (LEV-473).
#
# Writes a marker file proving the hook fired AND that the env_group
# plumbing carried env into the down-side hook. Mirrors write-marker.sh
# (after_up) so e2e coverage of before_down has the same shape as
# after_up.
#
# Path: $LICH_HOME/teardown-marker.txt. The e2e test points LICH_HOME at
# a tmpdir and reads the file after `lich down`.
#
# Env vars captured:
#   TEST_MODE      — literal from the `stack-plus-test` env_group
#   LICH_WORKTREE  — built-in stack var (proves stack env passed through)
#   API_URL        — top-level env (proves top-level env reached down hook;
#                    LEV-485 sentinel — pre-fix this would be empty)
#   FAKE_SECRET_TOKEN — top-level env_from value (proves env_from reached
#                    down hook; LEV-485 sentinel)

set -euo pipefail

out_path="${LICH_HOME:-/tmp}/teardown-marker.txt"
mkdir -p "$(dirname "$out_path")"

printf 'TEST_MODE=%s\nLICH_WORKTREE=%s\nAPI_URL=%s\nFAKE_SECRET_TOKEN=%s\n' \
  "${TEST_MODE:-}" "${LICH_WORKTREE:-}" "${API_URL:-}" "${FAKE_SECRET_TOKEN:-}" \
  > "$out_path"
