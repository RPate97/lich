/**
 * Compose override generator. Produces a per-worktree compose override YAML
 * and writes it to the stack's state directory. Passed to compose via
 * `-f <user> -f <override>` so the user's file stays untouched and lich
 * injects only the per-stack uniqueness it owns: host port bindings and
 * resolved env per compose service.
 *
 * Notes:
 *   - No `version:` (compose v2 doesn't need it; v3 deprecates it).
 *   - No `name:` (project name comes from the runner's `-p <project>`).
 *   - Service blocks with nothing to override are omitted entirely.
 *   - Container ports accepted in both Record (`{ http: { container, env } }`)
 *     and array (`[ { container, env } ]`) form. Bare-number Record entries
 *     (pinned host port, no container side) skip the binding.
 *   - Uses the `yaml` package for correct quoting on env values with special chars.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import type {
  ComposeService,
  LichConfig,
  PortDescriptor,
} from "../config/types.js";
import { stackDir } from "../state/directory.js";

export interface OverrideInput {
  config: LichConfig;
  /** Allocated ports for THIS stack: compose serviceName -> logicalPortName -> hostPort. */
  allocatedPorts: {
    compose: Record<string, Record<string, number>>;
  };
  /** Resolved env per compose service. Pass `{}` for services with empty env. */
  resolvedEnv: Record<string, NodeJS.ProcessEnv>;
  /** Stable per-worktree identifier; namespaces the project, embedded in the header. */
  stackId: string;
}

/**
 * Single service entry in the generated override. Field insertion order here
 * dictates YAML emit order (the `yaml` package preserves it in `stringify`):
 * `image, environment, ports, healthcheck, volumes, networks, profiles, tmpfs`.
 */
interface OverrideServiceBlock {
  image?: string;
  environment?: Record<string, string>;
  ports?: string[];
  healthcheck?: Record<string, unknown>;
  volumes?: unknown[];
  networks?: unknown;
  profiles?: unknown[];
  tmpfs?: string[] | string;
}

/**
 * Extract a container port from a ports declaration entry. Returns `undefined`
 * for bare-number form (pinned host port — no container side) or objects
 * without a `container` field.
 */
function containerPortFor(
  descriptor: PortDescriptor | undefined,
): number | undefined {
  if (descriptor == null) return undefined;
  if (typeof descriptor === "number") return undefined;
  if (typeof descriptor.container === "number" &&
      Number.isFinite(descriptor.container)) {
    return descriptor.container;
  }
  return undefined;
}

/**
 * Compute the `ports:` array for one compose service. For each allocated
 * logical port, look up the container port and emit `"<hostPort>:<containerPort>"`.
 * Iterated in sorted order for deterministic / idempotent output.
 */
function buildPortBindings(
  serviceDef: ComposeService,
  portMap: Record<string, number>,
): string[] {
  const bindings: string[] = [];
  const declared = serviceDef.ports;
  if (!declared) return bindings;

  const logicalNames = Object.keys(portMap).sort();

  for (const logicalName of logicalNames) {
    const hostPort = portMap[logicalName];
    if (typeof hostPort !== "number") continue;

    let container: number | undefined;

    if (Array.isArray(declared)) {
      // Array form has no logical-name keys; allocator map keys are string
      // indices (`"0"`, `"1"`, ...).
      const idx = Number(logicalName);
      if (Number.isInteger(idx) && idx >= 0 && idx < declared.length) {
        const entry = declared[idx];
        if (entry && typeof entry.container === "number") {
          container = entry.container;
        }
      }
    } else {
      container = containerPortFor(declared[logicalName]);
    }

    if (typeof container !== "number") continue;
    bindings.push(`${hostPort}:${container}`);
  }

  return bindings;
}

