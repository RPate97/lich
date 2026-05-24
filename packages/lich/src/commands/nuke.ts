/**
 * `lich nuke` — the escape hatch.
 *
 * Iterates every stack in `~/.lich/stacks/` (or `$LICH_HOME/stacks/`),
 * performs lich-down semantics for each on a best-effort basis, then
 * cleans up the state directory. Used when something has gone wrong and
 * the user wants a clean slate without poking at compose / docker / their
 * process table by hand.
 *
 * Per spec section 5 and the design's "actionable hints" guidance, this
 * is the command we point users at from error messages like "port
 * allocation failed, run `lich nuke` to kill everything." It must
 * therefore make forward progress on a partially-corrupt state directory:
 *   - Orphan stack dirs (no `state.json`) are silently removed.
 *   - Per-service teardown failures don't abort the whole nuke — we still
 *     try the rest, then report a summary.
 *   - `lich nuke` itself always exits 0, even if some stacks failed
 *     teardown. The point is escape-hatch semantics; "some teardown
 *     warnings, but you're free to `lich up` again" is the right outcome.
 *
 * Out of scope for Plan 1: enumerating *all* docker compose projects on
 * the host to reap orphans whose state directories were already deleted
 * by hand. That belongs to Plan 5/6 (daemon + onramp); for now we only
 * touch compose projects we know about via `state.json`.
 *
 * Per LEV-309, before the PID-kill step we re-parse `lich.yaml` from
 * `snapshot.worktree_path` (best-effort) so we can invoke `stop_cmd`
 * for owned services that declare one. This is the only teardown path
 * that reaches resources owned by `oneshot: true` services — for those,
 * the lich-spawned PID has already exited; the long-lived state lives
 * in docker containers / external state stores that only the user's
 * `stop_cmd` knows how to clean up. Missing/invalid yaml or a non-zero
 * stop_cmd exit logs a warning and continues.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import {
  down as composeDown,
  _exec as composeExec,
  type RunnerCtx,
} from "../compose/runner.js";
import { resolveComposeCli } from "../compose/detect.js";
import { parseConfig } from "../config/parse.js";
import type { LichConfig } from "../config/types.js";
import { resolveEnvForService } from "../env/resolve.js";
import { release } from "../ports/allocator.js";
import { survivors, signalGroup } from "../owned/supervisor.js";
import {
  listStacks,
  removeStackDir,
  stackDir,
} from "../state/directory.js";
import {
  readSnapshot,
  rebuildAllocatedPorts,
  injectOwnedPortEnv,
  type ServiceSnapshot,
  type StackSnapshot,
} from "../state/snapshot.js";
import {
  readStartedLog,
  type StartedEntry,
} from "../state/started-log.js";
import { hashPath, sanitizeName, type Worktree } from "../worktree/detect.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunNukeInput {
  /** `--yes` / `-y` to skip the confirmation prompt. */
  yes?: boolean;
  /**
   * `--rescue`: after the normal state.json-driven teardown, read
   * `~/.lich/started.log` and run cleanup for every entry on a
   * best-effort, idempotent basis. The recovery escape hatch for "I
   * got lich into a weird state and just want it clean" (LEV-311).
   *
   * Default false. Plain `lich nuke` (no `--rescue`) preserves the
   * fast state.json-driven path from LEV-295/309/310 — unchanged.
   */
  rescue?: boolean;
  /** Defaults to `process.stdout`. */
  out?: NodeJS.WritableStream;
  /** Defaults to `process.stderr`. */
  err?: NodeJS.WritableStream;
  /** Defaults to `process.stdin`. Tests pipe in synthetic input. */
  in?: NodeJS.ReadableStream;
}

export type NukeStatus = "nuked" | "failed" | "skipped";

export interface NukeOutcome {
  stackId: string;
  status: NukeStatus;
  /** Human-readable detail (warning / error message), if any. */
  detail?: string;
}

/**
 * One outcome from the `--rescue` scan over `~/.lich/started.log`.
 * Logged regardless of state.json availability — that's the whole
 * point of rescue. `kind` mirrors the StartedEntry kind; `detail` is
 * human-readable context (e.g. "already dead", "container down").
 */
export interface RescueOutcome {
  kind: "pid" | "compose" | "owned";
  /** Display label: pid number, project name, or service name. */
  label: string;
  status: "ok" | "warn";
  detail?: string;
}

export interface RunNukeResult {
  exitCode: number;
  outcomes: NukeOutcome[];
  /** Present when `--rescue` was passed; empty array means the log was empty. */
  rescue?: RescueOutcome[];
}

