/**
 * Compose override generator (Plan 1, Task 8).
 *
 * Produces a per-worktree compose override YAML and writes it to the
 * stack's state directory. The override is passed to compose via the
 * standard `-f <user> -f <override>` chain so the user's compose file
 * stays untouched and lich injects only the per-stack uniqueness it
 * owns: host port bindings (allocator-driven) and resolved env per
 * compose service.
 *
 * Notes:
 *
 *   - No `version:` is emitted. Compose v2 doesn't need it and v3
 *     deprecates it; emitting one would warn (or error) on modern
 *     compose CLIs.
 *
 *   - No `name:` field is emitted. The compose project name is set
 *     via the runner's `-p <project>` flag (see `./runner.ts`), not
 *     in the file.
 *
 *   - If a service in the user's lich.yaml has neither `ports` to
 *     bind nor `env` to inject, the entire service block is omitted
 *     from the override — keeps the file minimal and avoids touching
 *     services that have nothing to override.
 *
 *   - The container port comes from the user's lich.yaml. We accept
 *     either of the two `services.<name>.ports` shapes defined in
 *     `config/types.ts`:
 *       1. Record form: `{ http: { container: 3000, env: PORT } }`
 *       2. Array form:  `[ { container: 3000, env: PORT } ]`
 *     The array form is the compose-spec passthrough; the record
 *     form matches the dogfood-style shape. The Record form's value
 *     also accepts a bare number (pinned host port) — in that case
 *     we have no container port to bind to and skip that entry.
 *
 *   - Output uses the `yaml` package so quoting/escaping is correct
 *     for all env values (URLs with `:` and `/`, values with spaces
 *     or special chars, etc.).
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
  /** Parsed lich.yaml. */
  config: LichConfig;
  /**
   * Allocated ports for THIS stack: serviceLogicalName -> hostPort.
   * Includes both compose services and owned. Compose entries map by
   * service name (top-level under `services:`); for each compose
   * service, the logical port names within map to allocated host ports.
   */
  allocatedPorts: {
    /**
     * For compose services: serviceName -> { logicalPortName -> hostPort }.
     */
    compose: Record<string, Record<string, number>>;
  };
  /**
   * Resolved env to inject per compose service. Each service's env is
   * the result of the env pipeline (Plan 1 has a simple single-layer
   * pipeline; the full pipeline arrives in Task 13). Pass `{}` per
   * service if env is empty.
   */
  resolvedEnv: Record<string, NodeJS.ProcessEnv>;
  /**
   * Stable identifier for this stack (worktree-scoped). Used to
   * namespace the compose project name and embedded in the header
   * comment for debuggability.
   */
  stackId: string;
}

/**
 * Internal shape of a single service entry in the generated override.
 *
 * Holds both the lich-owned fields (`environment` populated from the env
 * pipeline, `ports` populated from the allocator) and the compose-spec
 * passthroughs the user declares inline in `lich.yaml`
 * (`image`/`healthcheck`/`volumes`/`networks`/`profiles`/`tmpfs`). Per
 * LEV-477 the passthroughs are emitted verbatim so users can keep the
 * full service definition in `lich.yaml` rather than splitting it
 * across a sibling compose file.
 *
 * Field insertion order in `buildOverrideDocument` determines emit
 * order in the YAML output (the `yaml` package preserves insertion
 * order in default `stringify`). The chosen order is:
 *   `image, environment, ports, healthcheck, volumes, networks, profiles, tmpfs`.
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
 * Pull the container port out of one entry of a service's `ports`
 * declaration. Returns `undefined` when the entry has no container
 * port we can bind to (e.g. a bare host-port pin in the Record form,
 * or an object form without a `container` field).
 *
 * `PortDescriptor` (see `config/types.ts`) is either a bare number
 * (pinned host port — no container side) or an object that may carry
 * `env`, `host_port`, and/or `container`. We only need `container`
 * here; everything else is the env-resolver's concern.
 */
function containerPortFor(
  descriptor: PortDescriptor | undefined,
): number | undefined {
  if (descriptor == null) return undefined;
  // Bare-number form means "pin this host port" — no container side
  // is declared, so we can't synthesize a host:container binding.
  if (typeof descriptor === "number") return undefined;
  if (typeof descriptor.container === "number" &&
      Number.isFinite(descriptor.container)) {
    return descriptor.container;
  }
  return undefined;
}

/**
 * Compute the `ports:` array for one compose service.
 *
 * For each logical port name the allocator handed us, look up the
 * corresponding container port from the user's lich.yaml and emit a
 * `"<hostPort>:<containerPort>"` binding. Skip entries where no
 * container port is declared (defensive — caller should generally
 * only allocate for entries that have one).
 */
function buildPortBindings(
  serviceDef: ComposeService,
  portMap: Record<string, number>,
): string[] {
  const bindings: string[] = [];
  const declared = serviceDef.ports;
  if (!declared) return bindings;

  // Iterate allocated entries in stable (sorted) order so the output
  // is deterministic regardless of object-key insertion order. This
  // matters for the idempotency contract on `writeComposeOverride`.
  const logicalNames = Object.keys(portMap).sort();

  for (const logicalName of logicalNames) {
    const hostPort = portMap[logicalName];
    if (typeof hostPort !== "number") continue;

    let container: number | undefined;

    if (Array.isArray(declared)) {
      // Array form: `ports: [{ container, env?, host_port? }, ...]`.
      // There's no logical-name key in the array form, so the allocator
      // map's keys are assumed to be string indices (`"0"`, `"1"`, ...).
      const idx = Number(logicalName);
      if (Number.isInteger(idx) && idx >= 0 && idx < declared.length) {
        const entry = declared[idx];
        if (entry && typeof entry.container === "number") {
          container = entry.container;
        }
      }
    } else {
      // Record form: `ports: { http: { container, env, ... }, ... }`.
      container = containerPortFor(declared[logicalName]);
    }

    if (typeof container !== "number") continue;
    bindings.push(`${hostPort}:${container}`);
  }

  return bindings;
}

