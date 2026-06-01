import { describe, test, expect } from "vitest";
import { buildRemoteCommand } from "../../../src/sandbox/ssh-exec.js";

describe("buildRemoteCommand", () => {
  test("emits a cd prefix, env assignments, and the argv joined", () => {
    const cmd = buildRemoteCommand(
      "/workspace",
      { LICH_SANDBOX_GUEST: "1", LICH_HOME: "/home/admin/.lich" },
      ["lich", "up", "dev"],
    );
    expect(cmd).toBe(
      "cd /workspace && env LICH_SANDBOX_GUEST=1 LICH_HOME=/home/admin/.lich lich up dev",
    );
  });

  test("quotes paths with shell metacharacters", () => {
    const cmd = buildRemoteCommand(
      "/work space",
      {},
      ["lich", "up", "dev:heavy"],
    );
    expect(cmd).toContain("cd '/work space'");
    expect(cmd).toContain("'dev:heavy'");
  });

  test("quotes env values that contain spaces or special chars", () => {
    const cmd = buildRemoteCommand(
      "/workspace",
      { DATABASE_URL: "postgresql://u:p@h/db", NOTE: "hello world" },
      ["echo", "hi"],
    );
    expect(cmd).toContain("DATABASE_URL='postgresql://u:p@h/db'");
    expect(cmd).toContain("NOTE='hello world'");
  });

  test("omits the env prefix when no env vars are set", () => {
    const cmd = buildRemoteCommand("/workspace", {}, ["ls"]);
    expect(cmd).toBe("cd /workspace && ls");
    expect(cmd).not.toContain("env ");
  });

  test("omits the cd prefix when cwd is empty", () => {
    const cmd = buildRemoteCommand("", { K: "v" }, ["ls"]);
    expect(cmd).toBe("env K=v ls");
    expect(cmd).not.toContain("cd ");
  });

  test("escapes single quotes inside env values", () => {
    const cmd = buildRemoteCommand("", { K: "it's fine" }, ["echo", "ok"]);
    // POSIX-safe single-quote escape: close + literal + reopen.
    expect(cmd).toContain(`K='it'\\''s fine'`);
  });
});
