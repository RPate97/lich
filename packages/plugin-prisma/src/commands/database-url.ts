import { CLIError } from '@lich/core/errors';
import type { EnvSourceRegistry } from '@lich/core/env/registry';

/**
 * Inputs for {@link resolveDatabaseUrl}. Pulled from the current stack's
 * registry entry by every `db.*` command, then passed through verbatim to
 * the EnvSource resolver. `consumerContext` is forced to `'host'` inside the
 * helper — db.* commands always run on the host (not in a container), so
 * callers don't get a knob.
 */
export interface ResolveDatabaseUrlInput {
  /**
   * Boot-scoped registry populated by `bootPlugins`. May be `undefined` when a
   * caller constructs the command outside the dispatch wiring (e.g. test that
   * forgot to inject one); the helper throws a structured `NO_ENV_REGISTRY`
   * in that case so the failure surface stays predictable.
   */
  envSourceRegistry: EnvSourceRegistry | undefined;
  /** Stack-allocated `portName -> hostPort` (from the runtime registry entry). */
  ports: Record<string, number>;
  /** Absolute project root — passed through to the source resolver. */
  projectRoot: string;
  /** Stable short identifier of the active worktree. */
  worktreeKey: string;
}

/**
 * Resolve `DATABASE_URL` via the EnvSource registry rather than by reaching
 * into any specific DB plugin's package. The `db.*` commands all run on the
 * host, so we always invoke the source's `host()` resolver with
 * `consumerContext: 'host'`.
 *
 * Lookup strategy (Approach A from LEV-171): scan named sources for one whose
 * declared `protocol` is `'postgres'` AND whose unqualified `name` is `'url'`.
 * That pair uniquely identifies "the connection string a postgres-shaped DB
 * plugin published" without coupling the consumer to a specific namespace.
 * A plugin that registers `postgres.url` qualifies; so does a hypothetical
 * `pg-cloud.url` published by an alternative postgres plugin.
 *
 * Failure modes are structured CLIErrors so the CLI driver returns a stable
 * exit code:
 *
 *   - `NO_ENV_REGISTRY` — the registry handle wasn't plumbed in. Only seen in
 *     test/dev paths that bypass `buildDispatchRegistry`; production always
 *     wires it.
 *   - `NO_DATABASE` — no plugin published a `*.url` postgres source. Tells
 *     the user to add a postgres-protocol DB plugin to their config.
 */
export async function resolveDatabaseUrl(input: ResolveDatabaseUrlInput): Promise<string> {
  const { envSourceRegistry, ports, projectRoot, worktreeKey } = input;

  if (!envSourceRegistry) {
    throw new CLIError(
      'INTERNAL',
      'EnvSource registry not available',
      'this command requires the dispatch-wired CommandContext (post-bootPlugins). Check that the plugin-prisma factory received `getEnvSourceRegistry` from the boot pipeline.',
    );
  }

  const urlSrc = envSourceRegistry.findFirstNamed(
    (entry) => entry.source.protocol === 'postgres' && entry.name === 'url',
  );
  if (!urlSrc) {
    throw new CLIError(
      'NO_PROJECT',
      'no postgres EnvSource active',
      'add a postgres-protocol DB plugin to your `lich.config.ts` plugins list so a `<ns>.url` source with `protocol: "postgres"` is registered.',
    );
  }

  return await urlSrc.source.host({
    ports,
    projectRoot,
    worktreeKey,
    consumerContext: 'host',
  });
}
