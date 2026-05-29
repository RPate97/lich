import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runValidate } from "../../../src/commands/validate.js";

let tmp: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lich-validate-multiport-"));
  stdout = [];
  stderr = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(body: string): string {
  const p = join(tmp, "lich.yaml");
  writeFileSync(p, body, "utf8");
  return p;
}

async function run(path: string) {
  return runValidate({
    path,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
}

describe("validate — services.<name>.host_port_<idx> (array form)", () => {
  it("accepts a valid in-range index", async () => {
    const path = writeYaml(`
version: "1"
services:
  mailhog:
    image: mailhog/mailhog
    ports:
      - { container: 1025, env: SMTP_HOST_PORT }
      - { container: 8025, env: MAILHOG_UI_PORT }
env:
  SMTP_URL: "smtp://localhost:\${services.mailhog.host_port_0}"
  UI_URL: "http://localhost:\${services.mailhog.host_port_1}"
`);
    const res = await run(path);
    expect(res.exitCode).toBe(0);
    expect(res.report.ok).toBe(true);
  });

  it("rejects host_port_<idx> out of range with helpful message", async () => {
    const path = writeYaml(`
version: "1"
services:
  mailhog:
    image: mailhog/mailhog
    ports:
      - { container: 1025, env: SMTP_HOST_PORT }
      - { container: 8025, env: MAILHOG_UI_PORT }
env:
  BAD: "http://localhost:\${services.mailhog.host_port_5}"
`);
    const res = await run(path);
    expect(res.exitCode).not.toBe(0);
    expect(res.report.ok).toBe(false);
    const interpErrors = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp",
    );
    expect(interpErrors.length).toBeGreaterThan(0);
    const msg = interpErrors.map((e) => e.message).join("\n");
    expect(msg).toContain("out of range");
    expect(msg).toContain('"mailhog"');
    expect(msg).toContain("only 2 port");
    expect(msg).toContain("0..1");
  });

  it("rejects host_port_<idx> against a Record-form ports declaration", async () => {
    const path = writeYaml(`
version: "1"
services:
  web:
    image: nginx
    ports:
      http:
        container: 80
        env: HTTP_PORT
      admin:
        container: 81
        env: ADMIN_PORT
env:
  BAD: "http://localhost:\${services.web.host_port_0}"
`);
    const res = await run(path);
    expect(res.exitCode).not.toBe(0);
    const interpErrors = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp",
    );
    expect(interpErrors.length).toBeGreaterThan(0);
    const msg = interpErrors.map((e) => e.message).join("\n");
    expect(msg).toContain("Record");
    expect(msg).toContain("ports.");
    expect(/http|admin/.test(msg)).toBe(true);
  });

  it("rejects non-numeric host_port_<suffix>", async () => {
    const path = writeYaml(`
version: "1"
services:
  mailhog:
    image: mailhog/mailhog
    ports:
      - { container: 1025, env: SMTP_HOST_PORT }
      - { container: 8025, env: MAILHOG_UI_PORT }
env:
  BAD: "http://localhost:\${services.mailhog.host_port_admin}"
`);
    const res = await run(path);
    expect(res.exitCode).not.toBe(0);
    const interpErrors = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp",
    );
    expect(interpErrors.length).toBeGreaterThan(0);
    const msg = interpErrors.map((e) => e.message).join("\n");
    expect(msg.toLowerCase()).toContain("unknown reference");
  });
});

describe("validate — services.<name>.ports.<key> (Record form)", () => {
  it("accepts a valid key reference", async () => {
    const path = writeYaml(`
version: "1"
services:
  web:
    image: nginx
    ports:
      http:
        container: 80
        env: HTTP_PORT
      admin:
        container: 81
        env: ADMIN_PORT
env:
  HTTP_URL: "http://localhost:\${services.web.ports.http}"
  ADMIN_URL: "http://localhost:\${services.web.ports.admin}"
`);
    const res = await run(path);
    expect(res.exitCode).toBe(0);
    expect(res.report.ok).toBe(true);
  });

  it("rejects ports.<nonexistent> with declared-key suggestion", async () => {
    const path = writeYaml(`
version: "1"
services:
  web:
    image: nginx
    ports:
      http:
        container: 80
        env: HTTP_PORT
      admin:
        container: 81
        env: ADMIN_PORT
env:
  BAD: "http://localhost:\${services.web.ports.bogus}"
`);
    const res = await run(path);
    expect(res.exitCode).not.toBe(0);
    const interpErrors = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp",
    );
    expect(interpErrors.length).toBeGreaterThan(0);
    const msg = interpErrors.map((e) => e.message).join("\n");
    expect(msg).toContain("unknown port");
    expect(msg).toContain('"bogus"');
    expect(msg).toContain('"web"');
  });

  it("rejects ports.<key> against an array-form ports declaration", async () => {
    const path = writeYaml(`
version: "1"
services:
  mailhog:
    image: mailhog/mailhog
    ports:
      - { container: 1025, env: SMTP_HOST_PORT }
      - { container: 8025, env: MAILHOG_UI_PORT }
env:
  BAD: "http://localhost:\${services.mailhog.ports.smtp}"
`);
    const res = await run(path);
    expect(res.exitCode).not.toBe(0);
    const interpErrors = (res.report.errors ?? []).filter(
      (e) => e.kind === "interp",
    );
    expect(interpErrors.length).toBeGreaterThan(0);
    const msg = interpErrors.map((e) => e.message).join("\n");
    expect(msg).toContain("array");
    expect(msg).toContain("host_port_");
  });
});

describe("validate — services.<name>.host_port (backward compat)", () => {
  it("accepts ${services.<name>.host_port} on a multi-port array-form service", async () => {
    const path = writeYaml(`
version: "1"
services:
  mailhog:
    image: mailhog/mailhog
    ports:
      - { container: 1025, env: SMTP_HOST_PORT }
      - { container: 8025, env: MAILHOG_UI_PORT }
env:
  PRIMARY: "smtp://localhost:\${services.mailhog.host_port}"
`);
    const res = await run(path);
    expect(res.exitCode).toBe(0);
  });

  it("accepts ${services.<name>.host_port} on a multi-port Record-form service", async () => {
    const path = writeYaml(`
version: "1"
services:
  web:
    image: nginx
    ports:
      http:
        container: 80
        env: HTTP_PORT
      admin:
        container: 81
        env: ADMIN_PORT
env:
  PRIMARY: "http://localhost:\${services.web.host_port}"
`);
    const res = await run(path);
    expect(res.exitCode).toBe(0);
  });
});
