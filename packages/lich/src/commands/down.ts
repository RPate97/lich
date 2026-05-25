/**
 * `lich down` — idempotent stack teardown (Plan 1 Task 24 / LEV-291).
 *
 * Inverse of `lich up`: reads `state.json` for the current worktree's stack,
 * re-parses `lich.yaml` to recover lifecycle hooks + stop_cmd + depends_on
 * (the snapshot doesn't carry these), and tears the stack down in reverse
 * topological order.
 *
 * Sequence:
 *
 *   1. Detect worktree → stack_id.
 *   2. Read state.json. If missing → "no stack found for this worktree", exit 0.
 *   3. If status:stopped already → no-op, exit 0 (idempotent).
 *   4. Re-parse lich.yaml from `worktree.path` for lifecycle/stop_cmd/depends_on.
 *      If lich.yaml missing/invalid: warn + proceed with state-only teardown.
 *   5. Compute reverse-topo order (deepest deps stop first).
 *   6. For each service in reverse order:
 *        - Run per-service `lifecycle.before_down` (best-effort warnings).
 *        - Owned: stop_cmd if defined; else SIGTERM→SIGKILL the recorded PID.
 *        - Compose: `compose down -v` against the project name `lich-<stack_id>`.
 *        - Mark service state → 'stopped'.
 *   7. Run top-level `lifecycle.before_down` (best-effort warnings).
 *   8. Release ports for this stack.
 *   9. Update state.json: status:stopped (don't delete — `lich stacks` keeps
 *      stopped stacks visible until `lich nuke` cleans them).
 *  10. Print summary, exit 0.
 *
 * Idempotency: re-runs are no-ops. Down on a missing state is exit 0.
 *
 * Best-effort by design: any failure during teardown becomes a warning and
 * teardown continues. Exit code stays 0. The warnings list is returned to
 * the caller for inspection (tests assert on it).
 *
 * ### LogTail lifecycle (Plan 4 Task 16 / LEV-365)
 *
 * `lich up` (Plan 4 Task 14) registers a `LogTail` per owned service in an
 * in-process `Map<string, LogTail>` on `UpState`. Those tails feed
 * `ready_when.log_match`, `fail_when.log_match`, `ready_when.capture`, and
 * (Plan 5) the dashboard live-tail. On the success path, `up` deliberately
 * leaves the tails RUNNING after it returns so a service that emits a
 * `fail_when` line five minutes post-startup still trips its failure handler.
 *
 * `lich down` runs in a SEPARATE process from `lich up`. It inherits NO
 * LogTail state — there is no in-process registry to drain here. Plan 4's
 * contract for the cross-process boundary is:
 *
 *   - The supervisor's stop_cmd / SIGTERM→SIGKILL escalation in
 *     `stopOwnedService` below terminates the spawned child. The child held
 *     the WRITE fd on the log file (via `stdio: ["ignore", logFd, logFd]`,
 *     see `packages/lich/src/owned/supervisor.ts`). When the child exits the
 *     kernel reclaims that fd. The log file itself stays on disk under
 *     `~/.lich/stacks/<id>/logs/` so `lich logs --failed` can still read it
 *     post-teardown.
 *
 *   - Any LogTail that was tied to a still-running `lich up` process gets
 *     stopped by the cancellation cleanup in `up.ts` (Plan 4 Task 15) when
 *     the user Ctrl-Cs that process, or by garbage collection when the up
 *     process itself exits. `lich down` doesn't and can't reach into another
 *     process's heap to call `.stop()` — the OS-level fd reclamation is the
 *     coordination mechanism.
 *
 * In short: there is nothing for `lich down` to do here beyond what it
 * already does. This docblock exists so the cross-plan dependency is
 * explicit and a future agent doesn't try to thread a registry through
 * IPC for no benefit. The interesting "LogTails outlive `up` for late
 * failure detection" behavior moves into Plan 5's daemon, which owns the
 * long-running state across multiple CLI invocations.
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
  type StackSnapshot,
} from "../state/snapshot.js";
import { stackDir } from "../state/directory.js";
import { resolveComposeCli } from "../compose/detect.js";
import { survivors, signalGroup } from "../owned/supervisor.js";
import {
  down as composeDown,
  _exec as composeExec,
  type RunnerCtx,
} from "../compose/runner.js";
import { resolveEnvForService } from "../env/resolve.js";
import { runLifecycle, type LifecycleEntry } from "../lifecycle/executor.js";
import { runPerServiceLifecycle } from "../lifecycle/per-service.js";
import { buildGraph, type NodeDecl } from "../deps/graph.js";
import { shutdownOrder, CycleError } from "../deps/sort.js";
import { resolveProfile } from "../profiles/resolve.js";
import type { LichConfig, OwnedService } from "../config/types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunDownInput {
  /** Defaults to `process.cwd()`. */
  cwd?: string;
  /** Defaults to `process.stdout`. */
  out?: NodeJS.WritableStream;
  /** Defaults to `process.stderr`. */
  err?: NodeJS.WritableStream;
  /**
   * Optional AbortSignal — wired to the bin layer's SIGINT handler. When
   * it fires we short-circuit the SIGTERM grace polling inside
   * `stopOwnedService`, escalating to SIGKILL immediately so Ctrl-C during
   * a teardown doesn't make the user wait the full grace window per service.
   * (The bin layer's second-SIGINT-forces-quit guarantees they can always
   * escape; this just makes the first SIGINT useful during down too.)
   */
  signal?: AbortSignal;
}

