import { describe, it, expect } from "vitest";
import { renderInterpolationReference } from "../../scripts/build-interpolation-reference";

describe("renderInterpolationReference", () => {
  const keys = [
    {
      pattern: "worktree.name",
      resolves_to: "Friendly name of the worktree.",
      evaluated: "Immediately.",
    },
    {
      pattern: "services.<name>.host_port",
      resolves_to: "Allocated host port.",
      evaluated: "At up time.",
    },
  ];

  it("emits AUTO-GENERATED header", () => {
    expect(renderInterpolationReference(keys)).toMatch(/AUTO-GENERATED/);
  });

  it("emits a markdown table with one row per key", () => {
    const out = renderInterpolationReference(keys);
    expect(out).toContain("| `${worktree.name}` |");
    expect(out).toContain("| `${services.<name>.host_port}` |");
  });

  it("includes resolves_to and evaluated columns", () => {
    const out = renderInterpolationReference(keys);
    expect(out).toContain("Friendly name of the worktree.");
    expect(out).toContain("At up time.");
  });
});
