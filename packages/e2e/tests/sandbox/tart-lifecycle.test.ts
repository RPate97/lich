import { describe, expect, test } from 'vitest';
import { TartBackend } from '../../../lich/src/sandbox/tart.js';
import { withFreshVm, isTartAvailable } from '../../helpers/tart.js';

const TEST_IMAGE = process.env.LICH_SANDBOX_TEST_IMAGE ?? 'ghcr.io/cirruslabs/ubuntu:latest';

describe.skipIf(!isTartAvailable())('TartBackend lifecycle (e2e)', () => {
  const backend = new TartBackend();
  const { name } = withFreshVm(backend, { name: 'lich-test-lifecycle', image: TEST_IMAGE });

  test('inspect reports running', async () => {
    expect((await backend.inspect(name)).state).toBe('running');
  });

  test('ip returns a routable address', async () => {
    const ip = await backend.ip(name);
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  test('exec runs commands in the guest', async () => {
    const result = await backend.exec(name, ['echo', 'hello-from-guest']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-from-guest');
  }, 30_000);

  test('stop transitions to stopped state', async () => {
    await backend.stop(name);
    expect((await backend.inspect(name)).state).toBe('stopped');
    await backend.start(name);
  }, 60_000);
});
