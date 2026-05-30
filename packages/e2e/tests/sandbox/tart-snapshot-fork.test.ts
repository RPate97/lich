import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { TartBackend } from '../../../lich/src/sandbox/tart.js';
import { isTartAvailable } from '../../helpers/tart.js';

const TEST_IMAGE = process.env.LICH_SANDBOX_TEST_IMAGE ?? 'ghcr.io/cirruslabs/ubuntu:latest';
const SRC = 'lich-test-snapshot-src';
const FORK = 'lich-test-snapshot-fork';

describe.skipIf(!isTartAvailable())('TartBackend snapshot/fork (e2e)', () => {
  const backend = new TartBackend();

  beforeAll(async () => {
    await backend.destroy(SRC);
    await backend.destroy(FORK);
    await backend.create({ name: SRC, image: TEST_IMAGE });
    await backend.start(SRC);
    await new Promise(r => setTimeout(r, 5000));
  }, 120_000);

  afterAll(async () => {
    await backend.destroy(SRC);
    await backend.destroy(FORK);
  }, 60_000);

  test('write data, suspend, clone, resume — data survives in the clone', async () => {
    const write = await backend.exec(SRC, ['bash', '-c', 'echo "marker-from-source" > /tmp/marker.txt']);
    expect(write.exitCode).toBe(0);

    await backend.suspend(SRC);
    expect((await backend.inspect(SRC)).state).toBe('suspended');

    await backend.clone(SRC, FORK);
    expect((await backend.inspect(FORK)).state).toBe('suspended');

    await backend.resume(FORK);
    await new Promise(r => setTimeout(r, 5000));
    expect((await backend.inspect(FORK)).state).toBe('running');

    const read = await backend.exec(FORK, ['cat', '/tmp/marker.txt']);
    expect(read.exitCode).toBe(0);
    expect(read.stdout.trim()).toBe('marker-from-source');

    await backend.resume(SRC);
  }, 180_000);
});