/**
 * Run the nuke flow end-to-end.
 *
 * Returns exit code 0 in every "ran successfully even if some stacks
 * failed teardown" case — escape-hatch semantics. The only non-zero
 * outcome would be a catastrophic failure inside this function itself,
 * which is not currently expected; the API is shaped to allow it.
 */
export async function runNuke(input: RunNukeInput): Promise<RunNukeResult> {
  const out = input.out ?? process.stdout;
  const stdin = input.in ?? process.stdin;

  const ids = await listStacks();

  // Rescue mode skips the "no stacks to nuke" early return — the whole
  // point of rescue is that state.json may be gone but external
  // resources may still be leaking. We still need to scan the log.
  if (ids.length === 0 && !input.rescue) {
    writeLine(out, "no stacks to nuke");
    return { exitCode: 0, outcomes: [] };
  }

  // Confirmation prompt — skipped if --yes, or if stdin is not a TTY
  // (a non-TTY stdin means we're being scripted; the explicit --yes
  // requirement would force every test/integration to opt in. Plan 1
  // takes the friendlier route: non-TTY stdin is treated as "the
  // caller knows what they're doing.").
  if (!input.yes && isTTY(stdin) && ids.length > 0) {
    writeLine(
      out,
      `will nuke ${ids.length} stack(s): ${ids.join(", ")}`,
    );
    const accepted = await confirm(out, stdin);
    if (!accepted) {
      writeLine(out, "aborted");
      return { exitCode: 0, outcomes: [] };
    }
  }

  const outcomes: NukeOutcome[] = [];
  for (const id of ids) {
    // Each stack runs its own try/catch so one corrupt entry doesn't
    // poison the rest of the run.
    try {
      const outcome = await nukeOneStack(id);
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push({
        stackId: id,
        status: "failed",
        detail: errorMessage(err),
      });
    }
  }

  // Final summary line. Always one line, machine-readable enough to
  // grep against in shell. In rescue mode with no stacks present, we
  // suppress this line — the rescue summary below tells the whole
  // story and the "nuked 0, failed 0, skipped 0" line would just be
  // noise.
  if (ids.length > 0) {
    const nuked = outcomes.filter((o) => o.status === "nuked").length;
    const failed = outcomes.filter((o) => o.status === "failed").length;
    const skipped = outcomes.filter((o) => o.status === "skipped").length;
    writeLine(out, `nuked ${nuked}, failed ${failed}, skipped ${skipped}`);
  }

  // --rescue path: after the normal teardown loop, read the append-only
  // started log and try to clean up every entry. Idempotent per the
  // log's design contract (LEV-311) — re-running is safe.
  if (input.rescue) {
    const rescueOutcomes = await runRescue(out);
    return { exitCode: 0, outcomes, rescue: rescueOutcomes };
  }

  return { exitCode: 0, outcomes };
}

// ---------------------------------------------------------------------------
// Per-stack teardown
// ---------------------------------------------------------------------------

