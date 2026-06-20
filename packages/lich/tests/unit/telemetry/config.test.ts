import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isTelemetryEnabled } from "../../../src/telemetry/config.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-tel-cfg-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("isTelemetryEnabled", () => {
  it("defaults to enabled when no opt-out is present", () => {
    expect(isTelemetryEnabled({ env: {}, userConfigPath: join(tmp, "config.json") })).toBe(true);
  });

  it("LICH_TELEMETRY=0 disables", () => {
    expect(isTelemetryEnabled({ env: { LICH_TELEMETRY: "0" }, userConfigPath: join(tmp, "absent") })).toBe(false);
  });

  it("LICH_TELEMETRY=false / off / no all disable", () => {
    for (const v of ["false", "off", "no", "FALSE", "Off", " no "]) {
      expect(isTelemetryEnabled({ env: { LICH_TELEMETRY: v }, userConfigPath: join(tmp, "absent") })).toBe(false);
    }
  });

  it("LICH_TELEMETRY=1 (or anything else) leaves it enabled", () => {
    for (const v of ["1", "true", "yes", "on", "anything"]) {
      expect(isTelemetryEnabled({ env: { LICH_TELEMETRY: v }, userConfigPath: join(tmp, "absent") })).toBe(true);
    }
  });

  it("user config telemetry:false disables", () => {
    const p = join(tmp, "config.json");
    writeFileSync(p, JSON.stringify({ telemetry: false }));
    expect(isTelemetryEnabled({ env: {}, userConfigPath: p })).toBe(false);
  });

  it("user config with telemetry:true keeps it enabled", () => {
    const p = join(tmp, "config.json");
    writeFileSync(p, JSON.stringify({ telemetry: true }));
    expect(isTelemetryEnabled({ env: {}, userConfigPath: p })).toBe(true);
  });

  it("malformed user config is ignored (defaults to enabled)", () => {
    const p = join(tmp, "config.json");
    writeFileSync(p, "{not valid json");
    expect(isTelemetryEnabled({ env: {}, userConfigPath: p })).toBe(true);
  });

  it("lich.yaml runtime.telemetry: false disables", () => {
    expect(isTelemetryEnabled({ env: {}, userConfigPath: join(tmp, "absent"), lichYamlTelemetry: false })).toBe(false);
  });

  it("any single layer disabling is enough (env wins quickly)", () => {
    const p = join(tmp, "config.json");
    writeFileSync(p, JSON.stringify({ telemetry: true }));
    expect(isTelemetryEnabled({ env: { LICH_TELEMETRY: "0" }, userConfigPath: p, lichYamlTelemetry: true })).toBe(false);
  });
});
