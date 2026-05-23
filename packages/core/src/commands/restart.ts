/**
 * LEV-249 — `lich restart`: bounce OWNED (host-process) services for the
 * current worktree's stack and leave compose-managed containers (postgres,
 * redis, etc.) untouched.
 *
 * Semantics:
 *   1. Resolve the current worktree's stack from the registry.
 *   2. Signal any running owned services (SIGTERM → wait → SIGKILL). The
 *      shared {@link signalDetachedOwned} helper from `owned/teardown.ts`
 *      does this — it is idempotent when the pid dir is absent or empty.
 *   3. Do NOT call `docker compose down` — containers stay up.
 *   4. Re-spawn owned services via {@link runOwnedServicesDetached}, the same
 *      path `dev` uses for its default detached mode.
 *   5. Surface CLIError for any owned service that crashes on restart
 *      (mirrors `dev`'s failure-surfacing introduced in LEV-219).
 */
import { resolveStackContext } from '../services/context';
import { getBuiltinServices } from '../services/builtins';
import type { Registry } from '../registry';
import type { Command } from './types';
import type { OwnedService, Service } from '../services/types';
import type { EnvSourceRegistry } from '../env/registry';
import {
  resolveEnvForService,
  type BulkResolutionCache,
  type EnvInjectionMap,
} from '../env/resolve';
import { runOwnedServicesDetached, type DetachedRunnerHandle } from '../owned/runner';
import { signalDetachedOwned } from '../owned/teardown';
import { createProgressReporter, type ProgressReporter } from '../ui/progress';
import { CLIError } from '../errors';
import { join } from 'node:path';
import type { PluginComposeContributions } from '../compose/stack';

export interface RestartOptions {
  /** Service provider; defaults to getBuiltinServices. Tests can inject custom lists. */
  getServices?: () => Service[];
  /**
   * Plugin-contributed `OwnedService` entries (post-LEV-154). The dispatcher
   * fills this from `bootPlugins().ownedServices` so plugins like
   * `@levelzero/plugin-next` that call `api.addOwnedService` get their
   * services bounced alongside the built-ins. Defaults to empty when omitted.
   */
  getPluginOwnedServices?: () => OwnedService[];
  /**
   * Plugin-contributed compose services/volumes/networks — accepted for parity
   * with DevOptions even though `restart` does NOT touch compose. The option
   * is ignored at runtime; its presence keeps the dispatcher's `sharedOpts`
   * passthrough symmetric with dev/stop/reset.
   */
  getPluginCompose?: () => PluginComposeContributions;
  /**
   * Boot-collected EnvSource registry (Plan 16 / LEV-181). When provided,
   * `restart` runs the per-service resolver for every owned service, using
   * the `host` context (same as `dev`). Without this getter the resolver is
   * skipped and no Plan-16 env vars are injected.
   */
  getEnvSourceRegistry?: () => EnvSourceRegistry;
  /** See {@link DevOptions.getEnvInjection}. */
  getEnvInjection?: () => EnvInjectionMap | undefined;
  /** See {@link DevOptions.getResolvedBulkSources}. */
  getResolvedBulkSources?: () => BulkResolutionCache;
  /**
   * Override the per-service HTTP readiness probe deadline (LEV-194).
   * Defaults to 10s. Tests inject something small so they don't wait on
   * services that never bind.
   */
  readinessTimeoutMs?: number;
}

function ownedServicesOnly(list: Service[]): OwnedService[] {
  return list.filter((s): s is OwnedService => s.kind === 'owned');
}

function deriveBaseEnv(services: Service[], ports: Record<string, number>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of services) {
    if (typeof s.envContributions === 'function') {
      Object.assign(env, s.envContributions(ports));
    }
  }
  return env;
}

