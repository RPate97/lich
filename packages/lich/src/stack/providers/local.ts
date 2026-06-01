import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StackDataProvider } from "../data-provider.js";
import type { StackView } from "../../daemon/dashboard/stacks-view.js";
import type { StackMetricsSnapshot, PsRow } from "../../daemon/metrics/types.js";
import type { TreeAggregate } from "../../daemon/metrics/proc-tree.js";
import { loadStacksView, loadStackView } from "../../daemon/dashboard/stacks-view.js";
import {
  buildSingleServiceStream,
  buildMetricsStream,
  type TailFactory,
  type MetricsSamplerHandle,
} from "../../daemon/dashboard/server.js";
import {
  aggregateSubtree,
  indexByPid,
  indexByPpid,
} from "../../daemon/metrics/proc-tree.js";
import type { StackSnapshot } from "../../state/snapshot.js";

export interface LocalStackDataProviderDeps {
  stateRoot: string;
  proxyPort: number;
  tailFactory: TailFactory;
  metricsSampler?: MetricsSamplerHandle;
  psFn?: () => Promise<PsRow[]>;
}

export class LocalStackDataProvider implements StackDataProvider {
  constructor(private readonly deps: LocalStackDataProviderDeps) {}

  listStacks(): Promise<StackView[]> {
    return loadStacksView(this.deps.stateRoot, this.deps.proxyPort);
  }

  loadStack(id: string): Promise<StackView | null> {
    return loadStackView(this.deps.stateRoot, id, this.deps.proxyPort);
  }

  tailLogs(stackId: string, serviceName: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    return buildSingleServiceStream({
      stateRoot: this.deps.stateRoot,
      stackId,
      service: serviceName,
      tailFactory: this.deps.tailFactory,
      clientSignal: signal,
    });
  }

  async metricsLatest(stackId: string): Promise<StackMetricsSnapshot | null> {
    return this.deps.metricsSampler?.latest(stackId) ?? null;
  }

  metricsStream(stackId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    if (!this.deps.metricsSampler) {
      return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    }
    return buildMetricsStream({
      sampler: this.deps.metricsSampler,
      stackId,
      clientSignal: signal,
    });
  }

  async procTree(stackId: string, serviceName: string): Promise<TreeAggregate | null> {
    const stateFile = join(this.deps.stateRoot, stackId, "state.json");
    let raw: string;
    try {
      raw = await readFile(stateFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
    let snap: StackSnapshot;
    try {
      snap = JSON.parse(raw) as StackSnapshot;
    } catch {
      return null;
    }
    const svc = snap.services.find((s) => s.name === serviceName);
    if (!svc || svc.kind !== "owned") return null;
    if (svc.pid === undefined || svc.pid <= 0) return null;
    const rows = this.deps.psFn ? await this.deps.psFn() : [];
    const byPid = indexByPid(rows);
    const byPpid = indexByPpid(rows);
    return aggregateSubtree(svc.pid, byPid, byPpid);
  }
}
