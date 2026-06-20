/**
 * `lich nuke` — the escape hatch.
 *
 * Iterates every stack in `~/.lich/stacks/`, performs `lich down` semantics best-effort, removes the state dir.
 * The command users get pointed at by hints like "port allocation failed; run `lich nuke`."
 *
 * - Orphan stack dirs (no state.json) are silently removed.
 * - Per-service failures don't abort the run — collect, summarize, keep going.
 * - Always exits 0. The point is escape-hatch semantics: "some warnings, but you're free to `lich up` again."
 * - Before the PID-kill step we re-parse lich.yaml to recover stop_cmd (oneshot services need this — their PIDs are
 *   already gone; only stop_cmd reaches the long-lived external state).
 *
 * Doesn't reap docker compose projects whose state.json was already deleted by hand — only what we know via state.json.
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
import { sweepOwnedContainers } from "../owned/containers.js";
import { parseConfig } from "../config/parse.js";
import type { LichConfig } from "../config/types.js";
import {
  clearDaemonPid,
  isDaemonAlive,
  readDaemonPid,
} from "../daemon/pid-file.js";
import {
  resolveEnvForService,
  resolveSharedEnvBase,
  type SharedEnvBase,
} from "../env/resolve.js";
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
import { findMainWorktreePath, hashPath, sanitizeName, type Worktree } from "../worktree/detect.js";

export interface RunNukeInput {
  /** `--yes` / `-y` skips the confirmation prompt. */
  yes?: boolean;
  /** `--rescue`: after the state.json-driven teardown, walk `~/.lich/started.log` and clean up every entry (idempotent). */
  rescue?: boolean;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  in?: NodeJS.ReadableStream;
}

export type NukeStatus = "nuked" | "failed" | "skipped";

export interface NukeOutcome {
  stackId: string;
  status: NukeStatus;
  detail?: string;
}

