import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stackDir } from "../../../src/state/directory.js";
import {
  type StackSnapshot,
  writeSnapshot,
} from "../../../src/state/snapshot.js";
import {
  formatUptime,
  runStacks,
} from "../../../src/commands/stacks.js";

let home: string;
let prevLichHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lich-stacks-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = home;
});

afterEach(() => {
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(home, { recursive: true, force: true });
});

class Sink {
  chunks: string[] = [];
  write = (chunk: string | Uint8Array): boolean => {
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  text(): string {
    return this.chunks.join("");
  }
}

function makeSink(): { sink: Sink; out: NodeJS.WritableStream } {
  const sink = new Sink();
  return { sink, out: sink as unknown as NodeJS.WritableStream };
}

function isoMinusSeconds(s: number): string {
  return new Date(Date.now() - s * 1000).toISOString();
}

function snap(overrides: Partial<StackSnapshot> & { stack_id: string }): StackSnapshot {
  return {
    worktree_name: overrides.stack_id,
    worktree_path: `/tmp/${overrides.stack_id}`,
    status: "up",
    started_at: isoMinusSeconds(60),
    services: [],
    ...overrides,
  };
}

describe("runStacks — empty", () => {
  it("pretty: prints 'no stacks running' and exits 0", async () => {
    const { sink, out } = makeSink();
    const result = await runStacks({ out });
    expect(result.exitCode).toBe(0);
    expect(sink.text().trim()).toBe("no stacks running");
  });

  it("json: prints '[]' and exits 0", async () => {
    const { sink, out } = makeSink();
    const result = await runStacks({ out, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(sink.text());
    expect(parsed).toEqual([]);
  });
});

describe("runStacks — single healthy stack", () => {
  it("pretty: shows one row with worktree, status, uptime, services, url", async () => {
    await writeSnapshot(
      snap({
        stack_id: "s1",
        worktree_name: "dogfood-stack",
        status: "up",
        started_at: isoMinusSeconds(3600),
        services: [
          {
            name: "postgres",
            kind: "compose",
            state: "healthy",
            allocated_ports: { POSTGRES_HOST_PORT: 5847 },
          },
          {
            name: "api",
            kind: "owned",
            state: "ready",
            allocated_ports: { PORT: 4000 },
          },
          { name: "web", kind: "owned", state: "ready" },
        ],
      }),
    );

    const { sink, out } = makeSink();
    const result = await runStacks({ out });
    expect(result.exitCode).toBe(0);

    const text = sink.text();
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/WORKTREE\s+STATUS\s+UPTIME\s+SERVICES\s+URL/);
    expect(lines[1]).toContain("dogfood-stack");
    expect(lines[1]).toContain("up");
    // ~1h with slop
    expect(lines[1]).toMatch(/\b01:00:0\d\b/);
    expect(lines[1]).toContain("3/3");
    expect(lines[1]).toContain("http://localhost:5847");
  });

  it("json: shape includes stack_id, worktree_name, status, started_at, uptime_seconds, services, primary_url", async () => {
    await writeSnapshot(
      snap({
        stack_id: "s1",
        worktree_name: "dogfood-stack",
        started_at: isoMinusSeconds(120),
        services: [
          {
            name: "postgres",
            kind: "compose",
            state: "healthy",
            allocated_ports: { POSTGRES_HOST_PORT: 5847 },
          },
        ],
      }),
    );

    const { sink, out } = makeSink();
    const result = await runStacks({ out, json: true });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(sink.text());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    const [entry] = parsed;
    expect(entry.stack_id).toBe("s1");
    expect(entry.worktree_name).toBe("dogfood-stack");
    expect(entry.status).toBe("up");
    expect(typeof entry.started_at).toBe("string");
    expect(entry.uptime_seconds).toBeGreaterThanOrEqual(119);
    expect(entry.uptime_seconds).toBeLessThanOrEqual(125);
    expect(entry.services).toEqual([
      { name: "postgres", kind: "compose", state: "healthy" },
    ]);
    expect(entry.primary_url).toBe("http://localhost:5847");
  });
});

describe("runStacks — multiple stacks", () => {
  it("lists all stacks sorted alphabetically by worktree_name", async () => {
    await writeSnapshot(
      snap({
        stack_id: "id-zulu",
        worktree_name: "zulu",
        services: [{ name: "x", kind: "owned", state: "ready" }],
      }),
    );
    await writeSnapshot(
      snap({
        stack_id: "id-alpha",
        worktree_name: "alpha",
        services: [{ name: "x", kind: "owned", state: "ready" }],
      }),
    );
    await writeSnapshot(
      snap({
        stack_id: "id-mike",
        worktree_name: "mike",
        services: [{ name: "x", kind: "owned", state: "ready" }],
      }),
    );

    const { sink, out } = makeSink();
    await runStacks({ out, json: true });
    const parsed: Array<{ worktree_name: string }> = JSON.parse(sink.text());
    expect(parsed.map((r) => r.worktree_name)).toEqual([
      "alpha",
      "mike",
      "zulu",
    ]);
  });

  it("mixed states all appear", async () => {
    await writeSnapshot(
      snap({
        stack_id: "a",
        worktree_name: "alpha",
        status: "up",
        services: [{ name: "x", kind: "owned", state: "ready" }],
      }),
    );
    await writeSnapshot(
      snap({
        stack_id: "b",
        worktree_name: "bravo",
        status: "partial",
        services: [
          { name: "x", kind: "owned", state: "ready" },
          { name: "y", kind: "owned", state: "failed" },
        ],
      }),
    );
    await writeSnapshot(
      snap({
        stack_id: "c",
        worktree_name: "charlie",
        status: "starting",
        services: [{ name: "x", kind: "owned", state: "starting" }],
      }),
    );

    const { sink, out } = makeSink();
    await runStacks({ out });
    const text = sink.text();
    expect(text).toContain("alpha");
    expect(text).toContain("bravo");
    expect(text).toContain("charlie");
    expect(text).toContain("partial");
    expect(text).toContain("starting");
  });
});

describe("runStacks — orphan directory", () => {
  it("skips silently when state.json is missing", async () => {
    await writeSnapshot(
      snap({
        stack_id: "real",
        worktree_name: "real-stack",
        services: [{ name: "x", kind: "owned", state: "ready" }],
      }),
    );
    mkdirSync(stackDir("orphan"), { recursive: true });
    writeFileSync(join(stackDir("orphan"), "logs.txt"), "noise", "utf8");

    const { sink, out } = makeSink();
    await runStacks({ out, json: true });
    const parsed: Array<{ worktree_name: string }> = JSON.parse(sink.text());
    expect(parsed).toHaveLength(1);
    expect(parsed[0].worktree_name).toBe("real-stack");
  });
});

describe("runStacks — failed services", () => {
  it("renders '2/3 (1 failed)' when one of three services failed", async () => {
    await writeSnapshot(
      snap({
        stack_id: "p",
        worktree_name: "partial-stack",
        status: "partial",
        services: [
          { name: "a", kind: "owned", state: "ready" },
          { name: "b", kind: "owned", state: "healthy" },
          { name: "c", kind: "owned", state: "failed" },
        ],
      }),
    );

    const { sink, out } = makeSink();
    await runStacks({ out });
    expect(sink.text()).toContain("2/3 (1 failed)");
  });
});

describe("runStacks — primary_url", () => {
  it("uses the first service with allocated_ports", async () => {
    await writeSnapshot(
      snap({
        stack_id: "u",
        worktree_name: "url-stack",
        services: [
          { name: "noports", kind: "owned", state: "ready" },
          {
            name: "api",
            kind: "owned",
            state: "ready",
            allocated_ports: { PORT: 9100 },
          },
          {
            name: "web",
            kind: "owned",
            state: "ready",
            allocated_ports: { PORT: 9200 },
          },
        ],
      }),
    );

    const { sink, out } = makeSink();
    await runStacks({ out, json: true });
    const [entry] = JSON.parse(sink.text());
    expect(entry.primary_url).toBe("http://localhost:9100");
  });

  it("omits primary_url when no service has allocated_ports (json)", async () => {
    await writeSnapshot(
      snap({
        stack_id: "n",
        worktree_name: "no-url",
        services: [{ name: "x", kind: "owned", state: "ready" }],
      }),
    );

    const { sink, out } = makeSink();
    await runStacks({ out, json: true });
    const [entry] = JSON.parse(sink.text());
    expect(entry.primary_url).toBeUndefined();
  });

  it("leaves URL column blank in pretty when no ports", async () => {
    await writeSnapshot(
      snap({
        stack_id: "n",
        worktree_name: "no-url",
        services: [{ name: "x", kind: "owned", state: "ready" }],
      }),
    );

    const { sink, out } = makeSink();
    await runStacks({ out });
    const lines = sink.text().trimEnd().split("\n");
    expect(lines[1]).not.toContain("http://");
  });
});

describe("runStacks — active_profile (json wire format)", () => {
  it("includes active_profile in the JSON when the snapshot recorded one", async () => {
    await writeSnapshot(
      snap({
        stack_id: "id-prof",
        worktree_name: "with-profile",
        active_profile: "dev",
        services: [{ name: "api", kind: "owned", state: "ready" }],
      }),
    );

    const { sink, out } = makeSink();
    const result = await runStacks({ out, json: true });
    expect(result.exitCode).toBe(0);

    const [entry] = JSON.parse(sink.text());
    expect(entry.active_profile).toBe("dev");
  });

  it("omits active_profile from the JSON when the snapshot has none", async () => {
    await writeSnapshot(
      snap({
        stack_id: "id-noprof",
        worktree_name: "no-profile",
        services: [{ name: "api", kind: "owned", state: "ready" }],
      }),
    );

    const { sink, out } = makeSink();
    const result = await runStacks({ out, json: true });
    expect(result.exitCode).toBe(0);

    const text = sink.text();
    const [entry] = JSON.parse(text);
    // contract: key absent — `in` catches a serialized null too
    expect("active_profile" in entry).toBe(false);
  });
});

describe("formatUptime", () => {
  it("formats sub-minute correctly", () => {
    expect(formatUptime(0)).toBe("00:00:00");
    expect(formatUptime(7)).toBe("00:00:07");
  });

  it("formats minutes and hours correctly", () => {
    expect(formatUptime(60)).toBe("00:01:00");
    expect(formatUptime(3600)).toBe("01:00:00");
    expect(formatUptime(3661)).toBe("01:01:01");
  });

  it("formats >24h with day prefix", () => {
    expect(formatUptime(86400)).toBe("1d 00:00:00");
    expect(formatUptime(90061)).toBe("1d 01:01:01");
    expect(formatUptime(2 * 86400 + 7200 + 180 + 5)).toBe("2d 02:03:05");
  });

  it("clamps negative seconds to zero", () => {
    expect(formatUptime(-5)).toBe("00:00:00");
  });
});

describe("runStacks — uptime calculation end-to-end", () => {
  it("snapshot started_at = 1 hour ago produces uptime ~01:00:00 in pretty output", async () => {
    await writeSnapshot(
      snap({
        stack_id: "h",
        worktree_name: "hour-stack",
        started_at: isoMinusSeconds(3600),
        services: [{ name: "x", kind: "owned", state: "ready" }],
      }),
    );

    const { sink, out } = makeSink();
    await runStacks({ out });
    // allow clock slop
    expect(sink.text()).toMatch(/\b01:00:0\d\b/);
  });
});
