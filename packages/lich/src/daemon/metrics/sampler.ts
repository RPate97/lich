/**
 * Daemon-side metrics sampler. Runs once per `intervalMs` (default 2s),
 * walks every alive stack's owned services + reads `docker stats` for compose
 * services, and maintains a 60s ring buffer per stack.
 *
 * Two pieces work together to give "current" CPU%:
 *   - ps's `pcpu` is "average CPU since process start" — useless for live load.
 *   - We track cumulative CPU% per PID across samples; current% = (delta /
 *     wall-clock delta) * 100, normalized to one core. First sample of any
 *     PID shows 0% (no prior cumulative to diff against).
 *
 * Docker stats already reports current% per cgroup, no diff needed.
 */

import { execFile as execFileCb } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { readSnapshot } from "../../state/snapshot.js";
import type {
  ServiceMetrics,
  ServiceMetricsCompose,
  ServiceMetricsOwned,
  StackMetricsSnapshot,
} from "./types.js";
import { parsePsOutput } from "./ps.js";
import { aggregateSubtree, indexByPid, indexByPpid } from "./proc-tree.js";
import { parseDockerStats, type DockerStatRow } from "./docker-stats.js";

const execFile = promisify(execFileCb);

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_RING_SECONDS = 60;

/** Externally-injectable so tests can stub `ps` / `docker stats` outputs. */
export interface MetricsProbe {
  ps(): Promise<string>;
  dockerStats(project: string): Promise<string>;
}

