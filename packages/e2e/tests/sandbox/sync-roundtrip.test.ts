import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TartBackend } from "../../../lich/src/sandbox/tart.js";
import { CopySync } from "../../../lich/src/sandbox/copy-sync.js";
import { DEFAULT_IGNORE } from "../../../lich/src/sandbox/sync.js";
import { isTartAvailable, imageExists } from "../../helpers/tart.js";

// Proves the live-sync thesis on a real VM: CopySync gets host source into the
// guest's /workspace, host edits propagate on flush, and node_modules is never
// synced (the sync-correctness invariant — a host-arch node_modules in a Linux
// guest is a silent breakage).

const VM = "lich-sync-rt-e2e";
const IMAGE = process.env.LICH_SANDBOX_TEST_IMAGE ?? "lich-sandbox-base";

describe.skipIf(!isTartAvailable() || !imageExists())("CopySync round-trip (e2e)", () => {
  const backend = new TartBackend();
  const sync = new CopySync();
  let host: string;

  beforeAll(async () => {
    host = mkdtempSync(join(tmpdir(), "lich-sync-host-"));
    writeFileSync(join(host, "probe.txt"), "HELLO_FROM_HOST_V1");
    mkdirSync(join(host, "node_modules"), { recursive: true });
    writeFileSync(join(host, "node_modules", "SENTINEL"), "SHOULD_NOT_SYNC");
    mkdirSync(join(host, "src"), { recursive: true });
    writeFileSync(join(host, "src", "app.txt"), "app-code");

    await backend.destroy(VM);
    await backend.create({ name: VM, image: IMAGE });
    await backend.start(VM);
  }, 180_000);

  afterAll(async () => {
    await sync.terminate(VM).catch(() => {});
    await backend.destroy(VM).catch(() => {});
    rmSync(host, { recursive: true, force: true });
  }, 60_000);

  test("source reaches the VM; node_modules is NOT synced", async () => {
    await sync.start({
      name: VM,
      hostPath: host,
      target: await backend.ip(VM),
      guestPath: "/workspace",
      ignore: DEFAULT_IGNORE,
    });

    const probe = await backend.exec(VM, ["cat", "/workspace/probe.txt"]);
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.trim()).toBe("HELLO_FROM_HOST_V1");

    const app = await backend.exec(VM, ["cat", "/workspace/src/app.txt"]);
    expect(app.stdout.trim()).toBe("app-code");

    // node_modules must be absent in the guest.
    const sentinel = await backend.exec(VM, ["sh", "-c", "test -e /workspace/node_modules/SENTINEL && echo PRESENT || echo ABSENT"]);
    expect(sentinel.stdout.trim()).toBe("ABSENT");
  }, 120_000);

  test("host edit propagates to the VM after flush; measure latency", async () => {
    writeFileSync(join(host, "probe.txt"), "EDITED_ON_HOST_V2");
    const t0 = Date.now();
    await sync.flush(VM);
    const latencyMs = Date.now() - t0;

    const probe = await backend.exec(VM, ["cat", "/workspace/probe.txt"]);
    expect(probe.stdout.trim()).toBe("EDITED_ON_HOST_V2");
    // Log the remote-UX number (don't assert a threshold).
    console.log(`[sync-roundtrip] edit→visible latency: ${latencyMs}ms`);
  }, 120_000);
});
