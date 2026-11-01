import { describe, it, expect } from "vitest";
import { shouldSuppressNotice } from "../../../src/version-check/suppress.js";

describe("shouldSuppressNotice", () => {
  it("fires on a normal run (not suppressed)", () => {
    expect(
      shouldSuppressNotice({
        argv: { _: [], json: false, quiet: false, version: false },
        env: {},
        commandName: "up",
      }),
    ).toBe(false);
  });

  it("suppresses when LICH_NO_UPDATE_CHECK is truthy", () => {
    for (const v of ["1", "true", "yes", "on"]) {
      expect(
        shouldSuppressNotice({
          argv: { _: [], json: false, quiet: false, version: false },
          env: { LICH_NO_UPDATE_CHECK: v },
          commandName: "up",
        }),
      ).toBe(true);
    }
  });

  it("ignores LICH_NO_UPDATE_CHECK=0 / unset", () => {
    expect(
      shouldSuppressNotice({
        argv: { _: [], json: false, quiet: false, version: false },
        env: { LICH_NO_UPDATE_CHECK: "0" },
        commandName: "up",
      }),
    ).toBe(false);
  });

  it("suppresses --json (would contaminate stderr for jq pipelines)", () => {
    expect(
      shouldSuppressNotice({
        argv: { _: [], json: true, quiet: false, version: false },
        env: {},
        commandName: "stacks",
      }),
    ).toBe(true);
  });

  it("suppresses --quiet", () => {
    expect(
      shouldSuppressNotice({
        argv: { _: [], json: false, quiet: true, version: false },
        env: {},
        commandName: "up",
      }),
    ).toBe(true);
  });

  it("suppresses the update command itself (would be noise)", () => {
    expect(
      shouldSuppressNotice({
        argv: { _: [], json: false, quiet: false, version: false },
        env: {},
        commandName: "update",
      }),
    ).toBe(true);
  });

  it("suppresses --version", () => {
    expect(
      shouldSuppressNotice({
        argv: { _: [], json: false, quiet: false, version: true },
        env: {},
        commandName: undefined,
      }),
    ).toBe(true);
  });

  it("suppresses the hidden refresh subcommand", () => {
    expect(
      shouldSuppressNotice({
        argv: { _: [], json: false, quiet: false, version: false },
        env: {},
        commandName: "__update-check-refresh",
      }),
    ).toBe(true);
  });
});
