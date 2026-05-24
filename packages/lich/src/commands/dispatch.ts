/**
 * User-command dispatcher (Plan 2 Task 7).
 *
 * Runs a single user-defined command declared under `commands:` in `lich.yaml`.
 * The router in `bin/lich.ts` (Plan 2 Task 8) falls through to this module
 * whenever the requested command name isn't a built-in but IS declared in the
 * loaded config — dispatch is the runtime hot path that turns
 * `lich tools:env-check --extra foo` into an executed shell child.
 *
 * Responsibilities:
 *
 *   1. Look up the requested name in `config.commands`. Missing → exit 127
 *      (POSIX "command not found"), with a stderr hint pointing at `lich help`.
 *   2. Resolve the env_group: caller-supplied `--env-group=` override wins,
 *      then the per-command `env_group:` field, else the built-in `"stack"`.
 *      The resolver (`groups/resolve.ts`) handles cycle protection, missing-name
 *      errors, and interpolation — we just hand it the name + context.
 *   3. Layer the per-command `env: {...}` literals on top of the resolved group
 *      env. Per-command env wins (later wins, matches the rest of the env
 *      pipeline's precedence rules).
 *   4. Spawn `/bin/sh -c '<cmd>' -- <extraArgv...>` so the cmd can reach
 *      forwarded argv via `"$@"`. The `--` separator before extras is critical:
 *      without it, a forwarded flag like `--filter` could be misinterpreted by
 *      sh as a sh option in some shells. With `--`, every entry in extraArgv
 *      lands cleanly in positional `$1`, `$2`, … (and the whole list at `"$@"`).
 *   5. Spawn with `stdio: "inherit"` (default) so the user sees streaming
 *      output. Tests pass `"pipe"` to capture stdout/stderr instead.
 *   6. Honor the optional AbortSignal — when it fires, kill the child with
 *      SIGINT and resolve with exit code 130 (`128 + SIGINT(2)`, the POSIX
 *      convention for "process terminated by SIGINT").
 *
 * Non-responsibilities:
 *
 *   - We do NOT validate the command shape at dispatch time. The JSON schema
 *     (Plan 2 Tasks 2-3) catches structural errors; `lich validate` (Plan 2
 *     Tasks 14-17) catches reference errors. Dispatch is the runtime hot path
 *     and trusts those earlier surfaces.
 *   - We do NOT inject port-env shimming. The env_group resolver already
 *     interpolates `${owned.X.port}` references into the resolved env; if a
 *     user-defined command needs raw `LICH_*` port env vars it can reference
 *     them via interpolation in its `env:` block.
 *
 * Spec source: `docs/superpowers/specs/2026-05-23-lich-v1-design.md`,
 * section 4 (`commands`) + section 5 (`lich <user-command>`).
 */

import { spawn, type StdioOptions } from "node:child_process";
import { join } from "node:path";

import type { LichConfig } from "../config/types.js";
import type { Worktree } from "../worktree/detect.js";
import type { AllocatedPorts } from "../state/snapshot.js";
import { resolveEnvGroup } from "../groups/resolve.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input to {@link dispatchUserCommand}. Built by the bin-layer router from
 * the parsed argv + the loaded config + the per-worktree runtime context.
 */