const realProbe: MetricsProbe = {
  async ps(): Promise<string> {
    const { stdout } = await execFile(
      "ps",
      ["-A", "-o", "pid,ppid,rss,pcpu,time"],
      {
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return stdout;
  },
  async dockerStats(project: string): Promise<string> {
    const args = [
      "stats",
      "--no-stream",
      "--no-trunc",
      "--format",
      "json",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ];
    try {
      const { stdout } = await execFile("docker", args, {
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch {
      // Docker daemon down, no containers, missing CLI — sampler degrades to
      // zero compose metrics rather than crashing the entire sampler loop.
      return "";
    }
  },
};

export interface MetricsSamplerOpts {
  /** Root containing per-stack state dirs (matches the daemon's stateRoot). */
  stateRoot: string;
  /** Defaults to 2s. */
  intervalMs?: number;
  /** Defaults to 60s of history. */
  ringSeconds?: number;
  /** Indirection seam for tests. */
  probe?: MetricsProbe;
  /** Defaults to Date.now; tests inject fakes for the delta math. */
  now?: () => number;
}

/** Snapshot-plus-PID-tracking ring entry. PID CPU history lets us derive instantaneous CPU% from ps's cumulative time. */
interface RingEntry {
  /** ms since epoch from `now()` at sample time. */
  takenAt: number;
  snapshot: StackMetricsSnapshot;
  /** Owned-service root PID → cumulative subtree CPU time (s). Diffed against the next sample to compute CPU%. */
  pidCpuTime: Map<number, number>;
}

interface StackEntry {
  ring: RingEntry[];
  /** Subscriber callbacks for SSE streams; called every sample. */
  subscribers: Set<(snap: StackMetricsSnapshot) => void>;
}

export class MetricsSampler {
  private readonly stateRoot: string;
  private readonly intervalMs: number;
  private readonly ringSeconds: number;
  private readonly probe: MetricsProbe;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private readonly stacks = new Map<string, StackEntry>();
  private stopped = false;

  constructor(opts: MetricsSamplerOpts) {
    this.stateRoot = opts.stateRoot;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.ringSeconds = opts.ringSeconds ?? DEFAULT_RING_SECONDS;
    this.probe = opts.probe ?? realProbe;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Schedule the first tick. Awaits it so callers can `await start()` and know the ring has at least one entry per alive stack. */
  async start(): Promise<void> {
    if (this.stopped) return;
    await this.tick();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // sampler errors must never take down the daemon
      });
    }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Last snapshot for a stack, or null if the stack has never been sampled. */
  latest(stackId: string): StackMetricsSnapshot | null {
    const entry = this.stacks.get(stackId);
    if (!entry || entry.ring.length === 0) return null;
    return entry.ring[entry.ring.length - 1].snapshot;
  }

  /** All snapshots in the ring (oldest → newest) for the given stack, or `[]`. */
  history(stackId: string): StackMetricsSnapshot[] {
    const entry = this.stacks.get(stackId);
    if (!entry) return [];
    return entry.ring.map((e) => e.snapshot);
  }

  /** Subscribe to per-sample updates. Returns the unsubscribe fn. */
  subscribe(
    stackId: string,
    cb: (snap: StackMetricsSnapshot) => void,
  ): () => void {
    let entry = this.stacks.get(stackId);
    if (!entry) {
      entry = { ring: [], subscribers: new Set() };
      this.stacks.set(stackId, entry);
    }
    entry.subscribers.add(cb);
    return () => {
      const e = this.stacks.get(stackId);
      if (e) e.subscribers.delete(cb);
    };
  }

  /** Manually trigger one sample (test/diagnostic surface). */
  async tickOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    const stackIds = await this.listStacks();
    if (stackIds.length === 0) {
      // GC subscribers for stacks that disappeared — we still keep the
      // ring map keyed in case it comes back; subscribers will reconnect.
      return;
    }

    let psSnapshot: ReturnType<typeof parsePsOutput> | null = null;
    try {
      psSnapshot = parsePsOutput(await this.probe.ps());
    } catch {
      // ps unavailable (extremely unusual) — owned metrics zero-fill below.
      psSnapshot = [];
    }
    const byPid = indexByPid(psSnapshot);
    const byPpid = indexByPpid(psSnapshot);

    const tookAt = this.now();
    const tookAtIso = new Date(tookAt).toISOString();

    for (const stackId of stackIds) {
      try {
        await this.sampleStack({
          stackId,
          byPid,
          byPpid,
          tookAt,
          tookAtIso,
        });
      } catch {
        // per-stack errors stay scoped to that stack
      }
    }
  }

  private async sampleStack(args: {
    stackId: string;
    byPid: Map<number, import("./types.js").PsRow>;
    byPpid: Map<number, import("./types.js").PsRow[]>;
    tookAt: number;
    tookAtIso: string;
  }): Promise<void> {
    const snap = await readSnapshot(args.stackId).catch(() => null);
    if (!snap) return;

    let entry = this.stacks.get(args.stackId);
    if (!entry) {
      entry = { ring: [], subscribers: new Set() };
      this.stacks.set(args.stackId, entry);
    }

    const prevEntry =
      entry.ring.length > 0 ? entry.ring[entry.ring.length - 1] : null;
    const prevCpuTime = prevEntry?.pidCpuTime ?? new Map<number, number>();
    const prevAt = prevEntry?.takenAt ?? args.tookAt;
    const wallMs = args.tookAt - prevAt;

    const nextCpuTime = new Map<number, number>();

    let composeRows: DockerStatRow[] = [];
    const hasCompose = snap.services.some((s) => s.kind === "compose");
    if (hasCompose) {
      const project = `lich-${args.stackId}`;
      try {
        composeRows = parseDockerStats(
          await this.probe.dockerStats(project),
        );
      } catch {
        composeRows = [];
      }
    }

    const services: ServiceMetrics[] = [];
    let totalCpu = 0;
    let totalMem = 0;

    for (const svc of snap.services) {
      const uptime = computeUptimeSeconds(svc.started_at, args.tookAt);
      if (svc.kind === "owned") {
        const pid = svc.pid;
        let cpuTime = 0;
        let memBytes = 0;
        let procCount = 0;
        if (pid !== undefined && pid > 0) {
          const agg = aggregateSubtree(pid, args.byPid, args.byPpid);
          procCount = agg.process_count;
          memBytes = agg.mem_bytes;
          cpuTime = agg.cpu_time_seconds;
          // Track this subtree's cumulative CPU time under the parent PID —
          // the next sample diffs (Δtime / Δwall) to derive instantaneous %.
          nextCpuTime.set(pid, cpuTime);
        }
        const cpuInstant = deriveCpuInstant({
          prevCpuTime: pid !== undefined ? prevCpuTime.get(pid) : undefined,
          currCpuTime: cpuTime,
          wallMs,
        });
        const entryMetric: ServiceMetricsOwned = {
          name: svc.name,
          kind: "owned",
          state: svc.state,
          cpu_pct: cpuInstant,
          mem_bytes: memBytes,
          uptime_seconds: uptime,
          process_count: procCount,
        };
        if (pid !== undefined) entryMetric.pid = pid;
        services.push(entryMetric);
        totalCpu += cpuInstant;
        totalMem += memBytes;
      } else {
        // compose — match by container name suffix: docker stats reports
        // the container's full name including the project prefix.
        const expectedTail = `-${svc.name}-`;
        const match =
          composeRows.find(
            (r) =>
              r.name.includes(expectedTail) || r.name.endsWith(`-${svc.name}`),
          ) ?? null;
        const cpu = match?.cpu_pct ?? 0;
        const mem = match?.mem_bytes ?? 0;
        const composeMetric: ServiceMetricsCompose = {
          name: svc.name,
          kind: "compose",
          state: svc.state,
          cpu_pct: cpu,
          mem_bytes: mem,
          uptime_seconds: uptime,
        };
        if (match) {
          composeMetric.container_id = match.container_id;
          if (match.mem_limit_bytes !== undefined) {
            composeMetric.mem_limit_bytes = match.mem_limit_bytes;
          }
        }
        services.push(composeMetric);
        totalCpu += cpu;
        totalMem += mem;
      }
    }

    const snapshot: StackMetricsSnapshot = {
      stack_id: args.stackId,
      sampled_at: args.tookAtIso,
      total: { cpu_pct: round1(totalCpu), mem_bytes: totalMem },
      services: services.map((s) => ({ ...s, cpu_pct: round1(s.cpu_pct) })),
    };

    entry.ring.push({
      takenAt: args.tookAt,
      snapshot,
      pidCpuTime: nextCpuTime,
    });
    pruneRing(entry.ring, args.tookAt, this.ringSeconds * 1000);

    for (const cb of entry.subscribers) {
      try {
        cb(snapshot);
      } catch {
        // subscriber errors stay scoped to that subscriber
      }
    }
  }

  private async listStacks(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.stateRoot);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of entries) {
      try {
        const s = await stat(join(this.stateRoot, name));
        if (s.isDirectory()) out.push(name);
      } catch {
        // skip — concurrent removal
      }
    }
    return out;
  }
}

/**
 * Convert ps's cumulative CPU time (seconds) into current CPU%.
 * Standard formula: (Δcpu-time / Δwall-time) * 100. Normalized to a single
 * core — a process pegging all 8 cores will read 800%. First sample has no
 * prior reading, so returns 0% rather than extrapolating from "lifetime".
 *
 * Why CPU time instead of ps's pcpu: pcpu is "average % since start" and
 * decreases when the process goes idle. A delta of pcpu can therefore be
 * negative (we clamped to 0), which made the metric report 0% for any process
 * whose long-run average was tilting down. CPU time is monotonically
 * non-decreasing, so the delta is always meaningful.
 */
export function deriveCpuInstant(args: {
  prevCpuTime: number | undefined;
  currCpuTime: number;
  wallMs: number;
}): number {
  if (args.prevCpuTime === undefined) return 0;
  if (args.wallMs <= 0) return 0;
  const deltaSeconds = args.currCpuTime - args.prevCpuTime;
  if (deltaSeconds <= 0) return 0;
  const wallSeconds = args.wallMs / 1000;
  return (deltaSeconds / wallSeconds) * 100;
}

function pruneRing(ring: RingEntry[], nowMs: number, maxAgeMs: number): void {
  const threshold = nowMs - maxAgeMs;
  while (ring.length > 1 && ring[0].takenAt < threshold) {
    ring.shift();
  }
}

function computeUptimeSeconds(startedAtIso: string | undefined, nowMs: number): number {
  if (!startedAtIso) return 0;
  const t = Date.parse(startedAtIso);
  if (!Number.isFinite(t)) return 0;
  const d = Math.floor((nowMs - t) / 1000);
  return d < 0 ? 0 : d;
}

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}