/** Outcome from a single `--rescue` scan entry. */
export interface RescueOutcome {
  kind: "pid" | "compose" | "owned";
  /** Display label: pid, project, or service name. */
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

/** Always exits 0 — escape-hatch semantics. Non-zero would mean catastrophic in-function failure. */
export async function runNuke(input: RunNukeInput): Promise<RunNukeResult> {
  const out = input.out ?? process.stdout;
  const stdin = input.in ?? process.stdin;

  const ids = await listStacks();

  // Rescue mode skips the empty-early-return — state.json may be gone but resources may still be leaking.
  // Even on the early-return path we kill the daemon — stray daemons are exactly the cruft nuke is for.
  if (ids.length === 0 && !input.rescue) {
    const daemonWarning = await killDaemon();
    if (daemonWarning !== null) {
      writeLine(out, `warning: ${daemonWarning}`);
    }
    writeLine(out, "no stacks to nuke");
    return { exitCode: 0, outcomes: [] };
  }

  // Non-TTY stdin = scripted; skip the prompt rather than force every test/integration to pass `--yes`.
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
    // Per-stack try/catch so a corrupt entry doesn't poison the rest of the run.
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

  // Kill the daemon so the dashboard/proxy stop NOW rather than waiting ~30s for the daemon's auto-shutdown.
  const daemonWarning = await killDaemon();
  if (daemonWarning !== null) {
    writeLine(out, `warning: ${daemonWarning}`);
  }

  // Suppress the summary line in rescue mode when no stacks existed — rescue's own summary tells the story.
  if (ids.length > 0) {
    const nuked = outcomes.filter((o) => o.status === "nuked").length;
    const failed = outcomes.filter((o) => o.status === "failed").length;
    const skipped = outcomes.filter((o) => o.status === "skipped").length;
    writeLine(out, `nuked ${nuked}, failed ${failed}, skipped ${skipped}`);
  }

  if (input.rescue) {
    const rescueOutcomes = await runRescue(out);
    return { exitCode: 0, outcomes, rescue: rescueOutcomes };
  }

  return { exitCode: 0, outcomes };
}

async function nukeOneStack(stackId: string): Promise<NukeOutcome> {
  const snap = await readSnapshot(stackId);

  // Orphan directory: no state.json — just sweep the scaffolding away.
  if (snap === null) {
    await removeStackDir(stackId);
    return { stackId, status: "skipped", detail: "no state.json" };
  }

  const warnings: string[] = [];

  // Re-parse the yaml for stop_cmd (not in state.json). Best-effort: missing/invalid → PID-only teardown.
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

  // stop_cmd for each owned service that declares one — only teardown path that reaches a oneshot's external state.
  if (config !== null) {
    // Reconstruct Worktree from snapshot (NOT detectWorktree — the worktree dir may have moved/been renamed/be gone).
    const worktree: Worktree = reconstructWorktree(snap);
    const allocatedPorts = rebuildAllocatedPorts(snap);
    // Resolved lazily on the first owned stop_cmd, then reused so top-level env_from doesn't re-run per service.
    let sharedEnvBase: SharedEnvBase | undefined;

    for (const svc of snap.services) {
      if (svc.kind !== "owned") continue;
      const stopCmd = config.owned?.[svc.name]?.stop_cmd;
      if (typeof stopCmd !== "string" || stopCmd.length === 0) continue;

      // Resolve per-service env via the up.ts pipeline so stop_cmd addresses the same external state (project_id, etc.).
      // Env-resolve failure falls back to process.env — better to attempt stop_cmd with partial env than skip entirely.
      let stopEnv: NodeJS.ProcessEnv = process.env;
      try {
        if (sharedEnvBase === undefined) {
          sharedEnvBase = await resolveSharedEnvBase({
            config,
            worktree,
            allocatedPorts,
            projectRoot: snap.worktree_path,
          });
        }
        stopEnv = await resolveEnvForService({
          config,
          service: { kind: "owned", name: svc.name },
          worktree,
          allocatedPorts,
          projectRoot: snap.worktree_path,
          baseEnv: sharedEnvBase,
        });
      } catch (err) {
        warnings.push(
          `service ${svc.name} resolve env (fell back to process.env): ${errorMessage(err)}`,
        );
      }
      // Per-port env vars (`SUPABASE_API_PORT=9000` etc.) so tools like `supabase stop` can parse config.toml.
      stopEnv = injectOwnedPortEnv(
        stopEnv,
        config.owned?.[svc.name],
        svc.allocated_ports,
      );

      try {
        const result = await runStopCmd(stopCmd, snap.worktree_path, stopEnv);
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
          // External SIGKILL or spawn-level failure.
          const tail = formatStderrTail(result.stderrTail);
          const tailSection = tail ? ` stderr tail: "${tail}"` : "";
          warnings.push(
            `service ${svc.name} stop_cmd terminated abnormally (no exit code);${tailSection}`,
          );
        } else if (result.durationMs > STOP_CMD_SLOW_MS) {
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

  // owned_containers sweep — runs regardless of whether config is available. Snapshot wins (post-LEV-534);
  // yaml fallback covers legacy snapshots. No-op when no service declares the field.
  for (const svc of snap.services) {
    if (svc.kind !== "owned") continue;
    const spec = svc.owned_containers ?? config?.owned?.[svc.name]?.owned_containers;
    if (!spec) continue;
    try {
      const cli = await resolveComposeCli(undefined);
      const result = await sweepOwnedContainers(cli.cmd, spec);
      if (result.removed.length > 0) {
        const filterDesc = spec.label !== undefined ? `label=${spec.label}` : `name=${spec.name_pattern}`;
        warnings.push(
          `service ${svc.name} owned_containers sweep removed ${result.removed.length} straggler container(s) matching ${filterDesc}: ${result.removed.join(", ")}`,
        );
      }
      if (result.stragglers.length > 0) {
        const filterDesc = spec.label !== undefined ? `label=${spec.label}` : `name=${spec.name_pattern}`;
        warnings.push(
          `service ${svc.name} owned_containers sweep: ${result.stragglers.length} container(s) matching ${filterDesc} still present after rm -f: ${result.stragglers.join(", ")}`,
        );
      }
    } catch (err) {
      warnings.push(
        `service ${svc.name} owned_containers sweep: ${errorMessage(err)}`,
      );
    }
  }

  // Kill owned PIDs (best-effort). Oneshots are no-ops (already dead). Long-lived owned services without stop_cmd: only path.
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

  // Tear down known compose services. Snapshot doesn't carry the user's base compose file path or the runtime.compose_cli override —
  // we use the override lich wrote and fall back to autodetect. Containers referenced via an unknown base file will mostly no-op (documented orphan-reap gap).
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

  try {
    await release(snap.stack_id);
  } catch (err) {
    warnings.push(`release ports: ${errorMessage(err)}`);
  }

  try {
    await removeStackDir(snap.stack_id);
  } catch (err) {
    // The one outcome we surface as failure — without state dir removal, a subsequent `lich nuke` would re-process the same stack.
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

const STOP_CMD_TIMEOUT_MS = 30_000;
const STOP_CMD_STDERR_RING_BYTES = 4 * 1024;
const STOP_CMD_SLOW_MS = 5_000;

interface StopCmdResult {
  /** Exit code; null if killed by signal (timeout). */
  exitCode: number | null;
  stderrTail: string;
  durationMs: number;
  timedOut: boolean;
}

/** Run the user's stop_cmd via `/bin/sh -c`, bounded by STOP_CMD_TIMEOUT_MS. Mirrors commands/down.ts's runStopCmd shape. */
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
      exitCode = null;
      finish();
    });
  });
}

/** Compact a stderr tail into a single-line warning. */
function formatStderrTail(tail: string): string {
  return tail.replace(/\s+/g, " ").trim();
}

/**
 * Signal-based teardown for one owned service: SIGTERM → 2s grace → SIGKILL.
 * Pure pid-based signaling because nuke runs across stacks this process didn't start — no supervisor handle to use.
 * Returns null on success, a warning string on lingering survivors. Throws only for unexpected errno (EPERM etc.).
 */
async function killOwned(svc: ServiceSnapshot): Promise<string | null> {
  const pid = svc.pid;
  if (typeof pid !== "number") return null;

  if (!isAlive(pid)) return null;

  // detached:true at spawn means pid == pgid; signal the group to reach grandchildren atomically.
  try {
    signalGroup(pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw err;
  }

  const startMs = Date.now();
  while (Date.now() - startMs < 2_000) {
    if (!isAlive(pid) && survivors(pid).length === 0) return null;
    await sleep(50);
  }

  try {
    signalGroup(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw err;
  }

  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid) && survivors(pid).length === 0) return null;
    await sleep(50);
  }
  // Pathological — D-state, zombie, or container/pid mismatch. Surface honestly.
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

/** Time to wait for the daemon to exit after SIGTERM before SIGKILL. */
const DAEMON_SIGTERM_GRACE_MS = 5_000;

/**
 * SIGTERM the daemon (if alive), 5s grace, SIGKILL, then unconditionally clear the PID file so the next `lich up` starts clean.
 * The daemon's auto-shutdown takes ~30s by design; nuke can't wait that long.
 * Daemon is a single Bun process — no group signaling needed.
 *
 * Returns null on clean outcomes (no daemon, daemon stopped, SIGKILL reaped) or a warning string otherwise. Never flips exit code.
 */
async function killDaemon(): Promise<string | null> {
  let pid: number | null;
  try {
    pid = await readDaemonPid();
  } catch (err) {
    // Defensive: readDaemonPid swallows ENOENT, so any throw is unexpected (permissions, IO).
    return `read daemon.pid: ${errorMessage(err)}`;
  }

  if (pid === null) {
    return null;
  }

  // Stale-file case (daemon crashed without clearing): silent sweep.
  const alive = await isDaemonAlive();
  if (!alive) {
    await clearDaemonPid().catch(() => {});
    return null;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      // Race: died between isDaemonAlive and signal.
      await clearDaemonPid().catch(() => {});
      return null;
    }
    // EPERM or unexpected — surface but still clear the file.
    await clearDaemonPid().catch(() => {});
    return `daemon SIGTERM (pid ${pid}): ${errorMessage(err)}`;
  }

