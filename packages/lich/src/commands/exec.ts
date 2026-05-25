/**
 * `lich exec [--env-group=<group>] <cmd> [args...]` — ad-hoc command runner.
 *
 * Spawns an arbitrary command with the resolved env_group loaded as its
 * environment, inheriting stdio so the user sees streaming output. The
 * default group is `"stack"` — i.e. the same env the stack itself runs with.
 *
 * Argv dispatch — single-arg vs multi-arg
 * ----------------------------------------
 * The acceptance criteria pin one specific design rule here, and getting
 * this right matters for ergonomics:
 *
 *   - **Single-arg form** (`lich exec "echo $HOME"`): the lone argv entry
 *     is interpreted as a shell expression. We spawn `/bin/sh -c <arg>` so
 *     glob expansion, env interpolation, pipes, and redirections all work
 *     the way the user expects when they explicitly opted into shell mode
 *     by quoting a single string.
 *
 *   - **Multi-arg form** (`lich exec ls -la apps/api`): each argv entry is
 *     treated as a literal token — we spawn `argv[0]` directly with
 *     `argv.slice(1)` as its arguments. NO shell interpretation: `$HOME`
 *     does not expand, `;`/`|`/`>` are passed through verbatim as args to
 *     the named binary.
 *
 * This is the same trick `docker exec` and `kubectl exec` use, and it
 * sidesteps an entire class of shell-quoting bugs that come from naively
 * joining argv into a single string before handing it to `/bin/sh -c`.
 * Anyone reading this code who's tempted to "just always use sh -c" should
 * remember: that's the bug the design is preventing, not a missed
 * simplification.
 *
 * Env resolution
 * --------------
 *   1. Load `lich.yaml` from cwd via `parseConfig`. A parse failure is exit 1.
 *   2. Detect the worktree (`detectWorktree(cwd)`); read the stack snapshot
 *      if `state.json` exists and rebuild the allocated-ports map. When
 *      there's no snapshot (stack is down), the allocated-ports map is
 *      empty — the env group resolver still produces a useful env, just
 *      without `${owned.X.port}` style references resolved. Anything that
 *      tries to interpolate a port-ref against an empty map throws an
 *      `InterpolationError`, which we surface as exit 1.
 *   3. Resolve the named group via `groups/resolve.ts::resolveEnvGroup`.
 *
 * Cancellation
 * ------------
 * If a `signal` is supplied (the bin layer wires its SIGINT controller in),
 * we kill the child with SIGINT and resolve with exit code 130
 * (POSIX `128 + SIGINT(2)`). The bin layer's second-SIGINT-forces-quit
 * guarantee still applies — this is the cooperative path.
 *
 * Spec source: docs/superpowers/specs/2026-05-23-lich-v1-design.md (section 5).
 */

import { spawn, type StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../config/parse.js";
import { detectWorktree } from "../worktree/detect.js";
import {
  readSnapshot,
  rebuildAllocatedPorts,
  type AllocatedPorts,
} from "../state/snapshot.js";
import { resolveEnvGroup } from "../groups/resolve.js";
import {
  resolveProfile,
  type ResolvedProfile,
} from "../profiles/resolve.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExecOptions {
  /**
   * The argv after `exec` on the command line. Empty means "no command to
   * run" — emits a usage message and returns exit 2.
   *
   * Single entry (length === 1) → spawned via `/bin/sh -c <entry>` so shell
   * syntax (env expansion, pipes, redirections) works. Multiple entries →
   * spawned as `spawn(argv[0], argv.slice(1))` so each token is a literal.
   * See the file-level JSDoc for the rationale.
   */
  argv: string[];
  /**
   * Name of the env_group to load. Defaults to `"stack"`. Pass-through from
   * the `--env-group=<X>` flag (the router parses and forwards).
   */
  envGroupName?: string;
  /**
   * Working directory used both for config discovery (`lich.yaml` lookup)
   * and as the spawned child's cwd. Defaults to `process.cwd()` at the
   * call site.
   */
  cwd?: string;
  /**
   * Optional AbortSignal. When it fires we kill the child with SIGINT and
   * resolve with exit code 130. The bin layer wires its SIGINT controller
   * in; tests can pass their own to exercise the cancellation path.
   */
  signal?: AbortSignal;
  /**
   * Stdio override for tests. Defaults to `"inherit"` in production so the
   * user sees streaming output. Tests pass `"pipe"` and capture the child's
   * stdout/stderr through the returned handles (`onSpawn` below) to assert
   * on what actually ran.
   */
  stdio?: StdioOptions;
  /**
   * Sink for diagnostic output (usage messages, parse errors). Defaults
   * to `process.stderr.write` so production output streams immediately;
   * tests pass a string-collecting function to assert on the message.
   */
  stderr?: (line: string) => void;
  /**
   * Optional hook invoked synchronously immediately after the child is
   * spawned, with the raw {@link import("node:child_process").ChildProcess}.
   * Used by tests to capture `stdout`/`stderr` when `stdio: "pipe"` is set,
   * or to drive the child's lifecycle (e.g. asserting on argv passed to
   * spawn). Never called in production — only tests pass this in.
   */
  onSpawn?: (child: import("node:child_process").ChildProcess) => void;
}