async function nukeOneStack(stackId: string): Promise<NukeOutcome> {
  const snap = await readSnapshot(stackId);

  // Orphan directory: no state.json. Nothing we can do for it beyond
  // sweeping the empty/half-built scaffolding away.
  if (snap === null) {
    await removeStackDir(stackId);
    return { stackId, status: "skipped", detail: "no state.json" };
  }

  const warnings: string[] = [];

  // 1. Re-parse lich.yaml from the worktree to recover `stop_cmd`, which
  // isn't carried by state.json (LEV-309). This is best-effort: if the
  // worktree is gone or the yaml has rotted since `lich up`, we just log
  // a warning and continue with PID-only teardown. Aborting the whole
  // nuke because a yaml is missing would defeat the escape-hatch contract.
  let config: LichConfig | null = null;
  const configPath = join(snap.worktree_path, "lich.yaml");
  if (existsSync(configPath)) {
    const parsed = await parseConfig(configPath).catch((err) => {
      warnings.push(`parse lich.yaml: ${errorMessage(err)}`);
      return null;
    });
    if (parsed && parsed.ok) {
      config = parsed.config;
    } else if (parsed && !parsed.ok) {
      const first = parsed.errors[0];
      warnings.push(
        `parse lich.yaml: ${first?.message ?? "schema validation failed"}`,
      );
    }
  } else {
    warnings.push(
      `parse lich.yaml: not found at ${configPath}`,
    );
  }

  // 2. Run stop_cmd for each owned service that declares one. This is the
  // teardown path for oneshot services (supabase, etc.) whose lich-spawned
  // PID exits cleanly after launch — the long-lived state lives in docker
  // containers / external state stores the stop_cmd knows how to clean up.
  // PID-based kills (step 3 below) can't reach those resources.
  if (config !== null) {
    // Reconstruct the worktree shape from the snapshot. We don't call
    // detectWorktree here because nuke runs across stacks lich didn't
    // necessarily start in this process — the worktree dir may have
    // moved, been renamed, or be entirely gone. The deterministic
    // sanitizeName/hashPath helpers reproduce the same Worktree fields
    // up.ts originally computed, which is what resolveEnvForService and
    // its interpolation context need.
    const worktree: Worktree = reconstructWorktree(snap);
    const allocatedPorts = rebuildAllocatedPorts(snap);

    for (const svc of snap.services) {
      if (svc.kind !== "owned") continue;
      const stopCmd = config.owned?.[svc.name]?.stop_cmd;
      if (typeof stopCmd !== "string" || stopCmd.length === 0) continue;

      // Resolve per-service env via the same pipeline up.ts used at
      // startup, so stop_cmd addresses the same external state the
      // service was started with (LEV-310: supabase project_id and
      // similar). Fall back to process.env on env resolve failure so
      // teardown still runs — better to attempt the stop_cmd with
      // partial env than skip it entirely.
      let stopEnv: NodeJS.ProcessEnv = process.env;
      try {
        stopEnv = await resolveEnvForService({
          config,
          service: { kind: "owned", name: svc.name },
          worktree,
          allocatedPorts,
          projectRoot: snap.worktree_path,
        });
      } catch (err) {
        warnings.push(
          `service ${svc.name} resolve env (fell back to process.env): ${errorMessage(err)}`,
        );
      }
      // LEV-320: layer the per-port env vars (SUPABASE_API_PORT=9000 etc.)
      // that up.ts injected at spawn time. supabase stop reads config.toml
      // which has `port = "env(SUPABASE_API_PORT)"` and fails to parse
      // without them.
      stopEnv = injectOwnedPortEnv(
        stopEnv,
        config.owned?.[svc.name],
        svc.allocated_ports,
      );

      try {
        const result = await runStopCmd(stopCmd, snap.worktree_path, stopEnv);
        // LEV-312: surface the stderr tail with the exit code so the user
        // can actually diagnose a teardown failure. The pre-LEV-312
        // "exit 7" message left them grepping log files by hand.
        if (result.timedOut) {
          const tail = formatStderrTail(result.stderrTail);
          const tailSection = tail ? ` stderr tail: "${tail}"` : "";
          warnings.push(
            `service ${svc.name} stop_cmd exceeded ${STOP_CMD_TIMEOUT_MS}ms timeout and was SIGKILL'd;${tailSection}`,
          );
        } else if (
          typeof result.exitCode === "number" &&
          result.exitCode !== 0
        ) {
          const tail = formatStderrTail(result.stderrTail);
          const tailSection = tail ? ` stderr tail: "${tail}"` : "";
          warnings.push(
            `service ${svc.name} stop_cmd exited ${result.exitCode};${tailSection}`,
          );
        } else if (result.exitCode === null && !result.timedOut) {
          // Signal-killed or spawn-level failure — either is worth noting.
          const tail = formatStderrTail(result.stderrTail);
          const tailSection = tail ? ` stderr tail: "${tail}"` : "";
          warnings.push(
            `service ${svc.name} stop_cmd terminated abnormally (no exit code);${tailSection}`,
          );
        } else if (result.durationMs > STOP_CMD_SLOW_MS) {
          // Slow + exit 0 — surface as a note so the user can verify.
          const seconds = (result.durationMs / 1000).toFixed(1);
          warnings.push(
            `service ${svc.name} stop_cmd took ${seconds}s — verify resources are actually gone`,
          );
        }
      } catch (err) {
        warnings.push(
          `service ${svc.name} stop_cmd: ${errorMessage(err)}`,
        );
      }
    }
  }

  // 3. Kill owned PIDs (best-effort). For oneshot services the PID is
  // already dead and this is a no-op. For long-lived owned services
  // without a stop_cmd, this is still the only teardown path.
  for (const svc of snap.services) {
    if (svc.kind !== "owned" || typeof svc.pid !== "number") continue;
    try {
      const killWarning = await killOwned(svc);
      if (killWarning !== null) {
        warnings.push(killWarning);
      }
    } catch (err) {
      warnings.push(
        `service ${svc.name} (pid ${svc.pid}): ${errorMessage(err)}`,
      );
    }
  }

  // 4. Tear down compose services we know about (best-effort).
  // Plan 1: snapshot doesn't carry the user's base compose file path
  // or the runtime.compose_cli override. We use just the override
  // file (which lich wrote) and fall back to compose-CLI autodetect.
  // If detection fails, or if the user's stack had compose services
  // referenced via a base file we don't know about, the down will
  // mostly no-op — that's the documented "Plan 5/6 finishes orphan
  // reaping" gap.
  const hasComposeServices = snap.services.some((s) => s.kind === "compose");
  if (hasComposeServices) {
    try {
      const composeWarnings = await tearDownCompose(
        snap.stack_id,
        snap.worktree_path,
        snap.worktree_name,
      );
      for (const w of composeWarnings) {
        warnings.push(`compose down: ${w}`);
      }
    } catch (err) {
      warnings.push(`compose down: ${errorMessage(err)}`);
    }
  }

  // 5. Release allocated ports (best-effort; idempotent).
  try {
    await release(snap.stack_id);
  } catch (err) {
    warnings.push(`release ports: ${errorMessage(err)}`);
  }

  // 6. Remove the state directory. This is the "done" signal — if we
  // got here, lich considers the stack erased even if some upstream
  // step warned.
  try {
    await removeStackDir(snap.stack_id);
  } catch (err) {
    // Failing to remove the state directory is the one outcome we
    // surface as a true failure — without this step, a subsequent
    // `lich nuke` would re-process the same stack. The user needs to
    // know.
    return {
      stackId: snap.stack_id,
      status: "failed",
      detail: `remove state dir: ${errorMessage(err)}`,
    };
  }

  return {
    stackId: snap.stack_id,
    status: "nuked",
    detail: warnings.length > 0 ? warnings.join("; ") : undefined,
  };
}

