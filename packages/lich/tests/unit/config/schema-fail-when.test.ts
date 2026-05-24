/**
 * Schema tests for `fail_when` (Plan 4 Task 7 tightening).
 *
 * Before this task, `fail_when` was accepted as `Record<string, unknown>`
 * — anything went, including typos. This task tightens it to the v1
 * surface: a single optional `log_match` field (string-form regex).
 * `additionalProperties: false` catches typos and not-yet-supported keys
 * at `lich validate` time rather than silently ignoring them at runtime.
 *
 * Future plans may add more fields (`exit_code` is a plausible Plan-4-
 * followup). When they do, the schema, the `FailWhen` type, and these
 * tests must move together. The current strict-schema check is the
 * tripwire: a new field added without test updates will fail these tests.
 *
 * Tests mirror the structure of `schema.test.ts` (same ajv config, same
 * error-introspection pattern).
 */

import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { schema } from "../../../src/config/schema.js";

/** Build a fresh ajv with the same settings as the production validator. */
function makeAjv() {
  return new Ajv({ allErrors: true, strict: false });
}

/** Compile the root schema once per test for hermetic state. */
function compile() {
  return makeAjv().compile(schema);
}

describe("config/schema — fail_when", () => {
  it("accepts fail_when: { log_match: 'EADDRINUSE' }", () => {
    // The canonical happy path — string-form regex on the supported
    // field. The validator should not produce any errors.
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
      // Surface validator errors so a failure here is diagnosable.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(validate.errors, null, 2));
    }
    expect(ok).toBe(true);
  });

  it("accepts fail_when with a complex regex string (alternation, anchors, classes)", () => {
    // Regex strings can be arbitrarily complex — the schema only checks
    // the *type*, not the regex syntax. (Syntactic validation lives in
    // `commands/validate.ts`'s `checkRegexes`, exercised in
    // `validate.test.ts`.)
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
    // Per the schema, `log_match` is optional — an empty `fail_when: {}`
    // is a valid (if pointless) config. This matters because some users
    // may scaffold the block before filling in the pattern.
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
    // `log_match` must be a string (the regex source). Numbers are not
    // accepted even though `RegExp(42)` would technically coerce — the
    // schema is the front line for type discipline.
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
    // The error should reference the log_match path AND say "string".
    expect(
      errors.some(
        (e) =>
          /log_match/.test(e.instancePath) &&
          /string/.test(e.message ?? ""),
      ),
    ).toBe(true);
  });

  it("rejects fail_when: { log_match: true } — wrong type (boolean)", () => {
    // Same as the number case but explicitly proves booleans are also
    // rejected. Defensive against an ajv coerce-friendly settings change.
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
    // The canonical "no-restart-policies, no-liveness-probes" guard.
    // `exit_code` is a plausible Plan-4-followup; until then, it must
    // surface as an unknown-field error at `lich validate`. Otherwise
    // users would silently write configs that lich ignored.
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
    // additionalProperties is the diagnostic — the user typed a key
    // the schema doesn't recognize.
    expect(
      errors.some(
        (e) =>
          /additional/i.test(e.keyword) ||
          /must NOT have additional properties/i.test(e.message ?? ""),
      ),
    ).toBe(true);
  });

  it("rejects fail_when: { log_matc: '...' } — typo", () => {
    // Field-name typos are the most common failure mode of relaxed
    // schemas. `log_matc` is a single dropped character — without
    // strict validation it would silently disable the watcher and the
    // user would never know.
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
    // Defensive: a config with a valid log_match AND an unknown
    // alongside it should still fail validation. additionalProperties
    // is a property of the object, not a per-field check; this proves
    // the constraint fires even when one field is correct.
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
    // The dogfood-stack uses `fail_when: { log_match: "EADDRINUSE|Cannot find module" }`
    // on the api service. The tightening must not break that config —
    // this test is the inline analog of the broader dogfood validation
    // in `schema.test.ts`, narrowed to fail_when so a fail_when-specific
    // regression here is instantly diagnosable.
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
