/**
 * Unit tests for `lich routing` (LEV-480).
 *
 * The command reads the daemon URL from `<LICH_HOME>/daemon.url` and
 * fetches `/api/routing`, then renders the result. These tests spin up
 * a minimal `Bun.serve` stub at a known URL to act as the daemon, write
 * the URL into a per-test `LICH_HOME`, and assert on the rendered
 * output / exit codes for each scenario.
 *
 * Coverage:
 *   1. No daemon (no daemon.url file) → exit 1 + stderr hint
 *   2. Daemon URL unreachable → exit 1 + transport error in stderr
 *   3. Daemon returns 503 (no routing table) → exit 1 + clear message
 *   4. Daemon returns 200 with empty array → exit 0 + "no routes"
 *   5. Daemon returns 200 with entries → exit 0 + pretty table
 *   6. --json flag → JSON output, NO table rendering
 *   7. Daemon returns 200 with malformed JSON → exit 1
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runRouting } from "../../../src/commands/routing.js";
import { writeDaemonUrl, clearDaemonUrl } from "../../../src/daemon/pid-file.js";

// ---------------------------------------------------------------------------
// Per-test harness — fresh LICH_HOME + an ephemeral Bun.serve stub.
// ---------------------------------------------------------------------------

let homeDir: string;
let prevHome: string | undefined;
let stub: { stop: () => void; url: string } | null = null;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-routing-cmd-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
});

afterEach(async () => {
  if (stub) {
    stub.stop();
    stub = null;
  }
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
});

/**
 * Stand up a tiny stub server that mimics the daemon's `/api/routing` and
 * `/api/routing/reload` endpoints. Each test specifies the response
 * shape (status code, body) so the assertion paths are tight.
 */
