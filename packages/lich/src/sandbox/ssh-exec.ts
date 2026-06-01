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
    const remoteCmd = buildRemoteCommand(opts.cwd, opts.env, argv);
    const sshArgs = [...SSH_KEEPALIVE_FLAGS, `${this.user}@${target}`, remoteCmd];
    return new Promise<number>((resolve, reject) => {
      const child = spawn(this.sshPath, sshArgs, { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
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
