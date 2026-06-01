# Sandbox E2E Tests

Tests under this directory verify lich's microVM disk-fork via Tart on
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
| bake-fork-share.test.ts       | ~10 min  |
| gc.test.ts                    | ~10 min  |

## CI

These tests do not run in CI (which is Linux). They're intended for
local validation on a Mac dev machine.

---

# Sandbox Bake/Fork — User Guide

When `runtime.sandbox` is configured, your stack runs inside a Linux
microVM instead of on the host. Lich uses **disk-fork** on top of a
content-addressed golden cache: a golden VM is baked once with your
declared inputs (migrations, seed, lockfile), then each `lich up` is a
copy-on-write disk clone of that golden — no re-migration, no
re-install. Goldens are keyed by the content of `bake_inputs`, so
worktrees with identical declared inputs share one golden and diverge
to their own automatically when an input changes.

Apple Virtualization.framework cannot suspend Linux guests, so warm
*memory* fork is not possible on Apple Silicon — see the findings note
in `docs/superpowers/plans/2026-05-30-sandbox-warm-fork-v0.md`. A fork
still has to boot the VM; the win is skipping baked setup work (chiefly
migrations + dep install), not sub-second resume.

## One-time setup

    brew install cirruslabs/cli/tart
    cd packages/lich
    bun run build
    ./scripts/build-sandbox-image.sh   # ~5-10 min

## Enable for your stack

Minimum config:

```yaml
runtime:
  sandbox:
    backend: tart
    image: lich-sandbox-base
    memory: 4096
    cpus: 4
    bake_inputs:
      - db/migrations/**
      - db/seed.sql
      - bun.lockb
```

`bake_inputs` is **required** when `runtime.sandbox` is set. Validation
rejects a sandbox block with missing or empty `bake_inputs`.

`lich up` / `lich down` / `lich logs` / `lich exec` / `lich stacks` all
work exactly as before — they transparently run the stack inside a
sandbox VM instead of on the host.

## 1. `bake_inputs` — what to declare

`bake_inputs` is an array of globs, relative to the worktree root.
Lich hashes the content of every matched file (sorted by path for
determinism) and uses that hash as the cache key for the golden. The
rule is simple:

- If a file's content matters for what gets baked into the golden's
  disk, list it.
- If a file's content only affects runtime behavior (app code, configs
  read at boot), don't.

Typical inputs:

```yaml
runtime:
  sandbox:
    backend: tart
    bake_inputs:
      - db/migrations/**       # schema → baked
      - db/seed.sql            # seed data → baked
      - bun.lockb              # deps → baked (when install runs in before_up)
      - package-lock.json      # same, for npm
```

What NOT to list:

- Application source code. App code is mounted live via `--dir`; baking
  it would force a rebake on every edit and defeat the cache.
- Files outside the worktree (lich only hashes worktree-relative paths).

Changing any matched file changes the hash → the next `lich up`
cold-boots and bakes a fresh golden. There is no partial / delta apply:
any input change is a full rebake (see Limitations).

## 2. The bake/fork model end-to-end

```
lich up
 ├─ compute bake-inputs hash (globs + lich.yaml + profile)
 ├─ golden for this hash exists?
 │   ├─ yes → CoW clone golden → start fork → in-VM `lich up` with
 │   │         LICH_SKIP_BAKED=1 (only per_fork hooks run)
 │   └─ no  → cold boot fresh VM → in-VM `lich up` runs everything
 │            (before_up + after_up: migrations, seed, install)
 └─ stack is live

lich down
 ├─ in-VM `lich down`
 ├─ bake a golden (first-writer-wins — no-op if one already exists)
 └─ stop / destroy the run VM

lich sandbox snapshot   # explicit bake without tearing down the run VM
lich sandbox gc         # run the GC pass manually
lich sandbox status     # inspect golden cache + live forks
lich nuke               # destroy all lich-managed VMs + clear manifests
```

**`LICH_SKIP_BAKED=1`** is an internal env var. Lich sets it
automatically on the fork path before invoking the in-VM `lich up`. The
in-VM lifecycle executor reads it and filters `before_up` / `after_up`
hooks down to those marked `per_fork: true`. You never set this
yourself; it isn't a CLI flag.

### `per_fork: true` — the escape hatch

Some hooks must run on every boot (e.g. registering an ephemeral
URL into the env, contacting a local service that only exists at
runtime). Mark them `per_fork: true`:

```yaml
lifecycle:
  after_up:
    # Baked into the golden — runs on cold boot only, skipped on a fork.
    - psql "$DATABASE_URL" -f db/migrations/01_init.sql
    - psql "$DATABASE_URL" -f db/seed.sql
    # Per-boot: runs on every cold boot AND every fork.
    - cmd: ./scripts/register-tunnel-url.sh
      per_fork: true
```

Only the long (object) form of a hook supports `per_fork`. String-form
hooks (`- ./scripts/foo.sh`) are always treated as baked. If you need
the escape hatch, write the hook in object form.

### First-writer-wins on bake

If two agents `lich down` in parallel with identical bake-inputs hashes,
only the first bake materializes the golden; the second is a no-op. The
same applies to `lich sandbox snapshot` — if a golden for the hash
already exists, the command exits without re-baking.

## 3. Multi-agent / multi-worktree pattern

The canonical workflow for fanning out agents on the same commit:

