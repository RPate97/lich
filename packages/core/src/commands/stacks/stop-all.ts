import { spawn } from 'node:child_process';
import { CLIError } from '../../errors';
import { LEVELZERO_PREFIX } from '../../compose/naming';
import type { Registry } from '../../registry';
import type { Command } from '../types';

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a `docker` CLI command, capturing stdout/stderr. Never rejects on
 * non-zero exit codes — callers inspect `exitCode`. SIGKILLs on timeout.
 *
 * Inlined here (LEV-134) because the previous shared `dockerExec` helper in
 * `src/docker/exec.ts` was deleted along with the legacy non-compose runner.
 * `stacks stop --all` still needs raw `docker ps`/`docker rm -f` because it
 * sweeps orphan containers that aren't tied to a known compose project file.
 */
function dockerExec(args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`docker ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function removeContainer(name: string): Promise<void> {
  const r = await dockerExec(['rm', '-f', name], 30_000);
  if (r.exitCode !== 0 && !r.stderr.includes('No such container')) {
    throw new Error(`failed to stop ${name}: ${r.stderr.trim()}`);
  }
}

async function listLevelzeroContainers(): Promise<string[]> {
  const r = await dockerExec(
    ['ps', '-a', '--filter', `name=${LEVELZERO_PREFIX}`, '--format', '{{.Names}}'],
    10_000,
  );
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith(LEVELZERO_PREFIX));
}

export function makeStacksStopAllCommand(getRegistry: () => Registry): Command {
  return {
    name: 'stacks.stop',
    describe: 'Tear down every running levelzero stack on this machine (requires --all)',
    async run(ctx) {
      if (!ctx.flags['all']) {
        throw new CLIError(
          'INTERNAL',
          'stacks stop without --all is not supported in v0',
          'pass --all to tear down every running stack',
        );
      }
      const reg = getRegistry();
      const stoppedFromRegistry: string[] = [];
      const fromRegistryContainers = new Set<string>();

      await reg.withLock(async () => {
        const entries = await reg.list();
        for (const { key, entry } of entries) {
          for (const cname of entry.containers) {
            await removeContainer(cname);
            fromRegistryContainers.add(cname);
          }
          await reg.remove(key);
          stoppedFromRegistry.push(key);
        }
      });

      // Orphan sweep outside the lock — best-effort.
      const remaining = await listLevelzeroContainers();
      const stoppedOrphans: string[] = [];
      for (const cname of remaining) {
        if (fromRegistryContainers.has(cname)) continue;
        await removeContainer(cname);
        stoppedOrphans.push(cname);
      }

      const result = { stoppedFromRegistry, stoppedOrphans };
      if (ctx.format === 'json') return result;
      const lines: string[] = [];
      lines.push(`stopped ${stoppedFromRegistry.length} registered stack(s)`);
      for (const k of stoppedFromRegistry) lines.push(`  ${k}`);
      lines.push(`stopped ${stoppedOrphans.length} orphan container(s)`);
      for (const c of stoppedOrphans) lines.push(`  ${c}`);
      return lines.join('\n') + '\n';
    },
  };
}
