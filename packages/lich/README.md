# lich

A worktree-scoped dev stack orchestrator. See the v1 design spec at
`docs/superpowers/specs/2026-05-23-lich-v1-design.md`.

## Status

Pre-alpha. Plan 0 (foundation + failing test case) complete; Plans 1-6
add functionality tier by tier.

## Development

```bash
# Install deps
bun install

# Run the CLI from source
bun run dev --version

# Build the binary
bun run build
./dist/lich --version

# Run unit tests
bun test
```

## End-to-end tests

E2e tests live at `../../tests/e2e/`. They build the binary, copy
`examples/dogfood-stack/` to a tmpdir, and exercise `lich` against it.

```bash
cd ../../tests/e2e && bun test
```

At end of Plan 0, every e2e test fails (lich is a stub). Each
subsequent plan turns tests green.

## Contributing

See [`CLEANUP-HINTS.md`](./CLEANUP-HINTS.md) for small refactor
opportunities that aren't worth their own ticket but should get picked
up the next time someone is already in the neighborhood.
