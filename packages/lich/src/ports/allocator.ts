/**
 * File-locked, cross-process port allocator. Registry at `$LICH_HOME/ports.json`
 * is shared across all stacks; `lich up` invocations serialize through
 * `$LICH_HOME/ports.lock` so concurrent allocations don't collide.
 */

import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock.js";

const REGISTRY_VERSION = 1;

export interface AllocationRequest {
  stackId: string;
  /**
   * logical name → optional fixed port (if user pinned it in lich.yaml);
   * allocator must honor a fixed port if free or fail loudly.
   */
  logicalPorts: Record<string, number | null>;
  /** Range to allocate from when not pinned. */
  range: [number, number];
}

interface Registry {
  version: number;
  allocations: Record<string, Record<string, number>>;
}

function probeOn(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ port, host, exclusive: true });
  });
}

/**
 * Probe BOTH IPv4 (`0.0.0.0`) AND IPv6 (`::`) and require both to succeed.
 * Docker port forwards bind dual-stack; probing only IPv4 would miss a port
 * Docker had bound on IPv6 from another stack, then the supabase dual-stack
 * bind would fail with EADDRINUSE. Can't use a single `::` socket because
 * dual-stack-by-default behavior differs across OSes — separate probes are
 * the only portable approach.
 */
async function nodeBindProbe(port: number): Promise<boolean> {
  const ipv4Free = await probeOn("0.0.0.0", port);
  if (!ipv4Free) return false;
  const ipv6Free = await probeOn("::", port);
  return ipv6Free;
}

/**
 * Check whether any Docker container is publishing the given port.
 *
 * Docker's container port mappings are managed by `docker-proxy` (Linux) or
 * inside the Docker VM (macOS); those bindings aren't visible to Node's
 * `net.bind()` probe. Without this extra check, the allocator can pick a
 * "free" port that Docker then refuses to publish. `-a` covers stopped
 * containers too — docker holds the mapping until `docker rm`, not just stop.
 *
 * If docker isn't available, returns false — we trust the Node probe rather
 * than pretending the port is taken when we can't actually tell.
 */
function dockerHoldsPort(port: number): boolean {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("docker", ["ps", "-a", "--format", "{{.Ports}}"], {
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    return false;
  }
  if (result.status !== 0) return false;
  // `encoding: "utf8"` returns a string, but the type union includes Buffer.
  const stdout =
    typeof result.stdout === "string"
      ? result.stdout
      : result.stdout != null
        ? result.stdout.toString("utf8")
        : "";
  return new RegExp(`:${port}->`).test(stdout);
}

/**
 * Confirm a candidate port is bindable. Catches collisions with non-lich
 * processes AND stale Docker container port mappings. Node probe first
 * (cheap), Docker check only on Node-success to keep hot paths fast.
 */
async function isPortFree(port: number): Promise<boolean> {
  if (!(await nodeBindProbe(port))) return false;
  if (dockerHoldsPort(port)) return false;
  return true;
}

function lichHome(): string {
  return process.env.LICH_HOME ?? join(homedir(), ".lich");
}

function registryPath(): string {
  return join(lichHome(), "ports.json");
}

function lockPath(): string {
  return join(lichHome(), "ports.lock");
}

async function readRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.allocations === "object" &&
      parsed.allocations !== null
    ) {
      return {
        version:
          typeof parsed.version === "number"
            ? parsed.version
            : REGISTRY_VERSION,
        allocations: parsed.allocations as Record<
          string,
          Record<string, number>
        >,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Corrupted registry — surface rather than silently overwriting.
      throw new Error(
        `lich: failed to read port registry at ${registryPath()}: ${(err as Error).message}`,
      );
    }
  }
  return { version: REGISTRY_VERSION, allocations: {} };
}

