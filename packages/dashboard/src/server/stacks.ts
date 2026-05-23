import { access } from 'node:fs/promises';
import type { RegistryData } from './registry-reader';
import { readOwnedServices, readContainerLiveness } from './liveness';
import type { ServiceView, StackStatus, StackView } from '../types';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive the overall stack status from its service list.
 *   running — every service healthy
 *   down    — no service alive (all down, or no services at all)
 *   partial — at least one alive service (healthy / unhealthy / starting)
 *             mixed with anything else, or all alive but not all healthy
 */
function deriveStatus(services: ServiceView[]): StackStatus {
  const alive = services.filter((s) => s.status !== 'down').length;
  if (alive === 0) return 'down';
  const healthy = services.filter((s) => s.status === 'healthy').length;
  if (healthy === services.length) return 'running';
  return 'partial';
}

/**
 * Build the dashboard's `StackView[]` from a parsed registry. For each stack:
 *  - if its worktree path is gone, mark `worktreeMissing` + `down`, no probing
 *  - otherwise probe owned services (pid files + optional HTTP probe) +
 *    compose services (docker inspect with Health.Status)
 *  - attach URLs straight from the registry entry
 *
 * Status is always computed here, never persisted — see the design doc.
 */
export async function buildStackViews(reg: RegistryData): Promise<StackView[]> {
  const views: StackView[] = [];
  const now = Date.now();
  for (const [key, entry] of Object.entries(reg.stacks)) {
    const exists = await pathExists(entry.path);
    if (!exists) {
      views.push({
        key,
        path: entry.path,
        branch: entry.branch,
        createdAt: entry.createdAt,
        status: 'down',
        worktreeMissing: true,
        services: [],
        ports: entry.ports,
        urls: entry.urls,
        startedBy: entry.startedBy,
      });
      continue;
    }

    const owned = await readOwnedServices(entry.path, key, {
      urls: entry.urls,
      createdAt: entry.createdAt,
      now,
    });
    const containerStatus = await readContainerLiveness(entry.containers, { now });

    const services: ServiceView[] = [
      ...owned.map((s) => ({
        name: s.name,
        kind: 'owned' as const,
        status: s.status,
        url: entry.urls[s.name],
      })),
      ...entry.containers.map((c) => ({
        name: c,
        kind: 'compose' as const,
        status: containerStatus[c] ?? 'down',
      })),
    ];

    views.push({
      key,
      path: entry.path,
      branch: entry.branch,
      createdAt: entry.createdAt,
      status: deriveStatus(services),
      worktreeMissing: false,
      services,
      ports: entry.ports,
      urls: entry.urls,
      startedBy: entry.startedBy,
    });
  }
  return views;
}
