import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { runLich } from "../helpers/lich.js";
import { LICH_BINARY } from "@/helpers/paths.js";

const TEST_LABEL_KEY = "com.lich.test.owned-containers";

function dockerContainerExists(id: string): boolean {
  const result = spawnSync(
    "docker",
    ["ps", "-a", "--filter", `id=${id}`, "--format", "{{.ID}}"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0) return false;
  return (result.stdout ?? "").trim().length > 0;
}

function dockerRmF(id: string): void {
  spawnSync("docker", ["rm", "-f", id], { encoding: "utf8", timeout: 10_000 });
}

interface CleanupRef {
  tmpPath: string | null;
  lichHome: string | null;
  containerIds: string[];
}

const ref: CleanupRef = { tmpPath: null, lichHome: null, containerIds: [] };

afterEach(() => {
  if (ref.lichHome !== null && ref.tmpPath !== null) {
    try {
      runLich(["nuke", "--yes"], {
        cwd: ref.tmpPath,
        env: { LICH_HOME: ref.lichHome },
        timeout: 20_000,
      });
    } catch {
      /* best-effort */
    }
  }
  for (const id of ref.containerIds) {
    dockerRmF(id);
  }
  if (ref.tmpPath !== null) {
    try {
      rmSync(ref.tmpPath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  ref.tmpPath = null;
  ref.lichHome = null;
  ref.containerIds = [];
});

describe(
  "owned_containers sweep cleans up survivors after stop_cmd",
  () => {
    beforeAll(() => {
      if (!existsSync(LICH_BINARY)) {
        throw new Error(
          `lich binary not found at ${LICH_BINARY}. Run \`cd packages/lich && bun run build\` first.`,
        );
      }
      // Pre-check the test image so the per-test `docker run` calls don't fail on slow networks.
      // We don't pull here — the fast-pool hookTimeout is 20s and a cold pull can blow past that.
      // Instead, fail fast with a clear error pointing at `docker pull alpine:3`.
      const inspect = spawnSync("docker", ["image", "inspect", "alpine:3"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      if (inspect.status !== 0) {
        throw new Error(
          `alpine:3 not present in local docker. Run \`docker pull alpine:3\` once and re-run this test.`,
        );
      }
    }, 15_000);

    it(
      "lich down force-removes a labeled container the user's stop_cmd ignored",
      () => {
        const tmpPath = mkdtempSync(join(tmpdir(), "lich-e2e-owned-containers-"));
        ref.tmpPath = tmpPath;
        ref.lichHome = join(tmpPath, ".lich");

        // Unique label value per test run so parallel suites don't trip on each other.
        const labelValue = `sweep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Start the container BEFORE lich up so the cmd doesn't need docker access.
        // The oneshot's cmd just echoes; stop_cmd echoes too — neither touches the container.
        // The point: stop_cmd ignored the container, owned_containers sweep should reap it.
        const runResult = spawnSync(
          "docker",
          [
            "run",
            "-d",
            "--rm",
            "--label",
            `${TEST_LABEL_KEY}=${labelValue}`,
            "alpine:3",
            "sleep",
            "300",
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        if (runResult.status !== 0) {
          throw new Error(
            `docker run failed (exit ${runResult.status}):\nstdout: ${runResult.stdout}\nstderr: ${runResult.stderr}`,
          );
        }
        const containerId = (runResult.stdout ?? "").trim();
        expect(containerId).toMatch(/^[0-9a-f]{12,}$/);
        ref.containerIds.push(containerId);

        expect(dockerContainerExists(containerId)).toBe(true);

        const yamlContent =
          `version: "1"\n` +
          `owned:\n` +
          `  fake-supabase:\n` +
          `    cmd: "true"\n` +
          `    oneshot: true\n` +
          `    stop_cmd: "echo stop_cmd ran but does not touch the container"\n` +
          `    owned_containers:\n` +
          `      label: ${TEST_LABEL_KEY}=${labelValue}\n`;
        writeFileSync(join(tmpPath, "lich.yaml"), yamlContent, "utf8");

        const env = { LICH_HOME: ref.lichHome };

        const upResult = runLich(["up"], {
          cwd: tmpPath,
          env,
          timeout: 60_000,
        });
        if (upResult.exitCode !== 0) {
          throw new Error(
            `lich up failed (exit ${upResult.exitCode}).\nstdout:\n${upResult.stdout}\nstderr:\n${upResult.stderr}`,
          );
        }

        // sanity: container is still there after `lich up` (the cmd didn't kill it)
        expect(dockerContainerExists(containerId)).toBe(true);

        const downResult = runLich(["down"], {
          cwd: tmpPath,
          env,
          timeout: 60_000,
        });
        expect(downResult.exitCode).toBe(0);

        // The sweep should have reaped the container.
        expect(
          dockerContainerExists(containerId),
          `expected container ${containerId} (label ${TEST_LABEL_KEY}=${labelValue}) to be gone after lich down, but it still exists. lich down stdout:\n${downResult.stdout}\nstderr:\n${downResult.stderr}`,
        ).toBe(false);

        // Warning surfaced through the down warning channel so the user can see the sweep happened.
        expect(downResult.stdout).toMatch(/owned_containers sweep removed/i);
      },
      120_000,
    );

    it(
      "lich nuke also reaps owned_containers survivors",
      () => {
        const tmpPath = mkdtempSync(join(tmpdir(), "lich-e2e-owned-containers-nuke-"));
        ref.tmpPath = tmpPath;
        ref.lichHome = join(tmpPath, ".lich");

        const labelValue = `nuke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const runResult = spawnSync(
          "docker",
          [
            "run",
            "-d",
            "--rm",
            "--label",
            `${TEST_LABEL_KEY}=${labelValue}`,
            "alpine:3",
            "sleep",
            "300",
          ],
          { encoding: "utf8", timeout: 30_000 },
        );
        if (runResult.status !== 0) {
          throw new Error(
            `docker run failed (exit ${runResult.status}):\nstdout: ${runResult.stdout}\nstderr: ${runResult.stderr}`,
          );
        }
        const containerId = (runResult.stdout ?? "").trim();
        ref.containerIds.push(containerId);
        expect(dockerContainerExists(containerId)).toBe(true);

        const yamlContent =
          `version: "1"\n` +
          `owned:\n` +
          `  fake-supabase:\n` +
          `    cmd: "true"\n` +
          `    oneshot: true\n` +
          `    stop_cmd: "echo stop_cmd ran but does not touch the container"\n` +
          `    owned_containers:\n` +
          `      label: ${TEST_LABEL_KEY}=${labelValue}\n`;
        writeFileSync(join(tmpPath, "lich.yaml"), yamlContent, "utf8");

        const env = { LICH_HOME: ref.lichHome };

        const upResult = runLich(["up"], {
          cwd: tmpPath,
          env,
          timeout: 60_000,
        });
        if (upResult.exitCode !== 0) {
          throw new Error(
            `lich up failed (exit ${upResult.exitCode}).\nstdout:\n${upResult.stdout}\nstderr:\n${upResult.stderr}`,
          );
        }
        expect(dockerContainerExists(containerId)).toBe(true);

        const nukeResult = runLich(["nuke", "--yes"], {
          cwd: tmpPath,
          env,
          timeout: 60_000,
        });
        expect(nukeResult.exitCode).toBe(0);

        expect(
          dockerContainerExists(containerId),
          `expected container ${containerId} to be gone after lich nuke. nuke stdout:\n${nukeResult.stdout}\nstderr:\n${nukeResult.stderr}`,
        ).toBe(false);
      },
      120_000,
    );
  },
);
