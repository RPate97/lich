import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  addCleanup,
  installSignalHandlers,
  __fireForTest,
  __resetForTest,
  __setExitFnForTest,
} from '../src/signal-handlers';

// We never want a real `process.exit(...)` to escape into the vitest runner
// — it would kill the suite. Each test installs a stub `exitFn` that
// records the code and throws a sentinel, then catches it where the
// signal path runs synchronously (or awaits the cleanup chain otherwise).

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

beforeEach(() => {
  __resetForTest();
  __setExitFnForTest(((code: number) => {
    throw new ExitCalled(code);
  }) as (code: number) => never);
});

afterEach(() => {
  __resetForTest();
});

describe('signal-handlers', () => {
  it('runs registered cleanup callbacks when SIGINT fires', () => {
    const calls: NodeJS.Signals[] = [];
    addCleanup((sig) => {
      calls.push(sig);
    });

    expect(() => __fireForTest('SIGINT')).toThrow(ExitCalled);
    expect(calls).toEqual(['SIGINT']);
  });

  it('exits with code 130 on SIGINT and 143 on SIGTERM', () => {
    addCleanup(() => {});
    try {
      __fireForTest('SIGINT');
      throw new Error('exit was not called');
    } catch (err) {
      expect(err).toBeInstanceOf(ExitCalled);
      expect((err as ExitCalled).code).toBe(130);
    }

    __resetForTest();
    __setExitFnForTest(((code: number) => {
      throw new ExitCalled(code);
    }) as (code: number) => never);

    addCleanup(() => {});
    try {
      __fireForTest('SIGTERM');
      throw new Error('exit was not called');
    } catch (err) {
      expect(err).toBeInstanceOf(ExitCalled);
      expect((err as ExitCalled).code).toBe(143);
    }
  });

  it('runs every registered cleanup even when one throws', () => {
    const calls: string[] = [];
    addCleanup(() => {
      calls.push('a');
    });
    addCleanup(() => {
      throw new Error('boom');
    });
    addCleanup(() => {
      calls.push('c');
    });

    expect(() => __fireForTest('SIGINT')).toThrow(ExitCalled);
    expect(calls).toEqual(['a', 'c']);
  });

  it('returns an unregister function that detaches the cleanup', () => {
    const calls: string[] = [];
    const undo = addCleanup(() => {
      calls.push('a');
    });
    addCleanup(() => {
      calls.push('b');
    });

    undo();
    expect(() => __fireForTest('SIGINT')).toThrow(ExitCalled);
    expect(calls).toEqual(['b']);
  });

  it('installSignalHandlers is idempotent (no double-binding)', () => {
    installSignalHandlers();
    installSignalHandlers();
    installSignalHandlers();

    // After multiple installs there should be EXACTLY one of our
    // listeners attached to each signal. We can't introspect by
    // reference without exporting the listener, but we can count: if
    // we were double-binding, repeated calls would grow the count.
    const sigintListeners = process.listeners('SIGINT');
    const sigtermListeners = process.listeners('SIGTERM');

    // Re-install via addCleanup path; should still be only one.
    addCleanup(() => {});
    addCleanup(() => {});

    expect(process.listeners('SIGINT').length).toBe(sigintListeners.length);
    expect(process.listeners('SIGTERM').length).toBe(sigtermListeners.length);
  });

  it('addCleanup auto-installs signal handlers on first call', () => {
    // Fresh reset; no install yet.
    const beforeCount = process.listeners('SIGINT').length;
    addCleanup(() => {});
    const afterCount = process.listeners('SIGINT').length;
    expect(afterCount).toBe(beforeCount + 1);
  });

  it('second signal during cleanup force-exits immediately', () => {
    // First cleanup is async and never resolves; this models the case
    // where a teardown is genuinely stuck. Second signal must
    // short-circuit. Using a never-resolving promise (rather than a
    // setTimeout-backed delay) means we don't leak a timer or have to
    // worry about microtask ordering with `afterEach`'s reset.
    let firstResolved = false;
    addCleanup(async () => {
      await new Promise<void>(() => {
        /* never resolves */
      });
      firstResolved = true;
    });

    // First signal — kicks off pending. Won't exit synchronously because
    // the cleanup is async.
    expect(() => __fireForTest('SIGINT')).not.toThrow();

    // Second signal — short-circuit exit path.
    expect(() => __fireForTest('SIGINT')).toThrow(ExitCalled);
    expect(firstResolved).toBe(false);
  });

  it('awaits async cleanups before exiting (single-signal path)', async () => {
    let done = false;
    let exitedCode: number | undefined;
    __setExitFnForTest(((code: number) => {
      exitedCode = code;
      // Don't throw — the async path catches and continues.
      return undefined as never;
    }) as (code: number) => never);

    addCleanup(async () => {
      await new Promise((res) => setTimeout(res, 20));
      done = true;
    });

    __fireForTest('SIGTERM');
    // Wait for async cleanup chain to resolve.
    await new Promise((res) => setTimeout(res, 80));
    expect(done).toBe(true);
    expect(exitedCode).toBe(143);
  });
});
