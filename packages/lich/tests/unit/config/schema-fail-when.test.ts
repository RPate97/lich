import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { schema } from "../../../src/config/schema.js";

function makeAjv() {
  return new Ajv({ allErrors: true, strict: false });
}

function compile() {
  return makeAjv().compile(schema);
}

describe("config/schema — fail_when", () => {
  it("accepts fail_when: { log_match: 'EADDRINUSE' }", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          fail_when: { log_match: "EADDRINUSE" },
        },
      },
    });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts fail_when with a complex regex string (alternation, anchors, classes)", () => {
    // schema checks type only; regex syntax lives in commands/validate.ts
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          fail_when: {
            log_match: "^FATAL: .*(EADDRINUSE|Cannot find module).*$",
          },
        },
      },
    });
    expect(ok).toBe(true);
  });

  it("accepts an empty fail_when block (all fields optional)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: { cmd: "bun run dev", fail_when: {} },
      },
    });
    expect(ok).toBe(true);
  });

  it("rejects fail_when: { log_match: 42 } — wrong type", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          fail_when: { log_match: 42 },
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          /log_match/.test(e.instancePath) &&
          /string/.test(e.message ?? ""),
      ),
    ).toBe(true);
  });

  it("rejects fail_when: { log_match: true } — wrong type (boolean)", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          fail_when: { log_match: true },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("rejects fail_when: { exit_code: 1 } — unknown field", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          fail_when: { exit_code: 1 },
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          /additional/i.test(e.keyword) ||
          /must NOT have additional properties/i.test(e.message ?? ""),
      ),
    ).toBe(true);
  });

  it("rejects fail_when: { log_matc: '...' } — typo", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          fail_when: { log_matc: "EADDRINUSE" },
        },
      },
    });
    expect(ok).toBe(false);
    const errors = validate.errors ?? [];
    expect(
      errors.some(
        (e) =>
          /additional/i.test(e.keyword) ||
          /must NOT have additional properties/i.test(e.message ?? ""),
      ),
    ).toBe(true);
  });

  it("rejects fail_when: { log_match, unknown_field } — log_match valid but extra key", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          fail_when: {
            log_match: "EADDRINUSE",
            on_match: "restart",
          },
        },
      },
    });
    expect(ok).toBe(false);
  });

  it("still validates the dogfood-stack-shaped fail_when usage", () => {
    const validate = compile();
    const ok = validate({
      version: "1",
      owned: {
        api: {
          cmd: "bun run dev",
          fail_when: { log_match: "EADDRINUSE|Cannot find module" },
        },
      },
    });
    expect(ok).toBe(true);
  });
});
