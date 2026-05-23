# Archived v0 specs (do not use)

**These specs describe the v0 levelzero implementation. They are superseded and should not be referenced for v1 work.**

The current spec is at `../2026-05-23-lich-v1-design.md`.

## Why this is here

The v0 (`levelzero`) implementation was a multi-package plugin-based system with a TypeScript config, a scaffolder, and 14 adapter plugins. The v1 (`lich`) implementation reframes the same problem space around a single binary that reads a YAML config and uses shell-out for extension. The v1 design is intentionally different in shape from v0; mixing concepts between them will confuse implementation.

Files here are kept for git history and for occasional cross-reference, NOT as design guidance. If you're an agent working on v1, read only the v1 spec.

## What's archived

- `2026-05-16-levelzero-design.md` — the original v0 product design
- `2026-05-21-dashboard-design.md` — v0 dashboard design
- `2026-05-21-readme-design.md` — v0 README design
- `2026-05-22-dashboard-design-port.md` — v0 dashboard port work
