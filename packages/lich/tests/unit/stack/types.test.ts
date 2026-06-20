import { describe, it, expect } from "vitest";
import type { ExecutorRef, DataSourceRef } from "../../../src/stack/types.js";

describe("ExecutorRef discriminated union", () => {
  it("accepts 'local' kind with no extra fields", () => {
    const ref: ExecutorRef = { kind: "local" };
    expect(ref.kind).toBe("local");
  });

  it("accepts 'sandbox-tart' kind with vm_name", () => {
    const ref: ExecutorRef = { kind: "sandbox-tart", vm_name: "lich-run-abc" };
    expect(ref.vm_name).toBe("lich-run-abc");
  });
});

describe("DataSourceRef discriminated union", () => {
  it("accepts 'local' kind with no extra fields", () => {
    const ref: DataSourceRef = { kind: "local" };
    expect(ref.kind).toBe("local");
  });

  it("accepts 'http' kind with base_url and stack_id", () => {
    const ref: DataSourceRef = {
      kind: "http",
      base_url: "http://10.0.0.5:3300",
      stack_id: "workspace-c52ddf65",
    };
    expect(ref.base_url).toBe("http://10.0.0.5:3300");
    expect(ref.stack_id).toBe("workspace-c52ddf65");
  });
});
