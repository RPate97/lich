import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { copyExampleToTmpdir } from "../helpers/tmpdir.js";
import { runLich } from "../helpers/lich.js";
import { waitForHttp200 } from "../helpers/wait.js";
import { expectDbMode } from "../helpers/dbmode.js";
import { parseLichUrls } from "../helpers/urls.js";
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

interface StacksJsonRow {
  stack_id: string;
  worktree_name: string;
  status: string;
  active_profile?: string;
  services?: Array<{ name: string; kind: string; state: string }>;
}

describe("dev:lite profile activates [api, postgres, web] only (LEV-474)", () => {
  it(
    "(setup) brings up the dogfood-stack under the `dev:lite` profile",
    async () => {
      const stack = copyExampleToTmpdir("dogfood-stack", {
        prefix: "lich-e2e-dev-lite-",
        install: true,
      });
      const home = mkdtempSync(join(tmpdir(), "lich-e2e-dev-lite-home-"));
      fixture = {
        stackPath: stack.path,
        stackCleanup: stack.cleanup,
        lichHome: home,
      };

      const t0 = Date.now();
      const step = (label: string): void => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stderr.write(`  [+${elapsed}s] ${label}\n`);
      };

      step("lich up dev:lite (postgres + api + web; NO tunnel_demo/health_probe)");
      const upResult = runLich(["up", "dev:lite", "--no-browser"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
        // dev:lite still runs postgres + after_up psql migrations, so use
        // the same 4-minute compose-pool ceiling as profiles-lifecycle-scoping.
        timeout: 240_000,
      });
      if (upResult.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error("lich up dev:lite stdout:", upResult.stdout);
        // eslint-disable-next-line no-console
        console.error("lich up dev:lite stderr:", upResult.stderr);
        throw new Error(
          `lich up dev:lite exited ${upResult.exitCode}; cannot proceed with service-set assertion`,
        );
      }
      step("lich up dev:lite exit 0");

      // Probe /health and verify db: "live" — proves postgres + the
      // after_up psql migration ran under dev:lite, not just that `lich up`
      // exited 0. Mirrors profiles-lifecycle-scoping.test.ts.
      const urlsResult = runLich(["urls", "--raw"], {
        cwd: fixture.stackPath,
        env: { LICH_HOME: fixture.lichHome },
      });
      expect(urlsResult.exitCode).toBe(0);
      const urls = parseLichUrls(urlsResult.stdout);
      const apiUrl = urls.api;
      expect(apiUrl, `expected api url in: ${urlsResult.stdout}`).toBeTruthy();
      step(`probing api /health (${apiUrl})`);
      await waitForHttp200(`${apiUrl}/health`, { timeoutMs: 30_000 });
      await expectDbMode(apiUrl!, "live");
    },
    300_000,
  );

  it("lich stacks --json reports active_profile === 'dev:lite' and exactly [api, postgres, web]", () => {
    const fix = fixture!;

    const result = runLich(["stacks", "--json"], {
      cwd: fix.stackPath,
      env: { LICH_HOME: fix.lichHome },
    });
    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error("lich stacks --json stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("lich stacks --json stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);

    let parsed: StacksJsonRow[];
    try {
      parsed = JSON.parse(result.stdout) as StacksJsonRow[];
    } catch (err) {
      throw new Error(
        `lich stacks --json did not return valid JSON.\n` +
          `--- stdout ---\n${result.stdout}\n` +
          `--- stderr ---\n${result.stderr}\n` +
          `--- parse error ---\n${(err as Error).message}`,
      );
    }
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);

    const entry = parsed[0];
    expect(entry.status, `stack status: ${JSON.stringify(entry)}`).toBe("up");
    expect(entry.active_profile).toBe("dev:lite");

    // The load-bearing assertion: dev:lite's `owned: [api, web]` REPLACES
    // the implicit "all declared" set rather than subtracting from it. The
    // dogfood stack declares 4 owned services total (api, web, tunnel_demo,
    // health_probe); dev:lite must include ONLY api + web. If lich ever
    // regressed to the "union of declared" semantics, tunnel_demo and/or
    // health_probe would appear here and this assertion would fire.
    const serviceNames = (entry.services ?? []).map((s) => s.name).sort();
    expect(serviceNames).toEqual(["api", "postgres", "web"]);
    expect(serviceNames).not.toContain("tunnel_demo");
    expect(serviceNames).not.toContain("health_probe");

    // Per-service kind: postgres must be the compose service, the rest owned.
    const byName = new Map(
      (entry.services ?? []).map((s) => [s.name, s] as const),
    );
    expect(byName.get("postgres")?.kind).toBe("compose");
    expect(byName.get("api")?.kind).toBe("owned");
    expect(byName.get("web")?.kind).toBe("owned");
  });

  it(
    "(teardown) nuke + remove tmpdirs",
    () => {
      if (!fixture) return;
      try {
        runLich(["nuke", "--yes"], {
          cwd: fixture.stackPath,
          env: { LICH_HOME: fixture.lichHome },
          timeout: 20_000,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown lich nuke failed:", err);
      }
      try {
        fixture.stackCleanup();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown tmpdir cleanup failed:", err);
      }
      try {
        rmSync(fixture.lichHome, { recursive: true, force: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("teardown LICH_HOME cleanup failed:", err);
      }
      fixture = null;
    },
    180_000,
  );
});
