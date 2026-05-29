import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { schema } from "../../../src/config/schema.js";

function compile() {
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}

describe("config/schema — ready_when.capture", () => {
  it("accepts capture as a string-to-string map", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        tunnel: {
          cmd: "echo hi",
          ready_when: {
            log_match: "Listening on",
            capture: {
              url: "https://[a-z-]+\\.trycloudflare\\.com",
              port: "Listening on port (\\d+)",
            },
          },
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts an empty capture map", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { capture: {} },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects capture: { url: 42 } with a useful error", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { capture: { url: 42 } },
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          (e.instancePath ?? "").includes("/capture/url") &&
          e.keyword === "type",
      ),
    ).toBe(true);
  });

  it("rejects capture: { url: { regex: '...' } } — must be a flat string map", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: {
            capture: { url: { regex: "https://.*" } },
          },
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          (e.instancePath ?? "").includes("/capture/url") &&
          e.keyword === "type",
      ),
    ).toBe(true);
  });

  it("rejects capture: { url: ['regex1', 'regex2'] } — arrays are not strings", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: {
            capture: { url: ["regex1", "regex2"] },
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects capture: { url: null } — null is not a string", () => {
    // YAML `url:` (no value) parses to null
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { capture: { url: null } },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects capture: ['url'] — capture must be an object, not an array", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { capture: ["url"] },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("still accepts the other ready_when fields alongside capture", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: {
            http_get: "/health",
            tcp: "localhost:5432",
            log_match: "ready",
            cmd: "curl -fsS http://localhost/health",
            timeout: "60s",
            capture: { url: "https://.*" },
          },
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });
});
