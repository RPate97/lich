// Thin wrapper around the `tart` shell binary. Exists separately from
// TartBackend so we can inject a fake in unit tests.

import { spawn } from 'node:child_process';
import { TartCommandError } from './errors.js';

export interface TartCli {
  run(args: ReadonlyArray<string>, opts?: { stdin?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
}

export class RealTartCli implements TartCli {
  constructor(private readonly tartPath = 'tart') {}

  async run(args: ReadonlyArray<string>, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.tartPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timer: ReturnType<typeof setTimeout> | undefined;

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
        child.stdin.end();
      }

      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new TartCommandError(args, -1, stdout, `timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new TartCommandError(args, code ?? -1, stdout, stderr));
        }
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new TartCommandError(args, -1, stdout, String(err)));
      });
    });
  }
}
