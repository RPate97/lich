import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { parseLichUrls } from "../helpers/urls.js";
import { readStateJson, waitForStackStatus } from "../helpers/state.js";
import { waitForDaemonRunning } from "../helpers/daemon.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { LICH_BINARY as lichBinary, REPO_ROOT as repoRoot } from "@/helpers/paths.js";

beforeAll(() => {
  if (existsSync(lichBinary)) return;
  const build = spawnSync("bun", ["run", "build"], {
    cwd: resolve(repoRoot, "packages/lich"),
    stdio: "inherit",
    timeout: 120_000,
  });
  if (build.status !== 0) {
    throw new Error(
      `failed to build lich binary (exit ${build.status}); cannot run e2e tests`,
    );
  }
  if (!existsSync(lichBinary)) {
    throw new Error(
      `lich build reported success but ${lichBinary} does not exist`,
    );
  }
});

interface Fixture {
  stackPath: string;
  stackCleanup: () => void;
  lichHome: string;
}

let fixture: Fixture | null = null;

function makeFixture(): Fixture {
  // install: true — apps/web runs `next dev`, needs `next` in node_modules/.bin
  const stack = copyExampleToTmpdir("dogfood-stack", { install: true });
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-basic-up-home-"));
  return {
    stackPath: stack.path,
    stackCleanup: stack.cleanup,
    lichHome: home,
  };
}

function teardownFixture(fix: Fixture): void {
  try {
    runLich(["down"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach lich down failed for ${fix.stackPath}:`, err);
  }
  // nuke --yes kills the daemon; otherwise it holds the proxy port (3300)
  // and the next test's `lich up` can't bind it.
  try {
    runLich(["nuke", "--yes"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
      timeout: 20_000,
    });
  } catch {
    /* best-effort */
  }
  try {
    fix.stackCleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach tmpdir cleanup failed for ${fix.stackPath}:`, err);
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`afterEach LICH_HOME cleanup failed for ${fix.lichHome}:`, err);
  }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

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
  if (entries.length === 0) return null;
  return entries[0];
}

/** True if a TCP connect to localhost:port succeeds within ~1s. */
function tcpListening(port: number): Promise<boolean> {
  return new Promise((res) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 1000 });
    socket.on("connect", () => {
      socket.end();
      res(true);
    });
    socket.on("error", () => res(false));
    socket.on("timeout", () => {
      socket.destroy();
      res(false);
    });
  });
}

/**
 * Probe the lich proxy via a raw HTTP/1.1 socket. Required instead of `fetch()`
 * because undici silently strips the `Host` header (WHATWG forbidden headers).
 */
async function fetchViaProxy(
  ip: string,
  port: number,
  hostHeader: string,
  path: string = "/",
): Promise<Response> {
  const { Socket } = await import("node:net");
  return new Promise<Response>((resolve, reject) => {
    const socket = new Socket();
    let buf = Buffer.alloc(0);
    socket.setTimeout(10_000);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
    });
    socket.on("end", () => {
      try {
        resolve(parseHttpResponse(buf));
      } catch (err) {
        reject(err);
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      if (buf.length > 0) {
        try {
          resolve(parseHttpResponse(buf));
          return;
        } catch {
          /* fall through */
        }
      }
      reject(new Error(`proxy probe timeout: ${hostHeader}${path}`));
    });
    socket.on("error", (err) => reject(err));
    socket.connect(port, ip, () => {
      const req =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        `Connection: close\r\n` +
        `\r\n`;
      socket.write(req);
    });
  });
}

/** Minimal HTTP/1.1 response parser; decodes chunked transfer-encoding. */
function parseHttpResponse(raw: Buffer): Response {
  const sep = raw.indexOf("\r\n\r\n");
  const headerEnd = sep >= 0 ? sep : raw.length;
  const headerBlock = raw.subarray(0, headerEnd).toString("utf8");
  const rawBody = sep >= 0 ? raw.subarray(sep + 4) : Buffer.alloc(0);
  const [statusLine, ...headerLines] = headerBlock.split("\r\n");
  const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
  if (!m) {
    throw new Error(
      `unparseable HTTP response line: ${JSON.stringify(statusLine)}`,
    );
  }
  const status = parseInt(m[1], 10);
  const headers = new Headers();
  let chunked = false;
  for (const line of headerLines) {
    const ci = line.indexOf(":");
    if (ci > 0) {
      const name = line.slice(0, ci).trim();
      const value = line.slice(ci + 1).trim();
      headers.append(name, value);
      if (
        name.toLowerCase() === "transfer-encoding" &&
        /\bchunked\b/i.test(value)
      ) {
        chunked = true;
      }
    }
  }
  const body = chunked ? decodeChunkedBody(rawBody) : rawBody;
  return new Response(body, { status, headers });
}

