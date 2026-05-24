/**
 * Schema tests for `ready_when.capture` shape (Plan 4 Task 6).
 *
 * The schema (`src/config/schema.ts`) tightens `capture` to a flat
 * `key -> string` map. Each value MUST be a string (the regex pattern).
 * These tests lock down:
 *
 *   - the happy path (string-to-string map)
 *   - rejection of non-string values (e.g. integers)
 *   - rejection of nested objects (keeps the API a flat map)
 *
 * The runtime regex-compile check is a separate concern handled in
 * `src/ready/capture.ts` (the extractor itself compiles each pattern) and
 * later in `src/config/validate.ts` (Plan 4 Task 13 — surface bad regexes
 * at validate time). The SCHEMA only enforces shape.
 */

import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { schema } from "../../../src/config/schema.js";

function compile() {
  // Mirror parse.ts's ajv configuration so behaviour here matches the
  // real validator that runs at config-load time.
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}

describe("config/schema — ready_when.capture", () => {
  it("accepts capture as a string-to-string map", () => {
    // Happy path: this is exactly what a real user yaml looks like for the
    // canonical tunnel-URL use case.
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
    // Defensive: an empty `capture: {}` is structurally valid. Useful when
    // a user is iterating on their yaml and has temporarily removed all
    // entries — they shouldn't get a schema error for the empty object.
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
    // Common typo / mistake: writing an integer where a regex string is
    // expected. Must surface as a schema error so the user catches it at
    // validate time, not at ready-check time when capture would fail
    // mysteriously.
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
    // The error should point at the offending property's path so the user
    // can find it in their yaml. We don't pin the exact message text (ajv
    // wording varies by version) but the path must include `capture/url`
    // and the keyword should be `type`.
    expect(
      errors.some(
        (e) =>
          (e.instancePath ?? "").includes("/capture/url") &&
          e.keyword === "type",
      ),
    ).toBe(true);
  });

  it("rejects capture: { url: { regex: '...' } } — must be a flat string map", () => {
    // Per the spec note: we deliberately keep the API simple — no nested
    // objects, no `{ regex: ..., flags: ... }` shape. A user wanting more
    // structure declares multiple captures with separate patterns.
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
    // Another shape we explicitly reject: arrays. The single-group
    // convention means one regex per key; multi-regex would require an
    // array, and we don't support it in v1.
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
    // Catches the case where a user starts an entry and forgets to fill
    // it in. YAML `url:` (no value) parses to null, so this is realistic.
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
    // Sanity: capture is a map, not a list. Arrays should fail.
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
    // Regression guard: tightening `capture` must not break the other
    // ready_when fields. Exercise the full shape so a stray
    // `additionalProperties: false` regression would surface here.
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
