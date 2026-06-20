import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLichYamlTelemetry } from "../../../src/telemetry/config.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-tel-yml-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readLichYamlTelemetry", () => {
  it("returns undefined when no lich.yaml exists", () => {
    expect(readLichYamlTelemetry(tmp)).toBeUndefined();
  });

  it("returns undefined when runtime block is absent", () => {
    writeFileSync(join(tmp, "lich.yaml"), `version: "1"\nowned:\n  api:\n    cmd: bun dev\n`);
    expect(readLichYamlTelemetry(tmp)).toBeUndefined();
  });

  it("returns undefined when telemetry key is absent from runtime", () => {
    writeFileSync(join(tmp, "lich.yaml"), `version: "1"\nruntime:\n  proxy_port: 3300\n`);
    expect(readLichYamlTelemetry(tmp)).toBeUndefined();
  });

  it("reads telemetry: false", () => {
    writeFileSync(join(tmp, "lich.yaml"), `version: "1"\nruntime:\n  telemetry: false\n`);
    expect(readLichYamlTelemetry(tmp)).toBe(false);
  });

  it("reads telemetry: true", () => {
    writeFileSync(join(tmp, "lich.yaml"), `version: "1"\nruntime:\n  telemetry: true\n`);
    expect(readLichYamlTelemetry(tmp)).toBe(true);
  });

  it("reads telemetry after sibling runtime keys", () => {
    writeFileSync(
      join(tmp, "lich.yaml"),
      `version: "1"\nruntime:\n  proxy_port: 3300\n  ready_when_timeout: 60s\n  telemetry: false\n`,
    );
    expect(readLichYamlTelemetry(tmp)).toBe(false);
  });
});
