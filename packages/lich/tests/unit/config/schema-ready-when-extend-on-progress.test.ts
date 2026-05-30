import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { schema } from "../../../src/config/schema.js";

function compile() {
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}

describe("config/schema — ready_when.extend_on_progress", () => {
  it("accepts ready_when.extend_on_progress: true", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: {
            log_match: "ready",
            timeout: "30s",
            extend_on_progress: true,
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

  it("accepts ready_when.extend_on_progress: false (explicit default)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: {
            log_match: "ready",
            timeout: "30s",
            extend_on_progress: false,
          },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts ready_when without extend_on_progress (optional, default off)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: { log_match: "ready", timeout: "30s" },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects ready_when.extend_on_progress: 'yes' (wrong type — string)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: {
            log_match: "ready",
            timeout: "30s",
            extend_on_progress: "yes",
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects ready_when.extend_on_progress: 1 (wrong type — number)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          ready_when: {
            log_match: "ready",
            timeout: "30s",
            extend_on_progress: 1,
          },
        },
      },
    });
    expect(ok).toBe(false);
  });
});
