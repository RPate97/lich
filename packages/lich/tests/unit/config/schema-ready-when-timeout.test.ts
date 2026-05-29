import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { schema } from "../../../src/config/schema.js";

function makeAjv() {
  return new Ajv({ allErrors: true, strict: false });
}

function compile() {
  return makeAjv().compile(schema);
}

describe("config/schema — ready_when.timeout", () => {
  it("accepts ready_when.timeout: '30s' (seconds suffix)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "30s" },
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: '2m' (minutes suffix)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "2m" },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: '1h' (hours suffix)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "1h" },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: '500ms' (millisecond suffix)", () => {
    // ms is the only two-char suffix — guards against regex alternation
    // treating m/s as alternates rather than requiring exact `ms`
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "500ms" },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: 500 (raw integer ms)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: 500 },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: 60000 (larger raw integer)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: 60_000 },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when.timeout: '60000' (bare digits as string)", () => {
    // suffix is optional; "60000" === "60000ms" at runtime
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "60000" },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects ready_when.timeout: 'forever' with a useful error", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "forever" },
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some((e) => /timeout/.test(e.instancePath)),
    ).toBe(true);
  });

  it("rejects ready_when.timeout: '5 minutes' (whitespace + word suffix)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "5 minutes" },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: '-1s' (negative)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "-1s" },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: -1 (negative raw integer)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: -1 },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: 0 (zero raw integer)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: 0 },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: 1.5 (fractional raw number)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: 1.5 },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: '30sec' (unknown suffix)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: "30sec" },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: true (wrong type)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: true },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.timeout: { value: 30 } (object form)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health", timeout: { value: 30 } },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("accepts ready_when without a timeout (optional)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { http_get: "/health" },
        },
      },
    });
    expect(ok).toBe(true);
  });
});
