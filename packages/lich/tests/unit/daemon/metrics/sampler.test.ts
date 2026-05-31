import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MetricsSampler,
  deriveCpuInstant,
  type MetricsProbe,
} from "../../../../src/daemon/metrics/sampler.js";
import type { StackSnapshot } from "../../../../src/state/snapshot.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-sampler-test-"));
  process.env.LICH_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.LICH_HOME;
});

function writeStack(stackId: string, snapshot: StackSnapshot): void {
  const dir = join(home, "stacks", stackId);
  mkdirSync(join(dir, "logs"), { recursive: true });
  mkdirSync(join(dir, "env"), { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(snapshot), "utf8");
}

function ownedSnapshot(stackId: string, pid: number): StackSnapshot {
  return {
    stack_id: stackId,
    worktree_name: "test-worktree",
    worktree_path: "/fake",
    status: "up",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    services: [
      {
        name: "api",
        kind: "owned",
        state: "ready",
        pid,
        started_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  };
}

function composeSnapshot(stackId: string): StackSnapshot {
  return {
    stack_id: stackId,
    worktree_name: "test-worktree",
    worktree_path: "/fake",
    status: "up",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    services: [
      {
        name: "postgres",
        kind: "compose",
        state: "ready",
        started_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  };
}

function makeProbe(args: {
  psOutput: string;
  dockerOutput?: string;
}): MetricsProbe {
  return {
    async ps() {
      return args.psOutput;
    },
    async dockerStats() {
      return args.dockerOutput ?? "";
    },
  };
}

describe("MetricsSampler — owned services aggregate the process tree", () => {
  it("sums RSS + pcpu across parent + 3 children", async () => {
    const stackId = "test-stack";
    writeStack(stackId, ownedSnapshot(stackId, 4500));

    // 5-column form so the sampler's CPU-time tracking gets real values.
    const ps =
      `PID PPID RSS %CPU TIME\n` +
      `1 0 1000 0.0 0:00.00\n` +
      `4500 1 50000 1.0 0:01.00\n` +
      `4501 4500 100000 2.0 0:02.00\n` +
      `4502 4500 100000 2.0 0:02.00\n` +
      `4503 4500 100000 2.0 0:02.00\n`;

    const sampler = new MetricsSampler({
      stateRoot: join(home, "stacks"),
      probe: makeProbe({ psOutput: ps }),
      intervalMs: 999_999,
    });
    try {
      await sampler.start();
      const snap = sampler.latest(stackId);
      expect(snap).not.toBeNull();
      const api = snap!.services.find((s) => s.name === "api");
      expect(api).toBeDefined();
      if (api?.kind === "owned") {
        expect(api.process_count).toBe(4);
        expect(api.mem_bytes).toBe((50_000 + 3 * 100_000) * 1024);
        expect(api.pid).toBe(4500);
        // first sample: CPU% reported as 0 even though cumulative is high
        expect(api.cpu_pct).toBe(0);
      } else {
        throw new Error("expected owned service");
      }
    } finally {
      sampler.stop();
    }
  });
});

describe("MetricsSampler — CPU% delta across two samples", () => {
  it("first sample reports 0%, second sample reports (Δcpu-time / Δwall) * 100", async () => {
    const stackId = "cpu-stack";
    writeStack(stackId, ownedSnapshot(stackId, 4500));

    // Tree cpu-time grows from 5s to 7s — 2s of CPU in 2s of wall = 100%.
    const psSample1 = `PID PPID RSS %CPU TIME\n4500 1 50000 5.0 0:05.00\n`;
    const psSample2 = `PID PPID RSS %CPU TIME\n4500 1 50000 8.0 0:07.00\n`;

    let nowMs = 1_000_000;
    let currentOutput = psSample1;
    const probe: MetricsProbe = {
      async ps() {
        return currentOutput;
      },
      async dockerStats() {
        return "";
      },
    };
    const sampler = new MetricsSampler({
      stateRoot: join(home, "stacks"),
      probe,
      intervalMs: 999_999,
      now: () => nowMs,
    });

    try {
      await sampler.start();
      const first = sampler.latest(stackId);
      expect(first).not.toBeNull();
      expect(first!.services[0].cpu_pct).toBe(0);

      currentOutput = psSample2;
      nowMs = 1_002_000;
      await sampler.tickOnce();

      const second = sampler.latest(stackId);
      expect(second).not.toBeNull();
      // 2s CPU / 2s wall = 100%
      expect(second!.services[0].cpu_pct).toBeCloseTo(100.0, 1);
    } finally {
      sampler.stop();
    }
  });

  it("reports partial CPU% correctly when CPU time grows slower than wall time", async () => {
    const stackId = "cpu-stack-partial";
    writeStack(stackId, ownedSnapshot(stackId, 4500));

    // 0.5s of CPU time over 2s wall → 25%
    const psSample1 = `PID PPID RSS %CPU TIME\n4500 1 50000 0.0 0:00.00\n`;
    const psSample2 = `PID PPID RSS %CPU TIME\n4500 1 50000 0.0 0:00.50\n`;

    let nowMs = 1_000_000;
    let currentOutput = psSample1;
    const sampler = new MetricsSampler({
      stateRoot: join(home, "stacks"),
      probe: {
        async ps() {
          return currentOutput;
        },
        async dockerStats() {
          return "";
        },
      },
      intervalMs: 999_999,
      now: () => nowMs,
    });
    try {
      await sampler.start();
      currentOutput = psSample2;
      nowMs = 1_002_000;
      await sampler.tickOnce();
      const second = sampler.latest(stackId);
      expect(second!.services[0].cpu_pct).toBeCloseTo(25.0, 1);
    } finally {
      sampler.stop();
    }
  });
});

describe("MetricsSampler — compose services use docker stats", () => {
  it("matches container by service-name suffix and reports memory + limit", async () => {
    const stackId = "compose-stack";
    writeStack(stackId, composeSnapshot(stackId));

    const dockerOut =
      `{"ID":"abc","Name":"lich-compose-stack-postgres-1","CPUPerc":"2.5%","MemUsage":"120MiB / 8GiB"}\n`;
    const sampler = new MetricsSampler({
      stateRoot: join(home, "stacks"),
      probe: makeProbe({
        psOutput: "PID PPID RSS %CPU\n",
        dockerOutput: dockerOut,
      }),
      intervalMs: 999_999,
    });

    try {
      await sampler.start();
      const snap = sampler.latest(stackId);
      expect(snap).not.toBeNull();
      const pg = snap!.services.find((s) => s.name === "postgres");
      expect(pg).toBeDefined();
      if (pg?.kind === "compose") {
        expect(pg.cpu_pct).toBeCloseTo(2.5, 5);
        expect(pg.mem_bytes).toBe(120 * 1024 ** 2);
        expect(pg.mem_limit_bytes).toBe(8 * 1024 ** 3);
        expect(pg.container_id).toBe("abc");
      } else {
        throw new Error("expected compose service");
      }
    } finally {
      sampler.stop();
    }
  });
});

describe("MetricsSampler — subscribers", () => {
  it("calls subscribers with every new snapshot", async () => {
    const stackId = "sub-stack";
    writeStack(stackId, ownedSnapshot(stackId, 4500));

    const sampler = new MetricsSampler({
      stateRoot: join(home, "stacks"),
      probe: makeProbe({ psOutput: "PID PPID RSS %CPU\n4500 1 1024 0.1\n" }),
      intervalMs: 999_999,
    });

    const received: number[] = [];
    const unsubscribe = sampler.subscribe(stackId, (snap) => {
      received.push(snap.services[0].mem_bytes);
    });
    try {
      await sampler.start();
      await sampler.tickOnce();
      expect(received).toHaveLength(2);
      expect(received[0]).toBe(1024 * 1024);
      unsubscribe();
      await sampler.tickOnce();
      expect(received).toHaveLength(2);
    } finally {
      sampler.stop();
    }
  });
});

describe("MetricsSampler — ring buffer pruning", () => {
  it("drops snapshots older than the ring window", async () => {
    const stackId = "ring-stack";
    writeStack(stackId, ownedSnapshot(stackId, 4500));

    let nowMs = 1_000_000;
    const probe: MetricsProbe = {
      async ps() {
        return "PID PPID RSS %CPU\n4500 1 100 0.1\n";
      },
      async dockerStats() {
        return "";
      },
    };
    const sampler = new MetricsSampler({
      stateRoot: join(home, "stacks"),
      probe,
      intervalMs: 999_999,
      ringSeconds: 4,
      now: () => nowMs,
    });
    try {
      await sampler.start();
      nowMs += 2_000;
      await sampler.tickOnce();
      nowMs += 2_000;
      await sampler.tickOnce();
      // Three samples within 4s — all kept (with at least one inside the window).
      expect(sampler.history(stackId)).toHaveLength(3);

      nowMs += 10_000;
      await sampler.tickOnce();
      const after = sampler.history(stackId);
      // Most of the early ones should be pruned; at least one kept (the latest).
      expect(after.length).toBeLessThan(4);
      expect(after.length).toBeGreaterThan(0);
    } finally {
      sampler.stop();
    }
  });
});

describe("deriveCpuInstant", () => {
  it("returns 0 on first sample (no prior cumulative)", () => {
    expect(
      deriveCpuInstant({ prevCpuTime: undefined, currCpuTime: 50, wallMs: 2_000 }),
    ).toBe(0);
  });

  it("returns (Δcpu / Δwall) * 100 — single core saturated", () => {
    expect(
      deriveCpuInstant({ prevCpuTime: 5, currCpuTime: 7, wallMs: 2_000 }),
    ).toBeCloseTo(100, 5);
  });

  it("returns >100% when subtree uses multiple cores", () => {
    expect(
      deriveCpuInstant({ prevCpuTime: 0, currCpuTime: 8, wallMs: 2_000 }),
    ).toBeCloseTo(400, 5);
  });

  it("clamps to 0 on negative delta", () => {
    expect(
      deriveCpuInstant({ prevCpuTime: 8, currCpuTime: 5, wallMs: 2_000 }),
    ).toBe(0);
  });

  it("returns 0 on zero wall time", () => {
    expect(
      deriveCpuInstant({ prevCpuTime: 1, currCpuTime: 2, wallMs: 0 }),
    ).toBe(0);
  });
});