/** Decode an HTTP/1.1 chunked-transfer-encoding body. */
function decodeChunkedBody(raw: Buffer): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const crlf = raw.indexOf("\r\n", pos);
    if (crlf < 0) break;
    const sizeHex = raw.subarray(pos, crlf).toString("utf8");
    const size = parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size < 0) break;
    pos = crlf + 2;
    if (size === 0) break;
    out.push(raw.subarray(pos, pos + size));
    pos += size + 2; // skip chunk + trailing \r\n
  }
  return Buffer.concat(out);
}

describe("lich validate against dogfood-stack", () => {
  it("exits 0 with no stderr for the target yaml", () => {
    fixture = makeFixture();
    const result = runLich(["validate"], {
      cwd: fixture.stackPath,
      env: { LICH_HOME: fixture.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("validate stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("validate stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("lich up against dogfood-stack (Plan 1 basic flow)", () => {
  it(
    "brings the stack up, serves raw URLs, then lich down cleans up",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up --no-browser (dev:fast — api + web on host)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snap.status).toBe("up");
      const serviceNames = snap.services.map((s) => s.name).sort();
      expect(serviceNames).toEqual(["api", "web"]);

      // --raw sidesteps the friendly-URL proxy path. Friendly URLs race
      // against the routing watcher's debounce on a fast (~3s) up.
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      expect(Object.keys(urls).sort()).toEqual(
        expect.arrayContaining(["api", "web"]),
      );

      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      step(`probing api /health (${apiUrl})`);
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 10_000 });
      await expectDbMode(apiUrl!, "stub");
      const health = await fetch(`${apiUrl}/health`).then((r) => r.json());
      expect(health).toMatchObject({ status: "ok", db: "stub" });

      const webUrl = urls.web;
      expect(webUrl, `expected web url in: ${urlsResult.stdout}`).toBeTruthy();
      step(`probing web / (${webUrl})`);
      await waitForHttp200(webUrl!, { timeoutMs: 20_000 }); // Next.js cold compile ~3-8s
      step("all probes 200 OK");
      const webResp = await fetch(webUrl!);
      expect(webResp.status).toBe(200);
      const webBody = await webResp.text();
      expect(webBody.toLowerCase()).toMatch(/<!doctype html|_next|next/);

      const allocatedPorts: number[] = [];
      for (const svc of snap.services) {
        if (!svc.allocated_ports) continue;
        for (const p of Object.values(svc.allocated_ports)) {
          allocatedPorts.push(p);
        }
      }
      expect(allocatedPorts.length).toBeGreaterThanOrEqual(2);

      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      expect(downResult.exitCode).toBe(0);

      const downSnap = readStateJson(lichHome, stackId!);
      expect(downSnap?.status).toBe("stopped");

      // brief grace for sockets to release
      await new Promise<void>((r) => setTimeout(r, 2_000));
      for (const port of allocatedPorts) {
        const stillUp = await tcpListening(port);
        expect(stillUp, `port ${port} still listening after lich down`).toBe(
          false,
        );
      }
    },
    300_000,
  );

  it(
    "serves the web app over http://web.<worktree>.lich.localhost:3300/ (friendly URL)",
    async () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up --no-browser (dev:fast — api + web boot ~2-3s)");
      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 60_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up stderr:", upResult.stderr);
      }
      expect(upResult.exitCode).toBe(0);
      step("lich up exit 0");

      const stackId = findStackId(lichHome);
      expect(stackId).not.toBeNull();
      const snap = await waitForStackStatus(lichHome, stackId!, "up", {
        timeoutMs: 10_000,
      });
      expect(snap.status).toBe("up");
      const worktreeName = snap.worktree_name;
      expect(
        worktreeName,
        "snapshot must record worktree_name for friendly-URL hostnames",
      ).toBeTruthy();

      // daemon-auto-start in `lich up` is best-effort; assert it here.
      step("waiting for daemon pid + url files");
      const daemon = await waitForDaemonRunning(lichHome, {
        timeoutMs: 30_000,
      });
      step(`daemon alive: pid=${daemon.pid} url=${daemon.url}`);

      const urlsResult = runLich(["urls", "--raw"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const rawUrls = parseLichUrls(urlsResult.stdout);
      const rawWebUrl = rawUrls.web;
      expect(
        rawWebUrl,
        `expected raw web url in: ${urlsResult.stdout}`,
      ).toBeTruthy();

      const rawApiUrl = rawUrls.api;
      expect(rawApiUrl, `expected raw api url in: ${urlsResult.stdout}`).toBeTruthy();
      await waitForHttp200(`${rawApiUrl}/health`, { timeoutMs: 10_000 });
      await expectDbMode(rawApiUrl!, "stub");

      step(`probing raw web / (${rawWebUrl})`);
      await waitForHttp200(rawWebUrl!, { timeoutMs: 20_000 }); // Next.js cold compile ~3-8s
      const rawBody = await fetch(rawWebUrl!).then((r) => r.text());
      expect(rawBody.toLowerCase()).toMatch(/<!doctype html|_next|next/);

      const proxyPort = 3300;
      const friendlyHost = `web.${worktreeName}.lich.localhost`;
      const friendlyUrl = `http://${friendlyHost}:${proxyPort}/`;

      step(`probing friendly URL: ${friendlyUrl}`);

      const deadline = Date.now() + 15_000;
      let lastErr: unknown = null;
      let friendlyRes: Response | null = null;
      let chosenProbe: string | null = null;
      // Probe both IPv4 and IPv6 loopback. Bun.serve with hostname:"localhost"
      // binds only one family per process depending on resolver order.
      const probeHosts: Array<{ ip: string; label: string }> = [
        { ip: "127.0.0.1", label: "http://127.0.0.1" },
        { ip: "::1", label: "http://[::1]" },
      ];
      outer: while (Date.now() < deadline) {
        for (const probe of probeHosts) {
          try {
            const res = await fetchViaProxy(
              probe.ip,
              proxyPort,
              `${friendlyHost}:${proxyPort}`,
              "/",
            );
            if (res.status === 200) {
              friendlyRes = res;
              chosenProbe = `${probe.label}:${proxyPort}/`;
              break outer;
            }
            lastErr = new Error(
              `${probe.label}:${proxyPort}/ (Host=${friendlyHost}) returned ${res.status} — body: ${(await res.text()).slice(0, 1000)}`,
            );
          } catch (err) {
            lastErr = new Error(
              `${probe.label}:${proxyPort}/ (Host=${friendlyHost}) probe threw: ${(err as Error).message}`,
            );
          }
        }
        await new Promise<void>((r) => setTimeout(r, 250));
      }
      if (!friendlyRes) {
        throw new Error(
          `friendly URL ${friendlyUrl} never returned 200 within 15s. ` +
            `Tried IPv4 and IPv6 loopback. ` +
            `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        );
      }
      expect(friendlyRes.status).toBe(200);
      step(`friendly URL 200 OK via ${chosenProbe}`);

      const friendlyBody = await friendlyRes.text();
      expect(friendlyBody.toLowerCase()).toMatch(/<!doctype html|_next|next/);

      // proxy transparency: bodies match within a few KB
      const sizeDelta = Math.abs(friendlyBody.length - rawBody.length);
      expect(
        sizeDelta,
        `friendly body (${friendlyBody.length}B) and raw body (${rawBody.length}B) differ by ${sizeDelta}B — proxy may not be transparent`,
      ).toBeLessThan(2_000);

      // In-body teardown keeps afterEach fast (avoids 60s hookTimeout).
      step("lich down (in-body teardown)");
      const downResult = runLich(["down"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 120_000,
      });
      if (downResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich down stdout:", downResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich down stderr:", downResult.stderr);
      }
      expect(downResult.exitCode).toBe(0);
      step("lich down exit 0");
    },
    300_000,
  );
});
