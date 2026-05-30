import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _docker, sweepOwnedContainers } from "../../../src/owned/containers.js";

interface PsCall {
  cli: string;
  kind: "label" | "name";
  value: string;
}

interface RmCall {
  cli: string;
  id: string;
}

let psCalls: PsCall[];
let rmCalls: RmCall[];
let originalPs: typeof _docker.ps;
let originalRm: typeof _docker.rm;

beforeEach(() => {
  psCalls = [];
  rmCalls = [];
  originalPs = _docker.ps;
  originalRm = _docker.rm;
});

afterEach(() => {
  _docker.ps = originalPs;
  _docker.rm = originalRm;
});

describe("sweepOwnedContainers", () => {
  it("returns empty result when no spec provided", async () => {
    _docker.ps = async () => ["uncalled"];
    const result = await sweepOwnedContainers("docker", undefined);
    expect(result).toEqual({ removed: [], stragglers: [] });
  });

  it("returns empty result when label and name_pattern are both undefined", async () => {
    _docker.ps = async () => ["uncalled"];
    const result = await sweepOwnedContainers("docker", {});
    expect(result).toEqual({ removed: [], stragglers: [] });
    expect(psCalls).toHaveLength(0);
  });

  it("no-ops when no matching containers are found (single ps call)", async () => {
    _docker.ps = async (cli, filter) => {
      psCalls.push({ cli, kind: filter.kind, value: filter.value });
      return [];
    };
    const result = await sweepOwnedContainers("docker", { label: "k=v" });
    expect(result).toEqual({ removed: [], stragglers: [] });
    expect(psCalls).toEqual([{ cli: "docker", kind: "label", value: "k=v" }]);
  });

  it("removes matching containers and reports them in `removed`", async () => {
    let psCallCount = 0;
    _docker.ps = async (cli, filter) => {
      psCalls.push({ cli, kind: filter.kind, value: filter.value });
      psCallCount++;
      // First call returns survivors; second (verification) returns empty.
      return psCallCount === 1 ? ["abc123", "def456"] : [];
    };
    _docker.rm = async (cli, id) => {
      rmCalls.push({ cli, id });
      return { ok: true };
    };

    const result = await sweepOwnedContainers("docker", { label: "com.example/project=feature-x" });
    expect(result.removed).toEqual(["abc123", "def456"]);
    expect(result.stragglers).toEqual([]);
    expect(rmCalls).toEqual([
      { cli: "docker", id: "abc123" },
      { cli: "docker", id: "def456" },
    ]);
    expect(psCalls).toHaveLength(2);
    expect(psCalls[0]).toEqual({ cli: "docker", kind: "label", value: "com.example/project=feature-x" });
    expect(psCalls[1]).toEqual({ cli: "docker", kind: "label", value: "com.example/project=feature-x" });
  });

  it("uses name filter when name_pattern is set", async () => {
    _docker.ps = async (cli, filter) => {
      psCalls.push({ cli, kind: filter.kind, value: filter.value });
      return [];
    };
    await sweepOwnedContainers("podman", { name_pattern: "supabase_*_feature-x" });
    expect(psCalls).toEqual([{ cli: "podman", kind: "name", value: "supabase_*_feature-x" }]);
  });

  it("reports stragglers that survived rm -f", async () => {
    let psCallCount = 0;
    _docker.ps = async () => {
      psCallCount++;
      return psCallCount === 1 ? ["abc123"] : ["abc123"];
    };
    _docker.rm = async () => ({ ok: false });

    const result = await sweepOwnedContainers("docker", { label: "k=v" });
    expect(result.removed).toEqual([]);
    expect(result.stragglers).toEqual(["abc123"]);
  });

  it("prefers label over name_pattern when both are present (defensive against bad input)", async () => {
    _docker.ps = async (cli, filter) => {
      psCalls.push({ cli, kind: filter.kind, value: filter.value });
      return [];
    };
    await sweepOwnedContainers("docker", { label: "k=v", name_pattern: "x_*" });
    expect(psCalls).toHaveLength(1);
    expect(psCalls[0].kind).toBe("label");
  });
});
