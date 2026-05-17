import type { DockerService, StackContext } from '../services/types';
import { containerName, volumeName } from './naming';
import type {
  ComposeServiceDef,
  ComposeVolumeDef,
} from '../plugins/types';

/**
 * Result of converting a single `DockerService` into a compose contribution.
 *
 * `serviceName` is the compose service key (we use the levelzero service name
 * verbatim — short, stable, project-scoped via `name:` in the emitted file).
 *
 * `volumeName`/`volumeDef` are set when the source service declares a
 * `volumeMountPath`; the emitter needs both the entry in the service's
 * `volumes:` array and a matching top-level `volumes:` declaration.
 */
export interface DockerComposeContribution {
  serviceName: string;
  serviceDef: ComposeServiceDef;
  volumeName?: string;
  volumeDef?: ComposeVolumeDef;
}

/**
 * Interim adapter: convert a legacy `DockerService` (still used by the
 * builtins until LEV-148 extracts postgres into its own plugin) into a
 * `ComposeServiceDef` that the LEV-131 emitter understands.
 *
 * Why this exists: LEV-133 rewrites the docker-service portion of
 * `dev`/`stop`/`reset` to drive `docker compose`, but the project still has
 * no plugin contributing postgres directly. Once LEV-148 lands a postgres
 * plugin that calls `addComposeService` itself, the call sites here go away.
 *
 * Naming guarantees the adapter preserves:
 *   - `container_name` = `levelzero-<key>-<service>` (existing convention,
 *     consumed by `entry.containers`, `stacks stop --all`, log lookups).
 *   - Volume name = `levelzero-<key>-<service>-data` when `volumeMountPath`
 *     is set; absent otherwise.
 *   - Host port uses the `${PORT_<containerPortName>}` placeholder so the
 *     emitter can substitute the allocator's choice.
 */
export function dockerServiceToCompose(
  svc: DockerService,
  ctx: StackContext,
): DockerComposeContribution {
  const cName = containerName(ctx.worktreeKey, svc.name);
  const def: ComposeServiceDef = {
    image: svc.image,
    container_name: cName,
  };

  if (svc.containerEnv && Object.keys(svc.containerEnv).length > 0) {
    def.environment = { ...svc.containerEnv };
  }

  if (svc.containerPortName && svc.containerPortInContainer !== undefined) {
    // Bind to 127.0.0.1 to match `buildRunArgs` semantics — only the local
    // machine should reach the container directly.
    def.ports = [
      `127.0.0.1:\${PORT_${svc.containerPortName}}:${svc.containerPortInContainer}`,
    ];
  }

  let vName: string | undefined;
  let vDef: ComposeVolumeDef | undefined;
  if (svc.volumeMountPath) {
    vName = volumeName(ctx.worktreeKey, svc.name);
    def.volumes = [`${vName}:${svc.volumeMountPath}`];
    // Pin `name:` so compose doesn't prefix it with the project name
    // (default behaviour for top-level named volumes). Keeps the legacy
    // `levelzero-<key>-<service>-data` naming consumed by `db inspect`
    // and any operator running `docker volume ls`.
    vDef = { name: vName };
  }

  if (svc.healthCommand && svc.healthCommand.length > 0) {
    def.healthcheck = {
      test: ['CMD', ...svc.healthCommand],
      interval: '2s',
      timeout: '5s',
      retries: 30,
      start_period: '2s',
    };
  }

  return {
    serviceName: svc.name,
    serviceDef: def,
    volumeName: vName,
    volumeDef: vDef,
  };
}