export interface DispatchInput {
  /**
   * Command name (the unknown-to-built-ins name from `argv._[0]`). Looked up
   * in `config.commands` — absent → exit 127.
   */
  name: string;
  /**
   * Positionals and flags after the name. Already separated from the consumed
   * flags by the bin-layer's mri parsing (e.g. `--env-group=` is peeled off
   * upstream and passed as `envGroupOverride`). Forwarded to the underlying
   * cmd via `/bin/sh -c '<cmd>' -- <extraArgv...>`.
   */
  extraArgv: string[];
  /** Loaded `lich.yaml` config. */
  config: LichConfig;
  /** Per-worktree identity (worktree.* interpolation context source). */
  worktree: Worktree;
  /** Allocated ports for `${owned.X.port}` / `${services.X.host_port}` refs. */
  allocatedPorts: AllocatedPorts;
  /** Worktree root directory; used as the default cwd for the child. */
  projectRoot: string;
  /**
   * `--env-group=<name>` override from the top-level flag, when present.
   * Wins over the per-command `env_group:` field.
   */
  envGroupOverride?: string;
  /**
   * Optional AbortSignal. When fired, the child receives SIGINT and the
   * dispatch resolves with exit code 130. The bin-layer wires this to its
   * own SIGINT handler (LEV-302) so Ctrl-C reaches the user command cleanly.
   */
  signal?: AbortSignal;
  /**
   * Stdio shape for the spawned child. Defaults to `"inherit"` so the user
   * sees streaming output. Tests pass `"pipe"` to capture stdout/stderr.
   */
  stdio?: StdioOptions;
  /**
   * Sink for the "unknown command" stderr line. Defaults to writing to
   * `process.stderr`. Exposed for tests.
   */
  stderr?: (line: string) => void;
}

/**
 * Result of running one user command. Just the exit code — no captured
 * stdout/stderr, because the default stdio is `inherit` (the user sees
 * output directly). When tests need to capture output they pass a
 * custom `stdio` AND read from the returned child handle themselves
 * (see {@link DispatchHandleResult} below — exposed only for tests).
 */
