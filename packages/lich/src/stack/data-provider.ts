import type { StackView } from "../daemon/dashboard/stacks-view.js";
import type { StackMetricsSnapshot } from "../daemon/metrics/types.js";
import type { TreeAggregate } from "../daemon/metrics/proc-tree.js";

export interface StackDataProvider {
  listStacks(): Promise<StackView[]>;
  loadStack(id: string): Promise<StackView | null>;

  /** SSE bytes — interleaved service log lines. */
  tailLogs(stackId: string, serviceName: string, signal: AbortSignal): ReadableStream<Uint8Array>;

  /** Last metrics sample. null when sampler hasn't fired yet (warmup window). */
  metricsLatest(stackId: string): Promise<StackMetricsSnapshot | null>;

  /** SSE bytes — repeated `event: metrics\ndata: <json>\n\n` frames. */
  metricsStream(stackId: string, signal: AbortSignal): ReadableStream<Uint8Array>;

  /** Owned-service process tree (ps subtree on the executing host). null when not applicable (compose service, missing pid). */
  procTree(stackId: string, serviceName: string): Promise<TreeAggregate | null>;
}
