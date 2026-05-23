> **⚠ ARCHIVED v0 work — do NOT use for v1 implementation.**
> See `../superpowers/specs/2026-05-23-lich-v1-design.md` (product spec), `../superpowers/specs/2026-05-23-lich-v1-testing-standards.md` (testing standards), and `../superpowers/plans/2026-05-23-lich-v1-plan-0-foundation.md` (current plan). See `./README.md` in this directory for context.

---

# Plugin Extraction Lessons

A short field guide for moving a built-in adapter (or set of commands) out of `packages/core` and into a stand-alone `@lich/plugin-*` package. Distilled from the LEV-145 pilot that extracted `@lich/plugin-portless`, written ahead of Tier 5 (nine more plugin migrations).

For the author-facing reference, see [plugin-author-guide.md](./plugin-author-guide.md) and [EXTENSION.md](./EXTENSION.md). This document is internal: it covers the mechanics of *moving existing code out*, not greenfield plugin authoring.

## The 6-step playbook

1. **Scope the slot.** Pick the smallest coherent surface: one adapter slot (`portless`) or one command family. Note every file under `packages/core/src/**` that imports from that slot, and every test that touches it — those are the call sites you will rewrite.
2. **Create the package skeleton.** `packages/plugin-<name>/` with `package.json` (`peerDependencies: { "@lich/core": "workspace:*" }`, `main: "./src/index.ts"`), `tsconfig.json` extending `tsconfig.base.json`, and `vitest.config.ts` extending `vitest.shared.ts`. Mirror `packages/plugin-portless/` exactly — that's the canonical layout.
3. **Move the implementation files verbatim.** `git mv` the adapter impls and their tests into `packages/plugin-<name>/src/` and `packages/plugin-<name>/tests/`. Don't refactor in the same commit — keep the diff a pure move so reviewers can verify nothing changed.
4. **Write the `Plugin` export.** `src/index.ts` exports a default `Plugin` whose `register(api)` calls `api.addAdapter(slot, name, impl)` for each impl and `api.setActiveAdapter(slot, name)` for whichever should be active by default. Re-export the impls and types so downstream packages can still import them directly during the transition.
5. **Update core.** Remove the slot's impls from `getBuiltinAdapters()` in `packages/core/src/adapters/registry.ts` (keep the `AdapterSlot` union entry — that type is part of the published API). Rewrite every core import to point at the new package (`@lich/plugin-<name>`). Run `bun install` so the workspace symlink shows up.
6. **Smoke test end-to-end.** In a fresh tmpdir create `lich.config.ts` with `plugins: ['@lich/plugin-<name>']` and run `bun packages/core/src/bin.ts adapter list` — the plugin's adapters must appear, and at least one command that depends on the slot (for portless: `urls`) must succeed.

## Surprises from the pilot

- **The core barrel `packages/core/src/index.ts` is load-bearing.** Plugins import `Plugin`, `PluginAPI`, `AdapterSlot`, `LichConfig` etc. from `@lich/core` — not from deep paths. Before LEV-145 we had no barrel; the first thing the pilot had to add was a types-only `index.ts` re-exporting the contract. Keep it types-only by default; every value you export becomes part of the published API.
- **`bin.ts` has to merge two adapter registries, not one.** The built-ins live in `getBuiltinAdapters()`; plugin contributions live in the registry returned by `bootPlugins()`. The dispatch path in `buildDispatchRegistry` calls `mergeAdapterRegistries(builtins, pluginAdapters)` and re-binds `adapter list` to the merged view — otherwise `adapter list` shows only built-ins and the extracted slot looks empty. Any new extraction inherits this for free, but be aware that the merge re-applies the overlay's active selection last (last-write-wins on `(slot, name)` and on the active impl per slot).
- **Command call sites still import from the plugin path.** `commands/dev.ts` was rewritten to import `portlessAdapter` from `@lich/plugin-portless` directly. That's intentional during the transition — core commands haven't been extracted yet — but it means core has a runtime dependency on the plugin package. Tier 5 should keep this pattern (direct import from the plugin) until the consuming commands themselves move out.
- **`bun install` is mandatory after adding a package.** The workspace symlink under `node_modules/@lich/` only appears after install. The smoke test failed the first time we ran it precisely because of this; if your worktree's `node_modules` is stale, the plugin won't resolve.

## Tier 5 gotchas

