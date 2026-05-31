import { execSync } from 'node:child_process';
import { beforeAll, afterAll } from 'vitest';
import { TartBackend } from '../../lich/src/sandbox/tart.js';

let tartAvailable: boolean | undefined;

export function isTartAvailable(): boolean {
  if (tartAvailable !== undefined) return tartAvailable;
  if (process.platform !== 'darwin') {
    tartAvailable = false;
    return false;
  }
  try {
    execSync('tart --version', { stdio: 'ignore' });
    tartAvailable = true;
    return true;
  } catch {
    tartAvailable = false;
    return false;
  }
}

export async function destroyIfExists(backend: TartBackend, name: string): Promise<void> {
  await backend.destroy(name);
}

export function withFreshVm(
  backend: TartBackend,
  config: { name: string; image: string; memoryMb?: number; cpus?: number },
): { name: string } {
  beforeAll(async () => {
    await destroyIfExists(backend, config.name);
    await backend.create(config);
    await backend.start(config.name);
    await new Promise(r => setTimeout(r, 5000));
  }, 120_000);

  afterAll(async () => {
    await destroyIfExists(backend, config.name);
  }, 60_000);

  return { name: config.name };
}
