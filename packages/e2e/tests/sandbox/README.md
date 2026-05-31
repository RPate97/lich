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

---

# Sandbox Disk-Fork V0 — User Guide

When `runtime.sandbox` is configured, your stack runs inside a Linux
microVM instead of on the host. This is **disk-fork**, not warm-memory
fork: a golden VM is baked and shut down, and each fork is a copy-on-write
*disk* clone that boots fresh against the baked disk (migrations, installed
deps, build output survive the clone). Apple Virtualization.framework
cannot suspend Linux guests, so warm-*memory* fork is not possible on
Apple Silicon — see the findings note in
`docs/superpowers/plans/2026-05-30-sandbox-warm-fork-v0.md`.

Measured on M1: CoW clone ~75ms, fork-to-ready ~8s, baked disk survives.

## One-time setup

    brew install cirruslabs/cli/tart
    cd packages/lich
    bun run build
    ./scripts/build-sandbox-image.sh   # ~5-10 min

## Enable for your stack

Add to your `lich.yaml`:

    runtime:
      sandbox:
        backend: tart
        image: lich-sandbox-base
        memory: 4096
        cpus: 4
        warm_fork: true

That's it. `lich up` / `lich down` / `lich logs` / `lich exec` /
`lich stacks` all work exactly as before — they transparently run the
stack inside a sandbox VM instead of on the host.

## Cache management

    lich sandbox status              # list goldens + running VMs
    lich sandbox refresh dev:heavy   # force rebake for this profile
    lich sandbox purge               # wipe everything
    lich sandbox purge --hash abc1   # wipe one golden

## Known V0 limitations

- **Disk-fork only, not warm-memory.** Apple Virtualization.framework cannot
  suspend Linux guests, so a fork boots fresh against the baked disk rather
  than restoring warm RAM. Fork-to-ready is ~8s (process boot), not sub-second.
- **A fork still runs `lich up`, so `after_up` migrations re-run.** The disk is
  warm (install/build artifacts survive) but processes are not running on a
  fresh boot. Skipping migrations on a fork needs the bake/per_fork lifecycle
  split — out of V0 scope. Non-idempotent migrations will error on a fork.
- **Golden creation is explicit (`lich sandbox snapshot`), not automatic** — it
  must stop the stack to flush the disk, so it can't be a silent side effect of `up()`.
- macOS only (Tart). Linux Firecracker backend (with real warm-memory fork) is V1.
- File sync is via Tart's `--dir` mount (virtio-9p); heavy I/O into mounted
  paths is slow — keep node_modules / build outputs inside the VM.
- No friendly URL routing host → guest. Use `tart exec` / port-forward for now.
- Inputs-hash only includes lich.yaml + profile name. Lockfile / migration
  / seed hashing is V1.
- The daemon, if running, lives in the VM. Host-side dashboard is V1.

## When to refresh manually

The inputs-hash detects changes to lich.yaml + profile only. If you change
something the hash doesn't see (seed data, code affecting bake output),
explicitly `lich sandbox refresh <profile>` so the next `lich up`
cold-boots and re-bakes.
