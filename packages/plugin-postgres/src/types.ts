/**
 * Local type re-declarations the plugin needs from `@levelzero/core`.
 *
 * Why duplicate: the worktree's `node_modules/@levelzero/core` may resolve to
 * a sibling/parent project's copy in shared-cache workspaces (e.g. when
 * Bun/Turbo dedup across worktrees), so type-only imports against unreleased
 * additions to the core barrel can silently target the older sibling. Keeping
 * these structural copies inside the plugin lets the package typecheck against
 * its own source regardless of how `@levelzero/core` resolves at install time.
 *
 * The shapes mirror `packages/core/src/services/types.ts` exactly — `pgService`
 * is consumed elsewhere as a `DockerService` from `@levelzero/core` (those
 * call sites already import the canonical version, structural compatibility
 * is enough).
 */

/** Named → port-number map. Names are stable per-service (e.g. "postgres", "api"). */
export type PortMap = Record<string, number>;

/** Environment variables a service contributes for downstream services + tests. */
export type EnvContributions = (ports: PortMap) => Record<string, string>;

/** Built-in or user-added Docker-managed service (third-party image). */
export interface DockerService {
  name: string;
  kind: 'docker';
  portNames: string[];
  image: string;
  containerEnv?: Record<string, string>;
  containerPortName?: string;
  containerPortInContainer?: number;
  volumeMountPath?: string;
  /**
   * @deprecated Plan 16 / LEV-187 — postgres now publishes env values via
   * `api.addEnvSource()`. Field made optional so the legacy `pgService`
   * re-export can omit it; kept in the structural type for compatibility
   * with consumers that still attach a function during the transition.
   */
  envContributions?: EnvContributions;
  healthCommand?: string[];
}