export interface DispatchResult {
  /**
   * Child's exit code (or `1` if the child terminated abnormally without one).
   * Special values:
   *   - `127` — name not declared in config.commands ("command not found").
   *   - `130` — aborted via the supplied signal ("128 + SIGINT(2)").
   */
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * The POSIX "process terminated by SIGINT" exit code: 128 + signal(2).
 * Same value the bin-layer's own SIGINT handler uses for the parent process.
 */
const EXIT_CODE_ABORTED = 130;

/**
 * The POSIX "command not found" exit code, used by the shell when an
 * uninvocable name is looked up. We reuse it for the equivalent
 * "no `commands.<name>` entry" case.
 */
const EXIT_CODE_UNKNOWN_COMMAND = 127;

/**
 * Stringify EnvMap-shaped per-command literals onto the resolved group env.
 * Skips undefined/null defensively (envMaps allow boolean/number; both
 * coerce to strings — same coercion the env_groups resolver applies to its
 * own literals).
 *
 * Returns a new object — does not mutate the input env.
 */
function mergePerCommandEnv(
  base: Record<string, string>,
  literals: Record<string, string | number | boolean> | undefined,
): Record<string, string> {
  if (!literals) return { ...base };
  const out: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(literals)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/**
 * Run one user-defined command. See module-level JSDoc for the full contract.
 *
 * The async surface lets the caller `await` the child's exit before deciding
 * the process exit code. The signal-abort path resolves the same promise with
 * exit code 130 (rather than rejecting) so the bin-layer has a single
 * "what code do I exit with" answer regardless of how the run ended.
 */
export async function dispatchUserCommand(
  input: DispatchInput,
): Promise<DispatchResult> {
  const stderr = input.stderr ?? ((s: string) => process.stderr.write(s + "\n"));

  // ---- 1. Look up the command ---------------------------------------------
  const command = input.config.commands?.[input.name];
  if (!command) {
    // Mirror the standard shell "command not found" message + the
    // POSIX 127 exit code. The "try `lich help`" hint nudges users
    // toward the discovery surface rather than re-typing flags blindly.
    stderr(`lich: unknown command '${input.name}' (try \`lich help\`)`);
    return { exitCode: EXIT_CODE_UNKNOWN_COMMAND };
  }

  // ---- 2. Resolve the env_group --------------------------------------------
  // Precedence: --env-group=X override > per-command env_group > built-in "stack".
  const groupName =
    input.envGroupOverride ?? command.env_group ?? "stack";

  const groupEnv = await resolveEnvGroup({
    name: groupName,
    config: input.config,
    worktree: input.worktree,
    allocatedPorts: input.allocatedPorts,
    projectRoot: input.projectRoot,
    // processEnv intentionally left undefined → resolver picks up process.env.
    // The group's own `process_env: false` policy still applies if declared.
  });

  // ---- 3. Layer per-command env literals on top of the resolved group ----
  // Later wins: per-command `env:` overrides anything the group provided.
  const env = mergePerCommandEnv(groupEnv, command.env);

  // ---- 4. Build the shell invocation --------------------------------------
  // `/bin/sh -c '<cmd>' -- arg1 arg2 ...`
  //
  // The `--` separator is load-bearing: without it, a forwarded flag like
  // `--filter` could be re-interpreted by sh as a sh option (some shells
  // treat the argv after `-c <cmd>` as positional starting from $0; others
  // are more permissive). The `--` ensures every entry in extraArgv lands
  // cleanly in positional `$1`, `$2`, … and is reachable via `"$@"`.
  //
  // The implicit positional convention: per POSIX sh, the first argv entry
  // after `-c <cmd>` becomes `$0` (script name). The `--` marks "end of
  // options" so what follows is treated as a positional list; bash then
  // assigns the FIRST trailing arg to `$0` (the script-name slot) and the
  // rest to `$1` onward. To make every extraArgv entry visible at `$1`+,
  // we insert a sentinel placeholder for `$0` immediately after `--`.
  // Without it, `["a", "b", "c"]` would land as `$0=a, $1=b, $2=c`, and
  // `"$@"` would only contain `b c` — surprising.
  //
  // The sentinel is conventionally "lich-cmd" so users debugging via
  // `$0` see something recognizable (rather than e.g. "--").
  const SH_NAME_SLOT_SENTINEL = "lich-cmd";
  const args = ["-c", command.cmd, SH_NAME_SLOT_SENTINEL, ...input.extraArgv];

  // ---- 5. Resolve cwd relative to projectRoot ------------------------------
  // The per-command `cwd:` is YAML-side relative; resolve against the
  // worktree root so users can write `cwd: apps/api` and get an absolute
  // path the kernel actually accepts. Default is `.` (project root itself).
  const cwd = join(input.projectRoot, command.cwd ?? ".");

  // ---- 6. Spawn ------------------------------------------------------------
  const child = spawn("/bin/sh", args, {
    cwd,
    env,
    stdio: input.stdio ?? "inherit",
  });

  // ---- 7. Wire signal cancellation ----------------------------------------
  // If the caller's signal fires while the child is still running, send it
  // SIGINT (mimics Ctrl-C semantics). The child's `exit` event still fires
  // afterward — we use the `aborted` flag to translate that exit into the
  // 130 convention regardless of what code the child happened to return.
  let aborted = false;
  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    // Best-effort: child may have already exited between abort firing and
    // this listener running. SIGINT to a dead pid is ESRCH; ignore.
    try {
      child.kill("SIGINT");
    } catch {
      /* best-effort */
    }
  };

  if (input.signal) {
    if (input.signal.aborted) {
      // Already aborted before we got to wire up: still send the signal
      // (the child may not have started yet, but its `exit` will fire
      // either way and we'll translate to 130 below).
      onAbort();
    } else {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // ---- 8. Await child exit, translate to exit code ------------------------
  try {
    const code = await waitForExit(child);
    if (aborted) return { exitCode: EXIT_CODE_ABORTED };
    // `code` is null when the child terminated by signal without an exit
    // code (uncommon for sh-invoked cmds, but possible). Fall back to 1
    // so the caller has a sentinel "something went wrong" code.
    return { exitCode: code ?? 1 };
  } finally {
    if (input.signal) {
      input.signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Resolve when the child fires `exit` (NOT `close` — we want the moment
 * the process is gone, not when its stdio pipes have been drained; for an
 * inherit-stdio child there are no pipes to drain anyway).
 *
 * Spawn-pre-fork failures (ENOENT for /bin/sh — which shouldn't happen on
 * any sane Unix but defensive — or unreadable cwd) fire `error` instead of
 * `exit`. Translate those into a synthetic exit code so the caller has a
 * single await path.
 */
function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      // Spawn failed before the child ever ran. The user's command never
      // produced an exit code; return 1 as the conventional "something
      // went wrong" sentinel.
      resolve(1);
    });
  });
}
