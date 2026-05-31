# Sandbox E2E Tests

Tests under this directory verify lich's microVM warm-fork via Tart on
macOS. They SKIP on Linux/Windows and on macOS without Tart installed.

## Requirements

1. macOS (Apple Silicon recommended)
2. Tart: `brew install cirruslabs/cli/tart`
3. Lich binary: `cd packages/lich && bun run build`
4. The `lich-sandbox-base` image for tests that boot real stacks:
   `cd packages/lich && ./scripts/build-sandbox-image.sh`

## Running

All sandbox tests:

    cd packages/e2e && bunx vitest run tests/sandbox/

Individual tests:

    bunx vitest run tests/sandbox/tart-lifecycle.test.ts
    bunx vitest run tests/sandbox/sandbox-warm-fork.test.ts

## Timing expectations

| Test                          | Duration |
|-------------------------------|----------|
| tart-lifecycle.test.ts        | ~2-3 min |
| tart-snapshot-fork.test.ts    | ~2-3 min |
| config-schema.test.ts         | <30s     |
| dev-heavy-profile.test.ts     | ~5-7 min |
| sandbox-cold-up.test.ts       | ~10 min  |
| sandbox-warm-fork.test.ts     | ~15 min  |
| sandbox-tools.test.ts         | <1 min   |

## CI

These tests do not run in CI (which is Linux). They're intended for
local validation on a Mac dev machine.
