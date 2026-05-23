/**
 * TestRunnerAdapter — pluggable interface for the test-runner slot.
 *
 * Hypothetical alternative implementations:
 *   - Vitest      (current default for unit/integration; ships in `@lich/plugin-vitest`)
 *   - Playwright  (current default for e2e; ships in `@lich/plugin-playwright`)
 *   - Jest        (long-standing test runner)
 *   - Bun test    (Bun's built-in runner)
 *   - Mocha + Chai (split-runner combo)
 *   - WebDriverIO (e2e against multiple browsers/devices)
 *
 * Consumer-POV: callers want "run my tests in this directory, optionally
 * matching this pattern, with these env vars and timeout, and tell me how
 * many passed/failed". Everything else (config-file discovery, reporters,
 * coverage instrumentation, parallel workers) is impl-internal.
 *
 * `pattern` is intentionally a free-form string — each runner interprets
 * it in its own grammar (Vitest's `--testPathPattern`, Jest's
 * `-t`, Playwright's `--grep`). The contract just says "a string the
 * runner uses to filter which tests run".
 *
 * Result shape uses neutral counters (`passed`/`failed`/`skipped`/`total`)
 * rather than any one runner's reporter output. `raw` is an escape hatch
 * for callers that want the original stdout (e.g. to surface failures).
 */

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
  raw?: string;
}

export interface TestRunInput {
  cwd: string;
  /** Runner-defined filter string (e.g. test-name or path pattern). */
  pattern?: string;
  env?: Record<string, string>;
  watch?: boolean;
  timeoutMs?: number;
}

export interface TestRunnerAdapter {
  name: string;
  run(input: TestRunInput): Promise<TestResult>;
}
