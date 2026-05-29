/**
 * Assert the stack's /health reports the expected DB mode ("live" = dev,
 * "stub" = dev:fast). Catches profile drift at setup time. Call after the api
 * responds to /health.
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
