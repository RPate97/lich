import { describe, it, expect } from "vitest";
import { buildGraph, type NodeDecl } from "../../../src/deps/graph.js";
import { runGraph, type RunGraphInput } from "../../../src/deps/schedule.js";

function g(decls: NodeDecl[]) {
  return buildGraph(decls);
}

function c(name: string, depends_on: string[] = []): NodeDecl {
  return { name, kind: "compose", depends_on };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield enough microtask turns for pending gates/`Promise.all` chains to settle. */
async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/**
 * A controllable fake `runNode`: records start order + per-node signals, and
 * exposes a deferred per node so the test drives when each settles.
 */
function controllable() {
  const started: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const gates = new Map<string, Deferred>();

  const gate = (name: string): Deferred => {
    let d = gates.get(name);
    if (!d) {
      d = deferred();
      gates.set(name, d);
    }
    return d;
  };

  const runNode: RunGraphInput["runNode"] = (name, signal) => {
    started.push(name);
    signals.set(name, signal);
    return gate(name).promise;
  };

  return {
    runNode,
    started,
    signals,
    resolveNode: (name: string) => gate(name).resolve(),
    rejectNode: (name: string, err: unknown = new Error(name)) =>
      gate(name).reject(err),
  };
}

describe("deps/schedule: runGraph", () => {
  it("runs independent chains concurrently (chain B starts before chain A's slow node finishes)", async () => {
    // a1 -> a2 (a1 slow) ; b1 -> b2 (instant)
    const graph = g([
      c("a1"),
      c("a2", ["a1"]),
      c("b1"),
      c("b2", ["b1"]),
    ]);
    const fake = controllable();

    const run = runGraph({ graph, runNode: fake.runNode, abortOnFailure: true });

    // a1 and b1 (both roots) start immediately; a1 is left hanging.
    await flush();
    expect(fake.started).toContain("a1");
    expect(fake.started).toContain("b1");

    // Drive chain B to completion while a1 is still in flight.
    fake.resolveNode("b1");
    await flush();
    expect(fake.started).toContain("b2");
    fake.resolveNode("b2");
    await flush();

    // b2 reached runNode (chain B progressed) before a1 ever resolved.
    expect(fake.started).not.toContain("a2");

    // Now let chain A finish so the run can settle.
    fake.resolveNode("a1");
    await flush();
    fake.resolveNode("a2");

    const res = await run;
    expect(res.outcomes.get("b2")).toBe("ready");
    expect(res.outcomes.get("a2")).toBe("ready");
  });

  it("waits for ALL declared deps and no others before running a node", async () => {
    // d depends on a, b, c ; e is unrelated.
    const graph = g([
      c("a"),
      c("b"),
      c("cc"),
      c("d", ["a", "b", "cc"]),
      c("e"),
    ]);
    const fake = controllable();

    const run = runGraph({ graph, runNode: fake.runNode, abortOnFailure: false });

    await flush();
    // Roots a, b, cc, e start; d does not (deps unmet).
    expect(fake.started.sort()).toEqual(["a", "b", "cc", "e"]);

    // Resolve two of three deps — d must still not start.
    fake.resolveNode("a");
    fake.resolveNode("b");
    await flush();
    expect(fake.started).not.toContain("d");

    // Resolve the last dep — now d starts; unrelated e never gated it.
    fake.resolveNode("cc");
    await flush();
    expect(fake.started).toContain("d");

    fake.resolveNode("d");
    fake.resolveNode("e");
    const res = await run;
    expect(res.outcomes.get("d")).toBe("ready");
  });

  it("dependency failure → dependent is skipped and never run; failed node reported", async () => {
    // a -> b -> c ; a fails. b and c must skip; runNode never called for them.
    const graph = g([c("a"), c("b", ["a"]), c("cc", ["b"])]);
    const fake = controllable();

    const run = runGraph({
      graph,
      runNode: fake.runNode,
      abortOnFailure: false,
    });

    await flush();
    expect(fake.started).toEqual(["a"]);

    const err = new Error("boom-a");
    fake.rejectNode("a", err);

    const res = await run;
    expect(res.outcomes.get("a")).toBe("failed");
    expect(res.outcomes.get("b")).toBe("skipped");
    expect(res.outcomes.get("cc")).toBe("skipped");
    expect(fake.started).toEqual(["a"]); // b, cc never invoked
    expect(res.failures).toEqual([{ name: "a", error: err }]);
  });

  it("abortOnFailure:true → onFirstFailure fires once, in-flight signal aborts, not-yet-started skip", async () => {
    // Two roots: bad (fails) and slow (in flight). slow -> slowleaf (not started).
    // pending depends on a not-yet-resolved root `hold` so it sits at its gate.
    const graph = g([
      c("bad"),
      c("slow"),
      c("slowleaf", ["slow"]),
      c("hold"),
      c("pending", ["hold"]),
    ]);
    const fake = controllable();

    const firstFailures: string[] = [];
    const run = runGraph({
      graph,
      runNode: fake.runNode,
      abortOnFailure: true,
      onFirstFailure: (name) => {
        firstFailures.push(name);
      },
    });

    await flush();
    // Roots start; dependents wait.
    expect(fake.started.sort()).toEqual(["bad", "hold", "slow"]);
    const slowSignal = fake.signals.get("slow")!;
    expect(slowSignal.aborted).toBe(false);

    // bad fails first → trips the latch.
    fake.rejectNode("bad");
    await flush();

    // onFirstFailure fired exactly once for the failing node.
    expect(firstFailures).toEqual(["bad"]);
    // In-flight node's signal aborted (caller would cascade-kill on this).
    expect(slowSignal.aborted).toBe(true);

    // The in-flight node observes the abort and rejects in response.
    fake.rejectNode("slow", new Error("aborted"));
    // Resolve `hold` so `pending`'s gate clears AFTER the latch tripped.
    fake.resolveNode("hold");

    const res = await run;
    // slowleaf never started (its dep slow failed) → skipped.
    expect(res.outcomes.get("slowleaf")).toBe("skipped");
    // pending's gate cleared post-abort → skipped, runNode never called.
    expect(res.outcomes.get("pending")).toBe("skipped");
    expect(fake.started).not.toContain("pending");
    expect(fake.started).not.toContain("slowleaf");
    // Only one onFirstFailure despite two genuine failures.
    expect(firstFailures).toEqual(["bad"]);
  });

  it("abortOnFailure:false → all in-flight settle, dependents-of-failed skip, every failure reported, onFirstFailure never called", async () => {
    // bad fails; indep is an unrelated in-flight root that must settle naturally.
    // bad2 is a second independent failure. dep depends on bad → skipped.
    const graph = g([
      c("bad"),
      c("dep", ["bad"]),
      c("bad2"),
      c("indep"),
    ]);
    const fake = controllable();
    let onFirstCalls = 0;

    const run = runGraph({
      graph,
      runNode: fake.runNode,
      abortOnFailure: false,
      onFirstFailure: () => {
        onFirstCalls++;
      },
    });

    await flush();
    expect(fake.started.sort()).toEqual(["bad", "bad2", "indep"]);
    const indepSignal = fake.signals.get("indep")!;

    const e1 = new Error("bad");
    const e2 = new Error("bad2");
    fake.rejectNode("bad", e1);
    fake.rejectNode("bad2", e2);
    await flush();

    // No latch in this mode → in-flight signal stays live; node settles on its own.
    expect(indepSignal.aborted).toBe(false);
    fake.resolveNode("indep");

    const res = await run;
    expect(onFirstCalls).toBe(0);
    expect(res.outcomes.get("bad")).toBe("failed");
    expect(res.outcomes.get("bad2")).toBe("failed");
    expect(res.outcomes.get("indep")).toBe("ready");
    expect(res.outcomes.get("dep")).toBe("skipped");
    // Both genuine failures reported.
    const failed = res.failures.map((f) => f.name).sort();
    expect(failed).toEqual(["bad", "bad2"]);
    expect(res.failures.find((f) => f.name === "bad")?.error).toBe(e1);
    expect(res.failures.find((f) => f.name === "bad2")?.error).toBe(e2);
  });

  it("external signal already aborted → no node runs; all become skipped", async () => {
    const graph = g([c("a"), c("b", ["a"]), c("solo")]);
    const fake = controllable();

    const ac = new AbortController();
    ac.abort();

    const res = await runGraph({
      graph,
      runNode: fake.runNode,
      abortOnFailure: true,
      signal: ac.signal,
    });

    expect(fake.started).toEqual([]);
    expect(res.outcomes.get("a")).toBe("skipped");
    expect(res.outcomes.get("b")).toBe("skipped");
    expect(res.outcomes.get("solo")).toBe("skipped");
    expect(res.failures).toEqual([]);
  });

  it("external signal aborts mid-run → not-yet-started nodes are skipped", async () => {
    // a in flight; b depends on a (not started). Abort mid-run before a resolves.
    const graph = g([c("a"), c("b", ["a"]), c("solo")]);
    const fake = controllable();
    const ac = new AbortController();

    const run = runGraph({
      graph,
      runNode: fake.runNode,
      abortOnFailure: false,
      signal: ac.signal,
    });

    await flush();
    expect(fake.started.sort()).toEqual(["a", "solo"]);
    const aSignal = fake.signals.get("a")!;

    ac.abort();
    expect(aSignal.aborted).toBe(true);

    // In-flight nodes settle (resolve naturally here); a's success clears b's gate
    // AFTER the abort, so b skips.
    fake.resolveNode("a");
    fake.resolveNode("solo");

    const res = await run;
    expect(res.outcomes.get("a")).toBe("ready");
    expect(res.outcomes.get("solo")).toBe("ready");
    expect(res.outcomes.get("b")).toBe("skipped");
    expect(fake.started).not.toContain("b");
  });

  it("all-success DAG → every node ready, no failures, outcomes covers all nodes", async () => {
    // diamond: a -> {b, cc} -> d
    const graph = g([
      c("a"),
      c("b", ["a"]),
      c("cc", ["a"]),
      c("d", ["b", "cc"]),
    ]);
    const fake = controllable();

    const run = runGraph({ graph, runNode: fake.runNode, abortOnFailure: true });

    await flush();
    fake.resolveNode("a");
    await flush();
    fake.resolveNode("b");
    fake.resolveNode("cc");
    await flush();
    fake.resolveNode("d");

    const res = await run;
    expect([...res.outcomes.keys()].sort()).toEqual(["a", "b", "cc", "d"]);
    for (const name of ["a", "b", "cc", "d"]) {
      expect(res.outcomes.get(name)).toBe("ready");
    }
    expect(res.failures).toEqual([]);
  });

  it("empty graph → resolves immediately with empty outcomes and failures", async () => {
    const fake = controllable();
    const res = await runGraph({
      graph: g([]),
      runNode: fake.runNode,
      abortOnFailure: true,
    });
    expect(res.outcomes.size).toBe(0);
    expect(res.failures).toEqual([]);
    expect(fake.started).toEqual([]);
  });
});
