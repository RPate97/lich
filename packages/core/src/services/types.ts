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

/**
 * Environment variables a service contributes for downstream services + tests.
 *
 * @deprecated Plan 16 / LEV-178+ — publish env values via
 * `api.addEnvSource(name, source)` instead. During the transition the boot-time
 * compat shim (`env/compat.ts`, LEV-185) auto-promotes any `envContributions`
 * still present on a `DockerService` / `OwnedService` to a named EnvSource
 * under the plugin's namespace. LEV-187 migrates each v0 plugin off the legacy
 * shape; Plan 17 removes both this type and the shim.
 */
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
  /**
   * Env vars this service publishes to other services and to tests.
   *
   * @deprecated Plan 16 / LEV-178+ — use `api.addEnvSource()` in the plugin's
   * `register()`. The LEV-185 boot-time shim auto-promotes any remaining
   * `envContributions` on a service so plugins keep working during the
   * migration; LEV-187 removes the per-plugin usage on the v0 plugins
   * (making this field optional) and Plan 17 retires the shim along with
   * this field.
   */
  envContributions?: EnvContributions;
  /** Optional shell-quoted docker healthcheck (e.g. ["pg_isready", "-U", "postgres"]). */
  healthCommand?: string[];
}

/**
 * Service that lich spawns as a process (Hono api, Next web, project-added workers).
 * Managed via concurrently; its command should be hot-reload-aware in dev.
 */
export interface OwnedService {
  name: string;
  kind: 'owned';
  portNames: string[];
  /** Working directory for the spawned process, relative to project root. */
  cwd: string;
  /** Shell-quoted command. By convention, hot-reload-aware (e.g. `bun --hot run src/index.ts`). */
  command: string;
  /**
   * @deprecated Plan 16 / LEV-178+ — use `api.addEnvSource()` in the plugin's
   * `register()`. The LEV-185 boot-time shim auto-promotes any remaining
   * `envContributions` on a service so plugins keep working during the
   * migration; LEV-187 removes the per-plugin usage on the v0 plugins
   * (making this field optional) and Plan 17 retires the shim along with
   * this field.
   */
  envContributions?: EnvContributions;
  /** Names of other services this service depends on. The runner starts them first. */
  dependsOn?: string[];
  /**
   * Optional key under which this service publishes a URL (e.g., 'web', 'api') in
   * the per-stack registry's `urls` map. `dev` populates the entry after URL
   * registration; consumers (e.g., `stacks ls`) surface it. Absent for services
   * that do not expose a URL.
   */
  urlName?: string;
}

export type Service = DockerService | OwnedService;
