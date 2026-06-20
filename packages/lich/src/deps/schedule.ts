/**
 * Pure graph scheduler. Each node starts the moment its own dependencies are
 * ready — no topological wave barriers. Independent chains progress
 * concurrently at their own pace. Caller validates acyclicity first
 * (precondition: `graph` is a DAG); no cycle detection here.
 */

import type { Graph } from "./graph.js";

export type NodeOutcome = "ready" | "failed" | "skipped";

export interface RunGraphInput {
  graph: Graph;
  /** Start one node to ready. `signal` aborts when the run is being torn down
   *  (external cancel, or — when abortOnFailure — a sibling's failure). Rejects on failure. */
  runNode: (name: string, signal: AbortSignal) => Promise<void>;
  /** When true, the FIRST real node failure tears down the run: not-yet-started nodes
   *  become "skipped" and in-flight nodes' signals abort. */
  abortOnFailure: boolean;
  /** Fires at most once, on the first real failure when abortOnFailure is set, BEFORE
   *  remaining nodes settle. The caller uses it to cascade-kill in-flight work. */
  onFirstFailure?: (name: string) => void | Promise<void>;
  /** External cancellation (SIGINT). */
  signal?: AbortSignal;
}

export interface RunGraphResult {
  outcomes: Map<string, NodeOutcome>;
  failures: Array<{ name: string; error: unknown }>;
}

/** A dependency was failed or skipped; dependents reject their gate with this. */
class GateSkip extends Error {
  constructor() {
    super("dependency not ready");
    this.name = "GateSkip";
  }
}

export async function runGraph(input: RunGraphInput): Promise<RunGraphResult> {
  const { graph, runNode, abortOnFailure, onFirstFailure, signal } = input;

  const outcomes = new Map<string, NodeOutcome>();
  const failures: Array<{ name: string; error: unknown }> = [];

  // The signal handed to every runNode. It aborts when the external signal does,
  // or — under abortOnFailure — when the first real failure trips the latch.
  // Aborting cancels in-flight runNode calls and short-circuits not-yet-started
  // nodes to "skipped".
  const combined = new AbortController();
  const forward = () => combined.abort();
  if (signal) {
    if (signal.aborted) combined.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }

  let firstFailureHandled = false;
  let onFirstFailureDone: Promise<void> | undefined;
  const handleFirstFailure = (name: string): void => {
    if (firstFailureHandled) return;
    firstFailureHandled = true;
    combined.abort();
    // Best-effort teardown hook — its failure must not reject runGraph.
    onFirstFailureDone = Promise.resolve(onFirstFailure?.(name)).catch(() => {});
  };

  // One ready-promise per node, created up front so dependents can await deps
  // before those deps have begun running.
  const ready = new Map<string, Promise<void>>();
  for (const name of graph.nodes.keys()) {
    ready.set(name, runOne(name));
  }

  await Promise.allSettled(ready.values());
  await onFirstFailureDone;

  if (signal) signal.removeEventListener("abort", forward);

  return { outcomes, failures };

  async function runOne(name: string): Promise<void> {
    const deps = graph.edges.get(name) ?? new Set<string>();

    try {
      await Promise.all([...deps].map((d) => ready.get(d)));
    } catch {
      // A dependency failed or was skipped → this node is skipped, and its own
      // ready-promise must reject so ITS dependents skip too.
      outcomes.set(name, "skipped");
      throw new GateSkip();
    }

    if (combined.signal.aborted) {
      outcomes.set(name, "skipped");
      throw new GateSkip();
    }

    try {
      await runNode(name, combined.signal);
      outcomes.set(name, "ready");
    } catch (error) {
      outcomes.set(name, "failed");
      failures.push({ name, error });
      if (abortOnFailure) handleFirstFailure(name);
      throw error;
    }
  }
}