export interface DownWarning {
  /** Service name (omitted for stack-level warnings like top-level lifecycle). */
  service?: string;
  /** Coarse phase tag: 'before_down', 'stop_owned', 'compose_down', 'release_ports', etc. */
  phase: string;
  message: string;
}

export interface RunDownResult {
  exitCode: number;
  warnings: DownWarning[];
}

// ---------------------------------------------------------------------------
// Bounded timeouts
// ---------------------------------------------------------------------------

/** SIGTERM grace before SIGKILL escalation for owned services. */
const SIGTERM_GRACE_MS = 5_000;
/** Cap on stop_cmd execution time. */
const STOP_CMD_TIMEOUT_MS = 30_000;
/** Poll interval for the post-SIGTERM liveness check. */
const POLL_INTERVAL_MS = 50;
/**
 * Cap on the stderr ring buffer captured from `stop_cmd` so that a chatty
 * teardown doesn't balloon the warning string. 4 KiB is enough for a
 * typical stack trace or `make` output dump, small enough that the warning
 * stays readable in terminal output. (LEV-312)
 */
const STOP_CMD_STDERR_RING_BYTES = 4 * 1024;
/**
 * Threshold above which a stop_cmd that exited 0 is flagged as slow. A
 * slow stop is usually fine but worth surfacing — it's often the symptom
 * of a service that's hung on teardown but didn't propagate failure.
 * (LEV-312)
 */
