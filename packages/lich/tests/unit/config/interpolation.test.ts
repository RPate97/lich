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
      api: { host_port: 53210 },
      postgres: { host_port: 54123 },
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