function startStub(
  routingResponse:
    | { status: number; body: string; contentType?: string }
    | "transport-error",
): { url: string } {
  if (routingResponse === "transport-error") {
    // Don't actually start a server. Instead, return a URL that won't
    // accept connections — port 1 is reserved on most systems and
    // refuses cleanly.
    return { url: "http://127.0.0.1:1" };
  }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/routing") {
        return new Response(routingResponse.body, {
          status: routingResponse.status,
          headers: {
            "content-type":
              routingResponse.contentType ?? "application/json; charset=utf-8",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  stub = {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
  return { url: stub.url };
}

function makeStreams(): {
  out: PassThrough;
  err: PassThrough;
  collect: () => { stdout: string; stderr: string };
} {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const out = new PassThrough();
  const err = new PassThrough();
  out.on("data", (b) => outChunks.push(b as Buffer));
  err.on("data", (b) => errChunks.push(b as Buffer));
  return {
    out,
    err,
    collect: () => ({
      stdout: Buffer.concat(outChunks).toString("utf8"),
      stderr: Buffer.concat(errChunks).toString("utf8"),
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. No daemon
// ---------------------------------------------------------------------------

describe("lich routing — no daemon", () => {
  it("returns exit 1 with a hint to run `lich up` when daemon.url is missing", async () => {
    const { out, err, collect } = makeStreams();
    const result = await runRouting({ out, err });
    expect(result.exitCode).toBe(1);
    const { stderr } = collect();
    expect(stderr).toMatch(/no daemon is running/i);
    expect(stderr).toMatch(/lich up/);
  });
});

// ---------------------------------------------------------------------------
// 2. Daemon URL unreachable
// ---------------------------------------------------------------------------

describe("lich routing — daemon unreachable", () => {
  it("returns exit 1 with a transport error when the daemon URL refuses connections", async () => {
    // Point daemon.url at a port that won't answer. fetch should fail
    // with a connection error, which we translate to exit 1.
    const stub = startStub("transport-error");
    await writeDaemonUrl(stub.url);

    const { out, err, collect } = makeStreams();
    const result = await runRouting({ out, err });
    expect(result.exitCode).toBe(1);
    const { stderr } = collect();
    expect(stderr).toMatch(/failed to reach daemon/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Daemon 503
// ---------------------------------------------------------------------------

describe("lich routing — daemon returns 503", () => {
  it("returns exit 1 with a clear message about /api/routing missing", async () => {
    const stub = startStub({
      status: 503,
      body: JSON.stringify({ error: "routing table not configured" }),
    });
    await writeDaemonUrl(stub.url);

    const { out, err, collect } = makeStreams();
    const result = await runRouting({ out, err });
    expect(result.exitCode).toBe(1);
    const { stderr } = collect();
    expect(stderr).toMatch(/does not expose \/api\/routing/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Daemon 200 with empty array
// ---------------------------------------------------------------------------

describe("lich routing — empty routing table", () => {
  it("returns exit 0 and prints 'no routes' when the table is empty", async () => {
    const stub = startStub({
      status: 200,
      body: JSON.stringify([]),
    });
    await writeDaemonUrl(stub.url);

    const { out, err, collect } = makeStreams();
    const result = await runRouting({ out, err });
    expect(result.exitCode).toBe(0);
    const { stdout, stderr } = collect();
    expect(stdout).toMatch(/^no routes/);
    expect(stderr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5. Daemon 200 with entries
// ---------------------------------------------------------------------------

describe("lich routing — pretty table output", () => {
  it("renders a 2-column table sorted by hostname with .lich.localhost suffix", async () => {
    const stub = startStub({
      status: 200,
      body: JSON.stringify([
        { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9020" },
        { hostname: "web.feature-x", upstream_url: "http://127.0.0.1:9028" },
        {
          hostname: "postgres.feature-x",
          upstream_url: "http://127.0.0.1:9023",
        },
      ]),
    });
    await writeDaemonUrl(stub.url);

    const { out, err, collect } = makeStreams();
    const result = await runRouting({ out, err });
    expect(result.exitCode).toBe(0);
    const { stdout, stderr } = collect();
    expect(stderr).toBe("");

    // Header line + 3 entry lines (input order preserved — daemon
    // already returns sorted results; `lich routing` doesn't re-sort
    // because that's the daemon's contract).
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^host\s+→ upstream$/);
    // The .lich.localhost suffix must be appended to each entry.
    expect(stdout).toContain("api.feature-x.lich.localhost");
    expect(stdout).toContain("web.feature-x.lich.localhost");
    expect(stdout).toContain("postgres.feature-x.lich.localhost");
    expect(stdout).toContain("→ http://127.0.0.1:9020");
    expect(stdout).toContain("→ http://127.0.0.1:9028");
    expect(stdout).toContain("→ http://127.0.0.1:9023");

    // Columns aligned: every entry line's arrow lands at the same
    // character offset (so the table reads cleanly).
    const arrowOffsets = lines.slice(1).map((l) => l.indexOf("→"));
    expect(new Set(arrowOffsets).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. --json
// ---------------------------------------------------------------------------

describe("lich routing --json", () => {
  it("emits the entries as JSON on stdout when --json is set", async () => {
    const entries = [
      { hostname: "api.feature-x", upstream_url: "http://127.0.0.1:9020" },
      { hostname: "web.feature-x", upstream_url: "http://127.0.0.1:9028" },
    ];
    const stub = startStub({
      status: 200,
      body: JSON.stringify(entries),
    });
    await writeDaemonUrl(stub.url);

    const { out, err, collect } = makeStreams();
    const result = await runRouting({ json: true, out, err });
    expect(result.exitCode).toBe(0);
    const { stdout, stderr } = collect();
    expect(stderr).toBe("");
    // The output is valid JSON that round-trips to the input entries.
    expect(JSON.parse(stdout)).toEqual(entries);
    // No pretty table noise mixed in: the arrow separator is the
    // table-only formatting; .lich.localhost would only appear in pretty
    // output (raw entries store the bare hostname).
    expect(stdout).not.toContain("→");
    expect(stdout).not.toContain(".lich.localhost");
  });
});

// ---------------------------------------------------------------------------
// 7. Malformed JSON from daemon
// ---------------------------------------------------------------------------

describe("lich routing — malformed daemon response", () => {
  it("returns exit 1 when the daemon returns non-JSON 200", async () => {
    const stub = startStub({
      status: 200,
      body: "<html>oops</html>",
      contentType: "text/html",
    });
    await writeDaemonUrl(stub.url);

    const { out, err, collect } = makeStreams();
    const result = await runRouting({ out, err });
    expect(result.exitCode).toBe(1);
    const { stderr } = collect();
    expect(stderr).toMatch(/failed to parse/i);
  });
});