const STOP_CMD_SLOW_MS = 5_000;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runDown(input: RunDownInput): Promise<RunDownResult> {
  const cwd = input.cwd ?? process.cwd();
  const out = input.out ?? process.stdout;
  const warnings: DownWarning[] = [];

  // ---- Step 1: detect worktree ------------------------------------------
  let worktree: Worktree;
  try {
    worktree = detectWorktree(cwd);
  } catch (err) {
    writeLine(out, `no stack found for this worktree: ${errorMessage(err)}`);
    return { exitCode: 0, warnings };
  }

  // ---- Step 2: read state.json ------------------------------------------
  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  if (snap === null) {
    writeLine(out, "no stack found for this worktree");
    return { exitCode: 0, warnings };
  }

  // ---- Step 3: idempotent no-op if already stopped ----------------------
  if (snap.status === "stopped") {
    writeLine(out, `stack already stopped: ${worktree.stack_id}`);
    return { exitCode: 0, warnings };
  }

  // ---- Step 4: re-parse lich.yaml (best-effort) -------------------------
  // The snapshot doesn't carry lifecycle hooks or stop_cmd. We re-parse the
  // user's yaml from the worktree path to recover them. If the yaml is gone
  // or invalid, we still proceed with a state-only teardown — the user will
  // see a warning but their stack still gets cleaned up.
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

  // Mark stack as stopping while we tear it down — observers (lich stacks,
  // dashboard) get a coherent intermediate state to display.
  snap.status = "stopping";
  await writeSnapshot(snap).catch(() => {});

  // ---- Step 5: compute reverse-topo order -------------------------------
  // Pull the order from the union of (services in state.json) and (services
  // declared in the yaml). State drives the actual teardown — we only stop
  // services we recorded — but the yaml carries depends_on which gives us
  // the order. If yaml is missing, fall back to the order present in
  // state.json (which `up` writes in startup-topo order, so reversing it
  // is a reasonable proxy).
  const teardownOrder = computeTeardownOrder(snap.services, config, warnings);

  // Build a quick lookup of service snapshots by name.
  const snapsByName = new Map(snap.services.map((s) => [s.name, s]));

  // ---- Step 6: per-service teardown -------------------------------------
  // We have to issue compose-down once per compose service (or once for the
  // whole project — compose down with no services targets the project).
  // Since teardown order is per-service we issue per-service down calls;
  // compose treats `down <name>` as a stop on that container. For
  // simplicity and correctness we issue an individual `down` for each
  // compose service in the reverse order, then a project-level `down -v`
  // at the end to sweep volumes and the network.
  let composeRan = false;

  for (const name of teardownOrder) {
    const svcSnap = snapsByName.get(name);
    if (!svcSnap) continue;

    // ---- per-service before_down -----------------------------------
    const lifecycle =
      svcSnap.kind === "owned"
        ? config?.owned?.[name]?.lifecycle
        : config?.services?.[name]?.lifecycle;
    if (lifecycle?.before_down && lifecycle.before_down.length > 0) {
      await runPerServiceLifecycle(
        {
          serviceName: name,
          phase: "before_down",
          entries: lifecycle.before_down,
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

    // ---- service-kind-specific stop --------------------------------
    // Plan 4 Task 16 (LEV-365): No explicit LogTail teardown here. `lich up`
    // owned the LogTail registry in its own process; when that process is
    // gone the tails are gone with it. Killing the supervised child below
    // (via stop_cmd or SIGTERM→SIGKILL) releases the write fd on the log
    // file; any still-running tail in the up process (if it's still alive
    // — single-binary CLI, so usually not) sees stat() report a stable
    // size and stops emitting. See the top-of-file docblock for the full
    // cross-process LogTail lifecycle contract.
    if (svcSnap.kind === "owned") {
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
          warnings.push({ service: name, phase: "stop_owned", message: w });
        }
        if (stopResult.info) {
          // Info-level note: surface to the user via stdout, distinct from
          // the warnings list (which gets a separate "N warnings" rollup).
          writeLine(out, `info: [${name}] ${stopResult.info}`);
        }
      } catch (err) {
        warnings.push({
          service: name,
          phase: "stop_owned",
          message: errorMessage(err),
        });
      }
    } else if (svcSnap.kind === "compose") {
      composeRan = true;
    }

    svcSnap.state = "stopped";
  }

  // ---- One compose down for the whole project ---------------------------
  // We do this AFTER per-service before_down hooks have all run. Reverse
  // topo ordering is honored at the hook level; the actual container
  // teardown is a single project-scoped `down -v` because that's the
  // primitive compose exposes for "remove this project's resources cleanly,
  // including the network." Issuing per-service `down <name>` works too,
  // but doesn't tear down the network or volumes — the project-level call
  // is the canonical "remove everything for this project" invocation.
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

  // ---- Step 7: composed before_down (profile + top-level, LIFO) ---------
  // Compose order is the LIFO inverse of `up`'s before_up composition:
  // profile-scoped entries run FIRST (undo the specialization), then
  // top-level entries (tear down the base). This mirrors `resolveProfile`'s
  // `lifecycle.before_down` composition (child-first), applied here at the
  // call site so existing callers without a profile keep working unchanged.
  //
  // Re-resolve the active profile from the on-disk yaml. The snapshot
  // carries only the profile NAME (Plan 3 Task 8); the lifecycle entries
  // live in the yaml. If the yaml has drifted between up and down (user
  // removed the profile, renamed it, broke the extends chain, etc.) we
  // emit a `profile_resolve` warning and fall back to top-level-only so
  // teardown still makes forward progress — best-effort like the rest of
  // down.
  const beforeDownEntries: LifecycleEntry[] = [];
  if (snap.active_profile && config) {
    if (config.profiles?.[snap.active_profile]) {
      try {
        const resolved = resolveProfile(snap.active_profile, config);
        beforeDownEntries.push(...resolved.lifecycle.before_down);
      } catch (err) {
        warnings.push({
          phase: "profile_resolve",
          message: `failed to resolve profile "${snap.active_profile}" for before_down: ${errorMessage(err)}; proceeding with top-level entries only`,
        });
      }
    } else {
      warnings.push({
        phase: "profile_resolve",
        message: `active profile "${snap.active_profile}" recorded in state.json is no longer declared in lich.yaml; proceeding with top-level before_down entries only`,
      });
    }
  }
  if (
    config?.lifecycle?.before_down &&
    config.lifecycle.before_down.length > 0
  ) {
    beforeDownEntries.push(...config.lifecycle.before_down);
  }
  if (beforeDownEntries.length > 0) {
    await runLifecycle(
      {
        phase: "before_down",
        entries: beforeDownEntries,
        cwd: worktree.path,
        env: process.env,
      },
      (w) => {
        warnings.push({
          phase: "before_down",
          message: `entry #${w.index} exited ${w.exitCode}: ${w.cmd}`,
        });
      },
    ).catch((err) => {
      warnings.push({
        phase: "before_down",
        message: errorMessage(err),
      });
    });
  }

  // ---- Step 8: release ports --------------------------------------------
  try {
    await release(worktree.stack_id);
  } catch (err) {
    warnings.push({
      phase: "release_ports",
      message: errorMessage(err),
    });
  }

  // ---- Step 9: status:stopped persisted ---------------------------------
  snap.status = "stopped";
  // Plan 5 Task 10 (LEV-412): clear the stack's routing entries on teardown
  // so the daemon's reverse proxy stops serving stale upstream URLs within
  // one watcher tick (~100ms). We set `routing: []` rather than `undefined`:
  // the two are semantically distinct (see `RoutingEntry` JSDoc on
  // `StackSnapshot`):
  //   - `undefined`: this snapshot never declared routes (pre-Plan-5, or
  //     mid-startup before `up` populated them).
  //   - `[]`: routing was actively cleared — "this stack has zero routes
  //     right now," which is precisely what `down` is signaling.
  // The proxy in Plan 5 Task 12 filters routing for stacks whose status is
  // stopped/failed/stopping, so even without the explicit clear the routes
  // would no longer be served — but writing `[]` here is the unambiguous
  // signal and keeps the snapshot honest. Always-clear (vs. only-when-
  // present) is intentional: idempotent and removes any chance of a stale
  // routing block lingering on disk.
  snap.routing = [];
  await writeSnapshot(snap).catch((err) => {
    warnings.push({
      phase: "persist_state",
      message: errorMessage(err),
    });
  });

  // ---- Step 10: summary -------------------------------------------------
  writeLine(out, `stack down: ${worktree.stack_id}`);
  if (warnings.length > 0) {
    writeLine(out, `${warnings.length} warning(s) during teardown:`);
    for (const w of warnings) {
      const svcTag = w.service ? `[${w.service}] ` : "";
      writeLine(out, `  - ${svcTag}${w.phase}: ${w.message}`);
    }
  }

  // Reference stackDir to silence tree-shake (and so any future debugging
  // lookups have a single import point).
  void stackDir;

  return { exitCode: 0, warnings };
}

// ---------------------------------------------------------------------------
// Per-service stop helpers
// ---------------------------------------------------------------------------

/**
 * Outcome of stopping one owned service. `warnings` are diagnostics the
 * caller should attach to the down operation's overall warning list. The
 * function itself does not throw on per-service teardown problems — it
 * reports them so the surrounding loop can keep tearing down the rest
 * of the stack. (LEV-312)
 */
interface StopOwnedResult {
  warnings: string[];
  /** Info-level note ("stop_cmd took N.Ns") that isn't a warning. */
  info?: string;
}

/**
 * Stop one owned service. If `stop_cmd` is declared in the yaml, run it
 * via `/bin/sh -c`. Otherwise SIGTERM the recorded PID, wait up to
 * SIGTERM_GRACE_MS, escalate to SIGKILL.
 *
 * Idempotent: a dead/missing PID is a no-op.
 *
 * If a `signal` is supplied and fires before the SIGTERM grace expires,
 * we cut the grace window short and escalate to SIGKILL immediately —
 * that's how Ctrl-C during a teardown skips the per-service wait. The
 * outer bin-layer SIGINT handler still guarantees a second Ctrl-C forces
 * the process to exit; this just makes the first Ctrl-C make progress.
 *
 * Returns a {@link StopOwnedResult}. `warnings` carries diagnostics for
 * stop_cmd non-zero exits (now including the stderr tail) and post-SIGKILL
 * liveness check failures (LEV-312). `info` carries non-warning notes —
 * presently the "stop_cmd took longer than usual" hint.
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
    // Resolve per-service env via the same pipeline `up.ts` used to start
    // the service. This is non-negotiable for any stop_cmd that addresses
    // external state by an interpolated identifier (supabase project_id,
    // namespaced docker container names, etc. — see LEV-310). If the
    // resolver throws (env_from shell-out failure, missing dotenv, etc.)
    // we fall back to process.env and surface a warning so teardown still
    // makes forward progress.
    let stopEnv: NodeJS.ProcessEnv = process.env;
    if (config) {
      try {
        stopEnv = await resolveEnvForService({
          config,
          service: { kind: "owned", name },
          worktree,
          allocatedPorts: rebuildAllocatedPorts(snapshot),
          projectRoot: worktree.path,
        });
      } catch {
        // Best-effort: a failed env resolve falls back to process.env so
        // the stop_cmd at least runs. The user already gets a warning in
        // the surrounding catch block at the call site if this throws
        // again (it shouldn't — process.env is always valid).
        stopEnv = process.env;
      }
    }
    // LEV-320: ALSO inject per-port env vars (SUPABASE_API_PORT=9000 etc.).
    // These live outside the env pipeline — `up.ts` injects them at spawn
    // time in the supervisor from the yaml's `port:`/`ports:` blocks paired
    // with allocator output. Stop_cmd needs them too: `supabase stop`
    // reads supabase/config.toml's `port = "env(SUPABASE_API_PORT)"`
    // and fails to parse without them. Find the matching snapshot service
    // and re-derive the env vars from its allocated_ports.
    const snapSvc = snapshot.services.find(
      (s) => s.kind === "owned" && s.name === name,
    );
    stopEnv = injectOwnedPortEnv(stopEnv, ownedDef, snapSvc?.allocated_ports);
    const result = await runStopCmd(ownedDef.stop_cmd, worktree.path, stopEnv);
    // LEV-312: surface stop_cmd outcomes the user can actually act on.
    //   - non-zero exit (or signal): include exit code + stderr tail so the
    //     warning gives them enough context to know what failed and where
    //     to look. Without the tail "stop_cmd exited 7" is almost useless
    //     for debugging.
    //   - exit 0 but slow: log as info — "stop_cmd took N.Ns — verify
    //     resources are actually gone." We can't generically know what
    //     "stopped" means for each tool; the hint lets the user check.
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
      // Signal-killed (something external SIGKILL'd it) or spawn-level
      // failure (sh missing, etc.). Either is worth surfacing.
      const tail = formatStderrTail(result.stderrTail);
      const tailSection = tail ? ` stderr tail: "${tail}"` : "";
      warnings.push(
        `stop_cmd terminated abnormally (no exit code);${tailSection}`,
      );
    } else if (result.durationMs > STOP_CMD_SLOW_MS) {
      // Exit 0 but slow — info, not warning. Distinct surface tells the
      // user this is a hint to investigate, not a failure.
      const seconds = (result.durationMs / 1000).toFixed(1);
      info = `stop_cmd took ${seconds}s — verify resources are actually gone`;
    }
    return { warnings, info };
  }

  if (typeof pid !== "number") return { warnings };
  if (!isAlive(pid)) return { warnings };

  // SIGTERM the leader's process group. The supervisor spawns owned
  // services with detached:true, so pid == pgid and every grandchild
  // shares the group — `kill(-pid, SIGTERM)` delivers atomically to
  // the whole tree (`bun run dev` → `bun --hot src` for the api,
  // `bun run dev` → `node next dev` → `next-server` for the web).
  try {
    signalGroup(pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return { warnings };
    throw err;
  }

  // Poll for graceful exit of the whole group. Most processes exit within
  // a few hundred ms. If the caller's cancellation signal fires mid-grace,
  // break out and jump straight to SIGKILL.
  const startMs = Date.now();
  while (Date.now() - startMs < SIGTERM_GRACE_MS) {
    if (!isAlive(pid) && survivors(pid).length === 0) {
      return { warnings };
    }
    if (signal?.aborted) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // Still alive after the grace window (or cancellation cut us short).
  // Escalate to SIGKILL across the group.
  try {
    signalGroup(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return { warnings };
    throw err;
  }

  // SIGKILL is uncatchable; the kernel reaps shortly. One bounded poll
  // to confirm so the caller doesn't race.
  const killStartMs = Date.now();
  while (Date.now() - killStartMs < 1_000) {
    if (!isAlive(pid) && survivors(pid).length === 0) {
      return { warnings };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  // LEV-312: if anything in the group is STILL alive after SIGKILL +
  // grace, surface a warning. Pathological — pid in D-state, zombie,
  // or container/pid mismatch — but the user's "lich said it killed
  // it" contract requires us to say so rather than silently pretend
  // success.
  const lingering = survivors(pid);
  if (lingering.length > 0) {
    warnings.push(
      `pid(s) ${lingering.join(", ")} still alive after SIGKILL + 1s grace; service "${name}" may still be running`,
    );
  }
  return { warnings };
}

/** Outcome of a stop_cmd run (LEV-312). */
interface StopCmdResult {
  /** Exit code; `null` if the command was killed by signal (timeout). */
  exitCode: number | null;
  /** Tail of stderr (up to STOP_CMD_STDERR_RING_BYTES bytes). */
  stderrTail: string;
  /** Wall-clock duration of the stop_cmd run, in ms. */
  durationMs: number;
  /** True if we had to SIGKILL the stop_cmd because it exceeded the timeout. */
  timedOut: boolean;
}

/**
 * Run the user's stop_cmd via /bin/sh -c. Bounded by STOP_CMD_TIMEOUT_MS.
 *
 * Resolves with a {@link StopCmdResult} capturing the exit code, stderr
 * tail (ring buffer, capped at `STOP_CMD_STDERR_RING_BYTES`), wall-clock
 * duration, and whether the timeout fired. Non-zero exits are not thrown
 * — the caller decides whether and how to surface them as warnings, using
 * the captured stderr to make the warning useful for debugging (LEV-312).
 *
 * Per-service env resolved via the same pipeline used at startup, so
 * stop_cmd addresses the same external state the service was started with.
 * (LEV-310: without this, e.g. `supabase stop` would target the default
 * project_id rather than the worktree-tagged one, leaving the actual
 * containers running.)
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

    // Stderr ring buffer: append every chunk, drop oldest bytes once the
    // buffer exceeds the cap. We coerce chunks to strings up front so the
    // final tail slice is a single string operation; the size cost of
    // ASCII is identical to the byte count, and even worst-case multi-byte
    // UTF-8 stays bounded.
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text =
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrBuf += text;
      if (stderrBuf.length > STOP_CMD_STDERR_RING_BYTES) {
        stderrBuf = stderrBuf.slice(-STOP_CMD_STDERR_RING_BYTES);
      }
    });
    // Drain stdout so the child doesn't block on a full pipe. We don't
    // capture it — stdout from a teardown command is typically diagnostic
    // chatter ("ok, stopped foo"); the failure context lives in stderr.
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
      // Spawn-level failure (ENOENT for /bin/sh, etc.). Treat as code 1
      // with whatever stderr we managed to capture.
      exitCode = null;
      finish();
    });
  });
}

/**
 * Compact a stderr tail for inclusion in a single-line warning. Trims
 * leading/trailing whitespace and collapses newlines so the warning stays
 * scannable in a terminal. The full tail (capped at the ring buffer size)
 * is still surfaced — we just normalize the whitespace.
 */
function formatStderrTail(tail: string): string {
  return tail.replace(/\s+/g, " ").trim();
}

/**
 * Result of `tearDownCompose`: any warnings the caller should surface
 * to the user about the compose teardown not fully verifying.
 *
 * The "ideal" outcome is `warnings: []` — `compose down` returned 0 and
 * `compose ps -q` returned no surviving containers. (LEV-312)
 */
interface ComposeTeardownResult {
  warnings: string[];
}

/**
 * Drive `<cli> compose -p lich-<stack_id> -f <override> down -v` for the
 * stack, then verify the project actually emptied out (LEV-312). If
 * `compose ps -q` still returns container IDs, force-remove each with
 * `<cli> rm -f <id>` and re-check. Anything still alive after that is
 * surfaced as a loud warning with the surviving container IDs.
 *
 * We don't pass `--remove-orphans` (per the spec for this task): down is
 * meant to stop the stack we know about, not aggressively reap unrelated
 * resources. `--remove-orphans` is the nuke-tier behavior.
 *
 * If the compose override file doesn't exist (the up never wrote one — pure
 * owned stack, or a partial up that crashed before writing it), we just
 * pass no `-f` files. Compose can still find resources by project name.
 */
async function tearDownCompose(
  worktree: Worktree,
): Promise<ComposeTeardownResult> {
  const cli = await resolveComposeCli(undefined);
  const overridePath = join(stackDir(worktree.stack_id), "compose.override.yaml");
  const files = existsSync(overridePath) ? [overridePath] : [];
  const project = `lich-${worktree.stack_id}`;

  const ctx: RunnerCtx = {
    cli,
    project,
    files,
    cwd: worktree.path,
  };

  // Best-effort: non-zero exit codes are surfaced by the caller as a
  // warning, but the runner itself doesn't throw on non-zero, so we only
  // see throws for spawn-level failures (binary not found, etc.).
  await composeDown(ctx, { volumes: true, remove_orphans: false });

  // LEV-312: post-down verification. `compose ps -q` is the project-
  // scoped "what's still here?" probe — it prints one container ID per
  // line for everything matching the project label. Empty stdout means
  // the project is fully torn down. Non-empty means compose exited 0
  // but containers survived (compose timeouts, orphaned containers from
  // a previous run with a different override file, etc.).
  return verifyComposeTeardown(ctx);
}

/**
 * Verify the compose project is actually empty after `down`. Lists any
 * surviving container IDs via `compose ps -q`, attempts a force-remove
 * (`<cli> rm -f <id>`) on each, then re-checks. Returns warnings for
 * everything still alive after the salvage attempt. (LEV-312)
 *
 * The first `ps -q` lookup uses the same compose runner seam as `down`
 * itself so unit tests can swap it via `composeExec.current`. The force-
 * remove call goes through Node's `child_process.spawn` directly (the
 * compose runner abstraction only covers `compose <subcommand>` shapes,
 * and `docker rm` isn't one). Tests that need to assert on the `rm -f`
 * call should also stub `composeExec.current` and use the second `ps -q`
 * to drive the re-check.
 */
async function verifyComposeTeardown(
  ctx: RunnerCtx,
): Promise<ComposeTeardownResult> {
  const warnings: string[] = [];

  const remaining = await composePsQ(ctx);
  if (remaining.length === 0) return { warnings };

  // Attempt the force-remove salvage. Per-container so partial success
  // is observable in the re-check.
  for (const id of remaining) {
    await forceRemoveContainer(ctx.cli.cmd, id);
  }

  // Final check — anything still here is loudly surfaced. Include the
  // surviving IDs so the user can `docker rm -f` them by hand and / or
  // open a bug with the container details.
  const stillAlive = await composePsQ(ctx);
  if (stillAlive.length > 0) {
    warnings.push(
      `compose teardown could not fully remove project "${ctx.project}"; ${stillAlive.length} container(s) still alive after force-remove: ${stillAlive.join(", ")}`,
    );
  } else {
    // Salvage worked — surface as a softer warning so the user knows
    // compose itself had trouble (worth investigating) even though
    // lich cleaned up.
    warnings.push(
      `compose down left ${remaining.length} container(s) running for project "${ctx.project}"; force-removed via ${ctx.cli.cmd} rm -f`,
    );
  }
  return { warnings };
}

/**
 * Run `<cli> compose -p <project> -f <file>... ps -q` and parse the
 * stdout into a list of container IDs. Empty list means the project is
 * empty. (LEV-312)
 *
 * Uses the shared `composeExec.current` seam so tests can fake the ps
 * output without spawning anything.
 */
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
  // ps -q output is one container id per line. Filter empties so we don't
  // count blank lines as containers.
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * `<cli> rm -f <container_id>`. Best-effort — failures are silent because
 * the immediate re-check in {@link verifyComposeTeardown} will catch
 * containers we couldn't kill, and that's where we surface the warning.
 * (LEV-312)
 *
 * Uses the compose-runner exec seam so the cli command is consistent
 * (docker / podman / nerdctl) and tests can record the call.
 */
async function forceRemoveContainer(cli: string, id: string): Promise<void> {
  await composeExec.current(cli, ["rm", "-f", id], {}).catch(() => {
    /* best-effort; the re-check is the source of truth */
  });
}

// ---------------------------------------------------------------------------
// Teardown order
// ---------------------------------------------------------------------------

/**
 * Compute the order in which to stop services.
 *
 * Strategy:
 *   - If we have the yaml, build the dep graph from declared services and
 *     return `shutdownOrder` (= reverse startup topo). Include any services
 *     present in state.json but not in yaml (e.g. user removed them between
 *     up and down) at the end.
 *   - If we don't have the yaml, fall back to the order in state.json
 *     reversed. `up` writes services in startup order, so reversing gives
 *     a reasonable approximation.
 *   - On a graph-build error (cycle, missing dep — shouldn't happen since
 *     `up` validated the same yaml, but defensively), fall back to the
 *     reversed-snapshot order and warn.
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
    // Add any services from state.json that aren't in the yaml at the end
    // — we still want to tear them down. They're "extra" relative to the
    // current yaml.
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

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

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
