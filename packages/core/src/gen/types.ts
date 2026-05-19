/**
 * Generator contract (LEV-124).
 *
 * Plugins contribute one or more `Generator`s via `api.addGenerator(...)` so
 * the unified `levelzero gen` command can drive every codegen task through a
 * single dispatch path. Each generator owns its own resolution chain — the
 * registry just hands it the boot-scoped {@link GeneratorContext} and calls
 * `generate()`.
 *
 * Built-in generators that ship with first-party plugins today:
 *   - `api-client` (from `@levelzero/plugin-typed-client`) — extracts a
 *     `RouteManifest` from the active backend adapter and writes a typed
 *     fetch client to disk.
 *   - `prisma` (from `@levelzero/plugin-prisma`) — runs `prisma generate`
 *     against the project's `prisma/schema.prisma`. Skips when no schema is
 *     present.
 *
 * The shape is intentionally small. `generate()` returns a structured
 * {@link GeneratorResult} so the dispatcher can produce a uniform per-id
 * status table (`[OK] prisma`, `[SKIP] prisma (no schema)`, etc.) without
 * any per-generator special-casing.
 */
import type { AdapterRegistry } from '../adapters/registry';
import type { EnvSourceRegistry } from '../env/registry';

/**
 * Read-only context handed to every generator's `generate()` call. The
 * registries are shared with the rest of the dispatch wiring — generators
 * can resolve adapters / env sources the same way commands do, without
 * importing sibling plugin packages directly.
 *
 * `flags` carries through any unknown CLI flags from the `gen` invocation so
 * generators can opt into per-id options (e.g. `--api-dir`, `--out`) without
 * the dispatcher knowing about them ahead of time. The shape mirrors
 * `CommandContext.flags`.
 */
export interface GeneratorContext {
  /** Absolute path to the current worktree root. */
  projectRoot: string;
  /**
   * Boot-scoped {@link EnvSourceRegistry}. Generators that need a connection
   * string (e.g. prisma's `DATABASE_URL`) resolve it here rather than reaching
   * into a sibling plugin — same composability rule the command surface
   * follows.
   */
  envSources: EnvSourceRegistry;
  /**
   * Boot-scoped {@link AdapterRegistry}. Generators that consume an adapter
   * slot (e.g. `api-client` needs the active `backend` adapter's
   * `extractRoutes`) resolve it here.
   */
  adapters: AdapterRegistry;
  /**
   * Raw CLI flags from the `gen` invocation, passed through verbatim. The
   * dispatcher reserves `--only`, `--list`, and `--json` for its own use; any
   * other flag flows here for the generator to interpret. Forward-compatible
   * with per-id options that haven't been spec'd yet.
   */
  flags: Record<string, string | boolean>;
}

/**
 * One generator's outcome. The dispatcher renders these uniformly:
 *
 *   - `ok`   — `[OK] <id> [(N files)]` (or `[OK] <id>: <message>` if set)
 *   - `skip` — `[SKIP] <id>: <message>` (message is required in practice;
 *              gens that skip without a reason produce a confusing UI)
 *   - `fail` — `[FAIL] <id>: <message>` (the dispatcher's exit code is non-zero
 *              when any generator returns `fail`, or throws)
 *
 * `filesWritten` is the canonical list of paths produced. The api-client
 * generator surfaces this so the JSON shape stays useful for tooling that
 * needs to chain the output (e.g. linting only generated files). For `prisma`
 * (which writes into `node_modules/.prisma/client/`) the field is omitted.
 */
export interface GeneratorResult {
  status: 'ok' | 'skip' | 'fail';
  /**
   * Optional human-readable reason. Surfaced in pretty mode after the status
   * tag (`[SKIP] prisma: no prisma/schema.prisma found`) and in JSON under
   * the same key.
   */
  message?: string;
  /**
   * Absolute paths of files this generator wrote. Optional — generators that
   * write into opaque caches (prisma's `node_modules/.prisma/client/`) leave
   * it out.
   */
  filesWritten?: string[];
}

/**
 * A single registered generator. Plugins build these inside `register()` and
 * pass to `api.addGenerator({...})`.
 *
 * `id` is the user-facing handle — what shows up in `levelzero gen --list`
 * and what the user passes to `--only`. Keep it short and kebab-cased
 * (`api-client`, `prisma`, `openapi`). Re-registering an existing id replaces
 * the prior entry, matching adapter/command registry semantics.
 *
 * `describe` is a one-line summary surfaced by `--list` and (eventually) the
 * help renderer.
 *
 * `generate()` may be sync or async — the dispatcher awaits the returned
 * value either way. It must NEVER throw for "expected" no-op conditions
 * (missing schema, no routes to generate from); use `status: 'skip'` with a
 * clear `message` instead. Throwing is reserved for unexpected failures
 * (filesystem errors, child-process crashes, etc.), which the dispatcher
 * surfaces as `[FAIL] <id>: <message>` while keeping siblings running.
 */
export interface Generator {
  id: string;
  describe: string;
  generate(ctx: GeneratorContext): Promise<GeneratorResult>;
}
