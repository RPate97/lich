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
});
