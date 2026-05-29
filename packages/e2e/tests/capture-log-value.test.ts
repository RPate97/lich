import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runLich } from "../helpers/lich.js";
import { readStateJson } from "../helpers/state.js";
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

// Synthetic yaml: tunnel_demo emits a URL log line, capture extracts it,
// consumer's env interpolates ${owned.tunnel_demo.captured.listen_url}.
// Literal port (54999) keeps the expected value byte-stable.
const CAPTURE_YAML = `version: "1"
owned:
  tunnel_demo:
    cmd: 'echo "starting"; sleep 0.3; echo "Listening on http://localhost:54999 (demo)"; sleep 99999'
    ready_when:
      log_match: "Listening on"
      capture:
        listen_url: "http://localhost:\\\\d+"

  consumer:
    cmd: 'echo "CONSUMER_TUNNEL_DEMO_URL=\${TUNNEL_DEMO_URL}"; sleep 99999'
    depends_on: [tunnel_demo]
    env:
      TUNNEL_DEMO_URL: "\${owned.tunnel_demo.captured.listen_url}"
    ready_when:
      log_match: "CONSUMER_TUNNEL_DEMO_URL="
`;

function findStackId(lichHome: string): string | null {
  const stacksRoot = join(lichHome, "stacks");
  if (!existsSync(stacksRoot)) return null;
  const entries = readdirSync(stacksRoot);
  if (entries.length === 0) return null;
  return entries[0];
}

describe("ready_when.capture threads a log value into a downstream service", () => {
  it(
    "consumer's per-service env interpolates ${owned.tunnel_demo.captured.listen_url}",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-capture-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-capture-home-"));

      try {
        writeFileSync(join(dir, "lich.yaml"), CAPTURE_YAML, "utf8");

        const upResult = runLich(["up", "--no-browser"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 60_000,
        });
        if (upResult.exitCode !== 0) {
          // eslint-disable-next-line no-console
          console.error("lich up stdout:\n" + upResult.stdout);
          // eslint-disable-next-line no-console
          console.error("lich up stderr:\n" + upResult.stderr);
        }
        expect(
          upResult.exitCode,
          `lich up should succeed; stderr was:\n${upResult.stderr}`,
        ).toBe(0);

        // Load-bearing: consumer's log must contain the captured URL,
        // proving the captured value reached its spawn env.
        const logsResult = runLich(
          ["logs", "consumer", "--no-follow"],
          {
            cwd: dir,
            env: { LICH_HOME: home },
            timeout: 10_000,
          },
        );
        expect(logsResult.exitCode).toBe(0);
        expect(logsResult.stdout).toContain(
          "CONSUMER_TUNNEL_DEMO_URL=http://localhost:54999",
        );

        const stackId = findStackId(home);
        expect(stackId).not.toBeNull();
        const snap = readStateJson(home, stackId!);
        expect(snap).not.toBeNull();
        const services = Object.fromEntries(
          snap!.services.map((s) => [s.name, s.state]),
        );
        expect(services.tunnel_demo).toBe("ready");
        expect(services.consumer).toBe("ready");
      } finally {
        try {
          spawnSync(lichBinary, ["down"], {
            cwd: dir,
            env: { ...process.env, LICH_HOME: home },
            timeout: 30_000,
            encoding: "utf8",
          });
        } catch {
          /* best-effort */
        }
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        try {
          rmSync(home, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
    90_000,
  );
});
