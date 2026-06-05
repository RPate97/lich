import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TartBackend } from "../../../lich/src/sandbox/tart.js";
import { MutagenSync, RealMutagenCli, RealSshTransport, isMutagenAvailable } from "../../../lich/src/sandbox/mutagen.js";
import { DEFAULT_IGNORE } from "../../../lich/src/sandbox/sync.js";
import { isTartAvailable, imageExists } from "../../helpers/tart.js";

// Live SSH source sync over Mutagen against a real Tart VM. Proves: initial
// files land in /workspace, node_modules excluded, AND a host edit propagates
// after flush. Validated recipe: per-VM ephemeral ed25519 key pushed via
// tart-exec; host key appended to ~/.ssh/known_hosts via ssh-keyscan; key
// loaded into ssh-agent for mutagen to find. Never touches ~/.ssh/config.

let mutagenOk = false;
try { mutagenOk = await isMutagenAvailable(new RealMutagenCli()); } catch { mutagenOk = false; }

describe.skipIf(!isTartAvailable() || !imageExists() || !mutagenOk)("mutagen live SSH sync (e2e)", () => {
  const backend = new TartBackend();
  const vm = "lich-e2e-mut";
  let sync: MutagenSync;
  let work: string;
  let host: string;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "lich-e2e-mut-work-"));
    host = join(work, "src-root");
    mkdirSync(join(host, "src"), { recursive: true });
    mkdirSync(join(host, "node_modules"), { recursive: true });
    writeFileSync(join(host, "src", "app.txt"), "HELLO_LIVE_V1");
    writeFileSync(join(host, "node_modules", "SENTINEL"), "NOPE");

    sync = new MutagenSync(new RealMutagenCli(), new RealSshTransport(join(work, "mut")));

    await backend.destroy(vm).catch(() => {});
    await backend.create({ name: vm, image: "lich-sandbox-base", memoryMb: 2048 });
    await backend.start(vm);
    await new Promise((r) => setTimeout(r, 8000));
  }, 180000);

  afterAll(async () => {
    await sync.terminate(vm).catch(() => {});
    await backend.destroy(vm).catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }, 60000);

  test("initial sync, node_modules excluded, live edit propagates", async () => {
    const ip = await backend.ip(vm);
    await sync.start({
      name: vm,
      hostPath: host,
      target: ip,
      guestPath: "/tmp/synced",
      ignore: DEFAULT_IGNORE,
    });
    await sync.flush(vm);

    const initial = await backend.exec(vm, ["cat", "/tmp/synced/src/app.txt"]);
    expect(initial.stdout.trim()).toBe("HELLO_LIVE_V1");

    const sentinel = await backend.exec(vm, ["sh", "-c", "test -e /tmp/synced/node_modules/SENTINEL && echo LEAK || echo OK"]);
    expect(sentinel.stdout.trim()).toBe("OK");

    writeFileSync(join(host, "src", "app.txt"), "EDITED_LIVE_V2");
    await sync.flush(vm);
    const edited = await backend.exec(vm, ["cat", "/tmp/synced/src/app.txt"]);
    expect(edited.stdout.trim()).toBe("EDITED_LIVE_V2");
  }, 180000);
});
