import { describe, expect, it } from "vitest";

import {
  createStaticRoutes,
  emptyStaticRoutes,
} from "../../../../src/daemon/proxy/static-routes.js";

describe("createStaticRoutes — key normalization", () => {
  it("lowercases keys at construction time", () => {
    const r = createStaticRoutes({
      "Lich.Localhost": "http://127.0.0.1:8000",
    });
    expect(r.lookup("Lich.Localhost")).toBe("http://127.0.0.1:8000");
    expect(r.lookup("lich.localhost")).toBe("http://127.0.0.1:8000");
    expect(r.lookup("LICH.LOCALHOST")).toBe("http://127.0.0.1:8000");
  });

  it("strips a `:port` suffix from keys at construction time", () => {
    const r = createStaticRoutes({
      "lich.localhost:3300": "http://127.0.0.1:8000",
    });
    expect(r.lookup("lich.localhost")).toBe("http://127.0.0.1:8000");
    expect(r.lookup("lich.localhost:3300")).toBe("http://127.0.0.1:8000");
  });

  it("silently drops empty keys", () => {
    const r = createStaticRoutes({ "": "http://upstream" });
    expect(r.lookup("")).toBeUndefined();
    expect(r.hosts()).toEqual([]);
  });
});

describe("StaticRoutes.lookup", () => {
  it("returns undefined for null or empty raw host", () => {
    const r = createStaticRoutes({
      "lich.localhost": "http://127.0.0.1:8000",
    });
    expect(r.lookup(null)).toBeUndefined();
    expect(r.lookup("")).toBeUndefined();
  });

  it("returns undefined for hosts that aren't in the table", () => {
    const r = createStaticRoutes({
      "lich.localhost": "http://127.0.0.1:8000",
    });
    expect(r.lookup("api.feature-x.lich.localhost")).toBeUndefined();
    expect(r.lookup("example.com")).toBeUndefined();
  });

  it("strips a `:port` suffix from the lookup argument", () => {
    const r = createStaticRoutes({
      "lich.localhost": "http://127.0.0.1:8000",
    });
    expect(r.lookup("lich.localhost:3300")).toBe("http://127.0.0.1:8000");
    expect(r.lookup("lich.localhost:9999")).toBe("http://127.0.0.1:8000");
  });

  it("is case-insensitive on the lookup argument", () => {
    const r = createStaticRoutes({
      "lich.localhost": "http://127.0.0.1:8000",
    });
    expect(r.lookup("LICH.LOCALHOST:3300")).toBe("http://127.0.0.1:8000");
  });
});

describe("StaticRoutes.hosts", () => {
  it("returns the registered keys in canonical (lowercased) form", () => {
    const r = createStaticRoutes({
      "Lich.Localhost": "http://127.0.0.1:8000",
      "Other.Host": "http://127.0.0.1:9000",
    });
    expect(r.hosts().sort()).toEqual(["lich.localhost", "other.host"]);
  });

  it("returns [] for an empty table", () => {
    const r = createStaticRoutes({});
    expect(r.hosts()).toEqual([]);
  });
});

describe("emptyStaticRoutes", () => {
  it("matches nothing", () => {
    const r = emptyStaticRoutes();
    expect(r.lookup("lich.localhost")).toBeUndefined();
    expect(r.lookup("api.feature-x.lich.localhost")).toBeUndefined();
    expect(r.hosts()).toEqual([]);
  });
});