The pilot moved two small files with no command surface. The nine Tier 5 plugins are larger and bring two new wrinkles:

- **Plugins that contribute commands.** Use `api.addCommand(cmd)` inside `register`. The command's factory needs whatever registry/services it currently closes over in `bin.ts` — pass them through `PluginContext` rather than reaching back into core. Add a `commands` section to the smoke test (invoke the contributed command in the tmpdir and assert exit 0).
- **Plugins with multiple adapter impls across slots.** A single `register()` can call `addAdapter` for several slots; that's fine, but pick the default `setActiveAdapter` per slot carefully — extracted plugins should preserve whatever the pre-extraction default was so existing consumers don't observe a behavior change.
- **Shared helpers.** Anything currently imported by both the extracted code and remaining core code (e.g. a logger, a path helper) must either stay in core and be exported from the barrel, or move into a third internal package. Do not duplicate it into the plugin — that's how drift starts.

## Troubleshooting

### Stale or broken `@lich/*` resolutions in an agent worktree

Symptoms (any of):

- `tsc` reports "module not found" for `@lich/*` workspace packages.
- An agent imports a plugin and gets behaviour from a *prior* agent's worktree (the symlink under `node_modules/@lich/<pkg>` was a relative path into a sibling worktree that has since been removed or rewritten).
- `bun install` complains about missing packages in a freshly-created worktree.

Quick recovery (run from inside the worktree):

```bash
# Drop the stale workspace links and let bun rebuild them in place.
rm -rf node_modules/@lich && bun install
```

If the workspace root symlink itself is bad (`ls -la node_modules` shows a broken arrow), do a full reset:

```bash
rm node_modules packages/*/node_modules 2>/dev/null
bun install
```

### Pre-flight check

To assert symlink health before doing real work — useful as the first step in a long task or after any worktree mutation — run:

```bash
bash .claude/hooks/worktree-verify.sh        # checks the current worktree
bash .claude/hooks/worktree-verify.sh <dir>  # checks a specific worktree
```

Exit 0 with `OK` means every shared-node_modules link is either absent, a real install, or a valid symlink into the project root. Exit 1 prints a one-line diagnosis (`MISSING`, `BROKEN`, or `STALE`) suitable for `tail -1` consumption.

The `WorktreeCreate` hook (`.claude/hooks/worktree.sh`) verifies each symlink at creation time and falls back to a real `bun install` if any link is unhealthy, so a freshly-created worktree should always start `OK`. The verifier is for catching drift that happens *after* creation — e.g. when a sibling worktree is removed and the link target disappears.

### Docker address-pool exhaustion (`all predefined address pools have been fully subnetted`) (LEV-120)

Symptoms:

- `docker compose up` (or any `dev` invocation) fails with `Error response from daemon: all predefined address pools have been fully subnetted`.
- `docker network ls | grep lich | wc -l` reports more than ~20 networks.
- `lich doctor` shows `[WARN] lich-networks — N lich-* networks detected (>20)`.

Cause: every `lich up` creates a fresh bridge network (`lich-<key>`), which carves a `/24` (or similar) out of Docker's default address pool. The default pool is small — typically ~30 subnets — so a fleet of parallel agent worktrees can exhaust it. When an agent's run crashes without tearing the stack down (e.g. SIGKILL during `lich up`), the network is left behind and continues to occupy a subnet.

Recovery, in increasing order of force:

```bash
# Prefer: reap stale lich-* containers and networks system-wide. Safe to
# run any time — only touches resources whose name starts with `lich-`.
lich stacks prune --all

# Same, plus reap named volumes (destructive — wipes local DB state held by
# `lich-<key>-<service>-data` volumes).
lich stacks prune --all --volumes

# Last resort: ask docker itself to reap every unused network. Affects
# non-lich networks too, so only use this if the targeted prune above
# didn't free enough subnets.
docker network prune -f
```

Prevention:

- Add `lich stacks prune --all` as the first step of a flaky integration test's setup, OR have its `afterAll` call `docker compose -p lich-<key> down --volumes --remove-orphans` so the network is released even if the test crashes mid-run.
- Watch the `lich-networks` doctor check during long agent sessions. The 20-network warn threshold gives a few stacks of headroom before the daemon actually refuses to allocate.
- If you regularly run >20 parallel stacks, expand Docker's address pool at the daemon level. Out of scope here — see Docker's docs on `default-address-pools` in `/etc/docker/daemon.json` for the host-level fix.
