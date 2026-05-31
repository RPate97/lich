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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyFixtureToTmpdir } from "../helpers/tmpdir.js";
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
}

let fixture: Fixture | null = null;

// server.mjs: bind $PORT and stay alive so lich can probe it.
const SERVER_MJS = `
import { createServer } from "node:net";
const port = Number(process.env.PORT);
createServer().listen(port, "127.0.0.1");
`;

// ready_when.tcp uses bare ${owned.server.port} (interpolates to e.g. "3002")
// to exercise the fix — validate accepts it and runtime connects to localhost:<port>.
function makeLichYaml(stackPath: string): string {
  return `version: "1"

owned:
  server:
    cmd: node server.mjs
    cwd: ${stackPath}
    port: { published_env: PORT }
    ready_when:
      tcp: "\${owned.server.port}"
      timeout: 10s
`;
}

function makeFixture(): Fixture {
  const stack = copyFixtureToTmpdir("dogfood-stack");
  writeFileSync(join(stack.path, "server.mjs"), SERVER_MJS, "utf8");
  writeFileSync(join(stack.path, "lich.yaml"), makeLichYaml(stack.path), "utf8");
  const home = mkdtempSync(join(tmpdir(), "lich-e2e-ready-tcp-bare-port-home-"));
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
      timeout: 30_000,
    });
  } catch {
    // best-effort
  }
  try {
    fix.stackCleanup();
  } catch {
    // best-effort
  }
  try {
    rmSync(fix.lichHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

afterEach(() => {
  if (!fixture) return;
  teardownFixture(fixture);
  fixture = null;
});

describe("ready_when.tcp — bare port acceptance", () => {
  it(
    "validate passes and lich up succeeds when tcp target is a bare port number",
    () => {
      fixture = makeFixture();
      const { stackPath, lichHome } = fixture;

      const validateResult = runLich(["validate"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
      });
      expect(
        validateResult.exitCode,
        `validate failed:\n${validateResult.stdout}\n${validateResult.stderr}`,
      ).toBe(0);

      const upResult = runLich(["up", "--no-browser"], {
        cwd: stackPath,
        env: { LICH_HOME: lichHome },
        timeout: 20_000,
      });

      expect(
        upResult.exitCode,
        `lich up failed:\n${upResult.stdout}\n${upResult.stderr}`,
      ).toBe(0);
    },
    30_000,
  );
});