/** Cap on stop_cmd execution time. Mirrors `commands/down.ts`. */
const STOP_CMD_TIMEOUT_MS = 30_000;
/**
 * Stderr ring-buffer size for stop_cmd capture. Mirrors `commands/down.ts`
 * — keeps the warning string bounded while preserving enough context to
 * debug a teardown failure. (LEV-312)
 */
const STOP_CMD_STDERR_RING_BYTES = 4 * 1024;
/**
 * Threshold above which a stop_cmd that exited 0 is flagged as slow.
 * (LEV-312)
 */
const STOP_CMD_SLOW_MS = 5_000;

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
 * Run a user-supplied `stop_cmd` for an owned service via `/bin/sh -c`.
 * Bounded by `STOP_CMD_TIMEOUT_MS`; if the command hasn't exited by then
 * we SIGKILL it and move on.
 *
 * Resolves with a {@link StopCmdResult} carrying exit code, stderr tail
 * (ring buffer, capped at `STOP_CMD_STDERR_RING_BYTES`), wall-clock
 * duration, and whether the timeout fired — same shape as the helper in
 * `commands/down.ts` so both teardown paths produce comparable warnings.
 * (LEV-312)
 *
 * Per-service env resolved via the same pipeline used at startup, so
 * stop_cmd addresses the same external state the service was started
 * with (LEV-310).
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

    // Stderr ring buffer (LEV-312) — see commands/down.ts for the
    // identical pattern + rationale.
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
      exitCode = null;
      finish();
    });
  });
}

/**
 * Compact a stderr tail for inclusion in a single-line warning. Mirrors
 * the helper in `commands/down.ts`. (LEV-312)
 */
function formatStderrTail(tail: string): string {
  return tail.replace(/\s+/g, " ").trim();
}

/**
 * Signal-based teardown for one owned service. SIGTERM, wait ~2s,
 * escalate to SIGKILL if still alive. `process.kill(pid, 0)` is the
 * standard "is this pid alive?" probe — it returns normally if the
 * process exists and we have permission to signal it, ESRCH otherwise.
 *
 * We don't have access to the original child handle (lich nuke runs
 * across stacks lich didn't necessarily start in this process), so we
 * can't use the supervisor's `stop()` directly. Pure pid-based signaling
 * is the cross-process tool we have.
 *
 * Returns `null` on success (process is gone), or a warning string when
 * SIGKILL itself didn't reap the pid within the grace window (LEV-312).
 * Throws only for unexpected errno (e.g. EPERM) — the caller's catch
 * block turns those into warnings.
 */
