import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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

// SSH transport setup so mutagen can reach the Tart guest. The recipe (proven
// against mutagen 0.18.1 + cirruslabs ubuntu + openssh-server): per-run ephemeral
// ed25519 key pushed into the guest's admin user, host key appended to the host's
// known_hosts via ssh-keyscan, key added to ssh-agent so mutagen's ssh subprocess
// finds it. NEVER touches ~/.ssh/config. The known_hosts append is append-only
// and is what every interactive `ssh -o StrictHostKeyChecking=accept-new` would
// do — same standard-ssh behavior.
export interface MutagenTransport {
  prepare(opts: { name: string; host: string }): Promise<{ user: string }>;
  cleanup(opts: { name: string }): Promise<void>;
}

export const noopTransport: MutagenTransport = {
  async prepare() { return { user: "admin" }; },
  async cleanup() {},
};

export class RealSshTransport implements MutagenTransport {
  constructor(
    private readonly workDir: string = join(process.env.LICH_HOME ?? join(homedir(), ".lich"), "mutagen"),
    private readonly tartPath: string = "tart",
    private readonly user: string = "admin",
    private readonly knownHostsPath: string = join(homedir(), ".ssh", "known_hosts"),
  ) {}

  private keyPath(name: string): string {
    return join(this.workDir, "keys", name);
  }

  async prepare(opts: { name: string; host: string }): Promise<{ user: string }> {
    const keyDir = join(this.workDir, "keys");
    mkdirSync(keyDir, { recursive: true });
    const keyPath = this.keyPath(opts.name);

    if (!existsSync(keyPath)) {
      execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-q"]);
    }
    const pub = readFileSync(`${keyPath}.pub`, "utf8").trim();

    const pushScript =
      `install -d -m700 -o ${this.user} -g ${this.user} /home/${this.user}/.ssh; ` +
      `printf '%s\\n' '${pub}' > /home/${this.user}/.ssh/authorized_keys; ` +
      `chown ${this.user}:${this.user} /home/${this.user}/.ssh/authorized_keys; ` +
      `chmod 600 /home/${this.user}/.ssh/authorized_keys`;
    execFileSync(this.tartPath, ["exec", opts.name, "sudo", "bash", "-c", pushScript], { stdio: "ignore" });

    const scan = execFileSync("ssh-keyscan", ["-t", "ed25519", opts.host], { encoding: "utf8" });
    if (!existingKnownHost(this.knownHostsPath, opts.host)) {
      mkdirSync(join(homedir(), ".ssh"), { recursive: true });
      appendFileSync(this.knownHostsPath, scan, { mode: 0o600 });
    }

    execFileSync("ssh-add", [keyPath], { stdio: "ignore" });

    return { user: this.user };
  }

  async cleanup(opts: { name: string }): Promise<void> {
    const keyPath = this.keyPath(opts.name);
    if (existsSync(keyPath)) {
      try { execFileSync("ssh-add", ["-d", keyPath], { stdio: "ignore" }); } catch { /* not in agent */ }
    }
  }
}

function existingKnownHost(path: string, host: string): boolean {
  try {
    return readFileSync(path, "utf8").split("\n").some((line) => line.startsWith(host + " ") || line.startsWith(host + ","));
  } catch {
    return false;
  }
}

export class MutagenSync implements SandboxSync {
  constructor(
    private readonly cli: MutagenCli = new RealMutagenCli(),
    private readonly transport: MutagenTransport = noopTransport,
  ) {}

  async start(opts: SyncStartOpts): Promise<void> {
    // Idempotent: clean up any leftover session of the same name first. Re-up
    // on a still-running run VM (warm path) would otherwise hit `session name
    // already exists`. terminate is best-effort — `no such session` is fine.
    await this.cli.run(["sync", "terminate", opts.name]).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such session|unable to locate/i.test(msg)) throw err;
    });
    const { user } = await this.transport.prepare({ name: opts.name, host: opts.target });
    const ignores = [...new Set([...ALWAYS_IGNORE, ...opts.ignore])];
    const args: string[] = ["sync", "create", "--name", opts.name];
    for (const ig of ignores) args.push("--ignore", ig);
    if (opts.extraFlags) args.push(...opts.extraFlags);
    args.push(opts.hostPath, `${user}@${opts.target}:${opts.guestPath}`);
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
      if (!/no such session|unable to locate/i.test(msg)) {
        await this.transport.cleanup({ name });
        throw err;
      }
    }
    await this.transport.cleanup({ name });
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
