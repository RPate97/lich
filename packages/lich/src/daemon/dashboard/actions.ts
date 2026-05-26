import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ActionResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunLichActionOpts {
  timeoutMs?: number;
}

// 5min accommodates supabase-style teardowns; dashboard isn't user-blocking (it polls).
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const OUTPUT_CAP_BYTES = 16 * 1024;

const TRUNCATION_SUFFIX = "\n[... output truncated]\n";

/**
 * Run `lich <action>` in `worktreePath`. Never throws on subprocess
 * failure — returns `{ ok: false, ... }` so the dashboard can render the
 * outcome. THROWS only when the lich binary itself can't be located
 * (hard configuration error → server returns 500).
 */
export async function runLichAction(
  worktreePath: string,
  action: "down" | "restart",
  opts: RunLichActionOpts = {},
): Promise<ActionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const binaryPath = resolveLichBinary();

  return new Promise<ActionResult>((resolve) => {
    // Accumulate raw bytes so cap math is exact across multibyte chars.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Inherit daemon env so LICH_HOME / PATH propagate to the spawned CLI.
    const childEnv = { ...process.env };

    let child;
    try {
      child = spawn(binaryPath, [action], {
        cwd: worktreePath,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        // detached makes the child a process-group leader so we can SIGKILL
        // grandchildren on timeout — otherwise long-running shell-wrapper
        // grandchildren hold stdio open and `close` never fires.
        detached: true,
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: `failed to spawn lich: ${(err as Error).message}`,
      });
      return;
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      // SIGKILL the whole process group (-pid) so grandchildren get
      // reaped — see the `detached: true` rationale above.
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        // ESRCH if the group already exited; double-tap per-pid in case the group didn't form.
        try {
          child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= OUTPUT_CAP_BYTES) {
        stdoutTruncated = true;
        return;
      }
      const remaining = OUTPUT_CAP_BYTES - stdoutBytes;
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = OUTPUT_CAP_BYTES;
        stdoutTruncated = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= OUTPUT_CAP_BYTES) {
        stderrTruncated = true;
        return;
      }
      const remaining = OUTPUT_CAP_BYTES - stderrBytes;
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes = OUTPUT_CAP_BYTES;
        stderrTruncated = true;
      }
    });

    let errored = false;
    child.once("error", (err: Error) => {
      errored = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: `lich subprocess error: ${err.message}`,
      });
    });

    // `close` (not `exit`) so stdout/stderr drains flush before resolving.
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (errored) return;
      clearTimeout(timeout);

      let stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (stdoutTruncated) stdout += TRUNCATION_SUFFIX;
      if (stderrTruncated) stderr += TRUNCATION_SUFFIX;

      if (timedOut) {
        resolve({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: stderr + `\n[lich daemon] action timed out after ${timeoutMs}ms\n`,
        });
        return;
      }

      if (code === null) {
        resolve({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: stderr + `\n[lich daemon] action terminated by signal: ${signal ?? "unknown"}\n`,
        });
        return;
      }

      resolve({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

/** Resolution: LICH_BIN env var → sibling of process.execPath named `lich`. Throws when neither exists. */
export function resolveLichBinary(): string {
  const envOverride = process.env.LICH_BIN;
  if (envOverride !== undefined && envOverride.length > 0) {
    if (existsSync(envOverride)) {
      return envOverride;
    }
    throw new Error(`lich binary not found at LICH_BIN=${envOverride}`);
  }

  const sibling = join(dirname(process.execPath), "lich");
  if (existsSync(sibling)) {
    return sibling;
  }

  throw new Error(
    `lich binary not found at ${sibling}` +
      ` (and LICH_BIN env var is unset).` +
      ` Build it with: cd packages/lich && bun run build`,
  );
}
