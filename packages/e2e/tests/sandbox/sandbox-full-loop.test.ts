import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxRuntime } from "../../../lich/src/sandbox/runtime.js";
import { SnapshotStore } from "../../../lich/src/sandbox/snapshot-store.js";
import { TartBackend } from "../../../lich/src/sandbox/tart.js";
import { runName, goldenName } from "../../../lich/src/sandbox/naming.js";
import { isTartAvailable, imageExists } from "../../helpers/tart.js";
import type { SandboxRuntime as SandboxConfig } from "../../../lich/src/config/types.js";

// First real lich-stack-in-a-sandbox lifecycle: cold-boot → serve → snapshot →
// purge → warm-fork → serve → purge, on real Tart, with captured timings. Uses
// a minimal no-deps stack (python http.server, preinstalled in the image) so the
// loop proves the cold/fork mechanism without an in-VM dependency install (the
// full app-serving + node_modules-bake payoff is proven in dep-bake.test.ts).

const WORKTREE_ID = "fullloop";
const PROFILE = "dev:sandbox";
const PORT = 8099;
const IMAGE = process.env.LICH_SANDBOX_TEST_IMAGE ?? "lich-sandbox-base";

const LICH_YAML = `version: "1"
runtime:
  sandbox:
    backend: tart
    image: ${IMAGE}
    bake_inputs:
      - "lich.yaml"
profiles:
  "${PROFILE}":
    default: true
    owned: [web]
owned:
  web:
    cmd: "python3 -m http.server ${PORT}"
    cwd: "."
    port: ${PORT}
    ready_when:
      http_get: /
      timeout: 40s
`;

describe.skipIf(!isTartAvailable() || !imageExists())("sandbox full loop (e2e)", () => {
  const backend = new TartBackend();
  let worktree: string;
  let storeDir: string;
  let runtime: SandboxRuntime;
  const runVm = runName(WORKTREE_ID, PROFILE);
  const timings: Record<string, number> = {};

  const ctx = () => ({
    worktreeId: WORKTREE_ID,
    worktreePath: worktree,
    lichYamlPath: join(worktree, "lich.yaml"),
    profileName: PROFILE,
  });

  beforeAll(async () => {
    worktree = mkdtempSync(join(tmpdir(), "lich-fullloop-wt-"));
    storeDir = mkdtempSync(join(tmpdir(), "lich-fullloop-store-"));
    writeFileSync(join(worktree, "lich.yaml"), LICH_YAML);
    const config: SandboxConfig = {
      backend: "tart",
      image: IMAGE,
      bake_inputs: ["lich.yaml"],
    } as SandboxConfig;
    runtime = new SandboxRuntime(config, {
      snapshotStore: new SnapshotStore(storeDir),
      bootWaitMs: 8000,
    });
    await backend.destroy(runVm);
  }, 60_000);

  afterAll(async () => {
    await runtime.down(ctx(), { purge: true }).catch(() => {});
    await backend.destroy(runVm).catch(() => {});
    // Destroy any golden created during the run.
    for (const vm of await backend.list().catch(() => [])) {
      if (vm.name.startsWith("lich-golden-")) await backend.destroy(vm.name).catch(() => {});
    }
    rmSync(worktree, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
    if (Object.keys(timings).length) console.log(`[full-loop] timings(ms): ${JSON.stringify(timings)}`);
  }, 120_000);

  test("cold-boot serves the stack inside the VM", async () => {
    const t0 = Date.now();
    const outcome = await runtime.up(ctx());
    timings.cold = Date.now() - t0;
    expect(outcome.path).toBe("cold");
    expect((await backend.inspect(runVm)).state).toBe("running");

    // Source synced in.
    const yaml = await backend.exec(runVm, ["cat", "/workspace/lich.yaml"]);
    expect(yaml.stdout).toContain("python3 -m http.server");

    // Stack is actually serving inside the VM.
    const health = await backend.exec(runVm, ["sh", "-c", `curl -fsS -o /dev/null -w '%{http_code}' localhost:${PORT}/`]);
    expect(health.stdout.trim()).toBe("200");
  }, 180_000);

  test("snapshot creates a golden", async () => {
    const golden = await runtime.snapshot(ctx());
    const { computeBakeInputsHash } = await import("../../../lich/src/sandbox/inputs-hash.js");
    const expectedHash = await computeBakeInputsHash({
      worktreePath: worktree,
      lichYamlPath: join(worktree, "lich.yaml"),
      profileName: PROFILE,
      bakeInputs: ["lich.yaml"],
    });
    expect(golden).toBe(goldenName(expectedHash));
    expect((await backend.inspect(golden)).state).toBe("stopped");
  }, 120_000);

  test("purge then up warm-forks from the golden and serves again", async () => {
    await runtime.down(ctx(), { purge: true });
    expect((await backend.inspect(runVm)).state).toBe("absent");

    const t0 = Date.now();
    const outcome = await runtime.up(ctx());
    timings.fork = Date.now() - t0;
    expect(outcome.path).toBe("warm");
    expect((await backend.inspect(runVm)).state).toBe("running");

    const health = await backend.exec(runVm, ["sh", "-c", `curl -fsS -o /dev/null -w '%{http_code}' localhost:${PORT}/`]);
    expect(health.stdout.trim()).toBe("200");
  }, 180_000);

  test("down --purge destroys the run VM", async () => {
    await runtime.down(ctx(), { purge: true });
    expect((await backend.inspect(runVm)).state).toBe("absent");
  }, 60_000);
});
