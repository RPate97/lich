/**
 * `lich down` — idempotent stack teardown. Inverse of `lich up`.
 *
 * Reads state.json, re-parses lich.yaml to recover lifecycle hooks / stop_cmd / depends_on
 * (none of which the snapshot carries), and tears down in reverse-topo order:
 *
 *   1. per-owned-service stop (before_down hook → stop_cmd or SIGTERM→SIGKILL → mark stopped)
 *   2. composed before_down (profile then top-level, LIFO)
 *   3. per-compose-service stop, then project-scoped `compose down -v`
 *   4. composed after_down (LIFO) — for external cleanup safe only post-teardown
 *   5. release ports → mark stopped → summary
 *
 * Best-effort: every failure becomes a warning; teardown continues; exit stays 0. Re-runs are no-ops.
 * Yaml-gone case: state-only teardown with a warning; the stack still cleans up.
 *
 * LogTail lifecycle: `lich down` runs in a separate process from `lich up` — it inherits no LogTail registry.
 * The supervisor's SIGTERM/SIGKILL terminates the child holding the log write fd; the kernel reclaims it.
 * Any LogTail tied to a still-running `lich up` is stopped by that process's cancellation cleanup (or GC on exit).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../config/parse.js";
import { detectWorktree, hashPath, sanitizeName, type Worktree } from "../worktree/detect.js";
import { resolveStackId } from "../state/resolve-stack.js";
import { release } from "../ports/allocator.js";
import {
  readSnapshot,
  rebuildAllocatedPorts,
  injectOwnedPortEnv,
  truncateFailedCmd,
  writeSnapshot,
  type AllocatedPorts,
  type LifecyclePhaseStatus,
  type LifecycleSnapshotStatus,
  type SnapshotLifecycleEntry,
  type StackSnapshot,
} from "../state/snapshot.js";
import {
  interpolateString,
  type InterpolationContext,
} from "../config/interpolation.js";
import { listStacks, phaseLogPath, stackDir } from "../state/directory.js";
import { resolveComposeCli } from "../compose/detect.js";
import { sweepOwnedContainers } from "../owned/containers.js";
import { survivors, signalGroup } from "../owned/supervisor.js";
import {
  down as composeDown,
  _exec as composeExec,
  type RunnerCtx,
} from "../compose/runner.js";
import { resolveEnvForService, resolveTopLevelEnv } from "../env/resolve.js";
import { resolveEnvGroup } from "../groups/resolve.js";
import {
  runLifecycle,
  type LifecycleEntry,
} from "../lifecycle/executor.js";
import { runPerServiceLifecycle } from "../lifecycle/per-service.js";
import { buildGraph, type NodeDecl } from "../deps/graph.js";
import { shutdownOrder, CycleError } from "../deps/sort.js";
import { resolveProfile } from "../profiles/resolve.js";
import {
  createOutput,
  type Output,
  type OutputMode,
} from "../output/index.js";
import type { LichConfig, OwnedService } from "../config/types.js";
import { pickExecutor } from "../stack/executor.js";

export interface RunDownInput {
  cwd?: string;
  /** Stack ID or worktree name (`--worktree`); defaults to cwd-derived. */
  worktreeArg?: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  outputMode?: OutputMode;
  /** When fired, short-circuits SIGTERM grace polling — escalate to SIGKILL immediately. */
  signal?: AbortSignal;
  /** When true, destroy the sandbox VM instead of stopping it (sandbox stacks only). */
  purge?: boolean;
}

export interface DownWarning {
  /** Service name (omitted for stack-level warnings). */
  service?: string;
  /** Coarse phase tag: 'before_down', 'after_down', 'stop_owned', 'compose_down', 'release_ports', etc. */
  phase: string;
  message: string;
}

export interface RunDownResult {
  exitCode: number;
  warnings: DownWarning[];
}

// Sandbox stacks need to reach the routing block to destroy their VM, even
// when the snapshot says "stopped" — the VM persists across `lich down`.
export function shouldEarlyExitOnStopped(
  snapshot: StackSnapshot,
  purge: boolean | undefined,
): boolean {
  return snapshot.status === "stopped" && !(snapshot.sandbox === true && purge === true);
}

const SIGTERM_GRACE_MS = 5_000;
const STOP_CMD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;
/** Cap on stderr ring buffer captured from stop_cmd so a chatty teardown doesn't balloon the warning string. */
const STOP_CMD_STDERR_RING_BYTES = 4 * 1024;
/** Threshold above which a stop_cmd that exited 0 is flagged as slow — often symptom of a hung teardown. */
const STOP_CMD_SLOW_MS = 5_000;

function buildDownInterpCtx(
  worktree: Worktree,
  allocatedPorts: AllocatedPorts,
): InterpolationContext {
  const services: InterpolationContext["services"] = {};
  for (const [svc, ports] of Object.entries(allocatedPorts.compose)) {
    const keys = Object.keys(ports);
    services[svc] = {
      host_port: keys.length > 0 ? ports[keys[0]] : undefined,
      ports: { ...ports },
    };
  }
  const owned: InterpolationContext["owned"] = {};
  for (const [svc, entry] of Object.entries(allocatedPorts.owned)) {
    owned[svc] = { port: entry.port, ports: entry.ports };
  }
  return {
    worktree: { name: worktree.name, id: worktree.id, path: worktree.path },
    services,
    owned,
  };
}

function interpolateDownLifecycleEntries(
  entries: Array<string | { cmd: string; env_group?: string }>,
  ctx: InterpolationContext,
  source: string,
): Array<string | { cmd: string; env_group?: string }> {
  return entries.map((entry, i) => {
    if (typeof entry === "string") {
      return interpolateString(entry, ctx, `${source}[${i}]`, true);
    }
    return { ...entry, cmd: interpolateString(entry.cmd, ctx, `${source}[${i}].cmd`, true) };
  });
}

