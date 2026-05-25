/**
 * `lich restart` — whole-stack restart (Plan 5 Task 19 / LEV-421).
 *
 * Sequence: `runDown` → if exit 0, `runUp`. The exit code is the FIRST
 * non-zero we hit:
 *
 *   - If `runDown` returns non-zero, abort and return that exit code.
 *     Trying to `up` on top of a failed `down` would leave the stack in a
 *     half-torn-down state with no useful diagnostic.
 *   - If `runDown` succeeds (which includes the idempotent "no stack found"
 *     and "already stopped" no-ops — both return exit 0), proceed to
 *     `runUp` and return its exit code.
 *
 * AbortSignal threading: the same signal flows into both `runDown` and
 * `runUp`. If the user Ctrl-C's mid-down, `runDown`'s own cancellation path
 * fires (SIGTERM grace cut short, SIGKILL escalation, status:failed write,
 * release ports); restart returns that exit code without proceeding to up.
 * If the user Ctrl-C's mid-up after a successful down, `runUp`'s usual
 * cancellation path takes over.
 *
 * Scope (v1 MVP):
 *
 *   - Whole-stack only. The spec defines `lich restart [services...]` with
 *     per-service / `--owned` / `--compose` modes; v1.x ships those. The
 *     dashboard's "Restart" button (Plan 5 Task 16) uses this command for
 *     whole-stack restarts only.
 *
 *   - Same stack identity. `runUp` re-runs against the same `cwd`, so it
 *     re-derives the same `stack_id` from the worktree. New PIDs for owned
 *     services and fresh container IDs for compose services, but the
 *     worktree-scoped state directory and stack_id are preserved.
 *
 * Composition rationale: this command is intentionally a thin shim. The
 * heavy lifting (config parse, worktree detect, port allocation, lifecycle
 * hooks, ready waits, state.json writes) lives inside `runUp` / `runDown`.
 * Any behavioral change to up or down (signal handling, output mode, etc.)
 * automatically flows through restart.
 */

import type { OutputMode } from "../output/index.js";
import { runDown } from "./down.js";
import { runUp } from "./up.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunRestartInput {
  /** Defaults to `process.cwd()`. Threaded to both `runDown` and `runUp`. */
  cwd?: string;
  /**
   * Output mode for the CLI surface. Defaults to 'pretty'. Forwarded only
   * to `runUp` — `runDown` writes a single summary line and doesn't honor
   * the output mode in Plan 1's surface. (If `runDown` grows a structured
   * output later, this is the seam to wire it through.)
   */
  outputMode?: OutputMode;
  /** Output sink; defaults to `process.stdout`. */
  out?: NodeJS.WritableStream;
  /**
   * AbortSignal for cancellation. Threaded into both `runDown` and `runUp`
   * so Ctrl-C during either phase tears the in-flight phase down cleanly
   * (see `commands/up.ts` and `commands/down.ts` for the per-command
   * cancellation semantics).
   */
  signal?: AbortSignal;
}

export interface RunRestartResult {
  /**
   * The first non-zero exit code from the down-then-up sequence, or 0 if
   * both phases succeeded.
   *
   * Specifically:
   *   - non-zero if `runDown` failed (we did NOT proceed to `runUp`)
   *   - non-zero if `runDown` succeeded but `runUp` failed
   *   - 0 only if both succeeded
   */
  exitCode: number;
  /**
   * Stack id from `runUp`'s result, when we got that far. Absent when
   * `runDown` failed and we short-circuited.
   */
  stackId?: string;
  /**
   * Per-service final states from `runUp`'s result, when we got that far.
   * Absent when `runDown` failed and we short-circuited.
   */
  services?: Array<{ name: string; state: string }>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run a whole-stack restart: down, then up.
 *
 * See module-level JSDoc for the full contract.
 */
export async function runRestart(
  input: RunRestartInput,
): Promise<RunRestartResult> {
  // ---- 1. Down ---------------------------------------------------------
  // `runDown` is intentionally tolerant: a missing state.json or
  // already-stopped stack both return exit 0 with no warnings, so this
  // works as the "down half" of restart for stacks that aren't currently
  // up. Only an actual teardown failure (non-zero exit) short-circuits us.
  const downResult = await runDown({
    cwd: input.cwd,
    out: input.out,
    signal: input.signal,
  });
  if (downResult.exitCode !== 0) {
    // Don't try to up a broken state. Return down's exit code so the caller
    // sees the actual failure code; the warnings array (down's structured
    // diagnostic surface) lives on `downResult.warnings`, which we drop
    // here because the user already saw it printed by `runDown` itself.
    return { exitCode: downResult.exitCode };
  }

  // ---- 2. Up -----------------------------------------------------------
  // Same cwd → same worktree → same stack_id. New PIDs / containers but
  // the same persistent identity.
  const upResult = await runUp({
    cwd: input.cwd,
    outputMode: input.outputMode,
    out: input.out,
    signal: input.signal,
  });

  return {
    exitCode: upResult.exitCode,
    ...(upResult.stackId !== undefined && { stackId: upResult.stackId }),
    ...(upResult.services !== undefined && { services: upResult.services }),
  };
}
