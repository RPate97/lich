import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { TartBackend } from '../../../lich/src/sandbox/tart.js';
import { isTartAvailable } from '../../helpers/tart.js';

// Disk-fork proof: a baked golden, shut down gracefully, CoW-cloned into a
// fork that boots fresh against the baked disk. Apple Virtualization.framework
// cannot suspend Linux guests, so this is disk-level (not memory-level) fork.

const TEST_IMAGE = process.env.LICH_SANDBOX_TEST_IMAGE ?? 'ghcr.io/cirruslabs/ubuntu:latest';
const SRC = 'lich-test-fork-src';
const FORK = 'lich-test-fork-fork';

describe.skipIf(!isTartAvailable())('TartBackend disk-fork (e2e)', () => {
  const backend = new TartBackend();

  beforeAll(async () => {
    await backend.destroy(SRC);
    await backend.destroy(FORK);
    await backend.create({ name: SRC, image: TEST_IMAGE });
    await backend.start(SRC);
  }, 180_000);

  afterAll(async () => {
    await backend.destroy(SRC);
    await backend.destroy(FORK);
  }, 60_000);

  test('bake + graceful stop + clone + boot — baked disk survives in the fork', async () => {
    // Bake: write a marker to the golden's disk and flush it.
    const bake = await backend.exec(SRC, ['sh', '-c',
      'echo GOLDEN-DATA-99 | sudo tee /opt/baked.txt >/dev/null && sudo mkdir -p /var/lib/pgdata && echo 16 | sudo tee /var/lib/pgdata/PG_VERSION >/dev/null && sync']);
    expect(bake.exitCode).toBe(0);

    // Graceful stop (in-guest poweroff) flushes the disk; required before clone.
    await backend.stop(SRC);
    expect((await backend.inspect(SRC)).state).toBe('stopped');

    // CoW disk clone of the stopped golden.
    await backend.clone(SRC, FORK);
    expect((await backend.inspect(FORK)).state).toBe('stopped');

    // Fork boots fresh against the cloned disk.
    await backend.start(FORK);
    expect((await backend.inspect(FORK)).state).toBe('running');

    // The baked disk state must be present in the fork.
    const baked = await backend.exec(FORK, ['cat', '/opt/baked.txt']);
    expect(baked.exitCode).toBe(0);
    expect(baked.stdout.trim()).toBe('GOLDEN-DATA-99');

    const pg = await backend.exec(FORK, ['cat', '/var/lib/pgdata/PG_VERSION']);
    expect(pg.exitCode).toBe(0);
    expect(pg.stdout.trim()).toBe('16');
  }, 180_000);
});
