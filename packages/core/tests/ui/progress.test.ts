/**
 * LEV-217 — progress reporter unit tests.
 *
 * Each test wires the reporter against an in-memory `WriteStream` stub so
 * we can assert on the exact bytes written without touching a real
 * terminal. The stub satisfies the `NodeJS.WriteStream` shape used by the
 * reporter (only `write` and `isTTY` are read) — `as unknown as
 * NodeJS.WriteStream` keeps TypeScript happy without a full mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createProgressReporter, detectProgressMode } from '../../src/ui/progress';
import { __resetForTest } from '../../src/signal-handlers';

interface StubStream {
  chunks: string[];
  isTTY: boolean;
  write(s: string): boolean;
}

function makeStream(opts: { isTTY?: boolean } = {}): StubStream {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY: opts.isTTY ?? false,
    write(s: string) {
      chunks.push(s);
      return true;
    },
  };
}

function asStream(s: StubStream): NodeJS.WriteStream {
  return s as unknown as NodeJS.WriteStream;
}

/**
 * Strip ANSI escape codes so plain-text assertions can match cleanly even
 * when the TTY reporter wrote a colored line.
 */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

beforeEach(() => {
  // The TTY reporter installs a signal-handler cleanup on first spinner
  // start to restore the cursor on Ctrl-C. Reset between tests so each
  // case starts with a clean signal-handlers slate (the TTY tests rely on
  // `shutdown()` unregistering, but the reset is belt-and-suspenders).
  __resetForTest();
});

afterEach(() => {
  __resetForTest();
});

describe('createProgressReporter — silent mode', () => {
  it('produces no output for any step transition', () => {
    const stream = makeStream();
    const r = createProgressReporter({ mode: 'silent', stream: asStream(stream) });
    const s = r.step('doing work');
    s.start();
    s.succeed('done');
    s.fail('bad'); // no-op after succeed in plain/tty; silent ignores everything
    s.update('still working');
    r.shutdown();
    expect(stream.chunks).toEqual([]);
  });

  it('group wraps but emits nothing', async () => {
    const stream = makeStream();
    const r = createProgressReporter({ mode: 'silent', stream: asStream(stream) });
    const result = await r.group('phase', async () => 42);
    expect(result).toBe(42);
    expect(stream.chunks).toEqual([]);
  });
});

describe('createProgressReporter — plain mode', () => {
  it('emits a start line and a success line with elapsed time', async () => {
    const stream = makeStream();
    const r = createProgressReporter({ mode: 'plain', stream: asStream(stream) });
    const s = r.step('booting plugins');
    s.start();
    await new Promise((res) => setTimeout(res, 5));
    s.succeed('5 loaded');
    r.shutdown();

    const joined = stream.chunks.join('');
    expect(joined).toMatch(/> booting plugins\n/);
    expect(joined).toMatch(/ok booting plugins \(\d+\.\d+s\) 5 loaded\n/);
  });

  it('emits a FAIL line with the error message on fail()', () => {
    const stream = makeStream();
    const r = createProgressReporter({ mode: 'plain', stream: asStream(stream) });
    const s = r.step('emit compose');
    s.start();
    s.fail('disk full');
    r.shutdown();

    const joined = stream.chunks.join('');
    expect(joined).toMatch(/> emit compose\n/);
    expect(joined).toMatch(/FAIL emit compose \(\d+\.\d+s\) disk full\n/);
  });

  it('group() emits start + succeed lines on resolution', async () => {
    const stream = makeStream();
    const r = createProgressReporter({ mode: 'plain', stream: asStream(stream) });
    await r.group('bringing up postgres', async () => {
      await new Promise((res) => setTimeout(res, 2));
    });
    r.shutdown();
    const joined = stream.chunks.join('');
    expect(joined).toMatch(/> bringing up postgres\n/);
    expect(joined).toMatch(/ok bringing up postgres/);
  });

  it('group() emits FAIL with error message and rethrows on rejection', async () => {
    const stream = makeStream();
    const r = createProgressReporter({ mode: 'plain', stream: asStream(stream) });
    await expect(
      r.group('bringing up postgres', async () => {
        throw new Error('docker daemon not running');
      }),
    ).rejects.toThrow('docker daemon not running');
    r.shutdown();
    const joined = stream.chunks.join('');
    expect(joined).toMatch(/FAIL bringing up postgres .*docker daemon not running/);
  });

  it('update() re-prints the new label so users see the label change', () => {
    const stream = makeStream();
    const r = createProgressReporter({ mode: 'plain', stream: asStream(stream) });
    const s = r.step('starting service');
    s.start();
    s.update('starting service (probing port)');
    s.succeed();
    r.shutdown();
    const joined = stream.chunks.join('');
    expect(joined).toMatch(/> starting service\n/);
    expect(joined).toMatch(/> starting service \(probing port\)\n/);
    expect(joined).toMatch(/ok starting service \(probing port\)/);
  });

  it('multiple sequential steps interleave cleanly (one line each, no overlap)', () => {
    const stream = makeStream();
    const r = createProgressReporter({ mode: 'plain', stream: asStream(stream) });
    const a = r.step('phase a');
    a.start();
    a.succeed();
    const b = r.step('phase b');
    b.start();
    b.succeed();
    r.shutdown();
    const joined = stream.chunks.join('');
    // Every write is its own newline-terminated line in plain mode — easy
    // to count by counting newlines.
    const lines = joined.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/> phase a$/);
    expect(lines[1]).toMatch(/ok phase a /);
    expect(lines[2]).toMatch(/> phase b$/);
    expect(lines[3]).toMatch(/ok phase b /);
  });
});

