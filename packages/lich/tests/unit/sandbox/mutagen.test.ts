import { describe, test, expect } from "vitest";
import { MutagenSync, isMutagenAvailable } from "../../../src/sandbox/mutagen.js";
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
    expect(cli.calls).toHaveLength(1);
    const args = cli.calls[0]!;
    expect(args.slice(0, 2)).toEqual(["sync", "create"]);
    expect(args[args.indexOf("--name") + 1]).toBe("lich-run-abc");
    expect(args[args.length - 2]).toBe("/work/tree");
    expect(args[args.length - 1]).toBe("admin@10.0.0.5:/workspace");
  });

  test("node_modules + .git always ignored even when caller passes ignore: []", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).start(opts({ ignore: [] }));
    const ig = ignoresOf(cli.calls[0]!);
    expect(ig).toContain("node_modules");
    expect(ig).toContain(".git");
  });

  test("caller ignores union with ALWAYS_IGNORE, no duplicates", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).start(opts({ ignore: ["node_modules", "dist"] }));
    const ig = ignoresOf(cli.calls[0]!);
    expect(ig.filter((x) => x === "node_modules")).toHaveLength(1);
    expect(ig).toContain("dist");
  });

  test("extraFlags are forwarded", async () => {
    const cli = new FakeMutagenCli();
    await new MutagenSync(cli).start(opts({ extraFlags: ["--sync-mode", "two-way-resolved"] }));
    const args = cli.calls[0]!;
    expect(args).toContain("--sync-mode");
    expect(args).toContain("two-way-resolved");
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
