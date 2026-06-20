import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const SRC_DIR = resolve(__dirname, "../../../src");
const BIN_PATH = resolve(SRC_DIR, "bin/lich.ts");
const CLIENT_PATH = resolve(SRC_DIR, "telemetry/client.ts");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("telemetry payload contract", () => {
  const ALLOWED_LITERALS = new Set(["help", "custom"]);

  it("captureCommand is invoked from exactly one production file (bin/lich.ts)", () => {
    const callers: Array<{ file: string; count: number }> = [];
    for (const file of collectTsFiles(SRC_DIR)) {
      if (file === CLIENT_PATH) continue;
      const content = readFileSync(file, "utf8");
      const calls = content.match(/\bcaptureCommand\s*\(/g);
      if (calls && calls.length > 0) {
        callers.push({ file: relative(SRC_DIR, file), count: calls.length });
      }
    }
    expect(callers).toEqual([{ file: "bin/lich.ts", count: 1 }]);
  });

  it("every exitWithTelemetry call passes an allowlisted literal or the `commandName` identifier", () => {
    const src = readFileSync(BIN_PATH, "utf8");
    const safeCallRegex =
      /await\s+exitWithTelemetry\(\s*[^,]+,\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*\)/g;
    const calls = [...src.matchAll(safeCallRegex)];
    expect(calls.length, "no exitWithTelemetry calls found").toBeGreaterThan(0);

    const totalInvocations = (src.match(/await\s+exitWithTelemetry\(/g) ?? [])
      .length;
    expect(
      calls.length,
      "some exitWithTelemetry calls don't fit the literal/identifier shape — likely a function call or complex expression was passed as the command argument",
    ).toBe(totalInvocations);

    for (const match of calls) {
      const literal = match[1];
      const variable = match[2];
      if (literal !== undefined) {
        expect(
          ALLOWED_LITERALS,
          `unknown literal command value "${literal}" — add to ALLOWED_LITERALS or revise the call`,
        ).toContain(literal);
      } else {
        expect(
          variable,
          `unexpected variable "${variable}" passed as the command argument; only \`commandName\` is allowed`,
        ).toBe("commandName");
      }
    }
  });

  it("the `commandName` argument is gated by `if (isCommand(commandName))`", () => {
    const src = readFileSync(BIN_PATH, "utf8");
    expect(src).toMatch(/if \(isCommand\(commandName\)\)/);
  });

  it("captureCommand event payload has a fixed property allowlist", () => {
    const ALLOWED_PROPERTIES = new Set([
      "command",
      "exit_code",
      "duration_ms",
      "version",
      "platform",
    ]);
    const src = readFileSync(CLIENT_PATH, "utf8");
    const propsMatch = src.match(/properties:\s*\{([\s\S]*?)\}/);
    expect(
      propsMatch,
      "could not locate the properties object literal in client.ts",
    ).not.toBeNull();

    const body = propsMatch![1];
    const keys = [...body.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]);
    expect(keys.length, "no property keys parsed").toBeGreaterThan(0);
    for (const key of keys) {
      expect(
        ALLOWED_PROPERTIES,
        `unexpected telemetry property "${key}" — add to ALLOWED_PROPERTIES only after a privacy review`,
      ).toContain(key);
    }
  });
});
