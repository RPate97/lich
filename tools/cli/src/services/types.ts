/** Context passed to every service operation; identifies which stack we're operating on. */
export interface StackContext {
  /** 12-char hex worktree key. */
  worktreeKey: string;
  /** Absolute, canonical path of the worktree root. */
  worktreePath: string;
  /** Git branch of the worktree (best-effort; "" if not on a branch). */
  branch: string;
}

/** Named -> port-number map. Names are stable per-service (e.g. "postgres", "api"). */
export type PortMap = Record<string, number>;

/** Environment variables a service contributes for downstream services + tests. */
export type EnvContributions = (ports: PortMap) => Record<string, string>;

/** Returned by start(); holds the data the runner needs to stop() it later. */
export interface RunningHandle {
  serviceName: string;
  containerName: string;
  ports: PortMap;
}

/** Built-in or user-added Docker-managed service (third-party image). */
export interface DockerService {
  name: string;
  kind: 'docker';
  /** Port names this service exposes; allocator gives them concrete numbers. */
  portNames: string[];
  /** Docker image, e.g. "postgres:16-alpine". */
  image: string;
  /** Env passed into the container itself (separate from envContributions). */
  containerEnv?: Record<string, string>;
  /**
   * The port name this container listens on inside the container, and the
   * in-container port number. The runner maps host:<ports[name]> -> container:<containerPortInContainer>.
   * If undefined, the runner uses portNames[0] mapped to itself (rare; only sensible for host-mode services).
   */
  containerPortName?: string;
  containerPortInContainer?: number;
  /** Path inside the container to back with a named volume (one volume per service). */
  volumeMountPath?: string;
  /** Env vars this service publishes to other services and to tests. */
  envContributions: EnvContributions;
  /** Optional shell-quoted docker healthcheck (e.g. ["pg_isready", "-U", "postgres"]). */
  healthCommand?: string[];
}

/**
 * Owned-process service (managed by levelzero under concurrently).
 * Plan 03 fleshes this out; the placeholder keeps the discriminated union
 * forward-compatible without forcing every plan-02 consumer to branch on it.
 */
export interface OwnedServicePlaceholder {
  name: string;
  kind: 'owned';
  portNames: string[];
  envContributions: EnvContributions;
}

export type Service = DockerService | OwnedServicePlaceholder;
