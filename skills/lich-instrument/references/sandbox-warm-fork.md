# Sandbox: warm-fork + dep-bake (microVM)

When the user's stack has a long, repetitive cold boot — heavy migrations, large `node_modules` install, an external CLI launcher like `supabase start` that pulls/starts ~10 containers, or seed-data generation that takes minutes — the per-worktree cost of "spin up a parallel stack to try a thing" becomes the wall. Lich's sandbox feature trades a one-time bake for ~14s warm forks of the entire stack via Tart microVMs on macOS.

This file documents how to instrument a stack to use it, when it pays off, and the patterns that actually work.

## When to suggest it (decision)

Use it when **all** of these hold:

1. Cold boot of the stack on a clean machine takes more than ~60 seconds.
2. The expensive part is reproducible from `lich.yaml` + lockfiles + migration files (not interactive auth, not OS state, not host-network configuration).
3. The user is on macOS with Apple Silicon (Tart requires Apple Virtualization.framework; arm64-only on the M-series; x86 macs are not supported by Tart).
4. The user runs `lich up` from more than one worktree (the warm-fork win is per-worktree, so a single-worktree user gets nothing).

Skip it when **any** of these hold:

- Cold boot is already < 30 seconds (the ~12s VM clone floor swallows the win).
- The user is on Linux or Windows.
- The stack has only host processes and no docker. The expensive setup is already cached by `node_modules`/`__pycache__`/etc. living in the worktree; per-worktree warm-fork doesn't help.
- The user wants the speed but doesn't want a Linux VM in their dev loop. Sandbox literally moves the entire stack into a Linux microVM — services run there, not on the host. That's the trade.

Reference number from the dogfood-stack bench (postgres + 500 migrations + 50k seed rows): **cold 62s → warm 13.8s = 4.5×**. The ~12.6s floor is Tart's clone + resume time; everything above that is the cold-boot work the bake skipped. Stacks with heavier cold boots (real `npm install`, supabase, big seed) hit 10-20× routinely.

## How the model actually works

Three layers:

1. **Base image** (`lich-sandbox-base`): Ubuntu + Docker + Bun + pnpm + ssh + the pre-built `lich`/`lich-daemon` binaries. Built once with `bash packages/lich/scripts/build-sandbox-image.sh`. ~10-20GB. Tied to a specific lich version (the binary inside is the one you ship with).
2. **Golden** (`lich-golden-<inputs-hash>`): A CoW-clone of the base, plus the user's `before_up` and `after_up` lifecycle hooks have run inside it (`bun install`, `supabase start`, migrations applied, etc.), plus an explicit snapshot. Stopped state. Built automatically on the first `lich up` for a given `bake_inputs` hash.
3. **Run VM** (`lich-run-<id>-<profile>`): A CoW-clone of the golden. Source is mutagen-synced in from the host worktree. Services start in their already-baked state. Booted on every `lich up`. Destroyed on `lich down --purge`.

Cold-boot path: clone base → boot → sync source → run lifecycle hooks → start services → snapshot. Takes the full cold-boot duration.

