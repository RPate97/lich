import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MutagenSync,
  isMutagenAvailable,
  upsertSshConfigBlock,
  removeSshConfigBlock,
  gcOrphanedSshConfigBlocks,
} from "../../../src/sandbox/mutagen.js";
import type { MutagenCli } from "../../../src/sandbox/mutagen.js";

class FakeMutagenCli implements MutagenCli {
  calls: string[][] = [];
  failNext?: string;
  async run(args: ReadonlyArray<string>): Promise<{ stdout: string; stderr: string }> {
    this.calls.push([...args]);
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = undefined;
      throw new Error(msg);
    }
    return { stdout: "", stderr: "" };
  }
}

const opts = (over: Record<string, unknown> = {}) => ({
  name: "lich-run-abc",
  hostPath: "/work/tree",
  target: "10.0.0.5",
  guestPath: "/workspace",
  ignore: ["dist", ".next"],
  ...over,
});

function ignoresOf(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ignore") out.push(args[i + 1]!);
  }
  return out;
}

describe("MutagenSync", () => {
  test("start creates a session: name, ignores, host -> target:guest", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).start(opts());
    // calls[0] is the pre-terminate (idempotency); calls[1] is the create.
    expect(cli.calls).toHaveLength(2);
    const args = cli.calls[1]!;
    expect(args.slice(0, 2)).toEqual(["sync", "create"]);
    expect(args[args.indexOf("--name") + 1]).toBe("lich-run-abc");
    expect(args[args.length - 2]).toBe("/work/tree");
    expect(args[args.length - 1]).toBe("admin@10.0.0.5:/workspace");
  });

  test("node_modules + .git always ignored even when caller passes ignore: []", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).start(opts({ ignore: [] }));
    const ig = ignoresOf(cli.calls[1]!);
    expect(ig).toContain("node_modules");
    expect(ig).toContain(".git");
  });

  test("caller ignores union with ALWAYS_IGNORE, no duplicates", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).start(opts({ ignore: ["node_modules", "dist"] }));
    const ig = ignoresOf(cli.calls[1]!);
    expect(ig.filter((x) => x === "node_modules")).toHaveLength(1);
    expect(ig).toContain("dist");
  });

  test("extraFlags are forwarded", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).start(opts({ extraFlags: ["--sync-mode", "two-way-resolved"] }));
    const args = cli.calls[1]!;
    expect(args).toContain("--sync-mode");
    expect(args).toContain("two-way-resolved");
  });

  test("start is idempotent: terminate (best-effort) precedes create so leftover sessions don't collide", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).start(opts());
    expect(cli.calls).toHaveLength(2);
    expect(cli.calls[0]!.slice(0, 3)).toEqual(["sync", "terminate", "lich-run-abc"]);
    expect(cli.calls[1]!.slice(0, 2)).toEqual(["sync", "create"]);
  });

  test("start tolerates terminate failing with 'no such session' (clean slate)", async () => {
    const cli = new FakeMutagenCli();
    cli.failNext = "unable to locate requested sessions: no such session";
    await new MutagenSync(cli).start(opts());
    expect(cli.calls[1]!.slice(0, 2)).toEqual(["sync", "create"]);
  });

  test("flush flushes the named session", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).flush("lich-run-abc");
    expect(cli.calls[0]).toEqual(["sync", "flush", "lich-run-abc"]);
  });

  test("terminate terminates the named session", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).terminate("lich-run-abc");
    expect(cli.calls[0]).toEqual(["sync", "terminate", "lich-run-abc"]);
  });

  test("terminate swallows 'no such session' (idempotent)", async () => {
    const cli = new FakeMutagenCli();
    cli.failNext = "unable to locate requested sessions: no such session";
    await expect(new MutagenSync(cli).terminate("gone")).resolves.toBeUndefined();
  });

  test("terminate rethrows other errors", async () => {
    const cli = new FakeMutagenCli();
    cli.failNext = "mutagen daemon not running";
    await expect(new MutagenSync(cli).terminate("x")).rejects.toThrow(/daemon not running/);
  });
});

