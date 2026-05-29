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
    // single-port lands under the `default` key; hostname drops the portkey
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
    // `-` separator (not `.`): *.lich.localhost only binds one subdomain level
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
    const entries = buildRoutingEntries(
      input("main", [svc("migrate"), svc("seed", {})]),
    );
    expect(entries).toEqual([]);
  });

  it("multiple services in the same stack produce non-colliding entries", () => {
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
    const hostnames = entries.map((e) => e.hostname);
    expect(new Set(hostnames).size).toBe(hostnames.length);
  });

  it("compose services share the same hostname convention as owned", () => {
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
    const entries = buildRoutingEntries(
      input("feature-x", [svc("api", { default: 9014 })]),
    );
    expect(entries[0].hostname).toBe("api.feature-x");
    expect(entries[0].hostname).not.toContain("-a3");
  });
});

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-up-routing-home-"));
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
  stream.on("data", () => {});
  return { stream };
}

describe("runUp — routing entries persisted to state.json", () => {
  it("writes routing for the full single/multi/no-port matrix and round-trips through snapshot+raw JSON", async () => {
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

    const wt = detectWorktree(projectDir);
    createdStackIds.push(wt.stack_id);

    const { stream } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    expect(result.exitCode).toBe(0);

    const snap = await readSnapshot(wt.stack_id);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("up");
    expect(snap!.routing).toBeDefined();
    expect(snap!.routing).toHaveLength(3);

    const wtName = snap!.worktree_name;
    expect(wtName).toMatch(/^stack-/);

    const byService = new Map<string, Array<(typeof snap.routing)[0]>>();
    for (const e of snap!.routing!) {
      const list = byService.get(e.service) ?? [];
      list.push(e);
      byService.set(e.service, list);
    }

    const singleEntries = byService.get("single")!;
    expect(singleEntries).toHaveLength(1);
    expect(singleEntries[0].hostname).toBe(`single.${wtName}`);
    const singleAllocated = snap!.services.find((s) => s.name === "single")!
      .allocated_ports!.default;
    expect(singleEntries[0].upstream_url).toBe(
      `http://127.0.0.1:${singleAllocated}`,
    );

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

    expect(byService.has("noport")).toBe(false);

    // raw on-disk read: guards against a reader synthesizing the field
    const statePath = join(homeDir, "stacks", wt.stack_id, "state.json");
    const raw = readFileSync(statePath, "utf8");
    expect(raw).toContain('"routing"');
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.routing)).toBe(true);
    expect(parsed.routing).toHaveLength(3);
    expect(parsed.routing[0]).toHaveProperty("hostname");
    expect(parsed.routing[0]).toHaveProperty("upstream_url");
    expect(parsed.routing[0]).toHaveProperty("service");

    // hostnames use worktree name, not stack_id's 8-char hash suffix
    expect(wt.stack_id).toMatch(new RegExp(`^${wtName}-[a-f0-9]{8}$`));
    for (const e of parsed.routing as Array<{ hostname: string }>) {
      expect(e.hostname).not.toMatch(/-[a-f0-9]{8}$/);
      expect(e.hostname.endsWith(`.${wtName}`)).toBe(true);
    }
  }, 30_000);
});
