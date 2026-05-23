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
 */

import { createInterface } from "node:readline";
import { join } from "node:path";

import { down as composeDown, type RunnerCtx } from "../compose/runner.js";
import { resolveComposeCli } from "../compose/detect.js";
import { release } from "../ports/allocator.js";
import {
  listStacks,
  removeStackDir,
  stackDir,
} from "../state/directory.js";
import { readSnapshot, type ServiceSnapshot } from "../state/snapshot.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunNukeInput {
  /** `--yes` / `-y` to skip the confirmation prompt. */
  yes?: boolean;
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

export interface RunNukeResult {
  exitCode: number;
  outcomes: NukeOutcome[];
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

  if (ids.length === 0) {
    writeLine(out, "no stacks to nuke");
    return { exitCode: 0, outcomes: [] };
  }

  // Confirmation prompt — skipped if --yes, or if stdin is not a TTY
  // (a non-TTY stdin means we're being scripted; the explicit --yes
  // requirement would force every test/integration to opt in. Plan 1
  // takes the friendlier route: non-TTY stdin is treated as "the
  // caller knows what they're doing.").
  if (!input.yes && isTTY(stdin)) {
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
  // grep against in shell.
  const nuked = outcomes.filter((o) => o.status === "nuked").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  writeLine(out, `nuked ${nuked}, failed ${failed}, skipped ${skipped}`);

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

  // 1. Kill owned PIDs (best-effort).
  for (const svc of snap.services) {
    if (svc.kind !== "owned" || typeof svc.pid !== "number") continue;
    try {
      await killOwned(svc);
    } catch (err) {
      warnings.push(
        `service ${svc.name} (pid ${svc.pid}): ${errorMessage(err)}`,
      );
    }
  }

  // 2. Tear down compose services we know about (best-effort).
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
      await tearDownCompose(snap.stack_id, snap.worktree_path, snap.worktree_name);
    } catch (err) {
      warnings.push(`compose down: ${errorMessage(err)}`);
    }
  }

  // 3. Release allocated ports (best-effort; idempotent).
  try {
    await release(snap.stack_id);
  } catch (err) {
    warnings.push(`release ports: ${errorMessage(err)}`);
  }

  // 4. Remove the state directory. This is the "done" signal — if we
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
 */
async function killOwned(svc: ServiceSnapshot): Promise<void> {
  const pid = svc.pid;
  if (typeof pid !== "number") return;

  if (!isAlive(pid)) return; // already gone — nothing to do

  // SIGTERM gives the process a chance to clean up.
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // ESRCH = process died between our isAlive check and the kill.
    // Anything else (EPERM) is a genuine warning.
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    throw err;
  }

  // Poll for exit. 2s total, polling every 50ms (~40 polls). Cheaper
  // than setTimeout-then-blindly-SIGKILL because most processes exit
  // within a few hundred ms of SIGTERM.
  const startMs = Date.now();
  while (Date.now() - startMs < 2_000) {
    if (!isAlive(pid)) return;
    await sleep(50);
  }

  // Still alive after the grace window. Escalate.
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    throw err;
  }

  // SIGKILL is uncatchable; the kernel will reap shortly. One brief
  // poll is enough to confirm so callers don't race.
  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid)) return;
    await sleep(50);
  }
  // If it's somehow still here, the caller's warning will at least
  // mention this stack so the user knows where to look.
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
 * Drive `<compose-cli> compose down -v --remove-orphans` for a stack.
 * Plan 1: we only know the override file's path; the user's base
 * `compose_file` isn't in the snapshot. Compose treats `-f` files
 * additively, so passing just the override (plus whatever the project
 * label tells compose) lets compose find the running containers by
 * project name and tear them down. Containers without a matching
 * compose project label aren't lich's responsibility.
 */
async function tearDownCompose(
  stackId: string,
  worktreePath: string,
  worktreeName: string,
): Promise<void> {
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