async function killOwned(svc: ServiceSnapshot): Promise<string | null> {
  const pid = svc.pid;
  if (typeof pid !== "number") return null;

  if (!isAlive(pid)) return null; // already gone — nothing to do

  // SIGTERM the leader's process group. With detached:true at spawn,
  // pid == pgid and every grandchild inherits the group, so this one
  // syscall reaches the whole tree (`bun run dev` → `bun --hot src`,
  // `bun run dev` → next-server, etc).
  try {
    signalGroup(pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw err;
  }

  // Poll for the group to drain. 2s total, polling every 50ms.
  const startMs = Date.now();
  while (Date.now() - startMs < 2_000) {
    if (!isAlive(pid) && survivors(pid).length === 0) return null;
    await sleep(50);
  }

  // Still alive after the grace window. Escalate across the group.
  try {
    signalGroup(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw err;
  }

  // SIGKILL is uncatchable; the kernel will reap shortly. One brief
  // poll is enough to confirm so callers don't race.
  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid) && survivors(pid).length === 0) return null;
    await sleep(50);
  }
  // LEV-312: still alive after SIGKILL + 1s grace. Pathological (D-state,
  // zombie, container/pid mismatch) but the user's "lich said it killed
  // the thing" contract requires us to say so rather than silently
  // claim success.
  const lingering = survivors(pid);
  return `pid(s) ${lingering.join(", ")} still alive after SIGKILL + 1s grace; service "${svc.name}" may still be running`;
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

/**
 * Drive `<compose-cli> compose down -v --remove-orphans` for a stack,
 * then verify the project actually emptied out (LEV-312). If
 * `compose ps -q` still returns container IDs, force-remove each with
 * `<cli> rm -f <id>` and re-check. Anything still alive after the salvage
 * surfaces as a loud warning naming the surviving container IDs.
 *
 * Plan 1: we only know the override file's path; the user's base
 * `compose_file` isn't in the snapshot. Compose treats `-f` files
 * additively, so passing just the override (plus whatever the project
 * label tells compose) lets compose find the running containers by
 * project name and tear them down. Containers without a matching
 * compose project label aren't lich's responsibility.
 *
 * Returns the list of warnings the caller should attach to the per-stack
 * outcome detail.
 */
async function tearDownCompose(
  stackId: string,
  worktreePath: string,
  worktreeName: string,
): Promise<string[]> {
  const cli = await resolveComposeCli(undefined);
  const overridePath = join(stackDir(stackId), "compose.override.yaml");

  // Project name follows the convention documented on `RunnerCtx.project`:
  // `lich-<worktree.name>-<stack_id_short>`. The stack_id format is
  // `<name>-<8-char-hash>`, so the short suffix is the last segment.
  const shortId = stackId.includes("-")
    ? stackId.slice(stackId.lastIndexOf("-") + 1)
    : stackId;
  const project = `lich-${worktreeName}-${shortId}`;

  const ctx: RunnerCtx = {
    cli,
    project,
    files: [overridePath],
    cwd: worktreePath,
  };

  // Best-effort: a non-zero exit (compose project doesn't exist, override
  // file missing, etc.) doesn't throw — we just move on. The state dir
  // removal that follows is what definitively "ends" the stack.
  await composeDown(ctx, { volumes: true, remove_orphans: true });

  // LEV-312: post-down verification. See commands/down.ts for the
  // identical pattern + rationale.
  return verifyComposeTeardown(ctx);
}

/**
 * Verify the compose project is actually empty after `down`. Mirrors the
 * helper in `commands/down.ts`. Returns warnings for anything still alive
 * after the force-remove salvage. (LEV-312)
 */
async function verifyComposeTeardown(ctx: RunnerCtx): Promise<string[]> {
  const remaining = await composePsQ(ctx);
  if (remaining.length === 0) return [];

  // Attempt force-remove on each survivor.
  for (const id of remaining) {
    await forceRemoveContainer(ctx.cli.cmd, id);
  }

  const stillAlive = await composePsQ(ctx);
  if (stillAlive.length > 0) {
    return [
      `compose teardown could not fully remove project "${ctx.project}"; ${stillAlive.length} container(s) still alive after force-remove: ${stillAlive.join(", ")}`,
    ];
  }
  return [
    `compose down left ${remaining.length} container(s) running for project "${ctx.project}"; force-removed via ${ctx.cli.cmd} rm -f`,
  ];
}

/**
 * Run `<cli> compose -p <project> -f <file>... ps -q` and parse stdout
 * into a list of container IDs. Mirrors the helper in `commands/down.ts`.
 * (LEV-312)
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
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * `<cli> rm -f <container_id>`. Best-effort — failures are silent because
 * the immediate re-check catches anything we couldn't kill. Mirrors the
 * helper in `commands/down.ts`. (LEV-312)
 */
async function forceRemoveContainer(cli: string, id: string): Promise<void> {
  await composeExec.current(cli, ["rm", "-f", id], {}).catch(() => {
    /* best-effort; the re-check is the source of truth */
  });
}

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

