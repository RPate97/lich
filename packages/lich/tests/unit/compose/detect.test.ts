import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _probe,
  detectComposeCli,
  resolveComposeCli,
} from "../../../src/compose/detect.js";

type ProbeFn = (cmd: string, args: string[]) => Promise<boolean>;

let originalProbe: ProbeFn;
let calls: Array<{ cmd: string; args: string[] }>;

beforeEach(() => {
  originalProbe = _probe.current;
  calls = [];
});

afterEach(() => {
  _probe.current = originalProbe;
});

function stubProbe(available: ReadonlyArray<string>): void {
  _probe.current = async (cmd: string, args: string[]): Promise<boolean> => {
    calls.push({ cmd, args });
    return available.includes(cmd);
  };
}

describe("detectComposeCli", () => {
  it("returns docker when `docker compose version --short` exits 0", async () => {
    stubProbe(["docker"]);
    const cli = await detectComposeCli();
    expect(cli).toEqual({
      kind: "docker",
      cmd: "docker",
      args: ["compose"],
    });
    expect(calls[0]).toEqual({ cmd: "docker", args: ["compose"] });
  });

  it("falls through to podman when docker is unavailable", async () => {
    stubProbe(["podman"]);
    const cli = await detectComposeCli();
    expect(cli.kind).toBe("podman");
    expect(cli.cmd).toBe("podman");
    expect(calls.map((c) => c.cmd)).toEqual(["docker", "podman"]);
  });

  it("falls through to nerdctl when docker and podman are unavailable", async () => {
    stubProbe(["nerdctl"]);
    const cli = await detectComposeCli();
    expect(cli.kind).toBe("nerdctl");
    expect(calls.map((c) => c.cmd)).toEqual(["docker", "podman", "nerdctl"]);
  });

  it("throws a clear error if none of the three are available", async () => {
    stubProbe([]);
    await expect(detectComposeCli()).rejects.toThrow(/No compose CLI/i);
    expect(calls.map((c) => c.cmd)).toEqual(["docker", "podman", "nerdctl"]);
  });

  it("does not probe podman/nerdctl once docker succeeds", async () => {
    stubProbe(["docker", "podman", "nerdctl"]);
    await detectComposeCli();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("docker");
  });
});

describe("resolveComposeCli", () => {
  it("returns detected CLI when override is undefined", async () => {
    stubProbe(["podman"]);
    const cli = await resolveComposeCli(undefined);
    expect(cli.kind).toBe("podman");
  });

  it("short-circuits to podman when override='podman' and podman is available", async () => {
    stubProbe(["docker", "podman"]);
    const cli = await resolveComposeCli("podman");
    expect(cli.kind).toBe("podman");
    expect(calls).toEqual([{ cmd: "podman", args: ["compose"] }]);
  });

  it("short-circuits to nerdctl when override='nerdctl' and nerdctl is available", async () => {
    stubProbe(["docker", "nerdctl"]);
    const cli = await resolveComposeCli("nerdctl");
    expect(cli.kind).toBe("nerdctl");
    expect(calls).toEqual([{ cmd: "nerdctl", args: ["compose"] }]);
  });

  it("throws if override points at an unavailable CLI", async () => {
    stubProbe(["docker"]);
    await expect(resolveComposeCli("podman")).rejects.toThrow(
      /runtime\.compose_cli.*podman/i,
    );
  });

  it("throws on an unknown override value", async () => {
    stubProbe(["docker"]);
    await expect(
      resolveComposeCli("kaniko" as unknown as undefined),
    ).rejects.toThrow(/Unknown compose CLI override/i);
  });
});