export async function runDown(input: RunDownInput): Promise<RunDownResult> {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const outputMode: OutputMode = input.outputMode ?? "pretty";
  const output = createOutput({ mode: outputMode, stream: out, showTiming: true });
  const warnings: DownWarning[] = [];

  let worktree: Worktree;
  if (input.worktreeArg !== undefined && input.worktreeArg.length > 0) {
    try {
      const resolved = await resolveStackId({ cwd, worktreeArg: input.worktreeArg });
      const snap = resolved.snapshot ?? (await readSnapshot(resolved.stackId).catch(() => null));
      if (!snap) {
        writeLine(out, `no stack found with ID/name '${input.worktreeArg}'; try \`lich stacks\``);
        await output.close();
        return { exitCode: 1, warnings };
      }
      worktree = worktreeFromSnapshot(snap);
    } catch (err) {
      writeLine(out, `lich down: ${(err as Error).message}`);
      await output.close();
      return { exitCode: 1, warnings };
    }
  } else {
    try {
      worktree = detectWorktree(cwd);
    } catch {
      const fallback = await findWorktreeBySnapshot(cwd, { includeStoppedSandbox: input.purge === true });
      if (!fallback) {
        writeLine(out, `no stack found for this worktree: no lich.yaml and no matching snapshot`);
        await output.close();
        return { exitCode: 0, warnings };
      }
      worktree = fallback;
    }
  }

  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  if (snap === null) {
    writeLine(out, "no stack found for this worktree");
    await output.close();
    return { exitCode: 0, warnings };
  }

  if (shouldEarlyExitOnStopped(snap, input.purge)) {
    writeLine(out, `stack already stopped: ${worktree.stack_id}`);
    await output.close();
    return { exitCode: 0, warnings };
  }

  await output.close();
  const configPath = join(worktree.path, "lich.yaml");
  return (await pickExecutor(snap, { worktree, lichYamlPath: configPath })).down(input);
}

