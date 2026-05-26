import { describe, it, expect } from "vitest";

import {
  InterpolationError,
  interpolateRecord,
  interpolateString,
  type InterpolationContext,
} from "../../../src/config/interpolation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<InterpolationContext> = {}): InterpolationContext {
  return {
    worktree: {
      name: "feature-x",
      id: "abc12345",
      path: "/tmp/worktrees/feature-x",
    },
    services: {
      api: { host_port: 53210, ports: { "0": 53210 } },
      postgres: { host_port: 54123, ports: { "0": 54123 } },
      // Multi-port array-form service (allocator produces numeric-string
      // keys for array-form `ports:` declarations).
      mailhog: {
        host_port: 51025,
        ports: { "0": 51025, "1": 58025 },
      },
      // Multi-port Record-form service (keys are the declared logical
      // names). `host_port` is the first declared port per insertion
      // order.
      web: {
        host_port: 53000,
        ports: { http: 53000, admin: 53001, metrics: 53002 },
      },
      // A service entry without a host_port (e.g. allocation hasn't happened):
      bare: {},
    },
    owned: {
      web: { port: 3000 },
      api: { port: 4000 },
      supabase: {
        ports: {
          api: 54321,
          db: 54322,
          studio: 54323,
        },
      },
      // An owned service with neither port nor ports — to exercise the
      // "not allocated yet" branches:
      empty: {},
      // Plan-4: an owned service that has captured values from its
      // ready_when.capture extraction.
      tunnel: {
        captured: {
          url: "https://abc-def.trycloudflare.com",
          token: "secret-123",
        },
      },
      // Plan-4: an owned service with ports AND captures — for the
      // "both worlds" case proving the merge in resolve.ts works.
      both: {
        port: 9000,
        captured: { region: "us-west-2" },
      },
      // Plan-4: empty captured map — a service that declared
      // ready_when.capture but happened to have zero matches; not a
      // real-world case but the engine should treat it as
      // "no key 'X' declared" rather than crashing.
      capturedEmpty: { captured: {} },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// interpolateString — single reference shapes
// ---------------------------------------------------------------------------

describe("interpolateString — worktree.*", () => {
  it("resolves ${worktree.name}", () => {
    expect(interpolateString("${worktree.name}", ctx())).toBe("feature-x");
  });

  it("resolves ${worktree.id}", () => {
    expect(interpolateString("${worktree.id}", ctx())).toBe("abc12345");
  });

  it("resolves ${worktree.path}", () => {
    expect(interpolateString("${worktree.path}", ctx())).toBe(
      "/tmp/worktrees/feature-x",
    );
  });

  it("throws on unknown worktree field", () => {
    expect(() => interpolateString("${worktree.nope}", ctx())).toThrow(
      InterpolationError,
    );
  });
});

describe("interpolateString — services.<name>.host_port", () => {
  it("resolves and coerces number -> string", () => {
    const out = interpolateString("${services.api.host_port}", ctx());
    expect(out).toBe("53210");
    expect(typeof out).toBe("string");
  });

  it("interpolates inside a URL", () => {
    expect(
      interpolateString(
        "postgresql://postgres:postgres@localhost:${services.postgres.host_port}/app",
        ctx(),
      ),
    ).toBe("postgresql://postgres:postgres@localhost:54123/app");
  });

  it("throws when the service does not exist", () => {
    let err: unknown;
    try {
      interpolateString("${services.nonexistent.host_port}", ctx());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect((err as InterpolationError).reference).toBe(
      "${services.nonexistent.host_port}",
    );
  });

  it("throws when host_port is not allocated", () => {
    expect(() =>
      interpolateString("${services.bare.host_port}", ctx()),
    ).toThrow(InterpolationError);
  });

  it("throws on wrong shape ${services.foo}", () => {
    expect(() => interpolateString("${services.api}", ctx())).toThrow(
      InterpolationError,
    );
  });

  it("throws on unknown subfield ${services.api.bogus}", () => {
    expect(() =>
      interpolateString("${services.api.bogus}", ctx()),
    ).toThrow(InterpolationError);
  });
});

describe("interpolateString — services.<name>.host_port_<idx> (array form, LEV-461)", () => {
  it("resolves ${services.<name>.host_port_0} to the first array-form port", () => {
    expect(
      interpolateString("${services.mailhog.host_port_0}", ctx()),
    ).toBe("51025");
  });

  it("resolves ${services.<name>.host_port_1} to the second array-form port", () => {
    expect(
      interpolateString("${services.mailhog.host_port_1}", ctx()),
    ).toBe("58025");
  });

  it("interpolates inside a URL", () => {
    expect(
      interpolateString(
        "http://localhost:${services.mailhog.host_port_1}",
        ctx(),
      ),
    ).toBe("http://localhost:58025");
  });

  it("throws out-of-range error when index exceeds declared port count", () => {
    let err: InterpolationError | undefined;
    try {
      // mailhog has 2 ports (indices 0..1); index 2 is out of range.
      interpolateString("${services.mailhog.host_port_2}", ctx());
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.reference).toBe("${services.mailhog.host_port_2}");
    // The error message names the service, the count, and the valid range.
    expect(err!.message).toContain('"mailhog"');
    expect(err!.message).toContain("only 2 port");
    expect(err!.message).toContain("out of range");
    expect(err!.message).toContain("0..1");
  });

  it("throws out-of-range error for index 5 on a 2-port service", () => {
    let err: InterpolationError | undefined;
    try {
      interpolateString("${services.mailhog.host_port_5}", ctx());
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.message).toContain("only 2 port");
    expect(err!.message).toContain("out of range");
  });

  it("throws when the service does not exist", () => {
    let err: unknown;
    try {
      interpolateString("${services.ghost.host_port_0}", ctx());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect((err as InterpolationError).message).toContain(
      'no compose service named "ghost"',
    );
  });

  it("rejects non-numeric host_port_ suffix (typo routing to ports.<key>)", () => {
    // `host_port_admin` looks like a host_port_<idx> reference but the
    // suffix isn't numeric — should be a structural error, not a
    // misleading "out of range" message.
    let err: InterpolationError | undefined;
    try {
      interpolateString("${services.web.host_port_admin}", ctx());
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.message.toLowerCase()).toContain("unknown");
  });
});

describe("interpolateString — services.<name>.ports.<key> (Record form, LEV-461)", () => {
  it("resolves ${services.<name>.ports.<key>} for a Record-form service", () => {
    expect(interpolateString("${services.web.ports.http}", ctx())).toBe(
      "53000",
    );
    expect(interpolateString("${services.web.ports.admin}", ctx())).toBe(
      "53001",
    );
    expect(interpolateString("${services.web.ports.metrics}", ctx())).toBe(
      "53002",
    );
  });

  it("interpolates inside a URL", () => {
    expect(
      interpolateString(
        "http://localhost:${services.web.ports.admin}/dashboard",
        ctx(),
      ),
    ).toBe("http://localhost:53001/dashboard");
  });

  it("throws when the port key is not declared", () => {
    let err: InterpolationError | undefined;
    try {
      interpolateString("${services.web.ports.nonexistent}", ctx());
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.reference).toBe("${services.web.ports.nonexistent}");
    expect(err!.message).toContain('"nonexistent"');
    expect(err!.message).toContain('"web"');
    // The diagnostic lists the actually-declared keys so the user can
    // spot a typo quickly.
    expect(err!.message).toContain("http");
    expect(err!.message).toContain("admin");
  });

  it("throws when the service does not exist", () => {
    let err: InterpolationError | undefined;
    try {
      interpolateString("${services.ghost.ports.foo}", ctx());
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.message).toContain('no compose service named "ghost"');
  });

  it("throws when the service has no ports map allocated", () => {
    let err: InterpolationError | undefined;
    try {
      // `bare` has no `ports` in the context.
      interpolateString("${services.bare.ports.foo}", ctx());
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.message).toContain('"bare"');
    expect(err!.message).toContain("no allocated ports map");
  });
});

describe("interpolateString — services.<name>.host_port (backward compat for both shapes)", () => {
  it("resolves to the primary (first) port on an array-form service", () => {
    // mailhog has ports {"0": 51025, "1": 58025} — primary is 51025.
    expect(
      interpolateString("${services.mailhog.host_port}", ctx()),
    ).toBe("51025");
  });

  it("resolves to the primary (first declared) port on a Record-form service", () => {
    // web has ports { http: 53000, admin: 53001, metrics: 53002 } — the
    // primary is `http` (first inserted), value 53000.
    expect(interpolateString("${services.web.host_port}", ctx())).toBe(
      "53000",
    );
  });

  it("still resolves on a service whose ctx entry only has host_port (no ports map)", () => {
    // The bare-host_port shape (no ports map at all) must still work
    // because the env-resolve builder for the dogfood-stack used to
    // populate only `host_port`. This preserves backward compat for any
    // ctx producer that hasn't been updated.
    const c = ctx({
      services: {
        legacy: { host_port: 42 },
      },
    });
    expect(interpolateString("${services.legacy.host_port}", c)).toBe("42");
  });
});

describe("interpolateString — owned.<name>.port", () => {
  it("resolves single-port shape", () => {
    expect(interpolateString("${owned.web.port}", ctx())).toBe("3000");
  });

  it("throws when owned service is unknown", () => {
    expect(() =>
      interpolateString("${owned.nope.port}", ctx()),
    ).toThrow(InterpolationError);
  });

  it("throws when port is not allocated", () => {
    expect(() =>
      interpolateString("${owned.empty.port}", ctx()),
    ).toThrow(InterpolationError);
  });
});

describe("interpolateString — owned.<name>.ports.<key>", () => {
  it("resolves multi-port shape", () => {
    expect(interpolateString("${owned.supabase.ports.api}", ctx())).toBe(
      "54321",
    );
    expect(interpolateString("${owned.supabase.ports.db}", ctx())).toBe(
      "54322",
    );
  });

  it("throws when the key is not in the ports map", () => {
    expect(() =>
      interpolateString("${owned.supabase.ports.missing}", ctx()),
    ).toThrow(InterpolationError);
  });

  it("throws when the owned service has no ports map", () => {
    // `web` has `port`, not `ports`
    expect(() =>
      interpolateString("${owned.web.ports.api}", ctx()),
    ).toThrow(InterpolationError);
  });
});

// ---------------------------------------------------------------------------
// Plan-4 (LEV-361): owned.<name>.captured.<key>
// ---------------------------------------------------------------------------

describe("interpolateString — owned.<name>.captured.<key>", () => {
  it("resolves ${owned.X.captured.Y} against ctx.owned.X.captured.Y", () => {
    expect(interpolateString("${owned.tunnel.captured.url}", ctx())).toBe(
      "https://abc-def.trycloudflare.com",
    );
    expect(
      interpolateString("${owned.tunnel.captured.token}", ctx()),
    ).toBe("secret-123");
  });

  it("interpolates inside a URL alongside other refs", () => {
    expect(
      interpolateString(
        "tunnel=${owned.tunnel.captured.url} wt=${worktree.name}",
        ctx(),
      ),
    ).toBe(
      "tunnel=https://abc-def.trycloudflare.com wt=feature-x",
    );
  });

  it("resolves captures alongside ports on the same service", () => {
    // `both` has `port: 9000` AND `captured: { region: "us-west-2" }`.
    expect(interpolateString("${owned.both.port}", ctx())).toBe("9000");
    expect(interpolateString("${owned.both.captured.region}", ctx())).toBe(
      "us-west-2",
    );
  });

  it("throws InterpolationError with a useful message when the capture key is missing", () => {
    let err: InterpolationError | undefined;
    try {
      interpolateString("${owned.tunnel.captured.missing}", ctx());
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.reference).toBe("${owned.tunnel.captured.missing}");
    // Message names the missing key + the owning service, and points
    // the user at the source of truth (`ready_when.capture`).
    expect(err!.message).toContain('"missing"');
    expect(err!.message).toContain('"tunnel"');
    expect(err!.message).toContain("ready_when.capture");
  });

  it("differentiates between a missing service vs a missing capture key", () => {
    // Missing SERVICE: "no owned service named X"
    let err1: InterpolationError | undefined;
    try {
      interpolateString("${owned.ghost.captured.foo}", ctx());
    } catch (e) {
      err1 = e as InterpolationError;
    }
    expect(err1).toBeInstanceOf(InterpolationError);
    expect(err1!.message).toContain('no owned service named "ghost"');
    // Does NOT mention `ready_when.capture` — the diagnostic is
    // strictly about the unknown service, not where to declare the
    // missing capture. (The word "captured" appears in the original
    // reference, but the error message proper does not pivot to it.)
    expect(err1!.message).not.toContain("ready_when.capture");

    // Missing CAPTURE KEY: different message identifying the key.
    let err2: InterpolationError | undefined;
    try {
      interpolateString("${owned.tunnel.captured.gone}", ctx());
    } catch (e) {
      err2 = e as InterpolationError;
    }
    expect(err2).toBeInstanceOf(InterpolationError);
    expect(err2!.message).toContain('"gone"');
    expect(err2!.message).toContain('"tunnel"');
    expect(err2!.message).toContain("ready_when.capture");
    // The two error messages must be visibly distinct so users can
    // tell the cases apart.
    expect(err1!.message).not.toBe(err2!.message);
  });

  it("throws when the owned service has no captured map at all", () => {
    // `web` has port but no `captured` — distinct from "captured exists
    // but key missing". Message tells the user to check
    // `ready_when.capture` / wait for ready.
    let err: InterpolationError | undefined;
    try {
      interpolateString("${owned.web.captured.url}", ctx());
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.message).toContain("no captured values yet");
    expect(err!.message).toContain('"web"');
  });

  it("throws on missing key when captured map exists but is empty", () => {
    // `capturedEmpty.captured = {}` — service declared the capture
    // pipeline but no value extracted. The "map present, key missing"
    // branch fires (not the "no captured values yet" branch).
    let err: InterpolationError | undefined;
    try {
      interpolateString(
        "${owned.capturedEmpty.captured.anything}",
        ctx(),
      );
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.message).toContain('"anything"');
    expect(err!.message).toContain("ready_when.capture");
    expect(err!.message).not.toContain("no captured values yet");
  });

  it("treats an empty-string capture value as a valid resolution (does not throw)", () => {
    // Edge case: a regex with an optional group may legitimately
    // produce an empty string. The interpolation engine must accept
    // it as a valid value (returning "") rather than treating the
    // key as missing — that decision lives in the engine, NOT in
    // capture extraction.
    const c = ctx({
      owned: {
        ...ctx().owned,
        emptyVal: { captured: { x: "" } },
      },
    });
    expect(interpolateString("${owned.emptyVal.captured.x}", c)).toBe("");
  });

  it("rejects malformed captured shapes (rest.length !== 3)", () => {
    // `${owned.tunnel.captured}` — missing the key segment — falls
    // through to the generic unknown-shape error.
    expect(() =>
      interpolateString("${owned.tunnel.captured}", ctx()),
    ).toThrow(InterpolationError);
  });
});

// ---------------------------------------------------------------------------
// interpolateString — multi-ref, no-ref, escape
// ---------------------------------------------------------------------------

describe("interpolateString — composition", () => {
  it("resolves multiple references in one string", () => {
    expect(
      interpolateString(
        "wt=${worktree.name} api=${services.api.host_port} sb=${owned.supabase.ports.api}",
        ctx(),
      ),
    ).toBe("wt=feature-x api=53210 sb=54321");
  });

  it("returns strings with no $ verbatim", () => {
    expect(interpolateString("hello world", ctx())).toBe("hello world");
  });

  it("returns strings with no references but no escapes verbatim", () => {
    // A bare `$` with no `{` after it and no second `$` is left untouched.
    expect(interpolateString("price: $5", ctx())).toBe("price: $5");
  });

  it("unescapes $$ to a literal $", () => {
    expect(interpolateString("$$VAR", ctx())).toBe("$VAR");
  });

  it("$${ref} stays literal (the $$ escapes the leading $)", () => {
    expect(interpolateString("$${worktree.name}", ctx())).toBe(
      "${worktree.name}",
    );
  });

  it("mixes literal $ escape and real interpolation", () => {
    expect(
      interpolateString("$$LITERAL and ${worktree.name}", ctx()),
    ).toBe("$LITERAL and feature-x");
  });

  it("throws on empty reference ${}", () => {
    expect(() => interpolateString("${}", ctx())).toThrow(
      InterpolationError,
    );
  });

  it("throws on unknown root prefix", () => {
    let err: unknown;
    try {
      interpolateString("${bogus.thing}", ctx());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect((err as InterpolationError).reference).toBe("${bogus.thing}");
  });
});

describe("interpolateString — InterpolationError shape", () => {
  it("populates reference + source on failure", () => {
    let err: InterpolationError | undefined;
    try {
      interpolateString(
        "${owned.nonexistent.port}",
        ctx(),
        "api.env.DATABASE_URL",
      );
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.reference).toBe("${owned.nonexistent.port}");
    expect(err!.source).toBe("api.env.DATABASE_URL");
    // Source should be mentioned in the message so logs can pinpoint it.
    expect(err!.message).toContain("api.env.DATABASE_URL");
  });
});

// ---------------------------------------------------------------------------
// interpolateRecord
// ---------------------------------------------------------------------------

describe("interpolateRecord", () => {
  it("maps every entry when all references resolve", () => {
    const out = interpolateRecord(
      {
        API_URL: "http://localhost:${owned.api.port}",
        DB_URL:
          "postgresql://postgres:postgres@localhost:${owned.supabase.ports.db}/postgres",
        WT: "${worktree.name}",
        STATIC: "no-refs-here",
      },
      ctx(),
    );

    expect(out).toEqual({
      API_URL: "http://localhost:4000",
      DB_URL: "postgresql://postgres:postgres@localhost:54322/postgres",
      WT: "feature-x",
      STATIC: "no-refs-here",
    });
  });

  it("throws on first failure; source includes the offending key", () => {
    let err: InterpolationError | undefined;
    try {
      interpolateRecord(
        {
          GOOD: "${worktree.name}",
          BAD: "${owned.nonexistent.port}",
        },
        ctx(),
      );
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.source).toBe("BAD");
  });

  it("uses sourcePrefix to namespace the offending key", () => {
    let err: InterpolationError | undefined;
    try {
      interpolateRecord(
        { DATABASE_URL: "${services.missing.host_port}" },
        ctx(),
        "services.api.env",
      );
    } catch (e) {
      err = e as InterpolationError;
    }
    expect(err).toBeInstanceOf(InterpolationError);
    expect(err!.source).toBe("services.api.env.DATABASE_URL");
  });
});
