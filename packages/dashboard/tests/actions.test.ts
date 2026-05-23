// packages/dashboard/tests/actions.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock node:child_process so we never actually shell out in unit tests.
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { runLichAction } from '../src/server/actions';

const mockedExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.resetAllMocks();
});

/**
 * promisify wraps the raw callback-based execFile. We need the mock to call
 * through the same promisified path, so we simulate the callback interface:
 * the mock implementation receives (file, args, opts, callback) and we invoke
 * the callback synchronously.
 */
function mockSuccess(stdout = '', stderr = '') {
  mockedExecFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout, stderr });
    },
  );
}

function mockFailure(exitCode: number, stdout = '', stderr = 'command failed') {
  mockedExecFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error & { code?: number; stdout?: string; stderr?: string }) => void,
    ) => {
      const err = Object.assign(new Error('command failed'), {
        code: exitCode,
        stdout,
        stderr,
      });
      cb(err);
    },
  );
}

describe('runLichAction', () => {
  it('returns ok:true with captured output on success', async () => {
    mockSuccess('dev started\n', '');
    const result = await runLichAction('/some/worktree', 'restart');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('dev started\n');
    expect(result.stderr).toBe('');
  });

  it('passes the correct cwd and command args', async () => {
    mockSuccess();
    await runLichAction('/my/stack', 'stop');
    expect(mockedExecFile).toHaveBeenCalledWith(
      'bun',
      ['run', 'levelzero', 'stop'],
      expect.objectContaining({ cwd: '/my/stack', timeout: 30_000 }),
      expect.any(Function),
    );
  });

  it('returns ok:false with the exit code on non-zero CLI exit', async () => {
    mockFailure(1, '', 'already stopped');
    const result = await runLichAction('/some/worktree', 'stop');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('already stopped');
  });

  it('returns ok:false with exitCode -1 when spawn itself fails', async () => {
    mockedExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error & { code?: number; stdout?: string; stderr?: string }) => void,
      ) => {
        // Simulate a spawn error (e.g. executable not found) — no numeric code.
        const err = Object.assign(new Error('spawn bun ENOENT'), {
          code: 'ENOENT' as unknown as number,
        });
        cb(err);
      },
    );
    const result = await runLichAction('/some/worktree', 'restart');
    expect(result.ok).toBe(false);
    // code is 'ENOENT' (string) — should fall back to -1
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('ENOENT');
  });

  it('never throws — wraps unexpected errors', async () => {
    mockedExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error) => void,
      ) => {
        cb(new Error('unexpected spawn error'));
      },
    );
    await expect(runLichAction('/some/worktree', 'stop')).resolves.toMatchObject({
      ok: false,
      exitCode: -1,
    });
  });
});
