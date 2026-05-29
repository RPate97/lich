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
import { detectWorktree, type Worktree } from "../worktree/detect.js";
import { release } from "../ports/allocator.js";
import {
  readSnapshot,
  rebuildAllocatedPorts,
  injectOwnedPortEnv,
  writeSnapshot,
  type AllocatedPorts,
  type StackSnapshot,
} from "../state/snapshot.js";
import {
  interpolateString,
  type InterpolationContext,
} from "../config/interpolation.js";
import { hooksDir, stackDir } from "../state/directory.js";
import { resolveComposeCli } from "../compose/detect.js";
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

export interface RunDownInput {
  cwd?: string;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  outputMode?: OutputMode;
  /** When fired, short-circuits SIGTERM grace polling — escalate to SIGKILL immediately. */
  signal?: AbortSignal;
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
  const output = createOutput({
    mode: outputMode,
    stream: out,
    showTiming: true,
  });
  const runStartedAtMs = Date.now();
  const warnings: DownWarning[] = [];

  let worktree: Worktree;
  try {
    worktree = detectWorktree(cwd);
  } catch (err) {
    // Raw stream (not Output) so the early-exit message shape matches the pre-Output-framework behavior tests pin.
    writeLine(out, `no stack found for this worktree: ${errorMessage(err)}`);
    await output.close();
    return { exitCode: 0, warnings };
  }

  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  if (snap === null) {
    writeLine(out, "no stack found for this worktree");
    await output.close();
    return { exitCode: 0, warnings };
  }

  if (snap.status === "stopped") {
    writeLine(out, `stack already stopped: ${worktree.stack_id}`);
    await output.close();
    return { exitCode: 0, warnings };
  }

