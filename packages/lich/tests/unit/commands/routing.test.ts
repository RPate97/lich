import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runRouting } from "../../../src/commands/routing.js";
import { writeDaemonUrl, clearDaemonUrl } from "../../../src/daemon/pid-file.js";

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

function startStub(
  routingResponse:
    | { status: number; body: string; contentType?: string }
    | "transport-error",
): { url: string } {
  if (routingResponse === "transport-error") {
    // port 1 is reserved and refuses connections cleanly
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

describe("lich routing — daemon unreachable", () => {
  it("returns exit 1 with a transport error when the daemon URL refuses connections", async () => {
    const stub = startStub("transport-error");
    await writeDaemonUrl(stub.url);

    const { out, err, collect } = makeStreams();
    const result = await runRouting({ out, err });
    expect(result.exitCode).toBe(1);
    const { stderr } = collect();
    expect(stderr).toMatch(/failed to reach daemon/i);
  });
});

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

    // header + 3 entries (daemon already sorts; cmd doesn't re-sort)
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^host\s+→ upstream$/);
    expect(stdout).toContain("api.feature-x.lich.localhost");
    expect(stdout).toContain("web.feature-x.lich.localhost");
    expect(stdout).toContain("postgres.feature-x.lich.localhost");
    expect(stdout).toContain("→ http://127.0.0.1:9020");
    expect(stdout).toContain("→ http://127.0.0.1:9028");
    expect(stdout).toContain("→ http://127.0.0.1:9023");

    // arrow at the same offset on every entry line — columns aligned
    const arrowOffsets = lines.slice(1).map((l) => l.indexOf("→"));
    expect(new Set(arrowOffsets).size).toBe(1);
  });
});

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
    expect(JSON.parse(stdout)).toEqual(entries);
    // no table noise — arrow + .lich.localhost are pretty-output-only
    expect(stdout).not.toContain("→");
    expect(stdout).not.toContain(".lich.localhost");
  });
});

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
