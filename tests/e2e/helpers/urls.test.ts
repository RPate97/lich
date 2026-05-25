import { describe, it, expect } from "vitest";
import { parseLichUrls, portFromUrl } from "./urls.js";

describe("parseLichUrls", () => {
  it("parses simple single-service output (post-LEV-419 default friendly URLs)", () => {
    // After LEV-419 (friendly URLs by default), lich urls emits friendly
    // hostnames keyed by service name.
    const output = `\
api: http://api.lich-e2e-foo.lich.localhost:3300/
web: http://web.lich-e2e-foo.lich.localhost:3300/
`;
    const urls = parseLichUrls(output);
    expect(urls.api).toBe("http://api.lich-e2e-foo.lich.localhost:3300/");
    expect(urls.web).toBe("http://web.lich-e2e-foo.lich.localhost:3300/");
  });

  it("parses multi-port friendly URL output (parenthesized port key)", () => {
    // Multi-port owned service emits one line per port.
    const output = `\
supabase (api): http://supabase-api.lich-e2e-foo.lich.localhost:3300/
supabase (db): http://supabase-db.lich-e2e-foo.lich.localhost:3300/
api: http://api.lich-e2e-foo.lich.localhost:3300/
`;
    const urls = parseLichUrls(output);
    expect(urls.api).toBe("http://api.lich-e2e-foo.lich.localhost:3300/");
    // Multi-port entries use a "service.portkey" key shape.
    expect(urls["supabase.api"]).toBe(
      "http://supabase-api.lich-e2e-foo.lich.localhost:3300/",
    );
    expect(urls["supabase.db"]).toBe(
      "http://supabase-db.lich-e2e-foo.lich.localhost:3300/",
    );
  });

  it("parses raw URL output (--raw flag)", () => {
    // `lich urls --raw` emits localhost URLs with raw ports.
    const output = `\
api: http://127.0.0.1:9014/
web: http://127.0.0.1:9015/
`;
    const urls = parseLichUrls(output);
    expect(urls.api).toBe("http://127.0.0.1:9014/");
  });

  it("ignores blank lines and unknown prefixes", () => {
    const output = `\n\nnot a urls line\napi: http://api.foo.lich.localhost:3300/\n\n`;
    const urls = parseLichUrls(output);
    expect(urls.api).toBe("http://api.foo.lich.localhost:3300/");
    expect(Object.keys(urls)).toEqual(["api"]);
  });
});

describe("portFromUrl", () => {
  it("extracts the port from a URL", () => {
    expect(portFromUrl("http://127.0.0.1:9014/")).toBe(9014);
    expect(portFromUrl("http://api.foo.lich.localhost:3300/")).toBe(3300);
  });
});
