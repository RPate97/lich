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
import { composeProjectName } from './naming';

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
 * Compose contributions sourced from plugins (post-LEV-148). The dispatcher
 * harvests these from `bootPlugins().compose` and forwards them into
 * `buildComposeBundle` alongside the legacy `DockerService[]` list so the
 * emitter writes a single unified compose file.
 *
 * Plugin contributions are merged **after** the legacy `dockerServiceToCompose`
 * outputs, so a plugin that contributes a same-named service overrides the
 * legacy entry — mirroring `PluginAPI.addComposeService`'s last-write-wins
 * semantics. Container names from plugin contributions are appended to
 * `bundle.containerNames` when present so `entry.containers` carries them too.
 */
export interface PluginComposeContributions {
  services: Record<string, ComposeServiceDef>;
  volumes: Record<string, ComposeVolumeDef>;
  networks: Record<string, ComposeNetworkDef>;
}

const EMPTY_PLUGIN_CONTRIBUTIONS: PluginComposeContributions = {
  services: {},
  volumes: {},
  networks: {},
};

/**
 * Build the compose bundle for the current stack: project name, on-disk file
 * path (under `.levelzero/<key>/`), container names, and the YAML text the
 * file should contain. **Pure** — no I/O. Use {@link writeComposeFile} to
 * persist `bundle.yaml`.
 *
 * The split lets `stop`/`reset` reconstruct the same project name + file path
 * without re-running every plugin's contribution logic if it later becomes
 * expensive. For now it's just a small convenience for testing.
 *
 * `pluginContributions` defaults to empty so callers that haven't been wired
 * through the plugin system (e.g. tests that drive the bundle directly with a
 * `DockerService[]`) keep working unchanged.
 *
 * `serviceEnv` (LEV-182) carries per-service env-var maps already resolved via
 * `resolveEnvForService({ context: 'container' })`. The bundle merges these
 * into each compose service's `environment:` block (last-write-wins over any
 * env the service definition itself ships). When omitted the bundle still
 * builds — the legacy behavior — but Plan 16's container-side injection is
 * skipped. `dev`/`stop`/`reset` always pass a populated (possibly empty) map.
 */
export function buildComposeBundle(
  ctx: StackContext,
  dockerServices: DockerService[],
  allocatedPorts: Record<string, number>,
  pluginContributions: PluginComposeContributions = EMPTY_PLUGIN_CONTRIBUTIONS,
  serviceEnv: Record<string, Record<string, string>> = {},
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

  // Merge plugin contributions on top. Same-named services/volumes/networks
  // win over the legacy DockerService output.
  for (const [name, def] of Object.entries(pluginContributions.services)) {
    services[name] = def;
    if (def.container_name) containerNames.push(def.container_name);
  }
  for (const [name, def] of Object.entries(pluginContributions.volumes)) {
    volumes[name] = def;
  }
  for (const [name, def] of Object.entries(pluginContributions.networks)) {
    networks[name] = def;
  }

  // LEV-182: inject the resolved per-service env into each compose service's
  // `environment:` block. Runs after both the legacy DockerService→compose
  // conversion AND the plugin-contributed services merge so it sees the final
  // service set. The pre-existing "compose services receive no env" bug
  // surfaced because nothing wrote into `service.environment` before now;
  // this is the fix. Resolved env entries are added last so they win over any
  // env the underlying definition carries (legacy `containerEnv` from
  // `dockerServiceToCompose` becomes a base set the resolved values layer on
  // top of — matching `envInjection`'s "explicit wins" intent).
  for (const [name, env] of Object.entries(serviceEnv)) {
    if (!services[name]) continue;
    if (Object.keys(env).length === 0) continue;
    services[name] = {
      ...services[name],
      environment: { ...(services[name].environment ?? {}), ...env },
    };
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
