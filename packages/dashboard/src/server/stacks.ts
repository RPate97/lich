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
 *   running — every service up
 *   down    — no service up (includes the no-services case)
 *   partial — at least one up and at least one down
 */
function deriveStatus(services: ServiceView[]): StackStatus {
  const up = services.filter((s) => s.status === 'up').length;
  if (up === 0) return 'down';
  if (up === services.length) return 'running';
  return 'partial';
}

/**
 * Build the dashboard's `StackView[]` from a parsed registry. For each stack:
 *  - if its worktree path is gone, mark `worktreeMissing` + `down`, no probing
 *  - otherwise probe owned services (pid files) + compose services (docker)
 *  - attach URLs straight from the registry entry
 *
 * Status is always computed here, never persisted — see the design doc.
 */
export async function buildStackViews(reg: RegistryData): Promise<StackView[]> {
  const views: StackView[] = [];
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
        urls: entry.urls,
      });
      continue;
    }

    const owned = await readOwnedServices(entry.path, key);
    const containerStatus = await readContainerLiveness(entry.containers);

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
      urls: entry.urls,
    });
  }
  return views;
}