export function makeRestartCommand(
  getRegistry: () => Registry,
  opts?: RestartOptions,
): Command {
  const getServices = opts?.getServices ?? getBuiltinServices;
  const getPluginOwnedServices = opts?.getPluginOwnedServices;
  const getEnvSourceRegistry = opts?.getEnvSourceRegistry;
  const getEnvInjection = opts?.getEnvInjection;
  const getResolvedBulkSources = opts?.getResolvedBulkSources;
  const readinessTimeoutMs = opts?.readinessTimeoutMs;

  return {
    name: 'restart',
    describe:
      'Bounce the owned (host) services for the current worktree — leaves compose containers running',
    async run(ctx) {
      // LEV-217 — fall back to a silent reporter when the caller didn't wire
      // one in (tests construct `CommandContext` directly without one).
      const reporter: ProgressReporter =
        ctx.reporter ?? createProgressReporter({ mode: 'silent' });

      const stackCtx = await resolveStackContext(ctx.cwd);

      // Merge built-in + plugin-contributed owned services — same as `dev`.
      const allServices: Service[] = [
        ...getServices(),
        ...(getPluginOwnedServices?.() ?? []),
      ];
      const owned = ownedServicesOnly(allServices);

      const reg = getRegistry();
      const entry = await reg.get(stackCtx.worktreeKey);

      if (!entry) {
        throw new CLIError(
          'INTERNAL',
          `no stack running for ${stackCtx.worktreeKey} — run 'lich dev' first`,
        );
      }

      // ------------------------------------------------------------------
      // Phase 1: Stop running owned services (SIGTERM → wait → SIGKILL).
      // Compose containers are NOT touched.
      // ------------------------------------------------------------------
      const pidDir = join(
        stackCtx.worktreePath,
        '.levelzero',
        'state',
        stackCtx.worktreeKey,
        'pids',
      );

      const stopped = await reporter.group(
        'Stopping owned service(s)',
        async () => signalDetachedOwned(pidDir),
      );

      if (owned.length === 0) {
        // No owned services configured — return a summary and exit early.
        const result = {
          key: stackCtx.worktreeKey,
          stopped,
          started: {},
        };
        if (ctx.format === 'json') return result;
        return renderRestartPretty(stackCtx.worktreeKey, stopped, null);
      }

      // ------------------------------------------------------------------
      // Phase 2: Resolve per-owned-service env (same as dev).
      // ------------------------------------------------------------------
      const ports = entry.ports;
      const dockerEnv = deriveBaseEnv(allServices, ports);

      const envRegistry = getEnvSourceRegistry?.();
      const envInjection = getEnvInjection?.();
      const bulkCache = getResolvedBulkSources?.();
      const ownedServiceEnv: Record<string, Record<string, string>> = {};
      if (envRegistry) {
        for (const s of owned) {
          ownedServiceEnv[s.name] = await resolveEnvForService({
            serviceName: s.name,
            context: 'host',
            registry: envRegistry,
            injection: envInjection,
            ports,
            projectRoot: stackCtx.worktreePath,
            worktreeKey: stackCtx.worktreeKey,
            bulkCache,
          });
        }
      }

      // ------------------------------------------------------------------
      // Phase 3: Re-spawn owned services via the detached runner.
      // ------------------------------------------------------------------
      const detachedLogDir = join(
        stackCtx.worktreePath,
        '.levelzero',
        'state',
        stackCtx.worktreeKey,
        'logs',
      );

      const ownedNames = owned.map((s) => s.name).join(', ');
      const detached: DetachedRunnerHandle = await reporter.group(
        `Starting owned service(s) (${ownedNames})`,
        async () =>
          runOwnedServicesDetached(
            owned,
            stackCtx,
            ports,
            dockerEnv,
            {
              logDir: detachedLogDir,
              pidDir,
              ...(readinessTimeoutMs !== undefined ? { readinessTimeoutMs } : {}),
            },
            ownedServiceEnv,
          ),
      );

      // ------------------------------------------------------------------
      // LEV-219 parity — surface owned-service crash output.
      // ------------------------------------------------------------------
      const ownedFailed = Object.keys(detached.statuses).filter(
        (name) => detached.statuses[name] === 'failed',
      );

      const fullResult = {
        key: stackCtx.worktreeKey,
        stopped,
        started: {
          pids: detached.pids,
          statuses: detached.statuses,
          exitCodes: detached.exitCodes,
          exitedAfterMs: detached.exitedAfterMs,
          lastStderr: detached.lastLogTail,
          logPaths: detached.logPaths,
          pidPaths: detached.pidPaths,
        },
      };

      if (ownedFailed.length > 0) {
        const names = ownedFailed.join(', ');
        throw new CLIError(
          'INTERNAL',
          `owned service(s) failed to restart: ${names}`,
          {
            hint: `inspect full logs with: lich logs ${ownedFailed[0]!}`,
            details:
              ctx.format === 'json'
                ? { failed: ownedFailed, started: fullResult.started }
                : { summary: renderRestartPretty(stackCtx.worktreeKey, stopped, detached) },
          },
        );
      }

      if (ctx.format === 'json') return fullResult;
      return renderRestartPretty(stackCtx.worktreeKey, stopped, detached);
    },
  };
}

// ---------------------------------------------------------------------------
// Pretty-print renderer
// ---------------------------------------------------------------------------

function renderRestartPretty(
  key: string,
  stopped: Array<{ name: string; pid: number; result: string }>,
  detached: DetachedRunnerHandle | null,
): string {
  const lines: string[] = [`Restarted owned services for ${key}`];

  if (stopped.length > 0) {
    lines.push('stopped:');
    for (const o of stopped) {
      lines.push(`  ${o.name}  pid=${o.pid}  ${o.result}`);
    }
  } else {
    lines.push('stopped: (none running)');
  }

  if (detached) {
    lines.push('started (detached):');
    for (const [name, pid] of Object.entries(detached.pids)) {
      const status = detached.statuses[name] ?? 'skipped';
      if (status === 'failed') {
        const code = detached.exitCodes[name];
        const afterMs = detached.exitedAfterMs[name];
        const detail =
          code !== undefined
            ? afterMs !== undefined
              ? ` (exit code ${code} after ${(afterMs / 1000).toFixed(1)}s)`
              : ` (exit code ${code})`
            : '';
        lines.push(`  ${name}  pid=${pid}  failed${detail}`);
        const tail = detached.lastLogTail[name] ?? '';
        if (tail.length > 0) {
          lines.push('    last stderr:');
          for (const tl of tail.split('\n')) lines.push(`      ${tl}`);
        }
      } else {
        lines.push(`  ${name}  pid=${pid}  ${status}`);
      }
    }
    lines.push('  logs:  lich logs <service> --follow');
    lines.push('  stop:  lich stop');
  } else {
    lines.push('started: (no owned services configured)');
  }

  return lines.join('\n') + '\n';
}
