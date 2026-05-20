import { describe, it, expect } from 'vitest';
import { formatError, formatOutput } from '../src/output';
import { CLIError } from '../src/errors';

describe('formatOutput', () => {
  it('emits JSON when format is json', () => {
    expect(formatOutput({ ok: true, n: 1 }, 'json')).toBe('{"ok":true,"n":1}');
  });

  it('emits pretty JSON when format is pretty and value is an object', () => {
    const out = formatOutput({ a: 1 }, 'pretty');
    expect(out).toContain('"a": 1');
    expect(out.includes('\n')).toBe(true);
  });

  it('emits a string as-is (sans trailing newline) when format is pretty and value is a string', () => {
    expect(formatOutput('hello', 'pretty')).toBe('hello');
  });

  it('strips a single trailing newline so the bin caller does not double-newline', () => {
    expect(formatOutput('hello\n', 'pretty')).toBe('hello');
  });
});

// LEV-168 — pretty errors use `error: <msg>` + optional `hint: <text>`; JSON
// preserves the structured shape.
describe('formatError', () => {
  it('emits the prior JSON shape when format is json', () => {
    const err = new CLIError('NO_PROJECT', 'not in project', 'run init');
    expect(formatError(err, 'json')).toBe(
      '{"code":"NO_PROJECT","message":"not in project","hint":"run init"}',
    );
  });

  it('emits `error: <msg>` plus a `hint:` line when format is pretty', () => {
    const err = new CLIError('NO_PROJECT', 'not in project', 'run init');
    expect(formatError(err, 'pretty')).toBe('error: not in project\nhint: run init');
  });

  it('omits the hint line when CLIError has no hint', () => {
    const err = new CLIError('INTERNAL', 'boom');
    expect(formatError(err, 'pretty')).toBe('error: boom');
  });

  // LEV-197 — pretty renderer walks the Node native `Error.cause` chain
  // inline so the user sees the underlying message without having to
  // re-run with `--json`.
  it('renders a single cause inline under the error line', () => {
    const underlying = new Error('ENOENT: no such file or directory');
    const err = new CLIError('INTERNAL', 'gen failed', { cause: underlying });
    const out = formatError(err, 'pretty');
    expect(out).toContain('error: gen failed');
    expect(out).toContain('caused by: Error: ENOENT: no such file or directory');
  });

  it('walks a nested cause chain in pretty mode', () => {
    const root = new Error('root reason');
    const mid = new Error('middle layer');
    (mid as Error & { cause?: unknown }).cause = root;
    const err = new CLIError('INTERNAL', 'top', { cause: mid });
    const out = formatError(err, 'pretty');
    // Both links visible; nested layer indented further than the first.
    expect(out).toContain('caused by: Error: middle layer');
    expect(out).toContain('caused by: Error: root reason');
  });

  it('includes serialized cause chain in JSON output', () => {
    const root = new Error('deep reason');
    const err = new CLIError('INTERNAL', 'top', { cause: root });
    const json = JSON.parse(formatError(err, 'json'));
    expect(json.cause).toBeDefined();
    expect(json.cause.message).toBe('deep reason');
    expect(json.cause.name).toBe('Error');
  });

  it('renders structured details in pretty mode (key: value per line)', () => {
    const err = new CLIError('INTERNAL', 'db migrate failed', {
      details: {
        command: 'prisma migrate deploy',
        exitCode: 1,
        stderr: 'Error: P1001: cannot reach database',
      },
    });
    const out = formatError(err, 'pretty');
    expect(out).toContain('details:');
    expect(out).toContain('command: prisma migrate deploy');
    expect(out).toContain('exitCode: 1');
    expect(out).toContain('stderr: Error: P1001: cannot reach database');
  });

  it('uses a folded block for multi-line string details (stderr)', () => {
    const err = new CLIError('INTERNAL', 'prisma generate failed', {
      details: {
        stderr: 'Error: P1001\n  multi-line\n  trace',
      },
    });
    const out = formatError(err, 'pretty');
    // Folded block: `key: |` header followed by indented lines.
    expect(out).toContain('stderr: |');
    expect(out).toContain('  Error: P1001');
    expect(out).toContain('  multi-line');
  });

  it('truncates very large blobs in pretty mode', () => {
    const stderr = 'x'.repeat(8 * 1024);
    const err = new CLIError('INTERNAL', 'huge fail', {
      details: { stderr },
    });
    const out = formatError(err, 'pretty');
    expect(out.length).toBeLessThan(6 * 1024);
    expect(out).toContain('truncated');
  });

  it('truncates very long stack traces in serialized cause chain', () => {
    const root = new Error('deep reason');
    root.stack = `Error: deep reason\n${'    at frame\n'.repeat(2000)}`;
    const err = new CLIError('INTERNAL', 'top', { cause: root });
    const json = JSON.parse(formatError(err, 'json'));
    expect(json.cause.stack.length).toBeLessThan(5 * 1024);
  });
});