/**
 * Coerce env values to strings. The env pipeline ultimately produces
 * `NodeJS.ProcessEnv`, which is already `Record<string, string | undefined>`,
 * but the type allows `undefined` and we want to skip those rather than
 * emit `null` into the yaml.
 */
function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  // Sort keys for deterministic output (same reason as port bindings).
  for (const key of Object.keys(env).sort()) {
    const val = env[key];
    if (typeof val === "string") {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Build the override document object (not yet serialized).
 *
 * Walks every compose service declared in the user's lich.yaml and
 * builds an override block from:
 *   - lich-owned fields (`environment` from the env pipeline, `ports`
 *     from the allocator), AND
 *   - compose-spec passthroughs declared inline in lich.yaml (`image`,
 *     `healthcheck`, `volumes`, `networks`, `profiles`, `tmpfs`,
 *     user-declared `environment`).
 *
 * A service makes it into the output as long as the block has any
 * field at all. A service that declares nothing relevant (no ports,
 * no env, no passthroughs) is omitted entirely — no point shipping
 * empty entries to compose.
 *
 * Field insertion order is fixed (`image, environment, ports,
 * healthcheck, volumes, networks, profiles, tmpfs`) so the emitted
 * YAML is deterministic regardless of object-key insertion order in
 * the input.
 *
 * Environment merge rule (LEV-477): if the user declared `environment:`
 * inline AND the env pipeline also produced values, both are merged
 * and the pipeline's values win on key conflict. Rationale: the
 * pipeline output is the result of the full env resolution chain
 * (top-level env, profile env, env_groups, etc.) and the user's
 * inline `environment:` on a compose service is the equivalent of
 * raw compose syntax that pre-dates lich. Where they overlap, the
 * lich pipeline is the more recently computed and more authoritative
 * source.
 */
function buildOverrideDocument(input: OverrideInput): {
  services: Record<string, OverrideServiceBlock>;
} {
  const services: Record<string, OverrideServiceBlock> = {};
  const declaredServices = input.config.services ?? {};

  // Iterate in sorted order for deterministic output.
  for (const serviceName of Object.keys(declaredServices).sort()) {
    const serviceDef = declaredServices[serviceName];
    if (!serviceDef) continue;

    const portMap = input.allocatedPorts.compose[serviceName] ?? {};
    const resolvedEnvMap = normalizeEnv(input.resolvedEnv[serviceName] ?? {});
    const portBindings = buildPortBindings(serviceDef, portMap);

    // Merge user-declared `environment:` (if any) with the resolved env
    // from the pipeline. Resolved wins on conflict.
    //
    // The user-declared form is typed `unknown` in `ComposeService`
    // because compose accepts both map form (`{ KEY: value }`) and list
    // form (`["KEY=value"]`). We only normalize the map form here — the
    // list form is rare in lich.yaml (where the map form composes cleanly
    // with lich's own env machinery) and the override emits a map; mixing
    // a user-supplied list with lich's map would produce inconsistent
    // shapes inside the override. If a user supplies the list form it
    // passes through unchanged in the absence of resolved env, otherwise
    // resolved env wins and the list is dropped — surface a stricter rule
    // here only if we get a real report.
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

    // Widened inclusion check (LEV-477): emit a block if ANY field has
    // content. Pre-LEV-477 we only checked ports + env, which silently
    // dropped services that declared (e.g.) only `image:` — the
    // resulting override missed the inline declaration and compose then
    // rejected the service with "neither an image nor a build context
    // specified".
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

    // Build the block by inserting fields in the fixed emit order. The
    // `yaml` package preserves insertion order in `stringify`, so this
    // is also the order the user sees in the on-disk override file.
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
 * Produce the override YAML as a string. Pure function — no I/O.
 *
 * The output is prefixed with a two-line header:
 *   `# Auto-generated by lich. Do not edit.`
 *   `# stack_id: <id>`
 *
 * If no services need overriding the document still emits a valid
 * (empty) `services: {}` block so compose accepts the file without
 * complaint — the header makes it obvious why the file is otherwise
 * empty.
 */
export function generateComposeOverride(input: OverrideInput): string {
  const doc = buildOverrideDocument(input);

  // `stringify` with default options gives us idiomatic block-style
  // yaml; we add the header manually since `yaml` doesn't preserve
  // top-of-file comments in the simple stringify path.
  const body = stringify(doc);

  const header =
    "# Auto-generated by lich. Do not edit.\n" +
    `# stack_id: ${input.stackId}\n`;

  return header + body;
}

/**
 * Convenience wrapper: generate + write to `${stackDir}/compose.override.yaml`.
 * Creates the parent directory if needed (idempotent). Returns the
 * absolute path that was written.
 *
 * Idempotency: calling twice with identical input produces identical
 * file content. The generator sorts keys and port bindings so the
 * output is bit-for-bit reproducible.
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
