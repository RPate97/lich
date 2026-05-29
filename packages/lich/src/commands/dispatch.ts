/**
 * User-command dispatcher — runs one entry under `commands:` in `lich.yaml`.
 * The bin-layer router falls through here when an argv name isn't a built-in
 * but IS in the loaded config.
 */

import { spawn, type StdioOptions } from "node:child_process";
import { join } from "node:path";

import type { LichConfig } from "../config/types.js";
import type { Worktree } from "../worktree/detect.js";
import type { AllocatedPorts } from "../state/snapshot.js";
import { resolveEnvGroup } from "../groups/resolve.js";

export interface DispatchInput {
  /** Looked up in `config.commands` — absent → exit 127. */
  name: string;
  /** Positionals + flags after the name; forwarded via `sh -c <cmd> -- <argv>`. */
  extraArgv: string[];
  config: LichConfig;
  worktree: Worktree;
  allocatedPorts: AllocatedPorts;
  projectRoot: string;
  /** Top-level `--env-group=` flag; wins over per-command `env_group:`. */
  envGroupOverride?: string;
  /** SIGINT → kill child + exit 130. */
  signal?: AbortSignal;
  /** Defaults to `"inherit"`; tests pass `"pipe"`. */
  stdio?: StdioOptions;
  stderr?: (line: string) => void;
}

export interface DispatchResult {
  /**
   * Child's exit code, with these special values:
   *   127 — name not in `config.commands` ("command not found")
   *   130 — aborted via the supplied signal (128 + SIGINT(2))
   *   1   — child terminated by signal without an exit code
   */
  exitCode: number;
}

const EXIT_CODE_ABORTED = 130;
const EXIT_CODE_UNKNOWN_COMMAND = 127;

/**
 * Merge per-command env literals on top of the resolved group env.
 * `null` (not undefined) is an unset marker that scrubs the inherited key,
 * letting a command e.g. clear a remote-only DATABASE_URL before invoking a
 * tool that should never see it.
 */
function mergePerCommandEnv(
  base: Record<string, string>,
  literals: Record<string, string | number | boolean | null> | undefined,
): Record<string, string> {
  if (!literals) return { ...base };
  const out: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(literals)) {
    if (v === undefined) continue;
    if (v === null) {
      delete out[k];
      continue;
    }
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

export async function dispatchUserCommand(
  input: DispatchInput,
): Promise<DispatchResult> {
  const stderr = input.stderr ?? ((s: string) => process.stderr.write(s + "\n"));

  const command = input.config.commands?.[input.name];
  if (!command) {
    stderr(`lich: unknown command '${input.name}' (try \`lich --help\`)`);
    return { exitCode: EXIT_CODE_UNKNOWN_COMMAND };
  }

  // Precedence: --env-group= override > per-command env_group > "stack".
  const groupName =
    input.envGroupOverride ?? command.env_group ?? "stack";

  const groupEnv = await resolveEnvGroup({
    name: groupName,
    config: input.config,
    worktree: input.worktree,
    allocatedPorts: input.allocatedPorts,
    projectRoot: input.projectRoot,
    // processEnv left undefined → resolver picks up process.env; the group's
    // own process_env: false policy still applies.
  });

  // Later wins: per-command env overrides the group's.
  const env = mergePerCommandEnv(groupEnv, command.env);

  // Shell invocation: `/bin/sh -c '<cmd>' -- $0-sentinel arg1 arg2 ...`
  //
  // The `--` separator is load-bearing — without it, a forwarded flag like
  // `--filter` could be reinterpreted as a sh option.
  //
  // Per POSIX sh, after `-c <cmd>` the first trailing argv is `$0`, rest is
  // `$1+` and `"$@"`. So we insert a sentinel for `$0` to keep the user's
  // extraArgv visible at `$1+`/`"$@"`. "lich-cmd" because users debugging
  // via `$0` see something recognizable.
  const SH_NAME_SLOT_SENTINEL = "lich-cmd";
  const args = ["-c", command.cmd, SH_NAME_SLOT_SENTINEL, ...input.extraArgv];

  // YAML-side `cwd:` is relative; resolve against projectRoot.
  const cwd = join(input.projectRoot, command.cwd ?? ".");

  const child = spawn("/bin/sh", args, {
    cwd,
    env,
    stdio: input.stdio ?? "inherit",
  });

  let aborted = false;
  const onAbort = (): void => {
    if (aborted) return;
    aborted = true;
    try {
      child.kill("SIGINT");
    } catch {
      /* child already exited */
    }
  };

  if (input.signal) {
    if (input.signal.aborted) {
      onAbort();
    } else {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    const code = await waitForExit(child);
    if (aborted) return { exitCode: EXIT_CODE_ABORTED };
    // null = killed by signal without an exit code; fall back to 1.
    return { exitCode: code ?? 1 };
  } finally {
    if (input.signal) {
      input.signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Resolve on `exit` (not `close`) — inherit-stdio has no pipes to drain.
 * Spawn-pre-fork errors fire `error` instead; translate to a synthetic 1
 * so the caller has a single await path.
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
      resolve(1);
    });
  });
}
