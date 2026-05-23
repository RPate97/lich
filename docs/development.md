# Development Guide

## Monorepo structure

This is a [Turborepo](https://turbo.build/) + [Bun](https://bun.sh/) workspace monorepo.
All workspace packages live under `packages/`.

```
packages/
  core/                 # @lich/core — CLI, runtime
  plugin-*/             # plugin packages
  create-stack-v0/      # scaffolding CLI
  template-v0-stack/    # project template
```

## Prerequisites

- **Bun** ≥ 1.2.23 (`curl -fsSL https://bun.sh/install | bash`)
- **Node.js** ≥ 20 (for tooling compatibility)

## Initial setup

```bash
bun install          # install all workspace dependencies
bun run build        # build all packages
```

## Common tasks

| Task | Command |
|------|---------|
| Build all packages | `bun run build` |
| Type-check all | `bun run typecheck` |
| Run all tests | `bun run test` |
| Run e2e tests | `bun run test:e2e` |
| Create a changeset | `bun run changeset` |
| Bump package versions | `bun run version-packages` |
| Publish packages | `bun run release` |

---

## Parallel agent development and stale workspace symlinks (LEV-220)

> **TL;DR:** If `bun run lich` runs old code after a merge, run
> `bun run sync-workspace-symlinks` to fix it.

### What happens

The Claude Code agent harness runs multiple agents in parallel, each in a
temporary git worktree under `/tmp/lich-worktrees/agent-XXX/`.  To
avoid a full `bun install` per worktree, the setup hook creates a symlink:

```
/tmp/lich-worktrees/agent-XXX/node_modules
  -> /Users/<you>/programming/lich/node_modules   # main repo
```

When Bun installs packages inside that worktree (for any reason — installing
a new dependency, running the install fallback in the hook, etc.), it resolves
the workspace glob `"packages/*"` relative to the **worktree's** directory
and writes workspace symlinks like:

```
node_modules/@lich/core
  -> /tmp/lich-worktrees/agent-XXX/packages/core   # WORKTREE path
```

Because the worktree's `node_modules` IS the main repo's `node_modules`,
those symlinks land in the main repo and affect every consumer — including
your local terminal and every other agent.

After the worktree is merged and discarded the symlinks still point at the
now-stale (or deleted) worktree.  Running `bun run lich` then silently
executes whatever code was in that old worktree.

### How to reproduce

1. Observe stale symlinks: `ls -la node_modules/@lich/`
2. If any line shows a path containing `/tmp/lich-worktrees/agent-XXX/`,
   the symlinks are stale.

### How to fix immediately

```bash
bun run sync-workspace-symlinks
```

This re-anchors every `node_modules/@lich/*` symlink to the correct
path inside the main repo's `packages/` directory.  It is safe to run at
any time and is idempotent.

To check without modifying anything:

```bash
bun run check-workspace-symlinks   # exits 1 if any symlink is stale
```

### Automatic prevention

Two mechanisms prevent the problem from persisting:

1. **WorktreeCreate hook** (`/.claude/hooks/worktree.sh`): After setting up
   each new agent worktree, the hook calls `sync-workspace-symlinks` to
   repair any damage left by the previous agent.

2. **post-merge git hook** (`scripts/git-hooks/post-merge`): After every
   `git merge` in the main repo the hook checks for stale symlinks and
   repairs them automatically.  Install it once:

   ```bash
   bun run install-git-hooks
   ```

### Why option (c) — fixing Bun's resolution — is not feasible

Bun does not provide a flag or config to suppress workspace package linking
during `bun install`.  The workspace glob `"packages/*"` is what Bun uses to
locate `@lich/*` packages; removing it would break all cross-package
imports.  The root cause is an emergent interaction between:

- Bun's workspace symlink behaviour (always re-links on install)
- The shared `node_modules` symlink strategy (correct for speed)
- Multiple worktrees sharing the same logical `node_modules` directory

The scripts and hooks in this repo are the practical mitigation.
