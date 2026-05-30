import { describe, it, expect } from "vitest";
import { renderYamlReference, walkObjectSchema } from "../../scripts/build-yaml-reference";

describe("walkObjectSchema", () => {
  it("returns empty when schema has no properties", () => {
    expect(walkObjectSchema({ type: "object" })).toEqual([]);
  });

  it("marks required fields correctly", () => {
    const schema = {
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string", description: "first" },
        b: { type: "number", description: "second" },
      },
    };
    const rows = walkObjectSchema(schema);
    expect(rows.find((r) => r.name === "a")?.required).toBe(true);
    expect(rows.find((r) => r.name === "b")?.required).toBe(false);
  });

  it("describes array types as element-type[]", () => {
    const schema = {
      type: "object",
      properties: {
        arr: { type: "array", items: { type: "string" }, description: "an array" },
      },
    };
    expect(walkObjectSchema(schema)[0].type).toBe("string[]");
  });

  it("uses em-dash when description is missing", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "string" } },
    };
    expect(walkObjectSchema(schema)[0].description).toBe("—");
  });
});

describe("renderYamlReference", () => {
  const sections = [
    {
      title: "Top-level",
      anchor: "top-level",
      schema: {
        type: "object",
        required: ["version"],
        properties: {
          version: { type: "string", description: "Schema version." },
        },
      },
    },
  ];

  it("emits header + section heading with anchor", () => {
    const out = renderYamlReference(sections);
    expect(out).toMatch(/AUTO-GENERATED/);
    expect(out).toMatch(/## Top-level \{#top-level\}/);
  });

  it("renders a markdown table row per property", () => {
    const out = renderYamlReference(sections);
    expect(out).toContain("| `version` | `string` | yes | Schema version. |");
  });
});
