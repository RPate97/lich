import { describe, it, expect } from "vitest";
import type { StackDataProvider } from "../../../src/stack/data-provider.js";
import type { StackView } from "../../../src/daemon/dashboard/stacks-view.js";
import type { StackMetricsSnapshot } from "../../../src/daemon/metrics/types.js";
import type { TreeAggregate } from "../../../src/daemon/metrics/proc-tree.js";

describe("StackDataProvider interface", () => {
  it("declares listStacks/loadStack/tailLogs/metricsLatest/metricsStream/procTree", () => {
    const fake: StackDataProvider = {
      async listStacks(): Promise<StackView[]> { return []; },
      async loadStack(_id: string): Promise<StackView | null> { return null; },
      tailLogs(_stackId: string, _serviceName: string, _signal: AbortSignal): ReadableStream<Uint8Array> {
        return new ReadableStream();
      },
      async metricsLatest(_stackId: string): Promise<StackMetricsSnapshot | null> { return null; },
      metricsStream(_stackId: string, _signal: AbortSignal): ReadableStream<Uint8Array> {
        return new ReadableStream();
      },
      async procTree(_stackId: string, _serviceName: string): Promise<TreeAggregate | null> { return null; },
    };
    expect(typeof fake.listStacks).toBe("function");
    expect(typeof fake.loadStack).toBe("function");
    expect(typeof fake.tailLogs).toBe("function");
    expect(typeof fake.metricsLatest).toBe("function");
    expect(typeof fake.metricsStream).toBe("function");
    expect(typeof fake.procTree).toBe("function");
  });
});
