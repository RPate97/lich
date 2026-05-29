import { describe, it, expect } from "vitest";
import { expectDbMode } from "./dbmode.js";

describe("expectDbMode", () => {
  it("resolves when /health.db matches expected", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: "ok", db: "live" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      await expect(
        expectDbMode("http://nowhere", "live"),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects when /health.db doesn't match expected", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: "ok", db: "stub" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      await expect(
        expectDbMode("http://nowhere", "live"),
      ).rejects.toThrow(/Expected DB mode "live" but \/health reports "stub"/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects when /health returns non-200", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("oops", { status: 500 });
    try {
      await expect(expectDbMode("http://nowhere", "stub")).rejects.toThrow(
        /\/health returned 500/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
