import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isTartAvailable, imageExists } from "../../helpers/tart.js";
import { waitForDaemonRunning } from "../../helpers/daemon.js";

const _here = dirname(fileURLToPath(import.meta.url));
const LICH_BIN = resolve(_here, "../../../../lich/dist/lich");
const IMAGE = process.env.LICH_SANDBOX_TEST_IMAGE ?? "lich-sandbox-base";

const LICH_YAML = `version: "1"
runtime:
  sandbox:
    backend: tart
    image: ${IMAGE}
    bake_inputs:
      - "src/**"
profiles:
  "dev:box":
    default: true
    owned: [web]
owned:
  web:
    cmd: "python3 -m http.server 8088"
    cwd: "."
    ready_when:
      http: "http://localhost:8088/"
      timeout: 60s
`;

function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const entries = readdirSync(stacksRoot).filter((name) => {
    try {
      return statSync(join(stacksRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  return entries.length > 0 ? entries[0] : null;
}

describe.skipIf(!isTartAvailable() || !imageExists())("sandbox dashboard metrics + proc-tree proxy (e2e)", () => {
  let projectDir: string;
  let lichHome: string;
  let stackId: string;
  let dashboardUrl: string;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "lich-e2e-dash-proxy-"));
    lichHome = mkdtempSync(join(tmpdir(), "lich-e2e-dash-proxy-home-"));

    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "index.html"), "<html><body>hello</body></html>");
    writeFileSync(join(projectDir, "lich.yaml"), LICH_YAML);

    const result = spawnSync(LICH_BIN, ["up", "dev:box", "--no-browser"], {
      cwd: projectDir,
      env: { ...process.env, LICH_HOME: lichHome, LICH_NO_BROWSER: "1" },
      encoding: "utf8",
      timeout: 300_000,
    });

    if (result.status !== 0) {
      throw new Error(
        `lich up failed (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }

    const foundId = findStackId(lichHome);
    if (!foundId) {
      throw new Error("no stack state.json found after lich up");
    }
    stackId = foundId;

    const daemon = await waitForDaemonRunning(lichHome, { timeoutMs: 30_000 });
    dashboardUrl = daemon.url;
  }, 360_000);

  afterAll(async () => {
    try {
      spawnSync(LICH_BIN, ["down", "--purge"], {
        cwd: projectDir,
        env: { ...process.env, LICH_HOME: lichHome },
        encoding: "utf8",
        timeout: 60_000,
      });
    } catch {
      // best-effort
    }
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(lichHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 90_000);

  test("metrics endpoint proxies CPU/mem shape from in-VM sampler", async () => {
    // Allow the in-VM sampler at least one fire cycle before querying.
    await new Promise((r) => setTimeout(r, 6_000));

    const res = await fetch(`${dashboardUrl}/api/stacks/${stackId}/metrics`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.stack_id).toBeTruthy();
    expect(body.total).toBeDefined();
    const total = body.total as Record<string, unknown>;
    // Values may be zero in the warmup window — shape presence is what matters.
    expect(typeof total.cpu_pct).toBe("number");
    expect(typeof total.mem_bytes).toBe("number");
  }, 30_000);

  test("metrics/stream emits at least 2 SSE frames within 12 s", async () => {
    const controller = new AbortController();
    const res = await fetch(`${dashboardUrl}/api/stacks/${stackId}/metrics/stream`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const deadline = Date.now() + 12_000;

    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
      // SSE events are separated by double-newline; count "data:" lines as a
      // proxy for frame count (both real data frames and the leading heartbeat
      // comment are separated by double-newline).
      const frameMatches = received.match(/^data:/gm) ?? [];
      if (frameMatches.length >= 2) break;
    }

    controller.abort();
    reader.cancel().catch(() => {});

    const frameCount = (received.match(/^data:/gm) ?? []).length;
    expect(frameCount).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("proc-tree endpoint returns a TreeAggregate for the python http.server", async () => {
    const res = await fetch(
      `${dashboardUrl}/api/stacks/${stackId}/services/web/proc-tree`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // Shape: { service, pid, process_count, mem_bytes, cpu_pct_cumulative, tree }
    expect(body.service).toBe("web");
    expect(typeof body.pid).toBe("number");
    expect(body.pid).toBeGreaterThan(0);
    expect(typeof body.process_count).toBe("number");
    expect(body.process_count).toBeGreaterThanOrEqual(1);
    // tree is the root ProcessNode (may be null only if the pid isn't in ps output yet)
    expect(body.tree !== undefined).toBe(true);
  }, 30_000);
});
