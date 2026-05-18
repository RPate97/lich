import { CLIError } from '../../errors';
import { EnvSourceRegistry } from '../../env/registry';
import {
  resolveEnvForService,
  type BulkResolutionCache,
  type EnvInjectionMap,
} from '../../env/resolve';
import type { Command } from '../types';

/**
 * Inputs that the inline factory wires up. Default implementations stay
 * deliberately degenerate so the command is callable from the inline
 * dispatch path (where no project / no plugins are loaded). Real dispatch
 * passes the registry + envInjection + resolved-bulk cache that
 * `bootPlugins` produced, plus per-stack `ports` from the runtime registry
 * if a stack is already up.
 */
export interface EnvResolveOptions {
  /** Populated EnvSource registry from `bootPlugins`. Defaults to empty. */
  getEnvSourceRegistry?: () => EnvSourceRegistry;
  /** `levelzero.config.ts`'s `envInjection` block. Defaults to `undefined`. */
  getEnvInjection?: () => EnvInjectionMap | undefined;
  /**
   * Resolves the per-service input that depends on stack state — ports +
   * worktreeKey + projectRoot. Tests inject a fixed value; the default
   * (used by the inline path) returns empty stack state so the command
   * still runs without a project (it'll fail naturally for any source
   * that depends on ports).
   */
  getStackInput?: (
    cwd: string,
  ) => Promise<{ ports: Record<string, number>; projectRoot: string; worktreeKey: string }>;
  /** Optional shared bulk cache from `bootPlugins`. Defaults to a fresh map. */
  getBulkCache?: () => BulkResolutionCache;
}

export interface EnvResolveResult {
  service: string;
  context: 'host' | 'container';
  env: Record<string, string>;
}

/**
 * Build `levelzero env resolve <service>`. Computes exactly the env map the
 * runtime would inject into `<service>` if `dev` were running now, against
 * the merged registry + the consumer's `envInjection` block.
 *
 * Context auto-detects to `container` (the common case — every plugin
 * compose service runs there); pass `--context host` to override for
 * host-spawned owned services like `web` (Next dev). `--json` switches the
 * output from `KEY=value` lines to a structured {@link EnvResolveResult}.
 */
export function makeEnvResolveCommand(opts?: EnvResolveOptions): Command {
  const getRegistry = opts?.getEnvSourceRegistry ?? (() => new EnvSourceRegistry());
  const getInjection = opts?.getEnvInjection ?? (() => undefined);
  const getStackInput =
    opts?.getStackInput ??
    (async (cwd: string) => ({ ports: {}, projectRoot: cwd, worktreeKey: 'unknown' }));
  const getBulkCache = opts?.getBulkCache;

  return {
    name: 'env.resolve',
    describe:
      'Resolve every env var that would be injected into <service> using the current config',
    async run(ctx) {
      const [service, ...rest] = ctx.args;
      if (!service) {
        throw new CLIError(
          'INTERNAL',
          'missing required argument: service',
          'usage: levelzero env resolve <service> [--context host|container] [--json]',
        );
      }
      if (rest.length > 0) {
        throw new CLIError(
          'INTERNAL',
          `unexpected extra arguments: ${rest.join(' ')}`,
          'usage: levelzero env resolve <service> [--context host|container] [--json]',
        );
      }

      const context = pickContext(ctx.flags['context']);

      const stack = await getStackInput(ctx.cwd);
      const registry = getRegistry();
      const injection = getInjection();

      const env = await resolveEnvForService({
        serviceName: service,
        context,
        registry,
        injection,
        ports: stack.ports,
        projectRoot: stack.projectRoot,
        worktreeKey: stack.worktreeKey,
        bulkCache: getBulkCache?.(),
      });

      // LEV-168 — pretty is now the default; `--json` opts back into the
      // structured shape (mirrors `env list`).
      if (ctx.format === 'json') {
        return { service, context, env } satisfies EnvResolveResult;
      }
      return renderPretty(service, context, env);
    },
  };
}

/**
 * Normalize the `--context` flag value. Defaults to `container` (matches the
 * runtime default for plugin-managed services). Any value that isn't exactly
 * `host` or `container` is a hard error so a typo doesn't silently fall
 * through to the default behavior.
 */
function pickContext(raw: unknown): 'host' | 'container' {
  if (raw === undefined || raw === true || raw === false) return 'container';
  if (raw === 'host' || raw === 'container') return raw;
  throw new CLIError(
    'INTERNAL',
    `invalid --context value: ${String(raw)}`,
    'use --context host or --context container',
  );
}

/**
 * Render the resolved env as a header comment plus `KEY=value` lines, sorted
 * alphabetically by key so successive `env resolve` runs produce stable diffs.
 */
function renderPretty(
  service: string,
  context: 'host' | 'container',
  env: Record<string, string>,
): string {
  const keys = Object.keys(env).sort();
  const lines: string[] = [`# resolved env for service "${service}" (context: ${context})`];
  if (keys.length === 0) {
    lines.push('# (no env vars injected — empty envInjection or no matching sources)');
  } else {
    for (const k of keys) lines.push(`${k}=${env[k]}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Standalone export for the inline-only dispatch path (no project loaded).
 * It backs an empty registry + `undefined` envInjection — invoking it will
 * always produce an empty result. Real dispatch rebinds via
 * `makeEnvResolveCommand` inside `buildDispatchRegistry`.
 */
export const envResolveCommand: Command = makeEnvResolveCommand();