  const startMs = Date.now();
  while (Date.now() - startMs < DAEMON_SIGTERM_GRACE_MS) {
    if (!isAlive(pid)) {
      await clearDaemonPid().catch(() => {});
      return null;
    }
    await sleep(50);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      await clearDaemonPid().catch(() => {});
      return null;
    }
    await clearDaemonPid().catch(() => {});
    return `daemon SIGKILL (pid ${pid}): ${errorMessage(err)}`;
  }

  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid)) {
      await clearDaemonPid().catch(() => {});
      return null;
    }
    await sleep(50);
  }

  // Pathological — surface loudly but still clear the file so the next `lich up` doesn't see stale state.
  await clearDaemonPid().catch(() => {});
  return `daemon pid ${pid} still alive after SIGKILL + 1s grace; manual cleanup may be needed`;
}

/**
 * `compose down -v --remove-orphans` for a stack, then verify the project emptied (force-remove survivors).
 * Snapshot doesn't carry the user's base compose_file path — we autodetect the CLI and rely on project-label discovery.
 */
async function tearDownCompose(
  stackId: string,
  worktreePath: string,
  worktreeName: string,
): Promise<string[]> {
  const cli = await resolveComposeCli(undefined);

  // Project name: `lich-<worktree.name>-<stack_id_short>` per RunnerCtx.project convention. stack_id is `<name>-<8-char-hash>`.
  const shortId = stackId.includes("-")
    ? stackId.slice(stackId.lastIndexOf("-") + 1)
    : stackId;
  const project = `lich-${worktreeName}-${shortId}`;

  // Pass NO `-f` files — compose finds containers via project label alone. Passing the override caused validation failures for
  // stacks whose override file only declared ports + env (no image/build).
  const ctx: RunnerCtx = {
    cli,
    project,
    files: [],
    cwd: worktreePath,
  };

  // Best-effort: non-zero exits (project doesn't exist, etc.) don't throw — the state dir removal is what definitively ends the stack.
  await composeDown(ctx, { volumes: true, remove_orphans: true });

  return verifyComposeTeardown(ctx);
}