export async function runDownLocal(input: RunDownInput): Promise<RunDownResult> {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const outputMode: OutputMode = input.outputMode ?? "pretty";
  const output = createOutput({
    mode: outputMode,
    stream: out,
    showTiming: true,
  });
  const runStartedAtMs = Date.now();
  const warnings: DownWarning[] = [];

  let worktree: Worktree;
  if (input.worktreeArg !== undefined && input.worktreeArg.length > 0) {
    try {
      const resolved = await resolveStackId({ cwd, worktreeArg: input.worktreeArg });
      const snap = resolved.snapshot ?? (await readSnapshot(resolved.stackId).catch(() => null));
      if (!snap) {
        writeLine(out, `no stack found with ID/name '${input.worktreeArg}'; try \`lich stacks\``);
        await output.close();
        return { exitCode: 1, warnings };
      }
      worktree = worktreeFromSnapshot(snap);
    } catch (err) {
      writeLine(out, `lich down: ${(err as Error).message}`);
      await output.close();
      return { exitCode: 1, warnings };
    }
  } else {
    try {
      worktree = detectWorktree(cwd);
    } catch {
      // lich.yaml not found — try snapshot fallback (yaml may have been deleted after lich up).
      const fallback = await findWorktreeBySnapshot(cwd, { includeStoppedSandbox: input.purge === true });
      if (!fallback) {
        writeLine(out, `no stack found for this worktree: no lich.yaml and no matching snapshot`);
        await output.close();
        return { exitCode: 0, warnings };
      }
      worktree = fallback;
    }
  }

  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  if (snap === null) {
    writeLine(out, "no stack found for this worktree");
    await output.close();
    return { exitCode: 0, warnings };
  }

  if (shouldEarlyExitOnStopped(snap, input.purge)) {
    writeLine(out, `stack already stopped: ${worktree.stack_id}`);
    await output.close();
    return { exitCode: 0, warnings };
  }

  const configPath = join(worktree.path, "lich.yaml");

  // Detect whether this snapshot carries full teardown data (post-LEV-513).
  // New snapshots written by lich up have resolved_env on owned services and
  // stack-level before_down/after_down. Legacy snapshots fall back to yaml re-parsing.
  const hasFullTeardownData = snap.services.some(
    (s) => s.kind === "owned" && s.resolved_env !== undefined,
  ) || snap.before_down !== undefined || snap.after_down !== undefined;

  // Only parse lich.yaml when needed for legacy snapshot fallback.
  // Modern snapshots (hasFullTeardownData === true) skip the file read entirely.
  const needsParse = !hasFullTeardownData;
  const parsed = needsParse && existsSync(configPath) ? await parseConfig(configPath) : null;

  // Legacy fallback: re-parse yaml only when the snapshot lacks full teardown data.
  // New snapshots (post-LEV-513) never need this path; yaml edits between up and down are ignored.
  let config: LichConfig | null = null;
  if (!hasFullTeardownData) {
    if (parsed !== null) {
      if (parsed.ok) {
        config = parsed.config;
      } else {
        warnings.push({
          phase: "parse_config",
          message:
            "lich.yaml could not be parsed; proceeding with state-only teardown",
        });
      }
    } else {
      warnings.push({
        phase: "parse_config",
        message: "lich.yaml not found; proceeding with state-only teardown",
      });
    }
  }

  // Surface a coherent intermediate status to observers (lich stacks, dashboard).
  snap.status = "stopping";
  await writeSnapshot(snap).catch(() => {});

  // Reverse-topo order from yaml depends_on; falls back to reverse-snapshot order when yaml is missing.
  const teardownOrder = computeTeardownOrder(snap.services, config, warnings);

  const snapsByName = new Map(snap.services.map((s) => [s.name, s]));

  // Partition owned vs compose for presentation — two phase blocks with separate counters. Per-service before_down still interleaves with each stop.
  const ownedNames: string[] = [];
  const composeNames: string[] = [];
  for (const name of teardownOrder) {
    const svcSnap = snapsByName.get(name);
    if (!svcSnap) continue;
    if (svcSnap.kind === "owned") ownedNames.push(name);
    else if (svcSnap.kind === "compose") composeNames.push(name);
  }

  // Compute once before teardown loops so per-service lifecycle hooks + stop_cmd can interpolate ports.
  const snapAllocatedPorts = rebuildAllocatedPorts(snap);

  // Per-compose-service teardown is issued individually for ordering, then a single project-level
  // `down -v` at the end sweeps the volumes + network.
  let composeRan = false;

  if (ownedNames.length > 0) {
    // One phase for the entire owned-services teardown — spinner updates as each service ticks through.
    const ownedPhase = output.phase(
      formatOwnedPhaseName({ current: 1, total: ownedNames.length, service: ownedNames[0]! }),
    );
    let ownedIdx = 0;
    let ownedFailed = false;
    try {
      for (const name of ownedNames) {
        ownedIdx++;
        // Initial phase(...) already painted (1/N); skip the redundant update for tidiness in json mode.
        if (ownedIdx > 1) {
          ownedPhase.update(
            formatOwnedPhaseName({
              current: ownedIdx,
              total: ownedNames.length,
              service: name,
            }),
          );
        }

        const svcSnap = snapsByName.get(name);
        if (!svcSnap) continue;

        // Prefer snapshot before_down entries (post-LEV-513); fall back to yaml for legacy snapshots.
        const ownedBeforeDownEntries: import("../lifecycle/per-service.js").LifecycleEntry[] =
          svcSnap.before_down !== undefined
            ? svcSnap.before_down.map((e) => e.cmd)
            : (config?.owned?.[name]?.lifecycle?.before_down ?? []);
        if (ownedBeforeDownEntries.length > 0) {
          const ownedBeforeDownEnv =
            svcSnap.before_down !== undefined
              ? (svcSnap.before_down[0]?.env ?? process.env)
              : process.env;
          if (svcSnap.before_down !== undefined) {
            await runPerServiceLifecycle(
              {
                serviceName: name,
                phase: "before_down",
                entries: ownedBeforeDownEntries,
                cwd: worktree.path,
                env: ownedBeforeDownEnv,
              },
              (w) => {
                warnings.push({
                  service: name,
                  phase: "before_down",
                  message: `entry #${w.index} exited ${w.exitCode}: ${w.cmd}`,
                });
              },
            ).catch((err) => {
              warnings.push({
                service: name,
                phase: "before_down",
                message: errorMessage(err),
              });
            });
          } else {
            const perSvcCtx = buildDownInterpCtx(worktree, snapAllocatedPorts);
            await runPerServiceLifecycle(
              {
                serviceName: name,
                phase: "before_down",
                entries: interpolateDownLifecycleEntries(ownedBeforeDownEntries, perSvcCtx, `owned.${name}.lifecycle.before_down`),
                cwd: worktree.path,
                env: process.env,
              },
              (w) => {
                warnings.push({
                  service: name,
                  phase: "before_down",
                  message: `entry #${w.index} exited ${w.exitCode}: ${w.cmd}`,
                });
              },
            ).catch((err) => {
              warnings.push({
                service: name,
                phase: "before_down",
                message: errorMessage(err),
              });
            });
          }
        }

        // No explicit LogTail teardown — see top-of-file LogTail docblock.
        const ownedDef = config?.owned?.[name];
        try {
          const stopResult = await stopOwnedService(
            name,
            svcSnap.pid,
            svcSnap,
            ownedDef,
            worktree,
            config,
            snap,
            input.signal,
          );
          for (const w of stopResult.warnings) {
            warnings.push({
              service: name,
              phase: "stop_owned",
              message: w,
            });
          }
          if (stopResult.info) {
            // output.info clears the spinner line and re-paints — keeps the per-service block clean.
            output.info(`info: [${name}] ${stopResult.info}`);
          }
        } catch (err) {
          ownedFailed = true;
          warnings.push({
            service: name,
            phase: "stop_owned",
            message: errorMessage(err),
          });
        }

        svcSnap.state = "stopped";
      }
    } finally {
      // Best-effort: never mark the phase failed even if a service threw — warnings carry the diagnostic.
      void ownedFailed;
      ownedPhase.end(
        "ok",
        `${formatCompletedLabel("stopped owned services", ownedNames.length)}`,
      );
    }
  }

  // Determine before_down / after_down entries.
  // New snapshots (post-LEV-513): snap.before_down/after_down carry pre-resolved envs — no yaml needed.
  // Legacy snapshots: fall back to yaml-derived entries + reconstructed lifecycleEnv.
  const snapshotHasStackHooks = snap.before_down !== undefined || snap.after_down !== undefined;

  let legacyLifecycleEnv: NodeJS.ProcessEnv = process.env;
  let legacyLifecycleResolveEnvGroup:
    | ((name: string) => Promise<NodeJS.ProcessEnv>)
    | undefined = undefined;
  let legacyAllocatedPortsForLifecycle: AllocatedPorts = { compose: {}, owned: {} };
  let legacyBeforeDownEntries: LifecycleEntry[] = [];
  let legacyAfterDownEntries: LifecycleEntry[] = [];

  if (!snapshotHasStackHooks && config) {
    let resolvedProfileForDown: ReturnType<typeof resolveProfile> | null = null;
    if (snap.active_profile) {
      if (config.profiles?.[snap.active_profile]) {
        try {
          resolvedProfileForDown = resolveProfile(snap.active_profile, config);
        } catch (err) {
          warnings.push({
            phase: "profile_resolve",
            message: `failed to resolve profile "${snap.active_profile}" for before_down/after_down: ${errorMessage(err)}; proceeding with top-level entries only`,
          });
        }
      } else {
        warnings.push({
          phase: "profile_resolve",
          message: `active profile "${snap.active_profile}" recorded in state.json is no longer declared in lich.yaml; proceeding with top-level before_down/after_down entries only`,
        });
      }
    }

    legacyAllocatedPortsForLifecycle = snapAllocatedPorts;
    try {
      const topLevelEnv = await resolveTopLevelEnv({
        config,
        worktree,
        allocatedPorts: legacyAllocatedPortsForLifecycle,
        projectRoot: worktree.path,
        profile: resolvedProfileForDown ?? undefined,
      });
      let enrichedEnv: NodeJS.ProcessEnv = { ...topLevelEnv };
      for (const svcSnap of snap.services) {
        if (svcSnap.kind !== "owned") continue;
        const ownedDef = config.owned?.[svcSnap.name];
        if (!ownedDef) continue;
        enrichedEnv = injectOwnedPortEnv(
          enrichedEnv,
          ownedDef,
          svcSnap.allocated_ports,
        );
      }
      legacyLifecycleEnv = enrichedEnv;
    } catch (err) {
      warnings.push({
        phase: "lifecycle_env",
        message: `failed to reconstruct lifecycle env from state.json (${errorMessage(err)}); before_down/after_down will run with bare process.env`,
      });
    }

    legacyLifecycleResolveEnvGroup = (name: string): Promise<NodeJS.ProcessEnv> =>
      resolveEnvGroup({
        name,
        config,
        worktree,
        allocatedPorts: legacyAllocatedPortsForLifecycle,
        projectRoot: worktree.path,
        profile: resolvedProfileForDown ?? undefined,
      });

    if (resolvedProfileForDown) {
      legacyBeforeDownEntries.push(...resolvedProfileForDown.lifecycle.before_down);
      legacyAfterDownEntries.push(...resolvedProfileForDown.lifecycle.after_down);
    }
    if (config.lifecycle?.before_down && config.lifecycle.before_down.length > 0) {
      legacyBeforeDownEntries.push(...config.lifecycle.before_down);
    }
    if (config.lifecycle?.after_down && config.lifecycle.after_down.length > 0) {
      legacyAfterDownEntries.push(...config.lifecycle.after_down);
    }
  }

  const hasBeforeDown = snapshotHasStackHooks
    ? (snap.before_down?.length ?? 0) > 0
    : legacyBeforeDownEntries.length > 0;

  const lifecycleStatus: LifecycleSnapshotStatus = { ...(snap.lifecycle ?? {}) };

  if (hasBeforeDown) {
    const entryCount = snapshotHasStackHooks
      ? snap.before_down!.length
      : legacyBeforeDownEntries.length;
    const beforeDownPhase = output.phase(
      formatHooksPhaseName({
        verb: "running",
        which: "before_down",
        current: 1,
        total: entryCount,
      }),
    );
    const beforeDownLogPath = phaseLogPath(worktree.stack_id, "before_down");
    let beforeDownFailure: { index: number; cmd: string } | null = null;
    try {
      if (snapshotHasStackHooks) {
        await runSnapshotLifecycle(
          "before_down",
          snap.before_down!,
          worktree.path,
          beforeDownLogPath,
          (w) => warnings.push({ phase: "before_down", message: w }),
          (start) => output.lifecycleEntryStart(start),
          (completion) => {
            output.lifecycleEntryComplete(completion);
            if (completion.exitCode !== 0 && beforeDownFailure === null) {
              beforeDownFailure = { index: completion.index, cmd: completion.cmd };
            }
          },
        );
      } else {
        const beforeDownCtx = buildDownInterpCtx(worktree, legacyAllocatedPortsForLifecycle);
        await runLifecycle(
          {
            phase: "before_down",
            entries: interpolateDownLifecycleEntries(legacyBeforeDownEntries, beforeDownCtx, "lifecycle.before_down"),
            cwd: worktree.path,
            env: legacyLifecycleEnv,
            resolveEnvGroup: legacyLifecycleResolveEnvGroup,
            logPath: beforeDownLogPath,
          },
          {
            onWarning: (w) => {
              warnings.push({
                phase: "before_down",
                message: `entry #${w.index} exited ${w.exitCode}: ${w.cmd}`,
              });
              if (beforeDownFailure === null) {
                beforeDownFailure = { index: w.index, cmd: w.cmd };
              }
            },
            onEntryStart: (start) => output.lifecycleEntryStart(start),
            onEntryComplete: (completion) => output.lifecycleEntryComplete(completion),
          },
        ).catch((err) => {
          warnings.push({ phase: "before_down", message: errorMessage(err) });
        });
      }
    } finally {
      beforeDownPhase.end("ok", "hooks done");
    }
    if (beforeDownFailure !== null) {
      const f = beforeDownFailure as { index: number; cmd: string };
      lifecycleStatus.before_down = {
        status: "failed",
        failed_index: f.index,
        total: entryCount,
        failed_cmd: truncateFailedCmd(f.cmd),
        log_path: beforeDownLogPath,
      };
    } else {
      lifecycleStatus.before_down = { status: "ok" };
    }
  }

  if (composeNames.length > 0) {
    // One phase for the whole compose teardown. Per-service spinner is presentation; actual container removal is a single project-scoped `down -v` after the last service.
    const composePhase = output.phase(
      formatComposePhaseName({
        current: 1,
        total: composeNames.length,
        service: composeNames[0]!,
      }),
    );
    let composeIdx = 0;
    try {
      for (const name of composeNames) {
        composeIdx++;
        if (composeIdx > 1) {
          composePhase.update(
            formatComposePhaseName({
              current: composeIdx,
              total: composeNames.length,
              service: name,
            }),
          );
        }

        const svcSnap = snapsByName.get(name);
        if (!svcSnap) continue;

        // Prefer snapshot before_down entries (post-LEV-513); fall back to yaml for legacy snapshots.
        const composeBeforeDownEntries: import("../lifecycle/per-service.js").LifecycleEntry[] =
          svcSnap.before_down !== undefined
            ? svcSnap.before_down.map((e) => e.cmd)
            : (config?.services?.[name]?.lifecycle?.before_down ?? []);
        if (composeBeforeDownEntries.length > 0) {
          if (svcSnap.before_down !== undefined) {
            await runPerServiceLifecycle(
              {
                serviceName: name,
                phase: "before_down",
                entries: composeBeforeDownEntries,
                cwd: worktree.path,
                env: process.env,
              },
              (w) => {
                warnings.push({
                  service: name,
                  phase: "before_down",
                  message: `entry #${w.index} exited ${w.exitCode}: ${w.cmd}`,
                });
              },
            ).catch((err) => {
              warnings.push({
                service: name,
                phase: "before_down",
                message: errorMessage(err),
              });
            });
          } else {
            const composeSvcCtx = buildDownInterpCtx(worktree, snapAllocatedPorts);
            await runPerServiceLifecycle(
              {
                serviceName: name,
                phase: "before_down",
                entries: interpolateDownLifecycleEntries(composeBeforeDownEntries, composeSvcCtx, `services.${name}.lifecycle.before_down`),
                cwd: worktree.path,
                env: process.env,
              },
              (w) => {
                warnings.push({
                  service: name,
                  phase: "before_down",
                  message: `entry #${w.index} exited ${w.exitCode}: ${w.cmd}`,
                });
              },
            ).catch((err) => {
              warnings.push({
                service: name,
                phase: "before_down",
                message: errorMessage(err),
              });
            });
          }
        }

        composeRan = true;
        svcSnap.state = "stopped";
      }

      // Project-scoped `compose down -v` — per-service `down <name>` doesn't remove networks/volumes.
      if (composeRan) {
        try {
          const composeResult = await tearDownCompose(worktree);
          for (const w of composeResult.warnings) {
            warnings.push({ phase: "compose_down", message: w });
          }
        } catch (err) {
          warnings.push({
            phase: "compose_down",
            message: errorMessage(err),
          });
        }
      }
    } finally {
      composePhase.end(
        "ok",
        `${formatCompletedLabel("stopped compose services", composeNames.length)}`,
      );
    }
  }

  const hasAfterDown = snapshotHasStackHooks
    ? (snap.after_down?.length ?? 0) > 0
    : legacyAfterDownEntries.length > 0;

  if (hasAfterDown) {
    const entryCount = snapshotHasStackHooks
      ? snap.after_down!.length
      : legacyAfterDownEntries.length;
    const afterDownPhase = output.phase(
      formatHooksPhaseName({
        verb: "running",
        which: "after_down",
        current: 1,
        total: entryCount,
      }),
    );
    const afterDownLogPath = phaseLogPath(worktree.stack_id, "after_down");
    let afterDownFailure: { index: number; cmd: string } | null = null;
    try {
      if (snapshotHasStackHooks) {
        await runSnapshotLifecycle(
          "after_down",
          snap.after_down!,
          worktree.path,
          afterDownLogPath,
          (w) => warnings.push({ phase: "after_down", message: w }),
          (start) => output.lifecycleEntryStart(start),
          (completion) => {
            output.lifecycleEntryComplete(completion);
            if (completion.exitCode !== 0 && afterDownFailure === null) {
              afterDownFailure = { index: completion.index, cmd: completion.cmd };
            }
          },
        );
      } else {
        const afterDownCtx = buildDownInterpCtx(worktree, legacyAllocatedPortsForLifecycle);
        await runLifecycle(
          {
            phase: "after_down",
            entries: interpolateDownLifecycleEntries(legacyAfterDownEntries, afterDownCtx, "lifecycle.after_down"),
            cwd: worktree.path,
            env: legacyLifecycleEnv,
            resolveEnvGroup: legacyLifecycleResolveEnvGroup,
            logPath: afterDownLogPath,
          },
          {
            onWarning: (w) => {
              warnings.push({
                phase: "after_down",
                message: `entry #${w.index} exited ${w.exitCode}: ${w.cmd}`,
              });
              if (afterDownFailure === null) {
                afterDownFailure = { index: w.index, cmd: w.cmd };
              }
            },
            onEntryStart: (start) => output.lifecycleEntryStart(start),
            onEntryComplete: (completion) => output.lifecycleEntryComplete(completion),
          },
        ).catch((err) => {
          warnings.push({ phase: "after_down", message: errorMessage(err) });
        });
      }
    } finally {
      afterDownPhase.end("ok", "hooks done");
    }
    if (afterDownFailure !== null) {
      const f = afterDownFailure as { index: number; cmd: string };
      lifecycleStatus.after_down = {
        status: "failed",
        failed_index: f.index,
        total: entryCount,
        failed_cmd: truncateFailedCmd(f.cmd),
        log_path: afterDownLogPath,
      };
    } else {
      lifecycleStatus.after_down = { status: "ok" };
    }
  }

  try {
    await release(worktree.stack_id);
  } catch (err) {
    warnings.push({
      phase: "release_ports",
      message: errorMessage(err),
    });
  }

  snap.status = "stopped";
  // `routing: []` (NOT undefined) is the unambiguous "actively cleared" signal — undefined would mean "never declared routes".
  // The proxy filters by status anyway, but the explicit clear keeps state.json honest within one watcher tick.
  snap.routing = [];
  if (Object.keys(lifecycleStatus).length > 0) {
    snap.lifecycle = lifecycleStatus;
  }
  await writeSnapshot(snap).catch((err) => {
    warnings.push({
      phase: "persist_state",
      message: errorMessage(err),
    });
  });

  const totalMs = Date.now() - runStartedAtMs;
  output.summary({
    title: `stack down: ${worktree.stack_id}`,
    elapsedMs: totalMs,
    lines: [],
  });
  if (warnings.length > 0) {
    // Plain-line writes — the warning block's multi-line shape is pinned by tests.
    writeLine(out, `${warnings.length} warning(s) during teardown:`);
    for (const w of warnings) {
      const svcTag = w.service ? `[${w.service}] ` : "";
      writeLine(out, `  - ${svcTag}${w.phase}: ${w.message}`);
    }
  }

  await output.close();

  // Reference stackDir to silence tree-shake.
  void stackDir;

  return { exitCode: 0, warnings };
}

