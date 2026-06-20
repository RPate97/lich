import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const TESTS_DIR = resolve(__dirname, "../..");

function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (full.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("test-env telemetry guard", () => {
  it("bunfig.toml preload sets process.env.LICH_TELEMETRY to a disabled value", () => {
    const raw = process.env.LICH_TELEMETRY;
    expect(
      raw,
      "LICH_TELEMETRY is unset — bunfig.toml preload may not have run; check packages/lich/bunfig.toml",
    ).toBeDefined();
    const trimmed = (raw ?? "").trim().toLowerCase();
    expect(
      ["0", "false", "off", "no"],
      `LICH_TELEMETRY="${raw}" is not a recognized disable value`,
    ).toContain(trimmed);
  });

  it("every test that spawns the lich binary spreads process.env so the disable propagates", () => {
    // Match any spawn / spawnSync call whose first arg references the lich
    // binary path. The env option must spread process.env or include
    // LICH_TELEMETRY explicitly — otherwise the child runs with whatever the
    // dev shell has, which is exactly the leak we're guarding against.
    const violations: string[] = [];
    for (const file of collectTestFiles(TESTS_DIR)) {
      const src = readFileSync(file, "utf8");
      const spawnCalls = [
        ...src.matchAll(
          /spawn(?:Sync)?\s*\(\s*(?:lichBinary|LICH_BINARY|lichDaemonBinary)\b[\s\S]*?\)/g,
        ),
      ];
      for (const match of spawnCalls) {
        const body = match[0];
        const hasEnvSpread =
          /env\s*:\s*\{\s*\.\.\.process\.env/.test(body) ||
          /env\s*:\s*\{[^}]*LICH_TELEMETRY/.test(body);
        if (!hasEnvSpread) {
          violations.push(
            `${relative(TESTS_DIR, file)}: spawn omits ...process.env and LICH_TELEMETRY — ${body.slice(0, 100)}...`,
          );
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