export interface ExecResult {
  /**
   * Exit code from the spawned child. Conventions:
   *   - `2`   — usage error (empty argv, unknown env-group, etc.)
   *   - `1`   — config parse failure or env-resolution failure
   *   - `127` — child failed to spawn (sh missing, no such binary)
   *   - `130` — SIGINT-aborted via the cancellation signal (128 + 2)
   *   - else  — the child's own exit code
   */
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runExec(opts: ExecOptions): Promise<ExecResult> {
  const cwd = opts.cwd ?? process.cwd();
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const stdio = opts.stdio ?? "inherit";
  const envGroupName = opts.envGroupName ?? "stack";

  // ---- 1. Empty argv → usage --------------------------------------------
  if (!opts.argv || opts.argv.length === 0) {
    err("usage: lich exec [--env-group=<group>] <cmd> [args...]\n");
    return { exitCode: 2 };
  }

  // ---- 2. Load lich.yaml ------------------------------------------------
  const yamlPath = join(cwd, "lich.yaml");
  if (!existsSync(yamlPath)) {
    err(`lich exec: lich.yaml not found at ${yamlPath}\n`);
    return { exitCode: 1 };
  }
  const parsed = await parseConfig(yamlPath);
  if (!parsed.ok) {
    for (const e of parsed.errors) {
      err(`${e.location}: ${e.message}\n`);
    }
    return { exitCode: 1 };
  }
  const config = parsed.config;

  // ---- 3. Detect worktree + load allocated ports ------------------------
  // Worktree detection walks up from cwd to find lich.yaml; we already
  // know it's right here (we just parsed it), so failure to detect would
  // be a programming bug rather than a user error. Surface either way.
  let worktree: ReturnType<typeof detectWorktree>;
  try {
    worktree = detectWorktree(cwd);
  } catch (e) {
    err(`lich exec: ${e instanceof Error ? e.message : String(e)}\n`);
    return { exitCode: 1 };
  }

  // If no state.json exists (stack is down), the resolver still runs — the
  // user might just be running a command that doesn't need any ${owned.*.port}
  // references resolved. An empty map is fine; the resolver throws only if
  // a value actually references something missing.
  let allocatedPorts: AllocatedPorts = { compose: {}, owned: {} };
  const snap = await readSnapshot(worktree.stack_id).catch(() => null);
  if (snap) {
    allocatedPorts = rebuildAllocatedPorts(snap);
  }

  // LEV-454: re-resolve the active profile from the on-disk yaml so the env
  // group sees profile-scoped env_from/env_files/env overrides. The snapshot
  // carries only the profile NAME (Plan 3 Task 8); the layered env lives in
  // the yaml. If the yaml has drifted between up and exec (user removed or
  // renamed the profile, broke the extends chain, etc.) we silently fall back
  // to top-level-only env — mirrors `commands/down.ts`'s best-effort approach
  // for before_down composition. exec is a "read what's running" surface;
  // surfacing yaml drift as a hard failure would block the user from running
  // ad-hoc commands while they untangle the config.
  let resolvedProfile: ResolvedProfile | undefined;
  if (snap?.active_profile && config.profiles?.[snap.active_profile]) {
    try {
      resolvedProfile = resolveProfile(snap.active_profile, config);
    } catch {
      // Fall back to undefined → top-level-only env. The user's broken-yaml
      // diagnosis flows through `lich validate`, not exec.
      resolvedProfile = undefined;
    }
  }

  // ---- 4. Resolve the env group -----------------------------------------
  let env: Record<string, string>;
  try {
    env = await resolveEnvGroup({
      name: envGroupName,
      config,
      worktree,
      allocatedPorts,
      projectRoot: worktree.path,
      profile: resolvedProfile,
    });
  } catch (e) {
    err(`lich exec: ${e instanceof Error ? e.message : String(e)}\n`);
    return { exitCode: 1 };
  }

  // ---- 5. Spawn the child -----------------------------------------------
  // Single-arg → shell mode; multi-arg → direct spawn. See the file-level
  // JSDoc for the rationale; this is the load-bearing decision of this
  // command and the test suite pins both forms.
  const isShellForm = opts.argv.length === 1;
  const command = isShellForm ? "/bin/sh" : opts.argv[0];
  const args = isShellForm ? ["-c", opts.argv[0]] : opts.argv.slice(1);

  return new Promise<ExecResult>((resolve) => {
    let aborted = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: worktree.path,
      env,
      stdio,
    });

    // Give tests a chance to grab the child handle (for stdout/stderr
    // capture when stdio: "pipe"). The hook fires synchronously so tests
    // can attach data listeners before any output arrives.
    if (opts.onSpawn) {
      opts.onSpawn(child);
    }

    // Spawn-level failure (the binary doesn't exist, sh isn't on PATH, etc.).
    // Surface as exit 127 — the POSIX convention for "command not found"
    // shells use, which scripts checking $? can pattern-match.
    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      err(`lich exec: ${e instanceof Error ? e.message : String(e)}\n`);
      resolve({ exitCode: 127 });
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      // If a signal aborted us mid-flight, prefer 130 over the child's own
      // exit code — the user explicitly asked us to stop, and the conventional
      // exit code for SIGINT-terminated is 128 + SIGINT(2) = 130. Without
      // this, an aborted child that happened to be in the middle of a fast
      // exit might surface as code 0 even though it was killed.
      if (aborted) {
        resolve({ exitCode: 130 });
        return;
      }
      // Translate signal-killed (no exit code) into a reasonable default.
      if (code === null) {
        // Killed by a signal that wasn't the one we sent. Use the signal-
        // standard 128 + N where possible, falling back to 1 for unknown.
        const sigNum = signal ? signalToNumber(signal) : null;
        resolve({ exitCode: sigNum !== null ? 128 + sigNum : 1 });
        return;
      }
      resolve({ exitCode: code });
    });

    // Cooperative cancellation: send SIGINT to the child (matching the
    // bin layer's grace path) and let the exit handler return 130. If
    // the signal is already aborted at spawn time, kill immediately.
    const handleAbort = (): void => {
      aborted = true;
      if (!settled && child.pid !== undefined) {
        try {
          child.kill("SIGINT");
        } catch {
          /* child already exited; ignore */
        }
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        handleAbort();
      } else {
        opts.signal.addEventListener("abort", handleAbort, { once: true });
      }
    }
  });
}

/**
 * Map a POSIX signal name to its number for `128 + N` exit-code derivation.
 *
 * Only covers signals likely to terminate a spawned exec child — anything
 * exotic falls through to null and the caller substitutes exit 1. We avoid
 * pulling in a full signal table because the only cases that matter for
 * this command are SIGINT (130), SIGTERM (143), SIGKILL (137), and SIGHUP
 * (129); other signals surfacing here would be unusual enough to warrant
 * a closer look anyway.
 */
function signalToNumber(signal: NodeJS.Signals): number | null {
  switch (signal) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGQUIT":
      return 3;
    case "SIGKILL":
      return 9;
    case "SIGTERM":
      return 15;
    default:
      return null;
  }
}