/** Coerce env to strings; drop undefined (don't emit `null` into yaml). Sorted. */
function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const val = env[key];
    if (typeof val === "string") {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Build the override document. For each compose service in lich.yaml, combine
 * lich-owned fields (env from pipeline, ports from allocator) with compose-spec
 * passthroughs declared inline (image, healthcheck, volumes, networks, profiles,
 * tmpfs, user-declared environment). Services with no relevant fields are
 * omitted entirely.
 *
 * Environment merge: if the user declared `environment:` inline AND the pipeline
 * produced values, both merge with the pipeline winning on conflict (pipeline
 * is the more recently computed, more authoritative source — it represents the
 * full chain of top-level env, profile env, env_groups, etc.).
 */
function buildOverrideDocument(input: OverrideInput): {
  services: Record<string, OverrideServiceBlock>;
} {
  const services: Record<string, OverrideServiceBlock> = {};
  const declaredServices = input.config.services ?? {};

  for (const serviceName of Object.keys(declaredServices).sort()) {
    const serviceDef = declaredServices[serviceName];
    if (!serviceDef) continue;

    const portMap = input.allocatedPorts.compose[serviceName] ?? {};
    const resolvedEnvMap = normalizeEnv(input.resolvedEnv[serviceName] ?? {});
    const portBindings = buildPortBindings(serviceDef, portMap);

    // User-declared environment is typed `unknown` because compose accepts
    // both map (`{ KEY: value }`) and list (`["KEY=value"]`) forms. We only
    // normalize the map form — the list form is rare in lich.yaml and the
    // override emits a map; mixing them would produce inconsistent shapes.
    let envMap: Record<string, string> = resolvedEnvMap;
    if (
      serviceDef.environment !== undefined &&
      serviceDef.environment !== null &&
      typeof serviceDef.environment === "object" &&
      !Array.isArray(serviceDef.environment)
    ) {
      const userEnv = normalizeEnv(
        serviceDef.environment as NodeJS.ProcessEnv,
      );
      envMap = { ...userEnv, ...resolvedEnvMap };
    }

    const hasImage = typeof serviceDef.image === "string";
    const hasEnv = Object.keys(envMap).length > 0;
    const hasPorts = portBindings.length > 0;
    const hasHealthcheck = serviceDef.healthcheck !== undefined;
    const hasVolumes =
      Array.isArray(serviceDef.volumes) && serviceDef.volumes.length > 0;
    const hasNetworks = serviceDef.networks !== undefined;
    const hasProfiles =
      Array.isArray(serviceDef.profiles) && serviceDef.profiles.length > 0;
    const hasTmpfs =
      typeof serviceDef.tmpfs === "string" ||
      (Array.isArray(serviceDef.tmpfs) && serviceDef.tmpfs.length > 0);

    if (
      !hasImage &&
      !hasEnv &&
      !hasPorts &&
      !hasHealthcheck &&
      !hasVolumes &&
      !hasNetworks &&
      !hasProfiles &&
      !hasTmpfs
    ) {
      continue;
    }

    const block: OverrideServiceBlock = {};
    if (hasImage) block.image = serviceDef.image;
    if (hasEnv) block.environment = envMap;
    if (hasPorts) block.ports = portBindings;
    if (hasHealthcheck) block.healthcheck = serviceDef.healthcheck;
    if (hasVolumes) block.volumes = serviceDef.volumes;
    if (hasNetworks) block.networks = serviceDef.networks;
    if (hasProfiles) block.profiles = serviceDef.profiles;
    if (hasTmpfs) block.tmpfs = serviceDef.tmpfs;

    services[serviceName] = block;
  }

  return { services };
}

/**
 * Produce the override YAML as a string. Pure — no I/O. Prefixed with:
 *   `# Auto-generated by lich. Do not edit.`
 *   `# stack_id: <id>`
 */
export function generateComposeOverride(input: OverrideInput): string {
  const doc = buildOverrideDocument(input);

  // Header added manually — `yaml` doesn't preserve top-of-file comments
  // in the simple stringify path.
  const body = stringify(doc);

  const header =
    "# Auto-generated by lich. Do not edit.\n" +
    `# stack_id: ${input.stackId}\n`;

  return header + body;
}

/**
 * Generate and write to `${stackDir}/compose.override.yaml`. Idempotent:
 * calling twice with identical input produces bit-for-bit identical content
 * (keys and port bindings sorted).
 */
export async function writeComposeOverride(
  input: OverrideInput,
): Promise<string> {
  const content = generateComposeOverride(input);
  const path = join(stackDir(input.stackId), "compose.override.yaml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}
