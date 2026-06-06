import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
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
  stub: Server | null;
  stubPort: number | null;
}

let fixture: Fixture | null = null;

// Bind to 0.0.0.0 so the allocator's exclusive probe collides regardless of interface.
function startStubOnFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolveFn, rejectFn) => {
    const server = createServer((sock) => {
      sock.end();
    });
    server.once("error", rejectFn);
    server.listen({ port: 0, host: "0.0.0.0", exclusive: true }, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        rejectFn(
          new Error(`unexpected server.address() shape: ${JSON.stringify(addr)}`),
        );
        return;
      }
      resolveFn({ server, port: addr.port });
    });
  });
}

function stopStub(server: Server): Promise<void> {
  return new Promise((resolveFn) => {
    server.close(() => resolveFn());
  });
}

afterEach(async () => {
  if (!fixture) return;
  const fix = fixture;
  fixture = null;

  if (fix.stub) {
    try {
      await stopStub(fix.stub);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`afterEach stub close failed:`, err);
    }
  }

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
});

describe("lich up — port already in use on a pinned owned port", () => {
  it(
    "fails fast and names the conflicted port",
    async () => {
      const { server: stub, port: stubPort } = await startStubOnFreePort();

      // install: false — failure fires before any owned service spawns
      const stack = copyExampleToTmpdir("dogfood-stack");
      const lichHome = mkdtempSync(
        join(tmpdir(), "lich-e2e-port-in-use-home-"),
      );
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome,
        stub,
        stubPort,
      };

      // Both api + web share `port: { published_env: PORT }`; anchor on api's prefix.
      const lichYamlPath = join(stack.path, "lich.yaml");
      const original = readFileSync(lichYamlPath, "utf8");
      const needle = "cwd: apps/api\n    port: { published_env: PORT }";
      const occurrences = original.split(needle).length - 1;
      expect(
        occurrences,
        `expected exactly one occurrence of the api block's port descriptor ` +
          `(\`${needle.replaceAll("\n", "\\n")}\`) in dogfood-stack/lich.yaml; ` +
          `got ${occurrences}. Did the api block's formatting change? ` +
          `Update this test's mutation to match.`,
      ).toBe(1);
      const mutated = original.replace(
        needle,
        `cwd: apps/api\n    port: { published_env: PORT, host_port: ${stubPort} }`,
      );
      writeFileSync(lichYamlPath, mutated, "utf8");

      const result = runLich(["up", "--no-browser"], {
        cwd: stack.path,
        env: { LICH_HOME: lichHome },
        timeout: 30_000,
      });

      if (result.exitCode === 0) {
        // eslint-disable-next-line no-console
        console.error("unexpected lich up success — stdout:", result.stdout);
        // eslint-disable-next-line no-console
        console.error("unexpected lich up success — stderr:", result.stderr);
      }
      expect(
        result.exitCode,
        `lich up should fail when port ${stubPort} is held by another process`,
      ).not.toBe(0);

      // Accept any of several phrasings; contract is "port + conflict named"
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(
        combined,
        `expected output to mention the conflicted port ${stubPort}; got:\n${combined}`,
      ).toContain(String(stubPort));

      const conflictPhrase = /in use|EADDRINUSE|already (?:reserved|held|in use)/i;
      expect(
        conflictPhrase.test(combined),
        `expected output to mention a port conflict (one of: "in use" / "EADDRINUSE" / ` +
          `"already reserved|held|in use"); got:\n${combined}`,
      ).toBe(true);
    },
    45_000,
  );
});
