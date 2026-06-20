import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

// producer captures a URL from its ready log line; consumer (depends_on producer)
// interpolates ${owned.producer.captured.url} into its own cmd. Under graph
// scheduling the consumer starts only after the producer is ready, so the capture
// is guaranteed to be available when the consumer's cmd is resolved.
// producer publishes a port so it is present in the interpolation context (cmd
// refs resolve against allocated-port owned services); it echoes its real
// allocated URL, and ready_when.capture grabs it.
const FIXTURE_YAML = `version: "1"
owned:
  producer:
    cmd: 'echo "URL=http://localhost:\${PORT}"; echo READY; sleep 99999'
    port:
      published_env: PORT
    ready_when:
      log_match: READY
      capture:
        url: "http://localhost:\\\\d+"
  consumer:
    depends_on: [producer]
    cmd: 'echo "GOT=\${owned.producer.captured.url}"; echo READY; sleep 99999'
    ready_when:
      log_match: READY
`;

describe("graph scheduler — threads a declared dependency's capture to the dependent", () => {
  it(
    "consumer sees producer's ready_when capture via ${owned.producer.captured.url}",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lich-e2e-graph-capture-"));
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-graph-capture-home-"));

      try {
        writeFileSync(join(dir, "lich.yaml"), FIXTURE_YAML, "utf8");

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

        const producerLogs = runLich(["logs", "producer", "--no-follow"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 10_000,
        });
        expect(producerLogs.exitCode).toBe(0);
        const producerUrl = producerLogs.stdout.match(
          /URL=(http:\/\/localhost:\d+)/,
        )?.[1];
        expect(producerUrl, "producer never logged its URL").toBeDefined();

        const consumerLogs = runLich(["logs", "consumer", "--no-follow"], {
          cwd: dir,
          env: { LICH_HOME: home },
          timeout: 10_000,
        });
        expect(consumerLogs.exitCode).toBe(0);
        // The captured value threaded into the dependent must equal the
        // producer's actual URL — proves graph scheduling threads the dep's
        // ready_when capture to the dependent's cmd interpolation.
        expect(
          consumerLogs.stdout,
          "consumer did not receive the producer's captured url",
        ).toContain(`GOT=${producerUrl}`);
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
        for (const p of [dir, home]) {
          try {
            rmSync(p, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
      }
    },
    90_000,
  );
});