Warm-fork path: hash matches an existing golden → clone golden → boot → sync source (mutagen overwrites everything that's NOT in the sync ignore list) → SKIP lifecycle hooks → start services. Takes ~14s.

The `bake_inputs` field is what decides whether a golden matches. If the hash of all files matching the `bake_inputs` globs is unchanged, the golden is reused. If anything changes — your lockfile, `lich.yaml`, the supabase config — the existing golden is invalidated and a fresh cold boot bakes a new one.

## Prerequisites the user needs

```bash
# 1. macOS Apple Silicon (M-series)
# 2. Tart
brew install cirruslabs/cli/tart

# 3. The base image (one-time, ~3-5 min, ~10-20GB)
bash packages/lich/scripts/build-sandbox-image.sh
# Produces a local Tart image named `lich-sandbox-base`
```

`build-sandbox-image.sh` requires Bun on PATH (it cross-compiles the lich binaries for the Linux guest). If the user does not have Bun, install it first: `curl -fsSL https://bun.sh/install | bash`.

## Minimal `lich.yaml` change

Add a `runtime.sandbox` block. Everything else in `lich.yaml` stays as-is.

```yaml
version: "1"

services:
  postgres:
    image: postgres:16-alpine
    # ...

owned:
  api:
    cmd: bun run dev
    cwd: apps/api
    # ...

# This is the only new block
runtime:
  sandbox:
    backend: tart                  # the only supported backend in v0
    image: lich-sandbox-base       # the local Tart image name; must exist
    warm_fork: true
    bake_inputs:
      - "lich.yaml"
      - "bun.lock"
      - "supabase/config.toml"     # if you use supabase
      - "db/migrations/**"         # if migrations are baked
```

After saving, `lich up` automatically routes through the sandbox. The first up cold-boots and snapshots; every subsequent up (in any worktree of the same repo, until `bake_inputs` content changes) warm-forks.

## What to put in `bake_inputs`

The golden gets invalidated when any file matching these globs changes. Pick the files whose change genuinely requires re-running your `before_up`/`after_up`:

- **Always**: `lich.yaml` itself (services/owned/lifecycle changes alter what the golden contains).
- **Almost always**: the lockfile (`bun.lock`, `pnpm-lock.yaml`, `package-lock.json`, `Gemfile.lock`, `poetry.lock`, `uv.lock`) — when deps change, the bake's `bun install` etc. has more work to do.
- **If used**: external-CLI config files (`supabase/config.toml`, `temporal/config.yml`).
- **If migrations are baked**: `db/migrations/**` or equivalent. Skip if migrations are run per-worktree (not baked into the golden).

Do **not** put source code in `bake_inputs`. Source is mutagen-synced into the run VM from the host, so changes flow without a re-bake. Only put things in `bake_inputs` that the `before_up`/`after_up` hooks consume.

## What to put in `lifecycle.before_up` / `after_up` for the bake

The lifecycle hooks run during cold-boot, INSIDE the VM. Their output is what gets baked into the golden. Whatever should be ready when a warm-fork starts has to be put here:

```yaml
profiles:
  dev:
    services: [postgres]
    owned: [api, web]
    lifecycle:
      before_up:
        # Installs into /workspace/node_modules; baked.
        - bun install --frozen-lockfile
        # Installs supabase CLI into /usr/local/bin; baked.
        - curl -fsSL https://supabase.com/install.sh | bash
        # Starts supabase's containers; their state is baked.
        - supabase start
      after_up:
        # Migrations applied to postgres; baked.
        - psql "$DATABASE_URL" -f db/migrations/01_init.sql
        - psql "$DATABASE_URL" -f db/seed-heavy.sql

runtime:
  sandbox:
    backend: tart
    image: lich-sandbox-base
    warm_fork: true
    bake_inputs:
      - "lich.yaml"
      - "bun.lock"
      - "supabase/config.toml"
      - "db/migrations/**"
      - "db/seed-heavy.sql"
```

These hooks are SKIPPED on warm-fork (`runtime.ts` passes `skipBaked: true` when forking from a golden). So they run once per bake, not once per `lich up`.

If a hook is per-worktree (e.g., generating a random per-worktree subdomain), don't put it in `before_up` — it'll run inside the bake and be frozen. Move it to a service `lifecycle.before_start` or post-up step that runs after the warm-fork.

## Field reference

| Field | Required | Notes |
|---|---|---|
| `backend` | yes | Only `tart` is supported in v0. |
| `image` | no | Local Tart image name to clone from. Defaults to `lich-sandbox-base`. |
| `memory` | no | VM RAM in MB. Default 4096. Bump if the stack OOMs during bake. |
| `cpus` | no | VM CPUs. Default 4. |
| `warm_fork` | no | Default `true`. Set `false` to always cold-boot (useful when debugging the bake). |
| `snapshot_store` | no | Where goldens live on host. Default `<LICH_HOME>/sandboxes`. |
| `sync.ignore` | no | Extra mutagen sync ignore globs. `node_modules`, `.git`, `dist`, `.next` are always ignored — the user's must NOT round-trip from host. |
| `sync.mutagen_flags` | no | Pass-through flags to `mutagen sync create`. |
| `bake_inputs` | **yes** | At least one entry. Globs relative to worktree. Their hashed content decides golden identity. |
| `gc.keep_per_profile` | no | How many goldens to retain per profile. Default 3. |
| `gc.max_total_gb` | no | Total disk cap. Triggers LRU eviction when exceeded. |

## CLI surface

```bash
lich sandbox status      # list goldens + run VMs + their disk usage
lich sandbox snapshot    # explicit bake (mostly automatic via bake-on-down)
lich sandbox purge       # destroy all goldens and run VMs for this stack
lich sandbox refresh     # rebuild the golden for the current bake_inputs
lich sandbox gc          # apply gc policy now (also runs after every bake)
```

The user should rarely need these — auto-bake on `lich down` and auto-fork on `lich up` handle the common path. `status` is the diagnostic; `purge` is the panic button when state goes bad.

## Common gotchas to warn about during instrumentation

- **First `lich up` is slow.** The cold boot includes the bake, which is the whole point of the feature. Tell the user explicitly: "First up will take ~your-cold-boot-time; subsequent ups will be ~14s." Otherwise they'll panic.
- **`node_modules` lives in the VM, not the host.** Mutagen syncs source IN; `node_modules` is in the sync ignore list. If the user runs `bun run foo` from the host expecting node_modules to exist there, it won't. They should `lich exec -- bun run foo` to run inside the VM, or live with split node_modules (one on host for editor LSPs, one baked into the VM for runtime).
- **Hot reload still works inside the VM.** The dev server (next, vite, etc.) is in the VM; mutagen pipes file events through fast enough that hot-reload feels native.
- **`bake_inputs` matches must be exact.** A change in `lich.yaml` whitespace invalidates the golden. So does swapping the order of `bake_inputs` items. Treat the field like a cache key — stable across teammates if possible.
- **macOS only.** If the user is on Linux/Windows, the sandbox block is a hard validation error. They get the regular host-mode lich, which is still fully featured — just without the warm-fork win.
- **Disk usage adds up.** Each golden is ~5-20GB. Set `runtime.sandbox.gc.max_total_gb` (default unlimited) to cap before it eats the disk.

## Decision script during Pass 2 of the survey

If you see signals of heavy cold-boot work:

- `package.json` with > 100 deps and no install caching
- `supabase/config.toml` or `supabase start` in scripts
- `prisma`/`drizzle`/`goose` migrations directory with many files
- A `seed.sql` over a few thousand lines
- A `before_up` script that the user mentions takes "a couple minutes"

… ask:

> "Your stack's cold boot is going to be expensive (the [reason]). On macOS, lich supports a `runtime.sandbox` block that bakes the whole thing into a snapshot once and forks it for every subsequent `lich up` — typical cold drops from 1-3 min to ~14s. Worth wiring in? It does mean services run inside a Linux microVM instead of on the host."

If yes: propose the `runtime.sandbox` block with the matching `bake_inputs` set. If they're on Linux/Windows, don't offer it.
