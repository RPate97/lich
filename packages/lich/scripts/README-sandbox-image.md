# Sandbox VM Image

The `build-sandbox-image.sh` script bakes a Tart-compatible Ubuntu image
preloaded with: Docker + docker-compose, Bun, pnpm, postgresql-client,
and the lich binary itself (copied from `packages/lich/dist/lich`).

## Build

    cd packages/lich
    bun run build
    ./scripts/build-sandbox-image.sh

Takes ~5-10 min on first run (apt install dominates). Subsequent runs
inherit the base layer from Tart's local cache.

## Verify

    tart list           # should show lich-sandbox-base as stopped

## Use directly (debugging)

    tart clone lich-sandbox-base my-workspace
    tart run --no-graphics --detach my-workspace
    ssh admin@$(tart ip my-workspace)

## Use via lich (normal flow)

Add to your `lich.yaml`:

    runtime:
      sandbox:
        backend: tart
        image: lich-sandbox-base

Then `lich up` runs your stack inside a sandbox VM transparently.
