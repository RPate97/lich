/**
 * Shared signal-handler registry (LEV-199 / LEV-203).
 *
 * Node's default behavior on SIGINT/SIGTERM is to terminate the process
 * immediately, which means `try/finally` blocks never get a chance to run.
 * That's how the registry-lock bug (LEV-199) leaked: Ctrl-C during a
 * `dev` run skipped the `finally` that deletes `registry.json.lock`, so
 * the next `dev` invocation hung 30s waiting for a phantom holder.
 *
 * Rather than each subsystem reaching for `process.on('SIGINT', ...)` and
 * fighting each other (Node only allows one handler per signal in
 * practice — multiple registrations stack but ordering becomes a footgun),
 * this module owns the signal listeners and exposes a tiny `addCleanup`
 * API. Subsystems register a callback; the module fans the signal out to
 * every callback, then exits with the conventional exit codes (128 +
 * signal number: 130 for SIGINT, 143 for SIGTERM).
 *
 * Design notes:
 *
 * - The process listeners are installed lazily on the FIRST `addCleanup`
 *   call. We don't want library import to add listeners as a side effect
 *   (long-running test runners, embedders that don't want our signal
 *   semantics, etc.).
 *
 * - Installation is idempotent. Repeated `addCleanup` calls don't re-bind
 *   the listeners, and the listener is named so we can detect our own
 *   prior registration if the module is somehow loaded twice (e.g. ESM/CJS
 *   dual loads in test setups).
 *
 * - Cleanups run synchronously where they can (the LEV-199 use case is a
 *   sync `unlinkSync`). We do support promise-returning cleanups for
 *   future LEV-203 / `dev --live` teardown, but we time-bound them: if
 *   any cleanup hasn't completed within `CLEANUP_DEADLINE_MS`, OR if a
 *   second Ctrl-C arrives, we force-exit immediately. This is the "two
 *   Ctrl-C escape" pattern most CLIs implement — users should never feel
 *   stuck.
 *
 * - Each cleanup is wrapped in try/catch independently. One throwing
 *   cleanup must not prevent later cleanups from running.
 */

export type CleanupFn = (signal: NodeJS.Signals) => void | Promise<void>;

const CLEANUP_DEADLINE_MS = 2_000;

let cleanups: CleanupFn[] = [];
let installed = false;
let firing = false;
let forceExitTimer: NodeJS.Timeout | undefined;

// Indirection so tests can override `process.exit` without monkey-patching
// the global. Production code path is unchanged.
let exitFn: (code: number) => never = (code) => process.exit(code);

/**
 * Internal: invoked when SIGINT or SIGTERM arrives. On the first signal we
 * run every registered cleanup, then exit with the conventional code. On a
 * second signal we treat it as "user really wants out" and force-exit
 * immediately without running more cleanups.
 */
// Generation counter — every call to `__resetForTest` bumps this. Any
// in-flight async-cleanup completion paths captured by an earlier fire
// compare their captured generation against the current one; if they
// don't match, the test has reset state out from under us and we MUST
// NOT call `exitFn` (which by then has been swapped back to the real
// `process.exit`). Production code never resets, so this is a no-op
// outside of tests.
let generation = 0;

function onSignal(signal: NodeJS.Signals): void {
  if (firing) {
    // Second Ctrl-C — escape hatch. Skip any remaining work.
    exitFn(signal === 'SIGINT' ? 130 : 143);
    return;
  }
  firing = true;

  const exitCode = signal === 'SIGINT' ? 130 : 143;
  const gen = generation;
  // Capture the current exitFn so a test that swaps it out during fire
  // still drives the path it set up — without a capture, the .then
  // below would observe the post-reset exitFn.
  const capturedExit = exitFn;
  const safeExit = (code: number): void => {
    if (gen !== generation) return; // reset happened — abandon this fire
    capturedExit(code);
  };

  // Hard deadline: if any async cleanup hangs (e.g. waiting on a stuck
  // child process), force-exit after CLEANUP_DEADLINE_MS so the user
  // isn't stranded. The unref() lets the process still exit naturally
  // if every cleanup finishes early.
  forceExitTimer = setTimeout(() => {
    safeExit(exitCode);
  }, CLEANUP_DEADLINE_MS);
  forceExitTimer.unref?.();

  // Snapshot the list — a cleanup that unregisters during the fan-out
  // must not mutate the array we're iterating over.
  const snapshot = cleanups.slice();

  // Kick off every cleanup. Sync cleanups run immediately; promise-
  // returning ones get awaited collectively before we exit. We do NOT
  // bail on the first throw — every cleanup gets its chance.
  const pending: Array<Promise<void>> = [];
  for (const fn of snapshot) {
    try {
      const result = fn(signal);
      if (result && typeof (result as Promise<void>).then === 'function') {
        pending.push(
          (result as Promise<void>).catch(() => {
            /* swallow — cleanups are best-effort */
          }),
        );
      }
    } catch {
      /* swallow — cleanups are best-effort */
    }
  }

  if (pending.length === 0) {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    safeExit(exitCode);
    return;
  }

  Promise.allSettled(pending).then(() => {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    safeExit(exitCode);
  });
}

/**
 * Install the process-level SIGINT/SIGTERM listeners. Idempotent — repeated
 * calls are no-ops. Exported for tests that need to assert install
 * behavior; production code should rely on the implicit install inside
 * `addCleanup`.
 */
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  // Named listener (`onSignal`) means a future code path can detect our
  // own prior registration via `process.listeners('SIGINT').includes(...)`.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

/**
 * Register a cleanup callback to run on SIGINT/SIGTERM. Returns an
 * unregister function so subsystems can detach when their resource is
 * released the happy-path way (e.g. registry-lock unregisters from its
 * `release()`).
 *
 * The cleanup receives the signal name so handlers that care about the
 * distinction (graceful vs. abort) can branch.
 *
 * @example
 *   const undo = addCleanup(() => fs.unlinkSync(lockPath));
 *   // later, when the lock is released cleanly:
 *   undo();
 */
export function addCleanup(fn: CleanupFn): () => void {
  if (!installed) installSignalHandlers();
  cleanups.push(fn);
  return () => {
    cleanups = cleanups.filter((c) => c !== fn);
  };
}

/**
 * Test-only: remove ALL registered cleanups and uninstall the signal
 * listeners. Production code should never call this — it exists so unit
 * tests can isolate state between cases without leaking listeners into
 * the vitest runner's own SIGINT handling.
 *
 * Not exported from the package barrel; tests import from the deep path.
 */
export function __resetForTest(): void {
  cleanups = [];
  firing = false;
  generation++;
  if (forceExitTimer) {
    clearTimeout(forceExitTimer);
    forceExitTimer = undefined;
  }
  if (installed) {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    installed = false;
  }
  exitFn = (code) => process.exit(code);
}

/**
 * Test-only: override the exit function so tests can drive the signal
 * path without actually killing the test runner. Pair with
 * `__fireForTest` to assert that the right exit code would have been
 * delivered.
 */
export function __setExitFnForTest(fn: (code: number) => never): void {
  exitFn = fn;
}

/**
 * Test-only: drive the signal path without actually delivering a real
 * signal to the process. Exposed so tests can assert cleanup-fanout
 * behavior without coupling to `process.kill(process.pid, 'SIGINT')`
 * (which the vitest runner itself intercepts, leading to flaky
 * suites).
 */
export function __fireForTest(signal: NodeJS.Signals): void {
  onSignal(signal);
}
