import type { StackView } from "../../daemon/dashboard/stacks-view.js";
import type { StackMetricsSnapshot } from "../../daemon/metrics/types.js";
import type { ProcTreeResponse } from "../../daemon/metrics/proc-tree.js";
import type { StackDataProvider } from "../data-provider.js";

export class HttpStackDataProvider implements StackDataProvider {
  constructor(private readonly baseUrl: string, private readonly remoteStackId: string) {}

  async listStacks(): Promise<StackView[]> {
    const res = await fetch(`${this.baseUrl}/api/stacks`);
    if (!res.ok) return [];
    return res.json() as Promise<StackView[]>;
  }

  async loadStack(_id: string): Promise<StackView | null> {
    const res = await fetch(`${this.baseUrl}/api/stacks/${this.remoteStackId}`);
    if (!res.ok) return null;
    return res.json() as Promise<StackView>;
  }

  tailLogs(_stackId: string, serviceName: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    return this.passThroughSse(`/api/stacks/${this.remoteStackId}/logs?service=${encodeURIComponent(serviceName)}`, signal);
  }

  tailAllLogs(_stackId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    return this.passThroughSse(`/api/stacks/${this.remoteStackId}/logs`, signal);
  }

  async metricsLatest(_stackId: string): Promise<StackMetricsSnapshot | null> {
    const res = await fetch(`${this.baseUrl}/api/stacks/${this.remoteStackId}/metrics`);
    if (!res.ok) return null;
    return res.json() as Promise<StackMetricsSnapshot>;
  }

  metricsStream(_stackId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    return this.passThroughSse(`/api/stacks/${this.remoteStackId}/metrics/stream`, signal);
  }

  async procTree(_stackId: string, serviceName: string): Promise<ProcTreeResponse | null> {
    const res = await fetch(`${this.baseUrl}/api/stacks/${this.remoteStackId}/services/${encodeURIComponent(serviceName)}/proc-tree`);
    if (!res.ok) return null;
    return res.json() as Promise<ProcTreeResponse>;
  }

  private passThroughSse(pathAndQuery: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    const passthrough = new TransformStream<Uint8Array, Uint8Array>();
    let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    (async () => {
      try {
        const res = await fetch(`${this.baseUrl}${pathAndQuery}`, { signal });
        if (!res.body) { passthrough.writable.close().catch(() => {}); return; }
        const reader = res.body.getReader();
        writer = passthrough.writable.getWriter();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        await writer.close();
      } catch {
        if (writer !== null) {
          writer.close().catch(() => {});
        } else {
          passthrough.writable.close().catch(() => {});
        }
      }
    })();
    return passthrough.readable;
  }
}
