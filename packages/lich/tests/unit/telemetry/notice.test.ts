import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maybeShowFirstRunNotice } from "../../../src/telemetry/notice.js";

class StringStream {
  data = "";
  write(chunk: string | Uint8Array): boolean {
    this.data += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-tel-notice-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("maybeShowFirstRunNotice", () => {
  it("prints the notice and creates the flag on first run", () => {
    const out = new StringStream();
    const flagPath = join(tmp, "seen-telemetry-notice");
    maybeShowFirstRunNotice({ out: out as unknown as NodeJS.WritableStream, flagPath });
    expect(out.data).toContain("anonymous CLI usage telemetry");
    expect(out.data).toContain("LICH_TELEMETRY=0");
    expect(existsSync(flagPath)).toBe(true);
  });

  it("does not print on subsequent runs once the flag exists", () => {
    const flagPath = join(tmp, "seen-telemetry-notice");
    writeFileSync(flagPath, "2026-06-05T00:00:00.000Z");
    const out = new StringStream();
    maybeShowFirstRunNotice({ out: out as unknown as NodeJS.WritableStream, flagPath });
    expect(out.data).toBe("");
  });

  it("swallows I/O errors silently", () => {
    const out = new StringStream();
    expect(() =>
      maybeShowFirstRunNotice({
        out: out as unknown as NodeJS.WritableStream,
        flagPath: "/no/such/dir/seen-telemetry-notice",
      }),
    ).not.toThrow();
  });
});
