import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ComposeNetworkDef,
  ComposeServiceDef,
  ComposeVolumeDef,
} from '../plugins/types';
import type { DockerService, StackContext } from '../services/types';
import { dockerServiceToCompose } from './from-docker';
import { emitCompose } from './emitter';
import { composeProjectName } from '../docker/naming';

export interface ComposeBundle {
  /** Compose project name, e.g. `levelzero-<key>`. */
  projectName: string;
  /** Absolute path to the (would-be) compose file under `<worktree>/.levelzero/<key>/`. */
  composeFilePath: string;
  /** Container names compose will create — preserves legacy naming for `entry.containers`. */
  containerNames: string[];
  /** Service-name → ComposeServiceDef map (placeholders already substituted). */
  services: Record<string, ComposeServiceDef>;
  /** Top-level named volumes. */
  volumes: Record<string, ComposeVolumeDef>;
  /** Emitted YAML text. `writeComposeFile()` persists this verbatim. */
  yaml: string;
}

/**
 * Build the compose bundle for the current stack: project name, on-disk file
 * path (under `.levelzero/<key>/`), container names, and the YAML text the
 * file should contain. **Pure** — no I/O. Use {@link writeComposeFile} to
 * persist `bundle.yaml`.
 *
 * The split lets `stop`/`reset` reconstruct the same project name + file path
 * without re-running every plugin's contribution logic if it later becomes
 * expensive. For now it's just a small convenience for testing.
 */
export function buildComposeBundle(
  ctx: StackContext,
  dockerServices: DockerService[],
  allocatedPorts: Record<string, number>,
): ComposeBundle {
  const services: Record<string, ComposeServiceDef> = {};
  const volumes: Record<string, ComposeVolumeDef> = {};
  const networks: Record<string, ComposeNetworkDef> = {};
  const containerNames: string[] = [];

  for (const svc of dockerServices) {
    const contrib = dockerServiceToCompose(svc, ctx);
    services[contrib.serviceName] = contrib.serviceDef;
    if (contrib.volumeName && contrib.volumeDef) {
      volumes[contrib.volumeName] = contrib.volumeDef;
    }
    if (contrib.serviceDef.container_name) {
      containerNames.push(contrib.serviceDef.container_name);
    }
  }

  const projectName = composeProjectName(ctx.worktreeKey);
  const composeFilePath = join(
    ctx.worktreePath,
    '.levelzero',
    ctx.worktreeKey,
    'docker-compose.yml',
  );

  const yaml = emitCompose({
    services,
    volumes,
    networks,
    projectName,
    allocatedPorts,
  });

  return { projectName, composeFilePath, containerNames, services, volumes, yaml };
}

/**
 * Write `bundle.yaml` to `bundle.composeFilePath`, creating parents as
 * needed. Idempotent.
 */
export async function writeComposeFile(bundle: ComposeBundle): Promise<void> {
  await mkdir(dirname(bundle.composeFilePath), { recursive: true });
  await writeFile(bundle.composeFilePath, bundle.yaml, 'utf8');
}
