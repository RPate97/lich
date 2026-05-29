import { describe, it, expect } from "vitest";
import { pickDefaultProfile } from "../../../src/profiles/default.js";
import type { LichConfig, ProfileDef } from "../../../src/config/types.js";

function configWith(
  profiles: Record<string, ProfileDef> | undefined,
): LichConfig {
  return { version: "1", profiles };
}

describe("pickDefaultProfile (no default selected)", () => {
  it("returns { name: null } when profiles absent", () => {
    expect(pickDefaultProfile(configWith(undefined))).toEqual({ name: null });
  });

  it("returns { name: null } when profiles map is empty", () => {
    expect(pickDefaultProfile(configWith({}))).toEqual({ name: null });
  });

  it("returns { name: null } when no profile sets default", () => {
    expect(
      pickDefaultProfile(
        configWith({
          dev: { owned: ["api"] },
          "dev:test-env": { owned: ["api"], default: false },
        }),
      ),
    ).toEqual({ name: null });
  });
});

describe("pickDefaultProfile (exactly one default)", () => {
  it("returns the name when exactly one default exists", () => {
    expect(
      pickDefaultProfile(
        configWith({
          dev: { owned: ["api"], default: true },
          "dev:test-env": { owned: ["api"] },
        }),
      ),
    ).toEqual({ name: "dev" });
  });

  it("returns the name even when other profiles explicitly set default: false", () => {
    expect(
      pickDefaultProfile(
        configWith({
          dev: { owned: ["api"], default: true },
          "dev:test-env": { owned: ["api"], default: false },
          "dev:with-tunnel": { owned: ["api"], default: false },
        }),
      ),
    ).toEqual({ name: "dev" });
  });

  it("does not include an error field on the single-default success path", () => {
    const result = pickDefaultProfile(
      configWith({ dev: { default: true } }),
    );
    expect(result).toEqual({ name: "dev" });
    expect("error" in result).toBe(false);
  });
});

describe("pickDefaultProfile (multiple defaults)", () => {
  it("returns { name: null, error } when two profiles claim default", () => {
    const result = pickDefaultProfile(
      configWith({
        a: { default: true },
        b: { default: true },
      }),
    );
    expect(result.name).toBeNull();
    expect(result.error).toBe("multiple profiles set default: true: a, b");
  });

  it("lists every defaulting profile in the error (sorted)", () => {
    const result = pickDefaultProfile(
      configWith({
        c: { default: true },
        a: { default: true },
        b: { default: true },
      }),
    );
    expect(result.name).toBeNull();
    expect(result.error).toBe("multiple profiles set default: true: a, b, c");
  });

  it("ignores profiles whose default flag is unset or false when listing offenders", () => {
    const result = pickDefaultProfile(
      configWith({
        a: { default: true },
        b: { default: false },
        c: { default: true },
        d: {},
      }),
    );
    expect(result.name).toBeNull();
    expect(result.error).toBe("multiple profiles set default: true: a, c");
  });
});
