import { spawn } from "node:child_process";
import { shellQuote } from "./tart.js";

// Transport for long-running commands that need to survive minutes of quiet
// output (bun install, next dev compilation, postgres healthcheck waits).
// `tart exec` uses an opaque gRPC stream that has been observed to die mid-up
// with "Transport became inactive" under load; SSH with ServerAliveInterval
// holds the channel open through the same conditions.
export interface InVmSshExecutor {
  /**
   * Run argv in the VM via SSH. Inherits stdio for live output. Returns the
   * remote exit code; throws only on spawn-level failures (binary missing,
   * etc.).
   */
  exec(
    target: string,
    argv: ReadonlyArray<string>,
    opts: { cwd: string; env: Record<string, string> },
  ): Promise<number>;

  /**
   * Same as exec() but also captures and returns the tail of stderr — used
   * when a non-zero exit needs a diagnostic surface (vitest can swallow
   * inherited stderr inside per-test buffers).
   */
  execCapturingStderr?(
    target: string,
    argv: ReadonlyArray<string>,
    opts: { cwd: string; env: Record<string, string> },
  ): Promise<{ exitCode: number; stderrTail: string }>;
}

const SSH_KEEPALIVE_FLAGS = [
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=20",
  "-o", "StrictHostKeyChecking=accept-new",
];

const DEFAULT_USER = "admin";

export interface RealInVmSshExecutorOpts {
  user?: string;
  /** Override `ssh` lookup (tests). */
  sshPath?: string;
}

// Tail of stderr captured even when stdio is inherited — surfaces in the
// error message on non-zero exit so failures aren't opaque "exit 1".
const STDERR_TAIL_BYTES = 4096;

export interface InVmSshExecResult {
  exitCode: number;
  stderrTail: string;
}

export class RealInVmSshExecutor implements InVmSshExecutor {
  private readonly user: string;
  private readonly sshPath: string;

  constructor(opts: RealInVmSshExecutorOpts = {}) {
    this.user = opts.user ?? DEFAULT_USER;
    this.sshPath = opts.sshPath ?? "ssh";
  }

  async exec(
    target: string,
    argv: ReadonlyArray<string>,
    opts: { cwd: string; env: Record<string, string> },
  ): Promise<number> {
    const result = await this.execCapturingStderr(target, argv, opts);
    return result.exitCode;
  }

  async execCapturingStderr(
    target: string,
    argv: ReadonlyArray<string>,
    opts: { cwd: string; env: Record<string, string> },
  ): Promise<InVmSshExecResult> {
    const remoteCmd = buildRemoteCommand(opts.cwd, opts.env, argv);
    const sshArgs = [...SSH_KEEPALIVE_FLAGS, `${this.user}@${target}`, remoteCmd];
    return new Promise<InVmSshExecResult>((resolve, reject) => {
      // stdin inherited (no input), stdout inherited (user sees live output),
      // stderr piped so we can mirror + capture tail.
      const child = spawn(this.sshPath, sshArgs, { stdio: ["inherit", "inherit", "pipe"] });
      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        process.stderr.write(text);
        stderrTail += text;
        if (stderrTail.length > STDERR_TAIL_BYTES) {
          stderrTail = stderrTail.slice(stderrTail.length - STDERR_TAIL_BYTES);
        }
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ exitCode: code ?? -1, stderrTail }));
    });
  }
}

// Build the remote shell line — `cd <cwd> && env K=V K=V <argv>`. Exported so
// unit tests can assert the exact line we send without spawning ssh.
export function buildRemoteCommand(
  cwd: string,
  env: Record<string, string>,
  argv: ReadonlyArray<string>,
): string {
  const envAssign = Object.entries(env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  const cwdPrefix = cwd ? `cd ${shellQuote(cwd)} && ` : "";
  const envPrefix = envAssign ? `env ${envAssign} ` : "";
  return cwdPrefix + envPrefix + argv.map(shellQuote).join(" ");
}
