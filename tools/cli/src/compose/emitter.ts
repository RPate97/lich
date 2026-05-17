import { stringify as stringifyYaml } from 'yaml';
import type {
  ComposeServiceDef,
  ComposeVolumeDef,
  ComposeNetworkDef,
} from '../plugins/types';

export interface EmitComposeInput {
  services: Record<string, ComposeServiceDef>;
  volumes: Record<string, ComposeVolumeDef>;
  networks: Record<string, ComposeNetworkDef>;
  projectName: string;
  /**
   * Map of service-name → host-side port, used to substitute `${PORT_<name>}`
   * placeholders inside `service.ports[]`. Names map 1:1 to placeholder names
   * (e.g. `{ postgres: 54000 }` resolves `${PORT_postgres}` → `54000`).
   */
  allocatedPorts: Record<string, number>;
}

/**
 * Matches a `${PORT_<name>}` placeholder. The captured group is the
 * port-name (alphanumerics, underscores, dashes). Used per-occurrence so a
 * single port string may contain multiple placeholders.
 */
const PORT_PLACEHOLDER = /\$\{PORT_([A-Za-z0-9_-]+)\}/g;

/**
 * Emit a compose-v2 YAML document from the merged plugin contributions.
 *
 * Pure: input → string. The only transformation applied is substitution of
 * `${PORT_<name>}` placeholders inside each service's `ports[]` entries
 * using `allocatedPorts`. All other compose-v2 keys pass through verbatim,
 * so the output round-trips: `yaml.parse(emitCompose(input))` reproduces
 * the input (modulo port substitution) exactly.
 *
 * Empty top-level `volumes` / `networks` maps are omitted from the output
 * to keep the file minimal; compose treats their absence as equivalent.
 */
export function emitCompose(input: EmitComposeInput): string {
  const { services, volumes, networks, projectName, allocatedPorts } = input;

  const resolvedServices: Record<string, ComposeServiceDef> = {};
  for (const [name, def] of Object.entries(services)) {
    resolvedServices[name] = def.ports
      ? { ...def, ports: def.ports.map((p) => substitutePort(p, allocatedPorts)) }
      : def;
  }

  const doc: Record<string, unknown> = {
    name: projectName,
    services: resolvedServices,
  };
  if (Object.keys(volumes).length > 0) doc.volumes = volumes;
  if (Object.keys(networks).length > 0) doc.networks = networks;

  return stringifyYaml(doc);
}

function substitutePort(
  portString: string,
  allocatedPorts: Record<string, number>,
): string {
  return portString.replace(PORT_PLACEHOLDER, (_, name: string) => {
    const allocated = allocatedPorts[name];
    if (allocated === undefined) {
      throw new Error(
        `emitCompose: port placeholder \${PORT_${name}} has no allocated port ` +
          `(allocatedPorts keys: ${Object.keys(allocatedPorts).join(', ') || '<none>'})`,
      );
    }
    return String(allocated);
  });
}
