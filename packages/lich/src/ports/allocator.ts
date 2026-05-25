/**
 * File-locked, cross-process port allocator.
 *
 * Registry lives at `$LICH_HOME/ports.json` (defaults to `~/.lich/ports.json`)
 * — a single shared file all stacks read/write under the lock at
 * `$LICH_HOME/ports.lock`. `lich up` invocations across worktrees
 * serialize through the lock so concurrent allocations don't collide.
 */

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

/**
 * Probe to confirm a candidate port is actually bindable on the host.
 * The registry tells us what other lich stacks reserved; this catches
 * collisions with non-lich processes (the user's other dev tools).
 *
 * ## Dual-stack probe (LEV-457)
 *
 * We probe BOTH IPv4 (`0.0.0.0`) AND IPv6 (`::`) and require both binds
 * to succeed. Why: Docker's port forwards bind dual-stack (both families).
 * If we probed only IPv4 (the original implementation), we'd miss a
 * port that Docker had bound on IPv6 from another stack's containers —
 * `isPortFree` would falsely return true, the allocator would hand it
 * out, then supabase's own dual-stack bind would fail with EADDRINUSE.
 *
 * The two probes run sequentially. If IPv4 fails, we short-circuit. If
 * IPv4 succeeds but IPv6 fails (host has IPv6 disabled or a v4-only
 * conflict exists), we return false too — better to skip the port than
 * to hand out a half-bindable one.
 *
 * Note: we can't use a single `::` socket with `ipv6Only: false` (the
 * "true dual-stack" bind) because OS defaults differ — on macOS that
 * socket also blocks IPv4 binds on the same port, but on Linux without
 * `IPV6_V6ONLY` it depends on `/proc/sys/net/ipv6/bindv6only`. Probing
 * each family separately is the only portable approach.
 */
async function isPortFree(port: number): Promise<boolean> {
  const probeOn = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen({ port, host, exclusive: true });
    });

  const ipv4Free = await probeOn("0.0.0.0");
  if (!ipv4Free) return false;
  const ipv6Free = await probeOn("::");
  return ipv6Free;
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
      // Corrupted registry — surface, don't silently overwrite the
      // user's port assignments.
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

/** Find which stack (if any) holds a given port. */
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
 * Allocate ports for a stack atomically. Idempotent: if the stack
 * already has allocations in the registry, returns them unchanged.
 */
export async function allocate(
  req: AllocationRequest,
): Promise<Record<string, number>> {
  await mkdir(lichHome(), { recursive: true });
  return withFileLock(lockPath(), async () => {
    const registry = await readRegistry();

    // Idempotency: same stackId → return existing map. `lich up` retries
    // (e.g. after a crash mid-startup) must not get a different set of
    // ports than the state.json already on disk references.
    const existing = registry.allocations[req.stackId];
    if (existing) return { ...existing };

    const [rangeStart, rangeEnd] = req.range;
    if (rangeStart > rangeEnd) {
      throw new Error(
        `lich: invalid port range [${rangeStart}, ${rangeEnd}] (start > end)`,
      );
    }

    // Collect every port currently held by OTHER stacks.
    const inUse = new Set<number>();
    for (const [stackId, ports] of Object.entries(registry.allocations)) {
      if (stackId === req.stackId) continue;
      for (const p of Object.values(ports)) inUse.add(p);
    }

    const result: Record<string, number> = {};

    // Pass 1: honor pinned ports. Failing here on conflict is the right
    // call — silently relocating a pinned port would surprise the user
    // (env vars, compose files often hardcode the value).
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

    // Pass 2: assign unpinned by scanning the range. Lowest-free wins;
    // gives parallel allocations a deterministic ordering once the lock
    // serializes them.
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

/** Release ALL ports held by a stack. Idempotent (no-op if none). */
export async function release(stackId: string): Promise<void> {
  await mkdir(lichHome(), { recursive: true });
  await withFileLock(lockPath(), async () => {
    const registry = await readRegistry();
    if (!(stackId in registry.allocations)) return;
    delete registry.allocations[stackId];
    await writeRegistryAtomic(registry);
  });
}

/** List current allocations across all stacks (for `lich stacks` / debugging). */
export async function listAllocations(): Promise<
  Record<string, Record<string, number>>
> {
  await mkdir(lichHome(), { recursive: true });
  return withFileLock(lockPath(), async () => {
    const registry = await readRegistry();
    // Deep copy so callers can't mutate our internal view.
    const out: Record<string, Record<string, number>> = {};
    for (const [stackId, ports] of Object.entries(registry.allocations)) {
      out[stackId] = { ...ports };
    }
    return out;
  });
}
