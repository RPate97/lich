> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../superpowers/specs/2026-05-23-lich-v1-design.md` (product spec), `../superpowers/specs/2026-05-23-lich-v1-testing-standards.md` (testing standards), and `../superpowers/plans/2026-05-23-lich-v1-plan-0-foundation.md` (current plan). See `./README.md` in this directory for context.

---

# Build Strategy for `@lich/*` Packages

## Decision

**Use `tsup` to bundle every published `@lich/*` package.** Each package
emits dual ESM + CJS entry points plus `.d.ts` declaration files, sourcemaps
included. This applies first to `@lich/core` as the template, then to
every plugin package.

This decision rejects shipping raw `.ts` sources (option 2) and rejects plain
`tsc` output (option 3).

## Rationale

The target audience is "Node 20+, Bun-friendly," but realistically most
consumers install via `npm`/`pnpm` into a Node project that may or may not
have ESM configured and definitely does not want to wire up a TS loader. A
published package has one job: work the instant it is `require`'d or
`import`ed. `tsup` delivers that with the least ceremony.

`tsup` also matches the ecosystem default for TS libraries (Hono, tRPC,
Drizzle), so contributors recognize the config. Esbuild keeps build times
sub-second across all ~10 plugin packages.

## Trade-offs considered

- **Option 2 — ship `.ts` + `.d.ts` only.** Lightest publish flow, but forces
  consumers to register a loader (`tsx`, `bun`, `ts-node/esm`). That excludes
  plain Node 20 users and breaks the "drop-in library" contract. Fine for
  internal-only packages, not for public publish.
- **Option 3 — unbundled `tsc`.** Zero new tooling, but a noisy file tree,
  no CJS interop without dual `tsconfig` files, and slower incremental builds
  across 10+ packages. The "simplicity" is illusory once dual-format is
  required.
- **Option 1 — `tsup`.** One dev dependency plus a ~10-line config per
  package, in exchange for dual format, declaration bundling, treeshake,
  sourcemaps, and watch mode. Net win.

## Next steps for implementation

1. Add `tsup` to the root dev-dependency set in the workspace.
2. Create a shared `tsup.config.base.ts` in the repo root that exports
   `{ entry: ['src/index.ts'], format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true, target: 'node20' }`.
3. Wire `@lich/core` first: add `build: tsup` script, set
   `"main"`, `"module"`, `"types"`, and `"exports"` fields, and verify the
   published tarball with `npm pack --dry-run`.
4. Add a `turbo` / workspace `build` task so all packages build in parallel
   on release.
5. Roll the same template to each plugin package as it lands.
6. Open a follow-up ticket to add a CI smoke test that imports each built
   package from both an ESM and a CJS fixture.
