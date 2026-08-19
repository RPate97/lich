import { describe, expect, it } from "vitest";

import {
  buildOwnedPortsSpec,
  resolveTcpTarget,
} from "../../../src/commands/restart.js";
import type { ServiceSnapshot } from "../../../src/state/snapshot.js";

/**
 * The snapshot stores `ready_when.tcp` as authored in the yaml, so a
 * `${owned.<svc>.port}` template survives verbatim. On restart it must be
 * interpolated against the allocated port or the raw `${...}` reaches the tcp
 * parser and errors ("invalid tcp target"). See fix for restart re-probe.
 */
function svc(overrides: Partial<ServiceSnapshot>): ServiceSnapshot {
  return { name: "server", ...overrides } as ServiceSnapshot;
}

describe("resolveTcpTarget", () => {
  it("substitutes a ${owned.*.port} template with the service's default port", () => {
    const s = svc({ allocated_ports: { default: 3005 } });
    expect(resolveTcpTarget("localhost:${owned.server.port}", s)).toBe(
      "localhost:3005",
    );
  });

  it("falls back to the first allocated port when there is no `default` key", () => {
    const s = svc({ allocated_ports: { grpc: 7233 } });
    expect(resolveTcpTarget("localhost:${owned.temporal.ports.grpc}", s)).toBe(
      "localhost:7233",
    );
  });

  it("passes through a concrete host:port target unchanged", () => {
    const s = svc({ allocated_ports: { default: 3005 } });
    expect(resolveTcpTarget("localhost:8080", s)).toBe("localhost:8080");
  });

  it("passes through a bare numeric port unchanged", () => {
    const s = svc({ allocated_ports: { default: 3005 } });
    expect(resolveTcpTarget("5432", s)).toBe("5432");
  });

  it("throws a clear error when a template is used but no port is allocated", () => {
    const s = svc({ name: "web", allocated_ports: {} });
    expect(() => resolveTcpTarget("localhost:${owned.web.port}", s)).toThrow(
      /no port is allocated for 'web'/,
    );
  });

  it("throws when allocated_ports is absent and a template is present", () => {
    const s = svc({ name: "web" });
    expect(() => resolveTcpTarget("localhost:${owned.web.port}", s)).toThrow(
      /no port is allocated for 'web'/,
    );
  });
});

describe("buildOwnedPortsSpec", () => {
  it("rebuilds the single-port spec from allocated_ports + port_env_vars", () => {
    const s = svc({
      allocated_ports: { default: 3005 },
      port_env_vars: { default: "PORT" },
    });
    expect(buildOwnedPortsSpec(s)).toEqual({ default: { envVar: "PORT", port: 3005 } });
  });

  it("rebuilds a multi-port spec keyed by logical name", () => {
    const s = svc({
      allocated_ports: { api: 3000, db: 3001 },
      port_env_vars: { api: "SUPABASE_API_PORT", db: "SUPABASE_DB_PORT" },
    });
    expect(buildOwnedPortsSpec(s)).toEqual({
      api: { envVar: "SUPABASE_API_PORT", port: 3000 },
      db: { envVar: "SUPABASE_DB_PORT", port: 3001 },
    });
  });

  it("returns undefined when the service publishes no ports", () => {
    expect(buildOwnedPortsSpec(svc({}))).toBeUndefined();
  });

  it("returns undefined for an older snapshot without port_env_vars", () => {
    // Back-compat: a stack booted before this field existed → no injection,
    // same as the pre-fix behavior (rather than a crash).
    expect(buildOwnedPortsSpec(svc({ allocated_ports: { default: 3005 } }))).toBeUndefined();
  });

  it("skips ports that have no matching env var", () => {
    const s = svc({
      allocated_ports: { default: 3005, extra: 9999 },
      port_env_vars: { default: "PORT" },
    });
    expect(buildOwnedPortsSpec(s)).toEqual({ default: { envVar: "PORT", port: 3005 } });
  });
});