/** Mirrors commands/down.ts's verifyComposeTeardown — post-down ps -q, force-remove survivors, warn on remainder. */
async function verifyComposeTeardown(ctx: RunnerCtx): Promise<string[]> {
  const remaining = await composePsQ(ctx);
  if (remaining.length === 0) return [];

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

async function forceRemoveContainer(cli: string, id: string): Promise<void> {
  await composeExec.current(cli, ["rm", "-f", id], {}).catch(() => {
    /* best-effort; the re-check is the source of truth */
  });
}

/** `[y/N]` prompt. True for y/yes (case-insensitive), false for everything else including EOF. */
async function confirm(
  out: NodeJS.WritableStream,
  stdin: NodeJS.ReadableStream,
): Promise<boolean> {
  out.write("Continue? [y/N] ");

  // `terminal: false` so readline doesn't try to draw a cursor on non-TTY streams (test pipes are Readable).
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

function isTTY(stdin: NodeJS.ReadableStream): boolean {
  return Boolean((stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY);
}

/**
 * Synthesize a {@link Worktree} from a snapshot — nuke may run against stacks this process didn't start (worktree dir
 * may have moved/be gone), so we can't use detectWorktree. sanitizeName + hashPath are pure functions of name/path;
 * the synthesized id matches the original whenever worktree_path is reproduced on disk.
 */
function reconstructWorktree(snapshot: StackSnapshot): Worktree {
  return {
    name: sanitizeName(snapshot.worktree_name),
    id: hashPath(snapshot.worktree_path),
    path: snapshot.worktree_path,
    stack_id: snapshot.stack_id,
    main_path: findMainWorktreePath(snapshot.worktree_path) ?? snapshot.worktree_path,
  };
}

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

/**
 * --rescue: reads `~/.lich/started.log` and runs idempotent cleanup per entry.
 *
 *   pid      SIGTERM → 2s grace → SIGKILL. Dead PIDs are silently OK.
 *   compose  `compose down -v --remove-orphans -p <project>` with the logged files. Already-down projects exit 0.
 *   owned    If stop_cmd: `/bin/sh -c <stop_cmd>` with logged cwd + env (resolved env from start time — critical
 *            for tools like supabase whose stop_cmd reads SUPABASE_PROJECT_ID etc.). Without stop_cmd: no-op.
 */

const RESCUE_STOP_CMD_TIMEOUT_MS = 30_000;
const RESCUE_SIGTERM_GRACE_MS = 2_000;

/** Reads the log, dispatches per entry, prints a summary section, returns the outcomes. */
async function runRescue(
  out: NodeJS.WritableStream,
): Promise<RescueOutcome[]> {
  let entries: StartedEntry[];
  try {
    entries = await readStartedLog();
  } catch (err) {
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
    // Per-entry line for progress visibility on long rescues.
    writeLine(out, `  ${formatRescueLine(outcome)}`);
  }

  return outcomes;
}

/** Dispatch one rescue entry. Each path is idempotent and never throws (errors → warn outcomes). */
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
  // Defensive against a forward-compat new kind.
  return {
    kind: (entry as { kind: "pid" | "compose" | "owned" }).kind,
    label: "unknown",
    status: "warn",
    detail: "unknown rescue entry kind",
  };
}

/** SIGTERM → grace → SIGKILL on a logged PID. Dead PIDs are expected and reported OK. */
async function rescuePid(
  entry: Extract<StartedEntry, { kind: "pid" }>,
): Promise<RescueOutcome> {
  const label = `pid ${entry.pid} (${entry.service})`;

  if (!isAlive(entry.pid)) {
    return { kind: "pid", label, status: "ok", detail: "already dead" };
  }

  // detached:true → pid==pgid; signal the group to reach the whole tree atomically.
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

  const startMs = Date.now();
  while (Date.now() - startMs < RESCUE_SIGTERM_GRACE_MS) {
    if (!isAlive(entry.pid) && survivors(entry.pid).length === 0) {
      return { kind: "pid", label, status: "ok", detail: "SIGTERM" };
    }
    await sleep(50);
  }

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

/** Prefer the CLI named in the entry; fall back to autodetect (machine may have moved podman→docker since logged). */
async function rescueCompose(
  entry: Extract<StartedEntry, { kind: "compose" }>,
): Promise<RescueOutcome> {
  const label = `compose project ${entry.project}`;

  let cli;
  try {
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
    // Non-zero is expected for already-down projects — warn (not fail) since the project is most likely already gone.
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
 * Spawn `/bin/sh -c <stop_cmd>` with the LOGGED cwd + env (NOT process.env).
 * The logged env captures the resolved env at start time (SUPABASE_PROJECT_ID etc.) so stop_cmd addresses the same
 * external state. Bare process.env would re-introduce the misdirected-cleanup bug for self-managing tools.
 * Without stop_cmd: no-op. The paired `kind: pid` entry handles the process side.
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

    // Drain so the child doesn't block on a full pipe. No log tee — the per-service log is in the stack dir (which may be gone).
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

function rescueLabel(entry: StartedEntry): string {
  if (entry.kind === "pid") return `pid ${entry.pid} (${entry.service})`;
  if (entry.kind === "compose") return `compose project ${entry.project}`;
  return `owned service ${entry.service}`;
}

/** ASCII-only — renders consistently across terminals, CI logs, file redirects. */
function formatRescueLine(outcome: RescueOutcome): string {
  const marker = outcome.status === "ok" ? "ok" : "!!";
  const tail = outcome.detail ? ` (${outcome.detail})` : "";
  return `[${marker}] ${outcome.label}${tail}`;
}