/**
 * Prompt for `[y/N]`. Returns true for `y`/`yes` (case-insensitive),
 * false for anything else including empty input, EOF, or `n`/`no`.
 *
 * Implemented with `readline.createInterface` over the caller-supplied
 * stdin so tests can pipe a synthetic stream.
 */
async function confirm(
  out: NodeJS.WritableStream,
  stdin: NodeJS.ReadableStream,
): Promise<boolean> {
  out.write("Continue? [y/N] ");

  // `terminal: false` keeps readline from trying to draw a cursor on
  // non-TTY streams (the test pipes are Readable, not TTY). We only need
  // the first line; close the interface immediately after.
  const rl = createInterface({
    input: stdin,
    output: out,
    terminal: false,
  });

  try {
    const answer = await new Promise<string>((resolve) => {
      let resolved = false;
      const settle = (value: string): void => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };
      rl.once("line", (line: string) => settle(line));
      // EOF before any input arrives → "no".
      rl.once("close", () => settle(""));
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Is this stream a TTY (interactive terminal)? `process.stdin` exposes
 * `isTTY` on tty.ReadStream; non-TTY streams don't have the property.
 * We treat absence as non-interactive.
 */
function isTTY(stdin: NodeJS.ReadableStream): boolean {
  return Boolean((stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY);
}

// ---------------------------------------------------------------------------
// Worktree reconstruction
// ---------------------------------------------------------------------------

/**
 * Synthesize a {@link Worktree} from a {@link StackSnapshot}.
 *
 * `lich nuke` may run against stacks lich didn't start in this process —
 * the worktree directory may have moved, been renamed, or be entirely
 * gone. We can't call `detectWorktree` (which walks the filesystem from
 * a cwd looking for lich.yaml) safely from inside nuke; the snapshot
 * holds everything we need to rebuild the Worktree shape using the same
 * deterministic helpers (`sanitizeName`, `hashPath`) `up.ts` used at
 * startup time. Since both are pure functions of `worktree_name` / path,
 * the synthesized `id` matches the original whenever the original
 * `worktree_path` is reproduced on disk (which the snapshot stores).
 */
function reconstructWorktree(snapshot: StackSnapshot): Worktree {
  return {
    name: sanitizeName(snapshot.worktree_name),
    id: hashPath(snapshot.worktree_path),
    path: snapshot.worktree_path,
    stack_id: snapshot.stack_id,
  };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function writeLine(out: NodeJS.WritableStream, text: string): void {
  out.write(`${text}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Rescue (--rescue) — LEV-311
//
// Reads the append-only started log and runs idempotent cleanup per
// entry. The whole subsystem lives in this dedicated section to keep
// blast radius small and concentrate the new code, which makes merge
// conflicts with the parallel LEV-312 work surgical rather than
// scattered.
//
// Cleanup semantics:
//   - `kind: pid`     SIGTERM, wait 2s, SIGKILL if alive. Dead PIDs are
//                     silently OK.
//   - `kind: compose` `compose down -v --remove-orphans -p <project>`
//                     with the logged `files`. Use the CLI named in the
//                     entry if available; autodetect otherwise.
//                     Already-down projects are exit 0 (compose itself
//                     is idempotent).
//   - `kind: owned`   If `stop_cmd` set, spawn `/bin/sh -c <stop_cmd>`
//                     with `cwd: entry.cwd, env: entry.env`. The logged
//                     env is the resolved env from start time (critical
//                     for supabase-style tools whose stop_cmd reads
//                     SUPABASE_PROJECT_ID etc.). Without stop_cmd,
//                     there's nothing actionable in this entry — the
//                     paired `kind: pid` entry would have handled it.
// ---------------------------------------------------------------------------

/** Cap on a single rescue stop_cmd. Mirrors the main nuke teardown. */
const RESCUE_STOP_CMD_TIMEOUT_MS = 30_000;

/** Grace period before SIGKILL escalation in the rescue PID path. */
const RESCUE_SIGTERM_GRACE_MS = 2_000;

/**
 * Top-level rescue driver. Reads the log, dispatches per entry, prints
 * a summary section, and returns the per-entry outcomes.
 *
 * `out` is the same stream as the main nuke output — the summary block
 * appears AFTER the regular "nuked X, failed Y, skipped Z" line so
 * humans can scan top-down and machines (`grep "Rescue scan"`) can
 * still find the rescue boundary.
 */
async function runRescue(
  out: NodeJS.WritableStream,
): Promise<RescueOutcome[]> {
  let entries: StartedEntry[];
  try {
    entries = await readStartedLog();
  } catch (err) {
    // Catastrophic read failure (permissions, etc.) — surface as a
    // warning section and bail. The exit code stays 0 because rescue
    // can't make things worse than they already are.
    writeLine(out, "");
    writeLine(
      out,
      `Rescue scan: failed to read started.log (${errorMessage(err)})`,
    );
    return [];
  }

  writeLine(out, "");
  writeLine(
    out,
    `Rescue scan (${entries.length} entr${entries.length === 1 ? "y" : "ies"} in started.log):`,
  );

  if (entries.length === 0) {
    writeLine(out, "  (nothing to do)");
    return [];
  }

  const outcomes: RescueOutcome[] = [];
  for (const entry of entries) {
    const outcome = await rescueOne(entry).catch((err) => ({
      kind: entry.kind,
      label: rescueLabel(entry),
      status: "warn" as const,
      detail: errorMessage(err),
    }));
    outcomes.push(outcome);
    // Emit the one-line summary for this entry immediately so the user
    // sees progress on long rescues rather than a final block at the end.
    writeLine(out, `  ${formatRescueLine(outcome)}`);
  }

  return outcomes;
}

/**
 * Dispatch one rescue entry to the correct cleanup path. Each path is
 * idempotent — running twice in a row finds nothing new on the second
 * pass. Never throws (errors map to `status: "warn"` outcomes) so the
 * caller's loop can keep going past one bad entry.
 */
async function rescueOne(entry: StartedEntry): Promise<RescueOutcome> {
  if (entry.kind === "pid") {
    return rescuePid(entry);
  }
  if (entry.kind === "compose") {
    return rescueCompose(entry);
  }
  if (entry.kind === "owned") {
    return rescueOwned(entry);
  }
  // Defensive — the type system already exhausts the union, but a
  // forward-compat new `kind` from a future writer should not crash.
  return {
    kind: (entry as { kind: "pid" | "compose" | "owned" }).kind,
    label: "unknown",
    status: "warn",
    detail: "unknown rescue entry kind",
  };
}

/**
 * SIGTERM → grace → SIGKILL on a logged PID. Dead PIDs (ESRCH on
 * `process.kill(pid, 0)`) are the expected case for rescues run long
 * after the original lich process exited and are reported as OK.
 */
async function rescuePid(
  entry: Extract<StartedEntry, { kind: "pid" }>,
): Promise<RescueOutcome> {
  const label = `pid ${entry.pid} (${entry.service})`;

  if (!isAlive(entry.pid)) {
    return { kind: "pid", label, status: "ok", detail: "already dead" };
  }

  // SIGTERM the leader's process group. Owned services are spawned with
  // detached:true (pid == pgid), so this reaches the whole tree atomically.
  try {
    signalGroup(entry.pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return { kind: "pid", label, status: "ok", detail: "already dead" };
    }
    return {
      kind: "pid",
      label,
      status: "warn",
      detail: `SIGTERM: ${errorMessage(err)}`,
    };
  }

  // Wait up to grace for the group to drain.
  const startMs = Date.now();
  while (Date.now() - startMs < RESCUE_SIGTERM_GRACE_MS) {
    if (!isAlive(entry.pid) && survivors(entry.pid).length === 0) {
      return { kind: "pid", label, status: "ok", detail: "SIGTERM" };
    }
    await sleep(50);
  }

  // Escalate across the group.
  try {
    signalGroup(entry.pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return {
        kind: "pid",
        label,
        status: "ok",
        detail: "exited during grace",
      };
    }
    return {
      kind: "pid",
      label,
      status: "warn",
      detail: `SIGKILL: ${errorMessage(err)}`,
    };
  }

  // Brief verify so we don't report success on a still-alive pid.
  for (let i = 0; i < 20; i++) {
    if (!isAlive(entry.pid) && survivors(entry.pid).length === 0) {
      return { kind: "pid", label, status: "ok", detail: "SIGKILL" };
    }
    await sleep(50);
  }
  const lingering = survivors(entry.pid);
  return {
    kind: "pid",
    label,
    status: "warn",
    detail: `pid(s) ${lingering.join(", ")} still alive after SIGKILL — manual cleanup needed`,
  };
}

/**
 * `<compose-cli> compose -p <project> -f <files...> down -v --remove-orphans`.
 *
 * Uses the CLI named in the entry if available, falls back to autodetect
 * (e.g. machine moved from podman to docker since the entry was logged).
 * Both detection and the down call are best-effort — already-down
 * projects exit 0, and detection failure surfaces as a warn outcome
 * without aborting the rescue scan.
 */
async function rescueCompose(
  entry: Extract<StartedEntry, { kind: "compose" }>,
): Promise<RescueOutcome> {
  const label = `compose project ${entry.project}`;

  let cli;
  try {
    // Prefer the CLI the entry was logged with; resolveComposeCli probes
    // that it's still available, falling through to autodetect on a
    // missing/changed override.
    cli = await resolveComposeCli(entry.compose_cli).catch(async () => {
      return await resolveComposeCli(undefined);
    });
  } catch (err) {
    return {
      kind: "compose",
      label,
      status: "warn",
      detail: `no compose CLI available: ${errorMessage(err)}`,
    };
  }

  const ctx: RunnerCtx = {
    cli,
    project: entry.project,
    files: [...entry.files],
    cwd: entry.cwd,
  };

  try {
    const result = await composeDown(ctx, {
      volumes: true,
      remove_orphans: true,
    });
    // Non-zero exit is expected for already-down projects (compose
    // sometimes reports as a warning). Surface the exit code only when
    // it's actually non-zero — even then it's "warn" not "fail" because
    // the project is most likely already cleaned up.
    if (result.exitCode !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || "")
        .split("\n")
        .slice(0, 2)
        .join(" / ");
      return {
        kind: "compose",
        label,
        status: "warn",
        detail: `compose down exited ${result.exitCode}${detail ? `: ${detail}` : ""}`,
      };
    }
    return { kind: "compose", label, status: "ok", detail: "compose down" };
  } catch (err) {
    return {
      kind: "compose",
      label,
      status: "warn",
      detail: `compose down: ${errorMessage(err)}`,
    };
  }
}

/**
 * Spawn `/bin/sh -c <stop_cmd>` with the LOGGED cwd + env. Critical
 * detail: the env comes from `entry.env`, NOT `process.env`. The whole
 * reason this works for supabase et al. is that the resolved env
 * captured at start time (with SUPABASE_PROJECT_ID etc. interpolated)
 * is what stop_cmd needs to address the same external state — bare
 * `process.env` would re-introduce the LEV-310 class of bug at recovery
 * time.
 *
 * Entries without `stop_cmd` are no-ops: there's nothing actionable.
 * A paired `kind: pid` entry (logged by up.ts for every long-lived
 * owned service) handles the process side; the `kind: owned` entry's
 * only contribution is the stop_cmd path.
 */
async function rescueOwned(
  entry: Extract<StartedEntry, { kind: "owned" }>,
): Promise<RescueOutcome> {
  const label = `owned service ${entry.service}`;

  if (!entry.stop_cmd) {
    return {
      kind: "owned",
      label,
      status: "ok",
      detail: "no stop_cmd",
    };
  }

  return new Promise<RescueOutcome>((resolve) => {
    const child = spawn("/bin/sh", ["-c", entry.stop_cmd!], {
      cwd: entry.cwd,
      env: entry.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const finish = (outcome: RescueOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
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
      finish({
        kind: "owned",
        label,
        status: "warn",
        detail: `stop_cmd timed out after ${RESCUE_STOP_CMD_TIMEOUT_MS}ms`,
      });
    }, RESCUE_STOP_CMD_TIMEOUT_MS);

    // Drain output so the child doesn't block on a full pipe. We don't
    // tee to a log file — the rescue summary captures the outcome, and
    // the per-service log is owned by the original stack dir (which may
    // be gone, which is the whole reason rescue exists).
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({
          kind: "owned",
          label,
          status: "ok",
          detail: "stop_cmd",
        });
        return;
      }
      finish({
        kind: "owned",
        label,
        status: "warn",
        detail: `stop_cmd exited ${code}`,
      });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      finish({
        kind: "owned",
        label,
        status: "warn",
        detail: `stop_cmd: ${errorMessage(err)}`,
      });
    });
  });
}

/** Compact label used in the rescue summary block. */
function rescueLabel(entry: StartedEntry): string {
  if (entry.kind === "pid") return `pid ${entry.pid} (${entry.service})`;
  if (entry.kind === "compose") return `compose project ${entry.project}`;
  return `owned service ${entry.service}`;
}

/**
 * Format one rescue outcome as a single line. ASCII-only (no
 * non-printable / non-ASCII chars) so output renders the same across
 * terminals, CI logs, and file redirects.
 */
function formatRescueLine(outcome: RescueOutcome): string {
  const marker = outcome.status === "ok" ? "ok" : "!!";
  const tail = outcome.detail ? ` (${outcome.detail})` : "";
  return `[${marker}] ${outcome.label}${tail}`;
}
