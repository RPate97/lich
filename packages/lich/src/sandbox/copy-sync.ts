import { spawn } from "node:child_process";
import { ALWAYS_IGNORE, type SandboxSync, type SyncStartOpts } from "./sync.js";

export interface PipeExec {
  run(
    producer: { cmd: string; args: string[]; cwd: string },
    consumer: { cmd: string; args: string[] },
  ): Promise<void>;
}

export class RealPipeExec implements PipeExec {
  async run(
    producer: { cmd: string; args: string[]; cwd: string },
    consumer: { cmd: string; args: string[] },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn(producer.cmd, producer.args, { cwd: producer.cwd, stdio: ["ignore", "pipe", "pipe"] });
      const c = spawn(consumer.cmd, consumer.args, { stdio: ["pipe", "inherit", "pipe"] });
      p.stdout.pipe(c.stdin);
      let perr = "";
      let cerr = "";
      p.stderr.on("data", (d) => { perr += d.toString(); });
      c.stderr.on("data", (d) => { cerr += d.toString(); });
      let pDone = false;
      let cDone = false;
      let pCode = 0;
      let cCode = 0;
      const maybeFinish = (): void => {
        if (!pDone || !cDone) return;
        if (pCode !== 0) reject(new Error(`tar (host) failed (exit ${pCode}): ${perr}`));
        else if (cCode !== 0) reject(new Error(`tar (guest) failed (exit ${cCode}): ${cerr}`));
        else resolve();
      };
      p.on("close", (code) => { pDone = true; pCode = code ?? 0; maybeFinish(); });
      c.on("close", (code) => { cDone = true; cCode = code ?? 0; maybeFinish(); });
      p.on("error", reject);
      c.on("error", reject);
    });
  }
}

// One-shot source copy via `tar | tart exec -i <vm> tar -x`. No live watch:
// flush re-copies the whole tree. The mechanics-only fallback for when
// Mutagen's transport is unavailable on local Tart.
export class CopySync implements SandboxSync {
  private readonly sessions = new Map<string, SyncStartOpts>();

  constructor(
    private readonly pipe: PipeExec = new RealPipeExec(),
    private readonly tartPath = "tart",
  ) {}

  async start(opts: SyncStartOpts): Promise<void> {
    this.sessions.set(opts.name, opts);
    await this.copy(opts);
  }

  async flush(name: string): Promise<void> {
    const opts = this.sessions.get(name);
    if (!opts) return;
    await this.copy(opts);
  }

  async terminate(name: string): Promise<void> {
    this.sessions.delete(name);
  }

  async status(name: string): Promise<string> {
    return this.sessions.has(name) ? "copy-sync (one-shot, no live watch)" : "absent";
  }

  private async copy(opts: SyncStartOpts): Promise<void> {
    const excludes = [...new Set([...ALWAYS_IGNORE, ...opts.ignore])];
    const tarArgs = excludes.map((e) => `--exclude=${e}`);
    tarArgs.push("-cf", "-", ".");
    await this.pipe.run(
      { cmd: "tar", args: tarArgs, cwd: opts.hostPath },
      { cmd: this.tartPath, args: ["exec", "-i", opts.name, "tar", "-xf", "-", "-C", opts.guestPath] },
    );
  }
}
