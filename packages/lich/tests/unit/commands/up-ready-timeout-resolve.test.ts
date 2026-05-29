import { describe, expect, it } from "vitest";

import { resolveReadyTimeoutMs } from "../../../src/commands/up.js";

// fallback chain (owned): per-service ready_when.timeout → runtime.ready_when_timeout → 60s
// compose: per-service ready_when.timeout, else null (no runtime fallback by design)
describe("resolveReadyTimeoutMs — fallback chain", () => {
  it("returns parsed per-service ready.timeout when set (owned)", () => {
    const result = resolveReadyTimeoutMs(
      { http_get: "/health", timeout: "5s" },
      true,
      { ready_when_timeout: "180s" },
    );
    expect(result).toBe(5_000);
  });

  it("returns parsed per-service ready.timeout when set (compose)", () => {
    const result = resolveReadyTimeoutMs(
      { http_get: "/health", timeout: "5s" },
      false,
      { ready_when_timeout: "180s" },
    );
    expect(result).toBe(5_000);
  });

  it("accepts a per-service ready.timeout as a raw integer (ms)", () => {
    const result = resolveReadyTimeoutMs(
      { http_get: "/health", timeout: 12_345 },
      true,
      undefined,
    );
    expect(result).toBe(12_345);
  });

  it("falls back to runtime.ready_when_timeout for an owned service without per-service timeout", () => {
    const result = resolveReadyTimeoutMs(
      { http_get: "/health" },
      true,
      { ready_when_timeout: "180s" },
    );
    expect(result).toBe(180_000);
  });

  it("accepts runtime.ready_when_timeout as a raw integer (ms)", () => {
    const result = resolveReadyTimeoutMs(
      { http_get: "/health" },
      true,
      { ready_when_timeout: 30_000 },
    );
    expect(result).toBe(30_000);
  });

  it("does NOT apply runtime.ready_when_timeout to compose services", () => {
    // runtime default is owned-only; compose has its own healthcheck contract
    const result = resolveReadyTimeoutMs(
      { http_get: "/health" },
      false,
      { ready_when_timeout: "180s" },
    );
    expect(result).toBeNull();
  });

  it("falls back to the built-in 60s default for owned with neither timeout set", () => {
    const result = resolveReadyTimeoutMs(
      { http_get: "/health" },
      true,
      undefined,
    );
    expect(result).toBe(60_000);
  });

  it("falls back to the built-in 60s default when runtime is set but ready_when_timeout is unset", () => {
    // runtime block's mere presence doesn't disable the default
    const result = resolveReadyTimeoutMs(
      { http_get: "/health" },
      true,
      { compose_cli: "docker" },
    );
    expect(result).toBe(60_000);
  });

  it("returns null for compose services with no per-service timeout and no runtime default", () => {
    const result = resolveReadyTimeoutMs(
      { http_get: "/health" },
      false,
      undefined,
    );
    expect(result).toBeNull();
  });

  it("throws on a malformed per-service timeout (parseDuration defensive check)", () => {
    // schema rejects at validate-time; resolver re-checks defensively
    expect(() =>
      resolveReadyTimeoutMs(
        { http_get: "/health", timeout: "forever" as unknown as string },
        true,
        undefined,
      ),
    ).toThrow(/invalid duration/i);
  });

  it("throws on a malformed runtime.ready_when_timeout (parseDuration defensive check)", () => {
    expect(() =>
      resolveReadyTimeoutMs(
        { http_get: "/health" },
        true,
        { ready_when_timeout: "5 minutes" as unknown as string },
      ),
    ).toThrow(/invalid duration/i);
  });
});