  // Snapshot doesn't carry lifecycle hooks or stop_cmd — re-parse the yaml. Missing/invalid: state-only teardown.
  let config: LichConfig | null = null;
  const configPath = join(worktree.path, "lich.yaml");
  if (existsSync(configPath)) {
    const parsed = await parseConfig(configPath);
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

        const lifecycle = config?.owned?.[name]?.lifecycle;
        if (lifecycle?.before_down && lifecycle.before_down.length > 0) {
          const perSvcCtx = buildDownInterpCtx(worktree, snapAllocatedPorts);
          await runPerServiceLifecycle(
            {
              serviceName: name,
              phase: "before_down",
              entries: interpolateDownLifecycleEntries(lifecycle.before_down, perSvcCtx, `owned.${name}.lifecycle.before_down`),
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

        // No explicit LogTail teardown — see top-of-file LogTail docblock.
        const ownedDef = config?.owned?.[name];
        try {
          const stopResult = await stopOwnedService(
            name,
            svcSnap.pid,
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

  // Resolve the active profile ONCE so before_down + after_down see the same composed entry list,
  // and so any `profile_resolve` warning fires once per down rather than once per phase.
  let resolvedProfileForDown: ReturnType<typeof resolveProfile> | null = null;
  if (snap.active_profile && config) {
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

  // Reconstruct the lifecycle env so before_down/after_down hooks see the same env layering as before_up/after_up
  // (top-level env, profile env, env_from, env_files, port interpolation). Reconstruction goes through the
  // state.json snapshot (not a fresh yaml parse) so we use the port allocations the stack actually ran with.
  // Yaml-gone OR resolveTopLevelEnv throws → fall back to process.env + `lifecycle_env` warning.
  let lifecycleEnv: NodeJS.ProcessEnv = process.env;
  let lifecycleResolveEnvGroup:
    | ((name: string) => Promise<NodeJS.ProcessEnv>)
    | undefined = undefined;
  let allocatedPortsForLifecycle: AllocatedPorts = { compose: {}, owned: {} };
  if (config) {
    allocatedPortsForLifecycle = snapAllocatedPorts;
    try {
      const topLevelEnv = await resolveTopLevelEnv({
        config,
        worktree,
        allocatedPorts: allocatedPortsForLifecycle,
        projectRoot: worktree.path,
        profile: resolvedProfileForDown ?? undefined,
      });
      // Layer per-owned-service port env vars on top. Iterate snapshot (NOT yaml `owned:`) so we only inject ports for services that actually ran.
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
      lifecycleEnv = enrichedEnv;
    } catch (err) {
      warnings.push({
        phase: "lifecycle_env",
        message: `failed to reconstruct lifecycle env from state.json (${errorMessage(err)}); before_down/after_down will run with bare process.env`,
      });
      lifecycleEnv = process.env;
    }

    // Closure for long-form lifecycle entries with env_group — mirrors up.ts's lifecycleResolveEnvGroup.
    lifecycleResolveEnvGroup = (name: string): Promise<NodeJS.ProcessEnv> =>
      resolveEnvGroup({
        name,
        config,
        worktree,
        allocatedPorts: allocatedPortsForLifecycle,
        projectRoot: worktree.path,
        profile: resolvedProfileForDown ?? undefined,
      });
  }

  const beforeDownEntries: LifecycleEntry[] = [];
  if (resolvedProfileForDown) {
    beforeDownEntries.push(...resolvedProfileForDown.lifecycle.before_down);
  }
  if (
    config?.lifecycle?.before_down &&
    config.lifecycle.before_down.length > 0
  ) {
    beforeDownEntries.push(...config.lifecycle.before_down);
  }
  if (beforeDownEntries.length > 0) {
    const beforeDownPhase = output.phase(
      formatHooksPhaseName({
        verb: "running",
        which: "before_down",
        current: 1,
        total: beforeDownEntries.length,
      }),
    );
    try {
      const beforeDownCtx = buildDownInterpCtx(worktree, allocatedPortsForLifecycle);
      await runLifecycle(
        {
          phase: "before_down",
          entries: interpolateDownLifecycleEntries(beforeDownEntries, beforeDownCtx, "lifecycle.before_down"),
          cwd: worktree.path,
          env: lifecycleEnv,
          resolveEnvGroup: lifecycleResolveEnvGroup,
          logDir: hooksDir(worktree.stack_id),
        },
        {
          onWarning: (w) => {
            warnings.push({
              phase: "before_down",
              message: `entry #${w.index} exited ${w.exitCode}: ${w.cmd}`,
            });
          },
          onEntryStart: (start) => output.lifecycleEntryStart(start),
          onEntryComplete: (completion) =>
            output.lifecycleEntryComplete(completion),
        },
      ).catch((err) => {
        warnings.push({
          phase: "before_down",
          message: errorMessage(err),
        });
      });
    } finally {
      beforeDownPhase.end("ok", "hooks done");
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

        const lifecycle = config?.services?.[name]?.lifecycle;
        if (lifecycle?.before_down && lifecycle.before_down.length > 0) {
          const composeSvcCtx = buildDownInterpCtx(worktree, snapAllocatedPorts);
          await runPerServiceLifecycle(
            {
              serviceName: name,
              phase: "before_down",
              entries: interpolateDownLifecycleEntries(lifecycle.before_down, composeSvcCtx, `services.${name}.lifecycle.before_down`),
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

  // after_down runs AFTER services have stopped AND AFTER before_down — for external resource cleanup safe only post-teardown
  // (drop supabase workdir, remove scratch dirs). Composition order mirrors before_down: profile first (undo specialization), then top-level.
  // Same lifecycleEnv as before_down — reused since both phases have identical env requirements.
  const afterDownEntries: LifecycleEntry[] = [];
  if (resolvedProfileForDown) {
    afterDownEntries.push(...resolvedProfileForDown.lifecycle.after_down);
  }
  if (
    config?.lifecycle?.after_down &&
    config.lifecycle.after_down.length > 0
  ) {
    afterDownEntries.push(...config.lifecycle.after_down);
  }
  if (afterDownEntries.length > 0) {
    const afterDownPhase = output.phase(
      formatHooksPhaseName({
        verb: "running",
        which: "after_down",
        current: 1,
        total: afterDownEntries.length,
      }),
    );
    try {
      const afterDownCtx = buildDownInterpCtx(worktree, allocatedPortsForLifecycle);
      await runLifecycle(
        {
          phase: "after_down",
          entries: interpolateDownLifecycleEntries(afterDownEntries, afterDownCtx, "lifecycle.after_down"),
          cwd: worktree.path,
          env: lifecycleEnv,
          resolveEnvGroup: lifecycleResolveEnvGroup,
          logDir: hooksDir(worktree.stack_id),
        },
        {
          onWarning: (w) => {
            warnings.push({
              phase: "after_down",
              message: `entry #${w.index} exited ${w.exitCode}: ${w.cmd}`,
            });
          },
          onEntryStart: (start) => output.lifecycleEntryStart(start),
          onEntryComplete: (completion) =>
            output.lifecycleEntryComplete(completion),
        },
      ).catch((err) => {
        warnings.push({
          phase: "after_down",
          message: errorMessage(err),
        });
      });
    } finally {
      afterDownPhase.end("ok", "hooks done");
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
  ownedDef: OwnedService | undefined,
  worktree: Worktree,
  config: LichConfig | null,
  snapshot: StackSnapshot,
  signal?: AbortSignal,
): Promise<StopOwnedResult> {
  const warnings: string[] = [];
  let info: string | undefined;

  // stop_cmd takes priority — used by self-managing tools (e.g. supabase).
  if (ownedDef?.stop_cmd) {
    // Resolve per-service env via the same pipeline up.ts used at spawn — non-negotiable for any stop_cmd that addresses
    // external state by an interpolated identifier (supabase project_id, namespaced docker names, etc.).
    const allocatedPortsForStop = rebuildAllocatedPorts(snapshot);
    let stopEnv: NodeJS.ProcessEnv = process.env;
    if (config) {
      try {
        stopEnv = await resolveEnvForService({
          config,
          service: { kind: "owned", name },
          worktree,
          allocatedPorts: allocatedPortsForStop,
          projectRoot: worktree.path,
        });
      } catch {
        // Best-effort: fall back to process.env so stop_cmd at least runs.
        stopEnv = process.env;
      }
    }
    // ALSO inject per-port env vars (`SUPABASE_API_PORT=9000` etc.) so tools like `supabase stop` can parse `port = "env(SUPABASE_API_PORT)"` in config files.
    const snapSvc = snapshot.services.find(
      (s) => s.kind === "owned" && s.name === name,
    );
    stopEnv = injectOwnedPortEnv(stopEnv, ownedDef, snapSvc?.allocated_ports);
    // Interpolate ${...} refs in stop_cmd using the same port context used for env.
    let resolvedStopCmd = ownedDef.stop_cmd;
    try {
      resolvedStopCmd = interpolateString(
        ownedDef.stop_cmd,
        buildDownInterpCtx(worktree, allocatedPortsForStop),
        `owned.${name}.stop_cmd`,
        true,
      );
    } catch {
      // Best-effort: unresolved refs fall back to the raw string.
    }
    const result = await runStopCmd(resolvedStopCmd, worktree.path, stopEnv);
    // Surface outcomes the user can act on: exit code + stderr tail for failures; slow-but-zero exit as info.
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
      // External SIGKILL or spawn-level failure (sh missing, etc.).
      const tail = formatStderrTail(result.stderrTail);
      const tailSection = tail ? ` stderr tail: "${tail}"` : "";
      warnings.push(
        `stop_cmd terminated abnormally (no exit code);${tailSection}`,
      );
    } else if (result.durationMs > STOP_CMD_SLOW_MS) {
      const seconds = (result.durationMs / 1000).toFixed(1);
      info = `stop_cmd took ${seconds}s — verify resources are actually gone`;
    }
    return { warnings, info };
  }

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

/**
 * Compute teardown order. With yaml: reverse-topo from depends_on, with extras (services in snapshot but not yaml) appended.
 * No yaml or graph-error: fall back to reversed snapshot order (`up` writes in startup order). Cycle/missing-dep emits a warning.
 */
function computeTeardownOrder(
  serviceSnaps: Array<{ name: string; kind: "compose" | "owned" }>,
  config: LichConfig | null,
  warnings: DownWarning[],
): string[] {
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