async function writeRegistryAtomic(registry: Registry): Promise<void> {
  const target = registryPath();
  await mkdir(lichHome(), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(registry, null, 2), "utf8");
  try {
    await rename(tmp, target);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

function findHolderOfPort(
  registry: Registry,
  port: number,
  excludeStackId?: string,
): { stackId: string; logicalName: string } | undefined {
  for (const [stackId, ports] of Object.entries(registry.allocations)) {
    if (stackId === excludeStackId) continue;
    for (const [logicalName, p] of Object.entries(ports)) {
      if (p === port) return { stackId, logicalName };
    }
  }
  return undefined;
}

/**
 * Allocate ports for a stack atomically. Idempotent: same stackId returns
 * existing map unchanged.
 */
export async function allocate(
  req: AllocationRequest,
): Promise<Record<string, number>> {
  await mkdir(lichHome(), { recursive: true });
  return withFileLock(lockPath(), async () => {
    const registry = await readRegistry();

    // Idempotency: `lich up` retries (e.g. after a crash) must not get a
    // different set of ports than the state.json on disk already references.
    const existing = registry.allocations[req.stackId];
    if (existing) return { ...existing };

    const [rangeStart, rangeEnd] = req.range;
    if (rangeStart > rangeEnd) {
      throw new Error(
        `lich: invalid port range [${rangeStart}, ${rangeEnd}] (start > end)`,
      );
    }

    const inUse = new Set<number>();
    for (const [stackId, ports] of Object.entries(registry.allocations)) {
      if (stackId === req.stackId) continue;
      for (const p of Object.values(ports)) inUse.add(p);
    }

    const result: Record<string, number> = {};

    // Pass 1: honor pinned ports. Failing on conflict is the right call —
    // silently relocating a pinned port would surprise the user (env vars,
    // compose files often hardcode the value).
    for (const [logicalName, maybePort] of Object.entries(req.logicalPorts)) {
      if (maybePort === null || maybePort === undefined) continue;
      const pinned = maybePort;
      const holder = findHolderOfPort(registry, pinned, req.stackId);
      if (holder) {
        throw new Error(
          `lich: pinned port ${pinned} for ${req.stackId}.${logicalName} ` +
            `is already held by stack '${holder.stackId}' as '${holder.logicalName}'`,
        );
      }
      if (inUse.has(pinned)) {
        throw new Error(
          `lich: pinned port ${pinned} for ${req.stackId}.${logicalName} is already reserved`,
        );
      }
      if (!(await isPortFree(pinned))) {
        throw new Error(
          `lich: pinned port ${pinned} for ${req.stackId}.${logicalName} ` +
            `is in use by another process on the host`,
        );
      }
      result[logicalName] = pinned;
      inUse.add(pinned);
    }

    // Pass 2: unpinned. Lowest-free wins for deterministic parallel-allocation
    // ordering (once the lock has serialized them).
    for (const [logicalName, maybePort] of Object.entries(req.logicalPorts)) {
      if (maybePort !== null && maybePort !== undefined) continue;
      let chosen: number | null = null;
      for (let candidate = rangeStart; candidate <= rangeEnd; candidate++) {
        if (inUse.has(candidate)) continue;
        // eslint-disable-next-line no-await-in-loop
        if (!(await isPortFree(candidate))) continue;
        chosen = candidate;
        break;
      }
      if (chosen === null) {
        throw new Error(
          `lich: no free ports remain in range [${rangeStart}, ${rangeEnd}] ` +
            `for ${req.stackId}.${logicalName}`,
        );
      }
      result[logicalName] = chosen;
      inUse.add(chosen);
    }

    registry.allocations[req.stackId] = result;
    await writeRegistryAtomic(registry);
    return { ...result };
  });
}

/** Release ALL ports held by a stack. Idempotent. */
export async function release(stackId: string): Promise<void> {
  await mkdir(lichHome(), { recursive: true });
  await withFileLock(lockPath(), async () => {
    const registry = await readRegistry();
    if (!(stackId in registry.allocations)) return;
    delete registry.allocations[stackId];
    await writeRegistryAtomic(registry);
  });
}

/** List current allocations across all stacks. */
export async function listAllocations(): Promise<
  Record<string, Record<string, number>>
> {
  await mkdir(lichHome(), { recursive: true });
  return withFileLock(lockPath(), async () => {
    const registry = await readRegistry();
    const out: Record<string, Record<string, number>> = {};
    for (const [stackId, ports] of Object.entries(registry.allocations)) {
      out[stackId] = { ...ports };
    }
    return out;
  });
}
