import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StackDataProvider } from "../data-provider.js";
import type { StackView } from "../../daemon/dashboard/stacks-view.js";
import type { StackMetricsSnapshot, PsRow } from "../../daemon/metrics/types.js";
import { loadStacksView, loadStackView } from "../../daemon/dashboard/stacks-view.js";
import {
  buildSingleServiceStream,
  buildMergedStream,
  buildMetricsStream,
  type TailFactory,
  type MetricsSamplerHandle,
} from "../../daemon/dashboard/server.js";
import {
  aggregateSubtree,
  buildTree,
  indexByPid,
  indexByPpid,
  type ProcessNode,
  type ProcTreeNode,
  type ProcTreeResponse,
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

  tailAllLogs(stackId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    const passthrough = new TransformStream<Uint8Array, Uint8Array>();
    (async () => {
      const writer = passthrough.writable.getWriter();
      try {
        const stateFile = join(this.deps.stateRoot, stackId, "state.json");
        let snap: StackSnapshot;
        try {
          const raw = await readFile(stateFile, "utf8");
          snap = JSON.parse(raw) as StackSnapshot;
        } catch {
          await writer.close();
          return;
        }
        const services = snap.services.map((s) => s.name);
        const inner = buildMergedStream({
          stateRoot: this.deps.stateRoot,
          stackId,
          services,
          tailFactory: this.deps.tailFactory,
          clientSignal: signal,
        });
        const reader = inner.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        await writer.close();
      } catch {
        writer.close().catch(() => {});
      }
    })();
    return passthrough.readable;
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

  async procTree(stackId: string, serviceName: string): Promise<ProcTreeResponse | null> {
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
    if (svc.pid === undefined || svc.pid <= 0) {
      return { service: svc.name, pid: 0, process_count: 0, mem_bytes: 0, cpu_pct_cumulative: 0, tree: null };
    }
    const rows = this.deps.psFn ? await this.deps.psFn() : [];
    const byPid = indexByPid(rows);
    const byPpid = indexByPpid(rows);
    const agg = aggregateSubtree(svc.pid, byPid, byPpid);
    const rootNode = buildTree(svc.pid, byPid, byPpid);
    return {
      service: svc.name,
      pid: svc.pid,
      process_count: agg.process_count,
      mem_bytes: agg.mem_bytes,
      cpu_pct_cumulative: round1(agg.cpu_pct_cumulative),
      tree: rootNode ? toWireTree(rootNode) : null,
    };
  }
}

function toWireTree(node: ProcessNode): ProcTreeNode {
  return {
    pid: node.pid,
    ppid: node.ppid,
    rss_bytes: node.rss_kb * 1024,
    cpu_pct_cumulative: round1(node.pcpu),
    children: node.children.map(toWireTree),
  };
}

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}