interface StopOwnedResult {
  warnings: string[];
  /** Info-level note like "stop_cmd took N.Ns". Not a warning. */
  info?: string;
}

/**
 * Stop one owned service: stop_cmd if declared, else SIGTERM the recorded PID and escalate to SIGKILL after SIGTERM_GRACE_MS.
 * Idempotent on dead/missing PIDs. If `signal` fires during the grace window we escalate immediately so Ctrl-C makes progress per-service.
 * Never throws on per-service problems — reports them via warnings so the surrounding loop continues.
 */
async function stopOwnedService(
  name: string,
  pid: number | undefined,
  svcSnap: import("../state/snapshot.js").ServiceSnapshot,
  ownedDef: OwnedService | undefined,
  worktree: Worktree,
  config: LichConfig | null,
  snapshot: StackSnapshot,
  signal?: AbortSignal,
): Promise<StopOwnedResult> {
  const warnings: string[] = [];
  let info: string | undefined;

  // Prefer snapshotted stop_cmd; fall back to yaml for legacy snapshots.
  const stopCmd = svcSnap.stop_cmd ?? ownedDef?.stop_cmd;

  // Snapshotted owned_containers wins; legacy fallback interpolates from yaml.
  const ownedContainers = await resolveOwnedContainersForDown(
    name,
    svcSnap,
    ownedDef,
    worktree,
    snapshot,
  );

  // stop_cmd takes priority — used by self-managing tools (e.g. supabase).
  if (stopCmd) {
    let stopEnv: NodeJS.ProcessEnv;
    if (svcSnap.resolved_env !== undefined) {
      // New snapshot: use the fully resolved env from up time — no yaml re-parse needed.
      stopEnv = svcSnap.resolved_env;
    } else if (config) {
      // Legacy snapshot: reconstruct env from yaml (old behavior).
      const allocatedPortsForStop = rebuildAllocatedPorts(snapshot);
      try {
        stopEnv = await resolveEnvForService({
          config,
          service: { kind: "owned", name },
          worktree,
          allocatedPorts: allocatedPortsForStop,
          projectRoot: worktree.path,
        });
      } catch {
        stopEnv = process.env;
      }
      stopEnv = injectOwnedPortEnv(stopEnv, ownedDef, svcSnap.allocated_ports);
      // Interpolate ${...} refs in stop_cmd using the same port context used for env.
      const allocatedPortsForInterp = rebuildAllocatedPorts(snapshot);
      let resolvedStopCmdLegacy = stopCmd;
      try {
        resolvedStopCmdLegacy = interpolateString(
          stopCmd,
          buildDownInterpCtx(worktree, allocatedPortsForInterp),
          `owned.${name}.stop_cmd`,
          true,
        );
      } catch {
        // Best-effort: unresolved refs fall back to the raw string.
      }
      const result = await runStopCmd(resolvedStopCmdLegacy, worktree.path, stopEnv);
      if (result.timedOut) {
        const tail = formatStderrTail(result.stderrTail);
        const tailSection = tail ? ` stderr tail: "${tail}"` : "";
        warnings.push(`stop_cmd exceeded ${STOP_CMD_TIMEOUT_MS}ms timeout and was SIGKILL'd;${tailSection}`);
      } else if (typeof result.exitCode === "number" && result.exitCode !== 0) {
        const tail = formatStderrTail(result.stderrTail);
        const tailSection = tail ? ` stderr tail: "${tail}"` : "";
        warnings.push(`stop_cmd exited ${result.exitCode};${tailSection}`);
      } else if (result.exitCode === null && !result.timedOut) {
        const tail = formatStderrTail(result.stderrTail);
        const tailSection = tail ? ` stderr tail: "${tail}"` : "";
        warnings.push(`stop_cmd terminated abnormally (no exit code);${tailSection}`);
      } else if (result.durationMs > STOP_CMD_SLOW_MS) {
        const seconds = (result.durationMs / 1000).toFixed(1);
        info = `stop_cmd took ${seconds}s — verify resources are actually gone`;
      }
      await runOwnedContainersSweep(ownedContainers, warnings);
      return { warnings, info };
    } else {
      stopEnv = process.env;
    }
    const result = await runStopCmd(stopCmd, worktree.path, stopEnv);
    if (result.timedOut) {
      const tail = formatStderrTail(result.stderrTail);
      const tailSection = tail ? ` stderr tail: "${tail}"` : "";
      warnings.push(
        `stop_cmd exceeded ${STOP_CMD_TIMEOUT_MS}ms timeout and was SIGKILL'd;${tailSection}`,
      );
    } else if (typeof result.exitCode === "number" && result.exitCode !== 0) {
      const tail = formatStderrTail(result.stderrTail);
      const tailSection = tail ? ` stderr tail: "${tail}"` : "";
      warnings.push(
        `stop_cmd exited ${result.exitCode};${tailSection}`,
      );
    } else if (result.exitCode === null && !result.timedOut) {
      const tail = formatStderrTail(result.stderrTail);
      const tailSection = tail ? ` stderr tail: "${tail}"` : "";
      warnings.push(
        `stop_cmd terminated abnormally (no exit code);${tailSection}`,
      );
    } else if (result.durationMs > STOP_CMD_SLOW_MS) {
      const seconds = (result.durationMs / 1000).toFixed(1);
      info = `stop_cmd took ${seconds}s — verify resources are actually gone`;
    }
    await runOwnedContainersSweep(ownedContainers, warnings);
    return { warnings, info };
  }

  // No stop_cmd, but a sweep filter is still useful — long-lived owned services
  // can declare `owned_containers` to clean up sidecar containers.
  await runOwnedContainersSweep(ownedContainers, warnings);

  if (typeof pid !== "number") return { warnings };
  if (!isAlive(pid)) return { warnings };

  // The supervisor spawns with detached:true so pid==pgid and grandchildren share the group;
  // `kill(-pid, SIG)` delivers atomically to the whole tree (`bun run dev` → `next-server` etc.).
  try {
    signalGroup(pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return { warnings };
    throw err;
  }

  // Poll for graceful exit; if `signal` fires we break and SIGKILL immediately.
  const startMs = Date.now();
  while (Date.now() - startMs < SIGTERM_GRACE_MS) {
    if (!isAlive(pid) && survivors(pid).length === 0) {
      return { warnings };
    }
    if (signal?.aborted) break;
    await sleep(POLL_INTERVAL_MS);
  }

  try {
    signalGroup(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return { warnings };
    throw err;
  }

  // Bounded confirmation poll — kernel reaps quickly post-SIGKILL.
  const killStartMs = Date.now();
  while (Date.now() - killStartMs < 1_000) {
    if (!isAlive(pid) && survivors(pid).length === 0) {
      return { warnings };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  // Lingering survivors after SIGKILL + grace are pathological (D-state, zombie, container/pid mismatch) but surface honestly.
  const lingering = survivors(pid);
  if (lingering.length > 0) {
    warnings.push(
      `pid(s) ${lingering.join(", ")} still alive after SIGKILL + 1s grace; service "${name}" may still be running`,
    );
  }
  return { warnings };
}

/**
 * Resolve the post-stop_cmd container sweep filter for one owned service.
 * Snapshot wins (post-LEV-534); legacy fallback interpolates from yaml.
 * Best-effort — interpolation failures swallow to the un-interpolated string.
 */
async function resolveOwnedContainersForDown(
  name: string,
  svcSnap: import("../state/snapshot.js").ServiceSnapshot,
  ownedDef: OwnedService | undefined,
  worktree: Worktree,
  snapshot: StackSnapshot,
): Promise<{ label?: string; name_pattern?: string } | undefined> {
  if (svcSnap.owned_containers !== undefined) return svcSnap.owned_containers;
  if (!ownedDef?.owned_containers) return undefined;
  const allocatedPortsForInterp = rebuildAllocatedPorts(snapshot);
  const ctx = buildDownInterpCtx(worktree, allocatedPortsForInterp);
  const oc: { label?: string; name_pattern?: string } = {};
  if (ownedDef.owned_containers.label !== undefined) {
    try {
      oc.label = interpolateString(
        ownedDef.owned_containers.label,
        ctx,
        `owned.${name}.owned_containers.label`,
        true,
      );
    } catch {
      oc.label = ownedDef.owned_containers.label;
    }
  }
  if (ownedDef.owned_containers.name_pattern !== undefined) {
    try {
      oc.name_pattern = interpolateString(
        ownedDef.owned_containers.name_pattern,
        ctx,
        `owned.${name}.owned_containers.name_pattern`,
        true,
      );
    } catch {
      oc.name_pattern = ownedDef.owned_containers.name_pattern;
    }
  }
  return oc;
}

/** Run the sweep + pipe its outcome through the warnings collector. No-op on undefined spec. */
async function runOwnedContainersSweep(
  spec: { label?: string; name_pattern?: string } | undefined,
  warnings: string[],
): Promise<void> {
  if (!spec) return;
  let cli;
  try {
    cli = await resolveComposeCli(undefined);
  } catch (err) {
    warnings.push(
      `owned_containers sweep: no compose CLI available (${errorMessage(err)})`,
    );
    return;
  }
  const result = await sweepOwnedContainers(cli.cmd, spec);
  if (result.removed.length > 0) {
    const filterDesc = spec.label !== undefined ? `label=${spec.label}` : `name=${spec.name_pattern}`;
    warnings.push(
      `owned_containers sweep removed ${result.removed.length} straggler container(s) matching ${filterDesc} (stop_cmd missed them): ${result.removed.join(", ")}`,
    );
  }
  if (result.stragglers.length > 0) {
    const filterDesc = spec.label !== undefined ? `label=${spec.label}` : `name=${spec.name_pattern}`;
    warnings.push(
      `owned_containers sweep: ${result.stragglers.length} container(s) matching ${filterDesc} still present after \`${cli.cmd} rm -f\`: ${result.stragglers.join(", ")}`,
    );
  }
}

interface StopCmdResult {
  /** Exit code; null if killed by signal (timeout). */
  exitCode: number | null;
  stderrTail: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Run the user's stop_cmd via /bin/sh -c, bounded by STOP_CMD_TIMEOUT_MS.
 * Captures stderr in a ring buffer capped at STOP_CMD_STDERR_RING_BYTES so a chatty teardown can't balloon the warning.
 * Non-zero exits aren't thrown — caller decides whether to surface them.
 */
async function runStopCmd(
  stopCmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<StopCmdResult> {
  return new Promise<StopCmdResult>((resolve) => {
    const startMs = Date.now();
    const child = spawn("/bin/sh", ["-c", stopCmd], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text =
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrBuf += text;
      if (stderrBuf.length > STOP_CMD_STDERR_RING_BYTES) {
        stderrBuf = stderrBuf.slice(-STOP_CMD_STDERR_RING_BYTES);
      }
    });
    // Drain stdout so the child doesn't block on a full pipe.
    child.stdout?.on("data", () => {});

    let settled = false;
    let timedOut = false;
    let exitCode: number | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        stderrTail: stderrBuf,
        durationMs: Date.now() - startMs,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (typeof child.pid === "number") {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      finish();
    }, STOP_CMD_TIMEOUT_MS);

    child.once("exit", (code) => {
      clearTimeout(timer);
      exitCode = code;
      finish();
    });
    child.once("error", () => {
      clearTimeout(timer);
      // Spawn-level failure (ENOENT etc.).
      exitCode = null;
      finish();
    });
  });
}

/** Compact a stderr tail into a single-line warning. */
function formatStderrTail(tail: string): string {
  return tail.replace(/\s+/g, " ").trim();
}

interface ComposeTeardownResult {
  warnings: string[];
}

/**
 * `<cli> compose -p lich-<stack_id> down -v` then verify the project emptied. Force-removes survivors, warns on whatever's still alive.
 * Intentionally no `--remove-orphans` — that's nuke-tier behavior, not down.
 */
async function tearDownCompose(
  worktree: Worktree,
): Promise<ComposeTeardownResult> {
  const cli = await resolveComposeCli(undefined);
  const project = `lich-${worktree.stack_id}`;

  // Pass NO `-f` files — compose finds containers via the project label alone.
  // Passing the per-stack override file caused "no image nor build context" failures for stacks where the override only has ports + env
  // (compose validates the assembled project before tearing down, and an override-only project is invalid). Project-label-only sidesteps that.
  const ctx: RunnerCtx = {
    cli,
    project,
    files: [],
    cwd: worktree.path,
  };

  // composeDown surfaces non-zero exits via warnings; spawn-level failures throw here.
  await composeDown(ctx, { volumes: true, remove_orphans: false });

  return verifyComposeTeardown(ctx);
}

/**
 * Verify the compose project is empty after `down` — `compose ps -q` lists survivors, attempt a force-remove, re-check.
 * Two warning shapes: salvage-failed (containers still alive) and salvage-worked (soft warning so the user knows compose itself had trouble).
 */
async function verifyComposeTeardown(
  ctx: RunnerCtx,
): Promise<ComposeTeardownResult> {
  const warnings: string[] = [];

  const remaining = await composePsQ(ctx);
  if (remaining.length === 0) return { warnings };

  for (const id of remaining) {
    await forceRemoveContainer(ctx.cli.cmd, id);
  }

  const stillAlive = await composePsQ(ctx);
  if (stillAlive.length > 0) {
    warnings.push(
      `compose teardown could not fully remove project "${ctx.project}"; ${stillAlive.length} container(s) still alive after force-remove: ${stillAlive.join(", ")}`,
    );
  } else {
    warnings.push(
      `compose down left ${remaining.length} container(s) running for project "${ctx.project}"; force-removed via ${ctx.cli.cmd} rm -f`,
    );
  }
  return { warnings };
}

/** `<cli> compose -p <project> -f <file>... ps -q` → list of container IDs. Empty list = project is empty. */
async function composePsQ(ctx: RunnerCtx): Promise<string[]> {
  const args: string[] = [...ctx.cli.args, "-p", ctx.project];
  for (const f of ctx.files) {
    args.push("-f", f);
  }
  args.push("ps", "-q");
  const result = await composeExec.current(ctx.cli.cmd, args, {
    cwd: ctx.cwd,
    env: ctx.env,
  }).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `<cli> rm -f <id>`. Best-effort — the re-check in verifyComposeTeardown is the source of truth. */
async function forceRemoveContainer(cli: string, id: string): Promise<void> {
  await composeExec.current(cli, ["rm", "-f", id], {}).catch(() => {
    /* best-effort */
  });
}

function computeTeardownOrder(
  serviceSnaps: Array<{ name: string; kind: "compose" | "owned"; depends_on?: string[] }>,
  config: LichConfig | null,
  warnings: DownWarning[],
): string[] {
  // Use snapshot depends_on if all services carry it (post-LEV-513 snapshots).
  const allHaveDepsOnSnapshot = serviceSnaps.every((s) => s.depends_on !== undefined);

  if (allHaveDepsOnSnapshot) {
    const sourceDecls: NodeDecl[] = serviceSnaps.map((s) => ({
      name: s.name,
      kind: s.kind,
      depends_on: s.depends_on!,
    }));
    try {
      const graph = buildGraph(sourceDecls);
      return shutdownOrder(graph);
    } catch (err) {
      if (err instanceof CycleError) {
        warnings.push({
          phase: "compute_order",
          message: `cycle in depends_on (${err.cycle.join(" → ")}); using snapshot order`,
        });
      } else {
        warnings.push({
          phase: "compute_order",
          message: `failed to compute teardown order: ${errorMessage(err)}; using snapshot order`,
        });
      }
      return [...serviceSnaps].reverse().map((s) => s.name);
    }
  }

  // Legacy fallback: use yaml depends_on.
  if (!config) {
    return [...serviceSnaps].reverse().map((s) => s.name);
  }

  const decls: NodeDecl[] = [];
  for (const [name, def] of Object.entries(config.services ?? {})) {
    decls.push({ name, kind: "compose", depends_on: def?.depends_on ?? [] });
  }
  for (const [name, def] of Object.entries(config.owned ?? {})) {
    decls.push({ name, kind: "owned", depends_on: def?.depends_on ?? [] });
  }

  try {
    const graph = buildGraph(decls);
    const order = shutdownOrder(graph);
    // Services in snapshot but not in current yaml — still tear them down, just at the end.
    const inOrder = new Set(order);
    const extras = serviceSnaps
      .map((s) => s.name)
      .filter((n) => !inOrder.has(n));
    return [...order, ...extras.reverse()];
  } catch (err) {
    if (err instanceof CycleError) {
      warnings.push({
        phase: "compute_order",
        message: `cycle in depends_on (${err.cycle.join(" → ")}); using snapshot order`,
      });
    } else {
      warnings.push({
        phase: "compute_order",
        message: `failed to compute teardown order: ${errorMessage(err)}; using snapshot order`,
      });
    }
    return [...serviceSnaps].reverse().map((s) => s.name);
  }
}

async function runSnapshotLifecycle(
  phase: "before_down" | "after_down",
  entries: SnapshotLifecycleEntry[],
  cwd: string,
  logPath: string,
  onWarning: (msg: string) => void,
  onEntryStart: (s: import("../lifecycle/executor.js").LifecycleEntryStart) => void,
  onEntryComplete: (c: import("../lifecycle/executor.js").LifecycleEntryCompletion) => void,
): Promise<void> {
  const total = entries.length;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    onEntryStart({ phase, index, total, cmd: entry.cmd });
    await runLifecycle(
      {
        phase,
        entries: [entry.cmd],
        cwd,
        env: entry.env,
        logPath,
      },
      {
        onWarning: (w) => {
          onWarning(`entry #${w.index} exited ${w.exitCode}: ${w.cmd}`);
        },
        onEntryComplete: (c) => {
          onEntryComplete({ ...c, index, total });
        },
      },
    ).catch((err) => {
      onWarning(errorMessage(err));
    });
  }
}

function worktreeFromSnapshot(snap: StackSnapshot): Worktree {
  const path = snap.worktree_path;
  const name = sanitizeName(snap.worktree_name);
  const id = hashPath(path);
  return { name, id, path, stack_id: snap.stack_id };
}

async function findWorktreeBySnapshot(
  cwd: string,
  opts: { includeStoppedSandbox?: boolean } = {},
): Promise<Worktree | null> {
  const { realpathSync, existsSync: fsExists } = await import("node:fs");
  const { hashPath, sanitizeName } = await import("../worktree/detect.js");
  const { basename } = await import("node:path");

  const safeReal = (p: string): string => {
    try { return realpathSync(p); } catch { return p; }
  };
  const cwdReal = safeReal(cwd);

  const stackIds = await listStacks();
  for (const stackId of stackIds) {
    const snap = await readSnapshot(stackId).catch(() => null);
    if (!snap) continue;
    if (snap.status === "stopped") {
      // A stopped non-sandbox stack has nothing left to reach in the OS;
      // a stopped sandbox stack may still own a VM that --purge needs to destroy.
      if (!(opts.includeStoppedSandbox && snap.sandbox === true)) continue;
    }

    const snapPath = safeReal(snap.worktree_path);
    if (!cwdReal.startsWith(snapPath)) continue;

    const name = sanitizeName(basename(snapPath));
    const id = hashPath(snapPath);
    return { name, id, path: snapPath, stack_id: `${name}-${id.slice(0, 8)}` };
  }
  return null;
}

interface OwnedPhaseInput {
  current: number;
  total: number;
  service: string;
}

function formatOwnedPhaseName(input: OwnedPhaseInput): string {
  return `down: stopping owned services (${input.current}/${input.total}: ${input.service})`;
}

interface ComposePhaseInput {
  current: number;
  total: number;
  service: string;
}

function formatComposePhaseName(input: ComposePhaseInput): string {
  return `down: stopping compose services (${input.current}/${input.total}: ${input.service})`;
}

interface HooksPhaseInput {
  verb: "running";
  which: "before_down" | "after_down";
  current: number;
  total: number;
}

function formatHooksPhaseName(input: HooksPhaseInput): string {
  return `down: ${input.verb} ${input.which} hooks (${input.current}/${input.total})`;
}

function formatCompletedLabel(label: string, total: number): string {
  return `${label} (${total}/${total})`;
}

/** Liveness probe via signal 0. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLine(out: NodeJS.WritableStream, text: string): void {
  out.write(`${text}\n`);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