describe("upsertSshConfigBlock / removeSshConfigBlock", () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lich-ssh-cfg-"));
    configPath = join(dir, "config");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (over: Partial<{ host: string; user: string; keyPath: string; knownHostsPath: string }> = {}) => ({
    host: "192.168.64.5",
    user: "admin",
    keyPath: "/tmp/key",
    knownHostsPath: "/tmp/known_hosts",
    ...over,
  });

  test("upsert creates the config file with our marked block", () => {
    upsertSshConfigBlock(configPath, "vm-a", entry());
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("# === lich-tart: vm-a (auto-generated; safe to delete) ===");
    expect(content).toContain("Host 192.168.64.5");
    expect(content).toContain("IdentitiesOnly yes");
    expect(content).toContain("IdentityFile /tmp/key");
    expect(content).toContain("UserKnownHostsFile /tmp/known_hosts");
    expect(content).toContain("# === end lich-tart: vm-a ===");
  });

  test("upsert is idempotent for the same name (replaces the block)", () => {
    upsertSshConfigBlock(configPath, "vm-a", entry({ keyPath: "/tmp/key-old" }));
    upsertSshConfigBlock(configPath, "vm-a", entry({ keyPath: "/tmp/key-new" }));
    const content = readFileSync(configPath, "utf8");
    expect(content).not.toContain("/tmp/key-old");
    expect(content).toContain("/tmp/key-new");
    expect(content.match(/# === lich-tart: vm-a/g)?.length).toBe(1);
  });

  test("upsert preserves blocks for other names", () => {
    upsertSshConfigBlock(configPath, "vm-a", entry({ host: "192.168.64.5" }));
    upsertSshConfigBlock(configPath, "vm-b", entry({ host: "192.168.64.6" }));
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("# === lich-tart: vm-a");
    expect(content).toContain("# === lich-tart: vm-b");
    expect(content).toContain("Host 192.168.64.5");
    expect(content).toContain("Host 192.168.64.6");
  });

  test("upsert preserves existing user content (appended below)", () => {
    writeFileSync(configPath, "Host github.com\n    User git\n");
    upsertSshConfigBlock(configPath, "vm-a", entry());
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("Host github.com");
    expect(content).toContain("User git");
    expect(content).toContain("# === lich-tart: vm-a");
    expect(content.indexOf("Host github.com")).toBeLessThan(content.indexOf("lich-tart"));
  });

  test("remove deletes only the named block", () => {
    upsertSshConfigBlock(configPath, "vm-a", entry({ host: "192.168.64.5" }));
    upsertSshConfigBlock(configPath, "vm-b", entry({ host: "192.168.64.6" }));
    removeSshConfigBlock(configPath, "vm-a");
    const content = readFileSync(configPath, "utf8");
    expect(content).not.toContain("# === lich-tart: vm-a");
    expect(content).not.toContain("Host 192.168.64.5");
    expect(content).toContain("# === lich-tart: vm-b");
    expect(content).toContain("Host 192.168.64.6");
  });

  test("remove is a no-op when the file does not exist", () => {
    expect(() => removeSshConfigBlock(configPath, "missing")).not.toThrow();
  });

  test("remove is a no-op when the marker is absent", () => {
    writeFileSync(configPath, "Host github.com\n    User git\n");
    removeSshConfigBlock(configPath, "vm-a");
    expect(readFileSync(configPath, "utf8")).toBe("Host github.com\n    User git\n");
  });
});

describe("gcOrphanedSshConfigBlocks", () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lich-ssh-gc-"));
    configPath = join(dir, "config");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (host: string) => ({
    host,
    user: "admin",
    keyPath: "/tmp/key",
    knownHostsPath: "/tmp/known_hosts",
  });

  test("removes blocks whose VM is not in the known list", () => {
    upsertSshConfigBlock(configPath, "vm-orphan-a", entry("10.0.0.1"));
    upsertSshConfigBlock(configPath, "vm-live", entry("10.0.0.2"));
    upsertSshConfigBlock(configPath, "vm-orphan-b", entry("10.0.0.3"));

    const result = gcOrphanedSshConfigBlocks(configPath, ["vm-live"]);

    expect(new Set(result.removed)).toEqual(new Set(["vm-orphan-a", "vm-orphan-b"]));
    const content = readFileSync(configPath, "utf8");
    expect(content).not.toContain("vm-orphan-a");
    expect(content).not.toContain("vm-orphan-b");
    expect(content).toContain("vm-live");
  });

  test("returns empty removed list when all blocks are live", () => {
    upsertSshConfigBlock(configPath, "vm-a", entry("10.0.0.1"));
    upsertSshConfigBlock(configPath, "vm-b", entry("10.0.0.2"));

    const result = gcOrphanedSshConfigBlocks(configPath, ["vm-a", "vm-b"]);
    expect(result.removed).toEqual([]);
  });

  test("preserves non-lich-tart user content", () => {
    writeFileSync(configPath, "Host github.com\n    User git\n");
    upsertSshConfigBlock(configPath, "vm-orphan", entry("10.0.0.1"));

    gcOrphanedSshConfigBlocks(configPath, []);

    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("Host github.com");
    expect(content).toContain("User git");
    expect(content).not.toContain("vm-orphan");
  });

  test("no-op when config file does not exist", () => {
    const result = gcOrphanedSshConfigBlocks(configPath, []);
    expect(result.removed).toEqual([]);
  });

  test("no-op when config has no lich-tart blocks", () => {
    writeFileSync(configPath, "Host github.com\n    User git\n");
    const result = gcOrphanedSshConfigBlocks(configPath, []);
    expect(result.removed).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe("Host github.com\n    User git\n");
  });
});

describe("isMutagenAvailable", () => {
  test("true when `mutagen version` succeeds", async () => {
    const cli = new FakeMutagenCli();
    expect(await isMutagenAvailable(cli)).toBe(true);
    expect(cli.calls[0]).toEqual(["version"]);
  });

  test("false when the cli throws", async () => {
    const cli = new FakeMutagenCli();
    cli.failNext = "command not found";
    expect(await isMutagenAvailable(cli)).toBe(false);
  });
});
