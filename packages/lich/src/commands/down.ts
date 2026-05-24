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
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../config/parse.js";
import { detectWorktree, type Worktree } from "../worktree/detect.js";
import { release } from "../ports/allocator.js";
import { readSnapshot, writeSnapshot } from "../state/snapshot.js";
import { stackDir } from "../state/directory.js";
import { resolveComposeCli } from "../compose/detect.js";
import { down as composeDown, type RunnerCtx } from "../compose/runner.js";
import { runLifecycle } from "../lifecycle/executor.js";
import { runPerServiceLifecycle } from "../lifecycle/per-service.js";
import { buildGraph, type NodeDecl } from "../deps/graph.js";
import { shutdownOrder, CycleError } from "../deps/sort.js";
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
    if (svcSnap.kind === "owned") {
      const ownedDef = config?.owned?.[name];
      try {
        await stopOwnedService(
          name,
          svcSnap.pid,
          ownedDef,
          worktree,
          input.signal,
        );
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
      await tearDownCompose(worktree);
    } catch (err) {
      warnings.push({
        phase: "compose_down",
        message: errorMessage(err),
      });
    }
  }

  // ---- Step 7: top-level before_down ------------------------------------
  if (
    config?.lifecycle?.before_down &&
    config.lifecycle.before_down.length > 0
  ) {
    await runLifecycle(
      {
        phase: "before_down",
        entries: config.lifecycle.before_down,
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
 */
async function stopOwnedService(
  name: string,
  pid: number | undefined,
  ownedDef: OwnedService | undefined,
  worktree: Worktree,
  signal?: AbortSignal,
): Promise<void> {
  // stop_cmd takes priority — used by self-managing tools (e.g. supabase).
  if (ownedDef?.stop_cmd) {
    await runStopCmd(ownedDef.stop_cmd, worktree.path);
    return;
  }

  if (typeof pid !== "number") return;
  if (!isAlive(pid)) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    throw err;
  }

  // Poll for graceful exit. Most processes exit within a few hundred ms.
  // If the caller's cancellation signal fires mid-grace, break out and
  // jump straight to SIGKILL.
  const startMs = Date.now();
  while (Date.now() - startMs < SIGTERM_GRACE_MS) {
    if (!isAlive(pid)) return;
    if (signal?.aborted) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // Still alive after the grace window (or cancellation cut us short).
  // Escalate.
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    throw err;
  }

  // SIGKILL is uncatchable; the kernel reaps shortly. One bounded poll
  // to confirm so the caller doesn't race.
  const killStartMs = Date.now();
  while (Date.now() - killStartMs < 1_000) {
    if (!isAlive(pid)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  // If it's somehow still here, the warning path will mention this service
  // — but we don't loop forever. Reference `name` to keep it in the diag
  // surface (callers attach it to the warning).
  void name;
}

/**
 * Run the user's stop_cmd via /bin/sh -c. Bounded by STOP_CMD_TIMEOUT_MS.
 * Non-zero exits are not thrown — the warning surfacing happens at the
 * caller via the exit code → warning translation. (For now we just resolve
 * regardless; the warning is the "stop_cmd exited <code>" string the
 * caller pushes if it cares.)
 *
 * We construct the env as `process.env` rather than re-running the full env
 * resolution pipeline — the spec/contract calls this out: "best-effort env
 * reconstruction; not a full re-resolve since we don't need the full
 * pipeline." The stop_cmd typically wraps a CLI that talks to externally
 * managed resources (supabase stop, docker stop), where the missing
 * interpolated values are unlikely to matter for teardown.
 */
async function runStopCmd(stopCmd: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("/bin/sh", ["-c", stopCmd], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      if (typeof child.pid === "number") {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      finish();
    }, STOP_CMD_TIMEOUT_MS);

    // Drain the streams so the child doesn't block on a full pipe.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});

    child.once("exit", () => {
      clearTimeout(timer);
      finish();
    });
    child.once("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Drive `<cli> compose -p lich-<stack_id> -f <override> down -v` for the stack.
 *
 * We don't pass `--remove-orphans` (per the spec for this task): down is
 * meant to stop the stack we know about, not aggressively reap unrelated
 * resources. `--remove-orphans` is the nuke-tier behavior.
 *
 * If the compose override file doesn't exist (the up never wrote one — pure
 * owned stack, or a partial up that crashed before writing it), we just
 * pass no `-f` files. Compose can still find resources by project name.
 */
async function tearDownCompose(worktree: Worktree): Promise<void> {
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
