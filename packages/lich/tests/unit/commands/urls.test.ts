import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUrls } from "../../../src/commands/urls.js";
import { detectWorktree } from "../../../src/worktree/detect.js";
import {
  type ServiceSnapshot,
  type StackSnapshot,
  writeSnapshot,
} from "../../../src/state/snapshot.js";

// ---------------------------------------------------------------------------
// Test plumbing
//
// Each test gets:
//   - A tmpdir with a fresh `lich.yaml` so `detectWorktree` returns a valid
//     stack id.
//   - A separate tmpdir set as `LICH_HOME` so `writeSnapshot` writes under
//     `<LICH_HOME>/stacks/<stack-id>/state.json` without touching the
//     user's real `~/.lich`.
//   - A `StringSink` pair that captures stdout/stderr writes so the test
//     can assert on the exact bytes produced.
// ---------------------------------------------------------------------------

class StringSink {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;
let lichHome: string;
let prevLichHome: string | undefined;
let stdout: StringSink;
let stderr: StringSink;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "lich-urls-test-"));
  lichHome = mkdtempSync(join(tmpdir(), "lich-urls-home-"));
  prevLichHome = process.env.LICH_HOME;
  process.env.LICH_HOME = lichHome;
  stdout = new StringSink();
  stderr = new StringSink();
});

afterEach(() => {
  if (prevLichHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevLichHome;
  }
  rmSync(workdir, { recursive: true, force: true });
  rmSync(lichHome, { recursive: true, force: true });
});

/** Drop a minimal `lich.yaml` at `workdir` so detectWorktree finds it. */
function writeYaml(): void {
  writeFileSync(join(workdir, "lich.yaml"), `version: "1"\n`, "utf8");
}

async function writeSnap(
  builder: (stackId: string) => StackSnapshot,
): Promise<StackSnapshot> {
  const wt = detectWorktree(workdir);
  const snap = builder(wt.stack_id);
  await writeSnapshot(snap);
  return snap;
}

async function run(): Promise<{ exitCode: number; out: string; err: string }> {
  // Use --raw mode for these tests: they predate Plan 5's friendly URL
  // default and pin the raw-upstream-URL behavior. Friendly URL coverage
  // lives in `urls-friendly.test.ts`.
  const result = await runUrls({
    cwd: workdir,
    out: stdout as unknown as NodeJS.WritableStream,
    err: stderr as unknown as NodeJS.WritableStream,
    raw: true,
  });
  return { exitCode: result.exitCode, out: stdout.text(), err: stderr.text() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runUrls — no stack present", () => {
  it("exits 1 with a clear error when there is no state for this worktree", async () => {
    writeYaml(); // lich.yaml exists, but no state.json written
    const { exitCode, out, err } = await run();
    expect(exitCode).toBe(1);
    expect(err).toContain("no stack found");
    expect(out).toBe("");
  });

  it("exits 1 when there is no lich.yaml in the cwd ancestry either", async () => {
    // Note: workdir created by mkdtempSync is under the OS tmpdir, which is
    // not inside any git repo, so detectWorktree will walk to the FS root
    // and throw. The urls command must catch that and produce the same
    // user-facing message.
    const { exitCode, err } = await run();
    expect(exitCode).toBe(1);
    expect(err).toContain("no stack found");
  });
});

describe("runUrls — owned services", () => {
  it("prints a single URL line for a single-port owned service", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { PORT: 4001 },
          pid: 1234,
        },
      ],
    }));

    const { exitCode, out, err } = await run();
    expect(exitCode).toBe(0);
    expect(err).toBe("");
    expect(out).toBe("api: http://127.0.0.1:4001\n");
  });

  it("prints one URL line per logical port for a multi-port owned service", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "supabase",
          kind: "owned",
          state: "ready",
          allocated_ports: {
            api: 54321,
            studio: 54323,
            db: 54322,
          },
          pid: 5555,
        },
      ],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    // One line per logical port. Order matches the allocated_ports object
    // insertion order, which is what the runner is responsible for setting.
    const lines = out.trimEnd().split("\n");
    expect(lines).toEqual([
      "supabase.api: http://127.0.0.1:54321",
      "supabase.studio: http://127.0.0.1:54323",
      "supabase.db: http://127.0.0.1:54322",
    ]);
  });
});

describe("runUrls — compose services", () => {
  it("prints one URL line for a compose service with a single allocated port", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          allocated_ports: { POSTGRES_HOST_PORT: 54100 },
        },
      ],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toBe("postgres: http://127.0.0.1:54100\n");
  });
});

describe("runUrls — mixed compose + owned", () => {
  it("lists every service with allocated ports, in snapshot declaration order", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        {
          name: "postgres",
          kind: "compose",
          state: "ready",
          allocated_ports: { POSTGRES_HOST_PORT: 54100 },
        },
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { PORT: 4001 },
          pid: 1,
        },
        {
          name: "web",
          kind: "owned",
          state: "ready",
          allocated_ports: { PORT: 3001 },
          pid: 2,
        },
      ] as ServiceSnapshot[],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toBe(
      "postgres: http://127.0.0.1:54100\n" +
        "api: http://127.0.0.1:4001\n" +
        "web: http://127.0.0.1:3001\n",
    );
  });
});

describe("runUrls — no ports", () => {
  it("prints '(no ports allocated)' and exits 0 when nothing is bound", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        // A service with no allocated_ports field at all.
        {
          name: "migrator",
          kind: "owned",
          state: "ready",
          pid: 99,
        },
        // A service with an empty allocated_ports map.
        {
          name: "seed",
          kind: "owned",
          state: "ready",
          allocated_ports: {},
          pid: 100,
        },
      ],
    }));

    const { exitCode, out, err } = await run();
    expect(exitCode).toBe(0);
    expect(err).toBe("");
    expect(out).toBe("(no ports allocated)\n");
  });

  it("prints '(no ports allocated)' when the services array is empty", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toBe("(no ports allocated)\n");
  });

  it("omits services with no ports but still prints those that do", async () => {
    writeYaml();
    await writeSnap((stackId) => ({
      stack_id: stackId,
      worktree_name: "wt",
      worktree_path: workdir,
      status: "up",
      started_at: "2026-05-23T10:00:00.000Z",
      services: [
        { name: "migrator", kind: "owned", state: "ready", pid: 9 },
        {
          name: "api",
          kind: "owned",
          state: "ready",
          allocated_ports: { PORT: 4002 },
          pid: 10,
        },
      ],
    }));

    const { exitCode, out } = await run();
    expect(exitCode).toBe(0);
    expect(out).toBe("api: http://127.0.0.1:4002\n");
  });
});
