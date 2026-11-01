import { describe, it, expect } from "vitest";
import { formatNotice } from "../../../src/version-check/notice.js";

describe("formatNotice", () => {
  it("names the current + latest versions and the update command", () => {
    expect(formatNotice("0.4.0", "0.6.2")).toBe(
      "lich 0.4.0 is out of date — latest is 0.6.2. Run `lich update` to upgrade.\n",
    );
  });

  it("still produces a single trailing newline", () => {
    const line = formatNotice("1.0.0", "2.0.0");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2);
  });
});
