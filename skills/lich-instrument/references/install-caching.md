# pnpm install preflight (skip cold-cache reinstalls)

**When to use this:** every `lich up` spends 30-60 seconds running `pnpm install` even though the lockfile hasn't changed. A `before_up` hook that always runs `pnpm install` is the obvious first attempt; the problem is it always runs.

The fix is to check whether `node_modules` is stale relative to the lockfile and only reinstall if so. The pattern compares `pnpm-lock.yaml`'s mtime to `node_modules/.modules.yaml`'s mtime (pnpm writes the latter on every install), plus a sanity check that `node_modules/.pnpm` exists at all.

```yaml
lifecycle:
  before_up:
    - cmd: |
        set -euo pipefail
        if [ ! -d node_modules/.pnpm ] \
           || [ ! -f node_modules/.modules.yaml ] \
           || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
          echo "[preinstall] lockfile changed or node_modules missing — installing"
          pnpm install --frozen-lockfile
        else
          echo "[preinstall] node_modules up to date — skipping install"
        fi
```

Equivalent shapes for the other package managers:

- **yarn (berry):** check `pnpm-lock.yaml` → `yarn.lock`; check `node_modules/.modules.yaml` → `.yarn/install-state.gz`.
- **npm:** check `pnpm-lock.yaml` → `package-lock.json`; check `node_modules/.modules.yaml` → `node_modules/.package-lock.json`.

This pattern may eventually become a built-in (something like `runtime.preinstall: pnpm`) — until then, the manual `before_up` hook is the recipe.

**Common mistake:** running `pnpm install` unconditionally on every `lich up`. It wastes 30-60s per startup and slows down agent-driven workflows where `lich up`/`lich down` happen frequently.
