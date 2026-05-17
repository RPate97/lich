import { describe, it, expect } from 'vitest';
import { formatOutput } from '../src/output';

describe('formatOutput', () => {
  it('emits JSON when format is json', () => {
    expect(formatOutput({ ok: true, n: 1 }, 'json')).toBe('{"ok":true,"n":1}');
  });

  it('emits pretty JSON when format is pretty and value is an object', () => {
    const out = formatOutput({ a: 1 }, 'pretty');
    expect(out).toContain('"a": 1');
    expect(out.includes('\n')).toBe(true);
  });

  it('emits a string as-is when format is pretty and value is a string', () => {
    expect(formatOutput('hello', 'pretty')).toBe('hello');
  });
});
