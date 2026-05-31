import { spawn } from "node:child_process";
import { ALWAYS_IGNORE, type SandboxSync, type SyncStartOpts } from "./sync.js";

export interface MutagenCli {
  run(args: ReadonlyArray<string>, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
}

export class RealMutagenCli implements MutagenCli {
  constructor(private readonly mutagenPath = "mutagen") {}

  async run(
    args: ReadonlyArray<string>,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.mutagenPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`mutagen ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`mutagen ${args.join(" ")} failed (exit ${code}): ${stderr || stdout}`));
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }
}

export class MutagenSync implements SandboxSync {
  constructor(private readonly cli: MutagenCli = new RealMutagenCli()) {}

  async start(opts: SyncStartOpts): Promise<void> {
    const ignores = [...new Set([...ALWAYS_IGNORE, ...opts.ignore])];
    const args: string[] = ["sync", "create", "--name", opts.name];
    for (const ig of ignores) args.push("--ignore", ig);
    if (opts.extraFlags) args.push(...opts.extraFlags);
    args.push(opts.hostPath, `${opts.target}:${opts.guestPath}`);
    await this.cli.run(args);
  }

  async flush(name: string): Promise<void> {
    await this.cli.run(["sync", "flush", name]);
  }

  async terminate(name: string): Promise<void> {
    try {
      await this.cli.run(["sync", "terminate", name]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such session|unable to locate/i.test(msg)) return;
      throw err;
    }
  }

  async status(name: string): Promise<string> {
    const { stdout } = await this.cli.run(["sync", "list", name]);
    return stdout;
  }
}

export async function isMutagenAvailable(cli: MutagenCli = new RealMutagenCli()): Promise<boolean> {
  try {
    await cli.run(["version"]);
    return true;
  } catch {
    return false;
  }
}
