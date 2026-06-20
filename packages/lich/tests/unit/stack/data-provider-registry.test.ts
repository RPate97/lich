import { describe, it, expect } from "vitest";
import { pickDataProvider } from "../../../src/stack/data-provider.js";
import { LocalStackDataProvider } from "../../../src/stack/providers/local.js";
import { HttpStackDataProvider } from "../../../src/stack/providers/http.js";
import type { StackSnapshot } from "../../../src/state/snapshot.js";

const baseSnap = (over: Partial<StackSnapshot>): StackSnapshot => ({
  stack_id: "x",
  worktree_name: "x",
  worktree_path: "/x",
  status: "up",
  started_at: "t",
  services: [],
  ...over,
});

const baseDeps = () => ({
  stateRoot: "/tmp/state",
  proxyPort: 3300,
  tailFactory: ((_o: any) => ({ start: () => {}, onLine: () => {}, stop: () => {} } as any)),
});

describe("pickDataProvider", () => {
  it("returns LocalStackDataProvider for snapshot with no data_source", () => {
    const provider = pickDataProvider(baseSnap({}), baseDeps());
    expect(provider).toBeInstanceOf(LocalStackDataProvider);
  });

  it("returns LocalStackDataProvider when data_source.kind === 'local'", () => {
    const provider = pickDataProvider(baseSnap({ data_source: { kind: "local" } }), baseDeps());
    expect(provider).toBeInstanceOf(LocalStackDataProvider);
  });

  it("returns HttpStackDataProvider when data_source.kind === 'http'", () => {
    const provider = pickDataProvider(
      baseSnap({ data_source: { kind: "http", base_url: "http://10.0.0.5:3300", stack_id: "workspace-c52ddf65" } }),
      baseDeps(),
    );
    expect(provider).toBeInstanceOf(HttpStackDataProvider);
  });

  it("legacy: snap.sandbox without data_source falls back to local (no auto-http derivation)", () => {
    // Per spec: legacy snapshots without data_source default to local. Substrate post-Task 13
    // always writes data_source explicitly, so legacy = pre-this-plan = local-only.
    const provider = pickDataProvider(
      baseSnap({ sandbox: true, sandbox_vm: "lich-run-old" }),
      baseDeps(),
    );
    expect(provider).toBeInstanceOf(LocalStackDataProvider);
  });

  it("throws on unknown kind", () => {
    expect(() => pickDataProvider(
      baseSnap({ data_source: { kind: "alien" as any } } as any),
      baseDeps(),
    )).toThrow(/unknown data_source kind/i);
  });
});
