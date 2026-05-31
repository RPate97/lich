import { describe, test, expect, beforeEach } from 'vitest';
import { TartBackend } from '../../../src/sandbox/tart.js';
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

describe('TartBackend lifecycle', () => {
  let fake: FakeTartCli;
  let backend: TartBackend;

  beforeEach(() => {
    fake = new FakeTartCli();
    backend = new TartBackend(fake);
  });

  test('inspect returns absent for unknown VM', async () => {
    fake.responses.set('list --format json', { stdout: '[]', stderr: '' });
    expect(await backend.inspect('missing')).toEqual({ name: 'missing', state: 'absent' });
  });

  test('inspect maps tart states correctly', async () => {
    fake.responses.set('list --format json', {
      stdout: JSON.stringify([
        { Name: 'a', State: 'running', Source: 'local', Disk: 1, SizeOnDisk: 1, Running: true },
        { Name: 'b', State: 'stopped', Source: 'local', Disk: 1, SizeOnDisk: 1, Running: false },
        { Name: 'c', State: 'suspended', Source: 'local', Disk: 1, SizeOnDisk: 1, Running: false },
      ]),
      stderr: '',
    });
    expect((await backend.inspect('a')).state).toBe('running');
    expect((await backend.inspect('b')).state).toBe('stopped');
    expect((await backend.inspect('c')).state).toBe('suspended');
  });

  test('create clones the image and applies memory/cpus', async () => {
    fake.responses.set('list --format json', { stdout: '[]', stderr: '' });
    await backend.create({ name: 'new', image: 'base:latest', memoryMb: 8192, cpus: 6 });
    const argLists = fake.calls.map(c => c.args.join(' '));
    expect(argLists).toContain('clone base:latest new');
    expect(argLists).toContain('set new --memory 8192 --cpu 6');
  });

  test('create throws SandboxAlreadyExistsError when VM exists', async () => {
    fake.responses.set('list --format json', {
      stdout: JSON.stringify([{ Name: 'x', State: 'stopped', Source: 'local', Disk: 1, SizeOnDisk: 1, Running: false }]),
      stderr: '',
    });
    await expect(backend.create({ name: 'x', image: 'b:l' })).rejects.toBeInstanceOf(SandboxAlreadyExistsError);
  });

  test('destroy is a no-op on absent VM', async () => {
    fake.responses.set('list --format json', { stdout: '[]', stderr: '' });
    await backend.destroy('missing');
    const argLists = fake.calls.map(c => c.args.join(' '));
    expect(argLists).not.toContain('delete missing');
  });

  test('destroy stops then deletes if running', async () => {
    fake.responses.set('list --format json', {
      stdout: JSON.stringify([{ Name: 'x', State: 'running', Source: 'local', Disk: 1, SizeOnDisk: 1, Running: true }]),
      stderr: '',
    });
    await backend.destroy('x');
    const argLists = fake.calls.map(c => c.args.join(' '));
    expect(argLists).toContain('stop x');
    expect(argLists).toContain('delete x');
  });

  test('suspend rejects when not running', async () => {
    fake.responses.set('list --format json', {
      stdout: JSON.stringify([{ Name: 'x', State: 'stopped', Source: 'local', Disk: 1, SizeOnDisk: 1, Running: false }]),
      stderr: '',
    });
    await expect(backend.suspend('x')).rejects.toThrow(/state is stopped/);
  });

  test('clone requires absent destination', async () => {
    fake.responses.set('list --format json', {
      stdout: JSON.stringify([
        { Name: 'src', State: 'suspended', Source: 'local', Disk: 1, SizeOnDisk: 1, Running: false },
        { Name: 'dst', State: 'stopped', Source: 'local', Disk: 1, SizeOnDisk: 1, Running: false },
      ]),
      stderr: '',
    });
    await expect(backend.clone('src', 'dst')).rejects.toBeInstanceOf(SandboxAlreadyExistsError);
  });
});
