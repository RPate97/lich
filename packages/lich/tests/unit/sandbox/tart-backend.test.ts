import { describe, test, expect, beforeEach } from 'vitest';
import { TartBackend, parseVmStatFreeMemory, buildStartTimeoutError } from '../../../src/sandbox/tart.js';
import type { TartCli } from '../../../src/sandbox/tart-cli.js';
import { SandboxAlreadyExistsError, SandboxNotFoundError } from '../../../src/sandbox/errors.js';

class FakeTartCli implements TartCli {
  public calls: Array<{ args: ReadonlyArray<string>; stdin?: string }> = [];
  public responses: Map<string, { stdout: string; stderr: string }> = new Map();

  async run(args: ReadonlyArray<string>, opts?: { stdin?: string }): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ args, stdin: opts?.stdin });
    const key = args.join(' ');
    return this.responses.get(key) ?? { stdout: '', stderr: '' };
  }
}

function listResponse(entries: Array<{ Name: string; State: string }>): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify(
      entries.map(e => ({ ...e, Source: 'local', Disk: 1, SizeOnDisk: 1, Running: e.State === 'running' })),
    ),
    stderr: '',
  };
}

describe('TartBackend lifecycle', () => {
  let fake: FakeTartCli;
  let backend: TartBackend;

  beforeEach(() => {
    fake = new FakeTartCli();
    backend = new TartBackend(fake);
  });

  test('inspect returns absent for unknown VM', async () => {
    fake.responses.set('list --format json', listResponse([]));
    expect(await backend.inspect('missing')).toEqual({ name: 'missing', state: 'absent' });
  });

  test('inspect maps tart states correctly', async () => {
    fake.responses.set('list --format json', listResponse([
      { Name: 'a', State: 'running' },
      { Name: 'b', State: 'stopped' },
    ]));
    expect((await backend.inspect('a')).state).toBe('running');
    expect((await backend.inspect('b')).state).toBe('stopped');
  });

  test('inspect maps unknown tart states to "unknown"', async () => {
    fake.responses.set('list --format json', listResponse([{ Name: 'a', State: 'suspended' }]));
    expect((await backend.inspect('a')).state).toBe('unknown');
  });

  test('create clones the image and applies memory/cpus', async () => {
    fake.responses.set('list --format json', listResponse([]));
    await backend.create({ name: 'new', image: 'base:latest', memoryMb: 8192, cpus: 6 });
    const argLists = fake.calls.map(c => c.args.join(' '));
    expect(argLists).toContain('clone base:latest new');
    expect(argLists).toContain('set new --memory 8192 --cpu 6');
  });

  test('create throws SandboxAlreadyExistsError when VM exists', async () => {
    fake.responses.set('list --format json', listResponse([{ Name: 'x', State: 'stopped' }]));
    await expect(backend.create({ name: 'x', image: 'b:l' })).rejects.toBeInstanceOf(SandboxAlreadyExistsError);
  });

  test('destroy is a no-op on absent VM', async () => {
    fake.responses.set('list --format json', listResponse([]));
    await backend.destroy('missing');
    expect(fake.calls.map(c => c.args.join(' '))).not.toContain('delete missing');
  });

  test('destroy stops then deletes if running', async () => {
    fake.responses.set('list --format json', listResponse([{ Name: 'x', State: 'running' }]));
    await backend.destroy('x');
    const argLists = fake.calls.map(c => c.args.join(' '));
    expect(argLists).toContain('stop x');
    expect(argLists).toContain('delete x');
  });

  test('stop is a no-op when already stopped', async () => {
    fake.responses.set('list --format json', listResponse([{ Name: 'x', State: 'stopped' }]));
    await backend.stop('x');
    const argLists = fake.calls.map(c => c.args.join(' '));
    expect(argLists).not.toContain('stop x');
  });

  test('stop throws SandboxNotFoundError when absent', async () => {
    fake.responses.set('list --format json', listResponse([]));
    await expect(backend.stop('missing')).rejects.toBeInstanceOf(SandboxNotFoundError);
  });

  test('clone requires the source to be stopped', async () => {
    fake.responses.set('list --format json', listResponse([{ Name: 'src', State: 'running' }]));
    await expect(backend.clone('src', 'dst')).rejects.toThrow(/must be stopped/);
  });

  test('clone of a stopped source issues the clone', async () => {
    fake.responses.set('list --format json', listResponse([{ Name: 'src', State: 'stopped' }]));
    await backend.clone('src', 'dst');
    expect(fake.calls.map(c => c.args.join(' '))).toContain('clone src dst');
  });

  test('clone throws when destination already exists', async () => {
    fake.responses.set('list --format json', listResponse([
      { Name: 'src', State: 'stopped' },
      { Name: 'dst', State: 'stopped' },
    ]));
    await expect(backend.clone('src', 'dst')).rejects.toBeInstanceOf(SandboxAlreadyExistsError);
  });
});

describe('parseVmStatFreeMemory', () => {
  test('parses macOS vm_stat output with 16KB pages', () => {
    const sample = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                    11542.',
      'Pages active:                                 364755.',
      'Pages inactive:                               361464.',
      'Pages speculative:                              2868.',
    ].join('\n');
    const got = parseVmStatFreeMemory(sample);
    expect(got).not.toBeNull();
    expect(got!.freeMb).toBe(Math.round((11542 * 16384) / (1024 * 1024)));
    expect(got!.reclaimableMb).toBe(
      Math.round(((11542 + 361464 + 2868) * 16384) / (1024 * 1024)),
    );
  });

  test('parses macOS vm_stat output with 4KB pages', () => {
    const sample = [
      'Mach Virtual Memory Statistics: (page size of 4096 bytes)',
      'Pages free:                                    100000.',
      'Pages inactive:                                200000.',
    ].join('\n');
    const got = parseVmStatFreeMemory(sample);
    expect(got).not.toBeNull();
    expect(got!.freeMb).toBe(Math.round((100000 * 4096) / (1024 * 1024)));
  });

  test('returns null when page size is missing', () => {
    const sample = 'Pages free: 11542.';
    expect(parseVmStatFreeMemory(sample)).toBeNull();
  });

  test('returns null when Pages free is missing', () => {
    const sample = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)';
    expect(parseVmStatFreeMemory(sample)).toBeNull();
  });
});

describe('buildStartTimeoutError', () => {
  test('includes deadline in seconds in the error message', () => {
    const err = buildStartTimeoutError('lich-test-vm', 45_000, null);
    expect(err.stderr).toContain('45s');
    expect(err.stderr).toContain('VM did not reach running state');
    expect(err.command).toEqual(['run', 'lich-test-vm']);
  });

  test('includes host memory summary when probe succeeded', () => {
    const err = buildStartTimeoutError('lich-test-vm', 45_000, {
      freeMb: 180,
      reclaimableMb: 6000,
    });
    expect(err.stderr).toContain('180');
    expect(err.stderr).toContain('6000');
    expect(err.stderr).toContain('host');
  });

  test('omits host suffix when memory probe returned null', () => {
    const err = buildStartTimeoutError('lich-test-vm', 45_000, null);
    expect(err.stderr).not.toContain('host:');
    expect(err.stderr).not.toContain('MB');
  });
});
