/**
 * Unit tests for `buildRoutingEntries` + `runUp`'s routing snapshot write
 * (LEV-410, Plan 5 Task 8).
 *
 * Two test groups:
 *
 *   1. `buildRoutingEntries` pure-function tests. Synthetic `RoutingInput`s
 *      pin the hostname convention (`<service>.<wt>` for single-port,
 *      `<service>-<portkey>.<wt>` for multi-port), no-collision behavior
 *      across multiple services, and the empty-list result for services
 *      with no allocated ports. The pure function lets us assert exact
 *      output without spinning the full pipeline up.
 *
 *   2. `runUp` integration test. Spins up real owned services under a tmp
 *      LICH_HOME, runs `runUp`, then reads `state.json` from disk and
 *      asserts the `routing` field round-trips with the expected entries.
 *      Proves the orchestrator actually persists the field — not just that
 *      the helper would produce the right shape if called.
 *
 * The two-tier split mirrors the rest of `tests/unit/commands/`: a helper
 * test for the pure logic, plus a real-orchestrator test for the wiring.
 * Either alone would leave a gap (a helper test that drifted out of sync
 * with the orchestrator, or an integration test that couldn't isolate
 * regressions in the helper).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  buildRoutingEntries,
  runUp,
  type RoutingInput,
} from "../../../src/commands/up.js";
import {
  readSnapshot,
  type ServiceSnapshot,
} from "../../../src/state/snapshot.js";
import { release } from "../../../src/ports/allocator.js";
import { detectWorktree } from "../../../src/worktree/detect.js";

// ---------------------------------------------------------------------------
// Pure-function tests for buildRoutingEntries
// ---------------------------------------------------------------------------

function svc(
  name: string,
  ports?: Record<string, number>,
  kind: ServiceSnapshot["kind"] = "owned",
): ServiceSnapshot {
  const s: ServiceSnapshot = {
    name,
    kind,
    state: "ready",
  };
  if (ports !== undefined) s.allocated_ports = ports;
  return s;
}

function input(
  worktreeName: string,
  services: ServiceSnapshot[],
): RoutingInput {
  const map = new Map<string, ServiceSnapshot>();
  for (const s of services) map.set(s.name, s);
  return { worktree: { name: worktreeName }, services: map };
}

describe("buildRoutingEntries — pure", () => {
  it("single-port owned service produces one entry with the expected shape", () => {
    // single-port owned services land in the snapshot with their lone
    // allocated port keyed under `default` (per the convention in
    // state/snapshot.ts's rebuildAllocatedPorts). The friendly hostname
    // drops the portkey since there's only one — `api.feature-x`, not
    // `api-default.feature-x`.
    const entries = buildRoutingEntries(
      input("feature-x", [svc("api", { default: 9014 })]),
    );
    expect(entries).toEqual([
      {
        hostname: "api.feature-x",
        upstream_url: "http://127.0.0.1:9014",
        service: "api",
      },
    ]);
  });

  it("multi-port owned service produces N entries, one per logical port", () => {
    // dogfood's supabase shape: multiple logical ports under one service.
    // Each becomes its own hostname keyed by `<service>-<portkey>.<wt>`
    // (using `-` because `*.lich.localhost` only binds one level of
    // subdomain — `supabase.api.<wt>.lich.localhost` would not resolve).
    const entries = buildRoutingEntries(
      input("feature-x", [
        svc("supabase", { api: 9011, db: 9012, studio: 9013 }),
      ]),
    );
    expect(entries).toEqual([
      {
        hostname: "supabase-api.feature-x",
        upstream_url: "http://127.0.0.1:9011",
        service: "supabase",
      },
      {
        hostname: "supabase-db.feature-x",
        upstream_url: "http://127.0.0.1:9012",
        service: "supabase",
      },
      {
        hostname: "supabase-studio.feature-x",
        upstream_url: "http://127.0.0.1:9013",
        service: "supabase",
      },
    ]);
  });

  it("service with no allocated ports produces zero entries", () => {
    // Oneshots (e.g. supabase migration up) and any owned/compose service
    // that doesn't declare a port have nothing for the proxy to route to.
    // They show up in the snapshot but contribute zero routing rows.
    const entries = buildRoutingEntries(
      input("main", [svc("migrate"), svc("seed", {})]),
    );
    expect(entries).toEqual([]);
  });

  it("multiple services in the same stack produce non-colliding entries", () => {
    // The hostname is `<service>.<wt>` so different services in the same
    // worktree naturally never collide. Confirms iteration order matches
    // the snapshot map's insertion order — important because the proxy
    // and dashboard consume the array directly.
    const entries = buildRoutingEntries(
      input("main", [
        svc("api", { default: 9001 }),
        svc("web", { default: 9002 }),
        svc("worker"),
        svc("supabase", { api: 9003, db: 9004 }),
      ]),
    );
    expect(entries).toEqual([
      {
        hostname: "api.main",
        upstream_url: "http://127.0.0.1:9001",
        service: "api",
      },
      {
        hostname: "web.main",
        upstream_url: "http://127.0.0.1:9002",
        service: "web",
      },
      // `worker` has no ports — no entry.
      {
        hostname: "supabase-api.main",
        upstream_url: "http://127.0.0.1:9003",
        service: "supabase",
      },
      {
        hostname: "supabase-db.main",
        upstream_url: "http://127.0.0.1:9004",
        service: "supabase",
      },
    ]);
    // No hostname appears twice — the proxy would error on a collision.
    const hostnames = entries.map((e) => e.hostname);
    expect(new Set(hostnames).size).toBe(hostnames.length);
  });

  it("compose services share the same hostname convention as owned", () => {
    // The proxy doesn't differentiate by kind — it routes by hostname.
    // A compose service with a single allocated port becomes
    // `<service>.<wt>` just like an owned one; multi-port follows the
    // same `-<portkey>` suffixing.
    const entries = buildRoutingEntries(
      input("main", [
        svc("postgres", { POSTGRES_HOST_PORT: 54321 }, "compose"),
        svc(
          "redis",
          { primary: 6379, replica: 6380 },
          "compose",
        ),
      ]),
    );
    expect(entries).toEqual([
      {
        hostname: "postgres.main",
        upstream_url: "http://127.0.0.1:54321",
        service: "postgres",
      },
      {
        hostname: "redis-primary.main",
        upstream_url: "http://127.0.0.1:6379",
        service: "redis",
      },
      {
        hostname: "redis-replica.main",
        upstream_url: "http://127.0.0.1:6380",
        service: "redis",
      },
    ]);
  });

  it("hostname uses worktree name (not stack id)", () => {
    // The contract: `worktree.name` is the human-readable slug (`feature-x`),
    // NOT the stack id (which carries a hash suffix like `feature-x-a3f12c`).
    // Friendly URLs are for humans; collisions across worktrees are avoided
    // by the worktree name itself, not by the hash. This test pins that
    // the helper reads `worktree.name` rather than e.g. accidentally
    // pulling `stack_id` from somewhere.
    const entries = buildRoutingEntries(
      input("feature-x", [svc("api", { default: 9014 })]),
    );
    expect(entries[0].hostname).toBe("api.feature-x");
    expect(entries[0].hostname).not.toContain("-a3"); // no hash leakage
  });
});

// ---------------------------------------------------------------------------
// Integration test: runUp persists routing into state.json
// ---------------------------------------------------------------------------

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-routing-home-"));
  // Worktree detection sanitizes the dir basename into the worktree name —
  // `stack-XXXXX` → `stack-XXXXX`. The integration test reads the snapshot
  // by stack_id derived from `detectWorktree(projectDir)`, so the prefix
  // ensures predictable worktree names without us pinning the suffix.
  projectDir = mkdtempSync(join(tmpdir(), "stack-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
});

afterEach(async () => {
  for (const id of createdStackIds) {
    await release(id).catch(() => {});
  }
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function captureStdout(): { stream: PassThrough } {
  const stream = new PassThrough();
  // Drain so PassThrough's internal buffer doesn't fill and back-pressure
  // the writer.
  stream.on("data", () => {});
  return { stream };
}

describe("runUp — routing entries persisted to state.json (LEV-410)", () => {
  it("writes routing for the full single/multi/no-port matrix and round-trips through snapshot+raw JSON", async () => {
    // One integration test covers every shape so we don't multiply the
    // overhead of full `runUp` invocations across the suite (the sibling
    // pure-function tests above pin the per-shape behavior). Three services:
    //   - `single`: single-port owned (port: { env: ... }) → 1 entry
    //   - `multi`:  multi-port owned (ports: { ... }) → N entries
    //   - `noport`: no port declared → 0 entries
    // The result block is asserted both via the typed snapshot reader AND
    // a raw JSON parse so we know the writer, sanitizer, and reader all
    // agree on the on-disk shape.
    const sentinelSingle = join(projectDir, "single.ready");
    const sentinelMulti = join(projectDir, "multi.ready");
    const sentinelNoport = join(projectDir, "noport.ready");
    writeYaml(`
version: "1"
runtime:
  port_range: [20410, 20480]
owned:
  single:
    cmd: "echo READY; touch ${shellQuote(sentinelSingle)}; sleep 30"
    port: { env: SINGLE_PORT }
    ready_when:
      log_match: "READY"
  multi:
    cmd: "echo READY; touch ${shellQuote(sentinelMulti)}; sleep 30"
    ports:
      api: { env: MULTI_API_PORT }
      db:  { env: MULTI_DB_PORT }
    ready_when:
      log_match: "READY"
  noport:
    cmd: "echo READY; touch ${shellQuote(sentinelNoport)}; sleep 30"
    ready_when:
      log_match: "READY"
`);

    // Pre-compute the stack_id from the project path BEFORE invoking
    // `runUp`. Worktree detection is deterministic on the absolute path, so
    // we know exactly which stack_id `runUp` will resolve to. We use this
    // independent handle to read state.json on the back end — the readback
    // is what proves the routing field made it to disk; runUp's typed
    // return value is just a convenience.
    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    expect(result.exitCode).toBe(0);

    // Round-trip path (writer → on-disk JSON → reader) — proves the routing
    // field survives `sanitizeForWrite` and the snapshot reader's shape
    // decoding. This is the integration counterpart to the unit tests in
    // `state/snapshot-routing.test.ts`.
    const snap = await readSnapshot(wt.stack_id);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("up");
    expect(snap!.routing).toBeDefined();
    expect(snap!.routing).toHaveLength(3);

    const wtName = snap!.worktree_name;
    // Worktree name comes from `mkdtempSync(tmpdir(), "stack-")` which yields
    // `stack-XXXXX`. We don't hard-code the suffix; we use `wtName` directly
    // in expected hostnames so the assertion is exact.
    expect(wtName).toMatch(/^stack-/);

    // Group entries by owning service so each shape's contract can be
    // verified independently.
    const byService = new Map<string, Array<(typeof snap.routing)[0]>>();
    for (const e of snap!.routing!) {
      const list = byService.get(e.service) ?? [];
      list.push(e);
      byService.set(e.service, list);
    }

    // single-port owned: one entry, hostname `single.<wt>`, upstream points
    // at the actual allocated port (cross-verified against snapshot.services).
    const singleEntries = byService.get("single")!;
    expect(singleEntries).toHaveLength(1);
    expect(singleEntries[0].hostname).toBe(`single.${wtName}`);
    const singleAllocated = snap!.services.find((s) => s.name === "single")!
      .allocated_ports!.default;
    expect(singleEntries[0].upstream_url).toBe(
      `http://127.0.0.1:${singleAllocated}`,
    );

    // multi-port owned: two entries, hostnames `multi-api.<wt>` +
    // `multi-db.<wt>`. Both upstreams point at their respective allocated
    // ports.
    const multiEntries = byService.get("multi")!;
    expect(multiEntries).toHaveLength(2);
    const multiByHost = new Map(multiEntries.map((e) => [e.hostname, e]));
    expect(multiByHost.has(`multi-api.${wtName}`)).toBe(true);
    expect(multiByHost.has(`multi-db.${wtName}`)).toBe(true);
    const multiAllocated = snap!.services.find((s) => s.name === "multi")!
      .allocated_ports!;
    expect(multiByHost.get(`multi-api.${wtName}`)!.upstream_url).toBe(
      `http://127.0.0.1:${multiAllocated.api}`,
    );
    expect(multiByHost.get(`multi-db.${wtName}`)!.upstream_url).toBe(
      `http://127.0.0.1:${multiAllocated.db}`,
    );

    // noport: NO entries — the proxy has nothing to route to.
    expect(byService.has("noport")).toBe(false);

    // Belt-and-suspenders: confirm the raw on-disk JSON literally contains
    // the `routing` key. Without this, a bug in the reader could synthesize
    // the field after the fact and we'd never notice. Reads the same file
    // the daemon's filesystem watcher would see.
    const statePath = join(homeDir, "stacks", wt.stack_id, "state.json");
    const raw = readFileSync(statePath, "utf8");
    expect(raw).toContain('"routing"');
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.routing)).toBe(true);
    expect(parsed.routing).toHaveLength(3);
    expect(parsed.routing[0]).toHaveProperty("hostname");
    expect(parsed.routing[0]).toHaveProperty("upstream_url");
    expect(parsed.routing[0]).toHaveProperty("service");

    // Hostname uses the worktree NAME, not the stack id (which carries an
    // 8-char hash suffix). The stack id starts with the worktree name —
    // assert the routing hostnames don't contain the hash suffix.
    expect(wt.stack_id).toMatch(new RegExp(`^${wtName}-[a-f0-9]{8}$`));
    for (const e of parsed.routing as Array<{ hostname: string }>) {
      // hostname matches `<service>(-<portkey>)?.<wt>` — never embeds the
      // stack id's hash suffix.
      expect(e.hostname).not.toMatch(/-[a-f0-9]{8}$/);
      expect(e.hostname.endsWith(`.${wtName}`)).toBe(true);
    }
  }, 30_000);
});