describe('createProgressReporter — tty mode', () => {
  it('writes ANSI escape codes (cursor hide, color, clear-line) when active', () => {
    const stream = makeStream({ isTTY: true });
    const r = createProgressReporter({ mode: 'tty', stream: asStream(stream) });
    const s = r.step('working');
    s.start();
    s.succeed();
    r.shutdown();
    const joined = stream.chunks.join('');
    // Cursor hide/show pair must round-trip so the user's shell isn't left
    // with a missing cursor.
    expect(joined).toContain('\x1b[?25l');
    expect(joined).toContain('\x1b[?25h');
    // The success line uses the green-check ANSI prefix.
    expect(joined).toContain('\x1b[32m');
    expect(joined).toContain('✓');
    // Stripping ANSI should leave a recognizable success line.
    expect(strip(joined)).toMatch(/✓ working \(\d+\.\d+s\)/);
  });

  it('failure paints a red ✗ line and clears the spinner', () => {
    const stream = makeStream({ isTTY: true });
    const r = createProgressReporter({ mode: 'tty', stream: asStream(stream) });
    const s = r.step('booting');
    s.start();
    s.fail('boom');
    r.shutdown();
    const joined = stream.chunks.join('');
    expect(joined).toContain('\x1b[31m');
    expect(joined).toContain('✗');
    expect(strip(joined)).toMatch(/✗ booting \(\d+\.\d+s\) boom/);
  });

  it('shutdown() restores the cursor and clears any active spinner', () => {
    const stream = makeStream({ isTTY: true });
    const r = createProgressReporter({ mode: 'tty', stream: asStream(stream) });
    const s = r.step('long task');
    s.start();
    // Caller forgot to resolve the step — shutdown should still clean up.
    r.shutdown();
    const joined = stream.chunks.join('');
    expect(joined).toContain('\x1b[?25l'); // hidden during step
    expect(joined).toContain('\x1b[?25h'); // restored on shutdown
  });
});

describe('detectProgressMode', () => {
  it('returns silent when format=json regardless of TTY', () => {
    expect(
      detectProgressMode({
        format: 'json',
        stream: asStream(makeStream({ isTTY: true })),
        env: {},
      }),
    ).toBe('silent');
  });

  it('returns plain when stream is not a TTY', () => {
    expect(
      detectProgressMode({
        format: 'pretty',
        stream: asStream(makeStream({ isTTY: false })),
        env: {},
      }),
    ).toBe('plain');
  });

  it('returns plain when CI=true', () => {
    expect(
      detectProgressMode({
        format: 'pretty',
        stream: asStream(makeStream({ isTTY: true })),
        env: { CI: 'true' },
      }),
    ).toBe('plain');
  });

  it('returns plain when CI=1', () => {
    expect(
      detectProgressMode({
        format: 'pretty',
        stream: asStream(makeStream({ isTTY: true })),
        env: { CI: '1' },
      }),
    ).toBe('plain');
  });

  it('returns plain when NO_COLOR is set', () => {
    expect(
      detectProgressMode({
        format: 'pretty',
        stream: asStream(makeStream({ isTTY: true })),
        env: { NO_COLOR: '1' },
      }),
    ).toBe('plain');
  });

  it('returns tty when interactive and no CI / NO_COLOR env', () => {
    expect(
      detectProgressMode({
        format: 'pretty',
        stream: asStream(makeStream({ isTTY: true })),
        env: {},
      }),
    ).toBe('tty');
  });
});

describe('integration: progress + dev command silent mode under --json', () => {
  it('uses silent reporter — nothing on stderr from progress', async () => {
    // Direct construction test: when a command uses `ctx.reporter` and the
    // reporter is silent (e.g. because --json was passed), no progress
    // output should reach stderr.
    const stream = makeStream();
    const r = createProgressReporter({ mode: 'silent', stream: asStream(stream) });
    const spy = vi.fn();
    await r.group('phase', async () => {
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(stream.chunks).toEqual([]);
  });
});
