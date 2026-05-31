import { spawn } from 'node:child_process';
import type { SandboxBackend, SandboxConfig, SandboxState, ExecResult, ExecOptions } from './backend.js';
import type { TartCli } from './tart-cli.js';
import { RealTartCli } from './tart-cli.js';
import { SandboxNotFoundError, SandboxAlreadyExistsError, TartCommandError } from './errors.js';

interface TartListEntry {
  Name: string;
  State: string;
  Source: string;
  Disk: number;
  SizeOnDisk: number;
  Running: boolean;
}

const stateMap: Record<string, SandboxState['state']> = {
  running: 'running',
  stopped: 'stopped',
  suspended: 'suspended',
};

export class TartBackend implements SandboxBackend {
  constructor(
    private readonly cli: TartCli = new RealTartCli(),
    private readonly tartPath: string = "tart",
  ) {}

  async create(config: SandboxConfig): Promise<void> {
    const existing = await this.inspect(config.name);
    if (existing.state !== 'absent') {
      throw new SandboxAlreadyExistsError(config.name);
    }
    await this.cli.run(['clone', config.image, config.name]);

    const setArgs: string[] = ['set', config.name];
    if (config.memoryMb !== undefined) setArgs.push('--memory', String(config.memoryMb));
    if (config.cpus !== undefined) setArgs.push('--cpu', String(config.cpus));
    if (setArgs.length > 2) {
      await this.cli.run(setArgs);
    }
  }

  async inspect(name: string): Promise<SandboxState> {
    const { stdout } = await this.cli.run(['list', '--format', 'json']);
    const entries: TartListEntry[] = JSON.parse(stdout);
    const entry = entries.find(e => e.Name === name);
    if (!entry) return { name, state: 'absent' };
    return { name, state: stateMap[entry.State] ?? 'unknown' };
  }

  async list(): Promise<ReadonlyArray<SandboxState>> {
    const { stdout } = await this.cli.run(['list', '--format', 'json']);
    const entries: TartListEntry[] = JSON.parse(stdout);
    return entries.map(e => ({ name: e.Name, state: stateMap[e.State] ?? 'unknown' }));
  }

  async start(name: string): Promise<void> {
    const state = await this.inspect(name);
    if (state.state === 'absent') throw new SandboxNotFoundError(name);
    if (state.state === 'running') return;
    // tart run is foreground; spawn detached so the parent process returns.
    // We don't await child completion — Tart manages the VM independently.
    const child = spawn('tart', ['run', '--no-graphics', name], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    // Poll until tart reports the VM running.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const s = await this.inspect(name);
      if (s.state === 'running') return;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new TartCommandError(['run', name], -1, '', 'VM did not reach running state in 30s');
  }

  async stop(name: string): Promise<void> {
    const state = await this.inspect(name);
    if (state.state === 'absent') throw new SandboxNotFoundError(name);
    if (state.state === 'stopped') return;
    await this.cli.run(['stop', name]);
  }

  async destroy(name: string): Promise<void> {
    const state = await this.inspect(name);
    if (state.state === 'absent') return;
    if (state.state === 'running' || state.state === 'suspended') {
      await this.cli.run(['stop', name]);
    }
    await this.cli.run(['delete', name]);
  }

  async suspend(name: string): Promise<void> {
    const state = await this.inspect(name);
    if (state.state === 'absent') throw new SandboxNotFoundError(name);
    if (state.state === 'suspended') return;
    if (state.state !== 'running') {
      throw new Error(`cannot suspend sandbox '${name}': state is ${state.state}`);
    }
    await this.cli.run(['suspend', name]);
  }

  async resume(name: string): Promise<void> {
    const state = await this.inspect(name);
    if (state.state === 'absent') throw new SandboxNotFoundError(name);
    if (state.state === 'running') return;
    if (state.state !== 'suspended') {
      throw new Error(`cannot resume sandbox '${name}': state is ${state.state}`);
    }
    // Tart resumes via `run` against a suspended VM.
    const child = spawn('tart', ['run', '--no-graphics', name], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const s = await this.inspect(name);
      if (s.state === 'running') return;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new TartCommandError(['run', name], -1, '', 'VM did not reach running state in 30s');
  }

  async clone(source: string, dest: string): Promise<void> {
    const sourceState = await this.inspect(source);
    if (sourceState.state === 'absent') throw new SandboxNotFoundError(source);
    const destState = await this.inspect(dest);
    if (destState.state !== 'absent') throw new SandboxAlreadyExistsError(dest);
    await this.cli.run(['clone', source, dest]);
  }

  async ip(name: string): Promise<string> {
    const state = await this.inspect(name);
    if (state.state === 'absent') throw new SandboxNotFoundError(name);
    const { stdout } = await this.cli.run(['ip', name]);
    return stdout.trim();
  }

  async exec(name: string, cmd: ReadonlyArray<string>, opts: ExecOptions = {}): Promise<ExecResult> {
    const state = await this.inspect(name);
    if (state.state === 'absent') throw new SandboxNotFoundError(name);
    if (state.state !== 'running') {
      throw new Error(`cannot exec in sandbox '${name}': state is ${state.state}`);
    }
    const ip = await this.ip(name);

    const sshArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-i', this.sshKey,
      `admin@${ip}`,
    ];
    const cwdPrefix = opts.cwd ? `cd ${shellQuote(opts.cwd)} && ` : '';
    const envPrefix = Object.entries(opts.env ?? {})
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(' ');
    const shellLine = cwdPrefix
      + (envPrefix ? envPrefix + ' ' : '')
      + cmd.map(shellQuote).join(' ');
    sshArgs.push(shellLine);

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn('ssh', sshArgs, {
        stdio: opts.inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      if (!opts.inheritStdio) {
        child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
      }
      const timer = opts.timeoutMs
        ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`exec timed out after ${opts.timeoutMs}ms`)); }, opts.timeoutMs)
        : undefined;
      child.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
      child.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