```bash
# Once per commit (e.g. after `git pull`):
lich sandbox snapshot dev:sandbox   # bake the golden

# Then spawn N agents, each in its own worktree:
git worktree add ../agent-1 HEAD && cd ../agent-1 && lich up dev:sandbox
git worktree add ../agent-2 HEAD && cd ../agent-2 && lich up dev:sandbox
# ... each fork takes tens of seconds, not minutes.
```

Because goldens are content-addressed:

- Two agents on the same commit (identical `bake_inputs` content)
  produce the same hash and share the same golden. One bake, N forks.
- An agent that edits a `bake_inputs`-matched file (say, adds a new
  migration) computes a different hash. Its next `lich up` cold-boots
  and bakes a new golden — automatically, no flags, no manual refresh.
- A third agent that pulls the new commit and runs `lich up` will fork
  off whatever golden matches its hash. If the second agent already
  baked one for the new state, the third agent shares it. If not, the
  third agent cold-boots and bakes it (and then any further agents on
  that commit fork off it).

The cache is the synchronization mechanism. There is no central
registry — every worktree's `lich up` looks at the local
`SnapshotStore`, computes the hash, and decides fork vs. cold-boot
independently.

## 4. Garbage collection

Goldens accumulate — without GC, every commit-worth-of-inputs leaves a
multi-GB VM behind. The default policy:

- Keep the **2 most-recent goldens per profile**.
- Global LRU cap of **20 GB** across all goldens.
- **Never evict a golden with a live fork** (keep-on-uncertainty).

Override either default:

```yaml
runtime:
  sandbox:
    backend: tart
    bake_inputs: ["db/migrations/**", "db/seed.sql"]
    gc:
      keep_per_profile: 3
      max_total_gb: 40
```

GC runs automatically after every successful bake. Manual passes:

```bash
lich sandbox gc        # run GC now, print what was evicted
lich sandbox status    # inspect the cache: hash, profile, age, size,
                       # live-fork count, eviction-candidate marker
lich sandbox status --json
lich nuke              # destroy ALL lich-managed VMs (goldens + runs)
                       # and clear the manifest + forks log
```

`lich sandbox status` also reports, for the current worktree, the
computed bake-inputs hash and whether `lich up` would fork an existing
golden or cold-boot a new one — the "loud, inspectable cache"
principle.

## 5. Honest limitations

- **Rebake-only.** No delta apply, no incremental migration / seed
  layering on a stale golden. Any change to a declared bake input forces
  a full rebake. We explicitly chose this over delta-apply: the
  silent-staleness risk of "apply the diff on top of an older golden"
  is the kind of bug that gets agents stuck for hours, and we'd rather
  pay the rebake cost up front.

- **Fork-to-ready is process-boot-floored.** A fork still boots the VM
  and starts the services from scratch. The cache saves migration time
  and dep-install time, not process-startup time. Expect tens of
  seconds, not sub-second. (Warm-memory fork on Linux is potentially
  future work; on Apple Silicon it's blocked by Virtualization.framework.)

- **`node_modules` under a live `--dir` mount isn't baked.** The host
  mount shadows the in-VM `node_modules` directory, so `bun install` in
  `before_up` writes to a baked path that the mount then hides. If you
  want baked deps, move the install outside the synced path, or rework
  the mount layout. Currently deferred work.

- **Seed changes always rebake.** No incremental seed application.
  Editing `db/seed.sql` invalidates the golden the same way a migration
  does. Keep seed-only iteration on the host or in a profile without
  the sandbox block.

- **Local cache only.** No hosted / shared golden registry, no
  CI-bake-on-merge, no pull-before-bake. Every machine bakes its own
  goldens. The `SnapshotStore` interface is registry-shaped so a
  remote tier can slot in later.

## 6. Quick reference

### Config

```yaml
runtime:
  sandbox:
    backend: tart                  # only backend supported today
    image: lich-sandbox-base       # default
    memory: 4096                   # MB, default 4096
    cpus: 4                        # default 4
    warm_fork: true                # default; set false to disable bake-on-down
    bake_inputs:                   # REQUIRED, >= 1 entry
      - db/migrations/**
      - db/seed.sql
      - bun.lockb
    gc:
      keep_per_profile: 2          # default 2
      max_total_gb: 20             # default 20

lifecycle:
  after_up:
    - psql "$DATABASE_URL" -f db/migrations/01_init.sql   # baked
    - cmd: ./scripts/register-tunnel-url.sh               # per-boot
      per_fork: true
```

### Commands

| Command                       | Purpose                                       |
|-------------------------------|-----------------------------------------------|
| `lich up <profile>`           | Fork matching golden or cold-boot + bake      |
| `lich down`                   | In-VM down, bake golden (first-writer-wins), stop |
| `lich sandbox snapshot [p]`   | Explicit bake without tearing down the run VM |
| `lich sandbox status`         | List goldens (hash, profile, age, size, live forks) |
| `lich sandbox status --json`  | Structured form for tooling                   |
| `lich sandbox gc`             | Run GC pass manually                          |
| `lich sandbox purge`          | Wipe goldens                                  |
| `lich nuke`                   | Destroy all lich-managed VMs + clear manifest |

### Internal env (consumed by in-VM lich)

| Var                     | When set                                       |
|-------------------------|------------------------------------------------|
| `LICH_SANDBOX_GUEST=1`  | Always, inside the sandbox VM                  |
| `LICH_SKIP_BAKED=1`     | Fork path only; filters lifecycle to `per_fork: true` |
| `LICH_NO_BROWSER=1`     | Always, inside the sandbox VM                  |
| `LICH_DAEMON_HOST=0.0.0.0` | Always, inside the sandbox VM               |
