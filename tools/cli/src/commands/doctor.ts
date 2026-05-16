import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../config';
import type { Registry } from '../registry';
import { findWorktree } from '../worktree';
import type { Command } from './types';

type Status = 'ok' | 'error' | 'skipped';
interface Check {
  id: string;
  status: Status;
  message?: string;
}

export function makeDoctorCommand(getRegistry: () => Registry): Command {
  return {
    name: 'doctor',
    describe: 'Diagnose the local environment',
    async run(ctx) {
      const checks: Check[] = [];

      // Registry directory writable
      const regPath = (getRegistry() as any).path as string;
      try {
        await mkdir(dirname(regPath), { recursive: true });
        await access(dirname(regPath));
        checks.push({ id: 'registry', status: 'ok' });
      } catch (err) {
        checks.push({
          id: 'registry',
          status: 'error',
          message: `cannot access registry dir ${dirname(regPath)}: ${(err as Error).message}`,
        });
      }

      // Worktree presence
      const wt = await findWorktree(ctx.cwd);
      if (!wt) {
        checks.push({ id: 'project', status: 'skipped', message: 'not inside a levelzero project' });
      } else {
        checks.push({ id: 'project', status: 'ok', message: wt.path });
        // Config loadable
        try {
          await loadConfig(wt.configPath);
          checks.push({ id: 'config', status: 'ok' });
        } catch (err) {
          checks.push({ id: 'config', status: 'error', message: (err as Error).message });
        }
      }

      const ok = checks.every((c) => c.status !== 'error');
      return { ok, checks };
    },
  };
}
