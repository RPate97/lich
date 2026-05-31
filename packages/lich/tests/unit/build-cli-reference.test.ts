import { describe, it, expect } from "vitest";
import { renderCliReference } from "../../scripts/build-cli-reference";

describe("renderCliReference", () => {
  const summaries = {
    foo: "Do the foo thing.",
    bar: "Do the bar thing.",
  };
  const longHelp = {
    foo: ["Usage: lich foo", "", "Description."].join("\n"),
    bar: ["Usage: lich bar [opts]", "", "Long bar description."].join("\n"),
  };
  const order = ["foo", "bar"];

  it("emits an auto-generated header", () => {
    const out = renderCliReference(summaries, longHelp, order);
    expect(out).toMatch(/AUTO-GENERATED/);
    expect(out).toMatch(/build-cli-reference\.ts/);
  });

  it("emits one section per command in display order", () => {
    const out = renderCliReference(summaries, longHelp, order);
    const fooIdx = out.indexOf("## `lich foo`");
    const barIdx = out.indexOf("## `lich bar`");
    expect(fooIdx).toBeGreaterThan(-1);
    expect(barIdx).toBeGreaterThan(fooIdx);
  });

  it("includes the summary and long help for each command", () => {
    const out = renderCliReference(summaries, longHelp, order);
    expect(out).toContain("Do the foo thing.");
    expect(out).toContain("Usage: lich foo");
    expect(out).toContain("Long bar description.");
  });

  it("throws if a command is missing help data", () => {
    expect(() =>
      renderCliReference(summaries, longHelp, ["foo", "missing"]),
    ).toThrow(/Missing help data for command: missing/);
  });
});
