import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { runUp } from "../../../src/commands/up.js";
import { release, listAllocations } from "../../../src/ports/allocator.js";

let homeDir: string;
let projectDir: string;
let prevHome: string | undefined;
let createdStackIds: string[];

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lich-oneshot-mp-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "lich-oneshot-mp-proj-"));
  prevHome = process.env.LICH_HOME;
  process.env.LICH_HOME = homeDir;
  createdStackIds = [];
});

afterEach(async () => {
  for (const id of createdStackIds) {
    await release(id).catch(() => {});
  }
  if (prevHome === undefined) {
    delete process.env.LICH_HOME;
  } else {
    process.env.LICH_HOME = prevHome;
  }
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function writeYaml(body: string): void {
  writeFileSync(join(projectDir, "lich.yaml"), body, "utf8");
}

function captureStdout(): { stream: PassThrough; chunks: Buffer[] } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, chunks };
}

describe("runUp — oneshot service with multi-port ports: (LEV-510)", () => {
  it("allocates all 3 ports for a oneshot+multi-port service (LEV-510)", async () => {
    writeYaml(`
version: "1"
runtime:
  port_range: [19400, 19500]
owned:
  svc:
    cmd: "true"
    oneshot: true
    stop_cmd: "true"
    ports:
      api:    { env: SVC_API_PORT }
      db:     { env: SVC_DB_PORT }
      studio: { env: SVC_STUDIO_PORT }
  web:
    cmd: "echo READY; sleep 30"
    port: { env: PORT }
    depends_on: [svc]
    ready_when:
      log_match: "READY"
`);

    const { stream, chunks } = captureStdout();
    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode, `lich up should succeed; output:\n${Buffer.concat(chunks).toString("utf8").slice(0, 1000)}`).toBe(0);

    const allAllocations = await listAllocations();
    const our = allAllocations[result.stackId!];
    expect(our).toBeDefined();
    expect(Object.keys(our!)).toHaveLength(4);
  }, 15_000);

  it("injects multi-port env vars into the oneshot cmd env (LEV-510)", async () => {
    const portsDump = join(projectDir, "ports.dump");
    writeYaml(`
version: "1"
runtime:
  port_range: [19400, 19500]
owned:
  svc:
    cmd: 'printf "api=%s db=%s studio=%s" "$SVC_API_PORT" "$SVC_DB_PORT" "$SVC_STUDIO_PORT" > ${portsDump}'
    oneshot: true
    ports:
      api:    { env: SVC_API_PORT }
      db:     { env: SVC_DB_PORT }
      studio: { env: SVC_STUDIO_PORT }
  web:
    cmd: "echo READY; sleep 30"
    port: { env: PORT }
    depends_on: [svc]
    ready_when:
      log_match: "READY"
`);

    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on("data", (c: Buffer) => chunks.push(c));

    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode, `lich up should succeed; output:\n${Buffer.concat(chunks).toString("utf8").slice(0, 1000)}`).toBe(0);
    expect(existsSync(portsDump), "ports.dump should have been written by oneshot cmd").toBe(true);

    const dumped = readFileSync(portsDump, "utf8").trim();
    const m = dumped.match(/^api=(\d+) db=(\d+) studio=(\d+)$/);
    expect(m, `ports.dump should match pattern; got: ${dumped}`).not.toBeNull();
    const [, api, db, studio] = m!;
    expect(Number(api)).toBeGreaterThanOrEqual(19400);
    expect(Number(db)).toBeGreaterThanOrEqual(19400);
    expect(Number(studio)).toBeGreaterThanOrEqual(19400);
    expect(api).not.toBe(db);
    expect(db).not.toBe(studio);
    expect(api).not.toBe(studio);
  }, 15_000);

  it("resolves ${owned.svc.ports.key} in top-level env for oneshot services (LEV-510)", async () => {
    const portsDump = join(projectDir, "env.dump");
    writeYaml(`
version: "1"
runtime:
  port_range: [19400, 19500]
owned:
  svc:
    cmd: "true"
    oneshot: true
    ports:
      api:    { env: SVC_API_PORT }
      db:     { env: SVC_DB_PORT }
      studio: { env: SVC_STUDIO_PORT }
  web:
    cmd: "echo READY; sleep 30"
    port: { env: PORT }
    depends_on: [svc]
    ready_when:
      log_match: "READY"
env:
  API_URL: "http://localhost:\${owned.svc.ports.api}"
  DB_URL: "postgresql://localhost:\${owned.svc.ports.db}/postgres"
lifecycle:
  after_up:
    - 'printf "api_url=%s db_url=%s" "$API_URL" "$DB_URL" > ${portsDump}'
`);

    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on("data", (c: Buffer) => chunks.push(c));

    const result = await runUp({
      cwd: projectDir,
      outputMode: "json",
      out: stream,
    });
    if (result.stackId) createdStackIds.push(result.stackId);

    expect(result.exitCode, `lich up should succeed; output:\n${Buffer.concat(chunks).toString("utf8").slice(0, 1000)}`).toBe(0);
    expect(existsSync(portsDump), "env.dump should have been written by after_up hook").toBe(true);

    const dumped = readFileSync(portsDump, "utf8").trim();
    expect(dumped, `env.dump should contain api_url=http://localhost:<port>; got: ${dumped}`).toMatch(/api_url=http:\/\/localhost:\d+/);
    expect(dumped, `env.dump should contain db_url=postgresql://...; got: ${dumped}`).toMatch(/db_url=postgresql:\/\/localhost:\d+\/postgres/);
  }, 15_000);
});
