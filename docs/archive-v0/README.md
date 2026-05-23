# Archived v0 docs (do not use)

**These docs describe the v0 (`levelzero`) implementation — multi-package monorepo, plugin runtime, TypeScript config, Turborepo, Changesets, etc.**

**v1 (`lich`) is a fundamentally different shape: single binary, YAML config, no plugin runtime, no scaffolder. None of the guidance in these docs applies to v1.**

## For v1 work, read these instead:

- **Product spec:** `../superpowers/specs/2026-05-23-lich-v1-design.md`
- **Testing standards:** `../superpowers/specs/2026-05-23-lich-v1-testing-standards.md`
- **Current plan:** `../superpowers/plans/2026-05-23-lich-v1-plan-0-foundation.md`

## What's archived here

| File | What it covered (v0) |
|---|---|
| `EXTENSION.md` | Plugin authoring overview — v0 plugin system, gone in v1 |
| `build-strategy.md` | tsup bundling for `@lich/*` multi-package — single binary in v1 |
| `development.md` | Turborepo + Bun monorepo dev workflow — different in v1 |
| `plugin-author-guide.md` | How to write a v0 plugin — gone in v1 |
| `plugin-extraction-lessons.md` | Lessons from Plan 14 plugin extraction work — historical |
| `releases.md` | Changesets multi-package versioning — single binary in v1 |
| `testing.md` | v0 three-tier testing model — superseded by the v1 testing standards doc |

These are kept for git history and occasional cross-reference. They are NOT current guidance.
