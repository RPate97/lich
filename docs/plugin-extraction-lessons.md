# Plugin Extraction Lessons

A short field guide for moving a built-in adapter (or set of commands) out of `packages/core` and into a stand-alone `@levelzero/plugin-*` package. Distilled from the LEV-145 pilot that extracted `@levelzero/plugin-portless`, written ahead of Tier 5 (nine more plugin migrations).

For the author-facing reference, see [plugin-author-guide.md](./plugin-author-guide.md) and [EXTENSION.md](./EXTENSION.md). This document is internal: it covers the mechanics of *moving existing code out*, not greenfield plugin authoring.

## The 6-step playbook

1. **Scope the slot.** Pick the smallest coherent surface: one adapter slot (`portless`) or one command family. Note every file under `packages/core/src/**` that imports from that slot, and every test that touches it — those are the call sites you will rewrite.
2. **Create the package skeleton.** `packages/plugin-<name>/` with `package.json` (`peerDependencies: { "@levelzero/core": "workspace:*" }`, `main: "./src/index.ts"`), `tsconfig.json` extending `tsconfig.base.json`, and `vitest.config.ts` extending `vitest.shared.ts`. Mirror `packages/plugin-portless/` exactly — that's the canonical layout.
3. **Move the implementation files verbatim.** `git mv` the adapter impls and their tests into `packages/plugin-<name>/src/` and `packages/plugin-<name>/tests/`. Don't refactor in the same commit — keep the diff a pure move so reviewers can verify nothing changed.
4. **Write the `Plugin` export.** `src/index.ts` exports a default `Plugin` whose `register(api)` calls `api.addAdapter(slot, name, impl)` for each impl and `api.setActiveAdapter(slot, name)` for whichever should be active by default. Re-export the impls and types so downstream packages can still import them directly during the transition.
5. **Update core.** Remove the slot's impls from `getBuiltinAdapters()` in `packages/core/src/adapters/registry.ts` (keep the `AdapterSlot` union entry — that type is part of the published API). Rewrite every core import to point at the new package (`@levelzero/plugin-<name>`). Run `bun install` so the workspace symlink shows up.
6. **Smoke test end-to-end.** In a fresh tmpdir create `levelzero.config.ts` with `plugins: ['@levelzero/plugin-<name>']` and run `bun packages/core/src/bin.ts adapter list` — the plugin's adapters must appear, and at least one command that depends on the slot (for portless: `urls`) must succeed.

## Surprises from the pilot

- **The core barrel `packages/core/src/index.ts` is load-bearing.** Plugins import `Plugin`, `PluginAPI`, `AdapterSlot`, `LevelzeroConfig` etc. from `@levelzero/core` — not from deep paths. Before LEV-145 we had no barrel; the first thing the pilot had to add was a types-only `index.ts` re-exporting the contract. Keep it types-only by default; every value you export becomes part of the published API.
- **`bin.ts` has to merge two adapter registries, not one.** The built-ins live in `getBuiltinAdapters()`; plugin contributions live in the registry returned by `bootPlugins()`. The dispatch path in `buildDispatchRegistry` calls `mergeAdapterRegistries(builtins, pluginAdapters)` and re-binds `adapter list` to the merged view — otherwise `adapter list` shows only built-ins and the extracted slot looks empty. Any new extraction inherits this for free, but be aware that the merge re-applies the overlay's active selection last (last-write-wins on `(slot, name)` and on the active impl per slot).
- **Command call sites still import from the plugin path.** `commands/dev.ts` was rewritten to import `portlessAdapter` from `@levelzero/plugin-portless` directly. That's intentional during the transition — core commands haven't been extracted yet — but it means core has a runtime dependency on the plugin package. Tier 5 should keep this pattern (direct import from the plugin) until the consuming commands themselves move out.
- **`bun install` is mandatory after adding a package.** The workspace symlink under `node_modules/@levelzero/` only appears after install. The smoke test failed the first time we ran it precisely because of this; if your worktree's `node_modules` is stale, the plugin won't resolve.

## Tier 5 gotchas

The pilot moved two small files with no command surface. The nine Tier 5 plugins are larger and bring two new wrinkles:

- **Plugins that contribute commands.** Use `api.addCommand(cmd)` inside `register`. The command's factory needs whatever registry/services it currently closes over in `bin.ts` — pass them through `PluginContext` rather than reaching back into core. Add a `commands` section to the smoke test (invoke the contributed command in the tmpdir and assert exit 0).
- **Plugins with multiple adapter impls across slots.** A single `register()` can call `addAdapter` for several slots; that's fine, but pick the default `setActiveAdapter` per slot carefully — extracted plugins should preserve whatever the pre-extraction default was so existing consumers don't observe a behavior change.
- **Shared helpers.** Anything currently imported by both the extracted code and remaining core code (e.g. a logger, a path helper) must either stay in core and be exported from the barrel, or move into a third internal package. Do not duplicate it into the plugin — that's how drift starts.
