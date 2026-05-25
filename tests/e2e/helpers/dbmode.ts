/**
 * Assert the running stack's API reports the expected DB mode.
 *
 * Catches profile drift loudly at setup time. If a test that should
 * run with `dev` somehow gets dispatched against `dev:fast`
 * (default-flip confusion, missing profile arg, env leak), this
 * fails the test's beforeAll with a clear message instead of letting
 * the test silently pass with stub data.
 *
 * Call AFTER lich up has returned and the api has responded to /health.
 * Pair with waitForHttp200(apiUrl + "/health") if needed.
 *
 * Expected modes:
 *   - "live": DATABASE_URL was set, sql client constructed, dev profile.
 *   - "stub": DATABASE_URL was empty, sql is null, dev:fast profile.
 */
export async function expectDbMode(
  apiUrl: string,
  expected: "live" | "stub",
): Promise<void> {
  const r = await fetch(`${apiUrl}/health`);
  if (!r.ok) {
    throw new Error(`/health returned ${r.status}; expected 200`);
  }
  const body = (await r.json()) as { status: string; db: "live" | "stub" };
  if (body.db !== expected) {
    throw new Error(
      `Expected DB mode "${expected}" but /health reports "${body.db}". ` +
        `Active profile may be wrong — did this test forget to pass "dev"?`,
    );
  }
}
