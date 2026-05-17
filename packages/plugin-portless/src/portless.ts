import { spawn } from 'node:child_process';
import type { PortlessAdapter, URLEntry } from './types';

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the `portless` CLI with the given args, buffering stdout/stderr.
 *
 * Resolves with `{ exitCode, stdout, stderr }` for any clean process exit
 * (including non-zero); callers decide whether non-zero is an error.
 *
 * Rejects when the OS could not spawn the binary at all (most commonly
 * `ENOENT` when portless isn't on PATH). We surface those as the original
 * Error so callers can pattern-match on `.code`.
 */
function runPortless(args: string[]): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const proc = spawn('portless', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      reject(err);
    });
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function fail(action: string, r: SpawnResult): Error {
  const detail = (r.stderr || r.stdout).trim() || `exit ${r.exitCode}`;
  return new Error(`portless ${action} failed (exit ${r.exitCode}): ${detail}`);
}

export const portlessAdapter: PortlessAdapter = {
  name: 'portless',

  async available(): Promise<boolean> {
    try {
      const r = await runPortless(['--version']);
      return r.exitCode === 0;
    } catch {
      // ENOENT (binary not on PATH) and any other spawn-time failure mean
      // portless is unavailable. We deliberately swallow the error rather
      // than rethrowing — `available()` is a probe, not an assertion.
      return false;
    }
  },

  async register(input: { host: string; target: string }): Promise<void> {
    const r = await runPortless(['register', input.host, input.target]);
    if (r.exitCode !== 0) throw fail('register', r);
  },

  async unregister(host: string): Promise<void> {
    const r = await runPortless(['unregister', host]);
    if (r.exitCode !== 0) throw fail('unregister', r);
  },

  async list(): Promise<URLEntry[]> {
    const r = await runPortless(['list', '--json']);
    if (r.exitCode !== 0) throw fail('list', r);
    const parsed = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`portless list returned non-array JSON: ${r.stdout.slice(0, 200)}`);
    }
    return parsed as URLEntry[];
  },
};
